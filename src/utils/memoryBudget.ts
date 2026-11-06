/**
 * Notebook byte budget — soft / trigger / hard, with the cleanup request
 * deliberately set BETWEEN soft and hard.
 *
 * Why this exists: the whole Trader Notebook is ONE rewritten JSON blob under
 * a single Preferences key (`memory_files_v1_<user>`). Every memory write
 * re-stringifies and replaces it, and the platform can simply refuse: on the
 * web it is the per-origin quota, on desktop the file layer. Until now the only
 * defence was a console warning at 1,000,000 characters, which no screen shows
 * and no code acts on — so the failure mode was a `setPreferenceObject` that
 * throws inside a `catch`, silently stopping persistence while the app carries
 * on believing memory is being written.
 *
 * The unit is UTF-16 code units × 2, not UTF-8. `string.length` already counts
 * UTF-16 code units, so the cost is O(1) per string with no encoder
 * allocation on a hot path that runs on every write — and it is the unit the
 * web origin actually meters its quota in. For a file-backed Preferences layer
 * it overstates ASCII by 2x, which is the safe direction: a budget that reads
 * high asks for help early rather than after the write has failed.
 *
 * Why the tiers act the way they do: this store has NOTHING safe to delete.
 * Every byte in it is either user-written or derived from a source that is
 * only rebuilt when its own trigger fires, so blanking it would leave a hole
 * in the prompt until that event. So the response to pressure is to
 * REFUSE GROWTH from the unbounded writers and tell a human precisely where the
 * bytes are, never to evict silently. That is the same intent a between-caps
 * trigger serves — act before the hard cap — adapted to a system
 * where destruction is off the table.
 */

/** The size the previous guard called "huge", kept as the hard ceiling so this
 *  module does not silently move a threshold the app has been living with:
 *  1,000,000 characters = 2 MB of UTF-16. Above this the notebook writer is
 *  refused outright, so the blob cannot be pushed past what the platform will
 *  take. Nothing stored is ever evicted to make room — see below. */
export const NOTEBOOK_HARD_LIMIT_BYTES = 2 * 1024 * 1024;

/** Above this the harness stops creating NEW notebook files — appends to files
 *  that already exist still land, so the learning loop keeps writing. The point
 *  of sitting below the hard cap is to reach this state while there is still
 *  room to write the refusal down. */
export const NOTEBOOK_CLEANUP_TRIGGER_BYTES = Math.round(1.5 * 1024 * 1024);

/** Above this the notebook is only reported on: nothing changes. It exists so
 *  the Health tab can say "growing" before anything is prevented. */
export const NOTEBOOK_SOFT_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * Minimum gap between two cleanup REQUESTS. Without it a burst of writes — a
 * post-mortem that appends to five files re-persists the blob five times —
 * would re-flag pressure on every one, and the flag is what refuses new files.
 * Six hours coalesces a session's writers while staying far shorter than the
 * weekly hygiene cadence, so a request is never starved past the pass that
 * reads it.
 */
export const CLEANUP_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Below the soft cap nothing is said; above the hard cap writes are refused. */
export type NotebookPressure = 'ok' | 'soft' | 'trigger' | 'hard';

/** UTF-16 code units × 2. O(1) per string, no allocation, and it counts a
 *  surrogate pair as the 4 bytes it occupies rather than 2. */
export const bytesOf = (text: string | null | undefined): number =>
    text ? text.length * 2 : 0;

/** The one classifier. Exact boundaries are inclusive at the tier they open, so
 *  a notebook AT the trigger is already at the trigger. Only an UNREADABLE
 *  measurement (`NaN`) reads as no pressure — a size that overflowed to
 *  `Infinity` is the opposite of unreadable, and must not be waved through. */
export const pressureForBytes = (bytes: number): NotebookPressure => {
    if (Number.isNaN(bytes)) return 'ok';
    if (bytes >= NOTEBOOK_HARD_LIMIT_BYTES) return 'hard';
    if (bytes >= NOTEBOOK_CLEANUP_TRIGGER_BYTES) return 'trigger';
    if (bytes >= NOTEBOOK_SOFT_LIMIT_BYTES) return 'soft';
    return 'ok';
};

