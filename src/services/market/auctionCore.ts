/**
 * auctionCore — the day-structure read (market/auction method), pure math.
 *
 * Session convention comes from `sessionConvention.ts` (UTC day, IB = first
 * 60 minutes). Every classification is a declared-threshold heuristic from
 * documented auction method, NOT a measured edge: the outputs carry their
 * thresholds and a confidence so the ablation can judge them. A human reads
 * these off a chart in seconds; the point here is that the model reads the
 * same numbers instead of inventing them.
 */

import type { Kline } from '../../types/message';
import type { VolumeProfileRead } from './volumeProfileCore';
import { UTC_DAY_MS, utcDayStart } from './sessionConvention';

export interface InitialBalanceRead {
    high: number;
    low: number;
    width: number;
    /** Width in ATR units. */
    widthAtr: number;
    /** Percentile of today's ATR-normalized IB width vs the prior N days
     *  (0–100; null when there is not enough prior-day history). */
    widthPercentile: number | null;
    priorDaysUsed: number;
}

export const initialBalance = (
    dayCandles: Kline[],
    priorDayCandles: Kline[],
    atr: number,
    asofMs: number,
    options: { priorDays?: number } = {},
): InitialBalanceRead | null => {
    const day = utcDayStart(asofMs);
    const ibEnd = day + 60 * 60_000;
    const ib = dayCandles.filter(c => c.time >= day && c.time < ibEnd);
    if (ib.length === 0 || !(atr > 0)) return null;
    const high = Math.max(...ib.map(c => c.high));
    const low = Math.min(...ib.map(c => c.low));
    const width = high - low;

    // The percentile normalizes EVERY day's IB width the same way — by that
    // day's own mean candle range — so today's still-developing day and a
    // completed prior day are compared on one scale. `atr` is only the
    // display unit (`widthAtr`), never the percentile's yardstick.
    const priorDays = options.priorDays ?? 10;
    const meanRange = (candles: Kline[]): number => {
        if (candles.length === 0) return 0;
        return candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
    };
    const todayMeanRange = meanRange(ib.length >= 4 ? ib : dayCandles);
    const normalized = todayMeanRange > 0 ? width / todayMeanRange : 0;

    const priorNormalized: number[] = [];
    for (let d = 1; d <= priorDays; d++) {
        const dStart = day - d * UTC_DAY_MS;
        const dCandles = priorDayCandles.filter(c => c.time >= dStart && c.time < dStart + UTC_DAY_MS);
        if (dCandles.length < 4) continue;
        const dIb = dCandles.filter(c => c.time < dStart + 60 * 60_000);
        if (dIb.length === 0) continue;
        const dMean = meanRange(dCandles);
        if (dMean <= 0) continue;
        priorNormalized.push((Math.max(...dIb.map(c => c.high)) - Math.min(...dIb.map(c => c.low))) / dMean);
    }

    let widthPercentile: number | null = null;
    if (priorNormalized.length >= 5 && normalized > 0) {
        const below = priorNormalized.filter(p => p < normalized).length;
        widthPercentile = Math.round((below / priorNormalized.length) * 100);
    }

    return {
        high,
        low,
        width,
        widthAtr: Math.round((width / atr) * 100) / 100,
        widthPercentile,
        priorDaysUsed: priorNormalized.length,
    };
};

export type OpenType = 'drive' | 'test_drive' | 'rejection_reverse' | 'balanced';

export interface OpenTypeRead {
    type: OpenType;
    confidence: 'low' | 'medium';
    detail: string;
    /** The day's opening price (first candle's open). */
    open: number;
}

/**
 * Open type from the first 30 minutes plus behavior through `asof`:
 *  - drive: first 30m travels ≥ 1.0 ATR in one direction and price has not
 *    traded back through the open since;
 *  - rejection_reverse: the day opened beyond the prior day's range and the
 *    first hour traded back through the open against that side;
 *  - test_drive: a quiet open (< 0.5 ATR in 30m) followed by a break of one
 *    IB edge before mid-session;
 *  - balanced: none of the above.
 */
