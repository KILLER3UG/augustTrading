/**
 * pass2Backend — offline pins for the Pass 2 backend fixes:
 *
 *  - per-session re-prime of the frozen curated-memory snapshot;
 *  - unified Chat+Desk `session_search` with a surface tag;
 *  - turn-scoped `update_plan` validation and its ephemeral store;
 *  - consecutive failed-call stall exit;
 *  - the durable rejected-fingerprint list;
 *  - the complete skill_manage undo snapshot contract.
 *
 * ZERO network and ZERO model calls. Every store is a localStorage shim, every
 * username is unique to this file, and clocks are injected. Tests share one
 * process (--test-isolation=none), so `withUser` restores the ambient user.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'pass2-probe']]);
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
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
};
g.document = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false };

const withUser = async <T,>(user: string, fn: () => Promise<T>): Promise<T> => {
    const prev = backing.get('last_active_user');
    backing.set('last_active_user', user);
    try { return await fn(); } finally {
        if (prev === undefined) backing.delete('last_active_user');
        else backing.set('last_active_user', prev);
    }
};

describe('2A.1 — frozen snapshot is re-primed at a session boundary', () => {
    it('stays frozen mid-session but picks up disk writes on re-prime', async () => {
        const U = 'pass2-snapshot-user';
        await withUser(U, async () => {
            const m = await import('../src/services/learning/curatedMemory');
            await m.setCuratedMemoryText('user', '## [2026-01-01]\nOriginal rule.', U);
            const first = await m.primeCuratedMemorySnapshot(U);
            assert.match(first.userMd, /Original rule/);
            await m.setCuratedMemoryText('user', '## [2026-01-02]\nRewritten rule.', U);
            // The frozen prefix is unchanged within the session (KV cache).
            assert.match(m.getCachedCuratedMemorySnapshot(U).userMd, /Original rule/);
            // The named session-boundary re-prime reads the NEW disk bytes.
            const second = await m.reprimeCuratedMemorySnapshotForSession(U);
            assert.match(second.userMd, /Rewritten rule/);
            assert.match(m.getCachedCuratedMemorySnapshot(U).userMd, /Rewritten rule/);
        });
    });
});

describe('2A.2 — unified Chat + Desk session search', () => {
    it('tags hits with their home surface and reports honest per-surface counts', async () => {
        const m = await import('../src/services/trade/sessionSearchTool');
        const result = {
            hits: [
                { sessionId: 'chat-1', title: 'Chat thread', at: '2026-11-20T00:00:00.000Z', role: 'ai' as const,
                  excerpt: 'chat hit', score: 9, before: [], after: [], surface: 'chat' as const },
                { sessionId: 'desk-1', title: 'Desk dock', at: '2026-11-19T00:00:00.000Z', role: 'user' as const,
                  excerpt: 'desk hit', score: 4, before: [], after: [], surface: 'desk' as const },
            ],
            scannedSessions: 1, scannedEntries: 1,
            matchedBySurface: { chat: 1, desk: 1 },
        };
        const digest = m.formatUnifiedSessionSearchDigest(result, 3000);
        assert.match(digest, /\(chat\) Chat thread/);
        assert.match(digest, /\(desk\) Desk dock/);
        assert.match(digest, /Chat 1 · Desk 1/);
        assert.match(digest, /verbatim excerpts/);
    });

    it('stops at a whole hit at the same 3000-char budget and says what was withheld', async () => {
        const m = await import('../src/services/trade/sessionSearchTool');
        const hits = Array.from({ length: 6 }, (_, i) => ({
            sessionId: `s${i}`, title: `Session ${i}`, at: '2026-11-20T00:00:00.000Z', role: 'ai' as const,
            excerpt: 'x'.repeat(700), score: 10 - i, before: [], after: [], surface: 'chat' as const,
        }));
        const digest = m.formatUnifiedSessionSearchDigest({
            hits, scannedSessions: 6, scannedEntries: 18, matchedBySurface: { chat: 6, desk: 0 },
        }, 3000);
        assert.ok(digest.length <= 3100, `digest leaked past budget: ${digest.length}`);
        assert.match(digest, /more match\(es\) withheld/);
        assert.ok(!/Session 3/.test(digest), 'a partial hit leaked past the cap');
    });
});

describe('2A.4 — consecutive failed-call stall exit', () => {
    it('detects the second consecutive identical failure, not a success or a different call', async () => {
        const { detectConsecutiveToolFailures } = await import('../src/services/analysis/DeskToolsService');
        const fail = (name: string, args: string) => ({ name, args, ok: false, refused: true });
        const ok = (name: string, args: string) => ({ name, args, ok: true, refused: false });
        assert.equal(detectConsecutiveToolFailures([fail('memory', '{"target":"user"}'), fail('memory', '{"target":"user"}')])?.name, 'memory');
        assert.equal(detectConsecutiveToolFailures([fail('memory', 'a'), fail('memory', 'b')]), null);
        assert.equal(detectConsecutiveToolFailures([fail('memory', 'a'), ok('memory', 'a')]), null);
        assert.equal(detectConsecutiveToolFailures([fail('a', 'x')]), null);
    });
});

describe('2A.4 — durable rejected fingerprints', () => {
    it('normalizes whitespace/case and gives a deterministic hash', async () => {
        const m = await import('../src/services/learning/rejectedFingerprints');
        assert.equal(
            m.rejectionFingerprint({ kind: 'Memory', target: 'USER.md', content: '  Max   Risk  1%  ' }),
            m.rejectionFingerprint({ kind: 'memory', target: 'user.md', content: 'max risk 1%' }),
        );
        assert.notEqual(
            m.rejectionFingerprint({ kind: 'memory', target: 'user', content: 'rule A' }),
            m.rejectionFingerprint({ kind: 'memory', target: 'user', content: 'rule B' }),
        );
        assert.equal(m.hashRejectionText('abc'), m.hashRejectionText('abc'));
    });

    it('records an undo and skips the same rule for that user only', async () => {
        const U = 'pass2-reject-user';
        await withUser(U, async () => {
            const m = await import('../src/services/learning/rejectedFingerprints');
            const parts = { kind: 'memory', target: 'USER.md', content: 'Never trade the London open.' };
            assert.equal(await m.isRejectedFingerprint(parts, U), false);
            const fp = await m.recordRejectedFingerprint(parts, 'user_undo', 'USER.md · 1 rule', U);
            assert.equal(await m.isRejectedFingerprint(parts, U), true);
            assert.equal(fp.length > 8, true);
            const rows = await m.listRejectedFingerprints(U);
            assert.equal(rows.filter(r => r.fingerprint === fp).length, 1, 'a re-record must not duplicate');
            await m.recordRejectedFingerprint(parts, 'user_undo', 'USER.md · 1 rule', U);
            assert.equal((await m.listRejectedFingerprints(U)).length, 1);
            assert.equal(await m.isRejectedFingerprint(parts, 'pass2-other-user'), false);
        });
    });
});


describe('2A.4 — undo records the SAME rule the background writer refuses', () => {
    it('a memory undo refuses the NEW content, not the restored bytes', async () => {
        const U = 'pass2-reject-shape-user';
        await withUser(U, async () => {
            const cm = await import('../src/services/learning/curatedMemory');
            const rf = await import('../src/services/learning/rejectedFingerprints');
            const ops: Array<{ action: 'add'; content: string; old_text?: string }> = [{ action: 'add', content: 'Never trade the London open.' }];
            const receipt = await cm.applyCuratedMemoryOps('user', ops, { username: U });
            assert.equal(receipt.ok, true);
            // Exactly the shape learningPassWiring.emit() fingerprints.
            const emissionContent = ops
                .flatMap(op => [String(op.content ?? ''), String(op.old_text ?? '')]).join(' | ');
            assert.equal(receipt.rejectedContent, emissionContent);
            const parts = { kind: 'memory', target: receipt.target, content: receipt.rejectedContent ?? '' };
            await rf.recordRejectedFingerprint(parts, 'user_undo', 'undo', U);
            assert.equal(await rf.isRejectedFingerprint({
                kind: 'memory', target: 'user', content: emissionContent,
            }, U), true, 'the re-proposal must be skipped');
            assert.equal(await rf.isRejectedFingerprint({
                kind: 'memory', target: 'user', content: receipt.undoSnapshot,
            }, U), false, 'the restored bytes are NOT the refused rule');
        });
    });
});

describe('2A.5 — turn-scoped update_plan', () => {
    it('accepts 1–12 concise, unique steps and defaults an omitted status to pending', async () => {
        const { normalizePlanSteps } = await import('../src/services/trade/turnPlan');
        const good = normalizePlanSteps({ steps: [
            { id: 'a', label: 'Read the tape' },
            { id: 'b', label: 'Check derivatives', status: 'in_progress' },
            { id: 'c', label: 'Present the plan', status: 'completed' },
        ] });
        assert.equal(good.ok, true);
        if (!good.ok) return;
        assert.deepEqual(good.steps.map(s => s.status), ['pending', 'in_progress', 'completed']);
        assert.equal(normalizePlanSteps({ steps: Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, label: 'x' })) }).ok, false);
        assert.equal(normalizePlanSteps({ steps: [] }).ok, false);
        assert.equal(normalizePlanSteps({ steps: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }).ok, false);
        assert.equal(normalizePlanSteps({ steps: [{ id: 'a', label: 'x'.repeat(81) }] }).ok, false);
        assert.equal(normalizePlanSteps({ steps: [{ id: 'a' }] }).ok, false);
        assert.equal(normalizePlanSteps({}).ok, false);
    });

    it('stores per session, notifies subscribers and clears on settle', async () => {
        const m = await import('../src/services/trade/turnPlan');
        const seen: Array<string | null> = [];
        const off = m.subscribeTurnPlan((sid, plan) => { if (sid === 'plan-probe') seen.push(plan ? 'set' : null); });
        try {
            m.clearTurnPlan('plan-probe');
            m.setTurnPlan('plan-probe', [{ id: 'a', label: 'One', status: 'in_progress' }]);
            assert.equal(m.getTurnPlan('plan-probe')?.steps[0].label, 'One');
            assert.equal(m.getTurnPlan('plan-other'), null);
            assert.deepEqual(seen, ['set']);
            m.clearTurnPlan('plan-probe');
            assert.equal(m.getTurnPlan('plan-probe'), null);
            assert.deepEqual(seen, ['set', null]);
        } finally {
            off();
            m.clearTurnPlan('plan-probe');
        }
    });
});
