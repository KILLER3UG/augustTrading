/**
 * NotebookWriteFailurePanel — the Health tab's reader for the sticky memory
 * write failure.
 *
 * WHY THIS EXISTS. `MemoryFilesService` records a refused write (quota or
 * error) and rethrows, so no caller swallows it — but a record nobody reads is
 * the same invisible state the store was built to end: the app keeps serving
 * the in-memory notebook while nothing new reaches disk. The Health tab is
 * where a trader looks when something feels wrong, so the record is surfaced
 * here, beside the runtime telemetry, naming the scope, the kind, the bytes
 * and the streak.
 *
 * Read-only on purpose: this panel never writes to the failure store and never
 * clears it. A write that reaches disk clears its own scope in the service;
 * this panel only re-reads. It renders nothing while writes are reaching disk,
 * because a clean bill of health the trader did not ask for is just noise.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle } from '../shared/Icons';
import {
    getNotebookWriteFailure,
    SCOPE_LABEL,
    type NotebookWriteFailure,
} from '../../services/learning/MemoryFilesService';

/** The record's unit is UTF-16 bytes (`utils/memoryBudget.ts`), and the Health
 *  tab already speaks MB with two decimals (`describePressure`), so the tiers
 *  below stay in the same voice. */
const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** The store announces a SUCCESS — which is what clears a scope's failure —
 *  but not a failure, so a failure recorded while this tab is already open has
 *  no signal to wait for. Re-reading the sticky record on a short interval is
 *  the only way to catch it without a second store or a failure event in the
 *  service. The getter walks two keys, so the cost is nothing. */
const REFRESH_MS = 2000;

const NotebookWriteFailurePanel: React.FC = () => {
    const [failure, setFailure] = useState<NotebookWriteFailure | null>(
        () => getNotebookWriteFailure(),
    );

    useEffect(() => {
        const timer = setInterval(() => setFailure(getNotebookWriteFailure()), REFRESH_MS);
        return () => clearInterval(timer);
    }, []);

    if (!failure) return null;

    return (
        <div
            className="rounded-bubble border border-rose-500/20 bg-rose-950/30 p-3"
            data-testid="notebook-write-failure"
        >
            <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-ui-sm font-semibold text-rose-300">
                        Memory write failed — nothing new is reaching disk.
                    </p>
                    <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-0.5 text-ui-dense">
                        <dt className="text-zinc-500">Scope</dt>
                        <dd className="text-zinc-200">{SCOPE_LABEL[failure.scope]}</dd>
                        <dt className="text-zinc-500">Kind</dt>
                        <dd className="text-zinc-200">
                            {failure.kind === 'quota'
                                ? 'quota — the store refused the write for size'
                                : 'error — the write threw'}
                        </dd>
                        <dt className="text-zinc-500">Bytes</dt>
                        <dd className="tabular-nums text-zinc-200">{formatBytes(failure.bytes)}</dd>
                        <dt className="text-zinc-500">Streak</dt>
                        <dd className="tabular-nums text-zinc-200">
                            {failure.streak} {failure.streak === 1 ? 'write' : 'writes'} in a row
                        </dd>
                    </dl>
                    {failure.message && (
                        <p className="break-words text-ui-xs text-zinc-500">{failure.message}</p>
                    )}
                    <p className="text-ui-2xs text-zinc-600">
                        {new Date(failure.atMs).toLocaleString()}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default NotebookWriteFailurePanel;
