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
    typeof c.takerBuyVolume === 'number' && Number.isFinite(c.takerBuyVolume) && c.takerBuyVolume >= 0 && c.volume >= 0
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
        if (!(c.volume > 0)) continue;
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

// ─── Wave B: spot-vs-perp CVD divergence + VPIN ─────────────────────────

export interface SpotPerpDivergence {
    available: boolean;
    reason?: string;
    /** Σ(2·takerBuy − volume) over the aligned window, per book. */
    spotCvd: number | null;
    perpCvd: number | null;
    /** (perpCvd − spotCvd) / (Σ perp volume + Σ spot volume) ∈ [−1, 1]. */
    normalizedDeltaDivergence: number | null;
    classification: 'spot_led' | 'perp_chase' | 'aligned' | 'absorption_risk' | null;
    /** Closed bars the two books share (timestamp intersection). */
    alignedBars: number;
    spotBarsUsed: number;
    perpBarsUsed: number;
    /** Declared thresholds, visible for audit. */
    thresholds: { minAlignedBars: number; strongRateShare: number; dominantRatio: number };
}

/**
 * Spot-vs-perp CVD divergence over the ALIGNED closed-bar window (timestamp
 * intersection — a missing or misaligned spot bar never masquerades as a
 * zero-delta bar). Classification rules, all volume-normalized:
 *  - same sign and one book ≥ `dominantRatio` (2×) the other → spot_led / perp_chase;
 *  - opposite signs → absorption_risk;
 *  - otherwise → aligned.
 */
export const spotPerpCvdDivergence = (
    perpCandles: Kline[],
    spotCandles: Kline[],
    options: { minAlignedBars?: number; strongRateShare?: number; dominantRatio?: number } = {},
): SpotPerpDivergence => {
    const minAlignedBars = options.minAlignedBars ?? 10;
    const strongRateShare = options.strongRateShare ?? 0.05;
    const dominantRatio = options.dominantRatio ?? 2;
    const base: SpotPerpDivergence = {
        available: false,
        spotCvd: null,
        perpCvd: null,
        normalizedDeltaDivergence: null,
        classification: null,
        alignedBars: 0,
        spotBarsUsed: spotCandles.length,
        perpBarsUsed: perpCandles.length,
        thresholds: { minAlignedBars, strongRateShare, dominantRatio },
    };
    const perpSeries = deltaSeries(perpCandles);
    const spotSeries = deltaSeries(spotCandles);
    if (!perpSeries || perpCandles.length === 0) {
        return { ...base, reason: 'perp candles lack taker-buy volume — perp CVD is not measurable' };
    }
    if (!spotSeries || spotCandles.length === 0) {
        return { ...base, reason: 'spot candles unavailable or lack taker-buy volume — spot CVD is not measurable' };
    }
    // Timestamp intersection: only bars BOTH books closed, aligned by open time.
    const spotByTime = new Map(spotCandles.map(c => [c.time, c]));
    const aligned = perpCandles.filter(c => spotByTime.has(c.time));
    if (aligned.length < minAlignedBars) {
        return { ...base, reason: `only ${aligned.length} aligned closed bar(s) between spot and perp (need ≥ ${minAlignedBars}) — divergence is not quotable` };
    }
    let spotCvd = 0;
    let perpCvd = 0;
    let volumeSum = 0;
    for (const c of aligned) {
        const s = spotByTime.get(c.time)!;
        spotCvd += 2 * (s.takerBuyVolume ?? 0) - s.volume;
        perpCvd += 2 * (c.takerBuyVolume ?? 0) - c.volume;
        volumeSum += c.volume + s.volume;
    }
    if (!(volumeSum > 0)) {
        return { ...base, reason: 'aligned window carries no volume — divergence is not quotable' };
    }
    const perpRate = perpCvd / aligned.length;
    const spotRate = spotCvd / aligned.length;
    const volRef = volumeSum / (2 * aligned.length);
    const normalized = (perpCvd - spotCvd) / volumeSum;
    const perpDominates = Math.abs(perpRate) >= dominantRatio * Math.abs(spotRate);
    const spotDominates = Math.abs(spotRate) >= dominantRatio * Math.abs(perpRate);
    const perpQuiet = Math.abs(perpRate) < strongRateShare * volRef;
    const spotQuiet = Math.abs(spotRate) < strongRateShare * volRef;
    const oppositeActive = !perpQuiet && !spotQuiet && ((perpRate > 0 && spotRate < 0) || (perpRate < 0 && spotRate > 0));
    let classification: SpotPerpDivergence['classification'];
    if (perpQuiet && spotQuiet) classification = 'aligned';
    else if (oppositeActive) classification = 'absorption_risk';
    else if (spotDominates && !perpDominates && !spotQuiet) classification = 'spot_led';
    else if (perpDominates && !spotDominates && !perpQuiet) classification = 'perp_chase';
    else if ((perpRate > 0 && spotRate < 0) || (perpRate < 0 && spotRate > 0)) classification = 'absorption_risk';
    else classification = 'aligned';
    const cleanZero = (v: number): number => (v === 0 ? 0 : v);
    return {
        available: true,
        spotCvd: cleanZero(Math.round(spotCvd * 100) / 100),
        perpCvd: cleanZero(Math.round(perpCvd * 100) / 100),
        normalizedDeltaDivergence: cleanZero(Math.round(normalized * 10000) / 10000),
        classification,
        alignedBars: aligned.length,
        spotBarsUsed: spotCandles.length,
        perpBarsUsed: perpCandles.length,
        thresholds: { minAlignedBars, strongRateShare, dominantRatio },
    };
};

