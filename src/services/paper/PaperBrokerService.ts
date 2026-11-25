/**
 * PaperBrokerService — the single writer of the local paper account.
 *
 * The pure math lives in `paperCore`; this module adds ONLY the three things a
 * pure function cannot have: a per-user durable store behind one serialized
 * write chain, live public market quotes, and the journal settlement bridge.
 *
 * ANTI-REWARD-HACKING: there is no tool, prompt or code path from the seat to
 * equity. `resetPaperAccountForUser` and `updatePaperConfigForUser` are
 * Settings-only exports; no desk tool imports them. Closed trades are
 * append-only in the authoritative ledger and cannot be edited or deleted.
 */

import { getPreference, setPreference, getAllKeys, removePreference } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';
import { BINANCE_FUTURES_WS } from '../../config/exchangeEndpoints';
import { ensureKnownSymbol, fetchMarkIndex, fetchOrderBookDepth, fetchFuturesTicker24h } from '../analysis/MarketDataService';
import { evaluatePlanLocalSync } from '../trade/proposalGate';
import { fallbackAdversaryVerdict } from '../trade/adversaryReview';
import {
    getPaperLiveFrame, consumePaperLiveFrame, getAllPaperFundingFrames,
    subscribePaperLiveTicks, registerLivePaperFeed as registerLiveFeedOwner,
    shouldOpenPaperWs, unwrapCombined, publishPaperMark, publishPaperKline, publishPaperTicker,
    parseMarkPrice, parseKline, parseTicker,
    PAPER_FRAME_FRESH_MS,
    type PaperLiveFrame,
} from '../trade/futuresStreams';
import {
    createPaperAccount,
    normalizePaperConfig,
    evaluatePaperTick as evaluateTickCore,
    placePaperOrder as placeOrderCore,
    paperAccountView,
    isolatedLiquidationPrice,
    utcFundingSlotsBetween,
    PAPER_ORDER_ACTIONS,
    type PaperAccount,
    type PaperAccountConfig,
    type PaperAccountView,
    type PaperOrderInput,
    type PaperQuote,
    type PaperReceipt,
    type PaperSettledTrade,
    type PaperTick,
    type PaperTickOutcome,
    type PaperFundingFrame,
} from './paperCore';

const STORE_KEY_PREFIX = 'paper_account_v1_';
/** Distinct key for a preserved, untrusted raw payload. Never overwritten by
 *  the live account key, so a corrupt blob cannot be silently erased. */
const CORRUPT_KEY_PREFIX = 'paper_account_corrupt_v1_';

const storeKey = (username: string): string => `${STORE_KEY_PREFIX}${username}`;

/** The most recent corruption the loader refused, or null. Mirrors
 *  `MemoryFilesService.getNotebookWriteFailure()`: a sticky, user-visible
 *  surface for bytes that were NOT trusted. The UI must render this. */
export interface PaperCorruptionWarning {
    atMs: number;
    username: string;
    key: string;
    reason: string;
    bytes: number;
}
let corruptionWarning: PaperCorruptionWarning | null = null;
export const getPaperCorruptionWarning = (): PaperCorruptionWarning | null => corruptionWarning;
export const resetPaperCorruptionWarning = (): void => { corruptionWarning = null; };

const flagCorrupt = async (raw: string, username: string, reason: string): Promise<void> => {
    corruptionWarning = { atMs: Date.now(), username, key: storeKey(username), reason, bytes: raw.length };
    console.error(`[PaperBroker] stored account for "${username}" was NOT trusted (${reason}); `
        + 'a fresh account is in memory and the raw bytes are quarantined.');
    try {
        const key = `${CORRUPT_KEY_PREFIX}${username}_${Date.now()}`;
        await setPreference(key, JSON.stringify({
            capturedAt: new Date().toISOString(),
            sourceKey: storeKey(username),
            reason,
            raw,
        }));
        // A repaired account is re-read until the next write; cap the
        // sidecars so the warning never becomes an unbounded store leak.
        const keys = (await getAllKeys())
            .filter(k => k.startsWith(`${CORRUPT_KEY_PREFIX}${username}_`))
            .sort();
        for (const old of keys.slice(0, Math.max(0, keys.length - 5))) {
            await removePreference(old).catch(() => { /* best-effort */ });
        }
    } catch (e) {
        // A sidecar is a second chance, never a reason to break boot.
        console.warn('[PaperBroker] Could not preserve a corrupt paper account sidecar:', e);
    }
};

