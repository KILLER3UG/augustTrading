import React from 'react';
import SidebarToggle from './SidebarToggle';
import { LayoutMiniToggle } from './LayoutSwitch';
import UpdateButton from '../shared/UpdateButton';
import type { AppSurface } from '../../hooks/useSurface';

export interface TitleBarProps {
    surface: AppSurface;
    onSelectSurface: (surface: AppSurface) => void;
    navRailExpanded: boolean;
    onToggleNavRail: () => void;
}

/**
 * Unified single-row Electron desktop titlebar (`titleBarStyle: 'hidden'` +
 * `titleBarOverlay`). Replaces the stacked native Windows titlebar + second
 * collapsed-rail strip with one 36px monochrome bar hosting the sidebar
 * toggle, `[D | C]` layout switch, subtle brand mark, draggable window region,
 * and release-only update button cleanly clear of the native caption buttons.
 *
 * Returns `null` in standard browser/web mode.
 */
const TitleBar: React.FC<TitleBarProps> = ({
    surface,
    onSelectSurface,
    navRailExpanded,
    onToggleNavRail,
}) => {
    const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
    if (!isElectron) return null;

    return (
        <header
            data-testid="desktop-titlebar"
            className="titlebar-drag electron-titlebar-bar flex shrink-0 items-center gap-2 border-b border-hairline bg-zinc-950"
        >
            <div className="titlebar-no-drag flex shrink-0 items-center gap-1.5">
                <SidebarToggle expanded={navRailExpanded} onToggle={onToggleNavRail} />
                <LayoutMiniToggle surface={surface} onSelectSurface={onSelectSurface} />
                <span className="pointer-events-none select-none pl-1.5 text-ui-2xs font-medium tracking-wide text-zinc-500">
                    August Trading
                </span>
            </div>
            <div className="min-w-4 flex-1" aria-hidden="true" />
            <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
                <UpdateButton />
            </div>
        </header>
    );
};

export default React.memo(TitleBar);
