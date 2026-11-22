/**
 * SessionChip — the region chip and its disclosure, extracted from the old
 * content bar (owner 1.3.1 removed that bar; the session read is the one
 * thing it uniquely carried, and it lives beside the dock's bias read now —
 * the trader's "is it Asia or London right now" reads where the market
 * context already is).
 *
 * Self-contained on purpose: everything here comes from SessionService (5s
 * poll, paused when hidden), so no App state is drilled through three
 * components to reach it. The old popover's LIVE MARKET block and its two
 * popover links (Live market view / Vision data) were content-bar furniture
 * and died with it — the market read lives in the agent's `get_market_packet`
 * (the P-1 replacement the parity probe asserts).
 *
 * The disclosure is deliberately a DISCLOSURE, not a trapped modal (O-66
 * names it, and it stays out of the trap list on purpose): focus never leaves
 * the trigger, Escape and a click outside both dismiss it, and its body is a
 * status sheet that can legitimately contain NO control at all — adding a
 * close button would be chrome for the harness's benefit, not the trader's.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIcon } from './Icons';
import {
    getSessionContext, getAllSessionsStatus,
    SessionContext, SessionStatus,
} from '../../services/infrastructure/SessionService';

/** The chip NAMES the region — the trader's question is "is it Asia or
 *  London right now?" — while the popover keeps the tables and the verbose
 *  sessionName ('London/NY Overlap (High Volume)'). 'overlap' is its own
 *  window and names BOTH sides; off_hours says so and carries the next open
 *  in its suffix, so the honest empty state is information, not a dead label.
 *  Keys are SessionService's TradingSession — the data has one source. */
const SESSION_CHIP_LABEL: Record<SessionContext['currentSession'], string> = {
    asian: 'Asia', london: 'London', new_york: 'New York',
    overlap: 'London · NY', off_hours: 'Off hours',
};

const SessionChip: React.FC = () => {
    const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
    const [allSessions, setAllSessions] = useState<SessionStatus[]>([]);
    const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
    const sessionModalRef = useRef<HTMLDivElement>(null);

    // Update session context periodically.
    // Pause when the tab is hidden to save CPU/battery on mobile,
    // and use a 5s interval instead of 1s to reduce re-renders.
    useEffect(() => {
        const updateSessions = () => {
            setSessionContext(getSessionContext());
            setAllSessions(getAllSessionsStatus());
        };

        updateSessions();

        let interval: ReturnType<typeof setInterval>;
        const startInterval = () => {
            interval = setInterval(updateSessions, 5000);
        };
        const stopInterval = () => {
            clearInterval(interval);
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                updateSessions(); // Refresh immediately on return
                startInterval();
            } else {
                stopInterval();
            }
        };

        startInterval();
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            stopInterval();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // Escape and a click outside both put the disclosure away; no focus trap
    // (see the header comment).
    useEffect(() => {
        if (!isSessionModalOpen) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsSessionModalOpen(false);
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isSessionModalOpen]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (sessionModalRef.current && !sessionModalRef.current.contains(event.target as Node)) {
                setIsSessionModalOpen(false);
            }
        };

        if (isSessionModalOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isSessionModalOpen]);

    // Format minutes into hours/min
    const formatDuration = (minutes: number) => {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    };

    if (!sessionContext) return null;

    return (
        <div className="relative flex items-center" ref={sessionModalRef}>
            <button
                type="button"
                data-testid="session-chip"
                onClick={() => setIsSessionModalOpen(!isSessionModalOpen)}
                className="flex items-center gap-1.5 hit-target rounded-full border border-transparent px-2 py-1 text-ui-xs font-medium text-zinc-400 whitespace-nowrap transition-colors duration-[150ms] ease-[var(--ease-snappy)] hover:border-line hover:bg-white/[0.04] hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-zinc-500"
                aria-expanded={isSessionModalOpen}
                aria-controls="session-details-popover"
                aria-haspopup="dialog"
                title={sessionContext.sessionName}
            >
                <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-white/10" />
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${sessionContext.currentSession === 'off_hours' ? 'bg-zinc-600' : 'bg-zinc-300'}`} />
                <span className="flex items-baseline gap-1">
                    <span className="font-medium">{SESSION_CHIP_LABEL[sessionContext.currentSession]}</span>
                    {sessionContext.currentSession === 'off_hours' && (
                        <span className="text-zinc-600">
                            · next {SESSION_CHIP_LABEL[sessionContext.nextSession]} in {formatDuration(sessionContext.minutesToNextSession)}
                        </span>
                    )}
                </span>
            </button>

            {isSessionModalOpen && (
                <div id="session-details-popover" role="dialog" aria-label="Session details" className="motion-popover-down absolute top-full right-0 mr-2 mt-2 w-80 max-sm:fixed max-sm:inset-x-2 max-sm:top-[calc(env(safe-area-inset-top,0px)+4.25rem)] max-sm:mt-0 max-sm:w-auto bg-zinc-900/95 border border-white/[0.08] rounded-xl shadow-elevated backdrop-blur-md overflow-hidden z-drawer">
                    <div className="p-3 bg-zinc-900">
                        <div className="text-ui-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Sessions</div>
                        <div className="space-y-2">
                            {allSessions.map(session => (
                                <div key={session.id} className="flex items-center justify-between text-ui-sm py-0.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session.isOpen ? 'bg-zinc-300' : 'bg-zinc-700'}`} />
                                        <span className={session.isOpen ? 'text-white font-medium truncate' : 'text-zinc-500 truncate'} title={session.name.replace(' Session', '')}>{session.name.replace(' Session', '')}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <span className="text-ui-2xs px-1.5 py-0 rounded-full border whitespace-nowrap border-hairline text-zinc-300 bg-white/[0.04]">
                                            {session.volatility}
                                        </span>
                                        <div className="text-right w-28 whitespace-nowrap relative">
                                            {session.isOpen ? (
                                                <span className="text-ui-xs text-zinc-300 font-mono">
                                                    Closes in {formatDuration(session.closesInMinutes)}
                                                </span>
                                            ) : (
                                                <span className="text-ui-xs text-zinc-500 font-mono">
                                                    Opens in {formatDuration(session.opensInMinutes)}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {sessionContext.warnings.length > 0 && (
                            <div className="mt-3 pt-2 border-t border-hairline">
                                <div className="flex items-center gap-1.5 text-zinc-300 mb-1">
                                    <ActivityIcon className="w-3 h-3" aria-hidden="true" />
                                    <span className="text-ui-xs font-bold">Market Condition</span>
                                </div>
                                <div className="text-ui-xs text-zinc-400 leading-tight">
                                    {sessionContext.warnings[0]}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default React.memo(SessionChip);
