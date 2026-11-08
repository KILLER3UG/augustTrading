/**
 * NewGroupDialog — the "New Group Chat" dialog: pick two or
 * more bots; the room fans one prompt out to every member with an
 * activity feed (@name to direct, @everyone for all). In edit mode it is
 * Group Settings: who is in the room, and nothing else — the analyst roles
 * that used to ride the bots were removed by owner ruling (2026-10-19).
 */

import React from 'react';
import { Check, X } from '../shared/Icons';
import { BotAvatar } from './BotAvatar';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { type AgentBot, type AgentGroup } from '../../services/agents/agentRoster';

export interface NewGroupDialogProps {
    open: boolean;
    onClose: () => void;
    onCreate: (memberIds: string[]) => void;
    /** Edit mode: update this room's membership instead of creating. */
    initialGroup?: AgentGroup | null;
    onUpdate?: (groupId: string, memberIds: string[]) => void;
    bots: AgentBot[];
}

export const NewGroupDialog: React.FC<NewGroupDialogProps> = ({ open, onClose, onCreate, initialGroup, onUpdate, bots }) => {
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const editing = Boolean(initialGroup && onUpdate);
    useEscapeClose(open, onClose);
    // Same trap as the New Bot dialog: the member picker is a list of
    // checkboxes inside a blocking overlay, and Tab used to walk straight
    // past it onto the page behind (O-66).
    const dialogRef = useFocusTrap<HTMLDivElement>(open);

    React.useEffect(() => {
        if (!open) return;
        setSelected(new Set(initialGroup?.memberIds ?? []));
    }, [open, initialGroup]);

    if (!open) return null;

    const toggle = (id: string): void => {
        const next = new Set(selected);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        setSelected(next);
    };

    const membershipChanged = editing
        ? selected.size !== (initialGroup?.memberIds.length ?? 0)
            || ![...selected].every(id => initialGroup?.memberIds.includes(id))
        : false;
    const saveDisabled = selected.size < 2 || (editing && !membershipChanged);

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="New Group Chat">
            <div className="w-full max-w-md rounded-bubble border border-hairline bg-zinc-950 p-6 shadow-2xl" data-testid="new-group-dialog">
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-zinc-100">{editing ? 'Group Settings' : 'New Group Chat'}</h2>
                        <p className="mt-1 text-ui-sm leading-snug text-zinc-500">
                            {editing
                                ? 'Change who is in this room. The transcript stays.'
                                : 'One prompt goes to every member, one at a time, with a live activity feed. @name to direct, @everyone for all.'}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close new group dialog"
                        className="rounded-control p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <ul className="mt-4 max-h-72 space-y-1 overflow-y-auto">
                    {bots.map(bot => {
                        const checked = selected.has(bot.id);
                        return (
                            <li key={bot.id}>
                                <div className={`rounded-control px-3 py-2 transition-colors ${checked ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}>
                                    <button
                                        type="button"
                                        onClick={() => toggle(bot.id)}
                                        data-testid={`group-member-${bot.id}`}
                                        aria-pressed={checked}
                                        className="flex w-full items-center gap-3 text-left"
                                    >
                                        <span
                                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-control border ${
                                                checked ? 'border-zinc-200 bg-zinc-200' : 'border-zinc-600'
                                            }`}
                                        >
                                            {checked && <Check className="h-3 w-3 text-zinc-900 stroke-[3]" aria-hidden="true" />}
                                        </span>
                                        <BotAvatar bot={bot} size={30} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-ui-caption font-semibold text-zinc-100" title={bot.name}>{bot.name}</span>
                                            {bot.title && <span className="block truncate text-ui-dense text-zinc-500" title={bot.title}>{bot.title}</span>}
                                        </span>
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                    {bots.length === 0 && (
                        <li className="px-2 py-3 text-ui-sm text-zinc-500">
                            Create a Bot first — groups are made of bots.
                        </li>
                    )}
                </ul>

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-control px-4 py-2 text-ui-caption font-semibold text-zinc-400 hover:text-zinc-200"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (editing && initialGroup) onUpdate?.(initialGroup.id, [...selected]);
                            else onCreate([...selected]);
                            onClose();
                        }}
                        disabled={saveDisabled}
                        data-testid="create-group"
                        className="rounded-control bg-zinc-200 px-4 py-2 text-ui-caption font-bold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {editing ? 'Save' : `Create Group${selected.size >= 2 ? ` (${selected.size})` : ''}`}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default NewGroupDialog;
