/**
 * ModelPicker — the cascading provider + model flyout used by Settings, the
 * panel-seat picker (both since deleted — Settings is its only host).
 *
 * It used to be a SECOND implementation of the composer's model menu: its own
 * two-column hover flyout, its own "free models only" checkbox, no stars, no
 * capability badge, no arrow-key model. Both panels read the same stored
 * preference but presented it differently, so a trader who starred or narrowed
 * the list in one home saw a different list in the other (E-51 G-4). The body is
 * now `ModelMenu` — one panel, one keyboard model, one set of preferences — and
 * this component keeps only what a picker inside a form has to keep: the
 * trigger's display text, the value shape each `mode` speaks, and the
 * discovery-refresh state a Settings user needs to see.
 *
 * `mode` collapsed to two meanings (G-7). `provider-model` speaks
 * `"<providerId>::<modelId>"`; `model-only` is the same panel opened on the
 * provider that owns the stored model, writing the bare model id back. The old
 * `provider-only` mode had no render site anywhere in the app and is deleted —
 * a mode nobody can reach is vocabulary, not a capability.
 *
 * The flyout is portaled by `ModelMenu`, not rendered in place: a transformed or
 * backdrop-filtered ancestor (the Settings sheet has both) becomes the
 * containing block for `fixed` and misaligns the panel from its trigger.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ProviderConfig } from '../../types/provider';
import { formatModelDisplayName, isProviderReady, resolveProviderModelLabel } from '../../utils/providerUtils';
import { ChevronDownIcon } from './Icons';
import ModelMenu, { type ModelMenuAnchor } from './ModelMenu';

export type ModelPickerMode = 'provider-model' | 'model-only';

interface ModelPickerProps {
    /** All configured providers. */
    providers: ProviderConfig[];
    /** Current value. The format depends on `mode`:
     *  - provider-model: `"providerId::modelId"`, or a legacy bare `"modelId"`
     *  - model-only: `"modelId"`
     */
    value: string;
    /** Called when the user selects. Same format as `value`. */
    onChange: (value: string) => void;
    /** What to select. Default: 'provider-model'. */
    mode?: ModelPickerMode;
    /** Values to disable (grey out, not clickable). Used for deduplication. */
    disabledValues?: Set<string>;
    /** Show the "Manage providers" row at the foot of the provider panel. */
    onManageModels?: () => void;
    /** Triggers a fresh discovery of models from configured providers. */
    onRefreshModels?: () => Promise<void>;
    /** Trigger button label. If omitted, shows current selection text. */
    placeholder?: string;
    /** Extra CSS classes for the trigger button. */
    className?: string;
    /** Small variant for inline use. */
    compact?: boolean;
}

// The "ready provider" filter is the SHARED providerUtils.isProviderReady
// predicate — the same single source of truth the roster and the pipeline
// use. A local copy here previously diverged from it (readiness rules like
// keyless providers must be picked up by every surface at once), so it was
// deleted rather than re-synced.

const ModelPicker: React.FC<ModelPickerProps> = ({
    providers,
    value,
    onChange,
    mode = 'provider-model',
    disabledValues,
    onManageModels,
    placeholder = 'Select model',
    className = '',
    compact = false,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [anchor, setAnchor] = useState<ModelMenuAnchor | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const readyProviders = useMemo(() => providers.filter(isProviderReady), [providers]);

    /** The pair the panel highlights and opens on. `model-only` stores a bare
     *  model id, so the owning provider is looked up: the panel is
     *  providers-first, and an id no ready provider lists opens on the first one
     *  with nothing checked — the trigger's own label is what says so. */
    const pairValue = useMemo(() => {
        if (mode === 'provider-model') return value.includes('::') ? value : '';
        const owner = readyProviders.find(p => p.models.includes(value));
        return owner ? `${owner.id}::${value}` : '';
    }, [mode, value, readyProviders]);

    const handlePick = useCallback((pair: string): void => {
        const modelId = pair.split('::').slice(1).join('::');
        onChange(mode === 'model-only' ? modelId : pair);
        setIsOpen(false);
    }, [mode, onChange]);

    /** A stale or unusable stored pick says so instead of rendering a dead slug
     *  as though it would answer — the same honesty the composer's amber banner
     *  carries, in the one line a form field gets. */
    const displayText = useMemo((): string => {
        if (!value) return placeholder;
        if (mode === 'model-only' || !value.includes('::')) {
            const owner = readyProviders.find(p => p.models.includes(value));
            const label = owner ? resolveProviderModelLabel(owner, value) : (formatModelDisplayName(value) || value);
            return owner ? `${owner.name} · ${label}` : `${label} · unavailable`;
        }
        const [pid, ...rest] = value.split('::');
        const model = rest.join('::');
        const p = readyProviders.find(x => x.id === pid);
        if (!p) return `${formatModelDisplayName(model) || model} · unavailable`;
        return `${p.name} · ${resolveProviderModelLabel(p, model)}`;
    }, [value, mode, readyProviders, placeholder]);

    return (
        <div className={`relative inline-block ${className}`}>
            {/* Trigger — bare model name + chevron, no boxed chrome: it sits in
                form rows and panel headers, where a second border reads as a
                disabled field. */}
            <button
                ref={triggerRef}
                type="button"
                onClick={() => {
                    if (isOpen) { setIsOpen(false); return; }
                    const r = triggerRef.current?.getBoundingClientRect();
                    if (!r) return;
                    setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
                    setIsOpen(true);
                }}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={`Model: ${displayText}`}
                data-testid="model-picker-trigger"
                title={displayText}
                className={`flex items-center gap-1.5 rounded-control text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white ${
                    compact ? 'px-2 py-1 text-ui-dense' : 'px-2.5 py-1.5 text-ui-base font-medium'
                }`}
            >
                <span className="max-w-[180px] truncate" title={displayText}>{displayText}</span>
                <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>

            {isOpen && anchor && (
                <ModelMenu
                    providers={providers}
                    value={pairValue}
                    onChange={handlePick}
                    // The thinking tier belongs to a chat session, and a form
                    // field that picks a vision or memory model has no such row.
                    showEffort={false}
                    disabledValues={disabledValues}
                    onManageProviders={onManageModels}
                    anchor={anchor}
                    onClose={() => setIsOpen(false)}
                    returnFocusTo={triggerRef.current}
                />
            )}
        </div>
    );
};

export default React.memo(ModelPicker);
