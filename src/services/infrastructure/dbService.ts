/**
 * dbService.ts
 * 
 * Unified database service that uses:
 * - SQLite on native platforms (Android/iOS) for reliable persistence
 * - IndexedDB on web for development/testing
 * 
 * Automatically migrates data from IndexedDB to SQLite on first native run.
 */

import { openDB, IDBPDatabase } from 'idb';
import { UserProfile } from '../../types';
import { Capacitor } from '@capacitor/core';
import {
  initSqlite,
  isNativePlatform,
  sqliteGetAllUsernames,
  sqliteGetUserProfile,
  sqliteSaveUserProfile,
  sqliteDeleteUser,
  migrateFromIndexedDB
} from './SqliteService';
import { putMessageImages, getConversationImages, deleteMessageImagesForConversations } from './messageImageStore';
import { runExclusiveWrite } from './SqliteServiceHelpers';
import {
  isSqliteMigrated,
  setSqliteMigrated,
  migrateLocalStorageToPreferences
} from './PreferencesService';

// IndexedDB configuration (fallback for web)
const DB_NAME = 'FuturesAI-DB';
const STORE_NAME = 'userProfiles';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;
let sqliteReady = false;
let dbReadyPromise: Promise<void> | null = null;
/** Fires once: the deleted reasoning corpus owned its own IndexedDB database
 *  ('FuturesAI-Thinking-DB'). Nothing reads it — drop it from every machine
 *  that still carries one. Deliberate best-effort; a refused delete is
 *  harmless because no open connection ever holds the database any more. */
let deadThinkingDbCleanup: Promise<void> | null = null;
const cleanupDeadThinkingDb = (): Promise<void> => {
  if (!deadThinkingDbCleanup) {
    deadThinkingDbCleanup = new Promise<void>((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(); return; }
      try {
        const req = indexedDB.deleteDatabase('FuturesAI-Thinking-DB');
        req.onsuccess = () => { console.log('[dbService] Removed the deleted thinking corpus database'); resolve(); };
        req.onerror = () => { console.warn('[dbService] Could not remove the deleted thinking corpus database'); resolve(); };
        req.onblocked = () => resolve(); // another tab holds it; not our problem
      } catch { resolve(); }
    });
  }
  return deadThinkingDbCleanup;
};

/**
 * Await database initialization and return whether SQLite is available.
 * Safe to call before or after initDatabase().
 */
const ensureDbReady = async (): Promise<boolean> => {
  if (!dbReadyPromise) {
    // Lazy-init: the app usually calls initDatabase() on startup, but a save
    // can beat it (debounce/heartbeat firing during the first tick). Without
    // this, that early write sees sqliteReady=false and lands in IndexedDB,
    // then gets orphaned once the SQLite migration runs. Trigger init here so
    // every caller waits for the real backend.
    await initDatabase();
  } else {
    await dbReadyPromise;
  }
  return sqliteReady;
};

/**
 * Initialize IndexedDB (web fallback)
 */
const initIndexedDB = () => {
  if (dbPromise) return dbPromise;
  void cleanupDeadThinkingDb();
  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'username' });
      }
    },
  }).catch(async (err: unknown) => {
    // Repair: an older WIP build had ThinkingStoreService (since deleted)
    // open this same database at a higher version, which makes a v1 request
    // fail with a VersionError. Open at the current version instead — the
    // userProfiles store is unaffected.
    if ((err as { name?: string })?.name === 'VersionError') {
      console.warn('[dbService] Database version conflict detected, opening at current version');
      dbPromise = null;
      return initIndexedDBRepair();
    }
    throw err;
  });
  return dbPromise;
};

/**
 * Fallback opener used only after a VersionError: opens the existing
 * database at its current (higher) version without an upgrade request.
 */
const initIndexedDBRepair = () => {
  if (dbPromise) return dbPromise;
  dbPromise = openDB(DB_NAME);
  return dbPromise;
};

/**
 * Initialize database - call this on app startup
 * On native: Initializes SQLite and migrates data if needed
 * On web: Uses IndexedDB
 */
