import React from 'react';
import { Inbox, X } from '../shared/Icons';
import { EmptyState } from '../ui/EmptyState';
import { useEscapeClose } from '../../hooks/useEscapeClose';

/**
 * Activity drawer. It used to list each skill's latest detached-eval verdict;
 * the ledger that produced those verdicts is gone, so the drawer now states
 * the truth instead of an empty list.
 */

interface ActivityDrawerProps {
    open: boolean;
    onClose: () => void;
}

const JobsDrawer: React.FC<ActivityDrawerProps> = ({ open, onClose }) => {
    useEscapeClose(open, onClose);
    if (!open) return null;
    return (
        <>
            <div
                aria-hidden="true"
                onClick={onClose}
                className="motion-backdrop-in fixed inset-0 z-modal bg-black/50"
            />
            <div id="activity-drawer" data-testid="activity-drawer" className="motion-drawer-right fixed inset-y-0 right-0 z-modal flex w-full max-w-sm flex-col border-l border-white/[0.06] bg-zinc-950 shadow-elevated">
                <div className="flex shrink-0 items-center justify-between border-b border-white/[0.05] px-4 py-3">
                    <p className="text-ui-dense font-bold uppercase tracking-widest text-zinc-400">Activity</p>
                    <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close activity">
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
                    <EmptyState
                        compact
                        icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
                        title="Nothing running"
                        description="Detached skill evaluations were retired with the skill ledger. The library now keeps documents, not scores."
                    />
                </div>
            </div>
        </>
    );
};

export default JobsDrawer;
