import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from '../shared/Icons';
import {
    approveHarnessRevision, dismissHarnessRevision, loadHarnessOptimizationState,
    revertHarnessRevision,
    HOLDOUT_MIN_FILLS,
    type HarnessOptimizationState,
} from '../../services/selfMod/harnessOptimization';
import { getSelfModMode } from '../../services/selfMod/SelfModificationService';

/**
 * Harness optimization card (Enhancement 3) — the trader's gate on the ONE
 * harness revision the loop proposes. The pass (deterministic, on the
 * heartbeat) stages a pending proposal when ≥2 recurring entry-knowable
 * failures of one kind appear in the ledger/journal; NOTHING changes until a
 * tap here. Approve routes through proposePromptChange (applied, ledgered,
 * revertible); the holdout then measures the approved revision against the
 * resolved signals that follow, and a regression flips the card to a revert
 * recommendation.
 *
 * Monochrome by convention: green/red are reserved for Long/Short, TP/SL and
 * Approve/Reject semantics — this card is a review surface, so zinc.
 */
export const HarnessOptimizationCard: React.FC<{ username: string }> = ({ username }) => {
    const [state, setState] = useState<HarnessOptimizationState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A decision that settles after unmount must not write a dead card's state.
    const aliveRef = useRef({ value: true });
    useEffect(() => {
        aliveRef.current.value = true;
        let alive = true;
        void loadHarnessOptimizationState(username).then(s => {
            if (alive) setState(s);
        });
        return () => {
            alive = false;
            aliveRef.current.value = false;
        };
    }, [username]);

    const act = useCallback((fn: () => Promise<{ ok: boolean; error?: string }>) => {
        setBusy(true);
        setError(null);
        void fn()
            .then(res => {
                if (!res.ok) setError(res.error ?? 'the change was refused');
                return loadHarnessOptimizationState(username);
            })
            .then(s => { if (aliveRef.current.value) setState(s); })
            .catch(e => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    }, [username]);

    if (!state?.proposal) return null;
    const p = state.proposal;
    const holdout = p.holdout;
    const pct = (v: number | null | undefined): string =>
        typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';

    return (
        <div className="rounded-bubble border border-hairline bg-zinc-900/60 p-4" data-testid="harness-optimization-card">
            <div className="flex items-baseline justify-between gap-2">
                <p className="text-ui-xs font-bold uppercase tracking-widest text-zinc-500">
                    Harness optimization · {p.kind}
                </p>
                <span className="rounded-full border border-hairline bg-zinc-900 px-2 py-0.5 text-ui-2xs text-zinc-400">
                    {p.status === 'pending' && 'Proposed — awaiting you'}
                    {p.status === 'approved' && 'Approved · monitoring'}
                    {p.status === 'revert-recommended' && 'Revert recommended'}
                </span>
            </div>
            <p className="mt-2 text-ui-base leading-relaxed text-zinc-200">{p.reason}</p>
            <div className="mt-2 rounded-control border border-hairline bg-zinc-950/60 p-2.5 font-mono text-ui-dense text-zinc-400">
                <span className="text-zinc-600">{p.promptId}</span>
                <span className="mx-1.5 text-zinc-700">→</span>
                <span className="text-zinc-300">+ {p.after.trimEnd().split('\n').slice(-1)[0]}</span>
            </div>
            {p.evidence.length > 0 && (
                <ul className="mt-2 space-y-1 text-ui-dense text-zinc-500">
                    {p.evidence.slice(0, 3).map(e => (
                        <li key={e.id} className="leading-relaxed">· {e.fact}</li>
                    ))}
                </ul>
            )}
            {p.status === 'pending' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        data-testid="harness-opt-approve"
                        disabled={busy}
                        onClick={() => act(() => approveHarnessRevision(username))}
                        className="rounded-control bg-zinc-100 px-3 py-1.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-zinc-300 disabled:opacity-50"
                    >
                        Approve & apply
                    </button>
                    <button
                        type="button"
                        data-testid="harness-opt-dismiss"
                        disabled={busy}
                        onClick={() => act(() => dismissHarnessRevision(username))}
                        className="rounded-control border border-hairline px-3 py-1.5 text-ui-dense text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                    >
                        Dismiss
                    </button>
                    {getSelfModMode() === 'off' && (
                        <span className="text-ui-2xs text-zinc-600">
                            self-modification is off — turn it on in Settings → Analysis to apply
                        </span>
                    )}
                </div>
            )}
            {p.status === 'approved' && holdout && (
                <p className="mt-3 text-ui-dense text-zinc-500 tabular-nums" data-testid="harness-opt-holdout">
                    Holdout: {holdout.fills} signals resolved
                    {holdout.fills < HOLDOUT_MIN_FILLS ? ` — verdict at ${HOLDOUT_MIN_FILLS}` : ''}
                    {' '}· baseline {pct(p.baseline.hitRate)} · holdout {pct(holdout.hitRate)}
                </p>
            )}
            {p.status === 'revert-recommended' && (
                <div className="mt-3">
                    <p className="text-ui-dense text-zinc-400">{p.revertReason}</p>
                    <button
                        type="button"
                        data-testid="harness-opt-revert"
                        disabled={busy}
                        onClick={() => act(() => revertHarnessRevision(username))}
                        className="mt-2 flex items-center gap-1.5 rounded-control border border-hairline px-3 py-1.5 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                    >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Revert to the previous prompt
                    </button>
                </div>
            )}
            {error && <p className="mt-2 text-ui-dense text-zinc-400">{error}</p>}
            <p className="mt-3 text-ui-2xs leading-relaxed text-zinc-600">
                The revision is one appended rule to {p.promptId}; the previous text is ledgered and
                revertible. History: {(state.history ?? []).length} decided.
            </p>
        </div>
    );
};
