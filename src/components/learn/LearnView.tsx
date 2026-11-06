/**
 * Learning — one surface for everything the system knows and how it decided that
 * (WS-5.1).
 *
 * The information architecture is the loop's own order:
 *
 *   Skills → Memory → Health
 *   where it lives   what it reads   whether it's sound
 *
 * The APPROVALS tab (the old Coach tab) was removed by owner ruling
 * (2026-11-03). Skills are documents now, written by the model's `skill_write`
 * or the library; memory corrections have been direct writes since
 * 2026-10-29. There is nothing left to approve, so there is no
 * tab to click it in.
 *
 * The playbook LIBRARY is deliberately not a tab here: StrategyStudio is the
 * one owner of that table, it has its own surface (Alt+3), and mounting it a
 * second time from here left it without the onClose the Studio surface passes —
 * which made its "Try in chat" a dead button. Memory mounts this surface's own
 * notebook browser rather than reimplementing it.
 */

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Gauge, Layers } from '../shared/Icons';
import type { LoggedTrade } from '../../types';
import type { ProviderConfig } from '../../types/provider';
import PatternMemoryCard from './PatternMemoryCard';
import MemoryTopicsCard from './MemoryTopicsCard';
import RightPanel from '../shell/RightPanel';
import { useRightPanel } from '../../hooks/useRightPanel';
import MemoryTopicPanel from './MemoryTopicPanel';

const MemoryFilesManager = lazy(() => import('./MemoryFilesManager'));
const HarnessLessonsBrowser = lazy(() =>
    import('../settings/HarnessLessonsBrowser').then(m => ({ default: m.HarnessLessonsBrowser })));
const LearningDashboard = lazy(() => import('../dashboards/LearningDashboard'));
const VersionHistoryDashboardLazy = lazy(() =>
    import('../dashboards/VersionHistoryDashboard').then(m => ({ default: m.VersionHistoryDashboard })));
const SessionUsagePanel = lazy(() => import('../settings/SessionUsagePanel'));
const DiagnosticsPanel = lazy(() =>
    import('../settings/DiagnosticsPanel').then(m => ({ default: m.DiagnosticsPanel })));

type LearnTab = 'skills' | 'memory' | 'health';

export type { LearnTab };

const TAB_KEY = 'learn_tab_v1';

/** The notebook entry's detail — the one dock this surface opens; the skill
 *  document reads in the Skills tab, not in a second viewer. */
const MEMORY_TOPIC_DOCK = 'memory-topic';

const TABS: Array<{ id: LearnTab; label: string; Icon: React.FC<{ className?: string }> }> = [
    // The library the desk learns FROM, moved here from Settings — one view for
    // everything the app believes, rather than a tab in a dialog about the app.
    // Leads the row since the Approvals tab's removal (2026-11-03): skills are
    // what this surface is for.
    { id: 'skills', label: 'Skills', Icon: Layers },
    { id: 'memory', label: 'Memory', Icon: BookOpen },
    { id: 'health', label: 'Health', Icon: Gauge },
];


const Fallback: React.FC = () => (
    <div className="p-6 text-ui-dense text-zinc-600">Loading…</div>
);

