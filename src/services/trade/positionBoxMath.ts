/**
 * positionBoxMath — canonical geometry & risk/reward calculations for
 * interactive Long Position (`long_position`) and Short Position (`short_position`)
 * chart boxes.
 *
 * Anchor layout (3 DrawPoints):
 *   points[0] = Entry  { t: leftTime,  p: entryPrice }
 *   points[1] = Stop   { t: rightTime, p: stopLossPrice }
 *   points[2] = Target { t: rightTime, p: takeProfitPrice }
 *
 * All R:R math delegates exclusively to `plannedRiskRewardSigned` and
 * `fmtRiskReward` from `src/utils/riskReward.ts` (zero ad-hoc formulas).
 */

import {
    fmtRiskReward,
    plannedRiskRewardSigned,
    type PlannedRiskDirection,
} from '../../utils/riskReward';
import type { DrawPoint } from './chartDrawings';

export type PositionBoxKind = 'long_position' | 'short_position';

export interface PositionBoxMetrics {
    direction: PlannedRiskDirection;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    risk: number;
    reward: number;
    riskPct: number;
    rewardPct: number;
    ratio: number;
    formattedRR: string;
    inverted: boolean;
    fixes: string[];
}

export const isPositionBoxKind = (kind: string): kind is PositionBoxKind =>
    kind === 'long_position' || kind === 'short_position';

export const directionForPositionBox = (kind: PositionBoxKind): PlannedRiskDirection =>
    kind === 'long_position' ? 'Long' : 'Short';

/** Compute deterministic signed R:R and percent moves via canonical `plannedRiskRewardSigned`. */
export const computePositionBoxMetrics = (
    kind: PositionBoxKind,
    points: ReadonlyArray<DrawPoint>,
): PositionBoxMetrics | null => {
    if (points.length < 3) return null;
    const entry = points[0].p;
    const stopLoss = points[1].p;
    const takeProfit = points[2].p;
    if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
        return null;
    }
    const direction = directionForPositionBox(kind);
    const signed = plannedRiskRewardSigned({
        entry,
        stopLoss,
        takeProfits: [takeProfit],
        direction,
    });
    const denom = Math.abs(entry) > 0 ? Math.abs(entry) : 1;
    const riskPct = (signed.risk / denom) * 100;
    const rewardPct = (signed.reward / denom) * 100;
    return {
        direction,
        entry,
        stopLoss,
        takeProfit,
        risk: signed.risk,
        reward: signed.reward,
        riskPct,
        rewardPct,
        ratio: signed.ratio,
        formattedRR: signed.inverted || signed.ratio <= 0 ? 'INV' : fmtRiskReward(signed.ratio, 2),
        inverted: signed.inverted,
        fixes: signed.fixes,
    };
};

/** Ensure the right edge timestamps of SL (`points[1]`) and TP (`points[2]`)
 *  stay synchronized so the profit and risk boxes remain aligned horizontally. */
export const syncPositionBoxRightEdge = (points: ReadonlyArray<DrawPoint>): DrawPoint[] => {
    if (points.length < 3) return points.map(p => ({ ...p }));
    const [entry, sl, tp] = points;
    const rightT = Math.max(sl.t, tp.t);
    return [
        { t: entry.t, p: entry.p },
        { t: rightT, p: sl.p },
        { t: rightT, p: tp.p },
    ];
};

/** Seed a sensible initial 1:2 R:R position box from an entry anchor, a right-edge
 *  timestamp, and a risk distance (e.g. `1.0 * ATR(14)` or 1% of price). */
export const seedPositionBoxPoints = (
    kind: PositionBoxKind,
    entryAnchor: DrawPoint,
    rightEdgeTime: number,
    riskDistance: number,
    targetMultiple = 2,
): [DrawPoint, DrawPoint, DrawPoint] => {
    const safeRisk = Number.isFinite(riskDistance) && riskDistance > 0
        ? riskDistance
        : Math.max(Math.abs(entryAnchor.p) * 0.008, 1e-6);
    const mult = Number.isFinite(targetMultiple) && targetMultiple > 0 ? targetMultiple : 2;
    const isLong = kind === 'long_position';
    const slPrice = isLong ? Math.max(1e-8, entryAnchor.p - safeRisk) : entryAnchor.p + safeRisk;
    const tpPrice = isLong ? entryAnchor.p + safeRisk * mult : Math.max(1e-8, entryAnchor.p - safeRisk * mult);
    const rightT = rightEdgeTime !== entryAnchor.t ? rightEdgeTime : entryAnchor.t + 1;
    return [
        { t: entryAnchor.t, p: entryAnchor.p },
        { t: rightT, p: slPrice },
        { t: rightT, p: tpPrice },
    ];
};

/**
 * Update one handle of a position box during interactive drag:
 *  - handle 0 (Entry): moves entry price + left edge time.
 *  - handle 1 (SL): moves SL price AND synchronizes right edge time for both SL and TP.
 *  - handle 2 (TP): moves TP price AND synchronizes right edge time for both SL and TP.
 */
export const updatePositionBoxHandle = (
    points: ReadonlyArray<DrawPoint>,
    handleIndex: number,
    nextPoint: DrawPoint,
): DrawPoint[] => {
    if (points.length < 3) return points.map(p => ({ ...p }));
    const next: [DrawPoint, DrawPoint, DrawPoint] = [
        { t: points[0].t, p: points[0].p },
        { t: points[1].t, p: points[1].p },
        { t: points[2].t, p: points[2].p },
    ];
    if (handleIndex === 0) {
        next[0] = { t: nextPoint.t, p: nextPoint.p };
    } else if (handleIndex === 1) {
        next[1] = { t: nextPoint.t, p: nextPoint.p };
        next[2] = { t: nextPoint.t, p: next[2].p };
    } else if (handleIndex === 2) {
        next[2] = { t: nextPoint.t, p: nextPoint.p };
        next[1] = { t: nextPoint.t, p: next[1].p };
    }
    return next;
};
