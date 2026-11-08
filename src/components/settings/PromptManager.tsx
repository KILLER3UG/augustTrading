import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { PROMPT_REGISTRY, PromptRegistryEntry } from '../../constants/promptRegistry';
import {
    initPromptOverrides,
    getPromptOverrides,
    savePromptOverride,
    resetPromptOverride,
    resetAllPromptOverrides,
    validatePromptOverride,
} from '../../services/infrastructure/PromptOverrideService';
import { useToastActions } from '../shared/Toast';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import MarkdownContent from '../shared/MarkdownContent';
import { SearchIcon, LoadingIcon, FileTextIcon, ChevronRightIcon, ChevronLeftIcon, FolderIcon } from '../shared/Icons';

interface PromptManagerProps {
    /** Active user — overrides are stored per-user. */
    username?: string;
}

/**
 * Prompt categories — derived from the id prefix, so the sidebar groups
 * prompts the way the Trader Notebook groups md files into folders.
 */
const GROUP_ORDER = ['analysis', 'learning', 'strategy', 'notebook'];
const GROUP_LABELS: Record<string, string> = {
    analysis: 'Analysis',
    learning: 'Learning',
    strategy: 'Strategy',
    notebook: 'Notebook',
};

const groupKeyOf = (id: string): string => id.split('.')[0] || 'other';
const groupLabel = (key: string): string => GROUP_LABELS[key] ?? 'Other';

/**
 * Settings → Prompts: browse every prompt the app sends to models, see where
 * it is used, and edit it. Mirrors the Memory (Trader Notebook) layout:
 * categories on the left, the prompt list on the right, and clicking a prompt
 * opens its rendered markdown (Write switches to the raw editor).
 * Edits are stored per-user in Preferences and applied at call time
 * (getPrompt), so they take effect on the very next analysis — no restart.
 */
