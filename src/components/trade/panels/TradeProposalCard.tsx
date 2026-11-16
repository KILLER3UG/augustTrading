/**
 * TradeProposalCard — the model's presented trade plan rendered as the
 * DECISION CARD (redesign Phase 3): **Approve / Reject / Ask-why**, one tap
 * each, no modal.
 *
 * Approve is the trader's "log + monitor": it runs the SAME gated human path
 * the old "Track this trade" ran (gate scan, planId dedupe, PENDING row),
 * then App enqueues the approval-receipt harness turn so the model learns the
 * decision in conversation, and a short UNDO window opens (the receipt and
 * the window live in `services/trade/tradeDecision`).
 *
 * Approve is never silent about a market that moved: the card checks the
 * live mark against the proposed entry (staleness) at render time, and a
 * stale plan needs a re-confirm tap — "Re-confirm: approve anyway" — with
 * the drift printed on the card.
 *
 * Reject records a decline (the HOLD ledger) with an optional reason typed
 * on the card. Ask-why pre-fills the composer with a pushback prompt — the
 * host wires it through its draft setter, so nothing here touches the
 * composer directly.
 *
 * The double-log guard and the disposition map stay in the dock (they live at
 * module scope so a 'logged' plan survives an unmount/remount); this card
 * only reflects `canLog` and forwards the taps.
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle } from '../../shared/Icons';
import Disclosure from '../../shared/Disclosure';
import type { TradeProposal } from '../../../services/trade/proposedTrade';
import { computeRrRatio, buildTradePlan, modelStatedSize, proposedTicketSize } from '../../../services/trade/proposedTrade';
import { assessProposalStaleness, undoWindowOf } from '../../../services/trade/tradeDecision';
import { fmtRiskReward } from '../../../utils/riskReward';
import { getHarnessSettings } from '../../../utils/harnessSettings';
import { defaultLeverage } from '../../../utils/conversationUtils';
import { computeLiquidationBuffer } from '../../../utils/ticketSize';

export interface TradeProposalCardProps {
    proposal: TradeProposal;
    /** This card's transcript entry id — the key the undo window is stored
     *  under (module scope, so it survives the virtualized list remounting
     *  the card mid-window). */
    entryId?: string;
    /** A journal is attached (App passed onLogProposedTrade) — without it the
     *  Approve button is hidden and only Reject / Ask-why show. */
    canLog: boolean;
    /** The approve click is awaiting the gate scan. The button is disabled
     *  and labelled for what it is waiting on, so a slow scan never reads as
     *  a dead button — the failure mode this whole surface was built to
     *  avoid. */
    awaitingLog?: boolean;
    /** The leverage the suggested size is computed against. Defaults to the
     *  app-wide default; a host that knows the conversation's leverage should
     *  pass it, because the exchange's notional ceiling depends on it. */
    leverage?: number;
    /** The freshest live mark — the staleness check at approve time reads it
     *  from the chart's own snapshot, never a re-fetch. Absent ⇒ no drift is
     *  claimed (the age half of staleness still applies). */
    getMark?: () => number | null;
    /** When the plan was presented (the transcript entry's timestamp), for
     *  the validity-window half of the staleness check. */
    presentedAt?: number;
    /** Repaint trigger: the undo window lives at module scope, so the host
     *  bumps this after an approve/undo for the card to re-read it. */
    undoTick?: number;
    /** The undo window lapsed while this card was showing it — the host must
     *  re-render so the settled logged row replaces the card (without this,
     *  the card would fall back to live Approve buttons over an already-
     *  logged plan). */
    onUndoWindowClose?: () => void;
    onApprove: () => void;
    onReject: (reason?: string) => void;
    onAskWhy: () => void;
    /** Reverse this approval inside the undo window. Absent ⇒ no undo row. */
    onUndo?: () => void;
    /**
     * A caution printed on the card, in the app's own words, when the plan is
     * sound but the TURN that carried it was not — a run that stopped after
     * presenting the plan never delivered the rest of the reasoning.
     *
     * It deliberately does NOT disable or hide "Approve". The plan object
     * is machine-built and gate-checked; what went missing is the prose around
     * it. Removing a working control because something adjacent failed is the
     * inert-button failure mode this app already guards elsewhere, and it leaves
     * the trader to conclude logging is broken in general. So: say what is
     * incomplete, and let the trader decide.
     */
    logNote?: string;
    /** The session guard's refusal of ANY new log right now (daily loss
     *  consumed, trade cap reached, streak pause, post-loss cooldown). The
     *  host computes it over the journal; the log writer refuses on the same
     *  computation, so the disabled button and the writer cannot disagree.
     *  Unlike the gate refusal this is about the SESSION, not the plan — the
     *  recourse is a risk-change card, not a different plan. */
    guardBlock?: string | null;
    /** Non-blocking session-guard lines (budget used, equity unset). */
    guardWarnings?: string[];
}

