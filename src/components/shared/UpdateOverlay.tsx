import React from 'react';
import { CheckCircle, Wrench, Zap } from './Icons';
import { useAutoUpdate } from '../../hooks/useAutoUpdate';
import { useFocusTrap } from '../../hooks/useFocusTrap';

/**
 * Full-screen overlay shown during the Electron auto-update flow, styled with
 * the same vocabulary as the boot splash (index.css): the shimmering August
 * wordmark, the animated candle row, the hairline progress track and the
 * cycling mono status line. Brand gradient appears only on the wordmark.
 *
 * Shown during active phases only:
 * - downloading: determinate progress — the bar tracks the real percent
 * - downloaded:  ready to install (manual trigger, pop-in check)
 * - installing: "Restarting…" screen; when the animation has played it sends
 *   update:quit-now so main runs quitAndInstall (main also has a timeout
 *   fallback, so a stuck renderer never blocks the update)
 *
 * The `idle`, `checking`, `available`, and `error` states are handled
 * by `UpdateButton` in the header so users have a non-blocking entry point.
 *
 * In the browser (non-Electron) this renders nothing.
 */

const prefersReducedMotion = (): boolean => {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
};

/** The splash's 7-bar candle row — pure decoration, layout is CSS. */
const CandleRow: React.FC = () => (
    <div className="splash-candles" aria-hidden="true">
        <i /><i /><i /><i /><i /><i /><i />
    </div>
);

/** GitHub release bodies are markdown; render them as plain, readable text
 *  (no parser, no dangerouslySetInnerHTML — CSP and safety both prefer it). */
const notesToPlainLines = (raw: string): string[] => raw
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map(l => l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*[-*]\s+/, '• ')
        .replace(/\*\*|__|`/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trimEnd())
    .filter(l => l.trim().length > 0)
    .slice(0, 24);

const renderNoteLine = (line: string, i: number): React.ReactNode => {
    const isBullet = line.startsWith('•');
    const content = isBullet ? line.slice(1).trim() : line;
    const lower = content.toLowerCase();

    if (!isBullet) {
        return <p key={i} className="font-semibold text-zinc-300 mt-2 first:mt-0">{line}</p>;
    }

    let Icon = Zap;
    let iconTone = 'text-cyan-400';
    if (lower.startsWith('fix') || lower.includes('bug') || lower.includes('patch')) {
        Icon = Wrench;
        iconTone = 'text-amber-400';
    } else if (lower.startsWith('perf') || lower.includes('speed') || lower.includes('optim')) {
        Icon = Zap;
        iconTone = 'text-emerald-400';
    }

    return (
        <div key={i} className="flex items-start gap-2 py-0.5">
            <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${iconTone}`} />
            <span className="text-zinc-300">{content}</span>
        </div>
    );
};

