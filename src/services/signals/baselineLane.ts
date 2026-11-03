/**
 * baselineLane — the deterministic answer to "beats a fixed rule?" (O-08).
 *
 * The signal ledger already carries a per-signal base rate: the SAME bracket
 * geometry entered at every bar. That answers "did the timing add anything".
 * It does NOT answer "would a mechanical rule with no model at all have done
 * better" — so this module runs ONE fixed, named rule through the SAME
 * resolver on the SAME tape, and the result rides the resolution's base rate
 * beside it. No model, no fetch, no parameters to tune: the rule below is a
 * constant on purpose, because a baseline you can optimize is not a baseline.
 *
 * The rule: a 5m close crossing ABOVE its SMA20 enters long at that close,
 * with a fixed 1% stop and 2% target, 4 hours to live. Mirrored shorts are
 * deliberately absent — the harness's tape read is what's being graded, and
 * the simplest long-only mechanical lane is the honest floor to beat.
 */

import { resolveSignal, SIGNAL_BAR_MS, type SignalBracket, type SignalCandle } from './signalResolver';

export const BASELINE_RULE = '5m close crosses above SMA20 → long at that close · stop −1% · target +2% · 4h';
export const BASELINE_STOP_PCT = 0.01;
export const BASELINE_REWARD_PCT = 0.02;
/** 4 hours of 5m bars. */
export const BASELINE_HORIZON_BARS = 48;
const SMA_PERIOD = 20;
/** Shortest tape the lane will read: warmup plus a handful of live samples. */
const MIN_TAPE_BARS = SMA_PERIOD + 40;

export interface BaselineLane {
    rule: string;
    /** Bar closes the rule acted on. */
    signals: number;
    /** Resolutions where the entry was actually touched. */
    fills: number;
    hitRate: number | null;
    expectancyR: number | null;
}

const sma20 = (closes: readonly number[]): number[] => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i += 1) {
        sum += closes[i];
        if (i >= SMA_PERIOD) sum -= closes[i - SMA_PERIOD];
        out.push(i >= SMA_PERIOD - 1 ? sum / SMA_PERIOD : NaN);
    }
    return out;
};

/** The fixed rule, resolved per entry by the ledger's own resolver.
 *  Null when the tape is too short to be a sample. */
export const momentumBaselineFor = (candles: readonly SignalCandle[]): BaselineLane | null => {
    if (candles.length < MIN_TAPE_BARS) return null;
    const closes = candles.map(c => c.close);
    const sma = sma20(closes);
    let signals = 0;
    let fills = 0;
    let wins = 0;
    const outcomeRs: number[] = [];
    for (let i = SMA_PERIOD; i < candles.length; i += 1) {
        const now = candles[i].time;
        // A cross, not a state: close moved from at-or-below to above its
        // SMA20 this bar. Entering on every above-bar would stack dozens of
        // overlapping brackets on one trend and read a rate off one move.
        if (!(closes[i] > sma[i]) || !(closes[i - 1] <= sma[i - 1])) continue;
        const entry = closes[i];
        if (!(entry > 0)) continue;
        signals += 1;
        // The position opens with the NEXT bar: emittedAt just before it, so
        // the signal bar's own close tick cannot grade its own entry.
        const emittedAt = now + SIGNAL_BAR_MS - 1;
        const bracket: SignalBracket = {
            direction: 'long',
            entry,
            stop: entry * (1 - BASELINE_STOP_PCT),
            target: entry * (1 + BASELINE_REWARD_PCT),
            emittedAt,
            expiresAt: emittedAt + BASELINE_HORIZON_BARS * SIGNAL_BAR_MS,
        };
        const draft = resolveSignal(bracket, candles, [], bracket.expiresAt);
        if (!draft || draft.status === 'never_triggered') continue;
        fills += 1;
        if (draft.status === 'won') wins += 1;
        outcomeRs.push(draft.outcomeR);
    }
    return {
        rule: BASELINE_RULE,
        signals,
        fills,
        hitRate: fills > 0 ? wins / fills : null,
        expectancyR: fills > 0 ? outcomeRs.reduce((a, b) => a + b, 0) / fills : null,
    };
};
