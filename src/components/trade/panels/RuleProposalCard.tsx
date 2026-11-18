/**
 * RuleProposalCard — a trading rule promoted from a candidate lesson, gated.
 *
 * The card makes the anti-hindsight split impossible to miss: facts knowable
 * at entry are printed in one list, information visible only after resolution
 * in a second, explicitly excluded list. A rule that cites only hindsight is
 * refused before a card is ever minted (`checkRulePromotionEligibility`), so
 * what reaches the trader has already passed the N >= 2 and knowability tests.
 *
 * Tightening confirms in one tap; LOOSENING discipline needs the explicit
 * second tap. Confirm applies the rule through candidateRuleLoop's store and
 * starts its TTL; the applied state offers a 60s Undo. No colour encodes the
 * direction — the word does.
 */

import React, { useState } from 'react';
import type { RuleProposal } from '../../../services/learning/candidateRuleLoop';
import { QUADRANT_LABELS } from '../../../services/learning/candidateRuleLoop';

export interface RuleProposalCardProps {
    proposal: RuleProposal;
    applied?: boolean;
    revert?: { previousRule: import('../../../services/learning/candidateRuleLoop').ActiveTradingRule | undefined; msLeft: number };
    onConfirm?: () => void;
    onDismiss?: () => void;
    onRevert?: () => void;
}

export const RuleProposalCard: React.FC<RuleProposalCardProps> = ({
    proposal, applied = false, revert, onConfirm, onDismiss, onRevert,
}) => {
    const tightens = proposal.direction === 'tighten';
    const [loosenArmed, setLoosenArmed] = useState(false);

    if (applied) {
        const secondsLeft = revert ? Math.max(1, Math.ceil(revert.msLeft / 1000)) : 0;
        return (
            <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
                data-testid="rule-proposal-applied">
                <div className="flex items-center gap-2">
                    <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                        Rule active (TTL {proposal.ttlDays}d / {proposal.ttlTrades} trades)
                    </span>
                </div>
                <p className="mt-2 font-mono text-ui-dense text-zinc-300">
                    When {proposal.when}, do {proposal.action}
                </p>
                {onRevert && revert && (
                    <div className="mt-2 flex items-center gap-2">
                        <button type="button" onClick={onRevert}
                            className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700"
                            data-testid="rule-proposal-revert">
                            Undo rule
                        </button>
                        <span className="font-mono text-ui-2xs text-zinc-600">window {secondsLeft}s</span>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="rule-proposal-card">
            <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    Rule proposal
                </span>
                <span className="rounded-control px-1.5 py-0.5 font-mono text-ui-2xs uppercase tracking-wider text-zinc-300">
                    {tightens ? 'tightens' : 'loosens'}
                </span>
                <span className="rounded-control px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400">
                    {QUADRANT_LABELS[proposal.quadrant]}
                </span>
                <span className="ml-auto font-mono text-ui-2xs tabular-nums text-zinc-500">
                    n={proposal.tradeIds.length} distinct trades
                </span>
            </div>

            <p className="mt-2 font-mono text-ui-dense uppercase tracking-wider text-zinc-500">Knowable at entry</p>
            <ul className="mt-1 space-y-0.5 font-mono text-ui-dense text-zinc-300">
                {proposal.knowableAtEntry.length === 0
                    ? <li className="text-zinc-500">none — a rule cannot be promoted without entry facts</li>
                    : proposal.knowableAtEntry.map((item, i) => <li key={i}>· {item}</li>)}
            </ul>

            <p className="mt-2 font-mono text-ui-dense uppercase tracking-wider text-zinc-500">Excluded post-resolution</p>
            <ul className="mt-1 space-y-0.5 font-mono text-ui-dense text-zinc-400">
                {proposal.visibleOnlyAfterResolution.length === 0
                    ? <li>none</li>
                    : proposal.visibleOnlyAfterResolution.map((item, i) => <li key={i}>· {item}</li>)}
            </ul>

            <p className="mt-2 text-ui-sm text-zinc-300">
                When {proposal.when}, do {proposal.action}
            </p>
            <p className="mt-1 font-mono text-ui-2xs tabular-nums text-zinc-500">
                TTL: {proposal.ttlDays}d or {proposal.ttlTrades} trades
            </p>
            <p className="mt-1 text-ui-sm text-zinc-400">{proposal.reason}</p>

            <div className="mt-2 flex items-center gap-2">
                {tightens || loosenArmed ? (
                    <button type="button" onClick={onConfirm}
                        className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                        data-testid="rule-proposal-confirm">
                        {tightens ? 'Confirm rule' : 'Confirm: apply looser rule'}
                    </button>
                ) : (
                    <button type="button" onClick={() => setLoosenArmed(true)}
                        className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700"
                        data-testid="rule-proposal-arm">
                        Loosens discipline — confirm?
                    </button>
                )}
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="rule-proposal-dismiss">
                    Dismiss
                </button>
            </div>
        </div>
    );
};

export default RuleProposalCard;
