// Wave C pins — empirical bootstrap Monte Carlo, ledger ruin, sample
// uniqueness (N_eff), stationary-bootstrap significance, Deribit options
// context, and the four distilled Skills. All deterministic (seeded).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    empiricalBootstrapSimulation,
    calculateRuinRiskFromSeries,
} from '../src/services/analysis/MonteCarloService';
import {
    computeNEffective,
    stationaryBootstrapPValue,
    MIN_RATE_SAMPLE,
} from '../src/services/analysis/journalTools';
import {
    fetchDeribitOptionsContext,
    parseDeribitVolIndex,
    __futuresRateLimitTestHooks,
} from '../src/services/analysis/MarketDataService';
import type { Kline } from '../src/types/message';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

const randomWalkTape = (bars: number, seed = 7): Kline[] => {
    let a = seed >>> 0;
    const rnd = (): number => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out: Kline[] = [];
    let price = 100;
    for (let i = 0; i < bars; i++) {
        price *= 1 + (rnd() - 0.48) * 0.02;
        out.push({ time: i * 3_600_000, open: price * 0.999, high: price * 1.004, low: price * 0.996, close: price, volume: 100, takerBuyVolume: 50 });
    }
    return out;
};

// ─── C1: empirical bootstrap Monte Carlo ────────────────────────────────────

describe('Wave C — empirical bootstrap Monte Carlo', () => {
    const tape = randomWalkTape(150, 7);
    const config = {
        entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long' as const,
        numSimulations: 800, maxSteps: 100, seed: 42, candles: tape,
    };

    it('runs in empirical_bootstrap mode and is deterministic', () => {
        const a = empiricalBootstrapSimulation(config);
        const b = empiricalBootstrapSimulation(config);
        assert.ok(a !== null && b !== null);
        assert.equal(a.mode, 'empirical_bootstrap');
        assert.equal(a.seedUsed, b.seedUsed);
        assert.equal(a.winRate, b.winRate);
        assert.equal(a.cvar95R, b.cvar95R);
        assert.equal(a.barsUsed, 150);
    });

    it('charges the round-trip fee: avgWin on a +10% TP is strictly below 10%', () => {
        const r = empiricalBootstrapSimulation(config);
        const w = r?.avgWinPercent;
        assert.ok(w !== undefined && w > 0 && w < 10, `avgWin=${w} must be net of costs on a +10% TP`);
        assert.ok((r?.pHitTpBeforeSl ?? 0) > 0 && (r?.pHitTpBeforeSl ?? 0) <= 100);
        assert.ok((r?.expectedBarsToBarrier ?? 0) >= 1);
        assert.ok((r?.tailMaeP95 ?? -1) >= 0);
    });

    it('cvar95R is the mean R of the worst 5% and is below the average R', () => {
        const r = empiricalBootstrapSimulation(config);
        assert.ok(r !== null && r.cvar95R < 0.5, `cvar=${r?.cvar95R} must sit in the losing tail on a 2:1 setup`);
    });

    it('refuses (null) when fewer than 100 closed bars are supplied', () => {
        assert.equal(empiricalBootstrapSimulation({ ...config, candles: tape.slice(0, 50) }), null);
    });
});

// ─── C1: account-level ledger ruin ──────────────────────────────────────────

describe('Wave C — ledger-bootstrap ruin', () => {
    const series = Array.from({ length: 25 }, (_, i) => (i % 3 === 0 ? -1 : 2));

    it('refuses (null) under 20 settled outcomes', () => {
        assert.equal(calculateRuinRiskFromSeries(series.slice(0, 19), 10_000, 5_000), null);
        assert.equal(calculateRuinRiskFromSeries([], 10_000, 5_000), null);
    });

    it('bootstraps the actual R series with CVaR95 and the expected max drawdown', () => {
        const r = calculateRuinRiskFromSeries(series, 10_000, 5_000, 99);
        const r2 = calculateRuinRiskFromSeries(series, 10_000, 5_000, 99);
        assert.ok(r !== null);
        assert.equal(r.mode, 'ledger_bootstrap');
        assert.equal(r.samples, 25);
        assert.equal(r.kellyOptimalSize, r2!.kellyOptimalSize);
        assert.ok(r.cvar95DrawdownPct >= r.expectedMaxDrawdownPct, 'CVaR95 of drawdown ≥ its mean');
        assert.ok(r.expectedMaxDrawdownPct > 0);
        assert.ok(r.prob25pctDrawdown >= r.prob50pctDrawdown);
    });
});

