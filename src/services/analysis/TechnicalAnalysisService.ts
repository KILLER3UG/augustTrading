/**
 * TechnicalAnalysisService - Programmatic TA calculations
 * Calculates precise indicator values from OHLCV data
 */

import { RSI, MACD, EMA, BollingerBands, ATR, SMA, Stochastic } from 'technicalindicators';
import { clamp100 } from '../../utils/math';
import { Kline } from './MarketDataService';

export interface TechnicalIndicators {
    // RSI - Multiple periods
    rsi: {
        rsi6: number;
        rsi12: number;
        rsi14: number;
        rsi24: number;
    };
    rsiTrend: 'overbought' | 'oversold' | 'neutral';

    // MACD
    macd: {
        dif: number;    // MACD line (DIF)
        dea: number;    // Signal line (DEA)
        histogram: number;
        trend: 'bullish' | 'bearish' | 'neutral';
    };

    // EMAs - All requested periods
    ema: {
        ema5: number;
        ema9: number;
        ema13: number;
        ema20: number;
        ema21: number;
        ema50: number;
        ema200: number;
    };

    // SMAs - All requested periods (MA)
    sma: {
        ma5: number;
        ma10: number;
        ma20: number;
        ma30: number;
        ma50: number;
        ma60: number;
        ma200: number;
    };

    // Bollinger Bands
    bollingerBands: {
        upper: number;
        middle: number;
        lower: number;
        bandwidth: number;
        percentB: number;
    };

    // Stochastic
    stochastic: {
        k: number;
        d: number;
        j: number;
    };

    // Volume
    volume: {
        current: number;
        average: number;
        trend: 'high' | 'low' | 'normal';
    };

    // ATR
    atr: number;
    atrPercent: number;

    currentPrice: number;
    pricePosition: string;
    trendStrength: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
}

/**
 * Advanced Volume Analysis - OBV, CVD, Volume Profile
 */
export interface AdvancedVolumeAnalysis {
    // Basic volume (same as TechnicalIndicators.volume)
    current: number;
    average: number;
    trend: 'high' | 'low' | 'normal';
    relativeVolume: number;  // Current vs avg as multiplier (e.g., 1.5 = 150% of avg)

    // On-Balance Volume (OBV)
    obv: number;
    obvTrend: 'rising' | 'falling' | 'flat';
    obvDivergence: 'bullish' | 'bearish' | 'none';  // Price vs OBV divergence

    // Cumulative Volume Delta (approximated from candle structure)
    cvd: number;
    cvdTrend: 'buyers_control' | 'sellers_control' | 'balanced';

    // Volume Profile (simplified)
    volumeProfile: {
        poc: number;         // Point of Control (highest volume price)
        valueAreaHigh: number;
        valueAreaLow: number;
        priceVsPOC: 'above' | 'at' | 'below';
        // "What a human sees" additions: is the distribution one tight
        // cluster or two opposing clusters? Where is price vs the value
        // area? How much of the range does the 70% area span?
        shape: 'single_cluster' | 'bimodal' | 'flat';
        valueAreaSpan: number;              // 0-1: fraction of range spanned by the 70% value area
        valueAreaPosition: 'above' | 'inside' | 'below';
    };

    // Volume-weighted analysis
    volumeWeightedBias: 'bullish' | 'bearish' | 'neutral';
}

/**
 * Market Regime Detection using ADX
 */
export type MarketRegime =
    | 'strong_trend_up'
    | 'strong_trend_down'
    | 'weak_trend_up'
    | 'weak_trend_down'
    | 'ranging'
    | 'volatile_chop'
    | 'compression';

export interface RegimeAnalysis {
    regime: MarketRegime;
    adx: number;               // 0-100, >25 = trending
    plusDI: number;            // +DI (bullish pressure)
    minusDI: number;           // -DI (bearish pressure)
    trendDirection: 'bullish' | 'bearish' | 'neutral';
    trendStrength: 'strong' | 'moderate' | 'weak' | 'none';
    tradingBias: 'trend_following' | 'mean_reversion' | 'avoid';
    recommendation: string;
}

/**
 * Enhanced Key Levels with multiple detection methods
 */
export interface EnhancedKeyLevel {
    price: number;
    type: 'support' | 'resistance';
    strength: number;          // 0-100
    source: 'pivot' | 'fibonacci' | 'volume_node' | 'psychological' | 'swing';
    timeframe: string;
    touchCount: number;
}

export interface PivotPoints {
    pp: number;
    r1: number;
    r2: number;
    r3: number;
    s1: number;
    s2: number;
    s3: number;
    /** 'daily' = aggregated from a completed UTC session of the passed bars;
     *  'tf-relative' = no day boundary existed in the data, so the levels are
     *  derived from the timeframe window itself (do NOT read them as daily). */
    scope: 'daily' | 'tf-relative';
}

export interface FibonacciLevels {
    trend: 'up' | 'down';
    swingHigh: number;
    swingLow: number;
    levels: { ratio: string; price: number; kind: 'retracement' | 'extension' }[];  // 0.236…0.786 retracements + 1.272/1.618/2.0 extensions
}

export interface KeyLevelsEnhanced {
    support: EnhancedKeyLevel[];
    resistance: EnhancedKeyLevel[];
    pivotPoints: {
        daily: PivotPoints;
    };
    fibLevels: FibonacciLevels;
    psychologicalLevels: number[];
}

/**
 * VWAP Analysis
 */
export interface VWAPData {
    vwap: number;
    upperBand1: number;    // +1 std dev
    upperBand2: number;    // +2 std dev
    lowerBand1: number;    // -1 std dev
    lowerBand2: number;    // -2 std dev
    pricePosition: 'above_upper2' | 'above_upper1' | 'above_vwap' | 'at_vwap' | 'below_vwap' | 'below_lower1' | 'below_lower2';
    bias: 'bullish' | 'bearish' | 'neutral';
    /** 'session' = window restarted at the most recent UTC day boundary
     *  (true session VWAP); 'window' = no boundary present in the passed
     *  bars, so this is a window VWAP spanning everything given. */
    anchor: 'session' | 'window';
}

/**
 * Ichimoku Cloud Data
 */
export interface IchimokuData {
    tenkanSen: number;      // Conversion Line (9)
    kijunSen: number;       // Base Line (26)
    senkouSpanA: number;    // Leading Span A
    senkouSpanB: number;    // Leading Span B
    chikouSpan: number;     // Lagging Span
    cloudTop: number;
    cloudBottom: number;
    cloudColor: 'bullish' | 'bearish';
    priceVsCloud: 'above' | 'inside' | 'below';
    tkCross: 'bullish' | 'bearish' | 'none';
    signal: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
}

/**
 * Momentum Indicators (Rate of Change)
 */
export interface MomentumIndicators {
    roc5: number;           // Rate of Change (5 period) in %
    roc10: number;          // Rate of Change (10 period) in %
    roc20: number;          // Rate of Change (20 period) in %
    momentum: 'accelerating_up' | 'decelerating_up' | 'accelerating_down' | 'decelerating_down' | 'neutral';
    momentumScore: number;  // -100 to +100
    rsiDivergence?: 'bullish' | 'bearish' | 'none';
    macdDivergence?: 'bullish' | 'bearish' | 'none';
}

/**
 * Safe calculation wrapper - returns default if not enough data
 */
/**
 * Safely run a calculation, returning a fallback if it throws or yields
 * undefined/null.
 */
function safeCalc<T>(calc: () => T, defaultValue: T): T {
    try {
        const result = calc();
        return result !== undefined && result !== null ? result : defaultValue;
    } catch {
        return defaultValue;
    }
}

// ============================================================================
// Timestamp helpers (session/day anchoring)
// ============================================================================

const MS_PER_DAY = 86_400_000;

/** Normalize a kline timestamp to milliseconds. Binance sends ms; some
 *  synthetic/legacy feeds send seconds. Returns NaN for unusable values. */
const toMs = (t: number): number =>
    !Number.isFinite(t) || t <= 0 ? NaN : t < 1e12 ? t * 1000 : t;

/** UTC day index for a kline timestamp (NaN when the timestamp is unusable). */
const utcDayIndex = (k: Kline): number => {
    const ms = toMs(k.time);
    return Number.isNaN(ms) ? NaN : Math.floor(ms / MS_PER_DAY);
};

/** True when every bar carries a usable timestamp. */
const hasUsableTimes = (klines: Kline[]): boolean =>
    klines.length > 0 && klines.every(k => !Number.isNaN(utcDayIndex(k)));

/**
 * Magnitude-aware rounding for PRICE-scale values.
 *
 * A fixed 2dp is wrong at both ends of this market. On a sub-$10 perp
 * `round(0.012)` returns 0.01 — a ~17% error — and on the live picker alone
 * that is hundreds of symbols. It propagated into EMAs, Bollinger bands,
 * support/resistance and every stop suggestion: three genuinely distinct swing
 * lows on a 0.012 coin all collapsed to 0.01, so the ladder rendered three
 * identical "support" levels as if they were independent evidence.
 *
 * 4 significant digits, but never FEWER decimals than the historical 2, so
 * large prices stay byte-identical to before and only the low end changes.
 *
 * This used to live inside `calculateIndicators` and was applied to exactly two
 * fields (ATR and currentPrice) while every OTHER price field in the file
 * used a bare 2dp round. That is why the precision looked fixed and was not.
 */
