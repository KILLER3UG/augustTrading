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

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle } from '../../shared/Icons';
import Disclosure from '../../shared/Disclosure';
import type { TradeProposal } from '../../../services/trade/proposedTrade';
import { computeRrRatio, buildTradePlan, modelStatedSize, proposedTicketSize } from '../../../services/trade/proposedTrade';
import { formatPaperFillAssumptions, PAPER_EXECUTION_RECEIPT } from '../../../services/tracking/paperExecution';
import { assessProposalStaleness, undoWindowOf } from '../../../services/trade/tradeDecision';
import { fmtRiskReward } from '../../../utils/riskReward';
import {
    formatProposalLeverage,
    formatProposalPct,
    formatProposalQty,
    formatProposalR,
    formatProposalUsd,
} from '../../../utils/proposalFormatCore';
import { humanizeSkillTitle } from '../../../utils/uiFormatting';
import { computeProposalLiveDrift } from '../../../services/trade/toolVisualCore';
import { getHarnessSettings } from '../../../utils/harnessSettings';
import { getPaperAccount, submitPaperOrder, subscribePaperAccount } from '../../../services/paper/PaperBrokerService';
import type { PaperOrderInput, PaperReceipt } from '../../../services/paper/paperCore';

/** Build a deterministic PaperOrderInput from a TradeProposal + trader risk/leverage. */
export const buildPaperOrderFromProposal = (
    proposal: TradeProposal,
    riskPct: number,
    leverage: number,
): PaperOrderInput => ({
    action: 'open_market',
    symbol: proposal.symbol,
    side: proposal.direction === 'Long' ? 'long' : 'short',
    risk_pct: Number.isFinite(riskPct) && riskPct > 0 ? riskPct : 1,
    leverage: Number.isFinite(leverage) && leverage >= 1 ? Math.floor(leverage) : 1,
    entry_price: proposal.entry,
    stop_loss: proposal.stopLoss,
    take_profits: proposal.takeProfits.slice(0, 3),
    ...(proposal.skillSlug ? { skill_slug: proposal.skillSlug } : {}),
    ...(proposal.rationale ? { thesis: proposal.rationale.slice(0, 240) } : {}),
});
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
    /** True when read-only Plan Mode is active — shows conscious unlock control. */
    planMode?: boolean;
    /** Disable Plan Mode without clearing this card. */
    onUnlockPlanMode?: () => void;
    /** Optional override for whether Paper Mode is active (defaults to local PaperBroker config). */
    paperEnabled?: boolean;
    /** Optional override for deterministic paper execution testing. */
    onPaperExecute?: (proposal: TradeProposal) => Promise<PaperReceipt>;
}

