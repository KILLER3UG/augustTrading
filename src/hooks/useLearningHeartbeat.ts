/**
 * useLearningHeartbeat — the learning loop's clock.
 *
 * The four scheduled passes (weekly rollup, weekly review, monthly report,
 * memory hygiene) were fired once each, from `useUserProfileLoader`'s profile
 * load. That made them BOOT passes: a trader who left the app open for a day
 * got one sweep at open and none after — even though what those passes maintain
 * (stale-skill demotions, belief challenges, contradiction sweeps) is exactly
 * what goes stale during a day of trading. Reopening the app fixed it, which is
 * a strange property for a loop that is supposed to be running.
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
import { runWeeklyRollupIfDue } from '../services/learning/weeklyRollup';
import { runWeeklyReviewIfDue } from '../services/learning/weeklyReview';
import { runMonthlyReportIfDue } from '../services/learning/monthlyReport';
import { runMemoryHygieneIfDue } from '../services/learning/memoryHygiene';
import { settleDueSignals, settleRefusedSignals } from '../services/signals/signalService';
import { autoApplyPendingSkillDrafts } from '../services/learning/skillApproval';
import { repairSkillFileFormats } from '../services/learning/SkillMemoryService';
import {
    applyProposalCard, clearProposalAutoRefusal, dismissLearningProposal,
    isApplyableProposal, listLearningProposals, markProposalAutoRefused,
    proposalAutoAttempts, PROPOSAL_AUTO_MAX_ATTEMPTS,
} from '../utils/learningQueue';

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

        // AUTO-APPLY (owner ruling 2026-11-03): the approval inbox is gone.
        // Every draft source funnels through queueSkillDraft, whose write fires
        // 'august-skill-drafts' — so THIS listener is the one choke point the
        // auto-apply needs. The deterministic draft gates still run (duplicates,
        // malformed clauses, body caps, tombstones); what no longer exists is
        // the human click between a gated draft and the library. A draft the
        // library refuses keeps an attempts counter and stops being retried at
        // the budget, so one bad draft cannot burn writes on every sweep.
        const autoApply = (): void => {
            void autoApplyPendingSkillDrafts(username, tradesRef.current)
                .then(r => {
                    if (r.applied > 0) console.log(`[SkillAutoApply] ${r.applied} draft(s) applied`);
                    if (r.refused > 0) console.warn('[SkillAutoApply] refusals:', r.failures.join('; '));
                })
                .catch(e => console.warn('[SkillAutoApply] pass failed:', e instanceof Error ? e.message : e));
            // The proposal half of the same ruling: rescope/displacement rows
            // that were waiting on a Coach-thread Apply now apply through the
            // ONE dispatcher the old panels used, with the same refusal
            // budget. `applyProposalCard` never throws (the dispatcher
            // converts writes into refusals), so a per-row catch would be
            // dead code; a REJECTED row is consumed like the panel's dismiss.
            for (const p of listLearningProposals(username).filter(isApplyableProposal)) {
                if (proposalAutoAttempts(p.id, username) >= PROPOSAL_AUTO_MAX_ATTEMPTS) continue;
                void applyProposalCard(p, username)
                    .then(result => {
                        if (result.applied) {
                            clearProposalAutoRefusal(p.id, username);
                            dismissLearningProposal(p.id, username);
                            console.log(`[SkillAutoApply] proposal ${p.kind} applied`);
                        } else {
                            markProposalAutoRefused(p.id, username);
                        }
                    })
                    .catch(e => console.warn('[SkillAutoApply] proposal failed:', p.id, e instanceof Error ? e.message : e));
            }
        };
        autoApply(); // drain anything queued before this mount
        window.addEventListener('august-skill-drafts', autoApply);

        // ONE-FORMAT GATE over the EXISTING library (owner ruling 2026-11-03):
        // the writer always emits the canonical face, but files written before
        // the format existed — or imported/hand-edited ones — still have to
        // follow it. The pass derives the missing trigger/description from the
        // file's own words and rewrites through the same serializer; it is
        // idempotent, so a conforming library logs nothing and writes nothing.
        void repairSkillFileFormats(username)
            .then(r => {
                if (r.repaired > 0) console.log(`[SkillFormat] repaired ${r.repaired}/${r.checked}`, r.changed);
                else if (r.remaining > 0) console.warn(`[SkillFormat] ${r.remaining}/${r.checked} skill files still do not conform`);
            })
            .catch(e => console.warn('[SkillFormat] pass failed:', e instanceof Error ? e.message : e));

        const sweep = (): void => {
            const log = tradesRef.current;
            void runWeeklyRollupIfDue(username)
                .then(res => { if (res) console.log('[WeeklyRollup] pass complete:', res); })
                .catch(e => console.warn('[WeeklyRollup] pass failed:', e instanceof Error ? e.message : e));
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
            window.removeEventListener('august-skill-drafts', autoApply);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [activeUsername]);
};