interface LearnViewProps {
    username: string;
    trades: LoggedTrade[];
    /** The global-memory switch's state, handed straight through to
     *  MemoryFilesManager — which is the ONE writer of this flag (Settings →
     *  Memory kept only a link here). Both optional so the Memory tab still
     *  mounts in tests that don't care; the switch itself only renders when the
     *  setter is supplied. */
    isGlobalMemoryEnabled?: boolean;
    setIsGlobalMemoryEnabled?: (enabled: boolean) => void;
    memoryConfig?: ProviderConfig | null;
    /** Set by a caller that wants a SPECIFIC tab (Settings → "open the
     *  notebook"). Cleared by onInitialTabConsumed once applied — same contract
     *  the Journal uses for its deep link — so a later mount honours the user's
     *  own last tab instead of re-firing a stale link. */
    initialTab?: LearnTab | null;
    onInitialTabConsumed?: () => void;
    /** The skill library (Studio + trade plans + forged tools). Handed in as a
     *  node because the Studio reads the live regime and owns the strategy
     *  search, neither of which this surface has. */
    renderSkills?: () => React.ReactNode;
    /** The journal review's pattern synthesis — moved out of the Journal's
     *  trade log (2026-10-07). App supplies the review text, its loading flag
     *  and the regenerate handler; without them the card still reads the
     *  notebook file, minus the regenerate affordance. */
    reviewSummary?: string | null;
    reviewLoading?: boolean;
    onRegenerateReview?: () => void;
}

