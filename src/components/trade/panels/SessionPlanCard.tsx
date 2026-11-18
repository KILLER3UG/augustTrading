/**
 * SessionPlanCard — the agent's PROPOSED plan for the coming session.
 *
 * The card holds no authority. The desk's `propose_session_plan` call records
 * a proposal and this component only renders it; nothing becomes active until
 * the trader taps Confirm, which persists the plan through the sessionPlan
 * store. A confirmed plan stays on screen for a 60s revert window, then the
 * applied state is simply a verified record — "verified once per session",
 * never a panel the model can re-open.
 *
 * Monochrome by rule: no status colour for the bias, the bounds or the date.
 */

import React from 'react';
import type { SessionPlanProposal } from '../../../services/trade/sessionPlan';

export interface SessionPlanCardProps {
    proposal: SessionPlanProposal;
    /** The plan was confirmed and is inside its revert window. */
    applied?: boolean;
    /** Remaining revert state (from sessionPlanRevertOf). */
    revert?: { previousPlan: SessionPlanProposal | undefined; msLeft: number };
    onConfirm?: () => void;
    onDismiss?: () => void;
    onRevert?: () => void;
}

const Bounds: React.FC<{ proposal: SessionPlanProposal }> = ({ proposal }) => (
    <div className="mt-2 grid grid-cols-2 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
        <div>
            <div className="font-mono text-ui-xs uppercase text-zinc-500">Bias</div>
            <div className="font-semibold text-zinc-200">{proposal.sessionBias}</div>
        </div>
        <div>
            <div className="font-mono text-ui-xs uppercase text-zinc-500">Max trades</div>
            <div className="text-zinc-400">{proposal.maxTrades}</div>
        </div>
        <div>
            <div className="font-mono text-ui-xs uppercase text-zinc-500">Max loss</div>
            <div className="text-zinc-400">{proposal.maxLossR}R</div>
        </div>
        <div>
            <div className="font-mono text-ui-xs uppercase text-zinc-500">Session</div>
            <div className="text-zinc-400">{proposal.dateKey}</div>
        </div>
    </div>
);

export const SessionPlanCard: React.FC<SessionPlanCardProps> = ({
    proposal, applied = false, revert, onConfirm, onDismiss, onRevert,
}) => {
    if (applied) {
        const secondsLeft = revert ? Math.max(1, Math.ceil(revert.msLeft / 1000)) : 0;
        return (
            <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
                data-testid="session-plan-applied">
                <div className="flex items-center gap-2">
                    <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                        Session plan active
                    </span>
                    <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                        verified once per session
                    </span>
                    <span className="ml-auto font-mono text-ui-xs tabular-nums text-zinc-500">{proposal.dateKey}</span>
                </div>
                <p className="mt-2 font-mono text-ui-dense tabular-nums text-zinc-300">
                    Focus {proposal.focusPairs.join(', ')} · bias {proposal.sessionBias}
                    {' · '}max {proposal.maxTrades} trades · max loss {proposal.maxLossR}R
                </p>
                {onRevert && revert && (
                    <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={onRevert}
                            className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700"
                            data-testid="session-plan-revert">
                            Revert session plan
                        </button>
                        <span className="font-mono text-ui-2xs text-zinc-600">window {secondsLeft}s</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="session-plan-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    Session plan
                </span>
                <span className="ml-auto font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                    {proposal.dateKey}
                </span>
            </div>

            <p className="mt-2 font-mono text-ui-dense uppercase tracking-wider text-zinc-500">Focus pairs</p>
            <p className="font-mono text-ui-dense tabular-nums text-zinc-200">{proposal.focusPairs.join(', ')}</p>

            <Bounds proposal={proposal} />

            <p className="mt-2 font-mono text-ui-dense uppercase tracking-wider text-zinc-500">Invalidations</p>
            <ul className="mt-1 space-y-0.5 font-mono text-ui-dense text-zinc-300">
                {proposal.invalidations.map((item, i) => <li key={i}>· {item}</li>)}
            </ul>

            {proposal.notes && <p className="mt-2 text-ui-sm text-zinc-400">{proposal.notes}</p>}
            <p className="mt-2 text-ui-sm text-zinc-300">{proposal.reason}</p>

            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onConfirm}
                    className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                    data-testid="session-plan-confirm">
                    Confirm session plan
                </button>
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="session-plan-dismiss">
                    Dismiss
                </button>
            </div>
        </div>
    );
};

export default SessionPlanCard;
