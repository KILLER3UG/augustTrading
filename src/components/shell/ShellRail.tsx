/**
 * The shell rail — the one navigation column the reference has.
 *
 * It lives beside the content, runs the full height of the window and is the
 * SAME column on every surface (the workspace merge left one desk): the
 * [Desk | Chat] layout pill and the collapse toggle head it, the conversation
 * column (New chat / Pinned / Recent — ConversationGroups) fills it, and the
 * account row closes it. The narrow icon strip died with the owner's 1.2
 * ruling: the pill routes the two desk modes (Desk → trade, Chat → agents),
 * the account row carries the one Settings entry, and Alt+1/Alt+4 keep the
 * keyboard routes — three controls that each said "surface" was two of them
 * too many.
 *
 * The collapsed fallback is the header's compact bar (`SidebarToggle` +
 * `LayoutMiniToggle`): a put-away rail has no edge to click.
 *
 * The Approvals row died with the Approvals tab (2026-11-03): its queues
 * apply themselves, so a row with nothing behind it was the O-80 lie.
 * The Workspaces/Rooms sections are gone (mock-redesign-v3): the conversation
 * list is the only list; workspace switching lives in Settings → Accounts.
 * Journal, Learning, Skills and Memory are sections of the Settings modal,
 * so the account row's gear is the one entry instead of four rows.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import SidebarToggle from './SidebarToggle';
import { AccountRow } from './shellChrome';
import { ConversationGroups } from './ConversationGroups';
import { LayoutPill } from './LayoutSwitch';
import type { AppSurface } from '../../hooks/useSurface';
import type { Conversation } from '../../types';
import { display } from '../../utils/symbol';
import * as chatStore from '../../services/trade/chatStore';
import { readConversationPins, toggleConversationPin } from '../../services/trade/conversationPins';

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
    /** The Customize row lands on a named Settings tab (Memory). */
    onOpenCustomize?: () => void;
    onOpenActivity?: () => void;
    /** The dragged width of the conversation column; the whole rail is it. */
    width: number;
    isResizing: boolean;
    onResizeStart: (event: React.PointerEvent) => void;
    onResizeReset: () => void;
    /** Put the column away; the header's compact bar brings it back. */
    onCollapse: () => void;
    /** The profile write's state — the account row speaks only on ERROR. */
    saveStatus?: 'SAVED' | 'SAVING' | 'ERROR';
    /** Below the auto-collapse width the rail is a drawer over the content,
     *  not a column that squeezes it. */
    overlay?: boolean;
    onCloseOverlay?: () => void;
    /** On Electron the unified TitleBar hosts the layout pill + collapse toggle,
     *  so the rail omits its duplicate top row to avoid stacked header chrome. */
    hideTopControls?: boolean;
}

const ShellRail: React.FC<ShellRailProps> = ({
    surface, onSelectSurface, onNewChat,
    conversations, activeConversationId, onOpenConversation,
    onDeleteConversation, onClearConversation,
    activeUsername, onOpenSettings, onOpenCustomize, onOpenActivity,
    width, isResizing, onResizeStart, onResizeReset, onCollapse,
    saveStatus, overlay = false, onCloseOverlay, hideTopControls = false,
}) => {
    // One column on every surface: the workspace merge left ONE desk, so the
    // conversation list (New chat / Pinned / Recent) and the account row ride
    // beside the layout pill everywhere — there is no second surface left that
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
                    className="motion-backdrop-in fixed inset-0 z-30 bg-black/60 backdrop-blur-[2px]"
                />
            )}
            <aside
                ref={railRef}
                data-testid="shell-rail"
                data-expanded="true"
                aria-label="August navigation"
                style={{
                    width,
                    ...(overlay ? { maxWidth: 'calc(100vw - 24px)' } : null),
                }}
                className={`flex h-full border-r border-white/[0.04] bg-zinc-900/50 ${
                    overlay
                        ? 'motion-drawer-left fixed inset-y-0 left-0 z-40 bg-zinc-950 shadow-elevated'
                        : 'relative shrink-0'
                } ${isResizing ? '' : 'transition-[width] duration-150 ease-[var(--ease-out-expo)]'}`}
            >
                {/* The conversation column: the [Desk | Chat] pill + the rail's
                    collapse toggle head it (the pill IS the surface switch —
                    the icon strip died with ruling 1.2), New chat / Pinned /
                    Recent fill it, the account row closes it. The resize edge
                    is the column's own. */}
                <div className="flex min-w-0 flex-1 flex-col" style={{ width }}>
                    {!hideTopControls && (
                        <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
                            <LayoutPill surface={surface} onSelectSurface={onSelectSurface} />
                            <span aria-hidden="true" className="flex-1" />
                            {/* The collapse-to-zero control the ruling pairs with
                                the pill: the same one toggle the header carries,
                                so both states share a component and a testid. */}
                            <SidebarToggle expanded onToggle={onCollapse} />
                        </div>
                    )}
                    <ConversationGroups
                        conversations={conversations}
                        activeConversationId={activeConversationId}
                        pinnedIds={pinnedIds}
                        onTogglePin={togglePin}
                        onNewChat={onNewChat}
                        onOpenConversation={onOpenConversation}
                        onDeleteConversation={onDeleteConversation}
                        onClearConversation={onClearConversation}
                        onOpenSettings={onOpenSettings}
                        onOpenCustomize={onOpenCustomize}
                        onOpenActivity={onOpenActivity}
                    />
                    <AccountRow
                        expanded
                        activeUsername={activeUsername}
                        onOpenSettings={onOpenSettings}
                        onOpenActivity={onOpenActivity}
                        saveStatus={saveStatus}
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
