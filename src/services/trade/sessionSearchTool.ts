/**
 * sessionSearchTool — episodic recall over the Trade-panel chat sessions
 * (`chatSessions`), as a desk tool (`session_search`).
 *
 * Distinct from `infrastructure/sessionSearch.ts`, which searches the
 * AGENT conversations on the profile (`profile.conversations`). This module
 * searches the CHAT-DOCK sessions — the StoredChatEntry transcripts the
 * trader actually worked in — because "what did we conclude about ETH last
 * week" is answered from the work transcript, not the agent thread.
 *
 * Zero-LLM: lexical/phrase scoring over persisted turns, verbatim excerpts,
 * optional neighboring context, and a hard output budget so an old chat is
 * RETRIEVED on demand without ever riding the system prompt.
 */

import { loadSessions, type ChatSession, type StoredChatEntry } from './chatSessions';
import { searchChatHistory } from '../infrastructure/sessionSearch';

export interface SessionSearchParams {
    query: string;
    limit?: number;
    /** Filter to one instrument (session-bound symbol or text match). */
    symbol?: string;
    /** Search one session only. */
    session_id?: string;
    /** Neighboring turns to include before/after each hit (0–3, default 1). */
    window?: number;
}

export interface SessionSearchHit {
    sessionId: string;
    title: string;
    /** ISO timestamp of the MATCHED turn. */
    at: string;
    symbol?: string;
    role: 'user' | 'ai';
    /** Verbatim text around the first match — never paraphrased. */
    excerpt: string;
    score: number;
    /** Neighboring turns (trimmed), oldest first. */
    before: string[];
    after: string[];
}

export interface SessionSearchResult {
    hits: SessionSearchHit[];
    /** How many sessions/entries were scanned — the honest "searched N". */
    scannedSessions: number;
    scannedEntries: number;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'was', 'for', 'on', 'it', 'at', 'as', 'with', 'what', 'how']);

const tokenize = (query: string): string[] =>
    (query || '').toLowerCase().split(/[^a-z0-9%$.]+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));

export const SESSION_SEARCH_EXCERPT_CHARS = 320;
const NEIGHBOR_CHARS = 200;
export const SESSION_SEARCH_MAX_LIMIT = 20;
export const SESSION_SEARCH_MAX_WINDOW = 3;
const SESSION_SEARCH_DEFAULT_LIMIT = 5;

/** Verbatim slice around the first match, on the ORIGINAL text (no case
 *  folding leakage): the seat quotes the trader's own bytes back. */
export const verbatimExcerpt = (text: string, lowerTerm: string, max = SESSION_SEARCH_EXCERPT_CHARS): string => {
    if (text.length <= max) return text;
    const idx = text.toLowerCase().indexOf(lowerTerm);
    if (idx < 0) return `${text.slice(0, max).trimEnd()}…`;
    const room = Math.floor((max - 2) / 2);
    const start = Math.max(0, idx - room);
    const end = Math.min(text.length, idx + lowerTerm.length + room);
    const head = start > 0 ? `…${text.slice(start, end).trimStart()}` : text.slice(0, end);
    return `${head}${end < text.length ? '…' : ''}`;
};

const entryText = (e: StoredChatEntry): string => {
    if (typeof e.text === 'string' && e.text.trim()) return e.text;
    // A notice/error row still carries words worth finding, but never an image.
    return e.error ?? '';
};

const trimNeighbor = (text: string): string => {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > NEIGHBOR_CHARS ? `${t.slice(0, NEIGHBOR_CHARS).trimEnd()}…` : t;
};

/**
 * Rank one entry against the query. Exact phrase containment dominates,
 * then summed capped term frequency; both get the same role/recency weights
 * the agent-conversation search uses, so the two tools rank alike.
 */
export const scoreEntry = (
    text: string,
    terms: string[],
    phrase: string,
    role: string,
    updatedAtMs: number,
    nowMs: number,
): number => {
    const lower = text.toLowerCase();
    let score = 0;
    if (phrase.length >= 6 && lower.includes(phrase)) score += 6;
    for (const term of terms) {
        const occurrences = lower.split(term).length - 1;
        if (occurrences > 0) score += Math.min(occurrences, 4);
    }
    if (score === 0) return 0;
    const roleWeight = role === 'user' ? 0.6 : 1;
    const ageDays = Math.max(0, (nowMs - updatedAtMs) / 86_400_000);
    const recency = Math.exp(-ageDays / 60);
    return score * roleWeight * (1 + recency);
};

