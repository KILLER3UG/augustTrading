/**
 * MarketDataService - Real-time market data from Binance
 * Provides OHLCV, current price, and funding rate data
 */

// Using fetch directly instead of ccxt for better browser/mobile compatibility
import { coerceCandles } from '../../utils/candleShape';

const BINANCE_API_BASE = 'https://api.binance.com';
const BINANCE_FUTURES_API = 'https://fapi.binance.com';

// Simple in-memory cache with eviction
const cache: Map<string, { data: any; timestamp: number }> = new Map();
const CACHE_TTL = 30000; // 30 seconds
// mark/index is THE live price the chart streams at 1s (markPrice@1s). Caching
// it for the full 30s made every "Live mark" line in the model's packet lag
// the painted chart — the gap read as a fresh price move ("discrepancy
// flagged"). Keep it near-stream-fresh; the endpoint is one cheap symbol call.
const LIVE_MARK_TTL = 2000;
// The other single-symbol point-in-time reads. They sat on the generic 30s
// TTL, which stacked with the packet's own cache and the desk-tool cache to
// put 40-60s between the tape and what the model called "current" — and then
// a confirming tool call replayed the same 30s snapshot, so the model could
// not tell a quiet market from a cached one. These endpoints are one cheap
// symbol call each; the 30s default stays on kline SERIES, where the weight
// is real and a 15m indicator genuinely does not care about 30s.
const POINT_IN_TIME_TTL = 5000;

/** Per-attempt give-up budget for the point-in-time reads a SURFACE polls: the
 *  order-book ladder, mark/index, 24 h ticker. robustFuturesFetch walks the
 *  three mirror hosts SEQUENTIALLY, so this multiplies by three in the worst
 *  case -- and on the generic 15 s default a hung primary host put 15-45 s
 *  inside a single fetch, which chained ahead of the caller's own 5 s wait. The
 *  order book therefore refreshed every 20 s or worse while its badge said
 *  "REST poll every 5s". A healthy round trip is under a second, so 4 s absorbs
 *  a slow network without lying about cadence. Kline series, screeners and
 *  history keep the 15 s default, where the payload really can be slow. */
const POINT_IN_TIME_FETCH_MS = 4000;

// In-flight dedupe for fetchOHLCVFromTime — concurrent identical requests
// share one promise instead of fanning out N identical Binance calls.
const inFlightOHLCV: Map<string, Promise<Kline[]>> = new Map();
const MAX_CACHE_SIZE = 100; // Maximum number of cached entries

export interface Kline {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    /** Taker-buy base-asset volume (Binance kline field 9) — the REAL delta
     *  input for the CVD studies. Set by the kline parsers below; absent on
     *  synthetic rows and pre-CVD cached pages. */
    takerBuyVolume?: number;
}

export interface MarketData {
    symbol: string;
    currentPrice: number;
    price24hHigh: number;
    price24hLow: number;
    priceChange24h: number;
    priceChangePercent24h: number;
    volume24h: number;
    fundingRate?: number;
    /** False means the response is a fallback/placeholder, not a live observation. */
    available?: boolean;
}

/**
 * Derivatives market data from Binance Futures API (PUBLIC - No API Key Required)
 */
export interface DerivativesData {
    // Open Interest
    openInterest: number;              // OI in contracts
    openInterestValue: number;         // OI in USDT
    oiChange24h: number;               // % change in OI over 24h (approximated)

    // Long/Short Account Ratio (Global)
    longShortRatio: {
        longAccount: number;           // % of accounts that are long
        shortAccount: number;          // % of accounts that are short
        ratio: number;                 // long/short ratio
        sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
    };

    // Top Trader Long/Short Ratio
    topTraderRatio: {
        longAccount: number;
        shortAccount: number;
        ratio: number;
        sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
    };

    // Taker Buy/Sell Volume Ratio
    takerBuySell: {
        buyVolume: number;
        sellVolume: number;
        ratio: number;                 // buy/sell ratio
        pressure: 'strong_buying' | 'buying' | 'neutral' | 'selling' | 'strong_selling';
    };

    // --- Positioning TREND (the conviction/crowding the snapshot can't show) ---
    // Funding-rate history (most recent first): a streak of same-sign funding
    // tells the model the crowd is one-sided BEFORE it squeezes.
    fundingHistory?: { t: number; rate: number }[];
    fundingStreak?: number;            // consecutive same-sign periods (signed: + longs paying)
    // Open-interest history: OI rising into a move = fresh money (real
    // conviction); OI falling = the move is short-covering / weak.
    oiHistory?: { t: number; oi: number; value: number }[];
    oiChangePct?: number;              // % change over the history window
    // Spot–futures basis history: a blowout premium flags crowded leverage.
    basis?: { t: number; basis: number; basisRate: number }[];
    basisRateNow?: number;             // latest annualized-ish basis rate %

    // Combined sentiment analysis
    overallSentiment: 'very_bullish' | 'bullish' | 'neutral' | 'bearish' | 'very_bearish';
    sentimentScore: number;            // -100 to +100

    dataTimestamp: string;
    available?: boolean;
}

/**
 * Order Book Depth data - Shows buy/sell walls and liquidity
 */
export interface OrderBookData {
    // Top bid/ask levels
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPercent: number;

    // Raw price/qty ladders (best-first) for a DOM order-book column.
    bids: { price: number; qty: number }[];
    asks: { price: number; qty: number }[];

    // Aggregated depth (within 1% of current price)
    bidDepth: number;              // Total bid volume within 1%
    askDepth: number;              // Total ask volume within 1%
    depthImbalance: number;        // (bid - ask) / (bid + ask), ranges -1 to +1

    // Major walls (significant order clusters)
    buyWalls: { price: number; quantity: number; usdValue: number }[];
    sellWalls: { price: number; quantity: number; usdValue: number }[];

    /**
     * Microstructure read over the top 5 levels — LIVE-ONLY by nature (an
     * order book has no history to backtest; it must never enter a training
     * sample). `microprice` is the size-weighted mid (the standard
     * P_b·Q_a + P_a·Q_b over Q_b+Q_a): a heavy bid side pulls the fair
     * price toward the ask. `top5Imbalance` is (bidQty − askQty)/(sum) over
     * the five best levels each side. Absent (undefined) when the ladder
     * came back empty.
     */
    micro?: {
        microprice: number;
        top5BidQty: number;
        top5AskQty: number;
        top5Imbalance: number;
        note: 'live-only — no historical depth, never a training feature';
    };

    // Analysis
    dominantSide: 'buyers' | 'sellers' | 'balanced';
    wallDistance: {
        nearestBuyWall?: { price: number; distance: number };
        nearestSellWall?: { price: number; distance: number };
    };
    available?: boolean;
}

/**
 * Recent Liquidation data - Shows forced position closures
 *
 * `unavailableReason` distinguishes the two ways this block can come back
 * empty, which the surfaces used to conflate into one forever-N/A branch:
 * - 'source_retired': Binance removed the public forceOrders endpoints — the
 *   data will NEVER arrive, prompts must say so instead of hinting "quiet
 *   market".
 * - 'fetch_failed': transient transport/endpoint failure (or was, before the
 *   retirement latch) — a later call may still succeed.
 * A SUCCESSFUL fetch with zero events in the hour keeps available:true and
 * reads "Low liquidation activity — stable market": "no recent liquidations"
 * is a real observation, "source retired" is not data.
 */
export interface LiquidationData {
    // Recent liquidations (last hour)
    recentLongLiquidations: number;    // USD value
    recentShortLiquidations: number;   // USD value
    totalRecentLiquidations: number;   // Combined

    // Liquidation events (last 10)
    recentEvents: {
        side: 'LONG' | 'SHORT';
        price: number;
        quantity: number;
        usdValue: number;
        timestamp: string;
    }[];

    // Analysis
    dominantLiquidations: 'longs' | 'shorts' | 'balanced';
    liquidationPressure: 'high' | 'medium' | 'low';
    sentiment: string; // e.g., "Heavy long liquidations - bearish pressure"
    available?: boolean;
    unavailableReason?: 'source_retired' | 'fetch_failed';
}

/**
 * Normalize symbol format for Binance API
 * Handles various input formats: BTC, BTCUSDT, BTC/USDT, btc
 */
export const normalizeSymbol = (input: string): string => {
    let symbol = input.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // If it doesn't end with USDT, add it
    if (!symbol.endsWith('USDT') && !symbol.endsWith('BUSD')) {
        symbol = symbol + 'USDT';
    }

    return symbol;
};

/**
 * Get cached data or fetch new
 */
const getCached = <T>(key: string, ttlMs: number = CACHE_TTL): T | null => {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttlMs) {
        return cached.data as T;
    }
    return null;
};

