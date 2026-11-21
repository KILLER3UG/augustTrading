/**
 * streamBlocks — pure helpers for progressive markdown streaming without
 * flickering settled blocks or breaking code fences / tables mid-chunk.
 */

export interface StreamBlockSplit {
    /** Complete top-level blocks terminated by a blank line outside a fence. */
    committed: string[];
    /** Currently growing trailing block (may be empty). */
    active: string;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Split streamed markdown into committed top-level blocks + the currently
 * growing trailing block. Blank lines inside open fenced code blocks (` ``` ` /
 * `~~~`) never split prematurely so code blocks stream as one coherent unit.
 */
export const splitStableMarkdownBlocks = (text: string): StreamBlockSplit => {
    if (!text) return { committed: [], active: '' };
    const lines = text.split('\n');
    const committed: string[] = [];
    let current: string[] = [];
    let fence: { char: string; len: number } | null = null;

    for (const line of lines) {
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!fence) {
                fence = { char: marker[0], len: marker.length };
            } else if (marker[0] === fence.char && marker.length >= fence.len && line.trim() === marker) {
                fence = null;
            }
        }
        if (!fence && line.trim() === '') {
            if (current.length > 0) {
                committed.push(current.join('\n'));
                current = [];
            }
            continue;
        }
        current.push(line);
    }

    return {
        committed,
        active: current.join('\n'),
    };
};

const BLOCK_SYNTAX_RE = /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|```|~~~|\|)/;
const INLINE_SYNTAX_RE = /[*_`[\]\\<$]/;

/**
 * True when the growing trailing block is plain narrative prose with no
 * markdown block or inline markup that needs ReactMarkdown parsing yet.
 */
export const canRenderPlainStreamingProse = (block: string): boolean => {
    if (!block) return false;
    return !BLOCK_SYNTAX_RE.test(block) && !INLINE_SYNTAX_RE.test(block);
};
