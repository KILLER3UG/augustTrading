/**
 * regimeCore — the regime read as a STATE, not a label, pure math.
 *
 * Two separate axes, because "how trendy" and "how volatile" are different
 * questions a human answers independently:
 *  - direction axis: trend / range / neutral — ADX(14) with an efficiency-
 *    ratio confirm, and a NEUTRAL BAND near the boundaries so a borderline
 *    tape is not forced into a false binary;
 *  - volatility axis: compressed / normal / high — the percentile rank of
 *    ATR(14) and of Bollinger bandwidth over the trailing window.
 *
 * `dwell` (bars since the direction classification last changed) and the
 * stable `regime_id` exist so decisions and samples can be TAGGED per regime
 * — the per-regime win rates the harness cannot report today depend on that
 * tag existing. The coarse packet label (`TechnicalAnalysisService ›
 * calculateRegime`) stays where it is; convergence is a registered follow-up.
 */

import type { Kline } from '../../types/message';

export interface RegimeRead {
    /** Stable, taggable id: `<state>:<vol>:<barsUsed>`. */
    regimeId: string;
    direction: 'trend' | 'range' | 'neutral';
    directionStrength: number;
    efficiency: number;
    volatility: 'compressed' | 'normal' | 'high';
    atrPercentile: number | null;
    bbwPercentile: number | null;
    /** Bars since the direction classification last changed. */
    dwell: number;
    /** The declared thresholds — visible in output so a reader can audit. */
    thresholds: { adxTrend: number; adxRange: number; efficiencyConfirm: number; volHigh: number; volCompressed: number };
    barsUsed: number;
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Wilder ATR series (one value per bar from index `period`). */
export const atrSeries = (candles: Kline[], period = 14): number[] => {
    if (candles.length < period + 1) return [];
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
    const out: number[] = [atr];
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
        out.push(atr);
    }
    return out;
};

/** Wilder ADX series aligned with the tail of `candles`. */
export const adxSeries = (candles: Kline[], period = 14): number[] => {
    if (candles.length < period * 2 + 1) return [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const p = candles[i - 1];
        const up = c.high - p.high;
        const down = p.low - c.low;
        plusDM.push(up > down && up > 0 ? up : 0);
        minusDM.push(down > up && down > 0 ? down : 0);
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    const smooth = (xs: number[]): number[] => {
        const out: number[] = [];
        let acc = xs.slice(0, period).reduce((s, x) => s + x, 0);
        out.push(acc);
        for (let i = period; i < xs.length; i++) {
            acc = acc - acc / period + xs[i];
            out.push(acc);
        }
        return out;
    };
    const strP = smooth(plusDM);
    const strM = smooth(minusDM);
    const strTr = smooth(trs);
    const dxs: number[] = [];
    for (let i = 0; i < strP.length; i++) {
        if (strTr[i] <= 0) { dxs.push(0); continue; }
        const diP = (100 * strP[i]) / strTr[i];
        const diM = (100 * strM[i]) / strTr[i];
        const sum = diP + diM;
        dxs.push(sum > 0 ? (100 * Math.abs(diP - diM)) / sum : 0);
    }
    // Wilder smooth the DX into ADX.
    const adx: number[] = [];
    if (dxs.length >= period) {
        let acc = dxs.slice(0, period).reduce((s, x) => s + x, 0) / period;
        adx.push(acc);
        for (let i = period; i < dxs.length; i++) {
            acc = (acc * (period - 1) + dxs[i]) / period;
            adx.push(acc);
        }
    }
    return adx;
};

/** Kaufman efficiency ratio: net move ÷ sum of moves, over `n` bars. */
export const efficiencyRatio = (closes: number[], n = 10): number | null => {
    if (closes.length < n + 1) return null;
    const tail = closes.slice(-(n + 1));
    const net = Math.abs(tail[tail.length - 1] - tail[0]);
    let path = 0;
    for (let i = 1; i < tail.length; i++) path += Math.abs(tail[i] - tail[i - 1]);
    return path > 0 ? net / path : 0;
};

const percentileOf = (value: number, history: number[]): number | null => {
    if (history.length < 20) return null;
    const below = history.filter(v => v <= value).length;
    return Math.round((below / history.length) * 100);
};

/**
 * Bollinger bandwidth series ((upper−lower)/mid) on SMA20 ± 2σ, one value per
 * bar where a full window exists.
 */
export const bbwSeries = (candles: Kline[], period = 20): number[] => {
    const closes = candles.map(c => c.close);
    const out: number[] = [];
    for (let i = period; i <= closes.length; i++) {
        const win = closes.slice(i - period, i);
        const m = win.reduce((s, x) => s + x, 0) / period;
        const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) * (x - m), 0) / period);
        if (m > 0) out.push((4 * sd) / m);
    }
    return out;
};

