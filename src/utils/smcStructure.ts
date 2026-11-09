/**
 * smcStructure — Smart-Money-Concepts structure detectors (Batch 3).
 *
 * Pure functions over Kline[] — no fetches, no LLM, no side effects. All
 * detectors consume COMPLETED candles only (callers pass windows that end
 * before the forming candle, or slice off the last element — each detector
 * treats its input the same way detectLiquiditySweeps treats the
 * [len-2] convention: the last element may be the live candle and is
 * skipped for event detection, but IS used for "price is here now" reads).
 *
 * Everything returns bounded, formatted English lines ready for the hybrid
 * snapshot — the research layer said the models weight concrete structured
 * fields, so each line carries the price, not a vague phrase.
 */

import { Kline } from '../types';
import { atrSeries, lastOf } from '../services/trade/chartIndicators';

/**
 * ATR(14) over completed candles — the standard stop-math yardstick.
 * WILDER's smoothing (α=1/period), from `chartIndicators.atrSeries` — the
 * one series module the chart draws from. This used to be a simple average
 * of the trailing true ranges, which read as a DIFFERENT number than the
 * chart's ATR over the same bars (audit item D1): a stop the desk sized at
 * "1×ATR" and the line the trader saw at "1×ATR" were two distances. The
 * forming candle is still dropped first, and the warm-up still returns 0.
 */
export const atr14 = (klines: Kline[], period = 14): number => {
    const ks = klines.slice(0, -1); // drop the forming candle
    if (ks.length <= period) return 0;
    const atr = lastOf(atrSeries(
        ks.map(k => k.high),
        ks.map(k => k.low),
        ks.map(k => k.close),
        period,
    ));
    return typeof atr === 'number' && Number.isFinite(atr) ? atr : 0;
};

// ─── a) Equal highs/lows (liquidity pools) ───────────────────────────────────

export interface EqualLevels {
    equalHighs: { level: number; touches: number }[];
    equalLows: { level: number; touches: number }[];
    /** Formatted lines, or [] when no pools exist. */
    lines: string[];
}

/**
 * Equal highs/lows within a tolerance band: 2+ swing extremes whose prices
 * differ by ≤ tolPct. These are the resting-liquidity pools sweeps target —
 * buy-side liquidity rests above equal highs, sell-side below equal lows.
 */
export const detectEqualLevels = (
    klines: Kline[],
    lookback = 60,
    tolPct = 0.15,
): EqualLevels => {
    const ks = klines.slice(0, -1).slice(-lookback);
    if (ks.length < 10) return { equalHighs: [], equalLows: [], lines: [] };

    // Swing extremes: local max/min against 2 candles each side. The strict
    // half-inequality on each side is what kills flat runs — an identical-candle
    // stretch must not register every candle as a swing (ties everywhere).
    const highs: { i: number; p: number }[] = [];
    const lows: { i: number; p: number }[] = [];
    for (let i = 2; i < ks.length - 2; i++) {
        const k = ks[i];
        const swingHigh = k.high >= ks[i - 1].high && k.high >= ks[i - 2].high
            && k.high >= ks[i + 1].high && k.high >= ks[i + 2].high
            && (k.high > ks[i - 1].high || k.high > ks[i - 2].high)
            && (k.high > ks[i + 1].high || k.high > ks[i + 2].high);
        const swingLow = k.low <= ks[i - 1].low && k.low <= ks[i - 2].low
            && k.low <= ks[i + 1].low && k.low <= ks[i + 2].low
            && (k.low < ks[i - 1].low || k.low < ks[i - 2].low)
            && (k.low < ks[i + 1].low || k.low < ks[i + 2].low);
        if (swingHigh) highs.push({ i, p: k.high });
        if (swingLow) lows.push({ i, p: k.low });
    }

    const pool = (extremes: { i: number; p: number }[], kind: 'high' | 'low'): { level: number; touches: number }[] => {
        const out: { level: number; touches: number }[] = [];
        const used = new Set<number>();
        // Group swing extremes within tolPct of each other. Equal highs use
        // the cluster max (the level sweeps must exceed); lows the min.
        const band = tolPct / 100;
        for (let a = 0; a < extremes.length; a++) {
            if (used.has(a)) continue;
            const cluster = [extremes[a]];
            for (let b = a + 1; b < extremes.length; b++) {
                if (used.has(b)) continue;
                if (Math.abs(extremes[b].p - extremes[a].p) / extremes[a].p <= band) {
                    cluster.push(extremes[b]);
                    used.add(b);
                }
            }
            if (cluster.length >= 2) {
                const level = kind === 'high'
                    ? Math.max(...cluster.map(c => c.p))
                    : Math.min(...cluster.map(c => c.p));
                out.push({ level, touches: cluster.length });
            }
        }
        return out;
    };

    const equalHighs = pool(highs, 'high');
    const equalLows = pool(lows, 'low');
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    const lines = [
        ...equalHighs.map(h => `EQ HIGHS $${px(h.level)} ×${h.touches} — buy-side liquidity pool above (sweep bait)`),
        ...equalLows.map(l => `EQ LOWS $${px(l.level)} ×${l.touches} — sell-side liquidity pool below (sweep bait)`),
    ];
    return { equalHighs, equalLows, lines };
};

