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

import type { LoggedTrade } from '../../types/trade';
import type { JournalOutcomeSnapshot, TrackedPosition } from '../../types/tracking';
import { parsePrice } from '../../utils/analysisUtils';
import { stopDistancePercent } from '../../utils/netRiskReward';
import { TRACKED_BAR_MS } from './positionTracker';

export const journalTrackedId = (tradeId: string): string => `journal-${tradeId}`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
            ...(trade.promptVersion ? { promptVersion: trade.promptVersion } : {}),
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
    return {
        outcome,
        ...(Number.isFinite(exit.price) ? { exitPrice: exit.price } : {}),
        ...(Number.isFinite(exit.at) ? { exitAt: exit.at } : {}),
        resolvedAt: new Date(position.closedAt ?? exit.at + TRACKED_BAR_MS).toISOString(),
        ...(exit.realizedR !== null ? { realizedR: exit.realizedR } : {}),
        ...(exit.costR !== null ? { costR: exit.costR } : {}),
        ...(exit.netR !== null ? { netR: exit.netR } : {}),
        ...(excursions ? { excursions } : {}),
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
export const mergePendingJournalRow = (pending: LoggedTrade, settled: LoggedTrade): LoggedTrade => ({
    ...pending,
    ...settled,
    id: pending.id,
    source: pending.source,
    timestamp: pending.timestamp,
    decidedAt: pending.decidedAt ?? settled.decidedAt,
    analysis: pending.analysis ?? settled.analysis,
    planId: pending.planId ?? settled.planId,
    sourceRunId: pending.sourceRunId ?? settled.sourceRunId,
    promptVersion: pending.promptVersion ?? settled.promptVersion,
    promptLane: pending.promptLane ?? settled.promptLane,
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
    outcome: settled.outcome,
    outcomeResolvedAt: settled.outcomeResolvedAt,
    resolutionSource: settled.resolutionSource,
});

/** True when a row's outcome no longer needs the tracker to write one. */
export const isJournalSettled = (outcome: JournalOutcomeSnapshot['outcome']): boolean =>
    outcome === 'WIN'
    || outcome === 'LOSS'
    || outcome === 'ENTRY_NOT_HIT'
    || outcome === 'SKIPPED';
