/**
 * cardHydration — F10's other half: pending dock-turn decision cards mirrored
 * into the canonical Message persistence come back after a reload with the
 * module stores EMPTY (the dispositions, pending slots and undo windows are
 * runtime state). Without rebinding, a hydrated card is either dead UI (its
 * confirm resolves nothing — the F2 failure class) or missing entirely.
 *
 * The pass runs ONCE per profile load (the boot load in useUserProfileLoader,
 * with the journal rows in scope) and seeds each mirrored card by EVIDENCE:
 *
 *  - decision landed → seed `confirmed` so the card renders resolved and
 *    cannot re-apply (a settings value equal to the proposal, a plan status
 *    equal to the proposed status, a row already carrying the correction, a
 *    gone armed plan, a logged journal row);
 *  - decision did NOT land → seed `pending` so the card is interactive again;
 *  - the thing it acted on is GONE (row deleted, plan disarmed) → seed
 *    `dismissed` — the card resolves instead of offering an action on nothing.
 *
 * The trade-proposal card needs no store: its Approve path re-runs the whole
 * writer (gate stamp, guard, dedupe), so hydration only records the
 * disposition when the planId already has a journal row.
 */

import type { Message } from '../../types/message';
import type { LoggedTrade } from '../../types';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { seedRiskChangeForHydration } from './riskChangeProposal';
import { seedStrategyActivationForHydration } from './strategyActivation';
import { seedSettlementCorrectionForHydration } from './settlementCorrection';
import { seedTradeActionForHydration, type TradeActionProposal } from './tradeActionProposal';
import { rememberProposalState } from './proposalDisposition';
import { getStrategy } from '../learning/strategyStore';
import { getArmedPlans } from './levelWatchService';

const numbersEqual = (a: unknown, b: unknown): boolean =>
    typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && a === b;

export const hydrateCardsFromMessages = (messages: Message[], trades: LoggedTrade[]): void => {
    for (const m of messages) {
        // ── Risk change: settings value already equals the proposal → landed.
        if (m.riskChange) {
            const p = m.riskChange;
            const current = (getHarnessSettings() as unknown as Record<string, unknown>)[p.target];
            const landed = current !== undefined
                && (typeof p.proposedValue === 'number'
                    ? numbersEqual(current, p.proposedValue)
                    : current === p.proposedValue);
            seedRiskChangeForHydration(p, landed ? 'confirmed' : undefined);
        }
        // ── Strategy activation: plan status already equals the proposal.
        if (m.strategyActivation) {
            const p = m.strategyActivation;
            const meta = getStrategy(p.slug);
            const landed = meta ? meta.status === p.proposedStatus : false;
            seedStrategyActivationForHydration(p, landed ? 'confirmed' : undefined);
        }
        // ── Settlement correction: the row carries the correction → landed;
        //    the row is GONE → resolved (voided or deleted); else pending.
        if (m.settlementCorrection) {
            const p = m.settlementCorrection;
            const row = trades.find(t => t.id === p.tradeId);
            if (!row) seedSettlementCorrectionForHydration(p, 'dismissed');
            else {
                const outcomeLanded = !p.outcome || row.outcome === p.outcome;
                const pnlLanded = (p.pnlAmount === undefined || numbersEqual(row.pnlAmount, p.pnlAmount))
                    && (p.pnlPercent === undefined || numbersEqual(row.pnlPercent, p.pnlPercent));
                seedSettlementCorrectionForHydration(p, outcomeLanded && pnlLanded ? 'confirmed' : undefined);
            }
        }
        // ── Trade action: the armed plan is gone → resolved; else pending
        //    (level equality is the plan's own live state — an armed plan
        //    whose levels already match reads as applied).
        if (m.tradeAction) {
            const p = m.tradeAction as TradeActionProposal;
            const armed = getArmedPlans().some(pl => pl.planId === p.planId);
            seedTradeActionForHydration(p, armed ? undefined : 'dismissed');
        }
        // ── Trade proposal: the journal row exists → the approve landed
        //    (the disposition renders the settled row, not a re-actionable
        //    card). No row → pending; the Approve path re-runs the whole
        //    writer, so the card is safe to interact with again.
        if (m.proposal?.planId) {
            const landed = trades.some(t => t.planId === m.proposal!.planId);
            if (landed) rememberProposalState(m.id, 'logged');
        }
    }
};
