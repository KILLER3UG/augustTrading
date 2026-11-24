/**
 * paperCore — the deterministic core of the local Paper Trading Broker.
 *
 * August places no real orders and holds no exchange keys. Every number here
 * is a SIMULATION of an execution, computed locally from public market data;
 * the seat can never turn it into a real order. The core is pure and
 * synchronous: no fetch, no clock read, no persistence. A service wraps it
 * with live quotes and a serialized store; tests call it directly.
 *
 * Invariants this module enforces (never delegated to a model):
 *  - market fills cross the L2 ladder (or a FLAGGED conservative fallback);
 *  - resting limits fill on a STRICT cross — a touch is not a fill;
 *  - stop exits take taker fee + adverse slippage, resting TP takes maker;
 *  - liquidation is a MARK-price breach of the isolated liquidation price,
 *    never a wick of the last traded price;
 *  - funding accrues only at 00:00 / 08:00 / 16:00 UTC on full notional;
 *  - every refusal is a structured receipt with ZERO state mutation.
 */

import type { OrderBookData } from '../analysis/MarketDataService';
import { estimateBookSlippage } from '../analysis/MarketDataService';
import { computePaperExitFill } from '../tracking/paperExecution';
import type { PaperTradeRecord } from '../../types/trade';

// ── constants ───────────────────────────────────────────────────────────────

/** Fees on FULL notional (qty × execPrice), in basis points. */
export const PAPER_MAKER_FEE_BPS = 2;    // 0.02 %
export const PAPER_TAKER_FEE_BPS = 5;    // 0.05 %
/** Maintenance margin rate used for the isolated liquidation price (0.5 %). */
export const PAPER_MAINTENANCE_MARGIN_RATE = 0.005;
/** Adverse price slippage applied to a stop-market fill, in bps. */
export const PAPER_STOP_SLIPPAGE_BPS = 5;
/**
 * Declared, capped liquidation slippage (10 bps). A liquidation exits at the
 * position's OWN isolated liquidation price adjusted by at most this much,
 * NEVER at the gapped mark print that triggered it. At 125x the worst case is
 * ~0.4 % price loss + ~0.1 % fees < the 0.8 % isolated margin, so the trader
 * can never realize more than the margin they isolated, however far the next
 * print gaps through the level.
 */
export const PAPER_LIQUIDATION_SLIPPAGE_BPS = 10;
/** Conservative spread+impact fallback when depth is unavailable. */
export const PAPER_FALLBACK_SPREAD_BPS = 4;
export const PAPER_FALLBACK_IMPACT_BPS = 3;
/** 8-hour Binance funding cadence. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
/**
 * Legacy cap retained only as a documented constant for old readers. The
 * authoritative closed ledger is NEVER capped: settlement 251 must survive
 * with the same bytes as settlement 1. Any capped view belongs to the UI.
 */
export const PAPER_CLOSED_TRADE_CAP = 250;

export interface PaperRiskLimits {
    startingBalanceUsd: number;
    makerFeeBps: number;
    takerFeeBps: number;
    maxRiskPerTradePct: number;
    maxLeverage: number;
    maxConcurrentPositions: number;
    dailyDrawdownKillSwitchPct: number;
}

export const DEFAULT_PAPER_RISK_LIMITS: Readonly<PaperRiskLimits> = Object.freeze({
    startingBalanceUsd: 10_000,
    makerFeeBps: PAPER_MAKER_FEE_BPS,
    takerFeeBps: PAPER_TAKER_FEE_BPS,
    maxRiskPerTradePct: 1.0,
    maxLeverage: 10,
    maxConcurrentPositions: 3,
    dailyDrawdownKillSwitchPct: 3.0,
});

export interface PaperAccountConfig extends PaperRiskLimits {
    /** Default ON for interactive chat. Settings-only mutation. */
    enabled: boolean;
    /** Default strictly OFF — the seat never watches orders on its own. */
    allowAutonomousWatch: boolean;
}

export const DEFAULT_PAPER_ACCOUNT_CONFIG: Readonly<PaperAccountConfig> = Object.freeze({
    ...DEFAULT_PAPER_RISK_LIMITS,
    enabled: true,
    allowAutonomousWatch: false,
});

