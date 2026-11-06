/**
 * MemoryFilesService — the Trader Notebook (Learning → Memory).
 *
 * What reaches a prompt is decided by `getMemoryFilesContext` (retrieval) and
 * the `recall` tool; there is no graph walk and no evidence gate — a skill is a
 * document. The user writes notes and rules; the harness maintains:
 *   - profile/memory.md          — what the harness knows about the user
 *   - profile/pattern-memory.md  — synthesis of the journal (never dumped whole)
 *   - profile/index.md           — the notebook map, re-rendered on every persist
 *   - profile/suggestions.md     — the notebook review's advice, kept OUT of retrieval
 *   - trader-diary/<coin>.md     — one diary entry per closed trade
 *   - rules/recurring-mistakes.md — loss clusters from the trade log
 *   - skills/<slug>/SKILL.md     — skill documents, written only by SkillFileService
 *
 * Storage mirrors StrategyService: a synchronous module cache (so prompt
 * assembly at call time never awaits storage) backed by a per-user
 * Preferences key.
 */

import { getPreference, getPreferenceObject, setPreference, setPreferenceObject, removePreference, getAllKeys } from '../infrastructure/PreferencesService';
import { LoggedTrade, MemoryFile, MemoryFolder, TradeOutcome, UserProfile } from '../../types';
import { isMeaningfulLabel } from '../../utils/meaningfulLabel';
import {
    CLEANUP_DEDUP_WINDOW_MS,
    bytesOf,
    describePressure,
    measureNotebook,
    type NotebookPressure,
    type NotebookSize,
} from '../../utils/memoryBudget';

const MEMORY_KEY_PREFIX = 'memory_files_v1_';
/** Shard payloads: `memory_files_v2_<user>_<shard>`. The v1 key keeps the
 *  folders, the small files and the shard manifest. */
const SHARD_KEY_PREFIX = 'memory_files_v2_';
/** The categories large and frequent enough to be worth splitting out. The
 *  rest stay in the manifest so a rule edit does not rewrite the skills. */
const SHARDED_FOLDER_NAMES = new Set(['skills', 'trader-diary']);
/** A preserved copy of a notebook blob the loader could not trust. */
const CORRUPT_KEY_PREFIX = 'memory_files_corrupt_v1_';
/** Diaries keep only the most recent entries so the injected file stays tight. */
const MAX_DIARY_ENTRIES = 50;

export interface NotebookShardMeta {
    key: string;
    checksum: string;
    bytes: number;
    fileIds: string[];
}

export interface MemoryFilesStore {
    version: 1 | 2;
    folders: MemoryFolder[];
    files: MemoryFile[];
    /** v2 only: one entry per sharded folder name. */
    shards?: Record<string, NotebookShardMeta>;
    /** FNV-1a of the folders+files payload. Absent on rows written before
     *  this field existed; a mismatch is reported, never a reason to drop the
     *  trader's bytes. */
    checksum?: string;
    savedAt?: string;
}

