/**
 * candleTtl — candle-aligned freshness, as pure math.
 *
 * A closed bar never changes; a forming one stops being servable the moment
 * its close prints. So the honest cache window for a kline-backed payload is
 * the time left before the CURRENT bar of its shortest interval closes — not
 * a wall-clock TTL that can serve a just-closed bar its pre-close OHLC.
 *
 * Consumers: KlineService (the fetch-layer cache) and DeskToolsService (the
 * desk tool cache's kline-backed stamped entries, via `klineBackedCacheTtlMs`).
 * One function, both layers — a second implementation is how the two caches
 * disagree about what "fresh" means.
 */

const INTERVAL_MS: Record<string, number> = {
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
};

const FLAT_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;
const FLOOR_MS = 5_000;

/** Candle-aligned freshness (ms) for one interval at `now`: the time left
 *  before the CURRENT bar of that interval closes. 5m/15m/1h align to their
 *  boundary (capped at 300s); slower or unknown intervals keep the flat
 *  wall-clock bound, which is strictly no worse than a fixed 30s. The 5s
 *  floor stops a read in a bar's last seconds from pinning a bar that is
 *  about to print its close. */
export const candleAlignedTtlMs = (interval: string, now: number): number => {
    const span = INTERVAL_MS[interval];
    if (!span || span > 60 * 60_000) return FLAT_TTL_MS;
    const remaining = span - (now % span);
    return Math.max(FLOOR_MS, Math.min(remaining, MAX_TTL_MS));
};
