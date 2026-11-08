import React, { useState, useEffect, useCallback } from 'react';
import { MemoryFile, MemoryFolder } from '../../types';
import { ProviderConfig } from '../../types/provider';
import { useToastActions } from '../shared/Toast';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import { ToggleSwitch } from '../shared/ToggleSwitch';
import MarkdownContent from '../shared/MarkdownContent';
import {FileTextIcon, ChevronRightIcon, ChevronLeftIcon, ChevronUpIcon, ChevronDownIcon, FolderIcon, FileText, Loader2} from '../shared/Icons';

import { runNotebookReview } from '../../services/learning/MemoryReviewService';
import { isSkillFile } from '../../services/learning/SkillFileService';
import { topicSummaryOf } from '../../services/learning/memoryTopics';
import { memoryUpdatedLabel } from './MemoryTopicsCard';
import {
    initMemoryFiles,
    getMemoryFiles,
    getMemoryFilesStats,
    createMemoryFolder,
    createMemoryFile,
    updateMemoryFile,
    deleteMemoryFile,
    moveMemoryFolder,
    SUGGESTIONS_FILE_NAME,
    subscribeMemoryFilesChanged,
    listNotebookCorruptSidecars,
    restoreNotebookFromCorruptSidecar,
    type NotebookCorruptSidecar,
} from '../../services/learning/MemoryFilesService';

interface MemoryFilesManagerProps {
    /** Active user — notebook files are stored per-user. */
    username?: string;
    isGlobalMemoryEnabled?: boolean;
    setIsGlobalMemoryEnabled?: (enabled: boolean) => void;
    /** Memory provider/model picker (Settings). */
    memoryConfig?: ProviderConfig | null;
}

/**
 * Settings → Memory: folders of markdown files the model can READ.
 * The harness auto-maintains profile/, trader-diary/, rules/, and skills/.
 */
