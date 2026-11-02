/**
 * The tracked-position vocabulary.
 *
 * A TrackedPosition is the harness's own record of ONE plan followed until it
 * closes. It is not a LoggedTrade (the journal records the trader's decision)
 * and not a SignalRecord (the ledger records the desk's call); it is the live
 * state that lets either be graded against the tape after the fact.
 *
 * TWO RULES this file encodes:
 *  · MFE is >= 0 and MAE is <= 0, both in R, both measured over the HELD
 *    window only. `null` means "not measured" and must never print as 0.
 *  · A gap is a CONDITION of an exit, not a sixth reason: a stop hit through a
 *    gap is still `reason: 'stop'` with `gapAtOpen: true`, so the reason and
 *    the fill quality stay separately readable.
 */

export type TrackedSource = 'signal' | 'journal';

/** `pending_entry` is a plan whose limit has not been touched. `cancelled` is
 *  a plan that never filled (or an inverted plan the resolver refused); it is
 *  not a win or a loss and must not enter a win rate. */
export type TrackedStatus = 'pending_entry' | 'open' | 'closed' | 'expired' | 'cancelled';

export type TrackedDirection = 'long' | 'short';

export type ExitReason = 'target' | 'stop' | 'expiry' | 'manual';

/** How the bar that decided the exit was ordered. `stop-first` is the
 *  conservative policy when the order is unknowable, never a claim that the
 *  stop actually traded first. */
export type SameCandleResolution = 'single-level' | 'stop-first' | 'ordered-1m';

export type DiagnosisOutcome = 'win' | 'loss' | 'breakeven';

/** The one thing the post-mortem says should change. The prose field says
 *  what; this field makes the diagnosis filterable and makes a cluster of
 *  lessons countable. */
export type DiagnosisChange = 'entry' | 'stop' | 'target' | 'sizing' | 'skip' | 'hold';

export type DiagnosisRefusal = 'thin-tape' | 'no-lesson' | 'malformed';

/** One closed 5m bar on the path. `decisive` marks a bar the diagnosis must
 *  keep when the path is downsampled (entry, MFE, MAE, exit, a bar after a
 *  gap). */
export interface TrackPoint {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v?: number;
    decisive?: boolean;
}

/** A higher-timeframe/context reading. `spread` and `news` are optional
 *  because the app only has them when they were captured at the time; an
 *  absent field is "not captured", never zero. */
export interface TrackedContextPoint {
    at: number;
    timeframe: '15m' | '1h' | '4h' | '1d';
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    indicators?: Record<string, number>;
    funding?: number;
    openInterest?: number;
    spread?: number;
    news?: string[];
}

/** What the model saw when the plan was made. Kept small on purpose: a
 *  pointer to the analysis and the thesis is enough; the full transcript
 *  already lives in the conversation store. */
export interface TrackedEntryContext {
    thesis: string;
    evidenceRefs: string[];
    model?: string;
    provider?: string;
    promptVersion?: string;
    /** The setup family used by independence/dedupe. Signals have none, so a
     *  caller falls back to `symbol|direction`. */
    family?: string;
    /** The originating run, for skill attribution. */
    runId?: string;
    /** The skills that rode the prompt on the entry turn. */
    injectedSkills?: string[];
    /** A compact snapshot of the inputs the seat read at entry. */
    snapshot?: Record<string, unknown>;
}

export interface TrackedExit {
    reason: ExitReason;
    /** The fill, after a gap adjustment where one applied. */
    price: number;
    /** Bar open time of the deciding bar. */
    at: number;
    sameCandle: SameCandleResolution;
    /** True when the same bar touched both levels and no complete 1m series
     *  could order them. The policy is stop-first; the flag says it was a
     *  policy, not an observation. */
    ambiguous: boolean;
    /** True when the deciding bar opened beyond the level (a stop fills
     *  worse, a target fills better). */
    gapAtOpen: boolean;
    /** Closed bars read for this resolution. */
    barsRead: number;
    /** Gross price-measured R, before costs. Null when unmeasurable. */
    realizedR: number | null;
    /** Round-trip cost in R. Null when the cost model cannot compute it. */
    costR: number | null;
    /** realizedR − costR, or null. */
    netR: number | null;
    /** True only for the signal cost model, which includes assumed slippage.
     *  The journal cost model is fee-only and labels slippage as not modelled. */
    slippageModeled: boolean;
}

