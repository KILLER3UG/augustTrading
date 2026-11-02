/**
 * DataIntegrityService - Data validation and recovery utilities
 * Protects against data loss during updates and provides recovery options
 */

import { getUserProfile, saveUserProfile } from '../infrastructure/dbService';
import { createBackup, getBackups, BackupMetadata } from '../infrastructure/BackupService';
import { getPreference, setPreference, removePreference, getPreferenceObject, setPreferenceObject, PREF_KEYS } from '../infrastructure/PreferencesService';
import { selectRecoveryBackup } from '../../utils/backupSelection';

/**
 * Data integrity check result
 */
export interface IntegrityCheckResult {
    valid: boolean;
    issues: string[];
    tradeCountChanged: boolean;
    previousTradeCount: number;
    currentTradeCount: number;
    hasBackups: boolean;
    latestBackup: BackupMetadata | null;
    /** The backup that actually HOLDS MORE trades than the current profile —
     *  the only one worth offering. Null when no backup can recover anything. */
    recoveryBackup: BackupMetadata | null;
    /** True only for a loss this profile has not already been shown. The count
     *  baseline is deliberately never re-written to 0, so without this flag a
     *  genuine 0-trade profile re-warned on every launch. */
    newLossAlert: boolean;
}

/** Signatures already toasted in this page session. The persisted alert key
 *  covers reloads; this covers two overlapping startup checks in one load. */
const alertedThisSession = new Set<string>();

/**
 * Run data integrity check on user profile
 * Call this at startup after loading user data
 */
export const checkDataIntegrity = async (
    username: string,
    currentTradeCount: number
): Promise<IntegrityCheckResult> => {
    const issues: string[] = [];

    // Get last known trade count
    const lastTradeCountStr = await getPreference(`${PREF_KEYS.LAST_TRADE_COUNT}_${username}`);
    const previousTradeCount = lastTradeCountStr ? parseInt(lastTradeCountStr, 10) : 0;

    // Check if trade count decreased (potential data loss)
    const tradeCountChanged = previousTradeCount > 0 && currentTradeCount < previousTradeCount;

    if (tradeCountChanged) {
        const lostTrades = previousTradeCount - currentTradeCount;
        issues.push(`Trade count decreased from ${previousTradeCount} to ${currentTradeCount} (${lostTrades} trades missing)`);
    }

    // Check for existing backups
    const backups = await getBackups(username);
    const hasBackups = backups.length > 0;
    const latestBackup = backups.length > 0 ? backups[0] : null;
    // A recovery suggestion must hold MORE trades than the profile has now.
    // The newest backup is usually the startup backup taken seconds ago — the
    // one that captured the loss — so offering it ("a backup with 0 trades")
    // was advice that could not recover anything.
    const recoveryBackup = selectRecoveryBackup(backups, currentTradeCount);

    // If trade count dropped and a backup can recover it, say which.
    if (tradeCountChanged && recoveryBackup) {
        issues.push(`Backup ${new Date(recoveryBackup.timestamp).toLocaleString()} holds ${recoveryBackup.tradeCount} trades - recovery possible`);
    }

    // One notice per loss, not one per launch. The signature includes the
    // best recovery backup so a NEW better backup can speak up; an intentional
    // trade-count change (a logged trade or a deletion) clears it.
    const alertKey = `${PREF_KEYS.DATA_LOSS_ALERT}_${username}`;
    const lossSignature = `${previousTradeCount}->${currentTradeCount}|${recoveryBackup?.id ?? 'none'}`;
    let newLossAlert = false;
    if (tradeCountChanged) {
        let lastAlerted = '';
        try { lastAlerted = (await getPreference(alertKey)) || ''; } catch { /* private mode */ }
        // Migration for the builds that re-warned on every launch: an entry
        // in the integrity log means this exact loss was already surfaced.
        // Adopt its signature so the upgrade does not show the same stale
        // warning one more time.
        if (!lastAlerted) {
            try {
                const previousLog = await getPreferenceObject<Array<{
                    event?: string;
                    data?: { previousTradeCount?: number; currentTradeCount?: number };
                }>>(PREF_KEYS.DATA_INTEGRITY_LOG) || [];
                const alreadyShown = previousLog.some(entry =>
                    entry?.event === 'DATA_LOSS_DETECTED'
                    && entry.data?.previousTradeCount === previousTradeCount
                    && entry.data?.currentTradeCount === currentTradeCount);
                if (alreadyShown) {
                    lastAlerted = lossSignature;
                    await setPreference(alertKey, lossSignature);
                }
            } catch { /* no readable log — show it */ }
        }
        if (lastAlerted !== lossSignature && !alertedThisSession.has(`${username}|${lossSignature}`)) {
            newLossAlert = true;
            alertedThisSession.add(`${username}|${lossSignature}`);
            try { await setPreference(alertKey, lossSignature); } catch { /* private mode */ }
        }
    } else if (currentTradeCount > 0) {
        try { await removePreference(alertKey); } catch { /* private mode */ }
    }

    // Update last known trade count for next session — but never re-baseline
    // to 0. A count of 0 usually means the profile was still loading when the
    // check ran; re-baselining would permanently mask a real data loss.
    if (currentTradeCount > 0) {
        await setPreference(`${PREF_KEYS.LAST_TRADE_COUNT}_${username}`, String(currentTradeCount));
    }

    // Update session timestamp
    await setPreference(`${PREF_KEYS.LAST_SESSION}_${username}`, new Date().toISOString());

    return {
        valid: issues.length === 0,
        issues,
        tradeCountChanged,
        previousTradeCount,
        currentTradeCount,
        hasBackups,
        latestBackup,
        recoveryBackup,
        newLossAlert,
    };
};

