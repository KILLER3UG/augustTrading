// =============================================================================
// Provider Utilities
// Dynamic, config-driven helpers that replace the legacy hardcoded provider
// constants (per-provider model arrays, modelIdToName maps, default picks).
// =============================================================================

import { ProviderConfig } from '../types/provider';
import { isLocalBaseUrl } from '../../shared/providerRequestPolicy.cjs';

/**
 * A provider is "ready" when it is enabled AND has a usable model AND has an
 * API key — or points at a local model server (Ollama / LM Studio, see
 * isLocalBaseUrl), which is keyless by design. Mirrors getReadyProviders() in
 * ProviderConfigService exactly, including the models-presence clause (its
 * absence here used to hand callers a `model: ''` config that 400s on every
 * call). Kept dependency-free so it can run inside hooks/memos.
 */
export function isProviderReady(config: ProviderConfig): boolean {
    if (!config.isEnabled) return false;
    if (!(config.models.length > 0 || !!config.selectedModel)) return false;
    return config.apiKey.trim().length > 0 || isLocalBaseUrl(config.baseUrl);
}

/**
 * First ready provider, or null when nothing is configured.
 * Used for default selection (summarization, moderator, vision, memory).
 */
/** One entry per ready provider's selected model. This is the roster the
 *  pipeline uses for provider-level fallbacks (no-models check, notebook quick
 *  save, learning-injection ids, quota attribution) now that the multi-seat
 *  ensemble is gone. */
export interface ReadyProviderModel {
    config: ProviderConfig;
    name: string;
    model: string;
}

export const readyProviderModels = (configs: readonly ProviderConfig[]): ReadyProviderModel[] =>
    configs
        // ONE definition of ready. This used to require a non-empty apiKey and a
        // selectedModel that appears in `models`, while `isProviderReady` accepts
        // a keyless local endpoint — so a local-only setup showed a configured
        // provider and then reported "no AI models are ready" (the 2026-10-27 audit L-10).
        .filter(isProviderReady)
        .map((c) => ({ config: c, name: c.name, model: c.selectedModel || c.models[0] || '' }))
        .filter((p) => p.model.length > 0)
        .slice(0, 3);

export function getFirstReadyProvider(configs: ProviderConfig[]): ProviderConfig | null {
    return configs.find(isProviderReady) ?? null;
}

/**
 * Resolve the provider + EXACT model for a chat-model selection.
 *
 * The composer's picker emits `providerId::modelId` (the same qualified form
 * panel seats use) because a bare model id is ambiguous — two providers can
 * offer the same model, and "first provider that lists it" silently routed
 * the user's pick to the wrong provider. Legacy bare model ids (old stored
 * prefs / old session stamps) resolve heuristically: prefer the ready
 * provider whose selectedModel IS the value, else the first ready provider
 * listing it. Returns the config with selectedModel PINNED to the picked
 * model, or null when the selection matches nothing ready.
 */
export function resolveChatModelSelection(configs: ProviderConfig[], selection: string): ProviderConfig | null {
    const owner = findChatModelOwner(configs, selection);
    return owner?.ready ? owner.config : null;
}

export interface ChatModelOwner {
    config: ProviderConfig;
    /** Whether the owning provider would actually answer (enabled + key). */
    ready: boolean;
}

/**
 * Find WHO owns a chat-model selection — ready or not. Callers use this to
 * give a PRECISE reason when the selection can't answer: "no provider lists
 * this model anymore" vs "its provider is disabled / has no API key", instead
 * of silently answering with the first ready provider.
 */
export function findChatModelOwner(configs: ProviderConfig[], selection: string): ChatModelOwner | null {
    const value = (selection || '').trim();
    if (!value) return null;
    if (value.includes('::')) {
        const sep = value.indexOf('::');
        const providerId = value.slice(0, sep);
        const modelId = value.slice(sep + 2);
        const base = configs.find(c => c.id === providerId);
        if (!base) return null;
        return { config: modelId ? { ...base, selectedModel: modelId } : base, ready: isProviderReady(base) };
    }
    const byExact = configs.find(c => c.selectedModel === value);
    if (byExact) return { config: byExact, ready: isProviderReady(byExact) };
    const byList = configs.find(c => c.models.includes(value));
    return byList ? { config: byList, ready: isProviderReady(byList) } : null;
}

/** The bare model id of a chat-model selection (`providerId::modelId` →
 *  `modelId`; legacy bare values pass through). */
