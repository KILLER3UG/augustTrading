/**
 * KlineService - Candlestick (kline) data fetching.
 *
 * PRIMARY source: Binance USDT-FUTURES klines (fapi) — the SAME market as the
 * Analyze surface's markPrice@1s websocket, funding/OI, and the hybrid packet.
 * The desk is a perps desk: chart history from the SPOT market made the
 * painted candles deviate from the live mark on moving symbols (the
 * spot↔perp basis read as a price move). fapi sends
 * `Access-Control-Allow-Origin: *`, so the browser calls it directly; on
 * failure the request races the fapi/fapi1/fapi2 mirrors.
 *
 * DEGRADED FALLBACK: the SPOT mirror chain (data-api.binance.vision + CORS
 * proxies) — a DIFFERENT market whose candles can deviate from the perp
 * feed. Used only when fapi itself is unreachable from the browser, and
 * logged as degraded when it wins.
 *
 * All functions return a standardized Kline[] (time in milliseconds, OHLCV).
 *
 * SOURCE TAGGING: `fetchKlinesTagged` reports WHICH market answered
 * (futures / spot-mirror / unavailable) so a consumer feeding the model can
 * disclose a degraded read on its receipt; `fetchKlines` keeps the bare
 * candles for the UI consumers that paint what they fetch.
 */

import { Kline } from '../../types';
import { coerceCandles } from '../../utils/candleShape';

// --- Short-TTL cache + in-flight coalescing ---
// Chart mounts/polls re-race up to 4 proxy sources per fetch; a short TTL and
// shared promise dedupe concurrent identical requests (mirrors
// MarketDataService's pattern). The TTL is CANDLE-ALIGNED, not wall-clock:
// a closed bar never changes, so a series fetched mid-bar stays valid until
// THAT bar closes — the only volatile row is the forming one, and it stops
// being servable the moment its close prints.
const klineCache = new Map<string, { at: number; ttl: number; data: Kline[] }>();
const klineInFlight = new Map<string, Promise<TaggedKlines>>();
const KLINE_CACHE_TTL_MS = 30_000;
/** The ceiling of a candle-aligned TTL: even a 1h series is re-read at most
 *  this often, so a symbol left on screen cannot pin a mid-hour snapshot. */
const KLINE_CACHE_MAX_TTL_MS = 300_000;
const KLINE_CACHE_MAX = 200;

/** Candle-aligned freshness (ms) for one interval at `now`: the time left
 *  before the CURRENT bar of that interval closes. 5m/15m/1h align to their
 *  boundary (capped at KLINE_CACHE_MAX_TTL_MS); slower or unknown intervals
 *  keep the flat wall-clock bound, which is strictly no worse than the old
 *  fixed 30s. The 5s floor stops a read in a bar's last seconds from pinning
 *  a bar that is about to print its close. */
export const candleAlignedTtlMs = (interval: string, now: number): number => {
    const span = INTERVAL_MS[interval];
    if (!span || span > 60 * 60_000) return KLINE_CACHE_TTL_MS;
    const remaining = span - (now % span);
    return Math.max(5_000, Math.min(remaining, KLINE_CACHE_MAX_TTL_MS));
};

const INTERVAL_MS: Record<string, number> = {
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
};

/** Expired sweep + insertion-ordered eviction on WRITE. The map used to grow
 *  without bound (one entry per symbol × interval × limit, each up to 1000
 *  candle objects) across a long-lived desktop session — the same failure
 *  DeskToolsService's tool cache already caps (TOOL_CACHE_MAX). */
const trimKlineCache = (): void => {
    const now = Date.now();
    for (const [key, entry] of klineCache) {
        if (now - entry.at >= entry.ttl) klineCache.delete(key);
    }
    while (klineCache.size > KLINE_CACHE_MAX) {
        const oldest = klineCache.keys().next().value;
        if (oldest === undefined) break;
        klineCache.delete(oldest);
    }
};

// --- Binance interval mapping ---
// Binance klines are case-sensitive: daily/weekly are lowercase
// ('1d','3d','1w') but MONTHLY is a CAPITAL '1M' (a lowercase '1m' is
// 1-MINUTE). The app's timeframe tokens use '1D','3D','1W','1M'
// (TradingChart.CHART_INTERVALS), so map the multi-day ones here —
// normalizing in ONE place means no caller has to `.toLowerCase()` and
// silently turn the monthly chart into a 1-minute one. Spot and futures
// klines share the interval tokens.
const BINANCE_INTERVALS: Record<string, string> = {
    '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h',
    '1D': '1d', '3D': '3d', '1W': '1w', '1M': '1M',
};

