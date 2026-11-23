import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildReasoningPatch,
    applyReasoningToChatParams,
    registerWireRoutePins,
} from '../src/services/providers/reasoningControls';
import { createThinkingStreamGate } from '../src/utils/thinkingSplit';
import { createBrowserSseParser, extractReasoning, readWireBody, reasoningPreambleMessages, unstreamedReasoningTail } from '../src/services/providers/GenericProviderService';
import { requestReasoningSideChannel, splitChatContentPayload } from '../shared/providerRequestPolicy.cjs';
import { CHAT_SURFACE_SYSTEM_PROMPT, REASONING_CHANNEL_PROMPT } from '../src/constants/prompts/chatPrompts';
import { TRADE_CHAT_SYSTEM_PROMPT } from '../src/services/trade/tradeChatContext';

const customErnie = {
    id: 'custom-ernie',
    baseUrl: 'https://custom.example/v1',
    apiFormat: 'chat_completions',
    selectedModel: 'ernie-5.5-fl',
} as const;

describe('custom-effort reasoning route', () => {
    it('requests reasoning output with a safe reasoning_effort for a custom provider at max effort', () => {
        const params: Record<string, unknown> = {};
        const audit = applyReasoningToChatParams(customErnie, params, { reasoningEffort: 'max' });
        assert.equal(params.reasoning_effort, 'high');
        assert.equal(params.include_reasoning, true);
        assert.equal(String(audit.route), 'custom-effort');
        assert.equal(audit.applied, true);
        assert.match(audit.reason, /include_reasoning=true/);
    });

    it('uses OpenRouter reasoning shape and asks for the side channel on a custom gateway URL', () => {
        const config = {
            ...customErnie,
            id: 'custom-openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            selectedModel: 'openai/gpt-5',
        } as const;
        const params: Record<string, unknown> = {};
        requestReasoningSideChannel(config, params);
        const audit = applyReasoningToChatParams(config, params, { reasoningEffort: 'max' });
        assert.equal(params.include_reasoning, true);
        assert.deepEqual(params.reasoning, { effort: 'high' });
        assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false);
        assert.equal(audit.route, 'custom-effort');
        assert.equal(audit.applied, true);
    });

    it('asks Kilocode custom gateway URLs for reasoning and keeps Max on the portable high rung', () => {
        for (const baseUrl of ['https://api.kilocode.ai/v1', 'https://ai-gateway.kilo.ai/api/v1']) {
            const config = { ...customErnie, id: `custom-${baseUrl}`, baseUrl } as const;
            const params: Record<string, unknown> = {};
            requestReasoningSideChannel(config, params);
            const audit = applyReasoningToChatParams(config, params, { reasoningEffort: 'max' });
            assert.equal(params.include_reasoning, true, baseUrl);
            assert.equal(params.reasoning_effort, 'high', baseUrl);
            assert.notEqual(params.reasoning_effort, 'max', baseUrl);
            assert.equal(audit.route, 'custom-effort');
            assert.equal(audit.applied, true);
        }
    });

    it('does not send an effort knob to grok-fast through a Kilocode custom gateway', () => {
        const params: Record<string, unknown> = {};
        const audit = applyReasoningToChatParams(
            { ...customErnie, baseUrl: 'https://ai-gateway.kilo.ai/api/v1', selectedModel: 'xai/grok-4-fast' },
            params,
            { reasoningEffort: 'max' },
        );
        assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false);
        assert.equal(audit.applied, false);
    });

    it('does not send a knob to a grok-fast model on the generic route', () => {
        const params: Record<string, unknown> = {};
        const audit = applyReasoningToChatParams(
            {
                id: 'grok-fast',
                baseUrl: 'https://api.x.ai/v1',
                apiFormat: 'chat_completions',
                selectedModel: 'grok-4-fast',
            },
            params,
            { reasoningEffort: 'high' },
        );
        assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false);
        assert.equal(audit.applied, false);
    });

    it('maps every real tier onto the common scale, clamping max to high', () => {
        for (const [effort, value] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'high']] as const) {
            const { patch } = buildReasoningPatch(customErnie, effort);
            assert.equal(patch.reasoning_effort, value, `effort ${effort}`);
            assert.equal(patch.include_reasoning, true, `effort ${effort}`);
        }
    });

    it('puts the reasoning side-channel request in the shared patch used by the browser proxy', () => {
        const { patch, audit } = buildReasoningPatch(customErnie, 'max');
        assert.equal(patch.reasoning_effort, 'high');
        assert.equal(patch.include_reasoning, true);
        assert.equal(audit.applied, true);
        assert.match(audit.reason, /include_reasoning=true/);
    });

    it('prepends a separate reasoning system message for custom tool turns', () => {
        const messages = [
            { role: 'system' as const, content: 'Desk rules and chart context.' },
            { role: 'user' as const, content: 'Read BTC.' },
        ];
        const wired = reasoningPreambleMessages(customErnie, messages, {
            reasoningEffort: 'max',
            tools: [{ type: 'function', function: { name: 'get_chart_view', description: 'Read chart', parameters: { type: 'object', properties: {} } } }],
        });
        assert.equal(wired.length, 3);
        assert.equal(wired[0].role, 'system');
        assert.equal(wired[0].content, REASONING_CHANNEL_PROMPT);
        assert.deepEqual(wired.slice(1), messages);
    });

    it('does not add a reasoning preamble without an applied custom tool route', () => {
        const messages = [{ role: 'user' as const, content: 'Hello.' }];
        const tools = [{ type: 'function' as const, function: { name: 'get_chart_view', description: 'Read chart', parameters: { type: 'object', properties: {} } } }];
        assert.strictEqual(reasoningPreambleMessages(customErnie, messages, { reasoningEffort: 'auto', tools }), messages);
        assert.strictEqual(reasoningPreambleMessages(customErnie, messages, { reasoningEffort: 'max' }), messages);
        assert.strictEqual(reasoningPreambleMessages(
            { ...customErnie, baseUrl: 'https://api.openai.com/v1', selectedModel: 'o3-mini' },
            messages,
            { reasoningEffort: 'max', tools },
        ), messages);
    });

    it('sends no reasoning knob for auto or off on a custom provider', () => {
        for (const effort of ['auto', 'off'] as const) {
            const params: Record<string, unknown> = { temperature: 0.7 };
            const audit = applyReasoningToChatParams(customErnie, params, { reasoningEffort: effort });
            assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false, `effort ${effort}`);
            assert.equal(Object.prototype.hasOwnProperty.call(params, 'include_reasoning'), false, `effort ${effort}`);
            assert.equal(audit.applied, false, `effort ${effort}`);
            assert.equal(String(audit.route), 'none', `effort ${effort}`);
        }
    });

    it('sends no knob when a harness wire lesson pins the custom route off', () => {
        // Scoped checker: only the provider id used here is pinned. No other
        // test in the suite reads wire pins, so leaving it installed is safe.
        registerWireRoutePins((route, providerId) => String(route) === 'custom-effort' && providerId === 'pinned-custom');
        const params: Record<string, unknown> = {};
        const audit = applyReasoningToChatParams(
            { ...customErnie, id: 'pinned-custom' },
            params,
            { reasoningEffort: 'high' },
        );
        assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false);
        assert.equal(audit.applied, false);
        assert.match(audit.reason, /pinned off by a harness wire lesson/);
        // The same route still applies to an unpinned provider.
        const other: Record<string, unknown> = {};
        applyReasoningToChatParams(customErnie, other, { reasoningEffort: 'high' });
        assert.equal(other.reasoning_effort, 'high');
    });
});

