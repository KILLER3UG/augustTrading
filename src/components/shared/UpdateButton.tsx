import React from 'react';
import { RefreshCw, AlertCircle, Download, Loader2 } from './Icons';
import { useAutoUpdate } from '../../hooks/useAutoUpdate';
import StatusPill from '../ui/StatusPill';

/**
 * Header-level entry point for the desktop auto-update flow.
 *
 * Handles all states except active download/installation:
 * - idle: quiet version chip + icon-only refresh button
 * - checking: spinner with "Checking…" text
 * - available: Sparkle + v{version} chip + download button
 * - error: error indicator + retry button (with inline caption when verbose)
 *
 * The `downloading`, `downloaded`, and `installing` states are rendered
 * by the full-screen `<UpdateOverlay />` mounted at the app root.
 *
 * In the browser (non-Electron), this component renders nothing.
 */
/**
 * The collapsed nav rail carries update state on one dot.
 *
 * The full `UpdateButton` is a row of words and will not fit in 56px, but
 * dropping the status there entirely is what left the old drawer able to
 * download an update with nothing on screen to say so. This returns a dot —
 * or null when there is genuinely nothing to report — and the account row
 * renders it above the Settings button.
 *
 * The dot is decorative; `UpdateButton` in the expanded panel remains the
 * control that carries the accessible text.
 */
export const useUpdateStatusDot = (): React.ReactNode => {
    const { isElectron, updateStatus } = useAutoUpdate();
    if (!isElectron) return null;

    const { status, error, version, progress } = updateStatus;
    /* A plain pulsing span rather than a lucide glyph: this is a 8px status
     * light, not an icon, and drawing an icon that small is below the 12px
     * floor tests/iconLayer.test.ts holds the rest of the app to. The three
     * "working" states differ by colour, not by shape. */
    const dot = (label: string, className: string, busy = false) => (
        <span
            aria-hidden
            title={label}
            className={`block h-2 w-2 rounded-full ${className} ${busy ? 'animate-pulse' : ''}`}
        />
    );

    switch (status) {
        case 'checking':
            return dot('Checking for updates…', 'bg-cyan-400', true);
        case 'available':
            // This was the last chrome consumer of the brand gradient — one of
            // the three "brand moments" the design reserved it for, alongside the
            // wordmark and the active-nav bar. The gradient was retired on
            // 2026-10-27 and all three went to ink, so an available update is a
            // white dot: brighter than the cyan in-progress states beside it,
            // which is the whole signal it ever carried.
            return dot(`Version ${version} is available`, 'bg-zinc-100');
        case 'downloading':
            return dot(
                Number.isFinite(progress) && progress > 0 ? `Downloading — ${progress}%` : 'Downloading…',
                'bg-accent/30', true,
            );
        case 'upToDate':
            // The check ran and found nothing. Silent before this: the default
            // branch returned null, so a manual check looked like it did nothing.
            return dot('You\'re up to date', 'bg-emerald-500/60');
        case 'downloaded':
            return dot('Ready to restart', 'bg-emerald-500');
        case 'installing':
            return dot('Installing…', 'bg-amber-500/30', true);
        case 'error':
            return dot(error ? `Update error — ${error}` : 'Update error', 'bg-rose-500');
        default:
            return null;
    }
};

export const UpdateButton: React.FC<{ className?: string }> = ({ className = '' }) => {
    const { isElectron, appVersion, updateStatus, checkForUpdates, downloadUpdate, installUpdate } = useAutoUpdate();

    if (!isElectron) return null;

    const { status, error, version, progress } = updateStatus;

    // Installing state is handled by the full-screen overlay
    if (status === 'installing') {
        return null;
    }

    const baseClasses = 'inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-control text-ui-dense font-medium transition-[background-color,box-shadow,transform] duration-[150ms] ease-[var(--ease-snappy)]';
    const iconButtonClasses = 'inline-flex items-center justify-center h-7 w-7 rounded-control text-zinc-400 hover:bg-zinc-800 hover:text-cyan-400 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

    // Checking state — show spinner with text
    if (status === 'checking') {
        return (
            <div className={`flex items-center gap-1.5 ${className}`}>
                <span className="flex items-center gap-1.5 text-ui-dense text-cyan-400" role="status" aria-live="polite">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Checking…
                </span>
            </div>
        );
    }

    // Available state — Sparkle + version chip + download button
    if (status === 'available') {
        return (
            <div className={`flex items-center gap-2 ${className}`}>
                <span
                    className="flex items-center gap-1.5 rounded-control px-2 py-1 text-ui-dense font-medium text-emerald-300"
                    title={`Version ${version} is available`}
                >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    v{version}
                </span>
                <button
                    onClick={downloadUpdate}
                    className={`${baseClasses} bg-emerald-600 hover:bg-emerald-500 text-white hover:shadow-emerald-500/25 active:scale-95`}
                    aria-label={`Download update version ${version}`}
                >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Update
                </button>
            </div>
        );
    }

    // Downloading state — compact downloading pill with progress
    if (status === 'downloading') {
        return (
            <div className={`flex items-center gap-1.5 ${className}`} role="status" aria-live="polite">
                <StatusPill
                    tone="info"
                    className="font-mono tabular-nums"
                    icon={<Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                >
                    {Number.isFinite(progress) && progress > 0 ? `${progress}%` : 'Downloading…'}
                </StatusPill>
            </div>
        );
    }

    // Downloaded state — Restart button to apply
    if (status === 'downloaded') {
        return (
            <div className={`flex items-center gap-1.5 ${className}`}>
                <button
                    onClick={installUpdate}
                    className={`${baseClasses} bg-emerald-600 hover:bg-emerald-500 text-white hover:shadow-emerald-500/25 active:scale-95`}
                    aria-label={`Restart to apply version ${version ?? ''}`}
                >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Restart
                </button>
            </div>
        );
    }

    // Error state — inline caption + retry button
    if (status === 'error') {
        const verboseError = (error || '').length > 30;
        return (
            <div className={`flex items-center gap-2 ${className}`}>
                <span
                    className={`flex items-center gap-1.5 text-ui-dense text-rose-400 ${verboseError ? 'max-w-[260px]' : ''}`}
                    // In the short-error branch the only text on screen is the
                    // generic "Update error", so the real message has to live on
                    // this wrapper; in the verbose branch it moves to the
                    // truncating span below, and a title here would shadow it.
                    title={verboseError ? undefined : (error || '')}
                >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {verboseError && error ? <span className="truncate" title={error}>{error}</span> : 'Update error'}
                </span>
                <button
                    onClick={checkForUpdates}
                    className={`${baseClasses} bg-zinc-800 hover:bg-zinc-700 text-zinc-300`}
                    aria-label="Retry update check"
                >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Retry
                </button>
            </div>
        );
    }

    // Idle state — icon-only refresh + tiny version chip
    return (
        <div className={`flex items-center gap-1.5 ${className}`}>
            {appVersion && (
                <span
                    className="text-ui-xs text-zinc-600 font-mono"
                    title={`Installed version ${appVersion}`}
                >
                    v{appVersion}
                </span>
            )}
            <button
                onClick={checkForUpdates}
                className={iconButtonClasses}
                aria-label="Check for updates"
                title="Check for updates"
            >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
        </div>
    );
};

export default UpdateButton;
