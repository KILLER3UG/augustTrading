/**
 * useFuturesLiveFeed — one websocket subscription bundle per symbol for the
 * trade surface: markPrice@1s + depth20@100ms + 24h ticker on a combined
 * socket, and kline_<interval> on its own. While `status === 'live'` the
 * consumers skip their polling entirely; the moment the socket drops the
 * status flips to 'polling' and the existing REST loops take over — so the
 * surface is push-first, never push-only.
 *
 * REST polling fallback: on networks where the futures WS completes the
 * handshake but the host silently drops every frame (this network drops the
 * 1 Hz `markPrice@1s` control alongside every other fstream stream), the
 * "push-first" hook would mark itself 'polling' forever and never deliver
 * a fresh mark price. The poll below fires `fetchMarkIndex` +
 * `fetchFuturesTicker24h` every 5 s while no combined frame has arrived
 * for the polling arming window — the mark + 24 h ticker stay live on the
 * surface, level-2 depth keeps its last good value with a `depthStaleSince`
 * stamp (no public REST endpoint for it), and any WS frame tears the poll
 * down within one tick.
 *
 * Reconnects with capped backoff; Binance closes idle/failing sockets
 * silently, so a stale connection is treated as closed.
 */

import { useEffect, useState } from 'react';
import {
    parseMarkPrice, parseTicker, parseDepth, parseKline, unwrapCombined,
    publishPaperMark, publishPaperKline, publishPaperTicker, registerLivePaperFeed,
    type LiveMarkIndex, type LiveTicker, type LiveDepth, type LiveKline,
} from '../services/trade/futuresStreams';
import { fetchMarkIndex, fetchFuturesTicker24h } from '../services/analysis/MarketDataService';
import { mapBinanceInterval } from '../services/analysis/KlineService';
import { BINANCE_FUTURES_WS } from '../config/exchangeEndpoints';

export type FeedStatus = 'connecting' | 'live' | 'polling';

/** Diagnostic only — which source currently produces the mark + ticker. WS
 *  push keeps this at 'ws'; the REST fallback sets it to 'rest'; nothing is
 *  flowing yet ⇒ 'live' is misleading so we use 'live' to mean "WS push
 *  healthy". The public `status` field stays the 3-value FeedStatus. */
export type PollSource = 'ws' | 'rest' | 'live';

const FUTURE_WS = BINANCE_FUTURES_WS;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 10000;

/** The combined feed streams markPrice@1s, so a healthy socket is never
 *  silent for long. If it goes quiet for STALL_MS while still OPEN, it is
 *  half-dead (phantom-live) — force-close so scheduleRetry flips us to
 *  'polling' and REST resumes. STALL_CHECK_MS is how often we test for it. */
const STALL_MS = 8000;
const STALL_CHECK_MS = 5000;

/** How recently a depth20 frame must have arrived for the ladder to count as
 *  pushed rather than polled. Checked on the STALL_CHECK_MS cadence, so a dead
 *  stream is caught within ~one tick. */
const DEPTH_LIVE_FRESH_MS = 4000;

/** REST polling cadence once the arming threshold has been crossed. 5 s
 *  matches the STALL_CHECK_MS so the strip never goes more than one poll
 *  window without a fresh mark number. */
const POLL_INTERVAL_MS = 5000;

/** How long the combined feed may stay silent before the REST poll arms.
 *  The 2026-09-16 repro on this network proved a 16 s window is wrong:
 *  the WS opens and stays OPEN but never delivers a single markPrice@1s
 *  frame — scheduleRetry never fires (no onclose), status stays 'connecting',
 *  and the strip froze on the last good value. Arming at 2 s means the
 *  user gets a fresh mark + ticker on every 5 s REST tick within ~5 s of
 *  mount, even when the WS path is completely dead. A healthy WS producing
 *  frames every 1 s keeps the poll dormant via the early-return in armTimer. */
const POLL_ARM_MS = 2000;

