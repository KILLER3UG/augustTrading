// Wave C hardening pins — the five strict-audit fixes:
//   1. the >75% two-bar overlap trigger rule in compositeCandle,
//   2. the empirical Monte Carlo's zero-drift barrier invariants (the
//      block-start off-by-one fix) with exactly-centered tapes,
//   3. the entry-significance refusal floor (nEffective < 10) and the
//      sample-scaled block length,
//   4. the ledger ruin's AR(1) rho + Triple-Penance drawdown fields,
//   5. the 30-day realized-vol window for the Deribit VRP (pinned in
//      waveCValidate via the realizedVolWindow assertion).
// All deterministic (seeded); none touches the network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    empiricalBootstrapSimulation,
    calculateRuinRiskFromSeries,
    monteCarloToMarkdown,
    runSimulation,
} from '../src/services/analysis/MonteCarloService';
import {
    computeNEffective,
    stationaryBootstrapPValue,
    runSetupBaseRateTool,
} from '../src/services/analysis/journalTools';
import {
    gradeParent,
    MIN_HOLDOUT_SAMPLE,
    type HarnessParent,
} from '../src/services/selfMod/harnessOptimization';
import { compositeCandle } from '../src/services/market/swingStructureCore';
import type { LoggedTrade } from '../src/types/trade';
import type { Kline } from '../src/types/message';

const bar = (time: number, open: number, high: number, low: number, close: number): Kline =>
    ({ time, open, high, low, close, volume: 10 });

// ─── Fix 1: the >75% two-bar overlap trigger rule ───────────────────────────

describe('Wave C hardening — two-bar overlap trigger', () => {
    it('overlapRatio > 0.75 requires clearing BOTH bars', () => {
        const b1 = bar(0, 99, 102, 98, 101);
        const b2 = bar(3_600_000, 101, 101.6, 98.4, 100.5);
        // shared = 101.6 − 98.4 = 3.2; wider range = 4 → 0.8 > 0.75
        const c = compositeCandle([b1, b2], 2, 0.25);
        assert.ok(c !== null);
        assert.equal(c.overlapRatio, 0.8);
        assert.equal(c.requiresBothBarsClear, true);
        assert.equal(c.triggerHigh, 102.25); // max(b1.high, b2.high) + tick
        assert.equal(c.triggerLow, 97.75);   // min(b1.low, b2.low) − tick
    });

    it('overlapRatio <= 0.75 triggers off the second bar alone', () => {
        const b1 = bar(0, 100, 110, 90, 105);
        const b2 = bar(3_600_000, 103, 105, 95, 100.5);
        // shared = 105 − 95 = 10; wider range = 20 → 0.5 <= 0.75
        const c = compositeCandle([b1, b2], 2, 0.25);
        assert.ok(c !== null);
        assert.equal(c.overlapRatio, 0.5);
        assert.equal(c.requiresBothBarsClear, false);
        assert.equal(c.triggerHigh, 105.25); // b2.high + tick only
        assert.equal(c.triggerLow, 94.75);   // b2.low − tick only
    });

    it('disjoint bars report zero overlap; 3-bar composites carry no trigger rule', () => {
        const disjoint = compositeCandle([bar(0, 100, 102, 98, 101), bar(3_600_000, 104, 108, 103, 107)], 2, 0.25);
        assert.ok(disjoint !== null);
        assert.equal(disjoint.overlapRatio, 0);
        assert.equal(disjoint.requiresBothBarsClear, false);
        assert.equal(disjoint.triggerHigh, 108.25);
        const three = compositeCandle([bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99.5, 101), bar(2, 101, 103, 100, 102)], 3, 0.25);
        assert.ok(three !== null);
        assert.equal(three.overlapRatio, undefined);
        assert.equal(three.requiresBothBarsClear, undefined);
    });
});

// ─── Fix 2: empirical Monte Carlo zero-drift invariants ─────────────────────

/** Zero-drift tape by construction: seeded Gaussian log returns with the
 *  sample mean subtracted, so the bootstrap replays NO drift at all and the
 *  barrier odds reduce to the pure first-passage ratios. */
