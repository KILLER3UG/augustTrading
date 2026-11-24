/**
 * markPricePoll — the tiny Binance futures mark-price fetch shared by the two
 * harness watchers (watchService's price watches, levelWatchService's armed
 * plans). Both REST-poll off-view symbols every ~5s (Tier-0 #6: a watch armed
 * while the chart points at another coin used to never see a tick); this is
 * the only piece with identical semantics, so it lives here once.
 *
 * Deliberately tiny — importing MarketDataService would drag the whole
 * multi-provider market layer into every harness consumer bundle. The ~4s
 * abort keeps a stalled endpoint from piling up requests behind the 5s
 * throttle (and from hanging test workers). Returns null on any failure
 * (geo-block/offline); callers retry after their throttle.
 */
import { BINANCE_FUTURES_REST_BASES } from '../../config/exchangeEndpoints';

export const fetchMarkPrice = async (symbol: string): Promise<number | null> => {
    try {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(4000)
            : undefined;
        const response = await fetch(
            `${BINANCE_FUTURES_REST_BASES[0]}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
            signal ? { signal } : undefined,
        );
        if (!response.ok) return null;
        const data: unknown = await response.json();
        const raw = (data as { markPrice?: unknown } | null)?.markPrice;
        const price = typeof raw === 'string' ? parseFloat(raw) : NaN;
        return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
        return null;
    }
};
