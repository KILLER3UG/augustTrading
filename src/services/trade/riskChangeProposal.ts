/**
 * riskChangeProposal — the agent's PROPOSED change to a risk limit or the
 * session-guard preset, and what the trader did with it.
 *
 * WHY THIS EXISTS. The self-modification rails deliberately deny the agent
 * every risk path ("Risk. Sizing, leverage, the edge floor, the session guard
 * and outcome settlement are the trader's"). But the agent may SEE that a
 * limit is wrong for the market and SAY so — so the proposal exists as its
 * own object: the agent records what it would change and why, the transcript
 * renders it as a decision card, and the trader's confirm is the only thing
 * that applies it — through the SAME settings writer the trader's own
 * Settings screen uses. The agent never touches a risk value directly.
 *
 * ASYMMETRY (the owner's rule): TIGHTENING a limit is one tap. LOOSENING it
 * shows the before/after diff and needs an explicit confirm — the first tap
 * only arms the card, the second applies. `classifyRiskChange` is the one
 * place that decides which side a change falls on:
 *
 *   - riskPercent / defaultLeverage / guardDailyLossPct / guardMaxTradesPerDay:
 *     lower is tighter.
 *   - minEdgeR: HIGHER is tighter (a higher edge floor refuses more plans).
 *   - guardPreset: 'default' is the tight preset, 'ftmo' the looser one.
 *
 * The shape mirrors tradeActionProposal / settlementCorrection: a proposal
 * that resolves on a decision, keyed by its target. One pending proposal per
 * target — a new proposal supersedes an open one, because risk tuning is
 * ongoing and the newest reasoning is the one worth reading.
 */

import { getHarnessSettings } from '../../utils/harnessSettings';
import { harnessTurn } from '../../utils/harnessMarks';

export type RiskTarget =
    | 'riskPercent'
    | 'defaultLeverage'
    | 'minEdgeR'
    | 'guardDailyLossPct'
    | 'guardMaxTradesPerDay'
    | 'guardPreset';

export const RISK_TARGETS: readonly RiskTarget[] = [
    'riskPercent', 'defaultLeverage', 'minEdgeR',
    'guardDailyLossPct', 'guardMaxTradesPerDay', 'guardPreset',
];

export interface RiskChangeProposal {
    id: string;
    target: RiskTarget;
    /** Why, in the agent's words. Printed on the card. */
    reason: string;
    /** The value in force when the agent proposed (stamped at propose time —
     *  the card's "before" is a fact, never re-derived). */
    currentValue: number | string;
    proposedValue: number | string;
    direction: 'tighten' | 'loosen';
    createdAt: string;
}

export type RiskChangeState = 'confirmed' | 'dismissed';

export type RiskChangeCheck =
    | { ok: true; proposal: RiskChangeProposal }
    | { ok: false; refused: string };

/** The value bounds, mirroring the clamps harnessSettings applies on read —
 *  a proposal outside them would be a card for a setting the app refuses to
 *  hold. */
export const RISK_TARGET_LIMITS: Record<Exclude<RiskTarget, 'guardPreset'>, { min: number; max: number; integer?: boolean; label: string }> = {
    riskPercent: { min: 0.1, max: 10, label: 'risk per trade (%)' },
    defaultLeverage: { min: 1, max: 200, integer: true, label: 'default leverage (×)' },
    minEdgeR: { min: -5, max: 5, label: 'minimum edge (R)' },
    guardDailyLossPct: { min: 0.5, max: 10, label: 'daily loss limit (%)' },
    guardMaxTradesPerDay: { min: 1, max: 50, integer: true, label: 'max trades per day' },
};

const isRiskTarget = (v: unknown): v is RiskTarget =>
    typeof v === 'string' && (RISK_TARGETS as readonly string[]).includes(v);

/** Which way does this change move the risk? The ONE classifier — the card's
 *  colour, its tap count and the contract checks all read it. */
export const classifyRiskChange = (
    target: RiskTarget,
    current: number | string,
    proposed: number | string,
): 'tighten' | 'loosen' | 'same' => {
    if (target === 'guardPreset') {
        if (current === proposed) return 'same';
        return proposed === 'default' ? 'tighten' : 'loosen';
    }
    const c = typeof current === 'number' ? current : Number(current);
    const p = typeof proposed === 'number' ? proposed : Number(proposed);
    if (!Number.isFinite(c) || !Number.isFinite(p) || c === p) return 'same';
    if (target === 'minEdgeR') return p > c ? 'tighten' : 'loosen';
    return p < c ? 'tighten' : 'loosen';
};

const coerceValue = (target: RiskTarget, raw: unknown): { ok: true; value: number | string } | { ok: false; refused: string } => {
    if (target === 'guardPreset') {
        if (raw === 'default' || raw === 'ftmo') return { ok: true, value: raw };
        return { ok: false, refused: 'guardPreset must be "default" or "ftmo"' };
    }
    const limits = RISK_TARGET_LIMITS[target];
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    if (!Number.isFinite(n)) return { ok: false, refused: `${target} must be a number` };
    if (n < limits.min || n > limits.max) {
        return { ok: false, refused: `${target} must be between ${limits.min} and ${limits.max}` };
    }
    if (limits.integer && !Number.isInteger(n)) {
        return { ok: false, refused: `${target} must be a whole number` };
    }
    return { ok: true, value: n };
};

const MAX_PROPOSALS = 200;
const pending = new Map<RiskTarget, RiskChangeProposal>();
/** Keyed by the PROPOSAL id — a new proposal for the same limit is a new
 *  decision and must not inherit the previous one's state. */
