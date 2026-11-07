/**
 * DeclinePanel — the Health tab's reader for the HOLD record.
 *
 * WHY THIS EXISTS. `decline_trade` writes one bounded row per declined setup
 * (`services/trade/declineLog.ts`) so "are we skipping winners?" has an
 * object to answer against — but until this panel, `listDeclines` had no
 * caller outside that module and the key was only carried in backup/export.
 * The store is write-only, which is the same invisible state it was built to
 * end: the skip exists, and nobody can see it.
 *
 * Read-only on purpose: this panel never writes, never clears and never
 * re-reasons a decline. It re-reads `listDeclines`, the ONE store, so the
 * record's semantics stay in the one file that owns them.
 *
 * It renders nothing while there is no decline to show, because a clean bill
 * of health the trader did not ask for is just noise — and it renders an
 * explicit error panel when the store cannot be read, because "unreadable"
 * shown as "nothing was ever declined" is the silent state this panel exists
 * to end. The two are never the same screen.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Ban, History } from '../shared/Icons';
import {
    tryListDeclines,
    MAX_DECLINES,
    type DeclineReadResult,
    type DeclineRecord,
} from '../../services/trade/declineLog';

/** The getter reads one small localStorage key, so the cost of re-reading it
 *  on a short interval is nothing — and `decline_trade` has no event to wait
 *  for, so polling is the only way a desk turn's HOLD appears while this tab
 *  is already open without adding a second store. */
const REFRESH_MS = 2000;

/** The store is newest-first (`recordDecline` prepends), and the Health tab is
 *  a glance, not an audit: the ten most recent skips are what a trader means
 *  by "what did we skip?". The full bounded set stays reachable through
 *  backup/export, which is its one other home. */
const VISIBLE_DECLINES = 10;

const DIRECTION_LABEL: Record<DeclineRecord['direction'], string> = {
    Long: 'long',
    Short: 'short',
    Neutral: 'neutral',
};

const formatTime = (iso: string): string => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
};

const DeclineRow: React.FC<{ record: DeclineRecord }> = ({ record }) => (
    <li className="flex items-start gap-2">
        <span className="w-14 shrink-0 font-mono text-ui-sm font-semibold text-amber-300/90">
            {record.symbol}
        </span>
        <span className="min-w-0 flex-1">
            <span className="block break-words text-ui-dense text-zinc-300">{record.reason}</span>
            <span className="mt-0.5 block text-ui-2xs text-zinc-500">
                {DIRECTION_LABEL[record.direction]}
                {record.entry !== undefined ? ` · entry ${record.entry}` : ''}
                {record.stopLoss !== undefined ? ` · stop ${record.stopLoss}` : ''}
                {record.source === 'automation' ? ' · automation (historical)' : ''}
                {' · '}
                {formatTime(record.createdAt)}
            </span>
        </span>
    </li>
);

const DeclinePanel: React.FC = () => {
    const [read, setRead] = useState<DeclineReadResult>(() => tryListDeclines());

    useEffect(() => {
        const timer = setInterval(() => setRead(tryListDeclines()), REFRESH_MS);
        return () => clearInterval(timer);
    }, []);

    // A failed read is NOT an empty history, and must never render as one.
    if (read.error) {
        return (
            <div
                className="rounded-bubble border border-rose-500/20 bg-rose-950/30 p-3"
                data-testid="decline-panel-error"
                role="alert"
            >
                <div className="flex items-start gap-2">
                    <AlertTriangle
                        className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
                        aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-ui-sm font-semibold text-rose-300">
                            Could not read the decline history
                        </p>
                        <p className="text-ui-2xs text-zinc-500">
                            The HOLD record could not be read, so nothing is shown here — this is
                            not an empty history. {read.error}.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const declines = read.rows;
    if (declines.length === 0) return null;

    return (
        <div
            className="rounded-bubble border border-zinc-800 bg-zinc-900 p-3"
            data-testid="decline-panel"
        >
            <div className="flex items-start gap-2">
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="text-ui-sm font-semibold text-zinc-100">
                        Declined setups
                        <span className="ml-2 font-normal text-zinc-500">
                            {declines.length} of {MAX_DECLINES} kept
                        </span>
                    </p>
                    <p className="mt-1 text-ui-2xs text-zinc-500">
                        Setups the desk chose not to present. Recorded with the reason and the
                        rejected levels; not journal rows, and no outcome is tracked.
                    </p>
                    <ul className="mt-2 space-y-1.5">
                        {declines.slice(0, VISIBLE_DECLINES).map(record => (
                            <DeclineRow key={record.id} record={record} />
                        ))}
                    </ul>
                    {declines.length > VISIBLE_DECLINES && (
                        <p className="mt-2 flex items-center gap-1.5 text-ui-2xs text-zinc-500">
                            <History className="h-3 w-3" aria-hidden="true" />
                            {declines.length - VISIBLE_DECLINES} older declines — in backup/export
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DeclinePanel;
