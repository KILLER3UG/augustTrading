import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    Message, MessageRole, TradeOutcome, LoggedTrade, ImageMetadata,
    DebateTurn, Conversation, TradeAnalysis, TradeSummary,
    GlobalMemory, CustomInstructionsMap, CustomInstruction,
    PatternMemoryGateView,
} from '../types';

import { ProviderConfig } from '../types/provider';
import { readyProviderModels, isProviderReady } from '../utils/providerUtils';
import { analyzeTradingView, streamQuickResponse } from '../services/providers/GenericAnalysisService';
import type { ToolAction } from '../types/message';
import { WireAuditEntry, type ReasoningEffort } from '../services/providers/reasoningControls';
import { getActiveUsername } from '../utils/activeUser';
import { getBots, getGroups } from '../services/agents/agentRoster';

// Analysis / validation / backtesting services
import type { HybridDataPacket } from '../services/analysis/HybridIntelligenceService';
import { extractSymbolFromPrompt } from '../services/analysis/MarketDataService';
import { LabeledMonteCarloResult } from '../services/analysis/MonteCarloService';
import { type LiveBacktestResult } from '../services/backtesting/LiveBacktestService';

// Utils
import { TokenUsage, estimateCostUsd } from '../utils/tokenUsage';
import { offlineQueue } from '../services/infrastructure/OfflineQueueService';
import { splitThinkingFromOutput } from '../utils/thinkingSplit';
import { chatModelIdOf, resolveChatModelSelection } from '../utils/providerUtils';
import { buildDecisionReflectionContext } from '../services/learning/DecisionReflectionService';
import { getEnabledStrategiesText } from '../services/infrastructure/StrategyService';
import { useStreamThrottlers } from './analysisPipeline/streamThrottlers';
import { isNotebookQuickSaveRequest, runNotebookQuickSave } from './analysisPipeline/notebookQuickSave';
import { classifyRunFailure, mapRunFailureMessages, resolveQuotaFlaggedModel, sanitizeFallbackErrorMessage } from './analysisPipeline/runOutcome';
import {
    beginConversationRun,
    endConversationRunOwned,
    abortConversationRun,
} from '../services/trade/chatStore';
import type { ToolTurnOutcome } from '../services/trade/toolTurn';

// ─── Dev-only logging ─────────────────────────────────────────────────────
// console.log calls are gated behind the Vite dev flag so production builds
// stay clean. console.error / console.warn are kept unconditionally (genuine
// faults must always surface).
const devLog = (...args: unknown[]) => { if ((import.meta as any).env?.DEV) console.log(...args); };

// Ensemble openings launch each seat this many ms apart. Free-tier gateways
// dedupe/cache CONCURRENT near-identical requests (the three openings share
// ~99% of their payload once the hybrid envelope is in); staggering breaks
// the simultaneous-identical window those caches key on.
/** How stale a prior run's packet may be and still be reused instead of
 *  re-fetched. `dataTimestamp` is when the assembly ran, so this is a FLOOR on
 *  the real age — every cell inside it additionally carries up to its own REST
 *  cache window. Reusing a minutes-old packet was the worst link in the chain:
 *  a follow-up run got the previous tape labelled "real-time". */
const HYBRID_REUSE_MAX_AGE_MS = 60_000;

/** How long one 429 backs the desk off, for every conversation. Named because the
 *  cooldown is a promise the trader can see (a send that does nothing), and the
 *  timer that keeps it is the thing that used to never run — see
 *  `rateLimitEpochRef`. Scope is deliberately global today, not per provider;
 *  narrowing it is an owner call (the 2026-10-27 status ledger decision 8). */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// Learning services
import { generateWeightedVotingContext } from '../services/backtesting/ModelPerformanceService';
import { threadForProvider } from '../utils/agentThreads';
import { formatInvokedSkillSection, resolveInvokedSkills } from '../services/learning/SkillFileService';
import { extractDebateTemplate, DebateTemplate } from '../utils/debateTemplates';
import { parseComposerIntent, formatComposerSteer } from '../utils/composerMentions';
import { beginPromptLane, promptCorpusVersion } from '../services/infrastructure/PromptOverrideService';
import { parseDmMarkers } from '../services/agents/botMailbox';
import { notify } from '../services/infrastructure/notify';

// ─── Run Outcome ──────────────────────────────────────────────────────────────

/**
 * What `handleSendMessage` resolves with once the run ENDS. The offline
 * queue's replay callback is the consumer that makes this load-bearing:
 * `processQueue` awaits the callback before dequeuing, and an analysis that
 * fails INTERNALLY lands in the catch and lands an error bubble instead of
 * throwing — without an outcome flag the replayed item was consumed by a
 * failed run (audit 2026-09-15 §2.3 residual). App maps `ok:false` to a
 * throw so the queue's existing retryCount/MAX_RETRIES backoff applies.
 *
 * `ok:false` means "this attempt did not produce a completed analysis and
 * the work is worth retrying": the generic provider/pipeline error (error
 * bubble), the 429 rate-limit branch, the quota branch, and the pre-run
 * team/config blocks (no providers ready, missing moderator, incomplete
 * roster — retried with backoff, dropped after MAX_RETRIES, since the queue
 * item would otherwise vanish silently, which is the very bug).
 * `ok:true` covers a completed run, a user CANCEL (deliberate stop — a
 * retry would fight the user), a superseded/replaced run, a send parked
 * into the steering queue, a notebook quick-save short-circuit, and the
 * offline branch that re-queued the analysis as a FRESH item.
 */
export interface ChatRunOutcome {
    ok: boolean;
}

// ─── Per-conversation run ownership (E-45) ───────────────────────────────────

/** The key a run with no conversation id at all is filed under. */
const NO_CONVERSATION_KEY = '__no_conversation__';

/** The registry key for a conversation. `null` and `undefined` are the same
 *  "no conversation" bucket, so a run cannot be filed under two keys. */
const runKeyFor = (conversationId: string | null | undefined): string =>
    conversationId || NO_CONVERSATION_KEY;

/**
 * One conversation's live run.
 *
 * `controller` — the abort handle, so a Stop reaches THIS run and not
 * another. `owner` — the trader who started it; a run never writes across a
 * profile change. `loadingMessage` / `steeringQueue` / `inFlight` — the facts
 * the UI shows, kept per conversation so a switch shows the other thread's
 * state instead of clearing it.
 */
interface ConversationRun {
    controller: AbortController;
    /** The conversation this run belongs to — null for a scheduled run, which
     *  writes into a private message list and owns no thread. */
    conversationId: string | null;
    /** The trader this run belongs to. A run started by another trader is
     *  never allowed to land in the current trader's data. */
    owner: string;
    loadingMessage: string | null;
    inFlight: boolean;
}

// ─── Params Interface ──────────────────────────────────────────────────────────

export interface UseAnalysisPipelineParams {
    // From conversations:
    messages: Message[];
    messagesRef: React.MutableRefObject<Message[]>;
    updateMessages: (updater: (prev: Message[]) => Message[], conversationId?: string | null) => void;
    activeConversation: Conversation | undefined;
    activeConversationId: string | null;

    // All model/provider values:
    providerConfigs: ProviderConfig[];
    selectedOcrModel: string;
    moderatorConfig: ProviderConfig;
    moderatorModel: string;
    /** Settings → Memory model — notebook notes, pattern-memory rewrite, reviews. */
    memoryConfig?: ProviderConfig | null;

    // From memory/trade:
    finalTradeSummary: string | null;
    loggedTrades: LoggedTrade[];
    tradeSummaries: TradeSummary[];
    globalMemory: GlobalMemory | undefined;

    // From market data:
    currentHybridData: HybridDataPacket | null;
    setCurrentHybridData: (v: HybridDataPacket | null) => void;
    setLatestMonteCarloResult: (v: any) => void;
    setLatestBacktestResult: (v: any) => void;
    setPerAIMonteCarloResults: React.Dispatch<React.SetStateAction<LabeledMonteCarloResult[]>>;
    setCurrentSlOptimization: (v: any) => void;
    setCurrentSuggestedEntryPrice: (v: number | null) => void;
    setCurrentEntryTimingScore: (v: any) => void;
    setHybridConnectionStatus: React.Dispatch<React.SetStateAction<'disconnected' | 'connecting' | 'connected' | 'error'>>;

    // From UI state:
    isAnalysisInProgress: boolean;
    setIsAnalysisInProgress: (v: boolean) => void;
    isHybridLoading: boolean;
    setIsHybridLoading: (v: boolean) => void;
    isRateLimited: boolean;
    setIsRateLimited: (v: boolean) => void;

    // Settings:
    isGlobalMemoryEnabled: boolean;
    /** Master switch for user-uploaded strategy books (Settings → Strategies). */
    isStrategiesEnabled: boolean;
    customInstructions: CustomInstructionsMap;
    isHybridIntelligenceEnabled: boolean;
    activeFrameworks: string[];
    // Casual-chat model; falls back to the first ready provider's model when
    // empty/stale.
    selectedChatModel: string;
    /** ── Bot Mode ──
     *  When a bot's 1:1 thread is open, casual sends run AS that bot:
     *  persona system prompt, thread-scoped history, and the reply is
     *  handed to onBotReply so the mailbox can dispatch [[dm:@…]] markers.
     *  A GETTER (not a value) because App declares the roster below this
     *  hook — read at send time, stable identity. Null outside bot threads
     *  (Team/casual model chat keep old behavior). */
    getActiveBot?: () => {
        id: string;
        name: string;
        providerId: string;
        modelId: string;
        systemPrompt: string;
    } | null;
    /** Fired after a bot-thread casual reply settles (messageId + raw text
     *  INCLUDING any DM markers — the mailbox strips + delivers them). */
    onBotReply?: (messageId: string, rawText: string) => void;

