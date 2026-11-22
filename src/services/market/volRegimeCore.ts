/**
 * volRegimeCore — the quantitative volatility / trend-regime pack, pure math
 * over CLOSED bars (zero lookahead: every estimator consumes only bars at or
 * before its index).
 *
 * Contents:
 *  - Yang-Zhang volatility (handles the open/close/high/low covariance a
 *    close-to-close σ ignores) with an empirical percentile over the tape.
 *  - Bollinger-in-Keltner squeeze and NR7 compression flags.
 *  - Expected ±1σ move (dollars + percent) over a horizon.
 *  - Lo–MacKinlay variance ratio (bias-corrected) and a variance-scaling
 *    Hurst exponent — trending vs mean-reverting reads.
 *  - Multi-horizon trend-scanning OLS t-statistics.
 *  - Al Brooks bar-geometry flags: barbwire chop, reversal-overlap trap,
 *    EMA(20) gap-bar streaks and climax bars.
 *
 * Every threshold is declared in the output so a reader can audit it.
 */

import type { Kline } from '../../types/message';

export interface YangZhangVol {
    /** Per-bar Yang-Zhang σ in price units of RETURN (decimal). */
    perBar: number;
    /** Annualized percent, using the caller's bar cadence. */
    annualizedPct: number;
    /** Percentile of the latest σ among the rolling estimates on this tape. */
    percentile: number | null;
    /** Bars the estimate was computed over. */
    windowBars: number;
}

const LOG_MIN = 1e-12;

const sampleVariance = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
};

/** Yang-Zhang σ² over one window of bars (the classic 3-component estimator). */
const yangZhangVariance = (bars: Kline[]): number | null => {
    const n = bars.length;
    if (n < 3) return null;
    const o: number[] = [];
    const c: number[] = [];
    let rs = 0;
    for (let i = 1; i < n; i++) {
        const prevClose = bars[i - 1].close;
        const { open, high, low, close } = bars[i];
        if (!(prevClose > LOG_MIN) || !(open > LOG_MIN) || !(high > LOG_MIN) || !(low > LOG_MIN) || !(close > LOG_MIN)) continue;
        o.push(Math.log(open / prevClose));
        c.push(Math.log(close / open));
        rs += Math.log(high / open) * Math.log(high / close) + Math.log(low / open) * Math.log(low / close);
    }
    const m = o.length;
    if (m < 2) return null;
    const k = 0.34 / (1.34 + (m + 1) / (m - 1));
    const varO = sampleVariance(o);
    const varC = sampleVariance(c);
    const varRS = rs / Math.max(1, m);
    return Math.max(0, varO + k * varC + (1 - k) * varRS);
};

/**
 * Yang-Zhang volatility over the trailing `window` bars, plus its empirical
 * percentile among every rolling estimate of the same length on the tape.
 * Percentile is null under `minHistory` estimates (thin tape → no rank).
 */
export const yangZhangVol = (
    candles: Kline[],
    barSeconds: number,
    window = 30,
    minHistory = 60,
): YangZhangVol | null => {
    if (candles.length < window + 2) return null;
    const estimates: number[] = [];
    for (let end = window + 1; end <= candles.length; end++) {
        const v = yangZhangVariance(candles.slice(end - window - 1, end));
        if (v !== null && v > 0) estimates.push(Math.sqrt(v));
    }
    if (estimates.length === 0) return null;
    const perBar = estimates[estimates.length - 1];
    const barsPerYear = (365 * 24 * 3600) / Math.max(1, barSeconds);
    const percentile = estimates.length >= minHistory
        ? Math.round((estimates.filter(v => v <= perBar).length / estimates.length) * 100)
        : null;
    return {
        perBar: Number(perBar.toPrecision(8)),
        annualizedPct: Number((perBar * Math.sqrt(barsPerYear) * 100).toPrecision(6)),
        percentile,
        windowBars: window,
    };
};

/** Empirical percentile rank of `value` inside `history` (0–100). */
export const percentileRank = (value: number, history: number[]): number | null => {
    if (history.length < 1) return null;
    const below = history.filter(v => v <= value).length;
    return Math.round((below / history.length) * 100);
};

