/**
 * spotVsPerpCore — deterministic Spot vs. Perpetual taker CVD, basis, and flow regime.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, `localStorage`, or network
 * imports. Aligns closed Spot (`/api/v3/klines`) and Perp (`/fapi/v1/klines`)
 * bars by open timestamp so a missing or delisted spot leg never masquerades
 * as zero delta.
 */

import type { Kline } from '../../types/message';

export type SpotVsPerpRegime =
    | 'spot_absorption'
    | 'perp_chasing'
    | 'aligned_bull'
    | 'aligned_bear'
    | 'neutral';

export interface SpotVsPerpInput {
    symbol: string;
    interval: string;
    spotKlines: readonly Kline[];
    perpKlines: readonly Kline[];
    fundingRate?: number | null;
}

export interface SpotVsPerpResult {
    symbol: string;
    interval: string;
    spotAvailable: boolean;
    alignedBars: number;
    spotBars: number;
    perpBars: number;
    spotCvd: number | null;
    perpCvd: number | null;
    spotDeltaShare: number | null;
    perpDeltaShare: number | null;
    cvdDivergence: number | null;
    basisBps: number | null;
    avgBasisBps: number | null;
    fundingRate: number | null;
    regime: SpotVsPerpRegime;
    summary: string;
    reason?: string;
}

const MIN_ALIGNED_BARS = 5;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

const barDelta = (k: Kline): number => {
    const vol = Number.isFinite(k.volume) && k.volume > 0 ? k.volume : 0;
    if (vol <= 0) return 0;
    if (typeof k.takerBuyVolume === 'number' && Number.isFinite(k.takerBuyVolume)) {
        return 2 * k.takerBuyVolume - vol;
    }
    const range = k.high - k.low;
    if (range > 0) {
        return (((k.close - k.low) - (k.high - k.close)) / range) * vol;
    }
    return 0;
};

const classifySpotPerpRegime = (
    spotDeltaShare: number,
    perpDeltaShare: number,
): SpotVsPerpRegime => {
    if (spotDeltaShare >= 0.05 && perpDeltaShare >= 0.05) return 'aligned_bull';
    if (spotDeltaShare <= -0.05 && perpDeltaShare <= -0.05) return 'aligned_bear';
    // Reserve spot_absorption strictly for bullish spot buying absorbing perp selling.
    if (spotDeltaShare >= 0.06 && perpDeltaShare <= -0.04) {
        return 'spot_absorption';
    }
    if (
        (perpDeltaShare >= 0.08 && spotDeltaShare <= 0.02)
        || (perpDeltaShare <= -0.08 && spotDeltaShare >= -0.02 && spotDeltaShare < 0.06)
    ) {
        return 'perp_chasing';
    }
    return 'neutral';
};

