/**
 * SqliteServiceHelpers
 *
 * Exposes the internal SQLite db connection for use by other infrastructure
 * services without circular dependencies.
 *
 * The db connection is managed by SqliteService.ts via initSqlite().
 */

import { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { isNativePlatform } from './SqliteService';

// This is set by SqliteService when it initializes the connection.
// We use a module-level variable that both modules can access.
let dbConnection: SQLiteDBConnection | null = null;

/**
 * Set the db connection (called by SqliteService.initSqlite)
 */
export const setSqliteDb = (db: SQLiteDBConnection | null): void => {
    dbConnection = db;
};

/**
 * Get the current SQLite db connection.
 * Returns null if not on native platform or not yet initialized.
 */
export const getSqliteDb = async (): Promise<SQLiteDBConnection | null> => {
    if (!isNativePlatform()) return null;
    return dbConnection;
};

// ─── Write serialization ─────────────────────────────────────────────────────
// The shared SQLite connection cannot nest BEGIN TRANSACTION. Overlapping
// writes (data debounce, settings debounce, 15s heartbeat, unload flush, and
// thinking-record batches) used to hit "cannot start a transaction within a
// transaction", and one flow's ROLLBACK then rolled back the OTHER flow's
// uncommitted writes. Every transactional writer funnels through this single
// promise chain so at most one transaction is open at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Capability proving "this async flow already holds the write queue".
 * runExclusiveWrite issues one to the body it runs; a NESTED
 * runExclusiveWrite that receives it runs its body immediately instead of
 * queueing it — the deadlock-free re-entry.
 *
 * Why this is threaded explicitly rather than detected: the queue is a plain
 * promise chain with no ambient async context (no AsyncLocalStorage in the
 * browser/WebView), and "the queue is busy" is NOT the same question — while
 * flow A's body is suspended at an await, flow B may call in and would be
 * told it is A. A global "is the lock held" flag therefore lets two unrelated
 * flows run concurrently, which is exactly the overlap this mutex exists to
 * prevent. The permit only exists inside a runExclusiveWrite body, so
 * composing a nested writer is a deliberate, type-checked act, and a
 * forgotten permit fails as a deadlocked test rather than as silent
 * corruption in production.
 */
export interface WritePermit {
    /** Structural marker — always true; present so the type is inhabited. */
    readonly held: true;
}

const issuePermit = (): WritePermit => ({ held: true });

/**
 * Run a write while holding the serialized write queue.
 * The queue survives failures — one rejected write never blocks later ones.
 *
 * Pass the `permit` this call was given to a nested writer (one that opens
 * its own transaction on the same shared connection) to re-enter without
 * deadlocking; see {@link WritePermit}.
 */
export const runExclusiveWrite = <T>(
    write: (permit: WritePermit) => Promise<T>,
    permit?: WritePermit,
): Promise<T> => {
    // Re-entry from a flow that already holds the queue: run inline. The
    // holder is by definition the only writer, so this preserves mutual
    // exclusion instead of queueing behind our own unresolved promise.
    if (permit) return Promise.resolve().then(() => write(permit));
    const result = writeQueue.then(() => write(issuePermit()), () => write(issuePermit()));
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
};
