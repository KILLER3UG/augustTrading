import { useState, useCallback, useEffect, useRef } from 'react';
import { Message, MessageRole, TradeOutcome, LoggedTrade, TradeSummary, ImageMetadata, AIProvider, BenchmarkAlpha } from '../types';
import { captureOutcomeComparison } from '../services/ui/AutoCaptureService';
import { toLeveragedExcursionPct } from '../services/backtesting/outcomeEngine';
import * as MemoryService from '../services/learning/MemoryService';
import { insightTextForTrade } from '../utils/tradeInsightBrief';
import { ProviderConfig } from '../types/provider';
import GlobalLearningService from '../services/learning/GlobalLearningService';
import { defaultLeverage } from '../utils/conversationUtils';
import { parsePrice } from '../utils/analysisUtils';
import { trackTradeOutcome, getTradeProviders, creditedWinForAnalyst, recordProviderConfidenceCalibration } from '../services/backtesting/ModelPerformanceService';
import { computeRMultiple } from '../utils/disciplineAnalytics';
import { CaptureJournalTags } from '../types/trade';
import { trackConfluenceOutcome, calculateConfluenceScore } from '../services/analysis/TimeframeConfluenceService';
import { SLOptimizationData } from '../services/backtesting/StopLossOptimizerService';
import { ConfidenceLevel } from '../services/validation/calibrationStore';
import { syncClosedTradeToNotebook } from '../services/learning/SkillMemoryService';
import { reflectOnClosedTrade } from '../services/learning/settlementReflection';
import { resolveTradeRegime } from '../services/learning/regimeLedger';
import { botOriginForMessage } from '../services/agents/botLearning';
import { appendWatchEpisode } from '../utils/watchList';
import { getActiveUsername } from '../utils/activeUser';
import { withDetectedTradeType } from '../services/analysis/ScalpDetectionService';
import * as chatStore from '../services/trade/chatStore';
import { getHarnessSettings } from '../utils/harnessSettings';
import { computeContractSize } from '../utils/ticketSize';
import { netRiskReward, roundTripCostR, stopDistancePercent } from '../utils/netRiskReward';
import { modelStatedSize } from '../services/trade/proposedTrade';
import { mergePendingJournalRow, trackedPositionFromJournalTrade } from '../services/tracking/journalTracking';
import { registerJournalOutcomeBridge } from '../services/tracking/journalOutcomeBridge';

// Maximum number of trade summaries (Recent Insights) to keep - enforces FIFO when limit reached
export const MAX_TRADE_SUMMARIES = 100;

/** The message a settled journal row no longer has in the open thread. The
 *  settlement funnel reads analysis/provenance off a Message; the row carries
 *  the same facts, so the row IS the message source when the transcript is
 *  gone (another conversation, a reload, a bot thread). */
const messageFromJournalRow = (row: LoggedTrade): Message => ({
    id: row.id,
    role: MessageRole.AI,
    text: '',
    createdAt: row.decidedAt ?? row.timestamp,
    ...(row.analysis ? { analysis: row.analysis } : {}),
    outcome: TradeOutcome.PENDING,
    ...(row.planId ? { planId: row.planId } : {}),
    ...(row.modelsUsed ? { modelsUsed: row.modelsUsed } : {}),
    ...(row.thoughtProcesses ? { thoughtProcesses: row.thoughtProcesses } : {}),
    ...(row.ocrModelUsed ? { ocrModelUsed: row.ocrModelUsed } : {}),
    ...(row.debateTurns ? { debateTurns: row.debateTurns } : {}),
    ...(row.patternMemoryGate ? { patternMemoryGate: row.patternMemoryGate } : {}),
    ...(row.userPriorCall ? { userPriorCall: row.userPriorCall } : {}),
});

/**
 * The trade a capture flow is working on: the analysis message it came from,
 * the outcome being recorded, and whatever facts the detector or the trader has
 * already supplied so a second modal cannot lose them.
 *
 * This used to live on `PostTradeUploadModal`, which existed only to collect
 * screenshots for a post-mortem. That feature is deleted; the candidate is the
 * capture flow's own, so it is declared here.
 */
export type CaptureCandidate = {
    message: Message;
    outcome: TradeOutcome;
    /** The conversation that owns the row, when the detection came from
     *  another thread. The modal's write must land there, not in the active one. */
    conversationId?: string;
    feedback?: {
        pnlAmount?: number;
        correctedEntry?: string;
        correctedStopLoss?: string;
        correctedTakeProfit?: string;
        /** Facts the outcome detector already measured. They ride the candidate
         *  so opening a capture modal on top of a detection cannot lose them —
         *  the modal's own payload carries only what the trader types. */
        outcomeResolvedAt?: string;
        excursions?: { maePercent: number; mfePercent: number };
        realizedR?: number;
    };
};

export interface UseTradeLoggingParams {
    messages: Message[];
    // Latest-message ref (from useConversations). The four "initiate"
    // handlers feed chatContext, whose memoization would otherwise be
    // defeated every stream chunk by a fresh `messages` closure.
    messagesRef: { current: Message[] };
    updateMessages: (updater: (prev: Message[]) => Message[], conversationId?: string) => void;
    activeConversationLeverage?: number;
    moderatorProviderId: string;
    moderatorModel: string;
    memoryModel: string;
    memoryConfig: ProviderConfig;
    useAlgorithmicInsights: boolean;
    /** Fired after a trade is logged AND its insight generation settles —
     *  App debounces this into an automatic AI Review (Pattern Memory)
     *  re-run so the journal stays fresh without manual regeneration. */
    onJournalAutoRefresh?: () => void;
    // UI state setters needed by handlers (transient capture SPINNERS —
    // distinct from the persisted "prompt for capture" settings):
    setIsAutoCaptureBusy: (v: boolean) => void;
    setIsHybridLoading: (v: boolean) => void;
    setIsEntryNotHitCaptureBusy: (v: boolean) => void;
    /** "Prompt when entry price is not hit" setting — gates whether the
     *  capture modal interrupts, or the ENTRY_NOT_HIT is logged silently. */
    isEntryNotHitCapturing: boolean;
    /** Stage 3 wired this one: ON = the capture prompt opens when the
     *  autopilot confirms an outcome (see confirmAutopilotOutcome). Defaults
     *  off — today's behavior. ("Active trade updates" had no real trigger —
     *  nothing auto-initiates a trade update — so its toggle was deleted.) */
    isAutoCapturing?: boolean;
    setIsInsightGenerating: (v: boolean) => void;
    // Market data setters:
    setCurrentHybridData: (v: any) => void;
    // Analysis trigger:
    handleSendMessage: (text?: string, images?: ImageMetadata[], context?: string, options?: any) => void;
    // Toast:
    toast: { error: (title: string, msg?: string) => void; success: (title: string, msg?: string) => void };
    // Additional setters needed by handlers:
}

