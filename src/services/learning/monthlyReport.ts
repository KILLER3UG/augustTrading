/**
 * Monthly report card (Batch 5 remainder,) — deterministic
 * month-stats assembly ("what happened / what was learned / needs
 * attention") plus the GRADE-THE-PANEL section: per-provider and
 * ensemble-line Brier for the period, i.e. which seats were actually
 * right, not which argued best.
 *
 * Everything here is computed over the closed journal rows — no LLM call.
 * The weekly digest owns the single prose impulse; the monthly card is the
 * scoreboard. Trigger via runMonthlyReportIfDue at app start when >=30 days
 * since the last card AND >=3 closed trades in the window. Stored in
 * Preferences per user, rendered as a Journal analytics card.
 */

import { LoggedTrade } from '../../types/trade';
import { TradeOutcome, AIProvider } from '../../types/enums';
import { DebateTurn } from '../../types/message';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
// The review minimum is ONE rule for both review periods. See the note at its
// declaration before giving this module a second number of its own.
import { MIN_CLOSED_TRADES_FOR_REVIEW } from './weeklyReview';
import { buildDisciplineAnalytics, effectiveRMultiple } from '../../utils/disciplineAnalytics';
import { rowPnlUsd } from '../validation/SessionGuardService';
import { brierQuality } from '../validation/CalibrationLedgerService';

const KEY_PREFIX = 'monthly_report_v1_';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** Minimum Brier sample before a seat gets graded (thin rows are noise). */
const MIN_BRIER_SAMPLE = 3;

/** Confidence-word anchors — the same mapping ModelPerformanceService's
 *  Brier summary uses (High=0.70, Medium=0.55, Low=0.40). */
const CONFIDENCE_ANCHOR: Record<string, number> = { High: 0.70, Medium: 0.55, Low: 0.40 };

export interface PanelGradeRow {
    label: string;
    /** Closed trades in the period attributed to this seat. */
    n: number;
    wins: number;
    winRate: number;
    /** Mean (p - outcome)^2 over rows with a usable probability; null when n < MIN_BRIER_SAMPLE. */
    brier: number | null;
    /** 'good' | 'fair' | 'poor' | 'none' (coin flip = 0.25). */
    quality: 'good' | 'fair' | 'poor' | 'none';
}

export interface MonthlyReportCard {
    /** ISO timestamp of the period end (generation time). */
    generatedAt: string;
    /** ISO timestamp of the period start. */
    periodStart: string;
    whatHappened: {
        closed: number;
        wins: number;
        losses: number;
        netPnlUsd: number;
        /** Rows that actually carried a dollar figure. Absent on cards stored
         *  before this field existed; the card then refuses to claim $0. */
        dollarRows?: number;
        avgR: number | null;
    };
    whatLearned: {
        /** % of adherence-tagged trades that followed the plan. */
        adherenceFollowedPct: number | null;
        /** Most expensive mistake tag of the period (negative-PnL leader). */
        biggestMistake: string | null;
        /** Best closed trade by dollar P&L. */
        bestTrade: { label: string; pnlUsd: number } | null;
        /** Skill vs tide: among benchmark-settled closed trades, the % whose
         *  alpha beat holding the benchmark and the average alpha (pct).
         *  Null when no trade in the period was benchmark-settled. */
        tide?: { n: number; beatPct: number; avgAlpha: number } | null;
    };
    needsAttention: string[];
    /** GRADE-THE-PANEL: per-provider + ensemble-line Brier for the period. */
    panel: {
        seats: PanelGradeRow[];
        moderator: PanelGradeRow | null;
        ensembleLine: PanelGradeRow | null;
    };
}

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const isClosed = (t: LoggedTrade): boolean =>
    t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS;

const tradeLabel = (t: LoggedTrade): string => {
    const coin = t.analysis?.coinName || '';
    const dir = t.analysis?.direction || '';
    return `${coin}${dir ? ` ${dir}` : ''}`.trim() || 'trade';
};

/** Providers that contributed to a trade — modelsUsed keys first, legacy
 *  per-provider fields as fallback (mirrors ModelPerformanceService's
 *  private getTradeProviders; kept local so the stores can't drift). */