export const initDatabase = async (): Promise<void> => {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      // Runs on every backend: the deleted reasoning corpus owned its own
      // IndexedDB database even on SQLite (native) machines.
      void cleanupDeadThinkingDb();
      if (isNativePlatform()) {
        console.log('[dbService] Native platform detected, initializing SQLite...');
        sqliteReady = await initSqlite();

        if (sqliteReady) {
          // Check if we need to migrate
          const alreadyMigrated = await isSqliteMigrated();

          if (!alreadyMigrated) {
            console.log('[dbService] Running one-time migration...');

            // Migrate localStorage to Preferences
            await migrateLocalStorageToPreferences();

            // Migrate IndexedDB to SQLite
            const migrationResult = await migrateFromIndexedDB(
              idbGetUserProfile,
              idbGetAllUsernames
            );

            // Only mark the migration as done when it actually succeeded —
            // migrateFromIndexedDB returns migrated:false on any error. Marking
            // it anyway meant a failed/partial migration was never retried and
            // the user's data was permanently lost on native.
            if (migrationResult.migrated) {
              await setSqliteMigrated();
              console.log('[dbService] Migration complete!');
            } else {
              console.error('[dbService] Migration FAILED — will retry on next launch');
            }
          }
        }
      } else {
        console.log('[dbService] Web platform, using IndexedDB');
        await initIndexedDB();
      }
    })()
      .catch((err: unknown) => {
        // Don't leave a permanently-rejected promise: a transient failure
        // (e.g. the SQLite plugin not ready during the very first tick)
        // would otherwise poison every later read/write. Reset so the next
        // access retries initialization.
        dbReadyPromise = null;
        throw err;
      });
  }
  return dbReadyPromise;
};

// ============================================================================
// IMAGE STRIPPING / REHYDRATION (messageImageStore integration)
// ============================================================================

/**
 * Move message chart images into the side store and return the profile
 * payload WITHOUT them — keeps the hot save path (debounce, heartbeat,
 * settings) free of multi-MB base64 serialization. Images are only stripped
 * for keys whose store write committed; a failure leaves them inline
 * (legacy persistence), so images are never dropped.
 */
async function stripMessageImages(data: UserProfile): Promise<UserProfile>;
async function stripMessageImages(
    data: Partial<Omit<UserProfile, 'username'>>
): Promise<Partial<Omit<UserProfile, 'username'>>>;
async function stripMessageImages(
    data: UserProfile | Partial<Omit<UserProfile, 'username'>>
): Promise<UserProfile | Partial<Omit<UserProfile, 'username'>>> {
    if (!Array.isArray(data.conversations) || data.conversations.length === 0) return data;

    let conversationsChanged = false;
    const conversations = await Promise.all(data.conversations.map(async conv => {
        if (!Array.isArray(conv.messages) || conv.messages.length === 0) return conv;
        let messagesChanged = false;
        const messages = await Promise.all(conv.messages.map(async msg => {
            if (!Array.isArray(msg.images) || msg.images.length === 0) return msg;
            const stored = await putMessageImages(conv.id, msg.id, msg.images);
            if (!stored) return msg; // keep inline — never drop images
            messagesChanged = true;
            const stripped = { ...msg };
            delete stripped.images;
            return stripped;
        }));
        if (!messagesChanged) return conv;
        conversationsChanged = true;
        return { ...conv, messages };
    }));

    if (!conversationsChanged) return data;
    return { ...data, conversations };
};

/**
 * Reattach side-store images to a freshly loaded profile. Messages that
 * still carry inline images (legacy profiles written before this change)
 * are left untouched.
 */
const rehydrateMessageImages = async (profile: UserProfile): Promise<void> => {
    if (!Array.isArray(profile.conversations)) return;
    for (const conv of profile.conversations) {
        if (!Array.isArray(conv.messages) || conv.messages.length === 0) continue;
        const stored = await getConversationImages(conv.id);
        if (Object.keys(stored).length === 0) continue;
        conv.messages = conv.messages.map(msg => {
            if (Array.isArray(msg.images) && msg.images.length > 0) return msg;
            const images = stored[msg.id];
            return images ? { ...msg, images } : msg;
        });
    }
};

// ============================================================================
// INDEXEDDB OPERATIONS (for web and migration source)
// ============================================================================

