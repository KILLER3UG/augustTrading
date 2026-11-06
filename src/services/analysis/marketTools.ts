/**
 * marketTools — the P0 market-structure tool adapters.
 *
 * These are the FETCH + ENVELOPE layer; the math lives in the pure cores
 * under `src/services/market/` (no fetch, no storage — they are what the
 * contract tests exercise). Every tool here honours the same rules:
 *
 *  - AS-OF: `asof` (ms, default now) bounds everything. Candles are filtered
 *    to CLOSED bars (open + interval ≤ asof) before any core sees them, and
 *    range fetches pass `endTime = asof` so a forming bar is never delivered.
 *  - MISSING DATA: `data_quality.available: false` + reason. A tool never
 *    throws past its boundary and never blocks a turn — the desk loop turns
 *    a thrown fetch into DATA_UNAVAILABLE, and a data shortage becomes an
 *    honest envelope instead.
 *  - UNIFORM ENVELOPE: {tool, asof, symbol, tf, params, data_quality,
 *    values, distances_atr, evidence_level, one_line_summary}. Distances in
 *    ATR units, ATR measured on the tool's own timeframe and named.
 *  - ONE VENUE: Binance USDT-M futures (`fetchFuturesOHLCV*`); the venue is
 *    printed in `data_quality.notes`; volumes are never mixed across venues.
 */

import {
    normalizeSymbol, fetchFuturesOHLCV, fetchFuturesOHLCVFromTime,
    fetchOpenInterest, fetchOpenInterestHistory, fetchFundingRateHistory,
    fetchMarkIndex, fetchTakerBuySellRatio, fetchTopTraderRatio,
    fetchLongShortRatio, fetchRecentLiquidations,
} from './MarketDataService';
import { baseOf } from '../../utils/symbol';
import { atr14, detectEqualLevels, detectSweepReversals } from '../../utils/smcStructure';
import type { Kline } from '../../types/message';
import { initialBalance, openType, dayType, failedIbExtension, poorEdges, vaRotationSetup } from '../market/auctionCore';
import { fundingState, liquidationRisk, oiPriceState, positioningState } from '../market/derivativesCore';
import { btcRelative, relativeStrengthRank } from '../market/crossMarketCore';
import { effortVsResult } from '../market/effortResultCore';
import { dedupeLevels, priorPeriodLevels, roundNumberRows, sessionLevelRows } from '../market/levelsCore';
import { deltaSeries, cvdDivergence, flowEvents } from '../market/orderFlowCore';
import { regimeRead } from '../market/regimeCore';
import { scanPlaybooks, type PlaybookContext, type PlaybookMatch } from '../market/playbooksCore';
import { previousPeriods, sessionWindowsForDay, utcDayStart, utcWeekStart, UTC_DAY_MS } from '../market/sessionConvention';
import { activeSwingFib, readStructure } from '../market/swingStructureCore';
import { readImbalances } from '../market/imbalanceCore';
import { readSrZones, readRangeState } from '../market/zonesCore';
import { readWyckoff } from '../market/wyckoffCore';
import { computeTradeMath, type TradeMathRead } from '../market/tradeMathCore';
import { buildVolumeProfile, nakedPocs, pricePositionVsValue, sessionPocs } from '../market/volumeProfileCore';
import { anchoredSlice, computeVwap, vwapPosition } from '../market/vwapCore';

export type EvidenceLevel = 'structural' | 'documented' | 'folklore';

export interface MarketToolEnvelope<T> {
    tool: string;
    asof: number;
    symbol: string;
    tf: string;
    params: Record<string, unknown>;
    data_quality: {
        available: boolean;
        bars_used: number;
        notes: string[];
        reason?: string;
    };
    values: T | null;
    distances_atr: Record<string, number | null>;
    evidence_level: EvidenceLevel;
    one_line_summary: string;
}

const INTERVAL_MS: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
};

const intervalMs = (tf: string): number => INTERVAL_MS[tf] ?? 0;

/** Closed candles only: a bar counts when it OPENED + interval ≤ asof — the
 *  same rule the signal resolver states, applied to every tool input. */
export const closedCandles = (candles: Kline[], tf: string, asofMs: number): Kline[] => {
    const span = intervalMs(tf);
    if (span <= 0) return candles.filter(c => c.time <= asofMs);
    return candles.filter(c => c.time + span <= asofMs);
};

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Number(v.toPrecision(6));

/** The closed-candle read the other tool adapters share, exposed for the
 *  journal-side tools (meta_label's regime read) — one tape fetcher, one
 *  closed-bar rule. */
export const fetchRecentForTools = async (symbol: string, tf: string, limit: number, asofMs: number = Date.now()): Promise<Kline[]> =>
    fetchRecent(symbol, tf, limit, asofMs);

const fetchRecent = async (symbol: string, tf: string, limit: number, asofMs: number): Promise<Kline[]> => {
    const raw = await fetchFuturesOHLCV(symbol, tf, limit);
    return closedCandles(raw, tf, asofMs);
};

/** Ranged fetch, chunked. Binance caps a kline call at 1500 bars, and it
 *  returns the OLDEST bars of the range — a naive single call over a long
 *  window silently loses the most recent days, which is exactly the bars an
 *  as-of tool exists to read. Split the window on the expected bar count,
 *  concat ascending, and dedupe by open time. */
const FETCH_CHUNK_BARS = 1400;
const fetchRange = async (symbol: string, tf: string, startMs: number, endMs: number): Promise<Kline[]> => {
    const span = intervalMs(tf);
    const perChunkMs = span > 0 ? FETCH_CHUNK_BARS * span : Number.MAX_SAFE_INTEGER;
    const chunks: Array<{ start: number; end: number }> = [];
    let cursor = startMs;
    while (cursor < endMs) {
        const chunkEnd = Math.min(cursor + perChunkMs, endMs);
        chunks.push({ start: cursor, end: chunkEnd });
        cursor = chunkEnd;
        if (chunks.length > 30) break; // absurd window guard
    }
    const out: Kline[] = [];
    const seen = new Set<number>();
    for (const chunk of chunks) {
        const raw = await fetchFuturesOHLCVFromTime(symbol, tf, chunk.start, chunk.end);
        for (const c of closedCandles(raw, tf, endMs)) {
            if (seen.has(c.time)) continue;
            seen.add(c.time);
            out.push(c);
        }
    }
    return out.sort((a, b) => a.time - b.time);
};

