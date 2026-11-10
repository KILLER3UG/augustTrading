/**
 * The name of a conversation, derived once for every surface that shows one.
 *
 * The fallback chain is the trader's own first question, which is what the old
 * Agents rail showed and what the reference's sidebar lists. It is written the
 * instant the first message lands; a background model call then replaces it
 * with its own short name (see `services/trade/sessionTitle`). The model's
 * answer is UNTRUSTED text, so the sanitizer that decides whether it may
 * replace that fallback lives here beside the fallback itself — one module
 * owns every rule about what a title is.
 *
 * Code-calculated only for the fallback: no model call, no invented name. A
 * conversation with no user text keeps the caller's own fallback rather than
 * printing an empty label.
 */
import { MessageRole, type Conversation } from '../types';
import type { SessionTitleSource } from '../types/trade';

const MAX_TITLE = 64;

/** The model's brief, enforced rather than trusted. */
export const SESSION_TITLE_MIN_WORDS = 3;
export const SESSION_TITLE_MAX_WORDS = 6;
/** A title longer than this is a sentence, not a name. */
export const SESSION_TITLE_MAX_CHARS = 60;
/** A MANUAL name's ceiling. The model's 3–6-word brief is not imposed on the
 *  trader (a thread may be called "ETH"); only whitespace and a generous cap
 *  keep a paste from becoming the whole row. Shared by both rename surfaces. */
export const MANUAL_TITLE_MAX_CHARS = 80;

/**
 * May a model-generated title replace the stored one?
 *
 * Yes while the row still carries its placeholder or its first-message
 * fallback — including a legacy row with no source at all, which is what
 * `'message'` means. NO once the model has named it (a later exchange must not
 * rename the thread) and NEVER once the trader has (`'user'` is final).
 */
export const modelTitleMayReplace = (source?: SessionTitleSource): boolean =>
    source === undefined || source === 'default' || source === 'message';

/** Quotes, trimmed from either end and nowhere else: an apostrophe inside a
 *  real title is not punctuation to strip. */
const stripWrappingChrome = (text: string): string =>
    text
        .replace(/^[\s"'`“”‘’]+/, '')
        .replace(/[\s"'`“”‘’]+$/, '');

/** One line of a model answer → a usable title, or null to discard it. */
const titleFromLine = (raw: string): string | null => {
    let line = raw.trim();
    if (!line) return null;
    // A fenced answer: the fence markers are chrome, not the title.
    line = line.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
    // List / quote markers.
    line = line.replace(/^(?:[-*•]\s+|\d+\.\s+|>\s+)+/, '');
    // Markdown emphasis / headings / inline code. Stripped BEFORE the label
    // checks so "**Title:** …" is recognised as a label.
    line = line.replace(/[`*_#>]/g, ' ').trim();
    if (!line) return null;
    // A chatty preamble ("Here is a title:") is a label, not the name — the
    // answer's next line is. This keeps a model that ignores the one-line
    // brief from naming the thread after its own introduction.
    if (/[:\-–—]\s*$/.test(line) && line.split(/\s+/).length <= 8) return null;
    // A JSON-shaped answer (a model that ignored "plain text"): take the value.
    line = line.replace(/^\s*[[{]\s*"?title"?\s*:\s*/i, '').replace(/[\]}]\s*$/, '');
    // "Title: …" / "Session title: …" labels.
    line = line.replace(/^\s*(?:(?:session|chat|conversation)\s+)?title\s*[:\-–—]\s*/i, '');
    // The brief forbids a "Session"/"Chat"/"Conversation" prefix.
    line = line.replace(/^\s*(?:session|chat|conversation)\b[\s:\-–—]*/i, '');
    line = stripWrappingChrome(line);
    line = line.replace(/\s+/g, ' ').trim();
    // No trailing punctuation — and no dangling dash after a cut.
    line = line.replace(/[\s.,;:!?…\-–—]+$/u, '').trim();
    line = stripWrappingChrome(line);
    if (!line || line.length > SESSION_TITLE_MAX_CHARS) return null;
    const words = line.split(' ').filter(Boolean);
    if (words.length < SESSION_TITLE_MIN_WORDS || words.length > SESSION_TITLE_MAX_WORDS) return null;
    return line;
};

/**
 * The one gate a model-generated title must pass before it may replace a
 * fallback. Pure and defensive: the first line of the answer that is itself a
 * valid title wins, and anything empty, over-long or outside the 3–6 word
 * brief returns null — a bad name must leave the good fallback alone.
 */
export const sanitizeSessionTitle = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    for (const line of raw.split(/\r?\n/)) {
        const candidate = titleFromLine(line);
        if (candidate) return candidate;
    }
    return null;
};

export const conversationTitle = (
    conversation: Conversation | null | undefined,
    fallback = 'New chat',
): string => {
    const stored = conversation?.title?.trim();
    if (stored) return stored;
    const firstUser = conversation?.messages.find(
        m => m.role === MessageRole.USER && (m.text || '').trim(),
    );
    const asked = (firstUser?.text || '').replace(/\s+/g, ' ').trim();
    if (!asked) return fallback;
    return asked.length > MAX_TITLE ? `${asked.slice(0, MAX_TITLE - 3).trimEnd()}…` : asked;
};