const contributingProviders = (t: LoggedTrade): string[] => {
    if (t.modelsUsed && Object.keys(t.modelsUsed).length > 0) return Object.keys(t.modelsUsed);
    // AIProvider constants, not ad-hoc strings: 'groq-new'/'groq-alt2' never
    // matched the enum ids ('groq_new'/'groq_alt2') every other stats surface
    // joins on, so the same historical trade attributed its model to one
    // provider id here and another in model performance.
    const legacy: string[] = [];
    if (t.geminiModelUsed) legacy.push(AIProvider.GEMINI);
    if (t.deepseekModelUsed) legacy.push(AIProvider.DEEPSEEK);
    if (t.zhipuModelUsed) legacy.push(AIProvider.ZHIPU);
    if (t.groqModelUsed) legacy.push(AIProvider.GROQ);
    if (t.groqNewModelUsed) legacy.push(AIProvider.GROQ_NEW);
    if (t.groqAlt2ModelUsed) legacy.push(AIProvider.GROQ_ALT2);
    if (t.openrouterModelUsed) legacy.push(AIProvider.OPENROUTER);
    return legacy;
};

const brierOf = (rows: { p: number; win: boolean }[]): number | null =>
    rows.length === 0 ? null : rows.reduce((s, r) => s + (r.p - (r.win ? 1 : 0)) ** 2, 0) / rows.length;

const gradeRow = (label: string, scored: { p: number; win: boolean }[], closedN: number, wins: number): PanelGradeRow => {
    const brier = scored.length >= MIN_BRIER_SAMPLE ? brierOf(scored) : null;
    return {
        label,
        n: closedN,
        wins,
        winRate: closedN > 0 ? (wins / closedN) * 100 : 0,
        brier,
        quality: brierQuality(brier),
    };
};

/**
 * Recompute the deterministic ensemble line for a journaled debate from its
 * stored transcript: the sealed CONVICTION lines of the LAST rebuttal round
 * (the same slice the engine scored at verdict time — the line itself is not
 * persisted on the trade, so the transcript is the source of truth and this
 * works retroactively on historical rows). Returns null when no seat
 * declared a conviction.
 */
export const ensembleLineFromTranscript = (turns: DebateTurn[] | undefined): number | null => {
    if (!turns || turns.length === 0) return null;
    const seatTurns = turns.filter(t => t.speaker !== 'Moderator' && t.speaker !== 'System' && t.speaker !== 'Trader');
    if (seatTurns.length === 0) return null;
    // Group by speaker; keep each seat's LAST conviction-bearing turn
    // (the final rebuttal round). Round numbers are optional on legacy
    // transcripts — order in the array is the fallback.
    const lastBySeat = new Map<string, number>();
    for (const turn of seatTurns) {
        const m = turn.text.match(/CONVICTION:\s*(\d{1,3})/i);
        if (!m) continue;
        lastBySeat.set(turn.speaker, Math.min(100, Math.max(0, parseInt(m[1], 10))));
    }
    if (lastBySeat.size === 0) return null;
    // The engine's deterministic line, kept here because the journal rows that
    // carry a transcript still have to be graded: the mean of the seats' sealed
    // convictions in log-odds space, mapped back to a percentage. Weights and
    // `alpha` were always 1 in the transcripts this reads.
    const meanLogit = [...lastBySeat.values()].reduce((sum, conviction) => {
        const p = Math.min(99, Math.max(1, conviction)) / 100;
        return sum + Math.log(p / (1 - p));
    }, 0) / lastBySeat.size;
    return (1 / (1 + Math.exp(-meanLogit))) * 100;
};

