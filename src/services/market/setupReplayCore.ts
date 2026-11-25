/**
 * setupReplayCore — pure deterministic historical OHLCV pattern micro-backtester
 * ("`npm test` for Setups").
 *
 * Reuses the canonical playbook/structure detectors (`playbooksCore`,
 * `regimeCore`, `swingStructureCore`, `wyckoffCore`, `orderFlowCore`,
 * `vwapCore`, `zonesCore`, `smcStructure`), canonical fee math
 * (`utils/netRiskReward.roundTripCostR` / `FEE_TAKER_BPS`), and canonical
 * binomial CI (`signals/signalAccuracy.wilsonInterval95`).
 *
 * Anti-bias invariants:
 *   1. STRICT ZERO LOOKAHEAD: bar `i` sees ONLY `candles[0..i]` (bounded
 *      sliding suffix ending at `i`) and incremental Wilder ATR up to `i`.
 *   2. REALISTIC ENTRY: triggers on closed bar `i` enter at `candles[i + 1].open`.
 *   3. CONSERVATIVE INTRABAR RESOLUTION: if bar `j` touches BOTH stop and
 *      target, ALWAYS resolve as a LOSS (`stop`) first.
 *   4. NON-OVERLAPPING TRADES: at most one simulated trade open at a time;
 *      scan advances past `exitIdx` before evaluating the next trigger.
 *   5. FEE DRAG SIGN: subtract round-trip taker fee drag in R from EVERY
 *      closed trade's `netR` (winners shrink, losers deepen).
 */

import type { Kline } from '../../types/message';
import { scanPlaybooks, type PlaybookContext, type PlaybookMatch } from './playbooksCore';
import { regimeRead } from './regimeCore';
import { readStructure } from './swingStructureCore';
import { readWyckoff } from './wyckoffCore';
import { flowEvents } from './orderFlowCore';
import { computeVwap, vwapPosition } from './vwapCore';
import { readSrZones } from './zonesCore';
import { utcDayStart } from './sessionConvention';
import { detectEqualLevels, detectSweepReversals } from '../../utils/smcStructure';
import { roundTripCostR, FEE_TAKER_BPS } from '../../utils/netRiskReward';
import { wilsonInterval95 } from '../signals/signalAccuracy';
import { REPLAY_SUPPORTED_SETUPS, type ReplaySetupName } from '../../types/playbook';

export { REPLAY_SUPPORTED_SETUPS, type ReplaySetupName };

export interface SetupReplayInput {
    symbol: string;
    interval: string;
    setup: string;
    direction?: 'Long' | 'Short' | 'both';
    lookbackBars?: number;
    stopAtrMult?: number;
    targetR?: number;
    maxHoldBars?: number;
}

export interface SetupReplayOccurrence {
    triggerTime: number;
    entryTime: number;
    direction: 'Long' | 'Short';
    entry: number;
    stop: number;
    target: number;
    exitReason: 'target' | 'stop' | 'timeout';
    barsHeld: number;
    grossR: number;
    netR: number;
    mfeR: number;
    maeR: number;
}

export interface SetupReplaySuccess {
    ok: true;
    setup: ReplaySetupName;
    symbol: string;
    interval: string;
    direction: 'Long' | 'Short' | 'both';
    barsScanned: number;
    sampleCount: number;
    /** Total winning trades (TP hits + positive-netR timeouts). */
    wins: number;
    /** Total losing trades (SL hits + non-positive-netR timeouts; wins + losses === sampleCount). */
    losses: number;
    targetHits: number;
    stopHits: number;
    timeouts: number;
    winRate: number | null;
    wilson95Ci: { low: number; high: number } | null;
    grossExpectancyR: number | null;
    netExpectancyR: number | null;
    roundTripFeeRate: number;
    medianMfeR: number | null;
    medianMaeR: number | null;
    avgBarsToResolve: number | null;
    sufficientSample: boolean;
    warning?: string;
    recentOccurrences: SetupReplayOccurrence[];
}

export interface SetupReplayError {
    ok: false;
    error: 'unknown_setup' | 'insufficient_candles';
    message: string;
    supportedSetups?: readonly ReplaySetupName[];
}

export type SetupReplayResult = SetupReplaySuccess | SetupReplayError;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const roundPx = (v: number): number => Number(v.toPrecision(7));

const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    const raw = sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    return round4(raw);
};

export const isSupportedReplaySetup = (name: string): name is ReplaySetupName =>
    (REPLAY_SUPPORTED_SETUPS as readonly string[]).includes(name);

