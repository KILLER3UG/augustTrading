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

import type { JournalOutcomeSnapshot, JournalSettlement } from '../../types/tracking';

export interface JournalOutcomeBridge {
    read: (tradeId: string) => JournalOutcomeSnapshot | null;
    settle: (tradeId: string, settlement: JournalSettlement) => Promise<{ ok: boolean; error?: string }>;
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
