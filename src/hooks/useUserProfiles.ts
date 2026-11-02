import { useState } from 'react';
import * as dbService from '../services/infrastructure/dbService';
import { isValidUserProfile } from '../utils/profileUtils';
import { exportDataAsFile, exportPreferencesData, importPreferencesData } from '../services/infrastructure/ExportService';
import { clearQueueForUser } from '../services/infrastructure/OfflineQueueService';
import { phtDayKey } from '../utils/timezone';

export interface UseUserProfilesParams {
    resetAppState: (usernameToSave?: string | null) => Promise<void>;
    setIsUserModalOpen: (v: boolean) => void;
    setIsSettingsVisible: (v: boolean) => void;
    toast: { success: (t: string, m?: string) => void; error: (t: string, m?: string) => void; info: (t: string, m?: string) => void };
    /** Non-blocking styled confirmation dialog (replaces native window.confirm). */
    confirmDialog?: (opts: {
        title: string;
        message?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        destructive?: boolean;
        undoGraceMs?: number;
        onUndo?: () => void | Promise<void>;
    }) => Promise<boolean>;
}

/**
 * Custom hook that encapsulates user profile management state and handlers.
 * Extracted from App.tsx to reduce component complexity.
 */
export const useUserProfiles = (params: UseUserProfilesParams) => {
    const { resetAppState, setIsUserModalOpen, setIsSettingsVisible, toast, confirmDialog } = params;

    // ─── State ────────────────────────────────────────────────────────────
    const [activeUsername, setActiveUsername] = useState<string | null>(null);
    const [existingUsernames, setExistingUsernames] = useState<string[]>([]);
    const [saveStatus, setSaveStatus] = useState<'SAVED' | 'SAVING' | 'ERROR'>('SAVED');

    // ─── Handlers ─────────────────────────────────────────────────────────
    const handleImportData = async (fileContent: string) => {
        try {
            const data = JSON.parse(fileContent);
            if (isValidUserProfile(data)) {
                await dbService.overwriteUserProfile(data);
                // Restore the preferences backup (providers, lens config,
                // alerts, model performance) that handleExportData captures —
                // it was silently dropped before, so imports lost every
                // provider setup and API key.
                const prefsBackup = (data as unknown as Record<string, unknown>)?._preferencesBackup;
                if (prefsBackup && typeof prefsBackup === 'object') {
                    try {
                        const report = await importPreferencesData(prefsBackup as Record<string, any>);
                        // Non-silent skip reporting (finding F12): the backup
                        // sweep exports every key it can read, but restores
                        // are gated by the allow-list — surface what did NOT
                        // make it instead of pretending a full restore.
                        const skipNote = report.skippedKeys.length > 0
                            ? ` ${report.skippedKeys.length} setting(s) had no restorable slot in this build and were skipped (${report.skippedKeys.join(', ')}).`
                            : '';
                        toast.success("Profile Imported", `Profile and provider settings restored.${skipNote} Please select the user to log in.`);
                    } catch (prefsError) {
                        console.warn('[Import] Preferences restore failed (non-fatal):', prefsError);
                        toast.info("Profile Imported", "Profile restored, but provider settings could not be restored.");
                    }
                } else {
                    toast.success("Profile Imported", "Please select the user to log in.");
                }
                const users = await dbService.getAllUsernames();
                setExistingUsernames(users);
            } else {
                toast.error("Import Failed", "Invalid profile data format.");
            }
        } catch (e) {
            toast.error("Import Failed", "Failed to parse import file.");
        }
    };

    const handleDeleteUser = async (username: string): Promise<void> => {
        const ok = confirmDialog
            ? await confirmDialog({ title: `Delete user "${username}"?`, message: 'This cannot be undone.', destructive: true })
            : confirm(`Are you sure you want to delete user "${username}"? This cannot be undone.`);
        if (ok) {
            await dbService.deleteUserProfile(username);
            // Drop the deleted profile's pending offline-queue work too — items
            // stamped with their enqueueing username (clearQueueForUser only
            // removes that user's entries; other profiles' queues survive,
            // and legacy unstamped items can't be attributed). Non-fatal: an
            // IndexedDB hiccup must not abort the rest of the delete cascade.
            try {
                await clearQueueForUser(username);
            } catch (e) {
                console.warn('[useUserProfiles] Failed to clear offline queue for deleted user:', e);
            }
            setExistingUsernames(prev => prev.filter(u => u !== username));
            if (activeUsername === username) {
                setActiveUsername(null);
                // resetAppState(null): do NOT persist — the closure's
                // activeUsername still holds the deleted name, and saving
                // would resurrect the user as a blank profile.
                resetAppState(null);
                // Same singleton resets as loadUserData: the autopilot loop
                // must stop kline-verifying the deleted user's registrations,
                // and the insights cache / last_active_user must not point at
                // a deleted profile until the next user loads.
                const { OutcomeAutopilotService } = await import('../services/ui/OutcomeAutopilotService');
                OutcomeAutopilotService.reset();
                const { resetTracker } = await import('../services/tracking/trackerService');
                resetTracker();
                const { setAttributedInsightsUser } = await import('../services/learning/PatternMemorySynthesisService');
                setAttributedInsightsUser(null);
                setIsUserModalOpen(true);
            }
        }
    };

    const handleSwitchUser = () => {
        setIsUserModalOpen(true);
        setIsSettingsVisible(false);
    };

    const handleExportData = async () => {
        if (!activeUsername) return;
        const profile = await dbService.getUserProfile(activeUsername);
        if (profile) {
            // Create comprehensive backup including preferences settings
            const fullBackup = {
                ...profile,
                _exportedAt: new Date().toISOString(),
                _appVersion: '3.5',
                _preferencesBackup: await exportPreferencesData(),
            };

            const filename = `august_backup_${activeUsername}_${phtDayKey()}.json`;
            const result = await exportDataAsFile(fullBackup, filename);

            if (!result.success) {
                toast.error("Export Failed", result.error);
            } else {
                toast.success("Export Complete", "Backup saved. API keys were excluded; reconnect providers after restoring on a new device.");
            }
        }
    };

    return {
        activeUsername, setActiveUsername,
        existingUsernames, setExistingUsernames,
        saveStatus, setSaveStatus,
        handleImportData,
        handleDeleteUser,
        handleSwitchUser,
        handleExportData,
    };
};
