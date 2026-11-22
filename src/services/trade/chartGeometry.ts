/**
 * chartGeometry — pure, scale-aware chart geometry evaluator & Tier 0 manifest
 * formatter for full structured model visibility.
 *
 * Zero DOM, zero React, zero network: every calculation here is deterministic
 * and unit-tested via `node:test`.
 *
 * Key invariants:
 *  - Stable monotonic `shortId`s (`#D1`, `#D2`, …) per symbol: deleting `#D1`
 *    never renumbers `#D2`, and the next created shape takes `#D{highWater+1}`.
 *  - Diagonal projections (`trend`, `ray`, `channel`) interpolate in LOGICAL
 *    BAR-INDEX space (matching lightweight-charts' x-axis), with negative
 *    logical-index fallback `(anchor.t - firstCandle.time) / barSeconds` for
 *    HTF anchors predating the loaded candle window and positive step fallback
 *    for future bars.
 *  - Logarithmic scale mode uses `exp(lerp(ln(p1), ln(p2), t))` with a `p > 0`
 *    guard before `Math.log`, matching rendered pixels 1:1.
 *  - HTF drawings created on a higher or equal timeframe remain visible and
 *    evaluated on the active timeframe unless restricted by `visibleOnTfs`.
 *  - Touch counting uses ATR-scaled tolerance `max(0.15 * ATR(14), tickSize)`
 *    rather than a fixed percentage.
 */

import { intervalSeconds, type ChartInterval } from '../../utils/chartIntervals';
import { phtStamp } from '../../utils/timezone';
import type { ChartDrawing, DrawPoint } from './chartDrawings';
import { computePositionBoxMetrics, type PositionBoxMetrics } from './positionBoxMath';

export type PriceScaleMode = 'normal' | 'logarithmic';

export interface EvalCandle {
    /** Candle open time in unix SECONDS (lightweight-charts convention). */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface DrawingEvaluatedAtNow {
    id: string;
    shortId: string;
    kind: ChartDrawing['kind'];
    origin: 'user' | 'agent';
    label?: string;
    createdOnTf: string | null;
    visibleOnActiveTf: boolean;
    /** Projected price at the current bar (last candle or live bar). */
    projectedPrice: number | null;
    /** Bounds for range shapes (`rect`, `channel`, `fib`). */
    bounds?: { upper: number; lower: number };
    /** Concrete Fibonacci retracement prices (linear or log interpolated),
     *  plus continuation extensions (`kind: 'extension'`, labeled so a
     *  1.272 continuation is never mistaken for a retracement ratio). */
    fibLevels?: Array<{ ratio: number; price: number; distanceAtr: number | null; kind: 'retracement' | 'extension' }>;
    /** Canonical R:R & bracket metrics for `long_position` / `short_position`. */
    positionMetrics?: PositionBoxMetrics;
    /** Signed price delta: `projectedPrice - markPrice` (positive = level above mark). */
    distancePrice: number | null;
    /** Signed basis-point delta relative to markPrice. */
    distanceBps: number | null;
    /** Unsigned distance in ATR(14) units (`null` when ATR unavailable). */
    distanceAtr: number | null;
    /** Where the drawing sits relative to live mark price. */
    sideRelativeToMark: 'above' | 'below' | 'inside' | 'at' | 'unknown';
    /** Closed/loaded bars since anchor whose [low, high] touched within ATR tolerance. */
    touchesCount: number;
    /** True when price has drifted far (≥ 2× ATR or fallback 1%) or drawing is ≥ 4h old. */
    stale: boolean;
}

export interface ChartEvaluationContext {
    symbol: string;
    activeTf: string;
    candles: ReadonlyArray<EvalCandle>;
    markPrice: number | null;
    priceScaleMode: PriceScaleMode;
    atr14?: number | null;
    tickSize?: number;
    nowMs?: number;
}

export interface Tier0ManifestInput {
    symbol: string;
    interval: string;
    priceScaleMode: PriceScaleMode;
    revision: string;
    capturedAtMs: number;
    liveMark: number | null;
    formingCandle: EvalCandle | null;
    lastClosedBar: EvalCandle | null;
    atr14: number | null;
    activeStudies: Record<string, number>;
    visibleRange?: {
        priceLow: number;
        priceHigh: number;
        timeLow: number;
        timeHigh: number;
        barsLoaded: number;
        barsVisible: number;
    } | null;
    levels?: ReadonlyArray<{ label: string; price: number }>;
    evaluatedDrawings: ReadonlyArray<DrawingEvaluatedAtNow>;
    plansDescription?: string;
    sessionPlanBlock?: string;
    activeRulesBlock?: string;
    postMortemBrief?: string;
    indexDeltaNote?: string;
    nowMs?: number;
}

// Standard retracement ratios (incl. the 0.705 OTE) — the ratio measures how
// far price has given back from the swing END toward the START, shared with
// activeSwingFib/calculateFibonacciLevels so every surface labels the same
// price the same way.
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1] as const;
// Extensions project the leg PAST its end: start + r × range.
/** Exported so the chart's no-evalCtx drawing description quotes the SAME
 *  extension levels the geometry and the desk tool use. */
