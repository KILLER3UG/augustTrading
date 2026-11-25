/**
 * divergenceCore — deterministic, non-repainting regular & hidden divergence
 * detector across RSI(14), MACD(12, 26, 9) histogram, and CVD proxy.
 *
 * Non-repainting & coordinate invariants:
 *   1. Excludes the forming candle (`candles[candles.length - 1]`) by default so
 *      intra-bar ticks never fabricate phantom pivots.
 *   2. Swing pivots require BOTH `pivotLeft` (default 3) and `pivotRight`
 *      (default 3) confirmed closed bars on either side: no bar with index
 *      `> closedLen - 1 - pivotRight` can ever register as a pivot.
 *   3. Emits `pivotA.time` and `pivotB.time` in canonical Unix SECONDS matching
 *      `ChartDrawing.points[].t` (`chartDrawings.ts`) and `projectTimestampToX`
 *      (`drawingHitTest.ts`).
 */

import type { Kline } from '../../types/message';
import { emaSeries } from './playbooksCore';
import { deltaSeries } from './orderFlowCore';

export type DivergenceIndicator = 'rsi' | 'macd' | 'cvd';
export type DivergenceKind =
    | 'regular_bullish'
    | 'regular_bearish'
    | 'hidden_bullish'
    | 'hidden_bearish';

export interface DivergencePivot {
    /** Canonical Unix SECONDS timestamp matching ChartDrawing points. */
    time: number;
    index: number;
    price: number;
    value: number;
}

export interface DetectedDivergence {
    indicator: DivergenceIndicator;
    kind: DivergenceKind;
    pivotA: DivergencePivot;
    pivotB: DivergencePivot;
    barsAgo: number;
    priceDeltaPct: number;
    indicatorDelta: number;
    strength: number;
}

export interface DivergenceOptions {
    symbol?: string;
    interval?: string;
    pivotLeft?: number;
    pivotRight?: number;
    minPivotGapBars?: number;
    maxPivotGapBars?: number;
    /** Exclude the final bar as a forming candle (default true). Set false ONLY when candles were already closed-filtered. */
    excludeFormingCandle?: boolean;
    indicators?: readonly DivergenceIndicator[];
}

