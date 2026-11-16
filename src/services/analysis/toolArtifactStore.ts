/**
 * toolArtifactStore — keep the WHOLE tool payload so a clip is a pause, not a
 * loss.
 *
 * THE PROBLEM. A desk-tool result is capped before it reaches a model
 * (`budgetToolContent`: 12,000 chars by default, less per TOOL_BUDGETS). The cap is
 * necessary — tool output rides every subsequent prompt, so one 200 KB order
 * book compounds across a whole debate — but it means a seat asking about the
 * 92nd level of a book is told, correctly, that it was dropped. Before this the
 * dropped bytes were DESTROYED at that moment: even the 30-second result cache
 * held the clipped copy. So "MISSING, not absent" was honest and useless: the
 * seat could know the rest existed and still never get it.
 *
 * THIS FIXES IT BY. Keeping the pre-cap payload addressable and putting an
 * address in the truncation notice, with a `read_tool_output` tool that serves
 * any slice of it. The model's second move on a clipped result is to fetch the
 * rest instead of reasoning around the gap.
 *
 * WHY IN MEMORY AND NOT ON DISK, despite the reference harness writing spill
 * files: a CLI session runs for hours across many processes, so its artifacts
 * have to outlive the run. An August debate is minutes long, its tool payloads
 * are market snapshots that are WRONG an hour later, and the app's persistent
 * layer is one rewritten JSON blob this app already has a byte budget for.
 * Writing per-call megabytes of stale order books into it would be a regression
 * dressed as a feature. So the store is bounded and aged — and each turn's
 * artifacts are dropped by the turn that owns them (`clearToolArtifacts(owner)`
 * in the streaming wrapper's tail). It is deliberately NOT cleared beside the
 * result cache: that clear runs at the START of a turn, and a concurrent
 * dock/Chat turn would lose the payloads its model is still paging through.
 * (This comment used to say "cleared at every debate start"; the debate engine is
 * deleted, and a comment naming a caller that no longer exists is how a future
 * edit "restores" the bug.)
 *
 * The one rule that must not be bent: `budgetToolContent` promises the returned
 * string fits its cap, and callers size `tailReserve` so their live-price
 * stamps land INSIDE that budget. A receipt appended after the fact would
 * breach exactly that promise — which is a bug this repo has already been bitten
 * by once. The locator is therefore REPORTED BEFORE the cap is applied, via
 * `receiptCostFor`, and carved out of it.
 */

import { clipReceipt, dataUnavailable } from '../../utils/harnessMarks';

/** How many payloads stay addressable. Sized to a debate's worst case: 4 seats
 *  × 3 tool rounds × ~3 calls, keeping only the clipped ones. */
const MAX_ARTIFACTS = 40;
/** A single payload's ceiling. Beyond this, keeping it costs more than losing
 *  it: the store's job is the tail of a clipped result, not archiving the tape. */
const MAX_ARTIFACT_CHARS = 400_000;
/** Addressable for as long as a run could reasonably still be answering from
 *  it. Past this, an id is treated as expired rather than served stale. */
const ARTIFACT_TTL_MS = 30 * 60 * 1000;

export interface ToolArtifact {
    id: string;
    tool: string;
    /** The turn that produced it. Reads and clears are scoped to this token so
     *  two concurrent turns (dock + Chat) cannot delete or page each other's
     *  payloads. */
    owner: string;
    /** The FULL pre-budget payload, exactly as the desk produced it. */
    full: string;
    totalChars: number;
    /** Chars of `full` the model was actually shown, for the receipt's math. */
    keptChars: number;
    savedAt: number;
    reads: number;
}

const artifacts = new Map<string, ToolArtifact>();
let sequence = 0;

const idFor = (n: number): string => `ta-${n.toString(36).padStart(4, '0')}`;

/**
 * Width of the locator that gets appended to a truncation notice, measured FROM
 * the owner of that notice so the reservation can never drift from what is
 * actually appended — `utils/harnessMarks.clipReceipt` is the only place that
 * text is written. Computed against a sample id because ids are fixed-width
 * while {@link MAX_ARTIFACTS} stays under 36^4, so this is a real constant and
 * not an estimate. The `+ 1` is the newline the desk prepends.
 */
