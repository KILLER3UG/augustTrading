/**
 * paperJournal — the one bridge from the broker's authoritative closed ledger
 * to the Trade Log.
 *
 * The paper/live axis is the EXISTING `simulated?: boolean` field, read through
 * `isSimulatedTrade`. `TradeSource` stays what it means ('manual'|'imported'|
 * 'signal' — row provenance); overloading it with 'paper'|'live' would create
 * a second source of truth for the same distinction. Callers that want the
 * brief's wording use `paperSourceOf()`: absent `simulated` ⇒ 'live', so every
 * legacy row is backward-compatible with zero migration.
 *
 * Paper rows are stamped `simulated: true`, so `filterTradesBySimulationMode`
 * keeps them OUT of live win-rate / expectancy / calibration by default.
 */

import type { LoggedTrade } from '../../types/trade';
import type { PaperSettledTrade } from './paperCore';
import {
    PAPER_MAKER_FEE_BPS,
    PAPER_STOP_SLIPPAGE_BPS,
    PAPER_TAKER_FEE_BPS,
} from './paperCore';
import { isSimulatedTrade } from '../tracking/paperExecution';
import { TradeOutcome } from '../../types/enums';

export type PaperSource = 'paper' | 'live';

/** The derived Paper|Live label. Legacy/human rows default to live. */
export const paperSourceOf = (
    trade: { simulated?: boolean; analysis?: { simulated?: boolean } | null } | null | undefined,
): PaperSource => isSimulatedTrade(trade) ? 'paper' : 'live';

/** Kept as an explicit named export so a probe can pin the backward-compat rule. */
export const legacyRowsAreLive = (): PaperSource => paperSourceOf({}) ;

/** One settled broker row → one journal row, with the broker's numbers verbatim. */
export const paperSettlementToLoggedTrade = (settlement: PaperSettledTrade): LoggedTrade => {
    const exitIsMaker = settlement.exitReason === 'tp';
    const feeBps = exitIsMaker ? PAPER_MAKER_FEE_BPS : PAPER_TAKER_FEE_BPS;
    // The assumptions describe the EXIT leg the journal row settles: a stop
    // really did pay adverse slippage, a resting TP really did not. The ENTRY
    // leg's fee is inside `paper.feesUsd` (the row's total).
    const slippageBps = settlement.exitReason === 'sl' ? PAPER_STOP_SLIPPAGE_BPS : 0;
    const createdAt = new Date(settlement.openedAt).toISOString();
    const closedAt = new Date(settlement.closedAt).toISOString();
    return {
        id: `paper-${settlement.positionId}-${settlement.exitReason}-${settlement.closedAt}`,
        analysis: {
            // A paper fill is NOT a model verdict. Low confidence + probability 0
            // make that explicit instead of smuggling a fabricated grade into
            // any stats a trader might enable on the simulated filter.
            coinName: settlement.symbol,
            direction: settlement.side === 'long' ? 'Long' : 'Short',
            confidence: 'Low',
            probability: 0,
            strategy: 'paper_broker_simulation',
            activeStrategies: [],
            entryPoints: [{ description: 'Paper fill', price: String(settlement.entryPrice) }],
            stopLoss: settlement.stopLoss !== undefined ? String(settlement.stopLoss) : '—',
            takeProfit: (settlement.takeProfits ?? []).map(price => ({ price: String(price) })),
            marketConditions: {
                pattern: 'locally simulated paper execution',
                candleBehavior: 'not observed by a model',
                timeframeAlignment: 'not observed by a model',
                rsi: 'not observed by a model',
                macd: 'not observed by a model',
                sentiment: 'not observed by a model',
            },
            historicalCorrelation: 'not applicable — simulated execution',
            createdAt,
        },
        // A paper close always pays fees, so an exactly-0 net is a theoretical
        // boundary; the enum has no scratch state and PENDING would misread an
        // unsettled row, so the boundary books conservatively as a LOSS.
        outcome: settlement.netPnlUsd > 0 ? TradeOutcome.WIN : TradeOutcome.LOSS,
        timestamp: closedAt,
        decidedAt: createdAt,
        outcomeResolvedAt: closedAt,
        resolutionSource: 'tracker',
        simulated: true,
        fillAssumptions: {
            feeBps,
            spreadBps: 0,
            slippageBps,
            gapFillMode: 'gap_open',
        },
        paper: settlement,
        pnlAmount: settlement.netPnlUsd,
        rMultiple: settlement.rMultiple,
        realizedR: settlement.rMultiple,
        netR: settlement.rMultiple,
        slippageModeled: false,
        ...(settlement.thesis ? { postMortem: settlement.thesis } : {}),
    } as LoggedTrade;
};

/**
 * Merge the broker's settled ledger into a journal list without duplicates.
 * Called once on App mount (for settlements that closed while no surface was
 * mounted) and on every live settlement through the registered sink.
 */
export const mergePaperSettlements = (
    trades: readonly LoggedTrade[],
    settlements: readonly PaperSettledTrade[],
): LoggedTrade[] => {
    const seen = new Set(
        trades.filter(t => t.paper).map(t => `${t.paper?.positionId}|${t.paper?.exitReason}|${t.paper?.closedAt}`),
    );
    const additions: LoggedTrade[] = [];
    for (const settlement of settlements) {
        const key = `${settlement.positionId}|${settlement.exitReason}|${settlement.closedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push(paperSettlementToLoggedTrade(settlement));
    }
    return additions.length > 0 ? [...trades, ...additions] : [...trades];
};
