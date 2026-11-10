import type { Conversation } from '../../types/trade';
import { MessageRole } from '../../types/enums';

/**
 * SessionSearch: unified FTS-style search over the user's
 * stored conversation history — one backend powering both:
 *  - the `recall_chat` desk tool (seats can search past debates mid-run), and
 *  - future UI search surfaces.
 *
 * Conversations persist on the UserProfile (`profile.conversations`), so the
 * search loads them via dbService and scores matches with a lightweight
 * term-frequency ranking (no index file needed at this scale).
 */

export interface ChatSearchHit {
    conversationId: string;
    conversationTitle: string;
    /** ISO date of the matched message. */
    at: string;
    speaker: string;
    /** Matched excerpt, trimmed to ~240 chars around the first hit. */
    excerpt: string;
    /** Simple relevance score: term hits × role weight × recency boost. */
    score: number;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'was', 'for', 'on', 'it', 'at', 'as']);

const tokenize = (q: string): string[] =>
    q.toLowerCase().split(/[^a-z0-9%$.]+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));

const excerptAround = (text: string, lowerTerm: string): string => {
    const idx = text.toLowerCase().indexOf(lowerTerm);
    if (idx < 0) return text.slice(0, 240);
    const start = Math.max(0, idx - 100);
    const end = Math.min(text.length, idx + 140);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

// ── Per-user message index ──────────────────────────────────────────────
// searchChatHistory used to re-lowercase and re-scan every message of every
// conversation on every call. The index flattens that work once per profile
// fingerprint; repeated searches (the desk tool fires per debate seat) then
// only touch the pre-lowered rows.
//
// The fingerprint is a cheap O(n) signature over the profile (conversation
// count, message count, newest timestamp, and a per-message length+endpoint
// sum) — primitive reads only, no allocations. The search reads the
// PERSISTED profile (same source the fingerprint is computed from), so any
// structural change or text edit that lands in storage flips it and forces a
// rebuild. invalidateChatHistoryIndex() is exported for callers that mutate
// message text in place without a fingerprint-visible change.

interface IndexedMessage {
    conv: Conversation;
    text: string;
    lower: string;
    role: string;
    createdAt?: string;
}

interface UserIndex {
    fingerprint: string;
    rows: IndexedMessage[];
}

const indexByUser = new Map<string, UserIndex>();
const INDEX_USER_CAP = 4;

const fingerprintOf = (conversations: Conversation[]): string => {
    let newest = 0;
    let messages = 0;
    let sig = 0;
    for (const c of conversations) {
        if (c.timestamp > newest) newest = c.timestamp;
        for (const m of c.messages ?? []) {
            messages += 1;
            const t = typeof m.text === 'string' ? m.text : '';
            sig = (sig + t.length * 31 + (t.charCodeAt(0) || 0) + (t.charCodeAt(t.length - 1) || 0)) | 0;
        }
    }
    return `${conversations.length}:${messages}:${newest}:${sig}`;
};

const buildIndex = (username: string, conversations: Conversation[]): UserIndex => {
    const rows: IndexedMessage[] = [];
    for (const conv of conversations) {
        for (const msg of conv.messages ?? []) {
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (!text) continue;
            rows.push({ conv, text, lower: text.toLowerCase(), role: String(msg.role ?? ''), createdAt: msg.createdAt });
        }
    }
    const index: UserIndex = { fingerprint: fingerprintOf(conversations), rows };
    indexByUser.set(username, index);
    // Bound the map: the oldest entry (by insertion) goes first.
    while (indexByUser.size > INDEX_USER_CAP) {
        const oldest = indexByUser.keys().next().value;
        if (oldest === undefined) break;
        indexByUser.delete(oldest);
    }
    return index;
};

/**
 * Drop the cached index (all users, or one). Call after any in-place message
 * text mutation the profile fingerprint cannot see.
 */
export const invalidateChatHistoryIndex = (username?: string): void => {
    if (username === undefined) indexByUser.clear();
    else indexByUser.delete(username);
};

/** Search every stored conversation's messages for a query. Returns top N. */
export interface ChatSearchOptions {
    /** Only messages at or after this instant. Filters the ROWS, not the hits:
     *  dropping hits afterwards would let a date window silently empty a result
     *  set the ranker had already capped. */
    sinceMs?: number;
    /** Only messages at or before this instant. */
    untilMs?: number;
}

export const searchChatHistory = async (
    query: string,
    username?: string,
    limit = 5,
    options: ChatSearchOptions = {},
): Promise<ChatSearchHit[]> => {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const { getUserProfile } = await import('./dbService');
    const user = username
        || (typeof localStorage !== 'undefined' ? localStorage.getItem('last_active_user') || undefined : undefined)
        || 'default';
    let conversations: Conversation[];
    try {
        const profile = await getUserProfile(user);
        conversations = profile?.conversations ?? [];
    } catch {
        return [];
    }

    const fingerprint = fingerprintOf(conversations);
    const cached = indexByUser.get(user);
    const index = cached && cached.fingerprint === fingerprint ? cached : buildIndex(user, conversations);
    const inWindow = (at: string | undefined, fallbackMs: number): boolean => {
        const ms = at ? Date.parse(at) : fallbackMs;
        if (!Number.isFinite(ms)) return true;
        if (typeof options.sinceMs === 'number' && ms < options.sinceMs) return false;
        if (typeof options.untilMs === 'number' && ms > options.untilMs) return false;
        return true;
    };

    const hits: ChatSearchHit[] = [];
    for (const row of index.rows) {
        if (!inWindow(row.createdAt, row.conv.timestamp)) continue;
        const { lower, text } = row;
        let score = 0;
        for (const term of terms) {
            const occurrences = lower.split(term).length - 1;
            if (occurrences > 0) score += Math.min(occurrences, 4);
        }
        if (score === 0) continue;
        // Prefer AI/moderator analysis over short user prompts.
        const roleWeight = row.role === MessageRole.USER ? 0.6 : 1;
        // Recency boost: newer conversations surface first on ties.
        const ageDays = Math.max(0, (Date.now() - row.conv.timestamp) / 86_400_000);
        const recency = Math.exp(-ageDays / 60);
        const matched = terms.find(t => lower.includes(t)) ?? terms[0];
        hits.push({
            conversationId: row.conv.id,
            conversationTitle: row.conv.title || 'Untitled session',
            at: row.createdAt ?? new Date(row.conv.timestamp).toISOString(),
            speaker: row.role,
            excerpt: excerptAround(text, matched),
            score: score * roleWeight * (1 + recency),
        });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
};

/** Compact digest block for the `recall_chat` desk tool (≤1600 chars like recall). */
export const formatChatHitsDigest = (hits: ChatSearchHit[]): string => {
    if (hits.length === 0) return 'No matching passages found in your past sessions.';
    const rows = hits.map(h =>
        `- [${h.conversationTitle} · ${h.at.slice(0, 10)} · ${h.speaker}] ${h.excerpt.replace(/\s+/g, ' ')}`,
    );
    let out = '';
    for (const row of rows) {
        if (out.length + row.length > 1600) break;
        out += `${row}\n`;
    }
    return out.trim() || 'No matching passages found in your past sessions.';
};
