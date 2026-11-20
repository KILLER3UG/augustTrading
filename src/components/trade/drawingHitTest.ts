/**
 * drawingHitTest — pure screen-space coordinate projection (including offscreen
 * and future whitespace bars), drawing hit-testing (handles + bodies), and
 * 12px OHLC magnet snapping.
 *
 * Kept DOM-free so hit-testing, offscreen logical-index projection, and magnet
 * thresholds are directly unit-tested via `node:test`.
 */

import type { ChartDrawing, DrawPoint } from '../../services/trade/chartDrawings';
import { timeToLogicalIndex, type EvalCandle } from '../../services/trade/chartGeometry';

export interface ScreenXY {
    x: number;
    y: number;
}

export interface DrawingHitResult {
    drawing: ChartDrawing;
    target: 'handle' | 'body';
    handleIndex?: number;
    cursor: string;
}

export interface LogicalScaleAdapter {
    logicalToCoordinate(logical: number): number | null;
    coordinateToLogical(x: number): number | null;
}

export interface MagnetSnapResult {
    snapped: boolean;
    x: number;
    y: number;
    price?: number;
    time?: number;
    field?: 'open' | 'high' | 'low' | 'close';
}

export const DEFAULT_HANDLE_HIT_RADIUS = 9;
export const DEFAULT_BODY_HIT_TOLERANCE = 7;
export const DEFAULT_MAGNET_THRESHOLD_PX = 12;

/** Distance from point `(px, py)` to line segment `(ax, ay) -> (bx, by)`. */
export const distToSegment = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * Project ANY unix-second timestamp `t` to a screen X coordinate via logical
 * bar-index space — including anchors predating `candles[0]` (negative logical
 * index) and anchors extending into future whitespace bars past `candles[last]`.
 *
 * This prevents trendlines, rays, channels, rectangles, and position boxes from
 * disappearing when panned offscreen or stretched into future bars.
 */
export const projectTimestampToX = (
    t: number,
    candles: ReadonlyArray<Pick<EvalCandle, 'time'>>,
    barSeconds: number,
    scale: LogicalScaleAdapter | null | undefined,
): number | null => {
    if (!scale || !Number.isFinite(t)) return null;
    const logical = timeToLogicalIndex(t, candles, barSeconds);
    if (logical === null || !Number.isFinite(logical)) return null;
    const x = scale.logicalToCoordinate(logical);
    return x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : null;
};

/**
 * Convert ANY screen X coordinate (including future whitespace bars or bars
 * before `candles[0]`) into a unix-second timestamp via logical bar-index space.
 */
export const screenXToTimestamp = (
    x: number,
    candles: ReadonlyArray<Pick<EvalCandle, 'time'>>,
    barSeconds: number,
    scale: LogicalScaleAdapter | null | undefined,
): number | null => {
    if (!scale || !Number.isFinite(x)) return null;
    const step = Number.isFinite(barSeconds) && barSeconds > 0 ? barSeconds : 60;
    const logicalRaw = scale.coordinateToLogical(x);
    if (logicalRaw === null || logicalRaw === undefined || !Number.isFinite(Number(logicalRaw))) {
        return null;
    }
    const logical = Number(logicalRaw);
    const n = candles.length;
    if (n === 0) return Math.round(logical * step);
    if (logical <= 0) {
        return Math.round(candles[0].time + logical * step);
    }
    if (logical >= n - 1) {
        return Math.round(candles[n - 1].time + (logical - (n - 1)) * step);
    }
    const lo = Math.floor(logical);
    const hi = Math.min(n - 1, lo + 1);
    const frac = logical - lo;
    return Math.round(candles[lo].time + (candles[hi].time - candles[lo].time) * frac);
};

/** Return the draggable handle points in screen coordinates for a drawing. */
export const handlePointsForDrawing = (
    drawing: ChartDrawing,
    projected: ReadonlyArray<ScreenXY>,
): ScreenXY[] => {
    if (projected.length === 0) return [];
    if (drawing.kind === 'brush') {
        return projected.length >= 2 ? [projected[0], projected[projected.length - 1]] : [projected[0]];
    }
    return [...projected];
};

