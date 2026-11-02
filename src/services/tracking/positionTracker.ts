/**
 * positionTracker — the pure half of the tracked-position loop.
 *
 * It takes a position and the closed 5m tape and returns the next position:
 * entry trigger, MFE/MAE, exit, path, and the reason the pass could not
 * advance. It touches no storage, no network and no clock of its own.
 *
 * THE RULES.
 *  · A signal is resolved by `resolveSignal` — the same resolver the signal
 *    ledger uses. A journal trade is resolved by `scanTradeOutcome` /
 *    `resolveOutcomeFromScan` — the same engine the journal and backtest use.
 *    This module maps their answer; it does not re-derive the arithmetic.
 *  · A same-candle touch of both levels is STOP-FIRST. If a complete 1m
 *    series orders it, the order is used and `ambiguous` is false; otherwise
 *    the policy stands and `ambiguous` is true.
 *  · A gap through a stop fills at the bar OPEN (worse), a gap through a
 *    target fills at the open (better). The reason stays `stop`/`target` and
 *    `gapAtOpen` records the fill quality.
 *  · If the tape does not reach back to the entry window, nothing is resolved
 *    from it. `tapeCoversWindow:false` is the only thing written.
 *  · MFE is >= 0R and MAE is <= 0R, measured over the HELD window only. Null
 *    means unmeasured, never 0.
 *
 * THE PATH. The full 5m path is downsampled to
 * `TRACKED_TIMELINE_MAX_POINTS`; entry, MFE, MAE, exit and the bar after a gap
 * are `decisive` and retained first. When a decisive point must be dropped,
 * `timelineDownsampled` and `timelinePointsDropped` say so. The MFE/MAE
 * values themselves are stored separately, so a dropped bar never hides the
 * excursion.
 *
 * INDEPENDENCE (the skill threshold). Two closed outcomes are independent
 * when they are different trades, their HOLDING WINDOWS do not overlap, and
 * they are not the same setup on the same PHT day. "Same setup" is the
 * recorded family, or `SYMBOL|direction` when no family exists. The day is
 * the day of the ENTRY. This is the definition the 3-outcome threshold uses;
 * `countIndependentOutcomes` returns a greedy independent set, not a maximum
 * independent set (the value is a threshold, not an optimisation).
 */

import type { Kline } from '../../types';
import type { SignalCandle } from '../signals/signalResolver';
import { resolveSignal, roundTripCostR } from '../signals/signalResolver';
import {
    resolveOutcomeFromScan,
    realizedRFromPrices,
    scanTradeOutcome,
} from '../backtesting/outcomeEngine';
import { netRiskReward, stopDistancePercent } from '../../utils/netRiskReward';
import { phtDayKey } from '../../utils/timezone';
import type {
    DiagnosisQueueItem,
    TrackedContextPoint,
    TrackedExit,
    TrackedOutcomeWindow,
    TrackedPosition,
    TrackPoint,
} from '../../types/tracking';
import {
    TRACKED_CONTEXT_MAX_POINTS,
    TRACKED_TIMELINE_MAX_POINTS,
} from '../../types/tracking';

export { TRACKED_CONTEXT_MAX_POINTS, TRACKED_TIMELINE_MAX_POINTS };

export const TRACKED_BAR_MS = 5 * 60_000;
export const DIAGNOSIS_BATCH_CAP = 3;
export const MAX_DIAGNOSIS_ATTEMPTS = 3;
export const DIAGNOSIS_STALE_MS = 10 * 60_000;
export const MIN_INDEPENDENT_OUTCOMES = 3;
export const MAX_GAP_MARKERS = 20;

export interface AdvanceInput {
    position: TrackedPosition;
    /** Closed 5m bars, ascending, covering the WHOLE tracked window (entry
     *  through the current closed bar). The path and excursions are rebuilt
     *  from them; a partial window would shrink the path. */
    bars: readonly Kline[];
    /** 1m bars inside the deciding bar, only when the coarse bar touched both
     *  levels. A complete series is required to order them. */
    drill?: readonly SignalCandle[];
    /** The time the pass is allowed to see. Defaults to Date.now(). */
    now?: number;
}

