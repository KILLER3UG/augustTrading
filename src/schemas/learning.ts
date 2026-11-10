/**
 * Zod schemas for secondary AI boundaries: global memory synthesis,
 * LLM rule extraction, and strategy search results.
 * Lenient by design — malformed items are dropped, not fatal.
 */

import { z } from 'zod';
import type { GlobalMemory, LearningRule } from '../types';

// =============================================================================
// GLOBAL MEMORY (updateGlobalMemory — previously zero validation)
// =============================================================================

const coercedStringArray = z.array(z.unknown()).transform((arr) =>
  arr.map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)))
);

const coercedStringRecord = z.record(z.string(), z.unknown()).transform((rec) =>
  Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [k, typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)])
  )
);

export const GlobalMemorySchema = z.object({
  totalTradesAnalyzed: z.number().default(0),
  familyPerformance: coercedStringRecord.default({}),
  userPreferences: z.object({
    leverageDefault: z.number().default(100),
    favoriteAssets: coercedStringArray.default([]),
    preferredSetup: z.string().default(''),
  }).default({ leverageDefault: 100, favoriteAssets: [], preferredSetup: '' }),
  globalCorrections: coercedStringArray.default([]),
  // Structured insight knowledge base — shape validated by its own consumers.
  insightKnowledgeBase: z.any().optional(),
  lastUpdated: z.string().default(() => new Date().toISOString()),
});

export const parseGlobalMemory = (raw: unknown): GlobalMemory | null => {
  const result = GlobalMemorySchema.safeParse(raw);
  return result.success ? (result.data as GlobalMemory) : null;
};

// =============================================================================
// LLM RULE EXTRACTION
// =============================================================================

const RULE_CATEGORIES = ['entry', 'exit', 'risk', 'pattern', 'regime', 'general'] as const;

export const ExtractedRuleSchema = z.object({
  condition: z.string().min(1),
  action: z.string().min(1),
  category: z.enum(RULE_CATEGORIES).catch('general'),
  confidence: z.number().min(0).max(100).catch(80),
});

export type ValidatedExtractedRule = z.infer<typeof ExtractedRuleSchema>;

/** Parse an array of raw extracted rules, dropping malformed items. */
export const parseExtractedRules = (raw: unknown): ValidatedExtractedRule[] => {
  if (!Array.isArray(raw)) return [];
  const rules: ValidatedExtractedRule[] = [];
  for (const item of raw) {
    const result = ExtractedRuleSchema.safeParse(item);
    if (result.success) rules.push(result.data);
  }
  return rules;
};

// Re-export for consumers that construct LearningRule objects from these.
export type { LearningRule };

// =============================================================================
// STRATEGY SEARCH RESULTS
// =============================================================================

export const StrategySearchResultSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  rationale: z.string().optional(),
  backtestData: z.string().optional(),
  pitfalls: z.string().optional(),
  implementationSteps: z.array(z.string()).optional(),
});

export type ValidatedStrategySearchResult = z.infer<typeof StrategySearchResultSchema>;

/**
 * Parse strategy search output: accepts a bare array or a wrapped
 * `{ results | strategies: [...] }` object, dropping malformed items.
 */
export const parseStrategySearchResults = (raw: unknown): ValidatedStrategySearchResult[] => {
  let items: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    items = obj.results || obj.strategies || [];
  }
  if (!Array.isArray(items)) return [];
  const results: ValidatedStrategySearchResult[] = [];
  for (const item of items) {
    const result = StrategySearchResultSchema.safeParse(item);
    if (result.success) results.push(result.data);
  }
  return results;
};

/**
 * The one trigger-length bar, declared HERE because `services/learning/
 * skillClauseBar.ts` imports its types from this file — a constant the other
 * way round would close the edge schemas → services that `utils/` is explicitly
 * forbidden to make.
 *
 * Until now the schema accepted 8 characters and `validateIfThen` rejected
 * under 12, so a chat or verdict craft of 8–11 characters parsed clean, was
 * queued as a draft, and then died in a gate the proposer had already been
 * told it passed. One number, both checks.
 */
export const CLAUSE_MIN_LENGTH = 12;

// =============================================================================
// SETTLEMENT REFLECTION (E-57 §1) — the post-mortem the harness writes at
// settlement, and the ONLY thing that has ever written `trade.postMortem`.
// =============================================================================

/**
 * Four fields, because four is what the two notebook readers actually parse,
 * and no more:
 *  - `extractLessonFromPostMortem` (services/learning/MemoryFilesService.ts:1017)
 *    needs a `Lesson:` line whose capture is at least 10 characters;
 *  - `parseLessonClauses` (utils/lessonClause.ts) needs both sides of the
 *    clause and slices each at 240 — so the caps here ARE the reader's caps.
 *    A boundary wider than the reader would promise a clause the reader then
 *    truncates, which is the drift this repo keeps finding.
 *
 * Sliced rather than rejected past the cap: a boundary that throws away a
 * whole reflection because one sentence ran long teaches the loop nothing. The MIN is
 * the load-bearing edge — a field too short to be a claim is a malformed
 * answer, and a malformed answer writes nothing.
 */
const sliced = (max: number) => (v: unknown) => (typeof v === 'string' ? v.slice(0, max) : v);

export const SettlementReflectionSchema = z.object({
  whatHappened: z.preprocess(sliced(1200), z.string().min(20)),
  lesson: z.preprocess(sliced(400), z.string().min(10)),
  when: z.preprocess(sliced(240), z.string().min(CLAUSE_MIN_LENGTH)),
  action: z.preprocess(sliced(240), z.string().min(CLAUSE_MIN_LENGTH)),
  // The honest "no transferable lesson here" answer. Optional so a model that
  // simply answers the four fields still parses; when it is set the caller
  // writes NOTHING, because a gap in the notebook is true and a invented lesson
  // is not.
  noLesson: z.preprocess(
    (v) => (v === true || v === 'true' || v === 'yes' ? true : v),
    z.boolean().optional().catch(undefined),
  ),
});

export type SettlementReflection = z.infer<typeof SettlementReflectionSchema>;

/** null on anything malformed, and on a declined reflection. */
export const parseSettlementReflection = (raw: unknown): SettlementReflection | null => {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).reflection ?? raw
    : raw;
  // The prompt's own decline shape is `{"noLesson": true}` ALONE. Detect it
  // BEFORE the field schema, or the required lesson fields fail first and the
  // model's honest "nothing to teach here" is misreported as a malformed
  // answer. Same outcome (write nothing), but the parser should honor the
  // contract it hands the model.
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const flag = (obj as Record<string, unknown>).noLesson;
    if (flag === true || flag === 'true' || flag === 'yes') return null;
  }
  const result = SettlementReflectionSchema.safeParse(obj);
  if (!result.success) return null;
  return result.data.noLesson ? null : result.data;
};

