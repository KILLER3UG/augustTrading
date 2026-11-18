
import React, { useState, useEffect, useMemo, useRef } from 'react';
import TradeLogContent from './TradeLog';
import { WeeklyReviewCard } from './WeeklyReviewCard';
import { HarnessOptimizationCard } from './HarnessOptimizationCard';
import { askDesk } from '../../utils/askDesk';
import { MonthlyReportCard } from './MonthlyReportCard';
import SignalFeed from './SignalFeed';
import {HistoryIcon, ChartBarIcon, FileSpreadsheet, FileText, TargetIcon} from '../shared/Icons';

import { exportTradesCSV, exportTradesHTML } from '../../utils/reportExport';
import { LoggedTrade, TradeOutcome } from '../../types';
import { computeJournalStats } from '../../utils/journalAnalytics';
import { getActiveUsername } from '../../utils/activeUser';
import { useEscapeClose } from '../../hooks/useEscapeClose';

interface JournalProps {
    isVisible: boolean;
    onClose: () => void;
    /** The Journal covers all logged trades: the ledger and the stats read
     *  over it. The old models/reasoning/learning/memory tabs are gone
     *  (2026-10-07) and the saved-analyses tab went with the debate that
     *  wrote them (2026-10-18) — a stale hash or old bookmark folds to the
     *  ledger in resolveTab. */
    initialTab: 'log' | 'analytics';
    /** Monotonic counter bumped by App on every openJournal. Re-apply the
     *  requested tab whenever THIS moves — re-opening the SAME tab while
     *  mounted changes no prop and was silently dropped by value-diffing. */
    openNonce?: number;
    /** Active user — scopes per-user lookups (falls back to localStorage). */
    username?: string;

    // Trade Log Props
    trades: LoggedTrade[];
    onDeleteTrades: (ids: string[]) => void;
    /** Optional while App's wiring lands in the next slice — the ledger
     *  degrades to a chat-only audit note until the restore bridge exists. */
    onClearAllTrades?: () => void;
    /** Undo bridge for the bulk-void gate in TradeLog. Threaded from App's
     *  `handleRestoreTrades`; absent until that wiring lands. */
    onRestoreTrades?: (trades: LoggedTrade[]) => void;
    modelIdToName: Record<string, string>;
    onUpdateInsights: (ids: string[]) => void;
    isSummarizing?: boolean;
    currentInsightIds: string[];
    /** (i/n) progress for manual insight-generation loops. */
    insightProgress?: { done: number; total: number } | null;
    /** Correct a mis-logged outcome from the expanded card. */
    onUpdateOutcome?: (id: string, outcome: TradeOutcome) => void;
    /** Edit PnL (dollar + percent) from the expanded card. */
    onUpdatePnL?: (id: string, pnl: { pnlAmount?: number; pnlPercent?: number }) => void;
}

// Tab configuration
type TabId = 'log' | 'signals' | 'analytics';

interface TabConfig {
    id: TabId;
    label: string;
    icon: React.ReactNode;
}

/** Dead tabs fold to the ledger. 'performance' predates this file's tab
 *  rename; 'learning'/'memory' moved to the Learning surface with the Studio
 *  merge; 'models' and 'reasoning' were deleted outright on 2026-10-07 —
 *  a stale hash or old bookmark lands on the trades, never a blank panel. */
const resolveTab = (tab: string): TabId =>
    tab === 'analytics' ? 'analytics' : tab === 'signals' ? 'signals' : 'log';

const TABS: TabConfig[] = [
    { id: 'log', label: 'History', icon: <HistoryIcon className="w-4 h-4 shrink-0" aria-hidden="true" /> },
    { id: 'signals', label: 'Signals', icon: <TargetIcon className="w-4 h-4 shrink-0" aria-hidden="true" /> },
    { id: 'analytics', label: 'Stats', icon: <ChartBarIcon className="w-4 h-4 shrink-0" aria-hidden="true" /> },
];

/** CSV + printable-report export. The journal has TWO headers (the embedded
 *  surface and the sliding overlay) and both need the pair, so it lives once
 *  here — the duplicated copy is how the overlay version lost its aria-labels. */
const ExportTray: React.FC<{ trades: LoggedTrade[] }> = ({ trades }) => {
    const empty = trades.length === 0;
    const cls = 'inline-flex items-center gap-1.5 rounded-control border border-hairline bg-zinc-800/80 px-3 py-1.5 text-ui-xs font-semibold text-zinc-400 transition-colors hover:border-line hover:bg-zinc-700/70 hover:text-zinc-100 disabled:opacity-40';
    return (
        <>
            <button
                type="button"
                onClick={() => exportTradesCSV(trades)}
                disabled={empty}
                title={empty ? 'Log a trade to export' : 'Download trade log as CSV'}
                aria-label="Export trades as CSV"
                className={cls}
            >
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                CSV
            </button>
            <button
                type="button"
                onClick={() => exportTradesHTML(trades)}
                disabled={empty}
                title={empty ? 'Log a trade to export' : 'Export the printable trade report (open it and print-to-PDF)'}
                aria-label="Export printable trade report"
                className={cls}
            >
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Report
            </button>
        </>
    );
};

