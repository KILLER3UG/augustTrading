/**
 * shellChrome — the pieces of the old NavRail that are still live.
 *
 * The rail itself was deleted on 2026-10-28: no rendered or default-import caller
 * existed, and the update download it alone hosted had no other entry point. What
 * remains here is what OTHER files import — the three layout constants the shell
 * and the probes measure the sidebar with, and the account row the Agents surface's
 * sidebar carries once the rail is not rendered there.
 */
import React, { useState } from 'react';
import { Activity, AlertTriangleIcon, Inbox, Plus, Settings, SwitchUserIcon } from '../shared/Icons';
import Tip from '../ui/Tip';
import { useEscapeClose } from '../../hooks/useEscapeClose';
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

/** Exported because the shell column carries it on every surface — one account
 *  row per screen either way. The expanded row grew the Settings gear when the
 *  icon strip died (ruling 1.2), and it grew the shell's status pieces when the
 *  content bar died (ruling 1.3.1): the update control and the FAILED-save
 *  badge live where the trader already is, at the column's foot. Both are
 *  quiet at rest — a healthy write renders nothing, and so does Electron with
 *  nothing to say. */
export const AccountRow: React.FC<{
    expanded: boolean;
    activeUsername: string | null;
    onOpenSettings: () => void;
    /** The Activity drawer's opener. It used to ride the content bar's status
     *  cluster; the v3 bar is the title, the context and one live dot, so the
     *  drawer's only door moved to the account row at the column's foot. */
    onOpenActivity?: () => void;
    /** The profile write's state. Only ERROR speaks — a silent save error is
     *  data loss wearing a clean bar (the old header-save-failed chip). */
    saveStatus?: 'SAVED' | 'SAVING' | 'ERROR';
    /** Quick actions inside the bottom-left profile popover. */
    onNewChat?: () => void;
    onRunDoctor?: () => void;
    onSwitchProfile?: () => void;
}> = ({
    expanded,
    activeUsername,
    onOpenSettings,
    onOpenActivity,
    saveStatus = 'SAVED',
    onNewChat,
    onRunDoctor,
    onSwitchProfile,
}) => {
    const { isElectron } = useAutoUpdate();
    const updateDot = useUpdateStatusDot();
    const [menuOpen, setMenuOpen] = useState(false);
    useEscapeClose(menuOpen, () => setMenuOpen(false));

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
            className="relative flex shrink-0 flex-col gap-1 px-3 pb-2.5 pt-2"
        >
            {menuOpen && (
                <>
                    <div className="fixed inset-0 z-shield" aria-hidden onClick={() => setMenuOpen(false)} />
                    <div
                        data-testid="profile-quick-menu"
                        role="menu"
                        aria-label="Profile quick menu"
                        className="motion-popover-down absolute bottom-full left-2 right-2 z-shield mb-1.5 rounded-xl border border-white/[0.08] bg-zinc-900/95 p-1 shadow-elevated backdrop-blur-md"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => { setMenuOpen(false); onOpenSettings(); }}
                            className="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                        >
                            <span className="flex items-center gap-2">
                                <Settings className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                                Settings
                            </span>
                            <kbd className="font-mono text-ui-2xs text-zinc-500">Ctrl ,</kbd>
                        </button>
                        {onNewChat && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuOpen(false); onNewChat(); }}
                                className="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                            >
                                <span className="flex items-center gap-2">
                                    <Plus className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                                    New chat
                                </span>
                                {/* No printed chord: Ctrl+K opens the unified
                                    command bar now (New Chat is a command inside
                                    it), and a hint that did something else
                                    would be a lie. */}
                            </button>
                        )}
                        {onRunDoctor && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuOpen(false); onRunDoctor(); }}
                                className="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                            >
                                <span className="flex items-center gap-2">
                                    <Activity className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                                    Run /doctor
                                </span>
                            </button>
                        )}
                        {onSwitchProfile && (
                            <>
                                <div aria-hidden="true" className="my-1 h-px bg-white/[0.07]" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setMenuOpen(false); onSwitchProfile(); }}
                                    className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                                >
                                    <SwitchUserIcon className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                                    Switch profile
                                </button>
                            </>
                        )}
                    </div>
                </>
            )}
            {saveStatus === 'ERROR' && (
                <span role="status" aria-label="Save failed"
                    title="The profile could not be saved"
                    data-testid="header-save-failed"
                    className="flex items-center gap-1 self-start rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-ui-2xs font-medium text-rose-300">
                    <AlertTriangleIcon className="h-3 w-3" aria-hidden="true" /> Save failed
                </span>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    data-testid="profile-menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen(v => !v)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-1 -ml-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-zinc-400"
                >
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-caption text-zinc-300" data-testid="nav-account-name" title={activeUsername || 'No profile'}>{activeUsername || 'No profile'}</span>
                        <span className="block truncate text-ui-2xs text-zinc-600" title="Signed in · local-first">Signed in · local-first</span>
                    </span>
                </button>
                {onOpenActivity && (
                    <Tip label="Activity" shortcut="">
                        <button
                            type="button"
                            data-testid="nav-activity"
                            onClick={onOpenActivity}
                            aria-label="Activity"
                            className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
                        >
                            <Inbox className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </Tip>
                )}
                {onOpenSettings && (
                    <Tip label="Settings" shortcut="Ctrl+,">
                        <button
                            type="button"
                            data-testid="surface-switch-settings"
                            onClick={onOpenSettings}
                            aria-label="Settings — Journal, Learning, Skills, Memory · Ctrl+,"
                            className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
                        >
                            <Settings className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </Tip>
                )}
            </div>
        </div>
    );
};
