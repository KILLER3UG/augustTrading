/**
 * WorkspaceHome — the workspace's record view, drawn in the main column beside
 * the Chart AI dock.
 *
 * The reference (owner, 2026-11-03) draws a workspace as a HOME: a mark, two
 * actions (New workspace, Restore from backup), then the workspace list with a
 * name and one quiet subtitle line. Conversations are NOT a second list here:
 * they live in the sidebar's list column (ConversationGroups), which is the
 * record's one home, so this screen names the workspaces and stops there.
 *
 * Presentation-only. App owns profiles, conversations and routing; this
 * component renders what it passes and reports clicks upward. Type and spacing
 * follow the reference: a 460px column, 38px actions, 54px workspace rows,
 * 12.5px names and 11px mono subtitles.
 */

import React, { useState } from 'react';
import { FolderIcon } from '../shared/Icons';

/** The reference's age column: now, 5m, 3h, 48d — days for anything older. */
export const workspaceAgeLabel = (timestamp: number): string => {
    const ms = Date.now() - (Number.isFinite(timestamp) ? timestamp : Date.now());
    if (ms < 60_000) return 'now';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
};

export interface WorkspaceOption {
    name: string;
    active: boolean;
    /** Conversations in this profile, or null when only the active profile's
     *  store is loaded — an unknown count must not be printed as 0. */
    conversations: number | null;
}

export interface WorkspaceHomeProps {
    workspaces: WorkspaceOption[];
    onOpenWorkspace: (name: string) => void;
    onNewWorkspace: () => void;
    onRestoreBackup: () => void;
    /** History is reachable from the workspace list's foot, the way the
     *  reference's home leads into its records. */
    /** Reveal the sidebar's conversation list — the record's one home. */
    onShowConversations: () => void;
}

const workspaceSubtitle = (ws: WorkspaceOption): string => (
    ws.conversations === null
        ? 'profile'
        : `profile · ${ws.conversations} conversation${ws.conversations === 1 ? '' : 's'}`
);

export const WorkspaceHome: React.FC<WorkspaceHomeProps> = ({
    workspaces, onOpenWorkspace, onNewWorkspace, onRestoreBackup, onShowConversations,
}) => {
    const [expanded, setExpanded] = useState(false);
    const visible = expanded ? workspaces : workspaces.slice(0, 5);
    const hasMore = workspaces.length > 5;

    return (
        <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto custom-scrollbar" data-testid="workspace-home">
            <div className="w-[460px] max-w-[calc(100%-48px)] py-[72px] pb-12">
                <div className="flex flex-col items-center gap-2.5">
                    <span aria-hidden="true" className="flex h-[46px] w-[46px] items-center justify-center text-zinc-100">
                        <svg viewBox="0 0 24 24" width="42" height="42" fill="none">
                            <path d="M12 3 4.5 20h4.2L12 12l3.3 8h4.2L12 3Z" fill="currentColor" />
                        </svg>
                    </span>
                    <span className="text-ui-sm font-semibold tracking-[-0.01em] text-zinc-100">August Trading</span>
                </div>

                <div className="mt-[26px] flex flex-col gap-2">
                    <button
                        type="button"
                        onClick={onNewWorkspace}
                        data-testid="workspace-home-new"
                        className="flex h-[38px] items-center justify-center gap-2 rounded-[7px] bg-zinc-100 text-ui-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
                    >
                        <FolderIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        New workspace
                    </button>
                    <button
                        type="button"
                        onClick={onRestoreBackup}
                        className="flex h-[38px] items-center justify-center gap-2 rounded-[7px] border border-white/[0.08] bg-white/[0.05] text-ui-sm text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100"
                    >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
                        </svg>
                        Restore from backup
                    </button>
                </div>

                <div className="mb-2.5 mt-[30px] px-0.5 text-ui-sm font-semibold text-zinc-400">Workspaces</div>
                <div className="flex flex-col gap-1.5">
                    {visible.map(ws => (
                        <button
                            key={ws.name}
                            type="button"
                            onClick={() => onOpenWorkspace(ws.name)}
                            data-testid={`workspace-home-${ws.name}`}
                            title={ws.active ? `Open ${ws.name}` : `Switch to ${ws.name}`}
                            className="w-full rounded-[7px] border border-white/[0.06] bg-white/[0.015] px-3 py-2.5 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.035]"
                        >
                            <span className="block truncate text-ui-sm text-zinc-100">{ws.name}</span>
                            <span className="mt-[3px] block truncate font-mono text-[11px] text-zinc-600">{workspaceSubtitle(ws)}</span>
                        </button>
                    ))}
                </div>
                {hasMore && (
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="mt-1 h-[34px] w-full text-ui-sm text-zinc-600 transition-colors hover:text-zinc-300"
                    >
                        Show more…
                    </button>
                )}
                <button
                    type="button"
                    onClick={onShowConversations}
                    data-testid="workspace-home-history"
                    className="mt-6 flex h-[34px] w-full items-center justify-center gap-2 text-ui-sm text-zinc-500 transition-colors hover:text-zinc-200"
                >
                    All conversations
                </button>
            </div>
        </div>
    );
};

export interface HistoryConversation {
    id: string;
    title: string;
    /** The workspace (profile) the conversation belongs to. */
    workspace: string;
    updatedAt: number;
    active?: boolean;
}