const setCache = (key: string, data: any): void => {
    // Evict expired entries first
    if (cache.size >= MAX_CACHE_SIZE) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.timestamp >= CACHE_TTL) {
                cache.delete(k);
            }
        }
    }
    // If still over limit, evict oldest entries
    if (cache.size >= MAX_CACHE_SIZE) {
        const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, Math.ceil(MAX_CACHE_SIZE * 0.25)); // Remove oldest 25%
        for (const [k] of toRemove) {
            cache.delete(k);
        }
    }
    cache.set(key, { data, timestamp: Date.now() });
};

/**
 * True when any numeric leaf of a plain data object/array is NaN/Infinity.
 * Used to refuse caching poisoned analyses (a NaN from an empty book side
 * once propagated through wall detection and into the 30s cache).
 */
const containsNonFinite = (value: unknown): boolean => {
    if (typeof value === 'number') return !Number.isFinite(value);
    if (Array.isArray(value)) return value.some(containsNonFinite);
    if (value && typeof value === 'object') return Object.values(value).some(containsNonFinite);
    return false;
};

// List of available Binance API endpoints to try
const BINANCE_ENDPOINTS = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://data-api.binance.vision' // Fallback data API (usually works when others fail)
];

// List of available Binance Futures API endpoints to try.
// NO testnet here: testnet.binancefuture.com used to sit at the end of this
// chain as a "last resort", but on a geo-block (451 on the prod hosts) the
// testnet happily answers 200 with SYNTHETIC prices — which were then cached
// 30s and served to the model and the desk as "live" mark/funding/OI. A wrong
// price labeled live is worse than a failed fetch, so the prod path must only
// ever talk to the real futures hosts.
const BINANCE_FUTURES_ENDPOINTS = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
];

/**
 * Robust fetch helper that tries multiple Binance endpoints
 * Handles SSL certificate errors by falling back to working endpoints
 */
const robustBinanceFetch = async (apiPath: string, timeoutMs: number = 10000): Promise<Response> => {
    let lastError: Error | null = null;
    let lastStatus: number | null = null;

    for (const baseUrl of BINANCE_ENDPOINTS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(`${baseUrl}${apiPath}`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                return response;
            } else {
                lastStatus = response.status;
                console.warn(`[MarketDataService] ${baseUrl} returned ${response.status}, trying next...`);
            }
        } catch (error) {
            lastError = error as Error;
            console.warn(`[MarketDataService] Failed with ${baseUrl}, trying next...`);
            // Continue to next endpoint
        }
    }

    if (lastStatus) {
        throw new Error(`Binance API error: ${lastStatus}`);
    }

    throw lastError || new Error('All Binance API endpoints failed');
};

/**
 * Sliding-window budget for Binance Futures calls, so a runaway loop can't
 * trip 429s. Binance's real limit is request WEIGHT (2400/min per IP) and these
 * endpoints cost 1-10 each, so a cap counted in requests only has to catch a
 * stuck loop -- it must not throttle ordinary traffic.
 *
 * Measured in the running app, steady state with one chart open and no
 * analysis running: ~65 futures calls/min (mark + ticker on the feed cadence,
 * klines, and the derivatives/ratios block). The old cap of 40 therefore sat
 * permanently saturated during any burst, and because the wait below booked a
 * slot after a fixed 5 s whether or not one had freed, every price read --
 * mark, ticker, depth -- paid 5 s of latency it never needed, while the heavy
 * kline calls fell through to the CORS-blocked mirror hosts. 120 leaves ~2x
 * headroom over normal traffic: still low enough to bound request WEIGHT (the
 * kline calls cost 10 each, so 120/min stays inside Binance's 2400) while no
 * longer throttling the surface that is just trying to show a price.
 */
const FUTURES_MAX_REQUESTS_PER_MINUTE = 120;
/** Ceiling on waiting for a slot. Past it the request goes anyway: starving
 *  the live price strip is the worse failure, and Binance's weight limit is the
 *  actual authority. */
const FUTURES_SLOT_MAX_WAIT_MS = 1500;
const futuresRequestTimes: number[] = [];

const acquireFuturesSlot = async (): Promise<void> => {
    const deadline = Date.now() + FUTURES_SLOT_MAX_WAIT_MS;
    for (;;) {
        const now = Date.now();
        while (futuresRequestTimes.length > 0 && futuresRequestTimes[0] < now - 60_000) futuresRequestTimes.shift();
        if (futuresRequestTimes.length < FUTURES_MAX_REQUESTS_PER_MINUTE || now >= deadline) {
            futuresRequestTimes.push(now);
            return;
        }
        // Re-check until a slot genuinely frees, instead of sleeping a fixed
        // 5 s and booking regardless -- which grew the window without bound
        // while making every caller pay the stall.
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, deadline - now)));
    }
};

/**
 * Robust fetch helper for Binance Futures API
 * Tries multiple futures endpoints to handle CORS/SSL issues
 * Enhanced with better error handling and logging
 */
const robustFuturesFetch = async (apiPath: string, timeoutMs: number = 15000): Promise<Response> => {
    await acquireFuturesSlot();
    let lastError: Error | null = null;
    let lastStatus: number | null = null;

    for (const baseUrl of BINANCE_FUTURES_ENDPOINTS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const fullUrl = `${baseUrl}${apiPath}`;

            console.log(`[MarketDataService] Trying Futures endpoint: ${fullUrl}`);

            const response = await fetch(fullUrl, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json'
                }
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                console.log(`[MarketDataService] Success with ${baseUrl}`);
                return response;
            } else {
                lastStatus = response.status;
                console.warn(`[MarketDataService] ${baseUrl} returned ${response.status}, trying next...`);
            }
        } catch (error) {
            lastError = error as Error;
            console.warn(`[MarketDataService] Futures API failed with ${baseUrl}:`, (error as Error).message);
            // Continue to next endpoint
        }
    }

    // If we got a specific HTTP error, throw more info
    if (lastStatus) {
        throw new Error(`All Binance Futures endpoints failed with status: ${lastStatus}`);
    }

    // FIX: Always throw if we reach here (all endpoints failed without HTTP status)
    throw lastError || new Error('All Binance Futures endpoints failed');
};

/**
 * Ping Binance API to check connectivity
 * Uses multiple endpoints and retries for robustness
 */
export const pingBinanceAPI = async (): Promise<boolean> => {
    // Helper to try a single endpoint with timeout
    const tryEndpoint = async (baseUrl: string): Promise<boolean> => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout per attempt

            const response = await fetch(`${baseUrl}/api/v3/ping`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            return response.ok;
        } catch (error) {
            return false;
        }
    };

    // Try endpoints in sequence (or could be parallel race if speed is critical)
    // We try up to 3 different endpoints before giving up
    for (let i = 0; i < 3; i++) {
        // Pick a random endpoint to distribute load and avoid a single down server
        const endpoint = BINANCE_ENDPOINTS[Math.floor(Math.random() * BINANCE_ENDPOINTS.length)];
        const success = await tryEndpoint(endpoint);
        if (success) return true;

        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.warn('[MarketDataService] All Binance ping attempts failed.');
    return false;
};

/**
 * Fetch OHLCV (candlestick) data from Binance
 * @param symbol - Trading pair (e.g., 'BTCUSDT')
 * @param timeframe - Candle interval ('1m', '5m', '15m', '1h', '4h', '1d')
 * @param limit - Number of candles to fetch (default 100)
 */
/** Shared row parser — spot (/api/v3) and futures (/fapi/v1) klines have the
 *  identical array layout, so both fetchers map through this. */
const toKlines = (data: any[][]): Kline[] => data.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    takerBuyVolume: Number.isFinite(parseFloat(k[9])) ? parseFloat(k[9]) : undefined
}));

/** The OHLC shape gate (utils/candleShape) at THIS service's boundary. This
 *  is the third ingestion path: KlineService (chart/desk tape) and
 *  signalMarketData (resolver tape) already gate their payloads, but every
 *  candle this service hands to runKeyLevels, runIndicators, the packet and
 *  the outcome verifiers used to skip the rule entirely. A broken row is
 *  dropped NAMED; an all-incoherent payload yields [] which every caller
 *  must treat as a failed fetch, not as an empty market. */
const gateCandles = (rows: Kline[], label: string): Kline[] => {
    const { kept, dropped } = coerceCandles(rows);
    if (dropped > 0) console.warn(`[MarketDataService] ${label}: dropped ${dropped} incoherent candle(s) (OHLC shape)`);
    return kept;
};

