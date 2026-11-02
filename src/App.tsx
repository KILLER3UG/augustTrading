
import React, { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import { reapplyIdleMotionClass } from './services/desk/idleMotion';

// Apply the user's persisted stillness preference to <body> on app startup,
// before the first running row can paint.
reapplyIdleMotionClass();
import { Message, MessageRole, TradeOutcome, Conversation, ImageMetadata, AIProvider, LoggedTrade } from './types';
import { subscribeMemoryFilesChanged } from './services/learning/MemoryFilesService';
import { runNotebookReview } from './services/learning/MemoryReviewService';
import { stripRemovedAppSettings } from './services/infrastructure/legacySettings';
import { useUserProfileLoader } from './hooks/useUserProfileLoader';
import { useTradeJournalActions } from './hooks/useTradeJournalActions';
import { useProfilePersistence } from './hooks/useProfilePersistence';
import { useConversationHousekeeping } from './hooks/useConversationHousekeeping';
import { useAgentThreads } from './hooks/useAgentThreads';
import { useWatchAndAutopilot } from './hooks/useWatchAndAutopilot';
import { buildProposedTradeMessage, type TradeProposal } from './services/trade/proposedTrade';
import { ensureStamp } from './services/trade/proposalGate';
import * as chatStore from './services/trade/chatStore';
import * as watchService from './services/trade/watchService';
import * as levelWatch from './services/trade/levelWatchService';
import { notify } from './services/infrastructure/notify';
import { latestChartVerdict } from './services/trade/chartData';


// Modular Imports
import { useToastActions } from './components/shared/Toast';
import { FORGED_PROPOSAL_EVENT } from './services/tools/toolForge';
import { AMENDMENT_EVENT } from './services/learning/memoryAmendments';
import { countPendingEverything } from './services/learning/memoryHealth';
import { loadBotLearningStats } from './services/agents/botLearning';
import { useConfirmDialog } from './components/shared/ConfirmDialog';
import { Header } from './components/shared/Header';
import { useProviderConfigs } from './hooks/useProviderConfigs';
import { useAppSettings } from './hooks/useAppSettings';
import { useJournalUI } from './hooks/useJournalUI';
import type { JournalUIState } from './hooks/useJournalUI';
import { ChevronDownIcon, CloseIcon } from './components/shared/Icons';

// Lazy-load heavy, conditionally-rendered components so the initial
// bundle stays small. Previously the entire app was one ~1.73 MB chunk.
// Each lazy() call below produces a separate chunk loaded on demand when
// the user opens the corresponding panel/modal. ChatArea and Header stay
// eager (always-rendered, critical path).
const StrategySearch = React.lazy(() => import('./components/shared/StrategySearch'));
const UserProfileManager = React.lazy(() => import('./components/settings/UserProfileManager'));
const WatchListPanel = React.lazy(() => import('./components/analysis/WatchListPanel'));
const ActionApprovalsPanel = React.lazy(() => import('./components/learn/ActionApprovals'));
const JobsDrawer = React.lazy(() => import('./components/settings/JobsDrawer'));
import { AskUserInputCard } from './components/shared/AskUserInputCard';
const SettingsMenu = React.lazy(() => import('./components/settings/SettingsMenu'));

// (LogTradeModal was removed — the capture flow uses DataCaptureModal.)
const DataCaptureModal = React.lazy(() => import('./components/modals/DataCaptureModal').then(m => ({ default: m.DataCaptureModal })));
const EntryNotHitCaptureModal = React.lazy(() => import('./components/modals/EntryNotHitCaptureModal').then(m => ({ default: m.EntryNotHitCaptureModal })));
const VisionDataViewer = React.lazy(() => import('./components/analysis/VisionDataViewer'));
const LiveMarket = React.lazy(() => import('./components/market/LiveMarket'));
const UpdateOverlay = React.lazy(() => import('./components/shared/UpdateOverlay'));
const StrategyStudio = React.lazy(() => import('./components/dashboards/StrategyStudio'));
const TradeView = React.lazy(() => import('./components/trade/TradeView'));
const NewBotDialog = React.lazy(() => import('./components/chat/NewBotDialog'));
const NewGroupDialog = React.lazy(() => import('./components/chat/NewGroupDialog'));
const GroupChatView = React.lazy(() => import('./components/chat/GroupChatView'));
const CoachThreadPanel = React.lazy(() => import('./components/chat/CoachThreadPanel'));
const LearnView = React.lazy(() => import('./components/learn/LearnView'));
import type { LearnTab } from './components/learn/LearnView';
import SkillsLibrary from './components/skills/SkillsLibrary';
const AgentsView = React.lazy(() => import('./components/agents/AgentsView'));
import ModelChip from './components/shared/ModelChip';
import { effortDialUp } from './components/shared/effortDial';
import { nextEffortTier } from './components/shared/effortScale';
import { DEFAULT_FRAMEWORKS } from './constants/models';
import { computeChatModelFallback, isProviderReady } from './utils/providerUtils';
import { defaultLeverage, createNewConversation, findReusableEmptyConversation } from './utils/conversationUtils';
import { collectApprovalItems, setAutoJournalRule, type ApprovalItem } from './utils/approvalInbox';
import { type ThreadSelection, threadForProvider } from './utils/agentThreads';
import {
    updateBot, 
    groupDisplayName, 
    type AgentBot,
} from './services/agents/agentRoster';
import { useAgentGroups } from './hooks/useAgentGroups';
import { useBotMailbox, type UseBotMailboxResult } from './hooks/useBotMailbox';
import { buildBotSystemPrompt } from './services/agents/botMailbox';
import { classifyBotAttention } from './services/agents/botAttention';
import { readBotSystemMarkdown, readBotMemoryMarkdown } from './services/bots/BotMemoryService';
import { takeSkillDraft, tombstoneSkillDraftKey, draftTriggerKey, listSkillDrafts, type SkillDraft } from './utils/skillDrafts';
import { listLearningProposals } from './utils/learningQueue';
import { approveSkillDraft, skillApprovalToast } from './services/learning/skillApproval';
import useNetworkStatus from './hooks/useNetworkStatus';
import { useSupervisorBootstrap } from './hooks/useSupervisorBootstrap';
import { useLearningHeartbeat } from './hooks/useLearningHeartbeat';
import { useUIState } from './hooks/useUIState';
import { useConversations } from './hooks/useConversations';
import { useMarketData } from './hooks/useMarketData';
import { useTradeLogging } from './hooks/useTradeLogging';
import { useAnalysisPipeline } from './hooks/useAnalysisPipeline';
import { useUserProfiles } from './hooks/useUserProfiles';
import { offlineQueue } from './services/infrastructure/OfflineQueueService';
import { getPreference, setPreference, removePreference, PREF_KEYS } from './services/infrastructure/PreferencesService';
// AI Learning Services - Adaptive Learning, Mistake Patterns, Insight Extraction
import { ProviderConfig, type ReasoningEffort } from './types/provider';
import { isProviderOnCooldown, providerCooldownRemainingMs } from './services/infrastructure/ProviderHealthService';
import { stopAutoBackup, createBackup, getBackups, type BackupMetadata } from './services/infrastructure/BackupService';
import { useWatchSideEffects } from './hooks/useWatchSideEffects';
import { useSurfaceRouter } from './hooks/useSurfaceRouter';
import { useColumnResize } from './hooks/useColumnResize';
import type { AppSurface } from './hooks/useSurface';
import type { TradeMode } from './components/trade/TradeView';
import type { SoloTurnRow } from './services/trade/chatTurnMirror';
import { type NavBadge } from './components/shell/SurfaceMenuList';
// The rail is DELETED (2026-10-28). Its live row and collapse threshold moved
// to shellChrome; the update control moved to the header. Nothing imports the
// old module, and the dead test reference went with it.
//
// This note stays where the old import sat: the account row and the collapse
// threshold are the live pieces of that shell module, and the deletion is not
// a rename that a future reader should undo.
import { AccountRow, NAV_RAIL_AUTO_COLLAPSE_PX, NAV_RAIL_EXPANDED_PX } from './components/shell/shellChrome';
import StatusCluster from './components/shell/StatusCluster';
import SurfaceSwitch from './components/shell/SurfaceSwitch';
import ShellRail, {
    DeskInstrument, ShellModeSwitch, ShellStatusBar, ShellUtility,
} from './components/shell/ShellRail';
// The Journal pulls recharts + react-virtuoso into its chunk — statically
// importing it put both on the startup path for a surface most users open
// after days of logging. Lazy-once like the other surfaces; the deep-link
// (hash router + openJournal) only mounts it, so Suspense below is enough.
const Journal = React.lazy(() => import('./components/journal/Journal').then(m => ({ default: m.Journal })));
import { useModelCatalogRefresh } from './hooks/useModelCatalogRefresh';

/**
 * Rebuilds a File from a data URL so persisted chart images can be
 * re-dispatched through the vision pipeline (F4 re-run).
 */
const dataUrlToFile = (dataUrl: string, filename: string): File => {
    const commaIdx = dataUrl.indexOf(',');
    const meta = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
    const mime = meta.match(/data:(.*?);/)?.[1] || 'image/png';
    const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const byteString = atob(b64);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
};

/**
 * Suspense fallback for the SURFACE-level lazy screens (TradeView,
 * StrategyStudio, the Agents roster). With fallback={null} the whole surface
 * flashed a blank black/white void for the duration of the chunk fetch
 * (audit: 21× fallback={null}). This is a quiet pulsing zinc panel that
 * matches the dark chrome — no new deps, no layout shift to the real screen.
 */
const SurfaceSkeleton: React.FC = () => (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 bg-zinc-950 p-4" role="status" aria-label="Loading">
        <div className="h-8 w-40 animate-pulse rounded-control bg-zinc-900" />
        <div className="flex-1 animate-pulse rounded-bubble border border-white/[0.06] bg-zinc-900" />
    </div>
);

/** Persisted nav-rail collapse state. Deliberately NOT per-profile: the rail
 *  is a property of the window, not of who is signed into it, and two profiles
 *  on one machine should see the same rail they left behind. The key predates
 *  the separate width key and is kept so an existing collapsed rail survives. */
const NAV_RAIL_KEY = 'nav_rail_width_v1';
/** The dragged width — numeric and separate from the collapse token, so
 *  dragging the rail never expands a collapsed one and collapsing never
 *  forgets the width. */
const NAV_RAIL_WIDTH_KEY = 'nav_rail_expanded_px_v1';
const NAV_RAIL_MIN_PX = 200;
const NAV_RAIL_MAX_PX = 360;

// ─── Backup freshness watchdog ───────────────────────────────────────────────
// `createBackup` catches its own error and returns NULL (BackupService.ts:223-226),
// so a caller's `.catch()` never even fires — a failed backup was invisible.
// The 30-minute scheduler ignores that null too, so the trader's "I have a
// backup every 30 minutes" belief could be wrong for as long as the app ran.
//
// These are the watchdog's own numbers. The cadence is BackupService's
// AUTO_BACKUP_INTERVAL_MS (30 minutes); the grace is one extra round, so a
// single slow write is not an alarm; the repeat is long, because a broken
// cadence does not need re-announcing every 40 minutes.
const BACKUP_CADENCE_MS = 30 * 60 * 1000;
const BACKUP_WATCHDOG_GRACE_MS = 10 * 60 * 1000;
const BACKUP_WATCHDOG_REPEAT_MS = 2 * 60 * 60 * 1000;
const BACKUP_WATCHDOG_EVERY_MS = 2 * 60 * 1000;

/**
 * The Agents surface's model control — provider, model and the thinking dial,
 * subscribed HERE rather than in App's body.
 *
 * `chatStore` latches the username it loaded for on its FIRST touch and rehashes
 * onto a different one the next time it writes. App renders before a profile is
 * chosen, so an App-level `useSyncExternalStore` over that store initialized it
 * against the empty username; the first persist then rehydrated it onto the real
 * one, and the session id the dock had been writing into simply stopped existing
 * — `mutate` no-ops on an unknown id, so a send appended nothing and the run
 * hung behind a bubble that never settled. Mounting this node is what touches
 * the store, and that only happens once the Agents surface is on screen.
 *
 * The snapshot is the tier itself, so the subscription re-renders on a real
 * change and not on every streaming patch of the session store.
 *
 * `showEffort` is handed IN rather than read here because a bot turn answers on
 * the bot's own config through a transport that never reads the dial, and only
 * the surface's own selection knows whether this turn is a bot's (E-51 §2).
 */
const SessionModelChip: React.FC<{
    providers: ProviderConfig[];
    value: string;
    onChange: (value: string) => void;
    onRefreshModels?: () => Promise<void>;
    issue: string | null;
    fallbackLabel?: string;
    showEffort: boolean;
}> = ({ providers, value, onChange, onRefreshModels, issue, fallbackLabel, showEffort }) => {
    const effort = useSyncExternalStore(chatStore.subscribe, chatStore.getActiveEffort, chatStore.getActiveEffort);
    return (
        <ModelChip providers={providers} value={value} onChange={onChange}
            onRefreshModels={onRefreshModels} issue={issue} fallbackLabel={fallbackLabel}
            effort={effort} onEffortChange={chatStore.setActiveEffort} showEffort={showEffort} />
    );
};

const App: React.FC = () => {
    const toast = useToastActions();
    const { confirm: confirmDialog, ConfirmDialogComponent } = useConfirmDialog();

    // UI visibility and progress state (extracted to hooks/useUIState.ts)
    const {
        isUserModalOpen, setIsUserModalOpen,
        isStrategySearchVisible, setIsStrategySearchVisible,
        isSettingsMenuVisible, setIsSettingsMenuVisible,
        isLiveMarketVisible, setIsLiveMarketVisible,
        isVisionDataVisible, setIsVisionDataVisible,


        isLoading, setIsLoading,
        isHybridLoading, setIsHybridLoading,
        isAnalysisInProgress, setIsAnalysisInProgress,
        isSummaryInProgress, setIsSummaryInProgress,
        isInsightGenerating, setIsInsightGenerating,
        isAutoCapturing, setIsAutoCapturing,
        isEntryNotHitCapturing, setIsEntryNotHitCapturing,
        isAutoCaptureBusy, setIsAutoCaptureBusy,
        isEntryNotHitCaptureBusy, setIsEntryNotHitCaptureBusy,
        isRateLimited, setIsRateLimited,
    } = useUIState();
    const [isWatchListVisible, setIsWatchListVisible] = useState(false);
    /** Background-jobs drawer (status-stack pattern). */
    const [isJobsDrawerVisible, setIsJobsDrawerVisible] = useState(false);

    // Lazy-on-demand: only mount the legacy StrategySearch + Analytics side
    // panels once the user opens them at least once. They stay mounted
    // thereafter so the open/close animation is instant on the second open.
    const [isStrategySearchEverOpened, setIsStrategySearchEverOpened] = useState(false);
    React.useEffect(() => {
        if (isStrategySearchVisible) setIsStrategySearchEverOpened(true);
    }, [isStrategySearchVisible]);

    // Provider configuration (API keys, base URLs, custom providers), plus the
    // display/lookup maps derived from that catalog — see useProviderConfigs.
    const {
        configs: providerConfigs,
        isLoaded: providerConfigsLoaded,
        readyProviders,
        modelIdToName,

        handleUpdateProvider,
        handleAddCustomProvider,
        handleRemoveProvider,
        handleToggleProvider: handleToggleProviderConfig,
        handleAddModel,
        handleRemoveModel,
        handleUpdateModel,
    } = useProviderConfigs();

    // Background model-catalog refresh: every dropdown (composer, bots,
    // team seats) stays on the provider's CURRENT model list —
    // a quiet boot + 6h sweep merges freshly discovered ids per provider.
    const { refreshNow: refreshModelCatalog } = useModelCatalogRefresh(providerConfigs, handleUpdateProvider);

    // Dynamic model display map + speaker-name→provider-id map come from
    // `useProviderConfigs` above, because they are derived from the catalog it
    // owns. Co-locating them there is what makes a stale map impossible rather
    // than merely unlikely.

    // Conversation state, derived values, and handlers (extracted to hooks/useConversations.ts)
    const {
        conversationHistory, setConversationHistory,
        activeConversationId, setActiveConversationId,
        activeConversation, messages, messagesRef,
        updateMessages, updateActiveConversation,
        selectedOcrModel,
        moderatorProviderId, moderatorModel,

        handleSetSelectedOcrModel,
        // Revert and versions (2026-10-27). The RULE lives in the conversation
        // store, not in a surface, because one conversation has two readers —
        // this surface and the Chart AI dock — and a revert applied inside only
        // one of them would be undone by the other's next merge.
        revertToMessage, restoreParkedTurns, editMessageText, stepMessageGeneration,
    } = useConversations();


    // UI and other state

    // AI analysis settings (memory, instructions, summarization, lens)
    const {
        globalMemory, setGlobalMemory,
        memoryConfig, setMemoryConfig,
        memoryModel, setMemoryModel,
        isGlobalMemoryEnabled, setIsGlobalMemoryEnabled,
        isStrategiesEnabled, setIsStrategiesEnabled,
        customInstructions, setCustomInstructions,
        isHybridIntelligenceEnabled, setIsHybridIntelligenceEnabled,
        insightKnowledgeBase, setInsightKnowledgeBase,
        activeFrameworks, setActiveFrameworks,
        summaryCharLimit, setSummaryCharLimit,
        summarizationProvider, setSummarizationProvider,
        summarizationModel, setSummarizationModel,
        visionModel, setVisionModel,
        useAlgorithmicSummary, setUseAlgorithmicSummary,
        useAlgorithmicInsights, setUseAlgorithmicInsights,
    } = useAppSettings();

    // The fallback provider. The global moderator picker is gone, and so is
    // the scheduled run that used to name a model of its own; this is now only
    // the last-resort provider for the memory/vision/strategy fallbacks
    // below. Prefer a provider that is not benched (P4 cooldown:
    // ≥3 persisted errors in 15 min).
    const moderatorConfig: ProviderConfig = useMemo(() => {
        const healthy = readyProviders.find(p => !isProviderOnCooldown(p.id));
        if (healthy) return healthy;
        if (readyProviders.length > 0) console.warn('[Fallback model] all providers are on error cooldown — using the first ready one anyway.');
        return readyProviders[0] || {
            id: 'none', name: 'None', apiKey: '', baseUrl: '', apiFormat: 'chat_completions' as const,
            isEnabled: false, isBuiltIn: true, models: [], selectedModel: '',
        };
    }, [readyProviders]);

    // ONE vision model for EVERY vision feature (chart OCR, post-trade
    // uploads, PDF book OCR). Resolution: the globally selected model
    // (Settings → AI setup → Vision Model) → the per-conversation OCR model
    // (legacy, saved conversations) → first ready provider → moderator.
    const visionConfig: ProviderConfig = useMemo(() => {
        if (visionModel) {
            const byGlobal = readyProviders.find(p => p.selectedModel === visionModel || p.models.includes(visionModel));
            if (byGlobal) return byGlobal;
        }
        if (selectedOcrModel) {
            const byConversation = readyProviders.find(p => p.selectedModel === selectedOcrModel || p.models.includes(selectedOcrModel));
            if (byConversation) return byConversation;
        }
        return readyProviders[0] || moderatorConfig;
    }, [readyProviders, visionModel, selectedOcrModel, moderatorConfig]);

    const memoryConfigRef = useRef(memoryConfig);
    memoryConfigRef.current = memoryConfig;
    const readyProvidersRef = useRef(readyProviders);
    readyProvidersRef.current = readyProviders;

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = subscribeMemoryFilesChanged((username) => {
            setMemoryNonce(n => n + 1);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const config = memoryConfigRef.current || readyProvidersRef.current[0] || null;
                void runNotebookReview(username, config).then((wrote) => {
                    if (wrote) {
                        // NOT a misroute, verified: Settings → Memory carries an
                        // "Open the notebook" button (Alt+5) that routes to
                        // Learning → Memory, which is where Suggestions renders. The
                        // signpost is the switches tab, the file is one hop on —
                        // the convention `tests/toolActions.test.tsx` pins.
                        toast.success('Memory reviewed', 'Open Suggestions in Settings → Memory.');
                    }
                }).catch((err) => {
                    console.warn('[MemoryReview] Notebook review failed:', err);
                });
            }, 4000);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [toast]);
    /** Set when another surface asks to open Learning on a SPECIFIC tab
     *  (Settings → "Open the notebook"). LearnView reports it consumed
     *  (onInitialTabConsumed), so it navigates exactly once and the user's own
     *  last tab survives the next mount — same contract as journalTab. */
    const [learnTab, setLearnTab] = useState<LearnTab | null>(null);
    const learnTabConsumed = useCallback(() => setLearnTab(null), []);

    // Surface + URL routing and the journal deep-link — one self-contained
    // cluster, lifted out of this component (handoff 2.1). It owns `useSurface`
    // and needs `setLearnTab` for the #/journal/learning bookmark, which is why
    // it is called after that.
    const {
        surface, setSurface,
        journalTab,
        journalOpenNonce,
        handleSurfaceSelect, openJournal,
    } = useSurfaceRouter({
        isSettingsMenuVisible, setIsSettingsMenuVisible,
        isLiveMarketVisible, setIsLiveMarketVisible,
        isWatchListVisible, setIsWatchListVisible,
        setLearnTab,
    });
    /** The Agents surface's switch: go and talk to the desk WITH the chart.
     *
     *  A route, not a mode. The Agents surface is the thread; the Chart AI
     *  experience lives where the chart is, so the hop lands on the session that
     *  stands in for the conversation being read — otherwise the dock opens on
     *  whichever chat was last used and the two surfaces become two transcripts
     *  wearing one conversation's name. Defined up here because the Alt+6 chord
     *  below reads it during the same render. */
    const openChartAi = useCallback((): void => {
        if (activeConversationId) chatStore.bindConversation(activeConversationId);
        handleSurfaceSelect('trade');
    }, [activeConversationId, handleSurfaceSelect]);
    /** Arriving on either home shows the thread that is ANSWERING.
     *
     *  The pill in each header already routes the deliberate hop through
     *  `openChartAi`, but the nav rail and the Alt+N chords switch surfaces
     *  directly, and a switch that lands on a different thread than the one
     *  still generating is the desync the trader reads as "it stopped answering
     *  over here". Both directions, keyed on the run registries rather than on a
     *  guess: the conversation's own registry for a Chat run, the session's for
     *  a dock run. */
    const hopSurfaceRef = useRef(surface);
    useEffect(() => {
        const from = hopSurfaceRef.current;
        hopSurfaceRef.current = surface;
        if (from === surface) return;
        if (surface === 'trade') {
            if (activeConversationId && chatStore.isConversationRunning(activeConversationId)) {
                chatStore.bindConversation(activeConversationId);
            }
            return;
        }
        if (surface === 'agents') {
            const sess = chatStore.getActiveSession();
            if (sess?.conversationId && chatStore.getSnapshot().running[sess.id]) {
                setActiveConversationId(sess.conversationId);
            }
        }
    }, [surface, activeConversationId, setActiveConversationId]);

    // The Chat ⇄ Chart AI hop is a mode switch, and a mode switch that stops to
    // load a chunk is not one. Each side warms its PARTNER at idle so the press
    // never waits on the network: measured in a real browser, the first hop goes
    // 1680ms → 789ms with the warm-up in place. Only the partner is fetched, not
    // both, because the surface you are looking at is already loading itself.
    // The `import()` specifier matches the surface's own lazy declaration, so the
    // bundler dedupes it to the same chunk rather than a second copy.
    useEffect(() => {
        const load = surface === 'agents'
            ? () => import('./components/trade/TradeView')
            : surface === 'trade'
                ? () => import('./components/agents/AgentsView')
                : null;
        if (!load) return;
        const warm = (): void => { void load(); };
        const idle = window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
            cancelIdleCallback?: (id: number) => void;
        };
        if (idle.requestIdleCallback) {
            const id = idle.requestIdleCallback(warm, { timeout: 2000 });
            return () => idle.cancelIdleCallback?.(id);
        }
        const t = setTimeout(warm, 1200);
        return () => clearTimeout(t);
    }, [surface]);

    /** The Customize rail row's destination: the skill library, which is a tab of
     *  the Learning surface now. It used to open Settings → Skills, and before
     *  that a rail surface — three homes for one library. */
    const openCustomize = useCallback((): void => {
        setLearnTab('skills');
        handleSurfaceSelect('learn');
    }, [handleSurfaceSelect, setLearnTab]);
    // The trade surface's collapsible left panel: the order book, opened and
    // closed from the toggle in the Chart's own market row. Persisted so the
    // layout survives reloads like the dock width.
    const [tradeSidebarOpen, setTradeSidebarOpen] = useState<boolean>(() => {
        try { return localStorage.getItem('trade_sidebar_open_v1') !== '0'; } catch { return true; }
    });
    // Below lg there is no sidebar to toggle — the book is one of the mobile
    // Chart|AI|Book modes owned by TradeView. The icon therefore requests a
    // mode flip (nonce-keyed so a repeat 'book' request still applies)
    // instead of silently mutating a flag nothing reads (audit R6 #4: the
    // old toggle did exactly that on phones).
    const [tradeModeRequest, setTradeModeRequest] = useState<{ mode: TradeMode; n: number } | null>(null);
    const tradeModeReqNRef = useRef(0);
    const lastRequestedTradeModeRef = useRef<TradeMode>('chart');
    const isBelowLgNow = (): boolean => {
        try { return !window.matchMedia('(min-width: 1024px)').matches; } catch { return false; }
    };
    const toggleTradeSidebar = useCallback(() => {
        if (isBelowLgNow()) {
            const next: TradeMode = lastRequestedTradeModeRef.current === 'book' ? 'chart' : 'book';
            lastRequestedTradeModeRef.current = next;
            setTradeModeRequest({ mode: next, n: ++tradeModeReqNRef.current });
            return;
        }
        setTradeSidebarOpen(prev => {
            try { localStorage.setItem('trade_sidebar_open_v1', prev ? '0' : '1'); } catch { /* private mode */ }
            return !prev;
        });
    }, []);
    // Market data state and effects (extracted to hooks/useMarketData.ts)
    const marketData = useMarketData(isHybridIntelligenceEnabled);
    const {
        currentHybridData, setCurrentHybridData,
 setHybridConnectionStatus,
        setLatestMonteCarloResult,
        setLatestBacktestResult,
        setPerAIMonteCarloResults,
        setCurrentSlOptimization,
 setCurrentSuggestedEntryPrice,
        setCurrentEntryTimingScore,
        liveMarketConditions,
        liveMarketSymbol,
    } = marketData;

    // Network status and offline queue
    const { isOnline, wasOffline } = useNetworkStatus();
    const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);

    // Journal and message expansion state
    // (journalState/setJournalState intentionally NOT consumed — the legacy
    // journal overlay is gone; the journal lives on its own surface, and the
    // deep-link tab/trade-id state is declared with the surface block below.)
    const {
        strategyToView, setStrategyToView,
    } = useJournalUI();


    // Refs for functions defined later but needed by useTradeLogging (breaks circular dependency)
    //
    // Typed from the hook that DEFINES the function rather than as
    // `(...args: any[]) => any`. The indirection is still needed — the send
    // path is declared hundreds of lines below the hooks that call it — but the
    // bridge no longer erases the signature: if `handleSendMessage` gains or
    // reorders a parameter, this wrapper stops compiling instead of forwarding
    // the wrong argument at runtime. Deriving from `ReturnType<typeof hook>`
    // also means the two cannot drift apart by hand.
    type SendMessage = ReturnType<typeof useAnalysisPipeline>['handleSendMessage'];
    const handleSendMessageRef = useRef<SendMessage | null>(null);
    const stableHandleSendMessage = useCallback<SendMessage>((...args) => {
        const send = handleSendMessageRef.current;
        // The ref is written during render, further down, on purpose: both
        // functions are declared hundreds of lines after the hooks that need
        // them. So the only way to arrive here with nothing wired is a caller
        // that fires DURING the same render pass — a bug in that caller.
        //
        // Say so, rather than `current?.(...)` behind an `as`. Optional chaining
        // here returns `undefined` typed as the pipeline's real result, so the
        // failure surfaces much later as a confusing property-of-undefined
        // crash in a caller that looks blameless. Throwing costs one branch and
        // removes the cast entirely — the return type is now genuinely the
        // hook's, with nothing asserting otherwise.
        if (!send) {
            throw new Error('handleSendMessage was called before the analysis pipeline was wired');
        }
        return send(...args);
    }, []);

    // ─── Journal auto-refresh ────────────────────────────────────────────
    // Every logged trade (WIN/LOSS/ENTRY_NOT_HIT) re-runs the AI Review
    // (Pattern Memory) automatically instead of waiting for the manual
    // "Regenerate" button. The handler is STABLE (useCallback + latest-ref)
    // so useTradeLogging's memoized callbacks don't re-arm on every App
    // render; the 1.2s debounce collapses rapid multi-trade logging into a
    // single regeneration.
    const journalAutoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const regenerateFinalSummaryRef = useRef<() => void>(() => {});
    const handleJournalAutoRefresh = useCallback(() => {
        if (journalAutoRefreshTimerRef.current) clearTimeout(journalAutoRefreshTimerRef.current);
        journalAutoRefreshTimerRef.current = setTimeout(() => {
            journalAutoRefreshTimerRef.current = null;
            regenerateFinalSummaryRef.current();
        }, 1200);
    }, []);
    useEffect(() => () => {
        if (journalAutoRefreshTimerRef.current) clearTimeout(journalAutoRefreshTimerRef.current);
    }, []);

    // Trade logging state and handlers (extracted to hooks/useTradeLogging.ts)
    // Bound names here are a contract: every one is used, and a test enforces
    // it. Thirteen dead bindings were removed when this surface shrank.
    const {
        loggedTrades, setLoggedTrades,
        tradeSummaries, setTradeSummaries,
        finalTradeSummary, setFinalTradeSummary,
        dataCaptureCandidate, setDataCaptureCandidate,
        entryNotHitCandidate, setEntryNotHitCandidate,
        newlyAddedInsightIds, setNewlyAddedInsightIds,
        confirmAutopilotOutcome,
        confirmAutopilotEntryNotHit,
        handleDataCaptureAuto,
        handleDataCaptureSkip,
        handleInitiateLogTrade,
        trackProposedTrade,
        handleEntryNotHitAutoCapture,
        handleEntryNotHitSkip,
    } = useTradeLogging({
        messages,
        messagesRef,
        updateMessages,
        activeConversationLeverage: activeConversation?.leverage,
        moderatorProviderId,
        moderatorModel,
        memoryModel,
        memoryConfig: memoryConfig || moderatorConfig,
        useAlgorithmicInsights,
        setIsAutoCaptureBusy,
        setIsHybridLoading,
        setIsEntryNotHitCaptureBusy,
        isEntryNotHitCapturing,
        setIsInsightGenerating,
        setCurrentHybridData,
        handleSendMessage: stableHandleSendMessage,
        toast,
        onJournalAutoRefresh: handleJournalAutoRefresh,
    });

    const [leverageInput, setLeverageInput] = useState<string>(String(defaultLeverage()));
    // The three leverage handlers useConversationLeverage used to return are
    // gone: nothing called them. The state stays — the composer and the desk
    // both bind to it — but the hook is pure derivation with no effects, so
    // calling it bought nothing. @typescript-eslint/no-unused-vars had been
    // reporting all three at this line for the life of the file.
    // (i/n) progress for the manual insight-generation loops (App only shows
    // a boolean spinner otherwise; a 50-trade rewrite runs for minutes).
    const [insightProgress, setInsightProgress] = useState<{ done: number; total: number } | null>(null);
    const appRef = useRef<HTMLDivElement>(null);
    // ── Scroll-to-message bridge (audit UI-shell fix, 2026-09-15) ──────────
    // The main transcript lives in the trade surface's Chart AI dock
    // (TradeChatPanel renders a plain scroll container, NOT a Virtuoso), so
    // the old virtuosoRef could never be attached and both scroll affordances
    // were silent no-ops. The dock now registers a scrollToMessage(id)
    // function here on mount (and null on unmount); "Jump to latest
    // analysis" and the gallery's Locate call it. Ids are the chatStore
    // entry ids stamped as `data-message-id` on each rendered entry.
    const scrollToMessageRef = useRef<((messageId: string) => void) | null>(null);
    // A "Show the trade" pressed from another surface can only land the user
    // on Trade — the dock that owns the scroller is not mounted yet. The id
    // parks here and replays once the dock registers.
    const pendingLocateRef = useRef<string | null>(null);
    const registerScrollToMessage = useCallback((fn: ((messageId: string) => void) | null): void => {
        scrollToMessageRef.current = fn;
        if (fn && pendingLocateRef.current) {
            const id = pendingLocateRef.current;
            pendingLocateRef.current = null;
            fn(id);
        }
    }, []);
    // ── Nav rail (D2) ───────────────────────────────────────────────────────
    // The rail is the navigation now: a 56px column that expands to 280px,
    // instead of a drawer the whole surface list was hidden behind.
    //
    // The preference is persisted like every other layout choice, but the
    // window gets the last word: below 1024px there is no room for a 280px
    // panel beside a chart, so the rail is a rail regardless of what the user
    // last chose. That override is applied at RENDER time rather than stored
    // back, so widening the window restores the choice the user actually made
    // instead of leaving it silently overwritten.
    const [isNavRailExpanded, setIsNavRailExpanded] = useState(() => {
        try {
            return localStorage.getItem(NAV_RAIL_KEY) !== 'collapsed';
        } catch { return true; }
    });
    const [isNavViewportNarrow, setIsNavViewportNarrow] = useState(
        () => typeof window !== 'undefined' && window.innerWidth < NAV_RAIL_AUTO_COLLAPSE_PX,
    );
    useEffect(() => {
        const onResize = () => setIsNavViewportNarrow(window.innerWidth < NAV_RAIL_AUTO_COLLAPSE_PX);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    useEffect(() => {
        try { localStorage.setItem(NAV_RAIL_KEY, isNavRailExpanded ? 'expanded' : 'collapsed'); }
        catch { /* private mode */ }
    }, [isNavRailExpanded]);
    // Below NAV_RAIL_AUTO_COLLAPSE_PX the rail is not a column, it is a wall —
    // so a user-OPENED rail at those widths is an overlay instead. Without the
    // second flag the narrow override won whatever the header button did, and
    // "Expand navigation" was rendered, advertised with aria-controls, and did
    // nothing: at 390px the five surfaces were reachable only by Alt+1..5.
    const [isNavOverlayOpen, setIsNavOverlayOpen] = useState(false);
    const isNavRailOpen = isNavRailExpanded && (!isNavViewportNarrow || isNavOverlayOpen);
    const isNavOverlay = isNavViewportNarrow && isNavRailOpen;
    const toggleNavRail = useCallback(() => {
        // Toggle the EFFECTIVE state, not the stored preference: at narrow
        // widths the preference can read `expanded` while the rail is closed.
        const willOpen = !isNavRailOpen;
        if (isNavViewportNarrow) {
            setIsNavOverlayOpen(willOpen);
            if (willOpen) setIsNavRailExpanded(true);
        } else {
            setIsNavRailExpanded(willOpen);
            setIsNavOverlayOpen(false);
        }
    }, [isNavRailOpen, isNavViewportNarrow]);
    // Closing the drawer leaves the stored choice alone, so widening the window
    // puts the rail back where the user left it.
    const closeNavOverlay = useCallback(() => setIsNavOverlayOpen(false), []);
    // The rail's dragged width is shared by both modes — the shell rail and
    // AgentsView's richer column are the same column at the same x — so the
    // mode hop does not restack the content behind a different-width sidebar.
    const railResize = useColumnResize({
        storageKey: NAV_RAIL_WIDTH_KEY,
        defaultWidth: NAV_RAIL_EXPANDED_PX,
        minWidth: NAV_RAIL_MIN_PX,
        maxWidth: NAV_RAIL_MAX_PX,
        edge: 'right',
    });

    // Chart AI dock routing (the Agents surface is gone — roster clicks open
    // sessions inside the trade surface instead). Nonce-keyed so re-clicking
    // the same bot/group re-fires the open effect. The Coach inbox is not
    // routed here any more: it is a Learning tab.
    const [tradeBotRequest, setTradeBotRequest] = useState<{ botId: string; nonce: number } | null>(null);
    const [tradeGroupRequest, setTradeGroupRequest] = useState<{ groupId: string; nonce: number } | null>(null);

    // Casual-chat model (used when ensemble is off): app-wide preference,
    // persisted in Preferences. Empty until loaded or chosen — the pipeline
    // falls back to the first ready provider's model.
    const [selectedChatModel, setSelectedChatModel] = useState(() => {
        try { return localStorage.getItem(PREF_KEYS.CASUAL_CHAT_MODEL) || ''; } catch { return ''; }
    });
    /** The one model-change writer for every chat home: the app-wide default AND
     *  the active session row. The dock and the Agents surface used to each spell
     *  this pair — two statements for one decision, which is how two homes start
     *  answering with different models. (E-51 Phase 2, G-4.) */
    const changeChatSoloModel = useCallback((value: string): void => {
        setSelectedChatModel(value);
        chatStore.setActiveSoloModel(value);
    }, []);
    const chatModelReadyRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        getPreference(PREF_KEYS.CASUAL_CHAT_MODEL).then(v => {
            if (cancelled) return;
            if (v) {
                try { localStorage.setItem(PREF_KEYS.CASUAL_CHAT_MODEL, v); } catch { /* ignore */ }
                setSelectedChatModel(v);
            }
            chatModelReadyRef.current = true;
        });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        if (!chatModelReadyRef.current && !selectedChatModel) return;
        if (selectedChatModel) {
            setPreference(PREF_KEYS.CASUAL_CHAT_MODEL, selectedChatModel);
            try { localStorage.setItem(PREF_KEYS.CASUAL_CHAT_MODEL, selectedChatModel); } catch { /* ignore */ }
        } else if (chatModelReadyRef.current) {
            removePreference(PREF_KEYS.CASUAL_CHAT_MODEL);
            try { localStorage.removeItem(PREF_KEYS.CASUAL_CHAT_MODEL); } catch { /* ignore */ }
        }
    }, [selectedChatModel]);

    // The composer's model selection is provider-qualified
    // (`providerId::modelId`) so a model name offered by TWO providers
    // answers from the one the user actually picked, not whichever provider
    // happened to be scanned first. Migrate the legacy bare-model preference
    // to the qualified form once the provider list exists.
    const chatModelMigratedRef = useRef('');
    useEffect(() => {
        if (!selectedChatModel || selectedChatModel.includes('::')) return;
        if (chatModelMigratedRef.current === selectedChatModel) return;
        if (providerConfigs.length === 0) return;
        chatModelMigratedRef.current = selectedChatModel;
        const owner = providerConfigs.find(c => isProviderReady(c) && c.selectedModel === selectedChatModel)
            ?? providerConfigs.find(c => isProviderReady(c) && c.models.includes(selectedChatModel))
            ?? providerConfigs.find(c => c.selectedModel === selectedChatModel)
            ?? providerConfigs.find(c => c.models.includes(selectedChatModel));
        if (owner) setSelectedChatModel(`${owner.id}::${selectedChatModel}`);
    }, [providerConfigs, selectedChatModel]);

    // ─── Bot Mode — pipeline bridge ────────────────
    // The pipeline is instantiated above the roster state, so it reads the
    // active bot + dispatches replies through refs assigned during render
    // (same pattern as handleSendMessageRef / loggedTradesRef).
    const botThreadStateRef = useRef<{ thread: ThreadSelection; bots: AgentBot[] }>({
        thread: { kind: 'team' },
        bots: [],
    });
    const mailboxRef = useRef<UseBotMailboxResult | null>(null);
    const getActiveBotForPipeline = useCallback(() => {
        const { thread, bots: roster } = botThreadStateRef.current;
        if (thread.kind !== 'bot') return null;
        const bot = roster.find(b => b.id === thread.botId);
        if (!bot) return null;
        return {
            id: bot.id,
            name: bot.name,
            providerId: bot.providerId,
            modelId: bot.modelId,
            systemPrompt: buildBotSystemPrompt(bot, {
                persona: readBotSystemMarkdown(bot.id),
                notes: readBotMemoryMarkdown(bot.id),
                teammates: roster,
            }),
        };
    }, []);
    const handleBotReplyForPipeline = useCallback((messageId: string, rawText: string): void => {
        const { thread, bots: roster } = botThreadStateRef.current;
        if (thread.kind !== 'bot') return;
        const bot = roster.find(b => b.id === thread.botId);
        if (!bot) return;
        // User-initiated turn: its DMs start a fresh chain at hop 0.
        mailboxRef.current?.dispatchFromBotReply(bot, messageId, rawText, 0);
    }, []);

    // Analysis pipeline state, refs, and handlers (extracted to hooks/useAnalysisPipeline.ts)
    const {
        input, setInput,

        // tsc reports this binding as unused; it is NOT. The one function
        // that reads it declares a local `const images` that shadows it, which
        // is why no reference resolves back to this destructure member.
        images, setImages,
        setLoadingMessage,
        currentVisionData,
        handleSendMessage,
        handleCancelAnalysis,
        handleClearChat,
    } = useAnalysisPipeline({
        messages, messagesRef, updateMessages, activeConversation, activeConversationId,
        providerConfigs: readyProviders,
        selectedOcrModel,
        moderatorConfig,
        moderatorModel: moderatorConfig.selectedModel || '',
        memoryConfig,
        finalTradeSummary, loggedTrades, tradeSummaries,
        globalMemory,
        currentHybridData, setCurrentHybridData,
        setLatestMonteCarloResult, setLatestBacktestResult,
        setPerAIMonteCarloResults, setCurrentSlOptimization,
        setCurrentSuggestedEntryPrice, setCurrentEntryTimingScore,
        setHybridConnectionStatus,
        isAnalysisInProgress, setIsAnalysisInProgress,
        isHybridLoading, setIsHybridLoading,
        isRateLimited, setIsRateLimited,
        isGlobalMemoryEnabled, isStrategiesEnabled, customInstructions,
        isHybridIntelligenceEnabled, activeFrameworks,
        selectedChatModel,
        getActiveBot: getActiveBotForPipeline,
        onBotReply: handleBotReplyForPipeline,
        toast,
        confirmDialog,
    });

    // Regime-matched provider win rates for the CURRENT market regime — feeds
    // the lens auto-assign (Team modal) so routing prefers who actually wins
    // in this kind of market, not a blended all-time number.

    // Session-guard verdict (Batch 2): deterministic day-P&L/trade-cap/streak
    // state over the journal — drives the composer banner and is injected
    // into the debate context so the moderator weighs it when grading.

    // The active username, mirrored into a ref so callbacks that outlive the
    // render they were created in still read the CURRENT account. Written from
    // state right after `activeUsername` is destructured below; the initializer
    // is all that exists before that, and nothing reads it in between.
    const activeUsernameRef = useRef<string | null>(sessionStorage.getItem('activeUsername'));

    // Freshest logged-trades array for the callbacks that capture it in a memo
    // or a timer. Several flows call setLoggedTrades and then read the list in
    // the same tick, so a `loggedTrades` closure is stale by the time the work
    // resolves — the ref (updated every render) always holds the latest rows.
    const loggedTradesRef = useRef<LoggedTrade[]>(loggedTrades);
    loggedTradesRef.current = loggedTrades;

    const currentInsightIds = useMemo(() => tradeSummaries.map(s => s.id), [tradeSummaries]);
    // The Send button must never look active when no provider can actually
    // run — a mode toggle can't conjure providers out of thin air (the
    // pipeline toasts "No AI Providers Enabled" on send).

    const familyWinRates = useMemo(() => {
        const stats: Record<string, { total: number; wins: number; winRate: number }> = {
            'Family A': { total: 0, wins: 0, winRate: 0 },
            'Family B': { total: 0, wins: 0, winRate: 0 },
            'Family C': { total: 0, wins: 0, winRate: 0 },
            'Family Omega': { total: 0, wins: 0, winRate: 0 },
        };

        loggedTrades.forEach(trade => {
            if (trade.outcome === TradeOutcome.PENDING || trade.outcome === TradeOutcome.SKIPPED || trade.outcome === TradeOutcome.ENTRY_NOT_HIT) return;

            let family = trade.analysis.detectedPatternFamily;

            if (!family) {
                const pat = (trade.analysis.marketConditions?.pattern || '').toUpperCase();
                if (pat.includes('FAMILY A')) family = 'Family A';
                else if (pat.includes('FAMILY B')) family = 'Family B';
                else if (pat.includes('FAMILY C')) family = 'Family C';
                else if (pat.includes('OMEGA')) family = 'Family Omega';
            }

            let key = '';
            if (family?.toUpperCase().includes('FAMILY A')) key = 'Family A';
            else if (family?.toUpperCase().includes('FAMILY B')) key = 'Family B';
            else if (family?.toUpperCase().includes('FAMILY C')) key = 'Family C';
            else if (family?.toUpperCase().includes('OMEGA')) key = 'Family Omega';

            if (key && stats[key]) {
                stats[key].total++;
                if (trade.outcome === TradeOutcome.WIN) {
                    stats[key].wins++;
                }
            }
        });

        Object.keys(stats).forEach(key => {
            const s = stats[key];
            if (s.total > 0) {
                s.winRate = Math.round((s.wins / s.total) * 100);
            }
        });

        return stats;
    }, [loggedTrades]);

    // ... (useEffects) ...
    useEffect(() => {
        if (activeConversation) {
            setLeverageInput(String(activeConversation.leverage));
        }
    }, [activeConversation?.id, activeConversation?.leverage]);

    // Offline Queue: Sync when coming back online
    useEffect(() => {
        const updateQueueCount = async () => {
            try {
                const count = await offlineQueue.getCount();
                setPendingQueueCount(count);
            } catch (e) {
                console.error('[OfflineQueue] Failed to get queue count:', e);
            }
        };

        // Load initial queue count
        updateQueueCount();

        // When coming back online, process the queue
        if (wasOffline && isOnline) {
            console.log('[OfflineQueue] Back online, processing queued requests...');
            offlineQueue.process({
                onAnalysis: async (payload) => {
                    // Re-dispatch queued analyses with their original charts
                    // (dataURLs persisted at enqueue time). AWAIT the run's
                    // promise: processQueue awaits this callback before it
                    // removes the item, so the queued analysis is only
                    // dropped once the pipeline run actually ENDS — previously
                    // the fire-and-forget call resolved at the first internal
                    // await and the item vanished the moment a run merely
                    // STARTED (audit §2.3).
                    //
                    // Resolving is NOT the same as succeeding. handleSendMessage
                    // catches a failing analysis internally (error bubble / rate
                    // / quota) and resolves with { ok:false }; a bare await
                    // would still dequeue that dead run. Throw on ok:false so
                    // the existing retryCount / exponential-backoff / MAX_RETRIES
                    // path applies instead of silently losing the work.
                    const images = (payload?.images || []).map((url: string, i: number) => ({
                        file: dataUrlToFile(url, `chart-${i + 1}.png`),
                        dataURL: url,
                        isLoading: false,
                    }));
                    const outcome = await handleSendMessage(payload?.prompt || '', images);
                    if (outcome && outcome.ok === false) {
                        throw new Error('Queued analysis replay failed — deferring to the retry/backoff path.');
                    }
                },
                onItemProcessed: () => updateQueueCount(),
                onQueueEmpty: () => setPendingQueueCount(0)
            });
        }
    }, [isOnline, wasOffline, handleSendMessage]);

    // --- AUTOMATIC MEMORY COMPRESSION --- DISABLED to save tokens
    // Thread Memory (Layer 2) is no longer used, so no need to compress chat history
    // useEffect(() => {
    //     const compressMemory = async () => {
    //         if (!activeConversationId || !activeConversation || messages.length === 0) return;
    //         if (messages.length > 5 && messages.length % 8 === 0) {
    //             try {
    //                 const newSummary = await MemoryService.compressChatHistory(messages, activeConversation.threadSummary || '', memoryProvider);
    //                 updateActiveConversation(c => ({
    //                     ...c,
    //                     threadSummary: newSummary
    //                 }));
    //             } catch (e) {
    //                 console.error("Memory compression failed:", e);
    //             }
    //         }
    //     };
    //     compressMemory();
    // }, [messages.length, activeConversationId]);

    const resetAppStateRef = useRef<((usernameToSave?: string | null) => Promise<void>) | null>(null);
    const resetAppState = useCallback((usernameToSave?: string | null) => {
        return resetAppStateRef.current ? resetAppStateRef.current(usernameToSave) : Promise.resolve();
    }, []);

    // User Profile state and handlers (extracted to hooks/useUserProfiles.ts)
    const {
        activeUsername, setActiveUsername,
        existingUsernames, setExistingUsernames,
        saveStatus, setSaveStatus,
        handleImportData,
        handleDeleteUser,
        handleSwitchUser,
        handleExportData,
    } = useUserProfiles({
        resetAppState,
        setIsUserModalOpen,
        setIsSettingsVisible: setIsSettingsMenuVisible,
        toast,
        confirmDialog,
    });



    // Second of the two activeUsernameRef writers (see the declaration for why
    // both exist and what each one serves). This one is the canonical value:
    // every hook called from here down reads it.
    activeUsernameRef.current = activeUsername ?? null;


    // Track the previous active user in a ref mutated by this
    // effect itself. (A render-phase read of activeUsernameRef made
    // `previous` equal the NEW username right after a switch — the
    // cache-clear and backup-stop below never fired, so one user's cached
    // AI responses and 30-min backup scheduler leaked into the next user's
    // session. The ref initializes from the session user so a same-user boot
    // is a no-op.)
    const previousUsernameRef = useRef<string | null>(activeUsernameRef.current);
    useEffect(() => {
        // Legacy migration: delete the AI response-cache IndexedDB left by
        // older builds. Analysis never reads or writes an AI response cache —
        // only tool/data caches (market data, kline, desk tools) remain.
        try { indexedDB.deleteDatabase('august-cache'); } catch { /* no-op */ }
    }, []);
    useEffect(() => {
        const previous = previousUsernameRef.current;
        const current = activeUsername ?? null;
        if (previous !== current) {
            // Stop the old user's backup scheduler; loadUserData starts
            // a fresh one for the new user.
            if (previous !== null) stopAutoBackup();
            // No AI response cache exists to clear (removed). Only tool/data
            // caches remain, which are in-memory and never persist across
            // users or reloads.
        }
        previousUsernameRef.current = current;
    }, [activeUsername]);

    // Final cleanup — stop the auto-backup scheduler when the app unmounts.
    useEffect(() => {
        return () => {
            stopAutoBackup();
        };
    }, []);

    // ─── Command palette (Ctrl/Cmd+K) ─────────────────────────────────────
    // Declared here (before the Esc handler) because the handler gates on
    // these overlay flags.

    // ─── Saved analyses gallery ────────────────────────────────────────────
    // Strategy Studio — the browse/annotate surface for the playbook library.
    // Strategy Studio moved to a surface (useSurface) — no overlay flag.

    // Chat-mode agent roster (extracted to hooks/useAgentThreads.ts):
    // bots/groups state + subscription, thread selection, unread badges,
    // and roster CRUD with confirm dialogs.
    const {
        activeThread, setActiveThread,
        threadOpenedMap,
        bots, groups,
        isNewBotOpen, setIsNewBotOpen,
        isNewGroupOpen, setIsNewGroupOpen,
        groupEditTarget, setGroupEditTarget,
        selectBotThread, selectGroupThread,
        createBot, createGroup, updateGroupMembers,
        deleteBot, deleteGroup,
    } = useAgentThreads({
        activeUsername, setSelectedChatModel, confirmDialog,
    });


    // ─── Groups ARE the debate room (Team/group merge) ─────────────────
    // Opening a group re-arms the ensemble with the room's members
    // (selectGroupThread). Personas ride the MEMBER bots; no separate
    // team store, no seat activation — one room concept.

    // Group runner: one prompt fans out to the members serially.
    const appendGroupMessage = useCallback((msg: Message) => {
        updateMessages(prev => [...prev, msg]);
    }, [updateMessages]);
    const patchGroupMessage = useCallback((id: string, patch: Partial<Message>) => {
        updateMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
    }, [updateMessages]);
    const { workingBotId, isRunning: groupRunning, activity, runGroupThread, cancelRun: cancelGroupRun } = useAgentGroups({
        providerConfigs,
        appendMessage: appendGroupMessage,
        patchMessage: patchGroupMessage,
        username: activeUsername,
        // Hybrid Intelligence room toggle: shares the main hybrid
        // switch — the same live-data gate the debate pipeline uses.
        hybridEnabled: isHybridIntelligenceEnabled,
        // WS-3: room turns teach their speakers too — same write-back the
        // 1:1 mailbox gets (lesson → memory.md, closed trades → evidence).
        loggedTradesRef,
    });
    const toggleGroupHybrid = useCallback(() => {
        setIsHybridIntelligenceEnabled(v => !v);
    }, [setIsHybridIntelligenceEnabled]);
    // ─── Bot Mode — teammate DMs ────────────────────
    // Per-target serial queues; a DM runs the target bot's turn (persona +
    // notes + teammate protocol) and its reply's [[dm:@…]] markers deliver
    // the next hop or wake the sender with a notice. The pipeline bridge
    // (getActiveBotForPipeline / handleBotReplyForPipeline) reads through
    // these refs, which are assigned during render below.
    const mailbox = useBotMailbox({
        bots,
        providerConfigs,
        username: activeUsername,
        messagesRef,
        appendMessage: appendGroupMessage,
        patchMessage: patchGroupMessage,
        // Same live-data gate the rooms use: with Hybrid Intelligence ON,
        // a bot in its own thread reasons over live prices too.
        hybridEnabled: isHybridIntelligenceEnabled,
        // WS-3: bot turns fold closed bot-authored trades back into the
        // shared learning loop (skills + evidence), same as chart AI closes.
        loggedTradesRef,
    });
    mailboxRef.current = mailbox;
    botThreadStateRef.current = { thread: activeThread, bots };
    // Rail working-pulse merge: the group runner owns the pulse first; a
    // draining DM queue shows the (first) busy bot when nothing else runs.
    const dmWorkingBotId = mailbox.dmBusyBotIds[0] ?? null;
    // needs-attention — classify each bot against
    // the live configs + provider health so the rail row says WHY a bot
    // can't work (missing key/model, auth, quota, benched) instead of the
    // user discovering it through a silent failure.
    const attentionMap = useMemo(() => {
        const out: Record<string, string> = {};
        for (const b of bots) {
            const a = classifyBotAttention(b, providerConfigs);
            if (a) out[b.id] = a.hint;
        }
        return out;
    }, [bots, providerConfigs]);
    const sendGroupThread = useCallback((prompt: string) => {
        if (activeThread.kind !== 'group') return;
        const group = groups.find(g => g.id === activeThread.groupId);
        if (group) void runGroupThread(group, prompt, bots);
    }, [activeThread, groups, bots, runGroupThread]);
    // Reply in thread: a direct @everyone round into the SAME room —
    // members' incremental context (lastSeenIndex) already carries the
    // prior thread, so the round continues it in place. Same shape as a
    // new-thread send; GroupChatView gates the affordance on this prop.
    const sendGroupReply = useCallback((prompt: string) => {
        if (activeThread.kind !== 'group') return;
        const group = groups.find(g => g.id === activeThread.groupId);
        if (group) void runGroupThread(group, prompt, bots);
    }, [activeThread, groups, bots, runGroupThread]);
    /** The room view, hoisted so both the Chart AI dock and the Agents surface
     *  render the SAME room from the SAME runners instead of two copies that
     *  can drift. */
    const renderGroupSurface = useCallback((groupId: string): React.ReactNode => {
        const group = groups.find(g => g.id === groupId);
        if (!group) return <p className="p-4 text-ui-dense leading-5 text-zinc-500">This room was deleted.</p>;
        return (
            <React.Suspense fallback={null}>
                <GroupChatView
                    group={group}
                    bots={bots}
                    messages={messages}
                    activity={activity}
                    workingBotId={workingBotId}
                    isRunning={groupRunning}
                    onSendThread={sendGroupThread}
                    onReplyInThread={sendGroupReply}
                    onCancelRun={cancelGroupRun}
                    hybridEnabled={isHybridIntelligenceEnabled}
                    onToggleHybrid={toggleGroupHybrid}
                    onEditGroup={() => {
                        setGroupEditTarget(group);
                        setIsNewGroupOpen(true);
                    }}
                    onDeleteGroup={() => deleteGroup(group.id)}
                />
            </React.Suspense>
        );
    }, [groups, bots, messages, activity, workingBotId, groupRunning, sendGroupThread,
        sendGroupReply, cancelGroupRun, isHybridIntelligenceEnabled, toggleGroupHybrid,
        setIsNewGroupOpen, deleteGroup]);
    // The verdict whose Entry/SL/TP the chart draws: the newest row that settled
    // a plan. Keyed on the proposal a tool turn stamps on its own row, with the
    // legacy analysis field as the fallback for pre-debate history.
    const chartVerdict = useMemo(() => latestChartVerdict(messages), [messages]);

    // Esc cancels an in-progress analysis (including the debate phase). Never
    // fires while the user is typing in an input/textarea/contenteditable, and
    // never while an overlay is open — overlays close themselves on Esc (their
    // own keydown handlers), and one Esc must not both close an overlay AND
    // cancel a running analysis.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const target = e.target as HTMLElement | null;
            const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
            if (isTyping) return;
            const anyOverlayOpen = isSettingsMenuVisible || isLiveMarketVisible || isUserModalOpen || isVisionDataVisible || isStrategySearchVisible || isWatchListVisible;
            if (anyOverlayOpen) {
                // Overlays with their own document-level Esc handlers
                // (SettingsMenu, command palette, Journal, LiveMarket, dialogs)
                // close themselves. Close the gate-owned overlays here so one
                // Esc never both closes an overlay AND cancels a running
                // analysis — but never cancels while anything is open.
                if (isVisionDataVisible) setIsVisionDataVisible(false);
                if (isStrategySearchVisible) setIsStrategySearchVisible(false);
                if (isWatchListVisible) setIsWatchListVisible(false);
                return;
            }
            if (isAnalysisInProgress) {
                handleCancelAnalysis();
                toast.info('Analysis cancelled', 'Anything it had already produced stays in the chat.');
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [isAnalysisInProgress, handleCancelAnalysis, toast, isSettingsMenuVisible, isLiveMarketVisible, isUserModalOpen, isVisionDataVisible, isStrategySearchVisible, isWatchListVisible]);

    // ─── View model reasoning (Think tab deep link) ────────────────────────
    // Opens the Trading Journal's Think tab focused on the reasoning records
    // of the clicked analysis card. The reasoning set is keyed by the
    // analysis createdAt, so resolve it via the card (message) id.

    // ─── Saved analyses gallery ────────────────────────────────────────────
    const handleLocateMessage = useCallback((messageId: string) => {
        const index = messages.findIndex(m => m.id === messageId);
        if (index >= 0) {
            scrollToMessageRef.current?.(messageId);
        }
    }, [messages]);

    // The Agents composer's Stop names its target, because App cannot guess
    // it: two bots can stream at once (a user turn plus an autonomous DM)
    // and a first-match abort kills the wrong one. The press routes to the
    // pipeline, a dock run, or the bot whose composer was used.
    const handleStopAgentsRun = useCallback((target?: { kind: 'analysis' } | { kind: 'dock'; conversationId: string } | { kind: 'bot'; botId: string }) => {
        if (!target || target.kind === 'analysis') {
            if (isAnalysisInProgress) handleCancelAnalysis();
            return;
        }
        if (target.kind === 'bot') mailboxRef.current?.cancelDmTurn(target.botId);
        else if (target.kind === 'dock') chatStore.abortConversationRun(target.conversationId);
    }, [isAnalysisInProgress, handleCancelAnalysis]);

    // The model's watches and the trade-plan level hits subscribe HERE, on
    // the surface that never unmounts — but only for the OS ping: the
    // harness RECORD is queued by the services themselves at the moment the
    // state is deleted or latched, so no trigger's record can depend on any
    // component being mounted (the review's zero-listener class).
    useEffect(() => {
        const unwatch = watchService.subscribe((fired) => {
            if (fired.expired) return; // a lapse is recorded in the thread; an OS banner for it is noise
            const w = fired.watch;
            const cond = w.kind === 'price'
                ? `${w.symbol} ${w.condition} ${w.price}${fired.price !== null ? ` (now ${fired.price})` : ''}`
                : `${w.symbol} scheduled re-check is due`;
            void notify('Chart AI watch fired', `${cond} — ${w.note}`, { tag: w.id });
        });
        const unlevel = levelWatch.subscribe((hit, plan) => {
            void notify(`${plan.symbol} ${hit.label} hit`, `${hit.label} @ ${hit.price} reached (mark ${hit.hitPrice}). Chart AI is reviewing the plan.`, { tag: hit.levelId });
        });
        return () => { unwatch(); unlevel(); };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Ctrl/Cmd+, opens Settings — the platform convention the activity
            // rail advertises in its tooltip. It was advertised but never
            // bound, so the kbd hint was a dead affordance.
            if ((e.ctrlKey || e.metaKey) && e.key === ',') {
                e.preventDefault();
                setIsSettingsMenuVisible(true);
            }
            // Ctrl/Cmd+B collapses and expands the nav rail. Matches the reference
            // clients, and is checked BEFORE the Ctrl+B that the rich-text
            // surfaces would otherwise claim — nothing else in this app binds
            // it, but the composer does contain a focusable text field.
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                toggleNavRail();
            }
            // Ctrl/Cmd+Shift+E steps the composer's thinking tier (E-51 ruling
            // D-B). It fires ONLY while a panel with an Effort section is on
            // screen, and the key hint beside that label is printed in the same
            // commit for the same reason: a chord bound where nothing shows the
            // result is a key that lies about what it changes. A panel session
            // and a bot turn render no dial, so neither answers to this — see
            // components/shared/effortDial.ts.
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && effortDialUp() && e.key.toLowerCase() === 'e') {
                e.preventDefault();
                chatStore.setActiveEffort(nextEffortTier(chatStore.getActiveEffort()));
            }
            // Alt+1..5 jumps the nav-rail surfaces (Minara nav; Alt keeps
            // the browser/Electron Ctrl+number tab-switching intact).
            const SURFACE_KEYS: Record<string, AppSurface> = {
                '1': 'trade', '2': 'journal', '4': 'agents', '5': 'learn',
            };
            if (e.altKey && !e.ctrlKey && !e.metaKey && SURFACE_KEYS[e.key]) {
                e.preventDefault();
                handleSurfaceSelect(SURFACE_KEYS[e.key]);
            }
            // Alt+3 is deliberately NOT deleted with the Skills surface: the
            // chord is muscle memory for "my skill library", and the library
            // still exists — it is the Skills SETTINGS tab now. A key that goes
            // silently missing is the worse outcome.
            // chord is muscle memory for "my skill library", and the library
            // still exists — it is the Skills tab of the Learning surface now.
            // A key that goes silently missing is the worse outcome.
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === '3') {
                e.preventDefault();
                openCustomize();
            }
            // Alt+6 takes the Agents surface's question to the chart. Scoped to
            // that surface: on any other one the chord would move something the
            // user cannot see, and a key that silently does nothing is worse
            // than one that is not bound — so it does not even preventDefault
            // elsewhere.
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === '6' && surface === 'agents') {
                e.preventDefault();
                openChartAi();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [handleSurfaceSelect, setIsSettingsMenuVisible, toggleNavRail, surface]);



    // True once the ACTIVE profile's data has actually loaded. Owned here
    // because the autosave below is constructed before the loader further
    // down, and both must agree: data may only be written for a profile that
    // loaded. A load that throws used to adopt the username anyway, and the
    // debounced autosave then wrote stale (or empty) state over that profile.
    const profileReadyRef = useRef(false);

    // Profile persistence (extracted to hooks/useProfilePersistence.ts):
    // heavy DATA save, light SETTINGS save, mid-run heartbeat, unload flush.
    useProfilePersistence({
        activeUsername, activeConversationId, setSaveStatus, toast, profileReadyRef,
        conversationHistory, loggedTrades, tradeSummaries,
        finalTradeSummary, globalMemory, insightKnowledgeBase,
        memoryConfig, memoryModel,
        isAnalysisInProgress,
        activeFrameworks, summaryCharLimit, summarizationProvider, summarizationModel,
        visionModel, isGlobalMemoryEnabled, isStrategiesEnabled,
        customInstructions,
        isHybridIntelligenceEnabled, isAutoCapturing,
        isEntryNotHitCapturing, useAlgorithmicSummary, useAlgorithmicInsights,
    });


    // --- ACCURACY MODE THEME HANDLER ---
    // Maintain consistent dark theme regardless of mode
    useEffect(() => {
        if (appRef.current) {
            // Remove all legacy theme classes and use consistent dark theme
            appRef.current.classList.remove('bg-zinc-950', 'bg-[#000000]', 'bg-[#000000]');
            appRef.current.classList.add('bg-zinc-950');
        }
    }, []);



    // The lens/ensemble settings are gone; delete the keys an older build left
    // behind so no setting the app cannot explain survives the upgrade.
    useEffect(() => { void stripRemovedAppSettings(); }, []);

    // The Agents desk is NOT seeded. Nothing here creates bots any more, so a
    // fresh profile opens on the empty rail AgentsView already renders and an
    // agent exists only because the trader made one. The built-in Macro,
    // Technical and Risk analysts were removed by owner ruling: a roster the
    // app invents is not a chat the trader chose, and an effect that rewrites a
    // named bot model from a Settings picker they never pressed is worse.

    // ToolForge + memory amendments: models can PROPOSE mid-debate; the
    // user only sees them in Settings, so surface each arrival as a toast
    // (the tool result already tells the model it landed as a candidate).
    useEffect(() => {
        const onForged = (e: Event): void => {
            const d = (e as CustomEvent<{ id?: string; name?: string }>).detail;
            toast.warning('New tool proposal', `${d?.name ?? 'A model'} proposed a desk tool — approve or retire it in Settings → Skills → Forged tools.`);
        };
        const onAmendment = (e: Event): void => {
            const d = (e as CustomEvent<{ id?: string; fileName?: string }>).detail;
            toast.warning('Memory correction proposed', `${d?.fileName ?? 'A file'} was flagged by a model — review it in Settings → Memory.`);
        };
        window.addEventListener(FORGED_PROPOSAL_EVENT, onForged);
        window.addEventListener(AMENDMENT_EVENT, onAmendment);
        return () => {
            window.removeEventListener(FORGED_PROPOSAL_EVENT, onForged);
            window.removeEventListener(AMENDMENT_EVENT, onAmendment);
        };
    }, [toast]);

    // Quota flagging UI never materialized (the old quotaExceededModels state
    // was set but never read by any component) — keep the callback for the
    // modal plumbing; quota errors surface via the OCR error state instead.
    const handleQuotaExceeded = useCallback((_modelId: string) => {
        // Intentional no-op.
    }, []);

    // Update ref for useTradeLogging (breaks circular dependency)
    handleSendMessageRef.current = handleSendMessage;


    // ... (handleAssistantChat remains unchanged) ...

    const handleLiveMarketAnalyze = (data: string) => {
        setIsLiveMarketVisible(false);
        setInput(data); // PREFILL INPUT, DO NOT SEND IMMEDIATELY
    };

    const handleUpdateSummaryCharLimit = (limit: number) => setSummaryCharLimit(limit);


    // Journal CRUD handlers (extracted to hooks/useTradeJournalActions.ts)
    const {
        handleDeleteTrades,
        handleClearAllTrades,
        handleManualInsightsUpdate,
        handleUpdateTradeLeverage,
        handleUpdateTradeType,
        handleUpdateTradeOutcome,
        handleUpdateTradePnL,
        handleRegenerateFinalSummary,
    } = useTradeJournalActions({
        loggedTrades, setLoggedTrades,
        tradeSummaries, setTradeSummaries,
        finalTradeSummary, setFinalTradeSummary,
        loggedTradesRef, activeUsernameRef,
        confirmDialog, toast,
        handleJournalAutoRefresh, regenerateFinalSummaryRef,
        isSummaryInProgress, setIsSummaryInProgress,
        setInsightProgress, setNewlyAddedInsightIds,
        memoryConfig, moderatorConfig, readyProviders,
        useAlgorithmicInsights, summaryCharLimit,
    });

    // Conversation housekeeping (extracted to hooks/useConversationHousekeeping.ts):
    // create/load/delete sessions, edit user messages, Ctrl+N + "/" shortcuts.
    const {

        handleNewConversation,
        handleLoadConversation,

        handleDeleteConversationFromSidebar,

    } = useConversationHousekeeping({
        conversationHistory, setConversationHistory,
        activeConversation, activeConversationId, setActiveConversationId,
        updateMessages, handleCancelAnalysis,
        confirmDialog, toast,
    });

    // F3: New conversation (Ctrl/Cmd+N shortcut + palette action).
    // Reuse an existing blank session instead of minting another empty one —
    // "New" from a filled session should return to the unused blank tab.



    const confirmAutopilotRef = useRef<(messageId: string) => void>(() => {});

    // Watch list + outcome autopilot (extracted to hooks/useWatchAndAutopilot.ts):
    // pinned-signal derivations and handlers, autopilot registration and
    // resolutions, and the deferred watch-list actions.
    const {
        autopilotResolutions, setAutopilotResolutions,
        handleToggleWatch,
        watchedSignals,
        watchOpenR,

        handleOpenWatchedSignal,
        handleConfirmAutopilot,
        runWatchListAction,
        handleDismissAutopilot,
    } = useWatchAndAutopilot({
        messages, conversationHistory, loggedTrades,
        activeConversationId, activeConversation, updateMessages, messagesRef,
        stableHandleSendMessage, handleLoadConversation,
        setIsWatchListVisible,
        confirmAutopilotOutcome, confirmAutopilotEntryNotHit, handleInitiateLogTrade,
        confirmAutopilotRef, toast,
    });

    /** Drives the dock's Pin chip. The flag lives on the Message, so a chat
     *  entry is pinable only through the analysis message id the bridge
     *  stamped on it (TradeChatPanel's data-message-id). */
    const pinnedMessageIds = useMemo(
        () => new Set(messages.filter(m => m.watched).map(m => m.id)),
        [messages],
    );

    const handleStartNewConversation = handleNewConversation;

    // Stable handler identities — plain arrow functions here were recreated
    // every render, defeating the chatContext memo and re-rendering every
    // visible transcript row on each stream chunk / keystroke.
    const handleApplyStrategy = useCallback((strategyName: string) => {
        if (!activeFrameworks.includes(strategyName)) {
            setActiveFrameworks(prev => [...prev, strategyName]);
        }
    }, [activeFrameworks]);

    const handleRemoveStrategy = (strategyName: string) => {
        setActiveFrameworks(prev => prev.filter(s => s !== strategyName));
    };

    // F4: "Re-run debate" — re-dispatches the original prompt + chart images
    // through the normal pipeline so the user gets a fresh debate for the
    // same setup (also the missing retry path for failed analyst slots).
    // Shared by the manual Re-run button and price-triggered setup watches.
    // Failed-run retry: rebuild the exact prompt + charts from the user
    // message the failed run was sent with (the error bubble carries its id).
    // ── Chart AI dock bridges ─────────────────────────────────────────────
    // "Full analysis" from the trade chat: run the SAME pipeline the Chat
    // surface runs, resolve with the verdict summary so the dock shows the
    // answer in its own transcript.
    // "Log this trade" from a Chart AI proposal → append a PENDING analysis
    // message. The outcome autopilot (useWatchAndAutopilot) registers it and
    // scores it against the real outcome, so a chat-proposed trade is tracked
    // like any other logged position.
    //
    // It awaits the gate stamp before writing anything. The plan's card and the
    // level-watch appear instantly (present_trade starts the scan and does not
    // wait), but the JOURNAL ROW is the one place a probability becomes a record,
    // so the cap has to be known here — and if the scan could not be measured,
    // logging fails CLOSED: an explicit confirm, a row stamped `gate:unavailable`,
    // and never a fabricated confidenceCap of 0.
    const handleLogProposedTrade = useCallback(async (proposal: TradeProposal): Promise<boolean> => {
        const gate = await ensureStamp(proposal, loggedTrades);
        const stamped: TradeProposal = { ...proposal, gate };
        if (gate.refusal) {
            // The card disables its own button, but a schedule, a replayed row
            // or a stale transcript can still reach this writer. The refusal is
            // the trader's own floor or an impossible plan, never a caution.
            toast.error('Plan refused by the gate', gate.refusal);
            return false;
        }
        if (gate.status === 'unavailable') {
            const ok = await confirmDialog({
                title: 'The gate could not be checked',
                message: `${gate.reason}. Logging now records this plan UNCAPPED, stamped gate:unavailable — its probability is NOT measured against fresh data.`,
                confirmLabel: 'Log without gate check',
                destructive: true,
            });
            if (!ok) return false;
        }
        // A Full analysis that called no market tool gets an amber notice on
        // its transcript row. Logging the plan is a second, durable claim, so
        // the warning must bind once: the trader acknowledges it here.
        const unverified = messages.some(m =>
            m.proposal?.planId === proposal.planId
            && (m.liveToolEvents?.desk ?? '').includes('NOTHING LOOKED UP'));
        if (unverified) {
            const ok = await confirmDialog({
                title: 'This plan was not checked against the tape',
                message: 'The Full analysis called no market tool before presenting this plan. Logging it records numbers the model did not look up. Log it anyway?',
                confirmLabel: 'Log unverified plan',
                destructive: true,
            });
            if (!ok) return false;
        }
        // planId dedupe, keyed on the JOURNAL ROW (`LoggedTrade.planId`) and
        // the pending card's own field — never on the headline string. The
        // dock's per-card map stops a double-click on one card; re-presenting
        // the same plan from another surface used to mint a byte-identical
        // second card because the only trace of the plan was prose.
        const duplicate = !!stamped.planId
            && (loggedTrades.some(t => t.planId === stamped.planId)
                || messages.some(m => m.planId === stamped.planId));
        if (duplicate) {
            // A prior attempt may have written the PENDING row/message but
            // failed to register the tracker. Retry registration for that
            // pending receipt; a settled plan needs nothing.
            const pendingReceipt = messages.find(m =>
                m.planId === stamped.planId && m.outcome === TradeOutcome.PENDING);
            if (pendingReceipt) {
                const tracked = await trackProposedTrade(pendingReceipt);
                if (!tracked.ok) {
                    toast.error('Could not track this trade', tracked.error);
                    return false;
                }
            }
            return true;
        }

        // The plan's own answer row carries the model and run identity, so the
        // accepted receipt copies them instead of arriving bare.
        const presenting = [...messages].reverse().find(m => m.role === MessageRole.AI && m.modelsUsed);
        const pendingReceipt = buildProposedTradeMessage(stamped, `proposed-${Date.now()}`, presenting);
        updateMessages(prev => [...prev, pendingReceipt]);
        // "Track this trade" writes the PENDING journal row and registers the
        // tracker. The receipt is already in the transcript; a failure keeps
        // the card live and leaves the PENDING row for the retry above.
        const tracked = await trackProposedTrade(pendingReceipt);
        if (!tracked.ok) {
            toast.error('Could not track this trade', tracked.error);
            return false;
        }
        return true;
    }, [updateMessages, loggedTrades, confirmDialog, messages, trackProposedTrade, toast]);

    /** The dock holds a settled verdict's message id, not a copy of the
     *  analysis — a persisted chat session would otherwise store a whole
     *  `TradeAnalysis` per answer. This lets it resolve the backing on demand.
     *  Memoised because `TradeChatPanel` is `React.memo`: an inline arrow would
     *  hand it a new prop on every App pass. */
    const getAnalysisMessage = useCallback(
        (messageId: string): Message | undefined => messages.find(m => m.id === messageId),
        [messages],
    );

    /** The instrument the active chat session is bound to. Both surfaces pass
     *  this into the analysis so a coin picker means something: the pipeline
     *  otherwise reads the coin out of the prompt TEXT, so selecting ETH and
     *  typing a question that names no coin would fetch nothing. Text still
     *  wins when it names one — the picker says where you are looking, not
     *  what to analyse. */
    const activeInstrument = useCallback((): { symbol?: string; interval?: string } => {
        const snap = chatStore.getSnapshot();
        const s = snap.sessions.find(x => x.id === snap.activeId);
        return s?.symbol || s?.interval ? { symbol: s.symbol, interval: s.interval } : {};
    }, []);

    /**
     * ONE analysis entry, for both chat homes.
     *
     * The Chart AI dock used to run with the scheduler's private-run option,
     * which sent the run into a message list built here, so a Full analysis
     * started on the chart never appeared in the Agents surface's thread or the
     * rail's list. The Agents surface ran on the active conversation instead.
     * Two entries for one feature is how the two homes ended up showing
     * different answers to the same question, so there is now one: the run
     * writes the active conversation, which is the thread `entriesForSession`
     * already feeds the dock.
     *
     * Resolves when the run ENDS and throws with the reason when it never
     * started or ended without a verdict — neither has a transcript row to
     * carry it, which is why both surfaces route this to a toast.
     */
    const handleRunAnalysisFromChat = useCallback(async (prompt: string, chatImages: Array<{ name: string; dataURL: string }>, fullAnalysis = false): Promise<void> => {
        if (isAnalysisInProgress) throw new Error('an analysis is already running — wait for it or stop it first');
        if (readyProviders.length === 0) throw new Error('no AI providers are configured');
        // Bind before the run: the session that stands for this conversation is
        // what the dock renders, and it only merges the conversation's rows
        // once that link exists. A chart-side session with a transcript of its
        // own is not blank, so this mints the conversation's session and makes
        // it active — the analysis lands where the Agents surface can see it, and
        // the earlier chart-only chat stays in the rail as itself.
        if (activeConversationId) chatStore.bindConversation(activeConversationId);
        const images: ImageMetadata[] = chatImages.map(img => ({
            file: new File([], img.name, { type: 'image/png' }),
            dataURL: img.dataURL,
            isLoading: false,
        }));
        const outcome = await handleSendMessage(prompt, images, undefined, {
            ...activeInstrument(),
            reasoningEffort: chatStore.getActiveEffort(),
            // Stamped by the CALLER that means it (the dock's Full-analysis
            // button), never guessed from the prompt text — 20c deleted the
            // wording gate, so intent has to travel as data.
            fullAnalysis,
        });
        // `ok:false` is the pipeline's own "this attempt produced no completed
        // analysis" verdict (rate limit, quota, a pre-run block). `ok:true`
        // covers a finished run AND a deliberate stop, and a stop is not a
        // failure worth reporting.
        if (!outcome?.ok) throw new Error('the analysis ended without a verdict (rate limit, quota, or a pre-run block)');
    }, [isAnalysisInProgress, readyProviders, handleSendMessage, activeConversationId]);



    /** The canonical conversation for whichever bot the dock is bound to, as
     *  rows, recomputed whenever `messages` changes.
     *
     *  This is what makes a bot session in the dock a VIEW of the conversation
     *  rather than a copy taken when it was opened: a turn said in the Chat
     *  surface appears in an already-open dock session with nothing to click.
     *
     *  It rides `tradeBotRequest` — the bot the trader last pushed into the
     *  dock — because App is the scope that holds `messages` and re-renders
     *  when it changes. There is deliberately no second copy of this selection
     *  anywhere: a filter here that disagreed with the Chat rail's would be a
     *  filter that decides who owns a message, twice. */
    const tradeBotThread = useMemo(() => {
        const botId = tradeBotRequest?.botId;
        if (!botId) return [];
        const b = bots.find(x => x.id === botId);
        if (!b) return [];
        return threadForProvider(messages, b.providerId, b.modelId, b.id);
    }, [tradeBotRequest, bots, messages]);

    /** A bot turn asked in the Chart AI dock, committed to the conversation
     *  that owns it.
     *
     *  The dock is a VIEW of `messages` (see `entriesForSession` in
     *  `services/trade/chatSessions.ts`), and a view cannot write. So the turn
     *  had to be committed here, and until
     *  it was, a question asked in Chart AI produced an answer the Chat
     *  surface could not see — the trader switched surfaces and found the
     *  exchange had never happened.
     *
     *  Both rows go in, because the dock's composer writes into the chat
     *  session, not the conversation: unlike the Agents surface, the trader's own
     *  line is NOT already there waiting to be claimed. The answer is stamped
     *  `botId` + `modelsUsed`, which is what lets `threadForProvider` claim the
     *  pair as this bot's thread, and what keeps it out of the desk pane —
     *  one stamp, both behaviours, and no second opinion about ownership.
     *
     *  `answer === undefined` is the trader's question; a string is the settled
     *  answer. Two calls rather than one, so the question is visible in the
     *  other surface while it is still being answered.
     */
    const commitDockBotTurn = useCallback((bot: AgentBot, prompt: string, answer?: string, workedMs?: number, effort?: ReasoningEffort): void => {
        const at = new Date().toISOString();
        const row: Message = answer === undefined
            ? { id: `dbu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: MessageRole.USER, text: prompt, createdAt: at }
            : {
                id: `dba-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                role: MessageRole.AI,
                text: answer,
                createdAt: at,
                modelsUsed: { [bot.providerId]: bot.modelId },
                botId: bot.id,
                // The work time the dock's own block measured, committed onto the
                // message so the Agents surface's collapsed block shows the same
                // "Analyzed for Ns" this dock row did — and so it survives a
                // reload. Without it the Chat rail's runStats is the only source
                // and a dock-native answer shows no duration there.
                ...(typeof workedMs === 'number' ? { runStats: { runId: `dock-${bot.id}-${Date.now()}`, startedAt: at, finishedAt: at, durationMs: workedMs, ...(effort ? { effort } : {}) } } : {}),
            };
        updateMessages(prev => [...prev, row], activeConversationId ?? null);
    }, [updateMessages, activeConversationId]);

    /** A solo (desk) turn asked in the Chart AI panel, committed into the
     *  conversation that owns it — under the entry's OWN id.
     *
     *  `commitDockBotTurn` mints fresh ids because a bot's question has no local
     *  row to match. A solo turn does: the panel is already painting this exact
     *  bubble, and `entriesForSession` merges by id. Reusing the id is what makes
     *  one turn ONE row in both homes — a new id here would append a second
     *  answer to the pane that just wrote it.
     *
     *  Deliberately un-stamped: no `botId`, no `modelsUsed`. A desk answer is the
     *  desk's, and `deskThread` drops only rows a bot positively owns. */
    const commitSoloChatTurn = useCallback((
        row: SoloTurnRow,
        conversationId: string,
    ): void => {
        const at = new Date().toISOString();
        // What a mirrored desk turn OWNS on the row. The trace rides under the
        // answering provider's key — the same key the Agents surface's own live
        // writer uses — so one turn is one paragraph, not two.
        const live = (createdAt: string): Partial<Message> => ({
            isStreaming: !!row.streaming,
            ...(row.reasoning ? { thoughtProcesses: { [row.speakerKey ?? 'desk']: row.reasoning } } : {}),
            ...(row.tools ? { toolEvents: row.tools } : {}),
            ...(row.toolIds ? { toolIds: row.toolIds } : {}),
            ...(row.error ? { error: row.error } : {}),
            ...(typeof row.workedMs === 'number'
                ? { runStats: { runId: `desk-${row.id}`, startedAt: createdAt, finishedAt: createdAt, durationMs: row.workedMs, ...(row.effort ? { effort: row.effort } : {}) } }
                : {}),
        });
        updateMessages(prev => {
            const idx = prev.findIndex(m => m.id === row.id);
            if (idx < 0) {
                return [...prev, {
                    id: row.id,
                    role: row.role === 'user' ? MessageRole.USER : MessageRole.AI,
                    text: row.text,
                    createdAt: at,
                    ...(row.role === 'ai' ? live(at) : {}),
                }];
            }
            // UPSERT, never replace. The dock's mirror writes this row every
            // ~200ms while the turn runs, and a field another writer owns —
            // the analysis, the planId receipt, an attached image — must
            // survive the next patch. Only the mirrored fields move.
            return prev.map((m, i) => (i === idx
                ? { ...m, text: row.text, ...(row.role === 'ai' ? live(m.createdAt ?? at) : {}) }
                : m));
        }, conversationId);
    }, [updateMessages]);

    /** Adopt (or mint) the conversation a Chart AI solo turn speaks into, and
     *  point the Agents surface at it.
     *
     *  A dock session started on the Trade screen had no conversation at all, so
     *  nothing said there could ever appear in the Agents surface — the two homes
     *  were two transcripts wearing one app. Every solo turn now resolves to a
     *  thread first: the session's own binding if it still exists, else the
     *  unused blank conversation the housekeeping reuses for "New chat", else a
     *  fresh one. Making it ACTIVE is the other half of the sync: the thread you
     *  are typing in is the thread the other home shows. */
    const ensureDockTurnConversation = useCallback((conversationId?: string): string | null => {
        if (conversationId && conversationHistory.some(c => c.id === conversationId)) {
            if (conversationId !== activeConversationId) setActiveConversationId(conversationId);
            return conversationId;
        }
        const reusable = findReusableEmptyConversation(conversationHistory, activeConversationId);
        // A blank thread is only reusable if nothing is ANSWERING in it. The
        // pipeline registers its run under the conversation id BEFORE the
        // trader's row lands, so a thread can be empty and still mid-run — and
        // adopting it would put two writers on one answer, which is the very
        // desync this callback exists to remove.
        if (reusable && !chatStore.isConversationRunning(reusable.id)) {
            if (reusable.id !== activeConversationId) {
                setConversationHistory(prev => [
                    { ...reusable, timestamp: Date.now() },
                    ...prev.filter(c => c.id !== reusable.id),
                ]);
                setActiveConversationId(reusable.id);
            }
            return reusable.id;
        }
        const newConv = createNewConversation();
        if (activeConversation) {
            newConv.ocrModel = activeConversation.ocrModel;
            newConv.leverage = activeConversation.leverage;
        }
        setConversationHistory(prev => [newConv, ...prev]);
        setActiveConversationId(newConv.id);
        return newConv.id;
    }, [conversationHistory, activeConversationId, setActiveConversationId, activeConversation, setConversationHistory]);

    // ─── Stable identities for overlay/panel callbacks ─────────────────────
    // Inline arrows here were recreated on every App render, busting
    // React.memo on ChatArea/Journal and rebuilding ChatArea's
    // enhancedContext (re-rendering every memoized transcript row) on each
    // keystroke / progress tick even when nothing relevant changed.
    const handleCloseJournal = useCallback(() => {
        setSurface('trade');
    }, [setSurface]);

    // Settings → Journal's launcher cards route to the JOURNAL SURFACE.
    // They used to call a handler that re-opened Settings at its own Journal
    // tab — a launcher loop the audit caught (the surface was never reachable
    // from Settings). One route now, the same one every other affordance uses.
    const handleOpenJournal = useCallback((tab: JournalUIState['tab'] = 'log') => {
        openJournal(tab);
    }, [openJournal]);

    const handleOpenLiveMarket = useCallback(() => {
        setIsLiveMarketVisible(true);
    }, []);

    // ─── Outcome Autopilot ────────────────────────────────────────────────
    // Register PENDING analyses for automatic SL/TP detection; resolutions
    // surface in the chat via chatContext for inline one-click confirmation.

    const {
        loadUserData,
        resetAppState: userProfileResetAppState,
    } = useUserProfileLoader({
        handleCancelAnalysis,
        providerConfigs,
        setConversationHistory,
        setActiveConversationId,
        setLoggedTrades,
        setTradeSummaries,
        setFinalTradeSummary,
        setGlobalMemory,
        setIsGlobalMemoryEnabled,
        setMemoryConfig,
        setMemoryModel,
        setInsightKnowledgeBase,
        setActiveFrameworks,
        setSummaryCharLimit,
        setSummarizationProvider,
        setSummarizationModel,
        setVisionModel,
        setUseAlgorithmicSummary,
        setUseAlgorithmicInsights,
        setIsStrategiesEnabled,
        setCustomInstructions,
        setIsHybridIntelligenceEnabled,
        setIsAutoCapturing,
        setIsEntryNotHitCapturing,
        setAutopilotResolutions,
        setInput,
        setImages,
        setIsLoading,
        setActiveUsername,
        setExistingUsernames,
        setIsUserModalOpen,
        toast,
        profileReadyRef,
    });
    resetAppStateRef.current = userProfileResetAppState;

    const [skillDraftNonce, setSkillDraftNonce] = useState(0);
    /** Bumped on any notebook write — the Agents rail's per-bot learning stats
     *  read the notebook, so they refresh with it rather than every price tick. */
    const [memoryNonce, setMemoryNonce] = useState(0);
    useEffect(() => {
        const bump = (): void => setSkillDraftNonce(n => n + 1);
        window.addEventListener('august-skill-drafts', bump);
        return () => window.removeEventListener('august-skill-drafts', bump);
    }, []);
    const approvalItems = useMemo(
        () => collectApprovalItems(messages, autopilotResolutions, activeUsername || undefined),
        [messages, autopilotResolutions, skillDraftNonce, activeUsername],
    );
    // ─── Coach thread ───────────────────────────────────────────────
    // The learning loop's inbox as a conversation: pending skill drafts +
    // queue proposals. The badge counts both; the panel refreshes itself on
    // the same window events, so App only needs the count + selection.
    const [learningQueueNonce, setLearningQueueNonce] = useState(0);
    useEffect(() => {
        const bump = (): void => setLearningQueueNonce(n => n + 1);
        window.addEventListener('august-learning-queue', bump);
        return () => window.removeEventListener('august-learning-queue', bump);
    }, []);
    const coachCount = useMemo(
        () => approvalItems.filter(i => i.kind === 'skill').length
            + listLearningProposals(activeUsername || undefined).length,
        [approvalItems, learningQueueNonce, activeUsername],
    );
    // Per-bot learning stats for the Agents rail (WS-3.4). Walks the notebook,
    // so it is keyed to notebook writes and the roster — not to price ticks.
    const botStats = useMemo(() => loadBotLearningStats(), [bots, memoryNonce]);
    // One number for one meaning: the union of every queue the Learning surface
    // hosts — the notebook's pending drafts, proposals and amendments, plus the
    // permissions the harness is asking for. A skill draft appears in
    // approvalItems too, so it is counted once, from the store — not twice
    // because two surfaces happened to list it.
    const approvalsWaiting = useMemo(() => {
        const permissions = approvalItems.filter(i => i.kind !== 'skill').length;
        return countPendingEverything(activeUsername || 'default') + permissions;
    }, [approvalItems, activeUsername, skillDraftNonce, learningQueueNonce, memoryNonce]);
    // Surface-menu badges. Memoized because App re-renders on every price tick
    // and both Header and SurfaceMenuList are React.memo'd — a fresh object
    // literal would invalidate the memo once a second for nothing.
    const navBadges = useMemo<Partial<Record<AppSurface, NavBadge>>>(() => {
        const next: Partial<Record<AppSurface, NavBadge>> = {};
        // The group runner owns the working pulse; a draining DM queue counts
        // too (the roster rail already read it this way — the rail didn't).
        const working = workingBotId ?? dmWorkingBotId;
        if (working) {
            next.agents = { active: true, detail: 'a bot is working' };
        }
        if (isInsightGenerating) {
            next.journal = {
                active: true,
                detail: insightProgress
                    ? `summarizing ${insightProgress.done}/${insightProgress.total} trades`
                    : 'generating insights',
            };
        }
        // The number rides the surface that HOLDS the queues. It used to sit on a
        // separate Approvals row in the rail — one destination, two rows, the same
        // count twice on one screen. The Chat sidebar does carry a "Coach inbox"
        // row now, because the menu that was its only entry point was removed, but
        // it is a route with no number: this badge stays the single figure.
        if (approvalsWaiting > 0) {
            next.learn = {
                count: approvalsWaiting,
                detail: `${approvalsWaiting} decision${approvalsWaiting === 1 ? '' : 's'} waiting`,
            };
        }
        return next;
    }, [workingBotId, dmWorkingBotId, isInsightGenerating, insightProgress, activeUsername, skillDraftNonce, learningQueueNonce, approvalsWaiting]);
    const selectTeamThread = useCallback(() => setActiveThread({ kind: 'team' }), []);
    // One shell rail, two modes. A conversation row, New chat and Search all
    // land on the desk's focused form (Agents); the dock is the same thread
    // with the chart beside it, reached by the mode switch.
    const [agentsSearchRequest, setAgentsSearchRequest] = useState(0);
    const openDeskConversation = useCallback((id: string) => {
        handleLoadConversation(id);
        selectTeamThread();
        setSurface('agents');
    }, [handleLoadConversation, selectTeamThread, setSurface]);
    const startDeskChat = useCallback(() => {
        handleStartNewConversation();
        selectTeamThread();
        setSurface('agents');
    }, [handleStartNewConversation, selectTeamThread, setSurface]);
    const requestDeskSearch = useCallback(() => {
        setAgentsSearchRequest(n => n + 1);
        setSurface('agents');
    }, [setSurface]);
    const consumeAgentsSearchRequest = useCallback(() => setAgentsSearchRequest(0), []);
    const coachAllowDraft = useCallback((draft: SkillDraft): void => {
        void approveSkillDraft(draft, activeUsername || 'default', loggedTradesRef.current)
            .then(r => { const t = skillApprovalToast(r, draft.crafted.name); toast[t.kind](t.title, t.body); });
    }, [activeUsername]);
    const coachDenyDraft = useCallback((draft: SkillDraft): void => {
        const taken = takeSkillDraft(draft.id, activeUsername || undefined);
        if (!taken) {
            toast.warning('Draft not discarded', 'It is still in your inbox — retry, or approve it there.');
            return;
        }
        tombstoneSkillDraftKey(
            draftTriggerKey(draft.coin, draft.crafted),
            activeUsername || undefined,
        );
        toast.success('Skill discarded', 'Similar suggestions paused for 7 days');
    }, [activeUsername]);
    // Roster clicks route into the Chart AI dock (the Agents surface is gone).
    // Declared after the thread selectors above so their useCallback
    // identities exist at first read.
    const openBotInTrade = useCallback((id: string) => {
        selectBotThread(id);
        setTradeBotRequest({ botId: id, nonce: Date.now() });
        setSurface('trade');
    }, [selectBotThread, setSurface]);
    const openGroupInTrade = useCallback((id: string) => {
        selectGroupThread(id);
        setTradeGroupRequest({ groupId: id, nonce: Date.now() });
        setSurface('trade');
    }, [selectGroupThread, setSurface]);
    /** The Coach inbox merged into the Learning surface, so a coach hop names the
     *  tab rather than opening a dock session. */
    const renderCoachInbox = useCallback(() => (
        <React.Suspense fallback={null}>
            <CoachThreadPanel onAllowDraft={coachAllowDraft} onDenyDraft={coachDenyDraft} />
        </React.Suspense>
    ), [coachAllowDraft, coachDenyDraft]);
    /** The one inbox. The nav rail's Approvals row and every "open the Coach"
     *  affordance land here, so a decision has exactly one address. */
    const openApprovalsInLearn = useCallback(() => {
        setLearnTab('coach');
        setSurface('learn');
    }, [setSurface]);
    // Skill-citation chip tap: open Settings → Skills so the
    // Skill-citation chip tap: open the Strategy Studio surface so it mounts
    // and consumes the pending slug (Studio listens for the same event when
    // already open). The Settings → Skills tab is now just a pointer here.
    useEffect(() => {
        const onOpenSkill = (): void => {
            // The library is the Learning surface's Skills tab, so this lands
            // there — the same destination as the Customize row and Alt+3, not a
            // third one.
            openCustomize();
        };
        window.addEventListener('august:open-skill', onOpenSkill);
        return () => window.removeEventListener('august:open-skill', onOpenSkill);
    }, [openCustomize]);

    // "Try in chat" from the Studio or the learning queue: the dock reads the
    // hand-off itself (see skillDeepLink), but on Learning nothing would show the
    // result, so App does the travelling.
    useEffect(() => {
        const onTrySkill = (): void => setSurface('trade');
        window.addEventListener('august:try-skill', onTrySkill);
        return () => window.removeEventListener('august:try-skill', onTrySkill);
    }, []);


    useWatchSideEffects({
        messagesRef,
        setConversationHistory,
        setAutopilotResolutions,
        toast,
        confirmAutopilot: confirmAutopilotRef,
        activeUsername,
    });

    // WS-2.1: the supervisor's listeners + startup sweep live at App level —
    // a session that never opens the Trade dock still self-governs its queues.
    useSupervisorBootstrap(activeUsername);

    // The four scheduled passes used to fire once, from the profile load, so
    // they only ran when the app was opened. App level for the same reason as
    // the supervisor above: the loop belongs to the session, not to whichever
    // surface happens to be mounted.
    useLearningHeartbeat(activeUsername, loggedTrades);


    // F6: best-effort backup when the desktop app closes — the unload flush
    // protects the DB, but a fresh snapshot guards against IndexedDB
    // eviction/corruption between the 30-minute auto-backups. Throttled to
    // once per 10 minutes so quick relaunches don't churn backup files.
    const lastExitBackupRef = useRef(0);
    useEffect(() => {
        const onBeforeUnload = () => {
            if (typeof window.electronAPI === 'undefined') return;
            if (Date.now() - lastExitBackupRef.current < 10 * 60 * 1000) return;
            lastExitBackupRef.current = Date.now();
            if (activeUsernameRef.current) {
                // Best-effort: IndexedDB transactions started in beforeunload
                // usually complete in Chromium, and a failed write is
                // non-fatal — the 30-minute auto-backup is the real safety
                // net. But it is NOT silent: `createBackup` swallows its own
                // error and resolves to null, so the null IS the failure
                // signal and it used to be dropped on the floor here.
                // The window is closing, so a toast is not an option — the
                // console is the signal, and it names what was lost.
                void createBackup(activeUsernameRef.current)
                    .then((metadata) => {
                        if (metadata) return;
                        console.error(
                            '[App] Exit backup FAILED — the last journal snapshot was NOT written. '
                            + 'The most recent auto-backup is the only copy on disk.',
                        );
                    })
                    .catch((err) => {
                        console.error(
                            '[App] Exit backup FAILED — the last journal snapshot was NOT written. '
                            + 'The most recent auto-backup is the only copy on disk.',
                            err,
                        );
                    });
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    // ── Backup freshness watchdog ───────────────────────────────────────────
    // A failed backup used to produce NO signal at all: `createBackup` returns
    // null on failure and the 30-minute scheduler ignores that null, so the
    // trader believed they had a backup cadence and learned the truth only
    // when they needed a restore. This watches the one signal the backup
    // store already publishes — the newest backup's timestamp — and says so
    // out loud when the cadence stops.
    //
    // It NEVER writes anything: it is a watchdog, not a backup, so it cannot
    // double the cadence or change what lands on disk.
    useEffect(() => {
        if (!activeUsername) return;
        let cancelled = false;
        // When the current grace window opened, and how long it is.
        let watchingSince = Date.now();
        let graceMs = BACKUP_CADENCE_MS + BACKUP_WATCHDOG_GRACE_MS;
        // The newest backup seen so far. Zero means "none yet".
        let newestBackupAt = 0;

        const check = async (): Promise<void> => {
            let backups: BackupMetadata[];
            try {
                backups = await getBackups(activeUsername);
            } catch {
                return; // the backup store is unreadable — the watchdog is best-effort
            }
            if (cancelled) return;
            const newest = backups.reduce(
                (max, b) => Math.max(max, Date.parse(b.timestamp) || 0),
                0,
            );
            if (newest > newestBackupAt) {
                // A backup landed — the cadence is alive. Re-arm the window.
                newestBackupAt = newest;
                watchingSince = Date.now();
                graceMs = BACKUP_CADENCE_MS + BACKUP_WATCHDOG_GRACE_MS;
                return;
            }
            if (Date.now() - watchingSince < graceMs) return;
            // A whole round (plus slack) passed with nothing written.
            watchingSince = Date.now();
            graceMs = BACKUP_WATCHDOG_REPEAT_MS;
            toast.error(
                'Auto-backup has not run',
                'No new backup has been written for over 40 minutes, so the last snapshot on disk may be out of date. Open Settings → Data to back up now.',
            );
        };

        void check();
        const id = window.setInterval(() => { void check(); }, BACKUP_WATCHDOG_EVERY_MS);
        return () => { cancelled = true; window.clearInterval(id); };
    }, [activeUsername, toast]);




    /** Shared approval handlers — the Inbox modal AND the
     *  inline cards in the chat flow both route through these. */
    const approvalHandlers = useMemo(() => ({
        allow: (item: ApprovalItem): void => {
            if (item.kind === 'skill') {
                // Read the draft WITHOUT consuming it: the old path took it off
                // the queue first, so a write that silently declined destroyed
                // the trader's only copy and still said "Skill saved".
                const draft = listSkillDrafts(activeUsername || undefined)
                    .find(d => d.id === item.id);
                if (!draft) return;
                void approveSkillDraft(draft, activeUsername || 'default', loggedTrades)
                    .then(r => { const t = skillApprovalToast(r, draft.crafted.name); toast[t.kind](t.title, t.body); });
                return;
            }
            handleConfirmAutopilot(item.messageId);
        },
        deny: (item: ApprovalItem): void => {
            if (item.kind === 'skill') {
                const draft = takeSkillDraft(item.id, activeUsername || undefined);
                if (draft) {
                    tombstoneSkillDraftKey(
                        draftTriggerKey(draft.coin, draft.crafted),
                        activeUsername || undefined,
                    );
                    toast.success('Skill discarded', 'Similar suggestions paused for 7 days');
                } else {
                    toast.warning('Draft not discarded', 'It is still in your inbox — retry, or approve it there.');
                }
                return;
            }
            handleDismissAutopilot(item.messageId);
        },
        always: (item: ApprovalItem): void => {
            if (item.coin) setAutoJournalRule(item.coin, 'always', activeUsername || undefined);
            handleConfirmAutopilot(item.messageId);
        },
        never: (item: ApprovalItem): void => {
            if (item.coin) setAutoJournalRule(item.coin, 'deny', activeUsername || undefined);
            handleDismissAutopilot(item.messageId);
        },
    }), [activeUsername, loggedTrades, handleConfirmAutopilot, handleDismissAutopilot, toast]);

    const renderActionApprovals = useCallback(() => (
        <React.Suspense fallback={null}>
            <ActionApprovalsPanel
                items={approvalItems}
                onAllow={approvalHandlers.allow}
                onDeny={approvalHandlers.deny}
                onAlways={approvalHandlers.always}
                onNever={approvalHandlers.never}
                onOpen={(item) => {
                    // The dock owns the only transcript scroller, and it
                    // registers its bridge on mount — so from another surface
                    // this parks the row and locates it once the dock has
                    // mounted; calling the bridge there would be a null deref
                    // that silently scrolls nothing.
                    const dockIsMounted = surface === 'trade';
                    setSurface('trade');
                    if (dockIsMounted) handleLocateMessage(item.messageId);
                    else pendingLocateRef.current = item.messageId;
                }}
            />
        </React.Suspense>
    ), [approvalItems, approvalHandlers, surface, handleLocateMessage, setSurface]);




    // The title bar's status cluster, built ONCE. Every surface now has exactly
    // one bar: Analyze/Journal/Learning get the band — moved INSIDE the content
    // column so the sidebar runs the full height, the reference's silhouette —
    // and the Agents surface keeps its own header row, which is why this travels
    // as a node rather than markup only `shared/Header` can reach. The collapsed
    // rail's expand button is deliberately NOT a node: each bar renders
    // `NavExpandButton` from the callbacks it already holds, because an
    // interactive-root element parked in a local variable gets attributed to
    // whichever component holds it, and `App` is not a button wrapper.
    const shellNavSwitch = useMemo(
        () => (
            <SurfaceSwitch
                surface={surface}
                onSelect={(next) => {
                    // Chat → Trade is not a plain route: it must carry THIS
                    // conversation into the Chart AI dock, which is what the
                    // ChatModePill used to do before the switch absorbed it.
                    // Drop this and the dock silently opens on its own last
                    // session — render-probe's "the dock draws the same decision
                    // cards as the thread" check is what catches it.
                    if (next === 'trade' && surface === 'agents') { openChartAi(); return; }
                    handleSurfaceSelect(next);
                }}
                badges={navBadges}
            />
        ),
        [surface, handleSurfaceSelect, openChartAi, navBadges],
    );
    /** The rail's mode switch: Analyze and Agents are the same desk, so the
     *  chat → chart hop keeps its carry-over rule here too. */
    const shellModeSwitch = useMemo(
        () => (
            <ShellModeSwitch
                surface={surface}
                onSelect={(next) => {
                    if (next === 'trade' && surface === 'agents') { openChartAi(); return; }
                    handleSurfaceSelect(next);
                }}
            />
        ),
        [surface, handleSurfaceSelect, openChartAi],
    );
    const shellUtilities = useMemo(
        () => (
            <ShellUtility
                surface={surface}
                onSelect={handleSurfaceSelect}
                onOpenCustomize={openCustomize}
                badges={navBadges}
            />
        ),
        [surface, handleSurfaceSelect, openCustomize, navBadges],
    );
    /** What the content bar is about. The rail names the workspace; this names
     *  the thing being worked on. */
    const shellTitle = surface === 'journal'
        ? 'Journal'
        : surface === 'learn'
            ? 'Learning'
            : (activeConversation?.title?.trim() || 'Desk');
    // Memoized because Header is memoized on purpose: a fresh element on every
    // price tick would re-render the whole bar for a label that has not moved.
    const shellContext = useMemo(
        () => (surface === 'trade' ? <DeskInstrument /> : undefined),
        [surface],
    );
    const shellStatus = useMemo(() => (
        <StatusCluster
            saveStatus={saveStatus}
            isOnline={isOnline}
            onOpenActivity={() => setIsJobsDrawerVisible(true)}
            activityOpen={isJobsDrawerVisible}
        />
    ), [saveStatus, isOnline, isJobsDrawerVisible]);

    /** One read of "the chat's model pick is unusable", shared by the Chat
     *  surface's model chip (which colours itself amber) and its banner. */
    const chatModelFallback = useMemo(() => {
        const f = computeChatModelFallback(providerConfigs, selectedChatModel);
        return {
            issue: f.issue ?? null,
            providerName: f.provider?.name,
            // The banner needs BOTH halves: a warning that cannot name a
            // provider has nothing to tell the user.
            notice: f.issue && f.provider ? { issue: f.issue, provider: f.provider } : null,
        };
    }, [providerConfigs, selectedChatModel]);

    return (
        // Outer Suspense boundary. fallback={null} so a suspending lazy
        // subtree (e.g. a modal opening) does NOT blank the always-visible
        // chat/header. Per-component Suspense wrappers below isolate suspends.
        <React.Suspense fallback={null}>
        <div ref={appRef} className="flex flex-col bg-zinc-950 text-zinc-100 font-sans h-full overflow-hidden">
            {/* Custom confirm dialog + undo toast (replaces window.confirm) */}
            {ConfirmDialogComponent}

            {/* Desktop auto-update overlay (Electron only).
                Renders null in the browser and whenever no update is in
                progress, so it's a safe no-op outside Electron. */}
            <React.Suspense fallback={null}>
                <UpdateOverlay />
            </React.Suspense>
            <UserProfileManager isVisible={isUserModalOpen} isLoading={isLoading} onUserSelect={loadUserData} existingUsers={existingUsernames} onImportProfile={handleImportData} onDeleteUser={handleDeleteUser} onClose={() => setIsUserModalOpen(false)} />
            {/* Mounted only while the overlay is open: LiveMarket now runs the
                app's shared live feed (a combined futures socket PLUS a kline
                socket), so leaving the panel mounted-but-hidden would hold two
                sockets and a REST poller open for the whole session. The panel
                returns null on !isVisible anyway, so nothing it can see
                changes — it just stops paying for it while it is closed. */}
            {isLiveMarketVisible && (
                <LiveMarket isVisible onClose={() => setIsLiveMarketVisible(false)} onAnalyze={handleLiveMarketAnalyze} />
            )}
            {dataCaptureCandidate && (
                <DataCaptureModal
                    message={dataCaptureCandidate.message}
                    outcome={dataCaptureCandidate.outcome}
                    onClose={() => setDataCaptureCandidate(null)}
                    onAutoCapture={handleDataCaptureAuto}
                    onSkip={handleDataCaptureSkip}
                    isCapturing={isAutoCaptureBusy}
                />
            )}
            {entryNotHitCandidate && (
                <EntryNotHitCaptureModal
                    message={entryNotHitCandidate.message}
                    correctedEntry={entryNotHitCandidate.correctedEntry}
                    onClose={() => setEntryNotHitCandidate(null)}
                    onAutoCapture={handleEntryNotHitAutoCapture}
                    onSkip={handleEntryNotHitSkip}
                    isCapturing={isEntryNotHitCaptureBusy}
                />
            )}
            {/* Per-component Suspense: isolates a suspending lazy overlay from
                the rest of the app. fallback={null} — these overlays mount at
                boot, so their chunks preload during startup; a visible
                full-screen fallback here caused a triple overlay flash on
                every launch. */}
            <React.Suspense fallback={null}>
            <SettingsMenu
                isVisible={isSettingsMenuVisible}
                onClose={() => setIsSettingsMenuVisible(false)}
                onOpenLearn={(tab) => { setLearnTab(tab ?? null); setSurface('learn'); setIsSettingsMenuVisible(false); }}
                summaryCharLimit={summaryCharLimit}
                onUpdateSummaryCharLimit={handleUpdateSummaryCharLimit}
                useAlgorithmicSummary={useAlgorithmicSummary}
                onToggleAlgorithmicSummary={setUseAlgorithmicSummary}
                useAlgorithmicInsights={useAlgorithmicInsights}
                onToggleAlgorithmicInsights={setUseAlgorithmicInsights}
                onSwitchUser={handleSwitchUser}
                onExportData={handleExportData}
                username={activeUsername || undefined}
                onProfileRestored={(restoredUsername) => { loadUserData(restoredUsername); }}
                isHybridIntelligenceEnabled={isHybridIntelligenceEnabled}
                setIsHybridIntelligenceEnabled={setIsHybridIntelligenceEnabled}
                isAutoCapturing={isAutoCapturing}
                onToggleAutoCapturing={() => setIsAutoCapturing(!isAutoCapturing)}
                isEntryNotHitCapturing={isEntryNotHitCapturing}
                onToggleEntryNotHitCapturing={() => setIsEntryNotHitCapturing(!isEntryNotHitCapturing)}
                isStrategiesEnabled={isStrategiesEnabled}
                setIsStrategiesEnabled={setIsStrategiesEnabled}
                memoryConfig={memoryConfig}
                onMemoryConfigChange={(config) => {
                    setMemoryConfig(config);
                    setMemoryModel(config?.selectedModel || '');
                }}
                customInstructions={customInstructions}
                setCustomInstructions={setCustomInstructions}
                providerConfigs={providerConfigs}
                providerConfigsLoaded={providerConfigsLoaded}
                selectedOcrModel={selectedOcrModel}
                onSetOcrModel={handleSetSelectedOcrModel}
                visionModel={visionModel}
                onSetVisionModel={setVisionModel}
                visionConfig={visionConfig}
                onUpdateProvider={handleUpdateProvider}
                onAddCustomProvider={handleAddCustomProvider}
                onRemoveProvider={handleRemoveProvider}
                onToggleProviderConfig={handleToggleProviderConfig}
                onAddModel={handleAddModel}
                onRemoveModel={handleRemoveModel}
                onUpdateModel={handleUpdateModel}
                loggedTrades={loggedTrades}
                onOpenJournal={handleOpenJournal}
            />
            </React.Suspense>
            <VisionDataViewer isVisible={isVisionDataVisible} onClose={() => setIsVisionDataVisible(false)} visionData={currentVisionData} />

            {/* The band is no longer here. It renders as the first child of
                <main>, so the sidebar runs the full height of the window the way
                the reference's does and the title bar belongs to the content
                column instead of cutting across both. */}


            {/* The old Journal OVERLAY was removed (navigation rewired to the
                journal surface): the live render is the embedded branch in
                <main> below — do not re-add an overlay or journalState-style
                plumbing. */}

            <React.Suspense fallback={null}>
            {isStrategySearchEverOpened && (
                <StrategySearch isVisible={isStrategySearchVisible} onClose={() => { setIsStrategySearchVisible(false); setStrategyToView(null); }} onApplyStrategy={handleApplyStrategy} onRemoveStrategy={handleRemoveStrategy} providerConfig={readyProviders[0] || moderatorConfig} activeFrameworks={activeFrameworks} defaultFrameworks={DEFAULT_FRAMEWORKS} initialViewStrategy={strategyToView} onQuotaExceeded={handleQuotaExceeded} familyWinRates={familyWinRates} />
            )}
            </React.Suspense>
            <React.Suspense fallback={null}>
                <WatchListPanel
                    isVisible={isWatchListVisible}
                    onClose={() => setIsWatchListVisible(false)}
                    signals={watchedSignals}
                    activeConversationId={activeConversationId}
                    autopilotResolutions={autopilotResolutions}
                    onToggleWatch={handleToggleWatch}
                    onLogTrade={(messageId, outcome, conversationId) => runWatchListAction(conversationId, { type: 'log', messageId, outcome })}
                    onOpenSignal={handleOpenWatchedSignal}
                    onConfirmAutopilot={(messageId, conversationId) => runWatchListAction(conversationId, { type: 'autopilot', messageId })}
                />
            </React.Suspense>
            {/* Activity drawer — the app's autonomous work that still exists:
                each skill's latest detached-eval verdict. Scheduled automations
                were removed on 2026-10-24. */}
            <React.Suspense fallback={null}>
                <JobsDrawer
                    open={isJobsDrawerVisible}
                    onClose={() => setIsJobsDrawerVisible(false)}
                />
            </React.Suspense>
            {/* The trader's half of ask_user_input: a seat that parked its turn on
                a question renders here, above the composer, in BOTH homes. It owns
                no state of its own — the channel does. */}
            <AskUserInputCard />


            {/* The shell: one navigation column beside the content, the way the
                reference draws it. The rail is the full height of the window and
                owns every route; the content bar names the thing being worked
                on. On the Agents surface the column is AgentsView's own richer
                sidebar, which carries the same mode switch and utility rows, so
                a mode hop moves the content and not the chrome. */}
            <div className="flex-1 flex flex-row min-h-0">
                {surface !== 'agents' && isNavRailOpen && (
                    <ShellRail
                        surface={surface}
                        onSelectSurface={handleSurfaceSelect}
                        onNewChat={startDeskChat}
                        onOpenApprovals={openApprovalsInLearn}
                        approvalsCount={approvalsWaiting}
                        onOpenSearch={requestDeskSearch}
                        conversations={conversationHistory}
                        activeConversationId={activeConversationId}
                        onOpenConversation={openDeskConversation}
                        onDeleteConversation={handleDeleteConversationFromSidebar}
                        onClearConversation={(id) => { void handleClearChat(id); }}
                        onOpenCustomize={openCustomize}
                        activeUsername={activeUsername}
                        onOpenSettings={() => setIsSettingsMenuVisible(true)}
                        width={railResize.width}
                        isResizing={railResize.isResizing}
                        onResizeStart={railResize.startResize}
                        onResizeReset={railResize.resetWidth}
                        onCollapse={toggleNavRail}
                        overlay={isNavOverlay}
                        onCloseOverlay={closeNavOverlay}
                    />
                )}
                {/* Surfaces: pages, not modals. */}
                <main className="flex-1 flex flex-col min-h-0 min-w-0 relative bg-zinc-950">
                    {/* The content bar. The rail owns navigation; this bar names
                        what is being worked on and carries the live state. On
                        Agents, AgentsView's own bar is this bar — rendering a
                        second one above it stacked two titles for one screen. */}
                    {surface !== 'agents' && (
                        <Header
                            saveStatus={saveStatus}
                            isAnalysisInProgress={isAnalysisInProgress}
                            currentVisionData={currentVisionData}
                            surface={surface}
                            isOnline={isOnline}
                            pendingQueueCount={pendingQueueCount}
                            liveMarketConditions={liveMarketConditions}
                            liveMarketSymbol={liveMarketSymbol}
                            onOpenActivity={() => setIsJobsDrawerVisible(true)}
                            onOpenLiveMarket={handleOpenLiveMarket}
                            onOpenVisionData={() => setIsVisionDataVisible(true)}
                            hasVisionData={currentVisionData.length > 0}
                            status={shellStatus}
                            title={shellTitle}
                            context={shellContext}
                            surfaceSwitch={isNavRailOpen ? undefined : shellNavSwitch}
                            onExpandNavRail={isNavRailOpen ? undefined : toggleNavRail}
                        />
                    )}

                    {/* The first-run onboarding card used to sit here as a
                        centered banner, but it ate ~50% of the Analyze surface
                        width. The same nudge now lives inside the Chart AI
                        dock's composer card (see TradeChatPanel) so it shows
                        up exactly where the user needs to take action. */}

                    {surface === 'trade' && (
                            <React.Suspense fallback={<SurfaceSkeleton />}>
                                <TradeView
                                    memoryEnabled={isGlobalMemoryEnabled}
                                    strategiesEnabled={isStrategiesEnabled}
                                    providers={providerConfigs}
                                    selectedChatModel={selectedChatModel}
                                    onSelectChatModel={setSelectedChatModel}
                                    onRefreshModels={refreshModelCatalog}
                                    sidebarOpen={surface === 'trade' && tradeSidebarOpen}
                                    onToggleSidebar={toggleTradeSidebar}
                                    modeRequest={tradeModeRequest ?? undefined}
                                    activeUsername={activeUsername ?? undefined}
                                    onTradeModeChange={(m) => { lastRequestedTradeModeRef.current = m; }}
                                    onOpenChat={() => handleSurfaceSelect('agents')}
                                    /* The same two handlers the Chat rail gets, so
                                       the dock is the Chat's compact form rather
                                       than a reduced one: it can open a room and
                                       the Coach inbox, not just list rooms. */
                                    botThreadRows={tradeBotThread}
                                    onBotTurnCommit={commitDockBotTurn}
                                    onSoloTurnCommit={commitSoloChatTurn}
                                    onSyncConversation={ensureDockTurnConversation}
                                    conversationRows={messages}
                                    onNewGroup={() => setIsNewGroupOpen(true)}
                                    onOpenCoach={openApprovalsInLearn}
                                    coachCount={coachCount}
                                    verdict={chartVerdict}
                                    bots={bots}
                                    trades={loggedTrades}
                                    groups={groups.map(g => ({ id: g.id, name: groupDisplayName(g, bots) }))}
                                    botSessionRequest={tradeBotRequest ?? undefined}
                                    groupSessionRequest={tradeGroupRequest ?? undefined}
                                    onRunAnalysis={(prompt, images) => handleRunAnalysisFromChat(prompt, images, true)}
                                    onAnalysisError={(message) => toast.error(message)}
                                    onStopRun={handleCancelAnalysis}
                                    getAnalysisMessage={getAnalysisMessage}
                                    onLogProposedTrade={handleLogProposedTrade}
                                    registerScrollToMessage={registerScrollToMessage}
                                    onToggleWatch={handleToggleWatch}
                                    onOpenWatchList={() => setIsWatchListVisible(true)}
                                    watchOpenCount={watchedSignals.filter(s => !s.outcome || s.outcome === TradeOutcome.PENDING).length}
                                    watchOpenR={watchOpenR}
                                    pinnedMessageIds={pinnedMessageIds}
                                    renderGroupSurface={renderGroupSurface}
                                />
                            </React.Suspense>
                        )}
                        {surface === 'journal' && (
                            <React.Suspense fallback={<SurfaceSkeleton />}>
                                <Journal
                                    isVisible={true}
                                onClose={handleCloseJournal}
                                initialTab={journalTab}
                                openNonce={journalOpenNonce}
                                username={activeUsername || undefined}
                                trades={loggedTrades}
                                onDeleteTrades={handleDeleteTrades}
                                onClearAllTrades={handleClearAllTrades}
                                modelIdToName={modelIdToName}
                                onUpdateInsights={handleManualInsightsUpdate}
                                isSummarizing={isSummaryInProgress}
                                currentInsightIds={currentInsightIds}
                                onUpdateTradeLeverage={handleUpdateTradeLeverage}
                onUpdateTradeType={handleUpdateTradeType}
                                onUpdateOutcome={handleUpdateTradeOutcome}
                                onUpdatePnL={handleUpdateTradePnL}
                                />
                            </React.Suspense>
                        )}
                        {surface === 'learn' && (
                            <React.Suspense fallback={<SurfaceSkeleton />}>
                                <LearnView
                                    username={activeUsername || 'default'}
                                    trades={loggedTrades}
                                    memoryConfig={memoryConfig}
                                    isGlobalMemoryEnabled={isGlobalMemoryEnabled}
                                    setIsGlobalMemoryEnabled={setIsGlobalMemoryEnabled}
                                    initialTab={learnTab}
                                    onInitialTabConsumed={learnTabConsumed}
                                    renderCoach={renderCoachInbox}
                                    renderSkills={() => (
                                        // Rendered lazily from the tab, not built
                                        // as a node up top: the Studio reads the
                                        // live regime, and a const here would
                                        // evaluate before those values exist.
                                        <SkillsLibrary studio={(
                                            <React.Suspense fallback={<SurfaceSkeleton />}>
                                                <StrategyStudio
                                                    trades={loggedTrades}
                                                    onOpenStrategySearch={() => setIsStrategySearchVisible(true)}
                                                    username={activeUsername || undefined}
                                                    memoryConfig={memoryConfig}
                                                    currentRegime={(currentHybridData as { regime?: { regime?: string } } | null)?.regime?.regime}
                                                />
                                            </React.Suspense>
                                        )} />
                                    )}
                                    renderActionApprovals={renderActionApprovals}
                                    coachCount={coachCount}
                                    reviewSummary={finalTradeSummary}
                                    reviewLoading={isLoading}
                                    onRegenerateReview={handleRegenerateFinalSummary}
                                    // The catalog's Add hands off to the Coach inbox, which owns
                                    // the draft path. `onOpenSkillsSettings` stays unwired on
                                    // purpose: Settings → Skills is "Tool approvals", so a gear
                                    // labelled "Skill settings" there would be an affordance lie,
                                    // and SkillsCatalog hides a control it has no handler for.
                                    onAddSkill={openApprovalsInLearn}
                                />
                            </React.Suspense>
                        )}
                        {surface === 'agents' && (
                            <React.Suspense fallback={<SurfaceSkeleton />}>
                                <AgentsView
                                    username={activeUsername || ''}
                                    bots={bots}
                                    groups={groups}
                                    messages={messages}
                                    selection={activeThread}
                                    onSelect={t => {
                                        if (t.kind === 'bot') selectBotThread(t.botId);
                                        else if (t.kind === 'group') selectGroupThread(t.groupId);
                                        else selectTeamThread();
                                    }}
                                    onNewBot={() => setIsNewBotOpen(true)}
                                    onNewGroup={() => setIsNewGroupOpen(true)}
                                    onSendBotTurn={async (bot, prompt) =>
                                        (await mailboxRef.current?.runUserBotTurn(bot, prompt)) ?? false}
                                    onAnalyze={handleRunAnalysisFromChat}
                                    onLogProposedTrade={handleLogProposedTrade}
                                    onAnalysisError={(message) => toast.error(message)}
                                    onStopRun={handleStopAgentsRun}
                                    analysisRunning={isAnalysisInProgress}
                                    renderGroup={g => renderGroupSurface(g.id)}
                                    coachCount={coachCount}
                                    workingBotId={workingBotId ?? dmWorkingBotId}
                                    mailboxBusyBotIds={mailbox.dmBusyBotIds}
                                    lastOpenedMap={threadOpenedMap}
                                    attentionMap={attentionMap}
                                    botStats={botStats}
                                    onDeleteBot={deleteBot}
                                    onRenameBot={(botId, name) => updateBot(botId, { name })}
                                    onOpenCoach={openApprovalsInLearn}
                                    onDeleteGroup={deleteGroup}
                                    onEditGroup={groupId => {
                                        const target = groups.find(g => g.id === groupId);
                                        if (!target) return;
                                        setGroupEditTarget(target);
                                        setIsNewGroupOpen(true);
                                    }}
                                    modelPicker={({ showEffort }) => (
                                        /* The dock's control, not a plainer twin of
                                           it: one trigger naming the provider, the
                                           model AND the tier, opening one panel that
                                           edits all three. The writes are the pair
                                           the dock writes (`changeChatSoloModel`), and
                                           the tier is subscribed inside the node — see
                                           SessionModelChip. */
                                        <SessionModelChip providers={providerConfigs} value={selectedChatModel}
                                            onChange={changeChatSoloModel}
                                            onRefreshModels={refreshModelCatalog}
                                            issue={chatModelFallback.issue}
                                            fallbackLabel={chatModelFallback.providerName}
                                            showEffort={showEffort} />
                                    )}
                                    modelFallback={chatModelFallback.notice}
                                    railExpanded={isNavRailOpen}
                                    onToggleRailExpanded={toggleNavRail}
                                    railWidth={railResize.width}
                                    railIsResizing={railResize.isResizing}
                                    onRailResizeStart={railResize.startResize}
                                    onRailResizeReset={railResize.resetWidth}
                                    onRevertTo={revertToMessage}
                                    onEditPromptMessage={editMessageText}
                                    onStepVersion={stepMessageGeneration}
                                    parkedCount={(activeConversation?.parked ?? []).reduce((n, p) => n + p.rows.length, 0)}
                                    onRestoreParked={restoreParkedTurns}
                                    /* Navigation on this surface follows the same
                                       rule as the shell rail: the mode switch owns
                                       the top of the column at every width, the
                                       four-destination switch only comes back when
                                       the column is put away (the title bar then
                                       has to carry it), and Journal/Learning/
                                       Customize sit above the account. */
                                    modeSwitch={shellModeSwitch}
                                    surfaceSwitch={shellNavSwitch}
                                    shellUtilities={<ShellUtility
                                        surface={surface}
                                        onSelect={handleSurfaceSelect}
                                        onOpenCustomize={openCustomize}
                                        badges={navBadges}
                                    />}
                                    shellStatusBar={<ShellStatusBar />}
                                    searchRequestNonce={agentsSearchRequest}
                                    onSearchRequestConsumed={consumeAgentsSearchRequest}
                                    statusCluster={shellStatus}
                                    accountRow={(
                                        <AccountRow
                                            expanded
                                            activeUsername={activeUsername}
                                            onOpenSettings={() => setIsSettingsMenuVisible(true)}
                                        />
                                    )}
                                    conversations={conversationHistory}
                                    activeConversationId={activeConversationId}
                                    onLoadConversation={(id) => {
                                        // A loaded conversation's general rows land
                                        // in the desk pane's slice, so the selection
                                        // follows — otherwise the pane kept showing
                                        // the previous thread while the transcript
                                        // silently swapped underneath (stage-3 fix
                                        // for the silent-session-swap defect).
                                        handleLoadConversation(id);
                                        selectTeamThread();
                                    }}
                                    onDeleteConversation={handleDeleteConversationFromSidebar}
                                    onClearConversation={(id) => { void handleClearChat(id); }}
                                    onNewChat={handleStartNewConversation}
                                />
                            </React.Suspense>
                        )}
                    {/* The status strip belongs to the content column, under
                        the surface. Agents renders its own copy inside the pane
                        (it owns that column), so this one is for the rest. */}
                    {surface !== 'agents' && <ShellStatusBar />}
                    </main>


                </div>

            {/* New Bot / New Group Chat dialogs */}
            {isNewBotOpen && (
                <React.Suspense fallback={null}>
                    <NewBotDialog
                        open
                        onClose={() => setIsNewBotOpen(false)}
                        onCreate={createBot}
                        providers={providerConfigs}
                    />
                </React.Suspense>
            )}
            {isNewGroupOpen && (
                <React.Suspense fallback={null}>
                    <NewGroupDialog
                        open
                        onClose={() => { setIsNewGroupOpen(false); setGroupEditTarget(null); }}
                        onCreate={createGroup}
                        onUpdate={updateGroupMembers}
                        initialGroup={groupEditTarget}
                        bots={bots}
                    />
                </React.Suspense>
            )}
            {/* TeamDialog removed — teams merged into groups (one room
                concept; roles/instructions live on the member bots). */}

            {/* The command palette was deleted (stage 3): a fixed action list
                that duplicated chrome and could not search anything. Its
                sole-path actions were rehomed — StrategySearch onto the
                Studio, Saved Analyses into the Journal's Saved tab, the
                ensemble toggle into Settings → Analysis, clear-chat into the
                conversation row menu, jump-to-latest into the transcript's
                scroll-to-bottom pill. Every other entry was a duplicate. */}

            {/* The Strategy Studio is no longer a surface and no longer a
                SETTINGS tab either: it is mounted by the Learning surface's
                Skills tab (see `renderSkills` on LearnView above), reached from
                the sidebar's Customize row or Alt+3. No overlay state to manage
                either way. */}

        </div>
        </React.Suspense>
    );
};

export default App;