const idbGetAllUsernames = async (): Promise<string[]> => {
  const db = await initIndexedDB();
  const allKeys = await db.getAllKeys(STORE_NAME);
  return allKeys as string[];
};

const idbGetUserProfile = async (username: string): Promise<UserProfile | undefined> => {
  const db = await initIndexedDB();
  return db.get(STORE_NAME, username);
};

const idbSaveUserProfile = async (username: string, data: Partial<Omit<UserProfile, 'username'>>): Promise<void> => {
  // Serialize web writes through the same queue as the SQLite path — the
  // read-modify-write here is NOT atomic, and overlapping debounced saves
  // (data 1500ms + settings 2500ms + 15s heartbeat + unload flush) could
  // interleave and drop fields via stale snapshots.
  await runExclusiveWrite(async () => {
    const db = await initIndexedDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const existingProfile = await store.get(username) || {};

    const updatedProfile: UserProfile = {
      username,
      conversations: [],
      tradeLog: [],
      tradeSummaries: [],
      finalTradeSummary: null,
      settings: { activeFrameworks: [] },
      ...existingProfile,
      ...data,
      updatedAt: new Date().toISOString(),
    };

    if (!updatedProfile.createdAt) {
      updatedProfile.createdAt = new Date().toISOString();
    }

    await store.put(updatedProfile);
    await tx.done;
    // Conversation GC after the write committed (see gcRemovedConversation-
    // Images): the id diff needs the PREVIOUS stored list, read above.
    await gcRemovedConversationImages(
      existingProfile && typeof existingProfile === 'object' ? existingProfile as UserProfile : undefined,
      updatedProfile
    );
  });
};

const idbDeleteUserProfile = async (username: string): Promise<void> => {
  await runExclusiveWrite(async () => {
    const db = await initIndexedDB();
    await db.delete(STORE_NAME, username);
  });
};

// ============================================================================
// UNIFIED PUBLIC API - Routes to SQLite on native, IndexedDB on web
// ============================================================================

/**
 * Get all usernames
 */
export const getAllUsernames = async (): Promise<string[]> => {
  if (await ensureDbReady()) {
    return sqliteGetAllUsernames();
  }
  return idbGetAllUsernames();
};

/**
 * Get user profile
 */
export const getUserProfile = async (username: string): Promise<UserProfile | undefined> => {
  let profile: UserProfile | undefined;
  if (await ensureDbReady()) {
    const sqliteProfile = await sqliteGetUserProfile(username);
    profile = sqliteProfile || undefined;
  } else {
    profile = await idbGetUserProfile(username);
  }
  if (profile) {
    // Reattach side-store images so the UI (thumbnails, re-run) and
    // backups (which snapshot via getUserProfile) still see them.
    await rehydrateMessageImages(profile);
  }
  return profile;
};

/**
 * Save user profile (partial update)
 */
export const saveUserProfile = async (username: string, data: Partial<Omit<UserProfile, 'username'>>): Promise<void> => {
  // Chart images leave the profile blob first (see messageImageStore).
  const dataToSave = await stripMessageImages(data);
  if (await ensureDbReady()) {
    // The read-modify-write must be atomic: overlapping saves (data debounce,
    // settings debounce, heartbeat, unload flush) each read the whole profile
    // before writing; without serialization the earlier save's fields could
    // be lost to a stale snapshot, and the SQLite BEGIN/COMMIT could not nest.
    await runExclusiveWrite(async (permit) => {
      const existing = await sqliteGetUserProfile(username);
      const updatedProfile: UserProfile = {
        username,
        conversations: [],
        tradeLog: [],
        tradeSummaries: [],
        finalTradeSummary: null,
        settings: { activeFrameworks: [] },
        ...existing,
        ...dataToSave,
        updatedAt: new Date().toISOString(),
      };
      if (!updatedProfile.createdAt) {
        updatedProfile.createdAt = new Date().toISOString();
      }
      // Pass the permit: sqliteSaveUserProfile holds the write mutex itself,
      // and re-entering with the permit keeps THIS read-modify-write atomic
      // instead of deadlocking on a lock we already hold (or splitting into
      // two separately-locked halves that could interleave).
      await sqliteSaveUserProfile(updatedProfile, permit);
      await gcRemovedConversationImages(existing ?? undefined, updatedProfile);
    });
    return;
  }
  return idbSaveUserProfile(username, dataToSave);
};