const roundPrice = (v: number, sigDigits = 4): number => {
    if (!Number.isFinite(v) || v === 0) return 0;
    const magnitude = Math.floor(Math.log10(Math.abs(v)));
    const decimals = Math.min(12, Math.max(2, sigDigits - 1 - magnitude));
    return Number(v.toFixed(decimals));
};

/**
 * Calculate all technical indicators from OHLCV data
 */
/**
 * Memo for calculateIndicators.
 *
 * Every indicator below is a PURE function of the passed klines, and the whole
 * block reads one value out of a full-length series (e.g. `EMA.calculate(...)
 * .pop()` computes all N bars to return the last one). On a 1,000-bar window
 * that is 20+ full series computed per call — on the render path, and again on
 * every desk-tool round. The result is identical for identical input, so cache
 * it whole rather than instrumenting each indicator: one key, one store, and
 * the whole cost disappears for the repeated calls, which is the common case
 * (the chart re-reads the same closed bars while the user talks).
 *
 * The key fingerprints the WHOLE series, not just the last bar, so an in-place
 * history correction (a vendor revising an earlier candle) misses the cache
 * instead of serving a stale reading. Bounded LRU: an app left open all day
 * across many symbols must not grow this without limit.
 */
const INDICATOR_CACHE_MAX = 24;
const indicatorCache = new Map<string, TechnicalIndicators>();

/** Cheap order-sensitive fingerprint of the window that decides the output. */
const indicatorFingerprint = (klines: Kline[]): string => {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (const k of klines) {
        // mix the fields that move every indicator; FNV-style, no allocation.
        h1 = Math.imul(h1 ^ (k.close * 1000 | 0), 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (k.high * 1000 | 0) ^ Math.imul(k.low * 1000 | 0, 31) ^ (k.volume * 10 | 0), 0x85ebca6b) >>> 0;
    }
    return `${klines.length}:${klines[0]?.time ?? 0}:${klines[klines.length - 1]?.time ?? 0}:${h1.toString(36)}:${h2.toString(36)}`;
};

export const clearIndicatorCache = (): void => {
    indicatorCache.clear();
};

export const calculateIndicators = (klines: Kline[]): TechnicalIndicators => {
    const key = indicatorFingerprint(klines);
    const hit = indicatorCache.get(key);
    if (hit) {
        // Refresh recency: delete+set moves this key to the end, so the LRU
        // order below reflects actual use.
        indicatorCache.delete(key);
        indicatorCache.set(key, hit);
        return hit;
    }

    const computed = computeIndicators(klines);
    if (indicatorCache.size >= INDICATOR_CACHE_MAX) {
        // Map preserves insertion order; the first key is the least recently used.
        const oldest = indicatorCache.keys().next();
        if (!oldest.done) indicatorCache.delete(oldest.value);
    }
    indicatorCache.set(key, computed);
    return computed;
};

/** The actual maths. Separated so the memo above is the only entry point. */
const computeIndicators = (klines: Kline[]): TechnicalIndicators => {
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);
    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    // RSI - Multiple periods
    const rsi6Values = RSI.calculate({ values: closes, period: 6 });
    const rsi12Values = RSI.calculate({ values: closes, period: 12 });
    const rsi14Values = RSI.calculate({ values: closes, period: 14 });
    const rsi24Values = RSI.calculate({ values: closes, period: 24 });

    const rsi6 = safeCalc(() => rsi6Values[rsi6Values.length - 1], 50);
    const rsi12 = safeCalc(() => rsi12Values[rsi12Values.length - 1], 50);
    const rsi14 = safeCalc(() => rsi14Values[rsi14Values.length - 1], 50);
    const rsi24 = safeCalc(() => rsi24Values[rsi24Values.length - 1], 50);
    const rsiTrend = rsi14 > 70 ? 'overbought' : rsi14 < 30 ? 'oversold' : 'neutral';

    // MACD (12, 26, 9)
    const macdValues = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });
    const lastMacd = macdValues[macdValues.length - 1] || { MACD: 0, signal: 0, histogram: 0 };
    const prevMacd = macdValues[macdValues.length - 2] || { histogram: 0 };
    const macdTrend = (lastMacd.histogram || 0) > 0
        ? ((lastMacd.histogram || 0) > (prevMacd.histogram || 0) ? 'bullish' : 'neutral')
        : ((lastMacd.histogram || 0) < (prevMacd.histogram || 0) ? 'bearish' : 'neutral');

    // EMAs - All periods
    const ema5: number = safeCalc(() => EMA.calculate({ values: closes, period: 5 }).pop() ?? currentPrice, currentPrice);
    const ema9: number = safeCalc(() => EMA.calculate({ values: closes, period: 9 }).pop() ?? currentPrice, currentPrice);
    const ema13: number = safeCalc(() => EMA.calculate({ values: closes, period: 13 }).pop() ?? currentPrice, currentPrice);
    const ema20: number = safeCalc(() => EMA.calculate({ values: closes, period: 20 }).pop() ?? currentPrice, currentPrice);
    const ema21: number = safeCalc(() => EMA.calculate({ values: closes, period: 21 }).pop() ?? currentPrice, currentPrice);
    const ema50: number = safeCalc(() => EMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice, currentPrice);
    const ema200: number = safeCalc(() => EMA.calculate({ values: closes, period: 200 }).pop() ?? currentPrice, currentPrice);

    // SMAs (MA) - All periods
    const ma5: number = safeCalc(() => SMA.calculate({ values: closes, period: 5 }).pop() ?? currentPrice, currentPrice);
    const ma10: number = safeCalc(() => SMA.calculate({ values: closes, period: 10 }).pop() ?? currentPrice, currentPrice);
    const ma20: number = safeCalc(() => SMA.calculate({ values: closes, period: 20 }).pop() ?? currentPrice, currentPrice);
    const ma30: number = safeCalc(() => SMA.calculate({ values: closes, period: 30 }).pop() ?? currentPrice, currentPrice);
    const ma50: number = safeCalc(() => SMA.calculate({ values: closes, period: 50 }).pop() ?? currentPrice, currentPrice);
    const ma60: number = safeCalc(() => SMA.calculate({ values: closes, period: 60 }).pop() ?? currentPrice, currentPrice);
    const ma200: number = safeCalc(() => SMA.calculate({ values: closes, period: 200 }).pop() ?? currentPrice, currentPrice);

    // Bollinger Bands (20, 2)
    const bbValues = BollingerBands.calculate({
        values: closes,
        period: 20,
        stdDev: 2
    });
    const lastBB = bbValues[bbValues.length - 1] || { upper: currentPrice, middle: currentPrice, lower: currentPrice };
    const bandwidth = lastBB.middle > 0 ? ((lastBB.upper - lastBB.lower) / lastBB.middle) * 100 : 0;
    const percentB = lastBB.upper !== lastBB.lower
        ? ((currentPrice - lastBB.lower) / (lastBB.upper - lastBB.lower)) * 100
        : 50;

    // Stochastic (14, 3, 3)
    const stochValues = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3
    });
    const lastStoch = stochValues[stochValues.length - 1] || { k: 50, d: 50 };
    // `??` not `||`: K = 0 is a REAL reading (maximum oversold), not an absent
    // value. `|| 50` silently relabelled genuine zeros as "neutral".
    const stochK = lastStoch.k ?? 50;
    const stochD = lastStoch.d ?? 50;
    const stochJ = 3 * stochK - 2 * stochD; // J = 3K - 2D

    // Volume analysis — guarded: empty/degraded klines (per-source degradation
    // returns []) must not produce NaN (0/0) that flows into the prompt.
    const avgVolume = volumes.length === 0 ? 0 : volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
    const volumeTrend = currentVolume > avgVolume * 1.5 ? 'high'
        : currentVolume < avgVolume * 0.5 ? 'low'
            : 'normal';

    // ATR (14 period)
    const atrValues = ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14
    });
    const atr = safeCalc(() => atrValues[atrValues.length - 1], 0);
    const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

    // Price Position
    const positions: string[] = [];
    if (currentPrice > ema21) positions.push('Above EMA21');
    else positions.push('Below EMA21');
    if (currentPrice > ema50) positions.push('Above EMA50');
    else positions.push('Below EMA50');
    if (currentPrice > ema200) positions.push('Above EMA200');
    else positions.push('Below EMA200');

    // Trend Strength
    let trendStrength: TechnicalIndicators['trendStrength'] = 'neutral';
    const bullishSignals = [
        currentPrice > ema21,
        currentPrice > ema50,
        currentPrice > ema200,
        ema9 > ema21,
        (lastMacd.histogram || 0) > 0,
        rsi14 > 50
    ].filter(Boolean).length;

    if (bullishSignals >= 5) trendStrength = 'strong_bullish';
    else if (bullishSignals >= 4) trendStrength = 'bullish';
    else if (bullishSignals <= 1) trendStrength = 'strong_bearish';
    else if (bullishSignals <= 2) trendStrength = 'bearish';

    const round = (v: number, decimals = 2) => Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals);
    const roundPriceScale = roundPrice;

    return {
        rsi: {
            rsi6: round(rsi6, 1),
            rsi12: round(rsi12, 1),
            rsi14: round(rsi14, 1),
            rsi24: round(rsi24, 1)
        },
        rsiTrend,
        macd: {
            dif: round(lastMacd.MACD || 0, 2),
            dea: round(lastMacd.signal || 0, 2),
            histogram: round(lastMacd.histogram || 0, 2),
            trend: macdTrend
        },
        ema: {
            ema5: roundPrice(ema5),
            ema9: roundPrice(ema9),
            ema13: roundPrice(ema13),
            ema20: roundPrice(ema20),
            ema21: roundPrice(ema21),
            ema50: roundPrice(ema50),
            ema200: roundPrice(ema200)
        },
        sma: {
            ma5: roundPrice(ma5),
            ma10: roundPrice(ma10),
            ma20: roundPrice(ma20),
            ma30: roundPrice(ma30),
            ma50: roundPrice(ma50),
            ma60: roundPrice(ma60),
            ma200: roundPrice(ma200)
        },
        bollingerBands: {
            upper: roundPrice(lastBB.upper),
            middle: roundPrice(lastBB.middle),
            lower: roundPrice(lastBB.lower),
            bandwidth: round(bandwidth),
            percentB: round(percentB)
        },
        stochastic: {
            k: round(stochK, 1),
            d: round(stochD, 1),
            j: round(stochJ, 1)
        },
        volume: {
            current: round(currentVolume, 4),
            average: round(avgVolume, 4),
            trend: volumeTrend
        },
        atr: roundPriceScale(atr),
        atrPercent: round(atrPercent),
        currentPrice: roundPriceScale(currentPrice),
        pricePosition: positions.join(', '),
        trendStrength
    };
};

