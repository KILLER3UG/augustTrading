/**
 * PreferencesService.ts
 * 
 * Native key-value storage service using @capacitor/preferences.
 * Uses Android SharedPreferences / iOS UserDefaults for reliable persistence.
 * Falls back to localStorage on web.
 * 
 * Use this for:
 * - API keys
 * - User settings/preferences
 * - Small configuration values
 * - Feature flags
 */

import { Capacitor } from '@capacitor/core';
import { readStore, writeStore, removeStore } from './storeBackend';
import { Preferences } from '@capacitor/preferences';

// Storage keys
export const PREF_KEYS = {
    // Provider metadata is portable; API keys are deliberately redacted by
    // ExportService before backups leave the device.
    PROVIDER_CONFIGS: 'provider_configs_v1',
    // Core AI Handling
    MEMORY_PROVIDER: 'memory_provider', // ProviderConfig id of the provider used for memory synthesis

    // Settings
    CASUAL_CHAT_MODEL: 'casual_chat_model',
    HYBRID_PANEL_POSITION: 'hybrid_panel_position',
    MODEL_PERFORMANCE_DATA: 'model_performance_data',
    ROLLING_WINDOW_DATA: 'rolling_window_data',
    CONFIDENCE_CALIBRATION: 'confidence_calibration',
    CONFLUENCE_STATS: 'confluence_historical_stats',
    ATTRIBUTED_INSIGHTS: 'attributed_insights_kb',

    // Alerts
    OUTCOME_AUTOPILOT_STATE: 'outcome_autopilot_state',
    QUIET_HOURS: 'quiet_hours_v1',

    // Data integrity
    LAST_TRADE_COUNT: 'last_trade_count',
    LAST_SESSION: 'last_session',
    DATA_VERSION: 'data_version',
    DATA_INTEGRITY_LOG: 'data_integrity_log',
    /** Signature of the last data-loss warning this profile was shown. */
    DATA_LOSS_ALERT: 'data_loss_alert',

    // Error tracking
    LAST_CRASH_ERROR: 'lastCrashError',
    LAST_PROMISE_ERROR: 'lastPromiseError',
    LAST_GLOBAL_ERROR: 'lastGlobalError',

    // Migration flag
    SQLITE_MIGRATED: 'sqlite_migrated',
};

/**
 * Check if running on native platform
 */
const isNative = (): boolean => Capacitor.isNativePlatform();

/**
 * Desktop is NOT Capacitor — `isNative()` is false in Electron — so this used to
 * fall through to `localStorage` for every store, sharing one ~5 MiB origin
 * budget with the chats and the notebook. Electron now has a file backend
 * (`electron/storeFs.cjs` behind `window.electronAPI.store`), and this module is
 * the seam: same async API, so no caller changes. Web keeps localStorage.
 */

/**
 * Set a value in preferences
 */
export const setPreference = async (key: string, value: string): Promise<void> => {
    if (isNative()) {
        await Preferences.set({ key, value });
        return;
    }
    const res = await writeStore(key, value);
    // Throwing is the contract every writer already relies on: the notebook's
    // `persist` records the failure, rethrows, and the Health card says the bytes
    // did not land. A silent success here is the bug that surface exists for.
    if (!res.ok) throw new Error(res.error ?? 'preference write failed');
};

/**
 * Get a value from preferences
 */
export const getPreference = async (key: string): Promise<string | null> => {
    if (isNative()) {
        const result = await Preferences.get({ key });
        return result.value;
    }
    const res = await readStore(key);
    // A failed read reports null WHILE the backend refuses writes (storeBackend's
    // readFailed), so an unreadable store is never overwritten by an empty seed.
    if (!res.ok) {
        console.warn(`[Preferences] read failed for "${key}": ${res.error}`);
        return null;
    }
    return res.value;
};

/**
 * Remove a value from preferences
 */
export const removePreference = async (key: string): Promise<void> => {
    if (isNative()) {
        await Preferences.remove({ key });
        return;
    }
    await removeStore(key);
};

/**
 * Store a JSON object
 */