/** App timeframe token → Binance interval. Exported: the kline WEBSOCKET
 *  stream suffix (useFuturesLiveFeed) subscribes with the SAME tokens, and
 *  every other caller must go through this instead of `.toLowerCase()` —
 *  '1M'.toLowerCase() is '1m', which silently turns the monthly chart into a
 *  1-minute one. Unmapped tokens pass through unchanged. */
export const mapBinanceInterval = (interval: string): string => BINANCE_INTERVALS[interval] || interval;

// --- Core fetch helper ---

interface FetchSource {
    url: string;
    timeout: number;
}

/**
 * Fetch a URL with an abort-based timeout. Returns the parsed JSON body, or
 * throws on network error / non-OK status / timeout.
 */
const fetchJson = async (source: FetchSource): Promise<any> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), source.timeout);

    try {
        const response = await fetch(source.url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Status ${response.status}`);
        }

        // Parse via text to tolerate proxies that wrap/alter the payload.
        const text = await response.text();
        return JSON.parse(text);
    } finally {
        window.clearTimeout(timeoutId);
    }
};

/**
 * Parse Binance-style kline payload (array of arrays:
 * [time, open, high, low, close, volume, ...]) into standardized Kline[].
 * Time is preserved in milliseconds. Spot (/api/v3) and futures (/fapi/v1)
 * klines share this array layout.
 */
const parseBinanceKlines = (data: any): Kline[] => {
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
        return data.map((d: any[]) => ({
            time: d[0],
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
        }));
    }
    return [];
};

/**
 * Race all sources in parallel and resolve with the first VALID kline payload.
 * The old serial chain let a single slow source add its full timeout to the
 * critical path (worst case 27s+ for the Binance chain); with a parallel race
 * the fastest healthy source wins and the rest are abandoned (their abort
 * timers still fire, releasing the sockets). All sources share one parser, so
 * the first non-empty payload is a valid drop-in result. Resolves [] when
 * every source fails.
 */
const fetchKlinesFromSources = async (
    sources: FetchSource[],
    parse: (data: any) => Kline[],
    label: string,
): Promise<Kline[]> => {
    const attempts = sources.map(async (source) => {
        const data = await fetchJson(source);
        const klines = parse(data);
        // Shape gate (utils/candleShape): a candle that violates its own OHLC
        // is a broken row, not a quiet market. Drop it NAMED, and treat an
        // all-incoherent payload as a failed source so the race tries the
        // next mirror — an empty market must never masquerade as data.
        const { kept, dropped } = coerceCandles(klines);
        if (dropped > 0) {
            console.warn(`[KlineService] ${label}: dropped ${dropped} incoherent candle(s) (OHLC shape)`);
        }
        if (kept.length === 0) throw new Error('no usable candles in payload');
        return kept;
    });

    try {
        return await Promise.any(attempts);
    } catch {
        // Every source rejected or returned an empty payload.
        console.error(`All fetch attempts failed for ${label}`);
        return [];
    }
};

// --- PRIMARY: Binance futures klines (fapi, browser-direct) ---

const FUTURES_HOSTS = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
];

const buildFuturesSources = (symbol: string, interval: string, limit: number): FetchSource[] => {
    const binanceInterval = mapBinanceInterval(interval);
    return FUTURES_HOSTS.map(host => ({
        url: `${host}/fapi/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`,
        timeout: 8000,
    }));
};

// --- DEGRADED FALLBACK: Binance SPOT mirror chain (direct + CORS proxies) ---

const buildBinanceSources = (symbol: string, interval: string, limit: number): FetchSource[] => {
    const binanceInterval = mapBinanceInterval(interval);
    const publicUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
    const targetUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;

    return [
        // Binance Vision often allows CORS directly - try it first with a short timeout.
        { url: publicUrl, timeout: 3000 },
        { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}&t=${Date.now()}`, timeout: 8000 },
        { url: `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`, timeout: 8000 },
        { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, timeout: 8000 },
    ];
};

/**
 * Fetch klines for the perp chart: futures (fapi) first, spot mirror chain as
 * the labeled degraded fallback. Returns standardized Kline[] (time in ms),
 * or [] if both fail.
 *
 * `noCache` bypasses the 30 s read cache for periodic re-syncs (the live
 * watchdog / 15 s chart refresh) — without it the TTL halves their cadence
 * and can serve a just-closed bar its pre-close OHLC for up to 30 s. Fresh
 * results still land IN the cache (other consumers benefit either way).
 *
 * CACHE DOCTRINE: the cache key carries the SOURCE market. Spot-mirror
 * candles used to land under the same key as native futures data (with only
 * a console.warn at fetch time), so within the 30 s TTL a later native read
 * could be served — or poison — the OTHER market's candles; on symbols with
 * real basis the chart would silently flip between two instruments. Futures
 * results live under `kline_f_*`, degraded spot-mirror results under
 * `kline_s_*`, and total-failure empty results (source-agnostic) under
 * `kline_e_*`. Reads prefer native, then degraded. In-flight coalescing
 * stays source-agnostic because the fetch itself always tries futures first.
 */
