import React, { memo, useState, useEffect, useRef } from 'react';
import { UpdateButton } from './UpdateButton';
import { ActivityIcon } from './Icons';
import NavExpandButton from '../shell/NavExpandButton';
import StatusCluster from '../shell/StatusCluster';
import { getSessionContext, getAllSessionsStatus, SessionContext, SessionStatus } from '../../services/infrastructure/SessionService';
import { baseOf } from '../../utils/symbol';

interface HeaderProps {
    saveStatus: 'SAVED' | 'SAVING' | 'ERROR';
    isAnalysisInProgress: boolean;
    currentVisionData: string[];
    // Network status
    isOnline?: boolean;
    pendingQueueCount?: number;
    // Live market conditions
    liveMarketConditions?: {
        volatility: 'High' | 'Medium' | 'Low';
        liquidation: 'High' | 'Medium' | 'Low';
        lastUpdated: string;
    } | null;
    /** The instrument `liveMarketConditions` was sampled from. The label binds
     *  to it instead of naming a symbol of its own. */
    liveMarketSymbol?: string;
    // Toolbar entries that stayed in the header when the drawer was retired.
    /** Opens the Activity drawer: the app’s detached skill evaluations. */
    onOpenActivity?: () => void;
    /** Session-popover footer links. The rail's "Live Market" and "View Vision
     *  Data" rows landed here (stage 3): the popover is already the market-
     * context home, so the full-screen market view is one hop from it. */
    onOpenLiveMarket?: () => void;
    onOpenVisionData?: () => void;
    hasVisionData?: boolean;
    /** Present only while the NavRail is hidden (D2 amendment): the collapsed
     *  rail is 0px, so the expand affordance moves here. The DSH pattern —
     *  the hidden sidebar's expand button also carries the update-status dot,
     *  so the one quiet status carrier stays visible in the resting view. */
    onExpandNavRail?: () => void;
    /** What the content column is about: the conversation's name on Analyze, or
     *  the record surface's name. The rail carries the workspace, so the bar
     *  carries the thing being worked on. */
    title?: React.ReactNode;
    /** The instrument line beside the title (`BTC/USDT · 4h`). Omitted when the
     *  surface has no market context of its own. */
    context?: React.ReactNode;
    /** The band's own status cluster, overridable so the App can build it ONCE
     *  and hand the same node around. Absent, the band wires its own. */
    status?: React.ReactNode;
}