/** Read-modify-write calls share ONE chain (curatedMemory idiom). Reads stay
 *  lock-free: a snapshot is explicitly point-in-time; only the mutation is
 *  serialized, so two concurrent fills cannot clobber each other. */
let writeChain: Promise<unknown> = Promise.resolve();

export const withPaperWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
};

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOr = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
    isFiniteNum(v) && v >= min && v <= max ? v : fallback;
const tpList = (v: unknown, issues: string[], field: string): number[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { issues.push(`${field} is not an array`); return []; }
    const out = v.filter(t => isFiniteNum(t) && t > 0);
    if (out.length !== v.length) issues.push(`${field} contains a non-finite or non-positive level`);
    return out;
};

/**
 * Rebuild a usable account from ANY stored shape. Unlike the old version this
 * NEVER silently returns a fresh $10k account: the raw bytes are quarantined
 * under a distinct key and a sticky warning is raised. Every field used
 * downstream is validated; the two migration defects are REPAIRED in place —
 * a missing liquidation price is re-derived from entry/side/leverage (so the
 * position still liquidates) and a missing funding slot falls back to the
 * opening time (so accrual resumes instead of stalling forever).
 */
const normalizeStoredAccount = async (
    raw: string | null,
    username: string,
    nowMs: number,
): Promise<PaperAccount> => {
    if (!raw) return createPaperAccount(null, nowMs);
    const issues: string[] = [];
    let parsed: Partial<PaperAccount> | null;
    try {
        parsed = JSON.parse(raw) as Partial<PaperAccount> | null;
    } catch {
        await flagCorrupt(raw, username, 'invalid JSON');
        return createPaperAccount(null, nowMs);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
        await flagCorrupt(raw, username, 'unsupported account envelope');
        return createPaperAccount(null, nowMs);
    }
    const config = normalizePaperConfig(parsed.config);
    const fresh = createPaperAccount(config, nowMs);

    const positions: PaperAccount['positions'] = [];
    for (const p of (Array.isArray(parsed.positions) ? parsed.positions : []) as any[]) {
        if (!p || typeof p.id !== 'string' || !p.id || typeof p.symbol !== 'string' || !p.symbol
            || (p.side !== 'long' && p.side !== 'short')
            || !isFiniteNum(p.qty) || p.qty <= 0
            || !isFiniteNum(p.entryPrice) || p.entryPrice <= 0
            || !isFiniteNum(p.stopLoss) || !isFiniteNum(p.leverage) || p.leverage < 1) {
            issues.push('an open position failed structural validation and was dropped');
            continue;
        }
        const derivedLiq = isolatedLiquidationPrice(p.entryPrice, p.side, p.leverage);
        const liq = isFiniteNum(p.liquidationPrice) && p.liquidationPrice > 0 ? p.liquidationPrice : derivedLiq;
        if (!(liq > 0)) { issues.push(`position ${p.id} has no usable liquidation price`); continue; }
        if (!(isFiniteNum(p.liquidationPrice) && p.liquidationPrice > 0)) {
            issues.push(`position ${p.id} was missing liquidationPrice — re-derived at ${liq}`);
        }
        const openedAt = numOr(p.openedAt, nowMs, 0);
        const lastFundingSlotMs = isFiniteNum(p.lastFundingSlotMs) && p.lastFundingSlotMs > 0
            ? p.lastFundingSlotMs : openedAt;
        if (!(isFiniteNum(p.lastFundingSlotMs) && p.lastFundingSlotMs > 0)) {
            issues.push(`position ${p.id} was missing lastFundingSlotMs — resumed from openedAt`);
        }
        positions.push({
            id: p.id, symbol: p.symbol, side: p.side,
            qty: p.qty, entryPrice: p.entryPrice, liquidationPrice: liq,
            stopLoss: p.stopLoss,
            takeProfits: tpList(p.takeProfits, issues, `position ${p.id} takeProfits`),
            leverage: p.leverage,
            marginUsd: numOr(p.marginUsd, p.qty * p.entryPrice / p.leverage, 0),
            riskUsd: numOr(p.riskUsd, 0, 0),
            entryFeeUsd: numOr(p.entryFeeUsd, 0, 0),
            openedAt,
            fundingPaidUsd: numOr(p.fundingPaidUsd, 0),
            lastFundingSlotMs,
            closedQty: numOr(p.closedQty, 0, 0),
            ...(typeof p.skillSlug === 'string' ? { skillSlug: p.skillSlug } : {}),
            ...(typeof p.thesis === 'string' ? { thesis: p.thesis } : {}),
        });
    }

    const pendingOrders: PaperAccount['pendingOrders'] = [];
    for (const o of (Array.isArray(parsed.pendingOrders) ? parsed.pendingOrders : []) as any[]) {
        if (!o || typeof o.id !== 'string' || !o.id || typeof o.symbol !== 'string' || !o.symbol
            || (o.side !== 'long' && o.side !== 'short')
            || !isFiniteNum(o.limitPrice) || o.limitPrice <= 0
            || !isFiniteNum(o.qty) || o.qty <= 0
            || !isFiniteNum(o.stopLoss) || !isFiniteNum(o.leverage) || o.leverage < 1) {
            issues.push('a resting order failed structural validation and was dropped');
            continue;
        }
        pendingOrders.push({
            id: o.id, symbol: o.symbol, side: o.side, limitPrice: o.limitPrice, qty: o.qty,
            stopLoss: o.stopLoss,
            takeProfits: tpList(o.takeProfits, issues, `order ${o.id} takeProfits`),
            leverage: o.leverage,
            riskUsd: numOr(o.riskUsd, 0, 0),
            createdAt: numOr(o.createdAt, nowMs, 0),
            ...(typeof o.skillSlug === 'string' ? { skillSlug: o.skillSlug } : {}),
            ...(typeof o.thesis === 'string' ? { thesis: o.thesis } : {}),
        });
    }

    // The closed ledger is authoritative and append-only: never fabricate a
    // settlement row. A row missing any field used downstream is refused.
    const closedTrades: PaperAccount['closedTrades'] = [];
    for (const t of (Array.isArray(parsed.closedTrades) ? parsed.closedTrades : []) as any[]) {
        const ok = t && typeof t.positionId === 'string' && typeof t.symbol === 'string'
            && (t.side === 'long' || t.side === 'short')
            && [t.qty, t.entryPrice, t.exitPrice, t.grossPnlUsd, t.feesUsd, t.fundingPaidUsd,
                t.netPnlUsd, t.rMultiple, t.openedAt, t.closedAt, t.leverage].every(isFiniteNum)
            && ['sl', 'tp', 'manual_close', 'liquidation'].includes(t.exitReason);
        if (!ok) { issues.push('a closed settlement failed validation and was dropped'); continue; }
        closedTrades.push({
            ...t,
            closedQty: numOr(t.closedQty, t.qty, 0),
            takeProfits: tpList(t.takeProfits, issues, `settlement ${t.positionId} takeProfits`),
        });
    }

    if (issues.length > 0) await flagCorrupt(raw, username, issues.join('; '));
    return {
        ...fresh,
        cashBalanceUsd: numOr(parsed.cashBalanceUsd, fresh.cashBalanceUsd),
        positions,
        pendingOrders,
        closedTrades,
        dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : fresh.dayKey,
        dayStartEquityUsd: numOr(parsed.dayStartEquityUsd, fresh.dayStartEquityUsd),
        killSwitchActive: parsed.killSwitchActive === true,
    };
};

