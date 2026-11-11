/**
 * chartIndicators — the ONE indicator module the chart renders from.
 *
 * Why this file exists: before it, the chart hand-rolled its own `sma()`
 * (`components/trade/TradingChart.tsx`), the prompt read `technicalindicators`
 * through `services/analysis/TechnicalAnalysisService.ts`, `taLibrary.ts` owned
 * a third set of primitives, and the Python pipeline in `Agentic-Trading` owned
 * a fourth. Nine indicators disagreed (see `design/chart-okx-audit-2026-11-09.md`),
 * two of them changing decisions: `smcStructure.atr14` was a simple average of
 * true range while everything else is Wilder, and the setup scanner's "EMA20"
 * was an SMA20. Both now read this module.
 *
 * This module is the single source for the CHART and for `get_chart_studies`.
 * It is NOT yet the prompt's only source: `TechnicalAnalysisService` still
 * calls `technicalindicators` directly and `taLibrary` still serves the desk
 * its own primitives. Migrating those consumers is O-150 in
 * `docs/plan/open-items.md`, and until it lands "the model sees the same
 * numbers the chart shows" is true only for the `get_chart_studies` tool.
 * Parity tests pin this module against `technicalindicators` so the library
 * cannot drift away silently.
 *
 * CONVENTIONS — pinned, and asserted by `check:contracts`:
 *
 *  - **Bar-aligned.** Every series is `(number | null)[]` with one entry per
 *    input bar, `null` before warm-up completes. No offset arrays: an offset
 *    array is how `taLibrary` reads the wrong bar in a composed study.
 *  - **EMA seeds with the SMA of the first `period` values**, `k = 2/(period+1)`,
 *    first value at bar `period-1`. This is the `technicalindicators`
 *    convention and the majority of the repo (`playbooksCore`, `regime`,
 *    `screener`). `taLibrary.emaOf`'s first-value seed is the outlier and is
 *    migrated onto this module rather than copied.
 *  - **RSI and ATR use Wilder smoothing** (`alpha = 1/period`) seeded with the
 *    SMA of the first `period` changes / true ranges, first value at bar
 *    `period`.
 *  - **Bollinger is SMA + population standard deviation**, first value at bar
 *    `period-1`.
 *  - **Every value at bar i reads only bars <= i.** No lookahead, so a series
 *    computed over a window ending at T is safe to print at T.
 *  - **No NaN.** Degenerate input returns `null`s, never NaN — a NaN in a
 *    legend becomes "NaN" in a prompt.
 */

export type Series = (number | null)[];

/** SMA, bar-aligned: `null` until bar `period-1`. */
export const smaSeries = (values: number[], period: number): Series => {
    const out: Series = new Array(values.length).fill(null);
    if (period <= 0) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        sum += values[i];
        if (i >= period) sum -= values[i - period];
        if (i >= period - 1) out[i] = sum / period;
    }
    return out;
};

/** EMA, bar-aligned: SMA seed of the first `period` values, `null` until `period-1`. */
export const emaSeries = (values: number[], period: number): Series => {
    const out: Series = new Array(values.length).fill(null);
    if (period <= 0 || values.length < period) return out;
    let prev = 0;
    for (let i = 0; i < period; i += 1) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
};

/** RSI (Wilder), bar-aligned: `null` until bar `period`. */
export const rsiSeries = (closes: number[], period = 14): Series => {
    const out: Series = new Array(closes.length).fill(null);
    if (period <= 0 || closes.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period;
    loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i += 1) {
        const d = closes[i] - closes[i - 1];
        gain = (gain * (period - 1) + Math.max(d, 0)) / period;
        loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
};

/** ATR (Wilder), bar-aligned: `null` until bar `period`. Uses TRUE range.
 *  This is the value the chart draws and the value `smcStructure.atr14` now
 *  reads (it was a simple average of true range before 6b3f4fe9). The other
 *  desk consumers are still on their own copies; O-150 tracks that
 *  migration. */
export const atrSeries = (
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14,
): Series => {
    const out: Series = new Array(closes.length).fill(null);
    if (period <= 0 || closes.length <= period) return out;
    const trueRange = (i: number): number => {
        if (i <= 0) return highs[0] - lows[0];
        return Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1]),
        );
    };
    let prev = 0;
    for (let i = 1; i <= period; i += 1) prev += trueRange(i);
    prev /= period;
    out[period] = prev;
    for (let i = period + 1; i < closes.length; i += 1) {
        prev = (prev * (period - 1) + trueRange(i)) / period;
        out[i] = prev;
    }
    return out;
};

/** ATR as a single last value — the legend's read. */
export const atrOf = (highs: number[], lows: number[], closes: number[], period = 14): number | null =>
    lastOf(atrSeries(highs, lows, closes, period));

export interface BollingerSeries {
    mid: Series;
    upper: Series;
    lower: Series;
}

/** Bollinger Bands: SMA(period) ± mult × population SD, bar-aligned. */
export const bollingerSeries = (closes: number[], period = 20, mult = 2): BollingerSeries => {
    const mid = smaSeries(closes, period);
    const upper: Series = new Array(closes.length).fill(null);
    const lower: Series = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i += 1) {
        const centre = mid[i];
        if (centre === null) continue;
        let acc = 0;
        for (let j = i - period + 1; j <= i; j += 1) acc += (closes[j] - centre) ** 2;
        const sd = Math.sqrt(acc / period);
        upper[i] = centre + mult * sd;
        lower[i] = centre - mult * sd;
    }
    return { mid, upper, lower };
};

export interface MacdSeries {
    macd: Series;
    signal: Series;
    histogram: Series;
}