const MemoryFilesManager: React.FC<MemoryFilesManagerProps> = ({
    username,
    isGlobalMemoryEnabled,
    setIsGlobalMemoryEnabled,
    memoryConfig,
}) => {
    const toast = useToastActions();
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const [folders, setFolders] = useState<MemoryFolder[]>([]);
    const [files, setFiles] = useState<MemoryFile[]>([]);
    const [stats, setStats] = useState({ enabledCount: 0, charCount: 0 });
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
    const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [isDirty, setIsDirty] = useState(false);
    const [isPreview, setIsPreview] = useState(false);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [isCreatingFile, setIsCreatingFile] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [isReviewing, setIsReviewing] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [corruptSidecars, setCorruptSidecars] = useState<NotebookCorruptSidecar[]>([]);

    const activeUser = username || 'default';

    const refresh = useCallback(() => {
        const { folders, files } = getMemoryFiles();
        setFolders(folders);
        setFiles(files);
        setStats(getMemoryFilesStats());
    }, []);

    useEffect(() => {
        let cancelled = false;
        initMemoryFiles(activeUser).then(() => {
            if (cancelled) return;
            refresh();
        });
        return () => { cancelled = true; };
    }, [activeUser, refresh]);

    useEffect(() => subscribeMemoryFilesChanged(() => refresh()), [refresh]);

    useEffect(() => {
        let cancelled = false;
        void listNotebookCorruptSidecars(activeUser).then(rows => {
            if (!cancelled) setCorruptSidecars(rows);
        });
        return () => { cancelled = true; };
    }, [activeUser, refresh]);

    const handleRestoreSidecar = useCallback(async (sidecar: NotebookCorruptSidecar) => {
        const ok = await confirm({
            title: 'Restore this preserved notebook?',
            message: `This replaces the live notebook with the copy preserved ${sidecar.capturedAt ? new Date(sidecar.capturedAt).toLocaleString() : 'earlier'}. The current notebook is kept until your next write.`,
            confirmLabel: 'Restore copy',
            destructive: true,
        });
        if (!ok) return;
        const restored = await restoreNotebookFromCorruptSidecar(activeUser, sidecar.key);
        if (restored) {
            refresh();
            setCorruptSidecars(await listNotebookCorruptSidecars(activeUser));
            toast.success('Notebook restored', 'The preserved copy is live again.');
        } else {
            toast.error('Could not restore', 'That preserved copy is not a readable notebook.');
        }
    }, [activeUser, confirm, refresh, toast]);

    const selectedFile = selectedFileId ? files.find(f => f.id === selectedFileId) ?? null : null;

    const selectedFolder = selectedFolderId ? folders.find(f => f.id === selectedFolderId) ?? null : null;

    const suggestionsFile = files.find(f => f.name === SUGGESTIONS_FILE_NAME) ?? null;

    const visibleFiles = selectedFolderId
        ? files.filter(f => f.folderId === selectedFolderId && f.name !== SUGGESTIONS_FILE_NAME)
        : [];

    const openFile = useCallback((file: MemoryFile) => {
        setSelectedFileId(file.id);
        setDraft(file.content);
        setIsDirty(false);
        setIsPreview(true);
    }, []);

    const handleFileSwitch = useCallback(async (file: MemoryFile) => {
        if (isDirty) {
            const ok = await confirm({
                title: 'Discard unsaved changes?',
                message: `You have unsaved edits to "${selectedFile?.name}". They will be lost if you switch files.`,
                confirmLabel: 'Discard',
                destructive: true,
            });
            if (!ok) return;
        }
        openFile(file);
    }, [isDirty, selectedFile, confirm, openFile]);

    const goBackToList = useCallback(async () => {
        if (isDirty) {
            const ok = await confirm({
                title: 'Discard unsaved changes?',
                message: `You have unsaved edits to "${selectedFile?.name}". They will be lost if you go back.`,
                confirmLabel: 'Discard',
                destructive: true,
            });
            if (!ok) return;
        }
        setSelectedFileId(null);
        setIsDirty(false);
    }, [isDirty, selectedFile, confirm]);

    const goBackToFolders = useCallback(async () => {
        if (selectedFileId) {
            await goBackToList();
            return;
        }
        setSelectedFolderId(null);
        setIsCreatingFile(false);
    }, [selectedFileId, goBackToList]);

    const handleCreateFolder = useCallback(async () => {
        const name = newFolderName.trim();
        if (!name) return;
        try {
            const folder = await createMemoryFolder(name, activeUser);
            refresh();
            setIsCreatingFolder(false);
            setNewFolderName('');
            setSelectedFolderId(folder.id);
            toast.success('Folder created', `"${folder.name}" is ready for files.`);
        } catch (e: unknown) {
            toast.error('Could not create folder', e instanceof Error ? e.message : 'Unknown error');
        }
    }, [newFolderName, activeUser, refresh, toast]);

    const handleCreateFile = useCallback(async () => {
        const name = newFileName.trim();
        if (!name || !selectedFolderId) return;
        try {
            const content = `# ${name.replace(/\.md$/i, '')}\n\nWrite what the model should know about this topic — it reads this file on every analysis.\n`;
            const file = await createMemoryFile(selectedFolderId, name, content, activeUser);
            refresh();
            setIsCreatingFile(false);
            setNewFileName('');
            openFile(file);
            toast.success('File created', `"${file.name}" was added to the notebook.`);
        } catch (e: unknown) {
            toast.error('Could not create file', e instanceof Error ? e.message : 'Unknown error');
        }
    }, [newFileName, selectedFolderId, activeUser, refresh, toast, openFile]);

    const handleSave = useCallback(async () => {
        if (!selectedFile) return;
        try {
            await updateMemoryFile(selectedFile.id, { content: draft }, activeUser);
            setIsDirty(false);
            refresh();
            // Saving is not the same fact as being offered to a model: a skill
            // still needs approval, and notebook text is retrieved when relevant,
            // not pasted into every prompt. Say what the write did.
            toast.success('Saved', `"${selectedFile.name}" was saved to the notebook.`);
        } catch (e: unknown) {
            toast.error('Could not save', e instanceof Error ? e.message : 'Unknown error');
        }
    }, [selectedFile, draft, activeUser, refresh, toast]);

    const handleToggleEnabled = useCallback(async (file: MemoryFile) => {
        try {
            const enabling = !file.enabled;
            const patch: Partial<MemoryFile> = { enabled: enabling };
            await updateMemoryFile(file.id, patch, activeUser);
            refresh();
            toast.success(enabling ? 'Enabled' : 'Disabled',
                !enabling
                    ? `"${file.name}" is no longer offered to the models.`
                    : isSkillFile(file)
                        ? `"${file.name}" is enabled - the models can use it when its description matches.`
                        : `"${file.name}" is enabled - the models can read it when it is relevant.`);
        } catch (e: unknown) {
            toast.error('Could not toggle file', e instanceof Error ? e.message : 'Unknown error');
        }
    }, [activeUser, refresh, toast]);

    /** The folder's date column: the newest file in it. `null` for a folder
     *  with nothing in it — the column then says so rather than printing a
     *  date the folder never had. */
    const latestFileUpdatedAt = useCallback((folderId: string): number | null => {
        const inFolder = files.filter(f => f.folderId === folderId && f.name !== SUGGESTIONS_FILE_NAME);
        if (inFolder.length === 0) return null;
        return inFolder.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)).updatedAt;
    }, [files]);

    const handleDeleteFile = useCallback(async (file: MemoryFile) => {
        const ok = await confirm({
            title: `Delete "${file.name}"?`,
            message: file.autoManaged
                ? 'This file is auto-maintained by the app and will be regenerated on the next sync.'
                : 'This file will be permanently removed from the notebook.',
            confirmLabel: 'Delete',
            destructive: true,
        });
        if (!ok) return;
        try {
            await deleteMemoryFile(file.id, activeUser);
            if (selectedFileId === file.id) setSelectedFileId(null);
            refresh();
            toast.success('File deleted', `"${file.name}" was removed.`);
        } catch (e: unknown) {
            toast.error('Could not delete file', e instanceof Error ? e.message : 'Unknown error');
        }
    }, [selectedFileId, activeUser, refresh, toast, confirm]);

    const handleRunReview = useCallback(async () => {
        if (!memoryConfig?.apiKey) {
            toast.error('Pick a Memory model', 'Settings → Memory needs a provider before reviews can run.');
            return;
        }
        setIsReviewing(true);
        try {
            const wrote = await runNotebookReview(activeUser, memoryConfig);
            refresh();
            if (wrote) toast.success('Suggestions updated', 'The Memory model finished reviewing the notebook.');
            else toast.success('Review finished', 'No new suggestions this time.');
        } catch (e: unknown) {
            toast.error('Review failed', e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsReviewing(false);
        }
    }, [memoryConfig, activeUser, refresh, toast]);

    return (
        <div className="flex flex-col h-full min-h-0 px-8 py-8 lg:px-12 lg:py-10">
            <div className="w-full max-w-4xl mx-auto flex flex-col flex-1 min-h-0">
            <div className="flex items-start justify-between gap-4 shrink-0 mb-8">
                <div>
                    <h3 className="text-3xl font-semibold text-zinc-100 tracking-tight">Memory</h3>
                    <p className="text-ui-base text-zinc-500 mt-2 leading-relaxed">
                        Notebook files the model reads. Skills, diaries, and rules live here.
                    </p>
                </div>
                <span className="shrink-0 text-ui-sm text-zinc-500 pt-2">
                    {stats.enabledCount} enabled · {stats.charCount.toLocaleString()} chars
                </span>
            </div>

            {corruptSidecars.length > 0 && (
                <div className="shrink-0 mb-6 rounded-bubble border border-amber-500/30 bg-amber-500/[0.06] p-4" data-testid="notebook-recovery">
                    <p className="text-ui-base font-semibold text-amber-300">A notebook copy was preserved</p>
                    <p className="mt-1 text-ui-sm text-zinc-400">
                        The loader could not verify the notebook and kept a sidecar copy. Your stored notebook was not overwritten.
                    </p>
                    <div className="mt-2 space-y-1.5">
                        {corruptSidecars.map(s => (
                            <div key={s.key} className="flex items-center justify-between gap-3 rounded-control border border-hairline bg-zinc-900/60 px-2.5 py-1.5">
                                <span className="font-mono text-ui-xs text-zinc-400">
                                    {s.capturedAt ? new Date(s.capturedAt).toLocaleString() : s.key}
                                    {s.reason ? ` · ${s.reason}` : ''}
                                    {s.bytes ? ` · ${s.bytes.toLocaleString()} chars` : ''}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => { void handleRestoreSidecar(s); }}
                                    className="shrink-0 rounded-control bg-amber-600/90 px-2.5 py-1 text-ui-dense font-medium text-white hover:bg-amber-500"
                                >
                                    Restore this copy
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-wrap items-end gap-4 shrink-0 mb-8">
                {/* The Memory Model picker moved to Settings →
                    AI Setup (it owns every learning pass); this surface shows
                    a read-only pointer so ownership stays discoverable. */}
                {memoryConfig && (
                    <div className="pb-2">
                        <span className="text-ui-xs uppercase tracking-widest text-zinc-600">Managed by </span>
                        <span className="text-ui-sm text-zinc-400">{memoryConfig.selectedModel || memoryConfig.name || 'memory model'}</span>
                    </div>
                )}
                {setIsGlobalMemoryEnabled && (
                    <div className="flex items-center gap-3 pb-2 ml-auto">
                        <span className="text-ui-sm font-medium uppercase tracking-widest text-zinc-500">Global memory</span>
                        <ToggleSwitch
                            checked={!!isGlobalMemoryEnabled}
                            onChange={() => setIsGlobalMemoryEnabled(!isGlobalMemoryEnabled)}
                            label="Toggle Global Memory"
                        />
                    </div>
                )}
            </div>

            {isCreatingFolder && !selectedFolder && !selectedFile && (
                <div className="shrink-0 mb-4">
                    <input
                        autoFocus
                        value={newFolderName}
                        onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void handleCreateFolder(); if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); } }}
                        placeholder="new-folder"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-control px-4 py-3 text-ui-base text-zinc-100 outline-none focus:border-zinc-600"
                    />
                </div>
            )}

            {showSuggestions ? (
                <div className="flex-1 min-h-0 flex flex-col">
                    <button
                        type="button"
                        onClick={() => setShowSuggestions(false)}
                        aria-label="Back to the notebook"
                        className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-6 self-start"
                    >
                        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Notebook
                    </button>
                    <div className="flex items-start justify-between gap-3 mb-2">
                        <h4 className="text-ui-xl font-semibold text-zinc-100 tracking-tight">Suggestions</h4>
                        <button
                            type="button"
                            onClick={() => { void handleRunReview(); }}
                            disabled={isReviewing}
                            className="px-3 py-1.5 rounded-control text-ui-dense bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-100 transition-colors"
                        >
                            {isReviewing ? 'Reviewing…' : 'Review now'}
                        </button>
                    </div>
                    <p className="text-ui-base text-zinc-500 mb-8">
                        Memory model review of your notebook. Not injected into analyses.
                    </p>
                    <div className="flex-1 min-h-[320px] rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        {isReviewing ? (
                            <div className="flex-1 flex items-center justify-center gap-2 text-ui-base text-zinc-500">
                                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Reviewing notebook…
                            </div>
                        ) : suggestionsFile?.content.trim() ? (
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-8 py-8 lg:px-10 lg:py-10">
                                <MarkdownContent content={suggestionsFile.content} className="text-ui-lede leading-8" />
                            </div>
                        ) : (
                            <p className="text-ui-base text-zinc-500 text-center py-16 px-8">
                                No suggestions yet. After notebook files change, the Memory model reviews them here. You can also tap Review now.
                            </p>
                        )}
                    </div>
                </div>
            ) : selectedFile ? (
                <div className="flex-1 min-h-0 flex flex-col">
                    <button
                        onClick={() => { void goBackToList(); }}
                        aria-label="Back to the folder"
                        className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-6 self-start"
                    >
                        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Notebook
                    </button>
                    <div className="flex items-start justify-between gap-3 mb-2">
                        <h4 className="text-ui-xl font-semibold text-zinc-100 tracking-tight font-mono">
                            {selectedFile.name}
                        </h4>
                        <div className="flex items-center gap-2 shrink-0">
                            <ToggleSwitch
                                checked={selectedFile.enabled}
                                onChange={() => { void handleToggleEnabled(selectedFile); }}
                                label="Toggle file injection"
                            />
                            <button
                                onClick={() => setIsPreview(v => !v)}
                                className="px-3 py-1.5 rounded-control text-ui-dense text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
                            >
                                {isPreview ? 'Write' : 'Preview'}
                            </button>
                            <button
                                onClick={() => { void handleSave(); }}
                                disabled={!isDirty}
                                className="px-3 py-1.5 rounded-control text-ui-dense bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-100 transition-colors"
                            >
                                Save
                            </button>
                            {/* The reference's Delete is a RAISED chip; the word
                                keeps the app's own rose so a destructive press
                                still reads as one. */}
                            <button
                                onClick={() => { void handleDeleteFile(selectedFile); }}
                                className="px-3 py-1.5 rounded-control text-ui-dense bg-zinc-800 hover:bg-zinc-700 font-medium text-rose-300 hover:text-rose-200 transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-3 mb-8 flex-wrap">
                        <p className="text-ui-base text-zinc-500">
                            {folders.find(f => f.id === selectedFile.folderId)?.name ?? selectedFile.folderId}
                            {selectedFile.autoManaged ? ' · auto-maintained' : ''}
                            {' · '}{draft.length.toLocaleString()} chars
                        </p>
                    </div>
                    <div className="flex-1 min-h-[320px] rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        {isPreview ? (
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-8 py-8 lg:px-10 lg:py-10">
                                <MarkdownContent content={draft || '(empty file)'} className="text-ui-lede leading-8" />
                            </div>
                        ) : (
                            <textarea
                                value={draft}
                                onChange={e => { setDraft(e.target.value); setIsDirty(true); }}
                                spellCheck={false}
                                className="flex-1 w-full resize-none bg-transparent px-8 py-8 lg:px-10 lg:py-10 text-ui-lede leading-8 text-zinc-200 font-mono focus:outline-none custom-scrollbar"
                                placeholder="# Write what the model should know…"
                                aria-label={`Edit ${selectedFile.name}`}
                            />
                        )}
                    </div>
                </div>
            ) : selectedFolder ? (
                <div className="flex-1 min-h-0 flex flex-col">
                    <button
                        onClick={() => { void goBackToFolders(); }}
                        aria-label="Back to the notebook"
                        className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-6 self-start"
                    >
                        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Notebook
                    </button>
                    <h4 className="text-ui-xl font-semibold text-zinc-100 tracking-tight font-mono mb-8">
                        {selectedFolder.name}
                    </h4>
                    <div className="flex-1 min-h-0 rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        <div className="flex items-center justify-end px-5 py-3 border-b border-zinc-800 shrink-0">
                            <button
                                type="button"
                                onClick={() => { setIsCreatingFile(v => !v); setIsCreatingFolder(false); }}
                                className="text-ui-sm text-zinc-400 hover:text-zinc-100 transition-colors"
                            >
                                New file
                            </button>
                        </div>
                        {isCreatingFile && (
                            <div className="px-5 py-3 border-b border-zinc-800">
                                <input
                                    autoFocus
                                    value={newFileName}
                                    onChange={e => setNewFileName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') void handleCreateFile(); if (e.key === 'Escape') { setIsCreatingFile(false); setNewFileName(''); } }}
                                    placeholder="my-note.md"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-control px-4 py-2 text-ui-base text-zinc-100 outline-none focus:border-zinc-600"
                                />
                            </div>
                        )}
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {visibleFiles.length === 0 ? (
                                <p className="text-ui-base text-zinc-500 text-center py-16">
                                    This folder is empty. Create the first file.
                                </p>
                            ) : (
                                visibleFiles.map(file => (
                                    <button
                                        key={file.id}
                                        type="button"
                                        onClick={() => { void handleFileSwitch(file); }}
                                        className="w-full flex items-center gap-4 px-5 py-3 border-b border-zinc-800/80 last:border-b-0 hover:bg-white/[0.04] transition-colors text-left"
                                    >
                                        <FileTextIcon className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
                                        {/* The reference's row: the name, what it
                                            says, and when it was last written. */}
                                        <span className="flex w-[26%] min-w-0 shrink-0 items-center gap-2">
                                            <span className="min-w-0 truncate font-mono text-ui-base text-zinc-100" title={file.name}>
                                                {file.name}
                                            </span>
                                            {file.autoManaged && (
                                                <span className="text-ui-xs uppercase tracking-widest text-zinc-600 shrink-0">auto</span>
                                            )}
                                            {!file.enabled && (
                                                <span className="text-ui-xs uppercase tracking-widest text-zinc-600 shrink-0">off</span>
                                            )}
                                        </span>
                                        <span
                                            className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500"
                                            title={file.content.trim() ? topicSummaryOf(file.content) : 'Empty file'}
                                        >
                                            {file.content.trim() ? topicSummaryOf(file.content) : 'Empty file'}
                                        </span>
                                        <span className="w-28 shrink-0 text-right text-ui-dense text-zinc-500 tabular-nums">
                                            {memoryUpdatedLabel(file.updatedAt)}
                                        </span>
                                        <ChevronRightIcon className="w-4 h-4 text-zinc-700 shrink-0" aria-hidden="true" />
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="flex-1 min-h-0 rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                    <div className="flex items-center justify-end px-5 py-3 border-b border-zinc-800 shrink-0">
                        <button
                            type="button"
                            onClick={() => { setIsCreatingFolder(v => !v); setIsCreatingFile(false); }}
                            className="min-h-6 text-ui-sm text-zinc-400 hover:text-zinc-100 transition-colors"
                        >
                            New folder
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                        <button
                            type="button"
                            onClick={() => {
                                setShowSuggestions(true);
                                setSelectedFolderId(null);
                                setSelectedFileId(null);
                            }}
                            className="w-full flex items-center gap-4 px-5 py-3 border-b border-zinc-800/80 hover:bg-white/[0.04] transition-colors text-left"
                        >
                            <FileText className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
                            <span className="w-[26%] min-w-0 shrink-0 truncate text-ui-base font-medium text-zinc-100" title="Suggestions">
                                Suggestions
                            </span>
                            <span
                                className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500"
                                title="Memory model review — tap to open"
                            >
                                Memory model review — tap to open
                            </span>
                            <span className="w-28 shrink-0 text-right text-ui-dense text-zinc-500 tabular-nums">
                                {suggestionsFile ? memoryUpdatedLabel(suggestionsFile.updatedAt) : '—'}
                            </span>
                            <ChevronRightIcon className="w-4 h-4 text-zinc-700 shrink-0" aria-hidden="true" />
                        </button>
                        {folders.length === 0 ? (
                            <p className="text-ui-base text-zinc-500 text-center py-16">No folders yet.</p>
                        ) : (
                            [...folders].sort((a, b) => a.order - b.order).map((folder, index, sorted) => {
                                const count = files.filter(f => f.folderId === folder.id && f.name !== SUGGESTIONS_FILE_NAME).length;
                                const handleMove = async (direction: -1 | 1): Promise<void> => {
                                    const target = sorted[index + direction];
                                    if (!target) return;
                                    try {
                                        await moveMemoryFolder(folder.id, target.order, activeUser);
                                        await initMemoryFiles(activeUser);
                                        setFolders(getMemoryFiles().folders);
                                        toast.success('Folder moved', `"${folder.name}" is now ${direction === -1 ? 'higher' : 'lower'} in the notebook.`);
                                    } catch (e) {
                                        toast.error('Could not move folder', e instanceof Error ? e.message : 'Unknown error');
                                    }
                                };
                                return (
                                    <div
                                        key={folder.id}
                                        className="flex w-full items-center border-b border-zinc-800/80 text-left transition-colors last:border-b-0 hover:bg-white/[0.04] group/folder"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedFolderId(folder.id);
                                                setIsCreatingFolder(false);
                                                setIsCreatingFile(false);
                                            }}
                                            // The row's inset lives HERE, on the control, not on
                                            // the wrapper: padding on the wrapper highlighted the
                                            // whole row but only the middle band was clickable, and
                                            // on the touch build — where the reorder arrows wait for
                                            // a hover that never comes — the dead strip was the
                                            // entire edge of the row. Geometry is unchanged: 16px
                                            // inset, 14px between the name and the arrows, 16px to
                                            // the right edge.
                                            className="flex min-w-0 flex-1 items-center gap-4 py-3 pl-4 pr-3 text-left"
                                        >
                                        <FolderIcon className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
                                        <span className="w-[26%] min-w-0 shrink-0 truncate text-ui-base font-medium text-zinc-100" title={folder.name}>
                                            {folder.name}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500" title={`${count} ${count === 1 ? 'file' : 'files'}`}>
                                            {count} {count === 1 ? 'file' : 'files'}
                                        </span>
                                        <span className="w-28 shrink-0 text-right text-ui-dense text-zinc-500 tabular-nums">
                                            {latestFileUpdatedAt(folder.id) === null
                                                ? '—'
                                                : memoryUpdatedLabel(latestFileUpdatedAt(folder.id))}
                                        </span>
                                        </button>
                                        <span className="hidden group-hover/folder:flex items-center shrink-0 pr-4">
                                            <button
                                                type="button"
                                                aria-label={`Move ${folder.name} up`}
                                                title="Move up"
                                                disabled={index === 0}
                                                onClick={() => void handleMove(-1)}
                                                className="rounded-control p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
                                            >
                                                <ChevronUpIcon className="h-4 w-4" aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={`Move ${folder.name} down`}
                                                title="Move down"
                                                disabled={index === sorted.length - 1}
                                                onClick={() => void handleMove(1)}
                                                className="rounded-control p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-30"
                                            >
                                                <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
                                            </button>
                                        </span>
                                        <ChevronRightIcon className="w-4 h-4 text-zinc-600 shrink-0 group-hover/folder:hidden" aria-hidden="true" />
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
            {ConfirmDialogComponent}
            </div>
        </div>
    );
};

export default React.memo(MemoryFilesManager);