export function chatModelIdOf(selection: string): string {
    const value = (selection || '').trim();
    return value.includes('::') ? value.slice(value.indexOf('::') + 2) : value;
}

export interface ChatModelFallback {
    /** Why the stored pick cannot answer, or null when it can. */
    issue: string | null;
    /** The provider that WILL answer — the pick when it resolves, else the
     *  first ready provider. */
    provider: ProviderConfig | null;
}

/**
 * Resolve a chat-model pick and say out loud when the app is NOT honouring it.
 *
 * A stored pick goes stale for ordinary reasons — the provider was edited,
 * disabled, lost its key, or the model was deleted. The answer must not die and
 * it must not silently come from a different model either, so every composer
 * that offers a picker shows this reason above the send button. It lives here
 * rather than in the dock because the Agents surface runs the same selection: two
 * copies of this branch is how one surface warns and the other lies.
 */
export function computeChatModelFallback(
    configs: ProviderConfig[],
    selection: string,
): ChatModelFallback {
    const resolved = resolveChatModelSelection(configs, selection);
    const provider = resolved ?? getFirstReadyProvider(configs);
    if (!selection || resolved || !provider) return { issue: null, provider };
    const owner = findChatModelOwner(configs, selection);
    const modelId = chatModelIdOf(selection);
    return {
        provider,
        issue: owner
            ? `The provider for "${modelId}" (${owner.config.name}) is disabled or has no API key.`
            : `The selected model "${modelId}" is no longer configured on any provider.`,
    };
}

/**
 * A provider config by id — the single lookup used everywhere a seat,
 * bot references its provider by id.
 */
export function findProviderById(configs: ProviderConfig[], id: string): ProviderConfig | undefined {
    return configs.find(c => c.id === id);
}

const KNOWN_MODEL_TOKENS: Record<string, string> = {
    gpt: 'GPT',
    glm: 'GLM',
    llama: 'Llama',
    qwen: 'Qwen',
    claude: 'Claude',
    gemini: 'Gemini',
    deepseek: 'Deepseek',
    mistral: 'Mistral',
    grok: 'Grok',
    o1: 'O1',
    o3: 'O3',
    o4: 'O4',
};

/**
 * Turn a model slug into a short label: `deepseek-v4-flash` → `Deepseek V4 Flash`.
 * Provider prefixes (`openrouter/…`) and `:free` suffixes are stripped to words.
 */
export function formatModelDisplayName(modelId: string | undefined): string {
    if (!modelId) return '';
    const trimmed = modelId.trim();
    if (!trimmed) return '';
    const slug = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
    return slug
        .split(/[:]+/)
        .flatMap(part => part.split(/[-_]+/))
        .map(token => token.trim())
        .filter(Boolean)
        .map(formatModelToken)
        .join(' ');
}

/** Pretty-print a seat/team label that may still contain a raw model slug. */
export function formatSeatLabel(name: string | undefined): string {
    if (!name) return '';
    const sep = name.indexOf(' · ');
    if (sep >= 0) {
        const prefix = name.slice(0, sep).trim();
        const slug = name.slice(sep + 3).trim();
        return slug ? `${prefix} · ${formatModelDisplayName(slug)}` : prefix;
    }
    if (/[/:_]/.test(name) || /^[a-z0-9]+(?:-[a-z0-9.]+)+$/i.test(name)) {
        return formatModelDisplayName(name) || name;
    }
    return name;
}

const formatModelToken = (token: string): string => {
    const lower = token.toLowerCase();
    if (KNOWN_MODEL_TOKENS[lower]) return KNOWN_MODEL_TOKENS[lower];
    if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
    if (/^\d/.test(token)) return token;
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
};

/**
 * Resolve a model's display name on a provider: prefers the trader's custom
 * `modelOverrides[modelId].displayName`, falling back to `formatModelDisplayName`.
 */
export function resolveProviderModelLabel(
    provider: Pick<ProviderConfig, 'modelOverrides'> | null | undefined,
    modelId: string | undefined,
): string {
    if (!modelId) return '';
    const custom = provider?.modelOverrides?.[modelId]?.displayName?.trim();
    if (custom) return custom;
    return formatModelDisplayName(modelId) || modelId;
}

/**
 * Build a model-id → display label map from all configured providers.
 * Replaces the legacy static `modelIdToName` / `ocrModelIdToName` constants.
 * Label format: "ProviderName · Pretty Model". Consumers fall back to a
 * formatted slug when a lookup misses.
 */