// ─── C2: N_eff + stationary bootstrap ──────────────────────────────────────

describe('Wave C — sample uniqueness (N_eff)', () => {
    it('disjoint windows keep nEffective == rawN', () => {
        const r = computeNEffective([
            { emittedAt: 0, resolvedAt: 100 },
            { emittedAt: 200, resolvedAt: 300 },
            { emittedAt: 400, resolvedAt: 500 },
        ]);
        assert.equal(r.rawN, 3);
        assert.equal(r.nEffective, 3);
    });

    it('identical overlapping windows collapse to one observation', () => {
        const r = computeNEffective([
            { emittedAt: 0, resolvedAt: 100 },
            { emittedAt: 0, resolvedAt: 100 },
            { emittedAt: 0, resolvedAt: 100 },
        ]);
        assert.equal(r.rawN, 3);
        assert.equal(r.nEffective, 1);
    });

    it('partial overlap lands between 1 and rawN', () => {
        const r = computeNEffective([
            { emittedAt: 0, resolvedAt: 100 },
            { emittedAt: 50, resolvedAt: 150 },
            { emittedAt: 200, resolvedAt: 260 },
        ]);
        assert.equal(r.rawN, 3);
        assert.ok(r.nEffective > 1 && r.nEffective < 3, `nEff=${r.nEffective}`);
    });
});

describe('Wave C — stationary bootstrap significance', () => {
    it('a strong edge gives a small p-value; random entries do not', () => {
        const winners = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0.1 : 1));
        const strong = stationaryBootstrapPValue(winners, { iterations: 500, seed: 5 });
        assert.ok(strong.available && strong.pValue !== null && strong.pValue < 0.05, JSON.stringify(strong));
        const rnd = (() => { let a = 99; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
        const noisy = Array.from({ length: 30 }, () => (rnd() - 0.5) * 2);
        const weak = stationaryBootstrapPValue(noisy, { iterations: 500, seed: 6 });
        assert.ok(weak.available && (weak.pValue ?? 1) > 0.05, JSON.stringify(weak));
    });

    it('refuses under 10 entries', () => {
        const r = stationaryBootstrapPValue([1, 2, 3]);
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /10/);
    });

    it('MIN_RATE_SAMPLE stays the gate floor', () => {
        assert.equal(MIN_RATE_SAMPLE, 5);
    });
});

// ─── C3: Deribit options context ────────────────────────────────────────────

