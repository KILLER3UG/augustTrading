/**
 * preTradeHooksCore — deterministic Pre-Trade Hooks & BTC-beta Correlated Heat.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, `localStorage`, or network
 * imports (`check:boundaries` enforces this).
 *
 * Enforced in `PaperBrokerService.submitPaperOrder` on open orders ONLY
 * (`open_market`, `open_limit`) — never blocking `close`, `cancel`, or
 * `modify_sl_tp`, and never blocking risk-reducing hedges.
 */

export interface PreTradeHooksSettings {
    blockCorrelatedHeat: boolean;
    maxCorrelatedHeatPct: number;
    blockChopBreakout: boolean;
    blockExtremeFunding: boolean;
}

export const DEFAULT_PRE_TRADE_HOOKS_SETTINGS: Readonly<PreTradeHooksSettings> = Object.freeze({
    blockCorrelatedHeat: true,
    maxCorrelatedHeatPct: 3.0,
    blockChopBreakout: false,
    blockExtremeFunding: false,
});

export const EXTREME_FUNDING_THRESHOLD = 0.0005;

export const normalizePreTradeHooksSettings = (
    input?: Partial<PreTradeHooksSettings> | null,
): PreTradeHooksSettings => {
    const d = DEFAULT_PRE_TRADE_HOOKS_SETTINGS;
    const rawCap = input?.maxCorrelatedHeatPct;
    const maxCorrelatedHeatPct = typeof rawCap === 'number' && Number.isFinite(rawCap)
        ? Math.round(Math.min(20, Math.max(0.5, rawCap)) * 100) / 100
        : d.maxCorrelatedHeatPct;
    return {
        blockCorrelatedHeat: input?.blockCorrelatedHeat !== false,
        maxCorrelatedHeatPct,
        blockChopBreakout: input?.blockChopBreakout === true,
        blockExtremeFunding: input?.blockExtremeFunding === true,
    };
};

const MAJOR_L1_L2_COINS: ReadonlySet<string> = new Set([
    'SOL', 'BNB', 'AVAX', 'ADA', 'XRP', 'ARB', 'OP', 'SUI', 'TON',
    'NEAR', 'APT', 'MATIC', 'POL', 'DOT', 'LINK', 'ATOM', 'LTC', 'BCH', 'TRX', 'SEI', 'TIA',
]);

const baseCoinOf = (symbol: string): string => {
    const clean = (symbol || '').trim().toUpperCase();
    return clean.replace(/(?:USDT|USDC|BUSD|PERP)$/i, '');
};

/** Resolve deterministic BTC-beta multiplier for a symbol. */
export const resolveBtcBeta = (
    symbol: string,
    betaOverrides?: Readonly<Record<string, number>>,
): number => {
    const clean = (symbol || '').trim().toUpperCase();
    const base = baseCoinOf(clean);
    if (betaOverrides) {
        const direct = betaOverrides[clean] ?? betaOverrides[base];
        if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
            return direct;
        }
    }
    if (base === 'BTC') return 1.0;
    if (base === 'ETH') return 1.15;
    if (MAJOR_L1_L2_COINS.has(base)) return 1.35;
    return 1.55;
};

export interface HeatPositionInput {
    symbol: string;
    side: 'long' | 'short';
    riskUsd?: number;
    riskPct?: number;
}

export interface CorrelatedPositionBreakdown {
    symbol: string;
    side: 'long' | 'short';
    riskPct: number;
    beta: number;
    signedHeatPct: number;
}

export interface CorrelatedPortfolioHeatInput {
    positions: readonly HeatPositionInput[];
    equityUsd?: number;
    candidate?: HeatPositionInput | null;
    betaOverrides?: Readonly<Record<string, number>>;
}

