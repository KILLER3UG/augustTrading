/**
 * executionAutopsyCore — pure deterministic MFE/MAE execution & behavior autopsy.
 *
 * Inspects settled `signal_ledger` records and closed paper trades to isolate
 * concrete execution leaks:
 *   - MFE Giveback Rate: setups reaching >= +1.5R favorable excursion that close <= +0.2R
 *   - Immediate Stop-Out Rate: stop-outs that never cleared +0.3R favorable excursion
 *   - Capture Efficiency & Hold Behavior: avg outcomeR, MFE, MAE, hold duration, efficiency
 *   - Regime / Session / Playbook Breakdowns: surfaced strictly when bucket n >= 5
 *   - Behavioral Clusters: rapid same-symbol re-entries within 30m after a red close & streaks
 *
 * Strict thin-sample honesty: refuses to claim any leak or pattern when n < 5.
 * 100% pure TypeScript: zero React, DOM, window, localStorage, or network imports.
 */

import type { SignalRow } from '../../types/signal';
import type { PaperSettledTrade } from '../paper/paperCore';

export const AUTOPSY_MIN_SAMPLE = 5;
export const MFE_GIVEBACK_PEAK_R = 1.5;
export const MFE_GIVEBACK_EXIT_MAX_R = 0.2;
export const IMMEDIATE_STOP_MFE_MAX_R = 0.3;
export const REVENGE_WINDOW_MS = 30 * 60_000;

export type UtcSessionBucket = 'Asia' | 'London' | 'NewYork' | 'Late';

export interface AutopsyRow {
    id: string;
    symbol: string;
    direction: 'long' | 'short';
    openedAtMs: number;
    closedAtMs: number;
    outcomeR: number;
    mfeR?: number;
    maeR?: number;
    isStopOut: boolean;
    regime?: string;
    playbook?: string;
}

export interface AutopsyBucketStat {
    key: string;
    sample: number;
    wins: number;
    losses: number;
    winRate: number;
    expectancyR: number;
    flaggedLeak: boolean;
}

export interface RevengeCluster {
    priorId: string;
    reentryId: string;
    symbol: string;
    gapMinutes: number;
    priorOutcomeR: number;
    reentryOutcomeR: number;
}

