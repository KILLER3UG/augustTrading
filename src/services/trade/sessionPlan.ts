/**
 * sessionPlan — the agent's PROPOSED plan for the coming session, and the
 * trader's decision on it.
 *
 * WHY THIS EXISTS. Analysis produces structure, liquidity, catalysts and a
 * bias; a signal turns that into direction, trigger, invalidation and targets.
 * The plan for a session is the bounded form of that signal: a short list of
 * focus pairs, a bias, how many trades may be taken, how much may be lost, and
 * what would prove the read wrong. The agent may PROPOSE it, but only the
 * trader's confirm ACTIVATES it — through this module's persist path, the same
 * way the trader's own settings are written. The agent never activates a plan
 * directly.
 *
 * THE SHAPE mirrors riskChangeProposal / strategyActivation: a proposal that
 * resolves on a decision, keyed by its target (here: the session date), with a
 * short revert window after a confirm. One pending plan per date — a new
 * proposal supersedes an open one, because the newest reasoning is the one
 * worth reading. `decided` keys on the PROPOSAL id, so a new plan for the same
 * date is a new decision, never one masked by the previous plan's state.
 *
 * The active plan is PERSISTED (username-scoped) so it survives a reload — the
 * in-memory Maps are an interaction cache, not the source of truth. Every
 * localStorage access is wrapped: private mode / tests may have no storage.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { harnessTurn } from '../../utils/harnessMarks';

export type SessionPlanBias = 'Long' | 'Short' | 'Neutral' | 'Selective';

export interface SessionPlanProposal {
    id: string;
    dateKey: string;
    focusPairs: string[];
    sessionBias: SessionPlanBias;
    invalidations: string[];
    maxTrades: number;
    maxLossR: number;
    notes?: string;
    reason: string;
    createdAt: string;
}

export interface ActiveSessionPlan extends SessionPlanProposal {
    confirmedAt: string;
}

type SessionPlanDecisionState = 'confirmed' | 'dismissed';

type SessionPlanCheck =
    | { ok: true; proposal: SessionPlanProposal }
    | { ok: false; refused: string };

const SESSION_BIASES: readonly SessionPlanBias[] = ['Long', 'Short', 'Neutral', 'Selective'];

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One pending plan per session date; a new proposal supersedes the open one. */
const MAX_PENDING_PLANS = 100;

const pending = new Map<string, SessionPlanProposal>();
const decided = new Map<string, SessionPlanDecisionState>();

/** UTC date key — the same boundary the trader's session guard reads. */
export const currentSessionDateKey = (nowMs: number = Date.now()): string => new Date(nowMs).toISOString().slice(0, 10);

/** The one storage key, username-scoped. `getActiveUsername` reads localStorage
 *  internally, so resolve it defensively too — a throwing getItem must not
 *  take down a read/write that is itself wrapped. */
const resolveKey = (username?: string): string => {
    const name = username !== undefined ? username : ((): string => {
        try {
            return getActiveUsername();
        } catch {
            return 'default';
        }
    })();
    return `session_plan_v1_${name}`;
};

/** Dismissals have no persisted plan to prove them, so the DECISION itself is
 *  mirrored under the same registered prefix. Without it a dismissed card
 *  comes back pending after a reload — a second decision the trader never
 *  asked to make. */
const decisionsKey = (username?: string): string => `${resolveKey(username)}_decisions`;

const readDecisions = (username?: string): Record<string, 'confirmed' | 'dismissed'> => {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(decisionsKey(username));
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, 'confirmed' | 'dismissed'> : {};
    } catch {
        return {};
    }
};

const writeDecision = (id: string, state: 'confirmed' | 'dismissed', username?: string): void => {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(decisionsKey(username), JSON.stringify({ ...readDecisions(username), [id]: state }));
    } catch { /* private mode — the in-memory decision still stands */ }
};