/** A cheap integrity fingerprint over the notebook's own bytes. */
export const notebookChecksum = (store: Pick<MemoryFilesStore, 'folders' | 'files'>): string => {
    let hash = 2166136261;
    const text = JSON.stringify({ folders: store.folders, files: store.files });
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export interface NotebookCorruptSidecar {
    key: string;
    capturedAt?: string;
    reason?: string;
    bytes: number;
}

/** Synchronous cache — populated by initMemoryFiles and every mutation. */
let memoryCache: MemoryFilesStore = { version: 1, folders: [], files: [] };

/**
 * The username the CACHE currently holds the notebook for — assigned
 * ATOMICALLY with every memoryCache swap (see adoptCache). Every persist
 * writes to THIS key, never to the username a writer captured at entry:
 * with one module-global cache, a profile switch mid-post-mortem used to hand
 * the new user's notebook to the old writer, which
 * persisted it under the OLD user's Preferences key (and back). Keying
 * persistence to the cache's own owner makes that impossible: data always
 * lands in the key that owns the bytes. The owner must NEVER be assigned
 * while the cache still holds the previous user's bytes — an unlocked
 * concurrent persist racing an in-flight init would then write the stale
 * cache under the NEW user's key.
 */
let memoryCacheOwner: string | null = null;

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Folder/file names are slugified everywhere (UI and AI writer) so the
 *  notebook stays filesystem-safe: lowercase, spaces → dashes, symbols out. */
export const slugifyName = (name: string): string =>
    name.trim()
        .replace(/[^A-Za-z0-9 _-]/g, '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

// ─── Default seed (first boot of a user) ────────────────────────────────────

const DEFAULT_FOLDERS: MemoryFolder[] = [
    { id: 'profile', name: 'profile', order: 0 },
    { id: 'trader-diary', name: 'trader-diary', order: 1 },
    { id: 'market-conditions', name: 'market-conditions', order: 2 },
    { id: 'rules', name: 'rules', order: 3 },
    { id: 'skills', name: 'skills', order: 4 },
    { id: 'bots', name: 'bots', order: 5 },
    { id: 'distilled', name: 'distilled', order: 7 },
    // Goal environments (goals/*.json). A goal is durable work state, not a
    // skill or a note; it lives in the SAME notebook blob so backup/export and
    // the one-store rule already cover it.
    { id: 'goals', name: 'goals', order: 8 },
    // The self-modification ledger (self-changes/*.json). One row per file for
    // the same reason a goal is one file: the notebook write lock, backup and
    // the byte budget already do the work a second store would need to re-do.
    { id: 'self-changes', name: 'self-changes', order: 10 },
    // Strategy plans (strategies/*.md). Lives in the SAME notebook blob as
    // everything else on purpose: a second persistence path would need a
    // second backup/export namespace, and a namespace nothing writes is a
    // phantom row in every backup the app takes.
    { id: 'strategies', name: 'strategies', order: 9 },
];

const SEED_FILES: Omit<MemoryFile, 'id' | 'createdAt' | 'updatedAt'>[] = [
    // The market-conditions starter playbooks (ranging-day.md,
    // after-liquidity-sweep.md) were removed: no retrieval path ever read
    // them, so they only posed as knowledge. The folder stays — user
    // notes there are still welcome, and the memory graph indexes them.
    {
        folderId: 'rules',
        name: 'risk-rules.md',
        enabled: true,
        content: `# Personal Risk Rules

The ensemble already enforces the R:R ladder and ATR stops. Add YOUR hard rules here — e.g.:

- Never risk more than 1% per trade.
- No new entries after 2 consecutive losses — stop for the day.
- Only take the highest-confluence setup (MTF score >= 60).
- Close early if price stalls at the 0.5 fib for more than 2 candles.

The model treats every line here as a binding rule.`,
    },
];

/**
 * Load the active user's notebook into the sync cache (seed the default
 * folders + starter templates on first boot). Call on app boot and on every
 * user switch.
 *
 * NOTE: DEFAULT_FOLDERS objects are shared module state — rename/move mutate
 * folder fields in place, so every seed must deep-copy them or a moved/renamed
 * folder silently rewrites the defaults for all future users.
 *
 * Serialized through the notebook write lock: without it, an init landing
 * mid-mutation swaps the cache under a writer, and the writer's persist then
 * flushes the NEW user's notebook (see memoryCacheOwner).
 */
export const initMemoryFiles = (username: string): Promise<void> =>
    withNotebookWriteLock(() => initMemoryFilesUnlocked(username));

const initMemoryFilesUnlocked = async (username: string): Promise<void> => {
    const freshSeed = (): MemoryFilesStore => ({
        version: 1,
        folders: DEFAULT_FOLDERS.map(f => ({ ...f })),
        files: [],
    });
    // OWNER + BYTES SWAP TOGETHER. Before this, the owner was assigned
    // BEFORE the storage read below — so while B's init was in flight the
    // cache still held A's bytes but was already stamped as B's, and any
    // unlocked concurrent persist (e.g. the ensureHarnessFoldersUnlocked call
    // in the closed-trade write-back) flushed A's
    // stale bytes into B's Preferences key. Adopting atomically keeps
    // owner and bytes always belonging together.
    const adoptCache = (store: MemoryFilesStore): void => {
        memoryCache = store;
        memoryCacheOwner = username;
    };
    try {
        // Read the RAW value, not getPreferenceObject: that getter returns
        // null for "no key" and "unparseable" alike, and the seed branch below
        // ends in persist — so one corrupt byte in the blob used to replace
        // the ENTIRE notebook with an empty one at boot. A missing key is the
        // only case allowed to write here.
        const raw = await getPreference(`${MEMORY_KEY_PREFIX}${username}`);
        if (raw !== null) {
            let stored: MemoryFilesStore | null = null;
            try {
                stored = JSON.parse(raw) as MemoryFilesStore;
            } catch {
                stored = null;
            }
            if (stored && Array.isArray(stored.folders) && Array.isArray(stored.files)) {
                // Integrity is REPORTED, never a reason to drop bytes: a
                // hand-repaired or older blob may predate the checksum, and a
                // mismatch on a readable notebook is still the trader's data.
                if (typeof stored.checksum === 'string' && stored.checksum !== notebookChecksum(stored)) {
                    console.warn(`[MemoryFiles] Notebook for "${username}" failed its checksum; loading it anyway and preserving a sidecar copy.`);
                    await preserveCorruptNotebook(username, raw, 'checksum mismatch');
                }
                if (stored.version === 2 && stored.shards) {
                    // Read the shards back into the ONE in-memory notebook the
                    // rest of the app knows. A shard that will not parse is
                    // preserved, not silently treated as an empty folder.
                    const merged = [...stored.files];
                    for (const [shardName, meta] of Object.entries(stored.shards)) {
                        let shardRaw: string | null = null;
                        try {
                            shardRaw = await getPreference(meta.key);
                            const parsedShard = shardRaw ? JSON.parse(shardRaw) as { files?: unknown; checksum?: unknown } : null;
                            if (!parsedShard || !Array.isArray(parsedShard.files)) throw new Error('not a shard');
                            if (typeof parsedShard.checksum === 'string'
                                && parsedShard.checksum !== notebookChecksum({ folders: [], files: parsedShard.files as MemoryFile[] })) {
                                // The bytes are readable, so they are still loaded;
                                // the mismatch is preserved as evidence, like the
                                // manifest's own checksum.
                                console.warn(`[MemoryFiles] Shard "${shardName}" for "${username}" failed its checksum; loading it anyway and preserving a sidecar copy.`);
                                await preserveCorruptNotebook(username, shardRaw ?? '', `shard ${shardName} checksum mismatch`, meta.key);
                            }
                            merged.push(...parsedShard.files as MemoryFile[]);
                        } catch {
                            console.warn(`[MemoryFiles] Shard "${shardName}" for "${username}" is unreadable; preserving a sidecar and keeping the rest of the notebook.`);
                            await preserveCorruptNotebook(username, shardRaw ?? '', `shard ${shardName} unreadable`, meta.key);
                        }
                    }
                    adoptCache({ ...stored, files: merged });
                } else {
                    adoptCache(stored);
                    // Migrate the one-blob notebook into the manifest + shards
                    // BEFORE anything writes: the v1 bytes stay as the backup
                    // until the shards are written and read back by persist().
                    memoryCache.version = 2;
                    await persist(username);
                }
                await ensureHarnessFoldersUnlocked(username);
                // A load that changes nothing never persists, and the pressure
                // read is what refuses new files — so measure on the read path too,
                // or a notebook can sit at the trigger all session unmeasured.
                measureIntoCache();
                return;
            }
            // Corrupt or foreign blob: serve an in-memory seed so the app
            // works, but NEVER persist it — the bytes on disk are the only
            // copy of whatever the user had, and overwriting them is the one
            // unrecoverable outcome. A sidecar preserves those bytes in a
            // second place; the original key stays untouched so a repaired
            // blob is picked up on the next boot.
            console.warn(`[MemoryFiles] Notebook for "${username}" is unparseable; serving an empty in-memory notebook and preserving a sidecar copy; the stored blob is UNTOUCHED.`);
            await preserveCorruptNotebook(username, raw, 'unparseable JSON');
            adoptCache(freshSeed());
            return;
        }
        // First run: seed AND persist, so a reload does not reseed.
        adoptCache(freshSeed());
        const now = Date.now();
        memoryCache.files = SEED_FILES.map(f => ({ ...f, id: uid(), createdAt: now, updatedAt: now }));
        await persist(username);
    } catch (e) {
        console.warn('[MemoryFiles] Failed to load notebook:', e);
        // Even the fallback seed must arrive with its owner — bytes that
        // belong to THIS user are adopted with THIS user's stamp.
        adoptCache(freshSeed());
    }
};

/** The notebook the sync cache currently holds, as loaded by initMemoryFiles. */
export const getMemoryFilesOwner = (): string | null => memoryCacheOwner;

/**
 * Preserve a notebook blob the loader could not trust. The MAIN key is never
 * touched — this is a second copy, so a repair/restore has something to read
 * after the trader's next write. At most five sidecars per user are kept.
 */
const preserveCorruptNotebook = async (
    username: string,
    raw: string,
    reason: string,
    sourceKey = `${MEMORY_KEY_PREFIX}${username}`,
): Promise<void> => {
    try {
        const key = `${CORRUPT_KEY_PREFIX}${username}_${Date.now()}`;
        await setPreferenceObject(key, {
            capturedAt: new Date().toISOString(),
            sourceKey,
            reason,
            raw,
        });
        const keys = (await getAllKeys())
            .filter(k => k.startsWith(`${CORRUPT_KEY_PREFIX}${username}_`))
            .sort();
        for (const old of keys.slice(0, Math.max(0, keys.length - 5))) {
            await removePreference(old).catch(() => { /* best-effort */ });
        }
    } catch (e) {
        // A sidecar is a second chance, not the first: never break boot for it.
        console.warn('[MemoryFiles] Could not preserve a corrupt-notebook sidecar:', e);
    }
};

/** The preserved copies a recovery affordance can offer. */
export const listNotebookCorruptSidecars = async (username: string): Promise<NotebookCorruptSidecar[]> => {
    try {
        const keys = (await getAllKeys())
            .filter(k => k.startsWith(`${CORRUPT_KEY_PREFIX}${username}_`))
            .sort()
            .reverse();
        const out: NotebookCorruptSidecar[] = [];
        for (const key of keys) {
            const rec = await getPreferenceObject<{ capturedAt?: string; reason?: string; raw?: string }>(key);
            if (!rec) continue;
            out.push({
                key,
                ...(rec.capturedAt ? { capturedAt: rec.capturedAt } : {}),
                ...(rec.reason ? { reason: rec.reason } : {}),
                bytes: typeof rec.raw === 'string' ? rec.raw.length : 0,
            });
        }
        return out;
    } catch {
        return [];
    }
};

/**
 * Put a preserved blob back as the live notebook. It is written RAW (the
 * original bytes, checksum and all) and then re-loaded through the normal
 * path, so a copy that is itself unreadable is refused instead of replacing
 * a good notebook with another broken one.
 */
export const restoreNotebookFromCorruptSidecar = async (username: string, key: string): Promise<boolean> => {
    try {
        if (!key.startsWith(`${CORRUPT_KEY_PREFIX}${username}_`)) return false;
        const rec = await getPreferenceObject<{ raw?: string }>(key);
        if (!rec || typeof rec.raw !== 'string') return false;
        const parsed = JSON.parse(rec.raw) as MemoryFilesStore;
        if (!Array.isArray(parsed.folders) || !Array.isArray(parsed.files)) return false;
        await setPreference(`${MEMORY_KEY_PREFIX}${username}`, rec.raw);
        await initMemoryFiles(username);
        return true;
    } catch {
        return false;
    }
};

/** Current notebook state (for the Settings UI and prompt injection). */
export const getMemoryFiles = (): MemoryFilesStore => memoryCache;

/** Add any missing harness folders (skills, …) for notebooks created before they existed. */
export const ensureHarnessFoldersUnlocked = (username: string): Promise<void> => withNotebookRollback(async () => {
    const names = new Set(memoryCache.folders.map(f => f.name));
    const looksLikeHarness = DEFAULT_FOLDERS.some(d => names.has(d.name));
    if (!looksLikeHarness) return;
    let changed = false;
    for (const def of DEFAULT_FOLDERS) {
        if (!memoryCache.folders.some(f => f.name === def.name)) {
            memoryCache.folders.push({ id: def.id, name: def.name, order: memoryCache.folders.length });
            changed = true;
        }
    }
    if (changed) await persist(username);
});

/**
 * Persist the cache for the user the cache was LOADED for (memoryCacheOwner),
 * not for the username the caller captured at entry — see the memoryCacheOwner
 * note. The passed username is only a fallback for writers that run before any
 * init has ever assigned an owner. Empty store clears the key.
 */
const persist = async (username: string): Promise<void> => {
    const owner = memoryCacheOwner ?? username;
    if (owner !== username) {
        console.warn(
            `[MemoryFiles] Writer captured "${username}" but the cache is owned by "${owner}" ` +
            '(profile switched mid-write) — persisting to the cache owner\'s key.'
        );
    }
    if (persistSilentDepth === 0) upsertNotebookIndexInCache();
    try {
        if (memoryCache.folders.length === 0 && memoryCache.files.length === 0) {
            notebookSize = null;
            await removePreference(`${MEMORY_KEY_PREFIX}${owner}`);
        } else {
            measureIntoCache();
            // Version + checksum ride the write, so a later load can tell a
            // complete blob from a partial one without guessing.
            const savedAt = new Date().toISOString();
            // Split the large, frequently-written categories out of the
            // manifest. The cache keeps every file; only the STORED shape is
            // partitioned, so every reader of getMemoryFiles() is unchanged.
            const folderNameById = new Map(memoryCache.folders.map(f => [f.id, f.name]));
            const coreFiles: MemoryFile[] = [];
            const byShard = new Map<string, MemoryFile[]>();
            for (const file of memoryCache.files) {
                const name = folderNameById.get(file.folderId) ?? '';
                if (SHARDED_FOLDER_NAMES.has(name)) {
                    byShard.set(file.folderId, [...(byShard.get(file.folderId) ?? []), file]);
                } else {
                    coreFiles.push(file);
                }
            }
            const shards: Record<string, NotebookShardMeta> = {};
            for (const [folderId, files] of byShard) {
                const key = `${SHARD_KEY_PREFIX}${owner}_${slugifyName(folderId) || folderId}`;
                const payload = {
                    version: 2,
                    shard: folderId,
                    files,
                    checksum: notebookChecksum({ folders: [], files }),
                    savedAt,
                };
                await setPreferenceObject(key, payload);
                shards[folderId] = {
                    key,
                    checksum: payload.checksum,
                    bytes: JSON.stringify(payload).length,
                    fileIds: files.map(f => f.id),
                };
            }
            // The manifest is written LAST: a failed shard write leaves the
            // previous manifest pointing at the previous shards, so one full
            // shard cannot take the whole notebook down with it.
            const manifest: MemoryFilesStore = {
                version: 2,
                folders: memoryCache.folders,
                files: coreFiles,
                ...(Object.keys(shards).length > 0 ? { shards } : {}),
                savedAt,
                checksum: notebookChecksum({ folders: memoryCache.folders, files: coreFiles }),
            };
            memoryCache.version = 2;
            memoryCache.savedAt = savedAt;
            memoryCache.checksum = notebookChecksum(memoryCache);
            await setPreferenceObject(`${MEMORY_KEY_PREFIX}${owner}`, manifest);
        }
    } catch (e) {
        // Record, then rethrow: every caller's handling of a failed write is
        // unchanged, and this is the only place that can see it happened.
        recordWriteFailure(e);
        throw e;
    }
    clearMemoryWriteFailure('notebook');
    if (persistSilentDepth === 0) {
        memoryChangeListeners.forEach(handler => handler(owner));
    }
};

/**
 * A notebook write that the storage layer refused.
 *
 * This used to be invisible, and it is the worst failure mode this store has:
 * `setPreferenceObject` rejects on a full origin quota (and on a native write
 * error), every caller catches and logs, and the in-memory cache goes on
 * serving every byte the trader has ever learned — so the app looks healthy,
 * the Health tab looks healthy, and NOTHING FURTHER IS ON DISK. The next reload
 * returns to whatever was last written successfully. `utils/memoryBudget.ts`
 * describes this exact hazard and only mitigates it by refusing to grow; the
 * blob can still outlive the quota, and a failed write still had no owner.
 *
 * So the failure is not swallowed here: it is named, counted, and read by
 * `memoryHealth`, which puts it in front of the user as the first thing on the
 * memory report. Deliberately NOT retried or auto-shrunk — nothing in this
 * store is safe to evict to make room (see the budget's rule).
 */
/**
 * Which store refused the write. The notebook blob and the pending-amendment
 * queue are different keys in the SAME origin, so a quota refusal in either
 * means the same thing to the user — but the bytes and the name in the report
 * have to be the ones that actually failed, or the report is describing a
 * store that was fine.
 */
export type MemoryWriteScope = 'notebook' | 'amendments';

export const SCOPE_LABEL: Record<MemoryWriteScope, string> = {
    notebook: 'notebook',
    amendments: 'amendment queue',
};

export interface NotebookWriteFailure {
    atMs: number;
    /** `quota` when the store refused the blob for size — the one the user can
     *  act on — and `error` for anything else. */
    kind: 'quota' | 'error';
    message: string;
    /** The measured blob the store refused, UTF-16 bytes (0 if never measured). */
    bytes: number;
    /** Consecutive failures since the last write that reached disk. */
    streak: number;
    /** The store that refused. See `MemoryWriteScope`. */
    scope: MemoryWriteScope;
}

/** Per-scope, and deliberately not one global: the amendment queue reaching
 *  disk says nothing about whether the notebook blob did, so a success in one
 *  must never clear a failure still standing in the other. */
const writeFailures: Partial<Record<MemoryWriteScope, NotebookWriteFailure>> = {};
const writeFailureStreaks: Partial<Record<MemoryWriteScope, number>> = {};

/** Refused-for-size is the actionable case, and each engine spells it
 *  differently: the DOMException name on Chromium/WebKit, a message on
 *  Firefox, and Capacitor surfaces the platform's own storage error. */
const QUOTA_SIGNATURES = ['quota', 'exceeded', 'full', 'exceed'];

const isQuotaFailure = (e: unknown): boolean => {
    const err = e as { name?: unknown; message?: unknown } | null;
    const hay = `${String(err?.name ?? '')} ${String(err?.message ?? e)}`.toLowerCase();
    return QUOTA_SIGNATURES.some(s => hay.includes(s));
};

/**
 * Record a memory write the storage layer refused, and say which store it was.
 *
 * Public because the notebook is not the only store that can silently lose a
 * write: `memoryAmendments` keeps the pending model-correction queue in its own
 * localStorage key, and a quota refusal there loses the same thing the notebook
 * refusal loses — a model-proposed correction the trader never gets to approve.
 * AGENTS.md forbids a swallow-and-continue around a memory write, and that rule
 * is about the failure having an owner, not about which key it was written to.
 *
 * Recording is NOT the caller's job to forget: it rethrows, so this only ever
 * adds a record next to an error already on its way up.
 */
export const recordMemoryWriteFailure = (e: unknown, scope: MemoryWriteScope, bytes: number): void => {
    const streak = (writeFailureStreaks[scope] ?? 0) + 1;
    writeFailureStreaks[scope] = streak;
    const message = e instanceof Error ? e.message : String(e);
    const failure: NotebookWriteFailure = {
        atMs: Date.now(),
        kind: isQuotaFailure(e) ? 'quota' : 'error',
        message: message.slice(0, 200),
        bytes,
        streak,
        scope,
    };
    writeFailures[scope] = failure;
    console.error(
        `[MemoryFiles] ${SCOPE_LABEL[scope]} write FAILED (${failure.kind}, ${streak} in a row)`
        + ` — the trader's memory is NOT being saved:`,
        e,
    );
};

/** This scope reached disk again, so its streak is over. Scoped on purpose. */
export const clearMemoryWriteFailure = (scope: MemoryWriteScope): void => {
    delete writeFailures[scope];
    writeFailureStreaks[scope] = 0;
};

/** The notebook's own write failure, from `persist`. */
const recordWriteFailure = (e: unknown): void => {
    recordMemoryWriteFailure(e, 'notebook', notebookSize?.bytes ?? 0);
};

/** The most recent memory write any store had refused, or null when writes are
 *  reaching disk (including when nothing has been written yet). Most recent
 *  rather than "worst" because the count a user can act on is the one still
 *  happening; each scope's own streak is preserved in the record it returns. */
export const getNotebookWriteFailure = (): NotebookWriteFailure | null => {
    let latest: NotebookWriteFailure | null = null;
    for (const failure of Object.values(writeFailures)) {
        if (failure && (!latest || failure.atMs > latest.atMs)) latest = failure;
    }
    return latest;
};


/**
 * The last measured size of the cache, and the pressure it implies. Recomputed
 * on every persist — never cached across a reload, because it is derived from
 * bytes that are themselves in memory — so `getNotebookSize()` cannot drift
 * from what is actually stored. `null` until something has been persisted or
 * loaded, which is a notebook nobody has opened yet.
 */
let notebookSize: NotebookSize | null = null;

/**
 * The single measurement point. Called from `persist` (every write) and from
 * `initMemoryFilesUnlocked` (so a load that writes nothing is still measured).
 * The number that governs the budget is the serialized payload — that is the
 * string Preferences is about to be asked to hold, envelope and escaping
 * included — while the per-folder attribution comes from the content itself,
 * because "which folder is fat" has to name something a user can act on.
 */
const measureIntoCache = (): void => {
    try {
        const detail = measureNotebook(memoryCache.files, memoryCache.folders);
        notebookSize = {
            ...detail,
            bytes: Math.max(detail.bytes, bytesOf(JSON.stringify(memoryCache))),
        };
        reportPressure(notebookSize);
    } catch { /* a guard must never break a persist */ }
};

let lastReportedAt = 0;
let lastReportedPressure: NotebookPressure | null = null;
const reportPressure = (size: NotebookSize): void => {
    if (size.pressure === 'ok') { lastReportedPressure = null; return; }
    const now = Date.now();
    // A tier change always speaks; a repeat of the same tier is throttled, so a
    // post-mortem that re-persists the blob five times logs the pressure once.
    if (lastReportedPressure === size.pressure && now - lastReportedAt < CLEANUP_DEDUP_WINDOW_MS) return;
    lastReportedPressure = size.pressure;
    lastReportedAt = now;
    const line = describePressure(size);
    if (size.pressure === 'hard') console.error(`[MemoryFiles] ${line}`);
    else console.warn(`[MemoryFiles] ${line}`);
};

/** The current notebook size + pressure, or null before anything is loaded. */
export const getNotebookSize = (): NotebookSize | null => notebookSize;

/** True when the blob has grown into the tiers a hygiene pass exists to
 *  relieve. An unmeasured notebook (`null`) is deliberately NOT a request: a
 *  pass scheduled before the blob loads would be guessing, and the weekly clock
 *  still covers it. Refusing growth is only half the budget's job — this is the
 *  half that makes reaching the trigger tier DO something. */
export const notebookWantsCleanup = (): boolean => {
    const tier = notebookSize?.pressure;
    return tier === 'trigger' || tier === 'hard';
};

/** True when the harness must stop growing the notebook. `newFiles` refuses
 *  creation only (appends still land, so learning continues); `all` refuses
 *  every model write. Refusal, never eviction: see utils/memoryBudget.ts for
 *  why there is nothing safe to delete in this store. */
export const notebookPressureAllows = (kind: 'newFiles' | 'appends' | 'all'): boolean => {
    const pressure = notebookSize?.pressure ?? 'ok';
    if (kind === 'all') return pressure !== 'hard';
    if (kind === 'appends') return pressure !== 'hard';
    return pressure !== 'hard' && pressure !== 'trigger';
};

let persistSilentDepth = 0;
const memoryChangeListeners = new Set<(username: string) => void>();

/** Subscribe to notebook writes. Returns unsubscribe. */
export const subscribeMemoryFilesChanged = (handler: (username: string) => void): (() => void) => {
    memoryChangeListeners.add(handler);
    return () => { memoryChangeListeners.delete(handler); };
};

// ─── Write lock ─────────────────────────────────────────────────────────────
// Every notebook mutation is a read-modify-write over the shared cache, and
// writers run concurrently: fire-and-forget trade syncs, the awaited
// post-mortem sync, the skill pen, notebook reviews, UI edits.
// Mutations are therefore serialized through a single promise chain.
//
// DEADLOCK RULE: a function that acquires this lock (any public mutator or
// withNotebookWriteLock caller) must only call the *Unlocked variants of
// other mutators — never a locked public from inside the lock.
let writeChain: Promise<unknown> = Promise.resolve();

export const withNotebookWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
};

/**
 * Snapshot the cache, run one mutation, and restore the exact pre-write state
 * when the persist rejects. A notebook write that throws on a full origin quota
 * must not leave the cache describing bytes that never landed — the create path
 * learned this first (the 2026-10-27 audit M-1); update, delete and folder moves had the
 * same lie, in the privacy-adjacent direction.
 */
const withNotebookRollback = async <T>(fn: () => Promise<T>): Promise<T> => {
    const filesBefore = memoryCache.files.map(f => ({ ...f }));
    const foldersBefore = memoryCache.folders.map(f => ({ ...f }));
    try {
        return await fn();
    } catch (e) {
        memoryCache.files = filesBefore;
        memoryCache.folders = foldersBefore;
        measureIntoCache();
        throw e;
    }
};

/** Persist without notifying listeners (used when writing suggestions.md). */
export const withSilentMemoryPersist = async (fn: () => Promise<void>): Promise<void> => {
    persistSilentDepth += 1;
    try {
        await withNotebookWriteLock(fn);
    } finally {
        persistSilentDepth -= 1;
    }
};

export const SUGGESTIONS_FILE_NAME = 'suggestions.md';
export const NOTEBOOK_INDEX_FILE = 'index.md';

const SKIP_INDEX_DUMP = new Set(['pattern-memory.md', 'suggestions.md', 'index.md']);

/** First heading or first prose line — keeps the notebook map scannable. */
export const fileBlurb = (content: string, max = 72): string => {
    const withoutFm = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const heading = withoutFm.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const line = heading
        || withoutFm.split('\n').map(l => l.trim()).find(l => l.length > 8 && !l.startsWith('>') && !l.startsWith('---'))
        || '';
    return line.replace(/\s+/g, ' ').slice(0, max);
};

const folderNameOf = (file: MemoryFile): string =>
    memoryCache.folders.find(f => f.id === file.folderId)?.name ?? 'misc';

/**
 * Compact catalog + wiki-style links. Always injected (progressive disclosure)
 * so a new conversation still knows the notebook exists.
 */
export const buildNotebookMapMarkdown = (): string => {
    const enabled = memoryCache.files.filter(f =>
        f.enabled && f.content.trim() && !SKIP_INDEX_DUMP.has(f.name.toLowerCase())
    );
    if (enabled.length === 0) return '';

    const rows: string[] = [
        '**NOTEBOOK MAP** — you already have a trader notebook. This is the index; matching files are quoted below.',
        '',
        '| File | About |',
        '| --- | --- |',
    ];
    const sortedFolders = [...memoryCache.folders].sort((a, b) => a.order - b.order);
    for (const folder of sortedFolders) {
        const folderFiles = enabled
            .filter(f => f.folderId === folder.id)
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const f of folderFiles) {
            // A skill is a folder: show its logical path, not the storage key.
            rows.push(`| ${folder.name}/${f.path ?? f.name} | ${fileBlurb(f.content)} |`);
        }
    }

    const links = new Map<string, Set<string>>();
    const addLink = (node: string, path: string): void => {
        const key = node.trim();
        if (!key) return;
        const set = links.get(key) ?? new Set<string>();
        set.add(path);
        links.set(key, set);
    };
    for (const f of enabled) {
        const path = `${folderNameOf(f)}/${f.name}`;
        const folder = folderNameOf(f);
        if (folder === 'trader-diary') {
            addLink(f.name.replace(/\.md$/i, '').toUpperCase(), path);
        }
        const coin = f.content.match(/^coin:\s*(.+)$/mi)?.[1]?.trim();
        const direction = f.content.match(/^direction:\s*(.+)$/mi)?.[1]?.trim();
        const family = f.content.match(/^family:\s*(.+)$/mi)?.[1]?.trim();
        const regime = f.content.match(/^regime:\s*(.+)$/mi)?.[1]?.trim();
        if (coin) addLink(coin.toUpperCase().replace(/USDT?$/, '') + 'USDT', path);
        if (direction) addLink(direction, path);
        if (family) addLink(family, path);
        if (regime) addLink(regime, path);
        if (/ranging/i.test(f.name)) addLink('ranging', path);
        if (/sweep|liquidity/i.test(f.name)) addLink('sweep', path);
    }

    const edgeLines = [...links.entries()]
        .filter(([, paths]) => paths.size > 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, 24)
        .map(([node, paths]) => `- **${node}** → ${[...paths].join(', ')}`);
    if (edgeLines.length > 0) {
        rows.push('', '**Graph** (topic → files):', ...edgeLines);
    }
    return rows.join('\n');
};