const emptyContext = (candles: Kline[], atr: number): PlaybookContext => ({
    candles,
    atr,
    regime: null,
    structure: null,
    wyckoff: null,
    flow: null,
    ib: null,
    failedExtension: null,
    rotation: null,
    dayOpen: null,
    profile: null,
    sessionVwap: null,
    sweeps: [],
    keyLevels: [],
});

/**
 * Evaluate ONLY the requested detector strictly on `prefix` (`candles[..i]`).
 * Never reads any candle after index `i`.
 */
const evaluateSetupAtPrefix = (
    setup: ReplaySetupName,
    prefix: Kline[],
    atr: number,
): PlaybookMatch | null => {
    if (prefix.length < 25 || !(atr > 0)) return null;
    const lastBar = prefix[prefix.length - 1];
    const ctx = emptyContext(prefix, atr);

    if (setup === 'turtle_soup') {
        const slice = prefix.length > 26 ? prefix.slice(-26) : prefix;
        ctx.candles = slice;
        return scanPlaybooks(ctx).find(m => m.playbook === 'turtle_soup') ?? null;
    }

    if (setup === 'trend_pullback') {
        if (prefix.length < 80) return null;
        const slice = prefix.length > 120 ? prefix.slice(-120) : prefix;
        ctx.candles = slice;
        ctx.regime = regimeRead(slice);
        if (!ctx.regime) return null;
        return scanPlaybooks(ctx).find(m => m.playbook === 'trend_pullback') ?? null;
    }

    if (setup === 'wyckoff_spring' || setup === 'wyckoff_utad') {
        if (prefix.length < 40) return null;
        const slice = prefix.length > 50 ? prefix.slice(-50) : prefix;
        // `readWyckoff` drops its trailing candle (`slice(0, -1)`), so appending
        // a copy of `lastBar` evaluates bar `i` itself without touching `i + 1`.
        const wy = readWyckoff([...slice, lastBar], atr);
        if (!wy || !wy.range) return null;
        const wantedKind = setup === 'wyckoff_spring' ? 'spring' : 'upthrust';
        const freshEvent = wy.events.some(
            e => e.kind === wantedKind && e.confidence === 'medium' && e.time === lastBar.time,
        );
        if (!freshEvent) return null;
        ctx.candles = slice;
        ctx.wyckoff = {
            ...wy,
            events: wy.events.filter(e => e.time === lastBar.time),
        };
        return scanPlaybooks(ctx).find(m => m.playbook === setup) ?? null;
    }

    if (setup === 'sweep_structure_shift') {
        if (prefix.length < 60) return null;
        const slice = prefix.length > 80 ? prefix.slice(-80) : prefix;
        const padded = [...slice, lastBar];
        ctx.candles = slice;
        ctx.structure = readStructure(slice);
        const eq = detectEqualLevels(padded, 60);
        const poolLevels = [
            ...eq.equalHighs.map(h => ({ price: h.level, label: 'equal_highs' })),
            ...eq.equalLows.map(l => ({ price: l.level, label: 'equal_lows' })),
        ];
        if (poolLevels.length === 0 || !ctx.structure) return null;
        const sweeps = detectSweepReversals(padded, poolLevels, { atr }).filter(s => s.barsElapsed <= 1);
        if (sweeps.length === 0) return null;
        ctx.sweeps = sweeps;
        return scanPlaybooks(ctx).find(m => m.playbook === 'sweep_structure_shift') ?? null;
    }

    if (setup === 'absorption_reversal') {
        if (prefix.length < 30) return null;
        const slice = prefix.length > 65 ? prefix.slice(-65) : prefix;
        const flow = flowEvents(slice, atr, Math.min(60, slice.length));
        if (!flow || !flow.events.some(e => e.kind === 'absorption' && e.time === lastBar.time)) {
            return null;
        }
        const zones = readSrZones(slice, atr);
        ctx.candles = slice;
        ctx.flow = { ...flow, events: flow.events.filter(e => e.time === lastBar.time) };
        ctx.keyLevels = (zones?.zones ?? []).slice(0, 4).flatMap(z => [z.top, z.bottom]);
        return scanPlaybooks(ctx).find(m => m.playbook === 'absorption_reversal') ?? null;
    }

    // setup === 'vwap_reclaim'
    const dayStart = utcDayStart(lastBar.time > 1e11 ? lastBar.time : lastBar.time * 1000);
    const daySlice = prefix.filter(c => {
        const ms = c.time > 1e11 ? c.time : c.time * 1000;
        return ms >= dayStart;
    });
    const vwapWindow = daySlice.length >= 6 ? daySlice : prefix.slice(-Math.min(24, prefix.length));
    const vwap = computeVwap(vwapWindow);
    const pos = vwap ? vwapPosition(vwap, vwapWindow, lastBar.close) : null;
    if (!vwap || !pos || pos.barsSinceCross === null || pos.barsSinceCross > 1) return null;
    ctx.candles = prefix.slice(-30);
    ctx.sessionVwap = { vwap, position: pos };
    return scanPlaybooks(ctx).find(m => m.playbook === 'vwap_reclaim') ?? null;
};