/** MACD(12, 26, 9): EMA(fast) − EMA(slow), signal = EMA of that, bar-aligned. */
export const macdSeries = (closes: number[], fast = 12, slow = 26, signal = 9): MacdSeries => {
    const fastSeries = emaSeries(closes, fast);
    const slowSeries = emaSeries(closes, slow);
    const macd: Series = closes.map((_, i) => (
        fastSeries[i] !== null && slowSeries[i] !== null ? (fastSeries[i] as number) - (slowSeries[i] as number) : null
    ));
    // The signal is an EMA of the MACD line, seeded with the SMA of its first
    // `signal` values, so its first value lands at bar `slow - 1 + signal - 1`.
    const first = slow - 1;
    const sig: Series = new Array(closes.length).fill(null);
    if (closes.length >= first + signal) {
        let prev = 0;
        for (let i = first; i < first + signal; i += 1) prev += macd[i] as number;
        prev /= signal;
        sig[first + signal - 1] = prev;
        const k = 2 / (signal + 1);
        for (let i = first + signal; i < closes.length; i += 1) {
            prev = (macd[i] as number) * k + prev * (1 - k);
            sig[i] = prev;
        }
    }
    const histogram: Series = closes.map((_, i) => (
        macd[i] !== null && sig[i] !== null ? (macd[i] as number) - (sig[i] as number) : null
    ));
    return { macd, signal: sig, histogram };
};

/** EMA over a series that may start with `null`s: the seed is the SMA of the
 *  first `period` NON-NULL values, so a composed study (EMA of an EMA) warms up
 *  after the inner study, not from bar 0. */
const emaFromSeries = (series: readonly (number | null)[], period: number): Series => {
    const out: Series = new Array(series.length).fill(null);
    const first = series.findIndex(v => v !== null);
    if (period <= 0 || first < 0 || series.length - first < period) return out;
    let prev = 0;
    for (let i = first; i < first + period; i += 1) prev += series[i] as number;
    prev /= period;
    out[first + period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = first + period; i < series.length; i += 1) {
        prev = (series[i] as number) * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
};

export interface TsiSeries {
    tsi: Series;
    signal: Series;
}

/** True Strength Index (OKX 25, 13, 13): double-smoothed momentum over
 *  double-smoothed absolute momentum, plus its EMA signal. Bar-aligned.
 *  Not in `technicalindicators`, so it carries no library parity test — the
 *  parity contract here is the definition itself. */
export const tsiSeries = (closes: number[], long = 25, short = 13, signal = 13): TsiSeries => {
    const momentum = closes.map((c, i) => (i === 0 ? 0 : c - closes[i - 1]));
    const doubleSmooth = (values: number[]): Series => emaFromSeries(emaFromSeries(values, long), short);
    const smoothed = doubleSmooth(momentum);
    const smoothedAbs = doubleSmooth(momentum.map(m => Math.abs(m)));
    const tsi: Series = closes.map((_, i) => {
        const s = smoothed[i];
        const a = smoothedAbs[i];
        if (s === null || a === null || a === 0) return null;
        return 100 * (s / a);
    });
    const signalLine = emaFromSeries(tsi, signal);
    return { tsi, signal: signalLine };
};

/** The last non-null value of a series, or null. What a legend prints. */
export const lastOf = (series: Series): number | null => {
    for (let i = series.length - 1; i >= 0; i -= 1) {
        if (series[i] !== null) return series[i] as number;
    }
    return null;
};

// ─── VWAP ────────────────────────────────────────────────────────────────────

export interface VwapCandle {
    time: number;
    high: number;
    low: number;
    close: number;
    /** A bar with no volume (or zero) cannot move a volume-weighted average:
     *  its own entry is `null` and the cumulative carries through untouched. */
    volume?: number;
}

/** Per-bar VWAP, bar-aligned: the volume-weighted typical price
 *  ((H+L+C)/3) accumulated from an anchor. TWO anchor modes, one function:
 *  · `anchorTime === null` — SESSION VWAP: the accumulation RESETS at every
 *    UTC day boundary, which is what OKX draws by default and what
 *    `sessionConvention.utcDayStart` means elsewhere in this app;
 *  · `anchorTime` set — ANCHORED VWAP: every bar before the anchor is `null`;
 *    the accumulation starts at the anchor bar.
 *  The cumulative itself is exact recursion: cumPV and cumV grow, and each
 *  bar's value is cumPV/cumV — a forming bar changes only its own entry. */
export const vwapSeries = (candles: readonly VwapCandle[], anchorTime: number | null = null): Series => {
    const out: Series = new Array(candles.length).fill(null);
    const UTC_DAY_MS = 86_400_000;
    let cumPV = 0;
    let cumV = 0;
    let currentDay: number | null = null;
    let anchored = anchorTime === null;
    for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i];
        if (anchorTime !== null) {
            if (!anchored) {
                if (c.time < anchorTime) continue; // before the anchor: no value
                anchored = true; // the anchor bar itself is the first accumulated
            }
        } else {
            const day = Math.floor(c.time * 1000 / UTC_DAY_MS);
            if (day !== currentDay) {
                currentDay = day;
                cumPV = 0;
                cumV = 0;
            }
        }
        const vol = typeof c.volume === 'number' && Number.isFinite(c.volume) && c.volume > 0 ? c.volume : null;
        if (vol === null) continue; // carry the cumulative; this bar has no VWAP
        const typical = (c.high + c.low + c.close) / 3;
        cumPV += typical * vol;
        cumV += vol;
        out[i] = cumV > 0 ? cumPV / cumV : null;
    }
    return out;
};
