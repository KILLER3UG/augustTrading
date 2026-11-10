/**
 * regime — the bias chips under the Chart AI header, CODE-CALCULATED like
 * the market packet: EMA9/21 cross + RSI-14 agree → the timeframe is Bullish
 * or Bearish; split decision or thin history → Neutral (the honest "no read"
 * state, shown in slate, never a coin-flip). The VWAP chip is a real session
 * VWAP: volume-weighted typical price over today's candles of the chart's own
 * timeframe — the level intraday traders actually lean on. Pure functions
 * over Kline[] so the whole read is unit-testable without a network.
 */

import type { Kline } from '../analysis/MarketDataService';

export type BiasTone = 'bull' | 'bear' | 'neutral';

export interface BiasChip {
    /** e.g. "1D Bullish", "15m Neutral", "Above VWAP". */
    text: string;
    tone: BiasTone | 'vwap';
}

/** Exponential moving average of the TAIL (last `period`-warm values) —
 *  seeded with the SMA of the first `period` closes. */
export const ema = (values: number[], period: number): number | null => {
    if (values.length < period || period <= 0) return null;
    let acc = 0;
    for (let i = 0; i < period; i += 1) acc += values[i];
    let e = acc / period;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
    return e;
};

/** Wilder-smoothed RSI over all provided closes (needs ≥ period+1). */
export const rsi = (closes: number[], period = 14): number | null => {
    if (closes.length < period + 1) return null;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    for (let i = period + 1; i < closes.length; i += 1) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
};

/**
 * One timeframe's bias: EMA9 must be over EMA21 AND RSI must lean the same
 * way (≥55 / ≤45 — a 50/50 RSI is not confirmation). Disagreement, or fewer
 * than 30 closes of history, reads NEUTRAL.
 */
export const trendBias = (closes: number[]): BiasTone => {
    if (closes.length < 30) return 'neutral';
    const fast = ema(closes, 9);
    const slow = ema(closes, 21);
    const r = rsi(closes, 14);
    if (fast === null || slow === null || r === null) return 'neutral';
    if (fast > slow && r >= 55) return 'bull';
    if (fast < slow && r <= 45) return 'bear';
    return 'neutral';
};

/** Session VWAP over one day's candles: Σ(typical×volume)/Σvolume where
 *  typical = (H+L+C)/3. Null on empty/zero-volume history. */
export const sessionVwap = (dayCandles: Kline[]): number | null => {
    let num = 0;
    let den = 0;
    for (const k of dayCandles) {
        if (!Number.isFinite(k.close) || !Number.isFinite(k.volume)) continue;
        const tp = (k.high + k.low + k.close) / 3;
        num += tp * k.volume;
        den += k.volume;
    }
    if (den <= 0 || !Number.isFinite(num)) return null;
    return num / den;
};

/**
 * The chip row (prototype order: macro first). `current`/`currentLabel` are
 * the chart's timeframe candles + tag ("15m"); `daily` are 1D candles — the
 * LAST one is today, and its own time opens the session window the VWAP is
 * computed over. A series with too little history contributes nothing rather
 * than a fake chip.
 */
export const biasChips = (
    current: Kline[],
    currentLabel: string,
    daily: Kline[],
): BiasChip[] => {
    const word = (t: BiasTone): string => (t === 'bull' ? 'Bullish' : t === 'bear' ? 'Bearish' : 'Neutral');
    const chips: BiasChip[] = [];
    if (daily.length >= 30) {
        const t = trendBias(daily.map(k => k.close));
        chips.push({ text: `1D ${word(t)}`, tone: t });
    }
    // On the daily chart `current` IS the daily series, so this would emit a
    // second "1D Bearish" — two chips with identical text, which React renders
    // as duplicate keys and can drop a row. One bar length, one chip.
    if (current.length >= 30 && currentLabel !== '1D') {
        const t = trendBias(current.map(k => k.close));
        chips.push({ text: `${currentLabel} ${word(t)}`, tone: t });
    }
    if (current.length >= 2 && daily.length > 0) {
        const today = daily[daily.length - 1];
        const todayCandles = current.filter(k => k.time >= today.time);
        const vwap = sessionVwap(todayCandles.length > 0 ? todayCandles : [today]);
        const mark = current[current.length - 1].close;
        if (vwap !== null && Number.isFinite(mark)) {
            chips.push({ text: mark >= vwap ? 'Above VWAP' : 'Below VWAP', tone: 'vwap' });
        }
    }
    return chips;
};
