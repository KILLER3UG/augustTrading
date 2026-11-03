/**
 * autoJournalRules — the per-coin "log this setup for me" policy.
 *
 * The Approvals inbox that once collected these decisions is gone (owner
 * ruling 2026-11-03), but the RULE it wrote is still what the autopilot obeys,
 * so the store and its one reader stay. Renamed from `approvalInbox` when the
 * inbox half was deleted: a module named for an inbox it no longer has is the
 * stale name that sends the next reader looking for a deleted surface.
 */

export type AutoJournalPolicy = 'ask' | 'always' | 'deny';

export interface AutoJournalRule {
    coin: string;
    policy: Exclude<AutoJournalPolicy, 'ask'>;
}

const LEGACY_RULES_KEY = 'approval_rules_v1';
const rulesKey = (username?: string): string =>
    `approval_rules_v1:${(username || 'default').trim() || 'default'}`;

const readRules = (username?: string): AutoJournalRule[] => {
    try {
        const raw = localStorage.getItem(rulesKey(username))
            ?? (!username ? localStorage.getItem(LEGACY_RULES_KEY) : null);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

export const getAutoJournalRules = (username?: string): AutoJournalRule[] =>
    typeof localStorage === 'undefined' ? [] : readRules(username);

export const setAutoJournalRule = (coin: string, policy: AutoJournalPolicy, username?: string): AutoJournalRule[] => {
    const key = coin.toUpperCase();
    const next = getAutoJournalRules(username).filter(r => r.coin !== key);
    if (policy !== 'ask') next.push({ coin: key, policy });
    try {
        localStorage.setItem(rulesKey(username), JSON.stringify(next));
    } catch { /* ignore */ }
    return next;
};

export const autoJournalPolicyFor = (coin?: string, username?: string): AutoJournalPolicy => {
    if (!coin) return 'ask';
    const hit = getAutoJournalRules(username).find(r => r.coin === coin.toUpperCase());
    return hit?.policy ?? 'ask';
};