const PromptManager: React.FC<PromptManagerProps> = ({ username }) => {
    const toast = useToastActions();
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<string>('');
    const [isDirty, setIsDirty] = useState(false);
    const [isPreview, setIsPreview] = useState(false);
    const [isDiff, setIsDiff] = useState(false);
    const [overrides, setOverrides] = useState<Record<string, string>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    const activeUser = username || 'default';

    // Refresh the sync cache on mount / user switch, then snapshot the map.
    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        initPromptOverrides(activeUser).then(() => {
            if (cancelled) return;
            setOverrides(getPromptOverrides());
            setIsLoading(false);
        });
        return () => { cancelled = true; };
    }, [activeUser]);

    const selectedEntry = useMemo(
        () => PROMPT_REGISTRY.find(e => e.id === selectedId) ?? null,
        [selectedId]
    );
    const isModified = selectedId ? overrides[selectedId] !== undefined : false;
    // Only edits that name a prompt the app can still SEND. An override left
    // behind by a deleted prompt used to inflate this count, so the button
    // offered to reset N prompts while some of them exist nowhere — and the
    // number was the same one the A/B fingerprint had already stopped trusting.
    // Built from the registry this tab already renders, so the two cannot disagree.
    const registeredIds = useMemo(() => new Set(PROMPT_REGISTRY.map(e => e.id)), []);
    const modifiedCount = Object.keys(overrides)
        .filter(id => registeredIds.has(id) && (overrides[id] || '').trim()).length;
    const draftWarnings = useMemo(() => validatePromptOverride(draft), [draft]);

    // Categories in display order (known groups first, unknown sorted).
    const allGroups = useMemo(() => {
        const byKey = new Map<string, PromptRegistryEntry[]>();
        for (const entry of PROMPT_REGISTRY) {
            const key = groupKeyOf(entry.id);
            const list = byKey.get(key) ?? [];
            list.push(entry);
            byKey.set(key, list);
        }
        const known = GROUP_ORDER
            .filter(key => byKey.has(key))
            .map(key => ({ key, label: groupLabel(key), entries: byKey.get(key)! }));
        const others = [...byKey.keys()]
            .filter(key => !GROUP_ORDER.includes(key))
            .sort()
            .map(key => ({ key, label: groupLabel(key), entries: byKey.get(key)! }));
        return [...known, ...others];
    }, []);

    // Search across name, description, id and usage.
    const searchFiltered = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return null;
        return PROMPT_REGISTRY.filter(entry =>
            entry.name.toLowerCase().includes(q) ||
            entry.description.toLowerCase().includes(q) ||
            entry.id.toLowerCase().includes(q) ||
            entry.usage.some(u => u.toLowerCase().includes(q))
        );
    }, [searchQuery]);

    // Right-list entries: a search query overrides category scoping and
    // returns matches from every category (a "results" view).
    const visibleEntries = useMemo(() => {
        if (searchFiltered) return searchFiltered;
        if (!selectedGroupKey) return [];
        return PROMPT_REGISTRY.filter(e => groupKeyOf(e.id) === selectedGroupKey);
    }, [searchFiltered, selectedGroupKey]);

    // Guard unsaved edits when leaving the current prompt.
    const ensureNotDirty = useCallback(async (): Promise<boolean> => {
        if (!isDirty || !selectedEntry) return true;
        const ok = await confirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${selectedEntry.name}". They will be lost if you switch prompts.`,
            confirmLabel: 'Discard',
            destructive: true,
        });
        return ok;
    }, [isDirty, selectedEntry, confirm]);

    const openEntry = useCallback(async (entry: PromptRegistryEntry) => {
        if (selectedId === entry.id) return;
        if (!(await ensureNotDirty())) return;
        setSelectedId(entry.id);
        setDraft(overrides[entry.id] ?? entry.fallback);
        setIsDirty(false);
        // Opening a prompt shows its rendered markdown (like opening an md
        // file); the Write button switches to the raw editor.
        setIsPreview(true);
    }, [selectedId, overrides, ensureNotDirty]);

    const selectCategory = useCallback(async (key: string) => {
        if (!(await ensureNotDirty())) return;
        setSelectedGroupKey(key);
        setSearchQuery('');
        setSelectedId(null);
        setIsDirty(false);
    }, [ensureNotDirty]);

    const goBackToList = useCallback(async () => {
        if (!(await ensureNotDirty())) return;
        setSelectedId(null);
        setIsDirty(false);
    }, [ensureNotDirty]);

    const goBackToCategories = useCallback(async () => {
        if (!(await ensureNotDirty())) return;
        setSelectedId(null);
        setSelectedGroupKey(null);
        setSearchQuery('');
        setIsDirty(false);
    }, [ensureNotDirty]);

    const handleSave = useCallback(async () => {
        if (!selectedEntry) return;
        setIsSaving(true);
        try {
            await savePromptOverride(selectedEntry.id, draft, activeUser);
            setOverrides(getPromptOverrides());
            setIsDirty(false);
            // Show the saved result rendered, like re-opening the md file.
            setIsPreview(true);
            if (draftWarnings.length > 0) {
                toast.success('Prompt updated', `Saved with ${draftWarnings.length} advisory warning${draftWarnings.length === 1 ? '' : 's'}.`);
            } else {
                toast.success('Prompt updated', `"${selectedEntry.name}" now applies to new analyses.`);
            }
        } catch (e) {
            console.error('[PromptManager] Save failed:', e);
            toast.error('Could not save', e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsSaving(false);
        }
    }, [selectedEntry, draft, draftWarnings, activeUser, toast]);

    const handleResetOne = useCallback(async () => {
        if (!selectedEntry) return;
        await resetPromptOverride(selectedEntry.id, activeUser);
        setOverrides(getPromptOverrides());
        setDraft(selectedEntry.fallback);
        setIsDirty(false);
        toast.success('Prompt reset', `"${selectedEntry.name}" back to the built-in default.`);
    }, [selectedEntry, activeUser, toast]);

    const handleResetAll = useCallback(async () => {
        const ok = await confirm({
            title: 'Reset all prompts?',
            message: `This restores all ${PROMPT_REGISTRY.length} prompts to their built-in defaults. Your edits are lost.`,
            confirmLabel: 'Reset all',
            destructive: true,
        });
        if (!ok) return;
        await resetAllPromptOverrides(activeUser);
        setOverrides({});
        if (selectedEntry) setDraft(selectedEntry.fallback);
        setIsDirty(false);
        toast.success('Prompts reset', 'All prompts are back to their built-in defaults.');
    }, [activeUser, selectedEntry, confirm, toast]);

    return (
        <div className="flex flex-col h-full min-h-0 px-8 pb-8 pt-8 lg:px-10">
            <div className="w-full flex flex-col flex-1 min-h-0">
            <div className="flex items-start justify-between gap-4 shrink-0 pt-7 mb-8">
                <div>
                    <h3 className="text-ui-lg font-semibold tracking-[-0.01em] text-zinc-100">Prompts</h3>
                    <p className="text-ui-sm text-zinc-500 mt-2 leading-relaxed">
                        Every prompt sent to your models. Edits apply on the next analysis.
                    </p>
                </div>
                {modifiedCount > 0 && (
                    <button
                        type="button"
                        onClick={handleResetAll}
                        className=" shrink-0 px-3 py-2 rounded-control border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-ui-sm font-medium transition-colors"
                    >
                        Reset all ({modifiedCount})
                    </button>
                )}
            </div>

            <div className="relative shrink-0 mb-8">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" aria-hidden="true" />
                <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search prompts…"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-control pl-10 pr-3 py-3 text-ui-base text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                    aria-label="Search prompts"
                />
            </div>

            {selectedEntry ? (
                <div className="flex-1 min-h-0 flex flex-col">
                    <button
                        onClick={() => { void goBackToList(); }}
                        className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-6 self-start"
                    >
                        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Back
                    </button>
                    <div className="flex items-start justify-between gap-3 mb-2">
                        <h4 className="text-lg font-medium text-zinc-100 tracking-tight font-mono">
                            {selectedEntry.id.replace(/\./g, '-')}.md
                        </h4>
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={() => { setIsDiff(v => !v); setIsPreview(false); }}
                                className={`px-3 py-1.5 rounded-control text-ui-base transition-colors ${isDiff ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900'}`}
                            >
                                Diff
                            </button>
                            <button
                                onClick={() => { setIsPreview(v => !v); setIsDiff(false); }}
                                className="px-3 py-1.5 rounded-control text-ui-base text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
                            >
                                {isPreview ? 'Write' : 'Preview'}
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!isDirty || isSaving}
                                className="px-3 py-1.5 rounded-control text-ui-base bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-100 transition-colors"
                            >
                                {isSaving ? 'Saving…' : 'Save'}
                            </button>
                            {isModified && (
                                <button
                                    onClick={handleResetOne}
                                    className="px-3 py-1.5 rounded-control text-ui-base text-zinc-500 hover:text-zinc-200 transition-colors"
                                >
                                    Reset
                                </button>
                            )}
                        </div>
                    </div>
                    <p className="text-ui-base text-zinc-500 mb-4">{selectedEntry.description}</p>
                    {draftWarnings.length > 0 && (
                        <ul className="mb-6 list-disc space-y-1 pl-5 text-ui-base text-zinc-400">
                            {draftWarnings.map(w => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    )}
                    <div className="flex-1 min-h-[320px] rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        {isDiff ? (
                            <PromptDiffView baseText={selectedEntry.fallback} currentText={draft} />
                        ) : isPreview ? (
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-8 py-8 lg:px-10 lg:py-10">
                                <MarkdownContent content={draft || '(empty prompt)'} className="text-ui-lede leading-8" />
                            </div>
                        ) : (
                            <textarea
                                value={draft}
                                onChange={e => { setDraft(e.target.value); setIsDirty(true); }}
                                spellCheck={false}
                                className="flex-1 w-full resize-none bg-transparent px-8 py-8 lg:px-10 lg:py-10 text-ui-lede leading-8 text-zinc-200 font-mono focus:outline-none custom-scrollbar"
                                placeholder="(empty override — the built-in default is used)"
                                aria-label={`Edit ${selectedEntry.name}`}
                            />
                        )}
                    </div>
                    <p className="shrink-0 text-ui-sm text-zinc-600 mt-4">
                        {isModified
                            ? 'Your edited version is live. Saving an empty editor removes the override.'
                            : 'No override yet — the built-in default above is what models currently see.'}
                    </p>
                </div>
            ) : searchQuery.trim() || selectedGroupKey ? (
                <div className="flex-1 min-h-0 flex flex-col">
                    {!searchQuery.trim() && (
                        <button
                            onClick={() => { void goBackToCategories(); }}
                            className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-6 self-start"
                        >
                            <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Back
                        </button>
                    )}
                    {selectedGroupKey && !searchQuery.trim() && (
                        <h4 className="text-lg font-medium text-zinc-100 tracking-tight mb-8">
                            {groupLabel(selectedGroupKey)}
                        </h4>
                    )}
                    <div className="flex-1 min-h-0 rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden">
                        {isLoading ? (
                            <div className="flex justify-center py-16"><LoadingIcon className="w-6 h-6 text-zinc-500" aria-hidden="true" /></div>
                        ) : visibleEntries.length === 0 ? (
                            <p className="text-ui-base text-zinc-500 text-center py-16">
                                {searchQuery ? `No prompts match "${searchQuery}".` : 'No prompts in this category.'}
                            </p>
                        ) : (
                            <div className="overflow-y-auto custom-scrollbar h-full">
                                {visibleEntries.map(entry => (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => { void openEntry(entry); }}
                                        className="w-full flex items-center gap-3.5 px-4 py-3.5 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/80 transition-colors text-left"
                                    >
                                        <span className="w-9 h-9 rounded-control bg-zinc-800 border border-zinc-700/80 flex items-center justify-center shrink-0">
                                            <FileTextIcon className="w-4 h-4 text-zinc-400" aria-hidden="true" />
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span className="block font-mono text-ui-base text-zinc-100 truncate" title={`${entry.id.replace(/\./g, '-')}.md`}>
                                                {entry.id.replace(/\./g, '-')}.md
                                            </span>
                                            <span className="block text-ui-sm text-zinc-500 mt-0.5 truncate" title={entry.description}>
                                                {entry.description}
                                            </span>
                                        </span>
                                        {overrides[entry.id] !== undefined && (
                                            <span className="text-ui-xs uppercase tracking-widest text-zinc-500 shrink-0">edited</span>
                                        )}
                                        <ChevronRightIcon className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex-1 min-h-0 rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden">
                    {isLoading ? (
                        <div className="flex justify-center py-16"><LoadingIcon className="w-6 h-6 text-zinc-500" aria-hidden="true" /></div>
                    ) : (
                        <div className="overflow-y-auto custom-scrollbar h-full">
                            {allGroups.map(group => {
                                const edited = group.entries.filter(e => overrides[e.id] !== undefined).length;
                                return (
                                    <button
                                        key={group.key}
                                        type="button"
                                        onClick={() => { void selectCategory(group.key); }}
                                        className="w-full flex items-center gap-3.5 px-4 py-3.5 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/80 transition-colors text-left"
                                    >
                                        <span className="w-9 h-9 rounded-control bg-zinc-800 border border-zinc-700/80 flex items-center justify-center shrink-0">
                                            <FolderIcon className="w-4 h-4 text-zinc-400" aria-hidden="true" />
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-ui-base font-medium text-zinc-100 truncate" title={group.label}>
                                                {group.label}
                                            </span>
                                            <span className="block text-ui-sm text-zinc-500 mt-0.5 truncate" title={`${group.entries.length} ${group.entries.length === 1 ? 'prompt' : 'prompts'}${edited > 0 ? ` · ${edited} edited` : ''}`}>
                                                {group.entries.length} {group.entries.length === 1 ? 'prompt' : 'prompts'}
                                                {edited > 0 ? ` · ${edited} edited` : ''}
                                            </span>
                                        </span>
                                        <ChevronRightIcon className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
            {ConfirmDialogComponent}
            </div>
        </div>
    );
};

// ─── Prompt diff viewer ─────────────────────────────────────────────────────
// Side-by-side built-in default vs current text with changed lines marked.
// Line-level LCS (small inputs — prompts are a few KB — so O(n·m) is fine).

type DiffOp = 'same' | 'add' | 'remove';

interface DiffRow {
    op: DiffOp;
    baseLine?: string;
    currentLine?: string;
}

const diffLines = (base: string, current: string): DiffRow[] => {
    const a = base.split('\n');
    const b = current.split('\n');
    // LCS table
    const m = a.length, n = b.length;
    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const rows: DiffRow[] = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { rows.push({ op: 'same', baseLine: a[i], currentLine: b[j] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ op: 'remove', baseLine: a[i] }); i++; }
        else { rows.push({ op: 'add', currentLine: b[j] }); j++; }
    }
    while (i < m) { rows.push({ op: 'remove', baseLine: a[i] }); i++; }
    while (j < n) { rows.push({ op: 'add', currentLine: b[j] }); j++; }
    return rows;
};

const PromptDiffView: React.FC<{ baseText: string; currentText: string }> = ({ baseText, currentText }) => {
    const rows = useMemo(() => diffLines(baseText, currentText), [baseText, currentText]);
    const changed = rows.filter(r => r.op !== 'same').length;
    return (
        <div className="flex-1 overflow-y-auto custom-scrollbar text-ui-sm font-mono leading-5">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2 text-ui-dense font-sans">
                <span className="text-zinc-500">Built-in default ← → your version</span>
                <span className={changed > 0 ? 'text-amber-400' : 'text-zinc-500'}>
                    {changed > 0 ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'identical'}
                </span>
            </div>
            {rows.map((row, index) => (
                <div
                    key={index}
                    className={`grid grid-cols-2 gap-0 border-b border-hairline ${
                        row.op === 'add' ? 'bg-emerald-500/5' : row.op === 'remove' ? 'bg-rose-500/5' : ''
                    }`}
                >
                    <div className={`whitespace-pre-wrap break-words px-4 py-0.5 ${row.op === 'remove' ? 'text-rose-300' : 'text-zinc-500'} ${row.op === 'add' ? 'opacity-40' : ''}`}>
                        {row.baseLine ?? ''}
                    </div>
                    <div className={`whitespace-pre-wrap break-words border-l border-hairline px-4 py-0.5 ${row.op === 'add' ? 'text-emerald-300' : 'text-zinc-500'} ${row.op === 'remove' ? 'opacity-40' : ''}`}>
                        {row.currentLine ?? ''}
                    </div>
                </div>
            ))}
        </div>
    );
};

export default React.memo(PromptManager);