export const FIB_EXTENSION_RATIOS = [1.272, 1.618, 2] as const;
const STALE_AGE_MS = 4 * 60 * 60 * 1000;
const STALE_FALLBACK_PCT = 1;
const STALE_ATR_MULTIPLIER = 2.0;
const TOUCH_ATR_MULTIPLIER = 0.15;

// ─── Stable monotonic shortIds per symbol ───────────────────────────────────

const shortIdHighWater = new Map<string, number>();

const parseShortIdNum = (shortId: string | undefined): number => {
    if (!shortId) return 0;
    const m = /^#D(\d+)$/.exec(shortId.trim());
    if (!m) return 0;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

const normSym = (symbol?: string): string => (symbol || 'GLOBAL').trim().toUpperCase() || 'GLOBAL';

/** Advance and return the next monotonic `#D<n>` for a symbol without ever
 *  reusing or renumbering deleted IDs. */
export const allocateDrawingShortId = (
    symbol?: string,
    existing: ReadonlyArray<Pick<ChartDrawing, 'shortId'>> = [],
): string => {
    const key = normSym(symbol);
    let maxNum = shortIdHighWater.get(key) ?? 0;
    for (const d of existing) {
        const n = parseShortIdNum(d.shortId);
        if (n > maxNum) maxNum = n;
    }
    const next = maxNum + 1;
    shortIdHighWater.set(key, next);
    return `#D${next}`;
};

/** Ensure every drawing in a list carries a stable `shortId` (assigning
 *  monotonic IDs only to drawings that lack one, preserving existing IDs). */
export const ensureStableShortIds = <T extends ChartDrawing>(
    drawings: ReadonlyArray<T>,
    symbol?: string,
): T[] => {
    const key = normSym(symbol);
    let maxNum = shortIdHighWater.get(key) ?? 0;
    for (const d of drawings) {
        const n = parseShortIdNum(d.shortId);
        if (n > maxNum) maxNum = n;
    }
    shortIdHighWater.set(key, maxNum);
    let changed = false;
    const out = drawings.map(d => {
        if (parseShortIdNum(d.shortId) > 0) return d;
        changed = true;
        maxNum += 1;
        shortIdHighWater.set(key, maxNum);
        return { ...d, shortId: `#D${maxNum}` };
    });
    return changed ? out : (drawings as T[]);
};

/** Test hook: clear per-symbol shortId high-water marks. */
export const __resetShortIdCountersForTests = (): void => {
    shortIdHighWater.clear();
};

// ─── Timeframe visibility & ATR(14) ─────────────────────────────────────────

const tfSecondsSafe = (tf: string | undefined | null): number | null => {
    if (!tf) return null;
    const trimmed = tf.trim();
    const sec = intervalSeconds(trimmed as ChartInterval);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
};

/** Determine whether a drawing is visible on `activeTf`.
 *  - Explicit `visibleOnTfs` wins when non-empty.
 *  - Otherwise HTF drawings (`createdOnTf >= activeTf`) are visible on LTF
 *    charts; LTF drawings (`createdOnTf < activeTf`) are hidden on HTF charts.
 *  - Legacy drawings without `createdOnTf` stay visible on all timeframes. */
export const isDrawingVisibleOnTf = (
    drawing: Pick<ChartDrawing, 'createdOnTf' | 'visibleOnTfs'>,
    activeTf: string,
): boolean => {
    if (Array.isArray(drawing.visibleOnTfs) && drawing.visibleOnTfs.length > 0) {
        return drawing.visibleOnTfs.includes(activeTf);
    }
    if (!drawing.createdOnTf) return true;
    if (drawing.createdOnTf === activeTf) return true;
    const createdSec = tfSecondsSafe(drawing.createdOnTf);
    const activeSec = tfSecondsSafe(activeTf);
    if (createdSec === null || activeSec === null) return true;
    return createdSec >= activeSec;
};

/** Pure ATR(14) over candles (Wilder smoothing; falls back to SMA over
 *  available true ranges when fewer than 15 bars exist). */
export const computeAtr14 = (candles: ReadonlyArray<Pick<EvalCandle, 'high' | 'low' | 'close'>>): number | null => {
    if (candles.length < 2) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i += 1) {
        const cur = candles[i];
        const prevClose = candles[i - 1].close;
        if (!Number.isFinite(cur.high) || !Number.isFinite(cur.low) || !Number.isFinite(prevClose)) continue;
        const tr = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prevClose),
            Math.abs(cur.low - prevClose),
        );
        if (Number.isFinite(tr) && tr >= 0) trs.push(tr);
    }
    if (trs.length === 0) return null;
    const period = 14;
    if (trs.length <= period) {
        const avg = trs.reduce((s, v) => s + v, 0) / trs.length;
        return avg > 0 ? avg : null;
    }
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i += 1) {
        atr = ((atr * (period - 1)) + trs[i]) / period;
    }
    return Number.isFinite(atr) && atr > 0 ? atr : null;
};

