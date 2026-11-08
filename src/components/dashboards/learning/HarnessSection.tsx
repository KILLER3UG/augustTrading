
import React, { useEffect, useMemo, useState } from 'react';
import { LoggedTrade, TradeOutcome } from '../../../types';
import { computeEvidenceQualityStats } from '../../../utils/analysisQuality';
import { summarizeSimilarSetups, COLD_START_MIN } from '../../../services/learning/SetupMemoryService';
import { decidedAtOf } from '../../../utils/journalAnalytics';
import { REGIMES } from './shared';

interface HarnessSectionProps {
    /** Closed trades inside the active time window. */
    closedWindowed: LoggedTrade[];
    /** Every closed trade, windowed or not. The caption under the window chips
     *  reads "N of M" so a filter that changes nothing says so out loud instead
     *  of leaving the trader to wonder whether the click landed. */
    totalClosed: number;
    windowDays: 0 | 30 | 90;
    onWindowDaysChange: (days: 0 | 30 | 90) => void;
}

/**
 * Harness accuracy (②): the similar-setup pool itself — pool stats,
 * drawdown, and the per-model × regime leaderboard.
 */
export const HarnessSection: React.FC<HarnessSectionProps> = ({ closedWindowed, totalClosed, windowDays, onWindowDaysChange }) => {
    const evidenceQuality = useMemo(() => computeEvidenceQualityStats(closedWindowed), [closedWindowed]);

    // Pool stats: setups indexed + avg matches per query (sampled for cost)
    // + how many queries hit the cold-start flag. The sampling loop runs up
    // to 50× summarizeSimilarSetups, each re-scanning the whole closed pool —
    // far too heavy to do synchronously on tab mount, so it is deferred to an
    // idle callback (2s timeout cap; setTimeout fallback where
    // requestIdleCallback is unavailable). Math is identical to the old memo;
    // only WHEN it runs changed. Cards read 0/— until the first result lands.
    const [poolSample, setPoolSample] = useState({ avgMatches: 0, coldStartQueries: 0, sampled: 0 });
    const poolStats = useMemo(
        () => ({ indexed: closedWindowed.length, ...poolSample }),
        [closedWindowed.length, poolSample],
    );
    useEffect(() => {
        const source = closedWindowed;
        let cancelled = false;
        const compute = (): void => {
            if (cancelled) return;
            const sample = source.slice(-50);
            let matches = 0, queries = 0, coldStarts = 0;
            for (const t of sample) {
                const s = summarizeSimilarSetups(
                    { coinName: t.analysis?.coinName, direction: t.analysis?.direction, detectedPatternFamily: t.analysis?.detectedPatternFamily },
                    source.filter(x => x.id !== t.id),
                    t.marketRegime
                );
                if (s) { matches += s.total; queries += 1; if (s.isColdStart) coldStarts += 1; }
            }
            if (!cancelled) setPoolSample({ avgMatches: queries ? matches / queries : 0, coldStartQueries: coldStarts, sampled: queries });
        };
        const w = window as unknown as {
            requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
            cancelIdleCallback?: (id: number) => void;
        };
        if (typeof w.requestIdleCallback === 'function') {
            const handle = w.requestIdleCallback(compute, { timeout: 2000 });
            return () => { cancelled = true; w.cancelIdleCallback?.(handle); };
        }
        const timer = window.setTimeout(compute, 300);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [closedWindowed]);

    // Drawdown — explicitly split: current (open) vs historical max.
    const drawdown = useMemo(() => {
        const ordered = [...closedWindowed].sort((a, b) => new Date(decidedAtOf(a)).getTime() - new Date(decidedAtOf(b)).getTime());
        let equity = 0, peak = 0, open = 0, max = 0;
        for (const t of ordered) {
            equity += typeof t.pnlPercent === 'number' ? t.pnlPercent : (t.outcome === TradeOutcome.WIN ? 2 : -1);
            if (equity > peak) peak = equity;
            open = Math.min(open, equity - peak);
            max = Math.min(max, equity - peak);
        }
        return { open, max };
    }, [closedWindowed]);

    // Per-model × regime leaderboard (win % + n), with a numeric delta over
    // the model's LAST 20 closed trades vs its overall — replaces the vague
    // trend arrow.
    const leaderboard = useMemo(() => {
        const rows: { key: string; byRegime: Record<string, { w: number; l: number }>; total: number; wins: number; last20WinRate: number | null; last20N: number }[] = [];
        const byKey = new Map<string, { byRegime: Record<string, { w: number; l: number }>; total: number; wins: number; recent: LoggedTrade[] }>();
        for (const t of closedWindowed) {
            const used = t.modelsUsed ?? {};
            const entries = Object.entries(used);
            const key = entries.length > 0 ? `${entries[0][0]}::${entries[0][1]}` : 'unknown';
            const c = byKey.get(key) ?? { byRegime: {}, total: 0, wins: 0, recent: [] };
            c.total += 1;
            if (t.outcome === TradeOutcome.WIN) c.wins += 1;
            const regime = t.marketRegime ?? 'unknown';
            c.byRegime[regime] = c.byRegime[regime] ?? { w: 0, l: 0 };
            c.byRegime[regime][t.outcome === TradeOutcome.WIN ? 'w' : 'l'] += 1;
            c.recent.push(t);
            byKey.set(key, c);
        }
        for (const [key, c] of byKey) {
            if (c.total < 3) continue;
            const last20 = c.recent.sort((a, b) => new Date(decidedAtOf(a)).getTime() - new Date(decidedAtOf(b)).getTime()).slice(-20);
            const last20Wins = last20.filter(t => t.outcome === TradeOutcome.WIN).length;
            rows.push({
                key,
                byRegime: c.byRegime,
                total: c.total,
                wins: c.wins,
                last20WinRate: last20.length >= 5 ? (last20Wins / last20.length) * 100 : null,
                last20N: last20.length,
            });
        }
        return rows.sort((a, b) => b.total - a.total);
    }, [closedWindowed]);

    return (
        <div className="space-y-3 sm:space-y-4">
            {/* Time-window control — stale early data must not masquerade as current */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className="text-ui-xs sm:text-ui-sm font-bold text-zinc-500 uppercase tracking-wider">Harness Accuracy — the similar-setup pool</h4>
                <div className="flex items-center gap-1">
                    {([0, 30, 90] as const).map(d => (
                        <button
                            key={d}
                            type="button"
                            aria-pressed={windowDays === d}
                            onClick={() => onWindowDaysChange(d)}
                            className={`min-h-6 px-2.5 py-1 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors ${
                                windowDays === d ? 'bg-zinc-800 border-transparent text-zinc-100' : 'bg-zinc-900 border-hairline text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            {d === 0 ? 'all time' : `${d}d`}
                        </button>
                    ))}
                </div>
            </div>
            <p className="text-ui-dense text-zinc-600" data-testid="harness-window-note">
                {closedWindowed.length} of {totalClosed} closed trades in view ·{' '}
                {windowDays === 0 ? 'the whole journal' : `the last ${windowDays} days`}
            </p>

            {/* Pool stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-zinc-800 rounded-bubble border border-hairline p-3">
                    <p className="text-ui-2xs text-zinc-500 uppercase tracking-wider mb-1">Setups indexed</p>
                    <p className="text-xl font-black text-white">{poolStats.indexed}</p>
                    <p className="text-ui-2xs text-zinc-600">closed trades in pool</p>
                </div>
                <div className="bg-zinc-800 rounded-bubble border border-hairline p-3">
                    <p className="text-ui-2xs text-zinc-500 uppercase tracking-wider mb-1">Avg matches / query</p>
                    <p className="text-xl font-black text-white">{poolStats.avgMatches.toFixed(1)}</p>
                    <p className="text-ui-2xs text-zinc-600">sampled {poolStats.sampled} queries</p>
                </div>
                <div className="bg-zinc-800 rounded-bubble border border-hairline p-3">
                    <p className="text-ui-2xs text-zinc-500 uppercase tracking-wider mb-1">Cold-start queries</p>
                    <p className={`text-xl font-black ${poolStats.coldStartQueries > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                        {poolStats.sampled > 0 ? `${Math.round((poolStats.coldStartQueries / poolStats.sampled) * 100)}%` : '—'}
                    </p>
                    <p className="text-ui-2xs text-zinc-600">below {COLD_START_MIN} matches → confidence scaled down</p>
                </div>
                <div className="bg-zinc-800 rounded-bubble border border-hairline p-3">
                    <p className="text-ui-2xs text-zinc-500 uppercase tracking-wider mb-1">Drawdown</p>
                    <p className="text-xl font-black text-rose-400">{drawdown.open.toFixed(1)}%</p>
                    <p className="text-ui-2xs text-zinc-600">open · historical max {drawdown.max.toFixed(1)}%</p>
                </div>
            </div>

            <div className="bg-zinc-800 rounded-bubble border border-hairline p-3">
                <p className="text-ui-2xs text-zinc-500 uppercase tracking-wider mb-2">Evidence coverage vs outcome</p>
                <p className="text-ui-xs text-zinc-600 mb-2">Recorded trend, not causal proof.</p>
                <div className="grid grid-cols-3 gap-2">
                    {evidenceQuality.map(bucket => (
                        <div key={bucket.coverage} className="rounded-control border border-hairline bg-zinc-950/50 p-2">
                            <p className="text-ui-xs uppercase tracking-widest text-zinc-500">{bucket.coverage}</p>
                            <p className="text-ui-base font-semibold text-zinc-100">{bucket.winRate !== null ? `${bucket.winRate}% WR` : '—'}</p>
                            <p className="text-ui-xs text-zinc-600">n={bucket.n}{bucket.avgProbability !== null ? ` · avg p ${bucket.avgProbability}` : ''}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Per-model × regime leaderboard */}
            <div className="bg-zinc-800 rounded-bubble border border-hairline p-3 sm:p-4">
                <h4 className="text-ui-xs sm:text-ui-sm font-bold text-zinc-500 uppercase tracking-wider mb-2 sm:mb-3">Per-model track record by regime</h4>
                {leaderboard.length === 0 ? (
                    <p className="text-ui-sm text-zinc-600 italic">Log ≥3 trades per model to see the leaderboard.</p>
                ) : (
                    <div className="overflow-x-auto custom-scrollbar">
                        <table className="w-full text-left text-ui-xs font-mono tabular-nums">
                            <thead>
                                <tr className="text-zinc-600 border-b border-hairline">
                                    <th className="py-1.5 pr-3 font-bold">Model</th>
                                    {REGIMES.map(r => <th key={r} className="py-1.5 px-2 font-bold">{r}</th>)}
                                    <th className="py-1.5 px-2 font-bold">Overall</th>
                                    <th className="py-1.5 px-2 font-bold">Δ last 20</th>
                                </tr>
                            </thead>
                            <tbody>
                                {leaderboard.map(row => {
                                    const overall = row.total > 0 ? (row.wins / row.total) * 100 : 0;
                                    const delta = row.last20WinRate !== null ? row.last20WinRate - overall : null;
                                    return (
                                        <tr key={row.key} className="border-b border-hairline last:border-0">
                                            <td className="py-1.5 pr-3 text-zinc-300 truncate max-w-[140px]" title={row.key}>{row.key}</td>
                                            {REGIMES.map(r => {
                                                const s = row.byRegime[r];
                                                if (!s || s.w + s.l === 0) return <td key={r} className="py-1.5 px-2 text-zinc-500">—</td>;
                                                const wr = (s.w / (s.w + s.l)) * 100;
                                                return (
                                                    <td key={r} className={`py-1.5 px-2 ${wr >= 60 ? 'text-emerald-400' : wr >= 45 ? 'text-zinc-300' : 'text-rose-400'}`}>
                                                        {wr.toFixed(0)}% <span className="text-zinc-600">({s.w + s.l})</span>
                                                    </td>
                                                );
                                            })}
                                            <td className="py-1.5 px-2 text-zinc-300">{overall.toFixed(0)}% <span className="text-zinc-600">({row.total})</span></td>
                                            <td className={`py-1.5 px-2 ${delta === null ? 'text-zinc-500' : delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)} pts / ${row.last20N}`}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                <p className="text-ui-2xs text-zinc-600 mt-2 leading-relaxed">
                    Regime classification: ADX thresholds — ADX ≥ 25 trend, &lt; 20 range, ATR-relative volatility; the regime is captured from the hybrid market data at log time.
                </p>
            </div>
        </div>
    );
};

export default HarnessSection;
