import { useCallback } from 'react';
import * as MemoryService from '../services/learning/MemoryService';
import { generateFinalSummary } from '../services/providers/GenericAnalysisService';
import { syncPatternMemory } from '../services/learning/MemoryFilesService';
import { getThinkingTradeId, updateThinkingOutcome, deleteThinkingByTrade } from '../services/infrastructure/ThinkingStoreService';
import { OutcomeAutopilotService } from '../services/ui/OutcomeAutopilotService';
import { recordIntentionalTradeCount } from '../services/validation/DataIntegrityService';
import { insightTextForTrade } from '../utils/tradeInsightBrief';
import { recalculateAnalysisMetrics } from '../utils/analysisUtils';
import { sanitizeErrorText } from '../utils/runStatus';
import { MAX_TRADE_SUMMARIES } from './useTradeLogging';
import type { ConfirmOptions } from '../components/shared/ConfirmDialog';
import { reconcileSkillsAfterOutcomeCorrection } from '../services/learning/SkillMemoryService';
import { TradeOutcome } from '../types';
import type { LoggedTrade, TradeSummary } from '../types';
import type { ProviderConfig } from '../types/provider';

export interface UseTradeJournalActionsArgs {
    loggedTrades: LoggedTrade[];
    setLoggedTrades: React.Dispatch<React.SetStateAction<LoggedTrade[]>>;
    tradeSummaries: TradeSummary[];
    setTradeSummaries: React.Dispatch<React.SetStateAction<TradeSummary[]>>;
    finalTradeSummary: string | null;
    setFinalTradeSummary: React.Dispatch<React.SetStateAction<string | null>>;
    /** Latest-ref read for outcome/PnL backfills — the handler stays
     *  memoized while always seeing the current trade row. */
    loggedTradesRef: React.MutableRefObject<LoggedTrade[]>;
    activeUsernameRef: React.MutableRefObject<string | null>;
    confirmDialog: (opts: ConfirmOptions) => Promise<boolean>;
    toast: {
        success: (title: string, message?: string) => void;
        /** Used to SURFACE a failed write — a pattern-memory sync that never
         *  lands is a lost learning event, and it must not be silent.
         *
         *  Optional so a caller that only has `success` still type-checks;
         *  App always provides it, and a caller that does not still gets the
         *  console report — the failure is never swallowed either way. */
        error?: (title: string, message?: string) => void;
    };
    /** The debounced AI-Review re-run trigger (owned by App, shared with
     *  useTradeLogging — stable identity so its memoized callbacks hold). */
    handleJournalAutoRefresh: () => void;
    /** Latest-ref bridge INTO the debounced trigger: assigned here after
     *  handleRegenerateFinalSummary exists so the stable debounced callback
     *  in App always invokes the freshest regeneration logic. */
    regenerateFinalSummaryRef: React.MutableRefObject<() => void>;
    isSummaryInProgress: boolean;
    setIsSummaryInProgress: React.Dispatch<React.SetStateAction<boolean>>;
    setInsightProgress: React.Dispatch<React.SetStateAction<{ done: number; total: number } | null>>;
    setNewlyAddedInsightIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    memoryConfig: ProviderConfig | null;
    moderatorConfig: ProviderConfig;
    readyProviders: ProviderConfig[];
    useAlgorithmicInsights: boolean;
    summaryCharLimit: number;
}

export interface UseTradeJournalActionsResult {
    handleDeleteTrades: (ids: string[]) => void;
    handleClearAllTrades: () => Promise<void>;
    handleManualInsightsUpdate: (ids: string[]) => Promise<void>;
    handleDeleteInsight: (id: string) => void;
    handleRewriteInsightsWithAI: (ids?: string[]) => Promise<void>;
    handleUpdateTradeLeverage: (id: string, leverage: number) => void;
    /** Correct the auto-detected scalp/swing class. The classifier labels every
     *  row as it is written to the journal, so without this the label is something the
     *  trader can filter by but never disagree with — and `tradeTypeManualOverride`
     *  exists in the type for exactly this case, unused. Manual wins:
     *  `withDetectedTradeType` skips any row that already carries a type. */
    handleUpdateTradeType: (id: string, tradeType: 'scalp' | 'swing') => void;
    handleUpdateTradeOutcome: (id: string, outcome: TradeOutcome) => void;
    handleUpdateTradePnL: (id: string, pnl: { pnlAmount?: number; pnlPercent?: number }) => void;
    handleRegenerateFinalSummary: () => Promise<void>;
}

