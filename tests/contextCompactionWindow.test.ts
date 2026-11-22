/**
 * Context-window resolution + compaction-trigger contracts (2026-11-23).
 *
 * Pins the fix for the live-tested compaction thrash: with
 * `Kilocode · Ernie 5.5 Flash Preview Free` (a 1M-context gateway model whose
 * catalog reported a small window), the tool loop compacted the CURRENT
 * turn's freshly fetched tool results at ~14k estimated tokens — every round —
 * and the seat re-fetched what it had just been handed.
 *
 * Three guarantees, all offline (no network, no provider):
 *  1. The effective window is 1,000,000 for default / unknown / Kilocode /
 *     Ernie models; only a user override or a provider-ENFORCED (rejection-
 *     stated) limit shrinks it — a catalog-published window never does.
 *  2. Auto-compaction fires at 90% of the window (900,000 tokens on 1M) —
 *     never at 14k / 50k / 200k / 850k.
 *  3. The ACTIVE turn's tool outputs survive: older completed turns compact
 *     first; the live turn is trimmed only as an emergency last resort when
 *     the single turn itself crosses the ceiling.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/services/providers/GenericProviderService';
import type { ProviderConfig } from '../src/types/provider';
import {
    compactForWire,
    compactMessages,
    estimateMessagesTokens,
    activeTurnStartIndex,
} from '../src/services/providers/contextCompact';
import {
    resolveContextWindow,
    promptTokenCeiling,
    recordMeasuredContextWindow,
    resetMeasuredContextWindows,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    COMPACTION_TRIGGER_RATIO,
} from '../src/utils/contextWindow';
import { HARNESS_TURN_MARK } from '../src/utils/harnessMarks';

// ─── Builders ───────────────────────────────────────────────────────────────

/** Content whose estimate is ~`tokens` (lowercase letters = 4 chars/token, +4 framing). */
const filler = (tokens: number): string => 'a'.repeat(Math.max(0, (tokens - 4) * 4));

const KILOCODE_ERNIER = 'ernie-5.5-flash-preview-free';

const kilocode = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: 'kilocode',
    name: 'Kilocode',
    apiKey: 'key-not-real',
    baseUrl: 'https://gateway.example/v1',
    apiFormat: 'chat_completions',
    isEnabled: true,
    isBuiltIn: false,
    models: [KILOCODE_ERNIER],
    selectedModel: KILOCODE_ERNIER,
    ...over,
});

const TOOL_NAMES = [
    'get_market_packet', 'get_regime', 'get_chart_view', 'swing_structure',
    'order_flow', 'sr_zones', 'get_indicators',
] as const;

const toolCallMsg = (ids: string[], names: string[]): ChatMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id, i) => ({
        id,
        type: 'function' as const,
        function: { name: names[i] ?? 'get_regime', arguments: '{}' },
    })),
});

const toolResultMsg = (id: string, name: string, tokens: number): ChatMessage => ({
    role: 'tool',
    tool_call_id: id,
    name,
    content: `RESULT ${id} · ${filler(tokens)}`,
});

/** ONE active turn: the trader's question plus one round of the seven desk
 *  lookups (the exact multi-tool shape from the live thrash report). */
const multiToolTurn = (perResultTokens: number): ChatMessage[] => {
    const ids = TOOL_NAMES.map((_, i) => `call-${i}`);
    return [
        { role: 'system', content: 'You are the August desk seat. ' + filler(40) },
        { role: 'user', content: 'Audit BTC 1h structure & positioning. ' + filler(40) },
        toolCallMsg(ids, [...TOOL_NAMES]),
        ...TOOL_NAMES.map((name, i) => toolResultMsg(ids[i], name, perResultTokens)),
    ];
};

/** A completed older exchange (two filler messages of speech). */
const olderTurn = (tag: string, tokensEach: number): ChatMessage[] => [
    { role: 'user', content: `${tag} question ` + filler(tokensEach) },
    { role: 'assistant', content: `${tag} answer ` + filler(tokensEach) },
];

beforeEach(() => {
    resetMeasuredContextWindows();
});

// ─── 1. Window resolution ───────────────────────────────────────────────────

