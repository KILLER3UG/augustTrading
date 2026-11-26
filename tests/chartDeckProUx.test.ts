/**
 * chartDeckProUx — 100% offline unit test suite for Desk Chart Layout,
 * Pro Drawing UX & Interactive Position/Paper Handles:
 *   1. `chartDeckCore` (6 grouped rail categories, magnet Off/Weak/Strong + Ctrl flip,
 *      favorites normalization/toggle, Measure/Ruler delta math, editable hotkey guard)
 *   2. `positionHandleCore` (Smart Long/Short Position Box Net R:R / Risk $ / Qty / Liq %,
 *      deterministic paper SL/TP handle parsing & live rAF preview, AI plan line drag sync
 *      & inversion refusal, Audit prompt builder)
 *   3. `paperDrawingsFromAccount`, `placePaperOrder` `modify_sl_tp` & Plan Mode / `chatStore`
 *      proposal sync integration (100% offline, zero network).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>([['last_active_user', 'chart-deck-test-user']]);
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
    };
}

import {
    ALL_RAIL_TOOLS,
    CHART_RAIL_GROUPS,
    MAX_FAVORITE_TOOLS,
    computeMeasureMetrics,
    findCategoryForTool,
    isEditableKeyboardTarget,
    normalizeFavoriteTools,
    resolveEffectiveMagnetMode,
    resolveMagnetThresholdPx,
    toggleFavoriteTool,
} from '../src/services/trade/chartDeckCore';
import {
    applyAiLevelDragToProposal,
    buildPositionBoxAuditPrompt,
    classifyAiPlanLevelLabel,
    computePaperHandlePreview,
    computePositionBoxReadout,
    paperEntryDrawingId,
    paperLimitDrawingId,
    paperSlDrawingId,
    paperTpDrawingId,
    parsePaperHandleId,
} from '../src/services/trade/positionHandleCore';
import { paperDrawingsFromAccount } from '../src/components/trade/drawingsPrimitive';
import { createPaperAccount, placePaperOrder } from '../src/services/paper/paperCore';
import type { TradeProposal } from '../src/services/trade/proposedTrade';
import * as chatStore from '../src/services/trade/chatStore';
import { pointsForKind } from '../src/services/trade/chartDrawings';

describe('chartDeckCore — Grouped Rail, Magnet, Favorites & Measure/Ruler', () => {
    it('exposes all 6 grouped rail categories with Freehand default in annotations', () => {
        assert.equal(CHART_RAIL_GROUPS.length, 6);
        const categories = CHART_RAIL_GROUPS.map(g => g.category);
        assert.deepEqual(categories, ['cursor', 'lines', 'fib', 'zones', 'position', 'annotations']);
        const annotations = CHART_RAIL_GROUPS.find(g => g.category === 'annotations')!;
        assert.equal(annotations.defaultTool, 'brush');
        const brushDef = annotations.tools.find(t => t.tool === 'brush')!;
        assert.equal(brushDef.title, 'Freehand — drag to draw');
        assert.equal(findCategoryForTool('hray'), 'lines');
        assert.equal(findCategoryForTool('vline'), 'lines');
        assert.equal(findCategoryForTool('price_range'), 'zones');
        assert.ok(ALL_RAIL_TOOLS.some(t => t.tool === 'trend' && t.hotkey === 'Alt+T'));
        assert.ok(ALL_RAIL_TOOLS.some(t => t.tool === 'rect' && t.hotkey === 'Shift+Alt+R'));
    });

    it('resolves Off/Weak/Strong magnet thresholds and Ctrl inversion', () => {
        assert.equal(resolveEffectiveMagnetMode('off', false), 'off');
        assert.equal(resolveEffectiveMagnetMode('off', true), 'weak');
        assert.equal(resolveEffectiveMagnetMode('weak', false), 'weak');
        assert.equal(resolveEffectiveMagnetMode('weak', true), 'off');
        assert.equal(resolveEffectiveMagnetMode('strong', false), 'strong');
        assert.equal(resolveEffectiveMagnetMode('strong', true), 'off');
        assert.equal(resolveMagnetThresholdPx('off'), 0);
        assert.equal(resolveMagnetThresholdPx('weak'), 12);
        assert.equal(resolveMagnetThresholdPx('strong'), 36);
    });

    it('normalizes, deduplicates, toggles, and caps starred favorite tools', () => {
        const cleaned = normalizeFavoriteTools(['trend', 'cursor', 'erase', 'trend', 'hline', 'invalid_xyz', 42]);
        assert.deepEqual(cleaned, ['trend', 'hline']);

        const added = toggleFavoriteTool(cleaned, 'fib');
        assert.deepEqual(added, ['trend', 'hline', 'fib']);

        const removed = toggleFavoriteTool(added, 'trend');
        assert.deepEqual(removed, ['hline', 'fib']);

        // Non-starrable tools cannot be added
        const unchanged = toggleFavoriteTool(removed, 'cursor');
        assert.deepEqual(unchanged, ['hline', 'fib']);

        // Cap enforced
        const many = normalizeFavoriteTools([
            'trend', 'hline', 'hray', 'vline', 'channel', 'fib', 'ray',
            'rect', 'price_range', 'long_position', 'short_position', 'brush', 'text',
        ]);
        assert.equal(many.length, MAX_FAVORITE_TOOLS);
    });

    it('computes exact Measure/Ruler delta %, $, bar count, and duration', () => {
        const up = computeMeasureMetrics({
            startPrice: 100_000,
            endPrice: 102_500,
            startTimeSec: 1_700_000_000,
            endTimeSec: 1_700_000_000 + 14 * 900, // 14 x 15m bars = 3h 30m
            barSeconds: 900,
        });
        assert.ok(up);
        assert.equal(up.direction, 'up');
        assert.equal(up.priceDelta, 2500);
        assert.ok(Math.abs(up.priceDeltaPct - 2.5) < 1e-9);
        assert.equal(up.absBars, 14);
        assert.equal(up.durationLabel, '3h 30m');
        assert.ok(up.formattedSummary.includes('+2.50%'));
        assert.ok(up.formattedSummary.includes('14 bars'));
        assert.ok(up.formattedSummary.includes('3h 30m'));

        const down = computeMeasureMetrics({
            startPrice: 100,
            endPrice: 95,
            startTimeSec: 1_700_010_000,
            endTimeSec: 1_700_006_400, // backwards drag = 3600s = 4 x 15m bars
            barSeconds: 900,
        });
        assert.ok(down);
        assert.equal(down.direction, 'down');
        assert.equal(down.absBars, 4);
        assert.equal(down.durationLabel, '1h');
        assert.ok(down.formattedSummary.includes('-5.00%'));

        assert.equal(computeMeasureMetrics({
            startPrice: 0,
            endPrice: 100,
            startTimeSec: 1000,
            endTimeSec: 2000,
            barSeconds: 60,
        }), null);
    });

    it('guards keyboard shortcuts against editable targets and validates new DrawKinds', () => {
        assert.equal(isEditableKeyboardTarget('INPUT', false), true);
        assert.equal(isEditableKeyboardTarget('textarea', false), true);
        assert.equal(isEditableKeyboardTarget('SELECT', false), true);
        assert.equal(isEditableKeyboardTarget('DIV', true), true);
        assert.equal(isEditableKeyboardTarget('DIV', false), false);
        assert.equal(isEditableKeyboardTarget('CANVAS', false), false);

        assert.equal(pointsForKind('hray', [{ t: 100, p: 50 }])?.length, 1);
        assert.equal(pointsForKind('vline', [{ t: 100, p: 50 }])?.length, 1);
        assert.equal(pointsForKind('price_range', [{ t: 100, p: 50 }, { t: 200, p: 55 }])?.length, 2);
        assert.equal(pointsForKind('price_range', [{ t: 100, p: 50 }]), null);
    });
});

describe('positionHandleCore — Position Box Readout, Paper Handles & AI Plan Sync', () => {
    it('computes Net R:R, Risk $, Qty, and Liq % on Long & Short position boxes', () => {
        const longPts = [
            { t: 1000, p: 100_000 }, // Entry
            { t: 2000, p: 98_000 },  // SL (2% risk = $2,000/BTC)
            { t: 2000, p: 106_000 }, // TP (6% reward -> Gross 3.0R)
        ];
        const longReadout = computePositionBoxReadout('long_position', longPts, {
            equityUsd: 10_000,
            riskPercent: 1,
            leverage: 10,
            takerFeeBps: 5,
        });
        assert.ok(longReadout);
        assert.equal(longReadout.inverted, false);
        assert.equal(longReadout.direction, 'Long');
        assert.ok(Math.abs(longReadout.grossRR - 3.0) < 1e-6);
        // Round trip taker fee = 10 bps = 0.10% against 2% stop = 0.05R cost -> Net 2.95R
        assert.ok(Math.abs(longReadout.costR - 0.05) < 1e-4);
        assert.ok(Math.abs(longReadout.netRR - 2.95) < 1e-4);
        assert.equal(longReadout.riskUsd, 100);
        assert.ok(Math.abs((longReadout.qty ?? 0) - 0.05) < 1e-6);
        assert.ok((longReadout.liqBufferPct ?? 0) > 8 && (longReadout.liqBufferPct ?? 0) < 11);
        assert.ok(longReadout.canvasBadge.includes('Net 2.95R'));
        assert.ok(longReadout.canvasBadge.includes('Risk $100'));
        assert.ok(longReadout.canvasBadge.includes('Liq'));

        const auditPrompt = buildPositionBoxAuditPrompt('BTCUSDT', longReadout, '#D3');
        assert.ok(auditPrompt.includes('#D3'));
        assert.ok(auditPrompt.includes('BTCUSDT'));
        assert.ok(auditPrompt.includes('Net 2.95R'));

        // Inverted Long (SL above Entry)
        const inverted = computePositionBoxReadout('long_position', [
            { t: 1000, p: 100_000 },
            { t: 2000, p: 101_000 },
            { t: 2000, p: 105_000 },
        ]);
        assert.ok(inverted);
        assert.equal(inverted.inverted, true);
        assert.ok(inverted.canvasBadge.includes('INVERTED'));
    });

    it('parses deterministic paper SL/TP handle IDs and computes live drag preview', () => {
        assert.deepEqual(parsePaperHandleId(paperSlDrawingId('pos-42')), { positionId: 'pos-42', kind: 'sl' });
        assert.deepEqual(parsePaperHandleId(paperTpDrawingId('pos-42', 0)), { positionId: 'pos-42', kind: 'tp', tpIndex: 0 });
        assert.deepEqual(parsePaperHandleId(paperTpDrawingId('pos-42', 1)), { positionId: 'pos-42', kind: 'tp', tpIndex: 1 });
        assert.equal(parsePaperHandleId(paperEntryDrawingId('pos-42')), null);
        assert.equal(parsePaperHandleId(paperLimitDrawingId('ord-9')), null);
        assert.equal(parsePaperHandleId('d-123456-abc'), null);

        const pos = {
            side: 'long' as const,
            entryPrice: 100_000,
            stopLoss: 98_000,
            takeProfits: [104_000],
            qty: 0.05,
            riskUsd: 100,
        };

        // Drag TP1 from 104,000 up to 106,000 -> +$300.00 / +3.00R
        const tpUp = computePaperHandlePreview({
            position: pos,
            target: { positionId: 'pos-42', kind: 'tp', tpIndex: 0 },
            candidatePrice: 106_000,
        });
        assert.equal(tpUp.valid, true);
        assert.ok(Math.abs(tpUp.pnlUsd - 300) < 1e-6);
        assert.ok(Math.abs(tpUp.rMultiple - 3.0) < 1e-6);
        assert.ok(tpUp.pillText.includes('+3.00R'));
        assert.ok(tpUp.pillText.includes('+$300.00'));

        // Drag SL across entry -> invalid
        const badSl = computePaperHandlePreview({
            position: pos,
            target: { positionId: 'pos-42', kind: 'sl' },
            candidatePrice: 100_500,
        });
        assert.equal(badSl.valid, false);
        assert.equal(badSl.reason, 'sl_crosses_entry');
    });

    it('syncs dragged AI plan horizontal lines onto TradeProposal and rejects inversions', () => {
        assert.equal(classifyAiPlanLevelLabel('Entry'), 'entry');
        assert.equal(classifyAiPlanLevelLabel('AI · SL'), 'sl');
        assert.equal(classifyAiPlanLevelLabel('TP1'), 'tp1');
        assert.equal(classifyAiPlanLevelLabel('TP 2'), 'tp2');
        assert.equal(classifyAiPlanLevelLabel('Support zone'), null);

        const proposal: TradeProposal = {
            symbol: 'BTCUSDT',
            direction: 'Long',
            entry: 100_000,
            stopLoss: 98_000,
            takeProfits: [104_000, 108_000],
            planId: 'plan-1',
        };

        const resized = applyAiLevelDragToProposal(proposal, 'tp1', 106_000, {
            equityUsd: 10_000,
            riskPercent: 1,
            leverage: 10,
            takerFeeBps: 5,
        });
        assert.equal(resized.ok, true);
        assert.equal(resized.proposal?.takeProfits[0], 106_000);
        assert.equal(resized.proposal?.takeProfits[1], 108_000);
        assert.ok(Math.abs((resized.proposal?.math?.grossRatio ?? 0) - 3.0) < 1e-6);
        assert.ok(Math.abs((resized.proposal?.math?.netRewardR ?? 0) - 2.95) < 1e-4);
        assert.equal(resized.proposal?.math?.riskUsd, 100);

        // Inverting SL above entry must fail cleanly without mutating original
        const invalid = applyAiLevelDragToProposal(proposal, 'sl', 101_000);
        assert.equal(invalid.ok, false);
        assert.equal(proposal.stopLoss, 98_000);
    });
});

describe('Paper overlay IDs, modify_sl_tp, Plan Mode & chatStore proposal sync', () => {
    it('emits deterministic draggable SL/TP IDs and commits valid modify_sl_tp cleanly', () => {
        const base = createPaperAccount({
            enabled: true,
            startingBalanceUsd: 10_000,
            maxRiskPerTradePct: 2,
            maxLeverage: 20,
            maxConcurrentPositions: 5,
        });
        const opened = placePaperOrder({
            account: base,
            input: {
                action: 'open_market',
                symbol: 'BTCUSDT',
                side: 'long',
                entry_price: 100_000,
                risk_pct: 1,
                leverage: 10,
                stop_loss: 98_000,
                take_profits: [104_000],
            },
            quote: { last: 100_000, bestBid: 99_999, bestAsk: 100_001 },
            nowMs: 1_700_000_000_000,
        });
        assert.equal(opened.ok, true, opened.reason);
        const pos = opened.account!.positions[0];
        assert.ok(pos);

        const overlay = paperDrawingsFromAccount(opened.account!, 'BTCUSDT', 1_700_000_000_000);
        assert.ok(overlay.some(d => d.id === paperEntryDrawingId(pos.id)));
        assert.ok(overlay.some(d => d.id === paperSlDrawingId(pos.id) && d.points[0].p === 98_000));
        assert.ok(overlay.some(d => d.id === paperTpDrawingId(pos.id, 0) && d.points[0].p === 104_000));

        // Valid SL modification
        const mod = placePaperOrder({
            account: opened.account!,
            input: {
                action: 'modify_sl_tp',
                symbol: 'BTCUSDT',
                position_id: pos.id,
                stop_loss: 98_500,
            },
            quote: { last: 100_000, bestBid: 99_999, bestAsk: 100_001 },
            nowMs: 1_700_000_060_000,
        });
        assert.equal(mod.ok, true);
        assert.equal(mod.account!.positions[0].stopLoss, 98_500);

        // Inverted SL modification refuses without mutating account
        const badMod = placePaperOrder({
            account: mod.account!,
            input: {
                action: 'modify_sl_tp',
                symbol: 'BTCUSDT',
                position_id: pos.id,
                stop_loss: 101_000,
            },
            quote: { last: 100_000, bestBid: 99_999, bestAsk: 100_001 },
            nowMs: 1_700_000_120_000,
        });
        assert.equal(badMod.ok, false);
        assert.equal(mod.account!.positions[0].stopLoss, 98_500);
    });

    it('updates latest symbol proposal via chatStore and respects Plan Mode flag', () => {
        const initialProposal: TradeProposal = {
            symbol: 'BTCUSDT',
            direction: 'Long',
            entry: 100_000,
            stopLoss: 98_000,
            takeProfits: [104_000],
            planId: 'plan-sync-1',
        };
        const sid = chatStore.addSession({
            kind: 'solo',
            symbol: 'BTCUSDT',
            interval: '15m',
            entries: [{
                id: 'ai-prop-1',
                role: 'ai',
                text: 'Proposed BTC Long setup.',
                tools: [],
                proposal: initialProposal,
            }],
        }, true);
        chatStore.setPlanMode(true, sid);
        assert.equal(chatStore.getPlanMode(sid), true);
        chatStore.setPlanMode(false, sid);
        assert.equal(chatStore.getPlanMode(sid), false);

        const updated = chatStore.updateLatestSymbolProposal(sid, 'BTCUSDT', p => {
            const r = applyAiLevelDragToProposal(p, 'sl', 98_400, { equityUsd: 10_000, riskPercent: 1, leverage: 10 });
            return r.ok ? (r.proposal ?? null) : null;
        });
        assert.equal(updated, true);

        const session = chatStore.getSnapshot().sessions.find(s => s.id === sid)!;
        const entry = session.entries.find(e => e.id === 'ai-prop-1')!;
        assert.equal(entry.proposal?.stopLoss, 98_400);
        assert.ok((entry.proposal?.math?.grossRatio ?? 0) > 2.4);
    });
});