export type AdvanceBlock =
    | 'already-closed'
    | 'no-bars'
    | 'tape-incomplete';

export interface AdvanceResult {
    position: TrackedPosition;
    /** Terminal status after this pass. */
    closed: boolean;
    /** A real exit was written on THIS call (the diagnosis should be queued). */
    exitedNow: boolean;
    /** Present when the pass could not evaluate the position. */
    blocked?: AdvanceBlock;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const isLong = (p: TrackedPosition): boolean => p.direction === 'long';
const riskOf = (p: TrackedPosition): number => Math.abs(p.entry - p.stop);
const isTerminal = (p: TrackedPosition): boolean =>
    p.status === 'closed' || p.status === 'expired' || p.status === 'cancelled';

const usableBar = (b: Kline): boolean =>
    finite(b.time) && finite(b.open) && finite(b.high) && finite(b.low) && finite(b.close);

const rOf = (p: TrackedPosition, price: number): number | null => {
    const risk = riskOf(p);
    if (!(risk > 0) || !finite(price)) return null;
    return round6((isLong(p) ? price - p.entry : p.entry - price) / risk);
};

const toPoint = (b: Kline, decisive = false): TrackPoint => ({
    t: b.time,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    ...(finite(b.volume) ? { v: b.volume } : {}),
    ...(decisive ? { decisive: true } : {}),
});

/** A gap fills at the bar open when the open is already beyond the level.
 *  A stop fills worse; a target fills better. */
export const gapAdjustedFill = (
    bar: Kline,
    level: number,
    long: boolean,
    kind: 'stop' | 'target',
): { price: number; gapped: boolean } => {
    if (!finite(bar.open) || !finite(level)) return { price: level, gapped: false };
    if (kind === 'stop') {
        if (long && bar.open < level) return { price: bar.open, gapped: true };
        if (!long && bar.open > level) return { price: bar.open, gapped: true };
    } else {
        if (long && bar.open > level) return { price: bar.open, gapped: true };
        if (!long && bar.open < level) return { price: bar.open, gapped: true };
    }
    return { price: level, gapped: false };
};

/** Bar open times of missing 5m bars inside the window, capped. */
export const detectGaps = (bars: readonly Kline[], max = MAX_GAP_MARKERS): number[] => {
    const gaps: number[] = [];
    for (let i = 1; i < bars.length && gaps.length < max; i += 1) {
        const previous = bars[i - 1];
        const current = bars[i];
        if (!usableBar(previous) || !usableBar(current)) continue;
        const delta = current.time - previous.time;
        if (delta <= TRACKED_BAR_MS) continue;
        for (let t = previous.time + TRACKED_BAR_MS; t < current.time && gaps.length < max; t += TRACKED_BAR_MS) {
            gaps.push(t);
        }
    }
    return gaps;
};

export interface DownsampledTimeline {
    points: TrackPoint[];
    dropped: number;
    downsampled: boolean;
}

/** Keep decisive points first, then an even sample of the rest, under a hard
 *  cap. A cap smaller than the decisive set drops decisive points too; the
 *  caller records that fact rather than pretending the path is complete. */
export const downsampleTimeline = (
    points: readonly TrackPoint[],
    max = TRACKED_TIMELINE_MAX_POINTS,
): DownsampledTimeline => {
    if (points.length <= max) {
        return { points: [...points], dropped: 0, downsampled: false };
    }
    const limit = Math.max(2, max);
    const keep = new Set<number>([0, points.length - 1]);
    const decisive: number[] = [];
    points.forEach((point, index) => { if (point.decisive) decisive.push(index); });

    if (decisive.length > limit - 2) {
        const slots = limit - 2;
        for (let k = 0; k < slots; k += 1) {
            const at = slots === 1 ? 0 : Math.round((k * (decisive.length - 1)) / (slots - 1));
            keep.add(decisive[at]);
        }
    } else {
        for (const index of decisive) keep.add(index);
        const remaining = limit - keep.size;
        if (remaining > 0) {
            const candidates: number[] = [];
            for (let i = 0; i < points.length; i += 1) {
                if (!keep.has(i)) candidates.push(i);
            }
            const step = candidates.length / remaining;
            for (let k = 0; k < remaining; k += 1) {
                keep.add(candidates[Math.min(candidates.length - 1, Math.floor(k * step))]);
            }
        }
    }
    const kept = [...keep].sort((a, b) => a - b).map(index => points[index]);
    return {
        points: kept,
        dropped: points.length - kept.length,
        downsampled: kept.length < points.length,
    };
};

export const downsampleContext = (
    points: readonly TrackedContextPoint[],
    max = TRACKED_CONTEXT_MAX_POINTS,
): { points: TrackedContextPoint[]; downsampled: boolean } => {
    if (points.length <= max) return { points: [...points], downsampled: false };
    const limit = Math.max(2, max);
    const keep: number[] = [];
    const step = (points.length - 1) / (limit - 1);
    for (let k = 0; k < limit; k += 1) keep.push(Math.round(k * step));
    return {
        points: [...new Set(keep)].map(index => points[index]),
        downsampled: true,
    };
};

interface ExcursionValues {
    mfeR: number;
    maeR: number;
    mfePrice: number;
    maePrice: number;
    mfeAt: number;
    maeAt: number;
}

/** MFE/MAE over [entryIndex, exitIndex], inclusive. The entry bar is
 *  included; `entryBarAmbiguous` on the position says its extremes may
 *  include action before the fill. */
const computeExcursions = (
    position: TrackedPosition,
    bars: readonly Kline[],
    entryIndex: number,
    exitIndex: number,
): ExcursionValues | null => {
    if (entryIndex < 0 || exitIndex < entryIndex) return null;
    const long = isLong(position);
    let mfeR = 0;
    let maeR = 0;
    let mfePrice = position.entry;
    let maePrice = position.entry;
    let mfeAt = bars[entryIndex]?.time ?? position.openedAt;
    let maeAt = mfeAt;
    let sawBar = false;

    for (let i = entryIndex; i <= exitIndex; i += 1) {
        const bar = bars[i];
        if (!usableBar(bar)) continue;
        sawBar = true;
        const favorable = long ? bar.high : bar.low;
        const adverse = long ? bar.low : bar.high;
        const favorableR = rOf(position, favorable);
        const adverseR = rOf(position, adverse);
        if (favorableR !== null && favorableR > mfeR) {
            mfeR = favorableR;
            mfePrice = favorable;
            mfeAt = bar.time;
        }
        if (adverseR !== null && adverseR < maeR) {
            maeR = adverseR;
            maePrice = adverse;
            maeAt = bar.time;
        }
    }
    if (!sawBar) return null;
    return { mfeR, maeR, mfePrice, maePrice, mfeAt, maeAt };
};

const entryBarIsAmbiguous = (position: TrackedPosition, bar: Kline): boolean => {
    if (position.entryConfirmed) return false;
    if (!usableBar(bar)) return false;
    return isLong(position) ? bar.open > position.entry : bar.open < position.entry;
};

const firstTouchIndex = (position: TrackedPosition, bars: readonly Kline[]): number => {
    const long = isLong(position);
    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        if (!usableBar(bar) || bar.time < position.openedAt) continue;
        if (long ? bar.low <= position.entry : bar.high >= position.entry) return i;
    }
    return -1;
};

