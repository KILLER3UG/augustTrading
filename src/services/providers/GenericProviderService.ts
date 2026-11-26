/**
 * GenericProviderService — Universal AI provider client supporting 4 API formats.
 *
 * Formats:
 * - chat_completions: OpenAI-compatible /chat/completions (most providers)
 * - messages: Anthropic-style /v1/messages
 * - responses: OpenAI Responses API /responses
 * - google: Gemini generateContent
 *
 * Capabilities:
 * - Non-streaming chat (`sendChatRequest`)
 * - Streaming chat (`streamChatRequest`) — async generator
 * - Multimodal/vision content (image_url parts)
 * - JSON response mode (`response_format: { type: 'json_object' }`)
 * - AbortSignal support
 */

import OpenAI from 'openai';
import { ProviderConfig } from '../../types/provider';
import { withRetry, ProviderName } from '../../utils/apiErrorUtils';
import { assertValidProviderUrl } from '../../utils/providerUrlValidation';
import {
    anthropicCachedSystem,
    anthropicShouldSendThinking,
    anthropicThinkingFields,
    claudeThinkingBudgetTokens,
    extractReasoningPayload,
    extractReasoningFields,
    mergeReasoningParts,
    splitChatContentPayload,
    geminiThinkingParams,
    MIN_EFFECTIVE_THINKING_TOKENS,
    requestReasoningSideChannel,
    ANTHROPIC_API_VERSION,
    DEV_PROVIDER_PROXY_PATH,
    PROVIDER_REQUEST_TIMEOUT_MS,
    PROVIDER_STREAM_TIMEOUT_MS,
} from '../../../shared/providerRequestPolicy.cjs';

import { recordProviderSuccess, recordProviderError } from '../infrastructure/ProviderHealthService';
import { applyReasoningToChatParams, buildReasoningPatch, detectWireCapabilities } from './reasoningControls';
import { resolveModelOverride, retryAttemptsForPolicy } from './modelCatalogCore';
// Side-effect import: harnessLessons registers the wire-route pin checker
// into reasoningControls at module init (harness-lesson read path). Importing here (the
// transport) guarantees the registration happens before any reasoning patch
// is built — harnessLessons imports buildReasoningPatch from
// reasoningControls, so the checker flows in through this module instead of
// a static cycle.
import '../learning/harnessLessons';
import { extractFinishReason, FinishReason, normalizeFinishReason, recordFinishReason, truncatesOutput } from '../../utils/finishReason';
import { compactForWire } from './contextCompact';
import { contextLengthLimitFromError, recordMeasuredContextWindow } from '../../utils/contextWindow';
import { emitTokenUsage, extractTokenUsage, TokenUsage } from '../../utils/tokenUsage';
import { observePromptRatio } from '../../utils/tokenEstimate';
import type { ElectronUpdateStatus } from '../../types/electron';
import { chatMessagesToGemini, googleGenerateUrl, parseGeminiResponse } from '../../utils/googleGeminiFormat';
import { createThinkingStreamGate, extractAndStripThinkBlocks } from '../../utils/thinkingSplit';
import { REASONING_CHANNEL_PROMPT } from '../../constants/prompts/chatPrompts';
interface ElectronProviderBridge {
    isElectron?: boolean;
        providerChat?: (request: {
        config: ProviderConfig;
        messages: ChatMessage[];
        requestId?: string;
        maxTokens?: number;
        temperature?: number;
        jsonMode?: boolean;
        /** Composer effort tier — the out-of-process transports (Electron
         *  bridge + dev proxy) gate/scale the Claude thinking block from this
         *  via shared/providerRequestPolicy.cjs. Without it the proxies could
         *  only ever use the fixed historical budget and ignored 'off'. */
        reasoningEffort?: NonNullable<ChatRequestOptions['reasoningEffort']>;
        /** Pre-resolved (capability-checked) constrained-decoding schema for
         *  chat_completions; undefined = never send json_schema. */
        jsonSchema?: ChatRequestOptions['jsonSchema'];
        tools?: ChatRequestOptions['tools'];
        toolChoice?: ChatRequestOptions['toolChoice'];
        /** Effort-derived wire fields (reasoningControls) — merged into the
         *  request body main-process-side, mirroring the vite proxy's
         *  reasoningPatch. Without it desktop ran thinking-default gateways
         *  at their provider default regardless of the composer tier. */
        reasoningPatch?: Record<string, unknown>;
        /** Opt into live SSE: main parses the response stream and pushes
         *  deltas over `provider:chunk` while the invoke promise still
         *  resolves with the accumulated final result. */
        stream?: boolean;
    }) => Promise<{ ok: boolean; text?: string; reasoning?: string; usage?: TokenUsage; toolCalls?: ChatTurnResult['toolCalls']; assistantMessage?: ChatMessage; /** Raw provider stop signal (finish_reason / stop_reason / status / finishReason), normalized renderer-side. */ finishReason?: string; status?: number; code?: string; message?: string }>;
    /** Subscribe to streamed deltas of a stream:true providerChat call. */
    onProviderChunk?: (callback: (chunk: { requestId: string; type: 'text' | 'reasoning'; delta: string }) => void) => (() => void) | void;
    cancelProviderChat?: (requestId: string) => Promise<boolean>;
    discoverModels?: (config: {
        baseUrl: string;
        apiKey: string;
        apiFormat: ProviderConfig['apiFormat'];
    }) => Promise<{ ok: boolean; status?: number; body?: string; message?: string }>;
    // ── App / auto-update / secret-encryption surface (preload.cjs). Declared
    // here so the ambient Window.electronAPI is complete: consumers (the update
    // hook, ProviderConfigService) read `window.electronAPI.*` typed instead of
    // re-casting to `(window as any)`. ──
    platform?: string;
    setTitleBarOverlay?: (opts: { color?: string; symbolColor?: string; height?: number }) => Promise<boolean>;
    getVersion?: () => Promise<string>;
    checkForUpdates?: () => Promise<ElectronUpdateStatus | null>;
    downloadUpdate?: () => Promise<ElectronUpdateStatus | null>;
    installUpdate?: () => Promise<ElectronUpdateStatus | null>;
    getUpdateStatus?: () => Promise<ElectronUpdateStatus | null>;
    /** Fired by the restart-animation overlay once it has played. */
    quitNow?: () => void;
    /** Subscribe to pushed status; returns an unsubscribe (or void). */
    onUpdateStatus?: (callback: (status: ElectronUpdateStatus) => void) => (() => void) | void;
    /** safeStorage (OS keychain) encrypt/decrypt for API keys at rest. */
    encryptSecret?: (plaintext: string) => Promise<string | null>;
    decryptSecret?: (payload: string) => Promise<string | null>;
    /** Repo bridge (preload `repo`) — the model's read/edit/apply access to
     *  August's own checkout. DEV ONLY; main enforces the sandbox. */
    repo?: {
        info: () => Promise<{ ok: true; available: boolean; root?: string; reason?: string } | { ok: false; error: string }>;
        list: (rel?: string) => Promise<{ ok: boolean; path?: string; entries?: Array<{ path: string; dir: boolean }>; error?: string }>;
        read: (rel: string) => Promise<{ ok: boolean; path?: string; content?: string; error?: string }>;
        write: (rel: string, content: string) => Promise<{ ok: boolean; path?: string; checkpoint?: string; error?: string }>;
        apply: () => Promise<{ ok: boolean; code?: number; output?: string; error?: string; applied?: string }>;
        setup: () => Promise<{ ok: boolean; root?: string; step?: string; note?: string; output?: string; error?: string }>;
    };
}

declare global {
    interface Window {
        electronAPI?: ElectronProviderBridge;
    }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single message part — text or image. */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** A chat message. `content` may be a plain string or an array of content parts (vision). */
export interface ChatMessage {
    role: string;
    content: string | ContentPart[] | null;
    /** OpenAI-style tool calls on assistant turns. */
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    /** OpenAI-style tool result linkage. */
    tool_call_id?: string;
    name?: string;
}

export interface ChatRequestOptions {
    maxTokens?: number;
    temperature?: number;
    /** Request JSON object output (chat_completions only uses response_format). */
    jsonMode?: boolean;
    /** Abort signal for cancellation. */
    signal?: AbortSignal;
    onReasoning?: (reasoning: string) => void;
    /** Fired when a prefilled template emits a closing `</think>` with no opening tag. */
    onOrphanThinkClose?: () => void;
    onUsage?: (usage: TokenUsage) => void;
    /** Why the model stopped, normalized across all four wire formats. Fires
     *  once per completed call. 'length' means the answer was cut off, which a
     *  caller parsing the tail of the text has to know. */
    onFinishReason?: (reason: FinishReason) => void;
    /** OpenAI-style tool definitions (chat_completions). */
    tools?: Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
        };
    }>;
    toolChoice?: 'auto' | 'none' | 'required';
    /** chat_completions streaming: when the model answers with native tool
     *  calls, the SSE deltas are accumulated and delivered here ONCE at end
     *  of stream (complete name + parsed JSON arguments). Text deltas still
     *  yield normally — the desk-tool loop uses this to stream AND loop. */
    onStreamToolCalls?: (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) => void;
    /** Constrained decoding (chat_completions, capability-gated): sends
     *  response_format json_schema with the given object-root JSON Schema
     *  instead of plain json_object. Non-strict — the zod boundary stays
     *  the validator; a rejected format degrades (json_object → none), it
     *  never blocks the call. Ignored by the other wire formats. */
    jsonSchema?: { name?: string; schema: Record<string, unknown> };
    /** The outbound history was compacted to fit this model's context window.
     *  Fires on the automatic recovery path only (a provider that rejected the
     *  request and stated its limit), and never mid-stream — a retry happens
     *  only before the first delta. A caller that paints a transcript should
     *  show the line: the seat's request lost bytes, and a silent rewrite of
     *  the trader's own history is the kind of thing this app names. */
    onContextCompact?: (line: string) => void;
}

export interface ChatTurnResult {
    text: string;
    reasoning: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    /** Raw assistant message for appending into a tool loop (chat_completions). */
    assistantMessage?: ChatMessage;
    /** Why the model stopped, normalized across wire formats. 'unknown' means
     *  the gateway sent no signal — NOT that it stopped cleanly. */
    finishReason: FinishReason;
    /** The answer was cut off at the token ceiling. Consumers must not treat a
     *  truncated body as complete: the verdict parser and the CONVICTION probe
     *  both read the tail of the text. */
    truncated: boolean;
}

/** Report the normalized stop signal: the run-level tally, plus the inline
 *  callback for a caller that needs the value now. There is deliberately no
 *  global listener bus here — the tally and the callback are the two readers,
 *  and a third (a subscriber list nothing ever subscribed to) is how this file
 *  grew write-only code once before. */
function reportFinishReason(config: ProviderConfig, reason: FinishReason, options?: ChatRequestOptions): void {
    // The per-run sink wins: a run must only ever count its OWN requests. The
    // global tally stays as the fallback for a transport nobody bracketed
    // (the 2026-10-27 audit L-7).
    if (options?.onFinishReason) options.onFinishReason(reason);
    else recordFinishReason(reason);
    // The sink was called above; a second call doubled every run's tally.
}

/** Extract, report and return the stop signal from any response body shape. */
function observeFinishReason(
    config: ProviderConfig,
    data: unknown,
    options?: ChatRequestOptions,
): { finishReason: FinishReason; truncated: boolean } {
    const reason = extractFinishReason(data) ?? 'unknown';
    reportFinishReason(config, reason, options);
    return { finishReason: reason, truncated: truncatesOutput(reason) };
}

/** Text volume actually sent, so a measured usage frame can be turned into a
 *  chars-per-token ratio. Reasoning payloads and image parts are included
 *  because they occupy the same window the budget is drawn from. */
function messageTextLength(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') chars += m.content.length;
        else if (Array.isArray(m.content)) {
            // Narrow on the discriminator rather than reading both branches:
            // an image part costs roughly a few hundred tokens of vision
            // embedding, which 1500 chars over-estimates on purpose.
            for (const part of m.content) chars += part.type === 'text' ? part.text.length : 1500;
        }
        chars += (m as { tool_calls?: unknown }).tool_calls ? 200 : 0;
    }
    return chars;
}

function reportUsage(
    config: ProviderConfig,
    data: unknown,
    options?: ChatRequestOptions,
    messages?: ChatMessage[],
): void {
    const usage = extractTokenUsage(data);
    if (!usage) return;
    options?.onUsage?.(usage);
    emitTokenUsage({ providerId: config.id, modelId: config.selectedModel, usage });
    // Calibrate the context-budget estimator against this provider's OWN count.
    // `utils/tokenEstimate` deliberately over-estimates in the absence of data;
    // once a gateway reports real prompt tokens there is no reason to keep
    // guessing, and a mis-guess costs either truncated memory or a 4xx.
    if (messages?.length && usage.promptTokens > 0) {
        observePromptRatio(usage.promptTokens, messageTextLength(messages));
    }
}

function reportUsageDirect(
    config: ProviderConfig,
    usage: TokenUsage | undefined,
    options?: ChatRequestOptions,
    /** Every Electron chat call takes the bridge and lands here, so without
     *  this the context-budget estimator was never calibrated on the shipped
     *  desktop app — only on web, which uses `reportUsage` instead. */
    messages?: ChatMessage[],
): void {
    if (!usage) return;
    // Coerce, don't just pass through. A truthy object with missing or
    // non-numeric fields (an un-normalized snake_case payload from a transport,
    // or any future one) used to reach mergeTokenUsage, where `0 + undefined`
    // produced NaN for the whole run ledger — and `estimateCostUsd(NaN) ?? 0`
    // then made shouldSkipRemaining() always false, silently disabling the
    // per-debate spend cap. Normalized upstream AND refused here, so one bad
    // transport cannot take the cost guard down with it.
    const promptTokens = Number(usage.promptTokens);
    const completionTokens = Number(usage.completionTokens);
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return;
    const safe: TokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens: Number.isFinite(Number(usage.totalTokens))
            ? Number(usage.totalTokens)
            : promptTokens + completionTokens,
    };
    options?.onUsage?.(safe);
    emitTokenUsage({ providerId: config.id, modelId: config.selectedModel, usage: safe });
    if (messages?.length && usage.promptTokens > 0) {
        observePromptRatio(usage.promptTokens, messageTextLength(messages));
    }
}

