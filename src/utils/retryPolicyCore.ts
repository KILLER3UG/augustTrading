/**
 * Retry Policy Core — the ONE classifier and delay curve for provider errors.
 *
 * Every retry decision in the app (the `withRetry` loop around non-streaming
 * calls and the open-of-stream retry around streaming generators) classifies
 * failures through `classifyTransientProviderError` and waits through
 * `computeRetryDelayMs`. Keeping the two in one pure module is the
 * single-source ruling: a second delay formula or a second retryable-check
 * is how the transports drift into hammering a rate-limited gateway.
 *
 * Pure by contract (see `docs/engineering/conventions.md`): no React, no DOM,
 * no window, no network. Errors arrive as unknown shapes — SDK APIErrors,
 * bridge Errors carrying `.status`, parsed JSON error frames — and this
 * module must classify all of them without throwing.
 */

export type TransientErrorKind =
    | 'rate_limit'
    | 'upstream_provider'
    | 'server_5xx'
    | 'network'
    | 'billing_exhausted'
    | 'auth'
    | 'bad_request'
    | 'aborted';

export interface TransientErrorClassification {
    retryable: boolean;
    kind: TransientErrorKind;
    /** Server-provided `Retry-After` converted to milliseconds, when the
     *  failure carried a parseable one. `0` is meaningful ("retry now"). */
    retryAfterMs?: number;
}

/** One automatic retry, fired BEFORE the wait starts so a caller can paint
 *  live progress (`Rate-limited (HTTP 429) — retrying KiloCode (2/10)…`). */
