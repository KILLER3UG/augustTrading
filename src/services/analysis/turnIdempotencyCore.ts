/**
 * turnIdempotencyCore — pure in-memory write-tool idempotency ledger keyed by
 * `(turnIntentKey, toolName, canonicalArgsHash)`.
 *
 * Prevents duplicate mutating side-effects (`paper_order`, `watch_price`,
 * `memory`, `skill_manage`, `draw_on_chart`) across SSE drops, transport
 * retries, or harness-echo retries within the same user turn.
 *
 * Zero React, DOM, `window`, storage, or network imports (`check:boundaries`).
 */

import { canonicalizeArgsForHash, coerceToolArguments } from './toolArgCoercionCore';

export const IDEMPOTENT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
    'paper_order',
    'watch_price',
    'memory',
    'skill_manage',
    'draw_on_chart',
]);

export interface TurnIdempotencyReceipt {
    ok: boolean;
    content: string;
    recordedAt: number;
}

const MAX_LEDGER_ENTRIES = 256;
const ledger = new Map<string, TurnIdempotencyReceipt>();

export const isIdempotentMutatingTool = (toolName: string): boolean =>
    IDEMPOTENT_MUTATING_TOOLS.has(toolName);

export const buildTurnIdempotencyKey = (
    turnIntentKey: string,
    toolName: string,
    args: unknown,
): string => {
    const normalizedArgs = args && typeof args === 'object' && !Array.isArray(args)
        ? coerceToolArguments(toolName, args as Record<string, unknown>).args
        : (args ?? {});
    return `${turnIntentKey.trim()}::${toolName}::${canonicalizeArgsForHash(normalizedArgs)}`;
};

/**
 * Look up a previously succeeded mutating call for the same `(turnIntentKey,
 * toolName, canonicalArgsHash)`. Returns `null` on miss or non-mutating tools.
 */
export const checkTurnIdempotency = (
    turnIntentKey: string | undefined,
    toolName: string,
    args: unknown,
): TurnIdempotencyReceipt | null => {
    const intent = (turnIntentKey ?? '').trim();
    if (!intent || !isIdempotentMutatingTool(toolName)) return null;
    const key = buildTurnIdempotencyKey(intent, toolName, args);
    return ledger.get(key) ?? null;
};

/**
 * Record a successful mutating tool execution under `(turnIntentKey, toolName,
 * canonicalArgsHash)`. Failed calls are deliberately NOT cached so bounded
 * self-correction can retry with fixed inputs.
 */
export const recordTurnIdempotency = (
    turnIntentKey: string | undefined,
    toolName: string,
    args: unknown,
    result: { ok: boolean; content: string },
    nowMs = Date.now(),
): void => {
    const intent = (turnIntentKey ?? '').trim();
    if (!intent || !result.ok || !isIdempotentMutatingTool(toolName)) return;
    const key = buildTurnIdempotencyKey(intent, toolName, args);
    ledger.delete(key); // refresh insertion order
    ledger.set(key, {
        ok: true,
        content: result.content,
        recordedAt: nowMs,
    });
    while (ledger.size > MAX_LEDGER_ENTRIES) {
        const oldest = ledger.keys().next();
        if (oldest.done) break;
        ledger.delete(oldest.value);
    }
};

/** Clear one turn's entries (by prefix) or the entire ledger (for tests). */
export const clearTurnIdempotency = (turnIntentKey?: string): void => {
    if (!turnIntentKey) {
        ledger.clear();
        return;
    }
    const prefix = `${turnIntentKey.trim()}::`;
    for (const key of [...ledger.keys()]) {
        if (key.startsWith(prefix)) ledger.delete(key);
    }
};