/** Synchronous in-memory cache of the last loaded/persisted paper account view (zero I/O, zero network). */
let cachedPaperAccount: { username: string; account: PaperAccount } | null = null;

export const getCachedPaperAccountView = (
    username: string = getActiveUsername() || 'default',
    nowMs: number = Date.now(),
): PaperAccountView | null => {
    if (!cachedPaperAccount || cachedPaperAccount.username !== username) return null;
    return paperAccountView(cachedPaperAccount.account, {}, nowMs);
};

export const getPaperAccount = async (
    username: string = getActiveUsername() || 'default',
    nowMs: number = Date.now(),
): Promise<PaperAccount> => {
    const account = await normalizeStoredAccount(await getPreference(storeKey(username)), username, nowMs);
    cachedPaperAccount = { username, account };
    return account;
};

const persistAccount = async (
    account: PaperAccount,
    username: string = getActiveUsername() || 'default',
): Promise<void> => {
    cachedPaperAccount = { username, account };
    await setPreference(storeKey(username), JSON.stringify(account));
    notifySubscribers(account);
};

// ── UI barometer ────────────────────────────────────────────────────────────

type PaperListener = (account: PaperAccount) => void;
const subscribers = new Set<PaperListener>();

export const subscribePaperAccount = (fn: PaperListener): (() => void) => {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
};

