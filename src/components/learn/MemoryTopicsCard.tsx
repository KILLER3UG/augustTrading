import React, { useEffect, useMemo, useState } from 'react';
import { NotebookPen, Pencil, Trash2 } from '../shared/Icons';
import { useToastActions } from '../shared/Toast';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import {
    deleteMemoryFile,
    getMemoryFiles,
    getMemoryFilesOwner,
    subscribeMemoryFilesChanged,
    updateMemoryFile,
} from '../../services/learning/MemoryFilesService';
import {
    memorySectionLabel,
    memoryUpdatedLabel,
    memoryTopicsFromStore,
    topicSummaryOf,
    type MemoryTopic,
} from '../../services/learning/memoryTopics';

/**
 * MemoryTopicsCard — the notebook read as CONTENT (gap 2 of
 * docs/plan/open-items.md).
 *
 * The reference's Settings → Memory opens on a list of named topics, each
 * with a one-line summary and an "Updated" stamp. August's memory tab opened
 * on the raw file manager, so finding out what the app believed meant reading
 * folders and markdown. This card is the index: every row IS a notebook file
 * (no copy, no second store — read live through the store subscription), and
 * pressing one opens the entry's detail in the right panel.
 *
 * The ROW GRAMMAR is the reference's, because the reference is what the owner
 * asked for:
 *
 *   - a SECTION HEADING per group (the notebook folder), the way the
 *     reference heads its list with "Topics" and "Areas";
 *   - THREE COLUMNS — the label (what the entry is called), the description
 *     (what it says, in one line) and the updated date (when it was last
 *     written). The columns are real: they come from the file's name, its
 *     summary and its `updatedAt`. Nothing here invents a timestamp;
 *   - HAIRLINES between the rows, not cards;
 *   - the SELECTED row is a raised panel, and it alone carries the
 *     pencil and the trash.
 *
 * What is deliberately NOT here: skills (the Skills tab's library owns those)
 * and harness-maintained files (diary/profile/rules — they regenerate, and a
 * Delete that does not stick is a lie the surface must not tell). Those stay
 * browsable in the file manager below.
 */

/**
 * The list's date column — ONE formatter for every memory surface.
 *
 * The reference writes the column two ways: "Updated Aug 21" for an entry
 * that has settled, and "Updated 4 days ago" for one that is still moving.
 * This keeps that rule and uses the repo's own clock (PHT day keys, so a
 * trading evening does not split across two days) and the repo's own date
 * formatter (`phtDay`).
 *
 * It LIVES in `services/learning/memoryTopics.ts` — the module that owns this
 * surface's vocabulary — because a vocabulary that two components import is
 * two vocabularies the moment one of them edits it. This re-export keeps the
 * old import path working, and the Settings card now reads the service
 * directly.
 */
export { memoryUpdatedLabel };

interface MemoryTopicsCardProps {
    onOpenTopic: (fileId: string) => void;
}

