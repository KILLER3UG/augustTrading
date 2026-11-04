/**
 * bestSetups — the ONE ranking of "best" over a screener scan.
 *
 * The screener (`services/trade/screener.ts`) measures the market; this module
 * decides which measured rows are worth the trader's attention. Both readers
 * use it: the human screener panel's "Best setups" sort and the model's
 * `find_best_setups` desk tool. A second score would let the table and the
 * answer name different "best" coins, which is exactly the drift the
 * canonical-module rule exists to stop.
 *
 * The score is a CONFLUENCE COUNT, not a probability, a win rate or a grade.
 * Every point is traceable to a field the screener measured (live setups,
 * EMA regime, RSI14, the trigger's bar age, the trader's own W/L record), and
 * every point is printed as a reason beside the number. Nothing here fetches,
 * invents a price, or proposes an entry/stop/target — those come from a
 * packet on the chosen coin, not from a market-wide ranking.
 *
 * Pure and dependency-free: check-contracts can pin the arithmetic.
 */

import type { ScreenerRow } from './screener';

export type SetupDirection = 'long' | 'short';

/** The formula, in the words both the tool schema and the digest print. */
export const SCORE_FORMULA =
    '3 per agreeing directional setup (max 3) + 3 when the EMA regime agrees '
    + '(−2 when it opposes) + 2 for a current-bar trigger / 1 within 2 bars '
    + '+ 1 when RSI14 is not stretched for the side (−1 when overextended) '
    + '+ 2/+1/−1 from at least 5 of your own logged outcomes on the coin '
    + '− 2 when long and short setups are live at once.';

export interface ScoreBreakdown {
    score: number;
    direction: SetupDirection | null;
    /** One human line per term of the score, so the number can be checked. */
    reasons: string[];
}

export interface RankedSetup {
    symbol: string;
    direction: SetupDirection;
    score: number;
    reasons: string[];
    price: number;
    change24h: number;
    rsi14: number | null;
    regime: ScreenerRow['regime'];
    edge: string;
    setups: ScreenerRow['setups'];
    quoteVolume: number;
}

export interface RankBestOptions {
    /** How many candidates to return (default 8). */
    limit?: number;
    /** Minimum confluence score (default 3). A thin market says "none". */
    minScore?: number;
    /** Keep only one side (default 'any'). */
    direction?: 'any' | SetupDirection;
}

export interface BestSetupsResult {
    ranked: RankedSetup[];
    /** Rows the scan actually measured. */
    scanned: number;
    /** Rows carrying at least one directional (long/short) setup. */
    withSetups: number;
    /** Rows that cleared minScore AND the direction filter. */
    eligible: number;
}

/** The screener prints the personal edge as "7W/5L". Parse it here rather
 *  than widening ScreenerRow: the string is the panel's display format and
 *  this is the only reader that needs the numbers. */
const edgeRecord = (edge: string): { wins: number; losses: number; sample: number } | null => {
    const match = /^(\d+)W\/(\d+)L$/.exec((edge ?? '').trim());
    if (!match) return null;
    const wins = Number(match[1]);
    const losses = Number(match[2]);
    return Number.isFinite(wins) && Number.isFinite(losses)
        ? { wins, losses, sample: wins + losses }
        : null;
};

/**
 * Score one measured row. Returns `direction: null` for a row with no long or
 * short setup — a "watch" detector alone is not a trade candidate, and must
 * never be counted as one.
 */
export const bestSetupScore = (row: ScreenerRow): ScoreBreakdown => {
    const directional = row.setups.filter(s => s.side === 'long' || s.side === 'short');
    if (directional.length === 0) return { score: 0, direction: null, reasons: [] };

    const longs = directional.filter(s => s.side === 'long').length;
    const shorts = directional.length - longs;
    // A tie is settled by measured context, never by a coin flip: the EMA
    // regime first, then the 24h sign. Deterministic and explainable.
    let direction: SetupDirection;
    if (longs > shorts) direction = 'long';
    else if (shorts > longs) direction = 'short';
    else if (row.regime === 'up') direction = 'long';
    else if (row.regime === 'down') direction = 'short';
    else direction = row.change24h >= 0 ? 'long' : 'short';

    const reasons: string[] = [];
    let score = 0;

    const agreeing = direction === 'long' ? longs : shorts;
    const confluence = 3 * Math.min(agreeing, 3);
    score += confluence;
    reasons.push(`${agreeing} ${direction} setup${agreeing === 1 ? '' : 's'} (+${confluence})`);

    if (longs > 0 && shorts > 0) {
        score -= 2;
        reasons.push('both long and short setups are live (−2)');
    }

    const agrees = (direction === 'long' && row.regime === 'up')
        || (direction === 'short' && row.regime === 'down');
    const opposes = (direction === 'long' && row.regime === 'down')
        || (direction === 'short' && row.regime === 'up');
    if (agrees) {
        score += 3;
        reasons.push(`${row.regime} regime agrees with ${direction} (+3)`);
    } else if (opposes) {
        score -= 2;
        reasons.push(`${row.regime} regime opposes ${direction} (−2)`);
    } else {
        reasons.push('range regime (0)');
    }

    const ages = directional
        .map(s => s.barsAgo)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    if (ages.length > 0) {
        const freshest = Math.min(...ages);
        if (freshest === 0) {
            score += 2;
            reasons.push('triggered on the current bar (+2)');
        } else if (freshest <= 2) {
            score += 1;
            reasons.push(`newest trigger ${freshest} bar${freshest === 1 ? '' : 's'} ago (+1)`);
        } else {
            reasons.push(`newest trigger ${freshest} bars ago (0)`);
        }
    } else {
        reasons.push('trigger age unknown (0)');
    }

    const rsi = row.rsi14;
    if (rsi !== null && Number.isFinite(rsi)) {
        const overextended = direction === 'long' ? rsi >= 75 : rsi <= 25;
        const healthy = direction === 'long'
            ? rsi >= 45 && rsi <= 65
            : rsi >= 35 && rsi <= 55;
        if (overextended) {
            score -= 1;
            reasons.push(`RSI14 ${rsi} is overextended for a fresh ${direction} (−1)`);
        } else if (healthy) {
            score += 1;
            reasons.push(`RSI14 ${rsi} is not stretched for a ${direction} (+1)`);
        } else {
            reasons.push(`RSI14 ${rsi} (0)`);
        }
    } else {
        reasons.push('RSI14 unavailable (0)');
    }

    const edge = edgeRecord(row.edge);
    if (edge && edge.sample >= 5) {
        const rate = edge.wins / edge.sample;
        if (rate >= 0.6) { score += 2; reasons.push(`your ${row.edge} on this coin (+2)`); }
        else if (rate >= 0.5) { score += 1; reasons.push(`your ${row.edge} on this coin (+1)`); }
        else if (rate < 0.4) { score -= 1; reasons.push(`your ${row.edge} on this coin (−1)`); }
        else reasons.push(`your ${row.edge} on this coin (0)`);
    }

    return { score, direction, reasons };
};

