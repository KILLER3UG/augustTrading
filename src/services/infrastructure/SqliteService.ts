/**
 * SqliteService.ts
 * 
 * Native SQLite storage service for reliable Android data persistence.
 * Falls back to IndexedDB on web for development.
 * 
 * Uses @capacitor-community/sqlite which maps to native SQLite on Android/iOS.
 * This ensures data survives cache clears and is never deleted by the OS.
 */

import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { LoggedTrade, UserProfile, Conversation, TradeSummary, GlobalMemory, UserSettings, Message } from '../../types';
import { setSqliteDb, runExclusiveWrite, WritePermit } from './SqliteServiceHelpers';
import { LEGACY_LEVERAGE } from '../../utils/conversationUtils';
import { parsePrice } from '../../utils/analysisUtils';
import { withTradeSource } from '../../utils/tradeSource';

/**
 * Parse a stored JSON blob defensively. A single corrupt cell (e.g. from an
 * interrupted native write) must not abort the entire profile load — the row
 * is skipped with a warning instead of throwing (which previously also broke
 * every subsequent save, since saves read the profile first).
 * Returns `any` to mirror the original `JSON.parse(...)` inference at the
 * call sites (fallbacks of `{}`/`[]`/`undefined` would otherwise narrow the
 * generic and break LoggedTrade/Conversation assignability).
 */
const safeParseJson = (json: string | null | undefined, fallback: any): any => {
    if (!json) return fallback;
    try {
        return JSON.parse(json);
    } catch (e) {
        console.warn('[SqliteService] Corrupt JSON row skipped:', e instanceof Error ? e.message : e);
        return fallback;
    }
};

// Database configuration
const DB_NAME = 'futuresai_db';
/**
 * VERSION PASSED TO createConnection — NOT this app's schema version.
 *
 * The real schema is versioned by the `schema_migrations` table below, which
 * currently gates through v8 (the v8 pass dropped the deleted thinking_records
 * table). This number is only the version the SQLite plugin records
 * on the connection it opens; bumping it does NOT migrate anything and must
 * NOT be "fixed" to 7 — the plugin treats a version change on an EXISTING
 * database as an upgrade request and runs its own upgrade path, which knows
 * nothing about our ALTER TABLE migration list. Schema changes belong in
 * schema_migrations (add a new runMigrations block there).
 */
const PLUGIN_CONNECTION_VERSION = 5;

// SQLite connection singleton
let sqliteConnection: SQLiteConnection | null = null;
let db: SQLiteDBConnection | null = null;
let isInitialized = false;

// Per-user fingerprints of the last persisted profile sections (see
// sqliteSaveUserProfile) so no-op saves skip the per-row native writes.
// Published ONLY after a successful COMMIT — staged updates live in a
// transaction-local map — so a rolled-back save can never leave fingerprints
// for rows that never actually persisted (a later save would skip the
// dirty-section gate and silently lose that section forever).
interface SectionFingerprints {
    trades?: string;
    conversations?: string;
    tradeSummaries?: string;
}

const lastSavedSections = new Map<string, SectionFingerprints>();

/**
 * Check if running on native platform (Android/iOS)
 */
export const isNativePlatform = (): boolean => {
    return Capacitor.isNativePlatform();
};

/**
 * Initialize SQLite database
 * Creates tables if they don't exist
 */
