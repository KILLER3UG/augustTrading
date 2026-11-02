/**
 * One candle row, one unit.
 *
 * `KlineService` stores `Kline.time` in epoch MILLISECONDS (the chart divides
 * by 1000 only at the lightweight-charts boundary). The desk tools used to
 * stamp these rows with `phtStamp(k.time * 1000)`, multiplying a millisecond
 * epoch by 1000 again: every bar landed in a far-future year whose month/day
 * cycle scaled with the timeframe, so a 5m series read 3.5 days apart, 1h read
 * 42 days apart and 1d read years apart. The row looked like stale monthly
 * candles while its OHLC was the real tape. The stamp lives here, beside the
 * unit it assumes, so both desk-tool readers share one conversion.
 */

import { phtStamp } from './timezone';

export interface KlineRowInput {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

const rounded = (v: number): number =>
    v >= 1000 ? Math.round(v) : Number(v.toFixed(v >= 1 ? 2 : 4));

/** Compact row for the multi-timeframe compendium: rounded prices + volume. */
export const compactKlineRow = (k: KlineRowInput): string =>
    `${phtStamp(k.time)} O${rounded(k.open)} H${rounded(k.high)} L${rounded(k.low)} C${rounded(k.close)} V${Math.round(k.volume)}`;

/** Full row for get_chart_view: exact OHLC and volume, same PHT stamp. */
export const fullKlineRow = (k: KlineRowInput): string =>
    `${phtStamp(k.time)} O${k.open} H${k.high} L${k.low} C${k.close} V${k.volume}`;
