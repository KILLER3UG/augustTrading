/**
 * journalTracking — the pure bridge between a journal row and the tracker.
 *
 * A journal row is the trader's record; a TrackedPosition is the tape's
 * record of the same plan. This module maps one to the other and merges a
 * settled row back over its PENDING self without losing the plan the trader
 * actually logged.
 *
 * The entry is NOT assumed filled. A row logged as PENDING is a plan waiting
 * for its limit, so the tracker uses the same touch rule as the signal
 * resolver. A row comes with a validity window; that becomes the tracker's
 * expiry, so a plan that never triggers cannot live forever.
 */

import type { LoggedTrade, TradeResolutionRecord } from '../../types/trade';
import type { JournalOutcomeSnapshot, TrackedPosition } from '../../types/tracking';
import { parsePrice } from '../../utils/analysisUtils';
import { stopDistancePercent } from '../../utils/netRiskReward';
import { isSimulatedTrade, normalizePaperFillAssumptions } from './paperExecution';
import { TRACKED_BAR_MS } from './positionTracker';

export const journalTrackedId = (tradeId: string): string => `journal-${tradeId}`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Extra facts the caller may hold that the row itself does not: the tracker
 *  knows its own entry/stop and exit bar, and the autopilot may have observed
 *  an SL touch followed by a recovery. Every field is optional — an absent
 *  measurement stays a gap, never a zero. */
export interface ResolutionMeta {
    entry?: number;
    stop?: number;
    maePercent?: number;
    mfePercent?: number;
    maeR?: number;
    mfeR?: number;
    exitAt?: number;
    resolvedAt?: string;
    recoveredAfterSlTouch?: boolean;
    slHitThenReversedToTp?: boolean;
    regimeAtEntry?: string;
    contextAtEntry?: string;
}