/**
 * Overwrite entire user profile
 */
export const overwriteUserProfile = async (profile: UserProfile): Promise<void> => {
  const profileToSave = await stripMessageImages(profile);
  if (await ensureDbReady()) {
    await runExclusiveWrite(async (permit) => {
      const previous = await sqliteGetUserProfile(profile.username) ?? undefined;
      await sqliteSaveUserProfile(profileToSave, permit);
      await gcRemovedConversationImages(previous, profileToSave);
    });
    return;
  }
  await runExclusiveWrite(async () => {
    const db = await initIndexedDB();
    const previous = (await db.get(STORE_NAME, profile.username)) as UserProfile | undefined;
    await db.put(STORE_NAME, profileToSave);
    await gcRemovedConversationImages(previous, profileToSave);
  });
};

/**
 * GC the side-store image rows of conversations a just-committed save
 * REMOVED from the profile (delete session / clear all / import-restore /
 * user reset). A profile save carries the FULL conversation list whenever it
 * carries one, so an id stored before and absent now is a deleted
 * conversation — its `convId__msgId` image rows would otherwise leak forever
 * (the image store has no other delete path). Deleting through the store's
 * GC also purges the write fingerprints, so a later undo-and-resave re-PUTs
 * the images instead of short-circuiting against a deleted row. Runs AFTER
 * the profile write commits: if the save itself failed, nothing is GC'd.
 */
const gcRemovedConversationImages = async (
    previous: UserProfile | undefined,
    next: { conversations?: UserProfile['conversations'] }
): Promise<void> => {
    const previousIds = (previous?.conversations ?? [])
        .map(c => c?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (previousIds.length === 0) return;
    const kept = new Set((next.conversations ?? []).map(c => c?.id).filter(Boolean) as string[]);
    const orphaned = previousIds.filter(id => !kept.has(id));
    if (orphaned.length === 0) return;
    try {
        await deleteMessageImagesForConversations(orphaned);
    } catch (err) {
        console.warn('[dbService] Failed to GC deleted conversations\' message images:', err);
    }
};

/**
 * Delete user profile
 */
export const deleteUserProfile = async (username: string): Promise<void> => {
    if (await ensureDbReady()) {
        // Enumerate the user's conversations BEFORE the profile row is
        // removed — the image store is keyed by conversation id, and once
        // the profile is gone nothing can name its rows anymore.
        let conversationIds: string[] = [];
        try {
            conversationIds = ((await sqliteGetUserProfile(username))?.conversations ?? [])
                .map(c => c?.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0);
        } catch (err) {
            console.warn('[dbService] Could not enumerate conversations for image GC:', err);
        }
        await sqliteDeleteUser(username);
        await deleteMessageImagesForConversations(conversationIds);
        return;
    }
    let conversationIds: string[] = [];
    try {
        conversationIds = ((await idbGetUserProfile(username))?.conversations ?? [])
            .map(c => c?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch (err) {
        console.warn('[dbService] Could not enumerate conversations for image GC:', err);
    }
    await idbDeleteUserProfile(username);
    // (The reasoning corpus's own IndexedDB database is not touched here:
    // the store was deleted, and initDatabase drops the dead database once.)
    // Same GC for the image side-store (web/IndexedDB path).
    await deleteMessageImagesForConversations(conversationIds);
};

/**
 * Check if using native SQLite storage
 */
export const isUsingSqlite = (): boolean => sqliteReady;

/**
 * Get storage info for debugging
 */
export const getStorageInfo = async (): Promise<{
  platform: string;
  storageType: 'sqlite' | 'indexeddb';
  userCount: number;
}> => {
  const usernames = await getAllUsernames();
  const usingSqlite = await ensureDbReady();
  return {
    platform: Capacitor.getPlatform(),
    storageType: usingSqlite ? 'sqlite' : 'indexeddb',
    userCount: usernames.length
  };
};