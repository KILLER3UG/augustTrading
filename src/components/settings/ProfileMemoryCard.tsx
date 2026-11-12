/**
 * ProfileMemoryCard — the human surface for what the assistant remembers about
 * the trader. Settings → Memory.
 *
 * The shape is the reference Settings → Memory page: a short stack of switches,
 * then the entries as named TOPICS grouped under You / Topics / Areas, each row
 * three columns — the label, the one-line summary and the updated stamp — and a
 * row opens the entry's own page (Summary + Details + Delete).
 *
 * What the rows ARE: `profileMemory` entries (the typed user/feedback/project/
 * reference store the model writes with `remember`). Their `subject` decides the
 * group — 'preference'/'profile' under You, 'topic'/'person' under Topics,
 * 'area' under Areas — and legacy rows derive it from `kind`, so the page has
 * the same grouping the store's own readers use.
 *
 * Trading NOTES are not here: they are notebook files, browsed on the Learning
 * surface. The one row that reaches them is "Notebook files", because the two
 * stores are different and a Delete that silently removed a file would be a
 * promise this page cannot keep.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, Pencil, Trash2 } from '../shared/Icons';
import ToggleSwitch from '../shared/ToggleSwitch';
import StatusPill from '../ui/StatusPill';
import { exportTextAsFile } from '../../services/infrastructure/ExportService';
import { getHarnessSettings, saveHarnessSettings } from '../../utils/harnessSettings';
import { memoryEntryTitle, memoryUpdatedLabel } from '../../services/learning/memoryTopics';
import { phtDayYear } from '../../utils/timezone';
import { memoryExportFilename, memoryExportMarkdown } from '../../services/learning/memoryExport';
import {
    listProfileMemories, listDeletedProfileMemories, forgetProfileMemory, rememberProfileMemory,
    restoreProfileMemory, flushProfileMemoryWrites, type ProfileMemoryEntry,
} from '../../services/learning/profileMemory';
import { memorySectionOf, memorySectionSlug, orderMemorySections } from '../../services/learning/memorySections';
import { isTraderLearningEnabled, setTraderLearningEnabled } from '../../services/learning/traderLearner';

interface ProfileMemoryCardProps {
    /** Settings → Memory still owns the model pick; the row lives in this list. */
    memoryModel?: string;
    /** The notebook is the Learning surface's, so this is a door, not a copy. */
    onOpenNotebook?: () => void;
    /** The entry page replaces the page header, so the tab has to know when it
     *  is open. Fired from an effect on the resolved entry, which also covers a
     *  delete-from-detail: the list comes back and so does the heading. */
    onDetailOpenChange?: (open: boolean) => void;
}

const updatedLabelOf = (entry: ProfileMemoryEntry): string => {
    const at = Date.parse(entry.updatedAt);
    return Number.isFinite(at) ? memoryUpdatedLabel(at) : 'Updated unknown';
};

const rowUpdatedIso = (entry: ProfileMemoryEntry): string => {
    const at = Date.parse(entry.updatedAt);
    return Number.isFinite(at) ? new Date(at).toISOString() : 'unknown';
};

/** The detail page's date, in the reference's fuller form. The row's
 *  "Updated 1 day ago" is relative; this page names the day. */
const detailUpdatedOf = (entry: ProfileMemoryEntry): string => {
    const at = Date.parse(entry.updatedAt);
    return Number.isFinite(at) ? phtDayYear(at) : 'Unknown';
};