const upsertNotebookIndexInCache = (): void => {
    const profile = memoryCache.folders.find(f => f.name === 'profile');
    if (!profile) return;
    const map = buildNotebookMapMarkdown();
    const existingIdx = memoryCache.files.findIndex(f => f.folderId === profile.id && f.name === NOTEBOOK_INDEX_FILE);
    if (!map) {
        if (existingIdx >= 0) memoryCache.files.splice(existingIdx, 1);
        return;
    }
    const body = `# Notebook index

Auto-maintained map of this trader notebook. Readable markdown — every analysis also gets a compact copy so new conversations are not a blank slate.

${map}
`;
    const now = Date.now();
    if (existingIdx >= 0) {
        const existing = memoryCache.files[existingIdx];
        if (existing.content === body) return;
        memoryCache.files[existingIdx] = { ...existing, content: body, autoManaged: true, enabled: true, updatedAt: now };
        return;
    }
    memoryCache.files.push({
        id: uid(),
        folderId: profile.id,
        name: NOTEBOOK_INDEX_FILE,
        content: body,
        enabled: true,
        autoManaged: true,
        createdAt: now,
        updatedAt: now,
    });
};

// ─── Folder CRUD ────────────────────────────────────────────────────────────

export const createMemoryFolderUnlocked = (name: string, username: string): Promise<MemoryFolder> => withNotebookRollback(async () => {
    const clean = slugifyName(name);
    if (!clean) throw new Error('Folder name is required');
    const existing = memoryCache.folders.find(f => f.name === clean);
    if (existing) return existing;
    const folder: MemoryFolder = { id: uid(), name: clean, order: memoryCache.folders.length };
    memoryCache.folders.push(folder);
    await persist(username);
    return folder;
});

