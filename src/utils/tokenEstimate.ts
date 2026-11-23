/**
 * Token estimation, deliberately biased HIGH.
 *
 * The app previously sized prompt content with `chars / 4` (see
 * `truncateTextToTokens`). Two problems with that:
 *
 *   1. It under-counts non-Latin text badly. A CJK character is typically one
 *      token, not a quarter of one — a Chinese strategy note is under-read by
 *      up to 4x, and an under-estimate does not fail loudly, it just delays
 *      compaction until the provider returns a 4xx.
 *   2. It treats every character as equal weight, so URLs, numbers and
 *      base64-ish identifiers (which tokenize into more pieces than plain
 *      English) get the same allowance as prose.
 *
 * Over-estimating costs a little unused context. Under-estimating costs a
 * failed analysis run. So every heuristic here rounds the other way.
 *
 * This is an estimate, not a tokenizer. Where a provider reports actual usage
 * we record it (`observePromptRatio`) and prefer the measured ratio for the
 * rest of the session, which is the cheap version of anchoring on real usage.
 */

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './contextWindow';

/** Fallback assumption when a provider declares no window.
 *
 * 1,000,000 (owner ruling, 2026-10-20) — and the number is SAFE here only
 * because every injection budget this feeds is `min(cap, window × fraction)`
 * and both caps already bind well below 1M: 2 %/900 tokens for retrieved
 * memory, 10 %/6,000 for the market packet. Raising it therefore changes no
 * injected byte; `tests/contextWindow.test.ts` pins that claim rather than
 * trusting it. It used to be 65,536 ("half of 128K, conservative on purpose")
 * which was the right assumption for the same reason: the caps bound at 45K
 * and above, so below them the fraction, not the default, decided.
 * See `utils/contextWindow.ts` for what the window is used for NOW — the
 * outbound ceiling — and for the compaction plus the measured-limit fallback
 * that make an optimistic ceiling survivable. */
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

/** Historical chars-per-token used across the app. Kept as the floor of the
 *  estimate so this module never budgets MORE optimistically than before. */
const ASCII_CHARS_PER_TOKEN = 4;

/** A CJK / fullwidth codepoint is very nearly one token on its own. */
const WIDE_CHARS_PER_TOKEN = 1.1;

/**
 * Characters that tend to split into more tokens than a letter would
 * (digits, punctuation, symbol runs). Counted at half weight.
 */
const DENSE_CHAR_RE = /[\d{}[\]()/\\"'`.,;:|_#$%&*+=<>?^~/]/;

const isWide = (code: number): boolean =>
    // CJK unified + extensions, kana, hangul, fullwidth forms, CJK punctuation.
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x323af);

/** Bounded content-hash cache for repeated identical strings (tool payload
 *  headers, skill bodies, stable prompt blocks). Estimation walks every
 *  codepoint; a transcript reuses the same strings across turns, so a cache
 *  pays for itself without ever changing the estimate. */
const ESTIMATE_CACHE_MAX = 1_024;
const ESTIMATE_CACHE_MAX_CHARS = 8_192;
const estimateCache = new Map<string, number>();

/** Test seam. */
export const resetTokenEstimateCache = (): void => { estimateCache.clear(); };

/**
 * Estimate the token count of a string. Iterates codepoints so surrogate
 * pairs count as one wide character rather than two ASCII ones.
 */
export const estimateTokens = (text: string | null | undefined): number => {
    if (!text) return 0;
    const cached = text.length <= ESTIMATE_CACHE_MAX_CHARS ? estimateCache.get(text) : undefined;
    if (cached !== undefined) return cached;
    let tokens = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (isWide(code)) {
            tokens += 1 / WIDE_CHARS_PER_TOKEN;
        } else if (DENSE_CHAR_RE.test(ch)) {
            // ~2x a letter: digits and punctuation tokenize into more pieces.
            tokens += 1 / 2;
        } else {
            tokens += 1 / ASCII_CHARS_PER_TOKEN;
        }
    }
    // Per-message framing overhead, so a budget of N messages is not N*N.
    const result = Math.ceil(tokens) + 4;
    if (text.length <= ESTIMATE_CACHE_MAX_CHARS) {
        if (estimateCache.size >= ESTIMATE_CACHE_MAX) {
            estimateCache.delete(estimateCache.keys().next().value as string);
        }
        estimateCache.set(text, result);
    }
    return result;
};

