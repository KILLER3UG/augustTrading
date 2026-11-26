/**
 * wave5PaperAutopsy — offline unit tests for Wave 5.1 Part C:
 *   - `TradeProposalCard` Playbook chip (`proposal-playbook-chip`)
 *   - `TradeProposalCard` `Paper execute` Plan Mode lock & Paper Mode disable (`proposal-paper-execute`)
 *   - `buildPaperOrderFromProposal` + `submitPaperOrder` / `placePaperOrder` risk walls + `skillSlug` preservation
 *   - `LearningDashboard` 0-trade empty state preserved & `Execution Autopsy` card (`learning-execution-autopsy`) rendered for N >= 5 combined signals + paper trades
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const backing = new Map<string, string>([['last_active_user', 'wave5-paper-user']]);
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

import TradeProposalCard, { buildPaperOrderFromProposal } from '../src/components/trade/panels/TradeProposalCard';
import { LearningDashboard } from '../src/components/dashboards/LearningDashboard';
import {
    createPaperAccount,
    placePaperOrder,
    type PaperSettledTrade,
} from '../src/services/paper/paperCore';
import { submitPaperOrder, getPaperAccount, __paperBrokerTestHooks } from '../src/services/paper/PaperBrokerService';
import type { TradeProposal } from '../src/services/trade/proposedTrade';
import type { SignalRow } from '../src/types/signal';
import { autopsyRowsFromLoggedTrades, buildExecutionAutopsy } from '../src/services/learning/executionAutopsyCore';

const BASE_MS = Date.parse('2026-10-14T14:00:00.000Z');
const MIN_MS = 60_000;

const sampleProposal = (overrides: Partial<TradeProposal> = {}): TradeProposal => ({
    symbol: 'BTCUSDT',
    direction: 'Long',
    entry: 60000,
    stopLoss: 58800,
    takeProfits: [62400],
    confidence: 'Medium',
    rationale: 'Clean sweep reclaim with positive delta divergence.',
    skillSlug: 'london-sweep-bos',
    ...overrides,
});

const makeSettledSignal = (idx: number, opts: { outcomeR: number; mfeR: number; coin?: string; openMin: number; closeMin: number }): SignalRow => {
    const openMs = BASE_MS + opts.openMin * MIN_MS;
    const closeMs = BASE_MS + opts.closeMin * MIN_MS;
    const status = opts.outcomeR > 0 ? 'won' : 'lost';
    return {
        status,
        signal: {
            id: `w5-autopsy-sig-${idx}`,
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
            thesis: 'Sweep setup',
            marketRegime: 'range:compressed',
            skillSlug: 'london-sweep-bos',
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
            maeR: -0.9,
            usedBarTimes: [],
            path: 'bar',
            ambiguous: false,
            crossCheck: 'unavailable',
            primarySource: 'okx',
        },
    };
};

describe('Wave 5.1 Part C — Paper Execution & Visible Execution Autopsy', () => {
    it('1. TradeProposalCard renders Playbook chip + Paper execute button (blocked in Plan Mode & Paper-Off, active when unlocked)', () => {
        const proposal = sampleProposal();

        const planLockedHtml = renderToStaticMarkup(
            React.createElement(TradeProposalCard, {
                proposal,
                canLog: true,
                planMode: true,
                paperEnabled: true,
                onUnlockPlanMode: () => {},
                onApprove: () => {},
                onReject: () => {},
                onAskWhy: () => {},
            }),
        );
        assert.ok(planLockedHtml.includes('data-testid="proposal-playbook-chip"'));
        assert.match(planLockedHtml, /Playbook:(?:<!--\s*-->|\s)*London Sweep BOS/);
        assert.ok(planLockedHtml.includes('data-testid="proposal-paper-execute"'));
        assert.match(planLockedHtml, /<button[^>]*disabled=""[^>]*data-testid="proposal-paper-execute"/);

        const paperDisabledHtml = renderToStaticMarkup(
            React.createElement(TradeProposalCard, {
                proposal,
                canLog: true,
                planMode: false,
                paperEnabled: false,
                onApprove: () => {},
                onReject: () => {},
                onAskWhy: () => {},
            }),
        );
        assert.match(paperDisabledHtml, /<button[^>]*disabled=""[^>]*data-testid="proposal-paper-execute"/);

        const unlockedHtml = renderToStaticMarkup(
            React.createElement(TradeProposalCard, {
                proposal,
                canLog: true,
                planMode: false,
                paperEnabled: true,
                onApprove: () => {},
                onReject: () => {},
                onAskWhy: () => {},
            }),
        );
        assert.ok(unlockedHtml.includes('data-testid="proposal-paper-execute"'));
        assert.doesNotMatch(unlockedHtml, /<button[^>]*disabled=""[^>]*data-testid="proposal-paper-execute"/);
    });

    it('2. buildPaperOrderFromProposal enforces paperCore risk walls and preserves skillSlug through open & close', async () => {
        const proposal = sampleProposal({ skillSlug: 'spot-perp-crowding-fade' });
        const orderInput = buildPaperOrderFromProposal(proposal, 0.5, 3);
        assert.equal(orderInput.skill_slug, 'spot-perp-crowding-fade');
        assert.equal(orderInput.action, 'open_market');

        // Pure core risk wall check: excessive leverage refused without state mutation
        const account = createPaperAccount({ enabled: true, maxLeverage: 5, maxRiskPerTradePct: 1.0 }, BASE_MS);
        const refusedLeverage = placePaperOrder({
            account,
            input: buildPaperOrderFromProposal(proposal, 0.5, 25),
            quote: { bestBid: 59990, bestAsk: 60010, last: 60000 },
            nowMs: BASE_MS + 1000,
        });
        assert.equal(refusedLeverage.ok, false);
        assert.equal(account.positions.length, 0);

        // Full service round-trip (injected offline quoteProvider + knownSymbol) preserves skillSlug
        const user = 'wave5-paper-exec-user';
        backing.set('last_active_user', user);
        await __paperBrokerTestHooks.clear(user);

        const fillReceipt = await submitPaperOrder(orderInput, {
            username: user,
            nowMs: BASE_MS + 2000,
            knownSymbol: async () => true,
            quoteProvider: async () => ({
                mark: 60000,
                fundingRate: 0.0001,
                fundingFrames: [],
                quote: {
                    bestBid: 59990,
                    bestAsk: 60010,
                    last: 60000,
                    depth: {
                        bids: [{ price: 59990, qty: 10 }],
                        asks: [{ price: 60010, qty: 10 }],
                    },
                },
            }),
        });
        assert.equal(fillReceipt.ok, true, fillReceipt.reason);
        assert.ok(fillReceipt.positionId);

        const openAccount = await getPaperAccount(user);
        assert.equal(openAccount.positions.length, 1);
        assert.equal(openAccount.positions[0].skillSlug, 'spot-perp-crowding-fade');

        const closeReceipt = await submitPaperOrder({
            action: 'close',
            symbol: 'BTCUSDT',
            position_id: fillReceipt.positionId,
        }, {
            username: user,
            nowMs: BASE_MS + 60_000,
            knownSymbol: async () => true,
            quoteProvider: async () => ({
                mark: 60600,
                fundingRate: 0.0001,
                fundingFrames: [],
                quote: {
                    bestBid: 60590,
                    bestAsk: 60610,
                    last: 60600,
                    depth: {
                        bids: [{ price: 60590, qty: 10 }],
                        asks: [{ price: 60610, qty: 10 }],
                    },
                },
            }),
        });
        assert.equal(closeReceipt.ok, true, closeReceipt.reason);

        const closedAccount = await getPaperAccount(user);
        assert.equal(closedAccount.positions.length, 0);
        assert.equal(closedAccount.closedTrades.length, 1);
        assert.equal(closedAccount.closedTrades[0].skillSlug, 'spot-perp-crowding-fade');
    });

    it('3. LearningDashboard keeps calm 0-trade empty state and renders Execution Autopsy across >= 5 signals + paper trades', () => {
        const emptyHtml = renderToStaticMarkup(
            React.createElement(LearningDashboard, {
                trades: [],
                username: 'wave5-empty-user',
                initialSignals: [],
                initialPaperTrades: [],
            }),
        );
        assert.ok(emptyHtml.includes('data-testid="learning-empty-state"'));
        assert.ok(emptyHtml.includes('No closed trades yet'));
        assert.equal(emptyHtml.includes('data-testid="learning-execution-autopsy"'), false);

        const signals: SignalRow[] = [
            makeSettledSignal(0, { outcomeR: -1.0, mfeR: 0.1, openMin: 0, closeMin: 20 }),
            makeSettledSignal(1, { outcomeR: -1.0, mfeR: 0.15, openMin: 25, closeMin: 35 }),
            makeSettledSignal(2, { outcomeR: 0.1, mfeR: 2.0, openMin: 45, closeMin: 90 }),
            makeSettledSignal(3, { outcomeR: 0.15, mfeR: 1.8, openMin: 180, closeMin: 240 }),
        ];
        const paperTrades: PaperSettledTrade[] = [
            {
                positionId: 'paper-pos-1',
                symbol: 'BTCUSDT',
                side: 'long',
                qty: 0.1,
                entryPrice: 60000,
                exitPrice: 59000,
                grossPnlUsd: -100,
                feesUsd: 6,
                fundingPaidUsd: 0,
                netPnlUsd: -106,
                rMultiple: -1.06,
                exitReason: 'sl',
                openedAt: BASE_MS + 300 * MIN_MS,
                closedAt: BASE_MS + 320 * MIN_MS,
                leverage: 2,
                skillSlug: 'london-sweep-bos',
            },
        ];

        const combined = buildExecutionAutopsy({ signals, paperTrades });
        assert.equal(combined.sampleCount, 5);
        assert.equal(combined.sufficientSample, true);
        assert.ok(combined.byPlaybook.some(p => p.key === 'london-sweep-bos' && p.sample === 5 && p.flaggedLeak));

        const autopsyHtml = renderToStaticMarkup(
            React.createElement(LearningDashboard, {
                trades: [],
                username: 'wave5-autopsy-user',
                initialSignals: signals,
                initialPaperTrades: paperTrades,
            }),
        );
        assert.ok(autopsyHtml.includes('data-testid="learning-execution-autopsy"'));
        assert.ok(autopsyHtml.includes('data-testid="autopsy-mfe-giveback"'));
        assert.ok(autopsyHtml.includes('data-testid="autopsy-immediate-stops"'));
        assert.ok(autopsyHtml.includes('data-testid="autopsy-revenge-clusters"'));
        assert.ok(autopsyHtml.includes('data-testid="autopsy-weakest-leak"'));
        assert.ok(autopsyHtml.includes('london-sweep-bos'));
        assert.ok(autopsyHtml.includes('Execution Autopsy'));

        // Verify logged-trade dedupe helper skips IDs already present in base set
        const exclude = new Set(['paper-pos-1']);
        const deduped = autopsyRowsFromLoggedTrades([], exclude);
        assert.equal(deduped.length, 0);
    });
});
