/**
 * settlementCorrection — the agent's PROPOSED correction to one journal row,
 * and what the trader did with it.
 *
 * WHY THIS EXISTS. The journal's outcome/PnL/leverage editors are the only way
 * a wrong settlement gets fixed, and they are being retired (the audit's P-6)
 * in favour of "the agent proposes, the trader confirms". This is the half that
 * makes that true rather than aspirational: a proposal is recorded here, the
 * transcript renders it as a card, and a confirm calls the SAME hook a human
 * edit calls (`useTradeJournalActions` › `handleUpdateTradeOutcome` /
 * `handleUpdateTradePnL`). There is no second write path — a correction carries
 * `correctedFrom`, `correctedAt` and `resolutionSource: 'correction'` because
 * that hook writes them, not because this file does.
 *
 * WHY IT HOLDS NO AUTHORITY. The store records intent; it never applies. An
 * unconfirmed proposal is inert, and a dismissed one is inert forever. The only
 * thing that moves a row is the confirm, and the confirm is the trader's tap.
 *
 * Shape follows `proposalDisposition` on purpose: keyed by row id, so a card
 * renders once and resolves, and a second proposal for the same row replaces the
 * first instead of stacking a second card.
 */

import { TradeOutcome } from '../../types/enums';

/** One proposed correction. Every field except `tradeId` and `reason` is
 *  optional, but at least ONE of outcome / pnlAmount / pnlPercent must be set:
 *  a correction that changes nothing is a card that lies about doing work. */
export interface SettlementCorrectionProposal {
    /** The journal row this corrects. The join key, and the card's identity. */
    tradeId: string;
    /** The outcome the agent says is right. Omit to leave the outcome alone. */
    outcome?: TradeOutcome;
    /** Absolute PnL in the row's own captured unit ($, or leveraged %). */
    pnlAmount?: number;
    /** PnL as a percentage, when the row carries one. */
    pnlPercent?: number;
    /** The entry the tape shows — for a row logged at a price the fill
     *  contradicts, or an entry the tracker missed (the capture modal's
     *  manual fill, as an agent-proposed card arm). */
    correctedEntry?: number;
    /** Why the row is wrong, in the agent's words. Printed on the card. */
    reason: string;
}

/** What the trader did with the card. `confirmed` is a FACT about the row, not
 *  about this map: the row is the record, and the map only stops the card from
 *  rendering again. */
export type SettlementCorrectionState = 'confirmed' | 'dismissed';

export type SettlementCorrectionRefusal =
    | 'a correction needs a trade row to correct'
    | 'a correction needs a reason the trader can read'
    | 'a correction must change at least one field - outcome, pnlAmount, pnlPercent or correctedEntry';

export type SettlementCorrectionCheck =
    | { ok: true; proposal: SettlementCorrectionProposal }
    | { ok: false; refused: SettlementCorrectionRefusal };

const MAX_CORRECTIONS = 500;

/** row id → the live proposal. Insertion-ordered; oldest dropped at the cap. */
const pending = new Map<string, SettlementCorrectionProposal>();
/** row id → what the trader decided. Kept after the proposal is applied, so a
 *  re-proposed correction does not silently become confirmable twice. */
const decided = new Map<string, SettlementCorrectionState>();

/** Validate a proposal BEFORE it reaches a card. Pure and exported: the executor
 *  refuses on this, and the contract check pins it, so a proposal that would
 *  render as "changed nothing" cannot be minted in the first place. */
export const checkSettlementCorrection = (input: unknown): SettlementCorrectionCheck => {
    const raw = (input ?? {}) as Partial<SettlementCorrectionProposal>;
    const tradeId = typeof raw.tradeId === 'string' ? raw.tradeId.trim() : '';
    if (!tradeId) return { ok: false, refused: 'a correction needs a trade row to correct' };
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) return { ok: false, refused: 'a correction needs a reason the trader can read' };
    const changesField = raw.outcome !== undefined
        || (typeof raw.pnlAmount === 'number' && Number.isFinite(raw.pnlAmount))
        || (typeof raw.pnlPercent === 'number' && Number.isFinite(raw.pnlPercent))
        || (typeof raw.correctedEntry === 'number' && Number.isFinite(raw.correctedEntry));
    if (!changesField) {
        return { ok: false, refused: 'a correction must change at least one field - outcome, pnlAmount, pnlPercent or correctedEntry' };
    }
    return { ok: true, proposal: { ...raw, tradeId, reason } as SettlementCorrectionProposal };
};

/** Record a proposal. Returns the stored proposal, or the refusal. A row the
 *  trader already CONFIRMED is not re-opened: the correction they accepted is
 *  the record, and a second card for it would invite a second write. */
export const proposeSettlementCorrection = (input: unknown): SettlementCorrectionCheck => {
    const checked = checkSettlementCorrection(input);
    if (!checked.ok) return checked;
    if (decided.get(checked.proposal.tradeId) === 'confirmed') {
        return { ok: false, refused: 'a correction needs a trade row to correct' };
    }
    pending.set(checked.proposal.tradeId, checked.proposal);
    while (pending.size > MAX_CORRECTIONS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

/** The live proposal for a row, or undefined. This is what the card renders. */
export const pendingSettlementCorrection = (tradeId: string): SettlementCorrectionProposal | undefined =>
    pending.get(tradeId);

/** What the trader decided, or undefined while the card is still open. */
export const settlementCorrectionStateOf = (tradeId: string): SettlementCorrectionState | undefined =>
    decided.get(tradeId);

/** The trader confirmed. Clears the proposal so the card resolves — the ROW is
 *  the record from here, and this map is only the card's memory. */
export const confirmSettlementCorrection = (tradeId: string): boolean => {
    if (!pending.has(tradeId)) return false;
    pending.delete(tradeId);
    decided.set(tradeId, 'confirmed');
    return true;
};

/** The trader declined. Same contract as confirm: it resolves the card, and the
 *  row is untouched. */
export const dismissSettlementCorrection = (tradeId: string): boolean => {
    if (!pending.has(tradeId)) return false;
    pending.delete(tradeId);
    decided.set(tradeId, 'dismissed');
    return true;
};

/** Hydration (F10): seed a mirrored pending correction back into the store, or
 *  record the decision evidence says already landed. Keyed by row id, like the
 *  confirm. */
export const seedSettlementCorrectionForHydration = (proposal: SettlementCorrectionProposal, decidedState?: SettlementCorrectionState): void => {
    if (decidedState) {
        decided.set(proposal.tradeId, decidedState!);
        return;
    }
    pending.set(proposal.tradeId, proposal);
};

/** Every open proposal, for a surface that renders a queue rather than a card. */
export const openSettlementCorrections = (): SettlementCorrectionProposal[] => [...pending.values()];

export const __clearSettlementCorrectionsForTests = (): void => {
    pending.clear();
    decided.clear();
};