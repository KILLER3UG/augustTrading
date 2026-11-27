/**
 * v18StreamingMotion.test.ts — offline unit tests for pure streaming cores:
 *   - markdownBlocksCore (splitStableMarkdownBlocks, canRenderPlainStreamingProse, appendStreamChunk)
 *   - streamCoalescerCore (createDeltaCoalescer)
 *   - chatStore sidebar metadata isolation (subscribeSidebarMeta ignores streaming deltas)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    appendStreamChunk,
    canRenderPlainStreamingProse,
    splitStableMarkdownBlocks,
    type StreamFadeChunk,
} from '../src/utils/markdownBlocksCore';
import {
    createDeltaCoalescer,
    type CoalescedDeltaBatch,
} from '../src/utils/streamCoalescerCore';
import * as chatStore from '../src/services/trade/chatStore';

describe('markdownBlocksCore — splitStableMarkdownBlocks', () => {
    it('returns empty split for empty input and keeps single growing paragraph in activeTail', () => {
        assert.deepEqual(splitStableMarkdownBlocks(''), { stableBlocks: [], activeTail: '' });
        assert.deepEqual(splitStableMarkdownBlocks('BTC is coiling near 61k.'), {
            stableBlocks: [],
            activeTail: 'BTC is coiling near 61k.',
        });
    });

    it('splits completed paragraphs on blank lines while keeping activeTail separate', () => {
        const md = 'First paragraph.\n\nSecond paragraph.\n\nThird in flight';
        const res = splitStableMarkdownBlocks(md);
        assert.deepEqual(res.stableBlocks, ['First paragraph.', 'Second paragraph.']);
        assert.equal(res.activeTail, 'Third in flight');
    });

    it('keeps unclosed backtick and tilde fenced code blocks intact across blank lines', () => {
        const unclosedBackticks = 'Intro paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;';
        const r1 = splitStableMarkdownBlocks(unclosedBackticks);
        assert.deepEqual(r1.stableBlocks, ['Intro paragraph.']);
        assert.equal(r1.activeTail, '```ts\nconst a = 1;\n\nconst b = 2;');

        const closedBackticks = `${unclosedBackticks}\n\`\`\`\n\nFollow-up note`;
        const r2 = splitStableMarkdownBlocks(closedBackticks);
        assert.deepEqual(r2.stableBlocks, [
            'Intro paragraph.',
            '```ts\nconst a = 1;\n\nconst b = 2;\n```',
        ]);
        assert.equal(r2.activeTail, 'Follow-up note');

        const unclosedTilde = '~~~json\n{"entry": 60500}\n\n{"stop": 59800}';
        const r3 = splitStableMarkdownBlocks(unclosedTilde);
        assert.deepEqual(r3.stableBlocks, []);
        assert.equal(r3.activeTail, unclosedTilde);
    });

    it('keeps markdown tables intact while streaming and flushes cleanly once terminated', () => {
        const streamingTable = [
            'Levels:',
            '',
            '| Level | Price | Role |',
            '| --- | --- | --- |',
            '| Entry | 60600 | Trigger |',
        ].join('\n');
        const r1 = splitStableMarkdownBlocks(streamingTable);
        assert.deepEqual(r1.stableBlocks, ['Levels:']);
        assert.equal(
            r1.activeTail,
            '| Level | Price | Role |\n| --- | --- | --- |\n| Entry | 60600 | Trigger |',
        );

        const afterTable = `${streamingTable}\n\nNext paragraph.`;
        const r2 = splitStableMarkdownBlocks(afterTable);
        assert.equal(r2.stableBlocks.length, 2);
        assert.equal(r2.stableBlocks[1], '| Level | Price | Role |\n| --- | --- | --- |\n| Entry | 60600 | Trigger |');
        assert.equal(r2.activeTail, 'Next paragraph.');
    });

    it('keeps loose lists and multi-paragraph blockquotes coherent across blank lines', () => {
        const looseList = '- Item one\n\n- Item two\n\nClosing thought';
        const r1 = splitStableMarkdownBlocks(looseList);
        assert.deepEqual(r1.stableBlocks, ['- Item one\n\n- Item two']);
        assert.equal(r1.activeTail, 'Closing thought');

        const quote = '> Line 1\n>\n> Line 2\n\nAfter quote';
        const r2 = splitStableMarkdownBlocks(quote);
        assert.deepEqual(r2.stableBlocks, ['> Line 1\n>\n> Line 2']);
        assert.equal(r2.activeTail, 'After quote');
    });

    it('splits a 20KB+ mixed markdown document in < 50ms (O(N) single pass)', () => {
        const chunk = [
            '## Market Regime Analysis',
            '',
            'BTCUSDT spot bid absorption holds near 60,400 while perpetual funding stays neutral.',
            '',
            '| Level | Price | Note |',
            '| --- | --- | --- |',
            '| Trigger | 61000 | Range high break |',
            '| Stop | 60250 | Below sweep low |',
            '',
            '```json',
            '{"symbol":"BTCUSDT","side":"long","rr":2.4}',
            '```',
            '',
        ].join('\n');
        const bigDoc = chunk.repeat(70); // > 20KB
        assert.ok(bigDoc.length > 20_000, `expected >20KB doc, got ${bigDoc.length}`);

        const t0 = performance.now();
        const res = splitStableMarkdownBlocks(bigDoc);
        const elapsedMs = performance.now() - t0;

        assert.ok(res.stableBlocks.length > 100);
        assert.ok(elapsedMs < 50, `expected <50ms, took ${elapsedMs.toFixed(2)}ms`);
    });
});

describe('markdownBlocksCore — canRenderPlainStreamingProse', () => {
    it('identifies plain streaming prose vs markdown syntax', () => {
        assert.equal(canRenderPlainStreamingProse(''), false);
        assert.equal(canRenderPlainStreamingProse('Price is holding above VWAP with steady spot bids.'), true);
        assert.equal(canRenderPlainStreamingProse('**Bold** level at 61000'), false);
        assert.equal(canRenderPlainStreamingProse('## Heading'), false);
        assert.equal(canRenderPlainStreamingProse('- Bullet item'), false);
        assert.equal(canRenderPlainStreamingProse('| Col A | Col B |'), false);
        assert.equal(canRenderPlainStreamingProse('Use `present_trade` here'), false);
    });
});

describe('markdownBlocksCore — appendStreamChunk', () => {
    it('coalesces deltas inside windowMs without changing chunk id and opens new chunk after windowMs', () => {
        let chunks: StreamFadeChunk[] = [];
        chunks = appendStreamChunk(chunks, 'Hello', 1000, 60, 8);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].id, 1);
        assert.equal(chunks[0].text, 'Hello');

        // Within 60ms window -> coalesced onto chunk 1
        chunks = appendStreamChunk(chunks, 'Hello world', 1030, 60, 8);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].id, 1);
        assert.equal(chunks[0].text, 'Hello world');

        // Outside 60ms window -> new chunk id=2
        chunks = appendStreamChunk(chunks, 'Hello world!', 1080, 60, 8);
        assert.equal(chunks.length, 2);
        assert.equal(chunks[0].id, 1);
        assert.equal(chunks[1].id, 2);
        assert.equal(chunks[1].text, '!');
        assert.equal(chunks.map(c => c.text).join(''), 'Hello world!');
    });

    it('caps total chunks to maxChunks by folding overflow into id=0 settled prefix', () => {
        let chunks: StreamFadeChunk[] = [];
        let full = '';
        for (let i = 1; i <= 15; i += 1) {
            full += `t${i} `;
            chunks = appendStreamChunk(chunks, full, i * 100, 60, 5);
        }
        assert.equal(chunks.length, 5);
        assert.equal(chunks[0].id, 0);
        assert.equal(chunks.map(c => c.text).join(''), full);
        // Active trailing chunk ids stay strictly increasing
        for (let i = 2; i < chunks.length; i += 1) {
            assert.ok(chunks[i].id > chunks[i - 1].id);
        }
    });

    it('resets cleanly when fullText shrinks or diverges', () => {
        let chunks = appendStreamChunk([], 'Initial turn text', 100, 60, 8);
        chunks = appendStreamChunk(chunks, 'Fresh turn', 200, 60, 8);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].text, 'Fresh turn');
        assert.equal(chunks[0].id, 2);
        assert.deepEqual(appendStreamChunk(chunks, '', 300, 60, 8), []);
    });
});

describe('streamCoalescerCore — createDeltaCoalescer', () => {
    it('coalesces 20 rapid synchronous deltas into 1 scheduled frame and 1 flush with zero char loss', () => {
        const batches: CoalescedDeltaBatch[] = [];
        const queue: Array<() => void> = [];
        let scheduleCount = 0;
        let cancelCount = 0;

        const coalescer = createDeltaCoalescer({
            onFlush: b => batches.push(b),
            schedule: cb => {
                scheduleCount += 1;
                queue.push(cb);
                return scheduleCount;
            },
            cancel: () => {
                cancelCount += 1;
                queue.length = 0;
            },
        });

        let expectedText = '';
        let expectedReasoning = '';
        for (let i = 1; i <= 20; i += 1) {
            expectedText += `tok${i} `;
            expectedReasoning += `r${i}|`;
            coalescer.setText(expectedText);
            coalescer.appendReasoning(`r${i}|`);
        }

        assert.equal(scheduleCount, 1, '20 synchronous updates must schedule exactly 1 frame');
        assert.equal(batches.length, 0, 'must not emit synchronously before frame fires');
        assert.equal(coalescer.hasPending(), true);

        // Fire the single scheduled frame
        queue.shift()?.();
        assert.equal(batches.length, 1);
        assert.equal(batches[0].text, expectedText);
        assert.equal(batches[0].reasoningDelta, expectedReasoning);
        assert.equal(coalescer.hasPending(), false);
        assert.equal(cancelCount, 0);
    });

    it('flush() cancels pending frame and emits immediately at tool/finish boundaries', () => {
        const batches: CoalescedDeltaBatch[] = [];
        let scheduledId = 0;
        let cancelledId = -1;

        const coalescer = createDeltaCoalescer({
            onFlush: b => batches.push(b),
            schedule: () => {
                scheduledId += 1;
                return scheduledId;
            },
            cancel: id => {
                cancelledId = id;
            },
        });

        coalescer.appendText('Part A ');
        coalescer.appendText('Part B');
        coalescer.setReasoning('Full thinking snapshot');
        assert.equal(coalescer.hasPending(), true);

        coalescer.flush();
        assert.equal(cancelledId, 1);
        assert.equal(batches.length, 1);
        assert.equal(batches[0].text, 'Part A Part B');
        assert.equal(batches[0].reasoningFull, 'Full thinking snapshot');
        assert.equal(coalescer.hasPending(), false);

        // Second flush is a no-op
        coalescer.flush();
        assert.equal(batches.length, 1);
    });

    it('cancel() drops buffered state and prevents emission', () => {
        const batches: CoalescedDeltaBatch[] = [];
        let cancelled = false;
        const coalescer = createDeltaCoalescer({
            onFlush: b => batches.push(b),
            schedule: () => 42,
            cancel: id => { if (id === 42) cancelled = true; },
        });

        coalescer.setText('aborted text');
        coalescer.appendReasoning('aborted thought');
        coalescer.cancel();

        assert.equal(cancelled, true);
        assert.equal(coalescer.hasPending(), false);
        coalescer.flush();
        assert.equal(batches.length, 0);
    });
});

describe('chatStore — subscribeSidebarMeta streaming isolation', () => {
    beforeEach(() => {
        chatStore.__resetForTests();
    });

    it('does not notify sidebar listeners on streaming ephemeral text/reasoning deltas, but notifies on structural metadata changes', () => {
        const g = globalThis as unknown as Record<string, unknown>;
        const prevWindow = g.window;
        if (typeof g.window === 'undefined') {
            g.window = {
                setTimeout,
                clearTimeout,
                addEventListener: () => {},
                removeEventListener: () => {},
            };
        }
        try {
            const sid = chatStore.bindConversation('conv-sidebar-iso', { symbol: 'BTCUSDT', interval: '15m' });
            chatStore.mutate(sid, s => ({
                ...s,
                entries: [{ id: 'a-1', role: 'ai', text: '', reasoning: '', tools: [], streaming: true }],
            }));

            // Prime snapshot
            const before = chatStore.getSidebarMetaSnapshot();
            assert.ok(before.sessions.some(s => s.id === sid), 'bound session must appear in sidebar meta');
            const beforeCount = before.sessions.length;

            let sidebarNotifies = 0;
            const unsub = chatStore.subscribeSidebarMeta(() => {
                sidebarNotifies += 1;
            });

            // Simulate 30 synchronous streaming text & reasoning updates + flushEphemeral
            for (let i = 1; i <= 30; i += 1) {
                chatStore.mutateEphemeral(sid, s => ({
                    ...s,
                    entries: s.entries.map(e => (e.id === 'a-1'
                        ? { ...e, text: `${e.text}w${i} `, reasoning: `${e.reasoning ?? ''}t${i} ` }
                        : e)),
                }));
                chatStore.flushEphemeral(sid);
            }

            assert.equal(sidebarNotifies, 0, 'streaming text/reasoning deltas must trigger 0 sidebar notifications');

            // Structural change (new session) MUST notify sidebar
            const sid2 = chatStore.bindConversation('conv-sidebar-iso-2', { symbol: 'ETHUSDT', interval: '1h' });
            assert.ok(sidebarNotifies >= 1, 'adding a session must notify sidebar subscribers');
            const after = chatStore.getSidebarMetaSnapshot();
            assert.ok(after.sessions.some(s => s.id === sid2), 'new session must appear in sidebar meta');
            assert.ok(after.sessions.length >= beforeCount + 1);

            unsub();
        } finally {
            if (prevWindow === undefined) {
                delete g.window;
            } else {
                g.window = prevWindow;
            }
        }
    });
});
