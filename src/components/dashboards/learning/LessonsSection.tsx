
import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDownIcon } from '../../shared/Icons';
import { LoggedTrade, TradeOutcome } from '../../../types';
import type { TopLesson } from '../../../services/learning/MemoryFilesService';
import { decidedAtOf } from '../../../utils/journalAnalytics';
import { REGIMES } from './shared';

interface LessonsSectionProps {
    topLessons: TopLesson[];
    /** Closed trades inside the dashboard's active time window — the pool the
     *  "View trades" drill-down filters, so it respects the window control. */
    closedWindowed: LoggedTrade[];
}

/**
 * Outcome-weighted clusters — losses first (fix list), then wins (repeat
 * list) — each expandable into the trades behind it.
 */
export const LessonsSection: React.FC<LessonsSectionProps> = ({ topLessons, closedWindowed }) => {
    // ─── View-trades on lessons: fixed filter set for v1 (regime + PnL
    //      threshold — direction/outcome are implied by the cluster). ─────
    const [expandedLesson, setExpandedLesson] = useState<number | null>(null);
    const [lessonRegimeFilter, setLessonRegimeFilter] = useState<string>('all');
    const [lessonPnlThreshold, setLessonPnlThreshold] = useState(false); // ≤ -2% only

    // Matches per lesson, memoized as a parallel array. This used to be a
    // plain function called from inside topLessons.map — every render of the
    // dashboard re-filtered + re-sorted the whole closed log once per lesson.
    const lessonMatches = useMemo(() => topLessons.map(lesson => {
        const splitAt = lesson.label.lastIndexOf(' ');
        const coin = lesson.label.slice(0, splitAt);
        const direction = lesson.label.slice(splitAt + 1);
        return closedWindowed.filter(t =>
            (t.analysis?.coinName ?? '') === coin
            && (t.analysis?.direction ?? '') === direction
            && (lesson.kind === 'win' ? t.outcome === TradeOutcome.WIN : t.outcome === TradeOutcome.LOSS)
            && (lessonRegimeFilter === 'all' || (t.marketRegime ?? 'unknown') === lessonRegimeFilter)
            && (!lessonPnlThreshold || (typeof t.pnlPercent === 'number' && t.pnlPercent <= -2))
        )
            .sort((a, b) => new Date(decidedAtOf(a)).getTime() - new Date(decidedAtOf(b)).getTime())
            .slice(-15);
    }), [topLessons, closedWindowed, lessonRegimeFilter, lessonPnlThreshold]);

    return (
        <div className="bg-zinc-800 rounded-bubble border border-hairline p-3 sm:p-4">
            <h4 className="text-ui-xs sm:text-ui-sm font-bold text-zinc-500 uppercase tracking-wider mb-2 sm:mb-3">Top Lessons (outcome-weighted)</h4>
            {topLessons.length === 0 ? (
                <p className="text-ui-sm text-zinc-600 italic">Log at least 2 trades on the same coin + direction to see clusters.</p>
            ) : (
                <div className="space-y-1.5">
                    {topLessons.map((l, i) => {
                        const matches = lessonMatches[i] ?? [];
                        const isOpen = expandedLesson === i;
                        return (
                            <div key={i} className="rounded-control border border-hairline bg-zinc-950/40 px-2.5 py-2">
                                <div className="flex items-center justify-between text-ui-base">
                                    <span className="text-zinc-300 truncate pr-2 flex items-center gap-1.5" title={`${l.label} ×${l.count}`}>
                                        {l.kind === 'loss' ? (
                                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
                                        ) : (
                                            <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                                        )}
                                        {l.label}
                                        <span className="text-ui-xs text-zinc-500">×{l.count}</span>
                                    </span>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {l.avgPnl !== null && (
                                            <span className={`text-ui-sm font-bold ${l.avgPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {l.avgPnl > 0 ? '+' : ''}{l.avgPnl.toFixed(1)}%
                                            </span>
                                        )}
                                        <button
                                            onClick={() => setExpandedLesson(isOpen ? null : i)}
                                            className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1"
                                        >
                                            View {matches.length} trades <ChevronDownIcon className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                        </button>
                                    </div>
                                </div>
                                <div className={`collapsible-content ${isOpen ? 'expanded' : ''}`}>
                                    <div className="mt-2 space-y-1.5">
                                        {/* Fixed filter set (v1): regime + PnL threshold */}
                                        <div className="flex items-center gap-1 flex-wrap">
                                            <button
                                                onClick={() => setLessonRegimeFilter('all')}
                                                className={`px-1.5 py-0.5 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors ${
                                                    lessonRegimeFilter === 'all' ? 'bg-zinc-800 border-transparent text-zinc-100' : 'bg-zinc-900 border-hairline text-zinc-500 hover:text-zinc-300'
                                                }`}
                                            >
                                                all regimes
                                            </button>
                                            {REGIMES.map(r => (
                                                <button
                                                    key={r}
                                                    onClick={() => setLessonRegimeFilter(prev => prev === r ? 'all' : r)}
                                                    className={`px-1.5 py-0.5 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors ${
                                                        lessonRegimeFilter === r ? 'bg-zinc-800 border-transparent text-zinc-100' : 'bg-zinc-900 border-hairline text-zinc-500 hover:text-zinc-300'
                                                    }`}
                                                >
                                                    {r}
                                                </button>
                                            ))}
                                            <button
                                                onClick={() => setLessonPnlThreshold(v => !v)}
                                                className={`px-1.5 py-0.5 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors ${
                                                    lessonPnlThreshold ? 'bg-rose-500/20 border-rose-500/30 text-rose-400' : 'bg-zinc-900 border-hairline text-zinc-500 hover:text-zinc-300'
                                                }`}
                                            >
                                                ≤ −2% only
                                            </button>
                                        </div>
                                        {matches.length === 0 ? (
                                            <p className="text-ui-xs text-zinc-600 italic">No trades match these filters in the current time window.</p>
                                        ) : (
                                            matches.slice(-8).map(t => (
                                                <div key={t.id} className="flex items-center justify-between rounded-control bg-zinc-900/60 border border-hairline px-2 py-1 text-ui-xs font-mono tabular-nums">
                                                    <span className="text-zinc-400 truncate pr-2" title={`${new Date(decidedAtOf(t)).toLocaleDateString()} · ${t.analysis?.direction} · ${t.marketRegime ?? '?'}`}>
                                                        {new Date(decidedAtOf(t)).toLocaleDateString()} · {t.analysis?.direction}
                                                        <span className="text-zinc-600"> · {t.marketRegime ?? '?'}</span>
                                                    </span>
                                                    <span className={`shrink-0 font-bold ${t.outcome === TradeOutcome.WIN ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                        {t.outcome}{typeof t.pnlPercent === 'number' ? ` (${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%)` : ''}
                                                    </span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default LessonsSection;
