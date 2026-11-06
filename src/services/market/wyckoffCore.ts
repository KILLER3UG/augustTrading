/**
 * wyckoffCore — range detection and the spring/upthrust family, pure math.
 *
 * Method: Wyckoff accumulation/distribution schematics. Detection is
 * deliberately conservative and every read carries an explicit confidence —
 * a spring that lacks the volume condition is NOT a spring, it is a sweep
 * with a lower name. The volume condition uses the candle's volume vs the
 * window average (taker split is NOT required — a spring is a price/volume
 * fact before it is an order-flow fact).
 *
 *  - range: the last `rangeBars` closed bars stay within a band whose width
 *    is ≤ `maxWidthAtr` × ATR (a same-height rejection floor and ceiling).
 *  - spring: a low UNDER the range low whose candle CLOSED back inside
 *    (rejection), with volume ≥ `minVolumeRatio` × window mean. UTAD: mirror.
 *  - sign of strength/weakness: the post-spring bar that leaves the range
 *    with displacement ≥ `sosDisplacementAtr` × ATR.
 */

import type { Kline } from '../../types/message';

export interface WyckoffRange {
    top: number;
    bottom: number;
    bars: number;
    widthAtr: number;
    /** Median volume of the range bars (the spring's yardstick). */
    medianVolume: number;
}

export interface WyckoffEvent {
    kind: 'spring' | 'upthrust' | 'sos' | 'sow';
    time: number;
    /** The range edge that was sprung / broken. */
    level: number;
    /** The event candle's volume ÷ the range's median volume. */
    volumeRatio: number;
    confidence: 'low' | 'medium';
    detail: string;
}

export interface WyckoffRead {
    range: WyckoffRange | null;
    events: WyckoffEvent[];
    /** The bias the events imply, or null when nothing qualifies. */
    bias: 'accumulative' | 'distributive' | null;
    thresholds: { maxWidthAtr: number; minVolumeRatio: number; sosDisplacementAtr: number; rangeBars: number };
    barsUsed: number;
    note: string;
}

const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const readWyckoff = (
    candles: Kline[],
    atr: number,
    options: { rangeBars?: number; maxWidthAtr?: number; minVolumeRatio?: number; sosDisplacementAtr?: number } = {},
): WyckoffRead | null => {
    if (!(atr > 0) || candles.length < 40) return null;
    const rangeBars = options.rangeBars ?? 30;
    const maxWidthAtr = options.maxWidthAtr ?? 3;
    const minVolumeRatio = options.minVolumeRatio ?? 1.2;
    const sosDisplacementAtr = options.sosDisplacementAtr ?? 1;

    const completed = candles.slice(0, -1); // closed candles only
    // The range is read over the window EXCLUDING the newest completed bar —
    // the most recent bar is the candidate EVENT (a spring defines itself as
    // under the range that existed before it; a range that includes its own
    // sweep can never see one).
    const window = completed.slice(0, -1).slice(-rangeBars);
    if (window.length < 20) return null;
    const top = Math.max(...window.map(c => c.high));
    const bottom = Math.min(...window.map(c => c.low));
    const widthAtr = (top - bottom) / atr;
    const medianVolume = median(window.map(c => c.volume));

    const range: WyckoffRange | null = widthAtr <= maxWidthAtr
        ? { top, bottom, bars: window.length, widthAtr: Math.round(widthAtr * 100) / 100, medianVolume }
        : null;

    const events: WyckoffEvent[] = [];
    if (range) {
        for (let i = 0; i < completed.length; i++) {
            const c = completed[i];
            if (c.time < window[0].time) continue;
            const volumeRatio = medianVolume > 0 ? c.volume / medianVolume : 0;
            // Spring: wick under the range low, close back inside, volume.
            if (c.low < range.bottom && c.close > range.bottom) {
                const withVolume = volumeRatio >= minVolumeRatio;
                if (withVolume) {
                    events.push({
                        kind: 'spring', time: c.time, level: range.bottom,
                        volumeRatio: Math.round(volumeRatio * 100) / 100,
                        confidence: 'medium',
                        detail: `swept ${(range.bottom - c.low) / atr > 0 ? ((range.bottom - c.low) / atr).toFixed(2) + '×ATR ' : ''}under the range low and closed back inside on ${volumeRatio.toFixed(1)}× median volume`,
                    });
                } else {
                    events.push({
                        kind: 'spring', time: c.time, level: range.bottom,
                        volumeRatio: Math.round(volumeRatio * 100) / 100,
                        confidence: 'low',
                        detail: `closed back inside the range low but volume ${volumeRatio.toFixed(1)}× is below the ${minVolumeRatio}× condition — a candidate, not a spring`,
                    });
                }
            }
            // Upthrust: mirror at the range high.
            if (c.high > range.top && c.close < range.top) {
                const withVolume = volumeRatio >= minVolumeRatio;
                if (withVolume) {
                    events.push({
                        kind: 'upthrust', time: c.time, level: range.top,
                        volumeRatio: Math.round(volumeRatio * 100) / 100,
                        confidence: 'medium',
                        detail: `swept above the range high and closed back inside on ${volumeRatio.toFixed(1)}× median volume`,
                    });
                } else {
                    events.push({
                        kind: 'upthrust', time: c.time, level: range.top,
                        volumeRatio: Math.round(volumeRatio * 100) / 100,
                        confidence: 'low',
                        detail: `closed back inside the range high but volume ${volumeRatio.toFixed(1)}× is below the ${minVolumeRatio}× condition`,
                    });
                }
            }
            // Sign of strength/weakness: displacement out of the range AFTER
            // an event (index guard: only candles after the first event).
            const firstEvent = events[0];
            if (firstEvent && c.time > firstEvent.time) {
                if (c.close > range.top && (c.close - c.open) / atr >= sosDisplacementAtr) {
                    events.push({ kind: 'sos', time: c.time, level: range.top, volumeRatio: Math.round(volumeRatio * 100) / 100, confidence: 'low', detail: `${((c.close - c.open) / atr).toFixed(1)}×ATR close beyond the range top` });
                }
                if (c.close < range.bottom && (c.open - c.close) / atr >= sosDisplacementAtr) {
                    events.push({ kind: 'sow', time: c.time, level: range.bottom, volumeRatio: Math.round(volumeRatio * 100) / 100, confidence: 'low', detail: `${((c.open - c.close) / atr).toFixed(1)}×ATR close beyond the range bottom` });
                }
            }
        }
    }

    const springs = events.filter(e => e.kind === 'spring' && e.confidence === 'medium').length;
    const sos = events.filter(e => e.kind === 'sos').length;
    const upthrusts = events.filter(e => e.kind === 'upthrust' && e.confidence === 'medium').length;
    const sows = events.filter(e => e.kind === 'sow').length;
    const bias: WyckoffRead['bias'] = springs + sos > 0 && springs + sos > upthrusts + sows ? 'accumulative'
        : upthrusts + sows > 0 ? 'distributive' : null;

    return {
        range,
        events: events.slice(-6),
        bias,
        thresholds: { maxWidthAtr, minVolumeRatio, sosDisplacementAtr, rangeBars },
        barsUsed: candles.length,
        note: 'spring/UTAD without the volume condition are flagged low-confidence by design; ranges wider than maxWidthAtr are not ranges at all',
    };
};
