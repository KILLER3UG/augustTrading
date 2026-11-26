/**
 * positionHandleCore — pure, DOM-free math for:
 *  1. Smart Long/Short Position Box readouts (Net R:R after fees, Risk $,
 *     Qty, Notional, Margin, Isolated Liq buffer %).
 *  2. Deterministic paper handle ID parsing (`paper:<posId>:sl`,
 *     `paper:<posId>:tp:<idx>`) and live drag preview (`$ PnL`, `R-multiple`).
 *  3. Live pre-approval AI plan line drag recalculation (`TradeProposal` +
 *     deterministic `proposal.math` sync with geometry guard).
 *
 * Zero React, DOM, `window`, `localStorage`, or network imports (`check:boundaries`).
 */

import type { DrawPoint } from './chartDrawings';
import { computePositionBoxMetrics, type PositionBoxKind } from './positionBoxMath';
import type { TradeProposal } from './proposedTrade';
import { roundTripCostR, stopDistancePercent } from '../../utils/netRiskReward';
import { isolatedLiquidationPrice, type PaperPosition } from '../paper/paperCore';

export interface PositionBoxSizing {
    equityUsd: number;
    riskPercent: number;
    leverage: number;
    takerFeeBps?: number;
}

export interface PositionBoxReadout {
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskPct: number;
    rewardPct: number;
    grossRR: number;
    netRR: number;
    costR: number;
    riskUsd: number | null;
    qty: number | null;
    notionalUsd: number | null;
    marginUsd: number | null;
    liquidationPrice: number | null;
    liqBufferPct: number | null;
    inverted: boolean;
    canvasBadge: string;
}

const fmtNum = (n: number, dp = 2): string => {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(dp);
};

const fmtQtyCompact = (qty: number): string => {
    if (!Number.isFinite(qty) || qty <= 0) return '0';
    if (qty >= 100) return qty.toFixed(1);
    if (qty >= 1) return qty.toFixed(3);
    return qty.toFixed(4);
};

const fmtUsdCompact = (usd: number): string => {
    if (!Number.isFinite(usd)) return '$0';
    const abs = Math.abs(usd);
    const sign = usd < 0 ? '-' : '';
    if (abs >= 1000) return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    return `${sign}$${abs.toFixed(0)}`;
};

const sizeForStop = (
    entry: number,
    stopLoss: number,
    equityUsd: number,
    riskPercent: number,
    leverage: number,
): { riskUsd: number; qty: number; notionalUsd: number; marginUsd: number; leverageNeeded: number } | null => {
    const dist = Math.abs(entry - stopLoss);
    if (!(equityUsd > 0) || !(riskPercent > 0) || !(dist > 0) || !(entry > 0)) return null;
    const riskUsd = equityUsd * (riskPercent / 100);
    const qty = riskUsd / dist;
    const notionalUsd = qty * entry;
    const safeLev = Math.max(1, Math.min(125, Math.round(leverage)));
    const marginUsd = notionalUsd / safeLev;
    const leverageNeeded = equityUsd > 0 ? notionalUsd / equityUsd : 0;
    return { riskUsd, qty, notionalUsd, marginUsd, leverageNeeded };
};

/**
 * Compute full tabular risk/size/liquidation readout for a Long/Short Position
 * drawing box using the app's canonical `computePositionBoxMetrics`,
 * `roundTripCostR`, and `isolatedLiquidationPrice`.
 */
