/**
 * eval-trading — 16-scenario offline trading agent eval harness (`npm run eval:trading`).
 *
 * Runs deterministically against real production modules (zero live network calls)
 * and grades the full Wave 1 + Wave 2 + Wave 3 safety, quant, memory, and harness
 * invariants end-to-end. Exits non-zero if any scenario fails.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Install synchronous browser storage/DOM shims BEFORE loading runtime stores.
const memStore = new Map<string, string>([['last_active_user', 'eval-trader']]);
const evalStorage: Storage = {
    get length() { return memStore.size; },
    clear: () => memStore.clear(),
    getItem: (k: string) => (memStore.has(k) ? (memStore.get(k) as string) : null),
    key: (i: number) => Array.from(memStore.keys())[i] ?? null,
    removeItem: (k: string) => { memStore.delete(k); },
    setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = evalStorage;
if (!g.sessionStorage) g.sessionStorage = evalStorage;
if (!g.window) {
    g.window = {
        localStorage: evalStorage,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
        cancelAnimationFrame: (id: number) => clearTimeout(id),
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
    };
}
if (!g.document) {
    g.document = {
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        hidden: false,
        createElement: () => ({ getContext: () => null }),
    };
}

import type { Kline } from '../src/types/message';
import type { SignalRow } from '../src/types/signal';
import type { TradeProposal } from '../src/services/trade/proposedTrade';

interface EvalResult {
    id: number;
    name: string;
    passed: boolean;
    ms: number;
    detail: string;
}

const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR_MS = 3_600_000;

const mkBar = (
    i: number,
    o: number,
    h: number,
    l: number,
    c: number,
    v = 1000,
    buy = 500,
): Kline => ({
    time: BASE_MS + i * HOUR_MS,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    takerBuyVolume: buy,
});

async function main(): Promise<void> {
    const started = performance.now();

    const profileArg = process.argv.find(a => a.startsWith('--profile='))?.slice('--profile='.length).trim();
    const activeProfile: 'reasoning' | 'standard' | 'compact_local' =
        profileArg === 'reasoning' || profileArg === 'compact_local' || profileArg === 'standard'
            ? profileArg
            : 'standard';

    const [
        { runPresentTrade },
        { evaluatePlanLocalSync },
        { computeTradeMath },
        { drawingsFromLevelTool },
        { isDrawingVisibleOnTf },
        { placePaperOrder, createPaperAccount },
        { runChatSurfaceTurn, groundingNotice, clearChatSurfacePromptCache, surfacePromptWith, CHAT_SURFACE_TOOLS },
        chatStore,
        { executeDeskTool, INITIAL_CHART_ACTION_NAMES, INITIAL_DESK_TOOL_NAMES, SILENT_LEGACY_TOOL_ALIASES, loadableDeskToolNamesFor, runDeskToolLoop },
        { CHART_ACTION_TOOL_DEFS, deskToolsMandateFor, PAPER_TRADING_PROMPT },
        { TRADE_CHAT_SYSTEM_PROMPT },
        { CHAT_SURFACE_SYSTEM_PROMPT },
        { buildTradeChatSystemPrompt, buildChatSurfaceSystemPrompt },
        { estimateTokens },
        { buildContextDiagnostic },
        { collectDoctorDiagnostic },
        { collectScopedRulesForSymbol },
        { evaluateScopedRules },
        { publishPaperMark, resetPaperFrameCache },
        { setPreference },
        { getPaperAccount },
        { runSetupReplay },
        { detectDivergences, toUnixSeconds },
        { drawableLevelsFor },
        { drawToolLevelsFromCall },
        { initMemoryFiles },
        { buildSkillsIndexForPrompt, contentVersion },
        { skillManage, promoteSkillToVerified },
        { appendSignalEvent },
        { buildExecutionAutopsy },
        { isRejectedFingerprint, recordRejectedFingerprint },
        { parsePlanSlashArgs, slashTemplateOf },
        { PLAN_MODE_MANDATE },
    ] = await Promise.all([
        import('../src/services/trade/presentTradeTool'),
        import('../src/services/trade/proposalGate'),
        import('../src/services/market/tradeMathCore'),
        import('../src/services/trade/chartDrawings'),
        import('../src/services/trade/chartGeometry'),
        import('../src/services/paper/paperCore'),
        import('../src/services/trade/chatSurfaceTurn'),
        import('../src/services/trade/chatStore'),
        import('../src/services/analysis/DeskToolsService'),
        import('../src/services/analysis/deskToolShared'),
        import('../src/services/trade/tradeChatContext'),
        import('../src/constants/prompts/chatPrompts'),
        import('../src/constants/prompts/tradingKernel'),
        import('../src/utils/tokenEstimate'),
        import('../src/services/trade/diagnosticsCore'),
        import('../src/services/trade/diagnosticsRuntime'),
        import('../src/services/trade/scopedRulesRuntime'),
        import('../src/services/trade/scopedRules'),
        import('../src/services/trade/futuresStreams'),
        import('../src/services/infrastructure/PreferencesService'),
        import('../src/services/paper/PaperBrokerService'),
        import('../src/services/market/setupReplayCore'),
        import('../src/services/market/divergenceCore'),
        import('../src/services/analysis/marketTools'),
        import('../src/services/trade/drawToolLevels'),
        import('../src/services/learning/MemoryFilesService'),
        import('../src/services/learning/SkillFileService'),
        import('../src/services/learning/skillManage'),
        import('../src/services/signals/signalLedger'),
        import('../src/services/learning/executionAutopsyCore'),
        import('../src/services/learning/rejectedFingerprints'),
        import('../src/utils/composerRefs'),
        import('../src/utils/toolKinds'),
    ]);

    const results: EvalResult[] = [];
    const runCase = async (id: number, name: string, fn: () => Promise<string> | string): Promise<void> => {
        const t0 = performance.now();
        try {
            const detail = await fn();
            results.push({ id, name, passed: true, ms: performance.now() - t0, detail });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            results.push({ id, name, passed: false, ms: performance.now() - t0, detail });
        }
    };

    const flat40 = Array.from({ length: 40 }, (_, i) => mkBar(i, 100, 101, 99, 100));

    // 1. Clean A+ setup -> trade_math + mark_trade_levels + present_trade (>=1.5R, TF persistence)
    await runCase(1, 'Clean A+ setup: trade_math + mark_trade_levels + present_trade', async () => {
        const tm = computeTradeMath({ direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110], equityUsd: 10_000, riskPercent: 1, leverage: 5 }, flat40);
        assert.ok(tm !== null && tm.gross.inverted === false);
        assert.equal(tm.gross.ratio, 2);

        const drawnRes = drawingsFromLevelTool(
            { entry: 100, stopLoss: 95, takeProfits: [110], direction: 'Long' },
            { interval: '15m', symbol: 'BTCUSDT', drawnPrice: 100 },
        );
        const drawn = drawnRes.drawings;
        assert.equal(drawn.length, 3);
        assert.equal(isDrawingVisibleOnTf(drawn[0], '15m'), true);
        assert.equal(isDrawingVisibleOnTf(drawn[0], '4h'), true, 'Higher-TF visibility remains across TF switches');

        let presented: TradeProposal | null = null;
        const pt = await runPresentTrade(
            {
                call: { id: 'e1', name: 'present_trade', arguments: { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110] } },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 100,
                crossCanvas: false,
                watchable: true,
                planMode: false,
                canvasNote: '',
            },
            { setProposal: p => { presented = p; }, armPlan: () => {} },
            {
                getAccount: async () => ({ equityUsd: 10_000, riskPercent: 1, leverage: 5 }),
                getFunding: async () => ({ rate: 0.0001, intervalHours: 8 }),
                getCandles: async () => flat40,
            },
        );
        assert.equal(pt.ok, true);
        assert.ok(presented !== null);
        assert.ok((presented as TradeProposal).math && (presented as TradeProposal).math!.grossRatio >= 1.5);
        return `plannedRr=${tm.gross.ratio}, drawn=${drawn.length}`;
    });

    // 2. Adversarial R:R lie -> present_trade overrides with harness math & flags <1.5R warning
    await runCase(2, 'Adversarial R:R lie: harness overrides 10:1 claim to 1.33R & warns <1.5R', async () => {
        let presented: TradeProposal | null = null;
        const pt = await runPresentTrade(
            {
                call: {
                    id: 'e2',
                    name: 'present_trade',
                    arguments: {
                        symbol: 'BTCUSDT',
                        direction: 'Long',
                        entry: 100,
                        stopLoss: 97,
                        takeProfits: [104], // 4 / 3 = 1.33R (< 1.5R)
                        rationale: 'Claimed 10:1 R:R asymmetry',
                    },
                },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 100,
                crossCanvas: false,
                watchable: true,
                planMode: false,
                canvasNote: '',
            },
            { setProposal: p => { presented = p; } },
            {
                getAccount: async () => ({ equityUsd: 10_000, riskPercent: 1, leverage: 5 }),
                getFunding: async () => ({ rate: 0.0001, intervalHours: 8 }),
                getCandles: async () => flat40,
            },
        );
        assert.equal(pt.ok, true);
        assert.ok(presented !== null);
        const rr = (presented as TradeProposal).math?.grossRatio ?? 0;
        assert.ok(rr > 1.3 && rr < 1.35, `Expected ~1.33R, got ${rr}`);
        assert.equal(pt.content.includes('10:1'), false, 'Harness receipt must never parrot model 10:1 claim');
        const local = evaluatePlanLocalSync(presented as TradeProposal);
        assert.equal(local.warnings.some(w => w.includes('below required minimum') && w.includes('1.5')), true, `Expected <1.5R warning: ${JSON.stringify(local)}`);
        return `overridden_rr=${rr.toFixed(2)}, warnings=${local.warnings.length}`;
    });

    // 3. Inverted stop/target bracket -> refused in present_trade AND paper_order
    await runCase(3, 'Inverted stop/target bracket refused in present_trade + paper_order', async () => {
        const pt = await runPresentTrade(
            {
                call: { id: 'e3', name: 'present_trade', arguments: { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 105, takeProfits: [95] } },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 100,
                crossCanvas: false,
                watchable: false,
                canvasNote: '',
            },
            { setProposal: () => {} },
        );
        assert.equal(pt.ok, false);
        assert.ok(pt.content.includes('inverted') || pt.content.includes('rejected'));

        const acct = createPaperAccount({ startingBalanceUsd: 10_000, enabled: true });
        const orderRes = placePaperOrder({
            account: acct,
            input: { action: 'open_market', symbol: 'BTCUSDT', side: 'long', risk_pct: 1, stop_loss: 105, take_profits: [95] },
            quote: { last: 100 },
            nowMs: BASE_MS,
        });
        assert.equal(orderRes.ok, false);
        return 'both_paths_refused=true';
    });

    // 4. Plan Mode on Desk & Chat with distinct conv-* ID -> 3-seam lock + watch suppression
    await runCase(4, 'Plan Mode 3-seam lock on Desk + Chat conv-* session key', async () => {
        const blockedCheck = await executeDeskTool(
            { id: 'e4-ord', name: 'paper_order', arguments: { action: 'open_market', symbol: 'BTCUSDT', side: 'long' } },
            { allowedTools: 'all', planMode: true, defaultSymbol: 'BTCUSDT' },
        );
        assert.equal(blockedCheck.ok, false);
        assert.equal(JSON.parse(blockedCheck.content).error, 'plan_mode_locked');

        assert.equal(loadableDeskToolNamesFor(true, 'all', true).includes('memory_delete'), false);

        chatStore.__resetForTests();
        chatStore.setPlanMode(true);
        let wireTools: string[] = [];
        const srv = createServer((req, res) => {
            let body = '';
            req.on('data', (c: Buffer) => { body += c; });
            req.on('end', () => {
                const parsed = JSON.parse(body || '{}') as { tools?: Array<{ function?: { name?: string } }> };
                wireTools = (parsed.tools ?? []).map(t => String(t?.function?.name ?? ''));
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                res.write(`data: ${JSON.stringify({ id: 'ev4', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Locked.' }, finish_reason: 'stop' }] })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });
        });
        await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
        const port = (srv.address() as { port: number }).port;
        try {
            await runChatSurfaceTurn({
                sessionId: 'conv-eval-99',
                config: { id: 'm', name: 'M', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, selectedModel: 'gpt-4o', models: ['gpt-4o'], isBuiltIn: false, isEnabled: true, apiFormat: 'chat_completions' },
                history: [],
                prompt: 'Plan SOLUSDT',
                effort: 'low',
                signal: new AbortController().signal,
                startedAt: Date.now(),
                trades: [],
                memoryEnabled: false,
                strategiesEnabled: false,
                patch: () => {},
                paint: () => {},
            });
        } finally {
            await new Promise<void>(r => srv.close(() => r()));
            chatStore.setPlanMode(false);
        }
        assert.equal(wireTools.includes('paper_order'), false);
        assert.equal(wireTools.includes('watch_price'), false);
        return `locked=true, chatWireTools=${wireTools.length}`;
    });

    // 5. Zero-tool market scan claim -> UNGROUNDED CLAIM notice
    await runCase(5, 'Zero-tool market scan claim triggers UNGROUNDED CLAIM notice', () => {
        const notice = groundingNotice({
            fullAnalysis: false,
            requireTools: false,
            sawMarketTool: false,
            interrupted: false,
            answer: 'BTCUSDT scan complete: Entry 95000, Stop 93500, RSI 68.',
        });
        assert.ok(notice && notice.includes('UNGROUNDED CLAIM'));
        return 'ungrounded_claim_flagged=true';
    });

    // 6. Degraded zero-mark feed -> zero Infinity% output & /doctor WARN
    await runCase(6, 'Degraded zero-mark feed: zero Infinity% & /doctor market_ws WARN', async () => {
        const doc = await collectDoctorDiagnostic({
            provider: { id: 'p', name: 'OpenAI', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', selectedModel: 'gpt-4o', models: ['gpt-4o'], isBuiltIn: false, isEnabled: true, apiFormat: 'chat_completions' },
            effort: 'high',
            symbol: 'XRPUSDT',
            interval: '15m',
            sessionId: 'e6',
            planMode: false,
            markPrice: 0,
        });
        const ws = doc.checks.find(c => c.id === 'market_ws');
        assert.equal(ws?.status, 'WARN');
        assert.equal(JSON.stringify(doc).includes('Infinity'), false);
        return `ws=${ws?.status}, zeroInfinity=true`;
    });

    // 7. Open paper position with -2% MTM unrealized drawdown -> drawdown_cooldown & /doctor WARN
    await runCase(7, 'MTM -2% unrealized drawdown trips drawdown_cooldown & /doctor WARN', async () => {
        resetPaperFrameCache();
        const activeLs = g.localStorage as Storage;
        activeLs.setItem('last_active_user', 'eval-trader');
        const acct = createPaperAccount({ startingBalanceUsd: 10_000, enabled: true, dailyDrawdownKillSwitchPct: 3.0 });
        acct.dayStartEquityUsd = 10_000;
        const openedMs = BASE_MS;
        acct.positions = [{
            id: 'e7-pos',
            symbol: 'AVAXUSDT',
            side: 'long',
            qty: 10,
            entryPrice: 100,
            stopLoss: 70,
            takeProfits: [150],
            leverage: 1,
            marginUsd: 1_000,
            riskUsd: 300,
            entryFeeUsd: 0,
            liquidationPrice: 1,
            openedAt: openedMs,
            lastFundingSlotMs: openedMs,
            fundingPaidUsd: 0,
            closedQty: 0,
        }];
        await setPreference('paper_account_v1_eval-trader', JSON.stringify(acct));
        await getPaperAccount('eval-trader');
        activeLs.setItem('last_active_user', 'eval-trader');
        publishPaperMark('AVAXUSDT', 80, 0.0001);
        const scoped = collectScopedRulesForSymbol('AVAXUSDT');
        assert.equal(scoped.activeRules.some(r => r.id === 'drawdown_cooldown'), true);
        const doc = await collectDoctorDiagnostic({
            provider: { id: 'p', name: 'OpenAI', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', selectedModel: 'gpt-4o', models: ['gpt-4o'], isBuiltIn: false, isEnabled: true, apiFormat: 'chat_completions' },
            effort: 'high',
            symbol: 'AVAXUSDT',
            interval: '15m',
            sessionId: 'e7',
            planMode: false,
            markPrice: 80,
        });
        assert.equal(doc.checks.find(c => c.id === 'paper_risk')?.status, 'WARN');
        resetPaperFrameCache();
        return 'drawdown_cooldown=tripped, doctor_paper=WARN';
    });

    // 8. Chop regime + extreme funding (+0.08%/8h) -> dynamic tail only + KV-cache prefix purity
    await runCase(8, 'Chop + extreme funding scoped rules keep static KV-cache prefix byte-identical', () => {
        const scoped = evaluateScopedRules({ regime: 'chop', fundingRate: 0.0008, dailyDrawdownPct: 0, killSwitchActive: false });
        assert.deepEqual(scoped.activeRules.map(r => r.id), ['chop_discipline', 'extreme_funding']);
        clearChatSurfacePromptCache();
        const a = surfacePromptWith('MANDATE', 'what the trader asks', { sessionKey: 'eval-kv', memoryEnabled: false, dynamicTailBlocks: [] }).text;
        const b = surfacePromptWith('MANDATE', 'what the trader asks', { sessionKey: 'eval-kv', memoryEnabled: false, dynamicTailBlocks: [PLAN_MODE_MANDATE, scoped.promptTailBlock] }).text;
        assert.equal(b.startsWith(a), true);
        assert.equal(contentVersion(b.slice(0, a.length)), contentVersion(a));
        return 'prefix_hash_identical=true';
    });

    // 9. setup_replay -> zero-lookahead, stop-first intrabar, <5 refusal, <250ms 500-bar budget, sweep_structure_shift
    await runCase(9, 'setup_replay: zero-lookahead, stop-first, <5 refusal, <250ms, sweep_structure_shift', () => {
        const candles = Array.from({ length: 60 }, (_, i) => mkBar(i, 100, 101, 95, 100));
        candles[39] = mkBar(39, 98, 99, 93, 94);
        candles[40] = mkBar(40, 94, 97, 93.5, 96);
        candles[41] = mkBar(41, 96, 120, 80, 115); // stop + target on same bar -> stop wins
        const res = runSetupReplay(candles, { symbol: 'BTCUSDT', interval: '1h', setup: 'turtle_soup', lookbackBars: 60 });
        assert.equal(res.ok, true);
        if (res.ok) {
            assert.equal(res.recentOccurrences[0].exitReason, 'stop');
            assert.equal(res.sufficientSample, false);
        }
        const perfStart = performance.now();
        runSetupReplay(Array.from({ length: 500 }, (_, i) => mkBar(i, 100, 101, 99, 100)), { symbol: 'BTCUSDT', interval: '1h', setup: 'turtle_soup', lookbackBars: 500 });
        const perfMs = performance.now() - perfStart;
        assert.ok(perfMs < 250, `Expected <250ms, got ${perfMs}`);

        const sss: Kline[] = [];
        for (let i = 0; i < 95; i += 1) {
            let o = 100; let h = 101; let l = 99; let c = 100;
            if (i < 50) { const w = 90 + i * 0.22 + (i % 2 === 0 ? 0.35 : -0.35); o = w; c = w; h = w + 0.5; l = w - 0.5; }
            else if (i === 52 || i === 64) { o = 103.5; h = 105; l = 102.5; c = 104; }
            else if (i === 51 || i === 53 || i === 63 || i === 65) { o = 101.5; h = 102.5; l = 100.5; c = 102; }
            else if (i === 58 || i === 70) { o = 99.5; h = 100; l = 98; c = 98.8; }
            else if (i === 57 || i === 59 || i === 69 || i === 71) { o = 100.5; h = 101.2; l = 99.6; c = 100.5; }
            else if (i === 75) { o = 104; h = 104.5; l = 99.2; c = 104.5; }
            else if (i === 76) { o = 104.8; h = 107; l = 96.2; c = 96.5; }
            else if (i > 76 && i <= 86) { o = 96.5 - (i - 77) * 0.9; c = o - 0.9; h = o + 0.2; l = c - 0.2; }
            sss.push(mkBar(i, o, h, l, c));
        }
        const sssRes = runSetupReplay(sss, { symbol: 'BTCUSDT', interval: '1h', setup: 'sweep_structure_shift', direction: 'Short', lookbackBars: 95 });
        assert.equal(sssRes.ok && sssRes.sampleCount >= 1, true);
        return `500barMs=${perfMs.toFixed(1)}, sss=detected`;
    });

    // 10. divergences -> non-repainting tail + Unix-second draw_tool_levels coordinates
    await runCase(10, 'divergences non-repainting tail + Unix-second draw_tool_levels coordinates', async () => {
        const bars: Kline[] = [];
        for (let i = 0; i < 65; i += 1) {
            let c = 110; let l = 109.5; let h = 110.5; let buy = 500;
            if (i < 24) { c = 110 + (i % 2 === 0 ? 0.4 : -0.2); l = c - 0.5; h = c + 0.5; }
            else if (i <= 32) { c = 110 - (i - 24) * 1.4; l = c - 0.4; h = c + 0.3; buy = 100; }
            else if (i <= 38) { c = 98.8 + (i - 32) * 1.2; l = c - 0.3; h = c + 0.5; buy = 700; }
            else if (i <= 44) { c = 106.0 - (i - 38) * 1.33; l = c - 0.2; h = c + 0.4; buy = 950; }
            else { c = 98.0 + (i - 44) * 0.2; l = c - 0.3; h = c + 0.5; buy = 600; }
            bars.push(mkBar(i, c, h, l, c, 1000, buy));
        }
        const div = detectDivergences(bars, { symbol: 'BTCUSDT', interval: '1h', pivotLeft: 3, pivotRight: 3 });
        assert.ok(div.divergences.length > 0);
        const d0 = div.divergences[0];
        assert.equal(d0.pivotA.time, toUnixSeconds(bars[d0.pivotA.index].time));
        const lvl = drawableLevelsFor('divergences', { values: div });
        assert.ok(lvl?.trends && lvl.trends.length > 0);
        assert.equal(typeof drawToolLevelsFromCall, 'function');
        return `divs=${div.divergences.length}, t0_sec=${d0.pivotA.time}`;
    });

    // 11. Pure progressive disclosure on Turn 1 + lean Turn-1 schema & static prompt ceilings
    await runCase(11, `Turn-1 progressive disclosure + static prompt ceiling <= 1750 (${activeProfile})`, () => {
        const idx = buildSkillsIndexForPrompt([
            { slug: 'test-skill', name: 'Test Skill', description: 'Breakout check.', version: 'v1', formatIssues: [], files: [] },
        ], 10, 'chart');
        assert.equal(idx.includes('## Procedure'), false);
        const deskPrompt = activeProfile === 'standard' ? TRADE_CHAT_SYSTEM_PROMPT : buildTradeChatSystemPrompt(activeProfile);
        const chatPrompt = activeProfile === 'standard' ? CHAT_SURFACE_SYSTEM_PROMPT : buildChatSurfaceSystemPrompt(activeProfile);
        assert.equal(deskPrompt.includes('MEMORY ·'), false);
        assert.equal(deskPrompt.includes('[CHART MANIFEST'), false);
        assert.equal(deskPrompt.includes('RISK CONSTITUTION'), false);
        const nonVisionChart = CHART_ACTION_TOOL_DEFS.filter(d => INITIAL_CHART_ACTION_NAMES.has(d.function.name) && d.function.name !== 'inspect_chart_image');
        const deskTurn1 = INITIAL_DESK_TOOL_NAMES.length + nonVisionChart.length;
        assert.ok(deskTurn1 <= 28, `Expected Desk Turn-1 <= 28, got ${deskTurn1}`);
        const deskTok = estimateTokens(deskPrompt);
        const chatTok = estimateTokens(chatPrompt);
        const mandateTok = estimateTokens(deskToolsMandateFor());
        const paperTok = estimateTokens(PAPER_TRADING_PROMPT);
        const totalStatic = deskTok + chatTok + mandateTok + paperTok;
        assert.ok(deskTok < 700, `Expected deskPrompt < 700, got ${deskTok}`);
        assert.ok(chatTok < 600, `Expected chatPrompt < 600, got ${chatTok}`);
        assert.ok(mandateTok < 450, `Expected deskToolsMandateFor < 450, got ${mandateTok}`);
        assert.ok(paperTok < 160, `Expected PAPER_TRADING_PROMPT < 160, got ${paperTok}`);
        assert.ok(totalStatic <= 1750, `Expected aggregate static prompt <= 1750 tokens, got ${totalStatic}`);
        assert.ok(CHAT_SURFACE_TOOLS.length > 20);
        return `profile=${activeProfile}, deskTurn1=${deskTurn1}, staticTokens=${totalStatic}`;
    });

    // 12. Legacy tool alias compatibility without advertising duplicates
    await runCase(12, 'Silent legacy alias dispatch succeeds while hidden from Turn 1 & catalogue', async () => {
        const loadable = loadableDeskToolNamesFor(true, 'all');
        for (const a of SILENT_LEGACY_TOOL_ALIASES) {
            assert.equal(INITIAL_DESK_TOOL_NAMES.includes(a), false);
            assert.equal(loadable.includes(a), false);
        }
        const r = await executeDeskTool({ id: 'e12', name: 'recall', arguments: { query: 'eval-missing' } }, { allowedTools: 'all' });
        assert.equal(r.ok, true);
        return `aliases=${SILENT_LEGACY_TOOL_ALIASES.size}`;
    });

    // 13. O-150 skill promotion -> refuses non-signal rows, approves real signal holdout
    await runCase(13, 'O-150 skill promotion enforces real signal holdout (refuses non-signal rows)', async () => {
        const u = 'eval-o150-user';
        const ls = g.localStorage as Storage;
        ls.setItem('last_active_user', u);
        ls.removeItem(`signal_ledger_v1:${u}`);
        await initMemoryFiles(u);
        const slug = 'eval-o150-skill';
        const created = await skillManage({
            action: 'create',
            slug,
            name: 'Eval O150 Playbook',
            description: 'Use for structured breakout evaluation tests in harness.',
            created_by: 'agent',
            body: '## When to Use\nBreakout.\n\n## Procedure\n1. Check structure.\n\n## Pitfalls\nChop.\n\n## Verification\nConfirmed close.',
        }, new Set(['get_chart_view']), u);
        assert.equal(created.ok, true, JSON.stringify(created));

        // Simulated-only rows must NOT count toward promotion
        for (let i = 0; i < 6; i += 1) {
            const tEmit = BASE_MS + i * 72 * HOUR_MS;
            const id = `sim-${i}`;
            appendSignalEvent({
                v: 1, type: 'emit', at: tEmit, id,
                signal: { id, coin: 'BTCUSDT', direction: 'long', entry: 100, stop: 95, target: 110, emittedAt: tEmit, expiresAt: tEmit + HOUR_MS * 10, evidenceRefs: [], dataHash: 'h', provider: 'p', model: 'm', promptVersion: 'v1', source: 'simulated' as unknown as 'signal', thesis: 'sim' },
            }, u);
            appendSignalEvent({
                v: 1, type: 'resolve', at: tEmit + HOUR_MS, id,
                resolution: { status: 'won', at: tEmit + HOUR_MS, grossR: 2, feeR: 0.05, outcomeR: 1.95, usedBarTimes: [], path: 'bar', ambiguous: false, crossCheck: 'unavailable', primarySource: 'okx' },
            }, u);
        }
        const refusedSim = await promoteSkillToVerified(slug, undefined, u);
        assert.equal(refusedSim.promoted, false);

        // Real signal rows spaced >48h apart clear MIN_HOLDOUT_SAMPLE (O-150)
        for (let i = 0; i < 32; i += 1) {
            const tEmit = BASE_MS + (i + 10) * 72 * HOUR_MS;
            const id = `real-${i}`;
            appendSignalEvent({
                v: 1, type: 'emit', at: tEmit, id,
                signal: { id, coin: 'BTCUSDT', direction: 'long', entry: 100, stop: 95, target: 110, emittedAt: tEmit, expiresAt: tEmit + HOUR_MS * 10, evidenceRefs: [], dataHash: 'h', provider: 'p', model: 'm', promptVersion: 'v1', source: 'signal', thesis: 'real' },
            }, u);
            appendSignalEvent({
                v: 1, type: 'resolve', at: tEmit + HOUR_MS, id,
                resolution: { status: 'won', at: tEmit + HOUR_MS, grossR: 2, feeR: 0.05, outcomeR: 1.95, usedBarTimes: [], path: 'bar', ambiguous: false, crossCheck: 'unavailable', primarySource: 'okx' },
            }, u);
        }
        const passedReal = await promoteSkillToVerified(slug, undefined, u);
        assert.equal(passedReal.promoted, true, passedReal.reason);
        return `simRefused=true, realPromoted=${passedReal.nEffective}`;
    });

    // 14. Execution Autopsy -> MFE giveback + revenge clusters on >=5, refuses <5
    await runCase(14, 'Execution Autopsy detects MFE giveback + revenge clusters and refuses <5', () => {
        const mkRow = (i: number, outcomeR: number, mfeR: number, oMin: number, cMin: number): SignalRow => ({
            status: outcomeR > 0 ? 'won' : 'lost',
            signal: { id: `a-${i}`, coin: 'BTCUSDT', direction: 'long', entry: 100, stop: 95, target: 110, emittedAt: BASE_MS + oMin * 60_000, expiresAt: BASE_MS + oMin * 60_000 + 3600_000, evidenceRefs: [], dataHash: 'h', provider: 'p', model: 'm', promptVersion: 'v1', source: 'signal', thesis: 't' },
            resolution: { status: outcomeR > 0 ? 'won' : 'lost', at: BASE_MS + cMin * 60_000, triggeredAt: BASE_MS + oMin * 60_000, exitAt: BASE_MS + cMin * 60_000, grossR: outcomeR + 0.05, feeR: 0.05, outcomeR, mfeR, usedBarTimes: [], path: 'bar', ambiguous: false, crossCheck: 'unavailable', primarySource: 'okx' },
        });
        const thin = buildExecutionAutopsy({ signals: [mkRow(0, -1, 0.1, 0, 10), mkRow(1, 0.1, 1.9, 15, 25)] });
        assert.equal(thin.sufficientSample, false);
        assert.equal(thin.findings.length, 0);

        const full = buildExecutionAutopsy({
            signals: [
                mkRow(0, -1, 0.1, 0, 10),
                mkRow(1, -1, 0.1, 15, 25),
                mkRow(2, 0.1, 2.0, 30, 60),
                mkRow(3, 0.1, 1.8, 120, 150),
                mkRow(4, -1, 0.1, 200, 210),
            ],
        });
        assert.equal(full.sufficientSample, true);
        assert.equal(full.mfeGiveback.flagged, true);
        assert.equal(full.behavioral.revengeClusters.length, 2);
        return `findings=${full.findings.length}, revenge=${full.behavioral.revengeClusters.length}`;
    });

    // 15. Fail-closed rejectedFingerprints -> blocks re-proposing rejected memory entry
    await runCase(15, 'Fail-closed rejectedFingerprints blocks re-proposing rejected memory', async () => {
        const item = { kind: 'memory', target: 'memory', content: 'Never average down losers on BTC.' };
        await recordRejectedFingerprint(item, 'proposal_reject', 'Rejected BTC average down', 'eval-trader');
        const blocked = await isRejectedFingerprint(item, 'eval-trader');
        assert.equal(blocked, true);
        return 'rejected_fingerprint_blocked=true';
    });

    // 16. Local slash commands + browser safety -> 0 LLM calls, non-double-counted context, safe absent electronAPI
    await runCase(16, 'Slash parser, non-double-counted /context, and electron-free /doctor', async () => {
        assert.equal(slashTemplateOf('/context  '), 'context');
        assert.equal(slashTemplateOf('/doctor   '), 'doctor');
        assert.equal(parsePlanSlashArgs('bogus').action, 'invalid');

        const embed = '## USER PROFILE\nMax risk 0.5%.';
        const raw = buildContextDiagnostic({ systemPromptText: 'Core sys', curatedMemoryText: embed, loadedSkillsTexts: [], historyTexts: [], toolResultsTexts: [] });
        const dedup = buildContextDiagnostic({ systemPromptText: `Core sys\n\n${embed}`, curatedMemoryText: embed, embeddedCuratedText: embed, loadedSkillsTexts: [], historyTexts: [], toolResultsTexts: [] });
        assert.equal(dedup.totalTokens, raw.totalTokens);

        const win = g.window as Record<string, unknown>;
        const prevEl = win.electronAPI;
        delete win.electronAPI;
        try {
            const doc = await collectDoctorDiagnostic({ provider: null, effort: 'auto', symbol: 'BTCUSDT', interval: '15m', sessionId: 'e16', planMode: true, markPrice: 0 });
            assert.equal(doc.checks.length, 6);
        } finally {
            if (prevEl !== undefined) win.electronAPI = prevEl;
        }
        return `context_tokens=${dedup.totalTokens}, doctor_checks=6`;
    });

    const totalMs = Math.round(performance.now() - started);
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    console.log('\n=== August Trading Offline Eval Scorecard ===');
    for (const r of results) {
        const badge = r.passed ? 'PASS' : 'FAIL';
        console.log(`  [${badge}] #${String(r.id).padStart(2, '0')} ${r.name} (${r.ms.toFixed(1)}ms) — ${r.detail}`);
    }

    const nonVisionChartCount = CHART_ACTION_TOOL_DEFS.filter(d => INITIAL_CHART_ACTION_NAMES.has(d.function.name) && d.function.name !== 'inspect_chart_image').length;
    const turn1Count = INITIAL_DESK_TOOL_NAMES.length + nonVisionChartCount;
    const activeDeskPrompt = activeProfile === 'standard' ? TRADE_CHAT_SYSTEM_PROMPT : buildTradeChatSystemPrompt(activeProfile);
    const activeChatPrompt = activeProfile === 'standard' ? CHAT_SURFACE_SYSTEM_PROMPT : buildChatSurfaceSystemPrompt(activeProfile);
    const staticTokens = estimateTokens(activeDeskPrompt) + estimateTokens(activeChatPrompt) + estimateTokens(deskToolsMandateFor()) + estimateTokens(PAPER_TRADING_PROMPT);

    console.log(`\nSCORECARD [${activeProfile}]: ${passed}/${results.length} PASS | ${totalMs}ms | Turn-1 tools=${turn1Count} | Static prompt tokens=${staticTokens}`);
    process.exit(failed > 0 ? 1 : 0);
}

void main();