/** Serialized public API — see withNotebookWriteLock. */
export const createMemoryFolder = (name: string, username: string): Promise<MemoryFolder> =>
    withNotebookWriteLock(() => createMemoryFolderUnlocked(name, username));

/** Rename a folder (slugified). Returns the new slug, or null if unknown. */
export const renameMemoryFolderUnlocked = (id: string, name: string, username: string): Promise<string | null> => withNotebookRollback(async () => {
    const clean = slugifyName(name);
    if (!clean) throw new Error('Folder name is required');
    if (memoryCache.folders.some(f => f.id !== id && f.name === clean)) throw new Error(`Folder "${clean}" already exists`);
    const folder = memoryCache.folders.find(f => f.id === id);
    if (!folder) return null;
    folder.name = clean;
    await persist(username);
    return clean;
});

/** Serialized public API — see withNotebookWriteLock. */
export const renameMemoryFolder = (id: string, name: string, username: string): Promise<string | null> =>
    withNotebookWriteLock(() => renameMemoryFolderUnlocked(id, name, username));

/**
 * Move a folder to a new index in the sidebar (drag & drop). Order persists
 * and drives prompt-injection order (profile stays first until moved).
 */
export const moveMemoryFolderUnlocked = (id: string, toIndex: number, username: string): Promise<void> => withNotebookRollback(async () => {
    const fromIndex = memoryCache.folders.findIndex(f => f.id === id);
    if (fromIndex < 0) return;
    const target = Math.max(0, Math.min(toIndex, memoryCache.folders.length - 1));
    if (fromIndex === target) return;
    const [moved] = memoryCache.folders.splice(fromIndex, 1);
    memoryCache.folders.splice(target, 0, moved);
    memoryCache.folders.forEach((f, i) => { f.order = i; });
    await persist(username);
});

/** Serialized public API — see withNotebookWriteLock. */
export const moveMemoryFolder = (id: string, toIndex: number, username: string): Promise<void> =>
    withNotebookWriteLock(() => moveMemoryFolderUnlocked(id, toIndex, username));

export const deleteMemoryFolderUnlocked = (id: string, username: string): Promise<void> => withNotebookRollback(async () => {
    memoryCache.folders = memoryCache.folders.filter(f => f.id !== id);
    memoryCache.files = memoryCache.files.filter(f => f.folderId !== id);
    await persist(username);
});

/** Serialized public API — see withNotebookWriteLock. */
export const deleteMemoryFolder = (id: string, username: string): Promise<void> =>
    withNotebookWriteLock(() => deleteMemoryFolderUnlocked(id, username));