/**
 * The ratio actually in force. The constant is the CEILING, not the default to
 * be beaten: a provider reporting that its text cost fewer tokens per character
 * than assumed must not buy a bigger slice than `chars / 4` would have, because
 * every caller reads this as "how much can I safely send". A dense measurement
 * (CJK, JSON) is allowed to shrink the allowance; a favourable one never grows
 * it. That is what keeps the header's two promises — prefer the measurement,
 * never budget more optimistically than before — from contradicting each other.
 */
const effectiveCharsPerToken = (): number => ASCII_CHARS_PER_TOKEN;
/** WHY THIS IGNORES THE MEASUREMENT, and why that is not the same as the bug
 *  it replaces. `observePromptRatio` divides the characters of the messages
 *  array by a `promptTokens` that ALSO counts system framing and every tool
 *  schema on the wire. The quotient therefore describes the gap between those
 *  two sets, not the text, and it is biased low by construction — one
 *  CJK-dense prompt measures ~1.0 and, because the value is a sticky module
 *  global, would have pinned `charsForTokens` at a quarter of its size for the
 *  rest of the session, silently starving the memory injected into every later
 *  debate. Consuming it was tried on 2026-09-22 and reverted for exactly that
 *  reason. The measurement stays wired as an observable, and consuming it is
 *  safe only once numerator and denominator describe the same payload — which
 *  needs the full wire length, not the message text. See also
 *  `tests/tokenEstimate.test.ts`, which pins the floor this function used to
 *  be able to undercut. */

/**
 * How many characters fit in `tokens`, using the WORST case (most chars per
 * token is best case; we want the smallest char count that still fits).
 * A conservative divisor means the resulting slice is always safe to send.
 */
export const charsForTokens = (tokens: number): number =>
    Math.max(0, Math.floor(tokens * effectiveCharsPerToken()));

/** Inverse: how many estimated tokens a character allowance holds. */
export const tokensForChars = (chars: number): number =>
    Math.floor(chars / effectiveCharsPerToken());

// ─── Optional measurement anchor ────────────────────────────────────────────

let measuredCharsPerToken: number | null = null;

/**
 * Feed a provider's own reported usage back in, so later estimates for
 * similarly-shaped text use the observed ratio instead of the constant.
 * Clamped to a sane band — a garbage usage frame must not make the estimator
 * recklessly optimistic.
 */
export const observePromptRatio = (promptTokens: number, charCount: number): void => {
    if (!Number.isFinite(promptTokens) || !Number.isFinite(charCount)) return;
    if (promptTokens <= 0 || charCount <= 0) return;
    const ratio = charCount / promptTokens;
    if (ratio < 0.5 || ratio > 8) return;
    measuredCharsPerToken = ratio;
};

export const observedCharsPerToken = (): number | null => measuredCharsPerToken;

/** Reset for tests. */
export const resetObservedRatio = (): void => { measuredCharsPerToken = null; };

/**
 * A fraction-of-window budget, clamped by a floor and a ceiling.
 *
 * `min(fraction * window, cap)` mirrors how a mature harness sizes an
 * always-on block: it scales with the model instead of with a hard-coded
 * constant, but the cap stops a 1M-context model from being sent an
 * unbounded amount of retrieved memory.
 */
export const windowBudgetTokens = (
    fraction: number,
    capTokens: number,
    contextWindowTokens: number = DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
): number => Math.max(
    // A floor keeps tiny/legacy windows from switching memory off entirely.
    Math.min(capTokens, 300),
    Math.min(capTokens, Math.floor(contextWindowTokens * fraction)),
);
