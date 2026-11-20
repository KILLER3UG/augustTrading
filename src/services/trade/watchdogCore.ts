/**
 * watchdogCore — deterministic ATR-scaled trigger tolerance, re-arm hysteresis,
 * bar cooldowns, and drawing-anchored triggers (`price_cross_drawing` &
 * `candle_close` near watched drawings).
 *
 * Pure & DOM-free so every hysteresis / cooldown / diagonal-cross edge case is
 * directly unit-tested via `node:test`.
 */

import type { ChartDrawing } from './chartDrawings';
import {
    evaluateDrawingAtNow,
    type EvalCandle,
    type PriceScaleMode,
} from './chartGeometry';

export const ATR_TRIGGER_FACTOR = 0.15;
export const ATR_REARM_FACTOR = 0.5;
export const DEFAULT_COOLDOWN_BARS = 2;

export interface HysteresisConfig {
    atr14: number | null;
    tickSize?: number;
    /** Minimum bars between consecutive triggers for the same watch (default 2). */
    cooldownBars?: number;
    /** Bar interval in seconds (used to compute bar delta for cooldowns). */
    barSeconds?: number;
}

export interface WatchdogLatchState {
    /** True while inside the trigger zone / waiting for re-arm hysteresis. */
    latched: boolean;
    /** Last known side relative to target ('above' | 'below' | 'inside' | null). */
    lastSide: 'above' | 'below' | 'inside' | null;
    /** Candle open timestamp (unix seconds) when this watch last fired. */
    lastFiredBarTime: number | null;
    /** Total times fired in current session. */
    fireCount: number;
}

export const createWatchdogLatch = (): WatchdogLatchState => ({
    latched: false,
    lastSide: null,
    lastFiredBarTime: null,
    fireCount: 0,
});

/**
 * ATR-scaled trigger tolerance: `max(0.15 * ATR(14), tickSize)`.
 * Replaces fixed basis-point tolerances so volatile altcoins and tight BTC
 * ranges get volatility-appropriate touch buffers.
 */
export const computeAtrTolerance = (atr14: number | null, tickSize = 0): number => {
    const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0;
    if (typeof atr14 === 'number' && Number.isFinite(atr14) && atr14 > 0) {
        return Math.max(ATR_TRIGGER_FACTOR * atr14, safeTick);
    }
    return safeTick;
};

/**
 * Re-arm hysteresis distance: `max(0.5 * ATR(14), tickSize * 3)`.
 * Price must pull away by at least this distance before a latched trigger can
 * re-arm, preventing chop-induced alert storms.
 */
export const computeRearmDistance = (atr14: number | null, tickSize = 0): number => {
    const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0;
    if (typeof atr14 === 'number' && Number.isFinite(atr14) && atr14 > 0) {
        return Math.max(ATR_REARM_FACTOR * atr14, safeTick * 3);
    }
    return safeTick * 3;
};

/**
 * Check whether an ENTRY level latch is ready to re-arm using ATR-scaled
 * hysteresis (`>= 0.5 * ATR(14)` on the far side of entry).
 */
export const shouldRearmEntryWithHysteresis = (
    entryPrice: number,
    livePrice: number,
    direction: 'Long' | 'Short',
    atr14: number | null,
    tickSize = 0,
): boolean => {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(livePrice) || entryPrice <= 0) return false;
    const rearmDist = computeRearmDistance(atr14, tickSize);
    if (direction === 'Long') {
        return livePrice >= entryPrice + rearmDist;
    }
    return livePrice <= entryPrice - rearmDist;
};

/** Check whether bar cooldown has elapsed since `lastFiredBarTime`. */
export const isCooldownElapsed = (
    lastFiredBarTime: number | null,
    currentBarTime: number,
    cooldownBars = DEFAULT_COOLDOWN_BARS,
    barSeconds = 900,
): boolean => {
    if (lastFiredBarTime === null) return true;
    const step = Number.isFinite(barSeconds) && barSeconds > 0 ? barSeconds : 900;
    const elapsedBars = Math.floor((currentBarTime - lastFiredBarTime) / step);
    return elapsedBars >= Math.max(0, cooldownBars);
};

export type DrawingTriggerKind = 'price_cross_drawing' | 'candle_close_drawing';

export interface DrawingWatchTriggerEvent {
    kind: DrawingTriggerKind;
    symbol: string;
    drawingId: string;
    shortId?: string;
    drawingKind: ChartDrawing['kind'];
    drawingLabel?: string;
    tf: string;
    livePrice: number;
    targetPrice: number;
    tolerance: number;
    distancePrice: number;
    distanceAtr: number | null;
    crossedDirection: 'up' | 'down' | 'touch';
    barTime: number;
    triggeredAt: number;
}

export interface EvaluateDrawingWatchInput {
    symbol: string;
    drawing: ChartDrawing;
    activeTf: string;
    barSeconds: number;
    priceScaleMode: PriceScaleMode;
    candles: ReadonlyArray<EvalCandle>;
    livePrice: number;
    /** True when evaluating at a candle close; false on live mark ticks. */
    isCandleClose?: boolean;
    /** Optional override for current bar open timestamp (unix seconds). */
    currentBarTime?: number;
    tickSize?: number;
    atr14: number | null;
    cooldownBars?: number;
    state: WatchdogLatchState;
}

