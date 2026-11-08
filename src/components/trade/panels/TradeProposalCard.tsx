/**
 * TradeProposalCard — the model's presented trade plan rendered as a card
 * with Log-this-trade / Cancel. This is the dock's half of the outcome
 * autopilot: logging hands App an OPEN (PENDING) trade that the autopilot
 * later scores. Extracted from TradeChatPanel unchanged.
 *
 * The double-log guard and the disposition map stay in the dock (they live at
 * module scope so a 'logged' plan survives an unmount/remount); this card only
 * reflects `canLog` and forwards the two clicks.
 */

import React from 'react';
import { CheckCircle } from '../../shared/Icons';
import Disclosure from '../../shared/Disclosure';
import type { TradeProposal } from '../../../services/trade/proposedTrade';
import { computeRrRatio, buildTradePlan, modelStatedSize, proposedTicketSize } from '../../../services/trade/proposedTrade';
import { fmtRiskReward } from '../../../utils/riskReward';
import { getHarnessSettings } from '../../../utils/harnessSettings';
import { defaultLeverage } from '../../../utils/conversationUtils';
import { computeLiquidationBuffer } from '../../../utils/ticketSize';

export interface TradeProposalCardProps {
    proposal: TradeProposal;
    /** A journal is attached (App passed onLogProposedTrade) — without it the
     *  Log button is hidden and only Cancel shows. */
    canLog: boolean;
    /** The log click is awaiting the gate scan. The button is disabled and
     *  labelled for what it is waiting on, so a slow scan never reads as a dead
     *  button — the failure mode this whole surface was built to avoid. */
    awaitingLog?: boolean;
    /** The leverage the suggested size is computed against. Defaults to the
     *  app-wide default; a host that knows the conversation's leverage should
     *  pass it, because the exchange's notional ceiling depends on it. */
    leverage?: number;
    onLog: () => void;
    onCancel: () => void;
    /**
     * A caution printed on the card, in the app's own words, when the plan is
     * sound but the TURN that carried it was not — a run that stopped after
     * presenting the plan never delivered the rest of the reasoning.
     *
     * It deliberately does NOT disable or hide "Log this trade". The plan object
     * is machine-built and gate-checked; what went missing is the prose around
     * it. Removing a working control because something adjacent failed is the
     * inert-button failure mode this app already guards elsewhere, and it leaves
     * the trader to conclude logging is broken in general. So: say what is
     * incomplete, and let the trader decide.
     */
    logNote?: string;
}