// ─── Thinking / Chain-of-Thought Extraction ──────────────────────────────────

/**
 * Normalize a provider reasoning payload to a string. OpenAI-compatible
 * gateways disagree on the shape: `reasoning_content` (DeepSeek), `reasoning`
 * (Qwen/Kimi), sometimes as an array of strings (`reasoning: ["..."]`).
 * Every variant funnels into the same onReasoning side channel.
 */
export function extractReasoning(value: unknown): string {
    return extractReasoningPayload(value);
}

/** Pull public text vs thinking out of chat-completions `content` (string or parts). */
export function splitChatContent(content: unknown): { text: string; reasoning: string } {
    if (typeof content === 'string') {
        const split = extractAndStripThinkBlocks(content);
        return { text: split.visible, reasoning: split.leaked };
    }
    if (!Array.isArray(content)) return { text: '', reasoning: '' };
    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const part of content) {
        if (typeof part === 'string') {
            texts.push(part);
            continue;
        }
        if (!part || typeof part !== 'object') continue;
        const block = part as { type?: string; thought?: boolean; thinking?: string; text?: string };
        const type = String(block.type || '');
        if (type === 'thinking' || type === 'reason' || type === 'reasoning' || block.thought === true) {
            const inner = block.thinking || block.text || '';
            if (inner.trim()) thoughts.push(inner);
            continue;
        }
        if (typeof block.text === 'string' && block.text) texts.push(block.text);
    }
    const stripped = extractAndStripThinkBlocks(texts.join('\n'));
    return {
        text: stripped.visible,
        reasoning: [...thoughts, stripped.leaked].filter(Boolean).join('\n'),
    };
}

function deltaReasoning(delta: {
    reasoning_content?: unknown;
    reasoning?: unknown;
    reasoning_text?: unknown;
    thinking?: unknown;
    thought?: unknown;
    reasoning_details?: unknown;
    content?: unknown;
}): string {
    const fromField = extractReasoningFields(delta);
    if (!Array.isArray(delta?.content)) return fromField;
    let fromParts = '';
    for (const part of delta.content) {
        if (!part || typeof part !== 'object') continue;
        const block = part as { type?: string; thought?: boolean; thinking?: string; text?: string };
        const type = String(block.type || '');
        if (type === 'thinking' || type === 'reason' || type === 'reasoning' || block.thought === true) {
            const inner = block.thinking ?? block.text ?? '';
            if (typeof inner === 'string') fromParts += inner;
        }
    }
    if (!fromField) return fromParts;
    if (!fromParts) return fromField;
    return `${fromField}${fromParts}`;
}

function deltaVisibleText(delta: { content?: unknown }): string {
    if (typeof delta?.content === 'string') return delta.content;
    if (!Array.isArray(delta?.content)) return '';
    let out = '';
    for (const part of delta.content) {
        if (typeof part === 'string') {
            out += part;
            continue;
        }
        if (!part || typeof part !== 'object') continue;
        const block = part as { type?: string; thought?: boolean; text?: string };
        const type = String(block.type || '');
        if (type === 'thinking' || type === 'reason' || type === 'reasoning' || block.thought === true) continue;
        if (typeof block.text === 'string') out += block.text;
    }
    return out;
}

// `requestReasoningSideChannel` now lives in shared/providerRequestPolicy.cjs
// and is imported below. It used to be a private copy HERE, which meant the
// PACKAGED APP never sent the flag: the dock asks electron/main.cjs to build
// the provider request, and main.cjs had no idea this existed. The same seat
// therefore returned its thinking on the web and not on the desktop — the
// Thinking row simply stayed empty, with no error anywhere to explain it. The
// shared policy module is the one file the renderer, the vite proxy and
// electron/main.cjs all import; that is the whole point of it.

/**
 * Extract the chain of thought from an Anthropic-style messages response.
 * Thinking arrives as `{type:'thinking', thinking, signature}` content blocks
 * (returned only when the request enabled extended thinking); redacted blocks
 * are surfaced as a marker so the user knows the provider withheld part of it.
 */
export function extractMessagesThinking(content: unknown): string {
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            parts.push(block.thinking.trim());
        } else if (block?.type === 'redacted_thinking') {
            parts.push('[Thinking redacted by provider]');
        }
    }
    return parts.join('\n');
}

/**
 * Extract the chain of thought from an OpenAI Responses API payload.
 * Reasoning arrives as `output` items of type `reasoning` — full text in
 * `content` (output_text blocks), the public summary in `summary`
 * (summary_text blocks). Both are captured; some gateways emit only one.
 */
export function extractResponsesReasoning(output: unknown): string {
    if (!Array.isArray(output)) return '';
    const parts: string[] = [];
    for (const item of output) {
        if (item?.type !== 'reasoning') continue;
        if (Array.isArray(item.content)) {
            for (const block of item.content) {
                if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
            }
        }
        if (Array.isArray(item.summary)) {
            for (const block of item.summary) {
                if (block?.type === 'summary_text' && typeof block.text === 'string') parts.push(block.text);
            }
        }
    }
    return parts.join('\n');
}

/**
 * The ONE reader of a provider's raw response body.
 *
 * The localhost dev proxy hands the provider's own JSON back untouched, so
 * both proxy call paths need the same per-format extraction — and they had
 * drifted: the request path joined an array `message.content`, the turn path
 * passed the array itself through as `text`, and only one of them split an
 * inline think block out of the visible answer. One reader means a fifth wire
 * format, or a fix to one of the four, happens in one place.
 *
 * `statedReasoning` is what the proxy itself reported; when it is silent the
 * body is asked, per format, where that provider hides its thinking.
 */
export const readWireBody = (
    format: ProviderConfig['apiFormat'],
    data: any,
    statedReasoning?: string,
): { text: string; reasoning: string } => {
    const stated = statedReasoning || '';
    if (format === 'messages') {
        const rawText = Array.isArray(data.content)
            ? data.content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n')
            : data.text || '';
        const stripped = extractAndStripThinkBlocks(rawText);
        const rawThinking = stated || extractMessagesThinking(data.content);
        const reasoning = [rawThinking, stripped.leaked].filter(Boolean).join('\n\n');
        return { text: stripped.visible, reasoning };
    }
    if (format === 'responses') {
        const stripped = extractAndStripThinkBlocks(data.output_text || '');
        const rawThinking = stated || extractResponsesReasoning(data.output);
        const reasoning = [rawThinking, stripped.leaked].filter(Boolean).join('\n\n');
        return { text: stripped.visible, reasoning };
    }
    if (format === 'google') {
        const parsed = parseGeminiResponse(data);
        const stripped = extractAndStripThinkBlocks(parsed.text);
        const rawThinking = stated || parsed.reasoning;
        const reasoning = [rawThinking, stripped.leaked].filter(Boolean).join('\n\n');
        return { text: stripped.visible, reasoning };
    }
    // chat_completions: the proxy returns `reasoning` itself, so this only
    // matters when it did not — and the answer may be an array of parts, or
    // carry an inline think block in the string.
    const message = data.choices?.[0]?.message || {};
    const split = splitChatContent(message.content);
    const nativeReasoning = stated || extractReasoningFields(message);
    return {
        text: split.text,
        reasoning: mergeReasoningParts([nativeReasoning, split.reasoning], '\n\n'),
    };
};

// ─── Dev-proxy routing ───────────────────────────────────────────────────────

/**
 * The vite DEV SERVER is the only runtime that serves /__provider_proxy
 * (it's registered in configureServer). A packaged Capacitor WebView ALSO
 * reports hostname 'localhost' — routing its provider calls to that path
 * POSTed at a non-existent middleware and every call 404'd. Only dev may
 * take the proxy; packaged mobile/web fall through to the direct-call
 * branches. Deliberately NOT a full mirror of ProviderConfigService.fetchProviderCatalog's
 * guard: that one ALSO excludes VITEST, while this one keeps the proxy branch
 * live under tests on purpose — the transport suites (devProxyRouting,
 * providerPayloads, desktopProviderParity) mock fetch and must be able to
 * reach this branch in jsdom, whereas a catalog fetch under vitest has no
 * dev server to talk to at all and must not be attempted.
 */
export function usesDevProviderProxy(): boolean {
    // `import.meta.env` only exists under a bundler (Vite injects it). A
    // plain-node context — the runtime-wiring E2E harness, a future CLI
    // runner — has none, and reading `.DEV` off undefined crashed the whole
    // request instead of just skipping the proxy branch.
    return Boolean(import.meta.env?.DEV)
        && typeof window !== 'undefined'
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
}

// ─── Extended Thinking (request side) ───────────────────────────────────────

/**
 * ALL extended-thinking / budget / temperature rules live in
 * shared/providerRequestPolicy.cjs — the single source consumed identically
 * by this renderer transport, the vite dev proxy, and electron/main.cjs.
 * (Before that module these rules were hand-copied three times and had
 * verifiably drifted: stale model-id regex, fixed 0.35 budget, missing
 * temperature on the proxies. The wrappers below stay exported because the
 * wire tests import them.
 */

/** Anthropic budget_tokens for a call: effort-scaled, clamped to
 *  1024 <= budget < max_tokens. Exported for wire tests. */
export function thinkingBudgetTokens(maxTokens: number, effort?: string): number {
    return claudeThinkingBudgetTokens(maxTokens, effort);
}

/**
 * Whether to request extended thinking on an Anthropic messages call
 * (delegates the whole gate — JSON-mode exclusion, the composer's 'off'
 * tier, the 1024-token floor, and the model-id list/`thinkingCapable`
 * override — to the shared policy module).
 */
export function shouldRequestExtendedThinking(config: ProviderConfig, options?: ChatRequestOptions): boolean {
    if (config.apiFormat !== 'messages') return false;
    return anthropicShouldSendThinking({
        modelId: config.selectedModel || '',
        displayName: config.name,
        capabilityOverride: config.thinkingCapable,
        maxTokens: options?.maxTokens,
        jsonMode: options?.jsonMode,
        reasoningEffort: options?.reasoningEffort,
    });
}

// ─── URL Normalization Helper ───────────────────────────────────────────────

/**
 * Normalizes base URLs by stripping trailing slashes and format-specific endpoint suffixes.
 * This ensures that pasting full endpoint URLs (e.g. ending in /chat/completions) works properly.
 */
export function normalizeBaseUrl(url: string, _format?: string): string {
    let clean = (url || '').trim().replace(/\/+$/, '');
    if (!clean) return '';

    for (const suffix of ['/chat/completions', '/messages', '/responses']) {
        if (clean.endsWith(suffix)) {
            clean = clean.substring(0, clean.length - suffix.length);
            break;
        }
    }
    return clean;
}

/**
 * Warm a provider's connection before it is actually needed (perceived speed).
 * Fires a cheap no-cors HEAD at the provider origin so the browser completes
 * DNS + TCP + TLS and keeps the socket in its connection pool. When the real
 * verdict/analysis request lands moments later, it reuses the warm socket and
 * skips the handshake latency. Never throws, never consumes tokens, and is a
 * no-op on Electron (main process owns its own sockets) and on the localhost
 * dev proxy (already same-origin warm).
 */
export function warmProviderConnection(config: ProviderConfig): void {
    try {
        if (typeof window === 'undefined' || typeof fetch !== 'function') return;
        const electronAPI = (window as { electronAPI?: { isElectron?: boolean } }).electronAPI;
        if (electronAPI?.isElectron) return;
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return;
        const base = normalizeBaseUrl(config.baseUrl, config.apiFormat);
        if (!base) return;
        let origin: string;
        try {
            origin = new URL(base).origin;
        } catch {
            return;
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 3000);
        fetch(origin, { method: 'HEAD', mode: 'no-cors', signal: controller.signal })
            .catch(() => undefined)
            .finally(() => window.clearTimeout(timer));
    } catch {
        // Warm-up is best-effort; never surface an error.
    }
}

// ─── Client Factory ─────────────────────────────────────────────────────────

/**
 * Create an OpenAI SDK client for chat_completions providers.
 * maxRetries: 0 — the SDK's own retry loop (default 2) multiplied with
 * withRetry(fn, 3) here, sending up to 9 requests to a rate-limited gateway
 * per logical call. Retry/backoff is this module's job; the SDK must make
 * exactly one attempt per call.
 */
function createOpenAIClient(config: ProviderConfig): OpenAI {
    return new OpenAI({
        apiKey: config.apiKey?.trim() || 'not-needed',
        baseURL: normalizeBaseUrl(config.baseUrl, config.apiFormat),
        dangerouslyAllowBrowser: true,
        maxRetries: 0,
    });
}

/** response_format for chat_completions: constrained json_schema when the
 *  jsonSchema capability class allows it and the caller supplied a schema,
 *  else plain json_object when requested, else none. Rejections are handled
 *  by the degrade chain in chatCompletionsTurn / chatCompletionsStream. */
const buildJsonResponseFormat = (
    config: ProviderConfig,
    options?: ChatRequestOptions,
): Record<string, unknown> | undefined => {
    if (options?.jsonSchema?.schema && detectWireCapabilities(config).jsonSchema) {
        return {
            type: 'json_schema',
            json_schema: {
                name: options.jsonSchema.name || 'august_json',
                // Non-strict on purpose: optional fields stay optional and
                // the zod schema at the analysis boundary remains the real
                // validator. Strict mode would require all-keys rewrites.
                strict: false,
                schema: options.jsonSchema.schema,
            },
        };
    }
    if (options?.jsonMode) return { type: 'json_object' };
    return undefined;
};

/** Capability decision for the OUT-of-process transports (Electron bridge +
 *  dev proxy, which build the body themselves): resolve the jsonSchema class
 *  here so those transports only ever see a schema the config supports. */
const resolveWireJsonSchema = (
    config: ProviderConfig,
    options?: ChatRequestOptions,
): ChatRequestOptions['jsonSchema'] =>
    options?.jsonSchema?.schema && detectWireCapabilities(config).jsonSchema ? options.jsonSchema : undefined;

