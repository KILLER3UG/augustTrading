import { CraftedSkill } from '../schemas/learning';

export interface SkillDraft {
    id: string;
    tradeId: string;
    coin?: string;
    crafted: CraftedSkill;
    createdAt: string;
    /** How many times the AUTO-APPLY path tried and failed to land this draft
     *  (owner ruling 2026-11-03: no approval inbox). The deterministic gates
     *  refuse for named reasons — no skills folder, over the hard cap — and a
     *  draft that keeps failing would be retried on every sweep forever
     *  without a budget. At SKILL_DRAFT_MAX_ATTEMPTS it stops being attempted
     *  and stays in the store as history. */
    attempts?: number;
}

/** The auto-apply retry budget for one draft. */
export const SKILL_DRAFT_MAX_ATTEMPTS = 3;

const KEY_PREFIX = 'skill_drafts_v1';
const LEGACY_KEY = KEY_PREFIX;

const storageKey = (username?: string): string =>
    `${KEY_PREFIX}:${(username || 'default').trim() || 'default'}`;

/** Legacy rows: an id used to be a bare millisecond timestamp, so drafts that
 *  closed in the same millisecond shared one. `takeSkillDraft` matches by id,
 *  so supervising one deleted its twins without ingesting either, and React
 *  drops a child whose key repeats — the queue rendered fewer drafts than the
 *  store held. The generator is fixed; this heals rows written before it.
 *  Deterministic (position, not randomness) because the id a caller read a
 *  moment earlier has to be the id takeSkillDraft resolves. */
const healRepeatIds = (drafts: SkillDraft[]): SkillDraft[] => {
    const seen = new Set<string>();
    return drafts.map((draft, i) => {
        if (!seen.has(draft.id)) {
            seen.add(draft.id);
            return draft;
        }
        const healed = `${draft.id}#${i}`;
        seen.add(healed);
        return { ...draft, id: healed };
    });
};

const read = (username?: string): SkillDraft[] => {
    try {
        const scopedKey = storageKey(username);
        const raw = localStorage.getItem(scopedKey)
            ?? (!username ? localStorage.getItem(LEGACY_KEY) : null);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? healRepeatIds(parsed) : [];
    } catch {
        return [];
    }
};

/** True only when the bytes are on disk. A caller is about to tell a human
 *  "your proposal is in the inbox"; that claim needs the store's agreement, not
 *  the absence of a throw. `dispatch` announces the write to the auto-apply
 *  sweep — a NEW draft wants that; a failure-bookkeeping write must NOT, or
 *  the refusal re-fires the sweep that refused it and burns the retry budget
 *  against itself (measured in probe case 4: attempts hit the cap in one
 *  burst). */
const write = (drafts: SkillDraft[], username?: string, dispatch = true): boolean => {
    try {
        localStorage.setItem(storageKey(username), JSON.stringify(drafts.slice(-20)));
        if (dispatch && typeof window !== 'undefined') window.dispatchEvent(new Event('august-skill-drafts'));
        return true;
    } catch {
        return false;
    }
};

export const listSkillDrafts = (username?: string): SkillDraft[] =>
    typeof localStorage === 'undefined' ? [] : read(username);