/**
 * Generate human-readable TA summary for AI context
 */
export const generateTASummary = (
    indicators: TechnicalIndicators,
    timeframe: string
): string => {
    const trend = indicators.trendStrength.replace(/_/g, ' ');
    return [
        `**${timeframe}** — price $${indicators.currentPrice} · ${indicators.pricePosition} · ${trend}`,
        '| RSI6 | RSI12 | RSI14 | RSI24 | RSI | MACD DIF | DEA | Hist | MACD | Stoch K/D/J | ATR | ATR% | Vol |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${indicators.rsi.rsi6} | ${indicators.rsi.rsi12} | ${indicators.rsi.rsi14} | ${indicators.rsi.rsi24} | ${indicators.rsiTrend} | ${indicators.macd.dif} | ${indicators.macd.dea} | ${indicators.macd.histogram} | ${indicators.macd.trend} | ${indicators.stochastic.k}/${indicators.stochastic.d}/${indicators.stochastic.j} | ${indicators.atr} | ${indicators.atrPercent}% | ${indicators.volume.trend} |`,
        '| EMA5 | EMA9 | EMA20 | EMA50 | EMA200 | SMA20 | SMA50 | SMA200 | BB U/M/L | BW | %B |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${indicators.ema.ema5} | ${indicators.ema.ema9} | ${indicators.ema.ema20} | ${indicators.ema.ema50} | ${indicators.ema.ema200} | ${indicators.sma.ma20} | ${indicators.sma.ma50} | ${indicators.sma.ma200} | ${indicators.bollingerBands.upper}/${indicators.bollingerBands.middle}/${indicators.bollingerBands.lower} | ${indicators.bollingerBands.bandwidth}% | ${indicators.bollingerBands.percentB}% |`,
    ].join('\n');
};

/**
 * Calculate support and resistance levels from price data
 */
export const calculateKeyLevels = (klines: Kline[]): { support: number[]; resistance: number[] } => {
    // Guard an empty series. A single failed timeframe fetch yields [], and
    // indexing it threw — which propagated out of fetchHybridData, where BOTH
    // callers swallow and return null. One flaky 4h request out of four
    // therefore discarded 15m + 1h + 1d indicators, regime, derivatives, order
    // book and the entire prompt injection, and the model analysed a chart
    // with no structure and no indication anything was missing. Empty levels
    // is exactly the degradation dataQuality.unavailableSources records.
    if (!Array.isArray(klines) || klines.length === 0) return { support: [], resistance: [] };
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const currentPrice = klines[klines.length - 1].close;

    // Find local highs and lows
    const localHighs: number[] = [];
    const localLows: number[] = [];

    for (let i = 2; i < klines.length - 2; i++) {
        // Local high: higher than 2 candles before and after
        if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
            highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
            localHighs.push(highs[i]);
        }
        // Local low: lower than 2 candles before and after
        if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
            lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
            localLows.push(lows[i]);
        }
    }

    // Filter to significant levels (touched multiple times or recent)
    const resistance = localHighs
        .filter(h => h > currentPrice)
        .sort((a, b) => a - b)
        .slice(0, 3)
        .map(v => roundPrice(v));

    const support = localLows
        .filter(l => l < currentPrice)
        .sort((a, b) => b - a)
        .slice(0, 3)
        .map(v => roundPrice(v));

    return { support, resistance };
};

/**
 * Multi-Timeframe Confluence Score
 * Calculates how aligned indicators are across multiple timeframes
 * Score 0-100: Higher = stronger agreement in direction
 */
export interface ConfluenceResult {
    score: number;  // 0-100
    direction: 'bullish' | 'bearish' | 'neutral';
    strength: 'strong' | 'moderate' | 'weak';
    alignment: string[];  // List of aligned signals
    conflicts: string[];  // List of conflicting signals
}

