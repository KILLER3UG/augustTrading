/**
 * wave1 — offline runtime coverage for the v1.6.4 Wave-1 changes:
 *
 *  1. chart-drawing persistence: `mark_trade_levels` shapes carry
 *     `persistAcrossTf` and stay visible on higher timeframes, while
 *     micro-drawings stay TF-scoped and are counted by the quiet pill helper;
 *  2. the zero/invalid-mark guard (no "Infinity%" receipts);
 *  3. the Chat surface's store-backed drawing executor writing into
 *     `drawingsControl('model', sid, symbol)`;
 *  4. the dead-tool grants (`scan_confluence`, `read_tool_output`);
 *  5. the deterministic `present_trade` math gate (computes, refuses
 *     inverted brackets, overrides model-stated figures);
 *  6. the `inspect_chart_image` offer predicate + registration;
 *  7. the hoisted `remember` Undo chip visible on the COLLAPSED row.
 *
 * ZERO network, ZERO model calls: every store is a localStorage shim and the
 * math inputs are stubbed. Tests share one process (--test-isolation=none),
 * so each block uses its own username/bucket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const backing = new Map<string, string>([['last_active_user', 'wave1-probe']]);
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
g.document = {
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, hidden: false,
    createElement: () => ({ getContext: () => null }),
};
backing.set('last_active_user', 'wave1-probe');

import { drawingsFromLevelTool, drawingFromChartTool } from '../src/services/trade/chartDrawings';
import { isDrawingVisibleOnTf, countHiddenLowerTf } from '../src/services/trade/chartGeometry';
import { drawingsControl } from '../src/services/trade/drawingsControl';
import {
    executeChatSurfaceChartTool,
    CHAT_SURFACE_TOOLS,
} from '../src/services/trade/chatSurfaceTurn';
import { drawToolLevelsFromCall } from '../src/services/trade/drawToolLevels';
import { runPresentTrade, computePresentTradeMath } from '../src/services/trade/presentTradeTool';
import { DESK_TOOL_NAMES } from '../src/utils/toolKinds';
import { loadableDeskToolNamesFor, DESK_TOOL_DEFINITIONS } from '../src/services/analysis/DeskToolsService';
import { CHART_ACTION_TOOL_DEFS, shouldOfferChartImageTool } from '../src/services/analysis/deskToolShared';
import ToolActionsRow from '../src/components/chat/ToolActionsRow';
import type { ToolAction } from '../src/types/message';

const LAST_BAR = Math.floor(Date.parse('2026-11-25T12:00:00.000Z') / 1000);

// ─── 1. trade levels persist across timeframes ──────────────────────────────
describe('wave1 · trade-level drawing persistence', () => {
    const { drawings: levels } = drawingsFromLevelTool(
        { entry: 100, stopLoss: 98, takeProfits: [106, 108] },
        { drawnPrice: 100.5, symbol: 'BTCUSDT', interval: '15m' },
    );

    it('mark_trade_levels tags every shape persistAcrossTf: true', () => {
        assert.equal(levels.length, 4); // Entry + SL + TP1 + TP2
        assert.deepEqual(
            levels.map(d => d.label),
            ['Entry', 'SL', 'TP1', 'TP2'],
        );
        for (const d of levels) assert.equal(d.persistAcrossTf, true, `${d.label} must persist`);
    });

    it('plan levels stay visible on 15m → 1h → 4h', () => {
        for (const tf of ['15m', '1h', '4h']) {
            for (const d of levels) {
                assert.equal(isDrawingVisibleOnTf(d, tf), true, `${d.label} visible on ${tf}`);
            }
        }
    });

    it('micro-drawings stay TF-scoped and are counted by the pill helper', () => {
        const { drawings: micro } = drawingFromChartTool(
            { kind: 'trend', prices: [99, 101], startBarsAgo: 10, endBarsAgo: 0 },
            { lastBarTime: LAST_BAR, barSeconds: 900, symbol: 'BTCUSDT', interval: '15m' },
        );
        assert.equal(micro.length, 1);
        assert.notEqual(micro[0].persistAcrossTf, true);
        assert.equal(isDrawingVisibleOnTf(micro[0], '15m'), true);
        assert.equal(isDrawingVisibleOnTf(micro[0], '1h'), false, 'a 15m trend hides on 1h');
        assert.equal(isDrawingVisibleOnTf(micro[0], '4h'), false);
        assert.equal(countHiddenLowerTf([...levels, ...micro], '1h'), 1, 'only the micro-drawing hides');
        assert.equal(countHiddenLowerTf([...levels, ...micro], '15m'), 0);
    });
});

// ─── 2. zero/invalid mark guard ──────────────────────────────────────────────
describe('wave1 · live-mark guard', () => {
    const drawHline = (drawnPrice: number | null | undefined) => drawingFromChartTool(
        { kind: 'hline', prices: [101.5] },
        { lastBarTime: LAST_BAR, barSeconds: 900, drawnPrice, symbol: 'BTCUSDT', interval: '15m' },
    );

    it('a zero mark never produces an Infinity% note', () => {
        const { note } = drawHline(0);
        assert.doesNotMatch(note ?? '', /Infinity/i);
        assert.match(note ?? '', /live mark unavailable/);
    });

    it('a missing mark says the note was skipped, never guesses', () => {
        for (const drawnPrice of [undefined, null, -5]) {
            const { note } = drawHline(drawnPrice as number | null | undefined);
            assert.doesNotMatch(note ?? '', /Infinity/i);
            assert.match(note ?? '', /live mark unavailable/);
        }
    });

    it('a real mark still produces the distance note', () => {
        const { note } = drawingFromChartTool(
            { kind: 'hline', prices: [101.5] },
            {
                lastBarTime: LAST_BAR, barSeconds: 900, drawnPrice: 90,
                klines: [{ high: 101, low: 99 }, { high: 102, low: 100 }, { high: 101.8, low: 100.2 }],
                symbol: 'BTCUSDT', interval: '15m',
            },
        );
        assert.match(note ?? '', /price is 90/);
        assert.doesNotMatch(note ?? '', /live mark unavailable/);
    });
});

// ─── 3. Chat-surface store-backed drawing executor ───────────────────────────
describe('wave1 · chat-surface store-backed drawing', () => {
    const SID = 's-wave1-chat';
    const ctx = { sessionId: SID, symbol: 'BTCUSDT', interval: '15m' };

    it('mark_trade_levels writes Entry/SL/TP into the model bucket', async () => {
        const result = await executeChatSurfaceChartTool(
            { id: 'c1', name: 'mark_trade_levels', arguments: { entry: 100, stopLoss: 98, takeProfits: [106] } },
            ctx,
        );
        assert.equal(result.ok, true, result.content);
        const stored = drawingsControl('model', SID, 'BTCUSDT').list();
        assert.deepEqual(stored.map(d => d.label), ['Entry', 'SL', 'TP1']);
        for (const d of stored) assert.equal(d.persistAcrossTf, true);
    });

    it('draw_on_chart appends a micro-drawing to the same bucket', async () => {
        const result = await executeChatSurfaceChartTool(
            { id: 'c2', name: 'draw_on_chart', arguments: { kind: 'hline', prices: [101.5], label: 'chat level' } },
            ctx,
        );
        assert.equal(result.ok, true, result.content);
        const stored = drawingsControl('model', SID, 'BTCUSDT').list();
        assert.equal(stored.some(d => d.label === 'chat level'), true);
    });

    it('clear_chart_drawings scope=model keeps the user bucket', async () => {
        drawingsControl('user', SID, 'BTCUSDT').add([{
            id: 'u-wave1', kind: 'hline', points: [{ t: LAST_BAR, p: 99 }], color: '#f4f4f5', createdAt: Date.now(),
        }]);
        const result = await executeChatSurfaceChartTool(
            { id: 'c3', name: 'clear_chart_drawings', arguments: {} },
            ctx,
        );
        assert.equal(result.ok, true, result.content);
        assert.equal(drawingsControl('model', SID, 'BTCUSDT').list().length, 0);
        assert.equal(drawingsControl('user', SID, 'BTCUSDT').list().some(d => d.id === 'u-wave1'), true, 'user shapes kept');
    });

    it('scope=all clears both buckets', async () => {
        await executeChatSurfaceChartTool(
            { id: 'c4', name: 'mark_trade_levels', arguments: { entry: 100, stopLoss: 98, takeProfits: [106] } },
            ctx,
        );
        const result = await executeChatSurfaceChartTool(
            { id: 'c5', name: 'clear_chart_drawings', arguments: { scope: 'all' } },
            ctx,
        );
        assert.equal(result.ok, true, result.content);
        assert.equal(drawingsControl('model', SID, 'BTCUSDT').list().length, 0);
        assert.equal(drawingsControl('user', SID, 'BTCUSDT').list().length, 0);
    });

    it('draw_tool_levels refuses an unknown tool with the catalogue names', async () => {
        const result = await executeChatSurfaceChartTool(
            { id: 'c6', name: 'draw_tool_levels', arguments: { tool: 'not_a_tool' } },
            ctx,
        );
        assert.equal(result.ok, false);
        assert.match(result.content, /"tool" must be one of/);
    });

    it('the shared draw core refuses an unknown tool identically', async () => {
        const { error } = await drawToolLevelsFromCall({ tool: 'nope' }, { symbol: 'BTCUSDT', interval: '15m' });
        assert.match(error ?? '', /"tool" must be one of/);
    });
});

// ─── 4. dead-tool grants ─────────────────────────────────────────────────────
describe('wave1 · tool grants', () => {
    it('scan_confluence is desk-granted and catalogue-loadable (not turn-1)', () => {
        assert.equal(DESK_TOOL_NAMES.includes('scan_confluence'), true);
        const loadable = loadableDeskToolNamesFor(true, DESK_TOOL_NAMES);
        assert.equal(loadable.includes('scan_confluence'), true, 'loadable via load_tools');
        assert.equal(DESK_TOOL_DEFINITIONS.some(d => d.function.name === 'scan_confluence'), true);
    });

    it('read_tool_output is desk-granted and offered from round 1', () => {
        assert.equal(DESK_TOOL_NAMES.includes('read_tool_output'), true);
        const loadable = loadableDeskToolNamesFor(true, DESK_TOOL_NAMES);
        assert.equal(loadable.includes('read_tool_output'), false, 'initial, not deferred');
    });

    it('the chat surface can load scan_confluence and draw into the store', () => {
        for (const name of ['scan_confluence', 'draw_on_chart', 'mark_trade_levels', 'draw_tool_levels', 'clear_chart_drawings']) {
            assert.equal(CHAT_SURFACE_TOOLS.includes(name), true, `${name} on Chat`);
        }
    });
});

// ─── 5. deterministic present_trade math gate ────────────────────────────────
describe('wave1 · present_trade deterministic math gate', () => {
    const mathDeps = {
        getAccount: async () => ({ equityUsd: 10_000, riskPercent: 1, leverage: 10 }),
        getFunding: async () => ({ rate: 0.0001, intervalHours: 8 }),
        getCandles: async () => [],
    };
    const baseArgs = {
        symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98,
        takeProfits: [106], confidence: 'High', rationale: 'R:R 10:1, risk $500 — the model invented these',
        invalidation: 'below 98',
    };
    const ctx = {
        call: { id: 'm1', name: 'present_trade', arguments: baseArgs },
        symbol: 'BTCUSDT', trades: [], drawnPrice: 100.5, crossCanvas: false,
        watchable: false, canvasNote: '',
    };

    it('computePresentTradeMath computes gross/net/size/liquidation from the inputs', async () => {
        const { snapshot } = await computePresentTradeMath(
            { symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 98, takeProfits: [106] },
            mathDeps,
        );
        assert.equal(snapshot.grossRatio, 3); // risk 2 → target 6
        assert.equal(snapshot.inverted, false);
        assert.equal(snapshot.riskUsd, 100); // 1% of 10k
        assert.equal(snapshot.qty, 50); // 100 risk / 2 stop distance
        assert.equal(snapshot.notionalUsd, 5_000);
        assert.equal(snapshot.leverageNeeded, 0.5);
        assert.equal(snapshot.liquidationPrice, 90); // 100 × (1 − 1/10)
        assert.equal(snapshot.fundingDragR, 0.005); // 1 × 0.0001 × (100/2)
        assert.equal(snapshot.fundingIntervalHours, 8);
    });

    it('runPresentTrade attaches the harness math and overrides the model’s numbers', async () => {
        const result = await runPresentTrade(ctx, { setProposal: () => {} }, mathDeps);
        assert.equal(result.ok, true, result.content.slice(0, 200));
        assert.match(result.content, /Harness math: gross 3:1/);
        assert.match(result.content, /risk \$100 → qty 50 @ 0\.5x \(notional \$5000\)/);
        assert.doesNotMatch(result.content, /gross 10:1/);
        assert.doesNotMatch(result.content, /risk \$500/);
    });

    it('runPresentTrade refuses an inverted bracket deterministically', async () => {
        const result = await runPresentTrade(
            {
                ...ctx,
                call: { id: 'm2', name: 'present_trade', arguments: { ...baseArgs, direction: 'Long', entry: 100, stopLoss: 102, takeProfits: [106] } },
            },
            { setProposal: () => {} },
            mathDeps,
        );
        assert.equal(result.ok, false);
        assert.match(result.content, /rejected/);
    });

    it('a Short plan with an inverted bracket is refused by the harness math', async () => {
        const result = await runPresentTrade(
            {
                ...ctx,
                call: { id: 'm3', name: 'present_trade', arguments: { ...baseArgs, direction: 'Short', entry: 100, stopLoss: 98, takeProfits: [106] } },
            },
            { setProposal: () => {} },
            mathDeps,
        );
        assert.equal(result.ok, false);
        assert.match(result.content, /rejected/);
    });
});

// ─── 6. inspect_chart_image offer predicate + registration ──────────────────
describe('wave1 · inspect_chart_image', () => {
    it('offered only for vision-capable models with a wired capture', () => {
        assert.equal(shouldOfferChartImageTool('gpt-4o', true), true);
        assert.equal(shouldOfferChartImageTool('claude-sonnet-4', true), true);
        assert.equal(shouldOfferChartImageTool('mock-mini', true), false, 'non-vision model');
        assert.equal(shouldOfferChartImageTool('gpt-4o', false), false, 'no canvas wired');
    });

    it('is registered as a read-only chart-action tool with no parameters', () => {
        const def = CHART_ACTION_TOOL_DEFS.find(d => d.function.name === 'inspect_chart_image');
        assert.ok(def, 'definition exists in CHART_ACTION_TOOL_DEFS');
        assert.equal(Object.keys(def.function.parameters.properties ?? {}).length, 0);
    });
});

// ─── 7. hoisted remember Undo chip ───────────────────────────────────────────
describe('wave1 · hoisted memory undo chip', () => {
    const actions: ToolAction[] = [{
        at: new Date().toISOString(), speaker: 'desk', tool: 'remember', ok: true,
        verb: 'saved', label: 'user/w1-undo-probe', review: 'Settings → Memory',
    }];

    it('renders the undo button on the collapsed summary row', () => {
        const markup = renderToStaticMarkup(React.createElement(ToolActionsRow, { actions }));
        const at = markup.indexOf('data-testid="memory-undo-w1-undo-probe"');
        assert.notEqual(at, -1, 'undo chip present');
        const summaryOpen = markup.indexOf('<summary');
        const summaryClose = markup.indexOf('</summary>');
        assert.ok(at > summaryOpen && at < summaryClose, 'chip sits INSIDE <summary> (collapsed row)');
        assert.doesNotMatch(markup, /<details[^>]*\bopen\b/, 'details stays collapsed');
    });
});