const emaSeries = (closes: number[], period: number): number[] => {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    let prev = closes.slice(0, period).reduce((s, x) => s + x, 0) / period;
    const out: number[] = new Array(period - 1).fill(NaN).concat([prev]);
    for (let i = period; i < closes.length; i++) {
        prev = closes[i] * k + prev * (1 - k);
        out.push(prev);
    }
    return out;
};

const atrOfBars = (bars: Kline[]): number => {
    if (bars.length === 0) return 0;
    return bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length;
};

/**
 * Bollinger-inside-Keltner squeeze: BB(20, 2σ) bands sit INSIDE the
 * Keltner channel EMA(20) ± 1.5 × ATR(14) — the classic compression tell.
 */
export const bbKcSqueeze = (candles: Kline[], period = 20): boolean => {
    if (candles.length < period + 14) return false;
    const tail = candles.slice(-(period + 14));
    const closes = tail.map(c => c.close);
    const ema = emaSeries(closes, period);
    const lastEma = ema[ema.length - 1];
    if (!Number.isFinite(lastEma)) return false;
    const win = closes.slice(-period);
    const m = win.reduce((s, x) => s + x, 0) / period;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) * (x - m), 0) / period);
    const atr = atrOfBars(tail.slice(-14));
    if (!(atr > 0)) return false;
    const bbUpper = m + 2 * sd;
    const bbLower = m - 2 * sd;
    const kcUpper = lastEma + 1.5 * atr;
    const kcLower = lastEma - 1.5 * atr;
    return bbUpper < kcUpper && bbLower > kcLower;
};

/** NR7: the last closed bar has the narrowest high−low range of the last 7. */
export const nr7 = (candles: Kline[]): { isNr7: boolean; range: number; ofBars: number } => {
    const tail = candles.slice(-7);
    if (tail.length < 7) return { isNr7: false, range: 0, ofBars: tail.length };
    const ranges = tail.map(c => c.high - c.low);
    const last = ranges[ranges.length - 1];
    const others = ranges.slice(0, -1);
    return { isNr7: others.every(r => last <= r), range: Number(last.toPrecision(8)), ofBars: tail.length };
};

/** ±1σ expected move over `horizonBars` at a per-bar σ, in dollars and %. */
export const expectedMove1Sigma = (
    perBarSigma: number,
    price: number,
    horizonBars = 1,
): { dollars: number; percent: number; horizonBars: number } | null => {
    if (!Number.isFinite(perBarSigma) || perBarSigma <= 0 || !Number.isFinite(price) || price <= 0) return null;
    const dollars = perBarSigma * Math.sqrt(Math.max(1, horizonBars)) * price;
    return {
        dollars: Number(dollars.toPrecision(6)),
        percent: Number(((dollars / price) * 100).toPrecision(6)),
        horizonBars: Math.max(1, horizonBars),
    };
};

/**
 * Lo–MacKinlay variance ratio with the bias correction: VR(k) = σ̂²c(k) /
 * (k·σ̂²a). VR > 1 = persistent/trending, VR < 1 = mean-reverting, ≈ 1 =
 * random walk. Needs `k × 4 + 1` closes minimum so the estimator has room.
 */
export const varianceRatio = (closes: number[], k: number): number | null => {
    const n = closes.length;
    if (n < k * 4 + 1 || k < 2) return null;
    const logs: number[] = [];
    for (let i = 1; i < n; i++) {
        if (closes[i - 1] <= LOG_MIN || closes[i] <= LOG_MIN) return null;
        logs.push(Math.log(closes[i] / closes[i - 1]));
    }
    const m = logs.length;
    const mu = (Math.log(closes[n - 1] / closes[0])) / m;
    const varA = sampleVariance(logs);
    if (varA <= 0) return null;
    let acc = 0;
    let count = 0;
    for (let i = k - 1; i < m; i++) {
        const sum = logs.slice(i - k + 1, i + 1).reduce((s, x) => s + x, 0);
        acc += (sum - k * mu) ** 2;
        count += 1;
    }
    if (count <= 0) return null;
    // VR = Var(k-period sums) / (k · Var(1-period returns)) with Lo–MacKinlay
    // small-sample bias correction (1 − k/m) — ≈ 1 for IID.
    const biasFactor = Math.max(1e-9, 1 - k / m);
    const varK = acc / (count * biasFactor);
    return Number((varK / (k * varA)).toPrecision(6));
};

