/**
 * TradeActionCard — the agent's PROPOSED action on a trade the trader already
 * armed, with Confirm / Dismiss. This is the card for the two AUTHORITY
 * changes: `update_trade` (move the levels) and `close_trade` (close it).
 *
 * Principle 5 is the reason this card exists: an authority change is never
 * hidden and never dressed up as a prep step. The tool only RECORDS the
 * proposal; the trader's confirm is what applies it, through the journal's own
 * writers. Nothing here writes anything.
 */

import React from 'react';
import type { TradeActionProposal } from '../../../services/trade/tradeActionProposal';

export interface TradeActionCardProps {
    proposal: TradeActionProposal;
    /** The plan's CURRENT levels, so the card can show what actually changes. */
    current?: { entry?: number; stopLoss?: number; takeProfits?: number[] };
    onConfirm: () => void;
    onDismiss: () => void;
}

const fmt = (v?: number): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');

/** One level's before → after. Equal values read as "unchanged", not as a
 *  coincidence of two different numbers. */
const LevelCell: React.FC<{ label: string; before?: number; after?: number }> = ({ label, before, after }) => {
    const changed = before !== after;
    return (
        <div>
            <div className="font-mono text-ui-xs uppercase text-zinc-500">{label}</div>
            <div className={changed ? 'font-semibold text-zinc-200' : 'text-zinc-400'}>
                {changed ? `${fmt(before)} → ${fmt(after)}` : fmt(after)}
            </div>
        </div>
    );
};

export const TradeActionCard: React.FC<TradeActionCardProps> = ({ proposal, current, onConfirm, onDismiss }) => {
    const isClose = proposal.kind === 'close';
    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="trade-action-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    {isClose ? 'Close trade' : 'Level change'}
                </span>
                <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                    proposed on an armed plan
                </span>
            </div>

            <p className="mt-2 text-ui-sm text-zinc-300">{proposal.reason}</p>

            {!isClose && (
                <div className="mt-2 grid grid-cols-3 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
                    <LevelCell label="Entry" before={current?.entry} after={proposal.entry ?? current?.entry} />
                    <LevelCell label="SL" before={current?.stopLoss} after={proposal.stopLoss ?? current?.stopLoss} />
                    <LevelCell label="TP1" before={current?.takeProfits?.[0]}
                        after={proposal.takeProfits?.[0] ?? current?.takeProfits?.[0]} />
                </div>
            )}

            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onConfirm} data-testid="trade-action-confirm"
                    className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white">
                    {isClose ? 'Confirm close' : 'Confirm new levels'}
                </button>
                <button type="button" onClick={onDismiss} data-testid="trade-action-dismiss"
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700">
                    Dismiss
                </button>
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    nothing changes until you confirm
                </span>
            </div>
        </div>
    );
};

export default TradeActionCard;