const hitTestBody = (
    x: number,
    y: number,
    drawing: ChartDrawing,
    pts: ReadonlyArray<ScreenXY>,
    plotW: number,
    plotH: number,
    tol: number,
): boolean => {
    if (pts.length === 0) return false;
    switch (drawing.kind) {
        case 'hline':
            return Math.abs(y - pts[0].y) <= tol;
        case 'text': {
            const labelLen = Math.max(4, (drawing.label || 'Note').length);
            const approxW = Math.min(220, labelLen * 6.8 + 14);
            return x >= pts[0].x - 6 && x <= pts[0].x + approxW + 6
                && y >= pts[0].y - 20 && y <= pts[0].y + 8;
        }
        case 'trend':
        case 'arrow':
            return pts.length >= 2 && distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= tol;
        case 'ray': {
            if (pts.length < 2) return false;
            const [a, b] = pts;
            const dx = b.x - a.x;
            if (Math.abs(dx) < 0.001) {
                return distToSegment(x, y, a.x, a.y, a.x, b.y >= a.y ? plotH : 0) <= tol;
            }
            const dir = dx >= 0 ? 1 : -1;
            const edgeX = dir > 0 ? Math.max(plotW, b.x) : Math.min(0, b.x);
            const slope = (b.y - a.y) / dx;
            const edgeY = a.y + slope * (edgeX - a.x);
            return distToSegment(x, y, a.x, a.y, edgeX, edgeY) <= tol;
        }
        case 'channel': {
            if (pts.length < 2) return false;
            const [a, b] = pts;
            const dx = b.x - a.x;
            if (Math.abs(dx) < 0.001) return distToSegment(x, y, a.x, a.y, b.x, b.y) <= tol;
            const slope = (b.y - a.y) / dx;
            const offset = a.y - b.y;
            const yTop = a.y + slope * (x - 0) - slope * a.x;
            // Match drawingGeometry.channelGeometry: top line passes through a? Wait:
            // channelGeometry uses lineY(x, a.y) = a.y + slope * x. Better: pass through (a.x, a.y).
            const line1Y = a.y + slope * (x - a.x);
            const line2Y = line1Y + offset;
            void yTop;
            if (Math.abs(y - line1Y) <= tol || Math.abs(y - line2Y) <= tol) return true;
            const loY = Math.min(line1Y, line2Y);
            const hiY = Math.max(line1Y, line2Y);
            const minX = Math.min(a.x, b.x) - tol;
            const maxX = Math.max(a.x, b.x) + tol;
            return x >= minX && x <= maxX && y >= loY - tol && y <= hiY + tol;
        }
        case 'rect':
        case 'fib': {
            if (pts.length < 2) return false;
            const [a, b] = pts;
            const left = Math.min(a.x, b.x);
            const right = Math.max(a.x, b.x);
            const top = Math.min(a.y, b.y);
            const bottom = Math.max(a.y, b.y);
            return x >= left - tol && x <= right + tol && y >= top - tol && y <= bottom + tol;
        }
        case 'long_position':
        case 'short_position': {
            if (pts.length < 3) return false;
            const [entry, sl, tp] = pts;
            const left = Math.min(entry.x, sl.x, tp.x);
            const right = Math.max(entry.x, sl.x, tp.x);
            const top = Math.min(entry.y, sl.y, tp.y);
            const bottom = Math.max(entry.y, sl.y, tp.y);
            return x >= left - tol && x <= right + tol && y >= top - tol && y <= bottom + tol;
        }
        case 'measured_move': {
            if (pts.length < 3) return false;
            const [entry, sl, tp] = pts;
            return distToSegment(x, y, entry.x, entry.y, entry.x + 14, sl.y) <= tol
                || distToSegment(x, y, entry.x, entry.y, entry.x + 14, tp.y) <= tol;
        }
        case 'brush': {
            for (let i = 1; i < pts.length; i += 1) {
                if (distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) {
                    return true;
                }
            }
            return false;
        }
        default:
            return false;
    }
};

/**
 * Unified top-down hit-tester:
 *  1. Checks anchor handles of the currently selected drawing FIRST so handles
 *     remain effortlessly grabbable even when overlapping another shape.
 *  2. Walks drawings top-down (last item in array = topmost visual layer) to
 *     match body hits.
 */