/** ATR-scaled touch tolerance with a strict tick-size floor. */
export const touchToleranceFor = (
    atr14: number | null,
    referencePrice: number,
    tickSize = 0,
): number => {
    const floor = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0;
    if (atr14 !== null && Number.isFinite(atr14) && atr14 > 0) {
        return Math.max(TOUCH_ATR_MULTIPLIER * atr14, floor);
    }
    const pctFallback = Number.isFinite(referencePrice) && referencePrice > 0
        ? referencePrice * 0.0015
        : 0;
    return Math.max(pctFallback, floor);
};

// ─── Scale-aware diagonal projection in logical bar-index space ─────────────

/** Map a unix-second timestamp to a logical bar index on `candles`.
 *  - Inside `[candles[0].time, candles[last].time]`: exact/interpolated bar index.
 *  - Older than `candles[0].time` (pre-window HTF anchor): negative logical index
 *    `(t - first.time) / barSeconds`.
 *  - Newer than `candles[last].time` (future projection): `(n - 1) + (t - last.time) / barSeconds`. */
export const timeToLogicalIndex = (
    t: number,
    candles: ReadonlyArray<Pick<EvalCandle, 'time'>>,
    barSeconds: number,
): number | null => {
    const step = Number.isFinite(barSeconds) && barSeconds > 0 ? barSeconds : 60;
    const n = candles.length;
    if (n === 0) return t / step;
    const first = candles[0].time;
    const last = candles[n - 1].time;
    if (t < first) {
        return (t - first) / step;
    }
    if (t > last) {
        return (n - 1) + (t - last) / step;
    }
    if (n === 1) return 0;
    // Binary search for largest index with candles[lo].time <= t.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (candles[mid].time <= t) lo = mid;
        else hi = mid - 1;
    }
    if (candles[lo].time === t || lo === n - 1) return lo;
    const t0 = candles[lo].time;
    const t1 = candles[lo + 1].time;
    const span = t1 - t0;
    return span > 0 ? lo + (t - t0) / span : lo;
};

/** Interpolate a price between `p1` and `p2` at fraction `u` respecting scale
 *  mode. Guards `p1 > 0 && p2 > 0` before calling `Math.log`. */
export const interpolateScalePrice = (
    p1: number,
    p2: number,
    u: number,
    scaleMode: PriceScaleMode,
): number | null => {
    if (!Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(u)) return null;
    if (scaleMode === 'logarithmic' && p1 > 0 && p2 > 0) {
        const lp1 = Math.log(p1);
        const lp2 = Math.log(p2);
        const out = Math.exp(lp1 + (lp2 - lp1) * u);
        return Number.isFinite(out) ? out : null;
    }
    const out = p1 + (p2 - p1) * u;
    return Number.isFinite(out) ? out : null;
};

