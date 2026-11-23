import { ProviderConfig } from '../../types/provider';
import { getUserProfile } from '../infrastructure/dbService';
import { loadProviderConfigs, getReadyProviders } from '../infrastructure/ProviderConfigService';
import { pickActiveModelConfig } from '../infrastructure/ActiveModelConfig';
import { getFirstReadyProvider } from '../../utils/providerUtils';

/**
 * The Memory Model (Settings → AI setup) owns every background learning
 * pass that remains: the pattern-memory synthesis and the notebook review.
 *
 * ONE MODEL, STRICTLY: the composer's active pick (`pickActiveModelConfig`)
 * resolves first and wins outright. A legacy `profile.settings.memoryProvider`
 * / `memoryModel` pair may remain on disk for old installs, but it is a SILENT
 * last-resort fallback used only when no active composer pick resolves — never
 * a second picker, never a rival to the composer. When neither resolves, the
 * first ready provider keeps background learning alive.
 *
 * `sessionTitle.ts`, `settlementReflection.ts` and `postMortemDiagnosis.ts`
 * inherit this resolver; their call shape (`resolveMemoryConfig(username)`) is
 * unchanged by the optional injection seam below.
 */

/** The legacy profile fields this resolver reads. Deliberately narrow: the
 *  profile type may carry more, but only these two can name a model. */
export interface LegacyMemoryPicker {
    settings?: { memoryProvider?: string; memoryModel?: string };
}

/** Optional dependency injection so resolution can be exercised offline.
 *  Production always takes the real imports; tests supply a ready list and a
 *  profile without touching the provider store. */
export interface MemoryConfigResolutionDeps {
    ready?: readonly ProviderConfig[];
    /** `null` means "no stored legacy picker". Omitting the key uses the real
     *  profile lookup. */
    profile?: LegacyMemoryPicker | null;
    pickActive?: () => Promise<ProviderConfig | null>;
}

export const resolveMemoryConfig = async (
    username?: string,
    deps?: MemoryConfigResolutionDeps,
): Promise<ProviderConfig | null> => {
    const ready = deps?.ready !== undefined
        ? [...deps.ready]
        : getReadyProviders(await loadProviderConfigs());

    // 1. The active composer pick is authoritative.
    const active = deps?.pickActive
        ? await deps.pickActive()
        : await pickActiveModelConfig();
    if (active) return active;

    // 2. Legacy JSON, read SILENTLY and only as a last resort. A stale picker
    //    must not log noise or surface as a selectable second model.
    let profile: LegacyMemoryPicker | null = null;
    if (deps && 'profile' in deps) {
        profile = deps.profile ?? null;
    } else {
        const activeUser = username
            || (typeof localStorage !== 'undefined' ? localStorage.getItem('last_active_user') || undefined : undefined)
            || 'default';
        try {
            profile = (await getUserProfile(activeUser)) as LegacyMemoryPicker | null;
        } catch {
            profile = null;
        }
    }
    const chosen = ready.find(c => c.id === profile?.settings?.memoryProvider);
    if (chosen) {
        const model = profile?.settings?.memoryModel;
        if (model && chosen.models.includes(model)) return { ...chosen, selectedModel: model };
        return chosen;
    }

    // 3. Keep background learning alive with the first ready provider.
    return getFirstReadyProvider([...ready]);
};
