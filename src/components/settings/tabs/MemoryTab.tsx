// TAB: Memory — the behavior switch, the notebook's folders as cards, and the
// entries index.
//
// The page follows the reference Settings → Memory shape: a "Memory behavior"
// card first (the switch that decides what the seat's memory tools may read
// and write this turn), then the notebook's folders as cards with live file
// counts and updated stamps, then the entries index grouped under
// You / Topics / Areas. The corrections log lives with the notebook it edits.
import React, { useEffect, useState } from 'react';
import ProfileMemoryCard from '../ProfileMemoryCard';
import AmendmentsInbox from '../../learn/AmendmentsInbox';
import { FolderIcon } from '../../shared/Icons';
import ToggleSwitch from '../../shared/ToggleSwitch';
import { getMemoryFiles, subscribeMemoryFilesChanged } from '../../../services/learning/MemoryFilesService';
import { SettingsGroup, SettingsPageHeader } from './shared';
import type { SettingsTabProps } from './types';

/** `SettingsTabProps`, narrowed to what this tab reads. An alias rather than an
 *  empty `interface extends` — that form is equivalent to its supertype and the
 *  lint rule flags it, and there is nothing to add here. The `onOpenLearn`
 *  binding is pre-narrowed in `SettingsMenu` so the child's callback stays
 *  typed. */
export type MemoryTabProps = SettingsTabProps;

interface FolderCard {
    id: string;
    name: string;
    count: number;
    updatedLabel: string;
}

const updatedStamp = (ms: number): string =>
    'Updated ' + new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

/** Folder cards from the live notebook store: one card per folder with the
 *  file count and the folder's latest file update. Auto-managed files (the
 *  trade diary, the harness's own folders) count too — the card is the
 *  folder's honest size, not a claim about who wrote what. */
const folderCards = (): FolderCard[] => {
    const store = getMemoryFiles();
    const cards = (store.folders || []).map((folder) => {
        const files = (store.files || []).filter(f => f.folderId === folder.id);
        let latest = 0;
        for (const f of files) { if (f.updatedAt > latest) latest = f.updatedAt; }
        return {
            id: folder.id,
            name: folder.name,
            count: files.length,
            updatedLabel: latest > 0 ? updatedStamp(latest) : 'No files yet',
        };
    });
    return cards.sort((a: FolderCard, b: FolderCard) => a.name.localeCompare(b.name));
};

const MemoryTab: React.FC<{ tab: MemoryTabProps }> = ({ tab: props }) => {
    const {
        memoryConfig,
        onOpenLearn,
        isGlobalMemoryEnabled,
        onToggleGlobalMemory,
    } = props;

    const model = memoryConfig?.selectedModel || memoryConfig?.name || undefined;
    // An entry's page IS the page — the reference drops the page title there and
    // leads with the back link, so the Memory heading belongs to the list only.
    const [detailOpen, setDetailOpen] = useState(false);
    const [folders, setFolders] = useState<FolderCard[]>(() => folderCards());

    useEffect(() => {
        const sync = () => setFolders(folderCards());
        sync();
        return subscribeMemoryFilesChanged(sync);
    }, []);

    const openNotebook = onOpenLearn ? () => onOpenLearn('memory') : undefined;

    return (
        <div className="animate-fade-in" data-testid="memory-tab">
            {!detailOpen && (
                <SettingsPageHeader
                    title="Memory"
                    description="View and manage the long-term memories the desk stores on this device."
                />
            )}

            <div className={detailOpen ? 'pt-7' : 'mt-7'}>
                {/* Memory behavior — the reference's first card: the switch that
                    decides what the seat's memory tools may read and write this
                    turn. OFF refuses everything at the executor, not just in
                    the prompt. */}
                <SettingsGroup
                    title="Memory behavior"
                    description="What the seat's memory tools may read and write. With memory off, nothing is read from or saved to the notebook."
                >
                    <div className="py-3">
                        <div className="flex items-center justify-between gap-6 rounded-control py-3 transition-colors hover:bg-white/[0.02]" data-testid="global-memory-toggle">
                            <div className="flex items-center gap-3 min-w-0">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-zinc-800 text-zinc-300">
                                    <FolderIcon className="h-4 w-4" aria-hidden="true" />
                                </span>
                                <div className="min-w-0">
                                    <div className="text-ui-sm font-medium text-zinc-100">Global memory</div>
                                    <p className="mt-1 text-ui-sm leading-relaxed text-zinc-500">
                                        When enabled, the seat reads and updates your preferences, habits and long-term
                                        context across surfaces. When disabled, the memory tools are refused — nothing is
                                        read or saved.
                                    </p>
                                </div>
                            </div>
                            {onToggleGlobalMemory && (
                                <ToggleSwitch
                                    checked={isGlobalMemoryEnabled !== false}
                                    onChange={onToggleGlobalMemory}
                                    label="Toggle Global Memory"
                                />
                            )}
                        </div>
                    </div>
                </SettingsGroup>

                {/* Notebook memory — one card per folder, with the folder's
                    honest file count and its latest update. Opening a card
                    lands on the Learning surface's notebook, the one home of
                    these files. */}
                {!detailOpen && (
                    <div className="mt-7">
                        <SettingsGroup
                            title="Notebook memory"
                            description="The folders the desk reads on every analysis. Open one to browse its files on the Learning surface."
                        >
                            <div className="py-3 grid gap-2 sm:grid-cols-2" data-testid="memory-folder-cards">
                                {folders.map(f => (
                                    <div key={f.id}
                                        className="flex items-center justify-between gap-4 rounded-control border border-hairline bg-zinc-950/40 px-3 py-3">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-zinc-800 text-zinc-300">
                                                <FolderIcon className="h-4 w-4" aria-hidden="true" />
                                            </span>
                                            <div className="min-w-0">
                                                <div className="truncate text-ui-sm font-medium text-zinc-100">{f.name}</div>
                                                <div className="text-ui-dense text-zinc-500">
                                                    {f.count} memory file{f.count === 1 ? '' : 's'} · {f.updatedLabel}
                                                </div>
                                            </div>
                                        </div>
                                        {openNotebook && (
                                            <button
                                                type="button"
                                                onClick={openNotebook}
                                                data-testid={`memory-folder-open-${f.id}`}
                                                className="shrink-0 rounded-control border border-zinc-800 px-2.5 py-1 text-ui-xs font-medium text-zinc-300 transition-colors hover:border-line hover:text-zinc-100"
                                            >
                                                Open
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </SettingsGroup>
                    </div>
                )}

                <ProfileMemoryCard
                    memoryModel={model}
                    onOpenNotebook={openNotebook}
                    onDetailOpenChange={setDetailOpen}
                />

                {/* The corrections log lives with the notebook it edits (owner
                    ruling 2026-11-03: no Approvals tab). Model amendments apply
                    themselves; this keeps the before/after and the ONE Undo.
                    A pending row exists only when a trader-requested edit
                    deferred one to a human. */}
                <div className="mt-7">
                    <SettingsGroup
                        title="Corrections"
                        description="Notes the desk changed with amend_memory. Applied directly — the before and after are kept here so a correction can be undone."
                    >
                        <div className="py-3">
                            <AmendmentsInbox />
                        </div>
                    </SettingsGroup>
                </div>
            </div>
        </div>
    );
};

export default MemoryTab;
