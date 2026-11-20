import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ChartDrawing } from '../src/services/trade/chartDrawings';
import type { EvalCandle } from '../src/services/trade/chartGeometry';
import {
    computeAtrTolerance,
    computeRearmDistance,
    createWatchdogLatch,
    evaluateDrawingWatch,
    isCooldownElapsed,
    shouldRearmEntryWithHysteresis,
} from '../src/services/trade/watchdogCore';
import {
    __resetSentinelForTests,
    buildSentinelPromptPacket,
    drainSentinelNoticesWhenIdle,
    evaluateSentinelEvent,
    getPendingSentinelNotices,
    parseSentinelDecision,
} from '../src/services/trade/sentinelLoop';
import { runPresentTrade } from '../src/services/trade/presentTradeTool';
import { computeTradeMath } from '../src/services/market/tradeMathCore';
import { runAllTimeframes } from '../src/services/analysis/DeskToolsService';
import type { Kline } from '../src/types';

const makeCandles = (count: number, startSec = 1_700_000_000, stepSec = 900, basePrice = 100): EvalCandle[] =>
    Array.from({ length: count }, (_, i) => {
        const p = basePrice + i * 0.5;
        return {
            time: startSec + i * stepSec,
            open: p - 0.2,
            high: p + 1.0,
            low: p - 1.0,
            close: p,
        };
    });

const makeKlines = (count: number, stepMs = 15 * 60_000, startPrice = 50_000): Kline[] => {
    const start = 1_700_000_000_000;
    return Array.from({ length: count }, (_, i) => {
        const open = startPrice + i * 25;
        const close = open + 15;
        return {
            time: start + i * stepMs,
            open,
            high: close + 40,
            low: open - 30,
            close,
            volume: 1200 + i * 10,
        };
    });
};

describe('Phase 3: WatchdogCore ATR tolerance, hysteresis & drawing triggers', () => {
    it('computes ATR-scaled tolerance with tick-size floor and 0.5*ATR re-arm hysteresis', () => {
        assert.equal(computeAtrTolerance(200, 0.1), 30); // 0.15 * 200
        assert.equal(computeAtrTolerance(2, 0.5), 0.5);  // tick floor wins over 0.3
        assert.equal(computeRearmDistance(200, 0.1), 100); // 0.5 * 200
        assert.equal(computeRearmDistance(1, 0.5), 1.5);   // tick * 3 wins over 0.5

        assert.equal(shouldRearmEntryWithHysteresis(100, 104, 'Long', 10), false);
        assert.equal(shouldRearmEntryWithHysteresis(100, 105, 'Long', 10), true);
        assert.equal(shouldRearmEntryWithHysteresis(100, 96, 'Short', 10), false);
        assert.equal(shouldRearmEntryWithHysteresis(100, 95, 'Short', 10), true);
    });

    it('detects diagonal trendline crossing and enforces 0.5*ATR hysteresis + bar cooldown anti-storm', () => {
        const candles = makeCandles(20, 1_700_000_000, 900, 100);
        // Horizontal-ish rising trendline from bar 0 (100) to bar 10 (110) -> at bar 19, projectedPrice = 119
        const drawing: ChartDrawing = {
            id: 'd-trend-1',
            shortId: '#D1',
            kind: 'trend',
            origin: 'user',
            color: '#a1a1aa',
            createdOnTf: '15m',
            createdAt: candles[0].time * 1000,
            label: 'Trendline Support',
            points: [
                { t: candles[0].time, p: 100 },
                { t: candles[10].time, p: 110 },
            ],
        };

        let latch = createWatchdogLatch();
        // Start below projected 119
        const r0 = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 112,
            atr14: 10,
            cooldownBars: 2,
            state: latch,
        });
        assert.equal(r0.event, null);
        latch = r0.nextState;

        // Cross into ATR tolerance band (tol = 1.5 around 119)
        const r1 = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 118.2,
            atr14: 10,
            cooldownBars: 2,
            state: latch,
        });
        assert.ok(r1.event);
        assert.equal(r1.event.kind, 'price_cross_drawing');
        assert.equal(r1.event.shortId, '#D1');
        assert.equal(r1.event.crossedDirection, 'up');
        latch = r1.nextState;
        assert.equal(latch.latched, true);

        // Chop around level (< 0.5 * ATR = 5 away) must NOT re-fire
        const rChop1 = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 116, // 3 away (< 5)
            atr14: 10,
            cooldownBars: 2,
            currentBarTime: candles[19].time + 900,
            state: latch,
        });
        assert.equal(rChop1.event, null);
        assert.equal(rChop1.nextState.latched, true);
        latch = rChop1.nextState;

        // Pull away >= 0.5 * ATR (119 - 113 = 6 >= 5) clears latch
        const rPullAway = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 113,
            atr14: 10,
            cooldownBars: 2,
            currentBarTime: candles[19].time + 900,
            state: latch,
        });
        assert.equal(rPullAway.event, null);
        assert.equal(rPullAway.nextState.latched, false);
        latch = rPullAway.nextState;

        // Still inside 2-bar cooldown (+1 bar): must NOT fire yet
        assert.equal(isCooldownElapsed(latch.lastFiredBarTime, candles[19].time + 900, 2, 900), false);
        const rTooSoon = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 119.2,
            isCandleClose: true,
            atr14: 10,
            cooldownBars: 2,
            currentBarTime: candles[19].time + 900,
            state: latch,
        });
        assert.equal(rTooSoon.event, null);

        // After pulling away again and waiting >= 2 bars: fires candle_close_drawing
        const rRearm2 = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 112,
            atr14: 10,
            cooldownBars: 2,
            currentBarTime: candles[19].time + 2 * 900,
            state: rTooSoon.nextState,
        });
        const rClose = evaluateDrawingWatch({
            symbol: 'BTCUSDT',
            drawing,
            activeTf: '15m',
            barSeconds: 900,
            priceScaleMode: 'normal',
            candles,
            livePrice: 119.1,
            isCandleClose: true,
            atr14: 10,
            cooldownBars: 2,
            currentBarTime: candles[19].time + 3 * 900,
            state: rRearm2.nextState,
        });
        assert.ok(rClose.event);
        assert.equal(rClose.event.kind, 'candle_close_drawing');
    });
});