// Memoized: Header re-renders every time App does (typing, progress ticks);
// with stable props it only renders when something it actually shows changes.
export const Header: React.FC<HeaderProps> = memo(({
    saveStatus,
    isOnline = true,
    liveMarketConditions,
    liveMarketSymbol,
    onOpenActivity,
    onOpenLiveMarket,
    onOpenVisionData,
    hasVisionData = false,
    onExpandNavRail,
    title,
    context,
    status,
}) => {
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

    // Esc closes the session modal. This used to also close the navigation
    // drawer and trap Tab inside it — both of which died with the drawer (D2).
    // The trap in particular was correct there and is simply not a thing for a
    // panel that is always on screen: trapping focus inside navigation that
    // sits beside the content would make the app unusable.
    //
    // The session popover is deliberately a DISCLOSURE, not a trapped modal
    // (O-66 names it, and it stays out of the trap list on purpose): focus
    // never leaves the trigger, Escape and a click outside both dismiss it, and
    // its body is a status sheet that can legitimately contain NO control at
    // all — the two links at its foot render only when the host passes them.
    // `useFocusTrap` on such a sheet swallows Tab against zero focusables, so
    // the keyboard would lock for as long as the popover was open. Adding the
    // trap would mean adding a close button purely to give the trap something
    // to focus, and that is chrome for the harness's benefit, not the trader's.
    useEffect(() => {
        if (!isSessionModalOpen) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsSessionModalOpen(false);
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isSessionModalOpen]);

    // Close session modal when clicking outside
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

    return (
        <header className="sticky top-0 z-20 flex-shrink-0 border-b border-white/[0.06] bg-zinc-950/90 backdrop-blur px-3 sm:px-5 pt-[calc(env(safe-area-inset-top,0px)+0px)]">
            <div className="flex h-14 items-stretch justify-between gap-3">
                <div className="flex min-w-0 items-stretch gap-2 sm:gap-4">
                    {onExpandNavRail && (
                        <div className="flex items-center">
                            <NavExpandButton onExpand={onExpandNavRail} />
                        </div>
                    )}
                    {/* The A-mark, and only the mark: the rail has no brand row
                        (the reference puts the wordmark nowhere), so this is
                        the one brand cue in the shell. The word "August" used
                        to sit beside it and repeated what the window already
                        says. */}
                    <div className="flex select-none items-center gap-2 self-center" aria-label="August">
                        <svg className="h-6 w-6" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 2 21.5 21h-5.1L12 11.4 7.6 21H2.5L12 2Z" fill="var(--color-zinc-100)" />
                            <rect x="9.1" y="15.7" width="5.8" height="1.5" rx=".75" fill="var(--color-zinc-950)" />
                        </svg>
                    </div>
                    {/* The content title. Navigation is not here at any width:
                        the rail carries it, and when the rail is away the
                        expand button beside this title is the only way back. */}
                    <div className="flex min-w-0 items-center gap-2">
                        <span
                            data-testid="header-surface-label"
                            className="min-w-0 truncate text-ui-sm font-medium text-zinc-200"
                            title={typeof title === 'string' ? title : undefined}
                        >
                            {title}
                        </span>
                        {context && (
                            <>
                                <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-white/10" />
                                <span className="hidden min-w-0 truncate text-ui-xs text-zinc-500 sm:inline">
                                    {context}
                                </span>
                            </>
                        )}
                    </div>
                </div>
                {/* Right side: the live session state and the shell's status
                    cluster only. The gear and the account disc moved off this
                    edge — Settings already has two homes (the Agents account
                    row and ⌘/Ctrl+,) and the disc was a second door to the same
                    settings modal. An edge with no job is not an edge worth
                    decorating. */}
                <div className="flex shrink-0 items-center gap-1.5 self-center">
                    {/* Session Display — the design's live-feed pill, carrying
                        REAL session state; the popover keeps the market
                        conditions and the session table. */}
                    {sessionContext && (
                        <div className="static sm:relative" ref={sessionModalRef}>
                            <button
                                onClick={() => setIsSessionModalOpen(!isSessionModalOpen)}
                                className="flex items-center gap-1.5 hit-target rounded-full border border-transparent px-2 py-1 text-ui-xs font-medium text-zinc-400 whitespace-nowrap transition-colors duration-[150ms] ease-[var(--ease-snappy)] hover:border-white/[0.08] hover:bg-white/[0.04] hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-zinc-500"
                                aria-expanded={isSessionModalOpen}
                                aria-controls="session-details-popover"
                                aria-haspopup="dialog"
                            >
                                <span className={`h-1.5 w-1.5 rounded-full ${sessionContext.isKillZone ? 'bg-rose-500 animate-pulse' :
                                    sessionContext.currentSession === 'off_hours' ? 'bg-zinc-500' : 'bg-emerald-500 shadow-[0_0_0_3px_rgba(7,181,106,0.12)]'
                                    }`} />
                                <span className={sessionContext.isKillZone ? 'text-rose-400' : ''}>
                                    {sessionContext.currentSession === 'overlap' ? 'Ldn/NY' :
                                        sessionContext.currentSession === 'new_york' ? 'NY' :
                                            sessionContext.currentSession === 'london' ? 'London' :
                                                sessionContext.currentSession === 'asian' ? 'Asia' : 'Off'}
                                </span>
                            </button>

                            {/* Session Details Modal — a disclosure, not
                                a modal: see the no-trap note above. */}
                            {isSessionModalOpen && (
                                     <div id="session-details-popover" role="dialog" aria-label="Session details" className="absolute top-full left-0 sm:left-auto sm:right-0 mt-4 sm:mt-2 w-80 bg-zinc-900 border border-white/10 rounded-bubble shadow-2xl overflow-hidden z-drawer animate-fade-in">
                                    <div className="p-3 bg-zinc-900">
                                        {/* Live Market Conditions Section */}
                                        {liveMarketConditions && (
                                            <div className="mb-3 p-2 bg-zinc-800 rounded-control border border-white/5">
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <div className="text-ui-xs font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-1">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-300 animate-pulse" />
                                                        LIVE MARKET{liveMarketSymbol ? ` (${baseOf(liveMarketSymbol)})` : ''}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-ui-xs px-2 py-0.5 rounded-full border font-medium ${liveMarketConditions.volatility === 'High' ? 'border-rose-500/40 text-rose-400 bg-rose-500/15' :
                                                        liveMarketConditions.volatility === 'Medium' ? 'border-amber-500/40 text-amber-400 bg-amber-500/15' :
                                                            'border-emerald-500/40 text-emerald-400 bg-emerald-500/15'
                                                        }`}>
                                                         {liveMarketConditions.volatility} Volatility
                                                    </span>
                                                    <span className={`text-ui-xs px-2 py-0.5 rounded-full border font-medium ${liveMarketConditions.liquidation === 'High' ? 'border-zinc-300/40 text-zinc-200 bg-zinc-300/15' :
                                                        liveMarketConditions.liquidation === 'Medium' ? 'border-zinc-500/40 text-zinc-400 bg-zinc-500/15' :
                                                            'border-zinc-700/40 text-zinc-500 bg-zinc-700/15'
                                                        }`}>
                                                         {liveMarketConditions.liquidation} Liq
                                                    </span>
                                                </div>
                                            </div>
                                        )}
                                        <div className="text-ui-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Sessions</div>
                                        <div className="space-y-2">
                                            {allSessions.map(session => (
                                                <div key={session.id} className="flex items-center justify-between text-ui-sm py-0.5">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session.isOpen ? 'bg-emerald-500 shadow-[0_0_8px_rgba(7,181,106,0.6)]' : 'bg-zinc-700'}`} />
                                                        <span className={session.isOpen ? 'text-white font-medium truncate' : 'text-zinc-500 truncate'} title={session.name.replace(' Session', '')}>{session.name.replace(' Session', '')}</span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                                        <span className={`text-ui-2xs px-1.5 py-0 rounded-full border whitespace-nowrap ${session.volatility === 'High' ? 'border-rose-500/30 text-rose-400 bg-rose-500/10' :
                                                            session.volatility === 'Medium' ? 'border-amber-500/30 text-amber-400 bg-amber-500/10' :
                                                                'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                                                            }`}>
                                                             {session.volatility}
                                                        </span>
                                                        <div className="text-right w-20 whitespace-nowrap relative">
                                                            {session.isOpen ? (
                                                                <span className="text-ui-xs text-emerald-400 font-mono">
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
                                            <div className="mt-3 pt-2 border-t border-white/5">
                                                <div className="flex items-center gap-1.5 text-amber-400 mb-1">
                                                    <ActivityIcon className="w-3 h-3" aria-hidden="true" />
                                                    <span className="text-ui-xs font-bold">Market Condition</span>
                                                </div>
                                                <div className="text-ui-xs text-zinc-400 leading-tight">
                                                    {sessionContext.warnings[0]}
                                                </div>
                                            </div>
                                        )}
                                        {(onOpenLiveMarket || (onOpenVisionData && hasVisionData)) && (
                                            <div className="mt-3 flex items-center gap-3 border-t border-white/5 pt-2">
                                                {onOpenLiveMarket && (
                                                    <button type="button" data-testid="session-open-live-market"
                                                        onClick={() => { setIsSessionModalOpen(false); onOpenLiveMarket(); }}
                                                        className="text-ui-xs text-zinc-400 underline-offset-2 transition-colors hover:text-zinc-200 hover:underline">
                                                        Live market view
                                                    </button>
                                                )}
                                                {onOpenVisionData && hasVisionData && (
                                                    <button type="button" data-testid="session-open-vision-data"
                                                        onClick={() => { setIsSessionModalOpen(false); onOpenVisionData(); }}
                                                        className="text-ui-xs text-zinc-400 underline-offset-2 transition-colors hover:text-zinc-200 hover:underline">
                                                        Vision data
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                    {status ?? (
                        <StatusCluster
                            saveStatus={saveStatus}
                            isOnline={isOnline}
                            onOpenActivity={onOpenActivity}
                        />
                    )}
                    {/* The update control's ONLY reachable home. It used to live in
                        the NavRail, which nothing rendered, so an available update
                        had no action anywhere in the app and the overlay's
                        'available' state was excluded on purpose
                        (the 2026-10-27 audit §8). The button renders nothing unless
                        Electron has something to say. */}
                    <UpdateButton />
                </div>
            </div>
        </header >
    );
});
