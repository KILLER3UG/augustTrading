/**
 * SessionGuardService — deterministic session-state guardrails (Batch 2).
 *
 * Pure functions over the profile tradeLog: realized day P&L (UTC), trades
 * opened today, and the current loss streak decide verdicts. No LLM, no
 * side effects — the research is unambiguous that these numbers must not be
 * negotiable in the moment ("over 63% of traders have lost an account in a
 * single day"; 73% of one auditor's losses came after the day's first red).
 *
 * Prop-firm defaults (research-tight end; the looser FTMO set — 3%/3 trades/
 * 60 min — is available through the config):
 *   - daily-loss limit: 2% of equity (Topstep auto-flatten level)
 *   - max trades/day: 2 (one win = done; one loss = one attempt then done)
 *   - streak pause: 2 consecutive losses
 *   - post-loss cooldown: 4h (cortisol clears ~90 min; the guard adds margin)
 *
 * Breaker behavior: warn at 50% of the daily cap, hard interstitial at 80%,
 * stand-down at 100% until the next UTC day. This is an advisory app, not a
 * broker: warn-first, never hard-block, with an explicit "continue anyway"
 * override that is itself journaled (overrideAt + overrideReason).
 */

import { LoggedTrade } from '../../types/trade';
import { TradeOutcome } from '../../types/enums';
import { getActiveUsername } from '../../utils/activeUser';

export interface SessionGuardConfig {
    /** Daily loss limit as a fraction of equity (0.02 = 2%). */
    dailyLossLimitPct: number;
    /** Max trades opened per UTC day. */
    maxTradesPerDay: number;
    /** Consecutive-loss count that triggers a streak pause. */
    lossStreakPause: number;
    /** Post-loss cooldown in minutes. */
    postLossCooldownMin: number;
    /**
     * The trader's per-trade risk budget (percent of equity, e.g. 1). Used
     * to convert pnlPercent-only autopilot rows to dollars when no
     * investmentAmount exists: a row resolved at its stop
     * counts as exactly -riskUsd. Defaults to the harness risk setting.
     */
    tradeRiskPercent: number;
}

export const DEFAULT_SESSION_GUARD: SessionGuardConfig = {
    dailyLossLimitPct: 0.02,
    maxTradesPerDay: 2,
    lossStreakPause: 2,
    postLossCooldownMin: 240,
    tradeRiskPercent: 1,
};

/** FTMO's looser preset — the config alternative named in the research. */
export const FTMO_SESSION_GUARD: SessionGuardConfig = {
    ...DEFAULT_SESSION_GUARD,
    dailyLossLimitPct: 0.03,
    maxTradesPerDay: 3,
};

/**
 * Dollar P&L of one journal row (corrected during
 * implementation): pnlAmount is authoritative when present. pnlPercent is
 * a LEVERAGED POSITION percent (autopilot rows carry e.g. -200 = the
 * position lost 200% of its margin). Dollars = margin × pct/100, where the
 * margin is the captured investmentAmount when known, else the 1%-of-
 * equity risk base (the documented convention: -200 leveraged = -$200 on
 * $10k). The original audit claim of a "double division" was a
 * miscalculation — the convention is sound; the real gap was ignoring
 * investmentAmount when present.
 */
export const rowPnlUsd = (
    t: LoggedTrade,
    equityUsd: number,
    tradeRiskPercent = 1,
): number => {
    if (typeof t.pnlAmount === 'number' && Number.isFinite(t.pnlAmount)) return t.pnlAmount;
    if (typeof t.pnlPercent !== 'number' || !Number.isFinite(t.pnlPercent)) return 0;
    const margin = t.investmentAmount && t.investmentAmount > 0
        ? t.investmentAmount
        : equityUsd * (tradeRiskPercent / 100);
    if (margin <= 0) return 0;
    return (t.pnlPercent / 100) * margin;
};

export type GuardLevel = 'clear' | 'notice' | 'warning' | 'standdown';

export interface SessionGuardVerdict {
    /** Worst active level — drives the banner color and the interstitial. */
    level: GuardLevel;
    /** Realized P&L for the current UTC day, in dollars. */
    dayPnlUsd: number;
    /** Equity fraction the day P&L represents (0 when equity unknown). */
    dayPnlPct: number;
    /** Trades opened in the current UTC day (any non-skipped entry). */
    tradesToday: number;
    /** Consecutive losses ending at the most recent closed trade. */
    lossStreak: number;
    /** True when the daily-loss limit is fully consumed. */
    dailyLossHit: boolean;
    /** True when today's trade count reached the cap. */
    tradeCapHit: boolean;
    /** True when the loss streak reached the pause threshold. */
    streakPauseActive: boolean;
    /** Cooldown end time (ISO) when a post-loss cooldown is running. */
    cooldownActiveUntil?: string;
    /** Human-readable lines for the banner + debate-context block. */
    warnings: string[];
    /** 0-1 usage of the daily loss budget (drives warn/interstitial tiers). */
    lossBudgetUsed: number;
}

