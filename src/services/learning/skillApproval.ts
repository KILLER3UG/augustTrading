/**
 * skillApproval — the one place a pending skill draft becomes a live skill.
 *
 * Both approval surfaces (the Coach thread's Save button and the approval
 * inbox) used to run the same six lines inline, and both were wrong in the
 * same way: they DELETED the draft, fired the notebook write with `void`, and
 * toasted "Skill saved" — unconditionally. `ingestCraftedSkill*Unlocked`
 * contains seven bare `return`s that write nothing (no skills folder, a skill
 * already carrying this trigger, an archived twin, an ineligible trade, a
 * rejected trade shape), and `createMemoryFileUnlocked` throws on a name
 * collision. Every one of those left the trader told that a skill existed when
 * none did, with the draft already destroyed so there was no retry.
 *
 * The fix is a read-back, not a new return type threaded through seven exits:
 * ask the library whether this trigger is present AFTER the write, and let
 * that answer — not the call's completion — decide what the UI says. It also
 * covers a future silent return in the ingest path without any change here.
 * This is the repo's standing rule for notebook writes (AGENTS.md): never
 * swallow-and-continue; surface it.
 */

import { activateSkillForTrigger, ingestCraftedSkill, ingestCraftedSkillFromDraft, isApprovedSkill, listSkills, type SkillIngestResult } from './SkillMemoryService';
import { listSkillDrafts, markSkillDraftFailed, SKILL_DRAFT_MAX_ATTEMPTS, takeSkillDraft, type SkillDraft } from '../../utils/skillDrafts';
import type { LoggedTrade } from '../../types';

export type SkillApprovalResult =
    /** The library now carries this trigger and the draft was consumed. */
    | { created: true; slug: string; draftRemains?: boolean }
    /** The trigger was ALREADY a live skill before the write — nothing new was
     *  born. `draftRemains` says the inbox row survived a refused removal. */
    | { created: false; reason: 'duplicate'; slug: string; draftRemains?: boolean }
    /** The write path declined for a named reason, or threw. The draft is LEFT
     *  IN THE INBOX so the human can fix and retry it, rather than being
     *  destroyed on an assumption. */
    | { created: false; reason: 'not-written' | 'write-failed' | 'no-skills-folder' | 'over-hard-cap'; error?: string };

/** Case-insensitive trigger match — the same comparison the ingest path uses
 *  to refuse a duplicate, so "already learned" means the same thing on both
 *  sides of the write. */
const findSkill = (when: string): { name: string; meta: Parameters<typeof isApprovedSkill>[0] } | null => {
    const want = when.trim().toLowerCase();
    const hit = listSkills().find(s => (s.meta.when ?? '').trim().toLowerCase() === want);
    return hit ? { name: hit.file.name, meta: hit.meta } : null;
};

const findByTrigger = (when: string): string | null => findSkill(when)?.name ?? null;

/**
 * Approve one draft. `trades` is the journal, used the way the old inline
 * handler used it: a draft that came from a CLOSED trade (a post-mortem craft)
 * ingests through the trade path so it carries that trade's evidence; a
 * verdict- or chat-sourced draft has no trade behind it and takes the draft
 * path.
 */
export const approveSkillDraft = async (
    draft: SkillDraft,
    username: string,
    trades: LoggedTrade[] = [],
    /** WHOSE decision this write records. 'human' — the button press — and
     *  'auto' — the owner-ruled auto-apply — are both approval facts;
     *  `isApprovedSkill` treats them the same because the ruling made them
     *  the same. */
    approvedBy: 'human' | 'auto' = 'human',
): Promise<SkillApprovalResult> => {
    const user = username || 'default';
    const trigger = draft.crafted.when;
    const alreadyThere = findByTrigger(trigger);

    const trade = trades.find(t => t.id === draft.tradeId);
    let declined: 'no-skills-folder' | 'over-hard-cap' | null = null;
    let detail: string | undefined;
    try {
        // P0-1: the approval fact rides the WRITE regardless of which ingest
        // path carries the evidence. The trade-backed writer previously built
        // its SkillMeta with no `approvedBy`/`prior`, so a post-mortem Save
        // produced a skill that failed `isApprovedSkill` and silently never
        // injected — while the card read "Active".
        if (trade) await ingestCraftedSkill(trade, draft.crafted, user, approvedBy);
        else {
            const r = await ingestCraftedSkillFromDraft(draft.crafted, draft.coin, user, undefined, approvedBy);
            // The ingest now says WHY it wrote nothing. The read-back below is
            // still the authority on success, but a named cause beats a generic
            // one in the message the human reads.
            if (r && !r.created && r.reason === 'no-skills-folder') declined = r.reason;
            if (r && !r.created && r.reason === 'over-hard-cap') { declined = r.reason; detail = r.detail; }
        }
    } catch (e) {
        return { created: false, reason: 'write-failed', error: e instanceof Error ? e.message : String(e) };
    }

    const after = findSkill(trigger);
    if (!after) {
        // The write path declined, or declined to say so. Do not consume the
        // draft: the human's only copy of this proposal is the inbox row.
        return { created: false, reason: declined ?? 'not-written', ...(detail ? { error: detail } : {}) };
    }
    if (alreadyThere && alreadyThere === after.name) {
        // The trigger was already in the library — but a duplicate is not an
        // approval. If that row is not live, this press is the consent that makes
        // it live: activate it, and report a real change. Refusing here (the old
        // behaviour) consumed the draft and told the human a skill that never
        // injected was "already learned" (the 2026-10-27 audit S-1).
        if (!isApprovedSkill(after.meta)) {
            const activated = await activateSkillForTrigger(trigger, user);
            if (activated) {
                const consumed = takeSkillDraft(draft.id, username || undefined);
                return { created: true, slug: activated, ...(consumed ? {} : { draftRemains: true }) };
            }
        }
        const consumed = takeSkillDraft(draft.id, username || undefined);
        return { created: false, reason: 'duplicate', slug: after.name, ...(consumed ? {} : { draftRemains: true }) };
    }
    const consumed = takeSkillDraft(draft.id, username || undefined);
    return { created: true, slug: after.name, ...(consumed ? {} : { draftRemains: true }) };
};

