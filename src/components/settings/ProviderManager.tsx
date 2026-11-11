/**
 * ProviderManager — Configure AI providers matching reference UI layout:
 * - Left sidebar list of Providers and Custom providers with status dot indicators
 * - Bottom "+ Add provider" button on sidebar
 * - Right panel with Provider name (editable), Enabled/Disable toggle pills, and Delete icon
 * - Base URL, API format, API key with SVG eye toggle
 * - Model list container with model ID rows, context badges, SVG edit/delete/link actions, and "+ Add model" button
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {Box, Check, Eye, EyeOff, LoadingIcon, Pencil, RefreshCw, Trash2, X, Zap} from '../shared/Icons';
import { ProviderConfig, ApiFormat, API_FORMAT_LABELS } from '../../types/provider';
import { GOOGLE_GEMINI_DEFAULT_BASE } from '../../utils/googleGeminiFormat';
import { testConnection } from '../../services/providers/GenericProviderService';
import { discoverProviderModelCatalog, discoverProviderModels } from '../../services/infrastructure/ProviderConfigService';
import { resetProviderHealth, getProviderHealth, providerCooldownRemainingMs } from '../../services/infrastructure/ProviderHealthService';
import { probeAndLearn } from '../../services/learning/harnessLessons';
import { validateProviderUrl } from '../../utils/providerUrlValidation';
import { ageMinutes, healthLabel } from '../../utils/relativeTime';
import { findProviderById, mergeDiscoveredModels, mergeModelContextWindows, sameModelContextWindows, sortModelsFreeFirst, isProviderReady } from '../../utils/providerUtils';
import { resolveContextWindow } from '../../utils/contextWindow';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import { SelectMenu } from '../shared/SelectMenu';
import { useToastActions } from '../shared/Toast';

import StatusPill from '../ui/StatusPill';
import ToggleSwitch from '../shared/ToggleSwitch';

interface ProviderManagerProps {
    configs: ProviderConfig[];
    /** False while the provider configs are still being loaded from storage —
     *  prevents the "No providers configured" empty state from flashing. */
    isLoaded?: boolean;
    onUpdateProvider: (id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>) => Promise<void>;
    onAddCustomProvider: (provider: {
        name: string; baseUrl: string; apiKey: string; apiFormat: ApiFormat;
        models?: string[]; selectedModel?: string;
    }) => Promise<void>;
    onRemoveProvider: (id: string) => Promise<void>;
    onToggleProvider: (id: string) => Promise<void>;
    onAddModel?: (providerId: string, modelId: string) => Promise<void>;
    onRemoveModel?: (providerId: string, modelId: string) => Promise<void>;
    onUpdateModel?: (providerId: string, oldModelId: string, newModelId: string) => Promise<void>;
    /** Reports staged-edit dirtiness so the host can confirm before closing. */
    onDirtyChange?: (dirty: boolean) => void;
}



// ─── Presentational Helpers ───────────────────────────────────────────────────

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <label className="block text-ui-dense font-medium text-zinc-400 mb-1.5">
        {children}
    </label>
);

const inputBase =
    'w-full px-3.5 py-2.5 rounded-control bg-zinc-950 border border-zinc-800 text-ui-base text-zinc-100 ' +
    'placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-600 ' +
    // transition-colors: only the border recolours on focus; nothing geometry does.
    'transition-colors duration-[150ms] ease-[var(--ease-snappy)]';

// Trigger classes for the SelectMenu dropdowns below (endpoint format,
// extended thinking). SelectMenu draws its own chevron, so unlike the old
// native-select base there is no appearance-none / bg-image arrow here.
const selectTriggerBase =
    'w-full px-3.5 py-2.5 rounded-control bg-zinc-950 border border-zinc-800 text-ui-base text-zinc-100 ' +
    'focus:outline-none focus:border-zinc-600 transition-colors duration-[150ms] ease-[var(--ease-snappy)] ' +
    'cursor-pointer hover:bg-zinc-900';

function getContextBadge(modelId: string): string {
    const m = modelId.toLowerCase();
    if (m.includes('1m') || m.includes('flash-free') || m.includes('deepseek-v4') || m.includes('nemotron') || m.includes('laguna')) return '1M';
    if (m.includes('262k') || m.includes('hy3') || m.includes('ling-3')) return '262K';
    if (m.includes('128k') || m.includes('glm-4') || m.includes('llama-4')) return '128K';
    if (m.includes('32k') || m.includes('qwen3-32b')) return '32K';
    return '1M';
}

/**
 * Live provider-health read-out (plan read side — the Settings view the
 * ProviderHealthService header comment always promised). Reads the in-memory
 * telemetry fed by GenericProviderService on every call: requests/errors,
 * rate limits, last error, latency, and whether the roster cooldown bench
 * currently applies. Polls while mounted (cheap — a Map read).
 */
const ProviderHealthBlock: React.FC<{ providerId: string }> = ({ providerId }) => {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 5000);
        return () => clearInterval(id);
    }, []);
    void tick; // re-render driver for the poll
    const h = getProviderHealth(providerId);
    const cooldownMs = providerCooldownRemainingMs(providerId);
    if (!h || (h.requestCount === 0 && !h.lastError)) {
        return (
            <p className="text-ui-dense text-zinc-600">
                No live telemetry this session yet — health appears after the first call through this provider.
            </p>
        );
    }
    const fmtAgo = (iso?: string): string => {
        if (!iso) return '—';
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return '—';
        return healthLabel(ageMinutes(at));
    };
    return (
        <div className=" rounded-control border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <div className="flex items-center justify-between">
                <p className="text-ui-xs font-bold uppercase tracking-widest text-zinc-500">Live health (this session)</p>
                {cooldownMs > 0 && (
                    <StatusPill tone="warn" kicker>
                        benched · {Math.ceil(cooldownMs / 60000)}m left
                    </StatusPill>
                )}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-ui-dense tabular-nums text-zinc-400 sm:grid-cols-3">
                <span>{h.requestCount} calls · {h.errorCount} errors</span>
                <span>{h.rateLimitCount > 0 ? `${h.rateLimitCount} rate-limited` : 'no rate limits'}</span>
                <span>{h.avgLatencyMs ? `avg ${h.avgLatencyMs}ms` : '—'}{h.lastLatencyMs ? ` · last ${h.lastLatencyMs}ms` : ''}</span>
                <span className="col-span-2 sm:col-span-3">last success {fmtAgo(h.lastSuccessAt)}</span>
                {h.lastError && (
                    <span className="col-span-2 truncate text-rose-400 sm:col-span-3" title={h.lastError}>
                        last error: {h.lastError}
                    </span>
                )}
            </div>
        </div>
    );
};