export const fetchOHLCV = async (
    symbol: string,
    timeframe: string = '1h',
    limit: number = 100
): Promise<Kline[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `ohlcv_${normalizedSymbol}_${timeframe}_${limit}`;

    const cached = getCached<Kline[]>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustBinanceFetch(`/api/v3/klines?symbol=${normalizedSymbol}&interval=${timeframe}&limit=${limit}`);
        const data = await response.json();

        const klines = gateCandles(toKlines(data), `spot klines ${normalizedSymbol} ${timeframe}`);

        setCache(cacheKey, klines);
        return klines;
    } catch (error) {
        console.error(`Failed to fetch OHLCV for ${normalizedSymbol}:`, error);
        throw error;
    }
};

/**
 * Futures OHLCV — same contract as fetchOHLCV but on /fapi/v1. The Trade
 * surface is a perpetuals desk: every packet/candle the model reasons about
 * must come from the same market as the chart's mark feed, or the spot↔perp
 * basis reads as a fresh price move.
 */
export const fetchFuturesOHLCV = async (
    symbol: string,
    timeframe: string = '1h',
    limit: number = 100
): Promise<Kline[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `futohlcv_${normalizedSymbol}_${timeframe}_${limit}`;

    const cached = getCached<Kline[]>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/fapi/v1/klines?symbol=${normalizedSymbol}&interval=${timeframe}&limit=${limit}`);
        const data = await response.json();

        const klines = gateCandles(toKlines(data), `futures klines ${normalizedSymbol} ${timeframe}`);

        setCache(cacheKey, klines);
        return klines;
    } catch (error) {
        console.error(`Failed to fetch futures OHLCV for ${normalizedSymbol}:`, error);
        throw error;
    }
};

/**
 * Futures 24h ticker — the perp counterpart of fetchMarketData. Field names
 * in /fapi/v1/ticker/24hr match the spot response, so the MarketData shape
 * is filled identically; only the market differs (and the market matters:
 * the chart's mark line, funding and OI are all perp-side).
 */
export const fetchFuturesTicker24h = async (symbol: string): Promise<MarketData> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `futmarket_${normalizedSymbol}`;

    const cached = getCached<MarketData>(cacheKey, POINT_IN_TIME_TTL);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/fapi/v1/ticker/24hr?symbol=${normalizedSymbol}`, POINT_IN_TIME_FETCH_MS);
        const data = await response.json();

        const marketData: MarketData = {
            symbol: normalizedSymbol,
            currentPrice: parseFloat(data.lastPrice),
            price24hHigh: parseFloat(data.highPrice),
            price24hLow: parseFloat(data.lowPrice),
            priceChange24h: parseFloat(data.priceChange),
            priceChangePercent24h: parseFloat(data.priceChangePercent),
            volume24h: parseFloat(data.quoteVolume),
            available: true
        };

        setCache(cacheKey, marketData);
        return marketData;
    } catch (error) {
        console.error(`Failed to fetch futures ticker for ${normalizedSymbol}:`, error);
        throw error;
    }
};

/**
 * Fetch OHLCV data starting from a specific timestamp
 * Used for historical verification of trade outcomes
 * @param symbol - Trading pair (e.g., 'BTCUSDT')
 * @param timeframe - Candle interval ('1m', '5m', '15m', '1h', '4h', '1d')
 * @param startTime - Unix timestamp in milliseconds to start from
 * @param endTime - Optional Unix timestamp in milliseconds to end at (defaults to now)
 */
export const fetchOHLCVFromTime = async (
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime?: number
): Promise<Kline[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const actualEndTime = endTime || Date.now();

    // Historical queries were never cached ("specific to timestamps") — with
    // several PENDING cards + the autopilot's 60s loop that's N×4-tier Binance
    // calls per minute for the SAME range. Key by minute-bucket so the 30s
    // cache actually dedupes poll cycles (a minute-old end time is immaterial
    // for 1m/15m/1h verification), and coalesce concurrent identical requests
    // through one shared promise.
    const endBucket = Math.floor(actualEndTime / 60_000) * 60_000;
    const cacheKey = `ohlcvfrom_${normalizedSymbol}_${timeframe}_${startTime}_${endBucket}`;

    const cached = getCached<Kline[]>(cacheKey);
    if (cached) return cached;
    const inFlight = inFlightOHLCV.get(cacheKey);
    if (inFlight) return inFlight;

    console.log(`[MarketDataService] Fetching historical klines for ${normalizedSymbol} from ${new Date(startTime).toISOString()} to ${new Date(actualEndTime).toISOString()}`);

    const promise = (async () => {
        try {
            const url = `/api/v3/klines?symbol=${normalizedSymbol}&interval=${timeframe}&startTime=${startTime}&endTime=${actualEndTime}&limit=1000`;
            const response = await robustBinanceFetch(url);
            const data = await response.json();

            const klines: Kline[] = gateCandles(data.map((k: any[]) => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                takerBuyVolume: Number.isFinite(parseFloat(k[9])) ? parseFloat(k[9]) : undefined
            })), `historical klines ${normalizedSymbol} ${timeframe}`);

            console.log(`[MarketDataService] Fetched ${klines.length} historical candles for ${normalizedSymbol}`);
            setCache(cacheKey, klines);
            return klines;
        } catch (error) {
            console.error(`Failed to fetch historical OHLCV for ${normalizedSymbol}:`, error);
            throw error;
        } finally {
            inFlightOHLCV.delete(cacheKey);
        }
    })();
    inFlightOHLCV.set(cacheKey, promise);
    return promise;
};

/**
 * Fetch OHLCV data from Binance FUTURES API starting from a specific timestamp
 * Used for accurate historical verification of perpetual futures trade outcomes
 * @param symbol - Trading pair (e.g., 'BTCUSDT')
 * @param timeframe - Candle interval ('1m', '5m', '15m', '1h', '4h', '1d')
 * @param startTime - Unix timestamp in milliseconds to start from
 * @param endTime - Optional Unix timestamp in milliseconds to end at (defaults to now)
 */
export const fetchFuturesOHLCVFromTime = async (
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime?: number
): Promise<Kline[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const actualEndTime = endTime || Date.now();

    // Mirror the spot twin's caching: the autopilot's 60s poll verifies every
    // PENDING trade through this endpoint, so N unresolved trades meant N×3
    // futures calls per minute against the same ranges — tripping the slot
    // budget and adding queue latency. Minute-bucket key + in-flight
    // coalescing dedupes poll cycles (a minute-old end time is immaterial for
    // 1m/15m/1h verification).
    const endBucket = Math.floor(actualEndTime / 60_000) * 60_000;
    const cacheKey = `futures_ohlcvfrom_${normalizedSymbol}_${timeframe}_${startTime}_${endBucket}`;

    const cached = getCached<Kline[]>(cacheKey);
    if (cached) return cached;
    const inFlight = inFlightOHLCV.get(cacheKey);
    if (inFlight) return inFlight;

    console.log(`[MarketDataService] Fetching FUTURES historical klines for ${normalizedSymbol} from ${new Date(startTime).toISOString()} to ${new Date(actualEndTime).toISOString()}`);

    const promise = (async () => {
        try {
            // Use Binance Futures API for perpetual contract prices
            const url = `/fapi/v1/klines?symbol=${normalizedSymbol}&interval=${timeframe}&startTime=${startTime}&endTime=${actualEndTime}&limit=1500`;
            const response = await robustFuturesFetch(url);
            const data = await response.json();

            const klines: Kline[] = gateCandles(data.map((k: any[]) => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                takerBuyVolume: Number.isFinite(parseFloat(k[9])) ? parseFloat(k[9]) : undefined
            })), `futures historical klines ${normalizedSymbol} ${timeframe}`);

            console.log(`[MarketDataService] Fetched ${klines.length} FUTURES historical candles for ${normalizedSymbol}`);
            setCache(cacheKey, klines);
            return klines;
        } catch (error) {
            console.error(`Failed to fetch Futures OHLCV for ${normalizedSymbol}:`, error);
            // NO silent SPOT fallback. This endpoint feeds OUTCOME
            // VERIFICATION: scoring a TP/SL hit against spot candles while
            // the trade was reasoned about perp prices can flip the verdict
            // on a basis-widening day (the same reason KlineService keys its
            // degraded spot chain separately). An empty result is honest —
            // the autopilot reports "cannot verify yet" and retries — while
            // a spot substitution resolved trades against the wrong
            // instrument with nothing on screen saying so.
            return [];
        } finally {
            inFlightOHLCV.delete(cacheKey);
        }
    })();
    inFlightOHLCV.set(cacheKey, promise);
    return promise;
};

/**
 * Fetch current price and 24h statistics
 */
