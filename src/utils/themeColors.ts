/**
 * Reading a theme color from JavaScript.
 *
 * The chart libraries and raw canvases in this app cannot take a Tailwind
 * class — they want a plain color string. That used to mean either hardcoding
 * a hex or reaching into a component, and both were wrong for the same reason:
 * the hexes drifted out of the theme the moment anyone re-stepped a ramp.
 *
 * `chartColor` is the one reader. It resolves a `--color-*` custom property off
 * `:root` at CALL time, which matters: the style tag is injected by JS in dev,
 * so a module-scope read would capture the empty string and fall back forever.
 *
 * It lives here rather than in `components/trade/TradingChart.tsx` (where it
 * was born) because the dashboards need it too, and importing it from there
 * would pull the ~200 kB chart chunk into every dashboard bundle to get a
 * four-line function. `TradingChart` re-exports it, so existing callers and
 * `TradeView` are unaffected.
 *
 * The `fallback` is not a guess: it is the token's own palette value, used
 * when no CSS is loaded — unit tests and jsdom import no stylesheet, and the
 * first paint can beat the style chunk. A chart must never render "undefined".
 *
 * THE RETURN IS ALWAYS A CANVAS-SAFE COLOR. Tailwind v4's default theme defines
 * its ramps in `oklch()`, and `src/index.css` only re-steps some of them to hex.
 * A token that is not overridden resolves to `oklch(85.5% 0.138 181.071)`, which
 * `lightweight-charts`' ColorParser cannot read: it THROWS inside
 * `PriceAxisWidget._optimalWidth` and `ChartWidget._drawImpl`, so the chart's own
 * draw never completes and every study added after the offending one is
 * invisible. Assigning the value to `ctx.fillStyle` does not help — Chromium
 * preserves the color space and hands back `oklch(0.855 0.138 181.071)`. Painting
 * it and reading the pixel back is what actually converts to sRGB.
 */

/** One 1×1 canvas for the whole app: the conversion is a pixel readback, and
 *  allocating a canvas per color on a chart that resolves dozens per rebuild is
 *  the kind of hot-path waste this module exists to avoid. */
let swatch: CanvasRenderingContext2D | null | undefined;

const swatchContext = (): CanvasRenderingContext2D | null => {
    if (swatch !== undefined) return swatch;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        swatch = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
        swatch = null;
    }
    return swatch;
};

/** Hex, rgb()/rgba() and hsl()/hsla() are the notations every canvas and chart
 *  library in this app already parses, so they skip the readback. */
const isPlainColor = (v: string): boolean =>
    v.startsWith('#') || /^(rgba?|hsla?)\(/i.test(v);

/** Convert any CSS color the browser understands into `rgba(r, g, b, a)`.
 *  Returns null when the browser cannot paint it (jsdom has no 2D context). */
const toRgba = (value: string): string | null => {
    const ctx = swatchContext();
    if (!ctx) return null;
    try {
        // Reset first: an unparseable assignment leaves the PREVIOUS fillStyle
        // in place, which would silently return the last color asked for.
        ctx.fillStyle = '#000000';
        ctx.fillStyle = value;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    } catch {
        return null;
    }
};

/** Resolve a `--color-*` token to a literal color string, with a safe fallback. */
export const chartColor = (token: string, fallback: string): string => {
    let resolved = fallback;
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
        if (v.length > 0) resolved = v;
    } catch { /* no document (SSR / node): the fallback is the answer */ }
    if (isPlainColor(resolved)) return resolved;
    // oklch/oklab/lab/lch/color() and named colors all land here. The fallback
    // is already plain, so a browser that cannot convert still gets a color the
    // chart can parse rather than a string that throws inside its draw loop.
    return toRgba(resolved) ?? (isPlainColor(fallback) ? fallback : toRgba(fallback) ?? '#888888');
};