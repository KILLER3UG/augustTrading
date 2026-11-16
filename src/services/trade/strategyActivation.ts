/**
 * strategyActivation — the agent's PROPOSED activation or retirement of one
 * strategy plan, and what the trader did with it.
 *
 * WHY THIS EXISTS. The agent may propose a strategy (`propose_strategy` → a
 * DRAFT in the notebook's strategies folder) and may read the journal's
 * verdicts on the plans in force — but today only the trader's Settings
 * screen can move a plan between draft / active / retired, so an agent that
 * can SEE a plan has earned or lost its edge cannot do anything but say so in
 * prose. This store is the same answer the risk card gives: the agent records
 * what it would change and why, the transcript renders it as a decision card,
 * and the trader's confirm applies it through the SAME writer the Settings
 * screen uses (`setStrategyStatus`). The agent never moves a plan's status
 * directly.
 *
 * There is no tighten/loosen asymmetry here — neither direction is a limit.
 * Activation puts a plan IN FRONT of the model every turn (it joins
 * `activeStrategiesBlock`), retirement takes it back out; the card prints the
 * before/after status and the reason either way, and the confirm is one tap.
 * A confirmed change keeps the same 60s revert window the risk card uses.
 *
 * The shape mirrors riskChangeProposal: a proposal that resolves on a
 * decision, keyed by slug, one pending proposal per strategy — a new proposal
 * supersedes an open one.
 */

import { getStrategy, type StrategyStatus } from '../learning/strategyStore';
import { harnessTurn } from '../../utils/harnessMarks';

export type StrategyAction = 'activate' | 'retire';

export interface StrategyActivationProposal {
    id: string;
    slug: string;
    /** The plan's display name, stamped at propose time — the card names the
     *  plan even if the notebook file is renamed or gone later. */
    name: string;
    action: StrategyAction;
    /** Why, in the agent's words. Printed on the card. */
    reason: string;
    /** The status in force when the agent proposed (stamped at propose time —
     *  the card's "before" is a fact, never re-derived). */
    currentStatus: StrategyStatus;
    proposedStatus: StrategyStatus;
    createdAt: string;
}

export type StrategyActivationState = 'confirmed' | 'dismissed';

export type StrategyActivationCheck =
    | { ok: true; proposal: StrategyActivationProposal }
    | { ok: false; refused: string };

const STATUS_FOR_ACTION: Record<StrategyAction, StrategyStatus> = {
    activate: 'active',
    retire: 'retired',
};

/** Validate a proposal. Pure inputs; exported for the contract check.
 *  `currentStatus` is what the plan holds right now; `slugExists` says the
 *  notebook actually has the file (the caller reads it live). */
