/**
 * paperExecution — explicit simulated fill model and stats-isolation gate for
 * the Paper Execution Lane (Phase 6).
 *
 * August places no real orders, holds no exchange keys, and touches no live
 * account. When a trader approves a trade proposal in the paper lane, the
 * harness tracks it over live market prices using existing `positionTracker`,
 * `journalTracking`, and `journalOutcomeBridge` machinery, stamping
 * `simulated: true` and explicit fill assumptions (`feeBps`, `spreadBps`,
 * `slippageBps`, and `gap_open` fills) onto the proposal, tracked position,
 * and journal row.
 *
 * Simulated rows are strictly isolated from real performance statistics by
 * default (`filterTradesBySimulationMode(trades, 'real')`) so paper experiments
 * never contaminate real win-rate, expectancy, or calibration numbers.
 */

export interface PaperFillAssumptions {
    /** Per-side taker/maker fee in basis points (e.g. 5 bps = 0.05% per leg). */
    feeBps: number;
    /** Full bid-ask spread in basis points (half-spread crossed on market fills). */
    spreadBps: number;
    /** Adverse market-impact / execution slippage in basis points. */
    slippageBps: number;
    /** Gap handling: when a candle opens past a stop or trigger, fill at the gap open. */
    gapFillMode: 'gap_open';
}

export const DEFAULT_PAPER_FILL_ASSUMPTIONS: PaperFillAssumptions = {
    feeBps: 5,
    spreadBps: 4,
    slippageBps: 3,
    gapFillMode: 'gap_open',
};

export type SimulationStatsMode = 'real' | 'simulated' | 'all';

export const PAPER_EXECUTION_RECEIPT = 'Simulated — nothing executed on any exchange.';

export interface PaperFillResult {
    fillPrice: number;
    referencePrice: number;
    gapAdjusted: boolean;
    feeBps: number;
    spreadBps: number;
    slippageBps: number;
    /** Total one-way friction in bps (half-spread + slippage + fee). */
    costBpsOneWay: number;
    summary: string;
}

const roundPrice = (n: number): number => {
    if (!Number.isFinite(n)) return 0;
    if (Math.abs(n) >= 100) return Math.round(n * 100) / 100;
    if (Math.abs(n) >= 1) return Math.round(n * 10_000) / 10_000;
    return Number(n.toPrecision(6));
};

const roundR = (n: number): number => Math.round(n * 100) / 100;

export const normalizePaperFillAssumptions = (
    input?: Partial<PaperFillAssumptions> | null,
): PaperFillAssumptions => ({
    feeBps: typeof input?.feeBps === 'number' && Number.isFinite(input.feeBps) && input.feeBps >= 0
        ? input.feeBps
        : DEFAULT_PAPER_FILL_ASSUMPTIONS.feeBps,
    spreadBps: typeof input?.spreadBps === 'number' && Number.isFinite(input.spreadBps) && input.spreadBps >= 0
        ? input.spreadBps
        : DEFAULT_PAPER_FILL_ASSUMPTIONS.spreadBps,
    slippageBps: typeof input?.slippageBps === 'number' && Number.isFinite(input.slippageBps) && input.slippageBps >= 0
        ? input.slippageBps
        : DEFAULT_PAPER_FILL_ASSUMPTIONS.slippageBps,
    gapFillMode: 'gap_open',
});

export const isSimulatedTrade = (
    trade?: { simulated?: boolean; analysis?: { simulated?: boolean } | null } | null,
): boolean => trade?.simulated === true || trade?.analysis?.simulated === true;

export const filterTradesBySimulationMode = <
    T extends { simulated?: boolean; analysis?: { simulated?: boolean } | null },
>(
    trades: readonly T[] | undefined,
    mode: SimulationStatsMode = 'real',
): T[] => {
    const list = trades ?? [];
    if (mode === 'all') return [...list];
    if (mode === 'simulated') return list.filter(t => isSimulatedTrade(t));
    return list.filter(t => !isSimulatedTrade(t));
};

export const countSimulatedTrades = (
    trades: readonly { simulated?: boolean; analysis?: { simulated?: boolean } | null }[] | undefined,
): number => (trades ?? []).filter(t => isSimulatedTrade(t)).length;

export const formatPaperFillAssumptions = (
    assumptions?: Partial<PaperFillAssumptions> | null,
): string => {
    const a = normalizePaperFillAssumptions(assumptions);
    return `Simulated · ${a.feeBps}bps fee/side · ${a.spreadBps}bps spread · ${a.slippageBps}bps slip · gap-open fills`;
};

export const paperStatsExclusionNotice = (simulatedCount: number): string =>
    `Simulated excluded (${Math.max(0, Math.trunc(simulatedCount))})`;

/**
 * Compute the simulated entry fill price, accounting for adverse gap-open,
 * half-spread crossing, and entry slippage.
 */
