/**
 * memoryHints — the deterministic pre-read, on every model.
 *
 * A plain string match of the trader's message against the memory index and the
 * skill slugs. No model call, no vector anything. On a match the harness does
 * the remembering the seat might not bother to do: it attaches the matched
 * record's own body (at most two, never a sensitive one) so the answer is
 * decided WITH the fact in front of it, and for a skill it names the slug and
 * still requires `skill_view` — a procedure body is never injected unasked.
 *
 * It runs for a strong model too, for the reason the spec gives: forgetting is
 * not a weakness only small models have. The cost is bounded by the match — a
 * message that names nothing adds zero bytes — and it happens before the first
 * token is sent, so no answer waits on it.
 *
 * Sensitive rows are excluded here, in the one place that builds the pre-read:
 * a health or finance line the trader did not raise cannot be unsaid once it is
 * in front of the model. They stay readable by explicit slug.
 */

/** Word tokens worth matching: ≥4 chars, lowercase, no digits-only. Hyphens
 *  are separators, not word characters — a slug like `user-btc-scalps` is
 *  three words, or it can never match a message that says "btc scalp". */
const tokensOf = (text: string): Set<string> =>
    new Set((text.toLowerCase().replace(/-/g, ' ').match(/[a-z][a-z0-9]{3,}/g) ?? [])
        .filter(t => !/^\d+$/.test(t))
        .map(t => t.replace(/s$/, '')));

/** A row or slug matches when EVERY significant word of its slug appears in
 *  the message, or any ≥5-char word of its description does. Slug-first keeps
 *  "my-btc-routine" from firing on every message that says "the". Trailing-s
 *  folding is crude on purpose — this is a hint, not a search engine. */
const STOP_WORDS = new Set(['user', 'feedback', 'project', 'reference', 'memory', 'note', 'the', 'and']);

const matches = (messageTokens: Set<string>, slug: string, description?: string): boolean => {
    const slugWords = [...tokensOf(slug)].filter(w => w.length >= 3 && !STOP_WORDS.has(w));
    if (slugWords.length > 0 && slugWords.every(w => messageTokens.has(w))) return true;
    const descWords = [...tokensOf(description ?? '')].filter(w => w.length >= 5);
    return descWords.some(w => messageTokens.has(w));
};

export interface MemoryHintRow {
    slug: string;
    description?: string;
    /** Extra match words (item 7's aliases). */
    aliases?: string[];
    /** Sensitive rows are NEVER pre-read — the hint can wait for an explicit
     *  ask; a leaked health or finance line in a pre-read cannot be unsaid. */
    sensitive?: boolean;
    /** The record's own body. Attached on a match, which is the whole point:
     *  the seat decides with the fact already in front of it. */
    body?: string;
}

/** Two records, each kept short: a pre-read that arrives as a paragraph is a
 *  second note the model has to read before answering the question. */
export const MEMORY_PRE_READ_MAX = 2;
export const MEMORY_PRE_READ_CHARS = 240;
export const SKILL_HINT_MAX = 2;

const clip = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * What the harness attaches to the trader's message before the turn is sent.
 * Empty array when nothing matched, which is the common case and must add zero
 * bytes.
 */
export const buildMemoryHints = (
    message: string,
    memories: readonly MemoryHintRow[],
    skillSlugs: readonly string[],
): string[] => {
    const msg = tokensOf(message);
    if (msg.size === 0) return [];
    const lines: string[] = [];
    for (const m of memories.slice(0, 60)) {
        if (lines.length >= MEMORY_PRE_READ_MAX) break;
        if (m.sensitive) continue;
        if (!matches(msg, m.slug, m.description) && !(m.aliases ?? []).some(a => matches(msg, a))) continue;
        const body = (m.body ?? '').trim();
        lines.push(body
            ? `memory you already hold — "${m.slug}": ${clip(body, MEMORY_PRE_READ_CHARS)}`
            : `read_memory "${m.slug}" before answering — the index says it may change this answer.`);
    }
    const skills: string[] = [];
    for (const slug of skillSlugs.slice(0, 60)) {
        if (skills.length >= SKILL_HINT_MAX) break;
        if (matches(msg, slug)) skills.push(`skill_view {"skill":"${slug}"} before acting — its description matches this task.`);
    }
    return [...lines, ...skills];
};
