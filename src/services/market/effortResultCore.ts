/**
 * effortResultCore — the Wyckoff effort-vs-result read, pure math.
 *
 * Effort is volume vs the same-time-of-day average (rvol); result is the
 * spread a bar travels and how much of it it keeps. The Wyckoff vocabulary
 * (climax, no-result effort, effortless progress) is DOCUMENTED method, not
 * measured edge — thresholds are declared parameters in the output so the
 * ablation can judge them.
 */

import type { Kline } from '../../types/message';

export interface EffortBar {
    time: number;
    /** Volume ÷ the same-UTC-hour average volume (1 = typical). */
    rvol: number;
    /** |close − open| in ATR units. */
    spreadAtr: number;
    /** Where the close sits in the bar's range: +1 = at the high. */
    closePosition: number;
    read: 'drive' | 'no_result' | 'effortless' | 'climax' | 'routine';
}

export interface EffortRead {
    bars: EffortBar[];
    /** Volume-vs-price correlation over the recent window (−1..1); a
     *  strongly negative value on a rising tape is the classic divergence. */
    volumePriceCorrelation: number | null;
    divergence: 'bullish' | 'bearish' | null;
    /** Time-of-day baseline had enough history (≥3 samples per bucket)? */
    baselineKnown: boolean;
    thresholds: { rvolDrive: number; rvolClimax: number; spreadClimaxAtr: number; spreadNoResultAtr: number };
}

/** Same-time-of-day relative volume. Buckets are UTC hours; a bucket with
 *  fewer than 3 historical samples falls back to the global mean (stated in
 *  `baselineKnown`). */
export const relativeVolumeByHour = (candles: Kline[]): { rvol: (c: Kline) => number; known: boolean } => {
    const byHour = new Map<number, number[]>();
    let globalSum = 0;
    for (const c of candles) {
        if (!(c.volume > 0)) continue;
        const h = new Date(c.time).getUTCHours();
        const bucket = byHour.get(h) ?? [];
        bucket.push(c.volume);
        byHour.set(h, bucket);
        globalSum += c.volume;
    }
    const globalMean = candles.length ? globalSum / candles.length : 0;
    let known = true;
    const hourMean = new Map<number, number>();
    for (const [h, vols] of byHour) {
        if (vols.length >= 3) {
            hourMean.set(h, vols.reduce((s, v) => s + v, 0) / vols.length);
        } else {
            hourMean.set(h, globalMean);
            known = false;
        }
    }
    return {
        rvol: (c: Kline): number => {
            const h = new Date(c.time).getUTCHours();
            const base = hourMean.get(h) ?? globalMean;
            return base > 0 ? c.volume / base : 1;
        },
        known,
    };
};

const correlation = (xs: number[], ys: number[]): number | null => {
    if (xs.length !== ys.length || xs.length < 5) return null;
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
        const a = xs[i] - mx;
        const b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    if (dx <= 0 || dy <= 0) return null;
    return num / Math.sqrt(dx * dy);
};

/**
 * The effort read over the recent bars. `atr` (price units) must be > 0 —
 * without it the result half of the read is not computable and the module
 * returns null rather than guessing.
 */
export const effortVsResult = (
    candles: Kline[],
    atr: number,
    options: { recentBars?: number; historyBars?: number } = {},
): EffortRead | null => {
    if (candles.length < 20 || !(atr > 0)) return null;
    const recentBars = Math.min(options.recentBars ?? 12, candles.length);
    const historyBars = Math.min(options.historyBars ?? 168, candles.length); // ~1 week of 1h
    // The baseline pool EXCLUDES the recent window: a bar classified against
    // a mean that includes itself damps exactly the climax/churn signal this
    // read exists to find (a 3× bar inside its own baseline reads as 2.4×).
    const recentStart = Math.max(0, candles.length - recentBars);
    const baselinePool = candles.slice(0, recentStart);
    const history = baselinePool.slice(Math.max(0, baselinePool.length - historyBars));
    const { rvol, known } = relativeVolumeByHour(history);

    const recent = candles.slice(candles.length - recentBars);
    const bars: EffortBar[] = recent.map(c => {
        const r = rvol(c);
        const spreadAtr = Math.abs(c.close - c.open) / atr;
        const range = c.high - c.low;
        const closePosition = range > 0 ? (c.close - c.low) / range : 0.5;
        let read: EffortBar['read'] = 'routine';
        if (r >= 3 && spreadAtr >= 1.5 && closePosition >= 0.85) read = 'climax';
        else if (r >= 2 && spreadAtr <= 0.3) read = 'no_result';
        else if (r <= 0.5 && spreadAtr >= 1) read = 'effortless';
        else if (r >= 1.5 && spreadAtr >= 0.7) read = 'drive';
        return {
            time: c.time,
            rvol: Math.round(r * 100) / 100,
            spreadAtr: Math.round(spreadAtr * 100) / 100,
            closePosition: Math.round(closePosition * 100) / 100,
            read,
        };
    });

    const window = Math.min(20, candles.length);
    const corrCandles = candles.slice(candles.length - window);
    const corr = correlation(corrCandles.map(c => c.volume), corrCandles.map(c => c.close));

    // Volume-price divergence by halves, the same shape as the CVD read:
    // higher highs on falling volume (bearish) / lower lows on rising
    // volume (bullish).
    const half = Math.floor(window / 2);
    const first = corrCandles.slice(0, half);
    const second = corrCandles.slice(half);
    let divergence: 'bullish' | 'bearish' | null = null;
    if (corr !== null && Math.abs(corr) >= 0.4) {
        const priceUp = Math.max(...second.map(c => c.close)) > Math.max(...first.map(c => c.close));
        const volDown = second.reduce((s, c) => s + c.volume, 0) < first.reduce((s, c) => s + c.volume, 0);
        if (priceUp && volDown && corr < 0) divergence = 'bearish';
        const priceDown = Math.min(...second.map(c => c.close)) < Math.min(...first.map(c => c.close));
        const volUp = second.reduce((s, c) => s + c.volume, 0) > first.reduce((s, c) => s + c.volume, 0);
        if (priceDown && volUp && corr < 0) divergence = 'bullish';
    }

    return {
        bars,
        volumePriceCorrelation: corr === null ? null : Math.round(corr * 100) / 100,
        divergence,
        baselineKnown: known,
        thresholds: { rvolDrive: 1.5, rvolClimax: 3, spreadClimaxAtr: 1.5, spreadNoResultAtr: 0.3 },
    };
};