/** First degrade step under a 400/422: json_schema falls back to
 *  json_object (when it was also requested), anything else is removed. */
const degradeResponseFormatOnce = (params: Record<string, unknown>, jsonMode?: boolean): void => {
    const rf = params.response_format as { type?: string } | undefined;
    if (rf?.type === 'json_schema' && jsonMode) params.response_format = { type: 'json_object' };
    else delete params.response_format;
};

/**
 * The ordered request bodies to try under a 400/422: the original, then each
 * degradation that actually changes the request — `json_schema` → `json_object`
 * → no `response_format` → no `tools`.
 *
 * Walked as a ladder rather than nested try/catch, because nesting strands a
 * rung behind a guard that stops holding partway down: the plain
 * `jsonMode` + `tools` shape (every desk-tool seat) has its `response_format`
 * deleted by the FIRST step, so a tools rung written inside
 * "…&& fallbackParams.response_format" is unreachable exactly where it is
 * needed. One rule reaches every rung: this body was refused, try the next.
 *
 * Steps that would send the same body again are dropped, so a healthy gateway —
 * and any request with nothing left to drop — still issues exactly one call.
 */
const buildDegradeLadder = (
    params: Record<string, unknown>,
    options?: ChatRequestOptions,
): Record<string, unknown>[] => {
    const steps: Record<string, unknown>[] = [{ ...params }];
    const tail = (): Record<string, unknown> => steps[steps.length - 1];

    // A rung is appended only if it is a DIFFERENT request from the one before
    // it. Comparing serialised content rather than reference identity is what
    // makes that true: two steps are the same request if they would put the
    // same body on the wire, whatever objects they were built from.
    const pushIfDifferent = (candidate: Record<string, unknown>): void => {
        if (JSON.stringify(candidate) !== JSON.stringify(tail())) steps.push(candidate);
    };

    // Each rung below is derived from the step it follows, and the degradation
    // is applied to a CLONE that is only ever appended. The previous version
    // read `last()` inside the guard as well as the builder, so whether a rung
    // existed depended on which rung happened to be last — an evaluation-order
    // coupling, not a statement about the request. Deriving the guards from the
    // clone removes that coupling: a rung now exists because the request still
    // carries the thing being dropped, and for no other reason.
    if (options?.jsonMode || options?.jsonSchema) {
        // json_schema falls back to json_object; anything else is removed.
        const softened = { ...tail() };
        degradeResponseFormatOnce(softened, options.jsonMode);
        pushIfDifferent(softened);

        // Then `response_format` goes entirely.
        const unformatted = { ...tail() };
        if (unformatted.response_format !== undefined) {
            delete unformatted.response_format;
            pushIfDifferent(unformatted);
        }
    }

    const withoutSideChannel = { ...tail() };
    if (withoutSideChannel.include_reasoning !== undefined) {
        delete withoutSideChannel.include_reasoning;
        pushIfDifferent(withoutSideChannel);
    }

    const withoutTemp = { ...tail() };
    if (withoutTemp.temperature !== undefined && (withoutTemp.reasoning || withoutTemp.thinking || withoutTemp.reasoning_effort)) {
        delete withoutTemp.temperature;
        pushIfDifferent(withoutTemp);
    }

    // Finally the tools. Every desk-tool seat reaches this line, and it is the
    // rung a nested try/catch strands exactly where it is needed — the
    // jsonMode+tools body has already lost its `response_format` above, so a
    // tools rung written inside "…&& fallbackParams.response_format" is
    // unreachable.
    const toolless = { ...tail() };
    if (toolless.tools !== undefined) {
        delete toolless.tools;
        delete toolless.tool_choice;
        pushIfDifferent(toolless);
    }
    return steps;
};

// ─── Timeout & Retry Helpers ────────────────────────────────────────────────

/** Abort a request if it exceeds this wall-clock duration (per attempt). */
const REQUEST_TIMEOUT_MS = PROVIDER_REQUEST_TIMEOUT_MS;

// Streaming analysis calls (reasoning-heavy models + large prompts) regularly
// exceed the non-streaming budget — the chain of thought streams first, then
// the answer. Give streams 5 minutes before declaring a timeout.
const STREAM_TIMEOUT_MS = PROVIDER_STREAM_TIMEOUT_MS;

/**
 * Combine the caller's AbortSignal with a strict timeout. A fresh combined
 * signal is created per attempt so a retry gets a full timeout budget.
 * (AbortSignal.timeout / AbortSignal.any are supported in Chromium 103+,
 * Node 20+, and Electron 25+.)
 */
function withTimeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function withStreamTimeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(STREAM_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// ─── Chat Completions Format ────────────────────────────────────────────────

/** Resolve effective max output tokens, honoring per-model `maxOutputTokens` override. */
export function resolveEffectiveMaxTokens(config: ProviderConfig, requested?: number): number {
    const overrideMax = resolveModelOverride(config)?.maxOutputTokens;
    if (typeof overrideMax === 'number' && Number.isFinite(overrideMax) && overrideMax > 0) {
        if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
            return Math.min(Math.floor(requested), Math.floor(overrideMax));
        }
        return Math.floor(overrideMax);
    }
    return requested ?? 4096;
}

async function chatCompletionsTurn(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<ChatTurnResult> {
    const client = createOpenAIClient(config);
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: config.selectedModel,
        messages: reasoningPreambleMessages(config, messages, options) as any,
        max_tokens: resolveEffectiveMaxTokens(config, options?.maxTokens),
        temperature: options?.temperature ?? 0.7,
    };
    const rf = buildJsonResponseFormat(config, options);
    if (rf) (params as any).response_format = rf;
    if (options?.tools?.length) {
        (params as any).tools = options.tools;
        (params as any).tool_choice = options.toolChoice ?? 'auto';
    }
    requestReasoningSideChannel(config, params, options?.reasoningEffort);
    applyReasoningToChatParams(config, params as unknown as Record<string, unknown>, options);
    // A gateway may refuse the constrained response_format, the tools, or both.
    // Walk the ladder of progressively less ambitious bodies instead of nesting
    // one fallback inside another's branch — see buildDegradeLadder for why
    // nesting strands the tools rung exactly where a desk-tool seat needs it.
    // Only a 400/422 ("this body was refused") advances it: 429s, 5xx and
    // network faults propagate untouched so withRetry keeps owning them, and a
    // healthy gateway still issues exactly one request.
    const ladder = buildDegradeLadder(params as unknown as Record<string, unknown>, options);
    let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
    let refusal: unknown;
    for (const body of ladder) {
        try {
            response = await client.chat.completions.create(body as any, { signal: withTimeoutSignal(options?.signal) });
            break;
        } catch (error: any) {
            if (error?.status !== 400 && error?.status !== 422) throw error;
            refusal = error;
        }
    }
    if (!response) throw refusal ?? new Error('Provider request failed');
    const message = response.choices[0]?.message as any;
    const splitContent = splitChatContent(message?.content);
    const nativeReasoning = extractReasoningFields(message ?? {});
    const reasoning = mergeReasoningParts([nativeReasoning, splitContent.reasoning], '\n');
    const content = splitContent.text;
    if (!content && !reasoning && !message?.tool_calls?.length && options?.jsonMode) {
        return chatCompletionsTurn(config, messages, { ...options, jsonMode: false, jsonSchema: undefined });
    }
    if (reasoning.trim()) options?.onReasoning?.(reasoning.trim());
    reportUsage(config, response, options, messages);
    const toolCalls = (message?.tool_calls || []).map((tc: any, i: number) => {
        let args: Record<string, unknown>;
        try {
            args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
            args = { raw: tc?.function?.arguments || '' };
        }
        return {
            id: tc?.id || `call_${i}`,
            name: String(tc?.function?.name || ''),
            arguments: args && typeof args === 'object' ? args : {},
        };
    }).filter((c: { name: string }) => c.name);
    const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: typeof content === 'string' ? content : (content ?? ''),
        ...(message?.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    };
    const finish = observeFinishReason(config, response, options);
    return {
        text: typeof content === 'string' ? content : '',
        reasoning: reasoning.trim(),
        toolCalls,
        assistantMessage,
        ...finish,
    };
}

async function chatCompletionsCall(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    const turn = await chatCompletionsTurn(config, messages, options);
    return turn.text;
}

async function* chatCompletionsStream(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): AsyncGenerator<string, void, unknown> {
    const client = createOpenAIClient(config);
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: config.selectedModel,
        messages: reasoningPreambleMessages(config, messages, options) as any,
        max_tokens: resolveEffectiveMaxTokens(config, options?.maxTokens),
        temperature: options?.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
    };
    const streamRf = buildJsonResponseFormat(config, options);
    if (streamRf) (params as any).response_format = streamRf;
    if (options?.tools?.length) {
        (params as any).tools = options.tools;
        (params as any).tool_choice = options.toolChoice ?? 'auto';
    }
    requestReasoningSideChannel(config, params, options?.reasoningEffort);
    applyReasoningToChatParams(config, params as unknown as Record<string, unknown>, options);
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
        stream = await client.chat.completions.create(params, { signal: withStreamTimeoutSignal(options?.signal) });
    } catch (error: any) {
        if (error?.status !== 400 && error?.status !== 422) throw error;
        let activeParams: Record<string, unknown> = { ...params };
        let opened: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | undefined;
        let lastErr: unknown = error;
        const tryParams = async (candidate: Record<string, unknown>): Promise<boolean> => {
            try {
                opened = await client.chat.completions.create(candidate as any, { signal: withStreamTimeoutSignal(options?.signal) }) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
                activeParams = candidate;
                return true;
            } catch (err: any) {
                lastErr = err;
                if (err?.status !== 400 && err?.status !== 422) throw err;
                return false;
            }
        };
        if ((options?.jsonMode || options?.jsonSchema) && activeParams.response_format) {
            const softened = { ...activeParams };
            degradeResponseFormatOnce(softened, options?.jsonMode);
            if (!(await tryParams(softened)) && softened.response_format !== undefined) {
                const noRf = { ...softened };
                delete noRf.response_format;
                await tryParams(noRf);
            }
        }
        if (!opened && activeParams.stream_options) {
            const noStreamOpts = { ...activeParams };
            delete noStreamOpts.stream_options;
            await tryParams(noStreamOpts);
        }
        if (!opened && activeParams.include_reasoning !== undefined) {
            const noSide = { ...activeParams };
            delete noSide.include_reasoning;
            await tryParams(noSide);
        }
        if (!opened && activeParams.temperature !== undefined && (activeParams.reasoning || activeParams.thinking || activeParams.reasoning_effort)) {
            const noTemp = { ...activeParams };
            delete noTemp.temperature;
            await tryParams(noTemp);
        }
        if (!opened) throw lastErr;
        stream = opened;
    }
    const gate = createThinkingStreamGate();
    const toolBuf = new StreamToolCallBuffer();
    // Chunks carry finish_reason only on the last one, and a stream that dies
    // mid-flight never yields one — so 'unknown' here genuinely means "no
    // signal", not "stopped cleanly".
    let streamFinish: FinishReason | undefined;
    for await (const chunk of stream) {
        reportUsage(config, chunk, options, messages);
        const chunkReason = normalizeFinishReason(chunk.choices?.[0]?.finish_reason);
        if (chunk.choices?.[0]?.finish_reason) streamFinish = chunkReason;
        const choice = chunk.choices?.[0] as any;
        const delta = choice?.delta;
        const bufferedMessage = choice?.message;
        if (bufferedMessage && !delta) {
            const buffered = readWireBody('chat_completions', chunk);
            if (buffered.reasoning) options?.onReasoning?.(buffered.reasoning);
            toolBuf.push({ tool_calls: bufferedMessage.tool_calls });
            const gated = gate.push(buffered.text);
            if (gated.orphanClose) options?.onOrphanThinkClose?.();
            if (gated.thinking.length > 0) options?.onReasoning?.(gated.thinking);
            if (gated.visible) yield gated.visible;
            continue;
        }
        toolBuf.push(delta);
        const reasoning = deltaReasoning(delta);
        if (reasoning.length > 0) options?.onReasoning?.(reasoning);
        const gated = gate.push(deltaVisibleText(delta));
        if (gated.orphanClose) options?.onOrphanThinkClose?.();
        if (gated.thinking.length > 0) options?.onReasoning?.(gated.thinking);
        if (gated.visible) yield gated.visible;
    }
    const flushed = gate.flush();
    if (flushed.thinking.length > 0) options?.onReasoning?.(flushed.thinking);
    if (flushed.visible) yield flushed.visible;
    toolBuf.finish(options);
    reportFinishReason(config, streamFinish ?? 'unknown', options);
}

// ─── Messages Format (Anthropic-style) ──────────────────────────────────────

/** Convert a ChatMessage's content to Anthropic message content blocks. */
export function toAnthropicContent(content: string | ContentPart[] | null): any[] {
    if (content == null) return [];
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    return content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        const url = part.image_url.url;
        const commaIdx = url.indexOf(',');
        if (url.startsWith('data:') && commaIdx !== -1) {
            // data:image/png;base64,<payload> — carry the real media type
            // (JPEG/WebP screenshots were previously hardcoded as PNG).
            const header = url.slice(5, commaIdx);
            const mimeMatch = header.match(/^image\/(png|jpeg|webp|gif)\b/i);
            const mediaType = mimeMatch ? mimeMatch[1].toLowerCase() : 'png';
            return { type: 'image', source: { type: 'base64', media_type: `image/${mediaType}`, data: url.slice(commaIdx + 1) } };
        }
        // Non-data URL — pass through as a URL source instead of silently
        // emitting an empty base64 payload.
        return { type: 'image', source: { type: 'url', url } };
    });
}

