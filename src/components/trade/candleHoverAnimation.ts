/**
 * candleHoverAnimation — pure geometry, color-luminance, and animation-step
 * math for the TradingChart candle hover focus effect.
 *
 * Separated from `TradingChart.tsx` (following `drawingGeometry.ts`) so the
 * animation state machine, scale geometry, and semantic brightness lift are
 * deterministic and unit-tested without a canvas or browser.
 */

/** Enter/leave durations (ms): snappy response on focus, gentle settle when sweeping. */
export const HOVER_ENTER_MS = 140;
export const HOVER_LEAVE_MS = 200;
/** Max per-frame delta clamp so a backgrounded tab never leaps violently. */
const MAX_DT_MS = 64;

export interface RgbColor {
    r: number;
    g: number;
    b: number;
}

export interface HoveredCandleInput {
    centerX: number;
    openY: number;
    closeY: number;
    highY: number;
    lowY: number;
    barSpacing: number;
    baseColor: string;
    /** Raw linear progress in [0, 1]. */
    progress: number;
}

export interface HoveredCandleGeometry {
    /** Eased progress in [0, 1]. */
    eased: number;
    /** Horizontal scale factor applied to the candle body width (>= 1). */
    scaleX: number;
    /** Scaled candle body bounding box in CSS pixels. */
    bodyX: number;
    bodyY: number;
    bodyWidth: number;
    bodyHeight: number;
    /** Corner radius for the subtle elevated body polish. */
    bodyRadius: number;
    /** Scaled wick geometry in CSS pixels. */
    wickX: number;
    wickTopY: number;
    wickBottomY: number;
    wickWidth: number;
    /** Brightened semantic fill & wick color. */
    fillColor: string;
    /** Crisp subtle luminous rim highlight around the scaled body. */
    rimColor: string;
    /** Soft semantic glow color and blur radius behind the focused candle. */
    glowColor: string;
    glowBlur: number;
    /** Opacity for the hover overlay pass (smoothly enters from 0 to 1). */
    alpha: number;
}

/** Smooth cubic ease-out: fast initial lift with a crisp settle. */
export const easeOutCubic = (t: number): number => {
    const c = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - c, 3);
};

/**
 * Matches `lightweight-charts`' `optimalCandlestickWidth` in CSS pixel space
 * (`pixelRatio = 1`) so at progress = 0 the hovered candle starts at the exact
 * resting width of the underlying bar.
 */
export const optimalCandleWidth = (barSpacing: number): number => {
    if (!Number.isFinite(barSpacing) || barSpacing <= 0) return 1;
    const specialFrom = 2.5;
    const specialTo = 4;
    if (barSpacing >= specialFrom && barSpacing <= specialTo) {
        return 3;
    }
    const reducingCoeff = 0.2;
    const coeff = 1 - (reducingCoeff * Math.atan(Math.max(specialTo, barSpacing) - specialTo)) / (Math.PI * 0.5);
    const res = Math.floor(barSpacing * coeff);
    const scaledSpacing = Math.floor(barSpacing);
    return Math.max(1, Math.min(res, scaledSpacing));
};

/** Parse `#rgb`, `#rrggbb`, `rgb(...)`, or `rgba(...)` into 0..255 channels. */
export const parseRgbColor = (color: string): RgbColor | null => {
    const trimmed = color.trim();
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16),
            };
        }
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }
    const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(trimmed);
    if (rgbMatch) {
        const r = Math.round(Math.max(0, Math.min(255, Number(rgbMatch[1]))));
        const g = Math.round(Math.max(0, Math.min(255, Number(rgbMatch[2]))));
        const b = Math.round(Math.max(0, Math.min(255, Number(rgbMatch[3]))));
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
            return { r, g, b };
        }
    }
    return null;
};

/**
 * Increase a candle's brightness while keeping its semantic hue vivid: boosts
 * luminance cleanly and lifts the dominant channel slightly more strongly so
 * bullish emerald and bearish rose stay crisp instead of washing out to pastel.
 */
export const brightenCandleColor = (baseColor: string, amount: number): string => {
    const rgb = parseRgbColor(baseColor);
    if (!rgb) return baseColor;
    const t = Math.max(0, Math.min(1, amount));
    if (t === 0) return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    if (t === 1) return 'rgb(255, 255, 255)';
    const maxCh = Math.max(rgb.r, rgb.g, rgb.b);
    const lift = (ch: number): number => {
        const weight = maxCh > 0 && ch === maxCh ? Math.min(1, t * 1.35) : t * 0.85;
        return Math.round(ch + (255 - ch) * weight);
    };
    return `rgb(${lift(rgb.r)}, ${lift(rgb.g)}, ${lift(rgb.b)})`;
};