// ─── b) FVG / imbalance ─────────────────────────────────────────────────────

export interface Fvg {
    direction: 'bullish' | 'bearish';
    top: number;
    bottom: number;
    midpoint: number;
    /** Candle index (completed series) where the gap opened. */
    openedAt: number;
    /** True when a later candle has traded back into the gap. */
    mitigated: boolean;
}

export const detectFvg = (
    klines: Kline[],
    lookback = 40,
    maxGaps = 3,
): Fvg[] => {
    const ks = klines.slice(0, -1).slice(-lookback);
    const gaps: Fvg[] = [];
    for (let i = ks.length - 3; i >= 0 && gaps.length < maxGaps; i--) {
        const a = ks[i];
        const b = ks[i + 1];
        const c = ks[i + 2];
        // 3-candle imbalance around the displacement candle b. BULLISH (BISI):
        // the oldest candle's HIGH sits below the newest candle's LOW — price
        // gapped up, leaving a support void at [a.high, c.low]. BEARISH (SIBI):
        // a.low above c.high — a resistance void at [c.high, a.low].
        if (a.high < c.low) {
            const top = c.low;
            const bottom = a.high;
            const mitigated = ks.slice(i + 3).some(k => k.low <= top);
            gaps.push({ direction: 'bullish', top, bottom, midpoint: (top + bottom) / 2, openedAt: i, mitigated });
        } else if (a.low > c.high) {
            const top = a.low;
            const bottom = c.high;
            const mitigated = ks.slice(i + 3).some(k => k.high >= bottom);
            gaps.push({ direction: 'bearish', top, bottom, midpoint: (top + bottom) / 2, openedAt: i, mitigated });
        }
        void b;
    }
    return gaps;
};

export const formatFvgLines = (gaps: Fvg[]): string[] => {
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    return gaps.slice(0, 3).map(g =>
        `${g.direction === 'bullish' ? 'BISI' : 'SIBI'} FVG $${px(g.bottom)}–$${px(g.top)} (CE $${px(g.midpoint)})${g.mitigated ? ' — mitigated' : ' — unmitigated'}`
    );
};

// ─── c) Order blocks ────────────────────────────────────────────────────────

export interface OrderBlock {
    direction: 'bullish' | 'bearish';
    top: number;
    bottom: number;
    /** Candle index (completed series) of the OB candle. */
    index: number;
    /** Displacement range of the leg that confirms the OB, in ATR units. */
    displacementAtr: number;
}

/**
 * Order blocks: the last OPPOSITE candle before a displacement leg —
 * range > k×ATR with a directional close. Bullish OB = last down candle
 * before an up-leg; bearish OB = last up candle before a down-leg.
 * Displacement is measured on the 3-candle leg after the OB candle.
 */
export const detectOrderBlocks = (
    klines: Kline[],
    kAtr = 2,
    lookback = 40,
    maxObs = 2,
): OrderBlock[] => {
    const ks = klines.slice(0, -1).slice(-lookback);
    const atr = atr14(klines);
    if (ks.length < 8 || atr <= 0) return [];
    const obs: OrderBlock[] = [];
    for (let i = ks.length - 5; i >= 0 && obs.length < maxObs; i--) {
        const ob = ks[i];
        const leg = [ks[i + 1], ks[i + 2], ks[i + 3]];
        const legRange = Math.max(...leg.map(k => k.high)) - Math.min(...leg.map(k => k.low));
        const displacementAtr = legRange / atr;
        if (displacementAtr < kAtr) continue;
        const upLeg = leg.every(k => k.close > ks[i].close) && leg[2].close > leg[0].close;
        const downLeg = leg.every(k => k.close < ks[i].close) && leg[2].close < leg[0].close;
        if (ob.close < ob.open && upLeg) {
            obs.push({ direction: 'bullish', top: ob.high, bottom: ob.low, index: i, displacementAtr });
        } else if (ob.close > ob.open && downLeg) {
            obs.push({ direction: 'bearish', top: ob.high, bottom: ob.low, index: i, displacementAtr });
        }
    }
    return obs;
};

export const formatObLines = (obs: OrderBlock[]): string[] => {
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    return obs.map(o =>
        `${o.direction} OB $${px(o.bottom)}–$${px(o.top)} (${o.displacementAtr.toFixed(1)}×ATR displacement leg)`
    );
};

// ─── d) Premium / discount ──────────────────────────────────────────────────

export interface PremiumDiscount {
    rangeHigh: number;
    rangeLow: number;
    equilibrium: number;
    zone: 'premium' | 'discount' | 'equilibrium';
    /** Price position within the dealing range, 0 (low) → 100 (high). */
    positionPct: number;
}

/** Premium/discount over the lookback dealing range — the don't-buy-premium rule.
 *  `currentPrice` (the live price) decides which side of equilibrium price is
 *  on; when omitted the last completed close stands in. */
