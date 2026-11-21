import React from 'react';
import { Download } from './Icons';
import { useAutoUpdate } from '../../hooks/useAutoUpdate';
import { shouldShowUpdateButton } from '../../utils/updateAvailability';

/**
 * Header-level entry point for the desktop auto-update flow.
 *
 * Hidden completely when idle, checking, up-to-date, errored, installing, or
 * when the offered version is not strictly newer than the running build.
 * Renders ONLY when a strictly newer release is available, downloading, or
 * downloaded and ready to install, using a clean monochrome Download icon.
 *
 * Manual update checks live in Settings → Profile (`CheckForUpdatesRow`).
 */

/**
 * Compact status indicator dot for collapsed surfaces, shown ONLY when a
 * strictly newer update is available/downloading/downloaded.
 */
export const useUpdateStatusDot = (): React.ReactNode => {
    const { isElectron, appVersion, updateStatus } = useAutoUpdate();
    if (!isElectron || !shouldShowUpdateButton(updateStatus, appVersion)) return null;

    const { status, version, progress } = updateStatus;
    const dot = (label: string, className: string) => (
        <span
            aria-hidden
            title={label}
            className={`block h-2 w-2 rounded-full ${className}`}
        />
    );

    if (status === 'available') {
        return dot(`Update v${version} available`, 'bg-zinc-100');
    }
    if (status === 'downloading') {
        return dot(
            Number.isFinite(progress) && progress > 0 ? `Downloading update — ${progress}%` : 'Downloading update…',
            'bg-zinc-300',
        );
    }
    if (status === 'downloaded') {
        return dot('Update ready — restart to install', 'bg-emerald-400');
    }
    return null;
};

export const UpdateButton: React.FC<{ className?: string }> = ({ className = '' }) => {
    const { isElectron, appVersion, updateStatus, downloadUpdate, installUpdate } = useAutoUpdate();

    if (!isElectron || !shouldShowUpdateButton(updateStatus, appVersion)) {
        return null;
    }

    const { status, version, progress } = updateStatus;
    const baseClasses =
        'inline-flex h-6 items-center justify-center gap-1.5 rounded-control px-2 text-ui-2xs font-medium transition-colors duration-[150ms] ease-[var(--ease-snappy)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400';

    if (status === 'available') {
        return (
            <button
                type="button"
                data-testid="update-button"
                data-update-status="available"
                onClick={downloadUpdate}
                className={`${baseClasses} border border-hairline bg-zinc-900 text-zinc-200 hover:border-line hover:bg-zinc-800 hover:text-zinc-100 ${className}`}
                aria-label={`Download update version ${version}`}
                title={`Download update v${version}`}
            >
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Update v{version}</span>
            </button>
        );
    }

    if (status === 'downloading') {
        return (
            <div
                data-testid="update-button"
                data-update-status="downloading"
                role="status"
                aria-live="polite"
                className={`${baseClasses} border border-hairline bg-zinc-900 font-mono tabular-nums text-zinc-300 ${className}`}
                title={`Downloading update${version ? ` v${version}` : ''}`}
            >
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{Number.isFinite(progress) && progress > 0 ? `${progress}%` : 'Downloading…'}</span>
            </div>
        );
    }

    if (status === 'downloaded') {
        return (
            <button
                type="button"
                data-testid="update-button"
                data-update-status="downloaded"
                onClick={installUpdate}
                className={`${baseClasses} bg-zinc-100 text-zinc-950 hover:bg-white ${className}`}
                aria-label={`Restart to install version ${version ?? ''}`}
                title={`Restart to install v${version ?? ''}`}
            >
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Restart to install</span>
            </button>
        );
    }

    return null;
};

export default UpdateButton;
