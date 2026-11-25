/**
 * ConversationGroups — the shell's shared conversation list.
 *
 * ONE home since 4217c135: AgentsView (the Chat surface) renders it. The
 * shell column mounts only on the record surfaces — Analyze has NO
 * conversation column (the icon rail alone), and the ownership test is
 * pinned in render-probe (`newChats === 1 && !shellColumn && agentsColumn`).
 * Sparse: New chat + Ctrl K, Pinned (only when there are pinned rows),
 * Recent (always). Rows: hollow
 * dot (filled active, ink pulsing running), truncated title, mono age
 * from `workspaceAgeLabel` (single source).
 *
 * This file did NOT exist on clean HEAD — created for mock-redesign-v3.
 * The age helper lives here; nothing else defines it.
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Conversation } from '../../types';
import { conversationTitle } from '../../utils/conversationTitle';
import { renameConversationRow } from '../../hooks/useConversations';
import { signalIdFromActions, signalRowById } from '../trade/SignalCard';
import * as chatStore from '../../services/trade/chatStore';
import { formatThreadBadge } from '../../utils/uiFormatting';

/** The side of the thread's latest signal — the mock's `Long` tag. Read from
 *  the ledger's own id on the turn's actions, never guessed from prose; a
 *  thread that emitted nothing shows no tag. */
const conversationSide = (conversation: Conversation): 'Long' | 'Short' | null => {
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
        const id = signalIdFromActions(conversation.messages[i].toolActions);
        if (!id) continue;
        const direction = signalRowById(id)?.signal.direction;
        if (direction === 'long') return 'Long';
        if (direction === 'short') return 'Short';
    }
    return null;
};

/** The ONE age formatter for conversation rows. `now`, `5m`, `3h`, `48d`. */
export const workspaceAgeLabel = (timestamp: number): string => {
    const ms = Date.now() - (Number.isFinite(timestamp) ? timestamp : Date.now());
    if (ms < 60_000) return 'now';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
};



export interface ConversationGroupsProps {
    conversations: Conversation[];
    activeConversationId: string | null;
    onNewChat: () => void;
    onOpenConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    /** Agents whose turns are still streaming — their rows pulse in ink. */
    runningAgentIds?: ReadonlySet<string>;
    /** Pinned conversation ids — the Pinned group renders only when > 0. */
    pinnedIds?: ReadonlySet<string>;
    /** Pin/unpin from the row's actions menu (the trader's own keep-at-top). */
    onTogglePin?: (id: string) => void;
    onOpenSearch?: () => void;
    /** Utility routes beside Recents: Settings (Memory/Skills) and the
     *  Jobs/Activity drawer. Both already exist — these rows only name them. */
    onOpenSettings?: () => void;
    /** Customize lands on a specific Settings tab (Memory) rather than the
     *  gear's remembered section. Falls back to onOpenSettings. */
    onOpenCustomize?: () => void;
    onOpenActivity?: () => void;
}

const conversationBadgeFallback = (conversation: Conversation): string | null => {
    for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
        const a = conversation.messages[i].analysis;
        if (a?.coinName) {
            return formatThreadBadge(a.coinName, (a as { timeframe?: string }).timeframe ?? null);
        }
    }
    return null;
};

