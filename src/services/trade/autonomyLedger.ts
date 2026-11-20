/**
 * autonomyLedger — the reversible audit trail for autonomous mutations.
 *
 * The autonomy engine's ruling is OPTIMISTIC: a valid autonomous mutation
 * executes immediately instead of waiting on a human modal, and THIS module is
 * what makes that safe. Every mutation appends a compact record that carries
 * enough snapshot to UNDO the write, and the activity feed offers one-click
 * revert. Nothing here re-derives subsystem logic: each undo payload is
 * interpreted by the same seam that made the write (profileMemory for memory,
 * SkillFileService.writeSkillFile for skills, the drawings control for chart).
 *
 * Shape rules:
 *  - The record is DATA, never a closure — it persists to
 *    `autonomy_ledger_v1_<user>` (capped), so undo survives a reload.
 *  - `undoneAt` marks a reverted record; undoing is itself append-only
 *    history, never a deletion.
 *  - A record WITHOUT an undo payload is still legal (an observation, or an
 *    action whose revert is the older record it superseded).
 */

import { getActiveUsername } from '../../utils/activeUser';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';

export type AutonomySubsystem = 'memory' | 'skill' | 'chart' | 'watch' | 'sentinel';

/** The persisted revert instruction. One variant per subsystem seam. */
export type AutonomyUndo =
    | { kind: 'memory-forget'; slug: string }
    | { kind: 'memory-restore'; entry: { slug: string; name?: string; title?: string; description: string; kind: string; body: string } }
    | { kind: 'memory-update'; slug: string; previous: { description: string; body: string; title?: string; version?: number } }
    | { kind: 'skill-restore'; slug: string; previous: { body: string; description: string; name?: string } }
    | { kind: 'chart-restore'; sessionId: string; symbol: string; drawings: unknown[] }
    | { kind: 'none' };

export interface AutonomyRecord {
    id: string;
    at: number;
    subsystem: AutonomySubsystem;
    /** One human-readable line — the feed renders exactly this. */
    summary: string;
    undo?: AutonomyUndo;
    undoneAt?: number;
}

const KEY_PREFIX = 'autonomy_ledger_v1_';
const LEDGER_CAP = 100;

const listeners = new Set<() => void>();
let cache: { user: string; records: AutonomyRecord[] } | null = null;

