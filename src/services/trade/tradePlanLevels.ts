/**
 * tradePlanLevels — the pure half of the harness level-watch: derive the
 * watchable levels of a presented trade plan, detect direction-aware
 * touches on live price ticks, and render the plan / a hit as the text the
 * Chart AI model reads. Mirrors the chatPanel/chatStore split (pure logic +
 * a singleton service), so every rule here is unit-testable with no React
 * and no network.
 *
 * CONTRACT: this is ADVISORY ONLY. It warns the model that a level was
 * reached; it never resolves anything. OutcomeAutopilotService owns SL/TP
 * resolution + post-mortem for logged trades. Both watch the same levels on
 * purpose — one grades the trade, one prompts the conversation — and the
 * fire-once latch (persisted per user by levelWatchService) keeps a level
 * from ever pinging twice, across reloads.
 */

import { phtClock } from '../../utils/timezone';
// The canonical price reader. The drawing tools were the one place that used a
// bare Number(), which is why "69,000" parsed everywhere else and not here.
import { parsePrice } from '../../utils/analysisUtils';
import type { ChartDrawing } from './chartDrawings';
import {
    interpolateScalePrice,
    projectDiagonalPrice,
    timeToLogicalIndex,
    type EvalCandle,
    type PriceScaleMode,
} from './chartGeometry';

export interface PlanLevel {
    /** Stable id the model quotes back: `${planId}:ENTRY|:SL|:TP1..N`. */
    id: string;
    kind: 'entry' | 'sl' | 'tp';
    label: string;
    price: number;
    tpIndex?: number;
}

export interface WatchPlan {
    planId: string;
    /** The dock session that armed this plan, when it came from a turn. An
     *  unbound plan (a Chat-surface verdict) drains to the active thread. */
    sid?: string;
    symbol: string;
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfits: number[];
}

export interface LevelHit {
    levelId: string;
    kind: PlanLevel['kind'];
    label: string;
    /** The plan's level price. */
    price: number;
    /** The tick that touched it. */
    hitPrice: number;
    /** Epoch ms. */
    at: number;
}

/**
 * The ONE rule for "is this a number we can put on a chart".
 *
 * Every path that turns a model-supplied number into a price on the user's
 * live chart, a watch trigger, or a plan level goes through here. There is no
 * second copy: the drawing tools used to accept any finite number, so `0` and
 * `-5` became a line at zero and the caller was told "Drew on the chart" —
 * a success receipt for something that cannot exist.
 *
 * `Number.isFinite` alone is not enough. Zero is finite. So is -1. Both are
 * finite, and both are not prices.
 *
 * Returns the rejection reason, or null when the value is usable. `field` is
 * used in the message so a four-price `prices: []` array says WHICH one is
 * wrong, rather than the model re-guessing all of them.
 */
export const priceArgError = (raw: unknown, field = 'price'): string | null => {
    const n = usablePrice(raw);
    if (n === null) return `${field} must be a positive number`;
    return null;
};

/**
 * Coerce a model-supplied value to a usable price, or null if it is not one.
 *
 * The same rule as `chartData.parsePrice` and `keyLevels.parsePrice` — finite
 * and greater than zero — but it was implemented with a plain `Number()`,
 * while those two route strings through `analysisUtils.parsePrice`. That made
 * the drawing tools the only price reader in the app that could not read
 * "69,000": the verdict overlay and the key-level loader both accept it, and a
 * model told "prices[0] must be a positive number" about a perfectly ordinary
 * number has no way to guess that the comma was the problem.
 *
 * Numbers still take the fast path, so this stays cheap on the common case and
 * accepts a real numeric price exactly as before.
 */
