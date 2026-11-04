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
    MessageSquareIcon,
    HistoryIcon,
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

/** Journal and Learning are the records half of the workspace: quiet rows at
 *  the foot of the rail, where the reference puts Sites. The Skills row is the
 *  Learning surface's Skills tab direct route — named for WHERE it lands
 *  (owner, 2026-11-03: a row labelled "Customize" that renders Learning →
 *  Skills promised a render it does not have; the label names the destination). */

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
    /** The rail's Chats icon. On the surfaces whose column IS the rail it
     *  collapses the rail (default); on Agents the column is the surface's own
     *  and starts closed, so the icon toggles THAT. */
    onToggleColumn?: () => void;
    columnOpen?: boolean;
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
    workspaces, onSwitchWorkspace, onAddWorkspace,
    conversations, activeConversationId, onOpenConversation,
    onDeleteConversation, onClearConversation,
    activeUsername, onOpenSettings, onOpenActivity, onToggleColumn, columnOpen = true,
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
                    width: width + RAIL_W,
                    ...(overlay ? { maxWidth: 'calc(100vw - 24px)' } : null),
                }}
                className={`flex h-full border-r border-white/[0.06] bg-zinc-950 ${
                    overlay
                        ? 'fixed inset-y-0 left-0 z-40 shadow-2xl'
                        : 'relative shrink-0'
                } ${isResizing ? '' : 'transition-[width] duration-150 ease-[var(--ease-snappy)]'}`}
            >
                {/* The icon rail: the two desk modes and the records at its
                    foot. The old "Hide conversations" (Chats) icon is GONE on
                    the surfaces whose column IS the rail — it collapsed the
                    whole rail and so duplicated the title-row toggle. It stays
                    on Agents ONLY, where it opens that surface's own column
                    (which starts closed and has no other opener). Hiding the
                    conversation list from the rail itself is now the icon
                    after the RECENT heading in `ConversationGroups`. */}
                <nav
                    aria-label="Surfaces"
                    data-testid="shell-surface-rail"
                    className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-white/[0.06] py-2"
                >
                    <RailIcon label="Analyze — chart and desk · Alt+1" testId="surface-switch-trade"
                        current={surface === 'trade'} onClick={() => onSelectSurface('trade')}>
                        <ActivityIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    <RailIcon label="Agents — focused chat · Alt+4" testId="surface-switch-agents"
                        current={surface === 'agents'} onClick={() => onSelectSurface('agents')}>
                        <MessageSquareIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    {onToggleColumn && (
                        <RailIcon label={columnOpen ? 'Hide conversations' : 'Show conversations'}
                            testId="shell-column-toggle" pressed={columnOpen}
                            onClick={onToggleColumn}>
                            <HistoryIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                        </RailIcon>
                    )}
                    <span aria-hidden="true" className="flex-1" />
                    <RailIcon label="Journal · Alt+2" testId="surface-switch-journal"
                        current={surface === 'journal'} onClick={() => onSelectSurface('journal')}>
                        <BookOpen className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    <RailIcon label="Learning · Alt+5" testId="surface-switch-learn"
                        current={surface === 'learn'} onClick={() => onSelectSurface('learn')}>
                        <GraduationCap className="h-[18px] w-[18px]" aria-hidden="true" />
                    </RailIcon>
                    {/* No collapse control here. The whole rail's one toggle
                        lives on the content bar's TITLE row (`SidebarToggle`),
                        where it stays reachable after the rail is put away —
                        a 0px rail has no edge to click. */}
                    <button
                        type="button"
                        data-testid="shell-account"
                        onClick={onOpenSettings}
                        aria-label={`${activeUsername || 'default'} — settings`}
                        title="Settings · Ctrl+,"
                        className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-zinc-700 to-zinc-800 text-[10px] font-semibold text-zinc-200 transition-colors hover:border-white/25"
                    >
                        {(activeUsername || 'default').trim().slice(0, 1).toUpperCase()}
                    </button>
                </nav>

                <div className="flex min-w-0 flex-1 flex-col" style={{ width }}>
                    <ConversationGroups
                        conversations={conversations}
                        activeConversationId={activeConversationId}
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
