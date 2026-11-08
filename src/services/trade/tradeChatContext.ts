/**
 * tradeChatContext — the pure half of "the model sees the chart realtime":
 * wraps the freshly-fetched hybrid market packet (which already carries the
 * numeric chart state per timeframe, indicators, funding, OI, book walls,
 * liquidations and session) plus the user's chart drawings in a labeled,
 * timestamped block the trade-panel chat prepends to every outgoing message.
 * Kept pure so the framing is unit-testable without a provider or the network.
 */

import { phtFullStamp, phtStamp } from '../../utils/timezone';
import { clipNote, dataUnavailable } from '../../utils/harnessMarks';
import { charsForTokens, windowBudgetTokens } from '../../utils/tokenEstimate';
import type { SkillIndexRow } from '../../services/learning/SkillFileService';

export interface TradeChatContextInput {
    symbol: string;
    interval: string;
    /** generateHybridPromptInjection output (code-calculated packet markdown). */
    packetMarkdown: string;    /** Epoch ms of the fetch — stamped so the model knows how fresh it is. */
    fetchedAtMs: number;
    /** The user's drawings on this chart (shape list; '' text when none). */
    drawingsDescription?: string;
    /** What the canvas literally displays right now (last bars + mark +
     *  levels), from TradingChart's imperative snapshot. Distinct from the
     *  packet: the packet is fetched data, this is what got PAINTED. */
    onScreenDescription?: string;
    /** The harness level-watch's armed plans for this symbol (one
     *  describePlanForModel block per plan, joined) — the model always
     *  knows the live plan and which levels already fired, even without a
     *  fresh signal. */
    plansDescription?: string;
    /** The chart's live websocket mark (markPrice@1s) captured at send
     *  time. When present it is stamped onto the packet so a cached
     *  snapshot can never read as a fresh price move. */
    liveMarkPrice?: number | null;
    /** The chart's forming candle (last element of the painted candles —
     *  updated live by the kline websocket). Stamped onto the packet so its
     *  REST-snapshot candle rows can't contradict what the user watches. */
    formingCandle?: FormingCandle | null;
    /** The coin's last stored post-mortem, pre-rendered by
     *  `diagnosisBriefBlock` (REFERENCE ONLY framing included). E7 extended
     *  to the ordinary desk read: the loop's lesson rides the context, not
     *  only the emit receipt. '' or undefined renders nothing. */
    postMortemBrief?: string;
    /** The seat's context window, when the caller knows it. Sizing the packet
     *  budget against the REAL window is the point — a 1M-window seat and a
     *  32k one should not be sent the same packet. */
    contextWindowTokens?: number;
    /** Clock for the age stamp. Defaults to now; injectable so the sentence a
     *  model reads about a packet's staleness is testable without a timer. */
    nowMs?: number;
}

/**
 * How much of the model's window the per-message packet may occupy.
 *
 * A fraction, not a flat number, so a small-window seat is not handed a packet
 * designed for a large one. The absolute cap is the guard for big windows,
 * which is why both feed `windowBudgetTokens` — it takes the smaller.
 */
const PACKET_WINDOW_FRACTION = 0.10;
const PACKET_TOKEN_CAP = 6_000;

/** One OHLC candle — the shape the canvas snapshot carries. */
export interface FormingCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

/** Price formatting tiers shared with the packet's own rendering. */
const fmtPx = (v: number): string => (v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(6));

/** One price-stamp line pinning the packet to the chart's websocket mark —
 *  the snapshot-vs-live seam in a single sentence. Shared with the desk-tool
 *  packet path (get_market_packet) so both stamps read identically. */
export const formatLiveMarkStamp = (price: number): string =>
    `[PRICE STAMP — live perp mark from the chart's markPrice@1s feed: $${fmtPx(price)}, this is "now". The packet's own price is a REST snapshot; where they differ, the stamp wins.]`;

/** One line pinning the packet to the chart's LIVE forming candle (the
 *  ws-updated tail the user is watching right now). */
export const formatFormingCandleLine = (candle: FormingCandle, interval?: string): string => {
    const ivl = interval ? `${interval} ` : '';
    const last = interval ? `last ${interval} ` : 'last ';
    return `[LIVE CANDLE — the forming ${ivl}candle on the chart right now: O ${fmtPx(candle.open)} H ${fmtPx(candle.high)} L ${fmtPx(candle.low)} C ${fmtPx(candle.close)} (kline websocket, live). The packet's ${last}candle row is a REST snapshot — this one is current.]`;
};