export const fetchMarketData = async (symbol: string): Promise<MarketData> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `market_${normalizedSymbol}`;

    const cached = getCached<MarketData>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustBinanceFetch(`/api/v3/ticker/24hr?symbol=${normalizedSymbol}`);
        const data = await response.json();

        const marketData: MarketData = {
            symbol: normalizedSymbol,
            currentPrice: parseFloat(data.lastPrice),
            price24hHigh: parseFloat(data.highPrice),
            price24hLow: parseFloat(data.lowPrice),
            priceChange24h: parseFloat(data.priceChange),
            priceChangePercent24h: parseFloat(data.priceChangePercent),
            volume24h: parseFloat(data.quoteVolume),
            available: true
        };

        setCache(cacheKey, marketData);
        return marketData;
    } catch (error) {
        console.error(`Failed to fetch market data for ${normalizedSymbol}:`, error);
        throw error;
    }
};

/**
 * Fetch funding rate for perpetual futures.
 * Uses premiumIndex endpoint which is more reliable.
 * Returns `null` when the rate is UNAVAILABLE — a failure is not a neutral
 * read, and 0 is a legitimate funding rate (new pair, funding just settled),
 * so the two must never share a value: the derivatives digest used to print
 * "funding 0.0000" as fact during an outage.
 */
export const fetchFundingRate = async (symbol: string): Promise<number | null> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `funding_${normalizedSymbol}`;

    const cached = getCached<number>(cacheKey, POINT_IN_TIME_TTL);
    if (cached !== null) return cached;

    try {
        // Try premiumIndex first - it's more reliable and gives current funding rate
        const response = await robustFuturesFetch(`/fapi/v1/premiumIndex?symbol=${normalizedSymbol}`);
        const data = await response.json();

        // premiumIndex returns a single object with lastFundingRate. A 0 is a
        // LEGITIMATE funding rate (new pair, funding just settled) — only fall
        // through to the extra endpoint when the field is actually missing.
        const rawFundingRate = data?.lastFundingRate;
        const fundingRate = (typeof rawFundingRate === 'string' || typeof rawFundingRate === 'number')
            ? parseFloat(String(rawFundingRate))
            : NaN;

        if (!Number.isNaN(fundingRate)) {
            setCache(cacheKey, fundingRate);
            return fundingRate;
        }

        // Fallback: try the fundingRate endpoint (premiumIndex returned no field)
        console.log(`[MarketDataService] premiumIndex returned no funding rate, trying fundingRate endpoint...`);
        const fallbackResponse = await robustFuturesFetch(`/fapi/v1/fundingRate?symbol=${normalizedSymbol}&limit=1`);
        const fallbackData = await fallbackResponse.json();
        const fallbackRate = fallbackData.length > 0 ? parseFloat(fallbackData[0].fundingRate) : NaN;

        if (!Number.isNaN(fallbackRate)) {
            setCache(cacheKey, fallbackRate);
            return fallbackRate;
        }
        // Both endpoints answered without a usable rate — unknown, not zero.
        // (Not cached: `cached !== null` treats a stored null as a miss.)
        return null;
    } catch (error) {
        console.warn(`Failed to fetch funding rate for ${normalizedSymbol}:`, error);
        return null;
    }
};

/**
 * Mark / index price + funding clock from the SAME premiumIndex payload
 * fetchFundingRate already reads (it discarded these fields). The trade
 * surface's stats strip shows Mark and Oracle (index) like Minara's perps
 * header; nextFundingTime drives the countdown.
 */
export interface MarkIndexData {
    markPrice: number;
    indexPrice: number;
    lastFundingRate: number;
    nextFundingTime: number; // epoch ms
    available: boolean;
}

export const fetchMarkIndex = async (symbol: string): Promise<MarkIndexData> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `markindex_${normalizedSymbol}`;
    const cached = getCached<MarkIndexData>(cacheKey, LIVE_MARK_TTL);
    if (cached) return cached;
    const empty: MarkIndexData = { markPrice: 0, indexPrice: 0, lastFundingRate: 0, nextFundingTime: 0, available: false };
    try {
        const response = await robustFuturesFetch(`/fapi/v1/premiumIndex?symbol=${normalizedSymbol}`, POINT_IN_TIME_FETCH_MS);
        const data = await response.json();
        const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number') ? parseFloat(String(v)) : NaN;
        const markPrice = num(data?.markPrice);
        const indexPrice = num(data?.indexPrice);
        const result: MarkIndexData = {
            markPrice: Number.isFinite(markPrice) ? markPrice : 0,
            indexPrice: Number.isFinite(indexPrice) ? indexPrice : 0,
            lastFundingRate: Number.isFinite(num(data?.lastFundingRate)) ? num(data.lastFundingRate) : 0,
            nextFundingTime: Number.isFinite(num(data?.nextFundingTime)) ? num(data.nextFundingTime) : 0,
            available: Number.isFinite(markPrice) || Number.isFinite(indexPrice),
        };
        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch mark/index for ${normalizedSymbol}:`, error);
        return empty;
    }
};

/**
 * 24h stats for one USDT-perpetual symbol as returned by the public futures
 * ticker endpoint (/fapi/v1/ticker/24hr). Lives on as the base shape of
 * `SymbolMeta` below; the old zero-caller `fetchTopFuturesSymbols` wrapper
 * (a `topfutsymbols_<limit>` cached fetch) was removed in the 2026-09 audit
 * dead-code purge.
 */
export interface SymbolTicker {
    symbol: string;
    lastPrice: number;
    changePercent24h: number;
    quoteVolume: number;
}

/** One tradable USDT-perpetual in the symbol picker: ticker stats + the base
 *  asset (the description column) from exchangeInfo. The ticker endpoint
 *  alone misses zero-volume listings; exchangeInfo alone has no prices —
 *  the picker universe is their INTERSECTION, falling back to the traded
 *  set when exchangeInfo is unreachable. */
export interface SymbolMeta extends SymbolTicker {
    baseAsset: string;
}

export const fetchAllFuturesSymbols = async (): Promise<SymbolMeta[]> => {
    const cacheKey = 'allfutsymbols_v1';
    const cached = getCached<SymbolMeta[]>(cacheKey);
    if (cached) return cached;
    const [tickers, info] = await Promise.all([
        robustFuturesFetch('/fapi/v1/ticker/24hr').then(r => r.json()).catch(() => null),
        robustFuturesFetch('/fapi/v1/exchangeInfo').then(r => r.json()).catch(() => null),
    ]);
    if (!Array.isArray(tickers)) return [];
    // Only TRADING perpetuals quoted in USDT — the app's whole universe.
    const baseByName = new Map<string, string>();
    if (info && Array.isArray(info.symbols)) {
        for (const s of info.symbols) {
            if (s?.status === 'TRADING' && s?.contractType === 'PERPETUAL'
                && s?.quoteAsset === 'USDT' && typeof s.symbol === 'string') {
                baseByName.set(s.symbol, String(s.baseAsset ?? s.symbol.replace(/USDT$/, '')));
            }
        }
    }
    const fromTicker = (t: any, baseAsset: string): SymbolMeta => ({
        symbol: t.symbol,
        baseAsset,
        lastPrice: parseFloat(t.lastPrice) || 0,
        changePercent24h: parseFloat(t.priceChangePercent) || 0,
        quoteVolume: parseFloat(t.quoteVolume) || 0,
    });
    const rows: SymbolMeta[] = baseByName.size > 0
        ? (tickers as any[])
            .filter((t: any) => typeof t?.symbol === 'string' && baseByName.has(t.symbol))
            .map((t: any) => fromTicker(t, baseByName.get(t.symbol)!))
        : (tickers as any[])
            .filter((t: any) => typeof t?.symbol === 'string' && t.symbol.endsWith('USDT') && !/[_-]/.test(t.symbol))
            .map((t: any) => fromTicker(t, t.symbol.replace(/USDT$/, '')));
    rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
    if (rows.length > 0) setCache(cacheKey, rows);
    return rows;
};

/**
 * Fetch Open Interest from Binance Futures (PUBLIC - No API Key Required)
 */
export const fetchOpenInterest = async (symbol: string): Promise<{ oi: number; oiValue: number }> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `oi_${normalizedSymbol}`;

    const cached = getCached<{ oi: number; oiValue: number }>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/fapi/v1/openInterest?symbol=${normalizedSymbol}`);
        // robustFuturesFetch throws on non-ok responses

        const data = await response.json();
        const oi = parseFloat(data.openInterest) || 0;
        // OI is FUTURES contracts — valuing it at the SPOT last price made
        // openInterestValue a cross-market figure (the same mixing class as
        // the order book below). Price it at the futures mark; fall back to
        // the futures 24h last, then spot only if the perp feed is dead.
        let priceRef = 0;
        const mark = await fetchMarkIndex(normalizedSymbol);
        if (mark.available && mark.markPrice > 0) priceRef = mark.markPrice;
        if (!priceRef) {
            const futTicker = await fetchFuturesTicker24h(normalizedSymbol).catch(() => null);
            priceRef = futTicker?.currentPrice || 0;
        }
        if (!priceRef) {
            const spot = await fetchMarketData(normalizedSymbol).catch(() => null);
            priceRef = spot?.currentPrice || 0;
        }
        const result = {
            oi,
            oiValue: (oi * priceRef) || 0
        };

        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch OI for ${normalizedSymbol}:`, error);
        return { oi: 0, oiValue: 0 };
    }
};

/**
 * Fetch Global Long/Short Account Ratio (PUBLIC - No API Key Required)
 * Shows the ratio of accounts with net long vs short positions
 */
export const fetchLongShortRatio = async (symbol: string): Promise<{
    longAccount: number;
    shortAccount: number;
    ratio: number;
    sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
}> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `lsr_${normalizedSymbol}`;

    const cached = getCached<ReturnType<typeof fetchLongShortRatio> extends Promise<infer T> ? T : never>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/futures/data/globalLongShortAccountRatio?symbol=${normalizedSymbol}&period=5m&limit=1`);
        // robustFuturesFetch throws on non-ok responses

        const data = await response.json();
        if (!data || data.length === 0) {
            return { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' };
        }

        const latest = data[0];
        const longAccount = parseFloat(latest.longAccount) * 100;
        const shortAccount = parseFloat(latest.shortAccount) * 100;
        const ratio = parseFloat(latest.longShortRatio);

        // Determine sentiment based on ratio
        let sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
        if (ratio > 2) sentiment = 'extreme_long';
        else if (ratio > 1.2) sentiment = 'long_bias';
        else if (ratio < 0.5) sentiment = 'extreme_short';
        else if (ratio < 0.8) sentiment = 'short_bias';
        else sentiment = 'neutral';

        const result = { longAccount, shortAccount, ratio, sentiment };
        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch Long/Short ratio for ${normalizedSymbol}:`, error);
        return { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' };
    }
};

/**
 * Fetch Top Trader Long/Short Ratio (PUBLIC - No API Key Required)
 * Shows positioning of top traders by accounts
 */
export const fetchTopTraderRatio = async (symbol: string): Promise<{
    longAccount: number;
    shortAccount: number;
    ratio: number;
    sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
}> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `ttr_${normalizedSymbol}`;

    const cached = getCached<ReturnType<typeof fetchTopTraderRatio> extends Promise<infer T> ? T : never>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/futures/data/topLongShortAccountRatio?symbol=${normalizedSymbol}&period=5m&limit=1`);
        // robustFuturesFetch throws on non-ok responses

        const data = await response.json();
        if (!data || data.length === 0) {
            return { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' };
        }

        const latest = data[0];
        const longAccount = parseFloat(latest.longAccount) * 100;
        const shortAccount = parseFloat(latest.shortAccount) * 100;
        const ratio = parseFloat(latest.longShortRatio);

        let sentiment: 'extreme_long' | 'long_bias' | 'neutral' | 'short_bias' | 'extreme_short';
        if (ratio > 2) sentiment = 'extreme_long';
        else if (ratio > 1.2) sentiment = 'long_bias';
        else if (ratio < 0.5) sentiment = 'extreme_short';
        else if (ratio < 0.8) sentiment = 'short_bias';
        else sentiment = 'neutral';

        const result = { longAccount, shortAccount, ratio, sentiment };
        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch Top Trader ratio for ${normalizedSymbol}:`, error);
        return { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' };
    }
};

/**
 * Fetch Taker Buy/Sell Volume Ratio (PUBLIC - No API Key Required)
 * Shows aggressive buying vs selling pressure
 */
export const fetchTakerBuySellRatio = async (symbol: string): Promise<{
    buyVolume: number;
    sellVolume: number;
    ratio: number;
    pressure: 'strong_buying' | 'buying' | 'neutral' | 'selling' | 'strong_selling';
}> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `tbs_${normalizedSymbol}`;

    const cached = getCached<ReturnType<typeof fetchTakerBuySellRatio> extends Promise<infer T> ? T : never>(cacheKey);
    if (cached) return cached;

    try {
        const response = await robustFuturesFetch(`/futures/data/takerlongshortRatio?symbol=${normalizedSymbol}&period=5m&limit=1`);
        // robustFuturesFetch throws on non-ok responses

        const data = await response.json();
        if (!data || data.length === 0) {
            return { buyVolume: 0, sellVolume: 0, ratio: 1, pressure: 'neutral' };
        }

        const latest = data[0];
        const buyVolume = parseFloat(latest.buyVol) || 0;
        const sellVolume = parseFloat(latest.sellVol) || 0;
        const ratio = parseFloat(latest.buySellRatio) || 1;

        let pressure: 'strong_buying' | 'buying' | 'neutral' | 'selling' | 'strong_selling';
        if (ratio > 1.5) pressure = 'strong_buying';
        else if (ratio > 1.1) pressure = 'buying';
        else if (ratio < 0.67) pressure = 'strong_selling';
        else if (ratio < 0.9) pressure = 'selling';
        else pressure = 'neutral';

        const result = { buyVolume, sellVolume, ratio, pressure };
        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch Taker Buy/Sell for ${normalizedSymbol}:`, error);
        return { buyVolume: 0, sellVolume: 0, ratio: 1, pressure: 'neutral' };
    }
};