export const RECEIPT_CHARS = clipReceipt('ta-0000').length + 1;

/** Put a clipped payload under an id. Returns the id, or null when the payload
 *  is not worth keeping (too large, or the read tool's own output — see
 *  {@link isReadBackTool}). */
export const storeToolArtifact = (
    name: string,
    full: string,
    keptChars: number,
    now = Date.now(),
    owner = '',
): string | null => {
    if (isReadBackTool(name)) return null;
    if (!full || full.length > MAX_ARTIFACT_CHARS) return null;
    sweepExpired(now);
    while (artifacts.size >= MAX_ARTIFACTS) {
        // Oldest first: the store is a window over the current run, and the
        // payload a seat asked about ten calls ago is the one least likely to
        // be paged through next.
        const oldest = [...artifacts.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0];
        if (!oldest) break;
        artifacts.delete(oldest[0]);
    }
    sequence += 1;
    const id = idFor(sequence);
    artifacts.set(id, {
        id, tool: name, owner, full, totalChars: full.length, keptChars, savedAt: now, reads: 0,
    });
    return id;
};

/** The read tool must never spill itself: a seat paging through an artifact
 *  that got clipped would receive a receipt pointing at… itself, and loop. */
export const isReadBackTool = (name: string): boolean => name === 'read_tool_output';

const sweepExpired = (now: number): void => {
    for (const [id, a] of artifacts) {
        if (now - a.savedAt > ARTIFACT_TTL_MS) artifacts.delete(id);
    }
};

export interface ArtifactPage {
    ok: true;
    content: string;
    /** Char offset just past what was returned, or null at the end. */
    nextOffset: number | null;
    artifact: ToolArtifact;
}

export interface ArtifactMiss {
    ok: false;
    content: string;
}

/**
 * Serve one page of a stored payload.
 *
 * The miss text is written so a stale id cannot read as a tool failure worth
 * retrying: the seat has already moved on if the window closed, and re-asking
 * for the artifact is how a turn burns its remaining rounds.
 */
export const readToolArtifact = (
    id: string,
    offset = 0,
    limit = 2000,
    now = Date.now(),
    owner?: string,
): ArtifactPage | ArtifactMiss => {
    sweepExpired(now);
    const artifact = artifacts.get((id || '').trim());
    // An id from an earlier turn is not this turn's context, even while the
    // bytes are still inside the bounded window. `owner` is omitted by tests
    // and by callers that predate the token.
    if (!artifact || (owner !== undefined && artifact.owner !== owner)) {
        return {
            ok: false,
            content: dataUnavailable(
                'read_tool_output',
                `no stored tool result with id "${id}" in this run`,
                'It belongs to an earlier or expired run — it was never in this context. Do not retry this id; answer from the results you have',
            ),
        };
    }
    artifact.reads += 1;
    const from = Math.max(0, Math.floor(offset) || 0);
    const width = Math.min(Math.max(1, Math.floor(limit) || 2000), 8000);
    if (from >= artifact.full.length) {
        return {
            ok: true,
            content: `[end of "${artifact.id}" — ${artifact.totalChars} chars total, nothing past offset ${from}]`,
            nextOffset: null,
            artifact,
        };
    }
    const slice = artifact.full.slice(from, from + width);
    const end = from + slice.length;
    return {
        ok: true,
        content: slice,
        nextOffset: end < artifact.full.length ? end : null,
        artifact,
    };
};

/** How much of a payload is currently addressable, for diagnostics/tests. */
export const artifactCount = (): number => artifacts.size;

/** Drop one turn's artifacts, or everything when no owner is named (tests and
 *  the diagnostics surface). A caller must pass its own token: clearing all at
 *  every turn start deleted a concurrent turn's live payloads. */
export const clearToolArtifacts = (owner?: string): void => {
    if (owner === undefined) {
        artifacts.clear();
        return;
    }
    for (const [id, a] of artifacts) {
        if (a.owner === owner) artifacts.delete(id);
    }
};