/** The packet's own age, in the sentence the model reads.
 *
 * `fetchedAtMs` alone asks the seat to subtract two clock times it cannot see,
 * and the cache in `chatTurnRunner` legitimately serves a packet up to 8 s old.
 * So the age is STATED, and past a minute it is named STALE with the remedy —
 * the seat must not read an eight-second-old snapshot as the live tape. */
export const packetAgeNote = (fetchedAtMs: number, nowMs: number): string => {
    const ageSec = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
    if (ageSec < 60) return `${ageSec}s old`;
    const mins = Math.floor(ageSec / 60);
    return `${mins}m ${ageSec % 60}s old — STALE: this snapshot predates the last ${mins} minute(s); call get_market_packet or get_chart_view for a newer read before you state a price`;
};

export const buildTradeChatContext = ({ symbol, interval, packetMarkdown, fetchedAtMs, drawingsDescription, onScreenDescription, plansDescription, postMortemBrief, liveMarkPrice, formingCandle, contextWindowTokens, nowMs }: TradeChatContextInput): string => {
    const when = phtFullStamp(fetchedAtMs);
    // A failed fetch is the app's OWN sentinel, not a parenthetical: the same
    // marker every other withheld read uses, so the seat cannot file an outage
    // as "there was nothing to find" and the cache/evidence paths can test it.
    const rawPacket = (packetMarkdown || '').trim() || dataUnavailable(
        'market packet',
        `the live fetch had returned nothing by ${when} PHT`,
        'Nothing about this chart was measured, so its state is UNKNOWN — say so and call get_market_packet or get_chart_view instead of guessing',
    );
    // The packet is the only unbounded section here, and it is the one this
    // block was previously concatenating with no cap at all — routine charts
    // rode 8-12k chars into EVERY message, including one-word questions.
    //
    // Clipped HERE rather than head-slicing the assembled block. The read
    // rules (the PRICES freshness note and both tool paragraphs) are the TAIL
    // of that assembly, and a head-slice eats exactly them: the same failure
    // already shipped once inside generateHybridPromptInjection, where the SMC
    // block was moved up for this reason and the read rules were not.
    const rawTotal = rawPacket.length;
    const room = charsForTokens(
        windowBudgetTokens(PACKET_WINDOW_FRACTION, PACKET_TOKEN_CAP, contextWindowTokens)
    );
    const packet = rawTotal > room
        ? `${rawPacket.slice(0, room).trimEnd()}\n${clipNote({ source: 'market packet', kept: room, total: rawTotal, guidance: 'the summaries past this point were withheld by the size cap, NOT absent — call get_market_packet or get_chart_view for the full picture' })}`
        : rawPacket;
    const stamp = typeof liveMarkPrice === 'number' && Number.isFinite(liveMarkPrice) && liveMarkPrice > 0
        ? formatLiveMarkStamp(liveMarkPrice)
        : '';
    const candleLine = formingCandle ? formatFormingCandleLine(formingCandle, interval) : '';
    return [
        `[LIVE CHART CONTEXT — ${symbol} · ${interval} chart · fetched ${when} PHT (UTC+8), ${packetAgeNote(fetchedAtMs, nowMs ?? Date.now())} — code-calculated, treat as ground truth]`,
        stamp,
        candleLine,
        packet,
        (onScreenDescription || '').trim(),
        '[PRICES — the packet is a REST snapshot (ticker/klines cached up to ~30s); the PRICE STAMP and the "Live mark" in [ON SCREEN] both come from the chart\'s markPrice@1s websocket and are the FRESHEST prices in this message. A gap between packet numbers and those is snapshot age or perp basis, NOT a fresh market move — never narrate a move from that gap alone; confirm with get_chart_view or get_price_snapshot first.]',
        (plansDescription || '').trim(),
        (postMortemBrief || '').trim(),
        (drawingsDescription || '').trim(),
        'If you need data newer than this packet, CALL THE DESK TOOLS — get_chart_view (everything on screen: candles, timeframe, live mark, verdict levels, order book and the user\'s own drawings), get_all_timeframes (every timeframe at once: candles, structure, formations per TF + book/spread/funding/OI/liquidations), get_market_packet (the full hybrid pull: every timeframe, indicators, funding, OI, book walls, liquidations, session), scan_setups (the strategy-book scanner: live breakouts, pin bars, inside-bar resolutions, gaps, divergences, band plays, pullbacks and failed breaks with evidence + matching skills), or the granular ones (get_price_snapshot, get_order_book, get_liquidations, get_session_context) — never invent a number the packet lacks.',
        'You can also GROW with this desk: write_memory_note saves a durable lesson straight into the trader notebook, get_notebook_map shows what you already know before you write, and skill_index / skill_write are the ONLY skill writer — read the index first, then UPDATE or MERGE an existing skill instead of creating a near-duplicate; a create that overlaps an existing skill is refused. amend_memory / forge_tool write directly too. And you can DRAW on this chart like the user does: mark_trade_levels lays an Entry/Stop/TP plan as labeled lines, draw_on_chart adds a trendline/ray/zone/fib/text, get_all_timeframes pulls every timeframe plus the book at once. The drawings block stamps when each shape was drawn and how far the mark has moved since — honour a "POSSIBLY STALE" flag by re-checking the level before you lean on it.',
    ].filter(Boolean).join('\n\n');
};