/** Soft semantic glow color derived from the active candle token. */
export const candleGlowColor = (baseColor: string, alpha: number): string => {
    const rgb = parseRgbColor(baseColor);
    const a = Math.max(0, Math.min(1, alpha));
    if (!rgb) return `rgba(255, 255, 255, ${a.toFixed(3)})`;
    // Lift the glow hue slightly so it reads clean and luminous on dark graphite.
    const r = Math.round(rgb.r + (255 - rgb.r) * 0.18);
    const g = Math.round(rgb.g + (255 - rgb.g) * 0.18);
    const b = Math.round(rgb.b + (255 - rgb.b) * 0.18);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
};

/** Binary search for a bar timestamp in ascending-sorted candle rows. */
export const findCandleIndexByTime = (bars: readonly { time: number }[], time: number): number => {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const t = bars[mid].time;
        if (t === time) return mid;
        if (t < time) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
};

/**
 * Advance the per-candle hover animation map by `dtMs` milliseconds.
 *
 * - `targetTime` ramps toward `1` over `HOVER_ENTER_MS`.
 * - Every other entry ramps down toward `0` over `HOVER_LEAVE_MS` and is pruned
 *   once settled, allowing multiple candles to cross-fade fluidly when sweeping.
 * - Returns `true` while any entry still needs another animation frame, `false`
 *   once every active candle has settled (allowing the rAF loop to stop idle).
 */
export const stepCandleHoverMap = (
    states: Map<number, number>,
    targetTime: number | null,
    dtMs: number,
    reducedMotion = false,
): boolean => {
    if (reducedMotion) {
        states.clear();
        if (targetTime !== null) states.set(targetTime, 1);
        return false;
    }

    const clampedDt = Math.max(0, Math.min(MAX_DT_MS, Number.isFinite(dtMs) ? dtMs : 0));
    const enterStep = clampedDt / HOVER_ENTER_MS;
    const leaveStep = clampedDt / HOVER_LEAVE_MS;

    if (targetTime !== null && !states.has(targetTime)) {
        states.set(targetTime, 0);
    }

    let stillAnimating = false;
    for (const [time, value] of [...states.entries()]) {
        if (time === targetTime) {
            const next = Math.min(1, value + enterStep);
            states.set(time, next);
            if (next < 1) stillAnimating = true;
        } else {
            const next = Math.max(0, value - leaveStep);
            if (next <= 0.001) {
                states.delete(time);
            } else {
                states.set(time, next);
                stillAnimating = true;
            }
        }
    }

    return stillAnimating;
};

/**
 * Compute the scaled + brightened geometry of a hovered candlestick in CSS
 * pixels for a given animation progress `0..1`.
 */
export const computeHoveredCandleStyle = (input: HoveredCandleInput): HoveredCandleGeometry => {
    const eased = easeOutCubic(input.progress);
    const baseW = optimalCandleWidth(input.barSpacing);

    // Subtle, immediate scale expansion: ~26% wider body (at least +2px when
    // densely zoomed out so focus is unmistakably clear), capped gently so wide
    // candles don't collide clumsily with neighbors.
    const desiredExtraW = Math.max(2, baseW * 0.26);
    const maxExtraW = Math.max(2.5, Math.min(baseW * 0.34, 6.5));
    const extraW = Math.min(desiredExtraW, maxExtraW) * eased;
    const bodyWidth = baseW + extraW;
    const scaleX = baseW > 0 ? bodyWidth / baseW : 1;

    const topBodyY = Math.min(input.openY, input.closeY);
    const bottomBodyY = Math.max(input.openY, input.closeY);
    const rawBodyH = Math.max(1, bottomBodyY - topBodyY);

    // Slight vertical body swell around its center (keeps price read accurate
    // while giving dojis and thin bars tactile visual weight on hover).
    const extraH = Math.min(2.4, Math.max(1.2, rawBodyH * 0.055)) * eased;
    const bodyHeight = rawBodyH + extraH;
    const bodyY = topBodyY - extraH * 0.5;
    const bodyX = input.centerX - bodyWidth * 0.5;

    const wickTopY = Math.min(input.highY, input.lowY);
    const wickBottomY = Math.max(input.highY, input.lowY);
    const wickWidth = 1 + 0.6 * eased;

    const fillColor = brightenCandleColor(input.baseColor, 0.28 * eased);
    const rimColor = `rgba(255, 255, 255, ${(0.28 * eased).toFixed(3)})`;
    const glowColor = candleGlowColor(input.baseColor, 0.36 * eased);
    const glowBlur = 7.5 * eased;

    return {
        eased,
        scaleX,
        bodyX,
        bodyY,
        bodyWidth,
        bodyHeight,
        bodyRadius: bodyWidth >= 6 ? 1.25 * eased : 0.5 * eased,
        wickX: input.centerX,
        wickTopY,
        wickBottomY,
        wickWidth,
        fillColor,
        rimColor,
        glowColor,
        glowBlur,
        // Fast initial opacity ramp so the brighter/scaled bar takes over smoothly
        // without ghosting, then fades cleanly back to the base chart bar on leave.
        alpha: Math.min(1, eased * 1.15),
    };
};
