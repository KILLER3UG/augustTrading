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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import TimeframeBar from './TimeframeBar';
import {
    createChart,
    CandlestickSeries,
    HistogramSeries,
    LineSeries,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type SeriesType,
    type UTCTimestamp,
} from 'lightweight-charts';
import { fetchKlines } from '../../services/analysis/KlineService';
import { phtAxisTick } from '../../utils/timezone';
import { toCandles, toVolumes, verdictLevels, VOLUME_UP, VOLUME_DOWN, type ChartLevel } from '../../services/trade/chartData';
import {
    loadDrawings, saveDrawings, loadSessionDrawings, createDrawingId, pointsForKind, FIB_RATIOS,
    drawWidthOf, nextDrawWidth, DRAW_WIDTH_DEFAULT,
    type ChartDrawing, type DrawKind, type DrawPoint, type DrawTool, DRAW_COLORS,
} from '../../services/trade/chartDrawings';
import { drawingsControl, capDrawings } from '../../services/trade/drawingsControl';
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
import { ChartToolRail, CHART_RAIL_WIDTH } from './ChartToolRail';
import ChartFrame from '../shared/ChartFrame';
import { shapeGeometry } from './drawingGeometry';
import {
    bollingerSeries,
    emaSeries,
    macdSeries,
    rsiSeries,
    tsiSeries,
    type Series,
} from '../../services/trade/chartIndicators';
import {
    CHART_INDICATOR_IDS,
    CHART_INDICATOR_LABELS,
    CHART_INDICATOR_PANE,
    readChartIndicatorSettings,
    writeChartIndicatorSettings,
    type ChartIndicatorId,
    type ChartIndicatorSettings,
} from '../../services/trade/chartIndicatorSettings';

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
const CANDLE_UP = (): string => chartColor('--color-emerald-500', '#10b981');
const CANDLE_DOWN = (): string => chartColor('--color-rose-500', '#f43f5e');

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
    capturedAt: number;
}

