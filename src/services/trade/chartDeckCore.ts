/**
 * chartDeckCore — pure, DOM-free core for the Desk chart drawing rail,
 * grouped flyout definitions, magnet resolution, favorites persistence helpers,
 * measure/ruler delta math, and editable-target hotkey guards.
 *
 * Zero React, DOM, `window`, `localStorage`, or network imports (`check:boundaries`).
 */

import type { DrawTool } from './chartDrawings';

export type ChartRailCategory =
    | 'cursor'
    | 'lines'
    | 'fib'
    | 'zones'
    | 'position'
    | 'annotations';

export type MagnetMode = 'off' | 'weak' | 'strong';

export type DrawingVisibilityScope = 'all' | 'hide_all' | 'hide_ai' | 'hide_user';

export interface ChartRailToolDef {
    tool: DrawTool;
    category: ChartRailCategory;
    label: string;
    title: string;
    hotkey?: string;
    testId: string;
    semantic?: 'long' | 'short';
    /** Whether this tool can be starred to the draggable Favorites micro-bar. */
    starrable: boolean;
}

export interface ChartRailGroupDef {
    category: ChartRailCategory;
    label: string;
    defaultTool: DrawTool;
    tools: readonly ChartRailToolDef[];
}

export const MAGNET_THRESHOLDS_PX: Readonly<Record<MagnetMode, number>> = {
    off: 0,
    weak: 12,
    strong: 36,
};

/**
 * Resolve effective magnet mode when holding `Ctrl` during drag/placement:
 *  - Base `off` + `Ctrl` → temporarily engages `weak` (12px OHLC snap).
 *  - Base `weak` or `strong` + `Ctrl` → temporarily releases to `off`.
 */
export const resolveEffectiveMagnetMode = (baseMode: MagnetMode, ctrlPressed: boolean): MagnetMode => {
    if (!ctrlPressed) return baseMode;
    return baseMode === 'off' ? 'weak' : 'off';
};

export const resolveMagnetThresholdPx = (effectiveMode: MagnetMode): number =>
    MAGNET_THRESHOLDS_PX[effectiveMode] ?? 0;

/**
 * Six grouped categories in Block 1 of the left 38px Desk chart rail.
 * Note: `brush` is the default tool of `annotations` with exact title
 * `"Freehand — drag to draw"` so both one-click freehand and render-probe
 * remain immediately reachable without opening a flyout.
 */
