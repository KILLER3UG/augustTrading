/**
 * chartIndicatorRegistry — the ONE place a chart study is declared.
 *
 * `chartIndicatorSettings` stores WHICH studies are visible; `chartIndicators`
 * computes their numbers. This file answers the third question the chart kept
 * getting wrong: HOW a study lives — what it creates on the chart, what it
 * paints on the overlay canvas, and what has to be torn down when it is
 * switched off.
 *
 * It exists because "toggling an indicator does nothing" is not one bug, it is
 * a missing contract. A study that creates series has to remove them; a study
 * that paints into the overlay has to reset its ref AND schedule a repaint
 * after the chart has re-laid-out; a study with neither silently advertises a
 * control that cannot fire (the `funding` toggle shipped that way — it was in
 * the menu with no branch behind it). Declaring the delivery here makes each of
 * those a compile-time property rather than a thing to remember.
 *
 * The exhaustive `Record<ChartIndicatorId, …>` is the enforcement: adding an id
 * to `ChartIndicatorId` fails to compile until its lifecycle is declared.
 */

import type { ChartIndicatorId } from './chartIndicatorSettings';
import { CHART_INDICATOR_LABELS } from './chartIndicatorSettings';

/** How a study reaches the screen — and therefore what its teardown is. */
export type IndicatorDelivery =
    /** A line/histogram on the price pane. Teardown: `chart.removeSeries`. */
    | 'main-series'
    /** One or more series on their own pane, which must also be removed. */
    | 'sub-series'
    /** Painted on the overlay canvas by `repaint` from a ref. Teardown: clear
     *  the ref and schedule a repaint — there is no series to remove. */
    | 'overlay'
    /** Declared, toggleable in settings for forward-compatibility, but with no
     *  draw branch yet. Never offered in the menu: a control that cannot fire
     *  is a broken promise. */
    | 'unimplemented';

export interface ChartIndicatorSpec {
    id: ChartIndicatorId;
    label: string;
    delivery: IndicatorDelivery;
    /** Legend keys this study contributes, in reading order. Empty for overlay
     *  studies (they report through their own rows) and for unimplemented ones. */
    legendKeys: readonly string[];
    /** The desk module the model reads the same numbers from, when there is
     *  one. Keeps "the chart and the prompt agree" checkable by eye. */
    source?: string;
}

export const CHART_INDICATOR_REGISTRY: Record<ChartIndicatorId, ChartIndicatorSpec> = {
    volume: { id: 'volume', label: CHART_INDICATOR_LABELS.volume, delivery: 'main-series', legendKeys: ['volume'], source: 'chartData.toVolumes' },
    ema20: { id: 'ema20', label: CHART_INDICATOR_LABELS.ema20, delivery: 'main-series', legendKeys: ['ema20'], source: 'chartIndicators.emaSeries' },
    ema200: { id: 'ema200', label: CHART_INDICATOR_LABELS.ema200, delivery: 'main-series', legendKeys: ['ema200'], source: 'chartIndicators.emaSeries' },
    boll: { id: 'boll', label: CHART_INDICATOR_LABELS.boll, delivery: 'main-series', legendKeys: ['bollMid', 'bollUpper', 'bollLower'], source: 'chartIndicators.bollingerSeries' },
    rsi: { id: 'rsi', label: CHART_INDICATOR_LABELS.rsi, delivery: 'sub-series', legendKeys: ['rsi6', 'rsi14', 'rsi24'], source: 'chartIndicators.rsiSeries' },
    macd: { id: 'macd', label: CHART_INDICATOR_LABELS.macd, delivery: 'sub-series', legendKeys: ['macdHist', 'macd', 'macdSignal'], source: 'chartIndicators.macdSeries' },
    tsi: { id: 'tsi', label: CHART_INDICATOR_LABELS.tsi, delivery: 'sub-series', legendKeys: ['tsi', 'tsiSignal'], source: 'chartIndicators.tsiSeries' },
    vwap: { id: 'vwap', label: CHART_INDICATOR_LABELS.vwap, delivery: 'main-series', legendKeys: ['vwap'], source: 'chartIndicators.vwapSeries' },
    avwap: { id: 'avwap', label: CHART_INDICATOR_LABELS.avwap, delivery: 'main-series', legendKeys: ['avwap'], source: 'chartIndicators.vwapSeries' },
    volumeProfile: { id: 'volumeProfile', label: CHART_INDICATOR_LABELS.volumeProfile, delivery: 'overlay', legendKeys: [], source: 'volumeProfileCore.buildVolumeProfile' },
    volumeProfileSession: { id: 'volumeProfileSession', label: CHART_INDICATOR_LABELS.volumeProfileSession, delivery: 'overlay', legendKeys: [], source: 'volumeProfileCore.buildVolumeProfile' },
    sessionLevels: { id: 'sessionLevels', label: CHART_INDICATOR_LABELS.sessionLevels, delivery: 'overlay', legendKeys: [], source: 'levelsCore.sessionLevelRows' },
    swings: { id: 'swings', label: CHART_INDICATOR_LABELS.swings, delivery: 'overlay', legendKeys: [], source: 'swingStructureCore.readStructure' },
    cvd: { id: 'cvd', label: CHART_INDICATOR_LABELS.cvd, delivery: 'sub-series', legendKeys: ['cvdDelta', 'cvd'], source: 'orderFlowCore.candleDelta' },
    // No draw branch exists. Offered in the menu it would be a control that
    // cannot fire — see `offerableIndicatorIds`.
    funding: { id: 'funding', label: CHART_INDICATOR_LABELS.funding, delivery: 'unimplemented', legendKeys: [] },
};

/** Every study the menu may offer: implemented, with a real draw path. */
export const offerableIndicatorIds: readonly ChartIndicatorId[] =
    (Object.keys(CHART_INDICATOR_REGISTRY) as ChartIndicatorId[])
        .filter(id => CHART_INDICATOR_REGISTRY[id].delivery !== 'unimplemented');

/** Studies that own series on the chart (and therefore need `removeSeries`). */
export const seriesIndicatorIds: readonly ChartIndicatorId[] =
    (Object.keys(CHART_INDICATOR_REGISTRY) as ChartIndicatorId[])
        .filter(id => {
            const delivery = CHART_INDICATOR_REGISTRY[id].delivery;
            return delivery === 'main-series' || delivery === 'sub-series';
        });

/** Studies painted on the overlay canvas (and therefore need a ref reset plus a
 *  scheduled repaint rather than a series teardown). */
export const overlayIndicatorIds: readonly ChartIndicatorId[] =
    (Object.keys(CHART_INDICATOR_REGISTRY) as ChartIndicatorId[])
        .filter(id => CHART_INDICATOR_REGISTRY[id].delivery === 'overlay');

/** The legend keys a given visibility set contributes, in registry order. */
export const legendKeysFor = (
    visible: Readonly<Record<ChartIndicatorId, boolean>>,
): string[] => offerableIndicatorIds
    .filter(id => visible[id])
    .flatMap(id => [...CHART_INDICATOR_REGISTRY[id].legendKeys]);
