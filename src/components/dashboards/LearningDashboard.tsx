import React, { useEffect, useMemo, useState } from 'react';
import { LoggedTrade, TradeOutcome } from '../../types';
import { decidedAtOf } from '../../utils/journalAnalytics';
import { getActiveUsername } from '../../utils/activeUser';
import { humanizeSkillTitle } from '../../utils/uiFormatting';
import { computeLearningProfile } from '../../services/learning/SelfLearningService';
import { computeTopLessons } from '../../services/learning/MemoryFilesService';
import { readSignals } from '../../services/signals/signalLedger';
import { getPaperAccount, subscribePaperAccount } from '../../services/paper/PaperBrokerService';
import type { PaperSettledTrade } from '../../services/paper/paperCore';
import { AUTOPSY_MIN_SAMPLE, buildExecutionAutopsy, type ExecutionAutopsyReport } from '../../services/learning/executionAutopsyCore';
import type { SignalRow } from '../../types/signal';
import { HarnessSection } from './learning/HarnessSection';
import { LessonsSection } from './learning/LessonsSection';
import { ProfileHeader } from './learning/ProfileHeader';
import { TraderProfileCards } from './learning/TraderProfileCards';

interface LearningDashboardProps {
    trades: LoggedTrade[];
    /** Active user - retained for the host's wiring. */
    username?: string;
    /** Optional pre-seeded closed signals for deterministic tests/snapshots. */
    initialSignals?: readonly SignalRow[];
    /** Optional pre-seeded closed paper trades for deterministic tests/snapshots. */
    initialPaperTrades?: readonly PaperSettledTrade[];
}

const isClosed = (t: LoggedTrade): boolean => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS;

const fmtPct = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
const fmtR = (val: number | null): string => (val === null ? '—' : `${val >= 0 ? '+' : ''}${val.toFixed(2)}R`);

/**
 * The learning profile - every number here is a read of a store the loop
 * already writes. Includes deterministic Execution Autopsy across settled
 * signals, closed paper trades, and closed journal trades when sample >= 5.
 */
