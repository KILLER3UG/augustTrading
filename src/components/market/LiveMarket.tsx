/**
 * LiveMarket — the market overlay: a live chart, an AI read on it, and the
 * button that hands the multi-timeframe data block to the chat.
 *
 * Port note (2026-09-27). This panel used to embed TradingView's tv.js from
 * s3.tradingview.com and run its OWN WebSocket + REST-poll price transport
 * and six private indicator functions. All three were dead or duplicated in
 * the app's own shells:
 *   · tv.js is unreachable from both shells — Electron's CSP and the
 *     Capacitor webviews block the remote script, so the chart area rendered
 *     an empty <div id="tradingview_widget"> on every real device.
 *   · the hand-rolled WS+poll (Binance spot, three CORS proxies) is a second
 *     answer to a question `hooks/useFuturesLiveFeed` already answers, with
 *     a half-open socket and no stall detection.
 *   · the private SMA/EMA/RSI/MACD/Bollinger/KDJ/SAR copies were a second
 *     implementation of `TechnicalAnalysisService`.
 * The chart is now the app's own `TradingChart` (same instrument, same
 * lightweight-charts render, same drawings/verdict overlays as the Trade
 * surface), the price comes from `useFuturesLiveFeed`, and the data block is
 * built by `services/analysis/marketSnapshot` on top of the canonical
 * indicators. The UI structure is unchanged — same header, price readout,
 * connection pill, symbol/interval selects, AI overlay card, insights panel
 * and Analyze button.
 *
 * Because the price now comes from a hook that opens sockets on mount, App
 * renders this panel only while the overlay is open (it returned null
 * otherwise anyway). Keep it that way: mounting it hidden would hold two
 * futures sockets plus a REST poller open for the whole session.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CloseIcon, ActivityIcon, LoadingIcon, CameraIcon, CheckIcon, ChevronDownIcon, BrainIcon, TrendUpIcon, TrendDownIcon, AlertTriangleIcon, AlertCircle } from '../shared/Icons';
import { sanitizeErrorText } from '../../utils/runStatus';
import { Spinner } from '../ui/Spinner';
import StatusPill from '../ui/StatusPill';
import { SelectMenu } from '../shared/SelectMenu';
import { ChartCandle } from '../../types/chart';
import { analyzeWithAI, convertToLineData, MarketInsights, TrendlineResult } from '../../services/analysis/AITrendlineService';
import { buildTimeframeSnapshot, formatLiveMarketPrompt, type LiveMarketSnapshot } from '../../services/analysis/marketSnapshot';
import { fetchKlines } from '../../services/analysis/KlineService';
import TradingChart from '../trade/TradingChart';
import type { ChartInterval } from '../../utils/chartIntervals';
import { MODEL_COLOR_NAMES, type ChartDrawing } from '../../services/trade/chartDrawings';
import { useFuturesLiveFeed } from '../../hooks/useFuturesLiveFeed';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface LiveMarketProps {
    isVisible: boolean;
    onClose: () => void;
    onAnalyze: (data: string) => void;
    /** Rendered inside a surface page instead of the full-screen overlay:
     *  no fixed positioning, no close button, Esc does not navigate. */
    isEmbedded?: boolean;
}

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'TAOUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT'];
/** The panel's own coarse interval set. A subset of the chart's full
 *  `CHART_INTERVALS`, so both controls stay valid against one type. */
const INTERVALS: ChartInterval[] = ['5m', '15m', '1h', '4h'];

/** The timeframes the Analyze button walks. Same four the AI block has
 *  always carried, and the same four `utils/liveMarketParser` recognises in
 *  its regex fallback. */
const ANALYSIS_TIMEFRAMES: ChartInterval[] = ['5m', '15m', '1h', '4h'];

/** The price readout's classes. The 300ms colour fade is the tick-flash read
 *  (see the sanctioned .tick-up/.tick-down pattern); the VALUE animating is
 *  data, not chrome. Swapped imperatively by the price effect below so a
 *  1 Hz mark-price stream never re-renders this panel's tree. */
