/**
 * proposalGate — the gate scan that bounds a presented plan.
 *
 * Why this exists at a tool call at all: the gate used to be a PIPELINE stage, so
 * the confidence cap only bound a verdict the multi-seat run produced. Once a
 * model can put a trade on the table by calling `present_trade`, the cap has to
 * bind THAT path too — otherwise a tool-proposed plan reaches the journal with a
 * probability no scan ever approved.
 *
 * Why it is CONCURRENT rather than blocking: the scan is market data plus an OHLCV
 * pull per timeframe. Awaiting it inside the tool call delays the plan's own
 * drawing and its "Log this trade" card by seconds, on a path that never touched
 * the network before. So `present_trade` starts the scan and shows the levels
 * immediately (no probability, no confidence, no grade until the stamp lands),
 * and the LOG path — a human deciding, seconds or minutes later — awaits the same
 * in-flight scan. Nothing uncapped is ever recorded, and nothing waits on a fetch.
 *
 * Deliberately NOT `quickGateCheck`: that helper folds a FAILED FETCH into
 * `pass: false, confidenceCap: 0`. Here that would report a live idea as a 0%
 * one for the length of a network blip, and 0 is a measurement, not an absence.
 * Splitting fetch from scoring keeps "measured low" and "could not measure" two
 * different facts.
 */

import { fetchGateInputData, runProgrammaticGate } from '../validation/GateKeeperService';
import type { GateInput } from '../validation/GateKeeperService';
import { validateRiskReward } from '../validation/AccuracyValidationService';
import type { ConfidenceLevel } from '../validation/AccuracyValidationService';
import { plannedRiskRewardSigned } from '../../utils/riskReward';
import type { LoggedTrade, ProposalGate } from '../../types';
import type { TradeProposal } from './proposedTrade';
import { buildTradePlan } from './proposedTrade';
import { getHarnessSettings } from '../../utils/harnessSettings';

/** The plan fields the gate needs. `runGateScan` needs the levels for the
 *  minEdge arithmetic too — not just the symbol. */
type PlanForGate = Pick<TradeProposal, 'symbol' | 'direction' | 'entry' | 'stopLoss' | 'takeProfits' | 'confidence'>;

/** How long a scan may run before the plan is called unmeasurable. */
export const GATE_FETCH_TIMEOUT_MS = 10_000;

/** How old a stamp may be before logging re-scans.
 *
 *  Shorter than the 30s desk-tool cache is pointless (the same data), longer than
 *  a trader is likely to sit on a card is theatre; two minutes is the window in
 *  which "fresh" still means the same market. A stamp from yesterday's session,
 *  re-opened today, is re-run. */
