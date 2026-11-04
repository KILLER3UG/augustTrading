/**
 * chartData — pure mappers feeding the local canvas chart (lightweight-charts)
 * from the app's own kline fetchers. Keeping the conversions pure means the
 * chart's data contract is unit-tested without a canvas or the network.
 */

import { Kline } from '../analysis/MarketDataService';
import { TradeAnalysis, Message } from '../../types';
import { buildProposedTradeAnalysis } from './proposedTrade';
import { parsePrice as parsePriceCanonical } from '../../utils/analysisUtils';
import { baseOf } from '../../utils/symbol';

export interface CandlePoint {
    time: number; // unix seconds (lightweight-charts UTCTimestamp)
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface VolumePoint {
    time: number;
    value: number;
    color: string;
}

export const VOLUME_UP = 'rgba(7, 181, 106, 0.45)';   // theme green
export const VOLUME_DOWN = 'rgba(247, 93, 95, 0.45)'; // theme red

export const toCandles = (klines: Kline[]): CandlePoint[] => klines
    .filter(k => Number.isFinite(k.open) && Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close))
    .map(k => ({ time: Math.floor(k.time / 1000), open: k.open, high: k.high, low: k.low, close: k.close }));

export const toVolumes = (klines: Kline[]): VolumePoint[] => klines
    .filter(k => Number.isFinite(k.volume))
    .map(k => ({ time: Math.floor(k.time / 1000), value: k.volume, color: k.close >= k.open ? VOLUME_UP : VOLUME_DOWN }));

export interface ChartLevel {
    label: string;
    price: number;
    color: string;
    dashed: boolean;
}

/** Positive-price read over the CANONICAL parser (utils/analysisUtils) —
 *  range-aware ("3210 - 3220" → midpoint) and annotation-safe, so the chart
 *  overlay reads the same entry value the SL/zone math uses. */
const parsePrice = (v: string | number | undefined): number | null => {
    if (v === undefined || v === null) return null;
    const n = typeof v === 'number' ? v : parsePriceCanonical(String(v));
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The verdict overlay: draw the CURRENT analysis' Entry/SL/TPs on the chart
 * so the surface shows August's own read of the tape, not just candles.
 * Returns [] when there is no verdict or it belongs to a different coin.
 */
export const verdictLevels = (analysis: TradeAnalysis | null | undefined, symbol: string): ChartLevel[] => {
    if (!analysis) return [];
    // Canonical base assets (utils/symbol). The old un-anchored strip mapped a
    // bare 'USDC' coinName to '' and dropped the overlay entirely; baseOf
    // keeps a bare stablecoin whole, and both sides of the comparison now
    // derive their base through the SAME helper.
    const aCoin = baseOf(analysis.coinName || '');
    const sCoin = baseOf(symbol);
    if (!aCoin || aCoin !== sCoin) return [];
    const levels: ChartLevel[] = [];
    const entry = parsePrice(analysis.entryPoints?.[0]?.price);
    if (entry) levels.push({ label: 'Entry', price: entry, color: '#4d9fff', dashed: false });
    const sl = parsePrice(analysis.stopLoss);
    if (sl) levels.push({ label: 'Stop', price: sl, color: '#f6465d', dashed: true });
    // Four lines, as the mock draws them: entry, stop, and at most two
    // targets. A fifth line turned the tape into a ladder of labels.
    (analysis.takeProfit || []).slice(0, 2).forEach((tp, i) => {
        const p = parsePrice(tp.price);
        if (p) levels.push({ label: `TP${i + 1}`, price: p, color: '#0bc67a', dashed: true });
    });
    return levels;
};
/**
 * The verdict the chart overlays its Entry/SL/TP lines with: the newest row that
 * settled a plan.
 *
 * Keyed on Message.proposal — what a tool-bearing turn stamps on its own row
 * (useAnalysisPipeline.ts:1360, chatSurfaceTurn.ts:293). It used to key on the
 * DEBATE shapes (ensembleProgress, more than one modelsUsed entry, debateTurns)
 * and read analysis off the row the verdict finalizer had just settled. That
 * finalizer is deleted and a tool turn never mints a TradeAnalysis, so every new
 * run went quiet while the chart kept reading the prop: a live reader with no
 * live writer. analysis stays as the fallback for rows written before the cut.
 *
 * `symbol` scopes the walk to the coin the chart is drawing. Without it a newer
 * plan for ANOTHER coin shadowed the current one: switching back to the first
 * coin drew no overlay even though its plan was still in the thread.
 */
export const latestChartVerdict = (messages: Message[], symbol?: string | null): TradeAnalysis | null => {
    const wanted = symbol ? baseOf(symbol) : '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const verdict = m.proposal ? buildProposedTradeAnalysis(m.proposal) : m.analysis;
        if (!verdict) continue;
        if (wanted && baseOf(verdict.coinName || '') !== wanted) continue;
        return verdict;
    }
    return null;
};
