// Wave A reliability pins — rate limiting, backward range fetch, trade_math
// guards, VWAP anchors, universe verification, fib conventions, order-book
// microstructure and funding carry. All deterministic: global fetch is mocked
// per test and restored immediately.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    __futuresRateLimitTestHooks,
    estimateBookSlippage,
    fetchOrderBookDepth,
    verifySymbolAgainstUniverse,
} from '../src/services/analysis/MarketDataService';
import { fetchRangeDetailed, runNakedPocsTool, runVwapTool, runTradeMathTool, runDerivativesStateTool, runRegimeTool, runImbalancesTool } from '../src/services/analysis/marketTools';
import { evaluateDrawingAtNow } from '../src/services/trade/chartGeometry';
import { FIB_RATIOS as DRAW_FIB_RATIOS } from '../src/services/trade/chartDrawings';
import { anchoredSlice } from '../src/services/market/vwapCore';
import { activeSwingFib } from '../src/services/market/swingStructureCore';
import { calculateFibonacciLevels } from '../src/services/analysis/TechnicalAnalysisService';
import { computeTradeMath, computeFundingDrag } from '../src/services/market/tradeMathCore';
import { plannedRiskRewardSigned } from '../src/utils/riskReward';
import { evaluatePlanLocalSync } from '../src/services/trade/proposalGate';
import { fallbackAdversaryVerdict } from '../src/services/trade/adversaryReview';
import { parseTradeProposal } from '../src/services/trade/proposedTrade';
import { describeDrawingsForModel } from '../src/services/trade/chartDrawings';
import { FIB_EXTENSION_RATIOS } from '../src/services/trade/chartGeometry';
import { executeDeskTool } from '../src/services/analysis/DeskToolsService';
import type { ChartDrawing } from '../src/services/trade/chartDrawings';
import type { EvalCandle } from '../src/services/trade/chartGeometry';

// ─── fetch mock plumbing ─────────────────────────────────────────────────────

type MockResponse = { status?: number; headers?: Record<string, string>; json?: unknown };
type MockHandler = (url: string) => MockResponse | Promise<MockResponse>;

const withMockedFetch = async (handler: MockHandler, fn: (calls: string[]) => Promise<void>): Promise<void> => {
    const calls: string[] = [];
    __futuresRateLimitTestHooks.setFetchImpl(async (url: string) => {
        calls.push(url);
        const res = await handler(url);
        const status = res.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (k: string) => (res.headers?.[k.toLowerCase()] ?? null) },
            json: async () => res.json,
        } as unknown as Response;
    });
    try {
        await fn(calls);
    } finally {
        __futuresRateLimitTestHooks.reset();
    }
};

