/**
 * memoryInjectionDedup — the ONE sentence-level dedup for prompt injection
 * seams (O-39).
 *
 * Skills, `rules/risk-rules.md`, `rules/recurring-mistakes.md` and the diary
 * are written independently and routinely phrase the same rule twice — the
 * notebook's own writer files can carry the same sentence in a skill body and
 * a rule bullet, and BOTH injection seams (the notebook slice in
 * `MemoryRetrievalService › getMemoryFilesContext` and the seat prompt's
 * skills+rules join in `services/trade/chatSurfaceTurn › surfacePromptWith`)
 * used to push both copies. A repeated rule is not emphasis; it burns budget
 * and teaches the model nothing.
 *
 * Line-level equality is not enough: the two sites reword. The match is
 * CONTENT-WORD SIMILARITY over whole sentences — jaccard OR containment (the
 * superset restatement: same rule, added padding) — and a sentence is matched
 * on BOTH its full words and its words without a POINTER PREFIX, because the
 * seams lead their lines with an address (`[skills/slug]`, `slug:`) whose
 * words would otherwise dilute the comparison. Short and structural lines
 * (headers, bullets under the word floor) are always kept — a
 * `[rules/risk-rules.md]` header must never be eaten because an earlier block
 * said something similar.
 *
 * Pure, so both seams and `check:contracts` read the same function.
 */

/** Below this many content words a sentence is structural — never dropped,
 *  never used as a drop precedent (a 3-word "stop for the day" would
 *  otherwise silence a longer sentence carrying the same words). */
const SENTENCE_WORD_FLOOR = 5;

/** Content-word jaccard at (or above) which two sentences count as the same
 *  rule phrased twice, and the CONTAINMENT alternative (shared words over the
 *  smaller sentence) for the superset rewording. "Never risk more than 1% per
 *  trade" vs "Never risk more than 1% of the account on one trade" is jaccard
 *  0.625 but containment 0.83 — the same rule, stated with padding. "Risk 1%
 *  per trade and stop after two losses" survives both (containment 0.5): a
 *  compound rule is a different rule. */
const SENTENCE_JACCARD_DROP = 0.7;
const SENTENCE_CONTAINMENT_DROP = 0.75;

export const contentWordSet = (text: string): Set<string> =>
    new Set(text.toLowerCase().split(/[^a-z0-9%]+/).filter(w => w.length > 2));

export const jaccardSets = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter += 1;
    return inter / (a.size + b.size - inter);
};

const splitSentences = (line: string): string[] =>
    line.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/)
        .map(s => s.trim())
        .filter(Boolean);

const isSubstantive = (words: Set<string>): boolean => words.size >= SENTENCE_WORD_FLOOR;

/** The match rule: near-equal phrasing (jaccard) OR a superset restatement
 *  (containment) of something already injected. */
const repeatsSeen = (words: Set<string>, seen: readonly Set<string>[]): boolean =>
    seen.some(s => {
        if (s.size === 0 || words.size === 0) return false;
        let inter = 0;
        for (const w of words) if (s.has(w)) inter += 1;
        const union = words.size + s.size - inter;
        return inter / union >= SENTENCE_JACCARD_DROP || inter / Math.min(words.size, s.size) >= SENTENCE_CONTAINMENT_DROP;
    });

/** Pointer prefixes the seams put IN FRONT of content: the retrieval lines
 *  open with `[skills/slug]`, the seat-prompt index with `slug:`. The prefix
 *  is an ADDRESS, not rule content — counting its words dilutes the match
 *  ("breakout-retest: Never risk more than 1%" vs the bare rule was 0.71
 *  containment, under the bar). Sentences are matched on BOTH the full and
 *  the prefix-stripped word set; the kept text is never altered. */
const POINTER_PREFIX_RE = /^(?:\[[^\]]+\]\s*|[a-z0-9-]{2,}:\s*)/i;

const sentenceWordSets = (sentence: string): { full: Set<string>; stripped: Set<string> } => ({
    full: contentWordSet(sentence),
    stripped: contentWordSet(sentence.replace(POINTER_PREFIX_RE, '')),
});

/** One shared seen-set, fed lines in injection order. `feed` returns the text
 *  that survives (the whole line, its kept sentences, or null when the line
 *  was a repeat). A partially-dropped line re-joins on single spaces. */
const createSentenceDeduper = () => {
    const seen: Set<string>[] = [];
    let droppedSentences = 0;
    const feed = (line: string): string | null => {
        const sentences = splitSentences(line);
        if (sentences.length <= 1) {
            const { full, stripped } = sentenceWordSets(line);
            const substantive = isSubstantive(full) || isSubstantive(stripped);
            if (substantive && (repeatsSeen(full, seen) || repeatsSeen(stripped, seen))) {
                droppedSentences += 1;
                return null;
            }
            if (isSubstantive(full)) seen.push(full);
            if (isSubstantive(stripped) && stripped !== full) seen.push(stripped);
            return line;
        }
        const keptSentences: string[] = [];
        for (const sentence of sentences) {
            const { full, stripped } = sentenceWordSets(sentence);
            const substantive = isSubstantive(full) || isSubstantive(stripped);
            if (!substantive) {
                keptSentences.push(sentence);
                continue;
            }
            if (repeatsSeen(full, seen) || repeatsSeen(stripped, seen)) {
                droppedSentences += 1;
                continue;
            }
            if (isSubstantive(full)) seen.push(full);
            if (isSubstantive(stripped) && stripped !== full) seen.push(stripped);
            keptSentences.push(sentence);
        }
        // Every substantive sentence repeated ⇒ the line is a repeat; drop it
        // whole. A line with only structural pieces left keeps them.
        return keptSentences.length > 0 ? keptSentences.join(' ') : null;
    };
    return { feed, dropped: () => droppedSentences };
};

/**
 * Drop lines whose sentences an EARLIER line already injected, at sentence
 * granularity. Returns the kept lines in order; `droppedSentences` reports
 * how many repeated sentences were removed, so a caller can count what the
 * dedup bought.
 */
export const dedupeInjectionLines = (
    lines: readonly string[],
): { lines: string[]; droppedSentences: number } => {
    const deduper = createSentenceDeduper();
    const kept: string[] = [];
    for (const line of lines) {
        const keptLine = deduper.feed(line);
        if (keptLine !== null) kept.push(keptLine);
    }
    return { lines: kept, droppedSentences: deduper.dropped() };
};

/**
 * Cross-block dedup for the injection seams: sections in, sections out —
 * ONE seen-set across all of them, in order, so a rule line in the second
 * section that repeats the first is dropped THERE. A section that loses
 * everything substantive is dropped whole; empty input sections disappear
 * (the joiners downstream already filter falsy).
 */
export const dedupeInjectionBlocks = (sections: readonly string[]): { blocks: string[]; droppedSentences: number } => {
    const deduper = createSentenceDeduper();
    const blocks: string[] = [];
    for (const section of sections) {
        if (!section?.trim()) continue;
        const kept = section.split('\n')
            .map(l => deduper.feed(l))
            .filter((l): l is string => l !== null);
        const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text) blocks.push(text);
    }
    return { blocks, droppedSentences: deduper.dropped() };
};