const ConversationRow: React.FC<{
    conversation: Conversation;
    selected: boolean;
    running: boolean;
    pinned: boolean;
    threadBadge?: string | null;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
    onClear: (id: string) => void;
    onTogglePin?: (id: string) => void;
}> = ({ conversation, selected, running, pinned, threadBadge, onOpen, onDelete, onClear, onTogglePin }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    // Inline rename: the row's own name becomes an input. Enter commits,
    // Escape cancels, a blur commits (unless Escape already cancelled it).
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState('');
    const renameCancelled = useRef(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const title = conversationTitle(conversation);
    const side = conversationSide(conversation);

    /** Commit a manual name through the store that owns the list (the row is
     *  rendered by two surfaces and receives the list read-only). Stamps
     *  `titleSource: 'user'`, which the model-title path can never replace. */
    const commitRename = (): void => {
        if (!renaming) return;
        setRenaming(false);
        if (renameCancelled.current) {
            renameCancelled.current = false;
            return;
        }
        const next = draft.replace(/\s+/g, ' ').trim();
        if (next && next !== title) renameConversationRow(conversation.id, next);
    };
    // The actions menu FLOATS above the list instead of pushing rows down:
    // an inline strip re-flowed every row under the opened one, which read
    // as the list jumping. Dismisses on Escape and on a click outside — the
    // same contract the header's session popover keeps.
    useEffect(() => {
        if (!menuOpen) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setMenuOpen(false);
        };
        const onPointer = (e: PointerEvent): void => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', onPointer);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('pointerdown', onPointer);
        };
    }, [menuOpen]);
    return (
        <div className={`group relative flex items-center rounded-lg transition-colors duration-150 ${
            selected
                ? 'bg-white/[0.07] text-zinc-100'
                : pinned
                    ? 'bg-white/[0.025] text-zinc-400 hover:bg-white/[0.05]'
                    : 'text-zinc-500 hover:bg-white/[0.04]'
        }`}>
            {renaming ? (
                <input
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        else if (e.key === 'Escape') {
                            e.preventDefault();
                            renameCancelled.current = true;
                            setRenaming(false);
                        }
                    }}
                    aria-label="Conversation title"
                    data-testid="conversation-rename-input"
                    className="min-w-0 flex-1 rounded-control border border-hairline bg-zinc-900 px-2 py-1 text-ui-caption text-zinc-100 focus:border-zinc-600 focus:outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => onOpen(conversation.id)}
                    title={title}
                    aria-current={selected ? 'page' : undefined}
                    data-testid="conversation-row"
                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left text-ui-caption transition-colors hover:text-zinc-100 ${
                        selected ? 'pr-8' : 'pr-2.5'
                    }`}
                >
                    <span
                        aria-hidden="true"
                        title={running ? 'running' : selected ? 'active' : undefined}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-zinc-300' : selected ? 'bg-zinc-100' : 'border border-zinc-600/60'}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {threadBadge && (
                        <span
                            data-testid="conversation-symbol-badge"
                            className="shrink-0 rounded-control border border-hairline px-1.5 py-0.5 font-mono text-ui-2xs leading-none text-zinc-500"
                        >
                            {threadBadge}
                        </span>
                    )}
                    {side && (
                        <span data-testid="conversation-side"
                            className={`shrink-0 font-mono text-ui-2xs uppercase tracking-wide ${side === 'Long' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {side}
                        </span>
                    )}
                    <span
                        className="shrink-0 font-mono tabular-nums text-ui-2xs text-zinc-600"
                        data-testid="conversation-age"
                        aria-hidden="true"
                    >
                        {workspaceAgeLabel(conversation.timestamp)}
                    </span>
                </button>
            )}
            {selected && !renaming && (
                <button
                    type="button"
                    aria-label={`Conversation actions for ${title}`}
                    aria-expanded={menuOpen}
                    title="Conversation actions"
                    onClick={() => setMenuOpen(m => !m)}
                    className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                >
                    <span aria-hidden="true" className="text-ui-caption leading-none">⋯</span>
                </button>
            )}
            {menuOpen && (
                <div
                    ref={menuRef}
                    className="motion-popover-down absolute right-1 top-full z-20 mt-0.5 flex flex-col rounded-xl border border-white/[0.08] bg-zinc-900/95 py-1 shadow-elevated backdrop-blur-md"
                >
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onTogglePin?.(conversation.id); }}
                        className="whitespace-nowrap px-3 py-1.5 text-left text-ui-xs text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                        {pinned ? 'Unpin' : 'Pin to top'}
                    </button>
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); setDraft(title); setRenaming(true); }}
                        className="whitespace-nowrap px-3 py-1.5 text-left text-ui-xs text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                        Rename
                    </button>
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onClear(conversation.id); }}
                        className="whitespace-nowrap px-3 py-1.5 text-left text-ui-xs text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                        Clear messages
                    </button>
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onDelete(conversation.id); }}
                        className="whitespace-nowrap px-3 py-1.5 text-left text-ui-xs text-rose-400/90 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                    >
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
};