export const initSqlite = async (): Promise<boolean> => {
    if (isInitialized) return true;

    if (!isNativePlatform()) {
        console.log('[SqliteService] Running on web - SQLite not available, using IndexedDB fallback');
        return false;
    }

    try {
        console.log('[SqliteService] Initializing SQLite database...');

        // Create SQLite connection
        sqliteConnection = new SQLiteConnection(CapacitorSQLite);

        // Check connection consistency
        const retCC = (await sqliteConnection.checkConnectionsConsistency()).result;
        const isConn = (await sqliteConnection.isConnection(DB_NAME, false)).result;

        if (retCC && isConn) {
            db = await sqliteConnection.retrieveConnection(DB_NAME, false);
        } else {
            db = await sqliteConnection.createConnection(
                DB_NAME,
                false,
                'no-encryption',
                PLUGIN_CONNECTION_VERSION,
                false
            );
        }

        await db.open();

        // Expose the connection to other infrastructure services
        setSqliteDb(db);

        // Create tables
        await createTables();

        isInitialized = true;
        console.log('[SqliteService] SQLite initialized successfully');
        return true;
    } catch (error) {
        console.error('[SqliteService] Failed to initialize SQLite:', error);
        return false;
    }
};

/**
 * Create database tables
 */
const createTables = async (): Promise<void> => {
    if (!db) throw new Error('Database not initialized');

    // Users table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            createdAt TEXT,
            updatedAt TEXT,
            globalMemory TEXT,
            settings TEXT,
            finalTradeSummary TEXT,
            learningRules TEXT,
            lastActiveConversationId TEXT
        );
    `);

    // Trades table - indexed for fast queries
    await db.execute(`
        CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            timestamp TEXT,
            outcome TEXT,
            coinName TEXT,
            direction TEXT,
            entry REAL,
            stopLoss REAL,
            takeProfit TEXT,
            pnlAmount REAL,
            investmentAmount REAL,
            leverage REAL,
            analysis TEXT,
            postMortem TEXT,
            confidenceVsActual TEXT,
            slOptimizationData TEXT,
            tradeType TEXT,
            meta TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_trades_username ON trades(username);
        CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
        CREATE INDEX IF NOT EXISTS idx_trades_outcome ON trades(outcome);
    `);

    // Conversations table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT,
            createdAt TEXT,
            messages TEXT,
            settings TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username);
    `);

    // Trade summaries table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS trade_summaries (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            summaryText TEXT,
            timestamp TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_summaries_username ON trade_summaries(username);
    `);

    // Saved analyses table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS saved_analyses (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            analysis TEXT,
            userPrompt TEXT,
            timestamp TEXT,
            meta TEXT
        );
    `);
    // Every read of this table filters by username, and it was the only one
    // without the index its siblings got — so it was full-scanning on each
    // open. IF NOT EXISTS means this also lands for pre-existing installs.
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_saved_analyses_username ON saved_analyses(username);
    `);

    // (The thinking_records table is gone with the reasoning corpus it held.
    // The v8 migration below drops it from installs that still carry one.)

    // The tracked-position store. A dedicated table, NOT a column on
    // `users`: a position carries a capped path/context timeline that must
    // not be rewritten by every profile save. `kind` names the document
    // (`positions`, `diagnoses`, `diagnosis_queue`), one JSON payload each.
    // CREATE IF NOT EXISTS runs on every open, so existing installs get the
    // table without an ALTER migration.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS tracking_store (
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            updatedAt TEXT,
            PRIMARY KEY (username, kind)
        );
    `);

    // Schema migration tracking — must exist before the gated blocks below.
    // Records which ALTER migrations have already been applied so the blocks
    // run once per install instead of on every startup.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);

    const migrationResult = await db.query('SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations');
    const appliedVersion = migrationResult.values?.[0]?.v || 0;

    // Record a migration as applied. Called even when the ALTER was a
    // no-op duplicate — pre-migration installs already carry the columns.
    const recordMigration = async (version: number): Promise<void> => {
        await db!.run(
            'INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
            [version, new Date().toISOString()]
        );
    };

    // ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, so "duplicate
    // column" failures are expected on re-runs — anything else is a real
    // failure.
    const isDuplicateColumnError = (e: unknown): boolean =>
        e instanceof Error && /duplicate column/i.test(e.message);

    // Run a version's migration statements and record the version ONLY when
    // every statement applied (duplicate columns count as applied — the
    // column already exists). Previously recordMigration ran unconditionally,
    // so a REAL failure (disk full, constraint) marked the migration done,
    // the column was never added, and every later query against it failed —
    // with no retry ever.
    const runMigrations = async (version: number, statements: { label: string; sql: string }[]): Promise<void> => {
        let allApplied = true;
        for (const { label, sql } of statements) {
            try {
                await db!.execute(sql);
            } catch (e) {
                if (isDuplicateColumnError(e)) continue; // already present — effectively applied
                allApplied = false;
                console.warn(`[SqliteService] Migration "${label}" failed:`, e);
            }
        }
        if (allApplied) await recordMigration(version);
    };

    // VERSION 2 MIGRATION: Add userPrompt if missing
    if (appliedVersion < 2) {
        await runMigrations(2, [
            { label: 'v2 saved_analyses.userPrompt', sql: 'ALTER TABLE saved_analyses ADD COLUMN userPrompt TEXT;' },
        ]);
    }

    // VERSION 3 MIGRATION: Add settings to conversations and meta to trades
    if (appliedVersion < 3) {
        await runMigrations(3, [
            { label: 'v3 conversations.settings', sql: 'ALTER TABLE conversations ADD COLUMN settings TEXT;' },
            { label: 'v3 trades.meta', sql: 'ALTER TABLE trades ADD COLUMN meta TEXT;' },
        ]);
    }

    // VERSION 4 MIGRATION: Add lastActiveConversationId to users and meta to saved_analyses
    if (appliedVersion < 4) {
        await runMigrations(4, [
            { label: 'v4 users.lastActiveConversationId', sql: 'ALTER TABLE users ADD COLUMN lastActiveConversationId TEXT;' },
            { label: 'v4 saved_analyses.meta', sql: 'ALTER TABLE saved_analyses ADD COLUMN meta TEXT;' },
        ]);
    }

    // VERSION 8 MIGRATION: Drop the deleted reasoning-corpus table. Its
    // v5/v6/v7 ALTER passes are retired from the ladder — the table itself is
    // being removed, so re-adding its columns on an install that never ran
    // them would recreate a table nothing reads. IF EXISTS makes this a
    // no-op on installs that never got the table; the table's indexes are
    // dropped with it (SQLite drops index owned by a table with the table).
    if (appliedVersion < 8) {
        await runMigrations(8, [
            { label: 'v8 drop thinking_records', sql: 'DROP TABLE IF EXISTS thinking_records;' },
        ]);
    }

    console.log('[SqliteService] Tables created successfully');
};