const notifySubscribers = (account: PaperAccount): void => {
    for (const fn of subscribers) {
        try { fn(account); } catch { /* a subscriber must not break a write */ }
    }
};

/** Ask every subscriber to re-read (e.g. after an external config change). */
export const refreshPaperAccount = async (username?: string): Promise<void> => {
    notifySubscribers(await getPaperAccount(username));
};

// ── journal settlement bridge ───────────────────────────────────────────────

type JournalSink = (settlements: PaperSettledTrade[]) => void;
const journalSinks = new Set<JournalSink>();

/**
 * App registers once on mount. The sink is a VIEW bridge only — the broker's
 * closed ledger remains authoritative, so a settlement that closes while no
 * surface is mounted is replayed by `mergePaperSettlements` on the next mount.
 */
export const registerPaperJournalSink = (fn: JournalSink): (() => void) => {
    journalSinks.add(fn);
    return () => { journalSinks.delete(fn); };
};

const publishSettlements = (settlements: PaperSettledTrade[]): void => {
    if (settlements.length === 0) return;
    for (const sink of journalSinks) {
        try { sink(settlements); } catch { /* never fail a fill because a view threw */ }
    }
};

export const getPaperSettlements = async (
    username?: string,
): Promise<PaperSettledTrade[]> => (await getPaperAccount(username)).closedTrades;

// ── live quote adapter ──────────────────────────────────────────────────────

export interface PaperLiveQuote {
    quote: PaperQuote;
    mark: number | null;
    /** Funding + mark map for EVERY held symbol, from the shared WS cache. */
    fundingRate?: number | null;
    fundingFrames?: PaperFundingFrame[];
    markPrices?: Readonly<Record<string, number>>;
}

/** Collect live marks for every held symbol: cached WS frames first, the
 *  just-fetched quote second. A symbol with neither stays absent — sizing then
 *  deliberately values it at entry rather than inventing a mark. */
export const livePaperMarks = (
    symbols: ReadonlyArray<string>,
    symbol: string,
    mark: number | null,
): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of symbols) {
        const frame = getPaperLiveFrame(s, PAPER_FRAME_FRESH_MS);
        const m = frame?.mark ?? (s === symbol ? mark : null);
        if (m !== null && Number.isFinite(m) && m > 0) out[s] = m;
    }
    return out;
};

export const livePaperQuote = async (symbol: string): Promise<PaperLiveQuote> => {
    const [book, markInfo, ticker] = await Promise.all([
        fetchOrderBookDepth(symbol).catch(() => null),
        fetchMarkIndex(symbol).catch(() => null),
        fetchFuturesTicker24h(symbol).catch(() => null),
    ]);
    const cached = getPaperLiveFrame(symbol, PAPER_FRAME_FRESH_MS);
    const mark = markInfo?.available && markInfo.markPrice > 0 ? markInfo.markPrice : null;
    const quote: PaperQuote = {
        ...(book ? { depth: { bids: book.bids, asks: book.asks } } : {}),
        ...(book?.bestBid ? { bestBid: book.bestBid } : {}),
        ...(book?.bestAsk ? { bestAsk: book.bestAsk } : {}),
        ...(mark !== null ? { last: mark } : (ticker?.currentPrice ? { last: ticker.currentPrice } : {})),
    };
    return {
        quote, mark,
        ...(cached?.fundingRate !== null && cached?.fundingRate !== undefined
            ? { fundingRate: cached.fundingRate }
            : (markInfo?.lastFundingRate !== undefined ? { fundingRate: markInfo.lastFundingRate } : {})),
        fundingFrames: getAllPaperFundingFrames(symbol),
    };
};

/** Deterministic-first plan gate: inverted levels and a mark already through
 *  the bracket refuse before a single number is persisted. CAUTION is a
 *  warning on a receipt, never a silent veto. */