/** True when a cleanup has not been asked for recently. An unreadable stamp
 *  (never requested, or garbage) reads as "due". */
export const cleanupIsDue = (
    lastRequestedAt: number | null | undefined,
    now: number,
): boolean => {
    if (typeof lastRequestedAt !== 'number' || !Number.isFinite(lastRequestedAt)) return true;
    return now - lastRequestedAt >= CLEANUP_DEDUP_WINDOW_MS;
};

export interface FolderShare {
    name: string;
    files: number;
    bytes: number;
    /** Share of the whole store, 0–1, so a caller can sort without re-dividing. */
    fraction: number;
}

export interface NotebookSize {
    bytes: number;
    pressure: NotebookPressure;
    /** Per-folder attribution, biggest first. */
    byFolder: FolderShare[];
    /** The biggest individual files, capped by `maxFiles`. */
    largest: Array<{ path: string; bytes: number }>;
    files: number;
}

/**
 * Attribute the blob's bytes to the folders that hold them. Content is counted
 * where it actually lives; the fixed per-row overhead (ids, timestamps, the
 * `enabled`/`autoManaged` flags) is folded into the folder too, because a
 * notebook of ten thousand one-line notes is a real shape and counting only
 * bodies would call it empty.
 */
export const measureNotebook = <F extends {
    folderId: string; name: string; content: string;
}>(
    files: readonly F[],
    folders: readonly { id: string; name: string }[],
    opts: { maxFiles?: number; overheadBytes?: number } = {},
): NotebookSize => {
    const maxFiles = opts.maxFiles ?? 5;
    const overheadBytes = opts.overheadBytes ?? 120;
    const names = new Map(folders.map(f => [f.id, f.name]));
    const totals = new Map<string, { files: number; bytes: number }>();
    const individual: Array<{ path: string; bytes: number }> = [];
    let bytes = 0;

    for (const file of files) {
        const folder = names.get(file.folderId) ?? file.folderId;
        const size = bytesOf(file.content) + overheadBytes;
        bytes += size;
        const row = totals.get(folder) ?? { files: 0, bytes: 0 };
        row.files += 1;
        row.bytes += size;
        totals.set(folder, row);
        individual.push({ path: `${folder}/${file.name}`, bytes: size });
    }

    const byFolder: FolderShare[] = [...totals.entries()]
        .map(([name, row]) => ({
            name,
            files: row.files,
            bytes: row.bytes,
            fraction: bytes > 0 ? row.bytes / bytes : 0,
        }))
        .sort((a, b) => b.bytes - a.bytes);

    return {
        bytes,
        pressure: pressureForBytes(bytes),
        byFolder,
        largest: individual.sort((a, b) => b.bytes - a.bytes).slice(0, maxFiles),
        files: files.length,
    };
};

/** One plain-English line for the health log / Health tab. Deliberately names
 *  the folders, because "the notebook is 1.6 MB" is not actionable and "the
 *  diary is 70% of it" is. */
export const describePressure = (size: NotebookSize): string => {
    const mb = (size.bytes / (1024 * 1024)).toFixed(2);
    if (size.pressure === 'ok') {
        return `Notebook: ${mb} MB across ${size.files} file${size.files === 1 ? '' : 's'} — inside every budget.`;
    }
    const top = size.byFolder[0];
    const where = top
        ? `, ${top.name}/ holds ${(top.fraction * 100).toFixed(0)}% of it`
        : '';
    const action = size.pressure === 'soft'
        ? 'watching it'
        : size.pressure === 'trigger'
            // Says what is actually true, twice over. The old wording claimed
            // ALL notebook file creation had stopped; only model-note creation
            // ever did. Skill creation stops at this tier too — but a hygiene
            // pass merges duplicates into the ARCHIVE, which still counts
            // toward these bytes, so it shrinks the active library and NOT the
            // stored size. Only deleting a note reclaims space, and saying
            // otherwise would promise a remedy that does not exist.
            ? 'the harness has stopped adding new skills and model notes — existing skills still update and still count new outcomes; a hygiene pass merges duplicates into the archive, but only deleting a note in Settings frees stored space'
            : 'the notebook writer is refused outright — nothing stored was deleted, but nothing new will be written';
    return `Notebook at ${mb} MB (${size.pressure})${where} — ${action}.`;
};
