/**
 * useModelCatalogRefresh — keeps every provider's model list fresh so all
 * model dropdowns (composer selector, bot dialog, team seats)
 * show the provider's CURRENT catalog without anyone visiting Settings.
 *
 * Design: a quiet background sweep keyed on a persisted last-checked
 * timestamp. On app boot (and every 6h while the app stays open) each
 * ready provider's /models endpoint is queried; discovered ids are merged
 * (never removed — manual additions and orderings survive) straight into
 * the provider config through the same onUpdateProvider path Settings
 * uses, so React state, Preferences, and every dropdown re-derive from
 * one source of truth. Failures are silent (offline / no /models
 * endpoint) — the existing list stays authoritative until a sweep
 * succeeds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProviderConfig } from '../types/provider';
import { discoverProviderModelCatalog } from '../services/infrastructure/ProviderConfigService';
import { getPreferenceObject, setPreferenceObject } from '../services/infrastructure/PreferencesService';
import {
    mergeDiscoveredModels,
    mergeModelContextWindows,
    sameModelContextWindows,
    sortModelsFreeFirst,
} from '../utils/providerUtils';
import { isLocalBaseUrl } from '../../shared/providerRequestPolicy.cjs';

const LAST_SWEEP_KEY = 'model_catalog_sweep_v1';
/** Minimum gap between periodic background sweeps (6h) while app stays open. */
const SWEEP_INTERVAL_MS = 6 * 3_600_000;
/** After a sweep where EVERY provider failed (e.g. the app booted
 *  offline), retry sooner instead of waiting out the full 6h. */
const FAILURE_RETRY_MS = 15 * 60_000;

interface SweepState {
    lastSweepAt: number;
    /** Set when a sweep ran but produced zero successes — the next
     *  eligible sweep uses FAILURE_RETRY_MS instead of the full 6h. */
    lastSweepFailed?: boolean;
}

const readSweepState = async (): Promise<SweepState> =>
    (await getPreferenceObject<SweepState>(LAST_SWEEP_KEY)) ?? { lastSweepAt: 0 };

export interface UseModelCatalogRefreshResult {
    /** Force a sweep now (also resets the interval timer). */
    refreshNow: () => Promise<void>;
    /** True while a model discovery sweep is currently in progress. */
    isSweeping: boolean;
}

export const useModelCatalogRefresh = (
    providerConfigs: ProviderConfig[],
    onUpdateProvider: (id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>) => Promise<void>,
): UseModelCatalogRefreshResult => {
    // Refs keep the effect stable (no re-sweep on every configs change);
    // the callback always reads the LIVE configs.
    const configsRef = useRef(providerConfigs);
    configsRef.current = providerConfigs;
    const updateRef = useRef(onUpdateProvider);
    updateRef.current = onUpdateProvider;
    const sweepingRef = useRef(false);
    const [isSweeping, setIsSweeping] = useState(false);

    const sweep = useCallback(async (): Promise<void> => {
        if (sweepingRef.current) return;
        sweepingRef.current = true;
        setIsSweeping(true);
        window.dispatchEvent(new CustomEvent('august:model-refresh-start'));

        let successes = 0;
        let freshCount = 0;
        try {
            const targets = configsRef.current.filter(
                p => p.isEnabled && (p.baseUrl || '').trim().length > 0 && ((p.apiKey || '').trim().length > 0 || isLocalBaseUrl(p.baseUrl)),
            );

            // Query enabled providers concurrently for fast, responsive discovery
            const results = await Promise.allSettled(
                targets.map(async provider => {
                    const catalog = await discoverProviderModelCatalog({
                        baseUrl: provider.baseUrl,
                        apiKey: provider.apiKey,
                        apiFormat: provider.apiFormat,
                    });
                    const discovered = catalog.ids;
                    // Respect the trader's curated active roster: when a
                    // provider already has models chosen (via presets or the
                    // `Choose models` modal), the background sweep must NOT
                    // overwrite `provider.models` with the full remote catalog
                    // (e.g. 200+ OpenRouter slugs). It still refreshes
                    // `modelContextWindows` metadata, and seeds `models` only
                    // when the list is empty (or merges locally pulled models
                    // for local Ollama/LM Studio endpoints).
                    const isLocal = isLocalBaseUrl(provider.baseUrl);
                    const hasCuratedRoster = provider.models.length > 0;
                    const nextModels = isLocal
                        ? mergeDiscoveredModels(provider.models, discovered)
                        : hasCuratedRoster
                            ? provider.models
                            : sortModelsFreeFirst(discovered);
                    const isUnchanged = provider.models.length === nextModels.length
                        && provider.models.every((m, idx) => m === nextModels[idx]);
                    const existing = new Set(provider.models);
                    const fresh = discovered.filter(m => !existing.has(m));
                    const nextWindows = mergeModelContextWindows(provider.modelContextWindows, catalog.windows);
                    const windowsChanged = !sameModelContextWindows(provider.modelContextWindows, nextWindows);
                    if ((!isUnchanged && nextModels.length > 0) || windowsChanged) {
                        const updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>> = isUnchanged
                            ? {}
                            : { models: nextModels };
                        if (!isUnchanged && provider.selectedModel && !nextModels.includes(provider.selectedModel)) {
                            updates.selectedModel = nextModels[0] || '';
                        }
                        if (windowsChanged) updates.modelContextWindows = nextWindows;
                        await updateRef.current(provider.id, updates);
                    }
                    return { providerId: provider.id, freshCount: fresh.length };
                }),
            );

            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === 'fulfilled') {
                    successes += 1;
                    freshCount += r.value.freshCount;
                } else {
                    console.warn(`[useModelCatalogRefresh] Discovery failed for ${targets[i]?.name || targets[i]?.id}:`, r.reason);
                }
            }

            // Every provider failed → record it so the next window retries
            // in 15min instead of waiting out the full 6h (booting offline
            // should not pin stale dropdowns for six hours).
            const totalFailure = targets.length > 0 && successes === 0;
            await setPreferenceObject<SweepState>(LAST_SWEEP_KEY, { lastSweepAt: Date.now(), lastSweepFailed: totalFailure });
        } finally {
            sweepingRef.current = false;
            setIsSweeping(false);
            window.dispatchEvent(new CustomEvent('august:model-refresh-end', { detail: { successes, freshCount } }));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        // Requirement: execute automatically every time the user opens the app
        // Small boot delay (3s) so the first paint never competes with the sweep.
        const boot = setTimeout(() => {
            if (!cancelled) {
                void sweep();
            }
        }, 3_000);

        // While the app remains open continuously, sweep periodically every 6h
        const interval = setInterval(async () => {
            const state = await readSweepState();
            const minGap = state.lastSweepFailed ? FAILURE_RETRY_MS : SWEEP_INTERVAL_MS;
            if (cancelled || Date.now() - state.lastSweepAt < minGap) return;
            await sweep();
        }, 60_000);

        // Event listener for manual refresh requests from model dropdowns
        const handleRefreshEvent = () => {
            if (!cancelled) {
                void sweep();
            }
        };
        window.addEventListener('august:refresh-models', handleRefreshEvent);

        return () => {
            cancelled = true;
            clearTimeout(boot);
            clearInterval(interval);
            window.removeEventListener('august:refresh-models', handleRefreshEvent);
        };
    }, [sweep]);

    return { refreshNow: sweep, isSweeping };
};
