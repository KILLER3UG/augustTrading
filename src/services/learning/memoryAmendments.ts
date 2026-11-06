/**
 * memoryAmendments — the memory self-correction loop.
 *
 * writeModelNote can only CREATE/APPEND, so a wrong model-authored note
 * accumulates forever. This module gives models a second, gated path:
 * apply an amendment (edit or supersede an existing notebook file) DIRECTLY
 * (owner ruling 2026-10-29: no human approval gate). Every applied row keeps
 * the previous and applied bytes, so the log can undo it.
 *
 * Provenance is mandatory: who wrote, when, why, and exactly what changed.
 * Rejected rows are kept (tombstoned) so the same correction's history is
 * visible.
 */

import { MemoryFile } from '../../types/learning';
import { bytesOf } from '../../utils/memoryBudget';
import { SKILL_FOLDER } from './SkillFileService';
import { clearMemoryWriteFailure, findFolderByName, isHarnessRegeneratedTarget, recordMemoryWriteFailure } from './MemoryFilesService';

export interface MemoryAmendment {
    id: string;
    /** The notebook file this amendment targets. */
    fileId: string;
    fileName: string;
    kind: 'edit' | 'supersede';
    /** The full replacement content (edit) or appended section (supersede). */
    proposedContent: string;
    /** Why the model believes the current content is wrong/outdated. */
    reason: string;
    /** Which provider/model proposed it (provenance). */
    proposedBy: string;
    status: 'pending' | 'approved' | 'rejected' | 'undone';
    createdAt: string;
    /** Resolution metadata. */
    resolvedAt?: string;
    resolvedBy?: 'user' | 'model';
    /** Direct-write history: the file before and after this correction, so the
     *  activity log can undo it without a second store. */
    previousContent?: string;
    appliedContent?: string;
    appliedAt?: string;
    undoneAt?: string;
    sourceTurnId?: string;
}

const KEY_PREFIX = 'memory_amendments_v1';

/** Per profile, like every other queue in the app. The key was global, so a
 *  second profile saw the first's pending corrections and could approve them
 *  against its own notebook (the 2026-10-27 audit M-4). The unscoped key is still read
 *  as a legacy fallback so a queue written before this is not lost. */
const keyFor = (): string => {
    const user = (typeof localStorage !== 'undefined' && localStorage.getItem('last_active_user')) || 'default';
    return `${KEY_PREFIX}:${user}`;
};
const LEGACY_KEY = KEY_PREFIX;

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowIso = (): string => new Date().toISOString();

/** Proposals can arrive mid-session — App listens and toasts. */
export const AMENDMENT_EVENT = 'august:memory-amendment';

const load = (): MemoryAmendment[] => {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    try {
        const raw = window.localStorage.getItem(keyFor()) ?? window.localStorage.getItem(LEGACY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as MemoryAmendment[]) : [];
    } catch { return []; }
};

/**
 * Store the queue, or fail loudly.
 *
 * This key shares the origin quota with the notebook blob and every other
 * localStorage store in the app, so a refusal here is the same "your memory is
 * not being saved" event the notebook has — and it was the one memory write in
 * this loop with no owner at all: a bare `catch` that ignored the quota dropped
 * a model-proposed correction on the floor, and the next `load()` returned the
 * queue without it, with nothing anywhere saying so.
 *
 * So: record it (named, counted, sized — `recordMemoryWriteFailure`), then
 * rethrow. That is the same contract `proposeAmendment` already has for a
 * rejected proposal, so no caller's error handling has to learn a new shape:
 * the model sees it as tool feedback, the inbox shows it, and the health
 * report leads with it until a write reaches disk again.
 */
const save = (items: MemoryAmendment[]): void => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const payload = JSON.stringify(items);
    try {
        window.localStorage.setItem(keyFor(), payload);
    } catch (e) {
        recordMemoryWriteFailure(e, 'amendments', bytesOf(payload));
        throw e;
    }
    clearMemoryWriteFailure('amendments');
};

/** Cap the inbox — the oldest resolved entries fall off. */
const MAX_AMENDMENTS = 60;

