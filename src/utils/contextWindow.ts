/**
 * contextWindow — what the app believes about a model's context window, and
 * what that belief may be used for.
 *
 * Two different questions were being answered with one number. `ProviderConfig
 * .contextWindowTokens` (Settings → Providers) sized how much retrieved memory
 * to INJECT, and `utils/tokenEstimate.ts` fell back to 65,536 when it was unset.
 * Nothing anywhere asked the other question — "how much history may I put on
 * the wire before the provider refuses?" — so a long Chat conversation or a
 * tool-heavy desk turn sent an ever-growing message array and the failure
 * surfaced as an error, or as an answer that never arrives.
 *
 * So this module resolves ONE window from three sources, best evidence first,
 * and says which one won:
 *
 *   1. `user`     — the number typed in Settings → Providers. An override is an
 *                   override: it beats everything, including a provider that
 *                   says otherwise, because the trader may be routing through a
 *                   gateway that truncates the window on purpose.
 *   2. `measured` — a limit this app read out of the provider's OWN rejection of
 *                   a previous request (see `contextLengthLimitFromError`). The
 *                   strongest evidence there is: the wire said the number, so
 *                   the provider explicitly REPORTED and ENFORCED it.
 *   3. `default`  — 1,000,000 (owner ruling, 2026-10-20; reaffirmed 2026-11-23
 *                   after live compaction thrash).
 *
 * ## Why a `/models`-reported window does NOT shrink the window
 *
 * A catalog entry (`modelContextWindows`, captured at discovery) is a claim the
 * provider PUBLISHED, not a limit it ENFORCED on this app. Trusting one bit the
 * app into a ~16k effective window for a 1M gateway model, and the tool loop
 * compacted the CURRENT turn's fresh tool results at ~14k estimated tokens —
 * the seat re-fetched what it had just been handed, every round (the 2026-11-23
 * Kilocode · Ernie thrash). So a published number is recorded for display but
 * never sizes the wire: the 1M default holds, and a provider that actually
 * enforces a smaller window teaches the app its real limit through the
 * rejection path (`measured`), which self-corrects after one retried turn.
 *
 * ## Why the default may be optimistic now
 *
 * 65,536 was conservative, and conservatism was load-bearing for INJECTION
 * sizing only: every injection budget is `min(cap, window × fraction)`, and both
 * caps already bind at 65,536 (`memoryWindowBudget` 2 %/900 tokens, market
 * packet 10 %/6,000 tokens). Raising the default therefore changes no injected
 * byte — `tests/contextWindow.test.ts` pins that. What the default is now used
 * for is the OUTBOUND ceiling, and an optimistic ceiling is only safe because
 * two things back it up: automatic compaction
 * (`services/providers/contextCompact.ts`) keeps the prompt inside the resolved
 * window, and a provider that refuses anyway is read for its stated limit,
 * remembered as `measured`, and the turn retried once. A wrong guess is
 * self-correcting instead of fatal — which is the whole reason 1M is affordable
 * here when it would not have been as an injection assumption.
 */

import type { ProviderConfig } from '../types/provider';

/** The owner's assumed window when nothing better is known (2026-10-20). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * Room kept back from the window for things the estimator cannot see: the
 * provider's own chat template, tool schemas (which are NOT part of the message
 * array and so are never counted by `estimateMessagesTokens`), and the small
 * per-request framing the estimator already adds per message but not per tool.
 */
export const WIRE_FRAMING_SAFETY_TOKENS = 4_096;

/** The output budget the transport puts on the wire when a caller names none
 *  (`max_tokens ?? 4096` in all four request builders). A ceiling must reserve
 *  the number the request will actually claim, so an absent or unusable reserve
 *  falls back to THIS rather than to zero: reserving nothing buys prompt room
 *  the answer then cannot use, which is the failure this module exists to
 *  prevent. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;

/** How many recent turns compaction must never collapse, whatever the budget.
 *  The current question, the seat's answer to it and the tool results it is
 *  reasoning over are the minimum a turn needs to stay on-topic. */
export const MIN_KEEP_MESSAGES = 6;

export type ContextWindowSource = 'user' | 'measured' | 'default';

export interface ResolvedContextWindow {
    tokens: number;
    source: ContextWindowSource;
    /** One line for the trader: where this number came from. A window that
     *  decides how much of their history survives must never be presented as
     *  though it were measured when it was assumed. */
    label: string;
}

/** The keys `resolveContextWindow` needs, so a caller may pass a subset. */
export type ContextWindowInput = Pick<
    ProviderConfig,
    'contextWindowTokens' | 'modelContextWindows' | 'selectedModel'
> & { id?: string; name?: string };

const positiveInt = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return Math.floor(v);
};

