/**
 * orderFlowCore — candle-level order flow, pure math.
 *
 * EVERY number this module produces is an ESTIMATE. Taker-buy volume per
 * candle is a real measurement (Binance kline field 9, kept by the tape
 * parser), but candle aggregation is not footprint: delta here means
 * "2 × takerBuy − volume", not matched orders at price levels. The tool
 * layer must label it so. A candle missing the taker-buy field makes the
 * read unavailable — never zero, never approximated from close position
 * (the old `calculateCVD` approximation is exactly what this replaces for
 * the desk tools).
 */

import type { Kline } from '../../types/message';

/** Per-candle delta: 2·takerBuy − volume. `null` when the field is absent. */
export const candleDelta = (c: Kline): number | null =>
    typeof c.takerBuyVolume === 'number' && Number.isFinite(c.takerBuyVolume) && c.volume > 0
        ? 2 * c.takerBuyVolume - c.volume
        : null;

export interface DeltaSeries {
    deltas: Array<{ time: number; delta: number }>;
    cvd: number;
    /** Cumulative delta series (same length as deltas). */
    cvdSeries: number[];
    buyVolume: number;
    sellVolume: number;
}

/** The delta series over candles; `null` when ANY candle lacks taker-buy
 *  volume — a partially-known series would silently misweight the CVD. */
export const deltaSeries = (candles: Kline[]): DeltaSeries | null => {
    if (candles.length === 0) return null;
    const deltas: Array<{ time: number; delta: number }> = [];
    const cvdSeries: number[] = [];
    let cvd = 0;
    let buy = 0;
    let sell = 0;
    for (const c of candles) {
        const d = candleDelta(c);
        if (d === null) return null;
        cvd += d;
        buy += c.takerBuyVolume as number;
        sell += c.volume - (c.takerBuyVolume as number);
        deltas.push({ time: c.time, delta: d });
        cvdSeries.push(cvd);
    }
    return { deltas, cvd, cvdSeries, buyVolume: buy, sellVolume: sell };
};

/**
 * Price-vs-CVD divergence over a window, read by halves: if the second half
 * makes a higher price high than the first while its net delta is negative,
 * the advance is being sold into (bearish divergence) — and the mirror for
 * bullish. A half-window comparison is coarse but deterministic; finer
 * swing-pairing is a P1 refinement, not a better definition.
 */
export const cvdDivergence = (
    candles: Kline[],
    series: DeltaSeries,
    window = 20,
): 'bullish' | 'bearish' | null => {
    const n = Math.min(window, candles.length);
    if (n < 4) return null; // two halves of at least two bars each
    const recent = candles.slice(candles.length - n);
    const half = Math.floor(n / 2);
    const firstHigh = Math.max(...recent.slice(0, half).map(c => c.high));
    const secondHigh = Math.max(...recent.slice(half).map(c => c.high));
    const firstLow = Math.min(...recent.slice(0, half).map(c => c.low));
    const secondLow = Math.min(...recent.slice(half).map(c => c.low));
    const secondDeltas = series.deltas.slice(series.deltas.length - (n - half));
    const netSecond = secondDeltas.reduce((s, d) => s + d.delta, 0);

    if (secondHigh > firstHigh && netSecond < 0) return 'bearish';
    if (secondLow < firstLow && netSecond > 0) return 'bullish';
    return null;
};

export interface FlowEvent {
    time: number;
    kind: 'absorption' | 'exhaustion';
    side: 'buy' | 'sell';
    /** Effort: the candle's volume z-score vs the window. */
    volumeZ: number;
    detail: string;
    estimate: true;
}

export interface FlowEventsRead {
    events: FlowEvent[];
    /** Bar count the z-scores were measured against. */
    windowBars: number;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map(x => (x - m) * (x - m))));
};

/**
 * Absorption and exhaustion events over the recent window.
 *  - absorption: volume z ≥ 2 with a small range (≤ 0.4 × ATR) — heavy
 *    effort, no progress; `side` is the side being absorbed (the delta
 *    direction that failed to move price).
 *  - exhaustion: volume z ≥ 2 with near-zero |delta|/volume (≤ 0.1) — a
 *    two-sided fight at volume, no net winner.
 * ATR is passed in (price units) by the caller; a non-positive ATR disables
 * the absorption range test rather than inventing one.
 */
export const flowEvents = (
    candles: Kline[],
    atr: number,
    window = 60,
    zThreshold = 2,
): FlowEventsRead | null => {
    const n = Math.min(window, candles.length);
    if (n < 10) return null;
    const series = deltaSeries(candles);
    if (!series) return null;
    const recent = candles.slice(candles.length - n);
    const recentDeltas = series.deltas.slice(series.deltas.length - n);
    const vols = recent.map(c => c.volume);
    const mu = mean(vols);
    const sd = stdev(vols);
    if (mu <= 0 || sd <= 0) return null;

    const events: FlowEvent[] = [];
    for (let i = 0; i < n; i++) {
        const c = recent[i];
        const d = recentDeltas[i].delta;
        const z = (c.volume - mu) / sd;
        if (z < zThreshold) continue;
        const deltaShare = Math.abs(d) / c.volume;
        const spread = c.high - c.low;
        if (deltaShare <= 0.1) {
            events.push({ time: c.time, kind: 'exhaustion', side: d >= 0 ? 'buy' : 'sell', volumeZ: Math.round(z * 100) / 100, detail: `volume ${z.toFixed(1)}σ with |delta| ${(deltaShare * 100).toFixed(0)}% of volume`, estimate: true });
        } else if (atr > 0 && spread <= 0.4 * atr) {
            events.push({ time: c.time, kind: 'absorption', side: d >= 0 ? 'buy' : 'sell', volumeZ: Math.round(z * 100) / 100, detail: `volume ${z.toFixed(1)}σ into a ${(spread / atr).toFixed(2)}×ATR range`, estimate: true });
        }
    }
    return { events: events.slice(-6), windowBars: n };
};
