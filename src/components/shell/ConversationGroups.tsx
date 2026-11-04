/**
 * ConversationGroups — the shell's shared conversation list.
 *
 * One component, two homes: ShellRail (Analyze) and AgentsView (Chat) render
 * the same rows so a conversation reads identically on either surface.
 * Sparse: New chat + Ctrl K, Pinned (only when there are pinned rows),
 * Recent (always). Rows: hollow dot (filled active, amber pulsing running),
 * truncated title, mono age from `workspaceAgeLabel` (single source).
 *
 * This file did NOT exist on clean HEAD — created for mock-redesign-v3.
 * The age helper lives here; nothing else defines it.
 */

import React, { useMemo, useState } from 'react';
import type { Conversation } from '../../types';

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

const conversationTitle = (conversation: Conversation): string =>
    conversation.title?.trim() || 'New chat';

export interface ConversationGroupsProps {
    conversations: Conversation[];
    activeConversationId: string | null;
    onNewChat: () => void;
    onOpenConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    /** Agents whose turns are still streaming — their rows pulse amber. */
    runningAgentIds?: ReadonlySet<string>;
    /** Pinned conversation ids — the Pinned group renders only when > 0. */
    pinnedIds?: ReadonlySet<string>;
    onOpenSearch?: () => void;
}

const ConversationRow: React.FC<{
    conversation: Conversation;
    selected: boolean;
    running: boolean;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
    onClear: (id: string) => void;
}> = ({ conversation, selected, running, onOpen, onDelete, onClear }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const title = conversationTitle(conversation);
    return (
        <div className={`group relative flex items-center rounded-control ${
            selected ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-500'
        }`}>
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
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-amber-400' : selected ? 'bg-zinc-100' : 'border border-zinc-600/60'}`}
                />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span
                    className="shrink-0 font-mono tabular-nums text-ui-2xs text-zinc-600"
                    data-testid="conversation-age"
                    aria-hidden="true"
                >
                    {workspaceAgeLabel(conversation.timestamp)}
                </span>
            </button>
            {selected && (
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
                <div className="mb-1 flex items-center gap-1 pl-6">
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onClear(conversation.id); }}
                        className="rounded-control px-2 py-1 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                        Clear messages
                    </button>
                    <button
                        type="button"
                        onClick={() => { setMenuOpen(false); onDelete(conversation.id); }}
                        className="rounded-control px-2 py-1 text-ui-xs text-rose-400/90 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
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
}) => {
    const rows = useMemo(
        () => [...conversations].sort((a, b) => b.timestamp - a.timestamp),
        [conversations],
    );
    const pinned = useMemo(
        () => pinnedIds ? rows.filter(c => pinnedIds.has(c.id)) : rows.filter(c => (c as Conversation & { pinned?: boolean }).pinned),
        [rows, pinnedIds],
    );
    const recent = useMemo(
        () => rows.filter(c => !pinnedIds?.has(c.id) && !(c as Conversation & { pinned?: boolean }).pinned),
        [rows, pinnedIds],
    );
    const isRunning = (id: string): boolean => runningAgentIds?.has(id) ?? false;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-0.5">
                <button
                    type="button"
                    data-testid="rail-new-chat"
                    aria-label="New chat"
                    title="New chat · Ctrl+K"
                    onClick={onNewChat}
                    className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ui-caption text-zinc-400 transition-colors duration-150 ease-[var(--ease-snappy)] hover:bg-white/[0.05] hover:text-zinc-100"
                >
                    <span className="text-ui-base leading-none" aria-hidden="true">+</span>
                    <span className="flex-1 truncate">New chat</span>
                    <kbd className="shrink-0 rounded border border-zinc-700/60 px-1 font-mono text-ui-2xs text-zinc-600" aria-hidden="true">⌘K</kbd>
                </button>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto custom-scrollbar" data-testid="shell-conversations">
                {pinned.length > 0 && (
                    <div className="mb-2">
                        <div className="px-2.5 pb-1 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-600">Pinned</div>
                        {pinned.map(conversation => (
                            <ConversationRow
                                key={conversation.id}
                                conversation={conversation}
                                selected={conversation.id === activeConversationId}
                                running={isRunning(conversation.id)}
                                onOpen={onOpenConversation}
                                onDelete={onDeleteConversation}
                                onClear={onClearConversation}
                            />
                        ))}
                    </div>
                )}
                <div className="mb-2">
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
