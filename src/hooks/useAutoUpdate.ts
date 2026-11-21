import { useState, useEffect, useCallback } from 'react';
import type { ElectronUpdateStatus as UpdateStatus } from '../types/electron';
import { APP_VERSION } from '../constants/version';
import { shouldShowUpdateButton } from '../utils/updateAvailability';

/**
 * Hook for managing app auto-updates in Electron.
 *
 * In the browser (non-Electron), all operations are no-ops and
 * `isUpdateAvailable` is always false.
 *
 * The `window.electronAPI` surface is typed by the ambient global declared
 * next to GenericProviderService's bridge (so no `(window as any)` here); its
 * members are optional (absent on web), hence the `?.` calls.
 *
 * Usage:
 *   const { isElectron, appVersion, updateStatus, checkForUpdates, downloadUpdate, installUpdate } = useAutoUpdate();
 */
const IDLE_STATUS: UpdateStatus = {
    status: 'idle',
    progress: 0,
    version: null,
    error: null,
};

export function useAutoUpdate() {
    const [isElectron, setIsElectron] = useState(false);
    const [appVersion, setAppVersion] = useState<string | null>(APP_VERSION);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(IDLE_STATUS);

    useEffect(() => {
        // Detect if running in Electron
        const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
        if (!electronAPI) return;

        setIsElectron(true);

        // Get current app version
        void electronAPI.getVersion?.().then((v) => {
            if (v) setAppVersion(v);
        });

        // Subscribe to status updates from main process
        const unsubscribe = electronAPI.onUpdateStatus?.((status: UpdateStatus) => {
            setUpdateStatus(status);
        });

        // Fetch initial status
        void electronAPI.getUpdateStatus?.().then((status) => {
            if (status) setUpdateStatus(status);
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, []);

    const installUpdate = useCallback(async () => {
        const electronAPI = window.electronAPI;
        if (!electronAPI) return;
        await electronAPI.installUpdate?.();
    }, []);

    const checkForUpdates = useCallback(async () => {
        const electronAPI = window.electronAPI;
        if (!electronAPI) return;
        await electronAPI.checkForUpdates?.();
    }, []);

    const downloadUpdate = useCallback(async () => {
        const electronAPI = window.electronAPI;
        if (!electronAPI) return;
        await electronAPI.downloadUpdate?.();
    }, []);

    /** Tell main the restart animation is done — quit & install now. Safe to
     *  call repeatedly; main ignores it outside an install. */
    const quitNow = useCallback(() => {
        const electronAPI = window.electronAPI;
        if (!electronAPI) return;
        electronAPI.quitNow?.();
    }, []);

    return {
        isElectron,
        appVersion,
        updateStatus,
        isUpdateAvailable: shouldShowUpdateButton(updateStatus, appVersion),
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        quitNow,
    };
}
