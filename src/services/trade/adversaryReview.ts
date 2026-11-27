/**
 * adversaryReview — the isolated read-only reviewer for `present_trade`
 * (Claude Code's zero-history subagent, adapted to a trade plan).
 *
 * WHY IT EXISTS: the thread that proposes a plan cannot be the one that
 * confirms it — self-confirming bias is the failure mode every deterministic
 * gate already fights, and the gates are shape/fee checks, not market reads.
 * This reviewer is a SECOND seat call over an OBJECTIVE packet only: the plan
 * bracket, its net R:R after fees, ATR distances, the measured trend biases,
 * and the trader's own calibration history for the coin. NO chat prose, no
 * thesis, no self-justification — the reviewer sees the plan and the tape, in
 * that order, and answers with a strict verdict.
 *
 * The verdict is ADVISORY-TO-THE-CARD, never a trade decision: APPROVE/CAUTION
 * arm as usual, a VETO withdraws the auto-armed watch until the trader
 * explicitly overrides on the card. A timeout, a missing provider, or an
 * unparseable answer is `UNAVAILABLE` — the plan proceeds exactly as it would
 * have without the reviewer, and the card says so.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { plannedRiskRewardSigned, targetsByDistance } from '../../utils/riskReward';
import { roundTripCostR } from '../../utils/netRiskReward';
import { resolveComposerEffort } from '../providers/reasoningControls';
import type { ReasoningEffort } from '../../types/provider';
import type { ProposalConflictFlag } from './proposalConflictSensorCore';

export type AdversaryVerdict = 'APPROVE' | 'CAUTION' | 'VETO' | 'UNAVAILABLE';

export interface AdversaryReview {
    verdict: AdversaryVerdict;
    objections: string[];
    invalidationCheck: string;
    at: number;
}

export interface AdversaryInput {
    plan: {
        planId: string;
        symbol: string;
        direction: 'Long' | 'Short';
        entry: number;
        stopLoss: number;
        takeProfits: number[];
    };
    markPrice: number | null;
    atr: number | null;
    /** Evaluated candles for the measured trend bias (the SAME series the
     *  Tier 0 manifest reads) — never chat text. */
    candles: ReadonlyArray<{ close: number }>;
    /** The coin's own calibration verdict, when the ledger has one. */
    calibration?: { verdict: string; thin: boolean } | null;
    /** Deterministic 5-check conflict flags that triggered this adversary pass. */
    conflictFlags?: readonly ProposalConflictFlag[];
    /** Optional composer effort; defaults to boosted `EFFORT_BY_TASK.adversary` ('high'). */
    effort?: ReasoningEffort;
}

export const ADVERSARY_TIMEOUT_MS = 13_000;

const ADVERSARY_SYSTEM = [
    'You are an ADVERSARIAL risk reviewer for one trade plan. Your job is to find reasons it LOSES, not to approve it.',
    'Respond ONLY with JSON: {"verdict":"APPROVE"|"CAUTION"|"VETO","objections":["<=4 short objective objections"],"invalidation_check":"one sentence on whether the stop invalidates at a defensible level"}',
    'Rules:',
    '- VETO only for objective defects: inverted or noise-level stop, net R:R after fees below 1, stop/target already reached by the mark, or a regime read that directly opposes the direction.',
    '- CAUTION for one-sided confluence, wide stop relative to ATR, or a thin calibration sample.',
    '- Every objection must cite a NUMBER from the packet. No opinions, no advice, no prose beyond the JSON.',
].join('\n');

/** The one pure classification the fallback uses (also unit-tested). */
export const fallbackAdversaryVerdict = (input: AdversaryInput): AdversaryReview => {
    const { plan, markPrice, atr } = input;
    const risk = Math.abs(plan.entry - plan.stopLoss);
    const target = targetsByDistance(plan.entry, plan.takeProfits)[0] ?? plan.entry;
    const signed = plannedRiskRewardSigned({
        direction: plan.direction,
        entry: plan.entry,
        stopLoss: plan.stopLoss,
        takeProfits: plan.takeProfits,
    });
    const stopDistancePct = plan.entry > 0 ? (risk / plan.entry) * 100 : 0;
    const cost = roundTripCostR({ stopDistancePct });
    const netRr = signed.inverted ? 0 : Math.max(0, signed.ratio - (cost.known ? (cost.costR as number) : 0));
    const objections: string[] = [];
    let verdict: AdversaryVerdict = 'APPROVE';
    // A bracket with a non-positive/NaN target or an unknown direction cannot
    // be scored: `nearestTargetPrice` only checks finiteness, so a target of
    // -5 turns a Short into a fictitious 52.5R and used to APPROVE it.
    if (plan.direction !== 'Long' && plan.direction !== 'Short') {
        objections.push(`direction ${String(plan.direction)} is not Long/Short — the bracket cannot be scored.`);
        verdict = 'VETO';
    }
    const badTargets = plan.takeProfits.filter(tp => typeof tp !== 'number' || !Number.isFinite(tp) || tp <= 0);
    if (badTargets.length > 0) {
        objections.push(`target ${String(badTargets[0])} is non-positive or not finite — the bracket cannot be scored.`);
        verdict = 'VETO';
    }
    if (signed.inverted) {
        objections.push('plan levels are inverted for the stated direction.');
        verdict = 'VETO';
    }
    if (markPrice !== null && Number.isFinite(markPrice)) {
        const throughStop = plan.direction === 'Long' ? markPrice <= plan.stopLoss : markPrice >= plan.stopLoss;
        const throughTarget = plan.direction === 'Long' ? markPrice >= target : markPrice <= target;
        if (throughStop || throughTarget) {
            objections.push(`mark ${markPrice} is already through the plan's ${throughStop ? 'stop' : 'target'} — the watch would latch stale.`);
            verdict = 'VETO';
        }
    }
    if (netRr < 1) {
        objections.push(`net R:R ${netRr.toFixed(2)}:1 is below 1 after the bracket.`);
        if (verdict === 'APPROVE') verdict = 'CAUTION';
    }
    if (atr !== null && atr > 0 && risk > 0 && risk < atr * 0.25) {
        objections.push(`stop distance ${risk} is under 0.25 ATR (${atr}) — noise-level invalidation.`);
        if (verdict === 'APPROVE') verdict = 'CAUTION';
    }
    if (input.calibration?.thin) {
        objections.push('calibration sample for this coin is too thin to support a claim.');
    }
    return {
        verdict,
        objections: objections.slice(0, 4),
        invalidationCheck: risk > 0
            ? `Stop ${plan.stopLoss} sits ${risk} from entry; invalidation is ${risk / (atr && atr > 0 ? atr : risk)} ATR away.`
            : 'Stop equals entry — bracket invalid.',
        at: Date.now(),
    };
};