const indexAtOrBefore = (bars: readonly Kline[], time: number): number => {
    let found = -1;
    for (let i = 0; i < bars.length; i += 1) {
        if (bars[i].time <= time) found = i;
        else break;
    }
    return found;
};

const indexAt = (bars: readonly Kline[], time: number): number => {
    const exact = bars.findIndex(bar => bar.time === time);
    return exact >= 0 ? exact : indexAtOrBefore(bars, time);
};

const pointIndexAt = (points: readonly TrackPoint[], time: number): number => {
    let found = -1;
    for (let i = 0; i < points.length; i += 1) {
        if (points[i].t <= time) found = i;
        else break;
    }
    return found;
};

const buildTimeline = (
    bars: readonly Kline[],
    entryIndex: number,
    exitIndex: number,
    mfeAt: number | null,
    maeAt: number | null,
    exitAt: number | null,
    gaps: readonly number[],
): DownsampledTimeline => {
    const points = bars.map(bar => toPoint(bar));
    const mark = (index: number): void => {
        if (index >= 0 && index < points.length) points[index].decisive = true;
    };
    mark(entryIndex);
    mark(exitIndex);
    if (mfeAt !== null) mark(pointIndexAt(points, mfeAt));
    if (maeAt !== null) mark(pointIndexAt(points, maeAt));
    if (exitAt !== null) mark(pointIndexAt(points, exitAt));
    for (const gap of gaps) {
        const next = points.findIndex(point => point.t >= gap);
        if (next >= 0) points[next].decisive = true;
    }
    return downsampleTimeline(points);
};