/** kline stream interval names. Delegates to the ONE Binance interval map
 *  (KlineService.mapBinanceInterval) — same tokens as the REST klines, so the
 *  multi-day suffixes ('1d','3d','1w', capital '1M') stay exact. The old local
 *  map's `?? appInterval.toLowerCase()` fallback carried the documented
 *  '1M'→1m trap for any token missing from it; the canonical map's fallback
 *  passes the token through UNCHANGED instead of lowercasing it. */
export const klineInterval = (appInterval: string): string => mapBinanceInterval(appInterval);

export interface FuturesLiveFeed {
    markIndex: LiveMarkIndex | null;
    ticker: LiveTicker | null;
    depth: LiveDepth | null;
    kline: LiveKline | null;
    status: FeedStatus;
    /** Epoch ms when depth went silent (no level-2 push frames). Null while
     *  depth is still fresh or was never seen. Public REST has no level-2
     *  endpoint, so the only honest answer is "stale since X" — the surface
     *  can render that or omit the column. Diagnostic-only addition. */
    depthStaleSince: number | null;
    /** Whether the depth20 push itself is current. Deliberately NOT the same
     *  question as `status`: on the network this file documents, markPrice@1s
     *  is dropped while depth20@100ms keeps flowing, so `status` never reaches
     *  'live' — and gating the order book on it threw away a healthy ladder
     *  stream in favour of 5 s REST, which read as "the book stopped being
     *  realtime". */
    depthLive: boolean;
    /** Diagnostic only — see PollSource. Lets surfaces and the TradingView
     *  mark line distinguish "fresh from REST" from "fresh from WS push"
     *  without parsing `status`. */
    pollSource: PollSource;
}