/** Compare aligned closed Spot vs. Perp klines deterministically. */
export const analyzeSpotVsPerp = (input: SpotVsPerpInput): SpotVsPerpResult => {
    const symbol = (input.symbol || '').trim().toUpperCase() || 'UNKNOWN';
    const interval = (input.interval || '').trim() || '15m';
    const spotKlines = input.spotKlines ?? [];
    const perpKlines = input.perpKlines ?? [];
    const fundingRate = typeof input.fundingRate === 'number' && Number.isFinite(input.fundingRate)
        ? input.fundingRate
        : null;

    const perpByTime = new Map<number, Kline>();
    for (const k of perpKlines) {
        if (Number.isFinite(k.time)) perpByTime.set(k.time, k);
    }
    const aligned: Array<{ spot: Kline; perp: Kline }> = [];
    const seen = new Set<number>();
    const spotSorted = [...spotKlines].sort((a, b) => a.time - b.time);
    for (const s of spotSorted) {
        if (!Number.isFinite(s.time) || seen.has(s.time)) continue;
        const p = perpByTime.get(s.time);
        if (!p) continue;
        seen.add(s.time);
        aligned.push({ spot: s, perp: p });
    }

    if (spotKlines.length === 0 || aligned.length < MIN_ALIGNED_BARS) {
        let perpCvdFallback: number | null = null;
        let perpShareFallback: number | null = null;
        if (perpKlines.length > 0) {
            let pCvd = 0;
            let pVol = 0;
            for (const p of perpKlines) {
                const v = Number.isFinite(p.volume) && p.volume > 0 ? p.volume : 0;
                pVol += v;
                pCvd += barDelta(p);
            }
            perpCvdFallback = round2(pCvd);
            perpShareFallback = pVol > 0 ? round4(pCvd / pVol) : 0;
        }
        const reason = spotKlines.length === 0
            ? `spot market klines unavailable or delisted for ${symbol}`
            : `only ${aligned.length} aligned closed bars (need ${MIN_ALIGNED_BARS})`;
        const summary = `${symbol} ${interval} spot_vs_perp: neutral (spot unavailable — ${reason})`;
        return {
            symbol,
            interval,
            spotAvailable: false,
            alignedBars: aligned.length,
            spotBars: spotKlines.length,
            perpBars: perpKlines.length,
            spotCvd: null,
            perpCvd: perpCvdFallback,
            spotDeltaShare: null,
            perpDeltaShare: perpShareFallback,
            cvdDivergence: null,
            basisBps: null,
            avgBasisBps: null,
            fundingRate,
            regime: 'neutral',
            summary,
            reason,
        };
    }

    let spotCvd = 0;
    let perpCvd = 0;
    let spotVol = 0;
    let perpVol = 0;
    let basisSum = 0;
    let basisCount = 0;
    let latestBasisBps: number | null = null;

    for (const { spot, perp } of aligned) {
        const sv = Number.isFinite(spot.volume) && spot.volume > 0 ? spot.volume : 0;
        const pv = Number.isFinite(perp.volume) && perp.volume > 0 ? perp.volume : 0;
        spotVol += sv;
        perpVol += pv;
        spotCvd += barDelta(spot);
        perpCvd += barDelta(perp);
        if (spot.close > 0 && Number.isFinite(perp.close)) {
            const bps = ((perp.close - spot.close) / spot.close) * 10_000;
            basisSum += bps;
            basisCount += 1;
            latestBasisBps = bps;
        }
    }

    const spotShareRaw = spotVol > 0 ? spotCvd / spotVol : 0;
    const perpShareRaw = perpVol > 0 ? perpCvd / perpVol : 0;
    const totalVol = spotVol + perpVol;
    const divRaw = totalVol > 0 ? (perpCvd - spotCvd) / totalVol : 0;
    const avgBasis = basisCount > 0 ? basisSum / basisCount : null;
    const regime = classifySpotPerpRegime(spotShareRaw, perpShareRaw);

    const spotPct = (spotShareRaw * 100).toFixed(1);
    const perpPct = (perpShareRaw * 100).toFixed(1);
    const basisTxt = latestBasisBps !== null ? `${latestBasisBps.toFixed(1)}bps` : 'n/a';
    const fundTxt = fundingRate !== null ? ` · funding ${(fundingRate * 100).toFixed(3)}%` : '';
    const summary = `${symbol} ${interval} spot_vs_perp=${regime} · spotCVD=${spotPct}% vs perpCVD=${perpPct}% · basis=${basisTxt}${fundTxt}`;

    return {
        symbol,
        interval,
        spotAvailable: true,
        alignedBars: aligned.length,
        spotBars: spotKlines.length,
        perpBars: perpKlines.length,
        spotCvd: round2(spotCvd),
        perpCvd: round2(perpCvd),
        spotDeltaShare: round4(spotShareRaw),
        perpDeltaShare: round4(perpShareRaw),
        cvdDivergence: round4(divRaw),
        basisBps: latestBasisBps !== null ? round2(latestBasisBps) : null,
        avgBasisBps: avgBasis !== null ? round2(avgBasis) : null,
        fundingRate,
        regime,
        summary,
    };
};
