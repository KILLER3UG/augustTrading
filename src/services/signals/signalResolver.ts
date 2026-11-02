/**
 * signalResolver — the deterministic half of the signal loop.
 *
 * A signal is settled by walking closed candles AFTER its emission:
 *
 *  1. The first bar that touches `entry` opens the position (assumed filled at
 *     `entry`, a limit touch).
 *  2. From that bar on, the first bar that touches `stop` or `target` decides.
 *     A bar that touches BOTH is ambiguous: the resolver drills into 1m bars
 *     inside it; if the 1m series is unavailable or a single 1m bar contains
 *     both levels too, the order is unknowable and the result is STOP-FIRST
 *     with `ambiguous: true` — conservative by construction, and counted.
 *  3. If neither level is touched by expiry, the position is marked to the last
 *     closed bar's close and the result is `expired` with a signed R.
 *  4. If `entry` is never touched, the result is `never_triggered` and costs
 *     nothing — no fill, no R.
 *
 * NO LOOKAHEAD, by two rules: a bar only counts when it OPENED at or after
 * `emittedAt` (a wick that happened before the call cannot fill it), and a bar
 * only counts when it CLOSED at or before `expiresAt` / now (a bar that
 * straddles the boundary could carry post-expiry price action). The cost of
 * both rules is a conservative miss at the edges; the cost of relaxing them is
 * a ledger that grades the model on prices it could not have seen.
 *
 * Every filled outcome is charged a round-trip cost in R: taker fee on both
 * sides plus an assumed slippage on both sides, scaled by the entry price over
 * the stop distance. Fees are an assumption, so they are a named constant, not
 * a hidden subtraction.
 */

import type {
    SignalDirection,
    SignalLevels,
    SignalRecord,
    SignalRow,
    SignalStatus,
    SignalSummary,
} from '../../types/signal';

export interface SignalCandle {
    /** Open time, ms. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    /** Base-asset volume when the venue supplied it. Optional because a
     *  cross-check/normalizer may drop it; the resolver never reads it. */
    volume?: number;
}

/** The coarse resolution bar. 5m keeps the fetch small; the 1m series exists
 *  only to order a bar that contains both levels. */
export const SIGNAL_BAR_MS = 5 * 60_000;
export const SIGNAL_DRILL_BAR_MS = 60_000;

/** Assumed costs, per side. Taker, because a signal's stop is an exit that
 *  cannot wait for a maker fill. These are DEFAULTS on a perp desk, not a
 *  claim about the trader's fee tier. */
export const SIGNAL_TAKER_FEE_RATE = 0.0005;
export const SIGNAL_SLIPPAGE_RATE = 0.0002;

export type SignalSide = 'stop' | 'target' | 'both' | 'none';

export const bracketError = (levels: SignalLevels, direction: SignalDirection): string | null => {
    const { entry, stop, target } = levels;
    if (![entry, stop, target].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        return 'entry, stop and target must be positive prices';
    }
    if (entry === stop) return 'entry and stop are the same price — there is no risk distance';
    if (entry === target) return 'entry and target are the same price — there is no reward distance';
    if (direction === 'long' && !(stop < entry && entry < target)) {
        return 'a long needs stop < entry < target';
    }
    if (direction === 'short' && !(target < entry && entry < stop)) {
        return 'a short needs target < entry < stop';
    }
    return null;
};

export const riskPerUnit = (levels: Pick<SignalLevels, 'entry' | 'stop'>): number =>
    Math.abs(levels.entry - levels.stop);

/** Round-trip cost in R at this entry/stop. */
export const roundTripCostR = (levels: Pick<SignalLevels, 'entry' | 'stop'>): number => {
    const risk = riskPerUnit(levels);
    if (!(risk > 0)) return 0;
    return (levels.entry * 2 * (SIGNAL_TAKER_FEE_RATE + SIGNAL_SLIPPAGE_RATE)) / risk;
};

const touches = (candle: SignalCandle, direction: SignalDirection, price: number): boolean =>
    direction === 'long' ? candle.low <= price : candle.high >= price;

/** A long target is ABOVE (high reaches it), a short target is BELOW (low
 *  reaches it) — the mirror of `touches`, which is the entry/stop rule. */
