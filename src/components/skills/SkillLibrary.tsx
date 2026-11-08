/**
 * SkillLibrary — the ONE skill browser.
 *
 * A skill is a folder: <slug>/SKILL.md plus optional references/, templates/,
 * scripts/ and assets/. The library is a grid of those documents; opening one
 * shows the reference's detail shape — a breadcrumb back, the document header,
 * and two tabs:
 *
 *   Overview — what the skill is for, plus its source and revision.
 *   Contents — the folder as a file tree (SKILL.md and every bundled file) beside
 *              a viewer that toggles between the rendered document and its raw
 *              source, with the frontmatter as a table and a per-file download.
 *
 * Reading is the default; writing is the Edit action, which reuses the same
 * draft/version/conflict machinery as before. There is no status, no approval
 * and no record — those belonged to the retired ledger. The model writes
 * through `skill_write`; this is the human's pen. Both go through
 * `writeSkillFile`, so a save here carries the same optimistic version check a
 * model update does.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    deleteSkillFile,
    listSkillFiles,
    missingSkillSections,
    parseSkillMarkdown,
    writeSkillFile,
    composeSkillMarkdown,
    SKILL_BODY_SECTIONS,
    type ParsedSkillMarkdown,
    type SkillFile,
} from '../../services/learning/SkillFileService';
import { importSkillFiles, readSkillFiles, fetchSkillFromUrl, type SkillFileRead, type SkillImportResult } from '../../services/learning/SkillImportService';
import { subscribeMemoryFilesChanged } from '../../services/learning/MemoryFilesService';
import { rewriteSkillWithModel } from '../../services/learning/SkillFormatService';
import { skillFormatIssues } from '../../utils/skillFrontmatter';
import ModelPicker from '../shared/ModelPicker';
import type { ProviderConfig } from '../../types/provider';
import { ArrowLeft, CodeIcon, Download, Eye, FileText, Layers, Pencil, Plus, Search, Trash2, Upload, Wrench } from '../shared/Icons';
import MarkdownContent from '../shared/MarkdownContent';

export interface SkillLibraryProps {
    /** Open this skill on mount (a deep link or a search result). */
    initialSlug?: string | null;
    /** Configured providers, for the format-with-model picker. */
    providers?: ProviderConfig[];
    /** The model that reformats a skill, as `providerId::modelId`. */
    formatModel?: string;
    onFormatModelChange?: (value: string) => void;
}

interface Draft {
    slug?: string;
    name: string;
    description: string;
    body: string;
    version?: string;
}

/** A new skill opens with the four headings already in place: the trader fills
 *  under them rather than remembering them, so a created skill is in the format
 *  by construction. The headings come from the one list `SKILL_BODY_SECTIONS`
 *  owns — the editor hint and the model's rewrite read the same names. */
const emptyDraft = (): Draft => ({
    name: '',
    description: '',
    body: SKILL_BODY_SECTIONS.map(s => `## ${s}`).join('\n\n'),
});

const draftOf = (skill: SkillFile): Draft => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    version: skill.version,
});

const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p);

type DetailTab = 'overview' | 'contents';

