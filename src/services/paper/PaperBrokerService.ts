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

import { getPreference, setPreference } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';
import { ensureKnownSymbol, fetchMarkIndex, fetchOrderBookDepth, fetchFuturesTicker24h } from '../analysis/MarketDataService';
import { evaluatePlanLocalSync } from '../trade/proposalGate';
import { fallbackAdversaryVerdict } from '../trade/adversaryReview';
import {
    createPaperAccount,
    normalizePaperConfig,
    evaluatePaperTick as evaluateTickCore,
    placePaperOrder as placeOrderCore,
    paperAccountView,
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
} from './paperCore';

const STORE_KEY_PREFIX = 'paper_account_v1_';

const storeKey = (username: string): string => `${STORE_KEY_PREFIX}${username}`;

/** Read-modify-write calls share ONE chain (curatedMemory idiom). Reads stay
 *  lock-free: a snapshot is explicitly point-in-time; only the mutation is
 *  serialized, so two concurrent fills cannot clobber each other. */
let writeChain: Promise<unknown> = Promise.resolve();

export const withPaperWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
};

/** Rebuild a usable account from ANY stored shape; a corrupt blob is a fresh
 *  account, never a partially trusted one. */
const normalizeStoredAccount = (raw: string | null, nowMs: number): PaperAccount => {
    if (!raw) return createPaperAccount(null, nowMs);
    try {
        const parsed = JSON.parse(raw) as Partial<PaperAccount> | null;
        if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
            return createPaperAccount(null, nowMs);
        }
        const config = normalizePaperConfig(parsed.config);
        const fresh = createPaperAccount(config, nowMs);
        const positions = Array.isArray(parsed.positions)
            ? parsed.positions.filter(p => p && typeof p.id === 'string' && typeof p.symbol === 'string'
                && Number.isFinite(p.qty) && p.qty > 0 && Number.isFinite(p.entryPrice) && p.entryPrice > 0
                && Number.isFinite(p.stopLoss) && Number.isFinite(p.leverage) && p.leverage >= 1
                && (p.side === 'long' || p.side === 'short'))
            : [];
        const pendingOrders = Array.isArray(parsed.pendingOrders)
            ? parsed.pendingOrders.filter(o => o && typeof o.id === 'string' && typeof o.symbol === 'string'
                && Number.isFinite(o.limitPrice) && o.limitPrice > 0
                && Number.isFinite(o.qty) && o.qty > 0
                && (o.side === 'long' || o.side === 'short'))
            : [];
        const closedTrades = Array.isArray(parsed.closedTrades)
            ? parsed.closedTrades.filter(t => t && typeof t.positionId === 'string'
                && typeof t.symbol === 'string' && Number.isFinite(t.qty)
                && Number.isFinite(t.entryPrice) && Number.isFinite(t.exitPrice)
                && Number.isFinite(t.netPnlUsd) && Number.isFinite(t.closedAt))
            : [];
        return {
            ...fresh,
            cashBalanceUsd: typeof parsed.cashBalanceUsd === 'number' && Number.isFinite(parsed.cashBalanceUsd)
                ? parsed.cashBalanceUsd : fresh.cashBalanceUsd,
            positions,
            pendingOrders,
            closedTrades,
            dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : fresh.dayKey,
            dayStartEquityUsd: typeof parsed.dayStartEquityUsd === 'number' && Number.isFinite(parsed.dayStartEquityUsd)
                ? parsed.dayStartEquityUsd : fresh.dayStartEquityUsd,
            killSwitchActive: parsed.killSwitchActive === true,
        };
    } catch {
        return createPaperAccount(null, nowMs);
    }
};

export const getPaperAccount = async (
    username: string = getActiveUsername() || 'default',
    nowMs: number = Date.now(),
): Promise<PaperAccount> => normalizeStoredAccount(await getPreference(storeKey(username)), nowMs);