/**
 * Hurst exponent via variance scaling of aggregated log returns:
 * var(block sum of s) ∝ s^(2H) ⇒ H = slope/2 of ln(var) vs ln(s).
 * ≈ 0.5 random walk, < 0.5 mean-reverting, > 0.5 trending.
 */
export const hurstExponent = (closes: number[]): number | null => {
    const n = closes.length;
    if (n < 65) return null;
    const logs: number[] = [];
    for (let i = 1; i < n; i++) {
        if (closes[i - 1] <= LOG_MIN || closes[i] <= LOG_MIN) return null;
        logs.push(Math.log(closes[i] / closes[i - 1]));
    }
    const points: Array<{ s: number; v: number }> = [];
    for (const s of [2, 4, 8, 16, 32]) {
        const blocks: number[] = [];
        for (let i = 0; i + s <= logs.length; i += s) {
            blocks.push(logs.slice(i, i + s).reduce((acc, x) => acc + x, 0));
        }
        if (blocks.length < 3) continue;
        const v = sampleVariance(blocks);
        if (v > 0) points.push({ s, v });
    }
    if (points.length < 3) return null;
    const xs = points.map(p => Math.log(p.s));
    const ys = points.map(p => Math.log(p.v));
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
    }
    if (den <= 0) return null;
    return Number((num / den / 2).toPrecision(6));
};

export interface TrendScanPoint {
    horizonBars: number;
    tStat: number;
    slope: number;
}

/**
 * Trend-scanning OLS t-statistics: fit close ~ bar index over the last `h`
 * bars for each horizon and report the slope's t-stat. The max-|t| horizon
 * is the strongest (linear) trend on the tape.
 */
export const trendScanTStat = (closes: number[], horizons: number[] = [10, 20, 40, 80]): TrendScanPoint[] | null => {
    const usable = horizons.filter(h => h <= closes.length && h >= 5);
    if (usable.length === 0) return null;
    const out: TrendScanPoint[] = [];
    for (const h of usable) {
        const ys = closes.slice(-h);
        const xs = ys.map((_, i) => i);
        const mx = xs.reduce((s, x) => s + x, 0) / h;
        const my = ys.reduce((s, y) => s + y, 0) / h;
        let sxy = 0;
        let sxx = 0;
        for (let i = 0; i < h; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
        }
        if (sxx <= 0) continue;
        const slope = sxy / sxx;
        const intercept = my - slope * mx;
        let ssRes = 0;
        for (let i = 0; i < h; i++) {
            const pred = intercept + slope * xs[i];
            ssRes += (ys[i] - pred) ** 2;
        }
        const dof = h - 2;
        if (dof <= 0) continue;
        const seSlope = Math.sqrt((ssRes / dof) / sxx);
        if (!(seSlope > 0)) continue;
        out.push({ horizonBars: h, tStat: Number((slope / seSlope).toPrecision(6)), slope: Number(slope.toPrecision(8)) });
    }
    return out.length > 0 ? out : null;
};

/** The strongest trend-scan horizon by |t|. */
export const strongestTrendScan = (points: TrendScanPoint[]): TrendScanPoint | null =>
    points.length === 0 ? null : points.reduce((best, p) => (Math.abs(p.tStat) > Math.abs(best.tStat) ? p : best));

/**
 * Barbwire: 3+ consecutive bars heavily overlap (each pair shares ≥ 50% of
 * the smaller bar's range), at least one doji (body ≤ 30% of range) and at
 * least two bars with prominent tails (tails ≥ 50% of range) — the explicit
 * "NO STOP ENTRIES" chop hazard.
 */