export const paperPlanGate = (
    input: PaperOrderInput,
    mark: number | null,
): { ok: boolean; reason?: string; warnings: string[] } => {
    const tps = (input.take_profits ?? []).filter(tp => Number.isFinite(tp) && tp > 0);
    const warnings: string[] = [];
    if (tps.length > 0 && Number.isFinite(input.entry_price) && Number.isFinite(input.stop_loss)) {
        const local = evaluatePlanLocalSync({
            symbol: input.symbol ?? '',
            entry: input.entry_price as number,
            stopLoss: input.stop_loss as number,
            takeProfits: tps,
            direction: input.side === 'short' ? 'Short' : 'Long',
        });
        if (local.refusal) {
            // Shape is a HARD gate. The min-edge arm is only advisory here:
            // an execution instruction carries no model probability, and a
            // plan whose expectancy cannot be measured is not a bad plan.
            if (local.inverted || /inverted|no positive target/i.test(local.refusal)) {
                return { ok: false, reason: `plan gate: ${local.refusal}`, warnings };
            }
            warnings.push(`plan gate (no probability supplied): ${local.refusal}`);
        }
        warnings.push(...local.warnings);
    }
    if (Number.isFinite(input.entry_price) && Number.isFinite(input.stop_loss)) {
        const verdict = fallbackAdversaryVerdict({
            plan: {
                planId: 'paper-order',
                symbol: input.symbol ?? '',
                direction: input.side === 'short' ? 'Short' : 'Long',
                entry: input.entry_price as number,
                stopLoss: input.stop_loss as number,
                takeProfits: tps,
            },
            // With no target, the fallback's `target ?? entry` would read the
            // live mark as "already through the target" and veto a perfectly
            // valid stop-only execution. The target check needs a target.
            markPrice: tps.length > 0 ? mark : null,
            atr: null,
            candles: [],
        });
        if (verdict.verdict === 'VETO') {
            return { ok: false, reason: `adversary review VETO: ${verdict.objections[0] ?? 'objective plan defect'}`, warnings };
        }
        if (verdict.verdict === 'CAUTION') warnings.push(...verdict.objections);
    }
    return { ok: true, warnings };
};

// ── the two seat-facing operations ──────────────────────────────────────────

export interface SubmitPaperOrderDeps {
    username?: string;
    nowMs?: number;
    nextId?: (prefix: string) => string;
    /** Injectable for offline tests and probes; production uses public REST
     *  plus the shared WS frame cache. */
    quoteProvider?: (symbol: string) => Promise<PaperLiveQuote>;
    /** Injectable symbol gate; production calls ensureKnownSymbol (network). */
    knownSymbol?: (symbol: string) => Promise<boolean>;
    /** Funding context for the close path (or a test injection). */
    fundingRate?: number | null;
    fundingFrames?: ReadonlyArray<PaperFundingFrame>;
    /** Live marks for EVERY held symbol, injected in offline tests. */
    markPrices?: Readonly<Record<string, number>>;
}

/**
 * Submit one order. The account is read and written inside ONE lock so a
 * concurrent tick cannot settle the same position twice. Every refusal leaves
 * the store byte-for-byte untouched.
 */