async function messagesCall(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body: any = {
        model: config.selectedModel,
        max_tokens: resolveEffectiveMaxTokens(config, options?.maxTokens),
        messages: nonSystemMsgs.map(m => ({ role: m.role, content: toAnthropicContent(m.content) })),
    };
    const maxTokensForBody = body.max_tokens as number;
    if (systemMsg) {
        const systemText = typeof systemMsg.content === 'string' ? systemMsg.content : (systemMsg.content as ContentPart[]).map(p => p.type === 'text' ? p.text : '').join('');
        // One cache breakpoint (O-58): the system block repeats byte-for-byte
        // on every round of a turn, so rounds 2..N bill at the cache-read rate.
        body.system = anthropicCachedSystem(systemText);
    }
    // Temperature + extended thinking come from the shared policy module (all
    // three transports): explicit value or 0.7 default — Anthropic's own API
    // default is 1.0, so omitting temperature sampled the same task at a
    // different value per provider format and polluted calibration data —
    // and when thinking is active the block replaces temperature (Anthropic
    // requires it unset alongside `thinking`).
    const thinkingFields = anthropicThinkingFields({
        modelId: config.selectedModel || '',
        displayName: config.name,
        capabilityOverride: config.thinkingCapable,
        maxTokens: maxTokensForBody,
        temperature: options?.temperature,
        jsonMode: options?.jsonMode,
        reasoningEffort: options?.reasoningEffort,
    });
    if (typeof thinkingFields.temperature === 'number') body.temperature = thinkingFields.temperature;
    if (thinkingFields.thinking) body.thinking = thinkingFields.thinking;
    // Wire audit: the messages transport previously emitted
    // NO audit line, so Claude seats — the format whose thinking gate P3
    // fixed — were invisible in the run log. Report the shim's actual
    // decision: applied (thinking block sent), or why it wasn't.
    {
        const effort = options?.reasoningEffort ?? 'auto';
        const thinkingSent = !!body.thinking;
        options?.onWireAudit?.({
            route: thinkingSent ? 'anthropic-thinking' : 'none',
            effort,
            applied: thinkingSent,
            reason: thinkingSent
                ? `thinking budget_tokens=${(body.thinking as { budget_tokens: number }).budget_tokens} (effort ${effort})`
                : `no thinking block: ${options?.jsonMode ? 'jsonMode excludes thinking'
                    : (options?.maxTokens ?? 4096) <= MIN_EFFECTIVE_THINKING_TOKENS ? 'maxTokens below the 1024 thinking floor'
                        : config.thinkingCapable === false ? 'thinkingCapable override = off'
                            : 'model id not recognized as thinking-capable (set the override in Settings)'}`,
        });
    }

    const url = `${normalizeBaseUrl(config.baseUrl, 'messages')}/messages`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
    });

    if (!response.ok) {
        const status = response.status;
        // The trader gets the provider's OWN denial reason, not a paraphrase —
        // "access denied" without the reason is undiagnosable.
        const providerMessage = sanitizeProviderText(extractProviderErrorMessage(await response.text()));
        const err = new Error(providerMessage
            ? `${config.name || 'Provider'} (${status}): ${providerMessage}`
            : `${config.name || 'Provider'} request failed (${status}).`);
        (err as any).status = status; // Preserve for retry/quota classification
        (err as any).providerMessage = providerMessage;
        throw err;
    }

    const data = await response.json();
    // Anthropic chain of thought arrives as `thinking` content blocks — forward
    // it on the same side channel as chat_completions reasoning_content.
    const thinking = extractMessagesThinking(data.content);
    if (thinking) options?.onReasoning?.(thinking);
    reportUsage(config, data, options, messages);
    // Anthropic reports the ceiling as stop_reason:'max_tokens' on a 200 with
    // a well-formed body, so nothing downstream could tell it from an answer.
    observeFinishReason(config, data, options);
    if (data.content && Array.isArray(data.content)) {
        return data.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n');
    }
    return data.text || JSON.stringify(data);
}

// ─── Responses Format (OpenAI Responses API) ────────────────────────────────

export function toResponsesInput(messages: ChatMessage[]): any[] {
    // The Responses API only accepts user/assistant roles in `input` — system
    // content belongs in the top-level `instructions` field (see responsesCall).
    // Passing role:'system' here gets a 400-class rejection.
    return messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role,
        content: m.content == null
            ? ''
            : typeof m.content === 'string'
            ? m.content
            : (m.content as ContentPart[]).map(p => p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url }),
    }));
}

async function responsesCall(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    const url = `${normalizeBaseUrl(config.baseUrl, 'responses')}/responses`;
    const systemMsg = messages.find(m => m.role === 'system');
    const instructions = systemMsg
        ? typeof systemMsg.content === 'string'
            ? systemMsg.content
            : (systemMsg.content as ContentPart[]).map(p => p.type === 'text' ? p.text : '').join('')
        : undefined;
    const reasoningPatch = buildReasoningPatch(config, options?.reasoningEffort ?? 'auto');
    options?.onWireAudit?.(reasoningPatch.audit);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.selectedModel,
            input: toResponsesInput(messages),
            ...(instructions ? { instructions } : {}),
            max_output_tokens: resolveEffectiveMaxTokens(config, options?.maxTokens),
            ...(reasoningPatch.patch.reasoning ? {} : { temperature: options?.temperature ?? 0.7 }),
            ...reasoningPatch.patch,
        }),
        signal: options?.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        const status = response.status;
        const providerMessage = sanitizeProviderText(extractProviderErrorMessage(errorText));
        const err = new Error(providerMessage
            ? `${config.name || 'Provider'} (${status}): ${providerMessage}`
            : `${config.name || 'Provider'} request failed (${status}).`);
        (err as any).status = status; // Preserve for retry/quota classification
        (err as any).providerMessage = providerMessage;
        throw err;
    }

    const data = await response.json();
    // OpenAI Responses API reasoning arrives as `output` items of type
    // `reasoning` (full text + public summary) — forward on onReasoning.
    const reasoning = extractResponsesReasoning(data.output);
    if (reasoning) options?.onReasoning?.(reasoning);
    reportUsage(config, data, options, messages);
    // Responses reports a cut-off answer as status:'incomplete' — a success
    // shaped response that previously parsed as if it were finished.
    observeFinishReason(config, data, options);
    if (data.output && Array.isArray(data.output)) {
        const texts: string[] = [];
        for (const item of data.output) {
            if (item.type === 'message' && item.content) {
                for (const block of item.content) {
                    if (block.type === 'output_text') {
                        texts.push(block.text);
                    }
                }
            }
        }
        if (texts.length > 0) return texts.join('\n');
    }
    if (data.output_text) return data.output_text;
    return JSON.stringify(data);
}

async function googleCall(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    const base = normalizeBaseUrl(config.baseUrl, config.apiFormat);
    const key = (config.apiKey || '').trim();
    const url = googleGenerateUrl(base, config.selectedModel, key, false);
    const geminiThinking = geminiThinkingParams(
        options?.jsonMode,
        config.selectedModel,
        options?.reasoningEffort,
        options?.maxTokens,
    );
    // The audit must say what the wire received. Effort now scales
    // thinkingBudget, so reporting route:'none'/applied:false on a call that
    // is sending a thinkingConfig poisons everything built on the run log —
    // pinning, calibration and the known-answer probes all read this.
    options?.onWireAudit?.(geminiThinking
        ? {
            route: 'gemini-thinking',
            effort: options?.reasoningEffort ?? 'auto',
            applied: true,
            reason: `thinkingConfig.thinkingBudget=${geminiThinking.thinkingBudget}`,
        }
        : {
            route: 'none',
            effort: options?.reasoningEffort ?? 'auto',
            applied: false,
            reason: options?.jsonMode
                ? 'google generateContent: JSON mode sends no thinkingConfig'
                : (options?.reasoningEffort === 'off'
                    ? 'google generateContent: effort=off suppresses thinkingConfig'
                    : 'google generateContent: no thinkingConfig for this model'),
        });
    const body = chatMessagesToGemini(messages, {
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        jsonMode: options?.jsonMode,
        model: config.selectedModel,
        reasoningEffort: options?.reasoningEffort,
    });
    // Canonical thinking decision from the shared policy module (the codec's
    // inline copy is behaviorally identical; applying the policy here means
    // every transport's Gemini thinkingConfig provably comes from one source).
    if (geminiThinking) body.generationConfig.thinkingConfig = geminiThinking;
    else delete body.generationConfig.thinkingConfig;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) {
        const status = response.status;
        const providerMessage = sanitizeProviderText(extractProviderErrorMessage(await response.text()));
        const err = new Error(providerMessage
            ? `${config.name || 'Provider'} (${status}): ${providerMessage}`
            : `${config.name || 'Provider'} request failed (${status}).`);
        (err as { status?: number }).status = status;
        (err as { providerMessage?: string }).providerMessage = providerMessage;
        throw err;
    }
    const data = await response.json();
    const parsed = parseGeminiResponse(data);
    if (parsed.reasoning) options?.onReasoning?.(parsed.reasoning);
    reportUsage(config, data, options, messages);
    // Gemini reports MAX_TOKENS per candidate, so a truncated answer still has
    // a valid candidates[0].content — indistinguishable without this.
    observeFinishReason(config, data, options);
    return parsed.text;
}

// ─── Universal Dispatchers ──────────────────────────────────────────────────

function assertHasKey(config: ProviderConfig): void {
    assertValidProviderUrl(config.baseUrl);
}

/**
 * Convert low-level provider/SDK errors into user-safe messages.
 * Raw API error bodies can leak internals (URLs, request dumps), so they are
 * logged for debugging but never surfaced verbatim. The `status` property is
 * preserved so callers can still detect rate limits / quota errors, and abort
 * errors pass through untouched so cancellation keeps working.
 */
/** The provider's own error message from a response body — the REAL reason a
 *  request failed ("insufficient credits for model X", not a paraphrased
 *  "access denied"). The body is provider-generated and never contains our
 *  key; request headers are never echoed. Best-effort: JSON error-envelope
 *  shapes first (OpenAI / Anthropic / OpenCode / Gemini), then raw text. */
function extractProviderErrorMessage(bodyText: string): string {
    const text = (bodyText || '').trim();
    if (!text) return '';
    try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const errObj: unknown = data.error;
        const candidates: unknown[] = [
            errObj && typeof errObj === 'object' ? (errObj as Record<string, unknown>).message : errObj,
            data.message,
            data.detail,
            data.error,
        ];
        for (const c of candidates) {
            if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 400);
        }
    } catch { /* not JSON — the raw body itself is the message */ }
    return text.slice(0, 300);
}

/** Strip URLs, key-like tokens, and key prefixes before surfacing any
 *  provider text. */
function sanitizeProviderText(text: string): string {
    return (text || '')
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '***')
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '***')
        .slice(0, 300);
}

/**
 * The CAUSE chain, flattened to the parts a human needs.
 *
 * Node's fetch hides the actual reason one level down: the top-level message
 * is "fetch failed", and the real answer — "getaddrinfo ENOTFOUND
 * api.example.com", "ECONNREFUSED 127.0.0.1:1", "certificate has expired" —
 * sits in `cause`. A hint built from the top-level message alone names a
 * cause it never read, which is how "could not reach the server" became the
 * whole story when the error could have said WHICH host and WHY.
 *
 * Depth-capped (four) and de-duplicated: a cause chain that loops is a
 * provider's business, not the trader's.
 */
function errorCauseChain(error: unknown): string {
    const parts: string[] = [];
    let cause = (error as { cause?: unknown })?.cause;
    for (let depth = 0; cause && depth < 4; depth++) {
        const c = cause as { message?: string; code?: string };
        const message = sanitizeProviderText((c?.message || '').trim());
        const code = typeof c?.code === 'string' ? c.code.trim() : '';
        const piece = code && message ? `${code}: ${message}` : (code || message);
        if (piece && !parts.includes(piece)) parts.push(piece);
        cause = (cause as { cause?: unknown })?.cause;
    }
    return parts.join(' · ');
}