/**
 * Journal CRUD: delete/clear trades, generate/rewrite/delete insights,
 * correct outcome/PnL/leverage on a logged trade, and regenerate the AI
 * Review summary. Pure handlers over the trade-log state owned by
 * useTradeLogging — every mutation also backfills the thinking records
 * and re-runs the Pattern Memory sync so the learning stack never
 * describes trades or insights that no longer exist.
 */
export const useTradeJournalActions = (args: UseTradeJournalActionsArgs): UseTradeJournalActionsResult => {
    const {
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
    } = args;

    /**
     * A pattern-memory sync is a WRITE to the trader's notebook, so a failure
     * loses a learning event — and the notebook can then describe trades that
     * no longer exist. It used to be swallowed outright (`.catch(() => {})`),
     * which made that loss invisible.
     *
     * The repo's rule is explicit — "Never add a swallow-and-continue around
     * a notebook write; surface it, like `memoryHealth` does" — so this
     * reports it: the console for the record, and a toast the trader sees.
     * The error text goes through the app's own sanitizer, so a raw
     * provider/storage message never reaches the UI.
     */
    const reportPatternMemoryFailure = (err: unknown): void => {
        console.error('[TraderNotebook] pattern-memory.md sync failed:', err);
        toast.error?.(
            'Pattern memory not updated',
            `The notebook's pattern memory could not be written, so it may still describe trades that no longer exist. ${sanitizeErrorText(err)}`.trim(),
        );
    };

    const handleDeleteTrades = (ids: string[]) => {
        const idSet = new Set(ids);
        const nextTrades = loggedTrades.filter(t => !idSet.has(t.id));
        const nextSummaries = tradeSummaries.filter(s => !idSet.has(s.id));
        setLoggedTrades(nextTrades);
        setTradeSummaries(nextSummaries);
        if (nextTrades.length === 0) {
            setFinalTradeSummary(null);
            void syncPatternMemory(null, activeUsernameRef.current || 'default').catch(reportPatternMemoryFailure);
        } else if (nextTrades.length !== loggedTrades.length) {
            // The AI Review was synthesized from the old trade set — re-run
            // it so Pattern Memory never describes deleted trades.
            handleJournalAutoRefresh();
        }
        // Cascade: reasoning records, learning rules and autopilot watchers
        // keyed to the deleted trades must not survive — a deleted trade
        // would otherwise re-trigger "outcome detected" and be re-logged.
        const username = activeUsernameRef.current || 'default';
        // A deletion is deliberate, not a storage loss: move the integrity
        // baseline so the next boot does not warn about the rows just removed.
        void recordIntentionalTradeCount(username, nextTrades.length);
        const deletedTrades = loggedTrades.filter(t => idSet.has(t.id));
        deletedTrades.forEach(t => {
            void deleteThinkingByTrade(getThinkingTradeId(t.analysis?.createdAt, t.id), username);
            OutcomeAutopilotService.unregister(t.id);
        });
    };

    const handleClearAllTrades = async () => {
        // Capture state before deletion for undo. Previously this used
        // native confirm() (blocking, no undo) — a delete could appear to
        // succeed in UI but be lost if the tab closed before the debounced save.
        const prevTrades = loggedTrades;
        const prevSummaries = tradeSummaries;
        const prevFinalSummary = finalTradeSummary;
        const username = activeUsernameRef.current || 'default';
        let restored = false;
        const ok = await confirmDialog({
            title: 'Delete all trade history?',
            message: `This will remove ${loggedTrades.length} logged trade(s) and their insights. You can undo this for 5 seconds.`,
            confirmLabel: 'Delete All',
            destructive: true,
            onUndo: () => {
                restored = true;
                setLoggedTrades(prevTrades);
                setTradeSummaries(prevSummaries);
                setFinalTradeSummary(prevFinalSummary);
                void recordIntentionalTradeCount(username, prevTrades.length);
                toast.success('Trade history restored');
            },
        });
        if (ok) {
            setLoggedTrades([]);
            setTradeSummaries([]);
            setFinalTradeSummary(null);
            // Clearing is deliberate: move the integrity baseline so the next
            // startup does not warn that four trades became zero.
            void recordIntentionalTradeCount(username, 0);
            void syncPatternMemory(null, username).catch(reportPatternMemoryFailure);
            // AFTER the undo grace window — an undo restores the trades, so
            // their artifacts must survive until the delete is final.
            window.setTimeout(() => {
                if (restored || prevTrades.length === 0) return;
                prevTrades.forEach(t => {
                    void deleteThinkingByTrade(getThinkingTradeId(t.analysis?.createdAt, t.id), username);
                    OutcomeAutopilotService.unregister(t.id);
                });
            }, 5500);
        }
    };

    const handleManualInsightsUpdate = async (ids: string[]) => {
        // Find trades that need summaries generated (not already in tradeSummaries)
        const existingIds = new Set(tradeSummaries.map(s => s.id));
        const newTrades = loggedTrades.filter(t => ids.includes(t.id) && !existingIds.has(t.id));
        const alreadyAddedCount = ids.length - newTrades.length;

        if (newTrades.length === 0) {
            console.log('[ManualInsights] All selected trades are already in Recent Insights');
            return; // No new trades to process
        }

        setIsSummaryInProgress(true);

        try {
            // Generate summaries for each new trade
            const newSummaries: TradeSummary[] = [];
            let done = 0;
            setInsightProgress({ done: 0, total: newTrades.length });

            for (const trade of newTrades) {
                const fromPostMortem = insightTextForTrade(trade);
                const summary = fromPostMortem
                    || await MemoryService.summarizeTrade(trade, memoryConfig?.selectedModel || '', memoryConfig || moderatorConfig, useAlgorithmicInsights);
                newSummaries.push({
                    id: trade.id,
                    summaryText: summary,
                    timestamp: new Date().toISOString()
                });
                done++;
                setInsightProgress({ done, total: newTrades.length });
            }

            // Add new summaries with FIFO enforcement and robust deduplication
            setTradeSummaries(prev => {
                // Re-check for duplicates to prevent race conditions
                const prevIds = new Set(prev.map(s => s.id));
                const uniqueNewSummaries = newSummaries.filter(s => !prevIds.has(s.id));

                if (uniqueNewSummaries.length < newSummaries.length) {
                    console.warn(`[ManualInsights] Filtered ${newSummaries.length - uniqueNewSummaries.length} duplicates during update.`);
                }

                const updated = [...prev, ...uniqueNewSummaries];
                // Remove oldest entries from the beginning to maintain max limit
                return updated.slice(-MAX_TRADE_SUMMARIES);
            });

            // Track newly added insights for animation
            const addedIds = newSummaries.map(s => s.id);
            setNewlyAddedInsightIds(prev => {
                const next = new Set(prev);
                addedIds.forEach(id => next.add(id));
                return next;
            });
            // Clear animation after 3 seconds
            setTimeout(() => {
                setNewlyAddedInsightIds(prev => {
                    const next = new Set(prev);
                    addedIds.forEach(id => next.delete(id));
                    return next;
                });
            }, 3000);

            console.log(`[ManualInsights] Processed ${newSummaries.length} trades for insights.`);
            if (alreadyAddedCount > 0) {
                console.log(`[ManualInsights] ${alreadyAddedCount} trades were already in Recent Insights (pre-check)`);
            }
        } catch (e) {
            console.error('[ManualInsights] Failed to generate summaries:', e);
        } finally {
            setIsSummaryInProgress(false);
            setInsightProgress(null);
            // New insights landed — re-run the AI Review so Pattern Memory
            // reflects the expanded insight set.
            handleJournalAutoRefresh();
        }
    };

    // Delete individual insight from Recent Insights
    const handleDeleteInsight = (id: string) => {
        setTradeSummaries(prev => prev.filter(s => s.id !== id));
        // The AI Review is synthesized from the insights — keep it in sync.
        handleJournalAutoRefresh();
        console.log(`[ManualInsights] Removed insight with id: ${id}`);
    };

    // Rewrite insights with AI - regenerates summaries using AI provider
    // If ids is empty/undefined, rewrites ALL insights
    const handleRewriteInsightsWithAI = async (ids?: string[]) => {
        const targetIds = ids && ids.length > 0 ? ids : tradeSummaries.map(s => s.id);

        if (targetIds.length === 0) {
            console.log('[AIRewrite] No insights to rewrite');
            return;
        }

        setIsSummaryInProgress(true);
        console.log(`[AIRewrite] Rewriting ${targetIds.length} insights with AI...`);

        try {
            const updatedSummaries: TradeSummary[] = [];
            let done = 0;
            setInsightProgress({ done: 0, total: targetIds.length });

            for (const id of targetIds) {
                const trade = loggedTrades.find(t => t.id === id);
                console.log(`[AIRewrite] Looking for trade with id: ${id}, found: ${!!trade}`);
                if (trade) {
                    const summaryConfig = memoryConfig || readyProviders[0] || moderatorConfig;
                    console.log(`[AIRewrite] Calling MemoryService.summarizeTrade with provider: ${summaryConfig.name}, model: ${summaryConfig.selectedModel}`);
                    const fromPostMortem = insightTextForTrade(trade);
                    const summary = fromPostMortem
                        || await MemoryService.summarizeTrade(trade, summaryConfig.selectedModel || '', summaryConfig, false);
                    console.log(`[AIRewrite] Got summary for ${id}:`, summary?.substring(0, 100));
                    updatedSummaries.push({
                        id: trade.id,
                        summaryText: summary,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    console.warn(`[AIRewrite] Trade not found for id: ${id}. Available trade ids:`, loggedTrades.map(t => t.id));
                }
                done++;
                setInsightProgress({ done, total: targetIds.length });
            }

            // Replace existing summaries with AI-generated ones
            setTradeSummaries(prev => {
                const unchangedSummaries = prev.filter(s => !targetIds.includes(s.id));
                return [...unchangedSummaries, ...updatedSummaries].slice(-MAX_TRADE_SUMMARIES);
            });

            // Show animation for rewritten insights
            setNewlyAddedInsightIds(prev => {
                const next = new Set(prev);
                updatedSummaries.forEach(s => next.add(s.id));
                return next;
            });
            setTimeout(() => {
                setNewlyAddedInsightIds(prev => {
                    const next = new Set(prev);
                    updatedSummaries.forEach(s => next.delete(s.id));
                    return next;
                });
            }, 3000);

            console.log(`[AIRewrite] Successfully rewrote ${updatedSummaries.length} insights with AI`);
        } catch (e) {
            console.error('[AIRewrite] Failed to rewrite insights:', e);
        } finally {
            setIsSummaryInProgress(false);
            setInsightProgress(null);
            // Insights were rewritten — re-run the AI Review so Pattern
            // Memory is synthesized from the fresh insight text.
            handleJournalAutoRefresh();
        }
    };

    const handleUpdateTradeLeverage = (id: string, leverage: number) => {
        setLoggedTrades(prev => prev.map(t => {
            if (t.id === id) {
                const updatedAnalysis = recalculateAnalysisMetrics(t.analysis, leverage);
                return { ...t, leverage, analysis: updatedAnalysis };
            }
            return t;
        }));
    };

    // Correct the class the classifier assigned. Setting it manually also marks
    // the row as overridden, which is what stops finalization relabelling it —
    // the detector skips any trade that already carries a type.
    const handleUpdateTradeType = (id: string, tradeType: 'scalp' | 'swing') => {
        setLoggedTrades(prev => prev.map(t => (
            t.id === id
                ? {
                    ...t,
                    tradeType,
                    // The override flag lives on the analysis, which is where the
                    // type declares it and where the detector looks.
                    analysis: t.analysis
                        ? { ...t.analysis, tradeType, tradeTypeManualOverride: true }
                        : t.analysis,
                }
                : t
        )));
    };

    // Correct a mis-logged outcome (WIN/LOSS/etc.) from the journal card —
    // previously the only fix was delete + re-log. Backfills the thinking
    // records so outcome-correlated reasoning stays accurate.
    const handleUpdateTradeOutcome = useCallback((id: string, outcome: TradeOutcome) => {
        // A human correcting the outcome IS the moment it became known — later
        // than any detector's stamp, which is now stale by definition. The
        // previous value is kept on the row: an automatic settlement the
        // trader overruled must stay auditable, and a correction no longer
        // passes for the original call.
        const correctedAt = new Date().toISOString();
        setLoggedTrades(prev => prev.map(t => (t.id === id
            ? {
                ...t,
                ...(t.outcome !== outcome
                    ? { correctedFrom: t.outcome, correctedAt, resolutionSource: 'correction' as const }
                    : {}),
                outcome,
                outcomeResolvedAt: correctedAt,
            }
            : t)));
        const trade = loggedTradesRef.current.find(t => t.id === id);
        if (trade) {
            const tradeId = getThinkingTradeId(trade.analysis?.createdAt, id);
            void updateThinkingOutcome(tradeId, outcome, id, activeUsernameRef.current || 'default', { pnlAmount: trade.pnlAmount, pnlPercent: trade.pnlPercent }).catch(err => {
                console.warn('[TradeLog] Failed to update thinking outcome:', err);
            });
            // The settlement pass folded this trade into the skills that carried
            // it. The row and the fold must not disagree: move the record to the
            // corrected class, and say so — a silent repair is a second opinion
            // the trader cannot see. Only WIN↔LOSS corrections were ever folded;
            // the service owns that guard.
            if (trade.outcome !== outcome) {
                const corrected: LoggedTrade = {
                    ...trade,
                    outcome,
                    correctedFrom: trade.outcome,
                    correctedAt,
                    resolutionSource: 'correction' as const,
                    outcomeResolvedAt: correctedAt,
                };
                void reconcileSkillsAfterOutcomeCorrection(corrected, activeUsernameRef.current || 'default')
                    .then(result => {
                        if (result.reconciled.length > 0) {
                            toast.success(
                                'Skill record corrected',
                                `${result.reconciled.length} skill${result.reconciled.length === 1 ? '' : 's'} updated to the corrected outcome.`,
                            );
                        }
                    })
                    .catch(err => {
                        // A repair that never lands is a lost learning event;
                        // surface it like every other notebook write.
                        console.error('[TradeLog] Skill record correction failed:', err);
                        toast.error?.(
                            'Skill record not corrected',
                            err instanceof Error ? err.message : 'The notebook write failed.',
                        );
                    });
            }
        }
    }, [setLoggedTrades, loggedTradesRef, activeUsernameRef, toast]);

    // Fill in / correct PnL from the journal card (autopilot-logged trades
    // only carry the leveraged percent, so the dollar figure needs a manual
    // entry to make the dashboard PnL math meaningful). Backfills the
    // thinking records too so the training corpus stays consistent with the
    // journal.
    const handleUpdateTradePnL = useCallback((id: string, pnl: { pnlAmount?: number; pnlPercent?: number }) => {
        setLoggedTrades(prev => prev.map(t => t.id === id ? { ...t, ...pnl } : t));
        const trade = loggedTradesRef.current.find(t => t.id === id);
        if (trade) {
            const tradeId = getThinkingTradeId(trade.analysis?.createdAt, id);
            void updateThinkingOutcome(tradeId, trade.outcome, id, activeUsernameRef.current || 'default', pnl).catch(err => {
                console.warn('[TradeLog] Failed to backfill thinking PnL:', err);
            });
        }
    }, [setLoggedTrades, loggedTradesRef, activeUsernameRef]);

    const handleRegenerateFinalSummary = async () => {
        // Guard: an auto-refresh may already be running (the debounced
        // journal auto-refresh and the manual button share this path) —
        // never launch two AI syntheses concurrently.
        if (isSummaryInProgress) return;
        setIsSummaryInProgress(true);
        try {
            if (loggedTrades.length === 0) {
                setFinalTradeSummary(null);
                void syncPatternMemory(null, activeUsernameRef.current || 'default').catch(reportPatternMemoryFailure);
                return;
            }
            let summary = '';
            const summaryConfig = memoryConfig || readyProviders[0];
            if (summaryConfig) {
                summary = await generateFinalSummary(summaryConfig, tradeSummaries, summaryCharLimit);
            }

            setFinalTradeSummary(summary);
            const notebookUser = activeUsernameRef.current || 'default';
            void syncPatternMemory(summary || null, notebookUser, loggedTrades).catch(reportPatternMemoryFailure);
        } catch (e) {
            console.error("Summary regeneration failed", e);
        } finally {
            setIsSummaryInProgress(false);
        }
    };

    // Latest-ref for the debounced journal auto-refresh (the stable
    // debounced callback lives in App, before useTradeLogging). Assigning
    // AFTER the declaration keeps that stable closure seeing the freshest
    // regeneration logic without re-arming useTradeLogging's memoized
    // callbacks on every render.
    regenerateFinalSummaryRef.current = () => { void handleRegenerateFinalSummary(); };

    return {
        handleDeleteTrades,
        handleClearAllTrades,
        handleManualInsightsUpdate,
        handleDeleteInsight,
        handleRewriteInsightsWithAI,
        handleUpdateTradeLeverage,
        handleUpdateTradeType,
        handleUpdateTradeOutcome,
        handleUpdateTradePnL,
        handleRegenerateFinalSummary,
    };
};
