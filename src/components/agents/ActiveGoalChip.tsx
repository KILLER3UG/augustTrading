/**
 * ActiveGoalChip — the one place the Chat header says which goal the seat is
 * working inside.
 *
 * The focused goal changes what the NEXT turn is offered (its tool policy is
 * intersected with the seat's at the transport), so a trader who cannot see it
 * is being shaped by a state they never chose. The chip names it and carries
 * the one control that matters: leaving it. Renders nothing when no goal is
 * focused — an empty chip slot for a desk that is not inside anything is the
 * noise this surface's header already refuses.
 *
 * The snapshot is a string, not an object: `useSyncExternalStore` compares by
 * identity, and `focusedGoal()` returns a fresh parse of the notebook every
 * time, so returning the record would re-render the header on any notebook
 * write anywhere in the app.
 */
import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { focusGoal, focusedGoal } from '../../services/goals/GoalService';
import { subscribeMemoryFilesChanged } from '../../services/learning/MemoryFilesService';
import { CloseIcon } from '../shared/Icons';

const snapshot = (): string => {
    const goal = focusedGoal();
    return goal ? `${goal.slug}\u0000${goal.title}` : '';
};

const ActiveGoalChip: React.FC = () => {
    const state = useSyncExternalStore(subscribeMemoryFilesChanged, snapshot, snapshot);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [slug, title] = state.split('\u0000');

    const leave = useCallback(async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await focusGoal(slug, false, { by: 'human', summary: 'left from the header chip' });
        } catch (err) {
            // The chip stays, because the state it names is still true. A press
            // that did not land has to say so rather than vanish.
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [slug]);

    if (!slug) return null;
    return (
        <span className="flex min-w-0 shrink-0 items-center gap-1" data-testid="active-goal-chip">
            <span
                className="min-w-0 max-w-[180px] truncate rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-ui-dense text-zinc-100"
                title={`Working inside "${title}" — its tool policy narrows this seat's tools from the next turn`}
                data-testid="active-goal-name"
            >
                {title}
            </span>
            <button
                type="button"
                onClick={() => void leave()}
                disabled={busy}
                aria-label={`Leave the goal ${title}`}
                data-testid="active-goal-leave"
                className="hit-target rounded-control p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40"
            >
                <CloseIcon className="h-3 w-3" aria-hidden="true" />
            </button>
            {error && (
                <span role="status" data-testid="active-goal-error" className="text-ui-2xs text-rose-300" title={error}>
                    it did not leave
                </span>
            )}
        </span>
    );
};

export default ActiveGoalChip;