export interface AmendValidation { ok: boolean; errors: string[] }

/** Validate a proposed amendment before it may be stored. */
export const validateAmendment = (input: {
    proposedContent: string;
    reason: string;
    targetFile?: MemoryFile | null;
}): AmendValidation => {
    const errors: string[] = [];
    if (!(input.proposedContent ?? '').trim()) errors.push('proposedContent is required');
    if (input.proposedContent.length > 8000) errors.push('proposedContent exceeds 8000 chars');
    if (!(input.reason ?? '').trim()) errors.push('reason is required');
    if (!input.targetFile) errors.push('target file not found');
    else if (input.targetFile.folderId === findFolderByName(SKILL_FOLDER)?.id) errors.push('use skill_index and skill_write to change skills');
    // Model notes are autoManaged (the prune pass uses that flag) but are NOT
    // rebuilt by the harness. Only a genuinely regenerated file is refused.
    else if (isHarnessRegeneratedTarget(input.targetFile)) errors.push('harness-regenerated files (profile memory, pattern memory, recurring mistakes, suggestions) cannot be amended — they are rebuilt by the harness');
    else if (input.proposedContent === input.targetFile.content) errors.push('proposed content is identical to the current content');
    return { ok: errors.length === 0, errors };
};

/**
 * Propose an amendment. Validates hard (no autoManaged targets, no
 * identical content) and stores as PENDING. Throws with the reason on
 * invalid input — callers surface it to the model as tool feedback.
 */
export const proposeAmendment = (
    fileId: string,
    kind: 'edit' | 'supersede',
    proposedContent: string,
    reason: string,
    proposedBy: string,
    getFileById: (id: string) => MemoryFile | null,
): MemoryAmendment => {
    const target = getFileById(fileId);
    const v = validateAmendment({ proposedContent, reason, targetFile: target });
    if (!v.ok) throw new Error(`Amendment rejected: ${v.errors.join('; ')}`);
    const items = load();
    const amendment: MemoryAmendment = {
        id: uid(),
        fileId,
        fileName: target!.name,
        kind,
        proposedContent: proposedContent.trim(),
        reason: reason.trim(),
        proposedBy,
        status: 'pending',
        createdAt: nowIso(),
    };
    save([amendment, ...items].slice(0, MAX_AMENDMENTS));
    try {
        window.dispatchEvent(new CustomEvent(AMENDMENT_EVENT, { detail: { id: amendment.id, fileName: amendment.fileName } }));
    } catch { /* non-DOM envs — ignore */ }
    return amendment;
};

export const listAmendments = (status?: MemoryAmendment['status']): MemoryAmendment[] => {
    const items = load();
    return status ? items.filter(a => a.status === status) : items;
};

/**
 * Apply an approved correction to the notebook, and say whether the bytes landed.
 *
 * This lives here, not in the inbox, because there are TWO callers — the
 * inbox's Approve button and the model's own direct write (`applyAmendmentNow`
 * below) — and the second one used to call the status-only helper, so a row was
 * marked approved while the note kept its old text (the 2026-10-27 audit M-4).
 * One applier, one answer.
 *
 * A missing target is a refusal, not a silent approval: the note a model wanted
 * to correct was deleted, so there is nothing to apply and the human must be told.
 */