/**
 * Search the persisted chat sessions. Pure over the loaded store (the store
 * itself is the sync cache chatSessions maintains), so the ranking rules are
 * unit-testable without a provider or network.
 */
export const searchChatSessionsForTool = (
    params: SessionSearchParams,
    nowMs = Date.now(),
): SessionSearchResult => {
    const query = (params?.query ?? '').trim();
    const sessions = loadSessions();
    const scannedSessions = sessions.length;
    if (!query) return { hits: [], scannedSessions, scannedEntries: 0 };
    const terms = tokenize(query);
    if (terms.length === 0) return { hits: [], scannedSessions, scannedEntries: 0 };
    const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
    const limit = Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, Math.floor(Number(params.limit) || SESSION_SEARCH_DEFAULT_LIMIT)));
    const window = Math.max(0, Math.min(SESSION_SEARCH_MAX_WINDOW, Math.floor(Number(params.window ?? 1))));
    const symbolWanted = params.symbol?.trim().toUpperCase() || '';
    const sessionIdWanted = params.session_id?.trim() || '';

    let scannedEntries = 0;
    const hits: SessionSearchHit[] = [];
    for (const session of sessions) {
        if (sessionIdWanted && session.id !== sessionIdWanted) continue;
        const sessionSymbol = (session.symbol ?? '').toUpperCase();
        const entries = session.entries ?? [];
        scannedEntries += entries.length;
        for (const [index, entry] of entries.entries()) {
            const text = entryText(entry);
            if (!text) continue;
            if (symbolWanted
                && sessionSymbol !== symbolWanted
                && !text.toUpperCase().includes(symbolWanted)) continue;
            const score = scoreEntry(text, terms, phrase, entry.role, session.updatedAt, nowMs);
            if (score <= 0) continue;
            const matched = terms.find(t => text.toLowerCase().includes(t)) ?? terms[0];
            const before = entries.slice(Math.max(0, index - window), index)
                .map(e => trimNeighbor(entryText(e))).filter(Boolean);
            const after = entries.slice(index + 1, index + 1 + window)
                .map(e => trimNeighbor(entryText(e))).filter(Boolean);
            const at = entry.at ? new Date(entry.at).toISOString() : new Date(session.updatedAt).toISOString();
            hits.push({
                sessionId: session.id,
                title: session.title || 'Untitled chat',
                at,
                symbol: sessionSymbol || undefined,
                role: entry.role,
                excerpt: verbatimExcerpt(text, matched),
                score: Math.round(score * 100) / 100,
                before,
                after,
            });
        }
    }
    hits.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1));
    return { hits: hits.slice(0, limit), scannedSessions, scannedEntries };
};

/**
 * The bounded digest the desk tool returns. `budgetChars` comes from
 * TOOL_BUDGETS — the same cap every other tool result is shaped by — so the
 * digest NEVER swallows a hit silently: it stops at a whole hit and says how
 * many were withheld.
 */
export const formatSessionSearchDigest = (result: SessionSearchResult, budgetChars = 3000): string => {
    if (result.hits.length === 0) {
        return `No matching turns in ${result.scannedSessions} stored chat session(s) (${result.scannedEntries} turns scanned).`;
    }
    const header = `${result.hits.length} match(es) across ${result.scannedSessions} session(s), ${result.scannedEntries} turns scanned — verbatim excerpts:`;
    const lines: string[] = [header];
    let used = header.length;
    let shown = 0;
    for (const hit of result.hits) {
        const block = [
            `[${shown + 1}] ${hit.title}${hit.symbol ? ` · ${hit.symbol}` : ''} · ${hit.at} · ${hit.role} · score ${hit.score}`,
            hit.excerpt,
            ...(hit.before.length ? [`before: ${hit.before.join(' | ')}`] : []),
            ...(hit.after.length ? [`after: ${hit.after.join(' | ')}`] : []),
        ].map(l => `- ${l}`).join('\n');
        if (used + block.length > budgetChars) {
            lines.push(`(${result.hits.length - shown} more match(es) withheld — raise the limit or narrow the query.)`);
            break;
        }
        lines.push(block);
        used += block.length + 1;
        shown += 1;
    }
    return lines.join('\n');
};

/** Session ids are opaque; the transcript tool may need the row back. */
export const sessionById = (id: string): ChatSession | null =>
    loadSessions().find(s => s.id === id) ?? null;

