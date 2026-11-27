/**
 * presentTradeTool — the ONE `present_trade` executor, shared by both chat homes.
 *
 * This branch used to live inside the Chart AI dock's `executePanelTool`, where
 * it was welded to a `chatStore` entry, a live canvas and the level-watch. The
 * Agents surface cannot present a plan without it, and copying it would have been
 * a second answer to "what did the model propose" — the exact split stage 20
 * exists to close. So the TRANSITION lives here and every side-effect goes
 * through a sink the calling row owns.
 *
 * The receipts are the contract, and four honesty tests in
 * `tests/tradeChatPanelHarness.test.tsx` pin them: a plan already through its
 * stop/target gets REFUSED, a live one gets the watch promise, a cross-canvas
 * turn keeps the stale-stamp note, and a same-coin canvas adds no note. The
 * rule that makes those four agree is that the receipt describes the SAME
 * `arm()` call the surface is about to make — including the null anchor the
 * chart uses off-view, and including "nothing is watching" when the caller has
 * no watch to arm.
 */

import type { LoggedTrade } from '../../types';
import type { DeskToolCall, DeskToolResult } from '../analysis/DeskToolsService';
import type { ProposalGate, PresentTradeMath } from './proposedTrade';
import { parseTradeProposal, mintPlanId, buildTradePlan, type TradeProposal } from './proposedTrade';
import { formatPaperFillAssumptions, PAPER_EXECUTION_RECEIPT } from '../tracking/paperExecution';
import { beginGateScan, cancelGateScan, evaluatePlanLocalSync, gateReceiptLine } from './proposalGate';
import { drawingsFromLevelTool, type ChartDrawing } from './chartDrawings';
import { computeTradeMath, computeFundingDrag, type TradeMathRead } from '../market/tradeMathCore';
import { coerceToolArguments, formatTypedRepairRejection, recordCoercionAudit } from '../analysis/toolArgCoercionCore';
import type { Kline } from '../../types/message';
import type { WatchPlan } from './tradePlanLevels';

/**
 * Injectable inputs for the deterministic math gate. Tests stub these;
 * the defaults read the LIVE paper account (equity, risk cap, max leverage),
 * the MEASURED funding interval and the coin's recent candles — each
 * best-effort and time-boxed, so an offline harness degrades to `null`
 * inputs (the math still runs; the missing piece is named) instead of
 * inventing numbers.
 */
export interface PresentTradeMathDeps {
    getAccount?: () => Promise<{ equityUsd: number; riskPercent: number; leverage: number } | null>;
    getFunding?: (symbol: string) => Promise<{ rate: number; intervalHours: number | null } | null>;
    getCandles?: (symbol: string) => Promise<Kline[]>;
}

/** Never let a slow/offline market fetch stall a presented plan. */
const withTimeout = async <T>(promise: Promise<T>, fallback: T, ms = 1_500): Promise<T> => {
    try {
        return await Promise.race([
            promise,
            new Promise<T>(resolve => { setTimeout(() => resolve(fallback), ms); }),
        ]);
    } catch {
        return fallback;
    }
};

const defaultPresentTradeMathDeps: PresentTradeMathDeps = {
    getAccount: async () => {
        try {
            const { getPaperAccount } = await import('../paper/PaperBrokerService');
            const account = await withTimeout(getPaperAccount(), null as never);
            if (!account) return null;
            return {
                equityUsd: account.cashBalanceUsd > 0 ? account.cashBalanceUsd : account.config.startingBalanceUsd,
                riskPercent: account.config.maxRiskPerTradePct,
                leverage: account.config.maxLeverage,
            };
        } catch {
            return null;
        }
    },
    getFunding: async symbol => {
        try {
            const mds = await import('../analysis/MarketDataService');
            const [intervalHours, mark] = await Promise.all([
                withTimeout(mds.fetchFundingInfo(symbol).catch(() => null), null),
                withTimeout(mds.fetchMarkIndex(symbol).catch(() => null), null as never),
            ]);
            const rate = Number((mark as unknown as { lastFundingRate?: unknown } | null)?.lastFundingRate);
            if (!Number.isFinite(rate)) return null;
            return { rate, intervalHours: intervalHours ?? null };
        } catch {
            return null;
        }
    },
    getCandles: async symbol => {
        try {
            const { fetchRecentForTools } = await import('../analysis/marketTools');
            return await withTimeout(fetchRecentForTools(symbol, '15m', 100).catch(() => []), []);
        } catch {
            return [];
        }
    },
};

