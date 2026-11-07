// Trade analysis types

import type { StrategyFamily } from './strategy';

export interface MarketConditions {
  pattern: string;
  candleBehavior: string;
  timeframeAlignment: string;
  rsi: string;
  macd: string;
  sentiment: string;
  prices?: Record<string, string>; // New field for timeframe-specific prices
}

export interface EntryPoint {
  description: string;
  price: string;
}

export interface TakeProfitTarget {
  price: string;
  percentage?: string;
  originalPercentage?: string;
}

export interface PatternDetail {
  name: string;
  timeframe: string;
  type: 'Bullish' | 'Bearish' | 'Neutral';
  confidence?: string;
  description?: string;
}

export interface KeyLevels {
  support: string[];
  resistance: string[];
}

// Devil's Advocate analysis - mandatory section for accuracy
export interface DevilsAdvocateData {
  bearCaseReasons: string[];       // 3 reasons why this trade could fail
  failureScenarios: string[];      // Specific failure scenarios
  crowdedTradeWarning: string | null;  // Funding rate / L/S ratio warning
  riskScore: number;               // 0-100, higher = riskier
}

// =============================================================================
// DUAL SCENARIO ANALYSIS - Bullish vs Bearish evaluation before direction choice
// =============================================================================

/**
 * Definition of a single scenario (bullish or bearish)
 */
export interface ScenarioDefinition {
  trigger: string;           // e.g., "Break above 95500"
  confirmation: string;      // e.g., "4H candle close above level with volume"
  target: string;            // e.g., "97000"
  invalidation: string;      // e.g., "Close below 94500"
}

/**
 * Complete dual scenario analysis from the AI debate
 */
export interface DualScenarioAnalysis {
  bullish: ScenarioDefinition;
  bearish: ScenarioDefinition;
  selectedScenario: 'bullish' | 'bearish' | 'neutral';
  selectionReasoning: string;  // Why this scenario was chosen over the alternative
  confidenceInSelection: number; // 0-100, how confident in the selection
}

/** How the gate scan bound a presented plan.
 *
 *  Lives in `types` (not in the service that produces it) because the stamped
 *  value must survive onto the journal row, and a persisted record should not
 *  import from a runtime module to describe itself.
 *
 *  `unavailable` is a REAL state, not a zero: the scan fetches market data plus
 *  an OHLCV pull per timeframe, so it can fail, hang, or be stopped. A plan in
 *  that state is logged only behind an explicit "Log without gate check"
 *  confirm, and never with `confidenceCap: 0`, which would report a live idea
 *  as a worthless one. */
export interface ProposalGate {
    status: 'evaluated' | 'unavailable';
    /** 0-1 when evaluated; 1 (binds nothing) when unavailable. */
    confidenceCap: number;
    /** Why — quoted into the tool receipt and the row's validationWarnings. */
    reason: string;
    /** When the scan answered. A stamp older than the staleness window is
     *  re-run at log time, so a plan opened from yesterday's session is not
     *  logged against a number the market left behind. */
    stampedAt: string;
    /** Set when the plan must NOT be logged: its levels are inverted for the
     *  stated direction (E-57 §5 — there is no ratio to grade at all), or its
     *  net expectancy at its own probability is at or below the trader's floor.
     *  The card disables logging and quotes this; the log path refuses. An
     *  inverted plan's refusal wins, because an edge floor is a meaningless
     *  question on levels that point the wrong way. */
    refusal?: string;
    /** The refused net expectancy, in R. */
    netEdgeR?: number;
    /** The trader's floor the number was compared against, in R. */
    minEdgeThresholdR?: number;
    /**
     * Plan-shape cautions (E-57 §5): the R:R floor for the stated confidence, a
     * stop tighter than 1× ATR, a stop wider than 3×, a stop further from entry
     * than 5%. Computed by the ONE function that owns those bands
     * (`AccuracyValidationService.validateRiskReward`), which until now was
     * called only from `TradeValidationGate` — a module with no production
     * importer. So the numbers existed and nothing enforced or showed them.
     *
     * They WARN. Per the owner's ruling, only an inverted plan refuses (that is
     * `refusal`), because a stop distance is the trader's judgement and the app
     * proposes rather than decides. An UNMEASURABLE plan does not refuse either:
     * it lands in `reason` as `unavailable`, because a missing reading is not
     * evidence of a bad plan.
     */
    warnings?: string[];
}

