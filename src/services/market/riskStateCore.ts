/**
 * riskStateCore — the trader's risk state from the journal, pure math over
 * `LoggedTrade[]`.
 *
 * Three reads, all advisory, all refusing when the sample is thin:
 *  - OPEN RISK: rows still `PENDING` are the portfolio's open risk. Heat is
 *    counted in R-units (each open plan risks ~1R by convention — the plan's
 *    own numbers are echoed), grouped by base coin so correlated exposure is
 *    visible.
 *  - DRAWDOWN LIGHT: realized R summed by UTC day and by UTC week; the
 *    traffic-light thresholds are declared constants, not vibes.
 *  - KELLY CEILING: half-Kelly from the CLOSED rows' net R pool (W − (1−W)/R
 *    with R = avgWin/avgLoss), REFUSED under `MIN_TRADES_FOR_KELLY` — a
 *    Kelly number off ten trades is a lie with a formula attached. The
 *    standard formula is implemented here because the existing Kelly
 *    (`StopLossOptimizerService.calculateKellyScore`) sizes STOPS from its
 *    own optimizer pool, a different question.
 *
 * P&L is accounting, not the product line: this module exists for the
 * position-sizing and refusal decisions (docs/product/focus.md), and says so
 * in its outputs.
 */

import type { LoggedTrade } from '../../types/trade';

export interface OpenRiskRow {
    id: string;
    coin: string;
    direction: string;
    entry: number | null;
    stop: number | null;
    /** The plan's own R:R (nearest target ÷ stop) — 0 when not computable. */
    plannedRr: number;
    loggedAt: string;
}

export interface RiskStateRead {
    open: {
        count: number;
        byCoin: Array<{ coin: string; count: number; directions: string[] }>;
        /** Correlated exposure warning: ≥2 open plans on the same base coin. */
        correlated: boolean;
        rows: OpenRiskRow[];
    };
    drawdown: {
        todayR: number;
        weekR: number;
        light: 'green' | 'yellow' | 'red';
        thresholds: { yellowR: number; redR: number };
    };
    kelly: {
        available: boolean;
        reason?: string;
        tradesUsed?: number;
        winRate?: number;
        avgWinR?: number;
        avgLossR?: number;
        /** Full Kelly fraction of equity (0–1). */
        fullKelly?: number;
        /** HALF Kelly — the ceiling the harness quotes. */
        halfKellyPct?: number;
    };
    note: string;
}

const MIN_TRADES_FOR_KELLY = 20;

const parseNum = (v: string | number | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
};

const utcDayKey = (ms: number): string => new Date(Math.floor(ms / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
const utcWeekKey = (ms: number): string => {
    const day = Math.floor(ms / 86_400_000) * 86_400_000;
    const dow = (new Date(day).getUTCDay() + 6) % 7;
    return new Date(day - dow * 86_400_000).toISOString().slice(0, 10);
};

export const readRiskState = (
    trades: LoggedTrade[],
    now: number = Date.now(),
    thresholds: { yellowR: number; redR: number } = { yellowR: -2, redR: -4 },
): RiskStateRead => {
    const rows = trades ?? [];

    // ── open risk: outcome still PENDING ────────────────────────────────
    const openRows: OpenRiskRow[] = [];
    for (const t of rows) {
        if (t.outcome !== 'PENDING') continue;
        const a = t.analysis;
        const entry = parseNum(a.entryPoints?.[0]?.price);
        const stop = parseNum(a.stopLoss);
        openRows.push({
            id: t.id,
            coin: a.coinName ?? '?',
            direction: a.direction ?? '?',
            entry,
            stop,
            plannedRr: 0, // filled by the adapter via plannedRiskReward when targets exist
            loggedAt: t.timestamp,
        });
    }
    const byCoin = new Map<string, { coin: string; count: number; directions: string[] }>();
    for (const r of openRows) {
        const key = r.coin.replace(/USDT$/i, '');
        const hit = byCoin.get(key) ?? { coin: key, count: 0, directions: [] };
        hit.count += 1;
        if (!hit.directions.includes(r.direction)) hit.directions.push(r.direction);
        byCoin.set(key, hit);
    }

    // ── drawdown light: realized R by UTC day/week ──────────────────────
    const dayR = new Map<string, number>();
    const weekR = new Map<string, number>();
    for (const t of rows) {
        if (t.outcome === 'PENDING' || t.outcome === 'ENTRY_NOT_HIT') continue;
        const r = typeof t.realizedR === 'number' ? t.realizedR : null;
        if (r === null) continue;
        const ms = Date.parse(t.decidedAt ?? t.timestamp);
        if (!Number.isFinite(ms)) continue;
        const dk = utcDayKey(ms);
        const wk = utcWeekKey(ms);
        dayR.set(dk, (dayR.get(dk) ?? 0) + r);
        weekR.set(wk, (weekR.get(wk) ?? 0) + r);
    }
    const todayR = dayR.get(utcDayKey(now)) ?? 0;
    const weekRNow = weekR.get(utcWeekKey(now)) ?? 0;
    const worst = Math.min(todayR, weekRNow);
    const light: RiskStateRead['drawdown']['light'] = worst <= thresholds.redR ? 'red'
        : worst <= thresholds.yellowR ? 'yellow' : 'green';

    // ── half-Kelly from the closed net-R pool ───────────────────────────
    const closedR = rows
        .filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS')
        .map(t => (typeof t.netR === 'number' ? t.netR : typeof t.realizedR === 'number' ? t.realizedR : null))
        .filter((r): r is number => r !== null);
    const wins = closedR.filter(r => r > 0);
    const losses = closedR.filter(r => r <= 0);
    let kelly: RiskStateRead['kelly'];
    if (closedR.length < MIN_TRADES_FOR_KELLY || wins.length === 0 || losses.length === 0) {
        kelly = {
            available: false,
            reason: `need ≥${MIN_TRADES_FOR_KELLY} closed trades with R and both outcomes (have ${closedR.length}) — a Kelly number off a thin sample is a lie with a formula attached`,
        };
    } else {
        const winRate = wins.length / closedR.length;
        const avgWinR = wins.reduce((s, r) => s + r, 0) / wins.length;
        const avgLossR = Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length);
        const payoff = avgLossR > 0 ? avgWinR / avgLossR : 0;
        const fullKelly = payoff > 0 ? Math.max(0, winRate - (1 - winRate) / payoff) : 0;
        kelly = {
            available: true,
            tradesUsed: closedR.length,
            winRate: Math.round(winRate * 1000) / 1000,
            avgWinR: Math.round(avgWinR * 1000) / 1000,
            avgLossR: Math.round(avgLossR * 1000) / 1000,
            fullKelly: Math.round(fullKelly * 1000) / 1000,
            halfKellyPct: Math.round(fullKelly * 50 * 1000) / 1000, // HALF Kelly, as % of equity
        };
    }

    return {
        open: {
            count: openRows.length,
            byCoin: [...byCoin.values()],
            correlated: [...byCoin.values()].some(c => c.count >= 2),
            rows: openRows.slice(-10),
        },
        drawdown: {
            todayR: Math.round(todayR * 100) / 100,
            weekR: Math.round(weekRNow * 100) / 100,
            light,
            thresholds,
        },
        kelly,
        note: 'advisory context for sizing and refusal decisions — heat counts open plans (each ~1R by convention); it is not a P&L report',
    };
};

/** Exposed for the tool's available:false copy. */
export const MIN_TRADES_FOR_KELLY_FLOOR = MIN_TRADES_FOR_KELLY;
