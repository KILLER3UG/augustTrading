/**
 * ChartToolRail — grouped matte-monochrome 38px left drawing rail for the Desk
 * chart (inspired by TradingView / OKX / Binance, zero glassmorphism).
 *
 * Three hairline-separated blocks:
 *  - Block 1: 6 grouped drawing categories (`Cursor`, `Lines`, `Fib & Rays`,
 *    `Zones & Shapes`, `Position & Risk`, `Annotations`), each showing its
 *    active tool icon + a subtle `▸` corner trigger opening a matte flyout
 *    with tool name, hotkey badge, and ★ star pin-to-Favorites toggle.
 *  - Block 2: Measure/Ruler (`Shift+Drag`), Magnet `▸` (`Off` / `Weak` /
 *    `Strong`, `Ctrl` flips), Stay-in-Drawing-Mode pin.
 *  - Block 3: Lock All Drawings, Visibility Eye `▸` (`Show All` / `Hide All` /
 *    `Hide AI Levels Only` / `Hide User Drawings Only`), Trash `▸` (`Clear AI`
 *    / `Clear User` / `Clear All`), bottom rail-collapse chevron (`Ctrl+Alt+D`).
 *
 * Strictly `zinc-*` chrome with semantic `emerald-*` / `rose-*` reserved for
 * Long / Short position icons (`check:palette` compliant).
 */

import React, { useMemo, useState } from 'react';
import {
    ArrowDown,
    ArrowRight,
    ArrowUp,
    ArrowUpRight,
    ChevronLeftIcon,
    Eraser,
    Eye,
    EyeOff,
    Grid3x3,
    Layers,
    Lock,
    Magnet,
    Minus,
    MousePointer2,
    Pencil,
    Pin,
    Ruler,
    Square,
    StarIcon,
    Trash2,
    TrendingUp,
    Type,
    Unlock,
} from '../shared/Icons';
import type { DrawTool } from '../../services/trade/chartDrawings';
import {
    CHART_RAIL_GROUPS,
    findCategoryForTool,
    type ChartRailCategory,
    type DrawingVisibilityScope,
    type MagnetMode,
} from '../../services/trade/chartDeckCore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

/** Rail width in px — dedicated flex column to the left of the chart canvas. */
export const CHART_RAIL_WIDTH = 38;

export const renderRailToolIcon = (tool: DrawTool): React.ReactNode => {
    switch (tool) {
        case 'cursor':
            return <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'trend':
            return <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'hline':
            return <Minus className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'hray':
            return <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'vline':
            return (
                <span className="inline-block h-3.5 w-px bg-current" aria-hidden="true" />
            );
        case 'channel':
            return <Layers className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'fib':
            return <Grid3x3 className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'ray':
            return <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'rect':
            return <Square className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'price_range':
            return <Ruler className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'long_position':
            return <ArrowUp className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />;
        case 'short_position':
            return <ArrowDown className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />;
        case 'brush':
            return <Pencil className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'text':
            return <Type className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'arrow':
            return <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'erase':
            return <Eraser className="h-3.5 w-3.5" aria-hidden="true" />;
        case 'measure':
            return <Ruler className="h-3.5 w-3.5" aria-hidden="true" />;
        default:
            return <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />;
    }
};

type OpenFlyout =
    | { kind: 'group'; category: ChartRailCategory; top: number; left: number }
    | { kind: 'magnet'; top: number; left: number }
    | { kind: 'visibility'; top: number; left: number }
    | { kind: 'trash'; top: number; left: number }
    | null;

const RailSep: React.FC = () => <span className="my-1 h-px w-5 shrink-0 bg-white/[0.06]" aria-hidden="true" />;

export interface ChartToolRailProps {
    tool: DrawTool;
    onSelectTool: (t: DrawTool) => void;
    /** Currently starred tools for the draggable Favorites micro-bar. */
    favorites: ReadonlyArray<DrawTool>;
    onToggleFavorite: (t: DrawTool) => void;
    /** Magnet snap mode (`off` | `weak` 12px | `strong` 36px; `Ctrl` flips). */
    magnetMode: MagnetMode;
    onMagnetModeChange: (mode: MagnetMode) => void;
    /** Keep the active drawing tool selected after placing a shape. */
    stayInDrawingMode: boolean;
    onToggleStayInDrawingMode: () => void;
    /** Global lock state across all drawings on the current chart. */
    allLocked: boolean;
    onToggleLockAll: () => void;
    /** Visibility scope across user + AI drawing layers. */
    visibilityScope: DrawingVisibilityScope;
    onVisibilityScopeChange: (scope: DrawingVisibilityScope) => void;
    /** Counts & destructive actions in the Trash flyout. */
    userDrawingCount: number;
    agentDrawingCount: number;
    onClearAgentDrawings?: () => void;
    onClearUserDrawings?: () => void;
    onClearAllDrawings?: () => void;
    /** Whether the left rail is collapsed (`Ctrl+Alt+D`). */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
}

