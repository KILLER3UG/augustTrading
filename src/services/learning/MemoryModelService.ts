import { ProviderConfig } from '../../types/provider';
import { getUserProfile } from '../infrastructure/dbService';
import { loadProviderConfigs, getReadyProviders } from '../infrastructure/ProviderConfigService';
import { getFirstReadyProvider } from '../../utils/providerUtils';

/**
 * The Memory Model (Settings → AI setup) owns every background learning
 * pass that remains: the pattern-memory synthesis and the notebook review.
 * It is persisted on the active profile as
 * settings.memoryProvider / settings.memoryModel — this resolver reads it
 * back for service-side paths that run outside React state. Falls back to
 * the first ready provider when nothing is selected or it is not ready, so
 * learning never silently stops because of a stale picker value.
 */
export const resolveMemoryConfig = async (username?: string): Promise<ProviderConfig | null> => {
    const ready = getReadyProviders(await loadProviderConfigs());
    const activeUser = username
        || (typeof localStorage !== 'undefined' ? localStorage.getItem('last_active_user') || undefined : undefined)
        || 'default';
    try {
        const profile = await getUserProfile(activeUser);
        const chosen = ready.find(c => c.id === profile?.settings?.memoryProvider);
        if (chosen) {
            const model = profile?.settings?.memoryModel;
            if (model && chosen.models.includes(model)) return { ...chosen, selectedModel: model };
            return chosen;
        }
    } catch (e) {
        console.warn('[MemoryModel] profile lookup failed — using first ready provider:', e instanceof Error ? e.message : e);
    }
    return getFirstReadyProvider(ready);
};