const keyFor = (username: string): string => `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

export const subscribeAutonomyLedger = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

const emit = (): void => { for (const fn of [...listeners]) fn(); };

/** The in-flight persist, awaited by readers so an append is visible to the
 *  very next list call (the feed opens right after a loop acts). */
let pendingWrite: Promise<void> = Promise.resolve();

const readRecords = async (username: string): Promise<AutonomyRecord[]> => {
    if (cache && cache.user === username) return cache.records;
    try {
        const raw = await getPreferenceObject<{ records?: AutonomyRecord[] }>(keyFor(username));
        const records = Array.isArray(raw?.records) ? raw!.records! : [];
        cache = { user: username, records };
        return records;
    } catch {
        cache = { user: username, records: [] };
        return [];
    }
};

const writeRecords = async (username: string, records: AutonomyRecord[]): Promise<void> => {
    cache = { user: username, records };
    try {
        await setPreferenceObject(keyFor(username), { records });
    } catch { /* the audit trail never blocks the mutation it recorded */ }
    emit();
};

/** Append one record (newest first, capped). The CACHE updates synchronously
 *  when this user's records are already loaded, so a reader that runs right
 *  after a loop acted sees the record immediately; the persist chains behind
 *  any in-flight write. */
export const appendAutonomyRecord = (
    record: Omit<AutonomyRecord, 'id' | 'at' | 'undoneAt'> & { at?: number },
    username: string = getActiveUsername(),
): AutonomyRecord => {
    const full: AutonomyRecord = {
        ...record,
        id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: record.at ?? Date.now(),
    };
    if (cache && cache.user === username) {
        cache = { user: username, records: [full, ...cache.records].slice(0, LEDGER_CAP) };
        emit();
    }
    pendingWrite = (async () => {
        await pendingWrite.catch(() => { /* the previous write already reported */ });
        const records = await readRecords(username);
        if (!records.some(r => r.id === full.id)) {
            await writeRecords(username, [full, ...records].slice(0, LEDGER_CAP));
        } else {
            await writeRecords(username, records);
        }
    })();
    return full;
};

/** The feed's source of truth (async — the store lives in Preferences). */
export const listAutonomyRecords = async (username: string = getActiveUsername()): Promise<AutonomyRecord[]> => {
    await pendingWrite.catch(() => { /* a failed persist still serves the cache */ });
    return readRecords(username);
};

export const isAutonomyRecordUndone = (record: AutonomyRecord): boolean =>
    typeof record.undoneAt === 'number';

/** True when a record still carries a live revert (used to gate the Undo button). */
export const canUndoAutonomyRecord = (record: AutonomyRecord): boolean =>
    !!record.undo && record.undo.kind !== 'none' && !isAutonomyRecordUndone(record);

/**
 * Revert one record through the seam that made the write. The undo payloads
 * dynamic-import their subsystem so the ledger stays import-light and cycle
 * free. The record is marked `undoneAt` whether or not the revert throws —
 * a failed undo surfaces through the thrown error, and a second click must
 * never double-apply.
 */
export const undoAutonomyRecord = async (
    id: string,
    username: string = getActiveUsername(),
): Promise<void> => {
    const records = await readRecords(username);
    const record = records.find(r => r.id === id);
    if (!record || !canUndoAutonomyRecord(record)) return;
    const undo = record.undo!;
    switch (undo.kind) {
        case 'memory-forget': {
            const { forgetProfileMemory } = await import('../learning/profileMemory');
            forgetProfileMemory(undo.slug, username, 'model');
            break;
        }
        case 'memory-restore': {
            const { rememberProfileMemory } = await import('../learning/profileMemory');
            const e = undo.entry;
            rememberProfileMemory({
                slug: e.slug, name: e.name, title: e.title,
                description: e.description, kind: e.kind as never, body: e.body,
                source: 'auto', tag: 'inferred', author: 'model',
            }, username);
            break;
        }
        case 'memory-update': {
            const { updateProfileMemory } = await import('../learning/profileMemory');
            const { getProfileMemory } = await import('../learning/profileMemory');
            const current = getProfileMemory(undo.slug, username);
            updateProfileMemory({
                slug: undo.slug,
                mode: 'replace',
                body: undo.previous.body,
                ...(current ? { ifVersion: current.version } : {}),
            }, username);
            break;
        }
        case 'skill-restore': {
            const { writeSkillFile, skillLibraryVersion, listSkillFiles, contentVersion, getSkill } = await import('../learning/SkillFileService');
            // The ONE pen (writeSkillFile), same gates as a model write: the
            // restore must read the CURRENT bytes and pass their version, or
            // the stale-index refusal fires — undoing an edit the engine no
            // longer owns would otherwise clobber a later human edit.
            const current = getSkill(undo.slug);
            const all = listSkillFiles();
            await writeSkillFile({
                slug: undo.slug,
                name: undo.previous.name ?? undo.slug,
                description: undo.previous.description,
                body: undo.previous.body,
                ...(current ? { ifVersion: contentVersion(current.file.content) } : {}),
            }, username, {
                indexVersion: skillLibraryVersion(all),
                opened: new Map([[undo.slug, contentVersion(current ? current.file.content : undo.previous.body)]]),
            });
            break;
        }
        case 'chart-restore': {
            const { drawingsControl } = await import('./drawingsControl');
            drawingsControl('model', undo.sessionId, undo.symbol, username).replace(undo.drawings as never);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('august:agent-drawings-changed', { detail: { sessionId: undo.sessionId, symbol: undo.symbol } }));
            }
            break;
        }
        case 'none':
            return;
    }
    const next = records.map(r => (r.id === id ? { ...r, undoneAt: Date.now() } : r));
    pendingWrite = writeRecords(username, next);
    await pendingWrite;
};

/** Test hook: wipe the cache + backing key for one user. */
export const __resetAutonomyLedgerForTests = async (username: string = getActiveUsername()): Promise<void> => {
    await pendingWrite.catch(() => { /* whatever was in flight is obsolete */ });
    cache = null;
    try { await setPreferenceObject(keyFor(username), { records: [] }); } catch { /* fresh run */ }
    emit();
};
