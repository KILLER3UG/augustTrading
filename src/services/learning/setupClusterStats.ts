/**
 * setupClusterStats — this desk's recorded outcome on a setup shape.
 *
 * Pure over the trade log: coin (+ optional direction, family, regime and
 * playbook) → sample, wins/losses, average R, the newest row and its key
 * lesson. Callers print the number rather than trust a model to remember it:
 * `find_best_setups`' cluster line, the screener's own column, and the
 * journal tools (`setup_base_rate`, `playbook_attribution`, `meta_label`).
 *
 * The regime and playbook conditions read what the O-46 decision snapshot
 * recorded at PRESENT time (`marketConditions.timeframeAlignment`, written by
 * `buildDecisionSnapshot`) and the detector tag `present_trade` stamps on the
 * plan. A row without either is EXCLUDED from a conditioned bucket — never
 * guessed into one — which is why the callers also report coverage.
 *
 * It used to live in `EvidencePackService.ts`, which also assembled the
 * moderator's verdict evidence pack. That pack was deleted on 2026-11-06: no
 * live path ever wrote the fields its UI read, so this is what remained.
 */

import type { LoggedTrade } from '../../types';
import { baseOf } from '../../utils/symbol';
import { calculatePnlR } from './PatternMemorySynthesisService';

export interface SetupClusterStats {
    sample: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgR: number | null;
    lastOutcome: 'WIN' | 'LOSS' | null;
    lastDate: string | null;
    worstLesson: string | null;
}

/** The row keys a cluster is grouped by. */
export interface SetupClusterFilter {
    coin?: string;
    direction?: string;
    family?: string;
}

/** Conditions applied on top of the row keys (the attributed bucket). */
export interface SetupClusterConditions {
    /** Only rows whose decision-time regime id matches — `range:compressed`
     *  exactly, or a single axis (`range`, `compressed`) segment. */
    regime?: string;
    /** Only rows whose plan carried this `scan_playbooks` detector id. */
    playbook?: string;
}

const coinOf = (t: LoggedTrade): string => baseOf(t.analysis?.coinName || '');
const normalise = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    return v || null;
};

/**
 * The regime id the row recorded at decision time, or null. The snapshot
 * writes `${direction}:${volatility}`; a literal dash (no snapshot landed)
 * and any other shape are NOT a regime and never match a filter.
 */
export const regimeIdOf = (t: LoggedTrade): string | null => {
    const raw = normalise(t.analysis?.marketConditions?.timeframeAlignment);
    return raw && raw !== '—' && raw.includes(':') ? raw : null;
};

/** The playbook detector id stamped on the plan, or null. */
export const playbookIdOf = (t: LoggedTrade): string | null =>
    normalise(t.analysis?.playbookId);

/**
 * Segment match so one condition answers both questions: `range:compressed`
 * only matches that composite, while `compressed` matches any direction that
 * recorded it. A row's extra segments (a legacy three-part id) do not stop a
 * two-part query from matching.
 */
export const regimeIdMatches = (recorded: string, wanted: string): boolean => {
    const have = new Set(recorded.toLowerCase().split(':').map(s => s.trim()).filter(Boolean));
    const want = wanted.toLowerCase().split(':').map(s => s.trim()).filter(Boolean);
    return want.length > 0 && want.every(w => have.has(w));
};

/**
 * The CLOSED rows this cluster key selects, before any condition filter.
 * Exported so the journal tools can report coverage with the SAME predicate
 * the stats use — a bucket that is thin because rows carry no regime must not
 * read the same as a bucket that is thin because the trader loses there.
 */
export const clusterRows = (trades: LoggedTrade[] | undefined, filter: SetupClusterFilter): LoggedTrade[] => {
    const rows = trades ?? [];
    if (!filter.coin || rows.length === 0) return [];
    // Canonical base coin on BOTH sides of the comparison (utils/symbol) —
    // the caller may pass 'BTCUSDT' or a bare 'BTC'; per-trade coin names are
    // normalized through the same helper above.
    const wantCoin = baseOf(filter.coin);
    return rows.filter(t => {
        if (t.outcome !== 'WIN' && t.outcome !== 'LOSS') return false;
        if (coinOf(t) !== wantCoin) return false;
        if ((filter.direction === 'Long' || filter.direction === 'Short') && t.analysis?.direction !== filter.direction) return false;
        if (filter.family && !(t.analysis?.detectedPatternFamily || '').toLowerCase().includes(filter.family.toLowerCase())) return false;
        return true;
    });
};

/**
 * The one aggregation over a set of already-selected rows. Exported because
 * `playbook_attribution` bins by detector id WITHOUT a coin key — the same
 * arithmetic, never a second implementation.
 */
export const summariseClusterRows = (matched: LoggedTrade[]): SetupClusterStats | null => {
    let wins = 0;
    let losses = 0;
    let rSum = 0;
    let rCount = 0;
    let lastOutcome: 'WIN' | 'LOSS' | null = null;
    let lastDate: string | null = null;
    let worstLesson: string | null = null;

    for (const t of matched) {
        if (t.outcome === 'WIN') wins += 1; else losses += 1;
        const r = calculatePnlR(t);
        if (typeof r === 'number') { rSum += r; rCount += 1; }
        const ts = t.timestamp || '';
        if (!lastDate || ts > lastDate) {
            lastDate = ts || null;
            lastOutcome = (t.outcome as 'WIN' | 'LOSS') ?? null;
            worstLesson = (t.postMortem || '').match(/\*\*Key Lesson:\*\*\s*([^\n]+)/i)?.[1]?.trim() || null;
        }
    }

    const sample = wins + losses;
    if (sample === 0) return null;
    return {
        sample,
        wins,
        losses,
        winRate: wins / sample,
        avgR: rCount > 0 ? rSum / rCount : null,
        lastOutcome,
        lastDate,
        worstLesson,
    };
};

/**
 * Cluster stats over the trade log: coin + direction + family, optionally
 * narrowed to a regime and/or playbook bucket. Pure given its inputs — no
 * storage access.
 */
export const computeSetupClusterStats = (
    coin: string | undefined,
    direction: string | undefined,
    family: string | undefined,
    trades: LoggedTrade[],
    conditions?: SetupClusterConditions,
): SetupClusterStats | null =>
    summariseClusterRows(clusterRows(trades, { coin, direction, family }).filter(t => {
        if (conditions?.regime) {
            const recorded = regimeIdOf(t);
            if (!recorded || !regimeIdMatches(recorded, conditions.regime)) return false;
        }
        if (conditions?.playbook) {
            const recorded = playbookIdOf(t);
            if (!recorded || recorded !== conditions.playbook.toLowerCase()) return false;
        }
        return true;
    }));
