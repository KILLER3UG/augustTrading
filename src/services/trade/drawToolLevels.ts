/**
 * drawToolLevels — the ONE `draw_tool_levels` core, shared by the Chart AI
 * dock and the Chat surface's store-backed drawing executor.
 *
 * The model NAMES a market tool (and optionally which labels it wants); this
 * re-runs the tool FRESH at draw time and converts its computed levels into
 * chart drawings at the tool's own prices. The model never restates a number,
 * so the drawing and the computation cannot disagree — the same rule
 * `draw_detected` applies to detector anchors.
 *
 * Pure-ish: no canvas, no React. The caller owns the receipt prose, the
 * visibility note and where the drawings land (live canvas state vs the
 * per-session store).
 */

import {
    createDrawingId,
    MODEL_COLOR_NAMES,
    type ChartDrawing,
} from './chartDrawings';
import { allocateDrawingShortId } from './chartGeometry';
import { intervalSeconds } from '../../utils/chartIntervals';

export interface DrawToolLevelsCtx {
    /** The turn's coin — the default for the tool's `symbol` argument. */
    symbol: string;
    /** The turn's timeframe — the default for structure tools. */
    interval: string;
    /** Existing shapes (for stable `#Dn` short-id allocation). */
    existing?: ReadonlyArray<Pick<ChartDrawing, 'shortId'>>;
    /** The canvas' visible window — zone anchors span it (a zone is a region,
     *  not a point). Absent ⇒ the last ~40 bars before `lastBarTime`. */
    visibleRange?: { timeLow?: number; timeHigh?: number } | null;
    /** Unix seconds of the newest candle (fallback: now). */
    lastBarTime?: number;
    /** The live mark at draw time, stamped onto each shape for staleness
     *  reads; absent/zero marks are simply not stamped. */
    drawnPrice?: number | null;
}

export interface DrawToolLevelsResult {
    drawings: ChartDrawing[];
    /** Caller-facing refusal (already worded for the model). */
    error?: string;
    /** The canonical tool name that was drawn. */
    tool: string;
}

/** Run `tool` fresh and convert its levels into drawings. */
export const drawToolLevelsFromCall = async (
    args: Record<string, unknown>,
    ctx: DrawToolLevelsCtx,
): Promise<DrawToolLevelsResult> => {
    // Lazy: the market-tool module (and its fetch layer) stays out of the
    // dock chunk until a seat actually draws.
    const mt = await import('../analysis/marketTools');
    const wanted = String(args.tool ?? '').trim();
    if (!mt.DRAWABLE_TOOLS.includes(wanted)) {
        return { drawings: [], error: `"tool" must be one of ${mt.DRAWABLE_TOOLS.join(', ')}.`, tool: wanted };
    }
    const sym = String(args.symbol || ctx.symbol || '').trim();
    const items = Array.isArray(args.items) ? args.items.map(String) : undefined;
    let content: string;
    try {
        switch (wanted) {
            case 'volume_profile':
                content = await mt.runVolumeProfileTool(sym, (['session', 'day', 'week', 'visible', 'swing', 'custom'].includes(String(args.anchor)) ? String(args.anchor) : 'session') as Parameters<typeof mt.runVolumeProfileTool>[1]);
                break;
            case 'naked_pocs':
                content = await mt.runNakedPocsTool(sym, String(args.granularity) === 'week' ? 'week' : 'day', Math.min(20, Math.max(1, Number(args.lookback) || 5)));
                break;
            case 'vwap':
                content = await mt.runVwapTool(sym, (['session_open', 'swing_high', 'swing_low', 'custom'].includes(String(args.anchor)) ? String(args.anchor) : 'session_open') as Parameters<typeof mt.runVwapTool>[1]);
                break;
            case 'auction_state':
                content = await mt.runAuctionStateTool(sym);
                break;
            case 'get_key_levels':
                content = await mt.runKeyLevelsEnvelope(sym);
                break;
            default:
                content = await mt.runStructureTool(wanted, sym, (['5m', '15m', '1h', '4h'].includes(String(args.interval)) ? String(args.interval) : '1h'));
                break;
        }
    } catch (e) {
        return { drawings: [], error: `could not re-run ${wanted}: ${e instanceof Error ? e.message : 'fetch failed'}.`, tool: wanted };
    }
    if (!content) return { drawings: [], error: `${wanted} returned nothing.`, tool: wanted };
    let parsed: { values?: unknown; data_quality?: { reason?: string } };
    try {
        parsed = JSON.parse(content);
    } catch {
        return { drawings: [], error: `${wanted} returned a non-JSON result; nothing to draw.`, tool: wanted };
    }
    // get_key_levels' shape is its own (session_levels at the root, no
    // envelope) — wrap it so the extractor sees one shape.
    const set = mt.drawableLevelsFor(wanted, wanted === 'get_key_levels' ? { values: parsed } : parsed, items);
    if (!set || (set.hlines.length === 0 && set.zones.length === 0)) {
        const reason = parsed.data_quality?.reason ?? 'no drawable levels in the fresh result (nothing qualified)';
        return { drawings: [], error: `${wanted} produced nothing drawable — ${reason}. Nothing was drawn.`, tool: wanted };
    }
    const nowSec = Date.now() / 1000;
    const lastBarTime = ctx.lastBarTime ?? Math.floor(nowSec);
    const barSeconds = intervalSeconds(ctx.interval as never);
    // Zones anchor to the VISIBLE window (a zone is a region, not a point);
    // without a fitted range, fall back to the last ~40 bars.
    const t0 = ctx.visibleRange?.timeLow ?? (lastBarTime - 40 * barSeconds);
    const t1 = ctx.visibleRange?.timeHigh ?? lastBarTime;
    const seen: Array<Pick<ChartDrawing, 'shortId'>> = [...(ctx.existing ?? [])];
    const drawnPrice = Number.isFinite(ctx.drawnPrice ?? NaN) && (ctx.drawnPrice ?? 0) > 0 ? ctx.drawnPrice : undefined;
    const mk = (price: number, label: string, color: string): ChartDrawing => {
        const shortId = allocateDrawingShortId(ctx.symbol, seen);
        seen.push({ shortId });
        return {
            id: createDrawingId(), shortId, origin: 'agent', createdOnTf: ctx.interval, version: 1,
            kind: 'hline', points: [{ t: nowSec, p: price }], color, createdAt: Date.now(), label, drawnPrice,
        };
    };
    const mkZone = (label: string, top: number, bottom: number, color: string): ChartDrawing => {
        const shortId = allocateDrawingShortId(ctx.symbol, seen);
        seen.push({ shortId });
        return {
            id: createDrawingId(), shortId, origin: 'agent', createdOnTf: ctx.interval, version: 1,
            kind: 'rect', points: [{ t: t0, p: top }, { t: t1, p: bottom }], color, createdAt: Date.now(), label, drawnPrice,
        };
    };
    const drawings: ChartDrawing[] = [
        ...set.hlines.map(h => mk(h.price, h.label, MODEL_COLOR_NAMES[h.color])),
        ...set.zones.map(z => mkZone(z.label, z.top, z.bottom, MODEL_COLOR_NAMES[z.color])),
    ].slice(0, 20); // the model-drawing cap is 40 per symbol; one call stays half of it
    return { drawings, tool: wanted };
};
