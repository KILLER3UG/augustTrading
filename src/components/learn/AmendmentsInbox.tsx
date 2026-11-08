/**
 * AmendmentsInbox — the Learning → Approvals surface for model-proposed notebook
 * corrections. Approve applies the change through the notebook write lock
 * (provenance preserved); reject tombstones the proposal so repeat
 * suggestions of the same correction stay visible.
 */

import React from 'react';
import { Check, X } from '../shared/Icons';
import {
    MemoryAmendment,
    applyAmendmentContent,
    listAmendments,
    approveAmendment,
    rejectAmendment,
    undoAmendment,
} from '../../services/learning/memoryAmendments';
import { getActiveUsername } from '../../utils/activeUser';
import { phtStamp } from '../../utils/timezone';

const StatusBadge: React.FC<{ a: MemoryAmendment }> = ({ a }) => {
    const map: Record<MemoryAmendment['status'], string> = {
        pending: 'bg-amber-950/60 text-amber-400',
        approved: 'bg-emerald-950/60 text-emerald-400',
        rejected: 'bg-zinc-900 text-zinc-600 line-through',
        undone: 'bg-zinc-900 text-zinc-500',
    };
    return (
        <span className={`rounded-control px-1.5 py-0.5 text-ui-xs font-bold uppercase tracking-wider ${map[a.status]}`}>
            {a.status}
        </span>
    );
};

export const AmendmentsInbox: React.FC = () => {
    const [amendments, setAmendments] = React.useState<MemoryAmendment[]>([]);
    const [busyId, setBusyId] = React.useState<string | null>(null);
    const [saveError, setSaveError] = React.useState<string | null>(null);

    const refresh = React.useCallback(() => setAmendments(listAmendments()), []);
    React.useEffect(() => { refresh(); }, [refresh]);

    const resolve = async (a: MemoryAmendment, apply: boolean): Promise<void> => {
        setBusyId(a.id);
        setSaveError(null);
        try {
            if (apply) {
                // WRITE FIRST, MARK SECOND. This used to flip the queue row to
                // approved and only then apply the content, so a deleted target
                // was "approved" with nothing written, and a refused notebook
                // write left the row approved while the message said it was still
                // pending (the 2026-10-27 audit M-4). The applier lives in the service
                // because the model's own auto-apply needs the same one.
                const applied = await applyAmendmentContent(a, getActiveUsername());
                if (!applied.ok) {
                    setSaveError(applied.error ?? 'That correction could not be applied, so it is still pending.');
                    refresh();
                    return;
                }
                approveAmendment(a.id);
            } else {
                rejectAmendment(a.id);
            }
            refresh();
        } catch (e) {
            // The queue write is recorded and rethrown now, which is what makes
            // it visible at all — but "visible" to this component means the
            // trader is told, because the two failure modes land very
            // differently: a refused quota left the proposal PENDING and
            // retryable, while an error after approve() already burned the
            // in-memory status. Say which, rather than claiming it is safe.
            const quota = /quota|exceed|full/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
            setSaveError(quota
                ? 'Storage is full, so this was not saved. The proposal is still pending — free space or delete old backups, then try again.'
                : 'This could not be saved. The failure is recorded on the Memory health card; check it before assuming the change stuck.');
        } finally {
            setBusyId(null);
        }
    };

    const undo = async (a: MemoryAmendment): Promise<void> => {
        setBusyId(a.id);
        setSaveError(null);
        try {
            const r = await undoAmendment(a.id, getActiveUsername());
            if (!r.ok) setSaveError(r.error ?? 'That correction could not be undone.');
            refresh();
        } finally {
            setBusyId(null);
        }
    };

    const pending = amendments.filter(a => a.status === 'pending');
    const resolved = amendments.filter(a => a.status !== 'pending');

    return (
        <div className="space-y-2" data-testid="amendments-inbox">
            {saveError && (
                <p role="alert" data-testid="amendment-save-error"
                    className="rounded-control border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-ui-dense leading-snug text-rose-300">
                    {saveError}
                </p>
            )}
            {amendments.length === 0 && (
                <p className="rounded-control border border-hairline bg-zinc-900/50 px-3 py-4 text-center text-ui-sm text-zinc-600">
                    No amendment proposals. Models can propose corrections to your notebook via <code className="text-zinc-400">amend_memory</code>.
                </p>
            )}
            {pending.map(a => (
                <div key={a.id} className="rounded-bubble border border-amber-900/40 bg-zinc-900/40 p-3" data-testid={`amendment-${a.id}`}>
                    <div className="flex items-center gap-2">
                        <code className="text-ui-sm font-semibold text-zinc-200">{a.fileName}</code>
                        <span className="rounded-control bg-zinc-800 px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-wider text-zinc-400">{a.kind}</span>
                        <StatusBadge a={a} />
                        <span className="ml-auto shrink-0 text-ui-xs text-zinc-600">{a.proposedBy} · {phtStamp(a.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-ui-dense leading-snug text-zinc-400"><span className="text-zinc-600">Reason:</span> {a.reason}</p>
                    <pre className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-control bg-zinc-950/60 p-2 text-ui-xs leading-4 text-zinc-300 custom-scrollbar">{a.proposedContent}</pre>
                    <div className="mt-2 flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busyId === a.id}
                            onClick={() => { void resolve(a, true); }}
                            data-testid={`approve-amendment-${a.id}`}
                            className="flex items-center gap-1 rounded-control border border-hairline px-2 py-1 text-ui-dense font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                        >
                            <Check className="h-3 w-3" aria-hidden="true" /> {a.kind === 'supersede' ? 'Append correction' : 'Apply replacement'}
                        </button>
                        <button
                            type="button"
                            disabled={busyId === a.id}
                            onClick={() => { void resolve(a, false); }}
                            className="flex items-center gap-1 rounded-control px-2 py-1 text-ui-dense text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                        >
                            <X className="h-3 w-3" aria-hidden="true" /> Reject
                        </button>
                    </div>
                </div>
            ))}
            {resolved.length > 0 && (
                <details className="rounded-control border border-hairline bg-zinc-900/30 px-3 py-2">
                    <summary className="cursor-pointer text-ui-dense text-zinc-500">{resolved.length} resolved</summary>
                    <div className="mt-2 space-y-1.5">
                        {resolved.map(a => (
                            <div key={a.id} className="flex items-center gap-2 text-ui-dense text-zinc-500">
                                <StatusBadge a={a} />
                                <code className="text-zinc-400">{a.fileName}</code>
                                <span className="min-w-0 flex-1 truncate text-zinc-600" title={a.reason}>{a.reason}</span>
                                {a.status === 'approved' && typeof a.previousContent === 'string' && (
                                    <button type="button" disabled={busyId === a.id} onClick={() => { void undo(a); }}
                                        data-testid={`undo-amendment-${a.id}`}
                                        className="shrink-0 rounded-control border border-zinc-800 px-2 py-0.5 text-ui-2xs font-semibold text-zinc-300 hover:border-line hover:text-zinc-100 disabled:opacity-40">
                                        Undo
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
};

export default AmendmentsInbox;
