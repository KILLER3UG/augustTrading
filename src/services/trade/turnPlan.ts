/**
 * turnPlan — the EPHEMERAL, turn-scoped `update_plan` checklist.
 *
 * A plan is not memory: it lives only while one turn is streaming and is
 * cleared when that turn settles. It is keyed by session so a dock turn and a
 * Chat turn cannot overwrite each other's checklist. The React pill subscribes
 * here rather than reading a tool receipt, because the plan is UI state the
 * model proposed — never a persisted document, never a signal, never a skill.
 */

export type TurnPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface TurnPlanStep {
    id: string;
    label: string;
    status: TurnPlanStepStatus;
}

export interface TurnPlan {
    steps: TurnPlanStep[];
    updatedAt: number;
}

export interface NormalizedPlan {
    ok: true;
    steps: TurnPlanStep[];
}

export interface RefusedPlan {
    ok: false;
    error: string;
}

export const PLAN_MIN_STEPS = 1;
export const PLAN_MAX_STEPS = 12;
export const PLAN_LABEL_MAX_CHARS = 80;
export const PLAN_ID_MAX_CHARS = 40;
const STATUSES: readonly TurnPlanStepStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * Validate and normalize the model's plan AT THE EXECUTOR. Never trust the
 * shape: a 40-step plan would bury the composer, a duplicate id would make a
 * UI row ambiguous, and an unknown status would leave a step with no glyph.
 */
export const normalizePlanSteps = (raw: unknown): NormalizedPlan | RefusedPlan => {
    const steps = (raw as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) {
        return { ok: false, error: 'update_plan needs { steps: [...] }.' };
    }
    if (steps.length < PLAN_MIN_STEPS || steps.length > PLAN_MAX_STEPS) {
        return { ok: false, error: `update_plan needs ${PLAN_MIN_STEPS}–${PLAN_MAX_STEPS} steps (got ${steps.length}).` };
    }
    const seen = new Set<string>();
    const normalized: TurnPlanStep[] = [];
    for (const [i, step] of steps.entries()) {
        const row = (step ?? {}) as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id.trim().slice(0, PLAN_ID_MAX_CHARS) : '';
        const label = typeof row.label === 'string' ? row.label.replace(/\s+/g, ' ').trim() : '';
        const status = typeof row.status === 'string' && STATUSES.includes(row.status as TurnPlanStepStatus)
            ? row.status as TurnPlanStepStatus
            : 'pending';
        if (!id || !label) return { ok: false, error: `steps[${i}] needs a non-empty id and label.` };
        if (label.length > PLAN_LABEL_MAX_CHARS) {
            return { ok: false, error: `steps[${i}].label is over ${PLAN_LABEL_MAX_CHARS} chars — use a concise step.` };
        }
        if (seen.has(id)) return { ok: false, error: `steps[${i}].id "${id}" is duplicated — ids must be unique.` };
        seen.add(id);
        normalized.push({ id, label, status });
    }
    return { ok: true, steps: normalized };
};

// ─── Per-session live store ─────────────────────────────────────────────────

type Listener = (sessionId: string, plan: TurnPlan | null) => void;
const plans = new Map<string, TurnPlan>();
const listeners = new Set<Listener>();
const PLAN_MAP_CAP = 8;

const notify = (sessionId: string): void => {
    const plan = plans.get(sessionId) ?? null;
    for (const listener of listeners) {
        try { listener(sessionId, plan); } catch { /* a render listener never breaks a tool call */ }
    }
};

export const setTurnPlan = (sessionId: string, steps: TurnPlanStep[]): TurnPlan => {
    const key = sessionId || 'default';
    const plan: TurnPlan = { steps, updatedAt: Date.now() };
    plans.set(key, plan);
    while (plans.size > PLAN_MAP_CAP) {
        const oldest = plans.keys().next().value;
        if (oldest === undefined) break;
        plans.delete(oldest);
    }
    notify(key);
    return plan;
};

export const getTurnPlan = (sessionId: string): TurnPlan | null => plans.get(sessionId || 'default') ?? null;

/**
 * The pill has ONE focus: the most recently updated plan across all sessions.
 * A Chat turn is keyed by conversation id while the dock composer holds a
 * session id, so a pill that subscribes by its own id can miss a plan that was
 * just written under the other key. There is only ever one streaming turn in
 * focus, so rendering the latest plan is both simpler and correct.
 */
export const getLatestTurnPlan = (): TurnPlan | null => {
    let latest: TurnPlan | null = null;
    for (const plan of plans.values()) {
        if (!latest || plan.updatedAt >= latest.updatedAt) latest = plan;
    }
    return latest;
};

export const clearTurnPlan = (sessionId: string): void => {
    const key = sessionId || 'default';
    if (!plans.delete(key)) return;
    notify(key);
};

/** A transport loop settles a whole turn at once and has no sessionId of its
 *  own. Clearing the (tiny, capped) map there is the turn's end-of-life; the
 *  UI also clears on its own settle signal, so this is a belt-and-suspenders
 *  guard against a stale pill after a provider error. */
export const clearAllTurnPlans = (): void => {
    const keys = [...plans.keys()];
    if (keys.length === 0) return;
    plans.clear();
    for (const key of keys) notify(key);
};

export const subscribeTurnPlan = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
