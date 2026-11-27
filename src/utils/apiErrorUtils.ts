/**
 * API Error Utilities
 * Provides consistent error handling and user-friendly messages across all AI providers
 *
 * Retry DECISIONS and delays live in `utils/retryPolicyCore.ts` (the single
 * source); this file owns the retry LOOPS (`withRetry` for whole calls,
 * `withStreamOpenRetry` for the open of a streaming generator) on top of it.
 */

import {
    RetryAttemptInfo,
    classifyTransientProviderError,
    computeRetryDelayMs,
    transientErrorLabel,
} from './retryPolicyCore';

// Provider display names are runtime-configured (user-entered ProviderConfig
// names) — a fixed union would go stale (legacy 'Groq Alt' / 'Binance' entries)
// and lie for custom providers, so error branding takes a plain string.
export type ProviderName = string;

export interface ParsedAPIError {
    type: 'rate_limit' | 'quota_exceeded' | 'invalid_key' | 'network' | 'timeout' | 'server' | 'unknown';
    message: string;
    retryAfterSeconds?: number;
    provider: ProviderName;
}

/**
 * Parse API error into user-friendly message.
 * Message mapping ONLY — retry decisions and delays live in
 * `utils/retryPolicyCore.ts`; do not branch retry logic off this shape.
 */
export const parseAPIError = (error: any, provider: ProviderName): ParsedAPIError => {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorStatus = error?.status || error?.response?.status;

    // Rate Limit (429)
    if (errorStatus === 429 || errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
        // Only trust a real Retry-After header. SDK errors expose headers as a
        // Headers object (no array access), and a missing/NaN value used to
        // fall back to 30s — stalling the pipeline for 30s per attempt. Use a
        // short 1s default so transient bursts recover quickly.
        const headers = error?.headers;
        const headerRaw = headers?.get ? headers.get('retry-after') : headers?.['retry-after'];
        const headerParsed = parseInt(headerRaw, 10);
        const retryAfterSeconds = Number.isFinite(headerParsed) && headerParsed >= 0 ? headerParsed : 1;
        return {
            type: 'rate_limit',
            message: `${provider} rate limit reached. Retrying in ${retryAfterSeconds}s...`,
            retryAfterSeconds,
            provider
        };
    }

    // Quota Exceeded (403 or specific message)
    if (errorStatus === 403 || errorMessage.includes('quota') || errorMessage.includes('billing') || errorMessage.includes('exceeded')) {
        return {
            type: 'quota_exceeded',
            message: `${provider} quota exceeded. Try switching to another AI provider in Settings.`,
            provider
        };
    }

    // Invalid API Key (401)
    if (errorStatus === 401 || errorMessage.includes('api key') || errorMessage.includes('unauthorized') || errorMessage.includes('authentication')) {
        return {
            type: 'invalid_key',
            message: `${provider} API key is invalid or expired. Check your API key in Settings → Providers.`,
            provider
        };
    }

    // Timeout — a request that burned its full budget (or was aborted by the
    // Electron main-process timer) is wedged; retrying it immediately only
    // extends the stall. Previously these were classified 'network' and
    // retried 3× at 300s each → a ~15-minute hang on desktop.
    if (
        error?.name === 'TimeoutError'
        || errorMessage.includes('timed out')
        || errorMessage.includes('timeout')
        || errorMessage.includes('the operation was aborted') // Electron main-side abort of a hung request
    ) {
        return {
            type: 'timeout',
            message: `${provider} request timed out. The provider may be overloaded — try again shortly.`,
            provider
        };
    }

    // Network Error — connection-level failures (not timeouts), retryable.
    if (
        errorMessage.includes('network')
        || errorMessage.includes('fetch')
        || errorMessage.includes('econnrefused')
        || errorMessage.includes('enotfound')
        || errorMessage.includes('failed to connect')
        || errorMessage.includes('certificate')
        || errorMessage.includes('tls')
    ) {
        return {
            type: 'network',
            message: `Network error connecting to ${provider}. Check your internet connection.`,
            provider
        };
    }

    // Server Error (500+)
    if (errorStatus >= 500) {
        return {
            type: 'server',
            message: `${provider} server error. The service may be temporarily unavailable.`,
            provider
        };
    }

    // Unknown error — do not expose raw SDK/network text, which may contain
    // URLs, request payloads, or provider response bodies.
    return {
        type: 'unknown',
        message: `${provider} request failed. Check the provider settings and try again.`,
        provider
    };
};