export const checkStrategyActivation = (input: {
    slug: unknown;
    action: unknown;
    reason: unknown;
    currentStatus: StrategyStatus;
    slugExists: boolean;
}): StrategyActivationCheck => {
    const slug = typeof input?.slug === 'string' ? input.slug.trim() : '';
    if (!slug) return { ok: false, refused: 'a strategy activation needs the plan\'s slug (get_notebook_map lists them)' };
    const action = input?.action;
    if (action !== 'activate' && action !== 'retire') {
        return { ok: false, refused: 'action must be "activate" or "retire"' };
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) return { ok: false, refused: 'a strategy change needs a reason the trader can read' };
    if (!input.slugExists) return { ok: false, refused: `no strategy file for "${slug}" — get_notebook_map lists the plans that exist` };
    if (input.currentStatus === STATUS_FOR_ACTION[action]) {
        return { ok: false, refused: `"${slug}" is already ${input.currentStatus} — a proposal must change it` };
    }
    return {
        ok: true,
        proposal: {
            // Unique per proposal: the decided/revert state keys on this id, so
            // a NEW proposal for the same slug is a NEW decision, never one
            // masked by the previous one's state.
            id: `strat-${action}-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            slug,
            name: slug,
            action,
            reason,
            currentStatus: input.currentStatus,
            proposedStatus: STATUS_FOR_ACTION[action],
            createdAt: new Date().toISOString(),
        },
    };
};

const MAX_PROPOSALS = 100;
const pending = new Map<string, StrategyActivationProposal>();
/** Keyed by the PROPOSAL id — a new proposal for the same slug is a new
 *  decision and must not inherit the previous one's state. */
const decided = new Map<string, StrategyActivationState>();

/** Record a proposal for `slug`. Reads the plan's CURRENT status itself, so
 *  the card's "before" is stamped from the live notebook at propose time. A
 *  pending proposal for the same slug is superseded. */
export const proposeStrategyActivation = (input: { slug: unknown; action: unknown; reason: unknown }): StrategyActivationCheck => {
    const slug = typeof (input ?? {}).slug === 'string' ? (input as { slug: string }).slug.trim() : '';
    const meta = slug ? getStrategy(slug) : null;
    const checked = checkStrategyActivation({
        slug: input?.slug,
        action: input?.action,
        reason: input?.reason,
        currentStatus: meta?.status ?? 'draft',
        slugExists: !!meta,
    });
    if (!checked.ok) return checked;
    pending.set(checked.proposal.slug, { ...checked.proposal, name: meta?.name ?? checked.proposal.name });
    while (pending.size > MAX_PROPOSALS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

export const pendingStrategyActivation = (slug: string): StrategyActivationProposal | undefined => pending.get(slug);

export const strategyActivationStateOf = (proposalId: string): StrategyActivationState | undefined => decided.get(proposalId);

/** The trader confirmed. Clears the proposal — the applied status is the
 *  record from here. Returns the proposal so the applier knows what to write. */
export const confirmStrategyActivation = (slug: string): StrategyActivationProposal | undefined => {
    const proposal = pending.get(slug);
    if (!proposal) return undefined;
    pending.delete(slug);
    decided.set(proposal.id, 'confirmed');
    return proposal;
};

/** The trader declined. Resolves the card; the plan is untouched. */
export const dismissStrategyActivation = (slug: string): boolean => {
    const proposal = pending.get(slug);
    if (!proposal) return false;
    pending.delete(slug);
    decided.set(proposal.id, 'dismissed');
    return true;
};

// ── The revert window ────────────────────────────────────────────────────────

/** Same window as the risk card: long enough to notice, short enough that
 *  "revert" never reads as a second decision path. */
export const STRATEGY_REVERT_WINDOW_MS = 60_000;

const revertWindows = new Map<string, { previousStatus: StrategyStatus; deadline: number }>();

export const markStrategyRevertWindow = (proposalId: string, previousStatus: StrategyStatus, nowMs = Date.now()): void => {
    revertWindows.set(proposalId, { previousStatus, deadline: nowMs + STRATEGY_REVERT_WINDOW_MS });
};

export const strategyRevertOf = (proposalId: string, nowMs = Date.now()): { previousStatus: StrategyStatus; msLeft: number } | undefined => {
    const w = revertWindows.get(proposalId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        revertWindows.delete(proposalId);
        return undefined;
    }
    return { previousStatus: w.previousStatus, msLeft };
};

export const clearStrategyRevertWindow = (proposalId: string): void => { revertWindows.delete(proposalId); };

export const __clearStrategyActivationsForTests = (): void => {
    pending.clear();
    decided.clear();
    revertWindows.clear();
};

/** Test/contract seed: the propose wrapper reads the live notebook (which a
 *  sandbox has none of), so the pure check + this seed stand in for it. */
export const __seedPendingStrategyForTests = (proposal: StrategyActivationProposal): void => {
    pending.set(proposal.slug, proposal);
};

// ── The notes the model reads after the trader decides ──────────────────────

/** The confirm note: the model must learn the plan's status actually moved —
 *  an ACTIVATED plan joins the seat context (activeStrategiesBlock), a
 *  RETIRED one leaves it. */
export const formatStrategyActivationAppliedForModel = (p: StrategyActivationProposal): string => harnessTurn(
    `[STRATEGY ${p.action === 'activate' ? 'ACTIVATED' : 'RETIRED'} — the app, not the trader] The trader CONFIRMED your proposal:`
    + ` plan "${p.name}" (${p.slug}) is ${p.proposedStatus} (was ${p.currentStatus}).`
    + `${p.action === 'activate' ? ' Its rules join the seat context from the next turn.' : ' Its rules leave the seat context from the next turn; the record stays for evidence.'}`
    + ` Do not propose another change to the same plan without a new reason; a revert is the trader's call, not yours.`,
);

/** The revert note: the plan went back while the model may still be reasoning
 *  about the change. `previousStatus` is the value the applier stamped — what
 *  the revert actually restored, not an assumption. */
export const formatStrategyActivationRevertedForModel = (p: StrategyActivationProposal, previousStatus: StrategyStatus): string => harnessTurn(
    `[STRATEGY CHANGE REVERTED — the app, not the trader] The trader reverted your confirmed change:`
    + ` plan "${p.name}" (${p.slug}) is back at ${previousStatus} (from ${p.proposedStatus}).`
    + ` Reason with the restored status; do not re-propose the same change without something new.`,
);
