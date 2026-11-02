/**
 * The shell rail — the one navigation column the reference has.
 *
 * It lives beside the content, runs the full height of the window and owns
 * every route that is not a conversation: the Analyze ⇄ Agents mode switch,
 * New chat, Approvals, Search, the workspace's conversations, Journal,
 * Learning, Customize and the account. The old top-bar tab strip is gone, so
 * the rail is the only place navigation is repeated; the collapsed fallback
 * still rides the content bar (see `shared/Header` and `AgentsView`).
 *
 * The Agents surface keeps its own richer middle (agents, rooms, goals) but
 * renders the same mode switch at the top and the same utility group above the
 * account, so hopping modes moves the content and not the chrome.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIcon, BookOpen, ChevronDownIcon, FolderIcon, GraduationCap,
    Inbox, LayersIcon, MessageSquareIcon, PanelLeftClose, Plus, Search,
} from '../shared/Icons';
import { AccountRow } from './shellChrome';
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
 *  the foot of the rail, where the reference puts Sites. Customize rides with
 *  them so the Learning surface's Skills tab keeps its one direct route. */
export const ShellUtility: React.FC<{
    surface: AppSurface;
    onSelect: (surface: AppSurface) => void;
    onOpenCustomize?: () => void;
    badges?: Partial<Record<AppSurface, NavBadge>>;
}> = ({ surface, onSelect, onOpenCustomize, badges }) => {
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
            {onOpenCustomize && (
                <button
                    type="button"
                    onClick={onOpenCustomize}
                    aria-label="Customize, shortcut Alt+3"
                    title="Customize · Alt+3"
                    data-testid="nav-customize"
                    className={rowClass(false)}
                >
                    <LayersIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex-1 truncate">Customize</span>
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
    onOpenApprovals: () => void;
    approvalsCount: number;
    onOpenSearch: () => void;
    conversations: Conversation[];
    activeConversationId: string | null;
    onOpenConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    onOpenCustomize: () => void;
    activeUsername: string | null;
    onOpenSettings: () => void;
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

const conversationTitle = (conversation: Conversation): string =>
    conversation.title?.trim() || 'New chat';

const ShellRail: React.FC<ShellRailProps> = ({
    surface, onSelectSurface, onNewChat, onOpenApprovals, approvalsCount,
    onOpenSearch, conversations, activeConversationId, onOpenConversation,
    onDeleteConversation, onClearConversation, onOpenCustomize,
    activeUsername, onOpenSettings,
    width, isResizing, onResizeStart, onResizeReset, onCollapse,
    overlay = false, onCloseOverlay,
}) => {
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [workspaceOpen, setWorkspaceOpen] = useState(true);
    const railRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!menuFor) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (railRef.current?.contains(event.target as Node)) return;
            setMenuFor(null);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [menuFor]);

    const rows = useMemo(
        () => [...conversations].sort((a, b) => b.timestamp - a.timestamp),
        [conversations],
    );

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

            <div className="mt-3 flex shrink-0 flex-col gap-0.5">
                <button
                    type="button"
                    data-testid="rail-new-chat"
                    aria-label="New chat"
                    title="New chat"
                    onClick={onNewChat}
                    className={rowClass(false)}
                >
                    <Plus className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="flex-1 truncate">New chat</span>
                </button>
                <button
                    type="button"
                    data-testid="shell-approvals"
                    aria-label={approvalsCount > 0 ? `Approvals, ${approvalsCount} waiting` : 'Approvals'}
                    title={approvalsCount > 0 ? `Approvals — ${approvalsCount} waiting` : 'Approvals'}
                    onClick={onOpenApprovals}
                    className={rowClass(false)}
                >
                    <Inbox className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex-1 truncate">Approvals</span>
                    {approvalsCount > 0 && (
                        <span
                            aria-hidden="true"
                            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1 font-mono text-ui-2xs font-semibold text-amber-400"
                        >
                            {approvalsCount > 9 ? '9+' : approvalsCount}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    data-testid="shell-search"
                    aria-label="Search conversations"
                    title="Search conversations"
                    onClick={onOpenSearch}
                    className={rowClass(false)}
                >
                    <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex-1 truncate">Search</span>
                </button>
            </div>

            <div className="mt-3 px-2.5 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Workspaces
            </div>
            <div className="mt-0.5">
                <button
                    type="button"
                    onClick={() => setWorkspaceOpen(open => !open)}
                    aria-expanded={workspaceOpen}
                    aria-controls="shell-workspace-threads"
                    title={workspaceOpen ? 'Collapse August Trading' : 'Expand August Trading'}
                    className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-ui-caption text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                >
                    <FolderIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="flex-1 truncate">August Trading</span>
                    <ChevronDownIcon className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform duration-150 ${workspaceOpen ? '' : '-rotate-90'}`} aria-hidden="true" />
                </button>
            </div>

            <div
                id="shell-workspace-threads"
                className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"
                data-testid="shell-conversations"
            >
                {workspaceOpen && (rows.length === 0 ? (
                    <p className="px-2.5 py-3 text-ui-xs leading-relaxed text-zinc-600">
                        No conversations yet. Everything you ask the desk lands here.
                    </p>
                ) : rows.map(conversation => {
                    const selected = conversation.id === activeConversationId;
                    const title = conversationTitle(conversation);
                    return (
                        <div key={conversation.id}>
                            <div className={`group relative flex items-center rounded-control ${
                                selected ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-500'
                            }`}>
                                <button
                                    type="button"
                                    onClick={() => onOpenConversation(conversation.id)}
                                    title={title}
                                    aria-current={selected ? 'page' : undefined}
                                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left text-ui-caption transition-colors hover:text-zinc-100 ${
                                        selected ? 'pr-8' : 'pr-2.5'
                                    }`}
                                >
                                    {selected && (
                                        <MessageSquareIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate">{title}</span>
                                </button>
                                {selected && (
                                    <button
                                        type="button"
                                        aria-label={`Conversation actions for ${title}`}
                                        aria-expanded={menuFor === conversation.id}
                                        title="Conversation actions"
                                        onClick={() => setMenuFor(m => (m === conversation.id ? null : conversation.id))}
                                        className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                                    >
                                        <span aria-hidden="true" className="text-ui-caption leading-none">⋯</span>
                                    </button>
                                )}
                            </div>
                            {menuFor === conversation.id && (
                                <div className="mb-1 flex items-center gap-1 pl-2.5">
                                    <button
                                        type="button"
                                        onClick={() => { setMenuFor(null); onClearConversation(conversation.id); }}
                                        className="rounded-control px-2 py-1 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                                    >
                                        Clear messages
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => { setMenuFor(null); onDeleteConversation(conversation.id); }}
                                        className="rounded-control px-2 py-1 text-ui-xs text-rose-400/90 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                                    >
                                        Delete
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                }))}
            </div>

            <div className="shrink-0 border-t border-white/[0.06] py-1.5">
                <ShellUtility
                    surface={surface}
                    onSelect={onSelectSurface}
                    onOpenCustomize={onOpenCustomize}
                />
            </div>
            <AccountRow
                expanded
                activeUsername={activeUsername}
                onOpenSettings={onOpenSettings}
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
