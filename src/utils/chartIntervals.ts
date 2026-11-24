/**
 * The chart's timeframe vocabulary — pure data, in a util so the agent-side
 * services can read it without importing a component.
 *
 * `chatTurnRunner` needs the bar length in seconds to anchor drawings, and it
 * used to import `intervalSeconds` from `TradingChart`. That made a service
 * depend on a component at runtime: the bundler had to pull the chart (and
 * lightweight-charts) into a path that never draws one. The vocabulary lives
 * here instead; the component imports it like any other reader.
 */

/** Every timeframe Binance klines serve — the pool the user picks from. */
export const CHART_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1D', '3D', '1W', '1M'] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

/** The bar's default selection — the set the toolbar shipped with before it
 *  became customizable (TradingView-style: pick which intervals appear). */
export const DEFAULT_CHART_INTERVALS: readonly ChartInterval[] = ['1m', '5m', '15m', '1h', '4h', '1D'];

/** Canonical composer timeframe ladder derived from CHART_INTERVALS. */
export const COMPOSER_TIMEFRAMES: readonly ChartInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'];

/** Canonical kline-API interval subsets for desk tool JSON schemas. */
export const KLINE_INTERVALS_5M_TO_1H: readonly string[] = ['5m', '15m', '1h'];
export const KLINE_INTERVALS_15M_TO_4H: readonly string[] = ['15m', '1h', '4h'];
export const KLINE_INTERVALS_15M_TO_1D: readonly string[] = ['15m', '1h', '4h', '1d'];
export const KLINE_INTERVALS_5M_TO_4H: readonly string[] = ['5m', '15m', '1h', '4h'];
export const KLINE_INTERVALS_5M_TO_1D: readonly string[] = ['5m', '15m', '1h', '4h', '1d'];
export const KLINE_INTERVALS_ALL_INTRADAY_1D: readonly string[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

/** KlineService/Binance interval strings for each supported timeframe. */
const KLINE_OF: Partial<Record<ChartInterval, string>> = { '1D': '1d', '3D': '3d', '1W': '1w' };

/** Chart timeframe → Binance kline interval. Never lowercase: '1M' is the
 *  monthly, and lowercasing it would silently request 1-minute bars. */
export const toKlineInterval = (interval: ChartInterval): string => KLINE_OF[interval] ?? interval;

/** Bar length in SECONDS for each timeframe — the drawings' data-space ruler. */
const INTERVAL_SECONDS: Record<ChartInterval, number> = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
    '1D': 86400, '3D': 259200, '1W': 604800, '1M': 2592000,
};

export const intervalSeconds = (interval: ChartInterval): number => INTERVAL_SECONDS[interval] ?? 900;