const centeredTape = (bars: number, sigma: number, seed: number): Kline[] => {
    let a = seed >>> 0;
    const rnd = (): number => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const returns: number[] = [];
    for (let i = 0; i < bars; i++) {
        const u1 = Math.max(rnd(), 1e-12);
        const u2 = rnd();
        returns.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma);
    }
    const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
    const out: Kline[] = [];
    let price = 100;
    for (let i = 0; i < bars; i++) {
        price *= Math.exp(returns[i] - mean);
        out.push(bar(i * 3_600_000, price * 0.999, price * 1.002, price * 0.998, price));
    }
    return out;
};

describe('Wave C hardening — empirical bootstrap barrier invariants', () => {
    const tape = centeredTape(220, 0.006, 99);

    it('symmetric +5%/-5% zero-drift bracket lands near 50% (42–58%)', () => {
        const r = empiricalBootstrapSimulation({
            entry: 100, stopLoss: 95, takeProfits: [105], direction: 'Long',
            numSimulations: 2000, maxSteps: 1000, seed: 42, candles: tape,
        });
        assert.ok(r !== null && r.mode === 'empirical_bootstrap');
        assert.ok(r.pHitTpBeforeSl >= 42 && r.pHitTpBeforeSl <= 58,
            `symmetric pHitTpBeforeSl=${r.pHitTpBeforeSl} must sit in 42–58 (log-space barriers center it near 51)`);
    });

    it('2:1 +10%/-5% zero-drift bracket lands near 35% (25–40%) with the fee drag below 10%', () => {
        const r = empiricalBootstrapSimulation({
            entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long',
            numSimulations: 2000, maxSteps: 1000, seed: 42, candles: tape,
        });
        assert.ok(r !== null);
        assert.ok(r.pHitTpBeforeSl >= 25 && r.pHitTpBeforeSl <= 40,
            `2:1 pHitTpBeforeSl=${r.pHitTpBeforeSl} must sit in 25–40 (log-space barriers center it near 35)`);
        assert.ok((r.avgWinPercent ?? 0) > 0 && (r.avgWinPercent ?? 0) < 10,
            `avgWin=${r.avgWinPercent} must stay below the raw +10% TP (fee drag deducted)`);
    });

    it('every legal block start is now sampleable (deterministic, tail included)', () => {
        const cfg = {
            entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long' as const,
            numSimulations: 500, maxSteps: 300, seed: 7, candles: tape,
        };
        const a = empiricalBootstrapSimulation(cfg);
        const b = empiricalBootstrapSimulation(cfg);
        assert.ok(a !== null && b !== null);
        assert.equal(a.pHitTpBeforeSl, b.pHitTpBeforeSl);
        assert.equal(a.seedUsed, b.seedUsed);
    });
});

// ─── Fix 3: the entry-significance floor and block-length scaling ───────────

