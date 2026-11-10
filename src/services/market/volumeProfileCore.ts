/**
 * volumeProfileCore — session-grade volume profile, pure math.
 *
 * Everything here works on CLOSED candles the caller has already filtered to
 * the anchor window. Volume is distributed across price bins by the fraction
 * of each candle's range a bin covers (the standard candle approximation —
 * true footprint needs aggTrades, which this harness does not fetch). Ties
 * resolve to the LOWER price bin: deterministic, and stated in the output
 * rather than hidden.
 *
 * The coarse packet-level profile (`TechnicalAnalysisService.calculateVolumeProfile`)
 * stays where it is — this module is the tool-grade read (anchors, buy/sell
 * split, developing POC, naked POCs, ATR distances).
 */

import type { Kline } from '../../types/message';

export interface ProfileBin {
    /** Lower edge of the bin (price). */
    priceLow: number;
    priceHigh: number;
    volume: number;
    /** Taker-buy volume inside the bin; present only when every contributing
     *  candle carried `takerBuyVolume`. */
    buyVolume?: number;
}

export interface ProfileNode {
    price: number;
    volume: number;
}

export interface VolumeProfileRead {
    bins: ProfileBin[];
    poc: number;
    valueAreaHigh: number;
    valueAreaLow: number;
    /** Contiguous high-volume nodes, strongest first (≤3). */
    hvn: ProfileNode[];
    /** Interior low-volume valleys, weakest first (≤3). */
    lvn: ProfileNode[];
    /** POC of the first half vs the whole window — the developing read. */
    developingPoc: { early: number; now: number; migration: 'up' | 'down' | 'flat' } | null;
    totalVolume: number;
    /** True when every candle carried `takerBuyVolume`, so bin buy/sell is measured. */
    buySellKnown: boolean;
}

/** 6 significant digits — display rounding that survives both a six-figure
 *  instrument and a sub-cent one (a fixed 2-dp floor would not). */
const sig6 = (v: number): number => Number(v.toPrecision(6));

/**
 * Build the profile for one anchor window. `bins` is the resolution; the
 * default (48) keeps a session profile readable inside a tool budget.
 */
