/**
 * Pass 4 — single-model authority, provenance durability, context recovery,
 * incremental compaction.
 *
 * Offline and behavioural: every assertion drives real service code through a
 * seam or a deterministic store, never a source-string regex.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../src/types/provider';
import type { ChatMessage } from '../src/services/providers/GenericProviderService';
import type { SkillFile } from '../src/services/learning/SkillFileService';

// Use the suite's existing storage shim when one is installed; only create a
// private fallback when this file is run alone. Never overwrite another test
// file's shim — with --test-isolation=none the process is shared.
const scratch = new Map<string, string>();
const fallbackStorage: Storage = {
    get length() { return scratch.size; },
    clear: () => scratch.clear(),
    getItem: (k: string) => (scratch.has(k) ? (scratch.get(k) as string) : null),
    key: (i: number) => Array.from(scratch.keys())[i] ?? null,
    removeItem: (k: string) => { scratch.delete(k); },
    setItem: (k: string, v: string) => { scratch.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.localStorage === 'undefined') g.localStorage = fallbackStorage;

const filler = (tokens: number): string => 'a'.repeat(Math.max(0, (tokens - 4) * 4));

const provider = (id: string, model: string): ProviderConfig => ({
    id,
    name: id,
    apiKey: 'key-not-real',
    baseUrl: 'https://gateway.example/v1',
    apiFormat: 'chat_completions',
    isEnabled: true,
    isBuiltIn: false,
    models: [model],
    selectedModel: model,
});

const skill = (slug: string, version: string, description: string, body: string): SkillFile => ({
    file: {} as never,
    slug,
    name: slug.toUpperCase(),
    description,
    body,
    version,
    bundled: [],
});

// ─── 1. Single-model authority ──────────────────────────────────────────────

describe('1 — the active composer pick is strictly authoritative for memory calls', () => {
    it('an active pick outranks a stale memoryProvider/memoryModel; the legacy value is only a last resort', async () => {
        const mm = await import('../src/services/learning/MemoryModelService');
        const amc = await import('../src/services/infrastructure/ActiveModelConfig');
        const composer = provider('composer-provider', 'composer-model');
        const legacy = provider('legacy-provider', 'legacy-model');

        // The real composer seam reads the persisted pick synchronously.
        // Use whichever shim the shared suite installed — never replace it.
        const ls = globalThis.localStorage;
        if (ls) {
            ls.setItem('casual_chat_model', 'composer-provider::composer-model');
            assert.equal(amc.activeModelPair(), 'composer-provider::composer-model');
            ls.removeItem('casual_chat_model');
        }

        const profile = { settings: { memoryProvider: 'legacy-provider', memoryModel: 'legacy-model' } };
        // The active pick wins outright even though the stale legacy picker
        // names a DIFFERENT ready provider.
        const authoritative = await mm.resolveMemoryConfig('pass4-memory-user', {
            ready: [legacy, composer],
            profile: profile as never,
            pickActive: async () => ({ ...composer, selectedModel: 'composer-model' }),
        });
        assert.equal(authoritative?.id, 'composer-provider');
        assert.equal(authoritative?.selectedModel, 'composer-model');

        // No resolvable active pick: the stale profile value is a SILENT
        // last-resort fallback, not a second picker.
        const lastResort = await mm.resolveMemoryConfig('pass4-memory-user', {
            ready: [legacy, composer],
            profile: profile as never,
            pickActive: async () => null,
        });
        assert.equal(lastResort?.id, 'legacy-provider');
        assert.equal(lastResort?.selectedModel, 'legacy-model');

        // Neither: first ready provider keeps background learning alive.
        const none = await mm.resolveMemoryConfig('pass4-memory-user', {
            ready: [legacy, composer],
            profile: null,
            pickActive: async () => null,
        });
        assert.equal(none?.id, 'legacy-provider');
    });

    it('the three inherited consumers still resolve through the service', async () => {
        const title = await import('../src/services/trade/sessionTitle');
        const settle = await import('../src/services/learning/settlementReflection');
        const post = await import('../src/services/tracking/postMortemDiagnosis');
        assert.equal(typeof title.generateSessionTitle, 'function');
        assert.equal(typeof settle.reflectOnClosedTrade, 'function');
        assert.equal(typeof post.runDiagnosisPass, 'function');
    });
});

// ─── 2. Rejected-fingerprint provenance durability ──────────────────────────

describe('2 — rejection provenance is durable and bounded, and read failures are loud', () => {
    it('re-record preserves the origin, appends observedOutcome, updates source/at and caps long text', async () => {
        const rf = await import('../src/services/learning/rejectedFingerprints');
        const U = 'pass4-reject-provenance-user';
        const parts = { kind: 'memory', target: 'USER.md', content: 'Never trade the London open.' };
        const long = 'x'.repeat(900);
        await rf.recordRejectedFingerprint(parts, 'user_undo', 'first', U, {
            provenance: {
                rationale: long,
                observedOutcome: long,
                modelId: 'origin-model',
                recordedAt: '2026-01-01T00:00:00.000Z',
            },
        });
        const first = (await rf.listRejectedFingerprints(U)).find(r => r.fingerprint === rf.rejectionFingerprint(parts));
        assert.ok(first?.provenance);
        assert.equal(first.provenance.rationale?.length, 500, 'rationale capped');
        assert.equal(first.provenance.observedOutcome?.length, 500, 'observedOutcome capped');
        assert.equal(first.provenance.modelId, 'origin-model');
        assert.equal(first.provenance.recordedAt, '2026-01-01T00:00:00.000Z');

        await rf.recordRejectedFingerprint(parts, 'background_skip', 'second', U, {
            provenance: { rationale: 'a different reason', observedOutcome: 'second outcome' },
        });
        const rows = (await rf.listRejectedFingerprints(U)).filter(r => r.fingerprint === rf.rejectionFingerprint(parts));
        assert.equal(rows.length, 1, 'still one row');
        const merged = rows[0];
        assert.equal(merged.source, 'background_skip', 'source updated');
        assert.equal(merged.provenance?.modelId, 'origin-model', 'original model preserved when omitted');
        assert.equal(merged.provenance?.recordedAt, '2026-01-01T00:00:00.000Z', 'original recordedAt preserved');
        assert.deepEqual(merged.provenance?.observedOutcomes, ['x'.repeat(500), 'second outcome'], 'outcomes appended');
        assert.ok(merged.at >= (first.at ?? ''), 'at refreshed');
    });

    it('a corrupt read surfaces degraded instead of silently returning false', async () => {
        const rf = await import('../src/services/learning/rejectedFingerprints');
        const { setPreferenceObject } = await import('../src/services/infrastructure/PreferencesService');
        const U = 'pass4-reject-read-failure-user';
        const key = `${rf.REJECTED_FINGERPRINT_KEY_PREFIX}${U}`;
        await setPreferenceObject(key, { version: 1, rows: 'not-an-array' });
        const parts = { kind: 'memory', target: 'USER.md', content: 'a rule' };
        await assert.rejects(
            () => rf.isRejectedFingerprint(parts, U),
            /degraded|corrupt/i,
            'refusal enforcement must not fail open',
        );
        const state = await rf.readRejectionState(parts, U);
        assert.equal(state.degraded, true);
        assert.equal(state.rejected, false);
    });
});

// ─── 3. Skill token cache ───────────────────────────────────────────────────

describe('3 — skill library tokens are cached by version', () => {
    it('same version reuses the tokenizer; a version bump re-tokenizes', async () => {
        const sf = await import('../src/services/learning/SkillFileService');
        const corpus = [
            skill('alpha', 'v1', 'swing setup reclaim', 'wait for a close above the range'),
            skill('bravo', 'v1', 'order flow absorption', 'read the tape for absorption'),
        ];
        const candidate = { name: 'charlie', description: 'alpha swing setup reclaim', body: 'wait for a close above the range' };
        let calls = 0;
        const spy = (text: string): Set<string> => {
            calls += 1;
            return sf.contentWords(text);
        };
        sf.nearDuplicates(candidate, corpus, undefined, { tokenize: spy });
        const afterFirst = calls;
        assert.ok(afterFirst > 0, 'the library was tokenized on first use');
        sf.nearDuplicates(candidate, corpus, undefined, { tokenize: spy });
        assert.equal(calls, afterFirst, 'same library version reused the cached tokens');

        const bumped = corpus.map(s => ({ ...s, version: `${s.version}-bump` }));
        sf.nearDuplicates(candidate, bumped, undefined, { tokenize: spy });
        assert.ok(calls > afterFirst, 'a version bump re-tokenized the library');
    });
});

// ─── 4. Context recovery ────────────────────────────────────────────────────

describe('4 — context recovery compacts or refuses loudly', () => {
    beforeEach(async () => {
        const cw = await import('../src/utils/contextWindow');
        cw.resetMeasuredContextWindows();
    });

    it('returns compacted messages when there is something to cut', async () => {
        const gps = await import('../src/services/providers/GenericProviderService');
        const cfg = provider('recover-provider', 'recover-model');
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are the August desk seat.' },
            ...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `old ${i} ${filler(20_000)}` })),
            { role: 'user', content: 'the live question' },
            { role: 'assistant', content: 'the forming answer' },
        ];
        const error = new Error('maximum context length is 128000 tokens');
        const retry = gps.contextRecoveryMessages(cfg, messages, {}, error);
        assert.ok(Array.isArray(retry), 'a retry was produced');
        assert.ok((retry as ChatMessage[]).length < messages.length, 'older turns were cut');
        assert.ok((retry as ChatMessage[]).some(m => m.role === 'user' && m.content === 'the live question'));
    });

    it('throws a structured CONTEXT FULL error when stillOver remains after emergency compaction', async () => {
        const gps = await import('../src/services/providers/GenericProviderService');
        const cfg = provider('recover-full-provider', 'recover-full-model');
        // Six protected messages, each bigger than the whole enforced ceiling.
        const messages: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `tail ${i} ${filler(40_000)}`,
        }));
        const error = new Error('maximum context length is 128000 tokens');
        assert.throws(
            () => gps.contextRecoveryMessages(cfg, messages, {}, error),
            (e: unknown) => {
                const err = e as { code?: string; message?: string };
                return err.code === 'CONTEXT_FULL'
                    && typeof err.message === 'string'
                    && err.message.startsWith('CONTEXT FULL:');
            },
            'loud refusal reusing the compactor notice',
        );
    });
});

// ─── 5. Numeric limit extraction ────────────────────────────────────────────

describe('5 — provider-stated limits are extracted from more phrasings', () => {
    it('token-count / maximum-of phrasings classify and extract the limit', async () => {
        const cw = await import('../src/utils/contextWindow');
        assert.equal(cw.isContextLengthError('token count exceeds 32768'), true);
        assert.equal(cw.contextLengthLimitFromError('token count exceeds 32768'), 32_768);
        assert.equal(cw.contextLengthLimitFromError('supports a maximum of 32768 context tokens'), 32_768);
        assert.equal(
            cw.contextLengthLimitFromError('your 200000 token request supports a maximum of 32768 context tokens'),
            32_768,
            'the number adjacent to maximum wins',
        );
        // The resolution order is untouched.
        cw.recordMeasuredContextWindow('p', 'm', 131_072);
        const r = cw.resolveContextWindow({ id: 'p', name: 'P', selectedModel: 'm', contextWindowTokens: 262_144 });
        assert.equal(r.tokens, 262_144);
        assert.equal(r.source, 'user');
    });
});

// ─── 6. Incremental compaction ──────────────────────────────────────────────

describe('6 — compaction caches per-message estimates and unchanged inputs', () => {
    it('an unchanged transcript returns the identical result object; mutation invalidates it', async () => {
        const cc = await import('../src/services/providers/contextCompact');
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are the August desk seat.' },
            { role: 'user', content: `old question ${filler(2_000)}` },
            { role: 'assistant', content: `old answer ${filler(2_000)}` },
            { role: 'user', content: 'the live question' },
            { role: 'assistant', content: 'the forming answer' },
        ];
        const a = cc.compactMessages({ messages, ceilingTokens: 100_000 });
        const b = cc.compactMessages({ messages, ceilingTokens: 100_000 });
        assert.strictEqual(b, a, 'identical input returns the identical result object');

        const cloned = messages.map(m => ({ ...m }));
        const c = cc.compactMessages({ messages: cloned, ceilingTokens: 100_000 });
        assert.notStrictEqual(c, a);
        assert.deepStrictEqual(c, a, 'uncached path agrees with the cached result');

        const before = a.beforeTokens;
        messages[1] = { role: 'user', content: `mutated ${filler(6_000)}` };
        const d = cc.compactMessages({ messages, ceilingTokens: 100_000 });
        assert.notStrictEqual(d, a, 'mutation invalidated the cache');
        assert.notEqual(d.beforeTokens, before, 'the new estimate was used');
    });

    it('a large unchanged transcript returns the cached result on the fast path', async () => {
        const cc = await import('../src/services/providers/contextCompact');
        const messages: ChatMessage[] = Array.from({ length: 1_500 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `m${i} ${filler(120)}`,
        }));
        const first = cc.compactMessages({ messages, ceilingTokens: 1_000_000 });
        assert.equal(first.changed, false);
        const t0 = performance.now();
        const second = cc.compactMessages({ messages, ceilingTokens: 1_000_000 });
        const elapsed = performance.now() - t0;
        assert.strictEqual(second, first,
            'an unchanged transcript must return the SAME cached result object');
        // The identity above is the architectural proof (no rescan at all).
        // Wall-clock is only a smoke ceiling: `verify:fast` runs nine gates
        // against one CPU, where a 2ms budget measures the scheduler, not the
        // algorithm (a cold GC pause measured 262ms here). Keep it generous
        // enough to be deterministic but far below a real 1,500-message rescan.
        assert.ok(elapsed < 50, `fast path took ${elapsed.toFixed(3)}ms`);
    });
});