export const queueSkillDraft = (draft: Omit<SkillDraft, 'id' | 'createdAt'>, username?: string): SkillDraft | null => {
    const next: SkillDraft = {
        ...draft,
        // A millisecond timestamp alone is NOT unique: several trades closing
        // in the same ms produced identical ids, and takeSkillDraft filters by
        // id — so supervising one silently deleted its twins from the queue
        // without ever ingesting them. Same suffix discipline as learningQueue.
        id: `sk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: new Date().toISOString(),
    };
    const rest = listSkillDrafts(username).filter(d => d.tradeId !== draft.tradeId);
    if (!write([...rest, next], username)) return null;
    // Read-back. `write` returning true only proves setItem did not throw, and
    // propose_skill's receipt was already claiming the draft was queued before
    // anyone looked. Confirm the row is actually in the store the human will
    // open, and let the caller report a real failure if it is not.
    return listSkillDrafts(username).some(d => d.id === next.id) ? next : null;
};

export const takeSkillDraft = (id: string, username?: string): SkillDraft | null => {
    const drafts = listSkillDrafts(username);
    const hit = drafts.find(d => d.id === id) ?? null;
    if (!hit) return null;
    // The removal is part of the operation, not a side effect: the same read-back
    // discipline as `queueSkillDraft`. A refused write leaves the draft in the
    // inbox and is REPORTED, because a caller that assumes removal can approve the
    // same draft twice (the 2026-10-27 audit S-6).
    if (!write(drafts.filter(d => d.id !== id), username)) return null;
    return listSkillDrafts(username).some(d => d.id === id) ? null : hit;
};

/** Count one failed auto-apply attempt against a draft that REMAINS in the
 *  store. Read-back discipline as everywhere else here: the increment is only
 *  real when the store says so. The write is SILENT — this is bookkeeping on a
 *  draft the sweep just refused, not a new draft arriving, and re-firing the
 *  sweep would retry the refusal against its own budget. */
export const markSkillDraftFailed = (id: string, username?: string): SkillDraft | null => {
    const drafts = listSkillDrafts(username);
    const hit = drafts.find(d => d.id === id);
    if (!hit) return null;
    const bumped = { ...hit, attempts: (hit.attempts ?? 0) + 1 };
    if (!write(drafts.map(d => (d.id === id ? bumped : d)), username, false)) return null;
    return listSkillDrafts(username).some(d => d.id === id && d.attempts === bumped.attempts) ? bumped : null;
};

// ─── Rejection tombstones ───────────────────────────────────────────────────
// Discarding a draft used to leave no trace, so the next verdict citing the
// same pattern re-queued it immediately — the approval inbox became noise.
// A rejected trigger stays quiet for the cooldown window instead.

export const DRAFT_REJECT_COOLDOWN_MS = 7 * 24 * 3_600_000;

export interface SkillDraftTombstone {
    key: string;
    ts: string;
}

const tombstonesKey = (username?: string): string =>
    `${KEY_PREFIX}_rejected:${(username || 'default').trim() || 'default'}`;

const readTombstones = (username?: string): SkillDraftTombstone[] => {
    try {
        const raw = localStorage.getItem(tombstonesKey(username));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/** Stable trigger identity of a draft: coin + kind + the trigger sentence. */
export const draftTriggerKey = (
    coin: string | undefined,
    crafted: Pick<SkillDraft['crafted'], 'kind' | 'when'>,
): string =>
    [
        (coin || '').toUpperCase().replace(/USDT?$/, ''),
        crafted?.kind ?? '',
        crafted?.when ?? '',
    ].join('|').toLowerCase();

export const isDraftTombstoned = (
    key: string,
    username?: string,
    cooldownMs: number = DRAFT_REJECT_COOLDOWN_MS,
): boolean => {
    if (!key || typeof localStorage === 'undefined') return false;
    const cutoff = Date.now() - cooldownMs;
    return readTombstones(username).some(t => t.key === key && Date.parse(t.ts) > cutoff);
};

/** Record a user rejection — the matching trigger won't be re-queued during the cooldown. */
export const tombstoneSkillDraftKey = (key: string, username?: string): void => {
    if (!key || typeof localStorage === 'undefined') return;
    const next = [
        { key, ts: new Date().toISOString() },
        ...readTombstones(username).filter(t => t.key !== key),
    ].slice(0, 50);
    try {
        localStorage.setItem(tombstonesKey(username), JSON.stringify(next));
    } catch { /* ignore */ }
};

// ─── Worth-gate attempt ledger ──────────────────────────────────────────────
// The worth gate is a LIVE LLM call. When it cannot run (no ready provider) the
// cluster stays eligible and the next closed trade retries — which, before this
// ledger, meant one billed attempt per close FOREVER on a cluster that keeps
// producing trades and never gets a provider. The ledger records what the gate
// was last asked about and which trades were in the cluster then, so a retry
// happens only when the evidence actually changed (or a human asks).

export interface WorthGateAttempt {
    key: string;
    /** ISO stamp of the most recent attempt for this cluster. */
    lastAt: string;
    /** How many times the gate has been asked about this cluster. */
    attempts: number;
    /** Ids that were IN the cluster at the last attempt. A retry needs a trade
     *  the gate has not already judged. */
    tradeIds: string[];
}

const gateAttemptsKey = (username?: string): string =>
    `${KEY_PREFIX}_gate_attempts:${(username || 'default').trim() || 'default'}`;

const readGateAttempts = (username?: string): WorthGateAttempt[] => {
    try {
        const raw = localStorage.getItem(gateAttemptsKey(username));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/** The last recorded attempt for a cluster, or null when the gate has never
 *  been asked about it. */
export const readWorthGateAttempt = (key: string, username?: string): WorthGateAttempt | null => {
    if (!key || typeof localStorage === 'undefined') return null;
    return readGateAttempts(username).find(a => a.key === key) ?? null;
};

/** Record that the gate was asked about `key` with this cluster. Bounded like
 *  the tombstone ledger — an attempt record is a throttle, not a history. */
export const recordWorthGateAttempt = (
    key: string,
    tradeIds: string[],
    username?: string,
): void => {
    if (!key || typeof localStorage === 'undefined') return;
    const prior = readGateAttempts(username).find(a => a.key === key);
    const next: WorthGateAttempt[] = [
        {
            key,
            lastAt: new Date().toISOString(),
            attempts: (prior?.attempts ?? 0) + 1,
            tradeIds: [...new Set(tradeIds)].slice(-40),
        },
        ...readGateAttempts(username).filter(a => a.key !== key),
    ].slice(0, 50);
    try {
        localStorage.setItem(gateAttemptsKey(username), JSON.stringify(next));
    } catch { /* ignore */ }
};

/**
 * Should the worth gate run for this cluster right now?
 *
 * A retry needs NEW EVIDENCE: a trade id the gate has not already been shown.
 * Without this, a cluster that keeps producing trades and never gets a provider
 * bills one LLM call per close indefinitely. `force` is the human override (the
 * Coach card's "Try now").
 */
export const shouldAttemptWorthGate = (
    key: string,
    clusterTradeIds: string[],
    username?: string,
    force = false,
): boolean => {
    if (force) return true;
    const prior = readWorthGateAttempt(key, username);
    if (!prior) return true;
    const judged = new Set(prior.tradeIds);
    return clusterTradeIds.some(id => !judged.has(id));
};

/** Every recorded gate attempt, newest first. */
export const listWorthGateAttempts = (username?: string): WorthGateAttempt[] => {
    if (typeof localStorage === 'undefined') return [];
    return readGateAttempts(username);
};

/** Clear a cluster's attempt record — the gate ran and reached a verdict, so
 *  the throttle no longer applies. */
export const clearWorthGateAttempt = (key: string, username?: string): void => {
    if (!key || typeof localStorage === 'undefined') return;
    const rest = readGateAttempts(username).filter(a => a.key !== key);
    try {
        localStorage.setItem(gateAttemptsKey(username), JSON.stringify(rest));
    } catch { /* ignore */ }
};