/**
 * The regime read for one timeframe. `candles` are CLOSED and as-of filtered
 * by the caller; 120+ bars gives the percentiles room (80 minimum).
 */
export const regimeRead = (
    candles: Kline[],
    options: { adxTrend?: number; adxRange?: number; efficiencyConfirm?: number; volHigh?: number; volCompressed?: number } = {},
): RegimeRead | null => {
    if (candles.length < 80) return null;
    const adxTrend = options.adxTrend ?? 25;
    const adxRange = options.adxRange ?? 20;
    const efficiencyConfirm = options.efficiencyConfirm ?? 0.35;
    const volHigh = options.volHigh ?? 80;
    const volCompressed = options.volCompressed ?? 20;

    const closes = candles.map(c => c.close);
    const adx = adxSeries(candles);
    const lastAdx = adx.length ? adx[adx.length - 1] : null;
    const eff = efficiencyRatio(closes);
    if (lastAdx === null || eff === null) return null;

    // Direction axis with a neutral band: trend needs BOTH the ADX floor and
    // the efficiency confirm; range needs ADX at/below the range ceiling;
    // between the two sits neutral — a state, not a rounding error.
    let direction: RegimeRead['direction'];
    if (lastAdx >= adxTrend && eff >= efficiencyConfirm) direction = 'trend';
    else if (lastAdx <= adxRange) direction = 'range';
    else direction = 'neutral';

    // Dwell: walk the classification back bar by bar using the ONE ADX series
    // (adxSeries output index k maps to candle index L − adx.length + k) and
    // an efficiency ratio computed per prefix. Bounded, no O(n²) refit.
    const atrs = atrSeries(candles);
    const adxOffset = candles.length - adx.length;
    const classifyAt = (i: number): RegimeRead['direction'] | null => {
        const k = i - adxOffset;
        if (k < 0) return null;
        const a = adx[k];
        const e = efficiencyRatio(closes.slice(0, i + 1));
        if (e === null) return null;
        return a >= adxTrend && e >= efficiencyConfirm ? 'trend'
            : a <= adxRange ? 'range' : 'neutral';
    };
    let dwell = 0;
    for (let i = candles.length - 1; i >= adxOffset; i--) {
        const d = classifyAt(i);
        if (d === null || d !== direction) break;
        dwell += 1;
        if (dwell > 500) break;
    }

    // Volatility axis: percentile of the last ATR and the last bandwidth over
    // their trailing histories (self-rank included; percentile is coarse).
    const lastAtr = atrs.length ? atrs[atrs.length - 1] : null;
    const atrPct = lastAtr === null ? null : percentileOf(lastAtr, atrs.slice(0, -1));
    const bbws = bbwSeries(candles);
    const lastBbw = bbws.length ? bbws[bbws.length - 1] : null;
    const bbwPct = lastBbw === null ? null : percentileOf(lastBbw, bbws.slice(0, -1));

    let volatility: RegimeRead['volatility'] = 'normal';
    const highPct = Math.max(atrPct ?? 50, bbwPct ?? 50);
    const lowPct = Math.min(atrPct ?? 50, bbwPct ?? 50);
    if (highPct >= volHigh) volatility = 'high';
    else if (lowPct <= volCompressed) volatility = 'compressed';

    return {
        regimeId: `${direction}:${volatility}:${candles.length}`,
        direction,
        directionStrength: r4(lastAdx),
        efficiency: r4(eff),
        volatility,
        atrPercentile: atrPct,
        bbwPercentile: bbwPct,
        dwell,
        thresholds: { adxTrend, adxRange, efficiencyConfirm, volHigh, volCompressed },
        barsUsed: candles.length,
    };
};

// --- helpers kept for the trade_math tool (ATR sizing) -------------------

/** The current ATR(14) value, or null when there is not enough history. */
export const currentAtr = (candles: Kline[], period = 14): number | null => {
    const s = atrSeries(candles, period);
    return s.length ? s[s.length - 1] : null;
};

/** The mean candle range — the fallback vol unit when a period ATR is thin. */
export const meanCandleRange = (candles: Kline[]): number | null => {
    if (candles.length === 0) return null;
    return candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
};
