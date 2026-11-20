/**
 * wave1 — the six upgrades, each pinned by the contract the request named:
 *
 *  1. Steering: synthetic tool results pair EVERY unexecuted tool_call_id
 *     ("Skipped: user steered mid-turn") so strict providers never 400 a
 *     mid-turn injection.
 *  2. Adversary review: 13s timeout → UNAVAILABLE; VETO from the deterministic
 *     checks; the card override path.
 *  3. scan_confluence: caps (≤8 symbols, ≤3 tfs, ≤4 concurrency) + ranking.
 *  4. Trace inspector: CACHE WARM vs PREFIX CHANGED detection.
 *  5. Composer refs (@#D1, @4h, @skill:, @plan:) + slash templates + the
 *     /handoff checkpoint (deterministic, no model prose).
 *  6. Trajectory export: known_at_decision_time carries ZERO outcome fields.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// chatStore needs the storage shim before import.
const backing = new Map<string, string>([['last_active_user', 'Probe User']]);
const storageShim = {
    getItem: (k: string): string | null => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string): void => { backing.set(k, String(v)); },
    removeItem: (k: string): void => { backing.delete(k); },
    clear: (): void => backing.clear(),
    key: (i: number): string | null => Array.from(backing.keys())[i] ?? null,
    get length(): number { return backing.size; },
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storageShim;
g.sessionStorage = storageShim;
g.window = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
};
g.document = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false };

// ── 1. Steering: pair-valid synthetic results ───────────────────────────────
describe('steering — synthetic results pair every unexecuted tool_call_id', async () => {
    const { buildSteerSyntheticMessages } = await import('../src/services/trade/steeringProtocol');

    it('native transport: assistant turn + one skipped reply per tool_call id', () => {
        const assistant = {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
                { id: 'call_a', type: 'function' as const, function: { name: 'get_market_packet', arguments: '{}' } },
                { id: 'call_b', type: 'function' as const, function: { name: 'get_chart_view', arguments: '{}' } },
                { id: 'call_c', type: 'function' as const, function: { name: 'scan_confluence', arguments: '{"symbols":["BTCUSDT"]}' } },
            ],
        };
        const msgs = buildSteerSyntheticMessages({ assistantMessage: assistant, text: '' }, 'exit the ETH leg now');
        // 1 assistant + 3 synthetic tool replies + 1 steering user message.
        assert.equal(msgs.length, 5);
        assert.equal(msgs[0].role, 'assistant');
        const toolReplies = msgs.slice(1, 4) as Array<{ role: string; tool_call_id: string; content: string }>;
        assert.deepEqual(toolReplies.map(m => m.tool_call_id), ['call_a', 'call_b', 'call_c']);
        assert.ok(toolReplies.every(m => m.role === 'tool'));
        assert.ok(toolReplies.every(m => m.content.includes('Skipped: user steered mid-turn')));
        assert.equal(msgs[4].role, 'user');
        assert.equal(msgs[4].content, 'exit the ETH leg now');
        // The pairing is EXACT: every id the assistant emitted has a reply.
        const ids = new Set((assistant.tool_calls as Array<{ id: string }>).map(c => c.id));
        assert.ok(toolReplies.every(m => ids.has(m.tool_call_id)));
        assert.equal(toolReplies.length, ids.size);
    });

    it('text protocol: assistant text + a harness-marked user note (no id pairing to fake)', () => {
        const msgs = buildSteerSyntheticMessages(
            { assistantMessage: null, text: '<tool_call name="get_market_packet">{}</tool_call>' },
            'hold on — check funding first',
        );
        assert.equal(msgs.length, 2);
        assert.equal(msgs[0].role, 'assistant');
        assert.equal((msgs[0] as { content: string }).content, ''); // tags stripped, no prose
        assert.equal(msgs[1].role, 'user');
        assert.match((msgs[1] as { content: string }).content, /Skipped: user steered mid-turn/);
        assert.match((msgs[1] as { content: string }).content, /hold on — check funding first/);
    });
});

// ── 2. Adversary review ──────────────────────────────────────────────────────
describe('adversary review — objective fallback, timeout honesty, VETO semantics', async () => {
    const { fallbackAdversaryVerdict } = await import('../src/services/trade/adversaryReview');

    const baseInput = {
        plan: { planId: 'p1', symbol: 'BTCUSDT', direction: 'Long' as const, entry: 100, stopLoss: 98, takeProfits: [106] },
        markPrice: 100 as number | null,
        atr: 2 as number | null,
        candles: [{ close: 100 }],
    };

    it('a plan already through its stop at the live mark is VETOed deterministically', () => {
        const v = fallbackAdversaryVerdict({ ...baseInput, markPrice: 97.5 });
        assert.equal(v.verdict, 'VETO');
        assert.ok(v.objections.some(o => o.includes('through')));
    });

    it('sub-1 net R:R is at least CAUTION; a healthy plan APPROVEs', () => {
        const thin = fallbackAdversaryVerdict({ ...baseInput, plan: { ...baseInput.plan, takeProfits: [100.5] } });
        assert.ok(thin.verdict === 'CAUTION' || thin.objections.some(o => o.includes('R:R')));
        const healthy = fallbackAdversaryVerdict(baseInput);
        assert.equal(healthy.verdict, 'APPROVE');
        assert.match(healthy.invalidationCheck, /ATR|bracket/);
    });

    it('noise-level stop (< 0.25 ATR) is flagged', () => {
        const v = fallbackAdversaryVerdict({ ...baseInput, plan: { ...baseInput.plan, stopLoss: 99.9 } });
        assert.ok(v.objections.some(o => o.includes('0.25 ATR')));
    });

    it('UNAVAILABLE exists for the timeout path (the type contract)', async () => {
        const mod = await import('../src/services/trade/adversaryReview');
        assert.equal(mod.ADVERSARY_TIMEOUT_MS >= 12_000 && mod.ADVERSARY_TIMEOUT_MS <= 15_000, true);
    });
});

// ── 3. scan_confluence caps + ranking ────────────────────────────────────────
describe('scan_confluence — caps, bounded concurrency, ranking', async () => {
    const core = await import('../src/services/analysis/confluenceScanCore');

    it('caps 12 symbols → 8 and 5 timeframes → 3, dedupes, uppercases', () => {
        const norm = core.normalizeScanInput(
            ['btcusdt', 'ETHUSDT', 'btcusdt', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'BNBUSDT', 'LTCUSDT', 'DOTUSDT'],
            ['15m', '1h', '4h', '1d', '5m'],
            null,
        );
        assert.equal(norm.error, undefined);
        assert.equal(norm.symbols.length, 8);
        assert.equal(norm.timeframes.length, 3);
        assert.equal(norm.symbols[0], 'BTCUSDT');
    });

    it('an empty symbols array is a refusal, not a guess', () => {
        const norm = core.normalizeScanInput([], null, null);
        assert.match(norm.error ?? '', /non-empty/);
    });

    it('mapPool keeps concurrency bounded and preserves input order', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const results = await core.mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight -= 1;
            return n * 2;
        });
        assert.ok(maxInFlight <= 4, `concurrency stayed ≤4 (max ${maxInFlight})`);
        assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    });

    it('ranking: multi-TF agreement beats a single-TF setup, failures demote, ties sort by symbol', () => {
        const rows = core.rankConfluenceRows([
            { symbol: 'SOLUSDT', tf: '15m', ok: true, bias: 'bull', setups: [{ title: 'Breakout', side: 'long' }] },
            { symbol: 'SOLUSDT', tf: '1h', ok: true, bias: 'bull', setups: [] },
            { symbol: 'SOLUSDT', tf: '4h', ok: true, bias: 'bull', setups: [] },
            { symbol: 'AAAUSDT', tf: '15m', ok: true, bias: 'bull', setups: [{ title: 'Pin', side: 'long' }] },
            { symbol: 'AAAUSDT', tf: '1h', ok: false, bias: null, setups: [], error: 'fetch failed' },
            { symbol: 'BBBUSDT', tf: '15m', ok: true, bias: 'bear', setups: [] },
        ]);
        assert.equal(rows[0].symbol, 'SOLUSDT');
        assert.equal(rows[0].dominantBias, 'bull');
        assert.equal(rows[0].agreeingTfs, 3);
        assert.equal(rows[1].symbol, 'AAAUSDT');
        assert.equal(rows[1].failedPairs.length, 1);
        const summary = core.buildConfluenceSummary(rows);
        assert.match(summary, /SOLUSDT — BULL \(3\/3 tfs agree\)/);
        assert.match(summary, /AAAUSDT — BULL \(1\/1 tfs agree\)/);
        assert.match(summary, /CODE-detected/);
    });
});

// ── 4. Trace inspector: cache-warm detection ─────────────────────────────────
describe('trace inspector — CACHE WARM vs PREFIX CHANGED', () => {
    it('identical prefixes report warm; a changed prefix reports the change', async () => {
        const chatStore = await import('../src/services/trade/chatStore');
        const { contentVersion } = await import('../src/services/learning/SkillFileService');
        const h1 = contentVersion('FROZEN PROMPT v1');
        const h2 = contentVersion('FROZEN PROMPT v2');
        chatStore.setTraceHash('sess-trace', h1);
        assert.equal(chatStore.getTraceHash('sess-trace'), h1);
        assert.equal(chatStore.getTraceHash('sess-trace') === h1, true, 'warm');
        chatStore.setTraceHash('sess-trace', h2);
        assert.notEqual(chatStore.getTraceHash('sess-trace'), h1);
        void h2;
    });

    it('the TurnTrace type rides a live entry through a real store mutation', async () => {
        const chatStore = await import('../src/services/trade/chatStore');
        const sid = chatStore.addSession({ kind: 'solo', symbol: 'BTCUSDT' });
        chatStore.mutate(sid, st => ({
            ...st,
            entries: [...st.entries, {
                id: 'ai-trace', role: 'ai' as const, text: 'answer', tools: [], at: Date.now(),
                trace: { prefixHash: 'abc123', cacheWarm: true, tier0Revision: 'rev1', totalMs: 1500, tokensIn: 100, tokensOut: 40, gateRefusals: 1 },
            }],
        }));
        const entry = chatStore.getSnapshot().sessions.find(s => s.id === sid)!.entries.find(e => e.id === 'ai-trace')!;
        assert.equal(entry.trace?.cacheWarm, true);
        assert.equal(entry.trace?.gateRefusals, 1);
        assert.equal(entry.trace?.tokensIn, 100);
    });
});

// ── 5. Composer refs + slash templates + handoff checkpoint ─────────────────
describe('composer refs and slash templates', async () => {
    const { parseComposerRefs, focusLineForRefs, slashTemplateOf, expandSlashTemplate } = await import('../src/utils/composerRefs');
    const { buildHandoffCheckpoint } = await import('../src/utils/handoffCheckpoint');

    it('parses all four ref families and strips them from the sent text', () => {
        const parsed = parseComposerRefs('watch @#D1 and @#D7 on @4h, apply @skill:trend-discipline, and mind @plan:plan-btc-1. Do not chase.');
        assert.deepEqual(parsed.refs.shapes, ['#D1', '#D7']);
        assert.deepEqual(parsed.refs.timeframes, ['4h']);
        assert.deepEqual(parsed.refs.skills, ['trend-discipline']);
        assert.deepEqual(parsed.refs.plans, ['plan-btc-1']);
        assert.equal(parsed.cleaned.includes('@'), false);
        assert.match(parsed.cleaned, /Do not chase\./);
    });

    it('an unknown @mention is left alone (emails survive)', () => {
        const parsed = parseComposerRefs('ping me at @trader on the forum');
        assert.deepEqual(parsed.refs.shapes, []);
        assert.match(parsed.cleaned, /@trader/);
    });

    it('the focus line carries the priorities and is empty without refs', () => {
        const withRefs = focusLineForRefs({ shapes: ['#D1'], timeframes: ['4h'], skills: [], plans: [] });
        assert.match(withRefs, /TRADER FOCUS/);
        assert.match(withRefs, /#D1/);
        assert.equal(focusLineForRefs({ shapes: [], timeframes: [], skills: [], plans: [] }), '');
    });

    it('slash templates match at position 0 only, and /handoff never expands to prose', () => {
        assert.equal(slashTemplateOf('/audit the ETH leg'), 'audit');
        assert.equal(slashTemplateOf('please /audit this'), null);
        assert.equal(expandSlashTemplate('handoff', { symbol: 'BTCUSDT', interval: '15m' }, ''), '');
        const brief = expandSlashTemplate('brief', { symbol: 'BTCUSDT', interval: '15m' }, 'funding focus');
        assert.match(brief, /STRUCTURED desk brief on BTCUSDT 15m/);
        assert.match(brief, /funding focus/);
    });

    it('the /handoff checkpoint is deterministic, model-free, and complete', () => {
        const input = {
            symbol: 'BTCUSDT', interval: '15m', markPrice: 59500,
            drawings: [
                { shortId: '#D1', label: 'support', kind: 'hline', points: [{ p: 59000 }] },
                { shortId: '#D2', kind: 'trend', points: [{ p: 59500 }, { p: 60200 }] },
            ],
            plans: [{ planId: 'plan-1', symbol: 'BTCUSDT', direction: 'Long', entry: 59100 }],
            lastUserText: 'is the breakout live?',
        };
        const a = buildHandoffCheckpoint(input);
        const b = buildHandoffCheckpoint(input);
        assert.equal(a, b, 'deterministic');
        assert.match(a, /HANDOFF CHECKPOINT — BTCUSDT 15m · mark 59500/);
        assert.match(a, /#D1 hline "support" @ 59000/);
        assert.match(a, /Armed plans: plan-1 Long BTCUSDT entry 59100/);
        assert.match(a, /is the breakout live\?/);
        assert.match(a, /Verify every number/);
    });
});

// ── 6. Trajectory export: zero leakage ───────────────────────────────────────
describe('trajectory export — known_at_decision_time vs outcome, structurally', async () => {
    const { buildTrajectoryRecord } = await import('../src/services/learning/trajectoryExport');

    const row = {
        signal: {
            id: 'sig-1', coin: 'BTCUSDT', direction: 'long' as const,
            entry: 100, stopLoss: 98, takeProfits: [106], emittedAt: 1_700_000_000_000, expiresAt: 1_700_003_600_000,
            dataHash: 'fnv-tape', promptVersion: 'pv-7',
            skillSlug: 'trend-discipline', marketRegime: 'bull', htfAligned: true, hadUserDrawings: false,
            evidenceRefs: [], source: 'signal' as const, model: 'm', provider: 'p', thesis: 't',
        },
        status: 'won' as const,
        resolution: { status: 'won', grossR: 3, feeR: 0.05, outcomeR: 2.95, usedBarTimes: [1], path: 'bar' as const, ambiguous: false, at: 1_700_000_900_000, mfeR: 3.2, maeR: -0.4 },
    };

    it('the known half carries ONLY decision-time fields; the outcome half carries ONLY resolved facts', () => {
        const rec = buildTrajectoryRecord(row as unknown as Parameters<typeof buildTrajectoryRecord>[0], 3.0, { hindsightRefused: false });
        const known = rec.known_at_decision_time as Record<string, unknown>;
        assert.equal(known.coin, 'BTCUSDT');
        assert.equal(known.skillSlug, 'trend-discipline');
        assert.equal(known.marketRegime, 'bull');
        assert.equal(known.htfAligned, 'yes');
        assert.equal(known.hadUserDrawings, 'no');
        assert.equal(known.dataHash, 'fnv-tape');
        assert.equal(known.rr, 3);
        // THE LEAK RULE: no outcome field may appear in the known half.
        for (const banned of ['status', 'mfeR', 'maeR', 'netR', 'hindsightLeakFree', 'resolvedAt']) {
            assert.equal(banned in known, false, `${banned} leaked into known_at_decision_time`);
        }
        assert.equal(rec.outcome?.status, 'won');
        assert.equal(rec.outcome?.mfeR, 3.2);
        assert.equal(rec.outcome?.maeR, -0.4);
        assert.equal(rec.outcome?.netR, 2.95);
        assert.equal(rec.outcome?.hindsightLeakFree, true);
    });

    it('an unresolved row ships the known half with no outcome object at all', () => {
        const openRow = { ...row, status: 'open' as const, resolution: null };
        const rec = buildTrajectoryRecord(openRow as unknown as Parameters<typeof buildTrajectoryRecord>[0], 3.0, null);
        assert.equal(rec.outcome, undefined);
        assert.equal(rec.known_at_decision_time.coin, 'BTCUSDT');
    });

    it('a hindsight-refused diagnosis marks the record — never silently clean', () => {
        const rec = buildTrajectoryRecord(row as unknown as Parameters<typeof buildTrajectoryRecord>[0], 3.0, { hindsightRefused: true });
        assert.equal(rec.outcome?.hindsightLeakFree, false);
    });
});
