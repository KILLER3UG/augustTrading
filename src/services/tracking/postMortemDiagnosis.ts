/**
 * postMortemDiagnosis — ONE model call per closed tracked position.
 *
 * The deterministic packet (facts, absences, path) lives in `diagnosisPacket`;
 * this module owns the provider call, the persisted diagnosis queue and the
 * bridge back into the journal's existing settlement funnel.
 *
 * THE QUEUE. `runDiagnosisPass` takes at most three due items, writes the queue
 * after every item, and never drops overflow. A transport failure retries up
 * to `MAX_DIAGNOSIS_ATTEMPTS`; after that the item becomes a stored refusal,
 * so the audit trail keeps the gap instead of looping forever.
 */

import type {
    TrackedContextPoint,
    TrackedDiagnosis,
    TrackedPosition,
} from '../../types/tracking';
import { parseTrackedDiagnosisAnswer } from '../../schemas/tracking';
import {
    readDiagnoses,
    readDiagnosisQueue,
    readTrackedPositions,
    saveDiagnosis,
    saveTrackedPosition,
    writeDiagnosisQueue,
} from './positionStore';
import {
    downsampleContext,
    MAX_DIAGNOSIS_ATTEMPTS,
    requeueStaleDiagnoses,
    selectDiagnosisBatch,
} from './positionTracker';
import { readSignals } from '../signals/signalLedger';
import {
    applyJournalDiagnosis,
    hasJournalOutcomeBridge,
    readJournalTrade,
    recordJournalSettlement,
} from './journalOutcomeBridge';
import {
    fetchFundingRate,
    fetchFuturesOHLCV,
    fetchOpenInterest,
} from '../analysis/MarketDataService';
import { calculateIndicators } from '../analysis/TechnicalAnalysisService';
import { resolveMemoryConfig } from '../learning/MemoryModelService';
import { sendChatRequest, type ChatMessage } from '../providers/GenericProviderService';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { effortForTask } from '../providers/reasoningControls';
import {
    beginPromptLane,
    getPrompt,
    promptCorpusVersion,
} from '../infrastructure/PromptOverrideService';
import { extractAndParseJson } from '../../utils/jsonUtils';
import { sanitizeAIResponse } from '../../utils/sanitizers';
import { getActiveUsername } from '../../utils/activeUser';
import {
    authoritativeOutcome,
    CONTEXT_TIMEFRAMES,
    diagnosisIsTentative,
    diagnosisPacket,
    finite,
    fnv1a,
    refusalDiagnosis,
    renderDiagnosisPostMortem,
} from './diagnosisPacket';

export const DIAGNOSIS_PROMPT_ID = 'learning.post_mortem_diagnosis';

/** The built-in instruction. Registered in `constants/promptRegistry.ts`, so
 *  Settings can edit it and the call site imports the same string. */
export const POST_MORTEM_DIAGNOSIS_FALLBACK = `You write the post-mortem for ONE closed trade from the facts given. They are the whole record: you were not watching the tape, so you did not see anything they do not name.

Answer ONLY JSON:
{
  "outcome": "win" | "loss" | "breakeven",
  "whatHappened": "2-5 sentences on how this plan met its outcome, in terms of the numbers given",
  "rootCause": "why it won or lost — one or two sentences",
  "whatShouldHaveBeenDone": "the one change the record supports: entry, stop, target, sizing, skip or hold — or 'no change'",
  "primaryChange": "entry" | "stop" | "target" | "sizing" | "skip" | "hold",
  "lesson": "one transferable sentence — what to do differently next time, starting with the thing the trader controls",
  "when": "the trigger, as a condition the trader can check BEFORE entering (no price you invented)",
  "action": "the mechanical action that trigger should change",
  "confidence": 0,
  "evidenceRefs": ["EXCURSION", "BENCHMARK"]
}

Rules:
- Quote only numbers that are in the record. If a fact is missing, name the absence instead of filling it.
- The tape outcome is stated. Do not contradict it; if the record looks inconsistent, say so in rootCause.
- "when"/"action" must be checkable and mechanical — a level, a condition, a regime, a size. Not "be more careful", not "trust the feeling".
- A GROSS R that turns NET-negative after fees is a lesson about the stop distance or the entry, not about the direction.
- An outcome that beat its own benchmark is not evidence of skill; a loss while the benchmark rose is not evidence of error. Say which you were told.
- If the record does not support a transferable lesson — thin tape, a gap, an ambiguous same-candle exit, a one-off execution slip — output {"noLesson": true} and nothing else. A gap in the notebook is better than a rule that was never earned.
- Confidence is confidence in the LESSON, not in the trade outcome.`;

const DIAGNOSIS_TIMEOUT_MS = 60_000;