const NOW = 1_700_000_000_000;
const STEP_5M = 300_000;
const STEP_BY_TF: Record<string, number> = {
    '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
const klineRow = (t: number, step: number): unknown[] => [
    t, '100', '101', '99', '100', '10', t + step - 1, '1000', 100, '50', '500', '0',
];
const urlParam = (url: string, key: string): string | null => {
    const m = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
    return m ? decodeURIComponent(m[1]) : null;
};
const UNIVERSE_TICKERS = [
    { symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '1000' },
    { symbol: 'ETHUSDT', lastPrice: '50', priceChangePercent: '2', quoteVolume: '900' },
];
const UNIVERSE_INFO = {
    symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', baseAsset: 'BTC' },
        { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', baseAsset: 'ETH' },
    ],
};
/** Klines + universe + premiumIndex + depth router. */
const marketHandler = (): MockHandler => (url) => {
    if (url.includes('/fapi/v1/klines')) {
        const step = STEP_BY_TF[urlParam(url, 'interval') ?? '5m'] ?? STEP_5M;
        const start = urlParam(url, 'startTime');
        const rows: unknown[][] = [];
        if (start !== null) {
            const first = Number(start);
            const end = Number(urlParam(url, 'endTime') ?? String(NOW));
            const last = Math.min(end - step, first + 1399 * step);
            for (let t = first; t <= last; t += step) rows.push(klineRow(t, step));
        } else {
            const limit = Number(urlParam(url, 'limit') ?? '100');
            const last = NOW - step;
            for (let t = last - (limit - 1) * step; t <= last; t += step) rows.push(klineRow(t, step));
        }
        return { json: rows };
    }
    if (url.includes('/fapi/v1/ticker/24hr')) {
        return { json: url.includes('symbol=') ? UNIVERSE_TICKERS[0] : UNIVERSE_TICKERS };
    }
    if (url.includes('/fapi/v1/exchangeInfo')) return { json: UNIVERSE_INFO };
    if (url.includes('/fapi/v1/premiumIndex')) {
        return { json: { markPrice: '100', indexPrice: '100', lastFundingRate: '0.0001', nextFundingTime: String(NOW + 3_600_000) } };
    }
    if (url.includes('/fapi/v1/depth')) {
        return { json: { bids: [['99.5', '3'], ['99', '1']], asks: [['100.5', '2'], ['101', '1']] } };
    }
    return { json: {} };
};

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// ─── F1: rate limiting ───────────────────────────────────────────────────────

describe('Wave A — F1 futures rate limiting', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('a 429 with a long Retry-After latches the IP cooldown and fails fast WITHOUT cycling hosts', async () => {
        await withMockedFetch((url) => (
            url.includes('/fapi/v1/ping')
                ? { status: 429, headers: { 'retry-after': '30' }, json: {} }
                : { json: {} }
        ), async (calls) => {
            await assert.rejects(
                __futuresRateLimitTestHooks.fetch('/fapi/v1/ping'),
                /429.*failing fast/s,
            );
            const pingCalls = calls.filter(u => u.includes('/fapi/v1/ping'));
            assert.equal(pingCalls.length, 1, 'a 429 must not hammer the remaining hosts');
            // The latch answers the NEXT call with zero network attempts.
            await assert.rejects(
                __futuresRateLimitTestHooks.fetch('/fapi/v1/ping'),
                /cooldown active/,
            );
            assert.equal(pingCalls.length, 1, 'the latch must serve subsequent calls offline');
            assert.ok(__futuresRateLimitTestHooks.state().cooldownUntil - Date.now() >= 25_000);
        });
    });

    it('a 418 stops host cycling immediately and latches the ban window', async () => {
        await withMockedFetch((url) => (
            url.includes('/fapi/v1/ping')
                ? { status: 418, headers: { 'retry-after': '300' }, json: {} }
                : { json: {} }
        ), async (calls) => {
            await assert.rejects(
                __futuresRateLimitTestHooks.fetch('/fapi/v1/ping'),
                /418.*failing fast/s,
            );
            assert.equal(calls.filter(u => u.includes('/fapi/v1/ping')).length, 1, '418 is IP-level — zero failover attempts');
            assert.ok(__futuresRateLimitTestHooks.state().cooldownUntil - Date.now() >= 280_000);
            assert.equal(__futuresRateLimitTestHooks.state().cooldownReason, '418 IP auto-ban');
        });
    });

    it('a short 429 backoff retries ONCE inline on the same host', async () => {
        let pingCalls = 0;
        await withMockedFetch((url): MockResponse => {
            if (!url.includes('/fapi/v1/ping')) return { json: {} };
            pingCalls += 1;
            return pingCalls === 1
                ? { status: 429, headers: { 'retry-after': '1' }, json: {} }
                : { json: {}, headers: { 'x-mbx-used-weight-1m': '500' } };
        }, async (calls) => {
            const res = await __futuresRateLimitTestHooks.fetch('/fapi/v1/ping');
            assert.equal(res.ok, true);
            const pings = calls.filter(u => u.includes('/fapi/v1/ping'));
            assert.equal(pings.length, 2, 'exactly one inline retry');
            assert.ok(pings.every(u => u.startsWith('https://fapi.binance.com')),
                'the retry stays on the same host (hosts are not cycled through a 429)');
            assert.equal(__futuresRateLimitTestHooks.state().usedWeight, 500);
        });
    });

    it('a 429 without Retry-After uses the conservative default backoff and still retries inline once', async () => {
        let pingCalls = 0;
        await withMockedFetch((url) => {
            if (!url.includes('/fapi/v1/ping')) return { json: {} };
            pingCalls += 1;
            return pingCalls === 1 ? { status: 429, json: {} } : { json: {} };
        }, async (calls) => {
            const res = await __futuresRateLimitTestHooks.fetch('/fapi/v1/ping');
            assert.equal(res.ok, true);
            assert.equal(calls.filter(u => u.includes('/fapi/v1/ping')).length, 2);
        });
    });

    it('x-mbx-used-weight-1m is recorded from responses', async () => {
        await withMockedFetch(() => ({ json: {}, headers: { 'x-mbx-used-weight-1m': '500' } }), async () => {
            await __futuresRateLimitTestHooks.fetch('/fapi/v1/ping');
            assert.equal(__futuresRateLimitTestHooks.state().usedWeight, 500);
        });
    });

    it('a hot gauge (≥ 2,160 in the CURRENT minute) fails fast while > 5s remain in the minute', async () => {
        await withMockedFetch(() => ({ json: {} }), async () => {
            const realNow = Date.now;
            // Pin 10s into the UTC minute so 50s remain (> 5s grace) regardless of wall-clock seconds.
            Date.now = () => 1_700_000_010_000;
            try {
                __futuresRateLimitTestHooks.seedWeight(2300, 0); // reported THIS minute → hot
                await assert.rejects(
                    __futuresRateLimitTestHooks.fetch('/fapi/v1/ping'),
                    /weight gauge 2300\/2400/,
                );
                assert.equal(__futuresRateLimitTestHooks.state().usedWeight, 2300);
            } finally {
                Date.now = realNow;
            }
        });
    });

    it('stale weight never throttles the next minute (rollover reset)', async () => {
        await withMockedFetch(() => ({ json: {} }), async () => {
            __futuresRateLimitTestHooks.seedWeight(2300, 1); // reported in the PREVIOUS minute
            const t0 = Date.now();
            await __futuresRateLimitTestHooks.fetch('/fapi/v1/ping');
            assert.ok(Date.now() - t0 < 1000, 'a previous-minute gauge must not throttle');
        });
    });

    it('non-429/418 failures still cycle hosts (failover preserved)', async () => {
        let pingCalls = 0;
        await withMockedFetch((url) => {
            if (!url.includes('/fapi/v1/ping')) return { json: {} };
            pingCalls += 1;
            return pingCalls === 1 ? { status: 500, json: {} } : { json: {} };
        }, async (calls) => {
            const res = await __futuresRateLimitTestHooks.fetch('/fapi/v1/ping');
            assert.equal(res.ok, true);
            const pings = calls.filter(u => u.includes('/fapi/v1/ping'));
            assert.equal(pings.length, 2);
            assert.ok(pings[0].includes('fapi.binance.com') && pings[1].includes('fapi1.binance.com'));
        });
    });
});

