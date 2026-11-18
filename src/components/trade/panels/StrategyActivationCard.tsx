/**
 * StrategyActivationCard — the agent's PROPOSED activation or retirement of
 * one strategy plan, in the same decision-card shape as the risk card.
 *
 * There is no tighten/loosen asymmetry here — neither direction is a limit —
 * so the confirm is one tap either way. The card prints WHAT CHANGES (the
 * plan joins or leaves the seat context from the next turn) and the before/
 * after status, and Confirm calls `onConfirm`, which applies through the ONE
 * writer the trader's own Settings screen uses (`setStrategyStatus`) —
 * nothing here touches a plan directly.
 *
 * After a confirm the card stays for the same 60s REVERT window the risk card
 * uses, showing the status it replaced, with a one-tap Revert.
 */

import React from 'react';
import type { StrategyActivationProposal } from '../../../services/trade/strategyActivation';

export interface StrategyActivationCardProps {
    proposal: StrategyActivationProposal;
    /** The change was confirmed and is inside its revert window. */
    applied?: boolean;
    /** The revert window's remaining state (from strategyRevertOf). */
    revert?: { previousStatus: string; msLeft: number };
    onConfirm?: () => void;
    onDismiss?: () => void;
    /** Put the replaced status back. Absent ⇒ no revert control. */
    onRevert?: () => void;
}

const STATUS_LABEL: Record<string, string> = {
    draft: 'draft — not in front of the seats',
    active: 'active — in front of every seat',
    retired: 'retired — record kept, rules out of context',
};

export const StrategyActivationCard: React.FC<StrategyActivationCardProps> = ({
    proposal, applied = false, revert, onConfirm, onDismiss, onRevert,
}) => {
    const secondsLeft = revert ? Math.max(1, Math.ceil(revert.msLeft / 1000)) : 0;

    if (applied) {
        return (
            <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
                data-testid="strategy-activation-applied">
                <div className="flex items-center gap-2">
                    <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                        Strategy {proposal.proposedStatus}
                    </span>
                    <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                        {proposal.name}
                    </span>
                </div>
                <p className="mt-2 font-mono text-ui-dense tabular-nums text-zinc-300">
                    {proposal.currentStatus} → <span className="font-semibold text-zinc-200">{proposal.proposedStatus}</span>
                </p>
                {onRevert && revert && (
                    <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={onRevert}
                            className="rounded-control border border-hairline px-2 py-1 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06]"
                            data-testid="strategy-activation-revert">
                            Revert to {revert.previousStatus}
                        </button>
                        <span className="font-mono text-ui-2xs text-zinc-600">window {secondsLeft}s</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="strategy-activation-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    Strategy {proposal.action}
                </span>
                <span className="ml-auto font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                    {proposal.slug}
                </span>
            </div>

            <p className="mt-2 text-ui-sm text-zinc-300">{proposal.reason}</p>

            <div className="mt-2 grid grid-cols-2 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Now</div>
                    <div className="text-zinc-400">{STATUS_LABEL[proposal.currentStatus] ?? proposal.currentStatus}</div>
                </div>
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Proposed</div>
                    <div className="font-semibold text-zinc-200">{STATUS_LABEL[proposal.proposedStatus] ?? proposal.proposedStatus}</div>
                </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onConfirm}
                    className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                    data-testid="strategy-activation-confirm">
                    Confirm {proposal.action}
                </button>
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="strategy-activation-dismiss">
                    Dismiss
                </button>
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    {proposal.action === 'activate' ? 'the rules join every seat' : 'the rules leave the seats'}
                </span>
            </div>
        </div>
    );
};

export default StrategyActivationCard;
