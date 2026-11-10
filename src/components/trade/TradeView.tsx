/**
 * TradeView — August's take on Minara's /app/trade/perps/BTC screen, dark,
 * in the prototype's two-row market header: identity + HERO price (with a
 * 48-bar spark + feed state), then a quiet metrics strip (Mark / Oracle /
 * 24h / Volume / OI / Funding with a depleting-window bar) — over a
 * full-height canvas chart with TradingView-style drawing tools, with the
 * order-book ladder and the live-context Chart AI docked to the
 * right. The dock is drag-resizable, collapsible to a rail and expandable
 * over the chart; its width persists. BELOW LG the three panes (book / chart
 * / AI dock) flatten into an explicit Chart | AI | Book mode switcher — one
 * full-height pane at a time, choice persisted per user. Push-first: one
 * websocket bundle per symbol drives strip + book + candles; REST polling
 * takes over the moment the socket drops (and the chart's own stall watchdog
 * re-syncs a quiet
 * stream), so prices on the chart are realtime or visibly healing.
 * A Chart AI levels card can also push its key levels onto the canvas
 * (chatLevels — transient, coin-stamped, blanked on instrument switch).
 * Presentation only — no order execution.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ProviderConfig } from '../../types/provider';
import { TradeAnalysis, LoggedTrade, Message, Kline } from '../../types';
import { fetchMarkIndex, fetchFuturesTicker24h, fetchDerivativesData } from '../../services/analysis/MarketDataService';
import { latestChartVerdict, verdictLevels } from '../../services/trade/chartData';
import { loadSessionModelDrawings, flushDrawings, type ChartDrawing } from '../../services/trade/chartDrawings';
import { drawingsControl, capDrawings } from '../../services/trade/drawingsControl';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import { getActiveUsername } from '../../utils/activeUser';
import { fmtPercent, fmtPrice } from '../../utils/formatters';
import * as levelWatch from '../../services/trade/levelWatchService';
import type { WatchPlan } from '../../services/trade/tradePlanLevels';
import * as watchService from '../../services/trade/watchService';
import { ensureNotifyPermission } from '../../services/infrastructure/notify';
import * as chatStore from '../../services/trade/chatStore';
import { useFuturesLiveFeed } from '../../hooks/useFuturesLiveFeed';
import { useSharedTicker } from '../../hooks/useSharedTicker';
import { useSymbolUniverse } from '../../hooks/useSymbolUniverse';
import TradingChart, { type ChartHandle } from './TradingChart';
import ErrorBoundary from '../shared/ErrorBoundary';
import { toKlineInterval, type ChartInterval } from '../../utils/chartIntervals';
import type { MessageLevelLines } from '../../services/trade/keyLevels';
import { fetchKlines } from '../../services/analysis/KlineService';
import { LevelAccuracyBadge } from './LevelAccuracyBadge';
import OrderBookPanel from './OrderBookPanel';
import TradeChatPanel, { ChartAiDockRail } from './TradeChatPanel';
import RightPanel from '../shell/RightPanel';
import { useRightPanel } from '../../hooks/useRightPanel';
import type { PanelTurnContext } from './TradeChatPanel';
import type { SoloTurnRow } from '../../services/trade/chatTurnMirror';
import type { ReasoningEffort } from '../../types/provider';
import SymbolPicker from './SymbolPicker';
import ScreenerPanel from './ScreenerPanel';
import type { AgentBot } from '../../services/agents/agentRoster';

interface TradeViewProps {
    /** The Settings memory toggle, forwarded to the dock's seat prompt. */
    memoryEnabled?: boolean;
    /** The Settings → Strategies master switch, forwarded to the dock seat. */
    strategiesEnabled?: boolean;
    providers: ProviderConfig[];
    selectedChatModel: string;
    onSelectChatModel: (modelId: string) => void;
    /** The currently projected verdict — its Entry/SL/TP lines are drawn on
     *  the chart when it belongs to the selected symbol. */
    verdict?: TradeAnalysis | null;
    /** Roster bots — a Chart AI session can be bound to one (persona). */
    bots?: AgentBot[];
    /** The user's logged trade history — passed to Chart AI's desk tools so
     *  recall / setup-history see what the user actually traded. */
    trades?: LoggedTrade[];
    /** A roster click elsewhere asked Chart AI to open this bot's session
     *  (nonce-keyed so repeats re-open even for the same bot). */
    botSessionRequest?: { botId: string; nonce: number };
    /** Same for group rooms (dock session kinds). */
    groupSessionRequest?: { groupId: string; nonce: number };
    /** Run the FULL ensemble analysis from the Chart AI composer. It resolves
     *  when the run ends — the pipeline writes its rows into the active
     *  conversation, which is the thread `TradeChatPanel` renders, so there is
     *  no verdict text to hand back and no message id to stamp. */
    onRunAnalysis?: (prompt: string, images: Array<{ name: string; dataURL: string }>) => Promise<void>;
    /** Report a run that never started (the pipeline writes an error bubble only
     *  once it IS running). Threaded straight to the dock's Full-analysis path. */
    onAnalysisError?: (message: string) => void;
    /** Stop the RUNNING analysis. The composer's Stop button used to abort only
     *  the chat-session controller, which the pipeline never reads — so a Full
     *  analysis kept streaming (and spending) after the button reported it had
     *  stopped. Wired to the pipeline's own cancel; absent ⇒ Stop keeps its old
     *  chat-only meaning. */
    onStopRun?: () => void;
    /** Create a group room — the Chat-rail action the dock was missing.
     *  Forwarded to `TradeChatPanel`; App owns the handler. */
    onNewGroup?: () => void;
    /** A bot's existing conversation, so a bot opened in the dock inherits it. */
    botThreadRows?: Message[];
    onBotTurnCommit?: (bot: AgentBot, prompt: string, answer?: string, workedMs?: number, effort?: ReasoningEffort) => void;
    /** A solo turn asked in the dock has to reach the conversation too, or the
     *  merged thread stays one-way on this surface exactly as it did on Chat.
     *  The row shape is the mirror's — it carries the LIVE state as well as the
     *  settled one, which is what lets the Agents surface show a turn that started
     *  over here as still arriving. */
    onSoloTurnCommit?: (row: SoloTurnRow, conversationId: string) => void;
    /** Adopt (or mint) the conversation a dock solo turn speaks into, and point
     *  the Agents surface at it. Absent ⇒ a session with no thread stays invisible
     *  to the other home, which is the split this closes. */
    onSyncConversation?: (conversationId?: string) => string | null;
    /** The App conversation the dock's bound session stands in for, so the chart
     *  and the Agents surface show ONE thread rather than two transcripts.
     *  Read through `entriesForSession`; absent ⇒ the dock is its own chat. */
    conversationRows?: Message[];
    /** Resolve the analysis message `onRunAnalysis` created, so the dock can
     *  show what its settled verdict was built on. Threaded straight through to
     *  `TradeChatPanel` — the chart surface owns no verdict rendering itself.
     *  Forwarded rather than copied: the dock keeps a message id, not a stored
     *  duplicate of the analysis. */
    getAnalysisMessage?: (messageId: string) => Message | undefined;
    /** "Log this trade" on a Chart AI proposal → record an OPEN trade. */
    onLogProposedTrade?: (proposal: TradeProposal) => void;
    /** Group rooms the Chart AI dock embeds as a session. The Coach inbox used
     *  to be handed through here for the dock's Chat | Coach switch; it is a
     *  tab on the Learning surface now. */
    renderGroupSurface?: (groupId: string) => React.ReactNode;
    /** Group rooms offered in the dock's New-session menu (name for tabs). */
    groups?: Array<{ id: string; name: string }>;
    /** Imperative scroll-to-entry bridge forwarded to the Chart AI dock:
     *  App's "Jump to latest analysis" + gallery Locate route their scroll
     *  through the function the dock registers (null on unmount). */
    registerScrollToMessage?: (fn: ((messageId: string) => void) | null) => void;
    /** Triggers a fresh discovery of models from configured providers. */
    onRefreshModels?: () => Promise<void>;
    /** The left sidebar (the order book), open/closed. Below lg the same
     *  toggle flips the surface mode instead, since there is no sidebar. */
    sidebarOpen?: boolean;
    /** Opens/closes that book. The activity bar used to own this on its active
     *  Trade icon; with the surfaces moved into the hamburger menu the control
     *  lives in this surface's own market row. */
    onToggleSidebar?: () => void;
    /** A request to flip this surface's mode (nonce-keyed so a repeat request
     *  applies). Consumed only <lg, where the book is a mode, not a column. */
    modeRequest?: { mode: TradeMode; n: number };
    /** Active profile — the persisted mobile mode is per-user, so a profile
     *  switch re-reads it instead of keeping the previous user's choice. */
    activeUsername?: string;
    /** Reports every mode change upward so App's toggle semantics (which
     *  mode is currently active) stay in sync with the user's own picks. */
    onTradeModeChange?: (mode: TradeMode) => void;
    /** Jump straight to the Agents surface from the dock header. */
    onOpenChat?: () => void;
    /** Opens the WatchListPanel (pinned signals) — its one chrome home since
        stage 3 moved it off the app header. The count badge mirrors the
        header's old one. */
    onOpenWatchList?: () => void;
    watchOpenCount?: number;
    watchOpenR?: string;
    /** Pin/unpin a verdict to the Pinned list (App owns the watched flag). */
    onToggleWatch?: (messageId: string) => void;
    pinnedMessageIds?: ReadonlySet<string>;
}

