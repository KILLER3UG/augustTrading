/**
 * shellChrome — the pieces of the old NavRail that are still live.
 *
 * The rail itself was deleted on 2026-10-28: no rendered or default-import caller
 * existed, and the update download it alone hosted had no other entry point. What
 * remains here is what OTHER files import — the three layout constants the shell
 * and the probes measure the sidebar with, and the account row the Agents surface's
 * sidebar carries once the rail is not rendered there.
 */
import React from 'react';
import { Settings, Inbox } from '../shared/Icons';
import Tip from '../ui/Tip';
import { useUpdateStatusDot } from '../shared/UpdateButton';
import { useAutoUpdate } from '../../hooks/useAutoUpdate';

/** The collapsed column is 0px: the rail leaves the layout entirely and its
 *  expand affordance lives in the header (nav-rail-toggle-header). */
export const NAV_RAIL_COLLAPSED_PX = 0;
/** 240px (was 280): the redesign plan §2.1 — the reference rail is dense with
 *  value; 280px of mostly-empty column cost the chart 19% of a 1440 viewport. */
export const NAV_RAIL_EXPANDED_PX = 240;
/** Below this the rail is hidden whatever the user last chose — there is no
 *  room for a 280px panel beside a trade chart, and Electron's floor is
 *  minWidth 800. The choice is applied at render time, not written back, so
 *  widening the window restores what the user actually picked. */
export const NAV_RAIL_AUTO_COLLAPSE_PX = 1024;

/** Exported because the Agents surface's single sidebar carries it once the rail is
 *  not rendered there — one account row per screen either way. */
export const AccountRow: React.FC<{
    expanded: boolean;
    activeUsername: string | null;
    onOpenSettings: () => void;
    /** The Activity drawer's opener. It used to ride the content bar's status
     *  cluster; the v3 bar is the title, the context and one live dot, so the
     *  drawer's only door moved to the account row at the column's foot. */
    onOpenActivity?: () => void;
}> = ({ expanded, activeUsername, onOpenSettings, onOpenActivity }) => {
    const { isElectron } = useAutoUpdate();
    const updateDot = useUpdateStatusDot();

    if (!expanded) {
        return (
            <div className="flex flex-col items-center gap-1 px-1.5 pb-2 pt-1.5">
                {isElectron && updateDot && <span data-testid="nav-update-dot">{updateDot}</span>}
                <Tip label="Settings" shortcut="Ctrl+,">
                    <button
                        type="button"
                        data-testid="nav-settings"
                        onClick={onOpenSettings}
                        aria-label="Settings"
                        className="flex h-9 w-9 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
                    >
                        <Settings className="h-4 w-4" aria-hidden="true" />
                    </button>
                </Tip>
            </div>
        );
    }

    return (
        <div
            data-testid="nav-account"
            className="flex shrink-0 items-center gap-2 border-t border-white/[0.06] px-3 py-2.5"
        >
            <div
                className="flex min-w-0 flex-1 items-center gap-2 rounded-control py-0.5"
            >
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-caption text-zinc-300" data-testid="nav-account-name" title={activeUsername || 'No profile'}>{activeUsername || 'No profile'}</span>
                    <span className="block truncate text-ui-2xs text-zinc-600" title="Signed in · local-first">Signed in · local-first</span>
                </span>
            </div>
            {onOpenActivity && (
                <Tip label="Activity" shortcut="">
                    <button
                        type="button"
                        data-testid="nav-activity"
                        onClick={onOpenActivity}
                        aria-label="Activity — skill audits"
                        className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
                    >
                        <Inbox className="h-4 w-4" aria-hidden="true" />
                    </button>
                </Tip>
            )}
            <Tip label="Settings" shortcut="Ctrl+,">
                <button
                    type="button"
                    data-testid="nav-settings"
                    onClick={onOpenSettings}
                    aria-label="Settings"
                    className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
                >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                </button>
            </Tip>
        </div>
    );
};