/** The harness's OWN numbers for a presented plan — attached to the card and
 *  the receipt, so no figure a trader reads was ever the model's arithmetic. */
export interface PresentTradeMathResult {
    /** Null when the levels themselves are uncomputable (refused upstream). */
    read: TradeMathRead | null;
    snapshot: PresentTradeMath;
}

/** Compute the deterministic trade math for a presented plan. Pure over its
 *  inputs; every input defaults to the live harness sources and degrades to
 *  null (named on the card) rather than guessed. */
export const computePresentTradeMath = async (
    proposal: Pick<TradeProposal, 'symbol' | 'direction' | 'entry' | 'stopLoss' | 'takeProfits'>,
    deps: PresentTradeMathDeps = {},
): Promise<PresentTradeMathResult> => {
    const d = { ...defaultPresentTradeMathDeps, ...deps };
    const [account, funding, candles] = await Promise.all([
        d.getAccount?.() ?? Promise.resolve(null),
        d.getFunding?.(proposal.symbol) ?? Promise.resolve(null),
        d.getCandles?.(proposal.symbol) ?? Promise.resolve(null),
    ]);
    const read = computeTradeMath({
        direction: proposal.direction,
        entry: proposal.entry,
        stopLoss: proposal.stopLoss,
        takeProfits: proposal.takeProfits,
        equityUsd: account?.equityUsd,
        riskPercent: account?.riskPercent,
        leverage: account?.leverage,
    }, candles ?? []);
    // Funding carry at the MEASURED interval (never an invented 8h). One
    // settlement over the immediate hold is the honest minimum assumption —
    // stated on the card beside the number.
    let fundingDragR: number | null = null;
    if (funding && read && !read.gross.inverted) {
        fundingDragR = computeFundingDrag({
            direction: proposal.direction,
            entry: proposal.entry,
            stopLoss: proposal.stopLoss,
            fundingRate: funding.rate,
            settlements: 1,
        });
    }
    const snapshot: PresentTradeMath = {
        grossRatio: read?.gross.ratio ?? 0,
        netRewardR: read?.costs.netRewardR ?? null,
        costR: read?.costs.costR ?? null,
        breakEvenWinRatePct: read?.costs.breakEvenWinRatePct ?? null,
        riskUsd: read?.sizing.riskUsd ?? null,
        qty: read?.sizing.qty ?? null,
        notionalUsd: read?.sizing.notionalUsd ?? null,
        leverageNeeded: read?.sizing.leverageNeeded ?? null,
        liquidationPrice: read?.liquidation?.price ?? null,
        liquidationDistanceAtr: read?.liquidation?.distanceAtr ?? null,
        fundingDragR,
        fundingRate: funding?.rate ?? null,
        fundingIntervalHours: funding?.intervalHours ?? null,
        inverted: !read || read.gross.inverted,
    };
    return { read, snapshot };
};

/** What the turn is running against: the argument bag, the coin it was asked
 *  on, the closed-trade log for the gate, and the canvas truth it must not
 *  overstate. */
export interface PresentTradeContext {
    call: DeskToolCall;
    /** The coin THIS turn belongs to — never "whatever is on screen". */
    symbol: string;
    trades: LoggedTrade[];
    /** The live mark to stamp the drawing with, or null with no canvas. */
    drawnPrice: number | null;
    /** The snapshot is the VIEWED canvas and this turn runs on another coin,
     *  so its prices are stale for this turn. The dock measures it; a surface
     *  with no canvas passes false. */
    crossCanvas: boolean;
    /** Does this surface intend to ARM a level-watch on the plan? An explicit
     *  flag, not inferred from `sink.armPlan` being passed: the dock arms
     *  through a prop that a host may legitimately omit, and the receipt is a
     *  claim about the harness, so it must be driven by the surface's intent —
     *  an absent callback means "not wired", never "impossible". */
    watchable: boolean;
    /** True when read-only Plan Mode is active — suppresses background watch auto-arming. */
    planMode?: boolean;
    /** The note appended to the receipt when `crossCanvas` is true. */
    canvasNote: string;
    /** Bounded semantic auto-repair allowance remaining for this turn (default 1). */
    autoRepairRemaining?: number;
}

/** The writes a presenting turn needs. Only `setProposal` is required — a
 *  surface with no canvas draws nothing, and a surface whose harness does not
 *  own the level-watch says so in the receipt instead of promising a signal
 *  that will never come. */
