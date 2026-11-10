/**
 * textOverlap — the one token-overlap vocabulary.
 *
 * Two refusal rules in this app are built on "is everything this says already
 * said there?": the skill redundancy scan (`SkillFileService.nearDuplicates`)
 * and the memory similarity check on create. They must ask the same question
 * with the same stopwords, or the same text is a duplicate in one store and a
 * brand-new fact in the other.
 *
 * `overlap` is deliberately NOT Jaccard. Plain Jaccard divides by the UNION, so
 * a short trigger that names exactly what a longer description already covers
 * scores low and passes — the reworded duplicate the rule promises to catch.
 * `shared / min(|a|, |b|)` asks the question the refusal is actually built on.
 */

/** Words every sentence carries: left in, a library of "use this whenever…"
 *  boilerplate looks mutually similar and the real signal is diluted. The
 *  skill-scaffolding words ride along for the same reason. */
const STOPWORDS = new Set([
    'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
    'at', 'be', 'been', 'before', 'being', 'but', 'by', 'can', 'could', 'did',
    'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'how', 'i', 'if',
    'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'once', 'only', 'or',
    'should', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'these',
    'this', 'to', 'was', 'were', 'when', 'where', 'which', 'while', 'who',
    'will', 'with', 'would', 'you', 'your',
    'use', 'used', 'uses', 'using', 'skill', 'skills', 'note', 'notes',
]);

export const contentWords = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of (text || '').toLowerCase().split(/[^a-z0-9%$.-]+/)) {
        const word = raw.replace(/^[.-]+|[.-]+$/g, '');
        if (word.length >= 2 && !STOPWORDS.has(word)) out.add(word);
    }
    return out;
};

export const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    const union = a.size + b.size - shared;
    return union === 0 ? 0 : shared / union;
};

/** Containment in EITHER direction: shared / min(|a|, |b|). */
export const overlap = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared / Math.min(a.size, b.size);
};
