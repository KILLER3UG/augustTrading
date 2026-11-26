/**
 * TradingChart — a LOCAL canvas candlestick chart (lightweight-charts,
 * TradingView's MIT library) fed by the app's own Binance kline fetchers.
 * Deliberately NOT the embed widget: an iframe from s.tradingview.com is
 * blocked inside embedded webviews (and any strict CSP), which made the trade
 * surface look dead. Canvas + same-origin data works everywhere, refreshes on
 * a timer, and lets August draw its OWN verdict levels (Entry/SL/TP) on top
 * of the candles — the chart becomes part of the harness, not a guest.
 *
 * Three surfaces live here:
 *  · The candles: websocket-driven last-bar patching plus a freshness
 *    watchdog — while the feed claims 'live' but no kline arrives within a
 *    few bars' worth of quiet, history is re-synced so a stalled socket can
 *    never freeze the chart silently.
 *  · User drawings (TradingView-style): trendline / horizontal / ray /
 *    rectangle / freehand, drawn on a transparent overlay canvas anchored in
 *    DATA space (bar-time + price), so shapes survive zoom, pan, interval
 *    reloads and restarts (persisted per symbol via chartDrawings). An
 *    eraser, undo and clear complete the toolbar.
 *  · An imperative handle (chartHandle) the parent passes down: capturePng()
 *    composites the chart + the drawing overlay into one PNG (the Chart AI
 *    screenshot button), getSnapshot() returns everything currently on
 *    screen in plain data.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TimeframeBar from './TimeframeBar';
import {
    createChart,
    CandlestickSeries,
    HistogramSeries,
    LineSeries,
    PriceScaleMode as LwcPriceScaleMode,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type SeriesType,
    type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines } from '../../services/analysis/KlineService';
import {
    BellIcon,
    Camera,
    ChevronRight,
    Layers,
    Lock,
    Maximize2,
    MessageSquare,
    Minimize2,
    Redo2,
    RotateCcw,
    Settings,
    Target,
    Trash2,
    Undo2,
    Unlock,
} from '../shared/Icons';
import type { Kline } from '../../services/analysis/MarketDataService';
import { sessionLevelRows, type LevelRow } from '../../services/market/levelsCore';
import { readStructure, type StructureRead } from '../../services/market/swingStructureCore';
import { lastOf } from '../../services/trade/chartIndicators';
import { phtAxisTick } from '../../utils/timezone';
import { toCandles, toVolumes, verdictLevels, VOLUME_UP, VOLUME_DOWN, type ChartLevel } from '../../services/trade/chartData';
import {
    loadSessionDrawingsWithLegacy, createDrawingId, pointsForKind, FIB_RATIOS,
    drawWidthOf, nextDrawWidth, DRAW_WIDTH_DEFAULT,
    CLICK_CLICK_KINDS, CLICK_COMMIT_THRESHOLD_PX,
    type ChartDrawing, type DrawKind, type DrawPoint, type DrawTool, DRAW_COLORS,
} from '../../services/trade/chartDrawings';
import {
    allocateDrawingShortId,
    computeAtr14,
    computeChartRevision,
    ensureStableShortIds,
    type EvalCandle,
    type PriceScaleMode,
} from '../../services/trade/chartGeometry';
import {
    bumpDrawingVersion,
    canRedoDrawing,
    canUndoDrawing,
    clearAgentDrawingsFromHistory,
    countAgentDrawings,
    createDrawingHistory,
    pushDrawingSnapshot,
    redoDrawingState,
    syncDrawingHistoryPresent,
    undoDrawingState,
    type DrawingCommandHistory,
} from '../../services/trade/drawingCommandStack';
import {
    computePositionBoxMetrics,
    isPositionBoxKind,
    seedPositionBoxPoints,
    updatePositionBoxHandle,
} from '../../services/trade/positionBoxMath';
import {
    applyAiLevelDragToProposal,
    buildPositionBoxAuditPrompt,
    classifyAiPlanLevelLabel,
    computePaperHandlePreview,
    computePositionBoxReadout,
    parsePaperHandleId,
    type PaperHandlePreview,
    type PaperHandleTarget,
    type PositionBoxSizing,
} from '../../services/trade/positionHandleCore';
import { getHarnessSettings, subscribeHarnessSettings } from '../../utils/harnessSettings';
import type { PaperAccount } from '../../services/paper/paperCore';
import { renderAnnotatedChartSnapshot, type SnapshotBadge } from '../../services/trade/chartSnapshotAnnotator';
import { drawingsControl } from '../../services/trade/drawingsControl';
import { countHiddenLowerTf } from '../../services/trade/chartGeometry';
import type { LiveKline } from '../../services/trade/futuresStreams';
import type { MessageLevelLines } from '../../services/trade/keyLevels';
import { getActiveUsername } from '../../utils/activeUser';
import {
    CHART_INTERVALS,
    DEFAULT_CHART_INTERVALS,
    intervalSeconds,
    toKlineInterval,
    type ChartInterval,
} from '../../utils/chartIntervals';
import { chartColor } from '../../utils/themeColors';
import { fmtPrice as fmtPriceForChart, fmtUsd as fmtUsdForChart } from '../../utils/formatters';
import { TradeAnalysis } from '../../types';
import { ChartToolRail } from './ChartToolRail';
import { ChartFavoritesBar } from './ChartFavoritesBar';
import { ChartContextMenu } from './ChartContextMenu';
import ChartFrame from '../shared/ChartFrame';
import { ChartObjectTreePopover } from './ChartObjectTreePopover';
import * as watchService from '../../services/trade/watchService';
import * as chatStore from '../../services/trade/chatStore';
import { submitPaperOrder } from '../../services/paper/PaperBrokerService';
import {
    computeMeasureMetrics,
    isEditableKeyboardTarget,
    normalizeFavoriteTools,
    resolveEffectiveMagnetMode,
    resolveMagnetThresholdPx,
    toggleFavoriteTool,
    type DrawingVisibilityScope,
    type MagnetMode,
    type MeasureMetrics,
} from '../../services/trade/chartDeckCore';
import { shapeGeometry } from './drawingGeometry';
import { ChartDrawingsPrimitive, paperDrawingsFromAccount } from './drawingsPrimitive';
import { DrawingInspectorPopover } from './DrawingInspectorPopover';
import {
    hitTestDrawings,
    projectTimestampToX,
    screenXToTimestamp,
    snapToOhlcMagnet,
    type MagnetSnapResult,
    type ScreenXY,
} from './drawingHitTest';
import {
    computeHoveredCandleStyle,
    findCandleIndexByTime,
    stepCandleHoverMap,
} from './candleHoverAnimation';
import {
    createHoverReadout,
    HoverLegend,
    HoverCrossTag,
    PriceAxisPlusButton,
    type HoverBar,
    type HoverReadout,
} from './ChartHoverReadouts';
import {
    atrSeries,
    bollingerSeries,
    emaSeries,
    macdSeries,
    rsiSeries,
    tsiSeries,
    vwapSeries,
    type BollingerSeries,
    type Series,
} from '../../services/trade/chartIndicators';
import { candleDelta } from '../../services/market/orderFlowCore';
import { buildVolumeProfile } from '../../services/market/volumeProfileCore';
import { getPaperAccount, subscribePaperAccount } from '../../services/paper/PaperBrokerService';
import {
    CHART_INDICATOR_LABELS,
    readChartIndicatorSettings,
    subscribeChartIndicatorSettings,
    writeChartIndicatorSettings,
    type ChartIndicatorId,
    type ChartIndicatorSettings,
} from '../../services/trade/chartIndicatorSettings';
import { CHART_INDICATOR_REGISTRY, offerableIndicatorIds } from '../../services/trade/chartIndicatorRegistry';

/**
 * Resolve one of index.css's `@theme` CSS custom properties to a concrete
 * color for the JS-side surfaces that cannot take Tailwind classes:
 * lightweight-charts options and raw canvas fills (deep-dive 2026-09-15 UI
 * finding — "6 hardcoded chart-lib hexes that should read the token once").
 *
 * The implementation now lives in `utils/themeColors` so the dashboards can
 * read the theme without importing this ~200 kB chunk; re-exported here so
 * existing callers (including `TradeView`) are unaffected.
 */
export { chartColor };

/** Chart-internal palette: the semantic ramp, resolved from the theme at
 *  call time (never at module-eval time — in dev the style tag is injected
 *  by JS, so an import-time read could fall back forever). */
const CANDLE_UP = (): string => chartColor('--color-emerald-500', '#22c55e');
const CANDLE_DOWN = (): string => chartColor('--color-rose-500', '#ef4444');
/** The MACD histogram's sign colours — the volume series' own rgba
 *  convention (chartData.VOLUME_UP/DOWN), which a hex token cannot carry an
 *  alpha into. Same two hues, one step more opaque than the volume bars. */
const MACD_HIST_UP = 'rgba(7,181,106,0.55)';
const MACD_HIST_DOWN = 'rgba(247,93,95,0.55)';

// ── The user's chosen timeframe bar (persisted per user, like dock width) ──
const TF_BAR_KEY = 'trade_tf_bar_v1';
const tfBarKey = (): string => `${TF_BAR_KEY}_${getActiveUsername()}`;

export const readTfBarSelection = (): ChartInterval[] => {
    try {
        const raw = localStorage.getItem(tfBarKey());
        if (!raw) return [...DEFAULT_CHART_INTERVALS];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [...DEFAULT_CHART_INTERVALS];
        const valid = parsed.filter((i): i is ChartInterval =>
            typeof i === 'string' && (CHART_INTERVALS as readonly string[]).includes(i));
        return valid.length > 0 ? valid : [...DEFAULT_CHART_INTERVALS];
    } catch { return [...DEFAULT_CHART_INTERVALS]; }
};

export const writeTfBarSelection = (intervals: ChartInterval[]): void => {
    try { localStorage.setItem(tfBarKey(), JSON.stringify(intervals)); } catch { /* private mode */ }
};

const REFRESH_MS = 15_000;
/** While the feed claims live but no kline tick lands within this window,
 *  re-sync history — a silently stalled socket must never freeze the chart. */
const LIVE_STALL_MS = 12_000;
/** Bars the chart loads (and fitContent shows on first paint) — the user
 *  asked for at least 500 candles of visible history; 1000 is the Binance
 *  klines maximum, so the deepest chart stays one round-trip. */
const HISTORY_BARS = 1000;

/** The drawing tools the rail can arm. 'cursor' is the chart's native
 *  pan/zoom; the rest live in chartDrawings (shared with the rail). */
export type { DrawTool } from '../../services/trade/chartDrawings';
export { DRAW_COLORS } from '../../services/trade/chartDrawings';
export type ChartScaleMode = 'normal' | 'logarithmic' | 'percentage';
export type CandleDisplayStyle = 'candles' | 'hollow' | 'line';

/** What the parent can ask the chart for, imperatively. */
export interface ChartHandle {
    /** PNG data URL of the chart + the user's drawings (screenshot tool). */
    capturePng: () => string | null;
    /** Plain-data snapshot of everything currently on the chart. */
    getSnapshot: () => ChartSnapshot | null;
    /** Wipe the USER'S own drawings (the model's 'all' clear lands here —
     *  the model's own shapes live in the parent's state). */
    clearUserDrawings: () => void;
}

export interface ChartSnapshot {
    symbol: string;
    interval: ChartInterval;
    /** Last ≤30 candles (oldest→newest), unix seconds. */
    candles: { time: number; open: number; high: number; low: number; close: number }[];
    markPrice: number | null;
    levels: { label: string; price: number }[];
    drawings: ChartDrawing[];
    /** Shapes the model itself drew via desk tools (not persisted). */
    modelDrawings: ChartDrawing[];
    /**
     * What the user can actually SEE, in data space — the price and time
     * window currently on screen, plus how many bars are loaded.
     *
     * This exists because `repaint()` clips every shape to the plot rect
     * (ctx.rect(0, 0, plotW, plotH)). A price outside the visible scale
     * projects outside that rect and is silently discarded, and a trend whose
     * anchor sits past the visible window never appears at all. The model was
     * told "The user sees it now" with no way to learn otherwise.
     *
     * It is also what makes the model's own instructions checkable: without a
     * visible window, "a swing high from 300 bars ago" is simply not
     * expressible, because there was no bar index or timestamp in the snapshot
     * to name it by.
     *
     * null until the chart has fitted a range.
     */
    visibleRange?: {
        priceLow: number;
        priceHigh: number;
        timeLow: number;
        timeHigh: number;
        /** Bars loaded in the series, vs bars currently visible. */
        barsLoaded: number;
        barsVisible: number;
    } | null;
    /** Active right-axis price scale mode (`normal` or `logarithmic`). */
    priceScaleMode?: PriceScaleMode;
    /** Latest finite readings of active indicator overlays/panes on screen. */
    activeStudies?: Record<string, number>;
    /** Deterministic revision hash of visible chart state + drawings. */
    revision?: string;
    /** Current ATR(14) on the active chart timeframe. */
    atr14?: number | null;
    /** Up to 200 loaded candles (unix seconds) for scale-aware geometry evaluation. */
    evalCandles?: EvalCandle[];
    capturedAt: number;
}

interface TradingChartProps {
    symbol: string;
    interval: ChartInterval;
    onIntervalChange: (interval: ChartInterval) => void;
    /** The drawing scope, REQUIRED. Every chart draws into a session-shaped
     *  bucket (`trade_session_drawings_v1_<user>_<scope>`), so two charts of
     *  one instrument can never silently keep two stores — the bug class
     *  where a shape drawn in the dock went nowhere visible. A chart with no
     *  conversation passes a STABLE scope id ('analyze', 'market', 'dock');
     *  only a real conversation id gives that conversation its own canvas. */
    sessionId: string;
    /** The current verdict (optional): its Entry/SL/TP lines are drawn on the
     *  candles when it belongs to this symbol. */
    verdict?: TradeAnalysis | null;
    /** Optional moving average overlay (SMA20) — cheap context, one line. */
    showSma?: boolean;
    /** Websocket kline stream is up: the initial history load still happens,
     *  but the 15s refresh stops — liveKline drives the last bar instead. */
    live?: boolean;
    liveKline?: LiveKline | null;
    /** Live trade/mark price from the ticker stream — drawn as a dedicated
     *  dashed price line ("mark") that ticks every second, faster than the
     *  built-in last-close line can move while a bar is still open. */
    lastPrice?: number | null;
    /** Futures mark price (markPrice@1s). The dashed line is LABELED 'mark',
     *  so it should BE the mark price: on a quiet perp the last-trade ticker
     *  sits unchanged for minutes while mark keeps streaming, and the line
     *  reads as frozen/not-realtime. Falls back to lastPrice when absent. */
    markPrice?: number | null;
    /** Imperative handle filled in on mount (screenshot + snapshot). */
    chartHandle?: React.MutableRefObject<ChartHandle | null>;
    /** Notifies the parent (→ Chart AI context/desk tools) of drawing edits. */
    onDrawingsChange?: (drawings: ChartDrawing[]) => void;
    /** Shapes the MODEL drew via desk tools (draw_on_chart /
     *  mark_trade_levels) — rendered over the candles like the user's own;
     *  persisted per session+coin by the parent (TradeView), NOT the user's
     *  drawing file, so the two stores never clobber each other. */
    modelDrawings?: ChartDrawing[];
    /** Erasing a MODEL-drawn shape routes removal to the parent's model store
     *  (the eraser deletes whichever kind it lands on). */
    onRemoveModelShape?: (id: string) => void;
    /** Replaces the parent's model-drawn shapes list (used by Clear AI Drawings,
     *  dragging/editing AI shapes, and undo/redo restoration). */
    onReplaceModelDrawings?: (next: ChartDrawing[]) => void;
    /** Key levels the Chart AI dock is currently SHOWING on the chart (from a
     *  message's levels card + its chart toggle). A transient render layer,
     *  NOT a persisted drawing: the dock owns the show/pin/hover state and
     *  pushes the resolved line set here; the chart just paints it (dashed
     *  line + right-gutter tag, dim by default, full when pinned/hovered).
     *  Stamped with the symbol it was drawn for, so a BTC card never paints
     *  on an ETH chart. */
    chatLevels?: MessageLevelLines | null;
    /** Chart-head OHLC/V/OI row data — the fields the removed metrics band
     *  carried (24h high/low/volume/OI/oracle), rendered as the readout row. */
    ohlcvRow?: {
        high24h?: number | null;
        low24h?: number | null;
        volume24h?: number | null;
        oiValue?: number | null;
        oracle?: number | null;
        changePct?: number | null;
    } | null;
    /** Full-Chart Focus mode (`Ctrl+\`) controlled by parent Desk view. */
    chartFocus?: boolean;
    onToggleChartFocus?: () => void;
    /** Price scale mode (`normal` | `logarithmic` | `percentage`) synced with bottom footer. */
    scaleMode?: ChartScaleMode;
    onScaleModeChange?: (mode: ChartScaleMode) => void;
    /** Auto-scale toggle synced with bottom footer. */
    autoScale?: boolean;
    onAutoScaleChange?: (auto: boolean) => void;
    /** Imperative reset-view callback ref for bottom footer Reset button. */
    onResetViewRef?: React.MutableRefObject<(() => void) | null>;
}

/** The chart's own candle row, WITH its weight fields. `series.data()` is not
 *  contractually required to return fields the chart library does not know,
 *  so the volume/taker-buy weights the VWAP and CVD studies read live in THIS
 *  mirror — set at the history load, extended by every live tick, read by the
 *  indicator BUILD/REFRESH. One mirror, never recomputed from the series. */
type ChartRow = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    takerBuyVolume?: number;
};

/** The chart's rows carry `time` in SECONDS (lightweight-charts'
 *  UTCTimestamp), while `Kline.time` is MILLISECONDS (Binance). The desk cores
 *  compare candle times against ms bounds, so this converts — without it
 *  `sessionLevelRows` matches nothing and the chart draws no levels while the
 *  `session_levels` tool happily reports them. `volume` is added explicitly to
 *  keep ONE shape for both. */
const klinesOf = (rows: readonly ChartRow[]): Kline[] =>
    rows.map(c => ({ ...c, time: c.time * 1000, volume: c.volume ?? 0 }));

/** Seconds to the close of the bar that opened at `barTime`, as m:ss. Ticks
 *  itself so a countdown does not re-render the whole chart every second. */
