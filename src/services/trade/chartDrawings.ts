/**
 * chartDrawings — persistence + model-facing description for the user's
 * TradingView-style drawings on the trade chart (trendlines, horizontal
 * lines, rays, rectangles, brush paths). Shapes are anchored in DATA space
 * (unix-second time + price), never screen pixels, so a drawing survives
 * reloads, interval changes, zoom and pan. Session-scoped storage is per
 * active user, per session, per symbol (a BTC trendline must not appear on
 * ETH, nor in another session) through storeBackend — a JSON file per
 * session on desktop, localStorage on web — with hard caps so the blob
 * can't grow forever. Pure module — no canvas, no React — so the
 * validation and the "what the model reads" formatter are unit-testable.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { phtStamp } from '../../utils/timezone';
import { fmtRiskReward, plannedRiskReward } from '../../utils/riskReward';
import { priceArgError, usablePrice } from './tradePlanLevels';
import { readStore, writeStore, removeStore } from '../infrastructure/storeBackend';
import type { PatternAnchor } from '../../utils/patternDetection';
import { snapPriceToStructure } from '../../utils/patternDetection';

/**
 * DrawKind — what a shape can be.
 *
 * The first seven (trend/hline/ray/rect/brush/fib/text) are the user's tool
 * rail. `channel`, `arrow` and `measured_move` are the shapes a seat actually
 * asks for when it is annotating a setup: a band to say "this is the range",
 * an arrow to point at a level, and a measured move to state the risk and the
 * reward on the chart rather than only in prose.
 */
export type DrawKind =
    | 'trend' | 'hline' | 'ray' | 'rect' | 'brush' | 'fib' | 'text'
    | 'channel' | 'arrow' | 'measured_move';

/** One anchor point in data space: t = unix seconds, p = price. */
export interface DrawPoint { t: number; p: number }

export interface ChartDrawing {
    id: string;
    kind: DrawKind;
    points: DrawPoint[];
    /** CSS color the shape was drawn with. */
    color: string;
    /** Milliseconds when the user finished the shape (order for the model). */
    createdAt: number;
    /** Optional user label shown on the shape's first anchor. */
    label?: string;
    /**
     * Futures mark price at the moment the shape was drawn (model drawings,
     * and any canvas shape saved while the live feed was up). This is what
     * lets the model judge STALENESS — how far price has travelled since the
     * anchor — not just when it was made. Null for legacy/user shapes that
     * predate the stamp or were drawn with no live mark available.
     */
    drawnPrice?: number | null;
    /** Stroke weight in CSS px. Optional so every shape saved before the rail
     *  grew a width control still parses; `drawWidthOf` supplies the default. */
    width?: number;
}

export const MAX_DRAWINGS_PER_SYMBOL = 40;
export const MAX_POINTS_PER_DRAWING = 200;

const KINDS: readonly string[] = ['trend', 'hline', 'ray', 'rect', 'brush', 'fib', 'text', 'channel', 'arrow', 'measured_move'];

/** Fibonacci retracement ratios drawn between a fib's two anchors. */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** TradingView-style palette for the user's drawing tools (theme-aligned:
 *  emerald/rose/amber/sky/violet). Lives here (not in the chart component)
 *  so the tool rail and the chart share it without a cyclic import.
 *
 *  These are LITERALS rather than `chartColor()` calls on purpose — this module
 *  is read outside the DOM by the tool rail — but they are the theme's steps by
 *  value, so the 2026-10-27 neutral re-style moved them with the ramps. The
 *  first two MUST keep matching the candles: a drawn trend line in the OLD
 *  up-green next to a live candle in the NEW one reads as two different
 *  meanings for the same colour, which is the one rule the semantic tokens
 *  exist to hold. */
export const DRAW_COLORS = ['#e8a33d', '#22d3ee', '#10b981', '#f43f5e', '#e879f9', '#f4f1ea'] as const;

/** The stroke weights the rail's width control cycles through. A short ladder
 *  rather than a free number, for the same reason the colour palette is a
 *  fixed set: a drawing the trader cannot reproduce from the menu is a
 *  drawing they cannot read later. `DRAW_WIDTHS[0]` is the hairline a fib's
 *  interior levels keep, so the default sits one rung up. */
export const DRAW_WIDTHS = [1, 2, 3, 4] as const;
export const DRAW_WIDTH_DEFAULT = 2;

export const nextDrawWidth = (current: number): number => {
    const i = DRAW_WIDTHS.indexOf(current as (typeof DRAW_WIDTHS)[number]);
    return DRAW_WIDTHS[(i < 0 ? 1 : i + 1) % DRAW_WIDTHS.length];
};

/** A shape's stroke weight, with the default a pre-width drawing reads at. */
export const drawWidthOf = (d: ChartDrawing): number => d.width ?? DRAW_WIDTH_DEFAULT;

/** What the tool rail's pointer flow puts on the overlay: 'cursor' is the
 *  chart's native pan/zoom, 'erase' deletes a user shape, the rest are the
 *  DrawKinds themselves. */
export type DrawTool = 'cursor' | DrawKind | 'erase';