export const setPreferenceObject = async <T>(key: string, value: T): Promise<void> => {
    await setPreference(key, JSON.stringify(value));
};

/**
 * Get a JSON object
 */
export const getPreferenceObject = async <T>(key: string): Promise<T | null> => {
    const value = await getPreference(key);
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
};

/**
 * Get a JSON ARRAY with a runtime check — the hardened read for the many
 * list-shaped prefs (pass records, injection logs, tombstones).
 * getPreferenceObject is `as T` with no check: a legacy/corrupted/foreign
 * blob (an object, a number, an array of junk items) used to flow straight
 * into callers' `.map`/`.filter`/`.slice` chains.
 *
 * - Non-array / unparseable / null → `[]`.
 * - With `guard`: junk items are dropped (Array.prototype.filter with a type
 *   predicate), so the result is `T[]` by construction.
 * - Without `guard`: only the Array.isArray check is applied (items pass
 *   through as-is) — prefer a guard when the element shape matters.
 */
export const getPreferenceArray = async <T>(
    key: string,
    guard?: (item: unknown) => item is T,
): Promise<T[]> => {
    const raw = await getPreferenceObject<unknown>(key);
    if (!Array.isArray(raw)) return [];
    return guard ? raw.filter(guard) : (raw as T[]);
};

/**
 * Check if a key exists
 */
export const hasPreference = async (key: string): Promise<boolean> => {
    const value = await getPreference(key);
    return value !== null;
};

/**
 * Get all keys (native only returns plugin-managed keys)
 */
export const getAllKeys = async (): Promise<string[]> => {
    if (isNative()) {
        const result = await Preferences.keys();
        return result.keys;
    } else {
        return Object.keys(localStorage);
    }
};

/**
 * Clear all preferences
 */
export const clearAllPreferences = async (): Promise<void> => {
    if (isNative()) {
        await Preferences.clear();
    } else {
        localStorage.clear();
    }
};

// ============================================================================
// CONVENIENCE FUNCTIONS FOR COMMON OPERATIONS
// ============================================================================

/**
 * Check if SQLite migration has been completed
 */
export const isSqliteMigrated = async (): Promise<boolean> => {
    const value = await getPreference(PREF_KEYS.SQLITE_MIGRATED);
    return value === 'true';
};

/**
 * Mark SQLite migration as complete
 */
export const setSqliteMigrated = async (): Promise<void> => {
    await setPreference(PREF_KEYS.SQLITE_MIGRATED, 'true');
};

// ============================================================================
// MIGRATION HELPER - Move localStorage to Preferences
// ============================================================================

/**
 * Migrate specific localStorage keys to Preferences
 */
export const migrateLocalStorageToPreferences = async (): Promise<number> => {
    if (!isNative()) return 0;

    let migratedCount = 0;
    const keysToMigrate = Object.values(PREF_KEYS);

    for (const key of keysToMigrate) {
        // Check if already exists in Preferences
        const existing = await getPreference(key);
        if (existing) continue;

        // Try to get from localStorage (in case still accessible)
        try {
            const localValue = localStorage.getItem(key);
            if (localValue) {
                await setPreference(key, localValue);
                migratedCount++;
                console.log(`[PreferencesService] Migrated key: ${key}`);
            }
        } catch (e) {
            // localStorage may not be accessible
        }
    }

    // Per-user scoped keys (learning_rules_v2_<user>, attributed_insights_kb_<user>,
    // global_learning_state_<user>, rl_signals_data) are NOT in PREF_KEYS, so the
    // loop above skips them and they silently die on an Android WebView data
    // clear. Sweep every remaining localStorage key so none is left behind.
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || keysToMigrate.includes(key)) continue;
            const existing = await getPreference(key);
            if (existing) continue;
            const localValue = localStorage.getItem(key);
            if (localValue) {
                await setPreference(key, localValue);
                migratedCount++;
                console.log(`[PreferencesService] Migrated key: ${key}`);
            }
        }
    } catch (e) {
        console.warn('[PreferencesService] Per-user key sweep failed:', e);
    }

    console.log(`[PreferencesService] Migrated ${migratedCount} keys to Preferences`);
    return migratedCount;
};
