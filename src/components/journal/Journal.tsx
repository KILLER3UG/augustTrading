
import React, { useState, useEffect, useMemo, useRef } from 'react';
import TradeLogContent from './TradeLog';
import WinRateDashboard from '../dashboards/WinRateDashboard';
import EquityCurveDashboard from '../dashboards/EquityCurveDashboard';
import { WeeklyReviewCard } from './WeeklyReviewCard';
import { MonthlyReportCard } from './MonthlyReportCard';
import SignalFeed from './SignalFeed';
import {HistoryIcon, ChartBarIcon, FileSpreadsheet, FileText, TargetIcon} from '../shared/Icons';

import { exportTradesCSV, exportTradesHTML } from '../../utils/reportExport';
import { LoggedTrade, TradeOutcome } from '../../types';
import { computeJournalStats } from '../../utils/journalAnalytics';
import { RECENT_TRADES_WINDOW, buildTradeLogBrief } from '../../utils/recentTradesBrief';
import { phtClock, phtDayKey } from '../../utils/timezone';
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
    onClearAllTrades: () => void;
    modelIdToName: Record<string, string>;
    onUpdateInsights: (ids: string[]) => void;
    isSummarizing?: boolean;
    currentInsightIds: string[];
    /** (i/n) progress for manual insight-generation loops. */
    insightProgress?: { done: number; total: number } | null;
    onUpdateTradeLeverage: (id: string, leverage: number) => void;
    onUpdateTradeType: (id: string, tradeType: 'scalp' | 'swing') => void;
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
    trades, onDeleteTrades, onClearAllTrades, modelIdToName, onUpdateInsights, isSummarizing, currentInsightIds, onUpdateTradeLeverage, onUpdateTradeType, onUpdateOutcome, onUpdatePnL,
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
                modelIdToName={modelIdToName}
                onUpdateInsights={onUpdateInsights}
                isSummarizing={isSummarizing}
                currentInsightIds={currentInsightIds}
                onUpdateTradeLeverage={onUpdateTradeLeverage}
                onUpdateTradeType={onUpdateTradeType}
                onUpdateOutcome={onUpdateOutcome}
                onUpdatePnL={onUpdatePnL}
                username={activeUsername}
                onDocumentOpenChange={setDocumentOpen}
            />
        ) : activeTab === 'signals' ? (
            <SignalFeed user={activeUsername} />
        ) : activeTab === 'analytics' ? (
            <div className="h-full overflow-y-auto">
                <div className="p-6 sm:p-8 space-y-8">
                    <WeeklyReviewCard username={activeUsername} />
                    <MonthlyReportCard username={activeUsername} />
                    <JournalAnalyticsSummary trades={trades} />
                    {/* The three dashboards answer the same question at three
                        resolutions — recent form, the curve, the win-rate table. */}
                    <LastTwentyCard trades={trades} />
                    <EquityCurveDashboard trades={trades} />
                    <WinRateDashboard trades={trades} />
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
                            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-ui-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                                isActive
                                    ? 'bg-zinc-800 text-zinc-100 shadow-sm ring-1 ring-white/[0.06]'
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

/**
 * The last 20 rows as the seats read them — log time, outcome, PnL in whichever
 * unit was actually captured, price-measured R, strategy and discipline tags.
 * Oldest first, so it reads as a tape and the streak at the bottom is the
 * trader's current form. Same module the model gets (`utils/recentTradesBrief`),
 * so the two can never disagree.
 */
const LastTwentyCard: React.FC<{ trades: LoggedTrade[] }> = ({ trades }) => {
  const brief = useMemo(() => buildTradeLogBrief(trades), [trades]);
  if (brief.rows.length === 0) return null;

  const outcomeClass = (outcome: string): string =>
    outcome === TradeOutcome.WIN ? 'text-emerald-400'
      : outcome === TradeOutcome.LOSS ? 'text-rose-400'
        : 'text-zinc-500';

  return (
    <section className="rounded-bubble border border-hairline bg-zinc-900/40 p-4" data-testid="journal-last-20">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-ui-xs font-semibold uppercase tracking-wider text-zinc-500">
          Last {RECENT_TRADES_WINDOW} logged trades
        </h3>
        <p className="font-mono text-ui-dense text-zinc-400">
          {brief.wins}W / {brief.losses}L
          {brief.winRate !== null ? ` · ${brief.winRate.toFixed(1)}%` : ''}
          {brief.avgRealizedR !== null ? ` · avg ${brief.avgRealizedR >= 0 ? '+' : ''}${brief.avgRealizedR.toFixed(2)}R` : ''}
          {brief.netPnLDollars !== null ? ` · net ${brief.netPnLDollars >= 0 ? '+' : '-'}$${Math.abs(brief.netPnLDollars).toFixed(2)}` : ''}
          {brief.streak !== 0 ? ` · streak ${Math.abs(brief.streak)}${brief.streak > 0 ? 'W' : 'L'}` : ''}
        </p>
      </div>
      <ol className="mt-3 space-y-1">
        {brief.rows.map(r => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-hairline pb-1 text-ui-dense last:border-0">
            <span className="font-mono text-ui-2xs text-zinc-600 whitespace-nowrap">
              {phtDayKey(Date.parse(r.loggedAt))} {phtClock(r.loggedAt)}
            </span>
            <span className="font-semibold text-zinc-200">{r.symbol} <span className="text-zinc-500 font-normal">{r.direction}</span></span>
            <span className={`font-bold uppercase tracking-wider text-ui-2xs ${outcomeClass(r.outcome)}`}>
              {r.outcome === TradeOutcome.ENTRY_NOT_HIT ? 'NO ENTRY' : r.outcome}
            </span>
            {typeof r.pnlDollars === 'number' && (
              <span className={r.pnlDollars >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {r.pnlDollars >= 0 ? '+' : '-'}${Math.abs(r.pnlDollars).toFixed(2)}
              </span>
            )}
            {typeof r.pnlDollars !== 'number' && typeof r.pnlPercent === 'number' && (
              <span className={r.pnlPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'} title="Leveraged percent — dollars were never captured">
                {r.pnlPercent >= 0 ? '+' : ''}{r.pnlPercent.toFixed(1)}%
              </span>
            )}
            {typeof r.pnlDollars !== 'number' && typeof r.pnlPercent !== 'number' && (
              <span className="text-zinc-600">pnl not captured</span>
            )}
            {typeof r.realizedR === 'number' && (
              <span className="font-mono text-ui-2xs text-zinc-400">{r.realizedR >= 0 ? '+' : ''}{r.realizedR.toFixed(2)}R</span>
            )}
            {r.strategy && <span className="text-zinc-500 truncate max-w-[18ch]" title={r.strategy}>{r.strategy}</span>}
            {r.tags.length > 0 && (
              <span className="text-amber-300/80">{r.tags.join(' · ')}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};

export const Journal = React.memo(JournalInner);