export const calculateConfluenceScore = (
    indicators: { [timeframe: string]: TechnicalIndicators }
): ConfluenceResult => {
    const timeframes = Object.keys(indicators);
    const alignment: string[] = [];
    const conflicts: string[] = [];

    let bullishPoints = 0;
    let bearishPoints = 0;
    const maxPoints = timeframes.length * 6; // 6 signal types per timeframe
    // Which TIMEFRAMES actually contributed each way. The score is a
    // multi-timeframe confluence measure, so breadth across timeframes has to
    // be part of it — not just the ratio of bullish to bearish points.
    const tfBullious = new Set<string>();
    const tfBearish = new Set<string>();

    for (const tf of timeframes) {
        const ind = indicators[tf];
        if (!ind) continue;
        const bullBefore = bullishPoints;
        const bearBefore = bearishPoints;

        // RSI Signal (weight: 1)
        if (ind.rsi.rsi14 > 50 && ind.rsi.rsi14 < 70) {
            bullishPoints++;
            alignment.push(`${tf} RSI bullish (${ind.rsi.rsi14.toFixed(1)})`);
        } else if (ind.rsi.rsi14 < 50 && ind.rsi.rsi14 > 30) {
            bearishPoints++;
            alignment.push(`${tf} RSI bearish (${ind.rsi.rsi14.toFixed(1)})`);
        } else if (ind.rsi.rsi14 >= 70) {
            conflicts.push(`${tf} RSI overbought (${ind.rsi.rsi14.toFixed(1)})`);
        } else if (ind.rsi.rsi14 <= 30) {
            conflicts.push(`${tf} RSI oversold (${ind.rsi.rsi14.toFixed(1)})`);
        }

        // MACD Signal (weight: 1)
        if (ind.macd.histogram > 0 && ind.macd.trend === 'bullish') {
            bullishPoints++;
            alignment.push(`${tf} MACD bullish`);
        } else if (ind.macd.histogram < 0 && ind.macd.trend === 'bearish') {
            bearishPoints++;
            alignment.push(`${tf} MACD bearish`);
        }

        // EMA Alignment - Price above key EMAs (weight: 2)
        const price = ind.currentPrice;
        const emaBullish = price > ind.ema.ema20 && price > ind.ema.ema50;
        const emaBearish = price < ind.ema.ema20 && price < ind.ema.ema50;

        if (emaBullish) {
            bullishPoints += 2;
            alignment.push(`${tf} Price above EMA20/50`);
        } else if (emaBearish) {
            bearishPoints += 2;
            alignment.push(`${tf} Price below EMA20/50`);
        } else {
            conflicts.push(`${tf} Mixed EMA signals`);
        }

        // Stochastic Signal (weight: 1)
        if (ind.stochastic.k > ind.stochastic.d && ind.stochastic.k < 80) {
            bullishPoints++;
            alignment.push(`${tf} Stoch bullish cross`);
        } else if (ind.stochastic.k < ind.stochastic.d && ind.stochastic.k > 20) {
            bearishPoints++;
            alignment.push(`${tf} Stoch bearish cross`);
        }

        // Bollinger Band Position (weight: 1). %B is computed on a 0-100
        // scale (calculateIndicators) but the thresholds here are 0-1 — the
        // old comparison read "0.5" as 0.5%, so the bullish "upper half"
        // branch never fired and the bearish branch only fired at the very
        // BOTTOM of the range, inverting the confluence contribution.
        const percentB = ind.bollingerBands.percentB / 100;
        if (percentB > 0.5 && percentB < 0.9) {
            bullishPoints++;
            alignment.push(`${tf} BB upper half`);
        } else if (percentB < 0.5 && percentB > 0.1) {
            bearishPoints++;
            alignment.push(`${tf} BB lower half`);
        }

        if (bullishPoints > bullBefore) tfBullious.add(tf);
        if (bearishPoints > bearBefore) tfBearish.add(tf);
    }

    // Calculate direction and score
    const totalPoints = bullishPoints + bearishPoints;
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let score = 50; // Neutral baseline
    let agreeingTimeframes = 0;

    if (totalPoints > 0) {
        const bullishRatio = bullishPoints / totalPoints;
        if (bullishRatio > 0.6) {
            direction = 'bullish';
        } else if (bullishRatio < 0.4) {
            direction = 'bearish';
        } else {
            direction = 'neutral';
        }

        if (direction !== 'neutral') {
            // Purity alone made this a 1-signal-1-timeframe reading score 100
            // and earn the label `strong`, which ProbabilityEngine then turns
            // into a 1.15x probability multiplier. `maxPoints` was computed and
            // never used. A high score now needs agreement AND breadth: purity
            // scaled by how many timeframes actually voted the same way.
            const purity = Math.abs(bullishRatio - 0.5) * 2; // 0..1
            agreeingTimeframes = direction === 'bullish' ? tfBullious.size : tfBearish.size;
            const breadth = timeframes.length > 0 ? agreeingTimeframes / timeframes.length : 0;
            // How much of the available signal slots actually spoke. Half of
            // maxPoints is treated as fully-evidenced, because a clean trend
            // rarely fires all six indicators on every timeframe.
            const coverage = maxPoints > 0 ? Math.min(1, (totalPoints / maxPoints) * 2) : 0;
            // Floor of 0.3 keeps a genuine single-timeframe signal visible as
            // `moderate` without letting it reach the 75+ `strong` band.
            const composite = purity * (0.3 + 0.7 * breadth) * (0.5 + 0.5 * coverage);
            const magnitude = Math.round(composite * 50);
            score = direction === 'bullish' ? 50 + magnitude : 50 - magnitude;
        }
    }

    // Clamp score
    score = clamp100(score);

    // Determine strength
    // `strong` is a claim about MULTI-timeframe confluence, so it requires two
    // independent timeframes to agree regardless of score: a lone timeframe
    // cannot be strong evidence however cleanly its own indicators line up.
    const strength: 'strong' | 'moderate' | 'weak' =
        (agreeingTimeframes >= 2 && (score >= 75 || score <= 25)) ? 'strong' :
            score >= 60 || score <= 40 ? 'moderate' : 'weak';

    return {
        score,
        direction,
        strength,
        alignment: alignment.slice(0, 8), // Top 8 aligned signals
        conflicts: conflicts.slice(0, 4)   // Top 4 conflicts
    };
};

// ============================================================================
// PHASE 2: ADVANCED VOLUME ANALYSIS
// ============================================================================

/**
 * Calculate On-Balance Volume (OBV)
 */
const calculateOBVValues = (klines: Kline[]): number[] => {
    const obvValues: number[] = [];
    let obv = 0;

    for (let i = 0; i < klines.length; i++) {
        if (i === 0) {
            obv = klines[i].volume;
        } else {
            if (klines[i].close > klines[i - 1].close) {
                obv += klines[i].volume;
            } else if (klines[i].close < klines[i - 1].close) {
                obv -= klines[i].volume;
            }
            // If close == previous close, OBV stays the same
        }
        obvValues.push(obv);
    }

    return obvValues;
};

/**
 * Detect OBV divergence vs price
 */
const detectOBVDivergence = (klines: Kline[], obvValues: number[]): 'bullish' | 'bearish' | 'none' => {
    if (klines.length < 20 || obvValues.length < 20) return 'none';

    const recentKlines = klines.slice(-20);
    const recentOBV = obvValues.slice(-20);

    // Find price trend (comparing first half avg to second half avg)
    const firstHalfPriceAvg = recentKlines.slice(0, 10).reduce((a, b) => a + b.close, 0) / 10;
    const secondHalfPriceAvg = recentKlines.slice(-10).reduce((a, b) => a + b.close, 0) / 10;
    const priceTrend = secondHalfPriceAvg > firstHalfPriceAvg ? 'up' : 'down';

    // Find OBV trend
    const firstHalfOBVAvg = recentOBV.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const secondHalfOBVAvg = recentOBV.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const obvTrend = secondHalfOBVAvg > firstHalfOBVAvg ? 'up' : 'down';

    // Divergence detection
    if (priceTrend === 'down' && obvTrend === 'up') return 'bullish';
    if (priceTrend === 'up' && obvTrend === 'down') return 'bearish';

    return 'none';
};

/**
 * Calculate Cumulative Volume Delta (approximated from candle structure)
 * Uses candle body position to estimate buying/selling pressure
 */
const calculateCVD = (klines: Kline[]): number => {
    let cvd = 0;

    for (const kline of klines) {
        const range = kline.high - kline.low;
        if (range === 0) continue;

        // Estimate delta based on where the close is within the range
        const closePosition = (kline.close - kline.low) / range; // 0 to 1
        // If close is at top (1), all volume is buying; at bottom (0), all is selling
        const delta = kline.volume * (2 * closePosition - 1);
        cvd += delta;
    }

    return cvd;
};

/**
 * Calculate Volume Profile (simplified - POC, Value Area + distribution shape)
 */
const calculateVolumeProfile = (klines: Kline[]): {
    poc: number;
    valueAreaHigh: number;
    valueAreaLow: number;
    shape: 'single_cluster' | 'bimodal' | 'flat';
    valueAreaSpan: number;
} => {
    if (klines.length === 0) return { poc: 0, valueAreaHigh: 0, valueAreaLow: 0, shape: 'flat', valueAreaSpan: 0 };

    // Create price buckets
    const minPrice = Math.min(...klines.map(k => k.low));
    const maxPrice = Math.max(...klines.map(k => k.high));
    if (maxPrice === minPrice) {
        // Degenerate case: every candle at the same price -> POC is that price.
        return {
            poc: Math.round(minPrice * 100) / 100,
            valueAreaHigh: Math.round(minPrice * 100) / 100,
            valueAreaLow: Math.round(minPrice * 100) / 100,
            shape: 'single_cluster',
            valueAreaSpan: 0
        };
    }
    const bucketCount = 50;
    const bucketSize = (maxPrice - minPrice) / bucketCount;

    const volumeByBucket: Map<number, number> = new Map();

    for (const kline of klines) {
        // Distribute volume across the candle's range
        const lowBucket = Math.floor((kline.low - minPrice) / bucketSize);
        const rawHighBucket = Math.floor((kline.high - minPrice) / bucketSize);
        // Cap the top edge: a candle touching the max price can land exactly
        // on bucket 50 (floating point) — the divisor must count only the
        // buckets that actually receive volume, or that candle loses some.
        const highBucket = Math.min(rawHighBucket, bucketCount - 1);
        const span = Math.max(1, highBucket - lowBucket + 1);

        for (let b = lowBucket; b <= highBucket; b++) {
            volumeByBucket.set(b, (volumeByBucket.get(b) || 0) + kline.volume / span);
        }
    }

    // Find POC (highest volume bucket)
    let maxVolume = 0;
    let pocBucket = 0;
    volumeByBucket.forEach((volume, bucket) => {
        if (volume > maxVolume) {
            maxVolume = volume;
            pocBucket = bucket;
        }
    });

    const poc = minPrice + (pocBucket + 0.5) * bucketSize;

    // Calculate Value Area (70% of total volume)
    const totalVolume = Array.from(volumeByBucket.values()).reduce((a, b) => a + b, 0);
    const targetVolume = totalVolume * 0.7;

    // Expand from POC until we capture 70%
    let valueAreaVolume = volumeByBucket.get(pocBucket) || 0;
    let lowVABucket = pocBucket;
    let highVABucket = pocBucket;

    while (valueAreaVolume < targetVolume && (lowVABucket > 0 || highVABucket < bucketCount - 1)) {
        const lowVol = lowVABucket > 0 ? volumeByBucket.get(lowVABucket - 1) || 0 : 0;
        const highVol = highVABucket < bucketCount - 1 ? volumeByBucket.get(highVABucket + 1) || 0 : 0;

        if (lowVol >= highVol && lowVABucket > 0) {
            lowVABucket--;
            valueAreaVolume += lowVol;
        } else if (highVABucket < bucketCount - 1) {
            highVABucket++;
            valueAreaVolume += highVol;
        } else {
            break;
        }
    }

    // Distribution shape: a strong POC with no rival cluster = single_cluster
    // (HVN — one-sided liquidity); two significant clusters ≥20% of the range
    // apart = bimodal (two-sided battle); otherwise flat/balanced.
    // Average is over ALL buckets (empty ones included) so a two-cluster
    // profile with only two occupied buckets doesn't average to its own peak.
    const avgBucketVolume = totalVolume / bucketCount;
    const clusterMinDist = Math.round(bucketCount * 0.2);
    let secondPeak = 0;
    volumeByBucket.forEach((vol, bucket) => {
        if (Math.abs(bucket - pocBucket) >= clusterMinDist && vol > secondPeak) secondPeak = vol;
    });
    const pocRatio = maxVolume / (avgBucketVolume || 1);
    // 'flat' first: with no meaningful concentration (POC ≈ average bucket)
    // a uniform profile must not read as bimodal just because the max volume
    // appears twice. Then: two significant rival peaks = bimodal; otherwise a
    // strong single POC = single_cluster.
    const shape: 'single_cluster' | 'bimodal' | 'flat' =
        pocRatio < 1.8 ? 'flat' :
            secondPeak >= maxVolume * 0.6 ? 'bimodal' : 'single_cluster';

    return {
        poc: Math.round(poc * 100) / 100,
        valueAreaHigh: Math.round((minPrice + (highVABucket + 1) * bucketSize) * 100) / 100,
        valueAreaLow: Math.round((minPrice + lowVABucket * bucketSize) * 100) / 100,
        shape,
        valueAreaSpan: Math.max(1, highVABucket - lowVABucket + 1) / bucketCount
    };
};