export const ConversationGroups: React.FC<ConversationGroupsProps> = ({
    conversations, activeConversationId, onNewChat, onOpenConversation,
    onDeleteConversation, onClearConversation, runningAgentIds, pinnedIds,
    onTogglePin, onOpenSearch,
    onOpenSettings, onOpenCustomize, onOpenActivity,
}) => {
    // A conversation with no messages is a placeholder, not a record: it is
    // hidden unless it is the one on screen (a fresh New chat stays visible).
    const rows = useMemo(
        () => [...conversations]
            .filter(c => c.messages.length > 0 || c.id === activeConversationId)
            .sort((a, b) => b.timestamp - a.timestamp),
        [conversations, activeConversationId],
    );
    const pinned = useMemo(
        () => pinnedIds ? rows.filter(c => pinnedIds.has(c.id)) : rows.filter(c => (c as Conversation & { pinned?: boolean }).pinned),
        [rows, pinnedIds],
    );
    const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const badgeByConvId = useMemo(() => {
        const m = new Map<string, string>();
        for (const s of snap.sessions) {
            if (!s.conversationId) continue;
            const b = formatThreadBadge(s.symbol, s.interval);
            if (b) m.set(s.conversationId, b);
        }
        return m;
    }, [snap.sessions]);
    const recent = useMemo(
        () => rows.filter(c => !pinnedIds?.has(c.id) && !(c as Conversation & { pinned?: boolean }).pinned),
        [rows, pinnedIds],
    );
    const isRunning = (id: string): boolean => runningAgentIds?.has(id) ?? false;
    // Search is app-level: the row publishes a window event and App opens its
    // search drawer over the existing unified session search. The optional
    // callback is a direct route for hosts that own the drawer themselves.
    const openSearch = (): void => {
        window.dispatchEvent(new CustomEvent('august:open-search'));
        onOpenSearch?.();
    };
    const utilityRows: Array<{ id: string; label: string; testid: string; onClick: () => void }> = [
        { id: 'search', label: 'Search', testid: 'rail-search', onClick: openSearch },
        { id: 'customize', label: 'Customize', testid: 'rail-customize', onClick: () => (onOpenCustomize ?? onOpenSettings)?.() },
        { id: 'watches', label: 'Watches', testid: 'rail-watches', onClick: () => onOpenActivity?.() },
    ];

    return (
        <div className="flex min-h-0 flex-1 flex-col px-2 pt-2">
            <div className="flex shrink-0 flex-col gap-0.5">
                <button
                    type="button"
                    data-testid="rail-new-chat"
                    aria-label="New chat"
                    title="New chat · Ctrl+K"
                    onClick={onNewChat}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ui-caption text-zinc-300 transition-colors duration-150 ease-[var(--ease-out-expo)] hover:bg-white/[0.06] hover:text-zinc-100"
                >
                    <span className="text-ui-base leading-none" aria-hidden="true">+</span>
                    <span className="flex-1 truncate">New chat</span>
                </button>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto custom-scrollbar" data-testid="shell-conversations">
                {/* Quiet utility rows above Recents. They share the list's
                    typography and hit target so they read as navigation, not
                    as a second toolbar; each names an existing destination. */}
                <div className="mb-2 flex flex-col gap-0.5">
                    {utilityRows.map(row => (
                        <button
                            key={row.id}
                            type="button"
                            aria-label={row.label}
                            data-testid={row.testid}
                            onClick={row.onClick}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui-caption text-zinc-500 transition-colors duration-150 hover:bg-white/[0.04] hover:text-zinc-200"
                        >
                            <span className="min-w-0 flex-1 truncate">{row.label}</span>
                        </button>
                    ))}
                </div>
                {pinned.length > 0 && (
                    <div className="mb-2">
                        <div className="px-2.5 pb-1 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-600">Pinned</div>
                        {pinned.map(conversation => (
                            <ConversationRow
                                key={conversation.id}
                                conversation={conversation}
                                selected={conversation.id === activeConversationId}
                                running={isRunning(conversation.id)}
                                pinned
                                threadBadge={badgeByConvId.get(conversation.id) ?? conversationBadgeFallback(conversation)}
                                onTogglePin={onTogglePin}
                                onOpen={onOpenConversation}
                                onDelete={onDeleteConversation}
                                onClear={onClearConversation}
                            />
                        ))}
                    </div>
                )}
                <div className="mb-2">
                    {/* A plain section heading: the sidebar's ONE collapse toggle
                        is the control beside the [Desk | Chat] pill (ShellRail).
                        A second collapse icon here was the duplicate the UI
                        audit flagged — two icons, one behaviour, and the trader
                        could not tell which one owned the put-away. */}
                    <div className="px-2.5 pb-1 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-600">Recent</div>
                    {recent.length === 0 && pinned.length === 0 ? (
                        <p className="px-2.5 py-2 text-ui-xs leading-relaxed text-zinc-600">
                            No conversations yet. Everything you ask the desk lands here.
                        </p>
                    ) : recent.map(conversation => (
                        <ConversationRow
                            key={conversation.id}
                            conversation={conversation}
                            selected={conversation.id === activeConversationId}
                            running={isRunning(conversation.id)}
                                pinned={false}
                                threadBadge={badgeByConvId.get(conversation.id) ?? conversationBadgeFallback(conversation)}
                                onTogglePin={onTogglePin}
                            onOpen={onOpenConversation}
                            onDelete={onDeleteConversation}
                            onClear={onClearConversation}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};

export default React.memo(ConversationGroups);
