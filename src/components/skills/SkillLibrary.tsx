/**
 * SkillLibrary — the ONE skill browser.
 *
 * A skill is a folder: <slug>/SKILL.md plus optional references/, templates/,
 * scripts/ and assets/. This surface lists every skill by title and
 * description, opens the document, and lets the trader write it. There is no
 * status, no approval and no record — those belonged to the retired ledger.
 *
 * The model writes through `skill_write`; this is the human's pen. Both go
 * through `writeSkillFile`, so a save here carries the same optimistic
 * version check a model update does.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    deleteSkillFile,
    listSkillFiles,
    missingSkillSections,
    parseSkillMarkdown,
    writeSkillFile,
    SKILL_BODY_SECTIONS,
    type ParsedSkillMarkdown,
    type SkillFile,
} from '../../services/learning/SkillFileService';
import { importSkillFiles, readSkillFiles, fetchSkillFromUrl, type SkillFileRead, type SkillImportResult } from '../../services/learning/SkillImportService';
import { subscribeMemoryFilesChanged } from '../../services/learning/MemoryFilesService';
import Disclosure from '../shared/Disclosure';
import MarkdownContent from '../shared/MarkdownContent';

export interface SkillLibraryProps {
    /** Open this skill on mount (a deep link or a search result). */
    initialSlug?: string | null;
}

interface Draft {
    slug?: string;
    name: string;
    description: string;
    body: string;
    version?: string;
}

const emptyDraft = (): Draft => ({ name: '', description: '', body: '' });

const draftOf = (skill: SkillFile): Draft => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    version: skill.version,
});