export const computePremiumDiscount = (
    klines: Kline[],
    lookback = 60,
    currentPrice?: number,
): PremiumDiscount | null => {
    const ks = klines.slice(0, -1).slice(-lookback);
    if (ks.length < 10) return null;
    const rangeHigh = Math.max(...ks.map(k => k.high));
    const rangeLow = Math.min(...ks.map(k => k.low));
    const range = rangeHigh - rangeLow;
    if (range <= 0) return null;
    const price = typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0
        ? currentPrice
        : ks[ks.length - 1].close;
    const equilibrium = (rangeHigh + rangeLow) / 2;
    const positionPct = ((price - rangeLow) / range) * 100;
    const zone: PremiumDiscount['zone'] = positionPct > 60 ? 'premium' : positionPct < 40 ? 'discount' : 'equilibrium';
    return { rangeHigh, rangeLow, equilibrium, zone, positionPct };
};

export const formatPremiumDiscountLine = (pd: PremiumDiscount | null): string => {
    if (!pd) return '';
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    return `Dealing range $${px(pd.rangeLow)}–$${px(pd.rangeHigh)} · price ${pd.positionPct.toFixed(0)}% up the range — ${pd.zone.toUpperCase()} (rule: don't buy premium / sell discount against bias)`;
};

// ─── d2) Premium / discount ACROSS timeframes ───────────────────────────────

export interface MtfPremiumDiscountRow {
    timeframe: string;
    pd: PremiumDiscount;
}

export interface MtfPremiumDiscount {
    /** Only frames whose range could be measured at all. */
    rows: MtfPremiumDiscountRow[];
    premium: string[];
    discount: string[];
    equilibrium: string[];
    /** Frames price has left entirely — >100% or <0% of that dealing range. */
    outside: string[];
    consensus: 'all-premium' | 'all-discount' | 'mixed' | 'none';
    /** Mean position up each measured range. Null when no frame was measurable. */
    averagePositionPct: number | null;
}

/**
 * The same dealing-range read on every frame the caller holds, at once.
 *
 * One frame's premium tells you where price is in that frame. Four frames'
 * premium is the actual question — a 15m discount inside a 1d premium is a
 * different trade than a 15m discount inside a 1d discount, and before this the
 * packet could only ever answer the 4h one. Reuses `computePremiumDiscount`
 * unchanged, so the zone thresholds (60/40) cannot drift between the two paths.
 */
export const premiumDiscountAcross = (
    entries: { timeframe: string; klines: Kline[] }[],
    opts: { lookback?: number; currentPrice?: number } = {},
): MtfPremiumDiscount => {
    const rows: MtfPremiumDiscountRow[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const pd = computePremiumDiscount(e.klines, opts.lookback ?? 60, opts.currentPrice);
        if (pd) rows.push({ timeframe: String(e.timeframe), pd });
    }
    const inZone = (z: PremiumDiscount['zone']): string[] =>
        rows.filter(r => r.pd.zone === z).map(r => r.timeframe);
    const premium = inZone('premium');
    const discount = inZone('discount');
    const equilibrium = inZone('equilibrium');
    const outside = rows
        .filter(r => r.pd.positionPct > 100 || r.pd.positionPct < 0)
        .map(r => r.timeframe);

    let consensus: MtfPremiumDiscount['consensus'] = 'none';
    if (rows.length > 0) {
        if (premium.length === rows.length) consensus = 'all-premium';
        else if (discount.length === rows.length) consensus = 'all-discount';
        else consensus = 'mixed';
    }

    return {
        rows,
        premium,
        discount,
        equilibrium,
        outside,
        consensus,
        averagePositionPct: rows.length > 0
            ? rows.reduce((s, r) => s + r.pd.positionPct, 0) / rows.length
            : null,
    };
};

export const formatMtfPremiumDiscountLine = (read: MtfPremiumDiscount): string => {
    if (read.rows.length === 0) {
        return 'MTF premium/discount: no frame had a measurable dealing range (needs 10+ completed candles).';
    }
    const word = (z: PremiumDiscount['zone']): string => z === 'premium' ? 'PREMIUM' : z === 'discount' ? 'DISCOUNT' : 'EQ';
    const detail = read.rows
        .map(r => `${r.timeframe} ${r.pd.positionPct.toFixed(0)}% ${word(r.pd.zone)}${r.pd.positionPct > 100 ? ' (above range)' : r.pd.positionPct < 0 ? ' (below range)' : ''}`)
        .join(' · ');
    // A POSITION PERCENT, not a price — it must not carry the px() formatter's
    // dollar sign, or the seat reads "mean $55.00%" as a level.
    const eq = read.averagePositionPct === null
        ? ''
        : ` · mean ${read.averagePositionPct.toFixed(0)}% up`;
    return `MTF premium/discount: ${detail} — ${consensusWord(read.consensus)} (${read.premium.length} premium / ${read.discount.length} discount / ${read.equilibrium.length} eq)${eq}`;
};

