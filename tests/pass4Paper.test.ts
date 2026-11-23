/**
 * Pass-4 paper broker audit pins (behavioural, zero network).
 *
 * Written BEFORE the fixes. Each case exercises real code paths and is
 * expected to FAIL against the pre-fix source. The service cases install a
 * localStorage shim exactly as paperBroker.test.ts does; every clock and
 * every frame is injected, so no test opens a socket.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPreference } from '../src/services/infrastructure/PreferencesService';

const backing = new Map<string, string>([['last_active_user', 'pass4-paper-probe']]);
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

const SYMBOL = 'BTCUSDT';
const NOW = Date.parse('2026-11-22T07:00:00.000Z');
const SLOTS = [
    Date.parse('2026-11-22T08:00:00.000Z'),
    Date.parse('2026-11-22T16:00:00.000Z'),
];

const core = await import('../src/services/paper/paperCore');
const {
    createPaperAccount, placePaperOrder, evaluatePaperTick,
    isolatedLiquidationPrice, PAPER_LIQUIDATION_SLIPPAGE_BPS,
    PAPER_TAKER_FEE_BPS, PAPER_MAKER_FEE_BPS,
} = core as typeof import('../src/services/paper/paperCore') & {
    PAPER_LIQUIDATION_SLIPPAGE_BPS: number;
};
type PaperAccount = import('../src/services/paper/paperCore').PaperAccount;

const streams = await import('../src/services/trade/futuresStreams');
const svc = await import('../src/services/paper/PaperBrokerService');

const open = (over: Record<string, unknown> = {}, nowMs = NOW) => placePaperOrder({
    account: createPaperAccount(null, nowMs),
    input: {
        action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
        leverage: 5, stop_loss: 99, entry_price: 100, ...over,
    },
    quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
    nowMs, isKnownSymbol: s => s === SYMBOL, nextId: p => `${p}-p4`,
});

beforeEach(() => {
    (streams as any).resetPaperFrameCache?.();
    (svc as any).resetPaperCorruptionWarning?.();
});

// ─── 1. signed funding + cash invariant ────────────────────────────────────

describe('pass4 · item 1 — funding is signed and per-slot', () => {
    it('a SHORT that receives funding records a NEGATIVE fundingPaidUsd and cash = start + netPnl', () => {
        const made = open({ side: 'short', stop_loss: 101 }, Date.parse('2026-11-22T07:00:00Z'));
        assert.equal(made.ok, true, JSON.stringify(made));
        const start = made.account!.cashBalanceUsd;
        const funded = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-22T09:00:00Z'),
            price: 100, fundingRate: 0.0001,
        });
        const pos = funded.account.positions[0];
        assert.ok(pos.fundingPaidUsd < 0,
            `a short paid -funding must be recorded SIGNED, got ${pos.fundingPaidUsd}`);
        assert.ok(funded.account.cashBalanceUsd > start, 'positive rate credits the short in cash');

        const closed = placePaperOrder({
            account: funded.account, quote: { last: 100 }, nowMs: Date.parse('2026-11-22T10:00:00Z'),
            isKnownSymbol: s => s === SYMBOL,
            input: { action: 'close', symbol: SYMBOL, position_id: pos.id },
        });
        assert.equal(closed.ok, true, JSON.stringify(closed));
        const s = closed.settlements![0];
        assert.ok(s.fundingPaidUsd < 0, 'the RECEIPT must carry the signed credit, not 0');
        assert.ok(Math.abs((closed.account!.cashBalanceUsd) - (10_000 + s.netPnlUsd)) < 0.02,
            `cash ${closed.account!.cashBalanceUsd} must equal start + netPnl ${10_000 + s.netPnlUsd}`);
    });

    it('per-slot frames accrue each crossed slot with its OWN rate and mark notional', () => {
        const made = open({}, Date.parse('2026-11-22T07:00:00Z'));
        const qty = made.account!.positions[0].qty;
        const funded = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: Date.parse('2026-11-22T17:00:00Z'), price: 100,
            fundingRate: 0.0001, // deliberately WRONG — frames must win
            fundingFrames: [
                { slotMs: SLOTS[0], rate: 0.0002, markPrice: 120 },
                { slotMs: SLOTS[1], rate: 0.0004, markPrice: 80 },
            ],
        });
        const expected = qty * (120 * 0.0002 + 80 * 0.0004); // long pays positive
        assert.ok(Math.abs(funded.account.positions[0].fundingPaidUsd - expected) < 1e-5,
            `expected ${expected} from per-slot frames, got ${funded.account.positions[0].fundingPaidUsd}`);
        const ev = funded.events.filter(e => e.type === 'funding');
        assert.equal(ev.length, 2, 'one funding event per crossed slot');
    });
});

// ─── 2. liquidation exit price ──────────────────────────────────────────────

describe('pass4 · item 2 — liquidation cannot realize 2x margin', () => {
    it('exits at liquidationPrice ± capped slippage even when the next mark gaps far through it', () => {
        const made = open({ leverage: 10 });
        const pos = made.account!.positions[0];
        assert.equal(pos.liquidationPrice, isolatedLiquidationPrice(pos.entryPrice, 'long', 10));
        const margin = pos.marginUsd;
        const outcome = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, markPrice: 50, price: 50, high: 50, low: 50,
        });
        assert.equal(outcome.settlements.length, 1);
        const s = outcome.settlements[0];
        assert.equal(s.exitReason, 'liquidation');
        const floor = pos.liquidationPrice * (1 - PAPER_LIQUIDATION_SLIPPAGE_BPS / 10_000);
        assert.ok(s.exitPrice >= floor - 1e-6 && s.exitPrice <= pos.liquidationPrice + 1e-6,
            `liq fill ${s.exitPrice} must sit in [${floor}, ${pos.liquidationPrice}], not the gapped mark 50`);
        assert.ok(Math.abs(s.netPnlUsd) <= margin * (1 + 1e-6),
            `loss ${s.netPnlUsd} must not exceed isolated margin ${margin}`);
        assert.equal(s.exitPrice !== 50, true, 'the gapped mark must never be the settlement price');
    });
});

// ─── 3. nearest TP + partial exits ─────────────────────────────────────────

describe('pass4 · item 3 — nearest TP fills first and scales out', () => {
    it('an unordered TP array fills the NEAREST target and leaves the rest open with closedQty', () => {
        const made = open({ take_profits: [104, 101, 102] });
        const pos = made.account!.positions[0];
        const first = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 105, low: 100, price: 105,
        });
        assert.equal(first.settlements.length, 1);
        const firstSettlement = first.settlements[0]!;
        assert.equal(firstSettlement.exitPrice, 101, 'nearest crossed TP (101) must fill first');
        assert.ok((firstSettlement.closedQty ?? 0) > 0, 'settlement records the partial slice');
        const remaining = first.account.positions[0];
        assert.ok(remaining, 'the position stays open for the later targets');
        assert.equal(remaining.id, pos.id);
        assert.equal(remaining.qty < pos.qty, true, 'qty is reduced by the closed slice');
        assert.equal(remaining.closedQty > 0, true, 'closedQty accumulates on the position');
        assert.deepEqual(remaining.takeProfits, [104, 102], 'the filled TP is removed');

        const second = evaluatePaperTick(first.account, {
            symbol: SYMBOL, timestamp: NOW + 2000, high: 105, low: 100, price: 105,
        });
        assert.equal(second.settlements[0].exitPrice, 102, 'the next nearest target fills next');
        const third = evaluatePaperTick(second.account, {
            symbol: SYMBOL, timestamp: NOW + 3000, high: 105, low: 100, price: 105,
        });
        assert.equal(third.settlements[0].exitPrice, 104, 'the final target closes the remainder');
        assert.equal(third.account.positions.length, 0, 'position closes after the last TP');
        const totalQty = [first, second, third].reduce((n, r) => n + r.settlements[0].qty, 0);
        // Each slice is serialized at 6 decimals; three slices accumulate at
        // most ~1.5e-6 of display rounding against the exact original qty.
        assert.ok(Math.abs(totalQty - pos.qty) < 1e-5, `scaled-out qty ${totalQty} must sum to ${pos.qty}`);
    });
});

// ─── 4. funding on a manual close ──────────────────────────────────────────

describe('pass4 · item 4 — manual close accrues crossed funding before pricing', () => {
    it('a close at 09:00 settles the 08:00 slot even with no prior tick sweep', () => {
        const made = open({}, Date.parse('2026-11-22T07:00:00Z'));
        const pos = made.account!.positions[0];
        const closed = placePaperOrder({
            account: made.account as PaperAccount,
            input: { action: 'close', symbol: SYMBOL, position_id: pos.id },
            quote: { last: 100 },
            nowMs: Date.parse('2026-11-22T09:00:00Z'),
            isKnownSymbol: s => s === SYMBOL,
            fundingRate: 0.0001,
        });
        assert.equal(closed.ok, true, JSON.stringify(closed));
        const s = closed.settlements![0];
        assert.ok(s.fundingPaidUsd > 0, 'the crossed 08:00 slot must be accrued on close');
        assert.ok(Math.abs(closed.account!.cashBalanceUsd - (10_000 + s.netPnlUsd)) < 0.02,
            'wallet invariant still holds after a close-path accrual');
    });
});

// ─── 5. risk sizing with live marks ────────────────────────────────────────

describe('pass4 · item 5 — risk sizing values held positions at live marks', () => {
    it('uses the marked equity of OTHER positions, not their entry price', () => {
        const base = createPaperAccount(null, NOW);
        const holder = placePaperOrder({
            account: base,
            input: { action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 1000,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: NOW, isKnownSymbol: s => s === SYMBOL, nextId: p => `${p}-hold`,
        });
        const markedUp = placePaperOrder({
            account: holder.account as PaperAccount,
            input: { action: 'open_market', symbol: 'ETHUSDT', side: 'long', risk_pct: 0.5,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: NOW + 1,
            isKnownSymbol: () => true,
            markPrices: { [SYMBOL]: 200 },
            nextId: p => `${p}-size`,
        });
        const atEntry = placePaperOrder({
            account: holder.account as PaperAccount,
            input: { action: 'open_market', symbol: 'ETHUSDT', side: 'long', risk_pct: 0.5,
                leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: NOW + 1,
            isKnownSymbol: () => true,
            nextId: p => `${p}-size2`,
        });
        assert.equal(markedUp.ok, true, JSON.stringify(markedUp));
        assert.equal(atEntry.ok, true, JSON.stringify(atEntry));
        assert.ok(markedUp.account!.positions[1].qty > atEntry.account!.positions[1].qty,
            `a held winner marked at 200 must enlarge the next size (${markedUp.account!.positions[1].qty} vs ${atEntry.account!.positions[1].qty})`);
    });
});

// ─── 6. corrupt persistence ────────────────────────────────────────────────

describe('pass4 · item 6 — corrupt stored account is quarantined, validated, and warned', () => {
    const user = 'pass4-corrupt-probe';
    it('keeps a valid position, REPAIRS a missing liquidationPrice, warns + quarantines', async () => {
        const valid = {
            id: 'pos-ok', symbol: SYMBOL, side: 'long', qty: 5, entryPrice: 100,
            liquidationPrice: 90.5, stopLoss: 99, takeProfits: [101], leverage: 10,
            marginUsd: 50, riskUsd: 5, entryFeeUsd: 0.25, openedAt: NOW,
            fundingPaidUsd: 0, lastFundingSlotMs: NOW, closedQty: 0,
        };
        const broken = { ...valid, id: 'pos-broken', liquidationPrice: undefined };
        const raw = JSON.stringify({
            version: 1, config: {}, cashBalanceUsd: 9000,
            positions: [valid, broken], pendingOrders: [], closedTrades: [],
            dayKey: '2026-11-22', dayStartEquityUsd: 10000, killSwitchActive: false,
        });
        await svc.__paperBrokerTestHooks.clear(user);
        const activeStore = (): Storage => g.localStorage as Storage;
        await setPreference(svc.__paperBrokerTestHooks.storeKey(user), raw.slice(0, raw.length - 20)); // truncated JSON
        const account = await svc.getPaperAccount(user, NOW);
        assert.equal(account.cashBalanceUsd, 10_000, 'a corrupt blob falls back to a fresh account');
        const warning = svc.getPaperCorruptionWarning();
        assert.ok(warning, 'corruption is surfaced, not silently swallowed');
        assert.ok(warning.reason && warning.reason.length > 0);
        const st = activeStore();
        const quarantined: string[] = [];
        for (let i = 0; i < st.length; i += 1) {
            const k = st.key(i);
            if (k && k.startsWith('paper_account_corrupt_v1_')) quarantined.push(k);
        }
        assert.equal(quarantined.length, 1, 'the raw bytes are preserved under a distinct key');

        // Now a WELL-FORMED envelope whose second position is incomplete.
        await svc.__paperBrokerTestHooks.clear(user);
        await setPreference(svc.__paperBrokerTestHooks.storeKey(user), JSON.stringify({
            version: 1, config: {}, cashBalanceUsd: 9000,
            positions: [valid, broken], pendingOrders: [], closedTrades: [],
            dayKey: '2026-11-22', dayStartEquityUsd: 10000, killSwitchActive: false,
        }));
        const loaded = await svc.getPaperAccount(user, NOW);
        assert.equal(loaded.positions.length, 2, 'both positions survive — the broken one is REPAIRED, not lost');
        assert.equal(loaded.positions[0].id, 'pos-ok');
        assert.equal(loaded.cashBalanceUsd, 9000, 'the valid account data survives');
        const repaired = loaded.positions.find(p => p.id === 'pos-broken');
        assert.ok(repaired);
        assert.ok(repaired.liquidationPrice > 0, 'a missing liq price is re-derived so the position still liquidates');
        assert.ok(repaired.lastFundingSlotMs > 0, 'a missing funding slot is repaired so accrual resumes');
        assert.ok(svc.getPaperCorruptionWarning(), 'the repair is surfaced as a user-visible warning');
    });
});

// ─── 7. authoritative ledger is not capped ─────────────────────────────────

describe('pass4 · item 7 — the closed ledger keeps every settlement', () => {
    it('the 251st settlement is not dropped', () => {
        const seed = Array.from({ length: 250 }, (_, i) => ({
            positionId: `old-${i}`, symbol: SYMBOL, side: 'long' as const, qty: 1,
            entryPrice: 100, exitPrice: 101, grossPnlUsd: 1, feesUsd: 0.05,
            fundingPaidUsd: 0, netPnlUsd: 0.95, rMultiple: 1, exitReason: 'tp' as const,
            openedAt: NOW, closedAt: NOW + i, leverage: 5,
        }));
        const account = createPaperAccount(null, NOW);
        account.closedTrades = seed as any;
        const made = placePaperOrder({
            account,
            input: { action: 'open_market', symbol: SYMBOL, side: 'long', notional_usd: 500,
                leverage: 5, stop_loss: 99, entry_price: 100, take_profits: [101] },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: NOW, isKnownSymbol: s => s === SYMBOL, nextId: p => `${p}-ledger`,
        });
        const out = evaluatePaperTick(made.account as PaperAccount, {
            symbol: SYMBOL, timestamp: NOW + 1000, high: 102, low: 100, price: 102,
        });
        assert.equal(out.account.closedTrades.length, 251,
            'the authoritative ledger must grow past 250 — no silent cap');
    });
});

// ─── 8. live WS frames into the tick monitor ───────────────────────────────

describe('pass4 · item 8 — fresh WS frames drive ticks with intra-window wicks', () => {
    it('a published kline wick reaches the tick even when last == mark', async () => {
        const at = 1_700_000_000_000;
        streams.publishPaperMark(SYMBOL, 100, 0.0001, at);
        streams.publishPaperKline(SYMBOL, {
            openTime: at, open: 100, high: 101.5, low: 90, close: 100, volume: 1, closed: false,
        }, at + 10);
        const frame = streams.getPaperLiveFrame(SYMBOL, 3000, at + 20);
        assert.ok(frame, 'a just-published frame is fresh');
        assert.equal(frame.high, 101.5);
        assert.equal(frame.low, 90, 'the intra-window wick is preserved (REST poll would synthesize low=last)');
        const tick = await (svc as any).livePaperTick(SYMBOL, at + 20);
        assert.equal(tick.high, 101.5);
        assert.equal(tick.low, 90);
        assert.equal(tick.markPrice, 100);
        assert.equal(tick.fundingRate, 0.0001);
        assert.equal(streams.getPaperLiveFrame(SYMBOL, 3000, at + 5000), null, 'a stale frame is not fresh');
    });

    it('a Trade-surface feed suppresses the broker own socket decision, exposure alone opens it', () => {
        const s = SYMBOL.toLowerCase();
        assert.equal(streams.shouldOpenPaperWs(s, true), true, 'exposure with no Trade feed ⇒ own socket');
        assert.equal(streams.shouldOpenPaperWs(s, false), false, 'no exposure ⇒ no socket');
        const release = streams.registerLivePaperFeed(s);
        assert.equal(streams.hasLivePaperFeed(s), true);
        assert.equal(streams.shouldOpenPaperWs(s, true), false, 'a mounted Trade feed owns the socket');
        release();
        assert.equal(streams.hasLivePaperFeed(s), false);
        assert.equal(streams.shouldOpenPaperWs(s, true), true);
    });
});
