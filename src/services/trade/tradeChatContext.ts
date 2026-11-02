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
import { TENTATIVE_SKILL_INJECTION_MAX } from '../../constants/skillInjection';

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

export const buildTradeChatContext = ({ symbol, interval, packetMarkdown, fetchedAtMs, drawingsDescription, onScreenDescription, plansDescription, liveMarkPrice, formingCandle, contextWindowTokens, nowMs }: TradeChatContextInput): string => {
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
        (drawingsDescription || '').trim(),
        'If you need data newer than this packet, CALL THE DESK TOOLS — get_chart_view (everything on screen: candles, timeframe, live mark, verdict levels, order book and the user\'s own drawings), get_all_timeframes (every timeframe at once: candles, structure, formations per TF + book/spread/funding/OI/liquidations), get_market_packet (the full hybrid pull: every timeframe, indicators, funding, OI, book walls, liquidations, session), scan_setups (the strategy-book scanner: live breakouts, pin bars, inside-bar resolutions, gaps, divergences, band plays, pullbacks and failed breaks with evidence + matching skills), or the granular ones (get_price_snapshot, get_order_book, get_liquidations, get_session_context) — never invent a number the packet lacks.',
        'You can also GROW with this desk: write_memory_note saves a durable lesson straight into the trader notebook, get_notebook_map shows what you already know before you write, propose_skill / revise_skill / amend_memory / forge_tool write directly — skill writes are CANDIDATES, and evidence (not a human approval) changes their status. Propose them when this session taught you something that will matter on the next chart. When the user asks you to LEARN THIS CHART, scan_chart_skills studies EVERY candle — the hour-by-hour movement table in PHT, the ≥10% up/down swing legs with the state that preceded them, regimes, gaps, and every book detector with historical win-rates — and creates pattern-first candidates directly; it is slow, so call it at most once per turn. And you can DRAW on this chart like the user does: mark_trade_levels lays an Entry/Stop/TP plan as labeled lines, draw_on_chart adds a trendline/ray/zone/fib/text, get_all_timeframes pulls every timeframe plus the book at once. The drawings block stamps when each shape was drawn and how far the mark has moved since — honour a "POSSIBLY STALE" flag by re-checking the level before you lean on it.',
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
    // sees, never UTC to convert.
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
    'GROW the desk whenever this chat earns it: write_memory_note for durable lessons, revise_skill to improve an existing skill, propose_skill for a new rule, propose_strategy when several skills share ONE trade plan (entry / invalidation / stop / target / size) and that plan should be the single named thing they all reference, amend_memory to correct the notebook, forge_tool for a missing capability. Proposals wait for human approval — label them clearly.',
    'MAINTAIN your memory about the USER like a good assistant keeps notes: when you learn something durable about them (who they are, a correction about how they want you to work, an ongoing goal, a reference they use), save it with remember — one fact per entry, a description that says WHEN it matters, and check your memory index first so you UPDATE an existing slug instead of duplicating. feedback/project entries must end with **Why:** and **How to apply:** lines. Pull full bodies with read_memory when an index line is relevant, and forget entries that turn out wrong. Never save trading lessons (those belong to the notebook), provider keys, or anything that only matters to this one conversation.',
    'You can also DRAW on the user\'s live chart exactly like they do: mark_trade_levels lays an Entry/Stop/TP plan as labeled lines, draw_on_chart adds a trendline/ray/zone/fib retracement/text note, and clear_chart_drawings removes your marks. Use them when you give a concrete setup so the plan is visible on the screen, and only clear or overwrite when the user asks.',
    'When you present a concrete trade, call present_trade — it draws the plan AND arms the harness level-watch. Messages beginning [HARNESS SIGNAL] are machine price events from that watch, not the user: treat the price data as ground truth, warn the user what hit (name the level id and price), say whether the rest of the plan holds, and NEVER re-announce a level already marked fired. The harness warns only — it does not place, close or resolve trades.',
    'KEY LEVELS (optional): when the levels themselves ARE the point of your answer, CALL get_key_levels first — it computes support/resistance, pivots, Fibonacci, round numbers and VWAP for the asked symbol/timeframe and returns a ready-to-publish fenced block. Then end your answer with that block copied VERBATIM: one line per level as `LABEL | PRICE | short context` (e.g. "R1 | 112000 | swing high / first test above"; "VWAP | 111400 | intraday pivot"; the card colors S/R/VWAP). The app turns that block into a Key Levels card the user can toggle onto the chart (pin, preview, show-all). This is a publishing tool, not a ritual: answer in prose when naming levels inline reads better, and never force a block just to have one. Never retype a level the tool computed — copy its fence, or a number can drift between the card and the tape.',
    'WATCH the chart in real time: call watch_price to arm a price trigger ("above 112,000") or wake_me to re-check at a set time — the harness WAKES YOU with a [HARNESS TRIGGER] message when the condition holds, and you then pull a fresh read and tell the user whether it is ready to trade. Use them whenever the user says "alert me when", "tell me if price hits", or "check back in N minutes" — and confirm the watch id you armed. Never invent a trigger firing: if you have not been woken, the condition has not hit.',
    'Analysis, not financial advice — never promise outcomes.',
].join(' ');