/** Project a diagonal segment/ray `(a -> b)` onto `targetLogicalIndex` using
 *  logical bar-index geometry and linear or logarithmic price interpolation. */
export const projectDiagonalPrice = (
    a: DrawPoint,
    b: DrawPoint,
    targetLogicalIndex: number,
    candles: ReadonlyArray<Pick<EvalCandle, 'time'>>,
    barSeconds: number,
    scaleMode: PriceScaleMode = 'normal',
): number | null => {
    const idxA = timeToLogicalIndex(a.t, candles, barSeconds);
    const idxB = timeToLogicalIndex(b.t, candles, barSeconds);
    if (idxA === null || idxB === null) return null;
    const dx = idxB - idxA;
    if (Math.abs(dx) < 1e-9) return null;
    const u = (targetLogicalIndex - idxA) / dx;
    return interpolateScalePrice(a.p, b.p, u, scaleMode);
};

// ─── Single & batch drawing evaluation ──────────────────────────────────────

const round4 = (n: number): number => {
    if (!Number.isFinite(n)) return n;
    if (Math.abs(n) >= 1000) return Math.round(n * 100) / 100;
    if (Math.abs(n) >= 1) return Math.round(n * 10000) / 10000;
    return Number(n.toPrecision(6));
};

const countLevelTouches = (
    candles: ReadonlyArray<EvalCandle>,
    startIdx: number,
    priceAtIndex: (idx: number) => number | null,
    atr14: number | null,
    tickSize: number,
): number => {
    let touches = 0;
    const from = Math.max(0, Math.floor(startIdx));
    for (let i = from; i < candles.length; i += 1) {
        const lvl = priceAtIndex(i);
        if (lvl === null || !Number.isFinite(lvl) || lvl <= 0) continue;
        const tol = touchToleranceFor(atr14, lvl, tickSize);
        const c = candles[i];
        if (c.high >= lvl - tol && c.low <= lvl + tol) {
            touches += 1;
        }
    }
    return touches;
};

export const isDrawingStale = (
    d: ChartDrawing,
    markPrice: number | null,
    atr14: number | null,
    nowMs: number,
): boolean => {
    const ageMs = nowMs - (d.createdAt || nowMs);
    if (ageMs >= STALE_AGE_MS) return true;
    if (d.drawnPrice != null && markPrice != null && Number.isFinite(markPrice) && d.drawnPrice > 0) {
        const drift = Math.abs(markPrice - d.drawnPrice);
        if (atr14 !== null && atr14 > 0) {
            return drift >= STALE_ATR_MULTIPLIER * atr14;
        }
        return (drift / d.drawnPrice) * 100 >= STALE_FALLBACK_PCT;
    }
    return false;
};

/** Evaluate a single drawing at `now` against active timeframe candles, scale
 *  mode, live mark price, and ATR(14). */