const decided = new Map<string, RiskChangeState>();

/** Validate a proposal against the CURRENT setting. Pure inputs; exported for
 *  the contract check. `current` is what the setting is in force right now. */
export const checkRiskChangeProposal = (input: {
    target: RiskTarget;
    value: unknown;
    reason: unknown;
    currentValue: number | string;
}): RiskChangeCheck => {
    const target = input?.target;
    if (!isRiskTarget(target)) return { ok: false, refused: 'a risk change needs a known target' };
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) return { ok: false, refused: 'a risk change needs a reason the trader can read' };
    const value = coerceValue(target, input.value);
    if (!value.ok) return value;
    const direction = classifyRiskChange(target, input.currentValue, value.value);
    if (direction === 'same') {
        return { ok: false, refused: `${target} is already ${String(input.currentValue)} — a proposal must change it` };
    }
    return {
        ok: true,
        proposal: {
            // Unique per proposal: the decided/revert state keys on this id, so
            // a NEW proposal for the same limit is a NEW decision, never one
            // masked by the previous one's state.
            id: `risk-${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            target,
            reason,
            currentValue: input.currentValue,
            proposedValue: value.value,
            direction,
            createdAt: new Date().toISOString(),
        },
    };
};

/** Record a proposal for `target`. Reads the CURRENT setting itself, so the
 *  card's "before" is stamped from the live value at propose time. A pending
 *  proposal for the same target is superseded. */
export const proposeRiskChange = (input: { target: unknown; value: unknown; reason: unknown }): RiskChangeCheck => {
    const target = (input ?? {}).target;
    if (!isRiskTarget(target)) return { ok: false, refused: 'a risk change needs a known target' };
    const settings = getHarnessSettings();
    const currentValue: number | string = target === 'guardPreset'
        ? (settings.guardPreset ?? 'default')
        : (settings[target] as number);
    const checked = checkRiskChangeProposal({ target, value: input?.value, reason: input?.reason, currentValue });
    if (!checked.ok) return checked;
    pending.set(target, checked.proposal);
    while (pending.size > MAX_PROPOSALS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

export const pendingRiskChange = (target: RiskTarget): RiskChangeProposal | undefined => pending.get(target);

export const riskChangeStateOf = (proposalId: string): RiskChangeState | undefined => decided.get(proposalId);

/** The trader confirmed. Clears the proposal — the applied setting is the
 *  record from here. Returns the proposal so the applier knows what it wrote. */
export const confirmRiskChange = (target: RiskTarget): RiskChangeProposal | undefined => {
    const proposal = pending.get(target);
    if (!proposal) return undefined;
    pending.delete(target);
    decided.set(proposal.id, 'confirmed');
    return proposal;
};

/** The trader declined. Resolves the card; the setting is untouched. */
export const dismissRiskChange = (target: RiskTarget): boolean => {
    const proposal = pending.get(target);
    if (!proposal) return false;
    pending.delete(target);
    decided.set(proposal.id, 'dismissed');
    return true;
};

// ── The revert window ────────────────────────────────────────────────────────

/** How long the applied card offers its revert. Longer than the approval undo
 *  (a risk change deserves a longer look) but still a window, not a state. */
export const RISK_REVERT_WINDOW_MS = 60_000;

const revertWindows = new Map<string, { previousValue: number | string; deadline: number }>();

/** Record what a confirmed change REPLACED, so the card can offer to put it
 *  back. Keyed by the PROPOSAL id. The previous value is stamped by the
 *  applier from the proposal's own `currentValue` — never re-read after the
 *  fact. */
export const markRiskRevertWindow = (proposalId: string, previousValue: number | string, nowMs = Date.now()): void => {
    revertWindows.set(proposalId, { previousValue, deadline: nowMs + RISK_REVERT_WINDOW_MS });
};

export const riskRevertOf = (proposalId: string, nowMs = Date.now()): { previousValue: number | string; msLeft: number } | undefined => {
    const w = revertWindows.get(proposalId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        revertWindows.delete(proposalId);
        return undefined;
    }
    return { previousValue: w.previousValue, msLeft };
};

export const clearRiskRevertWindow = (proposalId: string): void => { revertWindows.delete(proposalId); };

export const __clearRiskChangesForTests = (): void => {
    pending.clear();
    decided.clear();
    revertWindows.clear();
};

// ── The notes the model reads after the trader decides ──────────────────────

/** The confirm note: the model must learn the limit actually moved (and that
 *  it may not move it again without a fresh card). */
export const formatRiskChangeAppliedForModel = (p: RiskChangeProposal): string => harnessTurn(
    `[RISK CHANGE APPLIED — the app, not the trader] The trader CONFIRMED your proposal:`
    + ` ${p.target} ${String(p.currentValue)} -> ${String(p.proposedValue)} (${p.direction}).`
    + ` The new limit is in force now and every sizing/guard read sees it.`
    + ` Do not propose another change to the same limit without a new reason; a revert is the trader's call, not yours.`,
);

/** The revert note: the limit went back while the model may still be reasoning
 *  about the new one. The proposal's `currentValue` IS the value that was
 *  replaced, so the revert reads it — no separate fact to keep in step. */
export const formatRiskChangeRevertedForModel = (p: RiskChangeProposal): string => harnessTurn(
    `[RISK CHANGE REVERTED — the app, not the trader] The trader reverted your confirmed change:`
    + ` ${p.target} is back at ${String(p.currentValue)} (from ${String(p.proposedValue)}).`
    + ` Reason with the restored limit; do not re-propose the same change without something new.`,
);
