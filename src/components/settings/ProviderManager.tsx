/**
 * ProviderManager — DeepSeek-style matte-monochrome Settings → Models surface.
 *
 * Two flat in-pane views (zero 3-deep stacked modals):
 *   1. Provider Roster (`data-testid="settings-models-roster"`):
 *      Single-row cards with status dot, display name, `[Custom]` badge,
 *      active toggle, Edit / Delete (`>= 24px`, `ConfirmDialog`), top-right
 *      `Open configuration` redacted JSON viewer, and dashed `+ Add model provider`.
 *   2. In-Pane Add/Edit Provider Sheet (`data-testid="provider-editor-pane"`):
 *      `← Models / <Provider>` breadcrumb, `Preset` vs `Custom model API` tabs,
 *      permanent lowercase `Provider ID`, editable `Display name`, `Base URL`,
 *      `API protocol`, masked `API key` with eye reveal, `Retry policy`,
 *      and `Customized Model Catalog` (`data-testid="provider-model-catalog"`)
 *      with `Restore defaults`, `+ Add model`, `Fetch available models`
 *      (`ChooseModelsModal`), drag + Up/Down reorderable rows, and per-model
 *      override accordion (Context window, Max output tokens, Text/Image
 *      modalities enforcing >= 1, Reasoning levels toggle + Level → API value).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    API_FORMAT_LABELS,
    type ApiFormat,
    type ModelCatalogEntry,
    type ModelReasoningLevel,
    type PromptProfile,
    type ProviderConfig,
    type ProviderRetryPolicy,
} from '../../types/provider';
import { testConnection } from '../../services/providers/GenericProviderService';
import { probeAndLearn } from '../../services/learning/harnessLessons';
import { discoverProviderModelCatalog } from '../../services/infrastructure/ProviderConfigService';
import {
    DEFAULT_REASONING_LEVELS,
    PROVIDER_PRESETS,
    catalogEntriesToConfigFields,
    entriesFromProviderConfig,
    findProviderPreset,
    mergeChosenModels,
    normalizeFetchedCatalog,
    reorderCatalogEntries,
    sanitizeProviderId,
    toggleInputModality,
    type ProviderPresetDef,
} from '../../services/providers/modelCatalogCore';
import { validateProviderUrl } from '../../utils/providerUrlValidation';
import {
    formatModelDisplayName,
    isProviderReady,
    mergeModelContextWindows,
} from '../../utils/providerUtils';
import { resolveContextWindow } from '../../utils/contextWindow';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import { useToastActions } from '../shared/Toast';
import SelectMenu from '../shared/SelectMenu';
import ToggleSwitch from '../shared/ToggleSwitch';
import {
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    Check,
    ChevronDown,
    ChevronRight,
    CloseIcon,
    Code,
    Eye,
    EyeOff,
    GripVertical,
    PlusIcon,
    RefreshIcon,
    TrashIcon,
} from '../shared/Icons';
import ChooseModelsModal from './ChooseModelsModal';
import ProviderConfigJsonModal from './ProviderConfigJsonModal';

export interface ProviderManagerProps {
    configs: ProviderConfig[];
    isLoaded?: boolean;
    onUpdateProvider: (id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>) => Promise<void>;
    onAddCustomProvider: (provider: {
        id?: string;
        name: string;
        baseUrl: string;
        apiKey: string;
        apiFormat: ApiFormat;
        models?: string[];
        selectedModel?: string;
        modelOverrides?: ProviderConfig['modelOverrides'];
        retryPolicy?: ProviderConfig['retryPolicy'];
        providerPreset?: string;
    }) => Promise<void>;
    onRemoveProvider: (id: string) => Promise<void>;
    onToggleProvider: (id: string) => Promise<void>;
    onAddModel?: (providerId: string, modelId: string) => Promise<void>;
    onRemoveModel?: (providerId: string, modelId: string) => Promise<void>;
    onUpdateModel?: (providerId: string, oldModelId: string, newModelId: string) => Promise<void>;
    onDirtyChange?: (dirty: boolean) => void;
}

const inputCls =
    'w-full rounded-control border border-hairline bg-zinc-950 px-3 py-2 font-mono text-ui-dense text-zinc-100 ' +
    'placeholder-zinc-600 transition-colors focus:border-zinc-500 focus:outline-none';

const selectTriggerCls =
    'w-full rounded-control border border-hairline bg-zinc-950 px-3 py-2 text-ui-dense text-zinc-100 ' +
    'transition-colors hover:border-zinc-700 focus:border-zinc-500 focus:outline-none';

const RETRY_POLICY_OPTIONS: ReadonlyArray<{ value: ProviderRetryPolicy; label: string }> = [
    { value: 'default', label: 'Default (3 attempts)' },
    { value: 'aggressive', label: 'Aggressive (5 attempts)' },
    { value: 'off', label: 'Off (1 attempt, no retry)' },
];

const API_FORMAT_OPTIONS: ReadonlyArray<{ value: ApiFormat; label: string }> = (
    ['chat_completions', 'messages', 'responses', 'google'] as const
).map(v => ({ value: v, label: API_FORMAT_LABELS[v] }));

const formatCompactCtx = (tokens?: number): string | null => {
    if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return null;
    if (tokens >= 1_000_000) {
        const m = Math.round(tokens / 100_000) / 10;
        return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
    }
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
    return String(tokens);
};

interface EditorDraft {
    mode: 'add' | 'edit';
    sourceId: string | null;
    addTab: 'preset' | 'custom';
    presetId: string;
    providerId: string;
    name: string;
    baseUrl: string;
    apiFormat: ApiFormat;
    apiKey: string;
    retryPolicy: ProviderRetryPolicy;
    selectedModel: string;
    entries: ModelCatalogEntry[];
    modelContextWindows?: Record<string, number>;
    contextWindowTokens: string;
    inputUsdPer1k: string;
    outputUsdPer1k: string;
    thinkingCapable: 'auto' | 'on' | 'off';
}

const draftFromConfig = (config: ProviderConfig): EditorDraft => ({
    mode: 'edit',
    sourceId: config.id,
    addTab: config.providerPreset && config.providerPreset !== 'custom' ? 'preset' : 'custom',
    presetId: config.providerPreset ?? 'custom',
    providerId: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    apiFormat: config.apiFormat,
    apiKey: config.apiKey,
    retryPolicy: config.retryPolicy ?? 'default',
    selectedModel: config.selectedModel,
    entries: entriesFromProviderConfig(config),
    modelContextWindows: config.modelContextWindows,
    contextWindowTokens: config.contextWindowTokens !== undefined ? String(config.contextWindowTokens) : '',
    inputUsdPer1k: config.inputUsdPer1k !== undefined ? String(config.inputUsdPer1k) : '',
    outputUsdPer1k: config.outputUsdPer1k !== undefined ? String(config.outputUsdPer1k) : '',
    thinkingCapable: config.thinkingCapable === true ? 'on' : config.thinkingCapable === false ? 'off' : 'auto',
});

const emptyAddDraft = (tab: 'preset' | 'custom' = 'preset'): EditorDraft => {
    const firstPreset = PROVIDER_PRESETS[0];
    if (tab === 'preset' && firstPreset) {
        return {
            mode: 'add',
            sourceId: null,
            addTab: 'preset',
            presetId: firstPreset.id,
            providerId: firstPreset.id,
            name: firstPreset.name,
            baseUrl: firstPreset.baseUrl,
            apiFormat: firstPreset.apiFormat,
            apiKey: '',
            retryPolicy: 'default',
            selectedModel: firstPreset.defaultModels[0]?.id ?? '',
            entries: firstPreset.defaultModels.map(m => ({ ...m })),
            contextWindowTokens: '',
            inputUsdPer1k: '',
            outputUsdPer1k: '',
            thinkingCapable: 'auto',
        };
    }
    return {
        mode: 'add',
        sourceId: null,
        addTab: 'custom',
        presetId: 'custom',
        providerId: '',
        name: '',
        baseUrl: '',
        apiFormat: 'chat_completions',
        apiKey: '',
        retryPolicy: 'default',
        selectedModel: '',
        entries: [],
        contextWindowTokens: '',
        inputUsdPer1k: '',
        outputUsdPer1k: '',
        thinkingCapable: 'auto',
    };
};

const ProviderManager: React.FC<ProviderManagerProps> = ({
    configs,
    isLoaded = true,
    onUpdateProvider,
    onAddCustomProvider,
    onRemoveProvider,
    onToggleProvider,
    onDirtyChange,
}) => {
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const toast = useToastActions();

    // `null` = Provider Roster; non-null = In-Pane Add/Edit Provider Sheet.
    const [draft, setDraft] = useState<EditorDraft | null>(null);
    const [baselineJson, setBaselineJson] = useState<string>('');
    const [showKey, setShowKey] = useState(false);
    const [expandedModelIdx, setExpandedModelIdx] = useState<number | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showConfigJson, setShowConfigJson] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [chooseModalCatalog, setChooseModalCatalog] = useState<ModelCatalogEntry[] | null>(null);
    const [newModelId, setNewModelId] = useState('');
    const [showAddModelRow, setShowAddModelRow] = useState(false);
    const dragIndexRef = useRef<number | null>(null);

    const isDirty = useMemo(() => {
        if (!draft) return false;
        return JSON.stringify(draft) !== baselineJson;
    }, [draft, baselineJson]);

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    // Always clear the parent's dirty flag when switching away from AI setup
    // or unmounting the provider manager so Settings never gets stuck dirty.
    useEffect(() => () => {
        onDirtyChange?.(false);
    }, [onDirtyChange]);

    const openEdit = useCallback((config: ProviderConfig): void => {
        const next = draftFromConfig(config);
        setDraft(next);
        setBaselineJson(JSON.stringify(next));
        setShowKey(false);
        setExpandedModelIdx(null);
        setShowAdvanced(false);
        setSaveError('');
        setTestResult(null);
        setShowAddModelRow(false);
        setNewModelId('');
    }, []);

    const openAdd = useCallback((): void => {
        const next = emptyAddDraft('preset');
        setDraft(next);
        setBaselineJson(JSON.stringify(next));
        setShowKey(false);
        setExpandedModelIdx(null);
        setShowAdvanced(false);
        setSaveError('');
        setTestResult(null);
        setShowAddModelRow(false);
        setNewModelId('');
    }, []);

    const closeEditor = useCallback(async (): Promise<void> => {
        if (isDirty) {
            const ok = await confirm({
                title: 'Discard unsaved changes?',
                message: 'Your edits to this model provider have not been saved.',
                confirmLabel: 'Discard',
                destructive: true,
            });
            if (!ok) return;
        }
        setDraft(null);
        setBaselineJson('');
        setChooseModalCatalog(null);
        setSaveError('');
        setTestResult(null);
    }, [confirm, isDirty]);

    const applyPreset = useCallback((preset: ProviderPresetDef): void => {
        setDraft(prev => {
            if (!prev) return prev;
            const entries = preset.defaultModels.map(m => ({ ...m }));
            return {
                ...prev,
                addTab: 'preset',
                presetId: preset.id,
                providerId: preset.id,
                name: preset.name,
                baseUrl: preset.baseUrl,
                apiFormat: preset.apiFormat,
                entries,
                selectedModel: entries[0]?.id ?? '',
            };
        });
        setExpandedModelIdx(null);
        setSaveError('');
    }, []);

    const switchAddTab = useCallback((tab: 'preset' | 'custom'): void => {
        setDraft(prev => {
            if (!prev || prev.mode !== 'add' || prev.addTab === tab) return prev;
            if (tab === 'preset') {
                const p = findProviderPreset(prev.presetId) ?? PROVIDER_PRESETS[0];
                const entries = p.defaultModels.map(m => ({ ...m }));
                return {
                    ...prev,
                    addTab: 'preset',
                    presetId: p.id,
                    providerId: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    apiFormat: p.apiFormat,
                    entries,
                    selectedModel: entries[0]?.id ?? '',
                };
            }
            return {
                ...prev,
                addTab: 'custom',
                presetId: 'custom',
                providerId: prev.providerId && !findProviderPreset(prev.providerId) ? prev.providerId : '',
                name: prev.name && !findProviderPreset(prev.name) ? prev.name : '',
                baseUrl: '',
                apiFormat: 'chat_completions',
                entries: [],
                selectedModel: '',
            };
        });
        setExpandedModelIdx(null);
        setSaveError('');
    }, []);

    const urlValidation = useMemo(
        () => (draft ? validateProviderUrl(draft.baseUrl) : { valid: true as const, normalizedUrl: '' }),
        [draft],
    );

    const updateEntryAt = useCallback((idx: number, patch: Partial<ModelCatalogEntry>): void => {
        setDraft(prev => {
            if (!prev) return prev;
            const entries = prev.entries.map((entry, i) => (i === idx ? { ...entry, ...patch } : entry));
            let selectedModel = prev.selectedModel;
            if (patch.id !== undefined && prev.entries[idx]?.id === prev.selectedModel) {
                selectedModel = patch.id;
            }
            return { ...prev, entries, selectedModel };
        });
    }, []);

    const removeEntryAt = useCallback((idx: number): void => {
        setDraft(prev => {
            if (!prev) return prev;
            const removed = prev.entries[idx];
            const entries = prev.entries.filter((_, i) => i !== idx);
            const selectedModel = removed && prev.selectedModel === removed.id
                ? (entries[0]?.id ?? '')
                : prev.selectedModel;
            return { ...prev, entries, selectedModel };
        });
        setExpandedModelIdx(curr => {
            if (curr === null) return null;
            if (curr === idx) return null;
            return curr > idx ? curr - 1 : curr;
        });
    }, []);

    const moveEntry = useCallback((fromIdx: number, toIdx: number): void => {
        setDraft(prev => {
            if (!prev) return prev;
            const entries = reorderCatalogEntries(prev.entries, fromIdx, toIdx);
            return { ...prev, entries };
        });
        setExpandedModelIdx(curr => {
            if (curr === null) return null;
            if (curr === fromIdx) return toIdx;
            if (fromIdx < curr && toIdx >= curr) return curr - 1;
            if (fromIdx > curr && toIdx <= curr) return curr + 1;
            return curr;
        });
    }, []);

    const handleAddManualModel = useCallback((): void => {
        const trimmed = newModelId.trim();
        if (!trimmed) return;
        setDraft(prev => {
            if (!prev) return prev;
            if (prev.entries.some(e => e.id === trimmed)) return prev;
            const entries: ModelCatalogEntry[] = [
                ...prev.entries,
                { id: trimmed, inputTypes: { text: true, image: false } },
            ];
            return {
                ...prev,
                entries,
                selectedModel: prev.selectedModel || trimmed,
            };
        });
        setNewModelId('');
        setShowAddModelRow(false);
    }, [newModelId]);

    const handleRestorePresetDefaults = useCallback((): void => {
        if (!draft) return;
        const preset = findProviderPreset(draft.presetId);
        if (!preset || preset.defaultModels.length === 0) return;
        setDraft(prev => {
            if (!prev) return prev;
            const defaults = preset.defaultModels.map(m => ({ ...m }));
            return {
                ...prev,
                entries: defaults,
                selectedModel: defaults[0]?.id ?? '',
            };
        });
        setExpandedModelIdx(null);
        toast.success('Defaults restored', `Restored ${preset.defaultModels.length} default models for ${preset.name}.`);
    }, [draft, toast]);

    const handleFetchAvailableModels = useCallback(async (): Promise<void> => {
        if (!draft) return;
        setSaveError('');
        setIsFetchingModels(true);
        try {
            const catalog = await discoverProviderModelCatalog({
                baseUrl: draft.baseUrl.trim(),
                apiKey: draft.apiKey.trim(),
                apiFormat: draft.apiFormat,
            });
            const entries = catalog.entries && catalog.entries.length > 0
                ? catalog.entries
                : normalizeFetchedCatalog(draft.apiFormat, catalog.ids);
            setDraft(prev => (prev
                ? { ...prev, modelContextWindows: mergeModelContextWindows(prev.modelContextWindows, catalog.windows) }
                : prev));
            setChooseModalCatalog(entries);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Model discovery failed.';
            setSaveError(message);
            toast.error('Fetch models failed', message);
        } finally {
            setIsFetchingModels(false);
        }
    }, [draft, toast]);

    const handleChooseModalUpdate = useCallback((checkedIds: string[]): void => {
        if (!chooseModalCatalog) return;
        setDraft(prev => {
            if (!prev) return prev;
            const merged = mergeChosenModels(prev.entries, chooseModalCatalog, checkedIds);
            const selectedModel = merged.some(m => m.id === prev.selectedModel)
                ? prev.selectedModel
                : (merged[0]?.id ?? '');
            return { ...prev, entries: merged, selectedModel };
        });
        setChooseModalCatalog(null);
    }, [chooseModalCatalog]);

    const handleTestConnection = useCallback(async (): Promise<void> => {
        if (!draft) return;
        if (!urlValidation.valid) {
            setTestResult({ success: false, message: urlValidation.message || 'Fix the base URL first.' });
            return;
        }
        const activeModel = draft.selectedModel || draft.entries[0]?.id || '';
        if (!activeModel) {
            setTestResult({ success: false, message: 'Add or fetch at least one model before testing.' });
            return;
        }
        setIsTesting(true);
        setTestResult(null);
        try {
            const { models, modelOverrides } = catalogEntriesToConfigFields(draft.entries);
            const probeConfig: ProviderConfig = {
                id: draft.sourceId ?? sanitizeProviderId(draft.providerId || draft.name),
                name: draft.name.trim() || 'Provider',
                apiKey: draft.apiKey.trim(),
                baseUrl: urlValidation.normalizedUrl,
                apiFormat: draft.apiFormat,
                isEnabled: true,
                isBuiltIn: false,
                models,
                selectedModel: activeModel,
                modelOverrides,
                retryPolicy: draft.retryPolicy,
            };
            const res = await testConnection(probeConfig);
            setTestResult(res);
            if (res.success) {
                try {
                    await probeAndLearn(probeConfig);
                } catch { /* best-effort wire probe */ }
            }
        } catch (err) {
            setTestResult({ success: false, message: err instanceof Error ? err.message : 'Connection test failed.' });
        } finally {
            setIsTesting(false);
        }
    }, [draft, urlValidation]);

    const handleSave = useCallback(async (): Promise<void> => {
        if (!draft) return;
        const cleanName = draft.name.trim();
        if (!cleanName) {
            setSaveError('Display name is required.');
            return;
        }
        if (!urlValidation.valid) {
            setSaveError(urlValidation.message || 'Enter a valid HTTP/HTTPS Base URL.');
            return;
        }
        const { models, modelOverrides } = catalogEntriesToConfigFields(draft.entries);
        const selectedModel = models.includes(draft.selectedModel) ? draft.selectedModel : (models[0] ?? '');
        const ctxNum = Number(draft.contextWindowTokens);
        const contextWindowTokens = draft.contextWindowTokens.trim() && Number.isFinite(ctxNum) && ctxNum >= 512
            ? Math.floor(ctxNum)
            : undefined;
        const inputUsd = draft.inputUsdPer1k.trim() ? Number(draft.inputUsdPer1k) : undefined;
        const outputUsd = draft.outputUsdPer1k.trim() ? Number(draft.outputUsdPer1k) : undefined;

        setSaving(true);
        setSaveError('');
        try {
            if (draft.mode === 'add') {
                const resolvedId = sanitizeProviderId(draft.providerId || cleanName);
                await onAddCustomProvider({
                    id: resolvedId,
                    name: cleanName,
                    baseUrl: draft.baseUrl.trim(),
                    apiKey: draft.apiKey.trim(),
                    apiFormat: draft.apiFormat,
                    models,
                    selectedModel,
                    modelOverrides,
                    retryPolicy: draft.retryPolicy,
                    providerPreset: draft.addTab === 'preset' ? draft.presetId : 'custom',
                });
                toast.success('Provider added', `${cleanName} saved with ${models.length} model${models.length === 1 ? '' : 's'}.`);
            } else if (draft.sourceId) {
                await onUpdateProvider(draft.sourceId, {
                    name: cleanName,
                    baseUrl: draft.baseUrl.trim(),
                    apiKey: draft.apiKey.trim(),
                    apiFormat: draft.apiFormat,
                    models,
                    selectedModel,
                    modelOverrides,
                    modelContextWindows: draft.modelContextWindows,
                    retryPolicy: draft.retryPolicy,
                    contextWindowTokens,
                    inputUsdPer1k: inputUsd !== undefined && Number.isFinite(inputUsd) && inputUsd >= 0 ? inputUsd : undefined,
                    outputUsdPer1k: outputUsd !== undefined && Number.isFinite(outputUsd) && outputUsd >= 0 ? outputUsd : undefined,
                    thinkingCapable: draft.apiFormat === 'messages' && draft.thinkingCapable !== 'auto'
                        ? draft.thinkingCapable === 'on'
                        : undefined,
                });
                toast.success('Provider saved', `${cleanName} updated.`);
            }
            setDraft(null);
            setBaselineJson('');
            setChooseModalCatalog(null);
            onDirtyChange?.(false);
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : 'Could not save provider.');
        } finally {
            setSaving(false);
        }
    }, [draft, urlValidation, onAddCustomProvider, onUpdateProvider, onDirtyChange, toast]);

    const handleDeleteProvider = useCallback(async (config: ProviderConfig): Promise<void> => {
        const ok = await confirm({
            title: `Delete ${config.name}?`,
            message: 'Removes this provider and its saved model catalog. Any chat using it will fall back cleanly to another ready provider.',
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (!ok) return;
        await onRemoveProvider(config.id);
        toast.success('Provider removed', `${config.name} was deleted.`);
    }, [confirm, onRemoveProvider, toast]);

    // ─── View B: In-Pane Add/Edit Provider Sheet ───────────────────────────────
    if (draft) {
        const activePreset = findProviderPreset(draft.presetId);
        const canRestoreDefaults = Boolean(activePreset && activePreset.defaultModels.length > 0);
        const resolvedActiveWindow = resolveContextWindow({
            id: draft.sourceId ?? draft.providerId,
            name: draft.name,
            selectedModel: draft.selectedModel || draft.entries[0]?.id || '',
            contextWindowTokens: draft.contextWindowTokens ? Number(draft.contextWindowTokens) : undefined,
            modelContextWindows: draft.modelContextWindows,
            modelOverrides: catalogEntriesToConfigFields(draft.entries).modelOverrides,
        });

        return (
            <div data-testid="provider-editor-pane" className="space-y-5">
                {/* Breadcrumb Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void closeEditor()}
                            data-testid="provider-editor-back"
                            className="flex h-7 items-center gap-1.5 rounded-control border border-hairline bg-zinc-900 px-2.5 text-ui-dense text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        >
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                            Models
                        </button>
                        <span className="text-zinc-600" aria-hidden="true">/</span>
                        <span className="truncate text-ui-sm font-semibold text-zinc-100">
                            {draft.mode === 'add' ? (draft.name.trim() || 'Add model provider') : draft.name}
                        </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void handleTestConnection()}
                            disabled={isTesting}
                            data-testid="provider-editor-test-btn"
                            className="flex h-8 items-center gap-1.5 rounded-control border border-hairline bg-zinc-900 px-3 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                        >
                            <RefreshIcon className={`h-3.5 w-3.5 ${isTesting ? 'animate-spin' : ''}`} aria-hidden="true" />
                            {isTesting ? 'Testing…' : 'Test'}
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleSave()}
                            disabled={saving}
                            data-testid="provider-editor-save-btn"
                            className="flex h-8 items-center gap-1.5 rounded-control bg-zinc-100 px-3.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-40"
                        >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            {saving ? 'Saving…' : draft.mode === 'add' ? 'Add provider' : 'Save changes'}
                        </button>
                    </div>
                </div>

                {saveError && (
                    <div
                        role="alert"
                        data-testid="provider-editor-error"
                        className="rounded-control border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-ui-dense text-rose-300"
                    >
                        {saveError}
                    </div>
                )}

                {testResult && (
                    <div
                        role="status"
                        data-testid="provider-editor-test-result"
                        className={`rounded-control border px-3 py-2 text-ui-dense ${
                            testResult.success
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                        }`}
                    >
                        {testResult.message}
                    </div>
                )}

                {/* Preset vs Custom model API tabs (Add flow) */}
                {draft.mode === 'add' && (
                    <div className="space-y-3">
                        <div className="inline-flex rounded-control border border-hairline bg-zinc-950 p-0.5" role="tablist">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={draft.addTab === 'preset'}
                                data-testid="provider-mode-preset"
                                onClick={() => switchAddTab('preset')}
                                className={`h-7 rounded-control px-3 text-ui-dense font-medium transition-colors ${
                                    draft.addTab === 'preset'
                                        ? 'bg-zinc-800 text-zinc-100'
                                        : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                Preset
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={draft.addTab === 'custom'}
                                data-testid="provider-mode-custom"
                                onClick={() => switchAddTab('custom')}
                                className={`h-7 rounded-control px-3 text-ui-dense font-medium transition-colors ${
                                    draft.addTab === 'custom'
                                        ? 'bg-zinc-800 text-zinc-100'
                                        : 'text-zinc-400 hover:text-zinc-200'
                                }`}
                            >
                                Custom model API
                            </button>
                        </div>

                        {draft.addTab === 'preset' && (
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="provider-preset-grid">
                                {PROVIDER_PRESETS.map(preset => {
                                    const active = draft.presetId === preset.id;
                                    return (
                                        <button
                                            key={preset.id}
                                            type="button"
                                            data-testid={`provider-preset-${preset.id}`}
                                            onClick={() => applyPreset(preset)}
                                            className={`flex min-h-[48px] flex-col items-start justify-center rounded-control border px-3 py-2 text-left transition-colors ${
                                                active
                                                    ? 'border-zinc-500 bg-zinc-800/80 text-zinc-100'
                                                    : 'border-hairline bg-zinc-900/50 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900'
                                            }`}
                                        >
                                            <span className="text-ui-dense font-semibold">{preset.name}</span>
                                            <span className="mt-0.5 line-clamp-1 font-mono text-ui-2xs text-zinc-500">
                                                {preset.apiFormat}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* Core Provider Identity & Connection Form */}
                <div className="grid grid-cols-1 gap-3.5 rounded-bubble border border-hairline bg-zinc-900/40 p-4 sm:grid-cols-2">
                    <div>
                        <label htmlFor="provider-id-field" className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            Provider ID
                        </label>
                        {draft.mode === 'add' ? (
                            <input
                                id="provider-id-field"
                                data-testid="provider-id-input"
                                value={draft.providerId}
                                onChange={e => setDraft(prev => prev ? { ...prev, providerId: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') } : prev)}
                                placeholder="e.g. my-gateway"
                                className={inputCls}
                            />
                        ) : (
                            <div
                                data-testid="provider-id-readonly"
                                className="flex h-[34px] items-center rounded-control border border-hairline bg-zinc-950/70 px-3 font-mono text-ui-dense text-zinc-400"
                            >
                                {draft.providerId}
                            </div>
                        )}
                    </div>

                    <div>
                        <label htmlFor="provider-name-field" className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            Display name
                        </label>
                        <input
                            id="provider-name-field"
                            data-testid="provider-name-input"
                            value={draft.name}
                            onChange={e => setDraft(prev => prev ? { ...prev, name: e.target.value } : prev)}
                            placeholder="e.g. OpenRouter or Local Gateway"
                            className={inputCls}
                        />
                    </div>

                    <div className="sm:col-span-2">
                        <label htmlFor="provider-url-field" className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            Base URL
                        </label>
                        <input
                            id="provider-url-field"
                            data-testid="provider-url-input"
                            value={draft.baseUrl}
                            onChange={e => setDraft(prev => prev ? { ...prev, baseUrl: e.target.value } : prev)}
                            placeholder="https://api.example.com/v1"
                            className={inputCls}
                        />
                        {draft.baseUrl.trim() && !urlValidation.valid && (
                            <p className="mt-1 text-ui-2xs text-rose-400">{urlValidation.message}</p>
                        )}
                    </div>

                    <div>
                        <label className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            API protocol
                        </label>
                        <SelectMenu
                            value={draft.apiFormat}
                            onChange={val => setDraft(prev => prev ? { ...prev, apiFormat: val as ApiFormat } : prev)}
                            options={API_FORMAT_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                            aria-label="API protocol"
                            triggerClassName={selectTriggerCls}
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            Retry policy
                        </label>
                        <SelectMenu
                            value={draft.retryPolicy}
                            onChange={val => setDraft(prev => prev ? { ...prev, retryPolicy: val as ProviderRetryPolicy } : prev)}
                            options={RETRY_POLICY_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                            aria-label="Retry policy"
                            triggerClassName={selectTriggerCls}
                        />
                    </div>

                    <div className="sm:col-span-2">
                        <label htmlFor="provider-key-field" className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                            API key
                        </label>
                        <div className="flex items-center gap-1.5">
                            <input
                                id="provider-key-field"
                                data-testid="provider-key-input"
                                type={showKey ? 'text' : 'password'}
                                value={draft.apiKey}
                                onChange={e => setDraft(prev => prev ? { ...prev, apiKey: e.target.value } : prev)}
                                placeholder={draft.presetId === 'ollama' ? 'Optional for localhost Ollama' : 'sk-...'}
                                autoComplete="off"
                                className={inputCls}
                            />
                            <button
                                type="button"
                                onClick={() => setShowKey(v => !v)}
                                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                                data-testid="provider-key-toggle"
                                className="flex h-[34px] w-9 shrink-0 items-center justify-center rounded-control border border-hairline bg-zinc-950 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                            >
                                {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Customized Model Catalog */}
                <div
                    data-testid="provider-model-catalog"
                    className="rounded-bubble border border-hairline bg-zinc-900/40"
                >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
                        <div>
                            <h4 className="text-ui-sm font-semibold text-zinc-100">
                                Customized Model Catalog
                                <span className="ml-2 font-mono text-ui-2xs font-normal text-zinc-500">
                                    {draft.entries.length} model{draft.entries.length === 1 ? '' : 's'}
                                </span>
                            </h4>
                            <p className="text-ui-2xs text-zinc-500">
                                Order here controls the composer picker. Expand any row to override context, vision, or reasoning.
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {canRestoreDefaults && (
                                <button
                                    type="button"
                                    onClick={handleRestorePresetDefaults}
                                    data-testid="catalog-restore-defaults-btn"
                                    className="h-7 rounded-control border border-hairline bg-zinc-950 px-2.5 text-ui-2xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                                >
                                    Restore defaults
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setShowAddModelRow(v => !v)}
                                data-testid="catalog-add-model-btn"
                                className="flex h-7 items-center gap-1 rounded-control border border-hairline bg-zinc-950 px-2.5 text-ui-2xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
                            >
                                <PlusIcon className="h-3 w-3" aria-hidden="true" />
                                Add model
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleFetchAvailableModels()}
                                disabled={isFetchingModels}
                                data-testid="fetch-available-models-btn"
                                className="flex h-7 items-center gap-1.5 rounded-control bg-zinc-100 px-3 text-ui-2xs font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-40"
                            >
                                <RefreshIcon className={`h-3 w-3 ${isFetchingModels ? 'animate-spin' : ''}`} aria-hidden="true" />
                                {isFetchingModels ? 'Fetching…' : 'Fetch available models'}
                            </button>
                        </div>
                    </div>

                    {showAddModelRow && (
                        <div className="flex items-center gap-2 border-b border-hairline bg-zinc-950/60 px-4 py-2.5">
                            <input
                                value={newModelId}
                                onChange={e => setNewModelId(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddManualModel(); } }}
                                placeholder="Exact model slug, e.g. deepseek/deepseek-r1"
                                aria-label="New model ID"
                                data-testid="catalog-new-model-input"
                                className={inputCls}
                            />
                            <button
                                type="button"
                                onClick={handleAddManualModel}
                                data-testid="catalog-new-model-confirm"
                                className="h-8 shrink-0 rounded-control bg-zinc-100 px-3 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-white"
                            >
                                Add
                            </button>
                        </div>
                    )}

                    <div className="divide-y divide-white/[0.05]">
                        {draft.entries.length === 0 ? (
                            <div className="px-4 py-6 text-center text-ui-dense text-zinc-500">
                                No models selected yet. Click <span className="text-zinc-300">Fetch available models</span> or <span className="text-zinc-300">+ Add model</span>.
                            </div>
                        ) : (
                            draft.entries.map((entry, idx) => {
                                const expanded = expandedModelIdx === idx;
                                const isDefault = draft.selectedModel === entry.id;
                                const ctxBadge = formatCompactCtx(entry.contextWindow ?? draft.modelContextWindows?.[entry.id]);
                                const inputTypes = entry.inputTypes ?? { text: true, image: false };
                                const reasoningLevels: ModelReasoningLevel[] = entry.reasoningLevels ?? [];
                                return (
                                    <div
                                        key={`${entry.id}-${idx}`}
                                        data-testid={`catalog-model-row-${idx}`}
                                        draggable
                                        onDragStart={() => { dragIndexRef.current = idx; }}
                                        onDragOver={e => e.preventDefault()}
                                        onDrop={() => {
                                            if (dragIndexRef.current !== null && dragIndexRef.current !== idx) {
                                                moveEntry(dragIndexRef.current, idx);
                                            }
                                            dragIndexRef.current = null;
                                        }}
                                        className="bg-zinc-950/40"
                                    >
                                        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
                                            <span
                                                title="Drag to reorder"
                                                className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center text-zinc-600 hover:text-zinc-300"
                                            >
                                                <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => moveEntry(idx, idx - 1)}
                                                disabled={idx === 0}
                                                aria-label={`Move ${entry.id} up`}
                                                data-testid={`catalog-move-up-${idx}`}
                                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-25"
                                            >
                                                <ArrowUp className="h-3 w-3" aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => moveEntry(idx, idx + 1)}
                                                disabled={idx === draft.entries.length - 1}
                                                aria-label={`Move ${entry.id} down`}
                                                data-testid={`catalog-move-down-${idx}`}
                                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-25"
                                            >
                                                <ArrowDown className="h-3 w-3" aria-hidden="true" />
                                            </button>

                                            <button
                                                type="button"
                                                onClick={() => setDraft(prev => prev ? { ...prev, selectedModel: entry.id } : prev)}
                                                aria-label={`Set ${entry.id} as default model`}
                                                aria-pressed={isDefault}
                                                title={isDefault ? 'Default model for this provider' : 'Make default model'}
                                                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                                                    isDefault
                                                        ? 'border-emerald-400 bg-emerald-500/20 text-emerald-400'
                                                        : 'border-zinc-700 text-transparent hover:border-zinc-500'
                                                }`}
                                            >
                                                <span className="h-2 w-2 rounded-full bg-current" />
                                            </button>

                                            <input
                                                value={entry.id}
                                                onChange={e => updateEntryAt(idx, { id: e.target.value })}
                                                aria-label={`Model ID row ${idx + 1}`}
                                                data-testid={`catalog-model-id-${idx}`}
                                                className="min-w-[140px] flex-1 rounded-control border border-transparent bg-transparent px-2 py-1 font-mono text-ui-dense text-zinc-200 transition-colors hover:border-hairline focus:border-zinc-600 focus:bg-zinc-950 focus:outline-none"
                                            />

                                            <input
                                                value={entry.displayName ?? ''}
                                                onChange={e => updateEntryAt(idx, { displayName: e.target.value || undefined })}
                                                placeholder={formatModelDisplayName(entry.id) || 'Display name'}
                                                aria-label={`Display name row ${idx + 1}`}
                                                data-testid={`catalog-display-name-${idx}`}
                                                className="min-w-[120px] flex-1 rounded-control border border-hairline bg-zinc-950 px-2 py-1 text-ui-dense text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                                            />

                                            <div className="flex shrink-0 items-center gap-1">
                                                {ctxBadge && (
                                                    <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs tabular-nums text-zinc-400">
                                                        {ctxBadge}
                                                    </span>
                                                )}
                                                {inputTypes.image && (
                                                    <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-300">
                                                        Img
                                                    </span>
                                                )}
                                                {entry.reasoningEnabled && (
                                                    <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-300">
                                                        Think
                                                    </span>
                                                )}
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => setExpandedModelIdx(expanded ? null : idx)}
                                                aria-expanded={expanded}
                                                aria-label={`Configure overrides for ${entry.id}`}
                                                data-testid={`catalog-expand-${idx}`}
                                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                                            >
                                                {expanded
                                                    ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                                                    : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => removeEntryAt(idx)}
                                                aria-label={`Remove ${entry.id}`}
                                                data-testid={`catalog-remove-${idx}`}
                                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                                            >
                                                <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                            </button>
                                        </div>

                                        {/* Expanded Per-Model Override Accordion */}
                                        {expanded && (
                                            <div
                                                data-testid="catalog-model-overrides"
                                                className="space-y-3 border-t border-hairline bg-zinc-950/80 px-4 py-3"
                                            >
                                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                    <div>
                                                        <label className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                                                            Context window (tokens)
                                                        </label>
                                                        <input
                                                            type="number"
                                                            min={512}
                                                            step={1024}
                                                            data-testid="override-context-window"
                                                            value={entry.contextWindow ?? ''}
                                                            onChange={e => {
                                                                const raw = e.target.value.trim();
                                                                const num = Number(raw);
                                                                updateEntryAt(idx, {
                                                                    contextWindow: raw && Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined,
                                                                });
                                                            }}
                                                            placeholder="e.g. 128000"
                                                            className={inputCls}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                                                            Max output tokens
                                                        </label>
                                                        <input
                                                            type="number"
                                                            min={64}
                                                            step={256}
                                                            data-testid="override-max-output"
                                                            value={entry.maxOutputTokens ?? ''}
                                                            onChange={e => {
                                                                const raw = e.target.value.trim();
                                                                const num = Number(raw);
                                                                updateEntryAt(idx, {
                                                                    maxOutputTokens: raw && Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined,
                                                                });
                                                            }}
                                                            placeholder="e.g. 8192"
                                                            className={inputCls}
                                                        />
                                                    </div>
                                                </div>

                                                {/* Input Modalities (at least 1 enforced) + Prompt Profile */}
                                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                    <div className="flex flex-wrap items-center gap-4">
                                                        <span className="text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                                                            Input types
                                                        </span>
                                                        <label className="flex min-h-[24px] cursor-pointer items-center gap-2 text-ui-dense text-zinc-200">
                                                            <input
                                                                type="checkbox"
                                                                data-testid="override-input-text"
                                                                checked={inputTypes.text}
                                                                onChange={e => updateEntryAt(idx, {
                                                                    inputTypes: toggleInputModality(inputTypes, 'text', e.target.checked),
                                                                })}
                                                                className="h-3.5 w-3.5 accent-zinc-100"
                                                            />
                                                            Text
                                                        </label>
                                                        <label className="flex min-h-[24px] cursor-pointer items-center gap-2 text-ui-dense text-zinc-200">
                                                            <input
                                                                type="checkbox"
                                                                data-testid="override-input-image"
                                                                checked={inputTypes.image}
                                                                onChange={e => updateEntryAt(idx, {
                                                                    inputTypes: toggleInputModality(inputTypes, 'image', e.target.checked),
                                                                })}
                                                                className="h-3.5 w-3.5 accent-zinc-100"
                                                            />
                                                            Image (Vision)
                                                        </label>
                                                    </div>
                                                    <div>
                                                        <label className="mb-1 block text-ui-2xs font-medium uppercase tracking-wider text-zinc-500">
                                                            Prompt profile
                                                        </label>
                                                        <SelectMenu
                                                            value={entry.promptProfile ?? 'auto'}
                                                            onChange={val => {
                                                                const next = val as PromptProfile;
                                                                updateEntryAt(idx, {
                                                                    promptProfile: next === 'auto' ? undefined : next,
                                                                });
                                                            }}
                                                            options={[
                                                                { value: 'auto', label: 'Auto' },
                                                                { value: 'reasoning', label: 'Reasoning' },
                                                                { value: 'standard', label: 'Standard' },
                                                                { value: 'compact_local', label: 'Compact local' },
                                                            ]}
                                                            aria-label={`Prompt profile for ${entry.id}`}
                                                            data-testid="override-prompt-profile"
                                                            triggerClassName={selectTriggerCls}
                                                        />
                                                    </div>
                                                </div>

                                                {/* Reasoning Levels Toggle + Editable Mapping Rows */}
                                                <div className="space-y-2 border-t border-hairline pt-2.5">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div>
                                                            <p className="text-ui-dense font-medium text-zinc-200">Reasoning levels</p>
                                                            <p className="text-ui-2xs text-zinc-500">
                                                                Map composer effort tiers to exact wire API values.
                                                            </p>
                                                        </div>
                                                        <ToggleSwitch
                                                            checked={entry.reasoningEnabled === true}
                                                            onChange={() => {
                                                                const next = entry.reasoningEnabled !== true;
                                                                updateEntryAt(idx, {
                                                                    reasoningEnabled: next,
                                                                    reasoningLevels: next
                                                                        ? (reasoningLevels.length > 0 ? reasoningLevels : [...DEFAULT_REASONING_LEVELS])
                                                                        : entry.reasoningLevels,
                                                                });
                                                            }}
                                                            label={`Enable reasoning levels for ${entry.id}`}
                                                            testId="override-reasoning-toggle"
                                                        />
                                                    </div>

                                                    {entry.reasoningEnabled && (
                                                        <div className="space-y-1.5 pt-1">
                                                            {reasoningLevels.map((lvl, lIdx) => (
                                                                <div key={lIdx} className="flex items-center gap-2">
                                                                    <input
                                                                        value={lvl.level}
                                                                        onChange={e => {
                                                                            const nextLevels = reasoningLevels.map((r, ri) =>
                                                                                ri === lIdx ? { ...r, level: e.target.value } : r,
                                                                            );
                                                                            updateEntryAt(idx, { reasoningLevels: nextLevels });
                                                                        }}
                                                                        placeholder="Level (e.g. high)"
                                                                        aria-label={`Reasoning level key ${lIdx + 1}`}
                                                                        className={inputCls}
                                                                    />
                                                                    <span className="text-zinc-600" aria-hidden="true">→</span>
                                                                    <input
                                                                        value={lvl.apiValue}
                                                                        onChange={e => {
                                                                            const nextLevels = reasoningLevels.map((r, ri) =>
                                                                                ri === lIdx ? { ...r, apiValue: e.target.value } : r,
                                                                            );
                                                                            updateEntryAt(idx, { reasoningLevels: nextLevels });
                                                                        }}
                                                                        placeholder="API value (e.g. high)"
                                                                        aria-label={`Reasoning API value ${lIdx + 1}`}
                                                                        className={inputCls}
                                                                    />
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => updateEntryAt(idx, {
                                                                            reasoningLevels: reasoningLevels.filter((_, ri) => ri !== lIdx),
                                                                        })}
                                                                        aria-label={`Remove reasoning level ${lvl.level || lIdx + 1}`}
                                                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                                                                    >
                                                                        <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                                                    </button>
                                                                </div>
                                                            ))}
                                                            <button
                                                                type="button"
                                                                data-testid="override-add-level-btn"
                                                                onClick={() => updateEntryAt(idx, {
                                                                    reasoningLevels: [...reasoningLevels, { level: 'max', apiValue: 'high' }],
                                                                })}
                                                                className="flex h-7 items-center gap-1 rounded-control border border-hairline bg-zinc-900 px-2.5 text-ui-2xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                                                            >
                                                                <PlusIcon className="h-3 w-3" aria-hidden="true" />
                                                                Add level
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Compact Provider-Level Advanced Disclosure */}
                <div className="rounded-bubble border border-hairline bg-zinc-900/30 px-4 py-2.5">
                    <button
                        type="button"
                        onClick={() => setShowAdvanced(v => !v)}
                        aria-expanded={showAdvanced}
                        className="flex h-6 w-full items-center justify-between text-left text-ui-2xs font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                    >
                        <span>Provider defaults &amp; cost tracking ({resolvedActiveWindow.tokens.toLocaleString()} tok active)</span>
                        {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                    {showAdvanced && (
                        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-hairline pt-3 sm:grid-cols-3">
                            <div>
                                <label className="mb-1 block text-ui-2xs text-zinc-500">Provider context override</label>
                                <input
                                    type="number"
                                    value={draft.contextWindowTokens}
                                    onChange={e => setDraft(prev => prev ? { ...prev, contextWindowTokens: e.target.value } : prev)}
                                    placeholder="Auto (1M)"
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-ui-2xs text-zinc-500">Input USD / 1K tok</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    value={draft.inputUsdPer1k}
                                    onChange={e => setDraft(prev => prev ? { ...prev, inputUsdPer1k: e.target.value } : prev)}
                                    placeholder="Optional"
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-ui-2xs text-zinc-500">Output USD / 1K tok</label>
                                <input
                                    type="number"
                                    step="0.0001"
                                    value={draft.outputUsdPer1k}
                                    onChange={e => setDraft(prev => prev ? { ...prev, outputUsdPer1k: e.target.value } : prev)}
                                    placeholder="Optional"
                                    className={inputCls}
                                />
                            </div>
                        </div>
                    )}
                </div>

                {chooseModalCatalog && (
                    <ChooseModelsModal
                        providerName={draft.name.trim() || draft.providerId}
                        fetchedCatalog={chooseModalCatalog}
                        initialCheckedIds={draft.entries.map(e => e.id)}
                        onCancel={() => setChooseModalCatalog(null)}
                        onUpdateList={handleChooseModalUpdate}
                    />
                )}
                {ConfirmDialogComponent}
            </div>
        );
    }

    // ─── View A: Calm Matte-Monochrome Provider Roster ─────────────────────────
    return (
        <div data-testid="settings-models-roster" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h3 className="text-ui-sm font-semibold text-zinc-100">Model providers</h3>
                    <p className="text-ui-2xs text-zinc-500">
                        {configs.length === 0
                            ? 'Add any OpenAI, Anthropic, Gemini, OpenRouter, or local gateway.'
                            : `${configs.filter(isProviderReady).length} of ${configs.length} ready for chat and analysis.`}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowConfigJson(true)}
                    data-testid="open-config-json-btn"
                    className="flex h-7 items-center gap-1.5 rounded-control border border-hairline bg-zinc-900 px-2.5 text-ui-2xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                >
                    <Code className="h-3.5 w-3.5" aria-hidden="true" />
                    Open configuration
                </button>
            </div>

            {!isLoaded ? (
                <div className="rounded-bubble border border-hairline bg-zinc-900/40 px-4 py-6 text-center text-ui-dense text-zinc-500">
                    Loading providers…
                </div>
            ) : (
                <div className="space-y-2">
                    {configs.map(config => {
                        const ready = isProviderReady(config);
                        const isCustom = !config.isBuiltIn;
                        return (
                            <div
                                key={config.id}
                                data-testid={`provider-roster-row-${config.id}`}
                                className="flex flex-wrap items-center gap-3 rounded-bubble border border-hairline bg-zinc-900/50 px-4 py-3 transition-colors hover:border-zinc-700"
                            >
                                <span
                                    aria-hidden="true"
                                    title={ready ? 'Ready' : 'Not ready (disabled, missing key, or no models)'}
                                    className={`h-2 w-2 shrink-0 rounded-full ${ready ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-ui-sm font-semibold text-zinc-100">
                                            {config.name}
                                        </span>
                                        {isCustom && (
                                            <span className="shrink-0 rounded-control border border-hairline bg-zinc-950 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400">
                                                Custom
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-0.5 truncate font-mono text-ui-2xs text-zinc-500">
                                        {config.models.length} model{config.models.length === 1 ? '' : 's'}
                                        {' · '}
                                        {config.apiFormat}
                                        {config.selectedModel ? ` · ${config.modelOverrides?.[config.selectedModel]?.displayName || formatModelDisplayName(config.selectedModel)}` : ''}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    <ToggleSwitch
                                        checked={config.isEnabled}
                                        onChange={() => { void onToggleProvider(config.id); }}
                                        label={`Toggle ${config.name}`}
                                        testId={`provider-toggle-${config.id}`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => openEdit(config)}
                                        data-testid={`provider-edit-${config.id}`}
                                        className="h-7 rounded-control border border-hairline bg-zinc-950 px-3 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteProvider(config)}
                                        aria-label={`Delete ${config.name}`}
                                        data-testid={`provider-delete-${config.id}`}
                                        className="flex h-7 w-7 items-center justify-center rounded-control border border-hairline bg-zinc-950 text-zinc-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-400"
                                    >
                                        <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                        );
                    })}

                    <button
                        type="button"
                        onClick={openAdd}
                        data-testid="add-model-provider-btn"
                        className="flex h-11 w-full items-center justify-center gap-2 rounded-bubble border border-dashed border-zinc-700 bg-zinc-950/60 text-ui-dense font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-100"
                    >
                        <PlusIcon className="h-4 w-4" aria-hidden="true" />
                        Add model provider
                    </button>
                </div>
            )}

            {showConfigJson && (
                <ProviderConfigJsonModal
                    configs={configs}
                    onClose={() => setShowConfigJson(false)}
                />
            )}
            {ConfirmDialogComponent}
        </div>
    );
};

export default React.memo(ProviderManager);