const consensusWord = (c: MtfPremiumDiscount['consensus']): string =>
    c === 'all-premium' ? 'EVERY FRAME PREMIUM'
        : c === 'all-discount' ? 'EVERY FRAME DISCOUNT'
            : c === 'mixed' ? 'MIXED' : 'NO READ';

// ─── d3) Sweep → reversal ───────────────────────────────────────────────────

export interface SweepReversalLevel {
    price: number;
    label: string;
}

export interface SweepReversal {
    /** The direction the reversal expects: a swept HIGH rolls bearish. */
    side: 'bearish' | 'bullish';
    levelLabel: string;
    level: number;
    /** Furthest wick past the level since the sweep candle. */
    extreme: number;
    status: 'confirmed' | 'developing';
    /** Index into the COMPLETED candles the caller passed. */
    sweepIndex: number;
    confirmIndex: number | null;
    /** Bars spent on this candidate, counting the sweep bar itself. */
    barsElapsed: number;
    reclaimed: boolean;
    structureBroken: boolean;
    /** The structure line price had to close through to confirm. */
    confirmationLevel: number;
    zone: { top: number; bottom: number };
    text: string;
}

export interface SweepReversalOptions {
    /** Minimum wick beyond the level, in ATR units. 0 = any take of the level. */
    minPenetrationAtr?: number;
    /** Prior bars the structure line is drawn over. */
    structureLookback?: number;
    /** Body the confirming candle must show, in ATR units. */
    minDisplacementAtr?: number;
    /** Bars a sweep stays live for before the candidate is dropped. */
    maxBarsToConfirm?: number;
    /** ATR override for short windows or tests; defaults to `atr14`. */
    atr?: number;
    /** Completed candles to replay, newest tail of the window. */
    scanBars?: number;
    /** Cap on returned reads, newest first. */
    maxReads?: number;
}

const SWEEP_DEFAULTS = {
    minPenetrationAtr: 0,
    structureLookback: 3,
    minDisplacementAtr: 0.2,
    maxBarsToConfirm: 12,
    scanBars: 120,
    maxReads: 3,
} as const;

/**
 * Sweep → reclaim → structure break, replayed over a window.
 *
 * `detectLiquiditySweeps` already answers "did the last completed candle take
 * liquidity and reject?" — which is two of the three things a sweep has to do
 * before it is a reversal rather than a wick into nothing. This adds the third:
 * after the level is taken and reclaimed, price must also close through the
 * structure that sat behind it, on a candle with a body. That is the difference
 * between "a high got swept" and "the sweep produced a sell", and it yields a
 * zone (swept level → extreme) with a stated invalidation instead of an event.
 *
 * Stateful by nature, so it is a faithful REPLAY rather than a scan: walk the
 * completed candles forward and carry the candidate. The sweep candle itself is
 * eligible to confirm on the same bar, because one bar can take the level,
 * close back under it and break structure all at once. A candidate that never
 * confirms is dropped at `maxBarsToConfirm` — it is NOT reported as an
 * unconfirmed signal, because a stale sweep line is the thing that gets a seat
 * killed.
 *
 * Needs a volatility yardstick: when `atr14` cannot be measured the displacement
 * test has no scale, so nothing is returned rather than returning candidates
 * whose displacement filter silently passed.
 */