/**
 * A deliberate trade-count change (logging, deleting, clearing) is not data
 * loss. Move the baseline and drop any pending loss alert so the next startup
 * does not accuse the trader of losing rows they chose to remove.
 */
export const recordIntentionalTradeCount = async (username: string, count: number): Promise<void> => {
    try {
        await setPreference(`${PREF_KEYS.LAST_TRADE_COUNT}_${username}`, String(count));
        await removePreference(`${PREF_KEYS.DATA_LOSS_ALERT}_${username}`);
    } catch (error) {
        console.warn('[DataIntegrity] Failed to record an intentional trade count:', error);
    }
};

/**
 * Create a startup backup
 * Should be called immediately after user login to preserve current state
 */
export const createStartupBackup = async (username: string): Promise<BackupMetadata | null> => {
    console.log(`[DataIntegrity] Creating startup backup for ${username}`);

    try {
        const metadata = await createBackup(username);
        if (metadata) {
            console.log(`[DataIntegrity] Startup backup created: ${metadata.id} (${metadata.tradeCount} trades)`);
        }
        return metadata;
    } catch (error) {
        console.error('[DataIntegrity] Failed to create startup backup:', error);
        return null;
    }
};

/**
 * Get stored data version for migration handling
 */
export const getDataVersion = async (username: string): Promise<number> => {
    const versionStr = await getPreference(`${PREF_KEYS.DATA_VERSION}_${username}`);
    return versionStr ? parseInt(versionStr, 10) : 0;
};

/**
 * Set data version after migration
 */
export const setDataVersion = async (username: string, version: number): Promise<void> => {
    await setPreference(`${PREF_KEYS.DATA_VERSION}_${username}`, String(version));
};

/**
 * Run any necessary data migrations
 */
export const runMigrations = async (username: string): Promise<void> => {
    const currentVersion = await getDataVersion(username);

    if (currentVersion < 1) {
        // Version 1 migration: Add data version tracking
        console.log('[DataIntegrity] Running migration to version 1');
        await setDataVersion(username, 1);
    }

    // Future migrations can be added here
    // if (currentVersion < 2) { ... }
};

/**
 * Log integrity event for debugging
 */
/**
 * Log integrity event for debugging
 */
export const logIntegrityEvent = async (event: string, data?: any): Promise<void> => {
    const logKey = PREF_KEYS.DATA_INTEGRITY_LOG;
    try {
        const existingLog = await getPreferenceObject<any[]>(logKey);
        const log = existingLog || [];

        log.push({
            timestamp: new Date().toISOString(),
            event,
            data,
        });

        // Keep only last 50 entries
        const trimmedLog = log.slice(-50);
        await setPreferenceObject(logKey, trimmedLog);
    } catch (error) {
        console.error('[DataIntegrity] Failed to log event:', error);
    }
};