/**
 * Calculate complete Advanced Volume Analysis
 */
export const calculateAdvancedVolume = (klines: Kline[]): AdvancedVolumeAnalysis => {
    const volumes = klines.map(k => k.volume);
    const currentVolume = volumes[volumes.length - 1] || 0;
    const avgVolume = volumes.length === 0 ? 0 : volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
    const currentPrice = klines[klines.length - 1]?.close || 0;

    // Basic volume trend
    const relativeVolume = avgVolume > 0 ? currentVolume / avgVolume : 1;
    const trend: 'high' | 'low' | 'normal' = relativeVolume > 1.5 ? 'high' : relativeVolume < 0.5 ? 'low' : 'normal';

    // OBV
    const obvValues = calculateOBVValues(klines);
    const obv = obvValues[obvValues.length - 1] || 0;
    const obvRecent = obvValues.slice(-10);
    // Sign-safe trend test. OBV is a running sum that routinely straddles
    // zero, so ratio thresholds like `last > first * 1.05` INVERT when the
    // baseline is negative (first = −1000, last = −1020 is a FALLING series
    // but −1020 > −1050 read "rising"). Compare the signed delta against a
    // deadband scaled by the magnitude of the endpoints instead.
    const obvFirst = obvRecent[0] ?? 0;
    const obvLast = obvRecent[obvRecent.length - 1] ?? 0;
    const obvDelta = obvLast - obvFirst;
    const obvDeadband = Math.max(Math.abs(obvFirst), Math.abs(obvLast)) * 0.05;
    const obvTrend: 'rising' | 'falling' | 'flat' =
        obvDeadband > 0 && obvDelta > obvDeadband ? 'rising' :
            obvDeadband > 0 && obvDelta < -obvDeadband ? 'falling' : 'flat';
    const obvDivergence = detectOBVDivergence(klines, obvValues);

    // CVD
    const cvd = calculateCVD(klines);
    const recentCVD = calculateCVD(klines.slice(-20));
    const cvdTrend: 'buyers_control' | 'sellers_control' | 'balanced' =
        recentCVD > 0 ? 'buyers_control' : recentCVD < 0 ? 'sellers_control' : 'balanced';

    // Volume Profile
    const vp = calculateVolumeProfile(klines);
    const priceVsPOC: 'above' | 'at' | 'below' =
        currentPrice > vp.poc * 1.005 ? 'above' :
            currentPrice < vp.poc * 0.995 ? 'below' : 'at';

    // Overall volume-weighted bias
    let biasScore = 0;
    if (obvTrend === 'rising') biasScore += 1;
    if (obvTrend === 'falling') biasScore -= 1;
    if (cvdTrend === 'buyers_control') biasScore += 1;
    if (cvdTrend === 'sellers_control') biasScore -= 1;
    if (priceVsPOC === 'above') biasScore += 0.5;
    if (priceVsPOC === 'below') biasScore -= 0.5;

    const volumeWeightedBias: 'bullish' | 'bearish' | 'neutral' =
        biasScore >= 1.5 ? 'bullish' : biasScore <= -1.5 ? 'bearish' : 'neutral';

    return {
        current: Math.round(currentVolume * 100) / 100,
        average: Math.round(avgVolume * 100) / 100,
        trend,
        relativeVolume: Math.round(relativeVolume * 100) / 100,
        obv: Math.round(obv),
        obvTrend,
        obvDivergence,
        cvd: Math.round(cvd),
        cvdTrend,
        volumeProfile: {
            poc: vp.poc,
            valueAreaHigh: vp.valueAreaHigh,
            valueAreaLow: vp.valueAreaLow,
            priceVsPOC,
            shape: vp.shape,
            valueAreaSpan: Math.round(vp.valueAreaSpan * 100) / 100,
            valueAreaPosition: currentPrice > vp.valueAreaHigh ? 'above' :
                currentPrice < vp.valueAreaLow ? 'below' : 'inside'
        },
        volumeWeightedBias
    };
};

// ============================================================================
// PHASE 3: MARKET REGIME DETECTION (ADX)
// ============================================================================

/**
 * Calculate True Range
 */
const calculateTR = (klines: Kline[]): number[] => {
    const tr: number[] = [];
    for (let i = 0; i < klines.length; i++) {
        if (i === 0) {
            tr.push(klines[i].high - klines[i].low);
        } else {
            const hl = klines[i].high - klines[i].low;
            const hpc = Math.abs(klines[i].high - klines[i - 1].close);
            const lpc = Math.abs(klines[i].low - klines[i - 1].close);
            tr.push(Math.max(hl, hpc, lpc));
        }
    }
    return tr;
};

/**
 * Calculate +DM and -DM
 */
const calculateDM = (klines: Kline[]): { plusDM: number[]; minusDM: number[] } => {
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 0; i < klines.length; i++) {
        if (i === 0) {
            plusDM.push(0);
            minusDM.push(0);
        } else {
            const upMove = klines[i].high - klines[i - 1].high;
            const downMove = klines[i - 1].low - klines[i].low;

            if (upMove > downMove && upMove > 0) {
                plusDM.push(upMove);
            } else {
                plusDM.push(0);
            }

            if (downMove > upMove && downMove > 0) {
                minusDM.push(downMove);
            } else {
                minusDM.push(0);
            }
        }
    }

    return { plusDM, minusDM };
};

/**
 * Smooth values using Wilder's smoothing.
 * Wilder: Smooth = Prev - Prev/period + Current/period. The incoming value
 * MUST be divided by period — without it each series converges to
 * period x its true level (for TR/DM the factor cancels in the DI ratio,
 * but ADX = smoothed DX would be amplified ~14x, e.g. 411 instead of ~29).
 */
const wilderSmooth = (values: number[], period: number): number[] => {
    const smoothed: number[] = [];
    let sum = 0;

    for (let i = 0; i < values.length; i++) {
        if (i < period) {
            sum += values[i];
            if (i === period - 1) {
                smoothed.push(sum / period);
            } else {
                smoothed.push(0);
            }
        } else {
            const prev = smoothed[i - 1];
            smoothed.push(prev - (prev / period) + values[i] / period);
        }
    }

    return smoothed;
};

/**
 * Calculate ADX, +DI, -DI
 */
export const calculateADX = (klines: Kline[], period: number = 14): { adx: number; plusDI: number; minusDI: number } => {
    if (klines.length < period * 2) {
        return { adx: 25, plusDI: 25, minusDI: 25 }; // Default neutral
    }

    const tr = calculateTR(klines);
    const { plusDM, minusDM } = calculateDM(klines);

    const smoothedTR = wilderSmooth(tr, period);
    const smoothedPlusDM = wilderSmooth(plusDM, period);
    const smoothedMinusDM = wilderSmooth(minusDM, period);

    // Calculate +DI and -DI
    const plusDI: number[] = [];
    const minusDI: number[] = [];
    const dx: number[] = [];

    for (let i = 0; i < smoothedTR.length; i++) {
        if (smoothedTR[i] === 0) {
            plusDI.push(0);
            minusDI.push(0);
            dx.push(0);
        } else {
            const pdi = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
            const mdi = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
            plusDI.push(pdi);
            minusDI.push(mdi);

            const diSum = pdi + mdi;
            if (diSum === 0) {
                dx.push(0);
            } else {
                dx.push((Math.abs(pdi - mdi) / diSum) * 100);
            }
        }
    }

    // Smooth DX to get ADX. dx[0..period-2] are the zero-padded DI warmup,
    // dx[period-1] is the first real DX — keep it in the seed average.
    const adxValues = wilderSmooth(dx.slice(period - 1), period);
    // `?? 25` (not `|| 25`): a legitimate 0 reading (e.g. symmetric range)
    // must not be replaced by the neutral default.
    const latestADX = adxValues[adxValues.length - 1] ?? 25;
    const latestPlusDI = plusDI[plusDI.length - 1] ?? 25;
    const latestMinusDI = minusDI[minusDI.length - 1] ?? 25;

    return {
        adx: Math.round(latestADX * 10) / 10,
        plusDI: Math.round(latestPlusDI * 10) / 10,
        minusDI: Math.round(latestMinusDI * 10) / 10
    };
};

