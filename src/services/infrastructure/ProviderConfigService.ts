/**
 * ProviderConfigService — CRUD for runtime-configurable AI provider settings.
 * Stores provider configs via PreferencesService (localStorage / Capacitor Preferences).
 */

import { ProviderConfig, ApiFormat, parseApiFormat } from '../../types/provider';
import { getPreferenceObject, setPreferenceObject } from './PreferencesService';
import { assertValidProviderUrl } from '../../utils/providerUrlValidation';
import { usesGoogleGeminiDiscovery, googleModelsUrl } from '../../utils/googleGeminiFormat';
import { isLocalBaseUrl, normalizeProviderUrl } from '../../../shared/providerRequestPolicy.cjs';
import { isProviderReady } from '../../utils/providerUtils';

const STORAGE_KEY = 'provider_configs_v1';

// ─── Secret Encryption (Electron safeStorage bridge) ─────────────────────────
// API keys are encrypted at rest on desktop via the OS keychain. Web/Capacitor
// builds have no bridge and keep plaintext (unchanged behavior). Encrypted
// values are prefixed "enc:v1:" so we can distinguish them from legacy
// plaintext and fail open (return as-is) if the bridge is unavailable.

interface CryptoBridge {
    encryptSecret: (plaintext: string) => Promise<string | null>;
    decryptSecret: (payload: string) => Promise<string | null>;
}

function getCryptoBridge(): CryptoBridge | null {
    if (typeof window === 'undefined') return null;
    const api = window.electronAPI;
    // The global electronAPI type carries the optional crypto members; narrow
    // across the presence check and hand back a required-members view so the
    // rest of this file never re-casts.
    if (api && typeof api.encryptSecret === 'function' && typeof api.decryptSecret === 'function') {
        return { encryptSecret: api.encryptSecret, decryptSecret: api.decryptSecret };
    }
    return null;
}

const isEncrypted = (value: string): boolean => value.startsWith('enc:v1:');

/**
 * Encrypt a key for storage, and SAY whether it could be.
 *
 * The failure mode is deliberate: on a system without a working OS keyring
 * (e.g. Linux without gnome-keyring/kwallet) `encryptSecret` returns null,
 * and throwing there made EVERY provider save fail with no recovery path. So
 * the key is stored as plaintext - and the only record of that was a console
 * line the trader never sees.
 *
 * So the caller is told, and the flag rides on the provider record so the
 * UI can stop calling it "encrypted at rest".
 *
 * @returns the value to store, and whether it is stored in the clear
 */
async function encryptKey(apiKey: string): Promise<{ value: string; plaintext: boolean }> {
    if (!apiKey || isEncrypted(apiKey)) return { value: apiKey, plaintext: false };
    const bridge = getCryptoBridge();
    // No bridge at all: the web and Capacitor builds have never encrypted.
    if (!bridge) return { value: apiKey, plaintext: true };
    const encrypted = await bridge.encryptSecret(apiKey);
    if (!encrypted) {
        // Fail open (matching decryptKey): on systems without a working OS
        // keyring (e.g. Linux without gnome-keyring/kwallet) encryptSecret
        // returns null — throwing here made EVERY provider save fail with no
        // recovery path. Store plaintext so the app stays usable, and let the
        // caller say so out loud.
        console.warn('[ProviderConfigService] safeStorage unavailable — storing API key as plaintext.');
        return { value: apiKey, plaintext: true };
    }
    return { value: encrypted, plaintext: false };
}

