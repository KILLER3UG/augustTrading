/**
 * v181RetryAndCraft — 100% offline unit test suite for v1.8.1:
 *   1. `retryPolicyCore` classification (`classifyTransientProviderError`) and
 *      the delay curve (`computeRetryDelayMs`), plus the `withRetry` loop's
 *      contract: 10 automatic retries on a rate-limited gateway with
 *      `Retry-After: 0`, fail-fast on billing/auth/bad-request/abort, live
 *      `onRetryAttempt` progress, and an AbortSignal that cancels the wait.
 *   2. `proposalFormatCore` — the proposal card's precision law (qty / R / % /
 *      leverage / compact USD), including the non-finite refusals.
 *   3. `commandBarCore` — the unified Ctrl+K palette's grouping and the
 *      deterministic prefix > keyword > category ranking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyTransientProviderError,
    computeRetryDelayMs,
    formatRetryProgressLine,
    transientErrorLabel,
} from '../src/utils/retryPolicyCore';
import { withRetry, withStreamOpenRetry } from '../src/utils/apiErrorUtils';
import {
    formatProposalLeverage,
    formatProposalPct,
    formatProposalQty,
    formatProposalR,
    formatProposalUsd,
} from '../src/utils/proposalFormatCore';
import {
    buildCommandBarItems,
    filterAndRankCommands,
    type CommandBarContext,
} from '../src/utils/commandBarCore';

describe('retryPolicyCore — classifyTransientProviderError', () => {
    it('classifies the KiloCode 429 relay as retryable rate_limit', () => {
        // The exact failure this release fixes: the friendly error text alone
        // (no status attached) must still ride the backoff curve.
        const cls = classifyTransientProviderError(new Error('KiloCode (HTTP 429): Provider returned error'));
        assert.equal(cls.retryable, true);
        assert.equal(cls.kind, 'rate_limit');
        assert.equal(transientErrorLabel(new Error('KiloCode (HTTP 429): Provider returned error'), cls.kind), 'Rate-limited (HTTP 429)');
    });

    it('classifies a JSON error frame ({error:{code:429}}) as retryable rate_limit', () => {
        const cls = classifyTransientProviderError({ error: { code: 429, message: 'Provider returned error' } });
        assert.equal(cls.retryable, true);
        assert.equal(cls.kind, 'rate_limit');
    });

    it('classifies 5xx / 408 / 529 / overloaded as retryable server_5xx', () => {
        for (const status of [408, 500, 502, 503, 504, 529]) {
            const cls = classifyTransientProviderError({ status, message: `HTTP ${status}` });
            assert.equal(cls.retryable, true, `status ${status}`);
            assert.equal(cls.kind, 'server_5xx', `status ${status}`);
        }
        const overloaded = classifyTransientProviderError(new Error('model overloaded, try again'));
        assert.equal(overloaded.retryable, true);
        assert.equal(overloaded.kind, 'server_5xx');
    });

    it('classifies transient network drops as retryable network', () => {
        const cls = classifyTransientProviderError(new TypeError('fetch failed'));
        assert.equal(cls.retryable, true);
        assert.equal(cls.kind, 'network');
    });

    it('refuses billing exhaustion, auth, bad request and aborts on attempt 1', () => {
        const billing = classifyTransientProviderError(new Error('insufficient credits — out of credits'));
        assert.equal(billing.retryable, false);
        assert.equal(billing.kind, 'billing_exhausted');
        // A 429-shaped quota wall is BILLING, not a rate limit: retrying a
        // paid wall ten times is the exact failure this module refuses.
        const quota = classifyTransientProviderError({ status: 429, message: 'insufficient_quota: you have run out of credits' });
        assert.equal(quota.retryable, false);
        assert.equal(quota.kind, 'billing_exhausted');

        const auth = classifyTransientProviderError({ status: 401, message: 'invalid api key' });
        assert.equal(auth.retryable, false);
        assert.equal(auth.kind, 'auth');
        const forbidden = classifyTransientProviderError({ status: 403, message: 'access denied' });
        assert.equal(forbidden.retryable, false);
        assert.equal(forbidden.kind, 'auth');

        const badRequest = classifyTransientProviderError({ status: 400, message: 'bad request' });
        assert.equal(badRequest.retryable, false);
        assert.equal(badRequest.kind, 'bad_request');
        const notFound = classifyTransientProviderError({ status: 404, message: 'model not found' });
        assert.equal(notFound.retryable, false);
        assert.equal(notFound.kind, 'bad_request');

        const abort = classifyTransientProviderError(new DOMException('The operation was aborted.', 'AbortError'));
        assert.equal(abort.retryable, false);
        assert.equal(abort.kind, 'aborted');
        const timeout = classifyTransientProviderError(new Error('request timed out'));
        assert.equal(timeout.retryable, false);
        assert.equal(timeout.kind, 'aborted');
    });

    it('extracts Retry-After from Headers-like and plain-record error shapes', () => {
        const headersShim = { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '2' : null) };
        const fromHeaders = classifyTransientProviderError({ status: 429, headers: headersShim, message: 'rate limit' });
        assert.equal(fromHeaders.retryAfterMs, 2000);
        const fromRecord = classifyTransientProviderError({ status: 429, headers: { 'retry-after': '0' }, message: 'rate limit' });
        assert.equal(fromRecord.retryAfterMs, 0);
    });
});

describe('retryPolicyCore — computeRetryDelayMs', () => {
    it('honors Retry-After exactly: 0 means retry now, positive clamps into [250ms, 30s]', () => {
        assert.equal(computeRetryDelayMs({ attempt: 1, retryAfterMs: 0 }), 0);
        assert.equal(computeRetryDelayMs({ attempt: 1, retryAfterMs: 2000 }), 2000);
        assert.equal(computeRetryDelayMs({ attempt: 1, retryAfterMs: 10 }), 250);
        assert.equal(computeRetryDelayMs({ attempt: 1, retryAfterMs: 600_000 }), 30_000);
    });

    it('rides the documented curve 1s → 2s → 4s → 8s → 12s → cap with deterministic ±20% jitter', () => {
        const noJitter = () => 0.5; // dead center: zero jitter displacement
        assert.equal(computeRetryDelayMs({ attempt: 1, jitterFn: noJitter }), 1000);
        assert.equal(computeRetryDelayMs({ attempt: 2, jitterFn: noJitter }), 2000);
        assert.equal(computeRetryDelayMs({ attempt: 3, jitterFn: noJitter }), 4000);
        assert.equal(computeRetryDelayMs({ attempt: 4, jitterFn: noJitter }), 8000);
        assert.equal(computeRetryDelayMs({ attempt: 5, jitterFn: noJitter }), 12000);
        assert.equal(computeRetryDelayMs({ attempt: 6, jitterFn: noJitter }), 15000);
        assert.equal(computeRetryDelayMs({ attempt: 9, jitterFn: noJitter }), 15000);
        // ±20%: the extremes of the jitter band.
        assert.equal(computeRetryDelayMs({ attempt: 1, jitterFn: () => 0 }), 800);
        assert.equal(computeRetryDelayMs({ attempt: 1, jitterFn: () => 0.999 }), 1200);
    });
});

describe('withRetry — the 10-retry automatic recovery loop', () => {
    it('recovers from 10 consecutive HTTP 429s on attempt 11 and reports every retry', async () => {
        let attempts = 0;
        const retries: Array<{ attempt: number; maxRetries: number; delayMs: number; reason: string }> = [];
        // Retry-After: 0 → every wait is exactly 0ms, so 11 attempts run
        // synchronously-fast with zero real sleeping.
        const rateLimited = (): Error => {
            const e = new Error('KiloCode (HTTP 429): Provider returned error');
            (e as { headers?: Record<string, string> }).headers = { 'retry-after': '0' };
            return e;
        };
        const result = await withRetry(
            async () => {
                attempts += 1;
                if (attempts <= 10) throw rateLimited();
                return 'recovered';
            },
            'KiloCode',
            11,
            undefined,
            info => retries.push(info),
        );
        assert.equal(result, 'recovered');
        assert.equal(attempts, 11);
        assert.equal(retries.length, 10);
        assert.equal(retries[0].attempt, 1);
        assert.equal(retries[9].attempt, 10);
        assert.equal(retries[9].maxRetries, 10);
        assert.equal(retries[9].delayMs, 0);
        assert.equal(retries[9].reason, 'Rate-limited (HTTP 429)');
        assert.equal(formatRetryProgressLine('KiloCode', retries[9]), 'Rate-limited (HTTP 429) — retrying KiloCode (10/10) in 0.0s…');
    });

    it('fails fast on non-retryable errors with zero retries', async () => {
        let attempts = 0;
        await assert.rejects(
            withRetry(async () => {
                attempts += 1;
                throw new Error('insufficient credits');
            }, 'Provider', 11),
            /insufficient credits/,
        );
        assert.equal(attempts, 1, 'billing exhaustion must never burn a retry');

        attempts = 0;
        await assert.rejects(
            withRetry(async () => {
                attempts += 1;
                const e = new Error('invalid api key');
                (e as { status?: number }).status = 401;
                throw e;
            }, 'Provider', 11),
            /invalid api key/,
        );
        assert.equal(attempts, 1, 'auth failures must never burn a retry');

        attempts = 0;
        await assert.rejects(
            withRetry(async () => {
                attempts += 1;
                const e = new Error('bad request');
                (e as { status?: number }).status = 400;
                throw e;
            }, 'Provider', 11),
            /bad request/,
        );
        assert.equal(attempts, 1, 'malformed requests must never burn a retry');

        attempts = 0;
        await assert.rejects(
            withRetry(async () => {
                attempts += 1;
                throw new DOMException('The operation was aborted.', 'AbortError');
            }, 'Provider', 11),
            (err: unknown) => (err as { name?: string }).name === 'AbortError',
        );
        assert.equal(attempts, 1, 'an aborted call must never burn a retry');
    });

    it('an AbortSignal cancels the retry wait immediately instead of riding it out', async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(
            withRetry(async () => {
                const e = new Error('HTTP 429');
                (e as { status?: number }).status = 429;
                throw e; // no Retry-After → the 1s backoff wait begins
            }, 'Provider', 11, controller.signal),
            (err: unknown) => (err as { name?: string }).name === 'AbortError',
        );
        // The wait was cut short — well under the full 1s backoff sleep.
        assert.ok(Date.now() - startedAt < 900, `abort took ${Date.now() - startedAt}ms`);
    });

    it('a server-instructed Retry-After is honored through the loop callback', async () => {
        const seen: number[] = [];
        await withRetry(
            async () => {
                const e = new Error('rate limit');
                (e as { status?: number }).status = 429;
                (e as { headers?: Record<string, string> }).headers = { 'retry-after': '2' };
                throw e;
            },
            'Provider',
            2,
            undefined,
            info => seen.push(info.delayMs),
        ).catch(() => undefined);
        assert.deepEqual(seen, [2000]);
    });
});

describe('withStreamOpenRetry — the streaming open-retry contract', () => {
    it('re-opens a stream that 429s before the first visible token and reports the retries', async () => {
        let opens = 0;
        const retries: Array<{ attempt: number; maxRetries: number }> = [];
        const makeStream = async function* (): AsyncGenerator<string, void, unknown> {
            opens += 1;
            if (opens <= 3) {
                const e = new Error('KiloCode (HTTP 429): Provider returned error');
                (e as { headers?: Record<string, string> }).headers = { 'retry-after': '0' };
                throw e;
            }
            yield 'answer text';
        };
        const deltas: string[] = [];
        for await (const delta of withStreamOpenRetry(makeStream, 'KiloCode', 11, undefined, info => retries.push(info))) {
            deltas.push(delta);
        }
        assert.equal(opens, 4);
        assert.deepEqual(deltas, ['answer text']);
        assert.equal(retries.length, 3);
        assert.equal(retries[2].attempt, 3);
    });

    it('never re-answers once a token has been painted', async () => {
        let opens = 0;
        const makeStream = async function* (): AsyncGenerator<string, void, unknown> {
            opens += 1;
            yield 'first paint';
            const e = new Error('HTTP 429');
            (e as { status?: number }).status = 429;
            (e as { headers?: Record<string, string> }).headers = { 'retry-after': '0' };
            throw e;
        };
        const deltas: string[] = [];
        await assert.rejects(async () => {
            for await (const delta of withStreamOpenRetry(makeStream, 'Provider', 11, undefined)) {
                deltas.push(delta);
            }
        }, /HTTP 429/);
        assert.equal(opens, 1, 'a painted stream must surface the error, not re-open');
        assert.deepEqual(deltas, ['first paint']);
    });
});

describe('proposalFormatCore — the proposal card precision law', () => {
    it('quotes sizes at the precision the decision needs', () => {
        assert.equal(formatProposalQty(0.0666667), '0.0667');
        assert.equal(formatProposalQty(0.153846), '0.154');
        assert.equal(formatProposalQty(2.5), '2.5');
        assert.equal(formatProposalQty(1.23456), '1.235');
        assert.equal(formatProposalQty(150.25), '150.3');
        assert.equal(formatProposalQty(1234.56), '1234.6');
        assert.equal(formatProposalQty(100), '100');
    });

    it('rounds R, percent and leverage to one readable figure', () => {
        assert.equal(formatProposalR(1.9067), '1.91R');
        assert.equal(formatProposalR(0), '0.00R');
        assert.equal(formatProposalPct(36.4433), '36.4%');
        assert.equal(formatProposalPct(0), '0.0%');
        assert.equal(formatProposalLeverage(0.68), '0.7x');
        assert.equal(formatProposalLeverage(10), '10x');
        assert.equal(formatProposalLeverage(20), '20x');
    });

    it('prints compact currency and refuses non-finite input with the em-dash', () => {
        assert.equal(formatProposalUsd(103), '$103');
        assert.equal(formatProposalUsd(1034.5), '$1035');
        assert.equal(formatProposalUsd(12.34), '$12.34');
        for (const fn of [formatProposalQty, formatProposalR, formatProposalPct, formatProposalLeverage, formatProposalUsd]) {
            assert.equal(fn(NaN), '—');
            assert.equal(fn(Infinity), '—');
        }
        // Zero is finite and renders as a real number, never a dash.
        assert.equal(formatProposalQty(0), '0');
        assert.equal(formatProposalR(0), '0.00R');
        assert.equal(formatProposalPct(0), '0.0%');
    });
});

describe('commandBarCore — the unified Ctrl+K palette', () => {
    const ctx: CommandBarContext = {
        planModeOn: false,
        transcriptMode: 'normal',
        chatLayout: false,
        symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'],
        timeframes: ['1m', '5m', '15m', '1h', '4h', '1D'],
        conversations: [{ id: 'c1', title: 'Funding review before NY open' }],
    };

    it('builds the grouped command list for one snapshot', () => {
        const items = buildCommandBarItems(ctx);
        const ids = items.map(i => i.id);
        for (const expected of [
            'toggle-plan-mode', 'cycle-transcript-mode', 'toggle-chart-focus', 'switch-layout', 'new-chat',
            'symbol:BTCUSDT', 'symbol:ETHUSDT', 'timeframe:4h',
            'run-compact', 'run-dream', 'run-context', 'run-doctor', 'settings-models', 'settings-data',
            'conversation:c1',
        ]) {
            assert.ok(ids.includes(expected), `missing ${expected}`);
        }
        assert.equal(items.find(i => i.id === 'toggle-plan-mode')?.detail, 'OFF');
        assert.equal(items.find(i => i.id === 'toggle-chart-focus')?.hint, 'Ctrl+\\');
    });

    it('ranks prefix matches first for plan, 4h, eth and bench', () => {
        const items = buildCommandBarItems(ctx);
        assert.equal(filterAndRankCommands(items, 'plan')[0]?.id, 'toggle-plan-mode');
        assert.equal(filterAndRankCommands(items, '4h')[0]?.id, 'timeframe:4h');
        assert.equal(filterAndRankCommands(items, 'eth')[0]?.id, 'symbol:ETHUSDT');
        assert.equal(filterAndRankCommands(items, 'bench')[0]?.id, 'settings-models');
    });

    it('ranks a keyword-only match and the transcript cycle command', () => {
        const items = buildCommandBarItems(ctx);
        // "audit" lives in the cycle command's keywords, not its label.
        assert.equal(filterAndRankCommands(items, 'audit')[0]?.id, 'cycle-transcript-mode');
        // "compact" is a label prefix.
        assert.equal(filterAndRankCommands(items, 'compact')[0]?.id, 'run-compact');
    });

    it('an empty query returns the full grouped list; a dead query returns nothing', () => {
        const items = buildCommandBarItems(ctx);
        assert.deepEqual(filterAndRankCommands(items, ''), items);
        assert.deepEqual(filterAndRankCommands(items, 'zzzz-no-such-command'), []);
    });
});
