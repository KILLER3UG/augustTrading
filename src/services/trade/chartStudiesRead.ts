/**
 * chartStudiesRead — the chart's studies as the MODEL reads them.
 *
 * The chart draws its studies from `chartIndicators` and the desk cores
 * (`levelsCore`, `swingStructureCore`, `volumeProfileCore`, `orderFlowCore`).
 * This module is the SAME computation over the same klines, shaped for a
 * prompt: one line per study, last value, no per-candle series.
 *
 * Why it exists: before it, a trader could turn on Session levels or Swings and
 * see them on the chart while the model had no idea they existed — the chart
 * and the seat were looking at different markets. The values here are the
 * values on the line, because they come from the same cores.
 *
 * PURE: klines in, a read out. No chart, no React, no I/O.
 */

import type { Kline } from '../analysis/MarketDataService';
import {
    atrOf,
    bollingerSeries,
    emaSeries,
    lastOf,
    macdSeries,
    rsiSeries,
    tsiSeries,
    vwapSeries,
} from './chartIndicators';
import { buildVolumeProfile } from '../market/volumeProfileCore';
import { candleDelta } from '../market/orderFlowCore';
import { sessionLevelRows, type LevelRow } from '../market/levelsCore';
import { readStructure, type StructureRead } from '../market/swingStructureCore';

const fmt = (v: number | null, dp = 2): string => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(dp));

export interface ChartStudiesRead {
    symbol: string;
    timeframe: string;
    bars: number;
    /** The last close the read is taken at. */
    price: number | null;
    atr: number | null;
    ema: { ema20: string; ema200: string };
    bollinger: { mid: string; upper: string; lower: string };
    rsi: { rsi6: string; rsi14: string; rsi24: string };
    macd: { dif: string; dea: string; macd: string };
    tsi: { tsi: string; signal: string };
    vwap: { session: string };
    cvd: string;
    volumeProfile: { poc: string; valueAreaHigh: string; valueAreaLow: string } | null;
    sessionLevels: LevelRow[];
    structure: StructureRead | null;
}

/** The study set over one kline series. This computes every implemented
 *  study; it does NOT read the chart's visibility record (there is no
 *  `visible` parameter). `get_chart_studies` therefore tells the model what
 *  the studies ARE, not only the subset the trader has toggled on — a
 *  distinction worth keeping honest until the registry's visibility is
 *  threaded through. */
