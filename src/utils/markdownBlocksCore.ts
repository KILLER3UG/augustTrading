/**
 * markdownBlocksCore — pure, O(N) markdown block splitter and fade-chunk
 * accumulator for smooth zero-jank streaming rendering.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, storage, or network imports
 * (`check:boundaries` enforces this).
 */

export interface MarkdownBlocksSplit {
    /** Completed top-level markdown blocks terminated cleanly outside any open fence/table. */
    stableBlocks: string[];
    /** Currently growing trailing block (may be empty if the input ends on a blank line). */
    activeTail: string;
}

export interface StreamFadeChunk {
    /** Stable key for React reconciliation (`0` = merged settled prefix). */
    id: number;
    /** Text slice for this chunk. */
    text: string;
    /** Timestamp (ms) when this chunk window opened. */
    createdAt: number;
}

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const BLOCK_SYNTAX_RE = /(?:^|\n)[ \t]{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|~~~|\|)/;
const INLINE_SYNTAX_RE = /[*_`[\]\\<$]/;

const isClosingFenceLine = (line: string, char: string, minLen: number): boolean => {
    const trimmed = line.trim();
    if (trimmed.length < minLen) return false;
    for (let i = 0; i < trimmed.length; i += 1) {
        if (trimmed[i] !== char) return false;
    }
    return true;
};

const isListLine = (line: string): boolean => {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
    if (i >= line.length) return false;
    const ch = line[i];
    if ((ch === '-' || ch === '*' || ch === '+') && line[i + 1] === ' ') return true;
    if (ch >= '0' && ch <= '9') {
        let j = i;
        while (j < line.length && line[j] >= '0' && line[j] <= '9') j += 1;
        if (j > i && (line[j] === '.' || line[j] === ')') && line[j + 1] === ' ') return true;
    }
    return false;
};

const isBlockquoteLine = (line: string): boolean => {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
    return line[i] === '>';
};

const isTableLine = (line: string): boolean => {
    const t = line.trim();
    return t.length > 0 && t.includes('|');
};

/**
 * Split a growing markdown stream into completed top-level `stableBlocks` and
 * the currently-streaming `activeTail` in a single O(N) pass:
 * - Unclosed fenced code blocks (` ``` ` / `~~~`) stay whole inside `activeTail`.
 * - Markdown tables, multi-item lists, and blockquotes stay intact until
 *   terminated by a blank line outside a fence (and loose lists/blockquotes
 *   only split when the next block is NOT a continuation of the same construct).
 */
export const splitStableMarkdownBlocks = (markdown: string): MarkdownBlocksSplit => {
    if (!markdown) return { stableBlocks: [], activeTail: '' };

    const lines = markdown.split('\n');
    const stableBlocks: string[] = [];
    let current: string[] = [];
    let fence: { char: string; len: number } | null = null;
    let inTable = false;

    for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const trimmed = line.trim();

        if (fence) {
            current.push(line);
            if (isClosingFenceLine(line, fence.char, fence.len)) {
                fence = null;
            }
            continue;
        }

        const fenceMatch = FENCE_OPEN_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            // If we were accumulating a plain paragraph/table and a code fence starts
            // immediately without a blank line, flush the prior block first.
            if (current.length > 0) {
                stableBlocks.push(current.join('\n'));
                current = [];
                inTable = false;
            }
            fence = { char: marker[0], len: marker.length };
            current.push(line);
            continue;
        }

        if (trimmed === '') {
            if (current.length === 0) continue;

            // Look ahead to the next non-blank line so loose lists or multi-paragraph
            // blockquotes stay coherent instead of fracturing mid-construct.
            let nextIdx = idx + 1;
            while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx += 1;
            const nextLine = nextIdx < lines.length ? lines[nextIdx] : null;
            const lastLine = current[current.length - 1];

            if (nextLine !== null) {
                const keepListTogether = isListLine(lastLine) && isListLine(nextLine);
                const keepQuoteTogether = isBlockquoteLine(lastLine) && isBlockquoteLine(nextLine);
                if (keepListTogether || keepQuoteTogether) {
                    current.push(line);
                    continue;
                }
            }

            // A blank line terminates the current block (paragraph, table, list, quote, or closed fence).
            stableBlocks.push(current.join('\n'));
            current = [];
            inTable = false;
            continue;
        }

        if (inTable && !isTableLine(line)) {
            // Table ended cleanly on a non-table line without an intervening blank line.
            stableBlocks.push(current.join('\n'));
            current = [line];
            inTable = false;
            continue;
        }

        if (current.length === 0 && isTableLine(line)) {
            inTable = true;
        }
        current.push(line);
    }

    return {
        stableBlocks,
        activeTail: current.join('\n'),
    };
};

