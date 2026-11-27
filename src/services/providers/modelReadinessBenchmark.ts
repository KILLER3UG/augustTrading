/**
 * modelReadinessBenchmark — lazy-loaded live runner for the 6-case trading-desk
 * model readiness benchmark in Settings → AI setup (`ProviderManager`).
 *
 * Dynamically imported ONLY when the user clicks "Benchmark model" so the eager
 * startup chunk stays completely unaffected.
 */

import type { ModelReadinessBenchmark, ProviderConfig } from '../../types/provider';
import { getQuickResponse } from './GenericProviderService';
import {
    gradeBenchmarkResponses,
    MODEL_READINESS_BENCHMARK_CASES,
    type BenchmarkCaseId,
    type BenchmarkCaseResponse,
} from './modelReadinessBenchmarkCore';

export interface BenchmarkProgress {
    completed: number;
    total: number;
    currentCaseId: BenchmarkCaseId;
}

const PER_CASE_TIMEOUT_MS = 15_000;

export const runModelReadinessBenchmark = async (
    config: ProviderConfig,
    modelId: string,
    onProgress?: (progress: BenchmarkProgress) => void,
    signal?: AbortSignal,
): Promise<ModelReadinessBenchmark> => {
    const probeConfig: ProviderConfig = {
        ...config,
        selectedModel: modelId,
    };
    const total = MODEL_READINESS_BENCHMARK_CASES.length;
    const responses: BenchmarkCaseResponse[] = [];

    for (let i = 0; i < total; i += 1) {
        const spec = MODEL_READINESS_BENCHMARK_CASES[i];
        onProgress?.({ completed: i, total, currentCaseId: spec.id });
        if (signal?.aborted) {
            responses.push({ id: spec.id, text: '', latencyMs: 0, error: 'Aborted' });
            continue;
        }
        const t0 = performance.now();
        const caseCtrl = new AbortController();
        const timer = setTimeout(() => caseCtrl.abort(), PER_CASE_TIMEOUT_MS);
        const onParentAbort = (): void => caseCtrl.abort();
        signal?.addEventListener('abort', onParentAbort, { once: true });
        try {
            const text = await getQuickResponse(probeConfig, spec.userPrompt, spec.systemPrompt, {
                maxTokens: spec.maxTokens,
                temperature: 0,
                reasoningEffort: 'low',
                signal: caseCtrl.signal,
            });
            responses.push({
                id: spec.id,
                text,
                latencyMs: Math.max(0, Math.round(performance.now() - t0)),
            });
        } catch (err) {
            responses.push({
                id: spec.id,
                text: '',
                latencyMs: Math.max(0, Math.round(performance.now() - t0)),
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onParentAbort);
        }
    }

    onProgress?.({ completed: total, total, currentCaseId: MODEL_READINESS_BENCHMARK_CASES[total - 1].id });
    return gradeBenchmarkResponses(responses);
};
