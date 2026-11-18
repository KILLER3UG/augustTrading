/**
 * aiSettingProposal — the agent's PROPOSED toggle of an AI-behavior setting,
 * and what the trader did with it.
 *
 * WHY THIS EXISTS. Commit 4.7 took the AI-behavior switches out of Settings:
 * `Hybrid Intelligence` and `Desk Tools` are no longer hand-editable in the
 * modal. The trader still owns them — now the desk MAY PROPOSE a change and
 * the trader applies it on a decision card, through the same settings writer
 * the Settings screen would use. This module is the store behind that card.
 * It mirrors riskChangeProposal (and strategyActivation) on purpose: one
 * pending proposal per target, keyed by target, with decisions keyed by the
 * proposal's unique id so a new card never inherits an older decision.
 *
 * ASYMMETRY (the owner's rule): TURNING A CAPABILITY OFF is a tightening —
 * one tap. TURNING IT ON is a loosening — the card prints the before/after and
 * needs an explicit second tap (arm → confirm). A capability the desk switches
 * on for itself is the direction that can hurt, so it never lands on the tap
 * that proposed it.
 *
 * The tool NEVER writes a setting. `proposeAiSettingChange` only records;
 * App's confirm handler writes through setIsHybridIntelligenceEnabled /
 * saveHarnessSettings, marks the revert window and notes the thread.
 */

import { getHarnessSettings } from '../../utils/harnessSettings';
import { getActiveUsername } from '../../utils/activeUser';
import { harnessTurn } from '../../utils/harnessMarks';

export type AiSettingTarget = 'hybridIntelligence' | 'deskToolsEnabled';

export const AI_SETTING_TARGETS: readonly AiSettingTarget[] = ['hybridIntelligence', 'deskToolsEnabled'];

export interface AiSettingProposal {
    id: string;
    target: AiSettingTarget;
    /** Why, in the agent's words. Printed on the card. */
    reason: string;
    /** The value in force when the agent proposed (stamped at propose time —
     *  the card's "before" is a fact, never re-derived). */
    currentValue: boolean;
    proposedValue: boolean;
    /** OFF is a tighten (one tap); ON is a loosen (arm → confirm). */
    direction: 'tighten' | 'loosen';
    createdAt: string;
}

export type AiSettingChangeState = 'confirmed' | 'dismissed';

export type AiSettingCheck =
    | { ok: true; proposal: AiSettingProposal }
    | { ok: false; refused: string };

const isAiSettingTarget = (v: unknown): v is AiSettingTarget =>
    typeof v === 'string' && (AI_SETTING_TARGETS as readonly string[]).includes(v);

// ── The live Hybrid Intelligence flag ───────────────────────────────────────
// Unlike deskToolsEnabled this is NOT a harness setting: it lives in App state
// and is persisted in the user profile. A tool executor has no React state, so
// App mirrors the value here on every change; before that mirror exists (first
// boot, a probe) the durable profile is the fallback. Never guess OFF — a
// guessed "before" would refuse a legitimate OFF proposal or mint a false
// ON→OFF card for a capability that was already on.

let hybridMirror: boolean | undefined;

export const setHybridIntelligenceMirror = (value: boolean): void => { hybridMirror = value; };

export const getHybridIntelligenceMirror = (): boolean | undefined => hybridMirror;

export const currentHybridIntelligenceEnabled = async (): Promise<boolean> => {
    if (typeof hybridMirror === 'boolean') return hybridMirror;
    try {
        const username = getActiveUsername();
        if (username) {
            const { getUserProfile } = await import('../infrastructure/dbService');
            const profile = await getUserProfile(username);
            const flag = (profile?.settings as { isHybridIntelligenceEnabled?: boolean } | undefined)?.isHybridIntelligenceEnabled;
            if (typeof flag === 'boolean') return flag;
        }
    } catch { /* no profile store in this context — fall back to OFF */ }
    return false;
};

const MAX_PROPOSALS = 200;
const pending = new Map<AiSettingTarget, AiSettingProposal>();
/** Keyed by the PROPOSAL id — a second proposal for the same setting is a new
 *  decision and must not inherit the previous one's state. */
const decided = new Map<string, AiSettingChangeState>();

/** The one classifier — the card's tap count and the model receipt read it. */
export const classifyAiSettingChange = (
    proposed: boolean,
    current: boolean,
): 'tighten' | 'loosen' | 'same' => {
    if (proposed === current) return 'same';
    // Disabling a capability removes what the desk may do; enabling it grants.
    return proposed ? 'loosen' : 'tighten';
};