/** The on-screen read for the model: the last painted candles + live mark +
 *  drawn levels, straight from the canvas snapshot (what the user ACTUALLY
 *  sees, not a fresh network fetch). Structural input so it stays pure. */
export const describeChartSnapshotForModel = (snap: {
    candles: { time: number; open: number; high: number; low: number; close: number }[];
    markPrice: number | null;
    levels: { label: string; price: number }[];
    capturedAt: number;
    visibleRange?: {
        priceLow: number;
        priceHigh: number;
        timeLow: number;
        timeHigh: number;
        barsLoaded: number;
        barsVisible: number;
    } | null;
}): string => {
    if (!snap || snap.candles.length === 0) return '';
    // Candle stamps in Philippine time — the model quotes the clock the user
    // sees, never UTC to convert. These candles come from the CANVAS snapshot,
    // whose `time` is lightweight-charts UNIX SECONDS, so this ×1000 is the
    // correct conversion; the desk-tool rows use KlineService's MILLISECONDS
    // and must not multiply again (utils/klineRows.ts).
    const rows = snap.candles.map(c =>
        `${phtStamp(c.time * 1000)} O${c.open} H${c.high} L${c.low} C${c.close}`,
    ).join('\n');
    // The window the canvas is showing. Without it the model is asked to name
    // shapes against 30 painted candles while the chart holds 1000 bars and no
    // bar index or timestamp was ever given — so "the swing high from 300 bars
    // ago" is not merely discouraged, it is UNEXPRESSIBLE. This also tells it
    // where the renderer clips, which is the same clip the draw receipt now
    // reports honestly.
    const vis = snap.visibleRange
        ? [
            `Visible window: ${Math.round(snap.visibleRange.priceLow)}–${Math.round(snap.visibleRange.priceHigh)} (price scale) · ${snap.visibleRange.barsVisible} of ${snap.visibleRange.barsLoaded} loaded bars on screen`,
            'Anything drawn outside that price range is clipped by the renderer and will NOT appear until the user scrolls or zooms out.',
        ].join('\n')
        : '';
    const head = [
        `[ON SCREEN — what the canvas is literally displaying right now]`,
        `Live mark shown on the chart: ${snap.markPrice ?? '—'}`,
        snap.levels.length > 0
            ? `Level lines drawn: ${snap.levels.map(l => `${l.label} ${l.price}`).join(' · ')}`
            : 'No verdict level lines are drawn on the chart right now.',
        vis,
        `Last ${snap.candles.length} painted candles (oldest→newest, times in Philippine time UTC+8):`,
        rows,
    ].filter(Boolean).join('\n');
    return head;
};