describe('pass 5 — streaming reasoning parser & multi-frame SSE orphan promotion', () => {
    it('routes chunk-split <thinking>, <think>, <thought>, <|thought|> tags to reasoning with zero leak and preserves math <', () => {
        for (const [open, close] of [
            ['<thinking>', '</thinking>'],
            ['<THINK data-foo="bar">', '</THINK>'],
            ['<thought>', '</thought>'],
            ['<|thought|>', '<|/thought|>'],
        ]) {
            const gate = createThinkingStreamGate();
            const full = `${open}Step 1: check RSI (x < 300).${close}Answer: 5 < 8 is true.`;
            let reasoning = '';
            let visible = '';
            for (let i = 0; i < full.length; i += 3) {
                const out = gate.push(full.slice(i, i + 3));
                reasoning += out.thinking;
                visible += out.visible;
            }
            const tail = gate.flush();
            reasoning += tail.thinking;
            visible += tail.visible;
            assert.equal(reasoning, 'Step 1: check RSI (x < 300).', `reasoning for ${open}`);
            assert.equal(visible, 'Answer: 5 < 8 is true.', `visible for ${open}`);
            assert.equal(/<\/?(?:thinking|think|thought|\|thought\|)/i.test(visible), false);
        }
    });

    it('retroactively promotes earlier SSE frames on orphan </think> within the same network chunk', () => {
        const parser = createBrowserSseParser('chat_completions');
        const sseChunk = [
            'data: {"choices":[{"delta":{"content":"First thought line "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"more thought</think>Clean answer: 5 < 8."}}]}\n\n',
            'data: [DONE]\n\n',
        ].join('');
        const batch = parser.push(sseChunk);
        const tail = parser.flush();
        const reasoning = [...batch.reasoningDeltas, ...tail.reasoningDeltas].join('');
        const visible = [...batch.textDeltas, ...tail.textDeltas].join('');
        assert.equal(batch.orphanClose, true);
        assert.equal(reasoning, 'First thought line more thought');
        assert.equal(visible, 'Clean answer: 5 < 8.');
    });

    it('keeps reasoning_details text and summary on the same SSE chunk as native tool calls', () => {
        const parser = createBrowserSseParser('chat_completions');
        const batch = parser.push(
            'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Read the log. "},{"type":"reasoning.summary","summary":"Check the edge."}],"tool_calls":[{"index":0,"id":"call_log","type":"function","function":{"name":"get_trade_log","arguments":"{\\"coin\\":\\"BTCUSDT\\"}"}}]}}]}\n\n'
            + 'data: {"choices":[{"delta":{"reasoning_content":"Compare the rows.","tool_calls":[{"index":1,"id":"call_pulse","type":"function","function":{"name":"get_market_pulse","arguments":"{}"}}]}}]}\n\n'
            + 'data: {"choices":[{"delta":{"reasoning":"Conclude."}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"The edge is weak."},"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n',
        );
        const toolCalls: Array<{ name: string }> = [];
        const tail = parser.flush({ onStreamToolCalls: calls => toolCalls.push(...calls) });
        assert.equal([...batch.reasoningDeltas, ...tail.reasoningDeltas].join(''), 'Read the log. Check the edge.Compare the rows.Conclude.');
        assert.equal([...batch.textDeltas, ...tail.textDeltas].join(''), 'The edge is weak.');
        assert.deepEqual(toolCalls.map(call => call.name), ['get_trade_log', 'get_market_pulse']);
    });

    it('reads a bare buffered JSON message when a gateway labels it as a stream', () => {
        const parser = createBrowserSseParser('chat_completions');
        const batch = parser.push(JSON.stringify({
            choices: [{
                message: {
                    reasoning_details: [{ type: 'reasoning.text', text: 'Buffered thought.' }],
                    content: 'Buffered answer.',
                    tool_calls: [
                        { id: 'call_buffered_log', type: 'function', function: { name: 'get_trade_log', arguments: '{}' } },
                        { id: 'call_buffered_context', type: 'function', function: { name: 'get_session_context', arguments: '{"coin":"BTCUSDT"}' } },
                    ],
                },
                finish_reason: 'tool_calls',
            }],
        }));
        const toolCalls: Array<{ name: string }> = [];
        const tail = parser.flush({ onStreamToolCalls: calls => toolCalls.push(...calls) });
        assert.equal([...batch.reasoningDeltas, ...tail.reasoningDeltas].join(''), 'Buffered thought.');
        assert.equal([...batch.textDeltas, ...tail.textDeltas].join(''), 'Buffered answer.');
        assert.deepEqual(toolCalls.map(call => call.name), ['get_trade_log', 'get_session_context']);
    });

    it('captures structured delta.reasoning_content, delta.reasoning, delta.thought, and delta.reasoning_details', () => {
        const parser = createBrowserSseParser('chat_completions');
        const sse = [
            'data: {"choices":[{"delta":{"reasoning_content":"A"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning":"B"}}]}\n\n',
            'data: {"choices":[{"delta":{"thought":"C"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_details":[{"text":"D"}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: [DONE]\n\n',
        ].join('');
        const batch = parser.push(sse);
        const tail = parser.flush();
        assert.equal([...batch.reasoningDeltas, ...tail.reasoningDeltas].join(''), 'ABCD');
        assert.equal([...batch.textDeltas, ...tail.textDeltas].join(''), 'Hello');
    });
});