const storageKey = (username: string, symbol: string): string =>
    `trade_drawings_v1_${username}_${symbol.toUpperCase()}`;

const sessionStorageKey = (username: string, sessionId: string): string =>
    `trade_session_drawings_v1_${username}_${sessionId}`;

const sessionModelStorageKey = (username: string, sessionId: string): string =>
    `trade_session_model_v1_${username}_${sessionId}`;

const finiteNum = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};

const validPoint = (p: unknown): p is DrawPoint => {
    const v = p as DrawPoint;
    return !!v && typeof v === 'object' && finiteNum(v.t) !== null && finiteNum(v.p) !== null;
};

const validDrawing = (d: unknown): d is ChartDrawing => {
    const v = d as ChartDrawing;
    if (!v || typeof v !== 'object') return false;
    if (typeof v.id !== 'string' || !KINDS.includes(v.kind)) return false;
    if (!Array.isArray(v.points) || v.points.length === 0) return false;
    if (typeof v.color !== 'string') return false;
    return true;
};

/** Read + validate + bound the stored shapes for one symbol; garbage → []. */
export const loadDrawings = (symbol: string, username = getActiveUsername()): ChartDrawing[] => {
    try {
        const raw = localStorage.getItem(storageKey(username, symbol));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(validDrawing).map(d => ({
            ...d,
            drawnPrice: finiteNum(d.drawnPrice) ?? undefined,
            points: d.points.filter(validPoint).slice(0, MAX_POINTS_PER_DRAWING),
        })).filter(d => d.points.length > 0).slice(-MAX_DRAWINGS_PER_SYMBOL);
    } catch {
        return [];
    }
};

/** Shared validation/bounding for a parsed drawing array (garbage → []). */
const sanitizeDrawings = (parsed: unknown): ChartDrawing[] => {
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(validDrawing).map(d => ({
        ...d,
        drawnPrice: finiteNum(d.drawnPrice) ?? undefined,
        points: d.points.filter(validPoint).slice(0, MAX_POINTS_PER_DRAWING),
    })).filter(d => d.points.length > 0).slice(-MAX_DRAWINGS_PER_SYMBOL);
};

/**
 * SESSION+COIN-scoped drawings — each Chart AI session owns a MAP of
 * symbol → shapes under one store key (`trade_session_drawings_v1_<user>_<sid>`
 * for the user's shapes, `trade_session_model_v1_<user>_<sid>` for the
 * model's). The bytes go through `storeBackend`, so on DESKTOP each key is a
 * plain JSON file under the store directory (written atomically by the main
 * process, outside the shared ~5 MiB origin budget that session 5 moved every
 * other store off), and on WEB it falls back to localStorage. Switching coins
 * inside a session blanks the canvas; coming BACK to a previous coin restores
 * that coin's shapes; a fresh session starts EMPTY.
 *
 * The write path is DEBOUNCED (DRAWINGS_FLUSH_MS) because a file write per
 * pointer commit is real I/O, and it is read-through-MIRROR: the mirror is
 * the authority from the moment a load resolves or a write happens, so a
 * slow disk read can never clobber shapes the trader just drew, and a rapid
 * coin/session switch always reads a consistent map.
 */
const DRAWINGS_FLUSH_MS = 400;
const coinMapMirror = new Map<string, Record<string, ChartDrawing[]>>();
const pendingFlushes = new Map<string, ReturnType<typeof setTimeout>>();
/** Stores explicitly deleted this boot. An in-flight flush captured before the
 *  delete must not write its stale bytes back over the removal — the delete's
 *  mirror entry is gone, but the flush already HOLDS the old map. */
const deletedStores = new Set<string>();

/** Keys whose mirror came from a completed store read. A key that was never
 *  read can still be WRITTEN (a model shape arriving for a bucket the chart
 *  has not opened) — its flush must merge with the disk's current content,
 *  the same read-merge-write the synchronous writer used to do, or the file's
 *  other coins are lost to a map the session never saw. */
const mirrorLoaded = new Set<string>();

/** Resolves TRUE only when the bytes are on disk. The legacy migration
 *  deletes the old key on this answer, so a `Promise.resolve()` for "nothing
 *  to write" or an ignored `{ ok: false }` is a data-loss path: the caller
 *  would clear the old home without a verified new one. */
const flushCoinMap = (storeKey: string): Promise<boolean> => {
    const timer = pendingFlushes.get(storeKey);
    if (timer !== undefined) { clearTimeout(timer); pendingFlushes.delete(storeKey); }
    if (deletedStores.has(storeKey)) return Promise.resolve(false);
    const mirror = coinMapMirror.get(storeKey);
    if (!mirror) return Promise.resolve(false);
    if (mirrorLoaded.has(storeKey)) {
        return writeStore(storeKey, JSON.stringify(mirror)).then(res => res.ok);
    }
    return readStore(storeKey).then(res => {
        if (deletedStores.has(storeKey)) return false; // deleted mid-read
        const merged = { ...parseCoinMap(res.ok ? res.value : null), ...mirror };
        mirrorLoaded.add(storeKey);
        coinMapMirror.set(storeKey, merged);
        return writeStore(storeKey, JSON.stringify(merged)).then(r => r.ok);
    });
};