export const buildVolumeProfile = (
    candles: Kline[],
    options: { bins?: number } = {},
): VolumeProfileRead | null => {
    if (candles.length < 5) return null;
    const binCount = Math.max(8, Math.min(options.bins ?? 48, 200));

    // Loop, not spread: the chart calls this on every pan frame, and a
    // spread over a multi-thousand-bar window both allocates an args array
    // per call and hits the engine's argument-count limit far below what a
    // year of 1m bars weighs.
    let min = Infinity;
    let max = -Infinity;
    for (const c of candles) {
        if (c.low < min) min = c.low;
        if (c.high > max) max = c.high;
    }
    if (!(max > min)) return null; // degenerate: every trade at one price

    const binHeight = (max - min) / binCount;
    const vols = new Array<number>(binCount).fill(0);
    const buys = new Array<number>(binCount).fill(0);
    const buyKnown = candles.every(c => typeof c.takerBuyVolume === 'number' && c.takerBuyVolume >= 0);

    for (const c of candles) {
        const span = c.high - c.low;
        const buy = buyKnown ? (c.takerBuyVolume as number) : 0;
        if (span <= 0) {
            const idx = binIndexFor(min, binHeight, binCount, c.close);
            vols[idx] += c.volume;
            buys[idx] += buy;
            continue;
        }
        const first = binIndexFor(min, binHeight, binCount, c.low);
        const last = binIndexFor(min, binHeight, binCount, Math.max(c.high - 1e-12, c.low));
        for (let i = first; i <= last; i++) {
            const binLow = min + i * binHeight;
            const binHigh = binLow + binHeight;
            const overlap = Math.min(c.high, binHigh) - Math.max(c.low, binLow);
            if (overlap <= 0) continue;
            const share = overlap / span;
            vols[i] += c.volume * share;
            buys[i] += buy * share;
        }
    }

    let totalVolume = 0;
    for (const v of vols) totalVolume += v;
    if (totalVolume <= 0) return null;

    // POC: argmax, ties to the lower price bin.
    let pocIdx = 0;
    for (let i = 1; i < binCount; i++) {
        if (vols[i] > vols[pocIdx]) pocIdx = i;
    }

    // Value area: expand from the POC to the richer neighbour until ≥70%.
    const target = totalVolume * 0.7;
    let lo = pocIdx;
    let hi = pocIdx;
    let area = vols[pocIdx];
    while (area < target && (lo > 0 || hi < binCount - 1)) {
        const below = lo > 0 ? vols[lo - 1] : -1;
        const above = hi < binCount - 1 ? vols[hi + 1] : -1;
        if (above >= below) { hi += 1; area += vols[hi]; } else { lo -= 1; area += vols[lo]; }
    }

    const bins: ProfileBin[] = vols
        .map((volume, i) => ({
            priceLow: sig6(min + i * binHeight),
            priceHigh: sig6(min + (i + 1) * binHeight),
            volume: Math.round(volume * 100) / 100,
            ...(buyKnown ? { buyVolume: Math.round(buys[i] * 100) / 100 } : {}),
        }))
        .filter(b => b.volume > 0);

    const maxVol = vols[pocIdx];
    const hvn = contiguousRuns(vols, v => v >= maxVol * 0.66)
        .sort((a, b) => peakVolume(vols, b) - peakVolume(vols, a))
        .slice(0, 3)
        .map(run => ({ price: sig6(binMid(min, binHeight, run)), volume: Math.round(peakVolume(vols, run) * 100) / 100 }));

    const lvn = contiguousRuns(vols, v => v <= maxVol * 0.15)
        .filter(run => run.first > 0 && run.last < binCount - 1) // interior only
        .sort((a, b) => peakVolume(vols, a) - peakVolume(vols, b))
        .slice(0, 3)
        .map(run => ({ price: sig6(binMid(min, binHeight, run)), volume: Math.round(peakVolume(vols, run) * 100) / 100 }));

    const half = Math.max(1, Math.floor(candles.length / 2));
    const earlyProfile = prefixPoc(min, binHeight, vols.length, candles.slice(0, half));
    const migration = earlyProfile === null
        ? 'flat'
        : earlyProfile < min + (pocIdx + 0.5) * binHeight - binHeight ? 'up'
            : earlyProfile > min + (pocIdx + 0.5) * binHeight + binHeight ? 'down' : 'flat';

    return {
        bins,
        poc: sig6(min + (pocIdx + 0.5) * binHeight),
        valueAreaHigh: sig6(min + (hi + 1) * binHeight),
        valueAreaLow: sig6(min + lo * binHeight),
        hvn,
        lvn,
        developingPoc: earlyProfile === null ? null : { early: sig6(earlyProfile), now: sig6(min + (pocIdx + 0.5) * binHeight), migration },
        totalVolume: Math.round(totalVolume * 100) / 100,
        buySellKnown: buyKnown,
    };
};

const binIndexFor = (min: number, binHeight: number, binCount: number, price: number): number =>
    Math.max(0, Math.min(binCount - 1, Math.floor((price - min) / binHeight)));

const binMid = (min: number, binHeight: number, run: { first: number; last: number }): number =>
    min + ((run.first + run.last) / 2 + 0.5) * binHeight;

const peakVolume = (vols: number[], run: { first: number; last: number }): number => {
    let peak = 0;
    for (let i = run.first; i <= run.last; i++) peak = Math.max(peak, vols[i]);
    return peak;
};

interface Run { first: number; last: number }

