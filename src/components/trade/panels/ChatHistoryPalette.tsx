/**
 * ChatHistoryPalette — the "Past Conversations" overlay (the reference's
 * history command): search box, "Recent" rows with relative times, keyboard
 * nav, and the "Show N more…" cap. Extracted from TradeChatPanel unchanged.
 *
 * The dock keeps owning the palette's open/query/selection state — the header
 * button resets three of those at once — and does the filtering, so this
 * component receives the already-narrowed rows and reports interactions up.
 *
 * A row can be RENAMED inline. The write goes through `chatStore.mutate`
 * (stamping `titleSource: 'user'`), the same store every other dock write
 * uses, so the host needs no new prop and the manual name is final: the
 * model-title path refuses to replace a `'user'` source.
 */

import React, { useRef, useState } from 'react';
import { Pencil, Trash2 } from '../../shared/Icons';
import * as chatStore from '../../../services/trade/chatStore';
import type { LiveSession } from '../../../services/trade/chatStore';
import { MANUAL_TITLE_MAX_CHARS } from '../../../utils/conversationTitle';
import { ageMinutes, agoLabel } from '../../../utils/relativeTime';

/** "2 days ago" style relative time — the palette's right column, copied from
 *  the reference's recency labels. Shared with the dock header's "answered"
 *  meta, which is why it is exported here. The ladder and the one subtraction
 *  are `utils/relativeTime`'s, so the palette, the header and the transcript's
 *  prov line cannot disagree about how old a turn is. */
export const relTime = (ts: number): string => agoLabel(ageMinutes(ts));

export interface ChatHistoryPaletteProps {
    /** Title-filtered, newest-first, already capped by the show-all toggle. */
    rows: LiveSession[];
    /** Rows the cap is hiding behind "Show N more…". */
    hidden: number;
    /** The highlighted row index (mouse hover and arrow keys share it). */
    sel: number;
    /** The search box text. */
    query: string;
    /** Session currently open in the dock — its row is emphasised. */
    activeId: string;
    /** More than one session exists, so rows may offer delete. */
    canDelete: boolean;
    onQueryChange: (value: string) => void;
    /** Passed straight from the dock's useState setter, so the arrow-key
     *  clamping keeps its functional-update semantics. */
    onSelChange: React.Dispatch<React.SetStateAction<number>>;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onShowAll: () => void;
    onClose: () => void;
}

const ChatHistoryPalette: React.FC<ChatHistoryPaletteProps> = ({
    rows, hidden, sel, query, activeId, canDelete,
    onQueryChange, onSelChange, onSelect, onDelete, onShowAll, onClose,
}) => {
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    // Escape unmounts the input; the blur it triggers must not then commit.
    const renameCancelled = useRef(false);

    /** Write a manual name. One path (`chatStore.mutate`) → the debounced
     *  persist, and `titleSource: 'user'` makes it final against the model. */
    const commitRename = (id: string): void => {
        if (renameCancelled.current) {
            renameCancelled.current = false;
            return;
        }
        const next = draft.replace(/\s+/g, ' ').trim().slice(0, MANUAL_TITLE_MAX_CHARS);
        if (next) chatStore.mutate(id, s => ({ ...s, title: next, titleSource: 'user' as const }));
        setRenamingId(null);
    };

    return (
        <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/50 px-6 pt-20" data-testid="chat-history-backdrop" onClick={onClose}>
        <div className="w-full max-w-sm overflow-hidden rounded-bubble border border-hairline bg-zinc-900 shadow-elevated" data-testid="chat-history" onClick={e => e.stopPropagation()}>
            <input
                autoFocus
                value={query}
                onChange={e => { onQueryChange(e.target.value); onSelChange(0); }}
                onKeyDown={e => {
                    if (e.key === 'Escape') onClose();
                    else if (e.key === 'ArrowDown') { e.preventDefault(); onSelChange(i => Math.min(i + 1, rows.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); onSelChange(i => Math.max(i - 1, 0)); }
                    else if (e.key === 'Enter') { const s = rows[sel]; if (s) onSelect(s.id); }
                }}
                placeholder="Search all conversations…"
                aria-label="Search all conversations"
                className="w-full border-b border-hairline bg-transparent px-4 py-3 text-ui-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            <div className="max-h-72 overflow-y-auto custom-scrollbar px-1 pb-1">
                <p className="px-3 py-1 text-ui-xs text-zinc-600">Recent</p>
                {rows.length === 0 && <p className="px-3 py-2 text-ui-dense text-zinc-600">No conversations match.</p>}
                {rows.map((s, i) => (
                    <div key={s.id} className={`group flex items-center gap-2 rounded-control px-3 py-2 ${i === sel ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}>
                        {renamingId === s.id ? (
                            <input
                                autoFocus
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                onBlur={() => commitRename(s.id)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                                    else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        renameCancelled.current = true;
                                        setRenamingId(null);
                                    }
                                }}
                                aria-label={`Rename session ${s.title}`}
                                data-testid="session-rename-input"
                                className="min-w-0 flex-1 rounded-control border border-hairline bg-zinc-900 px-2 py-1 text-ui-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                            />
                        ) : (
                            <button type="button"
                                onClick={() => onSelect(s.id)}
                                onMouseEnter={() => onSelChange(i)}
                                className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
                                <span className={`truncate text-ui-sm ${s.id === activeId ? 'font-semibold text-zinc-100' : 'text-zinc-300'}`} title={`${s.kind === 'panel' ? '◆ ' : ''}${s.title}`}>{s.kind === 'panel' ? '◆ ' : ''}{s.title}</span>
                                <span className="shrink-0 text-ui-xs text-zinc-600">{relTime(s.updatedAt)}</span>
                            </button>
                        )}
                        {renamingId !== s.id && (
                            <button type="button" onClick={() => { setDraft(s.title); setRenamingId(s.id); }}
                                aria-label={`Rename session ${s.title}`} title="Rename"
                                className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-zinc-200">
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        )}
                        {canDelete && renamingId !== s.id && (
                            <button type="button" onClick={() => onDelete(s.id)} aria-label={`Delete session ${s.title}`}
                                className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400">
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                ))}
                {hidden > 0 && (
                    <button type="button" onClick={onShowAll}
                        className="w-full px-3 py-2 text-left text-ui-dense text-zinc-500 transition-colors hover:text-zinc-200">
                        Show {hidden} more…
                    </button>
                )}
            </div>
            <div className="flex items-center justify-between border-t border-hairline px-4 py-2 text-ui-xs text-zinc-600">
                <span>↑↓ to navigate</span>
                <span>↵ to select</span>
            </div>
        </div>
    </div>
    );
};

export default ChatHistoryPalette;