/** The persisted disposition for a mirrored card, or undefined when the card
 *  is still open. Hydration reads this BEFORE falling back to plan evidence. */
export const readSessionPlanDecision = (
    proposalId: string,
    username?: string,
): 'confirmed' | 'dismissed' | undefined => readDecisions(username)[proposalId];

/** Validate a proposal from pure inputs; exported for the contract check. */
export const checkSessionPlanProposal = (input: {
    focusPairs: unknown;
    sessionBias: unknown;
    invalidations: unknown;
    maxTrades: unknown;
    maxLossR: unknown;
    reason: unknown;
    notes?: unknown;
    dateKey?: unknown;
}): SessionPlanCheck => {
    const rawPairs = input?.focusPairs;
    if (!Array.isArray(rawPairs) || rawPairs.length === 0) {
        return { ok: false, refused: 'a session plan needs at least one focus pair' };
    }
    const focusPairs: string[] = [];
    for (const pair of rawPairs) {
        if (typeof pair !== 'string' || !pair.trim()) {
            return { ok: false, refused: 'focusPairs must be non-blank strings' };
        }
        focusPairs.push(pair.trim());
    }

    const rawInvalidations = input?.invalidations;
    if (!Array.isArray(rawInvalidations) || rawInvalidations.length === 0) {
        return { ok: false, refused: 'a session plan needs at least one invalidation' };
    }
    const invalidations: string[] = [];
    for (const invalidation of rawInvalidations) {
        if (typeof invalidation !== 'string' || !invalidation.trim()) {
            return { ok: false, refused: 'invalidations must be non-blank strings' };
        }
        invalidations.push(invalidation.trim());
    }

    const bias = input?.sessionBias;
    if (typeof bias !== 'string' || !(SESSION_BIASES as readonly string[]).includes(bias)) {
        return { ok: false, refused: 'sessionBias must be Long, Short, Neutral or Selective' };
    }
    const sessionBias = bias as SessionPlanBias;

    const maxTrades = typeof input.maxTrades === 'number'
        ? input.maxTrades
        : Number(String(input.maxTrades ?? '').trim());
    if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades > 20) {
        return { ok: false, refused: 'maxTrades must be a whole number between 1 and 20' };
    }

    const maxLossR = typeof input.maxLossR === 'number'
        ? input.maxLossR
        : Number(String(input.maxLossR ?? '').trim());
    if (!Number.isFinite(maxLossR) || maxLossR < 0.5 || maxLossR > 10) {
        return { ok: false, refused: 'maxLossR must be between 0.5 and 10' };
    }

    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) {
        return { ok: false, refused: 'a session plan needs a reason the trader can read' };
    }

    // A supplied dateKey is a promise about which session the plan bounds:
    // validate the YYYY-MM-DD form or refuse it — never silently retarget a
    // dated plan to today. Absent (or blank) means today's session date.
    const rawDateKey = input?.dateKey;
    let dateKey: string;
    if (rawDateKey === undefined || rawDateKey === null || rawDateKey === '') {
        dateKey = currentSessionDateKey();
    } else if (typeof rawDateKey === 'string' && DATE_KEY_PATTERN.test(rawDateKey)) {
        dateKey = rawDateKey;
    } else {
        return { ok: false, refused: 'dateKey must be a YYYY-MM-DD string' };
    }

    const rawNotes = input?.notes;
    const notes = typeof rawNotes === 'string' && rawNotes.trim() ? rawNotes.trim() : undefined;

    const proposal: SessionPlanProposal = {
        id: `session-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        dateKey,
        focusPairs,
        sessionBias,
        invalidations,
        maxTrades,
        maxLossR,
        reason,
        createdAt: new Date().toISOString(),
    };
    if (notes !== undefined) proposal.notes = notes;

    return { ok: true, proposal };
};

/** Validate and RECORD a proposal. Nothing is activated — only the trader's
 *  confirm writes the active plan. One pending per date; a new proposal
 *  supersedes the previous open one. */
export const proposeSessionPlan = (input: {
    focusPairs: unknown;
    sessionBias: unknown;
    invalidations: unknown;
    maxTrades: unknown;
    maxLossR: unknown;
    reason: unknown;
    notes?: unknown;
    dateKey?: unknown;
}): SessionPlanCheck => {
    const checked = checkSessionPlanProposal(input);
    if (!checked.ok) return checked;
    pending.set(checked.proposal.dateKey, checked.proposal);
    while (pending.size > MAX_PENDING_PLANS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

export const pendingSessionPlan = (dateKey: string = currentSessionDateKey()): SessionPlanProposal | undefined => pending.get(dateKey);

export const sessionPlanStateOf = (proposalId: string): SessionPlanDecisionState | undefined => decided.get(proposalId);

/** The trader confirmed. Find the pending plan BY ID (the slot is keyed by
 *  date, and a superseded card may still be on screen), optionally require the
 *  tapped card's date, clear the slot, record the decision, and persist the
 *  active plan under the username's key. */
export const confirmSessionPlan = (
    proposalId: string,
    expectedDateKey?: string,
    username?: string,
): ActiveSessionPlan | undefined => {
    let slot: string | undefined;
    let found: SessionPlanProposal | undefined;
    for (const [key, proposal] of pending) {
        if (proposal.id === proposalId) {
            slot = key;
            found = proposal;
            break;
        }
    }
    if (!found || slot === undefined) return undefined;
    if (expectedDateKey !== undefined && found.dateKey !== expectedDateKey) return undefined;

    pending.delete(slot);
    decided.set(proposalId, 'confirmed');
    writeDecision(proposalId, 'confirmed', username);
    const active: ActiveSessionPlan = { ...found, confirmedAt: new Date().toISOString() };
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(resolveKey(username), JSON.stringify(active));
        }
    } catch { /* private mode — the in-memory decision still stands */ }
    return active;
};

/** The trader declined. Resolves the card; nothing is persisted. The DECISION
 *  is still mirrored under the caller's username key so a dismissed card does
 *  not come back pending after a reload. */
export const dismissSessionPlan = (proposalId: string, username?: string): boolean => {
    let slot: string | undefined;
    for (const [key, proposal] of pending) {
        if (proposal.id === proposalId) {
            slot = key;
            break;
        }
    }
    if (slot === undefined) return false;
    pending.delete(slot);
    decided.set(proposalId, 'dismissed');
    writeDecision(proposalId, 'dismissed', username);
    return true;
};

/** Read the persisted active plan for a session. The store is the truth across
 *  reloads, so a plan whose dateKey does not match the requested session is
 *  treated as absent. */
export const readActiveSessionPlan = (
    username?: string,
    dateKey: string = currentSessionDateKey(),
): ActiveSessionPlan | undefined => {
    try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(resolveKey(username));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as ActiveSessionPlan | null;
        if (!parsed || typeof parsed !== 'object') return undefined;
        return parsed.dateKey === dateKey ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/** Remove the stored key wholesale. `dateKey` is accepted for call-site
 *  symmetry but the plan for a username lives under one key. */
export const clearActiveSessionPlan = (username?: string, dateKey?: string): void => {
    void dateKey;
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(resolveKey(username));
    } catch { /* nothing to clear */ }
};

// ── The revert window ────────────────────────────────────────────────────────

export const SESSION_PLAN_REVERT_WINDOW_MS = 60_000;

const revertWindows = new Map<string, { previousPlan: ActiveSessionPlan | undefined; deadline: number }>();

/** Record what a confirmed plan REPLACED, so the card can offer to put it
 *  back. Keyed by the PROPOSAL id; the previous plan is stamped by the caller
 *  from the live store before the confirm writes the new one. */
export const markSessionPlanRevertWindow = (
    proposalId: string,
    previousPlan: ActiveSessionPlan | undefined,
    nowMs: number = Date.now(),
): void => {
    revertWindows.set(proposalId, { previousPlan, deadline: nowMs + SESSION_PLAN_REVERT_WINDOW_MS });
};

export const sessionPlanRevertOf = (
    proposalId: string,
    nowMs: number = Date.now(),
): { previousPlan: ActiveSessionPlan | undefined; msLeft: number } | undefined => {
    const w = revertWindows.get(proposalId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        revertWindows.delete(proposalId);
        return undefined;
    }
    return { previousPlan: w.previousPlan, msLeft };
};

/** Put the previous plan back (or clear the key when there was none), then
 *  close the window. An expired window reads as absent, so a stale card cannot
 *  revert a plan long after the window shut. */
export const revertSessionPlan = (proposalId: string, username?: string): ActiveSessionPlan | undefined => {
    const w = sessionPlanRevertOf(proposalId);
    if (!w) return undefined;
    try {
        if (typeof localStorage !== 'undefined') {
            if (w.previousPlan) localStorage.setItem(resolveKey(username), JSON.stringify(w.previousPlan));
            else localStorage.removeItem(resolveKey(username));
        }
    } catch { /* private mode — the window is still consumed */ }
    revertWindows.delete(proposalId);
    return w.previousPlan;
};

/** Hydration (F10): a mirrored pending card comes back after a reload with the
 *  stores empty — seed the date slot so it is interactive again, or record the
 *  decision evidence says already landed. */
export const seedSessionPlanForHydration = (
    proposal: SessionPlanProposal,
    decidedState?: SessionPlanDecisionState,
): void => {
    if (decidedState) {
        decided.set(proposal.id, decidedState);
        return;
    }
    pending.set(proposal.dateKey, proposal);
};

export const __clearSessionPlansForTests = (): void => {
    pending.clear();
    decided.clear();
    revertWindows.clear();
};

// ── The notes the model reads after the trader decides ──────────────────────

/** The confirm note: the plan is now in force for the session — the model
 *  must reason within its bounds, not re-decide them. */
export const formatSessionPlanAppliedForModel = (p: ActiveSessionPlan | SessionPlanProposal): string => harnessTurn(
    `[SESSION PLAN APPLIED — the app, not the trader] The trader CONFIRMED your session plan for ${p.dateKey}:`
    + ` focus pairs ${p.focusPairs.join(', ')}; bias ${p.sessionBias}; max trades ${p.maxTrades}; max loss ${p.maxLossR}R.`
    + ` It is ACTIVE for ${p.dateKey}. Reason within these bounds; a revert is the trader's call, not yours.`,
);

