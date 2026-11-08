// TAB: AI setup — provider CRUD plus the vision / memory / moderator model
// picks (SettingsMenu "TAB 1").
//
// Moved verbatim from the inline body in SettingsMenu.tsx. `readyConfigProviders`
// (the parent's ready-provider memo) and `setIsDirty` (the parent's staged-draft
// flag, which ProviderManager reports through) are passed under the local names
// the body already used.
import React from 'react';
import ProviderManager from '../ProviderManager';
import ModelPicker from '../../shared/ModelPicker';
import { SettingsPageHeader } from './shared';
import type { AIProvider } from '../../../types';
import type { ApiFormat, ProviderConfig } from '../../../types/provider';
import type { SettingsTabProps } from './types';

export interface ModelsTabProps extends SettingsTabProps {
    /** Ready = enabled + API key — derived in SettingsMenu from providerConfigs. */
    readyConfigProviders: ProviderConfig[];
    // Models
    /** Global vision model (Settings → AI setup → Vision Model): one model
     *  for EVERY vision feature (chart OCR, post-trade uploads, PDF OCR). */
    visionModel?: string;
    selectedOcrModel?: string;
    onSetVisionModel?: (modelId: string) => void;
    onMemoryConfigChange?: (config: ProviderConfig | null) => void;
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
        memoryConfig,
        onMemoryConfigChange,
        visionModel,
        selectedOcrModel,
        onSetVisionModel,
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
                description="Connect a provider, then choose the model the desk answers with."
            />
            {providerConfigsLoaded && readyConfigProviders.length === 0 && (
                <div className="rounded-bubble border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
                    <h3 className="text-ui-base font-semibold text-zinc-100">Connect an AI service to get started</h3>
                    <p className="mt-1 text-ui-sm leading-relaxed text-zinc-400">
                        Add a provider below, paste its key, pick a model, then use Test before running your first analysis.
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {readyConfigProviders.length > 0 && (
                    <div className="rounded-bubble border border-hairline bg-zinc-900/50 p-4">
                        <div className="mb-2 text-ui-dense font-semibold uppercase tracking-[0.08em] text-zinc-500">
                            Vision Model
                        </div>
                        <ModelPicker
                            providers={providerConfigs ?? []}
                            value={visionModel || selectedOcrModel || ''}
                            onChange={(v) => onSetVisionModel?.(v)}
                            mode="model-only"
                        />
                        <p className="text-ui-xs text-zinc-600 mt-2 leading-relaxed">
                            One model for every vision feature — chart OCR, post-trade uploads, and PDF book OCR.
                        </p>
                    </div>
                )}

                <div className="rounded-bubble border border-hairline bg-zinc-900/50 p-4">
                    <div className="mb-2 text-ui-dense font-semibold uppercase tracking-[0.08em] text-zinc-500">
                        Memory Model
                    </div>
                    <ModelPicker
                        providers={providerConfigs ?? []}
                        value={memoryConfig?.id && memoryConfig?.selectedModel ? `${memoryConfig.id}::${memoryConfig.selectedModel}` : memoryConfig?.id ?? ''}
                        onChange={(v) => {
                            const separator = v.indexOf('::');
                            if (separator >= 0) {
                                const providerId = v.slice(0, separator);
                                const modelId = v.slice(separator + 2);
                                const selected = (providerConfigs ?? []).find(p => p.id === providerId) ?? null;
                                if (selected) onMemoryConfigChange?.({ ...selected, selectedModel: modelId });
                            } else {
                                onMemoryConfigChange?.((providerConfigs ?? []).find(p => p.id === v) ?? null);
                            }
                        }}
                        mode="provider-model"
                    />
                    <p className="text-ui-xs text-zinc-600 mt-2 leading-relaxed">
                        The librarian: reviews the notebook, distills skills, organizes memory files, and runs every background learning pass.
                    </p>
                </div>

            </div>

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