describe('context window resolution — the 1M default holds', () => {
    it('defaults every unstated model to 1,000,000', () => {
        assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000);
        for (const selectedModel of ['any-model', '', 'unknown-free-tier-model']) {
            const r = resolveContextWindow({ id: 'p', name: 'P', selectedModel });
            assert.equal(r.tokens, 1_000_000, selectedModel);
            assert.equal(r.source, 'default');
        }
    });

    it('a catalog-published window (Kilocode · Ernie) NEVER shrinks the 1M default', () => {
        const cfg = kilocode({ modelContextWindows: { [KILOCODE_ERNIER]: 16_384 } });
        const r = resolveContextWindow(cfg);
        assert.equal(r.tokens, 1_000_000);
        assert.equal(r.source, 'default');
    });

    it('a provider-ENFORCED limit (stated in a rejection) wins over the default', () => {
        recordMeasuredContextWindow('kilocode', KILOCODE_ERNIER, 131_072);
        const r = resolveContextWindow(kilocode());
        assert.equal(r.tokens, 131_072);
        assert.equal(r.source, 'measured');
    });

    it('the user override beats every other source', () => {
        recordMeasuredContextWindow('kilocode', KILOCODE_ERNIER, 131_072);
        const r = resolveContextWindow(kilocode({ contextWindowTokens: 262_144 }));
        assert.equal(r.tokens, 262_144);
        assert.equal(r.source, 'user');
    });
});

// ─── 2. The 90% trigger ─────────────────────────────────────────────────────

describe('compaction trigger — 90% of the effective window', () => {
    it('the ratio is 0.9 and the 1M ceiling is 900,000 tokens', () => {
        assert.equal(COMPACTION_TRIGGER_RATIO, 0.9);
        assert.equal(promptTokenCeiling(1_000_000, 8_192), 900_000);
        assert.equal(promptTokenCeiling(1_000_000, 4_096), 900_000);
        assert.equal(promptTokenCeiling(1_000_000, 0), 900_000);
    });

    it('a smaller ENFORCED window still keeps a 10% margin', () => {
        assert.equal(promptTokenCeiling(131_072, 8_192), Math.floor(131_072 * 0.9));
    });
});

// ─── 3. No compaction below the trigger ─────────────────────────────────────

describe('no mid-turn compaction below 90% of 1M', () => {
    for (const target of [14_000, 50_000, 200_000, 850_000]) {
        it(`a ~${Math.round(target / 1000)}k-token multi-tool turn is NOT compacted`, () => {
            const messages = multiToolTurn(Math.floor((target - 400) / TOOL_NAMES.length));
            const before = estimateMessagesTokens(messages);
            // The builder lands within a few percent of the target — and the
            // point holds as long as it is far below the 900k ceiling and far
            // above the old ~12k failure zone.
            assert.ok(before > target * 0.9 && before < target * 1.15, `built ~${before} tokens`);
            const result = compactForWire(kilocode(), messages);
            assert.equal(result.changed, false, `compacted at ${before} tokens — thrash regression`);
            assert.equal(result.stillOver, 0);
            assert.equal(result.ceilingTokens, 900_000);
            // Every tool result survives VERBATIM — nothing the seat just
            // fetched was shortened behind its back.
            for (const m of messages) {
                if (m.role !== 'tool') continue;
                const kept = result.messages.find(x => x.role === 'tool' && x.tool_call_id === m.tool_call_id);
                assert.ok(kept, `tool result ${m.tool_call_id} missing`);
                assert.equal(kept.content, m.content, `tool result ${m.tool_call_id} was rewritten`);
            }
        });
    }

    it('a conversation of many completed turns at ~820k is NOT compacted either', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are the August desk seat.' },
            ...Array.from({ length: 10 }, (_, i) => olderTurn(`t${i}`, 41_000)).flat(),
            { role: 'user', content: 'Review my recent Trade Log edge. ' + filler(40) },
        ];
        const before = estimateMessagesTokens(messages);
        assert.ok(before > 795_000 && before < 900_000, `built ~${before} tokens`);
        const result = compactForWire(kilocode(), messages);
        assert.equal(result.changed, false, `compacted at ${before} tokens`);
        assert.equal(result.stillOver, 0);
    });
});

// ─── 4. Crossing 90% compacts oldest-first, active turn intact ──────────────