const TradeProposalCard: React.FC<TradeProposalCardProps> = ({ proposal, canLog, awaitingLog = false, leverage, logNote, onLog, onCancel }) => {
    // The card shows levels the moment the model names them, but the probability,
    // the confidence tier and any grade come ONLY from the one plan object —
    // the same builder the journal row runs, so the card can never quote a
    // number the row disagrees with.
    const plan = proposal.gate ? buildTradePlan(proposal) : null;
    // The SUGGESTED size — the trader's own equity and risk % against this
    // plan's stop distance. It is shown only once the gate has answered, so
    // the number never changes under the trader while the scan runs.
    const lev = leverage ?? defaultLeverage();
    const liquidated = computeLiquidationBuffer(String(proposal.entry), String(proposal.stopLoss), lev);
    const settings = getHarnessSettings();
    const refused = proposal.gate?.refusal;
    // The gate's plan-shape bands (E-57 §5). These never disable the Log button:
    // a stop distance is the trader's judgement, so the app PROPOSES a caution
    // and the journal row keeps it. Only `refused` — the trader's own edge floor
    // or an inverted plan — stops a click.
    const cautions = proposal.gate?.warnings ?? [];
    const size = plan && !refused
        ? proposedTicketSize(proposal, settings.equityUsd, lev, settings.riskPercent)
        : null;
    // What the MODEL said about size, kept separate from the suggestion: the
    // trader's ticket is the app's number, and the model's is a claim to
    // compare it against.
    const stated = modelStatedSize(proposal.rationale);
    return (
    <div className="mt-1 rounded-control border border-hairline bg-white/[0.015] p-2.5" data-testid="trade-proposal-card">
        <div className="flex items-center gap-2">
            <span className={`rounded-control px-1.5 py-0.5 text-ui-xs font-bold ${proposal.direction === 'Long' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>{proposal.direction}</span>
            <span className="font-mono text-ui-sm font-bold text-zinc-100">{proposal.symbol}</span>
            {/* The number that gates "Log this trade" — from the canonical
                planned-R:R util, the same chip the Agents surface header shows. */}
            {computeRrRatio(proposal) > 0 && (
                <span className="rounded-control border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-xs font-medium text-zinc-300">
                    {fmtRiskReward(computeRrRatio(proposal), 1)} R:R
                </span>
            )}
            {plan ? (
                <span className="ml-auto font-mono text-ui-xs uppercase tracking-wider text-zinc-500" data-testid="proposal-confidence">
                    {plan.probability}% · {plan.confidence} confidence
                </span>
            ) : (
                <span className="ml-auto font-mono text-ui-xs uppercase tracking-wider text-zinc-600" data-testid="proposal-gate-pending">
                    gate: checking…
                </span>
            )}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 rounded-control border border-hairline bg-white/[0.02] p-2 font-mono text-ui-dense tabular-nums">
            <div>
                <div className="font-mono text-ui-xs uppercase text-zinc-500">Entry</div>
                <div className="font-semibold text-zinc-100">{proposal.entry}</div>
            </div>
            <div>
                <div className="font-mono text-ui-xs uppercase text-zinc-500">SL</div>
                <div className="font-semibold text-rose-400">{proposal.stopLoss}</div>
            </div>
            <div>
                <div className="font-mono text-ui-xs uppercase text-zinc-500">TP</div>
                <div className="font-semibold text-emerald-400">{proposal.takeProfits.join(' / ')}</div>
            </div>
        </div>
        {liquidated && (
            // The risk the levels grid does not show: how far isolated
            // liquidation sits beyond the stop. At the old 100× default a 1 %
            // wick was a total loss and nothing on the card said so.
            <p
                className={`mt-1.5 font-mono text-ui-2xs ${liquidated.bufferPct <= 0 ? 'text-rose-400' : 'text-zinc-500'}`}
                data-testid="proposal-liq-buffer"
            >
                {liquidated.line}
            </p>
        )}
        {size && (
            // The SUGGESTED size — the trader's own equity and risk % against
            // this plan's stop distance, with the exchange's notional ceiling
            // applied. It is the app's number, not the model's, and it can
            // only ever be SMALLER than a full ticket: the sizing rule
            // downgrades, it never scales up.
            <div className="mt-2 rounded-control border border-hairline bg-white/[0.02] p-2" data-testid="proposal-size">
                <div className="font-mono text-ui-xs uppercase text-zinc-500">Suggested size</div>
                <div className={`font-mono text-ui-dense ${size.equityUsd > 0 ? 'text-zinc-200' : 'text-amber-400/90'}`}>
                    {size.equityUsd > 0 ? size.line : 'Not sized — equity not set'}
                </div>
                {size.equityUsd > 0 && (
                    <div className="font-mono text-ui-2xs text-zinc-500">
                        {size.riskPercent}% of ${Math.round(size.equityUsd)} · {lev}x notional cap
                    </div>
                )}
                {size.equityUsd > 0 && size.reason !== 'Uncapped' && (
                    <div className="font-mono text-ui-2xs text-amber-400/90">{size.reason}</div>
                )}
                {size.equityUsd <= 0 && (
                    <div className="font-mono text-ui-2xs text-zinc-500">
                        Set your account equity in Settings → Risk to size this trade.
                    </div>
                )}
            </div>
        )}
        {(stated.riskUsd !== undefined || stated.notionalUsd !== undefined) && (
            // What the MODEL said, kept apart from the suggestion above: the
            // trader can see the two side by side, and the model's claim never
            // changes the ticket.
            <p className="mt-1.5 font-mono text-ui-2xs text-zinc-500" data-testid="proposal-model-size">
                Model stated:{' '}
                {stated.riskUsd !== undefined && `$${Math.round(stated.riskUsd)} risk`}
                {stated.riskUsd !== undefined && stated.notionalUsd !== undefined && ' · '}
                {stated.notionalUsd !== undefined && `$${Math.round(stated.notionalUsd)} position`}
            </p>
        )}
        {proposal.rationale && <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-400">{proposal.rationale}</p>}
        {proposal.gate?.refusal && (
            <p className="mt-1.5 rounded-control border border-rose-500/20 bg-rose-500/[0.06] px-2 py-1.5 text-ui-dense text-rose-300" data-testid="proposal-refused">
                Refused — {proposal.gate.refusal}
            </p>
        )}
        {cautions.length > 0 && (
            // The FIRST caution is never click-gated: it is a sentence about the
            // trader's own money, and a warning behind a toggle is a warning
            // nobody reads. The rest fold into the one expandable panel the app
            // already owns, so a plan that trips three bands does not stack
            // three amber paragraphs on the card.
            <div className="mt-1.5" data-testid="proposal-cautions">
                <p className="text-ui-dense leading-relaxed text-amber-400/90">{cautions[0]}</p>
                {cautions.length > 1 && (
                    <Disclosure
                        testId="proposal-cautions-more"
                        className="mt-1"
                        summaryClassName="cursor-pointer font-mono text-ui-2xs uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                        bodyClassName="mt-1 space-y-1 text-ui-dense leading-relaxed text-zinc-400"
                        label={`More cautions about these levels (${cautions.length - 1})`}
                        summary={`${cautions.length - 1} more caution${cautions.length === 2 ? '' : 's'} about these levels`}
                    >
                        {cautions.slice(1).map(c => <p key={c}>{c}</p>)}
                    </Disclosure>
                )}
            </div>
        )}
        {proposal.gate?.status === 'unavailable' && !refused && (
            // Fail closed: an unmeasurable plan is never quietly logged. The
            // handler asks for an explicit confirm, and the row it writes is
            // stamped `gate:unavailable` — never confidenceCap 0.
            <p className="mt-1.5 text-ui-dense text-amber-400/90" data-testid="proposal-gate-unavailable">
                Gate could not be checked ({proposal.gate.reason}) — logging asks you to confirm, and the row is recorded UNCAPPED.
            </p>
        )}
        {logNote && (
            <p className="mt-1.5 text-ui-dense leading-relaxed text-amber-400/90" data-testid="proposal-log-note">
                {logNote}
            </p>
        )}
        <div className="mt-2.5 flex items-center gap-1.5">
            {canLog && (
                <button type="button"
                    onClick={onLog}
                    disabled={awaitingLog || !!refused}
                    title={refused ? 'The gate refused this plan; the reason is printed above.' : undefined}
                    className="rounded-control bg-emerald-600/90 px-2.5 py-1 text-ui-dense font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300">
                    {refused ? 'Refused by the gate' : awaitingLog ? 'Checking the gate…' : 'Track this trade'}
                </button>
            )}
            <button type="button"
                onClick={onCancel}
                className="rounded-control border border-hairline px-2.5 py-1 text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200">
                Cancel
            </button>
        </div>
    </div>
    );
};

/** The settled counterpart: a plan the trader already logged, left in the
 *  transcript so it can never be clicked twice. */
export const TradeProposalLoggedRow: React.FC = () => (
    <p className="mt-1 flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wider text-emerald-400">
        <CheckCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>✓ Tracking this trade — the harness will score it against the outcome.</span>
    </p>
);

export default TradeProposalCard;
