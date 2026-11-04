/**
 * The shell rail — the one navigation column the reference has.
 *
 * It lives beside the content, runs the full height of the window and owns
 * every route that is not a conversation: the Analyze ⇄ Agents mode switch,
 * New chat, Search, the sparse conversation list (ConversationGroups —
 * Pinned only when there are pinned rows, Recent always), Journal,
 * Learning, Skills and the account. The old top-bar tab strip is
 * gone, so the rail is the only place navigation is repeated; the collapsed
 * fallback still rides the content bar (see `shared/Header` and `AgentsView`).
 *
 * The Approvals row died with the Approvals tab (2026-11-03): its queues
 * apply themselves, so a row with nothing behind it was the O-80 lie.
 * The Workspaces/Rooms sections are gone (mock-redesign-v3): the Sparse
 * conversation list is the only list; workspace switching lives in
 * Settings → Accounts.
 *
 * The Agents surface keeps its own richer middle (agents, rooms, goals) but
 * renders the same mode switch at the top and the same utility group above the
 * account, so hopping modes moves the content and not the chrome.
 */
import React, { useRef } from 'react';
import {
    ActivityIcon, BookOpen, GraduationCap,
    LayersIcon, MessageSquareIcon, PanelLeftClose, Search,
} from '../shared/Icons';
import { AccountRow } from './shellChrome';
import { ConversationGroups } from './ConversationGroups';
import type { AppSurface } from '../../hooks/useSurface';
import type { Conversation } from '../../types';
import { display } from '../../utils/symbol';
import * as chatStore from '../../services/trade/chatStore';

/** Live activity on a route: `active` is a working pulse, `count` a waiting
 *  number. Announced through the row's accessible name, never a bare dot. */
export interface NavBadge {
    active?: boolean;
    count?: number;
    /** Sentence completing "Learning — …" for screen readers and the tooltip. */
    detail: string;
}

/** The two modes of the one desk. Analyze keeps the chart beside the desk;
 *  Agents is the same thread with the chart put away. */
const MODE_ITEMS = [
    { id: 'trade' as const, label: 'Analyze', shortcut: 'Alt+1', detail: 'chart and desk', Icon: ActivityIcon },
    { id: 'agents' as const, label: 'Agents', shortcut: 'Alt+4', detail: 'focused chat', Icon: MessageSquareIcon },
];

const rowClass = (current: boolean): string =>
    `flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ui-caption transition-colors duration-150 ease-[var(--ease-snappy)] ${
        current ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
    }`;

export const ShellModeSwitch: React.FC<{
    surface: AppSurface;
    onSelect: (surface: AppSurface) => void;
}> = ({ surface, onSelect }) => (
    <div
        role="group"
        aria-label="Desk mode"
        className="flex w-max max-w-full items-center gap-0.5 rounded-control border border-white/[0.07] bg-zinc-900/60 p-0.5"
    >
        {MODE_ITEMS.map(({ id, label, shortcut, detail, Icon }) => {
            const current = surface === id;
            return (
                <button
                    key={id}
                    type="button"
                    onClick={current ? undefined : () => onSelect(id)}
                    aria-current={current ? 'page' : undefined}
                    aria-label={`${label}, shortcut ${shortcut}`}
                    title={`${label} — ${detail} · ${shortcut}`}
                    data-testid={`surface-switch-${id}`}
                    className={`flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-ui-xs font-medium transition-colors duration-150 ease-[var(--ease-snappy)] ${
                        current ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
                    }`}
                >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{label}</span>
                </button>
            );
        })}
    </div>
);

/** Journal and Learning are the records half of the workspace: quiet rows at
 *  the foot of the rail, where the reference puts Sites. The Skills row is the
 *  Learning surface's Skills tab direct route — named for WHERE it lands
 *  (owner, 2026-11-03: a row labelled "Customize" that renders Learning →
 *  Skills promised a render it does not have; the label names the destination). */
export const ShellUtility: React.FC<{
    surface: AppSurface;
    onSelect: (surface: AppSurface) => void;
    onOpenSkills?: () => void;
    badges?: Partial<Record<AppSurface, NavBadge>>;
}> = ({ surface, onSelect, onOpenSkills, badges }) => {
    const items = [
        { id: 'journal' as const, label: 'Journal', shortcut: 'Alt+2', Icon: BookOpen },
        { id: 'learn' as const, label: 'Learning', shortcut: 'Alt+5', Icon: GraduationCap },
    ];
    return (
        <nav aria-label="Records and learning" className="flex flex-col gap-0.5">
            {items.map(({ id, label, shortcut, Icon }) => {
                const current = surface === id;
                const badge = badges?.[id];
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={current ? undefined : () => onSelect(id)}
                        aria-current={current ? 'page' : undefined}
                        aria-label={badge
                            ? `${label}. ${badge.detail}, shortcut ${shortcut}`
                            : `${label}, shortcut ${shortcut}`}
                        title={badge ? `${label} — ${badge.detail} · ${shortcut}` : `${label} · ${shortcut}`}
                        data-testid={`surface-switch-${id}`}
                        className={rowClass(current)}
                    >
                        <Icon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                        <span className="flex-1 truncate">{label}</span>
                        {badge?.count ? (
                            <span
                                aria-hidden="true"
                                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1 font-mono text-ui-2xs font-semibold text-amber-400"
                            >
                                {badge.count > 9 ? '9+' : badge.count}
                            </span>
                        ) : null}
                    </button>
                );
            })}
            {onOpenSkills && (
                <button
                    type="button"
                    onClick={onOpenSkills}
                    aria-label="Skills, shortcut Alt+3"
                    title="Skills · Alt+3"
                    data-testid="nav-customize"
                    className={rowClass(false)}
                >
                    <LayersIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex-1 truncate">Skills</span>
                </button>
            )}
        </nav>
    );
};