export const evaluateDrawingAtNow = (
    drawing: ChartDrawing,
    ctx: ChartEvaluationContext,
): DrawingEvaluatedAtNow => {
    const nowMs = ctx.nowMs ?? Date.now();
    const barSeconds = tfSecondsSafe(ctx.activeTf) ?? 900;
    const candles = ctx.candles;
    const atr = ctx.atr14 !== undefined ? ctx.atr14 : computeAtr14(candles);
    const tickSize = ctx.tickSize ?? 0;
    const mark = ctx.markPrice !== null && Number.isFinite(ctx.markPrice) && ctx.markPrice > 0
        ? ctx.markPrice
        : (candles.length > 0 ? candles[candles.length - 1].close : null);
    const targetIdx = candles.length > 0 ? candles.length - 1 : 0;
    const visibleOnActiveTf = isDrawingVisibleOnTf(drawing, ctx.activeTf);
    const origin: 'user' | 'agent' = drawing.origin === 'agent' ? 'agent' : 'user';
    const shortId = drawing.shortId || '#D?';

    let projectedPrice: number | null = null;
    let bounds: { upper: number; lower: number } | undefined;
    let fibLevels: DrawingEvaluatedAtNow['fibLevels'];
    let positionMetrics: PositionBoxMetrics | undefined;
    let touchesCount = 0;

    const pts = drawing.points ?? [];
    if (pts.length > 0) {
        const firstAnchorIdx = timeToLogicalIndex(pts[0].t, candles, barSeconds) ?? 0;
        switch (drawing.kind) {
            case 'hline':
            case 'text': {
                projectedPrice = pts[0].p;
                if (drawing.kind === 'hline') {
                    const startIdx = Math.max(0, Math.floor(firstAnchorIdx));
                    touchesCount = countLevelTouches(candles, startIdx, () => pts[0].p, atr, tickSize);
                }
                break;
            }
            case 'trend':
            case 'ray':
            case 'channel': {
                if (pts.length >= 2) {
                    const [a, b] = pts;
                    const proj = projectDiagonalPrice(a, b, targetIdx, candles, barSeconds, ctx.priceScaleMode);
                    projectedPrice = proj !== null ? round4(proj) : null;
                    if (drawing.kind === 'channel') {
                        // Parallel channel width mirrors drawingGeometry: default symmetric band
                        // when 2 anchors define the centerline/edge; report upper/lower bounds.
                        const span = Math.abs(b.p - a.p);
                        const halfBand = span * 0.25;
                        if (projectedPrice !== null) {
                            bounds = {
                                upper: round4(projectedPrice + halfBand),
                                lower: round4(Math.max(0, projectedPrice - halfBand)),
                            };
                        }
                    }
                    const minAnchorIdx = Math.min(
                        timeToLogicalIndex(a.t, candles, barSeconds) ?? 0,
                        timeToLogicalIndex(b.t, candles, barSeconds) ?? 0,
                    );
                    const startIdx = Math.max(0, Math.floor(minAnchorIdx));
                    touchesCount = countLevelTouches(
                        candles,
                        startIdx,
                        idx => projectDiagonalPrice(a, b, idx, candles, barSeconds, ctx.priceScaleMode),
                        atr,
                        tickSize,
                    );
                }
                break;
            }
            case 'rect': {
                if (pts.length >= 2) {
                    const upper = Math.max(pts[0].p, pts[1].p);
                    const lower = Math.min(pts[0].p, pts[1].p);
                    bounds = { upper: round4(upper), lower: round4(lower) };
                    const mid = interpolateScalePrice(lower, upper, 0.5, ctx.priceScaleMode);
                    projectedPrice = mid !== null ? round4(mid) : round4((upper + lower) / 2);
                    const minAnchorIdx = Math.min(
                        timeToLogicalIndex(pts[0].t, candles, barSeconds) ?? 0,
                        timeToLogicalIndex(pts[1].t, candles, barSeconds) ?? 0,
                    );
                    const startIdx = Math.max(0, Math.floor(minAnchorIdx));
                    const tol = touchToleranceFor(atr, projectedPrice, tickSize);
                    for (let i = startIdx; i < candles.length; i += 1) {
                        if (candles[i].high >= lower - tol && candles[i].low <= upper + tol) {
                            touchesCount += 1;
                        }
                    }
                }
                break;
            }
            case 'fib': {
                if (pts.length >= 2) {
                    const [a, b] = pts;
                    const upper = Math.max(a.p, b.p);
                    const lower = Math.min(a.p, b.p);
                    bounds = { upper: round4(upper), lower: round4(lower) };
                    // STANDARD retracement geometry, shared with
                    // activeSwingFib/calculateFibonacciLevels: the ratio
                    // measures how far price has given back from the swing END
                    // (b, the newer anchor) toward the START (a) — on a
                    // 100→200 up-swing, 0.382 = 161.8 and 0.618 = 138.2.
                    // Extensions project the leg PAST its end with the SIGNED
                    // range (a down-leg 200→100 extends DOWNWARD: 1.272 =
                    // 72.8), are labeled `extension`, and a level that lands
                    // at or below zero (deep legs × 2.0) is OMITTED — never a
                    // negative price on the chart or in the model's read.
                    fibLevels = [
                        ...FIB_RATIOS.map(ratio => ({
                            ratio,
                            kind: 'retracement' as const,
                            px: interpolateScalePrice(b.p, a.p, ratio, ctx.priceScaleMode),
                            fallback: b.p - (b.p - a.p) * ratio,
                        })),
                        ...FIB_EXTENSION_RATIOS.map(ratio => ({
                            ratio,
                            kind: 'extension' as const,
                            px: interpolateScalePrice(a.p, b.p, ratio, ctx.priceScaleMode),
                            fallback: a.p + (b.p - a.p) * ratio,
                        })),
                    ].map(({ ratio, kind, px, fallback }) => {
                        const price = px !== null ? round4(px) : round4(fallback);
                        return {
                            ratio,
                            kind,
                            price,
                            distanceAtr: mark !== null && atr !== null && atr > 0
                                ? Math.round((Math.abs(price - mark) / atr) * 100) / 100
                                : null,
                        };
                    }).filter(l => l.price > 0);
                    // Nearest fib level to current mark becomes projectedPrice.
                    if (mark !== null && fibLevels.length > 0) {
                        const nearest = fibLevels.reduce((best, cur) =>
                            Math.abs(cur.price - mark) < Math.abs(best.price - mark) ? cur : best,
                        );
                        projectedPrice = nearest.price;
                    } else {
                        projectedPrice = fibLevels[3]?.price ?? round4((upper + lower) / 2);
                    }
                }
                break;
            }
            case 'arrow': {
                projectedPrice = pts[pts.length - 1].p;
                break;
            }
            case 'measured_move': {
                projectedPrice = pts[0].p;
                if (pts.length >= 3) {
                    bounds = {
                        upper: round4(Math.max(pts[0].p, pts[1].p, pts[2].p)),
                        lower: round4(Math.min(pts[0].p, pts[1].p, pts[2].p)),
                    };
                }
                break;
            }
            case 'long_position':
            case 'short_position': {
                if (pts.length >= 3) {
                    const [entryPt, slPt, tpPt] = pts;
                    projectedPrice = round4(entryPt.p);
                    bounds = {
                        upper: round4(Math.max(entryPt.p, slPt.p, tpPt.p)),
                        lower: round4(Math.min(entryPt.p, slPt.p, tpPt.p)),
                    };
                    const computed = computePositionBoxMetrics(drawing.kind, pts);
                    if (computed) positionMetrics = computed;
                    const startIdx = Math.max(0, Math.floor(firstAnchorIdx));
                    touchesCount = countLevelTouches(candles, startIdx, () => entryPt.p, atr, tickSize);
                }
                break;
            }
            case 'brush': {
                projectedPrice = pts[pts.length - 1].p;
                break;
            }
        }
    }

    let distancePrice: number | null = null;
    let distanceBps: number | null = null;
    let distanceAtr: number | null = null;
    let sideRelativeToMark: DrawingEvaluatedAtNow['sideRelativeToMark'] = 'unknown';

    if (mark !== null && projectedPrice !== null && Number.isFinite(projectedPrice)) {
        const tol = touchToleranceFor(atr, mark, tickSize);
        if (bounds && (drawing.kind === 'rect' || drawing.kind === 'channel')) {
            if (mark >= bounds.lower && mark <= bounds.upper) {
                sideRelativeToMark = 'inside';
                distancePrice = 0;
                distanceBps = 0;
                distanceAtr = 0;
            } else {
                const edge = mark > bounds.upper ? bounds.upper : bounds.lower;
                distancePrice = round4(edge - mark);
                distanceBps = Math.round(((edge - mark) / mark) * 10_000 * 10) / 10;
                distanceAtr = atr !== null && atr > 0 ? Math.round((Math.abs(edge - mark) / atr) * 100) / 100 : null;
                sideRelativeToMark = edge > mark ? 'above' : 'below';
            }
        } else {
            const diff = projectedPrice - mark;
            distancePrice = round4(diff);
            distanceBps = Math.round((diff / mark) * 10_000 * 10) / 10;
            distanceAtr = atr !== null && atr > 0 ? Math.round((Math.abs(diff) / atr) * 100) / 100 : null;
            if (Math.abs(diff) <= tol) sideRelativeToMark = 'at';
            else sideRelativeToMark = diff > 0 ? 'above' : 'below';
        }
    }

    return {
        id: drawing.id,
        shortId,
        kind: drawing.kind,
        origin,
        ...(drawing.label ? { label: drawing.label } : {}),
        createdOnTf: drawing.createdOnTf ?? null,
        visibleOnActiveTf,
        projectedPrice,
        ...(bounds ? { bounds } : {}),
        ...(fibLevels ? { fibLevels } : {}),
        ...(positionMetrics ? { positionMetrics } : {}),
        distancePrice,
        distanceBps,
        distanceAtr,
        sideRelativeToMark,
        touchesCount,
        stale: isDrawingStale(drawing, mark, atr, nowMs),
    };
};