/**
 * Funding-rate HISTORY (public). The current rate is a snapshot; the streak
 * is the signal — many same-sign periods means the crowd is leaning one way
 * and paying to hold it, which precedes squeezes. Returns most-recent-first.
 */
export const fetchFundingRateHistory = async (
    symbol: string, limit = 21,
): Promise<{ t: number; rate: number }[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `fundhist_${normalizedSymbol}_${limit}`;
    const cached = getCached<{ t: number; rate: number }[]>(cacheKey);
    if (cached) return cached;
    try {
        const response = await robustFuturesFetch(`/fapi/v1/fundingRate?symbol=${normalizedSymbol}&limit=${limit}`);
        const data = await response.json();
        const rows = (Array.isArray(data) ? data : [])
            .map((r: any) => ({ t: Number(r.fundingTime), rate: parseFloat(r.fundingRate) }))
            .filter((r: { t: number; rate: number }) => Number.isFinite(r.t) && Number.isFinite(r.rate))
            .reverse(); // newest first
        setCache(cacheKey, rows);
        return rows;
    } catch (error) {
        console.warn(`Failed to fetch funding history for ${normalizedSymbol}:`, error);
        return [];
    }
};

/**
 * Open-interest HISTORY (public /futures/data/openInterestHist). OI trend
 * against price is the conviction read the snapshot lacks: rising OI + rising
 * price = new longs funding the move; falling OI + rising price = short
 * covering (weak). Returns oldest→newest for easy trend math.
 */
export const fetchOpenInterestHistory = async (
    symbol: string, period = '1h', limit = 24,
): Promise<{ t: number; oi: number; value: number }[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `oihist_${normalizedSymbol}_${period}_${limit}`;
    const cached = getCached<{ t: number; oi: number; value: number }[]>(cacheKey);
    if (cached) return cached;
    try {
        const response = await robustFuturesFetch(`/futures/data/openInterestHist?symbol=${normalizedSymbol}&period=${period}&limit=${limit}`);
        const data = await response.json();
        const rows = (Array.isArray(data) ? data : [])
            .map((r: any) => ({ t: Number(r.timestamp), oi: parseFloat(r.sumOpenInterest), value: parseFloat(r.sumOpenInterestValue) }))
            .filter((r: { t: number; oi: number }) => Number.isFinite(r.t) && Number.isFinite(r.oi));
        setCache(cacheKey, rows);
        return rows;
    } catch (error) {
        console.warn(`Failed to fetch OI history for ${normalizedSymbol}:`, error);
        return [];
    }
};

/**
 * Spot–futures BASIS history (public /futures/data/basis). The premium perps
 * trade over spot flags crowded leverage; a blowout is reversal risk. Returns
 * oldest→newest.
 */
export const fetchBasisHistory = async (
    symbol: string, period = '1h', limit = 24,
): Promise<{ t: number; basis: number; basisRate: number }[]> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `basis_${normalizedSymbol}_${period}_${limit}`;
    const cached = getCached<{ t: number; basis: number; basisRate: number }[]>(cacheKey);
    if (cached) return cached;
    try {
        const response = await robustFuturesFetch(`/futures/data/basis?symbol=${normalizedSymbol}&period=${period}&limit=${limit}`);
        const data = await response.json();
        const rows = (Array.isArray(data) ? data : [])
            .map((r: any) => ({ t: Number(r.timestamp), basis: parseFloat(r.basis), basisRate: parseFloat(r.basisRate) }))
            .filter((r: { t: number; basis: number }) => Number.isFinite(r.t) && Number.isFinite(r.basis));
        setCache(cacheKey, rows);
        return rows;
    } catch (error) {
        console.warn(`Failed to fetch basis for ${normalizedSymbol}:`, error);
        return [];
    }
};