// ─── F2: backward fetchRange ────────────────────────────────────────────────

describe('Wave A — F2 backward fetchRange', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('keeps the NEWEST bars when the chunk budget clips the window, and says truncated', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const end = NOW;
            const start = end - 200 * 86_400_000; // 200 days of 5m → 42 chunks
            const r = await fetchRangeDetailed('BTCUSDT', '5m', start, end);
            assert.equal(r.truncated, true);
            assert.equal(r.candles.length, 31 * 1400);
            const last = r.candles[r.candles.length - 1];
            assert.equal(last.time, end - STEP_5M, 'the newest closed bar survives');
            assert.equal(r.candles[0].time, end - 31 * 1400 * STEP_5M, 'the OLDEST part of the window is what was dropped');
            for (let i = 1; i < r.candles.length; i += 1) {
                assert.ok(r.candles[i - 1].time < r.candles[i].time, 'strictly chronological, no duplicates');
            }
        });
    });

    it('a window inside the budget is not truncated', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const end = NOW;
            const start = end - 3 * 86_400_000;
            const r = await fetchRangeDetailed('BTCUSDT', '5m', start, end);
            assert.equal(r.truncated, false);
            assert.equal(r.candles.length, 3 * 288);
            assert.equal(r.candles[0].time, start);
        });
    });

    it('runNakedPocsTool discloses the clipped lookback in data_quality.notes', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runNakedPocsTool('BTCUSDT', 'day', 500);
            const parsed = JSON.parse(raw);
            assert.equal(parsed.data_quality.bars_used, 31 * 1400);
            assert.ok(
                parsed.data_quality.notes.join(' ').includes('CLIPPED'),
                `notes must name the clip: ${JSON.stringify(parsed.data_quality.notes)}`,
            );
            assert.ok(parsed.data_quality.notes.join(' ').includes('NEWEST'), 'the disclosure says the newest data was kept');
        });
    });
});

// ─── F3: trade_math guards ──────────────────────────────────────────────────

describe('Wave A — F3 trade_math guards', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('refuses non-finite and non-positive targets alongside entry/stop', () => {
        const candles = Array.from({ length: 30 }, (_, i) => ({ time: i * 60_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10 }));
        assert.equal(computeTradeMath({ direction: 'Long', entry: NaN, stopLoss: 99, takeProfits: [103] }, candles), null);
        assert.equal(computeTradeMath({ direction: 'Long', entry: 100, stopLoss: -1, takeProfits: [103] }, candles), null);
        assert.equal(computeTradeMath({ direction: 'Long', entry: 100, stopLoss: 99, takeProfits: [-5] }, candles), null);
        assert.equal(computeTradeMath({ direction: 'Long', entry: 100, stopLoss: 99, takeProfits: [0] }, candles), null);
        assert.equal(computeTradeMath({ direction: 'Long', entry: 100, stopLoss: 99, takeProfits: [Infinity] }, candles), null);
    });

    it('an inverted plan quotes NO net figure: netRewardR/target_atr null, summary "net —"', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runTradeMathTool('BTCUSDT', 'Long', 100, 101, [99]);
            const parsed = JSON.parse(raw);
            assert.equal(parsed.values.gross.inverted, true);
            assert.equal(parsed.values.gross.ratio, 0);
            assert.equal(parsed.values.costs.netRewardR, null);
            assert.equal(parsed.distances_atr.target_atr, null);
            assert.ok(parsed.one_line_summary.includes('net —'), parsed.one_line_summary);
            assert.ok(parsed.one_line_summary.includes('INVERTED PLAN'), parsed.one_line_summary);
            assert.ok(!parsed.one_line_summary.includes('10.49') && !parsed.one_line_summary.includes('199.9'), 'no bogus arithmetic beside the refusal');
        });
    });

    it('an invalid direction is REFUSED, never coerced into Long', async () => {
        const res = await executeDeskTool(
            { id: 't-dir', name: 'trade_math', arguments: { direction: 'sideways', entry: 100, stop_loss: 99, take_profits: [103] } },
            { allowedTools: 'all' },
        );
        assert.ok(res.content.includes('trade_math rejected: direction must be "Long" or "Short"'), res.content);
    });

    it('direction is case-insensitive ("SHort" runs as Short)', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const res = await executeDeskTool(
                { id: 't-dir2', name: 'trade_math', arguments: { direction: 'SHort', entry: 100, stop_loss: 101, take_profits: [90] } },
                { allowedTools: 'all' },
            );
            assert.ok(res.content.includes('"direction":"Short"'), res.content);
            assert.ok(res.content.includes('R:R'), res.content);
        });
    });
});

