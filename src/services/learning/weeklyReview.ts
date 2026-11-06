/**
 * Weekly review — the deterministic week-stats
 * assembly + ONE moderator-provider call synthesizing exactly ONE
 * improvement impulse (Edgewonk cadence: one impulse, not a lecture).
 *
 * Trigger: at app start via runWeeklyReviewIfDue — due when >=7 days since
 * the last digest AND >=3 closed trades since. Rendered as a Journal card; stored in
 * Preferences per user.
 */

import { LoggedTrade } from '../../types/trade';
import { TradeOutcome } from '../../types/enums';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { buildDisciplineAnalytics, effectiveRMultiple } from '../../utils/disciplineAnalytics';
import { sendChatRequest } from '../providers/GenericProviderService';
import { getFirstReadyProvider } from '../../utils/providerUtils';
import { loadProviderConfigs } from '../infrastructure/ProviderConfigService';
import { ProviderConfig } from '../../types/provider';

const KEY_PREFIX = 'weekly_review_v1_';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Closed trades before a review card is worth generating.
 *
 * EXPORTED and used by monthlyReport, which declared the same rule as its own
 * private copy. Two review periods that disagree about how much evidence a
 * review needs would show the trader a weekly card one week and a monthly card
 * the next from the same three trades, with nothing to explain the difference.
 *
 * They are the same number today and are meant to be: a review is a review. If
 * a monthly review ever genuinely wants a higher bar, give it its own named
 * constant and say why in a comment - do not quietly re-point this one, which
 * would move the weekly review with it.
 */
export const MIN_CLOSED_TRADES_FOR_REVIEW = 3;

export interface WeeklyReviewDigest {
    /** ISO timestamp of the week this digest covers (its end). */
    generatedAt: string;
    /** Deterministic week stats (the numbers the impulse must cite). */
    stats: {
        closed: number;
        wins: number;
        losses: number;
        netPnlUsd: number;
        /** How many of `closed` actually carry a dollar figure. A journal of
         *  percentage-only trades sums to `$0`, and a `$0` week is a fabrication
         *  the coach prompt is then told to be "grounded in" (the 2026-10-27 audit A-5). */
        dollarRows: number;
        avgR: number | null;
        adherenceFollowedPct: number | null;
        topMistake: string | null;
        givebackDays: number;
    };
    /** The ONE improvement impulse from the moderator call. */
    impulse: string;
    /** Provider that wrote it (provenance). */
    providerName: string;
}

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

/** Deterministic week-stats assembly over the closed trades of the window. */
export const buildWeekStats = (trades: LoggedTrade[], nowMs: number): WeeklyReviewDigest['stats'] => {
    const since = nowMs - WEEK_MS;
    const closed = trades.filter(t =>
        (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS)
        && t.timestamp && Date.parse(t.timestamp) >= since);
    const wins = closed.filter(t => t.outcome === TradeOutcome.WIN);
    const losses = closed.filter(t => t.outcome === TradeOutcome.LOSS);
    const analytics = buildDisciplineAnalytics(closed);
    const rs = closed.map(effectiveRMultiple).filter((r): r is number => r !== undefined);
    const followedN = analytics.adherence.followed.n;
    const brokenN = analytics.adherence.broken.n;
    const topCost = analytics.mistakeCost[0];
    const withDollars = closed.filter(t => typeof t.pnlAmount === 'number');
    return {
        closed: closed.length,
        wins: wins.length,
        losses: losses.length,
        netPnlUsd: withDollars.reduce((s, t) => s + (t.pnlAmount as number), 0),
        dollarRows: withDollars.length,
        avgR: rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
        adherenceFollowedPct: followedN + brokenN > 0
            ? Math.round((followedN / (followedN + brokenN)) * 100)
            : null,
        topMistake: topCost && topCost.totalPnlUsd < 0 ? topCost.tag : null,
        givebackDays: analytics.giveback.days,
    };
};

/** Does this week actually have dollar figures? One predicate, so the prompt the
 *  coach is grounded in and the card the trader reads cannot disagree about it. */
export const weekPnlCaptured = (s: WeeklyReviewDigest['stats']): boolean =>
    (s.dollarRows ?? 0) > 0;

/** The money, or the honest absence of it. A digest stored before `dollarRows`
 *  existed cannot prove any row carried dollars, so it says "not captured"
 *  until regenerated — the alternative printed `$0` over percent-only weeks. */
export const weekPnlText = (s: WeeklyReviewDigest['stats']): string => {
    if (!weekPnlCaptured(s)) return 'not captured';
    const partial = s.dollarRows < s.closed ? ` (${s.dollarRows}/${s.closed} rows)` : '';
    return `$${Math.round(s.netPnlUsd)}${partial}`;
};