export const CHART_RAIL_GROUPS: readonly ChartRailGroupDef[] = [
    {
        category: 'cursor',
        label: 'Pointer',
        defaultTool: 'cursor',
        tools: [
            {
                tool: 'cursor',
                category: 'cursor',
                label: 'Cursor / Crosshair',
                title: 'Cursor — select, drag, pan & zoom (Esc)',
                hotkey: 'Esc',
                testId: 'rail-tool-cursor',
                starrable: false,
            },
        ],
    },
    {
        category: 'lines',
        label: 'Lines',
        defaultTool: 'trend',
        tools: [
            {
                tool: 'trend',
                category: 'lines',
                label: 'Trendline',
                title: 'Trendline — drag between two anchors (Alt+T)',
                hotkey: 'Alt+T',
                testId: 'rail-tool-trend',
                starrable: true,
            },
            {
                tool: 'hline',
                category: 'lines',
                label: 'Horizontal Line',
                title: 'Horizontal line — click to place (Alt+H)',
                hotkey: 'Alt+H',
                testId: 'rail-tool-hline',
                starrable: true,
            },
            {
                tool: 'hray',
                category: 'lines',
                label: 'Horizontal Ray',
                title: 'Horizontal ray — extends right from click (Alt+J)',
                hotkey: 'Alt+J',
                testId: 'rail-tool-hray',
                starrable: true,
            },
            {
                tool: 'vline',
                category: 'lines',
                label: 'Vertical Line',
                title: 'Vertical line — mark event / session time (Alt+V)',
                hotkey: 'Alt+V',
                testId: 'rail-tool-vline',
                starrable: true,
            },
            {
                tool: 'channel',
                category: 'lines',
                label: 'Parallel Channel',
                title: 'Parallel channel — drag range',
                testId: 'rail-tool-channel',
                starrable: true,
            },
        ],
    },
    {
        category: 'fib',
        label: 'Fib & Rays',
        defaultTool: 'fib',
        tools: [
            {
                tool: 'fib',
                category: 'fib',
                label: 'Fib Retracement',
                title: 'Fibonacci retracement — drag swing (Alt+F)',
                hotkey: 'Alt+F',
                testId: 'rail-tool-fib',
                starrable: true,
            },
            {
                tool: 'ray',
                category: 'fib',
                label: 'Trend Ray',
                title: 'Ray — anchor and extend forward',
                testId: 'rail-tool-ray',
                starrable: true,
            },
        ],
    },
    {
        category: 'zones',
        label: 'Zones & Shapes',
        defaultTool: 'rect',
        tools: [
            {
                tool: 'rect',
                category: 'zones',
                label: 'Rectangle Zone',
                title: 'Rectangle zone — drag supply/demand box (Shift+Alt+R)',
                hotkey: 'Shift+Alt+R',
                testId: 'rail-tool-rect',
                starrable: true,
            },
            {
                tool: 'price_range',
                category: 'zones',
                label: 'Price Range',
                title: 'Price range — measure & keep a price delta box',
                testId: 'rail-tool-price-range',
                starrable: true,
            },
        ],
    },
    {
        category: 'position',
        label: 'Position & Risk',
        defaultTool: 'long_position',
        tools: [
            {
                tool: 'long_position',
                category: 'position',
                label: 'Long Position',
                title: 'Long Position — R:R profit/risk box',
                testId: 'rail-tool-long-position',
                semantic: 'long',
                starrable: true,
            },
            {
                tool: 'short_position',
                category: 'position',
                label: 'Short Position',
                title: 'Short Position — R:R profit/risk box',
                testId: 'rail-tool-short-position',
                semantic: 'short',
                starrable: true,
            },
        ],
    },
    {
        category: 'annotations',
        label: 'Annotations',
        defaultTool: 'brush',
        tools: [
            {
                tool: 'brush',
                category: 'annotations',
                label: 'Freehand Brush',
                title: 'Freehand — drag to draw',
                testId: 'rail-tool-brush',
                starrable: true,
            },
            {
                tool: 'text',
                category: 'annotations',
                label: 'Callout / Text',
                title: 'Callout label — click to annotate (Alt+A)',
                hotkey: 'Alt+A',
                testId: 'rail-tool-text',
                starrable: true,
            },
            {
                tool: 'arrow',
                category: 'annotations',
                label: 'Arrow',
                title: 'Arrow — point to structure or catalyst',
                testId: 'rail-tool-arrow',
                starrable: true,
            },
            {
                tool: 'erase',
                category: 'annotations',
                label: 'Eraser',
                title: 'Eraser — click a shape to remove it',
                testId: 'rail-tool-erase',
                starrable: false,
            },
        ],
    },
];

export const ALL_RAIL_TOOLS: readonly ChartRailToolDef[] = CHART_RAIL_GROUPS.flatMap(g => g.tools);

export const findRailToolDef = (tool: DrawTool): ChartRailToolDef | undefined =>
    ALL_RAIL_TOOLS.find(t => t.tool === tool);

export const findCategoryForTool = (tool: DrawTool): ChartRailCategory | null =>
    findRailToolDef(tool)?.category ?? null;

const STARRABLE_SET: ReadonlySet<DrawTool> = new Set(
    ALL_RAIL_TOOLS.filter(t => t.starrable).map(t => t.tool),
);

export const MAX_FAVORITE_TOOLS = 10;

export const normalizeFavoriteTools = (raw: unknown): DrawTool[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<DrawTool>();
    const out: DrawTool[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const t = item as DrawTool;
        if (!STARRABLE_SET.has(t) || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= MAX_FAVORITE_TOOLS) break;
    }
    return out;
};

export const toggleFavoriteTool = (
    current: ReadonlyArray<DrawTool>,
    tool: DrawTool,
): DrawTool[] => {
    if (!STARRABLE_SET.has(tool)) return normalizeFavoriteTools(current);
    const cleaned = normalizeFavoriteTools(current);
    if (cleaned.includes(tool)) {
        return cleaned.filter(t => t !== tool);
    }
    return [...cleaned, tool].slice(0, MAX_FAVORITE_TOOLS);
};

export interface MeasureMetricsInput {
    startPrice: number;
    endPrice: number;
    startTimeSec: number;
    endTimeSec: number;
    barSeconds: number;
}

export interface MeasureMetrics {
    priceDelta: number;
    priceDeltaPct: number;
    absBars: number;
    durationSec: number;
    durationLabel: string;
    direction: 'up' | 'down' | 'flat';
    formattedPriceDelta: string;
    formattedPct: string;
    formattedSummary: string;
}