/** Deterministic month-stats assembly + grade-the-panel over the window. */
export const buildMonthReport = (trades: LoggedTrade[], nowMs: number): MonthlyReportCard => {
    const since = nowMs - MONTH_MS;
    const period = trades.filter(t => {
        const ts = t.analysis?.createdAt ? Date.parse(t.analysis.createdAt) : NaN;
        const open = Number.isFinite(ts) ? ts : Date.parse(t.timestamp);
        return isClosed(t) && Number.isFinite(open) && open >= since;
    });
    const wins = period.filter(t => t.outcome === TradeOutcome.WIN);
    const losses = period.filter(t => t.outcome === TradeOutcome.LOSS);
    const analytics = buildDisciplineAnalytics(period);
    const rs = period.map(effectiveRMultiple).filter((r): r is number => r !== undefined);

    // Best trade by dollar P&L.
    let bestTrade: MonthlyReportCard['whatLearned']['bestTrade'] = null;
    for (const t of period) {
        const pnl = rowPnlUsd(t, 10_000, 1);
        if (!bestTrade || pnl > bestTrade.pnlUsd) bestTrade = { label: tradeLabel(t), pnlUsd: pnl };
    }
    if (bestTrade && bestTrade.pnlUsd <= 0) bestTrade = null; // nothing green — say so by absence

    // GRADE-THE-PANEL: per-provider Brier (confidence anchor vs outcome),
    // moderator Brier (declared verdict probability vs outcome), and the
    // ensemble line recomputed from each journaled transcript.
    const seatScored = new Map<string, { p: number; win: boolean }[]>();
    const seatClosed = new Map<string, { n: number; wins: number }>();
    for (const t of period) {
        const win = t.outcome === TradeOutcome.WIN;
        const anchor = CONFIDENCE_ANCHOR[t.analysis?.confidence || ''];
        for (const provider of contributingProviders(t)) {
            const sc = seatScored.get(provider) ?? [];
            if (anchor !== undefined) sc.push({ p: anchor, win });
            seatScored.set(provider, sc);
            const c = seatClosed.get(provider) ?? { n: 0, wins: 0 };
            c.n += 1;
            if (win) c.wins += 1;
            seatClosed.set(provider, c);
        }
    }
    const seats = [...seatClosed.entries()]
        .map(([label, c]) => gradeRow(label, seatScored.get(label) ?? [], c.n, c.wins))
        .sort((a, b) => b.n - a.n);

    // Both labels name the deleted engine, and both are LEGACY-only by
    // construction: they are scored from `debateTurns`, which nothing writes
    // since the engine went. The word "legacy" is what tells a reader looking
    // for the moderator why the row can never appear on a new trade.
    const modLabel = 'moderator (legacy)';
    const modScored: { p: number; win: boolean }[] = [];
    for (const t of period) {
        const p = t.analysis?.probability;
        if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
            modScored.push({ p: Math.min(100, Math.max(0, p)) / 100, win: t.outcome === TradeOutcome.WIN });
        }
    }
    const moderator = modScored.length > 0
        ? gradeRow(modLabel, modScored, modScored.length, modScored.filter(r => r.win).length)
        : null;

    const lineScored: { p: number; win: boolean }[] = [];
    for (const t of period) {
        const line = ensembleLineFromTranscript(t.debateTurns);
        if (line !== null) lineScored.push({ p: Math.min(99, Math.max(1, line)) / 100, win: t.outcome === TradeOutcome.WIN });
    }
    const ensembleLine = lineScored.length > 0
        ? gradeRow('ensemble line (legacy)', lineScored, lineScored.length, lineScored.filter(r => r.win).length)
        : null;

    // Needs-attention lines — the honest short list, deterministic.
    const needsAttention: string[] = [];
    const followedN = analytics.adherence.followed.n;
    const brokenN = analytics.adherence.broken.n;
    if (followedN + brokenN >= 3 && followedN / (followedN + brokenN) < 0.6) {
        needsAttention.push(`Plan adherence under 60% (${followedN} followed / ${brokenN} broken)`);
    }
    const topCost = analytics.mistakeCost[0];
    if (topCost && topCost.totalPnlUsd < 0) {
        needsAttention.push(`Costliest mistake: ${topCost.tag} (${Math.round(topCost.totalPnlUsd)}$ over ${topCost.n} trades)`);
    }
    if (analytics.giveback.days > 0) {
        needsAttention.push(`${analytics.giveback.days} green day(s) finished red (giveback)`);
    }
    const graded = seats.filter(s => s.brier !== null);
    if (graded.length >= 2) {
        const worst = [...graded].sort((a, b) => (b.brier ?? 0) - (a.brier ?? 0))[0];
        if (worst.brier !== null && worst.brier > 0.25) {
            needsAttention.push(`Seat "${worst.label}" worse than coin flip (Brier ${worst.brier.toFixed(2)} over ${worst.n} closed trades)`);
        }
    }
    if (moderator?.brier != null && ensembleLine?.brier != null && ensembleLine.brier < moderator.brier - 0.02) {
        needsAttention.push(`The legacy ensemble line beat the legacy moderator this period (Brier ${ensembleLine.brier.toFixed(2)} vs ${moderator.brier.toFixed(2)}) — worth a look at how the verdict inputs were set on those old runs`);
    }
    const adherenceFollowedPct = followedN + brokenN > 0
        ? Math.round((followedN / (followedN + brokenN)) * 100)
        : null;

    // Skill vs tide (period): among benchmark-settled trades, how many beat
    // simply HOLDING the benchmark over their window, and by how much on
    // average. Trades whose alpha was never settled are not counted — a
    // missing measurement is not a loss.
    const settledTide = period.filter(t => t.benchmark && Number.isFinite(t.benchmark.alphaPct));
    const tide = settledTide.length > 0 ? {
        n: settledTide.length,
        beatPct: Math.round((settledTide.filter(t => (t.benchmark?.alphaPct ?? 0) > 0).length / settledTide.length) * 100),
        avgAlpha: Math.round((settledTide.reduce((s, t) => s + (t.benchmark?.alphaPct ?? 0), 0) / settledTide.length) * 10) / 10,
    } : null;

    return {
        generatedAt: new Date(nowMs).toISOString(),
        periodStart: new Date(since).toISOString(),
        whatHappened: {
            closed: period.length,
            wins: wins.length,
            losses: losses.length,
            netPnlUsd: period.reduce((s, t) => s + (typeof t.pnlAmount === 'number' ? t.pnlAmount : 0), 0),
            dollarRows: period.filter(t => typeof t.pnlAmount === 'number').length,
            avgR: rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
        },
        whatLearned: { adherenceFollowedPct, biggestMistake: topCost && topCost.totalPnlUsd < 0 ? topCost.tag : null, bestTrade, tide },
        needsAttention,
        panel: { seats, moderator, ensembleLine },
    };
};