const envelope = <T,>(
    args: {
        tool: string;
        asof: number;
        symbol: string;
        tf: string;
        params: Record<string, unknown>;
        barsUsed: number;
        notes: string[];
        values: T | null;
        distancesAtr: Record<string, number | null>;
        evidence: EvidenceLevel;
        summary: string;
        reason?: string;
    },
): MarketToolEnvelope<T> => ({
    tool: args.tool,
    asof: args.asof,
    symbol: args.symbol,
    tf: args.tf,
    params: args.params,
    data_quality: {
        available: args.values !== null && args.reason === undefined,
        bars_used: args.barsUsed,
        notes: args.notes,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
    values: args.values,
    distances_atr: args.distancesAtr,
    evidence_level: args.evidence,
    one_line_summary: args.values === null ? (args.reason ?? 'unavailable') : args.summary,
});

// ─── volume_profile ─────────────────────────────────────────────────────

export type ProfileAnchor = 'session' | 'day' | 'week' | 'visible' | 'swing' | 'custom';

export const runVolumeProfileTool = async (
    symbolInput: string,
    anchor: ProfileAnchor = 'session',
    bins: number = 48,
    customTime?: number,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    let tf = '5m';
    let candles: Kline[] = [];
    let windowLabel: string;
    try {
        if (anchor === 'session' || anchor === 'day') {
            tf = '5m';
            const day = anchor === 'session' ? utcDayStart(asofMs) : utcDayStart(asofMs) - UTC_DAY_MS;
            candles = await fetchRange(symbol, tf, day, asofMs);
            windowLabel = anchor === 'session' ? 'current_utc_day' : 'previous_utc_day';
        } else if (anchor === 'week') {
            tf = '1h';
            candles = await fetchRange(symbol, tf, utcWeekStart(asofMs), asofMs);
            windowLabel = 'current_week_utc';
        } else if (anchor === 'visible') {
            tf = '15m';
            candles = await fetchRecent(symbol, tf, 300, asofMs);
            windowLabel = 'visible_range_300';
        } else if (anchor === 'swing') {
            tf = '1h';
            const raw = await fetchRecent(symbol, tf, 200, asofMs);
            const slice = anchoredSlice(raw, 'swing_high') ?? raw;
            candles = slice;
            windowLabel = 'since_swing_high';
        } else {
            tf = '15m';
            if (typeof customTime !== 'number' || !Number.isFinite(customTime)) {
                return JSON.stringify(envelope({
                    tool: 'volume_profile', asof: asofMs, symbol, tf,
                    params: { anchor, bins }, barsUsed: 0, notes,
                    values: null, distancesAtr: {}, evidence: 'structural',
                    summary: '', reason: 'custom anchor needs customTime (ms epoch)',
                }));
            }
            candles = await fetchRange(symbol, tf, customTime, asofMs);
            windowLabel = 'custom';
        }
        const atr = atr14(candles);
        const profile = buildVolumeProfile(candles, { bins });
        if (!profile || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'volume_profile', asof: asofMs, symbol, tf,
                params: { anchor, bins }, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: candles.length < 5 ? 'fewer than 5 closed candles in the anchor window' : 'profile degenerate (single-price window)',
            }));
        }
        if (!profile.buySellKnown) notes.push('some candles lack taker-buy volume — bin buy/sell split omitted');
        const last = candles[candles.length - 1].close;
        const position = pricePositionVsValue(profile, last);
        const values = {
            window: windowLabel,
            price: r4(last),
            poc: r4(profile.poc),
            value_area_high: r4(profile.valueAreaHigh),
            value_area_low: r4(profile.valueAreaLow),
            hvn: profile.hvn.map(n => ({ price: r4(n.price), volume: n.volume })),
            lvn: profile.lvn.map(n => ({ price: r4(n.price), volume: n.volume })),
            developing_poc: profile.developingPoc
                ? { early: r4(profile.developingPoc.early), now: r4(profile.developingPoc.now), migration: profile.developingPoc.migration }
                : null,
            price_position: position,
            total_volume: profile.totalVolume,
            bin_count: profile.bins.length,
            bins: profile.bins.map(b => ({
                lo: r4(b.priceLow), hi: r4(b.priceHigh), vol: b.volume,
                ...(b.buyVolume !== undefined ? { buy: r4(b.buyVolume) } : {}),
            })),
        };
        const dPoc = r2(Math.abs(last - profile.poc) / atr);
        return JSON.stringify(envelope({
            tool: 'volume_profile', asof: asofMs, symbol, tf,
            params: { anchor, bins, window: windowLabel }, barsUsed: candles.length, notes,
            values,
            distancesAtr: {
                poc: dPoc,
                value_area_high: r2(Math.abs(last - profile.valueAreaHigh) / atr),
                value_area_low: r2(Math.abs(last - profile.valueAreaLow) / atr),
            },
            evidence: 'structural',
            summary: `price ${position.replace('_', ' ')} the ${windowLabel} value area; POC ${r4(profile.poc)} (${dPoc} ATR away), POC migration ${profile.developingPoc?.migration ?? 'n/a'}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'volume_profile', asof: asofMs, symbol, tf,
            params: { anchor, bins }, barsUsed: candles.length,
            notes: [...notes, `fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── naked_pocs ─────────────────────────────────────────────────────────

export const runNakedPocsTool = async (
    symbolInput: string,
    granularity: 'day' | 'week' = 'day',
    lookback: number = 5,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        if (granularity === 'day') {
            const tf = '5m';
            const start = utcDayStart(asofMs) - (lookback + 1) * UTC_DAY_MS;
            const candles = await fetchRange(symbol, tf, start, asofMs);
            if (candles.length < 50) {
                return JSON.stringify(envelope({
                    tool: 'naked_pocs', asof: asofMs, symbol, tf,
                    params: { granularity, lookback }, barsUsed: candles.length, notes,
                    values: null, distancesAtr: {}, evidence: 'documented',
                    summary: '', reason: `not enough 5m candles for ${lookback} sessions (${candles.length})`,
                }));
            }
            const atr = atr14(candles.slice(-100));
            const windows = Array.from({ length: lookback }, (_, i) => {
                const d = utcDayStart(asofMs) - (i + 1) * UTC_DAY_MS;
                return { label: `session_${new Date(d).toISOString().slice(0, 10)}`, startMs: d, endMs: d + UTC_DAY_MS };
            }).filter(w => w.endMs <= asofMs);
            const pocs = sessionPocs(windows, candles);
            const after = candles.filter(c => c.time >= (windows[0]?.endMs ?? 0));
            const naked = nakedPocs(pocs, after, asofMs);
            const last = candles[candles.length - 1].close;
            const values = {
                reference_price: r4(last),
                sessions_scanned: pocs.length,
                naked: naked.map(p => ({
                    session: p.label,
                    poc: r4(p.poc),
                    distance: r2(Math.abs(last - p.poc)),
                    distance_atr: atr > 0 ? r2(Math.abs(last - p.poc) / atr) : null,
                    side: p.poc >= last ? 'above' : 'below',
                })),
            };
            return JSON.stringify(envelope({
                tool: 'naked_pocs', asof: asofMs, symbol, tf,
                params: { granularity, lookback }, barsUsed: candles.length, notes,
                values,
                distancesAtr: Object.fromEntries(values.naked.map(p => [p.session, p.distance_atr])),
                evidence: 'documented',
                summary: values.naked.length
                    ? `${values.naked.length} unvisited POC(s) from the last ${pocs.length} sessions; nearest ${values.naked[0].distance_atr ?? '?'} ATR ${values.naked[0].side}`
                    : `no naked POCs in the last ${pocs.length} sessions — all visited`,
            }));
        }
        // week granularity: 1h candles, POC per prior UTC week
        const tf = '1h';
        const weekStart = utcWeekStart(asofMs);
        const start = weekStart - lookback * 7 * UTC_DAY_MS;
        const candles = await fetchRange(symbol, tf, start, asofMs);
        const atr = atr14(candles.slice(-120));
        const windows = Array.from({ length: lookback }, (_, i) => {
            const w = weekStart - (i + 1) * 7 * UTC_DAY_MS;
            return { label: `week_${new Date(w).toISOString().slice(0, 10)}`, startMs: w, endMs: w + 7 * UTC_DAY_MS };
        }).filter(w => w.endMs <= asofMs);
        const pocs = sessionPocs(windows, candles, 60);
        const after = candles.filter(c => c.time >= (windows[0]?.endMs ?? 0));
        const naked = nakedPocs(pocs, after, asofMs);
        const last = candles[candles.length - 1]?.close ?? 0;
        const values = {
            reference_price: r4(last),
            weeks_scanned: pocs.length,
            naked: naked.map(p => ({
                week: p.label,
                poc: r4(p.poc),
                distance_atr: atr > 0 ? r2(Math.abs(last - p.poc) / atr) : null,
                side: p.poc >= last ? 'above' : 'below',
            })),
        };
        return JSON.stringify(envelope({
            tool: 'naked_pocs', asof: asofMs, symbol, tf,
            params: { granularity, lookback }, barsUsed: candles.length, notes,
            values,
            distancesAtr: Object.fromEntries(values.naked.map(p => [p.week, p.distance_atr])),
            evidence: 'documented',
            summary: values.naked.length
                ? `${values.naked.length} unvisited weekly POC(s); nearest ${values.naked[0].distance_atr ?? '?'} ATR ${values.naked[0].side}`
                : `no naked weekly POCs in the last ${pocs.length} weeks`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'naked_pocs', asof: asofMs, symbol, tf: granularity === 'day' ? '5m' : '1h',
            params: { granularity, lookback }, barsUsed: 0,
            notes: [...notes, `fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── vwap (anchored) ────────────────────────────────────────────────────

export type VwapAnchor = 'session_open' | 'swing_high' | 'swing_low' | 'custom';

export const runVwapTool = async (
    symbolInput: string,
    anchor: VwapAnchor = 'session_open',
    customTime?: number,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        let tf: string;
        let candles: Kline[];
        if (anchor === 'session_open') {
            tf = '5m';
            candles = await fetchRange(symbol, tf, utcDayStart(asofMs), asofMs);
        } else if (anchor === 'custom') {
            tf = '15m';
            if (typeof customTime !== 'number' || !Number.isFinite(customTime)) {
                return JSON.stringify(envelope({
                    tool: 'vwap', asof: asofMs, symbol, tf,
                    params: { anchor }, barsUsed: 0, notes,
                    values: null, distancesAtr: {}, evidence: 'structural',
                    summary: '', reason: 'custom anchor needs customTime (ms epoch)',
                }));
            }
            candles = await fetchRange(symbol, tf, customTime, asofMs);
        } else {
            tf = '1h';
            candles = await fetchRecent(symbol, tf, 120, asofMs);
        }
        const slice = anchor === 'session_open' ? candles : anchoredSlice(candles, anchor, customTime);
        const atr = atr14(slice ?? []);
        const vwap = slice ? computeVwap(slice) : null;
        const last = slice?.[slice.length - 1]?.close;
        if (!vwap || !slice || !last || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'vwap', asof: asofMs, symbol, tf,
                params: { anchor }, barsUsed: slice?.length ?? 0, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: 'not enough closed candles from the anchor to compute VWAP',
            }));
        }
        const position = vwapPosition(vwap, slice, last);
        const dAtr = r2(Math.abs(last - vwap.vwap) / atr);
        const values = {
            anchor,
            anchored_from: vwap.anchoredFrom,
            price: r4(last),
            vwap: r4(vwap.vwap),
            bands: {
                one_upper: r4(vwap.bands.oneUpper), one_lower: r4(vwap.bands.oneLower),
                two_upper: r4(vwap.bands.twoUpper), two_lower: r4(vwap.bands.twoLower),
            },
            side_of_vwap: position?.side,
            bars_since_cross: position?.barsSinceCross ?? null,
            participant_read: position
                ? { verdict: position.verdict, estimate: true as const }
                : null,
        };
        return JSON.stringify(envelope({
            tool: 'vwap', asof: asofMs, symbol, tf,
            params: { anchor }, barsUsed: slice.length, notes,
            values,
            distancesAtr: { vwap: dAtr },
            evidence: 'structural',
            summary: `price ${dAtr} ATR ${position?.side ?? '?'} session VWAP ${r4(vwap.vwap)}; participants ${position?.verdict === 'participants_in_profit' ? 'in profit' : 'underwater'} (estimate)`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'vwap', asof: asofMs, symbol, tf: '5m',
            params: { anchor }, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── order_flow ─────────────────────────────────────────────────────────

export const runOrderFlowTool = async (
    symbolInput: string,
    tf: string = '15m',
    window: number = 20,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures', 'candle-level delta ESTIMATE (not footprint)'];
    try {
        const candles = await fetchRecent(symbol, tf, Math.max(80, window * 3), asofMs);
        const atr = atr14(candles);
        const series = deltaSeries(candles);
        if (!series || candles.length < 20 || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'order_flow', asof: asofMs, symbol, tf,
                params: { window }, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: candles.length < 20
                    ? 'fewer than 20 closed candles'
                    : 'candles lack taker-buy volume — delta is not measurable on this venue/window',
            }));
        }
        const recent = candles.slice(-window);
        const recentDeltas = series.deltas.slice(-window);
        const netDelta = recentDeltas.reduce((s, d) => s + d.delta, 0);
        const divergence = cvdDivergence(candles, series, window);
        const events = flowEvents(candles, atr, Math.max(40, window * 2));
        const values = {
            window_bars: recent.length,
            cvd_now: Math.round(series.cvd * 100) / 100,
            net_delta_window: Math.round(netDelta * 100) / 100,
            buy_volume: Math.round(series.buyVolume * 100) / 100,
            sell_volume: Math.round(series.sellVolume * 100) / 100,
            price_cvd_divergence: divergence,
            events: events?.events ?? [],
            note: 'delta = 2 × takerBuy − volume per candle; a taker-buy field is a measurement, but candle aggregation is NOT footprint',
        };
        return JSON.stringify(envelope({
            tool: 'order_flow', asof: asofMs, symbol, tf,
            params: { window }, barsUsed: candles.length, notes,
            values,
            distancesAtr: {},
            evidence: 'documented',
            summary: `CVD ${Math.round(series.cvd)}, window net delta ${Math.round(netDelta)}${divergence ? `, ${divergence} price/CVD divergence` : ''}${events?.events.length ? `, ${events.events.length} absorption/exhaustion event(s)` : ''}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'order_flow', asof: asofMs, symbol, tf,
            params: { window }, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── effort_vs_result ───────────────────────────────────────────────────

export const runEffortResultTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 200, asofMs);
        const atr = atr14(candles);
        const read = candles.length >= 20 && atr > 0 ? effortVsResult(candles, atr) : null;
        if (!read) {
            return JSON.stringify(envelope({
                tool: 'effort_vs_result', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: 'need ≥20 closed candles and a measurable ATR',
            }));
        }
        const values = {
            recent_bars: read.bars.map(b => ({
                time: b.time, rvol: b.rvol, spread_atr: b.spreadAtr, close_position: b.closePosition, read: b.read,
            })),
            volume_price_correlation: read.volumePriceCorrelation,
            divergence: read.divergence,
            baseline_known: read.baselineKnown,
            thresholds: read.thresholds,
        };
        const notable = read.bars.filter(b => b.read !== 'routine').length;
        return JSON.stringify(envelope({
            tool: 'effort_vs_result', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: {},
            evidence: 'documented',
            summary: `${notable}/${read.bars.length} recent bars non-routine (drive/no-result/climax); ${read.divergence ? `${read.divergence} volume-price divergence` : 'no volume-price divergence'}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'effort_vs_result', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── auction_state ──────────────────────────────────────────────────────

export const runAuctionStateTool = async (
    symbolInput: string,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = [
        'venue: binance-usdtm-futures',
        'session convention: UTC day; initial balance = 00:00–01:00 UTC; sessions DST-shifted (see sessionConvention)',
    ];
    try {
        const day = utcDayStart(asofMs);
        // Today at 5m + the prior 10 days at 5m (two ranged calls — 10 days of
        // 5m is ~2880 bars, one call over Binance's 1500 cap).
        const today = await fetchRange(symbol, '5m', day, asofMs);
        const priorRecent = await fetchRange(symbol, '5m', day - 5 * UTC_DAY_MS, day);
        const priorOlder = await fetchRange(symbol, '5m', day - 10 * UTC_DAY_MS, day - 5 * UTC_DAY_MS);
        const prior = [...priorOlder, ...priorRecent];
        const all = [...prior, ...today];
        const atr = atr14(all.slice(-100));
        if (today.length < 2 || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'auction_state', asof: asofMs, symbol, tf: '5m',
                params: {}, barsUsed: today.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: 'fewer than 2 closed candles in the UTC day so far',
            }));
        }
        const ib = initialBalance(today, prior, atr, asofMs);
        if (!ib) {
            return JSON.stringify(envelope({
                tool: 'auction_state', asof: asofMs, symbol, tf: '5m',
                params: {}, barsUsed: today.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: 'initial balance not formed yet (no closed candles in 00:00–01:00 UTC)',
            }));
        }
        const priorDayCandles = prior.filter(c => c.time >= day - UTC_DAY_MS && c.time < day);
        const priorDayProfile = buildVolumeProfile(priorDayCandles, { bins: 48 });
        const priorDayHl = priorDayCandles.length > 0
            ? { high: Math.max(...priorDayCandles.map(c => c.high)), low: Math.min(...priorDayCandles.map(c => c.low)) }
            : null;
        const todayProfile = buildVolumeProfile(today, { bins: 48 });
        const ot = openType(today, priorDayHl, atr, asofMs);
        const dt = ib ? dayType(today, ib, atr, asofMs) : null;
        const failedExt = failedIbExtension(today, ib, atr, asofMs);
        const poor = todayProfile ? poorEdges(todayProfile) : null;
        const rotation = vaRotationSetup(
            today,
            priorDayProfile ? { valueAreaHigh: priorDayProfile.valueAreaHigh, valueAreaLow: priorDayProfile.valueAreaLow } : null,
            asofMs,
        );
        const last = today[today.length - 1].close;
        const values = {
            utc_day: new Date(day).toISOString().slice(0, 10),
            price: r4(last),
            initial_balance: {
                high: r4(ib.high), low: r4(ib.low),
                width_atr: ib.widthAtr,
                width_percentile: ib.widthPercentile,
                prior_days_used: ib.priorDaysUsed,
            },
            open_type: ot ? { type: ot.type, confidence: ot.confidence, detail: ot.detail } : null,
            day_type: dt ? { type: dt.type, confidence: dt.confidence, range_vs_ib: dt.rangeVsIb, detail: dt.detail } : null,
            failed_ib_extension: { side: failedExt.side, max_extension_atr: failedExt.maxExtensionAtr, failed: failedExt.failed, detail: failedExt.detail },
            edges: poor ? { poor_high: poor.poorHigh, poor_low: poor.poorLow, detail: poor.detail } : null,
            value_rotation: {
                open_vs_prior_value: rotation.openVsPriorValue,
                reentered: rotation.reentered,
                target: rotation.target === null ? null : r4(rotation.target),
                detail: rotation.detail,
            },
            thresholds_note: 'open/day-type thresholds are declared heuristics from auction method, not measured edges',
        };
        const distances: Record<string, number | null> = {
            ib_high: r2((ib.high - last) / atr),
            ib_low: r2((ib.low - last) / atr),
        };
        if (rotation.target !== null) distances.rotation_target = r2(Math.abs(rotation.target - last) / atr);
        return JSON.stringify(envelope({
            tool: 'auction_state', asof: asofMs, symbol, tf: '5m',
            params: {}, barsUsed: all.length, notes,
            values,
            distancesAtr: distances,
            evidence: 'documented',
            summary: `${ot?.type ?? 'open n/a'} open, ${dt?.type ?? 'day n/a'} day, IB ${ib.widthAtr} ATR${failedExt.failed ? `, FAILED ${failedExt.side === 'above_ib_high' ? 'upside' : 'downside'} extension` : ''}${poor?.poorHigh || poor?.poorLow ? `, ${poor.poorHigh ? 'poor high' : 'poor low'}` : ''}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'auction_state', asof: asofMs, symbol, tf: '5m',
            params: {}, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── regime (get_regime) ────────────────────────────────────────────────

export const runRegimeTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 220, asofMs);
        const read = regimeRead(candles);
        if (!read) {
            return JSON.stringify(envelope({
                tool: 'get_regime', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: `need ≥80 closed candles on ${tf} (got ${candles.length})`,
            }));
        }
        const values = read;
        return JSON.stringify(envelope({
            tool: 'get_regime', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: {},
            evidence: 'structural',
            summary: `${read.direction} (ADX ${read.directionStrength}, efficiency ${read.efficiency}, dwell ${read.dwell} bars) · volatility ${read.volatility}${read.atrPercentile !== null ? ` (ATR p${read.atrPercentile})` : ''}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'get_regime', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── trade_math ─────────────────────────────────────────────────────────

export const runTradeMathTool = async (
    symbolInput: string,
    direction: 'Long' | 'Short',
    entry: number,
    stopLoss: number,
    takeProfits: Array<number>,
    options: { equityUsd?: number; riskPercent?: number; leverage?: number; tf?: string; asofMs?: number } = {},
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const tf = options.tf ?? '15m';
    const asofMs = options.asofMs ?? Date.now();
    const notes: string[] = ['venue: binance-usdtm-futures', 'cost model: taker bps, slippage NOT modeled (utils/netRiskReward)'];
    try {
        const candles = await fetchRecent(symbol, tf, 100, asofMs);
        const read = computeTradeMath(
            {
                direction, entry, stopLoss, takeProfits,
                equityUsd: options.equityUsd,
                riskPercent: options.riskPercent,
                leverage: options.leverage,
            },
            candles,
        );
        if (!read) {
            return JSON.stringify(envelope({
                tool: 'trade_math', asof: asofMs, symbol, tf,
                params: { direction, entry, stopLoss }, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: 'entry/stop must be positive finite numbers',
            }));
        }
        if (read.gross.inverted) notes.push('plan is INVERTED for its stated direction — stop/target on the wrong sides; levels refused, not repaired');
        const values: TradeMathRead = read;
        return JSON.stringify(envelope({
            tool: 'trade_math', asof: asofMs, symbol, tf,
            params: { direction, entry, stopLoss, takeProfits, equityUsd: options.equityUsd, riskPercent: options.riskPercent, leverage: options.leverage },
            barsUsed: candles.length, notes,
            values,
            distancesAtr: {
                stop_atr: read.atr && read.atr > 0 ? r2(read.gross.risk / read.atr) : null,
                target_atr: read.atr && read.atr > 0 ? r2(read.gross.reward / read.atr) : null,
            },
            evidence: 'structural',
            summary: `R:R ${read.gross.ratio}${read.costs.costR !== null ? ` gross, ${read.costs.netRewardR} net of costs` : ''}${read.gross.inverted ? ' — INVERTED PLAN' : ''}${read.sizing.available ? `, size ${read.sizing.qty} @ ${read.sizing.leverageNeeded}× needed` : ', size unavailable (no equity)'}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'trade_math', asof: asofMs, symbol, tf,
            params: { direction, entry, stopLoss }, barsUsed: 0,
            notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── session_levels (the get_key_levels extension payload) ─────────────

export interface SessionLevelsPayload {
    reference: number;
    atr: number | null;
    rows: Array<{
        label: string;
        price: number;
        distance: number;
        distance_atr: number | null;
        touches: number;
        side: 'above' | 'below';
    }>;
    windows_used: string[];
}

/**
 * The day/week/month + session + round-number level set that EXTENDS
 * `get_key_levels`. The existing pivots/fib/psych/VWAP rows stay untouched —
 * these rows arrive beside them under the same fence protocol.
 */
export const buildSessionLevels = async (
    symbolInput: string,
    asofMs: number = Date.now(),
): Promise<SessionLevelsPayload> => {
    const symbol = normalizeSymbol(symbolInput);
    const candles = await fetchRange(symbol, '1h', utcDayStart(asofMs) - 35 * UTC_DAY_MS, asofMs);
    const last = candles.length ? candles[candles.length - 1].close : null;
    if (last === null) {
        return { reference: 0, atr: null, rows: [], windows_used: [] };
    }
    const atr = atr14(candles.slice(-100)) || null;
    const tolerance = atr && atr > 0 ? 0.15 * atr : last * 0.0015;
    const prev = previousPeriods(asofMs);
    const periodCandles = (Object.values(prev) as Array<{ startMs: number; endMs: number; label: string }>)
        .map(range => ({
            range,
            candles: candles.filter(c => c.time >= range.startMs && c.time < range.endMs),
        }));
    const rows = dedupeLevels([
        ...priorPeriodLevels(periodCandles, last, atr, tolerance, candles),
        ...sessionLevelRows(candles, asofMs, last, atr, tolerance),
        ...roundNumberRows(last, atr, tolerance, candles, 2),
    ], tolerance);
    return {
        reference: last,
        atr,
        rows: rows.map(r => ({
            label: r.label,
            price: r.price,
            distance: r.distance,
            distance_atr: r.distanceAtr,
            touches: r.touches,
            side: r.side,
        })),
        windows_used: periodCandles.filter(p => p.candles.length > 0).map(p => p.range.label),
    };
};

/** Session H/L helper reused by the key-levels extension (kept here so the
 *  desk service does not import the cores directly). */
export const sessionWindowsToday = (asofMs: number): Array<{ session: string; startMs: number; endMs: number }> =>
    sessionWindowsForDay(asofMs).map(w => ({ session: w.session, startMs: w.startMs, endMs: w.endMs }));

// ─── P2: derivatives state + cross-market ───────────────────────────────
// (docs/plans/tools-upgrade.md §7 item 9 — the P2 group. One coarse tool per
// family: the derivatives sub-reads share their fetches, and cross-market is
// the answer for assets WITHOUT derivatives data.)

export const runDerivativesStateTool = async (
    symbolInput: string,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures', 'thresholds are declared starting parameters to validate, not edges'];
    try {
        // Price series (1h closed) + the derivatives series, all cached at
        // the MarketDataService layer. Failures come back empty/null and the
        // envelope says so per-read — a missing series never blocks the others.
        const candles = await fetchRecent(symbol, '1h', 30, asofMs).catch(() => [] as Kline[]);
        const [oiHist, fundingHist, mark, taker, topTrader, retail, oiNow, liq] = await Promise.all([
            fetchOpenInterestHistory(symbol, '1h', 24).catch(() => []),
            fetchFundingRateHistory(symbol, 21).catch(() => [] as Array<{ t: number; rate: number }>),
            fetchMarkIndex(symbol).catch(() => ({ markPrice: 0, indexPrice: 0, lastFundingRate: 0, nextFundingTime: 0, available: false })),
            fetchTakerBuySellRatio(symbol).catch(() => null),
            fetchTopTraderRatio(symbol).catch(() => null),
            fetchLongShortRatio(symbol).catch(() => null),
            fetchOpenInterest(symbol).catch(() => null),
            fetchRecentLiquidations(symbol).catch(() => null),
        ]);
        const priceRows = candles.map(c => ({ t: c.time, close: c.close }));
        const oiRows = oiHist.map(r => ({ t: r.t, oi: r.oi }));
        const oi = oiRows.length >= 3 && priceRows.length >= 3 ? oiPriceState(priceRows, oiRows) : null;
        const funding = fundingHist.length >= 3 || mark.available
            ? fundingState(fundingHist, mark.available ? mark.lastFundingRate : null, priceRows, mark.available ? mark.nextFundingTime : null, asofMs)
            : null;
        const positioning = taker || topTrader || retail
            ? positioningState({
                takerRatio: taker?.ratio ?? null,
                topTraderRatio: topTrader?.ratio ?? null,
                longShortRatio: retail?.ratio ?? null,
            }, priceRows)
            : null;
        const liqRisk = liquidationRisk({
            liquidationsUsd: liq && liq.available !== false && liq.unavailableReason === undefined ? liq.totalRecentLiquidations : null,
            oiUsd: oiNow && oiNow.oiValue > 0 ? oiNow.oiValue : null,
            dominantSide: liq && liq.available !== false && liq.unavailableReason === undefined ? liq.dominantLiquidations : null,
            unavailableReason: liq?.unavailableReason,
        });

        const everythingEmpty = !oi && !funding && !positioning;
        if (everythingEmpty) {
            return JSON.stringify(envelope({
                tool: 'derivatives_state', asof: asofMs, symbol, tf: '1h',
                params: {}, barsUsed: candles.length,
                notes: [...notes, 'no derivatives series came back for this asset'],
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: 'derivatives data unavailable for this asset — never invent OI, funding or positioning numbers',
            }));
        }
        const values = {
            oi_price_state: oi,
            funding_state: funding,
            positioning,
            liquidation_risk: liqRisk,
            series_depth: {
                oi_points: oiHist.length,
                funding_points: fundingHist.length,
                price_points: priceRows.length,
                note: 'OI 24×1h (1 day), funding ~21×8h (≈7 days) — training use must respect this depth (tools-upgrade §5)',
            },
        };
        const bits: string[] = [];
        if (oi) bits.push(`${oi.quadrant.replace(/_/g, ' ')}${oi.divergence.kind ? ` (${oi.divergence.kind.replace(/_/g, ' ')} ×${oi.divergence.consecutiveBars})` : ''}`);
        if (funding) bits.push(`funding ${funding.current !== null ? (funding.current * 100).toFixed(4) + '%' : 'n/a'}${funding.extreme ? ' EXTREME' : ''}, p${funding.percentile ?? '?'}`);
        if (liqRisk.available) bits.push(`liq intensity ${liqRisk.intensityPct}% (${liqRisk.band})`);
        return JSON.stringify(envelope({
            tool: 'derivatives_state', asof: asofMs, symbol, tf: '1h',
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: {},
            evidence: 'documented',
            summary: bits.length ? bits.join('; ') : 'derivatives series present but too thin to read',
            ...(!bits.length ? { reason: 'series too thin for any read' } : {}),
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'derivatives_state', asof: asofMs, symbol, tf: '1h',
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'derivatives fetch failed',
        }));
    }
};

/** The declared default peer set for the relative-strength rank (majors only,
 *  bounded — a rank across the whole universe would cost 100 fetches). */
const RS_PEER_SET = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

// ─── Family H: the playbook layer ───────────────────────────────────────
// One call composes every P0/P1 read on the SAME tape into named setup
// detectors (playbooksCore). Detectors tag; they never size or veto.

export const runPlaybooksTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = [
        'venue: binance-usdtm-futures',
        'detectors tag a setup with evidence — they never size a trade or veto one',
    ];
    try {
        const candles = await fetchRecent(symbol, tf, 220, asofMs);
        const atr = atr14(candles);
        if (candles.length < 40 || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'scan_playbooks', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: `need ≥40 closed candles and a measurable ATR on ${tf}`,
            }));
        }
        // The structure/flow reads run on the tool's own timeframe.
        const regime = regimeRead(candles);
        const structure = readStructure(candles);
        const wyckoff = readWyckoff(candles, atr);
        const flow = flowEvents(candles, atr, 60);
        const equal = detectEqualLevels(candles, 60);
        const equalRows = [
            ...equal.equalHighs.map(h => ({ price: h.level, touches: h.touches, side: 'above' as const })),
            ...equal.equalLows.map(l => ({ price: l.level, touches: l.touches, side: 'below' as const })),
        ];
        const sweeps = detectSweepReversals(candles, equalRows.map(e => ({ price: e.price, label: 'equal_levels' })), { atr });
        // The day-structure reads (IB / rotation / session VWAP) run on the
        // 5m UTC-day set — the session convention, whatever the tool tf is.
        const day = utcDayStart(asofMs);
        const [today5m, prior5m] = await Promise.all([
            fetchRange(symbol, '5m', day, asofMs),
            fetchRange(symbol, '5m', day - UTC_DAY_MS, day),
        ]);
        const dayAtr = atr14(today5m.length >= 20 ? today5m : candles);
        const ib = initialBalance(today5m, prior5m, dayAtr, asofMs);
        const priorDay = prior5m.filter(c => c.time >= day - UTC_DAY_MS && c.time < day);
        const priorProfile = buildVolumeProfile(priorDay, { bins: 48 });
        const rotation = vaRotationSetup(
            today5m,
            priorProfile ? { valueAreaHigh: priorProfile.valueAreaHigh, valueAreaLow: priorProfile.valueAreaLow } : null,
            asofMs,
        );
        const failedExt = ib ? failedIbExtension(today5m, ib, dayAtr, asofMs) : null;
        const dayVwapCandles = anchoredSlice(today5m, 'session_open') ?? today5m;
        const dayVwap = computeVwap(dayVwapCandles);
        const lastClose = candles[candles.length - 1].close;
        const dayPosition = dayVwap && today5m.length > 0 ? vwapPosition(dayVwap, dayVwapCandles, lastClose) : null;
        const sessionVwap = dayVwap && dayPosition
            ? { vwap: dayVwap, position: dayPosition }
            : null;
        const profile = buildVolumeProfile(today5m, { bins: 48 });
        const zones = readSrZones(candles, atr);

        const ctx: PlaybookContext = {
            candles,
            atr,
            regime,
            structure,
            wyckoff,
            flow,
            ib,
            failedExtension: failedExt,
            rotation,
            dayOpen: today5m.length ? today5m[0].open : null,
            profile,
            sessionVwap,
            sweeps,
            keyLevels: [
                ...(profile ? [profile.poc] : []),
                ...(zones?.zones ?? []).slice(0, 3).flatMap(z => [z.top, z.bottom]),
            ],
        };
        const matches: PlaybookMatch[] = scanPlaybooks(ctx);
        const values = {
            matches: matches.map(m => ({
                playbook: m.playbook,
                side: m.side,
                confidence: m.confidence,
                invalidation: m.invalidation,
                invalidation_atr: m.invalidation !== null ? r2(Math.abs(m.invalidation - lastClose) / atr) : null,
                evidence: m.evidence,
                evidence_level: m.evidence_level,
                applies_in: m.applies_in,
            })),
            regime_now: regime ? { direction: regime.direction, volatility: regime.volatility, regime_id: regime.regimeId } : null,
            note: 'a match is a TAG with receipts — quote its evidence, verify with the underlying tools, and apply the trader\'s own rules',
        };
        const top = matches[0];
        return JSON.stringify(envelope({
            tool: 'scan_playbooks', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: {},
            evidence: 'documented',
            summary: matches.length
                ? `${matches.length} playbook match(es); first: ${top.playbook} ${top.side} (${top.confidence})`
                : 'no playbook matches on this tape — that is a reading, not a failure',
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'scan_playbooks', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

export const runBtcRelativeTool = async (
    symbolInput: string,
    window: number = 30,
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const bars = Math.min(120, Math.max(15, window + 5));
        const base = baseOf(symbol);
        const isMajor = base === 'BTC' || base === 'ETH';
        const [alt, btc, eth] = await Promise.all([
            fetchRecent(symbol, '1h', bars, asofMs),
            fetchRecent('BTCUSDT', '1h', bars, asofMs),
            fetchRecent('ETHUSDT', '1h', bars, asofMs),
        ]);
        const read = btcRelative(
            alt.map(c => c.close),
            btc.map(c => c.close),
            eth.length ? eth.map(c => c.close) : null,
            window,
        );
        if (!read) {
            return JSON.stringify(envelope({
                tool: 'btc_relative', asof: asofMs, symbol, tf: '1h',
                params: { window }, barsUsed: alt.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: `need ≥10 aligned 1h closes for the pair (alt ${alt.length}, BTC ${btc.length})`,
            }));
        }
        // Relative-strength rank vs the declared majors (skipped when the
        // subject IS one of them — BTC is not ranked against itself).
        let rank: ReturnType<typeof relativeStrengthRank> | null = null;
        if (!isMajor) {
            const w = Math.min(read.windowBars, bars - 1);
            const ret = (closes: number[]): number =>
                closes.length > w ? ((closes[closes.length - 1] - closes[closes.length - 1 - w]) / closes[closes.length - 1 - w]) * 100 : 0;
            const peers = await Promise.all(RS_PEER_SET.map(async p => ({
                symbol: baseOf(p),
                windowReturnPct: ret((await fetchRecent(p, '1h', bars, asofMs)).map(c => c.close)),
            })));
            rank = relativeStrengthRank(base, ret(alt.map(c => c.close)), peers);
        }
        const values = { ...read, relative_strength_rank: rank, peer_set: isMajor ? [] : RS_PEER_SET.map(p => baseOf(p)) };
        return JSON.stringify(envelope({
            tool: 'btc_relative', asof: asofMs, symbol, tf: '1h',
            params: { window }, barsUsed: read.windowBars, notes,
            values,
            distancesAtr: {},
            evidence: 'documented',
            summary: `alt/BTC z ${read.ratioZScore}, momentum ${read.ratioMomentumPct}% over ${read.windowBars}h; corr(BTC) ${read.correlationBtc}, beta ${read.betaBtc}${rank ? `; RS rank ${rank.find(r => r.rank === 1)?.symbol ?? ''} leads` : ''}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'btc_relative', asof: asofMs, symbol, tf: '1h',
            params: { window }, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── P1: structure, liquidity, imbalances, zones, wyckoff ───────────────
// (docs/plans/tools-upgrade.md §7 item 9 — the P1 group. Same envelope, same
// as-of rules, same cores-under/adapters-over split.)

// ─── swing_structure ────────────────────────────────────────────────────

export const runSwingStructureTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 220, asofMs);
        const atr = atr14(candles);
        const structure = candles.length >= 12 ? readStructure(candles) : null;
        if (!structure || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'swing_structure', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: `need ≥12 closed candles with pivotable swings on ${tf}`,
            }));
        }
        const fib = activeSwingFib(candles, atr);
        const last = candles[candles.length - 1].close;
        const values = {
            trend: structure.trend,
            swing_labels: structure.labels.slice(-6).map(l => ({
                tag: l.tag, price: r4(l.swing.price), kind: l.swing.kind,
                time: l.swing.time,
                distance_atr: r2(Math.abs(last - l.swing.price) / atr),
            })),
            last_break: structure.lastBreak
                ? { kind: structure.lastBreak.kind, direction: structure.lastBreak.direction, level: r4(structure.lastBreak.level) }
                : null,
            fib: fib
                ? {
                    direction: fib.direction,
                    from: r4(fib.from.price), to: r4(fib.to.price),
                    levels: fib.levels.map(l => ({ ratio: l.ratio, price: r4(l.price), confluence: l.confluence })),
                    tolerance_atr: fib.toleranceAtr,
                }
                : null,
        };
        return JSON.stringify(envelope({
            tool: 'swing_structure', asof: asofMs, symbol, tf,
            params: { k: 2 }, barsUsed: candles.length, notes,
            values,
            distancesAtr: structure.lastBreak
                ? { last_break_level: r2(Math.abs(last - structure.lastBreak.level) / atr) }
                : {},
            evidence: 'structural',
            summary: `${structure.trend} on ${tf}${structure.lastBreak ? `; last ${structure.lastBreak.kind} ${structure.lastBreak.direction} through ${r4(structure.lastBreak.level)}` : ''}${fib ? `; fib from the ${fib.direction} swing, best confluence ${Math.max(...fib.levels.map(l => l.confluence))}` : ''}`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'swing_structure', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── liquidity ──────────────────────────────────────────────────────────

export const runLiquidityTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 220, asofMs);
        const atr = atr14(candles);
        if (candles.length < 60 || !(atr > 0)) {
            return JSON.stringify(envelope({
                tool: 'liquidity', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: `need ≥60 closed candles on ${tf}`,
            }));
        }
        const last = candles[candles.length - 1].close;
        const equal = detectEqualLevels(candles, 60);
        const equalRows = [
            ...equal.equalHighs.map(h => ({ price: h.level, touches: h.touches, side: 'above' as const })),
            ...equal.equalLows.map(l => ({ price: l.level, touches: l.touches, side: 'below' as const })),
        ];
        // Sweeps need named levels: the equal highs/lows are the pools worth
        // naming, so they are what the sweep detector watches.
        const sweeps = detectSweepReversals(candles, equalRows.map(e => ({ price: e.price, label: 'equal_levels' })), { atr });
        // Untested swing extremes: price has not returned since they printed.
        const structure = readStructure(candles);
        const untested = (structure?.swings ?? [])
            .filter(s => !candles.some(c => c.time > s.time && (s.kind === 'high' ? c.high >= s.price : c.low <= s.price)))
            .slice(-6)
            .map(s => ({
                kind: s.kind, price: r4(s.price), time: s.time,
                distance_atr: r2(Math.abs(last - s.price) / atr),
            }));
        // Next opposing liquidity: nearest untested high above / low below.
        const above = untested.filter(u => u.kind === 'high').sort((a, b) => a.price - b.price)[0] ?? null;
        const below = untested.filter(u => u.kind === 'low').sort((a, b) => b.price - a.price)[0] ?? null;
        const values = {
            reference: r4(last),
            equal_highs_lows: equalRows.slice(0, 4).map(e => ({
                price: r4(e.price), touches: e.touches,
                distance_atr: r2(Math.abs(last - e.price) / atr),
                side: e.price >= last ? 'above' : 'below',
            })),
            sweeps: sweeps.slice(0, 4).map(s => ({
                side: s.side, level: r4(s.level), status: s.status,
                reclaimed: s.reclaimed, bars_elapsed: s.barsElapsed,
            })),
            untested_swings: untested,
            next_opposing_liquidity: {
                above: above ? { price: above.price, distance_atr: above.distance_atr } : null,
                below: below ? { price: below.price, distance_atr: below.distance_atr } : null,
            },
        };
        return JSON.stringify(envelope({
            tool: 'liquidity', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: {
                ...(above ? { next_liquidity_above: above.distance_atr } : {}),
                ...(below ? { next_liquidity_below: below.distance_atr } : {}),
            },
            evidence: 'structural',
            summary: `${equalRows.length} equal-level pool(s), ${sweeps.length} sweep candidate(s), ${untested.length} untested swing extreme(s)`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'liquidity', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── imbalances ─────────────────────────────────────────────────────────

export const runImbalancesTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures', 'FVG detection reuses utils/smcStructure.detectFvg (the one detector)'];
    try {
        const candles = await fetchRecent(symbol, tf, 120, asofMs);
        const atr = atr14(candles);
        const gaps = candles.length >= 10 && atr > 0 ? readImbalances(candles, atr) : null;
        if (gaps === null) {
            return JSON.stringify(envelope({
                tool: 'imbalances', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: 'need ≥10 closed candles and a measurable ATR',
            }));
        }
        const last = candles[candles.length - 1].close;
        const values = {
            gaps: gaps.map(g => ({
                direction: g.direction, top: r4(g.top), bottom: r4(g.bottom),
                size_atr: g.sizeAtr, displacement_atr: g.displacementAtr,
                age_bars: g.ageBars, fill: g.fill, fill_pct: g.fillPct,
            })),
            thresholds: { min_size_atr: 0.3, min_displacement_atr: 0.8 },
            note: 'order blocks are deliberately absent — weakest evidence, added last per the tools-upgrade plan',
        };
        const unfilled = gaps.filter(g => g.fill !== 'filled').length;
        return JSON.stringify(envelope({
            tool: 'imbalances', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: Object.fromEntries(gaps.slice(0, 5).map((g, i) => [`gap_${i + 1}_mid`, r2(Math.abs((g.top + g.bottom) / 2 - last) / atr)])),
            evidence: 'structural',
            summary: `${gaps.length} FVG(s) ≥0.3×ATR with displacement, ${unfilled} unfilled`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'imbalances', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── sr_zones (+ range_state) ───────────────────────────────────────────

export const runSrZonesTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 220, asofMs);
        const atr = atr14(candles);
        const zones = candles.length >= 30 && atr > 0 ? readSrZones(candles, atr) : null;
        const range = candles.length >= 20 && atr > 0 ? readRangeState(candles, atr) : null;
        if (!zones && !range) {
            return JSON.stringify(envelope({
                tool: 'sr_zones', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'structural',
                summary: '', reason: 'need ≥30 closed candles and a measurable ATR',
            }));
        }
        const values = {
            zones: zones?.zones.map(z => ({
                kind: z.kind, top: r4(z.top), bottom: r4(z.bottom),
                touches: z.touches, age_bars: z.ageBars, distance_atr: z.distanceAtr,
            })) ?? [],
            range_state: range
                ? {
                    range_high: r4(range.rangeHigh), range_low: r4(range.rangeLow), mid: r4(range.mid),
                    position_pct: range.positionPct, verdict: range.verdict, width_atr: range.widthAtr,
                }
                : null,
            cluster_tolerance_atr: zones?.clusterToleranceAtr ?? null,
        };
        return JSON.stringify(envelope({
            tool: 'sr_zones', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: Object.fromEntries((zones?.zones ?? []).slice(0, 5).map((z, i) => [`zone_${i + 1}`, z.distanceAtr])),
            evidence: 'structural',
            summary: `${zones?.zones.length ?? 0} S/R zone(s); price in ${range?.verdict ?? 'n/a'} of the ${tf} dealing range`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'sr_zones', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── wyckoff_events ─────────────────────────────────────────────────────

export const runWyckoffTool = async (
    symbolInput: string,
    tf: string = '1h',
    asofMs: number = Date.now(),
): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    const notes: string[] = ['venue: binance-usdtm-futures'];
    try {
        const candles = await fetchRecent(symbol, tf, 160, asofMs);
        const atr = atr14(candles);
        const read = candles.length >= 40 && atr > 0 ? readWyckoff(candles, atr) : null;
        if (!read) {
            return JSON.stringify(envelope({
                tool: 'wyckoff_events', asof: asofMs, symbol, tf,
                params: {}, barsUsed: candles.length, notes,
                values: null, distancesAtr: {}, evidence: 'documented',
                summary: '', reason: 'need ≥40 closed candles and a measurable ATR',
            }));
        }
        const values = {
            range: read.range
                ? { top: r4(read.range.top), bottom: r4(read.range.bottom), bars: read.range.bars, width_atr: read.range.widthAtr }
                : null,
            events: read.events.map(e => ({
                kind: e.kind, time: e.time, level: r4(e.level),
                volume_ratio: e.volumeRatio, confidence: e.confidence, detail: e.detail,
            })),
            bias: read.bias,
            thresholds: read.thresholds,
            note: read.note,
        };
        return JSON.stringify(envelope({
            tool: 'wyckoff_events', asof: asofMs, symbol, tf,
            params: {}, barsUsed: candles.length, notes,
            values,
            distancesAtr: read.range
                ? {
                    range_top: r2(Math.abs(read.range.top - candles[candles.length - 1].close) / atr),
                    range_bottom: r2(Math.abs(read.range.bottom - candles[candles.length - 1].close) / atr),
                }
                : {},
            evidence: 'documented',
            summary: read.range
                ? `${read.range.widthAtr}×ATR range over ${read.range.bars} bars; ${read.events.length} event(s), bias ${read.bias ?? 'none'}`
                : `no qualifying range on ${tf} (last 30 bars wider than ${read.thresholds.maxWidthAtr}×ATR)`,
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'wyckoff_events', asof: asofMs, symbol, tf,
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'documented', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

// ─── drawable levels — the chart half of the tools ──────────────────────
// The model NAMES a tool; the app re-runs it and draws at the app's own
// computed prices. This is the draw_detected rule applied to the market
// tools: the drawing and the computation cannot disagree, because there is
// only one of them.

/** The structure-family dispatcher the drawer uses (swing_structure,
 *  liquidity, imbalances, sr_zones, wyckoff_events — one switch, one place). */
export const runStructureTool = (tool: string, symbol: string, tf: string): Promise<string> => {
    switch (tool) {
        case 'swing_structure': return runSwingStructureTool(symbol, tf);
        case 'liquidity': return runLiquidityTool(symbol, tf);
        case 'imbalances': return runImbalancesTool(symbol, tf);
        case 'sr_zones': return runSrZonesTool(symbol, tf);
        case 'wyckoff_events': return runWyckoffTool(symbol, tf);
        default: return Promise.resolve(JSON.stringify(envelope({
            tool, asof: Date.now(), symbol, tf,
            params: {}, barsUsed: 0, notes: [], values: null, distancesAtr: {},
            evidence: 'structural', summary: '', reason: `"${tool}" has no runner`,
        })));
    }
};

/** `get_key_levels` in the envelope shape, for the drawer: the desk tool's
 *  own JSON is a custom shape (the card protocol), so the drawer re-runs the
 *  session-levels frame under the standard envelope. */
export const runKeyLevelsEnvelope = async (symbolInput: string, asofMs: number = Date.now()): Promise<string> => {
    const symbol = normalizeSymbol(symbolInput);
    try {
        const payload = await buildSessionLevels(symbol, asofMs);
        return JSON.stringify(envelope({
            tool: 'get_key_levels', asof: asofMs, symbol, tf: '1h',
            params: {}, barsUsed: payload.rows.length, notes: ['venue: binance-usdtm-futures', 'session-levels frame only — the R/S/VWAP ladder lives in the get_key_levels desk tool'],
            values: { session_levels: payload } as unknown as Record<string, unknown>,
            distancesAtr: {}, evidence: 'structural',
            summary: `${payload.rows.length} session level(s)`,
            ...(payload.rows.length === 0 ? { reason: 'no candle coverage for the day/week/month windows' } : {}),
        }));
    } catch (error) {
        return JSON.stringify(envelope({
            tool: 'get_key_levels', asof: asofMs, symbol, tf: '1h',
            params: {}, barsUsed: 0, notes: [`fetch failed: ${(error as Error).message}`],
            values: null, distancesAtr: {}, evidence: 'structural', summary: '',
            reason: 'candle fetch failed',
        }));
    }
};

export type DrawingColor = 'emerald' | 'rose' | 'amber' | 'sky' | 'violet';

export interface DrawableHline {
    label: string;
    price: number;
    color: DrawingColor;
}

export interface DrawableZone {
    label: string;
    top: number;
    bottom: number;
    color: DrawingColor;
}

export interface DrawableSet {
    hlines: DrawableHline[];
    zones: DrawableZone[];
}

/** The tools whose result has a standard drawing, and what to re-run. */
export const DRAWABLE_TOOLS: readonly string[] = [
    'volume_profile', 'naked_pocs', 'vwap', 'auction_state', 'get_key_levels',
    'swing_structure', 'liquidity', 'imbalances', 'sr_zones', 'wyckoff_events',
];

/**
 * Extract the standard drawing set from a market-tool envelope (the JSON the
 * tool already returns). Pure: no fetch, no canvas — the panel executor
 * converts these into ChartDrawings. Every price here IS a computed price;
 * nothing is restated by the model.
 */
export const drawableLevelsFor = (
    tool: string,
    parsed: { values?: unknown },
    filter?: string[],
): DrawableSet | null => {
    const values = parsed?.values as Record<string, unknown> | null | undefined;
    if (!values) return null;
    const keep = (label: string): boolean =>
        !filter || filter.length === 0 || filter.some(f => label.toLowerCase().includes(f.toLowerCase()));
    const hlines: DrawableHline[] = [];
    const zones: DrawableZone[] = [];
    const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;

    if (tool === 'volume_profile') {
        const poc = num(values.poc);
        const vah = num(values.value_area_high);
        const val = num(values.value_area_low);
        if (poc !== null && keep('POC')) hlines.push({ label: 'POC', price: poc, color: 'amber' });
        if (vah !== null && val !== null) {
            if (keep('VAH')) hlines.push({ label: 'VAH', price: vah, color: 'sky' });
            if (keep('VAL')) hlines.push({ label: 'VAL', price: val, color: 'sky' });
            if (keep('value area')) zones.push({ label: 'value area (70%)', top: vah, bottom: val, color: 'violet' });
        }
    } else if (tool === 'naked_pocs') {
        const naked = values.naked as Array<{ poc?: unknown; session?: unknown; week?: unknown }> | undefined;
        for (const p of naked ?? []) {
            const price = num(p.poc);
            const label = String(p.session ?? p.week ?? 'POC');
            if (price !== null && keep(label)) hlines.push({ label: `naked POC ${label}`, price, color: 'violet' });
        }
    } else if (tool === 'vwap') {
        const vwap = num(values.vwap);
        const bands = values.bands as Record<string, unknown> | undefined;
        if (vwap !== null && keep('VWAP')) hlines.push({ label: 'VWAP', price: vwap, color: 'sky' });
        const oneUpper = num(bands?.one_upper);
        const oneLower = num(bands?.one_lower);
        if (oneUpper !== null && keep('±1σ')) hlines.push({ label: 'VWAP +1σ', price: oneUpper, color: 'violet' });
        if (oneLower !== null && keep('±1σ')) hlines.push({ label: 'VWAP −1σ', price: oneLower, color: 'violet' });
    } else if (tool === 'auction_state') {
        const ib = values.initial_balance as Record<string, unknown> | undefined;
        const ibHigh = num(ib?.high);
        const ibLow = num(ib?.low);
        if (ibHigh !== null && keep('IB')) hlines.push({ label: 'IB high', price: ibHigh, color: 'amber' });
        if (ibLow !== null && keep('IB')) hlines.push({ label: 'IB low', price: ibLow, color: 'amber' });
        const rotation = values.value_rotation as Record<string, unknown> | undefined;
        const target = num(rotation?.target);
        if (target !== null && keep('rotation')) hlines.push({ label: 'VA rotation target', price: target, color: 'emerald' });
    } else if (tool === 'get_key_levels') {
        const sl = values.session_levels as { rows?: Array<{ label?: unknown; price?: unknown; side?: unknown }> } | null | undefined;
        for (const row of (sl?.rows ?? []).slice(0, 12)) {
            const price = num(row.price);
            const label = String(row.label ?? 'level');
            if (price === null || !keep(label)) continue;
            hlines.push({ label, price, color: row.side === 'above' ? 'sky' : 'emerald' });
        }
    } else if (tool === 'swing_structure') {
        const fib = values.fib as { levels?: Array<{ ratio?: unknown; price?: unknown; confluence?: unknown }> } | null | undefined;
        for (const l of fib?.levels ?? []) {
            const price = num(l.price);
            const ratio = String(l.ratio ?? '');
            if (price === null || !keep(`fib ${ratio}`)) continue;
            hlines.push({ label: `fib ${ratio} (${String(l.confluence ?? 0)}×)`, price, color: 'violet' });
        }
        const brk = values.last_break as { level?: unknown; direction?: unknown; kind?: unknown } | null | undefined;
        const level = num(brk?.level);
        if (level !== null && keep('break')) {
            hlines.push({ label: `${String(brk?.kind ?? 'break')} ${String(brk?.direction ?? '')}`, price: level, color: brk?.direction === 'bullish' ? 'emerald' : 'rose' });
        }
    } else if (tool === 'liquidity') {
        const eq = values.equal_highs_lows as Array<{ price?: unknown; side?: unknown; touches?: unknown }> | undefined;
        for (const e of (eq ?? []).slice(0, 6)) {
            const price = num(e.price);
            if (price === null || !keep('equal')) continue;
            hlines.push({ label: `equal ${e.side} (${String(e.touches ?? '?')}×)`, price, color: 'violet' });
        }
        const untested = values.untested_swings as Array<{ kind?: unknown; price?: unknown }> | undefined;
        for (const u of (untested ?? []).slice(0, 4)) {
            const price = num(u.price);
            if (price === null || !keep('swing')) continue;
            hlines.push({ label: `untested swing ${String(u.kind ?? '')}`, price, color: 'amber' });
        }
    } else if (tool === 'imbalances') {
        const gaps = values.gaps as Array<{ direction?: unknown; top?: unknown; bottom?: unknown; fill?: unknown }> | undefined;
        for (const g of (gaps ?? []).slice(0, 6)) {
            const top = num(g.top);
            const bottom = num(g.bottom);
            if (top === null || bottom === null || g.fill === 'filled' || !keep('FVG')) continue;
            zones.push({ label: `FVG ${String(g.direction ?? '')} (${String(g.fill ?? '')})`, top, bottom, color: g.direction === 'bullish' ? 'emerald' : 'rose' });
        }
    } else if (tool === 'sr_zones') {
        const zs = values.zones as Array<{ kind?: unknown; top?: unknown; bottom?: unknown; touches?: unknown }> | undefined;
        for (const z of (zs ?? []).slice(0, 6)) {
            const top = num(z.top);
            const bottom = num(z.bottom);
            if (top === null || bottom === null || !keep('zone')) continue;
            zones.push({ label: `S/R ${String(z.kind ?? '')} (${String(z.touches ?? '?')}×)`, top, bottom, color: z.kind === 'supply' ? 'rose' : 'emerald' });
        }
    } else if (tool === 'wyckoff_events') {
        const range = values.range as { top?: unknown; bottom?: unknown } | null | undefined;
        const top = num(range?.top);
        const bottom = num(range?.bottom);
        if (top !== null && keep('range')) hlines.push({ label: 'range top', price: top, color: 'sky' });
        if (bottom !== null && keep('range')) hlines.push({ label: 'range bottom', price: bottom, color: 'sky' });
        const events = values.events as Array<{ kind?: unknown; level?: unknown; confidence?: unknown }> | undefined;
        for (const e of (events ?? []).slice(0, 4)) {
            const level = num(e.level);
            const kind = String(e.kind ?? '');
            if (level === null || (kind !== 'spring' && kind !== 'upthrust')) continue;
            if (!keep(kind)) continue;
            hlines.push({ label: `${kind} (${String(e.confidence ?? '')})`, price: level, color: kind === 'spring' ? 'emerald' : 'rose' });
        }
    } else {
        return null;
    }
    return { hlines: hlines.filter(h => h.price > 0), zones: zones.filter(z => z.top > 0 && z.bottom > 0) };
};