const persistAccount = async (
    account: PaperAccount,
    username: string = getActiveUsername() || 'default',
): Promise<void> => {
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

export const livePaperQuote = async (symbol: string): Promise<{ quote: PaperQuote; mark: number | null }> => {
    const [book, markInfo, ticker] = await Promise.all([
        fetchOrderBookDepth(symbol).catch(() => null),
        fetchMarkIndex(symbol).catch(() => null),
        fetchFuturesTicker24h(symbol).catch(() => null),
    ]);
    const mark = markInfo?.available && markInfo.markPrice > 0 ? markInfo.markPrice : null;
    const quote: PaperQuote = {
        ...(book ? { depth: { bids: book.bids, asks: book.asks } } : {}),
        ...(book?.bestBid ? { bestBid: book.bestBid } : {}),
        ...(book?.bestAsk ? { bestAsk: book.bestAsk } : {}),
        ...(mark !== null ? { last: mark } : (ticker?.currentPrice ? { last: ticker.currentPrice } : {})),
    };
    return { quote, mark };
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
    /** Injectable for offline tests and probes; production uses public REST. */
    quoteProvider?: (symbol: string) => Promise<{ quote: PaperQuote; mark: number | null }>;
    /** Injectable symbol gate; production calls ensureKnownSymbol (network). */
    knownSymbol?: (symbol: string) => Promise<boolean>;
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

        const receipt = placeOrderCore({
            account, input, quote, nowMs,
            nextId: deps.nextId,
            planAllowed: () => ({ ok: true }), // already applied above, once
        });
        if (!receipt.ok || !receipt.account) {
            return { ...receipt, view: paperAccountView(account, {}, nowMs) };
        }
        await persistAccount(receipt.account, username);
        if (receipt.settlements?.length) publishSettlements(receipt.settlements);
        return {
            ...receipt,
            view: paperAccountView(receipt.account, {}, nowMs),
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
    const fullTick: PaperTick = { ...tick, symbol };
    return withPaperWriteLock(async () => {
        const account = await getPaperAccount(user, fullTick.timestamp);
        const outcome = evaluateTickCore(account, fullTick);
        if (outcome.events.length === 0) return outcome;
        await persistAccount(outcome.account, user);
        if (outcome.settlements.length) publishSettlements(outcome.settlements);
        return outcome;
    });
};

// ── live tick monitor ───────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorBusy = false;

/** One sweep: settle SL/TP/liquidation and accrue funding for every symbol
 *  that actually has paper exposure, from the PUBLIC mark/last. This never
 *  opens an order, needs no socket, and skips symbols with nothing at risk. */
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
        for (const symbol of symbols) {
            const [markInfo, ticker] = await Promise.all([
                fetchMarkIndex(symbol).catch(() => null),
                fetchFuturesTicker24h(symbol).catch(() => null),
            ]);
            const mark = markInfo?.available && markInfo.markPrice > 0 ? markInfo.markPrice : null;
            const last = ticker?.currentPrice && ticker.currentPrice > 0 ? ticker.currentPrice : mark;
            if (mark === null && last === null) continue;
            await evaluatePaperTick(symbol, {
                timestamp: Date.now(),
                ...(last !== null ? { price: last, high: last, low: last } : {}),
                ...(mark !== null ? { markPrice: mark } : {}),
                fundingRate: markInfo?.lastFundingRate ?? null,
            });
        }
    } catch { /* a failed sweep is retried on the next interval */ }
    finally { monitorBusy = false; }
};

/**
 * Start the deterministic monitor against live public marks. Returns a stop
 * function; idempotent, so several surfaces can call it safely.
 */
export const startPaperTickMonitor = (intervalMs: number = 30_000): (() => void) => {
    if (monitorTimer !== null) return () => { /* already running */ };
    monitorTimer = setInterval(() => { void runPaperTickSweep(); }, Math.max(5_000, intervalMs));
    void runPaperTickSweep();
    return () => {
        if (monitorTimer !== null) { clearInterval(monitorTimer); monitorTimer = null; }
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