const statsLines = (s: WeeklyReviewDigest['stats']): string =>
    `Closed trades (7d): ${s.closed} (${s.wins}W/${s.losses}L)\n` +
    `Net P&L: ${weekPnlText(s)}${s.avgR !== null ? ` · avg R: ${s.avgR.toFixed(2)}` : ''}\n` +
    `Plan adherence: ${s.adherenceFollowedPct !== null ? `${s.adherenceFollowedPct}% followed` : 'not tagged'}\n` +
    (s.topMistake ? `Most expensive mistake: ${s.topMistake}\n` : '') +
    (s.givebackDays > 0 ? `Giveback days (green turned red): ${s.givebackDays}\n` : '');

/** The single-call prompt: cite the computed facts, emit ONE impulse. */
export const buildWeeklyImpulsePrompt = (s: WeeklyReviewDigest['stats']): string =>
    `You are the trader's review coach. Here is this week's deterministic journal summary:\n\n` +
    `${statsLines(s)}\n` +
    `Write EXACTLY ONE improvement impulse for next week — one concrete, ` +
    `falsifiable behavior change (max 2 sentences), grounded in the numbers ` +
    `above. Lead with process over outcome: if adherence is the weak number, ` +
    `the impulse is about adherence, not P&L. No lecture, no lists, no ` +
    `hedging, no urgency words (never "urgent", "easy", "guaranteed"). ` +
    `If the numbers are too thin to learn from, say so in one line.`;

/** True when a digest has never been generated or is >=7 days old. */
export const isWeeklyReviewDue = async (username: string, now = Date.now()): Promise<boolean> => {
    try {
        const prev = await getPreferenceObject<{ generatedAt?: string }>(keyFor(username));
        const ts = prev?.generatedAt ? Date.parse(prev.generatedAt) : NaN;
        if (!Number.isFinite(ts)) return true;
        return now - ts >= WEEK_MS;
    } catch {
        return true;
    }
};

/**
 * Generate + store the digest. Returns null when not due, too few closed
 * trades, or no ready provider (best-effort — never throws into boot).
 */
export const runWeeklyReview = async (
    username: string,
    trades: LoggedTrade[],
    providerConfigs: ProviderConfig[],
    now = Date.now(),
): Promise<WeeklyReviewDigest | null> => {
    const stats = buildWeekStats(trades, now);
    if (stats.closed < MIN_CLOSED_TRADES_FOR_REVIEW) return null;
    const provider = getFirstReadyProvider(providerConfigs);
    if (!provider) return null;
    try {
        const impulse = (await sendChatRequest(
            provider,
            [{ role: 'user', content: buildWeeklyImpulsePrompt(stats) }],
            { maxTokens: 400, temperature: 0.4 },
        ) || '').trim().slice(0, 600);
        if (!impulse) return null;
        const digest: WeeklyReviewDigest = {
            generatedAt: new Date(now).toISOString(),
            stats,
            impulse,
            providerName: provider.name,
        };
        await setPreferenceObject(keyFor(username), digest);
        return digest;
    } catch (e) {
        console.warn('[WeeklyReview] impulse call failed:', e instanceof Error ? e.message : e);
        return null;
    }
};

/** Boot hook: due-check + trade gate + provider load, fire-and-forget. */
export const runWeeklyReviewIfDue = async (
    username: string,
    trades: LoggedTrade[],
): Promise<WeeklyReviewDigest | null> => {
    try {
        if (!(await isWeeklyReviewDue(username))) return null;
        // Deterministic passes beside the weekly rollup (no LLM):
        // settled-belief challenge flags + the scheduled hygiene pass.
        try {
            // Deterministic maintenance beside the digest. Hygiene carries its
            // OWN due-check, because this block re-runs whenever the digest
            // could not be generated and maintenance must not ride along on
            // every one of those retries.
            void import('./memoryHygiene')
                .then(m => m.runMemoryHygieneIfDue(username, undefined, trades))
                .catch(() => { /* hygiene is best-effort */ });
            // Resolve recent SKIPPED trades against post-skip klines. This is
            // the journal's correct-pass / missed-opportunity metric; it no
            // longer drafts skills.
            void (async () => {
                const { runPassMiningSweep } = await import('./passMining');
                const { fetchKlines } = await import('../analysis/KlineService');
                return runPassMiningSweep(trades, username, fetchKlines);
            })()
                .then(res => {
                    if (res.resolved > 0) console.log('[PassMining] resolved', res.resolved, 'skips');
                })
                .catch(() => { /* pass mining is best-effort */ });
        } catch { /* the review must not fail on a sweep hiccup */ }
        const configs = await loadProviderConfigs();
        return await runWeeklyReview(username, trades, configs);
    } catch {
        return null;
    }
};

/** The stored digest for the Journal card (null when none). */
export const loadWeeklyReview = async (username: string): Promise<WeeklyReviewDigest | null> => {
    try {
        const d = await getPreferenceObject<WeeklyReviewDigest>(keyFor(username));
        return d && typeof d.impulse === 'string' && d.stats ? d : null;
    } catch {
        return null;
    }
};