async function decryptKey(stored: string): Promise<string> {
    if (!stored || !isEncrypted(stored)) return stored;
    const bridge = getCryptoBridge();
    // Bridge unavailable (web/Capacitor — documented plaintext storage): return
    // the stored payload as-is, unchanged behavior for those platforms.
    if (!bridge) return stored;
    // The bridge EXISTS but the DECRYPT failed (OS keychain rotated, fresh
    // session, DPAPI/keyring credentials changed). Returning the raw
    // `enc:v1:…` blob as the apiKey was fail-OPEN in the wrong direction: the
    // ciphertext satisfies the non-empty readiness check (`apiKey.trim().length
    // > 0`) and got sent verbatim as the Bearer token to the provider. Mark
    // the provider NOT-READY instead — an empty key keeps it present in the
    // list, fails readiness, and the UI prompts the user to re-enter the key.
    try {
        const decrypted = await bridge.decryptSecret(stored);
        if (decrypted) return decrypted;
        console.warn('[ProviderConfigService] Failed to decrypt stored API key (OS keychain unavailable or rotated). Provider marked not ready — re-enter the key in Settings → Providers.');
        return '';
    } catch (error) {
        console.warn('[ProviderConfigService] API key decryption threw; provider marked not ready — re-enter the key in Settings → Providers.', error);
        return '';
    }
}

// ─── Provider Configuration Service ───────────────────────────────────────

