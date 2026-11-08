/**
 * RightPanel — the shared shell every right-hand panel renders inside.
 *
 * It owns the chrome (tab capsules, drag handle), the two presentations, and
 * the hide-vs-close geometry, and nothing else. Panels pass their own content
 * as children and stay mounted: the hook decides whether the shell is `push`
 * or `fullscreen` and whether it is open, and this component never unmounts a
 * child to show a different one — a panel switched away from must keep its
 * draft.
 *
 * Width: this shell publishes the persisted width as the `--panel-w` custom
 * property and does NOT apply it — where the width lands is the surface's
 * layout decision (`w-[var(--panel-w)]` in the caller's className). A panel
 * inside a stacked mobile mode must be able to ignore it, and an expanded
 * panel must be able to override it, so an inline width here would fight both.
 *
 * Hidden (`isHidden`) means out of flow, not `display: none`: the box keeps
 * its pixel width and its scroll state, which is what preserves the scroll
 * offset and the composer layout for when the panel comes back. The caller's
 * container needs `position: relative` (or a positioned ancestor) for the
 * hidden box to anchor to.
 *
 * The capsules render only when there is more than one open panel. One panel
 * gets no strip at all: a tab bar with a single tab is furniture that tells the
 * user nothing and costs a row of height.
 */

import React from 'react';
import { X } from '../shared/Icons';
import type { RightPanelDock, RightPanelPresentation } from '../../hooks/useRightPanel';

interface RightPanelProps {
    presentation: RightPanelPresentation;
    isResizing: boolean;
    width: number;
    /** True while this specific panel is the visible one. */
    isActive: boolean;
    /** Hide, don't close: the children stay mounted, this just takes the box
     *  out of flow and makes it inert. */
    isHidden: boolean;
    docks: RightPanelDock[];
    openIds: string[];
    activeId: string | null;
    onSelectDock: (id: string) => void;
    onCloseDock: (id: string) => void;
    onResizeStart: (event: React.PointerEvent) => void;
    onResizeReset: () => void;
    /** Accessible name for the region; the visible tab strip is not enough. */
    label: string;
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    testId?: string;
}

const RightPanel: React.FC<RightPanelProps> = ({
    presentation, isResizing, width, isActive, isHidden,
    docks, openIds, activeId,
    onSelectDock, onCloseDock, onResizeStart, onResizeReset,
    label, children, className, style, testId,
}) => {
    const openDocks = docks.filter(d => openIds.includes(d.id));
    const showStrip = openDocks.length > 1;

    return (
        <aside
            data-testid={testId}
            data-presentation={presentation}
            data-active={isActive ? 'true' : 'false'}
            data-hidden={isHidden ? 'true' : 'false'}
            aria-label={label}
            aria-hidden={isHidden || undefined}
            inert={isHidden ? true : undefined}
            style={{
                '--panel-w': `${width}px`,
                ...style,
                ...(isHidden ? {
                    /* Out of flow at the SAME pixel width: the interior never
                     * reflows while hidden, so the scroll offset and the
                     * composer layout are exactly as they were. The explicit
                     * width is what keeps that true; `display: none` would
                     * destroy the scroll box (see the hide-vs-close tests). */
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    height: '100%',
                    width: `${width}px`,
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    zIndex: -1,
                } : null),
            } as React.CSSProperties}
            /* No transition while dragging: an easing width lags the pointer,
               which reads as a broken handle. Restored the moment it lands. */
            className={[
                presentation === 'fullscreen'
                    ? 'absolute inset-0 z-modal flex min-h-0 w-full flex-col bg-zinc-900'
                    : 'z-drawer flex min-h-0 shrink-0 flex-col',
                isResizing ? '' : 'transition-[width] duration-[150ms] ease-[var(--ease-snappy)]',
                className,
            ].filter(Boolean).join(' ')}
        >
            {showStrip && (
                <div
                    role="tablist"
                    aria-label={`${label} panels`}
                    data-testid="right-panel-tabs"
                    className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 pt-2"
                >
                    {openDocks.map(dock => {
                        const selected = dock.id === activeId;
                        return (
                            <span key={dock.id} className="flex items-center">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    onClick={() => onSelectDock(dock.id)}
                                    className={`rounded-t-md px-2.5 py-1.5 text-ui-dense transition-colors ${
                                        selected
                                            ? 'bg-white/[0.06] text-zinc-100'
                                            : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
                                    }`}
                                >
                                    {dock.label}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onCloseDock(dock.id)}
                                    aria-label={`Close ${dock.label}`}
                                    className="rounded-control p-1 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                                >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            {/* The handle is hidden when the panel is closed — there is nothing
                to resize — and in fullscreen, where there is no edge to drag. */}
            {!isHidden && presentation === 'push' && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${label}`}
                    onPointerDown={onResizeStart}
                    onDoubleClick={onResizeReset}
                    title="Drag to resize · double-click to reset"
                    /* The seam is a HAIRLINE, like every other separator in
                       the app. It was a filled strip with a border on BOTH
                       sides, which drew a little gutter between the chart and
                       the dock — and the chart side went flat in E-56, so the
                       two halves of one window no longer matched. The grab
                       target keeps its width; only the paint changes. */
                    className="hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center border-l border-hairline text-zinc-600 transition-colors hover:text-zinc-300 lg:flex"
                >
                    <span aria-hidden className="block h-6 w-px bg-current opacity-60" />
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </aside>
    );
};

export default React.memo(RightPanel);