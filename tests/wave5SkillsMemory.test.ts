/**
 * wave5SkillsMemory — offline unit tests for Wave 5.1 Part A & Part B:
 *   - Direct `/<skill-slug>` slash invocation parsing (`parseSlashSkillInvocation`)
 *   - Condition-scoped skill routing (`skillRoutingCore`: regimes/sessions/symbols/conditions, metadata.*, stale exclusion & zero preload)
 *   - Deterministic pre-turn memory recall (`memoryRecallCore`: scoring, maxItems, sensitive/deleted filtering, empty safety)
 *   - Unified Turn-1 memory write contract (`memory`, `memory_add`, `memory_update` present on Turn 1 with <= 24 tools)
 *   - Automatic `skillSlug` attribution (`skill_view` / `initialViewedSkills` -> `present_trade`, `emit_signal`, `paper_order`)
 *   - `/dream` autopsy-to-skill `stale` demotion + fail-closed `rejectedFingerprints` guard
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'wave5-skills-user']]);
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

import { parseSlashSkillInvocation } from '../src/utils/composerRefs';
import {
    parseSkillTriggers,
    routeSkillsForContext,
    type SkillRoutingCandidate,
} from '../src/services/learning/skillRoutingCore';
import {
    selectPreTurnMemories,
    type MemoryRecallProfileEntry,
} from '../src/services/learning/memoryRecallCore';
import {
    DESK_TOOL_DEFINITIONS,
    INITIAL_CHART_ACTION_NAMES,
    INITIAL_DESK_TOOL_NAMES,
    runDeskToolLoop,
    type DeskToolCall,
} from '../src/services/analysis/DeskToolsService';
import type { ProviderConfig } from '../src/types/provider';
import { initMemoryFiles } from '../src/services/learning/MemoryFilesService';
import {
    writeSkillFile,
    getSkill,
    deleteSkillFile,
} from '../src/services/learning/SkillFileService';
import {
    __seedSkillMetaForTests,
    getSkillMeta,
} from '../src/services/learning/skillManage';
import {
    runMemoryDream,
    undoMemoryDream,
    formatDreamResultSummary,
    buildDreamUndoPayload,
    applyDreamUndo,
    getLastDreamUndo,
} from '../src/services/learning/memoryDream';
import { setCuratedMemoryTexts, getCuratedMemoryText } from '../src/services/learning/curatedMemory';
import type { SignalRow } from '../src/types/signal';
import { readSignals, __clearSignalLedgerForTests } from '../src/services/signals/signalLedger';
import { getPaperAccount, __paperBrokerTestHooks } from '../src/services/paper/PaperBrokerService';

const BASE_MS = Date.parse('2026-10-12T08:30:00.000Z'); // London UTC bucket
const MIN_MS = 60_000;

const makeMockProvider = (): ProviderConfig => ({
    id: 'mock',
    name: 'Mock',
    apiKey: 'test',
    baseUrl: 'http://127.0.0.1:0',
    selectedModel: 'gpt-4o',
    models: ['gpt-4o'],
    isBuiltIn: false,
    isEnabled: true,
    apiFormat: 'chat_completions',
});

const makeSkillMd = (opts: {
    name: string;
    description: string;
    extraFrontmatter?: string;
    bodyLine?: string;
}): string => `---
name: ${opts.name}
description: ${opts.description}
${opts.extraFrontmatter ? `${opts.extraFrontmatter.trim()}\n` : ''}---
## When to use
Check live structure and derivatives first.

## Steps
1. ${opts.bodyLine ?? 'Confirm sweep + BOS and check risk.'}

## Pitfalls
- Never chase thin liquidity.
`;

const makeSignalRow = (idx: number, skillSlug: string, outcomeR: number): SignalRow => {
    const openMs = BASE_MS + idx * 120 * MIN_MS;
    const closeMs = openMs + 25 * MIN_MS;
    const status = outcomeR > 0 ? 'won' : 'lost';
    return {
        status,
        signal: {
            id: `w5-sig-${skillSlug}-${idx}`,
            coin: 'BTCUSDT',
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
            thesis: 'Autopsy leak test',
            marketRegime: 'range:compressed',
            skillSlug,
        },
        resolution: {
            status,
            at: closeMs,
            triggeredAt: openMs,
            exitAt: closeMs,
            grossR: outcomeR + 0.05,
            feeR: 0.05,
            outcomeR,
            mfeR: 0.1,
            maeR: -1.0,
            usedBarTimes: [],
            path: 'bar',
            ambiguous: false,
            crossCheck: 'unavailable',
            primarySource: 'okx',
        },
    };
};

describe('Wave 5.1 Part A & B — Skills Intelligence & Memory Compounding', () => {
    it('1. parseSlashSkillInvocation resolves /<skill-slug> prompts while preserving built-in commands', () => {
        const slugs = ['london-sweep-bos', 'spot-perp-crowding-fade'];
        const direct = parseSlashSkillInvocation('/london-sweep-bos analyze BTC 15m liquidity', slugs);
        assert.deepEqual(direct, { slug: 'london-sweep-bos', rest: 'analyze BTC 15m liquidity' });

        const bare = parseSlashSkillInvocation('  /spot-perp-crowding-fade  ', slugs);
        assert.deepEqual(bare, { slug: 'spot-perp-crowding-fade', rest: '' });

        // Built-ins must NOT be misclassified as skill invocations
        for (const cmd of ['/plan on', '/context', '/doctor', '/dream', '/handoff', '/brief', '/audit', '/scan']) {
            assert.equal(parseSlashSkillInvocation(cmd, slugs), null, `${cmd} must stay a built-in command`);
        }
        assert.equal(parseSlashSkillInvocation('/unknown-skill test', slugs), null);
        assert.equal(parseSlashSkillInvocation('hello world', slugs), null);
    });

    it('2. skillRoutingCore parses top-level & metadata triggers, routes matching tape cleanly, skips stale/archived, and never preloads bodies', () => {
        const londonContent = makeSkillMd({
            name: 'London Sweep BOS',
            description: 'Fade sweeps in London range.',
            extraFrontmatter: [
                'regimes: [range, chop]',
                'sessions: [London]',
                'symbols: [BTCUSDT]',
            ].join('\n'),
            bodyLine: 'SECRET_BODY_SHOULD_NEVER_PRELOAD_IN_ROUTING',
        });
        const fundingContent = makeSkillMd({
            name: 'Spot Perp Crowding Fade',
            description: 'Fade crowded funding.',
            extraFrontmatter: [
                'metadata:',
                '  conditions: extreme_funding',
                '  symbols:',
                '    - ETHUSDT',
            ].join('\n'),
            bodyLine: 'CROWDING_SECRET_LINE',
        });

        const parsedLondon = parseSkillTriggers(londonContent);
        assert.deepEqual(parsedLondon.regimes, ['range', 'chop']);
        assert.deepEqual(parsedLondon.sessions, ['London']);
        assert.deepEqual(parsedLondon.symbols, ['BTCUSDT']);

        const parsedFunding = parseSkillTriggers(fundingContent);
        assert.deepEqual(parsedFunding.conditions, ['extreme_funding']);
        assert.deepEqual(parsedFunding.symbols, ['ETHUSDT']);

        const candidates: SkillRoutingCandidate[] = [
            { slug: 'london-sweep-bos', content: londonContent, status: 'verified' },
            { slug: 'spot-perp-crowding-fade', content: fundingContent, status: 'probation' },
            { slug: 'archived-skill', content: londonContent, status: 'archived' },
            { slug: 'stale-skill', content: londonContent, status: 'stale' },
        ];

        const matched = routeSkillsForContext(candidates, {
            symbol: 'BTCUSDT',
            nowMs: BASE_MS, // London UTC
            regime: 'range:tight',
            fundingRate: 0.0001,
            maxItems: 2,
        });
        assert.equal(matched.matches.length, 1);
        assert.equal(matched.matches[0].slug, 'london-sweep-bos');
        assert.ok(matched.promptTailBlock.includes('skill_view("london-sweep-bos")'));
        // Critical invariant: ZERO skill bodies preloaded
        assert.equal(matched.promptTailBlock.includes('SECRET_BODY_SHOULD_NEVER_PRELOAD_IN_ROUTING'), false);
        assert.equal(matched.promptTailBlock.includes('CROWDING_SECRET_LINE'), false);

        // Non-matching tape produces complete silence
        const unmatched = routeSkillsForContext(candidates, {
            symbol: 'SOLUSDT',
            nowMs: Date.parse('2026-10-12T22:00:00.000Z'), // Late UTC
            regime: 'trend:strong',
            fundingRate: 0.00005,
        });
        assert.equal(unmatched.matches.length, 0);
        assert.equal(unmatched.promptTailBlock, '');
    });

    it('3. memoryRecallCore ranks symbol/session/regime matches, caps maxItems, skips sensitive/deleted, and is empty-safe', () => {
        const empty = selectPreTurnMemories({ symbol: 'BTCUSDT', session: 'London', regime: 'range' });
        assert.equal(empty.items.length, 0);
        assert.equal(empty.promptTailBlock, '');

        const memoryMd = [
            '## [2026-10-01]',
            '- BTCUSDT London session sweep fade requires clean CHoCH confirmation (autopsy rule).',
            '- SOLUSDT Late UTC chop — never chase breakout wicks.',
            '- General journal hygiene: log thesis before entry.',
            '## [2026-10-02]',
            '- BTCUSDT range extremes favor liquidity fades over breakout longs.',
        ].join('\n');

        const profileEntries: MemoryRecallProfileEntry[] = [
            {
                slug: 'btc-london-risk',
                title: 'BTC London sizing',
                description: 'Cap risk at 0.5R in London chop on BTCUSDT.',
                body: 'Reduce leverage when London range compresses on BTC.',
                updatedAt: '2026-10-10T08:00:00.000Z',
            },
            {
                slug: 'secret-api-note',
                title: 'Sensitive key',
                description: 'BTCUSDT exchange secret token',
                body: 'Never recall sensitive entries.',
                sensitive: true,
                updatedAt: '2026-10-11T08:00:00.000Z',
            },
            {
                slug: 'deleted-btc-note',
                title: 'Deleted',
                description: 'BTCUSDT London deleted note',
                body: 'Deleted entry',
                deletedAt: '2026-10-11T09:00:00.000Z',
            },
        ];

        const recalled = selectPreTurnMemories({
            symbol: 'BTCUSDT',
            session: 'London',
            regime: 'range:compressed',
            memoryMd,
            profileEntries,
            maxItems: 2,
        });

        assert.equal(recalled.items.length, 2);
        assert.ok(recalled.items.every(i => !i.text.includes('secret') && !i.text.includes('Deleted')));
        assert.ok(recalled.items[0].matchedTerms.some(t => t.startsWith('symbol:')));
        assert.ok(recalled.promptTailBlock.includes('[RECALLED MEMORY'));
        assert.ok(recalled.promptTailBlock.includes('BTC'));
    });

    it('4. Unified Turn-1 memory write contract exposes memory + memory_add + memory_update within <= 24 tools', () => {
        assert.equal(INITIAL_DESK_TOOL_NAMES.includes('memory'), true);
        assert.equal(INITIAL_DESK_TOOL_NAMES.includes('memory_add'), true);
        assert.equal(INITIAL_DESK_TOOL_NAMES.includes('memory_update'), true);

        const nonVisionInitialChart = [...INITIAL_CHART_ACTION_NAMES].filter(n => n !== 'inspect_chart_image');
        const turn1Count = INITIAL_DESK_TOOL_NAMES.length + nonVisionInitialChart.length;
        assert.ok(turn1Count <= 24, `Turn-1 tools must stay <= 24, got ${turn1Count}`);

        const schemaNames = DESK_TOOL_DEFINITIONS.map(s => s.function.name);
        assert.equal(schemaNames.includes('memory'), true);
        assert.equal(schemaNames.includes('memory_add'), true);
        assert.equal(schemaNames.includes('memory_update'), true);

        // Displaced chart drawing reset is deferred off Turn-1 chart actions
        assert.equal(INITIAL_CHART_ACTION_NAMES.has('clear_chart_drawings'), false);
    });

    it('5. runDeskToolLoop auto-attaches most recently viewed skillSlug to present_trade, emit_signal, and paper_order', async () => {
        const user = 'wave5-attr-user';
        const prevUser = localStorage.getItem('last_active_user');
        localStorage.setItem('last_active_user', user);
        await initMemoryFiles(user);
        __clearSignalLedgerForTests(user);
        await __paperBrokerTestHooks.clear(user);

        const w1 = await writeSkillFile({
            slug: 'london-sweep-bos',
            name: 'London Sweep BOS',
            description: 'Fade sweeps in London session ranges.',
            body: '## When to Use\nLondon sweep.\n## Steps\n1. Wait for sweep + BOS.\n## Pitfalls\n- No chase.',
        }, user);
        assert.equal(w1.ok, true, JSON.stringify(w1));
        const w2 = await writeSkillFile({
            slug: 'spot-perp-crowding-fade',
            name: 'Spot Perp Crowding Fade',
            description: 'Counter-trade overleveraged perpetual funding imbalances against spot absorption.',
            body: '## When to Use\nExtreme positive or negative funding spikes.\n## Steps\n1. Confirm spot CVD divergence before entry.\n## Pitfalls\n- Never stand in front of spot breakout flow.',
        }, user);
        assert.equal(w2.ok, true, JSON.stringify(w2));

        // Stub globalThis.fetch strictly inside try/finally so paper_order & emit_signal stay 100% offline
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/fapi/v1/exchangeInfo')) {
                return new Response(JSON.stringify({
                    symbols: [{ symbol: 'BTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' }],
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('/fapi/v1/premiumIndex')) {
                return new Response(JSON.stringify({
                    symbol: 'BTCUSDT', markPrice: '100', indexPrice: '100', lastFundingRate: '0.0001',
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.includes('/fapi/v1/depth')) {
                return new Response(JSON.stringify({
                    bids: [['99.9', '50'], ['99.5', '100']],
                    asks: [['100.1', '50'], ['100.5', '100']],
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({}), { status: 200 });
        }) as typeof fetch;

        try {
            const capturedPresentArgs: Array<Record<string, unknown>> = [];
            let round = 0;

            await runDeskToolLoop({
                config: makeMockProvider(),
                messages: [{ role: 'user', content: '/london-sweep-bos setup BTC' }],
                nativeTools: true,
                allowedTools: 'all',
                defaultSymbol: 'BTCUSDT',
                initialViewedSkills: [{ slug: 'london-sweep-bos', body: '## Steps\n1. Wait for sweep.', version: 'abc12345' }],
                executeExtraTool: async (call: DeskToolCall) => {
                    if (call.name === 'present_trade') {
                        capturedPresentArgs.push(call.arguments ?? {});
                        return { toolCallId: call.id, name: 'present_trade', ok: true, content: 'Presented' };
                    }
                    return null;
                },
                sendTurn: async () => {
                    round += 1;
                    if (round === 1) {
                        // Round 1: present_trade immediately after initialViewedSkills (/london-sweep-bos)
                        return {
                            text: '',
                            reasoning: '',
                            finishReason: 'tool_calls',
                            truncated: false,
                            toolCalls: [{
                                id: 'pt-1',
                                name: 'present_trade',
                                arguments: {
                                    symbol: 'BTCUSDT',
                                    direction: 'Long',
                                    entry: 100,
                                    stopLoss: 95,
                                    takeProfits: [110],
                                    rationale: 'Sweep reclaim',
                                },
                            }],
                        };
                    }
                    if (round === 2) {
                        // Round 2: view another skill so viewedSkillSlugs shifts to spot-perp-crowding-fade
                        return {
                            text: '',
                            reasoning: '',
                            finishReason: 'tool_calls',
                            truncated: false,
                            toolCalls: [{
                                id: 'sv-1',
                                name: 'skill_view',
                                arguments: { skill: 'spot-perp-crowding-fade' },
                            }],
                        };
                    }
                    if (round === 3) {
                        localStorage.setItem('last_active_user', user);
                        // Round 3: emit_signal + paper_order WITHOUT explicit skillSlug/skill_slug
                        return {
                            text: '',
                            reasoning: '',
                            finishReason: 'tool_calls',
                            truncated: false,
                            toolCalls: [
                                {
                                    id: 'es-1',
                                    name: 'emit_signal',
                                    arguments: {
                                        coin: 'BTCUSDT',
                                        direction: 'Long',
                                        entry: 100,
                                        stop: 95,
                                        target: 110,
                                        expiresInMinutes: 120,
                                        thesis: 'Crowded squeeze reclaim with positive delta',
                                        evidence: ['trade_math'],
                                    },
                                },
                                {
                                    id: 'po-1',
                                    name: 'paper_order',
                                    arguments: {
                                        action: 'open_limit',
                                        symbol: 'BTCUSDT',
                                        side: 'long',
                                        risk_pct: 0.5,
                                        leverage: 2,
                                        entry_price: 98,
                                        stop_loss: 95,
                                        take_profits: [110],
                                    },
                                },
                            ],
                        };
                    }
                    return { text: 'Done.', reasoning: '', finishReason: 'stop', truncated: false, toolCalls: [] };
                },
            });

            assert.equal(capturedPresentArgs.length, 1);
            assert.equal(capturedPresentArgs[0].skillSlug, 'london-sweep-bos');

            const emitted = readSignals(user);
            assert.equal(emitted.length, 1);
            assert.equal(emitted[0].signal.skillSlug, 'spot-perp-crowding-fade');

            const paperAcc = await getPaperAccount(user);
            assert.equal(paperAcc.pendingOrders.length, 1);
            assert.equal(paperAcc.pendingOrders[0].skillSlug, 'spot-perp-crowding-fade');
        } finally {
            globalThis.fetch = origFetch;
            await deleteSkillFile('london-sweep-bos', user);
            await deleteSkillFile('spot-perp-crowding-fade', user);
            if (prevUser === null) localStorage.removeItem('last_active_user');
            else localStorage.setItem('last_active_user', prevUser);
        }
    });

    it('6. /dream demotes leaky playbook to stale and respects rejectedFingerprints on undo', async () => {
        const user = 'wave5-dream-stale-user';
        const prevUser = localStorage.getItem('last_active_user');
        localStorage.setItem('last_active_user', user);
        await initMemoryFiles(user);

        await setCuratedMemoryTexts([
            { target: 'user', text: '## [2026-10-01]\nRisk 0.5% per setup.' },
            { target: 'memory', text: '## [2026-10-01]\nKeep journal clean.' },
        ], user);
        const createdSkill = await writeSkillFile({
            slug: 'leaky-breakout-chase',
            name: 'Leaky Breakout Chase',
            description: 'Chases high-timeframe range highs during low volatility.',
            body: '## When to Use\nHigh volume breakout.\n## Steps\n1. Buy breakout close.\n## Pitfalls\n- Thin liquidity reversals.',
        }, user);
        assert.equal(createdSkill.ok, true, JSON.stringify(createdSkill));
        assert.ok(getSkill('leaky-breakout-chase'));

        await __seedSkillMetaForTests({
            'leaky-breakout-chase': {
                createdBy: 'agent',
                status: 'verified',
                createdAt: new Date(BASE_MS - 10 * 86_400_000).toISOString(),
                updatedAt: new Date(BASE_MS - 1 * 86_400_000).toISOString(),
            },
        }, user);

        const losingSignals: SignalRow[] = [
            makeSignalRow(0, 'leaky-breakout-chase', -1.0),
            makeSignalRow(1, 'leaky-breakout-chase', -1.0),
            makeSignalRow(2, 'leaky-breakout-chase', -1.0),
            makeSignalRow(3, 'leaky-breakout-chase', -0.8),
            makeSignalRow(4, 'leaky-breakout-chase', 0.4),
        ];

        try {
            const firstDream = await runMemoryDream({
                manual: true,
                username: user,
                nowMs: BASE_MS + 60_000,
                gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows: losingSignals }),
            });
            assert.equal(firstDream.ran, true);
            assert.ok(firstDream.demotedSkills && firstDream.demotedSkills.length === 1, `Expected 1 demoted skill, notes=${JSON.stringify(firstDream.core?.notes)}`);
            assert.equal(firstDream.demotedSkills[0].slug, 'leaky-breakout-chase');
            assert.equal(firstDream.demotedSkills[0].priorStatus, 'verified');

            const afterDemote = await getSkillMeta('leaky-breakout-chase', user);
            assert.equal(afterDemote?.status, 'stale');
            const summary = formatDreamResultSummary(firstDream);
            assert.ok(summary.includes('leaky-breakout-chase'));

            // Undo must restore verified status AND record rejectedFingerprint
            const undone = await undoMemoryDream(firstDream.undoSnapshot!, user, {
                skillMetaUndoSnapshot: firstDream.skillMetaUndoSnapshot,
                demotedSlugs: firstDream.demotedSkills.map(d => d.slug),
            });
            assert.equal(undone, true);
            assert.equal((await getSkillMeta('leaky-breakout-chase', user))?.status, 'verified');

            // Re-running /dream with the same leak must NOT re-demote (fail-closed)
            const secondDream = await runMemoryDream({
                manual: true,
                username: user,
                nowMs: BASE_MS + 120_000,
                gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows: losingSignals }),
            });
            assert.equal(secondDream.ran, true);
            assert.equal(secondDream.demotedSkills?.length ?? 0, 0);
            assert.equal((await getSkillMeta('leaky-breakout-chase', user))?.status, 'verified');
            assert.ok(getSkill('leaky-breakout-chase'));
        } finally {
            await deleteSkillFile('leaky-breakout-chase', user);
            if (prevUser === null) localStorage.removeItem('last_active_user');
            else localStorage.setItem('last_active_user', prevUser);
        }
    });

    it('7. buildDreamUndoPayload + applyDreamUndo restores memory bytes, skill status, and clears cached receipt', async () => {
        const user = 'wave5-dream-ui-undo-user';
        const prevUser = localStorage.getItem('last_active_user');
        localStorage.setItem('last_active_user', user);
        await initMemoryFiles(user);

        const initialUserMd = '## [2026-10-01]\nRisk 0.5% per setup.';
        const initialMemoryMd = '## [2026-10-01]\nKeep journal clean.';
        await setCuratedMemoryTexts([
            { target: 'user', text: initialUserMd },
            { target: 'memory', text: initialMemoryMd },
        ], user);

        const createdSkill = await writeSkillFile({
            slug: 'leaky-ui-undo-playbook',
            name: 'Leaky UI Undo Playbook',
            description: 'Chases mid-range breakouts without sweep confirmation.',
            body: '## When to Use\nRange highs.\n## Steps\n1. Chase close.\n## Pitfalls\n- Stop hunts.',
        }, user);
        assert.equal(createdSkill.ok, true, JSON.stringify(createdSkill));

        await __seedSkillMetaForTests({
            'leaky-ui-undo-playbook': {
                createdBy: 'agent',
                status: 'verified',
                createdAt: new Date(BASE_MS - 10 * 86_400_000).toISOString(),
                updatedAt: new Date(BASE_MS - 1 * 86_400_000).toISOString(),
            },
        }, user);

        const losingSignals: SignalRow[] = [
            makeSignalRow(0, 'leaky-ui-undo-playbook', -1.0),
            makeSignalRow(1, 'leaky-ui-undo-playbook', -1.0),
            makeSignalRow(2, 'leaky-ui-undo-playbook', -0.9),
            makeSignalRow(3, 'leaky-ui-undo-playbook', -0.8),
            makeSignalRow(4, 'leaky-ui-undo-playbook', 0.2),
        ];

        try {
            const firstDream = await runMemoryDream({
                manual: true,
                username: user,
                nowMs: BASE_MS + 60_000,
                gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows: losingSignals }),
            });
            assert.equal(firstDream.ran, true);
            assert.equal((await getSkillMeta('leaky-ui-undo-playbook', user))?.status, 'stale');

            const receipt = buildDreamUndoPayload(firstDream);
            assert.ok(receipt);
            assert.deepEqual(receipt.demotedSlugs, ['leaky-ui-undo-playbook']);
            assert.ok(receipt.skillMetaUndoSnapshot?.['leaky-ui-undo-playbook']);
            assert.equal(getLastDreamUndo(user)?.beforeSnapshot.memoryMd, receipt.beforeSnapshot.memoryMd);

            // Simulate clicking Undo from ChatWorkTimeline / UtilityRail
            const undone = await applyDreamUndo(receipt, user);
            assert.equal(undone, true);
            assert.equal(getLastDreamUndo(user), null);
            assert.equal((await getSkillMeta('leaky-ui-undo-playbook', user))?.status, 'verified');

            assert.equal((await getCuratedMemoryText('user', user)).trim(), initialUserMd);
            assert.equal((await getCuratedMemoryText('memory', user)).trim(), initialMemoryMd);

            // Re-running /dream with the same leak must NOT re-demote (rejectedFingerprint was saved)
            const secondDream = await runMemoryDream({
                manual: true,
                username: user,
                nowMs: BASE_MS + 120_000,
                gather: () => ({ newSessions: 6, corrections: [], ledger: [], signalRows: losingSignals }),
            });
            assert.equal(secondDream.ran, true);
            assert.equal(secondDream.demotedSkills?.length ?? 0, 0);
            assert.equal((await getSkillMeta('leaky-ui-undo-playbook', user))?.status, 'verified');
        } finally {
            await deleteSkillFile('leaky-ui-undo-playbook', user);
            if (prevUser === null) localStorage.removeItem('last_active_user');
            else localStorage.setItem('last_active_user', prevUser);
        }
    });

    it('8. selectPreTurnMemories splits same-day multi-bullet MEMORY.md blocks independently without truncating later bullets', () => {
        const memoryMd = [
            '## [2026-10-12]',
            '- Avoid chasing ETHUSDT Sunday pump extremes when funding stays elevated above 30bps and orderbook depth is thin across Asian open; always wait for reclaim.',
            '- XRPUSDT range breakdowns fake out unless spot CVD confirms below previous day low with two consecutive 15m closes underneath.',
            '- SOLUSDT during London session: wait for sweep + 15m BOS before fading range highs; never bid the initial spike.',
        ].join('\n');

        const recalled = selectPreTurnMemories({
            symbol: 'SOLUSDT',
            session: 'London',
            regime: 'range',
            memoryMd,
            profileEntries: [],
            maxItems: 2,
        });

        assert.equal(recalled.items.length >= 1, true);
        assert.ok(recalled.items[0].text.includes('SOLUSDT'));
        assert.ok(recalled.items[0].text.includes('London'));
        assert.equal(recalled.items[0].text.includes('ETHUSDT'), false);
    });

    it('9. excluding already-invoked /<skill-slug> from routing candidates avoids duplicate skill_view prompt tail', () => {
        const londonContent = makeSkillMd({
            name: 'London Sweep BOS',
            description: 'Fade sweeps in London range.',
            extraFrontmatter: [
                'regimes: [range]',
                'sessions: [London]',
                'symbols: [BTCUSDT]',
            ].join('\n'),
        });
        const candidates: SkillRoutingCandidate[] = [
            { slug: 'london-sweep-bos', content: londonContent, status: 'verified' },
        ];
        const invokedSlug = 'london-sweep-bos';
        const filtered = candidates.filter(c => c.slug !== invokedSlug);
        const routed = routeSkillsForContext(filtered, {
            symbol: 'BTCUSDT',
            nowMs: BASE_MS, // London UTC
            regime: 'range:tight',
            maxItems: 2,
        });
        assert.equal(routed.matches.length, 0);
        assert.equal(routed.promptTailBlock, '');
    });
});