// ─── 8b: funding carry ──────────────────────────────────────────────────────

describe('Wave A — 8b trade_math funding carry', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('quotes fundingDragR over the expected hold + minutes to the next 8h settlement', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runTradeMathTool('BTCUSDT', 'Long', 100, 95, [110], {
                expectedHoldHours: 24, asofMs: NOW,
            });
            const parsed = JSON.parse(raw);
            assert.equal(parsed.values.funding.rate, 0.0001);
            assert.equal(parsed.values.funding.settlements, 3);
            assert.equal(parsed.values.funding.intervalSource, 'assumed 8h funding interval');
            // 3 settlements × 0.0001 × (100/5 notional-per-risk) = +0.006R COST for a Long
            assert.equal(parsed.values.funding.dragR, 0.006);
            assert.equal(parsed.values.funding.minutesToNextSettlement, 60);
            const notes = parsed.data_quality.notes.join(' ');
            assert.ok(notes.includes('ASSUMED 8h interval'), notes);
        });
    });

    it('a Short EARNS the positive rate (negative drag)', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runTradeMathTool('BTCUSDT', 'Short', 100, 105, [90], {
                expectedHoldHours: 24, asofMs: NOW,
            });
            const parsed = JSON.parse(raw);
            assert.equal(parsed.values.funding.dragR, -0.006);
        });
    });

    it('an inverted plan quotes no funding block at all', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runTradeMathTool('BTCUSDT', 'Long', 100, 101, [99], {
                expectedHoldHours: 24, asofMs: NOW,
            });
            const parsed = JSON.parse(raw);
            assert.equal(parsed.values.gross.inverted, true);
            assert.equal(parsed.values.funding, undefined);
        });
    });

    it('no expectedHoldHours → no funding block (existing callers unchanged)', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runTradeMathTool('BTCUSDT', 'Long', 100, 99, [103]);
            const parsed = JSON.parse(raw);
            assert.equal(parsed.values.funding, undefined);
        });
    });
});

// ─── F4: vwap anchors ───────────────────────────────────────────────────────

describe('Wave A — F4 vwap anchor validation', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('an unknown anchor is refused with the valid anchor list (never swing_low semantics)', async () => {
        const raw = await runVwapTool('BTCUSDT', 'diagonal');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.data_quality.available, false);
        assert.ok(parsed.data_quality.reason.includes('unknown anchor "diagonal"'), parsed.data_quality.reason);
        assert.ok(parsed.data_quality.reason.includes('session_open, swing_high, swing_low, custom'), parsed.data_quality.reason);
    });

    it('anchoredSlice returns null for an unknown anchor (defense in depth)', () => {
        const candles = [{ time: 0, open: 1, high: 2, low: 0.5, close: 1, volume: 5 }, { time: 60, open: 1, high: 2, low: 0.5, close: 1, volume: 5 }];
        assert.equal(anchoredSlice(candles, 'diagonal' as never), null);
    });

    it('a valid anchor still computes the anchored VWAP', async () => {
        await withMockedFetch(marketHandler(), async () => {
            const raw = await runVwapTool('BTCUSDT', 'session_open');
            const parsed = JSON.parse(raw);
            assert.equal(parsed.data_quality.available, true);
            assert.ok(parsed.values.vwap > 0);
        });
    });
});

// ─── F5: universe verifier ──────────────────────────────────────────────────