/** Signed count of consecutive same-sign funding periods (newest first). */
const fundingStreakOf = (rows: { t: number; rate: number }[]): number => {
    if (rows.length === 0) return 0;
    const sign = Math.sign(rows[0].rate);
    if (sign === 0) return 0;
    let n = 0;
    for (const r of rows) { if (Math.sign(r.rate) === sign) n += 1; else break; }
    return sign * n;
};

/**
 * Fetch all derivatives data in one call
 * Combines Open Interest, Long/Short Ratios, and Taker Buy/Sell data
 */
export const fetchDerivativesData = async (symbol: string): Promise<DerivativesData> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `derivatives_${normalizedSymbol}`;

    const cached = getCached<DerivativesData>(cacheKey);
    if (cached) return cached;

    try {
        const [oi, lsr, ttr, tbs, fundingHistory, oiHistory, basisHistory] = await Promise.all([
            fetchOpenInterest(normalizedSymbol),
            fetchLongShortRatio(normalizedSymbol),
            fetchTopTraderRatio(normalizedSymbol),
            fetchTakerBuySellRatio(normalizedSymbol),
            fetchFundingRateHistory(normalizedSymbol).catch(() => [] as { t: number; rate: number }[]),
            fetchOpenInterestHistory(normalizedSymbol).catch(() => [] as { t: number; oi: number; value: number }[]),
            fetchBasisHistory(normalizedSymbol).catch(() => [] as { t: number; basis: number; basisRate: number }[]),
        ]);
        // OI % change over the history window (oldest→newest) — the conviction
        // read; 0 when there's no usable series.
        let oiChangePct = 0;
        if (oiHistory.length >= 2 && oiHistory[0].oi > 0) {
            oiChangePct = ((oiHistory[oiHistory.length - 1].oi - oiHistory[0].oi) / oiHistory[0].oi) * 100;
        }

        // Calculate overall sentiment score (-100 to +100)
        // Weight: Long/Short Ratio (30%), Top Trader (40%), Taker Buy/Sell (30%)
        let sentimentScore = 0;

        // Long/Short contribution
        const lsrScore = (lsr.ratio - 1) * 50; // 1 = neutral, 2 = +50, 0.5 = -25
        sentimentScore += lsrScore * 0.3;

        // Top Trader contribution (more weight to smart money)
        const ttrScore = (ttr.ratio - 1) * 50;
        sentimentScore += ttrScore * 0.4;

        // Taker Buy/Sell contribution
        const tbsScore = (tbs.ratio - 1) * 50;
        sentimentScore += tbsScore * 0.3;

        // Clamp to -100 to +100
        sentimentScore = Math.max(-100, Math.min(100, sentimentScore));

        // Determine overall sentiment
        let overallSentiment: DerivativesData['overallSentiment'];
        if (sentimentScore > 40) overallSentiment = 'very_bullish';
        else if (sentimentScore > 15) overallSentiment = 'bullish';
        else if (sentimentScore < -40) overallSentiment = 'very_bearish';
        else if (sentimentScore < -15) overallSentiment = 'bearish';
        else overallSentiment = 'neutral';

        const result: DerivativesData = {
            openInterest: oi.oi,
            openInterestValue: oi.oiValue,
            // The real 24h figure is computed below as oiChangePct from a
            // 24×1h history. A hard-coded 0 here printed "OI 24h: 0.0%" in the
            // prompt table immediately above the line carrying the actual
            // number, so the model's "conviction read" was a literal zero that
            // reads as a measurement. Same population, same source.
            oiChange24h: Math.round(oiChangePct * 100) / 100,
            longShortRatio: lsr,
            topTraderRatio: ttr,
            takerBuySell: tbs,
            fundingHistory,
            fundingStreak: fundingStreakOf(fundingHistory),
            oiHistory,
            oiChangePct: Math.round(oiChangePct * 100) / 100,
            basis: basisHistory,
            basisRateNow: basisHistory.length > 0 ? basisHistory[basisHistory.length - 1].basisRate : undefined,
            overallSentiment,
            sentimentScore: Math.round(sentimentScore),
            dataTimestamp: new Date().toISOString(),
            available: true
        };

        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.error(`Failed to fetch derivatives data for ${normalizedSymbol}:`, error);
        // Return neutral defaults
        return {
            openInterest: 0,
            openInterestValue: 0,
            oiChange24h: 0,
            longShortRatio: { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' },
            topTraderRatio: { longAccount: 50, shortAccount: 50, ratio: 1, sentiment: 'neutral' },
            takerBuySell: { buyVolume: 0, sellVolume: 0, ratio: 1, pressure: 'neutral' },
            overallSentiment: 'neutral',
            sentimentScore: 0,
            dataTimestamp: new Date().toISOString(),
            available: false
        };
    }
};

/**
 * Fetch Order Book Depth from Binance Futures (PUBLIC - No API Key Required)
 * Shows bid/ask walls and liquidity distribution
 */
