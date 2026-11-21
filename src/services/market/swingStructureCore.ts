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
    /** 'retracement' ratios measure the give-back from the swing end;
     *  'extension' ratios project the leg past its end — never confuse the
     *  two (a 1.272 continuation is not a 1.272 retracement). */
    kind: 'retracement' | 'extension';
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
    ['0.236', 0.236], ['0.382', 0.382], ['0.5', 0.5], ['0.618', 0.618], ['0.705', 0.705], ['0.786', 0.786],
];
// Extensions project the completed leg PAST its end: start + r × range.
const FIB_EXTENSION_RATIOS: Array<[string, number]> = [
    ['1.272', 1.272], ['1.618', 1.618], ['2.0', 2],
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
    const confluenceAt = (price: number): number =>
        swings.filter(s => Math.abs(s.price - price) <= tolerance && s.time < to.time).length;
    const levels: FibLevel[] = [
        // Retracements: level = end − r × (end − start) — the standard
        // give-back-from-the-extreme convention, shared with the chart's
        // fib drawings and calculateFibonacciLevels.
        ...FIB_RATIOS.map(([ratio, r]) => {
            const price = to.price - (to.price - from.price) * r;
            return { ratio, price, kind: 'retracement' as const, confluence: confluenceAt(price) };
        }),
        // Extensions: level = start + r × (end − start) with the SIGNED
        // range — a down-leg extends downward. A level at or below zero
        // (deep legs × 2.0) is omitted, never emitted as a negative price.
        ...FIB_EXTENSION_RATIOS.map(([ratio, r]) => {
            const price = from.price + (to.price - from.price) * r;
            return { ratio, price, kind: 'extension' as const, confluence: confluenceAt(price) };
        }),
    ].filter(l => l.price > 0);
    return { from, to, direction: bullish ? 'bullish' : 'bearish', levels, toleranceAtr };
};

// ─── Wave B: Al Brooks bar-count pullbacks, composite candles, inside clusters ──

export type PullbackLabel = 'H1' | 'H2' | 'H3' | 'H4' | 'L1' | 'L2' | 'L3' | 'L4';

export interface PullbackRead {
    direction: 'bull' | 'bear';
    /** Active resumption count, clamped to 4 for the label (count is exact). */
    label: PullbackLabel;
    /** Exact consecutive resumption bars counted. */
    count: number;
    /** One tick beyond the newest signal bar's extreme. */
    triggerPrice: number;
    /** The pullback's opposite extreme (bull: lowest low; bear: highest high). */
    invalidationPrice: number;
}

/**
 * Bar-count pullback engine (Al Brooks H1–H4 / L1–L4). Walking backward from
 * the newest closed bar: a bar whose high exceeds its predecessor's high
 * extends the bull resumption count (H); a bar whose low undercuts its
 * predecessor's low extends the bear count (L). The trigger sits one tick
 * beyond the newest signal bar's extreme; the invalidation is the pullback's
 * opposite extreme. `tickSize` is caller-supplied (0 → trigger = the extreme).
 */
export const barCountPullback = (candles: Kline[], tickSize = 0): PullbackRead | null => {
    if (candles.length < 2) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const tick = tickSize > 0 ? tickSize : 0;
    const higherHigh = last.high > prev.high;
    const lowerLow = last.low < prev.low;
    if (!higherHigh && !lowerLow) return null;
    const bull = higherHigh && lowerLow ? last.close >= last.open : higherHigh;
    let count = 1;
    let extreme = bull ? Math.min(prev.low, last.low) : Math.max(prev.high, last.high);
    for (let i = candles.length - 2; i > 0; i--) {
        const c = candles[i];
        const p = candles[i - 1];
        const extendsStreak = bull ? c.high > p.high : c.low < p.low;
        if (!extendsStreak) break;
        count += 1;
        extreme = bull ? Math.min(extreme, p.low, c.low) : Math.max(extreme, p.high, c.high);
    }
    const label = ((bull ? 'H' : 'L') + Math.min(4, count)) as PullbackLabel;
    return {
        direction: bull ? 'bull' : 'bear',
        label,
        count,
        triggerPrice: Number((bull ? last.high + tick : last.low - tick).toFixed(8)),
        invalidationPrice: Number(extreme.toFixed(8)),
    };
};

export interface CompositeCandleRead {
    bars: 2 | 3;
    open: number;
    high: number;
    low: number;
    close: number;
    /** |close − open| ÷ range of the blended bar. */
    bodyRatio: number;
    upperTailRatio: number;
    lowerTailRatio: number;
    netDirection: 'bull' | 'bear' | 'doji';
    /** 2-bar only: shared range of the two bars ÷ the wider bar's range
     *  (0 when they do not overlap). > 0.75 = Al Brooks' heavy-overlap
     *  two-bar reversal, where a breakout must clear BOTH bars. */
    overlapRatio?: number;
    /** True when the two bars overlap so heavily that the entry trigger must
     *  clear the extreme of BOTH bars, not just the second. */
    requiresBothBarsClear?: boolean;
    /** One-tick beyond the extreme the breakout must clear (both bars when
     *  heavily overlapped, else the second bar alone). */
    triggerHigh?: number;
    triggerLow?: number;
}