const signalExit = (
    position: TrackedPosition,
    bars: readonly Kline[],
    drill: readonly SignalCandle[],
    now: number,
): {
    exit: TrackedExit;
    status: 'closed' | 'expired' | 'cancelled';
    exitIndex: number;
    entryIndex: number;
    discrepancy?: string;
} | null => {
    const target = position.targets[0];
    if (!finite(target)) return null;
    const draft = resolveSignal(
        {
            direction: position.direction,
            entry: position.entry,
            stop: position.stop,
            target,
            emittedAt: position.openedAt,
            expiresAt: position.expiresAt ?? now,
        },
        bars,
        drill,
        now,
    );
    if (draft === null) return null;
    if (draft.status === 'never_triggered') {
        return {
            status: 'cancelled',
            exitIndex: -1,
            entryIndex: -1,
            exit: {
                reason: 'expiry',
                price: position.entry,
                at: now,
                sameCandle: 'single-level',
                ambiguous: false,
                gapAtOpen: false,
                barsRead: bars.length,
                realizedR: null,
                costR: null,
                netR: null,
                slippageModeled: true,
            },
            discrepancy: 'entry never triggered',
        };
    }

    const reason = draft.status === 'won' ? 'target' : draft.status === 'lost' ? 'stop' : 'expiry';
    const exitIndex = draft.exitAt !== undefined ? indexAt(bars, draft.exitAt) : bars.length - 1;
    const exitBar = exitIndex >= 0 ? bars[exitIndex] : null;
    const level = reason === 'target' ? target : position.stop;
    const basePrice = draft.exitPrice ?? level;
    const adjusted = exitBar && reason !== 'expiry'
        ? gapAdjustedFill(exitBar, level, isLong(position), reason === 'target' ? 'target' : 'stop')
        : { price: basePrice, gapped: false };
    const price = adjusted.price;
    const realizedR = reason === 'expiry'
        ? rOf(position, price)
        : realizedRFromPrices(position.entry, position.stop, price, isLong(position));
    const costR = draft.feeR;
    const netR = realizedR !== null && finite(costR) ? round6(realizedR - costR) : null;

    return {
        status: draft.status === 'expired' ? 'expired' : 'closed',
        exitIndex,
        entryIndex: firstTouchIndex(position, bars),
        exit: {
            reason,
            price,
            at: exitBar?.time ?? draft.exitAt ?? now,
            sameCandle: draft.ambiguous
                ? 'stop-first'
                : draft.path === '1m' ? 'ordered-1m' : 'single-level',
            ambiguous: draft.ambiguous,
            gapAtOpen: adjusted.gapped,
            barsRead: bars.length,
            realizedR,
            costR: finite(costR) ? round6(costR) : null,
            netR,
            slippageModeled: true,
        },
    };
};

