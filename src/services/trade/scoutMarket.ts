/**
 * scoutMarket — isolated, bounded read-only multi-symbol tape scout subagent.
 *
 * Scans up to `SCOUT_MAX_SYMBOLS` (6) symbols across up to `SCOUT_MAX_INTERVALS`
 * (2) intervals in parallel with a per-symbol timeout guard. Combines regime,
 * non-repainting divergences, funding/OI, and `spot_vs_perp` CVD/basis with ZERO
 * main-thread state mutation, returning a compact ranked brief (<= 1,200 chars).
 */

import type { Kline } from '../../types/message';
import { regimeRead } from '../market/regimeCore';
import { detectDivergences } from '../market/divergenceCore';
import { analyzeSpotVsPerp, type SpotVsPerpRegime } from '../market/spotVsPerpCore';

export const SCOUT_MAX_SYMBOLS = 6;
export const SCOUT_MAX_INTERVALS = 2;
export const SCOUT_MAX_BRIEF_CHARS = 1200;
export const SCOUT_DEFAULT_TIMEOUT_MS = 6000;

export interface MarketScoutFetchers {
    fetchPerpKlines: (symbol: string, interval: string, limit: number) => Promise<Kline[]>;
    fetchSpotKlines: (symbol: string, interval: string, limit: number) => Promise<Kline[]>;
    fetchFundingRate?: (symbol: string) => Promise<number | null>;
    fetchOpenInterestUsd?: (symbol: string) => Promise<number | null>;
}

export interface MarketScoutInput {
    symbols?: readonly string[];
    intervals?: readonly string[];
    focus?: string;
    timeoutMs?: number;
    maxChars?: number;
    fetchers?: MarketScoutFetchers;
}

export interface MarketScoutRow {
    symbol: string;
    score: number;
    regimes: Record<string, string>;
    spotPerpRegime: SpotVsPerpRegime | 'unavailable';
    basisBps: number | null;
    fundingRate: number | null;
    openInterestUsd: number | null;
    divergenceCount: number;
    topDivergence: string | null;
    rationale: string;
    timedOut?: boolean;
}

export interface MarketScoutResult {
    ok: boolean;
    symbolsScanned: string[];
    intervalsUsed: string[];
    focus: string | null;
    ranked: MarketScoutRow[];
    timedOutSymbols: string[];
    brief: string;
    briefChars: number;
}

const DEFAULT_SCOUT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
const DEFAULT_SCOUT_INTERVALS = ['15m', '1h'] as const;

const normalizeSym = (raw: string): string => {
    const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return '';
    return clean.endsWith('USDT') ? clean : `${clean}USDT`;
};

const defaultFetchers = async (): Promise<MarketScoutFetchers> => {
    const mds = await import('../analysis/MarketDataService');
    return {
        fetchPerpKlines: (symbol, interval, limit) => mds.fetchFuturesOHLCV(symbol, interval, limit),
        fetchSpotKlines: (symbol, interval, limit) => mds.fetchSpotOHLCV(symbol, interval, limit),
        fetchFundingRate: async symbol => {
            const mi = await mds.fetchMarkIndex(symbol).catch(() => null);
            return mi?.available && Number.isFinite(mi.lastFundingRate) ? mi.lastFundingRate : null;
        },
        fetchOpenInterestUsd: async symbol => {
            const oi = await mds.fetchOpenInterest(symbol).catch(() => null);
            return oi && Number.isFinite(oi.oiValue) && oi.oiValue > 0 ? oi.oiValue : null;
        },
    };
};