// ============================================================================
// USER OPERATIONS
// ============================================================================

/**
 * Get all usernames
 */
export const sqliteGetAllUsernames = async (): Promise<string[]> => {
    if (!db) return [];

    const result = await db.query('SELECT username FROM users');
    return result.values?.map(row => row.username) || [];
};

/**
 * Get user profile
 */
export const sqliteGetUserProfile = async (username: string): Promise<UserProfile | null> => {
    if (!db) return null;

    // Get user data
    const userResult = await db.query(
        'SELECT * FROM users WHERE username = ?',
        [username]
    );

    if (!userResult.values || userResult.values.length === 0) {
        return null;
    }

    const userData = userResult.values[0];

    // Get trades
    const tradesResult = await db.query(
        'SELECT * FROM trades WHERE username = ? ORDER BY timestamp DESC',
        [username]
    );
    const trades: LoggedTrade[] = (tradesResult.values || []).map(row => {
        const meta = safeParseJson(row.meta, {});
        // Ensure tradeType is restored cleanly if missing
        const tradeType = row.tradeType || meta.tradeType || undefined;

        return withTradeSource({
            id: row.id,
            timestamp: row.timestamp,
            outcome: row.outcome,
            analysis: safeParseJson(row.analysis, undefined),
            postMortem: row.postMortem,
            pnlAmount: row.pnlAmount,
            investmentAmount: row.investmentAmount,
            leverage: row.leverage,
            slOptimizationData: safeParseJson(row.slOptimizationData, undefined),
            tradeType,
            ...meta // Spread metadata to restore extended fields
        });
    });

    // Get conversations
    const convResult = await db.query(
        'SELECT * FROM conversations WHERE username = ? ORDER BY createdAt DESC',
        [username]
    );
    const conversations: Conversation[] = (convResult.values || []).map(row => {
        const settings = safeParseJson(row.settings, {});

        return {
            id: row.id,
            title: row.title,
            timestamp: new Date(row.createdAt).getTime(),
            messages: safeParseJson(row.messages, []),
            // Defaults for current Conversation fields; saved settings override.
            ocrModel: '',
            moderatorProviderId: settings.moderatorProvider || '', // legacy column name compat
            moderatorModel: '',
            leverage: LEGACY_LEVERAGE,
            ...settings // Override defaults with saved settings
        } as Conversation;

    });

    // Get trade summaries
    const summariesResult = await db.query(
        'SELECT * FROM trade_summaries WHERE username = ?',
        [username]
    );
    const tradeSummaries: TradeSummary[] = (summariesResult.values || []).map(row => ({
        id: row.id,
        summaryText: row.summaryText,
        timestamp: row.timestamp
    }));


    return {
        username: userData.username,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        globalMemory: safeParseJson(userData.globalMemory, undefined),
        settings: safeParseJson(userData.settings, { activeFrameworks: [] }),
        finalTradeSummary: userData.finalTradeSummary,
        learningRules: safeParseJson(userData.learningRules, undefined),
        lastActiveConversationId: userData.lastActiveConversationId, // Restore state
        tradeLog: trades,
        conversations,
        tradeSummaries
    };
};