const LearnView: React.FC<LearnViewProps> = ({
    username, trades, isGlobalMemoryEnabled, setIsGlobalMemoryEnabled,
    memoryConfig = null, initialTab, onInitialTabConsumed,
    renderSkills, reviewSummary = null, reviewLoading = false, onRegenerateReview,
}) => {
    const [tab, setTab] = useState<LearnTab>(() => {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(TAB_KEY) : null;
        // The notebook is this surface's own screen: Skills is a destination of
        // its own (the rail's Skills row), so defaulting here would make the two
        // rows render one view. A stored id from before the Approvals removal
        // ('coach', or the older 'queue'/'system') falls through to here too.
        return TABS.some(t => t.id === saved) ? (saved as LearnTab) : 'memory';
    });

    useEffect(() => {
        if (!initialTab) return;
        setTab(initialTab);
        onInitialTabConsumed?.();
    }, [initialTab, onInitialTabConsumed]);

    useEffect(() => {
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
    }, [tab]);

    // ── The right-panel shell ─────────────────────────────────────────────
    // Right-panel contract: the hook owns geometry and lifecycle, the layout
    // below owns where the width lands, and the panel itself owns what a
    // notebook entry looks like when it is READ rather than edited.
    const rightPanel = useRightPanel({ surface: 'learn', defaultWidth: 480, minWidth: 340, maxWidth: 760 });

    useEffect(() => {
        // `register` is stable; the hook object changes identity on every width
        // commit, and re-announcing per drag tick is pure noise.
        rightPanel.register({ id: MEMORY_TOPIC_DOCK, label: 'Entry' });
    }, [rightPanel.register]);

    // ── The memory topic detail (gaps 2 + 3) ─────────────────────────────
    const [topicFileId, setTopicFileId] = useState<string | null>(null);

    const openMemoryTopic = useCallback((fileId: string): void => {
        setTopicFileId(fileId);
        rightPanel.open(MEMORY_TOPIC_DOCK);
    }, [rightPanel]);

    const closePanel = useCallback((id: string): void => {
        rightPanel.close(id);
    }, [rightPanel]);

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface-page" data-testid="learn-view">
            <nav className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/30 px-4 py-2" aria-label="Learning sections">
                <span className="mr-3 hidden text-ui-caption font-semibold tracking-[-0.01em] text-zinc-200 lg:inline">Learning</span>
                {TABS.map(({ id, label, Icon }) => {
                    const active = tab === id;
                    return (
                        <button key={id} type="button" onClick={() => setTab(id)}
                            aria-current={active ? 'true' : undefined} data-testid={`learn-tab-${id}`}
                            className={`flex items-center gap-1.5 rounded-control px-3 py-1.5 text-ui-sm font-medium transition-colors duration-[120ms] ease-[var(--ease-snappy)] ${
                                active
                                    ? 'bg-zinc-800 text-zinc-100 ring-1 ring-white/[0.06]'
                                    : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
                            }`}>
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            {label}
                        </button>
                    );
                })}
            </nav>

            {/* `relative` anchors the panel's hidden (out-of-flow) state, which
                is how the shell preserves a panel's scroll offset without a
                closed one taking a column of width. */}
            <div className="relative flex min-h-0 flex-1">
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                {tab === 'skills' && (
                    <div className="min-h-0 flex-1" data-testid="learn-skills">
                        {renderSkills ? renderSkills() : null}
                    </div>
                )}

                {tab === 'memory' && (
                    <div className="mx-auto w-full max-w-4xl space-y-3 p-3">
                        {/* The synthesis first — it is what the memory is FOR;
                            the notebook browser below holds the raw files. */}
                            <PatternMemoryCard
                                trades={trades}
                                finalSummary={reviewSummary}
                                isLoading={reviewLoading}
                                onRegenerate={onRegenerateReview}
                            />
                            {/* CONTENT before STORAGE: the topic index reads the
                                notebook the way the reference reads memory — named
                                entries with summaries — and only then does the raw
                                file manager follow. */}
                            <MemoryTopicsCard onOpenTopic={openMemoryTopic} />
                        {/* The boundary wraps ONLY the lazy file manager. One
                            boundary over the whole tab made the rows below it
                            wait on a chunk nothing above needs, so the tab
                            painted "Loading…" instead of its content. */}
                        <Suspense fallback={<Fallback />}>
                            <MemoryFilesManager
                                username={username}
                                memoryConfig={memoryConfig}
                                isGlobalMemoryEnabled={isGlobalMemoryEnabled}
                                setIsGlobalMemoryEnabled={setIsGlobalMemoryEnabled}
                            />
                        </Suspense>
                    </div>
                )}

                {tab === 'health' && (
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3">
                        <div data-testid="learn-signals">
                            <Suspense fallback={<Fallback />}>
                                <LearningDashboard trades={trades} username={username} />
                            </Suspense>
                        </div>
                        <Suspense fallback={<Fallback />}>
                            <HarnessLessonsBrowser />
                        </Suspense>

                        {/* Runtime telemetry — the old System tab. */}
                        <div className="flex flex-col gap-3" data-testid="learn-system">
                            <Suspense fallback={<Fallback />}>
                                <VersionHistoryDashboardLazy />
                            </Suspense>
                            <Suspense fallback={<Fallback />}>
                                <SessionUsagePanel />
                            </Suspense>
                            <Suspense fallback={<Fallback />}>
                                <DiagnosticsPanel />
                            </Suspense>
                        </div>
                    </div>
                )}

                </div>

                <RightPanel
                    presentation={rightPanel.presentation}
                    isResizing={rightPanel.isResizing}
                    width={rightPanel.width}
                    isActive={rightPanel.isOpen}
                    isHidden={!rightPanel.isOpen}
                    docks={rightPanel.docks}
                    openIds={rightPanel.openIds}
                    activeId={rightPanel.activeId}
                    onSelectDock={rightPanel.setActive}
                    onCloseDock={closePanel}
                    onResizeStart={rightPanel.startResize}
                    onResizeReset={rightPanel.resetWidth}
                    label="Learning panels"
                    testId="learn-right-panel"
                    className="border-l border-zinc-800/80 bg-zinc-900 lg:w-[var(--panel-w)]"
                >
                    {rightPanel.activeId === MEMORY_TOPIC_DOCK && topicFileId
                        ? <MemoryTopicPanel fileId={topicFileId}
                            username={username}
                            memoryConfig={memoryConfig}
                            onClose={() => closePanel(MEMORY_TOPIC_DOCK)} />
                        : null}
                    {/* Neither dock selected but the shell is open (a stale id):
                        say so rather than rendering an empty box that reads as a
                        broken feature. */}
                    {rightPanel.isOpen && rightPanel.activeId !== MEMORY_TOPIC_DOCK
                        ? <p className="p-4 text-ui-dense text-zinc-500">Nothing selected to read.</p>
                        : null}
                </RightPanel>
            </div>
        </div>
    );
};

export default React.memo(LearnView);
