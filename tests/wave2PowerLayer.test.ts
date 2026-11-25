/**
 * wave2PowerLayer — offline runtime verification for Wave 2 (Claude-Code-for-Trading Power Layer):
 *
 *  1. Read-only Plan Mode: 3-seam lock (wire filter, load_tools filter, hard dispatch
 *     refusal), watch suppression in present_trade, cross-surface chatStore sync, and
 *     TradeProposalCard unlock control.
 *  2. Historical pattern micro-backtester (`setup_replay`): zero-lookahead invariance,
 *     conservative intrabar stop-before-target fill, non-overlapping trades, negative
 *     fee drag on wins & losses, Wilson CI, thin-sample refusal, and <250ms budget.
 *  3. Non-repainting divergences (`divergences`): regular & hidden bullish/bearish
 *     across RSI, MACD histogram, and CVD; unconfirmed tail exclusion; Unix-second
 *     coordinate parity with `drawableLevelsFor` and `drawToolLevels` (`kind: 'trend'`).
 *  4. Condition-scoped trading rules (`scopedRules`): chop, extreme funding, drawdown
 *     cooldown, kill-switch, graceful null omission, and KV-cache prefix purity.
 *  5. Harness diagnostics (`/context`, `/doctor`) & slash parser: safe without
 *     `window.electronAPI`, empty paper store, or 0 mark; safe argument parsing.
 *  6. `TOOL_REGISTRY` parity for `setup_replay` and `divergences`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const backing = new Map<string, string>([['last_active_user', 'wave2-probe']]);
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
import type { ProviderConfig } from '../src/types/provider';
import {
    DESK_TOOL_NAMES,
    PLAN_MODE_BLOCKED_TOOLS,
    PLAN_MODE_MANDATE,
    filterToolsForPlanMode,
    isBlockedInPlanMode,
} from '../src/utils/toolKinds';
import {
    DESK_TOOL_DEFINITIONS,
    INITIAL_DESK_TOOL_NAMES,
    executeDeskTool,
    loadableDeskToolNamesFor,
    runDeskToolLoop,
} from '../src/services/analysis/DeskToolsService';
import {
    CHAT_SURFACE_TOOLS,
    clearChatSurfacePromptCache,
    runChatSurfaceTurn,
    surfacePromptWith,
} from '../src/services/trade/chatSurfaceTurn';
import * as chatStore from '../src/services/trade/chatStore';
import { runPresentTrade } from '../src/services/trade/presentTradeTool';
import TradeProposalCard from '../src/components/trade/panels/TradeProposalCard';
import {
    REPLAY_SUPPORTED_SETUPS,
    runSetupReplay,
} from '../src/services/market/setupReplayCore';
import {
    detectDivergences,
    toUnixSeconds,
} from '../src/services/market/divergenceCore';
import { drawableLevelsFor, DRAWABLE_TOOLS } from '../src/services/analysis/marketTools';
import { evaluateScopedRules } from '../src/services/trade/scopedRules';
import { collectScopedRulesForSymbol } from '../src/services/trade/scopedRulesRuntime';
import {
    buildContextDiagnostic,
    buildDoctorDiagnostic,
} from '../src/services/trade/diagnosticsCore';
import { collectDoctorDiagnostic } from '../src/services/trade/diagnosticsRuntime';
import {
    SLASH_COMMAND_SUGGESTIONS,
    parsePlanSlashArgs,
    slashTemplateOf,
} from '../src/utils/composerRefs';
import { contentVersion } from '../src/services/learning/SkillFileService';
import { setPreference } from '../src/services/infrastructure/PreferencesService';
import { createPaperAccount } from '../src/services/paper/paperCore';
import { getPaperAccount } from '../src/services/paper/PaperBrokerService';
import { publishPaperMark, resetPaperFrameCache } from '../src/services/trade/futuresStreams';

const BASE_TIME_MS = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;

const makeKline = (
    idx: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 1000,
    takerBuyVolume = 500,
): Kline => ({
    time: BASE_TIME_MS + idx * HOUR_MS,
    open,
    high,
    low,
    close,
    volume,
    takerBuyVolume,
});

const makeFlatRangeCandles = (count: number, base = 100): Kline[] => {
    const out: Kline[] = [];
    for (let i = 0; i < count; i += 1) {
        const wave = Math.sin(i * 0.4) * 1.2;
        const c = base + wave;
        out.push(makeKline(i, c - 0.3, c + 0.8, c - 0.8, c, 1000, 520));
    }
    return out;
};

describe('Wave 2 Power Layer', () => {
    it('1. Plan Mode enforces 3-seam tool lock, suppresses watch auto-arming, and syncs across store', async () => {
        // Seam 1 helper: strips blocked tools, keeps analytical & planning tools
        const sampleSet = [
            'paper_order', 'emit_signal', 'watch_price', 'wake_me', 'remember', 'memory',
            'skill_manage', 'repo_edit', 'trade_math', 'setup_replay', 'divergences',
            'draw_on_chart', 'mark_trade_levels', 'present_trade', 'decline_trade', 'inspect_chart_image',
        ];
        const filtered = filterToolsForPlanMode(sampleSet, true);
        for (const blocked of ['paper_order', 'emit_signal', 'watch_price', 'wake_me', 'remember', 'memory', 'skill_manage', 'repo_edit']) {
            assert.equal(filtered.includes(blocked), false, `${blocked} must be stripped in Plan Mode`);
            assert.equal(isBlockedInPlanMode(blocked), true);
        }
        for (const kept of ['trade_math', 'setup_replay', 'divergences', 'draw_on_chart', 'mark_trade_levels', 'present_trade', 'decline_trade', 'inspect_chart_image']) {
            assert.equal(filtered.includes(kept), true, `${kept} must stay enabled in Plan Mode`);
            assert.equal(isBlockedInPlanMode(kept), false);
        }
        assert.equal(PLAN_MODE_BLOCKED_TOOLS.has('paper_order'), true);

        // Seam 2: loadableDeskToolNamesFor excludes blocked tools in Plan Mode & hides silent legacy aliases
        const loadableNormal = loadableDeskToolNamesFor(true, 'all', false);
        const loadablePlan = loadableDeskToolNamesFor(true, 'all', true);
        assert.equal(loadableNormal.includes('skill_write'), false, 'skill_write is a silent legacy alias');
        assert.equal(loadableNormal.includes('memory_delete'), true);
        assert.equal(loadablePlan.includes('memory_delete'), false);
        assert.equal(loadablePlan.includes('skill_write'), false);
        assert.equal(loadablePlan.includes('setup_replay'), true);
        assert.equal(loadablePlan.includes('divergences'), true);

        // Seam 2 + 1 live loop check: load_tools refuses blocked names while keeping setup_replay
        const seenToolsPerRound: string[][] = [];
        let roundIdx = 0;
        const mockProvider: ProviderConfig = {
            id: 'mock',
            name: 'Mock',
            apiKey: 'test',
            baseUrl: 'http://127.0.0.1:0',
            selectedModel: 'gpt-4o',
            models: ['gpt-4o'],
            isBuiltIn: false,
            isEnabled: true,
            apiFormat: 'chat_completions',
        };
        const loopRes = await runDeskToolLoop({
            config: mockProvider,
            messages: [{ role: 'user', content: 'Plan BTC' }],
            nativeTools: true,
            allowedTools: 'all',
            planMode: true,
            sendTurn: async (_cfg, _msgs, opts) => {
                seenToolsPerRound.push((opts?.tools ?? []).map(t => t.function.name));
                if (roundIdx === 0) {
                    roundIdx += 1;
                    return {
                        text: '',
                        reasoning: '',
                        finishReason: 'tool_calls',
                        truncated: false,
                        assistantMessage: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [{
                                id: 'tc1',
                                type: 'function',
                                function: {
                                    name: 'load_tools',
                                    arguments: JSON.stringify({ names: ['skill_write', 'setup_replay'] }),
                                },
                            }],
                        },
                        toolCalls: [{ id: 'tc1', name: 'load_tools', arguments: { names: ['skill_write', 'setup_replay'] } }],
                    };
                }
                return { text: 'Plan verified.', reasoning: '', finishReason: 'stop', truncated: false, toolCalls: [] };
            },
        });
        assert.equal(seenToolsPerRound[0].includes('paper_order'), false);
        assert.equal(seenToolsPerRound[0].includes('remember'), false);
        assert.equal(seenToolsPerRound[0].includes('trade_math'), true);
        assert.equal(seenToolsPerRound[1].includes('setup_replay'), true);
        assert.equal(seenToolsPerRound[1].includes('skill_write'), false);
        const loadToolMsg = loopRes.messages.find(m => m.role === 'tool' && m.tool_call_id === 'tc1');
        assert.ok(loadToolMsg && String(loadToolMsg.content).includes('skill_write') && String(loadToolMsg.content).includes('blockedInPlanMode'));

        // Seam 3: Direct dispatch bypass fails closed with `plan_mode_locked`
        const directOrder = await executeDeskTool(
            { id: 'c1', name: 'paper_order', arguments: { action: 'open_market', symbol: 'BTCUSDT', side: 'long' } },
            { allowedTools: 'all', planMode: true, defaultSymbol: 'BTCUSDT' },
        );
        assert.equal(directOrder.ok, false);
        assert.equal(JSON.parse(directOrder.content).error, 'plan_mode_locked');

        const directRemember = await executeDeskTool(
            { id: 'c2', name: 'remember', arguments: { slug: 'x', description: 'y', body: 'z' } },
            { allowedTools: 'all', planMode: true },
        );
        assert.equal(directRemember.ok, false);
        assert.equal(JSON.parse(directRemember.content).error, 'plan_mode_locked');

        // present_trade under Plan Mode suppresses armPlan and prints Plan Mode receipt
        let armed = false;
        let presentedProposal: unknown = null;
        const ptRes = await runPresentTrade(
            {
                call: {
                    id: 'pt1',
                    name: 'present_trade',
                    arguments: { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110] },
                },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 100,
                crossCanvas: false,
                watchable: true,
                planMode: true,
                canvasNote: '',
            },
            {
                setProposal: p => { presentedProposal = p; },
                armPlan: () => { armed = true; },
            },
            {
                getAccount: async () => ({ equityUsd: 10_000, riskPercent: 1, leverage: 10 }),
                getFunding: async () => ({ rate: 0.0001, intervalHours: 8 }),
                getCandles: async () => makeFlatRangeCandles(40, 100),
            },
        );
        assert.equal(ptRes.ok, true);
        assert.equal(armed, false, 'present_trade must NOT auto-arm background watch in Plan Mode');
        assert.ok(presentedProposal);
        assert.ok(ptRes.content.includes('Plan Mode is active (read-only)'));

        // chatStore cross-surface session-scoped Plan Mode sync
        chatStore.__resetForTests();
        const sid = chatStore.getActiveId();
        assert.equal(chatStore.getPlanMode(sid), false);
        chatStore.togglePlanMode(sid);
        assert.equal(chatStore.getPlanMode(sid), true);
        assert.equal(chatStore.getSnapshot().planMode[sid], true);
        chatStore.setPlanMode(false, sid);
        assert.equal(chatStore.getPlanMode(sid), false);

        // TradeProposalCard renders Unlock execution button when planMode=true
        const html = renderToStaticMarkup(
            React.createElement(TradeProposalCard, {
                proposal: {
                    symbol: 'BTCUSDT',
                    direction: 'Long',
                    entry: 100,
                    stopLoss: 95,
                    takeProfits: [110],
                    confidence: 'Medium',
                    rationale: 'Test',
                },
                canLog: true,
                planMode: true,
                onUnlockPlanMode: () => {},
                onApprove: () => {},
                onReject: () => {},
                onAskWhy: () => {},
            }),
        );
        assert.ok(html.includes('data-testid="plan-mode-unlock-btn"'));
        assert.ok(html.includes('Unlock execution'));
    });

    it('2. setup_replay enforces zero-lookahead, stop-first intrabar, non-overlap, negative fee drag, and <250ms budget', () => {
        // Unknown setup returns explicit supportedSetups
        const bad = runSetupReplay(makeFlatRangeCandles(60), { symbol: 'BTCUSDT', interval: '1h', setup: 'magic_unicorn' });
        assert.equal(bad.ok, false);
        if (!bad.ok) {
            assert.equal(bad.error, 'unknown_setup');
            assert.deepEqual(bad.supportedSetups, REPLAY_SUPPORTED_SETUPS);
        }

        // Construct deterministic Turtle Soup bullish trigger at bar k=40 (after 20-bar low at ~95):
        // bar 39 closes below 95 (at 94), bar 40 closes back above 95 (at 96).
        const baseCandles: Kline[] = [];
        for (let i = 0; i < 60; i += 1) {
            baseCandles.push(makeKline(i, 100, 101, 95, 100));
        }
        baseCandles[39] = makeKline(39, 98, 99, 93, 94);
        baseCandles[40] = makeKline(40, 94, 97, 93.5, 96);
        // Bar 41 (entry bar at open=96): touches BOTH stop (<= ~91) AND target (>= ~106)
        baseCandles[41] = makeKline(41, 96, 120, 80, 115);

        const resA = runSetupReplay(baseCandles, {
            symbol: 'BTCUSDT',
            interval: '1h',
            setup: 'turtle_soup',
            direction: 'Long',
            stopAtrMult: 1.5,
            targetR: 2.0,
        });
        assert.equal(resA.ok, true);
        if (resA.ok) {
            assert.equal(resA.sampleCount, 1);
            // Conservative intrabar resolution: bar 41 touched BOTH SL and TP -> MUST be LOSS
            assert.equal(resA.recentOccurrences[0].exitReason, 'stop');
            assert.equal(resA.recentOccurrences[0].grossR, -1);
            // Fee drag subtracts from grossR -> netR strictly deeper than -1.0
            assert.ok(resA.recentOccurrences[0].netR < resA.recentOccurrences[0].grossR);
            assert.ok(resA.recentOccurrences[0].netR < -1);
            // Thin sample < 5 -> sufficientSample: false + warning
            assert.equal(resA.sufficientSample, false);
            assert.ok(resA.warning && resA.warning.includes('N=1 < 5'));
            assert.ok(resA.wilson95Ci !== null);
        }

        // Strict lookahead proof: massively mutate bars 42..59 -> bar 40 trigger & entry MUST remain identical
        const mutatedFuture = baseCandles.map((c, idx) =>
            idx >= 42 ? makeKline(idx, 500, 900, 10, 800, 99999, 99999) : c,
        );
        const resB = runSetupReplay(mutatedFuture, {
            symbol: 'BTCUSDT',
            interval: '1h',
            setup: 'turtle_soup',
            direction: 'Long',
            stopAtrMult: 1.5,
            targetR: 2.0,
        });
        assert.equal(resB.ok, true);
        if (resA.ok && resB.ok) {
            assert.equal(resB.recentOccurrences[0].triggerTime, resA.recentOccurrences[0].triggerTime);
            assert.equal(resB.recentOccurrences[0].entry, resA.recentOccurrences[0].entry);
        }

        // Non-overlapping trades + winning fee drag proof:
        // Trigger at bar 40, open holds smoothly for 5 bars before hitting TP; trigger another at bar 41 (must be skipped!)
        const holdCandles = makeFlatRangeCandles(90, 100).map((c, i) => makeKline(i, 100, 101, 95, 100));
        holdCandles[39] = makeKline(39, 98, 99, 93, 94);
        holdCandles[40] = makeKline(40, 94, 97, 93.5, 96);
        holdCandles[41] = makeKline(41, 96, 97.5, 95.5, 97); // also closes back inside, but trade is ALREADY open!
        holdCandles[42] = makeKline(42, 97, 98, 96, 97.5);
        holdCandles[43] = makeKline(43, 97.5, 120, 97, 118); // hits TP cleanly

        const resHold = runSetupReplay(holdCandles, {
            symbol: 'BTCUSDT',
            interval: '1h',
            setup: 'turtle_soup',
            direction: 'Long',
            stopAtrMult: 1.5,
            targetR: 2.0,
        });
        assert.equal(resHold.ok, true);
        if (resHold.ok) {
            assert.equal(resHold.sampleCount, 1, 'Adjacent triggering bar 41 must be skipped while bar 40 trade is open');
            assert.equal(resHold.recentOccurrences[0].exitReason, 'target');
            assert.equal(resHold.recentOccurrences[0].grossR, 2);
            assert.ok(resHold.recentOccurrences[0].netR < 2, 'Fee drag must shrink winning netR');
        }

        // Performance budget (< 250ms on 500 synthetic bars)
        const perfCandles = makeFlatRangeCandles(500, 100);
        const t0 = performance.now();
        runSetupReplay(perfCandles, { symbol: 'BTCUSDT', interval: '1h', setup: 'turtle_soup', lookbackBars: 500 });
        runSetupReplay(perfCandles, { symbol: 'BTCUSDT', interval: '1h', setup: 'trend_pullback', lookbackBars: 500 });
        const elapsed = performance.now() - t0;
        assert.ok(elapsed < 250, `Expected 500-bar replay < 250ms, got ${elapsed.toFixed(1)}ms`);
    });

    it('3. divergences detects all 4 classes across RSI/MACD/CVD, never repaints tail, and matches chartDrawings seconds', () => {
        // Helper to build a candle array where two confirmed swing pivots form a divergence
        const buildBullDivCandles = (): Kline[] => {
            // Uptrend base -> drop to pivot A (idx 32) -> bounce -> drop lower to pivot B (idx 44) with gentler/higher delta & milder drop
            const out: Kline[] = [];
            for (let i = 0; i < 55; i += 1) {
                let close: number;
                let low: number;
                let high: number;
                let buy = 500;
                if (i < 24) {
                    close = 110 + (i % 2 === 0 ? 0.4 : -0.2);
                    low = close - 0.5;
                    high = close + 0.5;
                } else if (i >= 24 && i <= 32) {
                    // Sharp sell-off into pivot A at i=32 (massive sell delta -> low CVD & low RSI)
                    const step = i - 24;
                    close = 110 - step * 1.4;
                    low = close - 0.4;
                    high = close + 0.3;
                    buy = 100; // heavy selling
                } else if (i > 32 && i <= 38) {
                    // Bounce
                    const step = i - 32;
                    close = 98.8 + step * 1.2;
                    low = close - 0.3;
                    high = close + 0.4;
                    buy = 850; // strong buying
                } else if (i > 38 && i <= 44) {
                    // Drift gently to slightly lower price low at i=44, with positive taker delta
                    const step = i - 38;
                    close = 106 - step * 1.3; // at i=44: 98.2 (< 98.8 at i=32)
                    low = i === 44 ? 97.5 : close - 0.2; // strictly lower low than i=32 (98.4)
                    high = close + 0.3;
                    buy = 720; // CVD rises while price makes lower low!
                } else {
                    // Recovery confirming right shoulder at i=44 (45..54)
                    const step = i - 44;
                    close = 99 + step * 0.8;
                    low = close - 0.2;
                    high = close + 0.4;
                    buy = 750;
                }
                out.push(makeKline(i, close - 0.1, high, low, close, 1000, buy));
            }
            return out;
        };

        const bullCandles = buildBullDivCandles();
        const bullRead = detectDivergences(bullCandles, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        const closedLen = bullCandles.length - 1;
        // Non-repainting invariant: NO pivot may sit inside the trailing pivotRight bars
        for (const d of bullRead.divergences) {
            assert.ok(d.pivotA.index <= closedLen - 1 - 3);
            assert.ok(d.pivotB.index <= closedLen - 1 - 3);
            // Canonical Unix seconds (< 1e11)
            assert.ok(d.pivotA.time < 1e11 && d.pivotA.time === toUnixSeconds(bullCandles[d.pivotA.index].time));
            assert.ok(d.pivotB.time < 1e11 && d.pivotB.time === toUnixSeconds(bullCandles[d.pivotB.index].time));
        }
        assert.ok(
            bullRead.divergences.some(d => d.kind === 'regular_bullish' && (d.indicator === 'rsi' || d.indicator === 'macd' || d.indicator === 'cvd')),
            `Expected regular_bullish divergence, got: ${JSON.stringify(bullRead.divergences.map(d => `${d.indicator}:${d.kind}`))}`,
        );

        // Mutating the forming candle (last bar) and final 3 closed bars MUST NOT emit a pivot in the unconfirmed tail
        const extremeTail = bullCandles.map((c, idx) =>
            idx >= bullCandles.length - 4 ? makeKline(idx, 50, 200, 10, 40, 5000, 100) : c,
        );
        const tailRead = detectDivergences(extremeTail, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        for (const d of tailRead.divergences) {
            assert.ok(d.pivotB.index <= closedLen - 1 - 3, `Unconfirmed tail bar ${d.pivotB.index} leaked as pivot`);
        }

        // Bearish mirror -> regular_bearish
        const bearCandles = bullCandles.map((c, i) => {
            const invClose = 220 - c.close;
            const invHigh = 220 - c.low;
            const invLow = 220 - c.high;
            return makeKline(i, invClose + 0.1, invHigh, invLow, invClose, c.volume, c.volume - (c.takerBuyVolume ?? 500));
        });
        const bearRead = detectDivergences(bearCandles, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        assert.ok(
            bearRead.divergences.some(d => d.kind === 'regular_bearish'),
            `Expected regular_bearish divergence, got: ${JSON.stringify(bearRead.divergences.map(d => `${d.indicator}:${d.kind}`))}`,
        );

        // Hidden bullish & hidden bearish fixtures:
        // Hidden bullish: price makes HIGHER LOW while oscillator makes LOWER LOW
        const hiddenBullCandles: Kline[] = [];
        for (let i = 0; i < 65; i += 1) {
            let close = 100;
            let low = 99.5;
            let high = 100.5;
            let buy = 550;
            if (i >= 20 && i <= 28) {
                // Deep first drop to 90 (pivot A at i=28)
                close = 100 - (i - 20) * 1.2;
                low = i === 28 ? 89.5 : close - 0.3;
                high = close + 0.3;
                buy = 450;
            } else if (i > 28 && i <= 40) {
                // Big rally to 118
                close = 90.4 + (i - 28) * 2.3;
                low = close - 0.3;
                high = close + 0.4;
                buy = 800;
            } else if (i > 40 && i <= 50) {
                // Pullback to HIGHER low at 95 (i=50), with very sharp negative RSI/MACD/CVD momentum!
                close = 118 - (i - 40) * 2.25;
                low = i === 50 ? 94.8 : close - 0.2; // higher low (> 89.5)
                high = close + 0.2;
                buy = 50; // heavy selling -> lower CVD & sharp RSI drop
            } else if (i > 50) {
                close = 96 + (i - 50) * 1.1;
                low = close - 0.2;
                high = close + 0.3;
                buy = 700;
            }
            hiddenBullCandles.push(makeKline(i, close, high, low, close, 1000, buy));
        }
        const hidBullRead = detectDivergences(hiddenBullCandles, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        assert.ok(
            hidBullRead.divergences.some(d => d.kind === 'hidden_bullish'),
            `Expected hidden_bullish divergence, got: ${JSON.stringify(hidBullRead.divergences.map(d => `${d.indicator}:${d.kind}`))}`,
        );

        const hiddenBearCandles = hiddenBullCandles.map((c, i) => {
            const invClose = 220 - c.close;
            const invHigh = 220 - c.low;
            const invLow = 220 - c.high;
            return makeKline(i, invClose, invHigh, invLow, invClose, c.volume, c.volume - (c.takerBuyVolume ?? 500));
        });
        const hidBearRead = detectDivergences(hiddenBearCandles, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        assert.ok(
            hidBearRead.divergences.some(d => d.kind === 'hidden_bearish'),
            `Expected hidden_bearish divergence, got: ${JSON.stringify(hidBearRead.divergences.map(d => `${d.indicator}:${d.kind}`))}`,
        );

        // Coordinate & drawToolLevels parity
        assert.equal(DRAWABLE_TOOLS.includes('divergences'), true);
        const drawable = drawableLevelsFor('divergences', { values: bullRead });
        assert.ok(drawable && drawable.trends && drawable.trends.length > 0);
        assert.equal(drawable.trends[0].t0, bullRead.divergences[0].pivotA.time);
        assert.equal(drawable.trends[0].p0, bullRead.divergences[0].pivotA.price);
        assert.equal(drawable.trends[0].t1, bullRead.divergences[0].pivotB.time);
        assert.equal(drawable.trends[0].p1, bullRead.divergences[0].pivotB.price);
    });

    it('4. scopedRules triggers deterministically and preserves KV-cache static prefix purity', () => {
        // Normal / null inputs -> empty string (zero overhead)
        const normal = evaluateScopedRules({ regime: 'trend', fundingRate: 0.0001, dailyDrawdownPct: 0.2, killSwitchActive: false });
        assert.equal(normal.activeRules.length, 0);
        assert.equal(normal.promptTailBlock, '');

        const missing = evaluateScopedRules({ regime: null, fundingRate: undefined, dailyDrawdownPct: NaN });
        assert.equal(missing.activeRules.length, 0);
        assert.equal(missing.promptTailBlock, '');

        // Chop + extreme positive funding + drawdown cooldown
        const tripped = evaluateScopedRules({
            regime: 'range',
            fundingRate: 0.0008,
            dailyDrawdownPct: 2.1,
            killSwitchActive: false,
            maxDailyDrawdownPct: 3.0,
        });
        assert.deepEqual(tripped.activeRules.map(r => r.id), ['chop_discipline', 'extreme_funding', 'drawdown_cooldown']);
        assert.ok(tripped.promptTailBlock.includes('expected_hold_hours'));
        assert.ok(tripped.promptTailBlock.includes('0.90% headroom'));

        // Negative extreme funding + kill-switch
        const kill = evaluateScopedRules({
            regime: 'trend',
            fundingRate: -0.0006,
            dailyDrawdownPct: 3.2,
            killSwitchActive: true,
        });
        assert.deepEqual(kill.activeRules.map(r => r.id), ['extreme_funding', 'drawdown_cooldown']);
        assert.ok(kill.promptTailBlock.includes('Shorts crowded'));
        assert.ok(kill.promptTailBlock.includes('HALTED'));

        // KV-cache prefix purity: static prefix before dynamic tail must stay byte-identical
        clearChatSurfacePromptCache();
        const cleanPrompt = surfacePromptWith('MANDATE', 'what the trader asks', {
            sessionKey: 'kv-test-1',
            memoryEnabled: false,
            dynamicTailBlocks: [],
        }).text;
        const overlayPrompt = surfacePromptWith('MANDATE', 'what the trader asks', {
            sessionKey: 'kv-test-1',
            memoryEnabled: false,
            dynamicTailBlocks: [PLAN_MODE_MANDATE, tripped.promptTailBlock],
        }).text;
        assert.equal(overlayPrompt.startsWith(cleanPrompt), true, 'Dynamic overlays must append ONLY at the prompt tail');
        assert.equal(contentVersion(overlayPrompt.slice(0, cleanPrompt.length)), contentVersion(cleanPrompt));
    });

    it('5. /context, /doctor, and slash parser work safely without Electron or live feed', async () => {
        assert.deepEqual(
            SLASH_COMMAND_SUGGESTIONS.map(s => s.command).slice(0, 4),
            ['plan', 'context', 'doctor', 'dream'],
        );
        assert.equal(slashTemplateOf('/plan   '), 'plan');
        assert.equal(slashTemplateOf('/context  extra '), 'context');
        assert.equal(slashTemplateOf('/doctor   '), 'doctor');
        assert.equal(parsePlanSlashArgs('  ').action, 'toggle');
        assert.equal(parsePlanSlashArgs(' ON ').action, 'on');
        assert.equal(parsePlanSlashArgs('off').action, 'off');
        assert.equal(parsePlanSlashArgs('bogus').action, 'invalid');

        const ctxSnap = buildContextDiagnostic({
            systemPromptText: 'System mandate',
            curatedMemoryText: 'User profile',
            loadedSkillsTexts: ['Skill body'],
            historyTexts: ['User question', 'Assistant reply'],
            toolResultsTexts: ['{"ok":true}'],
            provider: null,
        });
        assert.equal(ctxSnap.kind, 'context');
        assert.equal(ctxSnap.breakdown.length, 5);
        assert.ok(ctxSnap.totalTokens > 0);
        assert.equal(ctxSnap.autoCompactTriggerTokens, Math.floor(ctxSnap.windowTokens * 0.9));
        assert.equal(ctxSnap.tokensUntilAutoCompact, Math.max(0, ctxSnap.autoCompactTriggerTokens - ctxSnap.totalTokens));

        // Ensure electronAPI is absent and markPrice is 0 — must not throw
        const win = g.window as Record<string, unknown>;
        const prevElectron = win.electronAPI;
        delete win.electronAPI;
        try {
            const docSnap = await collectDoctorDiagnostic({
                provider: null,
                effort: 'auto',
                symbol: 'BTCUSDT',
                interval: '15m',
                sessionId: 'diag-s1',
                planMode: true,
                markPrice: 0,
            });
            assert.equal(docSnap.kind, 'doctor');
            assert.equal(docSnap.checks.length, 6);
            assert.equal(docSnap.checks[0].status, 'FAIL'); // no provider
            assert.equal(docSnap.checks[5].status, 'PASS'); // browser mode clean
            assert.ok(docSnap.checks[2].summary.includes('Plan Mode=ON'));
        } finally {
            if (prevElectron !== undefined) win.electronAPI = prevElectron;
        }

        const directDoc = buildDoctorDiagnostic({
            providerName: 'OpenAI',
            modelId: 'gpt-4o',
            effort: 'high',
            toolsEnabled: true,
            reasoningCapable: true,
            visionCapable: true,
            windowTokens: 128_000,
            windowSource: 'user',
            symbol: 'BTCUSDT',
            interval: '15m',
            markPrice: 90_000,
            markAgeMs: 1_000,
            wsConnected: true,
            sessionId: 's1',
            modelDrawingCount: 2,
            hiddenLowerTfCount: 0,
            planMode: false,
            paperEnabled: true,
            paperEquityUsd: 10_000,
            paperDailyDrawdownPct: 0,
            paperKillSwitchPct: 3,
            paperKillSwitchActive: false,
            paperOpenPositions: 0,
            paperMaxPositions: 3,
            paperCorruptionReason: null,
            userMdBytes: 100,
            userMdCapBytes: 1500,
            memoryMdBytes: 200,
            memoryMdCapBytes: 2500,
            rejectedStoreHealthy: true,
            liveSkillCount: 3,
            activeScopedRuleIds: [],
            appVersion: '1.6.3',
            isElectron: false,
            updateStatus: 'idle',
        });
        assert.equal(directDoc.overall, 'PASS');
        assert.equal(directDoc.checks.length, 6);
    });

    it('6. TOOL_REGISTRY parity: setup_replay and divergences are catalogue-loadable on Desk & Chat, never turn-1 initial', () => {
        for (const name of ['setup_replay', 'divergences']) {
            assert.equal(DESK_TOOL_NAMES.includes(name), true, `${name} must have deskGrant: true`);
            assert.equal(CHAT_SURFACE_TOOLS.includes(name), true, `${name} must be granted to Chat`);
            assert.equal(INITIAL_DESK_TOOL_NAMES.includes(name), false, `${name} must NOT be in INITIAL_DESK_TOOL_NAMES`);
            assert.equal(DESK_TOOL_DEFINITIONS.some(d => d.function.name === name), true, `${name} must have schema in DESK_TOOL_DEFINITIONS`);
            assert.equal(loadableDeskToolNamesFor(true, DESK_TOOL_NAMES).includes(name), true, `${name} loadable on Desk`);
            assert.equal(loadableDeskToolNamesFor(true, CHAT_SURFACE_TOOLS).includes(name), true, `${name} loadable on Chat`);
        }
    });

    it('7. Wave 2 audit fixes: Chat conv-123 Plan Mode key fallback, MTM drawdown, sweep_structure_shift, and /context dedup', async () => {
        // 7a. P0 Plan Mode Chat key sync: toggle on active dock session, invoke runChatSurfaceTurn with distinct req.sessionId='conv-123'
        chatStore.__resetForTests();
        chatStore.setPlanMode(true); // active dock session ON; 'conv-123' not separately toggled
        let capturedWireTools: string[] = [];
        let capturedSystem = '';
        const srv = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk; });
            req.on('end', () => {
                const parsed = JSON.parse(body || '{}') as {
                    messages?: Array<{ role: string; content: unknown }>;
                    tools?: Array<{ function?: { name?: string } }>;
                };
                capturedWireTools = Array.isArray(parsed.tools)
                    ? parsed.tools.map(t => String(t?.function?.name ?? ''))
                    : [];
                const sysMsgs = (parsed.messages ?? []).filter(m => m.role === 'system');
                capturedSystem = sysMsgs.map(m => String(m.content ?? '')).join('\n');
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                res.write(`data: ${JSON.stringify({ id: 'chat-p0', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Plan checked.' }, finish_reason: 'stop' }] })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });
        });
        await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()));
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        try {
            await runChatSurfaceTurn({
                sessionId: 'conv-123',
                config: {
                    id: 'mock-surf',
                    name: 'Mock',
                    apiKey: 'test',
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    selectedModel: 'gpt-4o',
                    models: ['gpt-4o'],
                    isBuiltIn: false,
                    isEnabled: true,
                    apiFormat: 'chat_completions',
                },
                history: [],
                prompt: 'Plan BTC setup',
                effort: 'low',
                signal: new AbortController().signal,
                startedAt: Date.now(),
                trades: [],
                memoryEnabled: false,
                strategiesEnabled: false,
                patch: () => {},
                paint: () => {},
            });
        } finally {
            await new Promise<void>(resolve => srv.close(() => resolve()));
        }
        assert.equal(capturedWireTools.includes('paper_order'), false, 'paper_order locked on Chat conv-123 via active dock Plan Mode');
        assert.equal(capturedWireTools.includes('remember'), false, 'remember locked on Chat conv-123');
        assert.equal(capturedWireTools.includes('trade_math'), true, 'trade_math remains available');
        assert.ok(
            capturedSystem.includes('[PLAN MODE'),
            `Expected PLAN_MODE_MANDATE in system prompt (len=${capturedSystem.length}): ${capturedSystem.slice(-500)}`,
        );
        chatStore.setPlanMode(false);

        // 7b. P1 Mark-to-Market unrealized drawdown (-2% unrealized loss) trips drawdown_cooldown & surfaces in /doctor
        resetPaperFrameCache();
        const activeLs = g.localStorage as Storage;
        const prevMtmUser = activeLs.getItem('last_active_user');
        activeLs.setItem('last_active_user', 'wave2-probe');
        const acct = createPaperAccount({
            startingBalanceUsd: 10_000,
            enabled: true,
            dailyDrawdownKillSwitchPct: 3.0,
        });
        acct.dayStartEquityUsd = 10_000;
        acct.cashBalanceUsd = 10_000;
        const openedMs = Date.now() - 60_000;
        acct.positions = [{
            id: 'pos-mtm-1',
            symbol: 'SOLUSDT',
            side: 'long',
            qty: 10,
            entryPrice: 100,
            stopLoss: 75,
            takeProfits: [150],
            leverage: 1,
            marginUsd: 1_000,
            riskUsd: 250,
            entryFeeUsd: 0,
            liquidationPrice: 1,
            openedAt: openedMs,
            lastFundingSlotMs: openedMs,
            fundingPaidUsd: 0,
            closedQty: 0,
        }];
        await setPreference('paper_account_v1_wave2-probe', JSON.stringify(acct));
        await getPaperAccount('wave2-probe');
        // Re-assert user + mark synchronously right before sync scopedRules read (`test-isolation=none --test-concurrency=4`)
        activeLs.setItem('last_active_user', 'wave2-probe');
        publishPaperMark('SOLUSDT', 80, 0.0001); // uPnL = -$200 -> equity = 9,800 (-2.00% dd)
        const scopedMtm = collectScopedRulesForSymbol('SOLUSDT');
        assert.ok(
            scopedMtm.activeRules.some(r => r.id === 'drawdown_cooldown'),
            `Expected MTM -2% drawdown to trip drawdown_cooldown, got: ${JSON.stringify(scopedMtm.activeRules)}`,
        );
        activeLs.setItem('last_active_user', 'wave2-probe');
        const docMtm = await collectDoctorDiagnostic({
            provider: {
                id: 'p1',
                name: 'OpenAI',
                apiKey: 'k',
                baseUrl: 'https://api.openai.com/v1',
                selectedModel: 'gpt-4o',
                models: ['gpt-4o'],
                isBuiltIn: false,
                isEnabled: true,
                apiFormat: 'chat_completions',
            },
            effort: 'high',
            symbol: 'SOLUSDT',
            interval: '15m',
            sessionId: 'mtm-s1',
            planMode: false,
            markPrice: 80,
        });
        const paperCheck = docMtm.checks.find(c => c.id === 'paper_risk');
        assert.equal(paperCheck?.status, 'WARN', 'MTM -2% drawdown surfaces WARN on paper_risk in /doctor');
        assert.ok(paperCheck?.summary.includes('daily drawdown=2.00%'), `Expected daily drawdown=2.00% in summary, got: ${paperCheck?.summary}`);
        if (prevMtmUser === null) activeLs.removeItem('last_active_user');
        else activeLs.setItem('last_active_user', prevMtmUser);
        resetPaperFrameCache();

        // 7c. P1 sweep_structure_shift replay exercise (without fabricating equal level on lastBar clone)
        const sssCandles: Kline[] = [];
        for (let i = 0; i < 95; i += 1) {
            let open = 100;
            let high = 101;
            let low = 99;
            let close = 100;
            if (i < 50) {
                // Monotonically ascending gentle oscillation so no prior equal pools trigger before bar 76
                const wave = 90 + i * 0.22 + (i % 2 === 0 ? 0.35 : -0.35);
                open = wave;
                close = wave;
                high = close + 0.5;
                low = close - 0.5;
            } else if (i === 52 || i === 64) {
                // Two distinct swing highs at 105.0 (equal_highs pool) prior to sweep bar 76
                open = 103.5; high = 105.0; low = 102.5; close = 104.0;
            } else if (i === 51 || i === 53 || i === 63 || i === 65) {
                open = 101.5; high = 102.5; low = 100.5; close = 102.0;
            } else if (i === 58 || i === 70) {
                // Confirmed swing lows at 98.0 / 98.2 flanked by higher bars -> readStructure sees swings >= 4
                open = 99.5; high = 100.0; low = 98.0; close = 98.8;
            } else if (i === 57 || i === 59 || i === 69 || i === 71) {
                open = 100.5; high = 101.2; low = 99.6; close = 100.5;
            } else if (i === 75) {
                open = 104.0; high = 104.5; low = 99.2; close = 104.5;
            } else if (i === 76) {
                // Sweep above 105.0 equal highs and slam-close below 98.0 swing low -> bearish BOS + confirmed sweep
                open = 104.8; high = 107.0; low = 96.2; close = 96.5;
            } else if (i > 76 && i <= 86) {
                const step = i - 76;
                open = 96.5 - (step - 1) * 0.9;
                close = open - 0.9;
                high = open + 0.2;
                low = close - 0.2;
            }
            sssCandles.push(makeKline(i, open, high, low, close));
        }
        const sssRes = runSetupReplay(sssCandles, {
            symbol: 'BTCUSDT',
            interval: '1h',
            setup: 'sweep_structure_shift',
            direction: 'Short',
            lookbackBars: 95,
        });
        assert.equal(sssRes.ok, true);
        if (sssRes.ok) {
            assert.equal(sssRes.setup, 'sweep_structure_shift');
            assert.ok(sssRes.sampleCount >= 1, `Expected sweep_structure_shift to detect seeded setup, got sampleCount=${sssRes.sampleCount}`);
            assert.ok(sssRes.recentOccurrences.some(o => o.direction === 'Short'), 'Expected bearish sweep_structure_shift occurrence');
        }

        // 7d. P2 /context deduplicates curated memory tokens already embedded in systemPromptText
        const curatedBlock = '## USER PROFILE & DURABLE MEMORY\nTrader only risks 0.5% per trade on BTCUSDT.';
        const baseSys = 'CORE MANDATE INSTRUCTIONS';
        const combinedSys = `${baseSys}\n\n${curatedBlock}`;
        const snapWithoutEmbed = buildContextDiagnostic({
            systemPromptText: baseSys,
            curatedMemoryText: curatedBlock,
            loadedSkillsTexts: [],
            historyTexts: [],
            toolResultsTexts: [],
        });
        const snapWithEmbed = buildContextDiagnostic({
            systemPromptText: combinedSys,
            curatedMemoryText: curatedBlock,
            embeddedCuratedText: curatedBlock,
            loadedSkillsTexts: [],
            historyTexts: [],
            toolResultsTexts: [],
        });
        assert.equal(
            snapWithEmbed.totalTokens,
            snapWithoutEmbed.totalTokens,
            'Embedded curated memory inside systemPromptText must NOT be double-counted in /context totalTokens',
        );
    });
});