export const GATE_STAMP_STALE_MS = 120_000;

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`gate fetch timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const unavailable = (reason: string, minEdge?: MinEdgeVerdict, shape?: PlanShapeVerdict): ProposalGate => ({
    status: 'unavailable', confidenceCap: 1, reason, stampedAt: new Date().toISOString(),
    // An inverted plan refuses even with the market fetch down: the arithmetic
    // is plan-local, and a stamp that could not look at the tape is no reason to
    // present levels that contradict each other.
    ...(shape?.refusal ? { refusal: shape.refusal } : (minEdge?.refusal ? { refusal: minEdge.refusal } : {})),
    ...(shape?.warnings && shape.warnings.length ? { warnings: shape.warnings } : {}),
    ...(minEdge?.netEdgeR !== undefined ? { netEdgeR: minEdge.netEdgeR } : {}),
    ...(minEdge?.thresholdR !== undefined ? { minEdgeThresholdR: minEdge.thresholdR } : {}),
});

interface MinEdgeVerdict {
    refusal?: string;
    netEdgeR?: number;
    thresholdR?: number;
}

/** The plan-local expectancy check (E-43). It needs no market data, so a
 *  refused plan is refused even while the market gate is down. Unknown
 *  arithmetic (an unmeasurable stop) does NOT refuse — an unmeasured plan is
 *  not evidence of a bad one. */
const assessMinEdge = (proposal: PlanForGate, cap: number): MinEdgeVerdict => {
    const thresholdR = getHarnessSettings().minEdgeR;
    // Ask the SAME plan object the card and the journal use, with the cap
    // folded in as a synthetic evaluated stamp. Two arithmetic paths for one
    // plan is how the card and the gate start disagreeing.
    const plan = buildTradePlan({
        ...proposal,
        gate: { status: 'evaluated', confidenceCap: cap, reason: 'min-edge', stampedAt: new Date().toISOString() },
    } as TradeProposal);
    if (typeof plan.netEdgeR !== 'number' || !Number.isFinite(plan.netEdgeR)) {
        return { thresholdR, netEdgeR: undefined };
    }
    const refused = plan.netEdgeR <= thresholdR;
    return {
        thresholdR,
        netEdgeR: plan.netEdgeR,
        ...(refused
            ? { refusal: `net expectancy ${plan.netEdgeR.toFixed(2)}R at ${plan.probability.toFixed(0)}% is at or below your ${thresholdR.toFixed(2)}R floor — ${plan.netEdgeLabel ?? 'after fees'}` }
            : {}),
    };
};

/** The ATR the stop bands are measured against. The proposal carries no
 *  timeframe (the model names levels, not a frame), so this takes the frame the
 *  gate ALREADY scores against — `runProgrammaticGate`'s exhaustion check and
 *  `inferRegime` both read `indicators['1h']` — and falls back through the other
 *  three the harness always fetches. Zero means "no volatility reading", and the
 *  bands stand down rather than warn about a number that does not exist. */
const atrForGate = (indicators: GateInput['indicators'] | undefined): number => {
    for (const tf of ['1h', '4h', '15m', '1d'] as const) {
        const atr = indicators?.[tf]?.atr;
        if (typeof atr === 'number' && Number.isFinite(atr) && atr > 0) return atr;
    }
    return 0;
};

interface PlanShapeVerdict {
    warnings?: string[];
    refusal?: string;
}

/**
 * The plan's own shape: the R:R floor for its stated confidence and the ATR stop
 * bands (E-57 §5).
 *
 * The arithmetic is NOT re-derived here. `validateRiskReward` in
 * `services/validation/AccuracyValidationService.ts` has owned those bands for a
 * while, and its only production caller was `TradeValidationGate.ts` — a module
 * with no importer — which is why a plan could be graded against a floor nothing
 * enforced and the trader never saw it. This is the live call site.
 *
 * It WARNS. Per the owner's ruling a stop distance is the trader's judgement, and
 * *the app proposes; the trader decides*. The one case that refuses is an
 * INVERTED plan, where there is no ratio to warn about at all — decided by the
 * same `utils/riskReward` call the card's printed ratio comes from, so the two
 * cannot disagree about what "inverted" means.
 */
const assessPlanShape = (proposal: PlanForGate, atr: number): PlanShapeVerdict => {
    const planned = plannedRiskRewardSigned({
        entry: proposal.entry,
        stopLoss: proposal.stopLoss,
        takeProfits: proposal.takeProfits,
        direction: proposal.direction,
    });
    if (planned.inverted) {
        // Deliberately NOT `planned.fixes`: those strings are the ordering
        // module's REPAIR descriptions ("… mirrored to 95"), and this gate does
        // not repair, it refuses. Quoting a mirror the app never applied would
        // tell the trader the levels were fixed when they were thrown out.
        const sides = proposal.direction === 'Long'
            ? 'the stop below the entry and the target above it'
            : 'the stop above the entry and the target below it';
        return {
            refusal: `levels are inverted for a ${proposal.direction} plan — a ${proposal.direction} risks with ${sides}, and these levels are not. There is no ratio to grade.`,
        };
    }
    const verdict = validateRiskReward(
        proposal.entry,
        proposal.stopLoss,
        proposal.takeProfits,
        atr,
        (proposal.confidence ?? 'Medium') as ConfidenceLevel,
        proposal.direction as 'Long' | 'Short' | undefined,
    );
    const warnings = verdict.warnings.map(w => w.trim()).filter(w => w.length > 0);
    return warnings.length > 0 ? { warnings } : {};
};

/** Run ONE scan. Never throws: every failure path returns an `unavailable` stamp,
 *  because a plan must be loggable (behind a confirm) with the reason attached.
 *
 *  `skillGate` runs CONCURRENTLY with the market fetch. Its ceiling is folded
 *  into the returned stamp, so the plan the trader logs can never outrank a
 *  trigger deterministic code already confirmed. */
export const runGateScan = async (
    proposal: PlanForGate,
    tradeHistory: LoggedTrade[] = [],
    signal?: AbortSignal,
): Promise<ProposalGate> => {
    if (signal?.aborted) return unavailable('stopped before the gate ran', assessMinEdge(proposal, 1), assessPlanShape(proposal, 0));
    try {
        const input = await withTimeout(fetchGateInputData(proposal.symbol, tradeHistory), GATE_FETCH_TIMEOUT_MS);
        // A Stop can land while the fetch is in flight. The fetch itself has no
        // signal (it goes through the shared market service), so the result is
        // discarded here: a cancelled turn must not settle an evaluated stamp.
        if (signal?.aborted) return unavailable('stopped before the gate ran', assessMinEdge(proposal, 1), assessPlanShape(proposal, 0));
        if (!input) return unavailable('market data fetch returned nothing', assessMinEdge(proposal, 1), assessPlanShape(proposal, 0));
        const shape = assessPlanShape(proposal, atrForGate(input.indicators));
        const out = runProgrammaticGate(input);
        const minEdge = assessMinEdge(proposal, out.confidenceCap);
        const reason = out.pass
            ? `${(out.confidenceCap * 100).toFixed(0)}% cap — ${out.warnings.length > 0 ? out.warnings[0] : 'no penalties'}`
            : `insufficient data (${out.reason})`;
        return {
            status: 'evaluated',
            confidenceCap: out.confidenceCap,
            reason,
            stampedAt: new Date().toISOString(),
            ...(shape.refusal ? { refusal: shape.refusal } : (minEdge.refusal ? { refusal: minEdge.refusal } : {})),
            ...(shape.warnings ? { warnings: shape.warnings } : {}),
            ...(minEdge.netEdgeR !== undefined ? { netEdgeR: minEdge.netEdgeR } : {}),
            ...(minEdge.thresholdR !== undefined ? { minEdgeThresholdR: minEdge.thresholdR } : {}),
        };
    } catch (e) {
        return unavailable(
            e instanceof Error ? e.message : String(e),
            assessMinEdge(proposal, 1),
            assessPlanShape(proposal, 0),
        );
    }
};

/** One in-flight scan per PLAN, so a model that re-presents the same plan (or a
 *  transcript that re-renders it) cannot start a second fetch per paint. */
const inFlight = new Map<string, { promise: Promise<ProposalGate>; controller: AbortController }>();

/** Start the scan for a plan, or join the one already running for that plan id. */
export const beginGateScan = (
    planId: string,
    proposal: PlanForGate,
    tradeHistory: LoggedTrade[] = [],
): Promise<ProposalGate> => {
    const live = inFlight.get(planId);
    if (live) return live.promise;
    const controller = new AbortController();
    const entry = { promise: runGateScan(proposal, tradeHistory, controller.signal), controller };
    inFlight.set(planId, entry);
    // Drop the record once answered: `ensureStamp` then reads the stamp off the
    // proposal, and a genuinely stale one must be allowed to start a NEW scan.
    void entry.promise.finally(() => { if (inFlight.get(planId) === entry) inFlight.delete(planId); });
    return entry.promise;
};

/** Stop/unmount cancels the scan. The settled value is then an `unavailable`
 *  stamp, so the card falls to the confirm path instead of hanging. */
export const cancelGateScan = (planId: string): void => {
    const live = inFlight.get(planId);
    if (!live) return;
    inFlight.delete(planId);
    live.controller.abort();
};

export const isStampFresh = (gate?: ProposalGate): boolean => {
    if (!gate) return false;
    const at = Date.parse(gate.stampedAt);
    return Number.isFinite(at) && Date.now() - at <= GATE_STAMP_STALE_MS;
};

/** The ONE call every log path makes — the card's button and the rail's
 *  both await this, so a row is never written beside a scan that could have been
 *  consulted. Fresh stamp → reuse. Scan running → join it. Neither → scan now. */
export const ensureStamp = async (
    proposal: TradeProposal,
    tradeHistory: LoggedTrade[] = [],
    signal?: AbortSignal,
): Promise<ProposalGate> => {
    if (isStampFresh(proposal.gate)) return proposal.gate as ProposalGate;
    if (proposal.planId) return await beginGateScan(proposal.planId, proposal, tradeHistory);
    return await runGateScan(proposal, tradeHistory, signal);
};

/** One line for the tool receipt / the card, in the plan's own terms. */
export const gateReceiptLine = (gate: ProposalGate): string => {
    if (gate.refusal) return `Gate: REFUSED — ${gate.refusal}. The card will not offer "Log this trade"; do not ask the user to log it.`;
    const cap = gate.confidenceCap;
    return gate.status === 'evaluated'
        ? `Gate: confidence capped at ${(cap * 100).toFixed(0)}% (${gate.reason}).`
        : `Gate unavailable (${gate.reason}) — logging this plan needs an explicit confirm and it will be recorded UNCAPPED.`;
};
