// Trade logging, conversation, and dashboard types

import { TradeOutcome } from './enums';
import { TradeAnalysis } from './analysis';
import { Message, DebateTurn, PatternMemoryGateView } from './message';
import { RootCauseClass } from './learning';

/**
 * Benchmark-relative alpha settled at outcome time (skill vs tide): the
 * trade's realized direction-adjusted move minus what buy-and-hold of the
 * benchmark (BTCUSDT; ETHUSDT for ETH pairs) returned over the same window.
 * `alphaPct` NaN with `unavailableReason` set means the benchmark could not
 * be fetched — a measurement gap is recorded as a gap, never as a number.
 */
export interface BenchmarkAlpha {
  benchmarkSymbol: string;
  /** Benchmark buy-and-hold return over the window, percent. */
  benchmarkPct: number;
  /** The trade's unleveraged direction-adjusted move, percent. */
  tradePct: number;
  /** tradePct − benchmarkPct (NaN when unavailable). */
  alphaPct: number;
  /** Entry→exit window in ms. */
  windowMs: number;
  unavailableReason?: string;
}

/** Where the row came from. Staged for the signal fold: `imported` history is
 *  user behaviour and must never confirm a playbook; `signal` is reserved for
 *  the ledger. Absent on legacy rows — a reader defaults it to `manual`. */
export type TradeSource = 'manual' | 'imported' | 'signal';

export interface LoggedTrade {
  id: string;
  /** Provenance of the row. Optional for legacy rows; every reader defaults
   *  an absent value to 'manual' (see `normalizeTradeSource`). */
  source?: TradeSource;
  analysis: TradeAnalysis;
  /** Pattern-memory gate outcome at analysis time (journal badge). */
  patternMemoryGate?: PatternMemoryGateView;
  /** Prompt-layer fingerprint from the originating run (journal A/B). */
  promptVersion?: string;
  promptLane?: 'live' | 'control';
  /** RunId of the originating verdict run (runStats.runId). Skill
   *  evidence attribution joins the injection log on THIS — exact — instead
   *  of a time window around the log click. Absent on legacy trades. */
  sourceRunId?: string;
  tradeType?: 'scalp' | 'swing';  // Denormalized for filtering/stats
  outcome: TradeOutcome;
  /** When this row was LOGGED. Not the outcome time — see `outcomeResolvedAt`. */
  timestamp: string;
  /**
   * When the DECISION was made (`analysis.createdAt`, else the message time).
   * Distinct from `timestamp`: an autopilot row confirmed on Friday for a plan
   * decided Monday must land on Monday in every time-bucketed view. Absent on
   * legacy rows; read it through `decidedAtOf()` so the fallback lives once.
   */
  decidedAt?: string;
  /**
   * The id of the plan this trade came from (`Message.planId`, minted by the
   * dock's `present_trade` and shared with the level-watch). Absent on rows
   * logged before stage 3 and on trades the trader logged by hand.
   */
  planId?: string;
  /**
   * When the outcome BECAME KNOWN — the autopilot's detection time, or the
   * moment a human set the outcome. Distinct from `timestamp` (when the row was
   * written): a trade confirmed an hour after it was logged must not read as if
   * the result was known at log time, and a replayed run must be able to tell
   * the two apart.
   */
  outcomeResolvedAt?: string;
  /**
   * Who or what wrote the outcome: the autopilot's automatic settlement, a
   * human's manual log/confirm, or a later human correction. The ledger keeps
   * the distinction so an automatic mistake is auditable and never looks like
   * a trader's own call.
   */
  resolutionSource?: 'autopilot' | 'manual' | 'correction' | 'tracker';
  /** On a correction: the outcome this row carried before the trader changed it. */
  correctedFrom?: TradeOutcome;
  /** On a correction: when the trader changed it. */
  correctedAt?: string;
  leverage?: number;
  postMortem?: string;
  postMortemCreatedAt?: string; // Timestamp for post-mortem analysis
  postMortemImages?: string[]; // To store screenshots from the post-mortem upload
  /**
   * Per-provider post-mortem analyst reports, keyed by provider display
   * name. Captured at generation time so the EXTRACT_INSIGHTS job can
   * attribute knowledge-base insights to the AI that produced them
   * (by-provider quality tracking in the Knowledge Base card).
   */
  postMortemByProvider?: Record<string, string>;
  /**
   * Which model WROTE `postMortem` (E-57 §1). Set only by the settlement
   * reflection, and absent on every row written before it — which is the whole
   * point of keeping it separate from `postMortemByProvider`, the legacy
   * per-provider analyst map that means a different thing.
   *
   * A note the app authored must never read as a note the trader wrote: the
   * journal prints this beside the text, and `craftSkillFromPostMortem` drafts a
   * skill from it, so the row says who is speaking.
   */
  postMortemModel?: string;
  /**
   * Forensic class from the post-mortem blame split. Execution and macro
   * shocks must not become technical playbook rules.
   */
  rootCauseClass?: RootCauseClass;
  correctedEntry?: string;
  correctedStopLoss?: string;
  correctedTakeProfit?: string;
  investmentAmount?: number;
  pnlAmount?: number;
  /**
   * PnL expressed as a leveraged percent (e.g. +200 = +200%) when only a
   * percent is known (outcome autopilot). Distinct from pnlAmount (dollars) —
   * writing a percent into pnlAmount corrupts dashboard PnL math.
   */
  pnlPercent?: number;
  /**
   * Benchmark-relative alpha (skill vs tide) settled when the outcome was
   * verified against real candles. Absent on trades logged before this
   * feature, or where the benchmark fetch was unavailable.
   */
  benchmark?: BenchmarkAlpha;
  marketSnapshot?: unknown; // Stored market context for algorithmic recalculation
  // Ensemble fields — keyed by provider id (ProviderConfig.id)
  modelsUsed?: Record<string, string>;       // providerId → model id
  thoughtProcesses?: Record<string, string>; // providerId → thought process text
  // Legacy per-provider fields (kept for historical data migration)
  geminiModelUsed?: string;
  deepseekModelUsed?: string;
  zhipuModelUsed?: string;
  groqModelUsed?: string;
  groqNewModelUsed?: string;
  groqAlt2ModelUsed?: string;
  openrouterModelUsed?: string;

