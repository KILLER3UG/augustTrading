/**
 * MonteCarloService
 * Simulates randomized price paths to stress-test trade setups.
 * 
 * Features:
 * 1. Run 1000 Monte Carlo simulations using Geometric Brownian Motion
 * 2. Calculate probability distribution of outcomes (TP1/TP2/TP3/SL)
 * 3. Calculate ruin risk given position sizing
 * 4. Generate UI-friendly summaries
 */

// =============================================================================
// TYPES
// =============================================================================

import { clamp01 } from '../../utils/math';
import { targetsByDistance } from '../../utils/riskReward';

export interface MonteCarloResult {
    simulations: number;
    winRate: number;                  // % of sims hitting any TP
    winCount: number;                 // Number of winning sims
    expectedValue: number;            // Average PnL % per trade (resolved sims only; TIMEOUT PnLs excluded)
    timeframe: string;                // Timeframe used for simulation
    /** Mean PnL % over the POSITIVE-PnL samples (true average win). Optional
     *  because legacy/cached results may predate it; consumers should prefer
     *  it over the EV/winRate proxy when present. */
    avgWinPercent?: number;
    /** Mean PnL % magnitude over the negative-PnL samples (true average
     *  loss, as a positive number). Same optionality rationale. */
    avgLossPercent?: number;
    /** RNG seed actually used — derived from the setup identity when no
     *  explicit seed was passed, so the same setup yields the same
     *  "Simulated Win Rate" run after run. */
    seedUsed?: number;
    /** Sims that RESOLVED (hit a TP or the SL), i.e. simulations − TIMEOUT.
     *  Kelly inputs are computed on this subsample so p, EV and the win/loss
     *  means all describe the same set. Optional for legacy/cached results
     *  that predate it (derivable from probabilities.timeout). */
    resolvedCount?: number;
    probabilities: {
        tp1Hit: number;
        tp2Hit: number;
        tp3Hit: number;
        slHit: number;
        timeout: number;              // Neither TP nor SL hit within max steps
    };
    maxDrawdownAvg: number;           // Average max drawdown before outcome
    timeToOutcomeAvg: number;         // Average steps until resolution
    confidenceInterval: {
        lower: number;                // 5th percentile outcome
        upper: number;                // 95th percentile outcome
    };
}

// Labeled Monte Carlo result for per-AI display
export interface LabeledMonteCarloResult {
    provider: string;                 // e.g., "Gemini", "DeepSeek", "Moderator"
    result: MonteCarloResult;
    isModeratorFinal?: boolean;       // True if this is from the final moderated setup
}

export interface RuinRiskResult {
    prob25pctDrawdown: number;
    prob50pctDrawdown: number;
    prob75pctDrawdown: number;
    expectedEquityAfter100: number;   // Expected account value after 100 trades
    kellyOptimalSize: number;         // Kelly criterion position size (0-1)
}

