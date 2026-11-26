/**
 * compactCore — deterministic in-place `/compact [focus]` compressor.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, `localStorage`, or network
 * imports (`check:boundaries` enforces this). Compresses older conversation
 * entries into one structured `[COMPACTED CONTEXT]` checkpoint while preserving
 * key levels, drawings, open paper positions, armed watches, and the latest
 * `keepRecentTurns` user turns verbatim.
 */

import { estimateTokens } from '../../utils/tokenEstimate';

export interface CompactEntryInput {
    id: string;
    role: 'user' | 'ai';
    text: string;
    tools?: string[];
    toolIds?: string[];
    at?: number;
    speaker?: string;
    notice?: boolean;
}

export interface CompactDrawingInput {
    shortId?: string;
    id?: string;
    label?: string;
    kind?: string;
    points?: Array<{ p?: number; price?: number }>;
}

export interface CompactPositionInput {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    stopLoss?: number;
    qty?: number;
    leverage?: number;
    riskUsd?: number;
}

export interface CompactWatchInput {
    symbol: string;
    label?: string;
    price?: number;
    direction?: string;
    planId?: string;
}

export interface CompactReceiptSnapshot {
    kind: 'compact';
    compacted: boolean;
    compactedCount: number;
    keptCount: number;
    beforeTokens: number;
    afterTokens: number;
    savedPct: number;
    focus?: string;
    reason?: string;
    generatedAt: string;
    undoId?: string;
}

export interface CompactConversationInput<T extends CompactEntryInput> {
    entries: readonly T[];
    keepRecentTurns?: number;
    focus?: string;
    activeSymbol?: string;
    activeInterval?: string;
    pinnedDrawings?: readonly CompactDrawingInput[];
    openPaperPositions?: readonly CompactPositionInput[];
    armedWatches?: readonly CompactWatchInput[];
    toolPayloadLookup?: (toolId: string) => string | null;
    nowIso?: string;
}

export interface CompactConversationResult<T extends CompactEntryInput> {
    compacted: boolean;
    reason?: string;
    checkpointText: string;
    compactedCount: number;
    keptCount: number;
    beforeTokens: number;
    afterTokens: number;
    savedPct: number;
    retainedEntries: T[];
    receipt: CompactReceiptSnapshot;
}

const MAX_SNIPPET_CHARS = 160;
const MAX_KEY_LEVELS = 8;

const clipLine = (raw: string, maxChars = MAX_SNIPPET_CHARS): string => {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
};

/** Measure entry tokens using the exact same text + toolPayload accounting as `collectContextDiagnostic`. */
export const measureEntriesTokens = (
    entries: readonly CompactEntryInput[],
    toolPayloadLookup?: (toolId: string) => string | null,
): number => {
    let total = 0;
    for (const e of entries) {
        if (e.text?.trim()) total += estimateTokens(e.text);
        if (Array.isArray(e.tools)) {
            for (let i = 0; i < e.tools.length; i += 1) {
                const line = e.tools[i];
                const tid = e.toolIds?.[i];
                const stored = tid && toolPayloadLookup ? toolPayloadLookup(tid) : null;
                if (stored) total += estimateTokens(stored);
                else if (line) total += estimateTokens(line);
            }
        }
    }
    return total;
};

const LEVEL_CONTEXT_RE = /(?:entry|stop|sl|tp\d*|target|support|resistance|sweep|invalidation|reclaim|high|low|level|@#?D\d+)\s*[:=@]?\s*(\$?[\d,]+(?:\.\d+)?)/gi;
const DRAWING_REF_RE = /#D\d+/g;

const extractKeyLevels = (entries: readonly CompactEntryInput[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (val: string): void => {
        const clean = val.trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        out.push(clean);
    };
    for (const e of entries) {
        if (!e.text) continue;
        for (const d of e.text.match(DRAWING_REF_RE) ?? []) {
            push(d);
            if (out.length >= MAX_KEY_LEVELS) return out;
        }
        let m: RegExpExecArray | null;
        LEVEL_CONTEXT_RE.lastIndex = 0;
        while ((m = LEVEL_CONTEXT_RE.exec(e.text)) !== null) {
            push(clipLine(m[0], 42));
            if (out.length >= MAX_KEY_LEVELS) return out;
        }
    }
    return out;
};

const findKeepCutIndex = (entries: readonly CompactEntryInput[], keepRecentTurns: number): number => {
    if (entries.length === 0) return 0;
    let userCount = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].role === 'user') {
            userCount += 1;
            if (userCount === keepRecentTurns) {
                return i;
            }
        }
    }
    // Thread lacks enough explicit user turns: keep up to 2 * keepRecentTurns entries at tail.
    const fallbackCut = Math.max(0, entries.length - keepRecentTurns * 2);
    return fallbackCut;
};

const formatDrawingsSummary = (drawings: readonly CompactDrawingInput[] | undefined): string => {
    if (!drawings || drawings.length === 0) return '(none)';
    return drawings.slice(0, 6).map(d => {
        const ref = d.shortId ?? d.id ?? 'drawing';
        const px = d.points?.[0]?.p ?? d.points?.[0]?.price;
        const pxText = typeof px === 'number' && Number.isFinite(px) ? ` @ ${px}` : '';
        return `${ref}${d.label ? ` ${clipLine(d.label, 36)}` : d.kind ? ` ${d.kind}` : ''}${pxText}`;
    }).join(' | ');
};