/**
 * Blend the last `bars` (2 or 3) closed bars into ONE synthetic candle:
 * open = first.open, close = last.close, high/low = extremes. The body and
 * tail ratios describe the blended bar the way a single bar's would.
 */
export const compositeCandle = (candles: Kline[], bars: 2 | 3, tickSize = 0): CompositeCandleRead | null => {
    if (candles.length < bars) return null;
    const tail = candles.slice(-bars);
    const open = tail[0].open;
    const close = tail[tail.length - 1].close;
    const high = Math.max(...tail.map(c => c.high));
    const low = Math.min(...tail.map(c => c.low));
    const range = high - low;
    if (!(range > 0)) return null;
    const body = Math.abs(close - open);
    const upperTail = high - Math.max(open, close);
    const lowerTail = Math.min(open, close) - low;
    const tick = tickSize > 0 ? tickSize : 0;
    // Al Brooks' two-bar overlap rule: when the last two closed bars share
    // more than 75% of the wider bar's range, neither bar alone marks the
    // reversal — the breakout trigger must clear BOTH extremes.
    let overlap: Pick<CompositeCandleRead, 'overlapRatio' | 'requiresBothBarsClear' | 'triggerHigh' | 'triggerLow'> = {};
    if (bars === 2) {
        const [b1, b2] = tail;
        const shared = Math.min(b1.high, b2.high) - Math.max(b1.low, b2.low);
        const widerRange = Math.max(b1.high - b1.low, b2.high - b2.low, 1e-9);
        const overlapRatio = Math.max(0, shared) / widerRange;
        const requiresBothBarsClear = overlapRatio > 0.75;
        const triggerHigh = (requiresBothBarsClear ? Math.max(b1.high, b2.high) : b2.high) + tick;
        const triggerLow = (requiresBothBarsClear ? Math.min(b1.low, b2.low) : b2.low) - tick;
        overlap = {
            overlapRatio: Number(overlapRatio.toFixed(4)),
            requiresBothBarsClear,
            triggerHigh: Number(triggerHigh.toFixed(8)),
            triggerLow: Number(triggerLow.toFixed(8)),
        };
    }
    return {
        bars,
        open,
        high,
        low,
        close,
        bodyRatio: Number((body / range).toFixed(4)),
        upperTailRatio: Number((upperTail / range).toFixed(4)),
        lowerTailRatio: Number((lowerTail / range).toFixed(4)),
        netDirection: body / range < 0.1 ? 'doji' : close > open ? 'bull' : 'bear',
        ...overlap,
    };
};

export interface InsideClusterRead {
    kind: 'ii' | 'iii' | 'ioi';
    /** Indices into the passed series, oldest first. */
    indices: number[];
    /** Breakout triggers: one tick beyond the cluster's reference extremes. */
    breakoutHigh: number;
    breakoutLow: number;
}

const isInsideBar = (inner: Kline, outer: Kline): boolean =>
    inner.high <= outer.high && inner.low >= outer.low;

/**
 * Wick-inclusive inside-bar clusters over the most recent bars, most recent
 * first (up to `max`): ii (bar inside bar), iii (three nested), ioi (inside,
 * outside, inside). Breakout triggers sit one tick beyond the reference bar's
 * extremes (the outer bar for ii/iii, the outside bar for ioi).
 */
export const insideClusters = (candles: Kline[], tickSize = 0, max = 3): InsideClusterRead[] => {
    const out: InsideClusterRead[] = [];
    const tick = tickSize > 0 ? tickSize : 0;
    for (let i = candles.length - 1; i >= 3 && out.length < max; i--) {
        const c0 = candles[i - 3];
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];
        if (isInsideBar(c3, c2) && isInsideBar(c2, c1) && isInsideBar(c1, c0)) {
            out.push({
                kind: 'iii',
                indices: [i - 2, i - 1, i],
                breakoutHigh: Number((c1.high + tick).toFixed(8)),
                breakoutLow: Number((c1.low - tick).toFixed(8)),
            });
            continue;
        }
        if (i === candles.length - 1 && isInsideBar(c3, c2) && isInsideBar(c2, c1) && !isInsideBar(c1, c0)) {
            out.push({
                kind: 'ii',
                indices: [i - 1, i],
                breakoutHigh: Number((c2.high + tick).toFixed(8)),
                breakoutLow: Number((c2.low - tick).toFixed(8)),
            });
            continue;
        }
        if (isInsideBar(c2, c1) && isInsideBar(c1, c0) && !(c3.high <= c2.high && c3.low >= c2.low)) {
            out.push({
                kind: 'ii',
                indices: [i - 2, i - 1],
                breakoutHigh: Number((c1.high + tick).toFixed(8)),
                breakoutLow: Number((c1.low - tick).toFixed(8)),
            });
            continue;
        }
        if (isInsideBar(c1, c0) && c2.high >= c1.high && c2.low <= c1.low && isInsideBar(c3, c2)) {
            out.push({
                kind: 'ioi',
                indices: [i - 2, i - 1, i],
                breakoutHigh: Number((c2.high + tick).toFixed(8)),
                breakoutLow: Number((c2.low - tick).toFixed(8)),
            });
        }
    }
    return out;
};