export const barbwire = (candles: Kline[], minBars = 3): boolean => {
    if (candles.length < minBars) return false;
    const tail = candles.slice(-minBars);
    const rangeOf = (c: Kline): number => Math.max(1e-12, c.high - c.low);
    const bodyOf = (c: Kline): number => Math.abs(c.close - c.open);
    for (let i = 1; i < tail.length; i++) {
        const overlap = Math.min(tail[i - 1].high, tail[i].high) - Math.max(tail[i - 1].low, tail[i].low);
        const smaller = Math.min(rangeOf(tail[i - 1]), rangeOf(tail[i]));
        if (!(overlap >= 0.5 * smaller)) return false;
    }
    const dojis = tail.filter(c => bodyOf(c) <= 0.3 * rangeOf(c)).length;
    const tailed = tail.filter(c => (rangeOf(c) - bodyOf(c)) / rangeOf(c) >= 0.5).length;
    return dojis >= 1 && tailed >= 2;
};

/**
 * Reversal-overlap trap: a candidate bull reversal whose MIDPOINT is still
 * below… rather, ABOVE the prior bar's LOW (weak bull), or a bear reversal
 * whose midpoint is below the prior bar's HIGH (weak bear) — the trap that
 * looks like a turn but has not cleared the prior bar's geometry.
 */
export const reversalOverlapTrap = (candles: Kline[]): boolean => {
    if (candles.length < 2) return false;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const lastMid = (last.high + last.low) / 2;
    const bullReversal = last.close > last.open && last.close > prev.close;
    const bearReversal = last.close < last.open && last.close < prev.close;
    if (bullReversal) return lastMid > prev.low;
    if (bearReversal) return lastMid < prev.high;
    return false;
};

/**
 * EMA(20) gap-bar streak: consecutive closed bars whose full range never
 * touched the EMA. `maGapBarSetup` fires when the streak reached 20 and the
 * newest bar finally re-contacted (or closed through) the EMA — the pullback
 * Al Brooks waits for after an extended gap run.
 */
export const ema20GapStreak = (candles: Kline[]): { streak: number; maGapBarSetup: boolean } => {
    const closes = candles.map(c => c.close);
    const period = 20;
    const ema = emaSeries(closes, period);
    if (ema.length === 0) return { streak: 0, maGapBarSetup: false };
    const offset = closes.length - ema.length;
    const touches = (i: number): boolean => {
        const e = ema[i - offset];
        return Number.isFinite(e) && candles[i].low <= e && candles[i].high >= e;
    };
    // No-touch streak over the bars BEFORE the newest one, so the newest
    // bar's own contact can flag the pullback setup.
    let streakBefore = 0;
    // emaSeries pads indices 0..period-2 with NaN. Those bars never touched
    // the EMA because it did not exist yet — counting them as gap bars let
    // the 20-bar pullback setup fire after a single real gap bar.
    for (let i = candles.length - 2; i >= Math.max(offset, period - 1); i--) {
        if (touches(i)) break;
        streakBefore += 1;
    }
    const lastTouches = touches(candles.length - 1);
    return {
        streak: lastTouches ? 0 : streakBefore + 1,
        maGapBarSetup: lastTouches && streakBefore >= 20,
    };
};

/**
 * Climax bar: a body ≥ 2.5× the median body of the prior 20 bars arriving
 * after an unbroken same-direction close streak of ≥ 10 bars — the
 * exhaustion tell, not an entry signal.
 */
export const climaxBar = (candles: Kline[], lookback = 20): { isClimax: boolean; bodyVsMedian: number; trendStreak: number } => {
    if (candles.length < lookback + 2) return { isClimax: false, bodyVsMedian: 0, trendStreak: 0 };
    const last = candles[candles.length - 1];
    const body = Math.abs(last.close - last.open);
    const priorBodies = candles.slice(-(lookback + 1), -1).map(c => Math.abs(c.close - c.open));
    const sorted = [...priorBodies].sort((a, b) => a - b);
    const median = sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const ratio = median > 0 ? body / median : 0;
    let streak = 0;
    for (let i = candles.length - 1; i > 0; i--) {
        if (candles[i].close > candles[i - 1].close && last.close >= last.open) streak += 1;
        else if (candles[i].close < candles[i - 1].close && last.close <= last.open) streak += 1;
        else break;
    }
    const isClimax = ratio >= 2.5 && streak >= 10;
    return { isClimax, bodyVsMedian: Number(ratio.toPrecision(6)), trendStreak: streak };
};