describe('Phase 3: Isolated Headless Sentinel & Idle-Safe Queue', () => {
    it('builds isolated prompt packets without chat transcript, parses strict actions, and drains only when idle', async () => {
        __resetSentinelForTests();
        const trigger = {
            source: 'drawing_watch' as const,
            symbol: 'ETHUSDT',
            sid: 'sess-1',
            event: {
                kind: 'candle_close_drawing' as const,
                symbol: 'ETHUSDT',
                drawingId: 'd2',
                shortId: '#D2',
                drawingKind: 'hline' as const,
                drawingLabel: 'Daily Resistance',
                tf: '15m',
                livePrice: 3201,
                targetPrice: 3200,
                tolerance: 4,
                distancePrice: 1,
                distanceAtr: 0.04,
                crossedDirection: 'up' as const,
                barTime: 1_700_010_000,
                triggeredAt: Date.now(),
            },
        };
        const minimalCtx = {
            traderProfileSlice: 'Risk max 1% per trade; no counter-trend chases.',
            matchedSkillExcerpt: 'Breakout Retest Skill: wait for 15m close acceptance.',
            chartManifestSummary: 'ETHUSDT 15m mark=3201 ATR=25',
            atr14: 25,
        };

        const packet = buildSentinelPromptPacket(trigger, minimalCtx);
        assert.equal(packet.isolated, true);
        assert.match(packet.userPayload, /TRADER PROFILE SLICE/);
        assert.match(packet.userPayload, /MATCHED SKILL/);
        assert.match(packet.userPayload, /#D2/);

        // Strict JSON parsing + fail-safe dismissal on bad output
        assert.equal(parseSentinelDecision('not json at all').action, 'SILENT_DISMISS');
        assert.equal(parseSentinelDecision('{"action":"BUY_NOW","summary":"nope"}').action, 'SILENT_DISMISS');
        const parsedPlan = parseSentinelDecision(JSON.stringify({
            action: 'UPDATE_PLAN_STATUS',
            summary: 'SL reached on ETHUSDT.',
            severity: 'critical',
            planId: 'plan-9',
            nextPlanStatus: 'invalidated',
        }));
        assert.equal(parsedPlan.action, 'UPDATE_PLAN_STATUS');
        assert.equal(parsedPlan.nextPlanStatus, 'invalidated');

        // SILENT_DISMISS queues nothing
        const silent = await evaluateSentinelEvent(trigger, minimalCtx, {
            runHeadlessModel: async () => JSON.stringify({ action: 'SILENT_DISMISS', summary: 'chop' }),
        });
        assert.equal(silent.notice, null);
        assert.equal(getPendingSentinelNotices().length, 0);

        // ALERT_TRADER queues into idle-safe buffer
        const alerted = await evaluateSentinelEvent(trigger, minimalCtx, {
            runHeadlessModel: async () => JSON.stringify({
                action: 'ALERT_TRADER',
                summary: 'ETHUSDT 15m closed above #D2 Daily Resistance @ 3200.',
                severity: 'warning',
                drawingShortId: '#D2',
            }),
        });
        assert.ok(alerted.notice);
        assert.equal(getPendingSentinelNotices('sess-1').length, 1);

        // While streaming (isIdle = false), notices are HELD and never injected mid-stream
        const delivered: string[] = [];
        const held = drainSentinelNoticesWhenIdle(false, text => delivered.push(text), 'sess-1');
        assert.equal(held.length, 0);
        assert.equal(delivered.length, 0);
        assert.equal(getPendingSentinelNotices('sess-1').length, 1);

        // Once idle (isIdle = true), queued notices drain cleanly
        const flushed = drainSentinelNoticesWhenIdle(true, text => delivered.push(text), 'sess-1');
        assert.equal(flushed.length, 1);
        assert.equal(delivered.length, 1);
        assert.match(delivered[0], /SENTINEL ALERT/);
        assert.equal(getPendingSentinelNotices('sess-1').length, 0);
    });
});

describe('Phase 3: Tool Audit Fixes (runAllTimeframes, present_trade sync gate, trade_math multi-TP)', () => {
    it('parallelizes runAllTimeframes with compact per-TF digests, checkedAt, and data_quality', async () => {
        const fetchedOrder: string[] = [];
        const raw = await runAllTimeframes('BTCUSDT', 51_500, {
            skipMicrostructure: true,
            fetchTf: async (_sym, tf) => {
                fetchedOrder.push(tf);
                return { candles: makeKlines(60), source: 'okx' };
            },
        });
        assert.equal(fetchedOrder.length, 5);
        assert.match(raw, /checkedAt \d{4}-\d{2}-\d{2}T/);
        assert.match(raw, /data_quality: available=5\/5/);
        assert.match(raw, /mode=compact_digest/);
        assert.match(raw, /## 15m/);
        assert.match(raw, /## 1d/);
    });

    it('synchronously refuses inverted plans in runPresentTrade before drawing or arming', () => {
        let drew = false;
        let armed = false;
        let presented = false;
        const result = runPresentTrade(
            {
                call: {
                    id: 'tc-1',
                    name: 'present_trade',
                    arguments: {
                        symbol: 'BTCUSDT',
                        direction: 'Long',
                        entry: 70_000,
                        stopLoss: 72_000, // inverted for a Long!
                        takeProfits: [68_000],
                        strategy: 'Breakout',
                    },
                },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 70_000,
                crossCanvas: false,
                watchable: true,
                canvasNote: '',
            },
            {
                setProposal: () => { presented = true; },
                addDrawings: () => { drew = true; },
                armPlan: () => { armed = true; },
            },
        );
        assert.equal(result.ok, false);
        assert.equal(drew, false);
        assert.equal(armed, false);
        assert.equal(presented, false);
        assert.match(result.content, /REFUSED|inverted|stop/i);
    });

    it('computes blended multi-TP gross & net R:R alongside canonical nearest-TP R:R in computeTradeMath', () => {
        const candles = makeKlines(40, 15 * 60_000, 100);
        const read = computeTradeMath(
            {
                direction: 'Long',
                entry: 100,
                stopLoss: 98, // risk = 2
                takeProfits: [104, 108], // TP1 = 2R, TP2 = 4R
                tpWeights: [0.5, 0.5],
                equityUsd: 10_000,
                riskPercent: 1,
                leverage: 5,
            },
            candles,
        );
        assert.ok(read);
        // Canonical nearest-TP R:R stays 2.0R
        assert.equal(read.gross.ratio, 2);
        // Blended 50/50 of 2R and 4R = 3.0R
        assert.ok(read.blendedMultiTp);
        assert.equal(read.blendedMultiTp.targetsCount, 2);
        assert.equal(read.blendedMultiTp.grossRatio, 3);
        assert.ok(read.blendedMultiTp.netRewardR !== null && read.blendedMultiTp.netRewardR < 3);
    });
});