describe('Wave C hardening — entry significance floor', () => {
    const winners = Array.from({ length: 20 }, (_, i) => (i % 5 < 3 ? 2 : -1));

    it('refuses under 10 entries with the exact thin-sample reason', () => {
        const r = stationaryBootstrapPValue([1, -1, 1, 2, -1, 1, 1, -1, 2, 1].slice(0, 6));
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /sample too thin: nEffective 6 \(need >= 10\) — no significance p-value is quoted/);
    });

    it('refuses when the caller-supplied nEffective is under 10 even with 20 entries', () => {
        const r = stationaryBootstrapPValue(winners, { seed: 11, nEffective: 6 });
        assert.equal(r.available, false);
        assert.equal(r.nEffective, 6);
        assert.match(r.reason ?? '', /nEffective 6 \(need >= 10\)/);
    });

    it('scales the block length to the sample (N=20 → 3, never above ⌊N/3⌋)', () => {
        const r = stationaryBootstrapPValue(winners, { seed: 11 });
        assert.equal(r.meanBlockLength, 3);
        assert.equal(r.available, true);
    });

    it('zero-edge series keeps a high p-value; the winning series stays significant but not impossibly so', () => {
        const zeroEdge = stationaryBootstrapPValue(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1)), { seed: 1234 });
        assert.ok((zeroEdge.pValue ?? 0) > 0.2, `zero-edge p=${zeroEdge.pValue} must not read as an edge`);
        const strong = stationaryBootstrapPValue(winners, { seed: 1234 });
        assert.ok((strong.pValue ?? 1) > 0.0005 && (strong.pValue ?? 1) < 0.05,
            `winning p=${strong.pValue} must be significant yet above the 1/(B+1) floor`);
    });

    it('setup_base_rate refuses the significance leg when the disjoint-window N_eff is under 10', () => {
        const trades = Array.from({ length: 6 }, (_, i) => ({
            id: `t${i}`,
            timestamp: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
            outcome: i % 3 === 2 ? 'LOSS' : 'WIN',
            analysis: { coinName: 'BTC', direction: 'Long', detectedPatternFamily: 'pullback', entryPoints: [{ price: '100' }], stopLoss: '95', takeProfit: [{ price: '110' }] },
        })) as unknown as LoggedTrade[];
        const sixWindows = Array.from({ length: 6 }, (_, i) => ({ emittedAt: i * 10_000, resolvedAt: i * 10_000 + 5_000 }));
        const thin = JSON.parse(runSetupBaseRateTool(trades, { coin: 'BTCUSDT', signalWindows: sixWindows, entryReturns: winners }));
        assert.equal(thin.values.entry_significance.available, false);
        assert.match(thin.values.entry_significance.reason, /nEffective 6 \(need >= 10\)/);
        assert.equal(thin.values.sample_uniqueness.rawN, 6);

        const twelveWindows = Array.from({ length: 12 }, (_, i) => ({ emittedAt: i * 10_000, resolvedAt: i * 10_000 + 5_000 }));
        const ok = JSON.parse(runSetupBaseRateTool(trades, { coin: 'BTCUSDT', signalWindows: twelveWindows, entryReturns: winners }));
        assert.equal(ok.values.entry_significance.available, true);
        assert.equal(ok.values.entry_significance.nEffective, 12);
        assert.ok(ok.values.entry_significance.pValue > 0 && ok.values.entry_significance.pValue < 0.05);
    });

    it('N_eff still collapses overlapping windows (rawN 6 → 1)', () => {
        const r = computeNEffective(Array.from({ length: 6 }, () => ({ emittedAt: 1, resolvedAt: 2 })));
        assert.equal(r.rawN, 6);
        assert.equal(r.nEffective, 1);
    });

    it('computeNEffective collapses zero-duration identical timestamps and rejects invalid/inverted windows', () => {
        const zeroDur = computeNEffective(Array.from({ length: 6 }, () => ({ emittedAt: 1_700_000_000_000, resolvedAt: 1_700_000_000_000 })));
        assert.equal(zeroDur.rawN, 6);
        assert.equal(zeroDur.nEffective, 1);

        const invalid = computeNEffective([
            { emittedAt: NaN, resolvedAt: 100 },
            { emittedAt: 200, resolvedAt: 100 }, // inverted
            { emittedAt: 300, resolvedAt: 400 },
        ]);
        assert.equal(invalid.rawN, 3);
        assert.equal(invalid.nEffective, 1);
    });

    it('setup_base_rate evaluates entry_significance over the exact same matched series on mixed ledgers (6+14 refused, 12+8 accepted)', () => {
        const mkTrade = (i: number, coin: string, direction: 'Long' | 'Short', outcome: 'WIN' | 'LOSS'): LoggedTrade => ({
            id: `${coin}-${i}`,
            timestamp: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
            decidedAt: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
            outcomeResolvedAt: new Date(1_700_000_000_000 + i * 3_600_000 + 1_800_000).toISOString(),
            outcome,
            realizedR: outcome === 'WIN' ? 2 : -1,
            analysis: {
                coinName: coin,
                direction,
                detectedPatternFamily: 'pullback',
                entryPoints: [{ price: '100' }],
                stopLoss: direction === 'Long' ? '95' : '105',
                takeProfit: [{ price: direction === 'Long' ? '110' : '90' }],
            },
        }) as unknown as LoggedTrade;

        const mixedRefused: LoggedTrade[] = [
            ...Array.from({ length: 6 }, (_, i) => mkTrade(i, 'BTCUSDT', 'Long', i % 3 === 2 ? 'LOSS' : 'WIN')),
            ...Array.from({ length: 14 }, (_, i) => mkTrade(i + 6, 'ETHUSDT', 'Short', i % 2 === 0 ? 'WIN' : 'LOSS')),
        ];
        const refused = JSON.parse(runSetupBaseRateTool(mixedRefused, { coin: 'BTC', direction: 'Long' }, 1_700_100_000_000));
        assert.equal(refused.data_quality.available, true);
        assert.equal(refused.values.sample, 6);
        assert.equal(refused.values.sample_uniqueness.rawN, 6);
        assert.equal(refused.values.sample_uniqueness.nEffective, 6);
        assert.equal(refused.values.entry_significance.available, false);
        assert.equal(refused.values.entry_significance.entries, 6);
        assert.equal(refused.values.entry_significance.nEffective, 6);
        assert.equal(refused.values.entry_significance.entries, refused.values.sample_uniqueness.rawN);

        const mixedAccepted: LoggedTrade[] = [
            ...Array.from({ length: 12 }, (_, i) => mkTrade(i, 'BTCUSDT', 'Long', i % 4 === 3 ? 'LOSS' : 'WIN')),
            ...Array.from({ length: 8 }, (_, i) => mkTrade(i + 12, 'ETHUSDT', 'Short', 'LOSS')),
        ];
        const accepted = JSON.parse(runSetupBaseRateTool(mixedAccepted, { coin: 'BTC', direction: 'Long' }, 1_700_100_000_000));
        assert.equal(accepted.data_quality.available, true);
        assert.equal(accepted.values.sample, 12);
        assert.equal(accepted.values.sample_uniqueness.rawN, 12);
        assert.equal(accepted.values.sample_uniqueness.nEffective, 12);
        assert.equal(accepted.values.entry_significance.available, true);
        assert.equal(accepted.values.entry_significance.entries, 12);
        assert.equal(accepted.values.entry_significance.nEffective, 12);
        assert.equal(accepted.values.entry_significance.entries, accepted.values.sample_uniqueness.rawN);
    });
});

