/**
 * tradeDecision — the APPROVE / REJECT / UNDO logic behind the decision card
 * (redesign Phase 3).
 *
 * A presented plan used to offer exactly one trader action: "Track this
 * trade". The decision card replaces it with three one-tap actions —
 * **Approve** (log + monitor + a receipt the model reads in conversation),
 * **Reject** (a recorded decline with an optional reason) and **Ask why**
 * (a pre-filled pushback prompt). This module owns the pure logic all three
 * need, so the card stays presentational and App stays a thin writer:
 *
 *  - STALENESS — a plan is priced for a moment. Before an approval lands,
 *    the live mark is compared with the proposed entry: past a threshold
 *    (a fraction of the stop distance) or past the validity window the plan
 *    is STALE. The card shows the drift and asks for a re-confirm — an
 *    approval is never silent about a market that moved.
 *  - THE RECEIPT — one harness turn per decision, so the model learns in
 *    conversation that its plan was approved and which journal row now
 *    owns it. The receipt is a RECORD, not a request: it carries no tool
 *    call and grants no authority — every authority tool still only records
 *    a proposal that needs the trader's card.
 *  - THE DECLINE — a trader Reject writes the same HOLD ledger the model's
 *    own `decline_trade` writes, with `source: 'desk'`, so "the trader
 *    declined this" is evidence the learning loop can read.
 *  - THE UNDO — a short window after Approve in which the approval can be
 *    reversed cleanly: journal row deleted, receipt message removed, plan
 *    watch disarmed, receipt dedupe cleared so a later approve re-receipts.
 *
 * The module-scope maps are bounded like every other disposition store: a
 * long-lived session must not accumulate state forever.
 */

import { harnessTurn } from '../../utils/harnessMarks';
import { recordDecline, type DeclineRecord } from './declineLog';
import { collectLiveMarketContextForSymbol } from './scopedRulesRuntime';

// ── The three thresholds the card's honesty is built on ─────────────────────

/** A proposal older than this is EXPIRED: the market it was priced against
 *  is gone, and the card says so instead of approving a stale plan. */
export const PROPOSAL_VALIDITY_MS = 30 * 60_000;

/** A plan is STALE when the live mark has moved past this fraction of the
 *  stop distance from the proposed entry. Half the stop is the honest line:
 *  beyond it the plan's R:R is materially not the plan that was presented. */
export const DRIFT_STOP_FRACTION = 0.5;

/** How long after Approve the trader may undo it. Long enough to notice a
 *  mis-click, short enough that "undo" never reads as a second decision
 *  path. The row, the receipt and the watch are all reversed inside it. */
export const UNDO_WINDOW_MS = 12_000;

// ── Staleness ────────────────────────────────────────────────────────────────