export const fetchOrderBookDepth = async (symbol: string): Promise<OrderBookData> => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cacheKey = `orderbook_${normalizedSymbol}`;

    const cached = getCached<OrderBookData>(cacheKey, POINT_IN_TIME_TTL);
    if (cached) return cached;

    try {
        // Fetch futures order book (limit 100 for detailed depth)
        const response = await robustFuturesFetch(`/fapi/v1/depth?symbol=${normalizedSymbol}&limit=100`, POINT_IN_TIME_FETCH_MS);
        // robustFuturesFetch throws on non-ok responses

        const data = await response.json();

        // Reference price must live on the SAME market as the book. This used
        // to pull the SPOT ticker: the spread %, the ±1% depth window and the
        // wall distances were all measured against a different instrument
        // than the ladder they classify (same cross-market class the
        // futures-native packet fix closed — on moving symbols the
        // spot↔perp basis skewed every number). Use the futures MARK price
        // (premiumIndex, already fetched near-stream-fresh elsewhere in this
        // file); the book's own mid is the fallback when mark is unavailable.
        const mark = await fetchMarkIndex(normalizedSymbol);
        const markPrice = mark.available && mark.markPrice > 0 ? mark.markPrice : 0;

        // Parse bids and asks: [[price, quantity], ...]
        const bids: { price: number; qty: number }[] = data.bids.map((b: string[]) => ({
            price: parseFloat(b[0]),
            qty: parseFloat(b[1])
        }));

        const asks: { price: number; qty: number }[] = data.asks.map((a: string[]) => ({
            price: parseFloat(a[0]),
            qty: parseFloat(a[1])
        }));

        const bookMid = bids[0] && asks[0]
            ? (bids[0].price + asks[0].price) / 2
            : (bids[0]?.price ?? asks[0]?.price ?? 0);
        const refPrice = markPrice > 0 ? markPrice : bookMid;

        const bestBid = bids[0]?.price || refPrice;
        const bestAsk = asks[0]?.price || refPrice;
        const spread = bestAsk - bestBid;
        const spreadPercent = refPrice > 0 ? (spread / refPrice) * 100 : 0;

        // Calculate depth within 1% of the futures reference price
        const priceRange = refPrice * 0.01;
        const bidDepth = bids
            .filter(b => b.price >= refPrice - priceRange)
            .reduce((sum, b) => sum + (b.qty * b.price), 0);
        const askDepth = asks
            .filter(a => a.price <= refPrice + priceRange)
            .reduce((sum, a) => sum + (a.qty * a.price), 0);
        const depthImbalance = (bidDepth + askDepth) > 0
            ? (bidDepth - askDepth) / (bidDepth + askDepth)
            : 0;

        // Detect walls (orders > 3x average size). A side can legitimately be
        // empty on a one-sided book — dividing by bids.length/asks.length == 0
        // produced NaN, `qty >= NaN * 3` is false for every row, so all walls
        // on the OTHER side silently vanished and the NaN result got cached.
        const avgBidSize = bids.length > 0 ? bids.reduce((sum, b) => sum + b.qty, 0) / bids.length : 0;
        const avgAskSize = asks.length > 0 ? asks.reduce((sum, a) => sum + a.qty, 0) / asks.length : 0;

        const buyWalls = bids
            .filter(b => avgBidSize > 0 && b.qty >= avgBidSize * 3)
            .slice(0, 3)
            .map(b => ({ price: b.price, quantity: b.qty, usdValue: b.qty * b.price }));

        const sellWalls = asks
            .filter(a => avgAskSize > 0 && a.qty >= avgAskSize * 3)
            .slice(0, 3)
            .map(a => ({ price: a.price, quantity: a.qty, usdValue: a.qty * a.price }));

        // Determine dominant side
        const dominantSide: OrderBookData['dominantSide'] =
            depthImbalance > 0.15 ? 'buyers' :
                depthImbalance < -0.15 ? 'sellers' : 'balanced';

        // Calculate wall distances
        const wallDistance: OrderBookData['wallDistance'] = {};
        if (buyWalls.length > 0 && refPrice > 0) {
            wallDistance.nearestBuyWall = {
                price: buyWalls[0].price,
                distance: ((refPrice - buyWalls[0].price) / refPrice) * 100
            };
        }
        if (sellWalls.length > 0 && refPrice > 0) {
            wallDistance.nearestSellWall = {
                price: sellWalls[0].price,
                distance: ((sellWalls[0].price - refPrice) / refPrice) * 100
            };
        }

        // The microstructure read over the top 5 levels (see the interface
        // note): microprice is the size-weighted mid, top5Imbalance the
        // five-level depth skew.
        const top5BidQty = bids.slice(0, 5).reduce((s, b) => s + b.qty, 0);
        const top5AskQty = asks.slice(0, 5).reduce((s, a) => s + a.qty, 0);
        const micro: OrderBookData['micro'] = top5BidQty + top5AskQty > 0
            ? {
                microprice: (bestBid * top5AskQty + bestAsk * top5BidQty) / (top5BidQty + top5AskQty),
                top5BidQty,
                top5AskQty,
                top5Imbalance: (top5BidQty - top5AskQty) / (top5BidQty + top5AskQty),
                note: 'live-only — no historical depth, never a training feature',
            }
            : undefined;

        const result: OrderBookData = {
            bestBid,
            bestAsk,
            spread,
            spreadPercent,
            bids: bids.slice(0, 25),
            asks: asks.slice(0, 25),
            bidDepth,
            askDepth,
            depthImbalance,
            buyWalls,
            sellWalls,
            micro,
            dominantSide,
            wallDistance,
            available: true
        };

        // Never cache a NaN/Infinity-poisoned analysis — the whole point of
        // the guard above is that one bad number gets replayed for 30s and
        // empties the DOM wall column. Serve the honest default instead.
        if (containsNonFinite(result)) {
            console.warn(`[MarketDataService] order book for ${normalizedSymbol} contains non-finite numbers; not caching`);
            return getDefaultOrderBook();
        }

        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch order book for ${normalizedSymbol}:`, error);
        return getDefaultOrderBook();
    }
};

const getDefaultOrderBook = (): OrderBookData => ({
    bestBid: 0,
    bestAsk: 0,
    spread: 0,
    spreadPercent: 0,
    bids: [],
    asks: [],
    bidDepth: 0,
    askDepth: 0,
    depthImbalance: 0,
    buyWalls: [],
    sellWalls: [],
    dominantSide: 'balanced',
    wallDistance: {},
    available: false
});

/**
 * RETIRED-SOURCE LATCH for liquidations.
 *
 * Both public force-order endpoints the liquidations feature used are gone
 * from Binance: /fapi/v1/forceOrders is now signed-only (401 without an API
 * key + HMAC signature — a browser can never call it) and
 * /fapi/v1/allForceOrders was removed outright (404). Before this latch every
 * call burned ~8 serial endpoint attempts (4 futures hosts × 2 endpoints,
 * each with a 15s timeout budget) and returned the same forever-N/A object,
 * uncached — a permanent tax on autopilot loops and desk tools, with nobody
 * (including the model) told the source is dead rather than quiet.
 *
 * The first 401/403/404-class failure latches this for the lifetime of the
 * module; subsequent calls return the honest RETIRED result immediately with
 * zero network attempts. There is no per-call retry by design — a websocket
 * re-home (`!forceOrder@arr`) would be the replacement path, not polling
 * endpoints Binance deleted.
 *
 * 2026-09-16 WS re-home PROBE (kept RETIRED — the re-home stayed unbuildable
 * from this network): `wss://fstream.binance.com/ws/!forceOrder@arr` plus
 * the per-symbol `btcusdt@forceOrder` / `ethusdt@forceOrder` /
 * `solusdt@forceOrder` forms all completed the 101 handshake but delivered
 * ZERO frames across two 90 s windows — and crucially, so did every control
 * stream on the same host: `btcusdt@aggTrade` AND the 1 Hz
 * `btcusdt@markPrice@1s` THE APP'S OWN futures desk feed rides. The same
 * manual client against `stream.binance.com:9443` (spot trade stream)
 * received 530+ frames in 25 s and a generic echo server round-tripped.
 * So futures WS data (fstream.binance.com) is silently dropped at the
 * network layer here — liquidation sparsity cannot be distinguished from a
 * blocked feed, and "data flows" was never demonstrated. Per the audit's
 * rule the surface stays honestly retired; before building the ring-buffer
 * re-home, re-run the probe from a network where the desk shows 'live' (the
 * markPrice@1s control must produce frames) — if it does, !forceOrder@arr
 * will too.
 * RE-VERIFIED 2026-09-16 IN HEADLESS CHROMIUM (the app's own engine, via
 * Playwright — the one gap in the Node probe): identical verdict — fstream
 * markPrice@1s control 0 frames / 20 s, !forceOrder@arr + per-symbol
 * forceOrder 0 frames / 60 s, while the SPOT stream.binance.com trade feed
 * delivered 98 frames in the same 20 s. The block is specifically futures
 * WS at the network layer, not a Node artifact. (PriceAlertService is
 * unaffected — its socket rides the working spot host; the desk degrades to
 * fapi REST polling, which answers fine.)
 */
let liquidationsSourceUnavailable = false;

/** 401/403/404 from robustFuturesFetch means the endpoint itself is gone or
 *  locked — a permanent, source-level verdict. Timeouts/5xx/429 are NOT. */
const isRetiredSourceError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /status:\s*40[134]\b/.test(message);
};

/**
 * Fetch Recent Liquidations from Binance Futures
 * The public forceOrders endpoints were retired by Binance (see
 * liquidationsSourceUnavailable); this keeps the contract intact for any
 * future re-home while short-circuiting the dead path honestly.
 */
export const fetchRecentLiquidations = async (symbol: string): Promise<LiquidationData> => {
    const normalizedSymbol = normalizeSymbol(symbol);

    // Short-circuit FIRST — don't even read the cache, don't hammer.
    if (liquidationsSourceUnavailable) return getRetiredLiquidations();

    const cacheKey = `liquidations_${normalizedSymbol}`;

    const cached = getCached<LiquidationData>(cacheKey);
    if (cached) return cached;

    try {
        // Try fetching all recent force orders (without symbol - this is public)
        // Then filter for our symbol client-side
        let data: any[] = [];

        try {
            // First try with symbol (may fail without auth)
            const symbolResponse = await robustFuturesFetch(`/fapi/v1/forceOrders?symbol=${normalizedSymbol}&limit=50`);
            data = await symbolResponse.json();
            console.log(`[MarketDataService] Got ${(data || []).length} liquidations for ${normalizedSymbol}`);
        } catch (symbolError) {
            if (isRetiredSourceError(symbolError)) {
                liquidationsSourceUnavailable = true;
                console.warn(`[MarketDataService] Liquidations source RETIRED by Binance (forceOrders is signed-only/removed); latching off — no further attempts.`);
                return getRetiredLiquidations();
            }

            console.warn(`[MarketDataService] Symbol-specific liquidations failed, trying all liquidations...`);

            // Fallback: fetch all recent liquidations and filter
            try {
                const allResponse = await robustFuturesFetch(`/fapi/v1/allForceOrders?limit=100`);
                const allData = await allResponse.json();
                data = (allData || []).filter((o: any) => o.symbol === normalizedSymbol);
                console.log(`[MarketDataService] Filtered ${data.length} liquidations for ${normalizedSymbol} from all`);
            } catch (allError) {
                if (isRetiredSourceError(allError)) {
                    liquidationsSourceUnavailable = true;
                    console.warn(`[MarketDataService] Liquidations source RETIRED by Binance (allForceOrders removed); latching off — no further attempts.`);
                    return getRetiredLiquidations();
                }
                console.warn(`[MarketDataService] All liquidations fetch also failed:`, allError);
                // Return default with "data unavailable" note
                return getDefaultLiquidations();
            }
        }

        // Filter to last hour
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const recentOrders = (data || []).filter((o: any) => o.time >= oneHourAgo);

        const eventOf = (o: any): LiquidationData['recentEvents'][number] => {
            const side: 'LONG' | 'SHORT' = o.side === 'BUY' ? 'SHORT' : 'LONG'; // Buy to close = was short, Sell to close = was long
            const qty = parseFloat(o.origQty) || 0;
            const price = parseFloat(o.price) || 0;
            return {
                side,
                price,
                quantity: qty,
                usdValue: qty * price,
                timestamp: new Date(o.time).toISOString()
            };
        };

        // Totals cover the WHOLE last hour: the recentLong/ShortLiquidations
        // contract says "last hour", but the old code accumulated them inside
        // `.slice(0, 10).map()` — so the $10M/$1M pressure thresholds and the
        // dominant-side ratio compared against the 10 DISPLAYED events, not
        // the hour's flow. Sum over all events first; slice only for display.
        let recentLongLiquidations = 0;
        let recentShortLiquidations = 0;
        for (const o of recentOrders) {
            const { side, usdValue } = eventOf(o);
            if (side === 'LONG') recentLongLiquidations += usdValue;
            else recentShortLiquidations += usdValue;
        }

        const recentEvents: LiquidationData['recentEvents'] = recentOrders
            .slice(0, 10)
            .map(eventOf);

        const totalRecentLiquidations = recentLongLiquidations + recentShortLiquidations;

        // Determine dominant side
        const ratio = totalRecentLiquidations > 0
            ? recentLongLiquidations / totalRecentLiquidations
            : 0.5;
        const dominantLiquidations: LiquidationData['dominantLiquidations'] =
            ratio > 0.6 ? 'longs' : ratio < 0.4 ? 'shorts' : 'balanced';

        // Determine pressure level
        const liquidationPressure: LiquidationData['liquidationPressure'] =
            totalRecentLiquidations > 10000000 ? 'high' :
                totalRecentLiquidations > 1000000 ? 'medium' : 'low';

        // Generate sentiment string
        let sentiment = '';
        if (liquidationPressure === 'high') {
            sentiment = dominantLiquidations === 'longs'
                ? ' Heavy long liquidations — bearish pressure'
                : dominantLiquidations === 'shorts'
                    ? ' Heavy short liquidations — bullish squeeze'
                    : ' Mixed liquidations — volatile conditions';
        } else if (liquidationPressure === 'medium') {
            sentiment = dominantLiquidations === 'longs'
                ? 'Moderate long liquidations — bearish lean'
                : dominantLiquidations === 'shorts'
                    ? 'Moderate short liquidations — bullish lean'
                    : 'Balanced liquidations — neutral';
        } else {
            sentiment = 'Low liquidation activity — stable market';
        }

        const result: LiquidationData = {
            recentLongLiquidations,
            recentShortLiquidations,
            totalRecentLiquidations,
            recentEvents,
            dominantLiquidations,
            liquidationPressure,
            sentiment,
            available: true
        };

        setCache(cacheKey, result);
        return result;
    } catch (error) {
        console.warn(`Failed to fetch liquidations for ${normalizedSymbol}:`, error);
        return getDefaultLiquidations();
    }
};

