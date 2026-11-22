/**
 * The single definition of a PLANNED risk/reward ratio.
 *
 * This app computed R:R four different ways and showed all of them to the
 * user: nearest-TP ÷ stop (analysisUtils), `takeProfits[0]` ÷ stop by ARRAY
 * ORDER (proposedTrade), and highest-TP-hit ÷ stop (the old
 * BacktestingService, retired 2026-10-30). The first two disagree whenever the model emits its
 * targets out of order — which it does — so the same trade could read 1.8R on
 * the card and 3.1R in the journal.
 *
 * Planned R:R is now defined once, here: distance to the take-profit CLOSEST
 * to entry, over distance to the stop. That is the "reward if the first target
 * fills" a trader actually quotes, and it is deliberately independent of array
 * order.
 *
 * The realized ratio in `outcomeEngine.ts` (`realizedRFromPrices`) is a
 * DIFFERENT quantity (which target the market actually reached) and must not
 * be routed through here.
 */

import { sanitizeLevelOrdering } from './levelOrder';

const finiteOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Nearest-to-entry target, or null when none is usable. */
export const firstTargetDistance = (
    entry: number,
    takeProfits: Array<number | null | undefined>,
): number | null => {
    const distances = takeProfits
        .map(finiteOrNull)
        .filter((tp): tp is number => tp !== null && tp > 0)
        .map(tp => Math.abs(tp - entry))
        .filter(d => d > 0);
    return distances.length > 0 ? Math.min(...distances) : null;
};

/**
 * The take-profit NEAREST the entry — the target whose distance the planned
 * R:R is measured against. `null` when there is no usable target (a target
 * sitting exactly ON the entry is zero reward, so it is not a target).
 *
 * This is the SELECTION half of `plannedRiskReward`, exposed because the
 * direction-aware variant below needs the target itself, not just its
 * distance: a signed ratio has to know which side of the entry it sits on.
 */
export const nearestTargetPrice = (
    entry: number,
    takeProfits: Array<number | null | undefined>,
): number | null => {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const raw of takeProfits) {
        const tp = finiteOrNull(raw);
        // A price must be positive: a finite -5 used to read as a 105-point
        // reward on a Short and quote a fictitious 52.5:1 to every caller.
        if (tp === null || tp <= 0) continue;
        const distance = Math.abs(tp - entry);
        if (distance <= 0 || distance >= bestDistance) continue;
        bestDistance = distance;
        best = tp;
    }
    return best;
};

/**
 * The targets in the order a trader would take them: nearest first. Missing,
 * zero-distance and duplicate levels are dropped. Used by consumers that label
 * targets TP1/TP2/TP3 — array order is not that order.
 */
export const targetsByDistance = (
    entry: unknown,
    takeProfits: Array<number | null | undefined>,
): number[] => {
    const e = finiteOrNull(entry);
    if (e === null) return [];
    const seen = new Set<number>();
    return takeProfits
        .map(finiteOrNull)
        .filter((tp): tp is number => tp !== null)
        .filter(tp => Math.abs(tp - e) > 0)
        .filter(tp => { if (seen.has(tp)) return false; seen.add(tp); return true; })
        .sort((a, b) => Math.abs(a - e) - Math.abs(b - e));
};

export interface RiskRewardInput {
    entry: unknown;
    stopLoss: unknown;
    takeProfits: Array<number | null | undefined>;
}

/**
 * Planned reward:risk, rounded to 2 decimals. Returns 0 — never NaN, never a
 * negative — when the levels are missing, equal, or have no usable target, so
 * callers can keep using `0` as "not computable" the way the gate clamps
 * already do.
 */
export const plannedRiskReward = (input: RiskRewardInput): number => {
    const entry = finiteOrNull(input.entry);
    const stop = finiteOrNull(input.stopLoss);
    if (entry === null || stop === null) return 0;

    const risk = Math.abs(entry - stop);
    if (risk <= 0) return 0;

    const reward = firstTargetDistance(entry, input.takeProfits);
    if (reward === null) return 0;

    return Math.round((reward / risk) * 100) / 100;
};

/** The direction the plan is stated in. Only a tradeable direction can carry
 *  a signed R:R — a Neutral plan has no side to sign the distances with. */
export type PlannedRiskDirection = 'Long' | 'Short';

export interface SignedPlannedRiskReward {
    /**
     * The planned R:R — the SAME number `plannedRiskReward` returns, rounded
     * the same way — or `0` when the plan is inverted or not computable.
     * Never negative: a plan that cannot be measured is `0` ("not
     * computable"), never a negative ratio that reads like a real figure.
     */
    ratio: number;
    /** |entry − stop| — the risk distance, a magnitude. */
    risk: number;
    /** |nearest target − entry| — the reward distance, a magnitude. */
    reward: number;
    /**
     * True when the plan's levels contradict the stated direction — the stop
     * is not on the risk side, or the nearest target is not on the reward
     * side. Such a plan is REFUSED, not repaired: the mirror the ordering gate
     * describes is a repair, and a gate that silently repaired would grade a
     * plan the trader never stated.
     */
    inverted: boolean;
    /** True when the (chosen) levels were already correctly ordered. */
    orderingValid: boolean;
    /** The ordering gate's repair descriptions — empty when it was valid. */
    fixes: string[];
}