export const usablePrice = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;
    const n = parsePrice(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** One row per watchable level, ids stable for the plan's whole life. */
export const buildPlanLevels = (p: WatchPlan): PlanLevel[] => {
    const levels: PlanLevel[] = [
        { id: `${p.planId}:ENTRY`, kind: 'entry', label: 'Entry', price: p.entry },
        { id: `${p.planId}:SL`, kind: 'sl', label: 'Stop loss', price: p.stopLoss },
    ];
    p.takeProfits.forEach((tp, i) => levels.push({
        id: `${p.planId}:TP${i + 1}`, kind: 'tp', label: `TP${i + 1}`, price: tp, tpIndex: i + 1,
    }));
    return levels;
};

/** Direction-aware touch: is `price` at or through this level? A Long's
 *  entry/stop sit BELOW the market (fire at `<=`), its targets ABOVE (`>=`);
 *  a Short mirrors. A touch test subsumes mid-tick crossings — any print on
 *  the far side of the level fires, however fast the market moved. */
const touches = (level: PlanLevel, price: number, direction: 'Long' | 'Short'): boolean => {
    if (!Number.isFinite(level.price) || level.price <= 0) return false;
    const beyond = direction === 'Long'
        ? (level.kind === 'tp' ? price >= level.price : price <= level.price)
        : (level.kind === 'tp' ? price <= level.price : price >= level.price);
    return beyond;
};

/** Every unfired level this tick touches. `prev` is the last accepted tick:
 *  an unchanged print can't newly touch anything, so it's skipped (the
 *  feed's 1s mark price repeats constantly). The first tick (prev === null)
 *  is judged on the plain touch test — the "first-tick fallback". */
export const detectLevelHits = (
    levels: PlanLevel[],
    direction: 'Long' | 'Short',
    prev: number | null,
    price: number,
    isFired: (levelId: string) => boolean,
): LevelHit[] => {
    if (!Number.isFinite(price) || price <= 0) return [];
    if (prev !== null && prev === price) return [];
    const at = Date.now();
    return levels
        .filter(l => !isFired(l.id) && touches(l, price, direction))
        .map(l => ({ levelId: l.id, kind: l.kind, label: l.label, price: l.price, hitPrice: price, at }));
};

// ── DRAWN LEVELS ─────────────────────────────────────────────────────────────
// Everything above grades a plan's levels against a LIVE tick. What was
// missing is the question the app never asked of the shapes the MODEL draws:
// a seat can put twenty levels on a chart and every one of them is unmeasured
// forever. Nothing scores whether price ever reached them, so a model that
// draws nonsense and a model that draws structure are indistinguishable - and
// the user has no way to learn which one they are talking to.
//
// Pure functions over a candle series. WHEN to run them is a service's
// problem; what "reached" means belongs beside the code that already owns that
// question, not inside a component.

/** How a model-drawn level fared once the market had time to reach it. */
export type DrawnLevelVerdict = 'untouched' | 'touched' | 'pending';

export interface DrawnLevelScore {
    verdict: DrawnLevelVerdict;
    /** Closest the market came, in percent of the level's price. 0 = touched. */
    missPct: number;
    /** Bars examined since the shape was drawn. */
    barsSince: number;
}

/**
 * Did the market reach a price the model drew?
 *
 * Scored against each BAR'S RANGE, not its close, because a level can be
 * traded through intrabar and a close-only test would report a level the
 * market plainly reached as untouched. Same lesson the touch detector above
 * encodes: a print on the far side fires however fast the market moved. The
 * bar's range must SPAN the level - a bar that merely traded on the far side
 * of it is not a touch, or a level the market had already walked past would
 * read as reached forever.
 *
 * `drawnAtSeconds` restricts the scan to bars at or after the shape was drawn.
 * Scanning history the model could already see when it chose the price would
 * let it claim credit for a level that only worked afterwards, or bury a bad
 * one under a swing from before it drew anything.
 *
 * 'pending' when there are not yet enough bars to judge: a level drawn two
 * minutes ago has not had a fair test, and calling that 'untouched' is the
 * same failure pointed the other way.
 */
export const scoreDrawnLevel = (
    levelPrice: number,
    candles: ReadonlyArray<{ time: number; high: number; low: number }>,
    drawnAtSeconds: number,
    minBars = 3,
): DrawnLevelScore => {
    if (!Number.isFinite(levelPrice) || levelPrice <= 0) {
        return { verdict: 'untouched', missPct: Infinity, barsSince: 0 };
    }
    const after = candles.filter(c => c.time >= drawnAtSeconds);
    if (after.length < minBars) {
        return { verdict: 'pending', missPct: Infinity, barsSince: after.length };
    }
    let miss = Infinity;
    for (const c of after) {
        // The bar's range must SPAN the level. Testing `low <= level` alone
        // would call any bar that traded below it a touch, including one that
        // never came near from the other side — which is how a level the
        // market had already walked past reads as "reached" forever.
        if (c.high >= levelPrice && c.low <= levelPrice) { miss = 0; break; }
        // Perpendicular gap from the level to the bar's range, as a percent.
        // Whichever side the bar sits on, the gap is how far away the NEAREST
        // edge is — not how far the far edge is, which would let a wide bar
        // that never came close report a smaller miss than a narrow one that
        // nearly touched.
        miss = Math.min(miss, (Math.max(levelPrice - c.high, c.low - levelPrice) / levelPrice) * 100);
    }
    const missPct = Math.max(0, Math.abs(miss));
    return { verdict: missPct === 0 ? 'touched' : 'untouched', missPct, barsSince: after.length };
};

export interface ScoreDrawnShapeOptions {
    /** Bar interval in seconds (used for logical-index diagonal projection). */
    barSeconds: number;
    /** Price scale mode (`normal` | `logarithmic`) for diagonal/fib projection. */
    priceScaleMode?: PriceScaleMode;
    /** Minimum post-creation bars required before leaving `'pending'`. Default 3. */
    minBars?: number;
    /** Optional creation timestamp in unix seconds override (defaults to drawing.createdAt / 1000). */
    drawnAtSeconds?: number;
}

const barMissPctToPrice = (bar: Pick<EvalCandle, 'high' | 'low'>, target: number): number => {
    if (!Number.isFinite(target) || target <= 0) return Infinity;
    if (bar.high >= target && bar.low <= target) return 0;
    return (Math.max(target - bar.high, bar.low - target) / target) * 100;
};

const barMissPctToZone = (bar: Pick<EvalCandle, 'high' | 'low'>, lower: number, upper: number): number => {
    const lo = Math.min(lower, upper);
    const hi = Math.max(lower, upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return Infinity;
    // Any overlap between [bar.low, bar.high] and [lo, hi] is a touch.
    if (bar.high >= lo && bar.low <= hi) return 0;
    if (bar.high < lo) return ((lo - bar.high) / lo) * 100;
    return ((bar.low - hi) / hi) * 100;
};

/**
 * Generalized drawing-respect scorer for ALL chart drawing shapes:
 * horizontal lines (`hline`), diagonals (`trend`, `ray`), parallel `channel`s,
 * `rect` zones, `fib` retracements (0.382 / 0.5 / 0.618 key levels), and
 * `long_position` / `short_position` entry levels.
 *
 * Uses the exact same logical-bar-index + linear/log scale projection as
 * `chartGeometry.ts`, restricted strictly to bars at or after creation.
 */
export const scoreDrawnShape = (
    drawing: ChartDrawing,
    candles: ReadonlyArray<EvalCandle>,
    opts: ScoreDrawnShapeOptions,
): DrawnLevelScore => {
    const minBars = opts.minBars ?? 3;
    const scaleMode: PriceScaleMode = opts.priceScaleMode ?? 'normal';
    const drawnAtSeconds = opts.drawnAtSeconds ?? Math.floor((drawing.createdAt ?? 0) / 1000);

    if (drawing.kind === 'hline') {
        const level = drawing.points[0]?.p ?? NaN;
        return scoreDrawnLevel(level, candles, drawnAtSeconds, minBars);
    }

    const postIndices: number[] = [];
    for (let i = 0; i < candles.length; i += 1) {
        if (candles[i].time >= drawnAtSeconds) postIndices.push(i);
    }
    if (postIndices.length < minBars) {
        return { verdict: 'pending', missPct: Infinity, barsSince: postIndices.length };
    }

    let miss = Infinity;
    const pts = drawing.points;

    if (drawing.kind === 'trend' || drawing.kind === 'ray') {
        if (pts.length < 2) return { verdict: 'untouched', missPct: Infinity, barsSince: postIndices.length };
        const [a, b] = pts;
        for (const idx of postIndices) {
            const projected = projectDiagonalPrice(a, b, idx, candles, opts.barSeconds, scaleMode);
            if (projected === null || projected <= 0) continue;
            const d = barMissPctToPrice(candles[idx], projected);
            if (d < miss) miss = d;
            if (miss === 0) break;
        }
    } else if (drawing.kind === 'channel') {
        if (pts.length < 3) return { verdict: 'untouched', missPct: Infinity, barsSince: postIndices.length };
        const [a, b, c] = pts;
        const idxC = timeToLogicalIndex(c.t, candles, opts.barSeconds);
        const baseAtC = idxC !== null
            ? projectDiagonalPrice(a, b, idxC, candles, opts.barSeconds, scaleMode)
            : null;
        const rawDelta = baseAtC !== null ? c.p - baseAtC : c.p - a.p;
        const logRatio = scaleMode === 'logarithmic' && baseAtC !== null && baseAtC > 0 && c.p > 0
            ? c.p / baseAtC
            : (scaleMode === 'logarithmic' && a.p > 0 && c.p > 0 ? c.p / a.p : null);
        for (const idx of postIndices) {
            const p1 = projectDiagonalPrice(a, b, idx, candles, opts.barSeconds, scaleMode);
            if (p1 === null || p1 <= 0) continue;
            const p2 = logRatio !== null ? p1 * logRatio : p1 + rawDelta;
            if (!Number.isFinite(p2) || p2 <= 0) continue;
            // Respecting either rail or trading inside the channel zone counts as a touch.
            const d = barMissPctToZone(candles[idx], p1, p2);
            if (d < miss) miss = d;
            if (miss === 0) break;
        }
    } else if (drawing.kind === 'rect') {
        if (pts.length < 2) return { verdict: 'untouched', missPct: Infinity, barsSince: postIndices.length };
        const lower = Math.min(pts[0].p, pts[1].p);
        const upper = Math.max(pts[0].p, pts[1].p);
        for (const idx of postIndices) {
            const d = barMissPctToZone(candles[idx], lower, upper);
            if (d < miss) miss = d;
            if (miss === 0) break;
        }
    } else if (drawing.kind === 'fib') {
        if (pts.length < 2) return { verdict: 'untouched', missPct: Infinity, barsSince: postIndices.length };
        const keyRatios = [0.382, 0.5, 0.618];
        const keyLevels = keyRatios
            .map(r => interpolateScalePrice(pts[0].p, pts[1].p, r, scaleMode))
            .filter((v): v is number => v !== null && v > 0);
        for (const idx of postIndices) {
            for (const lvl of keyLevels) {
                const d = barMissPctToPrice(candles[idx], lvl);
                if (d < miss) miss = d;
            }
            if (miss === 0) break;
        }
    } else if (drawing.kind === 'long_position' || drawing.kind === 'short_position') {
        const entry = pts[0]?.p ?? NaN;
        return scoreDrawnLevel(entry, candles, drawnAtSeconds, minBars);
    }

    const missPct = Number.isFinite(miss) ? Math.max(0, Math.abs(miss)) : Infinity;
    return { verdict: missPct === 0 ? 'touched' : 'untouched', missPct, barsSince: postIndices.length };
};

/** The headline number: what share of the model's drawn levels got reached. */
export const levelAccuracy = (scores: DrawnLevelScore[]): {
    reached: number;
    judged: number;
    ratio: number | null;
} => {
    const judged = scores.filter(s => s.verdict !== 'pending');
    const reached = judged.filter(s => s.verdict === 'touched').length;
    // null rather than 0 when nothing has been judged: "0% of nothing" reads
    // as a failure of the model when it is a failure of the sample.
    return { reached, judged: judged.length, ratio: judged.length === 0 ? null : reached / judged.length };
};

/** For the model: one line saying how its own drawn levels have done. */
export const describeLevelAccuracyForModel = (scores: DrawnLevelScore[]): string => {
    const { reached, judged, ratio } = levelAccuracy(scores);
    if (judged === 0) {
        return 'No drawn level has been on the chart long enough to judge — say nothing about their accuracy yet.';
    }
    return `Of your ${judged} judged level(s) on this chart, price reached ${reached} `
        + `(${(ratio! * 100).toFixed(0)}%). Treat a level you drew as a hypothesis, not a fact: `
        + 'levels price never came back to were not read from the chart.';
};

/**
 * Stale-plan guard: levels to latch SILENTLY at arm time. If the market is
 * already through the stop or a target when the plan is armed, the plan is
 * already invalidated or paid — pinging "SL HIT" on tick 0 for a plan the
 * user just watched die is noise, so every level is suppressed. An entry
 * already in range is NOT stale (the zone is live right now) — it fires on
 * the first tick like any other touch.
 */
export const staleLevelsAtArm = (p: WatchPlan, priceAtArm: number | null): string[] => {
    if (priceAtArm === null || !Number.isFinite(priceAtArm) || priceAtArm <= 0) return [];
    const levels = buildPlanLevels(p);
    const dead = levels.some(l => (l.kind === 'sl' || l.kind === 'tp') && touches(l, priceAtArm, p.direction));
    return dead ? levels.map(l => l.id) : [];
};

/** The armed-plan block the model reads with every message: the live plan,
 *  each level's id, and which levels already fired (never to be re-
 *  announced). Empty firedIds ⇒ "nothing has fired yet". */
export const describePlanForModel = (p: WatchPlan, firedIds: string[]): string => {
    const levels = buildPlanLevels(p);
    const fired = new Set(firedIds);
    const rows = levels.map(l => `${l.label} ${l.price}${fired.has(l.id) ? ' — FIRED' : ''} [${l.id}]`);
    return [
        `[ARMED PLAN — harness level watch on ${p.direction} ${p.symbol}, plan ${p.planId}. Advisory only: the harness warns, it never places or closes anything.]`,
        rows.join(' · '),
        fired.size > 0
            ? `Already fired: ${levels.filter(l => fired.has(l.id)).map(l => l.id).join(', ')} — never re-announce these.`
            : 'No level has fired yet.',
    ].join('\n');
};

/** The exact text a level hit sends to the model (the harness signal). The
 *  level id is named explicitly so the model can say WHICH level spoke. */
export const formatLevelHitForModel = (p: WatchPlan, hit: LevelHit, firedIds: string[]): string => {
    const when = phtClock(hit.at);
    const others = firedIds.filter(id => id !== hit.levelId);
    // The instruction rides its OWN line. The dock's notice row renders the
    // signal's first line only — one joined line used to print the model's
    // orders ("WARN THE USER NOW…") as an all-caps amber transcript row.
    const event = [
        `[HARNESS SIGNAL — price event, not the user] Plan ${p.planId}: ${hit.label} @ ${hit.price} HIT (mark ${hit.hitPrice}, ${when} PHT).`,
        `Level id ${hit.levelId}.`,
        `Plan: Entry ${p.entry} · SL ${p.stopLoss} · TP ${p.takeProfits.join(' / ')}.`,
        others.length > 0 ? `Already fired: ${others.join(', ')}.` : 'This is the first level of this plan to fire.',
    ].join(' ');
    return `${event}
Warn the user now: what hit, the price, whether the rest of the plan holds, and refer to levels by id. Do not re-announce fired levels.`;
};