const touchesTarget = (candle: SignalCandle, direction: SignalDirection, price: number): boolean =>
    direction === 'long' ? candle.high >= price : candle.low <= price;

const sideOf = (candle: SignalCandle, direction: SignalDirection, levels: SignalLevels): SignalSide => {
    const stop = touches(candle, direction, levels.stop);
    const target = touchesTarget(candle, direction, levels.target);
    return stop && target ? 'both' : stop ? 'stop' : target ? 'target' : 'none';
};

/** Which 1m bars belong to a coarse bar, complete enough to trust. Missing
 *  minutes make the ordering unknowable, which is an ambiguity — never a pass. */
const drillFor = (bar: SignalCandle, drill: readonly SignalCandle[]): SignalCandle[] | null => {
    const want = SIGNAL_BAR_MS / SIGNAL_DRILL_BAR_MS;
    const inside = drill.filter(c => c.time >= bar.time && c.time < bar.time + SIGNAL_BAR_MS);
    if (inside.length !== want) return null;
    for (let i = 1; i < inside.length; i++) {
        if (inside[i].time - inside[i - 1].time !== SIGNAL_DRILL_BAR_MS) return null;
    }
    return inside;
};

export interface ResolutionDraft {
    status: Exclude<SignalStatus, 'open'>;
    grossR: number;
    feeR: number;
    outcomeR: number;
    usedBarTimes: number[];
    path: 'bar' | '1m';
    ambiguous: boolean;
    triggeredAt?: number;
    exitAt?: number;
    exitPrice?: number;
}

export type SignalBracket = Pick<SignalRecord, 'direction' | 'entry' | 'stop' | 'target' | 'emittedAt' | 'expiresAt'>;

/**
 * Settle one signal, or return null while it is still open (not expired and
 * neither level touched yet). `coarse` and `drill` are ascending, CLOSED
 * candles; the caller is responsible for only passing closed bars.
 */