    // Toast:
    toast: {
        warning: (t: string, m?: string) => void;
        error: (t: string, m?: string) => void;
        success?: (t: string, m?: string) => void;
    };
    /** Non-blocking styled confirmation dialog (replaces native window.confirm). */
    confirmDialog?: (opts: {
        title: string;
        message?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        destructive?: boolean;
        undoGraceMs?: number;
        onUndo?: () => void | Promise<void>;
    }) => Promise<boolean>;
}

// Best-effort pattern-family detection from the user prompt, so the
// unified learning context can match insights/mistakes to the current setup
// before the AI analysis completes (there is no analysis yet at send time).
// Falls back to undefined when no keyword matches.



const MAX_INITIAL_ANALYSIS_RETRIES = 1;

/**
 * Wraps analyzeTradingView with one bounded retry for transient failures
 * (429/5xx/network blip). The debate rounds already retry via
 * streamWithTransientRetry, but the initial analyst streams ran bare — a
 * single rate-limit blip silently dropped an analyst before the debate
 * started (two rate-limited analysts killed the whole run). A retry re-runs
 * the full call (a partial stream is discarded, never resumed), so a
 * genuinely failing provider still surfaces its error.
 */
/** Stable per-seat temperature (0.55–0.85) so Normal-mode ensemble seats that
 *  share one prompt sample differently. Deterministic per key — not random —
 *  so a seat keeps the same temperature across re-runs/replacements. */