export interface EvaluateDrawingWatchOutput {
    event: DrawingWatchTriggerEvent | null;
    nextState: WatchdogLatchState;
}

/**
 * Evaluate a watched user or AI drawing (`hline`, `trend`, `ray`, `channel`,
 * `rect`, `fib`, `long_position`, `short_position`) against live price or
 * candle close using exact `evaluateDrawingAtNow` geometry, ATR-scaled touch
 * tolerance, `0.5 * ATR(14)` re-arm hysteresis, and bar cooldowns.
 */
export const evaluateDrawingWatch = (
    input: EvaluateDrawingWatchInput,
): EvaluateDrawingWatchOutput => {
    const {
        symbol,
        drawing,
        activeTf,
        barSeconds,
        priceScaleMode,
        candles,
        livePrice,
        isCandleClose = false,
        tickSize = 0,
        atr14,
        cooldownBars = DEFAULT_COOLDOWN_BARS,
        state,
    } = input;

    if (!Number.isFinite(livePrice) || livePrice <= 0 || candles.length === 0) {
        return { event: null, nextState: state };
    }

    const barTime = input.currentBarTime ?? candles[candles.length - 1].time;
    const evaluated = evaluateDrawingAtNow(drawing, {
        symbol,
        activeTf,
        candles,
        markPrice: livePrice,
        priceScaleMode,
        atr14,
        tickSize,
    });

    const tol = computeAtrTolerance(atr14, tickSize);
    const rearmDist = computeRearmDistance(atr14, tickSize);

    // Determine reference target price and signed distance from the drawing geometry.
    let targetPrice: number | null = null;
    let absDist = Infinity;
    let currentSide: 'above' | 'below' | 'inside' = 'inside';

    if (evaluated.bounds !== undefined) {
        const hi = Math.max(evaluated.bounds.upper, evaluated.bounds.lower);
        const lo = Math.min(evaluated.bounds.upper, evaluated.bounds.lower);
        if (livePrice >= lo - tol && livePrice <= hi + tol) {
            currentSide = 'inside';
            targetPrice = Math.abs(livePrice - hi) <= Math.abs(livePrice - lo) ? hi : lo;
            absDist = livePrice >= lo && livePrice <= hi
                ? 0
                : Math.min(Math.abs(livePrice - hi), Math.abs(livePrice - lo));
        } else if (livePrice > hi + tol) {
            currentSide = 'above';
            targetPrice = hi;
            absDist = livePrice - hi;
        } else {
            currentSide = 'below';
            targetPrice = lo;
            absDist = lo - livePrice;
        }
    } else if (evaluated.projectedPrice !== null && Number.isFinite(evaluated.projectedPrice)) {
        targetPrice = evaluated.projectedPrice;
        const delta = livePrice - targetPrice;
        absDist = Math.abs(delta);
        currentSide = absDist <= tol ? 'inside' : delta > 0 ? 'above' : 'below';
    } else if (drawing.points[0] && Number.isFinite(drawing.points[0].p)) {
        targetPrice = drawing.points[0].p;
        const delta = livePrice - targetPrice;
        absDist = Math.abs(delta);
        currentSide = absDist <= tol ? 'inside' : delta > 0 ? 'above' : 'below';
    }

    if (targetPrice === null) {
        return { event: null, nextState: state };
    }

    // Re-arm hysteresis check: once latched, price MUST pull away >= 0.5 * ATR(14)
    // before the latch clears.
    let latched = state.latched;
    if (latched && currentSide !== 'inside' && absDist >= rearmDist) {
        latched = false;
    }

    // Did price cross from one side to the other OR enter the ATR tolerance band?
    const crossedUp = state.lastSide === 'below' && (currentSide === 'above' || currentSide === 'inside');
    const crossedDown = state.lastSide === 'above' && (currentSide === 'below' || currentSide === 'inside');
    const inBand = currentSide === 'inside' || absDist <= tol;
    const triggered = crossedUp || crossedDown || inBand;

    if (!triggered || latched) {
        return {
            event: null,
            nextState: {
                ...state,
                latched,
                lastSide: currentSide,
            },
        };
    }

    if (!isCooldownElapsed(state.lastFiredBarTime, barTime, cooldownBars, barSeconds)) {
        return {
            event: null,
            nextState: {
                ...state,
                latched: true,
                lastSide: currentSide,
            },
        };
    }

    const crossedDirection: 'up' | 'down' | 'touch' = crossedUp ? 'up' : crossedDown ? 'down' : 'touch';
    const distanceAtr = atr14 && atr14 > 0 ? Math.round((absDist / atr14) * 100) / 100 : null;

    return {
        event: {
            kind: isCandleClose ? 'candle_close_drawing' : 'price_cross_drawing',
            symbol,
            drawingId: drawing.id,
            shortId: drawing.shortId,
            drawingKind: drawing.kind,
            drawingLabel: drawing.label,
            tf: activeTf,
            livePrice,
            targetPrice,
            tolerance: tol,
            distancePrice: absDist,
            distanceAtr,
            crossedDirection,
            barTime,
            triggeredAt: Date.now(),
        },
        nextState: {
            latched: true,
            lastSide: currentSide,
            lastFiredBarTime: barTime,
            fireCount: state.fireCount + 1,
        },
    };
};