/** Evaluate all drawings visible on `ctx.activeTf` (including HTF drawings). */
export const evaluateChartDrawings = (
    drawings: ReadonlyArray<ChartDrawing>,
    ctx: ChartEvaluationContext,
): DrawingEvaluatedAtNow[] => {
    const withIds = ensureStableShortIds(drawings, ctx.symbol);
    return withIds
        .map(d => evaluateDrawingAtNow(d, ctx))
        .filter(ev => ev.visibleOnActiveTf);
};

// ─── Deterministic chart revision hash (FNV-1a) ─────────────────────────────

export const computeChartRevision = (input: {
    symbol: string;
    interval: string;
    priceScaleMode: PriceScaleMode;
    lastClosedBarTime: number | null;
    visibleRange?: { priceLow: number; priceHigh: number; barsVisible: number } | null;
    activeStudies?: Record<string, number>;
    levels?: ReadonlyArray<{ label: string; price: number }>;
    drawings?: ReadonlyArray<ChartDrawing>;
}): string => {
    const canonical = JSON.stringify({
        s: input.symbol.toUpperCase(),
        tf: input.interval,
        sc: input.priceScaleMode,
        cb: input.lastClosedBarTime ?? 0,
        vr: input.visibleRange
            ? [
                Math.round(input.visibleRange.priceLow),
                Math.round(input.visibleRange.priceHigh),
                input.visibleRange.barsVisible,
            ]
            : null,
        st: input.activeStudies
            ? Object.keys(input.activeStudies).sort().map(k => [k, Math.round(input.activeStudies![k] * 100) / 100])
            : [],
        lv: (input.levels ?? []).map(l => [l.label, l.price]),
        dr: (input.drawings ?? []).map(d => [
            d.id,
            d.shortId ?? '',
            d.version ?? 1,
            d.origin ?? 'user',
            d.createdOnTf ?? '',
            d.kind,
            d.label ?? '',
            d.points.map(p => [Math.round(p.t), p.p]),
        ]),
    });
    let hash = 2166136261;
    for (let i = 0; i < canonical.length; i += 1) {
        hash ^= canonical.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `rev-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

// ─── High-signal Tier 0 user-turn manifest ──────────────────────────────────

const fmtPx = (v: number): string => {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return v.toFixed(1);
    if (Math.abs(v) >= 1) return v.toFixed(2);
    return v.toFixed(6);
};

const formatEvalLine = (ev: DrawingEvaluatedAtNow): string => {
    const tfTag = ev.createdOnTf ? ` [${ev.createdOnTf}]` : '';
    const lbl = ev.label ? ` "${ev.label}"` : '';
    const proj = ev.bounds && (ev.kind === 'rect' || ev.kind === 'channel')
        ? `${fmtPx(ev.bounds.lower)}–${fmtPx(ev.bounds.upper)}`
        : (ev.projectedPrice !== null ? fmtPx(ev.projectedPrice) : '—');
    const dist = ev.distanceAtr !== null
        ? `${ev.distanceAtr.toFixed(2)} ATR`
        : (ev.distanceBps !== null ? `${ev.distanceBps > 0 ? '+' : ''}${ev.distanceBps.toFixed(0)} bps` : '');
    const parts = [
        `${ev.shortId} ${ev.kind}${tfTag}${lbl} @ now ${proj}`,
        ev.sideRelativeToMark !== 'unknown' ? `${ev.sideRelativeToMark} mark${dist ? ` (${dist})` : ''}` : '',
        ev.touchesCount > 0 ? `${ev.touchesCount} touch${ev.touchesCount === 1 ? '' : 'es'}` : '',
        ev.stale ? 'STALE' : '',
    ].filter(Boolean);
    if (ev.positionMetrics) {
        const pm = ev.positionMetrics;
        parts.push(`Entry ${fmtPx(pm.entry)} / SL ${fmtPx(pm.stopLoss)} / TP ${fmtPx(pm.takeProfit)} (${pm.formattedRR})`);
    }
    if (ev.fibLevels && ev.fibLevels.length > 0) {
        const keyFibs = ev.fibLevels
            .filter(f => f.ratio === 0.382 || f.ratio === 0.5 || f.ratio === 0.618 || f.ratio === 0.705 || f.ratio === 0.786)
            .map(f => `${(f.ratio * 100).toFixed(1)}%=${fmtPx(f.price)}`)
            .join(', ');
        if (keyFibs) parts.push(`fibs(${keyFibs})`);
    }
    return `- ${parts.join(' · ')}`;
};

/** Build the compact, cache-safe Tier 0 chart manifest injected strictly into
 *  the latest user turn wrapper (never in the system prompt). */
export const formatTier0ChartManifest = (input: Tier0ManifestInput): string => {
    const nowMs = input.nowMs ?? Date.now();
    const ageSec = Math.max(0, Math.floor((nowMs - input.capturedAtMs) / 1000));
    const ageLabel = ageSec < 60
        ? `${ageSec}s old`
        : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s old`;

    const lines: string[] = [
        `[CHART MANIFEST — ${input.symbol} · ${input.interval} · scale ${input.priceScaleMode} · ${input.revision} · ${phtStamp(input.capturedAtMs)} PHT (${ageLabel})]`,
    ];

    const markBits: string[] = [];
    markBits.push(`Live mark: ${input.liveMark !== null ? fmtPx(input.liveMark) : 'unavailable'}`);
    if (input.atr14 !== null && input.atr14 > 0) markBits.push(`ATR(14): ${fmtPx(input.atr14)}`);
    if (input.visibleRange) {
        markBits.push(`Visible: ${fmtPx(input.visibleRange.priceLow)}–${fmtPx(input.visibleRange.priceHigh)} (${input.visibleRange.barsVisible}/${input.visibleRange.barsLoaded} bars)`);
    }
    lines.push(markBits.join(' · '));

    if (input.formingCandle) {
        const c = input.formingCandle;
        lines.push(`Forming ${input.interval} bar (${phtStamp(c.time * 1000)}): O ${fmtPx(c.open)} H ${fmtPx(c.high)} L ${fmtPx(c.low)} C ${fmtPx(c.close)}`);
    }
    if (input.lastClosedBar) {
        const c = input.lastClosedBar;
        lines.push(`Last closed ${input.interval} bar (${phtStamp(c.time * 1000)}): O ${fmtPx(c.open)} H ${fmtPx(c.high)} L ${fmtPx(c.low)} C ${fmtPx(c.close)}`);
    }

    const studyEntries = Object.entries(input.activeStudies).filter(([, v]) => Number.isFinite(v));
    if (studyEntries.length > 0) {
        lines.push(`Active studies: ${studyEntries.map(([k, v]) => `${k} ${fmtPx(v)}`).join(' · ')}`);
    }

    if (input.levels && input.levels.length > 0) {
        lines.push(`Verdict levels: ${input.levels.map(l => `${l.label} ${fmtPx(l.price)}`).join(' · ')}`);
    }

    const userDrawings = input.evaluatedDrawings.filter(d => d.origin === 'user');
    const agentDrawings = input.evaluatedDrawings.filter(d => d.origin === 'agent');
    if (userDrawings.length > 0) {
        lines.push(`User drawings (${userDrawings.length} — evaluate critically; verify against structure/ATR):`);
        for (const d of userDrawings) lines.push(formatEvalLine(d));
    }
    if (agentDrawings.length > 0) {
        lines.push(`AI drawings (${agentDrawings.length}):`);
        for (const d of agentDrawings) lines.push(formatEvalLine(d));
    }
    if (userDrawings.length === 0 && agentDrawings.length === 0) {
        lines.push('Drawings: none on this timeframe.');
    }

    if (input.plansDescription?.trim()) lines.push(input.plansDescription.trim());
    if (input.sessionPlanBlock?.trim()) lines.push(input.sessionPlanBlock.trim());
    if (input.activeRulesBlock?.trim()) lines.push(input.activeRulesBlock.trim());
    if (input.postMortemBrief?.trim()) lines.push(input.postMortemBrief.trim());
    if (input.indexDeltaNote?.trim()) lines.push(input.indexDeltaNote.trim());

    lines.push(`Call get_chart_view(if_revision: "${input.revision}") for full candles/book if needed, or get_market_packet / get_all_timeframes for full MTF + derivatives.`);
    return lines.join('\n');
};