const BarCountdown = ({ barTime, interval }: { barTime: number; interval: ChartInterval }): React.ReactElement => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, []);
    const left = Math.max(0, Math.ceil(barTime + intervalSeconds(interval) - now / 1000));
    return (
        <span
            data-testid="bar-countdown"
            className="rounded-[3px] border border-hairline bg-zinc-900/95 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-zinc-300"
        >
            {`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
        </span>
    );
};

/** The sub-pane studies, in the order OKX stacks them. Fixed, so pane indices
 *  are deterministic and the legend rows can be laid out in the same order. */
const SUB_PANE_ORDER = ['rsi', 'macd', 'tsi', 'cvd'] as const satisfies readonly ChartIndicatorId[];

/** One bar as the legend describes it: OHLC plus the study values at that bar. */
type LegendBar = HoverBar;

const TradingChart: React.FC<TradingChartProps> = ({
    symbol, interval, onIntervalChange, sessionId, verdict, showSma = false, live = false, liveKline,
    lastPrice, markPrice, chartHandle, onDrawingsChange, modelDrawings, onRemoveModelShape,
    onReplaceModelDrawings, chatLevels, ohlcvRow,
    chartFocus = false, onToggleChartFocus,
    scaleMode: controlledScaleMode, onScaleModeChange,
    autoScale: controlledAutoScale, onAutoScaleChange,
    onResetViewRef,
}) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    // The 24h fields are a CROSSHAIR readout (v3): they appear while the
    // pointer is over the plot and leave with it, so the resting chart is the
    // tape and nothing else.
    /** Mirror of `overPlot`, so the per-tick refresh (which runs outside any
     *  hover handler) can tell whether the legend belongs to the crosshair or
     *  to the last bar. Written SYNCHRONOUSLY by the crosshair handler, so a
     *  tick that lands between the pointer event and the next render cannot
     *  steal a legend the pointer is holding. */
    const overPlotRef = useRef(false);
    const [overPlot, setOverPlot] = useState(false);
    overPlotRef.current = overPlot;
    /** The two hot readouts live in their own store + leaves
     *  (`ChartHoverReadouts`): the crosshair fires on every pointer pixel, and
     *  routing those numbers through this component's state re-rendered the
     *  entire chart — every study row, tag, rail and toolbar — per crossing.
     *  The leaves subscribe to one slice each, so a sweep renders two small
     *  components and never this one. */
    const hoverReadout = useMemo<HoverReadout>(() => createHoverReadout(), []);
    useEffect(() => () => hoverReadout.dispose(), [hoverReadout]);
    /** The chart's root `<div>`: `data-hovered-candle` is a data attribute the
     *  snapshot/e2e surface reads, so it is written imperatively (one string
     *  per bar crossed) instead of carrying a legend bar through React. */
    const rootRef = useRef<HTMLDivElement | null>(null);
    const setHoveredCandleAttr = useCallback((time: number | null): void => {
        const el = rootRef.current;
        if (!el) return;
        const next = time === null ? '' : String(time);
        if (el.getAttribute('data-hovered-candle') !== next) el.setAttribute('data-hovered-candle', next);
    }, []);
    /** The study readouts sit behind the legend's expand toggle (owner 1.4.1):
     *  one compact OHLCV line at rest, the wall only when asked for. Session
     *  state — a chart preference re-chosen per session, not persisted data. */
    const [legendExpanded, setLegendExpanded] = useState(false);
    const legendTimeRef = useRef<number | null>(null);
    /** The last-price tag on the axis: price, its screen Y, the bar's open time
     *  (for the countdown) and the bar's direction (for the colour). */
    const [lastTag, setLastTag] = useState<{ y: number; price: number; up: boolean; barTime: number } | null>(null);
    const lastTagRef = useRef<{ y: number; price: number } | null>(null);
    /** The right price-axis gutter, MEASURED, not assumed. The axis is
     *  content-sized (`autoSize`, labels vary — a titled 'mark' label is wider
     *  than a bare number), so a hardcoded 58px put the custom tags and the
     *  band fill's clip under the axis labels. Measured on the same paths
     *  that already touch layout (tag/crosshair updates); the canvas reads the
     *  ref, the DOM tags read the state, and both lag one event at worst. */
    const [axisW, setAxisW] = useState(58);
    const axisWRef = useRef(58);
    const measureAxis = useCallback((): void => {
        const ps = chartRef.current?.priceScale('right') as { width?: () => number } | undefined;
        const w = typeof ps?.width === 'function' ? ps.width() : 58;
        const next = Number.isFinite(w) && w > 0 ? Math.round(w) : 58;
        if (Math.abs(next - axisWRef.current) >= 1) {
            axisWRef.current = next;
            setAxisW(next);
        }
    }, []);
    /** Position the tag. Guarded, so panning within a pixel of the same price
     *  does not re-render the whole chart. */
    const updateLastTag = useCallback((): void => {
        measureAxis();
        const cs = candlesRef.current;
        if (!cs) { setLastTag(null); return; }
        const data = (cs.data?.() ?? []) as readonly { time: number; open: number; close: number }[];
        const last = data[data.length - 1];
        if (!last) { lastTagRef.current = null; setLastTag(null); return; }
        const y = typeof cs.priceToCoordinate === 'function' ? cs.priceToCoordinate(last.close as never) : null;
        if (y === null || y === undefined || !Number.isFinite(Number(y))) { setLastTag(null); return; }
        const prev = lastTagRef.current;
        if (prev && Math.abs(prev.y - Number(y)) < 1 && prev.price === last.close) return;
        lastTagRef.current = { y: Number(y), price: last.close };
        setLastTag({ y: Number(y), price: last.close, up: last.close >= last.open, barTime: last.time });
    }, [measureAxis]);
    const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    /** The main-pane indicator overlays, so the mount cleanup can drop them. */
    const indicatorSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
    /** The Bollinger band, for the shaded fill the overlay canvas paints.
     *  `lightweight-charts` has no band series, so the fill is a polygon
     *  between the upper and lower lines drawn on the same canvas as the
     *  trader's own shapes — which keeps it clipped to the plot and makes it
     *  survive zoom and pan for free. */
    const bandRef = useRef<{ times: number[]; upper: Series; lower: Series } | null>(null);
    /** How to recompute the band from a candle array — REFRESH re-runs it so
     *  the shaded fill tracks the live tape with the lines. */
    const bandCalcRef = useRef<((cs: readonly ChartRow[]) => BollingerSeries) | null>(null);
    /** The candle rows WITH their weight fields (volume, taker-buy) — see the
     *  ChartRow type. The history load fills it, every live tick extends it,
     *  and the indicator BUILD/REFRESH read it instead of `series.data()`. */
    const chartRowsRef = useRef<ChartRow[]>([]);
    /** The anchored-VWAP anchor: the bar TIME the trader Alt+clicked. View
     *  state, not settings — an anchor is a question about THIS chart read,
     *  not a preference. Toggling the study off clears it. */
    const [avwapAnchor, setAvwapAnchor] = useState<number | null>(null);
    const avwapAnchorRef = useRef<number | null>(null);
    /** Every series living on a SUB-pane (RSI / MACD / TSI), so the mount
     *  cleanup can drop them and the rebuild can start from pane 1. */
    const subPaneSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
    /** Session levels and the swing read, painted by `repaint` from the DESK's
     *  cores. Recomputed on every refresh so a tick moves them too. */
    const sessionLevelsRef = useRef<LevelRow[]>([]);
    const swingsRef = useRef<StructureRead | null>(null);
    /** One descriptor per drawn study: its chart series, how to recompute its
     *  values from a candle array (`calc`), and its legend key. The BUILD
     *  effect creates the series once; REFRESH re-runs every `calc` against
     *  the CURRENT candles and pushes the new values into the SAME series —
     *  so the studies track the live tape without the teardown/flicker of a
     *  rebuild per tick. */
    const indicatorDefsRef = useRef<{
        series: ISeriesApi<SeriesType>;
        kind: 'line' | 'hist';
        /** Legend key, when the study has a legend row. */
        name?: string;
        calc: (cs: readonly ChartRow[]) => Series;
    }[]>([]);
    /** Re-run every study compute and push the results into the live series.
     *  `full` (a bar closed, or a settings change) rewrites whole series;
     *  otherwise only each series' LAST point moves, which is exact for every
     *  recursive study — past values cannot change from a forming bar. */
    const refreshIndicatorsRef = useRef<(full: boolean) => void>(() => {});
    /** The bars and the computed studies, so the legend under the crosshair
     *  reads the SAME series the lines are drawn from. */
    const legendRef = useRef<{
        times: number[];
        bars: { open: number; high: number; low: number; close: number }[];
        volumes: Map<number, number>;
        series: Record<string, Series>;
    } | null>(null);
    const levelLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
    /** The chart's own dotted last-price line (the library's is replaced). */
    const lastLineRef = useRef<IPriceLine | null>(null);
    /** Key-level lines the DOCK pushed (message card + chart toggle) — id →
     *  price line, diffed on every push. Transient view state, never saved. */
    const chatLevelLinesRef = useRef<Map<string, IPriceLine>>(new Map());
    const [status, setStatus] = useState<'loading' | 'live' | 'unavailable'>('loading');
    /** The load effect's manual-retry handle: the error overlay's Retry tap
     *  re-runs the SAME guarded load (inFlight dedupes a tap mid-fetch), so
     *  the trader never waits out the 4s auto-retry to ask again. */
    const retryLoadRef = useRef<(() => void) | null>(null);
    const [levels, setLevels] = useState<ChartLevel[]>([]);
    /** Which studies are drawn, per user. The SERIES come from
     *  `chartIndicators.ts` — the one series module (the desk tools migrate
     *  onto it per O-150) — so a line on the screen and the desk's numbers
     *  share one computation. This state only says which of them are
     *  visible; it cannot change a value. */
    const [indicatorSettings, setIndicatorSettings] = useState<ChartIndicatorSettings>(
        () => readChartIndicatorSettings(getActiveUsername() || 'default'),
    );
    /** What is visible, readable from non-React callbacks (the canvas repaint
     *  runs on subscriptions, not renders — a state read there goes stale).
     *  The BUILD effect refreshes it on every settings change. */
    const visibleRef = useRef(indicatorSettings.visible);
    /** Back-compat with the old single `ƒSMA` toggle: on when ANY study is on,
     *  so a caller forcing `showSma` still lights the button. */
    const indicatorsOn = Object.values(indicatorSettings.visible).some(Boolean) || showSma;
    const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
    const toggleIndicator = (id: ChartIndicatorId) => {
        // The updater MUST be pure: the store's write notifies subscribers
        // synchronously, so a write/notify inside this function re-ran the
        // queued functional update against state it had already advanced and
        // the second run computed the INVERSE value — one click, two writes,
        // a study toggle that read as dead. Compute only here; the write and
        // the anchor reset live in the effect below.
        setIndicatorSettings(prev => ({
            visible: { ...prev.visible, [id]: !prev.visible[id] },
        }));
    };
    // Persist exactly once per settings change. The writer notifies its
    // subscribers synchronously, and our own subscriber (below) echoes the
    // SAME object back into state; `lastWrittenRef` is the loop guard that
    // makes that echo a no-op. The first run is skipped — mounting reads the
    // stored settings, it does not write them back.
    const lastWrittenRef = useRef<ChartIndicatorSettings | null>(null);
    const firstSettingsEffectRef = useRef(true);
    useEffect(() => {
        if (firstSettingsEffectRef.current) { firstSettingsEffectRef.current = false; return; }
        if (lastWrittenRef.current === indicatorSettings) return;
        lastWrittenRef.current = indicatorSettings;
        writeChartIndicatorSettings(getActiveUsername() || 'default', indicatorSettings);
        // Turning the anchored VWAP off also drops its anchor: re-toggling
        // starts a fresh read, not a silent revival of an old one.
        if (!indicatorSettings.visible.avwap) {
            avwapAnchorRef.current = null;
            setAvwapAnchor(null);
        }
    }, [indicatorSettings]);
    // A study toggled from the DESK writes the same store this state came from.
    // Without the subscription the write lands in localStorage and nothing
    // repaints, which is a control that cannot fire — the exact defect
    // chartIndicatorRegistry was written to stop, in a new place. The chart owns
    // the canvas, so hearing about the write is the chart's job; the tool only
    // writes the row.
    useEffect(() => subscribeChartIndicatorSettings(next => {
        setIndicatorSettings(next);
    }), []);

    /** One legend row per visible study, OKX's order and names. Reads the same
     *  computed series the lines are drawn from, so a legend value can never
     *  disagree with the line it describes. */
    const legendSettingsRows = (bar: LegendBar): React.ReactNode => {
        const v = indicatorSettings.visible;
        const fmt = (x: number | null): string => (x === null ? '—' : fmtPriceForChart(x));
        const num = (x: number | null, dp = 2): string => (x === null ? '—' : x.toFixed(dp));
        const rows: React.ReactNode[] = [];
        if (v.ema20 || v.ema200) {
            rows.push((
                <div key="ema" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {v.ema20 && <span>EMA(20) <span className="text-zinc-300">{fmt(bar.values.ema20 ?? null)}</span></span>}
                    {v.ema200 && <span>EMA(200) <span className="text-zinc-300">{fmt(bar.values.ema200 ?? null)}</span></span>}
                </div>
            ));
        }
        if (v.boll) {
            rows.push((
                <div key="boll" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>BOLL <span className="text-zinc-300">{fmt(bar.values.bollMid ?? null)}</span></span>
                    <span>UB <span className="text-zinc-300">{fmt(bar.values.bollUpper ?? null)}</span></span>
                    <span>LB <span className="text-zinc-300">{fmt(bar.values.bollLower ?? null)}</span></span>
                </div>
            ));
        }
        if (v.vwap || v.avwap) {
            rows.push((
                <div key="vwap" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {v.vwap && <span>VWAP <span className="text-zinc-300">{fmt(bar.values.vwap ?? null)}</span></span>}
                    {v.avwap && <span>aVWAP <span className="text-zinc-300">{avwapAnchor === null ? '(Alt+click a bar)' : fmt(bar.values.avwap ?? null)}</span></span>}
                </div>
            ));
        }
        if (v.rsi) {
            rows.push((
                <div key="rsi" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>RSI(6) <span className="text-zinc-300">{num(bar.values.rsi6 ?? null)}</span></span>
                    <span>RSI(14) <span className="text-zinc-300">{num(bar.values.rsi14 ?? null)}</span></span>
                    <span>RSI(24) <span className="text-lime-300">{num(bar.values.rsi24 ?? null)}</span></span>
                </div>
            ));
        }
        if (v.macd) {
            // OKX's row is DIF / DEA / MACD where DIF is the MACD line, DEA its
            // signal and MACD the histogram DOUBLED (the Chinese convention:
            // MACD = 2·(DIF−DEA)). `chartIndicators` keeps the histogram at 1×
            // for library parity, so the doubling happens here, in the display.
            const dif = bar.values.macd ?? null;
            const dea = bar.values.macdSignal ?? null;
            const hist = dif !== null && dea !== null ? dif - dea : null;
            rows.push((
                <div key="macd" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>MACD <span className="text-zinc-300">{num(hist === null ? null : 2 * hist, 1)}</span></span>
                    <span>DIF <span className="text-zinc-300">{num(dif, 1)}</span></span>
                    <span>DEA <span className="text-rose-300">{num(dea, 1)}</span></span>
                </div>
            ));
        }
        if (v.tsi) {
            rows.push((
                <div key="tsi" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>TSI(25, 13, 13) <span className="text-zinc-300">{num(bar.values.tsi ?? null)}</span></span>
                    <span>Signal <span className="text-rose-300">{num(bar.values.tsiSignal ?? null)}</span></span>
                </div>
            ));
        }
        if (v.cvd) {
            rows.push((
                <div key="cvd" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>CVD <span className="text-zinc-300">{bar.values.cvd === null || bar.values.cvd === undefined ? '—' : Math.round(bar.values.cvd).toLocaleString()}</span></span>
                    <span className="text-zinc-500">taker volume</span>
                </div>
            ));
        }
        // Session levels and the structure read are not per-bar studies, so
        // they are reported as the nearest levels and the last structural
        // break — the same rows the desk tools print.
        if (v.sessionLevels && sessionLevelsRef.current.length > 0) {
            const nearest = [...sessionLevelsRef.current].sort((a, b) => a.distance - b.distance).slice(0, 3);
            rows.push((
                <div key="sessionLevels" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {nearest.map(l => (
                        <span key={l.label}>{l.label} <span className="text-zinc-300">{fmt(l.price)}</span></span>
                    ))}
                </div>
            ));
        }
        if (v.swings && swingsRef.current) {
            const s = swingsRef.current;
            rows.push((
                <div key="swings" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>Structure <span className="text-zinc-300">{s.trend}</span></span>
                    {s.lastBreak && (
                        <span>{s.lastBreak.kind} <span className={s.lastBreak.direction === 'bullish' ? 'text-emerald-300' : 'text-rose-300'}>{s.lastBreak.direction}</span></span>
                    )}
                </div>
            ));
        }
        return rows;
    };

    // ─── Drawings state & zero-lag primitive ────────────────────────────────
    const overlayRef = useRef<HTMLCanvasElement | null>(null);
    const primitiveRef = useRef<ChartDrawingsPrimitive | null>(null);
    const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
    const [tool, setTool] = useState<DrawTool>('cursor');
    const toolRef = useRef<DrawTool>(tool);
    toolRef.current = tool;
    const [color] = useState<string>(DRAW_COLORS[0]);
    /** Right-axis price scale mode ('normal' | 'logarithmic' | 'percentage'). */
    const [internalScaleMode, setInternalScaleMode] = useState<ChartScaleMode>('normal');
    const activeScaleMode: ChartScaleMode = controlledScaleMode ?? internalScaleMode;
    const setScaleMode = useCallback((next: ChartScaleMode | ((prev: ChartScaleMode) => ChartScaleMode)): void => {
        const resolved = typeof next === 'function' ? next(activeScaleMode) : next;
        setInternalScaleMode(resolved);
        onScaleModeChange?.(resolved);
    }, [activeScaleMode, onScaleModeChange]);
    const priceScaleMode: PriceScaleMode = activeScaleMode === 'logarithmic' ? 'logarithmic' : 'normal';
    const priceScaleModeRef = useRef<PriceScaleMode>(priceScaleMode);
    priceScaleModeRef.current = priceScaleMode;
    const [internalAutoScale, setInternalAutoScale] = useState(true);
    const activeAutoScale = controlledAutoScale ?? internalAutoScale;
    const setAutoScale = useCallback((next: boolean | ((prev: boolean) => boolean)): void => {
        const resolved = typeof next === 'function' ? next(activeAutoScale) : next;
        setInternalAutoScale(resolved);
        onAutoScaleChange?.(resolved);
    }, [activeAutoScale, onAutoScaleChange]);
    const [candleStyle, setCandleStyle] = useState<CandleDisplayStyle>('candles');
    const closeLineRef = useRef<ISeriesApi<'Line'> | null>(null);
    const [railCollapsed, setRailCollapsed] = useState(false);
    const [objectTreeOpen, setObjectTreeOpen] = useState(false);
    const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
    const [showGrid, setShowGrid] = useState(true);
    /** Currently selected & hovered drawing ids (selection handles render on `zOrder: 'top'`). */
    const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
    const selectedDrawingIdRef = useRef<string | null>(null);
    selectedDrawingIdRef.current = selectedDrawingId;
    const hoveredDrawingIdRef = useRef<string | null>(null);
    /** Double-click inspector popover state. */
    const [inspector, setInspector] = useState<{ drawingId: string; x: number; y: number } | null>(null);
    /** Immutable undo/redo history stack (covers both user + AI drawings, e.g., undoable Clear AI). */
    const historyRef = useRef<DrawingCommandHistory>(createDrawingHistory({ userDrawings: [], modelDrawings: [] }));
    const [historyMeta, setHistoryMeta] = useState<{ canUndo: boolean; canRedo: boolean }>({
        canUndo: false,
        canRedo: false,
    });
    const syncHistoryMeta = useCallback((h: DrawingCommandHistory): void => {
        historyRef.current = h;
        setHistoryMeta({ canUndo: canUndoDrawing(h), canRedo: canRedoDrawing(h) });
    }, []);
    /** Active 12px OHLC magnet reticle during drawing or dragging. */
    const magnetSnapRef = useRef<MagnetSnapResult | null>(null);
    /** In-progress shape in SCREEN space while the user is clicking/dragging. */
    const [draft, setDraft] = useState<{ points: { x: number; y: number }[] } | null>(null);
    // Where the ACTIVE placement press began — the click-vs-drag discriminator:
    // a release within CLICK_COMMIT_THRESHOLD_PX of the press is a CLICK (arms
    // click-click placement, the draft stays live under the pointer), anything
    // further is a drag (commits on release, the old one-shot gesture).
    const draftStartRef = useRef<{ x: number; y: number } | null>(null);
    // Clear the press anchor whenever the draft dies (commit, Escape, tool switch).
    useEffect(() => {
        if (!draft) draftStartRef.current = null;
    }, [draft]);
    /** Visibility scope across user + AI drawing layers (`all` | `hide_all` | `hide_ai` | `hide_user`). */
    const [visibilityScope, setVisibilityScope] = useState<DrawingVisibilityScope>('all');
    const visibilityScopeRef = useRef<DrawingVisibilityScope>(visibilityScope);
    visibilityScopeRef.current = visibilityScope;
    const drawingsHidden = visibilityScope === 'hide_all';
    /** The "N lower-TF hidden" pill's temporary reveal: when true, drawings the
     *  active timeframe would hide render anyway until the trader closes the
     *  pill. Plan levels (persistAcrossTf) are never hidden, so they never
     *  count toward the pill. */
    const [showLowerTfDrawings, setShowLowerTfDrawings] = useState(false);
    /** Magnet snap mode (`off` | `weak` 12px | `strong` 36px; holding Ctrl flips). */
    const [magnetMode, setMagnetMode] = useState<MagnetMode>('off');
    const magnetModeRef = useRef<MagnetMode>(magnetMode);
    magnetModeRef.current = magnetMode;
    /** Keep the active drawing tool selected after placing a shape. */
    const [stayInDrawingMode, setStayInDrawingMode] = useState(false);
    const stayInDrawingModeRef = useRef(stayInDrawingMode);
    stayInDrawingModeRef.current = stayInDrawingMode;
    /** Starred drawing tools for the draggable Favorites micro-bar (per user). */
    const favStorageKey = `august_chart_favorites_v1_${getActiveUsername() || 'default'}`;
    const [favoriteTools, setFavoriteTools] = useState<DrawTool[]>(() => {
        try {
            const raw = localStorage.getItem(`august_chart_favorites_v1_${getActiveUsername() || 'default'}`);
            return raw ? normalizeFavoriteTools(JSON.parse(raw)) : [];
        } catch {
            return [];
        }
    });
    const handleToggleFavorite = useCallback((t: DrawTool): void => {
        setFavoriteTools(prev => {
            const next = toggleFavoriteTool(prev, t);
            try { localStorage.setItem(favStorageKey, JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    }, [favStorageKey]);
    const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
    /** Ephemeral Shift+Drag / Ruler measurement state (never saved as a drawing). */
    const measureDragRef = useRef<{ start: ScreenXY; end: ScreenXY; metrics: MeasureMetrics | null } | null>(null);
    const [measureReadout, setMeasureReadout] = useState<{ x: number; y: number; metrics: MeasureMetrics } | null>(null);
    /** Stroke weight for NEW shapes; the rail cycles the ladder. Committed
     *  shapes keep the width they were drawn at, so changing the control does
     *  not restyle the trader's existing work. */
    const [lineWidth] = useState<number>(DRAW_WIDTH_DEFAULT);
    const drawingsHiddenRef = useRef(drawingsHidden);
    drawingsHiddenRef.current = drawingsHidden;
    const showLowerTfRef = useRef(showLowerTfDrawings);
    showLowerTfRef.current = showLowerTfDrawings;
    /** Live-editing a text note: which drawing id + where its input renders. */
    const [textEdit, setTextEdit] = useState<{ id: string; x: number; y: number } | null>(null);
    const lastTickRef = useRef<number>(Date.now());
    const drawingsRef = useRef<ChartDrawing[]>([]);
    drawingsRef.current = drawings;
    const modelDrawingsRef = useRef<ChartDrawing[]>([]);
    modelDrawingsRef.current = modelDrawings ?? [];
    /** Committed shapes the ACTIVE timeframe hides (micro-structure anchored on
     *  a lower timeframe). Plan levels (persistAcrossTf) never count — they
     *  always render. Drives the quiet "N lower-TF hidden" pill. */
    const hiddenLowerTfCount = useMemo(
        () => countHiddenLowerTf([...drawings, ...(modelDrawings ?? [])], interval),
        [drawings, modelDrawings, interval],
    );
    // Paper levels are a THIRD, ephemeral list: never merged into `drawings`
    // or `modelDrawings`, so no paper fill can be undone or saved as a user
    // drawing. Only the primitive reads them.
    const [paperDrawings, setPaperDrawings] = useState<ReadonlyArray<ChartDrawing>>([]);
    const paperDrawingsRef = useRef<ReadonlyArray<ChartDrawing>>([]);
    paperDrawingsRef.current = paperDrawings;
    const paperAccountRef = useRef<PaperAccount | null>(null);
    const [paperEnabled, setPaperEnabled] = useState(false);
    const [planMode, setPlanMode] = useState<boolean>(() => chatStore.getPlanMode(sessionId));
    const planModeRef = useRef(planMode);
    planModeRef.current = planMode;
    const [harnessSizing, setHarnessSizing] = useState<PositionBoxSizing>(() => {
        const s = getHarnessSettings();
        return { equityUsd: s.equityUsd, riskPercent: s.riskPercent, leverage: s.defaultLeverage };
    });
    const harnessSizingRef = useRef<PositionBoxSizing>(harnessSizing);
    harnessSizingRef.current = harnessSizing;
    useEffect(() => subscribeHarnessSettings(() => {
        const s = getHarnessSettings();
        const acct = paperAccountRef.current;
        const equity = s.equityUsd > 0 ? s.equityUsd : (acct?.cashBalanceUsd ?? 0);
        setHarnessSizing({ equityUsd: equity, riskPercent: s.riskPercent, leverage: s.defaultLeverage });
    }), []);
    const [paperDragPreview, setPaperDragPreview] = useState<{ x: number; y: number; preview: PaperHandlePreview } | null>(null);
    useEffect(() => {
        setPlanMode(chatStore.getPlanMode(sessionId));
        return chatStore.subscribe(() => {
            setPlanMode(chatStore.getPlanMode(sessionId));
        });
    }, [sessionId]);
    const [contextMenu, setContextMenu] = useState<{ price: number; x: number; y: number } | null>(null);
    const [chartNotice, setChartNotice] = useState<string | null>(null);
    const chartNoticeTimerRef = useRef<number | null>(null);
    const showChartNotice = useCallback((msg: string): void => {
        setChartNotice(msg);
        if (chartNoticeTimerRef.current !== null) window.clearTimeout(chartNoticeTimerRef.current);
        chartNoticeTimerRef.current = window.setTimeout(() => {
            chartNoticeTimerRef.current = null;
            setChartNotice(null);
        }, 3200);
    }, []);
    useEffect(() => () => {
        if (chartNoticeTimerRef.current !== null) window.clearTimeout(chartNoticeTimerRef.current);
    }, []);
    /** Drawing spotlighted by hovering a `#Dn` chip inside Chat messages. */
    const [spotlightShortId, setSpotlightShortId] = useState<string | null>(null);
    const spotlightIdRef = useRef<string | null>(null);
    const onReplaceModelDrawingsRef = useRef(onReplaceModelDrawings);
    onReplaceModelDrawingsRef.current = onReplaceModelDrawings;
    const intervalRef = useRef<ChartInterval>(interval);
    intervalRef.current = interval;
    // Stable handle to the latest repaint() so the data-lifecycle effect (which
    // runs before repaint is defined) can force a repaint the instant a coin's
    // candles (re)load — otherwise a switch BACK reloads the shapes into state
    // but, with status already 'live', nothing repaints them (invisible until a
    // manual pan). Synced below once repaint exists.
    const repaintRef = useRef<() => void>(() => {});
    /** Repaint at most once per FRAME. Pan/zoom fires the visible-range
     *  subscription many times per frame, and each repaint walks the visible
     *  bars through coordinate conversions — uncoalesced, a fast pan paid for
     *  two or three full repaints per frame and the chart lagged with a lot
     *  of data loaded. Everything schedules; the last schedule in a frame
     *  wins. The ResizeObserver rides the same lane. */
    const repaintFrameRef = useRef<number | null>(null);
    const scheduleRepaint = useCallback((): void => {
        if (repaintFrameRef.current !== null) return;
        repaintFrameRef.current = window.requestAnimationFrame(() => {
            repaintFrameRef.current = null;
            repaintRef.current();
        });
    }, []);

    // ─── Candle hover focus animation (scale + brightness) ──────────────────
    // Animated entirely on the overlay canvas via rAF so hovering never causes
    // per-frame React renders or 1000-bar series rewrites; the loop stops
    // completely as soon as active enter/leave transitions settle.
    const hoveredCandleTimeRef = useRef<number | null>(null);
    const hoverAnimsRef = useRef<Map<number, number>>(new Map());
    const hoverRafRef = useRef<number | null>(null);
    const hoverLastTsRef = useRef<number | null>(null);

    const stopHoverAnimation = useCallback((): void => {
        if (hoverRafRef.current !== null) {
            window.cancelAnimationFrame(hoverRafRef.current);
            hoverRafRef.current = null;
        }
        hoverLastTsRef.current = null;
    }, []);

    const setHoveredCandle = useCallback((time: number | null): void => {
        if (hoveredCandleTimeRef.current === time) return;
        hoveredCandleTimeRef.current = time;
        const reducedMotion = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reducedMotion) {
            stopHoverAnimation();
            stepCandleHoverMap(hoverAnimsRef.current, time, 0, true);
            scheduleRepaint();
            return;
        }
        if (hoverRafRef.current !== null) return;
        hoverLastTsRef.current = null;
        const tick = (now: number): void => {
            const dt = hoverLastTsRef.current === null ? 16 : now - hoverLastTsRef.current;
            hoverLastTsRef.current = now;
            const stillAnimating = stepCandleHoverMap(
                hoverAnimsRef.current,
                hoveredCandleTimeRef.current,
                dt,
                false,
            );
            repaintRef.current();
            if (stillAnimating) {
                hoverRafRef.current = window.requestAnimationFrame(tick);
            } else {
                hoverRafRef.current = null;
                hoverLastTsRef.current = null;
            }
        };
        hoverRafRef.current = window.requestAnimationFrame(tick);
    }, [scheduleRepaint, stopHoverAnimation]);

    // Clear candle hover highlight whenever the instrument, interval, or active
    // drawing tool changes so a stale bar from another series never lingers.
    useEffect(() => {
        hoveredCandleTimeRef.current = null;
        hoverAnimsRef.current.clear();
        stopHoverAnimation();
        scheduleRepaint();
    }, [symbol, interval, stopHoverAnimation, scheduleRepaint]);

    useEffect(() => {
        if (tool !== 'cursor') setHoveredCandle(null);
    }, [tool, setHoveredCandle]);

    // Load the persisted shapes whenever the chart (scope + symbol) changes.
    // ONE store: the session bucket for this scope — there is no legacy
    // fallback chart-side any more, because a fallback IS the two-bucket bug
    // (779cb746). The one-time legacy import lives in the store module; the
    // async load means the cancelled guard is what makes a rapid scope/coin
    // switch settle on the LAST switch's shapes — a slower stale read must
    // never land after a newer one and paint the wrong scope's shapes.
    useEffect(() => {
        let cancelled = false;
        setDraft(null);
        setTool('cursor');
        setTextEdit(null);
        setSelectedDrawingId(null);
        setInspector(null);
        const load = async (): Promise<void> => {
            const list = await loadSessionDrawingsWithLegacy(sessionId, symbol);
            if (!cancelled) {
                const normalized = ensureStableShortIds(
                    list.map(d => (d.origin ? d : { ...d, origin: 'user' as const })),
                    symbol,
                );
                setDrawings(normalized);
                syncHistoryMeta(createDrawingHistory({ userDrawings: normalized, modelDrawings: modelDrawingsRef.current }));
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [symbol, sessionId, syncHistoryMeta]);

    // Keep history present synced when modelDrawings updates externally (e.g. AI desk tool).
    useEffect(() => {
        const currentModel = modelDrawings ?? [];
        const present = historyRef.current.present;
        if (present.modelDrawings !== currentModel) {
            historyRef.current = syncDrawingHistoryPresent(
                historyRef.current,
                { userDrawings: drawingsRef.current, modelDrawings: currentModel },
            );
        }
    }, [modelDrawings]);

    // The paper overlay re-reads the one authoritative account on every fill
    // or config write. It never calls a mutator and never touches the two
    // persisted drawing buckets.
    useEffect(() => {
        let alive = true;
        const applyAccount = (account: PaperAccount): void => {
            paperAccountRef.current = account;
            setPaperEnabled(account.config.enabled === true);
            setPaperDrawings(paperDrawingsFromAccount(account, symbol));
            const s = getHarnessSettings();
            const equity = s.equityUsd > 0 ? s.equityUsd : account.cashBalanceUsd;
            setHarnessSizing({
                equityUsd: equity,
                riskPercent: s.riskPercent,
                leverage: s.defaultLeverage,
                takerFeeBps: account.config.takerFeeBps,
            });
        };
        const unsubscribe = subscribePaperAccount(account => {
            if (alive) applyAccount(account);
        });
        void getPaperAccount().then(account => {
            if (alive) applyAccount(account);
        }).catch(() => { /* no readable paper account — overlay stays empty */ });
        return () => { alive = false; unsubscribe(); };
    }, [symbol]);

    // Sync the native lightweight-charts ISeriesPrimitive with current drawings/selection/scale.
    const syncPrimitive = useCallback((overrides?: {
        userDrawings?: ReadonlyArray<ChartDrawing>;
        modelDrawings?: ReadonlyArray<ChartDrawing>;
        paperDrawings?: ReadonlyArray<ChartDrawing>;
        selectedId?: string | null;
        hoveredId?: string | null;
    }): void => {
        const prim = primitiveRef.current;
        if (!prim) return;
        const bars: ReadonlyArray<EvalCandle> = chartRowsRef.current.length > 0
            ? chartRowsRef.current
            : ((candlesRef.current?.data?.() ?? []) as readonly EvalCandle[]);
        prim.setState({
            userDrawings: overrides?.userDrawings ?? drawingsRef.current,
            modelDrawings: overrides?.modelDrawings ?? modelDrawingsRef.current,
            paperDrawings: overrides?.paperDrawings ?? paperDrawingsRef.current,
            selectedId: overrides?.selectedId !== undefined ? overrides.selectedId : selectedDrawingIdRef.current,
            hoveredId: overrides?.hoveredId !== undefined ? overrides.hoveredId : hoveredDrawingIdRef.current,
            spotlightId: spotlightIdRef.current,
            hidden: drawingsHiddenRef.current,
            visibilityScope: visibilityScopeRef.current,
            includeLowerTf: showLowerTfRef.current,
            activeTf: intervalRef.current,
            barSeconds: intervalSeconds(intervalRef.current),
            priceScaleMode: priceScaleModeRef.current,
            candles: bars,
            sizing: harnessSizingRef.current,
        });
    }, []);

    useEffect(() => {
        const onSpotlight = (ev: Event): void => {
            const shortId = (ev as CustomEvent<{ shortId?: string | null }>).detail?.shortId ?? null;
            setSpotlightShortId(shortId);
            if (!shortId) {
                spotlightIdRef.current = null;
            } else {
                const upper = shortId.trim().toUpperCase();
                const found = [...drawingsRef.current, ...modelDrawingsRef.current]
                    .find(d => d.shortId?.toUpperCase() === upper);
                spotlightIdRef.current = found ? found.id : null;
            }
            syncPrimitive();
        };
        window.addEventListener('august:chart-spotlight', onSpotlight);
        return () => window.removeEventListener('august:chart-spotlight', onSpotlight);
    }, [syncPrimitive]);

    useEffect(() => {
        syncPrimitive();
        scheduleRepaint();
    }, [drawings, modelDrawings, paperDrawings, selectedDrawingId, visibilityScope, showLowerTfDrawings, interval, priceScaleMode, harnessSizing, syncPrimitive, scheduleRepaint]);

    // Apply Normal / Logarithmic / Percentage mode + AutoScale directly to lightweight-charts' right price scale.
    useEffect(() => {
        try {
            chartRef.current?.priceScale('right')?.applyOptions({
                mode: activeScaleMode === 'logarithmic'
                    ? LwcPriceScaleMode.Logarithmic
                    : activeScaleMode === 'percentage'
                        ? LwcPriceScaleMode.Percentage
                        : LwcPriceScaleMode.Normal,
                autoScale: activeAutoScale,
            });
            syncPrimitive();
            scheduleRepaint();
        } catch { /* chart tearing down */ }
    }, [activeScaleMode, activeAutoScale, syncPrimitive, scheduleRepaint]);

    // Apply grid visibility toggle without recreating the chart.
    useEffect(() => {
        try {
            const c = showGrid ? 'rgba(255,255,255,0.025)' : 'transparent';
            chartRef.current?.applyOptions({
                grid: { vertLines: { color: c }, horzLines: { color: c } },
            });
        } catch { /* chart tearing down */ }
    }, [showGrid]);

    // Apply Candle style (Candles / Hollow / Line) without recreating the chart.
    useEffect(() => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return;
        try {
            if (candleStyle === 'line') {
                cs.applyOptions({
                    upColor: 'transparent',
                    downColor: 'transparent',
                    borderVisible: false,
                    wickVisible: false,
                });
                if (!closeLineRef.current) {
                    closeLineRef.current = chart.addSeries(LineSeries, {
                        color: chartColor('--color-zinc-200', '#e4e4e7'),
                        lineWidth: 2,
                        priceLineVisible: false,
                        lastValueVisible: false,
                    });
                }
                closeLineRef.current.setData(
                    chartRowsRef.current.map(r => ({ time: r.time as UTCTimestamp, value: r.close })),
                );
            } else {
                if (closeLineRef.current) {
                    try { chart.removeSeries(closeLineRef.current); } catch { /* removed */ }
                    closeLineRef.current = null;
                }
                const up = CANDLE_UP();
                const dn = CANDLE_DOWN();
                cs.applyOptions({
                    upColor: candleStyle === 'hollow' ? 'transparent' : up,
                    downColor: dn,
                    borderVisible: true,
                    borderUpColor: up,
                    borderDownColor: dn,
                    wickVisible: true,
                    wickUpColor: up,
                    wickDownColor: dn,
                });
            }
        } catch { /* chart tearing down */ }
    }, [candleStyle, status, symbol, interval]);

    const handleResetView = useCallback((): void => {
        try {
            setScaleMode('normal');
            setAutoScale(true);
            chartRef.current?.priceScale('right')?.applyOptions({
                mode: LwcPriceScaleMode.Normal,
                autoScale: true,
            });
            chartRef.current?.timeScale()?.fitContent?.();
            syncPrimitive();
            scheduleRepaint();
        } catch { /* chart tearing down */ }
    }, [setScaleMode, setAutoScale, syncPrimitive, scheduleRepaint]);

    useEffect(() => {
        if (!onResetViewRef) return;
        onResetViewRef.current = handleResetView;
        return () => { onResetViewRef.current = null; };
    }, [onResetViewRef, handleResetView]);

    const publishDrawings = useCallback((next: ChartDrawing[]): void => {
        setDrawings(next);
        drawingsRef.current = next;
        drawingsControl('user', sessionId, symbol).replace(next);
        onDrawingsChange?.(next);
        syncPrimitive({ userDrawings: next });
    }, [symbol, sessionId, onDrawingsChange, syncPrimitive]);

    const publishModelDrawings = useCallback((next: ChartDrawing[]): void => {
        modelDrawingsRef.current = next;
        onReplaceModelDrawingsRef.current?.(next);
        syncPrimitive({ modelDrawings: next });
    }, [syncPrimitive]);

    /** Commit a drawing mutation onto the immutable undo/redo command stack. */
    const commitDrawingChange = useCallback((nextUser: ChartDrawing[], nextModel?: ChartDrawing[]): void => {
        const resolvedModel = nextModel ?? modelDrawingsRef.current;
        const nextHistory = pushDrawingSnapshot(historyRef.current, { userDrawings: nextUser, modelDrawings: resolvedModel });
        syncHistoryMeta(nextHistory);
        publishDrawings(nextUser);
        if (nextModel !== undefined) publishModelDrawings(nextModel);
    }, [publishDrawings, publishModelDrawings, syncHistoryMeta]);

    const handleDrawHlineAtPrice = useCallback((price: number): void => {
        if (!Number.isFinite(price) || price <= 0) return;
        const bars = chartRowsRef.current;
        const t = bars.length > 0 ? bars[bars.length - 1].time : Math.floor(Date.now() / 1000);
        const shortId = allocateDrawingShortId(symbol, [...drawingsRef.current, ...modelDrawingsRef.current]);
        const created: ChartDrawing = {
            id: createDrawingId(),
            shortId,
            origin: 'user',
            createdOnTf: interval,
            version: 1,
            kind: 'hline',
            points: [{ t, p: price }],
            color,
            createdAt: Date.now(),
            drawnPrice: markPrice ?? lastPrice ?? undefined,
            width: lineWidth,
        };
        commitDrawingChange([...drawingsRef.current, created]);
        setSelectedDrawingId(created.id);
        showChartNotice(`Placed ${shortId} @ $${fmtPriceForChart(price)}`);
    }, [symbol, interval, color, lineWidth, markPrice, lastPrice, commitDrawingChange, showChartNotice]);

    const handleArmWatchAtPrice = useCallback((price: number, notePrefix = 'Chart level'): void => {
        if (!Number.isFinite(price) || price <= 0) return;
        const liveMark = markPrice ?? lastPrice ?? null;
        const condition: 'above' | 'below' = liveMark !== null && price < liveMark ? 'below' : 'above';
        const now = Date.now();
        const res = watchService.arm({
            kind: 'price',
            id: `w-${now}-${Math.random().toString(36).slice(2, 6)}`,
            symbol: symbol.toUpperCase(),
            condition,
            price,
            note: `${notePrefix} @ $${fmtPriceForChart(price)}`,
            expiresAt: now + 24 * 60 * 60 * 1000,
            createdAt: now,
            sid: sessionId,
        }, liveMark);
        showChartNotice(
            res === 'armed'
                ? `Watch armed: ${symbol.replace(/USDT$/i, '')} ${condition} $${fmtPriceForChart(price)}`
                : `Watch refused — mark already ${condition} $${fmtPriceForChart(price)}`,
        );
    }, [symbol, sessionId, markPrice, lastPrice, showChartNotice]);

    const handleStagePaperLimitAtPrice = useCallback(async (price: number, side: 'long' | 'short'): Promise<void> => {
        if (planMode) {
            showChartNotice('Blocked in Plan Mode (read-only) — toggle Plan Mode off to stage paper orders');
            return;
        }
        if (!paperEnabled) {
            showChartNotice('Paper Mode is off — enable Paper Mode in Settings');
            return;
        }
        const atr = computeAtr14(chartRowsRef.current.slice(-200));
        const riskDist = atr && atr > 0 ? atr : Math.max(price * 0.01, 1e-6);
        const stopLoss = side === 'long' ? Math.max(1e-8, price - riskDist) : price + riskDist;
        const takeProfit = side === 'long' ? price + riskDist * 2 : Math.max(1e-8, price - riskDist * 2);
        const receipt = await submitPaperOrder({
            action: 'open_limit',
            symbol,
            side,
            entry_price: price,
            stop_loss: stopLoss,
            take_profits: [takeProfit],
            thesis: `Chart limit ${side} @ $${fmtPriceForChart(price)}`,
        });
        if (receipt.ok) {
            showChartNotice(`Staged Paper Limit ${side.toUpperCase()} @ $${fmtPriceForChart(price)}`);
        } else {
            showChartNotice(`Paper refused: ${receipt.reason ?? receipt.error ?? 'blocked'}`);
        }
    }, [planMode, paperEnabled, symbol, showChartNotice]);

    const handleAskAugust = useCallback((snippet: string): void => {
        window.dispatchEvent(new CustomEvent('august:composer-inject', {
            detail: { text: snippet, focus: true },
        }));
    }, []);

    const handleStagePaperFromPositionBox = useCallback(async (sel: ChartDrawing): Promise<void> => {
        if (!isPositionBoxKind(sel.kind)) return;
        if (planMode) {
            showChartNotice('Blocked in Plan Mode (read-only) — toggle Plan Mode off to stage paper orders');
            return;
        }
        if (!paperEnabled) {
            showChartNotice('Paper Mode is off — enable Paper Mode in Settings');
            return;
        }
        const readout = computePositionBoxReadout(sel.kind, sel.points, harnessSizingRef.current);
        if (!readout || readout.inverted) {
            showChartNotice('Position box geometry is inverted — adjust SL/TP before staging');
            return;
        }
        const side = readout.direction === 'Long' ? 'long' : 'short';
        const receipt = await submitPaperOrder({
            action: 'open_limit',
            symbol,
            side,
            entry_price: readout.entry,
            stop_loss: readout.stopLoss,
            take_profits: [readout.takeProfit],
            risk_pct: harnessSizingRef.current.riskPercent,
            leverage: harnessSizingRef.current.leverage,
            thesis: `Position box ${sel.shortId ?? ''} (${readout.direction} Net ${readout.netRR.toFixed(2)}R)`.trim(),
        });
        if (receipt.ok) {
            showChartNotice(`Staged Paper ${readout.direction} @ $${fmtPriceForChart(readout.entry)} (SL $${fmtPriceForChart(readout.stopLoss)})`);
        } else {
            showChartNotice(`Paper refused: ${receipt.reason ?? receipt.error ?? 'blocked'}`);
        }
    }, [planMode, paperEnabled, symbol, showChartNotice]);

    const handleUndoDrawing = useCallback((): void => {
        const nextHistory = undoDrawingState(historyRef.current);
        if (nextHistory === historyRef.current) return;
        syncHistoryMeta(nextHistory);
        publishDrawings(nextHistory.present.userDrawings);
        publishModelDrawings(nextHistory.present.modelDrawings);
        setSelectedDrawingId(null);
        setInspector(null);
    }, [publishDrawings, publishModelDrawings, syncHistoryMeta]);

    const handleRedoDrawing = useCallback((): void => {
        const nextHistory = redoDrawingState(historyRef.current);
        if (nextHistory === historyRef.current) return;
        syncHistoryMeta(nextHistory);
        publishDrawings(nextHistory.present.userDrawings);
        publishModelDrawings(nextHistory.present.modelDrawings);
        setSelectedDrawingId(null);
        setInspector(null);
    }, [publishDrawings, publishModelDrawings, syncHistoryMeta]);

    const handleClearAgentDrawings = useCallback((): void => {
        const { history: nextHistory, removedCount } = clearAgentDrawingsFromHistory(historyRef.current);
        if (removedCount === 0) return;
        syncHistoryMeta(nextHistory);
        publishDrawings(nextHistory.present.userDrawings);
        publishModelDrawings(nextHistory.present.modelDrawings);
        setSelectedDrawingId(null);
        setInspector(null);
    }, [publishDrawings, publishModelDrawings, syncHistoryMeta]);

    const handleClearUserDrawings = useCallback((): void => {
        if (drawingsRef.current.length === 0) return;
        commitDrawingChange([], modelDrawingsRef.current);
        setSelectedDrawingId(null);
        setInspector(null);
    }, [commitDrawingChange]);

    const handleClearAllDrawings = useCallback((): void => {
        if (drawingsRef.current.length === 0 && modelDrawingsRef.current.length === 0) return;
        commitDrawingChange([], []);
        setSelectedDrawingId(null);
        setInspector(null);
    }, [commitDrawingChange]);

    const allLocked = useMemo(() => {
        const combined = [...drawings, ...(modelDrawings ?? [])];
        return combined.length > 0 && combined.every(d => d.locked === true);
    }, [drawings, modelDrawings]);

    const handleToggleLockAll = useCallback((): void => {
        const nextLocked = !allLocked;
        const nextUser = drawingsRef.current.map(d => bumpDrawingVersion({ ...d, locked: nextLocked }));
        const nextModel = modelDrawingsRef.current.map(d => bumpDrawingVersion({ ...d, locked: nextLocked }));
        commitDrawingChange(nextUser, nextModel);
    }, [allLocked, commitDrawingChange]);

    const deleteDrawingById = useCallback((id: string): void => {
        const inUser = drawingsRef.current.some(d => d.id === id);
        const inModel = modelDrawingsRef.current.some(d => d.id === id);
        if (!inUser && !inModel) return;
        // Locked is locked: the selection toolbar's unlock is the only door.
        const target = [...drawingsRef.current, ...modelDrawingsRef.current].find(d => d.id === id);
        if (target?.locked === true) return;
        const nextUser = inUser ? drawingsRef.current.filter(d => d.id !== id) : drawingsRef.current;
        const nextModel = inModel ? modelDrawingsRef.current.filter(d => d.id !== id) : modelDrawingsRef.current;
        if (inModel && !onReplaceModelDrawingsRef.current) {
            onRemoveModelShape?.(id);
            if (inUser) commitDrawingChange(nextUser);
        } else {
            commitDrawingChange(nextUser, nextModel);
        }
        if (selectedDrawingIdRef.current === id) setSelectedDrawingId(null);
        setInspector(prev => (prev?.drawingId === id ? null : prev));
    }, [commitDrawingChange, onRemoveModelShape]);

    // Global keyboard shortcuts: Escape, Delete/Backspace, Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z.
    useEffect(() => {
        const onKeyDown = (ev: KeyboardEvent): void => {
            const target = ev.target as HTMLElement | null;
            if (isEditableKeyboardTarget(target?.tagName, target?.isContentEditable)) return;
            if (ev.key === 'Escape') {
                if (draft) setDraft(null);
                if (measureDragRef.current) {
                    measureDragRef.current = null;
                    setMeasureReadout(null);
                    scheduleRepaint();
                }
                if (inspector) setInspector(null);
                if (selectedDrawingIdRef.current) setSelectedDrawingId(null);
                if (toolRef.current !== 'cursor') setTool('cursor');
                return;
            }
            if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedDrawingIdRef.current) {
                ev.preventDefault();
                deleteDrawingById(selectedDrawingIdRef.current);
                return;
            }
            const mod = ev.ctrlKey || ev.metaKey;
            const lower = ev.key.toLowerCase();
            if (mod && ev.altKey && lower === 'd') {
                ev.preventDefault();
                setRailCollapsed(v => !v);
                return;
            }
            if (mod && ev.altKey && lower === 'h') {
                ev.preventDefault();
                setVisibilityScope(prev => (prev === 'hide_all' ? 'all' : 'hide_all'));
                return;
            }
            if (mod && !ev.altKey && !ev.shiftKey && (ev.key === '\\' || ev.code === 'Backslash')) {
                if (onToggleChartFocus) {
                    ev.preventDefault();
                    onToggleChartFocus();
                }
                return;
            }
            if (ev.altKey && !mod) {
                if (ev.shiftKey && lower === 'r') {
                    ev.preventDefault();
                    setTool('rect');
                    setDraft(null);
                    return;
                }
                if (!ev.shiftKey) {
                    if (lower === 'r') {
                        ev.preventDefault();
                        handleResetView();
                        return;
                    }
                    const altMap: Record<string, DrawTool> = {
                        t: 'trend',
                        h: 'hline',
                        j: 'hray',
                        v: 'vline',
                        f: 'fib',
                        a: 'text',
                    };
                    const mapped = altMap[lower];
                    if (mapped) {
                        ev.preventDefault();
                        setTool(mapped);
                        setDraft(null);
                        return;
                    }
                }
            }
            if (mod && lower === 'z' && !ev.shiftKey) {
                if (canUndoDrawing(historyRef.current)) {
                    ev.preventDefault();
                    handleUndoDrawing();
                }
                return;
            }
            if (mod && (lower === 'y' || (lower === 'z' && ev.shiftKey))) {
                if (canRedoDrawing(historyRef.current)) {
                    ev.preventDefault();
                    handleRedoDrawing();
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [draft, inspector, deleteDrawingById, handleUndoDrawing, handleRedoDrawing, handleResetView, onToggleChartFocus]);

    // ─── Chart lifecycle ────────────────────────────────────────────────────
    // Create the chart once per mount; theme tokens match the app's dark surface.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const chart = createChart(host, {
            autoSize: true,
            layout: {
                background: { color: 'transparent' },
                textColor: chartColor('--color-zinc-500', '#9d998f'),
                attributionLogo: false,
            },
            grid: {
                // Fainter than v2 (mock v3): the tape is the drawing, the grid
                // is the paper it is drawn on.
                vertLines: { color: 'rgba(255,255,255,0.025)' },
                horzLines: { color: 'rgba(255,255,255,0.025)' },
            },
            rightPriceScale: {
                borderColor: 'rgba(255,255,255,0.08)',
                scaleMargins: { top: 0.12, bottom: 0.12 },
                entireTextOnly: true,
            },
            timeScale: {
                borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false,
                // Philippine-time axis labels (lightweight-charts defaults to UTC).
                tickMarkFormatter: (time: number | { year: number; month: number; day: number }, tickMarkType: unknown) => {
                    if (typeof time !== 'number') return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
                    // TimeMarkType: 0/1 are clock ticks; MonthDay(2)+ are date ticks.
                    return phtAxisTick(time, Number(tickMarkType) >= 2 ? 'day' : 'time');
                },
            },
            localization: {
                // Crosshair + any default time tooltip render in PHT, not UTC.
                timeFormatter: (time: number | { year: number; month: number; day: number }) =>
                    typeof time === 'number' ? phtAxisTick(time, 'full') : `${phtAxisTick(Date.UTC(time.year, time.month - 1, time.day) / 1000, 'day')}`,
            },
            crosshair: { mode: 0 },
        });
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: CANDLE_UP(), downColor: CANDLE_DOWN(),
            borderUpColor: CANDLE_UP(), borderDownColor: CANDLE_DOWN(),
            wickUpColor: CANDLE_UP(), wickDownColor: CANDLE_DOWN(),
            // The last-price line and its axis tag are drawn by the chart
            // itself instead: OKX's line is DOTTED and coloured by the last
            // candle's direction, and the tag carries a countdown the library
            // cannot render. The library's solid fixed-colour line is replaced.
            priceLineVisible: false,
            lastValueVisible: false,
        });
        const volume = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
            // The tag would otherwise print on the divider between the main
            // pane and the first sub-pane once a study is open.
            lastValueVisible: false,
        });
        chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        // Attach the native ISeriesPrimitive for zero-lag committed drawings + selection handles.
        const drawingsPrimitive = new ChartDrawingsPrimitive();
        try {
            candles.attachPrimitive(drawingsPrimitive);
            primitiveRef.current = drawingsPrimitive;
        } catch {
            primitiveRef.current = null;
        }
        chartRef.current = chart;
        candlesRef.current = candles;
        volumeRef.current = volume;
        // ── Crosshair readouts: coalesced to one frame ─────────────────────
        // The library fires this handler per pointer event. The two readouts
        // are committed at most once per frame, and the legend only rebuilds
        // when the BAR under the pointer changes — sweeps inside one bar cost
        // nothing at all.
        let crossFrame: number | null = null;
        let pendingCrossTime: number | null = null;
        let pendingCrossY: number | null = null;
        let pendingCrossPane = 1;
        const flushCrosshair = (): void => {
            crossFrame = null;
            const t = pendingCrossTime;
            const y = pendingCrossY;
            const pane = pendingCrossPane;
            const data = legendRef.current;
            if (typeof t === 'number' && data && t !== legendTimeRef.current) {
                legendTimeRef.current = t;
                const idx = data.times.indexOf(t);
                const bar = idx >= 0 ? data.bars[idx] : undefined;
                if (bar) {
                    const values: Record<string, number | null> = {};
                    for (const [k, s] of Object.entries(data.series)) values[k] = s[idx] ?? null;
                    hoverReadout.setBar({ time: t, ...bar, values });
                }
            }
            setHoveredCandleAttr(typeof t === 'number' ? t : null);
            // The price under the crosshair, with its % from the last price —
            // OKX's crosshair label. Main pane only; a sub-pane has its own
            // scale (and its own readout).
            const cs = candlesRef.current;
            if (typeof y !== 'number' || pane !== 0 || !cs || typeof cs.coordinateToPrice !== 'function') {
                hoverReadout.setCross(null);
                return;
            }
            const price = cs.coordinateToPrice(y as never);
            const rows = chartRowsRef.current;
            const lastClose = rows.length > 0 ? rows[rows.length - 1].close : undefined;
            if (price === null || price === undefined || !Number.isFinite(Number(price)) || !lastClose) {
                hoverReadout.setCross(null);
                return;
            }
            const p = Number(price);
            hoverReadout.setCross({ y, price: p, pct: ((p - lastClose) / lastClose) * 100 });
        };
        const onCrosshair = (param: Parameters<Parameters<IChartApi['subscribeCrosshairMove']>[0]>[0]) => {
            // Entering/leaving the plot is the ONLY thing that re-renders this
            // component on hover (the 24h row mounts with the pointer). The
            // numbers themselves go to the readout leaves on the next frame.
            const over = !!param?.time;
            if (over !== overPlotRef.current) {
                overPlotRef.current = over;
                setOverPlot(over);
            }
            measureAxis();
            const t = param?.time;
            setHoveredCandle(typeof t === 'number' && param?.point ? t : null);
            pendingCrossTime = typeof t === 'number' ? t : null;
            pendingCrossY = param?.point && Number.isFinite(Number(param.point.y)) ? Number(param.point.y) : null;
            pendingCrossPane = typeof param?.paneIndex === 'number' ? param.paneIndex : 0;
            if (crossFrame === null) crossFrame = window.requestAnimationFrame(flushCrosshair);
        };
        chart.subscribeCrosshairMove(onCrosshair);
        return () => {
            stopHoverAnimation();
            hoverAnimsRef.current.clear();
            hoveredCandleTimeRef.current = null;
            if (crossFrame !== null) {
                window.cancelAnimationFrame(crossFrame);
                crossFrame = null;
            }
            chart.unsubscribeCrosshairMove(onCrosshair);
            if (primitiveRef.current) {
                try { candles.detachPrimitive(primitiveRef.current); } catch { /* chart removed */ }
                primitiveRef.current = null;
            }
            chart.remove();
            chartRef.current = null;
            candlesRef.current = null;
            volumeRef.current = null;
            chartRowsRef.current = [];
            indicatorSeriesRef.current = [];
            subPaneSeriesRef.current = [];
            levelLinesRef.current = [];
            lastLineRef.current = null;
            // The chat-level lines died with the chart — forget them so the
            // next mount's diff recreates instead of applyOptions-ing ghosts.
            chatLevelLinesRef.current = new Map();
        };
    }, [measureAxis, setHoveredCandle, stopHoverAnimation, hoverReadout, setHoveredCandleAttr]);

    // Data lifecycle: the history load always runs (the stream only pushes
    // the CURRENT bar). Refresh cadence after that: while live the websocket
    // drives updates and no fast timer is armed — but a stall watchdog
    // re-syncs if the socket goes quiet; otherwise 15s (4s while empty).
    // Tracks symbol flips inside the data-lifecycle effect below (it also
    // re-runs on `live` toggles, which must NOT blank the chart).
    const dataSymbolRef = useRef(symbol);

    /**
     * The window the user is actually looking at, read from the live chart.
     *
     * Derived defensively: every accessor can throw or return null if the
     * series is mid-teardown (symbol switch, unmount), and a snapshot that
     * throws would take the whole chat turn down with it. Anything unreadable
     * comes back null, which the receipt reads as "cannot vouch for it" rather
     * than as "definitely visible".
     */
    const readVisibleRange = (): ChartSnapshot['visibleRange'] => {
        try {
            const chart = chartRef.current;
            const series = candlesRef.current;
            const host = hostRef.current;
            if (!chart || !series || !host) return null;
            const lr = chart.timeScale().getVisibleLogicalRange();
            if (!lr) return null;
            // The clip rect is (0, 0, plotW, plotH) with plotH = h - 28, so
            // y=0 is the top of the visible price band and y=plotH the bottom.
            // coordinateToPrice is the direction that maps pixels -> price;
            // priceToCoordinate would answer the opposite question.
            const plotH = Math.max(0, host.clientHeight - 28);
            if (plotH <= 0) return null;
            const top = series.coordinateToPrice(0);
            const bottom = series.coordinateToPrice(plotH);
            if (top === null || bottom === null || !Number.isFinite(top) || !Number.isFinite(bottom)) return null;
            return {
                priceLow: Math.min(top, bottom),
                priceHigh: Math.max(top, bottom),
                timeLow: (Number(lr.from) || 0) * 60,
                timeHigh: (Number(lr.to) || 0) * 60,
                barsLoaded: (series.data() ?? []).length,
                barsVisible: Math.max(0, Math.round(Number(lr.to) - Number(lr.from))),
            };
        } catch {
            return null;
        }
    };
    useEffect(() => {
        // Symbol switch: drop the PREVIOUS coin's artifacts immediately —
        // candles, volume and the price lines — so no stale price prints on
        // the new chart during the history fetch (the "BTC mark on a ZEN
        // chart" data-discrepancy flag).
        if (dataSymbolRef.current !== symbol) {
            dataSymbolRef.current = symbol;
            // The custom last-price line is a price line too — without this,
            // the previous coin's dotted line persisted onto the new chart
            // until a prop ticked (the last-price line was added later and
            // missed this cleanup).
            if (lastLineRef.current) {
                try { candlesRef.current?.removePriceLine(lastLineRef.current); } catch { /* series gone */ }
                lastLineRef.current = null;
            }
            setLastTag(null);
            lastTagRef.current = null;
            candlesRef.current?.setData([]);
            volumeRef.current?.setData([]);
            chartRowsRef.current = [];
            syncPrimitive();
            lastTickRef.current = Date.now();
        }
        let cancelled = false;
        let timer = 0;
        let watchdog = 0;
        // In-flight flag: the stall watchdog fires every 5 s while a fetch is
        // still pending — without this guard the stalled loads pile up.
        let inFlight = false;
        const load = async (isInitial: boolean): Promise<void> => {
            if (cancelled || inFlight) return;
            inFlight = true;
            try {
                // Refreshes (non-initial) bypass the 30 s kline cache — with it
                // the 15 s poll and the live-stall watchdog re-fetch the same
                // snapshot and the chart advances at ~30 s, half its cadence.
                // The initial (mount/coin-switch) load still rides the cache.
                const klines = await fetchKlines(symbol, toKlineInterval(interval), HISTORY_BARS, isInitial ? undefined : { noCache: true });
                if (cancelled) return;
                const cs = candlesRef.current;
                const vs = volumeRef.current;
                if (!cs || !vs || klines.length === 0) { setStatus('unavailable'); timer = window.setTimeout(() => void load(false), 4000); return; }
                const candles = toCandles(klines);
                chartRowsRef.current = candles;
                cs.setData(candles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
                vs.setData(toVolumes(klines).map(v => ({ ...v, time: v.time as UTCTimestamp })));
                setStatus('live');
                lastTickRef.current = Date.now();
                // The primitive projects the drawings through THIS row array —
                // the load replaces it, so re-publish before the repaint below.
                syncPrimitive();
                // Repaint the (already-reloaded) drawings against the fresh
                // bars NOW — a switch back sets `status` to 'live' when it is
                // already 'live', so the state-change repaint effect won't fire
                // and the shapes would stay unpainted until the next pan/zoom.
                repaintRef.current();
                if (isInitial) {
                    const ts = chartRef.current?.timeScale();
                    ts?.fitContent?.();
                    // A tick sitting exactly on the pane's left edge clips its
                    // axis label in half against the tool-rail seam. Pad the
                    // initial window with logical (empty) bars so the first
                    // labeled tick has room — spacing measured from the range
                    // fitContent actually produced (options().barSpacing is
                    // just the configured default, not the fitted one).
                    try {
                        const range = typeof ts?.getVisibleLogicalRange === 'function' ? ts.getVisibleLogicalRange() : null;
                        const width = hostRef.current?.clientWidth ?? 900;
                        const spacing = range ? width / Math.max(1, range.to - range.from) : 2;
                        const pad = (px: number): number => Math.ceil(px / Math.max(spacing, 0.25));
                        ts?.setVisibleLogicalRange?.({ from: (range?.from ?? 0) - pad(30), to: (range?.to ?? HISTORY_BARS) + pad(10) });
                    } catch { /* a mock without range APIs just keeps fitContent */ }
                }
                if (!live) timer = window.setTimeout(() => void load(false), REFRESH_MS);
            } catch {
                // EVERYTHING post-failure stays inside the cancellation guard:
                // arming the retry outside it kept dead-symbol effects retrying
                // a fetch every 4 s forever after a symbol switch.
                if (!cancelled) {
                    setStatus('unavailable');
                    timer = window.setTimeout(() => void load(false), 4000);
                }
            } finally {
                inFlight = false;
            }
        };
        void load(true);
        retryLoadRef.current = () => void load(false);
        if (live) {
            // Stall watchdog: any gap in the push stream gets healed by a
            // history re-sync instead of leaving a frozen last bar.
            watchdog = window.setInterval(() => {
                if (Date.now() - lastTickRef.current > LIVE_STALL_MS) void load(false);
            }, 5000);
        }
        return () => { cancelled = true; retryLoadRef.current = null; window.clearTimeout(timer); window.clearInterval(watchdog); };
    }, [symbol, interval, live, syncPrimitive]);

    // Live kline stream: patch the last bar in place (sub-second ticks).
    useEffect(() => {
        if (!liveKline || !candlesRef.current || !volumeRef.current) return;
        lastTickRef.current = Date.now();
        const t = Math.floor(liveKline.openTime / 1000);
        candlesRef.current.update({
            time: t as UTCTimestamp,
            open: liveKline.open, high: liveKline.high, low: liveKline.low, close: liveKline.close,
        });
        // The weight mirror rides the same tick: the forming bar's VWAP/CVD
        // move with its volume, and a new bar opens a fresh row.
        {
            const rows = chartRowsRef.current;
            const lastRow = rows[rows.length - 1];
            const row: ChartRow = { time: t, open: liveKline.open, high: liveKline.high, low: liveKline.low, close: liveKline.close, volume: liveKline.volume };
            if (lastRow && lastRow.time === t) rows[rows.length - 1] = row;
            else rows.push(row);
        }
        volumeRef.current.update({
            time: t as UTCTimestamp,
            value: liveKline.volume,
            color: liveKline.close >= liveKline.open ? VOLUME_UP : VOLUME_DOWN,
        });
        // A closed bar means the next tick opens a NEW bar — keep history
        // honest without waiting for the watchdog. Bypass the cache: the whole
        // point is the just-finalized OHLC, which a 30 s-old cached page of
        // 3 would still report at its pre-close value.
        if (liveKline.closed) {
            const cs = candlesRef.current;
            void fetchKlines(symbol, toKlineInterval(interval), 3, { noCache: true }).then(kl => {
                if (kl.length === 0 || cs.data().length === 0) return;
                const last = kl[kl.length - 1];
                const tClosed = Math.floor(last.time / 1000);
                cs.update({ time: tClosed as UTCTimestamp, open: last.open, high: last.high, low: last.low, close: last.close });
                {
                    const rows = chartRowsRef.current;
                    const row: ChartRow = { time: tClosed, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume, takerBuyVolume: last.takerBuyVolume };
                    if (rows.length && rows[rows.length - 1].time === tClosed) rows[rows.length - 1] = row;
                    else rows.push(row);
                }
                // The finalized OHLC can differ from the tick's last print, so
                // the just-closed bar's study values move too — full rewrite.
                refreshIndicatorsRef.current(true);
            }).catch(() => { /* the next tick or the watchdog covers it */ });
            // And a full rewrite now, for the bar close THIS tick carried.
            refreshIndicatorsRef.current(true);
        }
    }, [liveKline, symbol, interval]);

    // The last-price line: DOTTED and coloured by the last candle's direction,
    // which is what OKX draws. Re-created rather than restyled because the
    // colour changes with every tick.
    useEffect(() => {
        const cs = candlesRef.current;
        if (!cs) return;
        const removeLine = (): void => {
            if (lastLineRef.current) {
                try { cs.removePriceLine?.(lastLineRef.current); } catch { /* already gone */ }
                lastLineRef.current = null;
            }
        };
        const data = (cs.data?.() ?? []) as readonly { open: number; close: number }[];
        const last = data[data.length - 1];
        if (!last) { removeLine(); return; }
        const up = last.close >= last.open;
        const color = up ? chartColor('--color-emerald-500', '#22c55e') : chartColor('--color-rose-500', '#ef4444');
        const opts = { price: last.close, color, lineWidth: 1 as const, lineStyle: 1 as const };
        if (lastLineRef.current) {
            try { lastLineRef.current.applyOptions(opts); return; } catch { removeLine(); }
        }
        try {
            // No axis label: the chart draws its own tag with a countdown.
            lastLineRef.current = cs.createPriceLine({ ...opts, axisLabelVisible: false }) ?? null;
        } catch { /* series without price-line support (test mock) */ }
        updateLastTag();
    }, [symbol, lastPrice, status, interval, liveKline, updateLastTag]);

    // Indicator overlays. Every series comes from `chartIndicators`, the ONE
    // series module: the chart's lines, this legend, and — as the desk tools
    // migrate onto it (O-150) — the prompt's numbers share one computation.
    // The hand-rolled `sma()` is retired with it.
    //
    // Two phases, deliberately split:
    // · BUILD (this effect) tears down and re-creates the series, wired to
    //   the pane layout — only when the symbol, the interval, the visible
    //   studies or the chart's readiness change (removePane shifts every pane
    //   above it, so a stale index would put the wrong study in the wrong
    //   pane; hence the whole-set rebuild here and nowhere else);
    // · REFRESH (`refreshIndicatorsRef`) recomputes every study against the
    //   CURRENT candles and pushes values into the SAME series, so the lines
    //   track the live tape instead of freezing at load — a live 1m chart
    //   used to leave the EMA20 ending about an hour back while OKX keeps
    //   recomputing. Recursive studies only ever move their LAST point on a
    //   forming bar, so a forming tick is one `update` per series and a
    //   closed bar is one full `setData` per series.
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        for (const s of indicatorSeriesRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
        indicatorSeriesRef.current = [];
        indicatorDefsRef.current = [];
        const candles = chartRowsRef.current.length > 0
            ? chartRowsRef.current
            : (candlesRef.current?.data?.() ?? []) as readonly ChartRow[];
        // The visibility mirror is refreshed BEFORE the empty-candles return:
        // `repaint` reads it from a non-React callback, and leaving it on the
        // previous set made a toggle that landed during a load paint the OLD
        // studies until the next tick.
        const visible = indicatorSettings.visible;
        visibleRef.current = visible;
        bandRef.current = null;
        bandCalcRef.current = null;
        if (candles.length === 0) { refreshIndicatorsRef.current = () => {}; scheduleRepaint(); return; }
        const closesOf = (cs: readonly ChartRow[]): number[] => cs.map(c => c.close);
        /** Register a main-pane line study: create the series now, remember
         *  how to recompute its values from any later candle array, and file
         *  the raw series under its legend key. */
        const addLine = (calc: (cs: readonly ChartRow[]) => Series, color: string, name?: string): void => {
            const series = chart.addSeries(LineSeries, {
                color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
            });
            indicatorSeriesRef.current.push(series);
            indicatorDefsRef.current.push({ series, kind: 'line', name, calc });
        };
        if (visible.ema20) addLine(cs => emaSeries(closesOf(cs), 20), chartColor('--color-zinc-500', '#71717a'), 'ema20');
        if (visible.ema200) addLine(cs => emaSeries(closesOf(cs), 200), chartColor('--color-zinc-400', '#a1a1aa'), 'ema200');
        if (visible.boll) {
            const bollColor = chartColor('--color-zinc-500', '#71717a');
            addLine(cs => bollingerSeries(closesOf(cs), 20, 2).mid, bollColor, 'bollMid');
            addLine(cs => bollingerSeries(closesOf(cs), 20, 2).upper, bollColor, 'bollUpper');
            addLine(cs => bollingerSeries(closesOf(cs), 20, 2).lower, bollColor, 'bollLower');
            bandCalcRef.current = (cs) => bollingerSeries(closesOf(cs), 20, 2);
        }
        // VWAP: session (UTC-day reset) by default; the ANCHORED variant runs
        // from the bar the trader Alt+clicked (avwapAnchorRef), which is a
        // question about THIS read, not a preference — so it lives in view
        // state and a new anchor just re-runs REFRESH, no rebuild.
        if (visible.vwap) addLine(cs => vwapSeries(cs, null), chartColor('--color-zinc-400', '#a1a1aa'), 'vwap');
        if (visible.avwap) addLine(cs => vwapSeries(cs, avwapAnchorRef.current), chartColor('--color-zinc-400', '#a1a1aa'), 'avwap');
        // Sub-panes, in a FIXED order so the indices are deterministic.
        for (const s of subPaneSeriesRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
        subPaneSeriesRef.current = [];
        while (chart.panes().length > 1) {
            try { chart.removePane(chart.panes().length - 1); } catch { break; }
        }
        const addSub = (series: ISeriesApi<SeriesType>): void => { subPaneSeriesRef.current.push(series); };
        const putLine = (pane: number, calc: (cs: readonly ChartRow[]) => Series, color: string, scaleId?: string, name?: string): void => {
            const s = chart.addSeries(LineSeries, {
                color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
                crosshairMarkerVisible: false, ...(scaleId ? { priceScaleId: scaleId } : {}),
            }, pane);
            addSub(s);
            indicatorDefsRef.current.push({ series: s, kind: 'line', name, calc });
        };
        const putHist = (pane: number, calc: (cs: readonly ChartRow[]) => Series, name?: string): void => {
            const s = chart.addSeries(HistogramSeries, {
                priceLineVisible: false, lastValueVisible: false,
            }, pane);
            addSub(s);
            indicatorDefsRef.current.push({ series: s, kind: 'hist', name, calc });
        };
        let paneIndex = 1;
        for (const id of SUB_PANE_ORDER) {
            if (!visible[id]) continue;
            const pane = paneIndex;
            if (id === 'rsi') {
                putLine(pane, cs => rsiSeries(closesOf(cs), 6), chartColor('--color-zinc-400', '#a1a1aa'), 'rsi', 'rsi6');
                putLine(pane, cs => rsiSeries(closesOf(cs), 14), chartColor('--color-zinc-400', '#a1a1aa'), 'rsi', 'rsi14');
                putLine(pane, cs => rsiSeries(closesOf(cs), 24), chartColor('--color-lime-400', '#a3e635'), 'rsi', 'rsi24');
                chart.priceScale('rsi', pane).applyOptions({ visible: false });
            } else if (id === 'macd') {
                putHist(pane, cs => macdSeries(closesOf(cs)).histogram, 'macdHist');
                putLine(pane, cs => macdSeries(closesOf(cs)).macd, chartColor('--color-zinc-500', '#71717a'), undefined, 'macd');
                putLine(pane, cs => macdSeries(closesOf(cs)).signal, chartColor('--color-zinc-400', '#a1a1aa'), undefined, 'macdSignal');
            } else if (id === 'tsi') {
                putLine(pane, cs => tsiSeries(closesOf(cs)).tsi, chartColor('--color-zinc-500', '#71717a'), 'tsi', 'tsi');
                putLine(pane, cs => tsiSeries(closesOf(cs)).signal, chartColor('--color-zinc-400', '#a1a1aa'), 'tsi', 'tsiSignal');
                chart.priceScale('tsi', pane).applyOptions({ visible: false });
            } else if (id === 'cvd') {
                // REAL taker delta — the delta DEFINITION is orderFlowCore's
                // candleDelta (one source with the desk; family 36 pins it),
                // but the cumulative is built bar-robustly here: a forming
                // live bar has no taker-buy field yet, and deltaSeries' whole-
                // window all-or-null rule (right for the desk's read) would
                // collapse the chart's CVD to nothing on every live tick. A
                // bar without taker-buy yields null and the cumulative carries.
                putHist(pane, cs => cs.map(c => {
                    const d = candleDelta({ ...c, volume: c.volume ?? 0 });
                    return d;
                }), 'cvdDelta');
                putLine(pane, cs => {
                    let cum = 0;
                    return cs.map(c => {
                        const d = candleDelta({ ...c, volume: c.volume ?? 0 });
                        if (d === null) return null;
                        cum += d;
                        return cum;
                    });
                }, chartColor('--color-zinc-300', '#d4d4d8'), undefined, 'cvd');
            }
            const paneApi = chart.panes()[pane];
            if (paneApi) paneApi.setHeight(110);
            paneIndex += 1;
        }
        // REFRESH: recompute every registered study from the current candles
        // and push into the SAME series — no teardown, no flicker. `full`
        // rewrites whole series (a bar closed, so past points moved too);
        // otherwise only each series' last point moves.
        refreshIndicatorsRef.current = (full: boolean): void => {
            const cs = chartRowsRef.current.length > 0
                ? chartRowsRef.current
                : (candlesRef.current?.data?.() ?? []) as readonly ChartRow[];
            if (cs.length === 0) return;
            const times = cs.map(c => c.time as UTCTimestamp);
            const legendSeries: Record<string, Series> = {};
            // SESSION LEVELS and SWINGS are not series — levels are horizontal
            // lines and swings are point markers — so they are computed here and
            // painted by `repaint` from these refs. Both read the DESK's cores
            // (levelsCore, swingStructureCore), never a reimplementation: the
            // same levels the `session_levels` tool reports.
            sessionLevelsRef.current = [];
            swingsRef.current = null;
            const closesNow = closesOf(cs);
            const reference = closesNow[closesNow.length - 1];
            const visibleNow = visibleRef.current;
            if (visibleNow.sessionLevels && Number.isFinite(reference)) {
                const atr = lastOf(atrSeries(cs.map(c => c.high), cs.map(c => c.low), closesNow, 14));
                // Half an ATR is the desk's touch tolerance: tight enough that
                // two sessions' lines do not collapse into one, loose enough
                // that a near-miss still counts as the same level.
                const tolerance = (atr ?? Math.abs(reference) * 0.002) * 0.5;
                sessionLevelsRef.current = sessionLevelRows(klinesOf(cs), Date.now(), reference, atr, tolerance);
            }
            if (visibleNow.swings) {
                swingsRef.current = readStructure(klinesOf(cs), 2);
            }
            for (const def of indicatorDefsRef.current) {
                const values = def.calc(cs);
                if (def.name) legendSeries[def.name] = values;
                const points = times
                    .map((t, i) => {
                        const v = values[i];
                        if (v === null) return null;
                        // OKX's MACD row is 2·(DIF−DEA), and the legend and
                        // `get_chart_studies` already print that. The module
                        // keeps the histogram at 1× for library parity, so the
                        // doubling belongs HERE — otherwise the bar and the
                        // number beside it describe two different studies.
                        return def.kind === 'hist'
                            ? { time: t, value: 2 * v, color: v >= 0 ? MACD_HIST_UP : MACD_HIST_DOWN }
                            : { time: t, value: v };
                    })
                    .filter((p): p is { time: UTCTimestamp; value: number; color?: string } => p !== null);
                try {
                    if (full || points.length === 0) def.series.setData(points);
                    else def.series.update(points[points.length - 1]);
                } catch {
                    // `update()` refuses a timestamp older than the series'
                    // last one. That is reachable: CVD's forming bar has no
                    // taker-buy field, so the last non-null point can lag the
                    // series and `points[points.length - 1]` is an OLDER bar.
                    // A full setData is the correct recovery; swallowing the
                    // error left the study frozen with no signal. The second
                    // catch is only for a series torn down mid-frame.
                    try { def.series.setData(points); } catch { /* unmounted */ }
                }
            }
            const bandCalc = bandCalcRef.current;
            if (bandCalc) {
                const band = bandCalc(cs);
                bandRef.current = { times: cs.map(c => c.time), upper: band.upper, lower: band.lower };
                legendSeries.bollMid = band.mid;
                legendSeries.bollUpper = band.upper;
                legendSeries.bollLower = band.lower;
            }
            // The legend mirror: a forming tick changes exactly ONE row — the
            // last — so on `full === false` only that row (and its volume) is
            // patched instead of rebuilding a 1000-entry array triple plus a
            // Map on every tick. A full refresh (bar closed, settings change,
            // reload) rebuilds wholesale, because past rows legitimately move.
            const lastRow = cs[cs.length - 1];
            const prevLegend = legendRef.current;
            if (!full && prevLegend && prevLegend.times.length === cs.length && prevLegend.bars.length === cs.length) {
                prevLegend.times[cs.length - 1] = lastRow.time;
                prevLegend.bars[cs.length - 1] = { open: lastRow.open, high: lastRow.high, low: lastRow.low, close: lastRow.close };
                prevLegend.volumes.set(lastRow.time, (volumeRef.current?.data?.() as readonly { time: number; value: number }[] | undefined)?.slice(-1)[0]?.value ?? 0);
                prevLegend.series = legendSeries;
            } else {
                legendRef.current = {
                    times: cs.map(c => c.time),
                    bars: cs.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
                    volumes: new Map(((volumeRef.current?.data?.() ?? []) as readonly { time: number; value: number }[])
                        .map(p => [p.time, p.value] as const)),
                    series: legendSeries,
                };
            }
            // SCHEDULED, not synchronous. A toggle goes through BUILD, which
            // has just removed and re-added series; the price scale and the
            // pane heights are invalidated but NOT re-laid-out until
            // lightweight-charts' next frame. Painting here converted prices
            // through the stale space, so the canvas studies (swings, session
            // levels, volume profile, the Bollinger fill) drew at yesterday's
            // coordinates or not at all — the "some indicators don't update
            // visually" report. Deferring to the next frame paints against the
            // space the trader is about to see.
            scheduleRepaint();
            // too. Without this the legend froze at the last effect run: the
            // refresh mutated the mirror but never told anyone, and no dep of
            // the at-rest effect changes on a tick. The readout store drops a
            // write that would not change a character, so a tick that did not
            // move the bar costs nothing — and the crosshair always wins while
            // the pointer is over the plot.
            if (!overPlotRef.current && cs.length > 0) {
                const lastIdx = cs.length - 1;
                const row = cs[lastIdx];
                const values: Record<string, number | null> = {};
                for (const [k, s] of Object.entries(legendSeries)) values[k] = s[lastIdx] ?? null;
                hoverReadout.setBar({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, values });
            }
        };
        refreshIndicatorsRef.current(true);
    }, [symbol, interval, indicatorSettings, status, scheduleRepaint]);

    // The live tape drives REFRESH: every tick re-places the studies' last
    // point, and a closed bar rewrites them whole (the Bollinger window
    // slides, so past points legitimately move on a close).
    useEffect(() => {
        if (!liveKline) return;
        refreshIndicatorsRef.current(liveKline.closed === true);
    }, [liveKline]);

    /** At rest the legend describes the LAST bar, as OKX's does. While the
     *  pointer is over the plot the crosshair handler owns it. */
    useEffect(() => {
        if (overPlot) return;
        const data = legendRef.current;
        if (!data || data.times.length === 0) return;
        const idx = data.times.length - 1;
        const bar = data.bars[idx];
        if (!bar) return;
        const values: Record<string, number | null> = {};
        for (const [k, s] of Object.entries(data.series)) values[k] = s[idx] ?? null;
        hoverReadout.setBar({ time: data.times[idx], ...bar, values });
        // Re-arm the "same bar" gate on the bar the legend now shows: leaving a
        // bar and hovering it again must update, not be mistaken for a repeat.
        legendTimeRef.current = data.times[idx];
        setHoveredCandleAttr(null);
    }, [overPlot, indicatorSettings, symbol, interval, status, hoverReadout, setHoveredCandleAttr]);

    /** The legend's volume column: contracts at the bar, from the chart's own
     *  mirror (the same rows the study values come from). */
    const volumeFor = useCallback((time: number): number | null => {
        const v = legendRef.current?.volumes.get(time);
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }, []);

    // ─── Chat key-level lines (the message card's chart toggle) ────────────
    // The dock owns the whole interaction model (master show-all switch,
    // per-row pins, hover previews) and pushes the RESOLVED line set here.
    // This effect diffs it against the live lines: ids that vanished (or went
    // hidden / another coin's payload) come off; new ones are created; the
    // rest get applyOptions — dim dashed while merely "shown", full color for
    // pinned, solid 2px while hovered ("preview"), exactly the prototype's
    // opacity semantics (50% default, 100% on .pin/.on).
    useEffect(() => {
        const cs = candlesRef.current;
        const lines = (chatLevels && chatLevels.symbol === symbol ? chatLevels.lines : [])
            .filter(l => l.state !== 'hidden' && Number.isFinite(l.price) && l.price > 0);
        const wanted = new Map(lines.map(l => [l.id, l] as const));
        for (const [id, line] of [...chatLevelLinesRef.current]) {
            if (!wanted.has(id)) {
                try { cs?.removePriceLine?.(line); } catch { /* already gone */ }
                chatLevelLinesRef.current.delete(id);
            }
        }
        if (!cs) return;
        for (const l of wanted.values()) {
            const bright = l.state === 'pinned' || l.state === 'preview';
            const opts = {
                // 8-digit hex alpha dims a merely-SHOWN line; pinned/preview
                // print at full strength so the table↔chart link is legible.
                price: l.price,
                color: bright ? l.color : `${l.color}80`,
                lineWidth: l.state === 'preview' ? 2 : 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: l.label,
            } as const;
            const existing = chatLevelLinesRef.current.get(l.id);
            if (existing) {
                try { existing.applyOptions(opts); continue; } catch { /* recreate below */ }
            }
            try {
                chatLevelLinesRef.current.set(l.id, cs.createPriceLine(opts));
            } catch { /* series without price-line support (test mock) */ }
        }
    }, [chatLevels, symbol, status]);

    // Verdict levels: horizontal lines per Entry/SL/TP with labels.
    useEffect(() => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return;
        const next = verdictLevels(verdict, symbol);
        setLevels(next);
        levelLinesRef.current.forEach(l => { try { chart.removeSeries(l); } catch { /* already gone */ } });
        levelLinesRef.current = next.map(level => {
            const line = chart.addSeries(LineSeries, {
                color: level.color,
                lineWidth: 1,
                lineStyle: level.dashed ? 2 : 0,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                // A verdict's levels can sit far from the current price — a
                // plan logged hours ago, a stale signal. fitContent() fits
                // EVERY series, so leaving these in the autoscale zooms the
                // chart out until the candles are a strip at the bottom.
                // Returning null opts the line out: it still draws, but the
                // price scale stays anchored to the candles.
                autoscaleInfoProvider: () => null,
            });
            const data = (cs.data?.() ?? []) as readonly { time: number }[];
            if (data.length > 0) line.setData([{ time: data[0].time as UTCTimestamp, value: level.price }, { time: data[data.length - 1].time as UTCTimestamp, value: level.price }]);
            return line;
        });
    }, [verdict, symbol, status]);

    // ─── Drawing overlay: data↔screen conversion ────────────────────────────
    // x converts through the time scale's LOGICAL space (bar index), y through
    // the series' price space. Logical indexes anchor to the loaded bars —
    // NOT to whatever is visible — so a shape stays glued to the SAME bar
    // through pan, zoom and new-bar appends, and drawing WORKS while the
    // early candles are scrolled far off-screen (the previous anchor-time
    // conversion asked timeToCoordinate for a possibly hidden bar, got null,
    // and silently killed every tool: clicks drew a preview that never
    // committed, existing shapes vanished on pan).

    const toScreen = useCallback((p: DrawPoint): { x: number; y: number } | null => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return null;
        const ts = chart.timeScale();
        // Test mocks (and mid-teardown windows) may lack the logical API —
        if (typeof ts.logicalToCoordinate !== 'function' || typeof cs.priceToCoordinate !== 'function') return null;
        const bars = chartRowsRef.current.length > 0
            ? chartRowsRef.current
            : ((cs.data?.() ?? []) as readonly { time: number }[]);
        if (bars.length === 0) return null;
        const x = projectTimestampToX(p.t, bars, intervalSeconds(interval), {
            logicalToCoordinate: l => {
                const c = ts.logicalToCoordinate(l as never);
                return c === null || c === undefined ? null : Number(c);
            },
            coordinateToLogical: cx => {
                const l = ts.coordinateToLogical(cx);
                return l === null || l === undefined ? null : Number(l);
            },
        });
        if (x === null) return null;
        const y = cs.priceToCoordinate(p.p as never);
        if (y === null || y === undefined || !Number.isFinite(Number(y))) return null;
        return { x, y: Number(y) };
    }, [interval]);

    const toData = useCallback((x: number, y: number): DrawPoint | null => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return null;
        const ts = chart.timeScale();
        if (typeof ts.coordinateToLogical !== 'function' || typeof cs.coordinateToPrice !== 'function') return null;
        const p = cs.coordinateToPrice(y);
        if (p === null || p === undefined || !Number.isFinite(Number(p))) return null;
        const bars = chartRowsRef.current.length > 0
            ? chartRowsRef.current
            : ((cs.data?.() ?? []) as readonly { time: number }[]);
        if (bars.length === 0) return null;
        const t = screenXToTimestamp(x, bars, intervalSeconds(interval), {
            logicalToCoordinate: l => {
                const c = ts.logicalToCoordinate(l as never);
                return c === null || c === undefined ? null : Number(c);
            },
            coordinateToLogical: cx => {
                const l = ts.coordinateToLogical(cx);
                return l === null || l === undefined ? null : Number(l);
            },
        });
        if (t === null) return null;
        return { t, p: Number(p) };
    }, [interval]);

    /** Pull a screen point onto the nearest candle's OHLC using effective magnet mode (Weak 12px / Strong 36px, Ctrl flips). */
    const magnetPoint = useCallback((pt: ScreenXY, ctrlPressed = false): MagnetSnapResult => {
        const effective = resolveEffectiveMagnetMode(magnetModeRef.current, ctrlPressed);
        const thresholdPx = resolveMagnetThresholdPx(effective);
        if (thresholdPx <= 0) return { snapped: false, x: pt.x, y: pt.y };
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs || typeof cs.priceToCoordinate !== 'function') {
            return { snapped: false, x: pt.x, y: pt.y };
        }
        const ts = chart.timeScale();
        if (typeof ts.logicalToCoordinate !== 'function' || typeof ts.coordinateToLogical !== 'function') {
            return { snapped: false, x: pt.x, y: pt.y };
        }
        const bars: ReadonlyArray<EvalCandle> = chartRowsRef.current.length > 0
            ? chartRowsRef.current
            : ((cs.data?.() ?? []) as readonly EvalCandle[]);
        if (bars.length === 0) return { snapped: false, x: pt.x, y: pt.y };
        const scaleAdapter = {
            logicalToCoordinate: (l: number) => {
                const c = ts.logicalToCoordinate(l as never);
                return c === null || c === undefined ? null : Number(c);
            },
            coordinateToLogical: (cx: number) => {
                const l = ts.coordinateToLogical(cx);
                return l === null || l === undefined ? null : Number(l);
            },
        };
        const step = intervalSeconds(interval);
        return snapToOhlcMagnet(
            pt,
            bars,
            time => projectTimestampToX(time, bars, step, scaleAdapter),
            price => {
                const y = cs.priceToCoordinate(price as never);
                return y === null || y === undefined ? null : Number(y);
            },
            thresholdPx,
        );
    }, [interval]);

    // Paint committed drawings + the in-progress draft onto the overlay.
    const repaint = useCallback((): void => {
        const canvas = overlayRef.current;
        const host = hostRef.current;
        if (!canvas || !host) return;
        const dpr = window.devicePixelRatio || 1;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // Never paint over the price-axis gutter (MEASURED — it is
        // content-sized and moves when a label widens) or the time axis.
        const plotW = Math.max(0, w - axisWRef.current);
        const plotH = Math.max(0, h - 28);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, plotW, plotH);
        ctx.clip();

        // Bollinger band fill: upper forward, lower backward, closed. Painted
        // BEFORE the drawings so a shape the trader drew on the band still
        // reads on top of the shade. Only the VISIBLE bars are converted —
        // each bar costs two coordinate transforms, and with 1000 bars loaded
        // the off-screen ~90% were pure per-frame waste (the plot clip already
        // discarded their pixels; this discards their work too).
        const band = bandRef.current;
        if (band) {
            const bandTs = chartRef.current?.timeScale();
            const bandRange = bandTs && typeof bandTs.getVisibleLogicalRange === 'function'
                ? bandTs.getVisibleLogicalRange()
                : null;
            const firstIdx = bandRange ? Math.max(0, Math.floor(Number(bandRange.from)) - 2) : 0;
            const lastIdx = bandRange ? Math.min(band.upper.length - 1, Math.ceil(Number(bandRange.to)) + 2) : band.upper.length - 1;
            const top: { x: number; y: number }[] = [];
            const bottom: { x: number; y: number }[] = [];
            for (let i = firstIdx; i <= lastIdx; i += 1) {
                if (band.upper[i] === null || band.lower[i] === null) continue;
                const hi = toScreen({ t: band.times[i], p: band.upper[i] as number });
                const lo = toScreen({ t: band.times[i], p: band.lower[i] as number });
                if (hi) top.push(hi);
                if (lo) bottom.push(lo);
            }
            if (top.length > 1 && bottom.length > 1) {
                ctx.beginPath();
                ctx.moveTo(top[0].x, top[0].y);
                for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i].x, top[i].y);
                for (let i = bottom.length - 1; i >= 0; i -= 1) ctx.lineTo(bottom[i].x, bottom[i].y);
                ctx.closePath();
                ctx.fillStyle = 'rgba(6, 182, 212, 0.09)';
                ctx.fill();
            }
        }

        // The anchored VWAP's anchor: a thin vertical marker on the bar the
        // trader Alt+clicked, so the anchor is a visible fact, not a guess
        // about where the average starts. Repaint keeps it under pan/zoom.
        if (visibleRef.current.avwap && avwapAnchorRef.current !== null) {
            const ax = toScreen({ t: avwapAnchorRef.current, p: 0 });
            if (ax) {
                ctx.save();
                ctx.strokeStyle = chartColor('--color-zinc-400', '#a1a1aa');
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(ax.x, 0);
                ctx.lineTo(ax.x, plotH);
                ctx.stroke();
                ctx.restore();
            }
        }

        // THE VOLUME PROFILE: the desk's ONE buildVolumeProfile (family 36 pins
        // its math), drawn as a horizontal histogram hugging the right edge with
        // POC/VAH/VAL lines. A right-edge histogram is geometry, not a series,
        // so this is canvas work beside the fill, not a chartIndicators entry.
        // Two anchorings, because the spec asked for both: the VISIBLE range
        // (OKX's VPVR, recomputed per pan) and the current UTC SESSION.
        const paintProfile = (rows: ChartRow[], tone: 'range' | 'session'): void => {
            if (rows.length === 0) return;
            const prof = buildVolumeProfile(
                rows.map(c => ({ ...c, volume: c.volume ?? 0 })),
                { bins: 48 },
            );
            if (!prof) return;
            const vpPriceY = (p: number): number | null => {
                const y = candlesRef.current?.priceToCoordinate?.(p as never);
                return y === null || y === undefined || !Number.isFinite(Number(y)) ? null : Number(y);
            };
            const maxBin = Math.max(...prof.bins.map(b => b.volume));
            const maxW = plotW * 0.22;
            const barColor = tone === 'range' ? 'rgba(148, 163, 184, 0.30)' : 'rgba(180, 130, 220, 0.26)';
            ctx.save();
            for (const b of prof.bins) {
                if (b.volume <= 0) continue;
                const yTop = vpPriceY(b.priceHigh);
                const yBot = vpPriceY(b.priceLow);
                if (yTop === null || yBot === null) continue;
                const w = (b.volume / maxBin) * maxW;
                ctx.fillStyle = barColor;
                ctx.fillRect(plotW - w, yTop, w, Math.max(1, yBot - yTop - 1));
            }
            // POC (solid amber) and the value-area bounds (dashed).
            const hline = (price: number, color: string, dashed: boolean, label: string): void => {
                const y = vpPriceY(price);
                if (y === null) return;
                ctx.strokeStyle = color;
                ctx.setLineDash(dashed ? [4, 4] : []);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(plotW, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = '9px ui-monospace, monospace';
                ctx.fillStyle = color;
                ctx.fillText(label, plotW - ctx.measureText(label).width - 4, y - 3);
            };
            const pocColor = chartColor('--color-zinc-400', '#a1a1aa');
            const vaColor = chartColor('--color-zinc-500', '#71717a');
            hline(prof.valueAreaHigh, vaColor, true, 'VAH');
            hline(prof.valueAreaLow, vaColor, true, 'VAL');
            hline(prof.poc, pocColor, false, 'POC');
            ctx.restore();
        };
        if (visibleRef.current.volumeProfile) {
            const vpTs = chartRef.current?.timeScale();
            const vpRows = chartRowsRef.current;
            const vpRange = vpTs && typeof vpTs.getVisibleLogicalRange === 'function' ? vpTs.getVisibleLogicalRange() : null;
            if (vpRange && vpRows.length > 0) {
                const first = Math.max(0, Math.floor(Number(vpRange.from)));
                const last = Math.min(vpRows.length - 1, Math.ceil(Number(vpRange.to)));
                paintProfile(vpRows.slice(first, last + 1), 'range');
            }
        }
        if (visibleRef.current.volumeProfileSession) {
            // The current UTC day, up to the last loaded bar.
            const all = chartRowsRef.current;
            if (all.length > 0) {
                const dayStart = Math.floor(all[all.length - 1].time / 86400) * 86400;
                const session = all.filter(c => c.time >= dayStart);
                paintProfile(session, 'session');
            }
        }

        // SESSION LEVELS: dashed horizontal lines with their tag on the right
        // edge, from the DESK's levelsCore — the same rows the
        // `session_levels` tool reports, so the chart and the model cannot
        // disagree about where Asia's high is.
        const levels = sessionLevelsRef.current;
        if (levels.length > 0) {
            ctx.save();
            ctx.font = '9px ui-monospace, monospace';
            for (const row of levels) {
                const y = candlesRef.current?.priceToCoordinate?.(row.price as never);
                if (y === null || y === undefined || !Number.isFinite(Number(y))) continue;
                const above = row.side === 'above';
                ctx.strokeStyle = above ? 'rgba(244, 63, 94, 0.40)' : 'rgba(16, 185, 129, 0.40)';
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(0, Number(y));
                ctx.lineTo(plotW, Number(y));
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = above ? 'rgba(244, 63, 94, 0.80)' : 'rgba(16, 185, 129, 0.80)';
                ctx.fillText(row.label, plotW - ctx.measureText(row.label).width - 4, Number(y) - 3);
            }
            ctx.restore();
        }

        // SWINGS: a triangle on each swing high/low, and the last structural
        // break labelled. From swingStructureCore — the desk's own read.
        const structure = swingsRef.current;
        if (structure) {
            ctx.save();
            ctx.font = '9px ui-monospace, monospace';
            const swTs = chartRef.current?.timeScale();
            for (const sw of structure.swings) {
                const x = swTs?.logicalToCoordinate(sw.index as never);
                const y = candlesRef.current?.priceToCoordinate?.(sw.price as never);
                if (x === null || x === undefined || y === null || y === undefined) continue;
                ctx.fillStyle = sw.kind === 'high' ? '#fafafa' : '#a1a1aa';
                const yy = sw.kind === 'high' ? Number(y) - 6 : Number(y) + 6;
                ctx.beginPath();
                if (sw.kind === 'high') {
                    ctx.moveTo(Number(x), yy - 4);
                    ctx.lineTo(Number(x) - 3.5, yy + 2);
                    ctx.lineTo(Number(x) + 3.5, yy + 2);
                } else {
                    ctx.moveTo(Number(x), yy + 4);
                    ctx.lineTo(Number(x) - 3.5, yy - 2);
                    ctx.lineTo(Number(x) + 3.5, yy - 2);
                }
                ctx.closePath();
                ctx.fill();
            }
            if (structure.lastBreak) {
                const b = structure.lastBreak;
                const y = candlesRef.current?.priceToCoordinate?.(b.level as never);
                if (y !== null && y !== undefined && Number.isFinite(Number(y))) {
                    ctx.fillStyle = b.kind === 'BOS' ? '#fafafa' : '#a1a1aa';
                    ctx.fillText(`${b.kind} ${b.direction}`, 6, Number(y) - 4);
                }
            }
            ctx.restore();
        }

        // HOVERED CANDLE FOCUS: smoothly scales and brightens the hovered
        // candle (and gracefully fades out neighbors during sweeps) right on
        // the main pane so the trader gets immediate tactile focus feedback
        // without mutating the 1000-bar series or obscuring drawings/tags.
        if (hoverAnimsRef.current.size > 0) {
            const hoverChart = chartRef.current;
            const hoverSeries = candlesRef.current;
            const hoverTs = hoverChart?.timeScale();
            if (hoverChart && hoverSeries && hoverTs
                && typeof hoverTs.logicalToCoordinate === 'function'
                && typeof hoverSeries.priceToCoordinate === 'function') {
                const bars = chartRowsRef.current.length > 0
                    ? chartRowsRef.current
                    : ((hoverSeries.data?.() ?? []) as readonly ChartRow[]);
                if (bars.length > 0) {
                    const mainPaneH = (() => {
                        try {
                            const h0 = hoverChart.panes?.()?.[0]?.getHeight?.();
                            return typeof h0 === 'number' && Number.isFinite(h0) && h0 > 0
                                ? Math.min(plotH, h0)
                                : plotH;
                        } catch {
                            return plotH;
                        }
                    })();
                    let barSpacing = 6;
                    if (bars.length >= 2) {
                        const refIdx = Math.floor((bars.length - 1) / 2);
                        const rx1 = hoverTs.logicalToCoordinate(refIdx as never);
                        const rx2 = hoverTs.logicalToCoordinate((refIdx + 1) as never);
                        if (rx1 !== null && rx1 !== undefined && rx2 !== null && rx2 !== undefined) {
                            const measured = Math.abs(Number(rx2) - Number(rx1));
                            if (Number.isFinite(measured) && measured > 0) barSpacing = measured;
                        }
                    } else {
                        const configured = hoverTs.options?.()?.barSpacing;
                        if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
                            barSpacing = configured;
                        }
                    }
                    const upColor = CANDLE_UP();
                    const downColor = CANDLE_DOWN();
                    const activeEntries = [...hoverAnimsRef.current.entries()]
                        .filter(([, p]) => p > 0.001)
                        .sort((a, b) => a[1] - b[1]);
                    if (activeEntries.length > 0) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(0, 0, plotW, mainPaneH);
                        ctx.clip();
                        for (const [barTime, progress] of activeEntries) {
                            const idx = findCandleIndexByTime(bars, barTime);
                            if (idx < 0) continue;
                            const bar = bars[idx];
                            const cx = hoverTs.logicalToCoordinate(idx as never);
                            const openY = hoverSeries.priceToCoordinate(bar.open as never);
                            const closeY = hoverSeries.priceToCoordinate(bar.close as never);
                            const highY = hoverSeries.priceToCoordinate(bar.high as never);
                            const lowY = hoverSeries.priceToCoordinate(bar.low as never);
                            if (cx === null || cx === undefined
                                || openY === null || openY === undefined
                                || closeY === null || closeY === undefined
                                || highY === null || highY === undefined
                                || lowY === null || lowY === undefined) continue;
                            const xNum = Number(cx);
                            if (!Number.isFinite(xNum) || xNum < -20 || xNum > plotW + 20) continue;
                            const baseColor = bar.close >= bar.open ? upColor : downColor;
                            const geo = computeHoveredCandleStyle({
                                centerX: xNum,
                                openY: Number(openY),
                                closeY: Number(closeY),
                                highY: Number(highY),
                                lowY: Number(lowY),
                                barSpacing,
                                baseColor,
                                progress,
                            });
                            ctx.save();
                            ctx.globalAlpha = geo.alpha;
                            ctx.shadowColor = geo.glowColor;
                            ctx.shadowBlur = geo.glowBlur;

                            // Brightened, slightly crisper wick.
                            ctx.strokeStyle = geo.fillColor;
                            ctx.lineWidth = geo.wickWidth;
                            ctx.lineCap = 'round';
                            ctx.beginPath();
                            ctx.moveTo(geo.wickX, geo.wickTopY);
                            ctx.lineTo(geo.wickX, geo.wickBottomY);
                            ctx.stroke();

                            // Scaled, brightened candle body.
                            ctx.fillStyle = geo.fillColor;
                            if (typeof ctx.roundRect === 'function' && geo.bodyRadius > 0.1) {
                                ctx.beginPath();
                                ctx.roundRect(geo.bodyX, geo.bodyY, geo.bodyWidth, geo.bodyHeight, geo.bodyRadius);
                                ctx.fill();
                            } else {
                                ctx.fillRect(geo.bodyX, geo.bodyY, geo.bodyWidth, geo.bodyHeight);
                            }

                            // Crisp subtle rim highlight so the focused bar reads cleanly.
                            ctx.shadowBlur = 0;
                            ctx.strokeStyle = geo.rimColor;
                            ctx.lineWidth = 0.85;
                            if (typeof ctx.roundRect === 'function' && geo.bodyRadius > 0.1) {
                                ctx.beginPath();
                                ctx.roundRect(geo.bodyX + 0.4, geo.bodyY + 0.4, Math.max(0.5, geo.bodyWidth - 0.8), Math.max(0.5, geo.bodyHeight - 0.8), geo.bodyRadius);
                                ctx.stroke();
                            } else {
                                ctx.strokeRect(geo.bodyX + 0.4, geo.bodyY + 0.4, Math.max(0.5, geo.bodyWidth - 0.8), Math.max(0.5, geo.bodyHeight - 0.8));
                            }
                            ctx.restore();
                        }
                        ctx.restore();
                    }
                }
            }
        }

        // The committed drawings are painted by the native primitive on its own
        // schedule. Do NOT re-publish its state here: `repaint()` runs on every
        // hover-animation frame, and `setState` → `requestUpdate()` is a FULL
        // chart invalidation — syncing from this loop re-rasterised every pane
        // 60 times a second while the pointer swept the candles (measured: 333
        // pane repaints across a 2.3s sweep vs 3 at rest), which is the flicker.
        // The primitive is synced where its INPUTS change instead: drawing
        // lists, selection/hover, scale mode, and the candle window (history
        // load / symbol switch / live bar).

        // Visible-range high/low markers, OKX's "← 76,216.8" tags. They track the
        // visible bars only, so a marker is a statement about what is on screen
        // rather than about the whole loaded history. Painted last, under the
        // trader's shapes (those are painted after this block).
        const markRange = candlesRef.current;
        const markTs = chartRef.current?.timeScale();
        if (markRange && markTs && typeof markTs.getVisibleLogicalRange === 'function') {
            const range = markTs.getVisibleLogicalRange();
            const bars = (markRange.data?.() ?? []) as readonly { high: number; low: number }[];
            if (range && bars.length > 0) {
                const first = Math.max(0, Math.floor(Number(range.from)));
                const last = Math.min(bars.length - 1, Math.ceil(Number(range.to)));
                let hi = -1;
                let lo = -1;
                for (let i = first; i <= last; i += 1) {
                    if (hi < 0 || bars[i].high > bars[hi].high) hi = i;
                    if (lo < 0 || bars[i].low < bars[lo].low) lo = i;
                }
                const tag = (idx: number, price: number, kind: 'high' | 'low'): void => {
                    const x = markTs.logicalToCoordinate(idx as never);
                    const y = markRange.priceToCoordinate(price as never);
                    if (x === null || x === undefined || y === null || y === undefined) return;
                    const label = price >= 1000 ? price.toFixed(1) : price.toFixed(2);
                    ctx.font = '9px ui-monospace, monospace';
                    const w = ctx.measureText(label).width + 16;
                    const top = kind === 'high' ? Number(y) - 16 : Number(y) + 4;
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(Number(x) - w - 6, top, w, 12);
                    ctx.fillStyle = kind === 'high'
                        ? chartColor('--color-zinc-400', '#a1a1aa')
                        : chartColor('--color-zinc-300', '#d4d4d8');
                    ctx.fillText(label, Number(x) - w + 2, top + 9);
                    // A drawn triangle, not a glyph: a monospace canvas font has
                    // no guarantee of an arrow, and a missing glyph prints as a
                    // box or a fallback that reads as a plus sign.
                    const ax = Number(x) - 5;
                    const ay = top + 6;
                    ctx.beginPath();
                    ctx.moveTo(ax + 4, ay - 3);
                    ctx.lineTo(ax, ay);
                    ctx.lineTo(ax + 4, ay + 3);
                    ctx.closePath();
                    ctx.fill();
                };
                if (hi >= 0) tag(hi, bars[hi].high, 'high');
                if (lo >= 0) tag(lo, bars[lo].low, 'low');
            }
        }

        const strokeLine = (pts: { x: number; y: number }[], stroke: string, dashed = false, width = 1.6): void => {
            if (pts.length < 2) return;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = width;
            ctx.setLineDash(dashed ? [6, 4] : []);
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            ctx.setLineDash([]);
        };

        const priceLabel = (at: { x: number; y: number }, stroke: string): void => {
            const cs = candlesRef.current;
            const dp = cs ? Number(cs.coordinateToPrice(at.y as never)) : NaN;
            if (!Number.isFinite(dp)) return;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(at.x - 2, at.y + 2, 58, 13);
            ctx.fillStyle = stroke;
            ctx.font = '9px ui-monospace, monospace';
            ctx.fillText(dp >= 1000 ? dp.toFixed(0) : dp.toFixed(2), at.x + 1, at.y + 12);
        };

        const drawShape = (kind: DrawKind, pts: { x: number; y: number }[], stroke: string, fill?: string, label?: string, width = 1.6): void => {
            if (pts.length === 0) return;
            switch (kind) {
                case 'hline':
                    strokeLine([{ x: 0, y: pts[0].y }, { x: plotW, y: pts[0].y }], stroke, true, width);
                    break;
                case 'hray':
                    strokeLine([{ x: pts[0].x, y: pts[0].y }, { x: plotW, y: pts[0].y }], stroke, true, width);
                    break;
                case 'vline':
                    strokeLine([{ x: pts[0].x, y: 0 }, { x: pts[0].x, y: plotH }], stroke, true, width);
                    break;
                case 'price_range': {
                    if (pts.length < 2) return;
                    const [a, b] = pts;
                    const up = b.y <= a.y;
                    const rangeColor = up ? '#10b981' : '#f43f5e';
                    ctx.fillStyle = up ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)';
                    ctx.strokeStyle = rangeColor;
                    ctx.lineWidth = width;
                    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
                    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
                    break;
                }
                case 'trend':
                    strokeLine(pts, stroke, false, width);
                    break;
                case 'ray': {
                    if (pts.length < 2) return;
                    const [a, b] = pts;
                    const dx = b.x - a.x;
                    if (Math.abs(dx) < 0.001) { strokeLine([a, { x: a.x, y: plotH }], stroke, false, width); return; }
                    const slope = (b.y - a.y) / dx;
                    strokeLine([a, { x: plotW, y: a.y + slope * (plotW - a.x) }], stroke, false, width);
                    break;
                }
                case 'rect': {
                    if (pts.length < 2) return;
                    const [a, b] = pts;
                    ctx.fillStyle = fill ?? `${stroke}22`;
                    ctx.strokeStyle = stroke;
                    ctx.lineWidth = width;
                    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
                    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
                    break;
                }
                case 'brush':
                    strokeLine(pts, stroke, false, width);
                    break;
                case 'fib': {
                    // Retracement levels between the two anchors — dashed
                    // interior lines, solid 0%/100%, each tagged with ratio +
                    // real price (like TradingView's level captions).
                    if (pts.length < 2) return;
                    const [a, b] = pts;
                    const left = Math.min(a.x, b.x);
                    const right = Math.max(a.x, b.x);
                    const cs = candlesRef.current;
                    ctx.font = '9px ui-monospace, monospace';
                    for (const r of FIB_RATIOS) {
                        const y = a.y + (b.y - a.y) * r;
                        ctx.strokeStyle = stroke;
                        ctx.lineWidth = Math.max(1, Math.min(width, 2));
                        ctx.setLineDash(r === 0 || r === 1 ? [] : [4, 3]);
                        ctx.beginPath();
                        ctx.moveTo(left, y);
                        ctx.lineTo(right, y);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        const dp = cs ? Number(cs.coordinateToPrice(y as never)) : NaN;
                        const price = Number.isFinite(dp) ? ` ${dp >= 1000 ? dp.toFixed(0) : dp.toFixed(2)}` : '';
                        ctx.fillStyle = stroke;
                        ctx.fillText(`${(r * 100).toFixed(1)}%${price}`, left + 3, Math.max(8, y - 3));
                    }
                    return;
                }
                case 'channel':
                case 'arrow':
                case 'measured_move': {
                    // The maths lives in drawingGeometry so it is unit-testable
                    // without a canvas; this block only issues the draw calls.
                    const geo = shapeGeometry(kind, pts, { plotW, stroke, priceAt: y => {
                        const cs = candlesRef.current;
                        const dp = cs ? Number(cs.coordinateToPrice(y as never)) : NaN;
                        return dp;
                    } });
                    if (!geo) return;
                    for (const line of geo.lines) strokeLine(line, stroke, false, width);
                    for (const poly of geo.fills) {
                        ctx.beginPath();
                        ctx.moveTo(poly.points[0].x, poly.points[0].y);
                        for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
                        ctx.closePath();
                        ctx.fillStyle = poly.fill ?? `${stroke}1f`;
                        ctx.fill();
                    }
                    for (const lbl of geo.labels) {
                        ctx.fillStyle = lbl.color;
                        ctx.font = lbl.font;
                        ctx.fillText(lbl.text, lbl.at.x, lbl.at.y);
                    }
                    priceLabel(pts[0], stroke);
                    return;
                }
                    case 'long_position':
                    case 'short_position': {
                        if (pts.length < 2) return;
                        const [a, b] = pts;
                        const isLong = kind === 'long_position';
                        const left = Math.min(a.x, b.x);
                        const right = Math.max(a.x, b.x, left + 48);
                        const tpY = b.y;
                        const slY = a.y + (a.y - b.y) * 0.5;
                        ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
                        ctx.fillRect(left, Math.min(a.y, tpY), right - left, Math.abs(tpY - a.y));
                        ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
                        ctx.fillRect(left, Math.min(a.y, slY), right - left, Math.abs(slY - a.y));
                        strokeLine([{ x: left, y: a.y }, { x: right, y: a.y }], '#d4d4d8', false, 1.25);
                        strokeLine([{ x: left, y: tpY }, { x: right, y: tpY }], '#10b981', false, 1.25);
                        strokeLine([{ x: left, y: slY }, { x: right, y: slY }], '#f43f5e', false, 1.25);
                        const cs = candlesRef.current;
                        const ep = cs ? Number(cs.coordinateToPrice(a.y as never)) : NaN;
                        const tp = cs ? Number(cs.coordinateToPrice(tpY as never)) : NaN;
                        const sl = cs ? Number(cs.coordinateToPrice(slY as never)) : NaN;
                        if (Number.isFinite(ep) && Number.isFinite(tp) && Number.isFinite(sl)) {
                            const m = computePositionBoxMetrics(isLong ? 'long_position' : 'short_position', [
                                { t: 0, p: ep },
                                { t: 1, p: sl },
                                { t: 1, p: tp },
                            ]);
                            if (m) {
                                ctx.fillStyle = 'rgba(24, 24, 27, 0.9)';
                                ctx.fillRect(left + 4, a.y - 16, 94, 14);
                                ctx.fillStyle = '#e4e4e7';
                                ctx.font = '10px ui-monospace, monospace';
                                ctx.fillText(`${isLong ? 'LONG' : 'SHORT'} ${m.formattedRR}`, left + 8, a.y - 5);
                            }
                        }
                        return;
                    }
                    case 'text': {
                        ctx.fillStyle = stroke;
                        ctx.font = '11px ui-monospace, monospace';
                        ctx.fillText(label || 'Note', pts[0].x + 4, pts[0].y - 4);
                        return;
                    }
                }
            if (label) {
                ctx.fillStyle = stroke;
                ctx.font = '10px ui-monospace, monospace';
                ctx.fillText(label, pts[0].x + 4, Math.max(10, pts[0].y - 5));
            }
            priceLabel(pts[0], stroke);
        };

        // Committed user + AI drawings now render inside the zero-lag native
        // `ChartDrawingsPrimitive` (`ISeriesPrimitive`). The overlay canvas
        // renders ONLY the transient creation draft and active magnet reticle
        // so `takeScreenshot(false, false)` never double-renders shapes.
        if (!drawingsHiddenRef.current && draft && draft.points.length > 0 && tool !== 'measure') {
            const draftKind: DrawKind =
                tool === 'hline' ? 'hline'
                    : tool === 'hray' ? 'hray'
                        : tool === 'vline' ? 'vline'
                            : tool === 'rect' ? 'rect'
                                : tool === 'price_range' ? 'price_range'
                                    : tool === 'ray' ? 'ray'
                                        : tool === 'channel' ? 'channel'
                                            : tool === 'arrow' ? 'arrow'
                                                : tool === 'brush' ? 'brush'
                                                    : tool === 'fib' ? 'fib'
                                                        : tool === 'long_position' ? 'long_position'
                                                            : tool === 'short_position' ? 'short_position'
                                                                : 'trend';
            const previewPts = draftKind === 'channel' && draft.points.length === 2
                ? [draft.points[0], draft.points[1], { x: draft.points[0].x, y: draft.points[0].y - 36 }]
                : draft.points;
            drawShape(draftKind, previewPts, color, `${color}22`, undefined, lineWidth);
        }

        // Ephemeral Shift+Drag / Ruler measurement overlay (never persisted).
        const mDrag = measureDragRef.current;
        if (mDrag) {
            const { start, end } = mDrag;
            const left = Math.min(start.x, end.x);
            const top = Math.min(start.y, end.y);
            const rw = Math.abs(end.x - start.x);
            const rh = Math.abs(end.y - start.y);
            ctx.save();
            ctx.fillStyle = 'rgba(250, 250, 250, 0.06)';
            ctx.fillRect(left, top, rw, rh);
            ctx.strokeStyle = 'rgba(212, 212, 216, 0.65)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(left, top, rw, rh);
            ctx.setLineDash([]);
            // Center vertical & horizontal ruler guides
            const midX = left + rw / 2;
            const midY = top + rh / 2;
            ctx.strokeStyle = 'rgba(228, 228, 231, 0.55)';
            ctx.beginPath();
            ctx.moveTo(midX, start.y);
            ctx.lineTo(midX, end.y);
            ctx.moveTo(start.x, midY);
            ctx.lineTo(end.x, midY);
            ctx.stroke();
            ctx.restore();
        }

        // 12px OHLC magnet snap reticle (visible when snapping during create/drag).
        const snap = magnetSnapRef.current;
        if (snap && snap.snapped) {
            ctx.save();
            ctx.strokeStyle = '#fafafa';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(snap.x, snap.y, 4.5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = 'rgba(24, 24, 27, 0.85)';
            ctx.fillRect(snap.x + 7, snap.y - 11, 24, 13);
            ctx.fillStyle = '#e4e4e7';
            ctx.font = '9px ui-monospace, monospace';
            ctx.fillText((snap.field ?? 'o')[0].toUpperCase(), snap.x + 15, snap.y - 1);
            ctx.restore();
        }
        ctx.restore();
    }, [toScreen, draft, tool, color, lineWidth, syncPrimitive]);
    repaintRef.current = repaint;

    useEffect(() => {
        repaintRef.current();
        const chart = chartRef.current;
        if (!chart) return;
        const handler = (): void => { scheduleRepaint(); updateLastTag(); };
        const ts = chart.timeScale();
        const sub = ts.subscribeVisibleLogicalRangeChange?.bind(ts);
        const unsub = ts.unsubscribeVisibleLogicalRangeChange?.bind(ts);
        if (sub) sub(handler);
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleRepaint()) : null;
        if (ro && hostRef.current) ro.observe(hostRef.current);
        return () => {
            if (unsub) { try { unsub(handler); } catch { /* chart removed */ } }
            ro?.disconnect();
            if (repaintFrameRef.current !== null) {
                window.cancelAnimationFrame(repaintFrameRef.current);
                repaintFrameRef.current = null;
            }
        };
    }, [drawings, modelDrawings, paperDrawings, status, interval, updateLastTag, scheduleRepaint]);

    useEffect(() => {
        repaint();
    }, [repaint]);

    // ─── Cursor-mode pointer arbitration: select, drag handles, log-safe body drag, dblclick inspector ───
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        let chartLocked = false;
        const lockChart = (): void => {
            if (chartLocked) return;
            chartLocked = true;
            try {
                chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
            } catch { /* chart tearing down */ }
        };
        const unlockChart = (): void => {
            if (!chartLocked) return;
            chartLocked = false;
            try {
                chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
            } catch { /* chart tearing down */ }
        };

        interface ActiveDrag {
            pointerId: number;
            drawingId: string;
            isModel: boolean;
            target: 'handle' | 'body';
            handleIndex: number;
            startX: number;
            startY: number;
            origDrawing: ChartDrawing;
            origScreenPts: ScreenXY[];
            moved: boolean;
            latestDrawing: ChartDrawing;
        }
        let activeDrag: ActiveDrag | null = null;
        interface ActivePaperDrag {
            pointerId: number;
            drawing: ChartDrawing;
            target: PaperHandleTarget;
            startY: number;
            moved: boolean;
            candidatePrice: number;
            preview: PaperHandlePreview | null;
        }
        let activePaperDrag: ActivePaperDrag | null = null;
        let shiftMeasureActive: { pointerId: number; start: ScreenXY; startData: DrawPoint } | null = null;
        /** Pending passive-hover frame + where the pointer actually is. */
        let hoverFrame: number | null = null;
        let hoverPoint: ScreenXY | null = null;

        const hostLocal = (ev: MouseEvent | PointerEvent): ScreenXY => {
            const rect = host.getBoundingClientRect();
            return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        };

        const plotBounds = (): { plotW: number; plotH: number } => ({
            plotW: Math.max(0, host.clientWidth - axisWRef.current),
            plotH: Math.max(0, host.clientHeight - 28),
        });

        const getAllDrawings = (): ChartDrawing[] =>
            drawingsHiddenRef.current ? [] : [...drawingsRef.current, ...modelDrawingsRef.current];

        const getDraggablePaperDrawings = (): ChartDrawing[] =>
            drawingsHiddenRef.current
                ? []
                : paperDrawingsRef.current.filter(d => parsePaperHandleId(d.id) !== null);

        const finishPaperDrag = (commit: boolean): void => {
            const pDrag = activePaperDrag;
            activePaperDrag = null;
            setPaperDragPreview(null);
            unlockChart();
            host.style.cursor = '';
            if (!pDrag) return;
            const revert = (): void => {
                syncPrimitive({ paperDrawings: paperDrawingsRef.current });
            };
            if (!commit || !pDrag.moved) {
                revert();
                return;
            }
            if (planModeRef.current) {
                revert();
                showChartNotice('Blocked in Plan Mode (read-only) — paper SL/TP unchanged');
                return;
            }
            if (!pDrag.preview || !pDrag.preview.valid) {
                revert();
                showChartNotice(pDrag.preview?.pillText ?? 'Invalid SL/TP price — reverted');
                return;
            }
            const account = paperAccountRef.current;
            const pos = account?.positions.find(p => p.id === pDrag.target.positionId);
            if (!pos) {
                revert();
                return;
            }
            const nextPrice = pDrag.candidatePrice;
            const orderInput = pDrag.target.kind === 'sl'
                ? {
                    action: 'modify_sl_tp' as const,
                    symbol: pos.symbol,
                    position_id: pos.id,
                    stop_loss: nextPrice,
                }
                : {
                    action: 'modify_sl_tp' as const,
                    symbol: pos.symbol,
                    position_id: pos.id,
                    take_profits: pos.takeProfits.map((tp, idx) => (idx === (pDrag.target as { tpIndex: number }).tpIndex ? nextPrice : tp)),
                };
            void submitPaperOrder(orderInput).then(receipt => {
                if (receipt.ok) {
                    showChartNotice(`Updated paper ${pDrag.preview!.label} @ $${fmtPriceForChart(nextPrice)}`);
                } else {
                    revert();
                    showChartNotice(`Modify refused: ${receipt.reason ?? receipt.error ?? 'blocked'}`);
                }
            });
        };

        const applyLiveDrawing = (isModel: boolean, updated: ChartDrawing): void => {
            if (isModel) {
                const next = modelDrawingsRef.current.map(d => (d.id === updated.id ? updated : d));
                modelDrawingsRef.current = next;
                syncPrimitive({ modelDrawings: next });
            } else {
                const next = drawingsRef.current.map(d => (d.id === updated.id ? updated : d));
                drawingsRef.current = next;
                syncPrimitive({ userDrawings: next });
            }
        };

        const finishDrag = (commit: boolean): void => {
            const drag = activeDrag;
            activeDrag = null;
            magnetSnapRef.current = null;
            unlockChart();
            host.style.cursor = '';
            scheduleRepaint();
            if (!drag) return;
            if (commit && drag.moved) {
                const bumped = bumpDrawingVersion(drag.latestDrawing);
                if (drag.isModel) {
                    // If this is an AI Plan horizontal line (Entry / SL / TP1..3),
                    // sync the updated price live to the unapproved TradeProposalCard
                    // and revert cleanly if the drag inverted Long/Short geometry.
                    const levelKind = bumped.kind === 'hline' ? classifyAiPlanLevelLabel(bumped.label) : null;
                    if (levelKind && bumped.points[0]) {
                        let invalidReason: string | null = null;
                        let synced = false;
                        chatStore.updateLatestSymbolProposal(sessionId, symbol, proposal => {
                            const res = applyAiLevelDragToProposal(
                                proposal,
                                levelKind,
                                bumped.points[0].p,
                                harnessSizingRef.current,
                            );
                            if (!res.ok || !res.proposal) {
                                invalidReason = res.reason ?? 'Invalid plan geometry';
                                return null;
                            }
                            synced = true;
                            return res.proposal;
                        });
                        if (invalidReason) {
                            applyLiveDrawing(true, drag.origDrawing);
                            showChartNotice(`Reverted — ${invalidReason}`);
                            return;
                        }
                        if (synced) {
                            showChartNotice(`Synced AI ${bumped.label ?? levelKind.toUpperCase()} @ $${fmtPriceForChart(bumped.points[0].p)}`);
                        }
                    }
                    const nextModel = modelDrawingsRef.current.map(d => (d.id === bumped.id ? bumped : d));
                    commitDrawingChange(drawingsRef.current, nextModel);
                } else {
                    const nextUser = drawingsRef.current.map(d => (d.id === bumped.id ? bumped : d));
                    commitDrawingChange(nextUser);
                }
            } else if (!commit && drag.moved) {
                // Restore original geometry on cancelled drag.
                applyLiveDrawing(drag.isModel, drag.origDrawing);
            }
        };

        const onCapturePointerDown = (ev: PointerEvent): void => {
            if (toolRef.current !== 'cursor' || ev.button !== 0) return;
            const pt = hostLocal(ev);
            // Ephemeral Shift+Drag measure/ruler anywhere on the plot (zero saved drawings).
            if (ev.shiftKey && !ev.altKey) {
                const { plotW, plotH } = plotBounds();
                if (pt.x <= plotW && pt.y <= plotH) {
                    const startData = toData(pt.x, pt.y);
                    if (startData) {
                        ev.stopPropagation();
                        ev.preventDefault();
                        shiftMeasureActive = { pointerId: ev.pointerId, start: pt, startData };
                        measureDragRef.current = { start: pt, end: pt, metrics: null };
                        setMeasureReadout(null);
                        lockChart();
                        host.style.cursor = 'crosshair';
                        try { host.setPointerCapture?.(ev.pointerId); } catch { /* synthetic events */ }
                        scheduleRepaint();
                        return;
                    }
                }
            }
            // Alt+Click on a `#Dn` drawing injects its handle straight into ChatComposer.
            if (ev.altKey) {
                const { plotW, plotH } = plotBounds();
                if (pt.x <= plotW && pt.y <= plotH) {
                    const altHit = hitTestDrawings(
                        pt.x,
                        pt.y,
                        getAllDrawings(),
                        selectedDrawingIdRef.current,
                        toScreen,
                        plotW,
                        plotH,
                    );
                    if (altHit?.drawing.shortId) {
                        ev.stopPropagation();
                        ev.preventDefault();
                        setSelectedDrawingId(altHit.drawing.id);
                        window.dispatchEvent(new CustomEvent('august:composer-inject', {
                            detail: { text: altHit.drawing.shortId, focus: true },
                        }));
                        return;
                    }
                }
            }
            if (ev.altKey && indicatorSettings.visible.avwap) {
                const ts = chartRef.current?.timeScale();
                const logical = typeof ts?.coordinateToLogical === 'function' ? ts.coordinateToLogical(pt.x) : null;
                const idx = logical === null || logical === undefined ? -1 : Math.round(Number(logical));
                const row = chartRowsRef.current[idx];
                if (row) {
                    const next = avwapAnchorRef.current === row.time ? null : row.time;
                    avwapAnchorRef.current = next;
                    setAvwapAnchor(next);
                    refreshIndicatorsRef.current(true);
                }
                return;
            }
            const { plotW, plotH } = plotBounds();
            if (pt.x > plotW || pt.y > plotH) return;
            // Check draggable paper SL/TP handles first when pointer sits on one.
            const paperLines = getDraggablePaperDrawings();
            if (paperLines.length > 0) {
                const paperHit = hitTestDrawings(pt.x, pt.y, paperLines, null, toScreen, plotW, plotH);
                const parsed = paperHit ? parsePaperHandleId(paperHit.drawing.id) : null;
                if (paperHit && parsed) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    setInspector(null);
                    activePaperDrag = {
                        pointerId: ev.pointerId,
                        drawing: paperHit.drawing,
                        target: parsed,
                        startY: pt.y,
                        moved: false,
                        candidatePrice: paperHit.drawing.points[0]?.p ?? 0,
                        preview: null,
                    };
                    lockChart();
                    host.style.cursor = 'ns-resize';
                    try { host.setPointerCapture?.(ev.pointerId); } catch { /* synthetic events */ }
                    return;
                }
            }
            const hit = hitTestDrawings(
                pt.x,
                pt.y,
                getAllDrawings(),
                selectedDrawingIdRef.current,
                toScreen,
                plotW,
                plotH,
            );
            if (!hit) {
                if (selectedDrawingIdRef.current !== null) setSelectedDrawingId(null);
                setInspector(null);
                return;
            }
            ev.stopPropagation();
            ev.preventDefault();
            setInspector(null);
            setSelectedDrawingId(hit.drawing.id);
            selectedDrawingIdRef.current = hit.drawing.id;
            // A locked shape still selects (that is how the toolbar unlocks
            // it), but a drag is refused — the cursor already said not-allowed.
            if (hit.drawing.locked === true) {
                syncPrimitive({ selectedId: hit.drawing.id });
                return;
            }
            const origScreenPts = hit.drawing.points
                .map(p => toScreen(p))
                .filter((s): s is ScreenXY => s !== null);
            if (origScreenPts.length !== hit.drawing.points.length) {
                syncPrimitive({ selectedId: hit.drawing.id });
                return;
            }
            const isModel = modelDrawingsRef.current.some(d => d.id === hit.drawing.id);
            activeDrag = {
                pointerId: ev.pointerId,
                drawingId: hit.drawing.id,
                isModel,
                target: hit.target,
                handleIndex: hit.handleIndex ?? 0,
                startX: pt.x,
                startY: pt.y,
                origDrawing: hit.drawing,
                origScreenPts,
                moved: false,
                latestDrawing: hit.drawing,
            };
            lockChart();
            host.style.cursor = hit.target === 'handle' ? 'grabbing' : 'move';
            try { host.setPointerCapture?.(ev.pointerId); } catch { /* synthetic events */ }
            syncPrimitive({ selectedId: hit.drawing.id });
        };

        const onCapturePointerMove = (ev: PointerEvent): void => {
            if (toolRef.current !== 'cursor') return;
            const rawPt = hostLocal(ev);
            if (shiftMeasureActive) {
                ev.stopPropagation();
                ev.preventDefault();
                const endData = toData(rawPt.x, rawPt.y);
                const metrics = endData ? computeMeasureMetrics({
                    startPrice: shiftMeasureActive.startData.p,
                    endPrice: endData.p,
                    startTimeSec: shiftMeasureActive.startData.t,
                    endTimeSec: endData.t,
                    barSeconds: intervalSeconds(intervalRef.current),
                }) : null;
                measureDragRef.current = { start: shiftMeasureActive.start, end: rawPt, metrics };
                if (metrics) {
                    const hostW = host.clientWidth || 600;
                    setMeasureReadout({
                        x: Math.min(Math.max(8, rawPt.x + 12), Math.max(8, hostW - 240)),
                        y: Math.max(8, rawPt.y - 34),
                        metrics,
                    });
                }
                scheduleRepaint();
                return;
            }
            if (activePaperDrag) {
                ev.stopPropagation();
                ev.preventDefault();
                if (!activePaperDrag.moved && Math.abs(rawPt.y - activePaperDrag.startY) < 2) return;
                const dp = toData(rawPt.x, rawPt.y);
                if (!dp) return;
                activePaperDrag.moved = true;
                activePaperDrag.candidatePrice = dp.p;
                const movedPaper = paperDrawingsRef.current.map(d => (
                    d.id === activePaperDrag!.drawing.id
                        ? { ...d, points: [{ t: d.points[0].t, p: dp.p }] }
                        : d
                ));
                syncPrimitive({ paperDrawings: movedPaper });
                const pos = paperAccountRef.current?.positions.find(p => p.id === activePaperDrag!.target.positionId);
                if (pos) {
                    const preview = computePaperHandlePreview({
                        position: pos,
                        target: activePaperDrag.target,
                        candidatePrice: dp.p,
                    });
                    activePaperDrag.preview = preview;
                    const hostW = host.clientWidth || 600;
                    setPaperDragPreview({
                        x: Math.min(Math.max(8, rawPt.x + 14), Math.max(8, hostW - 220)),
                        y: Math.max(8, rawPt.y - 28),
                        preview,
                    });
                }
                return;
            }
            if (activeDrag) {
                ev.stopPropagation();
                ev.preventDefault();
                const snapRes = magnetPoint(rawPt, ev.ctrlKey);
                magnetSnapRef.current = snapRes.snapped ? snapRes : null;
                const curPt = { x: snapRes.x, y: snapRes.y };
                const dx = curPt.x - activeDrag.startX;
                const dy = curPt.y - activeDrag.startY;
                if (!activeDrag.moved && Math.hypot(dx, dy) < 2) return;
                activeDrag.moved = true;

                const orig = activeDrag.origDrawing;
                let nextPoints: DrawPoint[] = orig.points;

                if (activeDrag.target === 'handle') {
                    const dp = toData(curPt.x, curPt.y);
                    if (dp) {
                        if (isPositionBoxKind(orig.kind)) {
                            nextPoints = updatePositionBoxHandle(
                                orig.points,
                                activeDrag.handleIndex,
                                dp,
                            );
                        } else if (orig.kind === 'hline') {
                            nextPoints = [{ t: orig.points[0].t, p: dp.p }];
                        } else {
                            nextPoints = orig.points.map((p, idx) => (idx === activeDrag!.handleIndex ? dp : p));
                        }
                    }
                } else {
                    // Whole-body drag: convert EVERY anchor via screen Y -> coordinateToPrice(origY + dy)
                    // so vertical translation preserves visual height/slope 1:1 in BOTH Normal & Log scales.
                    const cs = candlesRef.current;
                    const chart = chartRef.current;
                    const ts = chart?.timeScale();
                    const bars = chartRowsRef.current.length > 0
                        ? chartRowsRef.current
                        : ((cs?.data?.() ?? []) as readonly { time: number }[]);
                    if (cs && ts && bars.length > 0 && typeof cs.coordinateToPrice === 'function') {
                        const scaleAdapter = {
                            logicalToCoordinate: (l: number) => {
                                const c = ts.logicalToCoordinate(l as never);
                                return c === null || c === undefined ? null : Number(c);
                            },
                            coordinateToLogical: (cx: number) => {
                                const l = ts.coordinateToLogical(cx);
                                return l === null || l === undefined ? null : Number(l);
                            },
                        };
                        const step = intervalSeconds(intervalRef.current);
                        const translated: DrawPoint[] = [];
                        let valid = true;
                        for (let i = 0; i < orig.points.length; i += 1) {
                            const sp = activeDrag.origScreenPts[i];
                            const newT = orig.kind === 'hline'
                                ? orig.points[i].t
                                : screenXToTimestamp(sp.x + dx, bars, step, scaleAdapter);
                            const newPRaw = cs.coordinateToPrice((sp.y + dy) as never);
                            const newP = newPRaw === null || newPRaw === undefined ? NaN : Number(newPRaw);
                            if (newT === null || !Number.isFinite(newP)) { valid = false; break; }
                            translated.push({ t: newT, p: newP });
                        }
                        if (valid && translated.length === orig.points.length) {
                            nextPoints = translated;
                        }
                    }
                }

                const updated: ChartDrawing = { ...orig, points: nextPoints };
                activeDrag.latestDrawing = updated;
                applyLiveDrawing(activeDrag.isModel, updated);
                if (magnetSnapRef.current) scheduleRepaint();
                return;
            }

            // Passive hover hit-test in cursor mode for cursor feedback & highlight.
            // COALESCED to one test per frame: `pointermove` fires far faster
            // than the pointer can be drawn, and every pass projects every
            // drawing's anchors through two coordinate conversions. A sweep over
            // the candles used to run that work per device event (and repaint
            // via `syncPrimitive` whenever the hover changed), which competed
            // with the library's own crosshair frame.
            hoverPoint = rawPt;
            if (hoverFrame === null) {
                hoverFrame = window.requestAnimationFrame(() => {
                    hoverFrame = null;
                    const pt = hoverPoint;
                    hoverPoint = null;
                    if (!pt || activeDrag) return;
                    runPassiveHover(pt);
                });
            }
        };

        /** One passive hover pass: cursor affordance + the hovered shape's
         *  handles. Only a CHANGE of the hovered id repaints the primitive. */
        const runPassiveHover = (pt: ScreenXY): void => {
            const { plotW, plotH } = plotBounds();
            if (pt.x > plotW || pt.y > plotH) {
                clearHover();
                return;
            }
            const paperLines = getDraggablePaperDrawings();
            if (paperLines.length > 0) {
                const paperHit = hitTestDrawings(pt.x, pt.y, paperLines, null, toScreen, plotW, plotH);
                if (paperHit) {
                    if (host.style.cursor !== 'ns-resize') host.style.cursor = 'ns-resize';
                    if (hoveredDrawingIdRef.current !== null) {
                        hoveredDrawingIdRef.current = null;
                        syncPrimitive({ hoveredId: null });
                    }
                    return;
                }
            }
            const drawings = getAllDrawings();
            if (drawings.length === 0) {
                clearHover();
                return;
            }
            const hit = hitTestDrawings(
                pt.x,
                pt.y,
                drawings,
                selectedDrawingIdRef.current,
                toScreen,
                plotW,
                plotH,
            );
            const nextHover = hit ? hit.drawing.id : null;
            const cursor = hit ? hit.cursor : '';
            if (host.style.cursor !== cursor) host.style.cursor = cursor;
            if (nextHover !== hoveredDrawingIdRef.current) {
                hoveredDrawingIdRef.current = nextHover;
                syncPrimitive({ hoveredId: nextHover });
            }
        };

        const clearHover = (): void => {
            if (host.style.cursor) host.style.cursor = '';
            if (hoveredDrawingIdRef.current !== null) {
                hoveredDrawingIdRef.current = null;
                syncPrimitive({ hoveredId: null });
            }
        };

        const onCapturePointerUp = (ev: PointerEvent): void => {
            if (activePaperDrag) {
                ev.stopPropagation();
                try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
                finishPaperDrag(true);
                return;
            }
            if (shiftMeasureActive) {
                ev.stopPropagation();
                try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
                shiftMeasureActive = null;
                measureDragRef.current = null;
                setMeasureReadout(null);
                unlockChart();
                host.style.cursor = '';
                scheduleRepaint();
                return;
            }
            if (!activeDrag) return;
            ev.stopPropagation();
            try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
            finishDrag(true);
        };

        const onCapturePointerCancel = (ev: PointerEvent): void => {
            if (activePaperDrag) {
                try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
                finishPaperDrag(false);
                return;
            }
            if (shiftMeasureActive) {
                try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
                shiftMeasureActive = null;
                measureDragRef.current = null;
                setMeasureReadout(null);
                unlockChart();
                host.style.cursor = '';
                scheduleRepaint();
                return;
            }
            if (!activeDrag) return;
            try { host.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
            finishDrag(false);
        };

        const onWindowBlur = (): void => {
            if (activePaperDrag) finishPaperDrag(false);
            if (activeDrag) finishDrag(false);
            else unlockChart();
        };

        // Pointer LEFT the chart: the hover state must die with it, or the
        // hovered shape's axis price tags and hover handles linger forever
        // after the cursor is gone — and ride into every capturePng snapshot.
        const onPointerLeave = (): void => {
            if (activeDrag) return;
            if (hoverFrame !== null) {
                window.cancelAnimationFrame(hoverFrame);
                hoverFrame = null;
            }
            hoverPoint = null;
            clearHover();
        };

        const onCaptureDblClick = (ev: MouseEvent): void => {
            if (toolRef.current !== 'cursor') return;
            const pt = hostLocal(ev);
            const { plotW, plotH } = plotBounds();
            const hit = hitTestDrawings(
                pt.x,
                pt.y,
                getAllDrawings(),
                selectedDrawingIdRef.current,
                toScreen,
                plotW,
                plotH,
            );
            if (!hit) return;
            ev.stopPropagation();
            ev.preventDefault();
            setSelectedDrawingId(hit.drawing.id);
            setInspector({ drawingId: hit.drawing.id, x: pt.x, y: pt.y });
        };

        host.addEventListener('pointerdown', onCapturePointerDown, true);
        host.addEventListener('pointermove', onCapturePointerMove, true);
        host.addEventListener('pointerup', onCapturePointerUp, true);
        host.addEventListener('pointercancel', onCapturePointerCancel, true);
        host.addEventListener('pointerleave', onPointerLeave);
        host.addEventListener('dblclick', onCaptureDblClick, true);
        window.addEventListener('blur', onWindowBlur);
        return () => {
            host.removeEventListener('pointerdown', onCapturePointerDown, true);
            host.removeEventListener('pointermove', onCapturePointerMove, true);
            host.removeEventListener('pointerup', onCapturePointerUp, true);
            host.removeEventListener('pointercancel', onCapturePointerCancel, true);
            host.removeEventListener('pointerleave', onPointerLeave);
            host.removeEventListener('dblclick', onCaptureDblClick, true);
            window.removeEventListener('blur', onWindowBlur);
            if (hoverFrame !== null) {
                window.cancelAnimationFrame(hoverFrame);
                hoverFrame = null;
            }
            unlockChart();
            host.style.cursor = '';
        };
    }, [toScreen, toData, magnetPoint, syncPrimitive, commitDrawingChange, scheduleRepaint, indicatorSettings.visible.avwap, sessionId, symbol, showChartNotice]);

    // ─── Pointer capture on the overlay (only while a drawing tool is active) ───
    const localPoint = (ev: React.PointerEvent): { x: number; y: number } => {
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const resolveToolPoint = (ev: React.PointerEvent): ScreenXY => {
        const raw = localPoint(ev);
        const snap = magnetPoint(raw, ev.ctrlKey);
        magnetSnapRef.current = snap.snapped ? snap : null;
        return snap.snapped ? { x: snap.x, y: snap.y } : raw;
    };

    const onPointerDown = (ev: React.PointerEvent): void => {
        if (tool === 'cursor') return;
        ev.preventDefault();
        const pt = resolveToolPoint(ev);
        if (tool === 'measure') {
            measureDragRef.current = { start: pt, end: pt, metrics: null };
            setMeasureReadout(null);
            setDraft({ points: [pt] });
            (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
            scheduleRepaint();
            return;
        }
        if (tool === 'erase') {
            const host = hostRef.current;
            const plotW = Math.max(0, (host?.clientWidth ?? 600) - axisWRef.current);
            const plotH = Math.max(0, (host?.clientHeight ?? 400) - 28);
            const hit = hitTestDrawings(
                pt.x,
                pt.y,
                [...drawingsRef.current, ...modelDrawingsRef.current],
                null,
                toScreen,
                plotW,
                plotH,
            );
            // The eraser refuses locked shapes — unlock in the selection
            // toolbar first, so a stray click cannot delete a kept level.
            if (hit && hit.drawing.locked !== true) deleteDrawingById(hit.drawing.id);
            return;
        }
        if (tool === 'hline' || tool === 'hray' || tool === 'vline') {
            const dp = toData(pt.x, pt.y);
            if (dp) {
                const shortId = allocateDrawingShortId(symbol, [...drawingsRef.current, ...modelDrawingsRef.current]);
                const created: ChartDrawing = {
                    id: createDrawingId(),
                    shortId,
                    origin: 'user',
                    createdOnTf: interval,
                    version: 1,
                    kind: tool,
                    points: [dp],
                    color,
                    createdAt: Date.now(),
                    drawnPrice: markPrice ?? lastPrice ?? undefined,
                    width: lineWidth,
                };
                commitDrawingChange([...drawingsRef.current, created]);
                setSelectedDrawingId(created.id);
                if (!stayInDrawingModeRef.current) setTool('cursor');
            }
            magnetSnapRef.current = null;
            return;
        }
        if (tool === 'text') {
            const dp = toData(pt.x, pt.y);
            if (dp) {
                const id = createDrawingId();
                const shortId = allocateDrawingShortId(symbol, [...drawingsRef.current, ...modelDrawingsRef.current]);
                commitDrawingChange([...drawingsRef.current, {
                    id,
                    shortId,
                    origin: 'user',
                    createdOnTf: interval,
                    version: 1,
                    kind: 'text',
                    points: [dp],
                    color,
                    createdAt: Date.now(),
                    label: 'Note',
                    drawnPrice: markPrice ?? lastPrice ?? undefined,
                    width: lineWidth,
                }]);
                setTextEdit({ id, x: pt.x, y: pt.y });
                if (!stayInDrawingModeRef.current) setTool('cursor');
            }
            magnetSnapRef.current = null;
            return;
        }
        if (CLICK_CLICK_KINDS.has(tool as DrawKind)) {
            if (draft && draft.points.length >= 1) {
                // Second click of click-click placement: commit at THIS point
                // (the pressed anchor, not the hovering preview point).
                const pts = [draft.points[0], pt];
                setDraft(null);
                magnetSnapRef.current = null;
                draftStartRef.current = null;
                commitPlacement(tool as DrawKind, pts);
                return;
            }
            draftStartRef.current = { x: pt.x, y: pt.y };
            setDraft({ points: [pt] });
            (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
            return;
        }
        // Brush is a pure drag gesture; everything else two-anchor already
        // routed above.
        draftStartRef.current = { x: pt.x, y: pt.y };
        setDraft({ points: [pt] });
        (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    };

    const onPointerMove = (ev: React.PointerEvent): void => {
        if (tool === 'cursor' || tool === 'erase') return;
        const pt = resolveToolPoint(ev);
        if (tool === 'measure') {
            const m = measureDragRef.current;
            if (!m) return;
            const startData = toData(m.start.x, m.start.y);
            const endData = toData(pt.x, pt.y);
            const metrics = startData && endData ? computeMeasureMetrics({
                startPrice: startData.p,
                endPrice: endData.p,
                startTimeSec: startData.t,
                endTimeSec: endData.t,
                barSeconds: intervalSeconds(interval),
            }) : null;
            measureDragRef.current = { start: m.start, end: pt, metrics };
            if (metrics) {
                const hostW = hostRef.current?.clientWidth ?? 600;
                setMeasureReadout({
                    x: Math.min(Math.max(8, pt.x + 12), Math.max(8, hostW - 240)),
                    y: Math.max(8, pt.y - 34),
                    metrics,
                });
            }
            scheduleRepaint();
            return;
        }
        if (!draft) {
            if (magnetMode !== 'off' || ev.ctrlKey) scheduleRepaint();
            return;
        }
        if (tool === 'brush') {
            const last = draft.points[draft.points.length - 1];
            if (Math.hypot(pt.x - last.x, pt.y - last.y) < 3) return;
            setDraft({ points: [...draft.points, pt] });
        } else {
            const a = draft.points[0];
            setDraft({ points: [a, pt] });
        }
    };

    /** The one commit tail both placement gestures share: a drag that releases
     *  past the click threshold, and the second click of click-click placement.
     *  Position boxes seed ATR defaults from a single anchor or size from the
     *  second anchor; two-anchor kinds run `pointsForKind` (channel seeds its
     *  parallel 3rd anchor). */
    const commitPlacement = (kind: DrawKind, pts: { x: number; y: number }[]): void => {
        // Long / Short Position box: click-to-seed OR drag-to-size, always producing 3 valid anchors.
        if (isPositionBoxKind(kind)) {
            const entryDp = toData(pts[0].x, pts[0].y);
            if (!entryDp) return;
            const evalBars = chartRowsRef.current.slice(-200);
            const atr = computeAtr14(evalBars);
            const barSec = intervalSeconds(interval);
            const riskDist = atr && atr > 0 ? atr : Math.max(Math.abs(entryDp.p) * 0.008, 1e-6);
            let finalPts = seedPositionBoxPoints(kind, entryDp, entryDp.t + barSec * 16, riskDist);
            if (pts.length >= 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) > 8) {
                const dragDp = toData(pts[1].x, pts[1].y);
                if (dragDp) {
                    const rightT = Math.max(dragDp.t, entryDp.t + barSec * 4);
                    const rawDelta = Math.abs(dragDp.p - entryDp.p);
                    const tpDist = rawDelta > 0 ? rawDelta : (atr && atr > 0 ? atr * 2 : entryDp.p * 0.012);
                    const slDist = tpDist * 0.5;
                    const isLong = kind === 'long_position';
                    finalPts = [
                        entryDp,
                        { t: rightT, p: isLong ? Math.max(1e-8, entryDp.p - slDist) : entryDp.p + slDist },
                        { t: rightT, p: isLong ? entryDp.p + tpDist : Math.max(1e-8, entryDp.p - tpDist) },
                    ];
                }
            }
            const shortId = allocateDrawingShortId(symbol, [...drawingsRef.current, ...modelDrawingsRef.current]);
            const created: ChartDrawing = {
                id: createDrawingId(),
                shortId,
                origin: 'user',
                createdOnTf: interval,
                version: 1,
                kind,
                points: finalPts,
                color: kind === 'long_position' ? '#10b981' : '#f43f5e',
                createdAt: Date.now(),
                drawnPrice: markPrice ?? lastPrice ?? undefined,
                width: lineWidth,
            };
            commitDrawingChange([...drawingsRef.current, created]);
            setSelectedDrawingId(created.id);
            setTool('cursor');
            return;
        }

        if (pts.length < 2) return;
        const dataPts = pts.map(p => toData(p.x, p.y)).filter((p): p is DrawPoint => p !== null);
        // Channel: seed parallel 3rd anchor offset by 1.5*ATR (or 1% of price) so user can drag handle 2 cleanly.
        if (kind === 'channel' && dataPts.length === 2) {
            const atr = computeAtr14(chartRowsRef.current.slice(-200));
            const offset = atr && atr > 0 ? atr * 1.5 : Math.max(Math.abs(dataPts[0].p) * 0.01, 1e-6);
            dataPts.push({ t: dataPts[0].t, p: dataPts[0].p + offset });
        }
        const finalPts = pointsForKind(kind, dataPts);
        if (!finalPts || finalPts.length < 2) return;
        const shortId = allocateDrawingShortId(symbol, [...drawingsRef.current, ...modelDrawingsRef.current]);
        const created: ChartDrawing = {
            id: createDrawingId(),
            shortId,
            origin: 'user',
            createdOnTf: interval,
            version: 1,
            kind,
            points: finalPts,
            color,
            createdAt: Date.now(),
            drawnPrice: markPrice ?? lastPrice ?? undefined,
            width: lineWidth,
        };
        commitDrawingChange([...drawingsRef.current, created]);
        setSelectedDrawingId(created.id);
        if (!stayInDrawingModeRef.current) setTool('cursor');
    };

    const onPointerUp = (ev: React.PointerEvent): void => {
        if (tool === 'measure') {
            (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
            setDraft(null);
            measureDragRef.current = null;
            setMeasureReadout(null);
            scheduleRepaint();
            if (!stayInDrawingModeRef.current) setTool('cursor');
            return;
        }
        if (!draft) return;
        const kind = tool as DrawKind;
        const pts = draft.points;
        const start = draftStartRef.current;
        (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);

        // Click-click placement: a release in place (a CLICK, not a drag) arms
        // the pending second anchor — the draft stays live under the pointer
        // until the second click commits or Escape cancels. A release that
        // travelled commits immediately, the classic drag-to-place gesture.
        const last = pts[pts.length - 1];
        const isClick = !start
            || (pts.length === 1 && Math.hypot(last.x - start.x, last.y - start.y) < CLICK_COMMIT_THRESHOLD_PX);
        if (isClick && CLICK_CLICK_KINDS.has(kind)) {
            return;
        }
        setDraft(null);
        magnetSnapRef.current = null;
        draftStartRef.current = null;
        commitPlacement(kind, pts);
    };

    const renameTextDrawing = (id: string, label: string): void => {
        publishDrawings(drawingsRef.current.map(d => (d.id === id ? bumpDrawingVersion({ ...d, label: label.slice(0, 80) }) : d)));
    };
    const finishTextEdit = (cancel = false): void => {
        if (!textEdit) return;
        if (cancel) deleteDrawingById(textEdit.id);
        setTextEdit(null);
    };

    const applyInspectorUpdate = (updated: ChartDrawing): void => {
        const bumped = bumpDrawingVersion(updated);
        const isModel = modelDrawingsRef.current.some(d => d.id === bumped.id);
        if (isModel) {
            const nextModel = modelDrawingsRef.current.map(d => (d.id === bumped.id ? bumped : d));
            commitDrawingChange(drawingsRef.current, nextModel);
        } else {
            const nextUser = drawingsRef.current.map(d => (d.id === bumped.id ? bumped : d));
            commitDrawingChange(nextUser);
        }
        setInspector(null);
    };

    // ─── Imperative handle (screenshot + snapshot) ──────────────────────────
    useEffect(() => {
        if (!chartHandle) return;
        chartHandle.current = {
            capturePng: (): string | null => {
                try {
                    const chart = chartRef.current;
                    const host = hostRef.current;
                    if (!chart || !host) return null;
                    // `takeScreenshot(false, false)` captures `zOrder: 'normal'` committed
                    // drawings inside the primitive and excludes `zOrder: 'top'` selection
                    // handles + crosshair. Committed shapes are no longer on `overlayRef`,
                    // so there is zero double-rendering.
                    const base = chart.takeScreenshot(false, false);
                    const plotW = Math.max(0, host.clientWidth - axisWRef.current);
                    const plotH = Math.max(0, host.clientHeight - 28);
                    const userShapes = ensureStableShortIds(
                        drawingsRef.current.map(d => (d.origin ? d : { ...d, origin: 'user' as const })),
                        symbol,
                    );
                    const aiShapes = ensureStableShortIds(
                        modelDrawingsRef.current.map(d => (d.origin ? d : { ...d, origin: 'agent' as const })),
                        symbol,
                    );
                    const badges: SnapshotBadge[] = [];
                    if (!drawingsHiddenRef.current && plotW > 30 && plotH > 24) {
                        for (const d of [...userShapes, ...aiShapes]) {
                            const anchor = d.points[0];
                            if (!anchor || !d.shortId) continue;
                            const pt = toScreen(anchor);
                            if (!pt) continue;
                            // Skip anchors outside visible plot bounds, and clamp strictly
                            // inside the plot pane so badges never drift onto price/time axes
                            // across 1x/1.25x/1.5x/2x DPR scales.
                            if (pt.x < -8 || pt.x > plotW + 8 || pt.y < -8 || pt.y > plotH + 8) continue;
                            badges.push({
                                shortId: d.shortId,
                                origin: d.origin === 'agent' ? 'agent' : 'user',
                                x: Math.max(10, Math.min(plotW - 36, pt.x)),
                                y: Math.max(10, Math.min(plotH - 18, pt.y)),
                                color: d.color,
                            });
                        }
                    }
                    return renderAnnotatedChartSnapshot({
                        baseCanvas: base,
                        overlayCanvas: overlayRef.current,
                        overlayCssWidth: host.clientWidth,
                        overlayCssHeight: host.clientHeight,
                        backgroundColor: chartColor('--color-zinc-950', '#0a0a0b'),
                        badges,
                    });
                } catch {
                    return null;
                }
            },
            getSnapshot: (): ChartSnapshot | null => {
                const cs = candlesRef.current;
                if (!cs) return null;
                const data = (cs.data() ?? []) as readonly { time: number; open: number; high: number; low: number; close: number }[];
                const tail = data.slice(-30).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
                const fullRows = chartRowsRef.current.length > 0 ? chartRowsRef.current : data;
                const evalCandles: EvalCandle[] = fullRows.slice(-200).map(c => ({
                    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
                }));
                const scaleModeOpt = (chartRef.current?.priceScale('right')?.options?.() as { mode?: number } | undefined)?.mode;
                const activeScaleMode: PriceScaleMode = scaleModeOpt === 1 || priceScaleModeRef.current === 'logarithmic'
                    ? 'logarithmic'
                    : 'normal';
                const activeStudies: Record<string, number> = {};
                const legendSeries = legendRef.current?.series ?? {};
                for (const [key, series] of Object.entries(legendSeries)) {
                    for (let i = series.length - 1; i >= 0; i -= 1) {
                        const v = series[i];
                        if (typeof v === 'number' && Number.isFinite(v)) {
                            activeStudies[key] = v;
                            break;
                        }
                    }
                }
                const atr14 = typeof activeStudies.atr === 'number' && Number.isFinite(activeStudies.atr)
                    ? activeStudies.atr
                    : computeAtr14(evalCandles);
                const userDrawings = ensureStableShortIds(
                    drawingsRef.current.map(d => (d.origin ? d : { ...d, origin: 'user' as const })),
                    symbol,
                );
                const aiDrawings = ensureStableShortIds(
                    modelDrawingsRef.current.map(d => (d.origin ? d : { ...d, origin: 'agent' as const })),
                    symbol,
                );
                const visibleRange = readVisibleRange();
                const revision = computeChartRevision({
                    symbol,
                    interval,
                    priceScaleMode: activeScaleMode,
                    lastClosedBarTime: tail.length >= 2 ? tail[tail.length - 2].time : (tail[0]?.time ?? null),
                    visibleRange,
                    activeStudies,
                    drawings: [...userDrawings, ...aiDrawings],
                });
                return {
                    symbol,
                    interval,
                    candles: tail,
                    markPrice: markPrice ?? lastPrice ?? null,
                    levels: [
                        ...levels.map(l => ({ label: l.label, price: l.price })),
                        ...(chatLevels && chatLevels.symbol === symbol
                            ? chatLevels.lines.filter(l => l.state !== 'hidden').map(l => ({ label: l.label, price: l.price }))
                            : []),
                    ],
                    drawings: userDrawings,
                    modelDrawings: aiDrawings,
                    visibleRange,
                    priceScaleMode: activeScaleMode,
                    activeStudies,
                    revision,
                    atr14,
                    evalCandles,
                    capturedAt: Date.now(),
                };
            },
            clearUserDrawings: (): void => commitDrawingChange([]),
        };
        return () => { chartHandle.current = null; };
    }, [chartHandle, symbol, interval, lastPrice, markPrice, levels, chatLevels, commitDrawingChange, toScreen]);

    const handleToggleDrawingVisibility = useCallback((id: string): void => {
        const inModel = modelDrawingsRef.current.some(d => d.id === id);
        if (inModel) {
            const nextModel = modelDrawingsRef.current.map(d => (d.id === id ? bumpDrawingVersion({ ...d, hidden: !d.hidden }) : d));
            commitDrawingChange(drawingsRef.current, nextModel);
        } else {
            const nextUser = drawingsRef.current.map(d => (d.id === id ? bumpDrawingVersion({ ...d, hidden: !d.hidden }) : d));
            commitDrawingChange(nextUser);
        }
    }, [commitDrawingChange]);

    const handleToggleDrawingLock = useCallback((id: string): void => {
        const inModel = modelDrawingsRef.current.some(d => d.id === id);
        if (inModel) {
            const nextModel = modelDrawingsRef.current.map(d => (d.id === id ? bumpDrawingVersion({ ...d, locked: !d.locked }) : d));
            commitDrawingChange(drawingsRef.current, nextModel);
        } else {
            const nextUser = drawingsRef.current.map(d => (d.id === id ? bumpDrawingVersion({ ...d, locked: !d.locked }) : d));
            commitDrawingChange(nextUser);
        }
    }, [commitDrawingChange]);

    const handleSnapshotToChat = useCallback((): void => {
        const png = chartHandle?.current?.capturePng?.();
        if (!png) return;
        window.dispatchEvent(new CustomEvent('august:composer-attach-png', {
            detail: { dataUrl: png, name: `${symbol}-${interval}.png` },
        }));
    }, [chartHandle, symbol, interval]);

    const activeStudyIds = useMemo(
        () => offerableIndicatorIds.filter(id => indicatorSettings.visible[id]),
        [offerableIndicatorIds, indicatorSettings.visible],
    );

    const toolActive = tool !== 'cursor';

    return (
        <div
            ref={rootRef}
            className="flex h-full min-h-0 flex-col bg-zinc-950"
            data-testid="trading-chart"
            data-symbol={symbol}
            data-hovered-candle=""
            data-spotlight-drawing={spotlightShortId ?? ''}
        >
            {/* Top Chart Bar (36px): Left = Timeframes + Studies + Candle Style; Right = Undo/Redo, Object Tree, Snapshot, Focus, Settings */}
            <TimeframeBar
                interval={interval}
                onIntervalChange={onIntervalChange}
                noWrap
                className="z-30 h-9 border-b border-hairline bg-zinc-950 px-2 py-0"
            >
                <div className="relative ml-0.5 shrink-0">
                    <button type="button" onClick={() => setIndicatorMenuOpen(v => !v)} aria-pressed={indicatorsOn}
                        aria-expanded={indicatorMenuOpen} title="Chart studies"
                        className={`whitespace-nowrap rounded-control px-1.5 py-1 text-ui-dense font-medium transition-colors ${
                            indicatorsOn
                                ? 'bg-white/[0.06] text-zinc-100'
                                : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                        }`}>
                        ƒ Studies
                    </button>
                    {indicatorMenuOpen && (
                        <>
                            <button type="button" aria-hidden="true" tabIndex={-1}
                                onClick={() => setIndicatorMenuOpen(false)}
                                className="fixed inset-0 z-20 cursor-default" />
                            <div role="menu" data-testid="chart-indicator-menu"
                                className="motion-popover-down absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-hairline bg-zinc-950 py-1 shadow-elevated">
                                {offerableIndicatorIds.map(id => {
                                    const on = indicatorSettings.visible[id];
                                    return (
                                        <button key={id} type="button" role="menuitemcheckbox" aria-checked={on}
                                            onClick={() => toggleIndicator(id)}
                                            className="flex w-full items-center gap-2 px-2 py-1 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.05]">
                                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-zinc-200' : 'bg-zinc-700'}`} />
                                            <span className="flex-1">{CHART_INDICATOR_LABELS[id]}</span>
                                            {CHART_INDICATOR_REGISTRY[id].delivery === 'sub-series' && (
                                                <span className="text-ui-micro text-zinc-600">pane</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                {/* Candle style cycle: Candles / Hollow / Line */}
                <button
                    type="button"
                    data-testid="chart-candle-style"
                    title="Cycle candle style (Candles / Hollow / Line)"
                    onClick={() => setCandleStyle(s => (s === 'candles' ? 'hollow' : s === 'hollow' ? 'line' : 'candles'))}
                    className="shrink-0 whitespace-nowrap rounded-control px-1.5 py-1 text-ui-dense font-medium text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                >
                    {candleStyle === 'candles' ? 'Candles' : candleStyle === 'hollow' ? 'Hollow' : 'Line'}
                </button>

                {/* Right utility cluster */}
                <div className="relative ml-auto flex shrink-0 items-center gap-0.5 pr-0.5">
                    <button
                        type="button"
                        data-testid="rail-undo"
                        title="Undo last drawing (Ctrl+Z)"
                        aria-label="Undo last drawing (Ctrl+Z)"
                        disabled={!historyMeta.canUndo}
                        onClick={handleUndoDrawing}
                        className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        data-testid="rail-redo"
                        title="Redo drawing (Ctrl+Y)"
                        aria-label="Redo drawing (Ctrl+Y)"
                        disabled={!historyMeta.canRedo}
                        onClick={handleRedoDrawing}
                        className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                        <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        data-testid="chart-object-tree-btn"
                        aria-expanded={objectTreeOpen}
                        title="Object Tree (AI levels, drawings, studies)"
                        aria-label="Chart object tree"
                        onClick={() => { setChartSettingsOpen(false); setObjectTreeOpen(v => !v); }}
                        className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors ${
                            objectTreeOpen ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                        }`}
                    >
                        <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        data-testid="chart-snapshot-btn"
                        title="Snapshot chart to Chat composer"
                        aria-label="Snapshot chart to Chat"
                        onClick={handleSnapshotToChat}
                        className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {onToggleChartFocus && (
                        <button
                            type="button"
                            data-testid="chart-focus-toggle"
                            aria-pressed={chartFocus}
                            title={chartFocus ? 'Exit Full-Chart Focus (Ctrl+\\)' : 'Full-Chart Focus (Ctrl+\\)'}
                            aria-label={chartFocus ? 'Exit Full-Chart Focus' : 'Full-Chart Focus'}
                            onClick={onToggleChartFocus}
                            className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors ${
                                chartFocus ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                            }`}
                        >
                            {chartFocus
                                ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                                : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                    )}
                    <button
                        type="button"
                        data-testid="chart-settings-btn"
                        aria-expanded={chartSettingsOpen}
                        title="Chart display settings"
                        aria-label="Chart settings"
                        onClick={() => { setObjectTreeOpen(false); setChartSettingsOpen(v => !v); }}
                        className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors ${
                            chartSettingsOpen ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                        }`}
                    >
                        <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <span className={`ml-1 h-1.5 w-1.5 rounded-full ${status === 'live' ? 'bg-zinc-300' : status === 'loading' ? 'animate-pulse bg-zinc-500' : 'bg-zinc-600'}`} aria-label={`chart ${status}`} />

                    <ChartObjectTreePopover
                        open={objectTreeOpen}
                        onClose={() => setObjectTreeOpen(false)}
                        userDrawings={drawings}
                        modelDrawings={modelDrawings ?? []}
                        activeStudies={activeStudyIds}
                        selectedId={selectedDrawingId}
                        onSelectDrawing={id => setSelectedDrawingId(id)}
                        onToggleVisibility={handleToggleDrawingVisibility}
                        onToggleLock={handleToggleDrawingLock}
                        onRenameDrawing={renameTextDrawing}
                        onDeleteDrawing={deleteDrawingById}
                        onToggleStudy={toggleIndicator}
                    />

                    {chartSettingsOpen && (
                        <>
                            <div className="fixed inset-0 z-shield" aria-hidden="true" onClick={() => setChartSettingsOpen(false)} />
                            <div
                                data-testid="chart-settings-popover"
                                role="menu"
                                className="motion-popover-down absolute right-0 top-full z-flyout mt-1 w-48 rounded-lg border border-hairline bg-zinc-950 p-1.5 shadow-elevated"
                            >
                                <button
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={showGrid}
                                    onClick={() => setShowGrid(v => !v)}
                                    className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-zinc-300 hover:bg-white/[0.05]"
                                >
                                    <span>Grid lines</span>
                                    <span className="font-mono text-ui-2xs text-zinc-500">{showGrid ? 'On' : 'Off'}</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setRailCollapsed(v => !v); setChartSettingsOpen(false); }}
                                    className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-zinc-300 hover:bg-white/[0.05]"
                                >
                                    <span>{railCollapsed ? 'Show drawing rail' : 'Hide drawing rail'}</span>
                                    <span className="font-mono text-ui-2xs text-zinc-500">Ctrl+Alt+D</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { handleResetView(); setChartSettingsOpen(false); }}
                                    className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-zinc-300 hover:bg-white/[0.05]"
                                >
                                    <span className="flex items-center gap-1.5">
                                        <RotateCcw className="h-3 w-3 text-zinc-400" aria-hidden="true" />
                                        Reset view
                                    </span>
                                    <span className="font-mono text-ui-2xs text-zinc-500">Alt+R</span>
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </TimeframeBar>

            <ChartFrame
                variant="plain"
                state={status === 'loading' ? 'loading' : status === 'unavailable' ? 'error' : 'ready'}
                message="Candles unavailable — Binance fetch failed; retrying in 4s."
                onRetry={() => retryLoadRef.current?.()}
                bodyClassName="flex min-h-0 flex-1 overflow-hidden bg-zinc-950"
                testId="trading-chart-plot"
            >
                {/* Dedicated 38px flex drawing rail strictly OUTSIDE the canvas wrapper */}
                <ChartToolRail
                    tool={tool}
                    onSelectTool={t => { setTool(t); setDraft(null); setTextEdit(null); setInspector(null); }}
                    favorites={favoriteTools}
                    onToggleFavorite={handleToggleFavorite}
                    magnetMode={magnetMode}
                    onMagnetModeChange={setMagnetMode}
                    stayInDrawingMode={stayInDrawingMode}
                    onToggleStayInDrawingMode={() => setStayInDrawingMode(v => !v)}
                    allLocked={allLocked}
                    onToggleLockAll={handleToggleLockAll}
                    visibilityScope={visibilityScope}
                    onVisibilityScopeChange={setVisibilityScope}
                    userDrawingCount={drawings.length}
                    agentDrawingCount={countAgentDrawings({ userDrawings: drawings, modelDrawings: modelDrawings ?? [] })}
                    onClearAgentDrawings={handleClearAgentDrawings}
                    onClearUserDrawings={handleClearUserDrawings}
                    onClearAllDrawings={handleClearAllDrawings}
                    collapsed={railCollapsed}
                    onToggleCollapsed={() => setRailCollapsed(v => !v)}
                />
                {/* Canvas wrapper — owns plot, overlays, hover readouts, and toolbars with zero rail overlap */}
                <div
                    ref={canvasWrapperRef}
                    className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
                    data-testid="chart-canvas-wrapper"
                    onContextMenu={(ev) => {
                        const wrapper = canvasWrapperRef.current;
                        const cs = candlesRef.current;
                        if (!wrapper || !cs || typeof cs.coordinateToPrice !== 'function') return;
                        const rect = wrapper.getBoundingClientRect();
                        const localX = ev.clientX - rect.left;
                        const localY = ev.clientY - rect.top;
                        const plotW = Math.max(0, rect.width - axisWRef.current);
                        const plotH = Math.max(0, rect.height - 28);
                        if (localX > plotW || localY > plotH) return;
                        const pRaw = cs.coordinateToPrice(localY as never);
                        const price = pRaw === null || pRaw === undefined ? NaN : Number(pRaw);
                        if (!Number.isFinite(price) || price <= 0) return;
                        ev.preventDefault();
                        setContextMenu({ price, x: localX, y: localY });
                    }}
                >
                <ChartFavoritesBar
                    favorites={favoriteTools}
                    activeTool={tool}
                    onSelectTool={t => { setTool(t); setDraft(null); setTextEdit(null); setInspector(null); }}
                    containerRef={canvasWrapperRef}
                />
                {chartNotice && (
                    <div
                        data-testid="chart-action-notice"
                        role="status"
                        className="pointer-events-none absolute bottom-9 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-control border border-hairline bg-zinc-950/95 px-2.5 py-1 font-mono text-ui-dense text-zinc-200 shadow-elevated"
                    >
                        {chartNotice}
                    </div>
                )}
                {measureReadout && (
                    <div
                        data-testid="chart-measure-readout"
                        style={{ transform: `translate3d(${measureReadout.x}px, ${measureReadout.y}px, 0)` }}
                        className="pointer-events-none absolute left-0 top-0 z-20 whitespace-nowrap rounded-control border border-hairline bg-zinc-950/95 px-2 py-1 font-mono text-ui-dense tabular-nums text-zinc-200 shadow-elevated will-change-transform"
                    >
                        {measureReadout.metrics.formattedSummary}
                    </div>
                )}
                {paperDragPreview && (
                    <div
                        data-testid="paper-handle-preview-pill"
                        style={{ transform: `translate3d(${paperDragPreview.x}px, ${paperDragPreview.y}px, 0)` }}
                        className={`pointer-events-none absolute left-0 top-0 z-30 whitespace-nowrap rounded-control border border-hairline bg-zinc-950/95 px-2 py-1 font-mono text-ui-dense tabular-nums shadow-elevated will-change-transform ${
                            !paperDragPreview.preview.valid
                                ? 'text-rose-400'
                                : paperDragPreview.preview.pnlUsd >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                        }`}
                    >
                        {paperDragPreview.preview.pillText}
                    </div>
                )}
                <HoverLegend
                    store={hoverReadout}
                    expanded={legendExpanded}
                    onToggleExpanded={() => setLegendExpanded(v => !v)}
                    narrow={levels.length > 0}
                    renderRows={legendSettingsRows}
                    volumeFor={volumeFor}
                />
                {lastTag && (
                    <div
                        data-testid="last-price-tag"
                        className="pointer-events-none absolute right-0.5 top-0 z-10 flex flex-col items-end gap-1 [will-change:transform]"
                        style={{ transform: `translate3d(0, ${Math.max(6, lastTag.y - 10)}px, 0)` }}
                    >
                        <span
                            data-testid="last-price-pill"
                            style={{ minWidth: Math.max(48, axisW - 4) }}
                            className={`rounded-[3px] px-1.5 py-0.5 text-right font-mono text-[11px] font-medium leading-none tabular-nums ${lastTag.up ? 'bg-emerald-700 text-zinc-50' : 'bg-rose-700 text-zinc-50'}`}
                        >
                            {fmtPriceForChart(lastTag.price)}
                        </span>
                        <BarCountdown barTime={lastTag.barTime} interval={interval} />
                    </div>
                )}
                <HoverCrossTag store={hoverReadout} axisW={axisW} />
                <PriceAxisPlusButton
                    store={hoverReadout}
                    axisW={axisW}
                    onOpenMenu={(price, y) => {
                        const w = canvasWrapperRef.current?.clientWidth ?? 640;
                        setContextMenu({ price, x: Math.max(12, w - axisW - 256), y: Math.max(12, y - 16) });
                    }}
                />
                <ChartContextMenu
                    open={contextMenu !== null}
                    x={contextMenu?.x ?? 0}
                    y={contextMenu?.y ?? 0}
                    containerWidth={canvasWrapperRef.current?.clientWidth ?? 640}
                    containerHeight={canvasWrapperRef.current?.clientHeight ?? 420}
                    symbol={symbol}
                    price={contextMenu?.price ?? 0}
                    markPrice={markPrice ?? lastPrice ?? null}
                    planMode={planMode}
                    paperEnabled={paperEnabled}
                    onClose={() => setContextMenu(null)}
                    onDrawHline={handleDrawHlineAtPrice}
                    onArmWatch={price => handleArmWatchAtPrice(price, 'Chart price')}
                    onStagePaperLimit={(price, side) => { void handleStagePaperLimitAtPrice(price, side); }}
                    onAskAugust={price => handleAskAugust(`${symbol.replace(/USDT$/i, '')} @ $${fmtPriceForChart(price)}`)}
                />
                {ohlcvRow && overPlot && (
                    <div
                        data-testid="ohlcv-row"
                        className={`pointer-events-none absolute left-2 z-10 flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-control bg-zinc-950/80 px-2 py-0.5 text-ui-dense tabular-nums text-zinc-500 ${levels.length > 0 ? 'max-w-[calc(100%-204px)]' : 'max-w-[calc(100%-16px)]'}`}
                        style={{ top: status === 'live' ? (legendExpanded ? '5.5rem' : '2.75rem') : '0.375rem' }}
                    >
                        <span className="font-mono tabular-nums">H <span className="text-zinc-300">{ohlcvRow.high24h ? fmtPriceForChart(ohlcvRow.high24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">L <span className="text-zinc-300">{ohlcvRow.low24h ? fmtPriceForChart(ohlcvRow.low24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">Vol <span className="text-zinc-300">{ohlcvRow.volume24h ? fmtUsdForChart(ohlcvRow.volume24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">OI <span className="text-zinc-300">{ohlcvRow.oiValue ? fmtUsdForChart(ohlcvRow.oiValue) : '—'}</span></span>
                        <span className="font-mono tabular-nums">Oracle <span className="text-zinc-300">{ohlcvRow.oracle ? fmtPriceForChart(ohlcvRow.oracle) : '—'}</span></span>
                    </div>
                )}
                {levels.length > 0 && (
                    <span className="pointer-events-none absolute right-3 top-2 z-10 rounded-full bg-zinc-800/80 px-2 py-0.5 text-ui-2xs text-zinc-400" title="Current verdict levels drawn on the chart" data-testid="verdict-overlay-chip">
                        Verdict overlay · {levels.map(l => l.label).join(' ')}
                    </span>
                )}
                {hiddenLowerTfCount > 0 && (
                    <button
                        type="button"
                        data-testid="lower-tf-hidden-pill"
                        onClick={() => setShowLowerTfDrawings(v => !v)}
                        title={showLowerTfDrawings
                            ? 'Hide the lower-timeframe drawings again'
                            : 'Temporarily show the drawings anchored on lower timeframes'}
                        className="absolute bottom-2 left-3 z-10 rounded-full border border-hairline bg-zinc-900/80 px-2 py-0.5 font-mono text-ui-2xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                    >
                        {hiddenLowerTfCount} lower-TF hidden{showLowerTfDrawings ? ' · showing' : ''}
                    </button>
                )}
                {railCollapsed && (
                    <button
                        type="button"
                        data-testid="rail-expand-toggle"
                        onClick={() => setRailCollapsed(false)}
                        title="Expand drawing rail (Ctrl+Alt+D)"
                        aria-label="Expand drawing rail"
                        className="absolute bottom-2 left-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-control border border-hairline bg-zinc-950 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
                    >
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                )}
                <div ref={hostRef} className="absolute inset-0" />
                <canvas
                    ref={overlayRef}
                    data-testid="draw-overlay"
                    className={`absolute inset-0 z-10 h-full w-full ${toolActive ? (tool === 'erase' ? 'cursor-pointer' : 'cursor-crosshair') : 'pointer-events-none'}`}
                    style={{ touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
                {draft && toolActive && (() => {
                    const a = draft.points[0];
                    const b = draft.points[draft.points.length - 1];
                    const da = toData(a.x, a.y);
                    const db = draft.points.length >= 2 ? toData(b.x, b.y) : null;
                    const isPosBox = tool === 'long_position' || tool === 'short_position';
                    let text = 'Click to place · Esc cancels';
                    if (da && db && Math.abs(da.p) > 0) {
                        const pct = ((db.p - da.p) / da.p) * 100;
                        const bars = Math.round(Math.abs(db.t - da.t) / Math.max(1, intervalSeconds(interval)));
                        text = isPosBox
                            ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% · ${bars} bars · R:R 2.0 · click commits`
                            : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% · ${bars} bars`;
                    } else if (da && db) {
                        text = `${b.x >= a.x ? '+' : ''}${Math.round(b.x - a.x)}px · click commits`;
                    }
                    const hostW = hostRef.current?.clientWidth ?? 600;
                    return (
                        <div
                            data-testid="draft-readout"
                            className="pointer-events-none absolute z-20 whitespace-nowrap rounded-control bg-zinc-950/90 px-2 py-0.5 font-mono text-ui-dense text-zinc-300"
                            style={{
                                left: Math.min(Math.max(8, b.x + 14), Math.max(8, hostW - 170)),
                                top: Math.max(4, b.y - 26),
                            }}
                        >
                            {text}
                        </div>
                    );
                })()}
                {selectedDrawingId && !draft && !textEdit && (() => {
                    const sel = [...drawings, ...(modelDrawings ?? [])].find(d => d.id === selectedDrawingId);
                    if (!sel || !sel.points[0]) return null;
                    const anchor = toScreen(sel.points[0]);
                    if (!anchor) return null;
                    const locked = sel.locked === true;
                    const isModelShape = (modelDrawings ?? []).some(d => d.id === sel.id);
                    const patch = (fields: Partial<ChartDrawing>): void => {
                        const bumped = bumpDrawingVersion({ ...sel, ...fields });
                        if (isModelShape) {
                            commitDrawingChange(drawingsRef.current, modelDrawingsRef.current.map(d => (d.id === bumped.id ? bumped : d)));
                        } else {
                            commitDrawingChange(drawingsRef.current.map(d => (d.id === bumped.id ? bumped : d)));
                        }
                    };
                    const hostW = hostRef.current?.clientWidth ?? 600;
                    const left = Math.min(Math.max(8, anchor.x + 10), Math.max(8, hostW - (isPositionBoxKind(sel.kind) ? 520 : 420)));
                    const top = Math.max(6, anchor.y - 40);
                    const allTfs = sel.persistAcrossTf === true;
                    return (
                        <div
                            data-testid="drawing-selection-toolbar"
                            className="motion-popover-in absolute z-20 flex flex-nowrap items-center gap-0.5 whitespace-nowrap rounded-lg border border-hairline bg-zinc-950 px-1.5 py-1 shadow-elevated"
                            style={{ left, top }}
                        >
                            {DRAW_COLORS.map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    disabled={locked}
                                    title={locked ? 'Unlock to restyle' : `Set color ${c}`}
                                    aria-label={`Set drawing color ${c}`}
                                    onClick={() => patch({ color: c })}
                                    className={`h-3.5 w-3.5 rounded-full border transition-transform disabled:opacity-40 ${sel.color === c ? 'scale-110 border-zinc-100' : 'border-transparent hover:scale-105'}`}
                                    style={{ backgroundColor: c }}
                                />
                            ))}
                            <span className="mx-1 h-3.5 w-px bg-white/[0.10]" aria-hidden />
                            <button
                                type="button"
                                disabled={locked}
                                title={locked ? 'Unlock to restyle' : `Line width ${drawWidthOf(sel)}px — next weight`}
                                aria-label={`Line width ${drawWidthOf(sel)} pixels`}
                                onClick={() => patch({ width: nextDrawWidth(drawWidthOf(sel)) })}
                                className="flex h-6 min-w-8 items-center justify-center rounded-control px-1 font-mono text-ui-dense text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40"
                            >{`${drawWidthOf(sel)}px`}</button>
                            <button
                                type="button"
                                disabled={locked}
                                title={locked ? 'Unlock to restyle' : sel.dash ? 'Solid line' : 'Dashed line'}
                                aria-label={sel.dash ? 'Line style dashed' : 'Line style solid'}
                                aria-pressed={sel.dash === true}
                                onClick={() => patch({ dash: !sel.dash })}
                                className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40"
                            >
                                <span aria-hidden className={`block w-4 ${sel.dash ? 'border-t-2 border-dashed border-current' : 'border-t-2 border-current'}`} />
                            </button>
                            <button
                                type="button"
                                disabled={locked}
                                data-testid="selection-tf-toggle"
                                title={allTfs ? 'Visible on All TFs — click to scope to <= created TF' : 'Visible on <= created TF — click to show on All TFs'}
                                aria-label="Toggle timeframe visibility"
                                aria-pressed={allTfs}
                                onClick={() => patch({ persistAcrossTf: !allTfs })}
                                className={`flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-control px-1.5 font-mono text-ui-2xs transition-colors hover:bg-white/[0.06] disabled:opacity-40 ${
                                    allTfs ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                {allTfs ? 'All TFs' : `≤ ${sel.createdOnTf ?? interval}`}
                            </button>
                            <span className="mx-1 h-3.5 w-px bg-white/[0.10]" aria-hidden />
                            <button
                                type="button"
                                data-testid="selection-arm-watch-btn"
                                title={`Arm price watch @ $${fmtPriceForChart(sel.points[0].p)}`}
                                aria-label="Arm price watch on selected drawing"
                                onClick={() => handleArmWatchAtPrice(sel.points[0].p, sel.shortId ?? sel.label ?? sel.kind)}
                                className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                            >
                                <BellIcon className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                data-testid="selection-ask-august-btn"
                                title={`Ask August about ${sel.shortId ?? sel.kind}`}
                                aria-label="Ask August about selected drawing"
                                onClick={() => handleAskAugust(sel.shortId ?? `${sel.kind} @ $${fmtPriceForChart(sel.points[0].p)}`)}
                                className="flex h-6 items-center gap-1 rounded-control px-1.5 font-mono text-ui-2xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-50"
                            >
                                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                                <span>Ask</span>
                            </button>
                            {isPositionBoxKind(sel.kind) && (() => {
                                const boxReadout = computePositionBoxReadout(sel.kind, sel.points, harnessSizing);
                                if (!boxReadout) return null;
                                const stageDisabled = planMode || !paperEnabled || boxReadout.inverted;
                                const stageTitle = planMode
                                    ? 'Disabled in Plan Mode (read-only)'
                                    : !paperEnabled
                                        ? 'Enable Paper Mode in Settings'
                                        : boxReadout.inverted
                                            ? 'Position geometry is inverted'
                                            : `Stage Paper ${boxReadout.direction} @ $${fmtPriceForChart(boxReadout.entry)}`;
                                return (
                                    <>
                                        <span className="mx-1 h-3.5 w-px bg-white/[0.10]" aria-hidden />
                                        <button
                                            type="button"
                                            data-testid="position-box-audit-btn"
                                            title="Audit this position box with August"
                                            onClick={() => handleAskAugust(buildPositionBoxAuditPrompt(symbol, boxReadout, sel.shortId))}
                                            className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-control px-1.5 font-mono text-ui-2xs text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-zinc-50"
                                        >
                                            Audit
                                        </button>
                                        <button
                                            type="button"
                                            data-testid="position-box-stage-paper-btn"
                                            disabled={stageDisabled}
                                            title={stageTitle}
                                            onClick={() => { void handleStagePaperFromPositionBox(sel); }}
                                            className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-control border border-hairline px-1.5 font-mono text-ui-2xs transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40 ${
                                                boxReadout.direction === 'Long' ? 'text-emerald-400' : 'text-rose-400'
                                            }`}
                                        >
                                            Stage Paper
                                        </button>
                                    </>
                                );
                            })()}
                            <span className="mx-1 h-3.5 w-px bg-white/[0.10]" aria-hidden />
                            <button
                                type="button"
                                title={locked ? 'Unlock drawing' : 'Lock drawing'}
                                aria-label={locked ? 'Unlock drawing' : 'Lock drawing'}
                                aria-pressed={locked}
                                onClick={() => patch({ locked: !locked })}
                                className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors hover:bg-white/[0.06] ${locked ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                            >
                                {locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Unlock className="h-3.5 w-3.5" aria-hidden />}
                            </button>
                            <button
                                type="button"
                                title={inspector?.drawingId === sel.id ? 'Close exact-price inspector' : 'Exact-price inspector'}
                                aria-label="Exact price inspector"
                                aria-pressed={inspector?.drawingId === sel.id}
                                onClick={() => setInspector(inspector?.drawingId === sel.id ? null : { drawingId: sel.id, x: anchor.x, y: anchor.y })}
                                className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors hover:bg-white/[0.06] ${inspector?.drawingId === sel.id ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                            >
                                <Target className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <button
                                type="button"
                                disabled={locked}
                                title={locked ? 'Unlock to delete' : 'Delete drawing'}
                                aria-label="Delete drawing"
                                onClick={() => deleteDrawingById(sel.id)}
                                className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                        </div>
                    );
                })()}
                {inspector && (() => {
                    const targetDrawing = [...drawings, ...(modelDrawings ?? [])].find(d => d.id === inspector.drawingId);
                    if (!targetDrawing) return null;
                    return (
                        <DrawingInspectorPopover
                            key={`${targetDrawing.id}:${targetDrawing.version ?? 1}`}
                            drawing={targetDrawing}
                            anchorX={inspector.x}
                            anchorY={inspector.y}
                            containerWidth={hostRef.current?.clientWidth ?? 640}
                            containerHeight={hostRef.current?.clientHeight ?? 420}
                            onApply={applyInspectorUpdate}
                            onDelete={deleteDrawingById}
                            onClose={() => setInspector(null)}
                        />
                    );
                })()}
                {textEdit && (
                    <input
                        autoFocus
                        data-testid="text-note-editor"
                        defaultValue={drawingsRef.current.find(d => d.id === textEdit.id)?.label ?? ''}
                        onChange={ev => renameTextDrawing(textEdit.id, ev.target.value)}
                        onKeyDown={ev => {
                            if (ev.key === 'Enter') finishTextEdit(false);
                            if (ev.key === 'Escape') finishTextEdit(true);
                        }}
                        onBlur={() => finishTextEdit(false)}
                        placeholder="Type a note…"
                        className="absolute z-20 w-40 rounded-control border border-line bg-zinc-900 px-1.5 py-0.5 text-ui-dense text-zinc-100 focus:outline-none"
                        style={{
                            left: Math.min(textEdit.x + 6, Math.max(8, (hostRef.current?.clientWidth ?? 400) - 170)),
                            top: Math.max(4, textEdit.y - 24),
                        }}
                    />
                )}
                </div>
            </ChartFrame>
        </div>
    );
};

export default React.memo(TradingChart);
