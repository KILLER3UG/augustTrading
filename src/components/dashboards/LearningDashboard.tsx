import React, { useMemo, useState } from 'react';
import { LoggedTrade, TradeOutcome } from '../../types';
import { decidedAtOf } from '../../utils/journalAnalytics';
import { computeLearningProfile } from '../../services/learning/SelfLearningService';
import { computeTopLessons } from '../../services/learning/MemoryFilesService';
import { HarnessSection } from './learning/HarnessSection';
import { LessonsSection } from './learning/LessonsSection';
import { ProfileHeader } from './learning/ProfileHeader';
import { TraderProfileCards } from './learning/TraderProfileCards';

interface LearningDashboardProps {
    trades: LoggedTrade[];
    /** Active user - retained for the host's wiring. */
    username?: string;
}

const isClosed = (t: LoggedTrade): boolean => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS;

/**
 * The learning profile - every number here is a read of a store the loop
 * already writes. The skill ledger cards are gone: a skill is a document, so
 * there is no record, lift or veto accuracy to chart.
 */
export const LearningDashboard: React.FC<LearningDashboardProps> = ({ trades }) => {
    const profile = useMemo(() => computeLearningProfile(trades), [trades]);
    const topLessons = useMemo(() => computeTopLessons(trades, 6), [trades]);

    const [windowDays, setWindowDays] = useState<0 | 30 | 90>(0);
    const windowedTrades = useMemo(() => {
        if (windowDays === 0) return trades;
        const cutoff = Date.now() - windowDays * 86_400_000;
        return trades.filter(t => new Date(decidedAtOf(t)).getTime() >= cutoff);
    }, [trades, windowDays]);

    const totalClosed = useMemo(() => trades.filter(isClosed).length, [trades]);
    const closedWindowed = useMemo(() => windowedTrades.filter(isClosed), [windowedTrades]);

    const harnessSection = (
        <HarnessSection
            closedWindowed={closedWindowed}
            totalClosed={totalClosed}
            windowDays={windowDays}
            onWindowDaysChange={setWindowDays}
        />
    );
    const lessonsSection = <LessonsSection topLessons={topLessons} closedWindowed={closedWindowed} />;

    if (totalClosed === 0) {
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

    if (totalClosed < 5) {
        return (
            <div data-testid="learn-analytics" className="space-y-4 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
                {harnessSection}
                {lessonsSection}
                <div
                    data-testid="learning-progress-note"
                    className="rounded-bubble border border-hairline bg-zinc-900/50 px-4 py-3 text-ui-sm text-zinc-400"
                >
                    Log or settle {5 - totalClosed} more trade{5 - totalClosed === 1 ? '' : 's'} to unlock full profile breakdowns and execution autopsy ({totalClosed} / 5).
                </div>
            </div>
        );
    }

    return (
        <div data-testid="learn-analytics" className="space-y-4 sm:space-y-6 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
            {harnessSection}
            {lessonsSection}
            <ProfileHeader profile={profile} />
            <TraderProfileCards
                trades={trades}
                closedWindowed={closedWindowed}
                profile={profile}
            />
        </div>
    );
};

export default LearningDashboard;
