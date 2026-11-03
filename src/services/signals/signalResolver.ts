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
 *  2b. GAP RULE: after the position exists, a bar that OPENED beyond the stop
 *     fills at the open, never at the stop price — the stop was already
 *     breached at the bar's first tick, so a fill "at the stop" is a price the
 *     tape never printed. A long that gaps below its stop loses MORE than 1R,
 *     and the ledger says so (`gapAdjusted: true`). The trigger bar itself is
 *     exempt: entry limit and stop fire around the same tick and the
 *     birth-tick microstructure is genuinely unknowable, so the pre-existing
 *     stop-first-at-the-stop convention covers it.
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

/** The fill price and signed R of a stop-side exit on `bar`.
 *
 *  Header 2b, the gap rule: when `applyGap`, a bar that OPENED beyond the stop
 *  fills at the open — the stop was already breached at the bar's first tick,
 *  so the stop price is a print the tape never made. Without the gap (or with
 *  `applyGap` false, the trigger bar's birth-tick convention) the fill is the
 *  stop price and the loss is exactly 1R before costs. */
const stopExit = (
    bar: SignalCandle,
    direction: SignalDirection,
    levels: SignalLevels,
    risk: number,
    applyGap: boolean,
): { gap: boolean; exitPrice: number; grossR: number } => {
    const gap = applyGap && (direction === 'long'
        ? bar.open < levels.stop
        : bar.open > levels.stop);
    const exitPrice = gap ? bar.open : levels.stop;
    const grossR = (direction === 'long'
        ? exitPrice - levels.entry
        : levels.entry - exitPrice) / risk;
    return { gap, exitPrice, grossR };
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
    /** The exit bar OPENED beyond the stop, so the fill is the open (header
     *  2b). The loss exceeds 1R by the gap; absent on a stop-price fill. */
    gapAdjusted?: boolean;
    /** Signed R from the trigger bar's open to the assumed entry fill — the
     *  fill-realism measure (see the header's cost note). */
    entryOpenR?: number;
    /** The same measure on the exit bar. Absent on `never_triggered`. */
    exitOpenR?: number;
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
    // Fill-realism measurement (N4): how far the trigger bar's OPEN sat from
    // the assumed entry fill. The resolver assumes a limit fill AT the level;
    // this number is what a real fill at the bar's open would have been, in
    // signed R. Measured once, carried on every filled outcome.
    const entryOpenR = (signal.direction === 'long'
        ? trigger.open - signal.entry
        : signal.entry - trigger.open) / risk;
    for (let i = triggerIndex; i < bars.length; i++) {
        const bar = bars[i];
        const side = sideOf(bar, signal.direction, levels);
        if (side === 'none') continue;
        const usedBarTimes = bars.slice(triggerIndex, i + 1).map(c => c.time);

        if (side !== 'both') {
            const win = side === 'target';
            // Header 2b: the gap rule applies only AFTER the position exists —
            // the trigger bar keeps the stop-price birth-tick convention.
            const se = win
                ? { gap: false, exitPrice: signal.target, grossR: Math.abs(signal.target - signal.entry) / risk }
                : stopExit(bar, signal.direction, levels, risk, i > triggerIndex);
            return {
                status: win ? 'won' : 'lost',
                grossR: se.grossR,
                feeR,
                outcomeR: se.grossR - feeR,
                usedBarTimes,
                path: 'bar',
                ambiguous: false,
                triggeredAt: trigger.time,
                exitAt: bar.time,
                exitPrice: se.exitPrice,
                entryOpenR,
                exitOpenR: (signal.direction === 'long'
                    ? bar.open - signal.entry
                    : signal.entry - bar.open) / risk,
                ...(se.gap ? { gapAdjusted: true } : {}),
            };
        }

        // A post-trigger bar that OPENED beyond the stop ordered itself at its
        // first tick: the stop fired before anything later in this bar could
        // happen. Drill or not, that is a deterministic stop at the gap open —
        // never an ambiguity (header 2b).
        if (i > triggerIndex) {
            const se = stopExit(bar, signal.direction, levels, risk, true);
            if (se.gap) {
                return {
                    status: 'lost',
                    grossR: se.grossR,
                    feeR,
                    outcomeR: se.grossR - feeR,
                    usedBarTimes,
                    path: 'bar',
                    ambiguous: false,
                    triggeredAt: trigger.time,
                    exitAt: bar.time,
                    exitPrice: se.exitPrice,
                    entryOpenR,
                    exitOpenR: (signal.direction === 'long'
                        ? bar.open - signal.entry
                        : signal.entry - bar.open) / risk,
                    gapAdjusted: true,
                };
            }
        }

        // Both levels inside one coarse bar: try to order them on 1m data.
        const minutes = drillFor(bar, drill);
        const ambiguous = true;
        let path: 'bar' | '1m' = 'bar';
        if (minutes) {
            path = '1m';
            for (const m of minutes) {
                // The gap rule at minute granularity (post-trigger bars): a
                // minute that opened beyond the stop fired there first.
                if (i > triggerIndex) {
                    const mse = stopExit(m, signal.direction, levels, risk, true);
                    if (mse.gap) {
                        return {
                            status: 'lost',
                            grossR: mse.grossR,
                            feeR,
                            outcomeR: mse.grossR - feeR,
                            usedBarTimes,
                            path,
                            ambiguous: false,
                            triggeredAt: trigger.time,
                            exitAt: bar.time,
                            exitPrice: mse.exitPrice,
                            gapAdjusted: true,
                        };
                    }
                }
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
                    entryOpenR,
                    exitOpenR: (signal.direction === 'long'
                        ? m.open - signal.entry
                        : signal.entry - m.open) / risk,
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
            entryOpenR,
            exitOpenR: (signal.direction === 'long'
                ? bar.open - signal.entry
                : signal.entry - bar.open) / risk,
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
        entryOpenR,
        exitOpenR: (signal.direction === 'long'
            ? last.open - signal.entry
            : signal.entry - last.open) / risk,
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