describe('Wave A — F5 verifySymbolAgainstUniverse', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('verifies a listed symbol and positively refuses an unlisted one', async () => {
        await withMockedFetch(marketHandler(), async () => {
            assert.equal(await verifySymbolAgainstUniverse('BTCUSDT'), 'verified');
            assert.equal(await verifySymbolAgainstUniverse('FAKEUSDT'), 'unknown-symbol');
        });
    });

    it('fails open when the universe feed errors or hangs past the budget', async () => {
        await withMockedFetch(() => { throw new Error('offline'); }, async () => {
            assert.equal(await verifySymbolAgainstUniverse('BTCUSDT'), 'unverified');
        });
        // A hanging feed must time the budget out — and the coalesced
        // in-flight universe fetch must SETTLE (reject) so later callers
        // are not stuck waiting on a wedged promise.
        await withMockedFetch(() => new Promise<MockResponse>((_resolve, reject) => {
            setTimeout(() => reject(new Error('wedged')), 200);
        }), async () => {
            assert.equal(await verifySymbolAgainstUniverse('BTCUSDT', { budgetMs: 50 }), 'unverified');
        });
    });

    it('the market-tool path refuses an unknown symbol before any venue call', async () => {
        await withMockedFetch(marketHandler(), async (calls) => {
            await assert.rejects(
                fetchRangeDetailed('FAKEUSDT', '5m', NOW - 86_400_000, NOW),
                /unknown symbol "FAKEUSDT"/,
            );
            assert.ok(calls.every(u => !u.includes('/fapi/v1/klines')), 'no venue kline round-trip was spent');
        });
    });

    it('normalizes "eth" and "eth/usdt" to ETHUSDT before validation', async () => {
        await withMockedFetch(marketHandler(), async () => {
            assert.equal(await verifySymbolAgainstUniverse('eth'), 'verified');
            assert.equal(await verifySymbolAgainstUniverse('eth/usdt'), 'verified');
            assert.equal(await verifySymbolAgainstUniverse('ETH/USDT'), 'verified');
        });
    });

    it('get_order_book refuses an unknown symbol with zero depth calls', async () => {
        await withMockedFetch(marketHandler(), async (calls) => {
            const res = await executeDeskTool(
                { id: 'ob1', name: 'get_order_book', arguments: { symbol: 'FAKECOINUSDT' } },
                { allowedTools: 'all' },
            );
            assert.equal(res.ok, false);
            assert.ok(res.content.includes('unknown symbol "FAKECOINUSDT"'), res.content);
            assert.equal(calls.filter(u => u.includes('/fapi/v1/depth')).length, 0, 'zero venue depth HTTP calls');
        });
    });
});

// ─── Fibonacci conventions ──────────────────────────────────────────────────