export interface ProposalStaleness {
    /** True when the plan should not be approved without a re-confirm. */
    stale: boolean;
    /** True specifically because the proposal outlived its validity window. */
    expired: boolean;
    /** mark − entry, signed. null when no live mark is available. */
    drift: number | null;
    /** drift as a percent of the entry. null when no live mark. */
    driftPct: number | null;
    /** |stop − entry| — the ruler the drift threshold is measured against. */
    stopDistance: number | null;
    /** Human sentences the card prints verbatim, in reading order. */
    reasons: string[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Assess one proposal against the live mark and the clock.
 *
 *  Every input is optional-tolerant on purpose: a proposal without a stop
 *  (no ruler), a canvas without a mark (no drift) or an entry without a
 *  timestamp (no age) each degrade to "not stale on that axis" — the card
 *  never invents a drift it cannot measure, and the reasons array says what
 *  IS known when it is stale. */
export const assessProposalStaleness = (input: {
    entry?: unknown;
    stopLoss?: unknown;
    mark?: number | null;
    presentedAt?: number | null;
    nowMs?: number;
}): ProposalStaleness => {
    const reasons: string[] = [];
    const entry = finite(input.entry) ? input.entry : null;
    const stopLoss = finite(input.stopLoss) ? input.stopLoss : null;
    const mark = finite(input.mark) ? input.mark : null;
    const nowMs = input.nowMs ?? Date.now();

    const stopDistance = entry !== null && stopLoss !== null ? Math.abs(stopLoss - entry) : null;

    // Age: only a real timestamp can expire. `0` is "never presented", not
    // "presented at the epoch".
    const ageMs = input.presentedAt && input.presentedAt > 0 ? Math.max(0, nowMs - input.presentedAt) : null;
    const expired = ageMs !== null && ageMs > PROPOSAL_VALIDITY_MS;
    if (expired && ageMs !== null) {
        const mins = Math.round(ageMs / 60_000);
        reasons.push(`This plan is ${mins}m old — past its ${Math.round(PROPOSAL_VALIDITY_MS / 60_000)}m validity window. The market it was priced against has moved on.`);
    }

    let drift: number | null = null;
    let driftPct: number | null = null;
    if (mark !== null && entry !== null && entry !== 0) {
        drift = mark - entry;
        driftPct = (drift / entry) * 100;
        const driftedPastStop = stopDistance !== null && stopDistance > 0
            && Math.abs(drift) > DRIFT_STOP_FRACTION * stopDistance;
        if (driftedPastStop && stopDistance !== null) {
            const dir = drift > 0 ? 'above' : 'below';
            reasons.push(`The live mark ${mark} is ${dir} the proposed entry ${entry} by ${Math.abs(driftPct).toFixed(2)}% — more than ${Math.round(DRIFT_STOP_FRACTION * 100)}% of the stop distance (${stopDistance}). The R:R you would be approving is not the plan on this card.`);
        }
    }

    return {
        stale: reasons.length > 0,
        expired,
        drift,
        driftPct,
        stopDistance,
        reasons,
    };
};

// ── The approval receipt ─────────────────────────────────────────────────────

/** One receipt per decision. Keyed by plan id — a replayed card, a double
 *  tap or a second approve after an undo's re-approve must never enqueue a
 *  second receipt for the same decision. Bounded. */
const receiptedPlans = new Set<string>();
const MAX_RECEIPTS = 500;

export const hasApprovalReceipt = (planId: string): boolean => receiptedPlans.has(planId);

export const markApprovalReceipt = (planId: string): void => {
    if (!planId) return;
    if (receiptedPlans.size >= MAX_RECEIPTS) {
        const oldest = receiptedPlans.values().next();
        if (!oldest.done) receiptedPlans.delete(oldest.value);
    }
    receiptedPlans.add(planId);
};

/** An undo reverses the decision, so its receipt slot must free: a later
 *  re-approve is a NEW decision and owes the model a fresh receipt. */
export const clearApprovalReceipt = (planId: string): void => { receiptedPlans.delete(planId); };

export const __clearApprovalReceiptsForTests = (): void => { receiptedPlans.clear(); };

/** The receipt turn the harness runs so the model learns the decision in
 *  conversation.
 *
 *  Same bracket dialect as the `[HARNESS TRIGGER …]` watch signals — this is
 *  the app speaking, not the trader. The last line is the authority fence:
 *  the receipt invites a STATUS update, never an action. (The structural
 *  half of that fence lives in the tools themselves — update_trade /
 *  close_trade / risk changes only ever RECORD a proposal the trader must
 *  confirm — so even a model that ignores this line cannot act on it.) */
export const formatApprovalReceiptForModel = (p: {
    planId?: string;
    symbol: string;
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    rowId: string;
    watchArmed: boolean;
    /** The session guard's state at approval time — 'clear' or the active
     *  warnings. The deterministic limits live in code, not in this text, so
     *  the model may READ the session state here but is never told it may
     *  argue with it. */
    sessionGuard?: string;
}): string => harnessTurn(
    `[APPROVAL RECEIPT — the app, not the trader] The trader APPROVED your plan`
    + `${p.planId ? ` ${p.planId}` : ''}: ${p.direction} ${p.symbol} entry ${p.entry}, stop ${p.stopLoss}, targets ${p.takeProfits.join('/')}.`
    + ` It is logged as journal row "${p.rowId}" (PENDING — the harness settles it from the tape).`
    + ` ${p.watchArmed ? 'The level watch is armed and will wake you on a hit.' : 'No level watch is armed for it.'}`
    + `${p.sessionGuard ? ` Session guard: ${p.sessionGuard}.` : ''}`
    + ` This receipt is a record, not a request: do not move levels, close the trade or change risk on your own — any of those needs a fresh proposal card the trader confirms. You may acknowledge the approval in one short line.`,
);

/** The undo receipt: the model must learn an approval it saw was reversed,
 *  or it keeps reasoning about a trade that no longer exists. */
export const formatApprovalUndoneForModel = (p: { planId?: string; rowId: string }): string =>
    harnessTurn(
        `[APPROVAL UNDONE — the app, not the trader] The trader undid the approval of plan`
        + `${p.planId ? ` ${p.planId}` : ''} within the undo window: journal row "${p.rowId}" is deleted and nothing is tracked.`
        + ` Do not reference it as an open or logged trade. A new proposal card is required before anything is logged again.`,
    );

// ── The trader's decline ─────────────────────────────────────────────────────

/** A trader Reject writes the HOLD ledger — the same store `decline_trade`
 *  writes, so the journal's decline history reads one way regardless of who
 *  declined. The reason is optional: a decline without a stated reason is
 *  still a decline, recorded as such. */
export const recordTraderDecline = (p: {
    symbol?: string;
    direction?: 'Long' | 'Short';
    entry?: number;
    stopLoss?: number;
    takeProfits?: number[];
    planId?: string;
}, reason?: string): DeclineRecord | null => {
    const base = `The trader declined the proposal${p.planId ? ` (plan ${p.planId})` : ''}`;
    const liveCtx = p.symbol ? collectLiveMarketContextForSymbol(p.symbol) : null;
    return recordDecline({
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entry,
        stopLoss: p.stopLoss,
        takeProfits: p.takeProfits,
        reason: reason && reason.trim() ? `${base}: ${reason.trim()}` : `${base} without a stated reason.`,
        ...(liveCtx?.regime ? { regime: liveCtx.regime } : {}),
        ...(liveCtx?.session ? { session: liveCtx.session } : {}),
        source: 'desk',
    });
};

// ── The undo window ──────────────────────────────────────────────────────────

/** Which entry's approval is inside its undo window, and what that approval
 *  produced — keyed by the TRANSCRIPT ENTRY id (the card's identity), because
 *  the card is what renders the undo affordance. The dock transcript is
 *  virtualized: a card can unmount and remount mid-window, so this lives at
 *  module scope exactly like the proposal dispositions. */
const undoWindows = new Map<string, { rowId: string; planId?: string; deadline: number }>();

export const markUndoWindow = (entryId: string, rowId: string, planId?: string, nowMs = Date.now()): void => {
    if (!entryId || !rowId) return;
    if (undoWindows.size >= MAX_RECEIPTS) {
        const oldest = undoWindows.keys().next();
        if (!oldest.done) undoWindows.delete(oldest.value);
    }
    undoWindows.set(entryId, { rowId, planId, deadline: nowMs + UNDO_WINDOW_MS });
};

export const undoWindowOf = (entryId: string, nowMs = Date.now()): { rowId: string; planId?: string; msLeft: number } | undefined => {
    const w = undoWindows.get(entryId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        // The window closed: forget it so the map does not grow forever.
        undoWindows.delete(entryId);
        return undefined;
    }
    return { rowId: w.rowId, planId: w.planId, msLeft };
};

/** The undo is being executed (or the window expired and a caller is cleaning
 *  up): forget the window. */
export const clearUndoWindow = (entryId: string): void => { undoWindows.delete(entryId); };

export const __clearUndoWindowsForTests = (): void => { undoWindows.clear(); };