export const computePaperEntryFill = (input: {
    direction: 'Long' | 'Short';
    referencePrice: number;
    barOpen?: number;
    assumptions?: Partial<PaperFillAssumptions> | null;
}): PaperFillResult => {
    const a = normalizePaperFillAssumptions(input.assumptions);
    const ref = Number(input.referencePrice);
    const isLong = input.direction === 'Long';
    const open = typeof input.barOpen === 'number' && Number.isFinite(input.barOpen) && input.barOpen > 0
        ? input.barOpen
        : undefined;

    // Gap-open: if the bar opens adversely past the trigger/entry, fill from the open.
    const gapAdjusted = open !== undefined && (isLong ? open > ref : open < ref);
    const base = gapAdjusted && open !== undefined ? open : ref;
    const priceFrictionBps = a.spreadBps / 2 + a.slippageBps;
    const slipFactor = priceFrictionBps / 10_000;
    const rawFill = isLong ? base * (1 + slipFactor) : base * (1 - slipFactor);
    const fillPrice = roundPrice(rawFill);
    const costBpsOneWay = priceFrictionBps + a.feeBps;

    return {
        fillPrice,
        referencePrice: ref,
        gapAdjusted,
        feeBps: a.feeBps,
        spreadBps: a.spreadBps,
        slippageBps: a.slippageBps,
        costBpsOneWay,
        summary: `${formatPaperFillAssumptions(a)}${gapAdjusted ? ` · gap-open @ ${roundPrice(base)}` : ''}`,
    };
};

/**
 * Compute the simulated exit fill price.
 * - Stop (`'sl'`) and manual exits cross the spread, suffer slippage, and fill
 *   at the bar open when the bar gaps adversely through the stop level.
 * - Target (`'tp'`) exits fill at the target (or better gap open) with half-spread
 *   and slippage applied only on market/stop exits.
 */
export const computePaperExitFill = (input: {
    direction: 'Long' | 'Short';
    exitKind: 'tp' | 'sl' | 'manual';
    referencePrice: number;
    barOpen?: number;
    assumptions?: Partial<PaperFillAssumptions> | null;
}): PaperFillResult => {
    const a = normalizePaperFillAssumptions(input.assumptions);
    const ref = Number(input.referencePrice);
    const isLong = input.direction === 'Long';
    const open = typeof input.barOpen === 'number' && Number.isFinite(input.barOpen) && input.barOpen > 0
        ? input.barOpen
        : undefined;

    let gapAdjusted = false;
    let base = ref;
    if (input.exitKind === 'sl' || input.exitKind === 'manual') {
        if (open !== undefined && (isLong ? open < ref : open > ref)) {
            base = open;
            gapAdjusted = true;
        }
    } else if (input.exitKind === 'tp') {
        if (open !== undefined && (isLong ? open > ref : open < ref)) {
            base = open;
            gapAdjusted = true;
        }
    }

    const priceFrictionBps = input.exitKind === 'tp' ? 0 : (a.spreadBps / 2 + a.slippageBps);
    const slipFactor = priceFrictionBps / 10_000;
    const rawFill = isLong ? base * (1 - slipFactor) : base * (1 + slipFactor);
    const fillPrice = roundPrice(rawFill);
    const costBpsOneWay = priceFrictionBps + a.feeBps;

    return {
        fillPrice,
        referencePrice: ref,
        gapAdjusted,
        feeBps: a.feeBps,
        spreadBps: a.spreadBps,
        slippageBps: a.slippageBps,
        costBpsOneWay,
        summary: `${formatPaperFillAssumptions(a)}${gapAdjusted ? ` · gap-open exit @ ${roundPrice(base)}` : ''}`,
    };
};

/**
 * Compute gross R, explicit round-trip cost R (2×fee + spread + slippage), and net R
 * for a simulated paper trade.
 */
export const computePaperNetR = (input: {
    entryPrice: number;
    exitPrice: number;
    stopPrice: number;
    direction: 'Long' | 'Short';
    assumptions?: Partial<PaperFillAssumptions> | null;
}): { grossR: number; costR: number; netR: number } => {
    const a = normalizePaperFillAssumptions(input.assumptions);
    const entry = Number(input.entryPrice);
    const exit = Number(input.exitPrice);
    const stop = Number(input.stopPrice);
    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(stop) || entry <= 0 || risk <= 0) {
        return { grossR: 0, costR: 0, netR: 0 };
    }
    const signedMove = input.direction === 'Long' ? (exit - entry) : (entry - exit);
    const grossR = roundR(signedMove / risk);
    const stopDistancePct = (risk / entry) * 100;
    const totalRoundTripBps = 2 * a.feeBps + a.spreadBps + a.slippageBps;
    const roundTripCostPct = totalRoundTripBps / 100;
    const costR = stopDistancePct > 0 ? roundR(roundTripCostPct / stopDistancePct) : 0;
    const netR = roundR(grossR - costR);
    return { grossR, costR, netR };
};