export const useFuturesLiveFeed = (symbol: string, interval: string): FuturesLiveFeed => {
    const [markIndex, setMarkIndex] = useState<LiveMarkIndex | null>(null);
    const [ticker, setTicker] = useState<LiveTicker | null>(null);
    const [depth, setDepth] = useState<LiveDepth | null>(null);
    const [kline, setKline] = useState<LiveKline | null>(null);
    const [status, setStatus] = useState<FeedStatus>('connecting');
    const [depthStaleSince, setDepthStaleSince] = useState<number | null>(null);
    const [pollSource, setPollSource] = useState<PollSource>('live');
    const [depthLive, setDepthLive] = useState(false);

    useEffect(() => {
        const s = symbol.toLowerCase();
        // One mounted Trade/Desk feed owns this symbol's socket. The paper
        // broker publishes into the SAME frame cache and therefore never opens
        // a duplicate combined socket while this feed is live.
        const releaseFeedOwner = registerLivePaperFeed(s);
        setMarkIndex(null); setTicker(null); setDepth(null); setKline(null);
        setStatus('connecting');
        setDepthStaleSince(null);
        setPollSource('live');
        setDepthLive(false);

        let closed = false;
        const sockets = new Set<WebSocket>();
        // @kline_1s is the paper broker's intra-window high/low source: a 30 s
        // REST poll synthesizes high=low=last and misses the wicks that fill
        // stops, targets and liquidations. Same combined socket, no extra one.
        const combinedUrl = `${FUTURE_WS}/stream?streams=${s}@markPrice@1s/${s}@depth20@100ms/${s}@ticker/${s}@kline_1s`;
        const klineUrl = `${FUTURE_WS}/ws/${s}@kline_${klineInterval(interval)}`;

        // Mutable handles shared between the WS path and the REST poll below.
        // lastMarkOrTickerAt: bumped ONLY by markPrice/ticker frames so the
        //   poll arms even when depth20 keeps flowing (depth alone does not
        //   guarantee a fresh mark price — on the user's network
        //   markPrice@1s is silently dropped while depth20@100ms flows).
        // pollHandle: the current setInterval id for the REST fallback (0 if
        //   dormant). The WS onmessage handler clears it; the poll re-arms
        //   itself when the silence window has elapsed.
        // pollInFlight: single-flight guard — a slow REST roundtrip must not
        //   stack a second poll on top of itself (mirrors the chart's
        //   TradingChart.tsx load() inFlight flag).
        // depthSeenAt: epoch ms of the last depth frame; drives
        //   depthStaleSince so the surface can flag a dead DOM column
        //   honestly even while mark/ticker keep updating.
        // latestStatus: mirrors the React `status` state in a mutable cell so
        // the arming watcher (a long-lived setInterval) can read the most
        // recent status without re-binding on every setStatus call. Without
        // this the closure captured 'connecting' forever and the poll
        // would never arm.
        const lastMarkOrTickerAt = { current: 0 };
        const pollHandle = { current: 0 };
        const pollInFlight = { current: false };
        const depthSeenAt = { current: 0 };
        const latestStatus = { current: 'connecting' as FeedStatus };

        // Mirror React state into a mutable cell so the long-lived arming
        // watcher (a setInterval that outlives any single re-render) can see
        // the most recent status without stale-closure blindness.
        const setFeedStatus = (next: FeedStatus): void => {
            latestStatus.current = next;
            setStatus(next);
        };

        // Each socket owns its OWN reconnect + stall watchdog. Previously a
        // single shared `gotMessageRef` meant the busy combined feed kept
        // flipping status 'live' while the kline socket was actually dead
        // (and one socket's `onclose` called a `start()` that re-opened BOTH,
        // accumulating duplicate depth feeds on every flap).
        const open = (url: string, isCombined: boolean, onData: (payload: unknown) => void): void => {
            let attempt = 0;
            let retryTimer = 0;
            let gotMessage = false;
            let lastMessageAt = 0;
            let stallTimer = 0;
            let ws: WebSocket;

            const scheduleRetry = (): void => {
                if (closed) return;
                if (isCombined) setFeedStatus('polling');
                gotMessage = false;
                window.clearInterval(stallTimer);
                const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
                attempt += 1;
                window.clearTimeout(retryTimer);
                retryTimer = window.setTimeout(() => { if (!closed) connect(); }, backoff);
            };

            const connect = (): void => {
                if (closed) return;
                try { ws = new WebSocket(url); } catch { scheduleRetry(); return; }
                sockets.add(ws);
                const connectTimer = window.setTimeout(() => {
                    // This socket opened but stayed silent (or never opened):
                    // treat it as dead so it reconnects and REST takes over.
                    if (ws.readyState !== WebSocket.OPEN || !gotMessage) { try { ws.close(); } catch { /* already gone */ } }
                }, CONNECT_TIMEOUT_MS);
                ws.onopen = () => { attempt = 0; };
                ws.onmessage = ev => {
                    const payload = url.includes('/stream?') ? unwrapCombined(String(ev.data)) : safeParse(String(ev.data));
                    if (payload) {
                        gotMessage = true;
                        lastMessageAt = Date.now();
                        // Once the first frame lands, the connectTimer's job is
                        // done — hand liveness to the rolling stall watchdog.
                        window.clearTimeout(connectTimer);
                        if (isCombined && stallTimer === 0) {
                            // Phantom-live guard: a half-open TCP (laptop sleep,
                            // Wi-Fi roam, NAT timeout) never fires onclose, so
                            // 'live' would stick and EVERY REST fallback stays
                            // gated off — the strip freezes on the last frame
                            // forever. If the 1s markPrice stream goes quiet
                            // for STALL_MS, force-close: onclose → scheduleRetry
                            // flips status to 'polling' and REST resumes.
                            stallTimer = window.setInterval(() => {
                                if (closed) { window.clearInterval(stallTimer); stallTimer = 0; return; }
                                if (gotMessage && Date.now() - lastMessageAt > STALL_MS
                                    && ws.readyState === WebSocket.OPEN) {
                                    try { ws.close(); } catch { /* onclose drives the retry */ }
                                }
                            }, STALL_CHECK_MS);
                        }
                        // Per-frame liveness (status='live', clear poll,
                        // bump lastMarkOrTickerAt) is handled inside `onData`
                        // below — keyed on the actual frame type so depth
                        // alone does NOT keep the REST fallback disarmed on
                        // networks where markPrice@1s is silently dropped.
                        onData(payload);
                    }
                };
                ws.onclose = () => { window.clearTimeout(connectTimer); window.clearInterval(stallTimer); stallTimer = 0; sockets.delete(ws); scheduleRetry(); };
                ws.onerror = () => { try { ws.close(); } catch { /* close fires onerror too */ } };
            };
            connect();
        };

        open(combinedUrl, true, msg => {
            const mi = parseMarkPrice(msg); if (mi) {
                publishPaperMark(symbol, mi.markPrice, mi.fundingRate);
                setMarkIndex(mi);
                lastMarkOrTickerAt.current = Date.now();
                setFeedStatus('live');
                if (pollHandle.current) {
                    window.clearInterval(pollHandle.current);
                    pollHandle.current = 0;
                }
                setPollSource('ws');
                setDepthStaleSince(null);
                return;
            }
            const tk = parseTicker(msg); if (tk) {
                publishPaperTicker(symbol, tk.lastPrice);
                setTicker(tk);
                lastMarkOrTickerAt.current = Date.now();
                setFeedStatus('live');
                if (pollHandle.current) {
                    window.clearInterval(pollHandle.current);
                    pollHandle.current = 0;
                }
                setPollSource('ws');
                setDepthStaleSince(null);
                return;
            }
            const dp = parseDepth(msg); if (dp) {
                setDepth(dp);
                // Track the last depth frame so the surface can render
                // "stale since X" honestly when only the REST fallback is
                // updating mark/ticker. Depth alone does not prove mark/ticker
                // are healthy, so we do NOT bump lastMarkOrTickerAt and must
                // not keep the REST poll disarmed.
                depthSeenAt.current = Date.now();
                setDepthStaleSince(null);
                setDepthLive(true);
                return;
            }
            // 1s klines on the SAME combined socket feed the paper broker's
            // SL/TP/liquidation ticks with the intra-window high/low wicks.
            // This is intentionally a separate state slot from the chart's
            // chosen-interval kline socket below.
            const kl = parseKline(msg); if (kl) {
                publishPaperKline(symbol, kl);
            }
        });
        open(klineUrl, false, msg => {
            const kl = parseKline(msg); if (kl) setKline(kl);
        });

        // ── REST polling fallback ────────────────────────────────────────
        // Why this exists: on a network where the futures WS completes the
        // handshake but the host silently drops every frame (the user's
        // 2026-09-16 repro), `status` flips to 'polling' but no REST
        // fallback was producing fresh numbers — the chart's "current price
        // line" and the mark stat froze on the last good value. The poll
        // below mounts a 5 s interval that hits `/fapi/v1/premiumIndex`
        // (markPrice/indexPrice/funding clock) and `/fapi/v1/ticker/24hr`
        // (lastPrice/24h change/volume). Level-2 depth has no public REST
        // endpoint, so we keep its last WS value and stamp `depthStaleSince`.
        //
        // Lifecycle:
        //   - WS onmessage: clearInterval (the WS push is healthier than any
        //     5 s REST round-trip). The arming watcher below will re-mount
        //     the poll if the socket goes silent again.
        //   - STALL_MS elapses without a frame, while no socket is open:
        //     poll arms (the connect timer will have already closed the
        //     dead WS and flipped status to 'polling'). We arm AFTER STALL_MS
        //     * 2 so we don't fight an alive-but-just-slow socket.
        //   - Cleanup: clear the interval on unmount/symbol/interval change.
        //
        // Single-flight: a slow REST roundtrip must not stack a second poll
        // on top of itself; `pollInFlight` is the mirror of TradingChart.tsx
        // `load()`'s inFlight flag.
        const runPollOnce = async (): Promise<void> => {
            if (closed || pollInFlight.current) return;
            pollInFlight.current = true;
            try {
                // Both endpoints hit the same fapi host the WS would have —
                // fapi REST is answering fine on this network (the WS host
                // is the broken one). Run them in parallel; either can fail
                // independently without poisoning the other.
                const [mi, tk] = await Promise.all([
                    fetchMarkIndex(symbol).catch(() => null),
                    fetchFuturesTicker24h(symbol).catch(() => null),
                ]);
                if (closed) return;
                if (mi && (mi.available || mi.markPrice > 0 || mi.indexPrice > 0)) {
                    setMarkIndex({
                        markPrice: mi.markPrice,
                        indexPrice: mi.indexPrice,
                        fundingRate: mi.lastFundingRate,
                        nextFundingTime: mi.nextFundingTime,
                    });
                }
                if (tk && Number.isFinite(tk.currentPrice) && tk.currentPrice > 0) {
                    setTicker({
                        lastPrice: tk.currentPrice,
                        changePercent24h: tk.priceChangePercent24h,
                        quoteVolume24h: tk.volume24h,
                    });
                }
                setPollSource('rest');
                // Stamp the depth column as stale ONLY the first time the
                // REST fallback takes over without a prior depth frame — a
                // later push frame will clear it. Use depthSeenAt rather
                // than lastMarkOrTickerAt because mark frames alone are
                // enough to keep status 'live' on the same socket; if depth
                // is gone but mark keeps landing, the surface still wants
                // the DOM column flagged.
                if (depthSeenAt.current === 0) {
                    setDepthStaleSince(Date.now());
                } else {
                    setDepthStaleSince(depthSeenAt.current);
                }
            } finally {
                pollInFlight.current = false;
            }
        };

        // Arming watcher: every STALL_CHECK_MS, decide whether to start the
        // poll interval. Independent of the per-socket stall watchdogs (those
        // close dead sockets; this one mounts the REST fallback).
        const armTimer = window.setInterval(() => {
            if (closed) return;
            // Depth liveness is answered here rather than by `status`: this
            // watcher runs whether or not the mark/ticker path ever goes live.
            setDepthLive(depthSeenAt.current > 0
                && Date.now() - depthSeenAt.current < DEPTH_LIVE_FRESH_MS);
            // Already running? Nothing to do — the interval will keep firing.
            if (pollHandle.current) return;
            // WS mark/ticker are alive and recent — no REST fallback needed.
            if (lastMarkOrTickerAt.current > 0
                && Date.now() - lastMarkOrTickerAt.current <= POLL_ARM_MS) return;
            // Arm the poll when EITHER:
            //   (a) the combined feed has never produced a mark/ticker frame
            //       AND we've passed the arming window from mount (the WS
            //       handshake opened but the host silently drops frames —
            //       the user's 2026-09-16 repro on this network).
            //   (b) the WS was alive, has gone silent past POLL_ARM_MS, and
            //       `latestStatus` is now 'polling' — re-arm so we recover
            //       after a flap. The status flip happens in scheduleRetry
            //       when the per-socket stall watchdog closes the dead
            //       socket; latestStatus mirrors it so this long-lived
            //       interval sees the update.
            // Use latestStatus (mutable cell) instead of the captured `status`
            // closure variable — the latter freezes at 'connecting' for the
            // lifetime of the effect and would never let (b) fire.
            const elapsedSinceMarkOrTicker = lastMarkOrTickerAt.current > 0
                ? Date.now() - lastMarkOrTickerAt.current
                : Date.now(); // never produced: pretend mount = 0
            const wantArm = (lastMarkOrTickerAt.current === 0 && elapsedSinceMarkOrTicker >= POLL_ARM_MS)
                || (lastMarkOrTickerAt.current > 0 && elapsedSinceMarkOrTicker > POLL_ARM_MS
                    && latestStatus.current === 'polling');
            if (!wantArm) return;
            // First poll fires immediately so a freshly-mounted user with a
            // dead WS sees a live number within ~50 ms rather than waiting
            // the full POLL_INTERVAL_MS for the first tick.
            void runPollOnce();
            pollHandle.current = window.setInterval(() => { void runPollOnce(); }, POLL_INTERVAL_MS);
        }, STALL_CHECK_MS);

        return () => {
            closed = true;
            releaseFeedOwner();
            window.clearInterval(armTimer);
            if (pollHandle.current) {
                window.clearInterval(pollHandle.current);
                pollHandle.current = 0;
            }
            sockets.forEach(ws => { try { ws.close(); } catch { /* already closed */ } });
            sockets.clear();
        };
    }, [symbol, interval]);

    return { markIndex, ticker, depth, kline, status, depthStaleSince, depthLive, pollSource };
};

const safeParse = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return null; }
};
