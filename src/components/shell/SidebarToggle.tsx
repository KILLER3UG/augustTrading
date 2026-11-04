/**
 * SidebarToggle — the content bar's ONE control for the whole navigation rail.
 *
 * It sits on the title row (beside "Chart AI" / "Journal" / "Learning" / the
 * Agents thread name), NOT at the rail's foot: a control that puts the rail
 * away belongs at the top where the eye already is, and it must still be there
 * after the rail has gone, because a collapsed rail is 0px and has no edge to
 * click. One button, two states — the icon, the tooltip and the testid all
 * follow `expanded`. The trader-facing name is HIDE / SHOW CONVERSATION (this
 * is the same action the old Chats icon and "Collapse sidebar" both claimed);
 * the accessible name stays state-independent so a toggle press is readable.
 *
 * The collapsed state keeps the update-status dot the old expand-only button
 * carried: the hidden sidebar's one quiet status carrier stays on screen.
 */
import React from 'react';
import { PanelLeftClose, PanelLeftOpen } from '../shared/Icons';
import { useUpdateStatusDot } from '../shared/UpdateButton';

interface SidebarToggleProps {
    /** True when the rail is on screen. */
    expanded: boolean;
    onToggle: () => void;
}

const SidebarToggle: React.FC<SidebarToggleProps> = ({ expanded, onToggle }) => {
    const updateDot = useUpdateStatusDot();
    const Icon = expanded ? PanelLeftClose : PanelLeftOpen;
    // The accessible NAME stays the same in both states — a toggle's name is
    // its function, and `aria-pressed` carries the state. The tooltip names
    // the action the next press will take. A name that changed with the icon
    // would make the state unreadable to the render probe's control sweep and
    // to anyone tabbing between two presses.
    const action = expanded ? 'Hide conversation · Ctrl+B' : 'Show conversation · Ctrl+B';
    return (
        <button
            type="button"
            data-testid={expanded ? 'shell-rail-collapse' : 'nav-rail-toggle-header'}
            onClick={onToggle}
            aria-label="Toggle sidebar"
            aria-pressed={expanded}
            title={action}
            aria-controls="nav-rail-panel"
            aria-keyshortcuts="Control+B Meta+B"
            className="relative -ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400"
        >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {!expanded && updateDot && (
                <span data-testid="nav-update-dot-header" className="absolute -right-0.5 -top-0.5">
                    {updateDot}
                </span>
            )}
        </button>
    );
};

export default SidebarToggle;