export const computePositionBoxReadout = (
    kind: PositionBoxKind,
    points: ReadonlyArray<DrawPoint>,
    sizing?: PositionBoxSizing | null,
): PositionBoxReadout | null => {
    const metrics = computePositionBoxMetrics(kind, points);
    if (!metrics) return null;

    const direction: 'Long' | 'Short' = kind === 'long_position' ? 'Long' : 'Short';
    const side = direction === 'Long' ? 'long' : 'short';
    const feeBps = sizing?.takerFeeBps ?? 5;
    const stopDistPct = stopDistancePercent(metrics.entry, metrics.stopLoss);
    const costRes = roundTripCostR({ stopDistancePct: stopDistPct, feeBpsPerSide: feeBps });
    const costR = costRes.known && costRes.costR !== null ? costRes.costR : 0;
    const grossRR = metrics.inverted ? 0 : metrics.ratio;
    const netRR = metrics.inverted ? 0 : Math.max(0, grossRR - costR);

    const equityUsd = sizing?.equityUsd ?? 0;
    const riskPercent = sizing?.riskPercent ?? 1;
    const leverage = Math.max(1, Math.round(sizing?.leverage ?? 10));

    const sized = equityUsd > 0 && !metrics.inverted
        ? sizeForStop(metrics.entry, metrics.stopLoss, equityUsd, riskPercent, leverage)
        : null;

    const liqPrice = !metrics.inverted
        ? isolatedLiquidationPrice(metrics.entry, side, leverage)
        : null;
    const liqBufferPct = liqPrice !== null && metrics.entry > 0
        ? (Math.abs(metrics.entry - liqPrice) / metrics.entry) * 100
        : null;

    const dirTag = direction === 'Long' ? 'LONG' : 'SHORT';
    let canvasBadge: string;
    if (metrics.inverted) {
        canvasBadge = `${dirTag}  INVERTED · Target +${fmtNum(metrics.rewardPct)}% · Stop -${fmtNum(metrics.riskPct)}%`;
    } else if (sized) {
        const liqPart = liqBufferPct !== null ? ` · Liq ${fmtNum(liqBufferPct, 1)}%` : '';
        canvasBadge = `${dirTag}  Net ${fmtNum(netRR)}R · Risk ${fmtUsdCompact(sized.riskUsd)} · Qty ${fmtQtyCompact(sized.qty)}${liqPart}`;
    } else {
        canvasBadge = `${dirTag}  Net ${fmtNum(netRR)}R · Target +${fmtNum(metrics.rewardPct)}% · Stop -${fmtNum(metrics.riskPct)}%`;
    }

    return {
        direction,
        entry: metrics.entry,
        stopLoss: metrics.stopLoss,
        takeProfit: metrics.takeProfit,
        riskPct: metrics.riskPct,
        rewardPct: metrics.rewardPct,
        grossRR,
        netRR,
        costR,
        riskUsd: sized ? sized.riskUsd : null,
        qty: sized ? sized.qty : null,
        notionalUsd: sized ? sized.notionalUsd : null,
        marginUsd: sized ? sized.marginUsd : null,
        liquidationPrice: liqPrice,
        liqBufferPct,
        inverted: metrics.inverted,
        canvasBadge,
    };
};

export type PaperHandleTarget =
    | { positionId: string; kind: 'sl' }
    | { positionId: string; kind: 'tp'; tpIndex: number };

/** Deterministic paper handle drawing id builders shared with `drawingsPrimitive`. */
export const paperEntryDrawingId = (positionId: string): string => `paper:${positionId}:entry`;
export const paperSlDrawingId = (positionId: string): string => `paper:${positionId}:sl`;
export const paperTpDrawingId = (positionId: string, tpIndex: number): string => `paper:${positionId}:tp:${tpIndex}`;
export const paperLimitDrawingId = (orderId: string): string => `paper:${orderId}:limit`;

/** Parse a draggable paper SL/TP drawing id; returns null for non-draggable lines (entry/limit/user/agent). */
export const parsePaperHandleId = (drawingId: string): PaperHandleTarget | null => {
    if (!drawingId.startsWith('paper:')) return null;
    const parts = drawingId.split(':');
    if (parts.length === 3 && parts[2] === 'sl' && parts[1]) {
        return { positionId: parts[1], kind: 'sl' };
    }
    if (parts.length === 4 && parts[2] === 'tp' && parts[1]) {
        const idx = Number(parts[3]);
        if (Number.isInteger(idx) && idx >= 0) {
            return { positionId: parts[1], kind: 'tp', tpIndex: idx };
        }
    }
    return null;
};

export interface PaperHandlePreview {
    valid: boolean;
    reason?: string;
    label: string;
    candidatePrice: number;
    pnlUsd: number;
    rMultiple: number;
    pillText: string;
}

