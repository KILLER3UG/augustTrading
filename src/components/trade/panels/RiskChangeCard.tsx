/**
 * RiskChangeCard — the agent's PROPOSED change to one risk limit or the
 * session-guard preset, with the owner's ASYMMETRY built in:
 *
 *   - TIGHTENING a limit is ONE TAP ("Confirm change").
 *   - LOOSENING one prints the before/after and needs an EXPLICIT confirm —
 *     the first tap only arms the card ("This loosens risk — confirm"), the
 *     second applies. A looser limit is the direction that can hurt, so it
 *     never applies on the same tap that proposed it.
 *
 * The card holds no authority: Confirm calls `onConfirm`, which writes through
 * the ONE settings writer the trader's own Settings screen uses
 * (`saveHarnessSettings`) — nothing here touches a setting directly.
 *
 * After a confirm the card stays for a short REVERT window showing the value
 * it replaced, with a one-tap Revert — a risk change deserves a longer look
 * than the approval undo, but it is still a window, not a permanent panel.
 */

import React, { useState } from 'react';
import type { RiskChangeProposal } from '../../../services/trade/riskChangeProposal';
import { RISK_TARGET_LIMITS } from '../../../services/trade/riskChangeProposal';

export interface RiskChangeCardProps {
    proposal: RiskChangeProposal;
    /** The change was confirmed and is inside its revert window: the card
     *  shows what was applied and offers the one-tap revert. */
    applied?: boolean;
    /** The revert window's remaining state (from riskRevertOf). */
    revert?: { previousValue: number | string; msLeft: number };
    /** Only used by the DECISION state; the applied card has nothing to confirm. */
    onConfirm?: () => void;
    onDismiss?: () => void;
    /** Put the replaced value back. Absent ⇒ no revert control. */
    onRevert?: () => void;
}

const labelFor = (target: string): string =>
    (RISK_TARGET_LIMITS as Record<string, { label: string } | undefined>)[target]?.label
    ?? (target === 'guardPreset' ? 'session-guard preset' : target);

const fmtValue = (v: number | string): string => String(v);

export const RiskChangeCard: React.FC<RiskChangeCardProps> = ({
    proposal, applied = false, revert, onConfirm, onDismiss, onRevert,
}) => {
    const tighten = proposal.direction === 'tighten';
    // LOOSENING needs the explicit second tap: the first only arms the card.
    const [loosenArmed, setLoosenArmed] = useState(false);
    const secondsLeft = revert ? Math.max(1, Math.ceil(revert.msLeft / 1000)) : 0;

    if (applied) {
        return (
            <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
                data-testid="risk-change-applied">
                <div className="flex items-center gap-2">
                    <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                        Risk change applied
                    </span>
                    <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                        {labelFor(proposal.target)}
                    </span>
                </div>
                <p className="mt-2 font-mono text-ui-dense tabular-nums text-zinc-300">
                    {fmtValue(proposal.currentValue)} → <span className="font-semibold text-zinc-200">{fmtValue(proposal.proposedValue)}</span>
                </p>
                {onRevert && revert && (
                    <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={onRevert}
                            className="rounded-control border border-hairline px-2 py-1 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06]"
                            data-testid="risk-change-revert">
                            Revert to {fmtValue(revert.previousValue)}
                        </button>
                        <span className="font-mono text-ui-2xs text-zinc-600">window {secondsLeft}s</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="risk-change-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    Risk change
                </span>
                <span className="rounded-control px-1.5 py-0.5 font-mono text-ui-2xs uppercase tracking-wider text-zinc-300">
                    {tighten ? 'tightens' : 'loosens'}
                </span>
                <span className="ml-auto font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                    {labelFor(proposal.target)}
                </span>
            </div>

            <p className="mt-2 text-ui-sm text-zinc-300">{proposal.reason}</p>

            <div className="mt-2 grid grid-cols-2 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Now</div>
                    <div className="text-zinc-400">{fmtValue(proposal.currentValue)}</div>
                </div>
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Proposed</div>
                    <div className="font-semibold text-zinc-200">{fmtValue(proposal.proposedValue)}</div>
                </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
                {tighten || loosenArmed ? (
                    <button type="button" onClick={onConfirm}
                        className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                        data-testid="risk-change-confirm">
                        {tighten ? 'Confirm change' : 'Confirm: apply the looser limit'}
                    </button>
                ) : (
                    <button type="button" onClick={() => setLoosenArmed(true)}
                        className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700"
                        data-testid="risk-change-arm">
                        Loosens risk — confirm?
                    </button>
                )}
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="risk-change-dismiss">
                    Dismiss
                </button>
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    {tighten ? 'one tap tightens' : 'loosening needs the second tap'}
                </span>
            </div>
        </div>
    );
};

export default RiskChangeCard;
