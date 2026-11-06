import { useCallback, useEffect, useRef, useState } from 'react';
import * as dbService from '../services/infrastructure/dbService';
import { initNativeStatusBar } from '../services/infrastructure/NativeStatusBar';
import {
    initModelPerformanceService,
    syncFromTradeLog,
    syncRollingWindowFromTradeLog,
    syncConfidenceCalibrationFromTradeLog,
} from '../services/backtesting/ModelPerformanceService';
import { initPromptOverrides } from '../services/infrastructure/PromptOverrideService';
import { initStrategyDocs } from '../services/infrastructure/StrategyService';
import {
    initMemoryFiles,
    syncProfileMemory,
    syncPatternMemory,
} from '../services/learning/MemoryFilesService';
import { hydrateRegimeLedger } from '../services/learning/regimeLedger';
import { runWeeklyReviewIfDue } from '../services/learning/weeklyReview';
import { runMonthlyReportIfDue } from '../services/learning/monthlyReport';
import { runMemoryHygieneIfDue } from '../services/learning/memoryHygiene';
import {
    initConfluenceService,
    syncConfluenceFromTradeLog,
} from '../services/analysis/TimeframeConfluenceService';
import {
    initPatternMemoryService,
    setAttributedInsightsUser,
} from '../services/learning/PatternMemorySynthesisService';
import GlobalLearningService from '../services/learning/GlobalLearningService';
import { PriceAlertService } from '../services/ui/PriceAlertService';
import { OutcomeAutopilotService } from '../services/ui/OutcomeAutopilotService';
import { initTracker, resetTracker } from '../services/tracking/trackerService';
import { storageService } from '../services/infrastructure/StorageService';
import { offlineQueue } from '../services/infrastructure/OfflineQueueService';
import { runMigrations, checkDataIntegrity, createStartupBackup, logIntegrityEvent } from '../services/validation/DataIntegrityService';
import { startAutoBackup } from '../services/infrastructure/BackupService';
import { getPreferenceObject, PREF_KEYS } from '../services/infrastructure/PreferencesService';
import { primeChatSessions } from '../services/trade/chatSessions';
import * as chatStore from '../services/trade/chatStore';
import { createNewConversation, LEGACY_LEVERAGE } from '../utils/conversationUtils';
import { recalculateAnalysisMetrics } from '../utils/analysisUtils';
import { settleMessageRow } from '../utils/rowSettlement';
import { getFirstReadyProvider } from '../utils/providerUtils';
import { withTradeSource } from '../utils/tradeSource';
import { DEFAULT_FRAMEWORKS } from '../constants/models';
import { MAX_TRADE_SUMMARIES } from './useTradeLogging';
import type { Message, Conversation, LoggedTrade, CustomInstruction, CustomInstructionsMap, TradeSummary, UserProfile } from '../types';
import type { ProviderConfig } from '../types/provider';

export interface UseUserProfileLoaderArgs {
    handleCancelAnalysis: () => void;


    providerConfigs: ProviderConfig[];

    setConversationHistory: React.Dispatch<React.SetStateAction<Conversation[]>>;
    setActiveConversationId: React.Dispatch<React.SetStateAction<string | null>>;

    setLoggedTrades: React.Dispatch<React.SetStateAction<LoggedTrade[]>>;
    setTradeSummaries: React.Dispatch<React.SetStateAction<TradeSummary[]>>;
    setFinalTradeSummary: React.Dispatch<React.SetStateAction<string | null>>;
    setGlobalMemory: React.Dispatch<React.SetStateAction<any>>;
    setIsGlobalMemoryEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    setMemoryConfig: React.Dispatch<React.SetStateAction<ProviderConfig | null>>;
    setMemoryModel: React.Dispatch<React.SetStateAction<string>>;
    setInsightKnowledgeBase: React.Dispatch<React.SetStateAction<any>>;