  ocrModelUsed?: string;
  moderatorProvider?: string;  // ProviderConfig id (historical values like 'gemini' remain valid strings)
  moderatorModel?: string;

  // Debate transcript — the full debate turns
  // Stored for training data and outcome-correlated reasoning analysis
  debateTurns?: DebateTurn[];

  // Mode Tracking
  /**
   * Indicates if this trade hit the 150% extended SL zone.
   * true = hit 150% zone (REAL LOSS in live trading)
   * undefined/false = normal SL behavior
   */
  extendedSLZoneBreach?: boolean;
  /**
   * Market regime at time of trade for accurate performance tracking.
   * Absent means NO regime was observed — readers must skip the row, never
   * default it to 'ranging'.
   */
  marketRegime?: 'trending' | 'ranging' | 'volatile' | 'compression';
  /**
   * How `marketRegime` was learned: from the live hybrid packet, from the
   * regime ledger (this coin's nearest observation, day-granular), or from the
   * analysis's own pattern text. Provenance, not decoration — a regime
   * resolved from a ledger row three days old is weaker evidence than one the
   * packet named at log time, and a reader may want to treat them apart.
   */
  marketRegimeSource?: 'snapshot' | 'ledger' | 'analysis';
  /**
   * Post-mortem insight quality scores per provider (0-100).
   * Used to track which models provide actionable post-mortem insights.
   */
  postMortemProviderScores?: Record<string, number>;
  /**
   * SL Optimization Data - tracks stop loss behavior for optimization.
   * Populated when trade outcome is recorded with price data.
   */
  slOptimizationData?: {
    slWasTouched: boolean;             // Did price touch original SL?
    extendedZoneBreached: boolean;     // Exceeded 150% zone?
    missedWinDueToTightSL: boolean;    // Would have won with wider SL?
    /** Approximate: reconstructed from entry plus the observed hit prices, NOT
     *  candle extremes. The authoritative figure is the top-level
     *  `LoggedTrade.maxAdverseExcursion`, measured over the live window. */
    maxAdverseExcursion: number;       // Max price movement against position (%)
    minSlDistanceNeeded?: number;      // If missed win, what SL % would have saved it
    atrMultiplierUsed: number;         // ATR multiplier of original SL
  };
  /**
   * Indices of which entry points were actually triggered/filled.
   * When trade has multiple entries, tracks which one(s) the user confirmed were hit.
   * Example: [0] = Entry 1 only, [1] = Entry 2 only, [0, 1] = Both entries filled.
   */
  triggeredEntryIndices?: number[];