/**
 * Save user profile (upsert)
 */
const serializeConversationMessages = (messages: Message[]): string => JSON.stringify(messages);

/**
 * Delete rows of a collection that are absent from the profile being saved.
 * INSERT OR REPLACE can't remove rows; without this, deletions never
 * propagate to SQLite (stale snapshots and imports resurrected deleted rows).
 * The stale set is computed in JS (existing ids for this user minus the ids
 * present in the profile) and deleted with chunked `id IN (...)` statements:
 * SQLite's default variable limit is 999, and large profiles (1000+ trades)
 * would otherwise throw "too many SQL variables" inside the caller's
 * transaction, rolling back the whole save. Chunking the DELETE IN list by
 * ids-to-remove (rather than the old NOT IN present-ids chunks) is also what
 * makes it CORRECT: a NOT IN delete chunked over present ids treats each
 * 400-id chunk as the entire retained set and destroys every other chunk's
 * rows whenever the collection exceeds one chunk.
 */
const deleteAbsentRows = async (
    table: string,
    username: string,
    presentIds: string[]
): Promise<void> => {
    if (!db) return;
    if (presentIds.length === 0) {
        await db.run(`DELETE FROM ${table} WHERE username = ?`, [username]);
        return;
    }
    const existing = await db.query(
        `SELECT id FROM ${table} WHERE username = ?`,
        [username]
    );
    const present = new Set(presentIds);
    const staleIds = (existing.values || [])
        .map(row => row.id as string)
        .filter(id => !present.has(id));
    if (staleIds.length === 0) return;
    const CHUNK_SIZE = 400;
    for (let i = 0; i < staleIds.length; i += CHUNK_SIZE) {
        const chunk = staleIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        await db.run(
            `DELETE FROM ${table} WHERE username = ? AND id IN (${placeholders})`,
            [username, ...chunk]
        );
    }
};

/**
 * Save a user profile (upsert). ALWAYS takes the write mutex itself — the
 * BEGIN below cannot nest on the shared connection, so correctness used to
 * depend on every caller remembering to wrap the call. Callers that already
 * hold the mutex (dbService's read-modify-write, the IndexedDB migration)
 * pass the `permit` they were issued, which re-enters inline instead of
 * deadlocking on the queue they are themselves holding.
 */
