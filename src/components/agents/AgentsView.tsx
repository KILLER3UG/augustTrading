/**
 * AgentsView — the Agents surface, not a roster that bounces you somewhere
 * else (WS-6). Reached from the nav as "Chat"; the surface id and every
 * testid still say `agents`, because a dozen gates pin them independently of
 * the label.
 *
 * Three regions, mirroring the reference: a conversation rail, a main pane,
 * and one pill composer.
 *
 * The rail is chat-only (mock-redesign-v3): it reuses `ConversationGroups`
 * so its rows are byte-identical to ShellRail's. No Goals/Agents/Rooms
 * groups on this surface — bots and rooms live on their own surfaces.
 *
 * ⚠️ TWO STORES, ONE THREAD — this banner used to claim the opposite.
 *
 *  - this surface reads App's `messages` (useConversations) and slices it
 *    with `utils/agentThreads`;
 *  - the Chart AI dock reads and writes `services/trade/chatStore.ts`, a
 *    module singleton that survives unmount so a running stream is not
 *    aborted by a surface switch.
 *
 * Two row SHAPES, one thread: `startEntryMirror` (`services/trade/chatTurnMirror.ts`)
 * projects the dock's live entry into the conversation under the SAME id, and
 * `liveEntryFromMessage` (`services/trade/chatSessions.ts:491`) carries `Message.isStreaming`
 * back, so a Chat-surface run keeps its activity line when the trader hops.
 * The old banner ("DO NOT SHARE A STORE TODAY") was true of the arrays and
 * false of the thread, which is the unit the trader sees.
 * A conversation opened here and on the Chart surface is one conversation;
 * `docs/architecture/system-map.md` states the contract (its unit suite went with the suite, 2026-10-23).
 *
 *  - a send routes on WHAT IS SELECTED, not on a mode switch (there is no
 *    switch any more): a bot answers through `runUserBotTurn`, the same
 *    transport the DM mailbox uses; nothing selected hands the text to
 *    `handleSendMessage` — the real pipeline, so the desk tools and memory
 *    run exactly as they do from the dock, and the verdict
 *    comes back as an ordinary message in the same array.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Bot, ChevronDown, Ellipsis, MessageSquare, Pencil, PanelRight, Paperclip, Pin, Plus, Search, StopIcon, Trash2, Users } from '../shared/Icons';
import JumpToLatestFab, { JUMP_AWAY_PX } from '../shared/JumpToLatestFab';
import { ModelFallbackBanner } from '../trade/panels/ChatComposer';
import type { ProviderConfig } from '../../types/provider';
import { useChatAttachments, type PipelineImage } from '../../hooks/useChatAttachments';
import { DISCLAIMER_SHORT } from '../../constants/disclaimer';
import * as chatStore from '../../services/trade/chatStore';
import ChatTranscriptRow, { type ChatRowView } from '../shared/ChatTranscriptRow';
import { BotAvatar } from '../chat/BotAvatar';
import DetailModal from '../shared/DetailModal';
import AgentDetailCard from './AgentDetailCard';
import { formatModelDisplayName } from '../../utils/providerUtils';
import SymbolPicker from '../trade/SymbolPicker';
import TimeframeBar from '../trade/TimeframeBar';
import type { ChartInterval } from '../../utils/chartIntervals';
import { useSymbolUniverse } from '../../hooks/useSymbolUniverse';
import { MENU_W, RowMenu, type RowMenuItem } from './RowMenu';
import ActiveGoalChip from './ActiveGoalChip';
import type { AgentBot, AgentGroup } from '../../services/agents/agentRoster';
import { groupDisplayName } from '../../services/agents/agentRoster';
import type { Conversation } from '../../types';
import type { BotLearningStat } from '../../services/agents/botLearning';
import {
    deskThread, markThreadOpened, previewTextFor, threadForProvider, unreadCount,
    type AgentThreadOpenedMap, type ThreadSelection,
} from '../../utils/agentThreads';
import { MessageRole } from '../../types/enums';
import { useBackgroundCompaction } from '../../hooks/useBackgroundCompaction';
import { resolveCompactionComplete } from '../../services/trade/contextCompactionJob';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../utils/contextWindow';
import type { Message } from '../../types/message';
import { messageTraceText } from '../../utils/traceText';
import { activeIndex, versionCount } from '../../utils/messageVersions';
import StatusPill from '../ui/StatusPill';
// The shell's own column width, imported rather than repeated: this surface's
// sidebar and the rail are ONE shell, and two numbers is how the hop started
// jumping between them.
import { NAV_RAIL_EXPANDED_PX } from '../shell/shellChrome';
import SidebarToggle from '../shell/SidebarToggle';
import { ConversationGroups } from '../shell/ConversationGroups';
import { conversationTitle } from '../../utils/conversationTitle';
import AgentsDock from './dock/AgentsDock';
import InlineVerdict from '../analysis/InlineVerdict';
import TradeProposalCard, { TradeProposalLoggedRow } from '../trade/panels/TradeProposalCard';
import { proposalStateOf, rememberProposalState } from '../../services/trade/proposalDisposition';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import { mintPlanId } from '../../services/trade/proposedTrade';
import { planFromProse } from '../../services/trade/tradeShapedProse';

interface AgentsViewProps {
    username: string;
    bots: AgentBot[];
    groups: AgentGroup[];
    messages: Message[];
    selection: ThreadSelection;
    onSelect: (t: ThreadSelection) => void;
    onNewBot: () => void;
    onNewGroup: () => void;
    /** Chat mode: the bot's own DM transport (App's mailbox). */
    onSendBotTurn: (bot: AgentBot, prompt: string) => Promise<boolean>;
    /** The SAME pipeline entry the Chart AI dock runs — not a weaker local copy.
     *  It resolves when the run ENDS and rejects with the reason (a run already
     *  going, no provider configured, a verdict-less exit). It writes its own
     *  rows into the active conversation, which is the thread this surface and
     *  the dock both render — so this component must not also record the turn.
     *  The rejection is the only thing that never reaches a transcript row, and
     *  it is reported as a toast for that reason. */
    onAnalyze: (prompt: string, images: PipelineImage[]) => Promise<void>;
    /** Log a plan the model PRESENTED on this surface — the same journal entry
     *  the Chart AI dock writes, through the same App handler. Without it the
     *  card still shows (the plan is the model's, not the journal's), but its
     *  Log button is hidden rather than clicking into nothing. */
    onLogProposedTrade?: (proposal: TradeProposal) => void | Promise<boolean>;
    /** Where a run that never started says why. The pipeline writes its own rows
     *  — including its error bubble — once it is running, so the only silent
     *  failures left are the pre-flight ones ("already running", "no providers"),
     *  which have no transcript row to carry them. App routes this to a toast;
     *  this surface holds no notification of its own. */
    onAnalysisError?: (message: string) => void;
    /** Ends the run this surface started. Without it the send button never
     *  turns into Stop and a running analysis cannot be cancelled here. The
     *  press names its target — the pipeline, a dock turn in this thread, or
     *  the bot whose composer was used — because App cannot guess it: two
     *  bots can be streaming at once, and a first-match abort kills the
     *  wrong turn. */
    onStopRun?: (target: { kind: 'analysis' } | { kind: 'dock'; conversationId: string } | { kind: 'bot'; botId: string }) => void;
    /** Bots whose mailbox is streaming right now (queue-drained or user
     *  turns) — gives THIS composer's Stop the queue-drained case, which the
     *  local `busy` never sees. */
    mailboxBusyBotIds?: string[];
    /** The pipeline's own run flag. This surface unmounts when you hop to
     *  Trade, which resets the local `busy` to false mid-run — so Stop is
     *  derived from the run, not only from this component's state, or a hop
     *  and a return leaves a live analysis with no Stop and no double-send
     *  guard. */
    analysisRunning?: boolean;
    /** App renders the existing room view; this surface only hosts it. */
    renderGroup?: (group: AgentGroup) => React.ReactNode;
    workingBotId?: string | null;
    lastOpenedMap?: AgentThreadOpenedMap;
    /** botId → one-line "cannot do its job" hint (the rail's ⚠ badge). */
    attentionMap?: Record<string, string>;
    onDeleteBot?: (botId: string) => void;
    onDeleteGroup?: (groupId: string) => void;
    onEditGroup?: (groupId: string) => void;
    /** WS-3.4: what each bot has learned — lessons, skills authored, evidence.
     *  Shown on the active bot's header and as a row badge. */
    botStats?: BotLearningStat[];
    /** Rename a bot in place (WS-6's row affordances). */
    onRenameBot?: (botId: string, name: string) => void;
    /** The composer's model control — the dock's own `ModelChip`, built by the
    /** The composer's model control — the dock's own `ModelChip`, built by the
     *  host so this surface gets the identical panel (provider, model and the
     *  thinking tier in one place) instead of a plainer twin of it. It is a
     *  render prop because one rule needs this surface's selection: a bot turn
     *  answers on the bot's own config, so the panel shows no Effort section
     *  (`showEffort: false`) rather than showing a dial nothing reads. */
    modelPicker?: (opts: { showEffort: boolean }) => React.ReactNode;
    /** Why the stored chat model cannot answer, and what will instead (stage 3
     *  F4b). The Agents surface runs the same solo pick as the dock, so it must
     *  carry the same amber warning — hidden while a bot is selected, because a
     *  bot answers from its own config and the pick is irrelevant to it. */
    modelFallback?: { issue: string; provider: ProviderConfig } | null;
    /** The account + Settings row, for the same reason. */
    accountRow?: React.ReactNode;
    /** The shell's status cluster (save state, offline, Activity). Handed in for
     *  the same reason as the destinations: the sidebar now runs the full height
     *  of the window, so this surface renders NO global band, and the controls
     *  that used to live in it need a home in the one title bar this surface
     *  has. Same component the other surfaces' band uses — not a copy. */
    /** The column's own put-away (the rail's Chats icon drives the same one). */
    /** The SAME left-column state every other surface drives, handed in rather
     *  than re-derived per profile. This surface used to keep its own collapse
     *  key and its own width, so the Chat ⇄ Chart AI hop restacked the shell:
     *  the sidebar jumped 320→240px and the header's "Expand navigation" drove
     *  a rail that was not mounted here. One state, one width, and the switch
     *  changes only what the column lists — which is what the reference does
     *  between its chat and code modes. */
    railExpanded?: boolean;
    /** The WHOLE navigation rail's state. `railExpanded` above folds this
     *  surface's own column into it; the title-row toggle is about the rail
     *  alone, so it needs the un-folded value. */
    sidebarExpanded?: boolean;
    onToggleRailExpanded?: () => void;
    /** The dragged rail width, owned by App so the shell rail and this column
     *  agree across the Analyze ⇄ Agents hop. */
    railWidth?: number;
    railIsResizing?: boolean;
    onRailResizeStart?: (event: React.PointerEvent) => void;
    onRailResizeReset?: () => void;
    /* ── Revert and versions (2026-10-27) ──
       All optional, and all owned by App's conversation store rather than by
       this surface: one conversation has two readers, so the rule that decides
       what a revert does lives in `useConversations` and both homes call it. */
    /** Park every turn after this one. Returns how many moved. */
    onRevertTo?: (messageId: string) => number;
    /** Save a new wording for a sent prompt and re-ask it. */
    onEditPromptMessage?: (messageId: string, newText: string) => void;
    /** Step which generation of an answer is showing. */
    onStepVersion?: (messageId: string, delta: number) => void;
    /** Turns taken off this thread by past reverts, newest tail last. */
    parkedCount?: number;
    /** Bring the most recently parked tail back. */
    onRestoreParked?: () => number;
    onHydratePins?: (pins: string[]) => void;
    /** The App-side conversations (useConversations). Stage 3 made this rail
     *  the ONE conversation home: these render as their own section here
     *  instead of the nav rail's SESSIONS list. Loading one resets the
     *  selection to the desk pane, which is where its messages render. */
    conversations?: Conversation[];
    activeConversationId?: string | null;
    onLoadConversation?: (id: string) => void;
    onDeleteConversation?: (id: string) => void;
    /** Empty one conversation (keep the row, drop its messages) — the
     *  command palette's "Clear current chat" rehomed onto the row menu. */
    onClearConversation?: (id: string) => void;
    /** Start a new App conversation (the old nav-rail "New chat" row). */
    onNewChat?: () => void;
    /** Store the silent 80% compaction digest for a conversation. Called from
     *  an idle callback, so it may name a conversation that is no longer the
     *  active one. */
    onSetThreadSummary?: (id: string, summary: string) => void;
}

