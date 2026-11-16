/**
 * A self-change is one entry in the harness's change ledger: a request to
 * move something the agent normally only reads — a behavior knob, a prompt
 * override, a skill refinement.
 *
 * The row IS the rail. It stores the previous value verbatim, so undo is a
 * read rather than a guess; it stores who asked and why, so an audit can name
 * the actor; and its `status` is what the settle pass moves, so a change never
 * silently graduates from shadow to live.
 *
 * Rows live as JSON in the existing notebook (self-changes/<id>.json), so
 * backup/export, the notebook write lock and the memory budget already cover
 * them. No new store.
 */

import { z } from 'zod';

/** How much self-modification the trader has allowed. A ceiling, not a mode
 *  switch: 'config' permits reversible knob changes only. 'off' permits
 *  neither. There was a third value, 'shadow' — prompt overrides judged on
 *  closed trades — removed with its tier (O-148): the A/B it measured against
 *  never changed what a run was sent (O-140). A stored 'shadow' mode fails
 *  to 'off' on read. */
export const SELF_MOD_MODES = ['off', 'config'] as const;

/** 'config' = a knob, applied now, auto-reverts at the end of its window.
 *  'shadow' = LEGACY: the removed prompt tier's rows still parse so an old
 *  ledger reads one way, but nothing writes the tier anymore. */
export const SELF_CHANGE_TIERS = ['config', 'shadow'] as const;

export const SELF_CHANGE_STATUSES = ['active', 'shadow', 'promoted', 'reverted', 'rejected'] as const;

export const SELF_CHANGE_ACTORS = ['agent', 'owner', 'system'] as const;

export const SelfChangeSchema = z.strictObject({
    schemaVersion: z.number().int().default(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
    tier: z.enum(SELF_CHANGE_TIERS),
    /** What the change targets, always namespaced: `knob:<key>`,
     *  `prompt:<registry id>`, `skill:<slug>`. */
    target: z.string().min(1).max(140),
    /** The verbatim value before the change, serialized. '' when there was none
     *  (a brand-new prompt override). This is what undo restores. */
    before: z.string().max(12_000),
    /** The value the change applied (or would apply). */
    after: z.string().max(12_000),
    /** Why — the agent's own stated reason, kept verbatim for the audit. */
    reason: z.string().trim().min(1).max(600),
    status: z.enum(SELF_CHANGE_STATUSES),
    actor: z.enum(SELF_CHANGE_ACTORS).default('agent'),
    /** Config-tier only: after this instant the change is auto-reverted, so a
     *  mid-task speed-up cannot become a permanent behavior drift. */
    expiresAt: z.string().optional(),
    /** Prompt-tier only: the corpus fingerprint that identifies runs which
     *  actually resolved this text, so the settle pass can attribute trades. */
    corpusVersion: z.string().max(40).optional(),
    /** What the evidence said when the row was settled, promoted or reverted. */
    evidence: z.string().max(1_000).optional(),
    version: z.number().int().min(1).default(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
});

export const SelfModModeSchema = z.enum(SELF_MOD_MODES);

export type SelfModMode = z.infer<typeof SelfModModeSchema>;
export type SelfChangeTier = z.infer<typeof SelfChangeSchema>['tier'];
export type SelfChangeStatus = z.infer<typeof SelfChangeSchema>['status'];
export type SelfChangeActor = z.infer<typeof SelfChangeSchema>['actor'];
export type SelfChange = z.infer<typeof SelfChangeSchema>;