const MemoryTopicsCard: React.FC<MemoryTopicsCardProps> = ({ onOpenTopic }) => {
    const [version, setVersion] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');

    const toast = useToastActions();
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();

    useEffect(() => subscribeMemoryFilesChanged(() => setVersion(v => v + 1)), []);

    const topics = useMemo<MemoryTopic[]>(() => {
        void version;
        const store = getMemoryFiles();
        return memoryTopicsFromStore(store.files, store.folders);
    }, [version]);

    /** The rows, grouped by the notebook folder they live in. The group order
     *  is the order the folders first appear in the (newest-first) list. */
    const groups = useMemo(() => {
        const byFolder = new Map<string, MemoryTopic[]>();
        for (const t of topics) {
            const list = byFolder.get(t.folderName);
            if (list) list.push(t);
            else byFolder.set(t.folderName, [t]);
        }
        return [...byFolder.entries()].map(([name, rows]) => ({ name, label: memorySectionLabel(name), rows }));
    }, [topics]);

    /** The notebook's owner — the cache this list reads is loaded for one
     *  user, and a write must go to that user's notebook, not to a default. */
    const owner = (): string => getMemoryFilesOwner() ?? 'default';

    const openTopic = (t: MemoryTopic): void => {
        setSelectedId(t.file.id);
        onOpenTopic(t.file.id);
    };

    const startEdit = (t: MemoryTopic): void => {
        setEditingId(t.file.id);
        setDraft(t.file.content);
    };

    const cancelEdit = (): void => {
        setEditingId(null);
        setDraft('');
    };

    const saveEdit = async (t: MemoryTopic): Promise<void> => {
        try {
            await updateMemoryFile(t.file.id, { content: draft }, owner());
            cancelEdit();
            toast.success('Entry saved', `"${t.file.name}" now says what you wrote.`);
        } catch (e: unknown) {
            toast.error('Could not save', e instanceof Error ? e.message : 'Unknown error');
        }
    };

    const deleteTopic = async (t: MemoryTopic): Promise<void> => {
        const ok = await confirm({
            title: `Delete "${t.file.name.replace(/\.md$/i, '')}"?`,
            message: 'This entry will be permanently removed from the notebook. The model will stop reading it.',
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (!ok) return;
        try {
            await deleteMemoryFile(t.file.id, owner());
            if (selectedId === t.file.id) setSelectedId(null);
            if (editingId === t.file.id) cancelEdit();
            toast.success('Entry deleted', `"${t.file.name}" is no longer in the notebook.`);
        } catch (e: unknown) {
            toast.error('Could not delete', e instanceof Error ? e.message : 'Unknown error');
        }
    };

    const renderRow = (t: MemoryTopic) => {
        const label = t.file.name.replace(/\.md$/i, '');
        const selected = selectedId === t.file.id;
        const editing = editingId === t.file.id;

        if (editing) {
            // The pencil edits the entry where the entry is listed — the
            // reference's list edits in place, and the notebook browser below
            // keeps the full editor for the raw markdown.
            return (
                <li key={t.file.id} className="px-1 py-2">
                    <div className="rounded-control bg-zinc-800 p-3">
                        <label htmlFor={`memory-topic-edit-${t.file.id}`} className="sr-only">
                            Edit {label}
                        </label>
                        <textarea
                            id={`memory-topic-edit-${t.file.id}`}
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            spellCheck={false}
                            className="min-h-24 w-full resize-y rounded-control border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-ui-dense leading-relaxed text-zinc-100 outline-none focus:border-zinc-500"
                        />
                        <div className="mt-2 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={cancelEdit}
                                className="rounded-control px-3 py-1.5 text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => { void saveEdit(t); }}
                                className="rounded-control bg-zinc-100 px-3 py-1.5 text-ui-dense font-semibold text-zinc-950 transition-opacity hover:opacity-90"
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </li>
            );
        }

        return (
            <li key={t.file.id}>
                <div className={`flex items-center gap-2 pr-3 ${selected ? 'rounded-control bg-zinc-800' : ''}`}>
                    <button
                        type="button"
                        onClick={() => openTopic(t)}
                        aria-label={`Read ${label}`}
                        aria-current={selected ? 'true' : undefined}
                        className="flex min-w-0 flex-1 items-center gap-4 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                    >
                        <span
                            className="w-[26%] min-w-0 shrink-0 truncate text-ui-base font-medium text-zinc-100"
                            title={label}
                        >
                            {label}
                        </span>
                        <span
                            className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500"
                            title={topicSummaryOf(t.file.content)}
                        >
                            {t.summary}
                        </span>
                        <span className="w-28 shrink-0 text-right text-ui-dense text-zinc-500 tabular-nums">
                            {memoryUpdatedLabel(t.file.updatedAt)}
                        </span>
                    </button>
                    {/* The actions sit in their own column, and that column is
                        the same width on every row — so the dates above stay
                        aligned whether or not this row is the selected one. */}
                    <span className="flex w-16 shrink-0 justify-end gap-1">
                        {selected && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => startEdit(t)}
                                    aria-label={`Edit ${label}`}
                                    title="Edit this entry"
                                    className="rounded-control p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                                >
                                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { void deleteTopic(t); }}
                                    aria-label={`Delete ${label}`}
                                    title="Delete this entry"
                                    className="rounded-control p-1 text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                                >
                                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            </>
                        )}
                    </span>
                </div>
            </li>
        );
    };

    return (
        <section className="rounded-control border border-zinc-800/80 bg-zinc-900/60" data-testid="memory-topics">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-4 py-3">
                <div className="min-w-0 flex items-center gap-2">
                    <NotebookPen className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <h3 className="truncate text-ui-sm font-semibold text-zinc-100" title="Memory topics">Memory topics</h3>
                </div>
                <span className="shrink-0 text-ui-2xs text-zinc-600" data-testid="memory-topics-count">
                    {topics.length} {topics.length === 1 ? 'entry' : 'entries'}
                </span>
            </div>

            {topics.length === 0 ? (
                <p className="px-4 py-4 text-ui-dense text-zinc-500" data-testid="memory-topics-empty">
                    Nothing here yet. Entries you write — and the corrections you approve —
                    show up here as topics. The harness keeps its own diary, profile and rules
                    in the file manager below.
                </p>
            ) : (
                <div className="pb-1" data-testid="memory-topics-list">
                    {groups.map(group => (
                        <section key={group.name} className="mt-3 first:mt-0">
                            <h4 className="px-3 pb-1 text-ui-base font-semibold text-zinc-100">{group.label}</h4>
                            <ul className="divide-y divide-zinc-800/80">
                                {group.rows.map(renderRow)}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
            {ConfirmDialogComponent}
        </section>
    );
};

export default React.memo(MemoryTopicsCard);
