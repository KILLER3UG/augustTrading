/**
 * TradeChatPanel — the Chart AI dock on the trade surface. EVERY message
 * carries a freshly fetched, code-calculated market packet, and the model can
 * pull even more itself through the desk tools: get_market_packet (the full
 * hybrid pull), get_all_timeframes (every timeframe + book/funding/OI at
 * once), get_chart_view (candles + live mark + verdict levels + the
 * order book + the user's own drawings), and the GROWTH set —
 * write_memory_note / get_notebook_map / skill_index / skill_write /
 * amend_memory / forge_tool — so the model can create, update and edit its
 * own memory, skills and tools right from this chat (proposals still need the
 * human's approval in Settings / the Learning surface's Coach tab; visible status rows show
 * every side-effect). It can also DRAW on the live chart exactly like the
 * user: mark_trade_levels lays an Entry/SL/TP plan as labeled lines,
 * draw_on_chart adds a trendline/ray/zone, clear_chart_drawings wipes them —
 * the model's marks render on the canvas and flow back into its own context.
 *
 * The composer mirrors the reference agent client: a model selector, a +
 * attach button (files + images), a chart-screenshot button (the model sees
 * the chart as an image AND the image renders in the transcript), and a
 * thinking-effort toggle (Off → Max). AI answers stream with a real
 * collapsible Thinking row and fade in as text lands.
 *
 * Sessions: parallel chats persisted per user (new / switch / delete). A
 * session is SOLO (one model, optionally bound to a roster bot persona),
 * a PANEL (up to 5 models that see each other's turns, can DM each other
 * through the desk mailbox, and close with one synthesized answer), or an
 * ANALYSIS run (the full ensemble pipeline — hybrid intelligence, debate,
 * verdict — launched from this chat and answered back into it). The whole
 * dock is drag-resizable, collapsible to a rail, and expandable full width.
 *
 * The turn orchestration itself (send / runSeatTurn / runFullAnalysis /
 * runHarnessTurn / buildContextBlock / executePanelTool) is service-shaped:
 * it lives in `services/trade/chatTurnRunner.ts` and never touches JSX —
 * this file is the shell that subscribes to the session store, renders the
 * header, transcript and composer, and hands the runner its deps.
 *
 * No order execution — this is the copilot read of the tape, not a button.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Activity, Compass, Crosshair, Eye, History, MoreHorizontal, PanelRightOpen, Plus, X } from '../shared/Icons';
import JumpToLatestFab, { JUMP_AWAY_PX } from '../shared/JumpToLatestFab';
import { ProviderConfig } from '../../types/provider';
import type { LoggedTrade } from '../../types';
import type { Message } from '../../types/message';
import {
    buildSkillsIndexForPrompt, TRADE_CHAT_SYSTEM_PROMPT,
} from '../../services/trade/tradeChatContext';
import { activeStrategiesBlock } from '../../services/learning/strategyStore';
import { deleteSessionDrawings, type ChartDrawing } from '../../services/trade/chartDrawings';
import type { MessageLevelLines } from '../../services/trade/keyLevels';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import type { WatchPlan } from '../../services/trade/tradePlanLevels';
import { entriesForSession, PANEL_MAX_MODELS, type PanelSeatRef } from '../../services/trade/chatSessions';
import * as chatStore from '../../services/trade/chatStore';
import type { LiveEntry, LiveSession } from '../../services/trade/chatStore';
import { panelSeatKey } from '../../services/trade/chatPanel';
import { createChatTurnRunner } from '../../services/trade/chatTurnRunner';
import type { ChatTurnRunnerDeps, PanelTurnContext } from '../../services/trade/chatTurnRunner';
import type { ChartSnapshot } from './TradingChart';
import type { ChartInterval } from '../../utils/chartIntervals';
import BiasChips from './BiasChips';
import { saveBot, type AgentBot } from '../../services/agents/agentRoster';
import { resolveAgentContext, SINGLE_AGENT_MEMORY_BUDGET, type ResolvedAgentContext } from '../../services/agents/agentContext';
import { getFirstReadyProvider, isProviderReady, formatModelDisplayName, computeChatModelFallback } from '../../utils/providerUtils';
import { skillIndexRows } from '../../services/learning/SkillFileService';
import { getMemoryFiles } from '../../services/learning/MemoryFilesService';
import { buildNotebookTopicsIndex } from '../../services/learning/memoryTopics';
import { indexBudgetFor } from '../../utils/promptIndexBudget';
import { buildLearningRulesIndex } from '../../utils/learningRulesIndex';
import { storageService } from '../../services/infrastructure/StorageService';
import { buildProfileMemoryIndex } from '../../services/learning/profileMemory';
import { buildGoalsIndex } from '../../services/goals/GoalService';
import type { ReasoningEffort } from '../../services/providers/reasoningControls';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import ChatHistoryPalette, { relTime } from './panels/ChatHistoryPalette';
import ChatTranscriptList from './panels/ChatTranscriptList';
import ChatComposer from './panels/ChatComposer';
import { consumePendingSkillTry } from '../chat/skillDeepLink';
import ModelPicker from '../shared/ModelPicker';
import NewBotDialog from '../chat/NewBotDialog';

/** The running-turn identity moved beside the orchestrator that mints it
 *  (services/trade/chatTurnRunner); re-exported so the canvas owner
 *  (TradeView) keeps importing it from here. */
export type { PanelTurnContext };
/** Test hooks that moved with their caches — same names, same importers. */
export { __clearPacketCacheForTests } from '../../services/trade/chatTurnRunner';
export { __clearProposalStateForTests } from './panels/ChatTranscriptList';

