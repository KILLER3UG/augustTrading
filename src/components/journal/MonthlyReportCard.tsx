import React, { useEffect, useState } from 'react';
import { loadMonthlyReport, MonthlyReportCard as MonthlyReport } from '../../services/learning/monthlyReport';
import { fmtRMultiple } from '../../utils/riskReward';

/**
 * Monthly report card (Batch 5 remainder,) — what happened /
 * what was learned / needs attention, plus the GRADE-THE-PANEL section:
 * per-provider, moderator, and ensemble-line Brier for the period
 * ("which seats were actually right"). Reads the stored card only;
 * generation happens at boot. Monochrome; Brier quality encodes as
 * text labels, not color.
 */
export const MonthlyReportCard: React.FC<{ username: string }> = ({ username }) => {
    const [card, setCard] = useState<MonthlyReport | null>(null);
    useEffect(() => {
        let alive = true;
        void loadMonthlyReport(username).then(c => { if (alive) setCard(c); });
        return () => { alive = false; };
    }, [username]);
    if (!card) return null;
    const w = card.whatHappened;
    const l = card.whatLearned;
    // A percent-only month has no dollars to sum. Legacy cards stored no
    // dollarRows; a nonzero net is still evidence it carried some, while a
    // stored zero is not evidence of a zero-P&L month.
    const pnlCaptured = w.dollarRows === undefined ? w.netPnlUsd !== 0 : w.dollarRows > 0;
    const pnlText = pnlCaptured
        ? `Net $${Math.round(w.netPnlUsd)}${w.dollarRows !== undefined && w.dollarRows < w.closed ? ` (${w.dollarRows}/${w.closed} rows)` : ''}`
        : 'Net not captured';
    const gradeCell = (row: { label: string; n: number; winRate: number; brier: number | null; quality: string } | null): React.ReactNode => {
        if (!row || row.n === 0) return null;
        return (
            <div key={row.label} className="flex items-baseline justify-between gap-3 text-ui-dense tabular-nums">
                <span className="truncate text-zinc-300" title={row.label}>{row.label}</span>
                <span className="shrink-0 text-zinc-500">
                    {row.n} closed · {row.winRate.toFixed(0)}% win
                    {row.brier !== null && <> · Brier {row.brier.toFixed(3)} ({row.quality})</>}
                    {row.brier === null && ' · Brier n<3'}
                </span>
            </div>
        );
    };
    return (
        <div className="rounded-bubble border border-hairline bg-zinc-900/60 p-4">
            <div className="flex items-baseline justify-between">
                <p className="text-ui-xs font-bold uppercase tracking-widest text-zinc-500">
                    Monthly report · {card.periodStart.slice(0, 10)} → {card.generatedAt.slice(0, 10)}
                </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ui-dense text-zinc-500 tabular-nums">
                <span>{w.closed} closed ({w.wins}W/{w.losses}L)</span>
                <span>{pnlText}</span>
                {w.avgR !== null && <span>avg R {fmtRMultiple(w.avgR)}</span>}
                {l.adherenceFollowedPct !== null && <span>adherence {l.adherenceFollowedPct}%</span>}
                {l.biggestMistake && <span>costliest: {l.biggestMistake}</span>}
                {l.bestTrade && <span>best: {l.bestTrade.label} +${Math.round(l.bestTrade.pnlUsd)}</span>}
            </div>
            {card.needsAttention.length > 0 && (
                <ul className="mt-3 space-y-1 text-ui-dense text-zinc-400">
                    {card.needsAttention.map(line => (
                        <li key={line} className="flex gap-2">
                            <span className="text-zinc-600">—</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="mt-3 border-t border-hairline pt-2">
                <p className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-600">Grade the panel — legacy debate rows only (Brier, 0.25 = coin flip)</p>
                <div className="mt-1 space-y-0.5">
                    {card.panel.moderator && gradeCell(card.panel.moderator)}
                    {card.panel.ensembleLine && gradeCell(card.panel.ensembleLine)}
                    {card.panel.seats.map(s => gradeCell(s))}
                    {card.panel.seats.length === 0 && !card.panel.moderator && (
                        <p className="text-ui-dense text-zinc-600">no graded rows this period</p>
                    )}
                </div>
            </div>
        </div>
    );
};
