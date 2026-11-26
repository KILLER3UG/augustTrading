/**
 * modelCatalogCore — pure, DOM-free core for provider presets, fetch-all
 * `/models` catalog normalization, non-destructive `Choose models` merge,
 * catalog reordering, modal filtering, per-model override resolution, and
 * redacted configuration export.
 *
 * Zero React, DOM, `window`, `localStorage`, or network imports (`check:boundaries`).
 */

import type {
    ApiFormat,
    ModelCatalogEntry,
    ModelInputTypes,
    ModelOverride,
    ModelReasoningLevel,
    ProviderConfig,
    ProviderRetryPolicy,
} from '../../types/provider';

export interface ProviderPresetDef {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: ApiFormat;
    requiresKey: boolean;
    defaultModels: readonly ModelCatalogEntry[];
    description: string;
}

export const DEFAULT_REASONING_LEVELS: readonly ModelReasoningLevel[] = [
    { level: 'low', apiValue: 'low' },
    { level: 'medium', apiValue: 'medium' },
    { level: 'high', apiValue: 'high' },
];

export const PROVIDER_PRESETS: readonly ProviderPresetDef[] = [
    {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiFormat: 'chat_completions',
        requiresKey: true,
        description: 'Unified multi-model gateway (OpenAI-compatible)',
        defaultModels: [
            {
                id: 'deepseek/deepseek-r1',
                displayName: 'DeepSeek R1',
                contextWindow: 163_840,
                maxOutputTokens: 16_384,
                inputTypes: { text: true, image: false },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
            {
                id: 'anthropic/claude-sonnet-4',
                displayName: 'Claude Sonnet 4',
                contextWindow: 200_000,
                maxOutputTokens: 16_384,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
        ],
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiFormat: 'chat_completions',
        requiresKey: true,
        description: 'DeepSeek Chat & Reasoner API',
        defaultModels: [
            {
                id: 'deepseek-chat',
                displayName: 'DeepSeek Chat',
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
                inputTypes: { text: true, image: false },
                reasoningEnabled: false,
                supportsTools: true,
            },
            {
                id: 'deepseek-reasoner',
                displayName: 'DeepSeek Reasoner',
                contextWindow: 128_000,
                maxOutputTokens: 64_000,
                inputTypes: { text: true, image: false },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
        ],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiFormat: 'messages',
        requiresKey: true,
        description: 'Claude Messages API with extended thinking',
        defaultModels: [
            {
                id: 'claude-sonnet-4-20250514',
                displayName: 'Claude Sonnet 4',
                contextWindow: 200_000,
                maxOutputTokens: 16_384,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
            {
                id: 'claude-opus-4-20250514',
                displayName: 'Claude Opus 4',
                contextWindow: 200_000,
                maxOutputTokens: 16_384,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'chat_completions',
        requiresKey: true,
        description: 'OpenAI Chat Completions & Responses API',
        defaultModels: [
            {
                id: 'gpt-4.1',
                displayName: 'GPT-4.1',
                contextWindow: 1_047_576,
                maxOutputTokens: 32_768,
                inputTypes: { text: true, image: true },
                reasoningEnabled: false,
                supportsTools: true,
            },
            {
                id: 'o4-mini',
                displayName: 'o4-mini',
                contextWindow: 200_000,
                maxOutputTokens: 100_000,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
        ],
    },
    {
        id: 'gemini',
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiFormat: 'google',
        requiresKey: true,
        description: 'Google AI Studio Gemini generateContent API',
        defaultModels: [
            {
                id: 'gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                contextWindow: 1_048_576,
                maxOutputTokens: 65_536,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
            {
                id: 'gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                contextWindow: 1_048_576,
                maxOutputTokens: 65_536,
                inputTypes: { text: true, image: true },
                reasoningEnabled: true,
                reasoningLevels: [...DEFAULT_REASONING_LEVELS],
                supportsTools: true,
            },
        ],
    },
    {
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiFormat: 'chat_completions',
        requiresKey: true,
        description: 'Ultra-low latency OpenAI-compatible inference',
        defaultModels: [
            {
                id: 'llama-3.3-70b-versatile',
                displayName: 'Llama 3.3 70B',
                contextWindow: 131_072,
                maxOutputTokens: 32_768,
                inputTypes: { text: true, image: false },
                reasoningEnabled: false,
                supportsTools: true,
            },
        ],
    },
    {
        id: 'ollama',
        name: 'Ollama (Local)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiFormat: 'chat_completions',
        requiresKey: false,
        description: 'Local Ollama server — no API key required',
        defaultModels: [],
    },
    {
        id: 'nvidia',
        name: 'NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiFormat: 'chat_completions',
        requiresKey: true,
        description: 'NVIDIA NIM OpenAI-compatible catalog',
        defaultModels: [],
    },
];

export const findProviderPreset = (idOrName: string | undefined): ProviderPresetDef | undefined => {
    if (!idOrName) return undefined;
    const norm = idOrName.trim().toLowerCase();
    return PROVIDER_PRESETS.find(p => p.id === norm || p.name.toLowerCase() === norm);
};

export const sanitizeProviderId = (raw: string): string => {
    const cleaned = (raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return cleaned || 'custom-provider';
};

const positiveInt = (value: unknown, min = 1, max = 100_000_000): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
        return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const n = Number(value.trim());
        if (Number.isFinite(n) && n >= min && n <= max) return Math.floor(n);
    }
    return undefined;
};

const readNumericByKeys = (
    obj: Record<string, unknown>,
    keys: readonly string[],
    min = 1,
    max = 100_000_000,
): number | undefined => {
    for (const k of keys) {
        const found = positiveInt(obj[k], min, max);
        if (found !== undefined) return found;
    }
    for (const bag of ['top_provider', 'limits', 'limit', 'details', 'metadata', 'model_limits']) {
        const nested = obj[bag];
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const found = readNumericByKeys(nested as Record<string, unknown>, keys, min, max);
            if (found !== undefined) return found;
        }
    }
    return undefined;
};

const CONTEXT_WINDOW_KEYS = [
    'context_length',
    'context_window',
    'context_size',
    'max_context_length',
    'model_context_window',
    'max_model_len',
    'max_input_tokens',
    'inputTokenLimit',
    'input_token_limit',
] as const;

const MAX_OUTPUT_KEYS = [
    'max_completion_tokens',
    'max_output_tokens',
    'outputTokenLimit',
    'output_token_limit',
    'max_tokens',
] as const;

const isFreeSlug = (id: string): boolean => /(^|[/:\-_.])free($|[/:\-_.])/.test(id.trim().toLowerCase());

const isPricingFree = (pricing: unknown): boolean | undefined => {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return undefined;
    const p = pricing as Record<string, unknown>;
    const prompt = Number(p.prompt ?? p.input);
    const completion = Number(p.completion ?? p.output);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        return prompt === 0 && completion === 0;
    }
    return undefined;
};

const detectVisionFromRaw = (obj: Record<string, unknown>, id: string): boolean => {
    const arch = obj.architecture && typeof obj.architecture === 'object'
        ? (obj.architecture as Record<string, unknown>)
        : undefined;
    const modalities = arch?.input_modalities ?? obj.input_modalities ?? obj.modalities;
    if (Array.isArray(modalities)) {
        if (modalities.some(m => typeof m === 'string' && /image|vision|multimodal/i.test(m))) {
            return true;
        }
        if (modalities.length > 0 && modalities.every(m => typeof m === 'string' && m.toLowerCase() === 'text')) {
            return false;
        }
    }
    if (typeof arch?.modality === 'string') {
        if (/image/i.test(arch.modality)) return true;
        if (/^text->text$/i.test(arch.modality.trim())) return false;
    }
    const caps = obj.capabilities && typeof obj.capabilities === 'object'
        ? (obj.capabilities as Record<string, unknown>)
        : undefined;
    if (typeof caps?.vision === 'boolean') return caps.vision;
    if (typeof obj.vision === 'boolean') return obj.vision;
    if (typeof obj.supports_vision === 'boolean') return obj.supports_vision;

    const lower = id.toLowerCase();
    return lower.includes('vision')
        || lower.includes('-vl')
        || lower.includes('vl-')
        || lower.includes('gpt-4o')
        || lower.includes('gpt-4.1')
        || lower.includes('gpt-5')
        || lower.includes('claude-3')
        || lower.includes('claude-4')
        || lower.includes('claude-sonnet-4')
        || lower.includes('claude-opus-4')
        || lower.includes('gemini')
        || lower.includes('pixtral')
        || lower.includes('llama-4');
};

const detectToolsFromRaw = (obj: Record<string, unknown>, id: string, protocol: ApiFormat): boolean => {
    const supported = obj.supported_parameters;
    if (Array.isArray(supported)) {
        return supported.some(s => typeof s === 'string' && (s === 'tools' || s === 'tool_choice' || s === 'functions'));
    }
    const caps = obj.capabilities && typeof obj.capabilities === 'object'
        ? (obj.capabilities as Record<string, unknown>)
        : undefined;
    if (typeof caps?.tools === 'boolean') return caps.tools;
    if (typeof caps?.function_calling === 'boolean') return caps.function_calling;
    if (typeof obj.supports_tools === 'boolean') return obj.supports_tools;
    if (typeof obj.supports_function_calling === 'boolean') return obj.supports_function_calling;
    if (protocol === 'messages' || protocol === 'google' || protocol === 'responses') return true;
    return !/embed|whisper|tts|dall-e|moderation|rerank/i.test(id);
};

const detectReasoningFromRaw = (obj: Record<string, unknown>, id: string): boolean | undefined => {
    const supported = obj.supported_parameters;
    if (Array.isArray(supported)) {
        if (supported.some(s => typeof s === 'string' && /reason|include_reasoning|thinking/i.test(s))) {
            return true;
        }
    }
    const caps = obj.capabilities && typeof obj.capabilities === 'object'
        ? (obj.capabilities as Record<string, unknown>)
        : undefined;
    if (typeof caps?.reasoning === 'boolean') return caps.reasoning;
    if (typeof obj.reasoning === 'boolean') return obj.reasoning;
    if (/(^|[/:\-_])(r1|o1|o3|o4|reasoner|thinking|qwq)($|[/:\-_])/i.test(id)) return true;
    return undefined;
};

const extractRawList = (rawPayload: unknown): unknown[] => {
    if (Array.isArray(rawPayload)) return rawPayload;
    if (!rawPayload || typeof rawPayload !== 'object') return [];
    const dict = rawPayload as Record<string, unknown>;
    for (const key of ['data', 'models', 'result', 'model_list', 'items', 'list']) {
        if (Array.isArray(dict[key])) return dict[key] as unknown[];
    }
    return [];
};

const extractEntryId = (item: unknown): string | null => {
    if (typeof item === 'string') {
        const t = item.trim().replace(/^models\//, '');
        return t || null;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const raw = obj.id ?? obj.name ?? obj.model ?? obj.model_name ?? obj.value;
        if (typeof raw === 'string') {
            const t = raw.trim().replace(/^models\//, '');
            return t || null;
        }
    }
    return null;
};

/**
 * Normalize a raw `/models` or `/api/tags` payload from OpenRouter, OpenAI,
 * Ollama, Anthropic, or Google Gemini into structured `ModelCatalogEntry[]`.
 * Deduplicates by `id` while preserving provider ordering.
 */
export const normalizeFetchedCatalog = (
    protocol: ApiFormat,
    rawPayload: unknown,
): ModelCatalogEntry[] => {
    const list = extractRawList(rawPayload);
    const seen = new Set<string>();
    const out: ModelCatalogEntry[] = [];

    for (const item of list) {
        const id = extractEntryId(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            out.push({
                id,
                inputTypes: { text: true, image: detectVisionFromRaw({}, id) },
                supportsTools: detectToolsFromRaw({}, id, protocol),
                isFree: isFreeSlug(id),
            });
            continue;
        }

        const obj = item as Record<string, unknown>;
        const rawDisplay = obj.display_name ?? obj.displayName ?? (typeof obj.name === 'string' && obj.name !== id && obj.name !== `models/${id}` ? obj.name : undefined);
        const displayName = typeof rawDisplay === 'string' && rawDisplay.trim()
            ? rawDisplay.trim()
            : undefined;
        const contextWindow = readNumericByKeys(obj, CONTEXT_WINDOW_KEYS, 512, 100_000_000);
        const maxOutputTokens = readNumericByKeys(obj, MAX_OUTPUT_KEYS, 64, 10_000_000);
        const image = detectVisionFromRaw(obj, id);
        const supportsTools = detectToolsFromRaw(obj, id, protocol);
        const reasoningEnabled = detectReasoningFromRaw(obj, id);
        const pricingFree = isPricingFree(obj.pricing);
        const isFree = pricingFree !== undefined ? pricingFree : isFreeSlug(id);

        const entry: ModelCatalogEntry = {
            id,
            ...(displayName ? { displayName } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            inputTypes: { text: true, image },
            ...(reasoningEnabled !== undefined ? { reasoningEnabled } : {}),
            ...(reasoningEnabled ? { reasoningLevels: [...DEFAULT_REASONING_LEVELS] } : {}),
            supportsTools,
            isFree,
        };
        out.push(entry);
    }

    return out;
};

/**
 * Non-destructive merge for the `Choose models` modal's "Update list" action:
 *  - Preserves ALL user-customized overrides on models that remain checked.
 *  - Fills only missing metadata fields from `fetchedCatalog`.
 *  - Appends newly checked models hydrated from `fetchedCatalog`.
 *  - Removes unchecked models while preserving existing relative order of kept models.
 */
export const mergeChosenModels = (
    existingEntries: readonly ModelCatalogEntry[],
    fetchedCatalog: readonly ModelCatalogEntry[],
    checkedIds: readonly string[],
): ModelCatalogEntry[] => {
    const checkedSet = new Set(checkedIds.map(id => id.trim()).filter(Boolean));
    const fetchedMap = new Map<string, ModelCatalogEntry>();
    for (const f of fetchedCatalog) fetchedMap.set(f.id, f);

    const out: ModelCatalogEntry[] = [];
    const emitted = new Set<string>();

    // 1. Keep existing checked entries in their saved order, preserving user overrides.
    for (const existing of existingEntries) {
        if (!checkedSet.has(existing.id) || emitted.has(existing.id)) continue;
        emitted.add(existing.id);
        const fetched = fetchedMap.get(existing.id);
        if (!fetched) {
            out.push({ ...existing });
            continue;
        }
        out.push({
            id: existing.id,
            displayName: existing.displayName ?? fetched.displayName,
            contextWindow: existing.contextWindow ?? fetched.contextWindow,
            maxOutputTokens: existing.maxOutputTokens ?? fetched.maxOutputTokens,
            inputTypes: existing.inputTypes
                ? { text: existing.inputTypes.text, image: existing.inputTypes.image }
                : (fetched.inputTypes ? { ...fetched.inputTypes } : undefined),
            reasoningEnabled: existing.reasoningEnabled !== undefined
                ? existing.reasoningEnabled
                : fetched.reasoningEnabled,
            reasoningLevels: existing.reasoningLevels !== undefined
                ? existing.reasoningLevels.map(r => ({ ...r }))
                : (fetched.reasoningLevels ? fetched.reasoningLevels.map(r => ({ ...r })) : undefined),
            supportsTools: existing.supportsTools !== undefined
                ? existing.supportsTools
                : fetched.supportsTools,
            isFree: existing.isFree !== undefined ? existing.isFree : fetched.isFree,
        });
    }

    // 2. Append newly checked models in `checkedIds` order, hydrated from fetchedCatalog.
    for (const rawId of checkedIds) {
        const id = rawId.trim();
        if (!id || emitted.has(id)) continue;
        emitted.add(id);
        const fetched = fetchedMap.get(id);
        if (fetched) {
            out.push({
                ...fetched,
                inputTypes: fetched.inputTypes ? { ...fetched.inputTypes } : undefined,
                reasoningLevels: fetched.reasoningLevels ? fetched.reasoningLevels.map(r => ({ ...r })) : undefined,
            });
        } else {
            out.push({ id, inputTypes: { text: true, image: false } });
        }
    }

    return out;
};

/** Pure immutable array reorder with safe index clamping. */
export const reorderCatalogEntries = <T>(
    entries: readonly T[],
    fromIdx: number,
    toIdx: number,
): T[] => {
    if (entries.length <= 1) return [...entries];
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return [...entries];
    if (fromIdx < 0 || fromIdx >= entries.length) return [...entries];
    const clampedTo = Math.max(0, Math.min(entries.length - 1, toIdx));
    if (fromIdx === clampedTo) return [...entries];
    const copy = [...entries];
    const [moved] = copy.splice(fromIdx, 1);
    copy.splice(clampedTo, 0, moved);
    return copy;
};

export type CatalogModalFilter = 'all' | 'checked' | 'free' | 'vision' | 'tools';

export interface FilterCatalogModalOptions {
    query?: string;
    filter?: CatalogModalFilter;
    checkedSet: ReadonlySet<string>;
}

/** Pure filter for the `Choose models` modal search box + capability pills. */
export const filterCatalogModalItems = (
    items: readonly ModelCatalogEntry[],
    opts: FilterCatalogModalOptions,
): ModelCatalogEntry[] => {
    const q = (opts.query ?? '').trim().toLowerCase();
    const filter = opts.filter ?? 'all';
    return items.filter(item => {
        if (filter === 'checked' && !opts.checkedSet.has(item.id)) return false;
        if (filter === 'free' && item.isFree !== true) return false;
        if (filter === 'vision' && item.inputTypes?.image !== true) return false;
        if (filter === 'tools' && item.supportsTools !== true) return false;
        if (!q) return true;
        const idHit = item.id.toLowerCase().includes(q);
        const nameHit = (item.displayName ?? '').toLowerCase().includes(q);
        return idHit || nameHit;
    });
};

/** Ensure at least one input modality (Text or Image) remains enabled. */
export const toggleInputModality = (
    current: ModelInputTypes | undefined,
    kind: 'text' | 'image',
    nextValue: boolean,
): ModelInputTypes => {
    const base: ModelInputTypes = {
        text: current?.text ?? true,
        image: current?.image ?? false,
    };
    const candidate: ModelInputTypes = { ...base, [kind]: nextValue };
    if (!candidate.text && !candidate.image) {
        return base;
    }
    return candidate;
};

/** Extract ordered `ModelCatalogEntry[]` from a stored `ProviderConfig`. */
export const entriesFromProviderConfig = (
    config: Pick<ProviderConfig, 'models' | 'modelOverrides' | 'modelContextWindows'>,
): ModelCatalogEntry[] => {
    const out: ModelCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const id of config.models) {
        const trimmed = id.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const ov = config.modelOverrides?.[trimmed];
        const discoveredWindow = config.modelContextWindows?.[trimmed];
        out.push({
            id: trimmed,
            ...(ov ? { ...ov } : {}),
            ...(ov?.contextWindow === undefined && discoveredWindow !== undefined
                ? { contextWindow: discoveredWindow }
                : {}),
        });
    }
    return out;
};

const hasOverrideFields = (ov: ModelOverride): boolean =>
    Boolean(
        ov.displayName
        || ov.contextWindow !== undefined
        || ov.maxOutputTokens !== undefined
        || ov.inputTypes !== undefined
        || ov.reasoningEnabled !== undefined
        || (ov.reasoningLevels && ov.reasoningLevels.length > 0)
        || ov.supportsTools !== undefined
        || ov.isFree !== undefined,
    );

/** Convert ordered `ModelCatalogEntry[]` back to `{ models, modelOverrides }`. */
export const catalogEntriesToConfigFields = (
    entries: readonly ModelCatalogEntry[],
): { models: string[]; modelOverrides: Record<string, ModelOverride> | undefined } => {
    const models: string[] = [];
    const overrides: Record<string, ModelOverride> = {};
    const seen = new Set<string>();

    for (const entry of entries) {
        const id = entry.id.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
        const ov: ModelOverride = {};
        if (entry.displayName?.trim()) ov.displayName = entry.displayName.trim();
        if (typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0) {
            ov.contextWindow = Math.floor(entry.contextWindow);
        }
        if (typeof entry.maxOutputTokens === 'number' && Number.isFinite(entry.maxOutputTokens) && entry.maxOutputTokens > 0) {
            ov.maxOutputTokens = Math.floor(entry.maxOutputTokens);
        }
        if (entry.inputTypes) {
            ov.inputTypes = {
                text: Boolean(entry.inputTypes.text || !entry.inputTypes.image),
                image: Boolean(entry.inputTypes.image),
            };
        }
        if (typeof entry.reasoningEnabled === 'boolean') ov.reasoningEnabled = entry.reasoningEnabled;
        if (Array.isArray(entry.reasoningLevels)) {
            const cleanLevels = entry.reasoningLevels
                .map(r => ({ level: r.level.trim(), apiValue: r.apiValue.trim() }))
                .filter(r => r.level.length > 0 && r.apiValue.length > 0);
            if (cleanLevels.length > 0) ov.reasoningLevels = cleanLevels;
        }
        if (typeof entry.supportsTools === 'boolean') ov.supportsTools = entry.supportsTools;
        if (typeof entry.isFree === 'boolean') ov.isFree = entry.isFree;
        if (hasOverrideFields(ov)) overrides[id] = ov;
    }

    return {
        models,
        modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
};

/** Resolve per-model override for `modelId` (defaulting to `config.selectedModel`). */
export const resolveModelOverride = (
    config: Pick<ProviderConfig, 'selectedModel' | 'modelOverrides'> | null | undefined,
    modelId?: string,
): ModelOverride | undefined => {
    if (!config?.modelOverrides) return undefined;
    const id = modelId ?? config.selectedModel;
    return id ? config.modelOverrides[id] : undefined;
};

/** Resolve effective display label for a model on a provider. */
export const resolveModelDisplayName = (
    config: Pick<ProviderConfig, 'modelOverrides'> | null | undefined,
    modelId: string | undefined,
    fallbackFormatter?: (id: string) => string,
): string => {
    if (!modelId) return '';
    const custom = config?.modelOverrides?.[modelId]?.displayName?.trim();
    if (custom) return custom;
    return fallbackFormatter ? fallbackFormatter(modelId) : modelId;
};

/** Resolve effective retry attempts for a provider's retryPolicy. */
export const retryAttemptsForPolicy = (policy?: ProviderRetryPolicy): number => {
    if (policy === 'off') return 1;
    if (policy === 'aggressive') return 5;
    return 3;
};

/** Sanitize a raw `modelOverrides` record loaded from storage. */
export const parseModelOverrides = (raw: unknown): Record<string, ModelOverride> | undefined => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, ModelOverride> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const v = value as Record<string, unknown>;
        const ov: ModelOverride = {};
        if (typeof v.displayName === 'string' && v.displayName.trim()) ov.displayName = v.displayName.trim();
        const cw = positiveInt(v.contextWindow, 512, 100_000_000);
        if (cw !== undefined) ov.contextWindow = cw;
        const mo = positiveInt(v.maxOutputTokens, 64, 10_000_000);
        if (mo !== undefined) ov.maxOutputTokens = mo;
        if (v.inputTypes && typeof v.inputTypes === 'object' && !Array.isArray(v.inputTypes)) {
            const it = v.inputTypes as Record<string, unknown>;
            const text = it.text !== false;
            const image = it.image === true;
            ov.inputTypes = { text: text || !image, image };
        }
        if (typeof v.reasoningEnabled === 'boolean') ov.reasoningEnabled = v.reasoningEnabled;
        if (Array.isArray(v.reasoningLevels)) {
            const levels: ModelReasoningLevel[] = [];
            for (const row of v.reasoningLevels) {
                if (!row || typeof row !== 'object') continue;
                const r = row as Record<string, unknown>;
                if (typeof r.level === 'string' && r.level.trim() && typeof r.apiValue === 'string' && r.apiValue.trim()) {
                    levels.push({ level: r.level.trim(), apiValue: r.apiValue.trim() });
                }
            }
            if (levels.length > 0) ov.reasoningLevels = levels;
        }
        if (typeof v.supportsTools === 'boolean') ov.supportsTools = v.supportsTools;
        if (typeof v.isFree === 'boolean') ov.isFree = v.isFree;
        if (hasOverrideFields(ov)) out[id] = ov;
    }
    return Object.keys(out).length > 0 ? out : undefined;
};

export const parseRetryPolicy = (raw: unknown): ProviderRetryPolicy | undefined =>
    raw === 'default' || raw === 'aggressive' || raw === 'off' ? raw : undefined;

/**
 * Redact all provider API keys for read-only inspection (`Open configuration`
 * viewer & copy/export) so raw credentials are never rendered or leaked.
 */
export const redactProviderConfigsForView = (
    configs: readonly ProviderConfig[],
): Array<Omit<ProviderConfig, 'apiKey'> & { apiKey: string }> =>
    configs.map(c => ({
        ...c,
        apiKey: c.apiKey ? '•••••••• (redacted)' : '',
    }));