export const applyAmendmentContent = async (
    a: MemoryAmendment,
    username: string,
): Promise<{ ok: boolean; error?: string }> => {
    const { getMemoryFiles, updateMemoryFileUnlocked, withNotebookWriteLock } = await import('./MemoryFilesService');
    // Read the note INSIDE the notebook queue: a read outside it can carry a
    // body that an attribution write replaced before this correction lands,
    // and the next append would silently clobber that write.
    return withNotebookWriteLock(async () => {
        const file = getMemoryFiles().files.find(f => f.id === a.fileId);
        if (!file) return { ok: false, error: 'The note this correction targeted no longer exists, so nothing was changed.' };
        if (file.folderId === findFolderByName(SKILL_FOLDER)?.id) return { ok: false, error: 'Use skill_index and skill_write to change skills.' };
        const next = a.kind === 'supersede'
            ? `${file.content}

## Correction (${nowIso()})

${a.proposedContent}`
            : a.proposedContent;
        try {
            await updateMemoryFileUnlocked(a.fileId, { content: next }, username);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });
};

/**
 * Apply a correction immediately — the direct-write path (owner ruling
 * 2026-10-29: no human approval gate on memory writes). The row is the activity
 * log: it records the before/after bytes so Undo can restore them.
 */
export const applyAmendmentNow = async (
    input: {
        fileId: string;
        kind: 'edit' | 'supersede';
        proposedContent: string;
        reason: string;
        proposedBy: string;
        sourceTurnId?: string;
    },
    resolveFile: (id: string) => MemoryFile | null,
    username: string,
): Promise<{ ok: boolean; amendment?: MemoryAmendment; error?: string }> => {
    const amendment = proposeAmendment(
        input.fileId,
        input.kind,
        input.proposedContent,
        input.reason,
        input.proposedBy,
        resolveFile,
    );
    amendment.sourceTurnId = input.sourceTurnId;
    const target = resolveFile(input.fileId);
    const previousContent = target?.content ?? '';
    const applied = await applyAmendmentContent(amendment, username);
    if (!applied.ok) {
        amendment.status = 'rejected';
        amendment.resolvedAt = nowIso();
        amendment.resolvedBy = 'model';
        save(load().map(a => a.id === amendment.id ? amendment : a));
        return { ok: false, amendment, error: applied.error };
    }
    amendment.status = 'approved';
    amendment.resolvedAt = nowIso();
    amendment.appliedAt = amendment.resolvedAt;
    amendment.resolvedBy = 'model';
    amendment.previousContent = previousContent;
    amendment.appliedContent = resolveFile(input.fileId)?.content ?? '';
    save(load().map(a => a.id === amendment.id ? amendment : a));
    return { ok: true, amendment };
};

/** Undo one applied correction. Refuses when the note changed after it landed —
 *  restoring a stale snapshot would silently erase the newer edit. */
export const undoAmendment = async (
    id: string,
    username: string,
): Promise<{ ok: boolean; error?: string }> => {
    const items = load();
    const a = items.find(x => x.id === id);
    if (!a || a.status !== 'approved' || typeof a.previousContent !== 'string') {
        return { ok: false, error: 'that correction is not undoable' };
    }
    const { getMemoryFiles, updateMemoryFileUnlocked, withNotebookWriteLock } = await import('./MemoryFilesService');
    return withNotebookWriteLock(async () => {
        const file = getMemoryFiles().files.find(f => f.id === a.fileId);
        if (!file) return { ok: false, error: 'the note no longer exists' };
        if (file.folderId === findFolderByName(SKILL_FOLDER)?.id) return { ok: false, error: 'use skill_index and skill_write to change skills' };
        if (a.appliedContent !== undefined && file.content !== a.appliedContent) {
            return { ok: false, error: 'the note changed after this correction, so undo was refused' };
        }
        try {
            await updateMemoryFileUnlocked(a.fileId, { content: a.previousContent as string }, username);
            a.status = 'undone';
            a.undoneAt = nowIso();
            save(load().map(x => x.id === a.id ? a : x));
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });
};

/** APPROVE: call only AFTER `applyAmendmentContent` reported ok. */
export const approveAmendment = (id: string): MemoryAmendment | undefined => {
    const items = load();
    const a = items.find(x => x.id === id);
    if (!a || a.status !== 'pending') return undefined;
    a.status = 'approved';
    a.resolvedAt = nowIso();
    a.resolvedBy = 'user';
    save(items);
    return a;
};

/** REJECT: tombstoned so repeat proposals of the same change are visible. */
export const rejectAmendment = (id: string): MemoryAmendment | undefined => {
    const items = load();
    const a = items.find(x => x.id === id);
    if (!a || a.status !== 'pending') return undefined;
    a.status = 'rejected';
    a.resolvedAt = nowIso();
    a.resolvedBy = 'user';
    save(items);
    return a;
};
