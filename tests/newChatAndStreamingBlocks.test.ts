import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as chatStore from '../src/services/trade/chatStore';
import { createThinkingStreamGate, extractAndStripThinkBlocks, splitThinkingFromOutput } from '../src/utils/thinkingSplit';
import { splitStableMarkdownBlocks, canRenderPlainStreamingProse } from '../src/utils/streamBlocks';
import { createBrowserSseParser } from '../src/services/providers/GenericProviderService';
import { runDeskToolLoop } from '../src/services/analysis/DeskToolsService';
import type { ProviderConfig } from '../src/types/provider';

const require = createRequire(import.meta.url);
const { createSseParser } = require('../electron/sseParser.cjs') as {
    createSseParser: (apiFormat: string) => {
        push: (chunk: string) => { events: Array<{ type: string; delta?: string; message?: string }>; done: boolean };
        finish: () => { events: Array<{ type: string; delta?: string }>; done: boolean; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage: unknown; sawData: boolean };
    };
};

describe('chatStore — new-chat isolation & blank conversation detection', () => {
    beforeEach(() => {
        chatStore.__resetForTests();
    });

    it('creates a distinct blank solo session and preserves panel/bot/populated sessions', () => {
        const panelId = chatStore.addSession({ kind: 'panel', title: 'Panel' });
        const botId = chatStore.addSession({ kind: 'solo', botId: 'bot-1', title: 'Bot' });
        const s1 = chatStore.bindConversation('conv-1', { symbol: 'BTCUSDT', interval: '15m' });
        assert.notEqual(s1, panelId);
        assert.notEqual(s1, botId);

        chatStore.mutate(s1, s => ({
            ...s,
            entries: [{ id: 'u-1', role: 'user', text: 'What is the bias?', tools: [] }],
        }));
        assert.equal(chatStore.isConversationEmptyInStore('conv-1'), false);

        const s2 = chatStore.bindConversation('conv-2', { symbol: 'ETHUSDT', interval: '1h', effort: 'high' });
        assert.notEqual(s2, s1);
        const snap = chatStore.getSnapshot();
        assert.equal(snap.activeId, s2);
        const session2 = snap.sessions.find(s => s.id === s2);
        assert.equal(session2?.entries.length, 0);
        assert.equal(session2?.conversationId, 'conv-2');
        assert.equal(session2?.symbol, 'ETHUSDT');
        assert.equal(session2?.effort, 'high');
        assert.equal(snap.sessions.find(s => s.id === s1)?.entries.length, 1);
    });

    it('marks conversations with active runs as non-empty in store', () => {
        const sid = chatStore.bindConversation('conv-live');
        assert.equal(chatStore.isConversationEmptyInStore('conv-live'), true);

        const ctrl = new AbortController();
        chatStore.beginConversationRun('conv-live', ctrl);
        assert.equal(chatStore.isConversationEmptyInStore('conv-live'), false);

        // New chat minted while conv-live is running must NOT hijack conv-live's session
        const nextSid = chatStore.bindConversation('conv-next');
        assert.notEqual(nextSid, sid);
        assert.equal(chatStore.getSnapshot().activeId, nextSid);

        chatStore.endConversationRunOwned('conv-live', ctrl);
        assert.equal(chatStore.isConversationEmptyInStore('conv-live'), true);
    });
});