const PRICE_BASE_CLASS = "font-mono tabular-nums text-ui-base sm:text-ui-lg font-bold text-zinc-600 transition-colors duration-300 ease-[var(--ease-snappy)]";
const PRICE_UP_CLASS = "font-mono tabular-nums text-ui-base sm:text-ui-lg font-bold transition-colors duration-300 ease-[var(--ease-snappy)] text-emerald-400";
const PRICE_DOWN_CLASS = "font-mono tabular-nums text-ui-base sm:text-ui-lg font-bold transition-colors duration-300 ease-[var(--ease-snappy)] text-rose-400";

const LiveMarket: React.FC<LiveMarketProps> = ({ isVisible, onClose, onAnalyze, isEmbedded = false }) => {
    // Esc closes the overlay (was a navigation dead-end).
    useEscapeClose(isVisible && !isEmbedded, onClose);
    // The full-screen overlay says `aria-modal="true"`, so Tab has to stay
    // inside it — the embedded panel says nothing of the kind and must not be
    // trapped: it sits beside the rest of the page, and a trap there would
    // lock keyboard focus inside a column the trader is trying to leave.
    const dialogRef = useFocusTrap<HTMLDivElement>(isVisible && !isEmbedded);
    const [symbol, setSymbol] = useState('ETHUSDT');
    // Renamed from `interval` — a state variable named `interval` shadows the
    // global setInterval, making any future bare setInterval(...) call throw
    // "setInterval is not a function".
    const [chartInterval, setChartInterval] = useState<ChartInterval>('15m');

    /** The one-shot notice over the panel. There is exactly ONE producer today
     *  — a failed data extraction — so the DEFAULT is 'error'. Both used to be
     *  impossible: the toast was painted emerald-500 with a checkmark whatever
     *  it said, so "Insufficient data fetched. Check network connection." was
     *  announced to the trader as a success. */
    const [notification, setNotification] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
    const [analysisProgress, setAnalysisProgress] = useState<string | null>(null);

    // AI Analysis state for Binance
    const [isAIAnalyzing, setIsAIAnalyzing] = useState(false);
    const [marketBias, setMarketBias] = useState<'bullish' | 'bearish' | 'neutral'>('neutral');
    const [aiSummary, setAiSummary] = useState<string>('');
    const [keyLevels, setKeyLevels] = useState<{ price: number; type: 'support' | 'resistance' }[]>([]);
    const [marketInsights, setMarketInsights] = useState<MarketInsights | null>(null);
    /** The AI's drawn trendlines. The model returns exact endpoints and this
     *  panel already pays for the call, but until now the array was only ever
     *  console.logged — the work was bought and thrown away. */
    const [trendlines, setTrendlines] = useState<TrendlineResult[]>([]);
// The same trendlines, as drawable shapes. See the setTrendlineDrawings call.
const [trendlineDrawings, setTrendlineDrawings] = useState<ChartDrawing[]>([]);
    const [isInsightsPanelExpanded, setIsInsightsPanelExpanded] = useState(true);
    const aiAnalysisRequestRef = useRef(0);

    const notificationTimeoutRef = useRef<number | null>(null);
    const priceDisplayRef = useRef<HTMLSpanElement>(null);
    const lastPriceRef = useRef<number | null>(null);
    const isMountedRef = useRef(true);

    // ── Live transport ─────────────────────────────────────────────────────
    // The app's own futures feed (markPrice@1s + 24h ticker + kline push,
    // with a REST fallback that arms when the socket goes quiet). Replaces
    // this panel's private Binance-spot socket + three CORS proxies.
    const feed = useFuturesLiveFeed(symbol, chartInterval);
    const live = feed.status === 'live';
    const markPrice = feed.markIndex?.markPrice ?? null;
    const lastPrice = feed.ticker?.lastPrice ?? null;
    // The mark price is the panel's headline number — same reason the chart's
    // dashed line is labelled 'mark': on a quiet perp the last-trade ticker
    // sits unchanged for minutes while mark keeps streaming.
    const currentPrice = markPrice ?? lastPrice;

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            // Clear notification timeout on unmount
            if (notificationTimeoutRef.current) {
                window.clearTimeout(notificationTimeoutRef.current);
                notificationTimeoutRef.current = null;
            }
        };
    }, []);

    // Price readout. Driven imperatively (rather than as state) so a 1 Hz
    // mark-price stream repaints one span instead of re-rendering the panel —
    // the flash direction still needs the previous value, which is what
    // lastPriceRef carries.
    useEffect(() => {
        const el = priceDisplayRef.current;
        if (!el) return;
        if (!isVisible || !Number.isFinite(currentPrice)) {
            el.textContent = 'Loading...';
            el.className = PRICE_BASE_CLASS;
            lastPriceRef.current = null;
            return;
        }
        const price = currentPrice as number;
        const prev = lastPriceRef.current ?? price;
        el.textContent = `$${price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        el.className = price > prev ? PRICE_UP_CLASS : price < prev ? PRICE_DOWN_CLASS : PRICE_BASE_CLASS;
        lastPriceRef.current = price;
    }, [isVisible, symbol, currentPrice]);

    // AI Analysis for chart
    useEffect(() => {
        const requestId = ++aiAnalysisRequestRef.current;
        if (!isVisible) {
            setIsAIAnalyzing(false);
            setMarketBias('neutral');
            setAiSummary('');
            setKeyLevels([]);
            setMarketInsights(null);
            return;
        }

        const runAIAnalysis = async () => {
            setIsAIAnalyzing(true);
            try {
                // Fetch kline data for AI analysis
                const klines = await fetchKlines(symbol, chartInterval, 300);
                if (klines.length < 50) {
                    setIsAIAnalyzing(false);
                    return;
                }

                // Convert to CandlestickData format for AI service
                const candles: ChartCandle[] = klines.map(k => ({
                    time: Math.floor(k.time / 1000),
                    open: k.open,
                    high: k.high,
                    low: k.low,
                    close: k.close,
                }));

                const analysis = await analyzeWithAI(candles, symbol, chartInterval);

                if (isMountedRef.current && requestId === aiAnalysisRequestRef.current) {
                    setMarketBias(analysis.marketBias);
                    setAiSummary(analysis.summary);
                    setKeyLevels(analysis.keyLevels);
                    setMarketInsights(analysis.insights);
                    setTrendlines(analysis.trendlines);
                    // Put the trendlines ON the chart. They used to exist only
                    // as a list of price ranges in the side panel, under a
                    // comment claiming the row "cannot drift from what the
                    // chart format would have drawn" — and nothing drew them,
                    // so the claim described an aspiration. The service
                    // already returns DATA-SPACE endpoints, so this is the
                    // conversion the comment always assumed, and the chart's
                    // own visibility rules (this surface has no chat, so
                    // repaint() clips these exactly as it clips the dock's)
                    // now apply to them like any other shape.
                    setTrendlineDrawings(
                        analysis.trendlines.map((line, i) => ({
                            id: `ai-tl-${i}-${line.startTime}`,
                            kind: 'trend' as const,
                            points: [
                                { t: line.startTime, p: line.startPrice },
                                { t: line.endTime, p: line.endPrice },
                            ],
                            color: (MODEL_COLOR_NAMES as Record<string, string>)[line.type] ?? MODEL_COLOR_NAMES.sky,
                            createdAt: Date.now(),
                            label: line.label || line.type,
                        }))
                    );
                }
            } catch (error) {
                console.warn('[Binance AI] Analysis failed:', error);
            } finally {
                if (isMountedRef.current && requestId === aiAnalysisRequestRef.current) setIsAIAnalyzing(false);
            }
        };

        // Debounce to avoid rapid calls
        const timeout = setTimeout(runAIAnalysis, 500);
        return () => clearTimeout(timeout);
    }, [isVisible, symbol, chartInterval]);

    const showNotification = (msg: string, tone: 'error' | 'success' = 'error') => {
        setNotification({ text: msg, tone });
        // Clear previous timeout if exists
        if (notificationTimeoutRef.current) {
            window.clearTimeout(notificationTimeoutRef.current);
        }
        notificationTimeoutRef.current = window.setTimeout(() => {
            setNotification(null);
            notificationTimeoutRef.current = null;
        }, 5000);
    };

    const handleExtractAndAnalyze = useCallback(async () => {
        if (analysisProgress) return;

        setAnalysisProgress('Initializing...');

        try {
            const snapshots: Record<string, LiveMarketSnapshot> = {};
            let validDataCount = 0;

            for (const tf of ANALYSIS_TIMEFRAMES) {
                setAnalysisProgress(`Analyzing ${tf}...`);

                const klines = await fetchKlines(symbol, tf, 300);
                if (klines.length < 200) continue;

                validDataCount++;
                snapshots[tf] = buildTimeframeSnapshot(klines);
            }

            if (validDataCount === 0) throw new Error('Insufficient data fetched. Check network connection.');

            setAnalysisProgress('Finalizing...');
            await new Promise(resolve => window.setTimeout(resolve, 300));

            onAnalyze(formatLiveMarketPrompt(symbol, snapshots));

        } catch (error) {
            console.error('Analysis extraction failed', error);
            // sanitizeErrorText, not the raw message: a transport failure can
            // carry a request URL, and the doctrine forbids surfacing one.
            const detail = sanitizeErrorText(error) || 'Failed to extract market data. Please try again.';
            showNotification(detail, 'error');
        } finally {
            setAnalysisProgress(null);
        }
    }, [analysisProgress, onAnalyze, symbol]);

    if (!isVisible) return null;

    /* The transport's own vocabulary, so the pill can never claim a source
     * the feed is not actually using: 'live' = WS push frames arriving,
     * 'polling' = the socket is down/quiet and REST is carrying it,
     * 'connecting' = nothing flowing yet. */
    const feedLive = feed.status === 'live';
    const feedPolling = feed.status === 'polling';

    return (
        <div ref={dialogRef} role="dialog" aria-modal={isEmbedded ? undefined : 'true'} aria-label="Live Market" className={` flex flex-col ${isEmbedded ? 'h-full' : 'fixed inset-0 bg-zinc-950 z-modal animate-fade-in pb-[env(safe-area-inset-bottom)]'}`}>
            {/* Header - 2 rows on mobile for spacious feel */}
            <div className="bg-zinc-900 border-b border-hairline flex-shrink-0 shadow-lg shadow-black/20">
                {/* Top Row - Title, Price & Close */}
                <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-hairline">
                    <div className="flex items-center gap-2 sm:gap-3">
                        <div className="flex items-center gap-1.5 sm:gap-2 text-cyan-400">
                            <ActivityIcon className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden="true" />
                            <h2 className="font-bold text-ui-lg sm:text-lg tracking-tight">Live Market</h2>
                        </div>

                        {/* Connection status — one StatusPill instead of the
                            hand-rolled triple-nested border/bg/text ternary, so
                            "degraded transport" reads with the same amber the
                            rest of the app means by it. */}
                        <div className="hidden sm:flex">
                            <StatusPill
                                tone={feedLive ? 'up' : feedPolling ? 'warn' : 'neutral'}
                                kicker
                                title={feedLive
                                    ? 'Streaming from the exchange socket'
                                    : feedPolling ? 'Polling over HTTP — the socket is unavailable' : 'No feed yet'}
                                icon={<span aria-hidden className={`h-2 w-2 rounded-full ${
                                    feedLive ? 'bg-emerald-500 animate-pulse' : feedPolling ? 'bg-amber-500 animate-pulse' : 'bg-zinc-500'
                                }`} />}
                                data-testid="market-connection-pill"
                            >
                                {feedLive ? 'Live' : feedPolling ? 'HTTP' : '...'}
                            </StatusPill>
                        </div>
                    </div>

                    {/* Price Display & Close */}
                    <div className="flex items-center gap-2 sm:gap-4">
                        <div className="text-right">
                            <span className="text-ui-xs uppercase font-bold text-zinc-500 tracking-wider block">Mark</span>
                            <span ref={priceDisplayRef} className={PRICE_BASE_CLASS}>
                                Loading...
                            </span>
                        </div>
                        {!isEmbedded && (
                        <button
                            onClick={onClose}
                            className="p-3 text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-control transition-colors active:scale-95"
                            aria-label="Close"
                        >
                            <CloseIcon className="w-5 h-5" aria-hidden="true" />
                        </button>
                        )}
                    </div>
                </div>

                {/* Bottom Row - Controls */}
                <div className="flex items-center justify-between px-4 sm:px-6 py-4 gap-4 bg-zinc-950/30">
                    {/* Selectors Group */}
                    <div className="flex items-center gap-2 flex-1 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
                        {/* Symbol Selector */}
                        <SelectMenu
                            value={symbol}
                            onChange={setSymbol}
                            options={ASSETS.map(a => ({ value: a, label: a.replace('USDT', '') }))}
                            aria-label="Market symbol"
                            className="shrink-0"
                            drop="up"
                            triggerClassName="h-12 min-w-[112px] rounded-control border border-hairline bg-zinc-800 px-4 text-ui-base font-bold hover:bg-zinc-700 focus:border-accent"
                        />

                        {/* Interval Selector — bound to the SAME state the chart's
                            own timeframe bar drives, so neither control can go
                            stale relative to the other. */}
                        <SelectMenu
                            value={chartInterval}
                            onChange={(v) => setChartInterval(v as ChartInterval)}
                            options={INTERVALS.map(i => ({ value: i, label: i }))}
                            aria-label="Chart interval"
                            className="shrink-0"
                            drop="up"
                            triggerClassName="h-12 min-w-[78px] rounded-control border border-hairline bg-zinc-800 px-4 text-ui-base font-bold hover:bg-zinc-700 focus:border-accent"
                        />
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={() => { void handleExtractAndAnalyze(); }}
                            disabled={!!analysisProgress}
                            className="flex items-center justify-center gap-2 h-12 bg-accent hover:bg-amber-500 text-accent-ink text-ui-base font-bold px-6 rounded-control shadow-lg shadow-black/30 transition-[background-color,transform] duration-[150ms] ease-[var(--ease-snappy)] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-95"
                        >
                            {analysisProgress ? <LoadingIcon className="w-4 h-4" aria-hidden="true" /> : <CameraIcon className="w-4 h-4" aria-hidden="true" />}
                            <span>{analysisProgress || 'Analyze'}</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Chart Container — the app's own chart, same component the Trade
                surface renders. Sized by the flex parent so lightweight-charts
                gets a real box (it measures, it does not self-size). */}
            <div className="flex-1 min-h-[360px] lg:min-h-[500px] flex flex-col relative bg-zinc-900 overflow-hidden">
                <div className="min-h-0 flex-1">
                    <TradingChart
                        symbol={symbol}
                        interval={chartInterval}
                        onIntervalChange={setChartInterval}
                        live={live}
                        liveKline={feed.kline}
                        lastPrice={Number.isFinite(lastPrice) ? lastPrice : null}
                        markPrice={Number.isFinite(markPrice) ? markPrice : null}
                        modelDrawings={trendlineDrawings}
                    />
                </div>

                        {/* AI Analysis Overlay */}
                        {(marketBias !== 'neutral' || isAIAnalyzing || keyLevels.length > 0) && (
                            <div className="absolute top-2 right-2 z-10 flex flex-col gap-2 max-w-[200px]">
                                {/* AI Analyzing Indicator */}
                                {isAIAnalyzing && (
                                    <div className="flex items-center gap-2 bg-cyan-400/10 border border-cyan-400/20 rounded-control px-3 py-1.5">
                                        <Spinner size="w-3 h-3" color="border-cyan-400" />
                                        <span className="text-cyan-400 font-bold text-ui-sm">AI Analyzing...</span>
                                    </div>
                                )}

                                {/* Market Bias Badge */}
                                {!isAIAnalyzing && marketBias !== 'neutral' && (
                                    <div className={`flex items-center gap-2 rounded-control px-3 py-1.5 ${marketBias === 'bullish'
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-rose-500/10 border border-rose-500/20'
                                        }`}>
                                        <span className={`font-bold text-ui-sm ${marketBias === 'bullish' ? 'text-emerald-400' : 'text-rose-400'
                                            }`}>
                                            {marketBias === 'bullish' ? '▲ BULLISH' : '▼ BEARISH'}
                                        </span>
                                    </div>
                                )}

                                {/* Key Levels */}
                                {!isAIAnalyzing && keyLevels.length > 0 && (
                                    <div className="bg-zinc-900 border border-hairline rounded-control px-3 py-2">
                                        <span className="text-ui-xs font-bold text-zinc-500 uppercase tracking-wider">Key Levels</span>
                                        <div className="flex flex-col gap-1 mt-1">
                                            {keyLevels.slice(0, 4).map((level, i) => (
                                                <div key={i} className="flex items-center justify-between gap-2 text-ui-sm">
                                                    <span className={level.type === 'resistance' ? 'text-rose-400' : 'text-emerald-400'}>
                                                        {level.type === 'resistance' ? 'R' : 'S'}
                                                    </span>
                                                    <span className="font-mono text-white">${level.price.toLocaleString()}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* AI Trendlines - the price range per line. The SHAPES themselves are on
                                    the chart above (modelDrawings); this row is the readable
                                    summary of the same numbers, not a second copy of them. */}
                                {!isAIAnalyzing && trendlines.length > 0 && (
                                    <div className="bg-zinc-900 border border-hairline rounded-control px-3 py-2" data-testid="ai-trendlines">
                                        <span className="text-ui-xs font-bold text-zinc-500 uppercase tracking-wider">Trendlines</span>
                                        <div className="flex flex-col gap-1 mt-1">
                                            {trendlines.slice(0, 4).map((line, i) => {
                                                const [from, to] = convertToLineData(line);
                                                const lo = Math.min(from.value, to.value);
                                                const hi = Math.max(from.value, to.value);
                                                return (
                                                    <div key={`${line.startTime}-${i}`} className="flex items-baseline justify-between gap-2 text-ui-sm">
                                                        <span className="text-zinc-300 truncate" title={line.label || line.type}>{line.label || line.type}</span>
                                                        <span className="font-mono text-white shrink-0">
                                                            ${lo.toLocaleString()}–${hi.toLocaleString()}
                                                            <span className="text-zinc-600"> · {line.importance}</span>
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* AI Summary */}
                                {!isAIAnalyzing && aiSummary && (
                                    <div className="bg-zinc-900 border border-hairline rounded-control px-3 py-2">
                                        <span className="text-ui-xs text-zinc-400 leading-relaxed line-clamp-3" title={aiSummary}>{aiSummary}</span>
                                    </div>
                                )}
                            </div>
                        )}
            </div>

            {/* AI Market Insights Panel */}
            {(marketInsights || isAIAnalyzing) && (
                <div className="flex-shrink-0 bg-zinc-900 border-t border-hairline">
                    {/* Panel Header */}
                    <button
                        type="button"
                        aria-expanded={isInsightsPanelExpanded}
                        aria-controls="live-market-insights"
                        onClick={() => setIsInsightsPanelExpanded(!isInsightsPanelExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800 transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <BrainIcon className="w-5 h-5 text-cyan-400" aria-hidden="true" />
                            <span className="font-bold text-ui-base text-cyan-400">AI Market Insights</span>
                            {isAIAnalyzing && (
                                <Spinner size="w-3 h-3" color="border-cyan-400" className="ml-2" />
                            )}
                            {!isAIAnalyzing && marketBias !== 'neutral' && (
                                <span className={`ml-2 px-2 py-0.5 rounded-control text-ui-xs font-bold uppercase ${marketBias === 'bullish'
                                    ? 'bg-emerald-500/20 text-emerald-400'
                                    : 'bg-rose-500/20 text-rose-400'
                                    }`}>
                                    {marketBias}
                                </span>
                            )}
                        </div>
                        <ChevronDownIcon className={`w-5 h-5 text-zinc-400 transition-transform duration-[150ms] ease-[var(--ease-snappy)] ${isInsightsPanelExpanded ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Panel Content */}
                    {isInsightsPanelExpanded && marketInsights && !isAIAnalyzing && (
                        <div id="live-market-insights" className="px-4 sm:px-6 pb-6 space-y-4 max-h-[45vh] overflow-y-auto custom-scrollbar">
                            {/* Current Situation */}
                            <div className="bg-zinc-800 rounded-bubble p-3 border border-hairline">
                                <div className="flex items-center gap-2 mb-2">
                                    <ActivityIcon className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                                    <span className="text-ui-sm font-bold text-zinc-400 uppercase tracking-wider">Current Situation</span>
                                </div>
                                <p className="text-ui-base text-zinc-200 leading-relaxed">{marketInsights.situation}</p>
                            </div>

                            {/* Key Observations */}
                            {marketInsights.observations.length > 0 && (
                                <div className="bg-zinc-800 rounded-bubble p-3 border border-hairline">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-ui-sm font-bold text-zinc-400 uppercase tracking-wider">Key Observations</span>
                                    </div>
                                    <ul className="space-y-1.5">
                                        {marketInsights.observations.map((obs, i) => (
                                            <li key={i} className="flex items-start gap-2 text-ui-base text-zinc-300">
                                                <span className="text-cyan-400 mt-1">•</span>
                                                <span>{obs}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Potential Moves */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {/* Bullish Scenario */}
                                <div className="bg-emerald-500/5 rounded-bubble p-3 border border-emerald-500/20">
                                    <div className="flex items-center gap-2 mb-2">
                                        <TrendUpIcon className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                                        <span className="text-ui-sm font-bold text-emerald-400 uppercase tracking-wider">Bullish</span>
                                    </div>
                                    <p className="text-ui-base text-zinc-300 leading-relaxed">{marketInsights.potentialMoves.bullish}</p>
                                </div>

                                {/* Bearish Scenario */}
                                <div className="bg-rose-500/5 rounded-bubble p-3 border border-rose-500/20">
                                    <div className="flex items-center gap-2 mb-2">
                                        <TrendDownIcon className="w-4 h-4 text-rose-400" aria-hidden="true" />
                                        <span className="text-ui-sm font-bold text-rose-400 uppercase tracking-wider">Bearish</span>
                                    </div>
                                    <p className="text-ui-base text-zinc-300 leading-relaxed">{marketInsights.potentialMoves.bearish}</p>
                                </div>
                            </div>

                            {/* Risk Factors */}
                            {marketInsights.riskFactors.length > 0 && (
                                <div className="bg-amber-500/5 rounded-bubble p-3 border border-amber-500/20">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertTriangleIcon className="w-4 h-4 text-amber-400" aria-hidden="true" />
                                        <span className="text-ui-sm font-bold text-amber-400 uppercase tracking-wider">Watch Out</span>
                                    </div>
                                    <ul className="space-y-1.5">
                                        {marketInsights.riskFactors.map((risk, i) => (
                                            <li key={i} className="flex items-start gap-2 text-ui-base text-zinc-300">
                                                <span>{risk}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Loading State — no id here: the aria-controls target
                        above is the expanded content panel, and a duplicate
                        id would make the two divs indistinguishable. */}
                    {isInsightsPanelExpanded && isAIAnalyzing && (
                        <div className="px-4 sm:px-6 pb-6">
                            <div className="bg-zinc-800 rounded-bubble p-6 border border-hairline flex flex-col items-center justify-center gap-3">
                                <Spinner size="w-8 h-8" color="border-cyan-400" />
                                <span className="text-ui-base text-zinc-400">Analyzing market conditions...</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Notification Toast — tone-bearing, and it says out loud what it
                draws: an error announces as an alert, a success as a status. */}
            {notification && (
                <div
                    role={notification.tone === 'error' ? 'alert' : 'status'}
                    className={`absolute top-28 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-confirm px-5 py-3.5 rounded-bubble shadow-2xl flex items-center gap-3 animate-fade-in text-white ${
                        notification.tone === 'error' ? 'bg-rose-500/90' : 'bg-emerald-500/90'
                    }`}
                >
                    {notification.tone === 'error'
                        ? <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                        : <CheckIcon className="w-5 h-5 shrink-0" aria-hidden="true" />}
                    <span className="font-medium text-ui-base">{notification.text}</span>
                </div>
            )}
        </div>
    );
};

export default React.memo(LiveMarket);