const fmtSignedDollar = (v: number): string => {
    const sign = v >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtSignedR = (r: number): string => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

/**
 * Pure rAF preview calculator while dragging an open paper position's SL or TP line.
 */
export const computePaperHandlePreview = (input: {
    position: Pick<PaperPosition, 'side' | 'entryPrice' | 'stopLoss' | 'takeProfits' | 'qty' | 'riskUsd'>;
    target: PaperHandleTarget;
    candidatePrice: number;
}): PaperHandlePreview => {
    const { position, target, candidatePrice } = input;
    const label = target.kind === 'sl' ? 'SL' : `TP${target.tpIndex + 1}`;

    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
        return {
            valid: false,
            reason: 'invalid_price',
            label,
            candidatePrice,
            pnlUsd: 0,
            rMultiple: 0,
            pillText: `${label} · invalid price`,
        };
    }

    const isLong = position.side === 'long';
    if (target.kind === 'sl') {
        const crosses = isLong ? candidatePrice >= position.entryPrice : candidatePrice <= position.entryPrice;
        if (crosses) {
            return {
                valid: false,
                reason: 'sl_crosses_entry',
                label,
                candidatePrice,
                pnlUsd: 0,
                rMultiple: 0,
                pillText: `${label} · invalid (crosses entry)`,
            };
        }
    } else {
        const crosses = isLong ? candidatePrice <= position.entryPrice : candidatePrice >= position.entryPrice;
        if (crosses) {
            return {
                valid: false,
                reason: 'tp_crosses_entry',
                label,
                candidatePrice,
                pnlUsd: 0,
                rMultiple: 0,
                pillText: `${label} · invalid (wrong side of entry)`,
            };
        }
    }

    const pnlUsd = isLong
        ? (candidatePrice - position.entryPrice) * position.qty
        : (position.entryPrice - candidatePrice) * position.qty;
    const origRisk = position.riskUsd > 0
        ? position.riskUsd
        : Math.abs(position.entryPrice - position.stopLoss) * position.qty;
    const rMultiple = origRisk > 0 ? pnlUsd / origRisk : 0;

    return {
        valid: true,
        label,
        candidatePrice,
        pnlUsd,
        rMultiple,
        pillText: `${label} · ${fmtSignedR(rMultiple)} · ${fmtSignedDollar(pnlUsd)}`,
    };
};

export type AiPlanLevelKind = 'entry' | 'sl' | 'tp1' | 'tp2' | 'tp3';

/** Classify an agent horizontal line's label (`Entry`, `SL`, `TP1`..`TP3`). */
export const classifyAiPlanLevelLabel = (label?: string): AiPlanLevelKind | null => {
    if (!label) return null;
    const norm = label.trim().toLowerCase().replace(/^ai\s*[·:-]\s*/i, '');
    if (/^entry\b/.test(norm)) return 'entry';
    if (/^(sl|stop|stop\s*loss|invalidation)\b/.test(norm)) return 'sl';
    if (/^tp\s*3\b/.test(norm)) return 'tp3';
    if (/^tp\s*2\b/.test(norm)) return 'tp2';
    if (/^(tp|tp\s*1|target|target\s*1)\b/.test(norm)) return 'tp1';
    return null;
};

export interface AiProposalDragResult {
    ok: boolean;
    proposal?: TradeProposal;
    reason?: string;
}

/**
 * Apply a dragged AI horizontal line price to an unapproved `TradeProposal`
 * and recompute its deterministic `proposal.math`. Returns `{ ok: false }`
 * without mutating if the dragged level would invert Long/Short geometry.
 */
