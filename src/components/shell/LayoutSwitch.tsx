/**
 * LayoutSwitch — the [Desk | Chat] segmented pill, in both sizes it appears at.
 *
 * The owner's ruling (2026-11-17): a LAYOUT MODE of the one workspace, never a
 * second surface. Desk = chart + dock side by side; Chat hides the chart and
 * centers the stream. The segments route through `onSelectSurface` where the
 * caller has one (Desk selects the trade surface, Chat the agents surface —
 * the surface handler flips the layout to match), because with the icon strip
 * gone the pill IS the surface switch; `LayoutMiniToggle` in the collapsed
 * header bar flips the layout alone — a header has no surface router, and a
 * trader who collapsed the sidebar did not ask to change routes.
 *
 * Two truths live on one segment and both are honest: `aria-pressed` is the
 * LAYOUT in effect (Alt+D can desync it from the surface on the desk),
 * `aria-current` is the SURFACE the pill would land on. Alt+D toggles from
 * anywhere; the pill shows where you are.
 */
import React, { useSyncExternalStore } from 'react';
import {
    getWorkspaceLayout, setWorkspaceLayout, subscribeWorkspaceLayout, type WorkspaceLayout,
} from '../../utils/workspaceLayout';
import type { AppSurface } from '../../hooks/useSurface';

const SEGMENTS: ReadonlyArray<{
    layout: WorkspaceLayout;
    surface: AppSurface;
    label: string;
    short: string;
    title: string;
    /** Literal ids, not templates: a testid a probe or a contract pin can
     *  grep for is a testid that cannot drift by accident. */
    testId: string;
    miniTestId: string;
}> = [
    {
        layout: 'desk', surface: 'trade', label: 'Desk', short: 'D',
        title: 'Desk: Chart + AI copilot (Alt+D)',
        testId: 'layout-pill-desk', miniTestId: 'layout-pill-mini-desk',
    },
    {
        layout: 'chat', surface: 'agents', label: 'Chat', short: 'C',
        title: 'Chat: Focused conversation (Alt+D)',
        testId: 'layout-pill-chat', miniTestId: 'layout-pill-mini-chat',
    },
];

const useLayout = (): WorkspaceLayout =>
    useSyncExternalStore(subscribeWorkspaceLayout, getWorkspaceLayout, getWorkspaceLayout);

interface LayoutPillProps {
    surface: AppSurface;
    /** Present in the sidebar: a segment also lands its surface, so the pill
     *  is the one switcher the merged rail carries. */
    onSelectSurface?: (surface: AppSurface) => void;
    /** The surface the rail is currently showing (drives `aria-current`). */
}

export const LayoutPill: React.FC<LayoutPillProps> = ({ surface, onSelectSurface }) => {
    const layout = useLayout();
    return (
        <div
            role="group"
            aria-label="Workspace layout"
            data-testid="layout-pill"
            className="flex items-center rounded-control bg-zinc-900/80 p-0.5"
        >
            {SEGMENTS.map((s) => (
                <button
                    key={s.layout}
                    type="button"
                    onClick={() => {
                        setWorkspaceLayout(s.layout);
                        onSelectSurface?.(s.surface);
                    }}
                    aria-pressed={layout === s.layout}
                    aria-current={surface === s.surface ? 'page' : undefined}
                    title={s.title}
                    data-testid={s.testId}
                    className={`flex h-6 items-center justify-center rounded-[6px] px-2 text-ui-2xs font-medium tracking-wide transition-colors ${
                        layout === s.layout
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                    {s.label}
                </button>
            ))}
        </div>
    );
};

export interface LayoutMiniToggleProps {
    surface?: AppSurface;
    onSelectSurface?: (surface: AppSurface) => void;
}

/** The collapsed sidebar's compact bar (beside `nav-rail-toggle-header`) and
 *  the unified Electron titlebar's layout pill: the same two segments at D/C. */
export const LayoutMiniToggle: React.FC<LayoutMiniToggleProps> = ({ surface, onSelectSurface }) => {
    const layout = useLayout();
    return (
        <div
            role="group"
            aria-label="Workspace layout"
            data-testid="layout-pill-mini"
            className="flex items-center rounded-control bg-zinc-900/80 p-0.5"
        >
            {SEGMENTS.map((s) => (
                <button
                    key={s.layout}
                    type="button"
                    onClick={() => {
                        setWorkspaceLayout(s.layout);
                        onSelectSurface?.(s.surface);
                    }}
                    aria-pressed={layout === s.layout}
                    aria-current={surface && surface === s.surface ? 'page' : undefined}
                    title={s.title}
                    data-testid={s.miniTestId}
                    className={`flex h-6 items-center justify-center rounded-[6px] px-2 text-ui-2xs font-medium tracking-wide transition-colors ${
                        layout === s.layout
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                    {s.label}
                </button>
            ))}
        </div>
    );
};