export function buildModelIdToName(configs: ProviderConfig[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const config of configs) {
        for (const model of config.models) {
            if (!model) continue;
            // First provider wins if two providers list the same model id.
            if (!(model in map)) {
                map[model] = `${config.name} · ${resolveProviderModelLabel(config, model)}`;
            }
        }
    }
    return map;
}

/**
 * Build a provider display-name → provider-id map.
 * Used by the debate UI to map speaker names back to provider configs
 * (lens role lookup, model tooltips).
 */
export function buildProviderNameToId(configs: ProviderConfig[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const config of configs) {
        // First provider wins if two providers share a display name — matches
        // buildModelIdToName's convention (a stable map, not last-write-wins).
        if (!(config.name in map)) {
            map[config.name] = config.id;
        }
    }
    return map;
}

/**
 * Resolve a human-readable label for a model id, falling back to the raw id.
 */
export function resolveModelLabel(modelId: string | undefined, modelIdToName: Record<string, string>): string {
    if (!modelId) return 'Unknown';
    return modelIdToName[modelId] ?? formatModelDisplayName(modelId);
}

/**
 * True when a model id is a free-tier listing (OpenRouter `:free`,
 * `*-free` slugs like `hy3-free`). Avoids matching names like "freedom".
 */
export function isFreeModelId(modelId: string): boolean {
    const id = modelId.trim().toLowerCase();
    if (!id) return false;
    return /(^|[/:\-_.])free($|[/:\-_.])/.test(id);
}

/** Stable unique list with free-tier ids first, original order preserved within each group. */
export function sortModelsFreeFirst(modelIds: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const id of modelIds) {
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        unique.push(trimmed);
    }
    return [
        ...unique.filter(isFreeModelId),
        ...unique.filter(id => !isFreeModelId(id)),
    ];
}

/**
 * Merge the context windows a `/models` sweep reported into the stored map.
 *
 * A reported value wins; a model the provider says nothing about keeps whatever
 * was learned before. That asymmetry is deliberate: gateways add and drop fields
 * between releases, and a sweep that stops reporting a window would otherwise
 * return a 128K model to the assumed 1M default — the one failure shape that
 * makes the app overflow instead of compact.
 */
export function mergeModelContextWindows(
  existing: Record<string, number> | undefined,
  discovered: Record<string, number>,
): Record<string, number> {
  return { ...(existing || {}), ...discovered };
}

/** Does that merge change anything? A 6-hourly sweep must not write Preferences
 *  (and re-render every dropdown off it) for a provider that said the same thing
 *  it said last time. */
export function sameModelContextWindows(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): boolean {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return kb.every(k => (a || {})[k] === (b || {})[k]);
}

/** Merge a /models catalog with ids the user already saved (keep custom extras). */
export function mergeDiscoveredModels(existing: string[], discovered: string[]): string[] {
    return sortModelsFreeFirst([...discovered, ...existing]);
}

// -----------------------------------------------------------------------------
// "Free models only" picker preference — shared by every provider/model flyout
// (ModelPicker, team roster menu) so the toggle follows the user across UIs.
// -----------------------------------------------------------------------------

export const FREE_ONLY_STORAGE_KEY = 'august_model_picker_free_only_v1';

export const readFreeOnlyPref = (): boolean => {
    try {
        return localStorage.getItem(FREE_ONLY_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

export const writeFreeOnlyPref = (value: boolean): void => {
    try {
        localStorage.setItem(FREE_ONLY_STORAGE_KEY, value ? '1' : '0');
    } catch {
        // Ignore quota / private-mode failures — the toggle still works in-session.
    }
};

// -----------------------------------------------------------------------------
// Starred models — the list every model menu sorts by. Owned beside the
// free-only pref for the same reason: two panels, one preference. The dock's
// chip and the merged panel must not each keep their own copy, or starring a
// model in one silently stops sorting in the other.
// -----------------------------------------------------------------------------

export const STARRED_MODELS_KEY = 'august_starred_models_v1';

export const readStarredModels = (): string[] => {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(STARRED_MODELS_KEY) ?? '[]');
        return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
};

export const writeStarredModels = (list: string[]): void => {
    try {
        localStorage.setItem(STARRED_MODELS_KEY, JSON.stringify(list));
    } catch {
        // Private mode / quota — the stars simply do not survive the session.
    }
};