const getDefaultLiquidations = (): LiquidationData => ({
    recentLongLiquidations: 0,
    recentShortLiquidations: 0,
    totalRecentLiquidations: 0,
    recentEvents: [],
    dominantLiquidations: 'balanced',
    liquidationPressure: 'low',
    sentiment: 'No liquidation data available',
    available: false,
    unavailableReason: 'fetch_failed'
});

/**
 * The honest RETIRED-source object: `available:false` keeps the existing
 * "N/A — do NOT infer" guard alive on every surface (the packet formatter,
 * desk tools and LiveMarket all key off it), while the sentiment text and
 * `unavailableReason` tell anyone who reads further that the silence is a
 * dead exchange endpoint, not a quiet market.
 */
const getRetiredLiquidations = (): LiquidationData => ({
    recentLongLiquidations: 0,
    recentShortLiquidations: 0,
    totalRecentLiquidations: 0,
    recentEvents: [],
    dominantLiquidations: 'balanced',
    liquidationPressure: 'low',
    sentiment: 'Liquidation data source RETIRED by Binance — the public forceOrders endpoints are signed-only/removed. Zero events here means "no data exists", NOT "no liquidations happened".',
    available: false,
    unavailableReason: 'source_retired'
});

/**
 * Test hook: clears the module-level caches and re-arms the liquidations
 * probe (same __reset*ForTests pattern used by notify/chatStore/watchService).
 */
export const __resetMarketDataForTests = (): void => {
    liquidationsSourceUnavailable = false;
    cache.clear();
    inFlightOHLCV.clear();
};

/**
 * Fetch complete market snapshot for a symbol
 * Includes price, OHLCV for multiple timeframes, and funding rate
 */
export const fetchCompleteMarketSnapshot = async (
    symbol: string
): Promise<{
    marketData: MarketData;
    klines: { '15m': Kline[]; '1h': Kline[]; '4h': Kline[]; '1d': Kline[] };
    /** null = the rate could not be fetched (an outage is not a settled 0%). */
    fundingRate: number | null;
    availability: {
        marketData: boolean;
        klines: { '15m': boolean; '1h': boolean; '4h': boolean; '1d': boolean };
        fundingRate: boolean;
    };
}> => {
    const normalizedSymbol = normalizeSymbol(symbol);

    console.log(`[MarketDataService] Fetching complete snapshot for ${normalizedSymbol}`);

    // Per-source degradation: a single flaky timeframe endpoint used to reject
    // the WHOLE packet (Promise.all), silently stripping calibration,
    // correlation, learning rules and validation from every analyst prompt for
    // the run. Timeframe klines + funding rate now degrade to empty/0 so the
    // rest of the packet survives; the core ticker (marketData) stays critical
    // because the packet cannot exist without it.
    //
    // All pulls are FUTURES (/fapi/v1): the packet is the perp desk's ground
    // truth and must share the market of the chart's markPrice@1s feed. Spot
    // sources made the packet diverge from the painted chart on moving symbols
    // (the spot↔perp basis read as a "discrepancy" the model narrated as a
    // fresh price move). If the futures ticker itself fails (unknown symbol),
    // fall back to the spot ticker so the packet still exists.
    const [futuresMarket, klines15m, klines1h, klines4h, klines1d, fundingRate] = await Promise.all([
        fetchFuturesTicker24h(normalizedSymbol).catch(err => { console.warn(`[MarketData] futures ticker failed, falling back to spot:`, err?.message || err); return null; }),
        fetchFuturesOHLCV(normalizedSymbol, '15m', 300).catch(err => { console.warn(`[MarketData] 15m klines failed, continuing without them:`, err?.message || err); return []; }),
        fetchFuturesOHLCV(normalizedSymbol, '1h', 300).catch(err => { console.warn(`[MarketData] 1h klines failed, continuing without them:`, err?.message || err); return []; }),
        fetchFuturesOHLCV(normalizedSymbol, '4h', 300).catch(err => { console.warn(`[MarketData] 4h klines failed, continuing without them:`, err?.message || err); return []; }),
        fetchFuturesOHLCV(normalizedSymbol, '1d', 300).catch(err => { console.warn(`[MarketData] 1d klines failed, continuing without them:`, err?.message || err); return []; }),
        fetchFundingRate(normalizedSymbol).catch(err => { console.warn(`[MarketData] funding rate failed, reporting unavailable:`, err?.message || err); return null; })
    ]);
    const marketData = futuresMarket ?? await fetchMarketData(normalizedSymbol);

    return {
        marketData,
        klines: {
            '15m': klines15m,
            '1h': klines1h,
            '4h': klines4h,
            '1d': klines1d
        },
        fundingRate,
        availability: {
            marketData: marketData.available !== false,
            klines: {
                '15m': klines15m.length > 0,
                '1h': klines1h.length > 0,
                '4h': klines4h.length > 0,
                '1d': klines1d.length > 0
            },
            // A zero rate can be valid; an outage is null. Report certainty
            // only when the rate actually arrived.
            fundingRate: fundingRate !== null
        }
    };
};

/**
 * Extract symbol from user prompt
 * Looks for common crypto symbols in the text
 */
export const extractSymbolFromPrompt = (prompt: string): string | null => {
    const upperPrompt = prompt.toUpperCase();

    // Common trading pairs to look for
    const commonSymbols = [
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
        'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT', 'LINKUSDT', 'ATOMUSDT',
        'LTCUSDT', 'UNIUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT',
        'PEPEUSDT', 'SHIBUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT',
        'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'MATIC'
    ];

    for (const symbol of commonSymbols) {
        if (upperPrompt.includes(symbol)) {
            return symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
        }
    }

    // Try to find pattern like "analyze X" or "X/USDT"
    const patterns = [
        /ANALYZE\s+([A-Z]{2,10})/i,
        /([A-Z]{2,10})\/USDT/i,
        /([A-Z]{2,10})\s+CHART/i,
        /([A-Z]{2,10})\s+ANALYSIS/i
    ];

    for (const pattern of patterns) {
        const match = upperPrompt.match(pattern);
        if (match && match[1]) {
            return match[1] + 'USDT';
        }
    }

    return null;
};