// ─── File CRUD ──────────────────────────────────────────────────────────────

export const createMemoryFileUnlocked = async (
    folderId: string,
    name: string,
    content: string,
    username: string,
    /** Harness-written files (diary, profile, recurring mistakes) label themselves "auto" in the UI. */
    autoManaged = false,
    /** Logical path inside the folder (skills/<slug>/SKILL.md). The storage
     *  name stays unique; this is what gives a skill its directory shape. */
    path?: string,
): Promise<MemoryFile> => {
    const requested = name.trim();
    const cleanName = /\.(md|json)$/i.test(requested) ? requested : `${requested}.md`;
    if (!cleanName || cleanName === '.md') throw new Error('File name is required');
    if (memoryCache.files.some(f => f.folderId === folderId && f.name === cleanName)) {
        throw new Error(`"${cleanName}" already exists in this folder`);
    }
    // Byte pressure, enforced at the ONE choke point every creation flows
    // through. Until now only `writeModelNoteUnlocked` consulted the budget,
    // so past the trigger tier the harness kept minting skill files while the
    // Health tab told the trader it had stopped.
    //
    // Scoped to the skills folder on purpose: a new skill is the growth the
    // model drives itself, and the one it can undo by merging or deleting.
    // Refusing here REDIRECTS rather than blocks — an update or an append to a
    // file that already exists is untouched at every tier, so a lesson still
    // lands; only minting a NEW skill stops until the trader frees space.
    if (!notebookPressureAllows('newFiles')) {
        const folder = memoryCache.folders.find(f => f.id === folderId)?.name ?? 'misc';
        if (folder === 'skills') {
            throw new Error(
                'Cannot add a new skill — the notebook is at its size budget'
                + `${notebookSize ? ` (${describePressure(notebookSize)})` : ''}.`
                + ' Existing skills can still be updated. Merge or delete redundant skills to free space.',
            );
        }
    }
    const now = Date.now();
    const file: MemoryFile = { id: uid(), folderId, name: cleanName, ...(path ? { path } : {}), content, enabled: true, autoManaged, createdAt: now, updatedAt: now };
    // A cache is a promise about what is stored. `persist` rejects on a full
    // origin quota while the array on line -3 already holds the new row, so the
    // notebook goes on serving bytes that never reached disk — and the next
    // reader of that cache reports them as fact. That is not hypothetical: a
    // phantom skill makes the next write answer "already exists" and delete the
    // trader's only copy of the draft (the 2026-10-27 audit M-1, reproduced in
    // the browser). Roll the mutation back with the failure
    // so the store can only describe what it actually holds.
    const filesBefore = memoryCache.files;
    memoryCache.files = [...filesBefore, file];
    try {
        await persist(username);
    } catch (e) {
        memoryCache.files = filesBefore;
        measureIntoCache();
        throw e;
    }
    return file;
};

/** Serialized public API — see withNotebookWriteLock. */
export const createMemoryFile = (
    folderId: string,
    name: string,
    content: string,
    username: string,
    autoManaged = false
): Promise<MemoryFile> =>
    withNotebookWriteLock(() => createMemoryFileUnlocked(folderId, name, content, username, autoManaged));

/** Patch fields of an existing file (content edits, enable toggle). */
export const updateMemoryFileUnlocked = (id: string, patch: Partial<MemoryFile>, username: string): Promise<void> => withNotebookRollback(async () => {
    const existing = memoryCache.files.findIndex(f => f.id === id);
    if (existing < 0) return;
    // A patch that changes nothing must not cost a write. Every persist
    // re-renders the notebook map and rewrites the whole blob (and the sharded
    // folders rewrite their shard), so a boot pass that "synced" identical
    // bytes used to spend a full write per file — measured at two blob
    // rewrites per profile load before any of the sync paths short-circuited.
    const changed = Object.entries(patch).some(([key, value]) =>
        (memoryCache.files[existing] as unknown as Record<string, unknown>)[key] !== value);
    if (!changed) return;
    memoryCache.files[existing] = { ...memoryCache.files[existing], ...patch, updatedAt: Date.now() };
    await persist(username);
});

/** Serialized public API — see withNotebookWriteLock. */
export const updateMemoryFile = (id: string, patch: Partial<MemoryFile>, username: string): Promise<void> =>
    withNotebookWriteLock(() => updateMemoryFileUnlocked(id, patch, username));

/**
 * Find a folder by its exact (slugified) name in the sync cache.
 * Callers that hold the notebook write lock use this directly; others go
 * through the *Unlocked APIs inside withNotebookWriteLock.
 */
export const findFolderByName = (name: string): MemoryFolder | undefined =>
    memoryCache.folders.find(f => f.name === name);

/** Find a file by exact name inside one folder. */
export const findFileInFolder = (folderId: string, baseName: string): MemoryFile | undefined =>
    memoryCache.files.find(f => f.folderId === folderId && f.name === baseName);

/**
 * Write a harness-owned file: update it when a file with this exact name
 * already lives in the folder, create it (autoManaged) otherwise. The
 * find-then-update-or-create shape every sync service repeated verbatim.
 * Caller must hold the notebook write lock (or be a *Unlocked function).
 */
export const upsertHarnessFileUnlocked = async (
    folder: MemoryFolder,
    fileName: string,
    content: string,
    username: string,
): Promise<MemoryFile> => {
    const existing = findFileInFolder(folder.id, fileName);
    if (existing) {
        await updateMemoryFileUnlocked(existing.id, { content }, username);
        // Return the FRESH cache object — `existing` is a stale reference.
        return memoryCache.files.find(f => f.id === existing.id) ?? existing;
    }
    return createMemoryFileUnlocked(folder.id, fileName, content, username, true);
};

export const deleteMemoryFileUnlocked = (id: string, username: string): Promise<void> => withNotebookRollback(async () => {
    memoryCache.files = memoryCache.files.filter(f => f.id !== id);
    await persist(username);
});

/** Serialized public API — see withNotebookWriteLock. */
export const deleteMemoryFile = (id: string, username: string): Promise<void> =>
    withNotebookWriteLock(() => deleteMemoryFileUnlocked(id, username));

// ─── Prompt injection ───────────────────────────────────────────────────────

export type { MemoryRetrievalQuery } from './MemoryRetrievalService';

/** UI stats: how many files are injected and at what total size. */
export const getMemoryFilesStats = (): { enabledCount: number; charCount: number } => {
    const enabled = memoryCache.files.filter(f => f.enabled && f.content.trim());
    return {
        enabledCount: enabled.length,
        charCount: enabled.reduce((sum, f) => sum + f.content.length, 0),
    };
};

// ─── Harness auto-writes ────────────────────────────────────────────────────

/**
 * Pull a one-line lesson out of a post-mortem report: the first "Lesson:" /
 * "Key takeaway:" style line if present, else the first meaningful sentence.
 * Mirrors the reflection-injection lesson style (DecisionReflectionService).
 *
 * Header-mining guard: post-mortems often format the lesson as a TITLE —
 * `**Lesson: 🩸 LOSS FORENSIC ANALYSIS…**` or `# Lesson: bold takeaway` —
 * with the substance on later lines. Matching the wrapper line stored the
 * title and dropped the lesson, so heading/bold-wrapped matches are
 * rejected, and captures that are themselves title-shaped (all-caps
 * forensics headers) are skipped in favor of the first real sentence.
 */
const LESSON_TITLE_PREFIX = /^(loss forensic|forensic analysis|key takeaway|post[- ]?mortem)/i;

/** True when the captured text reads as a section title, not a sentence. */
const isTitleShapedLesson = (text: string): boolean => {
    const t = text.trim();
    if (LESSON_TITLE_PREFIX.test(t)) return true;
    const words = t.match(/[A-Za-z]{2,}/g) ?? [];
    return words.length >= 2 && words.every(w => w === w.toUpperCase());
};

