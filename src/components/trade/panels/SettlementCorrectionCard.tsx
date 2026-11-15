/**
 * SettlementCorrectionCard — the agent's PROPOSED fix for one journal row, with
 * Confirm / Dismiss. The card is the whole point of P-6: the journal's manual
 * outcome and PnL editors are retired in favour of "the agent proposes, the
 * trader confirms", and this is the confirm.
 *
 * The card holds no authority. Confirm calls `onConfirm`, which is the SAME hook
 * a human edit calls (`useTradeJournalActions`), so the correction lands with
 * `correctedFrom`, `correctedAt` and `resolutionSource: 'correction'` — the
 * audit trail a silent write would have skipped.
 */

import React from 'react';
import type { SettlementCorrectionProposal } from '../../../services/trade/settlementCorrection';
import { TradeOutcome } from '../../../types/enums';

export interface SettlementCorrectionCardProps {
    proposal: SettlementCorrectionProposal;
    /** The row's CURRENT outcome and PnL, so the card can show what changes. */
    current?: { outcome?: TradeOutcome; pnlAmount?: number; pnlPercent?: number };
    onConfirm: () => void;
    onDismiss: () => void;
}

/** What the row says now, in the words the journal uses. */
const describeOutcome = (outcome?: TradeOutcome): string => outcome ?? 'unsettled';

const fmtPnl = (amount?: number, percent?: number): string => {
    if (typeof amount === 'number' && Number.isFinite(amount)) {
        return `${amount >= 0 ? '+' : ''}${amount}`;
    }
    if (typeof percent === 'number' && Number.isFinite(percent)) {
        return `${percent >= 0 ? '+' : ''}${percent}%`;
    }
    return 'unchanged';
};

export const SettlementCorrectionCard: React.FC<SettlementCorrectionCardProps> = ({
    proposal, current, onConfirm, onDismiss,
}) => {
    const outcomeChanges = proposal.outcome !== undefined && proposal.outcome !== current?.outcome;
    const pnlChanges = (proposal.pnlAmount !== undefined && proposal.pnlAmount !== current?.pnlAmount)
        || (proposal.pnlPercent !== undefined && proposal.pnlPercent !== current?.pnlPercent);

    return (
        <div className="mt-1 rounded-control border border-amber-500/30 bg-amber-500/[0.04] p-2.5"
            data-testid="settlement-correction-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-amber-500/15 px-1.5 py-0.5 text-ui-xs font-bold text-amber-400">
                    Correction
                </span>
                <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                    proposed settlement fix
                </span>
            </div>

            <p className="mt-2 text-ui-sm text-zinc-300">{proposal.reason}</p>

            <div className="mt-2 grid grid-cols-2 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">Outcome</div>
                    <div className={outcomeChanges ? 'font-semibold text-amber-300' : 'text-zinc-400'}>
                        {outcomeChanges
                            ? `${describeOutcome(current?.outcome)} → ${describeOutcome(proposal.outcome)}`
                            : describeOutcome(current?.outcome)}
                    </div>
                </div>
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">P&amp;L</div>
                    <div className={pnlChanges ? 'font-semibold text-amber-300' : 'text-zinc-400'}>
                        {pnlChanges
                            ? `${fmtPnl(current?.pnlAmount, current?.pnlPercent)} → ${fmtPnl(proposal.pnlAmount, proposal.pnlPercent)}`
                            : fmtPnl(current?.pnlAmount, current?.pnlPercent)}
                    </div>
                </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onConfirm}
                    className="rounded-control bg-amber-500/20 px-2 py-1 text-ui-xs font-semibold text-amber-300 hover:bg-amber-500/30"
                    data-testid="settlement-correction-confirm">
                    Confirm correction
                </button>
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-hairline px-2 py-1 text-ui-xs text-zinc-400 hover:text-zinc-200"
                    data-testid="settlement-correction-dismiss">
                    Dismiss
                </button>
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    nothing changes until you confirm
                </span>
            </div>
        </div>
    );
};

export default SettlementCorrectionCard;