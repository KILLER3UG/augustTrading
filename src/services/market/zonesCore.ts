/**
 * zonesCore — support/resistance ZONES and the range state, pure math.
 *
 * Zones are clustered swing pivots (a zone is where the market TURNED more
 * than once, not a line), scored by touches and recency. The range state
 * REUSES `utils/smcStructure.computePremiumDiscount` — the dealing range the
 * packet already prints — and adds the width-vs-ATR and the premium/discount
 * verdict a rotation read needs.
 */

import type { Kline } from '../../types/message';
import { computePremiumDiscount } from '../../utils/smcStructure';
import { findSwings, type SwingPoint } from './swingStructureCore';

export interface SrZone {
    top: number;
    bottom: number;
    kind: 'supply' | 'demand';
    touches: number;
    /** Bars since the zone's most recent touch. */
    ageBars: number;
    /** distance of the zone's near edge from the reference, in ATR units. */
    distanceAtr: number | null;
}

export interface ZonesRead {
    zones: SrZone[];
    /** The declared clustering tolerance, in ATR units. */
    clusterToleranceAtr: number;
    barsUsed: number;
}

/**
 * Cluster swing pivots into zones. Two pivots are the same zone when their
 * prices sit within `clusterToleranceAtr` (default 0.4) of the cluster's
 * current span. A zone with fewer than 2 touches is a swing, not a zone —
 * dropped rather than padded.
 */
export const readSrZones = (
    candles: Kline[],
    atr: number,
    options: { clusterToleranceAtr?: number; lookbackBars?: number; maxZones?: number; reference?: number } = {},
): ZonesRead | null => {
    if (!(atr > 0) || candles.length < 30) return null;
    const tolerance = (options.clusterToleranceAtr ?? 0.4) * atr;
    const maxZones = options.maxZones ?? 6;
    const lookbackBars = options.lookbackBars ?? candles.length;
    const window = candles.slice(Math.max(0, candles.length - lookbackBars));
    const swings = findSwings(window, 2);
    if (swings.length < 4) return null;

    interface Cluster { tops: number[]; bottoms: number[]; kinds: Array<'supply' | 'demand'>; lastIndex: number; count: number }
    const clusters: Cluster[] = [];
    for (const s of swings) {
        const hit = clusters.find(c =>
            s.price >= Math.min(...c.bottoms) - tolerance && s.price <= Math.max(...c.tops) + tolerance);
        if (hit) {
            hit.tops.push(s.price);
            hit.bottoms.push(s.price);
            hit.kinds.push(s.kind === 'high' ? 'supply' : 'demand');
            hit.lastIndex = Math.max(hit.lastIndex, s.index);
            hit.count += 1;
        } else {
            clusters.push({
                tops: [s.price], bottoms: [s.price],
                kinds: [s.kind === 'high' ? 'supply' : 'demand'],
                lastIndex: s.index, count: 1,
            });
        }
    }

    const reference = options.reference ?? window[window.length - 1].close;
    const zones: SrZone[] = clusters
        .filter(c => c.count >= 2)
        .map(c => {
            const top = Math.max(...c.tops);
            const bottom = Math.min(...c.bottoms);
            const nearEdge = Math.abs(top - reference) <= Math.abs(bottom - reference) ? top : bottom;
            // A zone the LAST pivot called demand is labelled by its own kind
            // majority — mixed clusters keep the majority's word.
            const supply = c.kinds.filter(k => k === 'supply').length;
            return {
                top, bottom,
                kind: supply >= c.kinds.length - supply ? 'supply' as const : 'demand' as const,
                touches: c.count,
                ageBars: window.length - 1 - c.lastIndex,
                distanceAtr: Math.round((Math.abs(reference - nearEdge) / atr) * 100) / 100,
            };
        })
        .sort((a, b) => a.distanceAtr - b.distanceAtr)
        .slice(0, maxZones);

    return { zones, clusterToleranceAtr: options.clusterToleranceAtr ?? 0.4, barsUsed: candles.length };
};

export interface RangeStateRead {
    rangeHigh: number;
    rangeLow: number;
    mid: number;
    /** Price position within the dealing range, 0–100 (100 = at the high). */
    positionPct: number;
    verdict: 'premium' | 'discount' | 'equilibrium';
    /** Range width in ATR units. */
    widthAtr: number;
    barsUsed: number;
}

/** The dealing range + premium/discount verdict over the lookback window.
 *  `computePremiumDiscount` already answers this for the packet; the wrap
 *  adds the width-vs-ATR and normalizes the verdict thresholds here
 *  (premium > 55, discount < 45 — a real neutral band, declared). */
export const readRangeState = (candles: Kline[], atr: number, lookback = 60): RangeStateRead | null => {
    if (!(atr > 0) || candles.length < 20) return null;
    const pd = computePremiumDiscount(candles, lookback);
    const ks = candles.slice(0, -1).slice(-lookback);
    if (!pd || ks.length === 0) return null;
    return {
        rangeHigh: pd.rangeHigh,
        rangeLow: pd.rangeLow,
        mid: pd.equilibrium,
        positionPct: Math.round(pd.positionPct * 100) / 100,
        verdict: pd.positionPct > 55 ? 'premium' : pd.positionPct < 45 ? 'discount' : 'equilibrium',
        widthAtr: Math.round(((pd.rangeHigh - pd.rangeLow) / atr) * 100) / 100,
        barsUsed: ks.length,
    };
};

/** Swing-point reuse for callers that want the raw pivots beside the zones. */
export const swingsOf = (candles: Kline[], k = 2): SwingPoint[] => findSwings(candles, k);
