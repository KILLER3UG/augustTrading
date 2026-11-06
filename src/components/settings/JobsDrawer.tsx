import React from 'react';
import { Inbox, X } from '../shared/Icons';
import { EmptyState } from '../ui/EmptyState';

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
    if (!open) return null;
    return (
        <div id="activity-drawer" data-testid="activity-drawer" className="fixed inset-y-0 right-0 z-drawer flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950 shadow-2xl shadow-black/60 animate-fade-in">
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
                <p className="text-ui-dense font-bold uppercase tracking-widest text-zinc-400">Activity</p>
                <button type="button" onClick={onClose} className="rounded-control p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors" aria-label="Close activity">
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
    );
};

export default JobsDrawer;
