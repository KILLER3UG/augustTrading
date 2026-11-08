// =============================================================================
// AI LEARNING TYPES - Adaptive Learning, Mistake Patterns, Insight Extraction
// =============================================================================

import { AIProvider } from './enums';

/**
 * FinCom disagree-or-commit marker (Batch 4): one line per peer in a debate
 * turn — the seat either commits to the peer's current position (with why)
 * or dissents (with why). Parsed into DebateTurn.fincom for conformity stats.
 */
export interface FinComMarker {
  seat: string;
  stance: 'commit' | 'dissent';
  why: string;
}

/**
 * A recurring trading mistake detected from losing trades
 * Used by MistakePatternService
 */
export interface RecurringMistake {
  type: 'timing' | 'direction' | 'setup' | 'risk' | 'exit';
  description: string;
  occurrences: number;
  affectedTrades: string[]; // Trade IDs
  severity: 'high' | 'medium' | 'low';
}

/**
 * Summary of trading weaknesses for UI display
 */
export interface TradingWeaknesses {
  mistakes: RecurringMistake[];
  worstPerformingSetups: { setup: string; winRate: number; count: number }[];
  lastUpdated: string;
}

/**
 * A single insight extracted from a post-mortem analysis.
 * Rendered by `utils/memoryUtils.buildGlobalMemoryIndex` for profiles that
 * already carry entries. Nothing appends to the store any more: the
 * post-mortem detectors that wrote it were deleted.
 */
export interface TradeInsight {
  id: string;
  category: 'entry_timing' | 'exit_strategy' | 'pattern_recognition' | 'risk_management' | 'general';
  insight: string;
  sourceTradeId: string;
  coin?: string;
  pattern?: string;
  direction?: 'Long' | 'Short';
  createdAt: string;
  useCount: number; // How many times the pattern recurred when this was distilled — nothing increments it later, so treat it as birth strength, not evidence of use
}

/**
 * Knowledge base for storing extracted insights
 */
export interface InsightKnowledgeBase {
  insights: TradeInsight[];
  lastUpdated: string;
}

/**
 * An insight with provider attribution and usage tracking. Lives in the
 * Trader notebook as a distilled/ memory file (plan store unification —
 * the old standalone `attributed_insights_kb` preference store was folded
 * into the notebook so one store, one cap, one UI owns it).
 */
export interface AttributedInsight {
  id: string;
  insight: string;
  sourceProvider: AIProvider | string;
  category: 'global' | 'coin' | 'pattern' | 'regime' | 'family';
  scope?: string; // e.g., "BTCUSDT" for coin-specific, "Family C" for family-specific
  qualityScore: number; // 0-100, based on user feedback or outcome correlation
  wasValidated: boolean; // Did following this advice help?
  timesUsed: number;
  timesHelpful: number;
  /** Negative explicit feedback — lets qualityScore reflect feedback only,
   *  not mere surface marks (timesUsed counts displays, which inflated the
   *  denominator and diluted the ratio). */
  timesNotHelpful?: number;
  /** Dedupe guard for "surfaced to a prompt" marks. Session-scoped since the
   *  notebook store — cross-restart re-marks cost one counter tick at most. */
  lastSurfacedAt?: number;
  createdAt: string;
  tradeId: string;
}

export interface GlobalMemory {
  totalTradesAnalyzed: number;
  familyPerformance: Record<string, string>;
  aiPatternMemory: string[];
  userPreferences: {
    leverageDefault: number;
    favoriteAssets: string[];
    preferredSetup: string;
  };
  globalCorrections: string[];
  insightKnowledgeBase?: InsightKnowledgeBase; // New: Structured insights knowledge base
  lastUpdated: string;
}

/**
 * A journal rule — one trigger + one action, the flat lesson index beside skills.
 * Legacy rows stored `ifCondition`/`thenAction`; `utils/learningRuleFormat`
 * migrates them on read and write.
 */
export interface LearningRule {
  id: string;
  when: string;                     // The trigger
  action: string;                   // What to do when it fires
  sourceTradeId: string;            // Trade ID this rule came from
  outcome?: 'WIN' | 'LOSS';         // Outcome of the source trade, when known
  coin?: string;                    // Specific coin (optional)
  pattern?: string;                 // Pattern family (optional)
  direction?: 'Long' | 'Short';     // Trade direction (optional)
  createdAt: string;                // ISO timestamp
  useCount: number;                 // Recurrences at distillation time; never incremented on injection. The prompt index reads this store.
  lastUsed?: string;                // Last time rule was used
  wins?: number;                    // Later outcomes that matched this rule
  losses?: number;
  status?: 'candidate' | 'confirmed' | 'retired';
}

/**
 * Why a closed trade failed or succeeded. Only SETUP_EDGE_FAILURE may
 * write a technical lesson into LearningRules / skills.
 */
export type RootCauseClass = 'SETUP_EDGE_FAILURE' | 'EXECUTION_ERROR' | 'MACRO_SHOCK' | 'UNCLEAR';

/**
 * A single markdown file in the Trader Notebook (the Memory surface).
 * The harness AND the user write these; matching enabled files are retrieved
 * into analyst, moderator, and post-mortem prompts (not a full dump).
 */
export interface MemoryFile {
  id: string;
  folderId: string;
  /** File name including the .md extension (e.g. "memory.md"). Unique in its folder. */
  name: string;
  /** Logical path inside the folder, e.g. "my-skill/SKILL.md" or
   *  "my-skill/references/checklist.md". The notebook stores files flat, so
   *  this is what gives a skill its directory shape. Absent on files written
   *  before the field existed. */
  path?: string;
  content: string;
  /** When true the full content is injected into prompts. */
  enabled: boolean;
  /**
   * Harness-managed file (trade diary, profile memory, recurring mistakes) —
   * the app rewrites these; the UI labels them "auto" so the user knows.
   */
  autoManaged?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A folder in the Trader Notebook (profile, trader-diary, …). */
export interface MemoryFolder {
  id: string;
  name: string;
  /** Lower-order folders are injected first (profile is always first). */
  order: number;
}