export interface SimulationConfig {
    entry: number;
    stopLoss: number;
    takeProfits: number[];            // [TP1, TP2, TP3]
    /** Explicit plans must not acquire the legacy fallback targets. */
    explicitTargetsOnly?: boolean;
    direction: 'Long' | 'Short';
    atr: number;                      // Current ATR for volatility
    timeframe: string;                // Timeframe of the chart
    trendBias?: number;               // -1 to 1 (negative = bearish, positive = bullish)
    numSimulations?: number;          // Default 1000
    maxSteps?: number;                // Max candles to simulate (default 100)
    marketRegime?: 'strong_trend_up' | 'strong_trend_down' | 'weak_trend_up' | 'weak_trend_down' | 'ranging' | 'volatile_chop' | 'compression';
    /** Explicit RNG seed. When omitted the seed is derived deterministically
     *  from the setup identity (see deriveSetupSeed) so re-running the same
     *  setup no longer yields a different "Simulated Win Rate". */
    seed?: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_SIMULATIONS = 1000;
const DEFAULT_MAX_STEPS = 100;
const ATR_VOLATILITY_FACTOR = 0.5;    // How much of ATR represents per-step volatility
const BIAS_STRENGTH = 0.001;          // How much trend bias affects drift

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Deterministic PRNG (mulberry32). The simulations used raw Math.random(),
 * so the same setup produced a different "Simulated Win Rate" on every run
 * — while the prompt explicitly tells the model to use it to validate
 * confidence. A seeded generator makes results reproducible per setup; the
 * worker and the synchronous fallback import the same code, so both paths
 * yield identical numbers for identical inputs. `runSimulation` has always
 * been seeded; `calculateRuinRisk` now threads the same seeded generator
 * through its 1000×100 trade loop, so the whole module's determinism claim
 * is actually true.
 */
export const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return (): number => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * FNV-1a over an identity string — the shared hashing path behind every
 * derived seed in this module (setup identity AND ruin-risk inputs), so
 * "rerun this setup" is stable everywhere while a genuinely different
 * input still gets a different sample.
 */
const hashIdentity = (identity: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < identity.length; i++) {
        h ^= identity.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
};

/**
 * FNV-1a hash of the setup identity (entry/SL/TPs/direction/ATR/timeframe/
 * bias/regime) → stable seed so "rerun this setup" is stable, while a
 * genuinely different setup still gets a different sample of paths.
 */
export const deriveSetupSeed = (config: SimulationConfig): number => {
    const identity = [
        config.entry,
        config.stopLoss,
        (config.takeProfits || []).join(','),
        config.direction,
        config.atr,
        config.timeframe,
        config.trendBias ?? 0,
        config.marketRegime ?? 'default'
    ].join('|');
    return hashIdentity(identity);
};

/**
 * Seed for the ruin simulation, derived from ITS inputs: the Monte Carlo
 * result (which carries `seedUsed` — i.e. the setup identity that produced
 * it), plus the account parameters. `calculateRuinRisk` runs the same code
 * on the worker and the synchronous fallback over exactly these arguments,
 * so the derived seed (and therefore the drawdown probabilities) are
 * identical across both paths without any caller having to pass one.
 */
export const deriveRuinRiskSeed = (
    accountBalance: number,
    positionSize: number,
    leverage: number,
    monteCarloResult: MonteCarloResult
): number => hashIdentity([
    monteCarloResult.seedUsed ?? 0,
    monteCarloResult.simulations,
    monteCarloResult.winRate,
    monteCarloResult.expectedValue,
    monteCarloResult.timeframe,
    accountBalance,
    positionSize,
    leverage
].join('|'));

/**
 * Generate a random number from standard normal distribution (Box-Muller
 * transform) using the supplied seeded generator instead of Math.random().
 */
const randomNormal = (rng: () => number): number => {
    // Guard against rng() === 0 → log(0) = -Infinity → infinite paths.
    const u1 = Math.max(rng(), 1e-300);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

/**
 * Volatility Regime Configuration
 */
export interface VolatilityRegimeConfig {
    currentRegime: 'strong_trend' | 'volatile_chop' | 'compression' | 'normal';
    regimeMultipliers: {
        strong_trend: { vol: number; drift: number };
        volatile_chop: { vol: number; drift: number };
        compression: { vol: number; drift: number };
        normal: { vol: number; drift: number };
    };
    switchProb: number; // Probability of switching regime per step (Markov chain)
}

const DEFAULT_REGIME_CONFIG: VolatilityRegimeConfig = {
    currentRegime: 'normal',
    regimeMultipliers: {
        strong_trend: { vol: 0.8, drift: 1.2 },    // Smoother moves, stronger trend
        volatile_chop: { vol: 1.5, drift: 0.2 },   // Wild swings, weak trend
        compression: { vol: 0.5, drift: 0.1 },     // Tight range, no trend
        normal: { vol: 1.0, drift: 1.0 }           // Baseline
    },
    switchProb: 0.05 // 5% chance to switch regime per candle
};

/**
 * Simulate one price path using Geometric Brownian Motion with Regime Switching
 */
const simulatePricePath = (
    startPrice: number,
    baseVolatility: number,
    baseDrift: number,
    steps: number,
    regimeConfig: VolatilityRegimeConfig = DEFAULT_REGIME_CONFIG,
    rng: () => number = Math.random
): number[] => {
    const path = [startPrice];
    let price = startPrice;
    let currentRegime = regimeConfig.currentRegime;

    const regimes = Object.keys(regimeConfig.regimeMultipliers) as (keyof typeof regimeConfig.regimeMultipliers)[];

    for (let i = 0; i < steps; i++) {
        // Markov chain regime switching
        if (rng() < regimeConfig.switchProb) {
            // Switch to a random other regime
            const otherRegimes = regimes.filter(r => r !== currentRegime);
            currentRegime = otherRegimes[Math.floor(rng() * otherRegimes.length)];
        }

        const multipliers = regimeConfig.regimeMultipliers[currentRegime];

        // Adjust volatility and drift based on current regime
        const effectiveVol = baseVolatility * multipliers.vol;
        const effectiveDrift = baseDrift * multipliers.drift;

        // GBM: dS = μS*dt + σS*dW
        const z = randomNormal(rng);
        const logReturn = effectiveDrift - 0.5 * effectiveVol * effectiveVol + effectiveVol * z;
        price = price * Math.exp(logReturn);
        path.push(price);
    }

    return path;
};

/**
 * Check if price path hits targets or stop loss
 */
const evaluatePath = (
    path: number[],
    entry: number,
    stopLoss: number,
    takeProfits: number[],
    direction: 'Long' | 'Short',
    explicitTargetsOnly = false
): {
    outcome: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TIMEOUT';
    pnlPercent: number;
    maxDrawdown: number;
    stepsToOutcome: number;
} => {
    let maxDrawdown = 0;
    let currentDrawdown: number;
    let outcome: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TIMEOUT' = 'TIMEOUT';
    let stepsToOutcome = path.length - 1;
    let exitPrice = path[path.length - 1];

    const isLong = direction === 'Long';
    const absentTarget = isLong ? Infinity : -Infinity;
    // TP1/TP2/TP3 mean nearest, next, farthest — the order the trader takes
    // them, not the order the model happened to list. Array order here made a
    // 3.10R "TP1" out of the farthest target on an out-of-order ladder.
    const orderedTargets = targetsByDistance(entry, takeProfits);
    const tp1 = orderedTargets[0] || (explicitTargetsOnly ? absentTarget : (isLong ? entry * 1.02 : entry * 0.98));
    const tp2 = orderedTargets[1] || (explicitTargetsOnly ? absentTarget : (isLong ? entry * 1.04 : entry * 0.96));
    const tp3 = orderedTargets[2] || (explicitTargetsOnly ? absentTarget : (isLong ? entry * 1.06 : entry * 0.94));

    // Per-step volatility estimate from the path's own log returns — used to
    // synthesize intra-step high/low. A TP/SL touch between closes was
    // previously invisible (only step CLOSES were tested), making MC win
    // rates systematically pessimistic vs. the candle-based outcome engine.
    let stepSigma = 0.01;
    if (path.length > 2) {
        const logReturns: number[] = [];
        for (let i = 1; i < path.length; i++) logReturns.push(Math.log(path[i] / path[i - 1]));
        const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
        const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
        if (variance > 0) stepSigma = Math.sqrt(variance);
    }

    for (let i = 1; i < path.length; i++) {
        const prevPrice = path[i - 1];
        const price = path[i];

        // Intra-step extremes (a candle's high/low, not just its close).
        const stepHigh = Math.max(prevPrice, price) * Math.exp(0.5 * stepSigma);
        const stepLow = Math.min(prevPrice, price) * Math.exp(-0.5 * stepSigma);

        // Calculate drawdown from entry (worst intra-step extreme)
        if (isLong) {
            currentDrawdown = Math.max(0, (entry - stepLow) / entry);
        } else {
            currentDrawdown = Math.max(0, (stepHigh - entry) / entry);
        }
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown);

        // Check stop loss FIRST (same-candle SL+TP → the resting stop filled
        // first — same semantics as the outcome engine).
        if (isLong && stepLow <= stopLoss) {
            outcome = 'SL';
            exitPrice = stopLoss;
            stepsToOutcome = i;
            break;
        } else if (!isLong && stepHigh >= stopLoss) {
            outcome = 'SL';
            exitPrice = stopLoss;
            stepsToOutcome = i;
            break;
        }

        // Check take profits (check higher TPs first for shorts, lower for longs)
        if (isLong) {
            if (stepHigh >= tp3) {
                outcome = 'TP3';
                exitPrice = tp3;
                stepsToOutcome = i;
                break;
            } else if (stepHigh >= tp2) {
                outcome = 'TP2';
                exitPrice = tp2;
                stepsToOutcome = i;
                break;
            } else if (stepHigh >= tp1) {
                outcome = 'TP1';
                exitPrice = tp1;
                stepsToOutcome = i;
                break;
            }
        } else {
            if (stepLow <= tp3) {
                outcome = 'TP3';
                exitPrice = tp3;
                stepsToOutcome = i;
                break;
            } else if (stepLow <= tp2) {
                outcome = 'TP2';
                exitPrice = tp2;
                stepsToOutcome = i;
                break;
            } else if (stepLow <= tp1) {
                outcome = 'TP1';
                exitPrice = tp1;
                stepsToOutcome = i;
                break;
            }
        }
    }

    // Calculate PnL
    let pnlPercent: number;
    if (isLong) {
        pnlPercent = ((exitPrice - entry) / entry) * 100;
    } else {
        pnlPercent = ((entry - exitPrice) / entry) * 100;
    }

    return {
        outcome,
        pnlPercent,
        maxDrawdown: maxDrawdown * 100,
        stepsToOutcome
    };
};

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

/**
 * Run Monte Carlo simulation for a trade setup
 */
export const runSimulation = (config: SimulationConfig): MonteCarloResult => {
    const {
        entry,
        stopLoss,
        takeProfits,
        direction,
        atr,
        timeframe,
        trendBias = 0,
        numSimulations = DEFAULT_SIMULATIONS,
        maxSteps = DEFAULT_MAX_STEPS,
        marketRegime
    } = config;

    // Calculate volatility from ATR (as percentage of price)
    const volatility = (atr / entry) * ATR_VOLATILITY_FACTOR;

    // Calculate drift (trend bias)
    const drift = trendBias * BIAS_STRENGTH;

    // Map regime from RegimeAnalysis string to internal VolatilityRegimeConfig
    const regimeConfig = { ...DEFAULT_REGIME_CONFIG };
    if (marketRegime) {
        if (marketRegime === 'strong_trend_up' || marketRegime === 'strong_trend_down') {
            regimeConfig.currentRegime = 'strong_trend';
        } else if (marketRegime === 'volatile_chop' || marketRegime === 'weak_trend_up' || marketRegime === 'weak_trend_down') {
            // Treat weak trends as potentially choppy or normal. Mapping weak -> volatile_chop for conservative "stress test"
            // or we could map to normal. Let's map weak -> normal, chop -> volatile_chop
            if (marketRegime.includes('weak')) {
                regimeConfig.currentRegime = 'normal';
            } else {
                regimeConfig.currentRegime = 'volatile_chop';
            }
        } else if (marketRegime === 'compression') {
            regimeConfig.currentRegime = 'compression';
        } else {
            regimeConfig.currentRegime = 'normal'; // 'ranging' falls here
        }
    }

    // Seeded RNG: same setup → same paths → same "Simulated Win Rate".
    // An explicit config.seed wins; otherwise the seed is a hash of the
    // setup identity (see deriveSetupSeed).
    const seedUsed = config.seed ?? deriveSetupSeed(config);
    const rng = mulberry32(seedUsed);

    // Results tracking
    const outcomes: ('TP1' | 'TP2' | 'TP3' | 'SL' | 'TIMEOUT')[] = [];
    const pnls: number[] = [];
    const drawdowns: number[] = [];
    const stepsToResolution: number[] = [];

    // Run simulations
    for (let i = 0; i < numSimulations; i++) {
        const path = simulatePricePath(entry, volatility, drift, maxSteps, regimeConfig, rng);
        const result = evaluatePath(path, entry, stopLoss, takeProfits, direction, config.explicitTargetsOnly);

        outcomes.push(result.outcome);
        pnls.push(result.pnlPercent);
        drawdowns.push(result.maxDrawdown);
        stepsToResolution.push(result.stepsToOutcome);
    }

    // Aggregate results
    const tp1Count = outcomes.filter(o => o === 'TP1').length;
    const tp2Count = outcomes.filter(o => o === 'TP2').length;
    const tp3Count = outcomes.filter(o => o === 'TP3').length;
    const slCount = outcomes.filter(o => o === 'SL').length;
    const timeoutCount = outcomes.filter(o => o === 'TIMEOUT').length;

    const winCount = tp1Count + tp2Count + tp3Count;
    const winRate = (winCount / numSimulations) * 100;

    // EV excludes TIMEOUT runs' mark-to-market PnL: a path that never hit TP
    // or SL has no realized trade outcome, and folding its final price into
    // the average (previously) biased EV toward whatever the random walk
    // wandered to. Drawdown/time/CI still describe the full sample.
    const resolvedPnls = pnls.filter((_, i) => outcomes[i] !== 'TIMEOUT');
    const expectedValue = resolvedPnls.length > 0
        ? resolvedPnls.reduce((a, b) => a + b, 0) / resolvedPnls.length
        : 0;

    // TRUE average win/loss = means of the positive / negative PnL samples.
    // (The Kelly input used to be EV/winRate, which is NOT an average win:
    // it subtracts the loss rate out of every win and systematically
    // understates b, shrinking the Kelly fraction.)
    const winSamples = resolvedPnls.filter(p => p > 0);
    const lossSamples = resolvedPnls.filter(p => p < 0);
    const avgWinPercent = winSamples.length > 0
        ? winSamples.reduce((a, b) => a + b, 0) / winSamples.length
        : 0;
    const avgLossPercent = lossSamples.length > 0
        ? Math.abs(lossSamples.reduce((a, b) => a + b, 0) / lossSamples.length)
        : 0;

    const maxDrawdownAvg = drawdowns.reduce((a, b) => a + b, 0) / numSimulations;
    const timeToOutcomeAvg = stepsToResolution.reduce((a, b) => a + b, 0) / numSimulations;

    // Calculate confidence interval (5th and 95th percentile)
    const sortedPnls = [...pnls].sort((a, b) => a - b);
    const lowerIdx = Math.floor(numSimulations * 0.05);
    const upperIdx = Math.floor(numSimulations * 0.95);

    return {
        simulations: numSimulations,
        winRate: Math.round(winRate * 10) / 10,
        winCount,
        expectedValue: Math.round(expectedValue * 100) / 100,
        timeframe,
        avgWinPercent: Math.round(avgWinPercent * 100) / 100,
        avgLossPercent: Math.round(avgLossPercent * 100) / 100,
        seedUsed,
        resolvedCount: numSimulations - timeoutCount,
        probabilities: {
            tp1Hit: Math.round((tp1Count / numSimulations) * 1000) / 10,
            tp2Hit: Math.round((tp2Count / numSimulations) * 1000) / 10,
            tp3Hit: Math.round((tp3Count / numSimulations) * 1000) / 10,
            slHit: Math.round((slCount / numSimulations) * 1000) / 10,
            timeout: Math.round((timeoutCount / numSimulations) * 1000) / 10
        },
        maxDrawdownAvg: Math.round(maxDrawdownAvg * 100) / 100,
        timeToOutcomeAvg: Math.round(timeToOutcomeAvg * 10) / 10,
        confidenceInterval: {
            lower: Math.round(sortedPnls[lowerIdx] * 100) / 100,
            upper: Math.round(sortedPnls[upperIdx] * 100) / 100
        }
    };
};

/**
 * Kelly criterion fraction: f* = (bp - q) / b, with b = avgWin/avgLoss.
 * `winRatePct` must be conditioned on the SAME sample as the money
 * statistics — pass wins/RESOLVED (TP-or-SL) sims, NOT wins/ALL sims.
 * TIMEOUT runs have no realized outcome, so EV/avgWin/avgLoss describe only
 * the resolved subsample; feeding Kelly the unconditional p mixes samples:
 * at long horizons most paths time out, p shrinks toward 0 and a genuinely
 * positive edge (e.g. 3:1) collapses to f* = 0.
 * Guarded against the degenerate cases (winRate 0, zero avg loss, zero b)
 * that previously produced Infinity/NaN, and clamped to [0, 1] (never size
 * more than 100% of the account).
 *
 * A zero/negative-EV system returns 0 — the old code fell back to a hardcoded
 * 2% average win, so ANY system with winRate > 1/3 reported a positive Kelly
 * fraction (up to 100% of the account) even when the setup was a guaranteed
 * loser. Sizing a losing system is worse than not sizing it.
 *
 * `avgWinPctOverride` should be the TRUE average win (mean of the positive
 * PnL sample, i.e. MonteCarloResult.avgWinPercent). Without it the legacy
 * EV/winRate proxy is used — that ratio is NOT an average win (it nets the
 * losses out of every win and is systematically too small), and it biases
 * Kelly down.
 */
export const computeKellyFraction = (
    winRatePct: number,
    expectedValuePct: number,
    slHitPct: number,
    ciLowerPct: number,
    avgWinPctOverride?: number
): number => {
    if (expectedValuePct <= 0) return 0;
    const winRate = winRatePct / 100;
    const lossRate = 1 - winRate;
    const avgWinPercent = typeof avgWinPctOverride === 'number' && avgWinPctOverride > 0
        ? avgWinPctOverride
        : (winRate > 0 ? expectedValuePct / winRate : 0);
    // NOTE: avgLossPercent deliberately uses the 5th-percentile tail PnL
    // (conservative) rather than the mean loss — a documented tail choice,
    // not a bug.
    const avgLossPercent = slHitPct > 0 && Math.abs(ciLowerPct) > 0
        ? Math.abs(ciLowerPct)
        : 1; // Default 1% if unknown
    const b = avgLossPercent > 0 ? avgWinPercent / avgLossPercent : 0;
    return b > 0 ? clamp01((b * winRate - lossRate) / b) : 0;
};

/**
 * Calculate ruin risk given position sizing by simulating 1000 sequences of
 * 100 trades. The loop runs on the SEEDED mulberry32 generator — an explicit
 * `seed` wins; otherwise the seed is derived from the inputs via the same
 * FNV path as deriveSetupSeed (the Monte Carlo result carries the setup
 * identity in `seedUsed`, so it flows through to the worker and the sync
 * fallback automatically). Identical arguments therefore produce identical
 * drawdown probabilities run-to-run AND on both execution paths — the
 * module-level determinism claim previously held only for runSimulation.
 */
export const calculateRuinRisk = (
    accountBalance: number,
    positionSize: number,
    leverage: number,
    monteCarloResult: MonteCarloResult,
    seed?: number
): RuinRiskResult => {
    const winRate = monteCarloResult.winRate / 100;

    // Kelly's p must live on the same RESOLVED subsample as EV/avgWin/avgLoss
    // (a TIMEOUT sim has no realized outcome — counting it as a non-win while
    // the money stats ignore it mixes samples and collapses a positive edge
    // to f* = 0 at long horizons; see computeKellyFraction). winRate itself
    // stays the unconditional share of ALL sims — the honest "Simulated Win
    // Rate" for the UI/prompt and the conservative per-trade win draw in the
    // binary equity loop below (a trade that never tagged TP is treated as
    // not-a-win, which errs toward MORE drawdown risk, not less).
    const timeoutSimCount = Math.round(
        (monteCarloResult.probabilities.timeout / 100) * monteCarloResult.simulations
    );
    const resolvedCount = monteCarloResult.resolvedCount
        ?? Math.max(0, monteCarloResult.simulations - timeoutSimCount);
    const winRatePctResolved = resolvedCount > 0
        ? (monteCarloResult.winCount / resolvedCount) * 100
        : 0;

    // Average win: prefer the TRUE sample mean (mean of positive-PnL sims)
    // recorded on the result. The legacy `expectedValue / winRate` is NOT an
    // average win — it nets the losses out of every win, systematically
    // understates b, and shrinks Kelly/ruin estimates. It remains only as a
    // fallback for legacy results that predate avgWinPercent — and it divides
    // by the RESOLVED win rate so numerator and denominator share a sample.
    const avgWinPercent = typeof monteCarloResult.avgWinPercent === 'number' && monteCarloResult.avgWinPercent > 0
        ? monteCarloResult.avgWinPercent
        : (winRatePctResolved > 0 && monteCarloResult.expectedValue > 0
            ? monteCarloResult.expectedValue / (winRatePctResolved / 100)
            : 0);

    const avgLossPercent = monteCarloResult.probabilities.slHit > 0 && Math.abs(monteCarloResult.confidenceInterval.lower) > 0
        ? Math.abs(monteCarloResult.confidenceInterval.lower)
        : 1; // Default 1% if unknown

    // Risk per trade as fraction of account
    // Guard: a zero/empty account or position size would make riskPerTrade
    // Infinity and every drawdown/equity stat NaN — report a zero-risk result
    // instead of poisoning the prompt with NaN percentages.
    if (!(accountBalance > 0) || !(positionSize > 0)) {
        return {
            prob25pctDrawdown: 0,
            prob50pctDrawdown: 0,
            prob75pctDrawdown: 0,
            expectedEquityAfter100: accountBalance > 0 ? Math.round(accountBalance) : 0,
            kellyOptimalSize: 0,
        };
    }
    const riskPerTrade = (positionSize / accountBalance) * (avgLossPercent / 100) * leverage;

    // Win/loss ratio for the fixed-fractional sizing model below
    const winLossRatio = avgLossPercent > 0 ? avgWinPercent / avgLossPercent : 0;

    // Simulate 1000 sequences of 100 trades
    const sequenceCount = 1000;
    const tradesPerSequence = 100;

    // Simulate 1000 sequences of 100 trades on the seeded PRNG — bare
    // Math.random() here made every call return different numbers, silently
    // breaking the "worker and sync yield identical numbers" claim.
    const rng = mulberry32(
        seed ?? deriveRuinRiskSeed(accountBalance, positionSize, leverage, monteCarloResult)
    );

    let count25pct = 0;
    let count50pct = 0;
    let count75pct = 0;
    const finalEquities: number[] = [];

    for (let seq = 0; seq < sequenceCount; seq++) {
        let equity = accountBalance;
        let maxEquity = accountBalance;
        let maxDrawdownReached = 0;

        for (let trade = 0; trade < tradesPerSequence; trade++) {
            const isWin = rng() < winRate;

            // Fixed-fractional model: risk riskPerTrade of the CURRENT equity
            // per trade (win → equity × (1 + b·f), loss → equity × (1 − f)).
            // This makes the drawdown probabilities account-aware — the old
            // loop applied the absolute positionSize and never used the
            // computed riskPerTrade, so the account balance didn't matter.
            if (isWin) {
                equity *= 1 + winLossRatio * riskPerTrade;
            } else {
                equity *= 1 - riskPerTrade;
            }

            maxEquity = Math.max(maxEquity, equity);
            const currentDrawdown = (maxEquity - equity) / maxEquity;
            maxDrawdownReached = Math.max(maxDrawdownReached, currentDrawdown);
        }

        if (maxDrawdownReached >= 0.25) count25pct++;
        if (maxDrawdownReached >= 0.50) count50pct++;
        if (maxDrawdownReached >= 0.75) count75pct++;
        finalEquities.push(equity);
    }

    const expectedEquity = finalEquities.reduce((a, b) => a + b, 0) / sequenceCount;

    // Kelly Criterion: f* = (bp - q) / b (guarded helper, fed the same true
    // average win used above and the RESOLVED win rate — same subsample as
    // EV/avgWin, see computeKellyFraction docs)
    const kellyFraction = computeKellyFraction(
        winRatePctResolved,
        monteCarloResult.expectedValue,
        monteCarloResult.probabilities.slHit,
        monteCarloResult.confidenceInterval.lower,
        typeof monteCarloResult.avgWinPercent === 'number' && monteCarloResult.avgWinPercent > 0
            ? monteCarloResult.avgWinPercent
            : undefined
    );

    return {
        prob25pctDrawdown: Math.round((count25pct / sequenceCount) * 1000) / 10,
        prob50pctDrawdown: Math.round((count50pct / sequenceCount) * 1000) / 10,
        prob75pctDrawdown: Math.round((count75pct / sequenceCount) * 1000) / 10,
        expectedEquityAfter100: Math.round(expectedEquity),
        kellyOptimalSize: Math.round(kellyFraction * 1000) / 10
    };
};

/**
 * Compact markdown digest for the model (run_monte_carlo desk tool).
 * Labels must match what runSimulation actually computes: the TP/SL buckets
 * are MUTUALLY EXCLUSIVE terminal outcomes (not cumulative touch odds), the
 * confidence interval spans 5th–95th percentile trade PnL (not final equity),
 * and expectedValue covers resolved TP/SL paths only.
 */
export const monteCarloToMarkdown = (
    result: MonteCarloResult,
    ruinRisk?: RuinRiskResult,
    inputs?: { symbol?: string; direction: string; entry: number; stopLoss: number; takeProfits: number[]; atr: number; timeframe: string; maxSteps: number; atrSource: 'caller' | 'measured' }
): string => {
    const p = result.probabilities;
    const evSign = result.expectedValue >= 0 ? '+' : '';
    const inLine = inputs
        ? `\nSetup: ${inputs.symbol ? `${inputs.symbol} ` : ''}${inputs.direction} entry ${inputs.entry.toLocaleString()} · SL ${inputs.stopLoss.toLocaleString()} · TPs ${inputs.takeProfits.map(t => t.toLocaleString()).join(' / ')} · ATR ${inputs.atr.toLocaleString()} (${inputs.timeframe})`
        : '';
    const lines = [
        `MONTE CARLO — ${result.simulations} simulated paths on ${result.timeframe}:${inLine}`,
        `Win rate ${result.winRate.toFixed(1)}% (${result.winCount}/${result.simulations}) · EV ${evSign}${result.expectedValue.toFixed(2)}% over resolved paths only (timeouts excluded; unleveraged)`,
        `Terminal outcomes (% of paths): TP1 ${p.tp1Hit.toFixed(1)} · TP2 ${p.tp2Hit.toFixed(1)} · TP3 ${p.tp3Hit.toFixed(1)} · SL ${p.slHit.toFixed(1)} · timeout ${p.timeout.toFixed(1)} (buckets are exclusive — a path counts once)`,
        `Avg win ${result.avgWinPercent !== undefined ? result.avgWinPercent.toFixed(2) : '—'}% · avg loss ${result.avgLossPercent !== undefined ? result.avgLossPercent.toFixed(2) : '—'}% · avg adverse excursion ${result.maxDrawdownAvg.toFixed(2)}% · avg resolution ${result.timeToOutcomeAvg.toFixed(0)} candles`,
        `5th–95th percentile trade PnL range: ${result.confidenceInterval.lower.toFixed(2)}% to ${result.confidenceInterval.upper.toFixed(2)}% (per-trade PnL, not account equity).`,
    ];
    if (inputs) {
        // O-64: the volatility input is named. `measured` = ATR14 computed
        // from the tape the desk already fetches; `caller` = the model's own
        // number, which the receipt must say so the trader can audit it.
        lines.push(`Assumptions: ${inputs.maxSteps} candles maximum; ATR ${inputs.atrSource === 'measured' ? 'measured from the tape (ATR14)' : 'supplied by the caller'}, timeframe is a label only; neutral initial drift/regime. Seed ${result.seedUsed ?? 'unknown'}. Average duration includes timeouts.`);
    }
    if (ruinRisk) {
        lines.push(
            `Account risk over 100 fixed-fractional trades: P(≥25% drawdown) ${ruinRisk.prob25pctDrawdown.toFixed(1)}% · P(≥50%) ${ruinRisk.prob50pctDrawdown.toFixed(1)}% · P(≥75%) ${ruinRisk.prob75pctDrawdown.toFixed(1)}% · mean equity after 100 trades ${ruinRisk.expectedEquityAfter100.toLocaleString()} · Kelly-optimal size ${ruinRisk.kellyOptimalSize.toFixed(1)}% of account.`,
        );
    }
    lines.push(
        'Statistical estimate from simulated price paths, NOT a forecast — quote probabilities with the setup assumptions, never as certainty.',
    );
    return lines.join('\n');
};

/**
 * Generate prompt injection with Monte Carlo context
 */
export const generateMonteCarloPromptInjection = (result: MonteCarloResult): string => {
    const evSign = result.expectedValue >= 0 ? '+' : '';
    const evWarning = result.expectedValue < 0
        ? ' NEGATIVE EXPECTED VALUE - This setup has historically lost money on average.'
        : '';

    return `
 **MONTE CARLO VALIDATION (${result.simulations} simulations on ${result.timeframe.padEnd(8)}):**
- Simulated Win Rate: ${result.winRate.toFixed(1)}% (${result.winCount}/${result.simulations})
- Expected Value: ${evSign}${result.expectedValue.toFixed(2)}% per trade
- TP1 Probability: ${result.probabilities.tp1Hit.toFixed(1)}%
- TP2 Probability: ${result.probabilities.tp2Hit.toFixed(1)}%
- SL Probability: ${result.probabilities.slHit.toFixed(1)}%
- 95% Confidence Range: ${result.confidenceInterval.lower.toFixed(2)}% to ${result.confidenceInterval.upper.toFixed(2)}%
${evWarning}

**Use this data to validate your confidence level.**
`;
};

// =============================================================================
// WEB WORKER API — runs simulations off the main thread
// =============================================================================

/**
 * A small worker POOL, not one shared worker: a single worker processes
 * messages serially, so N concurrent simulations would still take N × the
 * compute. The per-analyst Monte Carlo pass dispatches one simulation per
 * debate seat; with a pool they actually run in parallel (capped at 4 —
 * beyond that the seats just queue on cores anyway).
 */
const WORKER_POOL_SIZE = 4;
const workerPool: Worker[] = [];
let poolCursor = 0;
let requestId = 0;
const pendingRequests = new Map<string, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    /** The worker this request was dispatched to — needed so a timed-out
     *  request can eject ITS worker from the pool (see ejectWorker). */
    worker?: Worker;
}>();