/** Pure validation. Exported for the contract check; no state is touched. */
export const checkAiSettingProposal = (input: {
    target: unknown;
    value: unknown;
    reason: unknown;
    currentValue: unknown;
}): AiSettingCheck => {
    const target = input?.target;
    if (!isAiSettingTarget(target)) return { ok: false, refused: 'an AI setting change needs a known target' };
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) return { ok: false, refused: 'an AI setting change needs a reason the trader can read' };
    if (typeof input.value !== 'boolean') return { ok: false, refused: `${target} must be a boolean (ON or OFF)` };
    if (typeof input.currentValue !== 'boolean') {
        return { ok: false, refused: `${target} needs a boolean current value` };
    }
    const direction = classifyAiSettingChange(input.value, input.currentValue);
    if (direction === 'same') {
        return { ok: false, refused: `${target} is already ${input.currentValue ? 'ON' : 'OFF'} — a proposal must change it` };
    }
    return {
        ok: true,
        proposal: {
            id: `ai-setting-${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            target,
            reason,
            currentValue: input.currentValue,
            proposedValue: input.value,
            direction,
            createdAt: new Date().toISOString(),
        },
    };
};

/** Record a proposal. `deskToolsEnabled` is read from live settings when the
 *  caller omits `currentValue`; `hybridIntelligence` lives in App state, so a
 *  caller that has no value defaults it to OFF (the build default). A pending
 *  proposal for the same target is superseded in place. */
export const proposeAiSettingChange = (input: {
    target: unknown;
    value: unknown;
    reason: unknown;
    currentValue?: boolean;
}): AiSettingCheck => {
    const target = (input ?? {}).target;
    if (!isAiSettingTarget(target)) return { ok: false, refused: 'an AI setting change needs a known target' };
    const currentValue: boolean = input.currentValue ?? (
        target === 'deskToolsEnabled' ? getHarnessSettings().deskToolsEnabled : false
    );
    const checked = checkAiSettingProposal({
        target,
        value: input?.value,
        reason: input?.reason,
        currentValue,
    });
    if (!checked.ok) return checked;
    pending.set(target, checked.proposal);
    while (pending.size > MAX_PROPOSALS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

export const pendingAiSettingChange = (target: AiSettingTarget): AiSettingProposal | undefined => pending.get(target);

export const aiSettingChangeStateOf = (proposalId: string): AiSettingChangeState | undefined => decided.get(proposalId);

/** `expectedId` is the id of the card that was tapped. A pending proposal is
 *  superseded in place, so resolving by target alone could apply an OLD change
 *  while marking the NEW proposal decided. A mismatch is a no-op. */
export const confirmAiSettingChange = (target: AiSettingTarget, expectedId?: string): AiSettingProposal | undefined => {
    const proposal = pending.get(target);
    if (!proposal) return undefined;
    if (expectedId !== undefined && proposal.id !== expectedId) return undefined;
    pending.delete(target);
    decided.set(proposal.id, 'confirmed');
    return proposal;
};

export const dismissAiSettingChange = (target: AiSettingTarget, expectedId?: string): boolean => {
    const proposal = pending.get(target);
    if (!proposal) return false;
    if (expectedId !== undefined && proposal.id !== expectedId) return false;
    pending.delete(target);
    decided.set(proposal.id, 'dismissed');
    return true;
};

// ── The revert window ────────────────────────────────────────────────────────

/** Same 60s window the risk and strategy cards use. */
export const AI_SETTING_REVERT_WINDOW_MS = 60_000;

const revertWindows = new Map<string, {
    previousValue: boolean;
    deadline: number;
    target: AiSettingTarget;
}>();

export const markAiSettingRevertWindow = (
    proposalId: string,
    previousValue: boolean,
    nowMs = Date.now(),
    target?: AiSettingTarget,
): void => {
    revertWindows.set(proposalId, {
        previousValue,
        deadline: nowMs + AI_SETTING_REVERT_WINDOW_MS,
        target: target ?? 'deskToolsEnabled',
    });
};

export const aiSettingRevertOf = (
    proposalId: string,
    nowMs = Date.now(),
): { previousValue: boolean; msLeft: number } | undefined => {
    const w = revertWindows.get(proposalId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        revertWindows.delete(proposalId);
        return undefined;
    }
    return { previousValue: w.previousValue, msLeft };
};

export const clearAiSettingRevertWindow = (proposalId: string): void => { revertWindows.delete(proposalId); };

/** The newest live revert, for a Settings UI that wants to offer "Undo" after
 *  a card was confirmed on the dock. Never returns an expired window. */
export const latestAiSettingRevert = (nowMs = Date.now()): {
    proposalId: string;
    target: AiSettingTarget;
    previousValue: boolean;
    msLeft: number;
} | undefined => {
    let best: { proposalId: string; target: AiSettingTarget; previousValue: boolean; msLeft: number } | undefined;
    for (const [proposalId, w] of revertWindows) {
        const msLeft = w.deadline - nowMs;
        if (msLeft <= 0) { revertWindows.delete(proposalId); continue; }
        if (!best || msLeft > best.msLeft) {
            best = { proposalId, target: w.target, previousValue: w.previousValue, msLeft };
        }
    }
    return best;
};

/** Hydration: a pending card mirrored into a persisted Message comes back
 *  after a reload with the stores empty — seed the slot so it stays live. */
export const seedAiSettingChangeForHydration = (
    proposal: AiSettingProposal,
    decidedState?: AiSettingChangeState,
): void => {
    if (decidedState) {
        decided.set(proposal.id, decidedState);
        return;
    }
    pending.set(proposal.target, proposal);
};

export const __clearAiSettingChangesForTests = (): void => {
    pending.clear();
    decided.clear();
    revertWindows.clear();
    hybridMirror = undefined;
};

// ── The notes the model reads after the trader decides ──────────────────────

export const formatAiSettingAppliedForModel = (p: AiSettingProposal): string => harnessTurn(
    `[AI SETTING APPLIED — the app, not the trader] The trader CONFIRMED your proposal:`
    + ` ${p.target} ${p.currentValue ? 'ON' : 'OFF'} -> ${p.proposedValue ? 'ON' : 'OFF'} (${p.direction}).`
    + ` The new setting is in force now and every seat reads it.`
    + ` Do not propose another change to the same setting without a new reason; a revert is the trader's call, not yours.`,
);

export const formatAiSettingRevertedForModel = (p: AiSettingProposal): string => harnessTurn(
    `[AI SETTING REVERTED — the app, not the trader] The trader reverted your confirmed change:`
    + ` ${p.target} is back at ${p.currentValue ? 'ON' : 'OFF'} (from ${p.proposedValue ? 'ON' : 'OFF'}).`
    + ` Reason with the restored setting; do not re-propose the same change without something new.`,
);
