/**
 * wave52Capstone — 100% offline unit tests for Wave 5.2 (Final Capstone):
 *   1. In-place `/compact [focus]` (`compactCore` + `compactUndoStore` + `composerRefs`)
 *   2. `spot_vs_perp` (`spotVsPerpCore`: 5 regimes + basis bps + missing spot handling)
 *   3. `scout_market` (`scoutMarket` caps, timeout, <=1200 char brief, Plan Mode & Turn-1=24 parity)
 *   4. Deterministic Pre-Trade Hooks & BTC-beta Correlated Heat (`preTradeHooksCore`, `PaperBrokerService`, `runRiskStateTool`)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'wave52-test-user']]);
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = storageShim;
if (!g.sessionStorage) g.sessionStorage = storageShim;
if (!g.window) {
    g.window = {
        localStorage: storageShim,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
        cancelAnimationFrame: (id: number) => clearTimeout(id),
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    };
}
if (!g.document) {
    g.document = {
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false,
        createElement: () => ({ getContext: () => null }),
    };
}

import type { Kline } from '../src/types/message';
import { compactConversationEntries, type CompactEntryInput } from '../src/services/trade/compactCore';
import {
    saveCompactUndo,
    hasCompactUndo,
    takeCompactUndo,
    __clearCompactUndoForTests,
} from '../src/services/trade/compactUndoStore';
import { SLASH_COMMAND_SUGGESTIONS, slashTemplateOf } from '../src/utils/composerRefs';
import { analyzeSpotVsPerp } from '../src/services/market/spotVsPerpCore';
import {
    formatScoutToolPayload,
    runMarketScout,
    SCOUT_MAX_BRIEF_CHARS,
    SCOUT_MAX_INTERVALS,
    SCOUT_MAX_SYMBOLS,
    SCOUT_TOOL_PAYLOAD_MAX_CHARS,
} from '../src/services/trade/scoutMarket';
import {
    INITIAL_CHART_ACTION_NAMES,
    INITIAL_DESK_TOOL_NAMES,
    loadableDeskToolNamesFor,
} from '../src/services/analysis/DeskToolsService';
import { DESK_TOOL_NAMES, isBlockedInPlanMode } from '../src/utils/toolKinds';
import { CHAT_SURFACE_TOOLS } from '../src/services/trade/chatSurfaceTurn';
import {
    computeCorrelatedPortfolioHeat,
    DEFAULT_PRE_TRADE_HOOKS_SETTINGS,
    evaluatePreTradeHooks,
    resolveBtcBeta,
} from '../src/services/paper/preTradeHooksCore';
import {
    __paperBrokerTestHooks,
    getPaperAccount,
    submitPaperOrder,
} from '../src/services/paper/PaperBrokerService';
import { runRiskStateTool } from '../src/services/analysis/journalTools';

const BASE_MS = Date.parse('2026-10-15T10:00:00.000Z');
const BAR_MS = 15 * 60_000;

const makeBars = (opts: {
    count: number;
    basePrice: number;
    step?: number;
    volume?: number;
    takerRatio: number;
}): Kline[] => {
    const step = opts.step ?? 10;
    const vol = opts.volume ?? 1000;
    const out: Kline[] = [];
    for (let i = 0; i < opts.count; i += 1) {
        const open = opts.basePrice + i * step;
        const close = open + step * 0.5;
        const high = Math.max(open, close) + Math.abs(step) * 0.4 + 5;
        const low = Math.min(open, close) - Math.abs(step) * 0.4 - 5;
        out.push({
            time: BASE_MS + i * BAR_MS,
            open,
            high,
            low,
            close,
            volume: vol,
            takerBuyVolume: vol * opts.takerRatio,
        });
    }
    return out;
};

describe('Wave 5.2 Capstone — /compact, spot_vs_perp, scout_market & Pre-Trade Hooks', () => {
    it('1. /compact compresses older turns with focus/drawings/paper/watches preserved and 1-click Undo restores exact entries', () => {
        __clearCompactUndoForTests();
        assert.ok(SLASH_COMMAND_SUGGESTIONS.some(s => s.command === 'compact'));
        assert.equal(slashTemplateOf('/compact BTC sweep thesis'), 'compact');

        // Short thread: clean no-op
        const shortEntries: CompactEntryInput[] = [
            { id: 'u1', role: 'user', text: 'Check BTCUSDT', at: BASE_MS },
            { id: 'a1', role: 'ai', text: 'BTCUSDT range near 60k.', at: BASE_MS + 1000 },
        ];
        const noop = compactConversationEntries({ entries: shortEntries, keepRecentTurns: 2 });
        assert.equal(noop.compacted, false);
        assert.equal(noop.compactedCount, 0);
        assert.equal(noop.beforeTokens, noop.afterTokens);
        assert.equal(noop.savedPct, 0);
        assert.equal(noop.retainedEntries.length, 2);

        // Long 6-turn thread -> compacts older turns, preserves live metadata
        const verbose = 'Orderflow absorption at key demand zone #D1 with entry 60100, stop 59400, tp1 61800, tp2 63200. '.repeat(8);
        const longEntries: CompactEntryInput[] = [
            { id: 'u1', role: 'user', text: `Turn 1 analyze BTC sweep ${verbose}` },
            { id: 'a1', role: 'ai', text: `Turn 1 reply ${verbose}`, tools: ['get_market_packet BTCUSDT'], toolIds: ['tid-1'] },
            { id: 'u2', role: 'user', text: `Turn 2 check derivatives ${verbose}` },
            { id: 'a2', role: 'ai', text: `Turn 2 reply ${verbose}` },
            { id: 'u3', role: 'user', text: `Turn 3 latest check near 60200` },
            { id: 'a3', role: 'ai', text: `Turn 3 reply keeping context alive` },
            { id: 'u4', role: 'user', text: `Turn 4 final question` },
            { id: 'a4', role: 'ai', text: `Turn 4 final answer` },
        ];
        const res = compactConversationEntries({
            entries: longEntries,
            keepRecentTurns: 2,
            focus: 'BTC sweep thesis',
            activeSymbol: 'BTCUSDT',
            activeInterval: '15m',
            pinnedDrawings: [{ shortId: '#D1', label: 'London Low', kind: 'hline', points: [{ p: 59850 }] }],
            openPaperPositions: [{ symbol: 'BTCUSDT', side: 'long', entryPrice: 60100, stopLoss: 59400, leverage: 3 }],
            armedWatches: [{ symbol: 'BTCUSDT', direction: 'Long', price: 59900, planId: 'plan-1' }],
            toolPayloadLookup: id => (id === 'tid-1' ? 'X'.repeat(800) : null),
        });

        assert.equal(res.compacted, true);
        assert.equal(res.compactedCount, 4);
        assert.equal(res.keptCount, 4);
        assert.ok(res.beforeTokens > res.afterTokens, `expected drop: ${res.beforeTokens} -> ${res.afterTokens}`);
        assert.ok(res.savedPct > 0);
        assert.ok(res.checkpointText.includes('[COMPACTED CONTEXT · BTCUSDT 15m · Focus: BTC sweep thesis]'));
        assert.ok(res.checkpointText.includes('#D1'));
        assert.ok(res.checkpointText.includes('BTCUSDT LONG @ 60100 SL 59400 (3x)'));
        assert.ok(res.checkpointText.includes('BTCUSDT Long @ 59900'));
        assert.deepEqual(res.retainedEntries.map(e => e.id), ['u3', 'a3', 'u4', 'a4']);

        saveCompactUndo('cmp-1', { kind: 'desk', targetId: 'sess-1', entries: longEntries });
        assert.equal(hasCompactUndo('cmp-1'), true);
        const taken = takeCompactUndo('cmp-1');
        assert.equal(hasCompactUndo('cmp-1'), false);
        assert.equal(taken?.entries?.length, longEntries.length);
    });

    it('2. spotVsPerpCore classifies all 5 regimes, computes basis bps, and handles missing/delisted spot', () => {
        const spotUp = makeBars({ count: 20, basePrice: 60000, takerRatio: 0.65 });
        const perpDown = makeBars({ count: 20, basePrice: 60060, takerRatio: 0.35 });
        const absorption = analyzeSpotVsPerp({
            symbol: 'BTCUSDT', interval: '15m', spotKlines: spotUp, perpKlines: perpDown, fundingRate: 0.0001,
        });
        assert.equal(absorption.spotAvailable, true);
        assert.equal(absorption.regime, 'spot_absorption');
        assert.ok(absorption.basisBps !== null && absorption.basisBps > 0);

        const spotFlat = makeBars({ count: 20, basePrice: 60000, takerRatio: 0.50 });
        const perpChase = makeBars({ count: 20, basePrice: 60090, takerRatio: 0.72 });
        const chasing = analyzeSpotVsPerp({
            symbol: 'SOLUSDT', interval: '15m', spotKlines: spotFlat, perpKlines: perpChase,
        });
        assert.equal(chasing.regime, 'perp_chasing');

        const alignedBull = analyzeSpotVsPerp({
            symbol: 'ETHUSDT', interval: '15m',
            spotKlines: makeBars({ count: 20, basePrice: 3000, takerRatio: 0.62 }),
            perpKlines: makeBars({ count: 20, basePrice: 3003, takerRatio: 0.63 }),
        });
        assert.equal(alignedBull.regime, 'aligned_bull');

        const alignedBear = analyzeSpotVsPerp({
            symbol: 'ETHUSDT', interval: '15m',
            spotKlines: makeBars({ count: 20, basePrice: 3000, takerRatio: 0.36 }),
            perpKlines: makeBars({ count: 20, basePrice: 2997, takerRatio: 0.35 }),
        });
        assert.equal(alignedBear.regime, 'aligned_bear');

        const neutral = analyzeSpotVsPerp({
            symbol: 'BNBUSDT', interval: '15m',
            spotKlines: makeBars({ count: 20, basePrice: 600, takerRatio: 0.505 }),
            perpKlines: makeBars({ count: 20, basePrice: 600, takerRatio: 0.505 }),
        });
        assert.equal(neutral.regime, 'neutral');

        // Heavy spot selling into mild perp buying must NOT misclassify as spot_absorption
        const spotDumpMildPerp = analyzeSpotVsPerp({
            symbol: 'AVAXUSDT', interval: '15m',
            spotKlines: makeBars({ count: 20, basePrice: 30, takerRatio: 0.32 }),
            perpKlines: makeBars({ count: 20, basePrice: 30.05, takerRatio: 0.53 }),
        });
        assert.notEqual(spotDumpMildPerp.regime, 'spot_absorption');
        assert.equal(spotDumpMildPerp.regime, 'neutral');

        const spotDumpPerpChase = analyzeSpotVsPerp({
            symbol: 'AVAXUSDT', interval: '15m',
            spotKlines: makeBars({ count: 20, basePrice: 30, takerRatio: 0.32 }),
            perpKlines: makeBars({ count: 20, basePrice: 30.1, takerRatio: 0.72 }),
        });
        assert.notEqual(spotDumpPerpChase.regime, 'spot_absorption');
        assert.equal(spotDumpPerpChase.regime, 'perp_chasing');

        const missingSpot = analyzeSpotVsPerp({
            symbol: 'PERPONLYUSDT', interval: '15m', spotKlines: [], perpKlines: perpChase,
        });
        assert.equal(missingSpot.spotAvailable, false);
        assert.equal(missingSpot.regime, 'neutral');
        assert.equal(missingSpot.spotCvd, null);
        assert.equal(missingSpot.basisBps, null);
        assert.ok(missingSpot.reason?.includes('unavailable'));
    });

    it('3. scoutMarket enforces caps, forming-bar exclusion & <=1800 char payload, and spot_vs_perp + scout_market stay behind load_tools (Turn-1=24, Plan Mode allowed)', async () => {
        const res = await runMarketScout({
            symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'DOGEUSDT', 'ADAUSDT'],
            intervals: ['15m', '1h', '4h'],
            focus: 'spot_absorption',
            timeoutMs: 80,
            fetchers: {
                fetchPerpKlines: async (sym) => {
                    if (sym === 'BNBUSDT') {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    return makeBars({ count: 40, basePrice: 100, takerRatio: sym === 'SOLUSDT' ? 0.35 : 0.62 });
                },
                fetchSpotKlines: async (sym) => makeBars({
                    count: 40,
                    basePrice: 100,
                    takerRatio: sym === 'SOLUSDT' ? 0.68 : 0.60,
                }),
                fetchFundingRate: async () => 0.0001,
                fetchOpenInterestUsd: async () => 50_000_000,
            },
        });

        assert.equal(res.ok, true);
        assert.equal(res.symbolsScanned.length, SCOUT_MAX_SYMBOLS);
        assert.equal(res.intervalsUsed.length, SCOUT_MAX_INTERVALS);
        assert.ok(res.timedOutSymbols.includes('BNBUSDT'));
        assert.ok(res.briefChars <= SCOUT_MAX_BRIEF_CHARS);
        assert.ok(res.brief.length <= 1200);

        // Compact tool payload stays strictly <= 1800 chars with brief first
        const wire = formatScoutToolPayload(res);
        assert.ok(wire.length <= SCOUT_TOOL_PAYLOAD_MAX_CHARS, `expected <= ${SCOUT_TOOL_PAYLOAD_MAX_CHARS}, got ${wire.length}`);
        const parsedWire = JSON.parse(wire) as Record<string, unknown>;
        assert.equal(Object.keys(parsedWire)[0], 'brief');
        assert.equal(parsedWire.brief, res.brief);
        const oversizedWire = formatScoutToolPayload({ ...res, brief: 'X'.repeat(2400) });
        assert.ok(oversizedWire.length <= SCOUT_TOOL_PAYLOAD_MAX_CHARS);
        assert.equal(typeof (JSON.parse(oversizedWire) as { brief?: string }).brief, 'string');

        // Forming candle exclusion: mutating only the final unclosed candle must not change divergence read
        const baseBars = makeBars({ count: 45, basePrice: 100, takerRatio: 0.55 });
        const spikedBars = baseBars.map((b, idx) => idx === baseBars.length - 1
            ? { ...b, high: 250, low: 40, close: 42, takerBuyVolume: 10 }
            : b);
        const scoutBase = await runMarketScout({
            symbols: ['BTCUSDT'],
            intervals: ['15m'],
            fetchers: {
                fetchPerpKlines: async () => baseBars,
                fetchSpotKlines: async () => baseBars,
            },
        });
        const scoutSpiked = await runMarketScout({
            symbols: ['BTCUSDT'],
            intervals: ['15m'],
            fetchers: {
                fetchPerpKlines: async () => spikedBars,
                fetchSpotKlines: async () => baseBars,
            },
        });
        assert.equal(scoutSpiked.ranked[0].divergenceCount, scoutBase.ranked[0].divergenceCount);
        assert.equal(scoutSpiked.ranked[0].topDivergence, scoutBase.ranked[0].topDivergence);

        // Turn-1 invariant: MUST stay exact 24
        const nonVisionInitialChart = [...INITIAL_CHART_ACTION_NAMES].filter(n => n !== 'inspect_chart_image');
        assert.equal(INITIAL_DESK_TOOL_NAMES.length + nonVisionInitialChart.length, 24);
        assert.equal(INITIAL_DESK_TOOL_NAMES.includes('spot_vs_perp'), false);
        assert.equal(INITIAL_DESK_TOOL_NAMES.includes('scout_market'), false);

        // Strictly behind load_tools, allowed on Chat & Plan Mode
        for (const toolName of ['spot_vs_perp', 'scout_market'] as const) {
            assert.equal(DESK_TOOL_NAMES.includes(toolName), true, `${toolName} missing from DESK_TOOL_NAMES`);
            assert.equal(CHAT_SURFACE_TOOLS.includes(toolName), true, `${toolName} missing from CHAT_SURFACE_TOOLS`);
            assert.equal(isBlockedInPlanMode(toolName), false, `${toolName} must remain allowed in Plan Mode`);
            assert.equal(loadableDeskToolNamesFor(true, DESK_TOOL_NAMES, true).includes(toolName), true);
        }
    });

    it('4. preTradeHooksCore + PaperBrokerService + risk_state enforce correlated heat, hedges, chop/funding hooks & never block close/cancel', async () => {
        // Beta tiers
        assert.equal(resolveBtcBeta('BTCUSDT'), 1.0);
        assert.equal(resolveBtcBeta('ETHUSDT'), 1.15);
        assert.equal(resolveBtcBeta('SOLUSDT'), 1.35);
        assert.equal(resolveBtcBeta('DOGEUSDT'), 1.55);

        // Heat calculation + risk-reducing hedge check
        const hedgeHeat = computeCorrelatedPortfolioHeat({
            positions: [
                { symbol: 'SOLUSDT', side: 'long', riskPct: 1.0 },
                { symbol: 'AVAXUSDT', side: 'long', riskPct: 1.0 },
            ],
            candidate: { symbol: 'BTCUSDT', side: 'short', riskPct: 1.0 },
        });
        assert.equal(hedgeHeat.currentNetBetaHeatPct, 2.7);
        assert.equal(hedgeHeat.projectedNetBetaHeatPct, 1.7);
        assert.equal(hedgeHeat.reducesNetHeat, true);

        // Chop breakout vs range-play thesis
        const chopBlock = evaluatePreTradeHooks({
            hooks: { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS, blockChopBreakout: true },
            positions: [],
            candidate: { symbol: 'BTCUSDT', side: 'long', riskPct: 1.0, thesis: 'Momentum breakout above resistance' },
            regime: 'chop:compressed',
        });
        assert.equal(chopBlock.ok, false);
        assert.equal(chopBlock.violations[0].hook, 'chop_breakout');

        const chopSweepAllowed = evaluatePreTradeHooks({
            hooks: { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS, blockChopBreakout: true },
            positions: [],
            candidate: { symbol: 'BTCUSDT', side: 'long', riskPct: 1.0, thesis: 'London sweep reclaim long' },
            regime: 'chop:compressed',
        });
        assert.equal(chopSweepAllowed.ok, true);

        // Extreme funding crowded side vs counter side
        const fundingCrowded = evaluatePreTradeHooks({
            hooks: { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS, blockExtremeFunding: true },
            positions: [],
            candidate: { symbol: 'ETHUSDT', side: 'long', riskPct: 1.0 },
            fundingRate: 0.0006,
        });
        assert.equal(fundingCrowded.ok, false);
        assert.equal(fundingCrowded.violations[0].hook, 'extreme_funding');

        const fundingCounter = evaluatePreTradeHooks({
            hooks: { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS, blockExtremeFunding: true },
            positions: [],
            candidate: { symbol: 'ETHUSDT', side: 'short', riskPct: 1.0 },
            fundingRate: 0.0006,
        });
        assert.equal(fundingCounter.ok, true);

        // Live PaperBrokerService end-to-end: 2 alt longs ok -> 3rd alt long blocked -> hedge ok -> close & cancel never blocked
        const user = 'wave52-hooks-paper-user';
        await __paperBrokerTestHooks.clear(user);

        const quotes: Record<string, number> = {
            SOLUSDT: 150,
            AVAXUSDT: 30,
            DOGEUSDT: 0.2,
            BTCUSDT: 60000,
        };
        const commonDeps = {
            username: user,
            nowMs: BASE_MS,
            knownSymbol: async () => true,
            quoteProvider: async (sym: string) => {
                const px = quotes[sym] ?? 100;
                return {
                    mark: px,
                    quote: { last: px, bestBid: px * 0.9995, bestAsk: px * 1.0005 },
                    fundingRate: 0.0001,
                    fundingFrames: [],
                };
            },
            markPrices: quotes,
            preTradeHooks: { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS },
            regime: 'trend:normal',
        };

        const r1 = await submitPaperOrder({
            action: 'open_market', symbol: 'SOLUSDT', side: 'long',
            risk_pct: 1.0, leverage: 2, entry_price: 150, stop_loss: 142.5, take_profits: [165],
        }, commonDeps);
        assert.equal(r1.ok, true, r1.reason);

        const r2 = await submitPaperOrder({
            action: 'open_market', symbol: 'AVAXUSDT', side: 'long',
            risk_pct: 1.0, leverage: 2, entry_price: 30, stop_loss: 28.5, take_profits: [33],
        }, commonDeps);
        assert.equal(r2.ok, true, r2.reason);

        // 3rd alt long (DOGE 1.55x -> net 4.25% > 3.0% cap) MUST be refused with zero account mutation
        const r3Blocked = await submitPaperOrder({
            action: 'open_market', symbol: 'DOGEUSDT', side: 'long',
            risk_pct: 1.0, leverage: 2, entry_price: 0.2, stop_loss: 0.19, take_profits: [0.22],
        }, commonDeps);
        assert.equal(r3Blocked.ok, false);
        assert.equal(r3Blocked.error, 'pre_trade_hook_blocked');
        assert.ok(r3Blocked.reason?.includes('correlated_heat'));
        assert.equal((await getPaperAccount(user)).positions.length, 2);

        // Risk-reducing BTC short hedge MUST be allowed
        const rHedge = await submitPaperOrder({
            action: 'open_market', symbol: 'BTCUSDT', side: 'short',
            risk_pct: 1.0, leverage: 2, entry_price: 60000, stop_loss: 61500, take_profits: [57000],
        }, commonDeps);
        assert.equal(rHedge.ok, true, rHedge.reason);
        const acctAfterHedge = await getPaperAccount(user);
        assert.equal(acctAfterHedge.positions.length, 3);

        // risk_state reports live correlated_heat from paper positions
        const riskJson = JSON.parse(runRiskStateTool([], BASE_MS, {
            paperPositions: acctAfterHedge.positions,
            paperEquityUsd: acctAfterHedge.cashBalanceUsd,
            preTradeHooks: DEFAULT_PRE_TRADE_HOOKS_SETTINGS,
        }));
        assert.equal(riskJson.values.correlated_heat.currentNetBetaHeatPct, 1.7);
        assert.equal(riskJson.values.correlated_heat.maxCorrelatedHeatPct, 3);
        assert.ok(String(riskJson.one_line_summary).includes('net BTC-beta heat'));

        // Even with an impossibly tight 0.5% cap, close MUST NEVER be blocked
        const tightHooks = { ...DEFAULT_PRE_TRADE_HOOKS_SETTINGS, maxCorrelatedHeatPct: 0.5 };
        const solPosId = acctAfterHedge.positions.find(p => p.symbol === 'SOLUSDT')!.id;
        const rClose = await submitPaperOrder({
            action: 'close', symbol: 'SOLUSDT', position_id: solPosId,
        }, { ...commonDeps, preTradeHooks: tightHooks });
        assert.equal(rClose.ok, true, rClose.reason);

        // Pending limit open + cancel under tight hooks: open limit blocked, cancel never blocked
        const blockedLimit = await submitPaperOrder({
            action: 'open_limit', symbol: 'ETHUSDT', side: 'long',
            risk_pct: 1.0, leverage: 2, entry_price: 2900, stop_loss: 2800, take_profits: [3100],
        }, { ...commonDeps, preTradeHooks: tightHooks });
        assert.equal(blockedLimit.ok, false);
        assert.equal(blockedLimit.error, 'pre_trade_hook_blocked');

        const cancelMissing = await submitPaperOrder({
            action: 'cancel', symbol: 'ETHUSDT', order_id: 'ord-nonexistent',
        }, { ...commonDeps, preTradeHooks: tightHooks });
        assert.notEqual(cancelMissing.error, 'pre_trade_hook_blocked');
    });
});