export const applyAiLevelDragToProposal = (
    proposal: TradeProposal,
    levelKind: AiPlanLevelKind,
    newPrice: number,
    sizing?: PositionBoxSizing | null,
): AiProposalDragResult => {
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
        return { ok: false, reason: 'Price must be positive' };
    }
    let entry = proposal.entry;
    let stopLoss = proposal.stopLoss;
    const takeProfits = [...proposal.takeProfits];

    if (levelKind === 'entry') {
        entry = newPrice;
    } else if (levelKind === 'sl') {
        stopLoss = newPrice;
    } else {
        const idx = levelKind === 'tp1' ? 0 : levelKind === 'tp2' ? 1 : 2;
        while (takeProfits.length <= idx) takeProfits.push(newPrice);
        takeProfits[idx] = newPrice;
    }

    const isLong = proposal.direction === 'Long';
    if (isLong && stopLoss >= entry) {
        return { ok: false, reason: 'Long SL must remain below Entry' };
    }
    if (!isLong && stopLoss <= entry) {
        return { ok: false, reason: 'Short SL must remain above Entry' };
    }
    const tp1 = takeProfits[0];
    if (tp1 !== undefined) {
        if (isLong && tp1 <= entry) {
            return { ok: false, reason: 'Long TP1 must remain above Entry' };
        }
        if (!isLong && tp1 >= entry) {
            return { ok: false, reason: 'Short TP1 must remain below Entry' };
        }
    }

    const riskDist = Math.abs(entry - stopLoss);
    const rewardDist = tp1 !== undefined ? Math.abs(tp1 - entry) : 0;
    const grossRatio = riskDist > 0 ? rewardDist / riskDist : 0;
    const feeBps = sizing?.takerFeeBps ?? 5;
    const stopDistPct = stopDistancePercent(entry, stopLoss);
    const costRes = roundTripCostR({ stopDistancePct: stopDistPct, feeBpsPerSide: feeBps });
    const costR = costRes.known && costRes.costR !== null ? costRes.costR : null;
    const netRewardR = costR !== null ? Math.max(0, grossRatio - costR) : grossRatio;
    const breakEvenWinRatePct = netRewardR > 0 ? (1 / (1 + netRewardR)) * 100 : 100;

    const prevMath = proposal.math;
    const equityUsd = sizing?.equityUsd ?? 0;
    const riskPercent = sizing?.riskPercent ?? 1;
    const leverage = Math.max(1, Math.round(sizing?.leverage ?? 10));
    const sized = equityUsd > 0
        ? sizeForStop(entry, stopLoss, equityUsd, riskPercent, leverage)
        : null;
    const liqPrice = isolatedLiquidationPrice(entry, isLong ? 'long' : 'short', leverage);

    const updated: TradeProposal = {
        ...proposal,
        entry,
        stopLoss,
        takeProfits,
        math: {
            grossRatio,
            netRewardR,
            costR,
            breakEvenWinRatePct,
            riskUsd: sized ? sized.riskUsd : (prevMath?.riskUsd ?? null),
            qty: sized ? sized.qty : (prevMath?.qty ?? null),
            notionalUsd: sized ? sized.notionalUsd : (prevMath?.notionalUsd ?? null),
            leverageNeeded: sized ? sized.leverageNeeded : (prevMath?.leverageNeeded ?? null),
            liquidationPrice: liqPrice,
            liquidationDistanceAtr: prevMath?.liquidationDistanceAtr ?? null,
            fundingDragR: prevMath?.fundingDragR ?? null,
            fundingRate: prevMath?.fundingRate ?? null,
            fundingIntervalHours: prevMath?.fundingIntervalHours ?? null,
            inverted: false,
        },
    };

    return { ok: true, proposal: updated };
};

/** Format a crisp one-line prompt for the `Audit with August` position box button. */
export const buildPositionBoxAuditPrompt = (
    symbol: string,
    readout: PositionBoxReadout,
    shortId?: string,
): string => {
    const tag = shortId ? `${shortId} ` : '';
    const riskPart = readout.riskUsd !== null && readout.qty !== null
        ? `, Risk ${fmtUsdCompact(readout.riskUsd)}, Qty ${fmtQtyCompact(readout.qty)}`
        : '';
    return `Audit ${tag}${symbol} ${readout.direction} position: Entry ${readout.entry.toFixed(2)}, SL ${readout.stopLoss.toFixed(2)}, TP ${readout.takeProfit.toFixed(2)} (Net ${readout.netRR.toFixed(2)}R${riskPart}). Check structure, liquidity, and invalidation.`;
};
