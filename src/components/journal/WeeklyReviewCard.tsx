import React, { useEffect, useState } from 'react';
import { loadWeeklyReview, weekPnlCaptured, weekPnlText, WeeklyReviewDigest } from '../../services/learning/weeklyReview';
import { fmtRMultiple } from '../../utils/riskReward';

/**
 * Weekly review card — the deterministic week stats
 * plus the ONE improvement impulse, rendered at the top of the Journal
 * analytics tab. Reads the stored digest only; generation happens at boot.
 */
export const WeeklyReviewCard: React.FC<{ username: string }> = ({ username }) => {
    const [digest, setDigest] = useState<WeeklyReviewDigest | null>(null);
    useEffect(() => {
        let alive = true;
        void loadWeeklyReview(username).then(d => { if (alive) setDigest(d); });
        return () => { alive = false; };
    }, [username]);
    if (!digest) return null;
    const s = digest.stats;
    return (
        <div className="rounded-bubble border border-hairline bg-zinc-900/60 p-4">
            <div className="flex items-baseline justify-between">
                <p className="text-ui-xs font-bold uppercase tracking-widest text-zinc-500">
                    Weekly review · {digest.generatedAt.slice(0, 10)}
                </p>
                <span className="text-ui-2xs text-zinc-600">via {digest.providerName}</span>
            </div>
            <p className="mt-2 text-ui-base leading-relaxed text-zinc-200">{digest.impulse}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-ui-dense text-zinc-500 tabular-nums">
                <span>{s.closed} closed ({s.wins}W/{s.losses}L)</span>
                {/* The same derivation the coach prompt was grounded in: a week of
                    percentage-only trades reads "P&L not captured", never "Net $0". */}
                <span>{weekPnlCaptured(s) ? `Net ${weekPnlText(s)}` : 'P&L not captured'}</span>
                {s.avgR !== null && <span>avg R {fmtRMultiple(s.avgR)}</span>}
                {s.adherenceFollowedPct !== null && <span>adherence {s.adherenceFollowedPct}%</span>}
                {s.topMistake && <span>costliest: {s.topMistake}</span>}
                {s.givebackDays > 0 && <span>givebacks: {s.givebackDays}</span>}
            </div>
        </div>
    );
};