export interface TradeAnalysis {
  coinName?: string;
  direction: 'Long' | 'Short' | 'Neutral';
  tradeType?: 'scalp' | 'swing';  // Auto-detected or manually overridden
  tradeTypeManualOverride?: boolean;  // True if user manually set the trade type
  confidence: 'High' | 'Medium' | 'Low' | 'Avoid';
  probability: number;
  grade?: 'A' | 'B' | 'C' | 'D' | 'F'; // Trade setup grade (A=80-95%, B=70-79%, C=55-69%, D=40-54%, F=<40%)
  strategy: string;
  /** Controlled strategy-family vocabulary (types/strategy). Derived at the
   *  schema boundary: the model's explicit `strategyFamily` when it speaks
   *  the enum, else a keyword classification of the free-text `strategy`.
   *  Undefined only when neither carries a family signal. */
  strategyFamily?: StrategyFamily;
  activeStrategies: string[];
  entryPoints: EntryPoint[];
  stopLoss: string;
  stopLossPercentage?: string;
  originalStopLossPercentage?: string;
  takeProfit: TakeProfitTarget[];
  /**
   * The model's stop/targets came back on the WRONG SIDE of its entry and were
   * mirrored into a valid plan by the schema (utils/levelOrder).
   *
   * Set for the lifetime of the analysis and read by the accuracy writers,
   * which must NOT credit such a plan to the model: the outcome belongs to a
   * plan the model never proposed, so crediting it lets a model that
   * consistently inverts its side score as though it were right.
   *
   * This lived only on the zod schema and was therefore unreachable from
   * application code — which is exactly why a mirrored plan flowed into the
   * model-performance and Brier ledgers as if it were the model's own.
   */
  levelsCorrected?: boolean;
  /** Human-readable repairs, one per mirrored/re-sorted level. */
  levelFixes?: string[];
  marketConditions: MarketConditions;
  historicalCorrelation: string;
  createdAt?: string; // Timestamp for when the analysis was generated
  rrRatio?: number;
  detectedPatternFamily?: string; // New field for Market Classification Family
  /**
   * The `scan_playbooks` detector id the plan followed, stamped by
   * `present_trade` from the model's `playbook` argument. Absent when no
   * detector fired (or the id was not one of the shipped detectors) — a row
   * without a tag is excluded from per-detector stats, never assigned to one.
   */
  playbookId?: string;
  detectedPatterns?: PatternDetail[]; // New: List of specific patterns
  keyLevels?: KeyLevels; // New: Support and Resistance Zones
  isUpdate?: boolean; // NEW: Flag to indicate if this is an updated setup
  updateInterval?: string; // NEW: Time duration string (e.g. "2h 15m") since original setup
  // Accuracy validation fields
  devilsAdvocate?: DevilsAdvocateData; // Devil's advocate analysis
  validationWarnings?: string[]; // Warnings from validation gate
  originalConfidence?: 'High' | 'Medium' | 'Low' | 'Avoid'; // Original confidence before validation adjustments
  /** Quarantine stamp: the direction was OVERRIDDEN by an integrity gate (no
   *  aligned analyst cited, ungrounded levels, or an unparseable plan).
   *  `direction` stays 'Neutral' so every downstream consumer remains safe,
   *  but this tells the UI and journal the card is a measurement failure —
   *  never a deliberate no-trade opinion — and must not be graded as one. */
  verdictReview?: {
    reason: 'uncited' | 'ungrounded' | 'incomplete-plan' | 'truncated-plan';
    /** The moderator's directional call before it was overridden. */
    from?: 'Long' | 'Short';
  };
  // Entry Timing Score (display only, calculated during validation)
  entryTimingScore?: {
    score: number;
    timingQuality: string;
    suggestedEntry?: {
      price: number;
      reason: string;
    } | null;
  };
  // Trade validity window - how long this setup remains valid from createdAt
  validityDurationMinutes?: number; // e.g., 330 = 5h 30m valid from analysis time
  /** Deterministic risk veto applied AFTER the moderator's verdict — the
   *  ensemble agreeing on something is not risk control. Populated by the
   *  pipeline when the gate blocked, the verdict contradicts pattern-memory
   *  direction, or the plan is incomplete (missing SL/TP). */
  riskVeto?: string;
  /** Set only on a plan that reached the journal through `present_trade`: the
   *  scan that bounded it, or the honest record that no scan could. */
  gate?: ProposalGate;
  // Gate Keeper result - two-stage scan data
  gateResult?: {
    passed: boolean;
    confidenceCap: number;
    penalties: {
      dataIntegrity: number;
      patternMemory: number;
      htfConflict: number;
      volumeContext: number;
      rawTotal: number;
      effectiveTotal: number;
    };
    familyBias: {
      A: number;
      B: number;
      C: number;
      Omega: number;
      reasoning: string[];
    };
    suggestedDirection?: 'Long' | 'Short' | 'Neutral';
    warnings: string[];
    insights: string[];
  };
  // Dual Scenario Analysis - both bullish and bearish scenarios considered
  dualScenarioAnalysis?: DualScenarioAnalysis;
  // SL/TP Probability Estimation with Reasoning
  levelProbabilities?: LevelProbabilities;
  /**
   * Snapshot of market data at the time of analysis.
   * Type is HybridDataPacket (from HybridIntelligenceService), but using 'unknown' to avoid strict circular dependency.
   */
  marketSnapshot?: unknown;
  /**
   * Evidence-bound claims (better-harness methodology): every key conclusion
   * must cite its data sources and mark gaps explicitly instead of guessing.
   */
  evidence?: EvidenceClaim[];
  /** Structured Entry/SL/TP cites (source ids). Preferred over free-text evidence match. */
  levelCitations?: Array<{ label: string; price: string; sourceId: string }>;
  /**
   * Invalidation contract: the concrete conditions that falsify this setup.
   * Formalizes the invalidation thesis the prompts already require, so the
   * UI can show exactly what kills the trade (price level, time, structure).
   */
  invalidationCriteria?: InvalidationCriterion[];
  /**
   * Consensus explainability panel data: each ensemble analyst's structured
   * call (direction/entry/SL/TP/confidence) plus the pre-debate divergence
   * analysis, so the verdict can be audited against its own inputs.
   * App-computed (never AI-generated) — attached after sanitization.
   */
  analystConsensus?: AnalystConsensus;
  /**
   * First-class recommendation contract derived from the verdict (action,
   * risk boundary, invalidation, validity). App-computed for journal/watch.
   */
  recommendationContract?: RecommendationContract;
  positionSize?: {
    line: string;
    riskUsd: number;
    fraction: number;
    label: 'full' | 'half' | 'none';
    /** Every labeled sizing step that produced this ticket (gate caps, vetoes,
     *  downgrades, grade tier, equity state) — the explainable-sizing trail.
     *  Empty when the ticket runs at full risk uncapped. */
    adjustments?: Array<{
      type: 'neutral' | 'risk-veto' | 'skill-veto' | 'gate-cap' | 'downgrade' | 'grade-tier' | 'equity';
      label: string;
      fractionEffect: number;
    }>;
  };
  /**
   * Session-guard verdict at analysis time (Batch 2): the deterministic
   * day-P&L / trade-count / streak state the moderator was told to weigh.
   */
  sessionGuard?: {
    level: 'clear' | 'notice' | 'warning' | 'standdown';
    summary: string;
  };
  /** Kelly advisory line (empty string when journal history is too thin). */
  kellyAdvisory?: string;
  /**
   * Perpetual funding rate (8h, signed — positive = longs pay) snapshotted at
   * analysis time (Batch 7). The card frames it as a carry cost relative to
   * the verdict direction; the journal records what the moderator saw.
   * `null` = the rate could not be fetched — an outage is not a settled 0%.
   */
  fundingRate?: number | null;
  /**
   * Plan version: 1 for the original publication, incrementing
   * on each trade-update. A revision is an explicit amendment — the card
   * shows the version chip and WHAT moved (planDiff) — never a silent edit.
   */
  planVersion?: number;
  /** The message id of the plan this revision amends (undefined on v1). */
  amendsMessageId?: string;
  /** Human diff of what moved vs the prior version (empty when unchanged). */
  planDiff?: string;
}

