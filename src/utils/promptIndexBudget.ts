/**
 * promptIndexBudget — the ONE budget the skills catalogue and the memory
 * indexes share, scaled to the active model's context window.
 *
 * THE FLOOR IS 131k. Every model this app is used with reports at least that,
 * so below it there is no "budget" to defend: the old tier table shrank the
 * memory index to FOUR lines under 32k, which meant a real window could hide
 * every durable fact the trader had taught the seat. That tier is deleted, not
 * retuned — a cap that exists only to protect a window nobody runs is pure
 * downside.
 *
 * AT AND ABOVE THE FLOOR THE INDEX IS UNBOUNDED. The owner's ruling: on a 1M
 * model, thirty index lines is noise, and the index is the map the seat needs
 * to know what it may read. The budget still scales below 131k so an
 * unusually small local model degrades proportionally instead of silently
 * dropping every line — the floor is an assumption, not a guarantee.
 *
 * Pure: a window size in, line caps out. Contract-tested.
 */

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './contextWindow';

/** The smallest window this app designs for (owner ruling, 2026-11-10). */
export const ASSUMED_MIN_CONTEXT_WINDOW_TOKENS = 131_000;

/** "No cap". `Array.prototype.slice(-N)` clamps to the whole array, so this
 *  reads as "every line" at each call site without an `if`. */
export const UNBOUNDED_INDEX_LINES = Number.MAX_SAFE_INTEGER;

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

/** Everything the seat can afford to be told about, with no line cap. */
const UNBOUNDED: IndexBudget = {
    skills: UNBOUNDED_INDEX_LINES,
    memory: UNBOUNDED_INDEX_LINES,
    topics: UNBOUNDED_INDEX_LINES,
    goals: UNBOUNDED_INDEX_LINES,
};

/**
 * A window in, line caps out. At or above the 131k floor every cap is lifted;
 * below it the caps scale with the window so a genuinely small model still
 * gets a proportional index rather than four lines.
 */
export const indexBudgetFor = (windowTokens: number): IndexBudget => {
    const w = Number.isFinite(windowTokens) ? Math.max(0, windowTokens) : DEFAULT_CONTEXT_WINDOW_TOKENS;
    if (w >= ASSUMED_MIN_CONTEXT_WINDOW_TOKENS) return UNBOUNDED;
    // Below the floor: one index line per ~1.4k tokens. At 32k that is 22
    // lines (the old tiny tier allowed four); at 8k it is 5, floored at 8 so a
    // truly tiny local model still knows its memory and skills exist. This is
    // proportional degradation, not a tier table.
    const lines = Math.max(8, Math.floor(w / 1_400));
    return { skills: lines, memory: lines, topics: Math.max(4, Math.floor(lines / 2)), goals: Math.max(2, Math.floor(lines / 5)) };
};