export const submitPaperOrder = async (
    input: PaperOrderInput,
    deps: SubmitPaperOrderDeps = {},
): Promise<PaperReceipt> => {
    const username = deps.username ?? getActiveUsername() ?? 'default';
    const nowMs = deps.nowMs ?? Date.now();
    if (!PAPER_ORDER_ACTIONS.includes(input.action)) {
        return { ok: false, error: 'unknown_action', reason: `unsupported paper_order action "${String(input.action)}"` };
    }
    const needsQuote = input.action === 'open_market' || input.action === 'close';
    let quote: PaperQuote = {};
    let mark: number | null = null;
    let fundingRate: number | null | undefined = deps.fundingRate;
    let fundingFrames: ReadonlyArray<PaperFundingFrame> | undefined = deps.fundingFrames;
    if (needsQuote) {
        const symbol = String(input.symbol ?? '').trim().toUpperCase();
        const provided = deps.quoteProvider
            ? await deps.quoteProvider(symbol).catch(() => null)
            : await livePaperQuote(symbol).catch(() => null);
        if (!provided) {
            return { ok: false, error: 'quote_unavailable', reason: 'live market quote unavailable — refusing to price a fill' };
        }
        quote = provided.quote;
        mark = provided.mark;
        if (fundingRate === undefined) fundingRate = provided.fundingRate;
        if (fundingFrames === undefined) fundingFrames = provided.fundingFrames;
    } else if (Number.isFinite(input.entry_price)) {
        mark = input.entry_price as number;
    }

    return withPaperWriteLock(async () => {
        const account = await getPaperAccount(username, nowMs);
        if (!account.config.enabled) {
            return { ok: false, error: 'paper_mode_disabled', reason: 'Paper Mode is off in Settings — no order was placed' };
        }
        if (deps.knownSymbol && typeof input.symbol === 'string') {
            const known = await deps.knownSymbol(input.symbol.trim().toUpperCase());
            if (!known) {
                return {
                    ok: false, error: 'unknown_symbol',
                    reason: `symbol "${input.symbol}" is not a TRADING USDT perpetual in the live universe`,
                };
            }
        } else if (typeof input.symbol === 'string' && input.symbol.trim()) {
            try {
                await ensureKnownSymbol(input.symbol.trim().toUpperCase());
            } catch (error) {
                return {
                    ok: false, error: 'unknown_symbol',
                    reason: error instanceof Error ? error.message : 'unknown symbol',
                };
            }
        }
        const gate = paperPlanGate(input, mark);
        if (!gate.ok) return { ok: false, error: 'plan_refused', reason: gate.reason };

        const tradedSymbol = String(input.symbol ?? '').trim().toUpperCase();
        const markPrices = {
            ...livePaperMarks([
                ...account.positions.map(p => p.symbol),
                ...account.pendingOrders.map(o => o.symbol),
            ], tradedSymbol, mark),
            ...(deps.markPrices ?? {}),
        };
        const receipt = placeOrderCore({
            account, input, quote, nowMs,
            nextId: deps.nextId,
            planAllowed: () => ({ ok: true }), // already applied above, once
            fundingRate,
            fundingFrames,
            markPrices,
        });
        if (!receipt.ok || !receipt.account) {
            return { ...receipt, view: paperAccountView(account, markPrices, nowMs) };
        }
        await persistAccount(receipt.account, username);
        if (receipt.settlements?.length) publishSettlements(receipt.settlements);
        return {
            ...receipt,
            view: paperAccountView(receipt.account, markPrices, nowMs),
            ...(gate.warnings.length ? { message: [...gate.warnings, receipt.message ?? ''].filter(Boolean).join(' · ') } : {}),
        };
    });
};

/** Read-only `paper_account` receipt. */
export const paperAccountSnapshot = async (
    username?: string,
    markPrices: Readonly<Record<string, number>> = {},
    nowMs: number = Date.now(),
): Promise<PaperAccountView> => {
    const account = await getPaperAccount(username, nowMs);
    return paperAccountView(account, markPrices, nowMs);
};

/** The deterministic tick monitor, wrapped with the same lock + journal bridge. */
export const evaluatePaperTick = async (
    symbol: string,
    tick: Omit<PaperTick, 'symbol'>,
    username?: string,
): Promise<PaperTickOutcome> => {
    const user = username ?? getActiveUsername() ?? 'default';
    return withPaperWriteLock(async () => {
        const account = await getPaperAccount(user, tick.timestamp);
        const heldMarks = livePaperMarks([
            ...account.positions.map(p => p.symbol),
            ...account.pendingOrders.map(o => o.symbol),
        ], symbol.trim().toUpperCase(), tick.markPrice ?? tick.price ?? null);
        const fullTick: PaperTick = {
            ...tick,
            symbol,
            markPrices: { ...heldMarks, ...(tick.markPrices ?? {}) },
        };
        const outcome = evaluateTickCore(account, fullTick);
        if (outcome.events.length === 0) return outcome;
        await persistAccount(outcome.account, user);
        if (outcome.settlements.length) publishSettlements(outcome.settlements);
        return outcome;
    });
};

