/**
 * positionStore — the dedicated home for tracked positions and post-mortems.
 *
 * NOT the UserProfile blob. A position carries a capped path/context timeline,
 * and the profile is rewritten by the ordinary save/heartbeat path; a trading
 * tracker that lived there would either be lost by a stale save or make every
 * settings write pay for the timeline. The read API is the same on every
 * backend:
 *
 *   native (Capacitor)  → the shared SQLite connection, `tracking_store`
 *                         (username, kind, payload). A Preferences copy left by
 *                         a backup restore is adopted once, then SQLite owns it.
 *   desktop (Electron)  → `<userData>/store/prefs/…` JSON files through
 *                         `storeBackend` (atomic write + backup + 32 MiB cap).
 *   web                 → the same `storeBackend` key, localStorage.
 *
 * WRITES ARE READ-BACK VERIFIED, like the signal ledger: a backend that
 * silently drops bytes must not report a save. A failed read refuses the
 * write, so a corrupt store is never overwritten by an empty-looking load.
 *
 * CAPS. Open positions are never pruned. Closed/expired/cancelled rows keep
 * the newest `TRACKED_MAX_CLOSED_POSITIONS`; diagnoses keep the newest
 * `TRACKED_MAX_DIAGNOSES`. The diagnosis QUEUE is not pruned — a pending
 * diagnosis is a debt, and the per-pass cap must never turn it into a loss.
 */

import type {
    DiagnosisQueueItem,
    TrackedDiagnosis,
    TrackedPosition,
} from '../../types/tracking';
import { TRACKED_MAX_CLOSED_POSITIONS } from '../../types/tracking';
import { parseTrackedDiagnosis, parseTrackedPosition } from '../../schemas/tracking';
import { readStore, writeStore, removeStore } from '../infrastructure/storeBackend';
import { isNativePlatform } from '../infrastructure/SqliteService';
import { getSqliteDb, runExclusiveWrite } from '../infrastructure/SqliteServiceHelpers';
import { getPreference, removePreference } from '../infrastructure/PreferencesService';

export type TrackingKind = 'positions' | 'diagnoses' | 'diagnosis_queue';

export type TrackingRead<T> =
    | { ok: true; value: T; skipped: number }
    | { ok: false; error: string };

export type TrackingWrite =
    | { ok: true }
    | { ok: false; error: string };

const storeKey = (kind: TrackingKind, username: string): string =>
    `tracked_${kind}_v1_${username}`;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Per-key write chains. The storeBackend and SQLite writes are
 *  read-modify-write; two overlapping saves would otherwise lose one. */
const writeChains = new Map<string, Promise<unknown>>();
const withKeyLock = <T>(key: string, body: () => Promise<T>): Promise<T> => {
    const previous = writeChains.get(key) ?? Promise.resolve();
    const next = previous.then(body, body);
    writeChains.set(key, next.then(() => undefined, () => undefined));
    return next;
};

