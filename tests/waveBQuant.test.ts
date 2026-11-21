// Wave B pins — spot/perp CVD divergence, VPIN, quant volatility/trend pack,
// and the Al Brooks bar-geometry primitives. All deterministic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    spotPerpCvdDivergence,
    vpin,
} from '../src/services/market/orderFlowCore';
import {
    yangZhangVol, bbKcSqueeze, nr7, expectedMove1Sigma, varianceRatio,
    hurstExponent, trendScanTStat, strongestTrendScan, barbwire,
    reversalOverlapTrap, ema20GapStreak, climaxBar,
} from '../src/services/market/volRegimeCore';
import {
    barCountPullback, compositeCandle, insideClusters, readStructure,
} from '../src/services/market/swingStructureCore';
import { microMeasuringGaps } from '../src/services/market/imbalanceCore';
import type { Kline } from '../src/types/message';

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 100, takerBuyVolume?: number): Kline => ({
    time, open, high, low, close, volume,
    ...(takerBuyVolume !== undefined ? { takerBuyVolume } : {}),
});

// Deterministic LCG for synthetic random walks.
const lcg = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// ─── B1: spot/perp CVD divergence ───────────────────────────────────────────

describe('Wave B — spot/perp CVD divergence', () => {
    const mkPair = (n: number, spotBuyShare: number, perpBuyShare: number): { perp: Kline[]; spot: Kline[] } => {
        const perp: Kline[] = [];
        const spot: Kline[] = [];
        for (let i = 0; i < n; i++) {
            const t = i * 3_600_000;
            perp.push(bar(t, 100, 101, 99, 100.5, 100, 100 * perpBuyShare));
            spot.push(bar(t, 100, 101, 99, 100.5, 100, 100 * spotBuyShare));
        }
        return { perp, spot };
    };

    it('classifies ALIGNED when both books run the same delta direction', () => {
        const { perp, spot } = mkPair(20, 0.7, 0.7);
        const r = spotPerpCvdDivergence(perp, spot);
        assert.equal(r.available, true);
        assert.equal(r.classification, 'aligned');
        assert.equal(r.alignedBars, 20);
        assert.ok(r.spotCvd !== null && r.spotCvd > 0);
        assert.ok(Math.abs((r.normalizedDeltaDivergence ?? 1)) < 1e-6, 'identical books → zero divergence');
    });

    it('classifies ABSORPTION_RISK when the books pull in opposite directions', () => {
        const { perp, spot } = mkPair(20, 0.9, 0.1);
        const r = spotPerpCvdDivergence(perp, spot);
        assert.equal(r.classification, 'absorption_risk');
        assert.ok(Math.abs(r.normalizedDeltaDivergence ?? 0) > 0.79, `normalized=${r.normalizedDeltaDivergence}`);
    });

    it('classifies PERP_CHASE when perp delta surges and spot stays flat', () => {
        const perp: Kline[] = [];
        const spot: Kline[] = [];
        for (let i = 0; i < 20; i++) {
            const t = i * 3_600_000;
            perp.push(bar(t, 100, 101, 99, 100.5, 100, 85));
            spot.push(bar(t, 100, 101, 99, 100.5, 100, 50));
        }
        const r = spotPerpCvdDivergence(perp, spot);
        assert.equal(r.classification, 'perp_chase');
    });

    it('classifies SPOT_LED when spot delta surges and perp lags', () => {
        const perp: Kline[] = [];
        const spot: Kline[] = [];
        for (let i = 0; i < 20; i++) {
            const t = i * 3_600_000;
            perp.push(bar(t, 100, 101, 99, 100.5, 100, 50));
            spot.push(bar(t, 100, 101, 99, 100.5, 100, 85));
        }
        const r = spotPerpCvdDivergence(perp, spot);
        assert.equal(r.classification, 'spot_led');
    });

    it('refuses on misaligned/insufficient overlap (perp-only listing shape)', () => {
        const { perp, spot } = mkPair(20, 0.7, 0.7);
        const truncatedSpot = spot.slice(0, 5); // misaligned window
        const r = spotPerpCvdDivergence(perp, truncatedSpot);
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /aligned closed bar/);
    });

    it('refuses when taker-buy volume is missing (delta not measurable)', () => {
        const { perp, spot } = mkPair(20, 0.7, 0.7);
        const noTaker = spot.map(c => ({ ...c, takerBuyVolume: undefined }));
        const r = spotPerpCvdDivergence(perp, noTaker as Kline[]);
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /taker-buy volume/);
    });

    it('classifies bearish spot_led and perp_chase when the other book has 0 delta (50% taker buy)', () => {
        const { perp: p1, spot: s1 } = mkPair(20, 0.15, 0.5); // spot negative, perp 0
        const rSpotLed = spotPerpCvdDivergence(p1, s1);
        assert.equal(rSpotLed.classification, 'spot_led');
        const { perp: p2, spot: s2 } = mkPair(20, 0.5, 0.15); // perp negative, spot 0
        const rPerpChase = spotPerpCvdDivergence(p2, s2);
        assert.equal(rPerpChase.classification, 'perp_chase');
        const { perp: p3, spot: s3 } = mkPair(20, 0.5, 0.5); // both 0
        const rZero = spotPerpCvdDivergence(p3, s3);
        assert.equal(rZero.classification, 'aligned');
        assert.equal(Object.is(rZero.spotCvd, -0), false);
    });
});