interface StripData {
    markPrice: number;
    indexPrice: number;
    lastFundingRate: number;
    nextFundingTime: number;
    changePercent24h: number;
    volume24h: number;
    oiValue: number;
    /** The v2 instrument tape's 24h extremes — same perp ticker the change
     *  and volume already came from (fetchFuturesTicker24h). */
    high24h: number;
    low24h: number;
}

// fmtPrice now comes from utils/formatters (audit 2026-09-16 dedupe — the
// hero/strip/ladder copy pair was byte-identical).

/** Chart AI dock geometry — persisted like a panel, clamped to sane widths.
 *  The dock lives at the RIGHT of the chart, so dragging the separator LEFT
 *  grows it: width = startWidth - (clientX - startX).
 *  2026-11: the dock is a chat surface, and at 364px it was narrower than a
 *  phone — an answer wrapped every seven words beside a chart nobody was
 *  looking at. Default is now 460 (364 × 1.25 = 455, so this is a real +26%,
 *  not the +21% a round 440 would have been) and the ceiling is 1000, which is
 *  what the persisted-width clamp accepts. A stored 1000 does not get to sit
 *  edge-to-edge on a 1024 laptop: the `calc(100% - 420px)` cap applies to the
 *  collapsed state as well as the expanded one, so the chart keeps its 420px
 *  floor at every window size.
 *  DOCK_MIN stays 300: below that the composer's own controls stop fitting. */
const DOCK_WIDTH_KEY = 'trade_dock_width_v1';
const DOCK_MIN = 300;
const DOCK_MAX = 1000;
const DOCK_DEFAULT = 460;
/** Registry id of the Chart AI dock inside the shared right-panel contract. */
const DOCK_ID = 'chart-ai';

/** Order-book drawer height when expanded (closed strip is 30px). */
const BOOK_DRAWER_HEIGHT = 320;