export const LearningDashboard: React.FC<LearningDashboardProps> = ({
    trades,
    username,
    initialSignals,
    initialPaperTrades,
}) => {
    const user = username ?? getActiveUsername() ?? 'default';
    const profile = useMemo(() => computeLearningProfile(trades), [trades]);
    const topLessons = useMemo(() => computeTopLessons(trades, 6), [trades]);

    const [signals, setSignals] = useState<readonly SignalRow[]>(() => initialSignals ?? readSignals(user));
    const [paperTrades, setPaperTrades] = useState<readonly PaperSettledTrade[]>(() => initialPaperTrades ?? []);

    useEffect(() => {
        if (initialSignals !== undefined) {
            setSignals(initialSignals);
            return;
        }
        setSignals(readSignals(user));
    }, [initialSignals, user, trades.length]);

    useEffect(() => {
        if (initialPaperTrades !== undefined) {
            setPaperTrades(initialPaperTrades);
            return;
        }
        let alive = true;
        const unsubscribe = subscribePaperAccount(acc => {
            if (alive) setPaperTrades(acc.closedTrades);
        });
        void getPaperAccount(user)
            .then(acc => { if (alive) setPaperTrades(acc.closedTrades); })
            .catch(() => { /* no stored paper account yet */ });
        return () => { alive = false; unsubscribe(); };
    }, [initialPaperTrades, user]);

    const [windowDays, setWindowDays] = useState<0 | 30 | 90>(0);
    const windowedTrades = useMemo(() => {
        if (windowDays === 0) return trades;
        const cutoff = Date.now() - windowDays * 86_400_000;
        return trades.filter(t => new Date(decidedAtOf(t)).getTime() >= cutoff);
    }, [trades, windowDays]);

    const totalClosed = useMemo(() => trades.filter(isClosed).length, [trades]);
    const closedWindowed = useMemo(() => windowedTrades.filter(isClosed), [windowedTrades]);

    const autopsy: ExecutionAutopsyReport = useMemo(
        () => buildExecutionAutopsy({ signals, paperTrades, loggedTrades: trades }),
        [signals, paperTrades, trades],
    );
    const effectiveClosed = Math.max(totalClosed, autopsy.sampleCount);

    const weakestSession = useMemo(() => {
        const leak = autopsy.bySession.find(s => s.flaggedLeak);
        return leak ?? autopsy.bySession[0] ?? null;
    }, [autopsy]);

    const weakestPlaybook = useMemo(() => {
        const leak = autopsy.byPlaybook.find(p => p.flaggedLeak);
        return leak ?? autopsy.byPlaybook[0] ?? null;
    }, [autopsy]);

    const harnessSection = (
        <HarnessSection
            closedWindowed={closedWindowed}
            totalClosed={totalClosed}
            windowDays={windowDays}
            onWindowDaysChange={setWindowDays}
        />
    );
    const lessonsSection = <LessonsSection topLessons={topLessons} closedWindowed={closedWindowed} />;

    const autopsySection = autopsy.sufficientSample ? (
        <section
            data-testid="learning-execution-autopsy"
            className="rounded-bubble border border-hairline bg-zinc-900/50 p-4 space-y-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h5 className="text-ui-xs font-bold uppercase tracking-wider text-zinc-400">
                        Execution Autopsy
                    </h5>
                    <p className="mt-0.5 text-ui-2xs text-zinc-500">
                        MFE/MAE excursion &amp; behavioral audit across {autopsy.sampleCount} settled trades
                    </p>
                </div>
                <span className="rounded-control border border-hairline bg-white/[0.03] px-2 py-0.5 font-mono text-ui-2xs text-zinc-300 tabular-nums">
                    Avg {fmtR(autopsy.efficiency.avgOutcomeR)}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-control border border-hairline bg-zinc-950/50 p-2.5">
                    <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">MFE Giveback</p>
                    <p className="mt-1 font-mono text-ui-sm font-semibold text-zinc-100 tabular-nums" data-testid="autopsy-mfe-giveback">
                        {fmtPct(autopsy.mfeGiveback.rate)}
                    </p>
                    <p className="mt-0.5 font-mono text-ui-2xs text-zinc-500 tabular-nums">
                        {autopsy.mfeGiveback.count}/{autopsy.mfeGiveback.eligible} peaked &ge;+1.5R
                    </p>
                </div>

                <div className="rounded-control border border-hairline bg-zinc-950/50 p-2.5">
                    <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">Immediate Stop-Outs</p>
                    <p className="mt-1 font-mono text-ui-sm font-semibold text-zinc-100 tabular-nums" data-testid="autopsy-immediate-stops">
                        {fmtPct(autopsy.immediateStopOut.rate)}
                    </p>
                    <p className="mt-0.5 font-mono text-ui-2xs text-zinc-500 tabular-nums">
                        {autopsy.immediateStopOut.count}/{autopsy.immediateStopOut.eligible} stops &lt;+0.3R MFE
                    </p>
                </div>

                <div className="rounded-control border border-hairline bg-zinc-950/50 p-2.5">
                    <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">Revenge Clusters</p>
                    <p className="mt-1 font-mono text-ui-sm font-semibold text-zinc-100 tabular-nums" data-testid="autopsy-revenge-clusters">
                        {autopsy.behavioral.revengeClusters.length}
                    </p>
                    <p className="mt-0.5 font-mono text-ui-2xs text-zinc-500 tabular-nums">
                        &le;30m re-entries · max streak {autopsy.behavioral.maxLossStreak}L
                    </p>
                </div>

                <div className="rounded-control border border-hairline bg-zinc-950/50 p-2.5">
                    <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">Weakest Session / Playbook</p>
                    <p
                        className="mt-1 truncate font-mono text-ui-xs font-semibold text-zinc-100"
                        data-testid="autopsy-weakest-leak"
                        title={weakestPlaybook?.flaggedLeak
                            ? `${humanizeSkillTitle('', weakestPlaybook.key)} (${weakestPlaybook.key}) — ${fmtR(weakestPlaybook.expectancyR)} over N=${weakestPlaybook.sample}`
                            : weakestSession
                                ? `${weakestSession.key} UTC — ${fmtR(weakestSession.expectancyR)} over N=${weakestSession.sample}`
                                : 'No statistical leaks flagged'}
                    >
                        {weakestPlaybook?.flaggedLeak
                            ? `${humanizeSkillTitle('', weakestPlaybook.key)} (${fmtR(weakestPlaybook.expectancyR)})`
                            : weakestSession
                                ? `${weakestSession.key} UTC (${fmtR(weakestSession.expectancyR)})`
                                : 'None flagged'}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-ui-2xs text-zinc-500">
                        {weakestPlaybook && weakestSession
                            ? `${weakestSession.key} UTC ${fmtR(weakestSession.expectancyR)}`
                            : `Capture eff. ${fmtPct(autopsy.efficiency.captureEfficiency)}`}
                    </p>
                </div>
            </div>

            {autopsy.findings.length > 0 ? (
                <ul className="space-y-1 border-t border-hairline pt-2.5" data-testid="autopsy-findings-list">
                    {autopsy.findings.map((finding, idx) => (
                        <li key={idx} className="text-ui-dense leading-relaxed text-zinc-300">
                            · {finding}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="border-t border-hairline pt-2 text-ui-2xs text-zinc-500">
                    No statistical leaks flagged at N={autopsy.sampleCount} (thresholds: &ge;40% MFE giveback, &ge;60% immediate stops, or bucket expectancy &lt;-0.15R).
                </p>
            )}
        </section>
    ) : null;

    if (effectiveClosed === 0) {
        return (
            <div data-testid="learn-analytics" className="space-y-4 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between gap-2">
                    <h4 className="text-ui-xs sm:text-ui-sm font-bold text-zinc-400 uppercase tracking-wider">Learning &amp; accuracy</h4>
                    <span className="font-mono text-ui-dense text-zinc-500">
                        Drawdown <span data-testid="learning-drawdown-value" className="font-semibold text-zinc-100">0.0%</span>
                    </span>
                </div>
                <div
                    data-testid="learning-empty-state"
                    className="rounded-bubble border border-hairline bg-zinc-900/50 p-6 text-center"
                >
                    <p className="text-ui-base font-medium text-zinc-100">No closed trades yet</p>
                    <p className="mx-auto mt-1.5 max-w-md text-ui-sm leading-relaxed text-zinc-500">
                        Log or settle 5 trades to unlock accuracy, regime stats, and execution autopsy.
                    </p>
                </div>
            </div>
        );
    }

    if (effectiveClosed < AUTOPSY_MIN_SAMPLE) {
        return (
            <div data-testid="learn-analytics" className="space-y-4 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
                {harnessSection}
                {lessonsSection}
                <div
                    data-testid="learning-progress-note"
                    className="rounded-bubble border border-hairline bg-zinc-900/50 px-4 py-3 text-ui-sm text-zinc-400"
                >
                    Log or settle {AUTOPSY_MIN_SAMPLE - effectiveClosed} more trade{AUTOPSY_MIN_SAMPLE - effectiveClosed === 1 ? '' : 's'} to unlock full profile breakdowns and execution autopsy ({effectiveClosed} / {AUTOPSY_MIN_SAMPLE}).
                </div>
            </div>
        );
    }

    return (
        <div data-testid="learn-analytics" className="space-y-4 sm:space-y-6 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
            {harnessSection}
            {lessonsSection}
            {autopsySection}
            {totalClosed >= AUTOPSY_MIN_SAMPLE ? (
                <>
                    <ProfileHeader profile={profile} />
                    <TraderProfileCards
                        trades={trades}
                        closedWindowed={closedWindowed}
                        profile={profile}
                    />
                </>
            ) : null}
        </div>
    );
};

export default LearningDashboard;