// ─── B1: VPIN ───────────────────────────────────────────────────────────────

describe('Wave B — VPIN', () => {
    it('builds equal-volume buckets and scores the rolling imbalance', () => {
        // 4 bars of 100 volume, fully one-sided → one bucket per bar.
        const candles = [
            bar(0, 100, 101, 99, 100, 100, 100),
            bar(60, 100, 101, 99, 100, 100, 0),
            bar(120, 100, 101, 99, 100, 100, 100),
            bar(180, 100, 101, 99, 100, 100, 0),
        ];
        const r = vpin(candles, { minBuckets: 4, targetBuckets: 4, rollingWindow: 2 });
        assert.equal(r.available, true);
        assert.equal(r.buckets, 4);
        assert.equal(r.vpin, 1);
        assert.equal(r.vpinPercentile, 100);
        assert.equal(r.toxicityWarning, true);
    });

    it('splits a bar across buckets proportionally to its own taker ratio', () => {
        const candles = [
            bar(0, 100, 101, 99, 100, 150, 75), // 0.5 ratio → fills bucket 1 (100) then 25 into bucket 2
            bar(60, 100, 101, 99, 100, 150, 75), // completes bucket 2 (75+75... splits again)
        ];
        const r = vpin(candles, { minBuckets: 2, targetBuckets: 3, rollingWindow: 1 });
        assert.equal(r.available, true);
        assert.equal(r.buckets, 3);
        assert.ok(r.vpin !== null && r.vpin >= 0 && r.vpin <= 1);
    });

    it('refuses under the minimum bucket count', () => {
        const candles = [bar(0, 100, 101, 99, 100, 100, 80), bar(60, 100, 101, 99, 100, 100, 20)];
        const r = vpin(candles, { minBuckets: 20, targetBuckets: 2 });
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /bucket/);
        assert.equal(r.toxicityWarning, false);
    });

    it('refuses when taker-buy volume is missing', () => {
        const candles = [bar(0, 100, 101, 99, 100, 100), bar(60, 100, 101, 99, 100, 100)];
        const r = vpin(candles as Kline[], { minBuckets: 1 });
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /taker-buy volume/);
    });
});

// ─── B2: Yang-Zhang vol, squeeze, NR7, expected move ────────────────────────

