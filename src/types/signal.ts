/**
 * The signal ledger vocabulary.
 *
 * A signal is the harness's own call: a direction, three prices and an expiry,
 * emitted by the desk through `emit_signal` and settled later against the tape.
 * It is NOT a journal trade (nothing was executed) and NOT a skill (a single
 * call is not a belief). The ledger is append-only: an emission is one event,
 * its shadow checks are more events, and its resolution is another — nothing is
 * ever rewritten, so a later correction cannot make the record look prescient.
 */

export type SignalDirection = 'long' | 'short';

/** Where a signal stands. `open` means the expiry has not passed and neither
 *  level has been touched; every other value is terminal. There is no
 *  `ambiguous` STATUS — an unknowable bar order resolves stop-first and carries
 *  `ambiguous: true`, so the conservative loss stays a loss. */
export type SignalStatus = 'open' | 'won' | 'lost' | 'expired' | 'never_triggered';

export interface SignalLevels {
    entry: number;
    stop: number;
    target: number;
}

export interface SignalRecord extends SignalLevels {
    id: string;
    coin: string;
    direction: SignalDirection;
    emittedAt: number;
    expiresAt: number;
    /** What the call rests on, as the model stated it (tool names, levels,
     *  notebook files). Checked in shadow — never used to block. */
    evidenceRefs: string[];
    /** FNV-1a of the tape the app knew at emission (coin + live mark + forming
     *  candle). `unavailable` when the turn had no live tape to hash. A hash is
     *  a fingerprint, not a restatement: it proves two emissions saw the same
     *  snapshot, not what the snapshot said. */
    dataHash: string;
    /** The mark the app knew at emission — the number the model could have
     *  seen. Optional because a turn without a live feed has none. */
    markAtEmit?: number;
    provider: string;
    model: string;
    /** The emit_signal prompt revision, so a change in the tool's wording is
     *  visible in the record even when the model id is unchanged. */
    promptVersion: string;
    source: 'signal';
    thesis: string;
    /** The model's own evidence-anchored conviction (1-4, the written rubric
     *  in the tool description), when it self-reported one. Calibration reads
     *  this against outcomeR; absent on rows emitted before the field shipped.
     *  It is a self-report, never a gate. */
    conviction?: number;
}

/** The programmatic gate, run in SHADOW: it never refuses an emission, it
 *  records what it would have said. The resolution fold can then ask whether
 *  the refusals were right — a gate that refuses winners is as costly as one
 *  that passes losers. */
export interface SignalGateShadow {
    status: 'pass' | 'refused' | 'unavailable';
    at: number;
    refusal?: string;
    confidenceCap?: number;
    reason?: string;
}

/** The evidence check, also shadow. `missing` names tool-like refs that are
 *  not real desk tools; prose refs are citations the app cannot machine-check. */
export interface SignalGroundingShadow {
    at: number;
    verdict: 'cited' | 'uncited' | 'missing';
    missing: string[];
}

/** The same bracket geometry entered at every bar of the same tape — the
 *  baseline the signal's hit rate is measured against. `hitRate` uses the
 *  resolver's fill definition (won / (won + lost + expired)). */
export interface SignalBaseRate {
    samples: number;
    hitRate: number;
    horizonBars: number;
    riskPct: number;
    rewardPct: number;
    /** The same tape under a FIXED mechanical rule (SMA20 cross long, the
     *  bracket geometry below), resolved by the same resolver — the
     *  "does the harness beat a fixed rule" baseline (O-08). Absent when the
     *  tape was too short to sample. */
    ruleHitRate?: number;
    ruleFills?: number;
}

export interface SignalResolution {
    status: Exclude<SignalStatus, 'open'>;
    at: number;
    /** Signed R before costs: +R:R on a win, −1 on a stop-price fill, LESS
     *  than −1 when the exit bar opened beyond the stop (the gap rule), and
     *  the mark's signed distance on an expiry. */
    grossR: number;
    /** Round-trip cost in R (taker fee + assumed slippage, both sides). */
    feeR: number;
    /** grossR − feeR. Zero for `never_triggered` (nothing was filled). */
    outcomeR: number;
    /** The coarse bars the decision actually read, ascending by open time. */
    usedBarTimes: number[];
    path: 'bar' | '1m';
    /** Same-bar stop and target with no 1m series to order them (or a 1m bar
     *  that also contains both): settled stop-first. */
    ambiguous: boolean;
    triggeredAt?: number;
    exitAt?: number;
    exitPrice?: number;
    /** The exit bar OPENED beyond the stop, so the fill is the open — the stop
     *  price was never printed. The loss exceeds 1R by the gap. Absent when
     *  the exit filled at the stop or the target. */
    gapAdjusted?: boolean;
    /** Signed R between the trigger bar's OPEN and the assumed entry fill —
     *  how far a real limit fill could have differed from the assumed one
     *  (favorable when the bar gapped through the level in the fill's favor).
     *  Measured on every filled outcome; the fill-realism aggregate reads it. */
    entryOpenR?: number;
    /** The same measure on the exit bar: signed R at the exit bar's OPEN
     *  instead of the assumed exit price. Absent on `never_triggered`. */
    exitOpenR?: number;
    /** OKX (primary) vs Binance (cross-check) over the bars that decided this
     *  resolution. `unavailable` means the cross-check could not run — it is
     *  not agreement. */
    crossCheck: 'agree' | 'disagree' | 'unavailable';
    /** The exchange whose candles decided this row. OKX is primary; a Binance
     *  fallback is named rather than silently substituting, and it always
     *  carries `crossCheck: 'unavailable'` because no second source saw it. */
    primarySource: 'okx' | 'binance';
    /** What the SAME levels would have done entering at every bar of the same
     *  tape. Absent on resolutions written before the accuracy fold shipped and
     *  when the tape was too short to sample. */
    base?: SignalBaseRate;
}

export type SignalEvent =
    | { v: 1; type: 'emit'; at: number; id: string; signal: SignalRecord }
    | { v: 1; type: 'gate'; at: number; id: string; gate: SignalGateShadow }
    | { v: 1; type: 'ground'; at: number; id: string; grounding: SignalGroundingShadow }
    | { v: 1; type: 'resolve'; at: number; id: string; resolution: SignalResolution };

/** One signal folded from its events. `gate`/`grounding` are absent until the
 *  shadow checks land; `resolution` is absent while the signal is open. */
export interface SignalRow {
    signal: SignalRecord;
    gate?: SignalGateShadow;
    grounding?: SignalGroundingShadow;
    resolution?: SignalResolution;
    status: SignalStatus;
}

export interface SignalSummary {
    emitted: number;
    open: number;
    won: number;
    lost: number;
    expired: number;
    neverTriggered: number;
    /** won / (won + lost + expired) — fills only; `never_triggered` is not a
     *  loss. Null when nothing has filled. */
    hitRate: number | null;
    /** Mean `outcomeR` over fills. Null when nothing has filled. */
    expectancyR: number | null;
    /** ambiguous / fills. Null when nothing has filled. */
    ambiguityRate: number | null;
    /** Mean of each resolved signal's own same-levels base rate. Null until at
     *  least one resolution carries a base (added 2026-10-30). */
    baseRate: number | null;
    /** hitRate − baseRate, in probability points. Null when either side is. */
    lift: number | null;
    /** The shadow gate's two sides, resolved: the mean R of emissions it would
     *  have refused vs the ones it passed. Each is null until that side has a
     *  resolved fill — an empty side is not a zero. */
    shadowRefusedR: number | null;
    shadowPassedR: number | null;
}