export const openType = (
    dayCandles: Kline[],
    priorDayRange: { high: number; low: number } | null,
    atr: number,
    asofMs: number,
): OpenTypeRead | null => {
    if (dayCandles.length === 0 || !(atr > 0)) return null;
    const open = dayCandles[0].open;
    const day = utcDayStart(dayCandles[0].time);
    const first30 = dayCandles.filter(c => c.time < day + 30 * 60_000);
    if (first30.length === 0) return null;
    const first30Range = Math.max(...first30.map(c => c.high)) - Math.min(...first30.map(c => c.low));
    const first30Close = first30[first30.length - 1].close;
    const upMove = first30Close >= open;

    const sinceOpen = dayCandles.filter(c => c.time >= day && c.time <= asofMs);
    const revisitedOpen = sinceOpen.some(c => c.low <= open && c.high >= open) && sinceOpen.length > 1
        ? sinceOpen.slice(1).some(c => c.low <= open && c.high >= open)
        : false;

    if (first30Range >= atr && !revisitedOpen) {
        return {
            type: 'drive',
            confidence: 'medium',
            detail: `first 30m ${(first30Range / atr).toFixed(2)}×ATR ${upMove ? 'up' : 'down'}, open never revisited`,
            open,
        };
    }
    if (priorDayRange && (open > priorDayRange.high || open < priorDayRange.low)) {
        const backInside = sinceOpen.some(c => c.close <= priorDayRange.high && c.close >= priorDayRange.low);
        if (backInside) {
            return {
                type: 'rejection_reverse',
                confidence: 'medium',
                detail: `opened beyond prior day range, traded back inside within the day`,
                open,
            };
        }
    }
    if (first30Range < 0.5 * atr) {
        const ib = firstHoursRange(dayCandles, day);
        const brokeEdge = sinceOpen.some(c => c.close > ib.high || c.close < ib.low);
        if (brokeEdge) {
            return { type: 'test_drive', confidence: 'low', detail: 'quiet open, then an IB edge broke before mid-session', open };
        }
    }
    return { type: 'balanced', confidence: 'low', detail: `first 30m ${(first30Range / atr).toFixed(2)}×ATR, open revisited or unremarkable`, open };
};

const firstHoursRange = (dayCandles: Kline[], day: number): { high: number; low: number } => {
    const ib = dayCandles.filter(c => c.time < day + 60 * 60_000);
    const pool = ib.length > 0 ? ib : dayCandles.slice(0, Math.min(12, dayCandles.length));
    return {
        high: Math.max(...pool.map(c => c.high)),
        low: Math.min(...pool.map(c => c.low)),
    };
};

export type DayType = 'trend' | 'normal_variation' | 'normal' | 'neutral';

export interface DayTypeRead {
    type: DayType;
    /** How far the evidence is from a boundary: 'low' means treat as lean. */
    confidence: 'low' | 'medium';
    rangeSoFarAtr: number;
    rangeVsIb: number | null;
    detail: string;
}

/**
 * Developing day type from the range built so far vs the IB, where the close
 * (last closed candle) sits in the day range, and whether both IB edges have
 * been broken in both directions (neutral). Thresholds are declared in the
 * output detail so a reader can disagree with the numbers visible.
 */
export const dayType = (
    dayCandles: Kline[],
    ib: InitialBalanceRead,
    atr: number,
    asofMs: number,
): DayTypeRead | null => {
    if (dayCandles.length === 0 || !(atr > 0)) return null;
    const since = dayCandles.filter(c => c.time <= asofMs);
    if (since.length === 0) return null;
    const high = Math.max(...since.map(c => c.high));
    const low = Math.min(...since.map(c => c.low));
    const rangeAtr = (high - low) / atr;
    const close = since[since.length - 1].close;
    const position = high > low ? (close - low) / (high - low) : 0.5;
    const rangeVsIb = ib.width > 0 ? (high - low) / ib.width : null;

    const brokeUp = since.some(c => c.close > ib.high);
    const brokeDown = since.some(c => c.close < ib.low);
    const extreme = position >= 0.8 ? 'up' : position <= 0.2 ? 'down' : null;

    let type: DayType;
    let confidence: 'low' | 'medium' = 'low';
    let detail: string;
    if (rangeVsIb !== null && rangeVsIb >= 2 && extreme && ((extreme === 'up' && brokeUp) || (extreme === 'down' && brokeDown))) {
        type = 'trend';
        confidence = 'medium';
        detail = `${rangeVsIb.toFixed(1)}× IB range, close in the ${extreme === 'up' ? 'top' : 'bottom'} 20%`;
    } else if (brokeUp && brokeDown && position > 0.35 && position < 0.65) {
        type = 'neutral';
        detail = 'both IB edges broke both ways, close mid-range';
    } else if (rangeVsIb !== null && rangeVsIb >= 1.5) {
        type = 'normal_variation';
        detail = `${rangeVsIb.toFixed(1)}× IB range, close mid-range`;
    } else {
        type = 'normal';
        detail = `range ${rangeAtr.toFixed(2)}×ATR within/near IB`;
    }
    return { type, confidence, rangeSoFarAtr: Math.round(rangeAtr * 100) / 100, rangeVsIb: rangeVsIb === null ? null : Math.round(rangeVsIb * 100) / 100, detail };
};

export interface FailedExtensionRead {
    side: 'above_ib_high' | 'below_ib_low' | null;
    maxExtensionAtr: number;
    failed: boolean;
    detail: string;
}

