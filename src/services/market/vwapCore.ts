/**
 * vwapCore — VWAP with volume-weighted standard bands, anchored variants,
 * and the participant-position read. Pure math over CLOSED candles.
 *
 * VWAP itself is structural (a volume-weighted mean of typical price). The
 * "participants in profit / trapped" statement is an ESTIMATE: candles know
 * volume per bar, not who holds what, so the read is framed as the
 * volume-weighted average position vs the current price and is labelled as
 * an estimate in the tool output.
 */

import type { Kline } from '../../types/message';

export interface VwapRead {
    vwap: number;
    /** Volume-weighted standard deviation of typical price. */
    sd: number;
    bands: { oneUpper: number; oneLower: number; twoUpper: number; twoLower: number };
    totalVolume: number;
    /** First bar time of the anchoring window (echoed for auditability). */
    anchoredFrom: number | null;
}

const typical = (c: Kline): number => (c.high + c.low + c.close) / 3;

/**
 * VWAP over the given candle window (the caller resolves the anchor and
 * slices the candles). Requires volume > 0 somewhere; otherwise null.
 */
export const computeVwap = (candles: Kline[], anchoredFrom: number | null = null): VwapRead | null => {
    if (candles.length === 0) return null;
    let pv = 0;
    let vol = 0;
    let pv2 = 0;
    for (const c of candles) {
        if (!(c.volume > 0)) continue;
        const t = typical(c);
        pv += t * c.volume;
        pv2 += t * t * c.volume;
        vol += c.volume;
    }
    if (vol <= 0) return null;
    const vwap = pv / vol;
    const variance = Math.max(0, pv2 / vol - vwap * vwap);
    const sd = Math.sqrt(variance);
    return {
        vwap,
        sd,
        bands: {
            oneUpper: vwap + sd,
            oneLower: vwap - sd,
            twoUpper: vwap + 2 * sd,
            twoLower: vwap - 2 * sd,
        },
        totalVolume: vol,
        anchoredFrom: anchoredFrom ?? candles[0].time,
    };
};

export interface VwapPositionRead {
    side: 'above' | 'below';
    /** Signed distance of close from VWAP in price units. */
    distance: number;
    barsSinceCross: number | null;
    /**
     * The honest framing: the volume-weighted average participant of the
     * anchored window sits in profit or underwater vs the current close.
     * An estimate from candle aggregates, never a position-level fact.
     */
    verdict: 'participants_in_profit' | 'participants_underwater';
    estimate: true;
}

/** The participant-position read vs a computed VWAP. `close` is the last
 *  closed candle's close (as-of correctness is the caller's duty). */
export const vwapPosition = (
    vwap: VwapRead,
    candles: Kline[],
    close: number,
): VwapPositionRead | null => {
    if (candles.length === 0) return null;
    const side: 'above' | 'below' = close >= vwap.vwap ? 'above' : 'below';
    let barsSinceCross: number | null = null;
    for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i];
        const wasAbove = c.close >= vwap.vwap;
        if (wasAbove !== (side === 'above')) {
            barsSinceCross = candles.length - 1 - i;
            break;
        }
    }
    return {
        side,
        distance: close - vwap.vwap,
        barsSinceCross,
        verdict: side === 'above' ? 'participants_in_profit' : 'participants_underwater',
        estimate: true,
    };
};

/**
 * Anchor resolution for the tool layer. Given the lookback candles and the
 * anchor kind, returns the slice of candles FROM the anchor forward (the
 * window VWAP is computed over). `customTime` slices from the first candle
 * at or after the timestamp. A swing anchor is the extreme candle of the
 * lookback (highest high for `swing_high`, lowest low for `swing_low`).
 */
export const anchoredSlice = (
    candles: Kline[],
    anchor: 'session_open' | 'swing_high' | 'swing_low' | 'custom',
    customTime?: number,
): Kline[] | null => {
    if (candles.length === 0) return null;
    if (anchor === 'custom') {
        if (typeof customTime !== 'number' || !Number.isFinite(customTime)) return null;
        const idx = candles.findIndex(c => c.time >= customTime);
        if (idx < 0) return null;
        return candles.slice(idx);
    }
    if (anchor === 'session_open') {
        // The caller passes candles already sliced to the session open.
        return candles;
    }
    let extremeIdx = 0;
    for (let i = 1; i < candles.length; i++) {
        const better = anchor === 'swing_high'
            ? candles[i].high > candles[extremeIdx].high
            : candles[i].low < candles[extremeIdx].low;
        if (better) extremeIdx = i;
    }
    // VWAP from the swing candle forward: the anchor is the extreme, the
    // window starts there (participants since the swing).
    return candles.slice(extremeIdx);
};
