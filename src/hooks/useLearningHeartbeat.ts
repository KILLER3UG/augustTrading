/**
 * useLearningHeartbeat — the learning loop's clock.
 *
 * The scheduled passes (weekly review, monthly report, memory hygiene) were
 * fired once each, from `useUserProfileLoader`'s profile load. That made them
 * BOOT passes: a trader who left the app open for a day got one sweep at open
 * and none after. What they maintain now is the journal digest, the month
 * report and the notebook review — no skill verdict among them, because a skill
 * is a document and nothing demotes one.
 *
 * This is wiring only, deliberately. Every sibling already owns its due-check
 * — `*IfDue` re-reads the stored timestamp and returns null when not due — so
 * the tick can fire unconditionally and a wasted tick costs four early returns.
 * The alternative, teaching the loop to keep its own schedule, is a second
 * clock that can only ever drift from the one the Health tab reports against.
 *
 * Two wake-ups, because one is not enough:
 *   - a 15-minute interval, for a session left in the foreground;
 *   - `visibilitychange` → visible, because a backgrounded tab has its timers
 *     clamped and a backgrounded mobile WebView may not run them at all, so
 *     coming back to the tab is the moment the loop is guaranteed a chance.
 *
 * The first tick is deliberately NOT on mount: `useUserProfileLoader` has
 * already run all four at boot. The due-checks would make a second pass a no-op
 * anyway, but the log lines would double, and a loop log that overstates how
 * often the loop ran is worse than no log.
 */

import { useEffect, useRef } from 'react';
import type { LoggedTrade } from '../types';
import { runWeeklyReviewIfDue } from '../services/learning/weeklyReview';
import { runMonthlyReportIfDue } from '../services/learning/monthlyReport';
import { runMemoryHygieneIfDue } from '../services/learning/memoryHygiene';
import { settleDueSignals, settleRefusedSignals } from '../services/signals/signalService';
import { migrateSkillLibrary } from '../services/learning/SkillFileService';
import { expireSelfChanges } from '../services/selfMod/SelfModificationService';

/** How often a foreground session wakes the loop. Frequent enough that a
 *  trader sees a stale-skill proposal inside the hour; rare enough that four
 *  early-returning due-checks are not worth minimising. */
export const LEARNING_HEARTBEAT_MS = 15 * 60 * 1000;

export const useLearningHeartbeat = (activeUsername: string | null, trades: LoggedTrade[] = []): void => {
    // A ref rather than a dependency: the sweeps measure over the trade log as
    // it is NOW, and listing `trades` in the deps would tear down and restart
    // the 15-minute timer on every settled trade — so the tick would never come.
    const tradesRef = useRef<LoggedTrade[]>(trades);
    tradesRef.current = trades;

    useEffect(() => {
        if (!activeUsername) return;
        // Captured, not read from the closure of a changing value: a sweep that
        // started under one profile must finish under that profile.
        const username = activeUsername;

        // E4 (2026-11-03): one bounded ledger-settlement pass at boot. The
        // signal ledger used to settle only when Journal → Signals mounted, so
        // a trader who never opened it left every call unresolved even though
        // the tape had already graded it. Deterministic (no model call on a
        // timer — the resolver only), capped by MAX_SETTLE_PER_RUN, and the
        // pass's own 60s cooldown makes a double-fire with the feed's mount
        // pass free.
        void settleDueSignals(username)
            .then(out => { if (out.resolved > 0) console.log('[SignalSettle] boot pass settled', out.resolved); })
            .catch(e => console.warn('[SignalSettle] boot pass failed:', e instanceof Error ? e.message : e));

        // The refusal shadow bookkeeping rides the same boot pass: blocked
        // emissions grade against the tape with the same resolver, oldest
        // first, capped lower than real signals. Nothing renders from it yet —
        // the feed reads the folded refusals directly.
        void settleRefusedSignals(username)
            .then(out => { if (out.resolved > 0) console.log('[SignalSettle] refusal pass graded', out.resolved); })
            .catch(e => console.warn('[SignalSettle] refusal pass failed:', e instanceof Error ? e.message : e));

        // ONE-TIME FORMAT MIGRATION: pre-format skill files get their folder
        // path and lose the retired ledger face. Idempotent — a conforming
        // library logs nothing and writes nothing.
        void migrateSkillLibrary(username)
            .then(r => {
                if (r.migrated > 0) console.log(`[SkillFormat] migrated ${r.migrated}/${r.checked}`, r.changed);
                else if (r.remaining > 0) console.warn(`[SkillFormat] ${r.remaining}/${r.checked} skill files could not be read`);
            })
            .catch(e => console.warn('[SkillFormat] pass failed:', e instanceof Error ? e.message : e));

        // A self-change window is a promise about TIME, so it is checked on
        // time: at open (a window that closed while the app was shut) and on
        // every sweep (one that closes while it is open). Before this the
        // revert only ran when a trade closed, which made "reverts
        // automatically in 24h" a label rather than a behavior.
        const expireWindows = (): void => {
            void expireSelfChanges(Date.now(), { username })
                .then(rows => {
                    if (rows.length > 0) console.log('[SelfMod] window closed, reverted:', rows.map(r => r.target).join(', '));
                })
                .catch(e => console.warn('[SelfMod] expiry pass failed:', e instanceof Error ? e.message : e));
        };
        expireWindows();

        const sweep = (): void => {
            const log = tradesRef.current;
            expireWindows();
            void runWeeklyReviewIfDue(username, log)
                .then(res => { if (res) console.log('[WeeklyReview] digest generated:', res.impulse.slice(0, 80)); })
                .catch(e => console.warn('[WeeklyReview] pass failed:', e instanceof Error ? e.message : e));
            void runMonthlyReportIfDue(username, log)
                .then(res => { if (res) console.log('[MonthlyReport] card generated for period ending', res.generatedAt.slice(0, 10)); })
                .catch(e => console.warn('[MonthlyReport] pass failed:', e instanceof Error ? e.message : e));
            void runMemoryHygieneIfDue(username, undefined, log)
                .catch(e => console.warn('[MemoryHygiene] pass failed:', e instanceof Error ? e.message : e));
        };

        const timer = window.setInterval(sweep, LEARNING_HEARTBEAT_MS);
        const onVisibility = (): void => {
            if (document.visibilityState === 'visible') sweep();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [activeUsername]);
};
