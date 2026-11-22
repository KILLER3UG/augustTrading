/**
 * activeModel — the SINGLE ACTIVE MODEL principle (2026-11-23).
 *
 * One model is selected in the main composer's Model Selector, and that ONE
 * pick drives every LLM call in the app: chat, skill reformatting, session
 * titles, compaction summaries, memory consolidation, background helpers.
 * No per-feature picker exists in the UI; a background call that needs a
 * model reads the composer's pick (persisted app-wide as
 * `casual_chat_model`, `providerId::modelId`).
 *
 * Legacy stored seat/pick JSON (per-role seats, a stored format model) stays
 * readable as a FALLBACK for installs that had it — it fills in only when
 * the composer has no resolvable pick, and it never appears as a second
 * selector.
 */
import type { ProviderConfig } from '../../types/provider';

/** The composer's pick, as `providerId::modelId` ('' when none). */
export const activeModelPair = (): string => {
    try { return localStorage.getItem('casual_chat_model') || ''; } catch { return ''; }
};

/**
 * The ready provider the composer's pick names, with its selectedModel
 * overridden to the picked model — or null when the pick is absent, stale,
 * or names a provider that is not ready (the caller then falls back).
 */
export const pickActiveModelConfig = async (): Promise<ProviderConfig | null> => {
    const pair = activeModelPair();
    if (!pair) return null;
    const [providerId, ...modelParts] = pair.split('::');
    const modelId = modelParts.join('::');
    if (!providerId) return null;
    try {
        const { loadProviderConfigs, getReadyProviders } = await import('./ProviderConfigService');
        const ready = getReadyProviders(await loadProviderConfigs());
        const found = ready.find(c => c.id === providerId);
        if (!found) return null;
        if (modelId && found.selectedModel !== modelId && found.models.includes(modelId)) {
            return { ...found, selectedModel: modelId };
        }
        return found;
    } catch {
        return null;
    }
};

/**
 * `ready` reordered so the composer's pick is FIRST — for callers that walk
 * candidates in order. The composer's model leads; every other ready
 * provider follows in their stored order as fallbacks.
 */
export const orderReadyByActiveModel = async (ready: readonly ProviderConfig[]): Promise<ProviderConfig[]> => {
    const pair = activeModelPair();
    if (!pair) return [...ready];
    const [providerId, ...modelParts] = pair.split('::');
    const modelId = modelParts.join('::');
    const picked = ready.find(c => c.id === providerId);
    if (!picked) return [...ready];
    const rest = ready.filter(c => c.id !== providerId);
    const lead = modelId && picked.selectedModel !== modelId && picked.models.includes(modelId)
        ? { ...picked, selectedModel: modelId }
        : picked;
    return [lead, ...rest];
};
