/**
 * exchangeEndpoints — the ONE registry of exchange REST/WS endpoints.
 *
 * Every market-data service reads its hosts from here. A service that mints
 * its own `https://fapi.binance.com` literal is how one exchange ended up
 * spelled five ways across the codebase, with failover chains that drifted
 * apart. The chains keep their exact order (first entry = primary), and the
 * PRIMARY of each chain can be repointed by an env var (Vite
 * `import.meta.env`) so a self-hosted or proxied deployment can reroute the
 * app without a code edit; the failover mirrors stay the real exchange hosts.
 *
 * SECURITY/BEHAVIOUR PINS that live here on purpose:
 *  - The futures chain is PROD-ONLY. A testnet host must never re-enter it:
 *    on a geo-block the prod hosts 451 while a testnet happily answers 200
 *    with SYNTHETIC prices that would then be cached and served as "live".
 */

type Env = Record<string, string | undefined>;

const env: Env = (import.meta as { env?: Env }).env ?? {};

/** Primary-host env override; trailing slashes trimmed so path joins stay exact. */
const primary = (key: string, fallback: string): string => {
    const raw = env[key]?.trim();
    return raw ? raw.replace(/\/+$/, '') : fallback;
};

/** Binance USD-M futures REST — prod hosts only, primary first. */
export const BINANCE_FUTURES_REST_BASES: readonly string[] = [
    primary('VITE_BINANCE_FUTURES_API', 'https://fapi.binance.com'),
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
];

/** Binance spot REST failover chain — the Vision data mirror last. */
export const BINANCE_SPOT_REST_BASES: readonly string[] = [
    primary('VITE_BINANCE_API', 'https://api.binance.com'),
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://data-api.binance.vision',
];

/** Binance public spot data mirror (CORS-friendly; also the kline fallback). */
export const BINANCE_SPOT_DATA_BASE = primary('VITE_BINANCE_SPOT_DATA', 'https://data-api.binance.vision');

/** Binance WebSocket streams — futures (mark/kline/ticker) and spot. */
export const BINANCE_FUTURES_WS = primary('VITE_BINANCE_FUTURES_WS', 'wss://fstream.binance.com');
export const BINANCE_SPOT_WS = primary('VITE_BINANCE_SPOT_WS', 'wss://stream.binance.com:9443');

/** CORS-proxy bases for the DEGRADED spot-mirror kline path (order matters). */
export const CORS_PROXY_ALLORIGINS = 'https://api.allorigins.win/raw';
export const CORS_PROXY_CORSPROXY = 'https://corsproxy.io/';
export const CORS_PROXY_CODETABS = 'https://api.codetabs.com/v1/proxy';

/** Deribit public API (volatility index context). */
export const DERIBIT_API_BASE = primary('VITE_DERIBIT_API', 'https://www.deribit.com');

/** OKX public API (signal market data). */
export const OKX_API_BASE = primary('VITE_OKX_API', 'https://www.okx.com');

/** CoinGecko public API (global market caps for correlation risk). */
export const COINGECKO_API_BASE = primary('VITE_COINGECKO_API', 'https://api.coingecko.com/api/v3');

/** DuckDuckGo instant-answer & HTML lite search bases (keyless web search). */
export const DUCKDUCKGO_API_BASE = primary('VITE_DUCKDUCKGO_API', 'https://api.duckduckgo.com');
export const DUCKDUCKGO_HTML_BASE = primary('VITE_DUCKDUCKGO_HTML', 'https://html.duckduckgo.com');

/** Canonical fallback symbol/interval when no active workspace symbol/tf exists. */
export const DEFAULT_SYMBOL = 'BTCUSDT';
export const DEFAULT_INTERVAL = '15m';
export const FALLBACK_MAJOR_SYMBOLS: readonly string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