export function getDefaultConfigs(): ProviderConfig[] {
    return [];
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

// Ciphertexts whose decryption FAILED this session, by provider id. A failed
// decrypt yields apiKey '' (deliberate — the ciphertext must never ride out
// as a Bearer token), but the stored ciphertext is still the ONLY copy of the
// key: if a later read-modify-write save round-tripped that '', it would
// overwrite the ciphertext irrecoverably and the user would lose every key
// the OS keyring only TEMPORARILY could not open. saveProviderConfigs
// re-persists the preserved ciphertext for any entry still carrying the
// failed-decrypt empty key; a re-entered (non-empty) key encrypts normally
// and evicts the entry.
const undecryptableCiphertexts = new Map<string, string>();

/**
 * Load all provider configs. Returns empty array if none configured.
 * API keys are decrypted transparently when the desktop bridge is available.
 */
/** A stored rate: any finite non-negative number, `0` included (a free model is
 *  a real price). Anything else is "not set", never a silent 0. */
function nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A positive integer — the shape a context window has to be. */
function positiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** A capability override is tri-state by design: `undefined` means "decide by
 *  detection", so a stored string or a stray `1` must NOT become `true`. */
function triState(value: unknown): boolean | undefined {
    return value === true ? true : value === false ? false : undefined;
}

/** id → window, keeping only plausible entries. A corrupt map must not take the
 *  provider row down with it. */
function parseModelContextWindows(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, number> = {};
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
        const tokens = positiveNumber(raw);
        if (id && tokens) out[id] = tokens;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

export async function loadProviderConfigs(): Promise<ProviderConfig[]> {
    const saved = await getPreferenceObject<ProviderConfig[]>(STORAGE_KEY);
    if (!Array.isArray(saved)) return getDefaultConfigs();

    const configs = await Promise.all(saved.map(async (raw) => {
        const config = raw as Partial<ProviderConfig>;
        const apiFormat: ApiFormat = parseApiFormat(config.apiFormat);
        const models = Array.isArray(config.models)
            ? config.models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
            // Legacy configs predate the models array — keep the old
            // 'default' placeholder so they still work. An EMPTY array (all
            // models deleted via removeModelFromProvider) must STAY empty:
            // resurrecting 'default' sent a phantom model to the API that
            // failed on every call.
            : ['default'];
        const selectedModel = typeof config.selectedModel === 'string' && models.includes(config.selectedModel)
            ? config.selectedModel
            : models[0];
        const id = typeof config.id === 'string' ? config.id : `legacy-${Date.now()}`;

        const storedKey = typeof config.apiKey === 'string' ? config.apiKey : '';
        const decryptedKey = await decryptKey(storedKey);
        // Record the failure so a later save can re-persist the ciphertext
        // instead of the empty stand-in (see undecryptableCiphertexts).
        if (!decryptedKey && isEncrypted(storedKey)) {
            undecryptableCiphertexts.set(id, storedKey);
        } else if (decryptedKey) {
            undecryptableCiphertexts.delete(id);
        }

        return {
            id,
            name: typeof config.name === 'string' ? config.name : 'Unnamed provider',
            apiKey: decryptedKey,
            // Whether the STORED key is in the clear: no OS keyring on this
            // machine, so the key was stored as plaintext. The UI shows it.
            apiKeyPlaintext: storedKey ? !isEncrypted(storedKey) : undefined,
            baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
            apiFormat,
            isEnabled: config.isEnabled === true,
            isBuiltIn: config.isBuiltIn === true,
            models,
            selectedModel,
            // The optional fields are read back with the same coercions the
            // editor applies, and they are COPIED because this literal is what
            // the rest of the app sees: a field left out here is silently lost
            // on every app start while the save path keeps writing it. That is
            // not hypothetical — `contextWindowTokens`, `thinkingCapable`,
            // `jsonSchemaCapable` and the two pricing rates were all being
            // dropped, so a window the trader typed (or a limit discovery
            // learned) held for the session and vanished on restart, and
            // `utils/contextWindow` fell back to its assumed default.
            // Compaction decides how much history survives, so it has to be
            // sized off the number the provider editor shows.
            inputUsdPer1k: nonNegativeNumber(config.inputUsdPer1k),
            outputUsdPer1k: nonNegativeNumber(config.outputUsdPer1k),
            thinkingCapable: triState(config.thinkingCapable),
            jsonSchemaCapable: triState(config.jsonSchemaCapable),
            contextWindowTokens: positiveNumber(config.contextWindowTokens),
            modelContextWindows: parseModelContextWindows(config.modelContextWindows),
        } satisfies ProviderConfig;
    }));
    // Owner ruling 2026-10-19: the per-provider ensemble roster is gone. A
    // stored row that still carries it is rewritten once, through the normal
    // save path (which preserves undecryptable key ciphertexts).
    if (saved.some((raw) => raw && typeof raw === 'object' && 'ensembleModels' in raw)) {
        await saveProviderConfigs(configs).catch(() => undefined);
    }
    return configs;
}

/**
 * Persist all provider configs. API keys are encrypted at rest on desktop.
 */
export async function saveProviderConfigs(configs: ProviderConfig[]): Promise<void> {
    const encrypted = await Promise.all(configs.map(async c => {
        // A failed-decrypt provider still carries apiKey '' (see
        // loadProviderConfigs). Re-persist the ORIGINAL ciphertext rather
        // than encrypting '' — otherwise any unrelated CRUD op (add a model,
        // toggle a provider) permanently destroyed the stored key the moment
        // the OS keyring was briefly unavailable.
        const preserved = c.apiKey ? undefined : undecryptableCiphertexts.get(c.id);
        if (preserved !== undefined) return { ...c, apiKey: preserved };
        const { value: apiKey, plaintext } = await encryptKey(c.apiKey || '');
        // The key was re-entered (or the provider carries no key) — the
        // preserved copy is superseded either way.
        undecryptableCiphertexts.delete(c.id);
        // The record says whether the key it holds is encrypted at rest, so
        // the Settings surface can say so instead of assuming it.
        return { ...c, apiKey, apiKeyPlaintext: plaintext || undefined };
    }));
    await setPreferenceObject(STORAGE_KEY, encrypted);
    // Drop ciphertexts for providers that no longer exist.
    const savedIds = new Set(encrypted.map(c => c.id));
    for (const id of undecryptableCiphertexts.keys()) {
        if (!savedIds.has(id)) undecryptableCiphertexts.delete(id);
    }
}

// Serialize read-modify-write cycles. Every CRUD op below reloads the full
// list, mutates, and saves; two overlapping ops (e.g. toggling Enable while a
// model add is in flight) would both read the same snapshot and the second
// save would clobber the first op's change (mirrors SqliteService's
// runExclusiveWrite pattern).
let providerWriteChain: Promise<unknown> = Promise.resolve();
function runExclusiveProviderWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = providerWriteChain.then(fn, fn);
    providerWriteChain = run.catch(() => {});
    return run;
}

/**
 * Update a single provider config by ID.
 */
export async function updateProviderConfig(
    id: string,
    updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>
): Promise<ProviderConfig[]> {
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        const updated = configs.map(c => {
            if (c.id !== id) return c;
            const next = { ...c, ...updates };
            if (updates.baseUrl !== undefined) {
                next.baseUrl = assertValidProviderUrl(updates.baseUrl);
            }
            return next;
        });
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Add a custom provider.
 */
export async function addCustomProvider(provider: {
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
    models?: string[];
    selectedModel?: string;
}): Promise<ProviderConfig[]> {
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        // No phantom 'default' model seed (audit 2026-09-15): readiness is
        // `models.length > 0 || selectedModel`, so seeding ['default'] minted
        // a provider that looked READY with a fake model that 400s on every
        // call — and the picker rendered the phantom. A provider added
        // without models stays NOT ready until the user refreshes/picks real
        // models from the endpoint.
        const firstModel = provider.selectedModel || provider.models?.[0] || '';
        const newConfig: ProviderConfig = {
            id: `custom-${Date.now()}`,
            name: provider.name,
            apiKey: provider.apiKey,
            baseUrl: assertValidProviderUrl(provider.baseUrl),
            apiFormat: provider.apiFormat,
            isEnabled: true,
            isBuiltIn: false,
            models: provider.models ?? [],
            selectedModel: firstModel,
        };
        const updated = [...configs, newConfig];
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Remove a provider (custom or built-in).
 */
export async function removeCustomProvider(id: string): Promise<ProviderConfig[]> {
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        const updated = configs.filter(c => c.id !== id);
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Add a model ID to a provider's model list.
 */
export async function addModelToProvider(providerId: string, modelId: string): Promise<ProviderConfig[]> {
    const trimmed = modelId.trim();
    if (!trimmed) return await loadProviderConfigs();
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        const updated = configs.map(c => {
            if (c.id === providerId) {
                const models = c.models.includes(trimmed) ? c.models : [...c.models, trimmed];
                const selectedModel = c.selectedModel ? c.selectedModel : trimmed;
                return { ...c, models, selectedModel };
            }
            return c;
        });
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Remove a model ID from a provider's model list.
 */
export async function removeModelFromProvider(providerId: string, modelId: string): Promise<ProviderConfig[]> {
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        const updated = configs.map(c => {
            if (c.id === providerId) {
                const models = c.models.filter(m => m !== modelId);
                const selectedModel = c.selectedModel === modelId ? (models[0] || '') : c.selectedModel;
                return { ...c, models, selectedModel };
            }
            return c;
        });
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Update/rename a model ID in a provider's model list.
 */
export async function updateModelInProvider(providerId: string, oldModelId: string, newModelId: string): Promise<ProviderConfig[]> {
    const trimmed = newModelId.trim();
    if (!trimmed) return await loadProviderConfigs();
    return runExclusiveProviderWrite(async () => {
        const configs = await loadProviderConfigs();
        const updated = configs.map(c => {
            if (c.id === providerId) {
                const models = c.models.map(m => m === oldModelId ? trimmed : m);
                const selectedModel = c.selectedModel === oldModelId ? trimmed : c.selectedModel;
                return { ...c, models, selectedModel };
            }
            return c;
        });
        await saveProviderConfigs(updated);
        return updated;
    });
}

/**
 * Get only enabled providers that have a usable model AND either an API key
 * or a local base URL — Ollama / LM Studio style servers are keyless, so an
 * empty key must not make them "not ready". The predicate is providerUtils's,
 * so this list and every caller cannot drift apart again.
 */
export function getReadyProviders(configs: ProviderConfig[]): ProviderConfig[] {
    return configs.filter(isProviderReady);
}

/**
 * Discover a provider's available models through its /models endpoint.
 *
 * Endpoint + auth per API format:
 *  - OpenAI-compatible (chat_completions / responses): GET {baseUrl}/models
 *    with `Authorization: Bearer <key>` → { data: [{ id }] }
 *  - Anthropic (messages): GET {baseUrl}/models with `x-api-key` +
 *    `anthropic-version` headers → { data: [{ id }] }
 *  - Gemini / Google format: GET {baseUrl}/models?key=<key>
 *    → { models: [{ name: "models/..." }] } (the "models/" prefix is stripped)
 *
 * Returns the model ids, deduped and in the provider's order. Throws
 * user-safe errors (network / HTTP status / unparseable / empty).
 */
function parseDiscoverErrorBody(raw: string): string {
    try {
        const parsed = raw ? JSON.parse(raw) as { error?: { message?: string }; message?: string } : {};
        return (parsed?.error?.message || parsed?.message || '').trim();
    } catch {
        return '';
    }
}

function extractModelId(item: unknown): string | null {
    if (typeof item === 'string') {
        const trimmed = item.trim();
        return trimmed ? trimmed.replace(/^models\//, '') : null;
    }
    if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const candidate = obj.id ?? obj.name ?? obj.model ?? obj.model_name ?? obj.value;
        if (typeof candidate === 'string') {
            const trimmed = candidate.trim();
            return trimmed ? trimmed.replace(/^models\//, '') : null;
        }
    }
    return null;
}

export function parseDiscoveredModelIds(body: unknown): string[] {
    const ids: string[] = [];

    // 1. Direct top-level array: ["model1", "model2"] or [{ id: "model1" }, ...]
    if (Array.isArray(body)) {
        for (const item of body) {
            const id = extractModelId(item);
            if (id) ids.push(id);
        }
        return [...new Set(ids)];
    }

    if (body && typeof body === 'object') {
        const dict = body as Record<string, unknown>;

        // 2. Standard wrapper properties: data (OpenAI/Anthropic), models (Gemini/Ollama), result, model_list, items, list
        const candidateArrays = [
            dict.data,
            dict.models,
            dict.result,
            dict.model_list,
            dict.items,
            dict.list,
        ];

        for (const arr of candidateArrays) {
            if (Array.isArray(arr)) {
                for (const item of arr) {
                    const id = extractModelId(item);
                    if (id) ids.push(id);
                }
                if (ids.length > 0) {
                    return [...new Set(ids)];
                }
            }
        }
    }

    return [...new Set(ids)];
}

/**
 * The base URL discovery should probe: validated (throws on a bad URL) and
 * with the endpoint path suffix stripped.
 *
 * The suffix list and the host rules come from the SHARED policy module —
 * this function used to carry a third inline copy of both, one of the copies
 * that had drifted (the vite dev proxy stripped four suffixes, this and
 * electron/main.cjs stripped six, so a base URL pasted from a provider's docs
 * resolved to a different origin per transport).
 */
export function normalizeBaseUrlForModels(rawUrl: string): string {
    // assertValidProviderUrl first so the caller gets the specific
    // "must use HTTPS" / "cannot include credentials" message, as before.
    assertValidProviderUrl(rawUrl);
    return normalizeProviderUrl(rawUrl);
}

function throwDiscoverHttpError(status: number, rawBody: string): never {
    const detail = parseDiscoverErrorBody(rawBody);
    throw new Error(
        detail
            ? `Discovery failed (HTTP ${status}): ${detail}`
            : `Discovery failed (HTTP ${status}) — check the API key and base URL.`
    );
}

export function getDiscoveryCandidateUrls(baseUrl: string, isGemini: boolean, apiKey: string): string[] {
    if (isGemini) {
        return [googleModelsUrl(baseUrl, apiKey)];
    }
    const urls: string[] = [];
    urls.push(`${baseUrl}/models`);
    if (baseUrl.endsWith('/v1')) {
        const withoutV1 = baseUrl.slice(0, -3);
        if (withoutV1) urls.push(`${withoutV1}/models`);
    } else {
        urls.push(`${baseUrl}/v1/models`);
    }
    if (isLocalBaseUrl(baseUrl)) {
        const root = baseUrl.replace(/\/v1$/, '');
        urls.push(`${root}/api/tags`);
    }
    return [...new Set(urls)];
}

/**
 * Fetch GET {baseUrl}/models without CORS. Chat already goes through Electron
 * IPC / the Vite dev proxy; discovery used to call the provider from the
 * renderer and failed with a generic "could not reach" on every provider
 * that doesn't send Access-Control-Allow-Origin.
 */
async function fetchDiscoverPayload(config: {
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
}): Promise<{ status: number; body: string }> {
    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (electronAPI?.isElectron && electronAPI.discoverModels) {
        const result = await electronAPI.discoverModels(config);
        if (typeof result?.body === 'string') {
            return { status: result.status ?? (result.ok ? 200 : 0), body: result.body };
        }
        throw new Error(result?.message || 'Could not reach the provider — check the base URL and your network.');
    }

    const useDevProxy = Boolean(import.meta.env.DEV)
        && !import.meta.env.VITEST
        && typeof window !== 'undefined'
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (useDevProxy) {
        const response = await fetch('/__provider_proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discover: true, config }),
        });
        const result = await response.json() as { ok?: boolean; status?: number; body?: string; message?: string };
        if (typeof result.body === 'string') {
            return { status: result.status ?? response.status, body: result.body };
        }
        throw new Error(result.message || 'Could not reach the provider — check the base URL and your network.');
    }

    const base = normalizeBaseUrlForModels(config.baseUrl);
    const key = (config.apiKey || '').trim();
    const isGemini = usesGoogleGeminiDiscovery(base, config.apiFormat);
    const isAnthropic = config.apiFormat === 'messages' && !isGemini;
    const headers: Record<string, string> = {
        Accept: 'application/json',
    };
    if (isAnthropic) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
    } else if (!isGemini && key && key !== 'not-needed') {
        headers.Authorization = `Bearer ${key}`;
    }

    const candidateUrls = getDiscoveryCandidateUrls(base, isGemini, key);
    let lastResult = { status: 0, body: '' };
    let timedOut = false;

    for (const candidateUrl of candidateUrls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await fetch(candidateUrl, { headers, signal: controller.signal });
            const body = await res.text();
            lastResult = { status: res.status, body };
            // Success or explicit auth/validation error: stop and return.
            // Only retry candidate URLs if the endpoint was Not Found (404).
            if ((res.status >= 200 && res.status < 300) || res.status !== 404) {
                return lastResult;
            }
        } catch (e) {
            // A timeout on ONE endpoint must not cancel the fallback chain —
            // reaching the next candidate is the entire reason it exists. One
            // hanging /v1/models used to abort the whole sweep, so a provider
            // that answered fine on /v1/… was never given the chance.
            if ((e as Error)?.name === 'AbortError') timedOut = true;
            lastResult = { status: 0, body: (e as Error)?.message || '' };
        } finally {
            clearTimeout(timer);
        }
    }

    if (timedOut) {
        throw new Error('Model discovery timed out — check the base URL.');
    }
    if (lastResult.status === 0 && !lastResult.body) {
        throw new Error('Could not reach the provider — check the base URL and your network.');
    }
    return lastResult;
}

export async function discoverProviderModels(config: {
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
}): Promise<string[]> {
    return (await discoverProviderModelCatalog(config)).ids;
}

/** Model ids PLUS whatever the provider said about each one's context window. */
export interface DiscoveredModelCatalog {
    ids: string[];
    /** modelId → context window in tokens. Sparse: only models the provider
     *  actually reported a window for. An absent key means "no claim", NOT
     *  "small window" — `utils/contextWindow` falls through to the measured
     *  limit or the default, and a false zero here would compact a 1M model to
     *  nothing. */
    windows: Record<string, number>;
}

/**
 * Discover the provider's models and their context windows.
 *
 * `discoverProviderModels` is this function's ids-only face, kept because that
 * is what the model editor and the catalog refresh need; the windows are for
 * `utils/contextWindow.resolveContextWindow`, which otherwise has to choose
 * between a number the trader typed and an assumption.
 *
 * The field names below are what the gateways actually send, and they are not
 * one standard: OpenRouter/Together use `context_length`, Groq `context_window`,
 * llama.cpp `context_length`, vLLM `max_model_len`, Ollama's `/api/show`
 * `context_length`, Gemini `inputTokenLimit`. A provider that uses none of them
 * (OpenAI, DeepSeek, Anthropic) yields no windows — which is precisely the case
 * the assumed default and the measured-limit recovery exist for.
 */
export async function discoverProviderModelCatalog(config: {
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
}): Promise<DiscoveredModelCatalog> {
    const key = (config.apiKey || '').trim();
    if (!(config.baseUrl || '').trim()) throw new Error('Base URL is required to discover models.');
    // Keyless LOCAL providers (Ollama / LM Studio) answer /models with no
    // auth — demanding a key here made the one endpoint that could tell the
    // user "no key needed" reject them before the request. Remote providers
    // still require a key.
    if (!key && !isLocalBaseUrl(config.baseUrl)) throw new Error('API key is required to discover models.');
    assertValidProviderUrl(config.baseUrl);

    const { status, body } = await fetchDiscoverPayload(config);
    if (status < 200 || status >= 300) throwDiscoverHttpError(status, body);

    let parsed: unknown;
    try {
        parsed = body ? JSON.parse(body) : {};
    } catch {
        throw new Error('The provider returned an unreadable response.');
    }

    const ids = parseDiscoveredModelIds(parsed);
    if (ids.length === 0) {
        throw new Error('The provider returned no models — its /models endpoint may be unsupported.');
    }
    return { ids, windows: parseDiscoveredModelWindows(parsed) };
}

/** The keys a context window hides under, across the families this app talks
 *  to. Ordered by how specific they are: `context_length` is what a gateway
 *  that knows its own model reports, `max_model_len` is vLLM's, and
 *  `input_token_limit` is Google's. `total_tokens`/`max_tokens` are
 *  deliberately NOT here — those are request caps, not the window, and reading
 *  a 4096 output cap as a context window would make every turn compact itself
 *  into amnesia. */
const WINDOW_KEYS = [
    'context_length',
    'context_window',
    'context_size',
    'max_context_length',
    'model_context_window',
    'max_model_len',
    // Google spells its two camelCase; llama.cpp and the OpenAI-compat gateways
    // snake. A list that covers one family silently reports "unknown" for the
    // other, and unknown means the app goes back to the assumed 1M default.
    'inputTokenLimit',
    'input_token_limit',
] as const;

const readWindow = (source: Record<string, unknown> | undefined): number | null => {
    if (!source) return null;
    for (const key of WINDOW_KEYS) {
        const v = source[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 512 && v <= 100_000_000) {
            return Math.floor(v);
        }
    }
    // Nested shapes: { limits: { context_length } } (NVIDIA NIM),
    // { limit: { context_length } } (some proxies), { details: { ... } }.
    for (const bag of ['limits', 'limit', 'details', 'metadata', 'model_limits']) {
        const nested = source[bag];
        if (nested && typeof nested === 'object') {
            const found = readWindow(nested as Record<string, unknown>);
            if (found) return found;
        }
    }
    return null;
};

/** id → window, from any /models body shape `parseDiscoveredModelIds` reads. */
export function parseDiscoveredModelWindows(body: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    const items: unknown[] = Array.isArray(body)
        ? body
        : body && typeof body === 'object'
            ? (['data', 'models', 'result', 'model_list', 'items', 'list']
                .map(k => (body as Record<string, unknown>)[k])
                .find(Array.isArray) ?? [])
            : [];
    for (const item of items) {
        const id = extractModelId(item);
        if (!id) continue;
        const window = readWindow(item && typeof item === 'object' ? item as Record<string, unknown> : undefined);
        if (window) out[id] = window;
    }
    return out;
}