const ProfileMemoryCard: React.FC<ProfileMemoryCardProps> = ({ memoryModel, onOpenNotebook, onDetailOpenChange }) => {
    const [entries, setEntries] = useState<ProfileMemoryEntry[]>([]);
    const [deleted, setDeleted] = useState<ProfileMemoryEntry[]>([]);
    const [learning, setLearning] = useState(true);
    const [sensitive, setSensitive] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ slug: string; description: string; body: string; version?: number } | null>(null);
    const [editError, setEditError] = useState('');
    const [note, setNote] = useState('');

    const refresh = (): void => {
        setEntries([...listProfileMemories()].sort(
            (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
        ));
        setDeleted(listDeletedProfileMemories());
        setLearning(isTraderLearningEnabled());
        setSensitive(getHarnessSettings().sensitiveMemoryEnabled === true);
    };

    useEffect(() => {
        refresh();
        window.addEventListener('august-profile-memory', refresh);
        return () => window.removeEventListener('august-profile-memory', refresh);
    }, []);

    /** A row click opens its own page; the editor is the same page in edit mode. */
    const openEntry = (entry: ProfileMemoryEntry): void => {
        setSelected(entry.slug);
        setEditing(null);
        setEditError('');
    };

    const startEdit = (entry: ProfileMemoryEntry): void => {
        setSelected(entry.slug);
        setEditError('');
        setEditing({ slug: entry.slug, description: entry.description, body: entry.body, version: entry.version });
    };

    /** Save an edit as a STATED fact — the trader wrote it, so it outranks an
     *  observed one — and refuse silently losing a concurrent change. */
    const saveEdit = async (): Promise<void> => {
        if (!editing) return;
        const r = rememberProfileMemory({
            slug: editing.slug,
            description: editing.description.trim() || editing.slug,
            body: editing.body,
            kind: entries.find(e => e.slug === editing.slug)?.kind ?? 'user',
            subject: entries.find(e => e.slug === editing.slug)?.subject,
            tag: 'stated',
            ifVersion: editing.version,
        });
        if ('conflict' in r) {
            setEditError('This memory changed while you were editing it. Reopen it to see the current text.');
            return;
        }
        // The edit is queued to the notebook, not written yet. Close the editor
        // only once the write lands, or the trader sees a saved row that is not
        // on disk.
        const landed = await flushProfileMemoryWrites();
        if (r.persisted === false || !landed.ok) {
            setEditError(r.error ?? landed.error ?? 'The change could not be saved.');
            return;
        }
        setEditing(null);
        setEditError('');
        refresh();
    };

    const restoreOne = async (slug: string): Promise<void> => {
        const ok = restoreProfileMemory(slug);
        const landed = await flushProfileMemoryWrites();
        setNote(ok && landed.ok
            ? `Restored "${slug}".`
            : `"${slug}" could not be restored.${landed.error ? ` (${landed.error})` : ''}`);
        refresh();
    };

    /** Forget the named line, and say what ACTUALLY left. A row whose only
     *  source was this line goes with it, and a survivor that had absorbed other
     *  facts took those records down too — either case deletes more than the
     *  trader clicked, and a list that just shrinks under-reports it. */
    const forgetOne = async (slug: string): Promise<void> => {
        const r = forgetProfileMemory(slug);
        const landed = await flushProfileMemoryWrites();
        if (r.gone && !landed.ok) {
            setNote(`"${slug}" could not be removed from storage${landed.error ? ` (${landed.error})` : ''}. It is still on disk.`);
            refresh();
            return;
        }
        const extra = r.removed.length - 1;
        setNote(!r.gone
            ? `"${slug}" was already gone.`
            : extra > 0 || r.carried.length > 0
                ? `Forgot "${slug}"${extra > 0 ? ` and ${extra} other line${extra === 1 ? '' : 's'} derived solely from it (${r.removed.slice(1).join(', ')})` : ''}.`
                    + (r.carried.length > 0 ? ` It also carried the merged record of ${r.carried.join(', ')}.` : '')
                : `Forgot "${slug}".`);
        setSelected(null);
        refresh();
    };

    const exportMemory = async (): Promise<void> => {
        const result = await exportTextAsFile(memoryExportMarkdown(entries), memoryExportFilename());
        setNote(result.success
            ? `Exported ${entries.length} ${entries.length === 1 ? 'memory' : 'memories'} as Markdown.`
            : result.error ?? 'The export failed.');
    };

    /** One section per label the entries actually carry. A label the model
     *  invented ("Trading", "Risk Management") becomes a section of its own;
     *  rows with no explicit section fall back to their subject. */
    const sections = useMemo(() => {
        const bySection = new Map<string, ProfileMemoryEntry[]>();
        for (const entry of entries) {
            const label = memorySectionOf(entry);
            const list = bySection.get(label);
            if (list) list.push(entry); else bySection.set(label, [entry]);
        }
        return orderMemorySections([...bySection.keys()])
            .map(label => ({ label, id: memorySectionSlug(label), rows: bySection.get(label) ?? [] }))
            .filter(section => section.rows.length > 0);
    }, [entries]);

    const selectedEntry = selected ? entries.find(e => e.slug === selected) ?? null : null;

    useEffect(() => {
        onDetailOpenChange?.(selectedEntry !== null);
    }, [selectedEntry, onDetailOpenChange]);

    // ── The entry's own page ────────────────────────────────────────────────
    if (selectedEntry) {
        const provenance = [
            memorySectionOf(selectedEntry),
            selectedEntry.tag ?? 'stated',
        ].filter(Boolean).join(' · ');
        return (
            <div data-testid="profile-memory-card">
                <div data-testid="memory-detail">
                    <button
                        type="button"
                        onClick={() => { setSelected(null); setEditing(null); setEditError(''); }}
                        data-testid="memory-back"
                        className="inline-flex items-center gap-1 text-ui-dense font-medium text-zinc-400 transition-colors hover:text-zinc-100"
                    >
                        <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        Memory
                    </button>

                    <div className="mt-4 flex items-start justify-between gap-4">
                        <h3 className="min-w-0 text-ui-xl font-semibold leading-tight tracking-[-0.01em] text-zinc-100">
                            {memoryEntryTitle(selectedEntry)}
                        </h3>
                        <button
                            type="button"
                            onClick={() => forgetOne(selectedEntry.slug)}
                            data-testid="memory-delete"
                            className="shrink-0 rounded-control border border-zinc-800 px-3 py-1.5 text-ui-sm font-medium text-zinc-400 transition-colors hover:border-rose-500/40 hover:text-rose-300"
                        >
                            Delete
                        </button>
                    </div>

                    <div className="mt-4">
                        <p className="text-ui-sm text-zinc-500">Last updated</p>
                        <p className="mt-2.5 text-ui-sm text-zinc-200">{detailUpdatedOf(selectedEntry)}</p>
                    </div>

                    <div className="mt-5">
                        <p className="text-ui-sm text-zinc-500">Summary</p>
                        <p className="mt-2.5 text-ui-sm leading-relaxed text-zinc-200">{selectedEntry.description}</p>
                    </div>

                    <div className="mt-5">
                        <p className="text-ui-sm text-zinc-500">Details</p>
                        <p className="mt-2.5 whitespace-pre-wrap text-ui-sm leading-[1.8] text-zinc-300">{selectedEntry.body}</p>
                    </div>

                    <div className="mt-8 flex flex-wrap items-center gap-1.5">
                        <StatusPill tone="neutral" kicker title="Where this memory belongs">{provenance}</StatusPill>
                        {selectedEntry.source === 'auto' && (
                            <StatusPill tone="info" kicker title="Learned automatically from your sessions">auto</StatusPill>
                        )}
                        {selectedEntry.sensitive && (
                            <StatusPill tone="warn" kicker title="A sensitive-category fact — excluded from pre-reads and unattended contexts">
                                sensitive
                            </StatusPill>
                        )}
                        <span className="font-mono text-ui-2xs text-zinc-600" title="The memory's identity">{selectedEntry.slug}</span>
                    </div>

                    <div className="mt-8">
                        {!editing ? (
                            <button
                                type="button"
                                onClick={() => startEdit(selectedEntry)}
                                className="inline-flex items-center gap-1.5 rounded-control border border-zinc-800 px-3 py-1.5 text-ui-dense font-semibold text-zinc-300 transition-colors hover:border-line hover:text-zinc-100"
                            >
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                Edit memory
                            </button>
                        ) : (
                            <div className="space-y-2 rounded-bubble border border-hairline bg-zinc-950/60 p-3" data-testid={`profile-memory-editor-${selectedEntry.slug}`}>
                                <input
                                    value={editing.description}
                                    onChange={ev => setEditing({ ...editing, description: ev.target.value })}
                                    aria-label="Memory summary"
                                    placeholder="One line: what this memory says"
                                    className="w-full rounded-control border border-hairline bg-zinc-900 px-2 py-1 text-ui-dense text-zinc-100 placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
                                />
                                <textarea
                                    value={editing.body}
                                    onChange={ev => setEditing({ ...editing, body: ev.target.value })}
                                    aria-label="Memory details"
                                    rows={5}
                                    className="w-full resize-y rounded-control border border-hairline bg-zinc-900 px-2 py-1 text-ui-dense text-zinc-100 focus:border-accent/40 focus:outline-none"
                                />
                                {editError && <p role="alert" className="text-ui-xs leading-snug text-rose-300">{editError}</p>}
                                <div className="flex items-center gap-1.5">
                                    <button type="button" onClick={saveEdit} disabled={!editing.body.trim()}
                                        data-testid={`profile-memory-save-${selectedEntry.slug}`}
                                        className="rounded-control bg-zinc-100 px-2.5 py-1 text-ui-xs font-bold text-zinc-900 disabled:opacity-40">
                                        Save
                                    </button>
                                    <button type="button" onClick={() => { setEditing(null); setEditError(''); }}
                                        className="rounded-control border border-zinc-800 px-2.5 py-1 text-ui-xs font-semibold text-zinc-400 hover:text-zinc-100">
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ── The list ────────────────────────────────────────────────────────────
    return (
        <div data-testid="profile-memory-card">
            <div>
                <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]" data-testid="trader-learning-toggle">
                    <div className="min-w-0">
                        <div className="text-ui-sm font-medium text-zinc-100">Generate memory from chats</div>
                        <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                            Allow August to generate memory from your chats and trading sessions.
                        </p>
                    </div>
                    <ToggleSwitch
                        checked={learning}
                        onChange={() => { const next = !learning; setTraderLearningEnabled(next); setLearning(next); }}
                        label="Generate memory from chats"
                    />
                </div>

                <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]" data-testid="memory-sensitive-toggle">
                    <div className="min-w-0">
                        <div className="text-ui-sm font-medium text-zinc-100">Include sensitive topics in memory</div>
                        <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                            Allow facts about health, finances or identity; secrets are always refused.
                        </p>
                    </div>
                    <ToggleSwitch
                        checked={sensitive}
                        onChange={() => {
                            const next = !sensitive;
                            saveHarnessSettings({ sensitiveMemoryEnabled: next });
                            setSensitive(next);
                        }}
                        label="Include sensitive topics in memory"
                    />
                </div>

                <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]">
                    <div className="min-w-0">
                        <div className="text-ui-sm font-medium text-zinc-100">Export memory</div>
                        <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                            Download everything August remembers as a Markdown file.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void exportMemory()}
                        disabled={entries.length === 0}
                        data-testid="memory-export"
                        className="shrink-0 rounded-control bg-zinc-800 px-4 py-1 text-ui-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700 disabled:opacity-40"
                    >
                        Export
                    </button>
                </div>

                {onOpenNotebook && (
                    <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]">
                        <div className="min-w-0">
                            <div className="text-ui-sm font-medium text-zinc-100">Notebook files</div>
                            <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                                The markdown the desk reads on every analysis.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={onOpenNotebook}
                            data-testid="open-learn-memory"
                            className="shrink-0 rounded-control bg-zinc-800 px-3 py-1.5 text-ui-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
                        >
                            Open the notebook
                            <span className="ml-1 font-mono text-ui-xs text-zinc-500">Alt+5</span>
                        </button>
                    </div>
                )}

                {memoryModel && (
                    <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]">
                        <div className="min-w-0">
                            <div className="text-ui-sm font-medium text-zinc-100">Memory model</div>
                            <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                                The model that reviews the notebook and drafts amendments.
                            </p>
                        </div>
                        <span className="shrink-0 text-ui-sm text-zinc-300">{memoryModel}</span>
                    </div>
                )}
            </div>

            {entries.length === 0 ? (
                <p className="mt-6 rounded-control border border-dashed border-zinc-800 px-3 py-6 text-center text-ui-dense text-zinc-600">
                    No memories yet — the assistant saves one when it learns something durable about you.
                </p>
            ) : (
                <div data-testid="profile-memory-list">
                    {sections.map((section, index) => (
                        <section
                            key={section.id}
                            data-testid={`memory-group-${section.id}`}
                            className={`${index === 0 ? 'mt-4' : 'mt-6'} border-t border-hairline pt-4`}
                        >
                            <h4 className="text-ui-sm font-medium text-zinc-200">{section.label}</h4>
                            <ul className="mt-2.5 divide-y divide-hairline">
                                {section.rows.map(e => (
                                    <li key={e.slug} data-testid={`memory-entry-${e.slug}`}
                                        className="group relative rounded-control transition-colors hover:bg-white/[0.03]">
                                        <div className="flex items-center">
                                            <button
                                                type="button"
                                                onClick={() => openEntry(e)}
                                                className="min-w-0 flex-1 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                                                aria-label={`Open memory ${memoryEntryTitle(e)}`}
                                            >
                                                <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)_minmax(0,300px)] sm:items-baseline sm:gap-5">
                                                    <span className="truncate text-ui-sm font-medium text-zinc-100" title={e.description}>
                                                        {memoryEntryTitle(e)}
                                                    </span>
                                                    <span className="truncate text-ui-sm text-zinc-500" title={e.description}>
                                                        {e.description}
                                                    </span>
                                                    <span className="shrink-0 text-ui-sm text-zinc-500" title={rowUpdatedIso(e)}>
                                                        {updatedLabelOf(e)}
                                                    </span>
                                                </div>
                                            </button>
                                            <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 bg-gradient-to-l from-zinc-900 via-zinc-900/80 to-transparent pl-6 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                                <button type="button" onClick={() => startEdit(e)}
                                                    aria-label={`Edit memory ${e.slug}`} title="Edit"
                                                    className="rounded-control p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                                                    <Pencil className="h-4 w-4" aria-hidden="true" />
                                                </button>
                                                <button type="button" onClick={() => forgetOne(e.slug)}
                                                    aria-label={`Forget memory ${e.slug}`} title="Forget"
                                                    className="rounded-control p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-rose-300">
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                </button>
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            {deleted.length > 0 && (
                <details className="mt-10 rounded-control border border-zinc-800/80 bg-zinc-950/30 px-2.5 py-2" data-testid="profile-memory-deleted">
                    <summary className="cursor-pointer text-ui-dense text-zinc-500">
                        Recently deleted ({deleted.length}) · 30-day undo
                    </summary>
                    <ul className="mt-2 border-t border-zinc-800/80">
                        {deleted.map(e => (
                            <li key={e.slug} className="flex items-center gap-2 border-b border-zinc-800/60 py-1.5 last:border-0">
                                <span className="min-w-0 flex-1 truncate text-ui-dense text-zinc-400" title={e.description}>{e.description}</span>
                                <span className="shrink-0 text-ui-xs text-zinc-600">{String(e.deletedAt).slice(0, 10)}</span>
                                <button type="button" onClick={() => restoreOne(e.slug)}
                                    aria-label={`Restore memory ${e.slug}`} title="Restore"
                                    className="shrink-0 rounded-control border border-zinc-800 px-2 py-1 text-ui-2xs font-semibold text-zinc-300 transition-colors hover:border-line hover:text-zinc-100">
                                    Restore
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {note && (
                <p role="status" data-testid="profile-memory-forget-note"
                    className="mt-2 rounded-control border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5 text-ui-dense leading-4 text-zinc-400">
                    {note}
                </p>
            )}
        </div>
    );
};

export default ProfileMemoryCard;