export const extractLessonFromPostMortem = (postMortem: string): string => {
    if (!postMortem) return '';
    const LESSON_PATTERN = /(?:key\s+)?(?:lesson|lesson\s+learned|takeaway|actionable\s+takeaway|key\s+insight|what\s+(?:should|to)\s+(?:i\s+)?do\s+(?:differently\s+)?(?:next|next\s+time)?)\s*[:\-–]\s*([^\n]{10,})/i;
    for (const rawLine of postMortem.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const isHeading = /^#{1,6}\s/.test(line);
        const isBoldWrapped = line.startsWith('**') && line.endsWith('**');
        // Strip heading/bold wrappers so a "Lesson:" inside them can match…
        const stripped = line.replace(/^#{1,6}\s+/, '').replace(/^\*\*(.+?)\*\*$/, '$1').trim();
        const match = stripped.match(LESSON_PATTERN);
        if (!match) continue;
        // …but the wrapper line itself is a title — the substance is below.
        if (isHeading || isBoldWrapped) continue;
        const capture = match[1]
            .replace(/^[\s*_\-–:：]+/, '')
            .replace(/[*_]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (capture.length < 10 || isTitleShapedLesson(capture)) continue;
        return capture.slice(0, 200);
    }
    // Fallback: the first non-header, non-list line that looks like a
    // sentence. Label-shaped lines ("Lesson: …") are excluded too — if the
    // loop above rejected their capture, the label itself is not the lesson.
    const LESSON_LABEL = /^(?:key\s+)?(?:lesson(?:\s+learned)?|takeaway|actionable\s+takeaway|key\s+insight)\s*[:\-–]/i;
    const line = postMortem.split('\n').map(l => l.trim()).find(l =>
        l.length > 20 && !l.startsWith('#') && !l.startsWith('**') && !l.startsWith('-') && !l.startsWith('*') && !l.startsWith('>') && !LESSON_LABEL.test(l)
    );
    return line ? line.replace(/\s+/g, ' ').slice(0, 200) : '';
};

const buildDiaryEntry = (trade: LoggedTrade): string => {
    const a = trade.analysis ?? {};
    const outcomeLabel = trade.outcome === TradeOutcome.WIN ? 'WIN ✅' : 'LOSS ❌';
    const pnl = typeof trade.pnlPercent === 'number'
        ? ` (${trade.pnlPercent > 0 ? '+' : ''}${trade.pnlPercent}%)`
        : typeof trade.pnlAmount === 'number'
            ? ` (${trade.pnlAmount > 0 ? '+' : ''}$${trade.pnlAmount.toFixed(2)})`
            : '';
    const date = new Date(trade.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const lesson = extractLessonFromPostMortem(trade.postMortem ?? '');
    const lines = [`${date} · ${a.coinName ?? '?'} · ${a.direction ?? '?'} · ${outcomeLabel}${pnl}`];
    lines.push(`id: ${trade.id}`);
    if (lesson) lines.push(`What I learned: ${lesson}`);
    return lines.join('\n');
};

/**
 * Append one closed trade to trader-diary/<coin>.md (creating the file on
 * first entry). Only WIN/LOSS trades are logged — pending and entry-not-hit
 * runs carry no lesson. The file keeps the newest MAX_DIARY_ENTRIES entries.
 */
export const appendDiaryEntryUnlocked = async (trade: LoggedTrade, username: string): Promise<void> => {
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return;
    const folder = memoryCache.folders.find(f => f.name === 'trader-diary');
    if (!folder) return;
    const coin = (trade.analysis?.coinName ?? 'General').trim() || 'General';
    const safeName = `${coin.replace(/[^A-Za-z0-9_-]/g, '')}.md`;
    const entry = buildDiaryEntry(trade);
    const header = `# ${coin} Trade Diary (auto-maintained)\n> Keeps the last ${MAX_DIARY_ENTRIES} trades.`;

    const existing = memoryCache.files.find(f => f.folderId === folder.id && f.name === safeName);
    if (existing?.content.includes(`id: ${trade.id}`)) return;
    if (existing) {
        const entries = existing.content.split('\n## ').slice(1).filter(Boolean);
        const updated = [...entries, entry].slice(-MAX_DIARY_ENTRIES);
        await updateMemoryFileUnlocked(existing.id, { content: `${header}\n\n## ${updated.join('\n## ')}` }, username);
    } else {
        await createMemoryFileUnlocked(folder.id, safeName, `${header}\n\n## ${entry}`, username, true);
    }
};

/** Serialized public API — see withNotebookWriteLock. */
export const appendDiaryEntry = (trade: LoggedTrade, username: string): Promise<void> =>
    withNotebookWriteLock(() => appendDiaryEntryUnlocked(trade, username));

/**
 * Regenerate profile/memory.md from the user's actual profile data — who the
 * trader is, what they trade, their settings. Fully harness-managed.
 */
export const syncProfileMemoryUnlocked = async (profile: UserProfile | null, username: string): Promise<void> => {
    const folder = memoryCache.folders.find(f => f.name === 'profile');
    if (!folder) return;
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    if (!profile) {
        const fallback = `# About the Trader (auto-maintained by August)\n> Updated ${dateStr}\n\nNo profile data loaded yet.\n`;
        await upsertHarnessFileUnlocked(folder, 'memory.md', fallback, username);
        return;
    }

    const trades = profile.tradeLog ?? [];
    const closed = trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS);
    const wins = closed.filter(t => t.outcome === TradeOutcome.WIN).length;
    const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;

    const favorites = new Map<string, number>();
    trades.forEach(t => {
        const coin = t.analysis?.coinName;
        if (coin) favorites.set(coin, (favorites.get(coin) ?? 0) + 1);
    });
    const topCoins = [...favorites.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, n]) => `${c} (${n})`)
        .join(', ') || 'none yet';

    const prefs = profile.globalMemory?.userPreferences;
    const s = profile.settings ?? {};
    const flags = [
        s.isHybridIntelligenceEnabled ? 'Hybrid Intelligence' : null,
        s.isStrategiesEnabled ? 'Strategy books' : null,
    ].filter(Boolean).join(', ') || 'standard setup';

    const lines: string[] = [
        '# About the Trader (auto-maintained by August)',
        `> Updated ${dateStr} — from your profile and trade log. The model reads this file first.`,
        '',
        `- **Trader:** ${profile.username || username}`,
        `- **Trades logged:** ${trades.length} (${wins} win / ${closed.length - wins} loss${trades.length - closed.length > 0 ? ` / ${trades.length - closed.length} pending` : ''})`,
        ...(winRate !== null ? [`- **Win rate:** ${winRate}% (completed trades)`] : []),
        `- **Favorite assets:** ${topCoins}`,
        ...(prefs?.leverageDefault ? [`- **Default leverage:** ${prefs.leverageDefault}x`] : []),
        ...(prefs?.preferredSetup ? [`- **Preferred setup:** ${prefs.preferredSetup}`] : []),
        `- **App setup:** ${flags}`,
        '',
        'This file is maintained automatically. Add your own knowledge in the other notebook files (market-conditions, rules, or a new folder).',
    ];
    const content = lines.join('\n') + '\n';

    await upsertHarnessFileUnlocked(folder, 'memory.md', content, username);
};

/** Serialized public API — see withNotebookWriteLock. */
export const syncProfileMemory = (profile: UserProfile | null, username: string): Promise<void> =>
    withNotebookWriteLock(() => syncProfileMemoryUnlocked(profile, username));

const PATTERN_MEMORY_HEADINGS = [
    'Executive Summary',
    'Missed Win Analysis',
    'Extended SL Zone Breach Analysis',
    'Pattern Family Performance',
    'Confidence Calibration',
    'Winning Patterns',
    'Failure Patterns',
    'Behavioral Biases',
    'Statistical Tendencies',
    'Actionable Rules',
    'Conclusion',
];

/** Keep even when short — the rest of the essay can drop empty product sections. */
const PATTERN_MEMORY_KEEP = new Set([
    'executive summary',
    'actionable rules',
    'conclusion',
]);

const EMPTY_SECTION = /^(none\.?|n\/a\.?|n\/a|na\.?|not applicable\.?|no data\.?|nothing to report\.?|no missed wins?\.?|no breaches?\.?|-|—|–|\(none\))?\s*$/i;

export interface PatternMemoryStats {
    closed?: number;
    wins?: number;
    losses?: number;
}

export const patternMemoryStatsFromTrades = (trades: LoggedTrade[]): PatternMemoryStats => {
    const closed = trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS);
    const wins = closed.filter(t => t.outcome === TradeOutcome.WIN).length;
    const losses = closed.filter(t => t.outcome === TradeOutcome.LOSS).length;
    return { closed: closed.length, wins, losses };
};

const patternMemoryHeader = (stats?: PatternMemoryStats): string => {
    const dateStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lines = [
        '# Pattern Memory',
        '> Human synthesis — not injected into analyses. Live loop: `skills/` and `rules/recurring-mistakes.md`.',
        '',
    ];
    if (stats && typeof stats.closed === 'number' && stats.closed > 0) {
        const wins = stats.wins ?? 0;
        const losses = stats.losses ?? 0;
        const wr = Math.round((wins / stats.closed) * 100);
        lines.push(`- **Closed trades:** ${stats.closed} (${wins} win / ${losses} loss)`);
        lines.push(`- **Win rate:** ${wr}%`);
    }
    lines.push(`- **Updated:** ${dateStr}`);
    lines.push('');
    lines.push('See also: `skills/` (documents the desk writes and reads) and `rules/recurring-mistakes.md` (loss clusters).');
    lines.push('');
    return lines.join('\n');
};

