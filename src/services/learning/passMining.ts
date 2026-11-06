/**
 * Pass mining — the journal's read on discipline. Closed trades say what the
 * trader took; SKIPPED trades say what the trader refused, and nothing else in
 * the loop was looking at them.
 *
 * This service resolves passes POST-HOC and deterministically: for a SKIPPED
 * trade with a reason and a preliminary plan (the analyst's entry/SL/TP,
 * already captured on the row), fetch klines after the skip timestamp and
 * check which level the would-be trade hit first:
 *   SL first  → CORRECT PASS  — the discipline worked.
 *   TP first  → MISSED OPPORTUNITY — surfaced as a journal counter-metric
 *               ONLY. We do not teach the system to take more trades; the
 *               trader's own breakers own that side.
 *   neither   → still open / inconclusive — stays pending for a later sweep.
 *
 * Neither resolution writes a skill. The desk writes skills through
 * `skill_write` (SkillFileService) when it has something to say; a skipped
 * trade is a number in the journal, not a document.
 *
 * Resolutions persist per user (bounded), so each skip is fetched at most
 * once across sessions.
 */

import type { LoggedTrade } from '../../types';
import { TradeOutcome } from '../../types/enums';
import { getPreferenceArray, setPreferenceObject } from '../infrastructure/PreferencesService';
import { scanTradeOutcome, resolveOutcomeFromScan } from '../backtesting/outcomeEngine';
import { nearestTargetPrice } from '../../utils/riskReward';
import type { Kline } from '../../types/message';

/** Cap on kline fetches per sweep — the cost bound; a sweep never pages back far. */
export const PASS_MINING_MAX_FETCHES_PER_SWEEP = 5;
/** Only consider skips newer than this — older paths need too much history. */
const PASS_MINING_LOOKBACK_DAYS = 30;
/** Kline window after the skip: 1h × 300 ≈ 12 days. */
const PASS_KLINE_INTERVAL = '1h';
const PASS_KLINE_LIMIT = 300;

export type PassResolution = 'CORRECT_PASS' | 'MISSED_OPPORTUNITY' | 'OPEN' | 'NO_PLAN';

export interface PassRecord {
    /** The skipped trade/message id. */
    tradeId: string;
    coin?: string;
    direction?: string;
    family?: string;
    regime?: string;
    skipReason: string;
    skippedAt: string;
    resolution: PassResolution;
    resolvedAt: string;
}

const KEY_PREFIX = 'pass_mining_v1_';
const MAX_RECORDS = 300;

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const RESOLUTIONS: readonly PassResolution[] = ['CORRECT_PASS', 'MISSED_OPPORTUNITY', 'OPEN', 'NO_PLAN'];

/** Item guard for the stored blob: the sweep keys, filters and clusters on
 *  tradeId/resolution, so a junk element (null, string, unknown resolution)
 *  must never survive the read — the previous `as T` cast let one reach the
 *  `.map`/`every` chains. */
const isPassRecord = (item: unknown): item is PassRecord => {
    const r = item as Partial<PassRecord> | null;
    return !!r && typeof r === 'object'
        && typeof r.tradeId === 'string'
        && typeof r.resolution === 'string'
        && RESOLUTIONS.includes(r.resolution as PassResolution);
};

export const loadPassRecords = async (username: string): Promise<PassRecord[]> =>
    getPreferenceArray<PassRecord>(keyFor(username), isPassRecord);

const savePassRecords = async (username: string, recs: PassRecord[]): Promise<void> =>
    setPreferenceObject(keyFor(username), recs.slice(-MAX_RECORDS));

/**
 * Deterministic would-have-happened resolution over post-skip klines.
 * Reuses the production outcome engine (same limit-fill semantics as the
 * backtest engines): the would-be entry fills on first touch, then whichever
 * level is hit first decides. Pure — no fetching — so tests drive it with
 * synthetic candles.
 */
export const resolvePassOutcome = (
    klines: Kline[],
    skippedAtMs: number,
    entry: number,
    stopLoss: number,
    takeProfit: number,
    isLong: boolean,
): PassResolution => {
    if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)
        || entry <= 0 || stopLoss <= 0 || takeProfit <= 0) return 'NO_PLAN';
    const after = klines.filter(k => k.time >= skippedAtMs);
    if (after.length === 0) return 'OPEN';
    const scan = scanTradeOutcome(after, entry, stopLoss, [takeProfit], isLong);
    if (!scan.entryTriggered) return 'OPEN';
    const res = resolveOutcomeFromScan(scan);
    if (res.outcome === 'WIN') return 'MISSED_OPPORTUNITY';
    if (res.outcome === 'LOSS') return 'CORRECT_PASS';
    return 'OPEN';
};

