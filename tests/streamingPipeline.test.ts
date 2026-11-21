import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createBrowserSseParser } from '../src/services/providers/GenericProviderService';
import { __futuresRateLimitTestHooks } from '../src/services/analysis/MarketDataService';
import { executeDeskTool, streamChatWithDeskTools } from '../src/services/analysis/DeskToolsService';
import { initMemoryFiles } from '../src/services/learning/MemoryFilesService';
import { deleteSkillFile, skillIndexRows, usableSkillRows } from '../src/services/learning/SkillFileService';
import { seedBundledSkills } from '../src/services/learning/bundledSkills';

const require = createRequire(import.meta.url);
const { createSseParser } = require('../electron/sseParser.cjs') as {
    createSseParser: (apiFormat: string) => {
        push: (chunk: string) => { events: Array<{ type: string; delta?: string; message?: string }>; done: boolean };
        finish: () => { events: Array<{ type: string; delta?: string }>; done: boolean; toolCalls: unknown[]; usage: unknown; sawData: boolean };
    };
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const withMemoryStorage = async (user: string, fn: () => Promise<void>): Promise<void> => {
    const store = new Map<string, string>();
    const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { localStorage: Storage }).localStorage = {
        get length() { return store.size; },
        clear() { store.clear(); },
        getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
        key(i: number) { return [...store.keys()][i] ?? null; },
        removeItem(k: string) { store.delete(k); },
        setItem(k: string, v: string) { store.set(k, String(v)); },
    };
    if (prevWindow === undefined) (globalThis as { window?: unknown }).window = globalThis;
    localStorage.setItem('last_active_user', user);
    try {
        await fn();
    } finally {
        if (prevStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
        else (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
        if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = prevWindow;
    }
};

describe('Streaming SSE parsers — multi-format & Electron parity', () => {
    it('createBrowserSseParser parses OpenAI/OpenRouter reasoning + reasoning_details + array parts incrementally', () => {
        const parser = createBrowserSseParser('chat_completions');

        const b1 = parser.push('data: {"choices":[{"delta":{"reasoning":"Step 1. "}}]}\n\n');
        assert.deepEqual(b1.reasoningDeltas, ['Step 1. ']);
        assert.deepEqual(b1.textDeltas, []);

        const b2 = parser.push('data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Step 2. "}]}}]}\n\n');
        assert.deepEqual(b2.reasoningDeltas, ['Step 2. ']);

        const b3 = parser.push('data: {"choices":[{"delta":{"content":[{"type":"reasoning","text":"Step 3. "},{"type":"text","text":"Answer "}]}}]}\n\n');
        assert.deepEqual(b3.reasoningDeltas, ['Step 3. ']);
        assert.deepEqual(b3.textDeltas, ['Answer ']);

        // Mid-tag <think> split across chunks must route cleanly to reasoning without leaking markup.
        const b4 = parser.push('data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n');
        assert.deepEqual(b4.textDeltas, []);
        const b5 = parser.push('data: {"choices":[{"delta":{"content":"nk>inner</thi"}}]}\n\n');
        assert.deepEqual(b5.reasoningDeltas, ['inner']);
        const b6 = parser.push('data: {"choices":[{"delta":{"content":"nk>done"}}]}\n\n');
        assert.deepEqual(b6.textDeltas, ['done']);

        const tail = parser.flush();
        assert.deepEqual(tail.textDeltas, []);
        assert.deepEqual(tail.reasoningDeltas, []);
    });

    it('createBrowserSseParser parses Anthropic thinking_delta and Google thought:true parts incrementally', () => {
        const anth = createBrowserSseParser('messages');
        const a1 = anth.push('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check liquidity. "}}\n\n');
        assert.deepEqual(a1.reasoningDeltas, ['Check liquidity. ']);
        const a2 = anth.push('data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Setup confirmed."}}\n\n');
        assert.deepEqual(a2.textDeltas, ['Setup confirmed.']);

        const gem = createBrowserSseParser('google');
        const g1 = gem.push('data: {"candidates":[{"content":{"parts":[{"text":"Scanning regime...","thought":true}]}}]}\n\n');
        assert.deepEqual(g1.reasoningDeltas, ['Scanning regime...']);
        const g2 = gem.push('data: {"candidates":[{"content":{"parts":[{"text":"Final level: 65000."}]}}]}\n\n');
        assert.deepEqual(g2.textDeltas, ['Final level: 65000.']);
    });

    it('electron/sseParser handles apiFormat "google" thought and text parts', () => {
        const parser = createSseParser('google');
        const o1 = parser.push('data: {"candidates":[{"content":{"parts":[{"text":"Thinking step","thought":true},{"text":"Visible answer"}]}}]}\n\n');
        assert.deepEqual(o1.events, [
            { type: 'reasoning', delta: 'Thinking step' },
            { type: 'text', delta: 'Visible answer' },
        ]);
        const fin = parser.finish();
        assert.equal(fin.sawData, true);
    });
});

describe('DeskToolsService — Wave A-C model visibility & stream continuity', () => {
    it('all Wave A-C market fields survive executeDeskTool without budget clipping', async () => {
        const now = Date.now();
        const klines = Array.from({ length: 220 }, (_, i) => {
            const t = now - (220 - i) * 3_600_000;
            const base = 60_000 + i * 25 + Math.sin(i * 0.4) * 180;
            let o = base;
            let h = base + 220;
            let l = base - 160;
            let c = base + 90;
            if (i === 214) { o = base; h = base + 50; l = base - 50; c = base + 30; }
            if (i === 215) { o = base + 40; h = base + 900; l = base + 30; c = base + 850; }
            if (i === 216) { o = base + 830; h = base + 950; l = base + 450; c = base + 900; }
            return [t, o.toFixed(2), h.toFixed(2), l.toFixed(2), c.toFixed(2), '123.45', t + 3_599_000, '7400000', 420, '68.12', '4080000', '0'];
        });
        const prevFetch = globalThis.fetch;
        const mockFetch = async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/fapi/v1/exchangeInfo')) return new Response(JSON.stringify({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }] }), { status: 200 });
            if (url.includes('/fapi/v1/klines') || url.includes('/api/v3/klines')) return new Response(JSON.stringify(klines), { status: 200 });
            if (url.includes('/fapi/v1/premiumIndex')) return new Response(JSON.stringify({ symbol: 'BTCUSDT', markPrice: '65500', indexPrice: '65490', lastFundingRate: '0.0001', nextFundingTime: now + 3_600_000 }), { status: 200 });
            if (url.includes('/fapi/v1/fundingInfo')) return new Response(JSON.stringify([{ symbol: 'BTCUSDT', fundingIntervalHours: 8 }]), { status: 200 });
            if (url.includes('/fapi/v1/depth')) return new Response(JSON.stringify({ lastUpdateId: 1, bids: Array.from({ length: 20 }, (_, i) => [(65499 - i).toFixed(2), '5']), asks: Array.from({ length: 20 }, (_, i) => [(65501 + i).toFixed(2), '5']) }), { status: 200 });
            if (url.includes('/fapi/v1/ticker/24hr')) return new Response(JSON.stringify({ symbol: 'BTCUSDT', lastPrice: '65500', priceChangePercent: '2.1', quoteVolume: '1000000000' }), { status: 200 });
            if (url.includes('deribit.com')) return new Response(JSON.stringify({ result: { data: [[now - 3_600_000, 50, 52, 49, 51]] } }), { status: 200 });
            return new Response(JSON.stringify({}), { status: 200 });
        };
        __futuresRateLimitTestHooks.reset();
        __futuresRateLimitTestHooks.setFetchImpl(mockFetch as (url: string) => Promise<Response>);
        globalThis.fetch = mockFetch as typeof fetch;
        await withMemoryStorage('stream-audit', async () => {
            try {
                const sampleTrades = Array.from({ length: 12 }, (_, i) => ({
                    id: `btc-long-${i}`,
                    timestamp: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
                    decidedAt: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
                    outcomeResolvedAt: new Date(1_700_000_000_000 + i * 3_600_000 + 1_800_000).toISOString(),
                    outcome: i % 3 === 2 ? 'LOSS' : 'WIN',
                    realizedR: i % 3 === 2 ? -1 : 2,
                    analysis: {
                        coinName: 'BTCUSDT',
                        direction: 'Long',
                        detectedPatternFamily: 'pullback',
                        entryPoints: [{ price: '65000' }],
                        stopLoss: '64000',
                        takeProfit: [{ price: '67000' }],
                    },
                }));
                const specs: Array<{ name: string; args: Record<string, unknown>; keys: string[] }> = [
                    { name: 'get_regime', args: { symbol: 'BTCUSDT', interval: '1h' }, keys: ['quant', 'trendScan', 'byHorizon', 'brooks', 'barbwire'] },
                    { name: 'order_flow', args: { symbol: 'BTCUSDT', interval: '15m' }, keys: ['spot_perp_divergence', 'vpin'] },
                    { name: 'swing_structure', args: { symbol: 'BTCUSDT', interval: '1h' }, keys: ['bar_count', 'composite_candle', 'inside_cluster', '0.705'] },
                    { name: 'imbalances', args: { symbol: 'BTCUSDT', interval: '1h' }, keys: ['micro_measuring_gaps', 'midpoint'] },
                    { name: 'trade_math', args: { symbol: 'BTCUSDT', direction: 'Long', entry: 65000, stop_loss: 64000, take_profits: [67000, 69000], equity_usd: 10000, risk_percent: 1, expected_hold_hours: 16 }, keys: ['funding', 'dragR'] },
                    { name: 'get_order_book', args: { symbol: 'BTCUSDT', notional_usd: 50000, side: 'buy' }, keys: ['microprice', 'impact'] },
                    { name: 'get_btc_context', args: {}, keys: ['optionsContext'] },
                    { name: 'project_future_price', args: { symbol: 'BTCUSDT', interval: '1h', horizon_bars: 24 }, keys: ['horizon', '+24 bars'] },
                    { name: 'run_monte_carlo', args: { symbol: 'BTCUSDT', interval: '1h', direction: 'long', entry: 65000, stop_loss: 64000, take_profits: [67000, 69000] }, keys: ['resampled tape drift', 'MONTE CARLO'] },
                    { name: 'setup_base_rate', args: { coin: 'BTC', direction: 'Long' }, keys: ['sample_uniqueness', 'entry_significance'] },
                ];
                for (const s of specs) {
                    const res = await executeDeskTool(
                        { id: s.name, name: s.name, arguments: s.args },
                        { defaultSymbol: 'BTCUSDT', artifactOwner: 'stream-audit', allowedTools: 'all', trades: sampleTrades as never },
                    );
                    assert.equal(res.ok, true, `${s.name} failed: ${res.content}`);
                    assert.equal(res.content.includes('_clip') || res.content.includes('TRUNCATED') || res.content.includes('read_tool_output'), false, `${s.name} clipped (${res.content.length} chars)`);
                    for (const key of s.keys) {
                        assert.equal(res.content.includes(key), true, `${s.name} missing ${key}: ${res.content.slice(0, 300)}`);
                    }
                }
            } finally {
                globalThis.fetch = prevFetch;
                __futuresRateLimitTestHooks.reset();
            }
        });
    });

    it('streamChatWithDeskTools does not wipe the final answer after a clean native tool round', async () => {
        const originalWarn = console.warn;
        console.warn = () => {};
        const prevFetch = globalThis.fetch;
        let round = 0;
        const sseBody = (frames: string[]): string => frames.map(f => `data: ${f}\n\n`).join('');
        const server = http.createServer((_req, res) => {
            round += 1;
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            if (round === 1) {
                res.end(sseBody([
                    JSON.stringify({ choices: [{ delta: { reasoning: 'Need live price. ', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_price_snapshot', arguments: '{"symbol":"BTCUSDT"}' } }] } }] }),
                    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
                    '[DONE]',
                ]));
                return;
            }
            res.end(sseBody([
                JSON.stringify({ choices: [{ delta: { content: 'Chunk 1. ' } }] }),
                JSON.stringify({ choices: [{ delta: { content: 'Chunk 2.' }, finish_reason: 'stop' }] }),
                '[DONE]',
            ]));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as { port: number };
        const mockMarketFetch = async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/fapi/v1/exchangeInfo')) return new Response(JSON.stringify({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }] }), { status: 200 });
            if (url.includes('/fapi/v1/ticker/price') || url.includes('/fapi/v1/ticker/24hr') || url.includes('/fapi/v1/premiumIndex')) {
                return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '65000', lastPrice: '65000', markPrice: '65000', priceChangePercent: '1.0', lastFundingRate: '0.0001' }), { status: 200 });
            }
            if (url.includes('/fapi/v1/klines')) {
                const now = Date.now();
                return new Response(JSON.stringify([[now - 60000, '65000', '65100', '64900', '65000', '10', now - 1, '650000', 10, '5', '325000', '0']]), { status: 200 });
            }
            return prevFetch(input);
        };
        __futuresRateLimitTestHooks.reset();
        __futuresRateLimitTestHooks.setFetchImpl(mockMarketFetch as (url: string) => Promise<Response>);
        globalThis.fetch = mockMarketFetch as typeof fetch;

        await withMemoryStorage('stream-reset-check', async () => {
            try {
                let resets = 0;
                const chunks: string[] = [];
                for await (const delta of streamChatWithDeskTools(
                    { id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'k', apiFormat: 'chat_completions', models: ['m'], selectedModel: 'm', isEnabled: true, isBuiltIn: false },
                    [{ role: 'user', content: 'price?' }],
                    {
                        defaultSymbol: 'BTCUSDT',
                        allowedTools: ['get_price_snapshot'],
                        memoryEnabled: false,
                        onStreamReset: () => { resets += 1; },
                    },
                )) {
                    chunks.push(delta);
                }
                assert.equal(chunks.join(''), 'Chunk 1. Chunk 2.');
                // Only one pre-tool reset is expected (between round 1 tool call and round 2); never an extra post-answer reset.
                assert.ok(resets <= 1, `unexpected extra reset (${resets})`);
            } finally {
                globalThis.fetch = prevFetch;
                __futuresRateLimitTestHooks.reset();
                console.warn = originalWarn;
                server.close();
            }
        });
    });
});

describe('Bundled Wave C Skills runtime loader', () => {
    it('seeds all four shipped skills through writeSkillFile and respects explicit deletion', async () => {
        const skillsDir = path.join(ROOT, 'skills');
        const slugs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
        assert.deepEqual(slugs, [
            'brooks-trend-pullback-h2-l2',
            'confirmed-range-and-breakout',
            'major-trend-reversal-gate',
            'spot-perp-crowding-fade',
        ]);
        const bundled = slugs.map(slug => ({
            slug,
            content: fs.readFileSync(path.join(skillsDir, slug, 'SKILL.md'), 'utf8'),
        }));

        await withMemoryStorage('bundled-skills-user', async () => {
            await initMemoryFiles('bundled-skills-user');
            const seeded = await seedBundledSkills('bundled-skills-user', bundled);
            assert.deepEqual(seeded.sort(), slugs);
            const rows = usableSkillRows(skillIndexRows());
            assert.deepEqual(rows.map(r => r.slug).sort(), slugs);

            // Deleting one bundled skill must stick across a second boot/seed call.
            await deleteSkillFile('confirmed-range-and-breakout', 'bundled-skills-user');
            const secondSeed = await seedBundledSkills('bundled-skills-user', bundled);
            assert.deepEqual(secondSeed, []);
            assert.equal(usableSkillRows(skillIndexRows()).some(r => r.slug === 'confirmed-range-and-breakout'), false);
        });
    });
});
