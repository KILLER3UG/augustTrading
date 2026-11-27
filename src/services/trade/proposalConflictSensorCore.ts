/**
 * proposalConflictSensorCore — deterministic 5-check pre-proposal conflict sensor.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, storage, or network imports
 * (`check:boundaries` enforces this).
 *
 * Evaluates a candidate trade proposal across 5 objective dimensions:
 *  1. `htf_regime_conflict`      — higher-TF (4h / 1h) cached regime opposes direction or chop breakout
 *  2. `spot_perp_conflict`       — spot_vs_perp flow contradicts direction (`perp_chasing` / aligned opposite)
 *  3. `replay_base_rate_conflict`— setup_replay / gate base rate negative expectancy or <40% WR (N >= 5)
 *  4. `correlated_heat_conflict` — projected BTC-beta portfolio heat >= 80% of cap (without reducing net heat)
 *  5. `extreme_funding_conflict` — live/cached 8h funding >= +0.05% on Long or <= -0.05% on Short
 *
 * Triggers the bounded 1-pass LLM adversary critique strictly when `flags.length >= 2`.
 */

import {
    computeCorrelatedPortfolioHeat,
    DEFAULT_PRE_TRADE_HOOKS_SETTINGS,
    EXTREME_FUNDING_THRESHOLD,
    type HeatPositionInput,
} from '../paper/preTradeHooksCore';
import type { SpotVsPerpRegime } from '../market/spotVsPerpCore';

export type ProposalConflictFlagId =
    | 'htf_regime_conflict'
    | 'spot_perp_conflict'
    | 'replay_base_rate_conflict'
    | 'correlated_heat_conflict'
    | 'extreme_funding_conflict';

export interface ProposalConflictFlag {
    id: ProposalConflictFlagId;
    severity: 'warn' | 'high';
    label: string;
    detail: string;
}

export interface ProposalReplayBaseRateInput {
    sampleCount: number;
    /** Win rate in 0..1 (or 0..100 — normalized automatically). */
    winRate?: number | null;
    expectancyR?: number | null;
}

export interface ProposalConflictSensorInput {
    symbol: string;
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfits: readonly number[];
    rationale?: string;
    /** Cached per-TF regimes (prefer 4h -> 1h -> fallback `regime`). */
    regimesByTf?: Partial<Record<'15m' | '1h' | '4h', string>> | null;
    regime?: string | null;
    /** Optional spot_vs_perp flow regime when cached/supplied. */
    spotPerpRegime?: SpotVsPerpRegime | 'unavailable' | null;
    /** Optional setup_replay or gate base-rate statistics (evaluated only when N >= 5). */
    replayStats?: ProposalReplayBaseRateInput | null;
    /** Open paper positions for BTC-beta correlated heat projection. */
    openPositions?: readonly HeatPositionInput[] | null;
    equityUsd?: number | null;
    candidateRiskPct?: number | null;
    maxCorrelatedHeatPct?: number | null;
    betaOverrides?: Readonly<Record<string, number>>;
    /** Live/cached 8h funding rate in decimal (e.g. 0.0005 = +0.05%/8h). */
    fundingRate?: number | null;
}

export interface ProposalConflictSensorResult {
    flags: ProposalConflictFlag[];
    flagCount: number;
    severity: 'clear' | 'caution' | 'high';
    shouldInvokeAdversary: boolean;
}

const FADE_OR_RECLAIM_RE = /\b(?:fade|reclaim|sweep|mean[\s-]?revert|range[\s-]?(?:high|low|edge|boundar))\b/i;
const MIN_BASE_RATE_SAMPLE = 5;

const normalizeWinRate01 = (raw: number | null | undefined): number | null => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
    return raw > 1 ? raw / 100 : raw;
};