/** One row of the skills index the panel injects into the system prompt. */
export interface SkillIndexRow {
    slug: string;
    status?: string;
    kind?: string;
    /** What the skill is + when it applies — the activation key. Per the
     *  Agent-Skills guidance, a specific "what + when" line is what lets the
     *  model decide to USE a skill. */
    description?: string;
    /** The skill's one trigger sentence (its own `when`). */
    when?: string;
    /** Which seat may see this skill — mirrors `SkillMeta.audience`. The
     *  retrieval filters on it (`MemoryRetrievalService.rankedMatchedSkills`);
     *  the index did not, so a moderator-only rule could be named to an
     *  analyst seat. */
    audience?: string;
    /** Human-invoked only: background knowledge the trader reads with `/slug`.
     *  It is NEVER handed to a seat on its own, so it must not be named in a
     *  catalogue the seat is told to apply from. */
    manualOnly?: boolean;
    /** The idle lifecycle suspended it — it stops being injected. */
    suspended?: boolean;
    /** The trader switched it off. */
    disabled?: boolean;
    /** The approval fact the injection path already gates on (`isApprovedSkill`).
     *  Absent = keep (a caller that did not pass it); the one projection both
     *  surfaces now use always sets it. Without it the index NAMED an
     *  unapproved rule to a seat that would never be handed it. */
    approved?: boolean;
    /** ISO timestamp of the last counted trade — the tie-break. */
    lastEvidenceAt?: string;
    /** Earned from tracked outcomes but not yet confirmed by a human or the
     *  evidence ladder. It may be injected as labelled CONTEXT; it never
     *  vetoes or caps confidence. */
    tentative?: boolean;
}

/**
 * The seats the index can be written for. The retrieval path uses the same
 * two audiences, and `audience: analyst` hides a skill from a moderator's
 * assembly while `audience: moderator` hides it from an analyst's.
 */
export type SkillIndexAudience = 'analyst' | 'moderator';

/**
 * A skill earns an index slot only if it can ACTUALLY be applied.
 *
 * The index is not a catalogue of everything in the notebook — it is the
 * list the prompt tells the seat to APPLY from ("APPLY any that match … and
 * pull its full body with recall"). So it must carry the same gate the
 * injection path carries, or the index offers a rule the harness would never
 * honour:
 *
 *  · retired    — `SkillStatus` says the trader retired it.
 *  · suspended  — the idle lifecycle stopped injecting it (it can earn its
 *                 way back; it is not dead, but it is not live either).
 *  · disabled   — the trader switched it off.
 *  · manualOnly — human-invoked only: never handed to a seat on its own.
 *  · audience   — a rule scoped to the OTHER kind of seat.
 *  · approved   — no human yes (and not the vetted starter shelf): the
 *                 injection path refuses it, so the index must not name it.
 *
 * A row that carries none of these facts (a caller that did not pass them)
 * is KEPT — the filter must never remove a skill because the caller was
 * quiet about it.
 */
export const isIndexableSkill = (row: SkillIndexRow, audience: SkillIndexAudience = 'analyst'): boolean => {
    if (row.status === 'retired') return false;
    if (row.suspended === true) return false;
    if (row.disabled === true) return false;
    if (row.manualOnly === true) return false;
    // A tentative row has no human approval yet; it is allowed into the index
    // as labelled context. An unapproved row that is NOT tentative stays out.
    if (row.approved === false && row.tentative !== true) return false;
    const scope = (row.audience || 'all').toLowerCase();
    if (scope !== 'all' && scope !== audience) return false;
    return true;
};

/** A skill the seat cannot apply without a trigger is a name, not a rule. */
const hasUsableTrigger = (row: SkillIndexRow): boolean =>
    Boolean((row.description || '').trim() || (row.when || '').trim());

/** confirmed before candidate; anything else (an old status word) last. */
const statusRank = (status?: string): number => {
    if (status === 'confirmed') return 0;
    if (status === 'candidate') return 1;
    return 2;
};

/**
 * The order the index is written in, BEFORE the window is cut.
 *
 * The window is 30 slots. Filling it in notebook file order meant a retired
 * rule and an unproven candidate occupied a slot exactly like a confirmed
 * one, so repairing the library did not guarantee the model ever saw the
 * repaired skill — and the index is the only place a skill is ever NAMED to
 * the model.
 *
 * The order is: a usable trigger first (a name with no rule cannot be
 * applied), then `confirmed` before `candidate`, then the most recently
 * evidenced first. Ties keep the caller's order — the sort is stable, so a
 * library that is equal on every axis reads in the order it was given, and
 * nothing is reshuffled for tidiness.
 */
export const compareSkillIndexRows = (a: SkillIndexRow, b: SkillIndexRow): number => {
    const trigger = Number(hasUsableTrigger(b)) - Number(hasUsableTrigger(a));
    if (trigger !== 0) return trigger;
    const status = statusRank(a.status) - statusRank(b.status);
    if (status !== 0) return status;
    const aAt = a.lastEvidenceAt ? Date.parse(a.lastEvidenceAt) : NaN;
    const bAt = b.lastEvidenceAt ? Date.parse(b.lastEvidenceAt) : NaN;
    const aHas = Number.isFinite(aAt);
    const bHas = Number.isFinite(bAt);
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && aAt !== bAt) return bAt - aAt;
    return 0;
};