const stripExistingPatternMemoryChrome = (text: string): string => {
    let body = text.trim();
    body = body.replace(/^#\s+pattern memory\b[^\n]*\n+/i, '');
    body = body.replace(/^(>\s.*\n)+/, '');
    body = body.replace(/^(-\s+\*\*[^*]+\*\*:.*\n)+/, '');
    body = body.replace(/^see also:.*\n+/i, '');
    return body.trim();
};

const promotePatternMemoryHeadings = (body: string): string => {
    const headingLookup = PATTERN_MEMORY_HEADINGS.map(h => [h.toLowerCase(), h] as const);
    return body.split('\n').map(line => {
        const stripped = line
            .replace(/^[#\s>*_\-`]+/, '')
            .replace(/[*_]/g, '')
            .replace(/^[^\w]+/, '')
            .trim()
            .toLowerCase();
        const hit = headingLookup.find(([key]) =>
            stripped === key || stripped === `${key}:` || stripped.startsWith(`${key}:`)
        );
        if (hit && stripped.length <= hit[0].length + 8) {
            return `## ${hit[1]}`;
        }
        return line;
    }).join('\n');
};

/** Drop product sections whose heading is a placeholder ("N/A", "None") or whose only content is None / N/A / blank. */
export const collapseEmptyPatternMemorySections = (markdown: string): string => {
    const lines = markdown.split('\n');
    const chunks: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
    for (const line of lines) {
        const h = line.match(/^##\s+(.+)\s*$/);
        if (h) {
            chunks.push({ heading: h[1], lines: [] });
        } else {
            chunks[chunks.length - 1].lines.push(line);
        }
    }
    const kept: string[] = [];
    for (const chunk of chunks) {
        if (!chunk.heading) {
            const preamble = chunk.lines.join('\n').trim();
            if (preamble) kept.push(preamble);
            continue;
        }
        const body = chunk.lines.join('\n').trim();
        const keepAlways = PATTERN_MEMORY_KEEP.has(chunk.heading.toLowerCase());
        if (!keepAlways && (!isMeaningfulLabel(chunk.heading) || EMPTY_SECTION.test(body))) continue;
        kept.push(`## ${chunk.heading}\n${chunk.lines.join('\n')}`.trimEnd());
    }
    return kept.join('\n\n').trim();
};

/** Turn a synthesis blob into a markdown document (headings → ##). */
export const toPatternMemoryMarkdown = (
    summary: string | null | undefined,
    stats?: PatternMemoryStats,
): string => {
    const header = patternMemoryHeader(stats);
    const stub = `${header}Log more trades to generate a performance synthesis.\n`;
    if (!summary || !summary.trim()) return stub;

    const promoted = promotePatternMemoryHeadings(stripExistingPatternMemoryChrome(summary));
    const collapsed = collapseEmptyPatternMemorySections(promoted);
    return `${header}${collapsed}\n`;
};

/**
 * Write profile/pattern-memory.md from the current synthesis (or a stub when
 * empty). Harness-managed — the History tab opens this as a document.
 */
export const syncPatternMemoryUnlocked = async (
    summary: string | null | undefined,
    username: string,
    trades?: LoggedTrade[],
): Promise<void> => {
    const folder = memoryCache.folders.find(f => f.name === 'profile');
    if (!folder) return;
    const stats = trades ? patternMemoryStatsFromTrades(trades) : undefined;
    const content = toPatternMemoryMarkdown(summary, stats);
    await upsertHarnessFileUnlocked(folder, 'pattern-memory.md', content, username);
};

/** Serialized public API — see withNotebookWriteLock. */
export const syncPatternMemory = (
    summary: string | null | undefined,
    username: string,
    trades?: LoggedTrade[],
): Promise<void> =>
    withNotebookWriteLock(() => syncPatternMemoryUnlocked(summary, username, trades));

/**
 * Regenerate rules/recurring-mistakes.md from the trade log — deterministic,
 * code-side loss-cluster analysis (no AI): groups of 2+ losses on the same
 * coin + direction, worst first. The model reads this on every analysis, so
 * recurring failures become impossible to ignore.
 */
export const syncRecurringMistakesUnlocked = async (trades: LoggedTrade[], username: string): Promise<void> => {
    const folder = memoryCache.folders.find(f => f.name === 'rules');
    if (!folder) return;
    const content = buildRecurringMistakesContent(trades);
    await upsertHarnessFileUnlocked(folder, 'recurring-mistakes.md', content, username);
};

/** Serialized public API — see withNotebookWriteLock. */
export const syncRecurringMistakes = (trades: LoggedTrade[], username: string): Promise<void> =>
    withNotebookWriteLock(() => syncRecurringMistakesUnlocked(trades, username));

/** Pure content builder for recurring-mistakes.md (exported for tests). */
export const buildRecurringMistakesContent = (trades: LoggedTrade[]): string => {
    const lines: string[] = [
        '# My Recurring Mistakes (auto-synced from my trade log)',
        '> Loss clusters of 2+ trades on the same coin + direction. These are the setups where I keep losing — I check this list before recommending any trade.',
        '',
    ];
    const losses = trades.filter(t => t.outcome === TradeOutcome.LOSS);
    if (losses.length === 0) {
        lines.push('No losses logged yet — this file lists my loss clusters once trades are logged.');
        return lines.join('\n');
    }

    const clusters = new Map<string, { count: number; pnlPct: number[]; last: string }>();
    losses.forEach(t => {
        const key = `${t.analysis?.coinName ?? 'UNKNOWN'} ${t.analysis?.direction ?? '?'}`;
        const c = clusters.get(key) ?? { count: 0, pnlPct: [], last: '' };
        c.count += 1;
        if (typeof t.pnlPercent === 'number') c.pnlPct.push(t.pnlPercent);
        if (!c.last || t.timestamp > c.last) c.last = t.timestamp;
        clusters.set(key, c);
    });

    const recurring = [...clusters.entries()]
        .filter(([, c]) => c.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

    if (recurring.length === 0) {
        lines.push('No recurring loss clusters yet (needs 2+ losses on the same coin + direction).');
    } else {
        recurring.forEach(([key, c]) => {
            const avgPct = c.pnlPct.length > 0
                ? ` avg ${(c.pnlPct.reduce((a, b) => a + b, 0) / c.pnlPct.length).toFixed(1)}%`
                : '';
            const last = new Date(c.last).toLocaleDateString();
            lines.push(`- ⚠️ **${c.count}× ${key}**${avgPct} — last ${last}. I keep losing here; I need fresh confirmation before taking this setup again.`);
        });
    }
    return lines.join('\n');
};

// ─── Outcome-weighted lessons (journal Learning tab) ────────────────────────

export interface TopLesson {
    /** "BTCUSDT Short" — the coin + direction cluster. */
    label: string;
    count: number;
    /** Average pnlPercent across the cluster, when recorded. */
    avgPnl: number | null;
    last: string;
    kind: 'win' | 'loss';
}

/**
 * Outcome-weighted clusters from the trade log (2+ trades per coin +
 * direction): LOSS clusters first (the fix list), then WIN clusters (the
 * repeat list), each by count desc. Deterministic + testable — the journal
 * Learning tab renders these as "Top Lessons".
 */
export const computeTopLessons = (trades: LoggedTrade[], limit = 6): TopLesson[] => {
    const clusters = new Map<string, { label: string; count: number; pnl: number[]; last: string; kind: 'win' | 'loss' }>();
    for (const t of trades) {
        if (t.outcome !== TradeOutcome.WIN && t.outcome !== TradeOutcome.LOSS) continue;
        const label = `${t.analysis?.coinName ?? 'UNKNOWN'} ${t.analysis?.direction ?? '?'}`;
        const kind = t.outcome === TradeOutcome.WIN ? 'win' : 'loss';
        // Key includes the outcome — wins and losses on the same coin +
        // direction are separate clusters (repeat list vs fix list).
        const key = `${label}|${kind}`;
        const c = clusters.get(key) ?? { label, count: 0, pnl: [], last: '', kind };
        c.count += 1;
        if (typeof t.pnlPercent === 'number') c.pnl.push(t.pnlPercent);
        if (!c.last || t.timestamp > c.last) c.last = t.timestamp;
        clusters.set(key, c);
    }
    return [...clusters.values()]
        .filter(c => c.count >= 2)
        .sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'loss' ? -1 : 1;
            return b.count - a.count;
        })
        .slice(0, limit)
        .map(c => ({
            label: c.label,
            count: c.count,
            avgPnl: c.pnl.length > 0 ? c.pnl.reduce((sum, v) => sum + v, 0) / c.pnl.length : null,
            last: c.last,
            kind: c.kind,
        }));
};

// ─── AI writer (the model creates folders + files itself) ───────────────────

/**
 * A note the AI wants to write into the notebook. The model decides the
 * decision AFTER reading the current notebook index (see
 * `getMemoryFilesIndex`): append to an existing file when the topic already
 * has a home, create a new file (and maybe folder) when it is new, or skip
 * when the lesson is already covered. A missing decision means 'create'
 * (backward compatible with older callers).
 */
export type ModelNoteDecision = 'skip' | 'append' | 'create';

export interface ModelNote {
    decision?: ModelNoteDecision;
    folder: string;
    fileName: string;
    content: string;
}

/**
 * Compact structure of the whole notebook for the model to read BEFORE it
 * writes: folder tree, file names, sizes, and a short excerpt of each file —
 * enough to decide append-vs-create and reuse-vs-new-folder without dumping
 * entire files into the prompt.
 */
export const getMemoryFilesIndex = (): string => {
    if (memoryCache.files.length === 0) return '(empty notebook — no files yet)';
    const lines: string[] = [];
    for (const folder of [...memoryCache.folders].sort((a, b) => a.order - b.order)) {
        const folderFiles = memoryCache.files
            .filter(f => f.folderId === folder.id)
            .sort((a, b) => a.name.localeCompare(b.name));
        if (folderFiles.length === 0) continue;
        lines.push(`📁 ${folder.name}/`);
        for (const f of folderFiles) {
            const excerpt = fileBlurb(f.content, 120);
            lines.push(`   📄 ${f.name} (${f.content.length} chars)${excerpt ? ` — ${excerpt}` : ''}`);
        }
    }
    const map = buildNotebookMapMarkdown();
    const graph = map.split('**Graph**')[1];
    if (graph) {
        lines.push('', '**Graph**' + graph);
    }
    return lines.join('\n');
};

/**
 * Write an AI-generated note into the notebook. The model picks the folder —
 * if it does not exist yet it is created (the model can create folders, the
 * user can too). Names are slugified and existing files are NEVER overwritten:
 *  - decision 'append'  → the note becomes a NEW SECTION (--- separator) on
 *    an existing file (fuzzy name match: same stem, or one name contains the
 *    other). Falls back to creating the file when the target does not exist.
 *  - decision 'create'  → a new file; if the exact name is taken, it is
 *    suffixed -2, -3… instead of overwriting.
 * Files are marked "auto" like the other harness-managed ones.
 */
/** Max appended sections per AI-written note file (oldest trimmed). */
const MAX_NOTE_SECTIONS = 30;
/** Max harness-written note files per folder (oldest autoManaged file pruned). */
const MAX_NOTES_PER_FOLDER = 40;
const NOTE_SECTION_SEP = '\n\n---\n\n';

/**
 * The (folder, file) pairs the harness REGENERATES WHOLESALE from its own
 * data — profile sync, pattern memory, recurring mistakes, suggestions.
 * A model append into one of these is silently clobbered on the next rebuild,
 * so writeModelNote rejects it; the amend_memory path is the only sanctioned
 * write (it rejects these targets too, by design). Model notes (lessons/,
 * session-timing/, …) are autoManaged but NOT regenerated — they stay
 * appendable. The trader-diary and distilled folders are banned outright
 * (checked at folder level above).
 */
const HARNESS_REGENERATED_FILES: ReadonlySet<string> = new Set([
    'profile/memory.md',
    'profile/pattern-memory.md',
    'profile/suggestions.md',
    'rules/recurring-mistakes.md',
]);
const isHarnessRegeneratedFile = (folderName: string, fileName: string): boolean =>
    HARNESS_REGENERATED_FILES.has(`${folderName}/${fileName}`);

/** Is this file rebuilt wholesale by a harness pass (profile memory, pattern
 *  memory, recurring mistakes, suggestions)? Model notes are
 *  autoManaged too — for the prune pass — but they are NOT regenerated, so the
 *  amendment path must not confuse the two. */
export const isHarnessRegeneratedTarget = (
    file: Pick<MemoryFile, 'folderId' | 'name'>,
): boolean => {
    const folder = memoryCache.folders.find(f => f.id === file.folderId);
    return !!folder && isHarnessRegeneratedFile(folder.name, file.name);
};

export const writeModelNoteUnlocked = async (note: ModelNote, username: string): Promise<MemoryFile> => {
    const cleanFolder = slugifyName(note.folder) || 'lessons';
    if (cleanFolder === 'skills') throw new Error('Use skill_index and skill_write to write skills.');
    const baseName = slugifyName(note.fileName.replace(/\.md$/i, '')) || 'note';
    const content = (note.content ?? '').trim();
    if (!content) throw new Error('Note content is empty');
    // Past the hard cap the writer stops completely rather than pushing the
    // single blob over what the platform will take. Nothing already stored is
    // touched: the whole design of this budget is refuse-growth-not-evict (see
    // utils/memoryBudget.ts).
    if (!notebookPressureAllows('all')) {
        const size = getNotebookSize();
        throw new Error('Cannot write a notebook note — the notebook is at its hard size budget'
            + (size ? ` (${describePressure(size)})` : ''));
    }

    let folder = memoryCache.folders.find(f => f.name === cleanFolder);
    if (!folder) folder = await createMemoryFolderUnlocked(cleanFolder, username);

    // The diary and the distilled-fact store are the harness's OWN
    // namespaces — every file there is written (or regenerated) by a sync
    // service, so a model note landing in either would collide with, or be
    // clobbered by, the harness's next pass. Model notes belong in their
    // own folders (lessons/, rules/, market-conditions/, …).
    if (folder.name === 'trader-diary' || folder.name === 'distilled') {
        throw new Error(`Cannot write model notes into the harness-owned '${folder.name}' folder — pick lessons/ or another note folder.`);
    }

    // Append: extend an existing file when one matches (same stem, or one
    // name contains the other) — never overwrite, the note is a new section.
    if (note.decision === 'append') {
        const candidates = memoryCache.files.filter(f => f.folderId === folder.id);
        const target = candidates.find(f => f.name.replace(/\.md$/i, '') === baseName)
            ?? candidates.find(f =>
                f.name.replace(/\.md$/i, '').includes(baseName)
                || baseName.includes(f.name.replace(/\.md$/i, ''))
            );
        if (target) {
            // Harness-owned files are REGENERATED WHOLESALE by their owning
            // service (profile sync, pattern synthesis, lens memory, …) —
            // an append here would be silently clobbered on the next rebuild.
            // Model notes (also autoManaged) live OUTSIDE this set and stay
            // appendable; the amendment proposal flow rejects all of them.
            if (isHarnessRegeneratedFile(folder.name, target.name)) {
                throw new Error(`Cannot append to a harness-managed file — ${folder.name}/${target.name} is rewritten by the harness. Use the amend_memory proposal flow instead.`);
            }
            // Bound append-mode growth: keep the file head (everything before
            // the first section separator) plus the newest sections only.
            const parts = target.content.split(NOTE_SECTION_SEP);
            const head = parts[0];
            const sections = [...parts.slice(1), content].slice(-MAX_NOTE_SECTIONS);
            const updated = `${[head, ...sections].join(NOTE_SECTION_SEP)}\n`;
            await updateMemoryFileUnlocked(target.id, { content: updated }, username);
            // Return the FRESH object from the cache — `target` is a stale
            // reference and would report the pre-append content.
            return memoryCache.files.find(f => f.id === target.id) ?? target;
        }
        // Target file does not exist yet — create it with the note as its content.
        assertRoomForNewNote();
        await pruneModelNotesIfFull(folder.id, username);
        return createMemoryFileUnlocked(folder.id, `${baseName}.md`, content, username, true);
    }

    // Create: never overwrite — suffix -2, -3… when the name is taken.
    let name = `${baseName}.md`;
    let i = 2;
    while (memoryCache.files.some(f => f.folderId === folder.id && f.name === name)) {
        name = `${baseName}-${i}.md`;
        i += 1;
    }
    assertRoomForNewNote();
    await pruneModelNotesIfFull(folder.id, username);
    return createMemoryFileUnlocked(folder.id, name, content, username, true);
};

/**
 * Refuse to add a FILE when the notebook is under size pressure. An append to a
 * file that already exists is still allowed at this tier — it grows the blob by
 * one section instead of by a whole row's overhead plus its folder, and it keeps
 * the learning loop writing while the human decides what to prune. Throws,
 * because every caller of `writeModelNote` already handles a rejection here:
 * the harness-owned folders have refused writes this way all along.
 */
const assertRoomForNewNote = (): void => {
    if (notebookPressureAllows('newFiles')) return;
    const size = getNotebookSize();
    throw new Error(
        'Cannot create a new notebook file — the notebook is at its size budget'
        + (size ? ` (${describePressure(size)})` : '')
        + '. Append to an existing note, or prune one, first.',
    );
};

/** Serialized public API — see withNotebookWriteLock. */
export const writeModelNote = (note: ModelNote, username: string): Promise<MemoryFile> =>
    withNotebookWriteLock(() => writeModelNoteUnlocked(note, username));

/**
 * Keep a folder's harness-written note count bounded: when at capacity,
 * drop the OLDEST autoManaged file before a new one lands. User-authored
 * files are never touched — only notes this service created.
 */
const pruneModelNotesIfFull = async (folderId: string, username: string): Promise<void> => {
    const auto = memoryCache.files.filter(f => f.folderId === folderId && f.autoManaged);
    if (auto.length < MAX_NOTES_PER_FOLDER) return;
    const oldest = [...auto].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) await deleteMemoryFileUnlocked(oldest.id, username);
};

// ─── Note search (backs the `recall` desk tool) ─────────────────────────────

export interface NotebookNoteHit {
    path: string;
    excerpt: string;
}

/** Folders recall must NOT dump: skills ride the skill-meta retrieval tier,
 *  diary/distilled/lens/bots are harness-owned writes, archive is retired. */
const NOTE_SEARCH_SKIP_FOLDERS = new Set(['skills', 'trader-diary', 'distilled', 'lens', 'bots', 'archive']);

/**
 * Keyword search over the model's/user's NOTE files — the folders
 * `write_memory_note` writes into. The skill-tier retrieval never sees these
 * (no SKILL frontmatter), so without this a saved lesson is invisible to the
 * `recall` tool despite its "lessons learned" promise. Ranks enabled files by
 * term hits (name ×3, capped body hits), excerpts the first line containing a
 * term.
 */
export const searchNotebookNotes = (topic: string, limit = 3): NotebookNoteHit[] => {
    const terms = [...new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2))];
    if (terms.length === 0) return [];
    const folderById = new Map(memoryCache.folders.map(f => [f.id, f]));
    const hits = memoryCache.files
        .filter(f => f.enabled && f.content.trim() && !SKIP_INDEX_DUMP.has(f.name.toLowerCase()))
        .map(f => {
            const folder = folderById.get(f.folderId);
            if (!folder || NOTE_SEARCH_SKIP_FOLDERS.has(folder.name)) return null;
            if (HARNESS_REGENERATED_FILES.has(`${folder.name}/${f.name}`)) return null;
            const name = f.name.toLowerCase();
            const body = f.content.toLowerCase();
            let score = 0;
            for (const t of terms) {
                if (name.includes(t)) score += 3;
                score += Math.min(body.split(t).length - 1, 4);
            }
            if (score === 0) return null;
            const lines = f.content.split('\n').map(l => l.trim()).filter(Boolean);
            const hitLine = lines.find(l => terms.some(t => l.toLowerCase().includes(t))) ?? lines[0] ?? '';
            const excerpt = hitLine.length > 240 ? `${hitLine.slice(0, 240).trimEnd()}…` : hitLine;
            return { path: `${folder.name}/${f.name}`, excerpt, score };
        })
        .filter((x): x is NotebookNoteHit & { score: number } => x !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    return hits.map(({ path, excerpt }) => ({ path, excerpt }));
};
