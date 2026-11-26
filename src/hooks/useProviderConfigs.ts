/**
 * useProviderConfigs — React hook for managing AI provider configurations.
 * Loads configs on mount, exposes CRUD operations, and tracks ready providers.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ProviderConfig, ApiFormat, ModelOverride, ProviderRetryPolicy } from '../types/provider';
import {
    loadProviderConfigs,
    saveProviderConfigs,
    updateProviderConfig,
    addCustomProvider,
    removeCustomProvider,
    addModelToProvider,
    removeModelFromProvider,
    updateModelInProvider,
    getReadyProviders,
} from '../services/infrastructure/ProviderConfigService';
import { findProviderById, buildModelIdToName, buildProviderNameToId } from '../utils/providerUtils';

export function useProviderConfigs() {
    const [configs, setConfigs] = useState<ProviderConfig[]>([]);
    const [isLoaded, setIsLoaded] = useState(false);

    // Load configs on mount
    useEffect(() => {
        let mounted = true;
        loadProviderConfigs().then(loaded => {
            if (mounted) {
                setConfigs(loaded);
                setIsLoaded(true);
            }
        }, error => {
            // A rejecting read used to leave isLoaded false FOREVER, and every
            // boot step gated on it (BotRegistry seeding, team sync) then
            // silently never ran while the app looked healthy — index.tsx
            // preventDefaults unhandled rejections, so nothing surfaced either.
            // Degrade to "no providers configured", which the composer and
            // Health tab already render honestly.
            console.error('[Providers] Could not read provider settings — starting with none configured:', error);
            if (mounted) {
                setConfigs([]);
                setIsLoaded(true);
            }
        });
        return () => { mounted = false; };
    }, []);

    // Update a provider's config
    const handleUpdateProvider = useCallback(async (
        id: string,
        updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>
    ) => {
        const updated = await updateProviderConfig(id, updates);
        setConfigs(updated);
    }, []);

    // Add a custom provider
    const handleAddCustomProvider = useCallback(async (provider: {
        id?: string;
        name: string;
        baseUrl: string;
        apiKey: string;
        apiFormat: ApiFormat;
        models?: string[];
        selectedModel?: string;
        modelOverrides?: Record<string, ModelOverride>;
        retryPolicy?: ProviderRetryPolicy;
        providerPreset?: string;
    }) => {
        const updated = await addCustomProvider(provider);
        setConfigs(updated);
    }, []);

    // Remove a custom provider
    const handleRemoveProvider = useCallback(async (id: string) => {
        const updated = await removeCustomProvider(id);
        setConfigs(updated);
    }, []);

    // Toggle a provider's enabled state
    const handleToggleProvider = useCallback(async (id: string) => {
        const config = configs.find(c => c.id === id);
        if (config) {
            const updated = await updateProviderConfig(id, { isEnabled: !config.isEnabled });
            setConfigs(updated);
        }
    }, [configs]);

    // Model management callbacks
    const handleAddModel = useCallback(async (providerId: string, modelId: string) => {
        const updated = await addModelToProvider(providerId, modelId);
        setConfigs(updated);
    }, []);

    const handleRemoveModel = useCallback(async (providerId: string, modelId: string) => {
        const updated = await removeModelFromProvider(providerId, modelId);
        setConfigs(updated);
    }, []);

    const handleUpdateModel = useCallback(async (providerId: string, oldModelId: string, newModelId: string) => {
        const updated = await updateModelInProvider(providerId, oldModelId, newModelId);
        setConfigs(updated);
    }, []);

    // Get providers that are enabled AND have an API key
    const readyProviders = useMemo(() => getReadyProviders(configs), [configs]);

    // Get a specific provider config by ID
    const getProviderById = useCallback((id: string) => findProviderById(configs, id), [configs]);

    // The two display/lookup maps, derived from `configs` and therefore owned
    // HERE rather than computed by the caller. This is not tidiness: every
    // dropdown, lens role and model tooltip in the app resolves a name or an id
    // through these, and while they were `useMemo`s in App.tsx the thing that
    // keeps them honest — the catalog they are derived from — was in a
    // different file, with nothing making the two move together. Co-locating
    // them makes a stale map structurally impossible rather than merely
    // unlikely, and removes two memos from a 3,500-line component.
    const modelIdToName = useMemo(() => buildModelIdToName(configs), [configs]);
    // Vision models are just provider models now, so one map serves both. The
    // alias is kept because the OCR call sites read better saying `ocr…`.
    const ocrModelIdToName = modelIdToName;
    // Debate speaker names -> provider ids (for lens roles and model tooltips)
    const providerNameToId = useMemo(() => buildProviderNameToId(configs), [configs]);

    return {
        configs,
        isLoaded,
        readyProviders,
        modelIdToName,
        ocrModelIdToName,
        providerNameToId,
        handleUpdateProvider,
        handleAddCustomProvider,
        handleRemoveProvider,
        handleToggleProvider,
        handleAddModel,
        handleRemoveModel,
        handleUpdateModel,
        getProviderById,
    };
}