const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise.then(value => ({ timedOut: false as const, value })),
            new Promise<{ timedOut: true }>(resolve => {
                timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};

const scoreSymbolRow = (args: {
    regimes: Record<string, string>;
    spotPerpRegime: SpotVsPerpRegime | 'unavailable';
    basisBps: number | null;
    fundingRate: number | null;
    divKinds: string[];
    focus: string | null;
}): { score: number; rationale: string } => {
    let score = 0;
    const notes: string[] = [];

    const regValues = Object.values(args.regimes);
    if (regValues.length >= 2 && regValues[0] === regValues[1] && regValues[0] !== 'unknown') {
        score += 20;
        notes.push(`aligned ${regValues[0]}`);
    } else if (regValues[0] && regValues[0] !== 'unknown') {
        score += 8;
        notes.push(regValues[0]);
    }

    if (args.divKinds.length > 0) {
        score += Math.min(25, args.divKinds.length * 10);
        notes.push(`${args.divKinds.length} div (${args.divKinds[0]})`);
    }

    if (args.spotPerpRegime === 'spot_absorption' || args.spotPerpRegime === 'aligned_bull') {
        score += 18;
        notes.push(args.spotPerpRegime);
    } else if (args.spotPerpRegime === 'perp_chasing' || args.spotPerpRegime === 'aligned_bear') {
        score += 12;
        notes.push(args.spotPerpRegime);
    }

    if (args.fundingRate !== null && Math.abs(args.fundingRate) >= 0.0005) {
        score += 14;
        notes.push(`funding ${(args.fundingRate * 100).toFixed(3)}%`);
    } else if (args.basisBps !== null && Math.abs(args.basisBps) >= 8) {
        score += 6;
        notes.push(`basis ${args.basisBps.toFixed(1)}bps`);
    }

    if (args.focus) {
        const f = args.focus.toLowerCase();
        if (notes.join(' ').toLowerCase().includes(f)) score += 10;
    }

    return {
        score,
        rationale: notes.length > 0 ? notes.join(' · ') : 'quiet balanced tape',
    };
};

const clipBrief = (lines: string[], maxChars: number): string => {
    const cap = Math.max(80, Math.min(SCOUT_MAX_BRIEF_CHARS, maxChars));
    const kept: string[] = [];
    let length = 0;
    for (const line of lines) {
        const nextLen = length === 0 ? line.length : length + 1 + line.length;
        if (nextLen <= cap) {
            kept.push(line);
            length = nextLen;
        } else {
            break;
        }
    }
    if (kept.length === 0 && lines.length > 0) {
        return lines[0].slice(0, cap);
    }
    const joined = kept.join('\n');
    return joined.length > cap ? joined.slice(0, cap) : joined;
};

/**
 * Run bounded read-only multi-symbol reconnaissance. Does not touch any global
 * UI/chat/broker state and guarantees `brief.length <= SCOUT_MAX_BRIEF_CHARS` (1200).
 */
export const runMarketScout = async (input: MarketScoutInput = {}): Promise<MarketScoutResult> => {
    const rawSyms = Array.isArray(input.symbols) && input.symbols.length > 0
        ? input.symbols
        : DEFAULT_SCOUT_SYMBOLS;
    const symbolsScanned = [...new Set(rawSyms.map(normalizeSym).filter(Boolean))].slice(0, SCOUT_MAX_SYMBOLS);
    if (symbolsScanned.length === 0) symbolsScanned.push(...DEFAULT_SCOUT_SYMBOLS);

    const rawTfs = Array.isArray(input.intervals) && input.intervals.length > 0
        ? input.intervals
        : DEFAULT_SCOUT_INTERVALS;
    const intervalsUsed = [...new Set(rawTfs.map(t => String(t || '').trim()).filter(Boolean))].slice(0, SCOUT_MAX_INTERVALS);
    if (intervalsUsed.length === 0) intervalsUsed.push('15m');

    const focus = input.focus?.trim() ? input.focus.trim() : null;
    const timeoutMs = Math.max(50, Math.min(15_000, Math.floor(input.timeoutMs ?? SCOUT_DEFAULT_TIMEOUT_MS)));
    const maxChars = Math.min(SCOUT_MAX_BRIEF_CHARS, Math.max(120, Math.floor(input.maxChars ?? SCOUT_MAX_BRIEF_CHARS)));
    const fetchers = input.fetchers ?? await defaultFetchers();

    const scanOne = async (symbol: string): Promise<MarketScoutRow> => {
        const work = (async (): Promise<MarketScoutRow> => {
            const primaryTf = intervalsUsed[0];
            const perpEntries = await Promise.all(
                intervalsUsed.map(async tf => [tf, await fetchers.fetchPerpKlines(symbol, tf, 100).catch(() => [] as Kline[])] as const),
            );
            const [spotKlines, fundingRate, openInterestUsd] = await Promise.all([
                fetchers.fetchSpotKlines(symbol, primaryTf, 60).catch(() => [] as Kline[]),
                fetchers.fetchFundingRate ? fetchers.fetchFundingRate(symbol).catch(() => null) : Promise.resolve(null),
                fetchers.fetchOpenInterestUsd ? fetchers.fetchOpenInterestUsd(symbol).catch(() => null) : Promise.resolve(null),
            ]);

            const regimes: Record<string, string> = {};
            for (const [tf, kl] of perpEntries) {
                const reg = kl.length >= 30 ? regimeRead(kl) : null;
                regimes[tf] = reg ? `${reg.direction}:${reg.volatility}` : 'unknown';
            }

            const primaryKlines = perpEntries[0]?.[1] ?? [];
            const divRead = primaryKlines.length >= 30
                ? detectDivergences(primaryKlines, { symbol, interval: primaryTf, excludeFormingCandle: false })
                : null;
            const divKinds = (divRead?.divergences ?? []).map(d => `${d.indicator.toUpperCase()} ${d.kind}`);

            const spotPerp = analyzeSpotVsPerp({
                symbol,
                interval: primaryTf,
                spotKlines,
                perpKlines: primaryKlines,
                fundingRate,
            });
            const spotPerpRegime: SpotVsPerpRegime | 'unavailable' = spotPerp.spotAvailable
                ? spotPerp.regime
                : 'unavailable';

            const scored = scoreSymbolRow({
                regimes,
                spotPerpRegime,
                basisBps: spotPerp.basisBps,
                fundingRate,
                divKinds,
                focus,
            });

            return {
                symbol,
                score: scored.score,
                regimes,
                spotPerpRegime,
                basisBps: spotPerp.basisBps,
                fundingRate,
                openInterestUsd,
                divergenceCount: divKinds.length,
                topDivergence: divKinds[0] ?? null,
                rationale: scored.rationale,
            };
        })();

        const outcome = await withTimeout(work, timeoutMs);
        if (outcome.timedOut) {
            return {
                symbol,
                score: -1,
                regimes: {},
                spotPerpRegime: 'unavailable',
                basisBps: null,
                fundingRate: null,
                openInterestUsd: null,
                divergenceCount: 0,
                topDivergence: null,
                rationale: `timed out after ${timeoutMs}ms`,
                timedOut: true,
            };
        }
        return outcome.value;
    };

    const rows = await Promise.all(symbolsScanned.map(scanOne));
    const ranked = [...rows].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const timedOutSymbols = ranked.filter(r => r.timedOut).map(r => r.symbol);

    const header = `SCOUT [${intervalsUsed.join('/')}]${focus ? ` (${focus.slice(0, 40)})` : ''}:`;
    const bodyLines = ranked.map((r, idx) => {
        const regStr = Object.entries(r.regimes).map(([tf, val]) => `${tf}=${val}`).join(',') || 'n/a';
        const basisStr = r.basisBps !== null ? `${r.basisBps.toFixed(1)}bps` : 'n/a';
        return `${idx + 1}. ${r.symbol} (${r.score}) · ${regStr} · flow=${r.spotPerpRegime} · basis=${basisStr}${r.topDivergence ? ` · ${r.topDivergence}` : ''}${r.timedOut ? ' · TIMEOUT' : ''}`;
    });
    const brief = clipBrief([header, ...bodyLines], maxChars);

    return {
        ok: true,
        symbolsScanned,
        intervalsUsed,
        focus,
        ranked,
        timedOutSymbols,
        brief,
        briefChars: brief.length,
    };
};