describe('Wave C — Deribit options context', () => {
    beforeEach(() => __futuresRateLimitTestHooks.reset());

    it('parses the volatility-index payload to the latest close', () => {
        assert.equal(parseDeribitVolIndex({ result: { data: [[1, 50, 51, 49, 55], [2, 55, 56, 54, 61]] } }), 61);
        assert.equal(parseDeribitVolIndex({ result: { data: [] } }), null);
        assert.equal(parseDeribitVolIndex(null), null);
    });

    it('quotes DVOL + VRP for BTC and refuses other symbols', async () => {
        const fake = (payload: unknown): Response => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload } as unknown as Response);
        __futuresRateLimitTestHooks.reset();
        __futuresRateLimitTestHooks.setFetchImpl(async (url) => {
            if (url.includes('deribit.com')) {
                return fake({ result: { data: [[Date.now() - 3600e3, 50, 51, 49, 55], [Date.now(), 55, 56, 54, 61]] } });
            }
            if (url.includes('/fapi/v1/klines')) {
                // The VRP's realized leg is now 30 closed DAILY bars — serve a
                // deterministic daily walk with real variance (a flat tape has
                // no Yang-Zhang volatility and the leg correctly refuses).
                const rows: unknown[][] = [];
                let p = 100;
                let a = 7;
                for (let t = 0; t < 60; t++) {
                    a = (a + 0x6d2b79f5) | 0;
                    let x = Math.imul(a ^ (a >>> 15), 1 | a);
                    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
                    const rnd = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
                    p *= 1 + (rnd - 0.5) * 0.04;
                    rows.push([t * 86400e3, String(p * 0.99), String(p * 1.01), String(p * 0.98), String(p), '10', t * 86400e3 + 86399e3, '1', 1, '5', '5', '0']);
                }
                return fake(rows);
            }
            if (url.includes('/fapi/v1/ticker/24hr') && !url.includes('symbol=')) {
                return fake([{ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '1000' }]);
            }
            if (url.includes('/fapi/v1/exchangeInfo')) {
                return fake({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', baseAsset: 'BTC' }] });
            }
            return fake({});
        });
        const btc = await fetchDeribitOptionsContext('BTCUSDT');
        assert.equal(btc.available, true, `BTC context refused: ${btc.reason ?? 'no reason'}`);
        assert.equal(btc.symbol, 'BTC');
        assert.equal(btc.dvol, 61);
        assert.equal(btc.realizedVolWindow, '30d daily Yang-Zhang');
        assert.ok(btc.realizedVolPct !== null && btc.realizedVolPct !== undefined && btc.realizedVolPct > 0);
        assert.ok(near(btc.vrp ?? 0, 61 - (btc.realizedVolPct as number), 1e-6));
        const sol = await fetchDeribitOptionsContext('SOLUSDT');
        assert.equal(sol.available, false, `SOL context: ${sol.reason ?? ''}`);
        assert.match(sol.reason ?? '', /BTC and ETH only/);
        __futuresRateLimitTestHooks.reset();
    });

    it('refuses when Deribit errors (clean available:false)', async () => {
        __futuresRateLimitTestHooks.reset();
        await __futuresRateLimitTestHooks.setFetchImpl(async () => { throw new Error('deribit down'); });
        const r = await fetchDeribitOptionsContext('ETHUSDT');
        assert.equal(r.available, false);
        assert.match(r.reason ?? '', /Deribit fetch failed/);
        __futuresRateLimitTestHooks.reset();
    });
});

// ─── C3: the four distilled Skills ──────────────────────────────────────────

import {
    parseSkillMarkdown,
} from '../src/services/learning/SkillFileService';
import {
    skillFormatIssues,
    scanSkillText,
} from '../src/utils/skillFrontmatter';
import { toAnthropicTools } from '../src/services/analysis/DeskToolsService';

describe('Wave C — distilled Skills', () => {
    const skills = [
        'brooks-trend-pullback-h2-l2',
        'major-trend-reversal-gate',
        'confirmed-range-and-breakout',
        'spot-perp-crowding-fade',
    ];
    it('all four SKILL.md files exist with frontmatter, pass loader validation, and align with real desk tool names', () => {
        const knownTools = new Set((toAnthropicTools() as Array<{ name: string }>).map(t => t.name));
        for (const slug of skills) {
            const file = path.join(ROOT, 'skills', slug, 'SKILL.md');
            assert.ok(fs.existsSync(file), `${file} missing`);
            const text = fs.readFileSync(file, 'utf-8');
            const parsed = parseSkillMarkdown(text);
            assert.ok(parsed && parsed.name && parsed.description && parsed.body, `${slug}: parseSkillMarkdown`);
            assert.deepEqual(skillFormatIssues(text), [], `${slug}: format issues`);
            assert.deepEqual(scanSkillText(text), [], `${slug}: security scan findings`);
            for (const section of ['## When to use', '## Steps', '## Pitfalls', '## Verification']) {
                assert.ok(text.includes(section), `${slug}: missing ${section}`);
            }
            // Every referenced tool name in backticks must be a real registered desk tool.
            for (const m of text.matchAll(/`(get_regime|swing_structure|order_flow|imbalances|trade_math|run_monte_carlo|get_key_levels|sr_zones|liquidity|get_order_book|setup_base_rate|get_btc_context|derivatives_state|get_derivatives)`/g)) {
                assert.ok(knownTools.has(m[1]), `${slug}: unknown tool ${m[1]}`);
            }
            assert.ok(!text.includes('expectedHoldHours'), `${slug}: must use snake_case expected_hold_hours`);
            assert.ok(!text.includes('get_derivatives.funding_state'), `${slug}: funding_state lives on derivatives_state, not get_derivatives`);
        }
    });
});
