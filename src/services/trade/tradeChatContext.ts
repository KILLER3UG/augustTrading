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
import { getActiveUsername } from '../../utils/activeUser';
import { formatSessionPlanContextSummary } from './sessionPlan';
import { formatActiveRulesContextSummary } from '../learning/candidateRuleLoop';
import { formatTier0ChartManifest, type Tier0ManifestInput } from './chartGeometry';
import { REASONING_CHANNEL_PROMPT } from '../../constants/prompts/chatPrompts';

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
    /** Journal row count, used to expire learned rules by trade count. */
    currentTradeCount?: number;
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

export const buildTradeChatContext = ({ symbol, interval, packetMarkdown, fetchedAtMs, drawingsDescription, onScreenDescription, plansDescription, postMortemBrief, liveMarkPrice, formingCandle, contextWindowTokens, currentTradeCount, nowMs }: TradeChatContextInput): string => {
    const when = phtFullStamp(fetchedAtMs);
    // The trader's confirmed session plan and learned rules ride EVERY turn.
    // Both formatters return '' when there is nothing in force, so the context
    // stays quiet for a trader who has not confirmed either kind of card.
    const sessionPlanBlock = formatSessionPlanContextSummary();
    const activeRulesBlock = formatActiveRulesContextSummary(getActiveUsername(), currentTradeCount ?? 0, nowMs ?? Date.now());
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
        sessionPlanBlock,
        activeRulesBlock,
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

/**
 * High-signal, prompt-cache-safe Tier 0 chart manifest injected inside the
 * latest user turn wrapper (never in the static system prompt). Carries
 * `chartRevision`, `liveMark`, forming & last closed OHLC, `atr14`, active
 * study values, evaluated User vs AI `#D1..#Dn` drawings, armed plans,
 * session plan, active rules, and any mid-session skill/memory delta note.
 */
export const TRADER_QUESTION_MARKER = '---\nTrader question:\n';

/**
 * Assemble the user-role turn payload so attached chart context, files, and
 * panel room transcripts always sit ABOVE the trader's actual question at the
 * very end. Keeps fast/preview models focused on answering the question rather
 * than continuing or echoing trailing context blocks.
 */
export const composeUserTurnMessage = (input: {
    contextBlock?: string;
    fileBlocks?: string;
    extraContext?: string;
    traderQuestion: string;
}): string => {
    const contextParts = [
        (input.contextBlock ?? '').trim(),
        (input.fileBlocks ?? '').trim(),
        (input.extraContext ?? '').trim(),
    ].filter(Boolean);
    const question = (input.traderQuestion ?? '').trim();
    if (contextParts.length === 0) return question;
    if (!question) return contextParts.join('\n\n');
    return `${contextParts.join('\n\n')}\n\n${TRADER_QUESTION_MARKER}${question}`;
};

/**
 * Extract only the trader's raw question from a wrapped user turn message so
 * hint matchers and guards never match against `[CHART MANIFEST]` boilerplate.
 */
export const extractTraderQuestion = (content: string): string => {
    if (typeof content !== 'string' || !content) return '';
    const idx = content.lastIndexOf(TRADER_QUESTION_MARKER);
    if (idx !== -1) return content.slice(idx + TRADER_QUESTION_MARKER.length).trim();
    return content.trim();
};

export const buildTier0UserTurnContext = (
    input: Omit<Tier0ManifestInput, 'sessionPlanBlock' | 'activeRulesBlock'> & { currentTradeCount?: number },
): string => {
    const now = input.nowMs ?? Date.now();
    const sessionPlanBlock = formatSessionPlanContextSummary();
    const activeRulesBlock = formatActiveRulesContextSummary(getActiveUsername(), input.currentTradeCount ?? 0, now);
    return formatTier0ChartManifest({
        ...input,
        sessionPlanBlock,
        activeRulesBlock,
        nowMs: now,
    });
};

/**
 * The system prompt, in FOUR layers (clean-prompt ruling):
 *   (1) IDENTITY & DESK ROLE — what this is and how the trader works with it.
 *   (2) HARD RULES — the 6 non-negotiables; everything else is guidance.
 *   (3) VERIFICATION WORKFLOW — how a claim earns its way into an answer.
 *   (4) TOOL DISPATCH & OUTPUT FORMATS — one line per tool plus the wire
 *       formats (Key Levels fence, memory entry shape) the app parses.
 *
 * Rules ALREADY enforced in code live here only as one-line reminders — the
 * refusal gates (seat allow-list, memory-off, skill pen, provenance, session
 * guard, R:R floor) run in the executor regardless of what the prompt says.
 * The Risk Constitution rides the frozen prefix SEPARATELY (user-authored,
 * length-capped — see systemPromptFor), never inside this constant.
 */
export const TRADE_CHAT_SYSTEM_PROMPT = [
    'IDENTITY: live chart copilot beside a perpetuals chart (Claude Code for trading). Read each turn\'s Tier 0 manifest (revision, mark, candles, ATR14, studies, #D1..#Dn, armed plans); analysis, never financial advice.',
    REASONING_CHANNEL_PROMPT,
    'DISCIPLINE & VOICE:',
    '- Grounded numbers only: cite the tool, price, and timeframe; live mark overrides REST packet gaps.',
    '- Edge first: default Wait/NO_TRADE on thin confluence, chop, net R:R below minEdgeR, or stale feeds. For user drawings (#D1..#Dn), give the strongest counter-thesis before endorsing. Never alter user drawings unasked.',
    '- Response order (Beginner-Clear, Pro-Rigorous): 1) Plain-English Verdict first (Wait / Long / Short + 1-2 clear sentences anyone can follow); 2) What breaks the idea (exact Invalidation price/structure plotted on the chart); 3) Harness-verified numbers (Entry · Invalidation · Targets · Net R:R · Risk $ · Size · Liq buffer). Skip raw indicator dumps unless asked. If the trader is brainstorming or asks for simple explanations, stay advisory and jargon-light.',
    '- [HARNESS SIGNAL]/[HARNESS TRIGGER] rows are machine events: name the fired level id/price and whether the plan still holds.',
    '- Canonical tools & growth: verify brackets with `trade_math`; call `present_trade` for concrete setups or `decline_trade` for intentional skips; plot levels with `mark_trade_levels`, `draw_on_chart`, or `draw_tool_levels`; arm alerts with `watch_price`; copy `get_key_levels` fenced blocks verbatim when asked for levels; scan watchlists with `scan_confluence`; open matching skills with `skill_view` before acting; curate `USER.md`/`MEMORY.md` with `memory`, durable trader facts with `memory_add`, history via `session_search`, and playbooks via `skill_manage` (or `skill_index`). Never save API keys/secrets, transient market prices, or your own advice. Code enforces risk caps, duplicate scans, and Plan Mode.',
].join(' ');

/** The rows a prompt may carry. ONE definition, in `SkillFileService`, next to
 *  `skillIndexRows` — the prompt block, the turn's `injectedSkills` record,
 *  and every model-facing pointer (recall, scan_setups, memory hints) filter
 *  through it, so a record cannot name a skill the model was not shown and a
 *  pointer cannot point at a note. Re-exported here for the prompt layer. */
export { usableSkillRows } from '../learning/SkillFileService';
import { usableSkillRows } from '../learning/SkillFileService';

/**
 * Compact skills-library index for a seat's system prompt. The ONE canonical
 * renderer lives in `SkillFileService` (next to the rows it renders); this
 * re-export keeps the name every existing consumer already imports.
 */
export { buildSkillsIndexForPrompt } from '../learning/SkillFileService';

