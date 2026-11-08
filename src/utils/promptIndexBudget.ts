/**
 * promptIndexBudget — the ONE budget the skills catalogue and the memory
 * indexes share, scaled to the active model's context window.
 *
 * The indexes are always-on bytes: on a 1M-window frontier model 30 skill
 * lines plus 30 memory lines is noise; on an 8k local model it is the whole
 * prompt. Both composition sites (the Agents surface's `surfacePromptWith` and
 * the dock's seat-prompt builder) read THIS table, so the two homes shrink
 * together and one model's budget never depends on which surface asked.
 *
 * Pure: a window size in, line caps out. Contract-tested.
 */

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './contextWindow';

export interface IndexBudget {
    /** Skills catalogue lines (L0). */
    skills: number;
    /** Profile-memory index lines. */
    memory: number;
    /** Notebook topics index lines. */
    topics: number;
    /** Goal environments (a goal is the seat's work context). */
    goals: number;
}

const STEP = (
    windowTokens: number,
    big: number,
    mid: number,
    small: number,
    tiny: number,
): number => (windowTokens >= 200_000 ? big : windowTokens >= 100_000 ? mid : windowTokens >= 32_000 ? small : tiny);

/** The repo's defaults at ≥200k — the numbers the composition sites used
 *  before this budget existed, so big-window behaviour is unchanged. */
export const indexBudgetFor = (windowTokens: number): IndexBudget => {
    const w = Number.isFinite(windowTokens) ? Math.max(0, windowTokens) : DEFAULT_CONTEXT_WINDOW_TOKENS;
    return {
        skills: STEP(w, 30, 20, 10, 4),
        memory: STEP(w, 30, 16, 8, 4),
        topics: STEP(w, 12, 8, 4, 2),
        // Goals are the work environment; one line each, the focused one first.
        goals: STEP(w, 6, 4, 3, 1),
    };
};