describe('Wave B — volatility & compression pack', () => {
    const flatThenWide = (): Kline[] => {
        const out: Kline[] = [bar(0, 100, 100.5, 99.5, 100)];
        for (let i = 1; i <= 40; i++) {
            out.push(bar(i * 3600, 100, 100.5, 99.5, 100)); // calm tape: σ ≈ tiny
        }
        // 30 wide bars: ±2 around 100
        for (let i = 41; i <= 70; i++) {
            out.push(bar(i * 3600, 100, 103, 97, 100));
        }
        return out;
    };

    it('Yang-Zhang vol rises on a wide tape and ranks it at the top', () => {
        const candles = flatThenWide();
        const calm = yangZhangVol(candles.slice(0, 40), 3600, 30, 10);
        const wide = yangZhangVol(candles, 3600, 30, 10);
        assert.ok(calm !== null && calm.perBar > 0);
        assert.ok(wide !== null && wide.perBar > calm.perBar, `wide ${wide?.perBar} must exceed calm ${calm?.perBar}`);
        assert.equal(wide.percentile, 100);
        assert.ok(wide.annualizedPct > wide.perBar * 100);
    });

    it('Yang-Zhang refuses a window thinner than 3 bars and quotes percentile right at 90 closed bars', () => {
        assert.equal(yangZhangVol([bar(0, 100, 101, 99, 100)], 3600, 30, 10), null);
        const tape90: Kline[] = [];
        for (let i = 0; i < 90; i++) {
            const p = 100 + Math.sin(i * 0.3) * 2;
            tape90.push(bar(i * 3600, p - 0.5, p + 1, p - 1, p));
        }
        const yz90 = yangZhangVol(tape90, 3600, 30, 60);
        assert.ok(yz90 !== null && yz90.percentile !== null, '90-bar tape yields 60 estimates and satisfies minHistory=60');
    });

    it('bbKcSqueeze fires on a tight tape and stays off when closes disperse', () => {
        const tight: Kline[] = [];
        for (let i = 0; i < 40; i++) {
            const close = 100 + (i % 2) * 0.1;
            tight.push(bar(i * 3600, close - 0.2, close + 0.2, close - 0.2, close));
        }
        const dispersed: Kline[] = [];
        for (let i = 0; i < 40; i++) {
            const close = 100 + i * 5;
            dispersed.push(bar(i * 3600, close - 0.2, close + 0.2, close - 0.2, close));
        }
        assert.equal(bbKcSqueeze(tight), true);
        assert.equal(bbKcSqueeze(dispersed), false);
    });

    it('nr7 flags the narrowest range of the last 7 bars', () => {
        const candles = [
            bar(0, 100, 105, 95, 100), bar(60, 100, 104, 96, 100), bar(120, 100, 103, 97, 100),
            bar(180, 100, 102, 98, 100), bar(240, 100, 101, 99, 100), bar(300, 100, 100.8, 99.4, 100),
            bar(360, 100, 100.5, 99.8, 100), // narrowest (0.7)
        ];
        const r = nr7(candles);
        assert.equal(r.isNr7, true);
        assert.ok(near(r.range, 0.7));
        assert.equal(r.ofBars, 7);
        assert.equal(nr7([...candles, bar(420, 100, 104, 96, 100)]).isNr7, false);
    });

    it('expectedMove1Sigma scales with sqrt(horizon) in dollars and percent', () => {
        const r = expectedMove1Sigma(0.01, 100, 4);
        assert.ok(near(r!.dollars, 2, 1e-9));
        assert.ok(near(r!.percent, 2, 1e-9));
        assert.equal(r!.horizonBars, 4);
        assert.equal(expectedMove1Sigma(0, 100, 4), null);
    });
});

// ─── B2: Hurst / variance ratio / trend scanning ────────────────────────────