export interface PresentTradeSink {
    /** Show the plan's decision card on the row that presented it. */
    setProposal(proposal: TradeProposal): void;
    /** Fold the gate verdict into that same card once the scan answers. */
    setGate?(gate: ProposalGate): void;
    /** Draw ENTRY/SL/TP on a live canvas. */
    addDrawings?(drawings: ChartDrawing[]): void;
    /** Arm the harness level-watch on the plan. */
    armPlan?(plan: WatchPlan): void;
    /** A Stop on this turn cancels its own scan: a late answer must not
     *  resurrect a card the trader already cancelled. */
    onAbort?(fn: () => void): void;
    /** Training-corpus tee (O-46): the plan's STRUCTURED identity — the id
     *  this function minted and the playbook stamp it verified — reported the
     *  moment both exist. The recorder joins outcomes on this id; mining it
     *  out of the receipt prose was how a join could silently miss. */
    onCapturePlan?(plan: { planId: string; symbol: string; playbookId: string | null }): void;
    /** The decision snapshot, when its fetch lands (it is not awaited). The
     *  turn may have settled by then; the recorder is fire-and-forget and
     *  accepts it late. */
    onCaptureSnapshot?(snapshot: {
        regimeId: string | null; regimeText: string | null;
        atr: number | null; atrTf: string;
        prevDayHigh: number | null; prevDayLow: number | null;
        sessionVwap: number | null; capturedAt: string;
    }): void;
}

const receipt = (call: DeskToolCall, name: string, ok: boolean, content: string): DeskToolResult =>
    ({ toolCallId: call.id, name, ok, content });

/**
 * The attribution sentence in the present_trade receipt. It is the model's
 * only proof of what the journal will be able to measure: confirm a kept id,
 * name a dropped one rather than letting the model believe attribution
 * landed, and say nothing when the caller supplied none.
 */
export const playbookAttributionLine = (requested: unknown, stamped: string | undefined): string => {
    if (stamped) return ` Attribution: tagged ${stamped} — per-detector stats will count this plan.`;
    const dropped = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
    return dropped
        ? ` Attribution: "${dropped}" is not a scan_playbooks detector id, so NO playbook tag was recorded.`
        : '';
};

/** Run one `present_trade` call. Async because the deterministic math gate
 *  reads the live paper account + measured funding (both time-boxed and
 *  best-effort); every caller awaits it. */