interface TradeChatPanelProps {
    /** The Settings memory toggle — false strips the notebook-topics block
     *  from the dock seat prompt, the same promise the Agents surface keeps. */
    memoryEnabled?: boolean;
    /** The Settings → Strategies master switch — false strips the active plans
     *  and the uploaded books from this dock seat, the same promise the Chat
     *  surface keeps. */
    strategiesEnabled?: boolean;
    symbol: string;
    interval: string;
    providers: ProviderConfig[];
    selectedChatModel: string;
    onSelectChatModel: (modelId: string) => void;
    /** Websocket feed status label for the header hint only — the panel's
     *  context packet is fetched fresh per send regardless. */
    live?: boolean;
    /** Levels currently drawn on the chart (Entry/SL/TP) — forwarded to the
     *  desk tools so get_chart_view can report what the user sees. */
    chartLevels?: { label: string; price: number }[];
    /** The user's own chart drawings (trendlines, zones…) — model-readable. */
    chartDrawings?: ChartDrawing[];
    /** Shapes the MODEL drew via desk tools — merged into what the model
     *  reads (so it sees its own marks) and rendered by the chart. */
    modelDrawings?: ChartDrawing[];
    /** Desk-tool drawing surface (draw_on_chart / mark_trade_levels).
     *  `turn` names the RUNNING turn's session/entry/symbol/interval —
     *  persistence must key off IT, never off whichever session the user
     *  happens to be watching when the tool lands (per-turn identity). */
    addModelDrawings?: (drawings: ChartDrawing[], turn?: PanelTurnContext) => void;
    /** Clear only the model's own shapes (clear_chart_drawings scope=model). */
    clearModelDrawings?: (turn?: PanelTurnContext) => void;
    /** Clear model + user shapes (scope=all — only on the user's request). */
    clearAllDrawings?: (turn?: PanelTurnContext) => void;
    /** Captures the current chart (candles + drawings) as a PNG data URL. */
    onCaptureChart?: () => string | null;
    /** Plain-data snapshot of everything the canvas currently displays
     *  (last bars, mark, levels, drawings) — rides the context block so the
     *  model reads the SAME numbers the user sees, not a re-fetch. */
    getChartSnapshot?: () => ChartSnapshot | null;
    /** Roster bots — a session can be bound to one for its persona. */
    bots?: AgentBot[];
    /** The user's logged trade history — feeds the desk tools' recall /
     *  get_setup_history_stats so the model learns from what the user traded. */
    trades?: LoggedTrade[];
    /** A roster click (Agents tab) asked Chart AI to open this bot: create
     *  (or switch to) a session bound to it. Nonce-keyed so repeats work. */
    botSessionRequest?: { botId: string; nonce: number };
    /** Same, for group rooms. The Coach inbox is not here — it moved to the
     *  Learning surface when the tabs went into the hamburger menu. */
    groupSessionRequest?: { groupId: string; nonce: number };
    /** Launches the FULL ensemble pipeline from this chat. Absent ⇒ the option
     *  is hidden. It resolves when the run ENDS: the pipeline writes the
     *  question and its streaming answer into the ACTIVE conversation, and this
     *  dock renders that conversation, so nothing is handed back and no entry
     *  needs an App-side message id stamped on it. */
    onRunAnalysis?: (prompt: string, images: Array<{ name: string; dataURL: string }>) => Promise<void>;
    /** Where a run that never started says why ("already running", "no
     *  providers configured") — the failures with no transcript row to carry
     *  them. Absent ⇒ a rejected run is silent, which reads as a dead button. */
    onAnalysisError?: (message: string) => void;
    /** Stop the running analysis (the pipeline's own cancel). The composer's
     *  Stop needs both this and the chat controller: a Full analysis is a chat
     *  turn WHOSE WORK is the pipeline, and aborting only the turn's controller
     *  left the run streaming under a bubble that said it had stopped. */
    onStopRun?: () => void;
    /** Resolve the message id `onRunAnalysis` handed back into the App-side
     *  message, so a settled answer can show what its verdict was built on —
     *  the why-avoid breakdown, the evidence the moderator actually saw, the
     *  stage ladder. Resolved lazily rather than copied into the entry, because
     *  a stored session would otherwise carry a whole `TradeAnalysis` per
     *  answer. Absent ⇒ the audit block does not render. */
    getAnalysisMessage?: (messageId: string) => Message | undefined;
    /** "Log this trade" on a model proposal → App records it as an OPEN
     *  (PENDING) trade the outcome autopilot later scores. Absent ⇒ the Log
     *  button is hidden (no journal attached). */
    onLogProposedTrade?: (proposal: TradeProposal) => void;
    /** Report a presented plan to the harness level-watch (TradeView arms
     *  it; a later price touch comes back as a [HARNESS SIGNAL] turn).
     *  `turn` carries the RUNNING turn's identity (see PanelTurnContext). */
    onPlanPresented?: (plan: WatchPlan, turn?: PanelTurnContext) => void;
    /** A message's Key Levels card pushes its resolved lines here so the
     *  canvas can draw them (toggle / pin / hover states already decided);
     *  null clears. Owned by TradeView — the chart stays the single renderer. */
    onChatLevelsChange?: (payload: MessageLevelLines | null) => void;
    /** Group rooms carried into the dock: the room renders INSIDE the session
     *  tabs (App owns the wiring — the dock only shows the slot). Absent ⇒
     *  those session options are hidden. The Coach inbox is not one of them:
     *  it lives on the Learning surface now. */
    renderGroupSurface?: (groupId: string) => React.ReactNode;
    /** Group rooms available to open as a session (title for the tab). */
    groups?: Array<{ id: string; name: string }>;
    /** Imperative scroll-to-entry bridge for App-level affordances ("Jump to
     *  latest analysis", the saved-analyses gallery's Locate). This dock is
     *  the app's only real transcript scroller, so it hands App a function
     *  that scrolls the entry whose `data-message-id` matches the given id
     *  into view; the cleanup passes null so App never calls into an
     *  unmounted dock. (Replaces the old virtuosoRef, which pointed at a
     *  list this panel never rendered as a Virtuoso.) */
    registerScrollToMessage?: (fn: ((messageId: string) => void) | null) => void;
    /** Dock geometry controls, hoisted to the trade layout (drag handle).
     *  There is deliberately no `collapsed` prop: the dock is HIDDEN, not
     *  closed, so this component stays mounted while collapsed and this
     *  never renders a second copy of itself. See ChartAiDockRail below. */
    onToggleCollapsed?: () => void;
    expanded?: boolean;
    onToggleExpanded?: () => void;
    /** Create a group room. The dock could already OPEN rooms and create
     *  bots, but not make a new one — so "groups" in the dock meant
     *  "the groups that already exist elsewhere". The Chat rail owns
     *  both, and the dock is meant to be its compact form, not a
     *  second-class one. */
    onNewGroup?: () => void;
    /** The canonical conversation for the bot this session is bound to,
     *  as rows. LIVE, not a snapshot: App recomputes it whenever
     *  `messages` changes, so a turn said in the Agents surface appears in an
     *  already-open dock session without the trader reopening anything. */
    botThreadRows?: Message[];
    /** The Agents surface's current thread, handed over by the surface that owns
     *  the selection. Used ONLY for a session bound by `conversationId` — the
     *  link that makes one conversation visible in both homes. It is passed in
     *  rather than recomputed here because deciding which rows belong to a
     *  thread is `utils/agentThreads`' job and a second caller of it with its
     *  own arguments would be a second opinion about message ownership. */
    conversationRows?: Message[];
    /** Commit a bot turn asked HERE into the canonical conversation.
     *  `answer === undefined` is the trader's question; a string is the
     *  settled answer. Fired twice, so the question shows in the other
     *  surface while it is still being answered. */
    onBotTurnCommit?: (bot: AgentBot, prompt: string, answer?: string, workedMs?: number, effort?: ReasoningEffort) => void;
    /** Commit a SOLO turn asked HERE into the conversation this session is bound
     *  to, keyed by the entry's own id. See `ChatTurnRunnerDeps.onSoloTurnCommit`
     *  — without it the merged thread is readable from this pane but nothing a
     *  trader types here ever reaches the other home. */
    onSoloTurnCommit?: ChatTurnRunnerDeps['onSoloTurnCommit'];
    /** Adopt (or mint) the App conversation a solo dock turn speaks into, and
     *  make the Agents surface show it. Without it a session started on the Trade
     *  screen had no thread at all, so nothing said here could ever appear
     *  there — the two homes were two transcripts wearing one app. */
    onSyncConversation?: ChatTurnRunnerDeps['onSyncConversation'];
    /** Jump straight to the Agents surface from the dock header. Routed
     *  through App's surface select so the directional enter animation
     *  (Chat arrives from the left) fires like every other Chat hop. */
    onOpenChat?: () => void;
    /** Triggers a fresh discovery of models from configured providers. */
    onRefreshModels?: () => Promise<void>;
    /** Pin / unpin the signal behind an entry. Only entries that carry an
     *  App-side analysis message id can be pinned — a plain chat answer has no
     *  setup to track, and the Pinned list reads the flag off the message. */
    onToggleWatch?: (messageId: string) => void;
    /** Message ids currently pinned, so the chip shows the real state. */
    pinnedMessageIds?: ReadonlySet<string>;
}

/** Empty-state starters. The glyph is a category cue so the row scans by
 *  intent; the chip's text is what gets sent, byte-for-byte unchanged. */
const QUICK_PROMPTS: { text: string; Icon: React.FC<{ className?: string }> }[] = [
    { text: 'Read this chart', Icon: Eye },
    { text: 'Key levels?', Icon: Crosshair },
    { text: 'What is the bias?', Icon: Compass },
    { text: 'Order-flow pressure?', Icon: Activity },
];

/**
 * The collapsed Chart AI dock — a 10px column carrying only an expand
 * affordance, the name, and the live/busy light.
 *
 * Extracted from what used to be an early return inside TradeChatPanel so the
 * dock can be HIDDEN rather than closed. That panel used to render itself
 * twice: collapsed it returned this rail, expanded it returned the dock, and
 * React unmounted one to mount the other. Collapsing mid-turn therefore threw
 * away the composer draft, the scroll position and the in-flight stream —
 * the user collapsed the dock to see the chart, and came back to an empty one.
 * Now TradeView mounts the panel exactly once and hides it, so this is
 * presentation only and carries no panel state.
 */
export const ChartAiDockRail: React.FC<{
    onExpand: () => void;
    live: boolean;
}> = ({ onExpand, live }) => (
    <div
        className="flex h-10 w-full shrink-0 flex-row items-center gap-3 border-l border-hairline bg-zinc-900/40 px-3 lg:h-full lg:w-10 lg:flex-col lg:py-3"
        data-testid="trade-chat-rail"
    >
        <button
            type="button"
            onClick={onExpand}
            title="Expand Chart AI"
            aria-label="Expand Chart AI"
            className="rounded-control p-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
        >
            <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="select-none text-ui-xs font-bold uppercase tracking-widest text-zinc-500 lg:[writing-mode:vertical-rl]">Chart AI</span>
        {/* `live` only, not `busy`: busy is derived from the chat store's
            running map inside the panel, and reproducing that subscription out
            here to animate one 8px light on a 10px column would be a second
            source of truth for the same fact. One click away is the dock. */}
        <span className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
    </div>
);