/** Missed-opportunity counter-metric for the journal (never a skill). */
export const missedOpportunityCount = (records: PassRecord[]): number =>
    records.filter(r => r.resolution === 'MISSED_OPPORTUNITY').length;

export const correctPassCount = (records: PassRecord[]): number =>
    records.filter(r => r.resolution === 'CORRECT_PASS').length;

/**
 * Extract the would-be plan from a skipped trade row. The preliminary plan
 * (entry/SL/TP) rides the analysis the desk wrote when it proposed the trade.
 */
const planOf = (t: LoggedTrade): { entry: number; sl: number; tp: number; isLong: boolean } | null => {
    const a = t.analysis;
    if (!a) return null;
    const num = (v: unknown): number => parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;
    const entry = num(a.entryPoints?.[0]?.price) || num(t.correctedEntry);
    const sl = num(a.stopLoss);
    // The target the trader was shown is the NEAREST one, not the first the
    // model happened to list. A skipped trade resolved against array order can
    // be called a correct pass because the farthest target never filled.
    const tp = nearestTargetPrice(entry || 0, (a.takeProfit ?? []).map(t => num(t?.price)));
    const isLong = a.direction === 'Long';
    if (!entry || !sl || !tp) return null;
    // Sanity: the levels must bracket the entry the right way for the side.
    if (isLong && !(sl < entry && tp > entry)) return null;
    if (!isLong && !(sl > entry && tp < entry)) return null;
    return { entry, sl, tp, isLong };
};

export interface PassMiningSweepResult {
    resolved: number;
    correctPasses: number;
    missed: number;
}

/**
 * One sweep: resolve up to PASS_MINING_MAX_FETCHES_PER_SWEEP recent
 * unresolved skips and persist their outcomes. It writes no skill and no
 * queue item — the journal's two counters are the whole product.
 *
 * `fetchKlines` is injectable so tests (and offline runs) never touch the
 * network; production passes the real KlineService fetcher.
 */
export const runPassMiningSweep = async (
    trades: LoggedTrade[],
    username: string,
    fetchKlines: (symbol: string, interval: string, limit: number) => Promise<Kline[]>,
): Promise<PassMiningSweepResult> => {
    const result: PassMiningSweepResult = { resolved: 0, correctPasses: 0, missed: 0 };
    const records = await loadPassRecords(username);
    const known = new Map(records.map(r => [r.tradeId, r]));

    const cutoff = Date.now() - PASS_MINING_LOOKBACK_DAYS * 86_400_000;
    const candidates = trades.filter(t => {
        if (t.outcome !== TradeOutcome.SKIPPED) return false;
        if (!t.skipReason || !t.skipReason.trim()) return false;
        const ts = Date.parse(t.timestamp || '');
        if (!Number.isFinite(ts) || ts < cutoff) return false;
        const existing = known.get(t.id);
        if (existing && existing.resolution !== 'OPEN') return false;
        return planOf(t) !== null;
    });

    let fetches = 0;
    for (const t of candidates) {
        if (fetches >= PASS_MINING_MAX_FETCHES_PER_SWEEP) break;
        const plan = planOf(t);
        if (!plan) continue;
        const skippedAt = Date.parse(t.timestamp || '');
        let resolution: PassResolution;
        try {
            const symbol = (t.analysis?.coinName || '').toUpperCase();
            const klines = await fetchKlines(symbol.endsWith('USDT') ? symbol : `${symbol}USDT`, PASS_KLINE_INTERVAL, PASS_KLINE_LIMIT);
            fetches += 1;
            resolution = resolvePassOutcome(klines, skippedAt, plan.entry, plan.sl, plan.tp, plan.isLong);
        } catch {
            continue; // network failure — retry on a later sweep
        }
        const rec: PassRecord = {
            tradeId: t.id,
            coin: t.analysis?.coinName,
            direction: t.analysis?.direction === 'Long' || t.analysis?.direction === 'Short'
                ? t.analysis.direction : undefined,
            family: t.analysis?.detectedPatternFamily,
            regime: t.marketRegime,
            skipReason: t.skipReason!.trim(),
            skippedAt: t.timestamp,
            resolution,
            resolvedAt: new Date().toISOString(),
        };
        // Replace an existing OPEN record for this trade, or append. NOTE:
        // findIndex returns -1 for a first-time resolution — splice(-1, 1)
        // would delete the LAST record (JS negative-index semantics), so
        // only splice when the index is real.
        const idx = records.findIndex(r => r.tradeId === t.id);
        if (idx >= 0) records.splice(idx, 1);
        records.push(rec);
        known.set(t.id, rec);
        if (resolution !== 'OPEN') {
            result.resolved += 1;
            if (resolution === 'CORRECT_PASS') result.correctPasses += 1;
            if (resolution === 'MISSED_OPPORTUNITY') result.missed += 1;
        }
    }

    await savePassRecords(username, records);
    return result;
};