/** The revert note: the plan came back out while the model may still be
 *  reasoning with it. */
export const formatSessionPlanRevertedForModel = (p: ActiveSessionPlan | SessionPlanProposal): string => harnessTurn(
    `[SESSION PLAN REVERTED — the app, not the trader] The trader reverted your confirmed session plan for ${p.dateKey}:`
    + ` focus pairs ${p.focusPairs.join(', ')}; bias ${p.sessionBias}; max trades ${p.maxTrades}; max loss ${p.maxLossR}R are no longer active.`
    + ` Reason from the restored plan; do not apply the reverted plan without a fresh proposal.`,
);

/** A concise, bounded slice of the active plan for the seat's context — or ''
 *  when there is no confirmed plan for the session. Storage-safe. */
export const formatSessionPlanContextSummary = (username?: string, dateKey?: string): string => {
    const plan = readActiveSessionPlan(username, dateKey ?? currentSessionDateKey());
    if (!plan) return '';
    return `Session plan ${plan.dateKey}: focus ${plan.focusPairs.join(', ')}; bias ${plan.sessionBias};`
        + ` max trades ${plan.maxTrades}; max loss ${plan.maxLossR}R; invalidations ${plan.invalidations.join(', ')}.`
        + ` Trader-confirmed and active; reason within these bounds.`;
};
