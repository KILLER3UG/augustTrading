/**
 * curatedMemory — the two BOUNDED, model-curated memory stores:
 *
 *   USER.md    — durable trader DNA (risk limits, preferred pairs/sessions,
 *                style/verbosity preferences, hard personal rules).  CAP 1,500.
 *   MEMORY.md  — durable workflow corrections, post-mortem lessons, tool
 *                quirks, active market reminders.                    CAP 2,500.
 *
 * WHY A SECOND STORE NEXT TO profileMemory. profileMemory is the open
 * collaboration-facts ledger (unbounded rows, indexed per prompt). These two
 * are the Hermes-style FROZEN-SNAPSHOT files: a fixed, tightly capped summary
 * captured ONCE per session into the system prompt so the KV cache never sees
 * a mid-session rewrite, while mid-session writes persist to disk immediately
 * and answer with a receipt. The agent curates them with add/patch/remove;
 * there is NO silent truncation — an add or patch that would overflow the cap
 * is REFUSED with `capacity_exceeded` so the agent patches or removes stale
 * entries first.
 *
 * FRESHNESS DOCTRINE: everything in these files is a HINT about the trader
 * and past workflow — never live market truth. The prompt block carries the
 * rule; the desk tools carry the numbers.
 */

import { getPreference, setPreference } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';

export const USER_MD_MAX_CHARS = 1_500;
export const MEMORY_MD_MAX_CHARS = 2_500;

export type CuratedMemoryTarget = 'user' | 'memory';

export const CURATED_MEMORY_TARGETS: readonly CuratedMemoryTarget[] = ['user', 'memory'];

export const maxCharsForTarget = (target: CuratedMemoryTarget): number =>
    target === 'user' ? USER_MD_MAX_CHARS : MEMORY_MD_MAX_CHARS;

export const targetLabel = (target: CuratedMemoryTarget): string =>
    target === 'user' ? 'USER.md' : 'MEMORY.md';

/** One operation in a `memory` tool call. `add` appends a dated entry;
 *  `patch` replaces `old_text` (which must occur exactly once) with `content`;
 *  `remove` deletes `old_text` (exactly once). */
export interface CuratedMemoryOp {
    action: 'add' | 'patch' | 'remove';
    /** patch/remove: the exact existing text to find. */
    old_text?: string;
    /** add: the entry body. patch: the replacement text. */
    content?: string;
}

export type CuratedMemoryFailure =
    | 'capacity_exceeded'
    | 'unknown_target'
    | 'invalid_op'
    | 'missing_old_text'
    | 'ambiguous_old_text'
    | 'empty_content';

/** The structured receipt every mutation returns. `undoSnapshot` is the exact
 *  prior bytes of the target file — pass it back to `undoMemorySnapshot` to
 *  restore them. */
export interface CuratedMemoryReceipt {
    ok: boolean;
    target: CuratedMemoryTarget;
    /** How many operations were applied (0 on a refusal). */
    applied: number;
    usageChars: number;
    maxChars: number;
    undoSnapshot: string;
    error?: CuratedMemoryFailure;
    /** capacity_exceeded only: the numbers behind the refusal. */
    currentChars?: number;
    attemptedChars?: number;
    message?: string;
}

interface CuratedMemoryBlob {
    version: 1;
    /** USER.md bytes. */
    user: string;
    /** MEMORY.md bytes. */
    memory: string;
    updatedAt?: string;
}

const STORE_KEY_PREFIX = 'curated_memory_v1_';

const storeKey = (username: string): string => `${STORE_KEY_PREFIX}${username}`;

const emptyBlob = (): CuratedMemoryBlob => ({ version: 1, user: '', memory: '' });

/** ALL curated writes go through one serialized chain: the Dream's
 *  whole-file consolidation and a mid-session `memory` tool call must not
 *  read the same blob and clobber each other. Reads stay lock-free (a snapshot
 *  is explicitly point-in-time); only the read-modify-write section is locked. */