const JournalInner: React.FC<JournalProps> = ({
    isVisible, onClose, initialTab,
    openNonce, username,
    // Trade Log Pass-through
    trades, onDeleteTrades, onClearAllTrades, onRestoreTrades, modelIdToName, onUpdateInsights, isSummarizing, currentInsightIds,
}) => {
    const [activeTab, setActiveTab] = useState<TabId>(resolveTab(initialTab));
    const [documentOpen, setDocumentOpen] = useState(false);

    useEffect(() => {
        if (activeTab !== 'log') setDocumentOpen(false);
    }, [activeTab]);

    // Active user for reasoning-record lookups. Threaded from App; falls back
    // to the legacy localStorage key the analysis pipeline writes.
    const activeUsername = username
        || (typeof localStorage !== 'undefined' ? (localStorage.getItem('last_active_user') || 'default') : 'default');

    // Esc closes the overlay (the biggest navigation dead-end in the app).
    useEscapeClose(isVisible, onClose);

    // Remember the last active tab across opens. Re-apply `initialTab` when
    // it actually CHANGES (a deep-link while mounted with a different tab) OR
    // when App's openNonce moves (an explicit openJournal — including the
    // SAME tab/trade re-entered while mounted, which a pure value-diff used
    // to swallow). Never on a plain visibility flip: the old effect dumped
    // users back to History every time they reopened.
    const lastInitialTabRef = useRef<TabId>(resolveTab(initialTab));
    const lastOpenNonceRef = useRef<number>(openNonce ?? 0);
    useEffect(() => {
        if (!isVisible) return;
        const next = resolveTab(initialTab);
        const nonce = openNonce ?? 0;
        if (nonce !== lastOpenNonceRef.current) {
            lastOpenNonceRef.current = nonce;
            lastInitialTabRef.current = next;
            setActiveTab(next);
            return;
        }
        if (next !== lastInitialTabRef.current) {
            lastInitialTabRef.current = next;
            setActiveTab(next);
        }
    }, [isVisible, initialTab, openNonce]);


    // Roving-tabindex arrow navigation for the embedded tab strip.
    const tabListRef = useRef<HTMLDivElement>(null);
    const handleTabsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const current = Math.max(0, TABS.findIndex(t => t.id === activeTab));
        const next = event.key === 'ArrowLeft'
            ? (current - 1 + TABS.length) % TABS.length
            : event.key === 'ArrowRight'
                ? (current + 1) % TABS.length
                : event.key === 'Home'
                    ? 0
                    : TABS.length - 1;
        setActiveTab(TABS[next].id);
        tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    };

    if (!isVisible) return null;

    const renderContent = () => (
        activeTab === 'log' ? (
            <TradeLogContent
                trades={trades}
                onDeleteTrades={onDeleteTrades}
                onClearAllTrades={onClearAllTrades}
                onRestoreTrades={onRestoreTrades}
                modelIdToName={modelIdToName}
                onUpdateInsights={onUpdateInsights}
                isSummarizing={isSummarizing}
                currentInsightIds={currentInsightIds}
                username={activeUsername}
                onDocumentOpenChange={setDocumentOpen}
            />
        ) : activeTab === 'signals' ? (
            <SignalFeed user={activeUsername} />
        ) : activeTab === 'analytics' ? (
            <div className="h-full overflow-y-auto">
                <div className="p-6 sm:p-8 space-y-8">
                    {/* Enhancement 3 (2026-11-18): the trader's gate on the ONE
                        harness revision the heartbeat pass proposes — pending,
                        approved-under-holdout, or revert-recommended. Nothing
                        applies without a tap here. */}
                    <HarnessOptimizationCard username={activeUsername} />
                    <WeeklyReviewCard username={activeUsername} />
                    <MonthlyReportCard username={activeUsername} />
                    <JournalAnalyticsSummary trades={trades} />
                    {/* Phase 4 (P-5, owner 2026-11-17): the three standalone
                        dashboards left — the desk's StatsCard renders
                        get_setup_history_stats / playbook_attribution /
                        get_trade_log VERBATIM from the tool receipt (parity
                        probe P-5). One tap asks the desk for exactly that. */}
                    <section className="rounded-bubble border border-hairline bg-zinc-900/40 p-4" data-testid="journal-stats-ask">
                        <h3 className="text-ui-xs font-semibold uppercase tracking-wider text-zinc-500">Stats — ask the desk</h3>
                        <p className="mt-1 text-ui-dense text-zinc-400">
                            The desk renders win rate with its Wilson 95% CI, per-playbook attribution and the recent log as a card in the chat — the same numbers the tools return, never recomputed here.
                        </p>
                        <button
                            type="button"
                            data-testid="journal-stats-trigger"
                            onClick={() => askDesk('stats')}
                            className="mt-2.5 rounded-control border border-hairline px-3 py-1.5 text-ui-dense font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                        >
                            Ask the desk for my stats
                        </button>
                    </section>
                </div>
            </div>
        ) : null
    );

    // The legacy overlay branch (backdrop + side-sheet + bottom tab bar) is
    // deleted (stage 3): tests/journalSurfaceNavigation.test.tsx pins that
    // App's ONLY <Journal> render is the embedded surface, so that chrome
    // could never mount. This branch carries the export tray and tab strip.
    return (
        <div className="flex flex-col h-full bg-surface-page overflow-hidden animate-fade-in" data-testid="journal-view">
            <div className="shrink-0 px-5 pt-7 pb-2 sm:px-8 flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Performance ledger</p>
                    <h2 className="font-serif text-ui-display font-medium tracking-[-0.025em] text-zinc-100">Journal</h2>
                    {!documentOpen && (
                        <p className="text-ui-caption text-zinc-500 mt-2">{trades.length} {trades.length === 1 ? 'trade' : 'trades'} · decisions, outcomes, and evidence</p>
                    )}
                </div>
                {/* CSV / printable-report export — these buttons used to
                    live only in the removed overlay branch, so the
                    embedded journal silently lost trade export. */}
                {!documentOpen && (
                    <div className="shrink-0 flex items-center gap-2 pt-1">
                        <ExportTray trades={trades} />
                    </div>
                )}
            </div>
            {!documentOpen && (
            <div ref={tabListRef} role="tablist" aria-label="Journal sections" onKeyDown={handleTabsKeyDown} className="shrink-0 px-5 sm:px-8 pt-4 pb-5 flex items-center gap-2 overflow-x-auto border-b border-hairline custom-scrollbar">
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            id={`journal-tab-${tab.id}`}
                            /* The probe's tabbed sweep enters a view by testid
                               (the Learning tabs' convention); the id alone is not
                               queryable there. */
                            data-testid={`journal-tab-${tab.id}`}
                            aria-selected={isActive}
                            aria-controls={`journal-panel-${activeTab}`}
                            tabIndex={isActive ? 0 : -1}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-ui-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                isActive
                                    ? 'bg-zinc-800 text-zinc-100 ring-1 ring-white/[0.06]'
                                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                            }`}
                        >
                            <span className={isActive ? 'text-zinc-100' : 'text-zinc-500'}>{tab.icon}</span>
                            <span>{tab.label}</span>
                        </button>
                    );
                })}
            </div>
            )}
            <div
                role="tabpanel"
                id={`journal-panel-${activeTab}`}
                aria-labelledby={`journal-tab-${activeTab}`}
                className="flex-1 overflow-hidden min-h-[480px]"
            >
                {renderContent()}
            </div>
        </div>
    );
};

const Stat: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="min-w-0">
    <div className="text-ui-xs uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
    <div className="text-ui-lg font-semibold text-zinc-100 truncate" title={value}>{value}</div>
    {sub && <div className="text-ui-dense text-zinc-500 truncate mt-0.5" title={sub}>{sub}</div>}
  </div>
);

const JournalAnalyticsSummary: React.FC<{ trades: LoggedTrade[] }> = ({ trades }) => {
  const stats = useMemo(() => computeJournalStats(trades), [trades]);
  // Pass-mining counter-metric: the sweep resolves SKIPPED trades
  // post-hoc; the journal shows the two sides of discipline — passes the
  // market vindicated (CORRECT_PASS) and passes that cost a move
  // (MISSED_OPPORTUNITY). Read-only over the stored records.
  const [passCounts, setPassCounts] = useState<{ correct: number; missed: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { loadPassRecords, correctPassCount, missedOpportunityCount } = await import('../../services/learning/passMining');
      const recs = await loadPassRecords(getActiveUsername());
      if (alive) setPassCounts({ correct: correctPassCount(recs), missed: missedOpportunityCount(recs) });
    })().catch(() => { /* counter-metric is best-effort */ });
    return () => { alive = false; };
  }, [trades.length]);
  if (stats.total === 0) return null;
  const top = stats.perStrategy[0];
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
      <Stat label="Win rate" value={`${stats.winRate}%`} sub={`${stats.wins}W / ${stats.losses}L of ${stats.total}`} />
      <Stat label="Expectancy" value={`${stats.expectancyR > 0 ? '+' : ''}${stats.expectancyR}R`} sub={`avg win ${stats.avgWinR}R · avg loss ${stats.avgLossR}R`} />
      <Stat
        label="Streak"
        value={stats.currentStreak > 0 ? `${stats.currentStreak}W` : stats.currentStreak < 0 ? `${-stats.currentStreak}L` : '—'}
        sub={`best ${stats.bestWinStreak}W / ${-stats.bestLossStreak}L`}
      />
      <Stat label="Top strategy" value={top?.key ?? '—'} sub={top ? `${top.trades} trades · ${top.winRate}% WR` : undefined} />
      {/* the pass ledger — vindicated skips draft avoid-skills;
          missed opportunities are a counter-metric ONLY (we never teach
          the system to take more trades). */}
      {passCounts && (passCounts.correct > 0 || passCounts.missed > 0) && (
        <Stat
          label="Passes"
          value={`${passCounts.correct} right / ${passCounts.missed} missed`}
          sub="skips resolved against post-skip price"
        />
      )}
    </div>
  );
};

export const Journal = React.memo(JournalInner);
