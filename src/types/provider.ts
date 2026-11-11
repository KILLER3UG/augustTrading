// =============================================================================
// PROVIDER CONFIGURATION TYPES
// Runtime-configurable AI provider settings with custom provider support
// =============================================================================

/**
 * API format determines how requests are sent to the provider.
 * - chat_completions: OpenAI-compatible /v1/chat/completions (most providers)
 * - messages: Anthropic-style /v1/messages
 * - responses: OpenAI Responses API /responses
 * - google: Gemini generateContent (generativelanguage.googleapis.com)
 */
export type ApiFormat = 'chat_completions' | 'messages' | 'responses' | 'google';

/**
 * Harness-level reasoning effort — the thinking tier a request was sent under.
 *  - 'off'   = explicitly ask the model NOT to think (composer toggle)
 *  - 'auto'  = no override; the task's own schedule decides
 *  - 'low' … 'max' = an explicit rung on the ladder
 *
 * It lives HERE, in the wire vocabulary, because a `Message` and a stored
 * chat entry both have to carry the tier that produced them: the answer row
 * shows the tier the desk was given, and that fact outlives the request. The
 * services that resolve it (`services/providers/reasoningControls.ts`) own the
 * SCHEDULE and the resolution, and re-export this type, so there is one
 * union — not one per layer that mentions it.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto';

/**
 * Which capability route the transport applied to one request.
 *
 *  - 'anthropic-thinking' / 'gemini-thinking' — a thinking block was sent
 *  - 'openai-effort' / 'xai-effort' / 'responses-effort' — an effort knob
 *  - 'glm-thinking' / 'deepseek-thinking' — the vendors' own switches
 *  - 'none' — no route applied, and the reason says why
 */
export type WireAuditRoute =
    | 'xai-effort'
    | 'openai-effort'
    | 'glm-thinking'
    | 'deepseek-thinking'
    | 'anthropic-thinking'
    | 'responses-effort'
    | 'gemini-thinking'
    | 'none';

/**
 * One audit line per call — what the wire actually received, and why.
 *
 * It lives HERE, in the wire vocabulary, because the answer's row has to carry
 * it: a turn that returned no trace has to be able to say WHY (no route, a
 * closed gate, a model that does not think), and that fact outlives the
 * request. The services that decide the route
 * (`services/providers/reasoningControls.ts`) own the DECISION and re-export
 * this type, so there is one shape — not one per layer that mentions it.
 */
export interface WireAuditEntry {
    /** Which capability route was applied ('none' = fail-closed no-op). */
    route: WireAuditRoute;
    /** The harness effort tier that drove the translation. */
    effort: ReasoningEffort;
    /** Machine-readable outcome — the runStats / known-answer-probe substrate. */
    applied: boolean;
    /** Human-readable reason (surfaced in the DebateRunLog budget lines). */
    reason: string;
}

/**
 * Configuration for a single AI provider.
 * Built-in providers have isBuiltIn=true and cannot be deleted.
 * Custom providers have isBuiltIn=false and can be added/removed freely.
 */
export interface ProviderConfig {
  id: string;                    // Unique ID (e.g., 'gemini', 'custom-1720000000')
  name: string;                  // Display name (e.g., 'Gemini', 'My Local LLM')
  apiKey: string;                // User-entered API key; encrypted at rest on Electron when safeStorage is available
  /**
   * True when the stored key is NOT encrypted at rest - no working OS
   * keyring on this machine (e.g. Linux without gnome-keyring/kwallet), or a
   * web/Capacitor build that never encrypted. Set by the store, shown by the
   * provider editor, so "encrypted at rest" is a claim the app can back.
   */
  apiKeyPlaintext?: boolean;
  baseUrl: string;               // API base URL (e.g., 'https://api.openai.com/v1')
  apiFormat: ApiFormat;          // Which API format to use
  isEnabled: boolean;            // Whether this provider is active
  isBuiltIn: boolean;            // true = default provider, false = user-added
  models: string[];              // Available model IDs
  selectedModel: string;         // Currently selected model ID
  /** Models included when Ensemble mode is enabled (maximum three total). */
  /** Optional USD per 1k prompt tokens for run cost estimates. */
  inputUsdPer1k?: number;
  /** Optional USD per 1k completion tokens for run cost estimates. */
  outputUsdPer1k?: number;
  /**
   * Override for Anthropic extended-thinking eligibility on this provider
   * (apiFormat 'messages'). undefined = decide by model-id regex;
   * true = always request thinking (thinking-capable ids the regex can't
   * know yet); false = never (older Claude models that 400 on the thinking
   * block). Set from the provider editor.
   */
  thinkingCapable?: boolean;
  /**
   * Override for the model context window in tokens — optional, and it wins
   * over everything else (`utils/contextWindow.resolveContextWindow` puts a
   * user override above a measured limit, a discovered per-model window and the
   * 1,000,000 default). It scales the retrieved-memory budget
   * (`notebookSliceChars` → `utils/tokenEstimate.windowBudgetTokens`), the shared
   * index budget (`utils/promptIndexBudget`) and it sets
   * the ceiling automatic compaction holds the outbound history to, so a small
   * window here is how you tell the app "compact earlier", not "inject less".
   * Set from the provider editor; absent ⇒ best available evidence.
   */
  contextWindowTokens?: number;
  /**
   * Context window per model id, in tokens, as reported by the provider's own
   * `/models` endpoint at discovery (`context_length`, `context_window`,
   * `max_model_len`, `input_token_limit`, …). Read by
   * `utils/contextWindow.resolveContextWindow` AFTER `contextWindowTokens` and
   * a measured limit, and BEFORE the assumed default: it says what this model
   * claims about itself, which beats an assumption but loses to an override.
   * Absent ⇒ no per-model claim is known. Gateways that report nothing here
   * (OpenAI, DeepSeek, Anthropic) are why the default and the measured
   * fallback exist at all.
   */
  modelContextWindows?: Record<string, number>;
  /**
   * Override for json_schema constrained decoding on chat_completions
   * providers. undefined = decide by verified-host detection; true = always
   * send response_format json_schema when requested (an OpenAI-compatible
   * gateway that supports it); false = never (a host known to 400 on it).
   * Set from the provider editor. The 400-degrade chain stays as a safety
   * net either way.
   */
  jsonSchemaCapable?: boolean;
}

/**
 * Labels for API format dropdown display
 */
export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
  chat_completions: 'Chat completions (/chat/completions)',
  messages: 'Messages (/v1/messages)',
  responses: 'Responses (/responses)',
  google: 'Google Gemini (generateContent)',
};

export const parseApiFormat = (value: unknown): ApiFormat => {
  if (value === 'messages' || value === 'responses' || value === 'google' || value === 'chat_completions') {
    return value;
  }
  return 'chat_completions';
};