function toFriendlyProviderError(error: unknown, providerName: string): unknown {
    const err = error as { name?: string; code?: string; status?: number; message?: string };

    // Cancellation — must propagate as-is
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'TimeoutError') {
        return error;
    }

    const name = providerName || 'Provider';
    const status = typeof err?.status === 'number' ? err.status : undefined;

    // The transport attached the provider's OWN message (sanitized at the
    // boundary) — that is the real error and it LEADS. The canned sentences
    // below are only the fallback for a body we could not read.
    const real = typeof (err as { providerMessage?: unknown }).providerMessage === 'string'
        ? ((err as { providerMessage?: string }).providerMessage || '').trim()
        : '';
    if (real) {
        const wrapped = new Error(`${name} (HTTP ${status ?? '—'}): ${real}`);
        if (status !== undefined) (wrapped as any).status = status;
        return wrapped;
    }

    // On the desktop bridge, the dev proxy and the OpenAI-SDK path the
    // provider's own text arrives in err.message (parseProviderErrorBody put
    // it there on the bridge) with no providerMessage field — the REAL error
    // leads there too; the canned sentence is only for a generic/empty one.
    const fromMessage = sanitizeProviderText((err?.message || '').trim());
    // "HTTP 400" is the status echoing itself, not a reason.
    const statusEcho = status !== undefined
        && new RegExp(`^https?\\s*${status}$`, 'i').test(fromMessage);
    const messageIsGeneric = !fromMessage
        || statusEcho
        || /request failed/i.test(fromMessage);
    // The cause chain is the real reason when there is one, and it is
    // appended to whatever the message said — never instead of it.
    const causeDetail = errorCauseChain(err);
    // What the wire ACTUALLY said, in one string: the provider's own text
    // (when it said anything) plus the cause underneath it. This is the fact;
    // the sentences below are the advice.
    const detail = [messageIsGeneric ? '' : fromMessage, causeDetail].filter(Boolean).join(' · ');

    let friendly: string;
    // Every branch names the STATUS it was given, then says what to do about
    // it. A status the app swallowed and replaced with its own sentence left
    // the trader guessing which kind of failure they were looking at — and
    // the status is the part a retry policy, a log line, or a support
    // conversation needs.
    if (status === 401) {
        friendly = messageIsGeneric ? `${name} (HTTP 401): invalid API key. Check your provider settings.`
            : `${name} (HTTP 401): ${fromMessage}`;
    } else if (status === 403) {
        friendly = messageIsGeneric ? `${name} (HTTP 403): access denied. Your API key may lack permissions or credits.`
            : `${name} (HTTP 403): ${fromMessage}`;
    } else if (status === 429) {
        friendly = messageIsGeneric ? `${name} (HTTP 429): rate limit or quota reached. Please wait and try again.`
            : `${name} (HTTP 429): ${fromMessage}`;
    } else if (status === 404) {
        friendly = messageIsGeneric ? `${name} (HTTP 404): model or endpoint not found. Check the base URL and model id.`
            : `${name} (HTTP 404): ${fromMessage}`;
    } else if (status && status >= 500) {
        friendly = messageIsGeneric ? `${name} (HTTP ${status}): server error. Try again later.`
            : `${name} (HTTP ${status}): ${fromMessage}`;
    } else if (status) {
        friendly = messageIsGeneric ? `${name}: request failed (${status}).`
            : `${name} (HTTP ${status}): ${fromMessage}`;
    } else {
        const rawMessage = (err?.message || '').trim();
        const raw = rawMessage.toLowerCase();
        if (raw.includes('desktop provider bridge')) {
            friendly = 'Desktop provider bridge is not loaded. Fully quit and restart the Electron app.';
        } else if (raw.includes('aborted') || raw.includes('timed out') || raw.includes('timeout')) {
            // "The operation was aborted" arrives from the Electron bridge when
            // the main-process timer (or our per-attempt cap) killed a hung
            // request — surface it as a timeout, not a mystery abort.
            friendly = detail
                ? `${name}: ${detail} — request timed out. The provider may be overloaded — try again shortly.`
                : `${name}: request timed out. The provider may be overloaded — try again shortly.`;
        } else if (raw.includes('fetch') || raw.includes('network') || raw.includes('econnrefused') || raw.includes('enotfound') || raw.includes('failed to connect') || raw.includes('certificate') || raw.includes('tls')) {
            // The REAL error leads — "fetch failed · ENOTFOUND: getaddrinfo
            // ENOTFOUND api.example.com" — and the advice follows it. The
            // sentence alone was a guess dressed as a fact: it named no host,
            // no code, and nothing the trader could act on.
            friendly = detail
                ? `${name}: ${detail} — could not reach the server. Check the base URL and your connection.`
                : `${name}: could not reach the server. Check the base URL and your connection.`;
        } else if (rawMessage && rawMessage.toLowerCase() !== 'provider request failed.') {
            // Sanitize the raw SDK text before surfacing it: it can embed the
            // provider base URL and response-body excerpts (which may echo the
            // user's prompt). Same rules as sanitizeProviderText.
            const sanitized = sanitizeProviderText(rawMessage);
            friendly = causeDetail ? `${name}: ${sanitized} · ${causeDetail}` : `${name}: ${sanitized}`;
        } else {
            friendly = causeDetail ? `${name}: ${causeDetail}` : `${name}: request failed.`;
        }
    }

    console.warn(`[GenericProviderService] ${name} request failed with status ${status ?? 'unknown'}`);
    const wrapped = new Error(friendly);
    if (status !== undefined) {
        (wrapped as any).status = status;
    }
    return wrapped;
}

function parseProviderErrorBody(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as any;
        const message = parsed?.error?.message || parsed?.error?.error?.message || parsed?.message || parsed?.detail;
        return typeof message === 'string' ? message.trim().slice(0, 300) : '';
    } catch {
        return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
}

type StringTransport = (
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions,
) => Promise<string>;

/** The other three transports carry no per-attempt cap of their own; the
 *  wrapper gives them the one budget the whole file stands behind. */
const withRequestTimeout = (call: StringTransport): StringTransport =>
    (config, messages, options) => call(config, messages, { ...options, signal: withTimeoutSignal(options?.signal) });

/** The ONE place a wire format names its string transport. It used to be a
 *  switch in one function and a nested ternary in another, which is the shape
 *  where one path learns about a new format and the other silently returns ''.
 *  Keep both call paths going through `stringTransportFor`. */
const STRING_TRANSPORTS: Record<ProviderConfig['apiFormat'], StringTransport> = {
    // chatCompletionsCall applies its own per-attempt timeout internally
    // (needed for its jsonMode retry), so it is NOT wrapped.
    chat_completions: chatCompletionsCall,
    messages: withRequestTimeout(messagesCall),
    responses: withRequestTimeout(responsesCall),
    google: withRequestTimeout(googleCall),
};

export const stringTransportFor = (format: ProviderConfig['apiFormat']): StringTransport => {
    const call = (STRING_TRANSPORTS as Record<string, StringTransport | undefined>)[format];
    // Refusing loudly beats the old `: ''` — an unknown format is a bug, and an
    // empty answer is indistinguishable from a model with nothing to say.
    if (!call) throw new Error(`Unknown API format: ${format}`);
    return call;
};

/**
 * Send a chat request to any provider, routing to the correct API format.
 */
export async function sendChatRequest(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    try {
        return await sendChatRequestOnce(config, messages, options);
    } catch (error) {
        const retry = contextRecoveryMessages(config, messages, options, error);
        if (!retry) throw error;
        return sendChatRequestOnce(config, retry, options);
    }
}

/**
 * The one automatic recovery a context-window rejection deserves.
 *
 * Every provider in this app states the window in the rejection it returns for
 * a prompt that does not fit — "maximum context length is 128000 tokens",
 * "prompt is too long: 210000 tokens > 200000 maximum". That number is better
 * evidence than anything the app has: `resolveContextWindow` is otherwise
 * reading a field the trader typed, a value `/models` reported, or the 1M
 * default, and the default is deliberately optimistic. So on this one error the
 * wire teaches the app its own assumption, and the turn is retried once against
 * a history compacted to the limit that was just stated.
 *
 * Returns null when the error is not a context rejection, or when compaction
 * has nothing left to cut — retrying identical bytes against an identical limit
 * would produce the identical error, and the caller deserves the provider's
 * message rather than a second one.
 */
/**
 * A compacted request that STILL cannot fit is not a retry candidate. Sending
 * it again would burn a turn and return the same provider error; the caller
 * needs a machine-readable refusal carrying the compactor's own notice.
 */
export class ContextFullError extends Error {
    readonly code = 'CONTEXT_FULL' as const;
    readonly stillOver: number;
    readonly ceilingTokens: number;

    constructor(notice: string, stillOver: number, ceilingTokens: number) {
        super(notice);
        this.name = 'ContextFullError';
        this.stillOver = stillOver;
        this.ceilingTokens = ceilingTokens;
    }
}

export function contextRecoveryMessages(
    config: ProviderConfig,
    messages: ChatMessage[],
    options: ChatRequestOptions | undefined,
    error: unknown,
): ChatMessage[] | null {
    const message = (error as { message?: unknown })?.message;
    const limit = contextLengthLimitFromError(typeof message === 'string' ? message : '');
    if (!limit) return null;
    recordMeasuredContextWindow(config.id, config.selectedModel, limit);
    const compacted = compactForWire(config, messages, {
        outputReserveTokens: options?.maxTokens,
        windowTokens: limit,
    });
    // Emergency compaction ran and the protected tail alone still exceeds the
    // ceiling. Refuse LOUDLY with the compactor's CONTEXT FULL notice instead
    // of re-sending oversize bytes and losing the turn to an opaque 400.
    if (compacted.stillOver > 0) {
        throw new ContextFullError(compacted.notice, compacted.stillOver, compacted.ceilingTokens);
    }
    if (!compacted.changed) return null;
    if (compacted.notice) options?.onContextCompact?.(compacted.notice);
    return compacted.messages;
}