describe('Wave C hardening — empirical MC receipt drift & O-150 holdout gate', () => {
    it('empirical bootstrap accepts 100 closed bars, discloses tape drift without "neutral initial drift", and handles high timeout without NaN CVaR95', () => {
        // Trending down tape (~ -19% over 220 bars)
        const downTape: Kline[] = [];
        let p = 100;
        const stepFactor = Math.pow(0.81, 1 / 219);
        for (let i = 0; i < 220; i++) {
            if (i > 0) p *= stepFactor * (1 + (i % 2 === 0 ? 0.004 : -0.004));
            downTape.push(bar(i * 3_600_000, p * 1.001, p * 1.005, p * 0.995, p));
        }
        const emp100 = empiricalBootstrapSimulation({
            entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long',
            numSimulations: 200, maxSteps: 20, seed: 42, candles: downTape.slice(0, 100),
        });
        assert.ok(emp100 !== null && emp100.mode === 'empirical_bootstrap', '100 closed bars (99 returns) must enter empirical_bootstrap');
        assert.ok(Number.isFinite(emp100.cvar95R), `cvar95R must stay finite even with timeouts: ${emp100.cvar95R}`);

        const emp = empiricalBootstrapSimulation({
            entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long',
            numSimulations: 400, maxSteps: 100, seed: 42, candles: downTape,
        });
        assert.ok(emp !== null && emp.tapeDriftPct < -10);
        const empMd = monteCarloToMarkdown(emp, undefined, {
            symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110],
            atr: 2, timeframe: '1h', maxSteps: 100, atrSource: 'measured',
        });
        assert.ok(!empMd.includes('neutral initial drift'), `empirical receipt must never print neutral initial drift:\n${empMd}`);
        assert.match(empMd, /resampled tape drift -\d+\.\d% over 220 bars/);

        const gbm = runSimulation({
            entry: 100, stopLoss: 95, takeProfits: [110], explicitTargetsOnly: true,
            direction: 'Long', atr: 2, timeframe: '1h', numSimulations: 400, maxSteps: 100, seed: 42,
        });
        gbm.mode = 'gbm_fallback';
        const gbmMd = monteCarloToMarkdown(gbm, undefined, {
            symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110],
            atr: 2, timeframe: '1h', maxSteps: 100, atrSource: 'measured',
        });
        assert.ok(gbmMd.includes('neutral initial drift'), `GBM fallback receipt must print neutral initial drift:\n${gbmMd}`);
    });

    it('O-150 gradeParent refuses 6 overlapping fills (nEffective < 6) and grades 6 disjoint fills', () => {
        const mkParent = (rawN: number, nEffective: number): HarnessParent => ({
            id: 'p1',
            promptId: 'analysis.risk_rules',
            text: 'rule',
            kind: 'stop-swept',
            approvedAt: new Date(1_700_000_000_000).toISOString(),
            ledgerId: 'l1',
            baseline: { hitRate: 0.6, samples: 20 },
            holdout: {
                fills: 6,
                won: 2,
                lost: 4,
                expired: 0,
                hitRate: 2 / 6,
                uniqueness: { rawN, nEffective },
            },
            deltaPp: null,
            status: 'measuring',
        });

        const overlapping = mkParent(6, 1);
        gradeParent(overlapping);
        assert.equal(overlapping.status, 'measuring');
        assert.equal(overlapping.deltaPp, null);

        const disjoint = mkParent(6, MIN_HOLDOUT_SAMPLE);
        gradeParent(disjoint);
        assert.equal(disjoint.status, 'graded');
        assert.equal(disjoint.deltaPp, Math.round((2 / 6 - 0.6) * 100));
    });
});

