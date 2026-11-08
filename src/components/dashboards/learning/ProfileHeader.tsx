
import React from 'react';
import type { PersonalizedLearningProfile } from '../../../services/learning/SelfLearningService';
import { getWinRateColor } from './shared';

/**
 * Header + the two headline numbers.
 *
 * The three "meta-calibration" cards that used to sit here (worth-gate
 * precision, refinement recovery, eval agreement) were deleted on 2026-11-06
 * with the module behind them: every recorder in that store belonged to the
 * retired skill lifecycle, so nothing wrote a sample and the cards could only
 * ever print '—'. A metric that cannot be non-empty is not a measurement.
 */
export const ProfileHeader: React.FC<{
    profile: PersonalizedLearningProfile;
}> = ({ profile }) => {
    return (
        <>
            {/* Header */}
            <div className="text-center pb-3 sm:pb-4 border-b border-hairline">
                <h2 className="text-ui-lg sm:text-lg font-bold text-cyan-400 mb-1">AI Learning Profile</h2>
                <p className="text-ui-xs sm:text-ui-sm text-zinc-500">
                    Based on {profile.totalAnalyzedTrades} analyzed trades
                </p>
            </div>

            {/* Overall Performance */}
            <div className="grid grid-cols-2 gap-2 sm:gap-4">
                <div className="bg-gradient-to-br from-cyan-950/50 to-zinc-900 rounded-bubble p-3 sm:p-4 border border-cyan-500/20">
                    <p className="text-ui-2xs sm:text-ui-sm text-cyan-400/70 uppercase tracking-wider mb-1">Win Rate</p>
                    <p className={`text-2xl sm:text-3xl font-black ${getWinRateColor(profile.overallWinRate)}`}>
                        {profile.overallWinRate}%
                    </p>
                </div>
                <div className="bg-zinc-900 rounded-bubble p-3 sm:p-4 border border-zinc-800/80">
                    <p className="text-ui-2xs sm:text-ui-sm text-zinc-500 uppercase tracking-wider mb-1">Trades</p>
                    <p className="text-2xl sm:text-3xl font-black text-white">
                        {profile.totalAnalyzedTrades}
                    </p>
                </div>
            </div>
        </>
    );
};

export default ProfileHeader;
