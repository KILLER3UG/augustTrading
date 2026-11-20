/**
 * confluenceScanCore — the pure half of `scan_confluence` (Hermes-style
 * composite tool): input normalization with hard caps, bounded-concurrency
 * mapping, and the ranking that turns N symbol×timeframe rows into ONE ranked
 * summary a single inference turn can read.
 *
 * The executor (DeskToolsService) does the I/O; everything that decides caps,
 * agreement and order lives here so the caps are unit-testable facts, not
 * inline numbers nobody can see.
 */

export const SCAN_MAX_SYMBOLS = 8;
export const SCAN_MAX_TIMEFRAMES = 3;
export const SCAN_MAX_CONCURRENCY = 4;

export interface ScanPair {
    symbol: string;
    tf: string;
    ok: boolean;
    /** 'bull' | 'bear' | 'neutral' when the pair fetched; null on failure. */
    bias: 'bull' | 'bear' | 'neutral' | null;
    /** Live code-detected setups on this pair (titles + side). */
    setups: Array<{ title: string; side: 'long' | 'short' }>;
    error?: string;
}

/** Normalize + cap the tool input. Returns an error string for an unusable
 *  call (empty list, non-array) — the executor refuses instead of guessing. */
export const normalizeScanInput = (
    rawSymbols: unknown,
    rawTimeframes: unknown,
    defaultTf: string | null,
): { symbols: string[]; timeframes: string[]; error?: string } => {
    if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
        return { symbols: [], timeframes: [], error: 'symbols must be a non-empty array of perp symbols (1-8).' };
    }
    const symbols = [...new Set(rawSymbols
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim().toUpperCase()))].slice(0, SCAN_MAX_SYMBOLS);
    if (symbols.length === 0) {
        return { symbols: [], timeframes: [], error: 'symbols must contain at least one valid symbol.' };
    }
    const tfList = Array.isArray(rawTimeframes)
        ? rawTimeframes.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim())
        : [];
    const timeframes = [...new Set(tfList.length > 0 ? tfList : (defaultTf ? [defaultTf] : []))].slice(0, SCAN_MAX_TIMEFRAMES);
    if (timeframes.length === 0) {
        return { symbols: [], timeframes: [], error: 'timeframes must be a non-empty array (1-3) when the chart interval is unknown.' };
    }
    return { symbols, timeframes };
};

/** Bounded-concurrency map: at most `limit` promises in flight, results in
 *  INPUT order (the ranking is deterministic regardless of fetch order). */
export const mapPool = async <T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
};

/** All pairs a normalized call must fetch — the executor's work list. */
export const scanPairs = (symbols: readonly string[], timeframes: readonly string[]): Array<{ symbol: string; tf: string }> =>
    symbols.flatMap(symbol => timeframes.map(tf => ({ symbol, tf })));

export interface RankedSymbolScan {
    symbol: string;
    /** The majority bias across the fetched timeframes. */
    dominantBias: 'bull' | 'bear' | 'neutral';
    /** How many timeframes agree with the dominant bias (of the fetched ones). */
    agreeingTfs: number;
    fetchedTfs: number;
    setupCount: number;
    topSetup: { title: string; side: 'long' | 'short' } | null;
    score: number;
    failedPairs: string[];
}

/** Rank the fetched pairs into per-symbol rows: multi-TF agreement is the
 *  score's backbone (confluence, not noise), setups break ties. Deterministic:
 *  equal scores sort by symbol so a scan result is reproducible byte-for-byte
 *  from the same tape. */
export const rankConfluenceRows = (pairs: readonly ScanPair[]): RankedSymbolScan[] => {
    const bySymbol = new Map<string, ScanPair[]>();
    for (const pair of pairs) {
        const list = bySymbol.get(pair.symbol) ?? [];
        list.push(pair);
        bySymbol.set(pair.symbol, list);
    }
    const rows: RankedSymbolScan[] = [];
    for (const [symbol, list] of bySymbol) {
        const okPairs = list.filter(p => p.ok && p.bias !== null);
        const failedPairs = list.filter(p => !p.ok).map(p => `${p.symbol} ${p.tf}`);
        if (okPairs.length === 0) {
            rows.push({ symbol, dominantBias: 'neutral', agreeingTfs: 0, fetchedTfs: 0, setupCount: 0, topSetup: null, score: -1, failedPairs });
            continue;
        }
        const bull = okPairs.filter(p => p.bias === 'bull').length;
        const bear = okPairs.filter(p => p.bias === 'bear').length;
        const neutral = okPairs.filter(p => p.bias === 'neutral').length;
        const dominantBias: 'bull' | 'bear' | 'neutral' = bull >= bear && bull >= neutral ? 'bull' : bear >= neutral ? 'bear' : 'neutral';
        const agreeingTfs = dominantBias === 'bull' ? bull : dominantBias === 'bear' ? bear : neutral;
        const setups = okPairs.flatMap(p => p.setups);
        const topSetup = setups.length > 0
            ? (setups.find(s => (dominantBias === 'bull' && s.side === 'long') || (dominantBias === 'bear' && s.side === 'short'))
                ?? setups[0])
            : null;
        const score = agreeingTfs * 2 + Math.min(setups.length, 4) - (failedPairs.length > 0 ? 1 : 0);
        rows.push({ symbol, dominantBias, agreeingTfs, fetchedTfs: okPairs.length, setupCount: setups.length, topSetup, score, failedPairs });
    }
    return rows.sort((a, b) => (b.score - a.score) || a.symbol.localeCompare(b.symbol));
};

/** The compact ranked summary — one line per symbol, best first. */
export const buildConfluenceSummary = (rows: readonly RankedSymbolScan[]): string => {
    if (rows.length === 0) return 'SCAN CONFLUENCE — nothing fetched; the source failed. Do not invent rows.';
    const lines = rows.map(r => {
        if (r.fetchedTfs === 0) return `${r.symbol} — UNAVAILABLE (${r.failedPairs.join(', ') || 'fetch failed'}). Do not infer a tape.`;
        const setupsPart = r.setupCount > 0 && r.topSetup
            ? ` · ${r.setupCount} setup${r.setupCount === 1 ? '' : 's'} (top: ${r.topSetup.title} [${r.topSetup.side.toUpperCase()}])`
            : ' · no live setups';
        const failedPart = r.failedPairs.length > 0 ? ` · ${r.failedPairs.length} tf fetch failed` : '';
        return `${r.symbol} — ${r.dominantBias.toUpperCase()} (${r.agreeingTfs}/${r.fetchedTfs} tfs agree)${setupsPart}${failedPart}`;
    });
    return [
        `SCAN CONFLUENCE — ${rows.length} symbol${rows.length === 1 ? '' : 's'}, ranked by multi-timeframe agreement then setups:`,
        ...lines,
        'Rows are CODE-detected (trend bias + setup detectors) — confirm against the packet and levels before acting on any row.',
    ].join('\n');
};
