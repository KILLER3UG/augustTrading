import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHorizontalLabelOffsets } from '../src/services/trade/chartGeometry';

/**
 * The horizontal pills an AI plan paints (`AI · SL 59,660`, `AI · Entry
 * 59,380`, `AI · TP1 57,557`) sit 14px tall on a left anchor. On a 4h chart
 * 280 dollars is ~18 screen px, so two of them stack into one unreadable blob
 * unless the renderer deconflicts them. This is that rule, minus the canvas.
 */

const LAYOUT = { pillHeight: 14, minGap: 3, minY: 2, maxY: 600 };
const STEP = LAYOUT.pillHeight + LAYOUT.minGap;

const separation = (ys: number[]): number[] => ys.slice(1).map((y, i) => y - ys[i]);

describe('chartGeometry.resolveHorizontalLabelOffsets', () => {
    it('leaves well-spaced labels exactly on their anchors', () => {
        const out = resolveHorizontalLabelOffsets([
            { id: 'sl', anchorY: 120 },
            { id: 'entry', anchorY: 300 },
            { id: 'tp1', anchorY: 470 },
        ], LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['sl', 'entry', 'tp1']);
        for (const p of out) {
            assert.equal(p.labelY, p.anchorY);
            assert.equal(p.offsetY, 0);
        }
    });

    it('separates the AI · SL / AI · Entry pair that overlaps on a 4h chart', () => {
        // 280 dollars apart at the reported scale lands inside one 14px pill.
        const out = resolveHorizontalLabelOffsets([
            { id: 'sl', anchorY: 300 },
            { id: 'entry', anchorY: 312 },
        ], LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['sl', 'entry']);
        // The top pill keeps its line; the lower one is pushed clear.
        assert.equal(out[0].labelY, 300);
        assert.ok(out[1].labelY - out[0].labelY >= STEP,
            `pills must clear each other: ${out[1].labelY - out[0].labelY} < ${STEP}`);
        assert.equal(out[1].offsetY, out[1].labelY - out[1].anchorY);
        assert.ok(out[1].offsetY > 0, 'the nudged pill must report a connector offset');
    });

    it('separates three tightly stacked labels, preserving top-to-bottom price order', () => {
        const anchors = [200, 205, 210];
        const out = resolveHorizontalLabelOffsets(
            anchors.map((y, i) => ({ id: `l${i}`, anchorY: y })), LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['l0', 'l1', 'l2']);
        for (const gap of separation(out.map(p => p.labelY))) {
            assert.ok(gap >= STEP, `gap ${gap} < ${STEP}`);
        }
    });

    it('separates all four plan pills (SL, Entry, TP1, TP2) stacked on one price', () => {
        const out = resolveHorizontalLabelOffsets([
            { id: 'sl', anchorY: 260 },
            { id: 'entry', anchorY: 261 },
            { id: 'tp1', anchorY: 262 },
            { id: 'tp2', anchorY: 263 },
        ], LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['sl', 'entry', 'tp1', 'tp2']);
        const ys = out.map(p => p.labelY);
        for (const gap of separation(ys)) assert.ok(gap >= STEP, `gap ${gap} < ${STEP}`);
        assert.ok(ys[0] >= LAYOUT.minY && ys[ys.length - 1] + LAYOUT.pillHeight <= LAYOUT.maxY);
        for (const p of out) assert.equal(p.offsetY, p.labelY - p.anchorY);
    });

    it('clamps a label above the pane top cleanly inside the bounds', () => {
        const out = resolveHorizontalLabelOffsets([
            { id: 'above', anchorY: -40 },
            { id: 'next', anchorY: -10 },
        ], LAYOUT);
        assert.equal(out[0].labelY, LAYOUT.minY);
        assert.ok(out[0].offsetY > 0, 'a clamped pill still needs a connector');
        assert.ok(out[1].labelY - out[0].labelY >= STEP);
        assert.ok(out[1].labelY + LAYOUT.pillHeight <= LAYOUT.maxY);
    });

    it('pulls a stack back inside the pane bottom instead of clipping it', () => {
        const out = resolveHorizontalLabelOffsets([
            { id: 'a', anchorY: 575 },
            { id: 'b', anchorY: 585 },
            { id: 'c', anchorY: 598 },
        ], LAYOUT);
        const ys = out.map(p => p.labelY);
        for (const gap of separation(ys)) assert.ok(gap >= STEP, `gap ${gap} < ${STEP}`);
        assert.ok(ys[0] >= LAYOUT.minY);
        assert.ok(ys[ys.length - 1] + LAYOUT.pillHeight <= LAYOUT.maxY + 1e-9,
            `last pill bottom ${ys[ys.length - 1] + LAYOUT.pillHeight} exceeds ${LAYOUT.maxY}`);
        // A stack that runs off the bottom is nudged UP as a group (the whole
        // stack cannot sit on the bottom edge), and every moved pill reports it.
        assert.ok(out[0].labelY < 575, 'the stack must move up, not clip');
        assert.ok(out.every(p => p.offsetY < 0));
    });

    it('keeps every pill ordered and in bounds when the pane cannot hold the stack', () => {
        const out = resolveHorizontalLabelOffsets(
            [10, 11, 12, 13, 14, 15].map((y, i) => ({ id: `p${i}`, anchorY: y })),
            { pillHeight: 14, minGap: 3, minY: 2, maxY: 40 },
        );
        assert.deepEqual(out.map(p => p.id), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
        const ys = out.map(p => p.labelY);
        for (const gap of separation(ys)) assert.ok(gap > 0, 'order must survive compression');
        assert.ok(ys[0] >= 2 && ys[ys.length - 1] + 14 <= 40 + 1e-9);
    });

    it('is deterministic and does not mutate its input', () => {
        const input = [
            { id: 'b', anchorY: 210 },
            { id: 'a', anchorY: 200 },
            { id: 'c', anchorY: 205 },
        ];
        const snapshot = JSON.parse(JSON.stringify(input));
        const first = resolveHorizontalLabelOffsets(input, LAYOUT);
        const second = resolveHorizontalLabelOffsets(input, LAYOUT);
        assert.deepEqual(first, second);
        assert.deepEqual(input, snapshot);
        assert.deepEqual(first.map(p => p.id), ['a', 'c', 'b']);
    });

    it('breaks equal anchors by input order', () => {
        const out = resolveHorizontalLabelOffsets([
            { id: 'first', anchorY: 300 },
            { id: 'second', anchorY: 300 },
        ], LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['first', 'second']);
        assert.ok(out[1].labelY - out[0].labelY >= STEP);
    });

    it('returns nothing for no labels and survives non-finite anchors', () => {
        assert.deepEqual(resolveHorizontalLabelOffsets([], LAYOUT), []);
        const out = resolveHorizontalLabelOffsets([
            { id: 'bad', anchorY: Number.NaN },
            { id: 'ok', anchorY: 100 },
        ], LAYOUT);
        assert.deepEqual(out.map(p => p.id), ['ok']);
        assert.equal(out[0].labelY, 100);
    });
});
