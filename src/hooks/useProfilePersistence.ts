import { useCallback, useEffect, useRef } from 'react';
import * as dbService from '../services/infrastructure/dbService';
import { storageService } from '../services/infrastructure/StorageService';
import { useSaveOnUnload } from './useSaveOnUnload';
import type { UserProfile, Conversation, LoggedTrade, TradeSummary } from '../types';
import type { ProviderConfig } from '../types/provider';

export interface ProfileSettingsState {
    activeFrameworks: string[];
    summaryCharLimit: number;
    summarizationProvider: string;
    summarizationModel: string;
    visionModel: string;
    isGlobalMemoryEnabled: boolean;
    isStrategiesEnabled: boolean;
    customInstructions: UserProfile['settings']['customInstructions'];
    isHybridIntelligenceEnabled: boolean;
    isAutoCapturing: boolean;
    isEntryNotHitCapturing: boolean;
    useAlgorithmicSummary: boolean;
    useAlgorithmicInsights: boolean;
}

export interface UseProfilePersistenceArgs extends ProfileSettingsState {
    activeUsername: string | null;
    /** True once the ACTIVE profile's data has actually loaded. Read through a
     *  ref so the autosave can gate without re-arming on every render. */
    profileReadyRef?: React.MutableRefObject<boolean>;
    activeConversationId: string | null;
    setSaveStatus: React.Dispatch<React.SetStateAction<'SAVED' | 'SAVING' | 'ERROR'>>;

    conversationHistory: Conversation[];
    loggedTrades: LoggedTrade[];
    tradeSummaries: TradeSummary[];
    finalTradeSummary: string | null;
    globalMemory: any;
    memoryConfig: ProviderConfig | null;
    memoryModel: string;

    isAnalysisInProgress: boolean;

    toast: { error: (title: string, message?: string) => void };
}

export interface UseProfilePersistenceResult {
    /** The last profile payload actually persisted — dirty checks compare
     *  against it by reference. */
    lastSavedSnapshotRef: React.MutableRefObject<Partial<Omit<UserProfile, 'username'>> | null>;
    /** Full-profile snapshot (the heavy payload, conversations included). */
    buildProfileSnapshot: () => Partial<Omit<UserProfile, 'username'>>;
}

/**
 * Profile persistence: split the save into a heavy DATA write (conversations
 * with base64 images + trade log — only on real data changes) and a light
 * SETTINGS write (checkbox toggles, longer debounce), plus a 15s heartbeat
 * that flushes mid-run so a native kill can't lose an entire analysis, and
 * a synchronous flush on tab close/hide. Both writes hit the same profile;
 * dbService merges them, so a settings toggle never re-serializes
 * multi-MB conversation payloads.
 */
/** Shallow, key-wise compare of two settings snapshots. `customInstructions`
 *  is an object, so it is compared by JSON —
 *  settings are a few KB at most and this only runs on unload. */
const settingsEqual = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const av = a[k];
        const bv = b[k];
        if (av === bv) continue;
        if (av && bv && typeof av === 'object' && typeof bv === 'object') {
            if (JSON.stringify(av) === JSON.stringify(bv)) continue;
        }
        return false;
    }
    return true;
};

