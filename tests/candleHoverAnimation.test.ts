import test from 'node:test';
import assert from 'node:assert/strict';
import {
    HOVER_ENTER_MS,
    HOVER_LEAVE_MS,
    brightenCandleColor,
    candleGlowColor,
    computeHoveredCandleStyle,
    easeOutCubic,
    findCandleIndexByTime,
    optimalCandleWidth,
    parseRgbColor,
    stepCandleHoverMap,
} from '../src/components/trade/candleHoverAnimation';

test('optimalCandleWidth matches lightweight-charts resting widths across zoom levels', () => {
    assert.equal(optimalCandleWidth(0), 1);
    assert.equal(optimalCandleWidth(1), 1);
    assert.equal(optimalCandleWidth(3), 3);
    assert.equal(optimalCandleWidth(4), 3);
    // Moderately zoomed: ~80-90% of spacing
    const medium = optimalCandleWidth(10);
    assert.ok(medium >= 7 && medium <= 10, `expected 7..10, got ${medium}`);
    // Wide zoom approaches ~80% of spacing
    const wide = optimalCandleWidth(40);
    assert.ok(wide >= 30 && wide <= 34, `expected 30..34, got ${wide}`);
});

test('parseRgbColor and brightenCandleColor lift semantic candle luminance accurately', () => {
    assert.deepEqual(parseRgbColor('#22c55e'), { r: 34, g: 197, b: 94 });
    assert.deepEqual(parseRgbColor('#ef4444'), { r: 239, g: 68, b: 68 });
    assert.deepEqual(parseRgbColor('#0f0'), { r: 0, g: 255, b: 0 });
    assert.deepEqual(parseRgbColor('rgba(34, 197, 94, 0.8)'), { r: 34, g: 197, b: 94 });
    assert.equal(parseRgbColor('not-a-color'), null);

    // Zero lift preserves original channels
    assert.equal(brightenCandleColor('#22c55e', 0), 'rgb(34, 197, 94)');
    // Positive lift increases all channels strictly toward white
    const lifted = parseRgbColor(brightenCandleColor('#22c55e', 0.34));
    assert.ok(lifted);
    assert.ok(lifted.r > 34 && lifted.g > 197 && lifted.b > 94);
    assert.equal(brightenCandleColor('#ef4444', 1), 'rgb(255, 255, 255)');
    // Glow color emits valid rgba
    assert.match(candleGlowColor('#22c55e', 0.4), /^rgba\(\d+, \d+, \d+, 0\.400\)$/);
});

test('stepCandleHoverMap eases target in, cross-fades previous out, and stops when settled', () => {
    const map = new Map<number, number>();

    // Two 35ms frames reach half of HOVER_ENTER_MS (140ms)
    assert.equal(stepCandleHoverMap(map, 1000, HOVER_ENTER_MS / 4), true);
    assert.equal(stepCandleHoverMap(map, 1000, HOVER_ENTER_MS / 4), true);
    assert.ok(Math.abs((map.get(1000) ?? 0) - 0.5) < 0.001);

    // Complete hover enter — should settle and stop animating
    assert.equal(stepCandleHoverMap(map, 1000, HOVER_ENTER_MS / 4), true);
    assert.equal(stepCandleHoverMap(map, 1000, HOVER_ENTER_MS / 4), false);
    assert.equal(map.get(1000), 1);

    // Large dtMs (e.g. backgrounded tab) is clamped so animation never leaps to 1 in one frame
    const clampedMap = new Map<number, number>();
    assert.equal(stepCandleHoverMap(clampedMap, 3000, 5000), true);
    assert.ok((clampedMap.get(3000) ?? 0) < 0.6);

    // Sweep to candle 1060 — both 1000 (fading out) and 1060 (fading in) are active
    const active3 = stepCandleHoverMap(map, 1060, 50);
    assert.equal(active3, true);
    assert.ok((map.get(1000) ?? 0) < 1 && (map.get(1000) ?? 0) > 0);
    assert.ok((map.get(1060) ?? 0) > 0 && (map.get(1060) ?? 0) < 1);

    // Advance enough frames for 1000 to prune and 1060 to settle at 1
    for (let i = 0; i < 6; i += 1) {
        stepCandleHoverMap(map, 1060, 50);
    }
    assert.equal(map.has(1000), false);
    assert.equal(map.get(1060), 1);
    assert.equal(stepCandleHoverMap(map, 1060, 16), false);

    // Leave chart completely — fades 1060 back to 0 and prunes it
    let running = true;
    for (let i = 0; i < 8; i += 1) {
        running = stepCandleHoverMap(map, null, HOVER_LEAVE_MS / 4);
    }
    assert.equal(running, false);
    assert.equal(map.size, 0);
});

test('stepCandleHoverMap snaps immediately under reducedMotion', () => {
    const map = new Map<number, number>([[1000, 0.5]]);
    assert.equal(stepCandleHoverMap(map, 2000, 16, true), false);
    assert.equal(map.size, 1);
    assert.equal(map.get(2000), 1);

    assert.equal(stepCandleHoverMap(map, null, 16, true), false);
    assert.equal(map.size, 0);
});

test('computeHoveredCandleStyle scales symmetrically around centerX and handles doji candles', () => {
    const rest = computeHoveredCandleStyle({
        centerX: 200,
        openY: 120,
        closeY: 100,
        highY: 85,
        lowY: 135,
        barSpacing: 12,
        baseColor: '#22c55e',
        progress: 0,
    });
    const hovered = computeHoveredCandleStyle({
        centerX: 200,
        openY: 120,
        closeY: 100,
        highY: 85,
        lowY: 135,
        barSpacing: 12,
        baseColor: '#22c55e',
        progress: 1,
    });

    // Strictly wider and taller when hovered, centered symmetrically at centerX
    assert.ok(hovered.bodyWidth > rest.bodyWidth);
    assert.ok(hovered.scaleX > 1.15);
    assert.ok(hovered.bodyHeight > rest.bodyHeight);
    assert.ok(hovered.wickWidth > rest.wickWidth);
    assert.ok(Math.abs((hovered.bodyX + hovered.bodyWidth / 2) - 200) < 0.001);
    assert.ok(hovered.glowBlur > 0);
    assert.notEqual(hovered.fillColor, rest.fillColor);

    // Doji candle (openY === closeY) gets clean visible thickness when hovered
    const doji = computeHoveredCandleStyle({
        centerX: 150,
        openY: 100,
        closeY: 100,
        highY: 80,
        lowY: 120,
        barSpacing: 8,
        baseColor: '#ef4444',
        progress: 1,
    });
    assert.ok(doji.bodyHeight >= 2.2);
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
});

test('findCandleIndexByTime locates timestamps in sorted arrays and returns -1 when absent', () => {
    const bars = [{ time: 100 }, { time: 160 }, { time: 220 }, { time: 280 }, { time: 340 }];
    assert.equal(findCandleIndexByTime(bars, 100), 0);
    assert.equal(findCandleIndexByTime(bars, 220), 2);
    assert.equal(findCandleIndexByTime(bars, 340), 4);
    assert.equal(findCandleIndexByTime(bars, 200), -1);
    assert.equal(findCandleIndexByTime([], 100), -1);
});