let writeChain: Promise<unknown> = Promise.resolve();

export const withCuratedMemoryWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
};

/** Read the raw store. A missing or corrupt blob is an EMPTY store — the
 *  curated files are derived state the agent rebuilds; there is nothing in
 *  them worth a recovery ritual (the notebook keeps the durable copies). */
const readBlob = async (username: string): Promise<CuratedMemoryBlob> => {
    try {
        const raw = await getPreference(storeKey(username));
        if (!raw) return emptyBlob();
        const parsed = JSON.parse(raw) as Partial<CuratedMemoryBlob> | null;
        if (!parsed || typeof parsed !== 'object') return emptyBlob();
        return {
            version: 1,
            user: typeof parsed.user === 'string' ? parsed.user : '',
            memory: typeof parsed.memory === 'string' ? parsed.memory : '',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        };
    } catch {
        return emptyBlob();
    }
};

const writeBlob = async (username: string, blob: CuratedMemoryBlob): Promise<void> => {
    await setPreference(storeKey(username), JSON.stringify({ ...blob, updatedAt: new Date().toISOString() }));
};

/** The current bytes of one target. */
export const getCuratedMemoryText = async (
    target: CuratedMemoryTarget,
    username = getActiveUsername() || 'default',
): Promise<string> => {
    const blob = await readBlob(username);
    return target === 'user' ? blob.user : blob.memory;
};

/**
 * The ISO day (YYYY-MM-DD) an added entry is stamped with. Injectable clock
 * for tests; UTC — a memory stamp is a date, not a local-time fact.
 */
export const isoDayStamp = (nowMs: number = Date.now()): string =>
    new Date(nowMs).toISOString().slice(0, 10);

/** How an `add` lands: a clean `## [YYYY-MM-DD]` delimiter + the content.
 *  Kept in one place so the Dream consolidator and the tests parse the same
 *  shape the writer produces. */
export const formatCuratedEntry = (content: string, nowMs: number = Date.now()): string =>
    `## [${isoDayStamp(nowMs)}]\n${content.trim()}`;

/** Collapse the blank-line rubble a remove/patch can leave behind. */
const tidy = (text: string): string =>
    text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');

export interface ApplyCuratedMemoryOptions {
    username?: string;
    /** Injectable clock (epoch ms) for the `add` date stamp. */
    nowMs?: number;
}

/**
 * Apply a batch of operations to one target ATOMICALLY: every op is validated
 * and the whole batch is applied to an in-memory candidate, so a refusal
 * (unknown target, ambiguous old_text, CAP OVERFLOW) leaves the stored bytes
 * untouched. The receipt carries the pre-write bytes as `undoSnapshot`.
 *
 * THE CAP IS HARD. `attemptedChars` is the candidate size AFTER the batch —
 * the agent must patch or remove before adding again. This is deliberately
 * not a truncate: a memory that silently drops its oldest lines is a memory
 * that lies about what it kept.
 */
