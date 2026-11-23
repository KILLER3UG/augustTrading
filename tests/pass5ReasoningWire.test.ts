import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildReasoningPatch,
    applyReasoningToChatParams,
    registerWireRoutePins,
} from '../src/services/providers/reasoningControls';
import { createThinkingStreamGate } from '../src/utils/thinkingSplit';
import { createBrowserSseParser } from '../src/services/providers/GenericProviderService';

const customErnie = {
    id: 'custom-ernie',
    baseUrl: 'https://custom.example/v1',
    apiFormat: 'chat_completions',
    selectedModel: 'ernie-5.5-fl',
} as const;

describe('custom-effort reasoning route', () => {
    it('forwards a safe reasoning_effort for a custom chat_completions provider at max effort', () => {
        const { patch, audit } = buildReasoningPatch(customErnie, 'max');
        assert.equal(patch.reasoning_effort, 'high');
        assert.equal(String(audit.route), 'custom-effort');
        assert.equal(audit.applied, true);
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
        }
    });

    it('sends no reasoning knob for auto or off on a custom provider', () => {
        for (const effort of ['auto', 'off'] as const) {
            const params: Record<string, unknown> = { temperature: 0.7 };
            const audit = applyReasoningToChatParams(customErnie, params, { reasoningEffort: effort });
            assert.equal(Object.prototype.hasOwnProperty.call(params, 'reasoning_effort'), false, `effort ${effort}`);
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