const contiguousRuns = (vols: number[], predicate: (v: number) => boolean): Run[] => {
    const runs: Run[] = [];
    let start = -1;
    for (let i = 0; i <= vols.length; i++) {
        const hit = i < vols.length && predicate(vols[i]);
        if (hit && start < 0) start = i;
        if (!hit && start >= 0) { runs.push({ first: start, last: i - 1 }); start = -1; }
    }
    return runs;
};

const prefixPoc = (min: number, binHeight: number, binCount: number, candles: Kline[]): number | null => {
    if (candles.length === 0) return null;
    const vols = new Array<number>(binCount).fill(0);
    for (const c of candles) {
        const span = c.high - c.low;
        if (span <= 0) { vols[binIndexFor(min, binHeight, binCount, c.close)] += c.volume; continue; }
        const first = binIndexFor(min, binHeight, binCount, c.low);
        const last = binIndexFor(min, binHeight, binCount, Math.max(c.high - 1e-12, c.low));
        for (let i = first; i <= last; i++) {
            const binLow = min + i * binHeight;
            const binHigh = binLow + binHeight;
            const overlap = Math.min(c.high, binHigh) - Math.max(c.low, binLow);
            if (overlap > 0) vols[i] += c.volume * (overlap / span);
        }
    }
    let pocIdx = 0;
    for (let i = 1; i < binCount; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;
    return min + (pocIdx + 0.5) * binHeight;
};

/** Where price sits relative to a built profile: inside/above/below the value
 *  area, with the POC/VAH/VAL distances the caller converts to ATR units. */
export const pricePositionVsValue = (
    profile: Pick<VolumeProfileRead, 'poc' | 'valueAreaHigh' | 'valueAreaLow'>,
    price: number,
): 'above_value' | 'below_value' | 'inside_value' => {
    if (price > profile.valueAreaHigh) return 'above_value';
    if (price < profile.valueAreaLow) return 'below_value';
    return 'inside_value';
};

export interface SessionPoc {
    label: string;
    startMs: number;
    endMs: number;
    poc: number;
    /** Volume-weighted: how dominant the POC bin was (0–1). */
    pocShare: number;
}

/**
 * The POC of each window in `windows`, computed over the candles inside it.
 * Windows with no candles are skipped — a missing session is unavailable,
 * never a zero.
 */
export const sessionPocs = (
    windows: Array<{ label: string; startMs: number; endMs: number }>,
    candles: Kline[],
    bins = 48,
): SessionPoc[] => {
    const out: SessionPoc[] = [];
    for (const w of windows) {
        const inWindow = candles.filter(c => c.time >= w.startMs && c.time < w.endMs);
        if (inWindow.length < 5) continue;
        const profile = buildVolumeProfile(inWindow, { bins });
        if (!profile) continue;
        out.push({
            label: w.label,
            startMs: w.startMs,
            endMs: w.endMs,
            poc: profile.poc,
            pocShare: profile.totalVolume > 0
                ? Math.round(((profile.hvn[0]?.volume ?? 0) / profile.totalVolume) * 100) / 100
                : 0,
        });
    }
    return out;
};

export interface NakedPoc extends SessionPoc {
    /** ATR units from the reference price to the level. */
    distanceAtr: number | null;
}

/**
 * A POC is NAKED when no candle AFTER its session closed window traded
 * through its price (a single touch is a visit — the level has been
 * "used"). Candles must cover the span from each session's end to `asofMs`.
 */
export const nakedPocs = (
    pocs: SessionPoc[],
    candlesAfter: Kline[],
    asofMs: number,
): NakedPoc[] => {
    return pocs
        .filter(p => p.endMs <= asofMs)
        .map(p => {
            const visited = candlesAfter.some(
                c => c.time >= p.endMs && c.low <= p.poc && c.high >= p.poc,
            );
            return { ...p, distanceAtr: null as number | null, visited };
        })
        .filter(p => !p.visited)
        .map(({ visited: _visited, ...rest }) => rest);
};
