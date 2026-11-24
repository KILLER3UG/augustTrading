import React from 'react';
import { useAutoUpdate } from '../../hooks/useAutoUpdate';

/**
 * Full-screen restart curtain shown ONLY during `installing`, after the
 * user explicitly clicks "Restart to update".
 *
 * Background checks, downloads, and the ready-to-restart prompt stay
 * non-intrusive inside `UpdateButton` and Settings → Profile (`Updates`), so
 * background downloads never hijack the active chart or chat session.
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

const UpdateOverlay: React.FC = () => {
    const { isElectron, updateStatus, quitNow } = useAutoUpdate();
    const { status, version } = updateStatus;

    // Restart screen: let the animation breathe, then tell main to quit.
    // Reduced motion (or a hidden overlay) → ack almost immediately; main's
    // own timeout covers the case where this component never mounts.
    React.useEffect(() => {
        if (!isElectron || status !== 'installing') return;
        const holdMs = prefersReducedMotion() ? 300 : 1900;
        const timer = window.setTimeout(() => quitNow(), holdMs);
        return () => window.clearTimeout(timer);
    }, [isElectron, status, quitNow]);

    if (!isElectron || status !== 'installing') {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-update flex items-center justify-center bg-zinc-950 animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
            aria-label="Restarting to install application update"
        >
            <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-bubble border border-zinc-800 bg-zinc-900 p-8 shadow-elevated">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full"
                    style={{ background: 'radial-gradient(closest-side, rgba(255, 255, 255, 0.06), transparent 70%)' }}
                />
                <div className="update-phase animate-fade-in">
                    <span className="splash-wordmark mb-1 block">August Trading</span>
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
                </div>
            </div>
        </div>
    );
};

export default UpdateOverlay;
