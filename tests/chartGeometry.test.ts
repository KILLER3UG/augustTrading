import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ChartDrawing } from '../src/services/trade/chartDrawings';
import {
    allocateDrawingShortId,
    ensureStableShortIds,
    __resetShortIdCountersForTests,
    isDrawingVisibleOnTf,
    computeAtr14,
    touchToleranceFor,
    timeToLogicalIndex,
    interpolateScalePrice,
    projectDiagonalPrice,
    evaluateDrawingAtNow,
    evaluateChartDrawings,
    computeChartRevision,
    formatTier0ChartManifest,
    type EvalCandle,
} from '../src/services/trade/chartGeometry';

const makeDrawing = (overrides: Partial<ChartDrawing> = {}): ChartDrawing => ({
    id: overrides.id ?? 'd-1',
    kind: overrides.kind ?? 'hline',
    points: overrides.points ?? [{ t: 1_700_000_000, p: 100 }],
    color: overrides.color ?? '#f4f4f5',
    createdAt: overrides.createdAt ?? 1_700_010_000_000,
    ...overrides,
});

const makeCandles = (
    count: number,
    startSec: number,
    stepSec: number,
    basePrice = 100,
    range = 2,
): EvalCandle[] => {
    const out: EvalCandle[] = [];
    for (let i = 0; i < count; i += 1) {
        const c = basePrice + (i % 4) * 0.25;
        out.push({
            time: startSec + i * stepSec,
            open: c - range * 0.2,
            high: c + range * 0.5,
            low: c - range * 0.5,
            close: c,
        });
    }
    return out;
};

describe('chartGeometry — stable monotonic shortIds', () => {
    beforeEach(() => {
        __resetShortIdCountersForTests();
    });

    it('never renumbers or reuses deleted IDs and isolates counters per symbol', () => {
        const d1 = makeDrawing({ id: 'a', shortId: allocateDrawingShortId('BTCUSDT') });
        const d2 = makeDrawing({ id: 'b', shortId: allocateDrawingShortId('BTCUSDT', [d1]) });
        const d3 = makeDrawing({ id: 'c', shortId: allocateDrawingShortId('BTCUSDT', [d1, d2]) });

        assert.equal(d1.shortId, '#D1');
        assert.equal(d2.shortId, '#D2');
        assert.equal(d3.shortId, '#D3');

        // Delete #D1 and #D3 — only #D2 remains.
        const remaining = ensureStableShortIds([d2], 'BTCUSDT');
        assert.equal(remaining[0].shortId, '#D2');

        // Next drawing created on BTCUSDT must get #D4, never #D1 or #D3.
        const nextId = allocateDrawingShortId('BTCUSDT', remaining);
        assert.equal(nextId, '#D4');

        // A different symbol starts independently at #D1.
        const ethFirst = allocateDrawingShortId('ETHUSDT');
        assert.equal(ethFirst, '#D1');
    });

    it('hydrates legacy drawings missing shortId without disturbing existing IDs', () => {
        const existing = [
            makeDrawing({ id: 'keep', shortId: '#D5' }),
            makeDrawing({ id: 'legacy-1' }),
            makeDrawing({ id: 'legacy-2' }),
        ];
        const hydrated = ensureStableShortIds(existing, 'SOLUSDT');
        assert.equal(hydrated[0].shortId, '#D5');
        assert.equal(hydrated[1].shortId, '#D6');
        assert.equal(hydrated[2].shortId, '#D7');
    });
});