/**
 * Calculate Market Regime Analysis
 */
export const calculateRegime = (klines: Kline[]): RegimeAnalysis => {
    const { adx, plusDI, minusDI } = calculateADX(klines);
    const atrValues = ATR.calculate({ high: klines.map(k => k.high), low: klines.map(k => k.low), close: klines.map(k => k.close), period: 14 });
    const currentATR = atrValues[atrValues.length - 1] || 0;
    const avgATR = atrValues.length > 0
        ? atrValues.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrValues.length)
        : 0;

    // Determine trend direction
    const trendDirection: 'bullish' | 'bearish' | 'neutral' =
        plusDI > minusDI + 5 ? 'bullish' :
            minusDI > plusDI + 5 ? 'bearish' : 'neutral';

    // Determine trend strength
    let trendStrength: 'strong' | 'moderate' | 'weak' | 'none';
    if (adx >= 40) trendStrength = 'strong';
    else if (adx >= 25) trendStrength = 'moderate';
    else if (adx >= 15) trendStrength = 'weak';
    else trendStrength = 'none';

    // Determine regime
    let regime: MarketRegime;
    const isVolatile = currentATR > avgATR * 1.5;
    const isCompressing = currentATR < avgATR * 0.5;

    if (isCompressing && adx < 20) {
        regime = 'compression';
    } else if (isVolatile && adx < 25) {
        regime = 'volatile_chop';
    } else if (adx >= 40) {
        // A neutral DI gap cannot claim a directional regime — fall back to
        // ranging instead of forcing a trend label on the wrong side.
        regime = trendDirection === 'bullish' ? 'strong_trend_up' :
            trendDirection === 'bearish' ? 'strong_trend_down' : 'ranging';
    } else if (adx >= 25) {
        regime = trendDirection === 'bullish' ? 'weak_trend_up' :
            trendDirection === 'bearish' ? 'weak_trend_down' : 'ranging';
    } else {
        regime = 'ranging';
    }

    // Trading bias recommendation
    let tradingBias: 'trend_following' | 'mean_reversion' | 'avoid';
    let recommendation: string;

    if (regime === 'strong_trend_up' || regime === 'strong_trend_down') {
        tradingBias = 'trend_following';
        recommendation = `Strong ${trendDirection} trend detected (ADX: ${adx}). Look for pullbacks to enter in trend direction.`;
    } else if (regime === 'ranging') {
        tradingBias = 'mean_reversion';
        recommendation = `Range-bound market (ADX: ${adx}). Consider fading extremes or trading range boundaries.`;
    } else if (regime === 'compression') {
        tradingBias = 'avoid';
        recommendation = `Low volatility compression (ADX: ${adx}). Wait for breakout confirmation.`;
    } else if (regime === 'volatile_chop') {
        tradingBias = 'avoid';
        recommendation = `Choppy volatile conditions (ADX: ${adx}). High risk of false signals. Reduce position size or stay flat.`;
    } else {
        tradingBias = 'trend_following';
        recommendation = `Weak trend developing (ADX: ${adx}). Confirm with other indicators before entry.`;
    }

    return {
        regime,
        adx,
        plusDI,
        minusDI,
        trendDirection,
        trendStrength,
        tradingBias,
        recommendation
    };
};

// ============================================================================
// PHASE 4: ENHANCED KEY LEVELS
// ============================================================================

/**
 * Calculate Pivot Points (Classic/Floor Trader)
 *
 * Classic floor-trader pivots are DAILY: they use the high/low/close of the
 * previous completed UTC session. The old code took ONE bar of whatever
 * timeframe was passed — on a 15m chart the "daily" pivots were derived from
 * the previous 15-minute bar's HLC, dressing noise up as high-confidence
 * levels in every prompt. Now we aggregate the intraday bars into the
 * previous completed day; when no day boundary exists in the data (single-day
 * window or missing timestamps) we aggregate all completed bars into one
 * pseudo-session and label the result honestly as `tf-relative`.
 */
export const calculatePivotPoints = (klines: Kline[]): PivotPoints => {
    const round = roundPrice;

    if (klines.length === 0) {
        return { pp: 0, r1: 0, r2: 0, r3: 0, s1: 0, s2: 0, s3: 0, scope: 'tf-relative' };
    }

    const aggregate = (bars: Kline[]): { high: number; low: number; close: number } => ({
        high: Math.max(...bars.map(b => b.high)),
        low: Math.min(...bars.map(b => b.low)),
        close: bars[bars.length - 1].close
    });

    let hlc: { high: number; low: number; close: number };
    let scope: PivotPoints['scope'];

    const lastDay = hasUsableTimes(klines) ? utcDayIndex(klines[klines.length - 1]) : NaN;
    const completedDays = Number.isNaN(lastDay)
        ? []
        : [...new Set(klines.map(utcDayIndex))]
            .filter(d => !Number.isNaN(d) && d < lastDay)
            .sort((a, b) => a - b);

    if (completedDays.length > 0) {
        // Most recent COMPLETED UTC day strictly before the forming bar's day
        // (tolerates gap days where the feed had no prints).
        const targetDay = completedDays[completedDays.length - 1];
        const dayBars = klines.filter(k => utcDayIndex(k) === targetDay);
        hlc = aggregate(dayBars);
        scope = 'daily';
    } else {
        // No day boundary present: fold every completed bar (all except the
        // forming last one) into one pseudo-session. This is still far more
        // stable than the old single-bar HLC, but it is TF-relative, not daily.
        const prevBars = klines.slice(0, -1);
        const src = prevBars.length > 0 ? prevBars : klines;
        hlc = aggregate(src);
        scope = 'tf-relative';
    }

    const { high, low, close } = hlc;
    const pp = (high + low + close) / 3;
    const r1 = 2 * pp - low;
    const s1 = 2 * pp - high;
    const r2 = pp + (high - low);
    const s2 = pp - (high - low);
    const r3 = high + 2 * (pp - low);
    const s3 = low - 2 * (high - pp);

    return {
        pp: round(pp),
        r1: round(r1),
        r2: round(r2),
        r3: round(r3),
        s1: round(s1),
        s2: round(s2),
        s3: round(s3),
        scope
    };
};

/**
 * Calculate Fibonacci Retracement Levels
 */
export const calculateFibonacciLevels = (klines: Kline[]): FibonacciLevels => {
    // Empty series ⇒ no swing to anchor a retracement on. See
    // calculateKeyLevels for why an absent timeframe must degrade rather
    // than throw and take the whole packet with it.
    if (!Array.isArray(klines) || klines.length === 0) {
        return { levels: [] } as unknown as FibonacciLevels;
    }
    // Find swing high and swing low from recent data
    const recentKlines = klines.slice(-50);
    const swingHigh = Math.max(...recentKlines.map(k => k.high));
    const swingLow = Math.min(...recentKlines.map(k => k.low));

    // Determine trend direction based on recent price action
    const firstPrice = recentKlines[0].close;
    const lastPrice = recentKlines[recentKlines.length - 1].close;
    const trend: 'up' | 'down' = lastPrice > firstPrice ? 'up' : 'down';

    const fibRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1];
    const extensionRatios = [1.272, 1.618, 2];
    const range = swingHigh - swingLow;

    // STANDARD convention, shared with the chart's fib drawings and
    // activeSwingFib: retracements measure the give-back from the extreme the
    // trend ran to; extensions project the leg PAST it with the SIGNED range
    // (a down-leg extends downward). A level at or below zero is omitted.
    const levels = [
        ...fibRatios.map((ratio): FibonacciLevels['levels'][number] => {
            const raw = trend === 'up'
                ? swingHigh - range * ratio  // Retracement from high
                : swingLow + range * ratio;  // Retracement from low
            return { ratio: ratio.toString(), price: Math.round(raw * 100) / 100, kind: 'retracement' };
        }),
        ...extensionRatios.map((ratio): FibonacciLevels['levels'][number] => {
            const raw = trend === 'up'
                ? swingHigh + range * (ratio - 1)
                : swingLow - range * (ratio - 1);
            return { ratio: ratio.toString(), price: Math.round(raw * 100) / 100, kind: 'extension' };
        }),
    ].filter(l => l.price > 0);

    return {
        trend,
        swingHigh: Math.round(swingHigh * 100) / 100,
        swingLow: Math.round(swingLow * 100) / 100,
        levels
    };
};