const spawnWorker = (): Worker => {
    const w = new Worker(
        new URL('./monteCarlo.worker.ts', import.meta.url),
        { type: 'module' }
    );
    w.onmessage = (e: MessageEvent) => {
        const { type, id, result, error } = e.data;
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        if (type === 'error') {
            pending.reject(new Error(error));
        } else {
            pending.resolve(result);
        }
    };
    w.onerror = (e) => {
        // ONE worker crashing must not cancel everyone else's simulation.
        // The comment here used to claim "pending ids are not tagged per worker,
        // so a sibling's in-flight request cannot be told apart" and therefore
        // rejected the whole map and dropped the whole pool. That stopped being
        // true when `pending.worker` was added for the timeout path (:790) and
        // `ejectWorker` (:851) became the surgical version — this handler just
        // never moved. Measured with two workers: crashing worker 0 rejected a
        // request worker 1 had ALREADY ANSWERED, and terminated both workers
        // (the 2026-10-27 audit T-3). The next call still spawned fresh, so nothing was
        // left unsettled — the cost was another seat's finished work.
        const message = e.message || 'Worker crashed';
        for (const [id, pending] of pendingRequests) {
            if (pending.worker !== w) continue;
            pending.reject(new Error(message));
            pendingRequests.delete(id);
        }
        ejectWorker(w);
    };
    return w;
};