export const sqliteSaveUserProfile = (
    profile: UserProfile,
    permit?: WritePermit,
): Promise<void> => runExclusiveWrite(
    () => saveUserProfileUnlocked(profile),
    permit,
);

/**
 * The body of {@link sqliteSaveUserProfile}. MUST be called with the write
 * mutex held — use the wrapper above, or pass the holder's permit.
 */
const saveUserProfileUnlocked = async (profile: UserProfile): Promise<void> => {
    if (!db) throw new Error('Database not initialized');

    const now = new Date().toISOString();

    // Wrap all writes in a single transaction for performance.
    // Without this, each INSERT is a separate native-bridge round trip
    // (100 trades + 20 conversations = 120+ sequential awaits).
    // The wrapper above holds the write mutex for the whole transaction, so
    // BEGIN can no longer collide with another open transaction on this
    // connection.
    await db.execute('BEGIN TRANSACTION');
    let transactionOpen = true;
    try {
        // Upsert user
        await db.run(`
            INSERT OR REPLACE INTO users (
                username, createdAt, updatedAt, globalMemory, settings,
                finalTradeSummary, learningRules, lastActiveConversationId
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            profile.username,
            profile.createdAt || now,
            now,
            profile.globalMemory ? JSON.stringify(profile.globalMemory) : null,
            JSON.stringify(profile.settings),
            profile.finalTradeSummary,
            profile.learningRules ? JSON.stringify(profile.learningRules) : null,
            profile.lastActiveConversationId
        ]);

        // ─── Dirty-section skipping ───────────────────────────────────────
        // The 15s heartbeat re-saves the FULL profile during every run even
        // when only the streaming message changed. Comparing each section's
        // JSON locally (cheap) and skipping its per-row native-bridge writes
        // when unchanged turns a 120+ await save into a single users-row
        // update for no-op saves. JSON round-trips are deterministic, so the
        // re-parsed existing profile stringifies identically.
        const key = profile.username;
        const prev = lastSavedSections.get(key) ?? {};
        // Fingerprints are staged here and published into lastSavedSections
        // only after COMMIT succeeds — the DB writes below roll back with the
        // transaction, and the Map must roll back with them.
        const staged: SectionFingerprints = { ...prev };

        const tradesJson = JSON.stringify(profile.tradeLog || []);
        if (prev.trades !== tradesJson) {
            // Sync trades
            for (const trade of profile.tradeLog || []) {
                await sqliteSaveTrade(profile.username, trade);
            }
            // INSERT OR REPLACE only upserts — rows deleted from the profile
            // (deleted trades, imported-over data) must be removed explicitly,
            // or they'd resurrect on the next full load (and web/native would
            // diverge: IndexedDB replaces the whole record, SQLite did not).
            await deleteAbsentRows(
                'trades',
                profile.username,
                (profile.tradeLog || []).map(t => t.id)
            );
            staged.trades = tradesJson;
        }

        const conversationsJson = JSON.stringify(profile.conversations || []);
        if (prev.conversations !== conversationsJson) {
            // Sync conversations
            for (const conv of profile.conversations || []) {
                // Extract settings (everything that is not a core column)
                const { id, title, timestamp, messages, ...settings } = conv;

                // A missing/corrupt timestamp used to throw RangeError here
                // and roll back the ENTIRE profile save (trades included) —
                // fall back to now instead of aborting.
                let createdAt: string;
                try {
                    const t = new Date(timestamp);
                    createdAt = isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
                } catch {
                    createdAt = new Date().toISOString();
                }

                await db.run(`
                    INSERT OR REPLACE INTO conversations (id, username, title, createdAt, messages, settings)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    conv.id,
                    profile.username,
                    conv.title,
                    createdAt,
                     serializeConversationMessages(conv.messages),
                    JSON.stringify(settings) // Save extended flags and models
                ]);
            }
            await deleteAbsentRows(
                'conversations',
                profile.username,
                (profile.conversations || []).map(c => c.id)
            );
            staged.conversations = conversationsJson;
        }

        const summariesJson = JSON.stringify(profile.tradeSummaries || []);
        if (prev.tradeSummaries !== summariesJson) {
            // Sync trade summaries
            for (const summary of profile.tradeSummaries || []) {
                await db.run(`
                    INSERT OR REPLACE INTO trade_summaries (id, username, summaryText, timestamp)
                    VALUES (?, ?, ?, ?)
                `, [summary.id, profile.username, summary.summaryText, summary.timestamp]);
            }
            await deleteAbsentRows(
                'trade_summaries',
                profile.username,
                (profile.tradeSummaries || []).map(s => s.id)
            );
            staged.tradeSummaries = summariesJson;
        }


        await db.execute('COMMIT');
        transactionOpen = false;
        // The transaction is durable — now (and only now) publish the
        // fingerprints of the sections written inside it.
        lastSavedSections.set(key, staged);
    } catch (error) {
        // Only roll back when we own an open transaction — a failed BEGIN or
        // an already-rolled-back transaction would make this ROLLBACK throw
        // and mask the original error.
        if (transactionOpen) {
            try {
                await db.execute('ROLLBACK');
            } catch (rollbackError) {
                console.error('[SqliteService] ROLLBACK failed:', rollbackError);
            }
        }
        // lastSavedSections is deliberately NOT updated here — not even when
        // the ROLLBACK itself threw: the rows never persisted, so the previous
        // fingerprints remain the truth and the next save rewrites them.
        console.error('[SqliteService] Save failed, transaction rolled back:', error);
        throw error;
    }
};

