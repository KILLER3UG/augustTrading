/**
 * ChooseModelsModal — the ONE floating modal over the in-pane Provider Editor.
 *
 * Shows every model discovered from a provider's `/models` endpoint with
 * instant search, filtered `Select all (N)` toggle, capability filter pills
 * (`All · Checked · Free · Vision · Tools`), monochrome capability tags, and
 * non-destructive `Update list` merge.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CloseIcon, SearchIcon } from '../shared/Icons';
import type { ModelCatalogEntry } from '../../types/provider';
import {
    filterCatalogModalItems,
    type CatalogModalFilter,
} from '../../services/providers/modelCatalogCore';

export interface ChooseModelsModalProps {
    providerName: string;
    fetchedCatalog: readonly ModelCatalogEntry[];
    initialCheckedIds: readonly string[];
    onCancel: () => void;
    onUpdateList: (checkedIds: string[]) => void;
}

const FILTER_TABS: ReadonlyArray<{ id: CatalogModalFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'checked', label: 'Checked' },
    { id: 'free', label: 'Free' },
    { id: 'vision', label: 'Vision' },
    { id: 'tools', label: 'Tools' },
];

const formatCompactCtx = (tokens?: number): string | null => {
    if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return null;
    if (tokens >= 1_000_000) {
        const m = Math.round(tokens / 100_000) / 10;
        return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
    }
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
    return String(tokens);
};

export const ChooseModelsModal: React.FC<ChooseModelsModalProps> = ({
    providerName,
    fetchedCatalog,
    initialCheckedIds,
    onCancel,
    onUpdateList,
}) => {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<CatalogModalFilter>('all');
    const [checkedSet, setCheckedSet] = useState<Set<string>>(() => new Set(initialCheckedIds));
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [onCancel]);

    const visibleItems = useMemo(
        () => filterCatalogModalItems(fetchedCatalog, { query, filter, checkedSet }),
        [fetchedCatalog, query, filter, checkedSet],
    );

    const allVisibleChecked = visibleItems.length > 0 && visibleItems.every(item => checkedSet.has(item.id));

    const toggleOne = (id: string): void => {
        setCheckedSet(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAllVisible = (): void => {
        setCheckedSet(prev => {
            const next = new Set(prev);
            if (allVisibleChecked) {
                for (const item of visibleItems) next.delete(item.id);
            } else {
                for (const item of visibleItems) next.add(item.id);
            }
            return next;
        });
    };

    const handleCommit = (): void => {
        const ordered: string[] = [];
        const emitted = new Set<string>();
        // Keep existing order first, then catalog order for newly checked models.
        for (const id of initialCheckedIds) {
            if (checkedSet.has(id) && !emitted.has(id)) {
                emitted.add(id);
                ordered.push(id);
            }
        }
        for (const item of fetchedCatalog) {
            if (checkedSet.has(item.id) && !emitted.has(item.id)) {
                emitted.add(item.id);
                ordered.push(item.id);
            }
        }
        for (const id of checkedSet) {
            if (!emitted.has(id)) {
                emitted.add(id);
                ordered.push(id);
            }
        }
        onUpdateList(ordered);
    };

    return (
        <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/75 p-4"
            onClick={onCancel}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="choose-models-title"
                data-testid="choose-models-modal"
                onClick={e => e.stopPropagation()}
                className="flex max-h-[min(82vh,680px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-hairline bg-zinc-950 shadow-elevated"
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
                    <div className="min-w-0">
                        <h3 id="choose-models-title" className="text-ui-base font-semibold text-zinc-100">
                            Choose models{providerName ? ` · ${providerName}` : ''}
                        </h3>
                        <p className="mt-0.5 text-ui-dense text-zinc-400">
                            These are the models this provider has available. Checked models make up the list.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        aria-label="Close choose models modal"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                        <CloseIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                {/* Search + Select all + Filter pills */}
                <div className="space-y-2.5 border-b border-hairline bg-zinc-900/40 px-5 py-3">
                    <div className="flex items-center gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-hairline bg-zinc-950 px-2.5 py-1.5 focus-within:border-zinc-600">
                            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                            <input
                                ref={searchRef}
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Filter models by ID or display name…"
                                aria-label="Filter available models"
                                data-testid="choose-models-search"
                                className="w-full min-w-0 bg-transparent font-mono text-ui-dense text-zinc-100 placeholder-zinc-600 focus:outline-none"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={toggleSelectAllVisible}
                            disabled={visibleItems.length === 0}
                            data-testid="choose-models-select-all"
                            className="h-8 shrink-0 rounded-control border border-hairline bg-zinc-900 px-3 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                        >
                            {allVisibleChecked ? `Deselect all (${visibleItems.length})` : `Select all (${visibleItems.length})`}
                        </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Model capability filters">
                        {FILTER_TABS.map(tab => {
                            const active = filter === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    data-testid={`choose-models-filter-${tab.id}`}
                                    onClick={() => setFilter(tab.id)}
                                    className={`h-6 rounded-control border px-2.5 text-ui-2xs font-medium transition-colors ${
                                        active
                                            ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                                            : 'border-hairline bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                        <span className="ml-auto font-mono text-ui-2xs tabular-nums text-zinc-500">
                            {visibleItems.length} shown · {checkedSet.size} checked
                        </span>
                    </div>
                </div>

                {/* Scrollable checkbox list */}
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
                    {visibleItems.length === 0 ? (
                        <p className="px-3 py-8 text-center text-ui-dense text-zinc-500">
                            No available models match the current search or filter.
                        </p>
                    ) : (
                        <div className="space-y-0.5">
                            {visibleItems.map(item => {
                                const checked = checkedSet.has(item.id);
                                const ctxLabel = formatCompactCtx(item.contextWindow);
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={checked}
                                        data-testid={`choose-model-item-${item.id}`}
                                        onClick={() => toggleOne(item.id)}
                                        className={`flex min-h-[36px] w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition-colors ${
                                            checked
                                                ? 'bg-white/[0.06] text-zinc-100'
                                                : 'text-zinc-300 hover:bg-white/[0.04]'
                                        }`}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
                                                checked
                                                    ? 'border-zinc-200 bg-zinc-100 text-zinc-950'
                                                    : 'border-zinc-700 bg-zinc-950 text-transparent'
                                            }`}
                                        >
                                            <Check className="h-3 w-3" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-ui-dense font-medium text-zinc-100">
                                                {item.displayName || item.id}
                                            </span>
                                            {item.displayName && item.displayName !== item.id && (
                                                <span className="block truncate font-mono text-ui-2xs text-zinc-500">
                                                    {item.id}
                                                </span>
                                            )}
                                        </span>
                                        <span className="flex shrink-0 items-center gap-1">
                                            {ctxLabel && (
                                                <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs tabular-nums text-zinc-400">
                                                    {ctxLabel}
                                                </span>
                                            )}
                                            {item.inputTypes?.image && (
                                                <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-300">
                                                    Img
                                                </span>
                                            )}
                                            {item.supportsTools && (
                                                <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400">
                                                    Tools
                                                </span>
                                            )}
                                            {item.isFree && (
                                                <span className="rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-emerald-400">
                                                    Free
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-3 border-t border-hairline bg-zinc-900/40 px-5 py-3">
                    <span className="font-mono text-ui-2xs text-zinc-500">
                        Existing overrides are preserved for models that remain checked.
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="h-8 rounded-control border border-hairline bg-zinc-900 px-3 text-ui-dense font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleCommit}
                            data-testid="choose-models-update-btn"
                            className="h-8 rounded-control bg-zinc-100 px-3.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-white"
                        >
                            Update list ({checkedSet.size})
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ChooseModelsModal;
