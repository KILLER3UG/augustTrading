/**
 * BackupService - Automated backup management
 * Handles auto-save, versioned backups, and import validation
 *
 * On native platforms (Android/iOS), backups are persisted via the
 * Capacitor Filesystem API to a non-evictable directory, because WebView
 * IndexedDB can be cleared by the OS under storage pressure. On web, the
 * original IndexedDB store is used.
 */

import { Capacitor } from '@capacitor/core';
import { getUserProfile, saveUserProfile, overwriteUserProfile } from './dbService';
import { isValidUserProfile } from '../../utils/profileUtils';
import { phtDayKey } from '../../utils/timezone';
import { exportPreferencesData, importPreferencesData } from './ExportService';

export interface BackupMetadata {
    id: string;
    username: string;
    timestamp: string;
    version: number;
    sizeBytes: number;
    conversationCount: number;
    tradeCount: number;
    /** Stores this backup had to LEAVE OUT (over the per-store export cap).
     *  Rendered by Settings → Data: a backup that quietly omitted the trader's
     *  transcripts is worse than one that says it did. */
    notices?: string[];
}

const BACKUP_STORE_NAME = 'backups';
const MAX_BACKUPS = 5;
const AUTO_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const NATIVE_BACKUP_DIR = 'AugustBackups';

let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether to use the native (Filesystem) backup store instead of IndexedDB.
 * Resolved lazily so tests / SSR don't crash on a missing Capacitor bridge.
 */
const useNativeStorage = (): boolean => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

/**
 * Initialize the backup database (web fallback only).
 * On native, backups live in the Filesystem directory, so no init is needed.
 */
const initBackupDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('AugustBackups', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(BACKUP_STORE_NAME)) {
                const store = db.createObjectStore(BACKUP_STORE_NAME, { keyPath: 'id' });
                store.createIndex('username', 'username', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
};

/**
 * Read a Capacitor Filesystem file result as a string, handling both the
 * string and Blob return shapes across plugin versions. (Newer typings
 * return Blob; TextDecoder.decode() won't accept a Blob directly.)
 */
const readFileAsString = async (data: string | Blob): Promise<string> => {
    if (typeof data === 'string') return data;
    // Blob path — convert via arrayBuffer, then decode.
    const buf = await (data as Blob).arrayBuffer();
    return new TextDecoder().decode(buf);
};

/**
 * Lazy-load the Filesystem API so web builds don't pay the import cost and
 * tests don't fail when the plugin is absent.
 */
const getFilesystem = async () => {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    return { Filesystem, Directory, Encoding };
};

/**
 * Ensure the native backup directory exists.
 */
const ensureNativeDir = async (): Promise<void> => {
    const { Filesystem, Directory } = await getFilesystem();
    try {
        await Filesystem.mkdir({
            path: NATIVE_BACKUP_DIR,
            directory: Directory.Documents,
            recursive: true,
        });
    } catch (err: any) {
        // Already-exists is expected; rethrow real failures.
        if (!String(err?.message || '').toLowerCase().includes('exist')) {
            throw err;
        }
    }
};

/**
 * Create a backup of the current user profile
 */
export const createBackup = async (username: string): Promise<BackupMetadata | null> => {
    try {
        const profile = await getUserProfile(username);

        if (!profile) {
            console.warn('[BackupService] No profile found for', username);
            return null;
        }

        // The id embeds the SANITIZED username — the raw name can contain
        // characters that collide after filename sanitization ("a.b" vs "a_b"
        // both become "a_b"), letting one user list/delete the other's backups.
        const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const backupId = `backup-${safeUser}-${Date.now()}`;
        const timestamp = new Date().toISOString();
        const profileJson = JSON.stringify(profile);
        // F6: preferences sidecar — provider configs (with keys), learning
        // rules, price alerts, autopilot state. Restoring a backup previously
        // only restored the profile, silently dropping all of these.
        const preferences = await exportPreferencesData();
        // The export records what it skipped; carry it up to the person who
        // pressed the button instead of leaving it inside the sidecar file.
        const notices = Array.isArray(preferences._backup_notices)
            ? (preferences._backup_notices as unknown[]).map(String)
            : [];
        const preferencesJson = JSON.stringify(preferences);
        // (The reasoning-corpus sidecar is gone with ThinkingStoreService —
        // nothing wrote to that store any more, so backups no longer carry it.
        // Old backups that do have a .thinking.json sidecar are restored
        // without it; their profile and preferences still apply.)
        const sizeBytes = new Blob([profileJson]).size;
        const metadata: BackupMetadata = {
            id: backupId,
            username,
            timestamp,
            version: 1,
            sizeBytes,
            conversationCount: profile.conversations?.length || 0,
            tradeCount: profile.tradeLog?.length || 0,
            ...(notices.length ? { notices } : {}),
        };

        if (useNativeStorage()) {
            // Persist to Filesystem (non-evictable) on native.
            await ensureNativeDir();
            const { Filesystem, Directory, Encoding } = await getFilesystem();
            // Write the profile + a sidecar metadata file. We encode the
            // metadata in the filename so list operations don't need to read
            // every full backup just to show metadata.
            const baseName = `${safeUser}_${backupId}`;
            // CRITICAL: encoding: Encoding.UTF8 is required when passing a
            // string. Without it, Capacitor treats data as base64 binary and
            // throws on native (silently caught → backup returns null).
            await Filesystem.writeFile({
                path: `${NATIVE_BACKUP_DIR}/${baseName}.json`,
                data: profileJson,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
            await Filesystem.writeFile({
                path: `${NATIVE_BACKUP_DIR}/${baseName}.meta.json`,
                data: JSON.stringify(metadata),
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
            await Filesystem.writeFile({
                path: `${NATIVE_BACKUP_DIR}/${baseName}.prefs.json`,
                data: preferencesJson,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
        } else {
            // Web fallback: IndexedDB (subject to eviction under storage
            // pressure, but acceptable on desktop browsers).
            const db = await initBackupDB();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(BACKUP_STORE_NAME, 'readwrite');
                const store = tx.objectStore(BACKUP_STORE_NAME);
                const request = store.add({
                    id: backupId,
                    username,
                    timestamp,
                    version: 1,
                    profile: profileJson,
                    preferences: preferencesJson,
                    sizeBytes,
                    conversationCount: metadata.conversationCount,
                    tradeCount: metadata.tradeCount,
                });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }

        // Cleanup old backups (keep only MAX_BACKUPS)
        await cleanupOldBackups(username);

        console.log(`[BackupService] Created backup ${backupId} (${(sizeBytes / 1024).toFixed(1)}KB)${useNativeStorage() ? ' [native]' : ''}`);

        return metadata;
    } catch (error) {
        console.error('[BackupService] Failed to create backup:', error);
        return null;
    }
};

/**
 * Get all backups for a user
 */
export const getBackups = async (username: string): Promise<BackupMetadata[]> => {
    try {
        if (useNativeStorage()) {
            const { Filesystem, Directory, Encoding } = await getFilesystem();
            const result = await Filesystem.readdir({
                path: NATIVE_BACKUP_DIR,
                directory: Directory.Documents,
            });
            const safeUser = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
            const prefix = `${safeUser(username)}_`;
            // Read only the .meta.json sidecar files for this user. The
            // prefix is a cheap pre-filter — the AUTHORITATIVE check is the
            // username stored in the metadata (usernames sharing a sanitized
            // prefix, e.g. "bob" vs "bob_2", must not see each other's).
            const metaFiles = result.files
                .map(f => f.name)
                .filter(name => name.startsWith(prefix) && name.endsWith('.meta.json'));
            const metas: BackupMetadata[] = [];
            for (const metaFile of metaFiles) {
                try {
                    const { data } = await Filesystem.readFile({
                        path: `${NATIVE_BACKUP_DIR}/${metaFile}`,
                        directory: Directory.Documents,
                        encoding: Encoding.UTF8,
                    });
                    const meta = JSON.parse(await readFileAsString(data)) as BackupMetadata;
                    if (meta.username === username) metas.push(meta);
                } catch (err) {
                    console.warn(`[BackupService] Failed to read native meta ${metaFile}:`, err);
                }
            }
            return metas.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        }

        const db = await initBackupDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(BACKUP_STORE_NAME, 'readonly');
            const store = tx.objectStore(BACKUP_STORE_NAME);
            const index = store.index('username');
            const request = index.getAll(username);

            request.onsuccess = () => {
                const backups = request.result
                    .map((b: any) => ({
                        id: b.id,
                        username: b.username,
                        timestamp: b.timestamp,
                        version: b.version,
                        sizeBytes: b.sizeBytes,
                        conversationCount: b.conversationCount,
                        tradeCount: b.tradeCount
                    }))
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                resolve(backups);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[BackupService] Failed to get backups:', error);
        return [];
    }
};

/**
 * Read the full profile JSON for a backup (from either storage backend).
 * Used by exportBackupToFile.
 */
const readBackupProfile = async (backupId: string): Promise<{ username: string; timestamp: string; profileJson: string; preferencesJson?: string | null } | null> => {
    if (useNativeStorage()) {
        const { Filesystem, Directory, Encoding } = await getFilesystem();
        // Find the .json (non-meta) file whose name ends with the backupId.
        const result = await Filesystem.readdir({
            path: NATIVE_BACKUP_DIR,
            directory: Directory.Documents,
        });
        const match = result.files.find(f => f.name.endsWith(`${backupId}.json`) && !f.name.endsWith('.meta.json'));
        if (!match) return null;
        const { data } = await Filesystem.readFile({
            path: `${NATIVE_BACKUP_DIR}/${match.name}`,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
        const profileJson = await readFileAsString(data);
        // Recover username + timestamp from the sidecar meta if present.
        let username = '';
        let timestamp = new Date().toISOString();
        try {
            const metaResult = await Filesystem.readFile({
                path: `${NATIVE_BACKUP_DIR}/${match.name.replace('.json', '.meta.json')}`,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
            const meta = JSON.parse(await readFileAsString(metaResult.data));
            username = meta.username || '';
            timestamp = meta.timestamp || timestamp;
        } catch { /* meta missing — best effort */ }
        // Preferences sidecar (F6) — old backups don't have one.
        let preferencesJson: string | null = null;
        try {
            const prefsResult = await Filesystem.readFile({
                path: `${NATIVE_BACKUP_DIR}/${match.name.replace('.json', '.prefs.json')}`,
                directory: Directory.Documents,
                encoding: Encoding.UTF8,
            });
            preferencesJson = await readFileAsString(prefsResult.data);
        } catch { /* prefs sidecar missing — pre-F6 backup */ }
        // (Old backups may still carry a .thinking.json sidecar from the
        // deleted reasoning corpus — it is intentionally NOT read; a restore
        // applies the profile and preferences and ignores it.)
        return { username, timestamp, profileJson, preferencesJson };
    }

    const db = await initBackupDB();
    const backup = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(BACKUP_STORE_NAME, 'readonly');
        const store = tx.objectStore(BACKUP_STORE_NAME);
        const request = store.get(backupId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    if (!backup) return null;
    return { username: backup.username, timestamp: backup.timestamp, profileJson: backup.profile, preferencesJson: backup.preferences ?? null };
};

/**
 * Delete a specific backup
 */
export const deleteBackup = async (backupId: string): Promise<boolean> => {
    try {
        if (useNativeStorage()) {
            const { Filesystem, Directory } = await getFilesystem();
            const result = await Filesystem.readdir({
                path: NATIVE_BACKUP_DIR,
                directory: Directory.Documents,
            });
            // Match the id followed by the extension separator — a bare
            // `includes(backupId)` also matched OTHER backups whose ids share
            // the string as a prefix ("backup-bob-1000" matched
            // "backup-bob-10000"), deleting the wrong user's/version's data.
            const toDelete = result.files.filter(f => f.name.includes(`${backupId}.`));
            for (const f of toDelete) {
                await Filesystem.deleteFile({
                    path: `${NATIVE_BACKUP_DIR}/${f.name}`,
                    directory: Directory.Documents,
                });
            }
            console.log(`[BackupService] Deleted backup ${backupId}`);
            return true;
        }

        const db = await initBackupDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(BACKUP_STORE_NAME, 'readwrite');
            const store = tx.objectStore(BACKUP_STORE_NAME);
            const request = store.delete(backupId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        console.log(`[BackupService] Deleted backup ${backupId}`);
        return true;
    } catch (error) {
        console.error('[BackupService] Failed to delete backup:', error);
        return false;
    }
};

/**
 * Export backup to downloadable file
 */
export const exportBackupToFile = async (backupId: string): Promise<void> => {
    try {
        const record = await readBackupProfile(backupId);
        if (!record) {
            throw new Error('Backup not found');
        }

        // Include the preferences sidecar in the downloadable artifact. Keep
        // the profile-shaped envelope for compatibility with the existing
        // import flow, while avoiding a second opaque file users can forget.
        const profile = JSON.parse(record.profileJson) as Record<string, unknown>;
        const preferences = record.preferencesJson ? JSON.parse(record.preferencesJson) : undefined;
        const exportPayload = {
            ...profile,
            _backupExportedAt: new Date().toISOString(),
            ...(preferences ? { _preferencesBackup: preferences } : {}),
        };
        const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `august_backup_${record.username}_${phtDayKey(Date.parse(record.timestamp))}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('[BackupService] Failed to export backup:', error);
        throw error;
    }
};

/**
 * Restore a backup — REPLACES the profile stored under the backup's username
 * with the backed-up snapshot (delete-sync in sqliteSaveUserProfile removes
 * rows absent from the backup, so a smaller/older backup truly restores).
 *
 * ATOMICITY: every apply-step (profile write, preferences sidecar) that
 * FAILS aborts the restore with a thrown, step-named error —
 * a mixed-generation state (new profile + old prefs) never reports success.
 * A best-effort safety backup of the CURRENT state is taken before anything
 * is applied (when the profile exists) so a failed/partial restore is
 * reversible from Settings → Backups.
 */
export const restoreBackup = async (
    backupId: string
): Promise<{ success: boolean; error?: string; username?: string; message?: string; skippedPreferenceKeys?: string[] }> => {
    try {
        const record = await readBackupProfile(backupId);
        if (!record) {
            return { success: false, error: 'Backup not found' };
        }
        let profile: unknown;
        try {
            profile = JSON.parse(record.profileJson);
        } catch (e) {
            return { success: false, error: 'Backup file is corrupted (invalid JSON)' };
        }
        if (!isValidUserProfile(profile)) {
            return { success: false, error: 'Backup contains an invalid profile' };
        }

        // Pre-restore safety net: snapshot the CURRENT profile before any
        // write so a mid-restore failure is reversible. Best-effort —
        // createBackup returns null (already warns) when there is no current
        // profile or the snapshot itself failed; that must not block a
        // restore of a profile that legitimately doesn't exist yet.
        let safetyBackupId: string | null = null;
        try {
            const safety = await createBackup(profile.username);
            safetyBackupId = safety?.id ?? null;
        } catch (e) {
            console.warn('[BackupService] Pre-restore safety backup failed (restore continues):', e);
        }
        const safetyNote = safetyBackupId
            ? ` A pre-restore safety backup (${safetyBackupId}) was created and can be restored from Settings → Backups.`
            : ' No pre-restore safety backup was available.';

        // ── Step 1: profile ───────────────────────────────────────────────
        try {
            await overwriteUserProfile(profile);
        } catch (error) {
            throw new Error(
                `Restore failed at the "profile" step: ${error instanceof Error ? error.message : String(error)}.${safetyNote}`,
                { cause: error },
            );
        }

        // ── Step 2: preferences sidecar ───────────────────────────────────
        // F6: restore the preferences sidecar (provider configs, learning
        // rules, alerts, autopilot state). Old backups don't have one — the
        // profile restore still succeeds without it. But when a sidecar IS
        // present, any failure (bad JSON, import crash, or per-key write
        // failures reported by the import) aborts the restore loudly — the
        // prefs generation must not silently diverge from the profile's.
        // Keys skipped by the restore allow-list do NOT abort the restore
        // (they're data the current app build can't name), but they must not
        // vanish without a trace either: their names ride back to the UI in
        // the success result (see findings F6/F12 — both import surfaces
        // report the ImportPreferencesReport).
        let skippedPreferenceKeys: string[] = [];
        if (record.preferencesJson) {
            try {
                const preferences = JSON.parse(record.preferencesJson);
                if (preferences && typeof preferences === 'object') {
                    const report = await importPreferencesData(preferences);
                    if (report.failedKeys.length > 0) {
                        throw new Error(`${report.failedKeys.length} preference key(s) could not be written: ${report.failedKeys.join(', ')}`);
                    }
                    skippedPreferenceKeys = report.skippedKeys;
                }
            } catch (error) {
                throw new Error(
                    `Restore failed at the "preferences" step: ${error instanceof Error ? error.message : String(error)}.${safetyNote}`,
                    { cause: error },
                );
            }
        }

        // (The thinking sidecar step is gone with ThinkingStoreService. Old
        // backups that carry a .thinking.json sidecar are restored without it.)
        const message = skippedPreferenceKeys.length > 0
            ? `Restore succeeded, but ${skippedPreferenceKeys.length} backup key(s) are not on this build's restore allow-list and were skipped: ${skippedPreferenceKeys.join(', ')}.`
            : undefined;
        return { success: true, username: profile.username, message, skippedPreferenceKeys };
    } catch (error) {
        console.error('[BackupService] Restore failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Restore failed',
        };
    }
};

/**
 * Cleanup old backups.
 *
 * The rule used to be `backups.slice(MAX_BACKUPS)` and nothing else: five
 * records, one auto-backup per 30 minutes, so a day of trading kept roughly
 * 2.5 hours of recovery history — and the newest-5 window counted IMPORTED
 * records too, which is what the comment at `importBackupFromText` claims they
 * are exempt from. A trader who imported a file could therefore evict one of
 * the machine's own backups, and a trader whose notebook was corrupted at
 * 09:00 could discover at 12:00 that the only copy of yesterday was already
 * deleted. Both directions of that are memory loss, which is the one thing
 * this store exists to prevent.
 *
 * So: the newest MAX_BACKUPS always, plus one per day for DAILY_TIER_DAYS and
 * one per week for WEEKLY_TIER_WEEKS beyond that (bounded at MAX_BACKUPS + 7 +
 * 4 records), plus the newest MAX_IMPORTED imports. Imports are excluded from
 * the automatic window entirely — they are deliberate acts, not churn.
 *
 * Pure, because the jsdom suite has no IndexedDB: this is every decision the
 * sweep makes, and `cleanupOldBackups` only performs them.
 */
export const DAILY_TIER_DAYS = 7;
export const WEEKLY_TIER_WEEKS = 4;
export const MAX_IMPORTED_KEPT = 3;
const DAY_MS = 86_400_000;
const isImportedId = (id: string): boolean => id.startsWith('imported-');
const stampOf = (b: { timestamp: string }): number => {
    const t = Date.parse(b.timestamp);
    // Undated rows sort oldest: they cannot be placed in a time tier, so the
    // only thing they can ever win is one of the newest-MAX_BACKUPS slots.
    return Number.isFinite(t) ? t : 0;
};

export const selectBackupsToDelete = (
    backups: ReadonlyArray<Pick<BackupMetadata, 'id' | 'timestamp'>>,
    now: number = Date.now(),
): string[] => {
    const newestFirst = (a: { timestamp: string }, b: { timestamp: string }): number =>
        stampOf(b) - stampOf(a);
    const imports = backups.filter(b => isImportedId(b.id)).sort(newestFirst);
    const auto = backups.filter(b => !isImportedId(b.id)).sort(newestFirst);

    const keep = new Set<string>();
    auto.slice(0, MAX_BACKUPS).forEach(b => keep.add(b.id));

    // Tiered keeps only apply PAST the always-kept window; inside it the newest
    // five already cover whatever a day or week bucket would have chosen.
    const dailyCutoff = now - DAILY_TIER_DAYS * DAY_MS;
    const weeklyCutoff = now - (DAILY_TIER_DAYS + WEEKLY_TIER_WEEKS * 7) * DAY_MS;
    const byDay = new Map<string, string>();
    const byWeek = new Map<string, string>();
    for (const b of auto.slice(MAX_BACKUPS)) {
        const t = stampOf(b);
        if (t >= dailyCutoff) {
            const key = phtDayKey(t);
            if (!byDay.has(key)) { byDay.set(key, b.id); keep.add(b.id); }
            continue;
        }
        if (t >= weeklyCutoff) {
            const key = String(Math.floor(t / (7 * DAY_MS)));
            if (!byWeek.has(key)) { byWeek.set(key, b.id); keep.add(b.id); }
        }
    }

    imports.slice(0, MAX_IMPORTED_KEPT).forEach(b => keep.add(b.id));
    return backups.filter(b => !keep.has(b.id)).map(b => b.id);
};

const cleanupOldBackups = async (username: string): Promise<void> => {
    const backups = await getBackups(username);
    const toDelete = selectBackupsToDelete(backups);
    for (const id of toDelete) {
        await deleteBackup(id);
    }
    if (toDelete.length) {
        console.log(`[BackupService] Cleaned up ${toDelete.length} old backups`);
    }
};

/**
 * Start automatic backup scheduler
 */
export const startAutoBackup = (username: string, onBackupCreated?: (metadata: BackupMetadata) => void): void => {
    stopAutoBackup(); // Clear any existing timer

    console.log(`[BackupService] Starting auto-backup for ${username} (every ${AUTO_BACKUP_INTERVAL_MS / 60000} minutes)`);

    autoBackupTimer = setInterval(async () => {
        const metadata = await createBackup(username);
        if (metadata && onBackupCreated) {
            onBackupCreated(metadata);
        }
    }, AUTO_BACKUP_INTERVAL_MS);
};

/**
 * Stop automatic backup scheduler
 */
export const stopAutoBackup = (): void => {
    if (autoBackupTimer) {
        clearInterval(autoBackupTimer);
        autoBackupTimer = null;
        console.log('[BackupService] Stopped auto-backup');
    }
};

/**
 * Validate import data structure
 */
export const validateImportData = (data: any): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid data format - expected JSON object'] };
    }

    // Check required fields
    if (!data.username || typeof data.username !== 'string') {
        errors.push('Missing or invalid username');
    }

    if (data.conversations && !Array.isArray(data.conversations)) {
        errors.push('conversations must be an array');
    }

    if (data.tradeLog && !Array.isArray(data.tradeLog)) {
        errors.push('tradeLog must be an array');
    }

    if (data.settings && typeof data.settings !== 'object') {
        errors.push('settings must be an object');
    }

    // Validate conversation structure
    if (Array.isArray(data.conversations)) {
        data.conversations.forEach((conv: any, index: number) => {
            if (!conv.id || !conv.title) {
                errors.push(`Conversation at index ${index} missing id or title`);
            }
            if (!Array.isArray(conv.messages)) {
                errors.push(`Conversation at index ${index} has invalid messages array`);
            }
        });
    }

    return {
        valid: errors.length === 0,
        errors
    };
};

/**
 * Get import preview (summary of what will be imported)
 */
export const getImportPreview = (data: any): {
    username: string;
    conversationCount: number;
    messageCount: number;
    tradeCount: number;
} => {
    const messageCount = data.conversations?.reduce((sum: number, conv: any) =>
        sum + (conv.messages?.length || 0), 0) || 0;

    return {
        username: data.username || 'Unknown',
        conversationCount: data.conversations?.length || 0,
        messageCount,
        tradeCount: data.tradeLog?.length || 0
    };
};

// ─── IMPORT ─────────────────────────────────────────────────────────────────
// `exportBackupToFile` has always written a profile-shaped envelope documented
// as "compatible with the existing import flow" — but no import flow existed, so
// the one artifact a trader could carry off a machine was unreadable by this
// app. These two functions are that missing half: the pure builder holds every
// decision (what the file may contain, what it cannot), and the async importer
// just stores what it produced.

export interface ImportOutcome {
    ok: boolean;
    error?: string;
    errors?: string[];
    preview?: ReturnType<typeof getImportPreview>;
    /** What the file could not carry, so a completed import never reads as a
     *  complete one. */
    limitations?: string[];
    record?: BackupRecord;
    metadata?: BackupMetadata;
}

/** A stored backup, exactly as `createBackup` writes it. Exported so the import
 *  path cannot drift from the restore path's expectations. */
export interface BackupRecord {
    id: string;
    username: string;
    timestamp: string;
    version: number;
    profile: string;
    preferences: string;
    sizeBytes: number;
    conversationCount: number;
    tradeCount: number;
}

/** Turn exported JSON into a storable backup record. Pure — no storage, no
 *  Capacitor, so every branch of it is testable. */
export const buildBackupRecordFromExport = (text: string): ImportOutcome => {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return { ok: false, error: 'That file is not valid JSON.' };
    }

    const check = validateImportData(data);
    if (!check.valid) return { ok: false, errors: check.errors };

    const envelope = data as Record<string, unknown> & { username: string };
    const preview = getImportPreview(envelope);
    // The export envelope's own bookkeeping keys are not part of a UserProfile;
    // leaving them in would persist fields the restore path never expects.
    const { _backupExportedAt, _preferencesBackup, ...profile } = envelope;
    const profileJson = JSON.stringify(profile);
    const record: BackupRecord = {
        // An `imported-` prefix keeps this distinguishable from an auto-backup
        // in the list, and out of `cleanupOldBackups`' newest-5 window: an
        // import must never evict the backups already on the machine.
        id: `imported-${envelope.username.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`,
        username: envelope.username,
        timestamp: typeof _backupExportedAt === 'string'
            ? _backupExportedAt
            : new Date().toISOString(),
        version: 1,
        profile: profileJson,
        preferences: _preferencesBackup ? JSON.stringify(_preferencesBackup) : '{}',
        sizeBytes: profileJson.length * 2,
        conversationCount: preview.conversationCount,
        tradeCount: preview.tradeCount,
    };
    const limitations: string[] = [];
    if (!_preferencesBackup) {
        limitations.push('No provider settings/keys sidecar in this file — it predates sidecar exports.');
    }
    const metadata: BackupMetadata = {
        id: record.id,
        username: record.username,
        timestamp: record.timestamp,
        version: 1,
        sizeBytes: record.sizeBytes,
        conversationCount: record.conversationCount,
        tradeCount: record.tradeCount,
    };
    return { ok: true, preview, limitations, record, metadata };
};

/**
 * Import a file written by `exportBackupToFile` into the backup list.
 *
 * NON-DESTRUCTIVE by design: it stores a record and returns. Restoring — the
 * step that replaces a live profile — stays behind `restoreBackup` and the
 * confirm dialog that already guards it, so choosing a file can never silently
 * overwrite a journal.
 */
export const importBackupFromText = async (text: string): Promise<ImportOutcome> => {
    const outcome = buildBackupRecordFromExport(text);
    if (!outcome.ok || !outcome.record) return outcome;
    if (useNativeStorage()) {
        // The native store is the app's sandbox directory; a file chosen on a
        // desktop has no path there. Refuse loudly rather than half-import.
        return { ok: false, error: 'Importing a backup file is available on desktop and web. On mobile, backups stay inside the app.' };
    }
    try {
        const db = await initBackupDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(BACKUP_STORE_NAME, 'readwrite');
            const request = tx.objectStore(BACKUP_STORE_NAME).add(outcome.record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        return outcome;
    } catch (error) {
        console.error('[BackupService] Failed to import backup:', error);
        return { ok: false, error: 'Could not store the imported backup.' };
    }
};