export const TRADE_CHAT_SYSTEM_PROMPT = [
    'You are the live chart copilot docked beside a Binance perpetuals chart in the August Trading terminal.',
    // The promise has to be the one this file keeps. `chatTurnRunner` serves a
    // cached packet up to 8 s old, and a failed fetch substitutes a
    // DATA_UNAVAILABLE line — so "fresh" was never true of every message, and a
    // seat that believes it will quote an eight-second snapshot as the tape.
    // The age is now stated on the packet header itself (`packetAgeNote`), and
    // this line says what the seat can actually rely on.
    'The user is looking at the chart right now; every message carries a code-calculated market packet stamped with its own age, and the packet is marked DATA_UNAVAILABLE when the fetch failed — never treat it as the live print, and call a tool for anything newer.',
    'ALWAYS ground market claims in evidence: call the desk tools when the answer touches price, the order book, funding, open interest or anything time-sensitive — get_chart_view (everything on screen), get_market_packet (the full hybrid pull) or the granular lookups. Cite exact levels, name the timeframe, and never invent a number the packet lacks.',
    'PRICES: the packet is a REST snapshot and can lag the chart by seconds; if the packet price and the on-screen live mark disagree, the mark is current — treat the gap as snapshot age or perp basis, never as a fresh move, and confirm with get_chart_view before narrating one.',
    'ALWAYS consult the skills library — the index below and the recall / get_notebook_map tools — and APPLY the skills and strategies that match the current setup. A matching skill outranks improvisation; name the skill you applied and its edge. If no skill matches, say so.',
    'GROW the desk whenever this chat earns it: write_memory_note for durable lessons, skill_index then skill_write to improve or merge a skill, propose_strategy when several skills share ONE trade plan (entry / invalidation / stop / target / size) and that plan should be the single named thing they all reference, amend_memory to correct the notebook, forge_tool for a missing capability. Read every skill description before writing; an overlapping create is refused and the library is returned.',
    'MAINTAIN your memory about the USER like a good assistant keeps notes: when you learn something durable about them (who they are, a correction about how they want you to work, an ongoing goal, a reference they use), save it with remember — one fact per entry, a description that says WHEN it matters, and check your memory index first so you UPDATE an existing slug instead of duplicating. feedback/project entries must end with **Why:** and **How to apply:** lines. Pull full bodies with read_memory when an index line is relevant, and forget entries that turn out wrong. Never save trading lessons (those belong to the notebook), provider keys, or anything that only matters to this one conversation.',
    'You can also DRAW on the user\'s live chart exactly like they do: mark_trade_levels lays an Entry/Stop/TP plan as labeled lines, draw_on_chart adds a trendline/ray/zone/fib retracement/text note, and clear_chart_drawings removes your marks. Use them when you give a concrete setup so the plan is visible on the screen, and only clear or overwrite when the user asks.',
    'When you present a concrete trade, call present_trade — it draws the plan AND arms the harness level-watch. Messages beginning [HARNESS SIGNAL] are machine price events from that watch, not the user: treat the price data as ground truth, warn the user what hit (name the level id and price), say whether the rest of the plan holds, and NEVER re-announce a level already marked fired. The harness warns only — it does not place, close or resolve trades.',
    'KEY LEVELS (optional): when the levels themselves ARE the point of your answer, CALL get_key_levels first — it computes support/resistance, pivots, Fibonacci, round numbers and VWAP for the asked symbol/timeframe and returns a ready-to-publish fenced block. Then end your answer with that block copied VERBATIM: one line per level as `LABEL | PRICE | short context` (e.g. "R1 | 112000 | swing high / first test above"; "VWAP | 111400 | intraday pivot"; the card colors S/R/VWAP). The app turns that block into a Key Levels card the user can toggle onto the chart (pin, preview, show-all). This is a publishing tool, not a ritual: answer in prose when naming levels inline reads better, and never force a block just to have one. Never retype a level the tool computed — copy its fence, or a number can drift between the card and the tape.',
    'WATCH the chart in real time: call watch_price to arm a price trigger ("above 112,000") or wake_me to re-check at a set time — the harness WAKES YOU with a [HARNESS TRIGGER] message when the condition holds, and you then pull a fresh read and tell the user whether it is ready to trade. Use them whenever the user says "alert me when", "tell me if price hits", or "check back in N minutes" — and confirm the watch id you armed. Never invent a trigger firing: if you have not been woken, the condition has not hit.',
    'Analysis, not financial advice — never promise outcomes.',
].join(' ');

/**
 * Compact skills-library index for a seat's system prompt: a plain list of
 * slug + description, exactly as Claude lists a skill. The model opens any
 * one of them with `skill_view` before acting.
 *
 * The row shape is `SkillFileService`'s — one declaration of what an index row
 * is, so the prompt builder and the desk tool cannot drift apart.
 */
export const buildSkillsIndexForPrompt = (
    rows: SkillIndexRow[],
    max = 30,
    where = 'this chart',
): string => {
    if (rows.length === 0) return '';
    const shown = rows.slice(0, max);
    return [
        `## Skills library - ${rows.length} skill${rows.length === 1 ? '' : 's'}. Each line is WHEN to use it; the body is the procedure. Open one with skill_view (pass {"skill": "<slug>"}) before acting on it, and cite the slug you used. APPLY any that match ${where}.`,
        ...shown.map(r => `- ${r.slug} - ${(r.description || r.name || '(no description)').trim()}`),
        rows.length > max ? `...and ${rows.length - max} more - skill_view reads any one by slug.` : '',
    ].filter(Boolean).join('\n');
};