export const SkillLibrary: React.FC<SkillLibraryProps> = ({
    initialSlug, providers = [], formatModel = '', onFormatModelChange,
}) => {
    const [skills, setSkills] = useState<SkillFile[]>(() => listSkillFiles());
    const [selected, setSelected] = useState<string | null>(initialSlug ?? null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [conflict, setConflict] = useState<(ParsedSkillMarkdown & { version: string }) | null>(null);
    const [query, setQuery] = useState('');
    const [url, setUrl] = useState('');
    const [fetching, setFetching] = useState(false);
    const [armed, setArmed] = useState<string | null>(null);
    const [formatting, setFormatting] = useState(false);
    const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    // The editor body toggles between the raw SKILL.md text and its rendered
    // markdown, so what is being written is what the reader will see.
    const [preview, setPreview] = useState(false);
    // Detail reading state. Contents leads, because the document itself is what
    // a skill IS; the Overview is the one-screen answer to "should I read it".
    const [tab, setTab] = useState<DetailTab>('contents');
    const [openFile, setOpenFile] = useState('SKILL.md');
    const [raw, setRaw] = useState(false);
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
        setTab('contents');
        setOpenFile('SKILL.md');
        setRaw(false);
        setArmed(null);
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

    /** Every file in the skill's folder, head first. Content is the live
     *  notebook bytes (no copy) — the same store the model reads. */
    const filesOfCurrent = useMemo<Array<{ path: string; content: string }>>(() => {
        if (!current) return [];
        return [
            { path: 'SKILL.md', content: current.file.content },
            ...current.bundled.map(f => ({ path: f.path ?? f.name, content: f.content ?? '' })),
        ];
    }, [current]);

    const activeFile = filesOfCurrent.find(f => f.path === openFile) ?? filesOfCurrent[0] ?? null;

    const downloadActive = (): void => {
        if (!activeFile) return;
        const blob = new Blob([activeFile.content], { type: 'text/markdown' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = activeFile.path.split('/').pop() || 'SKILL.md';
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    };

    const save = async (): Promise<void> => {
        if (!draft || conflict) return;
        // CREATE only: the human's pen must produce a document IN the format.
        // The service stays permissive — the model's `skill_write` path is
        // governed by its own tool description and the duplicate scan, and the
        // contract pins a sectionless create as legal. The editor is where a
        // skill is BORN, and it scaffolds the headings precisely so this check
        // is a guarantee rather than a chore.
        if (!draft.slug) {
            const issues = skillFormatIssues(
                composeSkillMarkdown(draft.name, draft.description, draft.body),
            );
            if (!draft.name.trim()) issues.unshift({ kind: 'name', what: 'no title' });
            if (issues.length > 0) {
                setNote({
                    kind: 'error',
                    text: `This skill does not follow the format yet: ${issues.map(i => i.what).join('; ')}. `
                        + 'The four headings are already in the body — fill under them, or save a draft and let the format model reshape it.',
                });
                return;
            }
        }
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
            setTab('contents');
            setOpenFile('SKILL.md');
            setRaw(false);
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

    /** The provider config the format picker names, or null when the pick is
     *  empty or names a model no configured provider lists. A null here is a
     *  disabled button with a reason, never a call sent to the wrong model. */
    const formatConfig = useMemo<ProviderConfig | null>(() => {
        if (!formatModel) return null;
        const [providerId, ...rest] = formatModel.split('::');
        const model = rest.join('::');
        const provider = providers.find(p => p.id === providerId);
        if (!provider) return null;
        if (model && !provider.models.includes(model)) return null;
        return model ? { ...provider, selectedModel: model } : provider;
    }, [providers, formatModel]);

    const formatWithModel = async (): Promise<void> => {
        if (!current || !formatConfig || formatting) return;
        setFormatting(true);
        setNote({ kind: 'ok', text: `Reformatting "${current.name}" with ${formatConfig.selectedModel || 'the selected model'}…` });
        try {
            const result = await rewriteSkillWithModel({ slug: current.slug, config: formatConfig });
            setNote({ kind: result.ok ? 'ok' : 'error', text: result.message });
            if (result.ok) refresh();
        } catch (err) {
            setNote({ kind: 'error', text: `Could not reformat: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
            setFormatting(false);
        }
    };

    /** Format problems per skill, so a card can say "this one is not in the
     *  format" without re-deriving the answer in four places. */
    const issueCountBySlug = useMemo(() => {
        const map = new Map<string, number>();
        for (const s of skills) {
            const n = skillFormatIssues(s.file.content).length;
            if (n > 0) map.set(s.slug, n);
        }
        return map;
    }, [skills]);

    const currentIssues = useMemo(
        () => (current ? skillFormatIssues(current.file.content) : []),
        [current],
    );

    const inputClass = 'min-w-0 flex-1 rounded-control border border-hairline bg-zinc-900 px-3 py-1.5 text-ui-dense text-zinc-200 placeholder:text-zinc-600 focus:border-line focus:outline-none';
    const buttonClass = 'inline-flex items-center gap-1.5 rounded-control border border-hairline bg-zinc-800 px-3 py-1.5 text-ui-dense font-medium text-zinc-200 hover:border-line hover:bg-zinc-700';

    /* ── Library view ─────────────────────────────────────────────── */
    const libraryView = (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search skills"
                        aria-label="Search skills"
                        className={`${inputClass} pl-8`}
                    />
                </div>
                <button
                    type="button"
                    onClick={() => { setDraft(emptyDraft()); setSelected(null); setConflict(null); setNote(null); setPreview(false); }}
                    className={buttonClass}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    New skill
                </button>
                <button type="button" onClick={() => fileInput.current?.click()} className={buttonClass} title="Import standalone skill .md files">
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    Import files
                </button>
                <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => { void importFiles(e.target.files); e.target.value = ''; }}
                />
                <button type="button" onClick={() => folderInput.current?.click()} className={buttonClass} title="Import a SKILL.md folder with bundled text files; binary assets are not supported">
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
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
                    className={inputClass}
                />
                <button
                    type="button"
                    data-testid="skills-import-url-go"
                    disabled={fetching || !url.trim()}
                    onClick={() => void fetchFromUrl()}
                    className={`${buttonClass} disabled:opacity-40`}
                >
                    {fetching ? 'Fetching…' : 'Fetch URL'}
                </button>
            </div>
            {/* The model that reshapes a skill. It lives HERE, beside the
                library, because the action it drives is a library-wide repair —
                the same picker the composer uses, so the list, the stars and
                the keyboard model are one implementation. */}
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui-dense text-zinc-500">Format model</span>
                <ModelPicker
                    providers={providers}
                    value={formatModel}
                    onChange={onFormatModelChange ?? (() => undefined)}
                    compact
                    placeholder="Select a model"
                />
                <span className="text-ui-2xs text-zinc-600">
                    The model that rewrites a skill into the SKILL.md format.
                </span>
            </div>

            <div
                data-testid="skills-catalog-grid"
                className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-y-auto custom-scrollbar md:grid-cols-2"
            >
                {filtered.length === 0 && (
                    <p className="col-span-full rounded-control border border-dashed border-hairline px-3 py-8 text-center text-ui-dense text-zinc-500">
                        {skills.length === 0 ? 'No skills yet. Write one, or import a SKILL.md folder.' : 'No skill matches that search.'}
                    </p>
                )}
                {filtered.map(skill => {
                    const isArmed = armed === skill.slug;
                    return (
                        <div key={skill.slug} className="relative">
                            <button
                                type="button"
                                onClick={() => choose(skill.slug)}
                                data-testid="skills-catalog-card"
                                aria-label={`Read ${skill.name}`}
                                className="flex h-full w-full flex-col gap-1.5 rounded-control border border-hairline bg-zinc-900 p-3 pr-10 text-left transition-colors hover:border-line hover:bg-zinc-800/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                            >
                                <span className="flex items-center gap-2">
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-zinc-800 text-zinc-400">
                                        <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-zinc-100">{skill.name}</span>
                                </span>
                                <span className="line-clamp-2 text-ui-dense text-zinc-500">{skill.description || 'No description'}</span>
                                <span className="mt-auto flex items-center gap-2 pt-1 font-mono text-ui-2xs text-zinc-600">
                                    rev {skill.version.slice(0, 8)} · {skill.bundled.length} support file{skill.bundled.length === 1 ? '' : 's'}
                                    {issueCountBySlug.has(skill.slug) && (
                                        <span
                                            className="rounded-control border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-sans text-amber-300"
                                            data-testid={`skill-format-flag-${skill.slug}`}
                                            title="This skill does not follow the SKILL.md format"
                                        >
                                            format · {issueCountBySlug.get(skill.slug)}
                                        </span>
                                    )}
                                </span>
                            </button>
                            <button
                                type="button"
                                data-testid={`skill-delete-${skill.slug}`}
                                aria-label={isArmed ? `Confirm delete ${skill.name}` : `Delete ${skill.name}`}
                                title={isArmed ? 'Press again to delete this skill and its bundled files' : 'Delete'}
                                onClick={() => {
                                    // Two presses, never one: the first arms the
                                    // row, the second deletes it and its bundle.
                                    if (isArmed) void removeSlug(skill.slug);
                                    else setArmed(skill.slug);
                                }}
                                className={`absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-control border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${isArmed ? 'border-rose-400/60 bg-rose-500/15 text-rose-200' : 'border-transparent text-zinc-600 hover:border-rose-500/30 hover:text-rose-300'}`}
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </>
    );

    /* ── Detail views ─────────────────────────────────────────────── */
    const detailHeader = current && (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => choose(null)}
                    aria-label="Back to skills"
                    className="inline-flex items-center gap-1.5 rounded-control px-1.5 py-1 text-ui-base text-zinc-400 transition-colors hover:text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Skills
                </button>
                <span className="flex-1" />
                <button
                    type="button"
                    onClick={() => void formatWithModel()}
                    disabled={!formatConfig || formatting}
                    className={`${buttonClass} disabled:opacity-40`}
                    title={formatConfig
                        ? 'Rewrite this skill into the SKILL.md format with the selected model'
                        : 'Pick a format model in the library first'}
                    data-testid="skill-format-with-model"
                >
                    <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                    {formatting ? 'Formatting…' : 'Format'}
                </button>
                <button type="button" onClick={() => { setDraft(draftOf(current)); setPreview(false); }} className={buttonClass}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                </button>
                <button
                    type="button"
                    onClick={() => void remove()}
                    className="inline-flex items-center gap-1.5 rounded-control border border-rose-500/30 px-3 py-1.5 text-ui-dense font-medium text-rose-300 hover:bg-rose-500/10"
                >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                </button>
            </div>
            <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-zinc-800 text-zinc-300">
                    <Layers className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                    <h3 className="truncate text-ui-lg font-semibold text-zinc-100" title={current.name}>{current.name}</h3>
                    <p className="truncate font-mono text-ui-dense text-zinc-500">
                        rev {current.version.slice(0, 8)} · {current.bundled.length} support file{current.bundled.length === 1 ? '' : 's'} · from the notebook
                    </p>
                </div>
            </div>
            <div className="flex gap-1" role="tablist" aria-label="Skill detail">
                {([['overview', 'Overview'], ['contents', `Contents · ${filesOfCurrent.length}`]] as Array<[DetailTab, string]>).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        onClick={() => setTab(id)}
                        aria-selected={tab === id}
                        data-testid={`skill-tab-${id}`}
                        className={`rounded-control px-3 py-1.5 text-ui-dense font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${tab === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );

    const overviewView = current && (
        <div className="flex flex-col gap-4 md:flex-row">
            <div className="min-w-0 flex-1">
                <p className="text-ui-dense text-zinc-500">Description</p>
                <p className="mt-1 whitespace-pre-wrap text-ui-base leading-relaxed text-zinc-200">{current.description || 'No description'}</p>
            </div>
            <aside className="w-full shrink-0 rounded-control border border-hairline bg-zinc-900/60 p-3 md:w-64">
                <p className="text-ui-dense text-zinc-500">Source</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-ui-dense text-zinc-200">
                    <FileText className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                    The notebook
                </p>
                <p className="mt-3 text-ui-dense text-zinc-500">Slug</p>
                <p className="mt-0.5 break-all font-mono text-ui-dense text-zinc-300">{current.slug}</p>
                <p className="mt-3 text-ui-dense text-zinc-500">Revision</p>
                <p className="mt-0.5 break-all font-mono text-ui-dense text-zinc-300">{current.version}</p>
                <p className="mt-3 text-ui-dense text-zinc-500">Support files</p>
                <p className="mt-0.5 text-ui-dense text-zinc-200">{current.bundled.length}</p>
                <p className="mt-3 border-t border-hairline pt-2 text-ui-2xs leading-relaxed text-zinc-500">
                    Context, never a veto — the model reads this document; it does not gate a trade on it.
                </p>
            </aside>
        </div>
    );

    const contentsView = current && activeFile && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <nav aria-label="Skill files" className="flex w-full shrink-0 flex-col gap-0.5 overflow-y-auto md:w-56">
                {filesOfCurrent.map(file => {
                    const active = activeFile.path === file.path;
                    return (
                        <button
                            key={file.path}
                            type="button"
                            onClick={() => { setOpenFile(file.path); setRaw(false); }}
                            data-file-path={file.path}
                            className={`flex min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left font-mono text-ui-dense transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'}`}
                        >
                            <FileText className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden="true" />
                            <span className="truncate" title={file.path}>{file.path}</span>
                        </button>
                    );
                })}
            </nav>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-control border border-hairline bg-zinc-900">
                <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-ui-dense text-zinc-500" title={activeFile.path}>/{activeFile.path}</span>
                    <button
                        type="button"
                        onClick={() => setRaw(false)}
                        aria-pressed={!raw}
                        aria-label="Rendered"
                        title="Rendered"
                        className={`grid h-7 w-7 place-items-center rounded-control transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${!raw ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'}`}
                    >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setRaw(true)}
                        aria-pressed={raw}
                        aria-label="Source"
                        title="Source"
                        className={`grid h-7 w-7 place-items-center rounded-control transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${raw ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'}`}
                    >
                        <CodeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={downloadActive}
                        aria-label={`Download ${activeFile.path}`}
                        title="Download this file"
                        className="grid h-7 w-7 place-items-center rounded-control text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto custom-scrollbar p-3" data-testid="skill-file-viewer">
                    {raw ? (
                        <div className="font-mono text-ui-dense leading-relaxed">
                            {activeFile.content.split('\n').map((line, i) => (
                                <div key={i} className="flex">
                                    <span className="w-8 shrink-0 select-none pr-3 text-right text-zinc-600">{i + 1}</span>
                                    <span className="min-w-0 whitespace-pre-wrap break-words text-zinc-300">{line || ' '}</span>
                                </div>
                            ))}
                        </div>
                    ) : activeFile.path === 'SKILL.md' ? (
                        <>
                            <table className="mb-4 w-full text-ui-dense">
                                <tbody>
                                    <tr className="border-b border-hairline">
                                        <td className="w-36 py-1.5 align-top text-zinc-500">Name</td>
                                        <td className="py-1.5 text-zinc-200">{current.name}</td>
                                    </tr>
                                    <tr className="border-b border-hairline">
                                        <td className="w-36 py-1.5 align-top text-zinc-500">Description</td>
                                        <td className="py-1.5 text-zinc-200">{current.description || '—'}</td>
                                    </tr>
                                    <tr className="border-b border-hairline">
                                        <td className="w-36 py-1.5 align-top text-zinc-500">Revision</td>
                                        <td className="break-all py-1.5 font-mono text-zinc-300">{current.version}</td>
                                    </tr>
                                    <tr className="border-b border-hairline">
                                        <td className="w-36 py-1.5 align-top text-zinc-500">Support files</td>
                                        <td className="py-1.5 text-zinc-200">{current.bundled.length}</td>
                                    </tr>
                                    <tr>
                                        <td className="w-36 py-1.5 align-top text-zinc-500">Instruction mode</td>
                                        <td className="py-1.5 text-zinc-200">embedded</td>
                                    </tr>
                                </tbody>
                            </table>
                            <MarkdownContent content={current.body || '(empty body)'} className="text-ui-base leading-relaxed text-zinc-300" />
                        </>
                    ) : isMarkdownPath(activeFile.path) ? (
                        <MarkdownContent content={activeFile.content || '(empty file)'} className="text-ui-base leading-relaxed text-zinc-300" />
                    ) : (
                        <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-ui-dense text-zinc-300">{activeFile.content || '(empty file)'}</pre>
                    )}
                </div>
            </div>
        </div>
    );

    const detailView = current && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            {detailHeader}
            {currentIssues.length > 0 && (
                <div
                    data-testid="skill-format-issues"
                    className="flex flex-wrap items-center gap-2 rounded-control border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-ui-dense text-amber-200"
                >
                    <span className="min-w-0 flex-1">
                        Not in the SKILL.md format: {currentIssues.map(i => i.what).join('; ')}.
                    </span>
                    <button
                        type="button"
                        onClick={() => void formatWithModel()}
                        disabled={!formatConfig || formatting}
                        className="rounded-control border border-amber-400/40 px-2 py-0.5 font-medium hover:bg-amber-400/10 disabled:opacity-40"
                    >
                        {formatting ? 'Formatting…' : 'Fix with model'}
                    </button>
                </div>
            )}
            {tab === 'overview' ? overviewView : contentsView}
        </div>
    );

    /* ── Editor view (unchanged governance, same fields) ──────────── */
    const editorView = draft && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-control border border-hairline bg-zinc-900 p-3">
            <div className="flex items-center justify-between gap-2">
                <h3 className="truncate font-serif text-ui-lg text-zinc-100">
                    {draft.slug ?? 'New skill'}
                </h3>
                <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => { setDraft(null); setConflict(null); setNote(null); }} className="rounded-control border border-hairline px-2 py-1 text-ui-dense text-zinc-300 hover:bg-white/5">Cancel</button>
                    <button type="button" disabled={conflict !== null} onClick={() => void save()} className="rounded-control border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-ui-dense font-bold uppercase tracking-wider text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40">Save</button>
                </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2">
                <label className="text-ui-dense text-zinc-500">
                    Title
                    <input
                        value={draft.name}
                        onChange={e => setDraft({ ...draft, name: e.target.value })}
                        placeholder="Breakout retest"
                        className="mt-1 w-full rounded-control border border-hairline bg-zinc-950 px-2 py-1.5 text-ui-base text-zinc-100 focus:border-line focus:outline-none"
                    />
                </label>
                <label className="text-ui-dense text-zinc-500">
                    Description — what it does, then when to use it
                    <textarea
                        value={draft.description}
                        onChange={e => setDraft({ ...draft, description: e.target.value })}
                        rows={3}
                        placeholder="Use this skill whenever a 1h close clears the prior range high and the retest holds. Do NOT use for range chop."
                        className="mt-1 w-full resize-y rounded-control border border-hairline bg-zinc-950 px-2 py-1.5 text-ui-base text-zinc-100 focus:border-line focus:outline-none"
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
                                className={`rounded-control border px-2 py-0.5 text-ui-2xs uppercase tracking-wider ${preview ? 'border-hairline text-zinc-500 hover:bg-white/5' : 'border-line bg-zinc-800 text-zinc-200'}`}
                            >
                                Write
                            </button>
                            <button
                                type="button"
                                aria-pressed={preview}
                                onClick={() => setPreview(true)}
                                className={`rounded-control border px-2 py-0.5 text-ui-2xs uppercase tracking-wider ${preview ? 'border-line bg-zinc-800 text-zinc-200' : 'border-hairline text-zinc-500 hover:bg-white/5'}`}
                            >
                                Preview
                            </button>
                        </div>
                    </div>
                    {preview ? (
                        <div
                            data-testid="skill-body-preview"
                            className="mt-1 min-h-[24vh] flex-1 overflow-y-auto rounded-control border border-hairline bg-zinc-950 px-2 py-1.5"
                        >
                            <MarkdownContent content={draft.body} className="text-ui-dense text-zinc-100" />
                        </div>
                    ) : (
                        <textarea
                            value={draft.body}
                            onChange={e => setDraft({ ...draft, body: e.target.value })}
                            placeholder={'## When to use\n\n## Steps\n\n1. …\n\n## Pitfalls\n\n## Verification'}
                            className="mt-1 min-h-[24vh] flex-1 resize-y rounded-control border border-hairline bg-zinc-950 px-2 py-1.5 font-mono text-ui-dense text-zinc-100 focus:border-line focus:outline-none"
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
                    <section className="space-y-2 border-t border-hairline pt-3" aria-label="Current saved version">
                        <h4 className="text-ui-dense font-bold uppercase tracking-wider text-zinc-400">Current saved version · {conflict.version}</h4>
                        <p className="text-ui-dense text-zinc-400">Your draft above is unchanged. Reconcile it with the saved content below, then use the current version before saving.</p>
                        <p className="text-ui-base text-zinc-200">Title: {conflict.name || '(no title)'}</p>
                        <p className="whitespace-pre-wrap text-ui-dense text-zinc-400">Description: {conflict.description || '(no description)'}</p>
                        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-control border border-hairline bg-zinc-950 p-3 font-mono text-ui-dense text-zinc-300">{conflict.body || '(empty body)'}</pre>
                        <button
                            type="button"
                            onClick={() => {
                                setDraft(d => d ? { ...d, version: conflict.version } : d);
                                setConflict(null);
                                setNote({ kind: 'ok', text: 'Current version adopted. Your draft is unchanged; save when ready.' });
                            }}
                            title="Keep your reconciled draft and adopt only the saved version token"
                            className="rounded-control border border-hairline px-2 py-1 text-ui-dense text-zinc-300 hover:bg-white/5"
                        >
                            Use current version
                        </button>
                    </section>
                )}
            </div>
        </div>
    );

    return (
        <div className="flex h-full min-h-0 flex-col gap-3" data-testid="skill-library">
            {!editing && !current && libraryView}
            {!editing && current && detailView}
            {editing && editorView}
            {note && (
                <p
                    role={note.kind === 'error' ? 'alert' : 'status'}
                    className={`shrink-0 rounded-control border px-3 py-2 text-ui-dense ${note.kind === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}
                >
                    {note.text}
                </p>
            )}
        </div>
    );
};

export default SkillLibrary;