    setActiveFrameworks: React.Dispatch<React.SetStateAction<string[]>>;
    setSummaryCharLimit: React.Dispatch<React.SetStateAction<number>>;
    setSummarizationProvider: React.Dispatch<React.SetStateAction<string>>;
    setSummarizationModel: React.Dispatch<React.SetStateAction<string>>;
    setVisionModel: React.Dispatch<React.SetStateAction<string>>;
    setUseAlgorithmicSummary: React.Dispatch<React.SetStateAction<boolean>>;
    setUseAlgorithmicInsights: React.Dispatch<React.SetStateAction<boolean>>;
    setIsStrategiesEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    setCustomInstructions: React.Dispatch<React.SetStateAction<CustomInstructionsMap>>;
    setIsHybridIntelligenceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    setIsAutoCapturing: React.Dispatch<React.SetStateAction<boolean>>;
    setIsEntryNotHitCapturing: React.Dispatch<React.SetStateAction<boolean>>;
    setAutopilotResolutions: React.Dispatch<React.SetStateAction<Record<string, any>>>;

    setInput: React.Dispatch<React.SetStateAction<string>>;
    setImages: React.Dispatch<React.SetStateAction<any[]>>;
    setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;

    setActiveUsername: (u: string) => void;
    setExistingUsernames: React.Dispatch<React.SetStateAction<string[]>>;
    setIsUserModalOpen: (open: boolean) => void;
    /** The three tones this hook actually uses, from `useToastActions()`.
     *  `warning` carries the data-loss alert: a title + body pair, because the
     *  title slot renders bold at body size. */
    toast: {
        info: (msg: string) => void;
        error: (title: string, message?: string) => void;
        warning: (title: string, message?: string, durationMs?: number) => void;
    };
    /** Owned by the caller because the autosave hook is constructed BEFORE
     *  this one and must read the same flag. Set true only once a profile's
     *  data has actually loaded; the autosave refuses to write otherwise. */
    profileReadyRef: React.MutableRefObject<boolean>;
}

export interface UseUserProfileLoaderResult {
    loadUserData: (username: string) => Promise<void>;
    resetAppState: (usernameToSave?: string | null) => Promise<void>;
    profileReady: boolean;
    profileSelectionStartedRef: React.MutableRefObject<boolean>;
}