/**
 * Detect psychological levels (round numbers)
 */
export const detectPsychologicalLevels = (currentPrice: number): number[] => {
    const magnitude = Math.pow(10, Math.floor(Math.log10(currentPrice)) - 1);
    const levels: number[] = [];

    // Find nearby round numbers
    const baseLevel = Math.floor(currentPrice / magnitude) * magnitude;

    for (let i = -3; i <= 3; i++) {
        const level = baseLevel + i * magnitude;
        if (level > 0) {
            levels.push(level);
        }
    }

    return levels.sort((a, b) => a - b);
};

/**
 * Count how many candles in the recent window actually reached a price level
 * (candle range contains the level, ±tolerance). This is the "R1 has been
 * tested 3 times" heuristic — the payload previously shipped a hardcoded 0
 * for every level, which read as "untested" to the model.
 */
export const countLevelTouches = (klines: Kline[], level: number, tolerance = 0.0005, window = 60): number => {
    if (!isFinite(level) || level <= 0) return 0;
    const recent = klines.slice(-window);
    return recent.filter(k =>
        k.low <= level * (1 + tolerance) &&
        k.high >= level * (1 - tolerance)
    ).length;
};

/**
 * Calculate Enhanced Key Levels
 */
export const calculateEnhancedKeyLevels = (klines: Kline[], timeframe: string): KeyLevelsEnhanced => {
    // Degrade on an empty series rather than throw — see calculateKeyLevels.
    if (!Array.isArray(klines) || klines.length === 0) {
        return {
            support: [], resistance: [], pivotPoints: null, fibonacci: { levels: [] },
        } as unknown as KeyLevelsEnhanced;
    }
    const currentPrice = klines[klines.length - 1]?.close || 0;

    // Pivot Points
    const pivotPoints = calculatePivotPoints(klines);

    // Fibonacci Levels
    const fibLevels = calculateFibonacciLevels(klines);

    // Psychological Levels
    const psychologicalLevels = detectPsychologicalLevels(currentPrice);

    // Build enhanced support and resistance arrays
    const support: EnhancedKeyLevel[] = [];
    const resistance: EnhancedKeyLevel[] = [];

    // Add pivot supports
    [pivotPoints.s1, pivotPoints.s2, pivotPoints.s3].forEach((price, i) => {
        if (price < currentPrice) {
            support.push({
                price,
                type: 'support',
                strength: 70 - i * 15,
                source: 'pivot',
                timeframe,
                touchCount: 0
            });
        }
    });

    // Add pivot resistances
    [pivotPoints.r1, pivotPoints.r2, pivotPoints.r3].forEach((price, i) => {
        if (price > currentPrice) {
            resistance.push({
                price,
                type: 'resistance',
                strength: 70 - i * 15,
                source: 'pivot',
                timeframe,
                touchCount: 0
            });
        }
    });

    // Add Fibonacci levels
    fibLevels.levels.forEach(level => {
        const entry: EnhancedKeyLevel = {
            price: level.price,
            type: level.price < currentPrice ? 'support' : 'resistance',
            strength: level.ratio === '0.618' || level.ratio === '0.5' ? 80 : 60,
            source: 'fibonacci',
            timeframe,
            touchCount: 0
        };
        if (entry.type === 'support') support.push(entry);
        else resistance.push(entry);
    });

    // Add psychological levels
    psychologicalLevels.forEach(price => {
        const entry: EnhancedKeyLevel = {
            price,
            type: price < currentPrice ? 'support' : 'resistance',
            strength: 50,
            source: 'psychological',
            timeframe,
            touchCount: 0
        };
        if (entry.type === 'support' && price < currentPrice) support.push(entry);
        else if (entry.type === 'resistance' && price > currentPrice) resistance.push(entry);
    });

    // Real touch counts — how many of the last 60 candles actually tested
    // each level (±0.05%). Previously hardcoded 0 (a lie in the payload).
    for (const level of [...support, ...resistance]) {
        level.touchCount = countLevelTouches(klines, level.price);
    }

    // Sort by proximity to current price
    support.sort((a, b) => b.price - a.price);  // Closest first
    resistance.sort((a, b) => a.price - b.price);  // Closest first

    return {
        support: support.slice(0, 5),
        resistance: resistance.slice(0, 5),
        pivotPoints: { daily: pivotPoints },
        fibLevels,
        psychologicalLevels
    };
};

// ============================================================================
// PHASE 7: VWAP, ICHIMOKU, MOMENTUM (ROC)
// ============================================================================

/**
 * Calculate VWAP (Volume Weighted Average Price)
 */
export const calculateVWAP = (klines: Kline[]): VWAPData => {
    if (klines.length === 0) {
        return {
            vwap: 0,
            upperBand1: 0,
            upperBand2: 0,
            lowerBand1: 0,
            lowerBand2: 0,
            pricePosition: 'at_vwap',
            bias: 'neutral',
            anchor: 'window'
        };
    }

    // Session anchoring: a true VWAP restarts at each session open. When the
    // passed window contains a UTC day boundary, anchor on the day of the
    // most recent bar; otherwise this is honestly a window VWAP over all the
    // bars given.
    let windowBars = klines;
    let anchor: VWAPData['anchor'] = 'window';
    if (hasUsableTimes(klines)) {
        const lastDay = utcDayIndex(klines[klines.length - 1]);
        const sessionBars = klines.filter(k => utcDayIndex(k) === lastDay);
        if (sessionBars.length > 0 && sessionBars.length < klines.length) {
            windowBars = sessionBars;
            anchor = 'session';
        }
    }

    // Calculate VWAP
    let cumulativeTPV = 0;  // Typical Price * Volume
    let cumulativeVolume = 0;
    const sessionPoints: { tp: number; volume: number }[] = [];

    for (const kline of windowBars) {
        const typicalPrice = (kline.high + kline.low + kline.close) / 3;
        cumulativeTPV += typicalPrice * kline.volume;
        cumulativeVolume += kline.volume;
        sessionPoints.push({ tp: typicalPrice, volume: kline.volume });
    }

    const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;

    // Volume-weighted standard deviation over the anchored window — the bands
    // are labeled "+1/+2 std dev" around a volume-weighted mean, so the
    // deviation must be weighted the same way (an unweighted std over
    // typical prices mislabels itself when volume is lumpy).
    let sumWeightedSqDiff = 0;
    if (cumulativeVolume > 0) {
        for (const { tp, volume } of sessionPoints) {
            sumWeightedSqDiff += volume * Math.pow(tp - vwap, 2);
        }
    } else {
        // Zero-volume fallback: unweighted deviation of typical prices.
        for (const { tp } of sessionPoints) {
            sumWeightedSqDiff += Math.pow(tp - vwap, 2);
        }
    }
    const stdDivisor = cumulativeVolume > 0 ? cumulativeVolume : sessionPoints.length;
    const stdDev = stdDivisor > 0 ? Math.sqrt(sumWeightedSqDiff / stdDivisor) : 0;

    const upperBand1 = vwap + stdDev;
    const upperBand2 = vwap + 2 * stdDev;
    const lowerBand1 = vwap - stdDev;
    const lowerBand2 = vwap - 2 * stdDev;

    const currentPrice = klines[klines.length - 1].close;

    // Determine price position
    // Lower bands must be checked before the "below_vwap" window, otherwise
    // below_lower1/below_lower2 are unreachable for any price under vwap.
    let pricePosition: VWAPData['pricePosition'];
    if (currentPrice >= upperBand2) pricePosition = 'above_upper2';
    else if (currentPrice >= upperBand1) pricePosition = 'above_upper1';
    else if (currentPrice <= lowerBand2) pricePosition = 'below_lower2';
    else if (currentPrice <= lowerBand1) pricePosition = 'below_lower1';
    else if (currentPrice > vwap * 1.001) pricePosition = 'above_vwap';
    else if (currentPrice < vwap * 0.999) pricePosition = 'below_vwap';
    else pricePosition = 'at_vwap';

    // Determine bias
    const bias: 'bullish' | 'bearish' | 'neutral' =
        currentPrice > vwap * 1.01 ? 'bullish' :
            currentPrice < vwap * 0.99 ? 'bearish' : 'neutral';

    const round = roundPrice;

    return {
        vwap: round(vwap),
        upperBand1: round(upperBand1),
        upperBand2: round(upperBand2),
        lowerBand1: round(lowerBand1),
        lowerBand2: round(lowerBand2),
        pricePosition,
        bias,
        anchor
    };
};

/**
 * Calculate Ichimoku Cloud
 */