async function analyzeTradingViewWithTransientRetry(
    config: ProviderConfig,
    params: Parameters<typeof analyzeTradingView>[1],
): Promise<Awaited<ReturnType<typeof analyzeTradingView>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_INITIAL_ANALYSIS_RETRIES; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
        try {
            if (params.signal?.aborted) {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                throw err;
            }
            return await analyzeTradingView(config, params);
        } catch (e: any) {
            const isAbort = e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.name === 'TimeoutError';
            const transient = !isAbort && (
                e?.status === 429 || e?.status === 502 || e?.status === 503 || e?.status === 504 ||
                /network|econnrefused|failed to fetch|fetch failed|socket hang up/i.test(e?.message || '')
            );
            lastError = e;
            if (!transient) throw e;
            console.warn(`[Analysis] Transient failure (${e?.status ?? e?.message ?? e}); retrying once.`);
        }
    }
    throw lastError;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useAnalysisPipeline(params: UseAnalysisPipelineParams) {
    const {
        messages, messagesRef, updateMessages, activeConversation, activeConversationId,
        providerConfigs,
        selectedOcrModel,
        moderatorConfig, moderatorModel,
        memoryConfig,
        finalTradeSummary, loggedTrades, tradeSummaries,
        globalMemory,
        currentHybridData, setCurrentHybridData,
        setHybridConnectionStatus,
        isAnalysisInProgress, setIsAnalysisInProgress,
        isHybridLoading, setIsHybridLoading,
        isRateLimited, setIsRateLimited,
        isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,
        isHybridIntelligenceEnabled, activeFrameworks,
        selectedChatModel,
        getActiveBot,
        onBotReply,
        toast,
        confirmDialog,
    } = params;

    // Every analysis request goes to the configured provider. Keeping this
    // wrapper preserves one typed call shape for the ensemble, solo, and
    // replacement paths without replaying a locally cached AI response.
    interface AnalysisRequestParams {
        imageSummaries: string[];
        chatHistory: Message[];
        finalTradeSummary: string | null;
        recentInsights: string | null;
        activeFrameworks: string[];
        deepenAnalysis: boolean;
        globalMemory: GlobalMemory | undefined;
        threadSummary: string | undefined;
        customInstructions: string;
        systemPromptOverride: string | undefined;
        /** Per-seat independence directive — rendered into the system prompt head. */
        seatDirective?: string;
        /** Role-scoped desk tools for this seat (undefined = full toolset). */
        allowedTools?: string[];
        /** Per-seat sampling temperature (ensemble Normal mode). */
        temperature?: number;
        /** Summaries of user-uploaded strategy books (Settings → Strategies). */
        userStrategies: string | undefined;
        onReasoning: (reasoning: string) => void;
        /** Visible content deltas — surfaces the answer forming live. */
        onPartialOutput: (chunk: string) => void;
        /** Wire-audit sink (P5) — applied reasoning-route label per call. */
        onWireAudit?: (entry: WireAuditEntry) => void;
        /** model side-effects from this seat's desk tools. */
        onToolAction?: (action: ToolAction) => void;
    }

    
    // ─── State ─────────────────────────────────────────────────────────────
    const [input, setInput] = useState('');
        const [images, setImages] = useState<ImageMetadata[]>([]);
    const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
    /** Journal mirror for zero-dep callbacks (desk-tool recall on solo runs). */
    const loggedTradesRef = useRef<LoggedTrade[]>(loggedTrades);
    useEffect(() => { loggedTradesRef.current = loggedTrades; }, [loggedTrades]);
    /**
     * The 429 backoff is owned by the FLAG, not by the run that tripped it.
     *
     * It used to be guarded on `runsRef.get(key)?.controller === theRunThatFailed`,
     * written to stop "a stale timer from a previous run clearing the flag on a
     * newer run". That guard can never pass: the `finally` deletes the run
     * registration before a 60-second timer fires, and a run that did take the key
     * has a different controller — so the reset never ran, and because the early
     * guard at the top of the send returns on `isRateLimited` BEFORE the
     * `setIsRateLimited(false)` further down, one 429 blocked every conversation in
     * the app until reload (the 2026-10-27 audit L-1). A monotonic epoch gives the
     * protection the comment actually wanted: a newer 429 bumps it, so an older
     * timer cannot clear a cooldown it did not arm.
     */
    const rateLimitEpochRef = useRef(0);
    /**
     * Parked sends, per CONVERSATION.
     *
     * The queue belongs to the THREAD, not to the run: a correction parked
     * while a run is live must still be there after that run ends (the drain
     * reads it), so it cannot live in the run's record. One map, keyed the
     * same way the runs are — a parked word drains into the thread it was
     * typed in, never into whichever thread happens to be on screen.
     */
    const steeringRef = useRef<Map<string, string[]>>(new Map());
    const [steeringNotes, setSteeringNotes] = useState<string[]>([]);
    /** Per-seat steering: seat name → one queued note, drained per turn. */
    const seatSteeringRef = useRef<Record<string, string>>({});
    /** Per-seat stop: seats benched by the user for the rest of this run. */
    const stoppedSeatsRef = useRef<Set<string>>(new Set());
    // Mid-debate analyst replacement: the generator suspends and waits on a
    // promise whose resolver lives here; the UI calls handleReplacementChoice
    // (via ChatContext) to settle it with the picked provider id (or null to
    // continue without). Nulled on choice, run end, and cancel so a late click
    // can never resolve a stale wait.
    const replacementChoiceRef = useRef<{ messageId: string; resolve: (providerId: string | null) => void } | null>(null);
    const handleReplacementChoice = useCallback((messageId: string, providerId: string | null): void => {
        const pending = replacementChoiceRef.current;
        if (!pending || pending.messageId !== messageId) return;
        replacementChoiceRef.current = null;
        pending.resolve(providerId);
    }, []);
    const [currentVisionData, setCurrentVisionData] = useState<string[]>([]);
    const [isDeepAnalysis, setIsDeepAnalysis] = useState<boolean>(false);

    // ─── Refs ──────────────────────────────────────────────────────────────
    /**
     * One live run, per CONVERSATION.
     *
     * This used to be ONE `analysisAbortController` ref for the whole app, and
     * an effect on `activeConversationId` that aborted it on any conversation
     * change. That made the Agents surface's run the opposite of the dock's: the
     * dock's session state is hoisted into `services/trade/chatStore.ts` and its
     * controller is per-session, so an answer survives a surface switch, while
     * the Agents surface's run died the moment you looked at another thread.
     *
     * The machinery to survive a switch was already here — every async write
     * goes through `updateRequestMessages`, which binds the write to the
     * conversation the request started in — so the run was DESIGNED to land its
     * answer in the thread it was typed in, and the effect killed it before
     * that could ever happen. The registry makes the ownership explicit: a run
     * belongs to a conversation, and a conversation switch moves the VIEW.
     */
    const runsRef = useRef<Map<string, ConversationRun>>(new Map());
    /** The conversation on screen, as a ref — the async paths need to know
     *  which conversation is active long after the closure that started them
     *  went stale. Written during render on purpose (the `composerModeRef`
     *  precedent in AGENTS.md): it is committed state, not a prop that a
     *  concurrent render could tear. */
    const activeConversationIdRef = useRef<string | null>(activeConversationId);
    activeConversationIdRef.current = activeConversationId;
    /** Latest handleSendMessage closure, for the queued-send drain effect at
     *  the bottom of this hook — the drain fires after commit, so it must
     *  call through the freshest closure, not the one that started the run.
     *  Assigned after handleSendMessage below. */
    const drainSendRef = useRef<((text?: string) => Promise<ChatRunOutcome>) | null>(null);
    // ─── RAF-throttled casual-chat stream update ──────────────────────────
    // The four debate writers this call used to hand back died with the
    // ensemble engine; see hooks/analysisPipeline/streamThrottlers.ts.
    const {
                                throttledCasualStream,
            } = useStreamThrottlers({ updateMessages });

    /**
     * Write a run fact into the run's OWN conversation, and mirror it into the
     * shared React state ONLY when that conversation is the one on screen.
     *
     * This is the whole of "per-conversation" in one shape: the map is the
     * truth, the React state is the ACTIVE VIEW of it. A background
     * conversation's loading line and steering queue change without touching
     * what the trader is looking at; when they switch to it, the effect below
     * paints its state.
     */
    const setLoadingFor = useCallback((conversationId: string | null, msg: string | null): void => {
        const key = runKeyFor(conversationId);
        const run = runsRef.current.get(key);
        if (run) run.loadingMessage = msg;
        if (key === runKeyFor(activeConversationIdRef.current)) setLoadingMessage(msg);
    }, []);

    const setSteeringFor = useCallback((conversationId: string | null, queue: string[]): void => {
        const key = runKeyFor(conversationId);
        steeringRef.current.set(key, queue);
        if (key === runKeyFor(activeConversationIdRef.current)) setSteeringNotes(queue);
    }, []);

    /** The parked sends of one conversation, or an empty list. */
    const steeringFor = useCallback((conversationId: string | null): string[] =>
        steeringRef.current.get(runKeyFor(conversationId)) ?? [], []);

    /**
     * The app-level "is a run happening" flag, which the surfaces read for
     * their Stop button and the scheduler reads for its busy guard.
     *
     * It means "THE CONVERSATION ON SCREEN is running". It must NOT mean
     * "some background conversation is running": a run in a thread you are not
     * looking at would otherwise turn this thread's send button into a Stop
     * button for a chat you cannot even see.
     */
    const syncProgressFlag = useCallback((): void => {
        const activeKey = runKeyFor(activeConversationIdRef.current);
        const activeRun = runsRef.current.get(activeKey);
        setIsAnalysisInProgress(Boolean(activeRun?.inFlight));
    }, []);

    /**
     * A conversation switch moves the VIEW. It does not kill the run.
     *
     * The old effect aborted the run here, and cleared the loading message,
     * the step tracker, the in-progress flag and the steering queue. That was
     * the defect E-45 names: the run was built to land its answer in the
     * conversation it was typed in (`updateRequestMessages` binds every async
     * write to `requestConversationId`), and this effect killed it before that
     * machinery could be used.
     *
     * What the switch does now is show THAT conversation's state: a thread
     * that is still thinking says so, a thread that has parked a correction
     * shows the parked correction, and a thread with nothing running says
     * nothing at all.
     */
    useEffect(() => {
        const key = runKeyFor(activeConversationId);
        const run = runsRef.current.get(key);
        setLoadingMessage(run?.loadingMessage ?? null);
        setSteeringNotes(steeringRef.current.get(key) ?? []);
        setIsAnalysisInProgress(Boolean(run?.inFlight));
    }, [activeConversationId]);

    /**
     * Abort ONE run, by its registry key, and release everything it owns.
     *
     * The single place a run dies, so the release cannot be half-done: the
     * controller is aborted, the record is dropped, the store's copy is
     * released (owner-checked — a newer run in the same conversation must not
     * lose its slot), and the app-level flag is re-synced.
     */
    const cancelRunAt = (key: string): void => {
        const run = runsRef.current.get(key);
        if (!run) {
            // The key IS the conversation id, so a run the OTHER home started in
            // this thread is still stoppable from here: the Chart AI dock
            // registers its controller under the conversation as well as its
            // session, and a Stop that found no pipeline run used to do nothing
            // while the answer kept arriving in front of the trader.
            if (key && key !== NO_CONVERSATION_KEY) abortConversationRun(key);
            return;
        }
        run.controller.abort();
        run.inFlight = false;
        run.loadingMessage = null;
        runsRef.current.delete(key);
        if (run.conversationId) abortConversationRun(run.conversationId);
        setLoadingFor(run.conversationId, null);
        syncProgressFlag();
    };

    // ─── Helper: active custom instructions ────────────────────────────────
    const getActiveCustomInstructions = () => {
        const instructionsList = customInstructions.general;

        return instructionsList
            .filter(inst => inst.isActive)
            .map(inst => `[${inst.title}]\n${inst.content}`)
            .join('\n\n');
    };

    // ─── Helper: persist thinking records (best-effort, non-blocking) ──────
    // A failed reasoning write must never fail the analysis run itself.
    
    // ─── Main Analysis Handler ─────────────────────────────────────────────
    const handleSendMessage = useCallback(async (customPrompt?: string, customImages?: ImageMetadata[], hiddenContext?: string, options?: {
        isUpdate?: boolean;
        updateInterval?: string;
        /** Version-stamped amendments (Batch 7): the plan this update revises. */
        priorAnalysis?: TradeAnalysis;
        priorMessageId?: string;
        presetHybridData?: HybridDataPacket | null;
        /** Continue an interrupted debate from persisted turns. */
        resumeMessageId?: string;
        /** Same-thread ticket follow-up: reuse OCR, skip leftover composer charts. */
        followUpFromMessageId?: string;
        /** The instrument the SURFACE is currently showing, used only when the
         *  prompt names no coin. Naming a coin in the text still wins — the
         *  picker says where you are looking, it does not override what you
         *  just asked about. */
        symbol?: string;
        interval?: string;
        /** The composer's thinking tier for a casual (non-debate) turn, read
         *  off the active chat session by the surface that sent. `'auto'` and
         *  an omitted value both mean the task default, so every caller that
         *  never shows a dial keeps exactly the request it was making before.
         *  The debate ignores it: each seat's effort comes from the role
         *  schedule (`EFFORT_BY_TASK`), not from a composer. */
        reasoningEffort?: ReasoningEffort;
        /** Stage 20f: the trader pressed FULL ANALYSIS. With the ensemble toggle
         *  off this is what turns the desk arm's casual turn into a turn that is
         *  TOLD to look things up and CHECKED for having done so — the surviving
         *  half of the old keyword trigger, with the keyword gone (20c). */
        fullAnalysis?: boolean;
    }): Promise<ChatRunOutcome> => {
        // ── Composer + hybrid snapshots ──────────────────────────────────
        // These three used to be dependencies of this callback, which is the
        // wrong shape twice over: `input` and `images` change on every
        // keystroke and attachment, and `currentHybridData` changes on every
        // hybrid stream frame, so the function identity churned continuously
        // and took every downstream memo and effect down with it.
        //
        // Snapshotted HERE, at the top of the send, rather than read through a
        // ref (the `composerModeRef` precedent). A ref would be correct for the
        // composer — it is read before any await — and WRONG for
        // `currentHybridData`, which is read at the hybrid-reuse decision and
        // again in the pipeline call, both of which sit AFTER the
        // `runNotebookQuickSave` await. A ref there would swap the packet
        // captured when the trader pressed send for whatever the stream had
        // produced by then, quietly changing which market data reaches the
        // models. A local captures at exactly the moment the old closure did,
        // so this is behaviour-identical and the dep array gets smaller.
        const composerInput = input;
        const composerImages = images;
        const hybridAtSend = currentHybridData;

        const isSummarizing = composerImages.some(img => img.isLoading);

        // The guard is per CONVERSATION: a run in another thread must not
        // block a send here, and a run here must not be visible as a Stop
        // button in a thread the trader is not looking at.
        const activeRunKey = runKeyFor(activeConversationId);
        const activeRunInFlight = runsRef.current.get(activeRunKey)?.inFlight === true;
        if (isAnalysisInProgress || activeRunInFlight) {
            // Drafting stays enabled during a run, but a send attempt while a
            // debate is live must not silently eat the message (the composer
            // only disables during loadingMessage, which is null mid-debate).
            // The words park in steeringQueueRef and render as faded queued
            // bubbles above the composer — no toast, the bubbles ARE the
            // receipt. At the next debate step they steer in-run; anything
            // still parked when the run ends drains as one follow-up turn
            // (see the drain effect).
            const draft = typeof customPrompt === 'string' ? customPrompt : composerInput;
            if (draft.trim()) {
                const intent = parseComposerIntent(draft.trim());
                // Parked into THIS conversation's queue. A correction typed
                // in one thread must drain into that thread, so the queue is
                // keyed the same way the runs are.
                setSteeringFor(activeConversationId, [
                    ...steeringFor(activeConversationId),
                    formatComposerSteer(intent) || draft.trim(),
                ]);
                setInput('');
            }
            // Parked into the steering queue (it WILL run against the live
            // debate or as the end-of-run drain) — consumed, not failed.
            return { ok: true };
        }

        // --- ROUTING LOGIC: which model answers this send ---
        // Ensemble participants are model-level entries, not just provider
        // entries. This allows several models from one provider while keeping
        // each result and reasoning trace separate.
        // The provider pool: one entry per ready provider's selected model.
        // Nothing fans out to multiple seats any more; this list answers the
        // provider-level questions (is anything ready, which config pays for
        // the notebook save, whose ids feed the learning block, which model a
        // quota error names).
        const enabledProviders = readyProviderModels(providerConfigs);

        // Group-member personas (the Team/group merge): resolve the personas
        // of bots that are members of ANY group, keyed provider+model, so
        // each member's role/custom instructions ride its prompts. Members
        // are matched by provider+model identity (the same identity the
        // composer's Talk-to selector writes); a bot that moved on gets the
        // general-analyst default rather than a stale persona. Read at fire
        // time — persona edits apply to the next send.
                // Legacy mandate rotation (ad-hoc ensembles, no active team). Hoisted
        // so the mid-debate replacement path can mirror the initial seats.
        
        // The staged analyst cards this flag used to gate are gone with the
        // ensemble engine: nothing renders `ensembleProgress`, and the placeholder
        // row it minted had no settle path.

        let effectiveInput = '';
        if (typeof customPrompt === 'string') {
            effectiveInput = customPrompt;
        } else if (typeof composerInput === 'string') {
            effectiveInput = composerInput;
        }
        // Debate template marker ([[Scalp check]] etc.) — extract before the
        // composer-intent parse so the marker never reaches the models.
                // /slug skill invocations, captured before the steer-rewrite folds
        // the message into prose — resolved into actual skill content below
        // (a name alone teaches the seats nothing).
                {
            const extracted = extractDebateTemplate(effectiveInput);
            if (extracted.template) {
                effectiveInput = extracted.cleanText;
            }
        }
        if (effectiveInput.trim()) {
            const intent = parseComposerIntent(effectiveInput);
            const steered = formatComposerSteer(intent);
            if (steered) effectiveInput = steered;
        }

        // Determine images source (state or override)
        const followSource = options?.followUpFromMessageId
            ? (messagesRef.current.find(m => m.id === options.followUpFromMessageId)
                || messages.find(m => m.id === options.followUpFromMessageId))
            : undefined;
        const imagesToUse = followSource ? [] : (customImages || composerImages);

        // Nothing ran: a live loading/summarize state, a rate-limit flag, or
        // an empty payload. A replay hitting this must stay queued (the
        // transient block will clear; an empty item dies at MAX_RETRIES) —
        // ok:false so App's callback throws and the backoff path applies.
        if (loadingMessage || isSummarizing || (!effectiveInput.trim() && imagesToUse.length === 0) || isRateLimited) return { ok: false };

        // Setup problems no longer toast — they render as a normal chat
        // exchange (the user's message + an explanation bubble) so the reason
        // a run cannot start stays visible in the conversation history.
        const appendBlockedRunNotice = (reason: string): void => {
            updateMessages(prev => [...prev, {
                id: `user-${Date.now()}`,
                role: MessageRole.USER,
                text: effectiveInput,
                createdAt: new Date().toISOString(),
                images: imagesToUse.map(meta => meta.dataURL),
                imageSummaries: imagesToUse.map(meta => meta.summary).filter(Boolean) as string[],
            }, {
                id: `blocked-${Date.now()}`,
                role: MessageRole.AI,
                text: reason,
                createdAt: new Date().toISOString(),
            }], activeConversationId);
        };

        // P0 fix: Surface a clear error when no AI providers are enabled.
        // Previously this returned silently, leaving the user with no feedback.
        if (enabledProviders.length === 0) {
            appendBlockedRunNotice(
                'No AI models are ready yet. Add an API key and enable at least one provider in Settings → AI Models, then send this again.'
            );
            // Config block, not a completed run — ok:false keeps a replayed
            // item on the queue's backoff path (dropped at MAX_RETRIES).
            return { ok: false };
        }

        // ─── TRADER NOTEBOOK QUICK-SAVE ────────────────────────────────
        // "Save this to the notebook" short-circuits the ensemble: no chart
        // analysis, just the notebook write + a confirmation message. The
        // model reads the current notebook index and decides skip / append /
        // create (see writeNotebookNoteFromRequest).
        if (isNotebookQuickSaveRequest(effectiveInput)) {
            await runNotebookQuickSave(effectiveInput, {
                provider: memoryConfig || enabledProviders[0]?.config,
                setLoadingMessage,
                messagesRef,
                updateMessages,
                activeConversationId,
            });
            // The notebook quick-save completed (or reported its own failure
            // in-chat) — this was never an analysis run; consume it.
            return { ok: true };
        }
        // The seat-completeness refusals are gone with the debate. Only ONE
        // model answers a send (`provider`, below), so "your analyst team is
        // incomplete", "analysts must use different models" and "two debate
        // seats share a model" all blocked a run over a roster the run never
        // uses — identical prompts through identical models cannot happen here,
        // because there is only one prompt and one model. The TEAM_MAX_SEATS
        // ceiling went for the same reason: it existed to stop N× fan-out, and
        // nothing fans out since the engine was deleted.

        // Live-backtest summary (block-scoped result is captured here so the
        // final message update below can persist it on runStats).
        setIsRateLimited(false);
        // The run belongs to the conversation it was typed in. Aborting the
        // PREVIOUS run of THIS conversation is correct (a second send in the
        // same thread supersedes the first); aborting ANOTHER conversation's
        // run is exactly the defect E-45 removes.
        const requestConversationId = activeConversationId;
        const requestRunKey = runKeyFor(activeConversationId);
        const previousRun = runsRef.current.get(requestRunKey);
        previousRun?.controller.abort();
        const currentAbortController = new AbortController();
        const runOwner = getActiveUsername();
        runsRef.current.set(requestRunKey, {
            controller: currentAbortController,
            conversationId: requestConversationId,
            owner: runOwner,
            loadingMessage: null,
            inFlight: true,
        });
        beginConversationRun(requestConversationId ?? '', currentAbortController);
        setSteeringFor(requestConversationId, []);
        seatSteeringRef.current = {};
        stoppedSeatsRef.current = new Set();
        // Bind every async message write to the conversation that started the
        // request. This remains correct even if the user switches conversations
        // before a provider response or stream chunk arrives.
        const updateRequestMessages = (updater: (prevMessages: Message[]) => Message[]): void => {
            // A run never writes across a profile change. The profile switch
            // (hooks/useUserProfileLoader.ts) cancels BEFORE the username
            // flips, so its cancel cannot see that the trader changed; THIS is
            // the guard that actually holds — by the time a run writes, the new
            // profile is the active one, and the previous trader's answer must
            // not land in it.
            if (runOwner !== getActiveUsername()) {
                currentAbortController.abort();
                return;
            }
            updateMessages(updater, requestConversationId);
        };
        const isCurrentRequest = (): boolean =>
            runsRef.current.get(requestRunKey)?.controller === currentAbortController
            && !currentAbortController.signal.aborted;

        // Throw when the request goes stale (user cancel or conversation
        // switch). Plain early-returns/breaks bypassed the catch block's
        // message cleanup, leaving a streaming bubble stuck in its "thinking"
        // state — and with the abort controller already nulled by
        // the finally, the Stop button couldn't even abort it again.
        const assertCurrentRequest = (): void => {
            if (!isCurrentRequest()) {
                const abortError = new Error('Analysis aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }
        };

        if (imagesToUse.length > 0) {
            const visionData = imagesToUse.map(img => img.fullAnalysisText || `Chart ${imagesToUse.indexOf(img) + 1}: No analysis text available.`);
            setCurrentVisionData(visionData);
        }

        const dataURLs = imagesToUse.map(meta => meta.dataURL);
        // UI displays the user input, but API may receive enhanced context
        const originalPrompt = effectiveInput;
        const promptToSend = hiddenContext ? `${hiddenContext}\n\nUser Input: "${effectiveInput}"` : effectiveInput;

        const ocrModelsUsed = [...new Set(imagesToUse.map(meta => meta.ocrModelUsed).filter(Boolean) as string[])];

        const resumeTarget = options?.resumeMessageId
            ? (messagesRef.current.find(m => m.id === options.resumeMessageId) || messages.find(m => m.id === options.resumeMessageId))
            : undefined;
        const canResume = Boolean(resumeTarget && !resumeTarget.analysis && (resumeTarget.debateTurns?.length || 0) > 0);

        // A send that names no coin is not blocked — it gets a nudge to include
        // one. A surface that ALREADY has an instrument selected is not a bare
        // greeting, so it must not be nagged about one it is effectively
        // supplying.
        if (imagesToUse.length === 0 && !canResume
            && !extractSymbolFromPrompt(effectiveInput) && !options?.symbol) {
            toast.warning('Tip: include a coin', 'For a full analysis add a symbol like BTC, SOL or ETH — e.g. “analyze BTC”.');
        }

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: MessageRole.USER,
            text: originalPrompt,
            createdAt: new Date().toISOString(),
            images: dataURLs,
            imageSummaries: imagesToUse.map(meta => meta.summary).filter(Boolean) as string[],
            ocrModelUsed: ocrModelsUsed.join(','),
            ocrCache: (() => {
                const texts = [
                    ...imagesToUse.map(meta => meta.fullAnalysisText).filter((t): t is string => Boolean(t)),
                    ...(resumeTarget?.ocrCache?.texts ?? []),
                    ...(followSource?.ocrCache?.texts ?? []),
                ];
                const unique = [...new Set(texts)];
                return unique.length > 0 ? { texts: unique } : undefined;
            })(),
        };

        // The staged-ensemble PLACEHOLDER is gone. The tool turn writes its own
        // canonical row (`streamingMessageId`, below), so this row was a second
        // one appended beside the answer — and after the debate engine was
        // deleted nothing had a settle path for it: a staged send left an empty
        // bubble in the transcript permanently. `runOutcome` keyed its
        // cancel/error text on this row's `ensembleProgress`, and that guard goes
        // with it, so an interrupted run settles the answer row and nothing else.
        updateRequestMessages(prev => [...prev, userMessage]);
        setInput('');
        setImages([]);

        
        // Only claim the hybrid fetch when the feature is ON — the old
        // condition spun the HybridDataPanel for the whole run even with the
        // toggle off (the skip path never reset it).
        //
        // Guard against cross-symbol contamination: cached hybrid data from a
        // previous analysis (e.g. BTC) must never feed a different coin
        // (e.g. ETH) — the wrong prices/ATR/regime would be injected into the
        // analyst prompts and persisted onto the new trade card.
        // EXPLICIT WINS, then the words, then the instrument the user picked in
        // the surface. The picker has to reach the analysis or it is decoration:
        // asking "what is BTC doing?" while ETH is selected must analyse BTC, but
        // asking a question that names no coin must analyse what the user
        // selected rather than fetching nothing.
        const detectedSymbol = extractSymbolFromPrompt(effectiveInput) ?? options?.symbol ?? null;
        const cachedHybridAgeMs = hybridAtSend
            ? Date.now() - new Date(hybridAtSend.dataTimestamp).getTime()
            : Number.POSITIVE_INFINITY;
        const cachedHybridData = hybridAtSend
            && detectedSymbol
            && hybridAtSend.symbol === detectedSymbol
            && Number.isFinite(cachedHybridAgeMs)
            && cachedHybridAgeMs <= HYBRID_REUSE_MAX_AGE_MS
            ? hybridAtSend
            : null;
        // A manual send pulls the tape on demand through the desk tools; the
        // only packet folded into the prompt here is one an upstream capture
        // already fetched (auto-capture).
        let freshHybridData: HybridDataPacket | null = cachedHybridData;
        if (options?.presetHybridData) {
            setCurrentHybridData(options.presetHybridData);
            freshHybridData = options.presetHybridData;
            setIsHybridLoading(false);
        }

        // The `null` initializer is not decoration: the catch block below
        // (mapRunFailureMessages) reads it, and the cluster owns the lane
        // attribution now.
        // Id of the live-streaming casual-chat bubble (if this run is a casual
        // reply) so the catch block can settle it on cancel/error instead of
        // leaving a stuck isStreaming placeholder.
        let casualMessageId: string | null = null;
        // Casual chats attribute their error bubble to the provider that was
        // tried (modelsUsed), so a failed 1:1 bot reply surfaces INSIDE that
        // bot's thread instead of vanishing from the scoped view.
        let casualErrorAttribution: Record<string, string> | undefined;
        try {
            // The prompt A/B lane is a VALUE decided per run, begun BEFORE any
            // prompt is resolved. It used to be a module flag flipped here and
            // cleared in the `finally` below, so two runs deciding at once — a
            // schedule and a human send — each answered with whichever lane the
            // other had picked, and a run that threw before the finally still
            // reset the OTHER one's flag. There is nothing to un-set now.
            //
            // What this does NOT yet do: resolve a prompt override on the turn
            // path. Every `getPrompt` call site reachable from here is on the
            // analysis/skill-craft surfaces, and the desk turn that answers this
            // surface calls none of them — so the pair currently differs in what
            // it RECORDS, not in what it SENDS. Registered as an open item
            // (E-57 §3); the honest fix is to wire it or delete the dial. (O-55)
            const promptLane = beginPromptLane();
            // The corpus this run resolved, fingerprinted. Recorded so the journal
            // row can be grouped by the prompt that produced it — the version and
            // the lane are one measurement, not two. (O-47)
            const promptVersion = promptCorpusVersion(promptLane);
            const currentMessages = [...messagesRef.current, userMessage];
                        // Debate template steering rides the custom instructions so every
            // seat + the moderator see the framing (Scalp / Swing / Devil's
            // advocate / Risk-only).
            // Invoked notebook skills (/slug) resolve to their ACTUAL content
            // and ride the same lane — OpenBot's skills-as-system-turn shape:
            // "apply skill X" without skill X's text is a wish, not an
            // instruction. Missing slugs are stated, never silently dropped.
                        
            // HYBRID INTELLIGENCE: Inject real-time market data if enabled
            // Bayesian confidence cap computed by the hybrid fetch (calibration
            // pipeline) — enforced in processNewAnalysis below. Hoisted so the
            // nested function can read it (hybridResult is block-scoped).
            
            // Skip fetching if preset data was already passed (from auto-capture)
            devLog('[Hybrid Intelligence] ======= START =======');
            devLog('[Hybrid Intelligence] Enabled:', isHybridIntelligenceEnabled);
            devLog('[Hybrid Intelligence] HasPresetData:', !!options?.presetHybridData);
            devLog('[Hybrid Intelligence] User prompt:', effectiveInput);
            // Preset data (auto-capture) reaches the prompt through
            // `freshHybridData` below; no model turn fetches a packet implicit
            // from its wording any more.

            // USER STRATEGIES (Settings → Strategies): enabled book summaries
            // are injected into every analyst prompt AND bundled with the
            // hybrid chart block for every moderator surface — the ensemble
            // trades like a human following the uploaded book.
            
            // Coin detection for learning context: match only uppercase
            // tickers (no /i flag, which would match any word) and exclude
            // common command words, mirroring the GateKeeper commonWords
            // exclusion list. Hoisted ABOVE the moderator bundle so the
            // journal-driven accuracy blocks can join it.
            // TRADER NOTEBOOK stage (extracted): notebook slices, bot
            // memory, similar-setups record, regime weighting, loss priming.
            const { assemblePipelineMemoryContext, formatLossPrimingContext } = await import('./analysisPipeline/memoryContext');
            const {
                detectedLearningCoin,
                pendingDirection,
                pendingPattern,
                memoryFilesContext,
                similarSetupsContext,
                regimeWeightingContext,
                lossPrimingRows,
                asOfMs: memoryAsOfMs,
            } = await assemblePipelineMemoryContext(
                effectiveInput,
                loggedTrades,
                freshHybridData ?? null,
                userMessage.id,
                undefined,
                // One window value for every seat that reads this slice (it
                // rides analyst AND moderator prompts): the memory model's own
                // window decides, and windowBudgetTokens' floor keeps a tiny
                // window from zeroing memory out entirely.
                memoryConfig?.contextWindowTokens,
                // The same switch the seat prompts obey. Full analysis used to
                // read the profile index whatever the trader had chosen.
                isGlobalMemoryEnabled !== false,
            );

            // One context bundle for every moderator surface (autoplay debate,
            // real debate, accuracy verification, compact retry): the same
            // chart/pattern block the analysts see + the user strategies.
            
            // 'auto' trading style was hardcoded to 'swing' at every call
            // site — the market-data detector (ADX/regime/volume/session)
            // was never invoked. Resolve the effective style ONCE from the
            // live data so the lens prompts, the rebuttal personas and the
            // card's tradingStyle field all agree. Falls back to swing when
            // no hybrid data exists (hybrid off / fetch failed).

            // AI LEARNING: the old UnifiedLearningBuilder channel is
            // RETIRED — its six overlapping profile/mistake/insight injections
            // fought the budgeted notebook slice above (two memory voices is
            // exactly the degradation mode the simplification killed).
            // What survives is the one thing the notebook slice cannot produce:
            // per-provider historical accuracy weighting (weighted voting), fed
            // to BOTH the analysts and the moderator. Gated on a real closed
            // trade sample so fresh installs get clean prompts.
            let learningInjection = '';
            // Separate context for moderator surfaces

            const closedSample = loggedTrades.filter(
                t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS,
            ).length;
            if (closedSample >= 3 && enabledProviders.length > 0) {
                try {
                    learningInjection = generateWeightedVotingContext(
                        enabledProviders.map(p => p.config.id),
                        pendingPattern || undefined,
                    );
                    if (learningInjection) {
                        devLog('[AI Learning] Weighted-voting context generated:', learningInjection.length, 'chars');
                    }
                } catch (learningError) {
                    console.error('[AI Learning] Failed to generate weighted-voting context:', learningError);
                }
            }

            // Retrieved harness context already carries similar trades + skills.
            // Do not also dump the pattern-memory essay or raw insight list.

            let recentInsightsString: string | null = null;
            if (!memoryFilesContext && tradeSummaries && tradeSummaries.length > 0) {
                const top10Summaries = tradeSummaries.slice(0, 10);
                recentInsightsString = top10Summaries.map((s, idx) => `${idx + 1}. [${new Date(s.timestamp).toLocaleDateString()}] ${s.summaryText}`).join('\n\n');
                devLog('[Recent Insights] Generated from tradeSummaries array, length:', recentInsightsString.length);
            }

            // Every retrieved block that used to be assembled into a local
            // `enhancedPrompt` and then THROWN AWAY — the sends below pass
            // `promptToSend` — is collected here and handed to the DESK turn
            // (`runChatSurfaceTurn`), which puts it where a model reads
            // guidance (the system prompt). The bot-thread branch below takes
            // NO context argument: bots are chat-only by design (stage 20
            // ruling), so these blocks reach the desk path only. The trader's
            // own closed-trade lessons, skill-veto prose and notebook bodies
            // were computed, logged, and never sent (the 2026-10-27 audit L-8).
            //
            // THE ORDER IS THE BUDGET. `extraContext` is a PREFIX window — the
            // turn keeps its front and cuts its tail — so whatever is pushed
            // LAST is the first thing a cap removes. The order below is decision
            // relevance for THIS read, highest first: the coin+direction-scoped
            // lessons lead, and the broad notebook slice plus the provider
            // accuracy table trail, because a generic accuracy ranking is worth
            // less to one answer than the trader's own last loss on this setup.
            const contextParts: string[] = [];
            // 1. Coin+direction-scoped recent closed-trade lessons (loss priming,
            //    B4) — composed by the memory stage and read by nobody until now.
            if (lossPrimingRows.length > 0) {
                contextParts.push(formatLossPrimingContext(lossPrimingRows));
            }
            // 2. E7: the coin's last stored post-mortem rides the context bundle
            // (REFERENCE ONLY) — a lesson the tracked loop already earned is
            // invisible to an ordinary answer otherwise, and must not be
            // reachable only when the seat happens to emit a signal. The block
            // swallows its own read failure, so it costs itself, never the run.
            if (detectedLearningCoin) {
                const { diagnosisBriefBlock } = await import('../services/tracking/diagnosisBrief');
                const briefCoin = /USDT?$/i.test(detectedLearningCoin)
                    ? detectedLearningCoin.toUpperCase()
                    : `${detectedLearningCoin.toUpperCase()}USDT`;
                const briefBlock = await diagnosisBriefBlock(briefCoin);
                if (briefBlock) contextParts.push(briefBlock);
            }
            // 3. The journal's own track record for this setup (win rate / EV).
            if (similarSetupsContext) contextParts.push(similarSetupsContext);
            // 4. The model's track record in the CURRENT regime — the other
            //    block the memory stage composed and no consumer read.
            if (regimeWeightingContext) contextParts.push(regimeWeightingContext);
            // 5. The notebook slice (skills, bot memory).
            if (memoryFilesContext) contextParts.push(memoryFilesContext);
            // 6. Provider accuracy weighting — the moderator's tiebreaker, the
            //    least coin-specific block, so it is the first to be cut.
            if (learningInjection) contextParts.push(learningInjection);
            // ========== GATE KEEPER: Two-Stage Gate Scan ==========
            // The authoritative symbol is the one detected at the top of the
            // run: extractSymbolFromPrompt (canonical pair extraction), then
            // the surface's instrument picker. This block used to re-detect
            // with a case-insensitive scan whose stopword check was
            // case-SENSITIVE — a lowercase prompt like "what is the plan for
            // btc today" minted "WHATUSDT" and ran the gate scan on a
            // nonexistent market — and it shadowed the picker value, which
            // then never reached the gate scan or the coin-lessons block.
            const finalSymbol = detectedSymbol;

            // ========== DECISION REFLECTIONS ==========
            // Feed the user's closed trades + lessons back into the NEXT run
            // (TradingAgents/Reflexion loop): the model reasons with actual
            // outcomes for this ticker, not only generic extracted rules.
            // Pushed last and unshifted to the FRONT: it leads the bundle, so a
            // cap that cuts the tail never reaches it. (Its same-ticker rows
            // overlap the loss-priming block below by design — ticker-scoped raw
            // excerpts there, coin+direction-scoped distilled lessons here.)
            try {
                const reflectionBlock = buildDecisionReflectionContext(loggedTrades, finalSymbol);
                if (reflectionBlock) {
                    contextParts.unshift(reflectionBlock);
                }
            } catch { /* reflection is best-effort */ }
            // ========== END GATE KEEPER ==========

            const extraContext = contextParts.filter(Boolean).join('\n\n');
            devLog('[Hybrid Intelligence] Retrieved context length:', extraContext.length);
            devLog('[AI Learning] Has learning injection:', learningInjection.length > 0);
            devLog('[Hybrid Intelligence] ======= END =======');

            // Casual chat: use the user-selected model when it maps to a
            // ready provider; otherwise fall back to the first ready
            // provider (previous behavior).
            // ── Bot Mode: inside a bot's 1:1 thread, the send runs
            // AS the bot — its exact provider+model, its persona system
            // prompt, and only its own thread's history (threads are
            // derived views; threadForProvider is the same slice the
            // rail renders). Outside bot threads activeBot is null and
            // behavior is unchanged.
            const activeBot = getActiveBot?.() ?? null;
            const botProvider = activeBot
                ? providerConfigs.find(c => c.id === activeBot.providerId && isProviderReady(c) && c.models.includes(activeBot.modelId))
                : undefined;
            const useBotThread = Boolean(activeBot && botProvider);
            // The composer selection is provider-qualified
            // (`providerId::modelId`) so a model name offered by two
            // providers answers from the one the user actually picked.
            // Legacy bare ids resolve heuristically (see providerUtils).
            const chosen = useBotThread && activeBot && botProvider
                ? botProvider
                : resolveChatModelSelection(providerConfigs, selectedChatModel) ?? undefined;
            const chatModel = useBotThread && activeBot ? activeBot.modelId : chatModelIdOf(selectedChatModel);
            const provider = chosen
                ? { config: { ...chosen, selectedModel: chatModel }, name: chosen.name, model: chatModel, useImages: false, thoughtsKey: chosen.id }
                : enabledProviders[0];
                setLoadingFor(requestConversationId, "Thinking...");
            // The app-level flag is re-derived, not set: it means "the
            // conversation on screen is running (or a schedule is)", so it can
            // never be left saying "running" for a thread the trader has left.
            syncProgressFlag();
            // Stream the reply into the bubble as it generates (perceived
            // speed) instead of appending it once after completion.
            const streamingMessageId = `ai-${Date.now()}`;
            casualMessageId = streamingMessageId;
            casualErrorAttribution = { [provider.config.id]: provider.model };
            updateRequestMessages(prev => [...prev, {
                id: streamingMessageId,
                role: MessageRole.AI,
                text: '',
                createdAt: new Date().toISOString(),
                modelsUsed: { [provider.config.id]: provider.model },
                isStreaming: true,
            }]);
            let reasoningContent = '';
            let visibleContent = '';
            // ONE live writer for both shapes of this branch: the
            // RAF-coalesced casual updater, so a tool turn's per-token paint
            // costs one Message write per frame exactly like the plain one.
            const paint = (text: string, thinking: string): void => {
                throttledCasualStream(requestConversationId, streamingMessageId, text, thinking, provider.config.id, true);
            };
            // The bubble's own stamp: a Stop, a failure and a clean finish
            // must all report the same "worked for Ns", not each measure from
            // their own `Date.now()`.
            const turnStartedAt = Date.now();
            let toolTurn: ToolTurnOutcome | null = null;
            let responseText = '';
            if (useBotThread && activeBot) {
                // BOTS STAY CHAT-ONLY (stage 20 ruling). The roster
                // answers with its persona over the plain transport;
                // `useBotMailbox` and `groupRounds` are
                // deliberately NOT moved onto the tool turn. `extraContext`
                // is built for the desk branch only — this transport takes no
                // context argument, so the notebook blocks do not reach bot
                // threads.
                responseText = await streamQuickResponse(
                    provider.config,
                    promptToSend,
                    // Bot threads see ONLY their own thread (derived view).
                    threadForProvider(currentMessages, activeBot.providerId, activeBot.modelId, activeBot.id),
                    activeBot.systemPrompt,
                    currentAbortController.signal,
                    reasoning => {
                        reasoningContent += reasoning;
                        paint(visibleContent, reasoningContent);
                    },
                    delta => {
                        visibleContent += delta;
                        paint(visibleContent, reasoningContent);
                    },
                    // The dial the surface is showing, not the task default: a
                    // chip that displayed a tier while the request sent `'low'`
                    // is the dead affordance this argument exists to remove.
                    options?.reasoningEffort,
                );
            } else {
                // THE DESK ANSWERS WITH ITS TOOLS — the one executor the
                // Chart AI dock runs, writing this canonical row instead of
                // a dock entry. Ordinary conversation on this surface used
                // to be answered from the model's training data while the
                // dock looked the same question up.
                const { runChatSurfaceTurn } = await import('../services/trade/chatSurfaceTurn');
                toolTurn = await runChatSurfaceTurn({
                    config: provider.config,
                    history: currentMessages,
                    prompt: promptToSend,
                    // The silent 80% digest for turns this request has outgrown.
                    // Stored by the background summarizer; absent until then, and
                    // a stale digest is bounded by the summarizer's size cap.
                    threadSummary: activeConversation?.threadSummary,
                    memoryEnabled: isGlobalMemoryEnabled !== false,
                    strategiesEnabled: isStrategiesEnabled !== false,
                    extraContext,
                    // An attached screenshot is SENT, not mentioned: before
                    // this the camera on this surface painted a bubble the
                    // model never received.
                    image: dataURLs[0],
                    symbol: finalSymbol ?? options?.symbol ?? null,
                    interval: options?.interval,
                    trades: loggedTrades,
                    effort: options?.reasoningEffort,
                    requireTools: options?.fullAnalysis === true,
                    signal: currentAbortController.signal,
                    startedAt: turnStartedAt,
                    patch: fn => updateMessages(
                        prev => prev.map(m => (m.id === streamingMessageId ? fn(m) : m)),
                        requestConversationId,
                    ),
                    paint,
                });
                responseText = toolTurn.text;
            }
            if (!isCurrentRequest()) assertCurrentRequest();
            // Split before display: native CoT and any leaked scratchpad
            // belong in the bubble's Thinking row, never in the reply. The
            // tool turn already did this on its own accumulator (`runToolTurn`
            // owns the peel so both homes settle the same way), so re-splitting
            // its output would be a second opinion about the same text.
            const casualSplit = toolTurn
                ? { output: toolTurn.text, thinking: toolTurn.reasoning }
                : splitThinkingFromOutput(reasoningContent, responseText);
            // Strip [[dm:@…]] markers BEFORE the first persisted update:
            // the mailbox delivery below is fire-and-forget, so without
            // this the bubble shows raw marker text until the mailbox's
            // own patch lands (and forever if it throws). The mailbox
            // still receives the RAW text — it needs the markers to route.
            const casualClean = parseDmMarkers(casualSplit.output).clean.trim();
            // Casual chat is a single-model conversation. Do not store the
            // answer as an individual insight; that creates an oversized
            // "Individual AI Insights" section under ordinary replies.
            // Flush BEFORE the settle write, never after. A chunk that
            // arrived between the last animation frame and here is still
            // pending; flushing after the settle re-applies it and puts
            // `isStreaming: true` and the un-stripped live text back onto
            // the message that was just settled — permanently.
            throttledCasualStream.flush();
            updateMessages(prev => prev.map(m => m.id === streamingMessageId ? {
                ...m,
                // A deliberate Stop keeps the half-written answer the trader
                // chose to cut; a clean turn keeps the settled text.
                text: toolTurn?.interrupted ? (m.text || casualClean) : casualClean,
                isStreaming: false,
                modelsUsed: { [provider.config.id]: provider.model },
                thoughtProcesses: casualSplit.thinking ? { [provider.config.id]: casualSplit.thinking } : undefined,
                ...(toolTurn && !toolTurn.interrupted ? {
                    runStats: {
                        runId: `desk-${streamingMessageId}`,
                        promptLane,
                        promptVersion,
                        startedAt: new Date(turnStartedAt).toISOString(),
                        finishedAt: new Date(turnStartedAt + toolTurn.workedMs).toISOString(),
                        durationMs: toolTurn.workedMs,
                        // The thinking tier the answer was produced under. It
                        // comes out of the executor, so the row and the wire
                        // can never claim different tiers for one turn.
                        effort: toolTurn.effort,
                        // The wire reported these; the row keeps the measured
                        // numbers instead of making the compare panel show "—".
                        promptTokens: toolTurn.usage.promptTokens,
                        completionTokens: toolTurn.usage.completionTokens,
                        analystCount: 1,
                        costUsd: estimateCostUsd(toolTurn.usage, provider.config),
                    },
                } : {}),
                // The tools-off / reasoning-only truth belongs IN the
                // transcript, beside the lines that claim it — not in a toast
                // that disappears while the answer stays on screen.
                ...(toolTurn?.notice ? {
                    liveToolEvents: {
                        ...m.liveToolEvents,
                        desk: [m.liveToolEvents?.desk, toolTurn.notice].filter(Boolean).join('\n'),
                    },
                } : {}),
                // What the wire was actually asked, so the row can say WHY
                // this answer has no trace: the transport decided, and the
                // decision is the only honest answer to that question.
                ...(toolTurn?.wireAudit?.length ? { wireAudit: toolTurn.wireAudit } : {}),
            } : m), requestConversationId);
            // ── Completion notice for a run the trader asked for by name.
            // Before stage 19 this fired from the verdict finalizer; with the
            // finalizer out of the send path a Full analysis could finish in the
            // background and say nothing, which is how an unattended 40-second
            // turn becomes a tab the trader waits in. Scoped to the explicit
            // request and to turns that were not stopped, so an ordinary chat
            // line stays quiet and a cancelled one does not announce itself.
            // Schedules are excluded — nobody is watching them live, and 20r
            // already lands their outcome in the run's own row.
            if (options?.fullAnalysis === true && toolTurn && !toolTurn.interrupted) {
                void notify(
                    'Analysis complete',
                    `${provider.config.name} · ${provider.model} answered in `
                        + `${(toolTurn.workedMs / 1000).toFixed(1)}s — open the app to read it.`,
                    { tag: streamingMessageId },
                );
            }
            // ── Bot Mode: hand the settled reply (raw, markers
            // included) to the mailbox — it strips [[dm:@…]] markers
            // from the bubble and delivers the DMs. Fire-and-forget.
            if (useBotThread && activeBot && onBotReply) {
                try { onBotReply(streamingMessageId, casualSplit.output || responseText); } catch { /* mailbox must never break the reply */ }
            }
            // End of the try — the run completed. Success.
            return { ok: true };
        } catch (error: any) {
            // Runs for BOTH errors and user cancels. Previously the
            // `!isCurrentRequest()` early-return skipped this cleanup on abort,
            // leaving a streaming bubble stuck with a permanent
            // "thinking" indicator until the next reload.
            //
            // Only a true abort of THIS run's own signal is a cancellation.
            // `!isCurrentRequest()` also returns true when a NEWER run simply
            // replaced the abort-controller ref — labeling that run's genuine
            // error as "cancelled" silently swallowed real failures.
            const cancelled = currentAbortController.signal.aborted;
            // A pending replacement wait is void — a late click on the banner
            // must never resolve into a dead debate.
            replacementChoiceRef.current = null;
            // FLUSH BEFORE SETTLING, for the same reason the success path does:
            // a chunk that arrived between the last animation frame and here is
            // still pending, and a settle followed by that flush re-applies the
            // live text WITH `isStreaming: true` — a permanently "thinking" row
            // on a failed or stopped turn (the 2026-10-27 audit L-4).
            throttledCasualStream.flush();
            // Settle a live-streaming casual bubble; every other row survives.
            // `cancelled` rides through: a Stop is an interrupted row, not a
            // completed one (the same rule the dock's settle path applies).
            updateRequestMessages(prev => mapRunFailureMessages(prev, { casualMessageId, cancelled }));

            // User cancels / stale runs get no error bubbles. A deliberate
            // Stop (or a superseded run) is NOT a retryable failure —
            // ok:true lets a queued replay of it dequeue instead of fighting
            // the user with a backoff retry.
            if (cancelled) return { ok: true };

            const failureKind = classifyRunFailure(error);
            // Rate limits first — isQuotaError also claims status === 429, so
            // the dedicated rate-limit path below was previously unreachable.
            if (failureKind === 'rate-limit') {
                // See `rateLimitEpochRef`: the cooldown belongs to the flag, so the
                // timer that clears it must not be tied to a run the `finally` has
                // already released.
                const epoch = rateLimitEpochRef.current + 1;
                rateLimitEpochRef.current = epoch;
                setIsRateLimited(true);
                window.setTimeout(() => {
                    if (rateLimitEpochRef.current === epoch) setIsRateLimited(false);
                }, RATE_LIMIT_COOLDOWN_MS);
                // Transient — a queued replay must RETRY with backoff.
                return { ok: false };
            }

            if (failureKind === 'quota') {
                const flaggedModel = resolveQuotaFlaggedModel(error, providerConfigs, enabledProviders);
                updateRequestMessages(prev => [...prev, { id: `err-${Date.now()}`, role: MessageRole.SYSTEM, createdAt: new Date().toISOString(), text: `Model "${flaggedModel || 'an enabled AI'}" has exceeded its usage quota.` }]);
                return { ok: false };
            }

            // Offline sends are queued and re-dispatched on reconnect instead
            // of landing as a dead error bubble (the queue was previously
            // wired to the header badge but nothing ever enqueued). The
            // username is passed EXPLICITLY at the enqueue site so the item's
            // profile stamp never depends on the queue module's marker being
            // fresh — processQueue replays only the active user's items.
            // (Kept inline: tests/offlineQueueCompletion.test.ts pins this
            // enqueue site's shape by source contract.)
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
                try {
                    await offlineQueue.add({ type: 'analysis', username: getActiveUsername(), payload: { prompt: effectiveInput, images: imagesToUse.map(img => img.dataURL) } });
                    updateRequestMessages(prev => [...prev, { id: `err-${Date.now()}`, role: MessageRole.SYSTEM, createdAt: new Date().toISOString(), text: "You're offline — this analysis was queued and will run automatically when you're back online." }]);
                    // Re-queued as a FRESH item — this attempt is done; let
                    // the replayed original dequeue (no duplicate retry).
                    return { ok: true };
                } catch (queueErr) {
                    console.warn('[Pipeline] Failed to queue offline request:', queueErr);
                }
            }

            // Sanitize the fallback: never leak long key-like tokens (API keys)
            // and cap length so internal SDK errors stay readable but bounded.
            const safeMessage = sanitizeFallbackErrorMessage(error instanceof Error ? error.message : "An unknown error occurred.");
            // retryOf lets the error bubble rebuild the exact prompt + charts
            // (the send cleared the composer immediately, so a failure left
            // the user with no way to re-run the same setup).
            //
            // The message carries the REAL reason in the ERROR field, and the
            // text keeps the same words for the machine readers (the export,
            // the retry that rebuilds the prompt). The row renders the error,
            // not the text: a failed turn written as an answer reads as
            // though the seat had said the app's own error hint.
            updateRequestMessages(prev => [...prev, { id: `err-${Date.now()}`, role: MessageRole.SYSTEM, createdAt: new Date().toISOString(), text: safeMessage, error: safeMessage, retryOf: { userMessageId: userMessage.id }, modelsUsed: casualErrorAttribution }]);

            // The generic error-bubble path: the analysis FAILED internally.
            // ok:false is what keeps an offline-queue replay on the
            // retry/backoff path instead of dequeuing a dead run (§2.3).
            return { ok: false };
        } finally {
            // Release THIS run only. A run that is not the owner of its key
            // has already been replaced by a newer one in the same
            // conversation, which owns the state from there on.
            if (runsRef.current.get(requestRunKey)?.controller === currentAbortController) {
                const run = runsRef.current.get(requestRunKey);
                if (run) run.inFlight = false;
                runsRef.current.delete(requestRunKey);
                if (run?.conversationId) endConversationRunOwned(run.conversationId, currentAbortController);
                // Cancelling during the hybrid fetch skipped setIsHybridLoading
                // (the assert threw before it) — reset here so the panel
                // spinner can't spin until the next run.
                setIsHybridLoading(false);
                setLoadingFor(requestConversationId, null);
                syncProgressFlag();
            }
            // NOTE: queued sends are NOT drained here. The drain (see the
            // effect below) keys on the isAnalysisInProgress false-transition
            // AFTER React commits, because this closure's captured state is
            // stale — draining here would start the next run with a
            // mid-run-era closure. When a drain does start a new run before
            // this finally executes (fast cancel), the ownership guard above
            // sees a replaced controller and skips this cleanup — the new run
            // owns the state from there on.
        }
    }, [loadingMessage, finalTradeSummary, activeFrameworks, isRateLimited, providerConfigs, isDeepAnalysis, selectedOcrModel, updateMessages, moderatorConfig, moderatorModel, memoryConfig, activeConversationId, activeConversation, isAnalysisInProgress, globalMemory, isGlobalMemoryEnabled, customInstructions, isHybridIntelligenceEnabled, selectedChatModel, loggedTrades, tradeSummaries, isStrategiesEnabled, confirmDialog, toast, setLoadingFor, setSteeringFor, steeringFor, syncProgressFlag]);

    // ─── Cancel Analysis ───────────────────────────────────────────────────
    /**
     * Stop a run.
     *
     * With an id, it stops THAT conversation's run and nothing else — that is
     * what deleting a conversation needs, and what a surface that names its
     * conversation needs.
     *
     * With no id, it stops the run the trader can SEE: the ACTIVE
     * conversation's. A background conversation's run keeps going — that is
     * the whole point of the registry — and the trader can switch to it and
     * stop it there.
     *
     * It ALSO stops any run that belongs to a DIFFERENT trader. The profile
     * switch (`hooks/useUserProfileLoader.ts`) calls this with no id, and it
     * does so BEFORE the username flips, so the cancel alone cannot see that
     * the trader changed; the owner check below is the backstop, and the
     * write-path guard in `updateRequestMessages` is the one that actually
     * holds.
     */
    const handleCancelAnalysis = (conversationId?: string): void => {
        if (conversationId !== undefined) {
            cancelRunAt(runKeyFor(conversationId));
            return;
        }
        cancelRunAt(runKeyFor(activeConversationIdRef.current));
        const currentUser = getActiveUsername();
        for (const [key, run] of [...runsRef.current]) {
            if (run.owner !== currentUser) cancelRunAt(key);
        }
    };

    /**
     * The profile switch's hard stop.
     *
     * The switch cancels BEFORE the username flips, so `handleCancelAnalysis`
     * cannot see the change on that call. This effect can: by the time it
     * runs, the new profile is the active one, and a run that belongs to the
     * PREVIOUS trader is aborted before it can write a word into the new
     * trader's data.
     *
     * It runs on every render on purpose — the username is not React state
     * here, so there is nothing to depend on. The loop is bounded: the abort
     * removes the record, so the next pass finds nothing to do.
     */
    useEffect(() => {
        const currentUser = getActiveUsername();
        for (const [key, run] of [...runsRef.current]) {
            if (run.owner !== currentUser) cancelRunAt(key);
        }
    });

    // ─── Chat Management ───────────────────────────────────────────────────
    const handleClearChat = async (conversationId?: string) => {
        const ok = confirmDialog
            ? await confirmDialog({ title: 'Clear chat?', message: 'Clear current chat messages?', destructive: true })
            : confirm('Clear current chat messages?');
        // An explicit id clears THAT conversation — the Chat rail's row menu
        // clears a row without loading it first. Default stays the active one.
        if (ok) updateMessages(() => [], conversationId ?? null);
    };

    const handleDeleteMessages = async (ids: string[]) => {
        // F1: message deletion gets a 5s undo like every other destructive
        // clear in the app (conversations, trade history, analyses).
        const prevMessages = messagesRef.current;
        const ok = confirmDialog
            ? await confirmDialog({
                title: 'Delete messages?',
                message: `Delete ${ids.length} messages?`,
                destructive: true,
                undoGraceMs: 5000,
                onUndo: () => {
                    updateMessages(() => [...prevMessages]);
                    toast.success?.('Messages restored');
                },
            })
            : confirm(`Delete ${ids.length} messages?`);
        if (ok) updateMessages(prev => prev.filter(m => !ids.includes(m.id)));
    };

    // ─── Queued-send drain: the run ends, the queue runs ───────────────────
    // Everything parked while a run was live drains as ONE follow-up turn
    // when the run ends — however it ended. Settling is not the same as
    // succeeding: a complete, errored, or user-stopped run all drain, which
    // is what makes Stop a way of steering rather than a way of giving up
    // (park a correction, press Stop, and the correction is what runs next).
    // One turn and not one per message, newline-joined: three quick
    // corrections are usually one correction typed in three breaths. Keyed on
    // the isAnalysisInProgress FALSE-TRANSITION — not on run completion —
    // so it fires after React has committed the idle state and the send runs
    // with a fresh closure. A conversation switch clears the queue first (the
    // switch effect above), so parked words never drain into the wrong
    // thread; the queue is memory in one mount, not an outbox.
    drainSendRef.current = handleSendMessage;
    /**
     * Which conversations had a live run, so the drain knows whose queue to
     * empty. Per conversation, because the queue is: a correction parked in
     * one thread drains into that thread.
     */
    const wasRunActiveRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const key = runKeyFor(activeConversationId);
        const live = runsRef.current.get(key)?.inFlight === true;
        if (live) {
            wasRunActiveRef.current.add(key);
            return;
        }
        if (!wasRunActiveRef.current.has(key)) return;
        wasRunActiveRef.current.delete(key);
        const queuedDrain = steeringRef.current.get(key) ?? [];
        if (queuedDrain.length === 0) return;
        steeringRef.current.set(key, []);
        setSteeringFor(activeConversationId, []);
        void drainSendRef.current?.(queuedDrain.join('\n'));
    }, [activeConversationId, isAnalysisInProgress]);

    return {
        // State
        input, setInput,
        images, setImages,
        loadingMessage, setLoadingMessage,
        currentVisionData, setCurrentVisionData,
        isDeepAnalysis, setIsDeepAnalysis,

        // Refs — the live runs are owned per conversation now
        // (see runsRef); there is no single app-wide controller to hand out.

        // Handlers
        handleSendMessage,
        handleCancelAnalysis,
        handleClearChat,
        handleDeleteMessages,
        getActiveCustomInstructions,
        // Mid-debate analyst replacement: the user picks a candidate (or
        // passes null to continue without) from the debate banner.
        handleReplacementChoice,
        steeringNotes,
        handleRemoveSteeringNote: (index: number) => {
            // Removes from the ACTIVE conversation's queue — the one the note
            // is drawn in.
            const key = runKeyFor(activeConversationIdRef.current);
            const queue = steeringRef.current.get(key) ?? [];
            const next = queue.filter((_, i) => i !== index);
            steeringRef.current.set(key, next);
            setSteeringFor(activeConversationIdRef.current, next);
        },
        // Steer or bench one seat mid-debate.
        handleSteerSeat: (seatName: string, note: string) => {
            seatSteeringRef.current[seatName] = note;
            toast.success?.(`Queued for ${seatName}`, 'Applied at that seat\'s next turn.');
        },
        handleStopSeat: (seatName: string) => {
            stoppedSeatsRef.current.add(seatName);
            toast.success?.(`${seatName} stopped`, 'The debate continues without them at the next round.');
        },
    };
}