/** The active desk's instrument, read from the shared chat session. It is its
 *  own component so a chat-store write re-renders a label, not the App. */
export const DeskInstrument: React.FC<{ className?: string }> = ({ className }) => {
    const snap = React.useSyncExternalStore(
        chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const session = snap.sessions.find(s => s.id === snap.activeId) ?? snap.sessions[0];
    if (!session?.symbol) return null;
    return (
        <span className={className} data-testid="shell-instrument">
            {display(session.symbol)} · {session.interval}
        </span>
    );
};

interface ShellRailProps {
    surface: AppSurface;
    onSelectSurface: (surface: AppSurface) => void;
    onNewChat: () => void;
    onOpenSearch: () => void;
    /** Legacy props — workspace switching moved to Settings → Accounts.
     *  Kept optional so App's existing call site compiles untouched. */
    workspaces?: Array<{ name: string; active: boolean }>;
    onSwitchWorkspace?: (name: string) => void;
    onAddWorkspace?: () => void;
    conversations: Conversation[];
    activeConversationId: string | null;
    onOpenConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    onOpenSkills: () => void;
    activeUsername: string | null;
    onOpenSettings: () => void;
    onOpenActivity?: () => void;
    /** The dragged width, shared with the Agents mode's column. */
    width: number;
    isResizing: boolean;
    onResizeStart: (event: React.PointerEvent) => void;
    onResizeReset: () => void;
    /** Put the column away; the content bar's expand button brings it back. */
    onCollapse: () => void;
    /** Below the auto-collapse width the rail is a drawer over the content,
     *  not a column that squeezes it. */
    overlay?: boolean;
    onCloseOverlay?: () => void;
}

const ShellRail: React.FC<ShellRailProps> = ({
    surface, onSelectSurface, onNewChat,
    onOpenSearch, workspaces, onSwitchWorkspace, onAddWorkspace,
    conversations, activeConversationId, onOpenConversation,
    onDeleteConversation, onClearConversation, onOpenSkills,
    activeUsername, onOpenSettings, onOpenActivity,
    width, isResizing, onResizeStart, onResizeReset, onCollapse,
    overlay = false, onCloseOverlay,
}) => {
    void workspaces; void onSwitchWorkspace; void onAddWorkspace;
    const railRef = useRef<HTMLElement | null>(null);

    return (
        <>
            {overlay && (
                <button
                    type="button"
                    aria-label="Close navigation"
                    data-testid="shell-rail-backdrop"
                    onClick={onCloseOverlay}
                    className="fixed inset-0 z-30 bg-black/60"
                />
            )}
            <aside
                ref={railRef}
                data-testid="shell-rail"
                data-expanded="true"
                aria-label="August navigation"
                style={{
                    width,
                    ...(overlay ? { maxWidth: 'calc(100vw - 48px)' } : null),
                }}
                className={`flex h-full flex-col border-r border-white/[0.06] bg-zinc-950 px-2 pb-1 pt-2 ${
                    overlay
                        ? 'fixed inset-y-0 left-0 z-40 shadow-2xl'
                        : 'relative shrink-0'
                } ${isResizing ? '' : 'transition-[width] duration-150 ease-[var(--ease-snappy)]'}`}
            >
                <div className="flex shrink-0 items-center justify-between gap-2">
                    <ShellModeSwitch surface={surface} onSelect={onSelectSurface} />
                    <button
                        type="button"
                        onClick={onCollapse}
                        data-testid="shell-rail-collapse"
                        aria-label={overlay ? 'Close navigation' : 'Collapse navigation'}
                        title={overlay ? 'Close navigation' : 'Collapse navigation'}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                    >
                        <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>

            <button
                type="button"
                data-testid="shell-search"
                aria-label="Search conversations"
                title="Search conversations · Ctrl+K"
                onClick={onOpenSearch}
                className={`${rowClass(false)} mt-3 shrink-0`}
            >
                <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                <span className="flex-1 truncate">Search</span>
                <kbd className="shrink-0 rounded border border-zinc-700/60 px-1 font-mono text-ui-2xs text-zinc-600" aria-hidden="true">⌘K</kbd>
            </button>

            <ConversationGroups
                conversations={conversations}
                activeConversationId={activeConversationId}
                onNewChat={onNewChat}
                onOpenConversation={onOpenConversation}
                onDeleteConversation={onDeleteConversation}
                onClearConversation={onClearConversation}
            />

            <div className="shrink-0 border-t border-white/[0.06] py-1.5">
                <ShellUtility
                    surface={surface}
                    onSelect={onSelectSurface}
                    onOpenSkills={onOpenSkills}
                />
            </div>
            <AccountRow
                expanded
                activeUsername={activeUsername}
                onOpenSettings={onOpenSettings}
                onOpenActivity={onOpenActivity}
            />
            <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize navigation"
                data-testid="shell-rail-resize"
                onPointerDown={onResizeStart}
                onDoubleClick={onResizeReset}
                title="Drag to resize · double-click to reset"
                className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none items-center justify-center text-zinc-600 transition-colors hover:text-zinc-300 md:flex"
            >
                <span aria-hidden="true" className="block h-8 w-px bg-white/15 opacity-60" />
            </div>
        </aside>
        </>
    );
};

export default React.memo(ShellRail);