/** WHICH market answered a kline read. `futures` is the perp itself; a
 *  `spot-mirror` result is the DEGRADED fallback — a different instrument
 *  whose candles can deviate from the perp mark (the spot↔perp basis reads
 *  as a price move). Every consumer that hands candles to the model must
 *  carry this tag through to its receipt, or the degraded read silently
 *  feeds perp analysis (open-items O-63). */
export type KlineFeedSource = 'futures' | 'spot-mirror' | 'unavailable';

export interface TaggedKlines {
    candles: Kline[];
    source: KlineFeedSource;
}

/** The one receipt line a desk tool prints when its candles came from the
 *  spot mirror. Pure so check:contracts pins the wording; `null` for the
 *  native and unavailable sources (the unavailable case gets its own
 *  DATA_UNAVAILABLE receipt — never an implied-empty one). */
export const spotMirrorSourceNote = (source: KlineFeedSource): string | null => {
    if (source === 'spot-mirror') {
        return 'CANDLE SOURCE: SPOT MIRROR — the futures kline feed was unreachable, so these candles are the SPOT market and can deviate from the perp mark (basis, wicks, volume). Treat levels and wick reads from them as approximate; prefer the packet, the live mark and the order book for exact prices.';
    }
    return null;
};

export const fetchKlinesTagged = async (
    symbol: string,
    interval: string,
    limit: number = 300,
    opts?: { noCache?: boolean },
): Promise<TaggedKlines> => {
    const inFlightKey = `kline_${symbol}_${interval}_${limit}`;
    const futuresKey = `kline_f_${symbol}_${interval}_${limit}`;
    const spotKey = `kline_s_${symbol}_${interval}_${limit}`;
    const failedKey = `kline_e_${symbol}_${interval}_${limit}`;

    const freshEntry = (key: string): Kline[] | null => {
        const cached = klineCache.get(key);
        return cached && Date.now() - cached.at < cached.ttl ? cached.data : null;
    };

    if (!opts?.noCache) {
        const native = freshEntry(futuresKey);
        if (native) return { candles: native, source: 'futures' };
        const spot = freshEntry(spotKey);
        if (spot && spot.length > 0) return { candles: spot, source: 'spot-mirror' };
        const failed = freshEntry(failedKey);
        if (failed) return { candles: failed, source: 'unavailable' };
    }
    const inFlight = klineInFlight.get(inFlightKey);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<TaggedKlines> => {
        try {
            // PRIMARY: the futures market itself — same instrument the user
            // trades, same basis as the markPrice@1s feed and the packet.
            const data = await fetchKlinesFromSources(
                buildFuturesSources(symbol, interval, limit),
                parseBinanceKlines,
                `${symbol} ${interval} (futures)`,
            );
            if (data.length > 0) {
                klineCache.set(futuresKey, { at: Date.now(), ttl: candleAlignedTtlMs(interval, Date.now()), data });
                trimKlineCache();
                return { candles: data, source: 'futures' };
            }
            console.warn(
                `[KlineService] futures klines unavailable for ${symbol} ${interval} — DEGRADED to the SPOT mirror chain; candles may deviate from the perp feed`,
            );
            const spotData = await fetchKlinesFromSources(
                buildBinanceSources(symbol, interval, limit),
                parseBinanceKlines,
                `${symbol} ${interval} (spot fallback)`,
            );
            // The degraded market gets its OWN key — a later native success
            // must never be served from (or serve) this entry.
            klineCache.set(spotData.length > 0 ? spotKey : failedKey, { at: Date.now(), ttl: candleAlignedTtlMs(interval, Date.now()), data: spotData });
            trimKlineCache();
            return spotData.length > 0
                ? { candles: spotData, source: 'spot-mirror' }
                : { candles: spotData, source: 'unavailable' };
        } finally {
            klineInFlight.delete(inFlightKey);
        }
    })();
    klineInFlight.set(inFlightKey, promise);
    return promise;
};

/** Untagged read for the UI consumers that PAINT what they fetch (the chart
 *  and the live market panel render the candles they get, so the user sees
 *  the fallback for themselves). Every consumer that hands candles to the
 *  MODEL goes through `fetchKlinesTagged` instead and discloses the source. */
export const fetchKlines = async (
    symbol: string,
    interval: string,
    limit: number = 300,
    opts?: { noCache?: boolean },
): Promise<Kline[]> => (await fetchKlinesTagged(symbol, interval, limit, opts)).candles;