export const hitTestDrawings = (
    x: number,
    y: number,
    drawings: ReadonlyArray<ChartDrawing>,
    selectedId: string | null,
    projectPoint: (p: DrawPoint) => ScreenXY | null,
    plotW: number,
    plotH: number,
    opts?: { handleRadius?: number; bodyTolerance?: number },
): DrawingHitResult | null => {
    const handleRadius = opts?.handleRadius ?? DEFAULT_HANDLE_HIT_RADIUS;
    const bodyTol = opts?.bodyTolerance ?? DEFAULT_BODY_HIT_TOLERANCE;

    // 1. Selected drawing handle priority.
    if (selectedId) {
        const selected = drawings.find(d => d.id === selectedId);
        if (selected) {
            const pts = selected.points.map(projectPoint).filter((p): p is ScreenXY => p !== null);
            if (pts.length === selected.points.length) {
                const handles = handlePointsForDrawing(selected, pts);
                for (let h = 0; h < handles.length; h += 1) {
                    if (Math.hypot(x - handles[h].x, y - handles[h].y) <= handleRadius) {
                        const actualIdx = selected.kind === 'brush' && h === 1
                            ? selected.points.length - 1
                            : h;
                        return {
                            drawing: selected,
                            target: 'handle',
                            handleIndex: actualIdx,
                            cursor: 'grab',
                        };
                    }
                }
            }
        }
    }

    // 2. Top-down body hit test.
    for (let i = drawings.length - 1; i >= 0; i -= 1) {
        const d = drawings[i];
        const pts = d.points.map(projectPoint).filter((p): p is ScreenXY => p !== null);
        if (pts.length === 0) continue;
        if (!hitTestBody(x, y, d, pts, plotW, plotH, bodyTol)) continue;
        // A position box's RIGHT EDGE is the duration handle: grabbing it
        // slides SL+TP together in time (prices preserved). It wins over the
        // body drag whenever the pointer is on the edge band.
        if ((d.kind === 'long_position' || d.kind === 'short_position') && pts.length >= 3) {
            const [entry, sl, tp] = pts;
            const right = Math.max(entry.x, sl.x, tp.x);
            const lo = Math.min(sl.y, tp.y);
            const hi = Math.max(sl.y, tp.y);
            if (Math.abs(x - right) <= bodyTol + 2 && y >= lo - bodyTol && y <= hi + bodyTol) {
                return { drawing: d, target: 'handle', handleIndex: 3, cursor: 'ew-resize' };
            }
        }
        return {
            drawing: d,
            target: 'body',
            cursor: d.locked === true ? 'not-allowed' : 'move',
        };
    }

    return null;
};

/**
 * OHLC Magnet Snapper:
 * Snaps screen point `pt` to the nearest candle's O/H/L/C coordinate ONLY when
 * within `thresholdPx` (default 12px) so clicks far from candles stay exact.
 */
export const snapToOhlcMagnet = (
    pt: ScreenXY,
    candles: ReadonlyArray<EvalCandle>,
    projectTimeToX: (time: number) => number | null,
    priceToY: (price: number) => number | null,
    thresholdPx = DEFAULT_MAGNET_THRESHOLD_PX,
): MagnetSnapResult => {
    if (candles.length === 0 || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
        return { snapped: false, x: pt.x, y: pt.y };
    }
    let bestDist = Infinity;
    let best: MagnetSnapResult = { snapped: false, x: pt.x, y: pt.y };

    for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i];
        const cx = projectTimeToX(c.time);
        if (cx === null || Math.abs(cx - pt.x) > thresholdPx * 2.5) continue;
        const fields: Array<['open' | 'high' | 'low' | 'close', number]> = [
            ['open', c.open],
            ['high', c.high],
            ['low', c.low],
            ['close', c.close],
        ];
        for (const [field, price] of fields) {
            const cy = priceToY(price);
            if (cy === null || !Number.isFinite(cy)) continue;
            const dist = Math.hypot(cx - pt.x, cy - pt.y);
            if (dist <= thresholdPx && dist < bestDist) {
                bestDist = dist;
                best = {
                    snapped: true,
                    x: cx,
                    y: cy,
                    price,
                    time: c.time,
                    field,
                };
            }
        }
    }

    return best;
};