/** Price extended beyond an IB edge, then a candle CLOSED back inside. */
export const failedIbExtension = (
    dayCandles: Kline[],
    ib: InitialBalanceRead,
    atr: number,
    asofMs: number,
): FailedExtensionRead => {
    const since = dayCandles.filter(c => c.time <= asofMs);
    let side: 'above_ib_high' | 'below_ib_low' | null = null;
    let maxExt = 0;
    let failed = false;
    for (const c of since) {
        if (c.high > ib.high) {
            const ext = (c.high - ib.high) / atr;
            if (ext > maxExt && side !== 'below_ib_low') { maxExt = ext; side = 'above_ib_high'; }
        }
        if (c.low < ib.low) {
            const ext = (ib.low - c.low) / atr;
            if (ext > maxExt && side !== 'above_ib_high') { maxExt = ext; side = 'below_ib_low'; }
        }
        if (side === 'above_ib_high' && c.close < ib.high) failed = true;
        if (side === 'below_ib_low' && c.close > ib.low) failed = true;
    }
    return {
        side,
        maxExtensionAtr: Math.round(maxExt * 100) / 100,
        failed,
        detail: failed
            ? `extended ${(maxExt).toFixed(2)}×ATR beyond the ${side === 'above_ib_high' ? 'IB high' : 'IB low'}, closed back inside`
            : side
                ? `beyond the ${side === 'above_ib_high' ? 'IB high' : 'IB low'} by ${(maxExt).toFixed(2)}×ATR, still accepted`
                : 'price has not left the IB',
    };
};

export interface PoorEdgesRead {
    poorHigh: boolean;
    poorLow: boolean;
    detail: string;
}

/**
 * Poor highs/lows from the day's profile: ≥3 consecutive bins at ≤5% of the
 * peak volume hugging the top/bottom of the distribution — an edge with no
 * built excess behind it. (True single-print-vs-excess discrimination needs
 * finer data; this is the candle-resolution version and says so.)
 */
export const poorEdges = (profile: VolumeProfileRead): PoorEdgesRead | null => {
    if (profile.bins.length < 8) return null;
    const peak = Math.max(...profile.bins.map(b => b.volume));
    if (peak <= 0) return null;
    const thin = (b: { volume: number }): boolean => b.volume <= peak * 0.05;
    const top = profile.bins.slice(-4);
    const bottom = profile.bins.slice(0, 4);
    const poorHigh = top.slice(-3).every(thin);
    const poorLow = bottom.slice(0, 3).every(thin);
    return {
        poorHigh,
        poorLow,
        detail: `${poorHigh ? 'poor high' : 'excess at the high'}, ${poorLow ? 'poor low' : 'excess at the low'} (candle-resolution)`,
    };
};

export interface VaRotationRead {
    /** Where today opened relative to the PRIOR day's value area. */
    openVsPriorValue: 'above' | 'below' | 'inside' | null;
    /** Price has since closed back inside the prior value area. */
    reentered: boolean;
    /** The opposite side of the prior value area — the rotation target. */
    target: number | null;
    detail: string;
}

/** The classic rotation setup: open outside prior value, re-enter it, the
 *  far side of prior value becomes the objective. */
export const vaRotationSetup = (
    dayCandles: Kline[],
    priorValue: { valueAreaHigh: number; valueAreaLow: number } | null,
    asofMs: number,
): VaRotationRead => {
    if (!priorValue) {
        return { openVsPriorValue: null, reentered: false, target: null, detail: 'prior-day value area unavailable' };
    }
    const dayCandlesInDay = dayCandles.filter(c => c.time <= asofMs);
    if (dayCandlesInDay.length === 0) {
        return { openVsPriorValue: null, reentered: false, target: null, detail: 'no closed candles in the day yet' };
    }
    const open = dayCandlesInDay[0].open;
    const openVsPriorValue: 'above' | 'below' | 'inside' =
        open > priorValue.valueAreaHigh ? 'above' : open < priorValue.valueAreaLow ? 'below' : 'inside';
    const reentered = dayCandlesInDay.some(c =>
        c.close <= priorValue.valueAreaHigh && c.close >= priorValue.valueAreaLow);
    const target = openVsPriorValue === 'above' ? priorValue.valueAreaLow
        : openVsPriorValue === 'below' ? priorValue.valueAreaHigh : null;
    return {
        openVsPriorValue,
        reentered,
        target,
        detail: openVsPriorValue === 'inside'
            ? 'opened inside prior value — no rotation setup'
            : `opened ${openVsPriorValue === 'above' ? 'above' : 'below'} prior value${reentered ? ', re-entered value' : ', not yet back inside'}`,
    };
};
