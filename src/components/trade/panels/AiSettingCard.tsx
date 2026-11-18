/**
 * AiSettingCard — the agent's PROPOSED toggle of `Hybrid Intelligence` or
 * `Desk Tools`, with the owner's asymmetry built in exactly as on the risk
 * card:
 *
 *   - TURNING OFF is a tightening: ONE TAP ("Confirm change").
 *   - TURNING ON is a loosening: the before/after is printed and the first tap
 *     only ARMS the card ("Enabling capability — confirm?"), the second applies
 *     ("Confirm: turn ON").
 *
 * Monochrome on purpose: these are capability switches, not risk numbers. The
 * card holds no authority — Confirm calls `onConfirm`, which writes through
 * the one settings writer the trader's own Settings screen uses. A confirmed
 * change stays for a 60s revert window.
 */

import React, { useState } from 'react';
import type { AiSettingProposal } from '../../../services/trade/aiSettingProposal';

export interface AiSettingCardProps {
    proposal: AiSettingProposal;
    /** The change was confirmed and is inside its revert window. */
    applied?: boolean;
    /** Remaining revert state (from aiSettingRevertOf). */
    revert?: { previousValue: boolean; msLeft: number };
    /** Decision state only — the applied card has nothing to confirm. */
    onConfirm?: () => void;
    onDismiss?: () => void;
    /** Put the replaced value back. Absent ⇒ no revert control. */
    onRevert?: () => void;
}

const labelFor = (target: string): string => target === 'hybridIntelligence'
    ? 'Hybrid Intelligence'
    : target === 'deskToolsEnabled'
        ? 'Desk Tools'
        : target;

const onOff = (value: boolean): string => (value ? 'ON' : 'OFF');

export const AiSettingCard: React.FC<AiSettingCardProps> = ({
    proposal, applied = false, revert, onConfirm, onDismiss, onRevert,
}) => {
    const tighten = proposal.direction === 'tighten';
    // Turning a capability ON needs the explicit second tap.
    const [loosenArmed, setLoosenArmed] = useState(false);
    const secondsLeft = revert ? Math.max(1, Math.ceil(revert.msLeft / 1000)) : 0;

    if (applied) {
        return (
            <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
                data-testid="ai-setting-applied">
                <div className="flex items-center gap-2">
                    <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                        AI setting updated
                    </span>
                    <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                        {labelFor(proposal.target)}
                    </span>
                </div>
                <p className="mt-2 font-mono text-ui-dense tabular-nums text-zinc-300">
                    {onOff(proposal.currentValue)} → <span className="font-semibold text-zinc-200">{onOff(proposal.proposedValue)}</span>
                </p>
                {onRevert && revert && (
                    <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={onRevert}
                            className="rounded-control border border-line bg-zinc-800 px-2 py-1 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700"
                            data-testid="ai-setting-revert">
                            Revert to {onOff(revert.previousValue)}
                        </button>
                        <span className="font-mono text-ui-2xs text-zinc-600">window {secondsLeft}s</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="ai-setting-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    AI setting
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
                    <div className="text-zinc-400">{onOff(proposal.currentValue)}</div>
                </div>
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Proposed</div>
                    <div className="font-semibold text-zinc-200">{onOff(proposal.proposedValue)}</div>
                </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
                {tighten || loosenArmed ? (
                    <button type="button" onClick={onConfirm}
                        className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                        data-testid="ai-setting-confirm">
                        {tighten ? 'Confirm change' : 'Confirm: turn ON'}
                    </button>
                ) : (
                    <button type="button" onClick={() => setLoosenArmed(true)}
                        className="rounded-control border border-line bg-zinc-800 px-2 py-1 text-ui-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700"
                        data-testid="ai-setting-arm">
                        Enabling capability — confirm?
                    </button>
                )}
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="ai-setting-dismiss">
                    Dismiss
                </button>
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    {tighten ? 'one tap turns it OFF' : 'turning ON needs the second tap'}
                </span>
            </div>
        </div>
    );
};

export default AiSettingCard;
