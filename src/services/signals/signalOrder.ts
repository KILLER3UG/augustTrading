/**
 * signalOrder — the settlement queue's ordering, as a pure function.
 *
 * `settleDueSignals` used to slice the ledger's NEWEST-first fold, so every
 * pass graded the four newest open signals and an old open one could sit
 * ungraded until the ledger's 150-cap pruned it whole — survivorship bias in
 * the accuracy numbers, shrinking the scorecard's denominator exactly where
 * the record was weakest. The oldest open rows go first; a resolved row never
 * re-enters the queue; the cap stays with the caller.
 *
 * Pure so check:contracts pins it bundled (signalService itself drags the
 * fetch layer, which no contract needs).
 */

export interface OrderableSignalRow {
    status: string;
    signal: { emittedAt: number };
}

/** The rows a settlement pass should attempt, OLDEST-FIRST by emission. */
export const openSignalsOldestFirst = <T extends OrderableSignalRow>(rows: readonly T[]): T[] =>
    rows
        .filter(r => r.status === 'open')
        .sort((a, b) => a.signal.emittedAt - b.signal.emittedAt);