/**
 * The DIRECTION-AWARE form of the planned R:R.
 *
 * `plannedRiskReward` is magnitude-based: reward ÷ |entry − stop|, always
 * positive, and it deliberately ignores which side of the entry each level
 * sits on. The validation gate needs more than that — it must REFUSE a plan
 * whose stop (or whose nearest target) sits on the wrong side of the entry,
 * and a `Math.abs` used to hide exactly that (audit finding F-11: the gate
 * scored R:R from `takeProfits[0]` while the card and the journal quoted the
 * NEAREST target, so one plan could read 1.8R on the card and 3.1R in the
 * gate).
 *
 * So the sign is kept here, ONCE, and the two callers that need it — the
 * validation gate and the scalp/swing validators — read it from here instead
 * of each re-deriving it. The two are NOT merged: `plannedRiskReward` stays
 * magnitude-based for the card and the journal, and this variant adds the
 * direction the gate needs.
 *
 * **The target selection is the canonical one** — the take-profit nearest the
 * entry, independent of array order — so for a plan that is not inverted the
 * `ratio` here and `plannedRiskReward` are the SAME number to the last digit.
 * That equality is the point: one formula, two views.
 */
export const plannedRiskRewardSigned = (input: {
    entry: number;
    stopLoss: number;
    takeProfits: Array<number | null | undefined>;
    direction: PlannedRiskDirection;
}): SignedPlannedRiskReward => {
    const entry = finiteOrNull(input.entry);
    const stop = finiteOrNull(input.stopLoss);
    const blank: SignedPlannedRiskReward = {
        ratio: 0, risk: 0, reward: 0, inverted: false, orderingValid: true, fixes: [],
    };
    if (entry === null || stop === null) return blank;

    const usable = input.takeProfits
        .map(finiteOrNull)
        .filter((tp): tp is number => tp !== null && tp > 0);
    // The canonical selection: the target NEAREST the entry.
    const target = nearestTargetPrice(entry, usable);
    const isLong = input.direction === 'Long';

    // Signed distances. A negative risk means the STOP is on the wrong side of
    // the entry; a negative reward means the nearest TARGET is.
    const risk = isLong ? entry - stop : stop - entry;
    const reward = target === null ? 0 : (isLong ? target - entry : entry - target);
    const riskMagnitude = Math.abs(risk);
    const rewardMagnitude = Math.abs(reward);

    // The shared ordering gate (`utils/levelOrder`) is the ONE rule source for
    // "is this plan's geometry possible". It is asked about the CHOSEN target
    // only: asking it about the whole ladder would report a re-sort for a
    // model that listed its targets farthest-first, and REFUSING a plan for
    // the ORDER of its targets is precisely the failure this change exists to
    // end. When there is no usable target at all the raw list is passed, so a
    // degenerate target (sitting exactly on the entry) is still described.
    const order = sanitizeLevelOrdering(
        input.direction,
        entry,
        stop,
        target === null ? usable : [target],
    );
    const inverted = !order.ok;

    const ratio = !inverted && riskMagnitude > 0 && rewardMagnitude > 0
        ? Math.round((rewardMagnitude / riskMagnitude) * 100) / 100
        : 0;

    return {
        ratio,
        risk: riskMagnitude,
        reward: rewardMagnitude,
        inverted,
        orderingValid: order.ok,
        fixes: order.fixes,
    };
};

/** Same input, expressed as the raw price distances the ticket needs. */
export const riskRewardDistances = (input: {
    entry: number;
    stopLoss: number;
    takeProfits: Array<number | null | undefined>;
}): { risk: number; reward: number; ratio: number } => {
    const risk = Math.abs(input.entry - input.stopLoss);
    const reward = firstTargetDistance(input.entry, input.takeProfits) ?? 0;
    return {
        risk,
        reward,
        ratio: risk > 0 && reward > 0 ? Math.round((reward / risk) * 100) / 100 : 0,
    };
};

/**
 * The ONE display shape for a planned ratio: `2.4:1`, REWARD FIRST, always
 * over one unit of risk.
 *
 * Before this, the same number reached the trader three ways — `1:2.0` and
 * `R:R: 1:2` (risk-first, which reads as "one unit of reward for two of risk"
 * to anyone skimming) against `2.00:1` (reward-first). Order is the whole
 * meaning of a ratio, so it now lives in one function.
 *
 * `digits` is a required argument, as in `fmtPercent`: the shape is canonical,
 * the precision belongs to the surface. A canvas chip quotes `3.0:1`, the
 * verdict markdown quotes `1.37:1` because that is what `plannedRiskReward`
 * actually computed, and neither should be re-rounded to fit the other.
 */
export const fmtRiskReward = (ratio: number, digits: number): string =>
    Number.isFinite(ratio) ? `${ratio.toFixed(digits)}:1` : '—';

/**
 * The REALIZED multiple — `avg R 1.80` — which is a different quantity from
 * the planned ratio above (the outcome engine asks which target the market
 * actually reached; this module asks what the ticket promised). It deliberately
 * has no `:1` suffix: a multiple of risk is not a ratio of two prices, and
 * printing it as one is how the two got confused in the first place.
 */
export const fmtRMultiple = (r: number): string =>
    Number.isFinite(r) ? r.toFixed(2) : '—';