const noLessonAnswer = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const obj = (raw as Record<string, unknown>).diagnosis ?? raw;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const flag = (obj as Record<string, unknown>).noLesson;
    return flag === true || flag === 'true' || flag === 'yes';
};

const collectDiagnosisContext = async (position: TrackedPosition): Promise<TrackedContextPoint[]> => {
    const at = position.closedAt ?? position.exit?.at ?? Date.now();
    const [funding, oi] = await Promise.all([
        fetchFundingRate(position.symbol).catch(() => null),
        fetchOpenInterest(position.symbol).catch(() => null),
    ]);
    const points: TrackedContextPoint[] = [];
    await Promise.all(CONTEXT_TIMEFRAMES.map(async timeframe => {
        try {
            const bars = await fetchFuturesOHLCV(position.symbol, timeframe, 300);
            if (bars.length < 30) return;
            let index = -1;
            for (let i = 0; i < bars.length; i += 1) {
                if (bars[i].time <= at) index = i;
                else break;
            }
            if (index < 20) return;
            const bar = bars[index];
            const indicators = calculateIndicators(bars.slice(0, index + 1));
            const values: Record<string, number> = {};
            const pairs: Array<[string, number]> = [
                ['ema20', indicators.ema.ema20],
                ['ema50', indicators.ema.ema50],
                ['rsi14', indicators.rsi.rsi14],
                ['atrPercent', indicators.atrPercent],
                ['macdHistogram', indicators.macd.histogram],
            ];
            for (const [key, value] of pairs) {
                if (finite(value)) values[key] = value;
            }
            points.push({
                at: bar.time,
                timeframe,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                ...(finite(bar.volume) ? { volume: bar.volume } : {}),
                ...(Object.keys(values).length > 0 ? { indicators: values } : {}),
                ...(timeframe === '1h' && funding !== null && finite(funding) ? { funding } : {}),
                ...(timeframe === '1h' && oi && finite(oi.oiValue) && oi.oiValue > 0
                    ? { openInterest: oi.oiValue }
                    : {}),
            });
        } catch {
            // A missing timeframe is printed as "not captured" by the packet.
        }
    }));
    return points.sort((a, b) =>
        CONTEXT_TIMEFRAMES.indexOf(a.timeframe) - CONTEXT_TIMEFRAMES.indexOf(b.timeframe));
};

export interface DiagnosisPassResult {
    attempted: number;
    diagnosed: number;
    refused: number;
    failed: number;
    deferred: number;
}

const emptyResult = (): DiagnosisPassResult => ({
    attempted: 0,
    diagnosed: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
});

let diagnosisPromise: Promise<DiagnosisPassResult> | null = null;

/** Consume the diagnosis queue. At most `cap` items per pass; every item's
 *  status is persisted, so a crash mid-pass cannot lose a diagnosis. */