/** Deterministically score 5 conflict checks for a candidate trade proposal. */
export const evaluateProposalConflicts = (
    input: ProposalConflictSensorInput,
): ProposalConflictSensorResult => {
    const flags: ProposalConflictFlag[] = [];
    const dir = input.direction;
    const isLong = dir === 'Long';

    // 1. HTF Regime Alignment (prefer 4h, then 1h, then general regime)
    const htfTf = input.regimesByTf?.['4h']
        ? '4h'
        : input.regimesByTf?.['1h']
            ? '1h'
            : null;
    const rawRegime = (htfTf ? input.regimesByTf?.[htfTf] : input.regime) ?? '';
    const regHead = rawRegime.trim().toLowerCase().split(':')[0]?.trim() ?? '';
    if (regHead) {
        const isBearRegime = regHead === 'bear' || regHead === 'bearish' || regHead === 'downtrend' || regHead === 'down';
        const isBullRegime = regHead === 'bull' || regHead === 'bullish' || regHead === 'uptrend' || regHead === 'up';
        const isChopRegime = regHead === 'chop' || regHead === 'choppy' || regHead === 'range' || regHead === 'ranging';
        const tfLabel = htfTf ?? 'HTF';

        if (isLong && isBearRegime) {
            flags.push({
                id: 'htf_regime_conflict',
                severity: 'high',
                label: `${tfLabel} regime opposes Long`,
                detail: `${tfLabel} cached regime is ${regHead}; longing counter-trend requires tight sweep/reclaim confirmation.`,
            });
        } else if (!isLong && isBullRegime) {
            flags.push({
                id: 'htf_regime_conflict',
                severity: 'high',
                label: `${tfLabel} regime opposes Short`,
                detail: `${tfLabel} cached regime is ${regHead}; shorting counter-trend requires clear exhaustion/failure.`,
            });
        } else if (isChopRegime && !FADE_OR_RECLAIM_RE.test(input.rationale ?? '')) {
            flags.push({
                id: 'htf_regime_conflict',
                severity: 'warn',
                label: `Chop/range regime (${tfLabel})`,
                detail: `${tfLabel} regime is ${regHead} with no explicit range-edge fade/reclaim thesis stated.`,
            });
        }
    }

    // 2. Spot-vs-Perp Flow Conflict
    const flow = input.spotPerpRegime;
    if (flow && flow !== 'unavailable') {
        if (flow === 'perp_chasing') {
            flags.push({
                id: 'spot_perp_conflict',
                severity: 'warn',
                label: 'Perp chasing without spot support',
                detail: 'spot_vs_perp flow reads perp_chasing — leveraged crowding increases sweep-stop risk.',
            });
        } else if (isLong && flow === 'aligned_bear') {
            flags.push({
                id: 'spot_perp_conflict',
                severity: 'high',
                label: 'Spot + Perp flow aligned bearish',
                detail: 'Both spot and perp CVD are aligned_bear against a Long proposal.',
            });
        } else if (!isLong && flow === 'aligned_bull') {
            flags.push({
                id: 'spot_perp_conflict',
                severity: 'high',
                label: 'Spot + Perp flow aligned bullish',
                detail: 'Both spot and perp CVD are aligned_bull against a Short proposal.',
            });
        }
    }

    // 3. Setup Replay / Gate Base-Rate Conflict (only when N >= 5)
    const stats = input.replayStats;
    if (stats && Number.isFinite(stats.sampleCount) && stats.sampleCount >= MIN_BASE_RATE_SAMPLE) {
        const wr = normalizeWinRate01(stats.winRate);
        const expR = typeof stats.expectancyR === 'number' && Number.isFinite(stats.expectancyR)
            ? stats.expectancyR
            : null;
        const negExp = expR !== null && expR < 0;
        const lowWr = wr !== null && wr < 0.4;
        if (negExp || lowWr) {
            const parts: string[] = [`N=${stats.sampleCount}`];
            if (wr !== null) parts.push(`WR ${(wr * 100).toFixed(0)}%`);
            if (expR !== null) parts.push(`exp ${expR >= 0 ? '+' : ''}${expR.toFixed(2)}R`);
            flags.push({
                id: 'replay_base_rate_conflict',
                severity: negExp ? 'high' : 'warn',
                label: 'Weak historical base rate',
                detail: `Historical sample (${parts.join(', ')}) fails minimum expectancy/hit-rate floor.`,
            });
        }
    }

    // 4. BTC-Beta Correlated Portfolio Heat Conflict (>= 80% of cap, non-hedging)
    const capPct =
        typeof input.maxCorrelatedHeatPct === 'number' && Number.isFinite(input.maxCorrelatedHeatPct) && input.maxCorrelatedHeatPct > 0
            ? input.maxCorrelatedHeatPct
            : DEFAULT_PRE_TRADE_HOOKS_SETTINGS.maxCorrelatedHeatPct;
    const openPositions = input.openPositions ?? [];
    if (openPositions.length > 0) {
        const candidateRiskPct =
            typeof input.candidateRiskPct === 'number' && Number.isFinite(input.candidateRiskPct) && input.candidateRiskPct > 0
                ? input.candidateRiskPct
                : 1.0;
        const heat = computeCorrelatedPortfolioHeat({
            positions: openPositions,
            equityUsd: typeof input.equityUsd === 'number' && input.equityUsd > 0 ? input.equityUsd : undefined,
            candidate: {
                symbol: input.symbol,
                side: isLong ? 'long' : 'short',
                riskPct: candidateRiskPct,
            },
            betaOverrides: input.betaOverrides,
        });
        if (!heat.reducesNetHeat && heat.projectedAbsNetBetaHeatPct >= capPct * 0.8) {
            const breachesCap = heat.projectedAbsNetBetaHeatPct > capPct;
            flags.push({
                id: 'correlated_heat_conflict',
                severity: breachesCap ? 'high' : 'warn',
                label: breachesCap ? 'BTC-beta heat breaches cap' : 'BTC-beta heat near cap',
                detail: `Projected net BTC-beta heat ${heat.projectedAbsNetBetaHeatPct.toFixed(2)}% vs ${capPct.toFixed(1)}% cap (${openPositions.length} open).`,
            });
        }
    }

    // 5. Extreme Funding Crowding Conflict (>= +0.05%/8h on Long or <= -0.05%/8h on Short)
    if (typeof input.fundingRate === 'number' && Number.isFinite(input.fundingRate)) {
        const crowdedLong = isLong && input.fundingRate >= EXTREME_FUNDING_THRESHOLD;
        const crowdedShort = !isLong && input.fundingRate <= -EXTREME_FUNDING_THRESHOLD;
        if (crowdedLong || crowdedShort) {
            const pct = (input.fundingRate * 100).toFixed(4);
            flags.push({
                id: 'extreme_funding_conflict',
                severity: 'warn',
                label: `Crowded ${isLong ? 'long' : 'short'} funding`,
                detail: `Live 8h funding is ${input.fundingRate >= 0 ? '+' : ''}${pct}%/8h — entering on the crowded carry side.`,
            });
        }
    }

    const flagCount = flags.length;
    const shouldInvokeAdversary = flagCount >= 2;
    const severity: 'clear' | 'caution' | 'high' =
        flagCount >= 2 ? 'high' : flagCount === 1 ? 'caution' : 'clear';

    return {
        flags,
        flagCount,
        severity,
        shouldInvokeAdversary,
    };
};