const journalExit = (
    position: TrackedPosition,
    bars: readonly Kline[],
    now: number,
): {
    exit: TrackedExit;
    status: 'closed' | 'expired' | 'cancelled';
    exitIndex: number;
    entryIndex: number;
    discrepancy?: string;
} | null => {
    const startIndex = position.entryConfirmed
        ? bars.findIndex(bar => bar.time + TRACKED_BAR_MS > position.openedAt)
        : undefined;
    if (position.entryConfirmed && (startIndex === undefined || startIndex < 0)) return null;

    const scan = scanTradeOutcome(
        bars as Kline[],
        position.entry,
        position.stop,
        position.targets,
        isLong(position),
        {
            excludeFormingCandle: false,
            ...(startIndex !== undefined ? { startIndex } : {}),
        },
    );
    const resolution = resolveOutcomeFromScan(scan);
    const entryIndex = scan.entryTriggeredAtIndex;

    if (resolution.outcome === 'INVALID') {
        return {
            status: 'cancelled',
            exitIndex: -1,
            entryIndex,
            exit: {
                reason: 'manual',
                price: position.entry,
                at: now,
                sameCandle: 'single-level',
                ambiguous: false,
                gapAtOpen: false,
                barsRead: bars.length,
                realizedR: null,
                costR: null,
                netR: null,
                slippageModeled: false,
            },
            discrepancy: resolution.invalidReason ?? 'invalid plan',
        };
    }

    if (!scan.entryTriggered) {
        if (position.expiresAt !== undefined && now >= position.expiresAt) {
            return {
                status: 'cancelled',
                exitIndex: -1,
                entryIndex: -1,
                exit: {
                    reason: 'expiry',
                    price: position.entry,
                    at: now,
                    sameCandle: 'single-level',
                    ambiguous: false,
                    gapAtOpen: false,
                    barsRead: bars.length,
                    realizedR: null,
                    costR: null,
                    netR: null,
                    slippageModeled: false,
                },
                discrepancy: 'entry never triggered',
            };
        }
        return null;
    }

    if (resolution.outcome === 'OPEN') {
        if (position.expiresAt === undefined || now < position.expiresAt) return null;
        const lastIndex = bars.length - 1;
        const last = bars[lastIndex];
        if (!last || !usableBar(last)) return null;
        const grossR = rOf(position, last.close);
        const cost = grossR !== null
            ? netRiskReward({
                grossR,
                stopDistancePct: stopDistancePercent(position.entry, position.stop),
            })
            : null;
        return {
            status: 'expired',
            exitIndex: lastIndex,
            entryIndex,
            exit: {
                reason: 'expiry',
                price: last.close,
                at: last.time,
                sameCandle: 'single-level',
                ambiguous: false,
                gapAtOpen: false,
                barsRead: bars.length,
                realizedR: grossR,
                costR: cost && cost.known ? cost.costR : null,
                netR: cost && cost.known ? cost.netR : null,
                slippageModeled: false,
            },
        };
    }

    const win = resolution.outcome === 'WIN';
    const sameCandleBoth = scan.slTouched
        && scan.tpHits.some(hit => hit.candleIndex === scan.slTouchIndex);
    let exitIndex: number;
    let price: number;
    let gapped: boolean;

    if (win) {
        const lastHit = scan.tpHits[scan.tpHits.length - 1];
        if (!lastHit) return null;
        exitIndex = lastHit.candleIndex;
        const bar = bars[exitIndex];
        const adjusted = bar
            ? gapAdjustedFill(bar, lastHit.price, isLong(position), 'target')
            : { price: lastHit.price, gapped: false };
        const firstHit = scan.tpHits[0];
        if (!firstHit) return null;
        // A TP1 that gaps favourably is a better partial fill; the blended
        // exit must use it, not the printed level.
        const firstBar = bars[firstHit.candleIndex];
        const firstAdjusted = firstBar
            ? gapAdjustedFill(firstBar, firstHit.price, isLong(position), 'target')
            : { price: firstHit.price, gapped: false };
        gapped = adjusted.gapped || firstAdjusted.gapped;
        price = scan.tpHits.length > 1
            ? (firstAdjusted.price + adjusted.price) / 2
            : scan.breakevenHit && finite(scan.breakevenPrice)
                ? (firstAdjusted.price + (scan.breakevenPrice as number)) / 2
                : adjusted.price;
    } else {
        const level = scan.extendedSlExceeded ? scan.extendedSlPrice : position.stop;
        const deciding = scan.extendedSlExceeded ? scan.slExceededIndex : scan.slTouchIndex;
        exitIndex = deciding ?? scan.slTouchIndex ?? bars.length - 1;
        const bar = bars[exitIndex];
        const adjusted = bar
            ? gapAdjustedFill(bar, level, isLong(position), 'stop')
            : { price: level, gapped: false };
        price = adjusted.price;
        gapped = adjusted.gapped;
    }

    const grossR = realizedRFromPrices(position.entry, position.stop, price, isLong(position));
    const cost = grossR !== null
        ? netRiskReward({
            grossR,
            stopDistancePct: stopDistancePercent(position.entry, position.stop),
        })
        : null;
    const exitBar = bars[exitIndex];

    return {
        status: 'closed',
        exitIndex,
        entryIndex,
        exit: {
            reason: win ? 'target' : 'stop',
            price,
            at: exitBar?.time ?? now,
            sameCandle: sameCandleBoth ? 'stop-first' : 'single-level',
            ambiguous: sameCandleBoth,
            gapAtOpen: gapped,
            barsRead: bars.length,
            realizedR: grossR,
            costR: cost && cost.known ? cost.costR : null,
            netR: cost && cost.known ? cost.netR : null,
            slippageModeled: false,
        },
    };
};