// ── live tick monitor ───────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorUnsubscribeTicks: (() => void) | null = null;
let monitorBusy = false;
const pendingLiveSymbols = new Set<string>();
let wsDrainTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Build the tick for ONE sweep. A frame published by the Trade surface (or by
 * the broker's own socket) within PAPER_FRAME_FRESH_MS is authoritative: it
 * carries the intra-window high/low that a 30 s REST poll cannot see. REST is
 * ONLY a stale-frame fallback, and still synthesizes high=low=last there.
 */
export const livePaperTick = async (
    symbol: string,
    nowMs: number = Date.now(),
    consumeWicks = false,
): Promise<PaperTick | null> => {
    const frame: PaperLiveFrame | null = consumeWicks
        ? consumePaperLiveFrame(symbol, PAPER_FRAME_FRESH_MS, nowMs)
        : getPaperLiveFrame(symbol, PAPER_FRAME_FRESH_MS, nowMs);
    if (frame) {
        return {
            symbol, timestamp: nowMs,
            ...(frame.mark !== null ? { markPrice: frame.mark } : {}),
            ...(frame.high !== null ? { high: frame.high } : {}),
            ...(frame.low !== null ? { low: frame.low } : {}),
            ...(frame.last !== null ? { price: frame.last } : {}),
            fundingRate: frame.fundingRate,
            fundingFrames: getAllPaperFundingFrames(symbol),
        };
    }
    const [markInfo, ticker] = await Promise.all([
        fetchMarkIndex(symbol).catch(() => null),
        fetchFuturesTicker24h(symbol).catch(() => null),
    ]);
    const mark = markInfo?.available && markInfo.markPrice > 0 ? markInfo.markPrice : null;
    const last = ticker?.currentPrice && ticker.currentPrice > 0 ? ticker.currentPrice : mark;
    if (mark === null && last === null) return null;
    return {
        symbol, timestamp: nowMs,
        ...(last !== null ? { price: last, high: last, low: last } : {}),
        ...(mark !== null ? { markPrice: mark } : {}),
        fundingRate: markInfo?.lastFundingRate ?? null,
    };
};

/** Broker-owned sockets, at most ONE per symbol. A Trade/Desk feed owns the
 *  same symbol through `registerLivePaperFeed`, which makes shouldOpenPaperWs
 *  false and makes the next sweep close this socket — no duplicates, and no
 *  socket left open once exposure is gone. */
const paperWsSockets = new Map<string, WebSocket>();

export const registerPaperLiveFeed = (symbol: string): (() => void) => registerLiveFeedOwner(symbol);

const syncPaperWs = (exposure: ReadonlySet<string>): void => {
    if (typeof WebSocket === 'undefined') return;
    const desired = new Set(Array.from(exposure).map(s => s.trim().toUpperCase()));
    for (const symbol of desired) {
        const s = symbol.toLowerCase();
        if (!shouldOpenPaperWs(s, true)) {
            const existing = paperWsSockets.get(s);
            if (existing) { try { existing.close(); } catch { /* already gone */ } paperWsSockets.delete(s); }
            continue;
        }
        if (paperWsSockets.has(s)) continue; // idempotent — zero duplicate sockets
        const url = `${BINANCE_FUTURES_WS}/stream?streams=${s}@markPrice@1s/${s}@kline_1s/${s}@ticker`;
        let ws: WebSocket;
        try { ws = new WebSocket(url); } catch { continue; }
        paperWsSockets.set(s, ws);
        ws.onmessage = ev => {
            const msg = unwrapCombined(String(ev.data));
            if (!msg) return;
            const at = Date.now();
            const mi = parseMarkPrice(msg);
            if (mi) { publishPaperMark(symbol, mi.markPrice, mi.fundingRate, at); return; }
            const kl = parseKline(msg);
            if (kl) { publishPaperKline(symbol, kl, at); return; }
            const tk = parseTicker(msg);
            if (tk) publishPaperTicker(symbol, tk.lastPrice, at);
        };
        ws.onclose = () => { paperWsSockets.delete(s); };
        ws.onerror = () => { try { ws.close(); } catch { /* close fires onerror too */ } };
    }
    for (const [s, ws] of paperWsSockets) {
        if (!desired.has(s.toUpperCase())) {
            try { ws.close(); } catch { /* already gone */ }
            paperWsSockets.delete(s);
        }
    }
};

const drainPendingWsTicks = async (): Promise<void> => {
    wsDrainTimer = null;
    if (pendingLiveSymbols.size === 0) return;
    const symbolsToCheck = Array.from(pendingLiveSymbols);
    pendingLiveSymbols.clear();
    try {
        const account = await getPaperAccount();
        if (!account.config.enabled) return;
        const exposed = new Set<string>([
            ...account.positions.map(p => p.symbol.trim().toUpperCase()),
            ...account.pendingOrders.map(o => o.symbol.trim().toUpperCase()),
        ]);
        for (const sym of symbolsToCheck) {
            if (!exposed.has(sym)) continue;
            const frame = consumePaperLiveFrame(sym, PAPER_FRAME_FRESH_MS, Date.now());
            if (!frame) continue;
            await evaluatePaperTick(sym, {
                timestamp: Date.now(),
                ...(frame.mark !== null ? { markPrice: frame.mark } : {}),
                ...(frame.high !== null ? { high: frame.high } : {}),
                ...(frame.low !== null ? { low: frame.low } : {}),
                ...(frame.last !== null ? { price: frame.last } : {}),
                fundingRate: frame.fundingRate,
                fundingFrames: getAllPaperFundingFrames(sym),
            });
        }
    } catch { /* live WS errors recover on next tick or 30s REST fallback */ }
};

/** One sweep: settle SL/TP/liquidation and accrue funding for every symbol
 *  that actually has paper exposure, from fresh WS frames when available and
 *  REST only as a stale-frame fallback. Never opens an order. */
const runPaperTickSweep = async (): Promise<void> => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
        const account = await getPaperAccount();
        if (!account.config.enabled) return;
        const symbols = new Set<string>([
            ...account.positions.map(p => p.symbol),
            ...account.pendingOrders.map(o => o.symbol),
        ]);
        syncPaperWs(symbols);
        for (const symbol of symbols) {
            const tick = await livePaperTick(symbol, Date.now(), true);
            if (!tick) continue;
            const { symbol: _ignored, ...fields } = tick;
            await evaluatePaperTick(symbol, fields);
        }
    } catch { /* a failed sweep is retried on the next interval */ }
    finally { monitorBusy = false; }
};