async function sendChatRequestOnce(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<string> {
    assertHasKey(config);
    const effectiveConfig = {
        ...config,
        apiKey: config.apiKey?.trim() || 'not-needed'
    };
    const wireMessages = reasoningPreambleMessages(effectiveConfig, messages, options);
    const startedAt = Date.now();
    try {
        // Retry transient failures (rate limit / network / 5xx) with
        // exponential backoff; each attempt is hard-capped by REQUEST_TIMEOUT_MS.
        const result = await withRetry(
            () => {
                const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
                if (electronAPI?.isElectron && !electronAPI.providerChat) {
                    throw new Error('Desktop provider bridge is not loaded. Fully quit and restart the Electron app.');
                }
                if (electronAPI?.isElectron && electronAPI.providerChat) {
                    const requestId = `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const cancelRequest = () => {
                        void electronAPI.cancelProviderChat?.(requestId);
                    };
                    options?.signal?.addEventListener('abort', cancelRequest, { once: true });
                    // An abort arriving BEFORE the listener registered would
                    // never fire it — re-check so a main-process request can't
                    // run to its 300s cap on an already-aborted signal.
                    if (options?.signal?.aborted) cancelRequest();
                    // Hard per-attempt timeout for the Electron bridge. Unlike
                    // the web paths it has no built-in cap, and main.cjs's
                    // 300s guard surfaces only as a generic "aborted" error —
                    // without this a wedged main-process request could hang
                    // the pipeline ~15 minutes across 3 retries.
                    const timeout = window.setTimeout(() => cancelRequest(), REQUEST_TIMEOUT_MS);
                    return electronAPI.providerChat({
                        config: effectiveConfig,
                        messages: wireMessages,
                        requestId,
                        maxTokens: options?.maxTokens,
                        temperature: options?.temperature,
                        reasoningEffort: options?.reasoningEffort,
                        jsonMode: options?.jsonMode,
                        jsonSchema: resolveWireJsonSchema(effectiveConfig, options),
                        tools: options?.tools,
                        toolChoice: options?.toolChoice,
                        reasoningPatch: reasoningPatchFor(effectiveConfig, options),
                    }).then(result => {
                        if (!result.ok) {
                            const error = new Error(result.message || 'Provider request failed.');
                            if (result.status !== undefined) (error as any).status = result.status;
                            if (result.code !== undefined) (error as any).code = result.code;
                            throw error;
                        }
                        const stripped = extractAndStripThinkBlocks(result.text || '');
                        const combinedReasoning = mergeReasoningParts([result.reasoning || '', stripped.leaked], '\n\n');
                        if (combinedReasoning) options?.onReasoning?.(combinedReasoning);
                        reportUsageDirect(effectiveConfig, result.usage, options, messages);
                        reportFinishReason(
                            effectiveConfig,
                            normalizeFinishReason(result.finishReason),
                            options,
                        );
                        return stripped.visible;
                    }).finally(() => {
                        window.clearTimeout(timeout);
                        options?.signal?.removeEventListener('abort', cancelRequest);
                    });
                }
                if (usesDevProviderProxy()) {
                    const patch = reasoningPatchFor(effectiveConfig, options);
                    return fetch(DEV_PROVIDER_PROXY_PATH, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        config: effectiveConfig,
                        messages: wireMessages,
                        maxTokens: options?.maxTokens,
                        temperature: options?.temperature,
                        reasoningEffort: options?.reasoningEffort,
                        jsonMode: options?.jsonMode,
                        jsonSchema: resolveWireJsonSchema(effectiveConfig, options),
                        tools: options?.tools,
                        toolChoice: options?.toolChoice,
                        ...(options?.tools?.length ? { tool_choice: options?.toolChoice ?? 'auto' } : options?.toolChoice ? { tool_choice: options.toolChoice } : {}),
                        reasoningPatch: patch,
                        ...(patch ?? {}),
                    }),
                    // The dev proxy is the only transport with no cap of its own:
                    // every other path in this file passes a timeout signal, and a
                    // proxy request that wedges would hold the pipeline open until
                    // the trader pressed Stop. Same budget as the transport it stands
                    // in for.
                    signal: withTimeoutSignal(options?.signal),
                }).then(async response => {
                        const result = await response.json() as { ok?: boolean; status?: number; body?: string; reasoning?: string; message?: string };
                        if (!response.ok || !result.ok) {
                            const providerBody = result.body ? parseProviderErrorBody(result.body) : '';
                            const error = new Error(result.message || providerBody || `Provider request failed (${result.status || response.status}).`);
                            if (result.status !== undefined) (error as { status?: number }).status = result.status;
                            throw error;
                        }
                        let data: unknown;
                        try {
                            data = result.body ? JSON.parse(result.body) : {};
                        } catch (e) {
                            const message = e instanceof Error ? e.message : 'Unknown JSON parsing error';
                            throw new Error(`Provider proxy returned invalid JSON: ${message}. Body: ${(result.body || '').slice(0, 200)}`, { cause: e });
                        }
                        // The localhost proxy returns `reasoning` for
                        // chat_completions; the shared reader falls back to a
                        // per-format parse so messages/responses thinking
                        // survives the proxy too.
                        const { text, reasoning } = readWireBody(effectiveConfig.apiFormat, data, result.reasoning);
                        if (reasoning.trim()) options?.onReasoning?.(reasoning.trim());
                        reportUsage(effectiveConfig, data, options, messages);
                        // The proxy hands back the raw provider body, so the
                        // same four-shape extractor covers every format here.
                        observeFinishReason(effectiveConfig, data, options);
                        return text || '';
                    });
                }
                return stringTransportFor(effectiveConfig.apiFormat)(effectiveConfig, wireMessages, options);
            },
            (effectiveConfig.name as ProviderName) || 'Provider',
            retryAttemptsForPolicy(effectiveConfig.retryPolicy),
            options?.signal
        );
        recordProviderSuccess(config.id, Date.now() - startedAt);
        return result;
    } catch (error) {
        const err = error as { name?: string; code?: string };
        const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'TimeoutError';
        if (!isAbort) recordProviderError(config.id, error);
        throw toFriendlyProviderError(error, `${effectiveConfig.name} · ${effectiveConfig.selectedModel}`);
    }
}

/**
 * One chat turn that can return native tool calls (chat_completions).
 * Other formats return text only — callers may fall back to the text tool protocol.
 */
export async function sendChatTurn(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<ChatTurnResult> {
    try {
        return await sendChatTurnOnce(config, messages, options);
    } catch (error) {
        const retry = contextRecoveryMessages(config, messages, options, error);
        if (!retry) throw error;
        return sendChatTurnOnce(config, retry, options);
    }
}

async function sendChatTurnOnce(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): Promise<ChatTurnResult> {
    assertHasKey(config);
    const effectiveConfig = {
        ...config,
        apiKey: config.apiKey?.trim() || 'not-needed'
    };
    const wireMessages = reasoningPreambleMessages(effectiveConfig, messages, options);
    const startedAt = Date.now();
    try {
        const result = await withRetry(
            async () => {
                const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
                if (electronAPI?.isElectron && electronAPI.providerChat) {
                    const requestId = `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const cancelRequest = () => {
                        void electronAPI.cancelProviderChat?.(requestId);
                    };
                    options?.signal?.addEventListener('abort', cancelRequest, { once: true });
                    if (options?.signal?.aborted) cancelRequest();
                    const timeout = window.setTimeout(() => cancelRequest(), REQUEST_TIMEOUT_MS);
                    try {
                        const bridge = await electronAPI.providerChat({
                            config: effectiveConfig,
                            messages: wireMessages,
                            requestId,
                            maxTokens: options?.maxTokens,
                            temperature: options?.temperature,
                            reasoningEffort: options?.reasoningEffort,
                            jsonMode: options?.jsonMode,
                            jsonSchema: resolveWireJsonSchema(effectiveConfig, options),
                            tools: options?.tools,
                            toolChoice: options?.toolChoice,
                            reasoningPatch: reasoningPatchFor(effectiveConfig, options),
                        });
                        if (!bridge.ok) {
                            const error = new Error(bridge.message || 'Provider request failed.');
                            if (bridge.status !== undefined) (error as any).status = bridge.status;
                            if (bridge.code !== undefined) (error as any).code = bridge.code;
                            throw error;
                        }
                        const stripped = extractAndStripThinkBlocks(bridge.text || '');
                        const combinedReasoning = mergeReasoningParts([bridge.reasoning || '', stripped.leaked], '\n\n');
                        if (combinedReasoning) options?.onReasoning?.(combinedReasoning);
                        reportUsageDirect(effectiveConfig, bridge.usage, options, messages);
                        // The bridge already flattened the provider body, so
                        // this is a raw stop token rather than a response shape
                        // — normalize directly instead of re-extracting.
                        const bridgeFinish = normalizeFinishReason(bridge.finishReason);
                        reportFinishReason(effectiveConfig, bridgeFinish, options);
                        return {
                            text: stripped.visible,
                            reasoning: combinedReasoning,
                            toolCalls: bridge.toolCalls || [],
                            finishReason: bridgeFinish,
                            truncated: truncatesOutput(bridgeFinish),
                            assistantMessage: bridge.assistantMessage
                                ? { ...bridge.assistantMessage, content: stripped.visible }
                                : {
                                    role: 'assistant',
                                    content: stripped.visible,
                                },
                        } satisfies ChatTurnResult;
                    } finally {
                        window.clearTimeout(timeout);
                        options?.signal?.removeEventListener('abort', cancelRequest);
                    }
                }
                if (usesDevProviderProxy()) {
                    const patch = reasoningPatchFor(effectiveConfig, options);
                    const response = await fetch(DEV_PROVIDER_PROXY_PATH, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            config: effectiveConfig,
                            messages: wireMessages,
                            maxTokens: options?.maxTokens,
                            temperature: options?.temperature,
                            reasoningEffort: options?.reasoningEffort,
                            jsonMode: options?.jsonMode,
                            jsonSchema: resolveWireJsonSchema(effectiveConfig, options),
                            tools: options?.tools,
                            toolChoice: options?.toolChoice,
                            ...(options?.tools?.length ? { tool_choice: options?.toolChoice ?? 'auto' } : options?.toolChoice ? { tool_choice: options.toolChoice } : {}),
                            reasoningPatch: patch,
                            ...(patch ?? {}),
                        }),
                        // The stream's own budget, not the non-streaming one: a
                        // reasoning-heavy answer streams its chain of thought first,
                        // and 120 s would cut off a turn that is working. This is the
                        // same cap `withStreamTimeoutSignal` gives the other streaming
                        // transports.
                        signal: withStreamTimeoutSignal(options?.signal),
                    });
                    const result = await response.json() as { ok?: boolean; status?: number; body?: string; reasoning?: string; message?: string };
                    if (!response.ok || !result.ok) {
                        const providerBody = result.body ? parseProviderErrorBody(result.body) : '';
                        const error = new Error(result.message || providerBody || `Provider request failed (${result.status || response.status}).`);
                        if (result.status !== undefined) (error as { status?: number }).status = result.status;
                        throw error;
                    }
                    type ProxyToolCallShape = { id?: string; type?: 'function'; function?: { name?: string; arguments?: string } };
                    let data: {
                        choices?: Array<{
                            message?: {
                                content?: unknown;
                                reasoning_content?: unknown;
                                reasoning?: unknown;
                                tool_calls?: ProxyToolCallShape[];
                            };
                        }>;
                    };
                    try {
                        data = result.body ? JSON.parse(result.body) : {};
                    } catch (e) {
                        const message = e instanceof Error ? e.message : 'Unknown JSON parsing error';
                        throw new Error(`Provider proxy returned invalid JSON: ${message}. Body: ${(result.body || '').slice(0, 200)}`, { cause: e });
                    }
                    if (effectiveConfig.apiFormat === 'chat_completions') {
                        const message = data.choices?.[0]?.message || {};
                        const splitContent = readWireBody('chat_completions', data, result.reasoning);
                        const reasoning = splitContent.reasoning;
                        if (reasoning.trim()) options?.onReasoning?.(reasoning.trim());
                        reportUsage(effectiveConfig, data, options, messages);
                        const toolCalls = (message.tool_calls || []).map((tc, i: number) => {
                            let args: Record<string, unknown>;
                            try {
                                args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                            } catch {
                                args = { raw: tc?.function?.arguments || '' };
                            }
                            return {
                                id: tc?.id || `call_${i}`,
                                name: String(tc?.function?.name || ''),
                                arguments: args && typeof args === 'object' ? args : {},
                            };
                        }).filter(c => c.name);
                        const rawToolCalls = message.tool_calls
                            ?.filter((tc): tc is { id: string; type?: 'function'; function: { name: string; arguments: string } } =>
                                typeof tc?.id === 'string' && typeof tc?.function?.name === 'string')
                            .map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' } }));
                        return {
                            text: splitContent.text || '',
                            reasoning: reasoning.trim(),
                            toolCalls,
                            ...observeFinishReason(effectiveConfig, data, options),
                            assistantMessage: {
                                role: 'assistant',
                                content: splitContent.text || '',
                                ...(rawToolCalls?.length ? { tool_calls: rawToolCalls } : {}),
                            },
                        } satisfies ChatTurnResult;
                    }
                    // Non-chat_completions via proxy: text only. Same reader as
                    // the request path — the two had already drifted on an
                    // array `message.content`.
                    const { text, reasoning } = readWireBody(effectiveConfig.apiFormat, data, result.reasoning);
                    if (reasoning.trim()) options?.onReasoning?.(reasoning.trim());
                    reportUsage(effectiveConfig, data, options, messages);
                    return {
                        text: text || '',
                        reasoning: reasoning.trim(),
                        toolCalls: [],
                        ...observeFinishReason(effectiveConfig, data, options),
                        assistantMessage: { role: 'assistant', content: text || '' },
                    } satisfies ChatTurnResult;
                }
                if (effectiveConfig.apiFormat === 'chat_completions') {
                    return chatCompletionsTurn(effectiveConfig, messages, options);
                }
                // Other formats: reuse string path; text-protocol tools still work.
                // The string transports report the stop signal themselves, so
                // capture it on the way through rather than re-parsing a body
                // this layer never sees.
                let passthroughFinish: FinishReason = 'unknown';
                const captured: ChatRequestOptions = {
                    ...options,
                    onFinishReason: (reason) => {
                        passthroughFinish = reason;
                        options?.onFinishReason?.(reason);
                    },
                };
                // One dispatch, shared with sendChatRequestOnce: the format →
                // transport rule is not restated per call path.
                const text = await stringTransportFor(effectiveConfig.apiFormat)(effectiveConfig, wireMessages, captured);
                return {
                    text,
                    reasoning: '',
                    toolCalls: [],
                    finishReason: passthroughFinish,
                    truncated: truncatesOutput(passthroughFinish),
                    assistantMessage: { role: 'assistant', content: text },
                } satisfies ChatTurnResult;
            },
            (effectiveConfig.name as ProviderName) || 'Provider',
            retryAttemptsForPolicy(effectiveConfig.retryPolicy),
            options?.signal
        );
        recordProviderSuccess(config.id, Date.now() - startedAt);
        return result;
    } catch (error) {
        const err = error as { name?: string; code?: string };
        const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'TimeoutError';
        if (!isAbort) recordProviderError(config.id, error);
        throw toFriendlyProviderError(error, `${effectiveConfig.name} · ${effectiveConfig.selectedModel}`);
    }
}

/** The buffered Electron result carries the full reasoning trace. Return only
 *  what the chunk channel did not already paint, so a provider that ignored
 *  stream:true loses no thought and a normal stream gains no duplicate. */
export function unstreamedReasoningTail(streamed: string, settled?: string): string {
    const full = settled ?? '';
    if (!full || full === streamed) return '';
    return full.startsWith(streamed) ? full.slice(streamed.length) : full;
}

/**
 * Desktop live paint over the Electron bridge. main.cjs parses the provider's
 * SSE stream and pushes deltas on `provider:chunk`; this generator yields
 * text deltas as they land and forwards reasoning deltas to
 * options.onReasoning — so the thinking strip and the AnalyzedRow timer start
 * at the first thought, not the last byte. On invoke resolution it delivers
 * the accumulated native tool calls via options.onStreamToolCalls: the old
 * single-chunk short-circuit dropped them, so native seats silently lost
 * every tool round on desktop.
 *
 * If nothing streamed (provider ignored stream:true — main falls back to the
 * buffered parse and returns the whole text in the final result), the text is
 * yielded once whole; the consumer never sees a blank bubble.
 */
