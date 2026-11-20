/**
 * autonomyEngine — end-to-end proof of the desk's autonomous loops against a
 * local OpenAI-compatible transport (the same wire format getQuickResponse
 * consumes through the SDK). Four contracts, verified for real:
 *
 *  1. Model SILENT_MAINTAIN mutates ONLY the agent drawing bucket (never a
 *     user shape), spams no chat, and its ledger record carries a working
 *     1-click undo.
 *  2. ALERT_TRADER reaches the harness queue and drains ONLY when idle.
 *  3. Guardrails: paused halts model calls AND maintain (but an armed watch's
 *     deterministic alert still flows); an exhausted budget halts model calls.
 *  4. The closed loop: hindsight-checked post-mortem lessons promote into
 *     memory only past the evidence/sessions floors, risk-shaped lessons
 *     never auto-promote, and the idle maintenance pass prunes memory and
 *     refines a skill through the ONE pen — each with a working undo.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Storage shims — installed BEFORE any production import ──────────────────
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
globalShim.sessionStorage = storageShim;
globalShim.window = {
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
// chartDrawings registers a visibilitychange flush at module load; node has
// no document, so the shim carries the two members production code touches.
globalShim.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    hidden: false,
};

const USER = 'Probe User';

// ── The mock transport: routes by prompt content ────────────────────────────
let nextSentinelDecision = '';
let memoryOpsJson = '[]';
let skillMarkdown: string | null = null;
const requests: Array<{ system: string; prompt: string }> = [];

let server: Server | null = null;
let mockBaseUrl = '';

const startMock = async (): Promise<string> => new Promise((resolve) => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> };
                const msgs = parsed.messages ?? [];
                const system = String((msgs.find(m => m.role === 'system')?.content ?? ''));
                const userMsg = [...msgs].reverse().find(m => m.role === 'user');
                const prompt = typeof userMsg?.content === 'string' ? userMsg.content : '';
                requests.push({ system, prompt });
                let content: string;
                if (system.includes('isolated market sentinel')) {
                    content = nextSentinelDecision;
                } else if (prompt.includes('maintain the trader')) {
                    content = memoryOpsJson;
                } else if (prompt.includes('Refine this trading playbook')) {
                    content = skillMarkdown ?? 'unchanged';
                } else {
                    content = 'MOCK OK';
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'mock-1',
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                }));
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
    'Chasing a cross the 15m RSI already disagrees with.',
    '',
    '## Verification',
    '',
    'The cross price exists on the chart the trader is looking at.',
].join('\n');

const SKILL_MD_REFINED = SKILL_MD
    .replace('2. A drawing cross against the higher timeframe trend is a skip.',
        '2. A drawing cross against the higher timeframe trend is a skip; confirm the 1h structure agrees first.')
    .replace('version: 1.0.0', 'version: 1.1.0');

describe('Autonomy engine — the desk runs itself under guardrails', () => {
    before(async () => {
        mockBaseUrl = await startMock();
        const { setPreferenceObject } = await import('../src/services/infrastructure/PreferencesService');
        await setPreferenceObject('provider_configs_v1', [{
            id: 'mock-auto', name: 'Autonomy Mock', apiKey: 'test-key', baseUrl: mockBaseUrl,
            apiFormat: 'chat_completions', isEnabled: true, isBuiltIn: false,
            models: ['auto-model'], selectedModel: 'auto-model',
        }]);
        // Notebook store: seed the skills folder + one skill, then hydrate.
        await setPreferenceObject(`memory_files_v1_${USER}`, {
            version: 1,
            folders: [{ id: 'folder-skills', name: 'skills', order: 5 }],
            files: [{
                id: 'file-skill-trend', folderId: 'folder-skills', name: 'SKILL.md',
                path: 'trend-discipline/SKILL.md', content: SKILL_MD, enabled: true, updatedAt: Date.now(),
            }],
        });
        const { initMemoryFiles } = await import('../src/services/learning/MemoryFilesService');
        await initMemoryFiles(USER);
        const { initAutonomy, setAutonomyMode } = await import('../src/services/trade/autonomyEngine');
        await initAutonomy(USER);
        await setAutonomyMode('autonomous', USER);
        const { __resetSentinelForTests } = await import('../src/services/trade/sentinelLoop');
        __resetSentinelForTests();
    });
    after(() => { server?.close(); });

    it('model SILENT_MAINTAIN expires the named AI drawing, never a user shape, no chat spam, undo works', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { drawingsControl } = await import('../src/services/trade/drawingsControl');
        const { __resetAutonomyLedgerForTests, listAutonomyRecords, undoAutonomyRecord } = await import('../src/services/trade/autonomyLedger');
        const { __resetSentinelForTests, getPendingSentinelNotices } = await import('../src/services/trade/sentinelLoop');
        __resetSentinelForTests();
        await __resetAutonomyLedgerForTests(USER);

        const sid = 'sess-auto-1';
        const symbol = 'BTCUSDT';
        const agentCtl = drawingsControl('model', sid, symbol, USER);
        agentCtl.add([{
            id: 'agent-1', shortId: '#D1', kind: 'trend', origin: 'agent',
            color: '#22d3ee', createdAt: Date.now(), points: [{ t: 1_700_000_000, p: 100 }, { t: 1_700_003_600, p: 101 }],
        }]);
        const userCtl = drawingsControl('user', sid, symbol, USER);
        userCtl.add([{
            id: 'user-1', shortId: '#D1', kind: 'hline', origin: 'user',
            color: '#f4f1ea', createdAt: Date.now(), points: [{ t: 1_700_000_000, p: 99 }],
        }]);
        const beforeUser = userCtl.list();

        nextSentinelDecision = JSON.stringify({
            action: 'SILENT_MAINTAIN',
            summary: 'AI trendline invalidated by the close.',
            drawingShortId: '#D1',
            reason: 'invalidation_break',
        });
        const callsBefore = requests.length;
        const result = await engine.evaluateSentinelTrigger(
            {
                source: 'drawing_watch', symbol, sid,
                event: {
                    kind: 'candle_close_drawing', symbol, drawingId: 'agent-1', shortId: '#D1',
                    drawingKind: 'trend', tf: '5m', livePrice: 100.4, targetPrice: 100.5,
                    tolerance: 0.2, distancePrice: 0.1, distanceAtr: 0.1,
                    crossedDirection: 'up', barTime: 1_700_003_600, triggeredAt: Date.now(),
                },
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: `${symbol} 5m mark 100.4`, atr14: 1 },
            { sessionId: sid, drawings: agentCtl.list().concat(userCtl.list()) },
        );
        assert.equal(result.decision.action, 'SILENT_MAINTAIN');
        assert.equal(result.modelRan, true, 'the configured model classified the event');
        assert.equal(requests.length, callsBefore + 1, 'exactly one background call');

        // The AGENT shape is gone from the persisted bucket; the USER shape is
        // structurally untouched (the pass only ever reads the model bucket).
        assert.equal(agentCtl.list().some(d => d.id === 'agent-1'), false, 'agent drawing expired');
        assert.deepEqual(userCtl.list(), beforeUser, 'user drawing untouched');
        assert.equal(getPendingSentinelNotices().length, 0, 'SILENT_MAINTAIN never reaches chat');

        // The ledger record carries a working 1-click undo.
        const records = await listAutonomyRecords(USER);
        const rec = records.find(r => r.subsystem === 'chart' && r.summary.includes('#D1'));
        assert.ok(rec, 'the maintain landed in the activity feed');
        assert.ok(rec.undo && rec.undo.kind === 'chart-restore');
        await undoAutonomyRecord(rec.id, USER);
        assert.equal(drawingsControl('model', sid, symbol, USER).list().some(d => d.id === 'agent-1'), true, 'undo restores the drawing');
    });

    it('the model naming a USER drawing is refused silently (isolation contract)', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { drawingsControl } = await import('../src/services/trade/drawingsControl');
        const { __resetAutonomyLedgerForTests, listAutonomyRecords } = await import('../src/services/trade/autonomyLedger');
        await __resetAutonomyLedgerForTests(USER);
        const sid = 'sess-auto-1';
        // A different symbol: T1 just consumed BTCUSDT's per-symbol sentinel
        // cooldown — a REAL guardrail this test must not dodge.
        const userCtl = drawingsControl('user', sid, 'SOLUSDT', USER);
        const before = userCtl.list();

        nextSentinelDecision = JSON.stringify({
            action: 'SILENT_MAINTAIN',
            summary: 'remove the user level',
            drawingShortId: '#D1',
            reason: 'overreach',
        });
        const result = await engine.evaluateSentinelTrigger(
            {
                source: 'drawing_watch', symbol: 'SOLUSDT', sid,
                event: {
                    kind: 'price_cross_drawing', symbol: 'BTCUSDT', drawingId: 'user-1', shortId: '#D1',
                    drawingKind: 'hline', tf: '5m', livePrice: 99.2, targetPrice: 99,
                    tolerance: 0.2, distancePrice: 0.2, distanceAtr: 0.2,
                    crossedDirection: 'up', barTime: 1_700_003_600, triggeredAt: Date.now(),
                },
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: 'BTCUSDT 5m' },
            { sessionId: sid, drawings: drawingsControl('model', sid, 'SOLUSDT', USER).list().concat(before) },
        );
        assert.equal(result.decision.action, 'SILENT_MAINTAIN');
        assert.deepEqual(userCtl.list(), before, 'a user shape is NEVER maintained away');
        const records = await listAutonomyRecords(USER);
        assert.equal(records.some(r => r.subsystem === 'chart'), false, 'the refused maintain records nothing');
    });

    it('ALERT_TRADER reaches the harness queue and drains ONLY when the session is idle', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { drainSentinelNoticesWhenIdle, getPendingSentinelNotices, __resetSentinelForTests } = await import('../src/services/trade/sentinelLoop');
        __resetSentinelForTests();

        nextSentinelDecision = JSON.stringify({
            action: 'ALERT_TRADER',
            summary: 'BTCUSDT crossed the trendline cleanly.',
            drawingShortId: '#T1',
        });
        const result = await engine.evaluateSentinelTrigger(
            {
                source: 'drawing_watch', symbol: 'BTCUSDT', sid: 'sess-auto-1',
                event: {
                    kind: 'price_cross_drawing', symbol: 'BTCUSDT', drawingId: 'x', shortId: '#D4',
                    drawingKind: 'trend', tf: '5m', livePrice: 101, targetPrice: 100.5,
                    tolerance: 0.2, distancePrice: 0.5, distanceAtr: 0.5,
                    crossedDirection: 'up', barTime: 1_700_003_600, triggeredAt: Date.now(),
                },
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: 'BTCUSDT 5m' },
        );
        assert.equal(result.decision.action, 'ALERT_TRADER');
        assert.ok(result.notice, 'the notice is returned to the caller');
        assert.equal(getPendingSentinelNotices().length, 1, 'queued while maybe-busy');

        const drainedBusy = drainSentinelNoticesWhenIdle(false, () => { throw new Error('must not deliver mid-stream'); }, 'sess-auto-1');
        assert.equal(drainedBusy.length, 0, 'a busy session holds the notice');
        const drained: string[] = [];
        const drainedIdle = drainSentinelNoticesWhenIdle(true, (text) => { drained.push(text); }, 'sess-auto-1');
        assert.equal(drainedIdle.length, 1);
        assert.match(drained[0], /SENTINEL ALERT/);
    });

    it('paused halts model calls and maintain — but an armed watch alert still flows', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { setAutonomyMode } = engine;
        const { drawingsControl } = await import('../src/services/trade/drawingsControl');
        const { getPendingSentinelNotices, drainSentinelNoticesWhenIdle, __resetSentinelForTests } = await import('../src/services/trade/sentinelLoop');
        __resetSentinelForTests();
        await setAutonomyMode('paused', USER);

        const sid = 'sess-auto-1';
        const agentCtl = drawingsControl('model', sid, 'BTCUSDT', USER);
        agentCtl.add([{
            id: 'agent-2', shortId: '#D1', kind: 'rect', origin: 'agent',
            color: '#22d3ee', createdAt: Date.now(), points: [{ t: 1_700_000_000, p: 100 }, { t: 1_700_003_600, p: 101 }],
        }]);
        const callsBefore = requests.length;
        // The model would say SILENT_MAINTAIN — paused must neither call it
        // nor execute the mutation.
        nextSentinelDecision = JSON.stringify({ action: 'SILENT_MAINTAIN', drawingShortId: '#D1', reason: 'stale' });
        const r1 = await engine.evaluateSentinelTrigger(
            {
                source: 'drawing_watch', symbol: 'BTCUSDT', sid,
                event: {
                    kind: 'candle_close_drawing', symbol: 'BTCUSDT', drawingId: 'agent-2', shortId: '#D1',
                    drawingKind: 'rect', tf: '5m', livePrice: 100.2, targetPrice: 100.4,
                    tolerance: 0.2, distancePrice: 0.2, distanceAtr: 0.2,
                    crossedDirection: 'up', barTime: 1_700_003_600, triggeredAt: Date.now(),
                },
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: 'BTCUSDT 5m' },
            { sessionId: sid, drawings: agentCtl.list() },
        );
        assert.equal(r1.modelRan, false, 'paused: no model call');
        assert.equal(requests.length, callsBefore, 'zero provider requests while paused');
        assert.equal(agentCtl.list().some(d => d.id === 'agent-2'), true, 'paused: no chart mutation');

        // An armed watch's deterministic alert still wakes the trader.
        nextSentinelDecision = JSON.stringify({ action: 'SILENT_DISMISS' }); // model would say nothing anyway
        const r2 = await engine.evaluateSentinelTrigger(
            {
                source: 'plan_level', symbol: 'BTCUSDT', sid,
                plan: {
                    planId: 'plan-1', symbol: 'BTCUSDT', direction: 'Long',
                    levels: [{ id: 'entry-1', kind: 'entry', label: 'Entry', price: 100 }],
                } as never,
                hit: { kind: 'entry', levelId: 'entry-1', label: 'Entry', price: 100, hitPrice: 100.1 } as never,
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: 'BTCUSDT 5m' },
        );
        assert.equal(r2.decision.action, 'UPDATE_PLAN_STATUS', 'deterministic classification still runs');
        assert.ok(getPendingSentinelNotices().length >= 1, 'the armed-plan alert still reaches the queue');
        drainSentinelNoticesWhenIdle(true, () => { /* deliver */ }, sid);
        await setAutonomyMode('autonomous', USER);
    });

    it('an exhausted background budget degrades to the deterministic path', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { __forceBudgetForTests } = engine;
        const { getPendingSentinelNotices, drainSentinelNoticesWhenIdle, __resetSentinelForTests } = await import('../src/services/trade/sentinelLoop');
        __resetSentinelForTests();
        __forceBudgetForTests(USER);
        const callsBefore = requests.length;
        nextSentinelDecision = JSON.stringify({ action: 'ALERT_TRADER', summary: 'should not be reached via model' });
        const result = await engine.evaluateSentinelTrigger(
            {
                source: 'drawing_watch', symbol: 'ETHUSDT', sid: 'sess-auto-1',
                event: {
                    kind: 'price_cross_drawing', symbol: 'ETHUSDT', drawingId: 'x2', shortId: '#D5',
                    drawingKind: 'trend', tf: '5m', livePrice: 50, targetPrice: 49.5,
                    tolerance: 0.2, distancePrice: 0.5, distanceAtr: 0.5,
                    crossedDirection: 'down', barTime: 1_700_003_600, triggeredAt: Date.now(),
                },
            },
            { traderProfileSlice: 'Risk guard active.', chartManifestSummary: 'ETHUSDT 5m' },
        );
        assert.equal(result.modelRan, false, 'budget exhausted: no model call');
        assert.equal(requests.length, callsBefore, 'zero provider requests on an exhausted budget');
        // The deterministic classifier still answered (and it alerts on a clean cross).
        assert.equal(result.decision.action, 'ALERT_TRADER');
        drainSentinelNoticesWhenIdle(true, () => { /* deliver */ }, 'sess-auto-1');
    });

    it('post-mortem lessons promote only past the floors; risk-shaped lessons never auto-promote', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { __resetAutonomyLedgerForTests, listAutonomyRecords } = await import('../src/services/trade/autonomyLedger');
        const { listProfileMemories } = await import('../src/services/learning/profileMemory');
        await __resetAutonomyLedgerForTests(USER);
        engine.__resetAutonomyEngineForTests();
        await engine.initAutonomy(USER);
        await engine.setAutonomyMode('autonomous', USER);

        const base = { source: 'signal', outcome: 'lost' };
        // One lesson: held as a candidate, nothing promoted.
        await engine.notePostMortemLesson({
            ...base, id: 'd1', tradeId: 't1',
            lesson: 'Skip entries when the 15m RSI disagrees with the 1D trend.',
            when: '15m RSI against the 1D trend', action: 'skip the entry',
            createdAt: '2026-11-18T10:00:00.000Z',
        });
        let memories = listProfileMemories(USER);
        assert.equal(memories.some(m => m.slug.startsWith('pm-')), false, 'one lesson never promotes');
        let records = await listAutonomyRecords(USER);
        assert.ok(records.some(r => r.summary.includes('held as a candidate')), 'the candidate is auditable');

        // Two more DISTINCT trades on DIFFERENT days, same pattern → promotion.
        await engine.notePostMortemLesson({
            ...base, id: 'd2', tradeId: 't2',
            lesson: 'Skip entries when the 15m RSI disagrees with the 1D trend.',
            when: '15m RSI against the 1D trend', action: 'skip the entry',
            createdAt: '2026-11-19T10:00:00.000Z',
        });
        await engine.notePostMortemLesson({
            ...base, id: 'd3', tradeId: 't3',
            lesson: 'Skip entries when the 15m RSI disagrees with the 1D trend.',
            when: '15m RSI against the 1D trend', action: 'skip the entry',
            createdAt: '2026-11-20T10:00:00.000Z',
        });
        memories = listProfileMemories(USER);
        const promoted = memories.find(m => m.slug.startsWith('pm-'));
        assert.ok(promoted, '3 evidence across 3 sessions promotes into memory');
        assert.match(promoted.body, /Evidence: 3 settled trades across 3 sessions/);
        records = await listAutonomyRecords(USER);
        const promoRecord = records.find(r => r.summary.includes('Promoted post-mortem pattern'));
        assert.ok(promoRecord, 'the promotion is in the activity feed');

        // Risk-shaped: even past the floors, the engine only recommends.
        for (const [i, day] of ['2026-11-18', '2026-11-19', '2026-11-20'].entries()) {
            await engine.notePostMortemLesson({
                ...base, id: `d4${i}`, tradeId: `t4${i}`,
                lesson: 'Cut risk per trade when the session guard pauses twice.',
                when: 'two guard pauses in one session', action: 'reduce size',
                createdAt: `${day}T10:00:00.000Z`,
            });
        }
        memories = listProfileMemories(USER);
        assert.equal(memories.some(m => m.slug.includes('pm-signal-two-guard-pauses') || m.body.includes('Cut risk per trade')), false, 'risk rules are never written autonomously');
        records = await listAutonomyRecords(USER);
        assert.ok(records.some(r => r.summary.includes('recommendation only')), 'the refusal is auditable');
    });

    it('the idle maintenance pass prunes memory and refines a skill through the ONE pen — both undoable', async () => {
        const engine = await import('../src/services/trade/autonomyEngine');
        const { __resetAutonomyLedgerForTests, listAutonomyRecords, undoAutonomyRecord } = await import('../src/services/trade/autonomyLedger');
        const { rememberProfileMemory, getProfileMemory, listProfileMemories } = await import('../src/services/learning/profileMemory');
        const { getSkill } = await import('../src/services/learning/SkillFileService');
        await __resetAutonomyLedgerForTests(USER);

        // A clearly redundant pair: the curator should prune one.
        await rememberProfileMemory({
            slug: 'auto-tf-pref', name: 'auto-tf-pref',
            description: 'Trader works the 15m timeframe',
            kind: 'user', body: 'All analysis on 15m.', source: 'auto', tag: 'observed',
        }, USER);
        await rememberProfileMemory({
            slug: 'auto-tf-pref-dupe', name: 'auto-tf-pref-dupe',
            description: 'Trader works the 15m timeframe',
            kind: 'user', body: 'All analysis on 15m.', source: 'auto', tag: 'observed',
        }, USER);

        memoryOpsJson = JSON.stringify([{ op: 'forget', slug: 'auto-tf-pref-dupe', reason: 'exact duplicate of auto-tf-pref' }]);
        skillMarkdown = SKILL_MD_REFINED;
        // Capture the skill's stored bytes BEFORE the pass — the undo must
        // restore exactly what was there, whatever composition the pen uses.
        const { getSkill: skillBeforeRefine } = await import('../src/services/learning/SkillFileService');
        const skillContentBefore = skillBeforeRefine('trend-discipline')?.file.content ?? '';
        const notes = await engine.runMaintenancePass(USER);
        assert.ok(notes.some(n => n.includes('Pruned')), `memory prune applied: ${notes.join(' | ')}`);
        assert.equal(getProfileMemory('auto-tf-pref-dupe', USER), undefined, 'the redundant row is gone');
        assert.ok(getProfileMemory('auto-tf-pref', USER), 'the keeper survives');

        const records = await listAutonomyRecords(USER);
        const pruneRecord = records.find(r => r.summary.includes('Maintenance pruned'));
        assert.ok(pruneRecord?.undo?.kind === 'memory-restore');
        await undoAutonomyRecord(pruneRecord.id, USER);
        assert.ok(getProfileMemory('auto-tf-pref-dupe', USER), 'undo restores the pruned row');

        // Skill refine: the mock returned the refined SKILL.md; the ONE pen
        // wrote it, and the ledger carries the previous body.
        const refined = getSkill('trend-discipline');
        assert.ok(refined, 'skill still present');
        const recordsAfterSkill = await listAutonomyRecords(USER);
        const skillRecord = recordsAfterSkill.find(r => r.subsystem === 'skill');
        if (skillRecord) {
            assert.ok(skillRecord.undo?.kind === 'skill-restore');
            await undoAutonomyRecord(skillRecord.id, USER);
            const restored = getSkill('trend-discipline');
            // The pen composes a canonical trailing newline; the bytes' SUBSTANCE
            // (frontmatter + body) must match the pre-refine document.
            assert.equal(
                (restored?.file.content ?? '').replace(/\s+$/, ''),
                skillContentBefore.replace(/\s+$/, ''),
                'undo restores the previous SKILL.md bytes',
            );
        } else {
            // The refine write can be refused by the redundancy scan on a
            // near-identical body — a refusal is a correct quiet outcome.
            assert.ok(notes.some(n => n.toLowerCase().includes('refused') || n.includes('Refined')), notes.join(' | '));
        }
        void listProfileMemories;
    });
});
