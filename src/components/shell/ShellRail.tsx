/**
 * The shell rail — the one navigation column the reference has.
 *
 * It lives beside the content, runs the full height of the window and is the
 * SAME column on every surface (the workspace merge left one desk): the icon
 * strip carries the two desk routes and the Settings gear, and the column
 * beside it is New chat / Pinned / Recent (ConversationGroups) over the
 * account row. The collapsed fallback still rides the content bar (see
 * `shared/Header`): a put-away rail has no edge to click.
 *
 * The Approvals row died with the Approvals tab (2026-11-03): its queues
 * apply themselves, so a row with nothing behind it was the O-80 lie.
 * The Workspaces/Rooms sections are gone (mock-redesign-v3): the conversation
 * list is the only list; workspace switching lives in Settings → Accounts.
 * Journal, Learning, Skills and Memory are sections of the Settings modal,
 * so the rail carries the one gear instead of four rows.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    ActivityIcon, MessageSquareIcon, SettingsIcon,
} from '../shared/Icons';
import { AccountRow } from './shellChrome';
import { ConversationGroups } from './ConversationGroups';
import type { AppSurface } from '../../hooks/useSurface';
import type { Conversation } from '../../types';
import { display } from '../../utils/symbol';
import * as chatStore from '../../services/trade/chatStore';
import { getWorkspaceLayout, setWorkspaceLayout, subscribeWorkspaceLayout, type WorkspaceLayout } from '../../utils/workspaceLayout';
import { readConversationPins, toggleConversationPin } from '../../services/trade/conversationPins';

/** Live activity on a route: `active` is a working pulse, `count` a waiting
 *  number. Announced through the row's accessible name, never a bare dot. */
export interface NavBadge {
    active?: boolean;
    count?: number;
    /** Sentence completing "Learning — …" for screen readers and the tooltip. */
    detail: string;
}

const RAIL_W = 48;

const RailIcon: React.FC<{
    label: string;
    testId: string;
    onClick: () => void;
    children: React.ReactNode;
    current?: boolean;
    pressed?: boolean;
}> = ({ label, testId, onClick, children, current = false, pressed }) => (
    <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        aria-current={current ? 'page' : undefined}
        aria-pressed={pressed}
        data-testid={testId}
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-control transition-colors ${
            current || pressed
                ? 'bg-white/[0.06] text-zinc-100'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200'
        }`}
    >
        {(current || pressed) && (
            <span aria-hidden="true" className="absolute -left-1 top-2 bottom-2 w-[2px] rounded-full bg-zinc-200" />
        )}
        {children}
    </button>
);

/** Journal, Learning, Skills and Memory are the records half of the workspace:
 *  quiet rows at the foot of the rail, where the reference puts Sites. Each is a
 *  surface of its own (Skills and Memory split off Learning on 2026-11-08), so a
 *  row is named for WHERE it lands — owner, 2026-11-03: a row labelled
 *  "Customize" that renders Learning → Skills promised a render it does not
 *  have; the label names the destination. */

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
    /** Legacy props — workspace switching moved to Settings → Accounts.
     *  Kept optional so App's existing call site compiles untouched. */
    conversations: Conversation[];
    activeConversationId: string | null;
    onOpenConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    activeUsername: string | null;
    onOpenSettings: () => void;
    onOpenActivity?: () => void;
    /** The rail's Chats icon. On the surfaces whose column IS the rail it
     *  collapses the rail (default); on Agents the column is the surface's own
     *  and starts closed, so the icon toggles THAT. */
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

/** The [Desk | Chat] segmented pill — the workspace's layout mode at the
 *  rail's top-left. Two 24px segments; the active one is the workspace's
 *  current layout. Alt+D toggles it from anywhere. */
const LayoutPill: React.FC = () => {
    const layout = useSyncExternalStore(subscribeWorkspaceLayout, getWorkspaceLayout, getWorkspaceLayout);
    const pick = (m: WorkspaceLayout): void => setWorkspaceLayout(m);
    return (
        <div
            role="group"
            aria-label="Workspace layout"
            data-testid="layout-pill"
            className="mb-1 flex w-10 flex-col rounded-control border border-hairline bg-zinc-900/60 p-0.5"
        >
            {(['desk', 'chat'] as const).map((m) => (
                <button
                    key={m}
                    type="button"
                    onClick={() => pick(m)}
                    aria-pressed={layout === m}
                    title={m === 'desk' ? 'Desk — chart + AI side by side (Alt+D toggles)' : 'Chat — pure chat focus view (Alt+D toggles)'}
                    data-testid={`layout-pill-${m}`}
                    className={`flex h-6 w-full items-center justify-center rounded-[4px] font-mono text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        layout === m
                            ? 'bg-zinc-700/80 text-zinc-100'
                            : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                    {m === 'desk' ? 'D' : 'C'}
                </button>
            ))}
        </div>
    );
};