async function* streamViaElectronBridge(
    config: ProviderConfig,
    messages: ChatMessage[],
    options: ChatRequestOptions | undefined,
    electronAPI: NonNullable<Window['electronAPI']>,
): AsyncGenerator<string, void, unknown> {
    const wireMessages = reasoningPreambleMessages(config, messages, options);
    const requestId = `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue: string[] = [];
    let yielded = '';
    let sawTextChunk = false;
    let streamedReasoning = '';
    let wake: (() => void) | null = null;
    let settled = false;
    const notify = (): void => { wake?.(); wake = null; };
    // Route think-tag bodies to the reasoning channel, exactly as the other
    // two streaming paths do (`chatCompletionsStream`, `streamViaProxy`). This
    // bridge did not, so on the PACKAGED APP a reasoning model that leaks
    // <think> markup inside `content` painted its scratchpad straight into the
    // visible answer bubble. The settle-time cleanup peeled it back out, which
    // is why it read as a flicker rather than a failure — but the raw markup
    // was on screen, and the Thinking row never started its timer.
    const gate = createThinkingStreamGate();
    const unsubscribe = electronAPI.onProviderChunk?.((chunk) => {
        if (!chunk || chunk.requestId !== requestId) return;
        if (chunk.type === 'reasoning') {
            streamedReasoning += chunk.delta;
            options?.onReasoning?.(chunk.delta);
            return;
        }
        sawTextChunk = true;
        const gated = gate.push(chunk.delta);
        if (gated.orphanClose) {
            // Notify caller FIRST so already-yielded pre-</think> text moves
            // to reasoning before later queued chunks are flushed.
            options?.onOrphanThinkClose?.();
            if (queue.length > 0) {
                options?.onReasoning?.(queue.join(''));
                queue.length = 0;
            }
        }
        if (gated.thinking.length > 0) options?.onReasoning?.(gated.thinking);
        if (gated.visible) queue.push(gated.visible);
        notify();
    });
    const cancelRequest = (): void => { void electronAPI.cancelProviderChat?.(requestId); };
    options?.signal?.addEventListener('abort', cancelRequest, { once: true });
    if (options?.signal?.aborted) cancelRequest();
    // STREAMING budget (300s), NOT the 120s non-streaming cap: reasoning-heavy
    // desktop answers stream well past 120s and this renderer-side timer used
    // to cancel them mid-stream on the very transport main.cjs gives 300s.
    // (Web streams get the same 300s via withStreamTimeoutSignal.)
    const timeout = window.setTimeout(() => cancelRequest(), STREAM_TIMEOUT_MS);
    const invoke = electronAPI.providerChat!({
        config,
        messages: wireMessages,
        requestId,
        stream: true,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        reasoningEffort: options?.reasoningEffort,
        tools: options?.tools,
        toolChoice: options?.toolChoice,
        reasoningPatch: reasoningPatchFor(config, options),
    }).catch((err: unknown): Awaited<ReturnType<NonNullable<typeof electronAPI.providerChat>>> => ({
        ok: false,
        message: err instanceof Error ? err.message : 'Provider bridge call failed.',
    })).finally(() => { settled = true; notify(); });
    try {
        while (true) {
            while (queue.length > 0) {
                const delta = queue.shift() as string;
                yielded += delta;
                yield delta;
            }
            if (settled) break;
            await new Promise<void>(resolve => { wake = resolve; });
        }
        while (queue.length > 0) {
            const delta = queue.shift() as string;
            yielded += delta;
            yield delta;
        }
        const result = await invoke;
        // Flush the gate BEFORE the buffered-tail fallback: if the stream
        // stopped mid-think-block the visible remainder is sitting in the GATE,
        // not the queue, and yielding result.text on top would double-paint.
        // Same order the other two streaming paths use.
        const flushed = gate.flush();
        if (flushed.thinking.length > 0) options?.onReasoning?.(flushed.thinking);
        if (flushed.visible) { yielded += flushed.visible; yield flushed.visible; }
        if (!result.ok) {
            const error = new Error(result.message || 'Provider request failed.');
            if (result.status !== undefined) (error as { status?: number }).status = result.status;
            if (result.code !== undefined) (error as { code?: string }).code = result.code;
            throw error;
        }
        const reasoningTail = unstreamedReasoningTail(streamedReasoning, result.reasoning);
        if (reasoningTail) options?.onReasoning?.(reasoningTail);
        if (result.toolCalls && result.toolCalls.length > 0) options?.onStreamToolCalls?.(result.toolCalls);
        reportUsageDirect(config, result.usage, options, messages);
        reportFinishReason(config, normalizeFinishReason(result.finishReason), options);
        // Buffered fallback / lost tail: paint whatever the stream missed.
        // Only append a tail that is ACTUALLY a continuation. `result.text` is
        // the provider's raw accumulated text and `yielded` is the VISIBLE output
        // after the think-gate stripped inline reasoning — so slicing by a
        // character count re-emits stripped markup or duplicates text whenever the
        // two differ (the 2026-10-27 audit L-5). When nothing streamed at all,
        // peel inline `<think>` blocks first so raw markup never enters answer prose.
        if (!sawTextChunk && !yielded && result.text) {
            const stripped = extractAndStripThinkBlocks(result.text);
            if (stripped.leaked) options?.onReasoning?.(stripped.leaked);
            if (stripped.visible) yield stripped.visible;
        } else if (result.text && result.text.startsWith(yielded) && result.text.length > yielded.length) {
            yield result.text.slice(yielded.length);
        }
    } finally {
        window.clearTimeout(timeout);
        options?.signal?.removeEventListener('abort', cancelRequest);
        if (typeof unsubscribe === 'function') unsubscribe();
    }
}

/**
 * Stream a chat response from any provider as an async generator.
 * Desktop: streams through the Electron bridge (main.cjs parses the SSE for
 * all three wire formats and pushes provider:chunk deltas). Web: currently
 * supports chat_completions (the dominant format) via proxy/SDK streaming;
 * messages/responses formats fall back to non-streaming and yield the full
 * result once. Streaming applies the same hard timeout as non-streaming calls.
 */
export async function* streamChatRequest(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): AsyncGenerator<string, void, unknown> {
    let yielded = false;
    try {
        for await (const delta of streamChatRequestOnce(config, messages, options)) {
            yielded = true;
            yield delta;
        }
    } catch (error) {
        // A retry only exists while the bubble is still empty. Once a delta has
        // been painted, re-answering would append a SECOND reply to the first
        // one, and a context rejection that arrives mid-stream is a different
        // problem (the provider's own output cap, not the prompt).
        if (yielded) throw error;
        const retry = contextRecoveryMessages(config, messages, options, error);
        if (!retry) throw error;
        yield* streamChatRequestOnce(config, retry, options);
    }
}

async function* streamChatRequestOnce(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): AsyncGenerator<string, void, unknown> {
    assertHasKey(config);
    const effectiveConfig = {
        ...config,
        apiKey: config.apiKey?.trim() || 'not-needed'
    };
    try {
        const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
        if (electronAPI?.isElectron && electronAPI.providerChat) {
            // JSON-mode streams take the BUFFERED bridge, not the chunk bridge:
            // streamViaElectronBridge's payload carries no jsonMode/jsonSchema
            // (the chunk protocol cannot express them — main.cjs parses streamed
            // SSE as plain text and its streamRequested() guard only keeps
            // jsonMode calls buffered when it can SEE them). Yielding the full
            // text once via sendChatRequest — which DOES forward jsonMode/
            // jsonSchema — keeps the wire policy intact; a chunk-bridged
            // jsonMode call would silently lose constrained decoding on
            // desktop while web/proxy streams honored it.
            if (electronAPI.onProviderChunk && !options?.jsonMode) {
                yield* streamViaElectronBridge(effectiveConfig, messages, options, electronAPI);
                return;
            }
            // Shell without the chunk channel (old preload), or a jsonMode
            // stream the chunk bridge cannot represent — buffered as before.
            yield await sendChatRequestOnce(effectiveConfig, messages, options);
            return;
        }
        // Dev browser on localhost: route through the CORS-avoiding Vite
        // provider proxy, which passes SSE through. Direct SDK streaming from
        // the browser fails for providers without CORS headers (e.g. opencode).
        if (usesDevProviderProxy()) {
            const canStreamFormat = effectiveConfig.apiFormat === 'chat_completions'
                || (!options?.jsonMode && (
                    effectiveConfig.apiFormat === 'messages'
                    || effectiveConfig.apiFormat === 'responses'
                    || effectiveConfig.apiFormat === 'google'
                ));
            if (canStreamFormat) {
                const startedAt = Date.now();
                try {
                    yield* streamViaProxy(effectiveConfig, messages, options);
                    recordProviderSuccess(config.id, Date.now() - startedAt);
                } catch (streamError) {
                    const err = streamError as { name?: string; code?: string };
                    const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'TimeoutError';
                    if (!isAbort) recordProviderError(config.id, streamError);
                    throw streamError;
                }
                return;
            }
            // JSON-mode fallback for non-chat_completions formats through the proxy.
            const full = await sendChatRequestOnce(effectiveConfig, messages, options);
            yield full;
            return;
        }
        if (effectiveConfig.apiFormat === 'chat_completions') {
            const startedAt = Date.now();
            try {
                yield* chatCompletionsStream(effectiveConfig, messages, { ...options, signal: withStreamTimeoutSignal(options?.signal) });
                recordProviderSuccess(config.id, Date.now() - startedAt);
            } catch (streamError) {
                const err = streamError as { name?: string; code?: string };
                const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.name === 'TimeoutError';
                if (!isAbort) recordProviderError(config.id, streamError);
                throw streamError;
            }
            return;
        }
        // Fallback for non-OpenAI-compat formats: fetch then yield once.
        // Inside the try so its errors flow through toFriendlyProviderError
        // (previously this sat after the catch and bypassed friendly mapping).
        const full = await sendChatRequestOnce(effectiveConfig, messages, options);
        yield full;
    } catch (error) {
        throw toFriendlyProviderError(error, effectiveConfig.name);
    }
}

/**
 * Stream chat_completions through the localhost dev provider proxy. The proxy
 * pipes the upstream SSE response through; we parse `data:` events here and
 * yield content deltas while forwarding reasoning deltas to onReasoning.
 */
/** Accumulates OpenAI streamed tool_call deltas (fragmented across chunks
 *  and keyed by index) into complete calls. Shared by both chat_completions
 *  streaming paths (direct SDK + dev proxy) so the desk-tool loop can stream
 *  text live AND still loop on native tool calls. */
class StreamToolCallBuffer {
    private readonly parts = new Map<number, { id: string; name: string; args: string }>();

    push(delta: unknown): void {
        const frags = (delta as { tool_calls?: unknown })?.tool_calls;
        if (!Array.isArray(frags)) return;
        frags.forEach((f: { index?: number; id?: string; function?: { name?: string; arguments?: string } }, position: number) => {
            // Complete buffered messages omit index; array position is the only
            // stable identity that keeps parallel calls from merging into one.
            const idx = Number.isFinite(f?.index) ? Number(f.index) : position;
            const part = this.parts.get(idx) ?? { id: '', name: '', args: '' };
            if (typeof f?.id === 'string' && f.id) part.id = f.id;
            if (typeof f?.function?.name === 'string') part.name += f.function.name;
            if (typeof f?.function?.arguments === 'string') part.args += f.function.arguments;
            this.parts.set(idx, part);
        });
    }

    pushFragment(index: number, init: { id?: string; name?: string; argsDelta?: string }): void {
        const idx = Number.isFinite(index) ? index : 0;
        const part = this.parts.get(idx) ?? { id: '', name: '', args: '' };
        if (typeof init.id === 'string' && init.id) part.id = init.id;
        if (typeof init.name === 'string' && init.name) part.name += init.name;
        if (typeof init.argsDelta === 'string' && init.argsDelta) part.args += init.argsDelta;
        this.parts.set(idx, part);
    }

    /** Deliver complete calls to onStreamToolCalls; returns them (null = none). */
    finish(options?: Pick<ChatRequestOptions, 'onStreamToolCalls'>): Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null {
        if (this.parts.size === 0) return null;
        const calls = [...this.parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, p]) => ({
                id: p.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                name: p.name,
                arguments: parseStreamedToolArguments(p.args),
            }))
            .filter(c => c.name.length > 0);
        if (calls.length > 0) options?.onStreamToolCalls?.(calls);
        return calls.length > 0 ? calls : null;
    }
}

/** Tool-call arguments accumulate as a JSON string; a truncated stream must
 *  still reach the executor as an object (marked) rather than throwing. */
const parseStreamedToolArguments = (raw: string): Record<string, unknown> => {
    if (!raw.trim()) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { value: parsed };
    } catch {
        return { _unparsed: raw };
    }
};

/** Client-side reasoning translation for the proxy routes: the capability
 *  classes live in reasoningControls (renderer side), so the middleware
 *  never imports app services — it just merges this patch into the body.
 *  'auto'/absent effort ⇒ undefined (no key, no body change). */
const reasoningPatchFor = (
    config: ProviderConfig,
    options?: ChatRequestOptions,
): Record<string, unknown> | undefined => {
    const effort = options?.reasoningEffort ?? 'auto';
    if (config.apiFormat === 'messages') {
        const fields = anthropicThinkingFields({
            modelId: config.selectedModel || '',
            displayName: config.name,
            capabilityOverride: config.thinkingCapable,
            maxTokens: options?.maxTokens ?? 4096,
            temperature: options?.temperature,
            jsonMode: options?.jsonMode,
            reasoningEffort: effort,
        });
        const thinkingSent = !!fields.thinking;
        const audit: ReturnType<typeof buildReasoningPatch>['audit'] = {
            route: thinkingSent ? 'anthropic-thinking' : 'none',
            effort,
            applied: thinkingSent,
            reason: thinkingSent
                ? `thinking budget_tokens=${fields.thinking!.budget_tokens} (effort ${effort})`
                : `no thinking block (effort ${effort})`,
        };
        options?.onWireAudit?.(audit);
        return undefined;
    }
    if (config.apiFormat === 'google') {
        const geminiThinking = geminiThinkingParams(
            options?.jsonMode,
            config.selectedModel || '',
            effort,
            options?.maxTokens ?? 4096,
        );
        const audit: ReturnType<typeof buildReasoningPatch>['audit'] = geminiThinking
            ? {
                route: 'gemini-thinking',
                effort,
                applied: true,
                reason: `thinkingConfig.thinkingBudget=${geminiThinking.thinkingBudget}`,
            }
            : {
                route: 'none',
                effort,
                applied: false,
                reason: options?.jsonMode
                    ? 'google generateContent: JSON mode sends no thinkingConfig'
                    : (effort === 'off'
                        ? 'google generateContent: effort=off suppresses thinkingConfig'
                        : 'google generateContent: no thinkingConfig for this model'),
            };
        options?.onWireAudit?.(audit);
        return undefined;
    }
    if (!options?.reasoningEffort || options.reasoningEffort === 'auto') return undefined;
    const { patch, audit } = buildReasoningPatch(config, options.reasoningEffort);
    options?.onWireAudit?.(audit);
    return Object.keys(patch).length > 0 ? patch : undefined;
};

/** Custom gateways can silently skip the reasoning channel when a large desk
 *  prompt goes straight to tool_calls. A separate, leading system message keeps
 *  the instruction outside that prompt's output-format rules; the live SSE
 *  proof for Kilo/Ernie requires reasoning to arrive before the first tool. */
export const reasoningPreambleMessages = (
    config: Pick<ProviderConfig, 'id' | 'baseUrl' | 'apiFormat' | 'selectedModel'>,
    messages: ChatMessage[],
    options?: ChatRequestOptions,
): ChatMessage[] => {
    if (config.apiFormat !== 'chat_completions' || !options?.tools?.length) return messages;
    const { audit } = buildReasoningPatch(config, options.reasoningEffort ?? 'auto');
    if (audit.route !== 'custom-effort' || !audit.applied) return messages;
    if (messages[0]?.role === 'system' && messages[0].content === REASONING_CHANNEL_PROMPT) return messages;
    return [{ role: 'system', content: REASONING_CHANNEL_PROMPT }, ...messages];
};

export interface BrowserSseParsedBatch {
    reasoningDeltas: string[];
    textDeltas: string[];
    orphanClose?: boolean;
    finishReason?: FinishReason;
    usagePayload?: unknown;
    error?: Error;
    done?: boolean;
}

/** Incremental multi-format SSE / NDJSON parser for the browser `/__provider_proxy`
 *  stream and unit tests. Supports `chat_completions`, Anthropic `messages`,
 *  OpenAI `responses`, and Google `google`, dispatching complete JSON frames on
 *  single newlines as well as blank-line SSE boundaries while peeling chunk-split
 *  `<think>` tags. */
export const createBrowserSseParser = (apiFormat: ProviderConfig['apiFormat']) => {
    let lineBuf = '';
    let dataLines: string[] = [];
    const gate = createThinkingStreamGate();
    const toolBuf = new StreamToolCallBuffer();
    let droppedEvents = 0;

    const toChunkError = (chunk: any): Error | null => {
        if (!chunk || typeof chunk !== 'object') return null;
        const errObj = chunk.error && typeof chunk.error === 'object' ? chunk.error : null;
        const isErrEvent = chunk.type === 'error' || chunk.type === 'response.failed';
        if (!errObj && !chunk.error && !isErrEvent) return null;
        const message = errObj?.message
            || errObj?.type
            || chunk.response?.error?.message
            || (typeof chunk.error === 'string' ? chunk.error : '')
            || `Provider stream error (${errObj?.code ?? 'unknown'})`;
        const error = new Error(String(message));
        const code = errObj?.code ?? chunk.status;
        if (typeof code === 'number') (error as any).status = code;
        else if (typeof code === 'string' && /^\d{3}$/.test(code)) (error as any).status = Number(code);
        if (errObj?.status !== undefined) (error as any).status = errObj.status;
        return error;
    };

    const routeVisible = (rawText: string, batch: BrowserSseParsedBatch): void => {
        if (!rawText) return;
        const gated = gate.push(rawText);
        if (gated.orphanClose) {
            batch.orphanClose = true;
            if (batch.textDeltas.length > 0) {
                batch.reasoningDeltas.push(...batch.textDeltas);
                batch.textDeltas.length = 0;
            }
        }
        if (gated.thinking.length > 0) batch.reasoningDeltas.push(gated.thinking);
        if (gated.visible.length > 0) batch.textDeltas.push(gated.visible);
    };

    const handleChunk = (chunk: any, batch: BrowserSseParsedBatch): void => {
        const err = toChunkError(chunk);
        if (err) {
            batch.error = err;
            batch.done = true;
            return;
        }
        if (apiFormat === 'messages') {
            if (chunk?.type === 'message_start' && chunk?.message?.usage) {
                batch.usagePayload = { usage: chunk.message.usage };
            } else if (chunk?.type === 'content_block_start' && chunk?.content_block?.type === 'tool_use') {
                toolBuf.pushFragment(chunk.index ?? 0, {
                    id: chunk.content_block.id || '',
                    name: chunk.content_block.name || '',
                });
            } else if (chunk?.type === 'content_block_delta') {
                const d = chunk.delta || {};
                if (d.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
                    routeVisible(d.text, batch);
                } else if (d.type === 'thinking_delta' || d.type === 'reasoning_delta') {
                    const reasoning = typeof d.thinking === 'string' ? d.thinking : (typeof d.text === 'string' ? d.text : '');
                    if (reasoning.length > 0) batch.reasoningDeltas.push(reasoning);
                } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                    toolBuf.pushFragment(chunk.index ?? 0, { argsDelta: d.partial_json });
                }
            } else if (chunk?.type === 'message_delta') {
                if (chunk.usage) batch.usagePayload = chunk;
                if (chunk.delta?.stop_reason) batch.finishReason = normalizeFinishReason(chunk.delta.stop_reason);
            } else if (chunk?.type === 'message_stop') {
                batch.done = true;
            }
            return;
        }
        if (apiFormat === 'responses') {
            if (chunk?.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
                routeVisible(chunk.delta, batch);
            } else if (
                (chunk?.type === 'response.reasoning_summary_text.delta'
                    || chunk?.type === 'response.output_reasoning.text.delta'
                    || chunk?.type === 'response.reasoning_text.delta')
                && typeof chunk.delta === 'string'
                && chunk.delta.length > 0
            ) {
                batch.reasoningDeltas.push(chunk.delta);
            } else if (chunk?.type === 'response.output_item.added' && chunk?.item?.type === 'function_call') {
                toolBuf.pushFragment(chunk.output_index ?? 0, {
                    id: chunk.item.call_id || chunk.item.id || '',
                    name: chunk.item.name || '',
                });
            } else if (chunk?.type === 'response.function_call_arguments.delta' && typeof chunk.delta === 'string') {
                toolBuf.pushFragment(chunk.output_index ?? 0, { argsDelta: chunk.delta });
            } else if (chunk?.type === 'response.completed') {
                if (chunk.response?.usage) batch.usagePayload = { usage: chunk.response.usage };
                const status = chunk.response?.status;
                if (status) batch.finishReason = normalizeFinishReason(status);
                batch.done = true;
            }
            return;
        }
        if (apiFormat === 'google') {
            if (chunk?.usageMetadata) batch.usagePayload = chunk;
            const candidate = chunk?.candidates?.[0];
            if (candidate?.finishReason) batch.finishReason = normalizeFinishReason(candidate.finishReason);
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (!part || typeof part.text !== 'string' || part.text.length === 0) continue;
                    if (part.thought === true) batch.reasoningDeltas.push(part.text);
                    else routeVisible(part.text, batch);
                }
            }
            return;
        }
        // chat_completions (default)
        if (chunk?.usage) batch.usagePayload = chunk;
        const finish = chunk?.choices?.[0]?.finish_reason;
        if (finish) batch.finishReason = normalizeFinishReason(finish);
        const bufferedMessage = chunk?.choices?.[0]?.message;
        if (bufferedMessage && !chunk?.choices?.[0]?.delta) {
            // Some gateways ignore stream:true and label a normal JSON body as
            // a stream. Read its message shape instead of consuming it as an
            // empty delta and losing both reasoning and native tool calls.
            const buffered = readWireBody('chat_completions', chunk);
            if (buffered.reasoning) batch.reasoningDeltas.push(buffered.reasoning);
            routeVisible(buffered.text, batch);
            toolBuf.push({ tool_calls: bufferedMessage.tool_calls });
            return;
        }
        const delta = chunk?.choices?.[0]?.delta || {};
        toolBuf.push(delta);
        const reasoning = deltaReasoning(delta);
        if (reasoning.length > 0) batch.reasoningDeltas.push(reasoning);
        routeVisible(deltaVisibleText(delta), batch);
    };

    const dispatchDataLines = (batch: BrowserSseParsedBatch): void => {
        if (dataLines.length === 0) return;
        const data = dataLines.join('\n').trim();
        dataLines = [];
        if (!data) return;
        if (data === '[DONE]') {
            batch.done = true;
            return;
        }
        let chunk: any;
        try {
            chunk = JSON.parse(data);
        } catch {
            droppedEvents += 1;
            if (droppedEvents === 1) console.warn(`[ProxyStream] Dropping non-JSON SSE events (first seen: ${data.slice(0, 80)})`);
            return;
        }
        handleChunk(chunk, batch);
    };

    const processLine = (rawLine: string, batch: BrowserSseParsedBatch): void => {
        const line = rawLine.replace(/\r$/, '');
        if (line === '') {
            dispatchDataLines(batch);
            return;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
            const joined = dataLines.join('\n').trim();
            if (joined === '[DONE]') {
                dataLines = [];
                batch.done = true;
                return;
            }
            if (joined.startsWith('{') || joined.startsWith('[')) {
                try {
                    const parsed = JSON.parse(joined);
                    dataLines = [];
                    handleChunk(parsed, batch);
                } catch {
                    // Multi-line JSON event; wait for remaining data: lines or blank line.
                }
            }
            return;
        }
        if (dataLines.length === 0 && line.trimStart().startsWith('{')) {
            try {
                const parsed = JSON.parse(line);
                handleChunk(parsed, batch);
            } catch {
                // Ignore incomplete/non-JSON non-data line.
            }
        }
    };

    return {
        push(textChunk: string): BrowserSseParsedBatch {
            const batch: BrowserSseParsedBatch = { reasoningDeltas: [], textDeltas: [] };
            if (!textChunk) return batch;
            lineBuf = (lineBuf + textChunk).replace(/\r\n/g, '\n');
            let nl: number;
            while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl);
                lineBuf = lineBuf.slice(nl + 1);
                processLine(line, batch);
                if (batch.error) return batch;
            }
            return batch;
        },
        flush(options?: Pick<ChatRequestOptions, 'onStreamToolCalls'>): BrowserSseParsedBatch {
            const batch: BrowserSseParsedBatch = { reasoningDeltas: [], textDeltas: [] };
            if (lineBuf.length > 0) {
                const trailingLine = lineBuf;
                lineBuf = '';
                processLine(trailingLine, batch);
                if (batch.error) return batch;
            }
            dispatchDataLines(batch);
            if (batch.error) return batch;
            const flushed = gate.flush();
            if (flushed.thinking.length > 0) batch.reasoningDeltas.push(flushed.thinking);
            if (flushed.visible.length > 0) batch.textDeltas.push(flushed.visible);
            toolBuf.finish(options);
            return batch;
        },
    };
};

async function* streamViaProxy(
    config: ProviderConfig,
    messages: ChatMessage[],
    options?: ChatRequestOptions
): AsyncGenerator<string, void, unknown> {
    const wireMessages = reasoningPreambleMessages(config, messages, options);
    // Retry the OPEN of the stream on transient failures (429 / network /
    // 5xx) with the same backoff the non-streaming path uses — without it,
    // one rate-limit blip killed a bot room turn instantly while casual
    // chat (sendChatRequest → withRetry) recovered silently. Only the
    // request open is retried: once SSE bytes start flowing, a mid-stream
    // failure surfaces as an error instead of replaying the answer.
    const response = await withRetry(async () => {
        const patch = reasoningPatchFor(config, options);
        const attempt = await fetch(DEV_PROVIDER_PROXY_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config,
                messages: wireMessages,
                maxTokens: options?.maxTokens,
                temperature: options?.temperature,
                reasoningEffort: options?.reasoningEffort,
                jsonMode: options?.jsonMode,
                jsonSchema: resolveWireJsonSchema(config, options),
                // Native tool-calling over SSE — without these the proxy strip
                // silently downgrades every streamed chat to tool-less, so the
                // desk tools never fire in the dev browser.
                tools: options?.tools,
                toolChoice: options?.toolChoice,
                ...(options?.tools?.length ? { tool_choice: options?.toolChoice ?? 'auto' } : options?.toolChoice ? { tool_choice: options.toolChoice } : {}),
                // Reasoning patch is translated CLIENT-side (capability classes
                // live in reasoningControls); the middleware just merges it.
                reasoningPatch: patch,
                ...(patch ?? {}),
                stream: true,
            }),
            signal: withStreamTimeoutSignal(options?.signal),
        });
        if (!attempt.ok || !attempt.body) {
            const result = await attempt.json().catch(() => null);
            const message = result?.message || `Provider stream failed (${attempt.status}).`;
            const error = new Error(message);
            // The HTTP status is the ground truth and must survive the throw.
            // It used to be copied ONLY when the provider's own JSON body carried
            // a `status` field, and the OpenAI-compatible 429 body is
            // `{error:{message,type,code}}` — no `status`. So a real rate limit on
            // the streaming path reached the pipeline as a plain Error whose text
            // is `Provider stream failed (429).`, which `classifyRunFailure`
            // (hooks/analysisPipeline/runOutcome.ts:48) matches against neither
            // `status === 429` nor "Too Many Requests": every streaming 429 was
            // filed as a generic failure, so the backoff branch never ran
            // (the 2026-10-27 audit L-1b, reproduced in the browser). A body that states
            // its own status still wins — some gateways are more specific.
            (error as any).status = result?.status ?? attempt.status;
            throw error;
        }
        return attempt;
    }, (config.name as ProviderName) || 'Provider', retryAttemptsForPolicy(config.retryPolicy), options?.signal);
    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
        const data = await response.json().catch(() => ({}));
        if (data?.error) {
            throw new Error(data.error.message || 'Provider request failed.');
        }
        const { text, reasoning } = readWireBody(config.apiFormat, data);
        if (reasoning.trim()) options?.onReasoning?.(reasoning.trim());
        reportUsage(config, data, options, messages);
        observeFinishReason(config, data, options);
        const toolCalls = data?.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            const calls = toolCalls.map((tc: any, i: number) => ({
                id: tc?.id || `call_${i}`,
                name: String(tc?.function?.name || ''),
                arguments: parseStreamedToolArguments(String(tc?.function?.arguments || '')),
            })).filter((c: { name: string }) => c.name);
            if (calls.length > 0) options?.onStreamToolCalls?.(calls);
        }
        if (text) yield text;
        return;
    }
    if (!response.body) {
        throw new Error('Provider stream returned no body.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createBrowserSseParser(config.apiFormat);
    let proxyFinish: FinishReason | undefined;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const batch = parser.push(decoder.decode(value, { stream: true }));
            if (batch.usagePayload) reportUsage(config, batch.usagePayload, options, messages);
            if (batch.finishReason) proxyFinish = batch.finishReason;
            if (batch.orphanClose) options?.onOrphanThinkClose?.();
            for (const r of batch.reasoningDeltas) options?.onReasoning?.(r);
            for (const t of batch.textDeltas) yield t;
            if (batch.error) throw batch.error;
        }
        const tailBatch = parser.flush(options);
        if (tailBatch.usagePayload) reportUsage(config, tailBatch.usagePayload, options, messages);
        if (tailBatch.finishReason) proxyFinish = tailBatch.finishReason;
        if (tailBatch.orphanClose) options?.onOrphanThinkClose?.();
        for (const r of tailBatch.reasoningDeltas) options?.onReasoning?.(r);
        for (const t of tailBatch.textDeltas) yield t;
        if (tailBatch.error) throw tailBatch.error;
        reportFinishReason(config, proxyFinish ?? 'unknown', options);
    } finally {
        reader.releaseLock();
    }
}

/**
 * Quick single-turn response from a provider.
 */
export async function getQuickResponse(
    config: ProviderConfig,
    prompt: string,
    historyOrSystem?: string | any[],
    options?: ChatRequestOptions
): Promise<string> {
    const chatMessages: ChatMessage[] = [];

    if (Array.isArray(historyOrSystem)) {
        historyOrSystem.forEach(msg => {
            if (msg && typeof msg === 'object') {
                if ('role' in msg && 'text' in msg) {
                    const r = msg.role;
                    const role = r === 'user' || r === 'USER'
                        ? 'user'
                        : r === 'system' || r === 'SYSTEM'
                            ? 'system'
                            : 'assistant';
                    chatMessages.push({
                        role,
                        content: msg.text || ''
                    });
                } else if ('role' in msg && 'content' in msg) {
                    chatMessages.push(msg as ChatMessage);
                }
            }
        });
    } else if (typeof historyOrSystem === 'string' && historyOrSystem.trim()) {
        chatMessages.push({ role: 'system', content: historyOrSystem });
    }

    if (!chatMessages.some(m => m.content === prompt)) {
        chatMessages.push({ role: 'user', content: prompt });
    }

    return sendChatRequest(config, chatMessages, { maxTokens: 2048, ...options });
}

/**
 * Test a provider connection with a minimal request.
 */
export async function testConnection(config: ProviderConfig): Promise<{ success: boolean; message: string }> {
    const model = config.selectedModel?.trim();
    if (!model) {
        return { success: false, message: 'Choose a model before testing the connection.' };
    }

    try {
        const testConfig = {
            ...config,
            apiKey: config.apiKey?.trim() || 'not-needed',
            selectedModel: model,
        };
        const result = await sendChatRequest(
            testConfig,
            [{ role: 'user', content: 'Reply with exactly: OK' }],
            { maxTokens: 64, temperature: 0, signal: AbortSignal.timeout(30_000) }
        );
        // Verify the response actually contains the expected token — a 200
        // with empty/error content used to report "Connected successfully",
        // and max_tokens 10 truncated reasoning models into false failures.
        if (!/OK/i.test(result || '')) {
            return { success: false, message: `${config.name} · ${model} responded without the expected 'OK'.` };
        }
        return { success: true, message: `${config.name} · ${model} replied OK` };
    } catch (error: any) {
        return { success: false, message: error.message || 'Connection failed' };
    }
}