export const resolveSignal = (
    signal: SignalBracket,
    coarse: readonly SignalCandle[],
    drill: readonly SignalCandle[] = [],
    now: number = Date.now(),
): ResolutionDraft | null => {
    const levels: SignalLevels = { entry: signal.entry, stop: signal.stop, target: signal.target };
    if (bracketError(levels, signal.direction)) return null;
    const windowEnd = Math.min(signal.expiresAt, now);
    const bars = coarse.filter(c =>
        c.time >= signal.emittedAt
        && c.time + SIGNAL_BAR_MS <= windowEnd
        && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
    if (bars.length === 0) {
        // Nothing has closed since emission. Open until the clock, never a
        // resolution from zero bars.
        return now >= signal.expiresAt
            ? { status: 'never_triggered', grossR: 0, feeR: 0, outcomeR: 0, usedBarTimes: [], path: 'bar', ambiguous: false }
            : null;
    }

    const feeR = roundTripCostR(levels);
    const risk = riskPerUnit(levels);
    const triggerIndex = bars.findIndex(c => touches(c, signal.direction, signal.entry));
    if (triggerIndex < 0) {
        if (now < signal.expiresAt) return null;
        return {
            status: 'never_triggered',
            grossR: 0,
            feeR: 0,
            outcomeR: 0,
            usedBarTimes: bars.map(c => c.time),
            path: 'bar',
            ambiguous: false,
        };
    }

    const trigger = bars[triggerIndex];
    for (let i = triggerIndex; i < bars.length; i++) {
        const bar = bars[i];
        const side = sideOf(bar, signal.direction, levels);
        if (side === 'none') continue;
        const usedBarTimes = bars.slice(triggerIndex, i + 1).map(c => c.time);

        if (side !== 'both') {
            const win = side === 'target';
            const exitPrice = win ? signal.target : signal.stop;
            const grossR = win ? Math.abs(signal.target - signal.entry) / risk : -1;
            return {
                status: win ? 'won' : 'lost',
                grossR,
                feeR,
                outcomeR: grossR - feeR,
                usedBarTimes,
                path: 'bar',
                ambiguous: false,
                triggeredAt: trigger.time,
                exitAt: bar.time,
                exitPrice,
            };
        }

        // Both levels inside one coarse bar: try to order them on 1m data.
        const minutes = drillFor(bar, drill);
        const ambiguous = true;
        let path: 'bar' | '1m' = 'bar';
        if (minutes) {
            path = '1m';
            for (const m of minutes) {
                const mSide = sideOf(m, signal.direction, levels);
                if (mSide === 'none' || mSide === 'both') {
                    if (mSide === 'both') break; // still unknowable, stop-first
                    continue;
                }
                const win = mSide === 'target';
                const exitPrice = win ? signal.target : signal.stop;
                const grossR = win ? Math.abs(signal.target - signal.entry) / risk : -1;
                return {
                    status: win ? 'won' : 'lost',
                    grossR,
                    feeR,
                    outcomeR: grossR - feeR,
                    usedBarTimes,
                    path,
                    ambiguous: false,
                    triggeredAt: trigger.time,
                    exitAt: bar.time,
                    exitPrice,
                };
            }
        }
        return {
            status: 'lost',
            grossR: -1,
            feeR,
            outcomeR: -1 - feeR,
            usedBarTimes,
            path,
            ambiguous,
            triggeredAt: trigger.time,
            exitAt: bar.time,
            exitPrice: signal.stop,
        };
    }

    if (now < signal.expiresAt) return null;

    // Nothing hit by expiry: mark the last closed bar's close.
    const last = bars[bars.length - 1];
    const markR = (signal.direction === 'long'
        ? last.close - signal.entry
        : signal.entry - last.close) / risk;
    return {
        status: 'expired',
        grossR: markR,
        feeR,
        outcomeR: markR - feeR,
        usedBarTimes: bars.slice(triggerIndex).map(c => c.time),
        path: 'bar',
        ambiguous: false,
        triggeredAt: trigger.time,
        exitAt: last.time,
        exitPrice: last.close,
    };
};

/** The feed's headline numbers. Fills are won/lost/expired; a
 *  `never_triggered` call took no risk, so it is reported beside the rate, not
 *  counted as a loss. Every mean is null until its own side has a row — an
 *  empty side must never print as 0R. */
export const summariseSignals = (rows: readonly SignalRow[]): SignalSummary => {
    const out: SignalSummary = {
        emitted: rows.length,
        open: 0,
        won: 0,
        lost: 0,
        expired: 0,
        neverTriggered: 0,
        hitRate: null,
        expectancyR: null,
        ambiguityRate: null,
        baseRate: null,
        lift: null,
        shadowRefusedR: null,
        shadowPassedR: null,
    };
    const fillRs: number[] = [];
    const baseRates: number[] = [];
    let ambiguous = 0;
    const refusedRs: number[] = [];
    const passedRs: number[] = [];
    for (const row of rows) {
        if (row.status === 'open') { out.open += 1; continue; }
        if (row.status === 'never_triggered') { out.neverTriggered += 1; continue; }
        if (row.status === 'won') out.won += 1;
        else if (row.status === 'lost') out.lost += 1;
        else out.expired += 1;
        const r = row.resolution?.outcomeR;
        if (typeof r !== 'number' || !Number.isFinite(r)) continue;
        fillRs.push(r);
        const base = row.resolution?.base?.hitRate;
        if (typeof base === 'number' && Number.isFinite(base)) baseRates.push(base);
        if (row.resolution?.ambiguous) ambiguous += 1;
        if (row.gate?.status === 'refused') refusedRs.push(r);
        else if (row.gate?.status === 'pass') passedRs.push(r);
    }
    const mean = (xs: number[]): number | null =>
        xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    const fills = out.won + out.lost + out.expired;
    if (fills > 0) {
        out.hitRate = out.won / fills;
        out.ambiguityRate = ambiguous / fills;
    }
    out.expectancyR = mean(fillRs);
    out.baseRate = mean(baseRates);
    out.lift = out.hitRate !== null && out.baseRate !== null ? out.hitRate - out.baseRate : null;
    out.shadowRefusedR = mean(refusedRs);
    out.shadowPassedR = mean(passedRs);
    return out;
};
