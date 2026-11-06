import React, { useMemo } from 'react';
import { LoggedTrade } from '../../../types';
import type { PersonalizedLearningProfile } from '../../../services/learning/SelfLearningService';
import { summarizePromptVersions, summarizePromptLanes } from '../../../utils/promptVersionStats';
import { getCalibrationSummaries } from '../../../services/backtesting/ModelPerformanceService';
import { StatCard } from './StatCard';
import { getWinRateColor } from './shared';

interface TraderProfileCardsProps {
    trades: LoggedTrade[];
    closedWindowed: LoggedTrade[];
    profile: PersonalizedLearningProfile;
}

export const TraderProfileCards: React.FC<TraderProfileCardsProps> = ({
    trades, closedWindowed, profile,
}) => {
    const tideStats = useMemo(() => {
        const withAlpha = closedWindowed.filter(t => t.benchmark && Number.isFinite(t.benchmark.alphaPct));
        if (withAlpha.length === 0) return { n: 0, beatPct: null as number | null, avgAlpha: null as number | null };
        const beat = withAlpha.filter(t => (t.benchmark?.alphaPct ?? 0) > 0).length;
        const avg = withAlpha.reduce((s, t) => s + (t.benchmark?.alphaPct ?? 0), 0) / withAlpha.length;
        return { n: withAlpha.length, beatPct: Math.round((beat / withAlpha.length) * 100), avgAlpha: Math.round(avg * 10) / 10 };
    }, [closedWindowed]);

    const promptVersions = useMemo(() => summarizePromptVersions(closedWindowed), [closedWindowed]);
    const promptLanes = useMemo(() => summarizePromptLanes(closedWindowed), [closedWindowed]);
    const calibrationSummaries = useMemo(() => getCalibrationSummaries().filter(c => c.samples > 0), [trades]);

    return (
        <div className="grid grid-cols-1 gap-3 sm:gap-4">
            <StatCard
                title="Call vs tide"
                items={tideStats.n > 0 ? [
                    {
                        name: `Beat holding BTC/ETH (${tideStats.n} settled)`,
                        value: `${tideStats.beatPct}%`,
                        color: getWinRateColor(tideStats.beatPct ?? 0),
                    },
                    {
                        name: 'Average alpha vs hold',
                        value: `${(tideStats.avgAlpha ?? 0) >= 0 ? '+' : ''}${tideStats.avgAlpha}%`,
                        color: (tideStats.avgAlpha ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400',
                    },
                ] : []}
                emptyText="No benchmark-settled trades yet - outcomes verified from this version forward get a call-vs-tide reading"
            />
            <StatCard
                title="Best Coins"
                items={profile.bestCoins.slice(0, 4).map(c => ({
                    name: c.coin,
                    value: `${c.winRate}%`,
                    subtext: `(n=${c.count})`,
                    color: getWinRateColor(c.winRate)
                }))}
            />
            <StatCard
                title="Best Patterns"
                items={profile.bestPatterns.slice(0, 4).map(p => ({
                    name: p.pattern,
                    value: `${p.winRate}%`,
                    subtext: `(n=${p.count})`,
                    color: getWinRateColor(p.winRate)
                }))}
            />
            <StatCard
                title="Direction Performance"
                items={profile.bestDirections.map(d => ({
                    name: d.direction,
                    value: `${d.winRate}%`,
                    subtext: `(n=${d.count})`,
                    color: getWinRateColor(d.winRate)
                }))}
            />
            <StatCard
                title="Regime Performance"
                items={profile.bestRegimes.map(r => ({
                    name: r.regime,
                    value: `${r.winRate}%`,
                    subtext: `(n=${r.count})`,
                    color: getWinRateColor(r.winRate)
                }))}
            />
            <StatCard
                title="Prompt versions"
                items={promptVersions.slice(0, 5).map(v => ({
                    name: v.version,
                    value: v.winRate !== null ? `${v.winRate}%` : '-',
                    subtext: v.avgDeclared !== null
                        ? `(n=${v.trades} - said ${v.avgDeclared}% vs ${v.avgRealized}%)`
                        : `(n=${v.trades})`,
                    color: v.winRate !== null ? getWinRateColor(v.winRate) : 'text-zinc-500',
                }))}
                emptyText="Log closed trades after a run to compare prompt versions"
            />
            <StatCard
                title="Prompt A/B lanes"
                items={promptLanes.filter(l => l.trades > 0).map(l => ({
                    name: l.lane,
                    value: l.winRate !== null ? `${l.winRate}%` : '-',
                    subtext: `(n=${l.trades})`,
                    color: l.winRate !== null ? getWinRateColor(l.winRate) : 'text-zinc-500',
                }))}
                emptyText="Need closed trades on both live and control lanes"
            />
            <StatCard
                title="Model calibration (Brier)"
                items={calibrationSummaries.slice(0, 6).map(c => ({
                    name: c.provider,
                    value: c.brierScore !== null ? c.brierScore.toFixed(3) : '-',
                    subtext: `${c.verdict === 'calibrated' ? 'calibrated' : c.verdict.replace('-', ' ')}${c.highGap !== null ? ` - High gap ${c.highGap > 0 ? '+' : ''}${c.highGap}%` : ''} (n=${c.samples})`,
                    color: c.verdict === 'overconfident'
                        ? 'text-rose-400'
                        : c.verdict === 'underconfident'
                            ? 'text-amber-500'
                            : c.verdict === 'calibrated'
                                ? 'text-emerald-400'
                                : 'text-zinc-500',
                }))}
                emptyText="Close trades to measure whether model confidence means anything - lower Brier = better calibrated (chance ~0.25)"
            />
        </div>
    );
};

export default TraderProfileCards;