/** Advance one position over the closed tape. Idempotent: the same input
 *  returns the same state, and an already-terminal position is untouched. */
export const advancePosition = (input: AdvanceInput): AdvanceResult => {
    const now = input.now ?? Date.now();
    const { position } = input;
    if (isTerminal(position)) {
        return { position, closed: true, exitedNow: false, blocked: 'already-closed' };
    }

    const bars = input.bars
        .filter(usableBar)
        .filter(bar => bar.time + TRACKED_BAR_MS <= now)
        .slice()
        .sort((a, b) => a.time - b.time);
    if (bars.length === 0) {
        return { position, closed: false, exitedNow: false, blocked: 'no-bars' };
    }

    const windowStart = position.entryBarTime ?? position.openedAt;
    const firstBar = bars[0];
    if (firstBar.time > windowStart + TRACKED_BAR_MS) {
        return {
            position: { ...position, tapeCoversWindow: false },
            closed: false,
            exitedNow: false,
            blocked: 'tape-incomplete',
        };
    }

    const gaps = detectGaps(bars);
    const sourceExit = position.source === 'signal'
        ? signalExit(position, bars, input.drill ?? [], now)
        : journalExit(position, bars, now);

    let next: TrackedPosition = {
        ...position,
        tapeCoversWindow: true,
        barsRead: bars.length,
        gaps,
    };

    if (sourceExit === null) {
        // Still open (or still waiting for the entry). The path and the
        // excursions are still updated, so a trader can see the held window
        // before the exit exists.
        const entryIndex = position.entryConfirmed
            ? bars.findIndex(bar => bar.time + TRACKED_BAR_MS > position.openedAt)
            : position.source === 'signal'
                ? firstTouchIndex(position, bars)
                : scanTradeOutcome(
                    bars as Kline[],
                    position.entry,
                    position.stop,
                    position.targets,
                    isLong(position),
                    { excludeFormingCandle: false },
                ).entryTriggeredAtIndex;
        const entered = entryIndex >= 0;
        const lastIndex = bars.length - 1;
        const excursions = entered ? computeExcursions(position, bars, entryIndex, lastIndex) : null;
        const timeline = buildTimeline(
            bars,
            entryIndex,
            lastIndex,
            excursions?.mfeAt ?? null,
            excursions?.maeAt ?? null,
            null,
            gaps,
        );
        const context = downsampleContext(next.context);
        next = {
            ...next,
            status: entered ? 'open' : 'pending_entry',
            ...(entered && position.entryBarTime === undefined ? { entryBarTime: bars[entryIndex].time } : {}),
            ...(entered && position.entryBarAmbiguous === undefined
                ? { entryBarAmbiguous: entryBarIsAmbiguous(position, bars[entryIndex]) }
                : {}),
            ...(excursions
                ? {
                    mfeR: excursions.mfeR,
                    maeR: excursions.maeR,
                    mfePrice: excursions.mfePrice,
                    maePrice: excursions.maePrice,
                    mfeAt: excursions.mfeAt,
                    maeAt: excursions.maeAt,
                }
                : {}),
            timeline: timeline.points,
            timelineDownsampled: timeline.downsampled,
            timelinePointsDropped: timeline.dropped,
            context: context.points,
            contextDownsampled: context.downsampled,
            cursor: { lastClosedBarTime: lastIndex >= 0 ? bars[lastIndex].time + TRACKED_BAR_MS : position.cursor.lastClosedBarTime, timeframe: '5m' },
        };
        return { position: next, closed: false, exitedNow: false };
    }

    const terminal = sourceExit.status;
    const realExit = terminal !== 'cancelled';
    const entryIndex = sourceExit.entryIndex;
    const exitIndex = sourceExit.exitIndex >= 0 ? sourceExit.exitIndex : bars.length - 1;
    const excursions = realExit
        ? computeExcursions(position, bars, entryIndex, exitIndex)
        : null;
    const timeline = buildTimeline(
        bars,
        entryIndex,
        exitIndex,
        excursions?.mfeAt ?? null,
        excursions?.maeAt ?? null,
        realExit ? sourceExit.exit.at : null,
        gaps,
    );
    const context = downsampleContext(next.context);

    next = {
        ...next,
        status: terminal,
        ...(realExit && entryIndex >= 0 && position.entryBarTime === undefined
            ? { entryBarTime: bars[entryIndex].time }
            : {}),
        ...(realExit && entryIndex >= 0 && position.entryBarAmbiguous === undefined
            ? { entryBarAmbiguous: entryBarIsAmbiguous(position, bars[entryIndex]) }
            : {}),
        ...(excursions
            ? {
                mfeR: excursions.mfeR,
                maeR: excursions.maeR,
                mfePrice: excursions.mfePrice,
                maePrice: excursions.maePrice,
                mfeAt: excursions.mfeAt,
                maeAt: excursions.maeAt,
            }
            : {}),
        timeline: timeline.points,
        timelineDownsampled: timeline.downsampled,
        timelinePointsDropped: timeline.dropped,
        context: context.points,
        contextDownsampled: context.downsampled,
        cursor: {
            lastClosedBarTime: bars[bars.length - 1].time + TRACKED_BAR_MS,
            timeframe: '5m',
        },
        ...(realExit
            ? {
                closedAt: sourceExit.exit.at + TRACKED_BAR_MS,
                exit: sourceExit.exit,
            }
            : { closedAt: now }),
        ...(sourceExit.discrepancy ? { discrepancy: sourceExit.discrepancy } : {}),
    };

    return { position: next, closed: true, exitedNow: realExit && !isTerminal(position) };
};