// ─── Measured limits (learned from a rejection) ─────────────────────────────

/** providerId + modelId → the limit that provider stated. Session-scoped on
 *  purpose: a gateway's window is a property of the deployment, and a restart
 *  that forgets it re-learns it from the first rejection at the cost of one
 *  retried turn — which is cheaper than storing a number a provider may have
 *  changed behind our back. */
const measuredWindows = new Map<string, number>();

const measurementKey = (providerId: string, modelId: string): string =>
    `${providerId}::${modelId}`;

/** Record a window the provider itself stated, so the next turn believes it.
 *  Clamped to the same plausible band as `contextLengthLimitFromError`: a
 *  misread number persists, and a 4-token window would compact every later turn
 *  into nothing — worse than not remembering at all. */
export const recordMeasuredContextWindow = (
    providerId: string,
    modelId: string,
    tokens: number,
): void => {
    if (!modelId || !Number.isFinite(tokens)) return;
    const n = Math.floor(tokens);
    if (n < 512 || n > 100_000_000) return;
    measuredWindows.set(measurementKey(providerId || '', modelId), n);
};

export const measuredContextWindow = (providerId: string, modelId: string): number | null => {
    if (!modelId) return null;
    return measuredWindows.get(measurementKey(providerId || '', modelId)) ?? null;
};

/** Test seam. */
export const resetMeasuredContextWindows = (): void => { measuredWindows.clear(); };

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * The window to hold this call to, and the evidence that earned it.
 *
 * Order: user override → measured limit (a limit the provider itself enforced
 * in a rejection) → the 1M default. A `/models`-published window is NOT in
 * this ladder — see the header — because a published number the provider has
 * not enforced against this app must never shrink the wire below the default.
 * Each step is a strictly weaker claim about THIS model, and the source is
 * returned rather than discarded because the UI has to say which one it is
 * relying on.
 */
export const resolveContextWindow = (config: ContextWindowInput): ResolvedContextWindow => {
    const override = positiveInt(config.contextWindowTokens);
    if (override) {
        return { tokens: override, source: 'user', label: `your override · ${override.toLocaleString()} tokens` };
    }
    const measured = measuredContextWindow(config.id ?? '', config.selectedModel);
    if (measured) {
        return {
            tokens: measured,
            source: 'measured',
            label: `stated by ${config.name ?? 'the provider'} in a rejected request · ${measured.toLocaleString()} tokens`,
        };
    }
    return {
        tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        source: 'default',
        label: `assumed · ${DEFAULT_CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens (this model has not stated one)`,
    };
};

/**
 * How early auto-compaction fires, as a share of the effective window.
 *
 * 90% (owner ruling, 2026-11-23): the estimate is a heuristic, so the last
 * 10% is margin — but a trigger far below it (the old de-facto behaviour,
 * which compacted a 1M model at ~14k tokens) starves the turn and traps the
 * seat in a re-fetch loop. On a 1M model this is 900,000 tokens; it is NEVER
 * a fixed small number.
 */
export const COMPACTION_TRIGGER_RATIO = 0.9;

/**
 * The largest prompt this call may carry.
 *
 * Two bounds, whichever is tighter:
 *  - the COMPACTION TRIGGER — 90% of the window (`COMPACTION_TRIGGER_RATIO`),
 *    so a long conversation is refitted before it nears the wire's real limit;
 *  - `window − output reserve − framing`, because the output budget and the
 *    provider's own template ride the same window.
 * Floored at 1,024 tokens: a call with a window too small to hold a reply
 * still has to send *something*, and a zero or negative ceiling would ask the
 * compactor to delete the turn it is answering. The reserve is the request's
 * own output budget — thinking counts inside it, which is exactly why a
 * heavy-thinking model truncates rather than overflows.
 */