export const calculateIchimoku = (klines: Kline[]): IchimokuData => {
    const getHighLowAvg = (slice: Kline[]) => {
        const high = Math.max(...slice.map(k => k.high));
        const low = Math.min(...slice.map(k => k.low));
        return (high + low) / 2;
    };

    const len = klines.length;
    if (len < 52) {
        // Not enough data
        const price = klines[len - 1]?.close || 0;
        return {
            tenkanSen: price,
            kijunSen: price,
            senkouSpanA: price,
            senkouSpanB: price,
            chikouSpan: price,
            cloudTop: price,
            cloudBottom: price,
            cloudColor: 'neutral' as any,
            priceVsCloud: 'inside',
            tkCross: 'none',
            signal: 'neutral'
        };
    }

    // Tenkan-sen (Conversion Line): 9-period high-low average
    const tenkanSen = getHighLowAvg(klines.slice(-9));

    // Kijun-sen (Base Line): 26-period high-low average
    const kijunSen = getHighLowAvg(klines.slice(-26));

    // Senkou Span A: Average of Tenkan and Kijun, plotted 26 periods ahead
    const senkouSpanA = (tenkanSen + kijunSen) / 2;

    // Senkou Span B: 52-period high-low average, plotted 26 periods ahead
    const senkouSpanB = getHighLowAvg(klines.slice(-52));

    // Chikou Span: Current close plotted 26 periods back
    const chikouSpan = klines[len - 1].close;

    // ── Historical (current-position) cloud ──────────────────────────────
    // The spans above are DISPLACED 26 bars forward when plotted, so the
    // cloud that actually sits UNDER today's price was computed 26 bars ago.
    // The old code compared today's close against the FUTURE cloud — a
    // look-ahead, since that cloud is not observable yet — and every
    // consumer (signals, prompts, "price vs Cloud" validation) inherited the
    // bias. Evaluate against the spans formed at `len - 26`.
    const DISPLACEMENT = 26;
    const histEnd = len - DISPLACEMENT; // exclusive end of the historical window
    const tenkanThen = getHighLowAvg(klines.slice(Math.max(0, histEnd - 9), histEnd));
    const kijunThen = getHighLowAvg(klines.slice(Math.max(0, histEnd - 26), histEnd));
    const senkouSpanAThen = (tenkanThen + kijunThen) / 2;
    const senkouSpanBThen = getHighLowAvg(klines.slice(Math.max(0, histEnd - 52), histEnd));

    // Cloud boundaries AT the current price (historical spans, not the
    // forward-projected ones) — this is what charts overlay on today's bars
    // and what EntryTiming/AccuracyValidation read as support/resistance.
    const cloudTop = Math.max(senkouSpanAThen, senkouSpanBThen);
    const cloudBottom = Math.min(senkouSpanAThen, senkouSpanBThen);

    // Cloud color: twist of the cloud under price (same historical spans).
    const cloudColor: 'bullish' | 'bearish' = senkouSpanAThen > senkouSpanBThen ? 'bullish' : 'bearish';

    // Price vs Cloud
    const currentPrice = klines[len - 1].close;
    const priceVsCloud: 'above' | 'inside' | 'below' =
        currentPrice > cloudTop ? 'above' :
            currentPrice < cloudBottom ? 'below' : 'inside';

    // TK Cross detection (compare current and previous)
    const prevTenkan = len >= 10 ? getHighLowAvg(klines.slice(-10, -1)) : tenkanSen;
    const prevKijun = len >= 27 ? getHighLowAvg(klines.slice(-27, -1)) : kijunSen;

    let tkCross: 'bullish' | 'bearish' | 'none' = 'none';
    if (tenkanSen > kijunSen && prevTenkan <= prevKijun) tkCross = 'bullish';
    else if (tenkanSen < kijunSen && prevTenkan >= prevKijun) tkCross = 'bearish';

    // Overall signal
    let signal: IchimokuData['signal'] = 'neutral';
    let bullishPoints = 0;
    let bearishPoints = 0;

    if (priceVsCloud === 'above') bullishPoints += 2;
    if (priceVsCloud === 'below') bearishPoints += 2;
    if (cloudColor === 'bullish') bullishPoints += 1;
    if (cloudColor === 'bearish') bearishPoints += 1;
    if (tenkanSen > kijunSen) bullishPoints += 1;
    if (tenkanSen < kijunSen) bearishPoints += 1;
    if (tkCross === 'bullish') bullishPoints += 1;
    if (tkCross === 'bearish') bearishPoints += 1;

    if (bullishPoints >= 4) signal = 'strong_bullish';
    else if (bullishPoints >= 3) signal = 'bullish';
    else if (bearishPoints >= 4) signal = 'strong_bearish';
    else if (bearishPoints >= 3) signal = 'bearish';

    const round = roundPrice;

    return {
        tenkanSen: round(tenkanSen),
        kijunSen: round(kijunSen),
        senkouSpanA: round(senkouSpanA),
        senkouSpanB: round(senkouSpanB),
        chikouSpan: round(chikouSpan),
        cloudTop: round(cloudTop),
        cloudBottom: round(cloudBottom),
        cloudColor,
        priceVsCloud,
        tkCross,
        signal
    };
};

/**
 * Calculate Rate of Change (ROC) and Momentum
 */

/**
 * Generic divergence detection (Compare Price Trend vs Indicator Trend)
 */
const detectGenericDivergence = (klines: Kline[], indicatorValues: number[], period: number = 20): 'bullish' | 'bearish' | 'none' => {
    if (klines.length < period || indicatorValues.length < period) return 'none';

    const recentKlines = klines.slice(-period);
    const recentInd = indicatorValues.slice(-period);

    // Split into halves to detect trend
    const half = Math.floor(period / 2);

    // Price Peaks/Valleys (Simplified trend check)
    const priceFirstHalf = recentKlines.slice(0, half).map(k => k.close);
    const priceSecondHalf = recentKlines.slice(half).map(k => k.close);
    const priceTrend = Math.max(...priceSecondHalf) > Math.max(...priceFirstHalf) ? 'higher_high' :
        Math.min(...priceSecondHalf) < Math.min(...priceFirstHalf) ? 'lower_low' : 'neutral';

    // Indicator Peaks/Valleys
    const indFirstHalf = recentInd.slice(0, half);
    const indSecondHalf = recentInd.slice(half);
    const indTrend = Math.max(...indSecondHalf) > Math.max(...indFirstHalf) ? 'higher_high' :
        Math.min(...indSecondHalf) < Math.min(...indFirstHalf) ? 'lower_low' : 'neutral';

    // Bearish Divergence: Price Higher High + Indicator Lower High
    if (priceTrend === 'higher_high' && Math.max(...indSecondHalf) < Math.max(...indFirstHalf)) {
        return 'bearish';
    }

    // Bullish Divergence: Price Lower Low + Indicator Higher Low
    if (priceTrend === 'lower_low' && Math.min(...indSecondHalf) > Math.min(...indFirstHalf)) {
        return 'bullish';
    }

    return 'none';
};

/**
 * Calculate Rate of Change (ROC) and Momentum
 */
export const calculateMomentum = (klines: Kline[]): MomentumIndicators => {
    const closes = klines.map(k => k.close);
    const len = closes.length;

    // ROC calculation: ((Close - Close[n]) / Close[n]) * 100
    const calcROC = (period: number): number => {
        if (len <= period) return 0;
        const currentClose = closes[len - 1];
        const prevClose = closes[len - 1 - period];
        return prevClose !== 0 ? ((currentClose - prevClose) / prevClose) * 100 : 0;
    };

    const roc5 = calcROC(5);
    const roc10 = calcROC(10);
    const roc20 = calcROC(20);

    // Determine momentum state
    let momentum: MomentumIndicators['momentum'] = 'neutral';
    const rocTrend = roc5 > roc10 && roc10 > roc20; // Accelerating
    const rocDecel = roc5 < roc10 && roc10 < roc20; // Decelerating

    if (roc5 > 0) {
        momentum = rocTrend ? 'accelerating_up' : rocDecel ? 'decelerating_up' : 'neutral';
    } else if (roc5 < 0) {
        momentum = rocTrend ? 'decelerating_down' : rocDecel ? 'accelerating_down' : 'neutral';
    }

    // Calculate momentum score (-100 to +100)
    const momentumScore = Math.max(-100, Math.min(100, (roc5 * 2 + roc10 + roc20 * 0.5) / 3.5 * 10));

    // Calculate Divergences (RSI & MACD)
    // We calculate these locally here to avoid dependency injection issues
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const rsiValues = RSI.calculate({ values: close, period: 14 });
    const macdValues = MACD.calculate({
        values: close,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    }).map(m => m.histogram || 0);

    const rsiDivergence = detectGenericDivergence(klines, rsiValues);
    const macdDivergence = detectGenericDivergence(klines, macdValues);

    return {
        roc5: Math.round(roc5 * 100) / 100,
        roc10: Math.round(roc10 * 100) / 100,
        roc20: Math.round(roc20 * 100) / 100,
        momentum,
        momentumScore: Math.round(momentumScore),
        rsiDivergence,
        macdDivergence
    };
};
