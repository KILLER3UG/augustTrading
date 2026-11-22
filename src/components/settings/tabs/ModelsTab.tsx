// TAB: AI setup — provider CRUD (SettingsMenu "TAB 1").
//
// The ONE home for provider keys, base URLs and model lists. There are NO
// per-feature model pickers here (2026-11-23, single-active-model ruling):
// the composer's Model Selector is the one model decision, and every
// feature — vision, memory synthesis, skill formatting, background helpers —
// reads that pick. Legacy stored per-feature prefs stay readable as
// invisible fallbacks in their services.
import React from 'react';
import ProviderManager from '../ProviderManager';
import { SettingsPageHeader } from './shared';
import type { ApiFormat, ProviderConfig } from '../../../types/provider';
import type { SettingsTabProps } from './types';

export interface ModelsTabProps extends SettingsTabProps {
    /** Ready = enabled + API key — derived in SettingsMenu from providerConfigs. */
    readyConfigProviders: ProviderConfig[];
    // Dynamic Providers
    onUpdateProvider?: (id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>) => Promise<void>;
    onAddCustomProvider?: (provider: { name: string; baseUrl: string; apiKey: string; apiFormat: ApiFormat; models?: string[]; selectedModel?: string }) => Promise<void>;
    onRemoveProvider?: (id: string) => Promise<void>;
    onToggleProviderConfig?: (id: string) => Promise<void>;
    onAddModel?: (providerId: string, modelId: string) => Promise<void>;
    onRemoveModel?: (providerId: string, modelId: string) => Promise<void>;
    onUpdateModel?: (providerId: string, oldModelId: string, newModelId: string) => Promise<void>;
    /** Parent's staged-draft flag — ProviderManager reports dirtiness into it,
     *  and the dialog's confirm-close reads it. */
    setIsDirty: (isDirty: boolean) => void;
}

const ModelsTab: React.FC<{ tab: ModelsTabProps }> = ({ tab: props }) => {
    const {
        providerConfigs,
        providerConfigsLoaded,
        readyConfigProviders,
        onUpdateProvider,
        onAddCustomProvider,
        onRemoveProvider,
        onToggleProviderConfig,
        onAddModel,
        onRemoveModel,
        onUpdateModel,
        setIsDirty,
    } = props;

    return (
        <div className="space-y-5 animate-fade-in min-h-0">
            <SettingsPageHeader
                title="AI setup"
                description="Connect a provider, then choose the model the desk answers with. That one active model drives every feature — there are no per-feature model picks."
            />
            {providerConfigsLoaded && readyConfigProviders.length === 0 && (
                <div className="rounded-bubble border border-hairline bg-zinc-900/60 p-4">
                    <h3 className="text-ui-base font-semibold text-zinc-100">Connect an AI service to get started</h3>
                    <p className="mt-1 text-ui-sm leading-relaxed text-zinc-400">
                        Add a provider below, paste its key, pick a model, then use Test before running your first analysis.
                    </p>
                </div>
            )}

            {providerConfigs && onUpdateProvider && onAddCustomProvider && onRemoveProvider && onToggleProviderConfig ? (
                <ProviderManager
                    configs={providerConfigs}
                    isLoaded={providerConfigsLoaded}
                    onUpdateProvider={onUpdateProvider}
                    onAddCustomProvider={onAddCustomProvider}
                    onRemoveProvider={onRemoveProvider}
                    onToggleProvider={onToggleProviderConfig}
                    onAddModel={onAddModel}
                    onRemoveModel={onRemoveModel}
                    onUpdateModel={onUpdateModel}
                    onDirtyChange={setIsDirty}
                />
            ) : (
                <p className="text-ui-sm text-zinc-500">Provider configuration loading…</p>
            )}
        </div>
    );
};

export default ModelsTab;