const ProviderManager: React.FC<ProviderManagerProps> = ({
    configs,
    isLoaded = true,
    onUpdateProvider,
    onAddCustomProvider,
    onRemoveProvider,
    onToggleProvider,
    onAddModel,
    onRemoveModel,
    onUpdateModel,
    onDirtyChange,
}) => {
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const toast = useToastActions();
    const [selectedId, setSelectedId] = useState<string>(configs[0]?.id || '');
    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');

    // Draft (staged) values for right panel
    const [draftKey, setDraftKey] = useState('');
    const [draftUrl, setDraftUrl] = useState('');
    const [draftFormat, setDraftFormat] = useState<ApiFormat>('chat_completions');
    const [draftModel, setDraftModel] = useState('');
    // Tri-state thinking override for Anthropic-style 'messages' endpoints:
    // 'auto' = detect from the model id (thinkingCapable: undefined), 'on' =
    // always request a thinking budget (true), 'off' = never (false).
    const [draftThinking, setDraftThinking] = useState<'auto' | 'on' | 'off'>('auto');
    const [draftInputUsd, setDraftInputUsd] = useState('');
    const [draftOutputUsd, setDraftOutputUsd] = useState('');
    // Optional model context window (tokens) — retrieved-memory budgets
    // scale from it instead of the hard-coded default. Empty ⇒ unset.
    const [draftCtxWindow, setDraftCtxWindow] = useState('');
    const [showKey, setShowKey] = useState(false);

    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [isTesting, setIsTesting] = useState(false);
    const [testingModelId, setTestingModelId] = useState<string | null>(null);
    const [modelTests, setModelTests] = useState<Record<string, { ok: boolean; message: string }>>({});
    // "Discover models" — /models endpoint import (per-provider + add form).
    const [isDiscovering, setIsDiscovering] = useState(false);
    const [isDiscoveringNew, setIsDiscoveringNew] = useState(false);

    // Add new model inline state
    const [showAddModelInput, setShowAddModelInput] = useState(false);
    const [newModelInput, setNewModelInput] = useState('');

    // Edit model inline state
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [editModelInput, setEditModelInput] = useState('');

    // Add new provider modal/inline state
    const [showAddProvider, setShowAddProvider] = useState(false);
    const [newName, setNewName] = useState('');
    const [newUrl, setNewUrl] = useState('');
    const [newKey, setNewKey] = useState('');
    const [newFormat, setNewFormat] = useState<ApiFormat>('chat_completions');
    const [newModels, setNewModels] = useState('');
    const [addError, setAddError] = useState('');

    // Track the "saved" badge timer so it's cleared on unmount / next save.
    const saveStateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const selected = useMemo(() => findProviderById(configs, selectedId) || configs[0], [configs, selectedId]);

    useEffect(() => {
        if (selected) {
            setDraftKey(selected.apiKey);
            setDraftUrl(selected.baseUrl);
            setDraftFormat(selected.apiFormat);
            setDraftModel(selected.selectedModel);
            setDraftThinking(selected.thinkingCapable === true ? 'on' : selected.thinkingCapable === false ? 'off' : 'auto');
            setDraftInputUsd(selected.inputUsdPer1k !== undefined ? String(selected.inputUsdPer1k) : '');
            setDraftOutputUsd(selected.outputUsdPer1k !== undefined ? String(selected.outputUsdPer1k) : '');
            setDraftCtxWindow(selected.contextWindowTokens !== undefined ? String(selected.contextWindowTokens) : '');
            setNameDraft(selected.name);
            setIsEditingName(false);
            setShowKey(false);
            setSaveState('idle');
            setTestResult(null);
            setModelTests({});
            setShowAddModelInput(false);
            setEditingModelId(null);
        }
    }, [selected?.id, selected?.apiKey, selected?.baseUrl, selected?.apiFormat, selected?.selectedModel, selected?.name]);

    const draftUrlValidation = useMemo(() => validateProviderUrl(draftUrl), [draftUrl]);
    const newUrlValidation = useMemo(() => validateProviderUrl(newUrl), [newUrl]);

    // The control only exists for the messages endpoint — under any other
    // DRAFT format the saved override is what Save will write back (undefined),
    // so the draft must compare as 'auto' rather than count as a hidden edit.
    const draftThinkingEffective = draftFormat === 'messages'
        ? draftThinking
        : 'auto';
    // `selected` is undefined in a fresh workspace (no provider rows yet) —
    // the dirty probe must not read through it. isDirty below already
    // short-circuits on !selected; this preview has to do the same or the
    // whole Settings dialog crashes on first-run onboarding.
    const draftThinkingDirty = !!selected && draftThinkingEffective !== (selected.thinkingCapable === true ? 'on' : selected.thinkingCapable === false ? 'off' : 'auto');

    const isDirty = useMemo(() => {
        if (!selected) return false;
        return (
            draftKey !== selected.apiKey ||
            draftUrl !== selected.baseUrl ||
            draftFormat !== selected.apiFormat ||
            draftModel !== selected.selectedModel ||
            draftThinkingDirty ||
            draftInputUsd !== (selected.inputUsdPer1k !== undefined ? String(selected.inputUsdPer1k) : '') ||
            draftOutputUsd !== (selected.outputUsdPer1k !== undefined ? String(selected.outputUsdPer1k) : '') ||
            draftCtxWindow !== (selected.contextWindowTokens !== undefined ? String(selected.contextWindowTokens) : '') ||
            (!!nameDraft.trim() && nameDraft.trim() !== selected.name)
        );
        }, [selected, draftKey, draftUrl, draftFormat, draftModel, draftThinkingDirty, draftInputUsd, draftOutputUsd, draftCtxWindow, nameDraft]);

    // Surface dirtiness to the host (SettingsMenu) so closing the modal while
    // a draft is staged can warn instead of silently discarding edits.
    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    /** Selecting a row re-seeds EVERY draft field from the newly selected
     *  provider (the effect above), so an unguarded switch silently threw away
     *  a half-typed key or base URL while the UI implied the edits were safe.
     *  The close path already asks; this asks the same question with the same
     *  words, because it is the same loss. Declared after `isDirty` — a deps
     *  array is evaluated at this line, so hoisting it would be a TDZ crash. */
    const selectProvider = useCallback(async (id: string) => {
        if (id !== selected?.id && isDirty) {
            const ok = await confirm({
                title: 'Discard unsaved changes?',
                message: `Your edits to ${selected?.name ?? 'this provider'} have not been saved.`,
                confirmLabel: 'Discard',
            });
            if (!ok) return;
        }
        setSelectedId(id);
        setShowAddProvider(false);
    }, [confirm, isDirty, selected?.id, selected?.name]);

    const handleSave = useCallback(async () => {
        if (!selected || !draftUrlValidation.valid) return;
        setSaveState('saving');
        const updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>> = {
            // Trim the key — a pasted key with a trailing newline passed the
            // "ready" check (getReadyProviders trims) but failed every auth.
            apiKey: draftKey.trim(),
            baseUrl: draftUrl.trim(),
            apiFormat: draftFormat,
            selectedModel: draftModel,
            // Only 'messages' (Anthropic-style) endpoints have a thinking
            // gate; switching to another format must clear any stale override
            // so it doesn't resurrect if the user switches back.
            thinkingCapable: draftFormat === 'messages' && draftThinking !== 'auto'
                ? draftThinking === 'on'
                : undefined,
            inputUsdPer1k: draftInputUsd.trim() ? Number(draftInputUsd) : undefined,
            outputUsdPer1k: draftOutputUsd.trim() ? Number(draftOutputUsd) : undefined,
            // Empty or garbage ⇒ unset (default window), never NaN leaking
            // into windowBudgetTokens' arithmetic.
            contextWindowTokens: (() => {
                const n = Number(draftCtxWindow);
                return draftCtxWindow.trim() && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
            })(),
        };
        if (nameDraft.trim() && nameDraft.trim() !== selected.name) {
            updates.name = nameDraft.trim();
        }
        try {
            await onUpdateProvider(selected.id, updates);
            setIsEditingName(false);
            setSaveState('saved');
            // Track the timer so it's cleared on unmount / next save — a bare
            // setTimeout here could setState after unmount.
            clearTimeout(saveStateTimerRef.current);
            saveStateTimerRef.current = setTimeout(() => setSaveState('idle'), 1800);
        } catch (error) {
            clearTimeout(saveStateTimerRef.current);
            setSaveState('idle');
            setTestResult({ success: false, message: error instanceof Error ? error.message : 'Provider settings could not be saved.' });
            return;
        }
    }, [selected, draftKey, draftUrl, draftFormat, draftModel, draftThinking, draftInputUsd, draftOutputUsd, draftCtxWindow, nameDraft, draftUrlValidation, onUpdateProvider]);

    const handleTestModel = useCallback(async (modelId: string): Promise<{ success: boolean; message: string }> => {
        if (!selected || !draftUrlValidation.valid) {
            const failed = { success: false, message: 'Fix the base URL before testing a model.' };
            setModelTests(prev => ({ ...prev, [modelId]: { ok: false, message: failed.message } }));
            return failed;
        }
        setTestingModelId(modelId);
        try {
            const result = await testConnection({
                ...selected,
                apiKey: draftKey.trim(),
                baseUrl: draftUrlValidation.normalizedUrl,
                apiFormat: draftFormat,
                selectedModel: modelId,
            });
            setModelTests(prev => ({ ...prev, [modelId]: { ok: result.success, message: result.message } }));
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Connection test failed.';
            setModelTests(prev => ({ ...prev, [modelId]: { ok: false, message } }));
            return { success: false, message };
        } finally {
            setTestingModelId(current => current === modelId ? null : current);
        }
    }, [selected, draftKey, draftFormat, draftUrlValidation]);

    const handleTest = useCallback(async () => {
        if (!selected || !draftUrlValidation.valid || selected.models.length === 0) {
            setTestResult({ success: false, message: 'Add at least one model before testing.' });
            return;
        }
        setIsTesting(true);
        setTestResult(null);
        let passed = 0;
        let lastFail = '';
        for (const modelId of selected.models) {
            const result = await handleTestModel(modelId);
            if (result.success) passed += 1;
            else lastFail = result.message;
        }
        setTestResult({
            success: passed === selected.models.length,
            message: passed === selected.models.length
                ? `All ${selected.models.length} models replied OK`
                : `${passed}/${selected.models.length} models passed.${lastFail ? ` Last error: ${lastFail}` : ''}`,
        });
        setIsTesting(false);
        // P6: known-answer probe on the SELECTED model — behavior-proves the
        // reasoning knob (a 200 without the knob being honored is
        // indistinguishable from a stripped body at the provider side). The
        // result feeds the harness lesson store; failures never fail the test.
        if (passed > 0 && draftModel) {
            try {
                const probe = await probeAndLearn({
                    ...selected,
                    apiKey: draftKey.trim() || selected.apiKey,
                    baseUrl: draftUrlValidation.normalizedUrl,
                    apiFormat: draftFormat,
                    selectedModel: draftModel,
                });
                console.info(`[ProviderManager] wire probe (${draftModel}): route=${probe.audit.route} honored=${probe.honored} — ${probe.evidence}`);
            } catch { /* best-effort — the test result stands alone */ }
        }
    }, [selected, draftKey, draftFormat, draftModel, draftUrlValidation, handleTestModel]);

    const handleAddProvider = useCallback(async () => {
        if (!newName.trim() || !newUrlValidation.valid) return;
        const models = newModels.split(',').map(m => m.trim()).filter(Boolean);
        // No fake 'default-model' entries — a provider without models is
        // unusable and the user would have to discover/delete the stub row.
        if (models.length === 0) {
            setAddError('Add at least one model ID (comma-separated) before creating the provider.');
            return;
        }
        setAddError('');
        await onAddCustomProvider({
            name: newName.trim(),
            baseUrl: newUrl.trim(),
            apiKey: newKey.trim(),
            apiFormat: newFormat,
            models,
            selectedModel: models[0],
        });
        setNewName(''); setNewUrl(''); setNewKey(''); setNewFormat('chat_completions'); setNewModels('');
        setShowAddProvider(false);
    }, [newName, newUrl, newUrlValidation, newKey, newFormat, newModels, onAddCustomProvider]);

    const handleAddModelSubmit = useCallback(async () => {
        if (!selected || !newModelInput.trim()) return;
        const modelId = newModelInput.trim();
        if (onAddModel) {
            await onAddModel(selected.id, modelId);
        } else {
            const updatedModels = [...selected.models, modelId];
            await onUpdateProvider(selected.id, { models: updatedModels, selectedModel: selected.selectedModel || modelId });
        }
        setNewModelInput('');
        setShowAddModelInput(false);
    }, [selected, newModelInput, onAddModel, onUpdateProvider]);

    // Discover every model the provider exposes via /models and merge the
    // fresh ids into the model list (existing ids are kept untouched).
    const handleDiscoverModels = useCallback(async () => {
        if (!selected) return;
        setIsDiscovering(true);
        try {
            const catalog = await discoverProviderModelCatalog({
                baseUrl: draftUrl || selected.baseUrl,
                apiKey: draftKey || selected.apiKey,
                apiFormat: draftFormat || selected.apiFormat,
            });
            const discovered = catalog.ids;
            const freshModels = sortModelsFreeFirst(discovered);
            const isUnchanged = selected.models.length === freshModels.length && selected.models.every((m, idx) => m === freshModels[idx]);
            // Even when the id list is identical, the reported context windows
            // may be new — and they are what `utils/contextWindow` compaction
            // holds the outbound history to.
            const nextWindows = mergeModelContextWindows(selected.modelContextWindows, catalog.windows);
            const windowsChanged = !sameModelContextWindows(selected.modelContextWindows, nextWindows);
            if (isUnchanged && !windowsChanged) {
                toast.success('Models up to date', 'All models from this provider are already up to date.');
            } else {
                const updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>> = isUnchanged
                    ? {}
                    : { models: freshModels };
                if (selected.selectedModel && !freshModels.includes(selected.selectedModel)) {
                    updates.selectedModel = freshModels[0] || '';
                }
                if (windowsChanged) updates.modelContextWindows = nextWindows;
                await onUpdateProvider(selected.id, updates);
                const added = freshModels.filter(m => !selected.models.includes(m)).length;
                const removed = selected.models.filter(m => !freshModels.includes(m)).length;
                const details: string[] = [];
                if (added > 0) details.push(`+${added} new`);
                if (removed > 0) details.push(`-${removed} removed`);
                const summary = details.length > 0 ? ` (${details.join(', ')})` : '';
                toast.success('Models updated', `Catalog updated: ${freshModels.length} models active${summary}.`);
            }
        } catch (e) {
            console.error('[ProviderManager] Model discovery failed:', e);
            toast.error('Model discovery failed', e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsDiscovering(false);
        }
    }, [selected, draftUrl, draftKey, draftFormat, onUpdateProvider, toast]);

    // Discover models into the Add-Provider form's comma-separated field.
    const handleDiscoverNewModels = useCallback(async () => {
        setIsDiscoveringNew(true);
        try {
            const discovered = await discoverProviderModels({ baseUrl: newUrl, apiKey: newKey, apiFormat: newFormat });
            setNewModels(sortModelsFreeFirst(discovered).join(', '));
            setAddError('');
            toast.success('Models discovered', `${discovered.length} models found — review them, then create the provider.`);
        } catch (e) {
            console.error('[ProviderManager] Model discovery failed (new provider):', e);
            toast.error('Model discovery failed', e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsDiscoveringNew(false);
        }
    }, [newUrl, newKey, newFormat, toast]);

    const handleRemoveModelSubmit = useCallback(async (modelId: string) => {
        if (!selected) return;
        if (onRemoveModel) {
            await onRemoveModel(selected.id, modelId);
        } else {
            const updatedModels = selected.models.filter(m => m !== modelId);
            const newSelected = selected.selectedModel === modelId ? (updatedModels[0] || '') : selected.selectedModel;
            await onUpdateProvider(selected.id, { models: updatedModels, selectedModel: newSelected });
        }
    }, [selected, onRemoveModel, onUpdateProvider]);

    const handleUpdateModelSubmit = useCallback(async (oldModelId: string) => {
        if (!selected || !editModelInput.trim()) return;
        const trimmed = editModelInput.trim();
        if (onUpdateModel) {
            await onUpdateModel(selected.id, oldModelId, trimmed);
        } else {
            const updatedModels = selected.models.map(m => m === oldModelId ? trimmed : m);
            const newSelected = selected.selectedModel === oldModelId ? trimmed : selected.selectedModel;
            await onUpdateProvider(selected.id, { models: updatedModels, selectedModel: newSelected });
        }
        setEditingModelId(null);
        setEditModelInput('');
    }, [selected, editModelInput, onUpdateModel, onUpdateProvider]);

    const catalogRefreshed = useRef<Record<string, number>>({});
    // In-flight marker: refreshCatalog awaits onUpdateProvider, which changes
    // `configs` and re-fires the auto-refresh effect below WHILE the previous
    // sweep is still mid-await (catalogRefreshed only stamps on completion) —
    // without this guard, overlapping discover sweeps hammer the same
    // /models endpoint. A second call for a provider already refreshing is a
    // no-op; the running sweep is the refresh.
    const catalogInFlight = useRef<Set<string>>(new Set());
    const [catalogStatus, setCatalogStatus] = useState<string>('');

    const refreshCatalog = useCallback(async (cfg: ProviderConfig, silent: boolean): Promise<void> => {
        if (!cfg.apiKey.trim() || !cfg.baseUrl.trim()) return;
        if (catalogInFlight.current.has(cfg.id)) return;
        catalogInFlight.current.add(cfg.id);
        if (!silent) setCatalogStatus(`Updating ${cfg.name}…`);
        try {
            const catalog = await discoverProviderModelCatalog({
                baseUrl: cfg.baseUrl,
                apiKey: cfg.apiKey,
                apiFormat: cfg.apiFormat,
            });
            const discovered = catalog.ids;
            const freshModels = sortModelsFreeFirst(discovered);
            const selectedModel = freshModels.includes(cfg.selectedModel) ? cfg.selectedModel : (freshModels[0] || cfg.selectedModel);
            catalogRefreshed.current[cfg.id] = Date.now();
            const nextWindows = mergeModelContextWindows(cfg.modelContextWindows, catalog.windows);
            const windowsChanged = !sameModelContextWindows(cfg.modelContextWindows, nextWindows);
            if (freshModels.join('\0') !== cfg.models.join('\0') || selectedModel !== cfg.selectedModel || windowsChanged) {
                await onUpdateProvider(cfg.id, {
                    models: freshModels,
                    selectedModel,
                    ...(windowsChanged ? { modelContextWindows: nextWindows } : {}),
                });
            }
            if (!silent) setCatalogStatus(`Updated ${cfg.name} · ${freshModels.length} models`);
        } catch {
            if (!silent) setCatalogStatus(`Could not update ${cfg.name} — keeping the saved list.`);
        } finally {
            catalogInFlight.current.delete(cfg.id);
        }
    }, [onUpdateProvider]);

    useEffect(() => {
        let cancelled = false;
        const STALE_MS = 10 * 60 * 1000;
        const run = async (): Promise<void> => {
            for (const cfg of configs) {
                if (cancelled) return;
                if (!cfg.isEnabled || !cfg.apiKey.trim() || !cfg.baseUrl.trim()) continue;
                const last = catalogRefreshed.current[cfg.id] || 0;
                if (Date.now() - last < STALE_MS) continue;
                try {
                    await refreshCatalog(cfg, true);
                } catch {
                    /* keep the saved list */
                }
            }
        };
        void run();
        return () => { cancelled = true; };
    }, [configs, refreshCatalog]);

    const listedModels = selected ? sortModelsFreeFirst(selected.models) : [];

    return (
        <div className="space-y-4">
            {ConfirmDialogComponent}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-ui-xs font-medium uppercase tracking-[0.08em] text-zinc-500">
                    Providers{catalogStatus ? ` · ${catalogStatus}` : ''}
                </p>
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => { if (selected) void refreshCatalog(selected, false); }}
                        className="motion-press rounded-control border border-hairline p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                        title="Refresh model catalogs"
                        aria-label="Refresh model catalogs"
                    >
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => setShowAddProvider(true)}
                        className="motion-press rounded-control border border-hairline bg-zinc-100 px-2.5 py-1.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-zinc-200">
                        + Add provider
                    </button>
                </div>
            </div>

            <div className="grid min-h-[540px] w-full overflow-hidden rounded-card border border-hairline bg-zinc-900/40 md:grid-cols-[280px_minmax(0,1fr)]">
                <div className="flex flex-col border-b border-hairline p-3 md:border-b-0 md:border-r">
                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto custom-scrollbar">
                        {([
                            { title: 'Providers', items: configs.filter(c => c.isBuiltIn) },
                            { title: 'Custom providers', items: configs.filter(c => !c.isBuiltIn) },
                        ] as const).filter(section => section.title === 'Custom providers' || section.items.length > 0).map(section => (
                            <div key={section.title}>
                                <h5 className="mb-2 px-2 font-mono text-ui-xs font-medium uppercase tracking-[0.08em] text-zinc-500">{section.title}</h5>
                                <div className="motion-list divide-y divide-dashed divide-hairline">
                                    {section.items.map(c => {
                                        const isSelectedRow = selected?.id === c.id && !showAddProvider;
                                        const isReady = isProviderReady(c);
                                        return (
                                            <button
                                                key={c.id}
                                                onClick={() => { void selectProvider(c.id); }}
                                                className={`motion-press flex w-full items-center justify-between rounded-control px-2 py-2.5 text-left transition-colors ${
                                                    isSelectedRow ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                                                }`}
                                            >
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control border border-zinc-700/80 bg-zinc-950">
                                                        <Box className="h-3 w-3 text-zinc-400" aria-hidden="true" />
                                                    </span>
                                                    <span className="truncate text-ui-caption font-medium" title={c.name}>{c.name}</span>
                                                </span>
                                                <span className={` h-1.5 w-1.5 shrink-0 rounded-full ${isReady ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="mt-3 px-2 text-ui-2xs leading-relaxed text-zinc-600">
                        A green dot means the provider is enabled and has a key.
                    </p>
                </div>

                <div className="min-w-0 p-5">
                    {showAddProvider ? (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <h4 className="text-ui-base font-semibold text-zinc-100">Add provider</h4>
                                <button onClick={() => setShowAddProvider(false)} className="text-ui-sm text-zinc-500 hover:text-zinc-300">Cancel</button>
                            </div>
                            <div>
                                <FieldLabel>Provider Name</FieldLabel>
                                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Opencode Zen" className={inputBase} />
                            </div>
                            <div>
                                <FieldLabel>Base URI</FieldLabel>
                                <input type="text" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder={newFormat === 'google' ? GOOGLE_GEMINI_DEFAULT_BASE : 'https://opencode.ai/zen/v1'} className={inputBase} />
                                {!newUrlValidation.valid && newUrl.trim() && <p className="mt-1 text-ui-sm text-rose-300">{newUrlValidation.message}</p>}
                            </div>
                            <div>
                                <FieldLabel>Endpoint</FieldLabel>
                                <SelectMenu value={newFormat} onChange={(v) => {
                                    const next = v as ApiFormat;
                                    setNewFormat(next);
                                    if (next === 'google' && !newUrl.trim()) setNewUrl(GOOGLE_GEMINI_DEFAULT_BASE);
                                }} options={(Object.entries(API_FORMAT_LABELS) as [ApiFormat, string][]).map(([val, label]) => ({ value: val, label }))} aria-label="Endpoint format" triggerClassName={selectTriggerBase} />
                            </div>
                            <div>
                                <FieldLabel>API key</FieldLabel>
                                <input type="password" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={newFormat === 'google' ? 'AIza…' : 'sk-…'} className={inputBase} autoComplete="off" />
                            </div>
                            <div>
                                <FieldLabel>Model list (comma-separated)</FieldLabel>
                                <div className="flex gap-2">
                                    <input type="text" value={newModels} onChange={(e) => { setNewModels(e.target.value); setAddError(''); }} placeholder={newFormat === 'google' ? 'gemini-2.5-flash, gemini-2.5-pro' : 'deepseek-v4-flash-free, mimo-v2.5-free'} className={`${inputBase} min-w-0 flex-1`} />
                                    <button type="button" onClick={handleDiscoverNewModels} disabled={isDiscoveringNew || !newUrl.trim() || !newKey.trim()} className="shrink-0 rounded-control border border-zinc-700 px-3 text-ui-sm text-zinc-400 disabled:opacity-40">
                                        {isDiscoveringNew ? '…' : 'Discover'}
                                    </button>
                                </div>
                                {addError && <p className="mt-1 text-ui-sm text-rose-300">{addError}</p>}
                            </div>
                            <button onClick={handleAddProvider} disabled={!newName.trim() || !newUrlValidation.valid} className="w-full rounded-control bg-zinc-100 py-2 text-ui-sm font-bold text-zinc-950 disabled:opacity-40">
                                Create provider
                            </button>
                        </div>
                    ) : selected ? (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    {isEditingName ? (
                                        <>
                                            <input type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-ui-base font-semibold text-zinc-100 focus:outline-none" autoFocus />
                                            <button onClick={() => setIsEditingName(false)} className="text-ui-sm text-zinc-400">Done</button>
                                        </>
                                    ) : (
                                        <>
                                            <h3 className="truncate text-ui-lede font-semibold text-zinc-100" title={nameDraft.trim() || selected.name}>{nameDraft.trim() || selected.name}</h3>
                                            <button onClick={() => setIsEditingName(true)} className="p-1 text-zinc-500 hover:text-zinc-200" title="Edit name" aria-label="Edit provider name">
                                                <Pencil className="h-3 w-3" aria-hidden="true" />
                                            </button>
                                        </>
                                    )}
                                    <div className=" ml-1 flex items-center gap-1">
                                        <span className={`rounded-control px-2 py-0.5 text-ui-dense font-semibold ${selected.isEnabled ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-800 text-zinc-400'}`}>
                                            {selected.isEnabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                        <button type="button" onClick={() => { void onToggleProvider(selected.id); }} className="rounded-control px-2 py-0.5 text-ui-dense text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                                            {selected.isEnabled ? 'Disable' : 'Enable'}
                                        </button>
                                    </div>
                                </div>
                                <button
                                    disabled={selected.isBuiltIn}
                                    onClick={async () => {
                                        if (selected.isBuiltIn) return;
                                        const ok = await confirm({
                                            title: `Delete ${selected.name}?`,
                                            message: 'This removes the provider, its API key, and its models. Analyses already logged are unaffected.',
                                            confirmLabel: 'Delete',
                                        });
                                        if (!ok) return;
                                        onRemoveProvider(selected.id);
                                        resetProviderHealth(selected.id);
                                        const remaining = configs.filter(c => c.id !== selected.id);
                                        if (remaining.length > 0) setSelectedId(remaining[0].id);
                                    }}
                                    className="motion-press rounded-control border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-30"
                                    title={selected.isBuiltIn ? 'Built-in providers cannot be deleted' : 'Delete provider'}
                                    aria-label={selected.isBuiltIn ? 'Built-in providers cannot be deleted' : `Delete provider ${selected.name}`}
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                </button>
                            </div>

                            {/* Live health (plan read side): the
                                per-provider telemetry GenericProviderService
                                already feeds — last error, latency, rate
                                limits, and the roster-cooldown bench state.
                                In-memory by design: it reflects THIS
                                session's runs. */}
                            <ProviderHealthBlock providerId={selected.id} />

                            <div>
                                <FieldLabel>Base URI</FieldLabel>
                                <input type="text" value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder={draftFormat === 'google' ? GOOGLE_GEMINI_DEFAULT_BASE : 'https://opencode.ai/zen/v1'} className={inputBase} />
                                {!draftUrlValidation.valid && draftUrl.trim() && <p className="mt-1 text-ui-sm text-rose-300">{draftUrlValidation.message}</p>}
                            </div>
                            <div>
                                <FieldLabel>Endpoint</FieldLabel>
                                <SelectMenu value={draftFormat} onChange={(v) => {
                                    const next = v as ApiFormat;
                                    setDraftFormat(next);
                                    if (next === 'google' && !draftUrl.trim()) setDraftUrl(GOOGLE_GEMINI_DEFAULT_BASE);
                                }} options={(Object.entries(API_FORMAT_LABELS) as [ApiFormat, string][]).map(([val, label]) => ({ value: val, label }))} aria-label="Endpoint format" triggerClassName={selectTriggerBase} />
                            </div>
                            <div>
                                <FieldLabel>API key</FieldLabel>
                                <div className="relative">
                                    <input type={showKey ? 'text' : 'password'} value={draftKey} onChange={(e) => setDraftKey(e.target.value)} placeholder="••••••••••••••••••••••••••••••••" className={`${inputBase} pr-10`} autoComplete="off" />
                                    <button onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300" title={showKey ? 'Hide key' : 'Show key'} aria-label={showKey ? 'Hide API key' : 'Show API key'}>
                                        {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                                    </button>
                                </div>
                            </div>
                            {draftFormat === 'messages' && (
                                <div>
                                    <FieldLabel>Extended thinking</FieldLabel>
                                    <SelectMenu
                                        value={draftThinking}
                                        onChange={(v) => setDraftThinking(v as 'auto' | 'on' | 'off')}
                                        options={[
                                            { value: 'auto', label: 'Auto-detect from model id' },
                                            { value: 'on', label: 'Always request thinking budget' },
                                            { value: 'off', label: 'Never request thinking' },
                                        ]}
                                        aria-label="Extended thinking"
                                        triggerClassName={selectTriggerBase}
                                    />
                                    <p className="mt-1 text-ui-dense leading-relaxed text-zinc-500">
                                        Auto-detect matches known Claude thinking models; force it on if your endpoint
                                        supports thinking on a model the detection misses, or off if the extra
                                        request field causes errors.
                                    </p>
                                </div>
                            )}

                            <div>
                                <FieldLabel>Model list</FieldLabel>
                                <div className="motion-list max-h-[320px] min-h-[168px] divide-y divide-dashed divide-hairline overflow-y-auto custom-scrollbar">
                                    {listedModels.map((m) => {
                                        const isSelectedModel = draftModel === m;
                                        const isEditingThis = editingModelId === m;
                                        const badgeText = getContextBadge(m);
                                        const modelTest = modelTests[m];
                                        const isTestingThis = testingModelId === m;
                                        return (
                                            <div key={m} className="space-y-1 py-1.5">
                                            <div
                                                className={`flex h-[48px] items-center rounded-control px-3.5 ${
                                                    isSelectedModel ? 'bg-zinc-800 text-zinc-100' : 'bg-zinc-800/70 text-zinc-300 hover:bg-zinc-800'
                                                }`}
                                            >
                                                {isEditingThis ? (
                                                    <div className="flex min-w-0 flex-1 items-center gap-2" onClick={e => e.stopPropagation()}>
                                                        <input type="text" value={editModelInput} onChange={(e) => setEditModelInput(e.target.value)} className="w-full rounded-control border border-zinc-600 bg-zinc-950 px-2 py-1 font-mono text-ui-base text-zinc-100 focus:outline-none" autoFocus />
                                                        <button onClick={() => handleUpdateModelSubmit(m)} aria-label={`Confirm rename of model ${m}`} className="p-1 text-zinc-300 hover:text-white transition-colors"><Check className="h-3.5 w-3.5" aria-hidden="true" /></button>
                                                        <button onClick={() => setEditingModelId(null)} aria-label="Cancel rename" className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
                                                    </div>
                                                ) : (
                                                    <span className="min-w-0 flex-1 truncate font-mono text-ui-caption" title={m}>{m}</span>
                                                )}
                                                <div className="ml-4 flex shrink-0 items-center gap-2.5" onClick={e => e.stopPropagation()}>
                                                    <span className="font-mono text-ui-xs font-medium text-zinc-500">{badgeText}</span>
                                                    <ToggleSwitch
                                                        checked={isSelectedModel}
                                                        onChange={() => setDraftModel(m)}
                                                        label={`Use ${m} as the active model`}
                                                    />
                                                    <button type="button" onClick={() => void handleTestModel(m)} disabled={isTestingThis || isTesting || !draftUrlValidation.valid} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-40" title={modelTest?.message || `Test ${m}`} aria-label={modelTest?.message ? `Test ${m} — ${modelTest.message}` : `Test model ${m}`}>
                                                        {isTestingThis ? <LoadingIcon className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Zap className="h-3 w-3" aria-hidden="true" />}
                                                    </button>
                                                    <button onClick={() => { setEditingModelId(m); setEditModelInput(m); }} className="p-1 text-zinc-500 hover:text-zinc-200" title="Edit model ID" aria-label={`Edit model ID for ${m}`}>
                                                        <Pencil className="h-3 w-3" aria-hidden="true" />
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            const ok = await confirm({
                                                                title: `Remove model "${m}"?`,
                                                                message: 'The model id will be removed from this provider\'s list.',
                                                                confirmLabel: 'Remove',
                                                            });
                                                            if (ok) handleRemoveModelSubmit(m);
                                                        }}
                                                        className="p-1 text-zinc-500 hover:text-rose-400"
                                                        title="Remove model"
                                                        aria-label={`Remove model ${m}`}
                                                    >
                                                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                                                    </button>
                                                </div>
                                            </div>
                                            {isTestingThis && (
                                                <p className="px-3.5 text-ui-dense text-zinc-500">Testing…</p>
                                            )}
                                            {modelTest && !isTestingThis && modelTest.ok && (
                                                <p className=" px-3.5 text-ui-dense font-medium text-emerald-400">Connected!</p>
                                            )}
                                            {modelTest && !isTestingThis && !modelTest.ok && (
                                                <p className=" px-3.5 text-ui-dense leading-relaxed text-rose-400">{modelTest.message}</p>
                                            )}
                                            </div>
                                        );
                                    })}
                                </div>
                                {showAddModelInput ? (
                                    <div className="mt-2 flex gap-2">
                                        <input type="text" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddModelSubmit()} placeholder="model id" className={`${inputBase} flex-1`} autoFocus />
                                        <button onClick={handleAddModelSubmit} className="rounded-control bg-zinc-100 px-3 text-ui-sm font-bold text-zinc-950">Add</button>
                                        <button onClick={() => setShowAddModelInput(false)} className="rounded-control px-3 text-ui-sm text-zinc-500">Cancel</button>
                                    </div>
                                ) : (
                                    <button onClick={() => setShowAddModelInput(true)} className="mt-2 flex w-full items-center justify-center rounded-control border border-dashed border-zinc-700 py-2 text-ui-caption text-zinc-400 hover:border-zinc-500 hover:text-zinc-200">
                                        + Add model
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <p className="py-16 text-center text-ui-sm text-zinc-500">Select a provider or add one.</p>
                    )}
                </div>
            </div>

            {selected && !showAddProvider && (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={handleSave}
                            disabled={!isDirty || saveState === 'saving'}
                            className={`rounded-control px-4 py-2 text-ui-sm font-bold uppercase tracking-wider ${
                                saveState === 'saved'
                                    ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                                    : isDirty
                                        ? 'bg-zinc-100 text-zinc-950'
                                        : 'cursor-not-allowed border border-zinc-800 text-zinc-600'
                            }`}
                        >
                            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save'}
                        </button>
                        <button onClick={handleDiscoverModels} disabled={isDiscovering || !(draftUrl || selected.baseUrl).trim() || !(draftKey || selected.apiKey).trim()} className="rounded-control px-3 py-2 text-ui-sm text-zinc-500 hover:text-zinc-200 disabled:opacity-40">
                            {isDiscovering ? 'Discovering…' : 'Discover models'}
                        </button>
                        <button onClick={handleTest} disabled={isTesting || !draftUrlValidation.valid || selected.models.length === 0} className="rounded-control border border-zinc-700 px-3 py-2 text-ui-sm font-bold uppercase tracking-wider text-zinc-300 disabled:opacity-40">
                            {isTesting ? 'Testing…' : 'Test all'}
                        </button>
                    </div>
                    {testResult && (
                        <p className={`text-ui-sm ${testResult.success ? 'text-zinc-300' : 'text-rose-300'}`}>{testResult.message}</p>
                    )}
                    <details className="text-ui-dense text-zinc-500">
                        <summary className="cursor-pointer">Token pricing (optional)</summary>
                        <div className="mt-2 grid grid-cols-2 gap-3">
                            <input type="number" min="0" step="0.001" value={draftInputUsd} onChange={(e) => setDraftInputUsd(e.target.value)} placeholder="Input $/1k" className={inputBase} />
                            <input type="number" min="0" step="0.001" value={draftOutputUsd} onChange={(e) => setDraftOutputUsd(e.target.value)} placeholder="Output $/1k" className={inputBase} />
                        </div>
                    </details>
                    <details className="text-ui-dense text-zinc-500">
                        <summary className="cursor-pointer">Context window (optional)</summary>
                        <p className="mt-1 text-ui-sm text-zinc-500">
                            Model context window in tokens. It scales retrieved-memory budgets and it is the
                            ceiling a long turn is compacted to. Leave empty to use what this model reported
                            at discovery, or the 1,000,000 default when it reported nothing.
                        </p>
                        {(() => {
                            // What the app will ACTUALLY hold this provider to,
                            // and which evidence decided it. A number the trader
                            // did not type must not look like one they did.
                            const resolved = resolveContextWindow({
                                ...selected,
                                contextWindowTokens: draftCtxWindow.trim() && Number.isFinite(Number(draftCtxWindow))
                                    ? Number(draftCtxWindow)
                                    : selected.contextWindowTokens,
                            });
                            const reported = selected.modelContextWindows?.[selected.selectedModel];
                            return (
                                <p className="mt-1 text-ui-sm text-zinc-500" data-testid="provider-context-window-resolved">
                                    In use now: {resolved.tokens.toLocaleString()} tokens ({resolved.label}).
                                    {reported && resolved.source !== 'user'
                                        ? ` This model reported ${reported.toLocaleString()} at discovery.`
                                        : reported && resolved.source === 'user'
                                            ? ` Your entry overrides the ${reported.toLocaleString()} it reported.`
                                            : ' This model has never reported one.'}
                                </p>
                            );
                        })()}
                        <input type="number" min="1" step="1" value={draftCtxWindow} onChange={(e) => setDraftCtxWindow(e.target.value)} placeholder="1,000,000" className={`${inputBase} mt-2`} />
                    </details>
                </div>
            )}
        </div>
    );
};

export default React.memo(ProviderManager);