export const readChartStudies = (
    klines: readonly Kline[],
    symbol: string,
    timeframe: string,
): ChartStudiesRead => {
    const ks = klines as Kline[];
    const closes = ks.map(k => k.close);
    const lastClose = closes.length > 0 ? closes[closes.length - 1] : null;
    const atr = atrOf(ks.map(k => k.high), ks.map(k => k.low), closes);
    const tolerance = (atr ?? Math.abs(lastClose ?? 0) * 0.002) * 0.5;

    const ema20 = emaSeries(closes, 20);
    const ema200 = emaSeries(closes, 200);
    const band = bollingerSeries(closes, 20, 2);
    const rsi6 = rsiSeries(closes, 6);
    const rsi14 = rsiSeries(closes, 14);
    const rsi24 = rsiSeries(closes, 24);
    const macd = macdSeries(closes);
    const tsi = tsiSeries(closes);
    // `vwapSeries` resets at a UTC day boundary and works in SECONDS (the
    // chart's UTCTimestamp convention); `Kline.time` is ms. Convert for that
    // one call so the session VWAP resets on the same day the chart's does.
    // `sessionLevelRows` wants ms, so it gets `ks` untouched.
    const vwap = vwapSeries(ks.map(k => ({ ...k, time: k.time / 1000 })));
    const delta = ks.map(k => candleDelta({ ...k, volume: k.volume ?? 0 }));
    let cumulative = 0;
    let lastDelta: number | null = null;
    for (const d of delta) {
        if (d !== null) { cumulative += d; lastDelta = cumulative; }
    }
    const profile = buildVolumeProfile(ks, { bins: 48 });
    const levels = lastClose === null ? [] : sessionLevelRows(ks, Date.now(), lastClose, atr, tolerance);
    const structure = readStructure(ks, 2);

    return {
        symbol,
        timeframe,
        bars: ks.length,
        price: lastClose,
        atr,
        ema: { ema20: fmt(lastOf(ema20)), ema200: fmt(lastOf(ema200)) },
        bollinger: { mid: fmt(lastOf(band.mid)), upper: fmt(lastOf(band.upper)), lower: fmt(lastOf(band.lower)) },
        rsi: { rsi6: fmt(lastOf(rsi6)), rsi14: fmt(lastOf(rsi14)), rsi24: fmt(lastOf(rsi24)) },
        // OKX's row: DIF is the MACD line, DEA its signal, MACD the histogram
        // DOUBLED (2·(DIF−DEA)). `chartIndicators` keeps the histogram at 1×
        // for library parity, so the doubling is a display convention.
        macd: (() => {
            const dif = lastOf(macd.macd);
            const dea = lastOf(macd.signal);
            const hist = dif !== null && dea !== null ? 2 * (dif - dea) : null;
            return { dif: fmt(dif, 1), dea: fmt(dea, 1), macd: fmt(hist, 1) };
        })(),
        tsi: { tsi: fmt(lastOf(tsi.tsi)), signal: fmt(lastOf(tsi.signal)) },
        vwap: { session: fmt(lastOf(vwap)) },
        cvd: lastDelta === null ? '—' : Math.round(lastDelta).toLocaleString(),
        volumeProfile: profile
            ? { poc: fmt(profile.poc), valueAreaHigh: fmt(profile.valueAreaHigh), valueAreaLow: fmt(profile.valueAreaLow) }
            : null,
        sessionLevels: levels,
        structure,
    };
};

/** The read as prompt lines: one study per line, OKX's names. */
export const formatChartStudies = (read: ChartStudiesRead): string => {
    const lines: string[] = [`CHART STUDIES ${read.symbol} ${read.timeframe} — ${read.bars} bars, last ${fmt(read.price)}`];
    lines.push(`EMA(20) ${read.ema.ema20}  EMA(200) ${read.ema.ema200}`);
    lines.push(`BOLL ${read.bollinger.mid}  UB ${read.bollinger.upper}  LB ${read.bollinger.lower}`);
    lines.push(`RSI(6) ${read.rsi.rsi6}  RSI(14) ${read.rsi.rsi14}  RSI(24) ${read.rsi.rsi24}`);
    lines.push(`MACD ${read.macd.macd}  DIF ${read.macd.dif}  DEA ${read.macd.dea}`);
    lines.push(`TSI(25,13,13) ${read.tsi.tsi}  Signal ${read.tsi.signal}`);
    lines.push(`ATR(14) ${fmt(read.atr)}  VWAP ${read.vwap.session}  CVD ${read.cvd}`);
    if (read.volumeProfile) {
        lines.push(`VOLUME PROFILE  POC ${read.volumeProfile.poc}  VAH ${read.volumeProfile.valueAreaHigh}  VAL ${read.volumeProfile.valueAreaLow}`);
    }
    if (read.sessionLevels.length > 0) {
        const nearest = [...read.sessionLevels].sort((a, b) => a.distance - b.distance).slice(0, 4);
        lines.push(`SESSION LEVELS  ${nearest.map(l => `${l.label} ${fmt(l.price)}`).join('  ')}`);
    }
    if (read.structure) {
        lines.push(`STRUCTURE  ${read.structure.trend}${read.structure.lastBreak
            ? ` — last ${read.structure.lastBreak.kind} ${read.structure.lastBreak.direction} at ${fmt(read.structure.lastBreak.level)}`
            : ''}`);
    }
    return lines.join('\n');
};
