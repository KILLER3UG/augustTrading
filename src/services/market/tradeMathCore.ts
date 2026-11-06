/**
 * tradeMathCore — the trade's arithmetic as a tool, pure math.
 *
 * It COMPOSES the canonical modules instead of re-deriving them: the planned
 * R:R is `utils/riskReward.plannedRiskRewardSigned` (nearest target,
 * direction-aware, refuses an inverted plan), the costs are
 * `utils/netRiskReward.roundTripCostR` (taker bps, slippage explicitly NOT
 * modeled), the break-even is `utils/netRiskReward.breakEvenWinRate`. A
 * second cost model here is exactly how the card and the journal drifted
 * apart once already.
 *
 * Sizing is ATR-aware: risk% of equity ÷ stop distance. The liquidation
 * price uses the isolated-margin approximation (1/leverage, maintenance
 * margin ignored) — the SAME approximation `utils/ticketSize.computeLiquidationBuffer`
 * documents — and is labelled as an estimate with the model named.
 */

import { plannedRiskRewardSigned, type PlannedRiskDirection } from '../../utils/riskReward';
import { roundTripCostR, breakEvenWinRate, FEE_TAKER_BPS } from '../../utils/netRiskReward';
import type { Kline } from '../../types/message';
import { currentAtr } from './regimeCore';

export interface TradeMathInput {
    direction: PlannedRiskDirection;
    entry: number;
    stopLoss: number;
    takeProfits: Array<number | null | undefined>;
    equityUsd?: number;
    /** Risk as a percent of equity (default 1). */
    riskPercent?: number;
    /** Leverage for the liquidation estimate (default 10). */
    leverage?: number;
}

export interface TradeMathRead {
    gross: {
        ratio: number;
        risk: number;
        reward: number;
        inverted: boolean;
    };
    costs: {
        costR: number | null;
        /** Net reward at the nearest target, in R (gross − cost). */
        netRewardR: number | null;
        breakEvenWinRatePct: number | null;
        slippageModeled: false;
    };
    sizing: {
        available: boolean;
        reason?: string;
        riskUsd?: number;
        qty?: number;
        notionalUsd?: number;
        /** Notional ÷ equity — the leverage the size actually needs. */
        leverageNeeded?: number;
    };
    liquidation: {
        price: number;
        model: string;
        /** |entry − liquidation| in ATR units (null when ATR unavailable). */
        distanceAtr: number | null;
        estimate: true;
    } | null;
    atr: number | null;
}

export const computeTradeMath = (input: TradeMathInput, candles: Kline[]): TradeMathRead | null => {
    const { entry, stopLoss } = input;
    if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0 || stopLoss <= 0) return null;

    const signed = plannedRiskRewardSigned({
        entry, stopLoss, takeProfits: input.takeProfits, direction: input.direction,
    });
    const stopDistancePct = (Math.abs(entry - stopLoss) / entry) * 100;
    const cost = roundTripCostR({ stopDistancePct });
    // Net reward at the nearest target: gross reward in R minus the cost.
    const grossRewardR = signed.risk > 0 ? signed.reward / signed.risk : 0;
    const netRewardR = cost.known ? Math.round((grossRewardR - (cost.costR as number)) * 10000) / 10000 : null;
    const breakEven = breakEvenWinRate({ rewardRatio: signed.ratio, costR: cost.costR });

    const atr = currentAtr(candles);

    // Sizing: risk% of equity over the stop distance.
    const equity = input.equityUsd;
    const riskPct = input.riskPercent ?? 1;
    let sizing: TradeMathRead['sizing'];
    if (typeof equity !== 'number' || !Number.isFinite(equity) || equity <= 0) {
        sizing = { available: false, reason: 'equity not provided — sizing needs an equity number, never a default' };
    } else if (!(stopDistancePct > 0)) {
        sizing = { available: false, reason: 'stop distance not measurable' };
    } else {
        const riskUsd = equity * (riskPct / 100);
        const qty = riskUsd / Math.abs(entry - stopLoss);
        const notionalUsd = qty * entry;
        sizing = {
            available: true,
            riskUsd: Math.round(riskUsd * 100) / 100,
            qty: Number(qty.toPrecision(6)),
            notionalUsd: Math.round(notionalUsd * 100) / 100,
            leverageNeeded: equity > 0 ? Math.round((notionalUsd / equity) * 100) / 100 : undefined,
        };
    }

    // Liquidation: the isolated approximation, named. MMR ignored — the same
    // stated limit computeLiquidationBuffer documents.
    let liquidation: TradeMathRead['liquidation'] = null;
    const leverage = input.leverage ?? 10;
    if (leverage > 0) {
        const isLong = input.direction === 'Long';
        const liq = isLong
            ? entry * (1 - 1 / leverage)
            : entry * (1 + 1 / leverage);
        liquidation = {
            price: Number(liq.toPrecision(8)),
            model: `isolated-margin approximation (1/${leverage}, maintenance margin ignored)`,
            distanceAtr: atr && atr > 0 ? Number((Math.abs(entry - liq) / atr).toPrecision(4)) : null,
            estimate: true,
        };
    }

    return {
        gross: {
            ratio: signed.ratio,
            risk: signed.risk,
            reward: signed.reward,
            inverted: signed.inverted,
        },
        costs: {
            costR: cost.costR,
            netRewardR,
            breakEvenWinRatePct: breakEven,
            slippageModeled: false,
        },
        sizing,
        liquidation,
        atr,
    };
};

/** The fee tier the cost line quotes, echoed for the tool output. */
export const feeTierBps = FEE_TAKER_BPS;
