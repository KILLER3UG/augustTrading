/**
 * screener — the market-wide discovery layer: scan the USDT-perp universe
 * (top N by 24h volume) and grade every coin with August's OWN machinery —
 * RSI(14) + EMA regime on 15m, the strategy-book setup detectors
 * (setupScan), and the trader's personal edge from the journal. NOT a
 * TradingView clone: the value is the personal layer (your history, your
 * detectors) over data the app already fetches.
 *
 * Budget model: klines for N coins is the cost — callers scan the top 100
 * by default with bounded concurrency (6) and progressive onRows callbacks
 * so a UI table fills in as results land. KlineService's cache + in-flight
 * coalescing keeps repeat scans cheap.
 */

import { fetchAllFuturesSymbols } from '../analysis/MarketDataService';
import { fetchKlinesTagged, spotMirrorSourceNote } from '../analysis/KlineService';
import { rsiSeries, scanSetups } from './setupScan';
import { computeSetupClusterStats } from '../learning/setupClusterStats';
import { baseOf } from '../../utils/symbol';
import type { Kline } from '../analysis/MarketDataService';
import type { LoggedTrade } from '../../types/trade';

export interface ScreenerRow {
    symbol: string;
    baseAsset: string;
    price: number;
    change24h: number;
    quoteVolume: number;
    /** RSI(14) on the scan interval (null when klines failed/too short). */
    rsi14: number | null;
    /** EMA20/50 trend read on the scan interval. */
    regime: 'up' | 'down' | 'range';
    /** LIVE strategy-book setups detected on the scan interval. `barsAgo` is
     *  the detector's trigger age (0 = current bar); bestSetups scores it. */
    setups: { title: string; side: 'long' | 'short' | 'watch'; barsAgo?: number }[];
    /** The trader's own logged record for THIS coin, e.g. "7W/5L" ('' = no history). */
    edge: string;
    /** True when this row's candles came from the SPOT mirror (the futures
     *  feed was unreachable for this read) — a degraded row is named in the
     *  digest, never averaged silently into the scan (open-items O-63). */
    degraded: boolean;
}

export interface ScreenerOptions {
    /** How many of the top-by-volume coins to scan (default 100). */
    limit?: number;
    /** Parallel kline fetches (default 6 — polite to the exchange). */
    concurrency?: number;
    /** Scan timeframe (default 15m). */
    interval?: string;
    /** The trader's logged trades — powers the personal edge column. */
    trades?: LoggedTrade[];
    /** Progressive callback: fires after EVERY row lands. */
    onRows?: (rows: ScreenerRow[]) => void;
    signal?: AbortSignal;
}

const ema = (closes: number[], period: number): number => {
    if (closes.length < period) return NaN;
    let acc = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i += 1) acc = closes[i] * k + acc * (1 - k);
    return acc;
};

const regimeOf = (candles: Kline[]): 'up' | 'down' | 'range' => {
    const closes = candles.map(c => c.close);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    if (!Number.isFinite(ema20) || !Number.isFinite(ema50)) return 'range';
    const last = closes[closes.length - 1];
    if (ema20 > ema50 && last > ema20) return 'up';
    if (ema20 < ema50 && last < ema20) return 'down';
    return 'range';
};

const edgeFor = (symbol: string, trades: LoggedTrade[]): string => {
    // Canonical base asset (utils/symbol) — the same form
    // computeSetupClusterStats normalizes both sides to.
    const coin = baseOf(symbol);
    try {
        const stats = computeSetupClusterStats(coin, undefined, undefined, trades);
        if (stats && stats.sample > 0) return `${stats.wins}W/${stats.losses}L`;
    } catch { /* edge is decorative — never break the scan */ }
    return '';
};

const scanRow = async (meta: { symbol: string; baseAsset: string; price: number; change24h: number; quoteVolume: number }, interval: string, trades: LoggedTrade[]): Promise<ScreenerRow> => {
    const row: ScreenerRow = { ...meta, rsi14: null, regime: 'range', setups: [], edge: edgeFor(meta.symbol, trades), degraded: false };
    try {
        const tagged = await fetchKlinesTagged(meta.symbol, interval, 120);
        const candles = tagged.candles;
        row.degraded = tagged.source === 'spot-mirror';
        if (candles.length >= 15) {
            const rsis = rsiSeries(candles);
            const last = rsis[rsis.length - 1];
            row.rsi14 = Number.isFinite(last) ? Math.round(last * 10) / 10 : null;
            row.regime = regimeOf(candles);
            row.setups = scanSetups(candles).slice(0, 4)
                .map(s => ({ title: s.title, side: s.side, barsAgo: s.barsAgo }));
        }
    } catch { /* klines failed — the row stays price/volume-only */ }
    return row;
};