export const ChartToolRail: React.FC<ChartToolRailProps> = ({
    tool,
    onSelectTool,
    favorites,
    onToggleFavorite,
    magnetMode,
    onMagnetModeChange,
    stayInDrawingMode,
    onToggleStayInDrawingMode,
    allLocked,
    onToggleLockAll,
    visibilityScope,
    onVisibilityScopeChange,
    userDrawingCount,
    agentDrawingCount,
    onClearAgentDrawings,
    onClearUserDrawings,
    onClearAllDrawings,
    collapsed = false,
    onToggleCollapsed,
}) => {
    const [openFlyout, setOpenFlyout] = useState<OpenFlyout>(null);
    const [lastToolByCategory, setLastToolByCategory] = useState<Record<ChartRailCategory, DrawTool>>(() => {
        const init = {} as Record<ChartRailCategory, DrawTool>;
        for (const g of CHART_RAIL_GROUPS) init[g.category] = g.defaultTool;
        return init;
    });

    useEscapeClose(openFlyout !== null, () => setOpenFlyout(null));

    const activeCategory = useMemo(() => findCategoryForTool(tool), [tool]);

    if (collapsed) return null;

    const anchorFor = (el: HTMLElement): { top: number; left: number } => {
        const rect = el.getBoundingClientRect();
        const maxTop = Math.max(8, window.innerHeight - 230);
        return {
            top: Math.max(8, Math.min(maxTop, Math.round(rect.top))),
            left: Math.round(rect.right + 4),
        };
    };

    const pickTool = (category: ChartRailCategory, nextTool: DrawTool): void => {
        setLastToolByCategory(prev => ({ ...prev, [category]: nextTool }));
        onSelectTool(nextTool);
        setOpenFlyout(null);
    };

    const hiddenActive = visibilityScope !== 'all';
    const totalDrawings = userDrawingCount + agentDrawingCount;

    return (
        <>
            <div
                data-testid="chart-tool-rail"
                role="toolbar"
                aria-label="Chart drawing tools"
                className="relative z-20 flex h-full w-[38px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden border-r border-hairline bg-zinc-950 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {/* Block 1: 6 Grouped Drawing Categories */}
                {CHART_RAIL_GROUPS.map(group => {
                    const groupTool = activeCategory === group.category
                        ? tool
                        : (lastToolByCategory[group.category] ?? group.defaultTool);
                    const def = group.tools.find(t => t.tool === groupTool) ?? group.tools[0];
                    const isActive = activeCategory === group.category;
                    const hasSubmenu = group.tools.length > 1;
                    const flyoutOpen = openFlyout?.kind === 'group' && openFlyout.category === group.category;

                    return (
                        <div key={group.category} className="group/slot relative flex h-7 w-7 shrink-0 items-center justify-center">
                            <button
                                type="button"
                                data-testid={def.testId}
                                title={def.title}
                                aria-label={def.title}
                                aria-pressed={isActive}
                                onClick={() => {
                                    setOpenFlyout(null);
                                    if (group.category === 'cursor') {
                                        onSelectTool('cursor');
                                    } else {
                                        onSelectTool(tool === def.tool ? 'cursor' : def.tool);
                                    }
                                }}
                                onContextMenu={(ev) => {
                                    if (!hasSubmenu) return;
                                    ev.preventDefault();
                                    const pos = anchorFor(ev.currentTarget);
                                    setOpenFlyout({ kind: 'group', category: group.category, ...pos });
                                }}
                                className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors ${
                                    isActive
                                        ? 'bg-white/[0.10] text-zinc-100'
                                        : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                                }`}
                            >
                                {renderRailToolIcon(def.tool)}
                            </button>
                            {hasSubmenu && (
                                <button
                                    type="button"
                                    data-testid={`rail-group-chevron-${group.category}`}
                                    aria-label={`More ${group.label} tools`}
                                    aria-expanded={flyoutOpen}
                                    title={`${group.label} tools`}
                                    onClick={(ev) => {
                                        ev.stopPropagation();
                                        if (flyoutOpen) {
                                            setOpenFlyout(null);
                                        } else {
                                            const pos = anchorFor(ev.currentTarget);
                                            setOpenFlyout({ kind: 'group', category: group.category, ...pos });
                                        }
                                    }}
                                    className="absolute bottom-0 right-0 flex h-2.5 w-2.5 items-center justify-center text-[7px] leading-none text-zinc-600 transition-colors hover:text-zinc-200"
                                >
                                    ▸
                                </button>
                            )}
                        </div>
                    );
                })}

                <RailSep />

                {/* Block 2: Measure/Ruler, Magnet ▸, Stay-in-Drawing-Mode */}
                <button
                    type="button"
                    data-testid="rail-tool-measure"
                    title="Measure / Ruler — Shift+Drag anywhere or drag to measure % / $ / bars"
                    aria-label="Measure / Ruler"
                    aria-pressed={tool === 'measure'}
                    onClick={() => {
                        setOpenFlyout(null);
                        onSelectTool(tool === 'measure' ? 'cursor' : 'measure');
                    }}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
                        tool === 'measure'
                            ? 'bg-white/[0.10] text-zinc-100'
                            : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                    }`}
                >
                    <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
                    <button
                        type="button"
                        data-testid="rail-magnet"
                        title={`Magnet: ${magnetMode.toUpperCase()} — snaps to OHLC (hold Ctrl to flip)`}
                        aria-label={`Magnet mode (${magnetMode})`}
                        aria-pressed={magnetMode !== 'off'}
                        onClick={() => {
                            setOpenFlyout(null);
                            onMagnetModeChange(magnetMode === 'off' ? 'weak' : magnetMode === 'weak' ? 'strong' : 'off');
                        }}
                        className={`relative flex h-7 w-7 items-center justify-center rounded-control transition-colors ${
                            magnetMode !== 'off'
                                ? 'bg-white/[0.10] text-zinc-100'
                                : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                        }`}
                    >
                        <Magnet className="h-3.5 w-3.5" aria-hidden="true" />
                        {magnetMode === 'strong' && (
                            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-zinc-200" aria-hidden="true" />
                        )}
                    </button>
                    <button
                        type="button"
                        data-testid="rail-magnet-chevron"
                        aria-label="Magnet mode options"
                        aria-expanded={openFlyout?.kind === 'magnet'}
                        onClick={(ev) => {
                            ev.stopPropagation();
                            if (openFlyout?.kind === 'magnet') setOpenFlyout(null);
                            else setOpenFlyout({ kind: 'magnet', ...anchorFor(ev.currentTarget) });
                        }}
                        className="absolute bottom-0 right-0 flex h-2.5 w-2.5 items-center justify-center text-[7px] leading-none text-zinc-600 hover:text-zinc-200"
                    >
                        ▸
                    </button>
                </div>

                <button
                    type="button"
                    data-testid="rail-stay-drawing"
                    title={stayInDrawingMode ? 'Stay in drawing mode: ON' : 'Stay in drawing mode: OFF (returns to cursor after placing)'}
                    aria-label="Stay in drawing mode"
                    aria-pressed={stayInDrawingMode}
                    onClick={onToggleStayInDrawingMode}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
                        stayInDrawingMode
                            ? 'bg-white/[0.10] text-zinc-100'
                            : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                    }`}
                >
                    <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <span className="flex-1" aria-hidden="true" />

                <RailSep />

                {/* Block 3: Lock All, Visibility Eye ▸, Trash ▸, Collapse Rail */}
                <button
                    type="button"
                    data-testid="rail-lock-all"
                    title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'}
                    aria-label={allLocked ? 'Unlock all drawings' : 'Lock all drawings'}
                    aria-pressed={allLocked}
                    onClick={onToggleLockAll}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
                        allLocked
                            ? 'bg-white/[0.10] text-zinc-100'
                            : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                    }`}
                >
                    {allLocked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>

                <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
                    <button
                        type="button"
                        data-testid="rail-toggle-hidden"
                        title={hiddenActive ? 'Show all drawings (Ctrl+Alt+H)' : 'Hide all drawings (Ctrl+Alt+H)'}
                        aria-label={hiddenActive ? 'Show all drawings' : 'Hide all drawings'}
                        aria-pressed={hiddenActive}
                        onClick={() => {
                            setOpenFlyout(null);
                            onVisibilityScopeChange(hiddenActive ? 'all' : 'hide_all');
                        }}
                        className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors ${
                            hiddenActive
                                ? 'bg-white/[0.10] text-zinc-100'
                                : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                        }`}
                    >
                        {hiddenActive ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                    <button
                        type="button"
                        data-testid="rail-visibility-chevron"
                        aria-label="Visibility layer options"
                        aria-expanded={openFlyout?.kind === 'visibility'}
                        onClick={(ev) => {
                            ev.stopPropagation();
                            if (openFlyout?.kind === 'visibility') setOpenFlyout(null);
                            else setOpenFlyout({ kind: 'visibility', ...anchorFor(ev.currentTarget) });
                        }}
                        className="absolute bottom-0 right-0 flex h-2.5 w-2.5 items-center justify-center text-[7px] leading-none text-zinc-600 hover:text-zinc-200"
                    >
                        ▸
                    </button>
                </div>

                <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
                    <button
                        type="button"
                        data-testid="rail-trash-menu"
                        title="Clear drawings…"
                        aria-label="Clear drawings options"
                        aria-expanded={openFlyout?.kind === 'trash'}
                        disabled={totalDrawings === 0}
                        onClick={(ev) => {
                            if (openFlyout?.kind === 'trash') setOpenFlyout(null);
                            else setOpenFlyout({ kind: 'trash', ...anchorFor(ev.currentTarget) });
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>

                {onToggleCollapsed && (
                    <button
                        type="button"
                        data-testid="rail-collapse-toggle"
                        title="Hide drawing rail (Ctrl+Alt+D)"
                        aria-label="Hide drawing rail"
                        onClick={() => {
                            setOpenFlyout(null);
                            onToggleCollapsed();
                        }}
                        className="flex h-6 w-7 shrink-0 items-center justify-center rounded-control text-zinc-600 transition-colors hover:bg-white/[0.05] hover:text-zinc-300"
                    >
                        <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                )}
            </div>

            {/* Matte flyout menus positioned cleanly outside the rail overflow */}
            {openFlyout && (
                <>
                    <div
                        className="fixed inset-0 z-shield"
                        aria-hidden="true"
                        onClick={() => setOpenFlyout(null)}
                    />
                    {openFlyout.kind === 'group' && (() => {
                        const grp = CHART_RAIL_GROUPS.find(g => g.category === openFlyout.category);
                        if (!grp) return null;
                        return (
                            <div
                                data-testid={`drawing-flyout-${grp.category}`}
                                role="menu"
                                style={{ top: openFlyout.top, left: openFlyout.left }}
                                className="fixed z-flyout w-52 rounded-lg border border-hairline bg-zinc-950 p-1 shadow-elevated"
                            >
                                <div className="px-2 py-1 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                    {grp.label}
                                </div>
                                {grp.tools.map(t => {
                                    const active = tool === t.tool;
                                    const starred = favorites.includes(t.tool);
                                    return (
                                        <div
                                            key={t.tool}
                                            className={`flex items-center gap-1 rounded-control pr-1 transition-colors ${
                                                active ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
                                            }`}
                                        >
                                            <button
                                                type="button"
                                                role="menuitem"
                                                data-testid={`flyout-tool-${t.tool}`}
                                                onClick={() => pickTool(grp.category, t.tool)}
                                                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-ui-dense"
                                            >
                                                <span className="shrink-0 text-zinc-400">{renderRailToolIcon(t.tool)}</span>
                                                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                                                {t.hotkey && (
                                                    <span className="shrink-0 font-mono text-ui-2xs text-zinc-600">{t.hotkey}</span>
                                                )}
                                            </button>
                                            {t.starrable && (
                                                <button
                                                    type="button"
                                                    data-testid={`rail-star-${t.tool}`}
                                                    title={starred ? 'Remove from favorites bar' : 'Pin to favorites bar'}
                                                    aria-label={starred ? `Unstar ${t.label}` : `Star ${t.label}`}
                                                    aria-pressed={starred}
                                                    onClick={(ev) => {
                                                        ev.stopPropagation();
                                                        onToggleFavorite(t.tool);
                                                    }}
                                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-control transition-colors ${
                                                        starred
                                                            ? 'text-zinc-100 hover:bg-white/[0.08]'
                                                            : 'text-zinc-600 hover:bg-white/[0.06] hover:text-zinc-300'
                                                    }`}
                                                >
                                                    <StarIcon
                                                        className={`h-3 w-3 ${starred ? 'fill-zinc-200 text-zinc-200' : ''}`}
                                                        aria-hidden="true"
                                                    />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}

                    {openFlyout.kind === 'magnet' && (
                        <div
                            data-testid="drawing-flyout-magnet"
                            role="menu"
                            style={{ top: openFlyout.top, left: openFlyout.left }}
                            className="fixed z-flyout w-48 rounded-lg border border-hairline bg-zinc-950 p-1 shadow-elevated"
                        >
                            <div className="px-2 py-1 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                Magnet (Ctrl flips)
                            </div>
                            {([
                                { mode: 'off', label: 'Off', hint: 'Free' },
                                { mode: 'weak', label: 'Weak Magnet', hint: '12px' },
                                { mode: 'strong', label: 'Strong Magnet', hint: '36px' },
                            ] as const).map(item => (
                                <button
                                    key={item.mode}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={magnetMode === item.mode}
                                    data-testid={`magnet-mode-${item.mode}`}
                                    onClick={() => {
                                        onMagnetModeChange(item.mode);
                                        setOpenFlyout(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense transition-colors ${
                                        magnetMode === item.mode
                                            ? 'bg-white/[0.08] text-zinc-100'
                                            : 'text-zinc-300 hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <span>{item.label}</span>
                                    <span className="font-mono text-ui-2xs text-zinc-500">{item.hint}</span>
                                </button>
                            ))}
                        </div>
                    )}

                    {openFlyout.kind === 'visibility' && (
                        <div
                            data-testid="drawing-flyout-visibility"
                            role="menu"
                            style={{ top: openFlyout.top, left: openFlyout.left }}
                            className="fixed z-flyout w-52 rounded-lg border border-hairline bg-zinc-950 p-1 shadow-elevated"
                        >
                            <div className="px-2 py-1 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                Drawing Visibility
                            </div>
                            {([
                                { scope: 'all', label: 'Show All Layers', hint: '' },
                                { scope: 'hide_all', label: 'Hide All', hint: 'Ctrl+Alt+H' },
                                { scope: 'hide_ai', label: 'Hide AI Levels Only', hint: '' },
                                { scope: 'hide_user', label: 'Hide User Drawings Only', hint: '' },
                            ] as const).map(item => (
                                <button
                                    key={item.scope}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={visibilityScope === item.scope}
                                    data-testid={`visibility-scope-${item.scope}`}
                                    onClick={() => {
                                        onVisibilityScopeChange(item.scope);
                                        setOpenFlyout(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense transition-colors ${
                                        visibilityScope === item.scope
                                            ? 'bg-white/[0.08] text-zinc-100'
                                            : 'text-zinc-300 hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <span>{item.label}</span>
                                    {item.hint && <span className="font-mono text-ui-2xs text-zinc-600">{item.hint}</span>}
                                </button>
                            ))}
                        </div>
                    )}

                    {openFlyout.kind === 'trash' && (
                        <div
                            data-testid="drawing-flyout-trash"
                            role="menu"
                            style={{ top: openFlyout.top, left: openFlyout.left }}
                            className="fixed z-flyout w-52 rounded-lg border border-hairline bg-zinc-950 p-1 shadow-elevated"
                        >
                            <div className="px-2 py-1 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                Clear Drawings
                            </div>
                            <button
                                type="button"
                                role="menuitem"
                                data-testid="rail-clear-ai"
                                disabled={agentDrawingCount === 0 || !onClearAgentDrawings}
                                onClick={() => {
                                    onClearAgentDrawings?.();
                                    setOpenFlyout(null);
                                }}
                                className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.05] disabled:opacity-30"
                            >
                                <span>Clear AI Levels</span>
                                <span className="font-mono text-ui-2xs text-zinc-500">{agentDrawingCount}</span>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                data-testid="rail-clear-user"
                                disabled={userDrawingCount === 0 || !onClearUserDrawings}
                                onClick={() => {
                                    onClearUserDrawings?.();
                                    setOpenFlyout(null);
                                }}
                                className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.05] disabled:opacity-30"
                            >
                                <span>Clear User Drawings</span>
                                <span className="font-mono text-ui-2xs text-zinc-500">{userDrawingCount}</span>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                data-testid="rail-clear-all"
                                disabled={totalDrawings === 0 || !onClearAllDrawings}
                                onClick={() => {
                                    onClearAllDrawings?.();
                                    setOpenFlyout(null);
                                }}
                                className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-ui-dense text-rose-400 transition-colors hover:bg-rose-500/10 disabled:opacity-30"
                            >
                                <span>Clear All</span>
                                <span className="font-mono text-ui-2xs">{totalDrawings}</span>
                            </button>
                        </div>
                    )}
                </>
            )}
        </>
    );
};