const PIN_KEY = (user: string): string => `agent_pins_v1_${user}`;

const loadPins = (user: string): string[] => {
    try { return JSON.parse(localStorage.getItem(PIN_KEY(user)) || '[]') as string[]; } catch { return []; }
};

/** The ONE duration formatter: elapsed milliseconds → the compact label the
 *  rail prints (`now`, `45m`, `6h`, `8d`).
 *
 *  It takes a DURATION, never a stamp. The bug this replaces subtracted
 *  `Date.now()` twice — `relTime` computed `Date.now() - Date.parse(iso)` and
 *  handed that duration to `relTimeMs`, which subtracted `Date.now()` again,
 *  so an 8-day-old row printed `20731d` (the epoch leaking through). Every
 *  elapsed label on this surface must come from here so there is exactly one
 *  place a duration is turned into text. */
const durationLabel = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.round(h / 24)}d`;
};

/** Elapsed since an ISO stamp; '' when the stamp is missing or unparseable. */
const relTime = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return '';
    return durationLabel(Date.now() - at);
};

/** Adapt a pipeline `Message` onto the shared row view, so this surface and
 *  the Chart AI dock render one transcript furniture rather than two.
 *
 *  Everything here is data the pipeline already wrote: the thought trace, the
 *  tool side-effects, attached images, the analysis. The trace is joined by
 *  `messageTraceText` — ONE seam that folds the deleted debate engine's
 *  legacy lane in, so this surface and the dock read the same trace. */
const chatRowFrom = (m: Message, username: string, deskName: string): ChatRowView => {
    const trace = messageTraceText(m);
    // The trail, one line per entry. `liveToolEvents` is the capped,
    // newline-JOINED live feed — read as a list it is ONE row holding every
    // line, which is why the Agents surface's tool rows never paired. The
    // settled trail is `toolEvents`; the live feed is the fallback, and its
    // newlines are split so an older row still draws one row per line.
    const liveFeed = Object.values(m.liveToolEvents ?? {})
        .flatMap(feed => feed.split('\n'))
        .filter(line => line.trim().length > 0);
    const trail = m.toolEvents && m.toolEvents.length > 0 ? m.toolEvents : liveFeed;
    const startedAtMs = m.createdAt ? Date.parse(m.createdAt) : NaN;
    return {
        id: m.id,
        role: m.role === MessageRole.USER ? 'user' : 'ai',
        text: m.text || '',
        speaker: m.role === MessageRole.USER ? username : (m.botId ? deskName : 'desk'),
        timeLabel: relTime(m.createdAt),
        streaming: !!m.isStreaming,
        images: m.images,
        reasoning: trace.length > 0 ? trace : undefined,
        toolLines: trail,
        // The payload ids, so the tool rows can open onto the real output —
        // the expander is the dock's one job the Agents surface could not do.
        toolIds: m.toolIds,
        // What the wire was asked, so the row can say WHY a turn has no trace.
        wireAudit: m.wireAudit,
        // A failed turn is a row of its own, not an answer.
        error: m.error,
        // A run that stopped before it finished. Settled by
        // `utils/rowSettlement.ts`; without this projection the in-flow
        // "Run stopped" notice could never render on this surface.
        interrupted: m.interrupted,
        actions: m.toolActions,
        workedMs: typeof m.runStats?.durationMs === 'number' ? m.runStats.durationMs : undefined,
        startedAt: Number.isFinite(startedAtMs) ? startedAtMs : undefined,
        // The thinking tier this answer was produced under, so the row can
        // show it — the run's own record of how hard the model was asked to
        // think, which no amount of reading the text can recover.
        effort: m.runStats?.effort,
        // A planId-stamped row is the "Logged from Chart AI" RECEIPT of a
        // proposal whose decision card is already on screen — under the answer
        // that proposed it here, and on the dock's proposal card. Its analysis
        // is a copy carried for the journal row and the autopilot, so passing
        // it through here would render the identical ENTRY/STOP/TARGET/
        // PROBABILITY card a second time in the same turn. One fact, one
        // carrier: the card belongs to the answer, not to its receipt.
        analysis: m.planId ? undefined : m.analysis,
    };
};

/** Time-aware, per the reference's greeting — this surface is otherwise empty
 *  chrome, so the one thing it can say that's true is when you are. */
const greeting = (name: string): string => {
    const h = new Date().getHours();
    const part = h < 5 ? 'still up' : h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
    return h < 5 ? `Still up, ${name}?` : `${part}, ${name}`;
};

// ─── Rail row ───────────────────────────────────────────────────────────────

const Row: React.FC<{
    active: boolean;
    title: string;
    preview: string;
    time?: string;
    unread?: number;
    working?: boolean;
    pinned?: boolean;
    /** One-line "this bot cannot do its job" hint; the ⚠ carries it as tooltip. */
    attention?: string;
    onPin?: () => void;
    /** Hover actions: edit / delete — the roster affordances the old rail
     *  owned, kept reachable now that this surface replaced its row model. */
    manage?: React.ReactNode;
    /** WS-6 §5's context menu. The same handlers the hover icons carry, plus
     *  pin, so right-clicking a row is not a second-class path. */
    actions?: RowMenuItem[];
    /** Tiny mono count after the name — skills this bot authored. */
    stat?: number;
    /** Row identity for tests — the desk's own row needs its own. */
    testId?: string;
    children?: React.ReactNode;
    Icon: React.FC<{ className?: string }>;
    /** Identity graphic for this row. A bot's own `BotAvatar` face replaces the
     *  generic outlined glyph — the same mark the thread bylines and the roster
     *  already use, so a bot looks like the same bot in every list. */
    avatar?: React.ReactNode;
    onClick: () => void;
}> = ({ active, title, preview, time, unread, working, pinned, attention, onPin, manage, actions, stat, testId = 'agent-row', children, Icon, avatar, onClick }) => {
    const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
    const hasActions = !!actions && actions.length > 0;
    return (
        <div className={`group relative ${active ? 'bg-zinc-800/70' : 'hover:bg-zinc-800/30'} rounded-control`}
            onContextMenu={e => {
                // No actions for this row → leave the native menu alone.
                if (!hasActions) return;
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY });
            }}>
            <div className="flex items-start gap-2 px-2 py-1.5">
                <button type="button" onClick={onClick} data-testid={testId} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    {avatar ?? (
                        /* The reference's rows carry a PLAIN glyph — a small
                           chat mark, not a ring around every row, which made a
                           list of medallions. The state still reads: the working
                           row's mark is amber, the active row's is bright. */
                        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${
                            working ? 'text-amber-300' : active ? 'text-zinc-300' : 'text-zinc-600'
                        }`}>
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                    )}
                    <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 truncate text-ui-sm text-zinc-200" title={title}>{title}</span>
                            {attention && (
                                <span title={attention} data-testid="row-attention"
                                    className="shrink-0 text-ui-2xs font-bold text-amber-400">⚠</span>
                            )}
                            {!!stat && (
                                <span title={`${stat} skills authored`} data-testid="row-skills"
                                    className="shrink-0 rounded-full border border-zinc-800 px-1 font-mono text-ui-2xs tabular-nums text-zinc-500">
                                    {stat}
                                </span>
                            )}
                        </span>
                        <span className="block truncate text-ui-dense text-zinc-500" title={preview || 'No messages yet'}>{preview || 'No messages yet'}</span>
                    </span>
                </button>
                <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                    <span className="flex items-center gap-1">
                        {time && <span className="font-mono text-ui-2xs text-zinc-600">{time}</span>}
                        {!!unread && (
                            <span className="rounded-full bg-zinc-700 px-1.5 font-mono text-ui-2xs tabular-nums text-zinc-200">
                                {unread > 9 ? '9+' : unread}
                            </span>
                        )}
                    </span>
                </span>
                {/* The row's actions lie OVER the row instead of beside it. In
                    flow they cost 150px of a 223px row PERMANENTLY — every one of
                    them invisible until hover — which left 21px for the bot's
                    NAME, the one line that has to be readable. Absolutely
                    positioned, the name gets the whole row and the controls still
                    arrive on hover and on keyboard focus. A pinned row shows its
                    pin at rest, because that state is information, not an action. */}
                {(onPin || manage || hasActions) && (
                    <span className={`absolute right-1 top-1.5 flex items-center gap-1 rounded-control bg-zinc-900/95 px-1 transition-opacity ${
                        pinned ? 'pointer-events-auto opacity-100'
                            : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
                    }`}>
                        {onPin && (
                            <button type="button" onClick={onPin} aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
                                className={`hit-target rounded-control p-0.5 transition-colors ${
                                    pinned ? 'text-zinc-400' : 'text-zinc-600 hover:text-zinc-200'
                                }`}>
                                <Pin className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                        {manage}
                        {hasActions && (
                            <button type="button" aria-label={`${title} options`} data-testid="row-menu"
                                onPointerDown={e => e.stopPropagation()}
                                onClick={e => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    setMenuAt(m => m ? null : { x: r.right - MENU_W, y: r.bottom + 4 });
                                }}
                                className="hit-target rounded-control p-0.5 text-zinc-600 transition-colors hover:text-zinc-300">
                                <Ellipsis className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                    </span>
                )}
            </div>
            {children}
            {menuAt && actions && actions.length > 0 && createPortal(
                <RowMenu x={menuAt.x} y={menuAt.y} items={actions} onClose={() => setMenuAt(null)} />,
                document.body,
            )}
        </div>
    );
};


// ─── The view ───────────────────────────────────────────────────────────────

interface BotRow {
    bot: AgentBot;
    preview: string;
    time: string | null;
    unread: number;
}

const AgentsView: React.FC<AgentsViewProps> = ({
    username, bots, groups, messages, selection, onSelect, onNewBot, onNewGroup,
    onSendBotTurn, onAnalyze, onLogProposedTrade, onAnalysisError, onStopRun, analysisRunning = false, renderGroup, workingBotId, mailboxBusyBotIds,
    lastOpenedMap = {}, modelPicker, modelFallback = null, accountRow,
    railExpanded = true, sidebarExpanded = true, onToggleRailExpanded,
    railWidth = NAV_RAIL_EXPANDED_PX, railIsResizing = false,
    onRailResizeStart, onRailResizeReset,
    onRevertTo, onEditPromptMessage, onStepVersion, parkedCount = 0, onRestoreParked,
    attentionMap, onDeleteBot, onDeleteGroup, onEditGroup,
    botStats,
    onRenameBot,
    conversations = [], activeConversationId = null, onLoadConversation, onDeleteConversation, onClearConversation, onNewChat,
    onSetThreadSummary,
}) => {
    const [pins, setPins] = useState<string[]>(() => loadPins(username));
    const [query, setQuery] = useState('');
    // The field is revealed, not permanent. The reference's sidebar carries a
    // magnifier in the list's header rather than a bordered box that is on
    // screen even while nobody is searching — "lines, not boxes" — and a box
    // that is always there is the one thing that made this column read as a
    // form instead of a list.
    const [searchOpen, setSearchOpen] = useState(false);
    const [text, setText] = useState('');
    // There is no Chat/Analyze switch any more. What a send RUNS is decided by
    // what is selected in the rail: a bot answers in its own persona (its own
    // model, its own memory scope, fast and conversational); nothing selected
    // runs the full analysis pipeline — the market packet, desk tools, memory
    // injection, the verdict and its levels, which
    // is exactly what the Chart AI dock does. Both behaviours stay reachable;
    // the toggle was a second way to say something the selection already says.
    const [busy, setBusy] = useState(false);
    // ── The instrument this surface is talking about ──────────────────────
    // The CHAT SESSION is the shared binding: TradeView already stamps the
    // session on every symbol/interval change and adopts it back, so writing
    // here moves the chart, and writing there moves this surface. Choosing a
    // coin therefore genuinely changes the analysis, not just the label —
    // App passes the session's instrument into handleSendMessage as the
    // fallback when the prompt names no coin.
    const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const activeSession = snap.sessions.find(x => x.id === snap.activeId) ?? snap.sessions[0];
    /** A run the OTHER home started in THIS thread.
     *
     *  The Chart AI dock registers its controller under the CONVERSATION id as
     *  well as its session id, so this surface can say what is actually true:
     *  the thread is answering. Without it the composer showed Send over an
     *  answer streaming in from the chart, and pressing it started a second run
     *  on top of the first. */
    const dockRunning = !!activeConversationId && !!snap.conversationRunning[activeConversationId];
    const sessionSymbol = activeSession?.symbol ?? 'BTCUSDT';
    const sessionInterval = (activeSession?.interval ?? '15m') as ChartInterval;
    const symbols = useSymbolUniverse();
    // Written through the SAME accessor the composer reads (`activeSession`) and
    // the chart adopts from — `chatStore.getActiveSession()`, active row else
    // first. Writing to the raw active id instead made the picker a label in the
    // one state where the id does not resolve: the bubble repainted, nothing was
    // stored on the row the chart looks at, and the coin never moved.
    const setSessionSymbol = useCallback((next: string): void => {
        const sid = chatStore.getActiveSession()?.id;
        if (sid) chatStore.mutate(sid, sess => ({ ...sess, symbol: next }));
    }, []);
    const setSessionInterval = useCallback((next: ChartInterval): void => {
        const sid = chatStore.getActiveSession()?.id;
        if (sid) chatStore.mutate(sid, sess => ({ ...sess, interval: next }));
    }, []);
    // Below md the rail is an overlay, not a column — at 320px a permanent
    // 42vw list left no readable transcript.
    const [railOpen, setRailOpen] = useState(false);
    // Dock V1 — the right workspace is a peek, not a stored layout preference.
    // The dock itself persists its width and its tab mode through the shared
    // right-panel contract; whether it is on screen stays session state.
    const [dockOpen, setDockOpen] = useState(false);
    // The sort toggle lived on the tab row this column no longer has; the
    // roster keeps its pinned-first order and its own inactive fold instead.

    // WS-6: the composer attaches images through the SAME reader the Trade dock
    // uses (hooks/useChatAttachments was lifted out of TradeChatPanel for this).
    const { attachments, fileInputRef, attachFiles, remove: removeAttachment, clear: clearAttachments, openPicker, images: attachedImages } = useChatAttachments();
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    /** Which agent's FULL card is open. The launch list names the agent; this
     *  is where the trader reads what it actually is. Null = closed. */
    const [detailBotId, setDetailBotId] = useState<string | null>(null);
    const scroller = useRef<HTMLDivElement | null>(null);
    // Jump-to-latest (the command palette's "Jump to latest analysis"
    // rehomed): the control shows only when the trader has scrolled away from
    // the newest row, and one click returns. The same control the Chart AI
    // dock mounts — one home for the concern.
    const [showJump, setShowJump] = useState(false);
    /** Whether the transcript may still follow the newest row. Un-pinned when
     *  the trader scrolls away, so a streaming answer does not carry the row
     *  they are reading off the screen. */
    const stickToBottomRef = useRef(true);
    /** Re-render trigger for the module-scope proposal dispositions: the
     *  decision itself lives in `services/trade/proposalDisposition` so it
     *  survives a surface switch AND is shared with the Chart AI dock, which
     *  reads the same map for the same row id. This only makes React repaint
     *  the card. */
    const [proposalTick, setProposalTick] = useState(0);
    /** Which row's Log click is awaiting the gate stamp. Local on purpose: it is
     *  transient, and a pending await that outlived the surface would disable a
     *  button that no longer exists. */
    const [awaitingProposalRowId, setAwaitingProposalRowId] = useState<string | null>(null);
    const proposalStateFor = (id: string): 'logged' | 'dismissed' | undefined => {
        void proposalTick;
        return proposalStateOf(id);
    };
    /** The plan this row's PROSE describes, when the seat never called
     *  present_trade. Computed per render (the detector is regex over one row,
     *  and the transcript is capped), and gated by the same disposition store
     *  the card uses, so a dismissed chip stays dismissed. */
    const prosePlanFor = (m: Message): TradeProposal | null =>
        m.proposal ? null : planFromProse(m.text, m.analysis?.coinName ?? null);
    const onScrollerScroll = useCallback((): void => {
        const el = scroller.current;
        if (!el) return;
        // ONE rule for both homes: the transcript follows the newest row until
        // the trader has scrolled JUMP_AWAY_PX away from it, then it stops and
        // the jump control appears. A transcript that keeps moving under a
        // trader who is reading it cannot be read.
        const away = el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_AWAY_PX;
        stickToBottomRef.current = !away;
        setShowJump(away);
    }, []);
    const jumpToLatest = useCallback((): void => {
        const el = scroller.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
        stickToBottomRef.current = true;
        setShowJump(false);
    }, []);
    const paneRef = useRef<HTMLElement | null>(null);
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const [searchFocusNonce, setSearchFocusNonce] = useState(0);

    // `/` focuses the rail search. Nothing else claims it: the app-wide handler
    // that used to looked up #chat-composer, an id deleted in 78bc027.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            e.preventDefault();
            setRailOpen(true);
            // Focus lands in an effect, not here: below md the closed rail is
            // visibility:hidden, and a hidden subtree refuses focus. Both
            // flushSync and a rAF were measured in a real browser at 531px and
            // still ran before the commit — a bumped nonce guarantees a render
            // (even when railOpen was already true) and effects run after the
            // DOM is updated.
            setSearchFocusNonce(n => n + 1);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    // `/` (and the palette) asks for the search field. It is revealed on demand
    // now, so the request has to open it as well as focus it — and focusing
    // happens in the effect below, because the input does not exist until the
    // state change that this one causes has rendered.
    useEffect(() => {
        if (searchFocusNonce) setSearchOpen(true);
    }, [searchFocusNonce]);

    const searching = searchOpen || query.trim().length > 0;
    useEffect(() => {
        if (searching) searchRef.current?.focus();
    }, [searching]);

    // The shell rail's Search row lands here. The request is a token rather
    // than a boolean so two presses in a row both open the field; App clears
    // it once consumed, which is why a later remount does not replay it.

    const statFor = useCallback((botId: string): BotLearningStat | undefined =>
        botStats?.find(s => s.id === botId), [botStats]);

    useEffect(() => {
        try { localStorage.setItem(PIN_KEY(username), JSON.stringify(pins)); } catch { /* private mode */ }
    }, [pins, username]);

    const togglePin = useCallback((id: string): void => {
        setPins(p => (p.includes(id) ? p.filter(x => x !== id) : [id, ...p].slice(0, 8)));
    }, []);

    const q = query.trim().toLowerCase();
    const matches = useCallback((name: string): boolean => !q || name.toLowerCase().includes(q), [q]);

    const botRowsRaw = useMemo<BotRow[]>(() => bots
        .filter(b => matches(b.name))
        .map(b => {
            const thread = threadForProvider(messages, b.providerId, b.modelId, b.id);
            const last = thread[thread.length - 1] ?? null;
            return {
                bot: b,
                preview: last ? previewTextFor(last) : '',
                time: last?.createdAt ?? null,
                unread: unreadCount(messages, b.providerId, lastOpenedMap[b.providerId], b.modelId, b.id),
            };
        })
        .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? '')),
    [bots, messages, lastOpenedMap, matches]);
    // Shared-history previews: a message with no botId stamp is claimable by
    // every bot on that provider+model (the pre-stamp-history fallback), so
    // the SAME stale text used to render as several bots' previews — phantom
    // conversations. If one preview text appears on more than one row, it is
    // claimed by none of them (the threads still render; this is the LIST
    // preview only). Single-owner previews are untouched.
    const previewCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const r of botRowsRaw) {
            if (!r.preview) continue;
            counts.set(r.preview, (counts.get(r.preview) ?? 0) + 1);
        }
        return counts;
    }, [botRowsRaw]);
    const botRows = useMemo<BotRow[]>(() => botRowsRaw
        .map(r => (r.preview && (previewCounts.get(r.preview) ?? 0) > 1 ? { ...r, preview: '' } : r)),
    [botRowsRaw, previewCounts]);

    const groupRows = useMemo(() => groups
        .filter(g => matches(groupDisplayName(g, bots))), [groups, bots, matches]);

    const pinnedIds = new Set(pins);
    const pinnedBots = botRows.filter(r => pinnedIds.has(r.bot.id));
    const pinnedGroups = groupRows.filter(g => pinnedIds.has(g.id));
    const unpinnedGroups = groupRows.filter(g => !pinnedIds.has(g.id));
    // Bots flagged by attentionMap cannot do their job (dead provider, missing
    // model, no key). At rest they collapsed under one disclosure — the amber
    // ⚠ stays on each row inside it, but no longer shouts from the resting list.
    const [showInactive, setShowInactive] = useState(false);
    // The roster lists EVERY agent, pinned or not. It used to subtract the
    // pinned ones, which was invisible while both lists shared one scroll; once
    // the roster became its own tab, pinning an agent deleted it from the tab
    // that is meant to hold the whole roster.
    const listedBots = botRows;
    const activeBots = listedBots.filter(r => !attentionMap?.[r.bot.id]);
    const inactiveBots = listedBots.filter(r => !!attentionMap?.[r.bot.id]);
    const listedGroups = unpinnedGroups;
    const deskMessages = useMemo(() => deskThread(messages, bots), [messages, bots]);
    const lastChartMessage = deskMessages[deskMessages.length - 1];

    // App-side conversations, newest first, filtered by the same rail query.
    // The title is the first thing the trader said — the conversation has no
    // separate name field, and a preview IS its identity in every list that
    // shows one.
    // (conversationRows was the rail's filter — the rail now uses
    // ConversationGroups, which sorts by timestamp itself.)

    const activeBot = selection.kind === 'bot' ? bots.find(b => b.id === selection.botId) ?? null : null;
    // The composer's own busy flag never sees a QUEUE-drained DM to this bot
    // (only the mailbox knows); a bot streaming in the thread you are reading
    // shows Stop, and the press names that bot — App cannot guess it, because
    // two bots can stream at once and a first-match abort kills the wrong one.
    const mailboxBusyBot = !!mailboxBusyBotIds?.includes(activeBot?.id ?? '');
    const running = busy || analysisRunning || dockRunning || mailboxBusyBot;
    /** The agent whose full card is open, and the trace of its last turn —
     *  the two things a trader wants before handing a turn to it. */
    const detailBot = detailBotId ? bots.find(b => b.id === detailBotId) ?? null : null;
    const detailTrace = useMemo(() => {
        if (!detailBot) return undefined;
        const own = threadForProvider(messages, detailBot.providerId, detailBot.modelId, detailBot.id);
        for (let i = own.length - 1; i >= 0; i -= 1) {
            const t = messageTraceText(own[i]);
            if (t) return t;
        }
        return undefined;
    }, [detailBot, messages]);
    const activeGroup = selection.kind === 'group' ? groups.find(g => g.id === selection.groupId) ?? null : null;
    const activeStat = activeBot ? statFor(activeBot.id) : undefined;
    // WS-3.1's scope contract, read off the bot rather than assumed.
    const botIsolated = !!activeBot && (activeBot.memoryScope ?? 'global') !== 'global';
    // The Chart AI pane IS the dock's conversation — the same array, not a
    // copy (WS-6's hard requirement). It used to be [], which made "opening it
    // here and on the Analyze surface shows the same conversation" false: the
    // pane was a launcher wearing a transcript. The desk's own slice is
    // deskThread: desk-tool verdicts and session-model answers land
    // inline, while a bot's DM stays in that bot's row instead of leaking
    // into the desk pane.
    const isChartPane = selection.kind === 'team';
    const thread = useMemo(
        () => (activeBot ? threadForProvider(messages, activeBot.providerId, activeBot.modelId, activeBot.id)
            : isChartPane ? deskMessages : []),
        [activeBot, isChartPane, messages, deskMessages],
    );

    const lastThreadRole = thread[thread.length - 1]?.role;

    // ── Silent context compaction ─────────────────────────────────────────
    // At 80% of the window the OLDER turns are summarized on an idle callback
    // and the digest is stored on the conversation. Nothing here blocks a send:
    // the hook returns immediately, the model call happens off the paint path,
    // and a failure just leaves the next turn to compact structurally. The
    // digest is injected on the NEXT request (see chatSurfaceTurn), never shown.
    const [compactionModel, setCompactionModel] = useState<((prompt: string) => Promise<string>) | null>(null);
    useEffect(() => {
        let alive = true;
        void resolveCompactionComplete().then(fn => { if (alive) setCompactionModel(() => fn); });
        return () => { alive = false; };
    }, []);
    const compactionMessages = useMemo(
        () => thread.map(m => ({
            role: m.role === MessageRole.AI ? 'assistant' : m.role === MessageRole.SYSTEM ? 'system' : 'user',
            content: typeof m.text === 'string' ? m.text : '',
        })),
        [thread],
    );
    const activeConversationForCompaction = conversations.find(c => c.id === activeConversationId);
    const handleThreadSummary = useCallback(
        (summary: string, id: string) => onSetThreadSummary?.(id, summary),
        [onSetThreadSummary],
    );
    useBackgroundCompaction({
        conversationId: activeConversationId ?? null,
        messages: compactionMessages,
        windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        busy: dockRunning || busy,
        existingSummary: activeConversationForCompaction?.threadSummary,
        complete: compactionModel,
        onSummary: handleThreadSummary,
    });

    useEffect(() => {
        const el = scroller.current;
        // Sending is an explicit request to see the new turn: re-pin even if
        // the trader had scrolled up to read. Without this the question and
        // its answer could land below the fold while the transcript stayed
        // parked exactly where it was.
        if (lastThreadRole === 'user') {
            stickToBottomRef.current = true;
            setShowJump(false);
        }
        // Follow the newest row — but only while the trader is still near it.
        // Un-pinned, the transcript keeps the row the trader is reading.
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [thread.length, lastThreadRole]);

    const send = useCallback(async (): Promise<void> => {
        const prompt = text.trim();
        if (!prompt || running) return;
        stickToBottomRef.current = true;
        setShowJump(false);
        setText('');
        // The branch the toggle used to make explicit. A bot selected → the
        // bot's own transport; nothing selected → the full analysis pipeline.
        // A bot turn answers from text, so an attachment is only meaningful on
        // the analysis path and is dropped rather than silently ignored.
        if (!activeBot) {
            const images = attachedImages();
            clearAttachments();
            // `busy` used to be set only on the bot path, so an analysis run left
            // the composer reading as idle: the send button never became Stop,
            // and nothing disabled a second send while the first was still
            // streaming. The card that used to carry Stop is gone from this
            // surface, so this flag is now the only way to end a run from here.
            setBusy(true);
            try {
                // ONE record of this turn. The pipeline appends the question, the
                // streaming answer and any error bubble to the active conversation,
                // and the dock renders that conversation through `entriesForSession`.
                // This surface used to ALSO write the turn into the chat session via
                // `runAnalysisAsChatTurn`, and the two copies disagreed: the session
                // row carried this wrapper's summary ("The analysis was stopped.")
                // while the conversation carried the model's answer, and because the
                // wrapper keys its rows with fresh ids, the merge could not recognise
                // them as the same exchange — so the dock showed the question twice
                // with two different replies.
                await onAnalyze(prompt, images);
            } catch (e) {
                onAnalysisError?.(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(false);
            }
            return;
        }
        clearAttachments();
        setBusy(true);
        try { await onSendBotTurn(activeBot, prompt); } finally { setBusy(false); }
    }, [text, running, onAnalyze, onAnalysisError, activeBot, onSendBotTurn, attachedImages, clearAttachments]);

    /** The ⋯/right-click list for a room: pin plus the two roster handlers App
     *  hands in. Pinned rooms gain edit/delete here that the hover icons never
     *  showed them. */
    const groupActions = (g: AgentGroup): RowMenuItem[] => [
        { label: pinnedIds.has(g.id) ? 'Unpin' : 'Pin', onSelect: () => togglePin(g.id) },
        ...(onEditGroup ? [{ label: 'Edit room', onSelect: () => onEditGroup(g.id) }] : []),
        ...(onDeleteGroup ? [{ label: 'Delete room', onSelect: () => onDeleteGroup(g.id), danger: true }] : []),
    ];

    /** A bot row with everything the standalone roster rail used to own:
     *  pin, the ⚠ fix hint, rename, delete. */
    const renderBotRow = (r: BotRow): React.ReactNode => {
        // The LAUNCH LIST's job: say what the agent is FOR, so the trader
        // picks the right one instead of guessing from a name. The role is
        // the agent's title, or the first line of its description — and when
        // it has neither, the row says so rather than borrowing the last
        // message as a stand-in for a role.
        const role = (r.bot.title || r.bot.description || '').split('\n')[0].trim();
        return (
            <Row key={r.bot.id}
                active={selection.kind === 'bot' && selection.botId === r.bot.id}
                title={r.bot.name} preview={role || r.preview} time={relTime(r.time)} unread={r.unread}
                working={workingBotId === r.bot.id} pinned={pins.includes(r.bot.id)}
                attention={attentionMap?.[r.bot.id]}
                stat={statFor(r.bot.id)?.skillsAuthored}
                Icon={Bot}
                avatar={<BotAvatar bot={r.bot} size={20} working={workingBotId === r.bot.id} />}
                onPin={() => togglePin(r.bot.id)}
                onClick={() => selectThread({ kind: 'bot', botId: r.bot.id })}
                actions={[
                    { label: 'Details', onSelect: () => setDetailBotId(r.bot.id) },
                    { label: pins.includes(r.bot.id) ? 'Unpin' : 'Pin', onSelect: () => togglePin(r.bot.id) },
                    ...(onRenameBot ? [{
                        label: 'Rename',
                        onSelect: () => { setRenamingId(r.bot.id); setRenameDraft(r.bot.name); },
                    }] : []),
                    ...(onDeleteBot ? [{
                        label: 'Delete bot', onSelect: () => onDeleteBot(r.bot.id), danger: true,
                    }] : []),
                ]}
                manage={(onRenameBot || onDeleteBot) && (
                    <>
                        {onRenameBot && (
                            <button type="button" aria-label={`Rename ${r.bot.name}`} data-testid="rail-rename"
                                onClick={() => { setRenamingId(r.bot.id); setRenameDraft(r.bot.name); }}
                                className="hit-target rounded-control p-0.5 text-zinc-600 transition-colors hover:text-zinc-300">
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                        {onDeleteBot && (
                            <button type="button" aria-label={`Delete ${r.bot.name}`}
                                onClick={() => onDeleteBot(r.bot.id)}
                                className="hit-target rounded-control p-0.5 text-zinc-600 transition-colors hover:text-rose-300">
                                <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                    </>
                )}
                >
                {renamingId === r.bot.id && onRenameBot && (
                    <form className="flex items-center gap-1 px-2 pb-1.5 pl-9"
                        onSubmit={e => {
                            e.preventDefault();
                            const next = renameDraft.trim();
                            if (next) onRenameBot(r.bot.id, next);
                            setRenamingId(null);
                        }}>
                        <input value={renameDraft} onChange={e => setRenameDraft(e.target.value)}
                            aria-label={`Rename ${r.bot.name}`} data-testid="bot-rename-input" autoFocus
                            className="min-w-0 flex-1 rounded-control border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-ui-dense text-zinc-200 outline-none focus:border-zinc-600" />
                        <button type="submit"
                            className="shrink-0 rounded-control border border-zinc-700 px-1.5 py-0.5 text-ui-xs text-zinc-300 hover:bg-zinc-800">
                            Save
                        </button>
                    </form>
                )}
            </Row>
        );
    };

    const placeholder = activeBot
        ? `Message @${activeBot.name}…`
        : activeGroup ? 'Message the room…' : 'How can I help you today?';

    // Under the composer, and truncated there, so it is also the title there.
    const contextNote = activeBot
        ? `@${activeBot.name} answers here`
        : 'No agent selected — the desk can check the tape';
    /** A loaded App conversation's own name. The chat store's session title can
     *  still be the placeholder "New chat" while the conversation the trader
     *  picked already has a name, and this bar is the one place that name is the
     *  subject of the screen. */
    const activeConversationTitle = conversationTitle(
        conversations.find(c => c.id === activeConversationId), '');

    // The + New menu: one creator, four honest verbs. The old chip row made
    // "Agents" and "Rooms" look like navigation when both only opened create
    // dialogs — and "+ New" was the same NewBotDialog a third time.
    const [convMenuAt, setConvMenuAt] = useState<{ id: string; x: number; y: number } | null>(null);
    // Which list the column is showing. The reference's sidebar splits its
    // sessions from its bots; August's column held both at once, so the roster
    // scrolled away under the conversations. A third "desk" tab is deliberately
    // NOT here: the charted form of the desk is a SURFACE, and the switch at the
    // top of this column already routes to it — a second control claiming the
    // same jump is the duplication this redesign exists to remove.
    // `goals` is the opposite case: a goal is work state this surface's turns
    // run inside, it has no other home, and the desk reshapes it mid-task — so
    // the list, the focus and the undo belong beside the threads.
    // No tab strip (owner, 2026-11-03): one scroll of sections. The roster keeps
    // its own folds — inactive agents and the search field — so the column stays
    // navigable without a segmented control hiding half of it.


    // The mode switch lives in the column's header at every width, the drawer
    // included; there is no second copy in the content bar.

    const selectThread = useCallback((t: ThreadSelection): void => {
        onSelect(t);
        setRailOpen(false); // on mobile the drawer was the point of the tap
        if (t.kind === 'bot') {
            const b = bots.find(x => x.id === t.botId);
            if (b) markThreadOpened(lastOpenedMap, b.providerId);
        }
    }, [onSelect, bots, lastOpenedMap]);

    return (
        <div className="flex h-full min-h-0" data-testid="agents-view">
            {/* ── Rail — a column at md+, an overlay drawer below ── */}
            {railOpen && (
                <button type="button" aria-label="Close conversations"
                    onClick={() => setRailOpen(false)}
                    className="fixed inset-0 z-30 bg-black/60 md:hidden" data-testid="rail-backdrop" />
            )}
            {/* Deliberately NOT transitioning `visibility`: interpolating it
                delays the hidden state by the transition duration, which both
                leaves a closed drawer tabbable for 150ms and makes the flip
                unmeasurable. The slide-in still animates (visible instantly,
                transform after); the slide-out is not seen. */}
            <aside
                /* One width for both sides of the hop: `w-72` stays the mobile
                   drawer, and md+ takes the shell's own constant through a
                   custom property, because an inline style would otherwise win
                   at every breakpoint and flatten the drawer too. */
                style={{ '--rail-w': `${railWidth}px` } as React.CSSProperties}
                className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 transform flex-col bg-zinc-950 transition-transform duration-[150ms] ease-[var(--ease-snappy)] ${
                    railOpen ? 'translate-x-0' : 'invisible -translate-x-full md:visible'
                } md:relative md:z-auto md:h-full md:min-h-0 md:w-[var(--rail-w)] md:translate-x-0 ${
                    railExpanded ? '' : 'md:hidden'
                }`}
                data-testid="agents-rail">
                {/* The column's own header row, and the reference's: the mode
                    switch owns its LEFT edge, at the same x the rail-less
                    surfaces put it, so hopping Chat ⇄ Trade changes the content
                    and not the position of the control that changed it. The
                    put-away toggle keeps the right edge — the SAME toggle the
                    rail renders, so the two columns cannot disagree about
                    whether one is open. A wordmark above this row was tried and
                    removed: it pushed the switch down ~67px and the hop check
                    (which pins the switch across the hop) went red. */}
                {/* One scroll of sections, the way the reference's column reads —
                    the Chats | Bots strip is deleted, not hidden. The search handle
                    sits on this slim row because it filters across the sections
                    rather than one of them. */}
                <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
                    <button type="button" data-testid="rail-search-toggle" className="ml-auto shrink-0 rounded-control p-1.5 transition-colors hover:text-zinc-200"
                        onClick={() => setSearchOpen(v => !v)}
                        aria-expanded={searching} aria-controls="rail-search-field"
                        aria-label="Search conversations"
                        title={searching ? 'Hide the search field' : 'Search conversations (/)'}>
                        <Search className={`h-3.5 w-3.5 ${searching ? 'text-zinc-200' : 'text-zinc-600'}`} aria-hidden="true" />
                    </button>
                </div>
                {searching && (
                    <div id="rail-search-field" className="relative mb-1.5 px-1">
                        <input ref={searchRef} value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => {
                                if (e.key !== 'Escape') return;
                                // Hide ≠ close only applies to surfaces;
                                // an empty field has nothing to keep.
                                if (query) setQuery('');
                                else setSearchOpen(false);
                            }}
                            placeholder="Search conversations..."
                            aria-label="Search conversations" data-testid="rail-search"
                            className="w-full rounded-control border border-zinc-800/80 bg-zinc-950/70 py-1.5 pl-3 pr-7 text-ui-dense text-zinc-200 outline-none placeholder:text-zinc-500 transition-colors focus:border-zinc-700 focus:bg-zinc-950" />
                        {!query && (
                            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-control border border-zinc-800/80 bg-zinc-900/80 px-1 py-0.5 font-mono text-ui-xs leading-none text-zinc-500">
                                /
                            </kbd>
                        )}
                    </div>
                )}
                {/* Chat-only: the SAME ConversationGroups the shell rail renders,
                    so rows are identical on both surfaces. Goals/Agents/Rooms
                    groups are gone (mock-redesign-v3). */}
                <ConversationGroups
                    conversations={conversations}
                    activeConversationId={activeConversationId}
                    onNewChat={() => {
                        onNewChat?.();
                        // The pane must FOLLOW the conversation that was just
                        // made (the blank-reuse path hands back an unused blank
                        // session), and focus makes the press feel answered.
                        selectThread({ kind: 'team' });
                        composerRef.current?.focus();
                    }}
                    onOpenConversation={id => onLoadConversation?.(id)}
                    onDeleteConversation={id => onDeleteConversation?.(id)}
                    onClearConversation={id => onClearConversation?.(id)}
                    onHideConversation={onToggleRailExpanded}
                />

                <div id="rail-list-panel" role="tabpanel" aria-label="Conversations and agents"
                    className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3 custom-scrollbar">
                    {searching && (
                        <div id="rail-search-field" className="relative mb-1.5 px-1">
                            <input ref={searchRef} value={query}
                                onChange={e => setQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key !== 'Escape') return;
                                    // Hide ≠ close only applies to surfaces;
                                    // an empty field has nothing to keep.
                                    if (query) setQuery('');
                                    else setSearchOpen(false);
                                }}
                                placeholder="Search conversations..."
                                aria-label="Search conversations" data-testid="rail-search"
                                className="w-full rounded-control border border-zinc-800/80 bg-zinc-950/70 py-1.5 pl-3 pr-7 text-ui-dense text-zinc-200 outline-none placeholder:text-zinc-500 transition-colors focus:border-zinc-700 focus:bg-zinc-950" />
                            {!query && (
                                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-control border border-zinc-800/80 bg-zinc-900/80 px-1 py-0.5 font-mono text-ui-xs leading-none text-zinc-500">
                                    /
                                </kbd>
                            )}
                        </div>
                    )}
                    <section data-testid="rail-pinned">
                        <h4 className="px-1 pb-1 text-ui-dense text-zinc-500">Pinned</h4>
                        {/* WS-6: the desk's own conversation is a first-class row,
                            not only the pane you fall back into. */}
                        <Row active={isChartPane} title="Chart AI" testId="chart-ai-row"
                            preview={lastChartMessage ? previewTextFor(lastChartMessage) : 'Ask the desk — it can check the tape'}
                            time={relTime(lastChartMessage?.createdAt ?? null)} Icon={MessageSquare}
                            onClick={() => selectThread({ kind: 'team' })} />
                        {pinnedBots.map(renderBotRow)}
                        {pinnedGroups.map(g => (
                            <Row key={g.id} active={selection.kind === 'group' && selection.groupId === g.id}
                                title={groupDisplayName(g, bots)} preview={`${g.memberIds.length} seats`} Icon={Users}
                                pinned onPin={() => togglePin(g.id)}
                                actions={groupActions(g)}
                                onClick={() => selectThread({ kind: 'group', groupId: g.id })} />
                        ))}
                    </section>

                    <section>
                        <div className="flex items-center gap-1 px-1 pb-1">
                            <h4 className="text-ui-dense text-zinc-500">
                                Bots
                            </h4>
                            {/* The list's own creator, as the reference's BOTS
                                header carries one. Search and sort moved up onto
                                the tab row, because they filter both lists. */}
                            <button type="button" onClick={onNewBot} data-testid="rail-new-bot"
                                aria-label="New agent" title="New agent"
                                className="ml-auto rounded-control p-1.5 text-zinc-600 transition-colors hover:text-zinc-200">
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                        {listedBots.length === 0 && (
                            <p className="px-1 py-3 text-ui-dense leading-5 text-zinc-600">
                                No agents yet. Create one and it appears here with its own thread.
                            </p>
                        )}
                        {activeBots.map(renderBotRow)}
                        {inactiveBots.length > 0 && (
                            <>
                                <button type="button" data-testid="rail-inactive-toggle"
                                    onClick={() => setShowInactive(v => !v)}
                                    aria-expanded={showInactive}
                                    className="mt-1 flex w-full items-center gap-1 px-1 py-1 text-ui-dense text-zinc-600 transition-colors hover:text-zinc-400">
                                    <ChevronDown className={`h-3 w-3 transition-transform ${showInactive ? '' : '-rotate-90'}`} />
                                    {inactiveBots.length} inactive agent{inactiveBots.length === 1 ? '' : 's'}
                                </button>
                                {showInactive && inactiveBots.map(renderBotRow)}
                            </>
                        )}
                    </section>

                        {/* Rooms get their own header for the same reason the
                            reference's sidebar splits its lists: a bot row and a
                            room row look identical apart from the icon, so the
                            section name is what tells them apart. */}
                        {/* Always drawn, even empty: its `+` is the only sidebar
                            entry point left for making the FIRST room, and a
                            section that hides until it has something in it has
                            no place to put the control that creates one. */}
                    <section data-testid="rail-rooms">
                            <div className="flex items-center gap-1 px-1 pb-1">
                                <h4 className="text-ui-dense text-zinc-500">
                                    Rooms
                                </h4>
                                <button type="button" onClick={onNewGroup} data-testid="rail-new-room"
                                    aria-label="New room" title="New room"
                                    className="ml-auto rounded-control p-1.5 text-zinc-600 transition-colors hover:text-zinc-200">
                                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            </div>
                            {listedGroups.map(g => (
                            <Row key={g.id} active={selection.kind === 'group' && selection.groupId === g.id}
                                title={groupDisplayName(g, bots)} preview={`${g.memberIds.length} seats`} Icon={Users}
                                pinned={pinnedIds.has(g.id)} onPin={() => togglePin(g.id)}
                                actions={groupActions(g)}
                                onClick={() => selectThread({ kind: 'group', groupId: g.id })}
                                manage={(onEditGroup || onDeleteGroup) && (
                                    <>
                                        {onEditGroup && (
                                            <button type="button" aria-label={`Edit ${groupDisplayName(g, bots)}`}
                                                onClick={() => onEditGroup(g.id)} data-testid="rail-edit-group"
                                                className="hit-target rounded-control p-0.5 text-zinc-600 transition-colors hover:text-zinc-300">
                                                <Pencil className="h-3 w-3" aria-hidden="true" />
                                            </button>
                                        )}
                                        {onDeleteGroup && (
                                            <button type="button" aria-label={`Delete ${groupDisplayName(g, bots)}`}
                                                onClick={() => onDeleteGroup(g.id)} data-testid="rail-delete-group"
                                                className="hit-target rounded-control p-0.5 text-zinc-600 transition-colors hover:text-rose-300">
                                                <Trash2 className="h-3 w-3" aria-hidden="true" />
                                            </button>
                                        )}
                                    </>
                                )} />
                            ))}
                            {listedGroups.length === 0 && (
                                <p className="px-1 py-2 text-ui-dense leading-5 text-zinc-600">
                                    No rooms yet. A room puts several agents on one thread.
                                </p>
                            )}
                    </section>

                    {convMenuAt && createPortal(
                        <RowMenu
                            x={convMenuAt.x}
                            y={convMenuAt.y}
                            items={[
                                ...(onClearConversation ? [{ label: 'Clear messages', onSelect: () => onClearConversation(convMenuAt.id) }] : []),
                                ...(onDeleteConversation ? [{ label: 'Delete conversation', onSelect: () => onDeleteConversation(convMenuAt.id), danger: true }] : []),
                            ]}
                            onClose={() => setConvMenuAt(null)}
                        />,
                        document.body,
                    )}
                </div>


                {/* Identity, when this column IS the sidebar. It used to live only
                    in the nav rail, and putting it in both places at once is what
                    made two account rows share one screen — so it arrives as a
                    node from App, which knows whether the rail is mounted. */}
                {accountRow}
                {onRailResizeStart && (
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize conversations"
                        data-testid="agents-rail-resize"
                        onPointerDown={onRailResizeStart}
                        onDoubleClick={onRailResizeReset}
                        title="Drag to resize · double-click to reset"
                        className={`absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none items-center justify-center transition-colors md:flex ${
                            railIsResizing ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-300'
                        }`}
                    >
                        <span aria-hidden="true" className="block h-8 w-px bg-white/15 opacity-60" />
                    </div>
                )}
            </aside>

            {/* ── Main pane + Dock V1 ───────────────────────────────────
                `relative` anchors the right panel's hidden (out-of-flow)
                state. The dock PUSHES the thread on desktop and goes
                fullscreen below 1024px, so the centred column is never
                squeezed to a sliver at the Electron floor of 800px. */}
            <div className="relative flex min-h-0 flex-1">
            <section ref={paneRef} className="flex min-w-0 flex-1 flex-col bg-surface-page">
                {/* The instrument bar. The timeframe row is the SAME component the
                    chart renders, over the same persisted selection, so a
                    choice here is the choice there rather than a second
                    preference that drifts. */}
                {activeGroup && renderGroup ? (
                    <div className="flex min-h-0 flex-1 flex-col">{renderGroup(activeGroup)}</div>
                ) : (
                    <>
                        {/* The chat header: the conversation's name and the
                            switch, on one hairline row — the reference's shape.
                            The instrument and timeframe used to sit here too,
                            which stacked a second toolbar's worth of chrome
                            above an empty thread; they are context for the next
                            message, so they live in the composer now. */}
                        <div
                            data-testid="chat-header"
                            className="flex shrink-0 items-center gap-3 border-b border-hairline bg-zinc-900/25 px-4 py-2"
                        >
                            {/* The shell's ONE rail toggle, on the title row
                                like every other surface. It follows the WHOLE
                                rail's state, not this column's `railExpanded`,
                                so a collapsed rail always has a way back.
                                md+ only: below md this surface has its own
                                drawer opener (`rail-open`), and a second
                                sidebar control would do something different. */}
                            {onToggleRailExpanded && (
                                <span className="hidden md:flex">
                                    <SidebarToggle expanded={sidebarExpanded} onToggle={onToggleRailExpanded} />
                                </span>
                            )}
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                <button type="button" onClick={() => setRailOpen(true)}
                                    aria-label="Open conversations" data-testid="rail-open"
                                    className="shrink-0 rounded-control border border-zinc-800 p-1 text-zinc-500 transition-colors hover:text-zinc-200 md:hidden">
                                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                {/* No in-column expand here: the header's
                                    "Expand navigation" is the shell's one
                                    control, and it now reaches this column too.
                                    A second one made the same action live in
                                    two places with two different states. */}
                                <span className="min-w-0 truncate text-ui-caption font-medium tracking-[-0.01em] text-zinc-200" title={activeBot
                                        ? `@${activeBot.name}`
                                        /* The desk pane IS the active chat session —
                                            loaded App conversations included — so the
                                            title names the session, not a brand. The
                                            App conversation's own name wins when one is
                                            loaded; the chat-session title is the
                                            fallback for a thread that has not been
                                            named yet. The dock row above keeps the
                                            "Chart AI" name. */
                                        : (activeConversationTitle || activeSession?.title?.trim() || 'Desk')}>
                                    {activeBot
                                        ? `@${activeBot.name}`
                                        /* Same rule as the tooltip above: the loaded
                                            conversation's name, then the session's, then
                                            the desk. */
                                        : (activeConversationTitle || activeSession?.title?.trim() || 'Desk')}
                                </span>
                                {/* Which goal the seat is working inside — and the
                                    one press that ends it. Its tool policy is
                                    applied from the next turn, so the header that
                                    names the session must also name that. */}
                                <ActiveGoalChip />
                                {activeBot && (
                                    <StatusPill
                                        tone={botIsolated ? 'neutral' : 'info'}
                                        kicker
                                        data-testid="bot-notebook-sync"
                                        title={botIsolated
                                            ? 'Isolated: thinks from its own notes. The shared notebook never reaches it and nothing it learns surfaces for others.'
                                            : `Reads the shared notebook every turn and folds its closed trades back in.${activeStat?.lastLessonAt ? ` Last lesson ${activeStat.lastLessonAt}.` : ' No lesson written yet.'}`}
                                        icon={<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
                                    >
                                        {botIsolated ? 'own notes' : 'notebook'}
                                    </StatusPill>
                                )}
                                {activeStat && (
                                    <span className="hidden shrink-0 font-mono text-ui-xs tabular-nums text-zinc-600 xl:inline"
                                        data-testid="bot-learning-stats"
                                        title={activeStat.lastLessonAt ? `newest lesson ${activeStat.lastLessonAt}` : 'no dated lessons'}>
                                        {activeStat.lessons} lessons · {activeStat.skillsAuthored} skills · {activeStat.evidence} evidence
                                    </span>
                                )}
                            </div>
                            {/* Dock V1 — the ONE door to the right workspace.
                                It lives in the header, never beside the symbol
                                picker (the render gate pins that to the
                                composer area). */}
                            <button type="button" onClick={() => setDockOpen(v => !v)}
                                aria-label={dockOpen ? 'Close workspace' : 'Open workspace'}
                                aria-expanded={dockOpen}
                                data-testid="agents-dock-toggle"
                                title={dockOpen ? 'Close workspace' : 'Open files, charts and evidence'}
                                className={`motion-press flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
                                    dockOpen ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
                                }`}>
                                <PanelRight className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                        {/* The thread IS this surface. The charted form of the
                            desk is a different screen, reached from the pill
                            above — not a copy of this one with the chart
                            removed, which is what used to render here and made
                            the two states impossible to tell apart. */}
                        <div data-testid="agents-thread-column"
                            className={`flex min-h-0 flex-1 flex-col ${thread.length === 0 ? 'chat-hero-grid justify-center' : ''}`}>
                        <div className={`${thread.length === 0 ? 'shrink-0' : 'relative min-h-0 flex-1'}`}>
                        {/* `h-full` is load-bearing, not decoration: an
                            overflow-y-auto box with auto height grows to its
                            content and can never scroll. Losing it while adding
                            the horizontal pad made the whole thread unscrollable. */}
                        <div ref={scroller} onScroll={onScrollerScroll} className="h-full overflow-y-auto custom-scrollbar px-4">
                            {thread.length === 0 ? (
                                <div className="chat-column flex flex-col items-center justify-center px-6 py-4 text-center">
                                    <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-bubble border border-hairline bg-zinc-900/80 text-zinc-300">
                                        <Bot className="h-5 w-5" aria-hidden="true" />
                                    </div>
                                    <p className="mb-2 text-ui-2xs font-semibold uppercase tracking-[0.16em] text-zinc-500">Your market research desk</p>
                                    <h2 className="font-serif text-ui-display font-medium tracking-[-0.035em] text-zinc-100">{greeting(username || 'trader')}</h2>
                                    <p className="mt-3 max-w-xl text-ui-caption leading-relaxed text-zinc-500">
                                        {activeBot
                                            ? botIsolated
                                                ? `@${activeBot.name} thinks from its own notes only — it is isolated from the shared notebook.`
                                                : `@${activeBot.name} reads its own notes and the shared notebook on every turn.`
                                            : 'Ask a question, inspect the evidence, and decide for yourself. August can read the tape, your plans, and your journal — it never places a trade.'}
                                    </p>
                                    {!activeBot && (
                                        <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-3">
                                            {[
                                                { label: 'Read the market', detail: `${sessionSymbol} · ${sessionInterval}`, prompt: `Read ${sessionSymbol} on ${sessionInterval}. Summarize the observed structure, liquidity, and invalidation conditions without making a recommendation.` },
                                                { label: 'Stress-test a plan', detail: 'Costs, risk, and scenarios', prompt: 'Help me stress-test a trade plan. Ask for the entry, stop, target, size, and fees, then show the risk arithmetic and scenario sensitivity.' },
                                                { label: 'Review my journal', detail: 'Patterns with sample sizes', prompt: 'Review my recent journal for repeatable patterns. Separate observations from small-sample noise and cite the trades behind each observation.' },
                                            ].map(item => (
                                                <button
                                                    key={item.label}
                                                    type="button"
                                                    onClick={() => { setText(item.prompt); composerRef.current?.focus(); }}
                                                    className="rounded-bubble border border-hairline bg-zinc-900/75 px-3.5 py-3 text-left transition-colors hover:border-line hover:bg-zinc-800/80"
                                                >
                                                    <span className="block text-ui-caption font-medium text-zinc-200">{item.label}</span>
                                                    <span className="mt-1 block text-ui-dense text-zinc-500">{item.detail}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="chat-column space-y-7 py-8" data-testid="agent-thread"
                                    // A transcript is a log: rows are appended and the
                                    // older ones scroll away, which is what `role="log"`
                                    // means to assistive tech. `aria-busy` is the part
                                    // that makes it usable — while a run streams, the text
                                    // changes on every token, and a live region without it
                                    // re-announces the whole answer dozens of times per
                                    // sentence. Held busy until the row settles, the answer
                                    // is read once, in full. (O-65)
                                    role="log" aria-live="polite" aria-busy={running}
                                    aria-label="Conversation">
                                    {thread.map((m, i) => {
                                        const isUser = m.role === MessageRole.USER;
                                        const row = chatRowFrom(m, username, activeBot?.name ?? 'desk');
                                        const vCount = versionCount(m);
                                        /* The prompt an interrupted answer was answering,
                                           so the row's recovery card can prefill the
                                           composer with what was actually asked. The
                                           row builder sees one message; only this map
                                           knows the turn before it. */
                                        const askedPrompt = !isUser && i > 0 && thread[i - 1].role === MessageRole.USER
                                            ? thread[i - 1].text
                                            : '';
                                        return (
                                            <ChatTranscriptRow
                                                key={m.id}
                                                row={askedPrompt ? { ...row, interruptedPrompt: askedPrompt } : row}
                                                /* How many turns sit below this one — the
                                                   restore control is only drawn where
                                                   restoring would actually take something
                                                   away, so the LAST row never offers it. */
                                                turnsAfter={thread.length - 1 - i}
                                                onRevertTo={onRevertTo}
                                                /* The recovery card needs at least one handler
                                                   or it renders nothing; a prefill is the
                                                   honest action here (re-asking from a row
                                                   belongs to the dock's own retry). */
                                                onEditPrompt={askedPrompt
                                                    ? prompt => { setText(prompt); composerRef.current?.focus(); }
                                                    : undefined}
                                                onEditPromptMessage={onEditPromptMessage ? (id, text) => {
                                                    onEditPromptMessage(id, text);
                                                    /* The edited wording goes into the
                                                       composer rather than straight into
                                                       a run: saving an edit and spending
                                                       a model call are two decisions, and
                                                       the row's version history is already
                                                       written by the time this returns. */
                                                    setText(text);
                                                    composerRef.current?.focus();
                                                } : undefined}
                                                priorPrompts={m.edits}
                                                versions={vCount > 1 && onStepVersion ? {
                                                    index: activeIndex(m),
                                                    total: vCount,
                                                    onStep: (delta) => onStepVersion(m.id, delta),
                                                } : undefined}
                                            >
                                                {/* The decision card is fed from the ROW MODEL, never from the
                                                    raw message: a "Logged from Chart AI" receipt carries a copy
                                                    of the plan's analysis for the journal row and the autopilot,
                                                    and reading it here drew the identical ENTRY/STOP/TARGET/
                                                    PROBABILITY card a second time in the same turn.
                                                    `chatRowFrom` is the one place that decides. */}
                                                {!isUser && <InlineVerdict analysis={row.analysis} />}
                                                {/* A plan the model PRESENTED here gets the SAME decision card the
                                                    dock renders, fed off the canonical row. One disposition store,
                                                    keyed by the row id both homes share: logging on the chart marks
                                                    this card logged, and a re-click is a no-op rather than a second
                                                    journal row. */}
                                                {!isUser && m.proposal && proposalStateFor(m.id) === undefined && (
                                                    <TradeProposalCard
                                                        proposal={m.proposal}
                                                        canLog={!!onLogProposedTrade}
                                                        awaitingLog={awaitingProposalRowId === m.id}
                                                        onLog={async () => {
                                                            if (!onLogProposedTrade) return;
                                                            if (proposalStateOf(m.id) || awaitingProposalRowId) return;
                                                            const stamped = m.proposal!;
                                                            setAwaitingProposalRowId(m.id);
                                                            let logged: boolean;
                                                            // A log that threw is NOT a log: the card stays live so the
                                                            // trader can retry instead of seeing ✓ Logged over a missing row.
                                                            try { logged = (await onLogProposedTrade(stamped)) !== false; }
                                                            catch { logged = false; }
                                                            finally { setAwaitingProposalRowId(null); }
                                                            if (!logged) return;
                                                            rememberProposalState(m.id, 'logged');
                                                            setProposalTick(t => t + 1);
                                                        }}
                                                        onCancel={() => {
                                                            if (proposalStateOf(m.id)) return;
                                                            rememberProposalState(m.id, 'dismissed');
                                                            setProposalTick(t => t + 1);
                                                        }}
                                                    />
                                                )}
                                                {!isUser && m.proposal && proposalStateFor(m.id) === 'logged' && <TradeProposalLoggedRow />}
                                                {/* Stage 20d — the seat DESCRIBED a plan and never called
                                                    present_trade. The prose carries the same three numbers, so
                                                    the row offers the same decision instead of leaving the plan
                                                    in a sentence the journal never sees. Validation is NOT
                                                    re-implemented here: planFromProse hands the numbers to
                                                    parseTradeProposal, which already refuses a long whose stop
                                                    sits above its entry. */}
                                                {!isUser && !m.proposal && proposalStateFor(m.id) === undefined && prosePlanFor(m) && (
                                                    <div className="mt-1 flex items-center gap-2" data-testid="prose-plan-chip">
                                                        <button type="button" disabled={!onLogProposedTrade || awaitingProposalRowId !== null}
                                                            className="rounded-control border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-ui-dense font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                                                            onClick={async () => {
                                                                const plan = prosePlanFor(m);
                                                                if (!plan || !onLogProposedTrade) return;
                                                                if (proposalStateOf(m.id) || awaitingProposalRowId) return;
                                                                // The ONE plan-id shape, so a plan logged from
                                                                // prose dedupes against the same plan presented by
                                                                // the tool on another row.
                                                                const stamped: TradeProposal = { ...plan, planId: plan.planId ?? mintPlanId(plan.symbol) };
                                                                setAwaitingProposalRowId(m.id);
                                                                let logged: boolean;
                                                                try { logged = (await onLogProposedTrade(stamped)) !== false; }
                                                                catch { logged = false; }
                                                                finally { setAwaitingProposalRowId(null); }
                                                                if (!logged) return;
                                                                rememberProposalState(m.id, 'logged');
                                                                setProposalTick(t => t + 1);
                                                            }}>
                                                            Log this? {prosePlanFor(m)!.direction} {prosePlanFor(m)!.symbol} @ {prosePlanFor(m)!.entry}
                                                        </button>
                                                        <button type="button" aria-label="Not this plan"
                                                            className="text-ui-dense text-zinc-500 transition-colors hover:text-zinc-300"
                                                            onClick={() => {
                                                                if (proposalStateOf(m.id)) return;
                                                                rememberProposalState(m.id, 'dismissed');
                                                                setProposalTick(t => t + 1);
                                                            }}>
                                                            dismiss
                                                        </button>
                                                    </div>
                                                )}
                                                {!isUser && !m.proposal && proposalStateFor(m.id) === 'logged' && <TradeProposalLoggedRow />}
                                            </ChatTranscriptRow>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        {showJump && (
                            <JumpToLatestFab
                                visible
                                running={running}
                                onJump={jumpToLatest}
                            />
                        )}
                        </div>

                        {/* ── Composer pill ── */}
                        {parkedCount > 0 && onRestoreParked && (
                            /* Where the turns went. A restore parks them rather
                               than deleting them, and this is the only way back
                               — so it is a permanent line, not a hover control.
                               It says what it holds instead of showing an icon
                               the trader has to decode. */
                            <div className="chat-column flex items-center justify-between gap-3 px-5 pb-1 pt-2" data-testid="parked-notice">
                                <span className="min-w-0 truncate text-ui-xs text-zinc-500">
                                    {parkedCount} turn{parkedCount === 1 ? '' : 's'} parked by a restore
                                </span>
                                <button type="button"
                                    onClick={() => { onRestoreParked(); }}
                                    aria-label="Bring the parked turns back"
                                    className="shrink-0 rounded-full border border-hairline px-2.5 py-1 text-ui-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                                    Bring them back
                                </button>
                            </div>
                        )}
                        <div className="shrink-0 px-4 pb-4">
                            {!activeBot && modelFallback && (
                                <ModelFallbackBanner modelIssue={modelFallback.issue} provider={modelFallback.provider} />
                            )}
                            {/* The composer keeps its card; the market context
                                does not. The box is the thing you type into, so
                                the coin and the timeframe — which say what the
                                next message is ABOUT — sit on their own row under
                                it, outside the frame, with the context note and
                                the disclaimer. The wrapper carries the shared
                                measure so the box, the instrument row and the two
                                notes stay on one left edge at every width. */}
                            <div data-testid="chat-composer-area" className="chat-column">
                            {/* The instrument this chat is about, ABOVE the card and
                                outside it — the reference's arrangement: what you are
                                asking about, then the box you ask it in, then the note
                                under the box. It is not part of the field, so it does
                                not live inside the field's frame. */}
                            <div className="mx-auto mb-2 flex w-full max-w-[55rem] items-center gap-2 px-2.5">
                                <SymbolPicker
                                    symbols={symbols}
                                    value={sessionSymbol}
                                    onChange={setSessionSymbol}
                                />
                                <div className="hidden sm:flex items-center">
                                    <TimeframeBar
                                        interval={sessionInterval}
                                        onIntervalChange={setSessionInterval}
                                        compact
                                        className="border-b-0 px-0 py-0"
                                    />
                                </div>
                            </div>
                            <div data-testid="chat-composer" className="rounded-bubble border border-hairline bg-surface-raised p-3 transition-colors focus-within:border-accent/40">
                                <input type="file" multiple accept="image/*" className="hidden"
                                    ref={fileInputRef} data-testid="composer-file"
                                    onChange={e => { attachFiles(e.target.files); e.target.value = ''; }} />
                                {attachments.length > 0 && (
                                    <div className="mb-1.5 flex flex-wrap gap-1" data-testid="composer-attachments">
                                        {attachments.map(a => (
                                            <span key={a.id}
                                                className="flex items-center gap-1 rounded-control border border-zinc-800 bg-zinc-950 py-0.5 pl-1.5 pr-1 text-ui-xs text-zinc-300">
                                                {a.kind === 'image' && (
                                                    <img src={a.payload} alt="" className="h-5 w-5 rounded-control object-cover" />
                                                )}
                                                <span className="max-w-[9rem] truncate" title={a.name}>{a.name}</span>
                                                <button type="button" aria-label={`Remove ${a.name}`}
                                                    onClick={() => removeAttachment(a.id)}
                                                    className="text-zinc-500 transition-colors hover:text-rose-400">×</button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <textarea ref={composerRef} value={text}
                                    onChange={e => setText(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                                    }}
                                    rows={2} placeholder={placeholder} aria-label="Message"
                                    className="w-full resize-none bg-transparent py-1 text-ui-caption leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500" />
                                <div className="mt-1 flex items-center gap-2">
                                    <button type="button" onClick={openPicker} data-testid="composer-attach"
                                        aria-label="Attach image"
                                        title={activeBot
                                            ? 'Agent replies are text-only — attachments go to the desk (no agent selected)'
                                            : 'Attach an image'}
                                        disabled={!!activeBot}
                                        className="rounded-control border border-zinc-800/80 p-1 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-400">
                                        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                    {/* The coin and the timeframe used to sit in
                                        this row. They are not part of the field
                                        you type into, so they now have their own
                                        line BELOW the card — see the instrument
                                        row after the composer closes. */}
                                    {/* E-51 D-A: the merged model control sits IN
                                        the toolbar row, immediately left of send,
                                        and the pair is what right-aligns. The
                                        footer row under the card now carries only
                                        the context note. */}
                                    <div className="ml-auto flex min-w-0 items-center gap-1.5" data-testid="composer-model-and-send">
                                        {modelPicker?.({ showEffort: !activeBot })}
                                        <button type="button"
                                            onClick={() => {
                                                if (!running) { void send(); return; }
                                                if (activeBot && (busy || mailboxBusyBot)) onStopRun?.({ kind: 'bot', botId: activeBot.id });
                                                else if (analysisRunning) onStopRun?.({ kind: 'analysis' });
                                                else if (activeConversationId) onStopRun?.({ kind: 'dock', conversationId: activeConversationId });
                                            }}
                                            disabled={!running && !text.trim()}
                                            aria-label={running ? 'Stop' : 'Send'} data-testid="composer-send"
                                            /* Two states, like the dock's composer. Stop used to live only on the
                                               pipeline card floating over this surface, which covered the answer it
                                               was waiting for; the control now sits where the send did. */
                                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-90 disabled:opacity-30 ${
                                                running ? 'bg-rose-500/15 text-rose-300' : 'bg-zinc-100 text-zinc-900'}`}>
                                            {running
                                                ? <StopIcon className="h-3 w-3" fill="currentColor" aria-hidden="true" />
                                                : <ArrowUp className="h-4 w-4" aria-hidden="true" />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            {/* The context note keeps its own line, left-aligned on
                                the card's measure; the two chips it shared the row
                                with are now one control up in the toolbar.
                                `px-2.5` matches the card's own `p-2.5`: the
                                card and the measure are both 880px and centered,
                                so the note sits on the same left edge as the typed
                                text above it rather than 7px inside. */}
                            <div className="mx-auto mt-2 flex w-full max-w-[55rem] items-center px-2.5 text-ui-xs text-zinc-600">
                                <span className="min-w-0 truncate" title={contextNote}>{contextNote}</span>
                            </div>
                            <div className="mx-auto mt-1 w-full max-w-[55rem] px-2.5 text-ui-xs text-zinc-600">
                                <span className="hidden sm:inline">{DISCLAIMER_SHORT}</span>
                            </div>
                            </div>
                        </div>
                        </div>
                    </>
                )}
            </section>
            <AgentsDock
                isOpen={dockOpen}
                onClose={() => setDockOpen(false)}
                symbol={sessionSymbol}
                interval={sessionInterval}
                onIntervalChange={setSessionInterval}
                // 'dock' when no conversation is active: a STABLE scope, so the
                // dock's drawings persist — the old `?? undefined` is what let
                // the chart fall through to the legacy bucket silently.
                sessionId={activeConversationId ?? 'dock'}
            />
            </div>
            {/* The agent's FULL card — the reader the launch list opens. It
                mounts OUTSIDE the pane, because an overlay that mounts inside
                the scroller is measured as the pane's own content. */}
            <DetailModal
                isOpen={!!detailBot}
                onClose={() => setDetailBotId(null)}
                title={detailBot?.name ?? ''}
                subtitle={detailBot?.title || (detailBot ? formatModelDisplayName(detailBot.modelId) : undefined)}
                icon={detailBot ? <BotAvatar bot={detailBot} size={36} /> : undefined}
                closeLabel="Close agent details"
                footer="A read-only view of the agent. Press Escape to close."
            >
                {detailBot && (
                    <AgentDetailCard
                        bot={detailBot}
                        skillsAuthored={statFor(detailBot.id)?.skillsAuthored}
                        trace={detailTrace}
                    />
                )}
            </DetailModal>
        </div>
    );
};

export default React.memo(AgentsView);