const parseAdversaryJson = (raw: string, fallback: AdversaryReview): AdversaryReview => {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
        const parsed = JSON.parse(match[0]) as { verdict?: unknown; objections?: unknown; invalidation_check?: unknown; invalidationCheck?: unknown };
        const verdict = parsed.verdict === 'APPROVE' || parsed.verdict === 'CAUTION' || parsed.verdict === 'VETO'
            ? parsed.verdict
            : null;
        if (!verdict) return fallback;
        const objections = Array.isArray(parsed.objections)
            ? parsed.objections.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 4).map(o => o.trim().slice(0, 200))
            : [];
        const invalidationCheck = typeof parsed.invalidation_check === 'string'
            ? parsed.invalidation_check.slice(0, 300)
            : typeof parsed.invalidationCheck === 'string'
                ? parsed.invalidationCheck.slice(0, 300)
                : fallback.invalidationCheck;
        return { verdict, objections, invalidationCheck, at: Date.now() };
    } catch {
        return fallback;
    }
};

/**
 * One adversary pass. Deterministic-first: the fallback verdict is computed
 * BEFORE the model call, so a timeout, a missing provider, or garbage output
 * degrades to an honest measured answer instead of a shrug.
 */
export const runAdversaryReview = async (input: AdversaryInput): Promise<AdversaryReview> => {
    const fallback = fallbackAdversaryVerdict(input);
    try {
        const { resolveBackgroundSeat } = await import('./autonomyEngine');
        const { trendBias } = await import('./regime');
        const seat = await resolveBackgroundSeat(getActiveUsername(), 'adversary');
        if (!seat) return { verdict: 'UNAVAILABLE', objections: [], invalidationCheck: '', at: Date.now() };

        const signed = plannedRiskRewardSigned({
            direction: input.plan.direction,
            entry: input.plan.entry,
            stopLoss: input.plan.stopLoss,
            takeProfits: input.plan.takeProfits,
        });
        const risk = Math.abs(input.plan.entry - input.plan.stopLoss);
        const stopDistancePct = input.plan.entry > 0 ? (risk / input.plan.entry) * 100 : 0;
        const cost = roundTripCostR({ stopDistancePct });
        const rr = signed.inverted ? 0 : Math.max(0, signed.ratio - (cost.known ? (cost.costR as number) : 0));
        const closes = input.candles.map(c => c.close);
        const bias = closes.length >= 30 ? trendBias(closes) : null;
        const packet = JSON.stringify({
            plan: {
                id: input.plan.planId, symbol: input.plan.symbol, direction: input.plan.direction,
                entry: input.plan.entry, stop: input.plan.stopLoss, targets: input.plan.takeProfits,
            },
            net_rr_after_fees: Number.isFinite(rr) ? Number(rr.toFixed(2)) : null,
            mark: input.markPrice,
            atr14: input.atr,
            stop_distance_vs_atr: input.atr && input.atr > 0 ? Number((risk / input.atr).toFixed(2)) : null,
            measured_trend_bias: bias,
            calibration: input.calibration ?? null,
            ...(input.conflictFlags && input.conflictFlags.length > 0
                ? { conflict_flags: input.conflictFlags.map(f => ({ id: f.id, severity: f.severity, label: f.label, detail: f.detail })) }
                : {}),
        });
        const adversaryEffort = resolveComposerEffort(input.effort, 'adversary');
        const raw = await Promise.race([
            seat.complete(packet, ADVERSARY_SYSTEM, { maxTokens: 320, temperature: 0.1, reasoningEffort: adversaryEffort }),
            new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('adversary timeout')), ADVERSARY_TIMEOUT_MS); }),
        ]);
        return parseAdversaryJson(raw, fallback);
    } catch {
        // Timeout or transport failure: UNAVAILABLE, per the contract — the
        // plan proceeds exactly as it would have without the reviewer, and
        // the card says so instead of carrying a verdict nobody produced.
        return { verdict: 'UNAVAILABLE', objections: [], invalidationCheck: '', at: Date.now() };
    }
};