// ============================================================================
// TRADE OPERATIONS
// ============================================================================

/**
 * Save a single trade
 */
export const sqliteSaveTrade = async (username: string, trade: LoggedTrade): Promise<void> => {
    if (!db) throw new Error('Database not initialized');

    // Use the canonical parsePrice — the naive digit-strip regex turned
    // annotated AI prices like "94500 4h" into 945004, corrupting the
    // stored entry/stopLoss columns used by backtests and range filters.
    const entry = trade.analysis?.entryPoints?.[0]?.price
        ? (parsePrice(trade.analysis.entryPoints[0].price) || null)
        : null;
    const stopLoss = trade.analysis?.stopLoss
        ? (parsePrice(trade.analysis.stopLoss) || null)
        : null;

    // Extract meta fields (everything not in the core columns)
    const {
        id, timestamp, outcome, analysis, postMortem,
        pnlAmount, investmentAmount, leverage, slOptimizationData, tradeType,
        ...meta
    } = trade;

    await db.run(`
        INSERT OR REPLACE INTO trades (
            id, username, timestamp, outcome, coinName, direction,
            entry, stopLoss, takeProfit, pnlAmount, investmentAmount,
            leverage, analysis, postMortem, slOptimizationData, tradeType, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        trade.id,
        username,
        trade.timestamp,
        trade.outcome,
        trade.analysis?.coinName || null,
        trade.analysis?.direction || null,
        entry,
        stopLoss,
        trade.analysis?.takeProfit ? JSON.stringify(trade.analysis.takeProfit) : null,
        trade.pnlAmount,
        trade.investmentAmount,
        trade.leverage,
        trade.analysis ? JSON.stringify(trade.analysis) : null,
        trade.postMortem,
        trade.slOptimizationData ? JSON.stringify(trade.slOptimizationData) : null,
        trade.tradeType,
        JSON.stringify(meta) // Save extended fields like thought processes, models used, etc.
    ]);
};

/**
 * Get trades for a user
 */
export const sqliteGetTrades = async (username: string): Promise<LoggedTrade[]> => {
    if (!db) return [];

    const result = await db.query(
        'SELECT * FROM trades WHERE username = ? ORDER BY timestamp DESC',
        [username]
    );

    return (result.values || []).map(row => {
        const meta = safeParseJson(row.meta, {});
        // Ensure tradeType is restored cleanly if missing
        const tradeType = row.tradeType || meta.tradeType || undefined;

        return {
            id: row.id,
            timestamp: row.timestamp,
            outcome: row.outcome,
            analysis: safeParseJson(row.analysis, undefined),
            postMortem: row.postMortem,
            pnlAmount: row.pnlAmount,
            investmentAmount: row.investmentAmount,
            leverage: row.leverage,
            slOptimizationData: safeParseJson(row.slOptimizationData, undefined),
            tradeType,
            ...meta // Restore extended fields
        };
    });
};

/**
 * Delete a trade
 */
export const sqliteDeleteTrade = async (tradeId: string): Promise<void> => {
    if (!db) return;
    await db.run('DELETE FROM trades WHERE id = ?', [tradeId]);
};

/**
 * Delete a user and all associated data across all tables
 */
/**
 * Delete a user and all associated data across all tables.
 * Serialized through the write mutex and wrapped in one transaction: an
 * in-flight save (heartbeat/debounce/unload) reading the profile, then
 * re-inserting it after these DELETEs, would resurrect the deleted user.
 */
export const sqliteDeleteUser = async (username: string): Promise<void> => {
    if (!db) return;
    // A deleted profile must not leave stale fingerprints behind — otherwise
    // recreating the user could skip section writes based on pre-delete state.
    lastSavedSections.delete(username);
    // Narrow the module-level connection inside the closure (it's mutable).
    const connection = db;
    await runExclusiveWrite(async () => {
        await connection.execute('BEGIN TRANSACTION');
        let transactionOpen = true;
        try {
            await connection.run('DELETE FROM trades WHERE username = ?', [username]);
            await connection.run('DELETE FROM conversations WHERE username = ?', [username]);
            await connection.run('DELETE FROM trade_summaries WHERE username = ?', [username]);
            await connection.run('DELETE FROM saved_analyses WHERE username = ?', [username]);
            await connection.run('DELETE FROM tracking_store WHERE username = ?', [username]);
            await connection.run('DELETE FROM users WHERE username = ?', [username]);
            await connection.execute('COMMIT');
            transactionOpen = false;
        } catch (error) {
            if (transactionOpen) {
                try {
                    await connection.execute('ROLLBACK');
                } catch (rollbackError) {
                    console.error('[SqliteService] Delete ROLLBACK failed:', rollbackError);
                }
            }
            throw error;
        }
    });
};

/**
 * Get trade count for a user
 */
export const sqliteGetTradeCount = async (username: string): Promise<number> => {
    if (!db) return 0;
    const result = await db.query(
        'SELECT COUNT(*) as count FROM trades WHERE username = ?',
        [username]
    );
    return result.values?.[0]?.count || 0;
};

// ============================================================================
// GRANULAR READ API — lazy-load individual entities instead of full profile
// ============================================================================

/**
 * Get a single trade by ID
 */
export const sqliteGetTrade = async (tradeId: string): Promise<LoggedTrade | null> => {
    if (!db) return null;
    const result = await db.query('SELECT * FROM trades WHERE id = ?', [tradeId]);
    if (!result.values || result.values.length === 0) return null;

    const row = result.values[0];
    const meta = safeParseJson(row.meta, {});
    const tradeType = row.tradeType || meta.tradeType || undefined;

    return {
        id: row.id,
        timestamp: row.timestamp,
        outcome: row.outcome,
        analysis: safeParseJson(row.analysis, undefined),
        postMortem: row.postMortem,
        pnlAmount: row.pnlAmount,
        investmentAmount: row.investmentAmount,
        leverage: row.leverage,
        slOptimizationData: safeParseJson(row.slOptimizationData, undefined),
        tradeType,
        ...meta
    };
};

/**
 * List conversations with pagination (newest first)
 */
export const sqliteListConversations = async (
    username: string,
    options?: { limit?: number; before?: number }
): Promise<Conversation[]> => {
    if (!db) return [];

    const limit = options?.limit || 20;
    let query = 'SELECT * FROM conversations WHERE username = ?';
    const params: any[] = [username];

    if (options?.before) {
        query += ' AND createdAt < ?';
        params.push(new Date(options.before).toISOString());
    }

    query += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(limit);

    const result = await db.query(query, params);
    return (result.values || []).map(row => {
        const settings = safeParseJson(row.settings, {});
        return {
            id: row.id,
            title: row.title,
            timestamp: new Date(row.createdAt).getTime(),
            messages: safeParseJson(row.messages, []),
            ...settings,
            // The Conversation type declares these non-optional — rows saved
            // before the fields existed (or by the IndexedDB path) lack them,
            // and consumers dereference them directly.
            leverage: settings.leverage ?? LEGACY_LEVERAGE,
            ocrModel: settings.ocrModel ?? '',
            moderatorProviderId: settings.moderatorProviderId ?? '',
            moderatorModel: settings.moderatorModel ?? '',
        } as Conversation;
    });
};

/**
 * List trade summaries with pagination
 */
export const sqliteListSummaries = async (
    username: string,
    options?: { limit?: number }
): Promise<TradeSummary[]> => {
    if (!db) return [];

    const limit = options?.limit || 50;
    const result = await db.query(
        'SELECT * FROM trade_summaries WHERE username = ? ORDER BY timestamp DESC LIMIT ?',
        [username, limit]
    );
    return (result.values || []).map(row => ({
        id: row.id,
        summaryText: row.summaryText,
        timestamp: row.timestamp
    }));
};

// ============================================================================
// MIGRATION HELPER
// ============================================================================

/**
 * Migrate data from IndexedDB to SQLite
 * Called once on app upgrade
 */
export const migrateFromIndexedDB = async (
    getUserProfile: (username: string) => Promise<UserProfile | undefined>,
    getAllUsernames: () => Promise<string[]>
): Promise<{ migrated: boolean; userCount: number; tradeCount: number }> => {
    if (!isNativePlatform() || !isInitialized) {
        return { migrated: false, userCount: 0, tradeCount: 0 };
    }

    try {
        console.log('[SqliteService] Starting migration from IndexedDB...');

        const usernames = await getAllUsernames();
        let totalTrades = 0;

        for (const username of usernames) {
            // Check if already migrated
            const existingProfile = await sqliteGetUserProfile(username);
            if (existingProfile && existingProfile.tradeLog.length > 0) {
                console.log(`[SqliteService] User ${username} already migrated, skipping`);
                continue;
            }

            // Get from IndexedDB
            const profile = await getUserProfile(username);
            if (profile) {
                // sqliteSaveUserProfile takes the write mutex itself (the
                // BEGIN/COMMIT runs on the shared connection) — this call site
                // must NOT wrap it in a second runExclusiveWrite, which would
                // queue the save behind a lock the migration itself holds.
                await sqliteSaveUserProfile(profile);
                totalTrades += profile.tradeLog?.length || 0;
                console.log(`[SqliteService] Migrated user ${username} with ${profile.tradeLog?.length || 0} trades`);
            }

            // (The reasoning corpus's IndexedDB→SQLite pass is gone with
            // ThinkingStoreService — nothing owns that data any more; the
            // web-side initDatabase drops the dead database instead.)
        }

        console.log(`[SqliteService] Migration complete: ${usernames.length} users, ${totalTrades} trades`);
        return { migrated: true, userCount: usernames.length, tradeCount: totalTrades };
    } catch (error) {
        console.error('[SqliteService] Migration failed:', error);
        return { migrated: false, userCount: 0, tradeCount: 0 };
    }
};