export const promptTokenCeiling = (
    windowTokens: number,
    outputReserveTokens: number,
): number => {
    const w = positiveInt(windowTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const r = positiveInt(outputReserveTokens) ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    const wireFit = w - r - WIRE_FRAMING_SAFETY_TOKENS;
    const trigger = Math.floor(w * COMPACTION_TRIGGER_RATIO);
    return Math.max(1_024, Math.min(trigger, wireFit));
};

/**
 * How much output the wire can still afford after this prompt and the framing
 * reserve. A request whose prompt fits but whose `max_tokens` exceeds this is
 * still over the model's window: the output budget is part of the request, so
 * the compactor must size it against the same window.
 *
 * A result of `0` means the harness cannot fit even a one-token reply; the
 * caller must not send the request as if it fit.
 */
export const outputTokenBudget = (
    windowTokens: number,
    promptTokens: number,
    framingTokens = WIRE_FRAMING_SAFETY_TOKENS,
): number => {
    const w = positiveInt(windowTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const p = Math.max(0, Math.floor(Number.isFinite(promptTokens) ? promptTokens : 0));
    const f = positiveInt(framingTokens) ?? WIRE_FRAMING_SAFETY_TOKENS;
    return Math.max(0, w - p - f);
};

// ─── Reading a provider's own limit out of a rejection ──────────────────────

/**
 * Context-window rejections are the one error class where the provider states
 * the number we needed, in its message text. The phrasings below are the ones
 * these four wire families actually emit; each captures the LIMIT, not the
 * prompt size, because "200000 tokens > 128000 maximum" contains two numbers
 * and the smaller is the window.
 */
const LIMIT_PATTERNS: RegExp[] = [
    // OpenAI / most OpenAI-compatible gateways.
    /maximum context length is\s*\(?([\d,]+)\)?\s*tokens?/i,
    /max(?:imum)? context length of\s*\(?([\d,]+)\)?\s*tokens?/i,
    /context length is\s*\(?([\d,]+)\)?\s*tokens?/i,
    // "prompt is too long: 210000 tokens > 200000 maximum" (Anthropic).
    />\s*([\d,]+)\s*maximum/i,
    /prompt is too long[^0-9]*([\d,]+)\s*(?:tokens?|characters?).*?max/i,
    // llama.cpp / vLLM / Ollama / Gemini shapes. `[\s_]` because the same
    // quantity is spelled `context_size` by one server and `context size` by
    // another, and `\D{0,12}` is the "is / = / length (" gap between them.
    /(?:n_ctx|context[\s_]+(?:size|window|length)|max[\s_]+context[\s_]+length|model[\s_]+context[\s_]+window|max[\s_]+model[\s_]+len|input[\s_]+token[\s_]+limit)\D{0,12}([\d,]+)/i,
    /(?:context window|context of)\D{0,20}([\d,]+)\s*tokens?/i,
    /\b(?:exceeds?|over|beyond)\b[^0-9]{0,30}?(?:context|input|token)[^0-9]{0,20}([\d,]+)/i,
];

const toNumber = (raw: string): number => Number(raw.replace(/,/g, ''));

/**
 * Fallback for phrasings that CLASSIFY (see `isContextLengthError`) but whose
 * number is not captured by a named pattern above — e.g. "token count exceeds
 * 32768" or "supports a maximum of 32768 context tokens". Take the smallest
 * plausible integer (1 and 0 are prompt sizes, not windows), preferring one
 * sitting next to maximum / limit / window / context when several qualify.
 */
const LIMIT_KEYWORD_RE = /\b(?:maximum|max|limit|window|context)\b/gi;
const fallbackLimitFromError = (text: string): number | null => {
    const numbers = [...text.matchAll(/\d[\d,]*/g)]
        .map(m => ({ value: toNumber(m[0]), index: m.index ?? 0, width: m[0].length }))
        .filter(n => Number.isFinite(n.value) && n.value >= 512 && n.value <= 100_000_000);
    if (numbers.length === 0) return null;
    const keywords = [...text.matchAll(LIMIT_KEYWORD_RE)].map(m => ({
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
    }));
    const adjacent = numbers.filter(n => keywords.some(k =>
        k.end >= n.index - 32 && k.start <= n.index + n.width + 32));
    const pool = adjacent.length > 0 ? adjacent : numbers;
    return Math.min(...pool.map(n => Math.floor(n.value)));
};

/**
 * The window a provider's error text states, or null.
 *
 * Clamped to a plausible band: `1` and `0` show up in these messages as the
 * prompt size or the token count of an empty message, and a window of 4 tokens
 * would make every later request compact to nothing — a wrong-but-bounded
 * reading is worse than no reading, because it persists.
 */
export const contextLengthLimitFromError = (message: string | null | undefined): number | null => {
    const text = (message || '').toString();
    if (!text) return null;
    if (!isContextLengthError(text)) return null;
    for (const pattern of LIMIT_PATTERNS) {
        const m = pattern.exec(text);
        const n = m ? toNumber(m[1]) : NaN;
        if (Number.isFinite(n) && n >= 512 && n <= 100_000_000) return Math.floor(n);
    }
    return fallbackLimitFromError(text);
};

/** Does this provider error say "your prompt does not fit the window"?
 *  Deliberately narrow: rate limits and payload-size rejections also say
 *  "too long", and compacting history does nothing for either. */
export const isContextLengthError = (message: string | null | undefined): boolean =>
    /context[\s_]+(?:length|size|window|token)|maximum context|prompt is too long|too many tokens|token count|context overflow|input is too long|request payload too large|invalid_request.{0,80}token/i
        .test((message || '').toString());
