/**
 * PriceAlertService - Real-time price monitoring (shared feed)
 *
 * Features:
 * - WebSocket connection to Binance for real-time prices
 * - REST polling fallback with a batched request
 * - Ref-counted feed holds + per-symbol tracking for external consumers
 *   (OutcomeAutopilotService, WatchListPanel, …)
 *
 * The former per-trade price-alert layer (Entry/TP/SL thresholds with
 * notifications and quiet hours) was removed: nothing in production could
 * create an alert anymore (createAlert had zero callers), so its latching,
 * queuing, and notification paths were unreachable dead code.
 *
 * On native platforms the WebSocket/polling loop is paused on `pause` and
 * resumed on `resume` via @capacitor/app.
 */

import { Capacitor } from '@capacitor/core';

class PriceAlertServiceClass {
    private ws: WebSocket | null = null;
    private prices: Map<string, number> = new Map();
    private pollingInterval: ReturnType<typeof setInterval> | null = null;
    private wsReconnectAttempts = 0;
    /** Last price accepted per symbol — identical consecutive ticks are
     *  deduped (the Binance ticker repeats its close across frames). */
    private lastTickPrices = new Map<string, number>();
    // Tracked so pause()/stopMonitoring() can cancel a pending reconnect —
    // an untracked timer would reopen the socket (and its monitoring loop)
    // after the user backgrounded the app.
    private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private maxReconnectAttempts = 5;
    private isPaused = false; // true when app is backgrounded
    private nativeListenersRegistered = false;
    /** Lowercase symbols actually present in the OPEN combined-stream URL.
     *  The stream list is baked at connect time — comparing the needed set
     *  against it is what lets ensureMonitoring detect a stale-but-OPEN
     *  socket and rebuild it (Tier-0 #5: symbols armed mid-session used to
     *  never receive ticks until an unrelated socket flap). */
    private streamSymbols = new Set<string>();
    // Consumers can hook the same real-time price feed instead of opening
    // their own socket/poll loop.
    private priceSubscribers: Set<(symbol: string, price: number) => void> = new Set();
    // Non-alert consumers that need the feed running even with nothing
    // tracked (setup watches). Monitoring stops only when holders and
    // tracked symbols are both 0.
    private externalMonitorHolders = 0;
    // Symbols that must stay in the feed (setup watches, live-price
    // refresh). Merged into the WebSocket stream list and the polling loop
    // so ticks reach emitPriceTick for them.
    private trackedSymbols: Map<string, number> = new Map();

    constructor() {
        // Wire native app lifecycle (pause/resume) so we stop the
        // WebSocket + polling loop when the app is backgrounded and restart
        // it on resume. This saves battery and prevents WebView throttling
        // from causing stale prices.
        this.registerNativeLifecycle();
    }

    /**
     * Register Capacitor App pause/resume listeners (native only).
     * No-op on web.
     */
    private async registerNativeLifecycle(): Promise<void> {
        if (this.nativeListenersRegistered) return;
        try {
            if (!Capacitor.isNativePlatform()) return;
            const { App } = await import('@capacitor/app');
            App.addListener('appStateChange', ({ isActive }) => {
                if (isActive) {
                    this.resume();
                } else {
                    this.pause();
                }
            });
            this.nativeListenersRegistered = true;
        } catch (err) {
            console.warn('[PriceAlertService] Native lifecycle not registered:', err);
        }
    }

    /**
     * Pause all monitoring (called on app background).
     */
    pause(): void {
        if (this.isPaused) return;
        this.isPaused = true;
        console.log('[PriceAlertService] Paused (backgrounded)');
        // Close the WebSocket — it would be throttled by the WebView anyway.
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
    }

    /**
     * Resume monitoring (called on app foreground).
     */
    resume(): void {
        if (!this.isPaused) return;
        this.isPaused = false;
        console.log('[PriceAlertService] Resumed (foregrounded)');
        if (this.externalMonitorHolders > 0 || this.trackedSymbols.size > 0) {
            this.ensureMonitoring();
        }
    }

