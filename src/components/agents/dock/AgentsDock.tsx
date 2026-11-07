/**
 * AgentsDock — Dock V1 on the Chat surface.
 *
 * A vertical icon rail (screenshot 4's shape) beside a panel. The panel's
 * geometry, drag-resize, push/fullscreen presentation and persisted width all
 * come from the app's ONE right-panel contract (`hooks/useRightPanel.ts` +
 * `components/shell/RightPanel.tsx`) — the same one Trade and Learning use.
 *
 * Two modes, switchable and persisted:
 *   `all`    all four tabs are open; the capsule strip shows all of them.
 *   `single` one tab at a time; choosing another replaces it.
 *
 * Independent state: a view is mounted the first time it is opened and is
 * NEVER unmounted while the dock lives. Hiding/showing uses visibility +
 * `inert` (not display:none), so a chart keeps its measured size and a Files
 * filter keeps its text. Opening one tab therefore cannot reset another.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, BarChart3, FileText, Layers, LayoutGrid, Square, X } from '../../shared/Icons';
import RightPanel from '../../shell/RightPanel';
import { useRightPanel } from '../../../hooks/useRightPanel';
import { DOCK_TABS, readDockMode, writeDockMode, type DockMode, type DockTabId } from './dockModel';
import { ChartView, LiveView, EvidenceView, FilesView, type DockChartProps } from './AgentDockViews';

const WORKSPACE_DOCK = 'workspace';

const TAB_ICONS: Record<DockTabId, React.ReactNode> = {
    files: <FileText className="h-4 w-4" aria-hidden="true" />,
    chart: <BarChart3 className="h-4 w-4" aria-hidden="true" />,
    live: <Activity className="h-4 w-4" aria-hidden="true" />,
    evidence: <Layers className="h-4 w-4" aria-hidden="true" />,
};

export interface AgentsDockProps extends DockChartProps {
    isOpen: boolean;
    onClose: () => void;
}

const AgentsDock: React.FC<AgentsDockProps> = ({ isOpen, onClose, symbol, interval, onIntervalChange }) => {
    const panel = useRightPanel({
        surface: 'agents',
        defaultWidth: 460,
        minWidth: 340,
        maxWidth: 760,
        // Below 1024px there is no room for a pushed panel beside the centred
        // thread, so the shared contract switches to a fullscreen overlay.
        fullscreenBelow: 1024,
    });

    const [mode, setMode] = useState<DockMode>(readDockMode);
    const [openIds, setOpenIds] = useState<DockTabId[]>(() =>
        readDockMode() === 'all' ? DOCK_TABS.map(t => t.id) : ['files']);
    const [activeId, setActiveId] = useState<DockTabId>('files');
    const [mounted, setMounted] = useState<DockTabId[]>(() =>
        readDockMode() === 'all' ? DOCK_TABS.map(t => t.id) : ['files']);

    useEffect(() => {
        panel.register({ id: WORKSPACE_DOCK, label: 'Workspace' });
    }, [panel.register]);

    const switchMode = useCallback((next: DockMode): void => {
        setMode(next);
        writeDockMode(next);
        setOpenIds(prev => next === 'all' ? DOCK_TABS.map(t => t.id) : [activeId]);
        setMounted(prev => next === 'all'
            ? DOCK_TABS.map(t => t.id)
            : (prev.includes(activeId) ? prev : [...prev, activeId]));
    }, [activeId]);

    const selectTab = useCallback((id: DockTabId): void => {
        setMounted(prev => prev.includes(id) ? prev : [...prev, id]);
        setActiveId(id);
        setOpenIds(prev => {
            if (mode === 'single') return [id];
            return prev.includes(id) ? prev : [...prev, id];
        });
    }, [mode]);

    const closeTab = useCallback((id: DockTabId): void => {
        if (mode === 'single' || openIds.length <= 1) {
            onClose();
            return;
        }
        const next = openIds.filter(x => x !== id);
        setOpenIds(next);
        if (activeId === id) setActiveId(next[next.length - 1]);
    }, [mode, openIds, activeId, onClose]);

    const activeDef = DOCK_TABS.find(t => t.id === activeId) ?? DOCK_TABS[0];

    const renderView = (id: DockTabId): React.ReactNode => {
        switch (id) {
            case 'files': return <FilesView />;
            case 'chart': return <ChartView symbol={symbol} interval={interval} onIntervalChange={onIntervalChange} />;
            case 'live': return <LiveView symbol={symbol} interval={interval} onIntervalChange={onIntervalChange} />;
            case 'evidence': return <EvidenceView symbol={symbol} />;
            default: return null;
        }
    };

    return (
        <RightPanel
            presentation={panel.presentation}
            isResizing={panel.isResizing}
            width={panel.width}
            isActive={isOpen}
            isHidden={!isOpen}
            docks={[{ id: WORKSPACE_DOCK, label: 'Workspace' }]}
            openIds={[WORKSPACE_DOCK]}
            activeId={WORKSPACE_DOCK}
            onSelectDock={() => undefined}
            onCloseDock={onClose}
            onResizeStart={panel.startResize}
            onResizeReset={panel.resetWidth}
            label="Chat workspace"
            testId="agents-dock"
            className="border-l border-white/[0.06] bg-zinc-900 lg:w-[var(--panel-w)]"
        >
            <div className="flex min-h-0 flex-1">
                {/* Vertical icon rail — the active icon carries a filled state,
                    a ring and an ink mark, so it is unmistakable at 44px. */}
                <div role="tablist" aria-orientation="vertical" aria-label="Workspace views"
                    data-testid="agents-dock-rail"
                    className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] py-2">
                    {DOCK_TABS.map(tab => {
                        const active = activeId === tab.id;
                        return (
                            <button key={tab.id} type="button" role="tab"
                                aria-selected={active}
                                aria-label={tab.label}
                                title={tab.label}
                                data-testid={`dock-tab-${tab.id}`}
                                onClick={() => selectTab(tab.id)}
                                className={`motion-press relative flex h-9 w-9 items-center justify-center rounded-control transition-colors ${
                                    active
                                        ? 'bg-zinc-800 text-zinc-100 ring-1 ring-white/[0.09]'
                                        : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                                }`}>
                                {active && (
                                    <span aria-hidden="true"
                                        className="absolute -left-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-cyan-400" />
                                )}
                                {TAB_ICONS[tab.id]}
                            </button>
                        );
                    })}
                    <div className="mt-auto flex flex-col items-center gap-1 border-t border-white/[0.06] pt-2">
                        <button type="button" onClick={() => switchMode('all')}
                            aria-label="Open all tabs at once" aria-pressed={mode === 'all'}
                            title="All tabs open" data-testid="dock-mode-all"
                            className={`motion-press flex h-9 w-9 items-center justify-center rounded-control transition-colors ${
                                mode === 'all' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05]'
                            }`}>
                            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => switchMode('single')}
                            aria-label="Open one tab at a time" aria-pressed={mode === 'single'}
                            title="One tab at a time" data-testid="dock-mode-single"
                            className={`motion-press flex h-9 w-9 items-center justify-center rounded-control transition-colors ${
                                mode === 'single' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05]'
                            }`}>
                            <Square className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>

                {/* Panel */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <header className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-ui-sm font-medium text-zinc-200">{activeDef.label}</p>
                            <p className="truncate text-ui-2xs text-zinc-500">{activeDef.description}</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close workspace"
                            data-testid="dock-close"
                            className="motion-press rounded-control p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </header>

                    {/* Open tabs. Only the `all` mode has more than one, so a
                        single tab gets no strip — the icon rail already names it. */}
                    {openIds.length > 1 && (
                        <div role="tablist" aria-label="Open workspace tabs"
                            data-testid="dock-open-tabs"
                            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-2 py-1.5 custom-scrollbar">
                            {openIds.map(id => {
                                const def = DOCK_TABS.find(t => t.id === id);
                                if (!def) return null;
                                const active = id === activeId;
                                return (
                                    <span key={id} className={`flex shrink-0 items-center rounded-control transition-colors ${
                                        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.04]'
                                    }`}>
                                        <button type="button" role="tab" aria-selected={active}
                                            onClick={() => selectTab(id)}
                                            className="py-1 pl-2 pr-1 text-ui-dense">{def.label}</button>
                                        <button type="button" onClick={() => closeTab(id)}
                                            aria-label={`Close ${def.label} tab`}
                                            className="p-1.5 text-zinc-500 transition-colors hover:text-zinc-200">
                                            <X className="h-3 w-3" aria-hidden="true" />
                                        </button>
                                    </span>
                                );
                            })}
                        </div>
                    )}

                    <div className="relative min-h-0 flex-1">
                        {mounted.map(id => {
                            const visible = id === activeId && openIds.includes(id);
                            return (
                                <div key={id}
                                    data-testid={`dock-view-${id}`}
                                    data-active={visible ? 'true' : 'false'}
                                    inert={visible ? undefined : true}
                                    className={visible
                                        ? 'absolute inset-0 motion-tab'
                                        : 'pointer-events-none invisible absolute inset-0'}>
                                    {renderView(id)}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </RightPanel>
    );
};

export default React.memo(AgentsDock);