const applyCuratedMemoryOpsUnlocked = async (
    target: CuratedMemoryTarget,
    operations: CuratedMemoryOp[],
    options: ApplyCuratedMemoryOptions = {},
): Promise<CuratedMemoryReceipt> => {
    const username = options.username || getActiveUsername() || 'default';
    const maxChars = maxCharsForTarget(target);
    const base = await readBlob(username);
    const current = target === 'user' ? base.user : base.memory;
    const undoSnapshot = current;

    const fail = (
        error: CuratedMemoryFailure,
        message: string,
        extra: Partial<CuratedMemoryReceipt> = {},
    ): CuratedMemoryReceipt => ({
        ok: false,
        target,
        applied: 0,
        usageChars: current.length,
        maxChars,
        undoSnapshot,
        error,
        message,
        ...extra,
    });

    if (target !== 'user' && target !== 'memory') {
        return fail('unknown_target', `Unknown memory target — use "user" (USER.md) or "memory" (MEMORY.md).`);
    }
    if (!Array.isArray(operations) || operations.length === 0) {
        return fail('invalid_op', 'operations must be a non-empty array of { action, old_text?, content? }.');
    }
    if (operations.length > 8) {
        return fail('invalid_op', 'At most 8 operations per call — apply the rest in a follow-up call.');
    }

    let candidate = current;
    let applied = 0;
    for (const [index, op] of operations.entries()) {
        const action = op?.action;
        if (action !== 'add' && action !== 'patch' && action !== 'remove') {
            return fail('invalid_op', `operations[${index}].action must be add | patch | remove.`);
        }
        if (action === 'add') {
            const content = (op.content ?? '').trim();
            if (!content) return fail('empty_content', `operations[${index}].content is empty — an added entry needs text.`);
            const entry = formatCuratedEntry(content, options.nowMs ?? Date.now());
            candidate = tidy(candidate ? `${candidate}\n\n${entry}` : entry);
            applied += 1;
            continue;
        }
        // patch / remove both key off an exact, unique `old_text`.
        const oldText = op.old_text ?? '';
        if (!oldText.trim()) {
            return fail('missing_old_text', `operations[${index}] (${action}) needs old_text — the exact text to ${action === 'patch' ? 'replace' : 'remove'}.`);
        }
        const first = candidate.indexOf(oldText);
        if (first < 0) {
            return fail('missing_old_text', `operations[${index}]: old_text was not found in ${targetLabel(target)}. Copy it exactly from the snapshot.`);
        }
        const second = candidate.indexOf(oldText, first + 1);
        if (second >= 0) {
            return fail('ambiguous_old_text', `operations[${index}]: old_text occurs more than once in ${targetLabel(target)} — include more surrounding text so the edit is unambiguous.`);
        }
        if (action === 'remove') {
            candidate = tidy(candidate.replace(oldText, ''));
        } else {
            const content = op.content ?? '';
            if (!content.trim()) {
                return fail('empty_content', `operations[${index}].content is empty — a patch needs replacement text (use action "remove" to delete).`);
            }
            candidate = tidy(candidate.replace(oldText, content));
        }
        applied += 1;
    }

    if (candidate.length > maxChars) {
        return fail(
            'capacity_exceeded',
            `${targetLabel(target)} would reach ${candidate.length} / ${maxChars} chars. `
            + 'Refused — patch or remove stale entries first; nothing was written.',
            {
                currentChars: current.length,
                attemptedChars: candidate.length,
                usageChars: current.length,
            },
        );
    }

    if (candidate !== current) {
        const next = target === 'user' ? { ...base, user: candidate } : { ...base, memory: candidate };
        await writeBlob(username, next);
    }
    return {
        ok: true,
        target,
        applied,
        usageChars: candidate.length,
        maxChars,
        undoSnapshot,
        message: candidate === current
            ? 'No change (the operations were no-ops on the current bytes).'
            : `Saved. ${targetLabel(target)} is now ${candidate.length} / ${maxChars} chars.`,
    };
};

/**
 * Write one target's bytes WHOLESALE, cap-checked. The Dream consolidator's
 * write path: consolidation rewrites the whole file, which an old_text patch
 * cannot express on an empty or restructured file. Same hard cap, same
 * refusal shape, same undo contract as the op-based path — the agent's tools
 * and the system's pass share one gate.
 */
