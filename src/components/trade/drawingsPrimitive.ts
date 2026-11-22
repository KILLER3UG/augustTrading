/**
 * drawingsPrimitive — native `lightweight-charts` v5 `ISeriesPrimitive` plugin
 * for zero-lag committed chart drawings (user + AI) and active selection handles.
 *
 * Two pane views keep screenshots clean and pan/zoom frame-locked:
 *  1. Committed Drawings View (`zOrder: 'normal'`): painted directly inside the
 *     main chart pane bitmap via `useBitmapCoordinateSpace` (crisp HiDPI at
 *     1x/1.25x/1.5x/2x) AND captured automatically by `chart.takeScreenshot(false, false)`.
 *  2. Selection Handles View (`zOrder: 'top'`): painted on the top overlay canvas
 *     so selection outlines and drag handles never pollute AI screenshots.
 *
 * Offscreen & future anchors project through `projectTimestampToX` (logical bar
 * index space) so trendlines, rays, channels, and Long/Short position boxes stay
 * rock-solid when panned offscreen or stretched into future whitespace bars.
 */

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesPrimitive,
    ISeriesPrimitiveAxisView,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';
import {
    createDrawingId,
    drawWidthOf,
    FIB_RATIOS,
    type ChartDrawing,
    type DrawPoint,
} from '../../services/trade/chartDrawings';
import type { PaperAccount } from '../../services/paper/paperCore';
import {
    interpolateScalePrice,
    isDrawingVisibleOnTf,
    type EvalCandle,
    type PriceScaleMode,
} from '../../services/trade/chartGeometry';
import {
    computePositionBoxMetrics,
    isPositionBoxKind,
} from '../../services/trade/positionBoxMath';
import {
    handlePointsForDrawing,
    projectTimestampToX,
    type ScreenXY,
} from './drawingHitTest';
import { shapeGeometry } from './drawingGeometry';

export interface DrawingsPrimitiveState {
    userDrawings: ReadonlyArray<ChartDrawing>;
    modelDrawings: ReadonlyArray<ChartDrawing>;
    /** Ephemeral simulation overlay: fed from the paper broker's account,
     *  never persisted into a user or model drawing bucket. */
    paperDrawings: ReadonlyArray<ChartDrawing>;
    selectedId: string | null;
    hoveredId: string | null;
    hidden: boolean;
    activeTf: string;
    barSeconds: number;
    priceScaleMode: PriceScaleMode;
    candles: ReadonlyArray<EvalCandle>;
}

interface ProjectedShape {
    drawing: ChartDrawing;
    origin: 'user' | 'agent';
    pts: ScreenXY[];
    isSelected: boolean;
    isHovered: boolean;
}

const fmtPriceCompact = (p: number): string => {
    if (!Number.isFinite(p)) return '—';
    if (Math.abs(p) >= 1000) return p.toFixed(1);
    if (Math.abs(p) >= 1) return p.toFixed(2);
    return p.toFixed(5);
};

class CommittedDrawingsRenderer implements IPrimitivePaneRenderer {
    private shapes: ProjectedShape[] = [];
    private priceScaleMode: PriceScaleMode = 'normal';
    private priceAtCoord: (y: number) => number | null = () => null;
    private priceToCoord: (p: number) => number | null = () => null;

    setRenderData(
        shapes: ProjectedShape[],
        priceScaleMode: PriceScaleMode,
        priceAtCoord: (y: number) => number | null,
        priceToCoord: (p: number) => number | null,
    ): void {
        this.shapes = shapes;
        this.priceScaleMode = priceScaleMode;
        this.priceAtCoord = priceAtCoord;
        this.priceToCoord = priceToCoord;
    }

    draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
        if (this.shapes.length === 0) return;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, mediaSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
            const plotW = mediaSize.width;
            const plotH = mediaSize.height;
            const sx = (x: number): number => x * hpr;
            const sy = (y: number): number => y * vpr;
            const fontScale = Math.max(1, (hpr + vpr) / 2);

            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.beginPath();
            ctx.rect(0, 0, bitmapSize.width, bitmapSize.height);
            ctx.clip();

