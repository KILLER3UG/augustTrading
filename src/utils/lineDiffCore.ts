/**
 * lineDiffCore — pure, DOM-free line-by-line diff utility for Memory, Skill,
 * and Dream write receipts in `ChatWorkTimeline`.
 *
 * Zero React, DOM, `window`, `localStorage`, or network imports (`check:boundaries`).
 */

export type LineDiffKind = 'context' | 'removed' | 'added';

export interface LineDiffRow {
    kind: LineDiffKind;
    text: string;
    oldLine?: number;
    newLine?: number;
}

export interface LineDiffResult {
    lines: LineDiffRow[];
    added: number;
    removed: number;
    unchanged: number;
    hasChanges: boolean;
}

const normalizeLines = (text: string): string[] => {
    if (!text) return [];
    const normalized = text.replace(/\r\n/g, '\n');
    if (normalized === '') return [];
    return normalized.split('\n');
};

/**
 * Compute a deterministic line-by-line diff between `beforeText` and `afterText`.
 * Uses exact LCS dynamic programming up to `maxMatrixCells` (400×400) and falls
 * back to prefix/suffix trimming + block replacement for very large files so it
 * never stalls the UI thread.
 */
export const computeLineDiff = (
    beforeText: string,
    afterText: string,
    maxMatrixLines = 400,
): LineDiffResult => {
    const a = normalizeLines(beforeText);
    const b = normalizeLines(afterText);

    // Strip common leading and trailing lines first (O(N) fast path).
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start += 1;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }

    const lines: LineDiffRow[] = [];
    for (let i = 0; i < start; i += 1) {
        lines.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: i + 1 });
    }

    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);

    if (midA.length === 0 && midB.length === 0) {
        // Identical inputs
    } else if (midA.length === 0) {
        for (let j = 0; j < midB.length; j += 1) {
            lines.push({ kind: 'added', text: midB[j], newLine: start + j + 1 });
        }
    } else if (midB.length === 0) {
        for (let i = 0; i < midA.length; i += 1) {
            lines.push({ kind: 'removed', text: midA[i], oldLine: start + i + 1 });
        }
    } else if (midA.length <= maxMatrixLines && midB.length <= maxMatrixLines) {
        const m = midA.length;
        const n = midB.length;
        const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
        for (let i = m - 1; i >= 0; i -= 1) {
            for (let j = n - 1; j >= 0; j -= 1) {
                if (midA[i] === midB[j]) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
                }
            }
        }
        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (midA[i] === midB[j]) {
                lines.push({ kind: 'context', text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
                i += 1;
                j += 1;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                lines.push({ kind: 'removed', text: midA[i], oldLine: start + i + 1 });
                i += 1;
            } else {
                lines.push({ kind: 'added', text: midB[j], newLine: start + j + 1 });
                j += 1;
            }
        }
        while (i < m) {
            lines.push({ kind: 'removed', text: midA[i], oldLine: start + i + 1 });
            i += 1;
        }
        while (j < n) {
            lines.push({ kind: 'added', text: midB[j], newLine: start + j + 1 });
            j += 1;
        }
    } else {
        for (let i = 0; i < midA.length; i += 1) {
            lines.push({ kind: 'removed', text: midA[i], oldLine: start + i + 1 });
        }
        for (let j = 0; j < midB.length; j += 1) {
            lines.push({ kind: 'added', text: midB[j], newLine: start + j + 1 });
        }
    }

    for (let k = 0; k < a.length - endA; k += 1) {
        lines.push({
            kind: 'context',
            text: a[endA + k],
            oldLine: endA + k + 1,
            newLine: endB + k + 1,
        });
    }

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    for (const row of lines) {
        if (row.kind === 'added') added += 1;
        else if (row.kind === 'removed') removed += 1;
        else unchanged += 1;
    }

    return {
        lines,
        added,
        removed,
        unchanged,
        hasChanges: added > 0 || removed > 0,
    };
};

/**
 * Extract `{ before, after }` text pairs from a stored Memory, Skill, or Dream
 * write receipt so `WriteReceiptRows` can display a clean line diff.
 */
export const extractReceiptBeforeAfter = (
    kind: 'memory' | 'skill' | 'skill_manage' | 'memory_dream',
    receipt: unknown,
): { before: string; after: string } | null => {
    if (!receipt || typeof receipt !== 'object') return null;
    const r = receipt as Record<string, unknown>;

    if (kind === 'memory') {
        const before = typeof r.undoSnapshot === 'string' ? r.undoSnapshot : '';
        const after = typeof r.afterText === 'string'
            ? r.afterText
            : typeof r.content === 'string'
                ? (r.action === 'add' && before ? `${before.trimEnd()}\n${r.content}` : r.content)
                : typeof r.rejectedContent === 'string'
                    ? (before ? `${before.trimEnd()}\n${r.rejectedContent}` : r.rejectedContent)
                    : '';
        if (!before && !after) return null;
        return { before, after };
    }

    if (kind === 'skill' || kind === 'skill_manage') {
        const undoSkill = r.undoSkill && typeof r.undoSkill === 'object'
            ? (r.undoSkill as Record<string, unknown>)
            : null;
        const before = typeof undoSkill?.previousBody === 'string'
            ? undoSkill.previousBody
            : typeof r.beforeBody === 'string'
                ? r.beforeBody
                : '';
        const after = typeof r.afterBody === 'string'
            ? r.afterBody
            : typeof r.rejectedContent === 'string'
                ? r.rejectedContent
                : typeof r.body === 'string'
                    ? r.body
                    : '';
        if (!before && !after) return null;
        return { before, after };
    }

    if (kind === 'memory_dream') {
        const undoDream = r.undoDream && typeof r.undoDream === 'object'
            ? (r.undoDream as Record<string, unknown>)
            : null;
        const beforeParts: string[] = [];
        const afterParts: string[] = [];
        if (typeof undoDream?.userSnapshot === 'string') beforeParts.push(`# USER.md\n${undoDream.userSnapshot}`);
        if (typeof undoDream?.memorySnapshot === 'string') beforeParts.push(`# MEMORY.md\n${undoDream.memorySnapshot}`);
        if (typeof r.afterUser === 'string') afterParts.push(`# USER.md\n${r.afterUser}`);
        if (typeof r.afterMemory === 'string') afterParts.push(`# MEMORY.md\n${r.afterMemory}`);
        if (afterParts.length === 0 && typeof r.summary === 'string') {
            afterParts.push(r.summary);
        }
        const before = beforeParts.join('\n\n');
        const after = afterParts.join('\n\n');
        if (!before && !after) return null;
        return { before, after };
    }

    return null;
};
