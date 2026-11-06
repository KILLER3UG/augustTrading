/**
 * chatTurnRunner — the Chart AI dock's chat orchestrator, extracted from
 * TradeChatPanel. Every function here is the service-shaped core of the
 * dock: it never touches JSX and reads/writes the conversation entirely
 * through the module store (chatStore) plus the deps object the shell hands
 * in — `createChatTurnRunner(deps)`.
 *
 * What lives here:
 * - `executePanelTool` — the desk-tool surface that touches the LIVE canvas
 *   (drawings, trade plans, the watch/schedule harness).
 * - `buildContextBlock` — the fresh market packet + on-screen + plans block
 *   every message rides (short-TTL cached per symbol).
 * - `runSeatTurn` — streams ONE seat's turn into its store entry.
 * - `maybeReviewSessions` — the fire-and-forget learning hooks after a send.
 * - `send` — the solo/panel turn orchestrator (also the RETRY path).
 * - `runFullAnalysis` — the ensemble pipeline launched from the dock.
 * - `runHarnessTurn` — one queued harness signal as a model turn.
 *
 * The panel shell keeps the session-store subscription, the UI state
 * (pickers, menus, drag), the header, the transcript render and the
 * composer. It rebuilds the runner with useMemo over the deps entries —
 * the same set `send`'s former dep array listed, with `effort`, `symbol`
 * and `interval` now explicit instead of arriving only transitively
 * through the intermediate useCallbacks.
 */

import type { LoggedTrade } from '../../types';
import type { Message } from '../../types/message';
import type { ProviderConfig } from '../../types/provider';
import type { ChatMessage, ContentPart } from '../providers/GenericProviderService';
import type { DeskToolCall, DeskToolResult } from '../analysis/DeskToolsService';
import { fetchHybridData, generateHybridPromptInjection } from '../analysis/HybridIntelligenceService';
import { DESK_TOOL_NAMES } from '../../utils/toolKinds';
import { settleDockEntry } from '../../utils/rowSettlement';
import { CHART_ACTION_TOOL_DEFS } from '../analysis/DeskToolsService';
import { focusedGoal } from '../goals/GoalService';
import { buildTradeChatContext, describeChartSnapshotForModel } from './tradeChatContext';
import {
    describeDrawingsForModel, drawingFromChartTool, drawingsFromDetectedPattern, drawingsFromLevelTool, type ChartDrawing,
    MODEL_COLOR_NAMES, createDrawingId,
} from './chartDrawings';
// Type-only: erased at build, so the market-tool module stays lazy even
// though the drawer names its anchor unions in two casts.
import type { ProfileAnchor, VwapAnchor } from '../analysis/marketTools';
import { runPresentTrade } from './presentTradeTool';
import { runToolTurn, type ToolTurnEvents, type ToolTurnRequest } from './toolTurn';
import { scoreDrawnLevel, levelAccuracy, describeLevelAccuracyForModel } from './tradePlanLevels';
import * as levelWatch from './levelWatchService';
import { describePlanForModel, type WatchPlan } from './tradePlanLevels';

import { recordBotTurnOutcome } from '../agents/botLearning';
import * as watchService from './watchService';
import { parsePriceWatch, parseTimeWake, describeWatchesForModel } from './chartTriggers';
import { phtClock } from '../../utils/timezone';
import { truncationNotice, withTruncationWindow } from '../../utils/finishReason';
import { sanitizeErrorText } from '../../utils/runStatus';
import { ensureNotifyPermission } from '../infrastructure/notify';
import { runTraderLearner } from '../learning/traderLearner';
import { getActiveUsername } from '../../utils/activeUser';
import { baseOf, quoteOf } from '../../utils/symbol';
import { isPassReply } from '../agents/groupRounds';
import {
    titleFromMessage, entriesForSession, PANEL_MAX_MODELS,
} from './chatSessions';
import { saveToolPayload } from './toolPayloadStore';
import * as chatStore from './chatStore';
import type { LiveEntry, LiveSession } from './chatStore';
import { startEntryMirror, type SoloTurnRow } from './chatTurnMirror';
import {
    panelSeats, planPanelTurn, formatRoomTranscript, parsePanelMentions, panelCouldStillBePass,
} from './chatPanel';
import { createPanelMailbox, formatDmEventLine } from '../analysis/PanelMailbox';
import type { ChartSnapshot } from '../../components/trade/TradingChart';
import { intervalSeconds } from '../../utils/chartIntervals';
import type { AgentBot } from '../agents/agentRoster';
import { formatModelDisplayName } from '../../utils/providerUtils';
import { isVisionModel } from '../../utils/modelUtils';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { resolveComposerEffort, type ReasoningEffort } from '../providers/reasoningControls';
import type { Attachment } from '../../hooks/useChatAttachments';
import { recordToolTurnUsage } from '../../utils/sessionUsage';

/** Identity of a RUNNING model turn, captured the moment it starts. Every
 *  side-effect of a panel tool (proposal card attach, drawing persistence,
 *  level-watch arming) must resolve WHO IT BELONGS TO from this object —
 *  never from the panel's render-snapshot view state (`activeId`, or a
 *  shared "current entry" ref). A harness turn or a background session's
 *  turn keeps running while the user switches sessions/symbols; keying its
 *  output off the VIEWED session made proposals and drawings land in the
 *  wrong transcript (deep-dive 2026-09-15, per-turn identity class).
 *  Re-exported by TradeChatPanel so the canvas owner (TradeView) can
 *  persist against it too. */
export interface PanelTurnContext {
    /** The session the turn runs in. */
    sid: string;
    /** The streaming AI entry the turn writes into. */
    entryId: string;
    /** The chart the turn started under. */
    symbol: string;
    interval: string;
}

/** The dock seat's tool allow-list — the desk set PLUS the seven chart actions.
 *
 *  Naming them here is not a widening, it is what makes the offer work at all.
 *  `DeskToolsService` lists a chart-action definition only when the caller owns
 *  a live canvas AND `seatAllows(allowedTools, name)` names it, and a NON-EMPTY
 *  list is by definition a restricted one. So a list that omits them empties the
 *  chart set at that filter, and the widening step two lines later — which adds
 *  `extraDefs` back to the allow-list — has nothing left to add: the two rules
 *  cancelled each other out. This is the dock, the one home whose executor
 *  actually dispatches these calls (`executePanelTool` below, and the canvas it
 *  draws on is on screen), so the omission was the whole reason a seat answering
 *  over a live chart could tell the trader there was no canvas to draw on.
 *
 *  A focused goal still narrows this: `intersectGoalPolicy` runs against the full
 *  name list, and a goal may remove tools but never add one. */
const TRADE_TOOLS: string[] = [
    ...DESK_TOOL_NAMES,
    ...CHART_ACTION_TOOL_DEFS.map(d => d.function.name),
];

/** An image the composer attached to this turn, in the shape the runner needs. */
type ScreenshotAttachment = { kind: string; payload: string };

/**
 * Attach a screenshot to a turn — or say plainly that this seat cannot see it.
 *
 * This lives in ONE place because the two callers used to disagree, and the
 * disagreement was invisible from the outside. The solo path built a real
 * `image_url` part. The panel path built a plain string and dropped the
 * attachment entirely, while offering the user the same camera button. So in a
 * multi-seat panel — the app's headline mode — the user clicked the camera,
 * saw the screenshot in their own bubble, and every seat answered blind. No
 * error, no notice, and every measurement you would naturally take (button
 * enabled, bubble renders, model replies) is identical across both states.
 *
 * The fallback is not decoration either: a seat that cannot see images must
 * be told, or it invents a confident read of a chart it never received. A
 * panel can mix vision and text-only seats, so this is decided PER SEAT.
 */
export const userContentWithImage = (
    text: string,
    attachment: ScreenshotAttachment | undefined,
    selectedModel: string,
): string | ContentPart[] => {
    if (!attachment) return text;
    if (isVisionModel(selectedModel)) {
        return [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: attachment.payload } },
        ];
    }
    return `${text}\n\n[The user attached a chart screenshot but this model cannot see images.]`;
};

/** Cap on attached text file bulk handed to the prompt. */
const MAX_FILE_CHARS = 200_000;

/** Short-TTL cache of the slow hybrid-packet pull, keyed by symbol — lets a
 *  rapid follow-up question start the model without re-fetching. The market
 *  moves, so the window is deliberately tight. */
const PACKET_CACHE_MS = 8_000;
const packetCache = new Map<string, { markdown: string; atMs: number }>();
/** Test hook: drop cached packets so a test can observe the fetch path. */
export const __clearPacketCacheForTests = (): void => packetCache.clear();

const newId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** How long the answering work took, frozen at settle. `start` is the epoch-ms the
 *  turn began; the caller passes the timestamp captured when the entry was created,
 *  so every settle path in one turn reports the SAME duration instead of each
 *  measuring from its own `Date.now()`. Returns undefined when no start is known —
 *  the renderer then shows no duration rather than a wrong one. */
const workedMsFor = (start: number | null | undefined): number | undefined =>
    typeof start === 'number' && Number.isFinite(start) ? Math.max(0, Date.now() - start) : undefined;

/** The epoch-ms an entry was created, read back out of the live store. Used to
 *  anchor one turn's duration to when its bubble was painted rather than to each
 *  settle path's own `Date.now()`. */
const entryAtRef = (sid: string, entryId: string): number | undefined => {
    const found = chatStore.getSnapshot().sessions.find(s => s.id === sid)?.entries.find(e => e.id === entryId);
    return found?.at;
};

/** Everything the orchestrator needs from the panel shell, stated once.
 *  chatStore is imported directly (the module store — turn state is read
 *  FRESH at call time so a double-send inside one React tick still sees the
 *  run slot); React state setters, prop-driven config getters and the
 *  resolved provider objects ride in here. The shell rebuilds the runner
 *  with useMemo over exactly these entries. */
