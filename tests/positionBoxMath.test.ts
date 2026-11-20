import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    computePositionBoxMetrics,
    seedPositionBoxPoints,
    updatePositionBoxHandle,
} from '../src/services/trade/positionBoxMath';
import { fmtRiskReward, plannedRiskRewardSigned } from '../src/utils/riskReward';
import {
    evaluateDrawingAtNow,
    formatTier0ChartManifest,
    type EvalCandle,
} from '../src/services/trade/chartGeometry';
import type { ChartDrawing } from '../src/services/trade/chartDrawings';

const makeCandles = (count = 15, startSec = 1_700_000_000, stepSec = 900): EvalCandle[] =>
    Array.from({ length: count }, (_, i) => ({
        time: startSec + i * stepSec,
        open: 60_000 + i * 50,
        high: 60_200 + i * 50,
        low: 59_800 + i * 50,
        close: 60_100 + i * 50,
    }));

describe('Phase 2: Long & Short Position Box Math & Geometry Integration', () => {
    it('computes Long and Short R:R identically to canonical plannedRiskRewardSigned & fmtRiskReward', () => {
        const longPts = [
            { t: 1000, p: 60_000 }, // Entry
            { t: 2000, p: 59_000 }, // SL (-1000)
            { t: 2000, p: 62_500 }, // TP (+2500 -> 2.5R)
        ];
        const longMetrics = computePositionBoxMetrics('long_position', longPts);
        const canonicalLong = plannedRiskRewardSigned({
            entry: 60_000,
            stopLoss: 59_000,
            takeProfits: [62_500],
            direction: 'Long',
        });
        assert.ok(longMetrics);
        assert.equal(longMetrics.inverted, false);
        assert.equal(longMetrics.ratio, canonicalLong.ratio);
        assert.equal(longMetrics.formattedRR, fmtRiskReward(canonicalLong.ratio, 2));

        const shortPts = [
            { t: 1000, p: 60_000 }, // Entry
            { t: 2000, p: 61_000 }, // SL (+1000)
            { t: 2000, p: 57_000 }, // TP (-3000 -> 3.0R)
        ];
        const shortMetrics = computePositionBoxMetrics('short_position', shortPts);
        const canonicalShort = plannedRiskRewardSigned({
            entry: 60_000,
            stopLoss: 61_000,
            takeProfits: [57_000],
            direction: 'Short',
        });
        assert.ok(shortMetrics);
        assert.equal(shortMetrics.inverted, false);
        assert.equal(shortMetrics.ratio, canonicalShort.ratio);
        assert.equal(shortMetrics.formattedRR, fmtRiskReward(canonicalShort.ratio, 2));
    });

    it('flags inverted position boxes with INV formatting and synchronizes right edges on SL/TP handle drags', () => {
        const invertedLong = computePositionBoxMetrics('long_position', [
            { t: 1000, p: 60_000 },
            { t: 2000, p: 61_000 }, // SL above entry -> inverted
            { t: 2000, p: 62_000 },
        ]);
        assert.ok(invertedLong);
        assert.equal(invertedLong.inverted, true);
        assert.equal(invertedLong.formattedRR, 'INV');

        const seeded = seedPositionBoxPoints('long_position', { t: 1000, p: 60_000 }, 3000, 1000, 2);
        assert.equal(seeded[1].p, 59_000);
        assert.equal(seeded[2].p, 62_000);

        // Dragging SL handle right edge to t=4500 synchronizes TP right edge to t=4500 too
        const draggedSl = updatePositionBoxHandle(seeded, 1, { t: 4500, p: 59_200 });
        assert.equal(draggedSl[1].t, 4500);
        assert.equal(draggedSl[2].t, 4500);
        assert.equal(draggedSl[1].p, 59_200);
        assert.equal(draggedSl[2].p, 62_000);

        // Dragging TP handle right edge to t=5200 synchronizes SL right edge to t=5200 too
        const draggedTp = updatePositionBoxHandle(draggedSl, 2, { t: 5200, p: 63_200 });
        assert.equal(draggedTp[1].t, 5200);
        assert.equal(draggedTp[2].t, 5200);
        assert.equal(draggedTp[2].p, 63_200);
    });

    it('surfaces positionMetrics inside evaluateDrawingAtNow and Tier 0 chart manifest', () => {
        const candles = makeCandles(15);
        const drawing: ChartDrawing = {
            id: 'pos-1',
            shortId: '#D4',
            kind: 'long_position',
            origin: 'user',
            color: '#10b981',
            createdOnTf: '15m',
            createdAt: candles[10].time * 1000,
            label: 'Breakout Long',
            points: [
                { t: candles[10].time, p: 60_500 },
                { t: candles[14].time + 3600, p: 60_000 },
                { t: candles[14].time + 3600, p: 61_750 },
            ],
        };

        const ev = evaluateDrawingAtNow(drawing, {
            symbol: 'BTCUSDT',
            activeTf: '15m',
            candles,
            markPrice: 60_800,
            priceScaleMode: 'normal',
            atr14: 250,
        });
        assert.ok(ev.positionMetrics);
        assert.equal(ev.positionMetrics.direction, 'Long');
        assert.equal(ev.positionMetrics.ratio, 2.5);
        assert.equal(ev.positionMetrics.formattedRR, fmtRiskReward(2.5, 2));

        const manifest = formatTier0ChartManifest({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'normal',
            revision: 'rev-1',
            capturedAtMs: Date.now(),
            liveMark: 60_800,
            formingCandle: candles[14],
            lastClosedBar: candles[13],
            atr14: 250,
            activeStudies: {},
            evaluatedDrawings: [ev],
        });
        assert.match(manifest, /#D4/);
        assert.match(manifest, /2\.50:1/);
    });
});