/** Push every pending drawing write to the store NOW — on session switches
 *  and app close (a debounced write that never fires is a lost drawing). */
export const flushDrawings = (): Promise<unknown> =>
    Promise.all([...pendingFlushes.keys()].map(flushCoinMap));

if (typeof window !== 'undefined') {
    const flush = (): void => { void flushDrawings(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

const parseCoinMap = (raw: string | null): Record<string, ChartDrawing[]> => {
    if (raw === null) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const obj = parsed as Record<string, unknown>;
        const store: Record<string, ChartDrawing[]> = {};
        if (typeof obj.symbol === 'string' && Array.isArray(obj.drawings)) {
            // Earlier single-symbol shape → migrate that one coin.
            store[(obj.symbol as string).toUpperCase()] = sanitizeDrawings(obj.drawings);
        } else {
            for (const [coin, list] of Object.entries(obj)) {
                if (Array.isArray(list)) store[coin] = sanitizeDrawings(list);
            }
        }
        return store;
    } catch {
        return {}; // corrupt store — start clean rather than guess
    }
};

/** The session's coin map. First touch reads the store (async — the file on
 *  desktop, localStorage on web, with the store's own one-time migration of
 *  pre-file localStorage bytes); every later read — and every read that
 *  overlaps a write — is served from the mirror. */
const loadCoinMap = async (storeKey: string): Promise<Record<string, ChartDrawing[]>> => {
    if (coinMapMirror.has(storeKey)) return coinMapMirror.get(storeKey)!;
    const res = await readStore(storeKey);
    // A write that happened while the read was in flight wins.
    if (coinMapMirror.has(storeKey)) return coinMapMirror.get(storeKey)!;
    if (!res.ok) {
        // A TRANSIENT read failure must not seed an empty authoritative
        // mirror: that would freeze the bucket as empty for the boot and let
        // the next flush overwrite the file. Leave unloaded — a later load
        // retries, and flushCoinMap's read-merge-write still protects a
        // write that lands before any successful read.
        return {};
    }
    coinMapMirror.set(storeKey, parseCoinMap(res.value));
    mirrorLoaded.add(storeKey);
    return coinMapMirror.get(storeKey)!;
};

const saveCoinMap = (storeKey: string, symbol: string, drawings: ChartDrawing[]): void => {
    const wanted = symbol.toUpperCase();
    const store = coinMapMirror.get(storeKey) ?? {};
    store[wanted] = drawings.slice(-MAX_DRAWINGS_PER_SYMBOL)
        .map(d => ({ ...d, points: d.points.slice(0, MAX_POINTS_PER_DRAWING) }));
    coinMapMirror.set(storeKey, store);
    if (pendingFlushes.has(storeKey)) clearTimeout(pendingFlushes.get(storeKey)!);
    pendingFlushes.set(storeKey, setTimeout(() => { pendingFlushes.delete(storeKey); void flushCoinMap(storeKey); }, DRAWINGS_FLUSH_MS));
};

/** The mirror's answer for one coin, without touching the store — the sync
 *  merge base `drawingsControl` mutates against once the initial async load
 *  has resolved. Empty until then, and a write before the load still lands:
 *  the mirror is authoritative from its first touch. */
export const readSessionDrawingsSync = (bucket: 'user' | 'model', sessionId: string, symbol: string, username = getActiveUsername()): ChartDrawing[] =>
    coinMapMirror.get(bucket === 'user'
        ? sessionStorageKey(username, sessionId)
        : sessionModelStorageKey(username, sessionId))?.[symbol.toUpperCase()] ?? [];

/**
 * SESSION+COIN-scoped USER drawings — each Chart AI session owns a map of
 * symbol → shapes. Switching coins blanks the canvas; coming BACK restores
 * that coin's shapes; a fresh session starts EMPTY.
 */
export const loadSessionDrawings = async (sessionId: string, symbol: string, username = getActiveUsername()): Promise<ChartDrawing[]> =>
    (await loadCoinMap(sessionStorageKey(username, sessionId)))[symbol.toUpperCase()] ?? [];

/**
 * The ONE load a chart uses: the scope's session bucket, plus a ONE-TIME
 * import of the legacy per-symbol bucket (`trade_drawings_v1_<user>_<sym>`)
 * for a coin the session bucket has never seen. Before sessions existed the
 * charts saved there, and no session chart ever read those keys again —
 * orphaned bytes (779cb746's bug was two live buckets; those were a third,
 * unread one). Rules:
 *  · a session bucket that already has shapes for the coin is left alone —
 *    the trader drew there after the legacy window, and overwriting would be
 *    data loss;
 *  · the legacy key is deleted only after the session write reports SUCCESS,
 *    so the bytes are verified in the new home before the old one is cleared.
 *    A failed or skipped write keeps the legacy key — the next load retries.
 */
export const loadSessionDrawingsWithLegacy = async (sessionId: string, symbol: string, username = getActiveUsername()): Promise<ChartDrawing[]> => {
    const wanted = symbol.toUpperCase();
    const sessionKey = sessionStorageKey(username, sessionId);
    const existing = (await loadCoinMap(sessionKey))[wanted];
    if (existing && existing.length > 0) return existing;
    const legacy = loadDrawings(symbol, username);
    if (legacy.length === 0) return existing ?? [];
    saveCoinMap(sessionKey, wanted, legacy);
    void flushCoinMap(sessionKey).then(ok => {
        if (!ok) return;
        try { localStorage.removeItem(storageKey(username, wanted)); } catch { /* nothing left to clean */ }
    });
    return legacy;
};

export const saveSessionDrawings = (sessionId: string, symbol: string, drawings: ChartDrawing[], username = getActiveUsername()): void =>
    saveCoinMap(sessionStorageKey(username, sessionId), symbol, drawings);

/**
 * The MODEL's drawn shapes — the SAME per-session-per-coin machinery, its OWN
 * bucket (`trade_session_model_v1`) so the user's eraser/clear and the model's
 * `clear_chart_drawings(scope:"model")` never clobber each other — and BOTH
 * survive a coin switch instead of the model's lines vanishing.
 */
export const loadSessionModelDrawings = async (sessionId: string, symbol: string, username = getActiveUsername()): Promise<ChartDrawing[]> =>
    (await loadCoinMap(sessionModelStorageKey(username, sessionId)))[symbol.toUpperCase()] ?? [];

export const saveSessionModelDrawings = (sessionId: string, symbol: string, drawings: ChartDrawing[], username = getActiveUsername()): void =>
    saveCoinMap(sessionModelStorageKey(username, sessionId), symbol, drawings);

/** Deleting a session deletes its drawings — BOTH buckets, the pending
 *  debounce, and the mirror, or a deleted session's shapes come back on a
 *  same-id session or linger in the store forever. */
export const deleteSessionDrawings = async (sessionId: string, username = getActiveUsername()): Promise<void> => {
    for (const storeKey of [sessionStorageKey(username, sessionId), sessionModelStorageKey(username, sessionId)]) {
        const timer = pendingFlushes.get(storeKey);
        if (timer !== undefined) { clearTimeout(timer); pendingFlushes.delete(storeKey); }
        deletedStores.add(storeKey); // an in-flight flush must not resurrect this
        coinMapMirror.delete(storeKey);
        mirrorLoaded.delete(storeKey);
        await removeStore(storeKey);
    }
};

/** A restore replaced the files under the mirror. Drop the cache — including
 *  any pending debounce — so the next read comes from the restored store
 *  rather than the shapes that were live before the import. */
export const resetDrawingsCache = (): void => {
    for (const timer of pendingFlushes.values()) clearTimeout(timer);
    pendingFlushes.clear();
    coinMapMirror.clear();
    mirrorLoaded.clear();
    deletedStores.clear();
};

export const createDrawingId = (): string =>
    `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Palette names the model may use in draw_on_chart (mapped to the chart's
 *  TradingView-style DRAW_COLORS). Same values as the tool palette above, so a
 *  line the model draws and a line the trader draws are the same green. */
export const MODEL_COLOR_NAMES = { emerald: '#0bc67a', rose: '#f6465d', amber: '#f08800', sky: '#4d9fff', violet: '#c084fc' } as const;
export type ModelColorName = keyof typeof MODEL_COLOR_NAMES;

/** Default anchors: a line spans the last 40 bars → now. */
const DEFAULT_START_BARS_AGO = 40;

/**
 * Convert a model's draw_on_chart / mark_trade_levels call into data-space
 * drawings. The model expresses anchors as PRICES plus "bars ago" offsets
 * (it cannot know wall-clock bar times); `lastBarTime` (unix seconds of the
 * newest candle) + `barSeconds` re-anchor them onto the real axis. Pure so
 * the conversion is unit-testable.
 */
/** Past this gap the level is far enough from price that the model was not
 *  reading the current market. Generous on purpose - see the draw site.
 */
export const PRICE_ALREADY_PAST_PCT = 2;

export const drawingFromChartTool = (
    args: {
        kind?: unknown;
        prices?: unknown;
        startBarsAgo?: unknown;
        endBarsAgo?: unknown;
        color?: unknown;
        label?: unknown;
    },
    ctx: { lastBarTime: number; barSeconds: number; drawnPrice?: number | null; klines?: readonly { high: number; low: number }[] },
): { drawings: ChartDrawing[]; error?: string; note?: string } => {
    const kindRaw = typeof args.kind === 'string' ? args.kind : '';
    const kindMap: Record<string, DrawKind> = {
        hline: 'hline', horizontal: 'hline', level: 'hline',
        trend: 'trend', trendline: 'trend', line: 'trend', diagonal: 'trend',
        ray: 'ray',
        zone: 'rect', rect: 'rect', rectangle: 'rect', box: 'rect',
        fib: 'fib', retracement: 'fib', 'fib-retracement': 'fib',
        text: 'text', note: 'text', annotation: 'text',
        // A band between two parallel lines, e.g. a support/resistance range.
        channel: 'channel', range: 'channel', band: 'channel', corridor: 'channel',
        // A directed pointer at a level ("the close is here").
        arrow: 'arrow', pointer: 'arrow', marker: 'arrow',
        // The TradingView measured move: entry → stop (risk) and entry → first
        // target (reward), labelled with both distances.
        measured_move: 'measured_move', 'measured-move': 'measured_move',
        measuredmove: 'measured_move', riskreward: 'measured_move',
        'risk-reward': 'measured_move', rr: 'measured_move',
    };
    const kind = kindMap[kindRaw.toLowerCase().replace(/\s+/g, '_')] ?? kindMap[kindRaw];
    if (!kind) {
        return {
            drawings: [],
            error: `unknown kind "${kindRaw}" — use hline, trend, ray, rect/zone, channel, fib, arrow, measured_move or text`,
        };
    }

    // One rule, shared: `Number.isFinite` is not enough, because 0 and -1 are
    // both finite and neither is a price. This used to accept them, producing
    // a line at zero and an unconditional "Drew on the chart" receipt for a
    // shape that cannot exist. See priceArgError in tradePlanLevels.
    const rawPrices = Array.isArray(args.prices) ? args.prices : [];
    // hline/text are a single level; measured_move is entry + stop + target;
    // everything else is two anchors.
    const need = kind === 'hline' || kind === 'text' ? 1
        : kind === 'measured_move' ? 3
            : 2;
    if (rawPrices.length < need) {
        return {
            drawings: [],
            error: kind === 'measured_move'
                ? 'measured_move needs 3 prices in "prices": [entry, stop, firstTarget]'
                : `${kind} needs ${need} price(s) in "prices"`,
        };
    }
    const prices: number[] = [];
    for (let i = 0; i < need; i++) {
        const bad = priceArgError(rawPrices[i], `prices[${i}]`);
        if (bad) return { drawings: [], error: bad };
        prices.push(Number(rawPrices[i]));
    }

    const barAt = (barsAgo: number): number => Math.round(ctx.lastBarTime - barsAgo * ctx.barSeconds);
    const start = Number.isFinite(Number(args.startBarsAgo)) ? Math.max(0, Number(args.startBarsAgo)) : DEFAULT_START_BARS_AGO;
    const end = Number.isFinite(Number(args.endBarsAgo)) ? Math.max(0, Number(args.endBarsAgo)) : 0;
    // A measured move is a vertical stack at one bar, so it has no start/end
    // ordering to violate; every other two-anchor shape needs one.
    const needsOrdering = kind !== 'hline' && kind !== 'text' && kind !== 'measured_move';
    if (needsOrdering && start <= end) {
        return { drawings: [], error: 'startBarsAgo must be greater than endBarsAgo (start is the older anchor)' };
    }

    const colorName = typeof args.color === 'string' && args.color in MODEL_COLOR_NAMES ? args.color as ModelColorName : 'sky';
    const color = MODEL_COLOR_NAMES[colorName];
    const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 40) : undefined;

    const points: DrawPoint[] = kind === 'hline' || kind === 'text'
        ? [{ t: barAt(end), p: prices[0] }]
        : kind === 'measured_move'
            // Entry, stop and first target all read as three points on the
            // same bar: the measured move is a vertical stack at one moment,
            // not a shape spanning time.
            ? [
                { t: barAt(end), p: prices[0] },
                { t: barAt(end), p: prices[1] },
                { t: barAt(end), p: prices[2] },
            ]
            : [{ t: barAt(start), p: prices[0] }, { t: barAt(end), p: prices[1] }];

    // Snap-to-structure, and the warning that price is already through it.
    //
    // A seat reading "support at 62150" off a chart that printed 62147.3 is not
    // wrong by a trading decision, it is wrong by a transcription - it cannot
    // see the digits. So the code measures the level: the model supplies
    // intent, the chart supplies the price. Only hlines are snapped; a trend or
    // zone needs BOTH anchors to keep its slope, and moving one end of a line
    // to a nearby swing would tilt it rather than correct it.
    let snapNote = '';
    let throughNote = '';
    if (kind === 'hline') {
        const drawn = finiteNum(ctx.drawnPrice);
        if (drawn !== null && ctx.klines && ctx.klines.length > 0) {
            const snapped = snapPriceToStructure(prices[0], ctx.klines);
            if (snapped.snapped) {
                snapNote = ` (snapped to the swing at ${snapped.price}, ${Math.abs(((snapped.price - prices[0]) / prices[0]) * 100).toFixed(2)}% from your ${prices[0]})`;
                points[0].p = snapped.price;
            }
            // Price is already well past the level, so whatever the model was reading is
            // not where price is. This does NOT claim the level is wrong - a
            // target far above is normal, and a broken level is how a model
            // discovers it is wrong - so it states the gap and lets the model
            // decide. Deliberately a generous 2%: a level the market is sitting
            // on needs no comment, and warning on the ordinary case would train
            // the model to ignore the receipt.
            const gapPct = Math.abs((points[0].p - drawn) / drawn) * 100;
            if (gapPct > PRICE_ALREADY_PAST_PCT) {
                throughNote = ` NOTE: price is ${drawn}, ${gapPct.toFixed(1)}% ${drawn < points[0].p ? 'above' : 'below'} your level at ${points[0].p}. If you meant a level price is currently holding, this is not it.`;
            }
        }
    }

    return {
        drawings: [{ id: createDrawingId(), kind, points, color, createdAt: Date.now(), label, drawnPrice: finiteNum(ctx.drawnPrice ?? undefined) ?? undefined }],
        note: `${snapNote}${throughNote}`,
    };
};

/**
 * Convert a mark_trade_levels call into labeled horizontal lines: Entry
 * (sky), SL (rose), TPs (amber). One drawing per level, in that order.
 */
export const drawingsFromLevelTool = (
    args: { entry?: unknown; stopLoss?: unknown; takeProfits?: unknown },
    ctx?: { drawnPrice?: number | null },
): { drawings: ChartDrawing[]; error?: string } => {
    const num = (v: unknown): number | null => usablePrice(v);
    const entry = num(args.entry);
    const stop = num(args.stopLoss);
    // Same rule as draw_on_chart, named per field so the model is told which
    // level is wrong. takeProfits is filtered rather than rejected wholesale
    // because a model that emits one bad target alongside two good ones should
    // still get those two drawn.
    const tps = (Array.isArray(args.takeProfits) ? args.takeProfits : [])
        .map((raw, i) => {
            const bad = priceArgError(raw, `takeProfits[${i}]`);
            if (bad) return null;
            return Number(raw);
        })
        .filter((n): n is number => n !== null)
        .slice(0, 5);
    if (entry === null) {
        // Two different failures, and the model needs to be told which. A
        // missing entry is a required-field problem ("you forgot it"); an
        // entry of 0 is a value problem ("that cannot be a price"). Collapsing
        // them loses the distinction, and "entry must be a number" for an
        // absent field reads as if something malformed was sent rather than
        // nothing at all.
        const absent = args.entry === undefined || args.entry === null || args.entry === '';
        return {
            drawings: [],
            error: absent ? 'entry price is required' : priceArgError(args.entry, 'entry') ?? 'entry price is required',
        };
    }
    if (stop === null && tps.length === 0) return { drawings: [], error: 'provide stopLoss and/or takeProfits' };

    const drawnPrice = finiteNum(ctx?.drawnPrice ?? undefined) ?? undefined;
    const mk = (price: number, label: string, color: string): ChartDrawing => ({
        id: createDrawingId(), kind: 'hline', points: [{ t: Date.now() / 1000, p: price }], color, createdAt: Date.now(), label, drawnPrice,
    });
    const drawings: ChartDrawing[] = [mk(entry, 'Entry', MODEL_COLOR_NAMES.sky)];
    if (stop !== null) drawings.push(mk(stop, 'SL', MODEL_COLOR_NAMES.rose));
    tps.forEach((tp, i) => drawings.push(mk(tp, `TP${i + 1}`, MODEL_COLOR_NAMES.amber)));
    return { drawings };
};

/**
 * Turn a DETECTED pattern into drawings, from the anchors the detector already
 * computed.
 *
 * This exists to remove a whole class of error rather than to add a feature.
 * The model was asked to name a structure and then to place it: it read
 * "Shoulders at ~62150.00" out of a sentence and passed 62150 back as a price.
 * When it was slightly wrong — and it was, whenever the pattern was far enough
 * back or the round trip lost a digit — the level was wrong by construction
 * and nothing could detect it, because the drawing and the pattern were never
 * related.
 *
 * Here the model picks WHICH structure ("the head and shoulders") and the code
 * decides where it goes, from the same {price, time} the touch count was
 * measured on. The two cannot disagree, because there is only one of them.
 *
 * `line` (the edge whose touches were counted) is preferred over the raw
 * anchor list: a triangle groups its anchors BY SIDE, so first-to-last across
 * that list would draw a line from a high to a low that nobody described.
 *
 * Pure: no canvas, no React, so the conversion is unit-testable.
 */
export const drawingsFromDetectedPattern = (
    pattern: {
        name: string;
        touches: number;
        anchors?: PatternAnchor[];
        line?: { a: PatternAnchor; b: PatternAnchor };
    },
    ctx?: { drawnPrice?: number | null },
): { drawings: ChartDrawing[]; error?: string } => {
    const pair = pattern.line
        ? [pattern.line.a, pattern.line.b]
        : (pattern.anchors && pattern.anchors.length >= 2
            ? [pattern.anchors[0], pattern.anchors[pattern.anchors.length - 1]]
            : null);
    if (!pair) {
        return {
            drawings: [],
            error: `"${pattern.name}" has no drawable line — the detector found the shape but kept no anchors. Re-run the scan, or place it by hand with draw_on_chart.`,
        };
    }
    const drawnPrice = finiteNum(ctx?.drawnPrice ?? undefined) ?? undefined;
    const label = `${pattern.name} · ${pattern.touches} touch${pattern.touches === 1 ? '' : 'es'}`;
    // A confirmed shape is drawn in emerald and an unconfirmed one in sky, so
    // the confidence is legible on the chart itself rather than only in the
    // receipt. This is the same measured/asserted distinction the axis already
    // carries for verdict levels.
    const color = pattern.touches >= TOUCHES_TO_CONFIRM_FOR_DRAWING
        ? MODEL_COLOR_NAMES.emerald
        : MODEL_COLOR_NAMES.sky;
    const mkPoint = (a: PatternAnchor): DrawPoint => ({ t: a.time, p: a.price });
    // A flat edge (the same price at both ends) is a LEVEL, not a line — a
    // near-zero-slope "trend" is a 1px smudge nobody can aim at.
    const flat = Math.abs(pair[1].price - pair[0].price) / Math.max(1e-9, pair[0].price) < 0.0005;
    const kind: DrawKind = flat ? 'hline' : 'trend';
    return {
        drawings: [{
            id: createDrawingId(),
            kind,
            points: flat ? [mkPoint(pair[0])] : [mkPoint(pair[0]), mkPoint(pair[1])],
            color,
            createdAt: Date.now(),
            label,
            drawnPrice,
        }],
    };
};

/** The touch count at which a drawn pattern is coloured as confirmed. Mirrors
 *  patternStatus' threshold; kept here so this pure module does not have to
 *  import the detector. */
const TOUCHES_TO_CONFIRM_FOR_DRAWING = 3;

/** Minimum anchors per kind — guards against junk shapes reaching storage. */
export const pointsForKind = (kind: DrawKind, points: DrawPoint[]): DrawPoint[] | null => {
    if (kind === 'hline' || kind === 'text') return points.length >= 1 ? [points[0]] : null;
    if (kind === 'trend' || kind === 'ray') return points.length >= 2 ? points.slice(0, 2) : null;
    if (kind === 'rect' || kind === 'fib' || kind === 'channel' || kind === 'arrow') {
        return points.length >= 2 ? points.slice(0, 2) : null;
    }
    // Three anchors on one bar: entry, stop, first target.
    if (kind === 'measured_move') return points.length >= 3 ? points.slice(0, 3) : null;
    if (kind === 'brush') return points.length >= 2 ? points.slice(0, MAX_POINTS_PER_DRAWING) : null;
    return null;
};

const fmt = (n: number): string => Number.isInteger(n) ? String(n) : n.toFixed(2);

/** How long ago a drawing was made, in the same coarse units spanName uses. */
const agoLabel = (ms: number): string => {
    const mins = Math.max(0, ms) / 60_000;
    if (mins < 1) return 'moments';
    if (mins < 60) return `${Math.round(mins)} min`;
    if (mins < 24 * 60) return `${(mins / 60).toFixed(1)} hr`;
    return `${(mins / (60 * 24)).toFixed(1)} days`;
};

/** A drawing is worth re-checking when price has moved ≥1% off its draw-time
 *  mark, or it was anchored ≥4 hr ago. Soft — phrased as a caveat, not a
 *  verdict, so the model re-anchors without being told its read is wrong. */
export const DRAWING_STALE_DRIFT_PCT = 1;
export const DRAWING_STALE_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * A trailing "(drawn …)" note for one shape. Always names the Manila draw time
 * (the clock the user sees); with a live `fresh` context it adds how long ago
 * and — when a draw-time price was recorded — how far the current mark has
 * travelled since, flagging possibly-stale shapes so the model knows to
 * re-anchor before leaning on them.
 */
const freshnessNote = (d: ChartDrawing, fresh?: { priceNow: number | null; nowMs: number }): string => {
    if (!fresh) return ` (drawn ${phtStamp(d.createdAt)})`;
    const ageMs = fresh.nowMs - d.createdAt;
    const bits = [`drawn ${phtStamp(d.createdAt)}, ${agoLabel(ageMs)} ago`];
    const now = fresh.priceNow;
    const driftPct = d.drawnPrice != null && now != null && Number.isFinite(now) && d.drawnPrice !== 0
        ? ((now - d.drawnPrice) / d.drawnPrice) * 100
        : null;
    if (driftPct !== null) {
        const sign = driftPct >= 0 ? '+' : '';
        bits.push(`mark ${fmt(d.drawnPrice as number)}→${fmt(now as number)} (${sign}${driftPct.toFixed(1)}%) since`);
    }
    const stale = Math.abs(driftPct ?? 0) >= DRAWING_STALE_DRIFT_PCT || ageMs >= DRAWING_STALE_AGE_MS;
    if (stale) bits.push('POSSIBLY STALE — re-anchor against current price');
    return ` (${bits.join('; ')})`;
};

/** A rough duration name for a trendline/ray's time span, so the model
 *  knows how wide a shape is without counting seconds. */
const spanName = (seconds: number): string => {
    const mins = seconds / 60;
    if (mins < 5) return 'a few minutes';
    if (mins < 60) return `${Math.round(mins)}m`;
    if (mins < 24 * 60) return `${(mins / 60).toFixed(1)}h`;
    return `${(mins / (60 * 24)).toFixed(1)}d`;
};

/**
 * The chart in words for the model: one line per shape with kind, anchors
 * and (for lines) the slope direction. Used by get_chart_view and the
 * per-message context packet so the model sees what's on the chart. Pass
 * `fresh` (current mark + wall clock) to attach draw-time/drift staleness.
 */
export const describeDrawingsForModel = (
    drawings: ChartDrawing[],
    fresh?: { priceNow: number | null; nowMs: number },
): string => {
    if (drawings.length === 0) return '';
    // Times are Philippine (Manila) throughout — the model reads and repeats
    // the SAME clock the user sees on the chart.
    const lines = drawings.map(d => {
        const tag = d.label ? ` "${d.label}"` : '';
        const suffix = freshnessNote(d, fresh);
        const stamp = (unixSeconds: number): string => phtStamp(unixSeconds * 1000);
        switch (d.kind) {
            case 'hline':
                return `- horizontal line${tag} at price ${fmt(d.points[0].p)}${suffix}`;
            case 'trend':
            case 'ray': {
                const [a, b] = d.points;
                const slope = b.p > a.p ? 'rising' : b.p < a.p ? 'falling' : 'flat';
                const kindName = d.kind === 'trend' ? 'trendline' : 'ray';
                return `- ${slope} ${kindName}${tag} from ${fmt(a.p)} (${stamp(a.t)}) through ${fmt(b.p)} (${stamp(b.t)}), spans ${spanName(Math.abs(b.t - a.t))}${d.kind === 'ray' ? ', extends right' : ''}${suffix}`;
            }
            case 'rect': {
                const [a, b] = d.points;
                const top = Math.max(a.p, b.p);
                const bottom = Math.min(a.p, b.p);
                const left = Math.min(a.t, b.t);
                const right = Math.max(a.t, b.t);
                return `- supply/demand zone${tag} between prices ${fmt(bottom)} and ${fmt(top)}, from ${stamp(left)} to ${stamp(right)}${suffix}`;
            }
            case 'brush': {
                const first = d.points[0];
                const last = d.points[d.points.length - 1];
                return `- freehand sketch${tag} (${d.points.length} points) starting at price ${fmt(first.p)} (${stamp(first.t)}), ending at ${fmt(last.p)}${suffix}`;
            }
            case 'fib': {
                const [a, b] = d.points;
                const high = Math.max(a.p, b.p);
                const low = Math.min(a.p, b.p);
                return `- fibonacci retracement${tag} from ${fmt(low)} to ${fmt(high)}, levels at ${FIB_RATIOS.map(r => `${(r * 100).toFixed(1)}%`).join('/')}, spans ${spanName(Math.abs(b.t - a.t))}${suffix}`;
            }
            case 'channel': {
                const [a, b] = d.points;
                const rising = b.p > a.p;
                return `- ${rising ? 'rising' : 'falling'} channel${tag} running from ${fmt(a.p)} (${stamp(a.t)}) to ${fmt(b.p)} (${stamp(b.t)}), spans ${spanName(Math.abs(b.t - a.t))}${suffix}`;
            }
            case 'arrow': {
                const [a, b] = d.points;
                const up = b.p > a.p;
                return `- arrow${tag} pointing ${up ? 'up' : 'down'} from ${fmt(a.p)} (${stamp(a.t)}) to ${fmt(b.p)} (${stamp(b.t)})${suffix}`;
            }
            case 'measured_move': {
                const [entry, stop, target] = d.points;
                const risk = Math.abs(entry.p - stop.p);
                const reward = Math.abs(target.p - entry.p);
                // The ratio is the canonical one, not a fifth local formula:
                // `plannedRiskReward` measures the target CLOSEST the entry over
                // the stop distance, which for a three-point drawing is this
                // point — and stops being this point the moment the model draws
                // a ladder out of order. A canvas label that disagreed with the
                // card was O-03.
                const ratio = plannedRiskReward({
                    entry: entry.p, stopLoss: stop.p, takeProfits: [target.p],
                });
                const fmtPct = (from: number, to: number): string =>
                    (entry.p > 0 ? ` ${(((to - from) / from) * 100).toFixed(2)}%` : '');
                return `- measured move${tag}: entry ${fmt(entry.p)}, stop ${fmt(stop.p)} (risk ${fmt(risk)}${fmtPct(entry.p, stop.p)}), first target ${fmt(target.p)} (reward ${fmt(reward)}${fmtPct(entry.p, target.p)}), ${fmtRiskReward(ratio, 2)}${suffix}`;
            }
            case 'text':
                return `- text note${tag} at price ${fmt(d.points[0].p)} (${stamp(d.points[0].t)})${d.label ? `: ${d.label}` : ''}${suffix}`;
            default:
                return null;
        }
    }).filter((l): l is string => Boolean(l));
    return [`DRAWINGS ON THE CHART (user + model — ${drawings.length} shape${drawings.length === 1 ? '' : 's'}), times in Philippine time (UTC+8):`, ...lines].join('\n');
};