interface TradingChartProps {
    symbol: string;
    interval: ChartInterval;
    onIntervalChange: (interval: ChartInterval) => void;
    /** The ACTIVE Chart AI session — when set, drawings are SESSION-scoped
     *  (each session is its own chart with its own shapes) instead of
     *  shared per symbol. */
    sessionId?: string;
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
}

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
        <span className="font-mono text-ui-micro text-zinc-400">
            {`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
        </span>
    );
};

/** The sub-pane studies, in the order OKX stacks them. Fixed, so pane indices
 *  are deterministic and the legend rows can be laid out in the same order. */
const SUB_PANE_ORDER = ['rsi', 'macd', 'tsi'] as const satisfies readonly ChartIndicatorId[];

/** One bar as the legend describes it: OHLC plus the study values at that bar. */
interface LegendBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    values: Record<string, number | null>;
}

/** Distance from a point to a segment — the eraser's hit test (screen px). */
const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const TradingChart: React.FC<TradingChartProps> = ({ symbol, interval, onIntervalChange, sessionId, verdict, showSma = false, live = false, liveKline, lastPrice, markPrice, chartHandle, onDrawingsChange, modelDrawings, onRemoveModelShape, chatLevels, ohlcvRow }) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    // The 24h fields are a CROSSHAIR readout (v3): they appear while the
    // pointer is over the plot and leave with it, so the resting chart is the
    // tape and nothing else.
    const [overPlot, setOverPlot] = useState(false);
    /** The bar the legend describes: the crosshair's bar while the pointer is
     *  over the plot, otherwise the last bar. The values come from the same
     *  computed series the lines are drawn from. */
    const [legendBar, setLegendBar] = useState<LegendBar | null>(null);
    const legendTimeRef = useRef<number | null>(null);
    /** The last-price tag on the axis: price, its screen Y, the bar's open time
     *  (for the countdown) and the bar's direction (for the colour). */
    const [lastTag, setLastTag] = useState<{ y: number; price: number; up: boolean; barTime: number } | null>(null);
    /** The price under the crosshair, with its % from the last price — OKX's
     *  crosshair label. Main pane only; a sub-pane has its own scale. */
    const [crossPrice, setCrossPrice] = useState<{ y: number; price: number; pct: number } | null>(null);
    const lastTagRef = useRef<{ y: number; price: number } | null>(null);
    /** Position the tag. Guarded, so panning within a pixel of the same price
     *  does not re-render the whole chart. */
    const updateLastTag = useCallback((): void => {
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
    }, []);
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
    /** Every series living on a SUB-pane (RSI / MACD / TSI), so the mount
     *  cleanup can drop them and the rebuild can start from pane 1. */
    const subPaneSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
    /** The bars and the computed studies, so the legend under the crosshair
     *  reads the SAME series the lines are drawn from. */
    const legendRef = useRef<{
        times: number[];
        bars: { open: number; high: number; low: number; close: number }[];
        volumes: Map<number, number>;
        series: Record<string, Series>;
    } | null>(null);
    const levelLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
    const markLineRef = useRef<IPriceLine | null>(null);
    /** The chart's own dotted last-price line (the library's is replaced). */
    const lastLineRef = useRef<IPriceLine | null>(null);
    /** Key-level lines the DOCK pushed (message card + chart toggle) — id →
     *  price line, diffed on every push. Transient view state, never saved. */
    const chatLevelLinesRef = useRef<Map<string, IPriceLine>>(new Map());
    const [status, setStatus] = useState<'loading' | 'live' | 'unavailable'>('loading');
    const [levels, setLevels] = useState<ChartLevel[]>([]);
    /** Which studies are drawn, per user. The SERIES come from
     *  `chartIndicators.ts` — the same module the prompt reads — so a line on
     *  the screen is the number in the model's context. This state only says
     *  which of them are visible; it cannot change a value. */
    const [indicatorSettings, setIndicatorSettings] = useState<ChartIndicatorSettings>(
        () => readChartIndicatorSettings(getActiveUsername() || 'default'),
    );
    /** Back-compat with the old single `ƒSMA` toggle: on when ANY study is on,
     *  so a caller forcing `showSma` still lights the button. */
    const indicatorsOn = Object.values(indicatorSettings.visible).some(Boolean) || showSma;
    const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
    const toggleIndicator = (id: ChartIndicatorId) => {
        setIndicatorSettings(prev => {
            const next: ChartIndicatorSettings = { visible: { ...prev.visible, [id]: !prev.visible[id] } };
            writeChartIndicatorSettings(getActiveUsername() || 'default', next);
            return next;
        });
    };

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
                    {v.ema20 && <span>EMA(20) <span className="text-amber-300">{fmt(bar.values.ema20 ?? null)}</span></span>}
                    {v.ema200 && <span>EMA(200) <span className="text-purple-300">{fmt(bar.values.ema200 ?? null)}</span></span>}
                </div>
            ));
        }
        if (v.boll) {
            rows.push((
                <div key="boll" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>BOLL <span className="text-cyan-300">{fmt(bar.values.bollMid ?? null)}</span></span>
                    <span>UB <span className="text-cyan-300">{fmt(bar.values.bollUpper ?? null)}</span></span>
                    <span>LB <span className="text-cyan-300">{fmt(bar.values.bollLower ?? null)}</span></span>
                </div>
            ));
        }
        if (v.rsi) {
            rows.push((
                <div key="rsi" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>RSI(6) <span className="text-amber-300">{num(bar.values.rsi6 ?? null)}</span></span>
                    <span>RSI(14) <span className="text-yellow-200">{num(bar.values.rsi14 ?? null)}</span></span>
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
                    <span>MACD <span className="text-cyan-300">{num(hist === null ? null : 2 * hist, 1)}</span></span>
                    <span>DIF <span className="text-amber-300">{num(dif, 1)}</span></span>
                    <span>DEA <span className="text-rose-300">{num(dea, 1)}</span></span>
                </div>
            ));
        }
        if (v.tsi) {
            rows.push((
                <div key="tsi" className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>TSI(25, 13, 13) <span className="text-amber-300">{num(bar.values.tsi ?? null)}</span></span>
                    <span>Signal <span className="text-rose-300">{num(bar.values.tsiSignal ?? null)}</span></span>
                </div>
            ));
        }
        return rows;
    };

    // ─── Drawings state ─────────────────────────────────────────────────────
    const overlayRef = useRef<HTMLCanvasElement | null>(null);
    const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
    const [tool, setTool] = useState<DrawTool>('cursor');
    const [color, setColor] = useState<string>(DRAW_COLORS[0]);
    /** In-progress shape in SCREEN space while the user is clicking/dragging. */
    const [draft, setDraft] = useState<{ points: { x: number; y: number }[] } | null>(null);
    /** Hide-all (the rail's eye): every drawing layer off the canvas, nothing
     *  deleted — TradingView's "hide all objects" toggle. */
    const [drawingsHidden, setDrawingsHidden] = useState(false);
    /** Magnet snap: each anchor is pulled onto the nearest candle's OHLC. A
     *  drawing aid, not an edit — the trader still chooses WHERE, the magnet
     *  only removes the few ticks of hand error. */
    const [magnet, setMagnet] = useState(false);
    /** Stroke weight for NEW shapes; the rail cycles the ladder. Committed
     *  shapes keep the width they were drawn at, so changing the control does
     *  not restyle the trader's existing work. */
    const [lineWidth, setLineWidth] = useState<number>(DRAW_WIDTH_DEFAULT);
    const drawingsHiddenRef = useRef(drawingsHidden);
    drawingsHiddenRef.current = drawingsHidden;
    /** Live-editing a text note: which drawing id + where its input renders. */
    const [textEdit, setTextEdit] = useState<{ id: string; x: number; y: number } | null>(null);
    const lastTickRef = useRef<number>(Date.now());
    const drawingsRef = useRef<ChartDrawing[]>([]);
    drawingsRef.current = drawings;
    const modelDrawingsRef = useRef<ChartDrawing[]>([]);
    modelDrawingsRef.current = modelDrawings ?? [];
    // Stable handle to the latest repaint() so the data-lifecycle effect (which
    // runs before repaint is defined) can force a repaint the instant a coin's
    // candles (re)load — otherwise a switch BACK reloads the shapes into state
    // but, with status already 'live', nothing repaints them (invisible until a
    // manual pan). Synced below once repaint exists.
    const repaintRef = useRef<() => void>(() => {});

    // Load the persisted shapes whenever the chart (session + symbol)
    // changes: session-scoped when the active session is known, legacy
    // per-symbol otherwise. The session load is async (a file read on
    // desktop), so the cancelled guard is what makes a rapid session/coin
    // switch settle on the LAST switch's shapes — a slower stale read must
    // never land after a newer one and paint the wrong session's shapes.
    useEffect(() => {
        let cancelled = false;
        setDraft(null);
        setTool('cursor');
        setTextEdit(null);
        const load = async (): Promise<void> => {
            const list = sessionId ? await loadSessionDrawings(sessionId, symbol) : loadDrawings(symbol);
            if (!cancelled) setDrawings(list);
        };
        void load();
        return () => { cancelled = true; };
    }, [symbol, sessionId]);

    // Esc cancels an in-progress shape (TradingView behaviour) — the draft
    // lives across pointer moves, so the listener rides its lifetime.
    useEffect(() => {
        if (!draft) return;
        const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') setDraft(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [draft]);

    const publishDrawings = useCallback((next: ChartDrawing[]): void => {
        setDrawings(next);
        // Through the control, so the USER's bucket gets the same cap the store
        // enforces as the model's — this path used to save directly and relied
        // on every save remembering to trim.
        if (sessionId) drawingsControl('user', sessionId, symbol).replace(next);
        else saveDrawings(symbol, capDrawings(next));
        onDrawingsChange?.(next);
    }, [symbol, sessionId, onDrawingsChange]);

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
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
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
        chartRef.current = chart;
        candlesRef.current = candles;
        volumeRef.current = volume;
        const onCrosshair = (param: Parameters<Parameters<IChartApi['subscribeCrosshairMove']>[0]>[0]) => {
            setOverPlot(!!param?.time);
            const t = param?.time;
            const data = legendRef.current;
            // The legend follows the crosshair's BAR, so it only re-renders when
            // the bar changes — not on every pixel of pointer movement.
            const point = param?.point;
            const cs = candlesRef.current;
            if (!point || param?.paneIndex !== 0 || !cs || typeof cs.coordinateToPrice !== 'function') {
                setCrossPrice(null);
            } else {
                const price = cs.coordinateToPrice(point.y as never);
                const bars = (cs.data?.() ?? []) as readonly { close: number }[];
                const lastClose = bars[bars.length - 1]?.close;
                if (price === null || price === undefined || !Number.isFinite(Number(price)) || !lastClose) {
                    setCrossPrice(null);
                } else {
                    const p = Number(price);
                    const pct = ((p - lastClose) / lastClose) * 100;
                    setCrossPrice(prev => (prev && Math.abs(prev.y - point.y) < 1 && prev.price === p ? prev : { y: point.y, price: p, pct }));
                }
            }
            if (typeof t !== 'number' || !data) {
                if (legendTimeRef.current !== null) { legendTimeRef.current = null; setLegendBar(null); }
                return;
            }
            if (t === legendTimeRef.current) return;
            legendTimeRef.current = t;
            const idx = data.times.indexOf(t);
            const bar = idx >= 0 ? data.bars[idx] : undefined;
            if (!bar) { setLegendBar(null); return; }
            const values: Record<string, number | null> = {};
            for (const [k, s] of Object.entries(data.series)) values[k] = s[idx] ?? null;
            setLegendBar({ time: t, ...bar, values });
        };
        chart.subscribeCrosshairMove(onCrosshair);
        return () => {
            chart.unsubscribeCrosshairMove(onCrosshair);
            chart.remove();
            chartRef.current = null;
            candlesRef.current = null;
            volumeRef.current = null;
            indicatorSeriesRef.current = [];
            subPaneSeriesRef.current = [];
            levelLinesRef.current = [];
            markLineRef.current = null;
            // The chat-level lines died with the chart — forget them so the
            // next mount's diff recreates instead of applyOptions-ing ghosts.
            chatLevelLinesRef.current = new Map();
        };
    }, []);

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
        // candles, volume and the mark price line — so no stale price prints
        // on the new chart during the history fetch (the "BTC mark on a ZEN
        // chart" data-discrepancy flag).
        if (dataSymbolRef.current !== symbol) {
            dataSymbolRef.current = symbol;
            if (markLineRef.current) {
                try { candlesRef.current?.removePriceLine(markLineRef.current); } catch { /* series gone */ }
                markLineRef.current = null;
            }
            candlesRef.current?.setData([]);
            volumeRef.current?.setData([]);
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
                cs.setData(candles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
                vs.setData(toVolumes(klines).map(v => ({ ...v, time: v.time as UTCTimestamp })));
                setStatus('live');
                lastTickRef.current = Date.now();
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
        if (live) {
            // Stall watchdog: any gap in the push stream gets healed by a
            // history re-sync instead of leaving a frozen last bar.
            watchdog = window.setInterval(() => {
                if (Date.now() - lastTickRef.current > LIVE_STALL_MS) void load(false);
            }, 5000);
        }
        return () => { cancelled = true; window.clearTimeout(timer); window.clearInterval(watchdog); };
    }, [symbol, interval, live]);

    // Live kline stream: patch the last bar in place (sub-second ticks).
    useEffect(() => {
        if (!liveKline || !candlesRef.current || !volumeRef.current) return;
        lastTickRef.current = Date.now();
        const t = Math.floor(liveKline.openTime / 1000);
        candlesRef.current.update({
            time: t as UTCTimestamp,
            open: liveKline.open, high: liveKline.high, low: liveKline.low, close: liveKline.close,
        });
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
                cs.update({ time: Math.floor(last.time / 1000) as UTCTimestamp, open: last.open, high: last.high, low: last.low, close: last.close });
            }).catch(() => { /* the next tick or the watchdog covers it */ });
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
        const color = up ? chartColor('--color-emerald-500', '#10b981') : chartColor('--color-rose-500', '#f43f5e');
        const opts = { price: last.close, color, lineWidth: 1 as const, lineStyle: 1 as const };
        if (lastLineRef.current) {
            try { lastLineRef.current.applyOptions(opts); return; } catch { removeLine(); }
        }
        try {
            // No axis label: the chart draws its own tag with a countdown.
            lastLineRef.current = cs.createPriceLine({ ...opts, axisLabelVisible: false }) ?? null;
        } catch { /* series without price-line support (test mock) */ }
        updateLastTag();
    }, [lastPrice, markPrice, status, interval, liveKline, updateLastTag]);

    // Realtime price line: the live ticker/mark price gets its own dashed
    // "mark" line updated on every tick — visible immediately, unlike the
    // built-in last-close line which only moves when the open bar updates.
    useEffect(() => {
        const cs = candlesRef.current;
        if (!cs) return;
        const removeLine = (): void => {
            if (markLineRef.current) {
                try { cs.removePriceLine?.(markLineRef.current); } catch { /* already gone */ }
                markLineRef.current = null;
            }
        };
        // The line is titled 'mark', so prefer the real mark price; lastPrice
        // remains the fallback (e.g. feeds where markPrice@1s is unavailable).
        const price = markPrice ?? lastPrice;
        if (price == null || !Number.isFinite(price)) { removeLine(); return; }
        if (markLineRef.current) {
            try { markLineRef.current.applyOptions({ price }); return; } catch { removeLine(); }
        }
        try {
            markLineRef.current = cs.createPriceLine({
                price, color: chartColor('--color-cyan-500', '#06b6d4'), lineWidth: 1, lineStyle: 2,
                axisLabelVisible: true, title: 'mark',
            }) ?? null;
        } catch { /* series without price-line support (test mock) */ }
    }, [lastPrice, markPrice, status]);

    // Indicator overlays. Every series comes from `chartIndicators`, the ONE
    // module the prompt reads, so the line the trader sees and the number the
    // model is given are the same computation. The hand-rolled `sma()` is
    // retired with it. Main-pane studies only for now — RSI/MACD/TSI need their
    // own panes, which is the next step.
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        for (const s of indicatorSeriesRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
        indicatorSeriesRef.current = [];
        const candles = (candlesRef.current?.data?.() ?? []) as readonly { time: number; open: number; high: number; low: number; close: number }[];
        if (candles.length === 0) return;
        const times = candles.map(c => c.time as UTCTimestamp);
        const closes = candles.map(c => c.close);
        const addLine = (values: Series, color: string) => {
            const series = chart.addSeries(LineSeries, {
                color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
            });
            series.setData(times
                .map((t, i) => (values[i] === null ? null : { time: t, value: values[i] as number }))
                .filter((p): p is { time: UTCTimestamp; value: number } => p !== null));
            indicatorSeriesRef.current.push(series);
        };
        const visible = indicatorSettings.visible;
        bandRef.current = null;
        // Each study is computed ONCE and shared by the series and the legend,
        // so the number under the crosshair is the number on the line.
        const legendSeries: Record<string, Series> = {};
        if (visible.ema20) { legendSeries.ema20 = emaSeries(closes, 20); addLine(legendSeries.ema20, chartColor('--color-amber-500', '#f59e0b')); }
        if (visible.ema200) { legendSeries.ema200 = emaSeries(closes, 200); addLine(legendSeries.ema200, chartColor('--color-purple-400', '#a78bfa')); }
        if (visible.boll) {
            const band = bollingerSeries(closes, 20, 2);
            legendSeries.bollMid = band.mid;
            legendSeries.bollUpper = band.upper;
            legendSeries.bollLower = band.lower;
            addLine(band.mid, chartColor('--color-cyan-500', '#06b6d4'));
            addLine(band.upper, chartColor('--color-cyan-500', '#06b6d4'));
            addLine(band.lower, chartColor('--color-cyan-500', '#06b6d4'));
            bandRef.current = { times: candles.map(c => c.time), upper: band.upper, lower: band.lower };
        }
        if (visible.rsi) legendSeries.rsi = rsiSeries(closes, 14);
        if (visible.macd) { const m = macdSeries(closes); legendSeries.macd = m.macd; legendSeries.macdSignal = m.signal; }
        if (visible.tsi) { const t = tsiSeries(closes); legendSeries.tsi = t.tsi; legendSeries.tsiSignal = t.signal; }
        // Sub-panes, in a FIXED order so the indices are deterministic. The
        // whole set is torn down and rebuilt on every change: `removePane`
        // shifts every pane above it, so a stale index would put the wrong
        // study in the wrong pane.
        for (const s of subPaneSeriesRef.current) { try { chart.removeSeries(s); } catch { /* already gone */ } }
        subPaneSeriesRef.current = [];
        while (chart.panes().length > 1) {
            try { chart.removePane(chart.panes().length - 1); } catch { break; }
        }
        const addSub = (series: ISeriesApi<SeriesType>): void => { subPaneSeriesRef.current.push(series); };
        const putLine = (pane: number, values: Series, color: string, scaleId?: string): void => {
            const s = chart.addSeries(LineSeries, {
                color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
                crosshairMarkerVisible: false, ...(scaleId ? { priceScaleId: scaleId } : {}),
            }, pane);
            s.setData(times.map((t, i) => (values[i] === null ? null : { time: t, value: values[i] as number }))
                .filter((p): p is { time: UTCTimestamp; value: number } => p !== null));
            addSub(s);
        };
        const putHist = (pane: number, values: Series): void => {
            const s = chart.addSeries(HistogramSeries, {
                priceLineVisible: false, lastValueVisible: false,
            }, pane);
            s.setData(times.map((t, i) => {
                const v = values[i];
                return v === null ? null : {
                    time: t, value: v,
                    color: v >= 0 ? 'rgba(7,181,106,0.55)' : 'rgba(247,93,95,0.55)',
                };
            }).filter((p): p is { time: UTCTimestamp; value: number; color: string } => p !== null));
            addSub(s);
        };
        let paneIndex = 1;
        for (const id of SUB_PANE_ORDER) {
            if (!visible[id]) continue;
            const pane = paneIndex;
            if (id === 'rsi') {
                legendSeries.rsi6 = rsiSeries(closes, 6);
                legendSeries.rsi14 = rsiSeries(closes, 14);
                legendSeries.rsi24 = rsiSeries(closes, 24);
                putLine(pane, legendSeries.rsi6, '#f08800', 'rsi');
                putLine(pane, legendSeries.rsi14, '#facc15', 'rsi');
                putLine(pane, legendSeries.rsi24, '#a3e635', 'rsi');
                chart.priceScale('rsi', pane).applyOptions({ visible: false });
            } else if (id === 'macd') {
                const m = macdSeries(closes);
                legendSeries.macd = m.macd;
                legendSeries.macdSignal = m.signal;
                putHist(pane, m.histogram);
                putLine(pane, m.macd, '#06b6d4');
                putLine(pane, m.signal, '#f472b6');
            } else if (id === 'tsi') {
                const t = tsiSeries(closes);
                legendSeries.tsi = t.tsi;
                legendSeries.tsiSignal = t.signal;
                putLine(pane, t.tsi, '#f59e0b', 'tsi');
                putLine(pane, t.signal, '#f472b6', 'tsi');
                chart.priceScale('tsi', pane).applyOptions({ visible: false });
            }
            const paneApi = chart.panes()[pane];
            if (paneApi) paneApi.setHeight(110);
            paneIndex += 1;
        }
        legendRef.current = {
            times: candles.map(c => c.time),
            bars: candles.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
            volumes: new Map(((volumeRef.current?.data?.() ?? []) as readonly { time: number; value: number }[])
                .map(p => [p.time, p.value] as const)),
            series: legendSeries,
        };
        repaintRef.current();
    }, [symbol, interval, indicatorSettings, status]);

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
        setLegendBar({ time: data.times[idx], ...bar, values });
    }, [overPlot, indicatorSettings, symbol, interval, status]);

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

    /** Continuous bar-space position of a stored unix time: 0 = the first
     *  loaded bar, fractional between bars, NEGATIVE left of the window and
     *  > length-1 right of it. This is the drawings' data-space ruler, and the
     *  reason a timeframe switch keeps shapes in place: the stored time maps
     *  through the LOADED candles' own spacing (a perp's grid is uniform), so
     *  a bar-grid change re-scales positions instead of dropping the anchors.
     *  The previous conversion binary-searched the nearest bar and CLAMPED
     *  times outside the loaded window onto its first/last bar — a drawing
     *  anchored a week back collapsed onto the left edge the moment a shorter
     *  timeframe shrank the loaded window. Extrapolation keeps the anchor at
     *  its true time: logicalToCoordinate maps out-of-data logicals linearly,
     *  so a trendline to an off-window anchor still paints the segment that
     *  crosses the viewport, and panning to it finds it where the time says. */
    const logicalForTime = useCallback((t: number): number | null => {
        const cs = candlesRef.current;
        const data = (cs?.data?.() ?? []) as readonly { time: number }[];
        if (data.length === 0) return null;
        const step = data.length > 1
            ? (data[data.length - 1].time - data[0].time) / (data.length - 1)
            : intervalSeconds(interval);
        return (t - data[0].time) / step;
    }, [interval]);

    const toScreen = useCallback((p: DrawPoint): { x: number; y: number } | null => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return null;
        const ts = chart.timeScale();
        // Test mocks (and mid-teardown windows) may lack the logical API —
        // conversion is impossible there; callers skip those shapes.
        if (typeof ts.logicalToCoordinate !== 'function' || typeof cs.priceToCoordinate !== 'function') return null;
        const idx = logicalForTime(p.t);
        if (idx === null) return null;
        // x converts through an in-window REFERENCE PAIR rather than asking
        // logicalToCoordinate for the anchor's own logical. The pair is
        // mathematically identical to the direct call — the scale is linear
        // for ANY logical (negative, fractional, beyond the data) — but it
        // pins the conversion to THIS library's contract instead of assuming
        // it, and it measures px-per-bar from live bars rather than trusting
        // a configured default. The vanishing the audit measured came from
        // the old CLAMP (an out-of-window anchor collapsed onto bar 0: a
        // zero-width shape or a warped slope), not from a null here.
        const data = (cs.data?.() ?? []) as readonly { time: number }[];
        if (data.length < 2) return null;
        const l1 = Math.floor((data.length - 1) / 2);
        const x1 = ts.logicalToCoordinate(l1 as never);
        const x2 = ts.logicalToCoordinate((l1 + 1) as never);
        if (x1 === null || x1 === undefined || x2 === null || x2 === undefined) return null;
        const pxPerBar = Number(x2) - Number(x1);
        if (!Number.isFinite(pxPerBar) || pxPerBar === 0) return null;
        const x = Number(x1) + (idx - l1) * pxPerBar;
        const y = cs.priceToCoordinate(p.p as never);
        if (y === null || y === undefined) return null;
        return { x, y };
    }, [logicalForTime]);

    const toData = useCallback((x: number, y: number): DrawPoint | null => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs) return null;
        const ts = chart.timeScale();
        if (typeof ts.coordinateToLogical !== 'function' || typeof cs.coordinateToPrice !== 'function') return null;
        const logical = ts.coordinateToLogical(x);
        const p = cs.coordinateToPrice(y);
        if (logical === null || logical === undefined || p === null || p === undefined) return null;
        const data = (cs.data?.() ?? []) as readonly { time: number }[];
        if (data.length === 0) return null;
        // Continuous inverse of logicalForTime: a click BETWEEN bars lands
        // between their times, and a click in the padding BEYOND the loaded
        // window anchors at the extrapolated time instead of clamping onto
        // the edge bar (the same warp the read side had).
        const step = data.length > 1
            ? (data[data.length - 1].time - data[0].time) / (data.length - 1)
            : intervalSeconds(interval);
        const t = Math.round(data[0].time + logical * step);
        return { t, p: Number(p) };
    }, [interval]);

    /** Pull a screen point onto the nearest candle's OHLC — the rail's magnet.
     *  The bar is chosen by TIME (the closest one to the click), and the price
     *  is whichever of its four prints is nearest IN PIXELS, so a snap follows
     *  the distance the trader actually sees rather than a price difference the
     *  axis scale can distort. Returns the point unchanged when the chart
     *  cannot answer (no candles, a hidden bar, a test mock): a magnet that
     *  silently moved anchors would be worse than one that does nothing. */
    const magnetPoint = useCallback((pt: { x: number; y: number }): { x: number; y: number } => {
        const chart = chartRef.current;
        const cs = candlesRef.current;
        if (!chart || !cs || typeof cs.priceToCoordinate !== 'function') return pt;
        const ts = chart.timeScale();
        if (typeof ts.coordinateToLogical !== 'function') return pt;
        const logical = ts.coordinateToLogical(pt.x);
        if (logical === null || logical === undefined) return pt;
        const data = (cs.data?.() ?? []) as readonly {
            time: number; open: number; high: number; low: number; close: number;
        }[];
        if (data.length === 0) return pt;
        const i = Math.min(Math.max(Math.round(logical), 0), data.length - 1);
        const c = data[i];
        let bestY = pt.y;
        let best = Infinity;
        for (const price of [c.open, c.high, c.low, c.close]) {
            const y = cs.priceToCoordinate(price as never);
            if (y === null || y === undefined) continue;
            const d = Math.abs(Number(y) - pt.y);
            if (d < best) { best = d; bestY = Number(y); }
        }
        const anchor = toScreen({ t: c.time, p: c.close });
        return { x: anchor ? anchor.x : pt.x, y: bestY };
    }, [toScreen]);

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
        // Never paint over the price-axis gutter (right ~58px) or time axis.
        const plotW = Math.max(0, w - 58);
        const plotH = Math.max(0, h - 28);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, plotW, plotH);
        ctx.clip();

        // Bollinger band fill: upper forward, lower backward, closed. Painted
        // BEFORE the drawings so a shape the trader drew on the band still
        // reads on top of the shade.
        const band = bandRef.current;
        if (band) {
            const top: { x: number; y: number }[] = [];
            const bottom: { x: number; y: number }[] = [];
            for (let i = 0; i < band.upper.length; i += 1) {
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

        const project = (list: ChartDrawing['points']): { x: number; y: number }[] =>
            list.map(pt => toScreen(pt)).filter((s): s is { x: number; y: number } => s !== null);

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
                    ctx.fillStyle = kind === 'high' ? '#f472b6' : '#34d399';
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
                case 'text': {
                    // The annotation string IS the label (user tool + the
                    // model's draw_on_chart kind "text" both set it).
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

        // The eye toggle blanks every layer (draft included) without deleting.
        if (!drawingsHiddenRef.current) {
            for (const d of drawingsRef.current) {
                const pts = project(d.points);
                if (pts.length > 0) drawShape(d.kind, pts, d.color, undefined, d.label, drawWidthOf(d));
            }
            // The model's own shapes (draw_on_chart / mark_trade_levels) render
            // after the user's, same style — their labels ("Entry", "SL"…)
            // announce them. Not persisted into the user's drawing file.
            for (const d of modelDrawingsRef.current) {
                const pts = project(d.points);
                if (pts.length > 0) drawShape(d.kind, pts, d.color, undefined, d.label, drawWidthOf(d));
            }
            if (draft && draft.points.length > 0) {
                const draftKind: DrawKind = tool === 'hline' ? 'hline' : tool === 'rect' ? 'rect' : tool === 'ray' ? 'ray' : tool === 'brush' ? 'brush' : tool === 'fib' ? 'fib' : 'trend';
                drawShape(draftKind, draft.points, color, `${color}22`, undefined, lineWidth);
            }
        }
        ctx.restore();
    }, [toScreen, draft, tool, color]);
    repaintRef.current = repaint;

    // Repaint on state changes and on every pan/zoom the chart performs.
    // repaint() is read through repaintRef (synced during render, before
    // effects run) so this effect does NOT depend on the callback's identity:
    // repaint changes on every pointermove draft update (draft → repaint →
    // deps), and re-subscribing the range/resize listeners per pointermove
    // was pure churn during a drag. draft/tool/color repaints are still
    // driven by the repaintRef being fresh on the next trigger; committed
    // shapes only use their OWN colors, so a tool/color flip without a draft
    // paints nothing new.
    useEffect(() => {
        repaintRef.current();
        const chart = chartRef.current;
        if (!chart) return;
        const handler = (): void => { repaintRef.current(); updateLastTag(); };
        const ts = chart.timeScale();
        // Test mocks may omit the subscription API — painting still works,
        // only pan/zoom repaint is skipped there.
        const sub = ts.subscribeVisibleLogicalRangeChange?.bind(ts);
        const unsub = ts.unsubscribeVisibleLogicalRangeChange?.bind(ts);
        if (sub) sub(handler);
        // jsdom (and older webviews) have no ResizeObserver — painting on
        // pan/zoom still works via the range subscription alone.
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => repaintRef.current()) : null;
        if (ro && hostRef.current) ro.observe(hostRef.current);
        return () => {
            if (unsub) { try { unsub(handler); } catch { /* chart removed */ } }
            ro?.disconnect();
        };
    }, [drawings, modelDrawings, status, interval, updateLastTag]);

    // The in-progress DRAFT preview repaints on every pointermove — but it
    // must not re-run the subscription effect above (that was the churn:
    // draft → new repaint identity → listener teardown/re-add per move).
    // repaint's own closure only changes with draft/tool/color (toScreen is
    // stable), so this effect fires exactly on preview-relevant changes and
    // never overlaps the committed-shape triggers above.
    useEffect(() => {
        repaint();
    }, [repaint]);

    // ─── Pointer capture on the overlay (only while a tool is active) ───────
    const localPoint = (ev: React.PointerEvent): { x: number; y: number } => {
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const hitTestDrawing = (x: number, y: number): ChartDrawing | null => {
        // Model shapes paint above the user's, so test them first (top-down):
        // the eraser deletes whichever kind it actually lands on.
        const pool = [...drawingsRef.current, ...modelDrawingsRef.current];
        for (let i = pool.length - 1; i >= 0; i -= 1) {
            const d = pool[i];
            const pts = d.points.map(p => toScreen(p)).filter((s): s is { x: number; y: number } => s !== null);
            if (pts.length === 0) continue;
            if (d.kind === 'rect') {
                const [a, b] = pts;
                if (Math.min(a.x, b.x) - 4 <= x && x <= Math.max(a.x, b.x) + 4
                    && Math.min(a.y, b.y) - 4 <= y && y <= Math.max(a.y, b.y) + 4) return d;
                continue;
            }
            if (d.kind === 'hline' && Math.abs(y - pts[0].y) < 6) return d;
            if (d.kind === 'text' && Math.hypot(x - pts[0].x, y - pts[0].y) < 12) return d;
            for (let j = 1; j < pts.length; j += 1) {
                if (distToSegment(x, y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) < 6) return d;
            }
        }
        return null;
    };

    const onPointerDown = (ev: React.PointerEvent): void => {
        if (tool === 'cursor') return;
        ev.preventDefault();
        const pt = magnet ? magnetPoint(localPoint(ev)) : localPoint(ev);
        if (tool === 'erase') {
            const hit = hitTestDrawing(pt.x, pt.y);
            if (hit) {
                if (drawingsRef.current.some(d => d.id === hit.id)) {
                    publishDrawings(drawingsRef.current.filter(d => d.id !== hit.id));
                } else {
                    // A model-drawn shape → remove it from the parent's model
                    // store (which re-persists the coin's model bucket).
                    onRemoveModelShape?.(hit.id);
                }
            }
            return;
        }
        if (tool === 'hline') {
            const dp = toData(pt.x, pt.y);
            if (dp) publishDrawings([...drawingsRef.current, { id: createDrawingId(), kind: 'hline', points: [dp], color, createdAt: Date.now(), width: lineWidth }]);
            return;
        }
        if (tool === 'text') {
            // A text note is placed in one click, then typed in place — the
            // editor input mounts over the anchor; Enter commits, Esc deletes.
            const dp = toData(pt.x, pt.y);
            if (dp) {
                const id = createDrawingId();
                publishDrawings([...drawingsRef.current, { id, kind: 'text', points: [dp], color, createdAt: Date.now(), label: 'Note', width: lineWidth }]);
                setTextEdit({ id, x: pt.x, y: pt.y });
            }
            return;
        }
        setDraft({ points: [pt] });
        (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    };

    const onPointerMove = (ev: React.PointerEvent): void => {
        if (!draft || tool === 'cursor' || tool === 'erase') return;
        const pt = magnet ? magnetPoint(localPoint(ev)) : localPoint(ev);
        if (tool === 'brush') {
            const last = draft.points[draft.points.length - 1];
            if (Math.hypot(pt.x - last.x, pt.y - last.y) < 3) return;
            setDraft({ points: [...draft.points, pt] });
        } else {
            const a = draft.points[0];
            setDraft({ points: [a, pt] });
        }
    };

    const onPointerUp = (ev: React.PointerEvent): void => {
        if (!draft) return;
        const kind = tool as DrawKind;
        const pts = draft.points;
        setDraft(null);
        (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
        if (pts.length < 2) return;
        const dataPts = pts.map(p => toData(p.x, p.y)).filter((p): p is DrawPoint => p !== null);
        const finalPts = pointsForKind(kind, dataPts);
        if (!finalPts || finalPts.length < 2) return;
        publishDrawings([...drawingsRef.current, { id: createDrawingId(), kind, points: finalPts, color, createdAt: Date.now(), width: lineWidth }]);
    };

    const undoDrawing = (): void => publishDrawings(drawings.slice(0, -1));
    const clearDrawings = (): void => {
        publishDrawings([]);
        setTextEdit(null);
    };
    /** Live-rename the text note being edited (already published). */
    const renameTextDrawing = (id: string, label: string): void => {
        publishDrawings(drawingsRef.current.map(d => (d.id === id ? { ...d, label: label.slice(0, 80) } : d)));
    };
    /** Commit (blur/Enter) or cancel (Esc — removes the note) the editor. */
    const finishTextEdit = (cancel = false): void => {
        if (!textEdit) return;
        if (cancel) publishDrawings(drawingsRef.current.filter(d => d.id !== textEdit.id));
        setTextEdit(null);
    };

    // ─── Imperative handle (screenshot + snapshot) ──────────────────────────
    useEffect(() => {
        if (!chartHandle) return;
        chartHandle.current = {
            capturePng: (): string | null => {
                try {
                    const chart = chartRef.current;
                    if (!chart) return null;
                    const base = chart.takeScreenshot(false, false);
                    const out = document.createElement('canvas');
                    out.width = base.width;
                    out.height = base.height;
                    const ctx = out.getContext('2d');
                    if (!ctx) return null;
                    ctx.fillStyle = chartColor('--color-zinc-950', '#0d0c0b');
                    ctx.fillRect(0, 0, out.width, out.height);
                    ctx.drawImage(base, 0, 0);
                    // The drawing overlay is a CSS-pixel canvas over the chart
                    // host — scale it onto the screenshot's pixel grid.
                    if (overlayRef.current) {
                        ctx.drawImage(overlayRef.current, 0, 0, out.width, out.height);
                    }
                    return out.toDataURL('image/png');
                } catch {
                    return null;
                }
            },
            getSnapshot: (): ChartSnapshot | null => {
                const cs = candlesRef.current;
                if (!cs) return null;
                const data = (cs.data() ?? []) as readonly { time: number; open: number; high: number; low: number; close: number }[];
                const tail = data.slice(-30).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
                return {
                    symbol,
                    interval,
                    candles: tail,
                    markPrice: markPrice ?? lastPrice ?? null,
                    // What's ON SCREEN includes the verdict levels AND the
                    // lines the chat card is currently drawing — the model
                    // reads back exactly what the user is looking at.
                    levels: [
                        ...levels.map(l => ({ label: l.label, price: l.price })),
                        ...(chatLevels && chatLevels.symbol === symbol
                            ? chatLevels.lines.filter(l => l.state !== 'hidden').map(l => ({ label: l.label, price: l.price }))
                            : []),
                    ],
                    drawings: drawingsRef.current,
                    modelDrawings: modelDrawingsRef.current,
                    visibleRange: readVisibleRange(),
                    capturedAt: Date.now(),
                };
            },
            clearUserDrawings: (): void => publishDrawings([]),
        };
        return () => { chartHandle.current = null; };
    }, [chartHandle, symbol, interval, lastPrice, markPrice, levels, chatLevels, publishDrawings]);

    const toolActive = tool !== 'cursor';

    return (
        <div className="flex h-full min-h-0 flex-col bg-zinc-950" data-testid="trading-chart" data-symbol={symbol}>
            {/* The timeframe bar is shared with the Agents surface, so the customizable
                set and its persisted selection are one thing rather than two. The chart
                keeps its own extras as children. */}
            <TimeframeBar interval={interval} onIntervalChange={onIntervalChange}>
                {/* Prototype's "Add studies" button, one honest study: the
                    SMA-20 line over the closes. Amber = active, matching the
                    overlay's color so the button and the line agree.

                    CHROME: the study toggle is a flat control on the toolbar —
                    no box, no border — and its state is the amber fill the
                    line itself wears. The reference's toolbars are a row of
                    flat controls, and a bordered box on every one of them is
                    what made this row read as a stack of chips. */}
                {/* The studies menu. One toggle per study; every SERIES comes from
                    chartIndicators, so the label on the line is the number in the
                    prompt. Studies that need their own pane are marked — the
                    toggle persists the choice until the pane lands. */}
                <div className="relative ml-1.5">
                    <button type="button" onClick={() => setIndicatorMenuOpen(v => !v)} aria-pressed={indicatorsOn}
                        aria-expanded={indicatorMenuOpen} title="Chart studies"
                        className={`rounded-control px-2 py-1 text-ui-dense font-medium transition-colors ${
                            indicatorsOn
                                ? 'bg-amber-500/10 text-amber-300'
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
                                className="absolute left-0 top-full z-30 mt-1 w-44 rounded-control border border-hairline bg-zinc-900 py-1 shadow-elevated">
                                {CHART_INDICATOR_IDS.filter(id => CHART_INDICATOR_PANE[id]).map(id => {
                                    const on = indicatorSettings.visible[id];
                                    return (
                                        <button key={id} type="button" role="menuitemcheckbox" aria-checked={on}
                                            onClick={() => toggleIndicator(id)}
                                            className="flex w-full items-center gap-2 px-2 py-1 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.05]">
                                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-amber-400' : 'bg-zinc-700'}`} />
                                            <span className="flex-1">{CHART_INDICATOR_LABELS[id]}</span>
                                            {CHART_INDICATOR_PANE[id] === 'sub' && (
                                                <span className="text-ui-micro text-zinc-600">pane</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
                {/* Drawing tools live in the TradingView-style LEFT RAIL over
                    the plot (ChartToolRail) — the top bar keeps timeframes. */}
                    <span className="ml-auto flex items-center gap-2 pr-1">
                        <span className={`h-1.5 w-1.5 rounded-full ${status === 'live' ? 'bg-emerald-500' : status === 'loading' ? 'animate-pulse bg-cyan-400' : 'bg-rose-500'}`} aria-label={`chart ${status}`} />
                    </span>
                </TimeframeBar>
                {/* The 24h fields are the chart's CROSSHAIR readout (v3):
                    shown while the pointer is over the plot, gone at rest —
                    the metrics band is deleted, not restyled. */}

            <ChartFrame
                variant="plain"
                state={status === 'loading' ? 'loading' : status === 'unavailable' ? 'error' : 'ready'}
                message="Candles unavailable — Binance fetch failed; retrying in 4s."
                bodyClassName="min-h-0 flex-1 bg-zinc-950"
                testId="trading-chart-plot"
            >
                {/* The legend: timestamp, O/H/L/C, Change (value + %) and Range,
                    then VOL as contracts and USDT, then one row per visible
                    study. It follows the crosshair's bar and rests on the last
                    bar, so the numbers under the pointer ARE the numbers on the
                    lines — both come from `chartIndicators`. */}
                {legendBar && (
                    <div
                        data-testid="chart-legend"
                        className="pointer-events-none absolute left-2 top-1.5 z-10 max-w-[calc(100%-16px)] rounded-control bg-zinc-950/80 px-2 py-1 font-mono text-ui-dense text-zinc-500"
                    >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span>{phtAxisTick(legendBar.time, 'full')}</span>
                            {(['open', 'high', 'low', 'close'] as const).map(k => (
                                <span key={k}>{k[0].toUpperCase()} <span className="text-zinc-300">{fmtPriceForChart(legendBar[k])}</span></span>
                            ))}
                            <span>Change <span className={legendBar.close >= legendBar.open ? 'text-emerald-400' : 'text-rose-400'}>
                                {fmtPriceForChart(legendBar.close - legendBar.open)} ({(((legendBar.close - legendBar.open) / legendBar.open) * 100).toFixed(2)}%)
                            </span></span>
                            <span>Range <span className="text-zinc-300">{(((legendBar.high - legendBar.low) / legendBar.open) * 100).toFixed(2)}%</span></span>
                        </div>
                        {(() => {
                            const vol = legendRef.current?.volumes.get(legendBar.time);
                            if (vol === undefined) return null;
                            return (
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span>VOL(Contracts) <span className="text-amber-300">{vol >= 1000 ? `${(vol / 1000).toFixed(3)}K` : vol.toFixed(3)}</span></span>
                                    <span>VOL(USDT) <span className="text-amber-300">{fmtUsdForChart(vol * legendBar.close)}</span></span>
                                </div>
                            );
                        })()}
                        {legendSettingsRows(legendBar)}
                    </div>
                )}
                {/* The last-price tag on the axis: price, coloured by the last
                    candle's direction, with the countdown to that bar's close
                    beneath it — the two things the library's own tag cannot
                    carry. */}
                {lastTag && (
                    <div
                        data-testid="last-price-tag"
                        className="pointer-events-none absolute z-10 flex flex-col items-end"
                        style={{ top: lastTag.y - 16, right: 58 }}
                    >
                        <span className={`rounded-sm px-1 font-mono text-ui-dense ${lastTag.up ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                            {fmtPriceForChart(lastTag.price)}
                        </span>
                        <BarCountdown barTime={lastTag.barTime} interval={interval} />
                    </div>
                )}
                {/* The price under the crosshair, with its distance from the last
                    price — OKX's crosshair label. Main pane only. */}
                {crossPrice && (
                    <div
                        data-testid="crosshair-price-tag"
                        className="pointer-events-none absolute z-10 flex flex-col items-end"
                        style={{ top: crossPrice.y - 16, right: 58 }}
                    >
                        <span className="rounded-sm bg-zinc-700/80 px-1 font-mono text-ui-dense text-zinc-100">
                            {fmtPriceForChart(crossPrice.price)}
                        </span>
                        <span className={`font-mono text-ui-micro ${crossPrice.pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {`${crossPrice.pct >= 0 ? '+' : ''}${crossPrice.pct.toFixed(2)}%`}
                        </span>
                    </div>
                )}
                {ohlcvRow && overPlot && (
                    <div
                        data-testid="ohlcv-row"
                        className="pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-16px)] items-center gap-3 overflow-hidden rounded-control bg-zinc-950/80 px-2 py-0.5 text-ui-dense text-zinc-500"
                        style={{ top: legendBar ? '5.5rem' : '0.375rem' }}
                    >
                        <span className="font-mono tabular-nums">H <span className="text-zinc-300">{ohlcvRow.high24h ? fmtPriceForChart(ohlcvRow.high24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">L <span className="text-zinc-300">{ohlcvRow.low24h ? fmtPriceForChart(ohlcvRow.low24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">Vol <span className="text-zinc-300">{ohlcvRow.volume24h ? fmtUsdForChart(ohlcvRow.volume24h) : '—'}</span></span>
                        <span className="font-mono tabular-nums">OI <span className="text-zinc-300">{ohlcvRow.oiValue ? fmtUsdForChart(ohlcvRow.oiValue) : '—'}</span></span>
                        <span className="font-mono tabular-nums">Oracle <span className="text-zinc-300">{ohlcvRow.oracle ? fmtPriceForChart(ohlcvRow.oracle) : '—'}</span></span>
                    </div>
                )}
                {/* The verdict-overlay tag floats INSIDE the plot now — the
                    toolbar badge it replaced duplicated the symbol picker, the
                    active timeframe and the feed dot at once. */}
                {levels.length > 0 && (
                    /* CHROME: a status CHIP, not a data readout — so it takes
                       the reference's badge shape (a raised grey pill, no
                       border) and the reference's sentence case, instead of the
                       uppercase letter-spaced treatment the readout row keeps.
                       The level names inside it are the verdict's own words and
                       are unchanged. */
                    <span className="pointer-events-none absolute right-3 top-2 z-10 rounded-full bg-zinc-800/80 px-2 py-0.5 text-ui-2xs text-zinc-400" title="Current verdict levels drawn on the chart" data-testid="verdict-overlay-chip">
                        Verdict overlay · {levels.map(l => l.label).join(' ')}
                    </span>
                )}
                <ChartToolRail
                    tool={tool}
                    onSelectTool={t => { setTool(t); setDraft(null); setTextEdit(null); }}
                    color={color}
                    onColorChange={setColor}
                    canUndo={drawings.length > 0}
                    onUndo={undoDrawing}
                    onClear={clearDrawings}
                    hidden={drawingsHidden}
                    onToggleHidden={() => setDrawingsHidden(v => !v)}
                    magnet={magnet}
                    onToggleMagnet={() => setMagnet(v => !v)}
                    lineWidth={lineWidth}
                    onCycleWidth={() => setLineWidth(w => nextDrawWidth(w))}
                />
                <div ref={hostRef} className="absolute inset-y-0 right-0" style={{ left: CHART_RAIL_WIDTH }} />
                {/* Drawing overlay: captures the pointer ONLY while a tool is
                    active; otherwise the chart underneath gets every event.
                    z-10 clears lightweight-charts' internal z-1/z-2 canvases —
                    without it the overlay is hit-test BELOW the chart and no
                    tool ever receives a pointer. Inset left by the rail width
                    so shapes never paint under the rail. */}
                <canvas
                    ref={overlayRef}
                    data-testid="draw-overlay"
                    className={`absolute inset-y-0 right-0 z-10 h-full w-auto ${toolActive ? (tool === 'erase' ? 'cursor-pointer' : 'cursor-crosshair') : 'pointer-events-none'}`}
                    style={{ left: CHART_RAIL_WIDTH, touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
                {/* In-place editor for a just-placed text note. */}
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
                            left: Math.min(textEdit.x + CHART_RAIL_WIDTH + 6, (hostRef.current?.clientWidth ?? 400) - 170),
                            top: Math.max(4, textEdit.y - 24),
                        }}
                    />
                )}
            </ChartFrame>
        </div>
    );
};

export default React.memo(TradingChart);
