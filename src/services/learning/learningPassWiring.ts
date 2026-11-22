/**
 * learningPassWiring — the ONE adapter between the turn pipeline and the two
 * background learning passes (post-turn review + periodic Dream).
 *
 * WHY THIS EXISTS. `backgroundReview.ts` and `memoryDream.ts` are pure,
 * offline-testable cores: they take injected emitters/gatherers and never
 * import the app. This module is the app-side half — it binds the review's
 * `emit` to the REAL receipted executors (`applyCuratedMemoryOps`,
 * `skillManage`), binds the Dream's defaults to the real stores, and exposes
 * the two fire-and-forget hooks the turn runner and the profile loader call.
 *
 * THE BOUNDARY IS ENFORCED TWICE: `backgroundReview` refuses any tool outside
 * its allow-list before the emitter runs, and this adapter routes ONLY the
 * two whitelisted tools to their executors. A signal-ledger, trade or code
 * write has no path through here.
 */

import { getHarnessSettings } from '../../utils/harnessSettings';
import { getActiveUsername } from '../../utils/activeUser';
import {
    BACKGROUND_REVIEW_ALLOWED_TOOLS,
    runBackgroundReview,
    type BackgroundReviewEmission,
    type BackgroundReviewReceipt,
} from './backgroundReview';
import { runMemoryDream, type DreamRunResult } from './memoryDream';

/** The known desk-tool names, for `skill_manage`'s registered-tool check. */
const knownDeskToolNames = async (): Promise<Set<string>> => {
    try {
        const { DESK_TOOL_DEFINITIONS, CHART_ACTION_TOOL_DEFS } = await import('../analysis/DeskToolsService');
        return new Set<string>([
            ...DESK_TOOL_DEFINITIONS.map(d => d.function.name),
            ...CHART_ACTION_TOOL_DEFS.map(d => d.function.name),
            'load_tools',
        ]);
    } catch {
        return new Set<string>();
    }
};

/** Route one whitelisted emission to its executor and return its receipt. */
const emit = async (emission: BackgroundReviewEmission): Promise<{ ok: boolean; undoSnapshot?: unknown; error?: string }> => {
    // Belt-and-suspenders: the review already refuses non-whitelisted tools;
    // this adapter would not know how to execute one anyway.
    if (!BACKGROUND_REVIEW_ALLOWED_TOOLS.has(emission.tool)) {
        return { ok: false, error: `"${emission.tool}" is not a background-review tool (memory | skill_manage only).` };
    }
    // A NO-TRADER pass gets the SAME privacy gate as a model call. The review
    // quotes the trader's raw words into these entries, so filtering here is
    // the only place the sensitive-memory opt-out can be honoured.
    const { filterMemoryWrite } = await import('../../utils/memoryWriteFilters');
    const { getHarnessSettings } = await import('../../utils/harnessSettings');
    const rawOps = emission.tool === 'memory' ? emission.args.operations : undefined;
    const fields = emission.tool === 'memory'
        ? (Array.isArray(rawOps) ? rawOps : []).flatMap(op => {
            const row = (op ?? {}) as Record<string, unknown>;
            return [String(row.content ?? ''), String(row.old_text ?? '')];
        })
        : [String(emission.args.body ?? ''), String(emission.args.description ?? '')];
    const sensitiveAllowed = getHarnessSettings().sensitiveMemoryEnabled === true;
    for (const field of fields) {
        if (!field.trim()) continue;
        const verdict = filterMemoryWrite(field);
        if (verdict.refused) return { ok: false, error: `background write refused: ${verdict.refused}` };
        if (verdict.sensitive && !sensitiveAllowed) {
            return { ok: false, error: 'background write refused: sensitive-category text with sensitive memory off' };
        }
    }
    if (emission.tool === 'memory') {
        const { applyCuratedMemoryOps } = await import('./curatedMemory');
        const args = emission.args as { target?: unknown; operations?: unknown };
        const target = args.target === 'user' || args.target === 'memory' ? args.target : null;
        if (!target || !Array.isArray(args.operations)) {
            return { ok: false, error: 'memory emission needs { target: "user" | "memory", operations: [...] }.' };
        }
        const receipt = await applyCuratedMemoryOps(target, args.operations as Parameters<typeof applyCuratedMemoryOps>[1]);
        return { ok: receipt.ok, undoSnapshot: receipt.undoSnapshot, error: receipt.error ? receipt.message : undefined };
    }
    const { skillManage } = await import('./skillManage');
    const receipt = await skillManage(
        emission.args as unknown as Parameters<typeof skillManage>[0],
        await knownDeskToolNames(),
    );
    return { ok: receipt.ok, undoSnapshot: receipt.undoSnapshot, error: receipt.error };
};

export interface AgentLearningPassInput {
    /** The session the turn ran in (receipt provenance). */
    sid: string;
    /** The trader's raw message this turn. */
    userMessage: string;
    /** The assistant's final answer this turn. */
    assistantMessage: string;
    /** How many desk-tool calls the turn made. */
    toolCallCount: number;
    /** Skill slugs the turn loaded via skill_view. */
    skillsUsed: string[];
}

/**
 * The post-turn background review, against the REAL executors. Fire-and-forget
 * from the caller (never awaited on the streaming path); the returned receipt
 * is for logs/tests. Returns null when the feature is disabled.
 */
export const maybeRunAgentLearningPass = async (
    input: AgentLearningPassInput,
): Promise<BackgroundReviewReceipt | null> => {
    const settings = getHarnessSettings();
    if (!settings.backgroundReviewEnabled) return null;
    return runBackgroundReview({
        toolCallCount: input.toolCallCount,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        skillsUsed: input.skillsUsed,
        enabled: true,
        sourceSessionId: input.sid,
    }, { emit });
};

/**
 * The periodic Dream, gated on its own settings switch + eligibility
 * (>= 24h + >= 5 new sessions). Fire-and-forget; safe to call after every
 * turn — the gate makes the common case a no-op, and the module lock makes
 * overlapping calls share one run.
 */
export const maybeRunMemoryDreamIfDue = async (): Promise<DreamRunResult | null> => {
    if (!getHarnessSettings().memoryDreamEnabled) return null;
    return runMemoryDream();
};
