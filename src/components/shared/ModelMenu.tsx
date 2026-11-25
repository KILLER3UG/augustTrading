/**
 * ModelMenu — ONE panel for provider, model and thinking tier.
 *
 * Why it exists: the composer carried `ModelChip` (an inline absolute panel,
 * provider-grouped, star-able) and `EffortChip` (a radio menu of six tiers),
 * while Settings and the seat picker carried
 * `ModelPicker` (a portaled two-column flyout, free-filter, no stars). Two
 * implementations of one decision, reading different stored values, and the
 * tier separated from the model whose behaviour it changes — `low` switches
 * thinking OFF on the GLM and DeepSeek routes
 * (`services/providers/reasoningControls.ts`), so a tier you cannot see beside
 * the model is a tier you cannot reason about.
 * `docs/plan/model-menu-redesign.md` (E-51) rules on the shape; rulings D-A,
 * D-C and D-D are the owner's.
 *
 * Phase 1 of that plan extracts the panel and wires NOTHING to it, so this
 * file can be reviewed, tested and type-gated before any surface changes. The
 * trigger that mounts it arrives in Phase 2.
 *
 * Positioning: portaled to `document.body` and `fixed`, like `ModelPicker` and
 * `SelectMenu` already are, and clamped with the shared
 * `FLYOUT_VIEWPORT_MARGIN`. The trigger sits at the bottom of a composer card,
 * so the panel opens UPWARD and the provider panel opens to the RIGHT, flipping
 * to the left when the pair would overflow.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Check, ChevronRight, Search, StarIcon } from './Icons';
import StatusPill from '../ui/StatusPill';
import type { ProviderConfig } from '../../types/provider';
import {
    formatModelDisplayName,
    isProviderReady,
    readStarredModels,
    writeStarredModels,
} from '../../utils/providerUtils';
import { isVisionModel } from '../../utils/modelUtils';
import { FLYOUT_VIEWPORT_MARGIN } from './flyoutLayout';
import {
    EFFORT_CHOICES,
    effortAtIndex,
    effortChoiceOf,
    effortIndexOf,
    effortShortcutHint,
    type EffortChoice,
} from './effortScale';

const MAIN_W = 320;
const PROVIDER_W = 220;
const GAP = 4;
const MAX_H = 420;

/** The trigger's viewport rect, read once at open time. */
export interface ModelMenuAnchor {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export interface ModelMenuProps {
    providers: ProviderConfig[];
    /** `"<providerId>::<modelId>"` — the same encoding both composers write. */
    value: string;
    onChange: (value: string) => void;
    /** Absent, or `showEffort === false`, and the Effort section is NOT
     *  rendered: a bot turn answers on the bot's own config through a transport
     *  that never reads the dial, so offering to edit it would be a lie. */
    effort?: EffortChoice;
    onEffortChange?: (id: EffortChoice) => void;
    showEffort?: boolean;
    /** Values already taken elsewhere, greyed and un-clickable. The panel seat
     *  picker uses it so one model cannot be added to the compare twice. */
    disabledValues?: ReadonlySet<string>;
    /** The single destination for "I want to configure providers". Two rows
     *  (`New provider` + `Manage models`) would be one place written twice. */
    onManageProviders?: () => void;
    anchor: ModelMenuAnchor;
    onClose: () => void;
    /** Focus lands here when the panel closes. Without it, closing a menu
     *  that was opened by keyboard leaves focus on `document.body`. */
    returnFocusTo?: HTMLElement | null;
}

interface Pos { top: number; left: number; maxHeight: number; openUp: boolean }
interface ProviderPanelPos { top: number; left: number }

/** Open upward from the trigger, because the composer's card is at the bottom
 *  of the screen; fall back to downward when there is genuinely more room
 *  below (a panel docked to the top of a tall viewport). */
const computeUpward = (anchor: ModelMenuAnchor, h: number): Pos => {
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const spaceAbove = anchor.top - GAP - FLYOUT_VIEWPORT_MARGIN;
    const spaceBelow = viewportH - anchor.bottom - GAP - FLYOUT_VIEWPORT_MARGIN;
    const usedH = Math.min(h, MAX_H, Math.max(160, Math.max(spaceAbove, spaceBelow)));
    const openUp = spaceAbove >= Math.min(h, MAX_H) || spaceAbove >= spaceBelow;
    const top = openUp
        ? Math.max(FLYOUT_VIEWPORT_MARGIN, anchor.top - GAP - usedH)
        : Math.min(viewportH - FLYOUT_VIEWPORT_MARGIN - usedH, anchor.bottom + GAP);
    let left = anchor.left;
    if (left + MAIN_W > viewportW - FLYOUT_VIEWPORT_MARGIN) {
        left = Math.max(FLYOUT_VIEWPORT_MARGIN, viewportW - MAIN_W - FLYOUT_VIEWPORT_MARGIN);
    }
    return { top, left, maxHeight: usedH, openUp };
};

/** The provider panel sits to the RIGHT of the main panel and flips to the
 *  left when the pair would run off the edge. */
const computeProviderPanel = (main: Pos): ProviderPanelPos => {
    const viewportW = window.innerWidth;
    const right = main.left + MAIN_W + GAP;
    const flips = right + PROVIDER_W > viewportW - FLYOUT_VIEWPORT_MARGIN;
    return { top: main.top, left: flips ? Math.max(FLYOUT_VIEWPORT_MARGIN, main.left - PROVIDER_W - GAP) : right };
};

interface MenuRow {
    value: string; id: string; label: string; providerName: string;
    vision: boolean; starred: boolean; disabled: boolean;
    /** The model's reported context window, compact — `1M`, `200K` — or null
     *  when the provider published nothing (never a guessed number). */
    ctx: string | null;
}

const compactTokens = (tokens?: number): string | null => {
    if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return null;
    if (tokens >= 1_000_000) {
        const m = Math.round(tokens / 100_000) / 10;
        return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
    }
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
    return String(tokens);
};

/** A bogus bare `Free` catalog entry (an aggregator row with no model behind
 *  it) renders as a nameless row — refused here rather than drawn. */
const isBareFreeEntry = (modelId: string, label: string): boolean =>
    modelId.trim().toLowerCase() === 'free' || label.trim().toLowerCase() === 'free';

const buildRows = (input: {
    source: ProviderConfig[];
    q: string; searching: boolean;
    starred: string[]; disabledValues?: ReadonlySet<string>;
}): MenuRow[] => {
    const out: MenuRow[] = [];
    for (const p of input.source) {
        for (const m of p.models) {
            const pair = `${p.id}::${m}`;
            if (input.searching && !m.toLowerCase().includes(input.q)) continue;
            const label = formatModelDisplayName(m);
            if (isBareFreeEntry(m, label)) continue;
            out.push({
                value: pair,
                id: m,
                label,
                providerName: p.name,
                vision: isVisionModel(m),
                starred: input.starred.includes(pair),
                disabled: input.disabledValues?.has(pair) ?? false,
                ctx: compactTokens(p.modelContextWindows?.[m]),
            });
        }
    }
    return out.sort((a, b) => Number(b.starred) - Number(a.starred));
};

const ModelMenu: React.FC<ModelMenuProps> = ({
    providers, value, onChange, effort = 'auto', onEffortChange,
    showEffort = true, disabledValues,
    onManageProviders, anchor, onClose, returnFocusTo,
}) => {
    const readyProviders = useMemo(() => providers.filter(isProviderReady), [providers]);
    const [activeProviderId, setActiveProviderId] = useState<string>(() => {
        const fromValue = value.split('::')[0];
        return readyProviders.some(p => p.id === fromValue) ? fromValue : readyProviders[0]?.id ?? '';
    });
    const [providersOpen, setProvidersOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [starred, setStarred] = useState<string[]>(readStarredModels);
    const [pos, setPos] = useState<Pos>({ top: Math.max(FLYOUT_VIEWPORT_MARGIN, anchor.top - GAP - MAX_H), left: anchor.left, maxHeight: MAX_H, openUp: true });

    const mainRef = useRef<HTMLDivElement>(null);
    const providerRef = useRef<HTMLDivElement>(null);
    const sliderRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const prowRefs = useRef(new Map<string, HTMLButtonElement>());

    const activeProvider = readyProviders.find(p => p.id === activeProviderId) ?? readyProviders[0] ?? null;
    const q = query.trim().toLowerCase();
    const searching = q.length > 0;
    /** A query is a FLAT index over every model of every ready provider, not
     *  over the selected one: a search box that only answers for whichever
     *  provider the pointer happens to rest on is a filter wearing a search
     *  box's clothes. That is `ModelPicker`'s long-standing rule, and it is the
     *  reason the two pickers could not stay two implementations. */
    const rows = useMemo(() => buildRows({
        source: searching ? readyProviders : (activeProvider ? [activeProvider] : []),
        q, searching, starred, disabledValues,
    }), [readyProviders, activeProvider, searching, q, starred, disabledValues]);

    /** Starred models from EVERY ready provider, pinned into one compact top
     *  group — a frequent model is one click away without hunting the
     *  provider panel. Not built while searching: the flat index already
     *  ranks starred rows first. */
    const starredRows = useMemo<{ picked: MenuRow[]; main: MenuRow[] }>(() => {
        if (searching) return { picked: [], main: [] };
        const all = buildRows({
            source: readyProviders, q: '', searching: false, starred, disabledValues,
        });
        const picked = all.filter(r => r.starred);
        // The pinned group must not double-render a row the main list shows.
        const main = rows.filter(r => !picked.some(p => p.value === r.value));
        return { picked, main };
    }, [readyProviders, rows, searching, starred, disabledValues]);

    // Measure once with the panel's REAL height before the first paint, so the
    // upward flip is decided on pixels that exist, not on an estimate.
    // The anchor's NUMBERS are the deps, not the object: a parent that builds
    // its own rect each render would otherwise re-run this every render, and
    // `setPos` returning a fresh object each time is an infinite loop, not a
    // reposition. The identity check is what makes a repeat run a no-op.
    const aTop = anchor.top;
    const aBottom = anchor.bottom;
    const aLeft = anchor.left;
    useLayoutEffect(() => {
        const h = mainRef.current?.getBoundingClientRect().height ?? MAX_H;
        const next = computeUpward({ top: aTop, bottom: aBottom, left: aLeft, right: aLeft }, h);
        setPos(prev => (prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight && prev.openUp === next.openUp) ? prev : next);
    }, [aTop, aBottom, aLeft, rows.length, showEffort, effort]);

    // Focus enters the panel on open; it returns to the trigger on close.
    // The trigger arrives as a prop that is `null` on the render that first
    // mounts the panel (the parent reads it off its own ref), so the cleanup
    // must read the LATEST value, not the captured one — hence the sync effect
    // rather than a closure over `returnFocusTo`.
    const returnFocusRef = useRef<HTMLElement | null>(returnFocusTo);
    useEffect(() => { returnFocusRef.current = returnFocusTo; });

    // Ruling D-B: the hint printed beside the label names the chord App binds.
    // The registration that MAKES that chord legal lives in `ModelChip`, which
    // owns the dial for as long as a composer shows it — not here, where this
    // element exists only while the menu is open. See `effortDial.ts` for why a
    // panel seat or a bot turn must not answer to it.
    const shortcutHint = effortShortcutHint(
        typeof navigator === 'undefined' ? '' : `${navigator.userAgent} ${navigator.platform ?? ''}`,
    );
    useEffect(() => {
        const el = rows.length > 0
            ? rowRefs.current.get(value) ?? rowRefs.current.get(rows[0].value) ?? mainRef.current
            : mainRef.current;
        el?.focus();
        return () => { returnFocusRef.current?.focus(); };
        // Deliberately run on mount only: re-focusing on every row change would
        // fight the roving focus the arrow keys own.
    }, []);

    const close = useCallback((): void => { onClose(); }, [onClose]);

    // The panel is `fixed`, so anything that moves the page detaches it from
    // its trigger. Scrolling INSIDE the panel's own model list is not that
    // event, and is ignored — `ModelPicker` has honoured this distinction since
    // the flyout was portaled, and a panel that closes under its own scrollbar
    // cannot be read.
    useEffect(() => {
        const onScroll = (e: Event): void => {
            const t = e.target as Node | null;
            if (t && (mainRef.current?.contains(t) || providerRef.current?.contains(t))) return;
            onClose();
        };
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onClose);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    const focusRow = (target: string | null): void => {
        if (!target) return;
        rowRefs.current.get(target)?.focus();
    };

    const move = (delta: number): void => {
        if (rows.length === 0) return;
        const current = document.activeElement;
        const idx = rows.findIndex(r => r.value === (current as HTMLButtonElement | null)?.dataset?.rowValue);
        const next = rows[Math.min(Math.max((idx < 0 ? 0 : idx) + delta, 0), rows.length - 1)];
        focusRow(next.value);
    };

    const pick = (v: string): void => { onChange(v); close(); };

    const toggleStar = (v: string): void => {
        setStarred(prev => {
            const out = prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v];
            writeStarredModels(out);
            return out;
        });
    };

    const stepEffort = (delta: number): void => {
        if (!onEffortChange) return;
        onEffortChange(effortAtIndex(effortIndexOf(effort) + delta));
    };

    const onMainKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        // Contain Escape. Unhandled it bubbles to the app-level shortcut that
        // CANCELS A RUNNING ANALYSIS when the trader only meant to close a menu.
        e.stopPropagation();
        if (e.key === 'Escape') {
            if (providersOpen) setProvidersOpen(false);
            else close();
            return;
        }
        if (providersOpen) {
            // Left backs out of the inner panel; the outer list must not scroll
            // out from under it while it is open.
            if (e.key === 'ArrowLeft') { e.preventDefault(); setProvidersOpen(false); }
            return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
        if (e.key === 'Home') { e.preventDefault(); if (rows[0]) focusRow(rows[0].value); return; }
        if (e.key === 'End') { e.preventDefault(); const last = rows[rows.length - 1]; if (last) focusRow(last.value); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); setProvidersOpen(true); return; }
    };

    const onProviderPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        e.stopPropagation();
        if (e.key === 'Escape') { setProvidersOpen(false); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const ids = readyProviders.map(p => p.id);
        const current = document.activeElement as HTMLButtonElement | null;
        const idx = ids.indexOf(current?.dataset?.prow ?? '');
        const next = ids[Math.min(Math.max((idx < 0 ? 0 : idx) + (e.key === 'ArrowDown' ? 1 : -1), 0), ids.length - 1)];
        prowRefs.current.get(next)?.focus();
    };

    const providerPanelPos = computeProviderPanel(pos);
    const providerPanel = providersOpen && readyProviders.length > 0 ? (
        <div
            ref={providerRef}
            role="menu"
            aria-label="Provider"
            data-testid="model-menu-providers"
            onMouseDownCapture={(e) => e.stopPropagation()}
            onPointerDownCapture={(e) => e.stopPropagation()}
            onKeyDown={onProviderPanelKeyDown}
            style={{ top: providerPanelPos.top, left: providerPanelPos.left, width: PROVIDER_W }}
            className="fixed z-flyout rounded-xl border border-white/[0.08] bg-zinc-900/95 p-1 shadow-elevated backdrop-blur-md motion-popover-in"
        >
            <div className="custom-scrollbar max-h-64 overflow-y-auto">
                {readyProviders.map(p => (
                    <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === activeProviderId}
                        data-prow={p.id}
                        ref={el => { if (el) prowRefs.current.set(p.id, el); else prowRefs.current.delete(p.id); }}
                        title={`${p.name} — ${p.apiFormat}`}
                        onClick={() => { setActiveProviderId(p.id); setProvidersOpen(false); mainRef.current?.focus(); }}
                        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06]">
                        <Check className={`h-3 w-3 shrink-0 ${p.id === activeProviderId ? 'text-zinc-100' : 'opacity-0'}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
                        <span className="shrink-0 rounded-control border border-hairline px-1 text-ui-2xs uppercase tracking-wider text-zinc-500">API</span>
                    </button>
                ))}
            </div>
            {onManageProviders && (
                <button type="button" role="menuitem"
                    onClick={() => { onManageProviders(); close(); }}
                    className="mt-1 block w-full rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                    Manage providers
                </button>
            )}
        </div>
    ) : null;

    const renderRow = (row: MenuRow): React.ReactNode => (
        <div key={row.value} data-testid={`model-row-${row.value}`}
            className={`flex items-center gap-1 rounded-control py-0.5 pl-1 pr-1.5 transition-colors ${row.disabled ? '' : 'hover:bg-white/[0.06]'}`}>
            <button type="button" role="menuitemradio" aria-checked={row.value === value}
                data-row-value={row.value}
                ref={el => { if (el) rowRefs.current.set(row.value, el); else rowRefs.current.delete(row.value); }}
                disabled={row.disabled}
                onClick={() => pick(row.value)}
                title={searching ? `${row.label} · ${row.providerName}` : row.label}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-2 text-left text-ui-dense ${row.disabled ? 'cursor-not-allowed text-zinc-600' : 'text-zinc-300'}`}>
                <span className="min-w-0 truncate" title={row.label}>{row.label}</span>
                {searching && (
                    <span className="shrink-0 truncate text-ui-2xs text-zinc-600" title={row.providerName}>{row.providerName}</span>
                )}
            </button>
            {row.ctx && (
                <span className="shrink-0 font-mono text-ui-2xs tabular-nums text-zinc-600" title={`${row.ctx} context window`}>{row.ctx}</span>
            )}
            {row.vision && <StatusPill tone="info" kicker className="shrink-0 px-1 py-0 text-ui-2xs opacity-70">Vision</StatusPill>}
            <button type="button" onClick={() => toggleStar(row.value)}
                aria-label={row.starred ? `Unstar ${row.label}` : `Star ${row.label}`}
                aria-pressed={row.starred}
                className="shrink-0 rounded-full p-1 text-zinc-600 transition-colors hover:text-zinc-300">
                <StarIcon className={`h-3 w-3 ${row.starred ? 'text-zinc-300' : ''}`} fill={row.starred ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
            {/* ONE subtle, muted check for the active row — at the right edge,
                no leading opacity-0 gap on every other row. */}
            {row.value === value && (
                <Check className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            )}
        </div>
    );

    const visibleMain = searching ? rows : starredRows.main;
    const effortIdx = effortIndexOf(effort);
    const effortPct = (effortIdx / (EFFORT_CHOICES.length - 1)) * 100;
    return createPortal(
        <>
            {/* Backdrop: a menu you can leave only by picking an item is a trap. */}
            <div className="fixed inset-0 z-flyout" aria-hidden onClick={close} />
            <div
                ref={mainRef}
                role="menu"
                aria-label="Model and thinking effort"
                data-testid="model-menu"
                tabIndex={-1}
                /* The panel is portaled to `document.body`, so every click in it
                   is OUTSIDE the host that opened it. Modal and popover hosts
                   close on any document-level outside-mousedown, and without
                   these guards a seat picker would tear its own host down
                   mid-pick — the reason `ModelPicker` has carried this since the
                   flyout was portaled. */
                onMouseDownCapture={(e) => e.stopPropagation()}
                onPointerDownCapture={(e) => e.stopPropagation()}
                onKeyDown={onMainKeyDown}
                style={{ top: pos.top, left: pos.left, width: MAIN_W, maxHeight: pos.maxHeight }}
                className={`fixed z-flyout flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900/95 shadow-elevated backdrop-blur-md outline-none ${pos.openUp ? 'motion-popover-in' : 'motion-popover-down'}`}
            >
                <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={providersOpen}
                    data-testid="model-menu-provider-row"
                    onClick={() => setProvidersOpen(v => !v)}
                    title={`${activeProvider?.name ?? 'No provider'} — ${activeProvider?.apiFormat ?? ''}`}
                    className="flex shrink-0 items-center gap-2 border-b border-white/[0.05] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]">
                    <Box className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-zinc-100" title={activeProvider?.name ?? 'No ready provider'}>{activeProvider?.name ?? 'No ready provider'}</span>
                    <span className="shrink-0 rounded-control border border-hairline px-1 text-ui-2xs uppercase tracking-wider text-zinc-500">API</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden="true" />
                </button>

                {/* ONE row: the Models label, a borderless magnifier and the
                    inline search input. Separated by a hairline above the
                    scrolling viewport so rows never clip behind it. */}
                <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.05] px-3 py-2" data-testid="model-menu-search-bar">
                    <span className="shrink-0 text-ui-2xs font-bold uppercase tracking-widest text-zinc-600">Models</span>
                    {searching && (
                        <span className="shrink-0 text-ui-2xs tabular-nums text-zinc-500" data-testid="model-menu-count">
                            {rows.length}
                        </span>
                    )}
                    <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden="true" />
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={ev => setQuery(ev.target.value)}
                        onKeyDown={e => {
                            e.stopPropagation();
                            // Escape stops searching FIRST; a bare Escape with
                            // no query closes the panel, which is what the
                            // trader pressed it for.
                            if (e.key === 'Escape') {
                                if (query) setQuery('');
                                else close();
                            }
                        }}
                        placeholder="Search models…"
                        aria-label="Search models by name"
                        data-testid="model-picker-search"
                        className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-left text-ui-dense text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                    />
                </div>

                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
                    data-testid={searching ? 'model-picker-results' : 'model-menu-rows'}>
                    {!searching && starredRows.picked.length > 0 && (
                        <div className="pb-1">
                            <p className="ui-kicker px-2 pb-0.5 pt-1">Starred</p>
                            {starredRows.picked.map(renderRow)}
                        </div>
                    )}
                    {visibleMain.map(renderRow)}
                    {visibleMain.length === 0 && starredRows.picked.length === 0 && (
                        <p className="px-2 py-3 text-ui-dense text-zinc-600">
                            {searching
                                ? `No model matches “${query}”.`
                                : (activeProvider ? `No model on ${activeProvider.name}.` : 'No ready provider — add one in Settings.')}
                        </p>
                    )}
                </div>

                {showEffort && (
                    <div className="shrink-0 border-t border-hairline px-3 pb-3 pt-2" data-testid="model-menu-effort">
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="flex items-baseline gap-1.5">
                                <span className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-600">Effort</span>
                                <span className="text-ui-dense font-medium text-zinc-100">{effortChoiceOf(effort).label}</span>
                            </span>
                            <kbd className="shrink-0 rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-ui-2xs font-normal tracking-wide text-zinc-400">{shortcutHint}</kbd>
                        </div>
                        {/* One thick monochrome pill track: zinc-800 rail, a
                            zinc-600 fill, six clickable stop dots and a single
                            crisp zinc-100 thumb at effortIndexOf/5. The wrapper
                            keeps the slider's ARIA + keyboard contract — arrows
                            step, Home/End bind, Ctrl/Cmd+Shift+E stays aligned. */}
                        <div
                            ref={sliderRef}
                            role="slider"
                            tabIndex={0}
                            aria-label={`Thinking effort (${shortcutHint})`}
                            aria-valuemin={0}
                            aria-valuemax={EFFORT_CHOICES.length - 1}
                            aria-valuenow={effortIdx}
                            aria-valuetext={effortChoiceOf(effort).label}
                            data-testid="effort-slider"
                            onKeyDown={e => {
                                e.stopPropagation();
                                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); stepEffort(1); }
                                else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); stepEffort(-1); }
                                else if (e.key === 'Home') { e.preventDefault(); onEffortChange?.(EFFORT_CHOICES[0].id); }
                                else if (e.key === 'End') { e.preventDefault(); onEffortChange?.(EFFORT_CHOICES[EFFORT_CHOICES.length - 1].id); }
                                else if (e.key === 'Escape') { setProvidersOpen(false); close(); }
                            }}
                            className="relative mx-2.5 h-6 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                        >
                            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-zinc-800">
                                <div className="h-full rounded-full bg-zinc-600" style={{ width: `${effortPct}%` }} />
                            </div>
                            {EFFORT_CHOICES.map((c) => {
                                const i = effortIndexOf(c.id);
                                return (
                                    <button key={c.id} type="button" tabIndex={-1}
                                        aria-label={c.label} aria-pressed={effortIdx === i}
                                        onClick={() => onEffortChange?.(c.id)}
                                        className="absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus:outline-none"
                                        style={{ left: `${(i / (EFFORT_CHOICES.length - 1)) * 100}%` }}>
                                        <span className={`h-1.5 w-1.5 rounded-full ${i <= effortIdx ? 'bg-zinc-400' : 'bg-zinc-700'}`} aria-hidden="true" />
                                    </button>
                                );
                            })}
                            <div className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-100 shadow-md ring-2 ring-zinc-900"
                                style={{ left: `${effortPct}%` }} aria-hidden="true" />
                        </div>
                    </div>
                )}
            </div>
            {providerPanel}
        </>,
        document.body
    );
};

export default React.memo(ModelMenu);