describe('chartGeometry — scale-aware diagonal projection & pre-window HTF anchors', () => {
    it('projects in logical bar-index space even across timestamp gaps', () => {
        // 5 bars where bar 2 -> bar 3 has a 48h weekend gap instead of 1h.
        const base = 1_700_000_000;
        const candles: EvalCandle[] = [
            { time: base, open: 100, high: 101, low: 99, close: 100 },
            { time: base + 3600, open: 105, high: 106, low: 104, close: 105 },
            { time: base + 7200, open: 110, high: 111, low: 109, close: 110 },
            { time: base + 7200 + 48 * 3600, open: 115, high: 116, low: 114, close: 115 },
            { time: base + 7200 + 49 * 3600, open: 120, high: 121, low: 119, close: 120 },
        ];
        // Line from bar 0 (100) to bar 2 (110): +5 per logical bar.
        // At bar 4 (logical index 4), logical-index projection must yield 120,
        // NOT raw-timestamp extrapolation (~350).
        const proj = projectDiagonalPrice(
            { t: candles[0].time, p: 100 },
            { t: candles[2].time, p: 110 },
            4,
            candles,
            3600,
            'normal',
        );
        assert.ok(proj !== null);
        assert.ok(Math.abs(proj - 120) < 1e-6, `expected 120 in bar-index space, got ${proj}`);

        // Future bar projection (2 bars past last candle): logical index 6 -> 130.
        const futureIdx = timeToLogicalIndex(candles[4].time + 2 * 3600, candles, 3600);
        assert.equal(futureIdx, 6);
        const futureProj = projectDiagonalPrice(
            { t: candles[0].time, p: 100 },
            { t: candles[2].time, p: 110 },
            futureIdx!,
            candles,
            3600,
            'normal',
        );
        assert.ok(futureProj !== null && Math.abs(futureProj - 130) < 1e-6);
    });

    it('handles a 4H drawing evaluated on a 15m chart where anchor 1 predates the 200-bar window', () => {
        const barSec15m = 15 * 60; // 900s
        const windowStart = 1_700_000_000;
        const candles15m = makeCandles(200, windowStart, barSec15m, 65_000, 120);

        // Anchor 1 is 16 hours (64 x 15m bars) BEFORE evalCandles[0].time -> logical index -64.
        // Anchor 2 is at bar index 36 inside the 15m window -> delta = 100 bars.
        // Target is the current bar (index 199) -> u = (199 - (-64)) / (36 - (-64)) = 263 / 100 = 2.63.
        const anchor1 = { t: windowStart - 64 * barSec15m, p: 60_000 };
        const anchor2 = { t: candles15m[36].time, p: 62_000 };

        const idx1 = timeToLogicalIndex(anchor1.t, candles15m, barSec15m);
        const idx2 = timeToLogicalIndex(anchor2.t, candles15m, barSec15m);
        assert.equal(idx1, -64);
        assert.equal(idx2, 36);

        const expectedLinear = 60_000 + (62_000 - 60_000) * 2.63; // 65,260
        const projLinear = projectDiagonalPrice(anchor1, anchor2, 199, candles15m, barSec15m, 'normal');
        assert.ok(projLinear !== null);
        assert.ok(Math.abs(projLinear - expectedLinear) < 1e-6, `expected ${expectedLinear}, got ${projLinear}`);

        const expectedLog = Math.exp(Math.log(60_000) + (Math.log(62_000) - Math.log(60_000)) * 2.63);
        const projLog = projectDiagonalPrice(anchor1, anchor2, 199, candles15m, barSec15m, 'logarithmic');
        assert.ok(projLog !== null);
        assert.ok(Math.abs(projLog - expectedLog) < 1e-6, `expected ${expectedLog}, got ${projLog}`);
        assert.ok(projLog > projLinear, 'upward log trendline should curve above linear extrapolation');

        // End-to-end via evaluateChartDrawings: 4h drawing must remain visible & evaluated on 15m.
        const htfTrend = makeDrawing({
            id: 'htf-trend',
            shortId: '#D1',
            kind: 'trend',
            origin: 'user',
            createdOnTf: '4h',
            label: '4H rising support',
            points: [anchor1, anchor2],
        });
        const evaluated = evaluateChartDrawings([htfTrend], {
            symbol: 'BTCUSDT',
            activeTf: '15m',
            candles: candles15m,
            markPrice: 65_500,
            priceScaleMode: 'normal',
            nowMs: (candles15m[199].time + 60) * 1000,
        });
        assert.equal(evaluated.length, 1);
        assert.equal(evaluated[0].visibleOnActiveTf, true);
        assert.equal(evaluated[0].projectedPrice, 65_260);
        assert.equal(evaluated[0].sideRelativeToMark, 'below');
    });

    it('guards non-positive prices before Math.log in logarithmic mode without returning NaN', () => {
        const resZero = interpolateScalePrice(0, 100, 0.5, 'logarithmic');
        assert.equal(resZero, 50);

        const resNeg = interpolateScalePrice(-20, 80, 0.5, 'logarithmic');
        assert.equal(resNeg, 30);

        // Valid positive prices use geometric interpolation: sqrt(100 * 400) = 200 (vs 250 linear).
        const resLog = interpolateScalePrice(100, 400, 0.5, 'logarithmic');
        assert.ok(resLog !== null && Math.abs(resLog - 200) < 1e-9);
    });
});

