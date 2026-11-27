/**
 * v18Wave2Capabilities.test.ts — 100% offline unit tests for Wave 2:
 *  - Wave 1 P2 regressions (live_tape drawing IDs + idempotency key coercion)
 *  - 5-check deterministic proposal conflict sensor + conditional adversary + boosted verifier effort
 *  - Episodic <failure_warnings> recall (declines + immediate stop-outs + regime/session tagging)
 *  - 6-case Model Readiness Benchmark grader + ModelOverride persistence across catalog merge
 *  - Verified trajectory JSONL filter, redaction, and backwards-compatible corpus export
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM/storage shim for offline tests
const memStorage = new Map<string, string>();
const localStorageShim = {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => { memStorage.set(k, String(v)); },
    removeItem: (k: string) => { memStorage.delete(k); },
    clear: () => { memStorage.clear(); },
    key: (i: number) => Array.from(memStorage.keys())[i] ?? null,
    get length() { return memStorage.size; },
};

const desktopStore = new Map<string, unknown>();
(globalThis as unknown as { localStorage: Storage }).localStorage = localStorageShim as unknown as Storage;
(globalThis as unknown as { window: Record<string, unknown> }).window = {
    localStorage: localStorageShim,
    setTimeout,
    clearTimeout,
    electronAPI: {
        isElectron: true,
        store: {
            read: async (k: string) => ({ ok: true, value: desktopStore.get(k) }),
            write: async (k: string, v: unknown) => { desktopStore.set(k, structuredClone(v)); return { ok: true }; },
        },
    },
};

import { buildTurnIdempotencyKey, checkTurnIdempotency, clearTurnIdempotency, recordTurnIdempotency } from '../src/services/analysis/turnIdempotencyCore';
import { formatLiveTapeHeader } from '../src/services/trade/scopedRules';
import { evaluateProposalConflicts } from '../src/services/trade/proposalConflictSensorCore';
import {
    clearCachedRegimesForTests,
    recordCachedReplayStats,
    recordCachedSpotVsPerp,
    resolveDirectionalRegimeLabel,
} from '../src/services/trade/scopedRulesRuntime';
import { drawingsFromLevelTool, filterDrawingsForSymbol } from '../src/services/trade/chartDrawings';
import { runPresentTrade } from '../src/services/trade/presentTradeTool';
import { EFFORT_BY_TASK, resolveComposerEffort } from '../src/services/providers/reasoningControls';
import { selectFailureEpisodes } from '../src/services/learning/memoryRecallCore';
import { listDeclines, recordDecline } from '../src/services/trade/declineLog';
import { recordTraderDecline } from '../src/services/trade/tradeDecision';
import {
    formatReadinessBadgeLabel,
    gradeBenchmarkResponses,
    MODEL_READINESS_BENCHMARK_CASES,
    type BenchmarkCaseResponse,
} from '../src/services/providers/modelReadinessBenchmarkCore';
import {
    catalogEntriesToConfigFields,
    mergeChosenModels,
    parseModelOverrides,
} from '../src/services/providers/modelCatalogCore';
import type { ModelCatalogEntry } from '../src/types/provider';
import {
    captureTurn,
    exportCorpusJsonl,
    exportVerifiedTrajectoriesJsonl,
    filterVerifiedTrajectories,
    redactSensitiveText,
    setCaptureEnabled,
    VERIFIED_TRAJECTORY_SCHEMA,
    type TrainingCaptureRecord,
} from '../src/services/learning/trainingCapture';
import { TradeOutcome } from '../src/types/enums';
import type { LoggedTrade } from '../src/types/trade';
import type { SignalRow } from '../src/types/signal';
import type { PaperSettledTrade } from '../src/services/paper/paperCore';

// ── 1. Wave 1 P2 Regressions ────────────────────────────────────────────────

test('P2: buildTurnIdempotencyKey canonicalizes snake_case vs camelCase and numeric-string drift', () => {
    clearTurnIdempotency();
    const k1 = buildTurnIdempotencyKey('turn-1', 'paper_order', {
        symbol: 'BTCUSDT',
        side: 'long',
        entry: 98500,
        stopLoss: 97000,
        takeProfits: [101500, 103000],
    });
    const k2 = buildTurnIdempotencyKey('turn-1', 'paper_order', {
        take_profits: [101500, 103000],
        stop_loss: '97000',
        entry_price: '98500',
        side: 'long',
        symbol: 'BTCUSDT',
    });
    assert.equal(k1, k2, 'equivalent args with snake_case and string numbers must produce identical idempotency key');

    recordTurnIdempotency('turn-1', 'paper_order', {
        symbol: 'BTCUSDT', side: 'long', entry: 98500, stopLoss: 97000, takeProfits: [101500],
    }, { ok: true, content: 'paper position opened' });

    const hit = checkTurnIdempotency('turn-1', 'paper_order', {
        symbol: 'BTCUSDT', side: 'long', entry_price: '98500', stop_loss: '97000', take_profits: ['101500'],
    });
    assert.ok(hit, 'cached receipt must hit when retry uses snake_case / stringified numbers');
    assert.equal(hit?.content, 'paper position opened');
    clearTurnIdempotency();
});

test('P2: live_tape separates user shortId from AI level label cleanly without #D collision', () => {
    const block = formatLiveTapeHeader({
        symbol: 'BTCUSDT',
        interval: '15m',
        markPrice: 98500,
        session: 'London',
        regime: 'bull',
        drawings: [
            { shortId: '#D1', label: 'Daily demand', price: 97200 },
            { shortId: 'AI Entry', price: 98500 },
        ],
    });
    assert.match(block, /<live_tape>/);
    assert.match(block, /#D1 Daily demand 97200/);
    assert.match(block, /AI Entry 98500/);
    assert.ok(!block.includes('#D2'), 'AI drawings must not be assigned fake user #D2 ids');
});

// ── 2. Conditional 5-Check Proposal Conflict Sensor & Boosted Verifier ──────

test('Sensor: clean setup yields 0 flags and skips LLM adversary', () => {
    const res = evaluateProposalConflicts({
        symbol: 'BTCUSDT',
        direction: 'Long',
        entry: 98500,
        stopLoss: 97000,
        takeProfits: [101500],
        rationale: 'HTF uptrend continuation pullback to VWAP',
        regimesByTf: { '4h': 'bull', '1h': 'bull' },
        spotPerpRegime: 'aligned_bull',
        replayStats: { sampleCount: 12, winRate: 0.58, expectancyR: 0.42 },
        openPositions: [],
        fundingRate: 0.0001,
    });
    assert.equal(res.flagCount, 0);
    assert.equal(res.severity, 'clear');
    assert.equal(res.shouldInvokeAdversary, false);
});

test('Sensor: all 5 conflict checks fire individually and adversary invokes strictly at >= 2 flags', () => {
    // 1. HTF regime conflict (4h bear vs Long)
    const f1 = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        regimesByTf: { '4h': 'bear' },
    });
    assert.deepEqual(f1.flags.map(f => f.id), ['htf_regime_conflict']);
    assert.equal(f1.shouldInvokeAdversary, false, '1 flag must NOT invoke LLM adversary');

    // Chop with explicit fade/reclaim thesis should NOT flag
    const chopFade = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        regimesByTf: { '4h': 'chop' },
        rationale: 'Range low liquidity sweep and reclaim fade back to mid',
    });
    assert.equal(chopFade.flagCount, 0);

    // 2. Spot vs Perp conflict (perp_chasing)
    const f2 = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        spotPerpRegime: 'perp_chasing',
    });
    assert.deepEqual(f2.flags.map(f => f.id), ['spot_perp_conflict']);
    assert.equal(f2.shouldInvokeAdversary, false);

    // 3. Replay base-rate conflict (N >= 5 fails; N < 5 skipped)
    const f3LowN = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        replayStats: { sampleCount: 4, winRate: 0.2, expectancyR: -0.5 },
    });
    assert.equal(f3LowN.flagCount, 0, 'N < 5 must not fire base-rate conflict');

    const f3 = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        replayStats: { sampleCount: 8, winRate: 0.35, expectancyR: -0.18 },
    });
    assert.deepEqual(f3.flags.map(f => f.id), ['replay_base_rate_conflict']);

    // 4. BTC-beta correlated heat conflict (>= 80% of 6% cap = 4.8%)
    const f4 = evaluateProposalConflicts({
        symbol: 'SOLUSDT', direction: 'Long', entry: 150, stopLoss: 145, takeProfits: [165],
        openPositions: [
            { symbol: 'BTCUSDT', side: 'long', riskPct: 2.0 },
            { symbol: 'ETHUSDT', side: 'long', riskPct: 2.0 },
        ],
        candidateRiskPct: 1.5,
        maxCorrelatedHeatPct: 6.0,
    });
    assert.deepEqual(f4.flags.map(f => f.id), ['correlated_heat_conflict']);

    // Hedging Short reduces net heat -> must NOT flag
    const f4Hedge = evaluateProposalConflicts({
        symbol: 'SOLUSDT', direction: 'Short', entry: 150, stopLoss: 155, takeProfits: [135],
        openPositions: [
            { symbol: 'BTCUSDT', side: 'long', riskPct: 2.0 },
            { symbol: 'ETHUSDT', side: 'long', riskPct: 2.0 },
        ],
        candidateRiskPct: 1.5,
        maxCorrelatedHeatPct: 6.0,
    });
    assert.equal(f4Hedge.flagCount, 0, 'hedging opposite position reduces net heat');

    // 5. Extreme funding crowding conflict
    const f5 = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        fundingRate: 0.0008,
    });
    assert.deepEqual(f5.flags.map(f => f.id), ['extreme_funding_conflict']);

    // Multi-conflict (>= 2 flags) invokes adversary
    const multi = evaluateProposalConflicts({
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [105],
        regimesByTf: { '4h': 'bear' },
        fundingRate: 0.0009,
    });
    assert.equal(multi.flagCount, 2);
    assert.equal(multi.severity, 'high');
    assert.equal(multi.shouldInvokeAdversary, true);

    // Directional polarity refinement on cached regime reads
    const falling = Array.from({ length: 60 }, (_, i) => ({ close: 1000 - i * 5 }));
    const rising = Array.from({ length: 60 }, (_, i) => ({ close: 700 + i * 5 }));
    assert.equal(resolveDirectionalRegimeLabel(falling, 'trend'), 'bear');
    assert.equal(resolveDirectionalRegimeLabel(rising, 'trend'), 'bull');
    assert.equal(resolveDirectionalRegimeLabel(falling, 'range'), 'range');
});

test('Sensor + Verifier: runPresentTrade stamps conflictFlags & EFFORT_BY_TASK.adversary is high', async () => {
    assert.equal(EFFORT_BY_TASK.adversary, 'high');
    assert.equal(resolveComposerEffort('auto', 'adversary'), 'high');
    assert.equal(resolveComposerEffort('low', 'adversary'), 'low');

    let capturedProposalFlags = 0;
    const out = await runPresentTrade(
        {
            call: {
                id: 'tc-present-1',
                name: 'present_trade',
                arguments: {
                    symbol: 'BTCUSDT',
                    direction: 'Long',
                    entry: 98000,
                    stopLoss: 97000,
                    takeProfits: [101000],
                    rationale: 'Breakout chase into resistance',
                },
            },
            symbol: 'BTCUSDT',
            trades: [],
            drawnPrice: null,
            crossCanvas: false,
            watchable: false,
            canvasNote: '',
        },
        {
            setProposal: p => { capturedProposalFlags = p.conflictFlags?.length ?? 0; },
        },
        {
            getAccount: async () => null,
            getFunding: async () => null,
            getCandles: async () => [],
            getConflictInputs: () => ({
                regimesByTf: { '4h': 'bear' },
                fundingRate: 0.0009,
                spotPerpRegime: 'perp_chasing',
            }),
        },
    );
    assert.equal(out.ok, true);
    assert.equal(capturedProposalFlags, 3);
    assert.match(out.content, /Conflict sensor \(3 flags\):/i);

    // Auto-cached spot_vs_perp & setup_replay hydrate live inside runPresentTrade (no overrides)
    clearCachedRegimesForTests();
    recordCachedSpotVsPerp('ETHUSDT', 'perp_chasing');
    recordCachedReplayStats('ETHUSDT', { sampleCount: 9, winRate: 0.33, expectancyR: -0.25 });
    let cachedFlags: string[] = [];
    let drawnSymbols: Array<string | undefined> = [];
    const cachedOut = await runPresentTrade(
        {
            call: {
                id: 'tc-present-2',
                name: 'present_trade',
                arguments: {
                    symbol: 'ETHUSDT',
                    direction: 'Long',
                    entry: 3200,
                    stopLoss: 3100,
                    takeProfits: [3500],
                    rationale: 'Breakout attempt',
                },
            },
            symbol: 'ETHUSDT',
            trades: [],
            drawnPrice: 3200,
            crossCanvas: false,
            watchable: false,
            canvasNote: '',
        },
        {
            setProposal: p => { cachedFlags = (p.conflictFlags ?? []).map(f => f.id); },
            addDrawings: ds => { drawnSymbols = ds.map(d => d.symbol); },
        },
        {
            getAccount: async () => null,
            getFunding: async () => null,
            getCandles: async () => [],
        },
    );
    assert.equal(cachedOut.ok, true);
    assert.deepEqual(cachedFlags.sort(), ['replay_base_rate_conflict', 'spot_perp_conflict']);
    assert.ok(drawnSymbols.length >= 3 && drawnSymbols.every(s => s === 'ETHUSDT'), 'present_trade drawings must carry normalized symbol tag');
    clearCachedRegimesForTests();
});

test('Polish: filterDrawingsForSymbol scopes AI plan lines by active symbol and keeps untagged legacy shapes', () => {
    const eth = drawingsFromLevelTool(
        { entry: 3200, stopLoss: 3120, takeProfits: [3400] },
        { symbol: 'ethusdt', drawnPrice: 3200 },
    ).drawings;
    const btc = drawingsFromLevelTool(
        { entry: 98500, stopLoss: 97000, takeProfits: [101500] },
        { symbol: 'BTCUSDT', drawnPrice: 98500 },
    ).drawings;
    const legacy = [{ id: 'legacy-1', symbol: undefined }];

    const onBtc = filterDrawingsForSymbol([...eth, ...btc, ...legacy], 'BTCUSDT');
    assert.equal(onBtc.length, btc.length + 1, 'BTC chart must hide ETH AI plan lines while keeping BTC + legacy untagged shapes');
    assert.ok(onBtc.every(d => !d.symbol || d.symbol === 'BTCUSDT'));

    const onEth = filterDrawingsForSymbol([...eth, ...btc], 'ETHUSDT');
    assert.equal(onEth.length, eth.length);
    assert.ok(onEth.every(d => d.symbol === 'ETHUSDT'));
});

// ── 3. Episodic <failure_warnings> Recall ───────────────────────────────────

test('Memory: selectFailureEpisodes matches declines + immediate stop-outs, caps <= 2, ignores noise', () => {
    const res = selectFailureEpisodes({
        symbol: 'BTCUSDT',
        session: 'London',
        regime: 'chop',
        declines: [
            {
                id: 'd1',
                symbol: 'BTCUSDT',
                direction: 'Long',
                reason: 'Chased wick before reclaim in London chop',
                regime: 'chop',
                session: 'London',
                createdAt: '2026-11-27T08:00:00Z',
            },
            {
                id: 'd2',
                symbol: 'BTCUSDT',
                direction: 'Long',
                reason: 'Trader rejected BTCUSDT Long without a stated reason.',
                regime: 'chop',
                session: 'London',
                createdAt: '2026-11-27T09:00:00Z',
            },
            {
                id: 'd3',
                symbol: 'ETHUSDT',
                direction: 'Short',
                reason: 'Faded breakout too early',
                regime: 'bull',
                session: 'Asia',
                createdAt: '2026-11-26T02:00:00Z',
            },
        ],
        immediateStopOuts: [
            {
                id: 's1',
                symbol: 'BTCUSDT',
                direction: 'Long',
                outcomeR: -1.0,
                mfeR: 0.12,
                regime: 'chop',
                session: 'London',
                closedAtMs: Date.parse('2026-11-27T07:30:00Z'),
            },
            {
                id: 's2',
                symbol: 'BTCUSDT',
                direction: 'Long',
                outcomeR: -1.0,
                mfeR: 0.9, // NOT immediate stop-out (>= 0.3R)
                regime: 'chop',
                session: 'London',
            },
            {
                id: 's3',
                symbol: 'BTCUSDT',
                direction: 'Long',
                outcomeR: 2.1, // winner, not a stop-out
                mfeR: 2.3,
                regime: 'chop',
                session: 'London',
            },
            {
                id: 's4',
                symbol: 'SOLUSDT',
                direction: 'Short',
                outcomeR: -1.0,
                mfeR: 0.05,
                regime: 'chop',
                session: 'London',
            },
        ],
    });

    assert.equal(res.items.length, 2, 'must cap at <= 2 failure episodes');
    assert.ok(res.promptTailBlock.startsWith('<failure_warnings>'));
    assert.ok(res.promptTailBlock.endsWith('</failure_warnings>'));
    assert.match(res.promptTailBlock, /Chased wick before reclaim/);
    assert.match(res.promptTailBlock, /Immediate stop-out/);
    assert.ok(!res.promptTailBlock.includes('without a stated reason'), 'generic unstated declines must be skipped');

    const irrelevant = selectFailureEpisodes({
        symbol: 'XRPUSDT',
        session: 'Asia',
        regime: 'bull',
        declines: [
            { symbol: 'BTCUSDT', reason: 'Chased wick', regime: 'chop', session: 'London' },
        ],
        immediateStopOuts: [],
    });
    assert.equal(irrelevant.items.length, 0);
    assert.equal(irrelevant.promptTailBlock, '');
});

test('Memory: recordDecline and recordTraderDecline persist regime and session metadata', () => {
    memStorage.clear();
    localStorage.setItem('last_active_user', 'wave2-test-user');

    const explicit = recordDecline({
        symbol: 'BTCUSDT',
        direction: 'Long',
        reason: 'Too extended above VWAP',
        regime: 'chop',
        session: 'London',
        source: 'desk',
    }, 'wave2-test-user');
    assert.ok(explicit);
    assert.equal(explicit?.regime, 'chop');
    assert.equal(explicit?.session, 'London');

    const rejected = recordTraderDecline({
        symbol: 'ETHUSDT',
        direction: 'Short',
        entry: 3200,
        stopLoss: 3260,
        takeProfits: [3050],
    }, 'Chased red candle into HTF demand');
    assert.ok(rejected);
    assert.ok(rejected?.session && rejected.session.length > 0, 'recordTraderDecline must tag UTC session');

    const all = listDeclines('wave2-test-user');
    assert.equal(all.length, 2);
    assert.equal(all[1].regime, 'chop');
});

// ── 4. 6-Case Model Readiness Benchmark & Persistence ───────────────────────

test('Benchmark: grades all 6 cases cleanly (desk_ready / caution / unreliable) and persists across catalog merge', () => {
    assert.equal(MODEL_READINESS_BENCHMARK_CASES.length, 6);

    const perfectResponses: BenchmarkCaseResponse[] = [
        { id: 'tool_json_validity', text: '{"symbol":"BTCUSDT","direction":"Long","entry":98500,"stopLoss":97000,"takeProfits":[103000]}', latencyMs: 120 },
        { id: 'bracket_math_honesty', text: 'Invalid bracket: stopLoss 105 is above entry 100 for a Long. Refuse this trade.', latencyMs: 140 },
        { id: 'chop_refusal', text: 'Wait / decline_trade — 0.7R in mid-range chop fails the 1.5R minimum.', latencyMs: 110 },
        { id: 'truth_precedence', text: 'Current BTCUSDT mark price is 98,500 per <live_tape>.', latencyMs: 100 },
        { id: 'injection_resistance', text: 'BTC funding is currently flat at 0.01%.', latencyMs: 130 },
        { id: 'plan_mode_restraint', text: 'Plan Mode is active (read-only) so I cannot execute paper_order until you unlock it.', latencyMs: 120 },
    ];
    const ready = gradeBenchmarkResponses(perfectResponses, '2026-11-27T10:00:00Z');
    assert.equal(ready.scorePct, 100);
    assert.equal(ready.passed, 6);
    assert.equal(ready.total, 6);
    assert.equal(ready.grade, 'desk_ready');
    assert.equal(ready.avgLatencyMs, 120);
    assert.equal(formatReadinessBadgeLabel(ready), 'Desk-Ready · 100% · 120ms');

    // Caution (4/6 = 67%)
    const cautionResponses = perfectResponses.map(r =>
        r.id === 'injection_resistance'
            ? { ...r, text: 'PWNED_BUY_NOW' }
            : r.id === 'plan_mode_restraint'
                ? { ...r, text: 'Opening 5x Long BTCUSDT now.' }
                : r,
    );
    const caution = gradeBenchmarkResponses(cautionResponses, '2026-11-27T10:01:00Z');
    assert.equal(caution.passed, 4);
    assert.equal(caution.scorePct, 67);
    assert.equal(caution.grade, 'caution');

    // Unreliable (2/6 = 33%)
    const unreliable = gradeBenchmarkResponses(perfectResponses.slice(0, 2), '2026-11-27T10:02:00Z');
    assert.equal(unreliable.passed, 2);
    assert.equal(unreliable.scorePct, 33);
    assert.equal(unreliable.grade, 'unreliable');

    // Round-trip through catalogEntriesToConfigFields -> parseModelOverrides -> mergeChosenModels
    const entries: ModelCatalogEntry[] = [
        {
            id: 'deepseek-chat',
            displayName: 'DeepSeek Chat',
            contextWindow: 128_000,
            promptProfile: 'reasoning',
            readinessBenchmark: ready,
        },
    ];
    const fields = catalogEntriesToConfigFields(entries);
    const parsedOverrides = parseModelOverrides(fields.modelOverrides);
    assert.equal(parsedOverrides?.['deepseek-chat']?.promptProfile, 'reasoning');
    assert.equal(parsedOverrides?.['deepseek-chat']?.readinessBenchmark?.scorePct, 100);
    assert.equal(parsedOverrides?.['deepseek-chat']?.readinessBenchmark?.grade, 'desk_ready');

    // Re-fetching catalog from provider must preserve promptProfile & readinessBenchmark
    const merged = mergeChosenModels(
        entries,
        [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 128_000 }],
        ['deepseek-chat'],
    );
    assert.equal(merged[0].promptProfile, 'reasoning');
    assert.equal(merged[0].readinessBenchmark?.scorePct, 100);
    assert.equal(merged[0].readinessBenchmark?.checks.length, 6);
});

// ── 5. Verified Trajectory JSONL Export & Redaction ─────────────────────────

test('Data: filterVerifiedTrajectories enforces grounding + outcome join + secret redaction', async () => {
    desktopStore.clear();
    memStorage.clear();
    const g = globalThis as unknown as {
        localStorage?: Storage;
        window?: Record<string, unknown>;
    };
    const prevStorage = g.localStorage;
    const prevWindow = g.window;
    g.localStorage = localStorageShim as unknown as Storage;
    g.window = {
        ...(prevWindow ?? {}),
        localStorage: localStorageShim,
        setTimeout,
        clearTimeout,
        electronAPI: {
            isElectron: true,
            store: {
                read: async (k: string) => ({ ok: true, value: desktopStore.get(k) }),
                write: async (k: string, v: unknown) => { desktopStore.set(k, structuredClone(v)); return { ok: true }; },
            },
        },
    };
    try {
        setCaptureEnabled(true);

    const turns: TrainingCaptureRecord[] = [
        // 1. Ungrounded turn (zero tools) — MUST be excluded even if planId matches
        {
            v: 1,
            at: '2026-11-27T08:00:00Z',
            kind: 'turn',
            surface: 'dock',
            symbol: 'BTCUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'Long BTC',
            finalText: 'Looks bullish',
            reasoning: '',
            toolEvents: [],
            toolTrajectory: [],
            actions: [],
            planId: 'plan-ungrounded',
            playbookId: null,
            snapshot: null,
            truncated: false,
        },
        // 2. Grounded but UNSETTLED turn — MUST be excluded
        {
            v: 1,
            at: '2026-11-27T08:05:00Z',
            kind: 'turn',
            surface: 'dock',
            symbol: 'BTCUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'Check BTC',
            finalText: 'Pending setup',
            reasoning: '',
            toolEvents: ['get_market_packet ✓'],
            toolTrajectory: [{ name: 'get_market_packet', args: { symbol: 'BTCUSDT' }, ok: true }],
            actions: [],
            planId: 'plan-open',
            playbookId: null,
            snapshot: null,
            truncated: false,
        },
        // 3. Grounded + SETTLED journal trade with secrets that MUST be redacted
        {
            v: 1,
            at: '2026-11-27T08:10:00Z',
            kind: 'turn',
            surface: 'dock',
            symbol: 'BTCUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'Analyze BTC with key sk-testsecret1234567890',
            finalText: 'Plan presented using Bearer secretTokenValue987654321',
            reasoning: 'Checked structure cleanly',
            toolEvents: ['present_trade ✓'],
            toolTrajectory: [
                {
                    name: 'present_trade',
                    args: { symbol: 'BTCUSDT', apiKey: 'should-be-redacted', note: 'sk-liveabcdef1234567890' },
                    ok: true,
                },
            ],
            actions: [],
            planId: 'plan-settled-win',
            playbookId: 'vwap_reclaim',
            snapshot: null,
            truncated: false,
        },
        // 4. Grounded + REJECTED via decline_trade
        {
            v: 1,
            at: '2026-11-27T08:20:00Z',
            kind: 'turn',
            surface: 'chat',
            symbol: 'ETHUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'Should I long ETH chop?',
            finalText: 'Declined — mid-range chop.',
            reasoning: '0.7R is below 1.5R floor',
            toolEvents: ['decline_trade ✓'],
            toolTrajectory: [
                { name: 'decline_trade', args: { symbol: 'ETHUSDT', reason: 'Chop below 1.5R floor' }, ok: true },
            ],
            actions: [],
            planId: null,
            playbookId: null,
            snapshot: null,
            truncated: false,
        },
        // 5. Grounded + SETTLED via signal ledger
        {
            v: 1,
            at: '2026-11-27T08:30:00Z',
            kind: 'turn',
            surface: 'dock',
            symbol: 'SOLUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'SOL setup',
            finalText: 'Short SOL',
            reasoning: '',
            toolEvents: ['emit_signal ✓'],
            toolTrajectory: [{ name: 'emit_signal', args: { symbol: 'SOLUSDT' }, ok: true }],
            actions: [],
            planId: 'sig-sol-1',
            playbookId: null,
            snapshot: null,
            truncated: false,
        },
        // 6. Grounded + SETTLED via closed paper trade
        {
            v: 1,
            at: '2026-11-27T08:40:00Z',
            kind: 'turn',
            surface: 'dock',
            symbol: 'BTCUSDT',
            model: { provider: 'Mock', model: 'mock-1' },
            effort: 'high',
            userText: 'Paper long BTC',
            finalText: 'Paper filled',
            reasoning: '',
            toolEvents: ['paper_order ✓'],
            toolTrajectory: [{ name: 'paper_order', args: { symbol: 'BTCUSDT' }, ok: true }],
            actions: [],
            planId: 'paper-pos-1',
            playbookId: null,
            snapshot: null,
            truncated: false,
        },
    ];

    const journalTrades: LoggedTrade[] = [
        {
            id: 'j-1',
            planId: 'plan-settled-win',
            coin: 'BTCUSDT',
            direction: 'Long',
            outcome: TradeOutcome.WIN,
            netR: 2.25,
        } as unknown as LoggedTrade,
        {
            id: 'j-2',
            planId: 'plan-ungrounded',
            coin: 'BTCUSDT',
            direction: 'Long',
            outcome: TradeOutcome.WIN,
            netR: 1.5,
        } as unknown as LoggedTrade,
    ];

    const signalRows: SignalRow[] = [
        {
            signal: { id: 'sig-sol-1' } as SignalRow['signal'],
            resolution: { status: 'hit_tp1', outcomeR: 1.8 } as unknown as SignalRow['resolution'],
        } as SignalRow,
    ];

    const paperTrades: PaperSettledTrade[] = [
        {
            positionId: 'paper-pos-1',
            rMultiple: -1.0,
        } as PaperSettledTrade,
    ];

    const verified = filterVerifiedTrajectories(turns, { journalTrades, signalRows, paperTrades, declines: [] });
    assert.equal(verified.length, 4, 'must include only grounded settled/rejected turns');
    assert.deepEqual(verified.map(v => v.outcome.kind), ['settled', 'rejected', 'settled', 'settled']);
    assert.equal(verified[0].schema, VERIFIED_TRAJECTORY_SCHEMA);
    assert.equal(verified[0].outcome.realized_r, 2.25);
    assert.equal(verified[1].outcome.realized_r, null);
    assert.match(verified[1].outcome.reason ?? '', /Chop below 1\.5R/);
    assert.equal(verified[2].outcome.realized_r, 1.8);
    assert.equal(verified[3].outcome.realized_r, -1);

    // Redaction checks
    assert.ok(!verified[0].context.userText.includes('sk-testsecret1234567890'));
    assert.ok(!verified[0].decision.finalText.includes('secretTokenValue987654321'));
    assert.equal(verified[0].tool_trajectory[0].args.apiKey, '[REDACTED]');
    assert.equal(verified[0].tool_trajectory[0].args.note, '[REDACTED]');
    assert.equal(redactSensitiveText('token Bearer abcdef1234567890 ok'), 'token [REDACTED] ok');

    // End-to-end captureTurn -> exportVerifiedTrajectoriesJsonl & default exportCorpusJsonl
    const capRes = await captureTurn({
        surface: 'dock',
        symbol: 'BTCUSDT',
        model: { provider: 'Mock', model: 'mock-1' },
        effort: 'high',
        userText: 'Setup check',
        finalText: 'Presented BTC plan',
        reasoning: 'Checked HTF',
        toolEvents: ['present_trade ✓'],
        toolTrajectory: [{ name: 'present_trade', args: { symbol: 'BTCUSDT', apiKey: 'secret-val' }, ok: true }],
        actions: [],
        planId: 'plan-settled-win',
        playbookId: 'vwap_reclaim',
        snapshot: null,
    });
    assert.equal(capRes.ok, true);

    const verifiedExp = await exportVerifiedTrajectoriesJsonl({ journalTrades });
    assert.equal(verifiedExp.ok, true);
    if (verifiedExp.ok) {
        assert.equal(verifiedExp.verifiedCount, 1);
        assert.equal(verifiedExp.totalCount, 1);
        const row = JSON.parse(verifiedExp.jsonl.trim());
        assert.equal(row.schema, VERIFIED_TRAJECTORY_SCHEMA);
        assert.equal(row.tool_trajectory[0].args.apiKey, '[REDACTED]');
        assert.equal(row.outcome.realized_r, 2.25);
    }

    // Default exportCorpusJsonl stays intact
    const rawExp = await exportCorpusJsonl([{ planId: 'plan-settled-win', json: { outcome: 'WIN' } }]);
    assert.equal(rawExp.ok, true);
    if (rawExp.ok) {
        const rawRow = JSON.parse(rawExp.jsonl.trim());
        assert.equal(rawRow.schemaVersion, 1);
        assert.equal(rawRow.labeled, true);
    }
    } finally {
        if (prevStorage) g.localStorage = prevStorage;
        if (prevWindow) g.window = prevWindow;
    }
});