/** Rank a healthy scan. `universeFailed` is handled by the CALLER, which must
 *  say UNKNOWN rather than passing an empty array in here — an empty universe
 *  is a blind feed, not "no setups". */
export const rankBestSetups = (rows: ScreenerRow[], options: RankBestOptions = {}): BestSetupsResult => {
    const limit = Math.min(Math.max(Math.round(options.limit ?? 8), 1), 20);
    const minScore = Math.min(Math.max(Math.round(options.minScore ?? 3), 0), 30);
    const side = options.direction ?? 'any';
    let withSetups = 0;
    const scored: RankedSetup[] = [];
    for (const row of rows) {
        const breakdown = bestSetupScore(row);
        if (!breakdown.direction) continue;
        withSetups += 1;
        if (breakdown.score < minScore) continue;
        if (side !== 'any' && breakdown.direction !== side) continue;
        scored.push({
            symbol: row.symbol,
            direction: breakdown.direction,
            score: breakdown.score,
            reasons: breakdown.reasons,
            price: row.price,
            change24h: row.change24h,
            rsi14: row.rsi14,
            regime: row.regime,
            edge: row.edge,
            setups: row.setups,
            quoteVolume: row.quoteVolume,
        });
    }
    // Score first, then liquidity, then the symbol: two runs over the same
    // measured rows always print the same order.
    scored.sort((a, b) => b.score - a.score
        || b.quoteVolume - a.quoteVolume
        || a.symbol.localeCompare(b.symbol));
    return { ranked: scored.slice(0, limit), scanned: rows.length, withSetups, eligible: scored.length };
};

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 2 : 6 });

/** The model-facing digest. A quiet market says so plainly instead of
 *  promoting the least-bad row to "best". */
export const bestSetupsToMarkdown = (
    result: BestSetupsResult,
    meta: { top: number; interval: string; minScore: number },
): string => {
    const head = [
        `BEST SETUPS — asked for the top ${meta.top} USDT perps by 24h volume, measured ${result.scanned} (${meta.interval} read).`,
        `${result.withSetups} carried a live directional setup; ${result.eligible} cleared score >= ${meta.minScore}.`,
        `Score is a confluence count, NOT a probability: ${SCORE_FORMULA}`,
    ];
    if (result.ranked.length === 0) {
        return [
            ...head,
            `NO BEST SETUP CLEARED THE BAR. Do not promote a weak row to "best", and do not invent one. `
            + `Lower minScore only if the trader asks for a wider list, and say the evidence is thin.`,
        ].join('\n');
    }
    const lines = result.ranked.map((r, i) => {
        const setups = r.setups
            .map(s => `${s.title} (${s.side}${s.barsAgo === undefined ? '' : `, ${s.barsAgo} bar${s.barsAgo === 1 ? '' : 's'} ago`})`)
            .join('; ');
        return [
            `${i + 1}. ${r.symbol} · ${r.direction.toUpperCase()} · score ${r.score}`,
            `   price ${fmt(r.price)} · 24h ${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(1)}% `
            + `· RSI14 ${r.rsi14 ?? '—'} · regime ${r.regime} · your edge ${r.edge || '—'}`,
            `   setups: ${setups || '—'}`,
            `   why: ${r.reasons.join('; ')}`,
        ].join('\n');
    });
    return [
        ...head,
        ...lines,
        'These are CODE-detected conditions, not a plan: no entry, stop, target or probability is implied.',
        'To look at one, call switch_chart_symbol with its exact symbol, then get_market_packet for the levels.',
    ].join('\n');
};
