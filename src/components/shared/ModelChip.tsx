/**
 * ModelChip — the composer's ONE model control: the trigger, and the merged
 * panel it anchors.
 *
 * It used to be two controls and a third somewhere else: this chip (an inline
 * absolute panel, provider-grouped, star-able) and `EffortChip` (a radio menu of
 * six tiers) sat on one footer row, while `ModelPicker` ran a portaled
 * two-column flyout in Settings. Two
 * implementations of one decision reading different stored values, and the
 * thinking tier separated from the model whose behaviour it changes — `low`
 * switches thinking OFF on the GLM and DeepSeek routes
 * (`services/providers/reasoningControls.ts`), so a tier you cannot see beside
 * the model is a tier you cannot reason about. `docs/plan/model-menu-redesign.md`
 * (E-51) is the ruling; the trigger now carries the tier (D-D) and lives in the
 * composer card (D-A), and `EffortChip` is deleted rather than kept in step.
 *
 * The panel body is `ModelMenu`; what stays here is the trigger's shape, the
 * stored-value writes, and the star list — and the testid `composer-model-chip`,
 * which two npm-scripted Playwright harnesses drive.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from './Icons';
import ModelMenu, { type ModelMenuAnchor } from './ModelMenu';
import { releaseEffortDial, retainEffortDial } from './effortDial';
import type { EffortChoice } from './effortScale';
import { effortChoiceOf } from './effortScale';
import type { ProviderConfig } from '../../types/provider';
import { formatModelDisplayName, isProviderReady } from '../../utils/providerUtils';

export interface ModelChipProps {
    providers: ProviderConfig[];
    /** `"<providerId>::<modelId>"`, the same encoding both homes write. */
    value: string;
    onChange: (value: string) => void;
    onRefreshModels?: () => void | Promise<void>;
    /** Opens Settings → AI setup. Absent ⇒ the panel offers no such row, which
     *  is the honest option wherever the host cannot route there. */
    onManageProviders?: () => void;
    /** Why the chip warns: a stale or unusable pick. It surfaces in the chip's
     *  `title` only — the amber banner under the composer is a separate
     *  component (`ModelFallbackBanner`), not this control. */
    issue?: string | null;
    /** What to name the current pick when nothing in the ready list matches it. */
    fallbackLabel?: string;
    /** The session's stored tier — `'auto'` when the trader has never picked.
     *  Absent with `showEffort === false` (a bot turn) and the panel has no
     *  Effort section at all. */
    effort?: EffortChoice;
    onEffortChange?: (id: EffortChoice) => void;
    showEffort?: boolean;
    /** The dock's toolbar is 384px wide; the Agents surface's column is 880px.
     *  Same control, same label, two widths — the compact form truncates. */
    compact?: boolean;
}

const ModelChip: React.FC<ModelChipProps> = ({
    providers, value, onChange, onRefreshModels, onManageProviders, issue, fallbackLabel,
    effort, onEffortChange, showEffort = true, compact = false,
}) => {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<ModelMenuAnchor | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    // Ruling D-B: this composer is what makes `Ctrl/Cmd+Shift+E` legal. It
    // registers for as long as it SHOWS the tier — a panel session (`isPanel`
    // hides the chip) or a bot turn (`showEffort: false`) never registers, so
    // the chord cannot edit a value nothing reads back.
    useEffect(() => {
        if (!showEffort || !onEffortChange || !effort) return;
        retainEffortDial();
        return () => { releaseEffortDial(); };
    }, [showEffort, onEffortChange, effort]);

    const ready = providers.filter(isProviderReady);
    const pairId = value.split('::')[0];
    const modelId = value.split('::').slice(1).join('::');
    const provider = ready.find(p => p.id === pairId) ?? null;
    const modelLabel = provider && provider.models.includes(modelId)
        ? formatModelDisplayName(modelId)
        : null;
    const tierLabel = showEffort && effort ? effortChoiceOf(effort).label : null;
    // Ruling D-D: one value, one writer, and the tier is never behind a click.
    const selectedLabel = provider && modelLabel
        ? `${provider.name} · ${modelLabel}${tierLabel ? ` · ${tierLabel}` : ''}`
        : [fallbackLabel, tierLabel].filter(Boolean).join(' · ') || 'Select model';

    const toggle = (): void => {
        if (open) { setOpen(false); return; }
        const r = triggerRef.current?.getBoundingClientRect();
        if (!r) return;
        setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        setOpen(true);
    };

    return (
        <div className="relative min-w-0">
            <button type="button"
                ref={triggerRef}
                onClick={toggle}
                aria-label={`Model ${selectedLabel}`}
                aria-expanded={open} aria-haspopup="menu"
                title={issue ? 'Model fallback active — re-pick a model' : selectedLabel}
                data-testid="composer-model-chip"
                className={`flex items-center gap-1.5 rounded-control px-1.5 py-1 text-ui-dense text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 ${compact ? 'max-w-[13rem]' : 'max-w-[22rem] min-w-0'}`}>
                <span className="min-w-0 truncate" title={selectedLabel}>{selectedLabel}</span>
                <ChevronDown className={`h-2.5 w-2.5 shrink-0 transition-transform duration-150 ease-[var(--ease-snappy)] ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {open && anchor && (
                <ModelMenu
                    providers={providers}
                    value={value}
                    onChange={onChange}
                    effort={effort}
                    onEffortChange={onEffortChange}
                    showEffort={showEffort}
                    onRefreshModels={onRefreshModels}
                    onManageProviders={onManageProviders}
                    anchor={anchor}
                    onClose={() => setOpen(false)}
                    returnFocusTo={triggerRef.current}
                />
            )}
        </div>
    );
};

export default React.memo(ModelChip);