describe('chartGeometry — HTF visibility, Fib levels, ATR touch tolerance & manifest', () => {
    it('applies HTF->LTF visibility and explicit visibleOnTfs overrides', () => {
        assert.equal(isDrawingVisibleOnTf({ createdOnTf: '4h' }, '15m'), true);
        assert.equal(isDrawingVisibleOnTf({ createdOnTf: '4h' }, '4h'), true);
        assert.equal(isDrawingVisibleOnTf({ createdOnTf: '5m' }, '4h'), false);
        assert.equal(isDrawingVisibleOnTf({ createdOnTf: '4h', visibleOnTfs: ['4h', '1d'] }, '15m'), false);
        assert.equal(isDrawingVisibleOnTf({ createdOnTf: '5m', visibleOnTfs: ['5m', '4h'] }, '4h'), true);
        assert.equal(isDrawingVisibleOnTf({}, '15m'), true);
    });

    it('computes concrete Fibonacci retracements in both linear and log scale modes', () => {
        const candles = makeCandles(20, 1_700_000_000, 900, 200, 5);
        const fib = makeDrawing({
            id: 'fib-1',
            shortId: '#D1',
            kind: 'fib',
            createdOnTf: '15m',
            points: [
                { t: candles[2].time, p: 100 },
                { t: candles[10].time, p: 400 },
            ],
        });

        const evLinear = evaluateDrawingAtNow(fib, {
            symbol: 'SOLUSDT',
            activeTf: '15m',
            candles,
            markPrice: 248,
            priceScaleMode: 'normal',
            nowMs: (candles[19].time + 60) * 1000,
        });
        const midLinear = evLinear.fibLevels?.find(f => f.ratio === 0.5);
        assert.equal(midLinear?.price, 250);
        assert.equal(evLinear.projectedPrice, 250);

        const evLog = evaluateDrawingAtNow(fib, {
            symbol: 'SOLUSDT',
            activeTf: '15m',
            candles,
            markPrice: 202,
            priceScaleMode: 'logarithmic',
            nowMs: (candles[19].time + 60) * 1000,
        });
        const midLog = evLog.fibLevels?.find(f => f.ratio === 0.5);
        assert.equal(midLog?.price, 200);
        assert.equal(evLog.projectedPrice, 200);
    });

    it('uses ATR-scaled touch tolerance with a strict tick-size floor', () => {
        assert.ok(Math.abs(touchToleranceFor(100, 50_000, 0.1) - 15) < 1e-9);
        // When 0.15 * ATR is smaller than tickSize, tickSize floor wins.
        assert.equal(touchToleranceFor(1, 100, 0.5), 0.5);

        const base = 1_700_000_000;
        // Uniform ATR = 10 -> tolerance = 1.5 around level 100 => [98.5, 101.5].
        const candles: EvalCandle[] = [
            { time: base, open: 105, high: 110, low: 100, close: 105 }, // touches 100 exactly
            { time: base + 900, open: 106, high: 111.4, low: 101.4, close: 106 }, // TR = 10, within 1.5 -> touch
            { time: base + 1800, open: 108, high: 113, low: 103.0, close: 108 }, // TR = 10, outside 1.5 -> miss
        ];
        const atr = computeAtr14(candles);
        assert.ok(atr !== null && Math.abs(atr - 10) < 1e-6);

        const hline = makeDrawing({
            id: 'h1',
            shortId: '#D1',
            kind: 'hline',
            createdOnTf: '15m',
            points: [{ t: candles[0].time, p: 100 }],
        });
        const ev = evaluateDrawingAtNow(hline, {
            symbol: 'ETHUSDT',
            activeTf: '15m',
            candles,
            markPrice: 108,
            priceScaleMode: 'normal',
            atr14: 10,
            tickSize: 0.1,
            nowMs: (candles[2].time + 60) * 1000,
        });
        assert.equal(ev.touchesCount, 2);
    });

    it('produces deterministic revision hashes and a high-signal Tier 0 manifest', () => {
        const candles = makeCandles(30, 1_700_000_000, 900, 68_000, 200);
        const userLine = makeDrawing({
            id: 'u1',
            shortId: '#D1',
            kind: 'hline',
            origin: 'user',
            createdOnTf: '1h',
            label: 'Weekly support',
            points: [{ t: candles[5].time, p: 67_500 }],
        });
        const aiLine = makeDrawing({
            id: 'a1',
            shortId: '#D2',
            kind: 'hline',
            origin: 'agent',
            createdOnTf: '15m',
            label: 'Entry',
            points: [{ t: candles[25].time, p: 68_100 }],
        });

        const revA = computeChartRevision({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'normal',
            lastClosedBarTime: candles[28].time,
            activeStudies: { 'EMA 20': 67_950, RSI: 54.2 },
            drawings: [userLine, aiLine],
        });
        const revB = computeChartRevision({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'normal',
            lastClosedBarTime: candles[28].time,
            activeStudies: { RSI: 54.2, 'EMA 20': 67_950 },
            drawings: [userLine, aiLine],
        });
        const revScaleChanged = computeChartRevision({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'logarithmic',
            lastClosedBarTime: candles[28].time,
            activeStudies: { 'EMA 20': 67_950, RSI: 54.2 },
            drawings: [userLine, aiLine],
        });
        assert.equal(revA, revB);
        assert.notEqual(revA, revScaleChanged);

        const evaluated = evaluateChartDrawings([userLine, aiLine], {
            symbol: 'BTCUSDT',
            activeTf: '15m',
            candles,
            markPrice: 68_050,
            priceScaleMode: 'normal',
            atr14: 200,
            nowMs: (candles[29].time + 30) * 1000,
        });

        const manifest = formatTier0ChartManifest({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'normal',
            revision: revA,
            capturedAtMs: candles[29].time * 1000,
            nowMs: (candles[29].time + 30) * 1000,
            liveMark: 68_050,
            formingCandle: candles[29],
            lastClosedBar: candles[28],
            atr14: 200,
            activeStudies: { 'EMA 20': 67_950, RSI: 54.2 },
            evaluatedDrawings: evaluated,
            plansDescription: 'Armed plan: Long breakout above 68500',
        });

        assert.match(manifest, new RegExp(revA));
        assert.match(manifest, /Live mark: 68050\.0/);
        assert.match(manifest, /ATR\(14\): 200\.0/);
        assert.match(manifest, /Last closed 15m bar/);
        assert.match(manifest, /Active studies: EMA 20 67950\.0 · RSI 54\.20/);
        assert.match(manifest, /User drawings \(1/);
        assert.match(manifest, /#D1 hline \[1h\] "Weekly support"/);
        assert.match(manifest, /AI drawings \(1\):/);
        assert.match(manifest, /#D2 hline \[15m\] "Entry"/);
        assert.match(manifest, /Armed plan: Long breakout above 68500/);
        assert.match(manifest, /get_chart_view\(if_revision:/);
    });
});
