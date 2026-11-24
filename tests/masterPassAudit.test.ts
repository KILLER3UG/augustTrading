/**
 * Master Architecture, Streaming, Autonomy, Paper Broker & Dynamic Registry Audit
 *
 * Behavioural runtime regression suite (zero live network calls).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'master-audit-user']]);
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storageShim;
g.sessionStorage = storageShim;
g.window = {
    localStorage: storageShim,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
};
g.document = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false };

const policy = await import('../shared/providerRequestPolicy.cjs');
const providerSvc = await import('../src/services/providers/GenericProviderService');
const reasoning = await import('../src/services/providers/reasoningControls');
const autonomy = await import('../src/services/trade/autonomySettings');
const providerCfg = await import('../src/services/infrastructure/ProviderConfigService');
const harness = await import('../src/utils/harnessSettings');
const surfaceTurn = await import('../src/services/trade/chatSurfaceTurn');
const deskTools = await import('../src/services/analysis/DeskToolsService');
const skillManage = await import('../src/services/learning/skillManage');
const signalLedger = await import('../src/services/signals/signalLedger');
const paperCore = await import('../src/services/paper/paperCore');
const futuresStreams = await import('../src/services/trade/futuresStreams');
const toolKinds = await import('../src/utils/toolKinds');
const chartIntervals = await import('../src/utils/chartIntervals');
const endpoints = await import('../src/config/exchangeEndpoints');

describe('1. SSE, reasoning extraction & Effort=off gating', () => {
    it('suppresses requestReasoningSideChannel when reasoningEffort is off', () => {
        const cfg = {
            id: 'custom-gateway',
            name: 'Custom',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'test-key',
            apiFormat: 'chat_completions' as const,
            selectedModel: 'openai/gpt-5',
            models: ['openai/gpt-5'],
            isEnabled: true,
        };
        const offParams: Record<string, unknown> = {};
        policy.requestReasoningSideChannel(cfg, offParams, 'off');
        assert.equal(Object.prototype.hasOwnProperty.call(offParams, 'include_reasoning'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(offParams, 'reasoning'), false);

        const highParams: Record<string, unknown> = {};
        policy.requestReasoningSideChannel(cfg, highParams, 'high');
        assert.equal(highParams.include_reasoning, true);

        const audit = reasoning.applyReasoningToChatParams(cfg, { ...offParams }, { reasoningEffort: 'off' });
        assert.equal(audit.applied, false);
    });

    it('preserves sequential short tokens in extractReasoningPayload and splitChatContentPayload without false dedupe', () => {
        const joined = policy.extractReasoningPayload([
            { type: 'reasoning.text', text: '10' },
            { type: 'reasoning.text', text: '0' },
            { type: 'reasoning.text', text: '100' },
        ]);
        assert.equal(joined, '100100');

        const split = policy.splitChatContentPayload([
            { type: 'thinking', thinking: '10' },
            { type: 'thinking', thinking: '0' },
            { type: 'text', text: 'Check 5 < 8 hold' },
        ]);
        assert.equal(split.reasoning, '100');
        assert.equal(split.text, 'Check 5 < 8 hold');
    });

    it('extracts multi-round SSE array reasoning_details, reasoning_content, inline <thinking> and preserves 5 < 8 verbatim', () => {
        const parser = providerSvc.createBrowserSseParser('chat_completions');
        const round1 = [
            'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"First "},{"type":"reasoning.text","text":"10"}]}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"0"}]},"index":0}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":" + side","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_price_snapshot","arguments":"{}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"<thinking>Hidden step 5 < 8</thinking>Final: 5 < 8 holds."},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
        ].join('');

        const batch = parser.push(round1);
        const toolCalls: Array<{ name: string }> = [];
        const tail = parser.flush({ onStreamToolCalls: calls => toolCalls.push(...calls) });
        const reasoningJoined = [...batch.reasoningDeltas, ...tail.reasoningDeltas].join('');
        const textJoined = [...batch.textDeltas, ...tail.textDeltas].join('');

        assert.ok(reasoningJoined.includes('First 100'));
        assert.ok(reasoningJoined.includes(' + side'));
        assert.ok(reasoningJoined.includes('Hidden step 5 < 8'));
        assert.equal(textJoined, 'Final: 5 < 8 holds.');
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].name, 'get_price_snapshot');
    });
});

describe('2. Single Active Brain & multi-model override', () => {
    beforeEach(() => {
        backing.clear();
        backing.set('last_active_user', 'master-audit-user');
    });

    it('routes resolveBackgroundSeat through activeModelPair secondary model on a multi-model provider', async () => {
        await providerCfg.saveProviderConfigs([
            {
                id: 'custom-multi',
                name: 'Custom Multi',
                baseUrl: 'https://example.test/v1',
                apiKey: 'sk-test-1234',
                apiFormat: 'chat_completions',
                selectedModel: 'primary-model',
                models: ['primary-model', 'secondary-model'],
                isEnabled: true,
                isBuiltIn: false,
            },
        ]);
        localStorage.setItem('casual_chat_model', 'custom-multi::secondary-model');

        const seat = await autonomy.resolveBackgroundSeat('master-audit-user', 'maintenance');
        assert.ok(seat, 'expected active background seat');
        assert.equal(seat.config.id, 'custom-multi');
        assert.equal(seat.config.selectedModel, 'secondary-model');
    });
});

describe('3. Chat Risk Constitution + KV-cache prompt stability', () => {
    beforeEach(() => {
        backing.clear();
        backing.set('last_active_user', 'master-audit-user');
        surfaceTurn.clearChatSurfacePromptCache();
    });

    it('injects immutable Risk Constitution into frozen static prefix and keeps prefix cache stable across dynamic queries', () => {
        harness.saveHarnessSettings({ riskConstitution: 'Never risk more than 1R on CPI days.' });
        const first = surfaceTurn.surfacePromptWith('MANDATE', 'Chat Desk', {
            sessionKey: 'sess-kv-1',
            matchText: 'ETH breakout check',
        });
        const second = surfaceTurn.surfacePromptWith('MANDATE', 'Chat Desk', {
            sessionKey: 'sess-kv-1',
            matchText: 'SOL funding check',
        });

        assert.ok(first.text.includes('TRADER RISK CONSTITUTION'));
        assert.ok(first.text.includes('Never risk more than 1R on CPI days.'));
        assert.equal(first.text, second.text);

        surfaceTurn.clearChatSurfacePromptCache('sess-kv-1');
        harness.saveHarnessSettings({ riskConstitution: 'Updated constitution rule.' });
        const refreshed = surfaceTurn.surfacePromptWith('MANDATE', 'Chat Desk', {
            sessionKey: 'sess-kv-1',
            matchText: 'ETH breakout check',
        });
        assert.ok(refreshed.text.includes('Updated constitution rule.'));
    });
});

describe('4. Desk tool execution & Skill promotion safety', () => {
    beforeEach(() => {
        backing.clear();
        backing.set('last_active_user', 'master-audit-user');
        signalLedger.__clearSignalLedgerForTests('master-audit-user');
    });

    it('partitions read-only and stateful calls cleanly and preserves caller call order', async () => {
        const calls: import('../src/services/analysis/DeskToolsService').DeskToolCall[] = [
            { id: 'c1', name: 'trade_math', arguments: { entry: 100, stop: 95, target: 115, account_usd: 10000, risk_pct: 1 } },
            { id: 'c2', name: 'update_plan', arguments: { step: 'Map levels', status: 'in_progress' } },
            { id: 'c3', name: 'trade_math', arguments: { entry: 200, stop: 190, target: 230, account_usd: 10000, risk_pct: 1 } },
        ];
        const results = await deskTools.executeDeskTools(calls, {
            defaultSymbol: 'BTCUSDT',
            sessionId: 'tool-order-test',
        });
        assert.equal(results.length, 3);
        assert.deepEqual(results.map(r => r.toolCallId), ['c1', 'c2', 'c3']);
        assert.deepEqual(results.map(r => r.name), ['trade_math', 'update_plan', 'trade_math']);
    });

    it('excludes non-signal ledger rows from O-150 skill promotion evidence', async () => {
        const baseAt = Date.parse('2026-11-20T00:00:00.000Z');
        const iso = new Date(baseAt).toISOString();
        await skillManage.__seedSkillMetaForTests({
            'audit-probation-skill': {
                status: 'probation',
                createdBy: 'agent',
                createdAt: iso,
                updatedAt: iso,
            },
        }, 'master-audit-user');

        for (let i = 0; i < 6; i += 1) {
            const emittedAt = baseAt + i * 24 * 60 * 60 * 1000;
            const id = `sim-sig-${i}`;
            signalLedger.appendSignalEvent({
                v: 1, id, type: 'emit', at: emittedAt,
                signal: {
                    id, coin: 'BTCUSDT', direction: 'long',
                    entry: 100, stop: 95, target: 110,
                    emittedAt, expiresAt: emittedAt + 7200_000,
                    evidenceRefs: ['trade_math'], dataHash: 'unavailable',
                    provider: 'custom', model: 'ernie-5.5-fl',
                    promptVersion: 'v1', thesis: 'Audit fixture',
                    source: 'simulated' as unknown as 'signal',
                },
            }, 'master-audit-user');
            signalLedger.recordSignalResolution(id, {
                status: 'won', at: emittedAt + 3600_000,
                grossR: 2.0, feeR: 0.05, outcomeR: 1.95,
                usedBarTimes: [emittedAt], path: 'bar', ambiguous: false,
                crossCheck: 'unavailable', primarySource: 'okx',
                exitPrice: 110,
            }, 'master-audit-user');
        }

        const verdict = await skillManage.promoteSkillToVerified('audit-probation-skill', undefined, 'master-audit-user');
        assert.equal(verdict.promoted, false);
        assert.equal(verdict.nEffective, 0);
        assert.match(verdict.reason, /O-150/);
    });
});

describe('5. Paper broker multi-symbol funding & kline wick envelope', () => {
    beforeEach(() => {
        futuresStreams.resetPaperFrameCache();
    });

    it('scopes accruePaperFunding strictly to the ticked symbol across concurrent multi-symbol positions', () => {
        const startMs = Date.parse('2026-11-22T07:00:00.000Z');
        const btcOpen = paperCore.placePaperOrder({
            account: paperCore.createPaperAccount(null, startMs),
            input: { action: 'open_market', symbol: 'BTCUSDT', side: 'long', notional_usd: 500, leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: startMs,
            isKnownSymbol: s => s === 'BTCUSDT' || s === 'ETHUSDT',
            nextId: p => `${p}-btc`,
        });
        assert.equal(btcOpen.ok, true, JSON.stringify(btcOpen));

        const bothOpen = paperCore.placePaperOrder({
            account: btcOpen.account!,
            input: { action: 'open_market', symbol: 'ETHUSDT', side: 'long', notional_usd: 500, leverage: 5, stop_loss: 99, entry_price: 100 },
            quote: { bestBid: 99.9, bestAsk: 100.1, last: 100 },
            nowMs: startMs + 1000,
            isKnownSymbol: s => s === 'BTCUSDT' || s === 'ETHUSDT',
            nextId: p => `${p}-eth`,
        });
        assert.equal(bothOpen.ok, true, JSON.stringify(bothOpen));

        const tickAt = Date.parse('2026-11-22T09:00:00.000Z');
        const ticked = paperCore.evaluatePaperTick(bothOpen.account!, {
            symbol: 'BTCUSDT',
            timestamp: tickAt,
            price: 100,
            fundingRate: 0.0002,
        });

        const btcPos = ticked.account.positions.find(p => p.symbol === 'BTCUSDT')!;
        const ethPos = ticked.account.positions.find(p => p.symbol === 'ETHUSDT')!;
        assert.ok(btcPos.fundingPaidUsd > 0, 'ticked symbol BTCUSDT should settle funding');
        assert.equal(ethPos.fundingPaidUsd, 0, 'unticked ETHUSDT must not settle BTCUSDT funding');
    });

    it('accumulates intra-window high/low kline wicks in publishPaperKline until consumePaperLiveFrame', () => {
        const now = Date.now();
        futuresStreams.publishPaperKline('SOLUSDT', { openTime: now - 2000, open: 100, high: 105, low: 98, close: 102, volume: 10, closed: false }, now - 200);
        futuresStreams.publishPaperKline('SOLUSDT', { openTime: now - 1000, open: 102, high: 112, low: 99, close: 108, volume: 15, closed: false }, now - 100);
        futuresStreams.publishPaperKline('SOLUSDT', { openTime: now, open: 108, high: 109, low: 95, close: 100, volume: 12, closed: true }, now);

        const frame = futuresStreams.consumePaperLiveFrame('SOLUSDT', 5000, now);
        assert.ok(frame);
        assert.equal(frame.high, 112);
        assert.equal(frame.low, 95);
        assert.equal(frame.last, 100);

        const nextFrame = futuresStreams.consumePaperLiveFrame('SOLUSDT', 5000, now);
        assert.ok(nextFrame);
        assert.equal(nextFrame.high, null);
        assert.equal(nextFrame.low, null);
        assert.equal(nextFrame.last, 100);
    });
});

describe('6. Dynamic registries & single-source TOOL_REGISTRY parity', () => {
    it('keeps TOOL_REGISTRY derived exports and paper tool names in 100% parity', () => {
        const deskGrantNames = toolKinds.TOOL_REGISTRY.filter(t => t.deskGrant).map(t => t.name);
        assert.deepEqual(toolKinds.DESK_TOOL_NAMES, deskGrantNames);
        assert.deepEqual([...toolKinds.PAPER_TOOL_NAMES], ['paper_account', 'paper_order']);
        for (const name of toolKinds.PAPER_TOOL_NAMES) {
            assert.ok(toolKinds.DESK_TOOL_NAMES.includes(name));
        }

        for (const entry of toolKinds.TOOL_REGISTRY) {
            assert.equal(toolKinds.TOOL_LABELS[entry.name], entry.label);
            assert.equal(Boolean(entry.cacheable), toolKinds.CACHEABLE_TOOLS.has(entry.name));
            assert.equal(Boolean(entry.stateful), toolKinds.STATEFUL_DESK_TOOLS.has(entry.name));
        }
    });

    it('exposes shared chart intervals and default exchange endpoint metadata dynamically', () => {
        for (const tf of chartIntervals.DEFAULT_CHART_INTERVALS) {
            assert.ok(chartIntervals.CHART_INTERVALS.includes(tf));
        }
        assert.ok(chartIntervals.COMPOSER_TIMEFRAMES.includes('4h'));
        assert.equal(typeof endpoints.DEFAULT_SYMBOL, 'string');
        assert.ok(endpoints.DEFAULT_SYMBOL.length > 0);
    });
});
