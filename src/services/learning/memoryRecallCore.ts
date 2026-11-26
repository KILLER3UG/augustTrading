/**
 * memoryRecallCore — pure deterministic pre-turn memory recall.
 *
 * Scores and selects the top N (default 3) relevant entries from MEMORY.md
 * and non-sensitive profileMemory entries against the active symbol, UTC
 * session, and market regime. Zero LLM calls, zero network, zero DOM/storage.
 */

export interface MemoryRecallProfileEntry {
    slug: string;
    title?: string;
    description: string;
    body: string;
    updatedAt?: string;
    sensitive?: boolean;
    aliases?: readonly string[];
    deletedAt?: string;
    invalidatedAt?: string;
}

export interface PreTurnMemoryRecallInput {
    symbol?: string | null;
    session?: string | null;
    regime?: string | null;
    memoryMd?: string | null;
    profileEntries?: readonly MemoryRecallProfileEntry[] | null;
    maxItems?: number;
}

export interface RecalledMemoryItem {
    id: string;
    source: 'memory_md' | 'profile';
    score: number;
    matchedTerms: string[];
    text: string;
    updatedAt: string;
}

export interface PreTurnMemoryRecallResult {
    items: RecalledMemoryItem[];
    promptTailBlock: string;
}

const ENTRY_HEAD_RE = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*$/;
const AUTOPSY_CUE_RE = /\b(?:autopsy|leak|cooldown|giveback|stop-out|revenge|rule|avoid|never)\b/i;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsWordOrToken = (haystackLower: string, needleLower: string): boolean => {
    if (!needleLower) return false;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(needleLower)}([^a-z0-9]|$)`, 'i');
    return re.test(haystackLower);
};

const normalizeSymbolTokens = (raw: string | null | undefined): string[] => {
    if (typeof raw !== 'string') return [];
    const upper = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return [];
    const tokens = [upper.toLowerCase()];
    for (const suffix of ['USDT', 'USDC', 'BUSD', 'PERP']) {
        if (upper.length > suffix.length && upper.endsWith(suffix)) {
            tokens.push(upper.slice(0, -suffix.length).toLowerCase());
        }
    }
    return [...new Set(tokens)].filter(t => t.length >= 2);
};

const normalizeSessionTokens = (raw: string | null | undefined): string[] => {
    if (typeof raw !== 'string') return [];
    const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (!s) return [];
    if (s === 'newyork' || s === 'ny') return ['newyork', 'new york', 'ny'];
    if (s === 'london') return ['london'];
    if (s === 'asia') return ['asia'];
    if (s === 'late') return ['late'];
    return [raw.trim().toLowerCase()];
};

const normalizeRegimeTokens = (raw: string | null | undefined): string[] => {
    if (typeof raw !== 'string') return [];
    const head = raw.trim().toLowerCase().split(':')[0]?.trim() ?? '';
    if (!head) return [];
    if (head === 'range' || head === 'ranging') return ['range', 'ranging', 'chop'];
    if (head === 'chop' || head === 'choppy') return ['chop', 'choppy', 'range'];
    if (head === 'trend' || head === 'trending') return ['trend', 'trending'];
    if (head === 'bull' || head === 'bullish') return ['bull', 'bullish', 'uptrend'];
    if (head === 'bear' || head === 'bearish') return ['bear', 'bearish', 'downtrend'];
    return [head];
};

const parseMemoryMdBlocks = (memoryMd: string): Array<{ id: string; day: string; body: string }> => {
    const raw = (memoryMd || '').trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const blocks: Array<{ day: string; body: string }> = [];
    let current: { day: string; body: string } | null = null;
    for (const line of lines) {
        const m = ENTRY_HEAD_RE.exec(line.trim());
        if (m) {
            current = { day: m[1], body: '' };
            blocks.push(current);
            continue;
        }
        if (!current) {
            if (!line.trim()) continue;
            current = { day: '', body: '' };
            blocks.push(current);
        }
        current.body += (current.body ? '\n' : '') + line;
    }
    return blocks
        .map((b, i) => ({ id: `memory:${b.day || 'preamble'}:${i}`, day: b.day, body: b.body.trim() }))
        .filter(b => b.body.length > 0);
};

const clipSnippet = (text: string, maxLen = 220): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= maxLen) return flat;
    return `${flat.slice(0, maxLen - 1).trimEnd()}…`;
};

/**
 * Select up to `maxItems` (default 3) context-matched memory notes from
 * `MEMORY.md` and `profileEntries` deterministically with zero LLM calls.
 */
export const selectPreTurnMemories = (
    input: PreTurnMemoryRecallInput,
): PreTurnMemoryRecallResult => {
    const maxItems = Math.max(0, Math.min(8, input.maxItems ?? 3));
    if (maxItems === 0) return { items: [], promptTailBlock: '' };

    const symTokens = normalizeSymbolTokens(input.symbol);
    const sesTokens = normalizeSessionTokens(input.session);
    const regTokens = normalizeRegimeTokens(input.regime);
    if (symTokens.length === 0 && sesTokens.length === 0 && regTokens.length === 0) {
        return { items: [], promptTailBlock: '' };
    }

    const candidates: Array<{
        id: string;
        source: 'memory_md' | 'profile';
        searchText: string;
        displayText: string;
        updatedAt: string;
    }> = [];

    for (const block of parseMemoryMdBlocks(input.memoryMd ?? '')) {
        candidates.push({
            id: block.id,
            source: 'memory_md',
            searchText: block.body,
            displayText: block.day ? `[${block.day}] ${clipSnippet(block.body)}` : clipSnippet(block.body),
            updatedAt: block.day || '',
        });
    }

    for (const entry of input.profileEntries ?? []) {
        if (!entry || entry.sensitive === true || entry.deletedAt || entry.invalidatedAt) continue;
        const searchParts = [
            entry.slug,
            entry.title ?? '',
            entry.description ?? '',
            entry.body ?? '',
            ...(entry.aliases ?? []),
        ];
        const summary = entry.description?.trim() || clipSnippet(entry.body ?? '');
        if (!summary) continue;
        candidates.push({
            id: `profile:${entry.slug}`,
            source: 'profile',
            searchText: searchParts.join(' '),
            displayText: `${entry.slug}: ${clipSnippet(`${summary}${entry.body && entry.body !== summary ? ` — ${entry.body}` : ''}`, 200)}`,
            updatedAt: entry.updatedAt ?? '',
        });
    }

    const scored: RecalledMemoryItem[] = [];
    const seenSnippets = new Set<string>();

    for (const c of candidates) {
        const lower = c.searchText.toLowerCase();
        let score = 0;
        const matchedTerms: string[] = [];

        if (symTokens.some(t => containsWordOrToken(lower, t))) {
            score += 3;
            matchedTerms.push(`symbol:${symTokens[0].toUpperCase()}`);
        }
        if (sesTokens.some(t => containsWordOrToken(lower, t))) {
            score += 2;
            matchedTerms.push(`session:${sesTokens[0]}`);
        }
        if (regTokens.some(t => containsWordOrToken(lower, t))) {
            score += 2;
            matchedTerms.push(`regime:${regTokens[0]}`);
        }
        if (score === 0) continue;

        if (AUTOPSY_CUE_RE.test(lower)) {
            score += 1;
        }

        const dedupeKey = c.displayText.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seenSnippets.has(dedupeKey)) continue;
        seenSnippets.add(dedupeKey);

        scored.push({
            id: c.id,
            source: c.source,
            score,
            matchedTerms,
            text: c.displayText,
            updatedAt: c.updatedAt,
        });
    }

    scored.sort((a, b) =>
        b.score - a.score
        || b.updatedAt.localeCompare(a.updatedAt)
        || a.id.localeCompare(b.id));

    const items = scored.slice(0, maxItems);
    if (items.length === 0) {
        return { items: [], promptTailBlock: '' };
    }

    const promptTailBlock = [
        '[RECALLED MEMORY — context-matched prior notes; hints only, live tape wins]',
        ...items.map(item => `- ${item.text}`),
    ].join('\n');

    return { items, promptTailBlock };
};