export interface RetryAttemptInfo {
    /** 1-based: this is retry N of `maxRetries`. */
    attempt: number;
    /** Total automatic retries configured (total attempts − 1). */
    maxRetries: number;
    delayMs: number;
    /** Short human label for the failure, e.g. `Rate-limited (HTTP 429)`. */
    reason: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** First finite number among the candidates (null/undefined skipped). */
const firstNumber = (...candidates: unknown[]): number | undefined => {
    for (const c of candidates) {
        if (typeof c === 'number' && Number.isFinite(c)) return c;
    }
    return undefined;
};

/** A status riding the message text (`(HTTP 429):`, `failed (500).`,
 *  `status: 503`) — transports that forget to attach `.status` still say it
 *  in prose, and the classification must not depend on which one survived. */
const STATUS_TEXT_RE = /(?:https?\s*\(?\s*|\bfailed\s*\(\s*|\bstatus\s*[:=]\s*)(\d{3})\b/i;
const statusFromText = (lower: string): number | undefined => {
    const match = STATUS_TEXT_RE.exec(lower);
    if (!match) return undefined;
    const status = Number(match[1]);
    return Number.isFinite(status) ? status : undefined;
};

/** `Retry-After` from a Headers object or a plain record, in milliseconds.
 *  HTTP-date forms parse to NaN and yield undefined — the backoff curve then
 *  applies instead of guessing a wait the server did not state. */
const extractRetryAfterMs = (err: Record<string, unknown> | null): number | undefined => {
    const headers = err?.headers as unknown;
    if (!headers) return undefined;
    let raw: unknown;
    if (typeof (headers as Headers).get === 'function') {
        raw = (headers as Headers).get('retry-after');
    } else if (typeof headers === 'object') {
        raw = (headers as Record<string, unknown>)['retry-after'];
    }
    const seconds = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

/**
 * Classify a provider failure as retryable or not.
 *
 * Retryable (transient — the same call may succeed on a later attempt):
 * rate limits (HTTP 429 in any rendering, `rate limit`, `too many requests`,
 * JSON error frames with `code: 429`), upstream relays (`Provider returned
 * error`), server-side failures (408/500/502/503/504/529, `overloaded`),
 * and transient network drops (fetch failed, ECONNREFUSED, TLS resets).
 *
 * NOT retryable — fail immediately on the first attempt: caller aborts and
 * burned-budget timeouts (`aborted`; a wedged request retried immediately
 * only extends the stall), billing/credit exhaustion (`insufficient_quota`,
 * `insufficient credits`, `out of credits`, `billing`, `spend limit`, 402),
 * auth failures (401/403), malformed requests (400/404/422), and anything
 * the classifier cannot vouch for — refused when thin, not retried on hope.
 */
export const classifyTransientProviderError = (error: unknown): TransientErrorClassification => {
    const err = asRecord(error);
    // JSON error frames ({error:{code,message}}) and fetch wrappers
    // ({response:{status}}) nest the facts one level down.
    const inner = asRecord(err?.error);
    const response = asRecord(err?.response);
    const name = typeof err?.name === 'string' ? err.name : '';
    const code: unknown = err?.code ?? inner?.code;

    // 1. Cancellation family, checked first: an abort or a request that
    //    burned its full timeout budget is a wedge, not a blip.
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') {
        return { retryable: false, kind: 'aborted' };
    }

    const messageParts = [err?.message, inner?.message]
        .filter((part): part is string => typeof part === 'string' && part.length > 0);
    const lower = messageParts.join(' ').toLowerCase();

    // Timeout prose (main-process aborts surface as plain text on some
    // transports) — same wedge ruling as the named errors above.
    if (/\btimed? ?out\b|the operation was aborted/.test(lower)) {
        return { retryable: false, kind: 'aborted' };
    }

    const status = firstNumber(err?.status, response?.status, inner?.status) ?? statusFromText(lower);

    // 2. Billing/credit exhaustion — a paid wall does not lift by retrying.
    //    Checked BEFORE rate limit: OpenAI-shaped 429s carry
    //    `insufficient_quota` and must fail fast, not ride the backoff curve.
    if (
        status === 402
        || code === 'insufficient_quota'
        || lower.includes('insufficient_quota')
        || lower.includes('insufficient credits')
        || lower.includes('out of credits')
        || lower.includes('spend limit')
        || lower.includes('billing')
    ) {
        return { retryable: false, kind: 'billing_exhausted' };
    }

    // 3. Auth — a bad key fails identically on every retry. The wording is
    //    matched SPECIFICALLY, never a bare "api key": gateways phrase their
    //    own 429s as "Rate limit exceeded for your API key", and a bare
    //    substring filed a genuine rate limit as a permanent auth wall.
    //    A 429 status is the wire's word for rate limit and wins over any
    //    auth-looking prose.
    if (
        status !== 429
        && (status === 401
            || status === 403
            || /unauthorized|invalid api key|missing api key|incorrect api key|expired api key|authentication failed/.test(lower))
    ) {
        return { retryable: false, kind: 'auth' };
    }

    // 4. Rate limit — the case this module exists for. Status, wire code, or
    //    any human-readable rendering of it (`(HTTP 429):` from the friendly
    //    mapper, `failed (429)` from the proxy open).
    if (
        status === 429
        || code === 429
        || String(code) === '429'
        || String(code).includes('rate_limit')
        || /\b429\b/.test(lower)
        || lower.includes('rate limit')
        || lower.includes('too many requests')
    ) {
        return { retryable: true, kind: 'rate_limit', retryAfterMs: extractRetryAfterMs(err) };
    }

    // 5. Upstream relay — a gateway answering for a dead upstream
    //    ("Provider returned error"). The upstream may recover next attempt.
    if (lower.includes('provider returned error') || lower.includes('upstream')) {
        return { retryable: true, kind: 'upstream_provider' };
    }

    // 6. Server-side failure — 408/500/502/503/504/529, overload prose.
    if (
        (typeof status === 'number' && (status === 408 || status === 529 || status >= 500))
        || code === 'overloaded_error'
        || /overloaded|internal server error|bad gateway|service unavailable/.test(lower)
    ) {
        return { retryable: true, kind: 'server_5xx' };
    }

    // 7. Transient network drops — connection-level, not request-level.
    if (
        /network|fetch|econnrefused|enotfound|econnreset|epipe|failed to connect|certificate|\btls\b|socket/.test(lower)
    ) {
        return { retryable: true, kind: 'network' };
    }

    // 8. Everything else — including 400/404/422 — is refused: an error the
    //    classifier cannot vouch for must not burn ten retries on hope.
    return { retryable: false, kind: 'bad_request' };
};

/** Short human label for one retryable failure — the head of the live
 *  progress line. Carries the HTTP status when one resolved. */
export const transientErrorLabel = (error: unknown, kind: TransientErrorKind): string => {
    const err = asRecord(error);
    const inner = asRecord(err?.error);
    const response = asRecord(err?.response);
    const lower = [err?.message, inner?.message]
        .filter((part): part is string => typeof part === 'string')
        .join(' ')
        .toLowerCase();
    const status = firstNumber(err?.status, response?.status, inner?.status) ?? statusFromText(lower);
    switch (kind) {
        case 'rate_limit':
            return status ? `Rate-limited (HTTP ${status})` : 'Rate-limited';
        case 'server_5xx':
            return status ? `Server error (HTTP ${status})` : 'Server error';
        case 'upstream_provider':
            return 'Upstream provider error';
        case 'network':
            return 'Network error';
        case 'billing_exhausted':
            return 'Billing exhausted';
        case 'auth':
            return status ? `Auth error (HTTP ${status})` : 'Auth error';
        case 'bad_request':
            return status ? `Bad request (HTTP ${status})` : 'Bad request';
        case 'aborted':
            return 'Aborted';
    }
};

export interface RetryDelayInput {
    /** 1-based retry number — the first wait is attempt 1. */
    attempt: number;
    /** Server-instructed wait in milliseconds (from `Retry-After`). */
    retryAfterMs?: number;
    /** Backoff base, default 1s. */
    baseMs?: number;
    /** Backoff ceiling, default 15s. */
    maxMs?: number;
    /** Uniform [0,1) source, default Math.random. Injectable so tests pin
     *  the exact delay. */
    jitterFn?: () => number;
}

/**
 * One retry wait, in milliseconds.
 *
 * A server-instructed `Retry-After` is honored EXACTLY — `0` means retry
 * now, and a positive value is clamped only into a sane window ([250ms,
 * 30s]) so a 10-minute quota reset cannot stall the turn loop. Jitter does
 * not apply to the server's instruction.
 *
 * Otherwise: capped exponential backoff 1s → 2s → 4s → 8s → 12s → cap
 * (15s default), each wait ±20% jitter. Ensemble seats share gateway quota;
 * a deterministic curve wakes every 429'd seat in lockstep and trips the
 * limiter again, so the wake-ups must spread.
 */
export const computeRetryDelayMs = (input: RetryDelayInput): number => {
    const { retryAfterMs, baseMs = 1000, maxMs = 15_000, jitterFn = Math.random } = input;
    const attempt = Math.max(1, Math.floor(input.attempt));

    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
        if (retryAfterMs <= 0) return 0;
        return Math.round(Math.min(Math.max(retryAfterMs, 250), 30_000));
    }

    // Doubling rides up to the fourth attempt; the last stretch rises
    // gently to the cap (8s → 12s → 15s) instead of jumping from 8s to the
    // full cap, so an early-overload recovery still escalates in steps.
    const relativeSteps = [1, 2, 4, 8, 12];
    const base = attempt <= relativeSteps.length
        ? Math.min(baseMs * relativeSteps[attempt - 1], maxMs)
        : maxMs;
    const jitter = 1 + (Math.min(Math.max(jitterFn(), 0), 1) * 2 - 1) * 0.2;
    return Math.round(Math.max(base * jitter, 0));
};

/** The live progress line a caller paints while a retry wait runs:
 *  `Rate-limited (HTTP 429) — retrying KiloCode (2/10) in 2.0s…` */
export const formatRetryProgressLine = (provider: string, info: RetryAttemptInfo): string =>
    `${info.reason} — retrying ${provider} (${info.attempt}/${info.maxRetries}) in ${(info.delayMs / 1000).toFixed(1)}s…`;