const humanDuration = (ms: number): string => {
    if (!finite(ms) || ms < 0) return 'unknown';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.round(ms / 1000)}s`;
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

/**
 * The structured resolution record, computed purely from a (possibly partial)
 * journal row plus optional caller measurements. A `LoggedTrade` is assignable
 * to `Partial<LoggedTrade>`, so the log path can pass the row it just built and
 * the tracker can pass the few fields it owns without inventing a fake row.
 *
 * Knowable-at-entry facts (plan adherence, regime, context) are kept beside —
 * never merged into — the post-resolution excursions, because the review loop
 * must be able to refuse a rule that cites only hindsight.
 */
export const buildTradeResolutionRecord = (
    trade: Partial<LoggedTrade>,
    meta: ResolutionMeta = {},
): TradeResolutionRecord => {
    const record: TradeResolutionRecord = {};
    if (typeof trade.followedPlan === 'boolean') record.planAsLogged = trade.followedPlan;

    const maePercent = finite(trade.maxAdverseExcursion) ? trade.maxAdverseExcursion : meta.maePercent;
    const mfePercent = finite(trade.maxFavorableExcursion) ? trade.maxFavorableExcursion : meta.mfePercent;
    if (finite(maePercent)) record.maePercent = maePercent;
    if (finite(mfePercent)) record.mfePercent = mfePercent;

    const entry = finite(meta.entry)
        ? meta.entry
        : parsePrice(trade.analysis?.entryPoints?.[0]?.price ?? '');
    const stop = finite(meta.stop) ? meta.stop : parsePrice(trade.analysis?.stopLoss ?? '');
    const stopPct = finite(entry) && finite(stop) ? stopDistancePercent(entry, stop) : 0;
    if (finite(stopPct) && stopPct > 0) {
        const maeR = finite(meta.maeR) ? meta.maeR : finite(maePercent) ? -Math.abs(maePercent) / stopPct : undefined;
        const mfeR = finite(meta.mfeR) ? meta.mfeR : finite(mfePercent) ? Math.abs(mfePercent) / stopPct : undefined;
        if (finite(maeR)) record.maeR = maeR;
        if (finite(mfeR)) record.mfeR = mfeR;
    }

    const startText = trade.decidedAt ?? trade.timestamp;
    const startMs = startText ? Date.parse(startText) : NaN;
    const endText = meta.resolvedAt ?? trade.outcomeResolvedAt;
    const endMs = endText ? Date.parse(endText) : finite(meta.exitAt) ? meta.exitAt : NaN;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        record.timeToResolutionMs = endMs - startMs;
        record.timeToResolution = humanDuration(endMs - startMs);
    }

    // A missing measurement is a GAP, never a zero. Only stamp the reversal
    // when a caller actually measured it (an explicit meta flag, a recovered
    // after-touch observation, or a recorded SL touch that resolved as a win).
    // Otherwise leave the field absent — a false here would silently claim a
    // measurement nobody took, and the review loop would treat it as evidence.
    const measured: boolean | undefined =
        typeof meta.slHitThenReversedToTp === 'boolean' ? meta.slHitThenReversedToTp
            : typeof meta.recoveredAfterSlTouch === 'boolean' ? meta.recoveredAfterSlTouch
                : trade.slOptimizationData?.slWasTouched === true && trade.outcome === 'WIN' ? true
                    : undefined;
    if (typeof measured === 'boolean') record.slHitThenReversedToTp = measured;
    const regime = meta.regimeAtEntry ?? trade.marketRegime;
    if (regime) record.regimeAtEntry = regime;

    const context = meta.contextAtEntry ?? (trade.analysis
        ? [
            `strategy ${trade.analysis.strategy || 'unspecified'}`,
            `confidence ${trade.analysis.confidence ?? 'unknown'}`,
            `planned R:R ${trade.analysis.rrRatio ?? 'unknown'}`,
        ].join('; ')
        : undefined);
    if (context) record.contextAtEntry = context;
    return record;
};

/** A journal row becomes a tracked plan, or null when its levels/direction do
 *  not form one. Null is a refusal the caller reports; it never invents a
 *  level to keep the button working. */
export const trackedPositionFromJournalTrade = (trade: LoggedTrade): TrackedPosition | null => {
    const analysis = trade.analysis;
    if (!analysis) return null;
    const direction = analysis.direction === 'Long'
        ? 'long'
        : analysis.direction === 'Short' ? 'short' : null;
    if (!direction) return null;
    const entry = parsePrice(analysis.entryPoints?.[0]?.price ?? '');
    const stop = parsePrice(analysis.stopLoss ?? '');
    const targets = (analysis.takeProfit ?? [])
        .map(tp => parsePrice(tp.price))
        .filter(price => Number.isFinite(price) && price > 0);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 || targets.length === 0) {
        return null;
    }
    const symbol = (analysis.coinName ?? '').trim();
    if (!symbol) return null;
    const openedAt = Date.parse(trade.decidedAt || trade.timestamp);
    if (!Number.isFinite(openedAt)) return null;

    const validity = analysis.validityDurationMinutes;
    const expiresAt = typeof validity === 'number' && Number.isFinite(validity) && validity > 0
        ? openedAt + validity * 60_000
        : undefined;

    const providers = Object.keys(trade.modelsUsed ?? {});
    const provider = providers[0];
    const model = provider ? trade.modelsUsed?.[provider] : undefined;
    const family = analysis.detectedPatternFamily;
    const thesis = (analysis.strategy || analysis.historicalCorrelation || family || 'no thesis recorded').trim();

    return {
        id: journalTrackedId(trade.id),
        source: 'journal',
        sourceId: trade.id,
        symbol,
        direction,
        entry,
        stop,
        targets,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(trade.investmentAmount !== undefined ? { size: trade.investmentAmount } : {}),
        ...(trade.leverage !== undefined ? { leverage: trade.leverage } : {}),
        ...(trade.suggestedRiskUsd !== undefined ? { plannedRiskUsd: trade.suggestedRiskUsd } : {}),
        ...(trade.suggestedNotionalUsd !== undefined ? { plannedNotionalUsd: trade.suggestedNotionalUsd } : {}),
        status: 'pending_entry',
        openedAt,
        entryConfirmed: false,
        entryContext: {
            thesis,
            evidenceRefs: trade.planId ? [`plan:${trade.planId}`] : [],
            ...(model ? { model } : {}),
            ...(provider ? { provider } : {}),
            ...(family ? { family } : {}),
            ...(trade.sourceRunId ? { runId: trade.sourceRunId } : {}),
            snapshot: {
                ...(trade.planId ? { planId: trade.planId } : {}),
                confidence: analysis.confidence,
                probability: analysis.probability,
                ...(analysis.rrRatio !== undefined ? { rrRatio: analysis.rrRatio } : {}),
                ...(validity !== undefined ? { validityDurationMinutes: validity } : {}),
                ...(analysis.gate
                    ? {
                        gateStatus: analysis.gate.status,
                        gateCap: analysis.gate.confidenceCap,
                    }
                    : {}),
            },
        },
        cursor: {
            lastClosedBarTime: Math.floor(openedAt / TRACKED_BAR_MS) * TRACKED_BAR_MS + TRACKED_BAR_MS,
            timeframe: '5m',
        },
        mfeR: null,
        maeR: null,
        mfePrice: null,
        maePrice: null,
        mfeAt: null,
        maeAt: null,
        barsRead: 0,
        gaps: [],
        tapeCoversWindow: true,
        timeline: [],
        timelineDownsampled: false,
        timelinePointsDropped: 0,
        context: [],
        contextDownsampled: false,
        ...(isSimulatedTrade(trade)
            ? {
                simulated: true,
                fillAssumptions: normalizePaperFillAssumptions(trade.fillAssumptions ?? trade.analysis?.fillAssumptions),
            }
            : {}),
        version: 1,
    };
};

/** The tracker's exit as a journal settlement. A target is a win, a stop a
 *  loss; an expiry/manual exit follows the tape's R sign. MFE/MAE go back as
 *  RAW price percent (R × stop distance) because the journal applies leverage
 *  exactly once. */
export const journalSettlementFromPosition = (position: TrackedPosition): {
    outcome: 'WIN' | 'LOSS';
    exitPrice?: number;
    exitAt?: number;
    resolvedAt: string;
    realizedR?: number;
    costR?: number;
    netR?: number;
    excursions?: { maePercent: number; mfePercent: number };
    resolutionRecord?: TradeResolutionRecord;
} | null => {
    const exit = position.exit;
    if (!exit) return null;
    const outcome = exit.reason === 'target'
        ? 'WIN'
        : exit.reason === 'stop'
            ? 'LOSS'
            : (exit.realizedR ?? 0) >= 0 ? 'WIN' : 'LOSS';
    const stopPct = stopDistancePercent(position.entry, position.stop);
    const measured = (position.mfeR !== null || position.maeR !== null) && stopPct > 0;
    const excursions = measured
        ? {
            mfePercent: Math.max(0, position.mfeR ?? 0) * stopPct,
            maePercent: Math.abs(Math.min(0, position.maeR ?? 0)) * stopPct,
        }
        : undefined;
    const resolvedAt = new Date(position.closedAt ?? exit.at + TRACKED_BAR_MS).toISOString();
    // A target exit after MAE of at least one full stop is the tape's honest
    // proxy for "the stop was touched, then price reversed". The trader's own
    // autopilot observation overrides this when it is available downstream.
    const recoveredAfterSlTouch = exit.reason === 'target' && (position.maeR ?? 0) <= -1;
    return {
        outcome,
        ...(Number.isFinite(exit.price) ? { exitPrice: exit.price } : {}),
        ...(Number.isFinite(exit.at) ? { exitAt: exit.at } : {}),
        resolvedAt,
        ...(exit.realizedR !== null ? { realizedR: exit.realizedR } : {}),
        ...(exit.costR !== null ? { costR: exit.costR } : {}),
        ...(exit.netR !== null ? { netR: exit.netR } : {}),
        ...(excursions ? { excursions } : {}),
        resolutionRecord: buildTradeResolutionRecord(
            {
                outcome: outcome as LoggedTrade['outcome'],
                decidedAt: new Date(position.openedAt).toISOString(),
            },
            {
                entry: position.entry,
                stop: position.stop,
                ...(excursions ?? {}),
                ...(position.maeR !== null ? { maeR: position.maeR } : {}),
                ...(position.mfeR !== null ? { mfeR: position.mfeR } : {}),
                exitAt: exit.at,
                resolvedAt,
                recoveredAfterSlTouch,
                contextAtEntry: position.entryContext?.thesis,
            },
        ),
    };
};

/**
 * Merge a settled row over the PENDING row it came from.
 *
 * The identity, open time, decision time, analysis and entry-only facts are
 * the PENDING row's; the outcome and measured facts are the settlement's.
 * A re-log of an already-settled row never reaches here — the caller treats
 * that as a duplicate.
 */
export const mergePendingJournalRow = (pending: LoggedTrade, settled: LoggedTrade): LoggedTrade => {
    const merged: LoggedTrade = {
        ...pending,
        ...settled,
        id: pending.id,
        source: pending.source,
        timestamp: pending.timestamp,
        decidedAt: pending.decidedAt ?? settled.decidedAt,
        analysis: pending.analysis ?? settled.analysis,
        planId: pending.planId ?? settled.planId,
        sourceRunId: pending.sourceRunId ?? settled.sourceRunId,
        modelsUsed: pending.modelsUsed ?? settled.modelsUsed,
        thoughtProcesses: pending.thoughtProcesses ?? settled.thoughtProcesses,
        ocrModelUsed: pending.ocrModelUsed ?? settled.ocrModelUsed,
        moderatorProvider: pending.moderatorProvider ?? settled.moderatorProvider,
        moderatorModel: pending.moderatorModel ?? settled.moderatorModel,
        debateTurns: pending.debateTurns ?? settled.debateTurns,
        patternMemoryGate: pending.patternMemoryGate ?? settled.patternMemoryGate,
        userPriorCall: pending.userPriorCall ?? settled.userPriorCall,
        marketSnapshot: pending.marketSnapshot ?? settled.marketSnapshot,
        marketRegime: pending.marketRegime ?? settled.marketRegime,
        marketRegimeSource: pending.marketRegimeSource ?? settled.marketRegimeSource,
        leverage: pending.leverage ?? settled.leverage,
        suggestedRiskUsd: pending.suggestedRiskUsd ?? settled.suggestedRiskUsd,
        suggestedNotionalUsd: pending.suggestedNotionalUsd ?? settled.suggestedNotionalUsd,
        suggestedSizeReason: pending.suggestedSizeReason ?? settled.suggestedSizeReason,
        modelStatedRiskUsd: pending.modelStatedRiskUsd ?? settled.modelStatedRiskUsd,
        modelStatedNotionalUsd: pending.modelStatedNotionalUsd ?? settled.modelStatedNotionalUsd,
        postMortem: settled.postMortem ?? pending.postMortem,
        postMortemCreatedAt: settled.postMortemCreatedAt ?? pending.postMortemCreatedAt,
        postMortemModel: settled.postMortemModel ?? pending.postMortemModel,
        ...(pending.simulated !== undefined || settled.simulated !== undefined
            ? { simulated: pending.simulated ?? settled.simulated }
            : {}),
        ...(pending.fillAssumptions || settled.fillAssumptions
            ? { fillAssumptions: pending.fillAssumptions ?? settled.fillAssumptions }
            : {}),
        outcome: settled.outcome,
        outcomeResolvedAt: settled.outcomeResolvedAt,
        resolutionSource: settled.resolutionSource,
    };
    // A settlement that already measured the resolution is the authority; the
    // merge recomputes it only for older writers that did not carry one.
    return {
        ...merged,
        resolutionRecord: settled.resolutionRecord ?? buildTradeResolutionRecord(merged),
    };
};

/** True when a row's outcome no longer needs the tracker to write one. */
export const isJournalSettled = (outcome: JournalOutcomeSnapshot['outcome']): boolean =>
    outcome === 'WIN'
    || outcome === 'LOSS'
    || outcome === 'ENTRY_NOT_HIT'
    || outcome === 'SKIPPED';