export const useTradeLogging = (params: UseTradeLoggingParams) => {
    const {
        // `messages` and `handleSendMessage` left with the update-trade flow (their
        // only readers); the params stay on the interface so App's call shape is
        // unchanged.
        messagesRef, updateMessages, activeConversationLeverage,
        moderatorProviderId, moderatorModel,
        memoryModel, memoryConfig, useAlgorithmicInsights,
        onJournalAutoRefresh,
        setIsAutoCaptureBusy, setIsHybridLoading, setIsEntryNotHitCaptureBusy,
        isEntryNotHitCapturing, isAutoCapturing, setIsInsightGenerating,
        setCurrentHybridData,
        toast,
    } = params;

    // ─── State ────────────────────────────────────────────────────────────
    const [loggedTrades, setLoggedTrades] = useState<LoggedTrade[]>([]);
    /** Latest-ref mirror of loggedTrades. The autopilot resolution site
     *  fires pushTradeClosedEvent in the same tick that logTradeWithFeedback
     *  calls setLoggedTrades — the closure-captured `loggedTrades` would still
     *  hold the PRE-log array, so the trade lookup inside it reads the ref. */
    const loggedTradesRef = useRef<LoggedTrade[]>([]);
    useEffect(() => { loggedTradesRef.current = loggedTrades; }, [loggedTrades]);
    const [tradeSummaries, setTradeSummaries] = useState<TradeSummary[]>([]);
    const [finalTradeSummary, setFinalTradeSummary] = useState<string | null>(null);
    const [skipCandidate, setSkipCandidate] = useState<Message | null>(null);
    const [skipReason, setSkipReason] = useState<TradeOutcome.ENTRY_NOT_HIT | TradeOutcome.SKIPPED | null>(null);
    const [correctedEntry, setCorrectedEntry] = useState<string>('');
    const [dataCaptureCandidate, setDataCaptureCandidate] = useState<CaptureCandidate | null>(null);
    const [entryNotHitCandidate, setEntryNotHitCandidate] = useState<{ message: Message; correctedEntry?: string } | null>(null);
    const [newlyAddedInsightIds, setNewlyAddedInsightIds] = useState<Set<string>>(new Set());

    // ─── Helpers ──────────────────────────────────────────────────────────

    const calculateTimeDifference = (originalDate: string): string => {
        const now = new Date();
        const original = new Date(originalDate);
        const diffMs = now.getTime() - original.getTime();
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 60) return `${diffMins}m`;
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        return `${hours}h ${mins}m`;
    };

    // Auto-learn from trade outcome (Phase 1 AI Learning)
    const autoLearnFromOutcome = (trade: LoggedTrade) => {
        if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return;

        const isWin = trade.outcome === TradeOutcome.WIN;
        const analysis = trade.analysis;
        if (!analysis) return;

        // Track per-model performance. The provider list (getTradeProviders —
        // dynamic ids first, full 7-field legacy bridge) and the per-analyst
        // credit semantic (creditedWinForAnalyst) are THE shared ones in
        // ModelPerformanceService: this hook used to carry a private 3-field
        // legacy bridge and an inline inversion, so the incremental and
        // rebuild paths disagreed about the same historical trade.
        //
        // A plan whose levels were MIRRORED is not this model's plan. The
        // schema repairs an inverted stop or target by reflecting it across the
        // entry (schemas/tradeAnalysis.ts -> utils/levelOrder), because that
        // preserves the stated risk/reward magnitudes for a mistyped number.
        // The outcome of a plan the model never proposed says NOTHING about its
        // reading, so crediting it here would let a model that consistently
        // gets its side backwards score as if it were right — the mirror hides
        // the error and the ledger records the corrected plan. `levelsCorrected`
        // was already being set and stored; nothing ever READ it, which is what
        // let this pass.
        //
        // The trade still reaches the journal — the user took it, and hiding it
        // would be its own lie. It just does not train the model, and the
        // correction stays visible in the analysis the journal renders.
        const levelsMirrored = analysis.levelsCorrected === true;
        const providers = levelsMirrored ? [] : getTradeProviders(trade);

        providers.forEach(p => {
            const creditedWin = creditedWinForAnalyst(analysis, isWin, p);
            trackTradeOutcome(p as AIProvider, creditedWin, analysis.detectedPatternFamily || '', trade.marketRegime || 'ranging', analysis.confidence || 'Medium', {
                direction: analysis.direction,
                // parsePrice handles commas + annotations; the old digit-strip
                // regex turned "94500 4h" into 945004 in the RL training signal.
                entryPrice: parsePrice(analysis.entryPoints?.[0]?.price || '') || 0,
                // Real trade id so ReinforcementSignalService can dedupe
                // re-logged/updated trades.
                id: trade.id,
            });
            // Per-provider confidence calibration (the Brier summaries): the
            // store had NO writer, so those numbers were frozen legacy data
            // that still looked live on the profile and in moderator prompts.
            recordProviderConfidenceCalibration(p, analysis.confidence || 'Medium', creditedWin);
        });

        // Auto-learn from LOSS now lands in the SKILLS system:
        // syncClosedTradeToNotebook (called below by the caller) already runs
        // ingestLessonFromTrade + the skill-worth gate — evidence-counted,
        // enforceable, one representation. The parallel rules store is no
        // longer written; it remains read-only history for outcome
        // attribution (applyOutcomeToRules).
    };

    // ─── Recent Insights helper ────────────────────────────────────────────
    // Shared by logTradeWithFeedback and logEntryNotHitTrade (the block was
    // duplicated verbatim for ~40 lines). The 3s animation timer is tracked
    // so an unmount can't setState after teardown.
    const insightTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    useEffect(() => {
        return () => {
            insightTimersRef.current.forEach(t => clearTimeout(t));
            insightTimersRef.current.clear();
        };
    }, []);

    const autoAddRecentInsight = useCallback(async (loggedTrade: LoggedTrade) => {
        setIsInsightGenerating(true);
        try {
            // Use the user's preference for Algo vs AI insight generation
            const summary = insightTextForTrade(loggedTrade)
                || await MemoryService.summarizeTrade(
                    loggedTrade,
                    memoryModel,
                    memoryConfig,
                    useAlgorithmicInsights
                );
            const newSummary = {
                id: loggedTrade.id,
                summaryText: summary,
                timestamp: new Date().toISOString()
            };

            setTradeSummaries(prev => {
                // Check if already exists to prevent duplicates
                if (prev.some(s => s.id === loggedTrade.id)) {
                    return prev;
                }
                const updated = [...prev, newSummary];
                // FIFO: Remove oldest entries to maintain max limit
                return updated.slice(-MAX_TRADE_SUMMARIES);
            });

            // Track newly added insight for animation
            setNewlyAddedInsightIds(prev => new Set(prev).add(loggedTrade.id));
            // Clear animation after 3 seconds
            const timer = setTimeout(() => {
                insightTimersRef.current.delete(timer);
                setNewlyAddedInsightIds(prev => {
                    const next = new Set(prev);
                    next.delete(loggedTrade.id);
                    return next;
                });
            }, 3000);
            insightTimersRef.current.add(timer);

            console.log('[AutoInsight] Trade auto-added to Recent Insights:', loggedTrade.id);
        } catch (error) {
            // Surface the failure so the user knows an insight
            // wasn't created — their trade was still logged successfully.
            console.error('[AutoInsight] Failed to generate insight:', error);
            toast.error(
                "Insight Generation Failed",
                "Your trade was logged, but the AI insight couldn't be generated."
            );
        } finally {
            setIsInsightGenerating(false);
            // The trade is logged — ask App to re-run the AI Review (debounced)
            // whether or not this insight landed.
            onJournalAutoRefresh?.();
        }
    }, [memoryModel, memoryConfig, useAlgorithmicInsights, toast, onJournalAutoRefresh]);

    // ─── Trade Logging ────────────────────────────────────────────────────

    // Helper function to log trade (called by all capture handlers)
    const logTradeWithFeedback = useCallback(async (message: Message, outcome: TradeOutcome.WIN | TradeOutcome.LOSS, feedback: { pnlAmount?: number; pnlPercent?: number; correctedStopLoss?: string; correctedTakeProfit?: string; selectedEntryIndices?: number[]; slOptimizationData?: SLOptimizationData; journalTags?: CaptureJournalTags; benchmark?: BenchmarkAlpha; outcomeResolvedAt?: string; excursions?: { maePercent: number; mfePercent: number }; realizedR?: number; resolutionSource?: 'autopilot' | 'manual' | 'tracker'; }, conversationId?: string) => {
        // The regime this trade was settled in, resolved once in the agreed
        // order: the live hybrid packet, else the regime ledger's observation
        // for this coin on this day (or the nearest earlier one), else the
        // analysis's own pattern text. `mapRegimeToKey` used to answer this and
        // DEFAULTS TO 'ranging', so an unreadable label became a ranging trade
        // and the family × regime matrix counted a regime nobody observed. Here
        // an unresolvable regime stays undefined, and the row says how it was
        // learned so a reader can weigh a three-day-old ledger row apart from a
        // packet reading.
        const regimeCoin = message.analysis?.coinName
            || (message.text?.match(/\b([A-Z]{2,10}USDT?)\b/)?.[1]);
        const resolvedRegime = resolveTradeRegime({
            coin: regimeCoin,
            timestamp: message.createdAt || new Date().toISOString(),
            analysis: message.analysis,
        });
        const marketRegime = resolvedRegime.regime ?? undefined;

        const leverageUsed = activeConversationLeverage || defaultLeverage();
        // Excursions arrive as RAW price percent from whichever engine measured
        // them; the row stores them the same way the post-mortem writes them —
        // leveraged — so one trade cannot have two "worst move" numbers.
        const mae = toLeveragedExcursionPct(feedback.excursions?.maePercent, leverageUsed);
        const mfe = toLeveragedExcursionPct(feedback.excursions?.mfePercent, leverageUsed);
        // Who MEASURED the R/excursions. The tracker is its own writer; an
        // autopilot detection is not relabelled as one.
        const measuredBy = feedback.resolutionSource === 'tracker' ? 'tracker' as const : 'autopilot' as const;

        // ─── The SUGGESTED size ────────────────────────────────────────────
        // The trader's OWN equity and risk %, against the plan's stop
        // distance. The model never touches this number: the sizing rule can
        // only ever DOWNGRADE a ticket (a gate cap, a confidence downgrade, a
        // veto), never scale one up, and with no equity configured it fails
        // closed to zero rather than inventing a position for a user who
        // never set an account. (audit item E-12)
        //
        // Graded on the plan's OWN analysis, not the labelled copy below:
        // `withDetectedTradeType` only adds a scalp/swing label, and the
        // sizing reads the confidence, the direction and the gate — none of
        // which the label touches.
        const harnessSettings = getHarnessSettings();
        const ticket = computeContractSize(
            message.analysis!,
            harnessSettings.equityUsd,
            leverageUsed,
            harnessSettings.riskPercent,
        );
        // Fail closed: with no equity there is a REASON and no numbers. A
        // confident-looking size for an unconfigured account is the exact
        // failure this replaces.
        const sizeFields = ticket.equityUsd > 0
            ? {
                suggestedRiskUsd: ticket.riskUsd,
                suggestedNotionalUsd: ticket.notionalUsd,
                suggestedSizeReason: ticket.reason,
            }
            : { suggestedSizeReason: ticket.reason };

        // The size the MODEL stated, in its own words, recorded SEPARATELY so
        // the journal can compare the two. The app's suggestion never depends
        // on it — a model can neither inflate nor shrink the ticket it sees.
        const statedSize = modelStatedSize(message.analysis?.historicalCorrelation);

        // ─── The COST ──────────────────────────────────────────────────────
        // The round-trip fee, in R, charged against this plan's stop
        // distance, and the NET R beside the GROSS `realizedR`.
        //
        // `realizedR` stays GROSS on purpose: it is the price-measured
        // number the outcome engines produced, and rewriting it would make
        // the row disagree with the tape it was measured against. `netR` is
        // the cost-adjusted sibling, and it is the one a strategy ledger
        // should accumulate — every expectancy in this app used to be gross,
        // so a 0.10 % round trip against a 1 % stop was invisible. (E-03)
        const rowEntryPrice = parsePrice(message.analysis?.entryPoints?.[0]?.price || '') || 0;
        const rowStopPrice = parsePrice(feedback.correctedStopLoss || message.analysis?.stopLoss || '') || 0;
        const stopDistancePct = stopDistancePercent(rowEntryPrice, rowStopPrice);
        const grossR = typeof feedback.realizedR === 'number' && Number.isFinite(feedback.realizedR)
            ? feedback.realizedR
            : undefined;
        const cost = roundTripCostR({ stopDistancePct });
        const net = grossR !== undefined ? netRiskReward({ grossR, stopDistancePct }) : null;
        // The slippage is NOT modelled and the row says so — an unlabelled
        // zero would read as a claim the model never made.
        const costFields = cost.known && cost.costR !== null
            ? { costR: cost.costR, slippageModeled: false as const }
            : { slippageModeled: false as const, costUnknown: cost.unknown ?? ('stop-distance' as const) };

        let loggedTrade: LoggedTrade = {
            id: message.id,
            // Every row this path writes is the trader's own log. Imported
            // history and tape-resolved signals use their own writers when
            // they land; a legacy row reads as manual.
            source: 'manual',
            // Labelled here, at the row, because this is the one place every
            // journal row passes through — a presented plan, a prose chip or a
            // manual log all arrive here. The verdict finalizer used to stamp it
            // upstream; label-only, so no `validityDurationMinutes` appears on a
            // run that never had one and OutcomeAutopilot's expiry window stays
            // exactly as wide as it was. A row that already carries a type —
            // model-stated or the trader's own override — is left alone.
            analysis: withDetectedTradeType(message.analysis!),
            outcome: outcome,
            timestamp: new Date().toISOString(),
            /** The decision time, carried beside the write time. Every
             *  time-bucketed view reads this; `timestamp` stays the row's
             *  provenance. */
            decidedAt: message.analysis?.createdAt || message.createdAt || new Date().toISOString(),
            /** The plan this row came from — the same id the level-watch armed
             *  on. Set at LOG time, so it exists before any post-mortem runs. */
            ...(message.planId ? { planId: message.planId } : {}),
            /** When the outcome became known, not when the row was written: an
             *  autopilot detection at T logged at T+1h must not read as if the
             *  result was known at log time. */
            outcomeResolvedAt: feedback.outcomeResolvedAt ?? new Date().toISOString(),
            /** Provenance: an automatic settlement must never pass for the
             *  trader's own call. A manual capture/confirm is 'manual'. */
            resolutionSource: feedback.resolutionSource ?? 'manual',
            leverage: leverageUsed,
            investmentAmount: undefined,
            pnlAmount: feedback.pnlAmount,
            pnlPercent: feedback.pnlPercent,
            // Skill vs tide: settled only when the verify path resolved both
            // exit price and benchmark candles; otherwise stays undefined —
            // a gap is a gap, never a fabricated alpha.
            benchmark: feedback.benchmark,
            correctedStopLoss: feedback.correctedStopLoss,
            correctedTakeProfit: feedback.correctedTakeProfit,
            triggeredEntryIndices: feedback.selectedEntryIndices, // Store which entries were triggered
            marketSnapshot: message.analysis?.marketSnapshot, // Persist for Algo Mode
            marketRegime,
            ...(resolvedRegime.regime ? { marketRegimeSource: resolvedRegime.source } : {}),
            slOptimizationData: feedback.slOptimizationData, // Autopilot-observed SL behavior
            // Spread-conditional: an unmeasured excursion stays a gap. Writing 0
            // would claim the position never moved against the trader.
            ...(mae !== undefined ? { maxAdverseExcursion: mae } : {}),
            ...(mfe !== undefined ? { maxFavorableExcursion: mfe } : {}),
            // Provenance, not decoration: the post-mortem measures the same pair
            // over its own window, and the row must say which one it is holding
            // rather than letting the later writer swap it in silently.
            ...(mae !== undefined || mfe !== undefined ? { excursionSource: measuredBy } : {}),
            ...(typeof feedback.realizedR === 'number' && Number.isFinite(feedback.realizedR)
                ? { realizedR: feedback.realizedR, rSource: measuredBy }
                : {}),
            // The cost, and the net R beside the gross one above.
            ...costFields,
            ...(net && net.known && net.netR !== null ? { netR: net.netR } : {}),
            // The app's suggested size, and the model's own stated size kept
            // apart from it.
            ...sizeFields,
            ...(statedSize.riskUsd !== undefined ? { modelStatedRiskUsd: statedSize.riskUsd } : {}),
            ...(statedSize.notionalUsd !== undefined ? { modelStatedNotionalUsd: statedSize.notionalUsd } : {}),
            modelsUsed: message.modelsUsed,
            thoughtProcesses: message.thoughtProcesses,

            ocrModelUsed: message.ocrModelUsed,
            moderatorProvider: moderatorProviderId,
            moderatorModel: moderatorModel,
            // Persist debate transcript for training data
            debateTurns: message.debateTurns,
            patternMemoryGate: message.patternMemoryGate,
            promptVersion: message.runStats?.promptVersion,
            promptLane: message.runStats?.promptLane,
            sourceRunId: message.runStats?.runId,
            // Pre-read capture: the committed prior rides the message —
            // copy it onto the trade so the journal can score it.
            userPriorCall: message.userPriorCall,
            // Discipline tags (Batch 5): quick-tap at capture time; R-multiple
            // computed deterministically when a leveraged percent exists.
            ...feedback.journalTags,
            // `feedback.pnlPercent` is the LEVERAGED account percent while the
            // entry→SL distance is a raw price move, so the leverage the row is
            // saved with has to divide out or R is inflated by that factor.
            rMultiple: computeRMultiple(
                message.analysis?.entryPoints?.[0]?.price,
                message.analysis?.stopLoss,
                feedback.pnlPercent,
                leverageUsed,
            ),
        };

        // Settled-row dedupe: the row list dedupes by id, but the side-effect
        // tail below (harness line, notebook evidence, calibration buckets,
        // confluence, per-model attribution, insights) used to re-run on EVERY
        // re-log — confirming an autopilot banner after a manual modal log
        // double-counted the same trade in every stats sink. isDuplicate reads
        // the ref, and the ref is advanced HERE: the effect sync lags one
        // commit, which is exactly the window a double-confirm fires in.
        //
        // A PENDING row is NOT a duplicate: it is the open trade this settlement
        // closes. The settled row is merged over it (identity, open time and
        // the plan survive) and the tail runs exactly once.
        const existingRow = loggedTradesRef.current.find(t => t.id === loggedTrade.id);
        const pendingRow = existingRow?.outcome === TradeOutcome.PENDING ? existingRow : null;
        if (pendingRow) loggedTrade = mergePendingJournalRow(pendingRow, loggedTrade);
        const isDuplicate = existingRow !== undefined && pendingRow === null;
        if (!isDuplicate) {
            loggedTradesRef.current = [loggedTrade, ...loggedTradesRef.current.filter(t => t.id !== loggedTrade.id)];
        }
        setLoggedTrades(prev => {
            if (isDuplicate) return prev;
            if (pendingRow) return prev.map(t => t.id === loggedTrade.id ? loggedTrade : t);
            return [loggedTrade, ...prev.filter(t => t.id !== loggedTrade.id)];
        });
        updateMessages(prev => prev.map(m => {
            if (m.id !== message.id) return m;
            const next = { ...m, outcome };
            return m.watched ? appendWatchEpisode(next, 'logged', outcome) : next;
        }), conversationId);

        // Message chrome (outcome stamp + watch episode) is idempotent and
        // always applies; everything that ACCUMULATES statistics runs once.
        if (isDuplicate) return;

        // ─── Harness visibility: push a one-shot system entry into the
        //  Chart AI dock's chat session that presented this trade AND add
        //  the trade to that session's openTrades ledger. Without this the
        //  chat session that RECOMMENDED the trade never sees "your last
        //  call was logged at $ENTRY" — every downstream "did my last plan
        //  play out?" question is unanswerable from inside the harness.
        // The harness entry id is the conversation Message id (the present_
        //  trade path reuses the message id as the chat entry id) — fall
        //  back to the active session if we can't find a match.
        try {
            const analysis = message.analysis;
            if (analysis) {
                const entryPrices = (analysis.entryPoints || []).map(e => e.price).filter(Boolean);
                const tpPrices = (analysis.takeProfit || []).map(t => t.price).filter(Boolean);
                const entryStr = entryPrices.length > 0 ? entryPrices.join(' / ') : '—';
                const tpStr = tpPrices.length > 0 ? tpPrices.join(' / ') : '—';
                const symbol = analysis.coinName || '—';
                const dir = String(analysis.direction || '');
                const leverage = activeConversationLeverage || defaultLeverage();
                const loggedLine = `[HARNESS] Trade logged: ${symbol} ${dir} @ ${entryStr}, SL ${analysis.stopLoss || '—'}, TP ${tpStr}, leverage ${leverage}x · ${outcome}${message.userPriorCall ? ' (user-prior: ' + message.userPriorCall.direction + ' @ ' + message.userPriorCall.confidencePct + '%)' : ''}`;
                const targetSid = chatStore.findSessionByEntryId(message.id) || undefined;
                chatStore.addOpenTrade({
                    tradeId: loggedTrade.id,
                    symbol,
                    direction: dir,
                    entry: entryStr,
                    stopLoss: analysis.stopLoss || '',
                    takeProfits: tpPrices,
                    openedAt: loggedTrade.timestamp,
                }, targetSid);
                chatStore.addChatSystemEntry(loggedLine, targetSid);
            }
        } catch (harnessErr) {
            console.warn('[TradeLogging] harness visibility update failed (non-fatal):', harnessErr);
        }

        const notebookUser = getActiveUsername();
        // WS-3.2/3.3: a trade logged from a bot's reply is authored by THAT
        // bot, so the worth gate judges the resulting skill against its own
        // memory and the skill carries originBotId. A chart-AI verdict answers
        // with several providers at once and has no single authoring bot.
        const tradeOrigin = botOriginForMessage(message.modelsUsed);
        const tradesForNotebook = [loggedTrade, ...loggedTradesRef.current.filter(t => t.id !== loggedTrade.id)];
        // E-57 §1 — the reflection runs FIRST, and the notebook is handed the
        // row it wrote. The ordering is not a preference:
        // `syncClosedTradeToNotebook` marks the trade settled, then folds the
        // diary entry and the lesson skill draft from `trade.postMortem`, so a
        // reflection that ran afterwards would land on a row the notebook had
        // already recorded as having nothing to say.
        //
        // The trader's click is still not made to wait: the whole chain stays
        // fire-and-forget exactly as it was, so a slow model delays the diary,
        // not the journal.
        void (async () => {
            let settledTrade = loggedTrade;
            try {
                const reflection = await reflectOnClosedTrade(loggedTrade, {
                    username: notebookUser,
                    ...(message.injectedSkills?.length ? { injectedSkills: message.injectedSkills } : {}),
                });
                settledTrade = reflection.trade;
                if (reflection.wrote) {
                    const reflected = reflection.trade;
                    loggedTradesRef.current = loggedTradesRef.current.map(t => t.id === reflected.id ? reflected : t);
                    setLoggedTrades(prev => prev.map(t => t.id === reflected.id ? reflected : t));
                } else if (reflection.reason === 'failed' || reflection.reason === 'no-provider') {
                    // A gap the app CHOSE (a trader's own note, an entry that never
                    // filled) stays silent. A gap caused by the call not working is
                    // reported, because "the notebook has no lesson for this trade"
                    // is otherwise indistinguishable from the leg never existing.
                    console.warn(`[TraderNotebook] settlement reflection skipped: ${reflection.reason}`);
                }
            } catch (err) {
                // The service is written never to throw, but this leg owns the
                // notebook sync BELOW it: an escaping error must cost the
                // reflection, never the diary and the lesson draft.
                console.warn('[TraderNotebook] settlement reflection failed:', err);
            }
            await syncClosedTradeToNotebook(
                settledTrade,
                tradesForNotebook.map(t => t.id === settledTrade.id ? settledTrade : t),
                notebookUser,
                tradeOrigin ?? undefined,
            );
        })().catch(err => console.warn('[TraderNotebook] Closed-trade sync failed:', err));

        // === ThinkingStore: Update outcome for all thinking records of this trade ===
        // This correlates the stored reasoning with the actual outcome (WIN/LOSS),
        // enabling outcome-conditioned training data.
        try {
            const { updateThinkingOutcome, getThinkingTradeId } = await import('../services/infrastructure/ThinkingStoreService');
            // Canonical trade key — same formula as the save side, so the
            // outcome update lands on the records even when the analysis
            // createdAt is missing.
            const tradeId = getThinkingTradeId(loggedTrade.analysis?.createdAt, loggedTrade.id);
            // Pass the card (message) id so the outcome reaches the records
            // even if the timestamp key diverges from the logged trade.
            // PnL travels with the outcome — the corpus becomes risk-weighted
            // (a WIN at +4R is not the same as a WIN at +0.5R).
            updateThinkingOutcome(
                tradeId,
                outcome,
                message.id,
                getActiveUsername(),
                { pnlAmount: loggedTrade.pnlAmount, pnlPercent: loggedTrade.pnlPercent }
            ).catch(err => {
                console.warn('[ThinkingStore] Failed to update outcome:', err);
            });
        } catch (err) {
            console.warn('[ThinkingStore] Failed to import updateThinkingOutcome:', err);
        }

        // Update confidence calibration
        // The same exclusion for the Brier calibration ledger. A mirrored
        // plan's outcome would otherwise enter the confidence-vs-outcome
        // statistics, which are the numbers that tell the user how well this
        // seat's confidence tracks reality.
        if (message.analysis?.confidence && !message.analysis.levelsCorrected) {
            const confidence = message.analysis.confidence as ConfidenceLevel;
            const coin = message.analysis.coinName ||
                (message.text?.match(/\b([A-Z]{2,10}USDT?)\b/)?.[1]) || undefined;
            const pattern = message.analysis.detectedPatternFamily || undefined;

            const provider = Object.keys(message.modelsUsed || {})[0];
            if (coin || pattern) {
                await GlobalLearningService.updateCalibration({
                    timestamp: new Date().toISOString(),
                    confidence,
                    outcome: outcome === TradeOutcome.WIN ? 'WIN' : 'LOSS',
                    coin: coin?.toUpperCase(),
                    pattern: typeof pattern === 'string' ? pattern : undefined,
                    timeframe: '4h',
                    // Use the regime captured at analysis time (was derived
                    // from the pattern family — wrong dimension).
                    regime: marketRegime,
                    provider
                });
            } else {
                await GlobalLearningService.updateCalibration({
                    timestamp: new Date().toISOString(),
                    confidence,
                    outcome: outcome === TradeOutcome.WIN ? 'WIN' : 'LOSS',
                    provider
                });
            }

            // Confluence historical stats (was never tracked — the debate's
            // "historical confluence insight" always showed empty).
            try {
                const direction = message.analysis?.direction as 'Long' | 'Short' | 'Neutral' | undefined;
                if (direction && direction !== 'Neutral') {
                    const score = calculateConfluenceScore(message.analysis, direction);
                    trackConfluenceOutcome(score.score, outcome === TradeOutcome.WIN ? 'WIN' : 'LOSS');
                }
            } catch (e) {
                console.warn('[Confluence] Failed to track outcome:', e);
            }
        }

        // Trigger auto-learning from this trade outcome
        autoLearnFromOutcome(loggedTrade);

        // Auto-add to Recent Insights with FIFO enforcement
        void autoAddRecentInsight(loggedTrade);

    }, [activeConversationLeverage, moderatorProviderId, moderatorModel, updateMessages, memoryModel, memoryConfig, useAlgorithmicInsights, toast, autoAddRecentInsight]);

    /**
     * "Track this trade" — the ONE action a presented plan needs. It writes
     * the PENDING journal row the trader can see, then registers the tracker.
     * It never runs a closed-trade side effect; those belong to settlement.
     * A plan merely presented and never accepted is never tracked.
     */
    const trackProposedTrade = useCallback(async (
        message: Message,
    ): Promise<{ ok: boolean; already?: boolean; error?: string }> => {
        const analysis = message.analysis;
        if (!analysis) return { ok: false, error: 'the plan has no analysis' };
        const existing = loggedTradesRef.current.find(t => t.id === message.id);
        if (existing && existing.outcome !== TradeOutcome.PENDING) {
            return { ok: true, already: true };
        }

        let pending: LoggedTrade;
        if (existing) {
            pending = existing;
        } else {
            const regime = resolveTradeRegime({
                coin: analysis.coinName || message.text?.match(/\b([A-Z]{2,10}USDT?)\b/)?.[1],
                timestamp: analysis.createdAt || message.createdAt || new Date().toISOString(),
                analysis,
            });
            const leverage = activeConversationLeverage || defaultLeverage();
            const harness = getHarnessSettings();
            const ticket = computeContractSize(analysis, harness.equityUsd, leverage, harness.riskPercent);
            const stated = modelStatedSize(analysis.historicalCorrelation);
            pending = {
                id: message.id,
                source: 'manual',
                analysis: withDetectedTradeType(analysis),
                outcome: TradeOutcome.PENDING,
                timestamp: new Date().toISOString(),
                decidedAt: analysis.createdAt || message.createdAt || new Date().toISOString(),
                ...(message.planId ? { planId: message.planId } : {}),
                leverage,
                marketSnapshot: analysis.marketSnapshot,
                ...(regime.regime ? { marketRegime: regime.regime, marketRegimeSource: regime.source } : {}),
                ...(ticket.equityUsd > 0
                    ? {
                        suggestedRiskUsd: ticket.riskUsd,
                        suggestedNotionalUsd: ticket.notionalUsd,
                        suggestedSizeReason: ticket.reason,
                    }
                    : { suggestedSizeReason: ticket.reason }),
                ...(stated.riskUsd !== undefined ? { modelStatedRiskUsd: stated.riskUsd } : {}),
                ...(stated.notionalUsd !== undefined ? { modelStatedNotionalUsd: stated.notionalUsd } : {}),
                modelsUsed: message.modelsUsed,
                thoughtProcesses: message.thoughtProcesses,
                ocrModelUsed: message.ocrModelUsed,
                moderatorProvider: moderatorProviderId,
                moderatorModel,
                debateTurns: message.debateTurns,
                patternMemoryGate: message.patternMemoryGate,
                promptVersion: message.runStats?.promptVersion,
                promptLane: message.runStats?.promptLane,
                sourceRunId: message.runStats?.runId,
                userPriorCall: message.userPriorCall,
            };
            loggedTradesRef.current = [pending, ...loggedTradesRef.current.filter(t => t.id !== pending.id)];
            setLoggedTrades(prev => [pending, ...prev.filter(t => t.id !== pending.id)]);
        }

        const position = trackedPositionFromJournalTrade(pending);
        if (!position) {
            return { ok: false, error: 'the plan has no usable direction, entry, stop and target' };
        }
        try {
            const { registerJournalPositionForTracking } = await import('../services/tracking/trackerService');
            const registered = await registerJournalPositionForTracking(position);
            return registered.ok ? { ok: true } : { ok: false, error: registered.error };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }, [activeConversationLeverage, moderatorProviderId, moderatorModel]);

    // The tracker reads/settles journal rows through this bridge. The ref
    // keeps the latest settlement closure without re-registering on every
    // render; the bridge itself is unmounted with this hook.
    const logTradeWithFeedbackRef = useRef(logTradeWithFeedback);
    useEffect(() => { logTradeWithFeedbackRef.current = logTradeWithFeedback; }, [logTradeWithFeedback]);

    useEffect(() => registerJournalOutcomeBridge({
        read: (tradeId) => {
            const row = loggedTradesRef.current.find(t => t.id === tradeId);
            if (!row) return null;
            return {
                outcome: row.outcome as 'PENDING' | 'WIN' | 'LOSS' | 'ENTRY_NOT_HIT' | 'SKIPPED',
                ...(row.outcomeResolvedAt ? { resolvedAt: row.outcomeResolvedAt } : {}),
            };
        },
        settle: async (tradeId, settlement) => {
            const row = loggedTradesRef.current.find(t => t.id === tradeId);
            if (!row) return { ok: false, error: 'the journal row is no longer present' };
            if (row.outcome !== TradeOutcome.PENDING) return { ok: true };
            if (!row.analysis) return { ok: false, error: 'the journal row has no analysis' };
            const message = messagesRef.current.find(m => m.id === tradeId) ?? messageFromJournalRow(row);
            try {
                await logTradeWithFeedbackRef.current(
                    message,
                    settlement.outcome === 'WIN' ? TradeOutcome.WIN : TradeOutcome.LOSS,
                    {
                        outcomeResolvedAt: settlement.resolvedAt,
                        ...(settlement.realizedR !== undefined ? { realizedR: settlement.realizedR } : {}),
                        ...(settlement.excursions ? { excursions: settlement.excursions } : {}),
                        resolutionSource: 'tracker',
                    },
                );
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    }), []);

    // ─── Data Capture Modal Handlers ──────────────────────────────────────
    // No screenshot option: the post-mortem was the only consumer of a
    // capture's images, so the modal keeps the outcomes it can still record.

    // Temporary variable to store feedback during auto-capture
    const handleDataCaptureAuto = async (feedback: { pnlAmount: number; correctedStopLoss?: string; correctedTakeProfit?: string; selectedEntryIndices?: number[]; journalTags?: CaptureJournalTags; }) => {
        // User chose auto-capture - fetch current market data
        if (!dataCaptureCandidate || !dataCaptureCandidate.message.analysis) {
            setDataCaptureCandidate(null);
            return;
        }

        setIsAutoCaptureBusy(true);
        setIsHybridLoading(true); // Show loading animation on HybridDataPanel

        try {
            // Pass analysis timestamp and selected entry indices for historical TP/SL verification
            const result = await captureOutcomeComparison(
                dataCaptureCandidate.message.analysis,
                dataCaptureCandidate.message.createdAt, // Original analysis timestamp
                feedback.selectedEntryIndices // User-selected entry indices for multi-entry trades
            );

            if (result.success && result.comparisonBlock) {
                // Update HybridDataPanel with captured market data
                if (result.data) {
                    console.log('[AutoCapture] HybridDataPanel UPDATE:', {
                        symbol: result.data.symbol,
                        currentPrice: result.data.marketData?.currentPrice,
                        hasIndicators: !!result.data.indicators,
                        hasRegime: !!result.data.regime,
                        dataKeys: Object.keys(result.data)
                    });
                    setCurrentHybridData(result.data);
                } else {
                    console.warn('[AutoCapture] result.data is undefined!')
                }

                // Pass the auto-captured data as image summaries to post-mortem
                // This will be injected into all AI post-mortem prompts
                const autoCaptureSummary = result.comparisonBlock;

                console.log('[AutoCapture] Successfully captured market data');
                console.log('[AutoCapture] Comparison block length:', autoCaptureSummary.length);

                // Log the trade AFTER successful capture
                logTradeWithFeedback(dataCaptureCandidate.message, dataCaptureCandidate.outcome as any, {
                    // Detection facts ride the candidate; the verification that
                    // just ran has the better excursion read. `...feedback`
                    // stays last so the trader's own numbers win.
                    ...dataCaptureCandidate.feedback,
                    ...feedback,
                    // Carry the skill-vs-tide alpha settled during verification.
                    benchmark: result.historicalOutcome?.benchmark,
                    excursions: result.historicalOutcome?.excursions ?? dataCaptureCandidate.feedback?.excursions,
                    realizedR: result.historicalOutcome?.realizedR ?? dataCaptureCandidate.feedback?.realizedR,
                }, dataCaptureCandidate.conversationId);
            } else {
                console.error('[AutoCapture] Failed:', result.error);
                toast.error("Auto-Capture Failed", `${result.error || 'Unknown error'}. Please try again or skip the capture.`);
            }
        } catch (error) {
            console.error('[AutoCapture] Error:', error);
            toast.error("Auto-Capture Failed", "Please try again or skip the capture.");
        } finally {
            setIsAutoCaptureBusy(false);
            setIsHybridLoading(false); // Stop loading animation
            setDataCaptureCandidate(null);
        }
    };

    const handleDataCaptureSkip = (feedback: { pnlAmount: number; correctedStopLoss?: string; correctedTakeProfit?: string; journalTags?: CaptureJournalTags; }) => {
        // User chose to skip - log the trade without additional market capture.
        if (dataCaptureCandidate) {
            logTradeWithFeedback(dataCaptureCandidate.message, dataCaptureCandidate.outcome as any, {
                ...dataCaptureCandidate.feedback,
                ...feedback,
            }, dataCaptureCandidate.conversationId);
            setDataCaptureCandidate(null);
        }
    };

    // ─── Log / Skip / Update Initiation ───────────────────────────────────

    const handleInitiateLogTrade = useCallback((messageId: string, outcome: TradeOutcome.WIN | TradeOutcome.LOSS) => {
        const msg = messagesRef.current.find(m => m.id === messageId);
        if (msg) {
            // Open DataCaptureModal directly - trade will only be logged after capture confirmation
            setDataCaptureCandidate({ message: msg, outcome, feedback: undefined });
        }
    }, [messagesRef]);

    const handleInitiateSkipTrade = useCallback((messageId: string) => {
        const msg = messagesRef.current.find(m => m.id === messageId);
        if (msg) {
            setSkipCandidate(msg);
            setSkipReason(TradeOutcome.SKIPPED);
            setCorrectedEntry('');
        }
    }, [messagesRef]);

    const handleConfirmSkipTrade = useCallback((reason: TradeOutcome.ENTRY_NOT_HIT | TradeOutcome.SKIPPED) => {
        if (!skipCandidate) return;
        const outcome = reason;

        if (outcome === TradeOutcome.ENTRY_NOT_HIT && skipCandidate.analysis && isEntryNotHitCapturing) {
            // Setting ON (default): DON'T log trade yet - defer until user
            // confirms capture option in EntryNotHitCaptureModal.
            setEntryNotHitCandidate({
                message: skipCandidate,
                correctedEntry: correctedEntry || undefined
            });
        } else {
            // SKIPPED, or ENTRY_NOT_HIT with the "prompt for capture" setting
            // turned off: update message immediately (no capture modal).
            updateMessages(prev => prev.map(m => m.id === skipCandidate.id ? { ...m, outcome, correctedEntry: correctedEntry || undefined } : m));
        }

        setSkipCandidate(null);
        setSkipReason(null);
        setCorrectedEntry('');
    }, [skipCandidate, correctedEntry, isEntryNotHitCapturing]);

    // ─── Entry Not Hit Capture Handlers ───────────────────────────────────

    // Helper to log Entry Not Hit trade (called when user confirms capture choice)
    const logEntryNotHitTrade = useCallback(async (candidate: { message: Message; correctedEntry?: string }, resolutionSource: 'autopilot' | 'manual' = 'manual', conversationId?: string) => {
        if (!candidate.message.analysis) return;

        // Update message outcome
        updateMessages(prev => prev.map(m =>
            m.id === candidate.message.id
                ? { ...m, outcome: TradeOutcome.ENTRY_NOT_HIT, correctedEntry: candidate.correctedEntry }
                : m
        ), conversationId);

        // Log the trade
        const loggedTrade: LoggedTrade = {
            id: candidate.message.id,
            source: 'manual',
            analysis: withDetectedTradeType(candidate.message.analysis),
            outcome: TradeOutcome.ENTRY_NOT_HIT,
            timestamp: new Date().toISOString(),
            decidedAt: candidate.message.analysis.createdAt || candidate.message.createdAt || new Date().toISOString(),
            // Both fields the WIN/LOSS path already writes: an expired entry is a
            // settled row too, and dropping them made "which plan never triggered"
            // unanswerable for exactly the rows that never triggered
            // (the 2026-10-27 audit A-6).
            outcomeResolvedAt: new Date().toISOString(),
            ...(candidate.message.planId ? { planId: candidate.message.planId } : {}),
            resolutionSource,
            leverage: activeConversationLeverage || defaultLeverage(),
            correctedEntry: candidate.correctedEntry,
            modelsUsed: candidate.message.modelsUsed,
            patternMemoryGate: candidate.message.patternMemoryGate,
            promptVersion: candidate.message.runStats?.promptVersion,
        };
        // Dedupe by id — a double-confirm (e.g. retrying after a capture
        // failure that actually logged) previously appended a second row
        // with the same id, skewing every dashboard stat.
        setLoggedTrades(prev => prev.some(t => t.id === loggedTrade.id) ? prev : [loggedTrade, ...prev]);

        // === ThinkingStore: Update outcome for all thinking records of this trade ===
        // ENTRY_NOT_HIT resolves the reasoning set the same way a WIN/LOSS
        // does — without this the training records stayed PENDING forever and
        // the per-trade browser never showed the entry was missed.
        try {
            const { updateThinkingOutcome, getThinkingTradeId } = await import('../services/infrastructure/ThinkingStoreService');
            const tradeId = getThinkingTradeId(loggedTrade.analysis?.createdAt, loggedTrade.id);
            updateThinkingOutcome(tradeId, TradeOutcome.ENTRY_NOT_HIT, candidate.message.id, getActiveUsername()).catch(err => {
                console.warn('[ThinkingStore] Failed to update outcome:', err);
            });
        } catch (err) {
            console.warn('[ThinkingStore] Failed to import updateThinkingOutcome:', err);
        }

        // Auto-add to Recent Insights via the SHARED helper. This block used
        // to be a ~45-line verbatim copy of autoAddRecentInsight (its own
        // comment above even claimed the block was shared) — any fix to the
        // FIFO/toast/timer silently missed the ENTRY_NOT_HIT path.
        void autoAddRecentInsight(loggedTrade);
    }, [activeConversationLeverage, autoAddRecentInsight]);

    // ─── Auto post-mortem on outcome resolution ───────────────────────────
    // When the outcome autopilot resolves a logged trade (WIN / LOSS) the
    // harness (Chart AI chat session) was previously silent — no close-
    // message landed on the dock. pushTradeClosedEvent is the single entry
    // point: it removes the trade from the session's openTrades ledger and
    // pushes a one-shot "[HARNESS] Trade closed: …" entry. It used to start a
    // post-mortem as well; that feature is deleted, so the close line is now
    // the whole of what a resolution does to the chat.
    // Exported so the resolution site in useWatchAndAutopilot (and any
    // future resolve path) can wire it in directly.

    /** Resolution side-effect: drop the trade from openTrades and push a close
    //  message into the chat session that presented it. Falls back to the
    //  active session if the message can't be mapped (the manual resolve flow
    //  can land in any conversation). */
    const pushTradeClosedEvent = useCallback((args: {
        tradeId: string;
        outcome: TradeOutcome.WIN | TradeOutcome.LOSS;
        pnlPercent?: number;
        sid?: string;
    }): void => {
        const { tradeId, outcome, pnlPercent } = args;
        const targetSid = args.sid ?? chatStore.findSessionByEntryId(tradeId) ?? undefined;
        // 1) Drop the trade from openTrades (silent if the session never
        //    tracked it — manual resolve flows may not have an entry to
        //    remove, and the harness visibility is best-effort).
        if (targetSid) chatStore.removeOpenTrade(tradeId, targetSid);
        // 2) Build the close line. pnlPercent is the leveraged percent the
        //    autopilot already settled; a missing value means "magnitude
        //    unmeasured" so we don't fabricate a number.
        const trade = loggedTradesRef.current.find(t => t.id === tradeId);
        const symbol = trade?.analysis?.coinName || '—';
        const dir = trade?.analysis?.direction ? ` ${trade.analysis.direction}` : '';
        const pnlLine = typeof pnlPercent === 'number' && Number.isFinite(pnlPercent)
            ? ` at ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`
            : '';
        const closeLine = `[HARNESS] Trade closed: ${symbol}${dir} ${outcome}${pnlLine}`;
        if (targetSid) chatStore.addChatSystemEntry(closeLine, targetSid);
    }, []);

    // ─── Outcome Autopilot confirmation ───────────────────────────────────
    // One-click logging of autopilot-detected outcomes. Funnels through the
    // same writers as the manual modals so calibration/autoLearn/insight
    // side-effects fire exactly once.

    const confirmAutopilotOutcome = useCallback((
        message: Message,
        outcome: TradeOutcome.WIN | TradeOutcome.LOSS,
        pnlPercent?: number,
        slOptimizationData?: SLOptimizationData,
        /** What the detector actually measured, carried onto the row instead of
         *  being dropped at the confirm click. */
        resolved?: { at?: string; excursions?: { maePercent: number; mfePercent: number }; realizedR?: number },
    /** The conversation that owns the row — omitted for the active one. */
    conversationId?: string,
    ): boolean => {
        // pnlPercent is a PERCENT (e.g. +200), not dollars — it must not be
        // written into pnlAmount, which dashboards sum as USD. It is carried
        // on pnlPercent instead; dollar PnL stays unset (Not Captured).
        // Stage 3: "Post-trade result capture" ON asks the trader for the
        // full capture (dollars, discipline tags) instead of logging the
        // percent-only row — the dashboard unit split's root cause.
        if (isAutoCapturing === true) {
            setDataCaptureCandidate({
                message,
                outcome,
                conversationId,
                // The detection facts ride the candidate so the capture modal's
                // own payload cannot silently drop them.
                feedback: {
                    outcomeResolvedAt: resolved?.at,
                    excursions: resolved?.excursions,
                    realizedR: resolved?.realizedR,
                },
            });
            return false;
        }
        void logTradeWithFeedback(message, outcome, {
            pnlPercent,
            slOptimizationData,
            outcomeResolvedAt: resolved?.at,
            excursions: resolved?.excursions,
            realizedR: resolved?.realizedR,
            resolutionSource: 'autopilot',
        }, conversationId);
        // Every other logging path (capture modal auto/skip, entry-not-hit)
        // starts the post-mortem right after logging — the autopilot
        // one-click confirm must do the same, or a confirmed outcome never
        // gets its post-mortem analysis.
        // Push the close-message + remove from openTrades + auto-call the
        // post-mortem in one shot.
        pushTradeClosedEvent({
            tradeId: message.id,
            outcome,
            pnlPercent,
        });
        return true;
    }, [logTradeWithFeedback, pushTradeClosedEvent, isAutoCapturing]);

    const confirmAutopilotEntryNotHit = useCallback((message: Message, conversationId?: string) => {
        logEntryNotHitTrade({ message }, 'autopilot', conversationId);
    }, [logEntryNotHitTrade]);

    // (pushTradeClosedEvent is declared above so confirmAutopilotOutcome can
    //  reference it in its dep array without a TDZ violation.)

    const handleEntryNotHitAutoCapture = useCallback(async () => {
        if (!entryNotHitCandidate || !entryNotHitCandidate.message.analysis) {
            setEntryNotHitCandidate(null);
            return;
        }

        // Log trade NOW since user confirmed their choice
        logEntryNotHitTrade(entryNotHitCandidate);

        setIsEntryNotHitCaptureBusy(true);
        setIsHybridLoading(true);

        try {
            const result = await captureOutcomeComparison(
                entryNotHitCandidate.message.analysis,
                entryNotHitCandidate.message.createdAt
            );

            if (result.success && result.comparisonBlock) {
                if (result.data) {
                    console.log('[EntryNotHitCapture] HybridDataPanel UPDATE:', {
                        symbol: result.data.symbol,
                        currentPrice: result.data.marketData?.currentPrice,
                    });
                    setCurrentHybridData(result.data);
                }
                console.log('[EntryNotHitCapture] Successfully captured market data');
            } else {
                console.error('[EntryNotHitCapture] Failed:', result.error);
                toast.error("Auto-Capture Failed", `${result.error || 'Unknown error'}. The trade is logged without the captured market data.`);
            }
        } catch (error) {
            console.error('[EntryNotHitCapture] Error:', error);
            toast.error("Auto-Capture Failed", "The trade is logged without the captured market data.");
        } finally {
            setIsEntryNotHitCaptureBusy(false);
            setIsHybridLoading(false);
            setEntryNotHitCandidate(null);
        }
    }, [entryNotHitCandidate, logEntryNotHitTrade]);

    const handleEntryNotHitSkip = useCallback(() => {
        if (entryNotHitCandidate) {
            // Log trade NOW since user confirmed their choice
            logEntryNotHitTrade(entryNotHitCandidate);
            setEntryNotHitCandidate(null);
        }
    }, [entryNotHitCandidate, logEntryNotHitTrade]);

    // ─── Return ───────────────────────────────────────────────────────────

    // The surface below is EXACTLY what App.tsx consumes. It used to be 42
    // names wide, 13 of which App destructured and never referenced again —
    // a binding is a contract, and a contract nobody reads is a second thing to
    // keep correct every time a handler is renamed or a state field moves.
    // `tests/hookDestructureHygiene.test.ts` fails the build if a name is bound
    // here and not used, so the surface cannot quietly regrow.
    return {
        // State values and setters
        loggedTrades, setLoggedTrades,
        tradeSummaries, setTradeSummaries,
        finalTradeSummary, setFinalTradeSummary,
        dataCaptureCandidate, setDataCaptureCandidate,
        entryNotHitCandidate, setEntryNotHitCandidate,
        newlyAddedInsightIds, setNewlyAddedInsightIds,
        // Handler functions
        // `logTradeWithFeedback` and `logEntryNotHitTrade` are NOT bound in
        // App.tsx — the Journal auto-review and logged-trade harness suites
        // drive them straight off this hook's return. They are a deliberate
        // test seam, which is why the dead-binding test below scans the
        // DESTRUCTURE (App's contract) and not this return object.
        logTradeWithFeedback,
        logEntryNotHitTrade,
        confirmAutopilotOutcome,
        confirmAutopilotEntryNotHit,
        handleDataCaptureAuto,
        handleDataCaptureSkip,
        handleInitiateLogTrade,
        trackProposedTrade,
        handleEntryNotHitAutoCapture,
        handleEntryNotHitSkip,
        // Outcome-resolution harness visibility: drops the trade from the
        // chat session's openTrades ledger and pushes a close-message into
        // the dock. Surfaced for the autopilot resolution site and any future
        // resolve path.
        pushTradeClosedEvent,
    };
};
