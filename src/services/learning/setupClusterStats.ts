/**
 * setupClusterStats — this desk's recorded outcome on a setup shape.
 *
 * Pure over the trade log: coin (+ optional direction and family) → sample,
 * wins/losses, average R, the newest row and its key lesson. Two callers, both
 * of which print the number rather than trust a model to remember it:
 * `find_best_setups`' cluster line and the screener's own column.
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

const coinOf = (t: LoggedTrade): string => baseOf(t.analysis?.coinName || '');

/**
 * Cluster stats over the trade log: coin + direction + family + regime.
 * Pure given its inputs — no storage access.
 */
export const computeSetupClusterStats = (
    coin: string | undefined,
    direction: string | undefined,
    family: string | undefined,
    trades: LoggedTrade[],
): SetupClusterStats | null => {
    if (!coin || !trades || trades.length === 0) return null;
    // Canonical base coin on BOTH sides of the comparison (utils/symbol) —
    // the caller may pass 'BTCUSDT' or a bare 'BTC'; per-trade coin names are
    // normalized through the same helper above.
    const wantCoin = baseOf(coin);
    let wins = 0;
    let losses = 0;
    let rSum = 0;
    let rCount = 0;
    let lastOutcome: 'WIN' | 'LOSS' | null = null;
    let lastDate: string | null = null;
    let worstLesson: string | null = null;

    const matched = trades.filter(t => {
        if (t.outcome !== 'WIN' && t.outcome !== 'LOSS') return false;
        if (coinOf(t) !== wantCoin) return false;
        if ((direction === 'Long' || direction === 'Short') && t.analysis?.direction !== direction) return false;
        if (family && !(t.analysis?.detectedPatternFamily || '').toLowerCase().includes(family.toLowerCase())) return false;
        return true;
    });

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