/**
 * The rows the index may offer, in the order it offers them.
 *
 * Filtered by the same gate the injection path uses, then ranked. Exported so
 * a caller that also records WHICH skills it named (the row's `injectedSkills`
 * list) uses the SAME list the prompt carried — a row that claims a skill the
 * prompt never named is worse than a silent row.
 */
export const rankSkillIndexRows = (
    rows: SkillIndexRow[],
    audience: SkillIndexAudience = 'analyst',
): SkillIndexRow[] => rows
    .filter(r => isIndexableSkill(r, audience))
    .sort(compareSkillIndexRows);

/**
 * Compact skills-library index for the chat system prompt: the model must
 * reach for existing skills and strategies BEFORE free-styling, so it needs
 * to know what exists AND when each one applies. Pure — the panel loads the
 * library and passes rows in (kept out of this module so the prompt builder
 * stays network-free). Each line leads with the activation description
 * (what/when), then the skill's trigger sentence.
 */
/** The library index a seat reads. `where` names the thing a skill must match:
 *  the dock looks at a chart, the Agents surface looks at nothing, and a heading
 *  that says "match this chart" on a surface with no chart is a lie the model
 *  can only answer by inventing one. */
export const buildSkillsIndexForPrompt = (
    rows: SkillIndexRow[],
    max = 30,
    where = 'this chart',
    audience: SkillIndexAudience = 'analyst',
): string => {
    if (rows.length === 0) return '';
    // Ranked and filtered BEFORE the window is cut — see rankSkillIndexRows.
    const eligible = rankSkillIndexRows(rows, audience);
    if (eligible.length === 0) return '';
    // A candidate is a HYPOTHESIS, not a rule: it is not listed under APPLY,
    // it is never counted as a skill the seat may use, and it costs one line
    // (a count) instead of a slot. Only the evidence fold promotes a skill to
    // confirmed; until then the model must not be told to apply it.
    const confirmed = eligible.filter(r => r.status === 'confirmed');
    const tentative = eligible.filter(r => r.tentative === true && r.status !== 'confirmed');
    const candidates = eligible.filter(r => r.tentative !== true && r.status !== 'confirmed');
    const shown = confirmed.slice(0, max);
    const lines = shown.map(r => {
        const rule = r.when ? `When ${r.when}` : '';
        const desc = (r.description || '').trim();
        const kindTag = r.kind ? `${r.kind === 'avoid' ? 'avoid' : 'repeat'} · ` : '';
        return `- ${r.slug} — ${kindTag}${desc || rule || '(see recall)'}${desc && rule ? ` · ${rule}` : ''}`;
    });
    const candidateCount = candidates.length;
    const tentativeShown = tentative.slice(0, TENTATIVE_SKILL_INJECTION_MAX);
    const tentativeLines = tentativeShown.map(r => {
        const rule = r.when ? `When ${r.when}` : '';
        const desc = (r.description || '').trim();
        const kindTag = r.kind ? `${r.kind === 'avoid' ? 'avoid' : 'repeat'} · ` : '';
        return `- ${r.slug} — TENTATIVE · ${kindTag}${desc || rule || '(see recall)'}${desc && rule ? ` · ${rule}` : ''}`;
    });
    const header = confirmed.length > 0
        ? `## Skills library — ${confirmed.length} confirmed skill${confirmed.length === 1 ? '' : 's'}. Each line is WHEN to use it; the body is the procedure. APPLY any that match ${where} before answering; cite the slug you used, and open the full body with skill_view before acting on it.`
        : `## Skills library — no confirmed skills.${candidateCount > 0 ? ` ${candidateCount} candidate hypothes${candidateCount === 1 ? 'is exists' : 'es exist'} (unproven; NOT rules and NOT applied).` : ''}`;
    return [
        header,
        ...lines,
        // The honest count: what this seat may use, minus what it was shown.
        // Skills that were filtered out (retired, dormant, manual-only, another
        // seat's) are not counted — they are not this seat's to pull.
        confirmed.length > max ? `…and ${confirmed.length - max} more confirmed — skill_view reads any one of them by slug.` : '',
        confirmed.length > 0 && candidateCount > 0
            ? `- ${candidateCount} candidate hypothes${candidateCount === 1 ? 'is' : 'es'} (unproven; not rules, not applied — inspect with get_notebook_map or recall only if the question needs one).`
            : '',
        tentative.length > 0
            ? [
                `## Tentative skills — ${tentative.length} learned from tracked outcomes. CONTEXT ONLY: use them to inform the read; never as a rule, a veto or a confidence cap. The trader can edit or disable any.`,
                ...tentativeLines,
                tentative.length > tentativeShown.length
                    ? `…and ${tentative.length - tentativeShown.length} more tentative — not listed here.`
                    : '',
            ].filter(Boolean).join('\n')
            : '',
    ].filter(Boolean).join('\n');
};