            const strokePolyline = (
                pts: ReadonlyArray<ScreenXY>,
                stroke: string,
                lineW: number,
                dash: number[],
            ): void => {
                if (pts.length < 2) return;
                ctx.strokeStyle = stroke;
                ctx.lineWidth = Math.max(1, lineW * fontScale);
                ctx.setLineDash(dash.map(d => d * fontScale));
                ctx.beginPath();
                ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
                for (let i = 1; i < pts.length; i += 1) {
                    ctx.lineTo(sx(pts[i].x), sy(pts[i].y));
                }
                ctx.stroke();
                ctx.setLineDash([]);
            };

            const drawTagChip = (
                x: number,
                y: number,
                text: string,
                fg: string,
                bg: string,
                dashedBorder = false,
            ): void => {
                ctx.font = `600 ${Math.round(9.5 * fontScale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
                const padX = 4 * fontScale;
                const h = 14 * fontScale;
                const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
                const bx = Math.max(2 * hpr, Math.min(bitmapSize.width - w - 2 * hpr, sx(x)));
                const by = Math.max(2 * vpr, Math.min(bitmapSize.height - h - 2 * vpr, sy(y)));
                ctx.fillStyle = bg;
                ctx.fillRect(bx, by, w, h);
                ctx.strokeStyle = dashedBorder ? 'rgba(161, 161, 170, 0.5)' : 'rgba(255, 255, 255, 0.10)';
                ctx.lineWidth = Math.max(1, 0.9 * fontScale);
                if (dashedBorder) {
                    ctx.setLineDash([2.5 * fontScale, 2 * fontScale]);
                }
                ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
                if (dashedBorder) {
                    ctx.setLineDash([]);
                }
                ctx.fillStyle = fg;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, bx + padX, by + h / 2 + 0.5);
                ctx.textBaseline = 'alphabetic';
            };

            for (const item of this.shapes) {
                const { drawing, origin, pts, isHovered } = item;
                if (pts.length === 0) continue;
                const isAgent = origin === 'agent';
                const stroke = drawing.color || '#f4f4f5';
                const baseWidth = drawWidthOf(drawing) + (isHovered ? 0.5 : 0);
                // The dash is a STYLE (selection toolbar) plus the agent's
                // origin marker: an agent shape is dashed regardless, a user
                // shape only when the trader toggled the style.
                const dashed = isAgent || drawing.dash === true;
                const agentDash = dashed ? [6, 4] : [];

                switch (drawing.kind) {
                    case 'hline': {
                        strokePolyline(
                            [{ x: 0, y: pts[0].y }, { x: plotW, y: pts[0].y }],
                            stroke,
                            baseWidth,
                            dashed ? [6, 4] : [],
                        );
                        break;
                    }
                    case 'trend': {
                        strokePolyline(pts, stroke, baseWidth, agentDash);
                        break;
                    }
                    case 'ray': {
                        if (pts.length < 2) break;
                        const [a, b] = pts;
                        const dx = b.x - a.x;
                        if (Math.abs(dx) < 0.001) {
                            strokePolyline([a, { x: a.x, y: b.y >= a.y ? plotH : 0 }], stroke, baseWidth, agentDash);
                        } else {
                            const edgeX = dx >= 0 ? plotW : 0;
                            const slope = (b.y - a.y) / dx;
                            strokePolyline([a, { x: edgeX, y: a.y + slope * (edgeX - a.x) }], stroke, baseWidth, agentDash);
                        }
                        break;
                    }
                    case 'rect': {
                        if (pts.length < 2) break;
                        const [a, b] = pts;
                        const left = sx(Math.min(a.x, b.x));
                        const top = sy(Math.min(a.y, b.y));
                        const rw = sx(Math.abs(b.x - a.x));
                        const rh = sy(Math.abs(b.y - a.y));
                        ctx.fillStyle = isAgent ? `${stroke}16` : `${stroke}22`;
                        ctx.fillRect(left, top, rw, rh);
                        ctx.strokeStyle = stroke;
                        ctx.lineWidth = Math.max(1, baseWidth * fontScale);
                        if (dashed) ctx.setLineDash([6 * fontScale, 4 * fontScale]);
                        ctx.strokeRect(left, top, rw, rh);
                        ctx.setLineDash([]);
                        break;
                    }
                    case 'brush': {
                        strokePolyline(pts, stroke, baseWidth, agentDash);
                        break;
                    }
                    case 'fib': {
                        if (pts.length < 2 || drawing.points.length < 2) break;
                        const [a, b] = pts;
                        const [da, db] = drawing.points;
                        const left = Math.min(a.x, b.x);
                        const right = Math.max(a.x, b.x);
                        ctx.font = `${Math.round(9 * fontScale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
                        for (const ratio of FIB_RATIOS) {
                            // STANDARD convention (shared with the evaluated
                            // fibLevels): the ratio measures the give-back from
                            // the swing END (db) toward the START (da).
                            const lvlPrice = interpolateScalePrice(db.p, da.p, ratio, this.priceScaleMode);
                            const yFromPrice = lvlPrice !== null ? this.priceToCoord(lvlPrice) : null;
                            const y = yFromPrice !== null ? yFromPrice : (b.y + (a.y - b.y) * ratio);
                            const isEdge = ratio === 0 || ratio === 1;
                            strokePolyline(
                                [{ x: left, y }, { x: right, y }],
                                stroke,
                                Math.max(1, Math.min(baseWidth, 2)),
                                dashed ? [5, 4] : (isEdge ? [] : [4, 3]),
                            );
                            const displayPrice = lvlPrice ?? this.priceAtCoord(y);
                            const pxText = displayPrice !== null && Number.isFinite(displayPrice)
                                ? ` ${fmtPriceCompact(displayPrice)}`
                                : '';
                            ctx.fillStyle = stroke;
                            ctx.fillText(
                                `${(ratio * 100).toFixed(1)}%${pxText}`,
                                sx(left + 3),
                                Math.max(10 * vpr, sy(y) - 3 * vpr),
                            );
                        }
                        break;
                    }
                    case 'long_position':
                    case 'short_position': {
                        if (pts.length < 3) break;
                        const [entryPt, slPt, tpPt] = pts;
                        const left = Math.min(entryPt.x, slPt.x, tpPt.x);
                        const right = Math.max(entryPt.x, slPt.x, tpPt.x);
                        const boxW = Math.max(16, right - left);
                        const metrics = computePositionBoxMetrics(drawing.kind, drawing.points);
                        const profitFill = 'rgba(16, 185, 129, 0.16)';
                        const profitStroke = '#10b981';
                        const riskFill = 'rgba(244, 63, 94, 0.16)';
                        const riskStroke = '#f43f5e';

                        // Profit zone (Entry <-> TP)
                        const tpTop = Math.min(entryPt.y, tpPt.y);
                        const tpH = Math.abs(tpPt.y - entryPt.y);
                        ctx.fillStyle = profitFill;
                        ctx.fillRect(sx(left), sy(tpTop), sx(boxW), sy(tpH));

                        // Risk zone (Entry <-> SL)
                        const slTop = Math.min(entryPt.y, slPt.y);
                        const slH = Math.abs(slPt.y - entryPt.y);
                        ctx.fillStyle = riskFill;
                        ctx.fillRect(sx(left), sy(slTop), sx(boxW), sy(slH));

                        // Borders: TP, SL, and Entry divider
                        strokePolyline([{ x: left, y: tpPt.y }, { x: left + boxW, y: tpPt.y }], profitStroke, 1.4, dashed ? [5, 3] : []);
                        strokePolyline([{ x: left, y: slPt.y }, { x: left + boxW, y: slPt.y }], riskStroke, 1.4, dashed ? [5, 3] : []);
                        strokePolyline([{ x: left, y: entryPt.y }, { x: left + boxW, y: entryPt.y }], '#e4e4e7', 1.4, dashed ? [5, 3] : []);

                        // Live R:R stats bar anchored near Entry midline, offset
                        // past the left drag handle — OKX's position-box layout:
                        // a direction pill, then `Target +x% · R:R x · Stop -x%`
                        // on one line, each step separated so nothing overlaps.
                        if (metrics) {
                            const dirLabel = drawing.kind === 'long_position' ? 'LONG' : 'SHORT';
                            const headLabel = drawing.label ? `${drawing.label} · ` : '';
                            const prefix = isAgent ? `AI · ${headLabel}` : headLabel;
                            const stats = `Target +${metrics.rewardPct.toFixed(2)}% · R:R ${metrics.formattedRR} · Stop -${metrics.riskPct.toFixed(2)}%`;
                            const full = `${prefix}${dirLabel}  ${stats}`;
                            drawTagChip(
                                left + 10,
                                entryPt.y - 7,
                                full,
                                metrics.inverted ? '#fda4af' : '#f4f4f5',
                                metrics.inverted ? 'rgba(136, 19, 55, 0.90)' : 'rgba(9, 9, 11, 0.90)',
                                dashed,
                            );
                        }
                        break;
                    }
                    case 'channel':
                    case 'arrow':
                    case 'measured_move': {
                        const geo = shapeGeometry(drawing.kind, pts, {
                            plotW,
                            stroke,
                            priceAt: y => this.priceAtCoord(y) ?? NaN,
                        });
                        if (!geo) break;
                        for (const poly of geo.fills) {
                            if (poly.points.length < 3) continue;
                            ctx.beginPath();
                            ctx.moveTo(sx(poly.points[0].x), sy(poly.points[0].y));
                            for (let i = 1; i < poly.points.length; i += 1) {
                                ctx.lineTo(sx(poly.points[i].x), sy(poly.points[i].y));
                            }
                            ctx.closePath();
                            ctx.fillStyle = poly.fill ?? `${stroke}1f`;
                            ctx.fill();
                        }
                        for (const line of geo.lines) {
                            strokePolyline(line, stroke, baseWidth, agentDash);
                        }
                        for (const lbl of geo.labels) {
                            ctx.fillStyle = lbl.color;
                            ctx.font = `${Math.round(9 * fontScale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
                            ctx.fillText(lbl.text, sx(lbl.at.x), sy(lbl.at.y));
                        }
                        break;
                    }
                    case 'text': {
                        const text = drawing.label || 'Note';
                        drawTagChip(
                            pts[0].x + 4,
                            pts[0].y - 16,
                            isAgent ? `AI · ${text}` : text,
                            stroke,
                            'rgba(9, 9, 11, 0.85)',
                            isAgent,
                        );
                        break;
                    }
                }

                // Label / AI badge + anchor price tag (except position boxes / text / fib which render their own)
                if (drawing.kind !== 'text' && drawing.kind !== 'fib' && !isPositionBoxKind(drawing.kind)) {
                    const anchor = pts[0];
                    const labelParts: string[] = [];
                    if (isAgent) labelParts.push('AI');
                    if (drawing.label) labelParts.push(drawing.label);
                    if (labelParts.length > 0) {
                        drawTagChip(
                            anchor.x + 4,
                            anchor.y - 17,
                            labelParts.join(' · '),
                            isAgent ? '#d4d4d8' : stroke,
                            isAgent ? 'rgba(24, 24, 27, 0.88)' : 'rgba(9, 9, 11, 0.78)',
                            isAgent,
                        );
                    }
                    const dp = drawing.points[0]?.p;
                    if (Number.isFinite(dp)) {
                        drawTagChip(
                            anchor.x + 2,
                            anchor.y + 3,
                            fmtPriceCompact(dp),
                            stroke,
                            'rgba(9, 9, 11, 0.65)',
                            false,
                        );
                    }
                }
            }

            ctx.restore();
        });
    }
}

class SelectionHandlesRenderer implements IPrimitivePaneRenderer {
    private selected: ProjectedShape | null = null;
    private hovered: ProjectedShape | null = null;

    setSelected(selected: ProjectedShape | null, hovered: ProjectedShape | null): void {
        this.selected = selected;
        this.hovered = hovered;
    }

    draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void {
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
            const fontScale = Math.max(1, (hpr + vpr) / 2);
            const paintHandles = (item: ProjectedShape | null, mode: 'hover' | 'selected'): void => {
                if (!item || item.pts.length === 0) return;
                const handles = handlePointsForDrawing(item.drawing, item.pts);
                // Selected anchors are crisp hollow circles; a hovered (not
                // selected) shape shows the same anchors dimmer, under a soft
                // halo — the OKX affordance that says "this is grabbable"
                // without painting handles onto every idle shape.
                const r = (mode === 'selected' ? 4.5 : 3.5) * fontScale;
                for (const h of handles) {
                    const hx = h.x * hpr;
                    const hy = h.y * vpr;
                    if (mode === 'hover') {
                        ctx.beginPath();
                        ctx.arc(hx, hy, r + 2.5 * fontScale, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(250, 250, 250, 0.10)';
                        ctx.fill();
                    }
                    ctx.beginPath();
                    ctx.arc(hx, hy, r, 0, Math.PI * 2);
                    ctx.fillStyle = '#09090b';
                    ctx.fill();
                    ctx.lineWidth = Math.max(1.5, (mode === 'selected' ? 1.6 : 1.2) * fontScale);
                    ctx.strokeStyle = mode === 'selected' ? '#fafafa' : '#a1a1aa';
                    ctx.stroke();
                }
            };
            ctx.save();
            if (this.hovered && this.hovered !== this.selected) paintHandles(this.hovered, 'hover');
            paintHandles(this.selected, 'selected');
            ctx.restore();
        });
    }
}

class CommittedDrawingsPaneView implements IPrimitivePaneView {
    private readonly _renderer = new CommittedDrawingsRenderer();
    zOrder(): PrimitivePaneViewZOrder {
        return 'normal';
    }
    renderer(): IPrimitivePaneRenderer {
        return this._renderer;
    }
    update(
        shapes: ProjectedShape[],
        priceScaleMode: PriceScaleMode,
        priceAtCoord: (y: number) => number | null,
        priceToCoord: (p: number) => number | null,
    ): void {
        this._renderer.setRenderData(shapes, priceScaleMode, priceAtCoord, priceToCoord);
    }
}

class SelectionHandlesPaneView implements IPrimitivePaneView {
    private readonly _renderer = new SelectionHandlesRenderer();
    zOrder(): PrimitivePaneViewZOrder {
        return 'top';
    }
    renderer(): IPrimitivePaneRenderer {
        return this._renderer;
    }
    update(selected: ProjectedShape | null, hovered: ProjectedShape | null): void {
        this._renderer.setSelected(selected, hovered);
    }
}

export class ChartDrawingsPrimitive implements ISeriesPrimitive<Time> {
    private attachedParam: SeriesAttachedParameter<Time, SeriesType> | null = null;
    private readonly committedView = new CommittedDrawingsPaneView();
    private readonly selectionView = new SelectionHandlesPaneView();
    private readonly views: readonly IPrimitivePaneView[];
    /** Rebuilt only when the tagged set changes — the library caches axis
     *  views by array reference, so a fresh array every frame would thrash. */
    private axisViewsCache: ISeriesPrimitiveAxisView[] = [];

    private state: DrawingsPrimitiveState = {
        userDrawings: [],
        modelDrawings: [],
        paperDrawings: [],
        selectedId: null,
        hoveredId: null,
        hidden: false,
        activeTf: '15m',
        barSeconds: 900,
        priceScaleMode: 'normal',
        candles: [],
    };

    constructor() {
        this.views = [this.committedView, this.selectionView];
    }

    attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
        this.attachedParam = param;
        this.updateAllViews();
    }

    detached(): void {
        this.attachedParam = null;
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this.views;
    }

    /** Right-axis price tags for the drawing under the pointer or selected —
     *  the OKX/Binance affordance that puts the EXACT price on the scale.
     *  Position boxes tag all three levels (Entry / SL / TP) when touched;
     *  every other kind tags its first anchor. */
    priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
        return this.axisViewsCache;
    }

    private rebuildAxisViews(): void {
        const param = this.attachedParam;
        if (!param || this.state.hidden) {
            this.axisViewsCache = [];
            return;
        }
        const focus = this.state.selectedId ?? this.state.hoveredId;
        if (!focus) {
            this.axisViewsCache = [];
            return;
        }
        const drawing = [...this.state.userDrawings, ...this.state.modelDrawings]
            .find(d => d.id === focus);
        if (!drawing || !isDrawingVisibleOnTf(drawing, this.state.activeTf)) {
            this.axisViewsCache = [];
            return;
        }
        const isAgent = drawing.origin === 'agent';
        const anchorIndexes = isPositionBoxKind(drawing.kind)
            ? [0, 1, 2]
            : [0];
        const views: ISeriesPrimitiveAxisView[] = [];
        for (const idx of anchorIndexes) {
            const pt = drawing.points[idx];
            if (!pt || !Number.isFinite(pt.p)) continue;
            views.push({
                coordinate: () => {
                    const y = param.series.priceToCoordinate(pt.p as never);
                    return y === null || y === undefined || !Number.isFinite(Number(y)) ? -1 : Number(y);
                },
                text: () => {
                    const label = isPositionBoxKind(drawing.kind)
                        ? `${idx === 0 ? 'Entry' : idx === 1 ? 'SL' : 'TP'} ${fmtPriceCompact(pt.p)}`
                        : fmtPriceCompact(pt.p);
                    return drawing.label && !isPositionBoxKind(drawing.kind)
                        ? `${drawing.label} · ${label}`
                        : label;
                },
                textColor: () => {
                    if (!isPositionBoxKind(drawing.kind)) return isAgent ? '#d4d4d8' : '#fafafa';
                    return idx === 2 ? '#6ee7b7' : idx === 1 ? '#fda4af' : '#e4e4e7';
                },
                backColor: () => {
                    if (!isPositionBoxKind(drawing.kind)) return 'rgba(24, 24, 27, 0.92)';
                    return idx === 2 ? 'rgba(6, 78, 59, 0.85)' : idx === 1 ? 'rgba(136, 19, 55, 0.85)' : 'rgba(39, 39, 42, 0.92)';
                },
                tickVisible: () => false,
            });
        }
        this.axisViewsCache = views;
    }

    setState(next: DrawingsPrimitiveState): void {
        this.state = next;
        this.updateAllViews();
        this.rebuildAxisViews();
        this.attachedParam?.requestUpdate();
    }

    private projectPoint(pt: DrawPoint): ScreenXY | null {
        const param = this.attachedParam;
        if (!param) return null;
        const ts = param.chart.timeScale();
        const x = projectTimestampToX(pt.t, this.state.candles, this.state.barSeconds, {
            logicalToCoordinate: l => {
                const c = ts.logicalToCoordinate(l as never);
                return c === null || c === undefined ? null : Number(c);
            },
            coordinateToLogical: px => {
                const l = ts.coordinateToLogical(px as never);
                return l === null || l === undefined ? null : Number(l);
            },
        });
        const yRaw = param.series.priceToCoordinate(pt.p as never);
        if (x === null || yRaw === null || yRaw === undefined) return null;
        const y = Number(yRaw);
        if (!Number.isFinite(y)) return null;
        return { x, y };
    }

    updateAllViews(): void {
        const param = this.attachedParam;
        if (!param || this.state.hidden) {
            this.committedView.update([], this.state.priceScaleMode, () => null, () => null);
            this.selectionView.update(null, null);
            this.rebuildAxisViews();
            return;
        }

        const projected: ProjectedShape[] = [];
        let selectedShape: ProjectedShape | null = null;
        let hoveredShape: ProjectedShape | null = null;

        const appendList = (list: ReadonlyArray<ChartDrawing>, defaultOrigin: 'user' | 'agent'): void => {
            for (const drawing of list) {
                if (!isDrawingVisibleOnTf(drawing, this.state.activeTf)) continue;
                const pts = drawing.points
                    .map(p => this.projectPoint(p))
                    .filter((p): p is ScreenXY => p !== null);
                if (pts.length === 0) continue;
                const origin: 'user' | 'agent' = drawing.origin === 'agent'
                    ? 'agent'
                    : drawing.origin === 'user'
                        ? 'user'
                        : defaultOrigin;
                const item: ProjectedShape = {
                    drawing,
                    origin,
                    pts,
                    isSelected: drawing.id === this.state.selectedId,
                    isHovered: drawing.id === this.state.hoveredId,
                };
                projected.push(item);
                if (item.isSelected) selectedShape = item;
                if (item.isHovered) hoveredShape = item;
            }
        };

        appendList(this.state.userDrawings, 'user');
        appendList(this.state.modelDrawings, 'agent');
        // Paper lines are simulation context, not the trader's work and not a
        // model annotation: render them as solid user-origin shapes so they
        // never claim a model badge or enter the undoable drawing buckets.
        appendList(this.state.paperDrawings, 'user');

        const priceAtCoord = (y: number): number | null => {
            const p = param.series.coordinateToPrice(y as never);
            return p === null || p === undefined || !Number.isFinite(Number(p)) ? null : Number(p);
        };
        const priceToCoord = (p: number): number | null => {
            const y = param.series.priceToCoordinate(p as never);
            return y === null || y === undefined || !Number.isFinite(Number(y)) ? null : Number(y);
        };

        this.committedView.update(projected, this.state.priceScaleMode, priceAtCoord, priceToCoord);
        this.selectionView.update(selectedShape, hoveredShape);
        this.rebuildAxisViews();
    }
}

// ── Paper overlay (pure) ────────────────────────────────────────────────────
// The broker owns the book; this helper only projects it onto chart lines.
// No new DrawKind: a horizontal line already renders everywhere drawings do,
// so the paper overlay rides the existing 'hline' path and its monochrome
// palette. Nothing here writes back to the account or to either drawing list.

const PAPER_ENTRY_COLOR = '#f4f1ea';
const PAPER_TP_COLOR = '#e4e4e7';
const PAPER_LEVEL_COLOR = '#a1a1aa';

/** Build ephemeral horizontal lines for open paper positions and resting
 *  limits. Pure: the account is read-only and the result is safe to hand to
 *  `DrawingsPrimitiveState.paperDrawings` on every account notification. */
export const paperDrawingsFromAccount = (
    account: Pick<PaperAccount, 'positions' | 'pendingOrders'> | null | undefined,
    nowMs: number = Date.now(),
): ChartDrawing[] => {
    if (!account) return [];
    const out: ChartDrawing[] = [];
    const t = nowMs / 1000;
    const add = (price: number, label: string, color: string): void => {
        if (!Number.isFinite(price) || price <= 0) return;
        out.push({
            id: createDrawingId(),
            kind: 'hline',
            points: [{ t, p: price }],
            color,
            createdAt: nowMs,
            label,
        });
    };
    for (const position of account.positions ?? []) {
        add(position.entryPrice, `PAPER ${position.side === 'short' ? 'SHORT' : 'LONG'}`, PAPER_ENTRY_COLOR);
        add(position.stopLoss, 'SL', PAPER_LEVEL_COLOR);
        (position.takeProfits ?? []).forEach((tp, i) => add(tp, `TP${i + 1}`, PAPER_TP_COLOR));
    }
    for (const order of account.pendingOrders ?? []) {
        add(order.limitPrice, 'LIMIT', PAPER_LEVEL_COLOR);
    }
    return out;
};