export interface ScreenerResult {
    rows: ScreenerRow[];
    /** True when the futures universe feed could not be reached at all.
     *  `fetchAllFuturesSymbols` swallows transport failures into `[]`, and a
     *  live exchange never has an empty USDT-perp universe — so an empty
     *  universe IS the failure signal. Callers must NOT render this as
     *  "no coins match": the screen is blind, not empty. */
    universeFailed: boolean;
}

/** Scan the top-N universe; resolves with ALL rows (volume-ordered) plus a
 *  feed-failure flag that distinguishes a dead ticker from an empty result. */
export const runScreenerWithStatus = async (options: ScreenerOptions = {}): Promise<ScreenerResult> => {
    const { limit = 100, concurrency = 6, interval = '15m', trades = [], onRows, signal } = options;
    const universeMeta = await fetchAllFuturesSymbols();
    if (universeMeta.length === 0) return { rows: [], universeFailed: true };
    const universe = universeMeta.slice(0, Math.max(1, limit));
    const rows: ScreenerRow[] = [];
    let cursor = 0;
    let stopped = false;
    signal?.addEventListener('abort', () => { stopped = true; }, { once: true });
    const worker = async (): Promise<void> => {
        while (!stopped && !signal?.aborted) {
            const i = cursor;
            cursor += 1;
            if (i >= universe.length) return;
            const meta = universe[i];
            const row = await scanRow({
                symbol: meta.symbol,
                baseAsset: meta.baseAsset,
                price: meta.lastPrice,
                change24h: meta.changePercent24h,
                quoteVolume: meta.quoteVolume,
            }, interval, trades);
            if (stopped || signal?.aborted) return;
            rows.push(row);
            onRows?.([...rows]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, universe.length) }, worker));
    return { rows, universeFailed: false };
};

/** Scan the top-N universe; resolves with ALL rows (volume-ordered). */
export const runScreener = async (options: ScreenerOptions = {}): Promise<ScreenerRow[]> => {
    const { rows } = await runScreenerWithStatus(options);
    return rows;
};

/** Compact markdown digest for the model (run_screener desk tool).
 *
 *  An empty array here does NOT mean the feed failed — the caller checks
 *  `scan.universeFailed` and says UNKNOWN in that case, before ever reaching this
 *  formatter. The one model-facing caller filters `setupsOnly` after a healthy scan,
 *  so this line used to tell the seat "universe fetch failed" when the truth was
 *  "the scan ran and nothing matched" — an outage that never happened, in the one
 *  digest the model reads (the 2026-10-27 audit T-9). */
export const screenerToMarkdown = (rows: ScreenerRow[]): string => {
    if (rows.length === 0) return 'SCREENER — 0 rows: the scan completed and nothing met this filter. This is a real result, not a feed failure.';
    const degraded = rows.filter(r => r.degraded);
    const head = 'symbol | price | 24h% | RSI14 | regime | setups | your edge';
    const lines = rows.map(r => {
        const setups = r.setups.length > 0 ? r.setups.map(s => `${s.title} (${s.side})`).join('; ') : '—';
        const regime = r.regime === 'up' ? '▲ up' : r.regime === 'down' ? '▼ down' : '· range';
        const mark = r.degraded ? '*' : '';
        return `${r.symbol}${mark} | ${r.price.toLocaleString()} | ${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(1)}% | ${r.rsi14 ?? '—'} | ${regime} | ${setups} | ${r.edge || '—'}`;
    });
    const out = [`SCREENER — ${rows.length} coins (top by 24h volume, 15m read):`, head, ...lines];
    // O-63: a degraded read is named where the digest is read, not buried in
    // a per-row flag. `*` marks the rows; this line says what it means.
    if (degraded.length > 0) out.push(spotMirrorSourceNote('spot-mirror')!.replace('CANDLE SOURCE: SPOT MIRROR', `CANDLE SOURCE: SPOT MIRROR for ${degraded.map(r => r.symbol).join(', ')}`));
    return out.join('\n');
};