const TradeProposalCard: React.FC<TradeProposalCardProps> = ({
    proposal, entryId, canLog, awaitingLog = false, leverage, logNote,
    guardBlock = null, guardWarnings = [],
    getMark, presentedAt, undoTick = 0, onUndoWindowClose, onApprove, onReject, onAskWhy, onUndo,
}) => {
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

    // STALENESS — read at render time (the card re-renders on every store
    // emit, so the mark is fresh whenever the trader is looking at it). A
    // stale plan does not block the approval: it names the drift and makes
    // the approval an explicit re-confirm.
    const staleness = assessProposalStaleness({
        entry: proposal.entry,
        stopLoss: proposal.stopLoss,
        mark: getMark?.() ?? null,
        presentedAt: presentedAt ?? null,
    });
    const [staleAcknowledged, setStaleAcknowledged] = useState(false);
    const needsStaleConfirm = staleness.stale && !staleAcknowledged;

    // The undo window — module-scope, read through the host's tick so an
    // approve (here or on a remount of this card) repaints it. A second-by-
    // second local clock runs only while a window is open.
    void undoTick;
    const undo = entryId ? undoWindowOf(entryId) : undefined;
    const [, setUndoClock] = useState(0);
    useEffect(() => {
        if (!undo) return;
        const t = setInterval(() => {
            // The window self-clears at its deadline; the tick notices and
            // tells the host, so the settled logged row replaces this card
            // instead of the buttons re-appearing over a logged plan.
            if (entryId && !undoWindowOf(entryId)) {
                setUndoClock(c => c + 1);
                onUndoWindowClose?.();
            } else {
                setUndoClock(c => c + 1);
            }
        }, 1000);
        return () => clearInterval(t);
    }, [!!undo, undo?.rowId]);

    // The optional decline reason — one compact line above the actions, read
    // by the Reject tap. A decline without a reason is still a decline.
    const [declineReason, setDeclineReason] = useState('');

    const secondsLeft = undo ? Math.max(1, Math.ceil(undo.msLeft / 1000)) : 0;
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
        {proposal.invalidation && (
            // The invalidation is the plan's own falsifier — the thing the
            // trader is approving the harness to watch for. Print it, don't
            // bury it in the rationale.
            <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-500" data-testid="proposal-invalidation">
                <span className="font-mono text-ui-2xs uppercase tracking-wider text-zinc-600">Invalidated if </span>
                {proposal.invalidation}
            </p>
        )}
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
        {staleness.stale && (
            // The market moved away from the proposed entry, or the plan
            // outlived its validity window. Approving is still the trader's
            // call — but it is a RE-CONFIRM with the drift on screen, never a
            // silent one.
            <div className="mt-1.5 rounded-control border border-amber-500/25 bg-amber-500/[0.05] p-2" data-testid="proposal-stale">
                {staleness.reasons.map((r, i) => (
                    <p key={i} className="text-ui-dense leading-relaxed text-amber-400/90">{r}</p>
                ))}
                {!staleAcknowledged && (
                    <p className="mt-1 font-mono text-ui-2xs text-zinc-500">
                        Approving asks for a re-confirm because of this.
                    </p>
                )}
            </div>
        )}
        {proposal.gate?.status === 'unavailable' && !refused && (
            // Fail closed: an unmeasurable plan is never quietly logged. The
            // handler asks for an explicit confirm, and the row it writes is
            // stamped `gate:unavailable` — never confidenceCap 0.
            <p className="mt-1.5 text-ui-dense text-amber-400/90" data-testid="proposal-gate-unavailable">
                Gate could not be checked ({proposal.gate.reason}) — approving asks you to confirm, and the row is recorded UNCAPPED.
            </p>
        )}
        {guardBlock && (
            // The session guard refuses every new log — the card prints the
            // standing reason and Approve stays down. Same treatment as a
            // gate refusal: deterministic, no same-moment override.
            <p className="mt-1.5 rounded-control border border-rose-500/20 bg-rose-500/[0.06] px-2 py-1.5 text-ui-dense text-rose-300" data-testid="proposal-guard-block">
                Session guard — {guardBlock}
            </p>
        )}
        {!guardBlock && guardWarnings.length > 0 && (
            <p className="mt-1.5 text-ui-dense leading-relaxed text-amber-400/90" data-testid="proposal-guard-warning">
                {guardWarnings[0]}
            </p>
        )}
        {logNote && (
            <p className="mt-1.5 text-ui-dense leading-relaxed text-amber-400/90" data-testid="proposal-log-note">
                {logNote}
            </p>
        )}
        {undo ? (
            // INSIDE THE UNDO WINDOW: the approval landed (the row is in the
            // journal, the receipt is queued) and the trader may still reverse
            // it — one tap, no dialog. When the window lapses this swaps to
            // the settled logged row the host renders beside it.
            <div className="mt-2.5 flex items-center gap-2 rounded-control border border-emerald-500/25 bg-emerald-500/[0.06] p-2" data-testid="proposal-undo-window">
                <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <span className="text-ui-dense text-emerald-300">
                    Approved{undo.planId ? ` — plan ${undo.planId} is logged and monitored` : ' — logged and monitored'}.
                </span>
                {onUndo && (
                    <button type="button" onClick={onUndo}
                        className="ml-auto shrink-0 rounded-control border border-hairline px-2 py-1 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06]"
                        data-testid="proposal-undo">
                        Undo ({secondsLeft}s)
                    </button>
                )}
            </div>
        ) : (
            <div className="mt-2.5">
                <input
                    type="text"
                    value={declineReason}
                    onChange={e => setDeclineReason(e.target.value)}
                    placeholder="Optional: why decline? (sent with Reject)"
                    maxLength={300}
                    className="w-full rounded-control border border-hairline bg-white/[0.02] px-2 py-1 text-ui-dense text-zinc-300 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                    data-testid="proposal-decline-reason"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                    {canLog && (
                        <button type="button"
                            onClick={() => {
                                if (needsStaleConfirm) { setStaleAcknowledged(true); return; }
                                onApprove();
                            }}
                            disabled={awaitingLog || !!refused || !!guardBlock}
                            title={refused
                                ? 'The gate refused this plan; the reason is printed above.'
                                : guardBlock
                                    ? 'The session guard stands down; the reason is printed above.'
                                    : undefined}
                            data-testid="proposal-approve"
                            className="rounded-control bg-emerald-600/90 px-2.5 py-1 text-ui-dense font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300">
                            {refused
                                ? 'Refused by the gate'
                                : guardBlock
                                    ? 'Guard stands down'
                                    : awaitingLog
                                    ? 'Checking the gate…'
                                    : needsStaleConfirm
                                        ? 'Re-confirm: approve anyway'
                                        : 'Approve — log & monitor'}
                        </button>
                    )}
                    <button type="button"
                        onClick={() => onReject(declineReason.trim() || undefined)}
                        disabled={awaitingLog}
                        data-testid="proposal-reject"
                        className="rounded-control border border-rose-500/30 px-2.5 py-1 text-ui-dense text-rose-300/90 transition-colors hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40">
                        Reject
                    </button>
                    <button type="button"
                        onClick={onAskWhy}
                        disabled={awaitingLog}
                        data-testid="proposal-ask-why"
                        className="rounded-control border border-hairline px-2.5 py-1 text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40">
                        Ask why
                    </button>
                    <span className="ml-auto font-mono text-ui-2xs text-zinc-600">
                        nothing logs until you approve
                    </span>
                </div>
            </div>
        )}
    </div>
    );
};

/** The settled counterpart: a plan the trader already approved, left in the
 *  transcript so it can never be clicked twice — shown once the undo window
 *  has lapsed. */
export const TradeProposalLoggedRow: React.FC = () => (
    <p className="mt-1 flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wider text-emerald-400"
        data-testid="proposal-logged-row">
        <CheckCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>✓ Approved — tracking this trade; the harness will score it against the outcome.</span>
    </p>
);

export default TradeProposalCard;