  // ===== Journal discipline fields (Batch 5, — all optional) =====
  /** What went wrong, in the trader's own taxonomy. Drives the mistake-cost table. */
  mistakeTags?: ('failed_thesis' | 'boredom' | 'overtrading' | 'greed' | 'revenge' | 'moved_stop' | 'early_entry' | 'late_exit')[];
  /** Self-rated state at entry (quick-tap at capture time). */
  emotionalState?: 'calm' | 'confident' | 'anxious' | 'frustrated' | 'tilted' | 'fomo';
  /** Did the executed trade match the published plan? Drives the adherence split. */
  followedPlan?: boolean;
  /** What deviated, when followedPlan is false. */
  planDeviationNote?: string;
  /** Realized R-multiple — computed at log time from entry/SL/pnl (deterministic util). */
  rMultiple?: number;
  /**
   * R measured from PRICE levels only (raw move / raw stop distance), written
   * when the post-mortem's candle validation resolves a real exit. Unlike
   * `rMultiple`, it never divides a leveraged percent by an unleveraged one,
   * so it is the only R safe to accumulate into the skill ledger.
   */
  realizedR?: number;
  /**
   * Which writer measured `realizedR`, and which measured the excursion pair
   * below. The outcome autopilot and the post-mortem compute the SAME arithmetic
   * over (possibly) different tape, so a row must never silently trade one
   * answer for the other: first writer wins, and the field says who. Absent on
   * rows written before stage 3.
   */
  rSource?: 'autopilot' | 'postMortem' | 'tracker';
  excursionSource?: 'autopilot' | 'postMortem' | 'tracker';
  /**
   * The round-trip COST of this trade, in R, when it could be computed.
   *
   * The app had no cost model at all before this: every R on the row — and
   * every expectancy built from them — was GROSS, so a 0.10 % round trip
   * against a 1 % stop (0.10 R) was invisible. `costR` is that charge, in R,
   * from `utils/netRiskReward`.
   *
   * ABSENT when the cost could not be computed (the stop distance is
   * unknown) — a gap, never a zero. `costUnknown` says which.
   */
  costR?: number;
  /**
   * The NET R multiple — `realizedR` (GROSS) minus `costR`.
   *
   * `realizedR` stays the gross view on purpose: it is the price-measured
   * quantity the outcome engines produced, and rewriting it would make the
   * stored number disagree with the tape it was measured against. `netR` is
   * the cost-adjusted sibling, and the ledgers that grade a strategy should
   * read THIS one.
   */
  netR?: number;
  /**
   * ALWAYS `false`. The cost model charges fees only — slippage is NOT
   * modelled, and a stored `false` is how that stays visible to every reader
   * instead of being an unlabelled zero.
   */
  slippageModeled?: false;
  /** Why the cost could not be computed. Absent when it was. */
  costUnknown?: 'stop-distance' | 'fee' | 'gross-r';
  /**
   * The app's SUGGESTED risk for this trade, in dollars: the trader's equity
   * × their risk % × the ticket fraction, with the exchange leverage cap
   * applied.
   *
   * ABSENT when equity is unset — sizing fails closed there and no number is
   * invented, because a confident-looking size for a user who never set an
   * account is the exact failure this replaces.
   */
  suggestedRiskUsd?: number;
  /** The notional that suggested risk implies, in dollars. Absent with the risk. */
  suggestedNotionalUsd?: number;
  /**
   * Why the suggested size is what it is — a downgrade, a leverage clamp, the
   * equity-missing state. Present whenever a suggestion was made; the sizing
   * never shows an unexplained number.
   */
  suggestedSizeReason?: string;
  /**
   * The RISK in dollars the MODEL stated for this plan, when it stated one.
   *
   * Recorded SEPARATELY from the app's suggestion so the journal can compare
   * the two — the app's number never depends on it, and the model can neither
   * inflate nor shrink the suggested ticket. ABSENT when the model stated no
   * size, and the row must not imply that it agreed with the suggestion.
   */
  modelStatedRiskUsd?: number;
  /**
   * The NOTIONAL in dollars the MODEL stated, when it stated one. A
   * different quantity from the risk above, and kept apart from it for the
   * same reason.
   */
  modelStatedNotionalUsd?: number;
  /** Worst move against the position while it was open, as leveraged percent. Candle-exact; distinct from the approximate `slOptimizationData.maxAdverseExcursion`. */
  maxAdverseExcursion?: number;
  /** Best price the trade offered before exit, as leveraged percent (MFE). With pnlPercent it yields capture efficiency. Candle-exact over the live window. */
  maxFavorableExcursion?: number;
  /** Why a SKIPPED trade was passed on ("watched, chose not to") — passes become data. */
  skipReason?: string;
  /** Pre-trade checklist at log time: every item with whether it was ticked,
   *  plus the counts. The item is the lesson; the count alone could not say
   *  which guard got skipped. */
  checklistCompleted?: import('../utils/checklist').ChecklistResult;
  /** Pre-read capture: the user's committed prior call from
   *  BEFORE the verdict reveal, copied from the source message at log time.
   *  Feeds the journal's user-prior vs verdict vs outcome calibration row. */
  userPriorCall?: import('./message').UserPriorCall;
}