    /**
     * Initialize the service for a profile. The per-trade alert storage this
     * used to hydrate was removed as dead code, so the remaining work is
     * registering the native pause/resume lifecycle. The `username` parameter
     * is kept for call-site compatibility (useUserProfileLoader).
     */
    async init(username?: string): Promise<void> {
        void username;
        await this.registerNativeLifecycle();
    }

    /**
     * Profile switch: drop the tracked-symbol ref-counts and stop the feed
     * (audit §2.5 — the ref-counts of the OUTGOING profile's feed holds must
     * not survive the switch; the autopilot releases its own around this
     * call, and a leaked count would strand the old user's symbols in every
     * later stream).
     */
    reset(): void {
        this.trackedSymbols.clear();
        this.stopMonitoring();
    }

    /**
     * Subscribe to raw price ticks for every monitored symbol. The callback
     * receives (symbol, price) on each WebSocket message / polling tick for
     * any symbol the service is currently tracking. Returns an unsubscribe
     * function. Consumers that need ticks while nothing is tracked must also
     * hold the feed via acquireMonitor().
     */
    subscribePrices(callback: (symbol: string, price: number) => void): () => void {
        this.priceSubscribers.add(callback);
        return () => this.priceSubscribers.delete(callback);
    }

    /**
     * Declare that an external consumer needs the price feed running even
     * with nothing tracked (e.g. setup watches pre-create). Returns a
     * release function — the feed stops once the last holder releases and no
     * symbols remain tracked.
     */
    acquireMonitor(): () => void {
        this.externalMonitorHolders++;
        this.ensureMonitoring();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.externalMonitorHolders = Math.max(0, this.externalMonitorHolders - 1);
            this.maybeStopMonitoring();
        };
    }

    /**
     * Stop monitoring only when no external holders or tracked symbols need it.
     */
    private maybeStopMonitoring(): void {
        if (this.externalMonitorHolders === 0 && this.trackedSymbols.size === 0) {
            this.stopMonitoring();
        }
    }

    /**
     * Get current price for a symbol
     */
    getCurrentPrice(symbol: string): number | undefined {
        return this.prices.get(symbol);
    }

    /**
     * Register a symbol that must stay in the price feed (setup watches,
     * veto ledger). Ref-counted: several consumers may track the same
     * symbol, and one consumer releasing must not drop the feed for the
     * others. Starts monitoring on first holder.
     */
    trackSymbol(symbol: string): boolean {
        const normalized = this.normalizeSymbol(symbol);
        if (!normalized) return false;
        const count = this.trackedSymbols.get(normalized) ?? 0;
        this.trackedSymbols.set(normalized, count + 1);
        if (count > 0) return false;
        this.ensureMonitoring();
        return true;
    }

    /**
     * Release one tracking claim on a symbol. The symbol leaves the feed
     * only when the LAST holder releases. Monitoring stops only when
     * holders and tracked symbols are both gone.
     */
    untrackSymbol(symbol: string): boolean {
        const normalized = this.normalizeSymbol(symbol);
        const count = this.trackedSymbols.get(normalized) ?? 0;
        if (count <= 0) return false;
        if (count > 1) {
            this.trackedSymbols.set(normalized, count - 1);
            return false;
        }
        this.trackedSymbols.delete(normalized);
        this.maybeStopMonitoring();
        return true;
    }

    /**
     * Ref-counted symbol hold with a release function (mirrors
     * acquireMonitor). The OutcomeAutopilotService wraps each registration's
     * subscribeTicks window in one of these so autopilot-only coins actually
     * receive ticks — without a symbol hold, getCurrentPrice stayed empty
     * forever and the tick episodes silently never accumulated.
     */
    acquireSymbol(symbol: string): () => void {
        this.trackSymbol(symbol);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.untrackSymbol(symbol);
        };
    }

    /**
     * Start monitoring prices via WebSocket
     */
    private ensureMonitoring(): void {
        if (this.externalMonitorHolders === 0 && this.trackedSymbols.size === 0) return;
        // Don't start monitoring while backgrounded — resume() will
        // call this again on foreground.
        if (this.isPaused) return;

        // Use polling for Capacitor/mobile compatibility
        if (!this.pollingInterval) {
            this.startPolling();
        }

        // Also try WebSocket for faster updates
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connectWebSocket();
            return;
        }

        // Socket is OPEN — but the combined-stream URL was baked at connect
        // time, so symbols added mid-session never arrive (Tier-0 #5).
        // Rebuild the stream whenever a needed symbol is missing from it.
        // Removals are deliberately NOT a rebuild trigger: an extra streamed
        // symbol is harmless, and closing on every untrack would cause
        // reconnect churn.
        const needed = this.neededStreamSymbols();
        for (const symbol of needed) {
            if (!this.streamSymbols.has(symbol)) {
                console.log('[PriceAlertService] Tracked set changed while OPEN — rebuilding combined stream');
                this.closeSocketQuietly();
                this.connectWebSocket();
                break;
            }
        }
    }

    /** Every symbol that must be in the live feed, lower cased for the
     *  Binance stream URL. */
    private neededStreamSymbols(): Set<string> {
        return new Set([
            ...Array.from(this.trackedSymbols.keys()).map(s => s.toLowerCase()),
        ]);
    }

    /** True when the OPEN socket's stream covers everything we need right now
     *  (the polling loop uses this to decide it may stand down). */
    private streamIsCurrent(): boolean {
        for (const symbol of this.neededStreamSymbols()) {
            if (!this.streamSymbols.has(symbol)) return false;
        }
        return true;
    }

    /**
     * Detach every handler from the current socket and drop the reference
     * BEFORE it is replaced or closed. Without this, a stale onclose from
     * the old socket can schedule a reconnect over (or flap) the healthy
     * replacement — and the old socket kept re-entering acceptTick after
     * we considered it gone.
     */
    private closeSocketQuietly(): void {
        const ws = this.ws;
        this.ws = null;
        this.streamSymbols = new Set();
        if (!ws) return;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
            ws.close();
        } catch { /* already closing/closed */ }
    }

    /**
     * Connect to Binance WebSocket
     */
    private connectWebSocket(): void {
        try {
            const symbols = [...this.neededStreamSymbols()];
            if (symbols.length === 0) return;

            // Drop any previous socket's handlers before the reference is
            // replaced (its onclose must never touch the new one).
            this.closeSocketQuietly();

            const streams = symbols.map(s => `${s}@ticker`).join('/');
            const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

            this.ws = new WebSocket(url);
            this.streamSymbols = new Set(symbols);

            this.ws.onopen = () => {
                console.log('[PriceAlertService] WebSocket connected');
                this.wsReconnectAttempts = 0;
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.data && data.data.s && data.data.c) {
                        const symbol = data.data.s; // e.g., BTCUSDT
                        const price = parseFloat(data.data.c); // Current price
                        this.acceptTick(symbol, price);
                    }
                } catch (e) {
                    console.error('[PriceAlertService] WebSocket message error:', e);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[PriceAlertService] WebSocket error:', error);
            };

            this.ws.onclose = () => {
                console.log('[PriceAlertService] WebSocket closed');
                // Attempt reconnect — but NEVER while backgrounded: pause()
                // closes the socket, and close() fires onclose asynchronously,
                // so without this guard a backgrounded app re-spawns the
                // socket (and the poll) five seconds later.
                if (this.isPaused) return;
                // externalMonitorHolders MUST be in this guard: a consumer
                // that only monitors prices (zero tracked symbols of its own)
                // could never recover a flapped socket because nothing armed
                // the reconnect.
                const needsFeed = this.externalMonitorHolders > 0
                    || this.trackedSymbols.size > 0;
                if (needsFeed && this.wsReconnectAttempts < this.maxReconnectAttempts) {
                    this.wsReconnectAttempts++;
                    this.wsReconnectTimer = setTimeout(() => {
                        this.wsReconnectTimer = null;
                        this.connectWebSocket();
                    }, 5000 * this.wsReconnectAttempts);
                }
            };
        } catch (error) {
            console.error('[PriceAlertService] Failed to connect WebSocket:', error);
        }
    }

    /**
     * One price observation from any source (WS or poll). Dedupes identical
     * ticks — Binance's ticker repeats the same close price across frames,
     * and re-running the subscriber fan-out for an unchanged number is pure
     * waste.
     */
    private acceptTick(symbol: string, price: number): void {
        if (!Number.isFinite(price) || price <= 0) return;
        if (this.lastTickPrices.get(symbol) === price) return;
        this.lastTickPrices.set(symbol, price);
        this.prices.set(symbol, price);
        this.emitPriceTick(symbol, price);
    }

    /**
     * Start polling as fallback. The interval stays cheap while the
     * WebSocket is healthy (it returns without fetching) and takes over the
     * moment the socket drops — so the poll is a true fallback, not a
     * parallel second feed. Symbols are fetched in ONE batched request
     * instead of one sequential fetch per symbol.
     */
    private startPolling(): void {
        // One request at a time. The body is async inside setInterval, so a
        // stalled or geo-blocked exchange used to spawn a fresh hanging fetch
        // every 10s for the whole session — and responses could land out of
        // order, letting an older tick overwrite a newer one in acceptTick.
        let inFlight = false;
        this.pollingInterval = setInterval(async () => {
            if (inFlight) return;
            if (this.isPaused) return;
            // WS healthy AND its stream covers every needed symbol → the
            // socket is the feed; skip the poll. An OPEN-but-stale stream
            // (symbols added mid-session before the rebuild landed) must NOT
            // silence the poll — that early-return was half of Tier-0 #5.
            if (this.ws && this.ws.readyState === WebSocket.OPEN && this.streamIsCurrent()) return;
            const symbols = [...new Set([
                ...Array.from(this.trackedSymbols.keys()),
            ])];
            if (symbols.length === 0) return;

            inFlight = true;
            try {
                const query = symbols.map(s => `"${s}"`).join(',');
                // Timed below the 10s cadence so a stalled exchange cannot
                // outlive the tick that is waiting on it.
                const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${query}]`, {
                    signal: AbortSignal.timeout(9000),
                });
                if (!response.ok) return;
                const data = await response.json();
                const rows = Array.isArray(data) ? data : [data];
                for (const row of rows) {
                    const symbol = typeof row?.symbol === 'string' ? row.symbol : null;
                    const price = typeof row?.price === 'string' ? parseFloat(row.price) : NaN;
                    if (symbol && Number.isFinite(price)) this.acceptTick(symbol, price);
                }
            } catch (e) {
                console.error(`[PriceAlertService] Batched poll error (${symbols.length} symbols):`, e);
            } finally {
                inFlight = false;
            }
        }, 10000); // Poll every 10 seconds
    }

    /**
     * Stop all monitoring
     */
    private stopMonitoring(): void {
        this.closeSocketQuietly();
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        this.wsReconnectAttempts = 0;
        // Forget the dedup memory: the next monitoring start must fan out its
        // first tick even if the price never changed while we were stopped.
        this.lastTickPrices.clear();
    }

    /**
     * Notify external price-feed subscribers of a fresh tick.
     */
    private emitPriceTick(symbol: string, price: number): void {
        this.priceSubscribers.forEach(callback => {
            try {
                callback(symbol, price);
            } catch (e) {
                console.error('[PriceAlertService] Price subscriber error:', e);
            }
        });
    }

    /**
     * Normalize coin symbol to Binance format
     */
    normalizeSymbol(coinName: string): string {
        const cleaned = coinName.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return cleaned.includes('USDT') ? cleaned : `${cleaned}USDT`;
    }
}

// Singleton export
export const PriceAlertService = new PriceAlertServiceClass();