/**
 * Start the deterministic monitor against live public marks + real-time WS
 * ticks. Returns a stop function; idempotent, so several surfaces can call it.
 */
export const startPaperTickMonitor = (intervalMs: number = 30_000): (() => void) => {
    if (monitorTimer !== null) return () => { /* already running */ };
    monitorUnsubscribeTicks = subscribePaperLiveTicks(sym => {
        pendingLiveSymbols.add(sym);
        if (wsDrainTimer === null) {
            wsDrainTimer = setTimeout(() => { void drainPendingWsTicks(); }, 150);
        }
    });
    monitorTimer = setInterval(() => { void runPaperTickSweep(); }, Math.max(5_000, intervalMs));
    void runPaperTickSweep();
    return () => {
        if (monitorUnsubscribeTicks) { monitorUnsubscribeTicks(); monitorUnsubscribeTicks = null; }
        if (wsDrainTimer !== null) { clearTimeout(wsDrainTimer); wsDrainTimer = null; }
        pendingLiveSymbols.clear();
        if (monitorTimer !== null) { clearInterval(monitorTimer); monitorTimer = null; }
        for (const ws of paperWsSockets.values()) { try { ws.close(); } catch { /* already gone */ } }
        paperWsSockets.clear();
    };
};

// ── Settings-only mutators. NO desk tool imports these. ─────────────────────

export const updatePaperConfigForUser = async (
    patch: Partial<PaperAccountConfig>,
    username?: string,
): Promise<PaperAccount> => {
    const user = username ?? getActiveUsername() ?? 'default';
    return withPaperWriteLock(async () => {
        const account = await getPaperAccount(user);
        const next: PaperAccount = { ...account, config: normalizePaperConfig({ ...account.config, ...patch }) };
        await persistAccount(next, user);
        return next;
    });
};

/** Owner-only. Deliberately NOT part of any tool schema or tool grant. */
export const resetPaperAccountForUser = async (
    username?: string,
    nowMs: number = Date.now(),
): Promise<PaperAccount> => {
    const user = username ?? getActiveUsername() ?? 'default';
    return withPaperWriteLock(async () => {
        const existing = await getPaperAccount(user, nowMs);
        const next = createPaperAccount(existing.config, nowMs);
        await persistAccount(next, user);
        return next;
    });
};

/**
 * Test hooks — deterministic store RESET only. There is deliberately NO
 * whole-account write and no equity/cap setter here: the anti-reward-hacking
 * contract forbids any callable path that edits equity, caps or the closed
 * ledger, and a test shim is the largest surface this module will expose.
 */
export const __paperBrokerTestHooks = {
    storeKey,
    clear: async (username: string): Promise<void> => {
        await withPaperWriteLock(async () => {
            await setPreference(storeKey(username), JSON.stringify(createPaperAccount(null, Date.now())));
        });
    },
};