describe('Wave A — Fibonacci conventions', () => {
    const mkCandles = (n: number): EvalCandle[] => Array.from({ length: n }, (_, i) => ({
        time: i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
    }));
    const fibDrawing = (a: { t: number; p: number }, b: { t: number; p: number }): ChartDrawing => ({
        id: 'fib-test', shortId: '#D1', kind: 'fib', origin: 'agent', createdAt: 0, version: 1,
        color: '#4d9fff', points: [a, b], createdOnTf: '1h',
    });

    it('drawing fib on an up-swing 100→200 uses STANDARD ratios incl. OTE and extensions', () => {
        const ev = evaluateDrawingAtNow(fibDrawing({ t: 0, p: 100 }, { t: 11 * 3600, p: 200 }), {
            symbol: 'BTCUSDT', activeTf: '1h', candles: mkCandles(12), markPrice: 150,
            priceScaleMode: 'normal', atr14: 2, tickSize: 0, nowMs: 13 * 3600 * 1000,
        });
        const L = Object.fromEntries((ev.fibLevels ?? []).map(f => [f.ratio, f.price]));
        assert.equal(L[0.382], 161.8, '0.382 retracement = 161.8 (high − 0.382R)');
        assert.equal(L[0.618], 138.2, '0.618 retracement = 138.2');
        assert.equal(L[0.705], 129.5, '0.705 OTE');
        assert.equal(L[1.272], 227.2, '1.272 extension');
        assert.equal(L[1.618], 261.8, '1.618 extension');
        assert.equal(L[2], 300, '2.0 extension');
        (ev.fibLevels ?? []).forEach(f => {
            assert.equal(f.kind, f.ratio > 1 ? 'extension' : 'retracement', `ratio ${f.ratio} must be labeled`);
        });
    });

    it('drawing fib on a down-swing 200→100 mirrors correctly (no inverted 38.2/61.8)', () => {
        const ev = evaluateDrawingAtNow(fibDrawing({ t: 0, p: 200 }, { t: 11 * 3600, p: 100 }), {
            symbol: 'BTCUSDT', activeTf: '1h', candles: mkCandles(12), markPrice: 150,
            priceScaleMode: 'normal', atr14: 2, tickSize: 0, nowMs: 13 * 3600 * 1000,
        });
        const L = Object.fromEntries((ev.fibLevels ?? []).map(f => [f.ratio, f.price]));
        assert.equal(L[0.382], 138.2);
        assert.equal(L[0.618], 161.8);
        assert.equal(L[0.705], 170.5);
        assert.equal(L[1.272], 72.8);
        assert.equal(L[2], undefined, '2.0 on a 200→100 leg lands exactly at 0 — omitted');
        (ev.fibLevels ?? []).forEach(f => assert.ok(f.price > 0, 'no non-positive fib price is ever emitted'));
    });

    it('drawing fib on a deep down-swing 200→80 omits every non-positive extension', () => {
        const ev = evaluateDrawingAtNow(fibDrawing({ t: 0, p: 200 }, { t: 11 * 3600, p: 80 }), {
            symbol: 'BTCUSDT', activeTf: '1h', candles: mkCandles(12), markPrice: 140,
            priceScaleMode: 'normal', atr14: 2, tickSize: 0, nowMs: 13 * 3600 * 1000,
        });
        const L = Object.fromEntries((ev.fibLevels ?? []).map(f => [f.ratio, f.price]));
        assert.equal(L[0.382], 125.84, 'retracements stay inside the leg (80 + 0.382×120)');
        assert.equal(L[2], undefined, '2.0 extension at −160 is omitted');
        assert.equal(L[1.618], 5.84, '1.618 extension at +5.84 is kept (still positive)');
        (ev.fibLevels ?? []).forEach(f => assert.ok(f.price > 0, `ratio ${f.ratio} emitted ${f.price}`));
    });

    it('drawing fib 0.382 parity with calculateFibonacciLevels on the same swing', () => {
        const tape = Array.from({ length: 50 }, (_, i) => {
            const close = 101 + 2 * i;
            const high = i === 49 ? 200 : close + 1;
            const low = i === 0 ? 100 : close - 2;
            return { time: i * 3_600_000, open: close - 1, high, low, close, volume: 10 };
        });
        const cfl = calculateFibonacciLevels(tape);
        const calc382 = cfl.levels.find(l => l.ratio === '0.382');
        const ev = evaluateDrawingAtNow(fibDrawing({ t: 0, p: 100 }, { t: 11 * 3600, p: 200 }), {
            symbol: 'BTCUSDT', activeTf: '1h', candles: mkCandles(12), markPrice: 150,
            priceScaleMode: 'normal', atr14: 2, tickSize: 0, nowMs: 13 * 3600 * 1000,
        });
        const draw382 = ev.fibLevels?.find(f => f.ratio === 0.382);
        assert.equal(cfl.swingHigh, 200);
        assert.equal(cfl.swingLow, 100);
        assert.ok(calc382 && draw382 && near(calc382.price, draw382.price, 1e-9),
            `analytic ${calc382?.price} vs drawing ${draw382?.price}`);
    });

    it('activeSwingFib: standard retracements + 0.705 OTE + extensions with confluence', () => {
        // 18-candle zigzag: strict fractal high @idx7 (124) and low @idx15 (98).
        const highs = [110, 112, 114, 116, 118, 120, 122, 124, 122, 120, 118, 116, 114, 112, 110, 108, 108, 112];
        const lows = [100, 102, 104, 106, 108, 110, 112, 114, 112, 110, 108, 106, 104, 102, 100, 98, 104, 108];
        const leg = highs.map((h, i) => ({
            time: (i + 1) * 3_600_000, open: (h + lows[i]) / 2, high: h, low: lows[i],
            close: lows[i] + (h - lows[i]) * 0.75, volume: 10,
        }));
        const af = activeSwingFib(leg, 3, 0.25);
        assert.ok(af !== null);
        assert.equal(af.direction, 'bullish');
        assert.equal(af.from.price, 98);
        assert.equal(af.to.price, 124);
        const L = Object.fromEntries(af.levels.map(l => [l.ratio, l.price]));
        const from = af.from.price;
        const to = af.to.price;
        assert.ok(near(L['0.382'], to - 0.382 * (to - from), 1e-9), `0.382=${L['0.382']}`);
        assert.ok(near(L['0.705'], to - 0.705 * (to - from), 1e-9), `0.705=${L['0.705']}`);
        assert.ok(near(L['1.272'], from + 1.272 * (to - from), 1e-9), `1.272=${L['1.272']}`);
        assert.ok(near(L['2.0'], from + 2 * (to - from), 1e-9), `2.0=${L['2.0']}`);
        assert.ok(L['0.705'] < L['0.618'] && L['0.618'] < L['0.382'], 'deeper ratios sit nearer the swing origin');
    });
});

// ─── 8a: order-book microstructure ──────────────────────────────────────────