export interface ChatTurnRunnerDeps {
    /** The chart the panel is mounted under — stamped onto every turn
     *  context and every session write. */
    symbol: string;
    interval: string;
    /** The Settings memory switch: false makes the tool stream skip the
     *  pre-read hints and the executor refuse memory reads/writes. */
    memoryEnabled?: boolean;
    /** The composer's thinking-effort choice (per-session shell state). */
    effort: ReasoningEffort | 'auto';
    /** The solo model selection — stamped onto the session on send. */
    selectedChatModel: string;
    /** Levels currently drawn on the chart, forwarded to the desk tools. */
    chartLevels?: { label: string; price: number }[];
    /** The user's own drawings PLUS the model's marks — what the model reads. */
    allDrawings: ChartDrawing[];
    /** The user's logged trades (desk-tool recall + learning hooks). */
    trades: LoggedTrade[];
    /** Plain-data snapshot of everything the canvas currently displays. */
    getChartSnapshot?: () => ChartSnapshot | null;
    /** The fallback provider (the composer's resolved selection). */
    provider: ProviderConfig | null;
    /** Resolve a `${providerId}:${modelId}` seat to a runnable config. */
    configForSeat: (providerId: string, modelId: string) => ProviderConfig | null;
    /** The system prompt every seat of this session answers under. */
    systemPromptFor: (bot?: AgentBot, roleNote?: string) => string;
    /** Roster bots (solo persona + panel agent seats). */
    bots: AgentBot[];
    /** The ACTIVE session id (runFullAnalysis reads it from the render —
     *  send and runHarnessTurn read the store fresh instead). */
    activeId: string;
    /** The composer draft — runFullAnalysis sends and clears it. */
    draft: string;
    /** The shell's render-snapshot sessions — the learning-hook review scan
     *  reads it (the turns themselves read the store FRESH instead). */
    sessions: LiveSession[];
    /** The canonical bot conversation rows (App's `messages`), LIVE. The bot
     *  answers from them through `entriesForSession` — the same merge the dock's
     *  render calls, imported rather than injected so there is no second copy
     *  to drift and no prop a future caller can forget to pass. */
    botThreadRows?: Message[];
    /** The Agents surface's thread, for a session bound by `conversationId`. Same
     *  reason as `botThreadRows`: the bot must answer from the conversation the
     *  trader is looking at, not from a copy. */
    conversationRows?: Message[];
    /** Composer attachment tray (read at send, cleared after). */
    attachments: Attachment[];
    /** Attached images as the analysis pipeline takes them. */
    attachedImages: () => Array<{ name: string; dataURL: string }>;
    clearAttachments: () => void;
    setDraft: (value: string) => void;
    /** Last packet fetch stamp (the composer's ctx badge). */
    setContextAt: (atMs: number) => void;
    /** Desk-tool drawing surface (draw_on_chart / mark_trade_levels). */
    addModelDrawings?: (drawings: ChartDrawing[], turn?: PanelTurnContext) => void;
    /** Clear only the model's own shapes (clear_chart_drawings scope=model). */
    clearModelDrawings?: (turn?: PanelTurnContext) => void;
    /** Clear model + user shapes (scope=all — only on the user's request). */
    clearAllDrawings?: (turn?: PanelTurnContext) => void;
    /** Report a presented plan to the harness level-watch (TradeView arms
     *  it; a later price touch comes back as a [HARNESS SIGNAL] turn). */
    onPlanPresented?: (plan: WatchPlan, turn?: PanelTurnContext) => void;
    /** Commit a bot turn asked HERE into the canonical conversation. */
    onBotTurnCommit?: (bot: AgentBot, prompt: string, answer?: string, workedMs?: number, effort?: ReasoningEffort) => void;
    /** Commit a SOLO (desk) turn asked HERE into the conversation this session is
     *  bound to — under the entry's OWN id.
     *
     *  The id is the whole contract. `entriesForSession` keys its merge by id, so
     *  a committed row that reuses the entry id is ONE row seen from two homes,
     *  while a fresh id would append a second bubble to the very pane that just
     *  wrote it. `commitDockBotTurn` mints ids because a bot turn has no local
     *  row to match; a solo turn does.
     *
     *  Without this the merge is one-way: the pane reads the conversation but a
     *  question asked in it never lands there, so flipping the pill back made the
     *  exchange look like it had never happened.
     *
     *  It now carries the LIVE row too, not just the settled one — see
     *  `chatTurnMirror`, which exists because a turn started here was invisible
     *  to the Agents surface until it finished. */
    onSoloTurnCommit?: (row: SoloTurnRow, conversationId: string) => void;
    /** Make the conversation this dock turn belongs to the one the Agents surface
     *  is showing, minting one when the session has never had a thread.
     *
     *  A dock session started on the Trade screen had no `conversationId` at all,
     *  so nothing it said could reach the Agents surface — the two homes were two
     *  transcripts wearing one app. The caller owns conversations, so this asks
     *  it to adopt (or create) the thread and hands the id back for the session
     *  to bind. Returns null only when the host has no conversation to give, and
     *  the turn then stays dock-local rather than writing into a thread that
     *  does not exist. */
    onSyncConversation?: (conversationId?: string) => string | null;
    /** Launches the FULL ensemble pipeline from this chat. It writes its rows
     *  into the ACTIVE conversation — the same thread the Agents surface renders —
     *  so this resolves when the run ends and carries no answer text. */
    onRunAnalysis?: (prompt: string, images: Array<{ name: string; dataURL: string }>) => Promise<void>;
    /** Where a run that never started says why. The pipeline writes its own
     *  error bubble once it is running, so the only silent failures left are the
     *  pre-flight ones, and a button that does nothing reads as broken. */
    onAnalysisError?: (message: string) => void;
}

/** The three entry points the shell drives: the composer's send (and the
 *  retry chips' re-send), the Full-analysis button, and the harness-signal
 *  drain effect. */
export interface ChatTurnRunner {
    send: (raw: string, retryOf?: string) => Promise<void>;
    runFullAnalysis: () => Promise<void>;
    runHarnessTurn: (signalText: string) => Promise<void>;
}

/**
 * The human notice line for a harness signal: the EVENT's first sentence,
 * machine-tag stripped. The signal's last line is the MODEL'S orders
 * ("Warn the user now…") and must never reach the transcript as an amber row
 * (the all-caps instruction defect stage 3 closed).
 */
export const harnessNoticeLine = (signalText: string): string => {
    const firstLine = signalText.split('\n')[0].replace(/^\[[^\]]*\]\s*/, '').replace(/^⚡\s*/, '').trim();
    const cut = firstLine.indexOf('. ');
    const sentence = cut === -1 ? firstLine : firstLine.slice(0, cut + 1);
    return sentence.trim();
};

