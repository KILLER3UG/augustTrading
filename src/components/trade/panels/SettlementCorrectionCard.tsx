/**
 * SettlementCorrectionCard — the agent's PROPOSED fix for one journal row, with
 * Confirm / Dismiss / Void. The card is the whole point of P-6: the journal's
 * manual outcome and PnL editors — and its manual row DELETES — are retired in
 * favour of "the agent proposes, the trader decides", and this is where the
 * decision happens.
 *
 * The card holds no authority. Confirm calls `onConfirm`, which is the SAME hook
 * a human edit calls (`useTradeJournalActions`), so the correction lands with
 * `correctedFrom`, `correctedAt` and `resolutionSource: 'correction'` — the
 * audit trail a silent write would have skipped. Void is the SEPARATE explicit
 * delete: the row goes through the journal's own delete path, and nothing
 * applies without the trader's tap.
 */

import React from 'react';
import type { SettlementCorrectionProposal } from '../../../services/trade/settlementCorrection';
import { TradeOutcome } from '../../../types/enums';

export interface SettlementCorrectionCardProps {
    proposal: SettlementCorrectionProposal;
    /** The row's CURRENT outcome and PnL, so the card can show what changes. */
    current?: { outcome?: TradeOutcome; pnlAmount?: number; pnlPercent?: number; entry?: number };
    onConfirm: () => void;
    onDismiss: () => void;
    /** VOID — delete the row instead of applying the correction. The separate
     *  explicit action P-6's proof walks; optional so a host without the
     *  journal's delete path renders the two-action card. */
    onVoid?: () => void;
}

/** What the row says now, in the words the journal uses. */
const describeOutcome = (outcome?: TradeOutcome): string => outcome ?? 'unsettled';
const fmt = (v?: number): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');

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
    proposal, current, onConfirm, onDismiss, onVoid,
}) => {
    const outcomeChanges = proposal.outcome !== undefined && proposal.outcome !== current?.outcome;
    const pnlChanges = (proposal.pnlAmount !== undefined && proposal.pnlAmount !== current?.pnlAmount)
        || (proposal.pnlPercent !== undefined && proposal.pnlPercent !== current?.pnlPercent);
    const entryChanges = proposal.correctedEntry !== undefined && proposal.correctedEntry !== current?.entry;

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="settlement-correction-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
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
                    <div className={outcomeChanges ? 'font-semibold text-zinc-200' : 'text-zinc-400'}>
                        {outcomeChanges
                            ? `${describeOutcome(current?.outcome)} → ${describeOutcome(proposal.outcome)}`
                            : describeOutcome(current?.outcome)}
                    </div>
                </div>
                <div>
                    <div className="font-mono text-ui-xs uppercase text-zinc-500">P&amp;L</div>
                    {proposal.correctedEntry !== undefined && (
                        <div className={entryChanges ? 'font-semibold text-zinc-200' : 'text-zinc-400'}>
                            Entry: {fmt(current?.entry)} → {fmt(proposal.correctedEntry)}
                        </div>
                    )}
                    <div className={pnlChanges ? 'font-semibold text-zinc-200' : 'text-zinc-400'}>
                        {pnlChanges
                            ? `${fmtPnl(current?.pnlAmount, current?.pnlPercent)} → ${fmtPnl(proposal.pnlAmount, proposal.pnlPercent)}`
                            : fmtPnl(current?.pnlAmount, current?.pnlPercent)}
                    </div>
                </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onConfirm}
                    className="rounded-control bg-zinc-100 px-2 py-1 text-ui-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                    data-testid="settlement-correction-confirm">
                    Confirm correction
                </button>
                <button type="button" onClick={onDismiss}
                    className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                    data-testid="settlement-correction-dismiss">
                    Dismiss
                </button>
                {onVoid && (
                    <button type="button" onClick={onVoid}
                        className="rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                        data-testid="settlement-correction-void">
                        Void row
                    </button>
                )}
                <span className="ml-auto font-mono text-ui-xs text-zinc-600">
                    nothing changes until you tap
                </span>
            </div>
        </div>
    );
};

export default SettlementCorrectionCard;