export const detectSweepReversals = (
    klines: Kline[],
    levels: SweepReversalLevel[],
    opts: SweepReversalOptions = {},
): SweepReversal[] => {
    const o = { ...SWEEP_DEFAULTS, ...opts };
    const ks = (Array.isArray(klines) ? klines : []).slice(0, -1); // drop the forming candle
    const candLevels = (Array.isArray(levels) ? levels : [])
        .filter(l => Number.isFinite(l?.price) && l.price > 0);
    if (ks.length < o.structureLookback + 2 || candLevels.length === 0) return [];

    const atr = Number.isFinite(opts.atr) ? (opts.atr as number) : atr14(klines);
    if (!Number.isFinite(atr) || atr <= 0) return [];

    const penetration = o.minPenetrationAtr * atr;
    const minBody = o.minDisplacementAtr * atr;
    const from = Math.max(o.structureLookback, ks.length - o.scanBars);
    const out: SweepReversal[] = [];

    for (const L of candLevels) {
        for (const side of ['bearish', 'bullish'] as const) {
            let state: SweepReversal | null = null;

            for (let i = from; i < ks.length; i++) {
                const b = ks[i];
                if (!b || ![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;

                if (!state) {
                    // The candidate must START from the level. `detectLiquiditySweeps`
                    // hit the same trap and documents it: a candle merely trading
                    // on one side of a level reports "beyond" forever. Here it is
                    // worse, because `levels` is an arbitrary set of pools rather
                    // than the script's one latest swing extreme — so a bearish
                    // sweep of $100 means the bar rose INTO $100 from below it, not
                    // that some older bar happened to print a low under it.
                    const startsFromLevel = side === 'bearish'
                        ? b.open <= L.price
                        : b.open >= L.price;
                    if (!startsFromLevel) continue;
                    const swept = side === 'bearish'
                        ? b.high >= L.price + penetration
                        : b.low <= L.price - penetration;
                    if (!swept) continue;
                    // The structure line is frozen at the sweep bar from the
                    // bars BEFORE it — never from the sweeping candle itself,
                    // which would move the goalposts onto the bar being tested.
                    const prior = ks.slice(i - o.structureLookback, i);
                    if (prior.length < o.structureLookback) continue;
                    const conf = side === 'bearish'
                        ? Math.min(...prior.map(k => k.low))
                        : Math.max(...prior.map(k => k.high));
                    if (!Number.isFinite(conf)) continue;
                    state = {
                        side,
                        levelLabel: L.label,
                        level: L.price,
                        extreme: side === 'bearish' ? b.high : b.low,
                        status: 'developing',
                        sweepIndex: i,
                        confirmIndex: null,
                        barsElapsed: 0,
                        reclaimed: side === 'bearish' ? b.close < L.price : b.close > L.price,
                        structureBroken: false,
                        confirmationLevel: conf,
                        zone: { top: 0, bottom: 0 },
                        text: '',
                    };
                }

                if (!state) continue;
                state.extreme = side === 'bearish'
                    ? Math.max(state.extreme, b.high)
                    : Math.min(state.extreme, b.low);
                state.barsElapsed = i - state.sweepIndex + 1;
                state.reclaimed = state.reclaimed
                    || (side === 'bearish' ? b.close < state.level : b.close > state.level);
                const broke = side === 'bearish'
                    ? b.close < state.confirmationLevel
                    : b.close > state.confirmationLevel;
                const body = Math.abs(b.close - b.open);

                if (state.reclaimed && broke && body >= minBody) {
                    state.status = 'confirmed';
                    state.confirmIndex = i;
                    state.structureBroken = true;
                    state.zone = side === 'bearish'
                        ? { top: state.extreme, bottom: state.level }
                        : { top: state.level, bottom: state.extreme };
                    state.text = formatSweepReversal(state);
                    out.push(state);
                    state = null;
                    continue;
                }
                if (i - state.sweepIndex > o.maxBarsToConfirm) {
                    // Expired, not "developing forever": drop it silently.
                    state = null;
                }
            }

            if (state) {
                state.zone = side === 'bearish'
                    ? { top: state.extreme, bottom: state.level }
                    : { top: state.level, bottom: state.extreme };
                state.text = formatSweepReversal(state);
                out.push(state);
            }
        }
    }

    return out
        .sort((a, b) => b.sweepIndex - a.sweepIndex)
        .slice(0, Math.max(1, o.maxReads));
};

const formatSweepReversal = (r: SweepReversal): string => {
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    const zone = `$${px(Math.min(r.zone.top, r.zone.bottom))}–$${px(Math.max(r.zone.top, r.zone.bottom))}`;
    const invalid = px(r.extreme);
    if (r.status === 'confirmed') {
        return `${r.side.toUpperCase()} sweep-reversal: took ${r.levelLabel} $${px(r.level)} to $${px(r.extreme)}, closed back ${r.side === 'bearish' ? 'under' : 'over'} it and through structure $${px(r.confirmationLevel)} in ${r.barsElapsed} bar(s) — reversal zone ${zone}, invalid beyond $${invalid}`;
    }
    const missing = !r.reclaimed ? 'not reclaimed' : 'structure not broken';
    return `${r.side.toUpperCase()} sweep RECHECK (developing): took ${r.levelLabel} $${px(r.level)} to $${px(r.extreme)}, ${missing} ($${px(r.confirmationLevel)}) after ${r.barsElapsed} bar(s) — zone ${zone}`;
};


// ─── e) Draw on liquidity ───────────────────────────────────────────────────

export interface DolTarget {
    label: string;
    price: number;
    /** T1 = internal (inside-range) pool, T2 = external (range extreme). */
    tier: 'T1' | 'T2';
}

/**
 * Draw on liquidity: nearest UNTESTED PDH/PDL/PWH/PWL + weekly open. Inputs
 * come from the packet's marketContext — pure here so tests can pin levels.
 * "Untested" = current price has not traded through the level since the
 * period opened.
 */
export const buildDolTargets = (
    currentPrice: number,
    levels: { label: string; price: number; tested: boolean }[],
    maxTargets = 4,
): DolTarget[] => {
    const untested = levels
        .filter(l => Number.isFinite(l.price) && l.price > 0 && !l.tested)
        .map(l => ({ ...l, distancePct: Math.abs(l.price - currentPrice) / (currentPrice > 0 ? currentPrice : 1) * 100 }))
        .sort((a, b) => a.distancePct - b.distancePct)
        .slice(0, maxTargets);
    const rangeHigh = Math.max(...untested.map(l => l.price));
    const rangeLow = Math.min(...untested.map(l => l.price));
    return untested.map(l => ({
        label: l.label,
        price: l.price,
        tier: l.price === rangeHigh || l.price === rangeLow ? 'T2' : 'T1',
    }));
};

export const formatDolLines = (targets: DolTarget[], currentPrice: number): string[] => {
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    return targets.map(t => {
        const dist = currentPrice > 0 ? ((t.price - currentPrice) / currentPrice) * 100 : 0;
        return `${t.tier} ${t.label} $${px(t.price)} (${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% away)`;
    });
};

// ─── f) CVD (cumulative volume delta) ───────────────────────────────────────

export interface CvdRead {
    /** Session CVD in base-currency units (taker buys − taker sells). */
    sessionCvd: number;
    trend: 'rising' | 'falling' | 'flat';
    divergences: string[];
}

/**
 * Session CVD from taker-buy volume (Binance kline field 9). Requires the
 * extended Kline — callers that never fetched it get an honest null, not a
 * fabricated zero. Divergence flags: price makes a new session high but CVD
 * doesn't (bearish), or the mirror for lows (bullish).
 */
export const computeSessionCvd = (klines: Kline[]): CvdRead | null => {
    const ks = klines.slice(0, -1);
    if (ks.length < 10 || !ks.every(k => typeof k.takerBuyVolume === 'number')) return null;
    let cvd = 0;
    const series: number[] = [];
    for (const k of ks) {
        cvd += (k.takerBuyVolume ?? 0) - (k.volume - (k.takerBuyVolume ?? 0));
        series.push(cvd);
    }
    const first = series[0];
    const last = series[series.length - 1];
    const quarterIdx = Math.floor(series.length * 0.75);
    const quarterVal = series[quarterIdx];
    const trend: CvdRead['trend'] = Math.abs(last - quarterVal) < Math.abs(quarterVal - first) * 0.1 + 1e-9
        ? 'flat'
        : last > quarterVal
            ? 'rising'
            : 'falling';
    const divergences: string[] = [];
    const highIdx = ks.reduce((best, k, i) => (k.high > ks[best].high ? i : best), 0);
    const lowIdx = ks.reduce((best, k, i) => (k.low < ks[best].low ? i : best), 0);
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    if (highIdx > ks.length * 0.7 && highIdx !== 0) {
        const earlierHighIdx = ks.slice(0, highIdx).reduce((b, k, i) => (k.high > ks[b].high ? i : b), 0);
        if (series[highIdx] < series[earlierHighIdx]) {
            divergences.push(`bearish CVD div: price new high $${px(ks[highIdx].high)} but CVD lower than at $${px(ks[earlierHighIdx].high)}`);
        }
    }
    if (lowIdx > ks.length * 0.7 && lowIdx !== 0) {
        const earlierLowIdx = ks.slice(0, lowIdx).reduce((b, k, i) => (k.low < ks[b].low ? i : b), 0);
        if (series[lowIdx] > series[earlierLowIdx]) {
            divergences.push(`bullish CVD div: price new low $${px(ks[lowIdx].low)} but CVD higher than at $${px(ks[earlierLowIdx].low)}`);
        }
    }
    return { sessionCvd: last, trend, divergences };
};

export const formatCvdLine = (cvd: CvdRead | null): string => {
    if (!cvd) return '';
    const fmtCvd = Math.abs(cvd.sessionCvd) >= 1_000_000
        ? `${(cvd.sessionCvd / 1_000_000).toFixed(1)}M`
        : Math.abs(cvd.sessionCvd) >= 1000
            ? `${(cvd.sessionCvd / 1000).toFixed(1)}k`
            : cvd.sessionCvd.toFixed(0);
    let line = `Session CVD ${cvd.sessionCvd >= 0 ? '+' : ''}${fmtCvd} (${cvd.trend})`;
    if (cvd.divergences.length > 0) line += ` — ${cvd.divergences.join('; ')}`;
    return line;
};

// ─── g) Measured move / AB=CD + range width ────────────────────────────────

export interface MeasuredMove {
    /** Projected target from the AB=CD equivalence. */
    projection: number;
    /** Range width of the leg in ATR units (Wyckoff cause). */
    rangeAtr: number;
    method: 'ab=cd' | 'range-extension';
}

/**
 * Measured-move projection: take the most recent clean impulse leg (swing
 * low → swing high, or high → low), project the same distance from the
 * pullback extreme. Deterministic target-math cross-check — target logic
 * is the weakest link in retail setups and this is a hard number.
 */
export const projectMeasuredMove = (klines: Kline[]): MeasuredMove | null => {
    const ks = klines.slice(0, -1);
    if (ks.length < 12) return null;
    const atr = atr14(klines);
    if (atr <= 0) return null;
    // Walk back to find the last pivot: the most recent candle whose extreme
    // is a 3-candle swing against the current close direction.
    const swingHighIdx = (() => {
        for (let i = ks.length - 3; i >= 3; i--) {
            if (ks[i].high > ks[i - 1].high && ks[i].high > ks[i - 2].high
                && ks[i].high >= ks[i + 1]?.high && ks[i].high >= ks[i + 2]?.high) return i;
        }
        return -1;
    })();
    const swingLowIdx = (() => {
        for (let i = ks.length - 3; i >= 3; i--) {
            if (ks[i].low < ks[i - 1].low && ks[i].low < ks[i - 2].low
                && ks[i].low <= ks[i + 1]?.low && ks[i].low <= ks[i + 2]?.low) return i;
        }
        return -1;
    })();
    if (swingHighIdx < 0 || swingLowIdx < 0) return null;
    // Uptrend leg: low before the high — project from the last low.
    if (swingLowIdx < swingHighIdx) {
        const a = ks[swingLowIdx].low;
        const b = ks[swingHighIdx].high;
        const legRange = b - a;
        if (legRange <= 0) return null;
        // C = the lowest low after the swing high (the pullback).
        const after = ks.slice(swingHighIdx + 1);
        if (after.length < 2) return null;
        const c = Math.min(...after.map(k => k.low));
        if (c <= b) {
            return { projection: c + legRange, rangeAtr: legRange / atr, method: 'ab=cd' };
        }
    }
    // Downtrend leg: high before the low — project down from the last high.
    if (swingHighIdx < swingLowIdx) {
        const b = ks[swingHighIdx].high;
        const a = ks[swingLowIdx].low;
        const legRange = b - a;
        if (legRange <= 0) return null;
        const after = ks.slice(swingLowIdx + 1);
        if (after.length < 2) return null;
        const c = Math.max(...after.map(k => k.high));
        if (c >= a) {
            return { projection: c - legRange, rangeAtr: legRange / atr, method: 'ab=cd' };
        }
    }
    return null;
};

export const formatMeasuredMoveLine = (mm: MeasuredMove | null, currentPrice: number): string => {
    if (!mm) return '';
    const px = (v: number): string => v >= 1000 ? v.toFixed(0) : v.toFixed(2);
    const dist = currentPrice > 0 ? ((mm.projection - currentPrice) / currentPrice) * 100 : 0;
    return `AB=CD measured-move target $${px(mm.projection)} (${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% from spot) · leg width ${mm.rangeAtr.toFixed(1)}×ATR`;
};

// ─── h) Seasonality / session flags ─────────────────────────────────────────

export interface SeasonalityFlags {
    lines: string[];
}

/**
 * Calendar timing flags from the Concretum crypto seasonality research:
 * - Monday-Asia-open window: Sunday ~7pm ET + 24h — the best-evidenced
 *   favorable window in the dataset.
 * - Weekend chop: Sat/Sun (UTC) — historically the worst realized drift.
 * - Pre-open caution: the hour before US equity open (13:00–14:00 UTC),
 *   when crypto tends to whipsaw into the traditional-session handoff.
 */
export const seasonalityFlags = (now: Date = new Date()): SeasonalityFlags => {
    const lines: string[] = [];
    const utcDay = now.getUTCDay();     // 0 Sun … 6 Sat
    const utcHour = now.getUTCHours();
    // Sunday 23:00 UTC ≈ 7pm ET (DST-adjusted ±1h — the window is a band, not a line).
    if (utcDay === 0 && utcHour >= 23) {
        lines.push('Monday-Asia-open window: favorable (Sun ~7pm ET +24h — best-evidenced timing window)');
    } else if (utcDay === 1 && utcHour < 23) {
        lines.push('Monday-Asia-open window: favorable (Sun ~7pm ET +24h — best-evidenced timing window)');
    }
    if (utcDay === 6 || utcDay === 0) {
        lines.push('Weekend chop risk: historically negative realized drift — tighten targets or skip (Concretum)');
    }
    if (utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 14) {
        lines.push('Pre-open caution: 13:00–14:00 UTC (hour before US equity open) — known whipsaw window');
    }
    return { lines };
};

// ─── Stop-vs-ATR sanity check ───────────────────────────────────────────────

/**
 * Stop sanity: distance from entry to SL measured in ATR(14) of the signal
 * timeframe. < 0.5×ATR is noise-tight (normal wiggle will clip it); > 4×ATR
 * is a structure stop far past anything a 1R loss implies. Returns null when
 * the inputs are missing rather than a fabricated verdict.
 */
export const stopVsAtrCheck = (
    entry: number | undefined,
    stopLoss: number | undefined,
    klines: Kline[],
): { stopAtr: number; verdict: 'too-tight' | 'too-wide' | 'ok' } | null => {
    if (typeof entry !== 'number' || typeof stopLoss !== 'number'
        || !Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0 || stopLoss <= 0) return null;
    const atr = atr14(klines);
    if (atr <= 0) return null;
    const stopAtr = Math.abs(entry - stopLoss) / atr;
    const verdict = stopAtr < 0.5 ? 'too-tight' : stopAtr > 4 ? 'too-wide' : 'ok';
    return { stopAtr, verdict };
};

// ─── Aggregate read + snapshot block ───────────────────────────────────────

/** The full SMC read carried on the hybrid packet (all fields optional-safe). */
export interface SmcStructureRead {
    /** 1h equal highs/lows pools — sweep bait levels. */
    equalLevels: EqualLevels;
    /** 1h FVGs, newest first (unmitigated gaps are the actionable ones). */
    fvg: Fvg[];
    /** 1h order blocks confirmed by a displacement leg. */
    orderBlocks: OrderBlock[];
    /** 4h premium/discount dealing-range position. */
    premiumDiscount: PremiumDiscount | null;
    /** Nearest untested PDH/PDL/PWH/PWL + weekly-open draws. */
    dolTargets: DolTarget[];
    /** Session CVD from 1h taker-buy volume (null when field absent). */
    cvd: CvdRead | null;
    /** 1h AB=CD measured-move projection. */
    measuredMove: MeasuredMove | null;
    /** Calendar timing flags (Monday-Asia window, weekend, pre-open). */
    seasonality: SeasonalityFlags;
    /** 1h sweep→reclaim→structure-break reads, newest first. */
    sweepReversals: SweepReversal[];
}

/** Period levels for the DOL read, as provided by the packet's marketContext. */
export interface DolLevelInput {
    label: string;
    price: number;
    /** True when price has already traded through the level this period. */
    tested: boolean;
}

/**
 * Build the full SMC read from the snapshot's raw pieces. Structure reads run
 * on 1h (the payload's entry/structure timeframe) with premium/discount on 4h
 * for the higher-frame dealing range — the same TF split the rest of the
 * packet uses (bias 4h, structure 1h).
 */
export const buildSmcStructureRead = (parts: {
    klines1h: Kline[];
    klines4h: Kline[];
    currentPrice: number;
    dolLevels: DolLevelInput[];
    now?: Date;
}): SmcStructureRead => {
    const equalLevels = detectEqualLevels(parts.klines1h);
    const dolTargets = buildDolTargets(parts.currentPrice, parts.dolLevels);
    // The pools the sweep-reversal replay watches are the ones this same read
    // just found: internal liquidity (equal highs/lows) and external liquidity
    // (the untested period extremes). No second swing detector, no drift.
    const reversalLevels: SweepReversalLevel[] = [
        ...equalLevels.equalHighs.map(h => ({ price: h.level, label: `EQH ×${h.touches}` })),
        ...equalLevels.equalLows.map(l => ({ price: l.level, label: `EQL ×${l.touches}` })),
        ...dolTargets.map(t => ({ price: t.price, label: t.label })),
    ];
    return {
        equalLevels,
        fvg: detectFvg(parts.klines1h),
        orderBlocks: detectOrderBlocks(parts.klines1h),
        premiumDiscount: computePremiumDiscount(parts.klines4h, 60, parts.currentPrice),
        dolTargets,
        cvd: computeSessionCvd(parts.klines1h),
        measuredMove: projectMeasuredMove(parts.klines1h),
        seasonality: seasonalityFlags(parts.now ?? new Date()),
        sweepReversals: detectSweepReversals(parts.klines1h, reversalLevels),
    };
};

/**
 * Format the SMC block for the hybrid snapshot. Every line is a concrete
 * number (the research layer: models weight structured fields, not vibes).
 * The FVG caveat is mandatory — 60%+ of 30m FVGs go unmitigated same-session,
 * so an FVG is S/R, not a magnet.
 */
export const formatSmcStructureBlock = (read: SmcStructureRead, currentPrice: number): string => {
    const lines: string[] = ['### SMC structure (code-detected)'];
    if (read.equalLevels.lines.length > 0) {
        lines.push(`Liquidity pools: ${read.equalLevels.lines.slice(0, 4).join(' · ')}`);
    } else {
        lines.push('Liquidity pools: no equal highs/lows in the last 60 1h candles.');
    }
    if (read.fvg.length > 0) {
        lines.push(`FVG: ${formatFvgLines(read.fvg).join(' · ')} (caveat: 60%+ of 30m FVGs go unmitigated same-session — treat as S/R, not a magnet; CE = limit-entry midpoint)`);
    } else {
        lines.push('FVG: none open in the last 40 1h candles.');
    }
    if (read.orderBlocks.length > 0) {
        lines.push(`Order blocks: ${formatObLines(read.orderBlocks).join(' · ')}`);
    } else {
        lines.push('Order blocks: no displacement-confirmed OB in the last 40 1h candles.');
    }
    // A missing line here reads as "the detector did not run"; every other
    // detector in this block states its own negative for the same reason.
    lines.push(read.sweepReversals.length > 0
        ? `Sweep reversals: ${read.sweepReversals.map(r => r.text).join(' | ')}`
        : 'Sweep reversals: none — no swept pool has reclaimed AND broken structure behind it yet.');
    const pd = formatPremiumDiscountLine(read.premiumDiscount);
    if (pd) lines.push(pd);
    if (read.dolTargets.length > 0) {
        lines.push(`Draw on liquidity: ${formatDolLines(read.dolTargets, currentPrice).join(' · ')} (T1 = internal pool — partial there; T2 = external — runner)`);
    } else {
        lines.push('Draw on liquidity: no untested period levels remain.');
    }
    const cvd = formatCvdLine(read.cvd);
    if (cvd) lines.push(cvd);
    const mm = formatMeasuredMoveLine(read.measuredMove, currentPrice);
    if (mm) lines.push(mm);
    if (read.seasonality.lines.length > 0) {
        lines.push(`Seasonality: ${read.seasonality.lines.join(' · ')}`);
    }
    return lines.join('\n');
};