/**
 * Pure deterministic historical replay engine.
 */
export const runSetupReplay = (
    rawCandles: readonly Kline[],
    input: SetupReplayInput,
): SetupReplayResult => {
    const setupRaw = (input.setup ?? '').trim().toLowerCase();
    if (!isSupportedReplaySetup(setupRaw)) {
        return {
            ok: false,
            error: 'unknown_setup',
            message: `Unknown setup "${input.setup}". Supported setups: ${REPLAY_SUPPORTED_SETUPS.join(', ')}.`,
            supportedSetups: REPLAY_SUPPORTED_SETUPS,
        };
    }

    const lookbackBars = Math.round(clamp(input.lookbackBars ?? 500, 200, 1000));
    const stopAtrMult = clamp(input.stopAtrMult ?? 1.5, 0.5, 5.0);
    const targetR = clamp(input.targetR ?? 2.0, 0.5, 10.0);
    const maxHoldBars = Math.round(clamp(input.maxHoldBars ?? 48, 5, 200));
    const direction = input.direction ?? 'both';
    const roundTripFeeRate = (2 * FEE_TAKER_BPS) / 10_000;

    const candles = rawCandles.length > lookbackBars
        ? rawCandles.slice(-lookbackBars)
        : [...rawCandles];

    if (candles.length < 40) {
        return {
            ok: false,
            error: 'insufficient_candles',
            message: `Need at least 40 closed candles for setup_replay (got ${candles.length}).`,
        };
    }

    const occurrences: SetupReplayOccurrence[] = [];
    const period = 14;
    let atr = 0;
    let trSum = 0;

    // Causal bar-by-bar loop: ATR and detector see ONLY candles[0..i].
    let i = 0;
    while (i < candles.length - 1) {
        if (i >= 1) {
            const c = candles[i];
            const prev = candles[i - 1];
            const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
            if (i <= period) {
                trSum += tr;
                if (i === period) atr = trSum / period;
            } else {
                atr = (atr * (period - 1) + tr) / period;
            }
        }

        if (i < 24 || !(atr > 0)) {
            i += 1;
            continue;
        }

        // Bounded causal prefix ending strictly at bar `i` (never reads `i + 1..end`).
        const winStart = Math.max(0, i - 129);
        const prefix = candles.slice(winStart, i + 1);
        const match = evaluateSetupAtPrefix(setupRaw, prefix, atr);
        if (!match) {
            i += 1;
            continue;
        }

        const matchDir: 'Long' | 'Short' = match.side === 'long' ? 'Long' : 'Short';
        if (direction !== 'both' && matchDir !== direction) {
            i += 1;
            continue;
        }

        // Realistic entry at the NEXT bar's open (`i + 1`).
        const entryBarIdx = i + 1;
        const entryBar = candles[entryBarIdx];
        const entry = entryBar?.open ?? 0;
        const riskDist = atr * stopAtrMult;
        if (!(entry > 0) || !(riskDist > 0)) {
            i += 1;
            continue;
        }

        const isLong = matchDir === 'Long';
        const stop = isLong ? entry - riskDist : entry + riskDist;
        const target = isLong ? entry + riskDist * targetR : entry - riskDist * targetR;

        // Fee drag in R via canonical `roundTripCostR` (`tradeMathCore` / `netRiskReward`).
        const stopDistancePct = (riskDist / entry) * 100;
        const cost = roundTripCostR({ stopDistancePct });
        const feeDragR = cost.known && typeof cost.costR === 'number'
            ? cost.costR
            : (entry * roundTripFeeRate) / riskDist;

        const maxExitIdx = Math.min(candles.length - 1, entryBarIdx + maxHoldBars - 1);
        let exitIdx = maxExitIdx;
        let exitReason: 'target' | 'stop' | 'timeout' = 'timeout';
        let grossR = 0;
        let mfeR = 0;
        let maeR = 0;

        for (let j = entryBarIdx; j <= maxExitIdx; j += 1) {
            const bar = candles[j];
            const barFav = isLong
                ? (bar.high - entry) / riskDist
                : (entry - bar.low) / riskDist;
            const barAdv = isLong
                ? (entry - bar.low) / riskDist
                : (bar.high - entry) / riskDist;
            if (barAdv > maeR) maeR = barAdv;

            const hitStop = isLong ? bar.low <= stop : bar.high >= stop;
            const hitTarget = isLong ? bar.high >= target : bar.low <= target;

            // CONSERVATIVE INTRABAR RESOLUTION: stop ALWAYS wins over target on the same bar.
            if (hitStop) {
                exitIdx = j;
                exitReason = 'stop';
                grossR = -1;
                maeR = Math.min(1, Math.max(maeR, 1));
                break;
            }
            if (barFav > mfeR) mfeR = barFav;
            if (hitTarget) {
                exitIdx = j;
                exitReason = 'target';
                grossR = targetR;
                mfeR = Math.min(targetR, Math.max(mfeR, targetR));
                break;
            }
        }

        if (exitReason === 'timeout') {
            const exitPrice = candles[exitIdx].close;
            grossR = isLong
                ? (exitPrice - entry) / riskDist
                : (entry - exitPrice) / riskDist;
        }

        const netR = grossR - feeDragR;
        const barsHeld = exitIdx - entryBarIdx + 1;

        occurrences.push({
            triggerTime: candles[i].time,
            entryTime: entryBar.time,
            direction: matchDir,
            entry: roundPx(entry),
            stop: roundPx(stop),
            target: roundPx(target),
            exitReason,
            barsHeld,
            grossR: round4(grossR),
            netR: round4(netR),
            mfeR: round4(Math.max(0, Math.min(targetR, mfeR))),
            maeR: round4(Math.max(0, Math.min(1, maeR))),
        });

        // NON-OVERLAPPING TRADES: advance past the resolved bar, catching ATR up causally.
        for (let k = i + 1; k <= exitIdx && k < candles.length; k += 1) {
            const c = candles[k];
            const prev = candles[k - 1];
            const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
            if (k <= period) {
                trSum += tr;
                if (k === period) atr = trSum / period;
            } else {
                atr = (atr * (period - 1) + tr) / period;
            }
        }
        i = exitIdx + 1;
    }

    const sampleCount = occurrences.length;
    const targetHits = occurrences.filter(o => o.exitReason === 'target').length;
    const stopHits = occurrences.filter(o => o.exitReason === 'stop').length;
    const timeouts = occurrences.filter(o => o.exitReason === 'timeout').length;
    const wins = occurrences.filter(o => o.exitReason === 'target' || (o.exitReason === 'timeout' && o.netR > 0)).length;
    const losses = sampleCount - wins;
    const winRate = sampleCount > 0 ? round4(wins / sampleCount) : null;
    const wilson = sampleCount > 0 ? wilsonInterval95(wins, sampleCount) : null;
    const wilson95Ci = wilson ? { low: round4(wilson.low), high: round4(wilson.high) } : null;
    const grossExpectancyR = sampleCount > 0
        ? round4(occurrences.reduce((s, o) => s + o.grossR, 0) / sampleCount)
        : null;
    const netExpectancyR = sampleCount > 0
        ? round4(occurrences.reduce((s, o) => s + o.netR, 0) / sampleCount)
        : null;
    const avgBarsToResolve = sampleCount > 0
        ? round4(occurrences.reduce((s, o) => s + o.barsHeld, 0) / sampleCount)
        : null;
    const sufficientSample = sampleCount >= 5;

    return {
        ok: true,
        setup: setupRaw,
        symbol: input.symbol,
        interval: input.interval,
        direction,
        barsScanned: candles.length,
        sampleCount,
        wins,
        losses,
        targetHits,
        stopHits,
        timeouts,
        winRate,
        wilson95Ci,
        grossExpectancyR,
        netExpectancyR,
        roundTripFeeRate,
        medianMfeR: median(occurrences.map(o => o.mfeR)),
        medianMaeR: median(occurrences.map(o => o.maeR)),
        avgBarsToResolve,
        sufficientSample,
        ...(!sufficientSample
            ? { warning: `Insufficient sample (N=${sampleCount} < 5) — do not claim empirical edge from this replay.` }
            : {}),
        recentOccurrences: occurrences.slice(-5),
    };
};