/** Clamp every stored field. Never trust the stored shape. */
export const normalizePaperConfig = (input?: Partial<PaperAccountConfig> | null): PaperAccountConfig => {
    const d = DEFAULT_PAPER_ACCOUNT_CONFIG;
    const num = (v: unknown, fallback: number, min: number, max: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    return {
        enabled: input?.enabled !== false,
        allowAutonomousWatch: input?.allowAutonomousWatch === true,
        startingBalanceUsd: num(input?.startingBalanceUsd, d.startingBalanceUsd, 100, 10_000_000),
        makerFeeBps: num(input?.makerFeeBps, d.makerFeeBps, 0, 100),
        takerFeeBps: num(input?.takerFeeBps, d.takerFeeBps, 0, 100),
        maxRiskPerTradePct: num(input?.maxRiskPerTradePct, d.maxRiskPerTradePct, 0.05, 5),
        maxLeverage: Math.floor(num(input?.maxLeverage, d.maxLeverage, 1, 125)),
        maxConcurrentPositions: Math.floor(num(input?.maxConcurrentPositions, d.maxConcurrentPositions, 1, 20)),
        dailyDrawdownKillSwitchPct: num(input?.dailyDrawdownKillSwitchPct, d.dailyDrawdownKillSwitchPct, 0.1, 50),
    };
};

// ── state vocabulary ────────────────────────────────────────────────────────

export type PaperSide = 'long' | 'short';
export type PaperExitReason = PaperTradeRecord['exitReason'];
export type PaperOrderAction = 'open_market' | 'open_limit' | 'modify_sl_tp' | 'close' | 'cancel';

export const PAPER_ORDER_ACTIONS: readonly PaperOrderAction[] = Object.freeze([
    'open_market', 'open_limit', 'modify_sl_tp', 'close', 'cancel',
]);

export interface PaperPosition {
    id: string;
    symbol: string;
    side: PaperSide;
    qty: number;
    entryPrice: number;
    /** Isolated liquidation price from the ORIGINAL leverage — never re-derived live. */
    liquidationPrice: number;
    stopLoss: number;
    takeProfits: number[];
    leverage: number;
    marginUsd: number;
    riskUsd: number;
    entryFeeUsd: number;
    openedAt: number;
    /** Cumulative 8h funding PAID, SIGNED: positive = paid by the position,
     *  negative = received by a short. Migration-safe: readers must treat a
     *  missing value as 0. */
    fundingPaidUsd: number;
    /** Last UTC funding slot already settled for this position (exclusive boundary). */
    lastFundingSlotMs: number;
    /** Qty already closed by partial TP scale-outs. Migration-safe: default 0. */
    closedQty: number;
    skillSlug?: string;
    thesis?: string;
}

export interface PaperPendingOrder {
    id: string;
    symbol: string;
    side: PaperSide;
    limitPrice: number;
    qty: number;
    stopLoss: number;
    takeProfits: number[];
    leverage: number;
    riskUsd: number;
    createdAt: number;
    skillSlug?: string;
    thesis?: string;
}

export interface PaperSettledTrade extends PaperTradeRecord {
    symbol: string;
    leverage: number;
}

export interface PaperAccount {
    version: 1;
    config: PaperAccountConfig;
    /** Realized wallet: starting balance + net PnL − fees − funding. */
    cashBalanceUsd: number;
    positions: PaperPosition[];
    pendingOrders: PaperPendingOrder[];
    /** Authoritative closed ledger, newest first. */
    closedTrades: PaperSettledTrade[];
    /** UTC day (YYYY-MM-DD) the kill-switch window starts from. */
    dayKey: string;
    dayStartEquityUsd: number;
    killSwitchActive: boolean;
}

export const createPaperAccount = (
    config: Partial<PaperAccountConfig> | null | undefined = null,
    nowMs: number = Date.now(),
): PaperAccount => {
    const cfg = normalizePaperConfig(config);
    return {
        version: 1,
        config: cfg,
        cashBalanceUsd: cfg.startingBalanceUsd,
        positions: [],
        pendingOrders: [],
        closedTrades: [],
        dayKey: utcDayKey(nowMs),
        dayStartEquityUsd: cfg.startingBalanceUsd,
        killSwitchActive: false,
    };
};

export const utcDayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** UTC funding slots strictly AFTER `fromMs` and <= `toMs`. */
export const utcFundingSlotsBetween = (fromMs: number, toMs: number): number[] => {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
    const first = (Math.floor(fromMs / FUNDING_INTERVAL_MS) + 1) * FUNDING_INTERVAL_MS;
    const slots: number[] = [];
    for (let t = first; t <= toMs; t += FUNDING_INTERVAL_MS) slots.push(t);
    return slots;
};

// ── derived numbers ─────────────────────────────────────────────────────────

export const paperUnrealizedPnl = (position: PaperPosition, markPrice: number): number => {
    if (!Number.isFinite(markPrice) || markPrice <= 0) return 0;
    const move = position.side === 'long'
        ? markPrice - position.entryPrice
        : position.entryPrice - markPrice;
    return move * position.qty;
};

export const paperMarginUsed = (account: PaperAccount): number =>
    account.positions.reduce((sum, p) => sum + p.marginUsd, 0);

export const paperEquity = (account: PaperAccount, markPrices: Readonly<Record<string, number>> = {}): number => {
    const unrealized = account.positions.reduce((sum, p) =>
        sum + paperUnrealizedPnl(p, markPrices[p.symbol] ?? p.entryPrice), 0);
    return account.cashBalanceUsd + unrealized;
};

export const paperFreeMargin = (account: PaperAccount): number =>
    account.cashBalanceUsd - paperMarginUsed(account);

/** Isolated liquidation price from entry price, side and leverage. */
export const isolatedLiquidationPrice = (
    entryPrice: number,
    side: PaperSide,
    leverage: number,
): number => {
    const safeLeverage = Math.max(1, Math.min(125, Math.floor(leverage)));
    const raw = side === 'long'
        ? entryPrice * (1 - 1 / safeLeverage + PAPER_MAINTENANCE_MARGIN_RATE)
        : entryPrice * (1 + 1 / safeLeverage - PAPER_MAINTENANCE_MARGIN_RATE);
    return Math.max(0, Math.round(raw * 1e8) / 1e8);
};

export interface PaperAccountView {
    enabled: boolean;
    equity: number;
    cashBalance: number;
    freeMargin: number;
    unrealizedPnl: number;
    realizedPnlToday: number;
    dailyDrawdownPct: number;
    killSwitchActive: boolean;
    openPositions: PaperPosition[];
    pendingOrders: PaperPendingOrder[];
    riskLimits: PaperRiskLimits;
}

export const paperAccountView = (
    account: PaperAccount,
    markPrices: Readonly<Record<string, number>> = {},
    nowMs: number = Date.now(),
): PaperAccountView => {
    const equity = paperEquity(account, markPrices);
    const unrealizedPnl = equity - account.cashBalanceUsd;
    const dayKey = utcDayKey(nowMs);
    // A stale day key means no tick has arrived yet in THIS UTC day: the
    // drawdown window has reset, so today's drawdown is 0 — never a number
    // measured against yesterday's equity.
    const sameDay = dayKey === account.dayKey;
    const dayStart = sameDay ? account.dayStartEquityUsd : equity;
    const drawdownPct = sameDay && dayStart > 0 ? Math.max(0, ((dayStart - equity) / dayStart) * 100) : 0;
    const startOfDayMs = Date.parse(`${dayKey}T00:00:00.000Z`);
    const realizedPnlToday = account.closedTrades
        .filter(t => t.closedAt >= startOfDayMs)
        .reduce((sum, t) => sum + t.netPnlUsd, 0);
    return {
        enabled: account.config.enabled,
        equity: round2(equity),
        cashBalance: round2(account.cashBalanceUsd),
        freeMargin: round2(paperFreeMargin(account)),
        unrealizedPnl: round2(unrealizedPnl),
        realizedPnlToday: round2(realizedPnlToday),
        dailyDrawdownPct: round2(drawdownPct),
        killSwitchActive: sameDay ? account.killSwitchActive : false,
        openPositions: account.positions.map(p => ({ ...p })),
        pendingOrders: account.pendingOrders.map(o => ({ ...o })),
        riskLimits: { ...account.config },
    };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const finitePositive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;

// ── receipts ────────────────────────────────────────────────────────────────

export type PaperReceiptKind =
    | 'paper_fill' | 'paper_pending' | 'paper_modify' | 'paper_close'
    | 'paper_cancel' | 'paper_event' | 'paper_account';

export interface PaperOrderInput {
    action: PaperOrderAction;
    symbol?: string;
    side?: PaperSide;
    risk_pct?: number;
    notional_usd?: number;
    leverage?: number;
    entry_price?: number;
    stop_loss?: number;
    take_profits?: number[];
    position_id?: string;
    order_id?: string;
    skill_slug?: string;
    thesis?: string;
}

export interface PaperEvent {
    type: 'entry_fill' | 'pending_fill' | 'sl' | 'tp' | 'liquidation' | 'manual_close' | 'funding' | 'modify' | 'cancel' | 'kill_switch';
    symbol: string;
    positionId?: string;
    orderId?: string;
    price?: number;
    amountUsd?: number;
    at: number;
    /** Audited line the UI renders verbatim. Monochrome — no hue carries meaning. */
    line: string;
}

export interface PaperReceipt {
    ok: boolean;
    action?: PaperOrderAction;
    kind?: PaperReceiptKind;
    error?: string;
    reason?: string;
    message?: string;
    events?: PaperEvent[];
    settlements?: PaperSettledTrade[];
    view?: PaperAccountView;
    account?: PaperAccount;
    positionId?: string;
    orderId?: string;
    /** True when the live quote was missing and a conservative flagged fallback priced the fill. */
    fillFallback?: boolean;
}

export const refuse = (error: string, reason: string): PaperReceipt => ({ ok: false, error, reason });

// ── deterministic quote → fill ──────────────────────────────────────────────

export interface PaperQuote {
    bestBid?: number;
    bestAsk?: number;
    last?: number;
    /** Existing L2 snapshot; walked best-first through the shared estimator. */
    depth?: Pick<OrderBookData, 'bids' | 'asks'> | null;
}

export interface PaperFillQuote {
    price: number;
    source: 'l2' | 'spread_fallback' | 'price_fallback';
    fallback: boolean;
    note?: string;
}

/**
 * Resolve a market fill from a quote. L2 is authoritative when it can carry
 * the notional; a thin/absent book falls back to spread+impact with an
 * explicit flag — never an unflagged "live" price.
 */
export const resolveMarketFill = (
    side: PaperSide,
    notionalUsd: number,
    quote: PaperQuote,
): PaperFillQuote | null => {
    if (!finitePositive(notionalUsd)) return null;
    const bookSide = side === 'long' ? 'buy' : 'sell';
    const ladder = quote.depth;
    if (ladder && Array.isArray(ladder.bids) && Array.isArray(ladder.asks)) {
        const est = estimateBookSlippage(ladder.bids, ladder.asks, bookSide, notionalUsd);
        if (est.available && finitePositive(est.vwapFillPrice)) {
            return { price: est.vwapFillPrice as number, source: 'l2', fallback: false };
        }
    }
    const bid = finitePositive(quote.bestBid) ? quote.bestBid : undefined;
    const ask = finitePositive(quote.bestAsk) ? quote.bestAsk : undefined;
    if (bid !== undefined && ask !== undefined && ask >= bid) {
        const ref = side === 'long' ? ask : bid;
        const friction = (PAPER_FALLBACK_SPREAD_BPS / 2 + PAPER_FALLBACK_IMPACT_BPS) / 10_000;
        return {
            price: side === 'long' ? ref * (1 + friction) : ref * (1 - friction),
            source: 'spread_fallback',
            fallback: true,
            note: ladder ? 'order book too thin for this notional' : 'order book unavailable',
        };
    }
    const last = finitePositive(quote.last) ? quote.last : undefined;
    if (last !== undefined) {
        const friction = (PAPER_FALLBACK_SPREAD_BPS / 2 + PAPER_FALLBACK_IMPACT_BPS) / 10_000;
        return {
            price: side === 'long' ? last * (1 + friction) : last * (1 - friction),
            source: 'price_fallback',
            fallback: true,
            note: 'no two-sided book — priced from last trade with conservative spread+impact',
        };
    }
    return null;
};

// ── shared gate helpers ─────────────────────────────────────────────────────

export interface SizingInput {
    entryPrice: number;
    stopLoss: number;
    side: PaperSide;
    equityUsd: number;
    freeMarginUsd: number;
    riskPct?: number;
    notionalUsd?: number;
    leverage?: number;
    limits: PaperRiskLimits;
}

export interface SizingResult {
    qty: number;
    notionalUsd: number;
    riskUsd: number;
    leverage: number;
    marginUsd: number;
}

/** Pure sizing + risk-wall check. Returns a refusal string, never a throw. */
export const resolvePaperSizing = (input: SizingInput): { ok: true; value: SizingResult } | { ok: false; error: string; reason: string } => {
    const { limits } = input;
    if (!finitePositive(input.entryPrice) || !finitePositive(input.stopLoss)) {
        return { ok: false, error: 'invalid_levels', reason: 'entry and stop must be finite positive prices' };
    }
    if (!finitePositive(input.equityUsd)) {
        return { ok: false, error: 'account_unavailable', reason: 'equity is not a finite positive number' };
    }
    const distance = Math.abs(input.entryPrice - input.stopLoss);
    if (!(distance > 0)) {
        return { ok: false, error: 'invalid_geometry', reason: 'stop must be away from entry' };
    }
    // Directional geometry: long stop below entry, short stop above entry.
    if (input.side === 'long' && input.stopLoss >= input.entryPrice) {
        return { ok: false, error: 'inverted_stop', reason: 'a long stop must be below entry' };
    }
    if (input.side === 'short' && input.stopLoss <= input.entryPrice) {
        return { ok: false, error: 'inverted_stop', reason: 'a short stop must be above entry' };
    }
    const leverage = typeof input.leverage === 'number' && Number.isFinite(input.leverage)
        ? Math.floor(input.leverage)
        : 1;
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > limits.maxLeverage) {
        return {
            ok: false,
            error: 'leverage_exceeded',
            reason: `leverage ${leverage}x exceeds the ${limits.maxLeverage}x cap`,
        };
    }
    let qty: number;
    if (input.notionalUsd !== undefined) {
        if (!finitePositive(input.notionalUsd)) {
            return { ok: false, error: 'invalid_notional', reason: 'notional_usd must be a finite positive amount' };
        }
        qty = input.notionalUsd / input.entryPrice;
    } else if (input.riskPct !== undefined) {
        if (!finitePositive(input.riskPct)) {
            return { ok: false, error: 'invalid_risk', reason: 'risk_pct must be a finite positive percent' };
        }
        const riskBudget = input.equityUsd * (input.riskPct / 100);
        qty = riskBudget / distance;
    } else {
        return { ok: false, error: 'missing_size', reason: 'supply risk_pct or notional_usd — size is never invented' };
    }
    if (!finitePositive(qty)) {
        return { ok: false, error: 'invalid_size', reason: 'the computed quantity is not finite and positive' };
    }
    const notionalUsd = qty * input.entryPrice;
    const riskUsd = distance * qty;
    const marginUsd = notionalUsd / leverage;
    const maxRiskUsd = input.equityUsd * (limits.maxRiskPerTradePct / 100);
    if (riskUsd > maxRiskUsd * (1 + 1e-9)) {
        return {
            ok: false,
            error: 'risk_exceeded',
            reason: `risk $${round2(riskUsd)} exceeds the ${limits.maxRiskPerTradePct}% cap ($${round2(maxRiskUsd)})`,
        };
    }
    if (marginUsd > input.freeMarginUsd + 1e-9) {
        return {
            ok: false,
            error: 'margin_insufficient',
            reason: `isolated margin $${round2(marginUsd)} exceeds free margin $${round2(input.freeMarginUsd)}`,
        };
    }
    return { ok: true, value: { qty, notionalUsd, riskUsd, leverage, marginUsd } };
};

/** Directional geometry for targets: long TP above, short TP below entry. */
export const validateTakeProfits = (entry: number, side: PaperSide, tps: number[] | undefined): boolean => {
    if (tps === undefined) return true;
    if (!Array.isArray(tps) || tps.length === 0) return true;
    return tps.every(tp => finitePositive(tp) && (side === 'long' ? tp > entry : tp < entry));
};

// ── settlement ──────────────────────────────────────────────────────────────

export const settlePosition = (
    position: PaperPosition,
    exitPrice: number,
    exitFeeUsd: number,
    exitReason: PaperExitReason,
    nowMs: number,
): PaperSettledTrade => {
    const signedMove = position.side === 'long'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;
    const grossPnlUsd = signedMove * position.qty;
    const feesUsd = position.entryFeeUsd + exitFeeUsd;
    const fundingPaidUsd = position.fundingPaidUsd;
    const netPnlUsd = grossPnlUsd - feesUsd - fundingPaidUsd;
    // R is measured against the position's OWN planned risk — the distance to
    // the stop it was opened with — so the receipt, the journal row and the
    // wallet cannot disagree about what one R means. A shared helper here
    // would re-derive R from prices and drop the funding the position paid.
    const rMultiple = position.riskUsd > 0 ? netPnlUsd / position.riskUsd : 0;
    return {
        positionId: position.id,
        symbol: position.symbol,
        side: position.side,
        qty: round6(position.qty),
        /** A full exit closes the whole remaining qty; a partial TP slice
         *  settles only its pro-rata share. */
        closedQty: round6(position.qty),
        entryPrice: position.entryPrice,
        exitPrice,
        grossPnlUsd: round2(grossPnlUsd),
        feesUsd: round2(feesUsd),
        fundingPaidUsd: round2(fundingPaidUsd),
        netPnlUsd: round2(netPnlUsd),
        rMultiple: Math.round(rMultiple * 10000) / 10000,
        exitReason,
        openedAt: position.openedAt,
        closedAt: nowMs,
        leverage: position.leverage,
        stopLoss: position.stopLoss,
        takeProfits: [...position.takeProfits],
        ...(position.skillSlug ? { skillSlug: position.skillSlug } : {}),
        ...(position.thesis ? { thesis: position.thesis } : {}),
    };
};

// ── tick evaluation ─────────────────────────────────────────────────────────

export interface PaperTick {
    symbol: string;
    timestamp: number;
    price?: number;
    high?: number;
    low?: number;
    open?: number;
    /** Mark price for liquidation — NEVER substituted with a candle wick. */
    markPrice?: number;
    /** Live/cached funding rate for this settlement. Null/undefined = no accrual. */
    fundingRate?: number | null;
    /**
     * One observed funding frame per crossed 8h slot, captured from the live
     * markPrice WS stream while the slot was open. When present, each slot is
     * settled with ITS OWN rate and mark notional; absent frames fall back to
     * `fundingRate` + the tick mark (or entry as a last resort).
     */
    fundingFrames?: ReadonlyArray<PaperFundingFrame>;
    /** Optional live marks for all held symbols so rollover & drawdown equity
     *  value every open position at live mark rather than entry. */
    markPrices?: Readonly<Record<string, number>>;
}

/** One funding observation bucketed to its UTC 8h settlement slot. */
export interface PaperFundingFrame {
    slotMs: number;
    rate: number;
    /** Mark observed in that slot; the notional is qty × mark. */
    markPrice?: number;
}

/**
 * Settle every crossed 8h funding slot for EVERY open position, in place.
 * Shared by the tick sweep AND the manual-close path: a close before the first
 * sweep must not silently skip a slot the trader already crossed.
 */
export const accruePaperFunding = (
    account: PaperAccount,
    nowMs: number,
    rate: number | null | undefined,
    frames: ReadonlyArray<PaperFundingFrame> | undefined,
    referenceMark: number | undefined,
    events: PaperEvent[],
    symbol?: string,
): void => {
    if (account.positions.length === 0) return;
    const targetSymbol = typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : null;
    const bySlot = new Map<number, PaperFundingFrame>();
    if (frames) for (const f of frames) {
        if (Number.isFinite(f?.slotMs) && Number.isFinite(f?.rate)) bySlot.set(f.slotMs, f);
    }
    const hasFrame = bySlot.size > 0;
    const fallbackRate = Number.isFinite(rate) ? (rate as number) : null;
    if (!hasFrame && fallbackRate === null) return;
    for (const position of account.positions) {
        if (targetSymbol && position.symbol.toUpperCase() !== targetSymbol) continue;
        const slots = utcFundingSlotsBetween(position.lastFundingSlotMs, nowMs);
        if (slots.length === 0) continue;
        let payment = 0;
        let settledAny = false;
        for (const slot of slots) {
            const frame = bySlot.get(slot);
            const slotRate = frame ? frame.rate : fallbackRate;
            if (slotRate === null) continue;
            settledAny = true;
            const notionalMark = frame?.markPrice && finitePositive(frame.markPrice)
                ? frame.markPrice
                : (finitePositive(referenceMark) ? referenceMark as number : position.entryPrice);
            const slotPayment = position.qty * notionalMark * slotRate * (position.side === 'long' ? 1 : -1);
            payment += slotPayment;
            // One event PER SLOT: a two-slot crossing is two auditable lines,
            // not one aggregated line that hides the per-slot rate/mark.
            events.push({
                type: 'funding',
                symbol: position.symbol,
                positionId: position.id,
                amountUsd: slotPayment,
                at: slot,
                line: `Paper funding ${position.symbol} · ${(slotRate * 100).toFixed(4)}% @ ${roundPrice(notionalMark)} · ${signedUsd(slotPayment)}`,
            });
        }
        if (!settledAny) continue;
        // SIGNED: a short receiving positive funding gets a NEGATIVE
        // fundingPaidUsd, so netPnl = gross − fees − funding matches the cash
        // credit already applied to the wallet. Never Math.max(0, payment).
        position.fundingPaidUsd = round6(position.fundingPaidUsd + payment);
        position.lastFundingSlotMs = slots[slots.length - 1];
        account.cashBalanceUsd -= payment; // negative payment CREDITS the wallet
    }
};

export interface PaperTickOutcome {
    account: PaperAccount;
    events: PaperEvent[];
    settlements: PaperSettledTrade[];
}

const cloneAccount = (account: PaperAccount): PaperAccount => ({
    ...account,
    config: { ...account.config },
    positions: account.positions.map(p => ({ ...p, takeProfits: [...p.takeProfits] })),
    pendingOrders: account.pendingOrders.map(o => ({ ...o, takeProfits: [...o.takeProfits] })),
    closedTrades: [...account.closedTrades],
});

const dayRollover = (
    account: PaperAccount,
    nowMs: number,
    markPrices: Readonly<Record<string, number>> = {},
): void => {
    const key = utcDayKey(nowMs);
    if (key !== account.dayKey) {
        account.dayKey = key;
        // The daily drawdown window is measured from EQUITY (cash + open
        // PnL), never from cash alone — a day that opens with winners in
        // flight must not read as a fresh, risk-free start.
        account.dayStartEquityUsd = paperEquity(account, markPrices);
        account.killSwitchActive = false;
    }
};

const applyExit = (
    account: PaperAccount,
    position: PaperPosition,
    exitPrice: number,
    feeBps: number,
    reason: PaperExitReason,
    nowMs: number,
    events: PaperEvent[],
    settlements: PaperSettledTrade[],
    label: string,
): void => {
    const exitNotional = exitPrice * position.qty;
    const exitFeeUsd = exitNotional * (feeBps / 10_000);
    const settled = settlePosition(position, exitPrice, exitFeeUsd, reason, nowMs);
    // The wallet is debited ONCE per cost: the entry fee left at entry, the
    // funding left at each 8h accrual boundary. The close adds only the price
    // move minus the EXIT fee — adding `netPnlUsd` here would subtract the
    // entry fee and the funding a second time.
    account.cashBalanceUsd += settled.grossPnlUsd - exitFeeUsd;
    account.positions = account.positions.filter(p => p.id !== position.id);
    // Authoritative ledger: NEVER cap. Settlement 251 is as real as #1; a
    // capped VIEW belongs to the UI, not to the settlement path.
    account.closedTrades = [settled, ...account.closedTrades];
    settlements.push(settled);
    events.push({
        type: reason,
        symbol: position.symbol,
        positionId: position.id,
        price: exitPrice,
        amountUsd: settled.netPnlUsd,
        at: nowMs,
        line: `${label} ${position.symbol} · ${position.qty} @ ${roundPrice(exitPrice)} · net ${signedUsd(settled.netPnlUsd)}`,
    });
};

const roundPrice = (n: number): number => Math.round(n * 100) / 100;
const signedUsd = (n: number): string => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Scale out at ONE resting target. The nearest crossed target is filled first
 * (see `nearestCrossedTp`); when targets remain the position stays open with a
 * reduced qty, an incremented `closedQty` and the filled level removed. A
 * pro-rata copy is settled so entry fee, funding and planned risk are all
 * apportioned to the slice — the wallet is debited exactly once per slice.
 */
const applyPartialTp = (
    account: PaperAccount,
    position: PaperPosition,
    hitTp: number,
    nowMs: number,
    events: PaperEvent[],
    settlements: PaperSettledTrade[],
): void => {
    const remainingTps = position.takeProfits.filter(tp => tp !== hitTp);
    if (remainingTps.length === 0 || position.qty <= 0) {
        applyExit(account, position, hitTp, account.config.makerFeeBps, 'tp', nowMs,
            events, settlements, 'Paper TP');
        return;
    }
    const sliceQty = position.qty / (remainingTps.length + 1);
    const fraction = sliceQty / position.qty;
    const slice: PaperPosition = {
        ...position,
        qty: sliceQty,
        closedQty: sliceQty,
        entryFeeUsd: position.entryFeeUsd * fraction,
        fundingPaidUsd: position.fundingPaidUsd * fraction,
        riskUsd: position.riskUsd * fraction,
        marginUsd: position.marginUsd * fraction,
        takeProfits: [hitTp],
    };
    const exitFeeUsd = sliceQty * hitTp * (account.config.makerFeeBps / 10_000);
    const settled = settlePosition(slice, hitTp, exitFeeUsd, 'tp', nowMs);
    account.cashBalanceUsd += settled.grossPnlUsd - exitFeeUsd;
    account.closedTrades = [settled, ...account.closedTrades];
    settlements.push(settled);
    events.push({
        type: 'tp', symbol: position.symbol, positionId: position.id, price: hitTp,
        amountUsd: settled.netPnlUsd, at: nowMs,
        line: `Paper TP ${position.symbol} · ${round6(sliceQty)} @ ${roundPrice(hitTp)} · net ${signedUsd(settled.netPnlUsd)} · partial`,
    });
    const rest: PaperPosition = {
        ...position,
        qty: position.qty - sliceQty,
        closedQty: round6(position.closedQty + sliceQty),
        entryFeeUsd: position.entryFeeUsd - slice.entryFeeUsd,
        fundingPaidUsd: position.fundingPaidUsd - slice.fundingPaidUsd,
        riskUsd: position.riskUsd - slice.riskUsd,
        marginUsd: position.marginUsd - slice.marginUsd,
        takeProfits: remainingTps,
    };
    account.positions = account.positions.map(p => p.id === position.id ? rest : p);
};

/** Nearest crossed target by distance from entry, NOT first array element.
 *  A wick through [104, 101, 102] settles 101 first. */
const nearestCrossedTp = (position: PaperPosition, low: number, high: number): number | undefined => {
    let best: number | undefined;
    let bestDistance = Infinity;
    for (const tp of position.takeProfits) {
        const crossed = position.side === 'long' ? high > tp : low < tp;
        if (!crossed) continue;
        const distance = Math.abs(tp - position.entryPrice);
        if (distance < bestDistance) { best = tp; bestDistance = distance; }
    }
    return best;
};

/**
 * Evaluate one mark/tick against the account. Pure: returns a NEW account.
 * - limit entry: strict cross only (buy if low < limit, sell if high > limit);
 * - SL: adverse high/low with slippage + taker fee;
 * - TP: strict cross of a resting maker level, maker fee;
 * - liquidation: MARK price only, breaching isolated liquidation price;
 * - funding: every crossed 00:00/08:00/16:00 UTC slot on full notional.
 */
export const evaluatePaperTick = (
    account: PaperAccount,
    tick: PaperTick,
): PaperTickOutcome => {
    const next = cloneAccount(account);
    const events: PaperEvent[] = [];
    const settlements: PaperSettledTrade[] = [];
    if (!account.config.enabled) return { account: next, events, settlements };
    const nowMs = tick.timestamp;
    if (!Number.isFinite(nowMs)) return { account: next, events, settlements };
    const tickMarks: Record<string, number> = {
        ...(tick.markPrices ?? {}),
        [tick.symbol]: (finitePositive(tick.markPrice) ? tick.markPrice : tick.price) ?? 0,
    };
    dayRollover(next, nowMs, tickMarks);

    // 1. Resting entry limits — strict cross, maker fee. A daily kill-switch
    //    halts ENTRIES: a resting limit is left resting (never canceled) and
    //    can fill once the window resets at 00:00 UTC.
    for (const order of next.killSwitchActive ? [] : [...next.pendingOrders]) {
        if (order.symbol !== tick.symbol) continue;
        const low = Number.isFinite(tick.low) ? tick.low as number : tick.price;
        const high = Number.isFinite(tick.high) ? tick.high as number : tick.price;
        if (!finitePositive(low) || !finitePositive(high)) continue;
        const crosses = order.side === 'long' ? low < order.limitPrice : high > order.limitPrice;
        if (!crosses) continue; // a mere touch never fills
        if (next.positions.length >= next.config.maxConcurrentPositions) continue;
        // The fill can never be worse than the limit for a maker order.
        const fillPrice = order.limitPrice;
        const qty = order.qty;
        const notional = qty * fillPrice;
        const entryFeeUsd = notional * (next.config.makerFeeBps / 10_000);
        const position: PaperPosition = {
            id: order.id.replace(/^ord-/, 'pos-'),
            symbol: order.symbol,
            side: order.side,
            qty,
            entryPrice: fillPrice,
            liquidationPrice: isolatedLiquidationPrice(fillPrice, order.side, order.leverage),
            stopLoss: order.stopLoss,
            takeProfits: [...order.takeProfits],
            leverage: order.leverage,
            marginUsd: notional / order.leverage,
            riskUsd: order.riskUsd,
            entryFeeUsd,
            openedAt: nowMs,
            fundingPaidUsd: 0,
            lastFundingSlotMs: nowMs,
            closedQty: 0,
            ...(order.skillSlug ? { skillSlug: order.skillSlug } : {}),
            ...(order.thesis ? { thesis: order.thesis } : {}),
        };
        // Maker rebate is a cost here: reduce the wallet by the fee.
        next.cashBalanceUsd -= entryFeeUsd;
        next.positions.push(position);
        next.pendingOrders = next.pendingOrders.filter(o => o.id !== order.id);
        events.push({
            type: 'pending_fill',
            symbol: order.symbol,
            positionId: position.id,
            orderId: order.id,
            price: fillPrice,
            at: nowMs,
            line: `Paper ${position.side.toUpperCase()} ${position.symbol} · ${qty} @ ${roundPrice(fillPrice)} · LIMIT`,
        });
    }

    // 2. Funding accrual — every crossed 00:00/08:00/16:00 UTC slot, before
    //    exits so the settled receipt includes every payment owed up to the
    //    close. Per-slot WS frames win over the single current rate; the mark
    //    notional is live whenever a mark is available.
    accruePaperFunding(next, nowMs, tick.fundingRate, tick.fundingFrames,
        finitePositive(tick.markPrice) ? tick.markPrice as number : undefined, events, tick.symbol);

    // 3. Open position exits. Liquidation is checked on MARK only, never a wick.
    for (const position of [...next.positions]) {
        if (position.symbol !== tick.symbol) continue;
        const mark = finitePositive(tick.markPrice) ? tick.markPrice as number : undefined;
        const liquidated = mark !== undefined && (
            position.side === 'long' ? mark <= position.liquidationPrice : mark >= position.liquidationPrice
        );
        if (liquidated && mark !== undefined) {
            // Exit at the position's OWN liquidation level with only a DECLARED
            // capped slippage — NEVER at the gapped mark print. A 10x long
            // liquidating at ~90.5 that next prints 80k must not realize 2×
            // margin; max loss stays inside the isolated margin.
            const slip = PAPER_LIQUIDATION_SLIPPAGE_BPS / 10_000;
            const exitPrice = position.side === 'long'
                ? position.liquidationPrice * (1 - slip)
                : position.liquidationPrice * (1 + slip);
            applyExit(next, position, exitPrice, next.config.takerFeeBps, 'liquidation', nowMs,
                events, settlements, 'Paper LIQUIDATION');
            continue;
        }
        const low = Number.isFinite(tick.low) ? tick.low as number : tick.price;
        const high = Number.isFinite(tick.high) ? tick.high as number : tick.price;
        if (!finitePositive(low) || !finitePositive(high)) continue;

        const stopHit = position.side === 'long' ? low <= position.stopLoss : high >= position.stopLoss;
        if (stopHit) {
            // Realistic stop fill: adverse reference, then adverse slippage.
            const adverse = position.side === 'long'
                ? Math.min(position.stopLoss, low)
                : Math.max(position.stopLoss, high);
            const open = finitePositive(tick.open) ? tick.open : undefined;
            // computePaperExitFill applies the adverse friction ONCE, with an
            // injectable assumptions object — do not pre-slip the reference
            // and then slip it again inside the shared helper.
            const slipResult = computePaperExitFill({
                direction: position.side === 'long' ? 'Long' : 'Short',
                exitKind: 'sl',
                referencePrice: adverse,
                ...(open !== undefined ? { barOpen: open } : {}),
                assumptions: {
                    feeBps: next.config.takerFeeBps,
                    spreadBps: 0,
                    slippageBps: PAPER_STOP_SLIPPAGE_BPS,
                    gapFillMode: 'gap_open',
                },
            });
            applyExit(next, position, slipResult.fillPrice, next.config.takerFeeBps, 'sl', nowMs,
                events, settlements, 'Paper SL');
            continue;
        }

        // Resting TP limits: maker fee, strict cross only. The NEAREST crossed
        // target fills first, and later targets scale out the remaining qty.
        const hitTp = nearestCrossedTp(position, low, high);
        if (hitTp !== undefined) {
            applyPartialTp(next, position, hitTp, nowMs, events, settlements);
        }
    }

    // 4. Daily drawdown kill-switch — halts ENTRIES only, never an exit.
    const equity = paperEquity(next, tickMarks);
    const dayStart = next.dayStartEquityUsd;
    const drawdownPct = dayStart > 0 ? ((dayStart - equity) / dayStart) * 100 : 0;
    if (drawdownPct >= next.config.dailyDrawdownKillSwitchPct) next.killSwitchActive = true;

    return { account: next, events, settlements };
};

// ── order entry (pure given a quote) ────────────────────────────────────────

export interface PlaceOrderEnv {
    account: PaperAccount;
    input: PaperOrderInput;
    quote: PaperQuote;
    nowMs: number;
    /** Supplied by the live service after ensureKnownSymbol; injected in tests. */
    isKnownSymbol?: (symbol: string) => boolean;
    /** Deterministic id factory; injected in tests. */
    nextId?: (prefix: string) => string;
    /** Optional deterministic plan/adversary gate; injected in tests. */
    planAllowed?: (input: PaperOrderInput) => { ok: boolean; reason?: string };
    /** Live funding rate from the quote provider / WS cache. Applied to a
     *  manual close BEFORE pricing so crossed 8h slots are never skipped. */
    fundingRate?: number | null;
    /** Per-slot funding frames, injected from the shared WS frame cache. */
    fundingFrames?: ReadonlyArray<PaperFundingFrame>;
    /** Live marks for EVERY held symbol — sizing must value open positions at
     *  the mark, never at their entry. */
    markPrices?: Readonly<Record<string, number>>;
}

const makeId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Place one paper order. No mutation of the passed account: the receipt
 * carries the NEXT account, which the service persists only on `ok: true`.
 */
export const placePaperOrder = (env: PlaceOrderEnv): PaperReceipt => {
    const { account, input, quote, nowMs } = env;
    const next = cloneAccount(account);
    const events: PaperEvent[] = [];
    const idFor = env.nextId ?? makeId;

    if (!next.config.enabled) {
        return refuse('paper_mode_disabled', 'Paper Mode is off in Settings — no order was placed');
    }
    if (env.planAllowed) {
        const gate = env.planAllowed(input);
        if (!gate.ok) return refuse('plan_refused', gate.reason ?? 'the plan gate refused this order');
    }
    if (!PAPER_ORDER_ACTIONS.includes(input.action)) {
        return refuse('unknown_action', `unsupported paper_order action "${String(input.action)}"`);
    }
    const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
    if (!symbol || !/^[A-Z0-9]{3,20}USDT$/.test(symbol)) {
        return refuse('unknown_symbol', `symbol "${String(input.symbol ?? '')}" is not a USDT perpetual symbol`);
    }
    if (env.isKnownSymbol && !env.isKnownSymbol(symbol)) {
        return refuse('unknown_symbol', `symbol "${symbol}" is not a TRADING USDT perpetual in the live universe`);
    }
    dayRollover(next, nowMs, {
        [symbol]: (finitePositive(quote.last) ? quote.last : 0)
            || (finitePositive(quote.bestAsk) ? quote.bestAsk : 0)
            || (finitePositive(quote.bestBid) ? quote.bestBid : 0),
    });

    if (input.action === 'cancel') {
        if (typeof input.order_id !== 'string' || !input.order_id) {
            return refuse('missing_order_id', 'cancel requires an order_id');
        }
        const order = next.pendingOrders.find(o => o.id === input.order_id);
        if (!order) return refuse('order_not_found', `no pending order ${input.order_id}`);
        next.pendingOrders = next.pendingOrders.filter(o => o.id !== order.id);
        events.push({
            type: 'cancel', symbol: order.symbol, orderId: order.id, at: nowMs,
            line: `Paper LIMIT ${order.symbol} · canceled`,
        });
        return { ok: true, action: input.action, kind: 'paper_cancel', events, account: next, orderId: order.id,
            view: paperAccountView(next, {}, nowMs) };
    }

    if (input.action === 'modify_sl_tp') {
        if (typeof input.position_id !== 'string' || !input.position_id) {
            return refuse('missing_position_id', 'modify_sl_tp requires a position_id');
        }
        const position = next.positions.find(p => p.id === input.position_id);
        if (!position) return refuse('position_not_found', `no open paper position ${input.position_id}`);
        if (input.stop_loss !== undefined) {
            if (!finitePositive(input.stop_loss)) return refuse('invalid_stop', 'stop_loss must be a finite positive price');
            if (position.side === 'long' ? input.stop_loss >= position.entryPrice : input.stop_loss <= position.entryPrice) {
                return refuse('inverted_stop', 'a modification cannot put the stop through entry');
            }
        }
        if (!validateTakeProfits(position.entryPrice, position.side, input.take_profits)) {
            return refuse('inverted_target', 'take_profits must sit beyond entry on the right side');
        }
        const updated = {
            ...position,
            stopLoss: input.stop_loss ?? position.stopLoss,
            takeProfits: input.take_profits ?? position.takeProfits,
        };
        next.positions = next.positions.map(p => p.id === position.id ? updated : p);
        events.push({
            type: 'modify', symbol: position.symbol, positionId: position.id, at: nowMs,
            line: `Paper ${position.side.toUpperCase()} ${position.symbol} · SL ${roundPrice(updated.stopLoss)} · TP ${updated.takeProfits.map(roundPrice).join('/') || '—'}`,
        });
        return { ok: true, action: input.action, kind: 'paper_modify', events, account: next,
            positionId: position.id, view: paperAccountView(next, {}, nowMs) };
    }

    if (input.action === 'close') {
        if (typeof input.position_id !== 'string' || !input.position_id) {
            return refuse('missing_position_id', 'close requires a position_id');
        }
        const position = next.positions.find(p => p.id === input.position_id);
        if (!position) return refuse('position_not_found', `no open paper position ${input.position_id}`);
        const last = finitePositive(quote.last) ? quote.last : undefined;
        if (last === undefined) {
            return refuse('quote_unavailable', 'no live mark/last price — refusing to price a manual close');
        }
        // A manual close before the first tick sweep must still settle every
        // crossed 8h slot — accrue FIRST, then price the exit, so the receipt
        // carries the funding and the wallet invariant (cash = start + netPnl)
        // holds. The quote's last is the mark reference when no WS frame exists.
        const closeEvents: PaperEvent[] = [];
        accruePaperFunding(next, nowMs, env.fundingRate, env.fundingFrames, last, closeEvents, position.symbol);
        events.push(...closeEvents);
        applyExit(next, position, last, next.config.takerFeeBps, 'manual_close', nowMs,
            events, [], 'Paper CLOSE');
        const settled = next.closedTrades[0];
        return {
            ok: true, action: input.action, kind: 'paper_close', events,
            settlements: [settled], account: next, positionId: position.id,
            view: paperAccountView(next, {}, nowMs),
        };
    }

    // open_market / open_limit share validation and sizing. `side` is an
    // ENTRY field: close/cancel/modify act on an existing position id and
    // must not be refused for omitting it.
    if (input.side !== 'long' && input.side !== 'short') {
        return refuse('invalid_side', 'side must be "long" or "short"');
    }
    if (next.positions.length >= next.config.maxConcurrentPositions) {
        return refuse('max_positions', `${next.config.maxConcurrentPositions} concurrent positions already open`);
    }
    if (next.killSwitchActive) {
        return refuse('kill_switch_active',
            'daily drawdown kill-switch active — new entries halt until 00:00 UTC; closing/reducing is allowed');
    }
    // Value EVERY held position at a live mark, never at its entry: a 10 %
    // winner already in the book must enlarge the risk budget, and a loser
    // must shrink it. The traded symbol's quote fills the remaining gap.
    const quoteMark = finitePositive(quote.last) ? quote.last
        : (finitePositive(quote.bestAsk) ? quote.bestAsk : undefined);
    const marks: Record<string, number> = {
        ...(quoteMark !== undefined ? { [symbol]: quoteMark } : {}),
        ...(env.markPrices ?? {}),
    };
    const equity = paperEquity(next, marks);
    const size = resolvePaperSizing({
        entryPrice: input.entry_price ?? 0,
        stopLoss: input.stop_loss ?? 0,
        side: input.side,
        equityUsd: equity,
        freeMarginUsd: paperFreeMargin(next),
        riskPct: input.risk_pct,
        notionalUsd: input.notional_usd,
        leverage: input.leverage,
        limits: next.config,
    });
    if (!size.ok) return refuse(size.error, size.reason);
    if (!validateTakeProfits(input.entry_price as number, input.side, input.take_profits)) {
        return refuse('inverted_target', 'take_profits must sit beyond entry on the right side');
    }

    if (input.action === 'open_limit') {
        if (!finitePositive(input.entry_price)) {
            return refuse('invalid_limit', 'open_limit requires a finite positive limit price');
        }
        const order: PaperPendingOrder = {
            id: idFor('ord'), symbol, side: input.side,
            limitPrice: input.entry_price as number,
            qty: size.value.qty, stopLoss: input.stop_loss as number,
            takeProfits: input.take_profits ?? [], leverage: size.value.leverage,
            riskUsd: size.value.riskUsd, createdAt: nowMs,
            ...(input.skill_slug ? { skillSlug: input.skill_slug } : {}),
            ...(input.thesis ? { thesis: input.thesis } : {}),
        };
        next.pendingOrders.push(order);
        events.push({
            type: 'pending_fill', symbol, orderId: order.id, at: nowMs,
            line: `Paper LIMIT ${symbol} · ${round6(order.qty)} @ ${roundPrice(order.limitPrice)} · resting`,
        });
        return { ok: true, action: input.action, kind: 'paper_pending', events, account: next,
            orderId: order.id, view: paperAccountView(next, {}, nowMs) };
    }

    // open_market
    const fill = resolveMarketFill(input.side, size.value.notionalUsd, quote);
    if (!fill) {
        return refuse('quote_unavailable', 'no live bid/ask/mark quote — refusing to price a market fill');
    }
    // Re-solve sizing at the REAL fill price so the 1 % risk cap is enforced
    // on the number that will actually be paid, not on the caller's estimate.
    const filled = resolvePaperSizing({
        entryPrice: fill.price,
        stopLoss: input.stop_loss as number,
        side: input.side,
        equityUsd: equity,
        freeMarginUsd: paperFreeMargin(next),
        riskPct: input.risk_pct,
        notionalUsd: input.notional_usd,
        leverage: input.leverage,
        limits: next.config,
    });
    if (!filled.ok) return refuse(filled.error, filled.reason);
    const position: PaperPosition = {
        id: idFor('pos'), symbol, side: input.side,
        qty: filled.value.qty, entryPrice: fill.price,
        liquidationPrice: isolatedLiquidationPrice(fill.price, input.side, filled.value.leverage),
        stopLoss: input.stop_loss as number,
        takeProfits: input.take_profits ?? [],
        leverage: filled.value.leverage,
        marginUsd: filled.value.marginUsd,
        riskUsd: filled.value.riskUsd,
        entryFeeUsd: filled.value.notionalUsd * (next.config.takerFeeBps / 10_000),
        openedAt: nowMs,
        fundingPaidUsd: 0,
        lastFundingSlotMs: nowMs,
        closedQty: 0,
        ...(input.skill_slug ? { skillSlug: input.skill_slug } : {}),
        ...(input.thesis ? { thesis: input.thesis } : {}),
    };
    next.cashBalanceUsd -= position.entryFeeUsd;
    next.positions.push(position);
    events.push({
        type: 'entry_fill', symbol, positionId: position.id, price: fill.price,
        at: nowMs,
        line: `Paper ${input.side.toUpperCase()} ${symbol} · ${round6(position.qty)} @ ${roundPrice(fill.price)} · SL ${roundPrice(position.stopLoss)} ›`,
    });
    return {
        ok: true, action: input.action, kind: 'paper_fill', events, account: next,
        positionId: position.id, fillFallback: fill.fallback,
        message: fill.fallback ? fill.note : undefined,
        view: paperAccountView(next, {}, nowMs),
    };
};
