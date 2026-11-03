/**
 * outcomeSettlement — the decision between "detected" and "recorded".
 *
 * The learning loop used to be starved by one human click: the autopilot
 * resolved a trade, and every consumer downstream (skills, calibration, weekly
 * review, provider ranking) read an empty journal until the trader pressed
 * confirm. E-18 makes the write automatic but REVERSIBLE and PROVENANCED.
 *
 * The policy is deliberately a pure table:
 *   - an explicit per-coin 'deny' wins over everything;
 *   - an explicit per-coin 'always' logs immediately;
 *   - an expired-while-open setup is ambiguous and stays a notification;
 *   - otherwise the trader's global mode decides: automatic (15 s + Undo),
 *     shadow (show, do not record), or confirm (notification only).
 *
 * Keeping it pure is what lets the hook and its tests agree about every
 * combination without a timer, a provider, or a mounted component.
 */

import type { AutoJournalPolicy } from './autoJournalRules';

export type OutcomeSettlement = 'automatic' | 'confirm' | 'shadow';

export interface SettlementInput {
    /** Was this setup pinned to the watch list? */
    watched: boolean;
    /** The per-coin rule the trader set in the approval inbox. */
    policy: AutoJournalPolicy;
    /** The global mode. */
    settlement: OutcomeSettlement;
    /** Expired while still open — no single outcome is safe to record. */
    expiredOpen: boolean;
}

export type SettlementAction =
    /** The trader said no for this coin. */
    | 'ignore'
    /** Show the resolution; record nothing until the trader acts. */
    | 'notify-only'
    /** Resolve, show, do not record — the shadow month. */
    | 'shadow'
    /** Record now. */
    | 'log-now'
    /** Record after a short undo window. */
    | 'log-after-undo';

export const settlementActionFor = (input: SettlementInput): SettlementAction => {
    if (input.expiredOpen) return 'notify-only';
    if (input.policy === 'deny') return 'ignore';
    if (input.policy === 'always') return 'log-now';
    if (input.settlement === 'shadow') return 'shadow';
    if (input.settlement === 'confirm') return 'notify-only';
    return 'log-after-undo';
};

/** How long the Undo window stays open. */
export const SETTLEMENT_UNDO_MS = 15_000;