// ─── Fix 4: the ledger ruin's AR(1) rho + Triple-Penance fields ─────────────

describe('Wave C hardening — ledger ruin AR(1) + triple penance', () => {
    const series = Array.from({ length: 25 }, (_, i) => (i % 3 === 0 ? -1 : 2));

    it('reports ar1Rho1 (clamped) and the Triple-Penance drawdown on a positive-edge ledger', () => {
        const r = calculateRuinRiskFromSeries(series, 10_000, 5_000, 99);
        assert.ok(r !== null && r.mode === 'ledger_bootstrap' && r.samples === 25);
        assert.ok(r.ar1Rho1 !== null && r.ar1Rho1 !== undefined && r.ar1Rho1 > -0.95 && r.ar1Rho1 < 0.95);
        assert.ok((r.triplePenanceMaxDdPct ?? 0) > 0);
        assert.ok((r.triplePenanceTimeUnderwaterTrades ?? 0) > 0);
        // σ²/(2μ) in R for this series ≈ 1.29²/(2·1) ≈ 0.83R → ×0.5 risk ×100 ≈ 41.5% equity
        assert.ok((r.triplePenanceMaxDdPct ?? 0) < 100, 'the asymptotic penance stays sane for a 2:1 ledger');
    });

    it('a losing ledger has no expected recovery (time underwater null) and still quotes a drawdown floor', () => {
        const losers = Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? 1 : -1));
        const r = calculateRuinRiskFromSeries(losers, 10_000, 5_000, 99);
        assert.ok(r !== null);
        assert.equal(r.triplePenanceTimeUnderwaterTrades, null);
        assert.ok((r.triplePenanceMaxDdPct ?? 0) > 0);
    });

    it('refuses under 20 samples exactly as before', () => {
        assert.equal(calculateRuinRiskFromSeries(series.slice(0, 19), 10_000, 5_000, 99), null);
    });

    it('positive AR(1) serial correlation inflates Triple-Penance drawdown vs negative correlation', () => {
        // Same marginal distribution (12 wins of +2R, 12 losses of -1R), opposite serial order:
        // clustered streaks (ρ > 0) vs alternating outcomes (ρ < 0).
        const clustered = [
            ...Array.from({ length: 12 }, () => 2),
            ...Array.from({ length: 12 }, () => -1),
        ];
        const alternating = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 2 : -1));
        const pos = calculateRuinRiskFromSeries(clustered, 10_000, 2_000, 99);
        const neg = calculateRuinRiskFromSeries(alternating, 10_000, 2_000, 99);
        assert.ok(pos !== null && neg !== null);
        assert.ok((pos.ar1Rho1 ?? 0) > 0 && (neg.ar1Rho1 ?? 0) < 0);
        assert.ok((pos.triplePenanceMaxDdPct ?? 0) > (neg.triplePenanceMaxDdPct ?? Infinity),
            `clustered DD (${pos.triplePenanceMaxDdPct}%) must exceed alternating DD (${neg.triplePenanceMaxDdPct}%)`);
    });
});
