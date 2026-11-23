/**
 * paperBroker — offline pins for the local Paper Trading Broker.
 *
 * ZERO network: the deterministic core is pure, and the service is driven
 * with an injected quote provider + symbol gate. Every clock is injected and
 * every test uses its own persisted username (the suite shares one process).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'paper-broker-probe']]);
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storageShim;
g.sessionStorage = storageShim;
g.window = {
    localStorage: storageShim,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
};
g.document = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false };

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const SYMBOL = 'BTCUSDT';
const known = (s: string): boolean => s === SYMBOL;
const quoteAt = (price: number) => ({
    quote: { bestBid: price - 0.1, bestAsk: price + 0.1, last: price },
    mark: price,
});

const core = await import('../src/services/paper/paperCore');
const {
    createPaperAccount, placePaperOrder, evaluatePaperTick, resolvePaperSizing,
    resolveMarketFill, isolatedLiquidationPrice, utcFundingSlotsBetween,
    DEFAULT_PAPER_RISK_LIMITS, PAPER_ORDER_ACTIONS, PAPER_MAKER_FEE_BPS,
    PAPER_TAKER_FEE_BPS,
} = core;
type PaperAccount = import('../src/services/paper/paperCore').PaperAccount;

const openLong = (account: PaperAccount, overrides: Record<string, unknown> = {}) => placePaperOrder({
    account,
    input: {
        action: 'open_market', symbol: SYMBOL, side: 'long',
        notional_usd: 500, leverage: 5, stop_loss: 99,
        take_profits: [101], entry_price: 100,
        ...overrides,
    },
    quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
    nowMs: NOW,
    isKnownSymbol: known,
    nextId: prefix => `${prefix}-test`,
});

// ─── market fill + fees ─────────────────────────────────────────────────────

describe('paper fills — L2 walk, taker fee, flagged fallback', () => {
    it('walks the live L2 ladder and charges 0.05% taker on full notional', () => {
        const depth = {
            bids: [{ price: 99.9, qty: 10 }, { price: 99.8, qty: 10 }],
            asks: [{ price: 100.1, qty: 10 }, { price: 100.2, qty: 10 }],
        };
        const fill = resolveMarketFill('long', 500, { depth });
        assert.equal(fill?.source, 'l2');
        assert.equal(fill?.fallback, false);
        assert.ok(Math.abs((fill?.price ?? 0) - 100.1) < 0.01);

        const receipt = placePaperOrder({
            account: createPaperAccount(null, NOW),
            input: { action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { depth, bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: NOW,
            isKnownSymbol: known,
            nextId: prefix => `${prefix}-l2`,
        });
        assert.equal(receipt.ok, true);
        const position = receipt.account?.positions[0];
        assert.ok(position);
        const expectedFee = position.entryPrice * position.qty * (PAPER_TAKER_FEE_BPS / 10_000);
        assert.ok(Math.abs(position.entryFeeUsd - expectedFee) < 1e-6);
        assert.equal(receipt.fillFallback, false);
    });

    it('flags a thin/absent book instead of presenting a fallback as a live fill', () => {
        const thin = resolveMarketFill('short', 500, {
            depth: { bids: [{ price: 99, qty: 0.01 }], asks: [{ price: 101, qty: 0.01 }] },
            bestBid: 99, bestAsk: 101,
        });
        assert.equal(thin?.source, 'spread_fallback');
        assert.equal(thin?.fallback, true);
        assert.ok(thin?.note && thin.note.length > 0);
        const lastOnly = resolveMarketFill('long', 500, { last: 100 });
        assert.equal(lastOnly?.source, 'price_fallback');
        assert.equal(lastOnly?.fallback, true);
        assert.equal(resolveMarketFill('long', 500, {}), null);
    });
});

// ─── strict-cross limits ────────────────────────────────────────────────────

describe('resting limits fill only on a STRICT cross', () => {
    it('a mere touch does not fill; a cross fills at the limit with a maker fee', () => {
        const account = createPaperAccount(null, NOW);
        const placed = placePaperOrder({
            account,
            input: { action: 'open_limit', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: {}, nowMs: NOW, isKnownSymbol: known,
            nextId: prefix => `${prefix}-limit`,
        });
        assert.equal(placed.ok, true);
        assert.equal(placed.account?.pendingOrders.length, 1);

        const touch = evaluatePaperTick(placed.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 100, low: 100, price: 100,
        });
        assert.equal(touch.account.pendingOrders.length, 1, 'touch must NOT fill');
        assert.equal(touch.events.length, 0);

        const cross = evaluatePaperTick(placed.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 2000, high: 100, low: 99.9, price: 99.9,
        });
        assert.equal(cross.account.pendingOrders.length, 0);
        assert.equal(cross.account.positions.length, 1);
        const pos = cross.account.positions[0];
        assert.equal(pos.entryPrice, 100, 'maker never pays worse than the limit');
        const fee = pos.entryPrice * pos.qty * (PAPER_MAKER_FEE_BPS / 10_000);
        assert.ok(Math.abs(pos.entryFeeUsd - fee) < 1e-6);
        assert.equal(cross.events[0].type, 'pending_fill');
    });

    it('a short limit fills on high > limit, not on a touch', () => {
        const placed = placePaperOrder({
            account: createPaperAccount(null, NOW),
            input: { action: 'open_limit', symbol: SYMBOL, side: 'short', notional_usd: 500,
                leverage: 5, stop_loss: 101, entry_price: 100 },
            quote: {}, nowMs: NOW, isKnownSymbol: known,
        });
        const touch = evaluatePaperTick(placed.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1, high: 100, low: 100,
        });
        assert.equal(touch.account.positions.length, 0);
        const cross = evaluatePaperTick(placed.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 2, high: 100.1, low: 100,
        });
        assert.equal(cross.account.positions.length, 1);
    });
});

// ─── exits ──────────────────────────────────────────────────────────────────

describe('deterministic exits', () => {
    it('SL takes adverse slippage + taker fee and settles exitReason=sl', () => {
        const opened = openLong(createPaperAccount(null, NOW));
        assert.equal(opened.ok, true);
        const outcome = evaluatePaperTick(opened.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 60_000, high: 100.2, low: 98.9, price: 98.9,
        });
        assert.equal(outcome.account.positions.length, 0);
        assert.equal(outcome.settlements.length, 1);
        const s = outcome.settlements[0];
        assert.equal(s.exitReason, 'sl');
        assert.ok(s.exitPrice < 99, 'stop fill must be worse than the stop');
        assert.ok(Math.abs(s.exitPrice - 98.9 * (1 - 5 / 10_000)) < 0.02);
        assert.equal(s.side, 'long');
        assert.ok(s.feesUsd > 0);
    });

    it('resting TP fills at the target with a maker fee', () => {
        const opened = openLong(createPaperAccount(null, NOW));
        const outcome = evaluatePaperTick(opened.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 60_000, high: 101.1, low: 100.1, price: 101.1,
        });
        assert.equal(outcome.settlements.length, 1);
        const s = outcome.settlements[0];
        assert.equal(s.exitReason, 'tp');
        assert.equal(s.exitPrice, 101);
        assert.ok(s.netPnlUsd > 0);
    });

    it('liquidation needs a MARK breach — a price wick alone never liquidates', () => {
        const opened = openLong(createPaperAccount(null, NOW), { leverage: 10 });
        const pos = (opened.account as PaperAccount).positions[0];
        const liq = isolatedLiquidationPrice(pos.entryPrice, 'long', 10);
        assert.ok(liq > 0);

        const wickOnly = evaluatePaperTick(opened.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 105, low: liq - 1, price: 100,
            // deliberately NO markPrice: a wick is not a liquidation
        });
        assert.equal(wickOnly.settlements.length, 1, 'the wick still hits the SL — that is a stop, not a liquidation');
        assert.notEqual(wickOnly.settlements[0].exitReason, 'liquidation');

        const withMark = openLong(createPaperAccount(null, NOW), { leverage: 10 });
        const outcome = evaluatePaperTick(withMark.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 105, low: 105, price: 105,
            markPrice: liq - 0.1,
        });
        assert.equal(outcome.settlements.length, 1);
        assert.equal(outcome.settlements[0].exitReason, 'liquidation');
    });

    it('accrues 8h funding at UTC boundaries, signed by side', () => {
        assert.deepEqual(
            utcFundingSlotsBetween(Date.parse('2026-11-22T07:30:00Z'), Date.parse('2026-11-22T16:30:00Z')),
            [Date.parse('2026-11-22T08:00:00Z'), Date.parse('2026-11-22T16:00:00Z')],
        );
        const openedAt = Date.parse('2026-11-22T07:00:00Z');
        const made = placePaperOrder({
            account: createPaperAccount(null, openedAt),
            input: { action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: openedAt, isKnownSymbol: known, nextId: prefix => `${prefix}-fund`,
        });
        const before = (made.account as PaperAccount).cashBalanceUsd;
        const funded = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-22T09:00:00Z'), price: 100,
            fundingRate: 0.0001,
        });
        const pos = funded.account.positions[0];
        assert.equal(pos.fundingPaidUsd > 0, true, 'a long PAYS positive funding');
        assert.ok(funded.account.cashBalanceUsd < before);
        assert.equal(funded.events.filter(e => e.type === 'funding').length, 1);

        const shortAccount = createPaperAccount(null, openedAt);
        const shortMade = placePaperOrder({
            account: shortAccount,
            input: { action: 'open_market', symbol: SYMBOL, side: 'short', notional_usd: 500,
                leverage: 5, stop_loss: 101, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: openedAt, isKnownSymbol: known, nextId: prefix => `${prefix}-shortfund`,
        });
        const shortFunded = evaluatePaperTick(shortMade.account as PaperAccount, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-22T09:00:00Z'), price: 100,
            fundingRate: 0.0001,
        });
        // Signed funding: a SHORT that RECEIVES credit records a NEGATIVE
        // `fundingPaidUsd`. A 0 here used to hide the credit from `netPnl`,
        // which broke the `cash = start + netPnl` invariant.
        assert.ok(shortFunded.account.positions[0].fundingPaidUsd < 0,
            'a short RECEIVES positive funding, recorded as a signed negative payment');
        assert.ok(shortFunded.account.cashBalanceUsd > shortMade.account!.cashBalanceUsd,
            'a short RECEIVES positive funding');
    });
});

// ─── hard gates ─────────────────────────────────────────────────────────────

describe('hard execution gates refuse with zero mutation', () => {
    const base = { action: 'open_market' as const, symbol: SYMBOL, side: 'long' as const,
        entry_price: 100, stop_loss: 99, notional_usd: 500, leverage: 5 };
    const quote = { bestBid: 99.9, bestAsk: 100.1, last: 100 };

    it('refuses >1% risk, >10x leverage, unknown symbol and inverted geometry', () => {
        const account = createPaperAccount(null, NOW);
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ notional_usd: 20_000 }, 'risk_exceeded'],
            [{ leverage: 20 }, 'leverage_exceeded'],
            [{ stop_loss: 101 }, 'inverted_stop'],
            [{ symbol: 'FAKEUSDT' }, 'unknown_symbol'],
            [{ side: 'short' }, 'inverted_stop'],
        ];
        for (const [patch, error] of cases) {
            const receipt = placePaperOrder({
                account, input: { ...base, ...patch }, quote, nowMs: NOW,
                isKnownSymbol: known,
            });
            assert.equal(receipt.ok, false, JSON.stringify(patch));
            assert.equal(receipt.error, error, JSON.stringify(patch));
            assert.ok(receipt.reason && receipt.reason.length > 0);
        }
        assert.equal(account.cashBalanceUsd, 10_000, 'refusals never mutate the caller state');
        assert.equal(account.positions.length, 0);
    });

    it('refuses a fourth concurrent position and a -3% daily kill-switch', () => {
        const filled = openLong(createPaperAccount(null, NOW));
        const account = filled.account as PaperAccount;
        for (let i = 0; i < 2; i += 1) {
            const more = placePaperOrder({ account, input: { ...base }, quote, nowMs: NOW, isKnownSymbol: known });
            assert.equal(more.ok, true);
            Object.assign(account, more.account);
        }
        const fourth = placePaperOrder({ account, input: { ...base }, quote, nowMs: NOW, isKnownSymbol: known });
        assert.equal(fourth.error, 'max_positions');

        const dead = createPaperAccount(null, NOW);
        dead.cashBalanceUsd = 9700;
        dead.dayStartEquityUsd = 10_000;
        const killed = evaluatePaperTick(dead, { symbol: SYMBOL, timestamp: NOW + 1, price: 100 });
        assert.equal(killed.account.killSwitchActive, true);
        const blocked = placePaperOrder({
            account: killed.account, input: { ...base }, quote, nowMs: NOW + 2, isKnownSymbol: known,
        });
        assert.equal(blocked.error, 'kill_switch_active');
    });

    it('the sizing gate fails closed on non-finite and missing size', () => {
        const limits = DEFAULT_PAPER_RISK_LIMITS;
        const common = { entryPrice: 100, stopLoss: 99, side: 'long' as const,
            equityUsd: 10_000, freeMarginUsd: 10_000, limits };
        assert.equal(resolvePaperSizing({ ...common, notionalUsd: NaN }).ok, false);
        assert.equal(resolvePaperSizing({ ...common }).ok, false);
        assert.equal(resolvePaperSizing({ ...common, riskPct: 5 }).ok, false);
        assert.equal(resolvePaperSizing({ ...common, riskPct: 0.5 }).ok, true);
    });
});

// ─── anti-reward-hacking + journal isolation ────────────────────────────────

describe('anti-reward-hacking and Trade Log isolation', () => {
    it('the order vocabulary has exactly five actions and no equity/reset action', () => {
        assert.deepEqual([...PAPER_ORDER_ACTIONS],
            ['open_market', 'open_limit', 'modify_sl_tp', 'close', 'cancel']);
        const exported = Object.keys(core).join('|');
        assert.equal(/reset|setEquity|deleteClosed|editFee/i.test(exported), false,
            'the pure core exports no balance/reset/delete surface');
    });

    it('paper settlements default legacy rows to live and never pollute live stats', async () => {
        const { paperSourceOf, legacyRowsAreLive, mergePaperSettlements } =
            await import('../src/services/paper/paperJournal');
        const { filterTradesBySimulationMode } = await import('../src/services/tracking/paperExecution');
        assert.equal(legacyRowsAreLive(), 'live');
        assert.equal(paperSourceOf({}), 'live');
        assert.equal(paperSourceOf({ simulated: true }), 'paper');

        const opened = openLong(createPaperAccount(null, NOW));
        const outcome = evaluatePaperTick(opened.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 10_000, high: 101.1, low: 100.1,
        });
        const settled = outcome.settlements[0];
        const rows = mergePaperSettlements([], [settled]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].simulated, true);
        assert.equal(paperSourceOf(rows[0]), 'paper');
        assert.equal(filterTradesBySimulationMode(rows, 'real').length, 0);
        const live = [{ id: 'legacy', analysis: {} as never, outcome: 'WIN' as never, timestamp: '' }];
        assert.equal(filterTradesBySimulationMode(live, 'real').length, 1);
        assert.equal(mergePaperSettlements(rows, [settled]).length, 1, 'replay is idempotent');
    });
});

// ─── service persistence + loud refusal ─────────────────────────────────────

describe('PaperBrokerService — persistence and loud refusals', () => {
    const user = 'paper-service-probe';

    it('persists an injected-quote fill and refuses excess risk with zero equity change', async () => {
        const svc = await import('../src/services/paper/PaperBrokerService');
        await svc.__paperBrokerTestHooks.clear(user);
        const first = await svc.submitPaperOrder({
            action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
            leverage: 5, stop_loss: 99, entry_price: 100,
        }, {
            username: user, nowMs: NOW,
            quoteProvider: async () => quoteAt(100),
            knownSymbol: async () => true,
        });
        assert.equal(first.ok, true, JSON.stringify(first));
        const afterFill = await svc.getPaperAccount(user, NOW);
        assert.equal(afterFill.positions.length, 1);
        assert.ok(afterFill.cashBalanceUsd < 10_000);

        const refused = await svc.submitPaperOrder({
            action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 50_000,
            leverage: 5, stop_loss: 99, entry_price: 100,
        }, {
            username: user, nowMs: NOW + 1,
            quoteProvider: async () => quoteAt(100),
            knownSymbol: async () => true,
        });
        assert.equal(refused.ok, false);
        assert.equal(refused.error, 'risk_exceeded');
        const afterRefusal = await svc.getPaperAccount(user, NOW);
        assert.equal(afterRefusal.cashBalanceUsd, afterFill.cashBalanceUsd);
        assert.equal(afterRefusal.positions.length, 1);

        const view = await svc.paperAccountSnapshot(user, {}, NOW);
        assert.equal(view.enabled, true);
        assert.equal(view.openPositions.length, 1);
        assert.equal(view.riskLimits.maxRiskPerTradePct, 1);
    });

    it('Settings-only reset restores equity, and autonomous watch stays OFF', async () => {
        const svc = await import('../src/services/paper/PaperBrokerService');
        const before = await svc.getPaperAccount(user, NOW);
        assert.equal(before.config.allowAutonomousWatch, false);
        const reset = await svc.resetPaperAccountForUser(user, NOW + 2);
        assert.equal(reset.cashBalanceUsd, 10_000);
        assert.equal(reset.positions.length, 0);
        assert.equal(reset.closedTrades.length, 0);
        assert.equal(reset.config.enabled, true);
    });
});

// ─── audit regressions (independent review findings) ────────────────────────

describe('audit regressions — funding once, kill-switch walls', () => {
    it('funding is charged ONCE: cash after a funded close equals start + netPnl', () => {
        const openedAt = Date.parse('2026-11-22T07:00:00Z');
        const made = placePaperOrder({
            account: createPaperAccount(null, openedAt),
            input: { action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: openedAt, isKnownSymbol: known, nextId: prefix => `${prefix}-once`,
        });
        const funded = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-22T09:00:00Z'), price: 100, fundingRate: 0.0001,
        });
        const positionId = (funded.account as PaperAccount).positions[0].id;
        const closed = placePaperOrder({
            account: funded.account as PaperAccount,
            input: { action: 'close', symbol: SYMBOL, position_id: positionId },
            quote: { bestBid: 100.4, bestAsk: 100.6, last: 100.5 },
            nowMs: Date.parse('2026-11-22T10:00:00Z'), isKnownSymbol: known,
        });
        assert.equal(closed.ok, true, JSON.stringify(closed));
        const settlement = closed.settlements?.[0];
        assert.ok(settlement);
        assert.ok(settlement.fundingPaidUsd > 0, 'the receipt still carries the funding the position paid');
        const expected = 10_000 + settlement.netPnlUsd;
        assert.ok(Math.abs((closed.account?.cashBalanceUsd ?? 0) - expected) < 0.02,
            `cash ${closed.account?.cashBalanceUsd} must equal start + netPnl ${expected} — funding may not be debited twice`);
    });

    it('the daily kill-switch blocks NEW entries and leaves a resting limit UNFILLED', () => {
        // A new resting limit is refused outright while the switch is active.
        const dead = createPaperAccount(null, NOW);
        dead.cashBalanceUsd = 9700;
        dead.dayStartEquityUsd = 10_000;
        const killed = evaluatePaperTick(dead, { symbol: SYMBOL, timestamp: NOW + 1, price: 100 });
        assert.equal(killed.account.killSwitchActive, true);
        const refused = placePaperOrder({
            account: killed.account, quote: {}, nowMs: NOW + 2, isKnownSymbol: known,
            input: { action: 'open_limit', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
        });
        assert.equal(refused.error, 'kill_switch_active');

        // A limit that was resting BEFORE the switch stays resting — unfilled,
        // uncanceled — and can fill only after the window resets.
        const resting = placePaperOrder({
            account: createPaperAccount(null, NOW),
            input: { action: 'open_limit', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: {}, nowMs: NOW, isKnownSymbol: known, nextId: prefix => `${prefix}-rest`,
        });
        const halted = evaluatePaperTick({ ...(resting.account as PaperAccount), killSwitchActive: true }, {
            symbol: SYMBOL, timestamp: NOW + 1, high: 100, low: 99.9, price: 99.9,
        });
        assert.equal(halted.account.pendingOrders.length, 1, 'a cross during the kill-switch must NOT fill');
        assert.equal(halted.account.positions.length, 0);
    });

    it('the drawdown window opens on EQUITY, not cash', () => {
        const made = openLong(createPaperAccount(null, NOW));
        const account = made.account as PaperAccount;
        // Mark the open position UP (below its TP so it stays open), then roll
        // into a new UTC day: the window must start from the marked equity,
        // not from cash (which excludes the open profit).
        const marked = evaluatePaperTick(account, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 100.5, low: 100.2, price: 100.3, markPrice: 100.3,
        });
        assert.equal(marked.account.killSwitchActive, false);
        assert.equal(marked.account.positions.length, 1);
        const nextDay = evaluatePaperTick(marked.account, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-23T00:00:01.000Z'), high: 100.5, low: 100.3, price: 100.3,
        });
        assert.equal(nextDay.account.dayKey, '2026-11-23');
        assert.ok(nextDay.account.dayStartEquityUsd > nextDay.account.cashBalanceUsd,
            `day-start equity ${nextDay.account.dayStartEquityUsd} must include open PnL over cash ${nextDay.account.cashBalanceUsd}`);
    });
});