export const useProfilePersistence = (args: UseProfilePersistenceArgs): UseProfilePersistenceResult => {
    const {
        activeUsername, activeConversationId, setSaveStatus, toast, profileReadyRef,
        conversationHistory, loggedTrades, tradeSummaries,
        finalTradeSummary, globalMemory,
        memoryConfig, memoryModel,
        isAnalysisInProgress,
        activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel,
        visionModel, isGlobalMemoryEnabled, isStrategiesEnabled,
        customInstructions,
        isHybridIntelligenceEnabled, isAutoCapturing,
        isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights,
    } = args;

    const lastSavedSnapshotRef = useRef<Partial<Omit<UserProfile, 'username'>> | null>(null);
    // Settings have their OWN last-saved marker: the SETTINGS effect writes a
    // light payload and never touches the heavy snapshot, so comparing against
    // lastSavedSnapshotRef.settings would test a value the DATA path wrote at
    // some earlier moment — not what the settings writer last persisted.
    const lastSavedSettingsRef = useRef<Record<string, unknown> | null>(null);
    const buildProfileSnapshot = useCallback((): Partial<Omit<UserProfile, 'username'>> => ({
        conversations: conversationHistory,
        tradeLog: loggedTrades,
        tradeSummaries: tradeSummaries,
        finalTradeSummary: finalTradeSummary,
        globalMemory: globalMemory,
        settings: { activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel, visionModel, isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,isHybridIntelligenceEnabled, isAutoCapturing, isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights, memoryProvider: memoryConfig?.id || '', memoryModel },
        lastActiveConversationId: activeConversationId || undefined,
        // Learning rules used to live ONLY in WebView localStorage — they were
        // excluded from SQLite, backups and migrations, so a WebView data
        // clear silently destroyed them. Snapshotting them here populates the
        // users.learningRules column and BackupService payload.
        learningRules: storageService.loadLearningRules(),
    }), [conversationHistory, loggedTrades, activeFrameworks, activeConversationId, tradeSummaries, finalTradeSummary, globalMemory, summaryCharLimit, summarizationProvider, summarizationModel, visionModel, isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,isHybridIntelligenceEnabled, isAutoCapturing, isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights, memoryConfig, memoryModel]);

    // ─── Split save into DATA (heavy) + SETTINGS (light) ───────────
    // Previously a single effect re-serialized ALL conversations (with base64
    // images) + ALL trades on ANY of 22 dependency changes, including trivial
    // settings toggles. Now:
    //   - The DATA effect only re-serializes when conversations/trades/
    //     summaries/memory actually change (the heavy payload).
    //   - The SETTINGS effect handles cheap settings toggles (activeFrameworks,
    //     summaryCharLimit, etc.) with the same 1500ms debounce but a much
    //     smaller payload (no base64 images, no trade log).
    // Both write to the same profile; dbService merges them. The net effect:
    // toggling a settings checkbox no longer triggers a multi-MB re-serialize.

    /** True only while a profile that actually LOADED owns the live state.
     *  Checked at effect-body time AND again inside every debounced/timed write,
     *  because a timeout armed before a profile switch still fires after it — and
     *  the state it would then serialize is the INCOMING profile's rows under the
     *  OUTGOING username (the 2026-10-27 audit L-2). */
    const canPersist = (): boolean => !profileReadyRef || profileReadyRef.current === true;

    // (1) DATA save — heavy payload, only on real data changes.
    useEffect(() => {
        if (!activeUsername || !canPersist()) return;
        // Only ever write for a profile that actually LOADED. The loader
        // already refuses to adopt a username whose load threw; this is the
        // second lock on the same door, because the failure mode is total and
        // silent — a transient storage error turning the autosave into a
        // writer of whatever happens to be in React state (the previous
        // user's trades, or an empty array on a cold boot) under a username
        // whose data was never read.
        if (profileReadyRef && !profileReadyRef.current) return;

        // Bail out when already SAVING — this effect re-arms on EVERY stream
        // chunk, and a state write to the same value would still schedule a
        // full App render each time (setSaveStatus was a raw setter).
        setSaveStatus(prev => (prev === 'SAVING' ? prev : 'SAVING'));

        const handler = setTimeout(async () => {
            // Re-checked: the switch may have begun after this timer was armed.
            if (!canPersist()) return;
            try {
                // buildProfileSnapshot deliberately stays OUT of this effect's
                // deps (see dep list below): settings-only toggles would re-arm
                // a heavy full-snapshot save that the SETTINGS effect already
                // covers. heartbeatSnapshotRef (synced every render, below)
                // always holds the freshest snapshot without re-arming here.
                const profileData = heartbeatSnapshotRef.current();
                await dbService.saveUserProfile(activeUsername, profileData);
                lastSavedSnapshotRef.current = profileData;
                setSaveStatus('SAVED');
            } catch (err) {
                console.error("Failed to save user profile (data):", err);
                setSaveStatus('ERROR');
            }
        }, 1500);

        return () => {
            clearTimeout(handler);
        };
    }, [conversationHistory, loggedTrades, tradeSummaries, finalTradeSummary, globalMemory, activeUsername, setSaveStatus]);

    // The light payload, in one place so the SETTINGS effect and the unload
    // dirty-check can never drift on WHICH fields count as settings.
    const buildSettingsSnapshot = useCallback(() => ({
        activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel, visionModel, isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,isHybridIntelligenceEnabled, isAutoCapturing, isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights, memoryProvider: memoryConfig?.id || '', memoryModel,
    }), [activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel, visionModel, isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,isHybridIntelligenceEnabled, isAutoCapturing, isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights, memoryConfig, memoryModel]);

    // (2) SETTINGS save — light payload, runs on settings toggles. Uses a
    // longer debounce (2500ms) since settings changes are low-risk and we
    // don't want every checkbox tick to trigger a save storm.
    useEffect(() => {
        if (!activeUsername || !canPersist()) return;

        // Surface settings saves in the header status too — the old path
        // failed silently (console.error only), so a broken write looked
        // like a successful toggle. Same bail-out as the DATA effect.
        setSaveStatus(prev => (prev === 'SAVING' ? prev : 'SAVING'));

        const handler = setTimeout(async () => {
            if (!canPersist()) return;
            try {
                // Only the settings sub-object — no conversations, no trades,
                // no base64 images. This is a cheap write.
                await dbService.saveUserProfile(activeUsername, {
                    settings: buildSettingsSnapshot(),
                });
                lastSavedSettingsRef.current = buildSettingsSnapshot();
                setSaveStatus('SAVED');
            } catch (err) {
                console.error("Failed to save user profile (settings):", err);
                setSaveStatus('ERROR');
                toast.error('Settings not saved', 'Your changes could not be saved. Check storage permissions and try again.');
            }
        }, 2500);

        return () => {
            clearTimeout(handler);
        };
    }, [activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel, visionModel, isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,isHybridIntelligenceEnabled, isAutoCapturing, isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights, memoryConfig, memoryModel, activeUsername, setSaveStatus, toast]);

    // (3) SAVE HEARTBEAT — the 1500ms DATA debounce restarts on every message
    // change, so nothing is persisted for the ENTIRE duration of a run (the
    // RAF-throttled debate updates keep resetting it). A native kill or
    // background termination mid-run then loses the whole run. Flush every
    // 15s while a run is active instead.
    // buildProfileSnapshot changes identity on every conversationHistory
    // mutation — using it directly in deps would re-arm this interval every
    // frame during a run (the exact bug this heartbeat exists to fix). Keep
    // the freshest snapshot in a ref instead. The ref is synced during RENDER
    // (like loggedTradesRef): the effect body only runs when the run starts,
    // so an assignment inside it would freeze the snapshot at run-start data
    // and the mid-run flush would overwrite the profile with stale state.
    const heartbeatSnapshotRef = useRef(buildProfileSnapshot);
    heartbeatSnapshotRef.current = buildProfileSnapshot;
    useEffect(() => {
        if (!activeUsername || !isAnalysisInProgress || !canPersist()) return;
        const interval = setInterval(async () => {
            if (!canPersist()) return;
            try {
                const last = lastSavedSnapshotRef.current;
                const snapshot = heartbeatSnapshotRef.current();
                // Skip the write when nothing changed since the last persisted
                // snapshot (reference compare — same as the unload-flush dirty
                // check). Pure typing or a settled run must not force a
                // full-profile stringify every 15s.
                const dirty = !last
                    || last.conversations !== snapshot.conversations
                    || last.tradeLog !== snapshot.tradeLog
                    || last.tradeSummaries !== snapshot.tradeSummaries
                    || last.finalTradeSummary !== snapshot.finalTradeSummary
                    || last.globalMemory !== snapshot.globalMemory;
                if (!dirty) return;
                await dbService.saveUserProfile(activeUsername, snapshot);
                lastSavedSnapshotRef.current = snapshot;
            } catch (err) {
                console.error('Failed to save user profile (heartbeat):', err);
            }
        }, 15000);
        return () => clearInterval(interval);
    }, [activeUsername, isAnalysisInProgress]);

    // Flush pending state on tab close / hide. The hook keeps an internal
    // ref to the freshest snapshot (updated every render via getSnapshot)
    // so the synchronous unload handler always persists the latest data.
    useSaveOnUnload({
        enabled: !!activeUsername && canPersist(),
        getSnapshot: buildProfileSnapshot,
        isDirty: () => {
            const last = lastSavedSnapshotRef.current;
            if (!last) return true; // never saved yet
            // Shallow reference check on the heavy arrays is sufficient —
            // any state mutation produces a new array reference (immutable updates).
            if (last.conversations !== conversationHistory
                || last.tradeLog !== loggedTrades
                || last.tradeSummaries !== tradeSummaries
                || last.finalTradeSummary !== finalTradeSummary
                || last.globalMemory !== globalMemory
                || last.lastActiveConversationId !== (activeConversationId || undefined)) {
                return true;
            }
            // Settings too. The SETTINGS effect has its own 2500ms debounce, so
            // a toggle flipped and then closed inside that window reported
            // "not dirty" here, the unload flush returned early, and the
            // setting silently reverted on next launch.
            if (!settingsEqual(lastSavedSettingsRef.current as Record<string, unknown> | null, buildSettingsSnapshot())) {
                return true;
            }
            return false;
        },
        save: async (snapshot) => {
            if (!activeUsername || !canPersist()) return;
            await dbService.saveUserProfile(activeUsername, snapshot);
            lastSavedSnapshotRef.current = snapshot;
        },
        onFlushed: () => {
            // Don't touch React state during unload — just log for diagnostics.
            console.log('[App] Flushed pending save on unload');
        },
    });

    return { lastSavedSnapshotRef, buildProfileSnapshot };
};