describe('sseParser — reasoning deltas across all four wire formats', () => {
    it('extracts reasoning_content, reasoning, and reasoning_details arrays while preserving whitespace', () => {
        const parser = createSseParser('chat_completions');
        const out = parser.push(
            'data: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"reasoning":"\\n"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"reasoning_details":[{"text":"Step 2"}]}}]}\n\n'
            + 'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n'
            + 'data: [DONE]\n\n',
        );
        assert.deepEqual(out.events, [
            { type: 'reasoning', delta: 'Step 1' },
            { type: 'reasoning', delta: '\n' },
            { type: 'reasoning', delta: 'Step 2' },
            { type: 'text', delta: 'Answer.' },
        ]);
        assert.equal(out.done, true);
    });

    it('keeps reasoning_details after an empty alias on the same desktop chunk as tool calls', () => {
        const parser = createSseParser('chat_completions');
        const out = parser.push(
            'data: {"choices":[{"delta":{"reasoning_content":"","reasoning_details":[{"type":"reasoning.text","text":"Read. "},{"type":"reasoning.summary","summary":"Compare."}],"tool_calls":[{"index":0,"id":"call_desktop","type":"function","function":{"name":"get_trade_log","arguments":"{}"}}]}}]}\n\n'
            + 'data: [DONE]\n\n',
        );
        assert.deepEqual(out.events, [{ type: 'reasoning', delta: 'Read. Compare.' }]);
        const tail = parser.finish();
        assert.deepEqual(tail.toolCalls.map(call => call.name), ['get_trade_log']);
    });

    it('reads a bare buffered JSON message without losing reasoning or tool calls', () => {
        const parser = createSseParser('chat_completions');
        const batch = parser.push(JSON.stringify({
            choices: [{
                message: {
                    reasoning_content: '',
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
        const tail = parser.finish();
        assert.deepEqual([...batch.events, ...tail.events], [
            { type: 'reasoning', delta: 'Buffered thought.' },
            { type: 'text', delta: 'Buffered answer.' },
        ]);
        assert.deepEqual(tail.toolCalls.map(call => call.name), ['get_trade_log', 'get_session_context']);
        assert.deepEqual(tail.toolCalls[1].arguments, { coin: 'BTCUSDT' });
    });

    it('extracts Anthropic messages thinking_delta events', () => {
        const parser = createSseParser('messages');
        const out = parser.push(
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Analyzing liquidity"}}\n\n'
            + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bullish above 68k."}}\n\n',
        );
        assert.deepEqual(out.events, [
            { type: 'reasoning', delta: 'Analyzing liquidity' },
            { type: 'text', delta: 'Bullish above 68k.' },
        ]);
    });

    it('extracts OpenAI responses reasoning_summary_text.delta events', () => {
        const parser = createSseParser('responses');
        const out = parser.push(
            'data: {"type":"response.reasoning_summary_text.delta","delta":"Checking OI"} \n\n'
            + 'data: {"type":"response.output_text.delta","delta":"Hold short."}\n\n'
            + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
        );
        assert.deepEqual(out.events, [
            { type: 'reasoning', delta: 'Checking OI' },
            { type: 'text', delta: 'Hold short.' },
        ]);
        assert.equal(out.done, true);
    });

    it('extracts Gemini thought parts vs answer parts cleanly', () => {
        const parser = createSseParser('gemini');
        const out = parser.push(
            'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Evaluating sweep"},{"text":"Wait for reclaim."}]}}]}\n\n',
        );
        assert.deepEqual(out.events, [
            { type: 'reasoning', delta: 'Evaluating sweep' },
            { type: 'text', delta: 'Wait for reclaim.' },
        ]);
    });
});

describe('thinkingSplit & streamBlocks — live tag peeling and markdown block stability', () => {
    it('routes split <think> tags across chunks cleanly with zero leaked tags', () => {
        const gate = createThinkingStreamGate();
        const chunks = ['<thi', 'nk>Checking 15m', ' sweep.</thi', 'nk>Bias is ', '**bullish**.'];
        let visible = '';
        let thinking = '';
        for (const c of chunks) {
            const res = gate.push(c);
            visible += res.visible;
            thinking += res.thinking;
        }
        const tail = gate.flush();
        visible += tail.visible;
        thinking += tail.thinking;
        assert.equal(thinking, 'Checking 15m sweep.');
        assert.equal(visible, 'Bias is **bullish**.');
        assert.equal(visible.includes('<think'), false);
    });

    it('keeps fenced code blocks intact across blank lines while splitting prose paragraphs', () => {
        const sample = [
            'First paragraph.',
            '',
            '```ts',
            'const a = 1;',
            '',
            'const b = 2;',
            '```',
            '',
            'Trailing prose without markup',
        ].join('\n');

        const { committed, active } = splitStableMarkdownBlocks(sample);
        assert.equal(committed.length, 2);
        assert.equal(committed[0], 'First paragraph.');
        assert.ok(committed[1].includes('const a = 1;\n\nconst b = 2;'));
        assert.equal(active, 'Trailing prose without markup');
        assert.equal(canRenderPlainStreamingProse(active), true);
        assert.equal(canRenderPlainStreamingProse('**Bold** level'), false);
        assert.equal(canRenderPlainStreamingProse('- Bullet item'), false);
    });
});

describe('createBrowserSseParser — incremental SSE reasoning across dialects', () => {
    it('extracts reasoning_content, reasoning, reasoning_text, thinking, reasoning_details and split <think> chunks incrementally', () => {
        const parser = createBrowserSseParser('chat_completions');
        const chunks = [
            'data: {"choices":[{"delta":{"reasoning_content":"R1 "}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning":"R2 "}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_text":"R3 "}}]}\n\n',
            'data: {"choices":[{"delta":{"thinking":"R4 "}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_details":[{"text":"R5 "}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"nk>R6</thi"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"nk>Out 1 "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Out 2"}}]}\n\n',
            'data: [DONE]\n\n',
        ];
        const reasoning: string[] = [];
        const text: string[] = [];
        for (const chunk of chunks) {
            const b = parser.push(chunk);
            reasoning.push(...b.reasoningDeltas);
            text.push(...b.textDeltas);
        }
        const tail = parser.flush();
        reasoning.push(...tail.reasoningDeltas);
        text.push(...tail.textDeltas);
        assert.equal(reasoning.join(''), 'R1 R2 R3 R4 R5 R6');
        assert.equal(text.join(''), 'Out 1 Out 2');
    });

    it('streams Anthropic thinking_delta and Google thought parts without buffering', () => {
        const msgParser = createBrowserSseParser('messages');
        const b1 = msgParser.push('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Step A"}}\n\n');
        assert.deepEqual(b1.reasoningDeltas, ['Step A']);
        assert.deepEqual(b1.textDeltas, []);
        const b2 = msgParser.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Final A"}}\n\n');
        assert.deepEqual(b2.textDeltas, ['Final A']);

        const gemParser = createBrowserSseParser('google');
        const g1 = gemParser.push('data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Check B"}]}}]}\n\n');
        assert.deepEqual(g1.reasoningDeltas, ['Check B']);
        const g2 = gemParser.push('data: {"candidates":[{"content":{"parts":[{"text":"Final B"}]}}]}\n\n');
        assert.deepEqual(g2.textDeltas, ['Final B']);
    });
});

describe('runDeskToolLoop — strict Thinking -> Tool -> Output chronological callback order', () => {
    it('emits onReasoning -> onToolStart -> onToolEnd -> onToken across a multi-round turn', async () => {
        const cfg: ProviderConfig = {
            id: 'test-prov',
            name: 'Test',
            apiKey: 'test-key',
            baseUrl: 'https://example.invalid/v1',
            apiFormat: 'chat_completions',
            isEnabled: true,
            isBuiltIn: false,
            models: ['test-model'],
            selectedModel: 'test-model',
        };
        const timeline: string[] = [];
        let round = 0;
        const result = await runDeskToolLoop({
            config: cfg,
            messages: [{ role: 'user', content: 'Check ETH bias' }],
            nativeTools: true,
            allowedTools: 'all',
            options: {
                onReasoning: chunk => timeline.push(`reasoning:${chunk.trim()}`),
            },
            onStreamReset: () => timeline.push('reset'),
            onToolStart: call => timeline.push(`toolStart:${call.name}`),
            onToolEnd: res => timeline.push(`toolEnd:${res.name}`),
            onToken: tok => timeline.push(`token:${tok}`),
            executeExtraTool: async call => {
                timeline.push(`exec:${call.name}`);
                return { toolCallId: call.id, name: call.name, ok: true, content: `ok:${call.name}` };
            },
            sendTurn: async () => {
                throw new Error('sendTurn should not be called when streamTurn is supplied');
            },
            streamTurn: async function* (_cfg, _msgs, opts) {
                round += 1;
                if (round === 1) {
                    yield 'Plain pre-tool note.';
                    opts?.onReasoning?.('Think round 1');
                    opts?.onFinishReason?.('tool_calls');
                    opts?.onStreamToolCalls?.([{ id: 'c1', name: 'tool_one', arguments: {} }]);
                    return;
                }
                if (round === 2) {
                    opts?.onReasoning?.('Think round 2');
                    opts?.onFinishReason?.('tool_calls');
                    opts?.onStreamToolCalls?.([{ id: 'c2', name: 'tool_two', arguments: {} }]);
                    return;
                }
                opts?.onReasoning?.('Think round 3');
                yield 'Final ';
                yield 'Answer';
                opts?.onFinishReason?.('stop');
            },
        });
        assert.equal(result.finalText, 'Final Answer');
        assert.equal(result.reasoning, 'Think round 1\nPlain pre-tool note.\nThink round 2\nThink round 3');
        assert.deepEqual(timeline, [
            'token:Plain pre-tool note.',
            'reasoning:Think round 1',
            'reasoning:Plain pre-tool note.',
            'reset',
            'toolStart:tool_one',
            'exec:tool_one',
            'toolEnd:tool_one',
            'reasoning:Think round 2',
            'reset',
            'toolStart:tool_two',
            'exec:tool_two',
            'toolEnd:tool_two',
            'reasoning:Think round 3',
            'token:Final ',
            'token:Answer',
        ]);
    });

    it('retains preamble prose on a cache-replay tool round', async () => {
        const cfg: ProviderConfig = {
            id: 'test-prov', name: 'Test', apiKey: 'test-key',
            baseUrl: 'https://example.invalid/v1', apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false, models: ['test-model'], selectedModel: 'test-model',
        };
        let round = 0;
        const result = await runDeskToolLoop({
            config: cfg,
            messages: [{ role: 'user', content: 'Check session context twice' }],
            nativeTools: true,
            allowedTools: 'all',
            sendTurn: async () => {
                throw new Error('sendTurn should not be called when streamTurn is supplied');
            },
            streamTurn: async function* (_cfg, _msgs, opts) {
                round += 1;
                if (round <= 2) {
                    if (round === 2) yield 'Cached replay preamble.';
                    opts?.onReasoning?.(`Think cache round ${round}`);
                    opts?.onFinishReason?.('tool_calls');
                    opts?.onStreamToolCalls?.([{
                        id: `cache-${round}`, name: 'get_session_context', arguments: {},
                    }]);
                    return;
                }
                opts?.onReasoning?.('Think final round');
                yield 'Final Answer';
                opts?.onFinishReason?.('stop');
            },
        });
        assert.equal(result.finalText, 'Final Answer');
        assert.match(result.reasoning, /Think cache round 1/);
        assert.match(result.reasoning, /Think cache round 2\nCached replay preamble\./);
        assert.match(result.reasoning, /Think final round/);
    });
});

describe('thinking gate — exhaustive inline dialects, split tags, math and transport parity', () => {
    const drive = (chunks: string[]) => {
        const gate = createThinkingStreamGate();
        let visible = '';
        let thinking = '';
        let orphanClose = false;
        const perChunk: string[] = [];
        for (const chunk of chunks) {
            const res = gate.push(chunk);
            visible += res.visible;
            thinking += res.thinking;
            if (res.orphanClose) orphanClose = true;
            perChunk.push(res.visible);
        }
        const tail = gate.flush();
        visible += tail.visible;
        thinking += tail.thinking;
        return { visible, thinking, orphanClose, perChunk };
    };
    const noTagLeak = (text: string): boolean => !/<\/?(?:think|thinking|thought|reasoning|REASONING_SCRATCHPAD|redacted_thinking)\b|<\|(?:begin_of_thought|end_of_thought|\/?think|\/?thought)\|>/i.test(text);

    it('captures every inline reasoning dialect across arbitrary mid-tag chunk splits', () => {
        const dialects: Array<{ name: string; open: string[]; close: string[]; body: string; answer: string }> = [
            { name: 'think', open: ['<thi', 'nk>'], close: ['</thi', 'nk>'], body: 'R1 plan', answer: 'A1 done.' },
            { name: 'thinking', open: ['<thin', 'king>'], close: ['</thin', 'king>'], body: 'R2 plan', answer: 'A2 done.' },
            { name: 'thought', open: ['<thou', 'ght>'], close: ['</thou', 'ght>'], body: 'R3 plan', answer: 'A3 done.' },
            { name: 'reasoning', open: ['<reas', 'oning>'], close: ['</reas', 'oning>'], body: 'R4 plan', answer: 'A4 done.' },
            { name: 'pipe-thought', open: ['<|tho', 'ught|>'], close: ['<|/tho', 'ught|>'], body: 'R5 plan', answer: 'A5 done.' },
            { name: 'pipe-think', open: ['<|thi', 'nk|>'], close: ['<|/thi', 'nk|>'], body: 'R6 plan', answer: 'A6 done.' },
            { name: 'case-and-attribute', open: ['<Thin', 'king class="x">'], close: ['</thin', 'king>'], body: 'R7 plan', answer: 'A7 done.' },
        ];
        for (const d of dialects) {
            const r = drive([...d.open, d.body, ...d.close, d.answer]);
            assert.equal(r.thinking, d.body, `${d.name}: thinking body`);
            assert.equal(r.visible, d.answer, `${d.name}: visible answer`);
            assert.equal(noTagLeak(r.visible), true, `${d.name}: no tag in answer`);
            assert.equal(noTagLeak(r.thinking), true, `${d.name}: no tag in thinking`);
            assert.equal(r.perChunk[0], '', `${d.name}: no partial tag painted live`);
        }
    });

    it('releases non-tag < as soon as the next character rules out a tag prefix', () => {
        const r = drive(['BTC <', ' 60000 and R:R <', ' 2.0 (p <', ' 0.05)', ' and <t', 'arget done']);
        assert.equal(r.visible, 'BTC < 60000 and R:R < 2.0 (p < 0.05) and <target done');
        assert.equal(r.thinking, '');
        assert.equal(r.perChunk[4], ' and ');
        assert.equal(r.perChunk[5], '<target done');
        assert.equal(noTagLeak(r.visible), true);
    });

    it('holds a complete tag name whose > arrives in the next chunk, without swallowing later prose', () => {
        for (const [open, close] of [
            ['<thinking', '</thinking>'], ['<think', '</think>'], ['<thought', '</thought>'],
            ['<reasoning', '</reasoning>'], ['<|thought|', '<|/thought|>'],
        ]) {
            const r = drive([open, '>hidden', close, 'Answer']);
            assert.equal(r.perChunk[0], '', `${open}: a name-only chunk must stay buffered`);
            assert.equal(r.thinking, 'hidden', `${open}: reasoning body`);
            assert.equal(r.visible, 'Answer', `${open}: visible answer`);
            assert.equal(noTagLeak(r.visible), true, `${open}: no raw tag in the answer`);
        }
        const orphan = drive(['Let me think...', '</thinking', '\nBias is bullish']);
        assert.ok(orphan.visible.includes('Bias is bullish'), 'a name-only orphan close must not swallow the answer');
    });

    it('promotes an orphan closing tag to reasoning and keeps the answer tag-free', () => {
        const r = drive(['Let me check support first...', '</thinking>', '\nBias is bullish']);
        assert.equal(r.orphanClose, true);
        assert.equal(r.visible.includes('</thinking>'), false);
        const settled = splitThinkingFromOutput('', 'Let me check support first...</thinking>\nBias is bullish');
        assert.equal(settled.thinking, 'Let me check support first...');
        assert.equal(settled.output, 'Bias is bullish');
    });

    it('keeps an unclosed thinking block inside reasoning at stream end', () => {
        const r = drive(['<thinking>', 'still thinking', ' and more']);
        assert.equal(r.visible, '');
        assert.equal(r.thinking, 'still thinking and more');
        assert.equal(noTagLeak(r.visible), true);
    });

    it('preserves multi-block thinking without duplication on a tool-loop turn', () => {
        const r = drive(['<thinking>round 1 plan</thinking>', 'Answer 1 ', '<thinking>round 2 synthesis</thinking>', 'Final answer']);
        assert.equal(r.thinking, 'round 1 planround 2 synthesis');
        assert.equal(r.visible, 'Answer 1 Final answer');
    });

    it('settled parser strips pipe-thought pairs and orphan pipe tokens', () => {
        const paired = extractAndStripThinkBlocks('<|thought|>hidden<|/thought|>Shown');
        assert.deepEqual([paired.visible, paired.leaked], ['Shown', 'hidden']);
        const orphan = extractAndStripThinkBlocks('...hidden<|/thought|>Shown');
        assert.equal(orphan.visible, '...hiddenShown');
        assert.equal(noTagLeak(orphan.visible), true);
    });

    it('browser proxy and Electron bridge produce identical reasoning/answer for mid-split inline tags', () => {
        const browser = createBrowserSseParser('chat_completions');
        const electron = createSseParser('chat_completions');
        const bridgeGate = createThinkingStreamGate();
        let bText = '', bReason = '', eText = '', eReason = '';
        const feed = (payload: string): void => {
            const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`;
            const batch = browser.push(frame);
            bText += batch.textDeltas.join('');
            bReason += batch.reasoningDeltas.join('');
            const parsed = electron.push(frame);
            for (const ev of parsed.events) {
                if (ev.type === 'reasoning') eReason += ev.delta ?? '';
                else if (ev.type === 'text') {
                    const gated = bridgeGate.push(ev.delta ?? '');
                    eText += gated.visible;
                    eReason += gated.thinking;
                }
            }
        };
        for (const chunk of ['<thin', 'king>R1</thin', 'king>Answer']) feed(chunk);
        const bt = browser.flush(), ef = electron.finish(), bf = bridgeGate.flush();
        bText += bt.textDeltas.join(''); bReason += bt.reasoningDeltas.join('');
        eText += bf.visible; eReason += bf.thinking;
        assert.equal(bText, 'Answer');
        assert.equal(bReason, 'R1');
        assert.equal(eText, bText, 'Electron visible text matches browser');
        assert.equal(eReason, bReason, 'Electron reasoning matches browser');
        assert.equal(ef.toolCalls.length, 0);
    });
});