const TradeProposalCard: React.FC<TradeProposalCardProps> = ({
    proposal, entryId, canLog, awaitingLog = false, leverage, logNote,
    guardBlock = null, guardWarnings = [], planMode = false, onUnlockPlanMode,
    paperEnabled, onPaperExecute,
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
    const liveMark = getMark?.() ?? null;
    const staleness = assessProposalStaleness({
        entry: proposal.entry,
        stopLoss: proposal.stopLoss,
        mark: liveMark,
        presentedAt: presentedAt ?? null,
    });
    const liveDrift = computeProposalLiveDrift(proposal, liveMark);
    const [staleAcknowledged, setStaleAcknowledged] = useState(false);
    const needsStaleConfirm = staleness.stale && !staleAcknowledged;
    const [mathExpanded, setMathExpanded] = useState(false);
    const [sensorExpanded, setSensorExpanded] = useState(() => (proposal.conflictFlags?.length ?? 0) >= 2);
    const [rejecting, setRejecting] = useState(false);
    const rejectInputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (rejecting) rejectInputRef.current?.focus();
    }, [rejecting]);

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

    // Paper execution state — routes through PaperBrokerService/paperCore
    // enforcing all risk walls, L2 pricing, and skillSlug attribution.
    const [accountPaperEnabled, setAccountPaperEnabled] = useState(true);
    const [paperBusy, setPaperBusy] = useState(false);
    const [paperReceipt, setPaperReceipt] = useState<PaperReceipt | null>(null);
    useEffect(() => {
        if (paperEnabled !== undefined) return;
        let alive = true;
        const unsubscribe = subscribePaperAccount(acc => {
            if (alive) setAccountPaperEnabled(acc.config.enabled);
        });
        void getPaperAccount()
            .then(acc => { if (alive) setAccountPaperEnabled(acc.config.enabled); })
            .catch(() => { /* no stored account yet — default enabled */ });
        return () => { alive = false; unsubscribe(); };
    }, [paperEnabled]);
    const isPaperEnabled = paperEnabled ?? accountPaperEnabled;
    const handlePaperExecute = async (): Promise<void> => {
        if (planMode || !isPaperEnabled || paperBusy || !!refused || !!guardBlock || paperReceipt?.ok) return;
        setPaperBusy(true);
        try {
            const order = buildPaperOrderFromProposal(proposal, settings.riskPercent, lev);
            const receipt = onPaperExecute
                ? await onPaperExecute(proposal)
                : await submitPaperOrder(order);
            setPaperReceipt(receipt);
        } catch (err) {
            setPaperReceipt({
                ok: false,
                error: 'paper_execute_failed',
                reason: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setPaperBusy(false);
        }
    };

    const secondsLeft = undo ? Math.max(1, Math.ceil(undo.msLeft / 1000)) : 0;
    // The planned R:R chip. Sub-1 ratios quote TWO decimals: the canonical
    // builder rounds to 2, and re-rounding 0.05 to one digit printed "0.1:1"
    // — a chip that overstated the plan's reward 2× against the gate's own
    // "R:R ratio (0.05)" line. One number, one precision per magnitude.
    const rr = computeRrRatio(proposal);
    return (
    <div className="motion-card-enter mt-1 rounded-lg border border-hairline bg-zinc-900/60 p-2.5" data-testid="trade-proposal-card">
        {/* ROW 1 — the decision line: direction, symbol, the planned R:R, the
            live drift, and the gate's confidence right-aligned. Everything
            else moved to the quiet status line below. */}
        <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-control px-1.5 py-0.5 text-ui-xs font-bold ${proposal.direction === 'Long' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>{proposal.direction}</span>
            <span className="font-mono text-ui-sm font-bold text-zinc-100">{proposal.symbol}</span>
            {/* The number that gates "Log this trade" — from the canonical
                planned-R:R util, the same chip the Agents surface header shows. */}
            {rr > 0 && (
                <span className="rounded-control border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-xs font-medium text-zinc-300">
                    {fmtRiskReward(rr, rr >= 1 ? 1 : 2)} R:R
                </span>
            )}
            {liveDrift && (
                <span
                    data-testid="proposal-live-drift"
                    className={`rounded-control border px-1.5 py-0.5 font-mono text-ui-2xs tabular-nums ${
                        liveDrift.slBreached
                            ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                            : liveDrift.favorable
                                ? 'border-hairline bg-white/[0.04] text-emerald-400'
                                : 'border-hairline bg-white/[0.04] text-zinc-400'
                    }`}
                >
                    {liveDrift.driftLabel}
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
        {/* ROW 2 — the quiet inline status line: dot-separated facts, no chips.
            The 5-CHECK SENSOR drawer stays a full-width block below when at
            least one conflict flag fires; a clear sensor reads inline. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-ui-2xs text-zinc-500">
            {proposal.simulated !== false && (
                <span
                    data-testid="simulated-badge"
                    className="uppercase tracking-wider"
                >
                    Simulated
                </span>
            )}
            {proposal.skillSlug && (
                <>
                    <span aria-hidden="true" className="text-zinc-700">·</span>
                    <span data-testid="proposal-playbook-chip">
                        Playbook: {humanizeSkillTitle('', proposal.skillSlug)}
                    </span>
                </>
            )}
            {/* The adversary reviewer's verdict — an isolated read-only seat
                read of the plan against the tape. The objections live in the
                detail line below. */}
            {proposal.adversary && (
                <>
                    <span aria-hidden="true" className="text-zinc-700">·</span>
                    <span
                        data-testid="adversary-verdict"
                        className={`uppercase tracking-wider ${
                            proposal.adversary.verdict === 'VETO' && !proposal.adversary.overridden
                                ? 'font-medium text-rose-400'
                                : proposal.adversary.verdict === 'CAUTION'
                                    ? 'text-zinc-300'
                                    : ''
                        }`}
                    >
                        {proposal.adversary.verdict === 'VETO' && !proposal.adversary.overridden
                            ? 'Adversary VETO · watch held'
                            : proposal.adversary.verdict === 'UNAVAILABLE'
                                ? 'Adversary unavailable'
                                : `Adversary: ${proposal.adversary.verdict} · watch armed`}
                    </span>
                </>
            )}
            {proposal.conflictFlags !== undefined && proposal.conflictFlags.length === 0 && (
                <>
                    <span aria-hidden="true" className="text-zinc-700">·</span>
                    <span data-testid="proposal-conflict-sensor" className="uppercase tracking-wider">
                        Sensor clear
                    </span>
                </>
            )}
        </div>
        {proposal.conflictFlags !== undefined && proposal.conflictFlags.length > 0 && (
            <div
                data-testid="proposal-conflict-sensor"
                className="mt-1.5 rounded-control border border-hairline bg-white/[0.025] px-2 py-1"
            >
                <button
                    type="button"
                    aria-expanded={sensorExpanded}
                    onClick={() => setSensorExpanded(v => !v)}
                    className="flex min-h-[24px] w-full cursor-pointer items-center justify-between gap-2 text-left font-mono text-ui-2xs uppercase tracking-wider text-zinc-300"
                >
                    <span className={proposal.conflictFlags.length >= 2 ? 'text-rose-400' : 'text-zinc-300'}>
                        {proposal.conflictFlags.length === 1
                            ? '1 caution flag'
                            : `${proposal.conflictFlags.length} conflict flags · adversary engaged`}
                    </span>
                    <span className="shrink-0 text-zinc-500">
                        5-check sensor {sensorExpanded ? '▾' : '▸'}
                    </span>
                </button>
                <div className="motion-collapse-grid" data-open={sensorExpanded ? 'true' : 'false'} aria-hidden={!sensorExpanded}>
                    <div>
                        <ul className="mt-1 space-y-0.5 border-t border-hairline pt-1">
                            {proposal.conflictFlags.map((f, idx) => (
                                <li key={`${f.id}-${idx}`} className="text-ui-2xs leading-4 text-zinc-400">
                                    <span className={f.severity === 'high' ? 'font-medium text-rose-400' : 'font-medium text-zinc-200'}>
                                        {f.label}:
                                    </span>{' '}
                                    {f.detail}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        )}
        {/* Compact 2-row tabular grid: Row 1 (Entry / SL / TP1-TP2), Row 2 (Net R:R / Risk $ / Size / Liq Buffer). */}
        <div className="mt-2 divide-y divide-white/[0.05] rounded-control border border-hairline bg-white/[0.02] font-mono text-ui-dense tabular-nums">
            <div className="grid grid-cols-3 gap-2 px-2.5 py-2">
                <div>
                    <div className="text-ui-2xs uppercase text-zinc-500">Entry</div>
                    <div className="font-semibold text-zinc-100">{proposal.entry}</div>
                </div>
                <div>
                    <div className="text-ui-2xs uppercase text-zinc-500">SL</div>
                    <div className="font-semibold text-rose-400">{proposal.stopLoss}</div>
                </div>
                <div>
                    <div className="text-ui-2xs uppercase text-zinc-500">TP1 / TP2</div>
                    <div className="font-semibold text-emerald-400">{proposal.takeProfits.join(' / ')}</div>
                </div>
            </div>
            <div className="grid grid-cols-4 gap-2 px-2.5 py-1.5 text-ui-2xs">
                <div>
                    <div className="uppercase text-zinc-500">Net R:R</div>
                    <div className="font-medium text-zinc-200">
                        {proposal.math?.netRewardR != null
                            ? formatProposalR(proposal.math.netRewardR)
                            : rr > 0
                                ? `${fmtRiskReward(rr, rr >= 1 ? 1 : 2)}`
                                : '—'}
                    </div>
                </div>
                <div>
                    <div className="uppercase text-zinc-500">Risk $</div>
                    <div className="font-medium text-zinc-200">
                        {proposal.math?.riskUsd != null
                            ? formatProposalUsd(proposal.math.riskUsd)
                            : size && size.equityUsd > 0
                                ? formatProposalUsd(size.equityUsd * (size.riskPercent / 100))
                                : '—'}
                    </div>
                </div>
                <div data-testid="proposal-size">
                    <div className="uppercase text-zinc-500">Size</div>
                    <div className="truncate font-medium text-zinc-200" title={size?.line ?? undefined}>
                        {proposal.math?.qty != null
                            ? `${formatProposalQty(proposal.math.qty)} · ${formatProposalLeverage(proposal.math.leverageNeeded ?? lev)}`
                            : size && size.equityUsd > 0
                                ? size.line
                                : 'Unset'}
                    </div>
                </div>
                <div data-testid="proposal-liq-buffer">
                    <div className="uppercase text-zinc-500">Liq Buffer</div>
                    <div className="truncate font-medium text-zinc-300" title={liquidated?.line ?? undefined}>
                        {liquidated ? formatProposalPct(liquidated.bufferPct) : (proposal.math?.liquidationPrice != null ? `~${proposal.math.liquidationPrice}` : '—')}
                    </div>
                </div>
            </div>
        </div>
        {liveDrift?.slBreached && (
            <div
                role="alert"
                data-testid="proposal-sl-breached"
                className="mt-1.5 rounded-control border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 font-mono text-ui-dense font-medium text-rose-300"
            >
                Price breached SL — re-audit before entering (mark {liveDrift.markPrice} vs SL {proposal.stopLoss})
            </div>
        )}
        {/* DECISION BLOCKERS FIRST (the audit's hierarchy fix): a gate
            refusal, a standing session guard, a stale plan or an unmeasurable
            gate is the first thing the trader must see — above the rationale
            and the sizing, not buried under them. The buttons below already
            read these states; now the card's top does too. */}
        {proposal.gate?.refusal && (
            <p className="mt-1.5 rounded-control border border-line bg-white/[0.03] px-2 py-1.5 text-ui-dense text-zinc-300" data-testid="proposal-refused">
                Refused — {proposal.gate.refusal}
            </p>
        )}
        {guardBlock && (
            // The session guard refuses every new log — the card prints the
            // standing reason and Approve stays down. Same treatment as a
            // gate refusal: deterministic, no same-moment override.
            <p className="mt-1.5 rounded-control border border-line bg-white/[0.03] px-2 py-1.5 text-ui-dense text-zinc-300" data-testid="proposal-guard-block">
                Session guard — {guardBlock}
            </p>
        )}
        {staleness.stale && (
            // The market moved away from the proposed entry, or the plan
            // outlived its validity window. Approving is still the trader's
            // call — but it is a RE-CONFIRM with the drift on screen, never a
            // silent one.
            <div className="mt-1.5 rounded-control border border-line bg-white/[0.03] p-2" data-testid="proposal-stale">
                {staleness.reasons.map((r, i) => (
                    <p key={i} className="text-ui-dense leading-relaxed text-zinc-300">{r}</p>
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
            <p className="mt-1.5 text-ui-dense text-zinc-300" data-testid="proposal-gate-unavailable">
                Gate could not be checked ({proposal.gate.reason}) — approving asks you to confirm, and the row is recorded UNCAPPED.
            </p>
        )}
        {proposal.simulated !== false && (
            <p
                data-testid="fill-assumptions"
                className="mt-1.5 font-mono text-ui-2xs text-zinc-400"
            >
                {formatPaperFillAssumptions(proposal.fillAssumptions)} · {PAPER_EXECUTION_RECEIPT}
            </p>
        )}
        {proposal.invalidation && (
            // The invalidation is the plan's own falsifier — the thing the
            // trader is approving the harness to watch for. Print it, don't
            // bury it in the rationale.
            <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-500" data-testid="proposal-invalidation">
                <span className="font-mono text-ui-2xs uppercase tracking-wider text-zinc-600">Invalidated if </span>
                {proposal.invalidation}
            </p>
        )}
        {proposal.math && (
            // Foldable 1-line HARNESS MATH toggle — keeps the proposal card
            // scannable at a glance while preserving full fee/funding detail on click.
            <div className="mt-1.5 rounded-control border border-hairline bg-white/[0.02]" data-testid="proposal-harness-math">
                <button
                    type="button"
                    data-testid="proposal-harness-math-toggle"
                    aria-expanded={mathExpanded}
                    onClick={() => setMathExpanded(v => !v)}
                    className="flex h-7 w-full items-center justify-between gap-2 px-2.5 text-left font-mono text-ui-2xs tabular-nums text-zinc-400 transition-colors hover:text-zinc-200"
                >
                    <span className="truncate">
                        HARNESS MATH · Net {proposal.math.netRewardR != null ? formatProposalR(proposal.math.netRewardR) : '—'} · BE {proposal.math.breakEvenWinRatePct != null ? formatProposalPct(proposal.math.breakEvenWinRatePct) : '—'} · Liq {liquidated ? formatProposalPct(liquidated.bufferPct) : (proposal.math.liquidationPrice != null ? `~${proposal.math.liquidationPrice}` : '—')}
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-zinc-500">{mathExpanded ? '▾' : '▸'}</span>
                </button>
                <div className="motion-collapse-grid" data-open={mathExpanded ? 'true' : 'false'} aria-hidden={!mathExpanded}>
                    <div>
                        <div className="space-y-0.5 border-t border-hairline px-2.5 py-2 font-mono text-ui-2xs tabular-nums text-zinc-400">
                            <div className="text-zinc-200">
                                gross {proposal.math.grossRatio}:1 · net {proposal.math.netRewardR ?? '—'}R · break-even {proposal.math.breakEvenWinRatePct ?? '—'}%
                            </div>
                            <div>
                                risk ${proposal.math.riskUsd ?? '—'} → qty {proposal.math.qty ?? '—'} @ {proposal.math.leverageNeeded ?? '—'}x · notional ${proposal.math.notionalUsd ?? '—'} · liq ~{proposal.math.liquidationPrice ?? '—'}
                            </div>
                            <div className="text-zinc-500">
                                fees {proposal.math.costR ?? '—'}R{proposal.math.fundingDragR !== null
                                    ? ` · funding ${proposal.math.fundingDragR >= 0 ? '+' : ''}${proposal.math.fundingDragR}R (${proposal.math.fundingRate ?? '—'} at ${proposal.math.fundingIntervalHours ?? '—'}h)`
                                    : ' · funding unavailable'}
                            </div>
                        </div>
                    </div>
                </div>
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
        {cautions.length > 0 && (
            // The FIRST caution is never click-gated: it is a sentence about the
            // trader's own money, and a warning behind a toggle is a warning
            // nobody reads. The rest fold into the one expandable panel the app
            // already owns, so a plan that trips three bands does not stack
            // three amber paragraphs on the card.
            <div className="mt-1.5" data-testid="proposal-cautions">
                <p className="text-ui-dense leading-relaxed text-zinc-300">{cautions[0]}</p>
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
        {!guardBlock && guardWarnings.length > 0 && (
            <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-300" data-testid="proposal-guard-warning">
                {guardWarnings[0]}
            </p>
        )}
        {logNote && (
            <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-300" data-testid="proposal-log-note">
                {logNote}
            </p>
        )}
        {undo ? (
            // INSIDE THE UNDO WINDOW: the approval landed (the row is in the
            // journal, the receipt is queued) and the trader may still reverse
            // it — one tap, no dialog. When the window lapses this swaps to
            // the settled logged row the host renders beside it.
            <div className="mt-2.5 flex items-center gap-2 rounded-control border border-hairline bg-white/[0.03] p-2" data-testid="proposal-undo-window">
                <CheckCircle className="h-3.5 w-3.5 shrink-0 text-zinc-300" aria-hidden="true" />
                <span className="text-ui-dense text-zinc-200">
                    Approved{undo.planId ? ` — plan ${undo.planId} is logged and monitored` : ' — logged and monitored'}.
                </span>
        
        {/* The adversary's objections + the override. A VETO withdrew the
            auto-armed watch; only an explicit trader click re-arms it — the
            model's own proposal never overrides its own reviewer. */}
        {proposal.adversary && proposal.adversary.verdict === 'VETO' && !proposal.adversary.overridden && (
            <div data-testid="adversary-detail" className="mt-2 rounded-control border border-rose-500/30 bg-rose-500/[0.06] p-2">
                <p className="text-ui-2xs font-medium text-rose-400">Adversary review — watch withdrawn pending your override</p>
                <ul className="mt-1 space-y-0.5">
                    {proposal.adversary.objections.map((o, i) => (
                        <li key={i} className="text-ui-dense leading-4 text-zinc-300">· {o}</li>
                    ))}
                </ul>
                <p className="mt-1 text-ui-2xs text-zinc-500">{proposal.adversary.invalidationCheck}</p>
                <button
                    type="button"
                    data-testid="adversary-override"
                    onClick={() => {
                        const plan = proposal.adversary?.plan;
                        if (!plan) return;
                        void import('../../../services/trade/levelWatchService').then(lw => lw.arm({
                            planId: plan.planId, symbol: plan.symbol, direction: plan.direction,
                            entry: plan.entry, stopLoss: plan.stopLoss, takeProfits: plan.takeProfits,
                        }, null));
                        void import('../../../services/trade/chatStore').then(cs => cs.overrideAdversary(plan.planId));
                    }}
                    className="mt-1.5 rounded-control border border-hairline px-2 py-0.5 text-ui-2xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                >
                    Arm the watch anyway
                </button>
            </div>
        )}
        {proposal.adversary && proposal.adversary.verdict === 'CAUTION' && proposal.adversary.objections.length > 0 && (
            <p data-testid="adversary-caution" className="mt-1.5 text-ui-2xs text-zinc-500">
                Adversary: {proposal.adversary.objections[0]}
            </p>
        )}
        {onUndo && (
                    <button type="button" onClick={onUndo}
                        className="ml-auto shrink-0 rounded-control border border-line bg-zinc-800/80 px-2 py-1 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700"
                        data-testid="proposal-undo">
                        Undo ({secondsLeft}s)
                    </button>
                )}
            </div>
        ) : (
            <div className="mt-2.5">
                <div
                    className={`motion-collapse-grid ${rejecting ? 'pointer-events-auto' : 'pointer-events-none'}`}
                    data-open={rejecting ? 'true' : 'false'}
                    aria-hidden={!rejecting}
                >
                    <div>
                        <div className="mb-2 flex items-center gap-1.5">
                            <input
                                ref={rejectInputRef}
                                type="text"
                                tabIndex={rejecting ? 0 : -1}
                                value={declineReason}
                                onChange={e => setDeclineReason(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        onReject(declineReason.trim() || undefined);
                                        setRejecting(false);
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setRejecting(false);
                                    }
                                }}
                                placeholder="Optional: why decline? (recorded in hold ledger)"
                                maxLength={300}
                                className="h-7 min-w-0 flex-1 rounded-control border border-hairline bg-zinc-950 px-2 text-ui-dense text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                                data-testid="proposal-decline-reason"
                            />
                            <button
                                type="button"
                                tabIndex={rejecting ? 0 : -1}
                                onClick={() => {
                                    onReject(declineReason.trim() || undefined);
                                    setRejecting(false);
                                }}
                                data-testid="proposal-confirm-reject"
                                className="h-7 shrink-0 rounded-control border border-rose-500/40 bg-rose-500/15 px-2.5 text-ui-dense font-medium text-rose-300 transition-colors hover:bg-rose-500/25 active:scale-[0.98]"
                            >
                                Confirm reject
                            </button>
                            <button
                                type="button"
                                tabIndex={rejecting ? 0 : -1}
                                onClick={() => setRejecting(false)}
                                className="h-7 shrink-0 rounded-control border border-hairline bg-zinc-900 px-2 text-ui-dense text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {canLog && (
                        <button type="button"
                            onClick={() => {
                                if (planMode) return;
                                if (needsStaleConfirm) { setStaleAcknowledged(true); return; }
                                onApprove();
                            }}
                            disabled={planMode || awaitingLog || !!refused || !!guardBlock}
                            title={planMode
                                ? 'Plan Mode is active (read-only). Click "Unlock execution" to approve.'
                                : refused
                                    ? 'The gate refused this plan; the reason is printed above.'
                                    : guardBlock
                                        ? 'The session guard stands down; the reason is printed above.'
                                        : undefined}
                            data-testid="proposal-approve"
                            className="h-7 rounded-control bg-zinc-100 px-2.5 text-ui-dense font-medium text-zinc-950 transition-colors hover:bg-white active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300">
                            {planMode
                                ? 'Locked (Plan Mode)'
                                : refused
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
                    <button
                        type="button"
                        onClick={() => { void handlePaperExecute(); }}
                        disabled={planMode || !isPaperEnabled || paperBusy || !!refused || !!guardBlock || !!paperReceipt?.ok}
                        title={planMode
                            ? 'Plan Mode is active (read-only). Unlock execution before paper trading.'
                            : !isPaperEnabled
                                ? 'Paper Mode is off in Settings.'
                                : refused
                                    ? 'The gate refused this plan.'
                                    : guardBlock
                                        ? 'The session guard stands down.'
                                        : 'Execute simulated fill via local Paper Broker'}
                        data-testid="proposal-paper-execute"
                        className="h-7 rounded-control border border-line bg-zinc-900 px-2.5 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {paperBusy ? 'Filling…' : paperReceipt?.ok ? 'Paper filled' : 'Paper execute'}
                    </button>
                    {planMode && onUnlockPlanMode && (
                        <button
                            type="button"
                            onClick={onUnlockPlanMode}
                            data-testid="plan-mode-unlock-btn"
                            className="h-7 rounded-control border border-hairline bg-zinc-900 px-2.5 text-ui-dense font-medium text-zinc-100 transition-colors hover:bg-zinc-800"
                        >
                            Unlock execution
                        </button>
                    )}
                    <button type="button"
                        onClick={() => setRejecting(v => !v)}
                        disabled={awaitingLog}
                        data-testid="proposal-reject"
                        className="h-7 rounded-control border border-line bg-zinc-800/80 px-2.5 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40">
                        Reject
                    </button>
                    <button type="button"
                        onClick={onAskWhy}
                        disabled={awaitingLog}
                        data-testid="proposal-ask-why"
                        className="h-7 rounded-control border border-line bg-zinc-800/80 px-2.5 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40">
                        Ask why
                    </button>
                    <span className="ml-auto font-mono text-ui-2xs text-zinc-600">
                        nothing logs until you approve
                    </span>
                </div>
                {paperReceipt && (
                    <p
                        data-testid="proposal-paper-receipt"
                        role="status"
                        className="mt-1.5 rounded-control border border-hairline bg-white/[0.03] px-2 py-1 font-mono text-ui-2xs text-zinc-300"
                    >
                        {paperReceipt.ok
                            ? `Filled · Paper #${paperReceipt.positionId ?? paperReceipt.orderId ?? 'ok'}${paperReceipt.message ? ` — ${paperReceipt.message}` : ''}`
                            : `Refused · ${paperReceipt.reason ?? paperReceipt.error ?? 'Paper order rejected'}`}
                    </p>
                )}
            </div>
        )}
    </div>
    );
};

/** The settled counterpart: a plan the trader already approved, left in the
 *  transcript so it can never be clicked twice — shown once the undo window
 *  has lapsed. */
export const TradeProposalLoggedRow: React.FC = () => (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wider text-zinc-300"
        data-testid="proposal-logged-row">
        <CheckCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span
            data-testid="simulated-badge"
            className="rounded-control border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-2xs uppercase tracking-wider text-zinc-300"
        >
            Simulated
        </span>
        <span>✓ Approved — tracking this simulated trade; nothing executed on any exchange.</span>
    </p>
);

export default TradeProposalCard;