export const runPresentTrade = async (
    ctx: PresentTradeContext,
    sink: PresentTradeSink,
    mathDeps: PresentTradeMathDeps = {},
): Promise<DeskToolResult> => {
    const { call } = ctx;
    const name = call.name;
    const { args, coercions } = coerceToolArguments('present_trade', call.arguments ?? {});
    recordCoercionAudit('present_trade', coercions);
    const autoRepairRemaining = ctx.autoRepairRemaining ?? 1;
    const { proposal, error } = parseTradeProposal({ ...args, symbol: args.symbol || ctx.symbol });
    if (error || !proposal) {
        const reason = error ?? 'invalid proposal';
        const isInverted = /below entry|above entry|above it|below it|inverted/i.test(reason);
        return receipt(
            call,
            name,
            false,
            formatTypedRepairRejection({
                tool: 'present_trade',
                errorCode: isInverted ? 'inverted_bracket' : 'invalid_proposal_args',
                field: /direction/i.test(reason) ? 'direction'
                    : /stopLoss/i.test(reason) ? 'stopLoss'
                    : /takeProfits/i.test(reason) ? 'takeProfits'
                    : /entry/i.test(reason) ? 'entry'
                    : 'bracket',
                expectedConstraint: reason,
                repairHint: isInverted
                    ? 'Ensure Long has stopLoss < entry < takeProfits[0] (or Short has takeProfits[0] < entry < stopLoss) and retry once.'
                    : 'Pass valid direction ("Long"|"Short"), positive entry, stopLoss, and takeProfits array, then retry once.',
                autoRepairRemaining,
                message: `present_trade rejected: ${reason}`,
            }),
        );
    }

    // Synchronous plan-local shape + min-edge check BEFORE drawing or arming:
    // an inverted plan is refused immediately (never hits the chart or card),
    // while R:R and expectancy warnings ride onto the initial receipt.
    const localCheck = evaluatePlanLocalSync(proposal);
    if (localCheck.inverted) {
        return receipt(
            call,
            name,
            false,
            formatTypedRepairRejection({
                tool: 'present_trade',
                errorCode: 'inverted_bracket',
                field: 'stopLoss/takeProfits',
                expectedConstraint: localCheck.refusal ?? 'levels are inverted for the stated direction.',
                repairHint: proposal.direction === 'Long'
                    ? 'For Long, place stopLoss < entry < takeProfits[0] and retry once.'
                    : 'For Short, place takeProfits[0] < entry < stopLoss and retry once.',
                autoRepairRemaining,
                message: `present_trade rejected: ${localCheck.refusal ?? 'levels are inverted for the stated direction.'}`,
            }),
        );
    }

    // DETERMINISTIC MATH GATE — zero mental arithmetic. The harness computes
    // the plan's own numbers (gross R:R, fee/funding-adjusted net R:R,
    // break-even win rate, sizing at the account's equity + risk cap,
    // isolated liquidation) and attaches them to the card AND this receipt.
    // An inverted bracket that slips past the shape check is refused here too,
    // and the model's prose never supplies a number the trader reads.
    const math = await computePresentTradeMath(proposal, mathDeps);
    if (math.snapshot.inverted) {
        return receipt(
            call,
            name,
            false,
            formatTypedRepairRejection({
                tool: 'present_trade',
                errorCode: 'inverted_bracket',
                field: 'stopLoss/takeProfits',
                expectedConstraint: 'inverted bracket (harness math) — stop and targets must sit on opposite sides of entry.',
                repairHint: 'Fix stopLoss and takeProfits ordering relative to entry for the stated direction and retry once.',
                autoRepairRemaining,
                message: 'present_trade rejected: inverted bracket (harness math) — the stop and/or targets sit on the wrong side of the entry for the stated direction.',
            }),
        );
    }
    proposal.math = math.snapshot;

    // The DOCK generates the stable plan id first: it keys the level-watch,
    // the receipt's level ids, "Log this trade" onto the journal row, AND the
    // one in-flight gate scan for this plan.
    const planId = mintPlanId(proposal.symbol);
    proposal.planId = planId;
    // The corpus tee hears it from the STRUCTURED path, not from a regex over
    // the receipt prose.
    sink.onCapturePlan?.({ planId, symbol: proposal.symbol, playbookId: proposal.playbookId ?? null });

    // The O-46 decision snapshot starts NOW, like the gate scan: not awaited
    // (the card draws first), attached to the same proposal object when it
    // lands, so the journal row and the training corpus carry the market's
    // measured state at decision time. A failed fetch leaves the snapshot
    // absent — the dashes stay, which is honest.
    void import('../analysis/marketTools').then(mt => mt.buildDecisionSnapshot(proposal.symbol))
        .then(snap => {
            if (snap) {
                proposal.decisionSnapshot = snap;
                sink.onCaptureSnapshot?.(snap);
            }
        })
        .catch(() => { /* absent snapshot is the honest state */ });

    // The scan starts NOW but is not awaited here. Awaiting it put a
    // market-data fetch plus an OHLCV pull per timeframe in front of drawing
    // the plan, so the card appeared seconds later on a path that used to touch
    // no network at all. The LOG path awaits the same promise (`ensureStamp`),
    // which is where the cap actually has to bind.
    let cancelled = false;
    void beginGateScan(planId, proposal, ctx.trades).then(gate => {
        // The abort handler below can delete the in-flight entry, but the
        // promise it started still resolves. Drop that answer here: a late
        // stamp must not resurrect a card the trader cancelled.
        if (!cancelled) sink.setGate?.(gate);
    });
    // ONE plan object: the levels the watch arms, the drawings, the ratio the
    // receipt quotes and the card's numbers all come from here.
    const planView = buildTradePlan(proposal);
    if (sink.addDrawings) {
        const { drawings } = drawingsFromLevelTool(
            { entry: planView.entry, stopLoss: planView.stopLoss, takeProfits: planView.takeProfits },
            { drawnPrice: ctx.drawnPrice },
        );
        sink.addDrawings(drawings);
    }
    const plan: WatchPlan = {
        planId, symbol: planView.symbol, direction: planView.direction,
        entry: planView.entry, stopLoss: planView.stopLoss, takeProfits: planView.takeProfits,
    };
    // The honest disposition of the watch the surface is about to arm: arm()
    // REFUSES a plan already through its SL/target at the live mark
    // (`staleLevelsAtArm` is the same gate), so the receipt must not promise a
    // watch that will never ping. CROSS-CANVAS MIRROR OF
    // TradeView.handlePlanPresented: off-view the viewed mark is NOT the turn's
    // coin's live price, so arm() gets a null anchor (plain first-tick touch
    // test, never a stale-refuse) — and the receipt must evaluate the gate with
    // the SAME null, or it lies about a REFUSED watch that arms fine.
    const watching = ctx.watchable && !ctx.planMode;
    // GRAPH EDGE: present_trade does NOT arm. The plan enters `pending_review`
    // and the CALLER routes it through the isolated adversaryReview node —
    // APPROVE / CAUTION / UNAVAILABLE arm the watch (the trader's explicit
    // override clears a VETO). Arming here raced the review: a VETO had to
    // DISARM an armed watch it had already armed — two edges for one
    // decision. The stale gate still runs at arm time (levelWatch.arm
    // refuses a plan already through its levels with the live mark).
    sink.setProposal(proposal);
    sink.onAbort?.(() => {
        cancelled = true;
        cancelGateScan(planId);
    });
    // Planned R:R comes from utils/riskReward — the nearest target, not
    // whatever the model happened to list first. Reading takeProfits[0] here
    // made the receipt disagree with the card and the journal on any plan whose
    // targets came back out of order, and the model then repeated the receipt's
    // number to the trader.
    const ratio = planView.plannedRr;
    const rr = ratio > 0 ? ratio.toFixed(1) : '—';
    const levelIds = [`${proposal.planId}:ENTRY`, `${proposal.planId}:SL`,
        ...proposal.takeProfits.map((_, i) => `${proposal.planId}:TP${i + 1}`)];
    // Only reachable on the VIEWED canvas (crossCanvas ⇒ armPrice is null ⇒
    // stale is empty), so the price named here is genuinely the coin's live mark.
    const watchLine = ctx.planMode
        ? 'Plan Mode is active (read-only) — NO background price watch was armed. The trader can review the card and click "Unlock execution" to exit Plan Mode.'
        : !watching
        ? 'NO level-watch applies — this surface has no chart. The trader still sees the plan and can log it from the card.'
        : `The plan is PENDING REVIEW: the isolated adversary review clears it next — APPROVE/CAUTION/UNAVAILABLE arm the harness watch on ids ${levelIds.join(', ')} (a [HARNESS SIGNAL] names the level id when one is reached); a VETO holds the watch for the trader's explicit override on the card. Refer to levels by those ids and never re-announce one that already fired.`;
    // The receipt never states a probability the scan has not yet bounded.
    // Saying "Recorded as 72%" here and capping it at log time would put two
    // numbers for the same plan in the model's own context.
    const syncWarnLine = localCheck.warnings.length > 0
        ? ` Sync plan check warning(s): ${localCheck.warnings.join('; ')}.`
        : '';
    const gateLine = proposal.gate
        ? gateReceiptLine(proposal.gate)
        : `Gate: scanning now — no probability is shown on the card or recorded on the row until the scan answers, and the logged plan is capped by it.${syncWarnLine}`;
    const playbookLine = playbookAttributionLine(args.playbook, proposal.playbookId);
    const skillLine = proposal.skillSlug ? ` Skill: ${proposal.skillSlug}.` : '';
    const paperLine = proposal.simulated !== false
        ? ` Paper lane: ${formatPaperFillAssumptions(proposal.fillAssumptions)} (${PAPER_EXECUTION_RECEIPT})`
        : '';
    // The harness's own numbers on the receipt — the model quotes THESE, and
    // any R:R/size it said in prose is subordinate to them (the card shows
    // both side by side).
    const m = math.snapshot;
    const mathLine = ` Harness math: gross ${m.grossRatio}:1, net ${m.netRewardR ?? '—'}R (fees ${m.costR ?? '—'}R${m.fundingDragR !== null ? `, funding ${m.fundingDragR >= 0 ? '+' : ''}${m.fundingDragR}R${m.fundingIntervalHours !== null ? ` at the measured ${m.fundingIntervalHours}h interval` : ''}` : ''}), break-even ${m.breakEvenWinRatePct ?? '—'}%, risk $${m.riskUsd ?? '—'} → qty ${m.qty ?? '—'} @ ${m.leverageNeeded ?? '—'}x (notional $${m.notionalUsd ?? '—'}), liq ~${m.liquidationPrice ?? '—'}${m.liquidationDistanceAtr !== null ? ` (${m.liquidationDistanceAtr} ATR)` : ''}.`;
    return receipt(
        call,
        name,
        true,
        `Presented ${proposal.direction} ${proposal.symbol} @ ${proposal.entry}, SL ${proposal.stopLoss}, TP ${proposal.takeProfits.join('/')}, R:R ~${rr}:1.${mathLine} ${gateLine} The user sees a "Log this trade" card.${playbookLine}${skillLine}${paperLine} ${watchLine}${ctx.canvasNote}`,
    );
};