/**
 * Sleep that rejects early if the AbortSignal fires.
 */
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
        }

        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
        };

        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });
};

/**
 * Retry wrapper for AI provider API calls.
 *
 * - Classifies failures with `classifyTransientProviderError` (retryPolicyCore —
 *   the single source for what is retryable).
 * - Waits through `computeRetryDelayMs`: server `Retry-After` honored, else
 *   capped exponential backoff with ±20% jitter.
 * - Fails fast on non-retryable errors (billing, auth, bad request, abort).
 * - Aborts immediately (no retry, no backoff wait) when `signal` is aborted.
 * - Reports each automatic retry through `onRetryAttempt` BEFORE the wait so
 *   a caller can paint live progress; clicking Stop aborts the wait.
 *
 * @param fn            The async API call to execute.
 * @param provider      Provider label used for classification and logging.
 * @param maxAttempts   Total number of attempts — 11 under the default policy
 *                      (10 automatic retries), from `retryAttemptsForPolicy`.
 * @param signal        Optional AbortSignal to cancel in-flight retries/waits.
 * @param onRetryAttempt Optional live-progress callback, fired per retry.
 */
export const withRetry = async <T>(
    fn: () => Promise<T>,
    provider: ProviderName,
    maxAttempts: number = 4,
    signal?: AbortSignal,
    onRetryAttempt?: (info: RetryAttemptInfo) => void
): Promise<T> => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Caller cancelled - never retry or wait.
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }

            const classified = classifyTransientProviderError(error);
            // Fail fast on non-retryable errors or when out of attempts.
            // (attempt is 0-based here; the retry the trader is told about is
            // attempt+1 of maxRetries = maxAttempts-1.)
            if (!classified.retryable || attempt === maxAttempts - 1) {
                throw error;
            }

            const delay = computeRetryDelayMs({
                attempt: attempt + 1,
                retryAfterMs: classified.retryAfterMs,
            });
            onRetryAttempt?.({
                attempt: attempt + 1,
                maxRetries: maxAttempts - 1,
                delayMs: delay,
                reason: transientErrorLabel(error, classified.kind),
            });
            console.warn(
                `[${provider}] Attempt ${attempt + 1}/${maxAttempts} failed (${classified.kind}): ` +
                `retrying in ${Math.round(delay / 100) / 10}s...`
            );

            await abortableSleep(delay, signal);
        }
    }

    throw lastError;
};

/**
 * Retry the OPEN of a streaming generator.
 *
 * Streaming transports (SDK, dev proxy, Electron bridge) yield text deltas;
 * a retryable failure (429, `Provider returned error`, 5xx, network drop)
 * that lands BEFORE the first visible output token may be retried by simply
 * re-opening the stream — the trader has seen nothing yet. Once a delta has
 * been painted, `painted` is set and any later failure surfaces as-is:
 * re-answering would append a SECOND reply on top of the first.
 *
 * One `maxAttempts` budget owns the whole open sequence, mirroring
 * `withRetry`'s semantics (11 attempts = 10 automatic retries under the
 * default policy), with the same classification, delay curve and
 * `onRetryAttempt` contract.
 */
export async function* withStreamOpenRetry<T>(
    makeStream: () => AsyncGenerator<T, void, unknown>,
    provider: ProviderName,
    maxAttempts: number,
    signal: AbortSignal | undefined,
    onRetryAttempt?: (info: RetryAttemptInfo) => void
): AsyncGenerator<T, void, unknown> {
    let retries = 0;
    for (;;) {
        let painted = false;
        try {
            for await (const delta of makeStream()) {
                painted = true;
                yield delta;
            }
            return;
        } catch (error) {
            // Painted output must never be re-answered on top of.
            if (painted) throw error;
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            const classified = classifyTransientProviderError(error);
            retries += 1;
            if (!classified.retryable || retries > maxAttempts - 1) throw error;

            const delay = computeRetryDelayMs({
                attempt: retries,
                retryAfterMs: classified.retryAfterMs,
            });
            onRetryAttempt?.({
                attempt: retries,
                maxRetries: maxAttempts - 1,
                delayMs: delay,
                reason: transientErrorLabel(error, classified.kind),
            });
            console.warn(
                `[${provider}] Stream open failed (${classified.kind}), retry ` +
                `${retries}/${maxAttempts - 1} in ${Math.round(delay / 100) / 10}s...`
            );
            await abortableSleep(delay, signal);
        }
    }
}