/**
 * A single evidence-bound claim attached to an analysis conclusion.
 * `state` distinguishes verified data from partial or missing data so the UI
 * can show provenance and the AI cannot paper over gaps with confidence.
 */
export interface EvidenceClaim {
  /** The conclusion or assertion being made. */
  claim: string;
  /** Data sources backing the claim (e.g. "Binance 1h OHLCV", "Chart 1 OCR", "RSI(14)"). */
  sources: string[];
  /** observed = directly verified; partial = some data; unobserved = data gap, inferred only. */
  state: 'observed' | 'partial' | 'unobserved';
  /** Optional note explaining partial/unobserved state. */
  note?: string;
}

/**
 * A single falsification criterion from the analysis invalidation contract.
 * `level` stays a string (prices are cleaned strings throughout the app,
 * e.g. "94,500" or "4H close below 94,500").
 */
export interface InvalidationCriterion {
  /** The price level or threshold, e.g. "94,500" or "validity window expiry". */
  level: string;
  /** What must happen to falsify the setup, e.g. "4H close below this support". */
  condition: string;
  /** price = level breach; time = expiry; structure = market structure shift; signal = indicator/counter-signal. */
  category?: 'price' | 'time' | 'structure' | 'signal';
  /** Optional consequence/rationale, e.g. "bullish thesis dead, flip to neutral". */
  note?: string;
}