export interface ExecutionAutopsyReport {
    sampleCount: number;
    sufficientSample: boolean;
    refusalReason: string | null;
    mfeGiveback: {
        eligible: number;
        count: number;
        rate: number | null;
        flagged: boolean;
    };
    immediateStopOut: {
        eligible: number;
        count: number;
        rate: number | null;
        flagged: boolean;
    };
    efficiency: {
        avgOutcomeR: number | null;
        avgMfeR: number | null;
        avgMaeR: number | null;
        avgHoldMinutes: number | null;
        captureEfficiency: number | null;
    };
    byRegime: AutopsyBucketStat[];
    bySession: AutopsyBucketStat[];
    byPlaybook: AutopsyBucketStat[];
    behavioral: {
        revengeClusters: RevengeCluster[];
        maxLossStreak: number;
        postLossSample: number;
        postLossExpectancyR: number | null;
    };
    findings: string[];
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const r2 = (v: number): number => Math.round(v * 100) / 100;

export const classifyUtcSession = (epochMs: number): UtcSessionBucket => {
    const h = new Date(epochMs).getUTCHours();
    if (h >= 0 && h < 7) return 'Asia';
    if (h >= 7 && h < 13) return 'London';
    if (h >= 13 && h < 20) return 'NewYork';
    return 'Late';
};

/** Normalize resolved `SignalRow` records into `AutopsyRow` entries (skips open / never_triggered rows). */
export const autopsyRowsFromSignals = (rows: readonly SignalRow[]): AutopsyRow[] => {
    const out: AutopsyRow[] = [];
    for (const row of rows) {
        const res = row.resolution;
        if (!res || res.status === 'never_triggered') continue;
        const openedAtMs = res.triggeredAt ?? row.signal.emittedAt;
        const closedAtMs = res.exitAt ?? res.at;
        if (!Number.isFinite(res.outcomeR) || !Number.isFinite(closedAtMs)) continue;
        out.push({
            id: row.signal.id,
            symbol: row.signal.coin.trim().toUpperCase(),
            direction: row.signal.direction,
            openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : closedAtMs,
            closedAtMs,
            outcomeR: res.outcomeR,
            mfeR: typeof res.mfeR === 'number' && Number.isFinite(res.mfeR) ? res.mfeR : undefined,
            maeR: typeof res.maeR === 'number' && Number.isFinite(res.maeR) ? res.maeR : undefined,
            isStopOut: res.status === 'lost',
            regime: row.signal.marketRegime?.trim() || undefined,
            playbook: row.signal.skillSlug?.trim() || undefined,
        });
    }
    return out;
};

/** Normalize closed paper broker trades into `AutopsyRow` entries. */
export const autopsyRowsFromPaperTrades = (trades: readonly PaperSettledTrade[]): AutopsyRow[] => {
    const out: AutopsyRow[] = [];
    for (const t of trades) {
        if (!Number.isFinite(t.rMultiple) || !Number.isFinite(t.closedAt)) continue;
        out.push({
            id: t.positionId,
            symbol: t.symbol.trim().toUpperCase(),
            direction: t.side,
            openedAtMs: Number.isFinite(t.openedAt) ? t.openedAt : t.closedAt,
            closedAtMs: t.closedAt,
            outcomeR: t.rMultiple,
            isStopOut: t.exitReason === 'sl' || t.exitReason === 'liquidation',
            playbook: t.skillSlug?.trim() || undefined,
        });
    }
    return out;
};

const aggregateBuckets = (
    rows: readonly AutopsyRow[],
    keyFn: (row: AutopsyRow) => string | undefined,
): AutopsyBucketStat[] => {
    const map = new Map<string, AutopsyRow[]>();
    for (const row of rows) {
        const k = keyFn(row);
        if (!k) continue;
        const list = map.get(k);
        if (list) list.push(row);
        else map.set(k, [row]);
    }
    const stats: AutopsyBucketStat[] = [];
    for (const [key, list] of map.entries()) {
        if (list.length < AUTOPSY_MIN_SAMPLE) continue;
        const wins = list.filter(r => r.outcomeR > 0).length;
        const losses = list.length - wins;
        const winRate = r4(wins / list.length);
        const expectancyR = r4(list.reduce((s, r) => s + r.outcomeR, 0) / list.length);
        stats.push({
            key,
            sample: list.length,
            wins,
            losses,
            winRate,
            expectancyR,
            flaggedLeak: expectancyR < -0.15 || winRate < 0.35,
        });
    }
    return stats.sort((a, b) => a.expectancyR - b.expectancyR || b.sample - a.sample);
};

export interface BuildAutopsyInput {
    rows?: readonly AutopsyRow[];
    signals?: readonly SignalRow[];
    paperTrades?: readonly PaperSettledTrade[];
}

/** Deterministically compute MFE/MAE execution autopsy & behavioral leak flags. */
export const buildExecutionAutopsy = (input: BuildAutopsyInput): ExecutionAutopsyReport => {
    const merged: AutopsyRow[] = [
        ...(input.rows ?? []),
        ...(input.signals ? autopsyRowsFromSignals(input.signals) : []),
        ...(input.paperTrades ? autopsyRowsFromPaperTrades(input.paperTrades) : []),
    ].sort((a, b) => a.closedAtMs - b.closedAtMs || a.id.localeCompare(b.id));

    const sampleCount = merged.length;
    if (sampleCount < AUTOPSY_MIN_SAMPLE) {
        return {
            sampleCount,
            sufficientSample: false,
            refusalReason: `Insufficient settled executions (N=${sampleCount} < ${AUTOPSY_MIN_SAMPLE}) — autopsy withheld until at least ${AUTOPSY_MIN_SAMPLE} trades resolve.`,
            mfeGiveback: { eligible: 0, count: 0, rate: null, flagged: false },
            immediateStopOut: { eligible: 0, count: 0, rate: null, flagged: false },
            efficiency: {
                avgOutcomeR: null,
                avgMfeR: null,
                avgMaeR: null,
                avgHoldMinutes: null,
                captureEfficiency: null,
            },
            byRegime: [],
            bySession: [],
            byPlaybook: [],
            behavioral: {
                revengeClusters: [],
                maxLossStreak: 0,
                postLossSample: 0,
                postLossExpectancyR: null,
            },
            findings: [],
        };
    }

    const withMfe = merged.filter((r): r is AutopsyRow & { mfeR: number } => typeof r.mfeR === 'number');
    const givebackEligible = withMfe.filter(r => r.mfeR >= MFE_GIVEBACK_PEAK_R);
    const givebackCount = givebackEligible.filter(r => r.outcomeR <= MFE_GIVEBACK_EXIT_MAX_R).length;
    const givebackRate = givebackEligible.length > 0 ? r4(givebackCount / givebackEligible.length) : null;
    const givebackFlagged = givebackCount >= 2 && givebackRate !== null && givebackRate >= 0.4;

    const stopRows = merged.filter(r => r.isStopOut && typeof r.mfeR === 'number') as Array<AutopsyRow & { mfeR: number }>;
    const immediateStopCount = stopRows.filter(r => r.mfeR < IMMEDIATE_STOP_MFE_MAX_R).length;
    const immediateStopRate = stopRows.length > 0 ? r4(immediateStopCount / stopRows.length) : null;
    const immediateStopFlagged = immediateStopCount >= 3 && immediateStopRate !== null && immediateStopRate >= 0.6;

    const avgOutcomeR = r4(merged.reduce((s, r) => s + r.outcomeR, 0) / sampleCount);
    const avgMfeR = withMfe.length > 0 ? r4(withMfe.reduce((s, r) => s + r.mfeR, 0) / withMfe.length) : null;
    const withMae = merged.filter((r): r is AutopsyRow & { maeR: number } => typeof r.maeR === 'number');
    const avgMaeR = withMae.length > 0 ? r4(withMae.reduce((s, r) => s + r.maeR, 0) / withMae.length) : null;
    const holdsMin = merged
        .map(r => Math.max(0, (r.closedAtMs - r.openedAtMs) / 60_000))
        .filter(Number.isFinite);
    const avgHoldMinutes = holdsMin.length > 0
        ? r2(holdsMin.reduce((s, m) => s + m, 0) / holdsMin.length)
        : null;
    const captureEfficiency = avgMfeR !== null && avgMfeR > 0 ? r4(avgOutcomeR / avgMfeR) : null;

    const byRegime = aggregateBuckets(merged, r => r.regime);
    const bySession = aggregateBuckets(merged, r => classifyUtcSession(r.openedAtMs));
    const byPlaybook = aggregateBuckets(merged, r => r.playbook);

    // Behavioral clusters: same-symbol re-entries opened quickly after a losing exit
    // (tracked per symbol so interleaved symbols never mask a revenge entry) + streak metrics.
    const revengeClusters: RevengeCluster[] = [];
    const lastLossCloseBySymbol = new Map<string, { id: string; closedAtMs: number; outcomeR: number }>();
    const postLossOutcomes: number[] = [];
    let maxLossStreak = 0;
    let curStreak = 0;

    for (let i = 0; i < merged.length; i += 1) {
        const cur = merged[i];
        if (cur.outcomeR <= 0) {
            curStreak += 1;
            if (curStreak > maxLossStreak) maxLossStreak = curStreak;
        } else {
            curStreak = 0;
        }
        if (i > 0 && merged[i - 1].outcomeR <= 0) {
            postLossOutcomes.push(cur.outcomeR);
        }
        const priorLoss = lastLossCloseBySymbol.get(cur.symbol);
        if (priorLoss) {
            const gapMs = cur.openedAtMs - priorLoss.closedAtMs;
            if (gapMs >= 0 && gapMs <= REVENGE_WINDOW_MS) {
                revengeClusters.push({
                    priorId: priorLoss.id,
                    reentryId: cur.id,
                    symbol: cur.symbol,
                    gapMinutes: r2(gapMs / 60_000),
                    priorOutcomeR: r4(priorLoss.outcomeR),
                    reentryOutcomeR: r4(cur.outcomeR),
                });
            }
        }
        if (cur.outcomeR <= 0) {
            lastLossCloseBySymbol.set(cur.symbol, { id: cur.id, closedAtMs: cur.closedAtMs, outcomeR: cur.outcomeR });
        } else {
            lastLossCloseBySymbol.delete(cur.symbol);
        }
    }

    const postLossExpectancyR = postLossOutcomes.length > 0
        ? r4(postLossOutcomes.reduce((s, v) => s + v, 0) / postLossOutcomes.length)
        : null;

    const findings: string[] = [];
    if (givebackFlagged && givebackRate !== null) {
        findings.push(
            `MFE giveback leak: ${givebackCount}/${givebackEligible.length} (${Math.round(givebackRate * 100)}%) trades reaching >= +${MFE_GIVEBACK_PEAK_R}R closed <= +${MFE_GIVEBACK_EXIT_MAX_R}R — review trailing stop or partial take-profit timing.`,
        );
    }
    if (immediateStopFlagged && immediateStopRate !== null) {
        findings.push(
            `Immediate stop-out leak: ${immediateStopCount}/${stopRows.length} (${Math.round(immediateStopRate * 100)}%) losing trades reversed before reaching +${IMMEDIATE_STOP_MFE_MAX_R}R — entries are chasing into structural invalidation.`,
        );
    }
    if (revengeClusters.length >= 2) {
        const revengeAvgR = r2(revengeClusters.reduce((s, c) => s + c.reentryOutcomeR, 0) / revengeClusters.length);
        findings.push(
            `Revenge re-entry cluster: ${revengeClusters.length} rapid same-symbol re-entr(y/ies) within 30m of a loss (avg post-loss re-entry ${revengeAvgR}R) — enforce a post-loss cooldown.`,
        );
    }
    for (const b of bySession.filter(s => s.flaggedLeak)) {
        findings.push(
            `Session leak (${b.key} UTC, N=${b.sample}): WR ${Math.round(b.winRate * 100)}%, expectancy ${b.expectancyR}R.`,
        );
    }
    for (const b of byRegime.filter(s => s.flaggedLeak)) {
        findings.push(
            `Regime leak (${b.key}, N=${b.sample}): WR ${Math.round(b.winRate * 100)}%, expectancy ${b.expectancyR}R.`,
        );
    }
    for (const b of byPlaybook.filter(s => s.flaggedLeak)) {
        findings.push(
            `Playbook leak (${b.key}, N=${b.sample}): WR ${Math.round(b.winRate * 100)}%, expectancy ${b.expectancyR}R.`,
        );
    }

    return {
        sampleCount,
        sufficientSample: true,
        refusalReason: null,
        mfeGiveback: {
            eligible: givebackEligible.length,
            count: givebackCount,
            rate: givebackRate,
            flagged: givebackFlagged,
        },
        immediateStopOut: {
            eligible: stopRows.length,
            count: immediateStopCount,
            rate: immediateStopRate,
            flagged: immediateStopFlagged,
        },
        efficiency: {
            avgOutcomeR,
            avgMfeR,
            avgMaeR,
            avgHoldMinutes,
            captureEfficiency,
        },
        byRegime,
        bySession,
        byPlaybook,
        behavioral: {
            revengeClusters,
            maxLossStreak,
            postLossSample: postLossOutcomes.length,
            postLossExpectancyR,
        },
        findings,
    };
};

/** Compact deterministic prompt summary of verified autopsy findings (empty when thin or clean). */
export const formatAutopsyForPrompt = (report: ExecutionAutopsyReport): string => {
    if (!report.sufficientSample) {
        return report.refusalReason ?? '';
    }
    if (report.findings.length === 0) {
        return `Execution autopsy (N=${report.sampleCount}): avg ${report.efficiency.avgOutcomeR ?? 0}R, no statistical leaks detected.`;
    }
    return [
        `Execution autopsy (N=${report.sampleCount}, avg ${report.efficiency.avgOutcomeR ?? 0}R):`,
        ...report.findings.map(f => `- ${f}`),
    ].join('\n');
};