/** True when a card has never been generated or is >=30 days old. */
export const isMonthlyReportDue = async (username: string, now = Date.now()): Promise<boolean> => {
    try {
        const prev = await getPreferenceObject<{ generatedAt?: string }>(keyFor(username));
        const ts = prev?.generatedAt ? Date.parse(prev.generatedAt) : NaN;
        if (!Number.isFinite(ts)) return true;
        return now - ts >= MONTH_MS;
    } catch {
        return true;
    }
};

/** Generate + store the card. Returns null when not due or too few closed
 *  trades in the window (best-effort — never throws into boot). */
export const runMonthlyReport = async (
    username: string,
    trades: LoggedTrade[],
    now = Date.now(),
): Promise<MonthlyReportCard | null> => {
    const card = buildMonthReport(trades, now);
    if (card.whatHappened.closed < MIN_CLOSED_TRADES_FOR_REVIEW) return null;
    await setPreferenceObject(keyFor(username), card);
    return card;
};

/** Boot hook: due-check then deterministic assembly, fire-and-forget. */
export const runMonthlyReportIfDue = async (
    username: string,
    trades: LoggedTrade[],
): Promise<MonthlyReportCard | null> => {
    try {
        if (!(await isMonthlyReportDue(username))) return null;
        return await runMonthlyReport(username, trades);
    } catch {
        return null;
    }
};

/** The stored card for the Journal (null when none). */
export const loadMonthlyReport = async (username: string): Promise<MonthlyReportCard | null> => {
    try {
        const c = await getPreferenceObject<MonthlyReportCard>(keyFor(username));
        return c && c.whatHappened && c.panel ? c : null;
    } catch {
        return null;
    }
};
