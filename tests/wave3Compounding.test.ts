/**
 * wave3Compounding — offline tests for Wave 3 Step B1 & Step B3:
 *   - Execution Autopsy pure core (MFE giveback, immediate stop-out, revenge clusters, < 5 refusal)
 *   - `/dream` autopsy integration with fail-closed `rejectedFingerprints` & MEMORY.md cap enforcement
 *   - `weeklyReview` prompt injection & `backgroundReview` bounded autopsy emission
 *   - Silent legacy alias execution (`recall`, `skill_reader`) without Turn-1 schema offer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'wave3-probe']]);
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = storageShim;
if (!g.sessionStorage) g.sessionStorage = storageShim;
if (!g.window) {
    g.window = {
        localStorage: storageShim,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
        cancelAnimationFrame: (id: number) => clearTimeout(id),
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    };
}
if (!g.document) {
    g.document = {
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false,
        createElement: () => ({ getContext: () => null }),
    };
}

import {
    AUTOPSY_MIN_SAMPLE,
    buildExecutionAutopsy,
    formatAutopsyForPrompt,
} from '../src/services/learning/executionAutopsyCore';
import type { SignalRow } from '../src/types/signal';
import {
    consolidateMemoryCore,
    runMemoryDream,
} from '../src/services/learning/memoryDream';
import { buildWeeklyImpulsePrompt } from '../src/services/learning/weeklyReview';
import { runBackgroundReview } from '../src/services/learning/backgroundReview';
import { recordRejectedFingerprint } from '../src/services/learning/rejectedFingerprints';
import { MEMORY_MD_MAX_CHARS, getCachedCuratedMemorySnapshot, setCuratedMemoryTexts } from '../src/services/learning/curatedMemory';
import {
    executeDeskTool,
    INITIAL_DESK_TOOL_NAMES,
    loadableDeskToolNamesFor,
    SILENT_LEGACY_TOOL_ALIASES,
} from '../src/services/analysis/DeskToolsService';

const BASE_MS = Date.parse('2026-10-10T14:00:00.000Z'); // NewYork UTC bucket
const MIN_MS = 60_000;

const makeSignalRow = (
    idx: number,
    opts: {
        coin?: string;
        outcomeR: number;
        mfeR?: number;
        maeR?: number;
        status?: 'won' | 'lost' | 'expired';
        openOffsetMin?: number;
        closeOffsetMin?: number;
        regime?: string;
    },
): SignalRow => {
    const openMs = BASE_MS + (opts.openOffsetMin ?? idx * 120) * MIN_MS;
    const closeMs = BASE_MS + (opts.closeOffsetMin ?? (idx * 120 + 25)) * MIN_MS;
    const status = opts.status ?? (opts.outcomeR > 0 ? 'won' : 'lost');
    return {
        status,
        signal: {
            id: `sig-${idx}`,
            coin: opts.coin ?? 'BTCUSDT',
            direction: 'long',
            entry: 100,
            stop: 95,
            target: 110,
            emittedAt: openMs,
            expiresAt: openMs + 12 * 3600_000,
            evidenceRefs: ['trade_math'],
            dataHash: 'h1',
            provider: 'mock',
            model: 'gpt-4o',
            promptVersion: 'v1',
            source: 'signal',
            thesis: 'Test signal',
            marketRegime: opts.regime ?? 'range:compressed',
        },
        resolution: {
            status,
            at: closeMs,
            triggeredAt: openMs,
            exitAt: closeMs,
            grossR: opts.outcomeR + 0.05,
            feeR: 0.05,
            outcomeR: opts.outcomeR,
            mfeR: opts.mfeR,
            maeR: opts.maeR,
            usedBarTimes: [],
            path: 'bar',
            ambiguous: false,
            crossCheck: 'unavailable',
            primarySource: 'okx',
        },
    };
};

describe('Wave 3 Execution Autopsy & Compounding Loop', () => {
    it('1. executionAutopsyCore refuses < 5 samples cleanly with empty findings', () => {
        const thin = [
            makeSignalRow(1, { outcomeR: -1, mfeR: 0.1 }),
            makeSignalRow(2, { outcomeR: 0.1, mfeR: 2.0 }),
            makeSignalRow(3, { outcomeR: -1, mfeR: 0.15 }),
            makeSignalRow(4, { outcomeR: -1, mfeR: 0.05 }),
        ];
        const report = buildExecutionAutopsy({ signals: thin });
        assert.equal(report.sampleCount, 4);
        assert.equal(report.sufficientSample, false);
        assert.equal(report.findings.length, 0);
        assert.ok(report.refusalReason && report.refusalReason.includes(`N=4 < ${AUTOPSY_MIN_SAMPLE}`));
    });

    it('2. executionAutopsyCore flags MFE giveback, immediate stop-outs, revenge clusters, and session/regime leaks on N >= 5', () => {
        const rows: SignalRow[] = [
            // Row 0: lost at t=20m on BTCUSDT
            makeSignalRow(0, { coin: 'BTCUSDT', outcomeR: -1.0, mfeR: 0.1, maeR: -1.0, openOffsetMin: 0, closeOffsetMin: 20 }),
            // Row 1: revenge re-entry 5m later on BTCUSDT, immediate stop-out
            makeSignalRow(1, { coin: 'BTCUSDT', outcomeR: -1.0, mfeR: 0.15, maeR: -1.0, openOffsetMin: 25, closeOffsetMin: 35 }),
            // Row 2: revenge re-entry 10m later on BTCUSDT, reaches +2.1R MFE then gives back to -0.1R
            makeSignalRow(2, { coin: 'BTCUSDT', outcomeR: -0.1, mfeR: 2.1, maeR: -0.5, status: 'lost', openOffsetMin: 45, closeOffsetMin: 90 }),
            // Row 3: reaches +1.8R MFE then gives back to +0.1R expired
            makeSignalRow(3, { coin: 'ETHUSDT', outcomeR: 0.1, mfeR: 1.8, maeR: -0.2, status: 'expired', openOffsetMin: 180, closeOffsetMin: 240 }),
            // Row 4: immediate stop-out
            makeSignalRow(4, { coin: 'SOLUSDT', outcomeR: -1.0, mfeR: 0.05, maeR: -1.0, openOffsetMin: 300, closeOffsetMin: 315 }),
        ];
        const report = buildExecutionAutopsy({ signals: rows });
        assert.equal(report.sampleCount, 5);
        assert.equal(report.sufficientSample, true);
        assert.equal(report.mfeGiveback.flagged, true);
        assert.equal(report.mfeGiveback.count, 2);
        assert.equal(report.immediateStopOut.flagged, true);
        assert.equal(report.immediateStopOut.count, 3);
        assert.equal(report.behavioral.revengeClusters.length, 2);
        assert.ok(report.findings.some(f => f.includes('MFE giveback leak')));
        assert.ok(report.findings.some(f => f.includes('Immediate stop-out leak')));
        assert.ok(report.findings.some(f => f.includes('Revenge re-entry cluster')));
        assert.ok(report.bySession.some(b => b.key === 'NewYork' && b.flaggedLeak));
        assert.ok(report.byRegime.some(b => b.key === 'range:compressed' && b.flaggedLeak));
    });

    it('3. /dream, weeklyReview prompt, and backgroundReview integrate autopsy while respecting rejectedFingerprints & caps', async () => {
        const ls = g.localStorage as Storage;
        const prevUser = ls.getItem('last_active_user');
        ls.setItem('last_active_user', 'wave3-dream-user');

        const signalRows: SignalRow[] = [
            makeSignalRow(0, { coin: 'BTCUSDT', outcomeR: -1.0, mfeR: 0.1, openOffsetMin: 0, closeOffsetMin: 10 }),
            makeSignalRow(1, { coin: 'BTCUSDT', outcomeR: -1.0, mfeR: 0.1, openOffsetMin: 15, closeOffsetMin: 25 }),
            makeSignalRow(2, { coin: 'BTCUSDT', outcomeR: 0.05, mfeR: 1.9, status: 'expired', openOffsetMin: 35, closeOffsetMin: 65 }),
            makeSignalRow(3, { coin: 'ETHUSDT', outcomeR: 0.1, mfeR: 1.7, status: 'expired', openOffsetMin: 120, closeOffsetMin: 150 }),
            makeSignalRow(4, { coin: 'ETHUSDT', outcomeR: -1.0, mfeR: 0.1, openOffsetMin: 220, closeOffsetMin: 230 }),
        ];
        const autopsy = buildExecutionAutopsy({ signals: signalRows });
        const promptSummary = formatAutopsyForPrompt(autopsy);

        // weeklyReview includes autopsy findings
        const weeklyPrompt = buildWeeklyImpulsePrompt({
            closed: 5, wins: 2, losses: 3, netPnlUsd: -120, dollarRows: 5,
            avgR: -0.35, adherenceFollowedPct: 80, topMistake: null, givebackDays: 2,
        }, autopsy);
        assert.ok(weeklyPrompt.includes('MFE giveback leak'), 'weeklyReview cites verified autopsy leak');

        // backgroundReview emits autopsy finding through allowed `memory` tool
        const emitted: Array<{ tool: string; args: Record<string, unknown> }> = [];
        const br = await runBackgroundReview({
            toolCallCount: 4,
            userMessage: 'Check my execution leaks.',
            assistantMessage: 'Reviewed setup.',
            enabled: true,
            autopsy,
        }, {
            emit: async (em) => {
                emitted.push(em);
                return { ok: true };
            },
        });
        assert.equal(br.ran, true);
        assert.ok(emitted.some(e => e.tool === 'memory' && JSON.stringify(e.args).includes('MFE giveback leak')));

        // consolidateMemoryCore respects MEMORY.md char cap even with large autopsy + prior notes
        const longSeed = Array.from({ length: 12 }, (_, i) => `## [2026-09-${String(i + 1).padStart(2, '0')}]\n` + 'Archived execution note '.repeat(12)).join('\n\n');
        const capped = consolidateMemoryCore({
            userMd: '',
            memoryMd: longSeed,
            nowMs: BASE_MS,
            ledger: [],
            autopsy,
            extraMemoryEntry: promptSummary,
        });
        assert.ok(capped.memoryMd.length <= MEMORY_MD_MAX_CHARS, `MEMORY.md exceeded cap: ${capped.memoryMd.length}`);
        assert.ok(capped.notes.some(n => n.includes('MFE giveback leak')));

        // /dream writes autopsy when not rejected, then respects rejectedFingerprints when rejected
        await setCuratedMemoryTexts([
            { target: 'user', text: '## [2026-10-01]\nTrader risks 0.5%.' },
            { target: 'memory', text: '## [2026-10-01]\nInitial memory note.' },
        ], 'wave3-dream-user');

        const firstDream = await runMemoryDream({
            manual: true,
            username: 'wave3-dream-user',
            nowMs: BASE_MS + 10_000,
            gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows }),
        });
        assert.equal(firstDream.ran, true);
        assert.ok(firstDream.core?.memoryMd.includes('MFE giveback leak'), 'Dream wrote autopsy finding to MEMORY.md');

        // Record rejection fingerprint matching candidate autopsy & clear MEMORY.md; verify Dream withholds it
        await setCuratedMemoryTexts([{ target: 'memory', text: '## [2026-10-01]\nReset note.' }], 'wave3-dream-user');
        await recordRejectedFingerprint(
            { kind: 'memory', target: 'memory', content: promptSummary },
            'user_undo',
            'wave3-dream-user',
        );
        const secondDream = await runMemoryDream({
            manual: true,
            username: 'wave3-dream-user',
            nowMs: BASE_MS + 20_000,
            gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows }),
        });
        assert.equal(secondDream.ran, true);
        assert.equal(secondDream.core?.memoryMd.includes('MFE giveback leak'), false, 'Rejected autopsy must NOT re-enter MEMORY.md');
        assert.ok(secondDream.core?.notes.some(n => n.includes('rejectedFingerprints')));

        // Touch snapshot helper cleanly
        assert.ok(typeof getCachedCuratedMemorySnapshot('wave3-dream-user').memoryMd === 'string');

        if (prevUser === null) ls.removeItem('last_active_user');
        else ls.setItem('last_active_user', prevUser);
    });

    it('4. Consolidated legacy aliases stay hidden from Turn 1 & catalogue yet remain executable on direct dispatch', async () => {
        const loadable = loadableDeskToolNamesFor(true, 'all');
        for (const alias of SILENT_LEGACY_TOOL_ALIASES) {
            assert.equal(INITIAL_DESK_TOOL_NAMES.includes(alias), false, `${alias} must not be on Turn 1`);
            assert.equal(loadable.includes(alias), false, `${alias} must not clutter TOOL CATALOGUE`);
        }
        assert.ok(INITIAL_DESK_TOOL_NAMES.length <= 20, `Expected <= 20 core initial tools, got ${INITIAL_DESK_TOOL_NAMES.length}`);

        const recallRes = await executeDeskTool(
            { id: 'leg-recall', name: 'recall', arguments: { query: 'nonexistent-pattern-xyz' } },
            { allowedTools: 'all' },
        );
        assert.equal(recallRes.ok, true);

        const skillReaderRes = await executeDeskTool(
            { id: 'leg-sr', name: 'skill_reader', arguments: { skill: 'missing-skill-xyz' } },
            { allowedTools: 'all' },
        );
        // Should reach real skill lookup (not unknown_tool)
        assert.ok(!skillReaderRes.content.includes('unknown tool'), `Expected skill_reader dispatch, got: ${skillReaderRes.content}`);
    });
});
