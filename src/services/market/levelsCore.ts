/**
 * levelsCore — the day/week/month and session levels a discretionary trader
 * actually quotes, pure math over CLOSED candles.
 *
 * Every level carries: its price, the ATR-unit distance from the reference
 * close, and a touch count measured with a declared tolerance. The
 * previous-day/week/month periods and the session windows come from
 * `sessionConvention.ts` — the one definition.
 */

import type { Kline } from '../../types/message';
import { sessionWindowsForDay, utcDayStart, UTC_DAY_MS, type PeriodRange } from './sessionConvention';

export interface LevelRow {
    label: string;
    price: number;
    /** |reference − level| in price units. */
    distance: number;
    /** |reference − level| in ATR units (null when ATR was unavailable). */
    distanceAtr: number | null;
    /** Candles whose range came within `touchToleranceAtr` of the level. */
    touches: number;
    side: 'above' | 'below';
}

export interface LevelsRead {
    rows: LevelRow[];
    /** The periods/windows the rows were computed from. */
    windowsUsed: string[];
    touchToleranceAtr: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

const highLow = (candles: Kline[]): { high: number; low: number } | null => {
    if (candles.length === 0) return null;
    return {
        high: Math.max(...candles.map(c => c.high)),
        low: Math.min(...candles.map(c => c.low)),
    };
};

/** Candles in [start, end) whose high/low came within tolerance·ATR of the
 *  level — the touch count. Tolerance is declared in the output. */
const touchCount = (candles: Kline[], level: number, tolerance: number): number =>
    candles.filter(c => c.low - tolerance <= level && c.high + tolerance >= level).length;

const pushLevel = (
    rows: LevelRow[],
    label: string,
    price: number | null,
    reference: number,
    atr: number | null,
    tolerance: number,
    touchPool: Kline[],
): void => {
    if (price === null || !Number.isFinite(price)) return;
    rows.push({
        label,
        price: r2(price),
        distance: r2(Math.abs(reference - price)),
        distanceAtr: atr && atr > 0 ? r2(Math.abs(reference - price) / atr) : null,
        touches: touchCount(touchPool, price, tolerance),
        side: price >= reference ? 'above' : 'below',
    });
};

/**
 * The previous-period H/L levels. `periodCandles` maps a period range to the
 * CLOSED candles inside it (the adapter's job — as-of correctness lives
 * there). Levels that have no candle coverage are skipped, never zeroed.
 */
export const priorPeriodLevels = (
    periodCandles: Array<{ range: PeriodRange; candles: Kline[] }>,
    reference: number,
    atr: number | null,
    tolerance: number,
    touchPool: Kline[],
): LevelRow[] => {
    const rows: LevelRow[] = [];
    for (const { range, candles } of periodCandles) {
        const hl = highLow(candles);
        if (!hl) continue;
        pushLevel(rows, `${range.label}_high`, hl.high, reference, atr, tolerance, touchPool);
        pushLevel(rows, `${range.label}_low`, hl.low, reference, atr, tolerance, touchPool);
    }
    return rows;
};

/**
 * Session highs/lows for the named windows of the two most recent days
 * (today's completed windows + yesterday's). Only windows with candles are
 * reported.
 */
export const sessionLevelRows = (
    allCandles: Kline[],
    asofMs: number,
    reference: number,
    atr: number | null,
    tolerance: number,
): LevelRow[] => {
    const rows: LevelRow[] = [];
    const days = [utcDayStart(asofMs), utcDayStart(asofMs) - UTC_DAY_MS];
    for (const day of days) {
        for (const w of sessionWindowsForDay(day)) {
            const candles = allCandles.filter(c => c.time >= w.startMs && c.time < Math.min(w.endMs, asofMs) && c.time < asofMs);
            const hl = highLow(candles);
            if (!hl) continue;
            const tag = w.startMs >= utcDayStart(asofMs) ? 'today' : 'yesterday';
            pushLevel(rows, `${tag}_${w.session}_high`, hl.high, reference, atr, tolerance, allCandles);
            pushLevel(rows, `${tag}_${w.session}_low`, hl.low, reference, atr, tolerance, allCandles);
        }
    }
    return rows;
};

/**
 * Psychological round numbers near the reference. The step adapts to the
 * instrument's magnitude so both a six-figure coin and a sub-cent one get
 * meaningful lines. Returns the nearest `perSide` above and below.
 */
export const roundNumberRows = (
    reference: number,
    atr: number | null,
    tolerance: number,
    touchPool: Kline[],
    perSide = 3,
): LevelRow[] => {
    const rows: LevelRow[] = [];
    const abs = Math.abs(reference);
    if (!(abs > 0)) return rows;
    const step = abs >= 10_000 ? 1_000
        : abs >= 1_000 ? 100
            : abs >= 100 ? 10
                : abs >= 10 ? 1
                    : abs >= 1 ? 0.1
                        : abs >= 0.1 ? 0.01
                            : 0.001;
    const base = Math.floor(reference / step) * step;
    for (let i = 1; i <= perSide; i++) {
        pushLevel(rows, `round_${fmtStep(base + i * step)}`, base + i * step, reference, atr, tolerance, touchPool);
        pushLevel(rows, `round_${fmtStep(base - i * step)}`, base - i * step, reference, atr, tolerance, touchPool);
    }
    return rows;
};

const fmtStep = (v: number): string => {
    const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return s;
};

/** Dedupe rows whose prices sit within `tolerance` of each other, keeping
 *  the first (rows are pushed most-important first). */
export const dedupeLevels = (rows: LevelRow[], tolerance: number): LevelRow[] => {
    const kept: LevelRow[] = [];
    for (const row of rows) {
        const clash = kept.some(k => Math.abs(k.price - row.price) <= tolerance);
        if (!clash) kept.push(row);
    }
    return kept;
};