export interface StrategySearchResult {
  name: string;
  description: string;
  rationale?: string;
  backtestData?: string;
  pitfalls?: string;
  implementationSteps?: string[];
}

/**
 * Discipline tags captured at trade-logging time (Batch 5 quick-tag UI).
 * Everything optional — the capture flow must stay ≤3 taps.
 */
export interface CaptureJournalTags {
  mistakeTags?: LoggedTrade['mistakeTags'];
  emotionalState?: LoggedTrade['emotionalState'];
  followedPlan?: boolean;
  planDeviationNote?: string;
  /** Pre-trade checklist completion: items checked / items shown. */
  checklistCompleted?: import('../utils/checklist').ChecklistResult;
  /** Why a pass was taken — rides the capture modal's skip path. */
  skipReason?: string;
}


export interface TradeSummary {
  id: string; // Corresponds to the LoggedTrade ID
  summaryText: string;
  timestamp: string;
}

/**
 * WHO named a conversation or a dock chat — the guard that keeps a manual
 * rename final.
 *
 * - `'default'` — the fresh-row placeholder (`New chat` / `New panel`);
 * - `'message'` — the first-line fallback (`titleFromMessage` /
 *   `conversationTitle`);
 * - `'model'` — the background model's own name for the thread;
 * - `'user'` — the trader typed it, and nothing may replace it.
 *
 * Absent on legacy rows and read as `'message'`: before this field existed
 * every title came from the first message, so that is what those rows are.
 */
export type SessionTitleSource = 'default' | 'message' | 'model' | 'user';

export interface Conversation {
  id: string;
  timestamp: number;
  title?: string;
  /** Who named this conversation (see {@link SessionTitleSource}). Absent ⇒
   *  `'message'`. A manual rename stamps `'user'`, which the model-title path
   *  refuses to overwrite. */
  titleSource?: SessionTitleSource;
  messages: Message[];
  /** Turns taken off the live thread by a revert, oldest tail first, each one
   *  tagged with the message it was cut AFTER so it can go back where it came
   *  from. This is why a revert is not a delete: the trader's own earlier turns
   *  survive the operation and can be brought back. (2026-10-27 owner ruling.)
   *
   *  Persisted with the conversation like every other field — the profile save
   *  writes `conversations` verbatim, and only image bytes leave the blob. */
  parked?: import('../utils/messageVersions').ParkedTail<Message>[];
  threadSummary?: string; // Layer 2: Compressed Conversation Summary
  ocrModel: string;              // Vision/OCR model id (from the vision provider's models)
  moderatorProviderId: string;   // ProviderConfig id of the debate moderator
  moderatorModel: string;        // Moderator model id
  leverage: number;
}
