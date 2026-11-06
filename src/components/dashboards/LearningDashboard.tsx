import React, { useMemo, useState } from 'react';
import { BrainCircuit } from '../shared/Icons';
import { LoggedTrade, TradeOutcome } from '../../types';
import { decidedAtOf } from '../../utils/journalAnalytics';
import { computeLearningProfile } from '../../services/learning/SelfLearningService';
import { computeTopLessons } from '../../services/learning/MemoryFilesService';
import { EmptyState } from '../ui/EmptyState';
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

    const closedWindowed = useMemo(() => windowedTrades.filter(isClosed), [windowedTrades]);

    const harnessSection = (
        <HarnessSection
            closedWindowed={closedWindowed}
            totalClosed={trades.filter(isClosed).length}
            windowDays={windowDays}
            onWindowDaysChange={setWindowDays}
        />
    );
    const lessonsSection = <LessonsSection topLessons={topLessons} closedWindowed={closedWindowed} />;

    if (profile.totalAnalyzedTrades < 3) {
        return (
            <div data-testid="learn-analytics" className="space-y-4 p-3 sm:p-4 overflow-y-auto custom-scrollbar">
                {harnessSection}
                {lessonsSection}
                <EmptyState
                    icon={<BrainCircuit className="w-8 h-8" aria-hidden="true" />}
                    title="Building Your Profile"
                    description={`Log at least 3 trades (WIN or LOSS) to start seeing personalized AI learnings. Current: ${profile.totalAnalyzedTrades} / 3 trades.`}
                    className="h-64"
                />
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
