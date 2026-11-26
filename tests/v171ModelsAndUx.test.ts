/**
 * v171ModelsAndUx — 100% offline unit test suite for v1.7.1:
 *   1. `modelCatalogCore` (fetch-all catalog normalization across OpenRouter,
 *      OpenAI, Ollama, Anthropic, Gemini; non-destructive `mergeChosenModels`;
 *      `reorderCatalogEntries`; `filterCatalogModalItems`; modality guard;
 *      API-key redaction for `Open configuration`).
 *   2. Runtime per-model override wiring (`resolveContextWindow`, `isVisionModel`,
 *      `shouldOfferChartImageTool`, `buildReasoningPatch`, `resolveEffectiveMaxTokens`,
 *      `retryAttemptsForPolicy`, `resolveProviderModelLabel`).
 *   3. `lineDiffCore` (`computeLineDiff` + `extractReceiptBeforeAfter`).
 *   4. Live proposal drift + SL breach guard, `transcriptViewMode` persistence,
 *      `toolVisualCore` (`scout_market`, `spot_vs_perp`, `setup_replay`),
 *      `buildDescriptiveWorkSummary`, `NavigationHistoryStack`, and `conversationPins`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'v171-test-user']]);
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = storageShim;
if (!g.sessionStorage) g.sessionStorage = storageShim;
if (!g.window) {
    g.window = {
        localStorage: storageShim,
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    };
}

import type { ProviderConfig } from '../src/types/provider';
import {
    PROVIDER_PRESETS,
    catalogEntriesToConfigFields,
    entriesFromProviderConfig,
    filterCatalogModalItems,
    mergeChosenModels,
    normalizeFetchedCatalog,
    redactProviderConfigsForView,
    reorderCatalogEntries,
    retryAttemptsForPolicy,
    sanitizeProviderId,
    toggleInputModality,
} from '../src/services/providers/modelCatalogCore';
import { resolveContextWindow } from '../src/utils/contextWindow';
import { isVisionModel } from '../src/utils/modelUtils';
import { shouldOfferChartImageTool } from '../src/services/analysis/deskToolShared';
import { buildReasoningPatch } from '../src/services/providers/reasoningControls';
import { resolveEffectiveMaxTokens } from '../src/services/providers/GenericProviderService';
import { resolveProviderModelLabel } from '../src/utils/providerUtils';
import { computeLineDiff, extractReceiptBeforeAfter } from '../src/utils/lineDiffCore';
import {
    buildDescriptiveWorkSummary,
    computeProposalLiveDrift,
    createNavHistory,
    parseToolVisualsFromPayloads,
    pushNavHistory,
    stepNavBack,
    stepNavForward,
} from '../src/services/trade/toolVisualCore';
import {
    cycleTranscriptViewMode,
    getHarnessSettings,
    saveHarnessSettings,
} from '../src/utils/harnessSettings';
import { readConversationPins, toggleConversationPin } from '../src/services/trade/conversationPins';

describe('modelCatalogCore — normalization, non-destructive merge, filter & redaction', () => {
    it('normalizes OpenRouter, OpenAI, Ollama, Anthropic, and Gemini /models payloads', () => {
        const openRouter = normalizeFetchedCatalog('chat_completions', {
            data: [
                {
                    id: 'deepseek/deepseek-r1:free',
                    name: 'DeepSeek R1 (Free)',
                    context_length: 163840,
                    top_provider: { max_completion_tokens: 16384 },
                    architecture: { input_modalities: ['text'] },
                    supported_parameters: ['tools', 'include_reasoning'],
                    pricing: { prompt: '0', completion: '0' },
                },
                {
                    id: 'custom/vision-pro',
                    name: 'Custom Vision Pro',
                    context_length: 200000,
                    architecture: { input_modalities: ['text', 'image'] },
                    supported_parameters: ['tools'],
                    pricing: { prompt: '0.001', completion: '0.002' },
                },
            ],
        });
        assert.equal(openRouter.length, 2);
        assert.equal(openRouter[0].displayName, 'DeepSeek R1 (Free)');
        assert.equal(openRouter[0].contextWindow, 163840);
        assert.equal(openRouter[0].maxOutputTokens, 16384);
        assert.equal(openRouter[0].inputTypes?.image, false);
        assert.equal(openRouter[0].supportsTools, true);
        assert.equal(openRouter[0].reasoningEnabled, true);
        assert.equal(openRouter[0].isFree, true);
        assert.equal(openRouter[1].inputTypes?.image, true);
        assert.equal(openRouter[1].isFree, false);

        const anthropic = normalizeFetchedCatalog('messages', {
            data: [{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', max_input_tokens: 200000 }],
        });
        assert.equal(anthropic[0].displayName, 'Claude Sonnet 4');
        assert.equal(anthropic[0].contextWindow, 200000);
        assert.equal(anthropic[0].inputTypes?.image, true);

        const gemini = normalizeFetchedCatalog('google', {
            models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536 }],
        });
        assert.equal(gemini[0].id, 'gemini-2.5-pro');
        assert.equal(gemini[0].contextWindow, 1048576);
        assert.equal(gemini[0].maxOutputTokens, 65536);

        const ollama = normalizeFetchedCatalog('chat_completions', {
            models: [{ name: 'qwen2.5:14b' }, { model: 'llava-vision:latest' }],
        });
        assert.deepEqual(ollama.map(m => m.id), ['qwen2.5:14b', 'llava-vision:latest']);
        assert.equal(ollama[1].inputTypes?.image, true);
        assert.ok(PROVIDER_PRESETS.length >= 8);
        assert.equal(sanitizeProviderId(' My Gateway! 01 '), 'my-gateway-01');
    });

    it('merges chosen models non-destructively, reorders, filters, and redacts API keys', () => {
        const existing = [
            {
                id: 'alpha-1',
                displayName: 'My Custom Alpha',
                contextWindow: 64_000,
                maxOutputTokens: 4096,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [{ level: 'high', apiValue: 'high_custom' }],
            },
            {
                id: 'removed-model',
                displayName: 'Old Model',
            },
        ];
        const fetched = [
            { id: 'alpha-1', displayName: 'Provider Alpha', contextWindow: 128_000, supportsTools: true, isFree: false },
            { id: 'beta-free', displayName: 'Beta Free', contextWindow: 200_000, inputTypes: { text: true, image: true }, supportsTools: true, isFree: true },
        ];
        const merged = mergeChosenModels(existing, fetched, ['alpha-1', 'beta-free']);
        assert.deepEqual(merged.map(m => m.id), ['alpha-1', 'beta-free']);
        // User overrides on alpha-1 survive intact, while missing supportsTools is hydrated!
        assert.equal(merged[0].displayName, 'My Custom Alpha');
        assert.equal(merged[0].contextWindow, 64_000);
        assert.equal(merged[0].reasoningLevels?.[0].apiValue, 'high_custom');
        assert.equal(merged[0].supportsTools, true);
        // Newly checked beta-free is hydrated
        assert.equal(merged[1].contextWindow, 200_000);
        assert.equal(merged[1].isFree, true);

        const reordered = reorderCatalogEntries(merged, 1, 0);
        assert.deepEqual(reordered.map(m => m.id), ['beta-free', 'alpha-1']);

        const checkedSet = new Set(['beta-free']);
        assert.deepEqual(
            filterCatalogModalItems(merged, { filter: 'free', checkedSet }).map(m => m.id),
            ['beta-free'],
        );
        assert.deepEqual(
            filterCatalogModalItems(merged, { filter: 'checked', checkedSet }).map(m => m.id),
            ['beta-free'],
        );
        assert.deepEqual(
            filterCatalogModalItems(merged, { query: 'custom alpha', filter: 'all', checkedSet }).map(m => m.id),
            ['alpha-1'],
        );

        // Modality guard: cannot uncheck the last enabled modality
        const stillText = toggleInputModality({ text: true, image: false }, 'text', false);
        assert.deepEqual(stillText, { text: true, image: false });
        const both = toggleInputModality({ text: true, image: false }, 'image', true);
        assert.deepEqual(both, { text: true, image: true });

        // Round-trip entries <-> ProviderConfig fields + redaction
        const fields = catalogEntriesToConfigFields(reordered);
        const provider: ProviderConfig = {
            id: 'gw-1',
            name: 'Gateway',
            apiKey: 'sk-super-secret-value-999',
            baseUrl: 'https://gw.example.com/v1',
            apiFormat: 'chat_completions',
            isEnabled: true,
            isBuiltIn: false,
            models: fields.models,
            selectedModel: fields.models[0],
            modelOverrides: fields.modelOverrides,
        };
        assert.equal(entriesFromProviderConfig(provider)[0].id, 'beta-free');
        const redacted = redactProviderConfigsForView([provider]);
        assert.ok(!JSON.stringify(redacted).includes('sk-super-secret-value-999'));
        assert.ok(redacted[0].apiKey.includes('redacted'));
    });
});

describe('Runtime per-model override wiring (context, vision, reasoning, max_tokens, labels)', () => {
    it('honors per-model contextWindow, vision, reasoningLevels, maxOutputTokens, retryPolicy, and displayName', () => {
        const provider: ProviderConfig = {
            id: 'custom-gw',
            name: 'My Gateway',
            apiKey: 'sk-test',
            baseUrl: 'https://custom-gateway.example/v1',
            apiFormat: 'chat_completions',
            isEnabled: true,
            isBuiltIn: false,
            models: ['mystery-slug-x1', 'gpt-4o'],
            selectedModel: 'mystery-slug-x1',
            retryPolicy: 'aggressive',
            modelOverrides: {
                'mystery-slug-x1': {
                    displayName: 'Desk Reasoner X1',
                    contextWindow: 196_608,
                    maxOutputTokens: 12_288,
                    inputTypes: { text: true, image: true },
                    reasoningEnabled: true,
                    reasoningLevels: [
                        { level: 'low', apiValue: 'minimal_think' },
                        { level: 'high', apiValue: 'deep_think' },
                    ],
                },
                'gpt-4o': {
                    inputTypes: { text: true, image: false },
                    reasoningEnabled: false,
                },
            },
        };

        // 1. Context window override wins over default 1M
        const win = resolveContextWindow(provider);
        assert.equal(win.tokens, 196_608);
        assert.equal(win.source, 'user');

        // 2. Vision override unlocks unknown custom slug & explicitly disables known multimodal slug
        assert.equal(isVisionModel('mystery-slug-x1'), false);
        assert.equal(isVisionModel('mystery-slug-x1', provider.modelOverrides?.['mystery-slug-x1']), true);
        assert.equal(shouldOfferChartImageTool('mystery-slug-x1', true, provider.modelOverrides?.['mystery-slug-x1']), true);
        assert.equal(isVisionModel('gpt-4o', provider.modelOverrides?.['gpt-4o']), false);
        assert.equal(shouldOfferChartImageTool('gpt-4o', true, provider.modelOverrides?.['gpt-4o']), false);

        // 3. Reasoning levels map exact apiValue; 'off' omits; reasoningEnabled=false suppresses
        const highPatch = buildReasoningPatch(provider, 'high');
        assert.equal(highPatch.audit.applied, true);
        assert.equal(highPatch.patch.reasoning_effort, 'deep_think');

        const offPatch = buildReasoningPatch(provider, 'off');
        assert.equal(offPatch.audit.applied, false);
        assert.deepEqual(offPatch.patch, {});

        const disabledPatch = buildReasoningPatch({ ...provider, selectedModel: 'gpt-4o' }, 'high');
        assert.equal(disabledPatch.audit.applied, false);
        assert.deepEqual(disabledPatch.patch, {});

        // 4. Max output tokens, retry policy, custom display name
        assert.equal(resolveEffectiveMaxTokens(provider), 12_288);
        assert.equal(resolveEffectiveMaxTokens(provider, 20_000), 12_288);
        assert.equal(resolveEffectiveMaxTokens(provider, 2048), 2048);
        assert.equal(retryAttemptsForPolicy('off'), 1);
        assert.equal(retryAttemptsForPolicy('default'), 3);
        assert.equal(retryAttemptsForPolicy('aggressive'), 5);
        assert.equal(resolveProviderModelLabel(provider, 'mystery-slug-x1'), 'Desk Reasoner X1');
    });
});

describe('lineDiffCore, Proposal Drift/SL Breach, transcriptViewMode & Addendum Cores', () => {
    it('computes accurate line-by-line diffs and extracts memory/skill/dream receipt pairs', () => {
        const diff = computeLineDiff(
            'Risk 1% per trade\nAvoid trading FOMC\nPrefer 15m structure',
            'Risk 1% per trade\nAvoid trading FOMC & CPI\nPrefer 15m structure\nCheck spot vs perp CVD',
        );
        assert.equal(diff.hasChanges, true);
        assert.equal(diff.removed, 1);
        assert.equal(diff.added, 2);
        assert.equal(diff.unchanged, 2);
        assert.ok(diff.lines.some(l => l.kind === 'removed' && l.text === 'Avoid trading FOMC'));
        assert.ok(diff.lines.some(l => l.kind === 'added' && l.text === 'Check spot vs perp CVD'));

        const memPair = extractReceiptBeforeAfter('memory', {
            action: 'add',
            undoSnapshot: 'Line A',
            content: 'Line B',
        });
        assert.deepEqual(memPair, { before: 'Line A', after: 'Line A\nLine B' });

        const skillPair = extractReceiptBeforeAfter('skill_manage', {
            undoSkill: { previousBody: '# Old\nStep 1' },
            rejectedContent: '# New\nStep 1\nStep 2',
        });
        assert.deepEqual(skillPair, { before: '# Old\nStep 1', after: '# New\nStep 1\nStep 2' });
    });

    it('computes live mark drift + SL breach and cycles/persists transcriptViewMode', () => {
        const longProposal = { direction: 'Long' as const, entry: 100_000, stopLoss: 98_000, takeProfits: [104_000] };
        const favorable = computeProposalLiveDrift(longProposal, 101_500);
        assert.ok(favorable);
        assert.equal(favorable.favorable, true);
        assert.equal(favorable.slBreached, false);
        assert.equal(favorable.driftLabel, '+1.50% from entry');

        const breached = computeProposalLiveDrift(longProposal, 97_500);
        assert.ok(breached);
        assert.equal(breached.slBreached, true);

        const shortProposal = { direction: 'Short' as const, entry: 100_000, stopLoss: 102_000, takeProfits: [95_000] };
        assert.equal(computeProposalLiveDrift(shortProposal, 102_200)?.slBreached, true);
        assert.equal(computeProposalLiveDrift(shortProposal, 94_500)?.tp1Reached, true);

        assert.equal(getHarnessSettings().transcriptViewMode, 'normal');
        assert.equal(cycleTranscriptViewMode('normal'), 'audit');
        assert.equal(cycleTranscriptViewMode('audit'), 'calm');
        assert.equal(cycleTranscriptViewMode('calm'), 'normal');
        saveHarnessSettings({ transcriptViewMode: 'audit' });
        assert.equal(getHarnessSettings().transcriptViewMode, 'audit');
        saveHarnessSettings({ transcriptViewMode: 'normal' });
    });

    it('parses scout_market, spot_vs_perp & setup_replay inline visuals, descriptive summaries & nav history', () => {
        const visuals = parseToolVisualsFromPayloads([
            {
                toolCallId: 'tc-scout-1',
                name: 'scout_market',
                text: JSON.stringify({
                    ok: true,
                    symbolsScanned: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
                    intervalsUsed: ['15m', '1h'],
                    timedOutSymbols: [],
                    brief: [
                        'SCOUT [15m/1h]:',
                        '1. BTCUSDT (48) · 15m=trend,1h=trend · flow=spot_absorption · basis=3.4bps · bullish_rsi',
                        '2. ETHUSDT (32) · 15m=range,1h=trend · flow=neutral · basis=1.2bps',
                        '3. SOLUSDT (18) · 15m=range,1h=range · flow=perp_chasing · basis=8.5bps',
                    ].join('\n'),
                }),
            },
            {
                toolCallId: 'tc-svp-1',
                name: 'spot_vs_perp',
                text: JSON.stringify({
                    symbol: 'BTCUSDT',
                    interval: '15m',
                    spotAvailable: true,
                    spotDeltaShare: 0.14,
                    perpDeltaShare: -0.09,
                    spotCvd: 1200,
                    perpCvd: -850,
                    basisBps: 4.2,
                    fundingRate: 0.0001,
                    regime: 'spot_absorption',
                }),
            },
            {
                toolCallId: 'tc-replay-1',
                name: 'setup_replay',
                text: JSON.stringify({
                    symbol: 'BTCUSDT',
                    interval: '1h',
                    setup: 'Sweep Reclaim',
                    totalTrades: 12,
                    wins: 8,
                    losses: 3,
                    timeouts: 1,
                    winRatePct: 66.7,
                    expectancyR: 0.65,
                    netR: 7.8,
                }),
            },
        ]);

        assert.equal(visuals.length, 3);
        assert.equal(visuals[0].kind, 'scout_market');
        if (visuals[0].kind === 'scout_market') {
            assert.equal(visuals[0].items.length, 3);
            assert.equal(visuals[0].items[0].symbol, 'BTCUSDT');
            assert.equal(visuals[0].items[0].score, 48);
            assert.equal(visuals[0].items[0].flowRegime, 'spot_absorption');
            assert.equal(visuals[0].items[0].basisBps, 3.4);
        }
        assert.equal(visuals[1].kind, 'spot_vs_perp');
        if (visuals[1].kind === 'spot_vs_perp') {
            assert.equal(visuals[1].spotDeltaSharePct, 14);
            assert.equal(visuals[1].perpDeltaSharePct, -9);
        }
        assert.equal(visuals[2].kind, 'setup_replay');
        if (visuals[2].kind === 'setup_replay') {
            assert.equal(visuals[2].winRatePct, 66.7);
            assert.equal(visuals[2].netR, 7.8);
        }

        // Descriptive work summary
        assert.equal(buildDescriptiveWorkSummary([]), null);
        const desc = buildDescriptiveWorkSummary(
            [{ label: 'get_market_packet' }, { label: 'spot_vs_perp' }, { label: 'present_trade' }],
            { symbol: 'BTCUSDT', interval: '15m', seconds: 2 },
        );
        assert.equal(desc, 'Checked BTC 15m structure, spot vs. perp CVD & math gate · 2s');

        // Navigation back/forward history stack
        let nav = createNavHistory('s1');
        nav = pushNavHistory(nav, 's2');
        nav = pushNavHistory(nav, 's3');
        const back1 = stepNavBack(nav);
        assert.equal(back1.targetId, 's2');
        const back2 = stepNavBack(back1.next);
        assert.equal(back2.targetId, 's1');
        const fwd1 = stepNavForward(back2.next);
        assert.equal(fwd1.targetId, 's2');
        // Navigating to a new session after stepping back truncates forward branch
        const branched = pushNavHistory(fwd1.next, 's4');
        assert.deepEqual(branched.stack, ['s1', 's2', 's4']);
        assert.equal(stepNavForward(branched).targetId, null);

        // Conversation pins toggle round-trip
        const pinned = toggleConversationPin('conv-alpha', 'v171-test-user');
        assert.ok(pinned.includes('conv-alpha'));
        assert.ok(readConversationPins('v171-test-user').includes('conv-alpha'));
        const unpinned = toggleConversationPin('conv-alpha', 'v171-test-user');
        assert.ok(!unpinned.includes('conv-alpha'));
    });
});