describe('Wave B — Hurst, variance ratio, trend scanning', () => {
    const randomWalk = (seed: number, n: number): number[] => {
        const rnd = lcg(seed);
        const closes = [100];
        for (let i = 1; i < n; i++) closes.push(closes[i - 1] + (rnd() - 0.5) * 2);
        return closes;
    };
    const arTrend = (seed: number, n: number, phi: number): number[] => {
        const rnd = lcg(seed);
        const closes = [100];
        let r = 0;
        for (let i = 1; i < n; i++) {
            r = phi * r + (rnd() - 0.5) * 0.5;
            closes.push(closes[i - 1] * Math.exp(r * 0.001));
        }
        return closes;
    };

    it('variance ratio ≈ 1 on a random walk, > 1 when trending, < 1 when mean-reverting', () => {
        const rw = randomWalk(7, 300);
        const vr = varianceRatio(rw, 4);
        assert.ok(vr !== null && vr > 0.8 && vr < 1.25, `vr=${vr}`);
        const trend = arTrend(11, 300, 0.6);
        const vrTrend = varianceRatio(trend, 4);
        assert.ok(vrTrend !== null && vrTrend > 1, `vr=${vrTrend}`);
        const rev = arTrend(13, 300, -0.6);
        const vrRev = varianceRatio(rev, 4);
        assert.ok(vrRev !== null && vrRev < 1, `vr=${vrRev}`);
    });

    it('variance ratio refuses a tape shorter than k×4+1', () => {
        assert.equal(varianceRatio([100, 101, 102], 4), null);
    });

    it('hurst ≈ 0.5 on a random walk, below 0.5 mean-reverting, above 0.5 trending', () => {
        const rw = randomWalk(17, 400);
        const h = hurstExponent(rw);
        assert.ok(h !== null && h > 0.35 && h < 0.65, `h=${h}`);
        assert.ok((hurstExponent(arTrend(19, 400, -0.6)) ?? 1) < 0.5, 'mean-reverting tape');
        assert.ok((hurstExponent(arTrend(23, 400, 0.6)) ?? 0) > 0.5, 'trending tape');
    });

    it('hurst refuses tapes under 65 bars', () => {
        assert.equal(hurstExponent(randomWalk(7, 40)), null);
    });

    it('trend scanning finds the strongest horizon and refuses thin tapes', () => {
        const ramp: number[] = [];
        for (let i = 0; i < 90; i++) ramp.push(100 + 2 * i + (i % 2) * 0.5);
        const points = trendScanTStat(ramp);
        assert.ok(points !== null && points.length === 4);
        const strongest = strongestTrendScan(points!);
        assert.ok(strongest !== null && Math.abs(strongest.tStat) > 10, JSON.stringify(strongest));
        assert.equal(trendScanTStat(ramp.slice(0, 8)), null, 'under 5-bar horizons → refused');
    });
});

// ─── B3: Al Brooks bar geometry ─────────────────────────────────────────────

