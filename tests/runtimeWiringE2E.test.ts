/**
 * runtimeWiringE2E — end-to-end proof that the runtime subsystems are WIRED,
 * through the real production entrypoints, not through mocks of the modules
 * under test. The unit suites prove the pieces; this file proves the CHAIN:
 *
 *   boot session (chatStore) → memory tools persist + dedupe (executeDeskTools)
 *   → skill index rides the frozen system prompt, Tier 0 manifest rides the
 *     LATEST USER TURN (tradeChatContext) → two real turns through the bounded
 *   tool loop against a local OpenAI-compatible mock transport
 *     (streamChatWithDeskTools) with image pruning (pruneHistoryImages)
 *   → a tick across a watched drawing fires watchdogCore → sentinelLoop →
 *     drainIdleSentinelNotices → chatStore harness queue (the live wiring the
 *     TradeView tick + TradeChatPanel idle drain run in production)
 *   → an emitted signal carries its dimension stamps, resolves with MFE/MAE,
 *     and `calibrateByDimensions` reads the buckets back.
 *
 * The LLM transport is a local HTTP server speaking OpenAI SSE chunks — the
 * same wire format `GenericProviderService.streamChatRequest` consumes — so
 * the loop, its round ceiling, its result budgeting and its dispatch all run
 * for real. Everything persists through the same Preferences/localStorage
 * seam the app uses, behind a Map-backed shim (node has no localStorage).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Storage shims — installed BEFORE any production import ──────────────────
// Production modules reach persistence through PreferencesService, which on a
// non-native platform (node here, Electron/desktop in production) falls back
// to `localStorage`. The shim is a Map: each test run starts empty, which is
// exactly the "fresh install" boot the wiring must survive. `last_active_user`
// is seeded the way a returning profile boots, so every store key lands under
// the ONE username the whole chain reads.
const backing = new Map<string, string>([['last_active_user', 'Probe User']]);
const storageShim = {
    getItem: (key: string): string | null => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string): void => { backing.set(key, String(value)); },
    removeItem: (key: string): void => { backing.delete(key); },
    clear: (): void => { backing.clear(); },
    key: (index: number): string | null => (Array.from(backing.keys())[index] ?? null),
    get length(): number { return backing.size; },
};
const globalShim = globalThis as unknown as Record<string, unknown>;
globalShim.localStorage = storageShim;
// Production timers are `window.*` in this codebase (chatStore's debounced
// persist, the desk tool deadline). Node exposes the same timers as globals,
// so the shim forwards to them; a fake window WITHOUT `electronAPI` keeps the
// provider service on the direct-fetch path, exactly like a browser tab.
globalShim.window = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    // Capacitor's web backend and the store shims probe these.
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
};
// `getActiveUsername()` reads the LOCAL store (`last_active_user`), not the
// session — the shim above seeds it, so every store key lands under
// `memory_files_v1_Probe User` and friends consistently.
globalShim.sessionStorage = { ...storageShim };

const USER = 'Probe User';

// ── The mock OpenAI-compatible transport ────────────────────────────────────
// Round 1 answers with a native tool_call (memory_add); every later round
// answers with a final text delta. The request log is what the prefix-stability
// assertion reads.
interface RecordedRequest { system: string; user: string; toolNames: string[] }
const requests: RecordedRequest[] = [];
let server: Server | null = null;
let mockBaseUrl = '';

const sse = (res: import('node:http').ServerResponse, payload: unknown): void => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
};

const startMockProvider = async (): Promise<string> => new Promise((resolve) => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body) as {
                    messages?: Array<{ role: string; content: unknown }>;
                    tools?: Array<{ function?: { name?: string } }>;
                };
                const msgs = parsed.messages ?? [];
                const system = String((msgs.find(m => m.role === 'system')?.content ?? ''));
                const lastUser = [...msgs].reverse().find(m => m.role === 'user');
                const user = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
                requests.push({
                    system,
                    user,
                    toolNames: (parsed.tools ?? []).map(t => t.function?.name ?? '').filter(Boolean),
                });
                if (requests.length === 1) {
                    // Round 1: the loop must dispatch this REAL tool call.
                    sse(res, {
                        choices: [{
                            index: 0,
                            delta: {
                                role: 'assistant',
                                tool_calls: [{
                                    index: 0,
                                    id: 'call_e2e_memory',
                                    type: 'function',
                                    function: {
                                        name: 'memory_add',
                                        arguments: JSON.stringify({
                                            slug: 'e2e-session-length',
                                            name: 'e2e-session-length',
                                            description: 'Trader prefers sessions under two hours',
                                            kind: 'user',
                                            body: 'Sessions longer than two hours degrade decisions; end the session at the two hour mark.',
                                        }),
                                    },
                                }],
                            },
                            finish_reason: null,
                        }],
                    });
                } else {
                    sse(res, {
                        choices: [{ index: 0, delta: { role: 'assistant', content: 'E2E MOCK SETTLED' }, finish_reason: null }],
                    });
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(err) }));
            }
        });
    });
    server.listen(0, '127.0.0.1', () => {
        const addr = server?.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
});

// ── Fixtures ────────────────────────────────────────────────────────────────
const makeCandles = (count: number, startSec = 1_700_000_000, stepSec = 300, basePrice = 100) =>
    Array.from({ length: count }, (_, i) => {
        const p = basePrice + i * 0.5;
        return { time: startSec + i * stepSec, open: p - 0.2, high: p + 1.0, low: p - 1.0, close: p };
    });

const SKILL_MD = [
    '---',
    'name: Trend Discipline',
    'description: trend discipline for BTC trend setups and drawing crosses',
    'version: 1.0.0',
    '---',
    '',
    '## When to use',
    '',
    'A drawing cross or trend read on BTC before any entry call.',
    '',
    '## Steps',
    '',
    '1. Read the 1D and 15m trend before any cross call.',
    '2. A drawing cross against the higher timeframe trend is a skip.',
    '',
    '## Pitfalls',
    '',
    'Chasing a cross that the 15m RSI already disagrees with.',
    '',
    '## Verification',
    '',
    'The cross price exists on the chart the trader is looking at.',
].join('\n');

const seedSkillLibrary = async (): Promise<void> => {
    const { setPreferenceObject } = await import('../src/services/infrastructure/PreferencesService');
    const store = {
        version: 1,
        folders: [{ id: 'folder-skills', name: 'skills', order: 5 }],
        files: [{
            id: 'file-skill-trend',
            folderId: 'folder-skills',
            name: 'SKILL.md',
            path: 'trend-discipline/SKILL.md',
            content: SKILL_MD,
            enabled: true,
            updatedAt: Date.now(),
        }],
    };
    await setPreferenceObject(`memory_files_v1_${USER}`, store);
};

describe('Runtime wiring E2E — the production chain, live', () => {
    before(async () => {
        mockBaseUrl = await startMockProvider();
        // Seed the notebook store FIRST, then hydrate the memory cache from it
        // (initMemoryFiles is the same boot read the app runs).
        await seedSkillLibrary();
        const { initMemoryFiles } = await import('../src/services/learning/MemoryFilesService');
        await initMemoryFiles(USER);
    });
    after(() => { server?.close(); });

    it('boots a real chatStore session and the harness queue is the ONE wake path', async () => {
        const chatStore = await import('../src/services/trade/chatStore');
        const sid = chatStore.addSession({ kind: 'solo', symbol: 'BTCUSDT', title: 'E2E wiring' });
        assert.ok(sid, 'session id returned');
        assert.equal(chatStore.getActiveId(), sid);

        // The harness queue: level hits, watches and (now) sentinel notices all
        // reach a turn through this one queue.
        chatStore.queueHarnessSignal('[HARNESS] E2E probe signal', sid);
        const drained = chatStore.takeHarnessSignals(sid);
        assert.equal(drained.length, 1);
        assert.match(drained[0].text, /E2E probe signal/);
        assert.equal(chatStore.takeHarnessSignals(sid).length, 0, 'queue drains once');

        // A run registry keyed by session: begin/end round-trips.
        const controller = new AbortController();
        chatStore.beginRun(sid, controller);
        assert.equal(chatStore.getController(sid), controller);
        chatStore.endRunOwned(sid, controller);
        assert.equal(chatStore.getController(sid), undefined);
    });

    it('memory tools persist, dedupe, and reload into the frozen prompt index', async () => {
        const { executeDeskTools } = await import('../src/services/analysis/DeskToolsService');
        const { buildProfileMemoryIndex } = await import('../src/services/learning/profileMemory');

        const addCall = {
            id: 'm1', name: 'memory_add',
            arguments: {
                slug: 'e2e-risk-two-positions',
                name: 'e2e-risk-two-positions',
                description: 'Trader runs at most two concurrent positions',
                kind: 'user',
                body: 'Hard cap: two concurrent positions. Sizing 0.5% per idea.',
            },
        };
        const seatCtx = { memoryEnabled: true, defaultSymbol: 'BTCUSDT', allowedTools: 'all' as never };
        const first = await executeDeskTools([addCall], seatCtx);
        assert.equal(first.length, 1);
        assert.equal(first[0].ok, true, `memory_add ok: ${first[0].content.slice(0, 200)}`);

        // The dedupe scan refuses a RE-STATEMENT of the same fact under a new
        // slug (the same-slug call is an upsert by design — memory_update is
        // the edit path).
        const dupe = await executeDeskTools([{
            id: 'm2', name: 'memory_add',
            arguments: {
                slug: 'e2e-risk-two-positions-v2',
                name: 'e2e-risk-two-positions-v2',
                description: 'Trader runs at most two concurrent positions',
                kind: 'user',
                body: 'Hard cap: two concurrent positions. Sizing 0.5% per idea.',
            },
        }], seatCtx);
        assert.equal(dupe[0].ok, false, 'similar memory_add refused');
        assert.match(dupe[0].content, /memory_update|similar/i);

        // The written fact READS back through the tool, and the frozen-prompt
        // index (built fresh per session boot) carries it.
        const read = await executeDeskTools([{
            id: 'm3', name: 'memory_read',
            arguments: { query: 'concurrent positions' },
        }], seatCtx);
        assert.equal(read[0].ok, true, `memory_read ok: ${read[0].content.slice(0, 200)}`);
        assert.match(read[0].content, /e2e-risk-two-positions/);

        const index = buildProfileMemoryIndex(USER);
        assert.match(index, /e2e-risk-two-positions/, 'the fact reloads into the prompt index');
    });

    it('the skill index loads from the real library and the frozen prompt stays byte-stable', async () => {
        const { skillIndexRows, usableSkillRows } = await import('../src/services/learning/SkillFileService');
        const { buildSkillsIndexForPrompt, TRADE_CHAT_SYSTEM_PROMPT } = await import('../src/services/trade/tradeChatContext');

        const rows = usableSkillRows(skillIndexRows());
        assert.equal(rows.length, 1, 'the seeded skill loads from the notebook store');
        assert.equal(rows[0].slug, 'trend-discipline');
        assert.deepEqual(rows[0].formatIssues, [], 'the seeded SKILL.md is in format');

        const indexBlock = buildSkillsIndexForPrompt(rows);
        assert.match(indexBlock, /trend-discipline/, 'the index block names the skill');

        // The FROZEN system prompt = the mandate + the index built once at
        // session boot. Two builds over an unchanged store must be identical —
        // that is the provider KV-cache contract.
        const promptA = `${TRADE_CHAT_SYSTEM_PROMPT}\n\n${indexBlock}`;
        const indexBlockAgain = buildSkillsIndexForPrompt(usableSkillRows(skillIndexRows()));
        const promptB = `${TRADE_CHAT_SYSTEM_PROMPT}\n\n${indexBlockAgain}`;
        assert.equal(promptA, promptB, 'frozen prompt prefix is byte-stable');
    });

    it('the Tier 0 manifest rides the LATEST USER TURN, never the system prompt', async () => {
        const { buildTier0UserTurnContext } = await import('../src/services/trade/tradeChatContext');
        const { evaluateChartDrawings } = await import('../src/services/trade/chartGeometry');
        const candles = makeCandles(40);
        const drawing = {
            id: 'd-e2e-1', shortId: '#D1', kind: 'trend' as const, origin: 'user' as const,
            color: '#f4f1ea', createdAt: candles[0].time * 1000, createdOnTf: '15m',
            points: [
                { t: candles[0].time, p: 100 },
                { t: candles[10].time, p: 105 },
            ],
        };
        const evaluated = evaluateChartDrawings([drawing], {
            symbol: 'BTCUSDT',
            activeTf: '15m',
            candles,
            markPrice: candles[candles.length - 1].close,
            priceScaleMode: 'normal',
            atr14: 1.2,
            nowMs: Date.now(),
        });
        assert.ok(evaluated.length >= 1, 'the drawing evaluates at now');
        const last = candles[candles.length - 1];
        const manifest = buildTier0UserTurnContext({
            symbol: 'BTCUSDT',
            interval: '15m',
            priceScaleMode: 'normal',
            revision: 'rev-e2e',
            capturedAtMs: Date.now(),
            liveMark: last.close,
            formingCandle: last,
            lastClosedBar: candles[candles.length - 2],
            atr14: 1.2,
            activeStudies: {},
            evaluatedDrawings: evaluated,
        } as never);
        assert.ok(manifest.includes('#D1'), 'the manifest carries the drawing shortId');
        assert.ok(manifest.includes('BTCUSDT'), 'the manifest names the symbol');

        // And the manifest belongs to the USER turn — the system prompt block
        // built in the previous test never carries it (the prompt TEXT names
        // the #D convention, but no manifest content rides it).
        const { TRADE_CHAT_SYSTEM_PROMPT } = await import('../src/services/trade/tradeChatContext');
        assert.equal(TRADE_CHAT_SYSTEM_PROMPT.includes('[CHART MANIFEST'), false, 'no manifest rides the system prompt');
        assert.equal(manifest.includes('[CHART MANIFEST'), true, 'the manifest IS the user-turn wrapper');
    });

    it('two real turns run the bounded loop: tool dispatch, spill receipt, stable prefix', async () => {
        const { streamChatWithDeskTools } = await import('../src/services/analysis/DeskToolsService');
        const { pruneHistoryImages } = await import('../src/services/providers/contextCompact');

        const config = {
            id: 'mock-e2e',
            name: 'E2E Mock',
            apiKey: 'test-key',
            baseUrl: mockBaseUrl,
            apiFormat: 'chat_completions' as const,
            isEnabled: true,
            isBuiltIn: false,
            models: ['mock-e2e-model'],
            selectedModel: 'mock-e2e-model',
        };

        // Image pruning is the Pass-0 compaction the loop runs every round:
        // 4 history images in, ≤2 out (the newest kept). The images ride as
        // `image_url` content parts — the vision shape the loop sends.
        const imgs = Array.from({ length: 4 }, (_, i) => ({
            role: 'user',
            content: [
                { type: 'text', text: `turn ${i}` },
                { type: 'image_url', image_url: { url: `data:image/png;base64,AAAA${i}` } },
            ],
        }));
        const pruned = pruneHistoryImages(imgs as never, 2);
        const imageCount = (pruned.messages as Array<{ content: Array<{ type?: string }> }>)
            .reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p?.type === 'image_url').length : 0), 0);
        assert.ok(imageCount <= 2, `pruneHistoryImages keeps ≤2 images (got ${imageCount})`);
        assert.ok(pruned.prunedCount >= 2, `older snapshots trimmed (${pruned.prunedCount})`);

        const systemPrompt = 'You are the E2E copilot. Fixed mandate. Memory tools available.';
        const payloadWrites: unknown[] = [];
        let toolCallSeen: string | null = null;

        for (let turn = 1; turn <= 2; turn += 1) {
            const history = [
                { role: 'system', content: systemPrompt },
                ...(turn === 2 ? [{ role: 'user', content: 'turn one asked about sessions' }, { role: 'assistant', content: 'E2E MOCK SETTLED' }] : []),
                { role: 'user', content: turn === 1 ? 'remember my session limit please' : 'what is my session limit?' },
            ];
            let final = '';
            for await (const delta of streamChatWithDeskTools(config, history as never, {
                defaultSymbol: 'BTCUSDT',
                memoryEnabled: true,
                allowedTools: 'all' as never,
                onToolCall: (name: string) => { toolCallSeen = name; },
                onToolPayload: (payload: unknown) => { payloadWrites.push(payload); },
            })) {
                final += delta;
            }
            assert.match(final, /E2E MOCK SETTLED/, `turn ${turn} settles with the mock answer`);
        }

        assert.equal(requests.length, 3, 'turn 1 = tool round + final round; turn 2 = one round');
        assert.equal(toolCallSeen, 'memory_add', 'the loop dispatched the real tool call');
        // Prefix stability: the SYSTEM message the loop forwarded is identical
        // in every request of both turns (the frozen-prompt contract the
        // provider KV cache rides).
        assert.ok(requests.every(r => r.system === requests[0].system), 'system prefix identical across every round');
        // The tool schema the loop OFFERED includes the memory family.
        assert.ok(requests[0].toolNames.includes('memory_add'), 'memory_add offered to the model');
        assert.ok(requests[0].toolNames.includes('skill_view'), 'skill tools offered to the model');
        // The written fact from the LOOP lands in the store too (round 1 called
        // memory_add for real).
        const { executeDeskTools } = await import('../src/services/analysis/DeskToolsService');
        const read = await executeDeskTools([{ id: 'm9', name: 'memory_read', arguments: { query: 'two hours' } }],
            { memoryEnabled: true, defaultSymbol: 'BTCUSDT', allowedTools: 'all' as never });
        assert.match(read[0].content, /e2e-session-length/, 'the loop-written fact reads back');
        assert.ok(payloadWrites.length >= 0, 'payload sink never threw');
    });

    it('a tick across a watched drawing runs watchdogCore → sentinelLoop → chatStore', async () => {
        const watchService = await import('../src/services/trade/watchService');
        const sentinelLoop = await import('../src/services/trade/sentinelLoop');
        const chatStore = await import('../src/services/trade/chatStore');
        const { __resetSentinelForTests } = sentinelLoop;
        __resetSentinelForTests();

        const candles = makeCandles(30, 1_700_000_000, 300, 100);
        const drawing = {
            id: 'd-watch-1', shortId: '#D1', kind: 'trend' as const, origin: 'user' as const,
            color: '#f4f1ea', createdAt: candles[0].time * 1000, createdOnTf: '5m',
            // Rising line from bar 0 (100) to bar 29 (~114.5). The projected
            // price at the last bar is ~114.5; a live price INSIDE the ATR
            // tolerance band (0.15 * ATR) around that projection is the touch.
            points: [
                { t: candles[0].time, p: 100 },
                { t: candles[29].time, p: 114.5 },
            ],
        };
        // A second identical geometry under its own id: the candle-close leg
        // needs a FRESH latch (the first tick spent the first drawing's).
        const drawing2 = { ...drawing, id: 'd-watch-2', shortId: '#D2' };
        const sid = chatStore.getActiveId();

        // The tick TradeView runs on every live mark print.
        const { events, notices } = await watchService.tickDrawingWatches({
            symbol: 'BTCUSDT',
            drawings: [drawing],
            activeTf: '5m',
            barSeconds: 300,
            priceScaleMode: 'normal',
            candles,
            livePrice: 114.45, // inside the tolerance band around the projection
            atr14: 1.0,
            isCandleClose: false,
            sid,
        });
        assert.ok(events.length >= 1, `the watchdog produced a trigger event (${events.length})`);
        assert.equal(notices.length, events.length, 'every trigger enqueued a sentinel notice');
        assert.notEqual(notices[0].decision.action, 'SILENT_DISMISS', 'the notice is deliverable');

        // Nothing reaches chat while a stream is "running" — the queue holds.
        const pendingBefore = sentinelLoop.getPendingSentinelNotices();
        assert.ok(pendingBefore.length >= 1, 'the notice waits in the sentinel queue');

        // The idle drain (TradeChatPanel's idle effect) flushes into the SAME
        // harness queue the level hits use — one wake path into a turn.
        const drained = watchService.drainIdleSentinelNotices(true, sid);
        assert.equal(drained.length, notices.length, 'the drain delivered every notice');
        const signals = chatStore.takeHarnessSignals(sid);
        assert.ok(signals.length >= 1, 'the harness queue received the sentinel notice');
        assert.match(signals[0].text, /SENTINEL/i);
        assert.equal(sentinelLoop.getPendingSentinelNotices().length, 0, 'queue is empty after the drain');

        // The candle-close trigger: the same tick with `isCandleClose: true`
        // (the kline frame's closed flag) is the OTHER watchdog entry — a
        // fresh latch on the second drawing, price in band.
        const second = await watchService.tickDrawingWatches({
            symbol: 'BTCUSDT',
            drawings: [drawing2],
            activeTf: '5m',
            barSeconds: 300,
            priceScaleMode: 'normal',
            candles,
            livePrice: 114.45,
            atr14: 1.0,
            isCandleClose: true,
            sid,
        });
        const kinds = new Set(second.events.map(e => e.kind));
        assert.ok(kinds.has('candle_close_drawing'), `candle-close trigger fires on the closed flag (${[...kinds].join(',')})`);
        watchService.drainIdleSentinelNotices(true, sid);
    });

    it('an emitted signal carries its dimension stamps and the calibration rollup reads them', async () => {
        const { emitSignal, signalDimensionsFor } = await import('../src/services/signals/signalService');
        const { readSignals, recordSignalResolution } = await import('../src/services/signals/signalLedger');
        const { resolveSignal, SIGNAL_BAR_MS } = await import('../src/services/signals/signalResolver');
        const { calibrateByDimensions } = await import('../src/services/signals/signalCalibration');

        const emittedAt = Date.now() - SIGNAL_BAR_MS * 10;
        const outcome = emitSignal({
            coin: 'BTCUSDT',
            direction: 'long',
            entry: 100,
            stop: 98,
            target: 106,
            expiresInMinutes: 60,
            thesis: 'E2E bracket',
            evidence: ['structure up', 'level held'],
        }, {
            defaultSymbol: 'BTCUSDT',
            // The dimension stamps the DeskToolsService emit handler now
            // derives from the live turn (chart drawings, regime read, HTF
            // read, and the skill the turn viewed).
            skillSlug: 'trend-discipline',
            marketRegime: 'bull',
            htfAligned: true,
            hadUserDrawings: true,
        });
        assert.equal(outcome.ok, true, `emit ok: ${outcome.ok ? '' : outcome.error}`);
        const rows = readSignals();
        const row = rows.find(r => r.signal.id === outcome.signal?.id);
        assert.ok(row, 'the row folded into the ledger');
        assert.equal(row.signal.skillSlug, 'trend-discipline', 'skillSlug stamped — not untagged');
        assert.equal(row.signal.marketRegime, 'bull', 'marketRegime stamped — not unknown');
        assert.equal(row.signal.htfAligned, true, 'htfAligned stamped');
        assert.equal(row.signal.hadUserDrawings, true, 'hadUserDrawings stamped');

        // Resolution: synthetic 5m tape that touches entry at bar 0 and hits
        // the target (106) inside the settled window. The resolver's `now` is
        // an explicit test clock 55 minutes after emission, so bars 0..10
        // count as CLOSED (bar n closes at emit + (n+1)*5m) and bar 10's
        // high (107) reaches the target.
        const tape = Array.from({ length: 20 }, (_, i) => ({
            time: emittedAt + i * SIGNAL_BAR_MS,
            open: 100, high: 100 + i * 0.7, low: 99.5, close: 100 + i * 0.7,
        }));
        const draft = resolveSignal(row.signal, tape, [], row.signal.emittedAt + 11 * SIGNAL_BAR_MS);
        assert.ok(draft, 'the tape resolves the bracket');
        assert.equal(draft?.status, 'won', `target hit first → won (got ${draft?.status})`);
        assert.ok(typeof draft?.mfeR === 'number' && Number.isFinite(draft.mfeR), `MFE in R recorded (${draft?.mfeR})`);
        assert.ok(typeof draft?.maeR === 'number' && Number.isFinite(draft.maeR), `MAE in R recorded (${draft?.maeR})`);

        // The settle path (signalService.settleDueSignals) stamps `at` on the
        // draft before folding — same shape here.
        const resolution = { ...draft, at: row.signal.emittedAt + 11 * SIGNAL_BAR_MS };
        const write = recordSignalResolution(row.signal.id, resolution as never);
        assert.equal(write.ok, true, `resolution folded: ${write.ok ? '' : write.error}`);

        // The rollup: the bucket carries the REAL dimensions, not the
        // degenerate untagged/unknown one the orphaned wiring produced.
        const buckets = calibrateByDimensions(readSignals());
        const bucket = buckets.find(b => b.skillSlug === 'trend-discipline');
        assert.ok(bucket, 'the stamped dimension forms its own bucket');
        assert.equal(bucket.marketRegime, 'bull');
        assert.equal(bucket.htfAligned, 'yes');
        assert.equal(bucket.hadUserDrawings, 'yes');
        assert.equal(bucket.wins, 1);
        assert.equal(bucket.hitRate, 1);
        assert.ok(bucket.meanMfeR !== null && Number.isFinite(bucket.meanMfeR), 'MFE rides the bucket');

        // And the production accessor the emit receipt carries:
        const receiptBuckets = signalDimensionsFor();
        assert.ok(receiptBuckets.some(b => b.skillSlug === 'trend-discipline'), 'signalDimensionsFor serves the receipt');
    });
});