/** Manual close at a price the trader chose. The caller should run a pass
 *  first so MFE/MAE cover the window; this function does not invent bars. */
export const closePositionManually = (
    position: TrackedPosition,
    price: number,
    at: number = Date.now(),
): TrackedPosition => {
    // A pending entry has no position to close; closing it at a price would
    // invent a fill the tape never gave. The caller cancels it instead.
    if (position.status !== 'open' || !finite(price) || price <= 0) return position;
    const grossR = realizedRFromPrices(position.entry, position.stop, price, isLong(position));
    const signalCost = position.source === 'signal' ? roundTripCostR(position) : null;
    const journalCost = grossR !== null && position.source === 'journal'
        ? netRiskReward({
            grossR,
            stopDistancePct: stopDistancePercent(position.entry, position.stop),
        })
        : null;
    const costR = position.source === 'signal'
        ? signalCost
        : journalCost && journalCost.known ? journalCost.costR : null;
    const netR = grossR !== null && finite(costR) ? round6(grossR - costR) : null;
    return {
        ...position,
        status: 'closed',
        closedAt: at,
        exit: {
            reason: 'manual',
            price,
            at,
            sameCandle: 'single-level',
            ambiguous: false,
            gapAtOpen: false,
            barsRead: position.barsRead,
            realizedR: grossR,
            costR: finite(costR) ? round6(costR) : null,
            netR,
            slippageModeled: position.source === 'signal',
        },
    };
};