/** What an INGEST's named outcome means to the human who just pressed a button
 *  on it. `null` means the write landed — show nothing on success. Kept beside
 *  `skillApprovalToast` so the two surfaces that approve drafts cannot describe
 *  one refusal two different ways. */
export const skillIngestOverrideNote = (
    result: SkillIngestResult,
): { kind: 'error' | 'info'; body: string } | null => {
    if (result.created) return null;
    switch (result.reason) {
        case 'duplicate':
            return { kind: 'info', body: `Already a live skill (${result.slug}) — the trigger was there before you pressed.` };
        case 'no-skills-folder':
            return { kind: 'error', body: 'Not approved — this notebook has no skills folder to write into, so nothing was created.' };
        case 'over-hard-cap':
            return { kind: 'error', body: `Not approved — ${result.detail}. The draft is still in your inbox.` };
    }
};

/** What the trader is told, derived from what the library actually did. Kept
 *  here rather than in the caller so both approval surfaces — the Coach thread
 *  and the Inbox — cannot drift into disagreeing about the same write. */
export const skillApprovalToast = (
    result: SkillApprovalResult,
    name: string,
): { kind: 'success' | 'info' | 'error'; title: string; body: string } => {
    if (result.created) {
        return {
            kind: 'success',
            title: 'Skill saved',
            body: `${name}${result.draftRemains ? ' — the draft could not be removed from the inbox; it is still there.' : ''}`,
        };
    }
    if (result.reason === 'duplicate') {
        return {
            kind: 'info',
            title: 'Already learned',
            body: `${name} — this trigger is already a live skill${result.draftRemains ? ' (the draft is still in the inbox)' : ''}`,
        };
    }
    return {
        kind: 'error',
        title: 'Not saved — still in your inbox',
        body: result.error ?? `${name}: the skill library did not accept this trigger`,
    };
};

// ─── AUTO-APPLY (owner ruling, 2026-11-03) ──────────────────────────────────
// The approval inbox is gone: a draft applies ITSELF through the same
// deterministic gates a button press ran — duplicates, malformed clauses, body
// caps and tombstones still refuse; what changed is WHOSE consent the write
// records. 'auto' is an approval fact because the owner made it one. A draft
// the library refuses stays in the store with an attempts counter and stops
// being retried at SKILL_DRAFT_MAX_ATTEMPTS — a budget, so a permanently
// refusable draft cannot burn a write on every sweep forever.

export interface SkillDraftAutoApplyResult {
    applied: number;
    duplicates: number;
    refused: number;
    /** Drafts that hit the retry budget and are no longer attempted. */
    exhausted: number;
    /** One line per refusal, for the log the Health tab can point at. */
    failures: string[];
}

export const autoApplyPendingSkillDrafts = async (
    username: string,
    trades: LoggedTrade[] = [],
): Promise<SkillDraftAutoApplyResult> => {
    const out: SkillDraftAutoApplyResult = { applied: 0, duplicates: 0, refused: 0, exhausted: 0, failures: [] };
    const user = username || 'default';
    for (const draft of listSkillDrafts(user)) {
        if ((draft.attempts ?? 0) >= SKILL_DRAFT_MAX_ATTEMPTS) {
            out.exhausted += 1;
            continue;
        }
        const result = await approveSkillDraft(draft, user, trades, 'auto');
        if (result.created) {
            out.applied += 1;
        } else if (result.reason === 'duplicate') {
            out.duplicates += 1;
        } else {
            out.refused += 1;
            out.failures.push(`${draft.crafted.name || draft.id}: ${result.reason}${result.error ? ` — ${result.error}` : ''}`);
            // A refused write left the draft in the store (the read-back
            // discipline); count the attempt so the budget binds.
            markSkillDraftFailed(draft.id, user);
        }
    }
    return out;
};
