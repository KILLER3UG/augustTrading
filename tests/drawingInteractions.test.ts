import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ChartDrawing, DrawPoint } from '../src/services/trade/chartDrawings';
import type { EvalCandle } from '../src/services/trade/chartGeometry';
import {
    hitTestDrawings,
    projectTimestampToX,
    screenXToTimestamp,
    snapToOhlcMagnet,
    type LogicalScaleAdapter,
} from '../src/components/trade/drawingHitTest';
import {
    bumpDrawingVersion,
    canRedoDrawing,
    canUndoDrawing,
    clearAgentDrawingsFromHistory,
    countAgentDrawings,
    createDrawingHistory,
    pushDrawingSnapshot,
    redoDrawingState,
    undoDrawingState,
} from '../src/services/trade/drawingCommandStack';

const makeCandles = (count = 20, startSec = 1_700_000_000, stepSec = 900): EvalCandle[] =>
    Array.from({ length: count }, (_, i) => ({
        time: startSec + i * stepSec,
        open: 100 + i,
        high: 105 + i,
        low: 95 + i,
        close: 102 + i,
    }));

const linearScale = (originX = 100, pxPerBar = 20): LogicalScaleAdapter => ({
    logicalToCoordinate: (logical: number) => originX + logical * pxPerBar,
    coordinateToLogical: (x: number) => (x - originX) / pxPerBar,
});

describe('Phase 2: Offscreen & Future Logical Projection, Hit-Testing, and Magnet Snap', () => {
    it('projects pre-window HTF anchors and future whitespace timestamps symmetrically via logical bar space', () => {
        const candles = makeCandles(20, 1_700_000_000, 900);
        const scale = linearScale(100, 20);

        // Pre-window anchor: 5 bars before candles[0] -> logical = -5 -> x = 0
        const preTime = candles[0].time - 5 * 900;
        const preX = projectTimestampToX(preTime, candles, 900, scale);
        assert.equal(preX, 0);
        assert.equal(screenXToTimestamp(preX!, candles, 900, scale), preTime);

        // Future whitespace bar: 10 bars past candles[19] -> logical = 29 -> x = 680
        const futureTime = candles[19].time + 10 * 900;
        const futureX = projectTimestampToX(futureTime, candles, 900, scale);
        assert.equal(futureX, 100 + 29 * 20);
        assert.equal(screenXToTimestamp(futureX!, candles, 900, scale), futureTime);
    });

    it('prioritizes selected drawing handles over overlapping top-layer bodies', () => {
        const backTrend: ChartDrawing = {
            id: 'trend-back',
            shortId: '#D1',
            kind: 'trend',
            origin: 'user',
            color: '#a1a1aa',
            createdAt: 1,
            points: [
                { t: 100, p: 200 },
                { t: 300, p: 200 },
            ],
        };
        const frontRect: ChartDrawing = {
            id: 'rect-front',
            shortId: '#D2',
            kind: 'rect',
            origin: 'user',
            color: '#a1a1aa',
            createdAt: 2,
            points: [
                { t: 80, p: 150 },
                { t: 320, p: 250 },
            ],
        };
        const project = (pt: DrawPoint) => ({ x: pt.t, y: pt.p });

        // With nothing selected, clicking (100, 200) hits the topmost overlapping rectangle body
        const bodyHit = hitTestDrawings(100, 200, [backTrend, frontRect], null, project, 800, 500);
        assert.ok(bodyHit);
        assert.equal(bodyHit.drawing.id, 'rect-front');
        assert.equal(bodyHit.target, 'body');

        // With backTrend selected, clicking (103, 202) (within 9px handle radius) grabs backTrend handle 0
        const handleHit = hitTestDrawings(103, 202, [backTrend, frontRect], 'trend-back', project, 800, 500);
        assert.ok(handleHit);
        assert.equal(handleHit.drawing.id, 'trend-back');
        assert.equal(handleHit.target, 'handle');
        assert.equal(handleHit.handleIndex, 0);
    });

    it('snaps to nearest candle OHLC within 12px and refuses clicks beyond 12px', () => {
        const candles = makeCandles(5, 1_700_000_000, 900);
        const scale = linearScale(100, 30);
        const priceToY = (price: number) => 400 - price * 2;
        const projectTime = (t: number) => projectTimestampToX(t, candles, 900, scale);

        // Bar 2 high is 107 -> cx = 160, cy = 186 (closer to y=185 than close cy=192)
        const near = snapToOhlcMagnet({ x: 165, y: 185 }, candles, projectTime, priceToY, 12);
        assert.equal(near.snapped, true);
        assert.equal(near.field, 'high');
        assert.equal(near.price, 107);
        assert.equal(near.time, candles[2].time);

        // Far click (30px away) must NOT snap
        const far = snapToOhlcMagnet({ x: 160, y: 150 }, candles, projectTime, priceToY, 12);
        assert.equal(far.snapped, false);
        assert.equal(far.x, 160);
        assert.equal(far.y, 150);
    });
});

describe('Phase 2: Immutable Drawing Command Stack (Undo/Redo & Clear AI Drawings)', () => {
    const mkDrawing = (id: string, origin: 'user' | 'agent'): ChartDrawing => ({
        id,
        shortId: `#D${id.slice(-1)}`,
        kind: 'hline',
        origin,
        color: '#a1a1aa',
        version: 1,
        createdAt: 1_700_000_000_000,
        points: [{ t: 1_700_000_000, p: 50_000 }],
    });

    it('supports bumpDrawingVersion, undo/redo transitions, and undoable Clear AI Drawings preserving user drawings', () => {
        const u1 = mkDrawing('u1', 'user');
        const a1 = mkDrawing('a1', 'agent');
        const a2 = mkDrawing('a2', 'agent');

        const bumped = bumpDrawingVersion(u1);
        assert.equal(bumped.version, 2);
        assert.equal(u1.version, 1);

        let history = createDrawingHistory({ userDrawings: [u1], modelDrawings: [a1] });
        assert.equal(canUndoDrawing(history), false);
        assert.equal(countAgentDrawings(history.present), 1);

        history = pushDrawingSnapshot(history, { userDrawings: [u1, a2], modelDrawings: [a1] });
        assert.equal(canUndoDrawing(history), true);
        assert.equal(countAgentDrawings(history.present), 2);

        // One-click Clear AI Drawings removes ONLY origin==='agent' across both layers
        const cleared = clearAgentDrawingsFromHistory(history);
        assert.equal(cleared.removedCount, 2);
        history = cleared.history;
        assert.equal(history.present.userDrawings.length, 1);
        assert.equal(history.present.userDrawings[0].id, 'u1');
        assert.equal(history.present.modelDrawings.length, 0);
        assert.equal(countAgentDrawings(history.present), 0);

        // Ctrl+Z restores the cleared AI drawings cleanly
        history = undoDrawingState(history);
        assert.equal(countAgentDrawings(history.present), 2);
        assert.equal(canRedoDrawing(history), true);

        // Ctrl+Y re-applies the clear
        history = redoDrawingState(history);
        assert.equal(countAgentDrawings(history.present), 0);
        assert.equal(history.present.userDrawings.length, 1);
    });
});