describe('crossing 900k compacts cleanly — older turns first, active turn protected', () => {
    it('drops completed turns before touching the live tool results', () => {
        const active = multiToolTurn(3_000); // ~21k tokens of fresh results
        const messages: ChatMessage[] = [
            active[0], // system
            ...Array.from({ length: 10 }, (_, i) => olderTurn(`old${i}`, 44_000)).flat(), // ~880k
            active[1], // the active question (the LAST trader message)
            ...active.slice(2), // the live tool rounds
        ];
        const before = estimateMessagesTokens(messages);
        assert.ok(before > 900_000, `built ~${before} tokens, must cross the ceiling`);
        const result = compactForWire(kilocode(), messages);
        assert.equal(result.changed, true);
        assert.ok(result.afterTokens <= result.ceilingTokens,
            `after ${result.afterTokens} still over ceiling ${result.ceilingTokens}`);
        assert.equal(result.stillOver, 0);
        // The ACTIVE turn's seven fresh results are byte-identical.
        for (const m of active) {
            if (m.role !== 'tool') continue;
            const kept = result.messages.find(x => x.role === 'tool' && x.tool_call_id === m.tool_call_id);
            assert.ok(kept, `active tool result ${m.tool_call_id} missing`);
            assert.equal(kept.content, m.content, `active result ${m.tool_call_id} was trimmed — active-turn protection failed`);
        }
        // The trader's question survives verbatim.
        assert.ok(result.messages.some(m => m.role === 'user' && m.content === active[1].content),
            'the active question survives verbatim');
        // OLDEST-first: the oldest completed turn is the one that lost bytes
        // (its prose stubbed or its messages dropped), while a newer completed
        // turn survives whole.
        const old0Assistant = result.messages.find(m => m.role === 'assistant'
            && typeof m.content === 'string' && m.content.startsWith('old0 answer'));
        assert.ok(!old0Assistant || (typeof old0Assistant.content === 'string' && old0Assistant.content.length < 2_000),
            'the oldest completed turn gives up bytes first');
        assert.ok(result.messages.some(m => m.role === 'assistant'
            && typeof m.content === 'string' && m.content.startsWith('old9 answer')
            && m.content.length > 10_000),
            'a newer completed turn survives intact');
        // The calm notice, not the all-caps shout.
        assert.match(result.notice, /^Compacted /);
        assert.ok(!result.notice.includes('COMPACTED FOR THE CONTEXT WINDOW'));
    });
});

// ─── 5. Emergency: the single turn itself crosses the ceiling ───────────────

describe('emergency — a single turn over the ceiling trims its OWN oldest results', () => {
    it('stubs the oldest rounds first and keeps the newest results + question', () => {
        // Eight rounds, one lookup each — ~40k tokens in ONE turn.
        const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
        const original = new Map<string, string>();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are the August desk seat.' },
            { role: 'user', content: 'Full desk sweep, every angle. ' + filler(40) },
        ];
        for (let r = 0; r < 8; r++) {
            messages.push(toolCallMsg([ids[r]], [TOOL_NAMES[r % TOOL_NAMES.length]]));
            const result = toolResultMsg(ids[r], TOOL_NAMES[r % TOOL_NAMES.length], 5_000);
            original.set(ids[r], result.content as string);
            messages.push(result);
        }
        assert.ok(estimateMessagesTokens(messages) > 30_000);
        // A small ENFORCED window forces the emergency path: the turn alone
        // cannot fit (ceiling = min(90% of 40k, 40k − 4k out − 4k framing)
        // = 31,808 < ~40k), but the protected tail does fit.
        recordMeasuredContextWindow('kilocode', KILOCODE_ERNIER, 40_000);
        const result = compactForWire(kilocode(), messages);
        assert.equal(result.changed, true);
        assert.equal(result.stillOver, 0, `could not fit: ${result.afterTokens} vs ${result.ceilingTokens}`);
        // The question is never touched.
        const question = result.messages.find(m => m.role === 'user');
        assert.ok(question && String(question.content).includes('Full desk sweep'));
        // The NEWEST results survive verbatim; only the oldest were trimmed.
        for (const id of ['c5', 'c6', 'c7']) {
            const kept = result.messages.find(x => x.role === 'tool' && x.tool_call_id === id);
            assert.ok(kept, `newest result ${id} missing`);
            assert.equal(kept.content, original.get(id), `newest result ${id} was rewritten`);
        }
        // The oldest result did not survive verbatim (stubbed, not re-fetched).
        const oldest = result.messages.find(x => x.role === 'tool' && x.tool_call_id === 'c0');
        assert.ok(!oldest || oldest.content !== original.get('c0'),
            'the oldest result should be the first to give up bytes');
        // Direct API shape: the same input through compactMessages agrees.
        const direct = compactMessages({ messages, ceilingTokens: result.ceilingTokens });
        assert.equal(direct.stillOver, 0);
    });
});

// ─── 6. Active-turn boundary ────────────────────────────────────────────────

describe('activeTurnStartIndex', () => {
    it('starts at the newest TRADER message, skipping harness-authored user turns', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: `${HARNESS_TURN_MARK} Continue. Write your reply now.` },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function' as const, function: { name: 'get_regime', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c', name: 'get_regime', content: 'ok' },
        ];
        assert.equal(activeTurnStartIndex(messages), 1);
        // A NEW trader steering message mid-turn becomes the active start.
        messages.push({ role: 'user', content: 'actually focus on ETH' });
        assert.equal(activeTurnStartIndex(messages), 6);
    });

    it('returns 0 for an array with no trader turn (conservative)', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: `${HARNESS_TURN_MARK} results block` },
        ];
        assert.equal(activeTurnStartIndex(messages), 0);
    });
});