export const runDiagnosisPass = async (
    username: string = getActiveUsername(),
    options: { cap?: number } = {},
): Promise<DiagnosisPassResult> => {
    if (diagnosisPromise) return diagnosisPromise;
    diagnosisPromise = (async (): Promise<DiagnosisPassResult> => {
        const result = emptyResult();
        const now = Date.now();
        const queueRead = await readDiagnosisQueue(username);
        if (!queueRead.ok) return result;
        const positionsRead = await readTrackedPositions(username);
        if (!positionsRead.ok) return result;
        const diagnosesRead = await readDiagnoses(username);
        if (!diagnosesRead.ok) return result;

        const positions = new Map(positionsRead.value.map(position => [position.id, position]));
        const diagnoses = new Map(diagnosesRead.value.map(diagnosis => [diagnosis.tradeId, diagnosis]));
        const signalRows = new Map(readSignals(username).map(row => [row.signal.id, row]));
        const queue = requeueStaleDiagnoses(queueRead.value, now);
        if (queue.some((item, index) => item.status !== queueRead.value[index]?.status)) {
            await writeDiagnosisQueue(username, queue);
        }
        const { batch } = selectDiagnosisBatch(queue, options.cap);
        const queueById = new Map(queue.map(item => [item.id, item]));
        const saveQueue = async (): Promise<void> => {
            const wrote = await writeDiagnosisQueue(username, queue);
            if (!wrote.ok) console.warn('[Diagnosis] queue write failed:', wrote.error);
        };

        for (let index = 0; index < batch.length; index += 1) {
            result.attempted += 1;
            const item = queueById.get(batch[index].id) ?? batch[index];
            const position = positions.get(item.tradeId);
            const existing = diagnoses.get(item.tradeId);

            if (existing) {
                // A previous model succeeded. Re-link and apply; never pay for
                // the same diagnosis twice.
                if (position && !position.diagnosisId) {
                    const linked = { ...position, diagnosisId: existing.id };
                    const wrote = await saveTrackedPosition(username, linked);
                    if (wrote.ok) positions.set(position.id, linked);
                }
                if (position?.source === 'journal' && hasJournalOutcomeBridge()) {
                    const row = readJournalTrade(position.sourceId);
                    if (row) {
                        const applied = existing.refusal
                            ? await recordJournalSettlement(position.sourceId)
                            : await applyJournalDiagnosis(
                                position.sourceId,
                                existing,
                                renderDiagnosisPostMortem(existing),
                            );
                        if (!applied.ok) {
                            const attempts = item.attempts + 1;
                            item.attempts = attempts;
                            item.lastError = applied.error;
                            if (attempts >= MAX_DIAGNOSIS_ATTEMPTS) {
                                // The diagnosis is stored; only the row/notebook
                                // write is missing. Keep the gap in lastError
                                // rather than spinning a failed row forever.
                                item.status = 'done';
                                item.finishedAt = now;
                                if (existing.refusal) result.refused += 1;
                                else result.diagnosed += 1;
                            } else {
                                item.status = 'failed';
                                result.failed += 1;
                            }
                            await saveQueue();
                            continue;
                        }
                    }
                }
                item.status = 'done';
                item.finishedAt = now;
                await saveQueue();
                result.diagnosed += existing.refusal ? 0 : 1;
                if (existing.refusal) result.refused += 1;
                continue;
            }

            if (!position) {
                const refusal = refusalDiagnosis(item, null, 'breakeven', 'malformed', 'the tracked position was pruned before diagnosis');
                await saveDiagnosis(username, refusal);
                item.status = 'done';
                item.finishedAt = now;
                await saveQueue();
                result.refused += 1;
                continue;
            }
            if (position.status === 'cancelled' || !position.exit) {
                result.deferred += 1;
                continue;
            }
            if (position.source === 'journal' && !hasJournalOutcomeBridge()) {
                result.deferred += 1;
                continue;
            }
            const journalRow = position.source === 'journal' ? readJournalTrade(position.sourceId) : null;
            if (position.source === 'journal' && !journalRow) {
                const refusal = refusalDiagnosis(item, position, 'breakeven', 'malformed', 'the journal row is no longer present');
                await saveDiagnosis(username, refusal);
                await saveTrackedPosition(username, { ...position, diagnosisId: refusal.id });
                item.status = 'done';
                item.finishedAt = now;
                await saveQueue();
                result.refused += 1;
                continue;
            }
            const signalRow = position.source === 'signal'
                ? signalRows.get(position.sourceId) ?? null
                : null;
            const outcome = authoritativeOutcome(position, journalRow, signalRow);

            if (!position.tapeCoversWindow || position.barsRead < 2) {
                const refusal = refusalDiagnosis(
                    item,
                    position,
                    outcome,
                    'thin-tape',
                    `the tape covers ${position.barsRead} bar(s) and does not reach the entry window`,
                );
                await saveDiagnosis(username, refusal);
                await saveTrackedPosition(username, { ...position, diagnosisId: refusal.id });
                if (position.source === 'journal') await recordJournalSettlement(position.sourceId);
                item.status = 'done';
                item.finishedAt = now;
                await saveQueue();
                result.refused += 1;
                continue;
            }

            let config: Awaited<ReturnType<typeof resolveMemoryConfig>>;
            try {
                config = await resolveMemoryConfig(username);
            } catch {
                config = null;
            }
            if (!config || !config.apiKey?.trim()) {
                result.deferred += batch.length - index;
                break;
            }

            const collected = await collectDiagnosisContext(position);
            const contextMap = new Map(
                [...position.context, ...collected].map(point => [`${point.timeframe}:${point.at}`, point]),
            );
            const context = downsampleContext([...contextMap.values()].sort((a, b) =>
                CONTEXT_TIMEFRAMES.indexOf(a.timeframe) - CONTEXT_TIMEFRAMES.indexOf(b.timeframe)));
            const packet = diagnosisPacket({
                position,
                outcome,
                ...(journalRow ? { journalRow } : {}),
                ...(signalRow ? { signalRow } : {}),
                context: context.points,
            });
            const packetHash = fnv1a(packet);
            const lane = beginPromptLane();
            const promptVersion = promptCorpusVersion(lane);
            const tier = effortForTask('postMortem');

            let raw: string;
            try {
                raw = await sendChatRequest(
                    config,
                    [
                        { role: 'system', content: getPrompt(DIAGNOSIS_PROMPT_ID, POST_MORTEM_DIAGNOSIS_FALLBACK, lane) },
                        { role: 'user', content: packet },
                    ] as ChatMessage[],
                    {
                        maxTokens: TASK_BUDGETS.postMortem,
                        temperature: 0.2,
                        reasoningEffort: tier,
                        signal: AbortSignal.timeout(DIAGNOSIS_TIMEOUT_MS),
                    },
                );
            } catch (e) {
                const attempts = item.attempts + 1;
                const error = e instanceof Error ? e.message : String(e);
                if (attempts >= MAX_DIAGNOSIS_ATTEMPTS) {
                    const refusal = refusalDiagnosis(item, position, outcome, 'malformed', 'the diagnosis call failed on every attempt');
                    await saveDiagnosis(username, refusal);
                    await saveTrackedPosition(username, {
                        ...position,
                        diagnosisId: refusal.id,
                        context: context.points,
                        contextDownsampled: context.downsampled,
                    });
                    if (position.source === 'journal') await recordJournalSettlement(position.sourceId);
                    item.status = 'done';
                    item.finishedAt = now;
                    await saveQueue();
                    result.refused += 1;
                } else {
                    item.status = 'failed';
                    item.attempts = attempts;
                    item.lastError = error;
                    await saveQueue();
                    result.failed += 1;
                }
                continue;
            }

            let parsedJson: unknown;
            try {
                parsedJson = extractAndParseJson(sanitizeAIResponse(raw || ''));
            } catch {
                parsedJson = null;
            }

            if (noLessonAnswer(parsedJson)) {
                const refusal = refusalDiagnosis(
                    item,
                    position,
                    outcome,
                    'no-lesson',
                    'the model declined: the record did not support a transferable lesson',
                );
                await saveDiagnosis(username, refusal);
                await saveTrackedPosition(username, {
                    ...position,
                    diagnosisId: refusal.id,
                    context: context.points,
                    contextDownsampled: context.downsampled,
                });
                if (position.source === 'journal') await recordJournalSettlement(position.sourceId);
                item.status = 'done';
                item.finishedAt = now;
                await saveQueue();
                result.refused += 1;
                continue;
            }

            const answer = parseTrackedDiagnosisAnswer(parsedJson);
            if (!answer) {
                const attempts = item.attempts + 1;
                if (attempts >= MAX_DIAGNOSIS_ATTEMPTS) {
                    const refusal = refusalDiagnosis(item, position, outcome, 'malformed', 'the model answered, but not in the diagnosis shape, on every attempt');
                    await saveDiagnosis(username, refusal);
                    await saveTrackedPosition(username, {
                        ...position,
                        diagnosisId: refusal.id,
                        context: context.points,
                        contextDownsampled: context.downsampled,
                    });
                    if (position.source === 'journal') await recordJournalSettlement(position.sourceId);
                    item.status = 'done';
                    item.finishedAt = now;
                    await saveQueue();
                    result.refused += 1;
                } else {
                    item.status = 'failed';
                    item.attempts = attempts;
                    item.lastError = 'malformed answer';
                    await saveQueue();
                    result.failed += 1;
                }
                continue;
            }

            const tentative = diagnosisIsTentative(position) || answer.outcome !== outcome;
            const diagnosis: TrackedDiagnosis = {
                ...answer,
                id: item.id,
                tradeId: position.id,
                source: position.source,
                outcome,
                modelOutcome: answer.outcome,
                confidence: tentative ? Math.min(answer.confidence, 50) : answer.confidence,
                evidenceCount: 1,
                model: config.selectedModel,
                provider: config.id,
                promptVersion,
                packetHash,
                createdAt: new Date().toISOString(),
                tentative,
            };
            const stored = await saveDiagnosis(username, diagnosis);
            if (!stored.ok) {
                item.status = 'failed';
                item.attempts += 1;
                item.lastError = stored.error;
                await saveQueue();
                result.failed += 1;
                continue;
            }
            const linked = {
                ...position,
                diagnosisId: diagnosis.id,
                context: context.points,
                contextDownsampled: context.downsampled,
            };
            const linkedWrite = await saveTrackedPosition(username, linked);
            if (linkedWrite.ok) positions.set(position.id, linked);

            if (position.source === 'journal' && hasJournalOutcomeBridge()) {
                const applied = await applyJournalDiagnosis(
                    position.sourceId,
                    diagnosis,
                    renderDiagnosisPostMortem(diagnosis),
                );
                if (!applied.ok) {
                    item.status = 'failed';
                    item.attempts += 1;
                    item.lastError = applied.error;
                    await saveQueue();
                    result.failed += 1;
                    continue;
                }
            }
            item.status = 'done';
            item.finishedAt = Date.now();
            await saveQueue();
            result.diagnosed += 1;
        }
        return result;
    })().finally(() => {
        diagnosisPromise = null;
    });
    return diagnosisPromise;
};