export const SkillLibrary: React.FC<SkillLibraryProps> = ({ initialSlug }) => {
    const [skills, setSkills] = useState<SkillFile[]>(() => listSkillFiles());
    const [selected, setSelected] = useState<string | null>(initialSlug ?? null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [conflict, setConflict] = useState<(ParsedSkillMarkdown & { version: string }) | null>(null);
    const [query, setQuery] = useState('');
    const [url, setUrl] = useState('');
    const [fetching, setFetching] = useState(false);
    const [armed, setArmed] = useState<string | null>(null);
    const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    // The editor body toggles between the raw SKILL.md text and its rendered
    // markdown, so what is being written is what the reader will see.
    const [preview, setPreview] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);

    const refresh = useCallback(() => {
        setSkills(listSkillFiles());
    }, []);

    useEffect(() => {
        refresh();
        return subscribeMemoryFilesChanged(() => refresh());
    }, [refresh]);

    useEffect(() => {
        if (initialSlug) {
            setSelected(initialSlug);
            setDraft(null);
            setConflict(null);
        }
    }, [initialSlug]);

    const choose = (slug: string | null): void => {
        setSelected(slug);
        setDraft(null);
        setConflict(null);
        setNote(null);
    };

    const current = useMemo(
        () => skills.find(s => s.slug === selected) ?? null,
        [skills, selected],
    );

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return skills;
        return skills.filter(s =>
            s.slug.includes(needle)
            || s.name.toLowerCase().includes(needle)
            || s.description.toLowerCase().includes(needle));
    }, [skills, query]);

    const save = async (): Promise<void> => {
        if (!draft || conflict) return;
        try {
            const result = await writeSkillFile({
                slug: draft.slug,
                name: draft.name,
                description: draft.description,
                body: draft.body,
                ifVersion: draft.version,
            });
            if (!result.ok) {
                setNote({ kind: 'error', text: result.message });
                if (result.current) {
                    setConflict({
                        ...(parseSkillMarkdown(result.current.content) ?? { body: '' }),
                        version: result.current.version,
                    });
                }
                return;
            }
            refresh();
            setSelected(result.slug);
            setDraft(null);
            setConflict(null);
            setNote({ kind: 'ok', text: result.created ? 'Skill created.' : 'Skill saved.' });
        } catch (err) {
            setNote({ kind: 'error', text: `Could not save the skill: ${err instanceof Error ? err.message : String(err)}. Your draft is still here.` });
        }
    };

    const remove = async (): Promise<void> => {
        if (!current) return;
        if (!window.confirm(`Delete "${current.name}" and its bundled files? This cannot be undone.`)) return;
        await removeSlug(current.slug);
    };

    const removeSlug = async (slug: string): Promise<void> => {
        const result = await deleteSkillFile(slug);
        if (result.error) {
            setNote({ kind: 'error', text: result.error });
            return;
        }
        setNote({ kind: 'ok', text: `Deleted ${result.removed.length} file${result.removed.length === 1 ? '' : 's'}.` });
        setArmed(null);
        if (selected === slug) choose(null);
        refresh();
    };

    const reportImport = (result: SkillImportResult): void => {
        const failed = result.failed.map(f => `${f.name}: ${f.reason}`).join('; ');
        setNote({
            kind: result.failed.length ? 'error' : 'ok',
            text: `${result.imported.length} imported${result.imported.length ? ` (${result.imported.join(', ')})` : ''}${result.skipped.length ? `, ${result.skipped.length} skipped (${result.skipped.join(', ')})` : ''}${failed ? ` — ${failed}` : ''}.`,
        });
    };

    const fetchFromUrl = async (): Promise<void> => {
        const target = url.trim();
        if (!target) return;
        setFetching(true);
        try {
            const fetched = await fetchSkillFromUrl(target);
            if (fetched.error || !fetched.files || fetched.files.length === 0) {
                setNote({ kind: 'error', text: fetched.error || 'That URL did not return a SKILL.md.' });
                return;
            }
            const result = await importSkillFiles(fetched.files);
            result.failed.push(...(fetched.refused ?? []).map(r => ({ name: r.path, reason: r.reason })));
            reportImport(result);
            if (result.failed.length === 0) setUrl('');
            refresh();
        } catch (err) {
            setNote({ kind: 'error', text: `Could not fetch or import the skill: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
            setFetching(false);
        }
    };

    const importFiles = async (files: FileList | null): Promise<void> => {
        if (!files || files.length === 0) return;
        try {
            const read = await readSkillFiles(files);
            const readable = read.filter((f): f is SkillFileRead & { content: string } => typeof f.content === 'string' && !f.error);
            const result = await importSkillFiles(readable);
            result.failed.push(...read
                .filter(f => f.error || typeof f.content !== 'string')
                .map(f => ({ name: f.relPath ?? f.name, reason: f.error || 'File is not readable as text' })));
            reportImport(result);
            refresh();
        } catch (err) {
            setNote({ kind: 'error', text: `Could not import the files: ${err instanceof Error ? err.message : String(err)}` });
        }
    };

    const editing = draft !== null;

    // Guidance, not a gate: the hint names the suggested headings the body
    // does not have yet; a save without them is never refused.
    const missingSections = useMemo(
        () => (draft ? missingSkillSections(draft.body) : []),
        [draft],
    );

    return (
        <div className="flex h-full min-h-0 flex-col gap-3" data-testid="skill-library">
            <div className="flex flex-wrap items-center gap-2">
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search skills"
                    aria-label="Search skills"
                    className="min-w-0 flex-1 rounded-control border border-white/10 bg-zinc-900 px-3 py-1.5 text-ui-dense text-zinc-200 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
                />
                <button
                    type="button"
                    onClick={() => { setDraft(emptyDraft()); setSelected(null); setConflict(null); setNote(null); setPreview(false); }}
                    className="rounded-control border border-white/10 bg-zinc-800 px-3 py-1.5 text-ui-dense font-bold uppercase tracking-wider text-zinc-200 hover:border-white/20 hover:bg-zinc-700"
                >
                    New skill
                </button>
                <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="rounded-control border border-white/10 bg-zinc-800 px-3 py-1.5 text-ui-dense font-bold uppercase tracking-wider text-zinc-200 hover:border-white/20 hover:bg-zinc-700"
                    title="Import standalone skill .md files"
                >
                    Import files
                </button>
                <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => { void importFiles(e.target.files); e.target.value = ''; }}
                />
                <button
                    type="button"
                    onClick={() => folderInput.current?.click()}
                    className="rounded-control border border-white/10 bg-zinc-800 px-3 py-1.5 text-ui-dense font-bold uppercase tracking-wider text-zinc-200 hover:border-white/20 hover:bg-zinc-700"
                    title="Import a SKILL.md folder with bundled text files; binary assets are not supported"
                >
                    Import folder
                </button>
                <input
                    ref={folderInput}
                    type="file"
                    multiple
                    {...{ webkitdirectory: '' }}
                    aria-label="Import skill folder"
                    className="hidden"
                    onChange={e => { void importFiles(e.target.files); e.target.value = ''; }}
                />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="https://…/SKILL.md"
                    aria-label="Skill URL"
                    data-testid="skills-import-url"
                    className="min-w-0 flex-1 rounded-control border border-white/10 bg-zinc-900 px-3 py-1.5 text-ui-dense text-zinc-200 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
                />
                <button
                    type="button"
                    data-testid="skills-import-url-go"
                    disabled={fetching || !url.trim()}
                    onClick={() => void fetchFromUrl()}
                    className="rounded-control border border-white/10 bg-zinc-800 px-3 py-1.5 text-ui-dense font-bold uppercase tracking-wider text-zinc-200 hover:border-white/20 hover:bg-zinc-700 disabled:opacity-40"
                >
                    {fetching ? 'Fetching…' : 'Fetch URL'}
                </button>
            </div>

            {note && (
                <p
                    role={note.kind === 'error' ? 'alert' : 'status'}
                    className={`rounded-control border px-3 py-2 text-ui-dense ${note.kind === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}
                >
                    {note.text}
                </p>
            )}

            <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
                <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto" data-testid="skills-catalog-grid">
                    {filtered.length === 0 && (
                        <li className="rounded-control border border-dashed border-white/10 px-3 py-6 text-center text-ui-dense text-zinc-500">
                            {skills.length === 0 ? 'No skills yet. Write one, or import a SKILL.md folder.' : 'No skill matches that search.'}
                        </li>
                    )}
                    {filtered.map(skill => (
                        <li key={skill.slug} className="flex items-stretch gap-1">
                            <button
                                type="button"
                                onClick={() => choose(skill.slug)}
                                data-testid="skills-catalog-card"
                                aria-label={`Read ${skill.name}`}
                                className={`min-w-0 flex-1 rounded-control border px-3 py-2 text-left transition-colors ${selected === skill.slug ? 'border-white/25 bg-zinc-800' : 'border-white/5 bg-zinc-900 hover:border-white/15 hover:bg-zinc-800/70'}`}
                            >
                                <span className="flex items-baseline justify-between gap-2">
                                    <span className="truncate text-ui-base font-medium text-zinc-100">{skill.name}</span>
                                    <span className="shrink-0 text-ui-dense text-zinc-600">{skill.bundled.length ? `${skill.bundled.length} file${skill.bundled.length === 1 ? '' : 's'}` : ''}</span>
                                </span>
                                <span className="mt-0.5 block truncate text-ui-dense text-zinc-500">{skill.description || 'No description'}</span>
                            </button>
                            <button
                                type="button"
                                data-testid={`skill-delete-${skill.slug}`}
                                aria-label={armed === skill.slug ? `Confirm delete ${skill.name}` : `Delete ${skill.name}`}
                                title={armed === skill.slug ? 'Press again to delete this skill and its bundled files' : 'Delete'}
                                onClick={() => {
                                    // Two presses, never one: the first arms the
                                    // row, the second deletes it and its bundle.
                                    if (armed === skill.slug) void removeSlug(skill.slug);
                                    else setArmed(skill.slug);
                                }}
                                className={`shrink-0 rounded-control border px-2 text-ui-dense ${armed === skill.slug ? 'border-rose-400/60 bg-rose-500/15 text-rose-200' : 'border-white/5 text-zinc-500 hover:border-rose-500/30 hover:text-rose-300'}`}
                            >
                                {armed === skill.slug ? 'Sure?' : 'Delete'}
                            </button>
                        </li>
                    ))}
                </ul>

                {(editing || current) && (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-control border border-white/10 bg-zinc-900 p-3">
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="truncate font-serif text-ui-lg text-zinc-100">
                                {editing ? draft.slug ?? 'New skill' : current?.name}
                            </h3>
                            <div className="flex shrink-0 gap-2">
                                {editing ? (
                                    <>
                                        <button type="button" onClick={() => { setDraft(null); setConflict(null); setNote(null); }} className="rounded-control border border-white/10 px-2 py-1 text-ui-dense text-zinc-300 hover:bg-white/5">Cancel</button>
                                        <button type="button" disabled={conflict !== null} onClick={() => void save()} className="rounded-control border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-ui-dense font-bold uppercase tracking-wider text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">Save</button>
                                    </>
                                ) : (
                                    <>
                                        <button type="button" onClick={() => { if (current) { setDraft(draftOf(current)); setPreview(false); } }} className="rounded-control border border-white/10 px-2 py-1 text-ui-dense text-zinc-300 hover:bg-white/5">Edit</button>
                                        <button type="button" onClick={() => void remove()} className="rounded-control border border-rose-500/30 px-2 py-1 text-ui-dense text-rose-300 hover:bg-rose-500/10">Delete</button>
                                    </>
                                )}
                            </div>
                        </div>

                        {editing ? (
                            <div className="flex min-h-0 flex-1 flex-col gap-2">
                                <label className="text-ui-dense text-zinc-500">
                                    Title
                                    <input
                                        value={draft.name}
                                        onChange={e => setDraft({ ...draft, name: e.target.value })}
                                        placeholder="Breakout retest"
                                        className="mt-1 w-full rounded-control border border-white/10 bg-zinc-950 px-2 py-1.5 text-ui-base text-zinc-100 focus:border-white/20 focus:outline-none"
                                    />
                                </label>
                                <label className="text-ui-dense text-zinc-500">
                                    Description — what it does, then when to use it
                                    <textarea
                                        value={draft.description}
                                        onChange={e => setDraft({ ...draft, description: e.target.value })}
                                        rows={3}
                                        placeholder="Use this skill whenever a 1h close clears the prior range high and the retest holds. Do NOT use for range chop."
                                        className="mt-1 w-full resize-y rounded-control border border-white/10 bg-zinc-950 px-2 py-1.5 text-ui-base text-zinc-100 focus:border-white/20 focus:outline-none"
                                    />
                                </label>
                                <div className="flex min-h-0 flex-1 flex-col text-ui-dense text-zinc-500">
                                    <div className="flex items-center justify-between gap-2">
                                        <span>SKILL.md body</span>
                                        <div className="flex gap-1" role="group" aria-label="Body view">
                                            <button
                                                type="button"
                                                aria-pressed={!preview}
                                                onClick={() => setPreview(false)}
                                                className={`rounded-control border px-2 py-0.5 text-ui-2xs uppercase tracking-wider ${preview ? 'border-white/5 text-zinc-500 hover:bg-white/5' : 'border-white/20 bg-zinc-800 text-zinc-200'}`}
                                            >
                                                Write
                                            </button>
                                            <button
                                                type="button"
                                                aria-pressed={preview}
                                                onClick={() => setPreview(true)}
                                                className={`rounded-control border px-2 py-0.5 text-ui-2xs uppercase tracking-wider ${preview ? 'border-white/20 bg-zinc-800 text-zinc-200' : 'border-white/5 text-zinc-500 hover:bg-white/5'}`}
                                            >
                                                Preview
                                            </button>
                                        </div>
                                    </div>
                                    {preview ? (
                                        <div
                                            data-testid="skill-body-preview"
                                            className="mt-1 min-h-[24vh] flex-1 overflow-y-auto rounded-control border border-white/10 bg-zinc-950 px-2 py-1.5"
                                        >
                                            <MarkdownContent content={draft.body} className="text-ui-dense text-zinc-100" />
                                        </div>
                                    ) : (
                                        <textarea
                                            value={draft.body}
                                            onChange={e => setDraft({ ...draft, body: e.target.value })}
                                            placeholder={'## When to use\n\n## Steps\n\n1. …\n\n## Pitfalls\n\n## Verification'}
                                            className="mt-1 min-h-[24vh] flex-1 resize-y rounded-control border border-white/10 bg-zinc-950 px-2 py-1.5 font-mono text-ui-dense text-zinc-100 focus:border-white/20 focus:outline-none"
                                        />
                                    )}
                                </div>
                                {missingSections.length > 0 && (
                                    <p className="text-ui-dense text-amber-300/90" data-testid="skill-section-hint">
                                        No {missingSections.map(s => `## ${s}`).join(', ')} heading yet — a skill reads
                                        best with {SKILL_BODY_SECTIONS.map(s => `## ${s}`).join(', ')}. Saving without
                                        them is fine.
                                    </p>
                                )}
                                <p className="text-ui-dense text-zinc-600">
                                    This editor writes SKILL.md. Long material lives beside it —
                                    import the skill's folder to add <code>references/</code>, <code>templates/</code>,
                                    <code> scripts/</code> and <code>assets/</code> files.
                                </p>
                                {conflict && (
                                    <section className="space-y-2 border-t border-white/10 pt-3" aria-label="Current saved version">
                                        <h4 className="text-ui-dense font-bold uppercase tracking-wider text-zinc-400">Current saved version · {conflict.version}</h4>
                                        <p className="text-ui-dense text-zinc-400">Your draft above is unchanged. Reconcile it with the saved content below, then use the current version before saving.</p>
                                        <p className="text-ui-base text-zinc-200">Title: {conflict.name || '(no title)'}</p>
                                        <p className="whitespace-pre-wrap text-ui-dense text-zinc-400">Description: {conflict.description || '(no description)'}</p>
                                        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-control border border-white/5 bg-zinc-950 p-3 font-mono text-ui-dense text-zinc-300">{conflict.body || '(empty body)'}</pre>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setDraft(d => d ? { ...d, version: conflict.version } : d);
                                                setConflict(null);
                                                setNote({ kind: 'ok', text: 'Current version adopted. Your draft is unchanged; save when ready.' });
                                            }}
                                            title="Keep your reconciled draft and adopt only the saved version token"
                                            className="rounded-control border border-white/10 px-2 py-1 text-ui-dense text-zinc-300 hover:bg-white/5"
                                        >
                                            Use current version
                                        </button>
                                    </section>
                                )}
                            </div>
                        ) : current && (
                            <div className="flex min-h-0 flex-1 flex-col gap-3">
                                <p className="text-ui-dense text-zinc-400">{current.description || 'No description'}</p>
                                <div className="min-h-0 flex-1 overflow-y-auto rounded-control border border-white/5 bg-zinc-950 p-3 custom-scrollbar" data-testid="skill-body-reader">
                                    <MarkdownContent content={current.body || '(empty body)'} className="text-ui-base leading-relaxed text-zinc-300" />
                                </div>
                                {current.bundled.length > 0 && (
                                    <div>
                                        <h4 className="text-ui-dense font-bold uppercase tracking-wider text-zinc-500">Bundled files</h4>
                                        <p className="text-ui-dense text-zinc-600">Text preview only. Scripts are never executed.</p>
                                        <ul className="mt-1 space-y-0.5">
                                            {current.bundled.map(f => {
                                                // Markdown files read as markdown; anything
                                                // else (scripts, assets) stays raw.
                                                const isMarkdown = /\.(md|markdown)$/i.test(f.path ?? f.name);
                                                return (
                                                    <li key={f.id} className="font-mono text-ui-dense text-zinc-400">
                                                        <Disclosure
                                                            summary={f.path ?? f.name}
                                                            label={`Read ${f.path ?? f.name}`}
                                                            summaryClassName="cursor-pointer rounded-control px-2 py-1 hover:bg-white/5"
                                                        >
                                                            {isMarkdown ? (
                                                                <div className="max-h-[60vh] overflow-y-auto rounded-control border border-white/5 bg-zinc-950 p-3">
                                                                    <MarkdownContent content={f.content || ''} className="text-ui-dense leading-relaxed text-zinc-300" />
                                                                </div>
                                                            ) : (
                                                                <pre className="overflow-auto whitespace-pre-wrap break-words rounded-control border border-white/5 bg-zinc-950 p-3 text-zinc-300">{f.content || '(empty file)'}</pre>
                                                            )}
                                                        </Disclosure>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default SkillLibrary;
