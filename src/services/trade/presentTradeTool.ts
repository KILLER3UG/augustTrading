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
import type { ProposalGate } from './proposedTrade';
import { parseTradeProposal, mintPlanId, buildTradePlan, type TradeProposal } from './proposedTrade';
import { beginGateScan, cancelGateScan, gateReceiptLine } from './proposalGate';
import { drawingsFromLevelTool, type ChartDrawing } from './chartDrawings';
import { staleLevelsAtArm, type WatchPlan } from './tradePlanLevels';

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
    /** The note appended to the receipt when `crossCanvas` is true. */
    canvasNote: string;
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
}

const receipt = (call: DeskToolCall, name: string, ok: boolean, content: string): DeskToolResult =>
    ({ toolCallId: call.id, name, ok, content });

/** Run one `present_trade` call. */
export const runPresentTrade = (ctx: PresentTradeContext, sink: PresentTradeSink): DeskToolResult => {
    const { call } = ctx;
    const name = call.name;
    const args = call.arguments ?? {};
    const { proposal, error } = parseTradeProposal({ ...args, symbol: args.symbol || ctx.symbol });
    if (error || !proposal) return receipt(call, name, false, `present_trade rejected: ${error ?? 'invalid proposal'}`);

    // The DOCK generates the stable plan id first: it keys the level-watch,
    // the receipt's level ids, "Log this trade" onto the journal row, AND the
    // one in-flight gate scan for this plan.
    const planId = mintPlanId(proposal.symbol);
    proposal.planId = planId;

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
    const watching = ctx.watchable;
    const armPrice = !watching || ctx.crossCanvas
        ? null
        : (typeof ctx.drawnPrice === 'number' && Number.isFinite(ctx.drawnPrice) && ctx.drawnPrice > 0 ? ctx.drawnPrice : null);
    const stale = watching ? staleLevelsAtArm(plan, armPrice) : [];
    sink.armPlan?.(plan);
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
    const staleWatchLine = `WARNING: the harness REFUSED to watch this plan — price ${ctx.drawnPrice} is already through a stop/target, so every level (${stale.join(', ')}) latched as already-reached and NO [HARNESS SIGNAL] will come for them. Do not claim a watch is live; if the user still wants one, re-present a plan whose levels sit ahead of price.`;
    const watchLine = !watching
        ? 'NO level-watch is armed and nothing was drawn — this surface has no chart. The trader still sees the plan and can log it from the card.'
        : stale.length > 0
            ? staleWatchLine
            : `The harness now watches these levels — ids ${levelIds.join(', ')} — and will send you a [HARNESS SIGNAL] when one is reached; refer to levels by those ids and never re-announce one that already fired.`;
    // The receipt never states a probability the scan has not yet bounded.
    // Saying "Recorded as 72%" here and capping it at log time would put two
    // numbers for the same plan in the model's own context.
    const gateLine = proposal.gate
        ? gateReceiptLine(proposal.gate)
        : 'Gate: scanning now — no probability is shown on the card or recorded on the row until the scan answers, and the logged plan is capped by it.';
    return receipt(
        call,
        name,
        true,
        `Presented ${proposal.direction} ${proposal.symbol} @ ${proposal.entry}, SL ${proposal.stopLoss}, TP ${proposal.takeProfits.join('/')}, R:R ~${rr}:1. ${gateLine} The user sees a "Log this trade" card. ${watchLine}${ctx.canvasNote}`,
    );
};
