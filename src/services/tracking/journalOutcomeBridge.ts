/**
 * journalOutcomeBridge — the tracker's one way to read and settle a journal
 * row without importing React.
 *
 * The journal's settlement funnel (`useTradeLogging.logTradeWithFeedback`)
 * owns the row update and every downstream side effect. The tracker runs
 * outside React, so the hook registers a bridge here for its lifetime:
 *
 *  · read  — what the journal currently says about a trade id (sync, ref-backed);
 *  · settle — hand the tracker's exit to the existing funnel, which merges it
 *             over the PENDING row and runs the notebook/calibration/insight
 *             legs exactly once.
 *
 * A missing bridge is NOT a settlement. The tracker keeps the closed position
 * and retries; the diagnosis queue waits for `journalSettledAt`.
 */

import type { LoggedTrade } from '../../types/trade';
import type {
    JournalOutcomeSnapshot,
    JournalSettlement,
    TrackedDiagnosis,
} from '../../types/tracking';

export interface JournalOutcomeBridge {
    read: (tradeId: string) => JournalOutcomeSnapshot | null;
    /** The full row, for the diagnosis packet (benchmark, regime, gate,
     *  plan adherence, the model's own stated size). */
    readTrade: (tradeId: string) => LoggedTrade | null;
    settle: (tradeId: string, settlement: JournalSettlement) => Promise<{ ok: boolean; error?: string }>;
    /** Write the diagnosis's post-mortem onto the row and run the notebook
     *  sync. A trader-authored note is preserved (`preserved: true`). */
    applyDiagnosis: (
        tradeId: string,
        diagnosis: TrackedDiagnosis,
        postMortem: string,
    ) => Promise<{ ok: boolean; error?: string; preserved?: boolean }>;
    /** Record the closed trade in the notebook WITHOUT a lesson (a refusal, or
     *  a diagnosis the row could not carry). */
    recordSettlement: (tradeId: string) => Promise<{ ok: boolean; error?: string }>;
}

let bridge: JournalOutcomeBridge | null = null;

export const registerJournalOutcomeBridge = (next: JournalOutcomeBridge): (() => void) => {
    bridge = next;
    return () => {
        if (bridge === next) bridge = null;
    };
};

export const readJournalOutcome = (tradeId: string): JournalOutcomeSnapshot | null =>
    bridge ? bridge.read(tradeId) : null;

/** Distinguishes "no bridge yet" from "the bridge says the row is gone". A
 *  missing row may be cancelled as orphaned; a missing bridge must retry. */
export const hasJournalOutcomeBridge = (): boolean => bridge !== null;

export const settleJournalTrade = async (
    tradeId: string,
    settlement: JournalSettlement,
): Promise<{ ok: boolean; error?: string }> => {
    if (!bridge) return { ok: false, error: 'the journal outcome bridge is not mounted' };
    return bridge.settle(tradeId, settlement);
};

export const readJournalTrade = (tradeId: string): LoggedTrade | null =>
    bridge ? bridge.readTrade(tradeId) : null;

export const applyJournalDiagnosis = async (
    tradeId: string,
    diagnosis: TrackedDiagnosis,
    postMortem: string,
): Promise<{ ok: boolean; error?: string; preserved?: boolean }> => {
    if (!bridge) return { ok: false, error: 'the journal outcome bridge is not mounted' };
    return bridge.applyDiagnosis(tradeId, diagnosis, postMortem);
};

export const recordJournalSettlement = async (
    tradeId: string,
): Promise<{ ok: boolean; error?: string }> => {
    if (!bridge) return { ok: false, error: 'the journal outcome bridge is not mounted' };
    return bridge.recordSettlement(tradeId);
};