export interface TrackedPosition {
    id: string;
    source: TrackedSource;
    /** `SignalRecord.id` or the journal trade/plan id. */
    sourceId: string;
    symbol: string;
    direction: TrackedDirection;
    entry: number;
    stop: number;
    /** One target for a signal; the ladder for a journal trade. */
    targets: number[];
    expiresAt?: number;
    /** Planned size, journal only. Signals omit it rather than inventing one. */
    size?: number;
    leverage?: number;
    plannedRiskUsd?: number;
    plannedNotionalUsd?: number;
    status: TrackedStatus;
    /** When the decision was made (signal emission time, or the journal plan
     *  time), NOT when this row was written. */
    openedAt: number;
    closedAt?: number;
    /** Bar open time of the bar that filled the entry. */
    entryBarTime?: number;
    /** True when the trader confirmed the entry (a logged journal trade).
     *  False for a signal or a plan waiting on a limit touch. */
    entryConfirmed: boolean;
    /** True when the entry candle's open was not already executable, so its
     *  extremes may include price action before the fill. */
    entryBarAmbiguous?: boolean;
    entryContext: TrackedEntryContext;
    cursor: {
        lastClosedBarTime: number;
        timeframe: '5m';
    };
    /** Max favourable excursion, in R, >= 0. Null = unmeasured. */
    mfeR: number | null;
    /** Max adverse excursion, in R, <= 0. Null = unmeasured. */
    maeR: number | null;
    mfePrice: number | null;
    maePrice: number | null;
    mfeAt: number | null;
    maeAt: number | null;
    /** Closed bars read for the lifetime of this position. */
    barsRead: number;
    /** Bar open times of missing 5m bars inside the tracked window, capped. */
    gaps: number[];
    /** False when the fetched tape starts after the entry window; the exit is
     *  then NOT resolvable from this tape. */
    tapeCoversWindow: boolean;
    /** Decisive bars plus a downsampled path, capped at
     *  `TRACKED_TIMELINE_MAX_POINTS`. */
    timeline: TrackPoint[];
    timelineDownsampled: boolean;
    timelinePointsDropped: number;
    /** Higher-timeframe/context readings, capped at
     *  `TRACKED_CONTEXT_MAX_POINTS`. */
    context: TrackedContextPoint[];
    contextDownsampled: boolean;
    exit?: TrackedExit;
    /** Journal only: when the journal row itself reached a settled outcome.
     *  A diagnosis is queued only after this is set, so the post-mortem and
     *  the journal row cannot disagree about whether the trade closed. */
    journalSettledAt?: number;
    diagnosisId?: string;
    skillIds?: string[];
    /** A recorded disagreement with the deterministic resolver, or a reason a
     *  plan was refused. Never silently overwritten. */
    discrepancy?: string;
    version: 1;
}

/** What the journal currently says about a tracked row, read through the
 *  bridge the app mounts. `null` from the bridge means the row is not present. */
export interface JournalOutcomeSnapshot {
    outcome: 'PENDING' | 'WIN' | 'LOSS' | 'ENTRY_NOT_HIT' | 'SKIPPED';
    resolvedAt?: string;
}

/** The tracker's settlement payload for a journal row. The journal's existing
 *  funnel turns this into the row's outcome, R, costs and excursions. */
export interface JournalSettlement {
    outcome: 'WIN' | 'LOSS';
    exitPrice?: number;
    exitAt?: number;
    /** ISO timestamp when the outcome became known (the exit bar's close). */
    resolvedAt: string;
    realizedR?: number;
    costR?: number;
    netR?: number;
    /** RAW price percent; the journal applies leverage once. */
    excursions?: { maePercent: number; mfePercent: number };
}

/** The six fields the post-mortem prompt asks for, plus the two the existing
 *  skill parser needs (`when`/`action`). `noLesson` is the honest decline. */
export interface TrackedDiagnosisAnswer {
    outcome: DiagnosisOutcome;
    whatHappened: string;
    rootCause: string;
    whatShouldHaveBeenDone: string;
    primaryChange: DiagnosisChange;
    lesson: string;
    when: string;
    action: string;
    confidence: number;
    evidenceRefs?: string[];
    noLesson?: boolean;
}

/** The stored diagnosis: the answer plus provenance. */
export interface TrackedDiagnosis extends TrackedDiagnosisAnswer {
    id: string;
    tradeId: string;
    source: TrackedSource;
    /** The outcome the MODEL claimed. The stored `outcome` is the tape's /
     *  journal's authoritative one; this field keeps a disagreement visible
     *  instead of letting the model overrule a measured result. */
    modelOutcome?: DiagnosisOutcome;
    evidenceCount: number;
    model?: string;
    provider?: string;
    promptVersion?: string;
    /** Hash of the exact packet the model read. */
    packetHash?: string;
    createdAt: string;
    /** True until the evidence threshold is met. */
    tentative: boolean;
    /** Present only on a refused diagnosis; a refusal is a record, not a gap. */
    refusal?: DiagnosisRefusal;
}

/** One diagnosis waiting for a model call. Overflow from the per-pass cap
 *  stays here; it is never dropped because a pass was busy. */
export interface DiagnosisQueueItem {
    id: string;
    tradeId: string;
    /** Source of the tracked position. Optional on rows queued before the
     *  field existed; a missing position can then still be attributed. */
    source?: TrackedSource;
    queuedAt: number;
    attempts: number;
    status: 'pending' | 'running' | 'done' | 'failed';
    lastError?: string;
    startedAt?: number;
    finishedAt?: number;
}

/** A closed outcome as the independence rule sees it. */
export interface TrackedOutcomeWindow {
    id: string;
    /** The setup family, or `symbol|direction` when no family was recorded. */
    setupKey: string;
    openedAt: number;
    closedAt: number;
}

/** One independent outcome counted toward a tentative skill. The counts are
 *  already converted to the skill ledger's units; the skill writer must not
 *  recompute them from a different price. */
export interface DiagnosisSkillEvidence {
    tradeId: string;
    outcome: 'win' | 'loss';
    grossR?: number;
    netR?: number;
    stopDistancePct?: number;
    at: string;
    setup: {
        coin?: string;
        direction?: 'Long' | 'Short';
        family?: string;
        regime?: string;
    };
}

/** Hard per-position cap on the stored path. Decisive bars are retained
 *  first; the rest is an even sample. */
export const TRACKED_TIMELINE_MAX_POINTS = 240;

/** Hard per-position cap on higher-timeframe context readings. */
export const TRACKED_CONTEXT_MAX_POINTS = 60;

/** Closed positions kept on disk; open positions are never pruned. The
 *  diagnoses are the audit trail and are NOT count-pruned. */
export const TRACKED_MAX_CLOSED_POSITIONS = 100;

export const TRACKED_STORE_VERSION = 1 as const;