export const useUserProfileLoader = (args: UseUserProfileLoaderArgs): UseUserProfileLoaderResult => {
    const {
        handleCancelAnalysis,
        providerConfigs,
        setConversationHistory, setActiveConversationId,
        setLoggedTrades, setTradeSummaries, setFinalTradeSummary,
        setGlobalMemory, setIsGlobalMemoryEnabled, setMemoryConfig, setMemoryModel,
        setInsightKnowledgeBase, setActiveFrameworks, setSummaryCharLimit,
        setSummarizationProvider, setSummarizationModel, setVisionModel,
        setUseAlgorithmicSummary, setUseAlgorithmicInsights,
        setIsStrategiesEnabled,
        setCustomInstructions,
        setIsHybridIntelligenceEnabled,
        setIsAutoCapturing,
        setIsEntryNotHitCapturing, setAutopilotResolutions,
        setInput, setImages,
        setIsLoading, setActiveUsername, setExistingUsernames, setIsUserModalOpen,
        toast, profileReadyRef,
    } = args;

    const [profileReady, setProfileReady] = useState(false);
    const profileSelectionStartedRef = useRef(false);
    // Monotonic generation token for loadUserData (mirrors
    // GlobalLearningService._initGeneration). A profile switch mid-load
    // bumps it; every post-await write site in the loader bails when its
    // captured seq is no longer current, so a superseded load can never
    // stampede the outgoing profile's data into the incoming one's state.
    const loadSeqRef = useRef(0);

    /**
     * Everything a loaded profile owns, in one place.
     *
     * These ~30 writes used to be inline in `loadUserData`, split across a
     * hundred lines and interleaved with side effects that are NOT profile
     * application (the weekly/monthly/hygiene passes, the learning-rule
     * migration, the startup backup). That made two questions impossible to
     * answer by reading the loader: "what does a profile switch actually
     * overwrite?" (all of this, plus nothing else) and "which of these runs
     * before the first await?" (the answer must be none of them — a write
     * that lands after an await can be stamped onto the NEXT profile, which
     * is what `loadSeqRef` exists to prevent).
     *
     * So this is a pure application step: it reads `profile` and calls
     * setters, and it returns nothing. Everything sequenced around it — the
     * scheduled passes, the rule migration, the backup — stays in
     * `loadUserData`, where the ordering is still visible.
     */
    const applyLoadedProfile = useCallback((profile: UserProfile): void => {
        setTradeSummaries((profile.tradeSummaries || []).slice(-MAX_TRADE_SUMMARIES));
        setFinalTradeSummary(profile.finalTradeSummary || null);
        setGlobalMemory(profile.globalMemory);
        setActiveFrameworks(profile.settings?.activeFrameworks || DEFAULT_FRAMEWORKS);
        setSummaryCharLimit(profile.settings?.summaryCharLimit || 4000);

        const firstReadyProvider = getFirstReadyProvider(providerConfigs);
        setSummarizationProvider(profile.settings?.summarizationProvider || firstReadyProvider?.id || '');
        setSummarizationModel(profile.settings?.summarizationModel || firstReadyProvider?.selectedModel || '');
        setVisionModel(profile.settings?.visionModel || '');
        setUseAlgorithmicSummary(profile.settings?.useAlgorithmicSummary ?? false);
        setUseAlgorithmicInsights(profile.settings?.useAlgorithmicInsights ?? false);
        // Default ON for a profile that never touched the switch: the memory loop
        // is what makes the assistant remember (item 8 injects the profile,
        // preferences and index every turn), and item 18 frames this setting as
        // turning memory OFF — which presupposes it was on. `?? false` made every
        // existing profile silently run without memory until the trader found the
        // switch, and a stored false still means the trader said no.
        setIsGlobalMemoryEnabled(profile.settings?.isGlobalMemoryEnabled ?? true);
        // Same reasoning as the memory switch above: the flag now gates the seat
        // prompt (`activeStrategiesBlock`), and the per-book `enabled` checkbox
        // is the trader's opt-in — an absent master key must not read as
        // "refuse every book I enabled". A stored false still means they said no.
        setIsStrategiesEnabled(profile.settings?.isStrategiesEnabled ?? true);

        // Accuracy mode is gone: its two instruction lists fold into Standard on
        // load so typed rules survive instead of vanishing from the notebook.
        const loadedInstructions = profile.settings?.customInstructions as
            { general?: CustomInstruction[] | string; accuracyOriginal?: CustomInstruction[] | string; accuracyPure?: CustomInstruction[] | string } | undefined;
        const merged: CustomInstructionsMap = { general: [] };
        const absorb = (list: CustomInstruction[] | string | undefined, title: string) => {
            if (!list) return;
            if (typeof list === 'string') {
                if (list.trim()) merged.general.push({ id: 'migrated-' + title, title, content: list, isActive: true });
                return;
            }
            list.forEach(inst => { if (!merged.general.some(g => g.id === inst.id)) merged.general.push(inst); });
        };
        absorb(loadedInstructions?.general, 'Legacy General');
        absorb(loadedInstructions?.accuracyOriginal, 'Legacy Accuracy');
        absorb(loadedInstructions?.accuracyPure, 'Legacy Pure');
        setCustomInstructions(merged);

        setIsHybridIntelligenceEnabled(profile.settings?.isHybridIntelligenceEnabled ?? false);

        setIsAutoCapturing(profile.settings?.isAutoCapturing ?? false);
        setIsEntryNotHitCapturing(profile.settings?.isEntryNotHitCapturing ?? false);

        const loadedMemoryConfig = providerConfigs.find(p => p.id === profile.settings?.memoryProvider) || null;
        setMemoryConfig(loadedMemoryConfig);
        setMemoryModel(profile.settings?.memoryModel || loadedMemoryConfig?.selectedModel || getFirstReadyProvider(providerConfigs)?.selectedModel || '');

        setInsightKnowledgeBase(profile.insightKnowledgeBase);
    }, [
        providerConfigs,
        setTradeSummaries, setFinalTradeSummary, setGlobalMemory,
        setActiveFrameworks, setSummaryCharLimit, setSummarizationProvider,
        setSummarizationModel, setVisionModel, setUseAlgorithmicSummary,
        setUseAlgorithmicInsights, setIsGlobalMemoryEnabled, setIsStrategiesEnabled,
        setCustomInstructions,
        setIsHybridIntelligenceEnabled,
        setIsAutoCapturing, setIsEntryNotHitCapturing,
 setMemoryConfig, setMemoryModel, setInsightKnowledgeBase,
    ]);

    const resetAppState = useCallback(async (usernameToSave?: string | null) => {
        handleCancelAnalysis();
        const newConv = createNewConversation();
        setConversationHistory([newConv]);
        setActiveConversationId(newConv.id);
        setLoggedTrades([]);
        setTradeSummaries([]);
        setFinalTradeSummary(null);
        setGlobalMemory(undefined);
        // Back to the SHIPPED default, which is on — resetting a profile must not
        // quietly persist "this trader asked for no memory".
        setIsGlobalMemoryEnabled(true);
        setMemoryConfig(null);
        setMemoryModel('');
        setCustomInstructions({ general: [] });
        setIsHybridIntelligenceEnabled(false);
        setIsAutoCapturing(false);
        setIsEntryNotHitCapturing(false);
        setActiveFrameworks(DEFAULT_FRAMEWORKS);
        setSummaryCharLimit(4000);
        const firstReady = getFirstReadyProvider(providerConfigs);
        setSummarizationProvider(firstReady?.id || '');
        setSummarizationModel(firstReady?.selectedModel || '');
        setInput('');
        setImages([]);

        if (usernameToSave) {
            await dbService.saveUserProfile(usernameToSave, {
                conversations: [newConv],
                tradeLog: [],
                tradeSummaries: [],
                finalTradeSummary: null,
                globalMemory: undefined,
                settings: {
                    activeFrameworks: DEFAULT_FRAMEWORKS,
                    summaryCharLimit: 4000,
                    summarizationProvider: firstReady?.id || '',
                    summarizationModel: firstReady?.selectedModel || '',
                    visionModel: '',
                    isGlobalMemoryEnabled: false,
                    customInstructions: { general: [] },
                    isHybridIntelligenceEnabled: false,
                    isAutoCapturing: false,
                    isEntryNotHitCapturing: false,
                    useAlgorithmicSummary: false,
                    useAlgorithmicInsights: false,
                    memoryProvider: '',
                    memoryModel: '',
                },
                lastActiveConversationId: newConv.id,
            });
        }
    }, [
        handleCancelAnalysis, providerConfigs, setActiveConversationId,
        setActiveFrameworks, setConversationHistory,
        setCustomInstructions, setFinalTradeSummary,
        setGlobalMemory, setImages, setInput,
        setIsAutoCapturing, setIsEntryNotHitCapturing,
        setIsGlobalMemoryEnabled, setIsHybridIntelligenceEnabled,
        setLoggedTrades, setMemoryConfig,
        setMemoryModel, setSummarizationModel,
        setSummarizationProvider, setSummaryCharLimit, setTradeSummaries,
    ]);

    const loadUserData = useCallback(async (username: string): Promise<void> => {
        const seq = ++loadSeqRef.current;
        const isStale = (): boolean => loadSeqRef.current !== seq;

        handleCancelAnalysis();
        setIsLoading(true);
        // CLOSE THE DOOR BEFORE SWAPPING THE ROOM. Every profile writer in
        // useProfilePersistence keys its payload on the live state and its key on
        // `activeUsername`, and this load applies the INCOMING rows before the
        // username is adopted — so a debounce armed on either side of that seam
        // serializes one profile's data under the other's name. The flag was only
        // ever raised, never lowered, so during a switch it still said "ready" from
        // the profile being replaced (the 2026-10-27 audit L-2). It is raised again at the
        // one adoption point below, after data AND identity agree.
        profileReadyRef.current = false;

        // SWITCH PATH: drop the outgoing profile's live state before the
        // incoming one loads — the autopilot, the price-alert feed and the
        // setup watches are singletons whose sockets/maps would otherwise
        // keep resolving/monitoring the previous user's trades, and the
        // offline queue must stop replaying the previous user's requests.
        // (watchService/levelWatchService scope themselves per user.)
        OutcomeAutopilotService.reset();
        resetTracker();
        PriceAlertService.reset();
        offlineQueue.setActiveUser(username);

        setAutopilotResolutions({});

        try {
            await dbService.initDatabase();
            await initNativeStatusBar();
            await initModelPerformanceService();
            // The prompt-override / strategy-docs / memory-files trio writes
            // MODULE SINGLETONS scoped to `username`. A superseded load that
            // enters this trio after the newer profile's load already reset
            // them would re-init the OUTGOING profile over the incoming one,
            // so the staleness check runs BEFORE the trio and after each of
            // its three awaits — a load that entered mid-trio still bails
            // before the NEXT singleton write.
            if (isStale()) return;
            await initPromptOverrides(username);
            if (isStale()) return;
            await initStrategyDocs(username);
            if (isStale()) return;
            await initMemoryFiles(username);
            if (isStale()) return;

            // Captured, not fired: the regime ledger's cache is read by the
            // settlement path's regime resolution, so it must be hydrated
            // before anything asks it a question.
            void hydrateRegimeLedger(username)
                .catch(() => { /* ledger is best-effort */ });

            // Monitoring/autopilot singletons take the INCOMING username
            // explicitly (the `last_active_user` marker still points at the
            // outgoing profile until this load's tail commits it).
            if (isStale()) return;
            await PriceAlertService.init(username);
            if (isStale()) return;
            await OutcomeAutopilotService.init(username);
            if (isStale()) return;
            await initTracker(username);
            if (isStale()) return;
            await initConfluenceService();
            if (isStale()) return;
            await initPatternMemoryService();
            if (isStale()) return;
            await GlobalLearningService.setActiveUser(username);
            if (isStale()) return;
            setAttributedInsightsUser(username);

            const profile = await dbService.getUserProfile(username);
            if (isStale()) return;
            // Owner ruling 2026-10-19: the ensemble toggle is gone. Strip the
            // stored key the first time an upgraded profile is read, so the
            // profile blob stops carrying a setting nothing honours.
            if (profile?.settings && 'isEnsembleEnabled' in profile.settings) {
                delete (profile.settings as Record<string, unknown>).isEnsembleEnabled;
                await dbService.saveUserProfile(username, profile);
            }
            if (profile) {
                try {
                    await syncProfileMemory(profile, username);
                    await syncPatternMemory(profile.finalTradeSummary, username, profile.tradeLog || []);
                } catch (e) {
                    console.warn('[TraderNotebook] Initial sync failed:', e);
                }
                if (isStale()) return;

                const correctedConvs = (profile.conversations || []).map(conv => {
                    const leverage = conv.leverage || LEGACY_LEVERAGE;
                    const correctedMessages = (conv.messages || []).map(msg => {
                        const next = msg.analysis
                            ? { ...msg, analysis: recalculateAnalysisMetrics(msg.analysis, leverage) }
                            : msg;
                        // A row stored mid-stream belongs to a run that is not
                        // running any more. Restoring `isStreaming: true` made a
                        // killed turn come back looking alive, with a spinner no
                        // writer would ever clear (the 2026-10-27 audit L-6).
                        return next.isStreaming ? settleMessageRow(next, 'interrupted') : next;
                    });
                    return { ...conv, leverage, messages: correctedMessages };
                });

                const convs = correctedConvs.length > 0 ? correctedConvs : [createNewConversation()];
                setConversationHistory(convs);

                const loadedTrades = (profile.tradeLog || []).map(t => withTradeSource({ ...t, leverage: t.leverage || LEGACY_LEVERAGE }));
                setLoggedTrades(loadedTrades);
                syncConfluenceFromTradeLog(loadedTrades);

                void runWeeklyReviewIfDue(username, loadedTrades).then(res => {
                    if (res) console.log('[WeeklyReview] digest generated:', res.impulse.slice(0, 80));
                }).catch(e => {
                    console.warn('[WeeklyReview] boot pass failed:', e instanceof Error ? e.message : e);
                });

                void runMonthlyReportIfDue(username, loadedTrades).then(res => {
                    if (res) console.log('[MonthlyReport] card generated for period ending', res.generatedAt.slice(0, 10));
                }).catch(e => {
                    console.warn('[MonthlyReport] boot pass failed:', e instanceof Error ? e.message : e);
                });

                // WS-4.2: the memory hygiene pass is only a pass if something
                // schedules it. Same due-check discipline as its siblings;
                // fire-and-forget — the Health tab reads its log lines. The
                // loaded trade log rides along for the lift review, the way
                // weekly/monthly take it above.
                void runMemoryHygieneIfDue(username, undefined, loadedTrades).catch(e => {
                    console.warn('[MemoryHygiene] boot pass failed:', e instanceof Error ? e.message : e);
                });

                // Every profile-owned field, in one call — see applyLoadedProfile.
                applyLoadedProfile(profile);

                if (profile.learningRules && (profile.learningRules.rules?.length ?? 0) > 0) {
                    const localRules = storageService.loadLearningRules();
                    if ((localRules.rules?.length ?? 0) === 0) {
                        storageService.saveLearningRules({
                            rules: profile.learningRules.rules,
                            lastUpdated: profile.learningRules.lastUpdated,
                            version: 2,
                        });
                    }
                }

                const tradeLogData = (profile.tradeLog || []).map(t => withTradeSource({ ...t, leverage: t.leverage || LEGACY_LEVERAGE }));
                syncFromTradeLog(tradeLogData);
                syncRollingWindowFromTradeLog(tradeLogData);
                // The confidence buckets are counters with no entry log, so a
                // re-settled trade never un-counted; rebuild them from the same
                // rows (legacy-only providers are preserved, not dropped).
                syncConfidenceCalibrationFromTradeLog(tradeLogData);

                const lastActive = convs.find(c => c.id === profile.lastActiveConversationId) || convs[0];
                setActiveConversationId(lastActive.id);

                await runMigrations(username);
                if (isStale()) return;

                const tradeCount = (profile.tradeLog || []).length;
                createStartupBackup(username).catch(err =>
                    console.warn('[DataIntegrity] Startup backup failed:', err)
                );

                startAutoBackup(username);

                const integrityCheck = await checkDataIntegrity(username, tradeCount);
                if (isStale()) return;
                if (!integrityCheck.valid && integrityCheck.tradeCountChanged && integrityCheck.newLossAlert) {
                    logIntegrityEvent('DATA_LOSS_DETECTED', integrityCheck);
                    // Title + body, not one blob in the TITLE slot: the title
                    // renders bold at body size, so the whole warning came out
                    // as a five-line block of bold text over the chart. And
                    // `warning` is the honest tone — cyan `info` reads as a
                    // status update, and this says trades went missing.
                    // ONE notice per unchanged loss: the count baseline is not
                    // re-written to 0, so without the flag this fired on every
                    // launch. `recoveryBackup` is the best backup, never the
                    // startup backup that captured the loss.
                    const counts = `Your trade log has fewer trades than before (${integrityCheck.previousTradeCount} → ${integrityCheck.currentTradeCount}).`;
                    toast.warning('Data issue detected', integrityCheck.recoveryBackup
                        ? `${counts} A backup with ${integrityCheck.recoveryBackup.tradeCount} trades from ${new Date(integrityCheck.recoveryBackup.timestamp).toLocaleString()} is available — open Settings → Data to restore it.`
                        : `${counts} No backup holds more trades, so export your data regularly to prevent future loss.`, 15_000);
                }
            } else {
                await resetAppState(username);
            }

            if (isStale()) return;
            await primeChatSessions(username);
            if (isStale()) return;
            setActiveUsername(username);
            sessionStorage.setItem('activeUsername', username);
            localStorage.setItem('last_active_user', username);
            chatStore.resetForUserSwitch();
            profileSelectionStartedRef.current = true;
            setIsUserModalOpen(false);
            setIsLoading(false);
            setProfileReady(true);
            profileReadyRef.current = true;
        } catch (error) {
            console.error('App: failed to load user data', error);
            // A superseded load must not mark the newer profile's pending
            // load as failed — the current generation owns the UI now.
            if (isStale()) return;
            // DO NOT COMMIT THE SWITCH. This profile's data was never loaded,
            // so the React state still holds the PREVIOUS user's
            // conversations and trades. Adopting the username here made the
            // 1500ms debounced autosave write that stale state over the
            // incoming profile: on a fresh boot, empty arrays over a real
            // trade log; on a switch, one user's trades into another's. Both
            // reproduced. Stay on the last good state and say so, rather than
            // trading a transient storage error for the user's data.
            setIsLoading(false);
            setIsUserModalOpen(false);
            setProfileReady(false);
            profileReadyRef.current = false;
            toast.error(
                'Could not load that profile',
                `${username} was not opened because its data failed to load, so nothing was overwritten. `
                + 'Your previous session is unchanged — try again, or restore from a backup in Settings → Data.',
            );        }
    }, [
        // 31 of these used to be listed individually and are now reached only
        // through `applyLoadedProfile`, which carries them itself. Listing them
        // here again would be a comment about an implementation that is one
        // call away — and would be wrong the day someone moves a setter.
        applyLoadedProfile,
        handleCancelAnalysis,
        resetAppState, setActiveConversationId, setActiveUsername,
        setAutopilotResolutions, setConversationHistory, setIsLoading,
        setIsUserModalOpen, setLoggedTrades, toast, profileReadyRef,
    ]);

    // The workspace scan is a MOUNT-ONLY bootstrap. It must never re-run when
    // loadUserData's identity changes: its deps include providerConfigs and
    // the lens/ensemble settings, which legitimately change mid-session, and
    // a re-run would reload the whole profile from disk (loading flash,
    // autopilot reset, re-running migrations and startup backups) and wipe
    // any work not yet covered by the debounced save. The ref keeps each
    // invocation fresh without re-arming the effect.
    const loadUserDataRef = useRef(loadUserData);
    loadUserDataRef.current = loadUserData;

    useEffect(() => {
        let isMounted = true;
        const openWorkspaceIfNeeded = async (): Promise<void> => {
            try {
                const users = await dbService.getAllUsernames();
                if (!isMounted) return;
                setExistingUsernames(users);
                // sessionStorage is PER TAB, so a returning trader who simply
                // opened a new tab or restarted the desktop app had no active
                // user and was met by the workspace chooser every single time.
                // `last_active_user` is written to localStorage on every profile
                // load (:553) and is already what half the services treat as
                // "who is using this app" — the boot gate was the one place that
                // ignored it. The chooser still appears when there is nothing to
                // continue into: a first-ever run, a deleted profile, or an
                // explicit "switch user".
                const remembered = sessionStorage.getItem('activeUsername')
                    || localStorage.getItem('last_active_user');
                if (remembered && users.includes(remembered)) {
                    void loadUserDataRef.current(remembered);
                } else if (!profileSelectionStartedRef.current) {
                    setIsUserModalOpen(true);
                }
            } catch (error) {
                console.error('App: initialization failed', error);
                if (!isMounted) return;
                if (!profileSelectionStartedRef.current) setIsUserModalOpen(true);
            }
        };
        void openWorkspaceIfNeeded();
        return () => { isMounted = false; };
    }, [setExistingUsernames, setIsUserModalOpen]);

    return {
        loadUserData,
        resetAppState,
        profileReady,
        profileSelectionStartedRef,
    };
};