/**
 * True when the growing trailing block is plain narrative prose with no
 * markdown block or inline syntax that requires ReactMarkdown parsing yet.
 */
export const canRenderPlainStreamingProse = (block: string): boolean => {
    if (!block) return false;
    return !BLOCK_SYNTAX_RE.test(block) && !INLINE_SYNTAX_RE.test(block);
};

/**
 * Incrementally append newly arrived trailing text slices into bounded fade
 * chunks coalesced by `windowMs` (default 60ms).
 *
 * - Never re-animates previously settled characters (stable chunk `id`s).
 * - Caps total chunks to `maxChunks` (default 8) by folding overflow into the
 *   settled prefix chunk (`id: 0`) so DOM node count stays tiny.
 * - Resets cleanly if `fullText` shrinks or diverges (new turn / block reset).
 */
export const appendStreamChunk = (
    chunks: readonly StreamFadeChunk[],
    fullText: string,
    nowMs: number,
    windowMs = 60,
    maxChunks = 8,
): StreamFadeChunk[] => {
    if (!fullText) return [];

    const cap = Math.max(2, maxChunks);
    const prevJoined = chunks.length === 0 ? '' : chunks.map(c => c.text).join('');

    if (fullText === prevJoined) {
        return chunks as StreamFadeChunk[];
    }

    if (chunks.length === 0 || !fullText.startsWith(prevJoined)) {
        const nextId = chunks.length > 0 ? Math.max(1, chunks[chunks.length - 1].id + 1) : 1;
        return [{ id: nextId, text: fullText, createdAt: nowMs }];
    }

    const delta = fullText.slice(prevJoined.length);
    if (!delta) return chunks as StreamFadeChunk[];

    const out = chunks.slice();
    const last = out[out.length - 1];

    // Coalesce deltas arriving inside the same time window onto the newest fade
    // chunk (never merge into the settled id=0 prefix bucket).
    if (last && last.id !== 0 && nowMs - last.createdAt < windowMs) {
        out[out.length - 1] = {
            id: last.id,
            text: last.text + delta,
            createdAt: last.createdAt,
        };
        return out;
    }

    const nextId = Math.max(1, (last?.id ?? 0) + 1);
    out.push({ id: nextId, text: delta, createdAt: nowMs });

    // Bound DOM nodes by folding oldest overflow chunks into settled prefix (id = 0).
    if (out.length > cap) {
        const overflowCount = out.length - cap;
        let folded = '';
        let firstCreated = out[0].createdAt;
        if (out[0].id === 0) {
            folded = out[0].text;
            for (let i = 1; i <= overflowCount; i += 1) {
                folded += out[i].text;
            }
            return [{ id: 0, text: folded, createdAt: firstCreated }, ...out.slice(overflowCount + 1)];
        }
        firstCreated = out[0].createdAt;
        for (let i = 0; i <= overflowCount; i += 1) {
            folded += out[i].text;
        }
        return [{ id: 0, text: folded, createdAt: firstCreated }, ...out.slice(overflowCount + 1)];
    }

    return out;
};