// ─── Independence: the 3-outcome threshold ─────────────────────────────────

/** The setup key: the recorded family, or SYMBOL|direction. */
export const setupKeyOf = (position: TrackedPosition): string => {
    const family = position.entryContext.family?.trim().toLowerCase();
    if (family) return family;
    return `${position.symbol.trim().toUpperCase()}|${position.direction}`;
};

/** A closed outcome's holding window, or null for a non-terminal position. */
export const outcomeWindowOf = (position: TrackedPosition): TrackedOutcomeWindow | null => {
    if (!isTerminal(position) || position.status === 'cancelled') return null;
    const openedAt = position.entryBarTime ?? position.openedAt;
    const closedAt = position.closedAt;
    if (!finite(openedAt) || !finite(closedAt) || closedAt < openedAt) return null;
    return {
        id: position.id,
        setupKey: setupKeyOf(position),
        openedAt,
        closedAt,
    };
};

/**
 * The independence definition, in one place:
 *  · different trades;
 *  · holding windows do not overlap;
 *  · not the same setup on the same PHT day.
 * Two windows that merely touch (one closes at the other's open) do not
 * overlap. The day is the day of the ENTRY.
 */
export const areIndependentOutcomes = (
    a: TrackedOutcomeWindow,
    b: TrackedOutcomeWindow,
): boolean => {
    if (a.id === b.id) return false;
    const overlap = a.openedAt < b.closedAt && b.openedAt < a.closedAt;
    if (overlap) return false;
    const sameSetupSameDay = a.setupKey === b.setupKey
        && phtDayKey(a.openedAt) === phtDayKey(b.openedAt);
    return !sameSetupSameDay;
};

/** A greedy independent set, oldest first. It is a threshold, not an
 *  optimisation: the first outcome wins and a later overlapping one is
 *  skipped. */
export const countIndependentOutcomes = (
    windows: readonly TrackedOutcomeWindow[],
): number => {
    const sorted = [...windows].sort((a, b) => a.openedAt - b.openedAt);
    const kept: TrackedOutcomeWindow[] = [];
    for (const window of sorted) {
        if (kept.every(other => areIndependentOutcomes(other, window))) kept.push(window);
    }
    return kept.length;
};

// ─── Diagnosis queue ───────────────────────────────────────────────────────

/** Reset a `running` item whose pass died (app closed mid-call) so it can be
 *  retried. A finished or failed item is not resurrected here. */
export const requeueStaleDiagnoses = (
    queue: readonly DiagnosisQueueItem[],
    now: number = Date.now(),
    staleMs: number = DIAGNOSIS_STALE_MS,
): DiagnosisQueueItem[] => queue.map(item => {
    if (item.status !== 'running') return item;
    const started = item.startedAt ?? item.queuedAt;
    if (now - started < staleMs) return item;
    return { ...item, status: 'pending', startedAt: undefined };
});

/**
 * Select up to `cap` diagnosable items. Pending items and failed items that
 * still have attempts left are eligible; everything else stays in `remaining`.
 * The sum is always the whole queue — the per-pass cap can delay a diagnosis,
 * never drop it.
 */
export const selectDiagnosisBatch = (
    queue: readonly DiagnosisQueueItem[],
    cap: number = DIAGNOSIS_BATCH_CAP,
): { batch: DiagnosisQueueItem[]; remaining: DiagnosisQueueItem[] } => {
    const eligible = queue.filter(item =>
        item.status === 'pending'
        || (item.status === 'failed' && item.attempts < MAX_DIAGNOSIS_ATTEMPTS));
    const batch = eligible.slice(0, Math.max(0, cap));
    const batchIds = new Set(batch.map(item => item.id));
    return {
        batch,
        remaining: queue.filter(item => !batchIds.has(item.id)),
    };
};