const ShellRail: React.FC<ShellRailProps> = ({
    surface, onSelectSurface, onNewChat,
    conversations, activeConversationId, onOpenConversation,
    onDeleteConversation, onClearConversation,
    activeUsername, onOpenSettings, onOpenActivity,
    width, isResizing, onResizeStart, onResizeReset, onCollapse,
    overlay = false, onCloseOverlay,
}) => {
    // One column on every surface: the workspace merge left ONE desk, so the
    // conversation list (New chat / Pinned / Recent) and the account row ride
    // beside the icon strip everywhere — there is no second surface left that
    // would carry a duplicate list.
    const railRef = useRef<HTMLElement | null>(null);
    // The trader's own pins (F10 / the UI audit's dead Pinned section): the
    // ids live in the conversationPins store; this column renders them as the
    // Pinned group and flips them from the row menu. Refreshed on the
    // profile and on any list-length change (a delete can remove a pinned
    // row; a rename never changes ids).
    const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
        () => new Set(readConversationPins(activeUsername ?? undefined)));
    useEffect(() => {
        setPinnedIds(new Set(readConversationPins(activeUsername ?? undefined)));
    }, [activeUsername, conversations.length]);
    const togglePin = useCallback((id: string) => {
        setPinnedIds(new Set(toggleConversationPin(id, activeUsername ?? undefined)));
    }, [activeUsername]);

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
                    width: width + RAIL_W,
                    ...(overlay ? { maxWidth: 'calc(100vw - 24px)' } : null),
                }}
                className={`flex h-full border-r border-hairline bg-zinc-950 ${
                    overlay
                        ? 'fixed inset-y-0 left-0 z-40 shadow-elevated'
                        : 'relative shrink-0'
                } ${isResizing ? '' : 'transition-[width] duration-150 ease-[var(--ease-snappy)]'}`}
            >
                {/* The icon rail: the two desk modes at the top, and Settings
                    at its foot — Journal, Learning, Skills and Memory live
                    inside the Settings modal now, so the rail carries one
                    entry instead of four. */}
                <nav
                    aria-label="Surfaces"
                    data-testid="shell-surface-rail"
                    className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-hairline py-2"
                >
                    {/* The [Desk | Chat] layout pill — the owner's ruling: a
                        LAYOUT MODE of the one workspace, never a second
                        surface. Desk = chart + dock side by side; Chat hides
                        the chart and centers the stream. Alt+D toggles it. */}
                    <LayoutPill />
                    <RailIcon label="Analyze — chart and desk · Alt+1" testId="surface-switch-trade"
                        current={surface === 'trade'} onClick={() => onSelectSurface('trade')}>
                        <ActivityIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    <RailIcon label="Agents — focused chat · Alt+4" testId="surface-switch-agents"
                        current={surface === 'agents'} onClick={() => onSelectSurface('agents')}>
                        <MessageSquareIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    <span aria-hidden="true" className="flex-1" />
                    <RailIcon label="Settings — Journal, Learning, Skills, Memory · Ctrl+," testId="surface-switch-settings"
                        current={false} onClick={onOpenSettings}>
                        <SettingsIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    {/* No collapse control here. The whole rail's one toggle
                        lives on the content bar's TITLE row (`SidebarToggle`),
                        where it stays reachable after the rail is put away —
                        a 0px rail has no edge to click. No account avatar
                        either: the account row (where the column mounts) is
                        the one place the rail says who is signed in. */}
                </nav>

                {/* The conversation column: New chat / Pinned / Recent over
                    the account row — the reference's one sidebar, on every
                    surface. The resize edge is the column's own; the icon
                    strip is fixed at 48px. */}
                <div className="flex min-w-0 flex-1 flex-col" style={{ width }}>
                    <ConversationGroups
                        conversations={conversations}
                        activeConversationId={activeConversationId}
                        pinnedIds={pinnedIds}
                        onTogglePin={togglePin}
                        onNewChat={onNewChat}
                        onOpenConversation={onOpenConversation}
                        onDeleteConversation={onDeleteConversation}
                        onClearConversation={onClearConversation}
                        onHideConversation={onCollapse}
                    />
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
                </div>
            </aside>
        </>
    );
};

export default React.memo(ShellRail);