const fmtDuration = (sec: number): string => {
    const abs = Math.max(0, Math.round(sec));
    if (abs < 60) return `${abs}s`;
    const mins = Math.round(abs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
};

const fmtSignedPrice = (delta: number, refPrice: number): string => {
    const abs = Math.abs(delta);
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
    const ref = Math.abs(refPrice);
    const decimals = ref >= 1000 ? 1 : ref >= 1 ? 2 : ref >= 0.01 ? 4 : 6;
    const formatted = abs.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
    return `${sign}$${formatted}`;
};

/**
 * Pure computation for the ephemeral Shift+Drag / Ruler measurement tool.
 * Returns null if either price is non-finite or startPrice <= 0.
 */
export const computeMeasureMetrics = (input: MeasureMetricsInput): MeasureMetrics | null => {
    const { startPrice, endPrice, startTimeSec, endTimeSec, barSeconds } = input;
    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0) return null;
    if (!Number.isFinite(startTimeSec) || !Number.isFinite(endTimeSec)) return null;
    const step = Number.isFinite(barSeconds) && barSeconds > 0 ? barSeconds : 60;

    const priceDelta = endPrice - startPrice;
    const priceDeltaPct = (priceDelta / startPrice) * 100;
    const durationSec = Math.abs(endTimeSec - startTimeSec);
    const absBars = Math.round(durationSec / step);
    const durationLabel = fmtDuration(durationSec);
    const direction: 'up' | 'down' | 'flat' =
        priceDelta > 1e-12 ? 'up' : priceDelta < -1e-12 ? 'down' : 'flat';

    const pctSign = priceDeltaPct > 0 ? '+' : '';
    const formattedPct = `${pctSign}${priceDeltaPct.toFixed(2)}%`;
    const formattedPriceDelta = fmtSignedPrice(priceDelta, startPrice);
    const barsText = `${absBars} bar${absBars === 1 ? '' : 's'}`;
    const formattedSummary = `${formattedPct} (${formattedPriceDelta}) · ${barsText} · ${durationLabel}`;

    return {
        priceDelta,
        priceDeltaPct,
        absBars,
        durationSec,
        durationLabel,
        direction,
        formattedPriceDelta,
        formattedPct,
        formattedSummary,
    };
};

/**
 * Guard for chart hotkeys: returns true when keyboard focus is inside an
 * input, textarea, select, or contentEditable surface so shortcuts never
 * hijack typing in ChatComposer or Settings inputs.
 */
export const isEditableKeyboardTarget = (
    tagName?: string | null,
    isContentEditable?: boolean,
): boolean => {
    if (isContentEditable) return true;
    if (!tagName) return false;
    const upper = tagName.toUpperCase();
    return upper === 'INPUT' || upper === 'TEXTAREA' || upper === 'SELECT';
};

export interface FilterInteractiveDrawingsInput<
    T extends { id: string; hidden?: boolean; origin?: 'user' | 'agent' },
> {
    userDrawings: ReadonlyArray<T>;
    modelDrawings: ReadonlyArray<T>;
    visibilityScope: DrawingVisibilityScope;
}

/**
 * Pure filter returning only drawings currently visible & eligible for
 * hit-testing, selection, dragging, or erasing:
 *  - `hide_all` returns `[]`
 *  - individual `d.hidden === true` drawings are excluded
 *  - `hide_ai` excludes drawings whose resolved origin is `'agent'`
 *  - `hide_user` excludes drawings whose resolved origin is `'user'`
 */
export const filterInteractiveDrawings = <
    T extends { id: string; hidden?: boolean; origin?: 'user' | 'agent' },
>(
    input: FilterInteractiveDrawingsInput<T>,
): T[] => {
    const { userDrawings, modelDrawings, visibilityScope } = input;
    if (visibilityScope === 'hide_all') return [];
    const out: T[] = [];
    const append = (list: ReadonlyArray<T>, defaultOrigin: 'user' | 'agent'): void => {
        for (const drawing of list) {
            if (drawing.hidden === true) continue;
            const resolvedOrigin: 'user' | 'agent' = drawing.origin === 'agent'
                ? 'agent'
                : drawing.origin === 'user'
                    ? 'user'
                    : defaultOrigin;
            if (visibilityScope === 'hide_ai' && resolvedOrigin === 'agent') continue;
            if (visibilityScope === 'hide_user' && resolvedOrigin === 'user') continue;
            out.push(drawing);
        }
    };
    append(userDrawings, 'user');
    append(modelDrawings, 'agent');
    return out;
};
