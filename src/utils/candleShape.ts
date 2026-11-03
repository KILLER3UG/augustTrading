/**
 * candleShape — the ONE OHLC coherence rule, shared by every ingestion path.
 *
 * A candle that violates its own shape (high below the open, a negative price,
 * a non-finite wick) is not a quieter market — it is a broken row, and a
 * resolver or indicator that reads it grades the tape on a price that never
 * printed. Ingestion drops such rows and SAYS SO; it never silently passes
 * them downstream and never silently passes an empty series as data.
 *
 * Consumers: KlineService (the chart/desk tape) and signalMarketData (the
 * signal resolver's OKX/Binance tape). A second implementation of this rule
 * is how the chart and the ledger end up disagreeing about the same bar.
 */

export interface CandleShape {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;

/** One candle is coherent when every field is a finite, positive number and
 *  the wicks actually contain the body: high ≥ open/close ≥ low. */
export const isCoherentCandle = (c: CandleShape): boolean =>
    Number.isFinite(c.time)
    && positive(c.open) && positive(c.high) && positive(c.low) && positive(c.close)
    && c.high >= c.low
    && c.high >= c.open && c.high >= c.close
    && c.low <= c.open && c.low <= c.close;

/** Split a payload into coherent rows and a NAMED count of the rest. The
 *  caller owns the warning — it has the symbol/label this helper never sees.
 *  A payload that is entirely incoherent yields `kept: []`, which every
 *  caller must treat as a failed source, not as an empty market. */
export const coerceCandles = <T extends CandleShape>(rows: readonly T[]): { kept: T[]; dropped: number } => {
    const kept = rows.filter(isCoherentCandle);
    return { kept, dropped: rows.length - kept.length };
};