const getWorker = (): Worker => {
    if (workerPool.length < WORKER_POOL_SIZE) workerPool.push(spawnWorker());
    const w = workerPool[poolCursor % workerPool.length];
    poolCursor += 1;
    return w;
};

/**
 * Remove a specific worker from the pool and terminate it. Used when a
 * request on that worker timed out: the worker is (or may be) wedged, and
 * leaving it in the round-robin would stall every future request assigned
 * to it. Sibling in-flight requests on the ejected worker simply hit their
 * own timeout and fall back to the synchronous path.
 */
const ejectWorker = (worker: Worker): void => {
    const idx = workerPool.indexOf(worker);
    if (idx >= 0) {
        workerPool.splice(idx, 1);
        poolCursor = 0;
    }
    try {
        worker.terminate();
    } catch (err) {
        console.warn('[MonteCarlo] Worker terminate failed:', err);
    }
};

/**
 * A wedged worker (browser suspends the tab, infinite loop in the worker)
 * would otherwise leave the caller's promise pending forever. Race every
 * worker call against a timeout and fall back to the synchronous path —
 * identical math, just on the main thread.
 */
const WORKER_TIMEOUT_MS = 10_000;

const withWorkerTimeout = async <T>(
    workerPromise: Promise<T>,
    id: string,
    syncFallback: () => T
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            workerPromise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Monte Carlo worker timed out')), WORKER_TIMEOUT_MS);
            }),
        ]);
    } catch (err) {
        if (err instanceof Error && err.message === 'Monte Carlo worker timed out') {
            console.warn('[MonteCarlo] Worker timed out — falling back to synchronous simulation');
            // Release the pending slot so a late worker reply is ignored, and
            // EJECT the worker that owned the request: a wedged worker left in
            // the pool would stall every future round-robin pick on it.
            const entry = pendingRequests.get(id);
            if (entry?.worker) ejectWorker(entry.worker);
            pendingRequests.delete(id);
            return syncFallback();
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/**
 * Run Monte Carlo simulation in a Web Worker (non-blocking).
 * Falls back to synchronous execution if Workers are unavailable or the
 * worker wedges past WORKER_TIMEOUT_MS.
 */
export const runSimulationAsync = (config: SimulationConfig): Promise<MonteCarloResult> => {
    if (typeof Worker === 'undefined') {
        return Promise.resolve(runSimulation(config));
    }
    const id = `mc-${++requestId}`;
    const worker = getWorker();
    const workerPromise = new Promise<MonteCarloResult>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject, worker });
        worker.postMessage({ type: 'runSimulation', id, config });
    });
    return withWorkerTimeout(workerPromise, id, () => runSimulation(config));
};

/**
 * Calculate ruin risk in a Web Worker (non-blocking).
 * Falls back to synchronous execution if Workers are unavailable or the
 * worker wedges past WORKER_TIMEOUT_MS. The optional `seed` is forwarded to
 * BOTH paths; when omitted, both sides derive it from the same inputs
 * (deriveRuinRiskSeed), so worker and sync results are identical.
 */
export const calculateRuinRiskAsync = (
    accountBalance: number,
    positionSize: number,
    leverage: number,
    monteCarloResult: MonteCarloResult,
    seed?: number
): Promise<RuinRiskResult> => {
    if (typeof Worker === 'undefined') {
        return Promise.resolve(calculateRuinRisk(accountBalance, positionSize, leverage, monteCarloResult, seed));
    }
    const id = `mc-${++requestId}`;
    const worker = getWorker();
    const workerPromise = new Promise<RuinRiskResult>((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject, worker });
        worker.postMessage({ type: 'calculateRuinRisk', id, accountBalance, positionSize, leverage, monteCarloResult, seed });
    });
    return withWorkerTimeout(workerPromise, id, () =>
        calculateRuinRisk(accountBalance, positionSize, leverage, monteCarloResult, seed)
    );
};
