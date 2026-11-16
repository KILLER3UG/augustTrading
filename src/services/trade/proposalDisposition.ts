/**
 * proposalDisposition — the ONE memory of what the trader already did with a
 * presented plan.
 *
 * A plan's card is per-row: clicking "Log this trade" must not write a second
 * journal row on a re-click, and dismissing it must not bring it back on the
 * next render. That state lived in `ChatTranscriptList` at module scope so it
 * survived a dock unmount/remount — which is also exactly why the Agents surface
 * could not share it: the store was welded to the dock's file. Stage 20b puts
 * the card in both homes, so the map lives here and both surfaces read it.
 *
 * Keyed by the ROW id, which `entriesForSession` guarantees is the same id in
 * both homes (`liveEntryFromMessage` projects by `m.id`), so logging a plan on
 * the chart marks it logged in Chat and vice versa — one decision, one record.
 */

export type ProposalState = 'logged' | 'dismissed';

/** Bounded: a long-lived session must not accumulate dispositions forever. */
const MAX_DISPOSITIONS = 500;

const disposition = new Map<string, ProposalState>();

export const proposalStateOf = (rowId: string): ProposalState | undefined => disposition.get(rowId);

export const rememberProposalState = (rowId: string, state: ProposalState): void => {
    if (disposition.size >= MAX_DISPOSITIONS) {
        const oldest = disposition.keys().next();
        if (!oldest.done) disposition.delete(oldest.value);
    }
    disposition.set(rowId, state);
};

/** Forget one disposition — the UNDO path. Reversing an approval must put the
 *  card back to undecided: the row was deleted and the receipt message
 *  removed, so a stale 'logged' here would hide a card the trader can act on
 *  again (re-approve or reject). */
export const forgetProposalState = (rowId: string): void => { disposition.delete(rowId); };

/** Test hook: forget every recorded proposal disposition. */
export const __clearProposalStateForTests = (): void => { disposition.clear(); };