const setCuratedMemoryTextUnlocked = async (
    target: CuratedMemoryTarget,
    text: string,
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryReceipt> => {
    const maxChars = maxCharsForTarget(target);
    const base = await readBlob(username);
    const current = target === 'user' ? base.user : base.memory;
    const nextText = tidy(typeof text === 'string' ? text : '');
    if (nextText.length > maxChars) {
        return {
            ok: false,
            target,
            applied: 0,
            usageChars: current.length,
            maxChars,
            undoSnapshot: current,
            error: 'capacity_exceeded',
            currentChars: current.length,
            attemptedChars: nextText.length,
            message: `${targetLabel(target)} would be ${nextText.length} / ${maxChars} chars — refused.`,
        };
    }
    if (nextText !== current) {
        const next = target === 'user' ? { ...base, user: nextText } : { ...base, memory: nextText };
        await writeBlob(username, next);
    }
    return {
        ok: true,
        target,
        applied: nextText === current ? 0 : 1,
        usageChars: nextText.length,
        maxChars,
        undoSnapshot: current,
        message: nextText === current ? 'No change.' : `Saved. ${targetLabel(target)} is now ${nextText.length} / ${maxChars} chars.`,
    };
};

/**
 * Restore the exact bytes a receipt's `undoSnapshot` captured. The snapshot is
 * only ever the target's own prior text, so a restore cannot overflow the cap
 * (it held then) — the check still runs defensively and refuses a snapshot
 * that would, rather than silently truncating.
 */
const undoMemorySnapshotUnlocked = async (
    target: CuratedMemoryTarget,
    undoSnapshot: string,
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryReceipt> => {
    const maxChars = maxCharsForTarget(target);
    const base = await readBlob(username);
    const current = target === 'user' ? base.user : base.memory;
    const snapshot = typeof undoSnapshot === 'string' ? undoSnapshot : '';
    if (snapshot.length > maxChars) {
        return {
            ok: false,
            target,
            applied: 0,
            usageChars: current.length,
            maxChars,
            undoSnapshot: current,
            error: 'capacity_exceeded',
            currentChars: current.length,
            attemptedChars: snapshot.length,
            message: 'The undo snapshot itself exceeds the cap — refusing rather than truncating.',
        };
    }
    const next = target === 'user' ? { ...base, user: snapshot } : { ...base, memory: snapshot };
    await writeBlob(username, next);
    return {
        ok: true,
        target,
        applied: 1,
        usageChars: snapshot.length,
        maxChars,
        undoSnapshot: current,
        message: `Restored ${targetLabel(target)} (${snapshot.length} / ${maxChars} chars).`,
    };
};

// ─── Locked public write API + atomic pair ─────────────────────────────────

/** Every public mutation serializes its read-modify-write against the Dream
 *  and against other tool calls. Same signature, same receipts as the unlocked
 *  implementations — only the concurrency contract changes. */
export const applyCuratedMemoryOps = (
    target: CuratedMemoryTarget,
    operations: CuratedMemoryOp[],
    options: ApplyCuratedMemoryOptions = {},
): Promise<CuratedMemoryReceipt> =>
    withCuratedMemoryWriteLock(() => applyCuratedMemoryOpsUnlocked(target, operations, options));

export const setCuratedMemoryText = (
    target: CuratedMemoryTarget,
    text: string,
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryReceipt> =>
    withCuratedMemoryWriteLock(() => setCuratedMemoryTextUnlocked(target, text, username));

export const undoMemorySnapshot = (
    target: CuratedMemoryTarget,
    undoSnapshot: string,
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryReceipt> =>
    withCuratedMemoryWriteLock(() => undoMemorySnapshotUnlocked(target, undoSnapshot, username));

export interface CuratedMemoryPairWrite {
    target: CuratedMemoryTarget;
    text: string;
}

/**
 * Replace BOTH files in ONE storage write. USER.md and MEMORY.md are two
 * fields of the SAME JSON blob, so a single `writeBlob` is atomic: a refusal
 * on either cap leaves BOTH prior bytes intact, and a Dream can never land
 * half a consolidation. Caps are validated for the whole batch BEFORE the
 * write — there is no first-file-succeeded/second-file-refused state.
 */
export const setCuratedMemoryTexts = async (
    writes: CuratedMemoryPairWrite[],
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryReceipt[]> =>
    withCuratedMemoryWriteLock(async () => {
        const base = await readBlob(username);
        const before: Record<CuratedMemoryTarget, string> = { user: base.user, memory: base.memory };
        const next: CuratedMemoryBlob = { ...base };
        const refused: Array<{ write: CuratedMemoryPairWrite; attempted: number; max: number }> = [];
        for (const write of writes) {
            const text = tidy(typeof write.text === 'string' ? write.text : '');
            const max = maxCharsForTarget(write.target);
            if (text.length > max) {
                refused.push({ write, attempted: text.length, max });
                continue;
            }
            if (write.target === 'user') next.user = text;
            else next.memory = text;
        }
        if (refused.length > 0) {
            return writes.map((write) => {
                const bad = refused.find(r => r.write === write);
                const current = before[write.target];
                const max = maxCharsForTarget(write.target);
                return {
                    ok: false, target: write.target, applied: 0,
                    usageChars: current.length, maxChars: max, undoSnapshot: current,
                    error: 'capacity_exceeded' as const,
                    currentChars: current.length,
                    attemptedChars: bad?.attempted ?? 0,
                    message: bad
                        ? `${targetLabel(write.target)} would be ${bad.attempted} / ${max} chars — the whole pair was refused.`
                        : 'The pair was refused because another target overflowed; nothing was written.',
                };
            });
        }
        try {
            await writeBlob(username, next);
        } catch (e) {
            // The one storage write failed; it may or may not have landed.
            // Best-effort restore of the exact prior blob, and an honest error
            // rather than a success receipt.
            await writeBlob(username, { ...base }).catch(() => {});
            return writes.map(write => ({
                ok: false, target: write.target, applied: 0,
                usageChars: before[write.target].length,
                maxChars: maxCharsForTarget(write.target),
                undoSnapshot: before[write.target],
                error: 'invalid_op' as const,
                message: `Pair write failed: ${e instanceof Error ? e.message : String(e)}. Prior bytes were restored.`,
            }));
        }
        return writes.map(write => {
            const current = before[write.target];
            const after = write.target === 'user' ? next.user : next.memory;
            return {
                ok: true, target: write.target, applied: after === current ? 0 : 1,
                usageChars: after.length, maxChars: maxCharsForTarget(write.target),
                undoSnapshot: current,
                message: after === current ? 'No change.' : `Saved. ${targetLabel(write.target)} is now ${after.length} chars.`,
            };
        });
    });

// ─── Frozen session snapshot (KV-cache safe) ────────────────────────────────

/**
 * The SYNC snapshot cache. The system-prompt builder is synchronous (the
 * dock assembles the frozen prefix on the render path), so the snapshot is
 * primed ONCE per boot/user-switch here — the same pattern
 * MemoryFilesService uses for the notebook — and `systemPromptFor` reads it
 * without awaiting. Writes after priming persist to disk and invalidate
 * nothing: the frozen prompt keeps its session-start bytes (that is the
 * KV-cache contract), and the delta surfaces through receipts.
 */
let snapshotCache: CuratedMemorySnapshot | null = null;
let snapshotCacheOwner: string | null = null;

export const primeCuratedMemorySnapshot = async (
    username = getActiveUsername() || 'default',
): Promise<CuratedMemorySnapshot> => {
    const snap = await captureCuratedMemorySnapshot(username);
    snapshotCache = snap;
    snapshotCacheOwner = username;
    return snap;
};

/** The primed snapshot, or an empty one before priming (never a throw). */
export const getCachedCuratedMemorySnapshot = (username = getActiveUsername() || 'default'): CuratedMemorySnapshot => {
    if (snapshotCache && snapshotCacheOwner === username) return snapshotCache;
    return {
        userMd: '',
        memoryMd: '',
        userChars: 0,
        memoryChars: 0,
        userMax: USER_MD_MAX_CHARS,
        memoryMax: MEMORY_MD_MAX_CHARS,
        userPct: 0,
        memoryPct: 0,
        capturedAt: '',
    };
};

/** True when the cached snapshot is stale relative to the store's updatedAt
 *  (used by the delta-note path, not by the frozen prefix). */
export const curatedMemorySnapshotIsPrimed = (username = getActiveUsername() || 'default'): boolean =>
    snapshotCache !== null && snapshotCacheOwner === username;

export interface CuratedMemorySnapshot {
    userMd: string;
    memoryMd: string;
    userChars: number;
    memoryChars: number;
    userMax: number;
    memoryMax: number;
    /** 0–100, rounded — the capacity indicator the prompt shows. */
    userPct: number;
    memoryPct: number;
    capturedAt: string;
}

/**
 * Capture BOTH files ONCE per session. The returned object holds copied
 * strings, so later `memory` writes persist to disk WITHOUT mutating this
 * snapshot — the frozen system prompt stays byte-stable for the KV cache, and
 * mid-session edits are surfaced as receipts (and by the delta note), not as
 * a rewritten prefix.
 */
export const captureCuratedMemorySnapshot = async (
    username = getActiveUsername() || 'default',
): Promise<CuratedMemorySnapshot> => {
    const blob = await readBlob(username);
    const pct = (chars: number, max: number): number => Math.min(100, Math.round((chars / max) * 100));
    return {
        userMd: blob.user,
        memoryMd: blob.memory,
        userChars: blob.user.length,
        memoryChars: blob.memory.length,
        userMax: USER_MD_MAX_CHARS,
        memoryMax: MEMORY_MD_MAX_CHARS,
        userPct: pct(blob.user.length, USER_MD_MAX_CHARS),
        memoryPct: pct(blob.memory.length, MEMORY_MD_MAX_CHARS),
        capturedAt: new Date().toISOString(),
    };
};

/** The freshness rule, verbatim, so the prompt and the docs quote one text. */
export const CURATED_MEMORY_FRESHNESS_RULE =
    'MEMORY FRESHNESS: USER.md and MEMORY.md are HINTS about the trader and past workflow — '
    + 'never live market truth. Prices, structure, and journal/ledger stats go stale: verify them '
    + 'against the live desk tools (get_chart_view, get_market_packet, get_trade_log, setup_base_rate) '
    + 'before calling a setup. A memory that contradicts the live tape loses.';

const capacityLine = (label: string, chars: number, max: number, pct: number): string =>
    `[${label} — ${pct}% — ${chars.toLocaleString('en-US')}/${max.toLocaleString('en-US')} chars]`;

/**
 * The frozen prompt block. Empty files render as "(empty — nothing curated
 * yet)", so a new trader's seat still learns the files exist and how to fill
 * them. The capacity indicator is the agent's signal to consolidate before
 * adding, not a quota warning for the trader.
 */
export const buildCuratedMemoryPromptBlock = (snap: CuratedMemorySnapshot): string => {
    const userBody = snap.userMd.trim() || '(empty — nothing curated yet)';
    const memoryBody = snap.memoryMd.trim() || '(empty — nothing curated yet)';
    return [
        '## Curated memory (frozen at session start — mid-session writes land on disk and answer with receipts, not by rewriting this block)',
        capacityLine('USER.md', snap.userChars, snap.userMax, snap.userPct),
        userBody,
        capacityLine('MEMORY.md', snap.memoryChars, snap.memoryMax, snap.memoryPct),
        memoryBody,
        CURATED_MEMORY_FRESHNESS_RULE,
        'To update these files mid-session, call the `memory` tool (target "user" | "memory"); it refuses writes that would overflow the caps.',
    ].join('\n\n');
};

// ─── Idempotent legacy-notebook migration ───────────────────────────────────

const MIGRATED_KEY_PREFIX = 'curated_memory_migrated_v1_';

export interface CuratedMemoryMigrationResult {
    /** False when the migration had already run (or there was nothing to move). */
    migrated: boolean;
    /** Where the legacy prose was preserved. 'notebook' = the archival file;
     *  'memory' = it also fit inside MEMORY.md as a pointer. */
    archivedTo: 'notebook' | 'none';
    archivedChars: number;
    detail: string;
}

/**
 * One-time, idempotent preservation of the LEGACY notebook's curated prose.
 *
 * The notebook (MemoryFilesService) keeps every legacy file — this migration
 * never deletes or rewrites those bytes, it only:
 *   1. copies the harness-written profile/memory.md + rules/risk-rules.md
 *      prose into an archival notebook file `profile/curated-memory-archive.md`
 *      (the notebook is the durable store; no cap pressure there beyond its
 *      own budget), and
 *   2. seeds MEMORY.md with a SHORT pointer when one fits under the cap.
 *
 * Re-running is a no-op: the migrated marker key is set after the archive
 * lands, and a notebook that has no legacy files to archive migrates nothing.
 */
export const migrateLegacyNotebookToCuratedMemory = async (
    username = getActiveUsername() || 'default',
): Promise<CuratedMemoryMigrationResult> => {
    const marker = `${MIGRATED_KEY_PREFIX}${username}`;
    if (await getPreference(marker)) {
        return { migrated: false, archivedTo: 'none', archivedChars: 0, detail: 'Migration already ran for this profile.' };
    }
    const { getMemoryFiles, upsertHarnessFileUnlocked, withNotebookWriteLock, findFolderByName } =
        await import('./MemoryFilesService');
    const day = isoDayStamp();
    // Read AND write under the notebook lock: an init/user-switch must not
    // swap the cache between the scan and the archive write.
    const { legacyChunks, archiveBody } = await withNotebookWriteLock(async () => {
        const files = getMemoryFiles().files;
        const folders = getMemoryFiles().folders;
        const folderNameOf = (folderId: string): string => folders.find(f => f.id === folderId)?.name ?? '';
        const pick = (folder: string, name: string): string =>
            files.find(f => folderNameOf(f.folderId) === folder && f.name === name)?.content ?? '';
        const chunks = [
            { from: 'profile/memory.md', text: pick('profile', 'memory.md') },
            { from: 'rules/risk-rules.md', text: pick('rules', 'risk-rules.md') },
        ].filter(c => c.text.trim().length > 0);
        if (chunks.length === 0) return { legacyChunks: chunks, archiveBody: '' };
        const profileFolder = findFolderByName('profile');
        if (!profileFolder) return { legacyChunks: chunks, archiveBody: '' };
        const body = [
            `# Curated-memory archive (migrated ${day})`,
            '',
            'Preserved copy of the notebook prose that predated the bounded USER.md / MEMORY.md stores. The original files stay in place; nothing was deleted.',
            '',
            ...chunks.flatMap(c => [`## From ${c.from}`, '', c.text.trim(), '']),
        ].join('\n');
        await upsertHarnessFileUnlocked(profileFolder, 'curated-memory-archive.md', body, username);
        return { legacyChunks: chunks, archiveBody: body };
    });
    if (legacyChunks.length === 0) {
        await setPreference(marker, new Date().toISOString());
        return { migrated: false, archivedTo: 'none', archivedChars: 0, detail: 'No legacy notebook prose to archive.' };
    }
    if (!archiveBody) {
        // The archive did NOT land. Leave the marker unset so the next load
        // retries — a "migrated: true" here would lose the legacy prose.
        return { migrated: false, archivedTo: 'none', archivedChars: 0, detail: 'No profile folder to archive into — will retry on the next load.' };
    }
    const pointer = `Legacy notebook prose (profile/memory.md, rules/risk-rules.md) was archived to profile/curated-memory-archive.md on ${day}. The originals remain in the notebook.`;
    const receipt = await applyCuratedMemoryOps('memory', [{ action: 'add', content: pointer }], { username });
    await setPreference(marker, new Date().toISOString());
    return {
        migrated: true,
        archivedTo: 'notebook',
        archivedChars: archiveBody.length,
        detail: receipt.ok
            ? `Archived ${legacyChunks.length} legacy file(s) (${archiveBody.length} chars) and seeded MEMORY.md with a pointer.`
            : `Archived ${legacyChunks.length} legacy file(s); MEMORY.md pointer skipped (${receipt.error}).`,
    };
};