// ─── Unified Chat + Desk episodic search ───────────────────────────────────

/** Which HOME a hit came from. A query about "what we concluded" must find
 *  both the canonical Chat conversations and the dock's chat sessions; the
 *  seat needs the tag to know which surface to open for more context. */
export type SessionSurface = 'chat' | 'desk';

export interface UnifiedSessionSearchHit extends SessionSearchHit {
    surface: SessionSurface;
}

export interface UnifiedSessionSearchResult {
    hits: UnifiedSessionSearchHit[];
    scannedSessions: number;
    scannedEntries: number;
    /** Honest per-surface match counts BEFORE the final global cap — a surface
     *  that found 4 hits but lost them to the 3000-char budget is still shown. */
    matchedBySurface: Record<SessionSurface, number>;
}

/**
 * Search BOTH conversation stores with one ranking formula:
 *  - `desk`: the Chart AI dock's `chatSessions` (synchronous, loadSessions);
 *  - `chat`: the canonical Chat-surface conversations on the profile, through
 *    the SAME `searchChatHistory` index that powers `recall_chat`.
 * Both hit lists merge by score then recency, then take the tool's shared
 * limit. The `session_search` budget (TOOL_BUDGETS = 3000) is applied only by
 * the formatter, so ranking never depends on which surface won a char race.
 */
export const searchAllSessionsForTool = async (
    params: SessionSearchParams,
    nowMs = Date.now(),
    username?: string,
): Promise<UnifiedSessionSearchResult> => {
    const query = (params?.query ?? '').trim();
    const desk = searchChatSessionsForTool(params, nowMs);
    const limit = Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT,
        Math.floor(Number(params.limit) || SESSION_SEARCH_DEFAULT_LIMIT)));
    const chatRaw = query ? await searchChatHistory(query, username, limit) : [];
    const chat: UnifiedSessionSearchHit[] = chatRaw.map(h => ({
        sessionId: h.conversationId,
        title: h.conversationTitle,
        at: h.at,
        symbol: params.symbol?.trim().toUpperCase() || undefined,
        role: h.speaker === 'user' ? 'user' : 'ai',
        excerpt: h.excerpt,
        score: Math.round(h.score * 100) / 100,
        before: [],
        after: [],
        surface: 'chat',
    }));
    const deskHits: UnifiedSessionSearchHit[] = desk.hits.map(h => ({ ...h, surface: 'desk' }));
    const hits = [...deskHits, ...chat]
        .sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1))
        .slice(0, limit);
    return {
        hits,
        scannedSessions: desk.scannedSessions,
        scannedEntries: desk.scannedEntries,
        matchedBySurface: { desk: deskHits.length, chat: chat.length },
    };
};

/** The bounded digest for the unified tool. The surface tag is part of the
 *  line, never a separate preamble: a clipped hit still says where it came
 *  from, and the cap still stops at a WHOLE hit. */
export const formatUnifiedSessionSearchDigest = (
    result: UnifiedSessionSearchResult,
    budgetChars = 3000,
): string => {
    const surfaces = result.matchedBySurface;
    const header = result.hits.length === 0
        ? `No matching turns in Chat or Desk sessions (${surfaces.chat} chat / ${surfaces.desk} desk match(es) before the cap).`
        : `${result.hits.length} match(es) — Chat ${surfaces.chat} · Desk ${surfaces.desk} — ${result.scannedSessions} desk session(s), ${result.scannedEntries} turns scanned — verbatim excerpts:`;
    if (result.hits.length === 0) return header;
    const lines: string[] = [header];
    let used = header.length;
    let shown = 0;
    for (const hit of result.hits) {
        const block = [
            `[${shown + 1}] (${hit.surface}) ${hit.title}${hit.symbol ? ` · ${hit.symbol}` : ''} · ${hit.at} · ${hit.role} · score ${hit.score}`,
            hit.excerpt,
            ...(hit.before.length ? [`before: ${hit.before.join(' | ')}`] : []),
            ...(hit.after.length ? [`after: ${hit.after.join(' | ')}`] : []),
        ].map(l => `- ${l}`).join('\n');
        if (used + block.length > budgetChars) {
            lines.push(`(${result.hits.length - shown} more match(es) withheld — raise the limit or narrow the query.)`);
            break;
        }
        lines.push(block);
        used += block.length + 1;
        shown += 1;
    }
    return lines.join('\n');
};