const nativeRead = async (
    kind: TrackingKind,
    username: string,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> => {
    const db = await getSqliteDb();
    if (!db) return { ok: false, error: 'SQLite is not initialized' };
    try {
        const result = await db.query(
            'SELECT payload FROM tracking_store WHERE username = ? AND kind = ?',
            [username, kind],
        );
        const payload = result.values?.[0]?.payload;
        if (typeof payload === 'string') return { ok: true, value: payload };
        // A backup restore writes through Preferences; adopt that copy once,
        // then SQLite is the one owner. Never let a stale Preferences copy
        // shadow a row SQLite already has.
        let legacy: string | null = null;
        try {
            legacy = await getPreference(storeKey(kind, username));
        } catch {
            legacy = null;
        }
        if (legacy === null) return { ok: true, value: null };
        await runExclusiveWrite(async () => {
            await db.run(
                'INSERT OR REPLACE INTO tracking_store (username, kind, payload, updatedAt) VALUES (?, ?, ?, ?)',
                [username, kind, legacy, new Date().toISOString()],
            );
        });
        return { ok: true, value: legacy };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
};

const nativeWrite = async (
    kind: TrackingKind,
    username: string,
    payload: string,
): Promise<TrackingWrite> => {
    const db = await getSqliteDb();
    if (!db) return { ok: false, error: 'SQLite is not initialized' };
    try {
        await runExclusiveWrite(async () => {
            await db.run(
                'INSERT OR REPLACE INTO tracking_store (username, kind, payload, updatedAt) VALUES (?, ?, ?, ?)',
                [username, kind, payload, new Date().toISOString()],
            );
        });
        const back = await nativeRead(kind, username);
        if (!back.ok) return { ok: false, error: back.error };
        if (back.value !== payload) {
            return { ok: false, error: 'the store write could not be read back' };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
};

const readRaw = async (
    kind: TrackingKind,
    username: string,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> => {
    if (isNativePlatform()) return nativeRead(kind, username);
    const res = await readStore(storeKey(kind, username));
    return res.ok ? { ok: true, value: res.value } : { ok: false, error: res.error };
};

const writeRaw = async (
    kind: TrackingKind,
    username: string,
    payload: string,
): Promise<TrackingWrite> => {
    if (isNativePlatform()) return nativeWrite(kind, username, payload);
    const wrote = await writeStore(storeKey(kind, username), payload);
    if (!wrote.ok) return { ok: false, error: wrote.error ?? 'store write failed' };
    const back = await readRaw(kind, username);
    if (!back.ok) return { ok: false, error: back.error };
    if (back.value !== payload) {
        return { ok: false, error: 'the store write could not be read back' };
    }
    return { ok: true };
};

const readArray = async <T>(
    kind: TrackingKind,
    username: string,
    parse: (raw: unknown) => T | null,
): Promise<TrackingRead<T[]>> => {
    const raw = await readRaw(kind, username);
    if (!raw.ok) return raw;
    if (raw.value === null) return { ok: true, value: [], skipped: 0 };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.value);
    } catch (e) {
        return { ok: false, error: `stored ${kind} is not JSON: ${errorText(e)}` };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, error: `stored ${kind} is not an array` };
    }
    const value: T[] = [];
    let skipped = 0;
    for (const item of parsed) {
        const valid = parse(item);
        if (valid === null) skipped += 1;
        else value.push(valid);
    }
    if (skipped > 0) {
        console.warn(`[positionStore] skipped ${skipped} unreadable ${kind} row(s)`);
    }
    return { ok: true, value, skipped };
};

const isTerminal = (p: TrackedPosition): boolean =>
    p.status === 'closed' || p.status === 'expired' || p.status === 'cancelled';

/** Keep every open/pending row, plus the newest N terminal rows. */
export const prunePositions = (positions: readonly TrackedPosition[]): TrackedPosition[] => {
    const byId = new Map<string, TrackedPosition>();
    for (const p of positions) byId.set(p.id, p);
    const all = [...byId.values()];
    const terminal = all
        .filter(isTerminal)
        .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
    const keep = new Set(terminal.slice(0, TRACKED_MAX_CLOSED_POSITIONS).map(p => p.id));
    return all.filter(p => !isTerminal(p) || keep.has(p.id));
};

export const readTrackedPositions = async (
    username: string,
): Promise<TrackingRead<TrackedPosition[]>> =>
    readArray('positions', username, parseTrackedPosition);

/** Direct bulk write. The service owns the in-memory list; this is the one
 *  writer it calls after a pass. */
export const writeTrackedPositions = async (
    username: string,
    positions: readonly TrackedPosition[],
): Promise<TrackingWrite> => {
    const key = storeKey('positions', username);
    return withKeyLock(key, async () =>
        writeRaw('positions', username, JSON.stringify(prunePositions(positions))),
    );
};

/** Read-modify-write one position. Refuses to write when the store cannot be
 *  read — an empty-looking load must not overwrite a corrupt file. */
export const saveTrackedPosition = async (
    username: string,
    position: TrackedPosition,
): Promise<TrackingWrite> => {
    const key = storeKey('positions', username);
    return withKeyLock(key, async () => {
        const read = await readTrackedPositions(username);
        if (!read.ok) return { ok: false as const, error: read.error };
        const next = read.value.filter(p => p.id !== position.id);
        next.push(position);
        return writeRaw('positions', username, JSON.stringify(prunePositions(next)));
    });
};

export const deleteTrackedPosition = async (
    username: string,
    positionId: string,
): Promise<TrackingWrite> => {
    const key = storeKey('positions', username);
    return withKeyLock(key, async () => {
        const read = await readTrackedPositions(username);
        if (!read.ok) return { ok: false as const, error: read.error };
        return writeRaw(
            'positions',
            username,
            JSON.stringify(prunePositions(read.value.filter(p => p.id !== positionId))),
        );
    });
};

export const readDiagnoses = async (
    username: string,
): Promise<TrackingRead<TrackedDiagnosis[]>> =>
    readArray('diagnoses', username, parseTrackedDiagnosis);

export const saveDiagnosis = async (
    username: string,
    diagnosis: TrackedDiagnosis,
): Promise<TrackingWrite> => {
    const key = storeKey('diagnoses', username);
    return withKeyLock(key, async () => {
        const read = await readDiagnoses(username);
        if (!read.ok) return { ok: false as const, error: read.error };
        const next = read.value.filter(d => d.id !== diagnosis.id);
        next.push(diagnosis);
        // The diagnosis is the audit record; it is never count-pruned. It is
        // small (prose, not a price path), and the skill provenance points here.
        return writeRaw('diagnoses', username, JSON.stringify(next));
    });
};

const parseQueueItem = (raw: unknown): DiagnosisQueueItem | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Partial<DiagnosisQueueItem>;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (typeof item.tradeId !== 'string' || !item.tradeId) return null;
    if (typeof item.queuedAt !== 'number' || !Number.isFinite(item.queuedAt)) return null;
    if (item.status !== 'pending' && item.status !== 'running'
        && item.status !== 'done' && item.status !== 'failed') return null;
    return {
        id: item.id,
        tradeId: item.tradeId,
        ...(item.source === 'journal' || item.source === 'signal' ? { source: item.source } : {}),
        queuedAt: item.queuedAt,
        attempts: typeof item.attempts === 'number' && Number.isFinite(item.attempts) ? item.attempts : 0,
        status: item.status,
        ...(typeof item.lastError === 'string' ? { lastError: item.lastError } : {}),
        ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
        ...(typeof item.finishedAt === 'number' ? { finishedAt: item.finishedAt } : {}),
    };
};

export const readDiagnosisQueue = async (
    username: string,
): Promise<TrackingRead<DiagnosisQueueItem[]>> =>
    readArray('diagnosis_queue', username, parseQueueItem);

/** The queue is intentionally not pruned: a pending diagnosis is a debt. */
export const writeDiagnosisQueue = async (
    username: string,
    queue: readonly DiagnosisQueueItem[],
): Promise<TrackingWrite> => {
    const key = storeKey('diagnosis_queue', username);
    return withKeyLock(key, async () =>
        writeRaw('diagnosis_queue', username, JSON.stringify([...queue])),
    );
};

export interface TrackingSnapshot {
    positions: string | null;
    diagnoses: string | null;
    diagnosis_queue: string | null;
}

/** The raw documents, read through the SAME backend the tracker uses. The
 *  backup must not read `storeBackend` directly: on native the live store is
 *  SQLite, and a `readStore` there would export an empty localStorage copy. */
export const readTrackingSnapshot = async (
    username: string,
): Promise<{ ok: true; snapshot: TrackingSnapshot } | { ok: false; error: string }> => {
    const positions = await readRaw('positions', username);
    if (!positions.ok) return positions;
    const diagnoses = await readRaw('diagnoses', username);
    if (!diagnoses.ok) return diagnoses;
    const queue = await readRaw('diagnosis_queue', username);
    if (!queue.ok) return queue;
    return {
        ok: true,
        snapshot: {
            positions: positions.value,
            diagnoses: diagnoses.value,
            diagnosis_queue: queue.value,
        },
    };
};

/** Test-only: wipe this user's tracker namespace on the active backend. */
export const __clearTrackingForTests = async (username: string): Promise<void> => {
    for (const kind of ['positions', 'diagnoses', 'diagnosis_queue'] as const) {
        if (isNativePlatform()) {
            const db = await getSqliteDb();
            if (db) {
                try {
                    await runExclusiveWrite(async () => {
                        await db.run('DELETE FROM tracking_store WHERE username = ? AND kind = ?', [username, kind]);
                    });
                } catch { /* best effort */ }
            }
            try { await removePreference(storeKey(kind, username)); } catch { /* best effort */ }
        } else {
            await removeStore(storeKey(kind, username));
        }
    }
};
