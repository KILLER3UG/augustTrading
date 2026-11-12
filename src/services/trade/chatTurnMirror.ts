/**
 * chatTurnMirror — the Chart AI dock's live turn, mirrored into the App
 * conversation, so BOTH homes show the same answer arriving.
 *
 * WHY THIS EXISTS. The two homes had one merge and one writer each: the dock
 * streamed into its session's `entries`, and the Agents surface streamed into
 * `Message.isStreaming` + `text`. `commitSoloChatTurn` only ever wrote the
 * conversation at SETTLE, so a turn started in Chart AI was invisible to the
 * Agents surface until it finished — switch across mid-generation and the thread
 * showed the question and nothing else, with no sign the desk was working. The
 * reverse direction already worked (`liveEntryFromMessage` projects the
 * conversation's rows into the dock), which made the asymmetry look like a
 * broken switch rather than a missing writer.
 *
 * WHY A MIRROR AND NOT ONE STORE. The dock's entry is the richer row while the
 * turn runs — it carries the tool trail, the payload ids and the reasoning as
 * they land — and the conversation is the record everything else reads (the
 * Journal, the gallery, the learning loop). Replacing either writer was already
 * ruled out in `entriesForSession`'s note. So the dock keeps streaming into its
 * own entry and this module copies that entry into the conversation under the
 * SAME id, which is what makes one turn one row in both homes.
 *
 * THREE things this must not get wrong:
 *  - **It never uses requestAnimationFrame.** The generating surface is the one
 *    that is HIDDEN while the trader reads the other, and a rAF-driven writer
 *    fires zero times in a hidden tab — the exact defect `FadingText` records.
 *    A timer keeps the conversation current whether or not the dock is on screen.
 *  - **It always flushes.** A turn that fails or is stopped mid-stream leaves an
 *    `isStreaming: true` row in the conversation with nothing after it if the
 *    last patch is dropped, so `stop()` commits synchronously.
 *  - **It commits by id, and only for its own entry.** A retry drops the stale
 *    answer and re-runs under a new entry id; the old mirror stops, and the
 *    conversation's row for it is the settle commit's business, not this one's.
 */

import * as chatStore from './chatStore';
import type { LiveEntry } from './chatStore';
import type { ReasoningEffort } from '../../types/provider';

/** One row of a solo (desk) turn, as it travels to the conversation.
 *
 *  The id is the contract: `entriesForSession` merges by id, so a commit that
 *  reuses the dock's entry id is ONE row seen from two homes. */
export interface SoloTurnRow {
    id: string;
    role: 'user' | 'ai';
    text: string;
    /** The turn is still arriving — the Agents surface draws the running row from
     *  this, and clears it only when the mirror's final flush says false. */
    streaming?: boolean;
    /** The chain-of-thought as it streams, so the Thinking row is live too. */
    reasoning?: string;
    /** The tool trail, one line per entry, in call order. */
    tools?: string[];
    /** One payload id per line of `tools`, so a row opens onto real output. */
    toolIds?: string[];
    /** The turn failed, and this is the real reason — a row of its own. */
    error?: string;
    workedMs?: number;
    effort?: ReasoningEffort;
    /** The provider whose key the trace rides under, so the mirrored trace
     *  lands in the same `thoughtProcesses` slot the Agents surface's own writer
     *  uses instead of opening a second paragraph for one turn. */
    speakerKey?: string;
    /** The dock entry's own stamp — the TURN's send time. The mirrored row's
     *  `createdAt` reads this, not the commit moment: the mirror only starts
     *  after the context fetch (0.6–2.5s after send), and a clock started at
     *  its own commit counted the turn ~2s young the moment the fetch was
     *  slow. One turn, one start, in both homes. */
    at?: number;
}

export type SoloTurnCommit = (row: SoloTurnRow, conversationId: string) => void;

/** How often the mirror may write. The pipeline's own live writer is
 *  frame-throttled; a timer at this interval is the same order of magnitude
 *  (≈5 writes/s) and survives a hidden surface. */
const MIRROR_INTERVAL_MS = 200;

export interface EntryMirror {
    /** Commit whatever the entry holds NOW and unsubscribe. Idempotent. */
    stop(): void;
}

/**
 * Mirror one dock entry into one conversation, throttled.
 *
 * The mirror subscribes to the store rather than being called from the turn's
 * write sites on purpose: `patch` runs inside `chatStore.mutate`'s updater, and
 * a second store write (or a React state write) from inside another store's
 * reducer is how re-entrancy bugs are born. A subscriber sees the settled
 * snapshot instead.
 */
export const startEntryMirror = (opts: {
    sid: string;
    entryId: string;
    conversationId: string;
    speakerKey?: string;
    commit: SoloTurnCommit;
}): EntryMirror => {
    const { sid, entryId, conversationId, commit } = opts;
    let stopped = false;
    let timer = 0;
    // The store emits for EVERY session, and a second dock turn streaming in
    // another session would otherwise re-commit this entry unchanged ~5x/s —
    // each one a React state write on the Agents surface. The row's own shape is
    // the signature: nothing changed, nothing is sent.
    let last = '';
    const readEntry = (): LiveEntry | undefined => {
        const session = chatStore.getSnapshot().sessions.find(s => s.id === sid);
        return session?.entries.find(e => e.id === entryId);
    };

    const write = (e: LiveEntry | undefined): void => {
        if (!e) return;
        const row: SoloTurnRow = {
            id: e.id,
            role: 'ai',
            text: e.text ?? '',
            streaming: !!e.streaming,
            ...(typeof e.at === 'number' ? { at: e.at } : {}),
            ...(e.reasoning ? { reasoning: e.reasoning } : {}),
            ...(e.tools?.length ? { tools: e.tools } : {}),
            ...(e.toolIds?.length ? { toolIds: e.toolIds } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(typeof e.workedMs === 'number' ? { workedMs: e.workedMs } : {}),
            ...(e.effort ? { effort: e.effort } : {}),
            ...(opts.speakerKey ? { speakerKey: opts.speakerKey } : {}),
        };
        const signature = JSON.stringify(row);
        if (signature === last) return;
        last = signature;
        commit(row, conversationId);
    };

    const schedule = (): void => {
        if (stopped || timer) return;
        // `window.setTimeout`, not the bare global: this module is renderer
        // code and the bare one hands back a Node `Timeout` under some
        // environments, which is not a number to clear.
        timer = window.setTimeout(() => {
            timer = 0;
            write(readEntry());
        }, MIRROR_INTERVAL_MS);
    };

    // The placeholder exists before the first token: commit it now, so the
    // Agents surface shows a generating row the moment the dock does rather than
    // after one throttle window of apparent silence.
    write(readEntry());
    const unsubscribe = chatStore.subscribe(schedule);

    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            unsubscribe();
            if (timer) {
                window.clearTimeout(timer);
                timer = 0;
            }
            // The final state — settled text, `streaming: false`, or the error
            // a failed turn carries — must reach the conversation even though
            // no further store emit will ever schedule it.
            write(readEntry());
        },
    };
};