const fundingCountdown = (nextFundingTime: number, nowMs: number): string => {
    const left = nextFundingTime - nowMs;
    if (!Number.isFinite(left) || left <= 0) return '—';
    const h = Math.floor(left / 3_600_000);
    const m = Math.floor((left % 3_600_000) / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Funding settles on an 8 h cadence; the strip's progress bar shows how far
 *  INTO the current window we are (fills as the next funding approaches). When
 *  under 30 minutes remain the bar goes amber and pulses — the "it's basically
 *  now" cue from the prototype. Approximate prev (next − 8 h) since Binance
 *  only exposes the NEXT time; good enough for a depleting meter. */
const FUNDING_WINDOW_MS = 8 * 3_600_000;
const fundingProgress = (nextFundingTime: number, nowMs: number): { frac: number; soon: boolean } => {
    const left = nextFundingTime - nowMs;
    if (!Number.isFinite(left) || left <= 0) return { frac: 1, soon: false };
    const frac = Math.min(1, Math.max(0, 1 - left / FUNDING_WINDOW_MS));
    return { frac, soon: left <= 30 * 60_000 };
};

/**
 * The funding countdown + its depleting bar — a LEAF that owns the clock.
 *
 * The 1-second tick used to live in the TradeView body, so every second it
 * re-rendered the WHOLE trade surface — chart, order book, transcript — to
 * move one string. The tick now stops here: the leaf subscribes to the ONE
 * shared ticker (hooks/useSharedTicker.ts) and only the leaf re-renders.
 */
const FundingCountdown: React.FC<{ nextFundingTime: number; fundingRate: number }> = ({ nextFundingTime, fundingRate }) => {
    const nowMs = useSharedTicker();
    const { frac, soon } = fundingProgress(nextFundingTime, nowMs);
    return (
        <>
            {/* A gap, not justify-between: the row's width IS its content, so
                space-between had no free space to distribute and the funding
                rate and the countdown touched. The bar sits UNDER the text
                because the wrapper is a column (see chart-head-funding), not
                because of a margin. */}
            <span className="flex items-baseline gap-2">
                <span className={`font-mono text-ui-sm font-medium tabular-nums ${fundingRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtPercent(fundingRate * 100, 4)}
                </span>
                <span className="font-mono text-ui-dense tabular-nums text-zinc-400">{fundingCountdown(nextFundingTime, nowMs)}</span>
            </span>
            <span className="block h-[3px] w-full overflow-hidden rounded-full bg-zinc-800" aria-hidden="true" data-testid="funding-bar">
                {/* duration-300 is deliberate: the bar's width is a data value
                    (funding countdown), not chrome. ui-doctrine motion exception. */}
                <span className={`block h-full rounded-full transition-[width,background-color] duration-300 ease-[var(--ease-snappy)] ${soon ? 'animate-pulse bg-amber-400 shadow-[0_0_6px_rgba(240,136,0,0.5)]' : 'bg-cyan-400/80'}`} style={{ width: `${Math.round(frac * 100)}%` }} />
            </span>
        </>
    );
};

/** Live (<lg) viewport flag — below the lg breakpoint the desk switches to
 *  the mobile 3-mode layout (Chart | AI | Book); at lg+ the original three-
 *  column arrangement renders untouched. Guarded for jsdom (no matchMedia →
 *  assume wide). */
const useIsBelowLg = (): boolean => {
    const [below, setBelow] = useState<boolean>(() => {
        try { return !window.matchMedia('(min-width: 1024px)').matches; } catch { return false; }
    });
    useEffect(() => {
        let mql: MediaQueryList;
        try { mql = window.matchMedia('(min-width: 1024px)'); } catch { return; }
        const onChange = (): void => setBelow(!mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => { mql.removeEventListener('change', onChange); };
    }, []);
    return below;
};

/** Mobile trade surface mode (audit 2026-09-16, crosscheck §9.6 "Chart/AI/
 *  Book modes"): below lg the stacked chart + AI dock + book get flattened
 *  into ONE full-height pane chosen by a segmented control under the header.
 *  Last choice persists per user, same pattern as the timeframe bar. All
 *  three panes STAY MOUNTED in every mode (inactive ones are hidden, not
 *  unmounted) so the e2e/unit testid contract (trade-sidebar, trade-dock,
 *  trading-chart, trade-chat-panel presence) never changes with the mode. */
export type TradeMode = 'chart' | 'ai' | 'book';
const TRADE_MODES: readonly TradeMode[] = ['chart', 'ai', 'book'];
const TRADE_MODE_KEY = 'august_trade_mode_v1';
const tradeModeKey = (): string => `${TRADE_MODE_KEY}_${getActiveUsername()}`;
const readTradeMode = (): TradeMode => {
    try {
        const m = localStorage.getItem(tradeModeKey());
        return TRADE_MODES.includes(m as TradeMode) ? (m as TradeMode) : 'chart';
    } catch { return 'chart'; }
};
const writeTradeMode = (m: TradeMode): void => {
    try { localStorage.setItem(tradeModeKey(), m); } catch { /* private mode */ }
};

/** Smallest move (basis points from the last FLASHED print) that earns a
 *  flash, and the minimum gap between two. */
export const TICK_FLASH_MIN_BPS = 2;
export const TICK_FLASH_COOLDOWN_MS = 900;

/** Hero-price tick flash: a print that moved at least TICK_FLASH_MIN_BPS from
 *  the last one flashes emerald or rose. The mark streams at markPrice@1s, so
 *  without a threshold every sub-tick blip re-keyed the node — a strobe for the
 *  eye and a remount per second for the reconciler.
 *
 *  The baseline is the last price that FLASHED, not the last price seen, so a
 *  slow one-directional grind still registers instead of averaging itself into
 *  invisibility. `seq` bumps per flash so the caller can key the element —
 *  re-applying an already-running animation class does nothing. */
export const useTickFlash = (price: number | undefined): { cls: string; seq: number } => {
    const prevRef = useRef<number | undefined>(undefined);
    const lastAtRef = useRef(0);
    const [flash, setFlash] = useState<{ cls: string; seq: number }>({ cls: '', seq: 0 });
    useEffect(() => {
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return;
        const prev = prevRef.current;
        if (prev === undefined) {
            prevRef.current = price;
            return;
        }
        const deltaBps = (Math.abs(price - prev) / prev) * 10_000;
        const now = Date.now();
        if (deltaBps < TICK_FLASH_MIN_BPS || now - lastAtRef.current < TICK_FLASH_COOLDOWN_MS) return;
        prevRef.current = price;
        lastAtRef.current = now;
        setFlash(f => ({ cls: price > prev ? 'tick-up' : 'tick-down', seq: f.seq + 1 }));
    }, [price]);
    return flash;
};


const TradeView: React.FC<TradeViewProps> = ({
    memoryEnabled, strategiesEnabled, providers, selectedChatModel, onSelectChatModel, onRefreshModels, verdict, bots = [], trades = [], botSessionRequest, groupSessionRequest, onRunAnalysis, onAnalysisError, onStopRun, botThreadRows, onBotTurnCommit, onSoloTurnCommit, onSyncConversation, conversationRows, onNewGroup, getAnalysisMessage, onLogProposedTrade, renderGroupSurface, groups = [], registerScrollToMessage, modeRequest, activeUsername, onTradeModeChange, onOpenChat, onToggleWatch, onOpenWatchList, watchOpenCount = 0, pinnedMessageIds }) => {
    // The chart opens on the coin the SHARED chat session carries. Adopting only
    // from an effect is not enough: the dock mounts in the same commit, a child's
    // effect runs before its parent's, and the dock can re-bind the active session
    // first — leaving this surface to paint the wrong coin, then read a session
    // whose coin was never set. Seeding from the session makes the first frame
    // honest instead of one lurch behind the picker.
    const [symbol, setSymbol] = useState(() => chatStore.getActiveSession()?.symbol ?? 'BTCUSDT');
    const [interval, setInterval_] = useState<ChartInterval>(
        () => (chatStore.getActiveSession()?.interval as ChartInterval) ?? '15m',
    );
    // Shared with the Agents surface, which needs the same picker over the same
    // list — two 60s polls for one exchange answer would be waste.
    const symbols = useSymbolUniverse();
    const [strip, setStrip] = useState<StripData | null>(null);
    const [chartDrawings, setChartDrawings] = useState<ChartDrawing[]>([]);
    /** Shapes the MODEL drew via desk tools — rendered on the chart, never
     *  persisted into the user's drawing file, cleared on symbol change. */
    const [modelDrawings, setModelDrawings] = useState<ChartDrawing[]>([]);
    /** Candles for scoring the model's own drawn levels. The chart fetches the
     *  same series and KlineService caches for 30s, so this is a cache read,
     *  not a second network call. 200 bars so a level drawn earlier has
     *  enough history to have been judged. */
    const [levelCandles, setLevelCandles] = useState<Kline[]>([]);
    /** The `<sid>:<symbol>` bucket modelDrawings CURRENTLY holds. A turn may
     *  only merge into React state when its bucket matches this stamp — a
     *  stream-chunk tool call landing between a session-switch store emit
     *  and the re-render would otherwise merge the new session's drawings
     *  into the OLD bucket's state and persist that composite under the new
     *  key (audit R6 #12). Off-stamp turns go through load-merge-save. */
    const loadedBucketRef = useRef('');
    // The session+symbol the VISIBLE model drawings were loaded from. The
    // persist effect checks it before writing, so a coin switch can never save
    // the previous coin's shapes under the new coin's key.
    const drawingsClaimedRef = useRef('');
    const chartHandleRef = useRef<ChartHandle | null>(null);
    /* The Chart AI dock runs on the shared right-panel contract, not its own
     * geometry: presentation, per-surface persisted width, hide-vs-close, and
     * the tab strip all come from `useRightPanel` so that the next panel on
     * this surface is a registration rather than a second implementation.
     *
     * `DOCK_WIDTH_KEY` is handed over as the legacy key so an existing dragged
     * width is adopted on first read rather than reset by the upgrade. */
    const rightPanel = useRightPanel({
        surface: 'trade',
        defaultWidth: DOCK_DEFAULT,
        minWidth: DOCK_MIN,
        maxWidth: DOCK_MAX,
        legacyWidthKey: DOCK_WIDTH_KEY,
    });
    const { width: dockWidth } = rightPanel;
    const [dockCollapsed, setDockCollapsed] = useState(false);
    const [dockExpanded, setDockExpanded] = useState(false);
    const [screenerOpen, setScreenerOpen] = useState(false);
    // Mobile 3-mode surface (<lg): the stacked panes collapse into one, and
    // the old `hidden md:block` sidebar + the below-md book overlay drawer the
    // md toggle used to summon are replaced by an explicit Chart | AI | Book
    // segmented control (the NavRail book toggle stays a lg+ control).
    const isBelowLg = useIsBelowLg();

    // The dock is the surface's first registered right panel. It is always
    // "open" in the registry sense when the rail is showing, because CLOSE and
    // COLLAPSE are different things here: closing removes the dock from the
    // strip, collapsing hides it while keeping it mounted.
    useEffect(() => {
        rightPanel.register({ id: DOCK_ID, label: 'Chart AI' });
        // `register` is stable; the whole hook object changes identity on every
        // width commit, and re-announcing per drag tick is pure noise.
    }, [rightPanel.register]);
    const [mode, setMode] = useState<TradeMode>(readTradeMode);
    const pickMode = useCallback((m: TradeMode): void => {
        setMode(m);
        writeTradeMode(m);
        onTradeModeChange?.(m);
    }, [onTradeModeChange]);
    // Segmented-control thumb: the pill is ONE surface that slides between
    // tabs, so the active read is motion rather than three backgrounds
    // swapping color. Measured from real geometry (labels differ in width) and
    // re-measured on resize; width stays 0 until measured, which simply hides
    // the thumb — the active label's color already carries the state.
    const switcherRef = useRef<HTMLDivElement>(null);
    const modeTabRefs = useRef<Partial<Record<TradeMode, HTMLButtonElement | null>>>({});
    const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
    useLayoutEffect(() => {
        if (!isBelowLg) return;
        const measure = (): void => {
            const tab = modeTabRefs.current[mode];
            const box = switcherRef.current;
            if (!tab || !box) return;
            const a = tab.getBoundingClientRect();
            const b = box.getBoundingClientRect();
            // `left` on an absolutely-positioned child measures from the
            // PADDING box, but getBoundingClientRect reports the BORDER box —
            // without subtracting clientLeft the thumb sits 1px right.
            setThumb({ left: a.left - b.left - box.clientLeft, width: a.width });
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [mode, isBelowLg]);
    // `role="tablist"` is a promise: the switcher is ONE stop in the tab
    // sequence and the arrows move the selection inside it. It advertised the
    // pattern and handled no key at all, so a keyboard user could only walk the
    // three tabs with Tab — and never reach Book from Chart. Selecting on arrow
    // (not just focusing) is deliberate: these three panes are alternatives, and
    // landing on one is the same act as clicking it.
    const stepMode = (delta: number): void => {
        const at = TRADE_MODES.indexOf(mode);
        const next = TRADE_MODES[(at + delta + TRADE_MODES.length) % TRADE_MODES.length];
        pickMode(next);
        modeTabRefs.current[next]?.focus();
    };
    const jumpMode = (edge: 'first' | 'last'): void => {
        const next = edge === 'first' ? TRADE_MODES[0] : TRADE_MODES[TRADE_MODES.length - 1];
        pickMode(next);
        modeTabRefs.current[next]?.focus();
    };
    // App's activity-bar toggle below lg: apply each new nonce exactly once.
    const lastModeReqNRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (!modeRequest) { lastModeReqNRef.current = undefined; return; }
        if (lastModeReqNRef.current === modeRequest.n) return;
        lastModeReqNRef.current = modeRequest.n;
        pickMode(modeRequest.mode);
    }, [modeRequest, pickMode]);
    // Profile switch: the persisted mode is per-user — re-read it so B gets
    // B's layout instead of inheriting A's until a reload (audit R6 #23).
    const prevModeUserRef = useRef<string | undefined>(activeUsername);
    useEffect(() => {
        if (prevModeUserRef.current === activeUsername) return;
        prevModeUserRef.current = activeUsername;
        setMode(readTradeMode());
    }, [activeUsername]);
    /** Key-level lines a Chat AI message card is currently SHOWING on the
     *  chart (toggle / pin / hover resolved by the dock). Transient view state
     *  — never persisted, stamped with its symbol so a coin switch blanks it. */
    const [chatLevels, setChatLevels] = useState<MessageLevelLines | null>(null);
    const handleChatLevels = useCallback((lines: MessageLevelLines | null): void => {
        setChatLevels(prev => {
            if (!lines || !prev) return lines;
            // Keep the old object only when the push is content-identical (a
            // hover tick) — a different symbol or different lines always land.
            if (lines.symbol === prev.symbol && JSON.stringify(lines.lines) === JSON.stringify(prev.lines)) return prev;
            return lines;
        });
    }, []);

    // Push-first feed: markPrice@1s + depth20@100ms + ticker + kline over two
    // websockets. `live` gates every REST poll below — polling is the
    // fallback, never the primary path while the socket is up.
    const feed = useFuturesLiveFeed(symbol, interval);
    const live = feed.status === 'live';

    // ── Session-scoped chart memory ─────────────────────────────────────────
    // Each Chart AI session remembers the instrument + interval it was set up
    // on: switching sessions (from the dock's history palette) — or remounting
    // this surface — restores that chart. Capture flows the other way: every
    // user-driven symbol/interval change is stamped onto the ACTIVE session.
    const chatSnap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const symbolRef = useRef(symbol);
    symbolRef.current = symbol;
    const intervalRef = useRef(interval);
    intervalRef.current = interval;
    // Follow the active session's instrument, and follow it LIVE — not only
    // when the session id changes. A coin picked in the Agents surface has to
    // move this chart while it is mounted behind it, or the picker is a lie
    // the moment you return.
    //
    // `sharedSession` is resolved by chatStore's own rule (active row, else the
    // first) rather than by raw id: the Agents surface writes and reads through
    // that same accessor, so the row the picker painted is the row adopted here.
    const sharedSession = chatSnap.sessions.find(x => x.id === chatSnap.activeId) ?? chatSnap.sessions[0];
    useEffect(() => {
        if (!sharedSession) return;
        if (sharedSession.symbol && sharedSession.symbol !== symbolRef.current) setSymbol(sharedSession.symbol);
        if (sharedSession.interval && sharedSession.interval !== intervalRef.current) setInterval_(sharedSession.interval as ChartInterval);
    }, [sharedSession?.symbol, sharedSession?.interval]);
    const changeSymbol = useCallback((next: string): void => {
        setSymbol(next);
        // The ONE store writer for the instrument: the desk's
        // `switch_chart_symbol` tool lands on it too, so a model-driven
        // switch and a picker click cannot update different rows.
        chatStore.setActiveSymbol(next);
    }, []);
    const changeInterval = useCallback((next: ChartInterval): void => {
        setInterval_(next);
        const sid = chatStore.getActiveSession()?.id;
        if (sid) chatStore.mutate(sid, sess => ({ ...sess, interval: next }));
    }, []);


    // SYMBOL SWITCH: the strip must never print the previous coin's numbers.
    // Null it immediately, then one-shot fetch the NEW coin even while the
    // websocket is live — the socket re-subscribes within ~1s, but without
    // this the strip would show stale BTC prices on a ZEN chart (the data
    // discrepancy the model flagged) for as long as the socket stays up.
    useEffect(() => {
        setStrip(null);
        // Same doctrine for a chart card's level lines: the new coin starts
        // with the new coin's canvas — no leftover BTC tags floating on ZEN.
        setChatLevels(null);
        let cancelled = false;
        const load = async (): Promise<void> => {
            try {
                // Futures-native ticker: the strip's 24h change/volume used
                // to come from the SPOT ticker (fetchMarketData) while the
                // mark, oracle, funding and OI beside them are all perp-side
                // — the cross-market-mixing class. fetchFuturesTicker24h is
                // the perp counterpart; the live socket's <s>@ticker stream
                // already overrides this one-shot while connected.
                const [mi, market, deriv] = await Promise.all([
                    fetchMarkIndex(symbol),
                    fetchFuturesTicker24h(symbol),
                    fetchDerivativesData(symbol),
                ]);
                if (!cancelled) {
                    setStrip({
                        markPrice: mi.markPrice,
                        indexPrice: mi.indexPrice,
                        lastFundingRate: mi.lastFundingRate,
                        nextFundingTime: mi.nextFundingTime,
                        changePercent24h: market.priceChangePercent24h ?? 0,
                        volume24h: market.volume24h ?? 0,
                        oiValue: deriv.openInterestValue ?? 0,
                        high24h: market.price24hHigh ?? 0,
                        low24h: market.price24hLow ?? 0,
                    });
                }
            } catch { /* the socket or the poll will fill it */ }
        };
        void load();
        return () => { cancelled = true; };
    }, [symbol]);

    // Fallback strip (only while the socket is down): 15s refresh.
    useEffect(() => {
        if (live) return;
        let cancelled = false;
        const load = async (): Promise<void> => {
            try {
                const [mi, market, deriv] = await Promise.all([
                    fetchMarkIndex(symbol),
                    fetchFuturesTicker24h(symbol),
                    fetchDerivativesData(symbol),
                ]);
                if (!cancelled) {
                    setStrip({
                        markPrice: mi.markPrice,
                        indexPrice: mi.indexPrice,
                        lastFundingRate: mi.lastFundingRate,
                        nextFundingTime: mi.nextFundingTime,
                        changePercent24h: market.priceChangePercent24h ?? 0,
                        volume24h: market.volume24h ?? 0,
                        oiValue: deriv.openInterestValue ?? 0,
                        high24h: market.price24hHigh ?? 0,
                        low24h: market.price24hLow ?? 0,
                    });
                }
            } catch { /* keep the last strip on a failed poll */ }
        };
        void load();
        const poll = window.setInterval(() => void load(), 15_000);
        return () => { cancelled = true; window.clearInterval(poll); };
    }, [symbol, live]);

    // OI has no public stream — seed/refresh it on the slow poll even when
    // the rest of the strip is live. OI has no push stream, so it needs its
    // OWN slow poll (the comment always claimed this; the interval did not
    // exist — it only fetched once per [symbol, live] change, leaving OI
    // hours-stale while live).
    useEffect(() => {
        let cancelled = false;
        const load = async (): Promise<void> => {
            try {
                const d = await fetchDerivativesData(symbol);
                if (!cancelled) setStrip(prev => (prev ? { ...prev, oiValue: d.openInterestValue ?? prev.oiValue } : prev));
            } catch { /* keep last */ }
        };
        void load();
        const poll = window.setInterval(() => void load(), 15_000);
        return () => { cancelled = true; window.clearInterval(poll); };
    }, [symbol, live]);

    // A model drawing belongs to the symbol it was drawn on — switching
    // instruments wipes the canvas and drops the PREVIOUS symbol's level
    // watches (a remount of the same symbol keeps its plans alive — the
    // watch lives in the module singleton, and fired latches persist).
    const prevSymbolRef = useRef(symbol);
    useEffect(() => {
        if (prevSymbolRef.current !== symbol) levelWatch.disarmSymbol(prevSymbolRef.current);
        prevSymbolRef.current = symbol;
        // Anything the previous bucket still owes the store goes out NOW,
        // before the switch — a debounced write that outlives its session
        // would land the old coin's shapes under the new session's key.
        void flushDrawings();
        // Reload THIS coin's model-drawn shapes (persisted per session+coin),
        // so the model's lines survive a coin switch — instead of the old
        // blanket wipe that made "what the AI drew" vanish on the next coin.
        // The load is async (a file read on desktop); the cancelled guard is
        // what makes a rapid session/coin switch settle on the LAST switch.
        loadedBucketRef.current = `${chatSnap.activeId}:${symbol}`;
        let cancelled = false;
        const load = async (): Promise<void> => {
            const list = await loadSessionModelDrawings(chatSnap.activeId, symbol);
            if (!cancelled) {
                setModelDrawings(list);
                // The persist effect below keys on modelDrawings alone, so it could
                // re-save the PREVIOUS coin's array under the NEW coin's key whenever
                // the new list was reference-equal (both empty is the common case) and
                // some unrelated state change re-ran the effect first. Claim the bucket
                // in the same commit that loads it, so a save can only ever target the
                // bucket the visible list came from.
                drawingsClaimedRef.current = `${chatSnap.activeId}:${symbol}`;
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [symbol, chatSnap.activeId]);

    // Level-accuracy scoring needs THIS coin's bars at THIS timeframe. The
    // fetch used to ride the symbol-switch effect above with two holes: no
    // `interval` dep (a timeframe change never re-fetched) and no cancel (a
    // slow BTC response could land after the switch and overwrite the new
    // coin's candles, whose 30s cache usually resolves first). Either way the
    // badge printed a hit rate measured against a different market's bars.
    useEffect(() => {
        let cancelled = false;
        void fetchKlines(symbol, toKlineInterval(interval), 200)
            .then(candles => { if (!cancelled) setLevelCandles(candles); })
            .catch(() => { if (!cancelled) setLevelCandles([]); });
        return () => { cancelled = true; };
    }, [symbol, interval]);

    // Persist the model's shapes under the CURRENT coin+session whenever they
    // change (adds, erases, clear). Keyed on modelDrawings ONLY — not symbol —
    // so a coin switch (which loads a different list) never writes the
    // previous coin's shapes under the new coin's key.
    useEffect(() => {
        const sid = chatStore.getActiveId();
        // Only write the bucket the visible list was actually loaded from. A
        // coin switch that produces a reference-equal list (both empty) skips
        // the setState re-render, so a save triggered by any other state change
        // in that window would otherwise persist the OLD coin's shapes under
        // the NEW coin's key.
        if (sid && drawingsClaimedRef.current === `${sid}:${symbolRef.current}`) {
            drawingsControl('model', sid, symbolRef.current).replace(modelDrawings);
        }
    }, [modelDrawings]);

    // Live values override polled ones while the socket is up.
    const markPrice = feed.markIndex?.markPrice ?? strip?.markPrice;
    const indexPrice = feed.markIndex?.indexPrice ?? strip?.indexPrice;
    const fundingRate = feed.markIndex?.fundingRate ?? strip?.lastFundingRate;
    const nextFundingTime = feed.markIndex?.nextFundingTime ?? strip?.nextFundingTime;
    const changePct = feed.ticker?.changePercent24h ?? strip?.changePercent24h;
    const lastPrice = feed.ticker?.lastPrice ?? markPrice;
    // The strip's one fact (mock v3): spread and book imbalance over the
    // resting ladder. Imbalance is size-weighted, the same number the desk's
    // depth tool reports — a wall of asks and a wall of bids are not equal
    // evidence just because they have the same number of rows.
    const bookMetrics = useMemo(() => {
        const bids = feed.depth?.bids ?? [];
        const asks = feed.depth?.asks ?? [];
        if (!bids.length || !asks.length) return '';
        const spread = Math.max(0, (asks[0]?.price ?? 0) - (bids[0]?.price ?? 0));
        const bidVol = bids.reduce((n, l) => n + (l.qty || 0), 0);
        const askVol = asks.reduce((n, l) => n + (l.qty || 0), 0);
        const total = bidVol + askVol;
        const imbalance = total > 0 ? Math.round(((bidVol - askVol) / total) * 100) : 0;
        return `spread ${spread.toFixed(2)} · imbalance ${imbalance >= 0 ? '+' : ''}${imbalance}%`;
    }, [feed.depth]);

    // Order-book drawer: 30px strip closed by default, expands on demand.
    const [bookOpen, setBookOpen] = useState(false);
    // Chart-head OHLC/V/OI row data — the fields the removed metrics band
    // carried, forwarded to TradingChart's crosshair readout row.
    const ohlcvRow = useMemo(() => ({
        high24h: strip && strip.high24h > 0 ? strip.high24h : null,
        low24h: strip && strip.low24h > 0 ? strip.low24h : null,
        volume24h: strip?.volume24h ?? null,
        oiValue: strip?.oiValue ?? null,
        oracle: indexPrice ?? null,
        changePct: changePct ?? null,
    }), [strip, indexPrice, changePct]);
    // What's drawn on the chart right now — forwarded to the chat so its
    // get_chart_view tool can tell the model what the user is looking at.
    // The walk is scoped to the coin on screen: a newer plan for another coin
    // used to shadow this one, so returning to it drew no overlay at all.
    const chartVerdict = useMemo(
        () => (conversationRows ? latestChartVerdict(conversationRows, symbol) : verdict ?? null),
        [conversationRows, symbol, verdict],
    );
    const chartLevels = useMemo(() => verdictLevels(chartVerdict, symbol), [chartVerdict, symbol]);

    // ── Harness level-watch (advisory only — OutcomeAutopilot resolves) ────
    // Arm a plan the Chart AI model presents, feeding it the live mark so the
    // stale-plan guard can suppress a tick-0 ping for an already-dead plan.
    // The mark rides a ref so the handler identity stays stable (the dock is
    // memoized; the mark re-renders every second).
    const markPriceRef = useRef<number | undefined>(markPrice);
    markPriceRef.current = markPrice;
    const handlePlanPresented = useCallback((plan: WatchPlan, turn?: PanelTurnContext): void => {
        // A level watch is exactly "alert me when price gets there" — request
        // the OS notification permission NOW so the grant exists when the
        // level hits later (same treatment as the watch_price/wake_me tools).
        void ensureNotifyPermission();
        // The viewed mark is only authoritative for the viewed coin; a
        // background turn's plan gets a null anchor (plain first-tick touch
        // test) rather than another coin's price.
        const at = plan.symbol === symbolRef.current ? markPriceRef.current : undefined;
        levelWatch.arm({ ...plan, ...(turn?.sid ? { sid: turn.sid } : {}) }, typeof at === 'number' && Number.isFinite(at) ? at : null);
    }, []);
    // Tick the level-watch AND the model's price watches on every live mark
    // print (~1s while the socket is up; the polled strip value drives it
    // otherwise). Time wake-ups fire off the watch service's own clock.
    useEffect(() => {
        if (Number.isFinite(markPrice)) {
            levelWatch.tick(symbol, markPrice!);
            watchService.tick(symbol, markPrice!);
        }
    }, [symbol, markPrice]);
    // Level hits and model watches no longer subscribe HERE: a subscription
    // on a mountable surface dropped every hit that happened while the
    // trader was on another surface — and for a level hit that was WORSE
    // than a dropped ping, because the fire-once latch had already spent
    // the state. The harness record is queued by the services themselves;
    // App.tsx (never unmounted) carries the OS ping.

    // The design's change pill: tinted ground, tone text — the price figure
    // itself stays plain ink (the tone lives in the pill, not the print).
    const changeTone = useMemo(() => {
        const v = changePct ?? 0;
        return v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-rose-500/10 text-rose-400' : 'bg-zinc-500/10 text-zinc-300';
    }, [changePct]);
    /** The hero figure's own colour, on the same sign as the 24h change — the
     *  exchange convention (OKX, Binance) where the price itself reads green or
     *  red rather than sitting in ink while a pill beside it carries the direction.
     *  Text colour only: the tick flash animates the BACKGROUND, so the two never
     *  fight, and a flat session keeps plain ink instead of inventing a green.
     *  emerald-400 is 9.78:1 on the page and rose-400 8.00:1, so this is the one
     *  place the semantic hues are allowed on chrome-scale text without a contrast
     *  question. */
    const priceTone = useMemo(() => {
        const v = changePct ?? 0;
        return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-100';
    }, [changePct]);
    const tickFlash = useTickFlash(markPrice);

    // ── Dock drag-resize ────────────────────────────────────────────
    // The drag itself belongs to the shared contract now (hooks/useRightPanel):
    // it clamps, persists per surface, and drops the width transition for the
    // duration of the gesture. All this surface keeps is the one thing the hook
    // cannot know — while the dock is EXPANDED its width comes from the flex
    // layout, so a drag first un-expands it and starts from the live pixel
    // width, which keeps the separator from feeling dead on first grab.
    const startDrag = useCallback((ev: React.PointerEvent): void => {
        if (dockExpanded) setDockExpanded(false);
        // The handle lives inside the shell's <aside>, so the element being
        // sized is the handle's PARENT, not its sibling. Measuring anything
        // narrower would seed the drag low and shave the dock on every grab.
        const dockEl = (ev.currentTarget as HTMLElement).parentElement;
        const live = dockEl?.getBoundingClientRect().width;
        if (live && Number.isFinite(live) && live >= DOCK_MIN && live <= DOCK_MAX) {
            rightPanel.setWidth(live);
        }
        rightPanel.startResize(ev);
    }, [dockExpanded, rightPanel]);

    const captureChart = useCallback((): string | null => chartHandleRef.current?.capturePng() ?? null, []);
    const getChartSnapshot = useCallback(() => chartHandleRef.current?.getSnapshot() ?? null, []);
    /** Desk-tool drawing surface: the panel hands these to the model's
     *  draw_on_chart / mark_trade_levels / clear_chart_drawings calls.
     *  A turn's drawings belong to the session+coin that turn RAN on, not
     *  whatever the user happens to be watching now (deep-dive chat/desk
     *  identity leak): when the turn is off-view, write straight into that
     *  session's bucket and leave the visible canvas untouched. */
    const isViewTurn = (turn?: PanelTurnContext): boolean =>
        !turn || (turn.sid === chatStore.getActiveId() && turn.symbol === symbolRef.current
            && loadedBucketRef.current === `${turn.sid}:${turn.symbol}`);
    const addModelDrawings = useCallback((drawings: ChartDrawing[], turn?: PanelTurnContext): void => {
        if (isViewTurn(turn)) {
            // The SAME cap the store applies, via capDrawings — it used to be
            // a hardcoded 60 against the store's 40, so the view accepted
            // twenty more shapes than storage could keep and the user watched
            // them vanish on reload. One number, applied in both places.
            setModelDrawings(prev => capDrawings([...prev, ...drawings]));
            return;
        }
        const t = turn as PanelTurnContext;
        drawingsControl('model', t.sid, t.symbol).add(drawings);
    }, []);
    const clearModelDrawings = useCallback((turn?: PanelTurnContext): void => {
        if (isViewTurn(turn)) {
            setModelDrawings([]);
            return;
        }
        const t = turn as PanelTurnContext;
        drawingsControl('model', t.sid, t.symbol).clear();
    }, []);
    // Erasing one of the model's shapes (the chart's eraser routes it here);
    // the persist effect re-saves the coin's model bucket minus this shape.
    const removeModelShape = useCallback((id: string): void => {
        setModelDrawings(prev => prev.filter(d => d.id !== id));
    }, []);
    const clearAllDrawings = useCallback((turn?: PanelTurnContext): void => {
        if (isViewTurn(turn)) {
            setModelDrawings([]);
            chartHandleRef.current?.clearUserDrawings();
            return;
        }
        // Off-view 'all': only the model bucket is ours to clear — the user's
        // own strokes belong to the canvas the user is looking at.
        const t = turn as PanelTurnContext;
        drawingsControl('model', t.sid, t.symbol).clear();
    }, []);

    // TradeChatPanel is React.memo'd, and the spread below compares props
    // individually — so an inline arrow here re-renders a 1,100-line panel on
    // every market tick regardless of everything else being stable. The dock
    // toggles read nothing but the setters, so they can be permanently stable.
    const collapseDock = useCallback(() => {
        setDockCollapsed(true);
        setDockExpanded(false);
    }, []);
    const expandDock = useCallback(() => setDockCollapsed(false), []);
    const toggleDockExpanded = useCallback(() => setDockExpanded(v => !v), []);

    const dockProps = {
        symbol,
        interval,
        providers,
        selectedChatModel,
        onSelectChatModel,
        live,
        chartLevels,
        chartDrawings,
        modelDrawings,
        onCaptureChart: captureChart,
        getChartSnapshot,
        addModelDrawings,
        clearModelDrawings,
        clearAllDrawings,
        bots,
        trades,
        botSessionRequest,
        groupSessionRequest,
        onRunAnalysis,
        onAnalysisError,
        onStopRun,
        getAnalysisMessage,
        onLogProposedTrade,
        onPlanPresented: handlePlanPresented,
        onChatLevelsChange: handleChatLevels,
        renderGroupSurface,
        groups,
        onToggleWatch,
        pinnedMessageIds,
        onRefreshModels,
        registerScrollToMessage,
    };

    return (
        <div className="flex h-full min-h-0 flex-col bg-zinc-950" data-testid="trade-view">
            {/* INSTRUMENT ROW · the v2 design's single hairline strip: the
                instrument and its live price at the left, the tape of perp
                readings filling the middle, the desk tools at the right.

                The prototype's two rows (hero + metrics strip) merge into one
                row — the reference's 64px instrument bar: hairline-divided
                tape cells, no fills, a control's state is its colour. Every
                reading is the REAL one the two rows carried: mark price, 24h
                change, volume, OI, funding with its countdown and depleting
                window; the tape's 24h high/low come from the same perp ticker
                the change already used (fetchFuturesTicker24h), and the
                oracle reading rides along as the sixth cell rather than being
                dropped. The sparkline left with the merge: the live chart
                sits directly below, and a second small chart of the same data
                was the duplication the reference removes. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-zinc-950 px-3 py-2 sm:px-4">
                <div className="flex min-w-0 items-center gap-1.5">
                    <SymbolPicker symbols={symbols} value={symbol} onChange={changeSymbol}
                        onOpenScreener={() => setScreenerOpen(true)}
                        onOpenWatchList={onOpenWatchList}
                        watchOpenCount={watchOpenCount} />
                    {/* The design's price-block: the figure carries the session's
                        own colour (green up / red down, the exchange convention),
                        the 24h change rides beside it in a tinted pill, and the
                        tick flash still pulses the background — a print you can
                        see land, on a figure you can read at a glance. */}
                    <div className="ml-1 flex shrink-0 items-baseline gap-2">
                        <div
                            key={tickFlash.seq}
                            data-testid="hero-price"
                            className={`-mx-1 rounded-control px-1 font-mono text-ui-price font-medium tracking-[-0.035em] tabular-nums ${priceTone} ${tickFlash.cls}`.trim()}
                        >
                            {Number.isFinite(markPrice) ? fmtPrice(markPrice!) : '—'}
                        </div>
                        {Number.isFinite(changePct) && (
                            <span
                                title="24h change · MARK"
                                className={`shrink-0 rounded-[5px] px-1.5 py-1 font-mono text-ui-dense font-medium leading-none tabular-nums ${changeTone}`}
                            >
                                {changePct! >= 0 ? '+' : ''}{fmtPercent(changePct!, 2)}
                            </span>
                        )}
                        {/* The sparkline is GONE (v4): the live chart sits
                            directly below this row, and a second small chart of
                            the same closes was the duplication the reference
                            removes. `levelCandles` stays — it feeds level
                            accuracy, not this head. Funding rides the chart
                            head too: the quiet line, not a band. */}
                        <span className="hidden shrink-0 flex-col gap-1 sm:flex" data-testid="chart-head-funding">
                            {Number.isFinite(fundingRate) ? (
                                <FundingCountdown nextFundingTime={nextFundingTime ?? 0} fundingRate={fundingRate!} />
                            ) : <span className="font-mono text-ui-dense text-zinc-300">—</span>}
                        </span>
                    </div>
                </div>
                {/* The chart head is ONE quiet line (v3): the symbol picker,
                    the hero price, the change, the funding countdown and the
                    feed dot. The 24h high/low/volume/OI/oracle fields live in
                    the chart's crosshair readout, and the market tools (market
                    screener, pinned signals) live in the symbol picker's foot —
                    so no metrics band and no tool buttons ride this row. */}
                <span
                    data-testid="feed-status"
                    role="status"
                    aria-label={`Market feed ${feed.status}`}
                    title={feed.status === 'live' ? 'Live — websocket push (markPrice@1s · depth20@100ms · ticker · kline)' : feed.status === 'connecting' ? 'Opening websockets…' : 'Websocket down — REST polling every 5s'}
                    className="flex shrink-0 items-center pl-1"
                >
                    <span aria-hidden="true" className={`beacon ${feed.status === 'live' ? '' : 'is-quiet'}`.trim()} />
                </span>
            </div>

            {/* MOBILE MODE SWITCHER (<lg): Chart | AI | Book, pinned under the
                header; each mode shows exactly ONE full-height pane. Default
                Chart; the choice persists per user. At lg+ this row is not
                rendered at all.

                CHROME. These are NAVIGATION labels, not data readouts, so they
                follow the reference's rule — sentence case, not the shouty
                uppercase micro-label the readout row keeps — and the switcher
                is a raised pill (the sliding `.seg-thumb`) rather than a
                bordered box. */}
            {isBelowLg && (
                <div
                    ref={switcherRef}
                    role="tablist"
                    aria-label="Analyze surface mode"
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowRight') { e.preventDefault(); stepMode(1); }
                        else if (e.key === 'ArrowLeft') { e.preventDefault(); stepMode(-1); }
                        else if (e.key === 'Home') { e.preventDefault(); jumpMode('first'); }
                        else if (e.key === 'End') { e.preventDefault(); jumpMode('last'); }
                    }}
                    data-testid="trade-mode-switcher"
                    className="relative flex shrink-0 items-center self-start rounded-full bg-zinc-800/60 p-1 ml-3 mb-1"
                >
                    {thumb.width > 0 && (
                        <span
                            aria-hidden="true"
                            className="seg-thumb"
                            style={{ left: thumb.left, width: thumb.width }}
                        />
                    )}
                    {TRADE_MODES.map(m => (
                        <button
                            key={m}
                            ref={el => { modeTabRefs.current[m] = el; }}
                            type="button"
                            role="tab"
                            aria-selected={mode === m}
                            tabIndex={mode === m ? 0 : -1}
                            data-testid={`trade-mode-${m}`}
                            onClick={() => pickMode(m)}
                            className={`relative z-10 rounded-full px-4 py-1 text-ui-dense font-medium transition-colors duration-150 ease-[var(--ease-snappy)] active:scale-[0.97] ${
                                mode === m ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            {m === 'chart' ? 'Chart' : m === 'ai' ? 'AI' : 'Book'}
                        </button>
                    ))}
                </div>
            )}
            {/* Chart + book + AI chat (drag-resizable dock). BELOW lg exactly
                one pane shows (the mode switcher above); every pane stays
                MOUNTED-HIDDEN, and the container is overflow-hidden so the
                active pane fills the height. At lg+ the original stacked-
                scroll-then-row layout owns the height, untouched. */}
            <div className={isBelowLg
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-visible'}>
                {/* Left sidebar (Antigravity's Explorer position): the order
                    book, open/closed from the activity bar's active Trade
                    icon. Closed = the chart owns the whole middle. BELOW lg
                    it belongs to the Book mode instead: always mounted,
                    hidden unless the Book tab is active (the Book mode owns it)
                    gate it there — the mode switcher owns phone/tablet). */}
                {/* The chart COLUMN: the pane plus the order-book drawer, so
                    the drawer sits UNDER the chart and gives up no horizontal
                    space — as a row sibling it kept a 296px intrinsic column
                    even when shut, which squeezed the chart to 138px at 1280.
                    Below lg the wrapper is `contents`, so the panes stay the
                    row's direct children and the mode switcher keeps working. */}
                <div className={isBelowLg ? 'contents' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
                <div
                    data-testid="trade-chart-pane"
                    className={isBelowLg
                        ? (mode === 'chart' ? 'min-h-0 flex-1' : 'hidden')
                        /* Expanded, the chart is what GIVES way, and it gives way by
                         * flexing — never by claiming a fixed third. It used to take
                         * `lg:w-1/3 lg:flex-none`, which pinned its width while
                         * refusing to shrink, so the row could only widen past the
                         * viewport and clip the dock's right edge. */
                        : 'min-h-[420px] flex-1 lg:min-h-0 lg:min-w-0'}
                >
                    <ErrorBoundary pane label="The chart" resetKey={`${symbol}:${interval}`}>
                    <TradingChart symbol={symbol} interval={interval} onIntervalChange={changeInterval} sessionId={chatSnap.activeId ?? 'analyze'} verdict={chartVerdict} live={live} liveKline={feed.kline}
                        lastPrice={Number.isFinite(lastPrice) ? lastPrice : null}
                        markPrice={Number.isFinite(markPrice) ? markPrice : null}
                        chatLevels={chatLevels}
                        chartHandle={chartHandleRef}
                        ohlcvRow={ohlcvRow}
                        onDrawingsChange={setChartDrawings}
                        modelDrawings={modelDrawings}
                        onRemoveModelShape={removeModelShape} />
                    </ErrorBoundary>
                    <LevelAccuracyBadge
                        drawings={modelDrawings}
                        candles={levelCandles}
                        /* A floating chip over the plot, so it keeps a raised
                           surface to read against the candles — the same
                           raised pill the reference's own badges use — and
                           loses the border that framed it. */
                        className="absolute top-2 right-2 z-10 rounded-control bg-zinc-800/90 px-2 py-1" />
                </div>
                {/* The order book is DETAIL THE USER PULLS: a 30px strip
                    (name, live state, spread) closed by default, expanding
                    on demand. Below lg the Book mode is a full-height pane. */}
                {!isBelowLg && (
                    <div
                        data-testid="trade-sidebar"
                        data-book-open={bookOpen ? 'true' : 'false'}
                        className="shrink-0 border-t border-hairline"
                    >
                        <button
                            type="button"
                            onClick={() => setBookOpen(v => !v)}
                            aria-expanded={bookOpen}
                            aria-label={bookOpen ? 'Collapse order book' : 'Expand order book'}
                            data-testid="orderbook-drawer-strip"
                            className="flex h-[30px] w-full items-center gap-2 px-3 text-ui-dense text-zinc-400 transition-colors hover:text-zinc-200"
                        >
                            <span className={`beacon ${feed.depthLive ? '' : 'is-quiet'}`.trim()} aria-hidden="true" />
                            <span>Order book · <span className="text-zinc-500">live</span></span>
                            <span className="font-mono tabular-nums text-zinc-500" data-testid="orderbook-drawer-spread">
                                {bookMetrics || '—'}
                            </span>
                            <span className="ml-auto text-zinc-500">{bookOpen ? '▾' : '▴'}</span>
                        </button>
                        {bookOpen && (
                            <div style={{ height: BOOK_DRAWER_HEIGHT }} className="overflow-hidden">
                                <OrderBookPanel bare symbol={symbol} live={feed.depthLive} liveDepth={feed.depth} />
                            </div>
                        )}
                    </div>
                )}
                {/* Below lg the book pane: full-height OrderBookPanel (bare
                    mode = the bare ladder, no page chrome). */}
                {isBelowLg && (
                    <div
                        data-testid="trade-sidebar"
                        className={mode === 'book' ? 'min-h-0 w-full flex-1' : 'hidden'}
                    >
                        <OrderBookPanel bare symbol={symbol} live={feed.depthLive} liveDepth={feed.depth} />
                    </div>
                )}
                </div>
                {/* The Chart AI dock on the shared right-panel contract.

                    It supplies the WIDTH, the hide-vs-close behaviour, the drag
                    handle and (once a second panel registers) the tab capsules;
                    this surface supplies the layout classes, because below lg the
                    dock is one pane of a three-mode single-column stack rather
                    than a panel — which is why its presentation is pinned to
                    'push'. Letting the contract switch it to 'fullscreen' there
                    would overlay the mode switcher it is supposed to live in.

                    HIDE vs CLOSE. Collapsing used to swap a collapsed rail in for
                    this panel, unmounting it — so the composer draft, the scroll
                    offset and any in-flight turn died with it. Collapsing the dock
                    to look at the chart is an ordinary thing to do mid-analysis,
                    and coming back to an empty dock was data loss wearing a UI
                    costume. The shell keeps it mounted and makes it inert.

                    The `calc(100% - 420px)` cap is on BOTH states now, not just
                    the expanded one. With DOCK_MAX raised to 1000 a stored width
                    can be wider than the row it sits in on a 1024 laptop, and
                    without the cap the dock's right edge ran 24px past the window
                    (measured) — the chart survived but the header's close button
                    did not. 420 is kept as the chart's floor for the same reason
                    it was chosen for the expanded state: the ladder and the mode
                    switcher are unusable below it. */}
                <RightPanel
                    presentation="push"
                    isResizing={rightPanel.isResizing}
                    width={dockWidth}
                    isActive={!dockCollapsed}
                    isHidden={dockCollapsed && !isBelowLg}
                    docks={rightPanel.docks}
                    openIds={rightPanel.openIds}
                    activeId={rightPanel.activeId}
                    onSelectDock={rightPanel.setActive}
                    onCloseDock={rightPanel.close}
                    onResizeStart={startDrag}
                    onResizeReset={rightPanel.resetWidth}
                    label="Chart AI"
                    testId="trade-dock"
                    className={isBelowLg
                        ? (mode === 'ai' ? 'min-h-0 w-full flex-1' : 'hidden')
                        : `h-96 w-full shrink-0 lg:h-auto lg:w-[var(--panel-w)] lg:min-w-[300px] ${dockExpanded ? 'lg:!w-1/2 xl:!w-7/12 lg:!max-w-[calc(100%_-_420px)]' : 'lg:max-w-[calc(100%_-_420px)]'}`}
                >
                    <TradeChatPanel
                        {...dockProps}
                        memoryEnabled={memoryEnabled}
                        strategiesEnabled={strategiesEnabled}
                        onToggleCollapsed={isBelowLg ? undefined : collapseDock}
                        expanded={dockExpanded}
                        onToggleExpanded={toggleDockExpanded}
                        onNewGroup={onNewGroup}
                        botThreadRows={botThreadRows}
                        onBotTurnCommit={onBotTurnCommit}
                        onSoloTurnCommit={onSoloTurnCommit}
                        onSyncConversation={onSyncConversation}
                        conversationRows={conversationRows}
                        onOpenChat={onOpenChat}
                    />
                </RightPanel>
                {dockCollapsed && !isBelowLg && (
                    <div className="hidden shrink-0 lg:block" data-testid="trade-dock-rail">
                        <ChartAiDockRail onExpand={expandDock} live={live} />
                    </div>
                )}
            </div>
            {/* The pre-2026-09-16 below-md book overlay drawer lived here;
                the Book mode of the mobile switcher replaced it (same
                OrderBookPanel, no backdrop, no `orderbook-drawer` testid —
                grep of e2e/ + tests/ found zero references). */}
            <ScreenerPanel open={screenerOpen} onClose={() => setScreenerOpen(false)} onChangeSymbol={changeSymbol} trades={trades} />
        </div>
    );
};

export default TradeView;