describe('reasoning-channel prompt', () => {
    it('asks for scratch work in the reasoning channel or think tags, never the visible reply', () => {
        assert.match(CHAT_SURFACE_SYSTEM_PROMPT, /reasoning channel/);
        assert.match(CHAT_SURFACE_SYSTEM_PROMPT, /<think>\.\.\.<\/think>/);
        assert.match(CHAT_SURFACE_SYSTEM_PROMPT, /Never put scratch work in the visible reply/);
    });

    it('puts the same directive in the dock prompt, including before tool calls', () => {
        assert.ok(TRADE_CHAT_SYSTEM_PROMPT.includes(REASONING_CHANNEL_PROMPT));
        assert.match(REASONING_CHANNEL_PROMPT, /think before calling them as well/);
    });
});

describe('buffered reasoning fallback', () => {
    it('keeps distinct co-populated reasoning fields without repeating shared text', () => {
        assert.equal(extractReasoning({ text: '', summary: 'Summary only.' }), 'Summary only.');
        assert.equal(extractReasoning({ text: 'Text only.', summary: 'Summary only.' }), 'Text only.Summary only.');
        const result = readWireBody('chat_completions', {
            choices: [{
                message: {
                    reasoning: 'Shared alias.',
                    reasoning_details: [
                        { type: 'reasoning.text', text: 'Shared alias.' },
                        { type: 'reasoning.text', text: 'Detail only.' },
                        { type: 'reasoning.summary', summary: 'Summary only.' },
                    ],
                    content: 'Answer.',
                },
            }],
        });
        assert.equal(result.reasoning, 'Shared alias.Detail only.Summary only.');
        assert.equal(result.text, 'Answer.');
    });

    it('keeps buffered thinking blocks out of visible chat content', () => {
        assert.deepEqual(splitChatContentPayload([
            { type: 'thinking', thinking: 'Hidden thought.' },
            { type: 'text', text: 'Visible answer.' },
            { type: 'reasoning', text: 'Second thought.' },
        ]), { text: 'Visible answer.', reasoning: 'Hidden thought.Second thought.' });
    });

    it('forwards only the Electron buffered reasoning tail that was not streamed', () => {
        assert.equal(unstreamedReasoningTail('', 'Buffered thought.'), 'Buffered thought.');
        assert.equal(unstreamedReasoningTail('Round one. ', 'Round one. Round two.'), 'Round two.');
        assert.equal(unstreamedReasoningTail('Round one. Round two.', 'Round one. Round two.'), '');
        assert.equal(unstreamedReasoningTail('inline thought', 'native thought'), 'native thought');
    });

    it('reads reasoning_details after an empty alias and keeps inline thinking out of the answer', () => {
        const result = readWireBody('chat_completions', {
            choices: [{
                message: {
                    reasoning_content: '',
                    reasoning_details: [
                        { type: 'reasoning.text', text: 'Inspect the rows. ' },
                        { type: 'reasoning.summary', summary: 'The sample is thin.' },
                    ],
                    content: '<think>Check the counterexample.</think>No confirmed edge.',
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_trade_log', arguments: '{}' } }],
                },
                finish_reason: 'tool_calls',
            }],
        });
        assert.equal(result.reasoning, 'Inspect the rows. The sample is thin.\n\nCheck the counterexample.');
        assert.equal(result.text, 'No confirmed edge.');
    });
});