const UpdateOverlay: React.FC = () => {
    const { isElectron, updateStatus, installUpdate, quitNow } = useAutoUpdate();
    const { status, progress, version, bytesPerSecond, transferred, total, releaseNotes } = updateStatus;

    // Auto-expand the "What's new" details the first time this version's notes
    // are shown — the user opted into an update, they probably want to read
    // what changed. Persisted in localStorage so subsequent visits to the same
    // version default to collapsed (the new version becomes "background" once
    // they've seen it once).
    const [notesOpen, setNotesOpen] = React.useState<boolean>(false);
    const SEEN_KEY = 'august_update_notes_seen_v1';
    React.useEffect(() => {
        if (status !== 'downloaded' || !version) return;
        try {
            const raw = localStorage.getItem(SEEN_KEY);
            const seen: Record<string, true> = raw ? JSON.parse(raw) : {};
            if (!seen[version]) setNotesOpen(true);
        } catch { /* private mode */ }
    }, [status, version]);
    const onNotesToggle = React.useCallback((ev: React.SyntheticEvent<HTMLDetailsElement>): void => {
        const open = ev.currentTarget.open;
        setNotesOpen(open);
        if (!open || !version) return;
        try {
            const raw = localStorage.getItem(SEEN_KEY);
            const seen: Record<string, true> = raw ? JSON.parse(raw) : {};
            seen[version] = true;
            localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
        } catch { /* private mode */ }
    }, [version]);

    // ETA from electron-updater's live download telemetry.
    const etaLine = React.useMemo(() => {
        if (status !== 'downloading' || !total || !bytesPerSecond) return null;
        const secs = Math.ceil((total - (transferred ?? 0)) / bytesPerSecond);
        if (!Number.isFinite(secs) || secs <= 0) return null;
        const mbps = bytesPerSecond / (1024 * 1024);
        const speed = `${mbps.toFixed(1)} MB/s`;
        const eta = secs >= 60 ? `~${Math.ceil(secs / 60)} min` : secs >= 10 ? `~${secs}s` : '<10s';
        return `${speed} · ${eta} left`;
    }, [status, total, transferred, bytesPerSecond]);

    const notes = React.useMemo(() => (releaseNotes ? notesToPlainLines(releaseNotes) : []), [releaseNotes]);

    // Restart screen: let the animation breathe, then tell main to quit.
    // Reduced motion (or a hidden overlay) → ack almost immediately; main's
    // own timeout covers the case where this component never mounts.
    React.useEffect(() => {
        if (!isElectron || status !== 'installing') return;
        const holdMs = prefersReducedMotion() ? 300 : 1900;
        const timer = window.setTimeout(() => quitNow(), holdMs);
        return () => window.clearTimeout(timer);
    }, [isElectron, status, quitNow]);

    // The overlay claims `aria-modal`, so everything behind it is inert to a
    // screen reader — the phase that asks for a decision therefore has to hold
    // the keyboard too. Only 'downloaded' has a control to reach: trapping
    // 'downloading' or 'installing' would swallow Tab against a card with
    // nothing focusable in it for as long as the update runs.
    const dialogRef = useFocusTrap<HTMLDivElement>(isElectron && status === 'downloaded');

    if (!isElectron) return null;

    // Only show overlay during active download/installation
    if (status !== 'downloading' && status !== 'downloaded' && status !== 'installing') {
        return null;
    }

    return (
        <div
            ref={dialogRef}
            className=" fixed inset-0 z-update flex items-center justify-center bg-zinc-950 animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
            aria-label="Application update in progress"
        >
            <div className="relative w-full max-w-md mx-4 overflow-hidden border border-zinc-800 bg-zinc-900 shadow-2xl rounded-bubble p-8">
                {/* the same soft glow the splash carries, tucked inside the card */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full"
                    style={{ background: 'radial-gradient(closest-side, rgba(255, 255, 255, 0.06), transparent 70%)' }}
                />
                {/* key=phase re-mounts the content, so the fade-in plays on every transition */}
                <div key={status} className="update-phase animate-fade-in">
                    <span className="splash-wordmark mb-1 block">August Trading</span>

                    {status === 'downloading' && (
                        <>
                            <CandleRow />
                            <h2 className="mt-6 text-lg font-semibold text-zinc-100">
                                Updating to v{version}
                            </h2>
                            <p className="mb-6 mt-1 text-ui-base text-zinc-500">Downloading the latest version…</p>
                            <div className="w-full">
                                <div className="update-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                                    <div className="update-bar" style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />
                                </div>
                                <div className="mt-3 flex items-center justify-between">
                                    <span className="text-ui-sm text-zinc-500">Don't close the app</span>
                                    <span className="font-mono text-ui-base font-semibold text-zinc-200">
                                        {progress}%
                                        {etaLine && <span className="ml-2 text-ui-sm font-normal text-zinc-500">{etaLine}</span>}
                                    </span>
                                </div>
                            </div>
                        </>
                    )}

                    {status === 'downloaded' && (
                        <>
                            <div className="update-check-pop my-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                                <CheckCircle className="h-8 w-8 text-emerald-400" aria-hidden="true" />
                            </div>
                            <h2 className="text-lg font-semibold text-zinc-100">Update downloaded</h2>
                            <p className="mb-6 mt-1 text-ui-base text-zinc-500">
                                v{version} is ready. The app will restart to complete the update.
                            </p>
                            {notes.length > 0 && (
                                <details
                                    className="update-notes mb-5 w-full text-left"
                                    data-testid="update-release-notes"
                                    open={notesOpen}
                                    onToggle={onNotesToggle}
                                >
                                    <summary className="cursor-pointer text-ui-sm font-semibold uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300">
                                        What's new in v{version}
                                    </summary>
                                    <div className="mt-2 max-h-44 overflow-y-auto rounded-control border border-hairline bg-zinc-950/60 p-3 text-ui-dense leading-5 text-zinc-400 custom-scrollbar">
                                        {notes.map(renderNoteLine)}
                                    </div>
                                </details>
                            )}
                            <button
                                onClick={installUpdate}
                                className="w-full flex items-center justify-center gap-2 rounded-control bg-emerald-600 px-5 py-3 text-ui-base font-semibold text-white shadow-lg transition-[background-color,box-shadow,transform] duration-[150ms] ease-[var(--ease-snappy)] hover:bg-emerald-500 hover:shadow-emerald-500/25 active:scale-95"
                                aria-label={`Install update version ${version}`}
                            >
                                <Zap className="h-4 w-4" aria-hidden="true" />
                                Install &amp; Restart
                            </button>
                        </>
                    )}

                    {status === 'installing' && (
                        <>
                            <CandleRow />
                            <h2 className="mt-6 text-lg font-semibold text-zinc-100">
                                Restarting with v{version}
                            </h2>
                            <div className="update-status mt-4">
                                <span>Installing the update…</span>
                                <span>Preparing your session…</span>
                                <span>Relaunching August Trading…</span>
                            </div>
                            <p className="mt-4 text-ui-sm text-zinc-600">This takes a moment — see you right after.</p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default UpdateOverlay;
