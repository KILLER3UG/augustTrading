/**
 * swingStructureCore — swing structure the way a trader reads it, pure math.
 *
 * Swings are fractal pivots (a high with `k` lower highs on each side, k=2
 * default). From the pivot sequence the module derives the vocabulary the
 * packet only describes in prose: HH/HL/LH/LL labels, break of structure
 * (a CLOSE beyond the last opposing swing), change of character (the first
 * break against the prevailing leg sequence), and the per-timeframe trend
 * state. Fibonacci retracements come from the ACTIVE swing — the last
 * completed opposite-kind pivot pair — with a confluence count (how many
 * prior swings sit within tolerance of each level), which is what makes a
 * fib line more than a formula.
 *
 * The prose versions that exist elsewhere (`candleFormations.describeMarketStructure`,
 * the packet's SMC block) stay; this module is the tool-grade read with the
 * prices a drawing needs.
 */

import type { Kline } from '../../types/message';

export interface SwingPoint {
    time: number;
    price: number;
    kind: 'high' | 'low';
    /** Index in the completed candle series. */
    index: number;
}

export interface SwingLabel {
    swing: SwingPoint;
    /** Higher-High / Higher-Low / Lower-High / Lower-Low vs the previous
     *  swing of the same kind. */
    tag: 'HH' | 'HL' | 'LH' | 'LL';
}

export interface StructureRead {
    swings: SwingPoint[];
    labels: SwingLabel[];
    /** Sequence trend from the last two swings of each kind. */
    trend: 'uptrend' | 'downtrend' | 'range';
    /** The last structural break, and whether it changed character. */
    lastBreak: { kind: 'BOS' | 'CHoCH'; direction: 'bullish' | 'bearish'; level: number; time: number } | null;
    barsUsed: number;
}

/** Fractal pivots: k candles each side must be lower (high) / higher (low). */
export const findSwings = (candles: Kline[], k = 2): SwingPoint[] => {
    const swings: SwingPoint[] = [];
    for (let i = k; i < candles.length - k; i++) {
        let isHigh = true;
        let isLow = true;
        for (let j = i - k; j <= i + k; j++) {
            if (j === i) continue;
            if (candles[j].high >= candles[i].high) isHigh = false;
            if (candles[j].low <= candles[i].low) isLow = false;
        }
        if (isHigh) swings.push({ time: candles[i].time, price: candles[i].high, kind: 'high', index: i });
        if (isLow) swings.push({ time: candles[i].time, price: candles[i].low, kind: 'low', index: i });
    }
    return swings;
};

export const readStructure = (candles: Kline[], k = 2): StructureRead | null => {
    if (candles.length < (k + 1) * 2 + 4) return null;
    const swings = findSwings(candles, k);
    if (swings.length < 4) return null;

    // Label each swing against the previous swing of the SAME kind.
    const labels: SwingLabel[] = [];
    let prevHigh: SwingPoint | null = null;
    let prevLow: SwingPoint | null = null;
    for (const s of swings) {
        if (s.kind === 'high') {
            if (prevHigh) labels.push({ swing: s, tag: s.price > prevHigh.price ? 'HH' : 'LH' });
            prevHigh = s;
        } else {
            if (prevLow) labels.push({ swing: s, tag: s.price > prevLow.price ? 'HL' : 'LL' });
            prevLow = s;
        }
    }

    // Sequence trend: the last two highs and last two lows.
    const highs = labels.filter(l => l.swing.kind === 'high');
    const lows = labels.filter(l => l.swing.kind === 'low');
    const lastTwoHighs = highs.slice(-2).map(l => l.tag);
    const lastTwoLows = lows.slice(-2).map(l => l.tag);
    const up = lastTwoHighs.includes('HH') && lastTwoLows.includes('HL');
    const down = lastTwoHighs.includes('LH') && lastTwoLows.includes('LL');
    const trend: StructureRead['trend'] = up && !down ? 'uptrend' : down && !up ? 'downtrend' : 'range';

    // Breaks: a CLOSE beyond the most recent opposing swing. BOS = with the
    // sequence trend; CHoCH = the first break against it.
    const highsAll = swings.filter(s => s.kind === 'high');
    const lowsAll = swings.filter(s => s.kind === 'low');
    let lastBreak: StructureRead['lastBreak'] = null;
    let prevailing: 'bullish' | 'bearish' | null = null;
    for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const priorHighs = highsAll.filter(s => s.index < i - 1);
        const priorLows = lowsAll.filter(s => s.index < i - 1);
        const lastHigh = priorHighs[priorHighs.length - 1];
        const lastLow = priorLows[priorLows.length - 1];
        if (lastHigh && c.close > lastHigh.price) {
            const kind = prevailing === 'bearish' ? 'CHoCH' : 'BOS';
            lastBreak = { kind, direction: 'bullish', level: lastHigh.price, time: c.time };
            prevailing = 'bullish';
        } else if (lastLow && c.close < lastLow.price) {
            const kind = prevailing === 'bullish' ? 'CHoCH' : 'BOS';
            lastBreak = { kind, direction: 'bearish', level: lastLow.price, time: c.time };
            prevailing = 'bearish';
        }
    }

    return { swings, labels, trend, lastBreak, barsUsed: candles.length };
};

export interface FibLevel {
    ratio: string;
    price: number;
    /** Swings whose price sits within tolerance of the level. */
    confluence: number;
}

export interface ActiveFibRead {
    from: SwingPoint;
    to: SwingPoint;
    direction: 'bullish' | 'bearish';
    levels: FibLevel[];
    /** The declared confluence tolerance, in ATR units. */
    toleranceAtr: number;
}

const FIB_RATIOS: Array<[string, number]> = [
    ['0.236', 0.236], ['0.382', 0.382], ['0.5', 0.5], ['0.618', 0.618], ['0.786', 0.786],
];

/**
 * Fibonacci retracements from the ACTIVE swing: the last completed high→low
 * (bearish leg) or low→high (bullish leg) pair, most recent first. Each level
 * counts how many PRIOR swings sit within `toleranceAtr` of it — a level the
 * market has already respected is worth more than a bare ratio.
 */
export const activeSwingFib = (candles: Kline[], atr: number, toleranceAtr = 0.25): ActiveFibRead | null => {
    if (!(atr > 0) || candles.length < 10) return null;
    const swings = findSwings(candles, 2);
    if (swings.length < 2) return null;
    const lastHigh = [...swings].reverse().find(s => s.kind === 'high');
    const lastLow = [...swings].reverse().find(s => s.kind === 'low');
    if (!lastHigh || !lastLow) return null;
    // The active leg is the one whose pivot came LAST.
    const bullish = lastLow.time > lastHigh.time;
    const from = bullish ? lastLow : lastHigh;
    const to = bullish ? lastHigh : lastLow;
    const tolerance = toleranceAtr * atr;
    const levels: FibLevel[] = FIB_RATIOS.map(([ratio, r]) => {
        const price = to.price - (to.price - from.price) * r;
        const confluence = swings.filter(s => Math.abs(s.price - price) <= tolerance && s.time < to.time).length;
        return { ratio, price, confluence };
    });
    return { from, to, direction: bullish ? 'bullish' : 'bearish', levels, toleranceAtr };
};
