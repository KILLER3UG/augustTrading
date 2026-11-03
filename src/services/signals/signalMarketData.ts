/**
 * signalMarketData — the public, keyless tape the resolver reads.
 *
 * OKX is the PRIMARY series (`/api/v5/market/candles`, no key, no account) and
 * Binance is the CROSS-CHECK (`MarketDataService.fetchOHLCV`, the same public
 * klines the chart already uses). Neither call places an order or touches an
 * exchange account.
 *
 * The cross-check compares the bars that DECIDED a resolution, not the whole
 * series: a disagreement on an idle bar cannot change the outcome, and a
 * whole-series comparison would drown the deciding bar in noise. Agreement
 * means high, low and close are within 10 bps on every deciding bar; a bar the
 * cross series does not cover makes the check `unavailable` — never `agree`.
 *
 * Settlement REFUSES to run when the primary series does not reach back to the
 * signal's emission (`tapeCoversEmission`). A 300-bar window is 25 hours; an
 * app closed for a weekend would otherwise settle every old signal as
 * "never triggered" from a tape that simply starts later. An uncovered window
 * is left open and the feed says why.
 */

import type { SignalCandle } from './signalResolver';
import { fetchOHLCV, type Kline } from '../analysis/MarketDataService';
import { coerceCandles } from '../../utils/candleShape';

const OKX_BASE = 'https://www.okx.com';
const OKX_TIMEOUT_MS = 8000;
/** 10 bps. Two venues aggregate different trades; a wider tolerance would hide
 *  a real mismatch, a tighter one would flag every thin bar. */
export const CROSS_CHECK_TOLERANCE = 0.001;

export const normalizeCoin = (raw: string): string =>
    (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** BTCUSDT → BTC-USDT. Null when the quote is not one OKX lists this way —
 *  a guessed instrument id would settle one coin's signal on another's tape. */
export const okxInstId = (raw: string): string | null => {
    const coin = normalizeCoin(raw);
    const match = /^(.+?)(USDT|USDC|USD)$/.exec(coin);
    return match ? `${match[1]}-${match[2]}` : null;
};

export const parseOkxCandles = (json: unknown): SignalCandle[] => {
    const body = json as { code?: unknown; data?: unknown } | null;
    if (!body || body.code !== '0' || !Array.isArray(body.data)) return [];
    const out: SignalCandle[] = [];
    for (const row of body.data) {
        if (!Array.isArray(row) || row.length < 9) continue;
        // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        if (String(row[8]) !== '1') continue; // closed bars only — a forming bar is not evidence
        const [time, open, high, low, close] = row.map(Number);
        const volume = Number(row[5]);
        if (![time, open, high, low, close].every(Number.isFinite)) continue;
        out.push({
            time, open, high, low, close,
            ...(Number.isFinite(volume) ? { volume } : {}),
        });
    }
    // The resolver's tape obeys the shared shape rule (utils/candleShape): a
    // candle that violates its own OHLC is a broken row, dropped and named —
    // never a quieter bar the ledger grades on.
    const { kept, dropped } = coerceCandles(out);
    if (dropped > 0) {
        console.warn(`[signalMarketData] dropped ${dropped} incoherent OKX candle(s) (OHLC shape)`);
    }
    return kept.sort((a, b) => a.time - b.time);
};

export type OkxFetched = { ok: true; candles: SignalCandle[] } | { ok: false; error: string };

export const fetchOkxCandles = async (
    instId: string,
    bar: '5m' | '1m',
    limit: number,
    signal?: AbortSignal,
): Promise<OkxFetched> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OKX_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
        const url = `${OKX_BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${Math.min(300, Math.max(1, limit))}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return { ok: false, error: `OKX answered ${response.status}` };
        const candles = parseOkxCandles(await response.json());
        if (candles.length === 0) return { ok: false, error: 'OKX returned no closed candles' };
        return { ok: true, candles };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
};

const fromKlines = (klines: readonly Kline[]): SignalCandle[] => {
    const rows: SignalCandle[] = klines
        .map(k => ({
            time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
            ...(Number.isFinite(k.volume) ? { volume: k.volume } : {}),
        }))
        .filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));
    // The cross-check series obeys the same shape rule as the primary — a
    // broken row here would fabricate a disagreement.
    const { kept, dropped } = coerceCandles(rows);
    if (dropped > 0) {
        console.warn(`[signalMarketData] dropped ${dropped} incoherent Binance candle(s) (OHLC shape)`);
    }
    return kept.sort((a, b) => a.time - b.time);
};

/** Binance is the cross-check, never the silent primary. Throws are an
 *  unavailable check, not a disagreement. */
export const fetchBinanceCandles = async (
    coin: string,
    interval: '5m' | '1m',
    limit: number,
): Promise<SignalCandle[] | null> => {
    try {
        return fromKlines(await fetchOHLCV(coin, interval, Math.min(1000, limit)));
    } catch {
        return null;
    }
};

/** Does the primary series reach back to the emission? */
export const tapeCoversEmission = (candles: readonly SignalCandle[], emittedAt: number): boolean =>
    candles.length > 0 && candles[0].time <= emittedAt;

const withinTolerance = (a: number, b: number): boolean => {
    if (!(a > 0) || !(b > 0)) return false;
    return Math.abs(a - b) / Math.max(a, b) <= CROSS_CHECK_TOLERANCE;
};

export const crossCheckBars = (
    primary: readonly SignalCandle[],
    cross: readonly SignalCandle[] | null,
    usedBarTimes: readonly number[],
): 'agree' | 'disagree' | 'unavailable' => {
    if (!cross || cross.length === 0 || usedBarTimes.length === 0) return 'unavailable';
    const byTime = new Map(cross.map(c => [c.time, c]));
    for (const time of usedBarTimes) {
        const other = byTime.get(time);
        if (!other) return 'unavailable';
        const mine = primary.find(c => c.time === time);
        if (!mine) return 'unavailable';
        if (!withinTolerance(mine.high, other.high)
            || !withinTolerance(mine.low, other.low)
            || !withinTolerance(mine.close, other.close)) {
            return 'disagree';
        }
    }
    return 'agree';
};