describe('Wave A — 8a order-book slippage & microprice', () => {
    const asks = [{ price: 100, qty: 1 }, { price: 101, qty: 2 }, { price: 102, qty: 4 }];
    const bids = [{ price: 99, qty: 2 }, { price: 98, qty: 3 }];

    it('estimateBookSlippage walks the asks for a buy (vwap, mid reference, impact, levels)', () => {
        const r = estimateBookSlippage(bids, asks, 'buy', 500);
        assert.equal(r.available, true);
        assert.equal(r.levelsConsumed, 3);
        assert.equal(r.worstFillPrice, 102);
        assert.equal(r.remainingUsd, 0);
        assert.equal(r.referenceSource, 'mid');
        assert.ok(near(r.referencePrice ?? 0, 99.5, 1e-9), `ref=${r.referencePrice}`);
        // 500 / (1 + 2 + 198/102) = 101.190476…
        assert.ok(near(r.vwapFillPrice ?? 0, 500 / (1 + 2 + 198 / 102), 1e-6), `vwap=${r.vwapFillPrice}`);
        assert.ok(near(r.impactVsTopBps ?? 0, 119.05, 0.01), `impact=${r.impactVsTopBps}`);
        assert.ok(near(r.slippageVsMidBps ?? 0, 169.9, 0.01), `vsMid=${r.slippageVsMidBps}`);
    });

    it('a thin book refuses with the named shortfall', () => {
        const r = estimateBookSlippage(bids, asks, 'buy', 10_000);
        assert.equal(r.available, false);
        assert.ok(r.reason!.includes('depth insufficient'), r.reason);
        assert.ok(r.remainingUsd > 0);
    });

    it('a sell walks the bids and its impact is a POSITIVE cost', () => {
        const r = estimateBookSlippage(bids, asks, 'sell', 300);
        assert.equal(r.available, true);
        assert.ok((r.impactVsTopBps ?? 0) > 0, `impact=${r.impactVsTopBps}`);
        assert.ok(near(r.impactVsTopBps ?? 0, 34.57, 0.01), `impact=${r.impactVsTopBps}`);
        assert.ok((r.slippageVsMidBps ?? 0) < 0, `vsMid=${r.slippageVsMidBps} (signed: below mid)`);
        assert.equal(r.worstFillPrice, 98);
    });

    it('fetchOrderBookDepth carries the microprice, fetchedAt, and a ladder the estimator can walk', async () => {
        __futuresRateLimitTestHooks.reset();
        await withMockedFetch(marketHandler(), async () => {
            const book = await fetchOrderBookDepth('BTCUSDT');
            assert.ok(book.fetchedAt !== undefined && book.fetchedAt > 0);
            assert.ok(book.micro !== undefined);
            // microprice = (P_b·Q_a + P_a·Q_b) / (Q_b + Q_a) over the top-5 sums.
            const top5BidQty = 3 + 1;
            const top5AskQty = 2 + 1;
            assert.ok(near(book.micro.microprice, (99.5 * top5AskQty + 100.5 * top5BidQty) / (top5BidQty + top5AskQty), 1e-9),
                `micro=${book.micro.microprice}`);
            assert.ok(near(book.micro.top5Imbalance, (top5BidQty - top5AskQty) / (top5BidQty + top5AskQty), 1e-9));
            const impact = estimateBookSlippage(book.bids, book.asks, 'buy', 150);
            assert.equal(impact.available, true);
            assert.equal(impact.levelsConsumed, 1);
            assert.equal(impact.impactVsTopBps, 0);
            assert.ok((impact.slippageVsMidBps ?? 0) > 0);
            const thin = estimateBookSlippage(book.bids, book.asks, 'buy', 10_000);
            assert.equal(thin.available, false, 'thin-book refusal');
        });
    });
});

