/**
 * Learning — the surface that shows how the system decided, and the home of the
 * two panels split off from it (WS-5.1).
 *
 * 2026-11-08 (v4 plan, D2): Skills and Memory became surfaces of their own, so
 * this component now renders ONE panel per surface, chosen by the `tab` prop —
 * the tab bar was chrome for a surface with three destinations, and a surface
 * with one destination does not need it. Learning shows Health (scorecards,
 * lessons, runtime telemetry); Skills shows the library; Memory shows the
 * notebook.
 *
 * The order the tabs used to imply is the loop's own:
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
const NotebookWriteFailurePanel = lazy(() => import('./NotebookWriteFailurePanel'));
const DeclinePanel = lazy(() => import('./DeclinePanel'));

type LearnTab = 'skills' | 'memory' | 'health';

export type { LearnTab };

/** The notebook entry's detail — the one dock this surface opens; the skill
 *  document reads in the Skills surface, not in a second viewer. */
const MEMORY_TOPIC_DOCK = 'memory-topic';

const Fallback: React.FC = () => (
    <div className="p-6 text-ui-dense text-zinc-600">Loading…</div>
);

interface LearnViewProps {
    username: string;
    trades: LoggedTrade[];
    /** The global-memory switch's state, handed straight through to
     *  MemoryFilesManager — which is the ONE writer of this flag (Settings →
     *  Memory kept only a link here). Both optional so the Memory surface still
     *  mounts in tests that don't care; the switch itself only renders when the
     *  setter is supplied. */
    isGlobalMemoryEnabled?: boolean;
    setIsGlobalMemoryEnabled?: (enabled: boolean) => void;
    memoryConfig?: ProviderConfig | null;
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
    /** Which panel this surface shows. Skills, Memory and Learning (Health) are
     *  three surfaces of ONE component (2026-11-08): the surface, not a leftover
     *  preference, decides what is on screen, so there is no tab bar to steer. */
    tab: LearnTab;
}

const LearnView: React.FC<LearnViewProps> = ({
    username, trades, tab, isGlobalMemoryEnabled, setIsGlobalMemoryEnabled,
    memoryConfig = null, renderSkills, reviewSummary = null, reviewLoading = false,
    onRegenerateReview,
}) => {

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
                    <div className="mx-auto w-full max-w-4xl space-y-3 p-3" data-testid="learn-memory">
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
                            {/* The sticky memory write failure — the one signal
                                that says the notebook is NOT on disk. Renders
                                nothing while writes are reaching disk. */}
                            <Suspense fallback={<Fallback />}>
                                <NotebookWriteFailurePanel />
                            </Suspense>
                            {/* The HOLD record — `decline_trade` writes one bounded
                                row per declined setup and this tab is its only
                                reader. Renders nothing while there is no decline. */}
                            <Suspense fallback={<Fallback />}>
                                <DeclinePanel />
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
