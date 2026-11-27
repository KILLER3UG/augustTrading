/**
 * v18Wave1CoreAndPrompts — 100% offline unit tests for Wave 1:
 *  - Shared tradingKernel, Truth Precedence, Anti-Sycophancy, 3-Branch Routing,
 *    Adaptive Prompt Profiles (`auto` / `reasoning` / `standard` / `compact_local`),
 *    and token ceilings (<= 1,750 aggregate)
 *  - Pre-flight `<live_tape>` hydration (mark, 15m/1h/4h cached regimes, funding,
 *    UTC session, open paper BTC-beta heat, #D distances) + KV-cache prefix purity
 *  - Tolerant tool-arg coercion (markdown fences, trailing commas, snake<->camel,
 *    numeric strings, scalar->array), canonical arg hashing, typed repair signals
 *    with 1-repair cap, and preserved `parseTextToolCalls` bounce contract
 *  - Turn write-idempotency (`turnIntentKey`) + >=4 read-only round convergence steer
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'wave1-test-trader']]);
const storageShim = {
    get length() { return backing.size; },
    clear: () => { backing.clear(); },
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    getItem: (k: string): string | null => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string): void => { backing.set(k, String(v)); },
    removeItem: (k: string): void => { backing.delete(k); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = storageShim;
if (!g.sessionStorage) g.sessionStorage = storageShim;
if (!g.window) g.window = { localStorage: storageShim, sessionStorage: storageShim, setTimeout, clearTimeout };

import {
    buildChatSurfaceSystemPrompt,
    buildKernelForProfile,
    buildTradeChatSystemPrompt,
    formatRiskConstitutionBlock,
    REASONING_CHANNEL_PROMPT,
    resolveEffectivePromptProfile,
} from '../src/constants/prompts/tradingKernel';
import { CHAT_SURFACE_SYSTEM_PROMPT } from '../src/constants/prompts/chatPrompts';
import { TRADE_CHAT_SYSTEM_PROMPT } from '../src/services/trade/tradeChatContext';
import { deskToolsMandateFor, PAPER_TRADING_PROMPT } from '../src/services/analysis/deskToolShared';
import { estimateTokens } from '../src/utils/tokenEstimate';
import { catalogEntriesToConfigFields, parseModelOverrides } from '../src/services/providers/modelCatalogCore';
import { formatLiveTapeHeader } from '../src/services/trade/scopedRules';
import {
    clearCachedRegimesForTests,
    collectLiveMarketContextForSymbol,
    getCachedRegimesByTf,
    recordCachedRegime,
} from '../src/services/trade/scopedRulesRuntime';
import { clearChatSurfacePromptCache, surfacePromptWith } from '../src/services/trade/chatSurfaceTurn';
import { contentVersion } from '../src/services/learning/SkillFileService';
import { publishPaperMark, resetPaperFrameCache } from '../src/services/trade/futuresStreams';
import { createPaperAccount } from '../src/services/paper/paperCore';
import { getPaperAccount } from '../src/services/paper/PaperBrokerService';
import { setPreference } from '../src/services/infrastructure/PreferencesService';
import {
    canonicalizeArgsForHash,
    coerceToolArguments,
    formatTypedRepairRejection,
    getCoercionAuditLog,
    parseTolerantJsonObject,
    recordCoercionAudit,
    resetCoercionAuditForTests,
    stripJsonMarkdownFences,
} from '../src/services/analysis/toolArgCoercionCore';
import {
    checkTurnIdempotency,
    clearTurnIdempotency,
    recordTurnIdempotency,
} from '../src/services/analysis/turnIdempotencyCore';
import { parseTradeProposal } from '../src/services/trade/proposedTrade';
import { runPresentTrade } from '../src/services/trade/presentTradeTool';
import {
    executeDeskTool,
    parseTextToolCalls,
    runDeskToolLoop,
    type DeskToolCall,
} from '../src/services/analysis/DeskToolsService';
import type { ProviderConfig } from '../src/types/provider';
import type { ChatTurnResult } from '../src/services/providers/GenericProviderService';

const mkConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: 'mock-provider',
    name: 'Mock Provider',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    selectedModel: 'gpt-4o',
    models: ['gpt-4o'],
    isBuiltIn: false,
    isEnabled: true,
    apiFormat: 'chat_completions',
    ...overrides,
});

describe('Wave 1 — tradingKernel, Adaptive Profiles & Token Governance', () => {
    it('shares Truth Precedence, Anti-Sycophancy, 3-Branch Routing, and reasoning-channel pins across Desk and Chat', () => {
        for (const profile of ['reasoning', 'standard', 'compact_local'] as const) {
            const desk = buildTradeChatSystemPrompt(profile);
            const chat = buildChatSurfaceSystemPrompt(profile);
            const kernel = buildKernelForProfile(profile);

            assert.ok(desk.includes(kernel));
            assert.ok(chat.includes(kernel));
            assert.ok(desk.includes(REASONING_CHANNEL_PROMPT));
            assert.ok(chat.includes(REASONING_CHANNEL_PROMPT));
            assert.match(chat, /reasoning channel/);
            assert.match(chat, /<think>\.\.\.<\/think>/);
            assert.match(chat, /Never put scratch work in the visible reply/);
            assert.ok(kernel.includes('<risk_constitution>'));
            assert.ok(kernel.includes('<live_tape>'));
            assert.ok(kernel.includes('<recalled_memory>'));
            assert.ok(kernel.includes('<external_news>'));
            assert.ok(kernel.includes('0R') && kernel.includes('-1R'));
            assert.equal(desk.includes('MEMORY ·'), false);
            assert.equal(desk.includes('[CHART MANIFEST'), false);
            assert.equal(desk.includes('RISK CONSTITUTION'), false);

            const deskTok = estimateTokens(desk);
            const chatTok = estimateTokens(chat);
            const mandateTok = estimateTokens(deskToolsMandateFor());
            const paperTok = estimateTokens(PAPER_TRADING_PROMPT);
            const total = deskTok + chatTok + mandateTok + paperTok;

            assert.ok(deskTok < 700, `profile=${profile} deskTok=${deskTok}`);
            assert.ok(chatTok < 600, `profile=${profile} chatTok=${chatTok}`);
            assert.ok(mandateTok < 450, `profile=${profile} mandateTok=${mandateTok}`);
            assert.ok(paperTok < 160, `profile=${profile} paperTok=${paperTok}`);
            assert.ok(total <= 1750, `profile=${profile} total=${total} > 1750`);
        }

        assert.equal(TRADE_CHAT_SYSTEM_PROMPT, buildTradeChatSystemPrompt('standard'));
        assert.equal(CHAT_SURFACE_SYSTEM_PROMPT, buildChatSurfaceSystemPrompt('standard'));
    });

    it('resolves promptProfile auto-detection and honors explicit manual overrides', () => {
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'o4-mini', contextWindowTokens: 200_000 })), 'reasoning');
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'deepseek/deepseek-r1', contextWindowTokens: 163_840 })), 'reasoning');
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'custom-model', modelOverrides: { 'custom-model': { reasoningEnabled: true } } })), 'reasoning');
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1', providerPreset: 'ollama' })), 'compact_local');
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'llama-small', contextWindowTokens: 32_768 })), 'compact_local');
        assert.equal(resolveEffectivePromptProfile(mkConfig({ selectedModel: 'gpt-4o', contextWindowTokens: 128_000 })), 'standard');

        // Explicit manual override wins over auto
        assert.equal(
            resolveEffectivePromptProfile(mkConfig({
                selectedModel: 'gpt-4o',
                contextWindowTokens: 128_000,
                modelOverrides: { 'gpt-4o': { promptProfile: 'compact_local' } },
            })),
            'compact_local',
        );
        assert.equal(
            resolveEffectivePromptProfile(mkConfig({
                selectedModel: 'o4-mini',
                modelOverrides: { 'o4-mini': { promptProfile: 'standard' } },
            })),
            'standard',
        );
    });

    it('serializes and parses ModelOverride.promptProfile and wraps <risk_constitution>', () => {
        const built = catalogEntriesToConfigFields([
            { id: 'gpt-4o', promptProfile: 'reasoning', contextWindow: 128_000 },
            { id: 'auto-model', promptProfile: 'auto' },
        ]);
        assert.equal(built.modelOverrides?.['gpt-4o']?.promptProfile, 'reasoning');
        assert.equal(built.modelOverrides?.['auto-model'], undefined);

        const parsed = parseModelOverrides({
            'gpt-4o': { promptProfile: 'compact_local', contextWindow: 32_000 },
            'bad-model': { promptProfile: 'nonsense' },
        });
        assert.equal(parsed?.['gpt-4o']?.promptProfile, 'compact_local');
        assert.equal(parsed?.['bad-model'], undefined);

        const rc = formatRiskConstitutionBlock('Max 1% risk per trade.');
        assert.ok(rc.startsWith('<risk_constitution>'));
        assert.ok(rc.includes('TRADER RISK CONSTITUTION'));
        assert.ok(rc.endsWith('</risk_constitution>'));
    });
});

describe('Wave 1 — Pre-Flight <live_tape> Hydration & KV-Cache Purity', () => {
    beforeEach(() => {
        clearCachedRegimesForTests();
        resetPaperFrameCache();
    });

    it('hydrates mark, 15m/1h/4h cached regimes, funding, UTC session, paper BTC-beta heat, and #D distances without mutating static prefix', async () => {
        (g.localStorage as Storage).setItem('last_active_user', 'wave1-test-trader');
        const nowMs = Date.UTC(2026, 10, 27, 15, 0, 0); // NewYork UTC session
        recordCachedRegime('BTCUSDT', 'trend', '15m', nowMs);
        recordCachedRegime('BTCUSDT', 'range', '1h', nowMs);
        recordCachedRegime('BTCUSDT', 'trend', '4h', nowMs);
        assert.deepEqual(getCachedRegimesByTf('BTCUSDT', nowMs), {
            '15m': 'trend',
            '1h': 'range',
            '4h': 'trend',
        });

        // Seed paper account with 1 open ETHUSDT long position (beta=1.15, 1% risk => +1.15% net heat)
        const acct = createPaperAccount({ startingBalanceUsd: 10_000, enabled: true });
        acct.positions = [{
            id: 'p1',
            symbol: 'ETHUSDT',
            side: 'long',
            qty: 1,
            entryPrice: 3000,
            stopLoss: 2900,
            takeProfits: [3300],
            leverage: 3,
            marginUsd: 1000,
            riskUsd: 100,
            entryFeeUsd: 1.5,
            liquidationPrice: 2000,
            openedAt: nowMs - 60_000,
            lastFundingSlotMs: nowMs - 60_000,
            fundingPaidUsd: 0,
            closedQty: 0,
        }];
        await setPreference('paper_account_v1_wave1-test-trader', JSON.stringify(acct));
        await getPaperAccount('wave1-test-trader');
        publishPaperMark('BTCUSDT', 60_500, 0.00012, nowMs);

        const ctx = collectLiveMarketContextForSymbol('BTCUSDT', { interval: '15m', nowMs });
        assert.equal(ctx.markPrice, 60_500);
        assert.equal(ctx.session, 'NewYork');
        assert.equal(ctx.fundingRate, 0.00012);
        assert.equal(ctx.paperHeat?.openCount, 1);
        assert.equal(ctx.paperHeat?.netBetaHeatPct, 1.15);

        const header = formatLiveTapeHeader({
            symbol: ctx.symbol,
            interval: '15m',
            markPrice: ctx.markPrice,
            session: ctx.session,
            regimesByTf: ctx.regimesByTf,
            fundingRate: ctx.fundingRate,
            paperHeat: ctx.paperHeat,
            drawings: [{ shortId: '#D1', label: 'Range High', price: 61_500 }],
        });

        assert.ok(header.startsWith('<live_tape>'));
        assert.ok(header.endsWith('</live_tape>'));
        assert.ok(header.includes('BTCUSDT (15m)'));
        assert.ok(header.includes('mark=60500'));
        assert.ok(header.includes('session=NewYork'));
        assert.ok(header.includes('funding=+0.0120%/8h'));
        assert.ok(header.includes('15m=trend · 1h=range · 4h=trend'));
        assert.ok(header.includes('paper_heat: net +1.1% / 3.0% cap (1 open)') || header.includes('paper_heat: net +1.2% / 3.0% cap (1 open)'));
        assert.ok(header.includes('#D1 Range High 61500 (+1.65% above)'));
        assert.ok(estimateTokens(header) <= 200, `header tokens=${estimateTokens(header)}`);

        // Verify KV-cache static prefix remains byte-identical when <live_tape> rides dynamicTailBlocks
        clearChatSurfacePromptCache();
        const base = surfacePromptWith('MANDATE', 'what the trader asks', { sessionKey: 'w1-kv', memoryEnabled: false, dynamicTailBlocks: [] }).text;
        const hydrated = surfacePromptWith('MANDATE', 'what the trader asks', { sessionKey: 'w1-kv', memoryEnabled: false, dynamicTailBlocks: [header] }).text;
        assert.equal(hydrated.startsWith(base), true);
        assert.equal(contentVersion(hydrated.slice(0, base.length)), contentVersion(base));
    });
});

describe('Wave 1 — Tolerant Schema Coercion, Typed Repair Signals & Idempotency', () => {
    beforeEach(() => {
        resetCoercionAuditForTests();
        clearTurnIdempotency();
    });

    it('strips markdown JSON fences + trailing commas while keeping strings safe', () => {
        const fenced = '```json\n{"symbol": "BTCUSDT", "note": "keep ,} inside", "entry": 98500,}\n```';
        const cleaned = stripJsonMarkdownFences(fenced);
        const parsed = parseTolerantJsonObject(cleaned);
        assert.deepEqual(parsed, { symbol: 'BTCUSDT', note: 'keep ,} inside', entry: 98500 });
    });

    it('coerces present_trade, paper_order, and trade_math aliases, numeric strings, and scalar takeProfits', async () => {
        const ptCoerced = coerceToolArguments('present_trade', {
            symbol: 'BTCUSDT',
            direction: 'long',
            entry: '98500',
            stop_loss: '97000',
            take_profits: 103000,
        });
        assert.equal(ptCoerced.args.direction, 'Long');
        assert.equal(ptCoerced.args.entry, 98500);
        assert.equal(ptCoerced.args.stopLoss, 97000);
        assert.deepEqual(ptCoerced.args.takeProfits, [103000]);
        assert.ok(ptCoerced.coercions.length >= 4);
        recordCoercionAudit('present_trade', ptCoerced.coercions);
        assert.equal(getCoercionAuditLog().length, 1);

        const parsedProposal = parseTradeProposal({
            symbol: 'BTCUSDT',
            direction: 'long',
            entry: '98500',
            stop_loss: '97000',
            take_profits: 103000,
        });
        assert.equal(parsedProposal.error, undefined);
        assert.equal(parsedProposal.proposal?.entry, 98500);
        assert.equal(parsedProposal.proposal?.stopLoss, 97000);
        assert.deepEqual(parsedProposal.proposal?.takeProfits, [103000]);

        const poCoerced = coerceToolArguments('paper_order', {
            action: 'open_limit',
            symbol: 'ETHUSDT',
            side: 'Short',
            entryPrice: '3200',
            stopLoss: '3300',
            takeProfits: '2950',
            riskPct: '1.0',
        });
        assert.equal(poCoerced.args.side, 'short');
        assert.equal(poCoerced.args.entry_price, 3200);
        assert.equal(poCoerced.args.stop_loss, 3300);
        assert.deepEqual(poCoerced.args.take_profits, [2950]);
        assert.equal(poCoerced.args.risk_pct, 1);

        const tmCoerced = coerceToolArguments('trade_math', {
            direction: 'Long',
            entryPrice: '100',
            stopLoss: '95',
            takeProfits: 112,
        });
        assert.equal(tmCoerced.args.entry, 100);
        assert.equal(tmCoerced.args.stop_loss, 95);
        assert.deepEqual(tmCoerced.args.take_profits, [112]);

        // Preserves bare multi-arg text-tool bounce contract
        assert.equal(parseTextToolCalls('<tool_call name="remember">a durable fact</tool_call>').length, 0);
    });

    it('produces key-order-invariant canonical hashes and structured typed repair rejections', async () => {
        const h1 = canonicalizeArgsForHash({ b: 2, a: 1, nested: { z: 9, m: 4 } });
        const h2 = canonicalizeArgsForHash({ nested: { m: 4, z: 9 }, a: 1, b: 2 });
        assert.equal(h1, h2);

        const invTradeMath = await executeDeskTool(
            { id: 'tm-inv', name: 'trade_math', arguments: { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 105, takeProfits: 95 } },
            { allowedTools: 'all', defaultSymbol: 'BTCUSDT' },
        );
        assert.equal(invTradeMath.ok, false);
        const parsedTm = JSON.parse(invTradeMath.content) as Record<string, unknown>;
        assert.equal(parsedTm.kind, 'typed_repair_rejection');
        assert.equal(parsedTm.errorCode, 'inverted_bracket');
        assert.equal(parsedTm.autoRepairRemaining, 1);

        const invPresent = await runPresentTrade(
            {
                call: { id: 'pt-inv', name: 'present_trade', arguments: { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stop_loss: 105, take_profits: 95 } },
                symbol: 'BTCUSDT',
                trades: [],
                drawnPrice: 100,
                crossCanvas: false,
                watchable: false,
                canvasNote: '',
            },
            { setProposal: () => {} },
        );
        assert.equal(invPresent.ok, false);
        const parsedPt = JSON.parse(invPresent.content) as Record<string, unknown>;
        assert.equal(parsedPt.kind, 'typed_repair_rejection');
        assert.equal(parsedPt.errorCode, 'inverted_bracket');
    });

    it('enforces bounded 1-repair cap, turn write-idempotency, and >=4 read-only convergence steer in runDeskToolLoop', async () => {
        // 1. Direct idempotency core check
        recordTurnIdempotency('intent-A', 'paper_order', { b: 2, a: 1 }, { ok: true, content: '{"ok":true,"orderId":"ord-1"}' });
        const hit = checkTurnIdempotency('intent-A', 'paper_order', { a: 1, b: 2 });
        assert.ok(hit !== null && hit.content.includes('ord-1'));
        assert.equal(checkTurnIdempotency('intent-B', 'paper_order', { a: 1, b: 2 }), null);

        // 2. End-to-end runDeskToolLoop: duplicate draw_on_chart under same turnIntentKey executes once
        let drawExecutions = 0;
        const makeTurn = (calls: DeskToolCall[], text = ''): ChatTurnResult => ({
            text,
            reasoning: '',
            toolCalls: calls,
            finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
            truncated: false,
            assistantMessage: calls.length > 0
                ? {
                    role: 'assistant',
                    content: text,
                    tool_calls: calls.map(c => ({
                        id: c.id,
                        type: 'function' as const,
                        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                    })),
                }
                : undefined,
        });

        let step = 0;
        await runDeskToolLoop({
            config: mkConfig(),
            messages: [{ role: 'user', content: 'Draw level' }],
            allowedTools: 'all',
            turnIntentKey: 'turn-idem-1',
            extraToolDefs: [],
            executeExtraTool: async call => {
                if (call.name === 'draw_on_chart') {
                    drawExecutions += 1;
                    return { toolCallId: call.id, name: call.name, ok: true, content: 'Drew #D1 at 60000.' };
                }
                return null;
            },
            sendTurn: async () => {
                step += 1;
                if (step === 1) return makeTurn([{ id: 'c1', name: 'draw_on_chart', arguments: { kind: 'hline', prices: [60000] } }]);
                if (step === 2) return makeTurn([{ id: 'c2', name: 'draw_on_chart', arguments: { prices: [60000], kind: 'hline' } }]);
                return makeTurn([], 'Done.');
            },
        });
        assert.equal(drawExecutions, 1, 'Duplicate draw_on_chart under same turnIntentKey must execute only once');

        // 3. Different turnIntentKey executes normally
        step = 0;
        await runDeskToolLoop({
            config: mkConfig(),
            messages: [{ role: 'user', content: 'Draw level again' }],
            allowedTools: 'all',
            turnIntentKey: 'turn-idem-2',
            extraToolDefs: [],
            executeExtraTool: async call => {
                if (call.name === 'draw_on_chart') {
                    drawExecutions += 1;
                    return { toolCallId: call.id, name: call.name, ok: true, content: 'Drew #D2 at 60000.' };
                }
                return null;
            },
            sendTurn: async () => {
                step += 1;
                if (step === 1) return makeTurn([{ id: 'c3', name: 'draw_on_chart', arguments: { kind: 'hline', prices: [60000] } }]);
                return makeTurn([], 'Done again.');
            },
        });
        assert.equal(drawExecutions, 2);

        // 4. Semantic auto-repair cap: 1st invalid trade_math => autoRepairRemaining: 1, 2nd => autoRepairRemaining: 0
        const observedRepairPayloads: Array<Record<string, unknown>> = [];
        let repairStep = 0;
        await runDeskToolLoop({
            config: mkConfig(),
            messages: [{ role: 'user', content: 'Check math' }],
            allowedTools: 'all',
            turnIntentKey: 'turn-repair-cap',
            onToolEnd: r => {
                try {
                    const p = JSON.parse(r.content) as Record<string, unknown>;
                    if (p.kind === 'typed_repair_rejection') observedRepairPayloads.push(p);
                } catch { /* ignore */ }
            },
            sendTurn: async () => {
                repairStep += 1;
                if (repairStep === 1) {
                    return makeTurn([{ id: 'r1', name: 'trade_math', arguments: { direction: 'Long', entry: 100, stop_loss: 105, take_profits: [95] } }]);
                }
                if (repairStep === 2) {
                    return makeTurn([{ id: 'r2', name: 'trade_math', arguments: { direction: 'Long', entry: 100, stop_loss: 104, take_profits: [96] } }]);
                }
                return makeTurn([], 'Wait — invalid bracket.');
            },
        });
        assert.equal(observedRepairPayloads.length, 2);
        assert.equal(observedRepairPayloads[0].autoRepairRemaining, 1);
        assert.equal(observedRepairPayloads[1].autoRepairRemaining, 0);

        // 5. >=4 consecutive read-only rounds injects CONVERGE steer
        let readStep = 0;
        const loopRes = await runDeskToolLoop({
            config: mkConfig(),
            messages: [{ role: 'user', content: 'Audit BTC' }],
            allowedTools: 'all',
            turnIntentKey: 'turn-converge',
            executeExtraTool: async call => ({
                toolCallId: call.id,
                name: call.name,
                ok: true,
                content: `read-only-result-${call.id}`,
            }),
            sendTurn: async () => {
                readStep += 1;
                if (readStep <= 4) {
                    return makeTurn([{ id: `ro-${readStep}`, name: 'get_price_snapshot', arguments: { symbol: `SYM${readStep}USDT` } }]);
                }
                return makeTurn([], 'Verdict: Wait.');
            },
        });
        const convergeInjected = loopRes.messages.some(
            m => typeof m.content === 'string' && m.content.includes('CONVERGE — you have completed 4 consecutive read-only tool rounds'),
        );
        assert.equal(convergeInjected, true, 'Expected CONVERGE steer after 4 consecutive read-only rounds');

        // Sanity check formatTypedRepairRejection with 0 remaining overrides hint
        const exhausted = JSON.parse(formatTypedRepairRejection({
            tool: 'trade_math',
            errorCode: 'inverted_bracket',
            expectedConstraint: 'stop < entry < tp',
            repairHint: 'retry once',
            autoRepairRemaining: 0,
        })) as Record<string, unknown>;
        assert.equal(exhausted.autoRepairRemaining, 0);
        assert.ok(String(exhausted.repairHint).includes('Auto-repair budget exhausted'));
    });
});