export interface VpinRead {
    available: boolean;
    reason?: string;
    /** Rolling mean of the last `rollingWindow` bucket imbalances (0–1). */
    vpin: number | null;
    /** Empirical percentile of that rolling VPIN over the bucket history. */
    vpinPercentile: number | null;
    buckets: number;
    toxicityWarning: boolean;
    /** Declared thresholds, visible for audit. */
    thresholds: { minBuckets: number; targetBuckets: number; rollingWindow: number; toxicPercentile: number };
}

/**
 * Volume-synchronized probability of informed trading: closed bars are split
 * into equal-VOLUME buckets (buy vs sell volume accumulated proportionally to
 * each bar's own taker ratio), each bucket scores |buy − sell| / (buy + sell),
 * and the VPIN is the rolling mean of the last `rollingWindow` bucket scores.
 * The percentile is the current rolling VPIN's rank among every rolling value
 * on the bucket history. Refuses under `minBuckets` buckets or when any bar
 * lacks taker-buy volume (a partial series would silently misweight buckets).
 */
export const vpin = (
    candles: Kline[],
    options: { minBuckets?: number; targetBuckets?: number; rollingWindow?: number; toxicPercentile?: number } = {},
): VpinRead => {
    const minBuckets = options.minBuckets ?? 20;
    const targetBuckets = options.targetBuckets ?? 50;
    const rollingWindow = options.rollingWindow ?? 20;
    const toxicPercentile = options.toxicPercentile ?? 90;
    const thresholds = { minBuckets, targetBuckets, rollingWindow, toxicPercentile };
    const missingTaker = candles.some(c => typeof c.takerBuyVolume !== 'number' || !Number.isFinite(c.takerBuyVolume));
    if (missingTaker) {
        return { available: false, reason: 'candles lack taker-buy volume — VPIN buckets are not measurable', vpin: null, vpinPercentile: null, buckets: 0, toxicityWarning: false, thresholds };
    }
    const totalVolume = candles.reduce((s, c) => s + c.volume, 0);
    const bucketSize = totalVolume / targetBuckets;
    if (!(bucketSize > 0)) {
        return { available: false, reason: 'no volume on the window — VPIN is not measurable', vpin: null, vpinPercentile: null, buckets: 0, toxicityWarning: false, thresholds };
    }
    const probs: number[] = [];
    let accBuy = 0;
    let accSell = 0;
    const eps = Math.max(1e-9, bucketSize * 1e-9);
    for (const c of candles) {
        if (!(c.volume > 0)) continue;
        const buyVol = Math.max(0, Math.min(c.volume, c.takerBuyVolume as number));
        const buyShare = buyVol / c.volume;
        let rem = c.volume;
        while (rem > eps) {
            const need = bucketSize - (accBuy + accSell);
            const take = Math.min(need, rem);
            accBuy += take * buyShare;
            accSell += take * (1 - buyShare);
            rem -= take;
            if (accBuy + accSell >= bucketSize - eps) {
                probs.push(Math.abs(accBuy - accSell) / (accBuy + accSell));
                accBuy = 0;
                accSell = 0;
            }
        }
    }
    if (probs.length < minBuckets) {
        return { available: false, reason: `only ${probs.length} volume bucket(s) built (need ≥ ${minBuckets}) — VPIN is not quotable`, vpin: null, vpinPercentile: null, buckets: probs.length, toxicityWarning: false, thresholds };
    }
    const rolling: number[] = [];
    for (let i = rollingWindow; i <= probs.length; i++) {
        const win = probs.slice(i - rollingWindow, i);
        rolling.push(win.reduce((s, p) => s + p, 0) / rollingWindow);
    }
    const current = rolling[rolling.length - 1];
    const percentile = rolling.length > 1
        ? Math.round((rolling.filter(v => v <= current).length / rolling.length) * 100)
        : null;
    return {
        available: true,
        vpin: Number(current.toPrecision(6)),
        vpinPercentile: percentile,
        buckets: probs.length,
        toxicityWarning: percentile !== null && percentile >= toxicPercentile,
        thresholds,
    };
};