export interface CorrelatedPortfolioHeatResult {
    currentGrossBetaHeatPct: number;
    currentNetBetaHeatPct: number;
    currentAbsNetBetaHeatPct: number;
    projectedGrossBetaHeatPct: number;
    projectedNetBetaHeatPct: number;
    projectedAbsNetBetaHeatPct: number;
    candidateBeta: number | null;
    candidateSignedHeatPct: number | null;
    reducesNetHeat: boolean;
    byPosition: CorrelatedPositionBreakdown[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

const positionRiskPct = (p: HeatPositionInput, equityUsd: number): number => {
    if (typeof p.riskPct === 'number' && Number.isFinite(p.riskPct) && p.riskPct > 0) {
        return p.riskPct;
    }
    if (typeof p.riskUsd === 'number' && Number.isFinite(p.riskUsd) && p.riskUsd > 0 && equityUsd > 0) {
        return (p.riskUsd / equityUsd) * 100;
    }
    return 1.0;
};

/** Compute gross & signed net BTC-beta portfolio heat % and optional candidate projection. */
export const computeCorrelatedPortfolioHeat = (
    input: CorrelatedPortfolioHeatInput,
): CorrelatedPortfolioHeatResult => {
    const equityUsd = typeof input.equityUsd === 'number' && Number.isFinite(input.equityUsd) && input.equityUsd > 0
        ? input.equityUsd
        : 10_000;
    const byPosition: CorrelatedPositionBreakdown[] = [];
    let currentGross = 0;
    let currentNet = 0;

    for (const pos of input.positions ?? []) {
        const riskPct = positionRiskPct(pos, equityUsd);
        const beta = resolveBtcBeta(pos.symbol, input.betaOverrides);
        const sign = pos.side === 'short' ? -1 : 1;
        const signed = sign * riskPct * beta;
        currentGross += riskPct * beta;
        currentNet += signed;
        byPosition.push({
            symbol: (pos.symbol || '').trim().toUpperCase(),
            side: pos.side,
            riskPct: r2(riskPct),
            beta: r2(beta),
            signedHeatPct: r2(signed),
        });
    }

    const currentAbsNet = Math.abs(currentNet);
    if (!input.candidate) {
        return {
            currentGrossBetaHeatPct: r2(currentGross),
            currentNetBetaHeatPct: r2(currentNet),
            currentAbsNetBetaHeatPct: r2(currentAbsNet),
            projectedGrossBetaHeatPct: r2(currentGross),
            projectedNetBetaHeatPct: r2(currentNet),
            projectedAbsNetBetaHeatPct: r2(currentAbsNet),
            candidateBeta: null,
            candidateSignedHeatPct: null,
            reducesNetHeat: false,
            byPosition,
        };
    }

    const candRiskPct = positionRiskPct(input.candidate, equityUsd);
    const candBeta = resolveBtcBeta(input.candidate.symbol, input.betaOverrides);
    const candSign = input.candidate.side === 'short' ? -1 : 1;
    const candSigned = candSign * candRiskPct * candBeta;
    const projectedGross = currentGross + candRiskPct * candBeta;
    const projectedNet = currentNet + candSigned;
    const projectedAbsNet = Math.abs(projectedNet);
    const reducesNetHeat = currentAbsNet > 0 && projectedAbsNet < currentAbsNet - 1e-9;

    return {
        currentGrossBetaHeatPct: r2(currentGross),
        currentNetBetaHeatPct: r2(currentNet),
        currentAbsNetBetaHeatPct: r2(currentAbsNet),
        projectedGrossBetaHeatPct: r2(projectedGross),
        projectedNetBetaHeatPct: r2(projectedNet),
        projectedAbsNetBetaHeatPct: r2(projectedAbsNet),
        candidateBeta: r2(candBeta),
        candidateSignedHeatPct: r2(candSigned),
        reducesNetHeat,
        byPosition,
    };
};

export interface PreTradeHookViolation {
    hook: 'correlated_heat' | 'chop_breakout' | 'extreme_funding';
    reason: string;
}

export interface EvaluatePreTradeHooksInput {
    hooks: PreTradeHooksSettings;
    positions: readonly HeatPositionInput[];
    equityUsd?: number;
    candidate: HeatPositionInput & {
        thesis?: string;
        skillSlug?: string;
    };
    regime?: string | null;
    fundingRate?: number | null;
    betaOverrides?: Readonly<Record<string, number>>;
}

export interface EvaluatePreTradeHooksResult {
    ok: boolean;
    violations: PreTradeHookViolation[];
    reason?: string;
    heat: CorrelatedPortfolioHeatResult;
}

const CHOP_REGIME_RE = /chop|range|sideways|tight/i;
const RANGE_PLAY_RE = /fade|reclaim|sweep|mean|range/i;

/** Evaluate all deterministic Pre-Trade Hooks against a candidate open order. */
export const evaluatePreTradeHooks = (
    input: EvaluatePreTradeHooksInput,
): EvaluatePreTradeHooksResult => {
    const hooks = normalizePreTradeHooksSettings(input.hooks);
    const heat = computeCorrelatedPortfolioHeat({
        positions: input.positions,
        equityUsd: input.equityUsd,
        candidate: input.candidate,
        betaOverrides: input.betaOverrides,
    });

    const violations: PreTradeHookViolation[] = [];

    // 1. Correlated portfolio BTC-beta heat cap (risk-reducing hedges always allowed)
    if (
        hooks.blockCorrelatedHeat
        && !heat.reducesNetHeat
        && heat.projectedAbsNetBetaHeatPct > hooks.maxCorrelatedHeatPct + 1e-9
    ) {
        violations.push({
            hook: 'correlated_heat',
            reason: `correlated_heat: projected net BTC-beta heat ${heat.projectedAbsNetBetaHeatPct.toFixed(2)}% exceeds ${hooks.maxCorrelatedHeatPct.toFixed(2)}% cap (current ${heat.currentNetBetaHeatPct.toFixed(2)}%, ${input.candidate.symbol} beta ${heat.candidateBeta?.toFixed(2)}x)`,
        });
    }

    // 2. Chop-regime breakout blocker (explicit range/fade/reclaim/sweep/mean plays allowed)
    if (hooks.blockChopBreakout && input.regime && CHOP_REGIME_RE.test(input.regime)) {
        const metaText = `${input.candidate.thesis ?? ''} ${input.candidate.skillSlug ?? ''}`;
        if (!RANGE_PLAY_RE.test(metaText)) {
            violations.push({
                hook: 'chop_breakout',
                reason: `chop_breakout: regime is "${input.regime}" — breakout entry blocked unless thesis/playbook specifies fade/reclaim/sweep/mean/range`,
            });
        }
    }

    // 3. Extreme-funding crowded-side blocker (counter-trend side allowed)
    if (
        hooks.blockExtremeFunding
        && typeof input.fundingRate === 'number'
        && Number.isFinite(input.fundingRate)
        && Math.abs(input.fundingRate) >= EXTREME_FUNDING_THRESHOLD
    ) {
        const bps = (input.fundingRate * 10_000).toFixed(1);
        const crowdedLong = input.fundingRate >= EXTREME_FUNDING_THRESHOLD && input.candidate.side === 'long';
        const crowdedShort = input.fundingRate <= -EXTREME_FUNDING_THRESHOLD && input.candidate.side === 'short';
        if (crowdedLong || crowdedShort) {
            violations.push({
                hook: 'extreme_funding',
                reason: `extreme_funding: ${input.candidate.side} blocked into crowded ${input.fundingRate > 0 ? '+' : ''}${bps}bps funding (${input.fundingRate > 0 ? 'shorts' : 'longs'} counter-side allowed)`,
            });
        }
    }

    return {
        ok: violations.length === 0,
        violations,
        reason: violations.length > 0 ? violations.map(v => v.reason).join(' · ') : undefined,
        heat,
    };
};