export interface DivergenceRead {
    symbol: string;
    interval: string;
    barsAnalyzed: number;
    pivotLeft: number;
    pivotRight: number;
    divergences: DetectedDivergence[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const roundPx = (v: number): number => Number(v.toPrecision(7));

/** Normalize candle open time (ms or s) to canonical Unix SECONDS for ChartDrawing. */
export const toUnixSeconds = (t: number): number =>
    t > 1e11 ? Math.floor(t / 1000) : Math.floor(t);

/** Wilder RSI(period) aligned with `candles` (null during warmup). */
export const rsiSeries = (closes: readonly number[], period = 14): Array<number | null> => {
    const out: Array<number | null> = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= period; i += 1) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gainSum += diff;
        else lossSum -= diff;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i += 1) {
        const diff = closes[i] - closes[i - 1];
        const g = diff > 0 ? diff : 0;
        const l = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
        out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
};

/** MACD(fast, slow, signal) histogram aligned with `candles` (null during warmup). */
export const macdHistogramSeries = (
    closes: readonly number[],
    fast = 12,
    slow = 26,
    signal = 9,
): Array<number | null> => {
    const out: Array<number | null> = new Array(closes.length).fill(null);
    if (closes.length < slow + signal) return out;
    const rawCloses = [...closes];
    const emaFast = emaSeries(rawCloses, fast);
    const emaSlow = emaSeries(rawCloses, slow);
    // emaFast[k] corresponds to candle index `fast - 1 + k`
    // emaSlow[m] corresponds to candle index `slow - 1 + m`
    const macdLine: number[] = [];
    const macdIndices: number[] = [];
    for (let m = 0; m < emaSlow.length; m += 1) {
        const idx = slow - 1 + m;
        const fastIdx = idx - (fast - 1);
        if (fastIdx >= 0 && fastIdx < emaFast.length) {
            macdLine.push(emaFast[fastIdx] - emaSlow[m]);
            macdIndices.push(idx);
        }
    }
    const sigLine = emaSeries(macdLine, signal);
    for (let s = 0; s < sigLine.length; s += 1) {
        const macdPos = signal - 1 + s;
        const candleIdx = macdIndices[macdPos];
        out[candleIdx] = macdLine[macdPos] - sigLine[s];
    }
    return out;
};

interface PriceSwing {
    index: number;
    time: number;
    price: number;
}

const findConfirmedSwings = (
    candles: readonly Kline[],
    left: number,
    right: number,
): { highs: PriceSwing[]; lows: PriceSwing[] } => {
    const highs: PriceSwing[] = [];
    const lows: PriceSwing[] = [];
    const maxIdx = candles.length - 1 - right;
    for (let i = left; i <= maxIdx; i += 1) {
        const c = candles[i];
        let isHigh = true;
        let strictLeftHigh = false;
        let strictRightHigh = false;
        let isLow = true;
        let strictLeftLow = false;
        let strictRightLow = false;

        for (let j = i - left; j < i; j += 1) {
            if (candles[j].high > c.high) { isHigh = false; break; }
            if (candles[j].high < c.high) strictLeftHigh = true;
        }
        if (isHigh) {
            for (let j = i + 1; j <= i + right; j += 1) {
                if (candles[j].high > c.high) { isHigh = false; break; }
                if (candles[j].high < c.high) strictRightHigh = true;
            }
        }
        if (isHigh && strictLeftHigh && strictRightHigh) {
            highs.push({ index: i, time: toUnixSeconds(c.time), price: c.high });
        }

        for (let j = i - left; j < i; j += 1) {
            if (candles[j].low < c.low) { isLow = false; break; }
            if (candles[j].low > c.low) strictLeftLow = true;
        }
        if (isLow) {
            for (let j = i + 1; j <= i + right; j += 1) {
                if (candles[j].low < c.low) { isLow = false; break; }
                if (candles[j].low > c.low) strictRightLow = true;
            }
        }
        if (isLow && strictLeftLow && strictRightLow) {
            lows.push({ index: i, time: toUnixSeconds(c.time), price: c.low });
        }
    }
    return { highs, lows };
};

/** Ensure intermediate closes do not slice materially past the pivot segment. */
const segmentClear = (
    candles: readonly Kline[],
    a: PriceSwing,
    b: PriceSwing,
    side: 'high' | 'low',
): boolean => {
    const span = b.index - a.index;
    if (span <= 1) return true;
    const tol = 0.002;
    for (let k = a.index + 1; k < b.index; k += 1) {
        const seg = a.price + ((b.price - a.price) * (k - a.index)) / span;
        if (side === 'high' && candles[k].close > seg * (1 + tol)) return false;
        if (side === 'low' && candles[k].close < seg * (1 - tol)) return false;
    }
    return true;
};

const scoreStrength = (
    priceDeltaPct: number,
    indDelta: number,
    indRange: number,
    barsAgo: number,
): number => {
    const pTerm = Math.min(1, Math.abs(priceDeltaPct) / 2.5);
    const iTerm = indRange > 0 ? Math.min(1, Math.abs(indDelta) / (0.35 * indRange)) : 0.5;
    const recency = Math.max(0.2, 1 - barsAgo / 100);
    return round4(Math.min(1, Math.max(0.05, (0.4 * pTerm + 0.4 * iTerm + 0.2 * recency))));
};

/**
 * Detect non-repainting regular & hidden bullish/bearish divergences.
 */
export const detectDivergences = (
    rawCandles: readonly Kline[],
    options: DivergenceOptions = {},
): DivergenceRead => {
    const symbol = options.symbol ?? '';
    const interval = options.interval ?? '1h';
    const pivotLeft = Math.round(clamp(options.pivotLeft ?? 3, 2, 10));
    const pivotRight = Math.round(clamp(options.pivotRight ?? 3, 2, 10));
    const minGap = Math.max(2, Math.round(options.minPivotGapBars ?? 4));
    const maxGap = Math.max(minGap + 2, Math.round(options.maxPivotGapBars ?? 80));
    const excludeForming = options.excludeFormingCandle !== false;

    const candles = excludeForming ? rawCandles.slice(0, -1) : [...rawCandles];
    if (candles.length < pivotLeft + pivotRight + minGap + 15) {
        return { symbol, interval, barsAnalyzed: candles.length, pivotLeft, pivotRight, divergences: [] };
    }

    const wantedIndicators = new Set<DivergenceIndicator>(
        options.indicators && options.indicators.length > 0
            ? options.indicators
            : ['rsi', 'macd', 'cvd'],
    );

    const closes = candles.map(c => c.close);
    const { highs, lows } = findConfirmedSwings(candles, pivotLeft, pivotRight);

    const seriesMap: Array<{ name: DivergenceIndicator; values: Array<number | null> }> = [];
    if (wantedIndicators.has('rsi')) {
        seriesMap.push({ name: 'rsi', values: rsiSeries(closes, 14) });
    }
    if (wantedIndicators.has('macd')) {
        seriesMap.push({ name: 'macd', values: macdHistogramSeries(closes, 12, 26, 9) });
    }
    if (wantedIndicators.has('cvd')) {
        const cvd = deltaSeries(candles);
        if (cvd && cvd.cvdSeries.length === candles.length) {
            seriesMap.push({ name: 'cvd', values: cvd.cvdSeries });
        }
    }

    const found: DetectedDivergence[] = [];
    const lastClosedIdx = candles.length - 1;

    for (const { name, values } of seriesMap) {
        const validVals = values.filter((v): v is number => v !== null && Number.isFinite(v));
        if (validVals.length === 0) continue;
        const minV = Math.min(...validVals);
        const maxV = Math.max(...validVals);
        const indRange = Math.max(1e-9, maxV - minV);

        // Scan recent confirmed lows (regular_bullish / hidden_bullish)
        const seenB = new Set<string>();
        const recentLows = lows.slice(-10);
        for (let bIdx = recentLows.length - 1; bIdx >= 1; bIdx -= 1) {
            const pb = recentLows[bIdx];
            const vb = values[pb.index];
            if (vb === null || !Number.isFinite(vb)) continue;

            for (let aIdx = bIdx - 1; aIdx >= 0; aIdx -= 1) {
                const pa = recentLows[aIdx];
                const gap = pb.index - pa.index;
                if (gap < minGap || gap > maxGap) continue;
                const va = values[pa.index];
                if (va === null || !Number.isFinite(va)) continue;
                if (!segmentClear(candles, pa, pb, 'low')) continue;

                let kind: DivergenceKind | null = null;
                if (pb.price < pa.price && vb > va) kind = 'regular_bullish';
                else if (pb.price > pa.price && vb < va) kind = 'hidden_bullish';
                if (!kind) continue;

                const dedupeKey = `${name}:${kind}:${pb.index}`;
                if (seenB.has(dedupeKey)) continue;
                seenB.add(dedupeKey);

                const barsAgo = lastClosedIdx - pb.index;
                const priceDeltaPct = round4(((pb.price - pa.price) / pa.price) * 100);
                const indicatorDelta = round4(vb - va);
                found.push({
                    indicator: name,
                    kind,
                    pivotA: { time: pa.time, index: pa.index, price: roundPx(pa.price), value: round4(va) },
                    pivotB: { time: pb.time, index: pb.index, price: roundPx(pb.price), value: round4(vb) },
                    barsAgo,
                    priceDeltaPct,
                    indicatorDelta,
                    strength: scoreStrength(priceDeltaPct, indicatorDelta, indRange, barsAgo),
                });
                break;
            }
        }

        // Scan recent confirmed highs (regular_bearish / hidden_bearish)
        const recentHighs = highs.slice(-10);
        for (let bIdx = recentHighs.length - 1; bIdx >= 1; bIdx -= 1) {
            const pb = recentHighs[bIdx];
            const vb = values[pb.index];
            if (vb === null || !Number.isFinite(vb)) continue;

            for (let aIdx = bIdx - 1; aIdx >= 0; aIdx -= 1) {
                const pa = recentHighs[aIdx];
                const gap = pb.index - pa.index;
                if (gap < minGap || gap > maxGap) continue;
                const va = values[pa.index];
                if (va === null || !Number.isFinite(va)) continue;
                if (!segmentClear(candles, pa, pb, 'high')) continue;

                let kind: DivergenceKind | null = null;
                if (pb.price > pa.price && vb < va) kind = 'regular_bearish';
                else if (pb.price < pa.price && vb > va) kind = 'hidden_bearish';
                if (!kind) continue;

                const dedupeKey = `${name}:${kind}:${pb.index}`;
                if (seenB.has(dedupeKey)) continue;
                seenB.add(dedupeKey);

                const barsAgo = lastClosedIdx - pb.index;
                const priceDeltaPct = round4(((pb.price - pa.price) / pa.price) * 100);
                const indicatorDelta = round4(vb - va);
                found.push({
                    indicator: name,
                    kind,
                    pivotA: { time: pa.time, index: pa.index, price: roundPx(pa.price), value: round4(va) },
                    pivotB: { time: pb.time, index: pb.index, price: roundPx(pb.price), value: round4(vb) },
                    barsAgo,
                    priceDeltaPct,
                    indicatorDelta,
                    strength: scoreStrength(priceDeltaPct, indicatorDelta, indRange, barsAgo),
                });
                break;
            }
        }
    }

    found.sort((a, b) => a.barsAgo - b.barsAgo || b.strength - a.strength);

    return {
        symbol,
        interval,
        barsAnalyzed: candles.length,
        pivotLeft,
        pivotRight,
        divergences: found.slice(0, 10),
    };
};