describe('Wave B — Brooks bar geometry', () => {
    it('barbwire: overlapping doji/tail bars flag the chop hazard', () => {
        const wire = [
            bar(0, 100.4, 101.5, 99.5, 100.1),
            bar(60, 100.2, 101.3, 99.6, 100.9),
            bar(120, 100.1, 101.4, 99.7, 100.3),
        ];
        assert.equal(barbwire(wire), true);
        const trend = [
            bar(0, 100, 102, 99.5, 101.5),
            bar(60, 101.5, 104, 101, 103.5),
            bar(120, 103.5, 106, 103, 105.5),
        ];
        assert.equal(barbwire(trend), false);
    });

    it('reversal-overlap trap flags weak midpoints', () => {
        const prevBull = bar(0, 100, 110, 90, 90);
        assert.equal(reversalOverlapTrap([prevBull, bar(60, 95, 108, 94, 105)]), true, 'bull reversal with mid 101 above the prior low 90 → trap');
        assert.equal(reversalOverlapTrap([prevBull, bar(60, 80, 100, 70, 95)]), false, 'mid 85 below the prior low 90 → no trap');
        const prevBear = bar(0, 100, 110, 90, 108);
        assert.equal(reversalOverlapTrap([prevBear, bar(60, 105, 104, 92, 95)]), true, 'bear reversal with mid 98 below the prior high 110 → trap');
    });

    it('ema20GapStreak counts the no-contact run and flags the 20-bar pullback setup', () => {
        const candles: Kline[] = [];
        for (let i = 0; i < 40; i++) candles.push(bar(i * 3600, 100, 100.5, 99.5, 100));
        for (let i = 0; i < 25; i++) candles.push(bar((40 + i) * 3600, 101 + i, 101.5 + i, 100.5 + i, 101.5 + i));
        const running = ema20GapStreak(candles);
        assert.ok(running.streak >= 20, `streak=${running.streak}`);
        // Final bar dips back through the EMA → the setup fires.
        candles.push(bar(65 * 3600, 124, 125, 100, 121));
        const setup = ema20GapStreak(candles);
        assert.equal(setup.maGapBarSetup, true);
        assert.equal(setup.streak, 0);
    });

    it('climaxBar fires on a 2.5× body after a 10-bar unbroken streak', () => {
        const candles: Kline[] = [bar(0, 100, 101, 99, 100.5)];
        for (let i = 1; i <= 25; i++) candles.push(bar(i * 3600, 100.5 + i, 102 + i, 100 + i, 101.5 + i));
        // The climax: one bar with a 6-point body after the 26-bar grind.
        candles.push(bar(26 * 3600, 126, 132, 125, 131));
        const r = climaxBar(candles);
        assert.equal(r.isClimax, true);
        assert.ok(r.bodyVsMedian >= 2.5 && r.trendStreak >= 10, JSON.stringify(r));
        const quiet = candles.slice(0, 24).concat([bar(24 * 3600, 125.5, 126.5, 124.5, 125.8)]);
        assert.equal(climaxBar(quiet).isClimax, false);
    });

    it('barCountPullback counts H2/L2 with trigger and invalidation prices', () => {
        const candles = [
            bar(0, 10, 12, 9, 11),
            bar(60, 11, 14, 10.5, 13),
            bar(120, 13, 9, 8, 9),     // deep pullback
            bar(180, 9, 11, 7, 10),    // H1 (11 > 9)
            bar(240, 10, 13, 9.5, 12), // H2 (13 > 11)
        ];
        const r = barCountPullback(candles, 0.5);
        assert.equal(r!.direction, 'bull');
        assert.equal(r!.label, 'H2');
        assert.equal(r!.count, 2);
        assert.equal(r!.triggerPrice, 13.5);
        assert.equal(r!.invalidationPrice, 7);
        const mirrored = candles.map(c => bar(c.time, 100 - c.open, 100 - c.low, 100 - c.high, 100 - c.close));
        const l = barCountPullback(mirrored, 0.5);
        assert.equal(l!.label, 'L2');
        assert.equal(l!.triggerPrice, 86.5);
        assert.equal(l!.invalidationPrice, 93);
    });

    it('barCountPullback clamps the label at 4 while keeping the exact count', () => {
        const candles = [bar(0, 10, 11, 9, 10)];
        for (let i = 1; i <= 6; i++) candles.push(bar(i * 60, 10 + i, 11 + i, 9 + i, 10 + i));
        const r = barCountPullback(candles);
        assert.equal(r!.label, 'H4');
        assert.equal(r!.count, 6);
    });

    it('barCountPullback returns null on an inside close', () => {
        const candles = [bar(0, 10, 12, 9, 11), bar(60, 10.5, 11.5, 9.5, 10.75)];
        assert.equal(barCountPullback(candles), null);
    });

    it('compositeCandle blends 2 and 3 bars with body/tail ratios', () => {
        const candles = [
            bar(0, 100, 104, 99, 103),
            bar(60, 103, 106, 100, 101),
            bar(120, 101, 105, 98, 104),
        ];
        const two = compositeCandle(candles, 2);
        assert.equal(two!.bars, 2);
        assert.equal(two!.open, 103);
        assert.equal(two!.close, 104);
        assert.equal(two!.high, 106);
        assert.equal(two!.low, 98);
        assert.ok(near(two!.bodyRatio, 0.125));
        assert.ok(near(two!.upperTailRatio, 0.25));
        assert.ok(near(two!.lowerTailRatio, 0.625));
        const three = compositeCandle(candles, 3);
        assert.equal(three!.open, 100);
        assert.equal(three!.close, 104);
        assert.equal(three!.netDirection, 'bull');
    });

    it('insideClusters detects ii, iii and ioi with exact breakout triggers', () => {
        // iii: three nested bars (wick-inclusive) after an outer bar.
        const nested = [
            bar(0, 100, 110, 90, 105),
            bar(60, 102, 108, 92, 104),
            bar(120, 103, 106, 94, 103.5),
            bar(180, 103, 105.5, 95, 104),
        ];
        const clusters = insideClusters(nested, 0.5);
        assert.ok(clusters.some(c => c.kind === 'iii' && near(c.breakoutHigh, 108.5) && near(c.breakoutLow, 91.5)), JSON.stringify(clusters));
        // ii: two nested bars then a breakout bar.
        const iiBars = [
            bar(0, 100, 110, 90, 105),
            bar(60, 102, 108, 92, 104),
            bar(120, 103, 106, 94, 103.5),
            bar(180, 104, 112, 93, 111), // breaks OUT of the inner bar
        ];
        const ii = insideClusters(iiBars, 0.5);
        assert.ok(ii.some(c => c.kind === 'ii' && near(c.breakoutHigh, 108.5) && near(c.breakoutLow, 91.5)), JSON.stringify(ii));
        // ioi: inside → outside → inside.
        const ioiBars = [
            bar(0, 100, 110, 90, 105),
            bar(60, 103, 106, 94, 104),     // inside the outer bar
            bar(120, 102, 111, 89, 108),    // outside the middle bar
            bar(180, 105, 109, 95, 103),    // inside the outside bar
        ];
        const ioi = insideClusters(ioiBars, 0.5);
        assert.ok(ioi.some(c => c.kind === 'ioi' && near(c.breakoutHigh, 111.5) && near(c.breakoutLow, 88.5)), JSON.stringify(ioi));
        // live ii at the right edge (two newest bars nested inside c1, no breakout bar yet)
        const liveIiBars = [
            bar(0, 100, 110, 90, 105),
            bar(60, 101, 109, 91, 104), // c1 (outer)
            bar(120, 102, 107, 93, 103), // c2 (inside c1)
            bar(180, 103, 105, 95, 104), // c3 (inside c2)
        ];
        // Make c1 NOT inside c0 so it's ii (not iii)
        liveIiBars[1] = bar(60, 101, 112, 91, 104);
        const liveIi = insideClusters(liveIiBars, 0.5);
        assert.ok(liveIi.some(c => c.kind === 'ii' && c.indices[0] === 2 && c.indices[1] === 3 && near(c.breakoutHigh, 107.5) && near(c.breakoutLow, 92.5)), JSON.stringify(liveIi));
    });
});