describe('Wave A/B/C audit pins — universe gate, fib OTE parity, adversary Short/inverted, -0 guard, envelope fields', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('runDerivativesStateTool refuses an unknown symbol with zero futures data calls', async () => {
        await withMockedFetch(marketHandler(), async (calls) => {
            const parsed = JSON.parse(await runDerivativesStateTool('FAKECOINUSDT'));
            assert.equal(parsed.data_quality.available, false);
            assert.equal(calls.filter(u => u.includes('/fapi/v1/klines') || u.includes('/futures/data/')).length, 0);
        });
    });

    it('FIB_RATIOS in chartDrawings includes 0.705 OTE', () => {
        assert.ok((DRAW_FIB_RATIOS as readonly number[]).includes(0.705));
    });

    it('computeFundingDrag never returns -0 on zero Short funding rate', () => {
        const drag = computeFundingDrag({ direction: 'Short', entry: 100, stopLoss: 105, fundingRate: 0, settlements: 3 });
        assert.equal(Object.is(drag, -0), false);
        assert.equal(drag, 0);
    });

    it('fallbackAdversaryVerdict evaluates Short nearest target, deducts round-trip fees, and VETOes inverted brackets', () => {
        const shortThin = fallbackAdversaryVerdict({
            plan: { planId: 's1', symbol: 'BTCUSDT', direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [90, 98.1] },
            markPrice: 100, atr: 2, candles: [{ close: 100 }],
        });
        // Nearest target is 98.1 (0.95R gross < 1R after fees) → CAUTION
        assert.equal(shortThin.verdict, 'CAUTION');
        assert.ok(shortThin.objections.some(o => o.includes('below 1')));

        const inverted = fallbackAdversaryVerdict({
            plan: { planId: 's2', symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 102, takeProfits: [95] },
            markPrice: 100, atr: 2, candles: [{ close: 100 }],
        });
        assert.equal(inverted.verdict, 'VETO');
        assert.ok(inverted.objections.some(o => o.includes('inverted')));
    });

    it('parseTradeProposal refuses non-positive targets before a ratio can be quoted', () => {
        for (const bad of [-5, 0]) {
            const parsed = parseTradeProposal({ direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [bad] });
            assert.equal(parsed.proposal, undefined);
            assert.match(parsed.error ?? '', /positive/);
        }
        assert.equal(parseTradeProposal({ direction: 'Long', entry: 100, stopLoss: 90, takeProfits: [110] }).proposal?.takeProfits[0], 110);
    });

    it('the live proposal gate refuses a plan with no positive target', () => {
        const local = evaluatePlanLocalSync({ symbol: 'BTCUSDT', direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [-5], confidence: 'Medium' });
        assert.match(local.refusal ?? '', /positive target/);
    });

    it('the shared signed R:R never quotes a non-positive target as a reward', () => {
        const bad = plannedRiskRewardSigned({ direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [-5] });
        assert.equal(bad.ratio, 0);
        assert.equal(bad.reward, 0);
        const good = plannedRiskRewardSigned({ direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [95] });
        assert.ok(good.ratio > 0);
    });

    it('the no-evalCtx drawing description omits non-positive fib extensions like chartGeometry', () => {
        const text = describeDrawingsForModel([
            { id: 'f2', shortId: '#D2', kind: 'fib', color: '#fff', createdAt: 0, points: [{ t: 0, p: 200 }, { t: 1, p: 80 }] } as ChartDrawing,
        ]);
        assert.equal(text.includes('200%='), false, 'a 2.0 extension at -40 must never be quoted');
        assert.ok(text.includes('127.2%='), 'the positive 1.272 extension stays');
    });

    it('the no-evalCtx drawing description quotes the SAME fib extensions as chartGeometry', () => {
        const text = describeDrawingsForModel([
            { id: 'f1', shortId: '#D1', kind: 'fib', color: '#fff', createdAt: 0, points: [{ t: 0, p: 100 }, { t: 1, p: 200 }] } as ChartDrawing,
        ]);
        for (const r of DRAW_FIB_RATIOS) assert.ok(text.includes(`${(r * 100).toFixed(1).replace(/\.0$/, '')}%=`), `missing retracement ${r}`);
        for (const r of FIB_EXTENSION_RATIOS) assert.ok(text.includes(`${(r * 100).toFixed(1).replace(/\.0$/, '')}%=`), `missing extension ${r}`);
    });

    it('fallbackAdversaryVerdict VETOes non-positive, NaN and infinite targets and an unknown direction', () => {
        for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
            const v = fallbackAdversaryVerdict({
                plan: { planId: 'bad-tp', symbol: 'BTCUSDT', direction: 'Short', entry: 100, stopLoss: 102, takeProfits: [bad] },
                markPrice: null, atr: 2, candles: [{ close: 100 }],
            });
            assert.equal(v.verdict, 'VETO', `target ${String(bad)} must be refused`);
            assert.ok(v.objections.some(o => o.includes('target')));
        }
        const badDir = fallbackAdversaryVerdict({
            plan: { planId: 'bad-dir', symbol: 'BTCUSDT', direction: 'Flat' as unknown as 'Long' | 'Short', entry: 100, stopLoss: 102, takeProfits: [95] },
            markPrice: null, atr: 2, candles: [{ close: 100 }],
        });
        assert.equal(badDir.verdict, 'VETO');
        assert.ok(badDir.objections.some(o => o.includes('direction')));
    });

    it('get_regime exposes trendScan.byHorizon and imbalances exposes gaps[].midpoint', async () => {
        await withMockedFetch((url) => {
            if (url.includes('/fapi/v1/klines')) {
                const rows: unknown[][] = [];
                for (let i = 0; i < 120; i++) {
                    const t = NOW - (120 - i) * 3_600_000;
                    let open = 100 + i * 0.4 + (i % 3) * 0.3;
                    let high = open + 1.2;
                    let low = open - 0.6;
                    let close = open + 0.6;
                    // Create a clear bullish FVG around bar 115: bar 114 high < bar 116 low
                    if (i === 114) { open = 146; high = 147; low = 145; close = 146.5; }
                    if (i === 115) { open = 147; high = 154; low = 146.5; close = 153.5; }
                    if (i === 116) { open = 153; high = 155; low = 151; close = 154; }
                    if (i > 116) { open = 154; high = 155; low = 152; close = 154.5; }
                    rows.push([t, String(open), String(high), String(low), String(close), '10', t + 3_599_000, '1000', 10, '5', '500', '0']);
                }
                return { json: rows };
            }
            return marketHandler()(url);
        }, async () => {
            const reg = JSON.parse(await runRegimeTool('BTCUSDT', '1h', NOW));
            assert.equal(reg.data_quality.available, true);
            assert.ok(Array.isArray(reg.values.quant.trendScan.byHorizon) && reg.values.quant.trendScan.byHorizon.length === 4);

            const imb = JSON.parse(await runImbalancesTool('BTCUSDT', '1h', NOW));
            assert.equal(imb.data_quality.available, true);
            assert.ok(imb.values.gaps.length >= 1 && typeof imb.values.gaps[0].midpoint === 'number');
        });
    });
});