const MS_PER_DAY = 86_400_000;

/** UTC midnight of the day containing `now` (or the current instant). */
export const utcDayStart = (now: Date = new Date()): Date => {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const isOpenOfDay = (ts: string | undefined, dayStart: number, now: number): boolean => {
    if (!ts) return false;
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= dayStart && t <= now;
};

/**
 * Today's realized P&L in dollars — per-row conversion via rowPnlUsd
 * (pnlAmount authoritative; pnlPercent through the position's margin or
 * the planned risk base, never a double-divided percent-of-equity).
 */
const dayPnl = (trades: LoggedTrade[], dayStart: number, now: number, equityUsd: number, tradeRiskPercent = 1): number => {
    let total = 0;
    for (const t of trades) {
        if (!isOpenOfDay(t.timestamp, dayStart, now)) continue;
        total += rowPnlUsd(t, equityUsd, tradeRiskPercent);
    }
    return total;
};

/** Consecutive losses ending at the most recent CLOSED trade (wins reset). */
const currentLossStreak = (trades: LoggedTrade[], now: number): number => {
    const closed = trades
        .filter(t => t.timestamp && Date.parse(t.timestamp) <= now
            && (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    let streak = 0;
    for (let i = closed.length - 1; i >= 0; i--) {
        if (closed[i].outcome === TradeOutcome.LOSS) streak++;
        else break;
    }
    return streak;
};

/**
 * The session-state verdict for right now. `now` and `equityUsd` are
 * parameters (not reads) so tests can pin the UTC boundary.
 */
export const assessSession = (
    trades: LoggedTrade[],
    equityUsd: number,
    config: SessionGuardConfig = DEFAULT_SESSION_GUARD,
    now: Date = new Date(),
): SessionGuardVerdict => {
    // Fail closed: with no configured equity there is no loss budget to
    // measure, so the guard cannot honestly say 'clear'. The old $10,000
    // stand-in handed a confident verdict to a user who never set an
    // account. Trades/streaks are still counted — only the dollar tiers
    // depend on equity.
    if (!(equityUsd > 0)) {
        const tradesTodayNoEq = trades.filter(t =>
            isOpenOfDay(t.analysis?.createdAt ?? t.timestamp, utcDayStart(now).getTime(), now.getTime())
            && t.outcome !== TradeOutcome.SKIPPED
            && t.outcome !== TradeOutcome.ENTRY_NOT_HIT,
        ).length;
        return {
            level: 'standdown',
            dayPnlUsd: 0,
            dayPnlPct: 0,
            tradesToday: tradesTodayNoEq,
            lossStreak: currentLossStreak(trades, now.getTime()),
            dailyLossHit: false,
            tradeCapHit: false,
            streakPauseActive: false,
            warnings: ['Equity not set — add your account equity in Settings before trading.'],
            lossBudgetUsed: 0,
        };
    }
    const nowMs = now.getTime();
    const dayStart = utcDayStart(now).getTime();
    const pnl = dayPnl(trades, dayStart, nowMs, equityUsd, config.tradeRiskPercent ?? 1);
    const eq = equityUsd;
    const lossBudgetUsd = eq * config.dailyLossLimitPct;
    // Only losses consume the budget — a green day never trips the breaker.
    const lossConsumedUsd = Math.min(0, pnl);
    const lossBudgetUsed = lossBudgetUsd > 0 ? Math.min(1, Math.abs(lossConsumedUsd) / lossBudgetUsd) : 0;
    const dayPct = eq > 0 ? pnl / eq : 0;

    const tradesToday = trades.filter(t =>
        // Trade cap buckets by OPEN time (the signal's createdAt), not the
        // close timestamp — a trade opened 23:50 UTC and closed 00:10 is
        // Still a trade of yesterday's session (corrected by
        // review: `timestamp` is stamped at outcome-capture, so it is
        // already close time and is right for P&L/streak/cooldown).
        isOpenOfDay(t.analysis?.createdAt ?? t.timestamp, dayStart, nowMs)
        && t.outcome !== TradeOutcome.SKIPPED
        && t.outcome !== TradeOutcome.ENTRY_NOT_HIT,
    ).length;

    const streak = currentLossStreak(trades, nowMs);
    const dailyLossHit = lossBudgetUsed >= 1;
    const tradeCapHit = tradesToday >= config.maxTradesPerDay;
    // 0 = disabled: a trader (or a risk-change card) that sets the pause to
    // 0 means "no streak pause", not "pause every session".
    const streakPauseActive = config.lossStreakPause > 0 && streak >= config.lossStreakPause;

    // Post-loss cooldown: the most recent CLOSED trade is a loss and it is
    // younger than the cooldown window.
    const closed = trades
        .filter(t => t.timestamp && Date.parse(t.timestamp) <= nowMs
            && (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const lastClosed = closed[closed.length - 1];
    let cooldownActiveUntil: string | undefined;
    if (lastClosed?.outcome === TradeOutcome.LOSS && lastClosed.timestamp) {
        const endsAt = Date.parse(lastClosed.timestamp) + config.postLossCooldownMin * 60_000;
        if (endsAt > nowMs) cooldownActiveUntil = new Date(endsAt).toISOString();
    }

    const warnings: string[] = [];
    if (dailyLossHit) {
        warnings.push(`Daily loss limit hit (${Math.abs(dayPct * 100).toFixed(2)}% of equity) — stand down until the next UTC day.`);
    } else if (lossBudgetUsed >= 0.8) {
        warnings.push(`${Math.round(lossBudgetUsed * 100)}% of the daily loss budget used — one more loss trips the limit.`);
    } else if (lossBudgetUsed >= 0.5) {
        warnings.push(`${Math.round(lossBudgetUsed * 100)}% of the daily loss budget used.`);
    }
    if (tradeCapHit) {
        warnings.push(`Trade cap reached (${tradesToday}/${config.maxTradesPerDay} today) — the session is over.`);
    } else if (tradesToday === config.maxTradesPerDay - 1) {
        warnings.push(`${tradesToday}/${config.maxTradesPerDay} trades used today.`);
    }
    if (streakPauseActive) {
        warnings.push(`${streak} losses in a row — streak pause: step back and review before the next trade.`);
    }
    if (cooldownActiveUntil) {
        const mins = Math.ceil((Date.parse(cooldownActiveUntil) - nowMs) / 60_000);
        warnings.push(`Post-loss cooldown active for ~${mins} more minute${mins === 1 ? '' : 's'}.`);
    }

    const level: GuardLevel = dailyLossHit || tradeCapHit
        ? 'standdown'
        : lossBudgetUsed >= 0.8 || streakPauseActive || cooldownActiveUntil
            ? 'warning'
            : lossBudgetUsed >= 0.5 || tradesToday === config.maxTradesPerDay - 1
                ? 'notice'
                : 'clear';

    return {
        level,
        dayPnlUsd: pnl,
        dayPnlPct: dayPct,
        tradesToday,
        lossStreak: streak,
        dailyLossHit,
        tradeCapHit,
        streakPauseActive,
        cooldownActiveUntil,
        warnings,
        lossBudgetUsed,
    };
};

/** Compact block injected into the debate context so the moderator can weigh it. */
export const formatGuardContextBlock = (verdict: SessionGuardVerdict): string => {
    if (verdict.level === 'clear' && verdict.tradesToday === 0 && verdict.lossStreak === 0) return '';
    const lines = [
        `**TRADER SESSION STATE (deterministic — weigh this when grading):**`,
        `Trades today: ${verdict.tradesToday} · Day P&L: ${verdict.dayPnlUsd >= 0 ? '+' : ''}$${Math.round(verdict.dayPnlUsd)} (${(verdict.dayPnlPct * 100).toFixed(2)}% of equity)`,
    ];
    if (verdict.lossStreak > 0) lines.push(`Current loss streak: ${verdict.lossStreak}`);
    for (const w of verdict.warnings) lines.push(`- ${w}`);
    return lines.join('\n');
};

/**
 * Next UTC midnight after `now` — the earliest a stand-down can lift. Exposed
 * for the banner's "until 00:00 UTC" copy.
 */
export const nextUtcMidnight = (now: Date = new Date()): Date =>
    new Date(utcDayStart(now).getTime() + MS_PER_DAY);

// ─── Enforcement (the redesign's flow-flaw fix) ─────────────────────────────
// The verdict machine above had no consumer: the limits were editable in
// Settings and changeable through the risk-change card, but nothing refused a
// log that breached them. The owner's ruling is that guard rules are enforced
// DETERMINISTICALLY — the same way the min-edge floor refuses a sub-floor plan:
// no same-moment override, the recourse is the gated path (a risk-change card
// loosening the limit, two taps for a loosen). The four active arms block; the
// budget tiers and an unset equity only warn.

export interface GuardEnforcement {
    /** Non-null when a NEW trade is refused right now. The card prints it and
     *  the log writer refuses with it — both read this one function, so the
     *  button and the writer cannot disagree. */
    block: string | null;
    /** Non-blocking lines the card prints (budget used, equity unset). */
    warnings: string[];
}

// ─── The daily standdown latch (review finding F6, owner ruling) ────────────
// Tightening riskPercent for FUTURE trades must never retroactively shrink
// today's already-settled losses to slip past a daily-loss standdown: the
// budget converts pnlPercent-only rows with the CURRENT risk percent, so a
// one-tap tighten used to shrink the measured loss and lift the block. The
// ruling: once the daily-loss limit trips for a UTC day, the standdown LATCHES
// for that day, and only a LOOSENED daily-loss limit (the trader's own
// settings write — the same path the two-tap guard/risk loosen card uses)
// clears it. Pure assessSession stays pure: the latch is applied by the
// enforcement sites through applyDailyStanddownLatch, which both reads and
// writes the day latch. localStorage-backed so a reload cannot clear a
// standing standdown.

const DAY_LATCH_KEY_PREFIX = 'guard_day_latch_v1_';

interface DayLatch { dayStart: number; limitPct: number }

const readDayLatch = (): DayLatch | null => {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(`${DAY_LATCH_KEY_PREFIX}${getActiveUsername()}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DayLatch;
        return parsed && typeof parsed.dayStart === 'number' && typeof parsed.limitPct === 'number' ? parsed : null;
    } catch { return null; }
};

const writeDayLatch = (latch: DayLatch): void => {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(`${DAY_LATCH_KEY_PREFIX}${getActiveUsername()}`, JSON.stringify(latch));
    } catch { /* a latch that cannot persist still holds for this session */ }
};

/** Apply (and record) the daily standdown latch to one verdict.
 *
 *  - The verdict says the daily limit is HIT: latch the day (idempotent) and
 *    return the verdict unchanged.
 *  - A latch exists for TODAY and the configured limit has NOT been loosened
 *    past the latched one: force `dailyLossHit` true regardless of what the
 *    current conversion computes — a riskPercent tighten cannot un-trip it.
 *  - The configured limit IS looser than the latched one: the trader loosened
 *    the limit through the gated path — clear the latch and recompute
 *    honestly. A TIGHTEN never clears it. */
export const applyDailyStanddownLatch = (
    verdict: SessionGuardVerdict,
    config: SessionGuardConfig,
    now: Date = new Date(),
): SessionGuardVerdict => {
    const dayStart = utcDayStart(now).getTime();
    if (verdict.dailyLossHit) {
        const existing = readDayLatch();
        if (!existing || existing.dayStart !== dayStart || config.dailyLossLimitPct > existing.limitPct) {
            writeDayLatch({ dayStart, limitPct: config.dailyLossLimitPct });
        }
        return verdict;
    }
    const latch = readDayLatch();
    if (!latch || latch.dayStart !== dayStart) return verdict;
    if (config.dailyLossLimitPct > latch.limitPct) {
        // Loosened through the gated path: the standdown lifts.
        clearDailyStanddownLatch();
        return verdict;
    }
    if (verdict.level === 'standdown') return verdict;
    return {
        ...verdict,
        dailyLossHit: true,
        level: 'standdown',
        warnings: [...verdict.warnings, 'The daily loss limit was consumed earlier today — the standdown is latched until the limit is loosened or the UTC day rolls over.'],
    };
};

export const clearDailyStanddownLatch = (): void => {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(`${DAY_LATCH_KEY_PREFIX}${getActiveUsername()}`);
    } catch { /* nothing to clear */ }
};

export const __clearDailyLatchForTests = (): void => { clearDailyStanddownLatch(); };

export const guardEnforcement = (v: SessionGuardVerdict): GuardEnforcement => {
    // KNOWN SIDE DOOR (review finding F6, accepted as a design tension): the
    // daily-loss budget converts pnlPercent-only rows with the CURRENT risk
    // percent, and riskPercent is a risk-change target where LOWER classifies
    // as tighten = one tap. A one-tap tighten therefore also shrinks today's
    // measured dollar loss and can lift a daily-loss standdown without the
    // two-tap loosen. Accepted: a tighten genuinely reduces per-trade risk
    // (the direction the asymmetry fast-paths), the conversion is an estimate
    // for rows without pnlAmount, and the two-tap arm guards LOOSENING the
    // limit itself. Flagged for the owner rather than papered over with a
    // day-latched block.
    const block = v.dailyLossHit
        ? `The daily loss limit is consumed (${(v.dayPnlPct * 100).toFixed(2)}% of equity today) — the session stands down until the next UTC day. Loosen the limit through a risk-change card if you mean it.`
        : v.tradeCapHit
            ? `The trade cap is reached (${v.tradesToday} today) — the session stands down. Raise the cap through a risk-change card if you mean it.`
            : v.streakPauseActive
                ? `${v.lossStreak} losses in a row — the streak pause stands the session down until a review.`
                : v.cooldownActiveUntil
                    ? `The post-loss cooldown runs until ${v.cooldownActiveUntil} — no new trade before it lifts.`
                    : null;
    return { block, warnings: block ? [] : v.warnings };
};