// ─── B3: micro measuring gaps ───────────────────────────────────────────────

describe('Wave B — micro measuring gaps', () => {
    it('detects a bull 3-bar gap, its midpoint, and the tested status', () => {
        const candles = [
            bar(0, 100, 101, 99, 100),
            bar(60, 101, 105, 100.5, 104),  // surge
            bar(120, 105.5, 107, 101, 103), // next.low 101 ≥ prev.high 101 → bull gap; mid = 101
            bar(180, 103, 104, 100.5, 102), // tested (low 100.5 ≤ 101)
        ];
        const gaps = microMeasuringGaps(candles);
        assert.equal(gaps.length, 1);
        assert.equal(gaps[0].direction, 'bull');
        assert.equal(gaps[0].midpoint, 101);
        assert.equal(gaps[0].tested, true);
        assert.equal(gaps[0].index, 1);
    });

    it('detects a bear gap and an untested projection', () => {
        const candles = [
            bar(0, 100, 101, 97, 100),
            bar(60, 99, 98, 95, 96),        // bear surge
            bar(120, 96.5, 96, 93, 95),     // next.high 96 ≤ prev.low 97 → bear gap; mid = 96.5
            bar(180, 95, 98, 94, 97),       // tested (high 98 ≥ 96.5)
        ];
        const gaps = microMeasuringGaps(candles);
        assert.equal(gaps.length, 1);
        assert.equal(gaps[0].direction, 'bear');
        assert.equal(gaps[0].midpoint, 96.5);
        assert.equal(gaps[0].tested, true);
    });

    it('returns an empty list on a tape without 3-bar gaps', () => {
        const candles = [
            bar(0, 100, 101, 99, 100),
            bar(60, 100, 101, 99, 100),
            bar(120, 100, 101, 99, 100),
        ];
        assert.equal(microMeasuringGaps(candles).length, 0);
    });
});

function near(a: number, b: number, eps = 1e-4): boolean {
    return Math.abs(a - b) <= eps;
}