const TradeChatPanel: React.FC<TradeChatPanelProps> = ({
    memoryEnabled, strategiesEnabled, symbol, interval, providers, selectedChatModel, onSelectChatModel, live = false,
    chartLevels, chartDrawings, modelDrawings, addModelDrawings, clearModelDrawings, clearAllDrawings,
    onCaptureChart, getChartSnapshot, bots = [], trades = [], botSessionRequest, groupSessionRequest, onRunAnalysis, onAnalysisError, onStopRun, getAnalysisMessage, onLogProposedTrade, onPlanPresented,
    onChatLevelsChange,
    renderGroupSurface, groups = [],
    registerScrollToMessage,
    onToggleCollapsed, expanded, onToggleExpanded, onOpenChat,
    onNewGroup, botThreadRows, conversationRows, onBotTurnCommit,
    onSoloTurnCommit,
    onSyncConversation,
    onToggleWatch, pinnedMessageIds,
    onRefreshModels,
}) => {
    // Session state lives in the module store (chatStore) so an in-flight
    // answer survives switching to another surface tab and back — the panel
    // unmounts, but the run keeps streaming into the store.
    const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const sessions = snap.sessions;
    const activeId = snap.activeId;
    const [draft, setDraft] = useState('');
    const [contextAt, setContextAt] = useState<number | null>(null);
    // The same reader the Agents composer uses (hooks/useChatAttachments was
    // lifted out of this file so the second surface could reuse it verbatim).
    const {
        attachments, fileInputRef, attachFiles, add: addAttachment,
        remove: removeAttachment, clear: clearAttachments, images: attachedImages,
    } = useChatAttachments();
    const [showNewMenu, setShowNewMenu] = useState(false);
    /** The reference's Agent-panel header cluster: + / history / ⋯ / ×. The
     *  history button opens a "Past Conversations" palette (search + recent
     *  sessions with relative times); ⋯ opens the Customization popover. */
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyQuery, setHistoryQuery] = useState('');
    const [historySel, setHistorySel] = useState(0);
    const [historyShowAll, setHistoryShowAll] = useState(false);
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const [showNewBot, setShowNewBot] = useState(false);
    const [panelPickerFor, setPanelPickerFor] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    /** Which Key Levels card currently owns the shared chart-levels channel
     *  (message id of the card that last PUSHED). Its unmount may clear the
     *  layer; any other card's clear is dropped — see handleCardLevels. */
    const chatLevelsOwnerRef = useRef<string | null>(null);

    const activeSession = sessions.find(s => s.id === activeId) ?? sessions[0];
    const isPanel = activeSession.kind === 'panel';
    /** The composer's thinking tier — read from the SESSION ROW, not component
     *  state. The dock unmounts when you hop to the Agents surface, so a `useState`
     *  here died with it and the two homes disagreed about what the chat was
     *  asking for. Both now render one chip over one field, and a turn sends
     *  exactly what the chip shows (`chatTurnRunner` → `resolveComposerEffort`). */
    const effort: ReasoningEffort = activeSession.effort ?? 'auto';
    /** A bot session starts EMPTY, and that is correct: a bot's conversation
     *  belongs to `messages`, which this session renders as a view of
     *  (`entriesForSession`). Seeding the session with a copy of it on open
     *  is what made the dock's transcript a stale snapshot — the copy could
     *  never learn anything the canonical store did not already say. */
    const openBotSession = useCallback((botId: string): void => {
        chatStore.addSession({ botId });
    }, []);

    const boundBot = activeSession.botId ? bots.find(b => b.id === activeSession.botId) : undefined;

    // THE STORE CUT. A bot's conversation has exactly one owner — App's
    // `messages`, which is what the Journal, the analyses gallery, the learning
    // loop and the Chat rail all read, and what a bot turn is learned from. A
    // dock session's own `entries` is only a copy, seeded once when the bot was
    // opened, so anything said since was not there and reopening could not fix
    // a copy that was already stale.
    //
    // For a bot session, the session is therefore a VIEW of the canonical
    // conversation plus the row that has no counterpart yet: the answer
    // currently streaming, which joins `messages` only once it settles.
    //
    // ONE merge — `entriesForSession` in `services/trade/chatSessions.ts` — is
    // imported by BOTH readers: this render and the model's own history in
    // `chatTurnRunner`. That is the point: if the trader and the bot could read
    // two different conversations, the store cut would have moved the split
    // rather than closed it. A session with no counterpart passes through
    // untouched — `canonicalRows` is undefined unless this session IS a view of
    // a conversation, which means either a bot session (bound by `botId`) or a
    // Chat-surface session bound by `conversationId`. A chart-side session with
    // neither is a conversation of its own, with its own tool rounds and key
    // levels, and has no counterpart to be a view of.
    const canonicalRows = boundBot
        ? botThreadRows
        : (activeSession.conversationId ? conversationRows : undefined);
    const entries = useMemo<LiveEntry[]>(
        () => entriesForSession(activeSession.entries, canonicalRows),
        [activeSession.entries, canonicalRows],
    );
    /** Busy in EITHER home. `running` is the dock's own stream; a session bound
     *  to a conversation is also busy while the CHAT surface is answering in it,
     *  because the two homes are one thread and the composer must show Stop (and
     *  refuse a second send) for a run it did not start. The registry is the
     *  pipeline's own — `beginConversationRun` — so this cannot drift from it. */
    const conversationBusy = !!activeSession.conversationId && !!snap.conversationRunning[activeSession.conversationId];
    const busy = !!snap.running[activeId] || conversationBusy;

    /** The freshest mark for the levels card's Dist column + "last" divider —
     *  read from the canvas snapshot (the markPrice@1s line), never a re-fetch. */
    const getMarkForDist = useCallback((): number | null => {
        const m = getChartSnapshot?.()?.markPrice ?? null;
        return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null;
    }, [getChartSnapshot]);

    /** Ownership-arbitrated Key Levels → chart channel. Every Key Levels
     *  card reports (payload, ownerId) through this single dock-owned pipe:
     *  a PUSH always takes ownership (the most-recent card to draw owns the
     *  layer), and a CLEAR only forwards when it comes from the CURRENT
     *  owner — so card A unmounting can no longer null the live lines card
     *  B is still drawing (deep-dive 2026-09-15, KeyLevelsCard). */
    const handleCardLevels = useCallback((payload: MessageLevelLines | null, ownerId?: string): void => {
        if (payload) {
            chatLevelsOwnerRef.current = ownerId ?? null;
            onChatLevelsChange?.(payload);
        } else if (!ownerId || chatLevelsOwnerRef.current === ownerId) {
            chatLevelsOwnerRef.current = null;
            onChatLevelsChange?.(null);
        }
    }, [onChatLevelsChange]);

    /** Compact index of the trader's skill library — rides the system prompt
     *  so the model APPLYs existing skills and strategies instead of
     *  free-styling (the mandate lives in TRADE_CHAT_SYSTEM_PROMPT). Read
     *  FRESH on every prompt build (not a memo): a skill created, updated or
     *  merged mid-session — by `skill_write` or from the library — is in the
     *  next turn's prompt. One sync index read per send, against a network
     *  packet fetch: negligible. */
    const skillsIndexForPrompt = (config: ProviderConfig | null): string => {
        try {
            // The ONE projection (SkillFileService.skillIndexRows), so this
            // surface and the Agents surface name the same skills.
            // The notebook topics ride the same block — listing-first recall,
            // one line per subject, bodies on demand. ONE budget shared with
            // the Agents surface (utils/promptIndexBudget), scaled to the seat's
            // context window, so a small local model gets small indexes in
            // both homes.
            const budget = indexBudgetFor(config?.contextWindowTokens ?? 200_000);
            const store = getMemoryFiles();
            const topics = memoryEnabled !== false ? buildNotebookTopicsIndex(store.files, store.folders, budget.topics) : '';
            const goals = buildGoalsIndex(budget.goals);
            // The learned rules ride the same block as the Agents surface: they had
            // no reader at all before (the 2026-10-27 audit M-5), and a rule only one of
            // the two homes can see is the drift this file keeps fixing.
            const rules = memoryEnabled !== false
                ? buildLearningRulesIndex(storageService.loadLearningRules().rules, Math.min(6, budget.skills))
                : '';
            return [goals, buildSkillsIndexForPrompt(skillIndexRows(), budget.skills), rules, topics].filter(Boolean).join('\n\n');
        } catch {
            return '';
        }
    };

    /**
     * The ACTIVE strategy plans, injected beside the skills index so a skill
     * that references a plan and the plan itself travel together. Drafts are
     * deliberately excluded: an unapproved plan presented to a seat as
     * guidance is the defect the review flagged, and a store nothing reads is
     * the other half of it.
     */
    const strategiesForPrompt = (): string => {
        try {
            return activeStrategiesBlock(3, { enabled: strategiesEnabled });
        } catch {
            return '';
        }
    };

    /** The system prompt every seat of this session answers under. The
     *  collaboration-memory index is read FRESH per prompt (like the skills
     *  index): a `remember` call lands in the NEXT turn's prompt immediately,
     *  and the model always sees what it already knows before writing — the
     *  update-don't-duplicate discipline of this environment's memory.
     *
     *  `bot` is resolved through `resolveAgentContext`, the same loader the
     *  desk answers with, so persona and notes cannot be assembled one way at
     *  the chart and another way at the desk — which is how one named agent
     *  ends up knowing less in one place than the other. `roleNote` is about
     *  the ROOM (you are one of N seats), so it stays the caller's. */
    const systemPromptFor = useCallback((bot?: AgentBot, roleNote?: string): string => {
        const skillsBlock = skillsIndexForPrompt(provider);
        const strategiesBlock = strategiesForPrompt();
        // ONE setting, one answer: the Agents surface gates this block on the same
        // flag AND passes the same scaled budget (chatSurfaceTurn.ts:155-162).
        // The dock used to inject the profile index with memory switched OFF and
        // with the default row count on an 8k model, so the two homes disagreed
        // about both the toggle and the size (the 2026-10-27 audit M-3).
        const memoryBlock = memoryEnabled !== false
            ? buildProfileMemoryIndex(undefined, indexBudgetFor(provider?.contextWindowTokens ?? 200_000).memory)
            : '';
        let agent: ResolvedAgentContext | null = null;
        if (bot) {
            try {
                // One agent answering, so it gets the whole allowance — the
                // debate divides the same total across its roster.
                const knownCoins = [...new Set(
                    (trades ?? [])
                        .map(t => t?.analysis?.coinName)
                        .filter((a): a is string => typeof a === 'string' && a.length >= 2),
                )];
                agent = resolveAgentContext(bot, { coin: symbol, knownCoins }, SINGLE_AGENT_MEMORY_BUDGET);
            } catch {
                agent = null;
            }
        }
        const persona = [agent?.persona, roleNote].filter(Boolean).join('\n\n');
        // Same heading the desk uses (`buildBotSystemPrompt`) — one agent
        // should meet its own notes under one name wherever it is asked.
        const base = `${TRADE_CHAT_SYSTEM_PROMPT}${skillsBlock ? `\n\n${skillsBlock}` : ''}${strategiesBlock ? `\n\n${strategiesBlock}` : ''}${memoryBlock ? `\n\n${memoryBlock}` : ''}${agent?.notes ? `\n\n## Your private notes\n${agent.notes}` : ''}`;
        return persona ? `${base}\n\n## Your role\n${persona}` : base;
    }, [symbol, trades, memoryEnabled, strategiesEnabled]);

    /** What the model reads as "the drawings on the chart": the user's own
     *  shapes PLUS the model's marks from earlier turns — so it sees its own
     *  Entry/SL/TP lines and builds on them instead of redrawing. */
    const allDrawings = useMemo(
        () => [...(chartDrawings ?? []), ...(modelDrawings ?? [])],
        [chartDrawings, modelDrawings],
    );

    // The solo chat model: a `providerId::modelId` selection (the composer's
    // picker is provider-qualified so duplicate model names across providers
    // can't silently route to the wrong one). Legacy bare model ids resolve
    // heuristically; when nothing matches, the first ready provider answers
    // so the dock never dies — but NEVER silently: modelIssue explains it.
    // One computation, shared with the Agents surface composer: a stale pick must
    // read the same in both places.
    const fallback = useMemo(() => computeChatModelFallback(providers, selectedChatModel), [providers, selectedChatModel]);
    const provider = fallback.provider;
    // Panels answer from seats and bots from their own config, so a stale solo
    // pick is not their problem — but for the solo path the fallback must be
    // VISIBLE, never silent.
    const modelIssue = isPanel || activeSession?.botId ? null : fallback.issue;

    /** Resolve a `${providerId}:${modelId}` seat to a runnable config. */
    const configForSeat = useCallback((providerId: string, modelId: string): ProviderConfig | null => {
        const base = providers.find(p => p.id === providerId && isProviderReady(p)) ?? providers.find(p => p.id === providerId && p.isEnabled);
        if (!base) return null;
        return { ...base, selectedModel: modelId };
    }, [providers]);

    // ── The chat orchestrator (services/trade/chatTurnRunner) ──────────────
    // send / runFullAnalysis / runHarnessTurn never touch JSX — they run the
    // turns through chatStore plus this deps object. Rebuilt with useMemo over
    // exactly these entries: send's former dep array (the intermediate
    // buildContextBlock / runSeatTurn / maybeReviewSessions callbacks became
    // internal to the factory), with `effort`, `symbol` and `interval` now
    // explicit instead of arriving only transitively through them.
    const runner = useMemo(() => createChatTurnRunner({
        symbol,
        interval,
        memoryEnabled,
        effort,
        selectedChatModel,
        chartLevels,
        allDrawings,
        trades,
        getChartSnapshot,
        provider,
        configForSeat,
        systemPromptFor,
        bots,
        activeId,
        draft,
        sessions,
        botThreadRows,
        conversationRows,
        attachments,
        attachedImages,
        clearAttachments,
        setDraft,
        setContextAt,
        addModelDrawings,
        clearModelDrawings,
        clearAllDrawings,
        onPlanPresented,
        onBotTurnCommit,
        onSoloTurnCommit,
        onSyncConversation,
        onRunAnalysis,
        onAnalysisError,
    }), [symbol, interval, memoryEnabled, effort, selectedChatModel, chartLevels, allDrawings, trades, getChartSnapshot, provider, configForSeat, systemPromptFor, bots, activeId, draft, sessions, botThreadRows, conversationRows, attachments, attachedImages, clearAttachments, setDraft, setContextAt, addModelDrawings, clearModelDrawings, clearAllDrawings, onPlanPresented, onBotTurnCommit, onSoloTurnCommit, onSyncConversation, onRunAnalysis, onAnalysisError]);
    const { send, runFullAnalysis, runHarnessTurn } = runner;

    // ── Per-session composer memory ─────────────────────────────────────────
    // The thinking tier is a session FIELD and is read straight off it above, so
    // there is nothing to restore here. The solo-model choice still lives in
    // App's state, so switching sessions still has to rebind it — the same way
    // panel sessions restore their seats. Reads the store fresh inside the
    // effect so it fires on SWITCH, not on every streaming patch.
    const soloModelRef = useRef(selectedChatModel);
    soloModelRef.current = selectedChatModel;
    // Composer textarea, so a "Try in chat" skill chip can drop its /slug in
    // and hand focus back to the user (see the august:try-skill listener).
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    // Strategy Studio / learning-queue "Try in chat" (and the skill-citation
    // chips): prepend the skill's /slash-invocation to the composer and focus
    // it, so the user lands on the chat with the skill ready to invoke. Send
    // stays manual. The listener lives here because the Chart AI dock owns the
    // composer now (the old ChatInput that handled this was deleted).
    const applySkillToken = useCallback((slug: string): void => {
        const token = `/${slug.replace(/\.md$/i, '')}`;
        setDraft(prev => {
            const base = prev.trimStart();
            if (base.startsWith(`${token} `) || base === token) return prev; // already invoked
            return base ? `${token} ${base}` : `${token} `;
        });
        const el = composerRef.current;
        if (el) { el.focus(); const end = el.value.length; try { el.setSelectionRange(end, end); } catch { /* detached */ } }
    }, []);
    useEffect(() => {
        // Surfaces render exclusively, so a tap on Studio's "Try in chat" lands
        // while this dock is unmounted and its broadcast reaches nobody. Take
        // what the hand-off parked — that is what makes the button real there.
        const parked = consumePendingSkillTry();
        if (parked) applySkillToken(parked);
        const onTrySkill = (ev: Event): void => {
            const slug = (ev as CustomEvent<{ slug?: string }>).detail?.slug;
            if (!slug) return;
            // Delivered live: drop the parked copy or the next mount re-applies
            // a token the user already saw.
            consumePendingSkillTry();
            applySkillToken(slug);
        };
        window.addEventListener('august:try-skill', onTrySkill);
        return () => window.removeEventListener('august:try-skill', onTrySkill);
    }, [applySkillToken]);
    /** Composer model change: keep the app-wide default AND bind it to the
     *  active session so coming back to this chat reselects it. The per-session
     *  half goes through the store's own writer, because the Agents surface's chip
     *  writes the same field and two rules for one row is how the two homes
     *  start answering with different models. */
    const changeSoloModel = useCallback((value: string): void => {
        onSelectChatModel(value);
        chatStore.setActiveSoloModel(value);
    }, [onSelectChatModel]);
    /** One write, on the row both homes read — no component state to keep in
     *  step, so nothing here can go stale while the Agents surface changes it. */
    const changeEffort = useCallback((next: ReasoningEffort): void => {
        chatStore.mutate(activeId, sess => ({ ...sess, effort: next }));
    }, [activeId]);

    // Follow the bottom while the answer streams — UNLESS the user scrolled
    // up to read. Wheel/touch position wins over the auto-follow: scrolling
    // up unpins (returning near the bottom, or sending a message, re-pins).
    const stickToBottomRef = useRef(true);
    /** The trader has scrolled away from the newest row — the one state the
     *  follow-the-bottom behaviour will NOT fix on its own, because a
     *  transcript that moves while you read it cannot be read. The jump
     *  control is the way back, and it is the same control the Agents surface
     *  mounts (components/shared/JumpToLatestFab.tsx), on the same threshold:
     *  one rule for both homes, so neither yanks a reader the other one
     *  offered a button for. */
    const [scrolledAway, setScrolledAway] = useState(false);
    const onChatScroll = useCallback((): void => {
        const el = scrollRef.current;
        if (!el) return;
        const away = el.scrollHeight - el.scrollTop - el.clientHeight > JUMP_AWAY_PX;
        stickToBottomRef.current = !away;
        setScrolledAway(away);
    }, []);
    /** The newest-message count and session the transcript last followed.
     *  A NEW trader message re-pins the follow even if they had scrolled up
     *  to read — sending is an action, and the answer must not land where
     *  they cannot see it. A retry keeps the same user row, so this counts
     *  user rows rather than comparing array lengths (the retry path drops
     *  the stale answers first, which changes the length without asking). */
    const prevUserCountRef = useRef(0);
    const prevActiveIdRef = useRef(activeId);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const userCount = entries.reduce((n, e) => n + (e.role === 'user' ? 1 : 0), 0);
        if (userCount > prevUserCountRef.current) stickToBottomRef.current = true;
        prevUserCountRef.current = userCount;
        if (prevActiveIdRef.current !== activeId) {
            prevActiveIdRef.current = activeId;
            stickToBottomRef.current = true;
            setScrolledAway(false);
        }
        // A retry re-uses the user's row (so the count above does not move) and
        // then paints a fresh empty AI placeholder after it. That is a new
        // question from the trader's point of view, and the answer must be
        // visible even if they had scrolled up to press Retry.
        const last = entries[entries.length - 1];
        const beforeLast = entries[entries.length - 2];
        if (last?.role === 'ai' && last.streaming && !last.text?.trim() && beforeLast?.role === 'user') {
            stickToBottomRef.current = true;
        }
        if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [entries, activeId]);
    // Following only on `entries` was not enough: the transcript's own height
    // changes when the composer grows (its context stamp / warning line), and
    // rows grow AFTER the last entry patch (the Key Levels card mounts, fonts
    // and markdown settle, a disclosure opens). Either growth left the newest
    // lines clipped below the fold with no jump control to reach them — the
    // answer read as truncated until a reload re-scrolled the conversation
    // from the top. So watch BOTH the box's size and its content, and after
    // every change either re-pin (the reader is at the bottom) or re-measure
    // whether the newest row is now out of reach (so the control appears).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        let frame = 0;
        const settle = (): void => {
            frame = 0;
            const box = scrollRef.current;
            if (!box) return;
            if (stickToBottomRef.current) {
                box.scrollTop = box.scrollHeight;
                return;
            }
            setScrolledAway(box.scrollHeight - box.scrollTop - box.clientHeight > JUMP_AWAY_PX);
        };
        const schedule = (): void => {
            if (frame) return;
            frame = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(settle)
                : window.setTimeout(settle, 0);
        };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
        ro?.observe(el);
        const mo = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(schedule)
            : null;
        mo?.observe(el, { childList: true, subtree: true, characterData: true });
        window.addEventListener('resize', schedule);
        return () => {
            ro?.disconnect();
            mo?.disconnect();
            window.removeEventListener('resize', schedule);
            if (frame) {
                if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
                else window.clearTimeout(frame);
            }
        };
    }, [activeId, activeSession.kind]);
    /** One click returns to the newest row, and re-pins the follow so the next
     *  streamed line keeps arriving where the trader is looking. */
    const jumpToLatest = useCallback((): void => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
        stickToBottomRef.current = true;
        setScrolledAway(false);
    }, []);

    // ── Imperative scroll-to-entry bridge (see registerScrollToMessage) ────
    // The dock owns the only real transcript scroller, so App's affordances
    // ("Jump to latest analysis", the gallery's Locate) route the scroll
    // through this registered function instead of a never-attached handle.
    // Entries are stamped `data-entry-id` (the chatStore entry id — what
    // jump-to-latest resolves from the store) and `data-message-id` (the
    // App-side analysis message id when this entry carries one, else the
    // entry id — what the gallery's Locate passes). A miss is a deliberate
    // no-op: the group room renders no transcript, and an analysis
    // card that isn't in THIS dock's session must not yank the user
    // somewhere unrelated.
    useEffect(() => {
        if (!registerScrollToMessage) return;
        registerScrollToMessage((messageId: string): void => {
            const container = scrollRef.current;
            if (!container || !messageId) return;
            const nodes = container.querySelectorAll<HTMLElement>('[data-entry-id]');
            for (const node of Array.from(nodes)) {
                if (node.getAttribute('data-entry-id') === messageId
                    || node.getAttribute('data-message-id') === messageId) {
                    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    return;
                }
            }
        });
        return () => { registerScrollToMessage(null); };
    }, [registerScrollToMessage]);

    // The composer's "ctx HH:MM PHT" badge reports when the LAST packet was
    // fetched — a fetch made for a DIFFERENT coin or a DIFFERENT session
    // says nothing about this one. Clear it on any switch so the badge falls
    // back to `SYMBOL · INTERVAL` until the first send under the new setup
    // stamps a real time (the stale previous-coin fetch time was the bug).
    useEffect(() => {
        setContextAt(null);
    }, [symbol, activeId]);

    // NOTE: no unmount-abort on purpose. Switching to another surface tab
    // unmounts this panel; the run must keep streaming into the store so
    // returning shows the completed answer. Only an explicit Stop (or
    // deleting a session) aborts.

    // The Agents tab handed us a bot: reuse (or create) its bound session
    // and make it active. Nonce-keyed so re-clicking the same bot re-fires.
    const lastBotRequestRef = useRef(0);
    useEffect(() => {
        if (!botSessionRequest || botSessionRequest.nonce === lastBotRequestRef.current) return;
        lastBotRequestRef.current = botSessionRequest.nonce;
        const existing = sessions.find(s => s.botId === botSessionRequest.botId);
        if (existing) { chatStore.setActiveId(existing.id); return; }
        openBotSession(botSessionRequest.botId);
    }, [botSessionRequest, sessions, openBotSession]);

    // Group rooms opened from the roster rail.
    const lastGroupRequestRef = useRef(0);
    useEffect(() => {
        if (!groupSessionRequest || groupSessionRequest.nonce === lastGroupRequestRef.current) return;
        lastGroupRequestRef.current = groupSessionRequest.nonce;
        const name = groups.find(g => g.id === groupSessionRequest.groupId)?.name ?? 'Room';
        const existing = sessions.find(s => s.groupId === groupSessionRequest.groupId);
        if (existing) { chatStore.setActiveId(existing.id); return; }
        chatStore.addSession({ kind: 'group', title: name, groupId: groupSessionRequest.groupId });
    }, [groupSessionRequest, groups, sessions]);

    const mutate = (id: string, fn: (s: LiveSession) => LiveSession): void => {
        chatStore.mutate(id, fn);
    };

    // Flush queued harness signals when the session goes idle. takeHarness-
    // Signals emits, so this re-runs with an empty queue and settles.
    // KIND GATE: runHarnessTurn streams into the ACTIVE session's transcript
    // — but the group room renders a different surface the dock
    // never shows chat entries in. Draining into one would consume the queue
    // invisibly (the warning vanishes without ever reaching a model turn).
    // With a non-chat session selected the signals HOLD in the store;
    // switching back to a chat session re-fires this effect and drains.
    // The hold notice logs ONCE per episode — `sessions` is a fresh array on
    // every store emit, so an ungated log would spam the console per tick.
    const heldNoticeRef = useRef<string | null>(null);
    useEffect(() => {
        if (busy || snap.signals.length === 0) { heldNoticeRef.current = null; return; }
        const session = sessions.find(s => s.id === activeId) ?? sessions[0];
        if (session && session.kind !== 'solo' && session.kind !== 'panel') {
            if (heldNoticeRef.current !== session.id) {
                heldNoticeRef.current = session.id;
                console.info(`[Chart AI] holding ${snap.signals.length} harness signal(s): the active session is a ${session.kind}, not a chat — it will drain when a chat session is selected.`);
            }
            return;
        }
        heldNoticeRef.current = null;
        // HAND EACH WAKE TO ITS OWN THREAD. The queue records which session armed
        // a watch or owns the plan; the panel takes the signals for the session on
        // screen, and when the only queued ones belong to another CHAT session it
        // switches there and lets this effect drain them. Before this, a wake for
        // one chart was answered in whichever thread was on screen
        // (the 2026-10-27 audit L-7).
        const forActive = chatStore.takeHarnessSignals(activeId);
        if (forActive.length > 0) {
            void runHarnessTurn(forActive.map(s => s.text).join('\n\n'));
            return;
        }
        const owned = snap.signals.find(s => s.sid && sessions.some(x => x.id === s.sid && (x.kind === 'solo' || x.kind === 'panel')));
        if (owned?.sid && owned.sid !== activeId) {
            chatStore.setActiveId(owned.sid);
            return; // this effect re-runs with the owning session active
        }
        // Unbound signals (a level hit from a conversation, or a watch armed before
        // the field existed) still drain to the active session.
        const unbound = chatStore.takeHarnessSignals('unbound');
        if (unbound.length > 0) void runHarnessTurn(unbound.map(s => s.text).join('\n\n'));
    }, [busy, snap.signals, runHarnessTurn, activeId, sessions]);

    // ── Session management ──────────────────────────────────────────────────
    /** `botId` used to be a second parameter here, which made this a THIRD way
     *  to open a bot — one that silently skipped the history adoption in
     *  `openBotSession`. Every bot now comes in through that one helper, and
     *  the parameter is gone rather than merely unused, so it cannot be
     *  reintroduced by a call site that "just needs a quick session". */
    const addSession = useCallback((kind: 'solo' | 'panel' = 'solo'): void => {
        // A new session starts bound to the chart + composer state on screen,
        // so coming back to it restores exactly this setup (send re-stamps on
        // every turn; a bot-bound session takes its model from the bot).
        const id = chatStore.addSession({
            kind,
            symbol,
            interval,
            effort,
            ...(kind === 'solo' && selectedChatModel ? { soloModel: selectedChatModel } : {}),
        });
        setShowNewMenu(false);
        if (kind === 'panel') setPanelPickerFor(id);
    }, [symbol, interval, effort, selectedChatModel]);

    const removeSession = useCallback((id: string): void => {
        // Abort the session's runs FIRST: chatStore.removeSession kills the
        // in-flight controllers, and a tool response already being processed
        // could otherwise save drawings after the delete and rebuild the
        // store (the delete-vs-flush resurrection the review found).
        chatStore.removeSession(id);
        // The session's drawings die WITH it — user's and the model's alike.
        // Without this, every deleted chat left a drawings store orphaned in
        // the store directory forever (the audit's session-delete finding).
        void deleteSessionDrawings(id);
    }, []);

    /** Panel seat management: add (max 5) / remove a model. */
    const setPanelModels = useCallback((sid: string, models: PanelSeatRef[]): void => {
        mutate(sid, s => ({ ...s, panelModels: models.slice(0, PANEL_MAX_MODELS) }));
    }, []);

    const addPanelSeat = useCallback((value: string): void => {
        if (!panelPickerFor) return;
        const [providerId, modelId] = value.includes('::') ? value.split('::') : [provider?.id ?? '', value];
        if (!modelId) return;
        const session = sessions.find(s => s.id === panelPickerFor);
        const current = session?.panelModels ?? [];
        const pid = providerId || provider?.id || '';
        // Dedupe on the seat key, not modelId alone: two relays offering one
        // model are distinct seats, and an agent seated on that same model must
        // not displace (or be displaced by) the plain model seat.
        const next: PanelSeatRef = { providerId: pid, modelId };
        if (current.some(m => panelSeatKey(m) === panelSeatKey(next))) return;
        setPanelModels(panelPickerFor, [...current, next]);
    }, [panelPickerFor, provider, sessions, setPanelModels]);

    /** Seat a roster agent on the panel: it answers as itself — persona, its own
     *  provider/model and its own notebook — beside plain model seats. It still
     *  carries the bot's model pair so the seat survives the agent being
     *  deleted from the roster later. */
    const addPanelAgentSeat = useCallback((botId: string): void => {
        if (!panelPickerFor) return;
        const bot = bots.find(b => b.id === botId);
        if (!bot) return;
        const session = sessions.find(s => s.id === panelPickerFor);
        const current = session?.panelModels ?? [];
        const next: PanelSeatRef = { providerId: bot.providerId, modelId: bot.modelId, botId: bot.id };
        if (current.some(m => panelSeatKey(m) === panelSeatKey(next))) return;
        setPanelModels(panelPickerFor, [...current, next]);
    }, [bots, panelPickerFor, sessions, setPanelModels]);

    // ── Attachments ─────────────────────────────────────────────────────────
    // Reading files in is the shared hook's job (see useChatAttachments); the
    // chart snapshot is the one image that never came off the picker.

    const captureChart = (): void => {
        const png = onCaptureChart?.() ?? null;
        if (!png) return;
        addAttachment({ kind: 'image', name: 'chart.png', payload: png });
    };

    const ready = !!provider && (activeSession.kind !== 'panel' || (activeSession.panelModels?.length ?? 0) >= 2);

    // Past Conversations palette rows: newest first, title-filtered, capped
    // at 8 until "Show N more…" (the reference's exact behavior).
    const historyFiltered = [...sessions]
        .filter(s => !historyQuery.trim() || s.title.toLowerCase().includes(historyQuery.trim().toLowerCase()))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const historyRows = historyShowAll ? historyFiltered : historyFiltered.slice(0, 8);
    const historyHidden = historyFiltered.length - historyRows.length;


    return (
        <div className="relative flex h-full min-h-0 flex-col border-l border-hairline bg-transparent" data-testid="trade-chat-panel">
            {/* Header — the reference's Agent-panel cluster: wordmark left,
                + / history / ⋯ / × right, nothing else. Conversations are
                reached through the Past Conversations palette, not a tab
                strip. */}
            <div className="@container flex shrink-0 items-center gap-2.5 border-b border-hairline bg-zinc-900/30 px-5 py-3">
                <span className={`h-2 w-2 shrink-0 rounded-full ${busy ? 'animate-pulse bg-cyan-400' : live ? 'bg-emerald-500' : 'bg-zinc-500'}`} aria-label={live ? 'live market feed connected' : 'market feed polling'} />
                {/* The dock is narrow and user-dragged, so the brand never
                    yields: at 370px a squeezed "Chart AI" wrapped into two
                    lines while the controls kept their width. The session
                    title is the flexible element — it truncates. */}
                <h2 className="shrink-0 whitespace-nowrap text-ui-base font-medium tracking-[-0.01em] text-zinc-100">Chart AI</h2>
                <span className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500" title={activeSession.title}>{activeSession.title}</span>
                {(() => {
                    // The prototype's "Analyzed 2m ago" meta, told honestly:
                    // the session's last real activity, and only once a settled
                    // answer exists to be "answered". Gated on the DOCK's width
                    // (@container), not the viewport — `sm:` lit this up on a
                    // 1440px window whose dock was 370px, which is what
                    // squeezed the title in the first place.
                    const hasAnswer = entries.some(x => x.role === 'ai' && !x.notice && !x.streaming && x.text);
                    if (!hasAnswer) return null;
                    return <span className="hidden shrink-0 text-ui-xs text-zinc-600 @min-[460px]:inline" data-testid="chat-answered-meta">answered {relTime(activeSession.updatedAt)}</span>;
                })()}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    {/* The same switch the Agents surface carries, so the hop is
                        visible from BOTH ends. The ⋯ menu's "Open in Agents" row
                        stays, but a return route nobody can see is exactly the
                        asymmetry that made the first version of this control a
                        dead end — the render probe could get here and not back. */}
                    {/* The return hop used to be this panel's own ChatModePill.
                        The title-bar switch carries it now — the Chat entry is
                        the same route, from the same place, for every surface. */}
                    {/* Segmented chat actions: new + history */}
                    <div className="flex items-center rounded-control border border-hairline bg-white/[0.02] p-0.5">
                        <button type="button" onClick={() => addSession('solo')} aria-label="New chat" title="New chat"
                            className="hit-target rounded-control p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => { setHistoryOpen(v => !v); setHistoryQuery(''); setHistorySel(0); setHistoryShowAll(false); }}
                            aria-label="Past conversations" aria-expanded={historyOpen} title="Past conversations"
                            className={`hit-target rounded-control p-1 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 ${historyOpen ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400'}`}>
                            <History className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="relative">
                        <button type="button" onClick={() => setShowNewMenu(v => !v)} aria-label="Customization" aria-expanded={showNewMenu} title="Customization"
                            className={`rounded-control p-1.5 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 ${showNewMenu ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-400'}`}>
                            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        {showNewMenu && (
                            <>
                                <div className="fixed inset-0 z-20" aria-hidden onClick={() => setShowNewMenu(false)} />
                                <div className="absolute right-0 top-9 z-30 max-h-96 w-56 overflow-y-auto rounded-bubble border border-hairline bg-zinc-900 p-1 shadow-xl" data-testid="chat-new-menu">
                                    {isPanel && (
                                        <button type="button" onClick={() => { setShowNewMenu(false); setPanelPickerFor(activeId); }}
                                            className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                            Panel models <span className="text-zinc-600">· {activeSession.panelModels?.length ?? 0}/{PANEL_MAX_MODELS}</span>
                                        </button>
                                    )}
                                    {/* The re-run that used to be the top-level ⟳
                                        button. Same behaviour, fresh context, one
                                        level deeper where it does not compete
                                        with getting to Chat. */}
                                    {(() => {
                                        const lastUser = [...entries].reverse()
                                            .find(x => x.role === 'user' && x.text && x.text !== '(chart screenshot)');
                                        return (
                                            <button type="button"
                                                onClick={() => { setShowNewMenu(false); if (lastUser) void send('', lastUser.id); }}
                                                disabled={!ready || busy || !lastUser}
                                                data-testid="dock-rerun"
                                                className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40">
                                                Re-run last question
                                            </button>
                                        );
                                    })()}
                                    {/* Gated on its handler like Collapse is: the
                                        Agents surface's pane passes none, and a row
                                        reading "Expand over chart" in a host with
                                        no chart is a promise plus a dead press. */}
                                    {onToggleExpanded && (
                                        <button type="button" onClick={() => { setShowNewMenu(false); onToggleExpanded(); }}
                                            className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                            {expanded ? 'Shrink back' : 'Expand over chart'}
                                        </button>
                                    )}
                                    {/* The jump OUT of the dock. Stage 3 moved it
                                        here from a dedicated header icon: it is a
                                        route, not a frequent toggle, and the
                                        header lost its last chrome row. */}
                                    {onOpenChat && (
                                        <button type="button" onClick={() => { setShowNewMenu(false); onOpenChat(); }}
                                            data-testid="dock-open-chat"
                                            className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                            Open in Agents
                                        </button>
                                    )}
                                    <div className="my-1 border-t border-hairline" />
                                    <p className="px-2 py-0.5 text-ui-2xs text-zinc-600">Start</p>
                                    <button type="button" onClick={() => addSession('panel')} className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                        New panel <span className="text-zinc-600">· up to {PANEL_MAX_MODELS} models</span>
                                    </button>
                                    <button type="button" onClick={() => { setShowNewMenu(false); setShowNewBot(true); }}
                                        data-testid="new-agent-option"
                                        className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                        New agent <span className="text-zinc-600">· create a roster bot</span>
                                    </button>
                                    {onNewGroup && (
                                        <button type="button" onClick={() => { setShowNewMenu(false); onNewGroup(); }}
                                            data-testid="new-group-option"
                                            className="block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                            New room <span className="text-zinc-600">· create a group</span>
                                        </button>
                                    )}
                                    {renderGroupSurface && groups.length > 0 && groups.slice(0, 6).map(g => (
                                        <button key={g.id} type="button"
                                            onClick={() => { setShowNewMenu(false); const existing = sessions.find(s => s.groupId === g.id); if (existing) { chatStore.setActiveId(existing.id); return; } chatStore.addSession({ kind: 'group', title: g.name, groupId: g.id }); }}
                                            className="block w-full truncate rounded-control px-2 py-1 text-left text-ui-dense text-zinc-400 hover:bg-white/[0.06]" title={g.name}>
                                            {g.name} <span className="text-zinc-600">· room</span>
                                        </button>
                                    ))}
                                    {bots.length > 0 && bots.slice(0, 6).map(b => (
                                        <button key={b.id} type="button" onClick={() => openBotSession(b.id)}
                                            className="block w-full truncate rounded-control px-2 py-1 text-left text-ui-dense text-zinc-400 hover:bg-white/[0.06]" title={b.name}>
                                            {b.name} <span className="text-zinc-600">· as bot</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                    {/* Collapse is a lg+ affordance: below lg the owner passes no
                        handler (the dock is the session's whole surface), and the
                        old unguarded ✕ was a dead control that also armed the
                        desktop rail when the window later grew (audit R6 #22). */}
                    {onToggleCollapsed && (
                        <button type="button" onClick={onToggleCollapsed} aria-label="Collapse Chart AI" title="Collapse"
                            className="rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>

            {/* Past Conversations palette — the reference's history command:
                search box, "Recent" rows with relative times, keyboard nav. */}
            {historyOpen && (
                <ChatHistoryPalette
                    rows={historyRows}
                    hidden={historyHidden}
                    sel={historySel}
                    query={historyQuery}
                    activeId={activeId}
                    canDelete={sessions.length > 1}
                    onQueryChange={v => { setHistoryQuery(v); setHistorySel(0); }}
                    onSelChange={setHistorySel}
                    onSelect={id => { chatStore.setActiveId(id); setHistoryOpen(false); }}
                    onDelete={id => removeSession(id)}
                    onShowAll={() => setHistoryShowAll(true)}
                    onClose={() => setHistoryOpen(false)}
                />
            )}

            {/* Panel seat editor (while a panel is still short of 2 seats). */}
            {panelPickerFor && (
                <div className="shrink-0 space-y-1.5 border-b border-hairline bg-zinc-900/70 px-3 py-2" data-testid="panel-picker">
                    <p className="text-ui-xs text-zinc-500">Panel seats ({sessions.find(s => s.id === panelPickerFor)?.panelModels?.length ?? 0}/{PANEL_MAX_MODELS}) — pick up to {PANEL_MAX_MODELS} models or agents; they answer together and talk to each other</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                        {(sessions.find(s => s.id === panelPickerFor)?.panelModels ?? []).map((m: PanelSeatRef) => (
                            <span key={panelSeatKey(m)} className="flex items-center gap-1 rounded-full border border-hairline bg-zinc-800 px-2 py-0.5 text-ui-xs text-zinc-200">
                                {m.botId ? (bots.find(b => b.id === m.botId)?.name ?? formatModelDisplayName(m.modelId)) : formatModelDisplayName(m.modelId)}
                                {m.botId && <span className="text-ui-2xs text-zinc-500">agent</span>}
                                <button type="button" aria-label={`Remove ${panelSeatKey(m)}`}
                                    onClick={() => setPanelModels(panelPickerFor, (sessions.find(s => s.id === panelPickerFor)?.panelModels ?? []).filter((x: PanelSeatRef) => panelSeatKey(x) !== panelSeatKey(m)))}
                                    className="text-zinc-500 hover:text-rose-400"><X className="h-3 w-3" aria-hidden="true" /></button>
                            </span>
                        ))}
                        {(sessions.find(s => s.id === panelPickerFor)?.panelModels?.length ?? 0) < PANEL_MAX_MODELS && (
                            <ModelPicker providers={providers} value="" mode="provider-model" onChange={addPanelSeat} compact
                                disabledValues={new Set((sessions.find(s => s.id === panelPickerFor)?.panelModels ?? []).map((m: PanelSeatRef) => `${m.providerId}::${m.modelId}`))}
                                onRefreshModels={onRefreshModels}
                                placeholder="+ add model" />
                        )}
                        {/* Roster agents seat beside models: same panel, but the
                            answer carries the agent's persona, its own model and
                            its own notebook. Hidden when there is no roster. */}
                        {bots.length > 0 && (sessions.find(s => s.id === panelPickerFor)?.panelModels?.length ?? 0) < PANEL_MAX_MODELS && (
                            <span className="flex flex-wrap items-center gap-1" data-testid="panel-agent-picks">
                                <span className="text-ui-2xs text-zinc-600">agents</span>
                                {bots
                                    .filter(b => !(sessions.find(s => s.id === panelPickerFor)?.panelModels ?? [])
                                        .some((m: PanelSeatRef) => m.botId === b.id))
                                    .map(b => (
                                        <button key={b.id} type="button" data-testid={`panel-agent-${b.id}`}
                                            onClick={() => addPanelAgentSeat(b.id)}
                                            className="rounded-full border border-hairline bg-zinc-800 px-2 py-0.5 text-ui-xs text-zinc-300 hover:bg-zinc-700">
                                            + {b.name}
                                        </button>
                                    ))}
                            </span>
                        )}
                        <button type="button" onClick={() => setPanelPickerFor(null)}
                            className="rounded-full bg-zinc-700 px-2.5 py-1 text-ui-xs font-semibold text-zinc-100 hover:bg-zinc-600">
                            Done
                        </button>
                    </div>
                </div>
            )}

            {/* Group room: the roster surface the dock embeds (App owns the
                wiring) instead of the chat transcript. The Coach inbox used to
                render here too, behind a Chat | Coach switch; it is the Learning
                surface's own tab now. */}
            {activeSession.kind === 'group' && (
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar" data-testid="chat-group-surface">
                    {renderGroupSurface?.(activeSession.groupId ?? '')}
                </div>
            )}
            {activeSession.kind !== 'group' && (
            <>
            {/* The prototype's bias read rides ABOVE the transcript: always
                current, code-calculated — the tape's state, not a chat turn. */}
            <BiasChips symbol={symbol} interval={interval as ChartInterval} />
            {/* The transcript's own box, so the jump control floats over the
                transcript's bottom-right corner and not over the composer. */}
            <div className="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onChatScroll} className="h-full space-y-6 overflow-y-auto overscroll-contain custom-scrollbar px-5 py-6"
                // The dock's transcript root is the one element a screen reader
                // needs to name for an answer to be heard at all: rows append and
                // old ones scroll away, which is exactly `role="log"`. Held busy
                // while any row streams so the token-by-token rewrite is not
                // announced dozens of times; it flips off when the answer settles
                // and the finished reply is read once. (O-65)
                role="log" aria-live="polite" aria-busy={entries.some(e => e.streaming)}
                aria-label="Chart AI conversation">
                {entries.length === 0 && !panelPickerFor && (
                    <div className="flex h-full flex-col items-center justify-center gap-5 px-4 text-center">
                        <p className="max-w-[16rem] text-ui-caption leading-6 text-zinc-500">
                            It can see this chart, the book and your drawings.
                        </p>
                        <div className="flex w-full max-w-[17rem] flex-col gap-1.5" data-testid="dock-quick-prompts">
                            {QUICK_PROMPTS.map(({ text, Icon }) => (
                                <button key={text} type="button" disabled={!ready} onClick={() => void send(text)}
                                    className="group inline-flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 disabled:opacity-40">
                                    <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-200" aria-hidden="true" />
                                    {text}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <ChatTranscriptList
                    entries={entries}
                    send={send}
                    setDraftText={setDraft}
                    getAnalysisMessage={getAnalysisMessage}
                    resolveVerdictByIdentity={!!activeSession.conversationId}
                    symbol={symbol}
                    getMark={getMarkForDist}
                    onChatLevels={handleCardLevels}
                    onToggleWatch={onToggleWatch}
                    pinnedMessageIds={pinnedMessageIds}
                    onLogProposedTrade={onLogProposedTrade}
                />
            </div>
            {/* The jump control: it appears when the trader has scrolled away
                from the newest row, and while a turn is running it shows the
                INDETERMINATE ring — the answer is arriving down there. */}
            <JumpToLatestFab
                visible={scrolledAway || entries.some(e => e.streaming)}
                running={entries.some(e => e.streaming)}
                onJump={jumpToLatest}
            />
            </div>

            {/* Composer — the reference's layout: a workspace-style section
                header (symbol · panel seats · bot · packet age), then one
                rounded-bubble card holding the input and its toolbar, then a plain
                sentence-case disclaimer. Generous padding, no hard divider. */}
            <ChatComposer
                symbol={symbol}
                interval={interval}
                isPanel={isPanel}
                ready={ready}
                busy={busy}
                draft={draft}
                setDraft={setDraft}
                send={send}
                runFullAnalysis={runFullAnalysis}
                onRunAnalysis={onRunAnalysis}
                onStopRun={onStopRun}
                effort={effort}
                changeEffort={changeEffort}
                modelIssue={modelIssue}
                provider={provider}
                selectedChatModel={selectedChatModel}
                changeSoloModel={changeSoloModel}
                providers={providers}
                onRefreshModels={onRefreshModels}
                attachments={attachments}
                removeAttachment={removeAttachment}
                fileInputRef={fileInputRef}
                attachFiles={attachFiles}
                showAttachMenu={showAttachMenu}
                setShowAttachMenu={setShowAttachMenu}
                captureChart={captureChart}
                onCaptureChart={onCaptureChart}
                composerRef={composerRef}
                panelCount={activeSession.panelModels?.length ?? 0}
                pickerOpen={panelPickerFor === activeId}
                onTogglePicker={() => setPanelPickerFor(panelPickerFor === activeId ? null : activeId)}
                botName={boundBot ? boundBot.name : null}
                contextAt={contextAt}
            />
            </>
            )}
            {/* New agent: the roster's create dialog, launched from this dock.
                Creating saves the bot and opens its bound session immediately. */}
            {showNewBot && (
                <NewBotDialog
                    open
                    onClose={() => setShowNewBot(false)}
                    providers={providers}
                    onCreate={draft => {
                        const bot: AgentBot = { ...draft, id: `bot-${Date.now()}`, createdAt: new Date().toISOString() };
                        saveBot(bot);
                        setShowNewBot(false);
                        // A brand-new bot has no history to adopt, but it goes
                        // through the same helper so there is exactly ONE way a
                        // bot session comes into existence.
                        openBotSession(bot.id);
                    }}
                />
            )}
        </div>
    );
};

export default React.memo(TradeChatPanel);