const formatPositionsSummary = (positions: readonly CompactPositionInput[] | undefined): string => {
    if (!positions || positions.length === 0) return '(none)';
    return positions.slice(0, 6).map(p => {
        const sl = typeof p.stopLoss === 'number' && Number.isFinite(p.stopLoss) ? ` SL ${p.stopLoss}` : '';
        const lev = typeof p.leverage === 'number' && Number.isFinite(p.leverage) ? ` (${p.leverage}x)` : '';
        return `${p.symbol} ${p.side.toUpperCase()} @ ${p.entryPrice}${sl}${lev}`;
    }).join(' | ');
};

const formatWatchesSummary = (watches: readonly CompactWatchInput[] | undefined): string => {
    if (!watches || watches.length === 0) return '(none)';
    return watches.slice(0, 6).map(w => {
        const px = typeof w.price === 'number' && Number.isFinite(w.price) ? ` @ ${w.price}` : '';
        const tag = w.label ? clipLine(w.label, 32) : w.planId ? w.planId : 'watch';
        return `${w.symbol}${w.direction ? ` ${w.direction}` : ''}${px} (${tag})`;
    }).join(' | ');
};

/**
 * Deterministically compact older conversation entries into a single
 * `[COMPACTED CONTEXT]` checkpoint while keeping the latest `keepRecentTurns`
 * verbatim. Returns a clean no-op when no older turns exist.
 */
export const compactConversationEntries = <T extends CompactEntryInput>(
    input: CompactConversationInput<T>,
): CompactConversationResult<T> => {
    const entries = input.entries ?? [];
    const keepRecentTurns = Math.max(1, Math.floor(input.keepRecentTurns ?? 2));
    const focus = input.focus?.trim() ? clipLine(input.focus.trim(), 120) : undefined;
    const nowIso = input.nowIso ?? new Date().toISOString();

    const beforeTokens = measureEntriesTokens(entries, input.toolPayloadLookup);
    const cut = findKeepCutIndex(entries, keepRecentTurns);

    if (cut <= 0) {
        const reason = 'Nothing older to compact — thread has too few turns.';
        return {
            compacted: false,
            reason,
            checkpointText: '',
            compactedCount: 0,
            keptCount: entries.length,
            beforeTokens,
            afterTokens: beforeTokens,
            savedPct: 0,
            retainedEntries: [...entries],
            receipt: {
                kind: 'compact',
                compacted: false,
                compactedCount: 0,
                keptCount: entries.length,
                beforeTokens,
                afterTokens: beforeTokens,
                savedPct: 0,
                ...(focus ? { focus } : {}),
                reason,
                generatedAt: nowIso,
            },
        };
    }

    const olderEntries = entries.slice(0, cut);
    const retainedEntries = entries.slice(cut);

    const lastUserInOlder = [...olderEntries]
        .reverse()
        .find(e => e.role === 'user' && e.text.trim() && !e.text.trim().startsWith('/'));
    const lastAiInOlder = [...olderEntries]
        .reverse()
        .find(e => e.role === 'ai' && !e.notice && e.text.trim());

    const thesisParts: string[] = [];
    if (focus) thesisParts.push(focus);
    if (lastUserInOlder) thesisParts.push(`Prior ask: ${clipLine(lastUserInOlder.text, 140)}`);
    if (lastAiInOlder) thesisParts.push(`Prior read: ${clipLine(lastAiInOlder.text, 180)}`);
    const thesisLine = thesisParts.length > 0 ? thesisParts.join(' · ') : `${olderEntries.length} earlier entry(s) summarized`;

    const keyLevels = extractKeyLevels(olderEntries);
    const symHead = input.activeSymbol ? `${input.activeSymbol}${input.activeInterval ? ` ${input.activeInterval}` : ''}` : 'DESK';

    const lines = [
        `[COMPACTED CONTEXT · ${symHead}${focus ? ` · Focus: ${focus}` : ''}]`,
        `- Thesis / Focus: ${thesisLine}`,
        `- Key Levels: ${keyLevels.length > 0 ? keyLevels.join(', ') : '(none cited)'}`,
        `- Pinned Drawings: ${formatDrawingsSummary(input.pinnedDrawings)}`,
        `- Open Paper Positions: ${formatPositionsSummary(input.openPaperPositions)}`,
        `- Armed Watches: ${formatWatchesSummary(input.armedWatches)}`,
    ];
    const checkpointText = lines.join('\n');

    const afterTokens = estimateTokens(checkpointText) + measureEntriesTokens(retainedEntries, input.toolPayloadLookup);
    const savedPct = beforeTokens > 0
        ? Math.max(0, Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100))
        : 0;

    return {
        compacted: true,
        checkpointText,
        compactedCount: olderEntries.length,
        keptCount: retainedEntries.length,
        beforeTokens,
        afterTokens,
        savedPct,
        retainedEntries,
        receipt: {
            kind: 'compact',
            compacted: true,
            compactedCount: olderEntries.length,
            keptCount: retainedEntries.length,
            beforeTokens,
            afterTokens,
            savedPct,
            ...(focus ? { focus } : {}),
            generatedAt: nowIso,
        },
    };
};