/** One analyst's structured call, extracted for the consensus breakdown. */
export interface AnalystConsensusEntry {
  /** ProviderConfig.id — the key used across modelsUsed/calibration. */
  providerId: string;
  /**
   * The unique analyst identity (provider::model) when available — two lens
   * roles may share one provider, so config.id alone collides; the panel
   * matches on thoughtsKey first, providerId as fallback.
   */
  thoughtsKey?: string;
  /** Display name, e.g. "Gemini 2.0 Pro (Technical)". */
  displayName: string;
  direction?: string;
  /** First entry price, cleaned string. */
  entry?: string;
  stopLoss?: string;
  /** First take-profit price, cleaned string. */
  takeProfit?: string;
  confidence?: string;
  probability?: number;
}

/** Persisted subset of the pre-debate divergence analysis. */
export interface ConsensusDivergence {
  /** 0-100: 0 = complete agreement, 100 = total disagreement. */
  score: number;
  isEchoChamber: boolean;
  divergenceType: 'none' | 'direction' | 'confidence' | 'entry' | 'multiple';
  details: string[];
}

/** Full consensus payload attached to the verdict analysis. */
export interface AnalystConsensus {
  entries: AnalystConsensusEntry[];
  divergence: ConsensusDivergence;
  /** Who the verdict tracked vs who dissented (app-computed). */
  citations?: ConsensusCitation[];
}

export interface ConsensusCitation {
  displayName: string;
  aligned: boolean;
  note: string;
}

/** Scoped action + falsification the journal and watch thread can enforce. */
export interface RecommendationContract {
  action: 'long' | 'short' | 'avoid' | 'wait';
  /** Stop / size boundary in plain language. */
  riskBoundary: string;
  invalidation: InvalidationCriterion[];
  validityMinutes?: number;
  thesis: string;
}

/**
 * Reasoning breakdown for probability estimation
 * Provides transparency into how SL/TP probabilities were calculated
 */
export interface ProbabilityReasoning {
  indicatorBasis: string;        // e.g., "RSI oversold at 28, MACD bullish crossover"
  volatilityFactor: string;      // e.g., "ATR 1.2% - normal volatility, no adjustment"
  patternMemoryInfluence: string; // e.g., "Similar Family C setups: 72% hit TP1"
  aiAdjustments: string;         // e.g., "Reduced TP2 probability due to major resistance"
}

/**
 * Individual probability estimation for a specific take-profit level
 */
export interface TPProbability {
  level: number;                 // e.g., 1 for TP1, 2 for TP2
  probability: number;           // 0-100
  reasoning: ProbabilityReasoning;
}

/**
 * Probability estimation for stop-loss and take-profit levels
 */
export interface LevelProbabilities {
  slProbability: number;         // 0-100, probability of hitting stop-loss
  slReasoning: ProbabilityReasoning; // Explicit reasoning for SL
  tpProbabilities: TPProbability[]; // Dynamic array supporting any number of TPs

  // Legacy fields for backward compatibility
  tp1Probability?: number;
  tp2Probability?: number;
  tp3Probability?: number;
  reasoning?: {
    sl: ProbabilityReasoning;
    tp1: ProbabilityReasoning;
    tp2?: ProbabilityReasoning;
    tp3?: ProbabilityReasoning;
  };
  calculationMode?: 'AI' | 'Algo'; // 'AI' = LLM Reasoning, 'Algo' = Deterministic
}