export const createChatTurnRunner = (deps: ChatTurnRunnerDeps): ChatTurnRunner => {
    const {
        symbol, interval, effort, selectedChatModel, chartLevels, allDrawings, trades,
        getChartSnapshot, provider, configForSeat, systemPromptFor, bots, activeId, draft,
        sessions, botThreadRows, conversationRows, attachments, attachedImages,
        clearAttachments, setDraft, setContextAt, addModelDrawings,
        clearModelDrawings, clearAllDrawings, onPlanPresented, onBotTurnCommit, onSoloTurnCommit, onSyncConversation, onRunAnalysis, onAnalysisError,
    } = deps;

    /** The tier every turn in this runner resolves to. ONE resolution, read by
     *  the transport, the tool turn and the row that records it — so a turn,
     *  its request and its transcript row cannot claim three different tiers.
     *  The runner is rebuilt when the composer's tier changes (it is a
     *  dependency of the memo that builds this), so this cannot go stale. */
    const turnEffort = resolveComposerEffort(effort, 'tradingDecision');

    const mutate = (id: string, fn: (s: LiveSession) => LiveSession): void => {
        chatStore.mutate(id, fn);
    };

    /** End a run ONLY if the store still holds THIS run's controller — the rule
     *  itself lives in chatStore beside the controller map it reads, because a
     *  queued harness flush racing this run can REPLACE the slot. */
    const endRunOwned = chatStore.endRunOwned;

    /** Desk-tool drawing surface. draw_on_chart / mark_trade_levels /
     *  clear_chart_drawings land here — the market executor never sees
     *  them (they touch the live canvas). Bars-ago anchors resolve against
     *  the chart's newest candle so a line the model draws at "10 bars ago"
     *  lands where the user is looking.
     *  `turn` is the RUNNING turn's identity (captured by runSeatTurn when
     *  the stream starts) — every attach/persist keys off it, never off
     *  the view state, so a background or harness turn's output lands in
     *  ITS OWN session even after the user switched away. */
    const executePanelTool = async (call: DeskToolCall, turn: PanelTurnContext): Promise<DeskToolResult | null> => {
        const name = call.name;
        if (name !== 'draw_on_chart' && name !== 'draw_detected' && name !== 'draw_tool_levels' && name !== 'mark_trade_levels' && name !== 'clear_chart_drawings'
            && name !== 'present_trade' && name !== 'watch_price' && name !== 'wake_me' && name !== 'cancel_watch') return null;
        const args = call.arguments ?? {};
        const receipt = (ok: boolean, content: string): DeskToolResult => ({ toolCallId: call.id, name, ok, content });
        // The chart snapshot is shared by every drawing branch: its live mark
        // is stamped onto each shape (drawnPrice) so describeDrawingsForModel
        // can later tell the model how far price has moved since the shape was
        // made — the difference between a fresh level and a stale one.
        const snap = getChartSnapshot?.() ?? null;
        const drawnPrice = snap?.markPrice ?? null;
        // CANVAS HONESTY (residual of the per-turn identity refactor): the
        // snapshot is the VIEWED canvas, but a turn keeps running after the
        // user switches instruments. When the two disagree, every stamp taken
        // from it — drawnPrice, the bars-ago anchor, the arm-time stale call —
        // is NOT the turn's coin's live data. Say so in the receipt instead of
        // silently stamping the viewed coin's numbers onto another coin's
        // turn (the text-level half of the identity class; the canvas itself
        // stays owned by TradeView).
        const canvasSymbol = snap && typeof snap.symbol === 'string' && snap.symbol ? snap.symbol : '';
        const crossCanvas = !!canvasSymbol && !!turn.symbol && canvasSymbol !== turn.symbol;
        const canvasNote = crossCanvas
            ? ` NOTE: the canvas shows ${canvasSymbol}; this snapshot was taken while the turn was on ${turn.symbol} — treat its prices/bar times as stale for ${turn.symbol}, not as its live mark.`
            : '';
        // ── Watch / schedule harness (model arms a price trigger or a time
        //    wake-up; the harness wakes it back up when the condition holds).
        if (name === 'watch_price' || name === 'wake_me') {
            const makeId = (): string => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const nowMs = Date.now();
            // Arming a watch is an explicit "alert me later" — request the OS
            // notification permission NOW so the grant exists when the trigger
            // fires minutes/hours from now (a permission prompt at fire time
            // would be too late, or silently dropped).
            void ensureNotifyPermission();
            if (name === 'watch_price') {
                const { watch, error } = parsePriceWatch(args, { symbol: turn.symbol, makeId, nowMs });
                if (error || !watch) return receipt(false, `watch_price rejected: ${error ?? 'invalid'}`);
                // The canvas mark is only this watch's price when the canvas is
                // the same coin AND the turn has not drifted off it (canvasNote).
                // Otherwise the service decides from its own feed.
                const markHint = !crossCanvas && canvasSymbol === watch.symbol ? drawnPrice : null;
                // The wake belongs to the thread that armed it.
                watch.sid = turn.sid;
                if (watchService.arm(watch, markHint) === 'refused') {
                    // The refusal IS the answer: say what is already true instead
                    // of arming a trigger that would only announce history.
                    return receipt(false, `watch_price refused: ${watch.symbol} already satisfies "${watch.condition} ${watch.price}" at the live mark, so there is nothing to watch and no alert will ever come. Tell the user that condition is here NOW (read the tape if you need the fresh number), or arm a level the market has not reached.`);
                }
                return receipt(true, `Watch ${watch.id} armed: ${watch.symbol} ${watch.condition} ${watch.price}, expires ${phtClock(watch.expiresAt)} PHT. The harness will wake you with a [HARNESS TRIGGER] the first time it holds — then it lapses. Tell the user you are watching for it.`);
            }
            const { wake, error } = parseTimeWake(args, { symbol: turn.symbol, makeId, nowMs });
            if (error || !wake) return receipt(false, `wake_me rejected: ${error ?? 'invalid'}`);
            wake.sid = turn.sid;
            watchService.arm(wake);
            return receipt(true, `Scheduled wake ${wake.id} at ${phtClock(wake.atMs)} PHT (in ${Math.round((wake.atMs - nowMs) / 60_000)}m). The harness will signal you then to re-check ${wake.symbol}: "${wake.note}".`);
        }
        if (name === 'cancel_watch') {
            const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
            let n = 0;
            for (const id of ids) if (watchService.cancel(id)) n += 1;
            if (args.allForSymbol) {
                // The SAME canonicalization chartTriggers applies at arm time
                // (baseOf+quoteOf: 'BTC' → 'BTCUSDT'). Plans now live under the
                // normalized full form, so a raw toUpperCase() target could
                // never match a watch the model armed as bare 'BTC' — compare
                // canonically on BOTH sides to stay robust to legacy rows.
                const target = String(args.symbol ?? turn.symbol).trim();
                const canon = target ? `${baseOf(target)}${quoteOf(target)}` : '';
                n += watchService.cancelWhere(w => (w.symbol.trim() ? `${baseOf(w.symbol)}${quoteOf(w.symbol)}` : w.symbol) === canon);
            }
            const left = watchService.list().map(w => w.id);
            return receipt(true, n > 0
                ? `Cancelled ${n} watch${n === 1 ? '' : 'es'}. Still armed: ${left.join(', ') || 'none'}.`
                : `Nothing to cancel (ids: ${ids.join(', ') || '—'}). Still armed: ${left.join(', ') || 'none'}.`);
        }
        // present_trade: draw the plan, arm the harness level-watch, and surface a
        // "Log this trade" card on the streaming entry. The TRANSITION lives in
        // services/trade/presentTradeTool — the Agents surface presents the same plan
        // through the same rules — so everything below is the DOCK'S SINK: four
        // writes onto the running entry, plus the canvas and the watch only this
        // surface owns.
        if (name === 'present_trade') {
            let mintedPlanId = '';
            return runPresentTrade(
                { call, symbol: turn.symbol, trades, drawnPrice, crossCanvas, canvasNote, watchable: true },
                {
                    setProposal: p => {
                        mintedPlanId = p.planId ?? '';
                        // THE turn's entry — not "whatever is streaming in the viewed
                        // session": the card must land in this run's transcript even if
                        // the user switched sessions mid-stream.
                        if (turn.entryId) chatStore.mutate(turn.sid, s => ({ ...s, entries: s.entries.map(en => (en.id === turn.entryId ? { ...en, proposal: p } : en)) }));
                    },
                    setGate: gate => {
                        // Patch only while this exact row still carries this plan. If the
                        // turn was stopped, the session closed, or the user cancelled the
                        // card, the map finds nothing and the late answer is a no-op.
                        if (!mintedPlanId) return;
                        chatStore.mutate(turn.sid, s => ({
                            ...s,
                            entries: s.entries.map(en => (en.id === turn.entryId && en.proposal?.planId === mintedPlanId
                                ? { ...en, proposal: { ...en.proposal, gate } } : en)),
                        }));
                    },
                    ...(addModelDrawings ? { addDrawings: (list: ChartDrawing[]) => addModelDrawings(list, turn) } : {}),
                    ...(onPlanPresented ? { armPlan: (plan: WatchPlan) => onPlanPresented(plan, turn) } : {}),
                    // A Stop on this run kills the scan too: an answer that arrives for a
                    // turn the user already cancelled must not resurrect its card.
                    onAbort: fn => { chatStore.getController(turn.sid)?.signal.addEventListener('abort', fn, { once: true }); },
                },
            );
        }

        if (name === 'clear_chart_drawings') {
            const scope = args.scope === 'all' ? 'all' : 'model';
            if (!clearModelDrawings && !clearAllDrawings) return receipt(false, 'clear_chart_drawings: no chart is attached to this session.');
            if (scope === 'all') clearAllDrawings?.(turn);
            else clearModelDrawings?.(turn);
            return receipt(true, scope === 'all'
                ? 'Cleared ALL drawings (the model\'s marks and the user\'s own shapes) from the chart.'
                : 'Cleared the model\'s own drawings from the chart (the user\'s shapes were kept).');
        }
        if (!addModelDrawings) return receipt(false, `${name}: no chart is attached to this session.`);
        // Whether a drawn shape is actually ON SCREEN. repaint() clips to the
        // plot rect, so a price outside the visible scale is discarded
        // silently and a trend anchored past the window never appears — and the
        // receipt used to say "The user sees it now" either way. The model was
        // told its work landed, and had no way to learn otherwise.
        const vis = snap?.visibleRange ?? null;
        const inView = (p: number): boolean =>
            vis ? p >= vis.priceLow && p <= vis.priceHigh : true;
        /** Only claims visibility when it is known; never guesses either way. */
        const visibility = (drawings2: { points: { p: number }[] }[]): string => {
            if (!vis) return '';
            const off = drawings2.filter(d => !d.points.every(pt => inView(pt.p)));
            if (off.length === 0) return ' The user sees these now.';
            if (off.length === drawings2.length) {
                return ` WARNING: every price is OUTSIDE the visible range ${Math.round(vis.priceLow)}–${Math.round(vis.priceHigh)} — repaint() clips there, so the user will NOT see this until the chart is scrolled or zoomed out.`;
            }
            return ` WARNING: ${off.length} of ${drawings2.length} shapes fall outside the visible range ${Math.round(vis.priceLow)}–${Math.round(vis.priceHigh)} and will be clipped until the user scrolls or zooms out.`;
        };
        // How the model's OWN earlier levels have done. A seat could put twenty
        // levels on this chart and every one would be unmeasured forever, so a
        // model that draws nonsense and one that draws structure were
        // indistinguishable — and the model never learned which it was. This
        // closes that loop on the receipt it already receives.
        const drawnLevelStanding = (s: ChartSnapshot | null): string => {
            if (!s) return '';
            const hlines = (s.modelDrawings ?? []).filter(
                (x) => x.kind === 'hline' && x.points.length > 0,
            );
            if (hlines.length === 0) return '';
            const scores = hlines.map((x) =>
                scoreDrawnLevel(x.points[0].p, s.candles, x.createdAt / 1000),
            );
            // Silence while nothing is judgeable: a standing score over two
            // fresh bars is noise, and a model that learns to trust it would
            // be learning a habit, not a fact.
            if (levelAccuracy(scores).judged === 0) return '';
            return ` ${describeLevelAccuracyForModel(scores)}`;
        };
        if (name === 'mark_trade_levels') {
            const { drawings, error } = drawingsFromLevelTool(args, { drawnPrice });
            if (error) return receipt(false, `mark_trade_levels rejected: ${error}`);
            addModelDrawings(drawings, turn);
            const listed = drawings.map(d => `${d.label} ${d.points[0].p}`).join(', ');
            return receipt(true, `Marked on the chart: ${listed}.${visibility(drawings)}${canvasNote}`);
        }
        // draw_detected — the model NAMES the structure, the detector's own
        // anchors place it. This removes the round trip where a pattern reached
        // the model as the sentence "Shoulders at ~62150.00" and the model
        // passed 62150 back as a price, so the level was wrong by construction
        // whenever the read or the restatement lost a digit. Nothing could
        // catch that, because the drawing and the pattern were never related.
        if (name === 'draw_detected') {
            const wanted = String(args.pattern ?? '').trim().toLowerCase();
            if (!wanted) return receipt(false, 'draw_detected rejected: "pattern" is required — name a structure from the packet geometry table.');
            let packet;
            try {
                packet = await fetchHybridData(symbol);
            } catch (e) {
                return receipt(false, `draw_detected could not reach the detector: ${e instanceof Error ? e.message : 'fetch failed'}. Draw it by hand with draw_on_chart instead.`);
            }
            const perTf = packet?.chartPatterns ?? {};
            const available = Object.entries(perTf).flatMap(([tf, list]) =>
                (list ?? []).map(p => ({ tf, p }))
            );
            if (available.length === 0) {
                return receipt(false, 'draw_detected: the detector found no structures on this chart right now. Nothing to draw.');
            }
            const hit = available.find(({ p }) => p.name.toLowerCase() === wanted)
                ?? available.find(({ p }) => p.name.toLowerCase().includes(wanted));
            if (!hit) {
                const names = [...new Set(available.map(({ p }) => p.name))].join(', ');
                return receipt(false, `draw_detected: no structure named "${args.pattern}". The detector currently sees: ${names}.`);
            }
            const { drawings, error } = drawingsFromDetectedPattern(hit.p, { drawnPrice });
            if (error) return receipt(false, `draw_detected rejected: ${error}`);
            addModelDrawings(drawings, turn);
            const confirmed = hit.p.touches >= 3;
            return receipt(
                true,
                `Drew the detected ${hit.p.name} (${hit.tf}) at the measured anchors: ${drawings.map(x => x.points.map(pt => pt.p).join('→')).join(', ')}. `
                + `The market reached that line ${hit.p.touches} time${hit.p.touches === 1 ? '' : 's'} — ${confirmed ? 'confirmed' : 'NOT confirmed; treat it as an assumption, not a setup'}.`
                + `${visibility(drawings)}${canvasNote}`
            );
        }
        // draw_tool_levels — the market tools' chart half. The model NAMES the
        // tool (and optionally which labels it wants); the app RE-RUNS the
        // tool fresh and draws at the computed prices. Same rule as
        // draw_detected: the drawing and the computation cannot disagree,
        // because the model never restates a number.
        if (name === 'draw_tool_levels') {
            // Lazy: the market-tool module (and its fetch layer) stays out of
            // the dock chunk until a seat actually draws.
            const mt = await import('../analysis/marketTools');
            const wanted = String(args.tool ?? '').trim();
            if (!mt.DRAWABLE_TOOLS.includes(wanted)) {
                return receipt(false, `draw_tool_levels rejected: "tool" must be one of ${mt.DRAWABLE_TOOLS.join(', ')}.`);
            }
            // Re-run the tool FRESH at draw time (never from a cached copy the
            // turn might have clipped) — the same move draw_detected makes.
            const sym = String(args.symbol || turn.symbol || '').trim();
            const items = Array.isArray(args.items) ? args.items.map(String) : undefined;
            let content: string;
            try {
                switch (wanted) {
                    case 'volume_profile':
                        content = await mt.runVolumeProfileTool(sym, (['session', 'day', 'week', 'visible', 'swing', 'custom'].includes(String(args.anchor)) ? String(args.anchor) : 'session') as ProfileAnchor);
                        break;
                    case 'naked_pocs':
                        content = await mt.runNakedPocsTool(sym, String(args.granularity) === 'week' ? 'week' : 'day', Math.min(20, Math.max(1, Number(args.lookback) || 5)));
                        break;
                    case 'vwap':
                        content = await mt.runVwapTool(sym, (['session_open', 'swing_high', 'swing_low', 'custom'].includes(String(args.anchor)) ? String(args.anchor) : 'session_open') as VwapAnchor);
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
                return receipt(false, `draw_tool_levels could not re-run ${wanted}: ${e instanceof Error ? e.message : 'fetch failed'}.`);
            }
            if (!content) return receipt(false, `draw_tool_levels: ${wanted} returned nothing.`);
            let parsed: { values?: unknown; data_quality?: { reason?: string } };
            try {
                parsed = JSON.parse(content);
            } catch {
                return receipt(false, `draw_tool_levels: ${wanted} returned a non-JSON result; nothing to draw.`);
            }
            // get_key_levels' shape is its own (session_levels at the root, no
            // envelope) — wrap it so the extractor sees one shape.
            const set = mt.drawableLevelsFor(wanted, wanted === 'get_key_levels' ? { values: parsed } : parsed, items);
            if (!set || (set.hlines.length === 0 && set.zones.length === 0)) {
                const reason = parsed.data_quality?.reason ?? 'no drawable levels in the fresh result (nothing qualified)';
                return receipt(false, `draw_tool_levels: ${wanted} produced nothing drawable — ${reason}. Nothing was drawn.`);
            }
            const drawnPrice2 = drawnPrice ?? undefined;
            const nowSec = Date.now() / 1000;
            // Zones anchor to the VISIBLE window (a zone is a region, not a
            // point); without a fitted range, fall back to the snapshot's
            // candle span.
            const t0 = snap?.visibleRange?.timeLow
                ?? (snap && snap.candles.length > 0 ? snap.candles[0].time : nowSec - 3600);
            const t1 = snap?.visibleRange?.timeHigh
                ?? (snap && snap.candles.length > 0 ? snap.candles[snap.candles.length - 1].time : nowSec);
            const mk = (price: number, label: string, color: string): ChartDrawing => ({
                id: createDrawingId(), kind: 'hline', points: [{ t: nowSec, p: price }], color, createdAt: Date.now(), label, drawnPrice: drawnPrice2,
            });
            const mkZone = (label: string, top: number, bottom: number, color: string): ChartDrawing => ({
                id: createDrawingId(), kind: 'rect', points: [{ t: t0, p: top }, { t: t1, p: bottom }], color, createdAt: Date.now(), label, drawnPrice: drawnPrice2,
            });
            const drawings2: ChartDrawing[] = [
                ...set.hlines.map(h => mk(h.price, h.label, MODEL_COLOR_NAMES[h.color])),
                ...set.zones.map(z => mkZone(z.label, z.top, z.bottom, MODEL_COLOR_NAMES[z.color])),
            ].slice(0, 20); // the model-drawing cap is 40 per symbol; one call stays half of it
            addModelDrawings(drawings2, turn);
            const listed = drawings2.map(d => `${d.label}${d.kind === 'rect' ? ' (zone)' : ''} @ ${d.points[0].p}`).join(', ');
            return receipt(true, `Drew ${wanted}'s computed levels at the tool's own prices: ${listed}.${visibility(drawings2)}${canvasNote}`);
        }
        // draw_on_chart — resolve bars-ago anchors against the newest candle.
        const lastBarTime = snap && snap.candles.length > 0
            ? snap.candles[snap.candles.length - 1].time
            : Math.floor(Date.now() / 1000);
        const { drawings, error, note } = drawingFromChartTool(args, { lastBarTime, barSeconds: intervalSeconds(turn.interval as never), drawnPrice, klines: snap?.candles });
        if (error) return receipt(false, `draw_on_chart rejected: ${error}`);
        addModelDrawings(drawings, turn);
        const d = drawings[0];
        const described = describeDrawingsForModel([d]).split('\n').slice(1).join(' ').trim();
        return receipt(true, `Drew on the chart: ${described || d.kind}.${note || ''}${visibility([d])}${drawnLevelStanding(snap)}${canvasNote}`);
    };

    /** The fresh code-calculated packet every message rides (fetched ONCE per
     *  send — shared across all panel seats so they argue about the same tape).
     *  The hybrid pull is the slow network leg before the first token, so a
     *  short-TTL cache (per symbol) lets rapid follow-up questions skip it —
     *  only the PACKET is cached; drawings/plans/on-screen are rebuilt fresh
     *  every send, and the block carries the real fetch time so the model
     *  knows its age. */
    const buildContextBlock = async (): Promise<string> => {
        // What the canvas is PAINTING right now (the snapshot), independent
        // of the network fetch below — if they disagree, the model sees both.
        const snap = getChartSnapshot?.() ?? null;
        const onScreen = snap ? describeChartSnapshotForModel(snap) : '';
        // The harness level-watch's armed plans for THIS symbol PLUS the
        // model's own armed watches (price triggers / time wake-ups): the
        // model always knows what it is waiting on, even without a signal.
        const plansBlock = [
            ...levelWatch.getArmedPlans()
                .filter(p => p.symbol === symbol)
                .map(p => describePlanForModel(p, levelWatch.firedLevelsFor(p.planId))),
            describeWatchesForModel(watchService.list(), Date.now()),
        ].filter(Boolean).join('\n\n');
        // Send-time stamps from the websocket feed: the live mark plus the
        // FORMING candle (last painted bar — already ws-updated), so a
        // cached/snapshot packet can never read as a fresh move or a stale
        // candle.
        const liveMarkPrice = snap?.markPrice ?? null;
        const snapCandles = snap?.candles ?? [];
        const formingCandle = snapCandles.length > 0 ? snapCandles[snapCandles.length - 1] : null;
        // Drawings carry their draw-time price, so describe them against the
        // live mark HERE — the model sees how far price has moved since each
        // shape and knows which levels are still fresh vs gone stale.
        const drawingsDescription = describeDrawingsForModel(allDrawings, { priceNow: liveMarkPrice, nowMs: Date.now() });
        // E7 extended: the coin's last stored post-mortem rides the context
        // block, not only the emit_signal receipt — a lesson the loop already
        // earned is invisible to an ordinary answer otherwise. A failed store
        // read costs the section, never the turn.
        const { diagnosisBriefBlock } = await import('../tracking/diagnosisBrief');
        const postMortemBrief = await diagnosisBriefBlock(symbol);
        const cached = packetCache.get(symbol);
        if (cached && Date.now() - cached.atMs < PACKET_CACHE_MS) {
            return buildTradeChatContext({ symbol, interval, contextWindowTokens: provider?.contextWindowTokens, packetMarkdown: cached.markdown, fetchedAtMs: cached.atMs, drawingsDescription, onScreenDescription: onScreen, plansDescription: plansBlock, postMortemBrief, liveMarkPrice, formingCandle });
        }
        try {
            const packet = await fetchHybridData(symbol);
            const markdown = generateHybridPromptInjection(packet, { compact: true });
            const atMs = Date.now();
            setContextAt(atMs);
            packetCache.set(symbol, { markdown, atMs });
            return buildTradeChatContext({ symbol, interval, contextWindowTokens: provider?.contextWindowTokens, packetMarkdown: markdown, fetchedAtMs: atMs, drawingsDescription, onScreenDescription: onScreen, plansDescription: plansBlock, postMortemBrief, liveMarkPrice, formingCandle });
        } catch {
            return buildTradeChatContext({ symbol, interval, contextWindowTokens: provider?.contextWindowTokens, packetMarkdown: '', fetchedAtMs: Date.now(), drawingsDescription, onScreenDescription: onScreen, plansDescription: plansBlock, postMortemBrief, liveMarkPrice, formingCandle });
        }
    };

    /** Stream one seat turn into its entry; resolves with the full text. */
    const runSeatTurn = async (params: {
        sid: string;
        entryId: string;
        config: ProviderConfig;
        messages: ChatMessage[];
        mailboxSeat: string;
        mailbox?: ReturnType<typeof createPanelMailbox>;
        onMailSent?: (info: { from: string; to: string; text: string; round: number }) => void;
        /** Mirrors every side-effect (proposal/write) out to the caller so
         *  the panel loop can carry it into the shared room transcript. */
        onAction?: (label: string) => void;
        /** Panel seats: keep the bubble EMPTY while the stream could still
         *  collapse to a pure (pass), so silence never takes a visible turn. */
        hidePass?: boolean;
    }): Promise<string> => {
        const { sid, entryId, config, messages, mailboxSeat, mailbox, onMailSent, onAction, hidePass } = params;
        const controller = chatStore.getController(sid);
        if (!controller) return '';
        // One snapshot per seat turn feeds BOTH stamps (live mark + forming
        // candle) and the desk tools' context — a single consistent read of
        // what the canvas is painting as the turn starts.
        const sendSnap = getChartSnapshot?.() ?? null;
        const sendCandles = sendSnap?.candles ?? [];
        // The identity of THIS turn, frozen at start. Every panel-tool
        // side-effect (proposal card, drawings, arming) is dispatched with
        // this context — so a turn running in the background while the user
        // watches another session/symbol still writes into ITS transcript.
        const turnCtx: PanelTurnContext = { sid, entryId, symbol, interval };
        // ONE clock for every settle path in this seat turn. The entry's own `at`
        // is the honest start (stamped when the bubble was painted), so a Stop, a
        // failure and a clean finish all report the same "Analyzed for Ns".
        const turnStartedAt: number = entryAtRef(sid, entryId) ?? Date.now();
        const patch = (fn: (e: LiveEntry) => LiveEntry): void => {
            mutate(sid, s => ({ ...s, updatedAt: Date.now(), entries: s.entries.map(e => (e.id === entryId ? fn(e) : e)) }));
        };
        // The transport options stay HERE (they are this row's context); the
        // loop, the reasoning/echo/peel repair and the settle live in
        // services/trade/toolTurn so the Agents surface can run the same turn
        // against a canonical row instead of copying that logic.
        const transport: ToolTurnRequest['transport'] = {
            defaultSymbol: symbol,
            allowedTools: TRADE_TOOLS,
            goalAllowedTools: focusedGoal()?.policy.allowedTools,
            maxTokens: TASK_BUDGETS.chat,
            temperature: 0.4,
            reasoningEffort: turnEffort,
            chartInterval: interval,
            chartLevels,
            chartDrawings: allDrawings,
            liveMarkPrice: sendSnap?.markPrice ?? null,
            formingCandle: sendCandles.length > 0 ? sendCandles[sendCandles.length - 1] : null,
            // ...and re-read the canvas on every desk call. The two above are
            // frozen when the turn starts; a three-round turn can spend a
            // minute in tool calls, and a "live mark" stamped with the opening
            // tick is the same misreport the stamp exists to prevent.
            getLiveMarkPrice: () => getChartSnapshot?.()?.markPrice ?? null,
            getFormingCandle: () => {
                const cs = getChartSnapshot?.()?.candles ?? [];
                return cs.length > 0 ? cs[cs.length - 1] : null;
            },
            executePanelTool: call => executePanelTool(call, turnCtx),
            trades,
            mailbox,
            mailboxSeat,
            mailboxRound: 0,
            onMailSent,
        };
        // Each method here is a WRITE TO THIS ROW SHAPE, not generic turn logic.
        const events: ToolTurnEvents = {
            setText: text => patch(e => ({ ...e, text })),
            addReasoning: chunk => patch(e => ({ ...e, reasoning: (e.reasoning ?? '') + chunk })),
            // Tool lines AND their ids are appended in the SAME patch. The id is
            // the only safe join key for a payload: `results` inside the desk
            // loop is assembled `[...replays, ...extra, ...forged, ...core]`, so
            // its order does not match the `calling…` lines rendered here.
            // Pairing by index would silently attach the wrong payload to a row.
            addToolLine: line => patch(e => ({ ...e, tools: [...e.tools, line], toolIds: [...(e.toolIds ?? []), ''], liveProgress: undefined })),
            addLiveToolLine: line => patch(e => ({ ...e, liveProgress: line })),
            attachPayload: payload => {
                // The desk loop emits the digest line before this, so the row
                // exists and `tools`/`toolIds` are already the same length.
                try {
                    saveToolPayload(payload);
                } catch {
                    // Refused or unwritable. The store has RECORDED it and the
                    // row will say so; a payload write must never take down the
                    // transcript write it is riding inside.
                }
                patch(e => {
                    const ids = [...(e.toolIds ?? [])];
                    // Keep the two arrays the same length: a payload that arrives
                    // with no matching digest line (a replay reusing an earlier
                    // call id) pads with '' rather than shifting every later id
                    // onto the wrong row.
                    while (ids.length < e.tools.length) ids.push('');
                    ids[Math.max(0, e.tools.length - 1)] = payload.toolCallId;
                    return { ...e, toolIds: ids };
                });
            },
            addAction: action => {
                patch(e => ({ ...e, actions: [...(e.actions ?? []), action] }));
                // Mirror the side-effect into the caller's collector so a
                // PANEL seat's next turn (and the synthesis) can SEE that a
                // peer proposed/edited something — the cross-talk the user
                // asked for around skill/memory/tool edits.
                onAction?.(`${action.ok ? action.verb : 'rejected'} ${action.tool === 'skill_write' ? `skill ${action.label}` : action.tool === 'write_memory_note' ? `memory note ${action.label}` : action.tool === 'amend_memory' ? `memory amendment ${action.label}` : action.tool === 'forge_tool' ? `tool ${action.label}` : action.label}`);
            },
        };
        // The truncation tally is per-RUN, and this is the run. Without a window
        // open, `recordFinishReason` counts nothing and a provider that stopped
        // at the token ceiling is indistinguishable from one that finished — a
        // truncated body is a SUCCESS-shaped response, so nothing else in the
        // transport reports it. Bracket the seat's turn so the line the trader
        // reads is a measured fact, not a guess from a missing sentence.
        const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
        const lastUserMessage = typeof lastUser?.content === 'string'
            ? lastUser.content
            : Array.isArray(lastUser?.content)
                ? lastUser.content.map(p => (typeof p === 'string' ? p : (p as { text?: string }).text ?? '')).join('\n')
                : undefined;
        // Per-run recorder: see chatSurfaceTurn's note and the 2026-10-27 audit L-7.
        const { value: outcome, summary } = await withTruncationWindow(async (recordFinishReason) => await runToolTurn({
            config,
            messages,
            signal: controller.signal,
            startedAt: turnStartedAt,
            effort: turnEffort,
            keepTextHidden: hidePass ? panelCouldStillBePass : undefined,
            transport: { ...transport, onFinishReason: recordFinishReason },
            events,
            memoryEnabled: deps.memoryEnabled !== false,
            lastUserMessage,
        }));
        recordToolTurnUsage({
            startedAt: turnStartedAt,
            workedMs: outcome.workedMs,
            modelId: config.selectedModel,
            usage: outcome.usage,
            usageCalls: outcome.usageCalls,
            answer: outcome.text,
            seats: 1,
            rates: {
                inputUsdPer1k: config.inputUsdPer1k,
                outputUsdPer1k: config.outputUsdPer1k,
            },
        });
        // A cut-off answer is said on the row it belongs to: the seat's text
        // may end mid-sentence, and the trader must be able to tell that from
        // an answer that simply finished. A RECOVERED run is exempt — the
        // loop repaired the ceiling-hit and returned a whole answer.
        const cutOff = outcome.recoveredFromTruncation ? '' : truncationNotice(summary);
        patch(e => settleDockEntry({
            ...e,
            workedMs: outcome.workedMs,
            // The tier the turn was sent under, so the answer row can show it.
            // It comes out of the executor rather than being resolved again
            // here: one turn, one tier, one source.
            effort: outcome.effort,
            // What the wire was actually asked, for the same reason: the
            // answer row has to be able to say WHY a turn came back with no
            // trace, and the transport's own decision is the only honest
            // answer to that.
            ...(outcome.wireAudit?.length ? { wireAudit: outcome.wireAudit } : {}),
            ...(outcome.interrupted
                // A stopped turn keeps whatever text was already painted: a
                // hidden-pass seat that never spoke must not reveal its partial
                // accumulator just because the user pressed Stop.
                ? {}
                : {
                    text: outcome.text,
                    reasoning: outcome.leaked
                        ? (outcome.reasoning || e.reasoning)
                        : (e.reasoning || outcome.reasoning),
                }),
            ...(outcome.notice ? { tools: [...e.tools, outcome.notice] } : {}),
            ...(cutOff ? { tools: [...e.tools, cutOff] } : {}),
        }, outcome.interrupted ? 'stopped' : 'completed'));
        return outcome.carry;
    };

    /** Trader-learner hook, fire-and-forget after each send. It distills
     *  durable habits into profile memory from the recent transcripts, using
     *  the model the trader is actually talking to — the panel's FIRST seat
     *  when several are selected, else the session's own pick. The every-2-sends
     *  cadence lives inside the learner, not here. Best-effort:
     *  no ready provider means no pass, and a throw never reaches the turn. */
    const maybeReviewSessions = (learnerCfg: ProviderConfig | null): void => {
        const model = learnerCfg ?? provider;
        if (!model) return;
        const user = getActiveUsername();
        const reviewable = sessions
            .filter(s => s.kind !== 'group' && s.entries.some(e => e.role === 'ai' && e.text.trim()))
            .map(s => ({
                id: s.id,
                transcript: s.entries
                    .filter(e => e.text.trim())
                    .map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`)
                    .join('\n\n'),
                atMs: s.updatedAt,
                symbol,
            }));
        if (reviewable.length > 0) {
            void runTraderLearner(user, model, reviewable.map(s => s.transcript)).catch(() => { /* best-effort */ });
        }
    };

    /** Send a message — or RETRY one: `retryOf` is the id of a previous USER
     *  entry whose answer should be regenerated. The stale answer(s) after
     *  that bubble are dropped and the turn re-runs with the same text/image
     *  and fresh live context. */
    const send = async (raw: string, retryOf?: string): Promise<void> => {
        // Fresh STORE read (the pattern runHarnessTurn already uses) — never
        // the render snapshot: a key-repeat/double-click fires two sends
        // inside one React tick, and the snapshot's `busy` is still false
        // for the second one, so two runs overlap.
        const live = chatStore.getSnapshot();
        const sid = live.activeId;
        const session0 = live.sessions.find(s => s.id === sid);
        if (!session0) return;
        const retryEntry = retryOf
            ? session0.entries.find(e => e.id === retryOf && e.role === 'user')
            : undefined;
        if (retryOf && !retryEntry) return;
        const text = retryEntry
            ? (retryEntry.text === '(chart screenshot)' ? '' : retryEntry.text.trim())
            : raw.trim();
        const sentAttachments: Attachment[] = retryEntry
            ? (retryEntry.image ? [{ id: newId('at'), kind: 'image', name: 'chart.png', payload: retryEntry.image }] : [])
            : attachments;
        if ((!text && sentAttachments.length === 0 && !retryEntry) || live.running[sid]) return;
        // A run belongs to the thread, not to the surface that typed it. While
        // the Agents surface is answering IN THIS CONVERSATION, a second send from
        // the dock would put two writers on one answer — so the dock refuses,
        // exactly as it refuses against its own running session above.
        if (session0.conversationId && chatStore.isConversationRunning(session0.conversationId)) return;
        if (!provider) return;
        if (retryEntry) {
            // Drop the stale answer(s) AFTER the original user bubble — the
            // branch restarts from that message.
            mutate(sid, s => {
                const idx = s.entries.findIndex(e => e.id === retryEntry.id);
                return idx < 0 ? s : { ...s, updatedAt: Date.now(), entries: s.entries.slice(0, idx + 1) };
            });
        } else {
            setDraft('');
            clearAttachments();
        }
        const session = session0;
        // ONE conversation, two homes. A solo dock turn always speaks into a
        // thread the Agents surface can open: a session that never had one adopts
        // (or mints) it here, and a session that has one makes sure the Chat
        // surface is LOOKING at it — otherwise switching across showed an older
        // thread and the exchange you were mid-way through was nowhere.
        // Bot sessions are excluded (their thread is the bot's conversation,
        // committed by `onBotTurnCommit`) and panels are rooms, not threads.
        let turnConversationId = session.conversationId;
        if (session.kind !== 'panel' && !session.botId && onSyncConversation) {
            const synced = onSyncConversation(turnConversationId);
            if (synced && synced !== session.conversationId) {
                turnConversationId = synced;
                mutate(sid, s => (s.conversationId === synced ? s : { ...s, conversationId: synced }));
            }
        }
        // WHO DOES THE LEARNING: this session's model — a panel's FIRST seat
        // when several are selected, else the bot's pick, else the session's
        // own provider. It rides the learner hook fired from the finally block.
        const learnerSeat = session.kind === 'panel' ? session.panelModels?.[0] : undefined;
        const learnerBot = session.botId ? bots.find(b => b.id === session.botId) : undefined;
        const learnerCfg = (learnerSeat ? configForSeat(learnerSeat.providerId, learnerSeat.modelId) : null)
            ?? (learnerBot ? configForSeat(learnerBot.providerId, learnerBot.modelId) : null)
            ?? (session.kind !== 'panel' ? provider : null);
        // Retry: the model's history is everything BEFORE the retried bubble
        // (its stale answers are gone from the store too).
        // The bot answers from the SAME conversation the trader is looking at.
        // Reading the raw session here is what let a turn said in the Chat
        // surface reach the trader but never reach the bot: two views of one
        // conversation, which is the split this merge exists to remove.
        const conversation = entriesForSession(
            session.entries,
            session.botId && bots.some(b => b.id === session.botId)
                ? botThreadRows
                : (turnConversationId ? conversationRows : undefined),
        );
        const retryIdx = retryEntry ? conversation.findIndex(e => e.id === retryEntry.id) : -1;
        const history = retryIdx >= 0 ? conversation.slice(0, retryIdx) : conversation;
        const imageAttachment = sentAttachments.find(a => a.kind === 'image');
        const fileBlocks = sentAttachments.filter(a => a.kind === 'file')
            .map(a => `\n\n[ATTACHED FILE — ${a.name}]\n${a.payload.slice(0, MAX_FILE_CHARS)}`)
            .join('');
        const userEntry: LiveEntry = { id: retryEntry?.id ?? newId('u'), role: 'user', text: text || '(chart screenshot)', tools: [], image: imageAttachment?.payload, at: Date.now() };
        // The controller is armed (and registered in the store, keyed by
        // session) BEFORE the context fetch so a stop click during the
        // network-bound packet pull already kills the turn — and so the run
        // keeps streaming into the store even if the panel unmounts.
        const controller = new AbortController();
        chatStore.beginRun(sid, controller);
        // The SAME controller, registered under the CONVERSATION too. The two
        // homes key their run registries differently on purpose (a session id
        // and a conversation id must not collide), but a thread that is
        // answering must read as busy from either home: this is what lets the
        // Agents surface's Stop reach a run started here, and what lights the
        // rail's "still working" badge for it. Solo turns only — a panel is a
        // room, and a bot session's thread is committed by its own path.
        const registersConversation = session.kind !== 'panel' && !session.botId && !!turnConversationId;
        if (registersConversation && turnConversationId) {
            chatStore.beginConversationRun(turnConversationId, controller);
        }
        // Paint the transcript NOW, before the packet fetch: the user's
        // bubble + a "Thinking…" placeholder appear the instant they hit send,
        // so the dock never looks dead during the network round-trip. Solo
        // appends its streaming AI entry up front; panel seats stream into
        // their own entries added later in the loop.
        const isSolo = session.kind !== 'panel';
        const soloAiEntry: LiveEntry = { id: newId('a'), role: 'ai', text: '', tools: [], streaming: true, at: Date.now() };
        // The solo turn's clock, from the bubble's own stamp — every settle path
        // in this turn reports the SAME duration.
        const soloStartedAt: number | undefined = soloAiEntry.at;
        mutate(sid, s => ({
            ...s,
            title: s.entries.some(e => e.role === 'user') ? s.title : titleFromMessage(text),
            updatedAt: Date.now(),
            // Bind the session to the chart + composer state it was asked
            // under, so re-opening it later restores exactly this setup.
            symbol,
            interval,
            effort,
            ...(isSolo && !session.botId && selectedChatModel ? { soloModel: selectedChatModel } : {}),
            entries: [...s.entries, ...(retryEntry ? [] : [userEntry]), ...(isSolo ? [soloAiEntry] : [])],
        }));
        const contextBlock = await buildContextBlock();
        if (controller.signal.aborted) {
            // Stopped during the fetch — undo the optimistic bubbles (a
            // retried user bubble stays; only the fresh answer is removed).
            mutate(sid, s => ({ ...s, entries: s.entries.filter(e => e.id !== soloAiEntry.id && (retryEntry || e.id !== userEntry.id)) }));
            endRunOwned(sid, controller);
            // And release the CONVERSATION registration armed above, or this
            // thread stays busy forever: the run is over, but every home still
            // reads `conversationRunning` and offers a Stop for a turn that
            // already ended — which is what made a stopped dock turn block the
            // Agents surface's composer for the rest of the session.
            if (registersConversation && turnConversationId) {
                chatStore.endConversationRunOwned(turnConversationId, controller);
            }
            return;
        }
        const userText = `${contextBlock}\n\n${text}${fileBlocks}`;

        // ── SOLO (optionally bound to a roster bot persona) ────────────────
        if (isSolo) {
            const aiEntry = soloAiEntry;
            const bot = bots.find(b => b.id === session.botId);
            const soloProvider = bot
                ? (configForSeat(bot.providerId, bot.modelId) ?? provider)
                : provider;
            const systemPrompt = systemPromptFor(bot);
            const userContent = userContentWithImage(userText, imageAttachment, soloProvider.selectedModel);
            // Solo answers carry the seat label, so returning to a session
            // shows who said each line (the renderer the panel seats already
            // use). A bot-bound session names the AGENT, not the slug: the
            // same bot answers at the desk under its name, and one answer
            // claimed by model here and by identity there is two claims.
            mutate(sid, s => ({ ...s, entries: s.entries.map(en => (en.id === aiEntry.id ? { ...en, speaker: bot?.name ?? `${soloProvider.id}:${soloProvider.selectedModel}` } : en)) }));

            // Commit the QUESTION to the conversation that owns it, so the
            // Agents surface shows the exchange while it is still being answered
            // rather than after. The dock's composer writes into the chat
            // session, not into `messages`, so unlike the Agents surface there is
            // no trader's row already waiting to be claimed.
            if (bot) onBotTurnCommit?.(bot, text);
            else if (turnConversationId) {
                onSoloTurnCommit?.({ id: userEntry.id, role: 'user', text }, turnConversationId);
            }
            // THE LIVE MIRROR. Without it the conversation gained this turn's
            // answer only when it settled, so crossing to the Agents surface
            // mid-generation showed the question and a silent thread. The mirror
            // copies this entry into the conversation under the same id, and
            // `finally` stops it — which flushes, so a stopped or failed turn
            // cannot leave a row claiming to still be streaming.
            const mirror = !bot && turnConversationId && onSoloTurnCommit
                ? startEntryMirror({
                    sid,
                    entryId: aiEntry.id,
                    conversationId: turnConversationId,
                    speakerKey: soloProvider.id,
                    commit: onSoloTurnCommit,
                })
                : null;
            // History carries its images. The user attached a chart two turns
            // ago and asked "what about that pattern?" — the screenshot was
            // stored on the entry all along (StoredChatEntry.image, which is why
            // RETRY could recover it), but the history rebuild read e.text
            // alone, so the follow-up was answered blind by a model that had
            // just been shown the chart. Rebuilt through the same helper as the
            // live turn, so a prior image is re-sent as a real part and a
            // text-only seat is told it is there rather than not knowing.
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                ...history.slice(-10).flatMap(e => {
                    if (!e.text.trim() && !e.image) return [];
                    const role = e.role === 'user' ? 'user' : 'assistant';
                    const content = e.role === 'user' && e.image
                        ? userContentWithImage(e.text, { kind: 'image', payload: e.image }, soloProvider.selectedModel)
                        : e.text;
                    return [{ role, content } as ChatMessage];
                }),
                { role: 'user', content: userContent },
            ];
            try {
                await runSeatTurn({ sid, entryId: aiEntry.id, config: soloProvider, messages, mailboxSeat: '' });
            } catch (e) {
                // An explicit Stop throws a transport AbortError — that is a
                // user action, not a failure: the bubble keeps what streamed
                // (already settled by runSeatTurn) instead of being stamped
                // with a failure row.
                if (!controller.signal.aborted) {
                    // The CANONICAL sanitizer (utils/runStatus), the same one the
                    // Agents surface uses: an unredacted provider message can carry
                    // a credential-shaped token, and this string is persisted into
                    // the session and out into a backup.
                    const message = sanitizeErrorText(e);
                    // The REAL reason, in the ERROR field and not the text: a
                    // failed turn written into the answer reads as though the
                    // seat had said the app's own hint, and it was committed to
                    // the bot's memory as if it were an answer.
                    //
                    // It is stamped whether or not prose arrived. The old
                    // `&& !en.text` guard meant a turn that streamed
                    // "Long BTC above 65,000, stop 64,200, target…" and then
                    // FAILED kept the half-sentence looking like finished advice,
                    // with the missing half exactly where the risk numbers were.
                    // A row with text is stamped `interrupted` too, so the dock
                    // renders the one "Run stopped" card with the reason in it —
                    // prose and failure, never prose alone.
                    mutate(sid, s => ({
                        ...s,
                        entries: s.entries.map(en => en.id === aiEntry.id
                            ? settleDockEntry({
                                ...en,
                                workedMs: workedMsFor(soloStartedAt),
                            }, 'failed', { error: message, hasText: !!(en.text && en.text.trim()) })
                            : en),
                    }));
                }
            } finally {
                mutate(sid, s => ({ ...s, entries: s.entries.map(en => (en.id === aiEntry.id ? settleDockEntry({ ...en, ...(en.workedMs === undefined ? { workedMs: workedMsFor(soloStartedAt) } : {}) }, 'completed') : en)) }));
                endRunOwned(sid, controller);
                maybeReviewSessions(learnerCfg);
                // THE TURN HAS TO TEACH THE BOT. `recordBotTurnOutcome` writes
                // the lesson into this bot's own memory.md and feeds a closed
                // bot-authored trade into the shared skills/evidence path. The
                // mailbox and the group rooms both call it on
                // every reply — this dock did not, so asking a bot something
                // in Chart AI taught it NOTHING, while the same question in
                // the Agents surface did. A bot's memory was whichever surface
                // you happened to use, which is not a property anyone would
                // defend.
                //
                // Fire-and-forget on purpose, matching all three siblings: a
                // failed lesson write must never turn a delivered answer into
                // a failed turn.
                const usernameNow = getActiveUsername();
                const settledText = chatStore.getSnapshot().sessions
                    .find(x => x.id === sid)?.entries.find(en => en.id === aiEntry.id)?.text ?? '';
                // Only a real answer is committed. The stop placeholder and
                // the "could not answer" text would put a failed turn into
                // the conversation as though the seat had said something.
                const settled = !!settledText.trim() && !/^Running the full ensemble/.test(settledText);
                if (bot) {
                    if (settled) onBotTurnCommit?.(bot, text, settledText, workedMsFor(soloStartedAt), turnEffort);
                } else if (settled && turnConversationId) {
                    // Under the id the pane is ALREADY showing this answer by, so
                    // the Chat thread gains the row and this pane does not double
                    // it — see `onSoloTurnCommit`. `streaming: false` is said here
                    // as well as by the mirror's flush: a host with no mirror must
                    // still settle the row it was given.
                    onSoloTurnCommit?.(
                        { id: aiEntry.id, role: 'ai', text: settledText, streaming: false, workedMs: workedMsFor(soloStartedAt), effort: turnEffort },
                        turnConversationId,
                    );
                }
                // Stops the mirror and flushes the entry's final state — the
                // settled text, or the error and `streaming: false` of a turn
                // that never answered. Nothing may leave a live row in the
                // conversation once this run is over.
                mirror?.stop();
                if (registersConversation && turnConversationId) {
                    // Owned release: a pipeline run that took this conversation
                    // in the meantime keeps its own registration.
                    chatStore.endConversationRunOwned(turnConversationId, controller);
                }
                if (bot && usernameNow) {
                    const answered = chatStore.getSnapshot().sessions
                        .find(x => x.id === sid)?.entries.find(en => en.id === aiEntry.id)?.text ?? '';
                    if (answered.trim()) {
                        void recordBotTurnOutcome(bot, text, answered, {
                            username: usernameNow,
                            trades,
                        });
                    }
                }
            }
            return;
        }

        // ── PANEL: up to 5 models, one request, cross-talk + synthesis ─────
        const seats = panelSeats(session, formatModelDisplayName, id => bots.find(b => b.id === id)?.name);
        if (seats.length < 2) {
            // Say it out loud — a bare return left the user staring at their
            // own message (and leaked the run controller armed above). The
            // user bubble is already painted (optimistic), so just append the
            // notice.
            mutate(sid, s => ({
                ...s,
                entries: [...s.entries, {
                    id: newId('n'), role: 'ai' as const, text: '',
                    tools: ['This panel has fewer than 2 usable seats — add models or agents in the panel picker above.'],
                    notice: true,
                }],
            }));
            endRunOwned(sid, controller);
            return;
        }
        const mailbox = createPanelMailbox(seats.map(s => s.name));
        const spoken: string[] = [];
        const unavailableNotified = new Set<string>();
        // Seats a prior speaker @mentioned but hasn't talked yet — they jump
        // the round-robin queue so cross-talk actually routes.
        const pull: string[] = [];
        const room: { seatId: string; text: string; synthesis?: boolean }[] = [];
        const nameFor = (seatId: string): string => seats.find(s => s.id === seatId)?.name ?? seatId;
        // The user bubble was already painted optimistically above; seats
        // stream into their own entries appended inside the loop.
        try {
            for (let guard = 0; guard < PANEL_MAX_MODELS + 2; guard += 1) {
                const plan = planPanelTurn(seats, spoken, pull);
                if (!plan.seat) break;
                const seat = plan.seat;
                const seatBot = seat.botId ? bots.find(b => b.id === seat.botId) : undefined;
                // An agent seat answers with its OWN model first: the panel was
                // configured with the model, but the roster may since have
                // moved the bot — the bot's current pair is the truer read.
                const seatConfig = configForSeat(seat.providerId, seat.modelId)
                    ?? (seatBot ? configForSeat(seatBot.providerId, seatBot.modelId) : null);
                if (!seatConfig) {
                    // The seat's provider/model vanished from Settings — say so
                    // in the transcript; a silent skip looked like a hang.
                    // Once per seat (the synthesis pass would repeat it).
                    spoken.push(seat.id);
                    if (!unavailableNotified.has(seat.id)) {
                        unavailableNotified.add(seat.id);
                        mutate(sid, s => ({ ...s, entries: [...s.entries, {
                            id: newId('n'), role: 'ai' as const, text: '', streaming: false, notice: true,
                            speaker: seat.name,
                            tools: [`Seat unavailable — "${seat.name}" is no longer configured (Settings → Providers). Remove it or re-add its model.`],
                        }] }));
                    }
                    continue;
                }
                const roomTranscript = formatRoomTranscript(room, nameFor);
                const turnIntro = plan.isSynthesis
                    ? 'You are the LAST seat. Write ONE final answer for the user that synthesizes the whole panel above: agree where they agree, name where they disagree, and give the single actionable read of this chart. Keep every memory/skill/tool proposal you make explicitly labeled.'
                    : roomTranscript
                        ? 'Answer the user for this chart. Other seats already spoke (shown above) — build on or rebut their read, do not repeat it. You can @Name another seat to pull it into the conversation next, or send_message to a peer seat by name mid-turn to compare a number.'
                        : 'You are the first seat to answer for this chart.';
                const userMsg = `${userText}\n\n${turnIntro}${roomTranscript ? `\n\n${roomTranscript}` : ''}`;
                const aiEntry: LiveEntry = {
                    id: newId('a'), role: 'ai', text: '', tools: [], streaming: true,
                    speaker: seat.name,
                    at: Date.now(),
                };
                mutate(sid, s => ({ ...s, entries: [...s.entries, aiEntry] }));
                // An agent seat keeps its own mandate AND the panel's: the seat
                // still has to know it is one voice among N on this chart, which
                // the roster persona alone never says.
                const panelMandate = `You are "${seat.name}" on a ${seats.length}-seat chart panel. Seats: ${seats.map(x => x.name).join(', ')}.`;
                // The panel used to pass a bare string here and drop the
                // screenshot on the floor: the user attached a chart, saw it
                // in their own bubble, and every seat answered without it.
                // Decided per seat, because a panel can mix vision and
                // text-only models, and a seat that cannot see the image is
                // told so rather than left to invent a read of it.
                const seatContent = userContentWithImage(userMsg, imageAttachment, seatConfig.selectedModel);
                const messages: ChatMessage[] = [
                    { role: 'system', content: systemPromptFor(seatBot, panelMandate) },
                    { role: 'user', content: seatContent },
                ];
                let full = '';
                let seatFailed = false;
                // This seat's own clock, from the moment ITS bubble was painted —
                // a panel's seats start at different times, so each reports its
                // own duration rather than the room's.
                const seatStartedAt: number | undefined = aiEntry.at;
                const seatActions: string[] = [];
                try {
                    full = await runSeatTurn({
                        sid,
                        entryId: aiEntry.id,
                        config: seatConfig,
                        messages,
                        mailboxSeat: seat.name,
                        mailbox,
                        hidePass: true,
                        onAction: line => seatActions.push(line),
                        onMailSent: info => mutate(sid, s => ({
                            ...s,
                            entries: s.entries.map(e => (e.id === aiEntry.id
                                ? { ...e, tools: [...e.tools, formatDmEventLine({ from: info.from, toLabel: info.to, text: info.text, toKey: info.to.toLowerCase(), round: 0 })] }
                                : e)),
                        })),
                    });
                } catch (e) {
                    // SETTLE THE ROW IN BOTH DIRECTIONS. A seat that threw after
                    // partial text used to keep streaming:true forever — and a
                    // STOPPED seat was skipped entirely by the `!aborted` guard,
                    // so one Stop left a bubble spinning for the rest of the
                    // session and blocked the store from persisting (the 2026-10-27 audit
                    // L-4). A stop is not a failure: it keeps what streamed and
                    // says why the bubble is short.
                    //
                    // Through the ONE settlement rule (utils/rowSettlement.ts),
                    // not a third hand-rolled branch: a Stop is interrupted, a
                    // failure WITH prose is interrupted-with-cause, and a failure
                    // with no prose is the failure row itself — the old
                    // "(this seat failed to answer)" prose read as an answer.
                    seatFailed = true;
                    const msg = e instanceof Error ? e.message : String(e);
                    const aborted = controller.signal.aborted;
                    mutate(sid, s => ({ ...s, entries: s.entries.map(en => (en.id === aiEntry.id
                        ? settleDockEntry(
                            {
                                ...en,
                                workedMs: workedMsFor(seatStartedAt),
                                ...(aborted && !en.text ? { text: '(stopped)' } : {}),
                            },
                            aborted ? 'stopped' : 'failed',
                            { ...(aborted ? {} : { error: msg }), hasText: !!en.text },
                        )
                        : en)) }));
                }
                spoken.push(seat.id);
                if (!seatFailed && isPassReply(full)) {
                    // Silence is not a turn: drop the empty bubble and keep
                    // the pass out of the room the peers + synthesis read.
                    mutate(sid, s => ({ ...s, entries: s.entries.filter(e => e.id !== aiEntry.id) }));
                    continue;
                }
                // Route this seat's @mentions to the front of the queue.
                for (const mentioned of parsePanelMentions(full, seats, seat.id)) {
                    if (!spoken.includes(mentioned) && !pull.includes(mentioned)) pull.push(mentioned);
                }
                // Peers + the synthesis SEE this seat's memory/skill/tool
                // edits, so the panel co-authorizes its own growth.
                const roomText = seatActions.length > 0
                    ? `${full || '(no answer)'}\n\n[side-effects: ${seatActions.join('; ')}]`
                    : (full || '(no answer)');
                room.push({ seatId: seat.id, text: roomText, synthesis: plan.isSynthesis });
            }
        } finally {
            endRunOwned(sid, controller);
            maybeReviewSessions(learnerCfg);
        }
    };

    /** "Run full analysis" — the ensemble pipeline, on the ACTIVE conversation.
     *  It writes no transcript row here: the pipeline appends the question and
     *  its streaming answer to the conversation, and the dock renders that
     *  conversation through `entriesForSession`. What it keeps is the session's
     *  run slot — that flag is what turns the composer's send into Stop and
     *  blocks a second send while the first is still in flight. */
    const runFullAnalysis = async (): Promise<void> => {
        const text = draft.trim();
        // Fresh store read, same double-submit defense as send().
        if (!text || !onRunAnalysis || chatStore.getSnapshot().running[activeId]) return;
        setDraft('');
        const sentAttachments = attachments;
        const images = attachedImages();
        clearAttachments();
        const fileNote = sentAttachments.filter(a => a.kind === 'file')
            .map(a => `\n\n[ATTACHED FILE — ${a.name}]\n${a.payload.slice(0, MAX_FILE_CHARS)}`)
            .join('');
        const sid = activeId;
        const controller = new AbortController();
        chatStore.beginRun(sid, controller);
        try {
            await onRunAnalysis(text + fileNote, images);
        } catch (e) {
            onAnalysisError?.(e instanceof Error ? e.message : String(e));
        } finally {
            chatStore.endRunOwned(sid, controller);
        }
    };

    /** Run one queued harness signal (a level-watch price event) as a model
     *  turn: a notice row shows the event, then the model warns the user.
     *  The signal text is synthesized as the user message — it never renders
     *  as a user bubble. Modelled on runFullAnalysis: it arms its own
     *  controller and bypasses the composer's busy/empty guards (the queue
     *  lives in chatStore, so a hit that lands mid-run or mid-unmount is
     *  never dropped — the drain effect in the shell flushes it when idle). */
    const runHarnessTurn = async (signalText: string): Promise<void> => {
        const sid = chatStore.getActiveId();
        const current = chatStore.getSnapshot();
        if (current.running[sid]) return; // busy — stays queued, flushed on idle
        const session = current.sessions.find(s => s.id === sid);
        if (!session) return;
        // Routes to the ACTIVE session even when the plan belongs to another
        // symbol/session — the dock has one transcript; deliberate v1 scope.
        const bot = bots.find(b => b.id === session.botId);
        const seatModel = session.kind === 'panel' ? session.panelModels?.[0] : undefined;
        const config = (seatModel ? configForSeat(seatModel.providerId, seatModel.modelId) : null)
            ?? (bot ? configForSeat(bot.providerId, bot.modelId) : null)
            ?? provider;
        if (!config) return;
        // The notice is the EVENT's first sentence, machine-tag stripped. The
        // signal's last line is the MODEL'S orders ("Warn the user now…") and
        // must never reach the transcript as an amber row — the composers now
        // put it on its own line, and the sentence cut keeps even an old
        // single-line signal honest (a '. ' cut is price-decimal-safe:
        // "85184.5," has no dot-space).
        const noticeLine = harnessNoticeLine(signalText);
        const noticeEntry: LiveEntry = { id: newId('n'), role: 'ai', text: '', tools: [noticeLine], notice: true, at: Date.now() };
        const aiEntry: LiveEntry = { id: newId('a'), role: 'ai', text: '', tools: [], streaming: true, at: Date.now(), ...(bot ? { speaker: bot.name } : {}) };
        const harnessStartedAt: number | undefined = aiEntry.at;
        mutate(sid, s => ({ ...s, updatedAt: Date.now(), entries: [...s.entries, noticeEntry, aiEntry] }));
        const controller = new AbortController();
        chatStore.beginRun(sid, controller);
        const contextBlock = await buildContextBlock();
        if (controller.signal.aborted) {
            mutate(sid, s => ({ ...s, entries: s.entries.filter(e => e.id !== aiEntry.id) }));
            endRunOwned(sid, controller);
            return;
        }
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPromptFor(bot) },
            ...session.entries.slice(-10).flatMap(e =>
                e.text.trim() && !e.notice ? [{ role: e.role === 'user' ? 'user' : 'assistant', content: e.text } as ChatMessage] : []),
            { role: 'user', content: `${contextBlock}\n\n${signalText}` },
        ];
        try {
            await runSeatTurn({ sid, entryId: aiEntry.id, config, messages, mailboxSeat: '' });
        } catch (e) {
            // A Stop of a harness warning is not a failure to narrate.
            if (!controller.signal.aborted) {
                const message = e instanceof Error ? e.message : String(e);
                // The one settlement rule: the provider's reason is the row's
                // ERROR, not a sentence pasted into its text (which rendered as
                // though the seat had said it). A partial warning keeps its
                // prose and is marked interrupted with the cause.
                mutate(sid, s => ({ ...s, entries: s.entries.map(en => (en.id === aiEntry.id
                    ? settleDockEntry(en, 'failed', { error: message, hasText: !!en.text })
                    : en)) }));
            }
        } finally {
            const stopped = controller.signal.aborted;
            mutate(sid, s => ({
                ...s,
                entries: s.entries
                    // A stopped warning that never produced a word is not a row:
                    // the amber harness notice above it already says the event
                    // happened, and an empty answer bubble says the opposite.
                    .filter(en => !(stopped && en.id === aiEntry.id && !en.text.trim()))
                    .map(en => (en.id === aiEntry.id
                        ? settleDockEntry(
                            { ...en, ...(en.workedMs === undefined ? { workedMs: workedMsFor(harnessStartedAt) } : {}) },
                            stopped ? 'stopped' : 'completed',
                        )
                        : en)),
            }));
            endRunOwned(sid, controller);
        }
    };

    return { send, runFullAnalysis, runHarnessTurn };
};
