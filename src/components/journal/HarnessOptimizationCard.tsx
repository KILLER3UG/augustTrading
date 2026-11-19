import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from '../shared/Icons';
import {
    approveHarnessRevision, dismissHarnessRevision, loadHarnessOptimizationState,
    revertHarnessRevision, rollbackToParent, rankParents,
    HOLDOUT_MIN_FILLS,
    type HarnessOptimizationState,
} from '../../services/selfMod/harnessOptimization';
import { getSelfModMode } from '../../services/selfMod/SelfModificationService';

/**
 * Harness optimization card (Enhancement 3; Meta-RAM upgrade) — the trader's
 * gate on the ONE harness revision the loop proposes, and the one-tap
 * rollback to the ranked parent pool.
 *
 * The pass (deterministic, on the heartbeat) consolidates evidence in three
 * map-reduce steps — per-trade summaries, per-session diagnoses, cross-session
 * consolidation — and stages a pending proposal when ≥2 recurring failures of
 * one kind appear. NOTHING changes until a tap here. Approve routes through
 * proposePromptChange (applied, ledgered, revertible); the holdout measures
 * the approved revision against the resolved signals that follow, and a
 * regression flips the card to a revert recommendation. Every approved
 * revision enters the parent pool with its measured delta; the best-ranked
 * parent is one tap away whenever the trader wants it back.
 *
 * Monochrome by convention: green/red are reserved for Long/Short, TP/SL and
 * Approve/Reject semantics — this card is a review surface, so zinc. The
 * status badge is the one high-contrast element: a pending decision must not
 * be missed.
 */
export const HarnessOptimizationCard: React.FC<{ username: string }> = ({ username }) => {
    const [state, setState] = useState<HarnessOptimizationState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
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

    const act = useCallback((fn: () => Promise<{ ok: boolean; error?: string; restoredId?: string }>, okNote?: string) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        void fn()
            .then(res => {
                if (!res.ok) setError(res.error ?? 'the change was refused');
                else if (okNote) setNotice(okNote);
                return loadHarnessOptimizationState(username);
            })
            .then(s => { if (aliveRef.current.value) setState(s); })
            .catch(e => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    }, [username]);

    const pool = state?.parentPool ?? [];
    const ranked = rankParents(pool);
    const bestParent = ranked[0] ?? null;
    const p = state?.proposal;
    if (!p && pool.length === 0) return null;

    const holdout = p?.holdout;
    const pct = (v: number | null | undefined): string =>
        typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';
    const deltaLabel = (v: number | null): string =>
        v === null ? 'measuring' : `${v > 0 ? '+' : ''}${v}pp`;
    // Identical evidence facts (the same measured sentence on two rows) are
    // one bullet, not two — the count rides the symptom.
    const evidence = p
        ? [...new Map(p.evidence.map(e => [e.fact, e])).values()].slice(0, 3)
        : [];
    const addedLine = p ? p.after.trimEnd().split('\n').slice(-1)[0] : '';

    return (
        <div className="rounded-bubble border border-hairline bg-zinc-900/60 p-4" data-testid="harness-optimization-card">
            {p && (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-ui-xs font-bold uppercase tracking-widest text-zinc-400">
                            Harness optimization · {p.kind}
                        </p>
                        <span
                            data-testid="harness-opt-status"
                            className={`rounded-full px-2.5 py-0.5 text-ui-2xs font-semibold ${
                                p.status === 'pending'
                                    ? 'bg-zinc-100 text-zinc-950'
                                    : p.status === 'revert-recommended'
                                        ? 'border border-line bg-white/[0.06] text-zinc-100'
                                        : 'border border-hairline bg-zinc-900 text-zinc-300'
                            }`}
                        >
                            {p.status === 'pending' && 'Proposed — awaiting you'}
                            {p.status === 'approved' && 'Approved · monitoring'}
                            {p.status === 'revert-recommended' && 'Revert recommended'}
                        </span>
                    </div>

                    {/* The map-reduce diagnosis: the evidence's shape at a glance. */}
                    {p.diagnosis && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-ui-2xs text-zinc-400" data-testid="harness-opt-diagnosis">
                            <span className="rounded-control border border-hairline bg-white/[0.03] px-1.5 py-0.5">
                                {p.diagnosis.sessions} session{p.diagnosis.sessions === 1 ? '' : 's'}
                            </span>
                            <span className="rounded-control border border-hairline bg-white/[0.03] px-1.5 py-0.5">
                                {p.diagnosis.fills} fills · {p.diagnosis.won}W/{p.diagnosis.lost}L
                            </span>
                            {p.diagnosis.sessionSpread.length > 1 && (
                                <span className="rounded-control border border-hairline bg-white/[0.03] px-1.5 py-0.5">
                                    spread: {p.diagnosis.sessionSpread.join(' · ')}
                                </span>
                            )}
                        </div>
                    )}

                    <p className="mt-2.5 text-ui-base leading-relaxed text-zinc-200">{p.reason}</p>

                    <div className="mt-2.5 rounded-control border border-hairline bg-zinc-950/60 p-2.5 font-mono text-ui-dense text-zinc-400">
                        <span className="text-zinc-500">{p.promptId}</span>
                        <span className="mx-1.5 text-zinc-700">→</span>
                        <span className="text-zinc-300">+ {addedLine}</span>
                    </div>

                    {evidence.length > 0 && (
                        <ul className="mt-2.5 space-y-1.5 text-ui-dense text-zinc-500">
                            {evidence.map(e => (
                                <li key={e.id} className="leading-relaxed">· {e.fact}</li>
                            ))}
                        </ul>
                    )}

                    {p.status === 'pending' && (
                        <div className="mt-3.5 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                data-testid="harness-opt-approve"
                                disabled={busy}
                                onClick={() => act(() => approveHarnessRevision(username))}
                                className="rounded-control bg-zinc-100 px-3.5 py-1.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-50"
                            >
                                Approve & apply
                            </button>
                            <button
                                type="button"
                                data-testid="harness-opt-dismiss"
                                disabled={busy}
                                onClick={() => act(() => dismissHarnessRevision(username))}
                                className="rounded-control border border-hairline px-3.5 py-1.5 text-ui-dense text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                            >
                                Dismiss
                            </button>
                            {getSelfModMode() === 'off' && (
                                <span className="text-ui-2xs text-zinc-500">
                                    self-modification is off — turn it on in Settings → Analysis to apply
                                </span>
                            )}
                        </div>
                    )}

                    {p.status === 'approved' && holdout && (
                        <p className="mt-3 text-ui-dense text-zinc-400 tabular-nums" data-testid="harness-opt-holdout">
                            Holdout: {holdout.fills} signals resolved
                            {holdout.fills < HOLDOUT_MIN_FILLS ? ` — verdict at ${HOLDOUT_MIN_FILLS}` : ''}
                            {' '}· baseline {pct(p.baseline.hitRate)} · holdout {pct(holdout.hitRate)}
                        </p>
                    )}

                    {p.status === 'revert-recommended' && (
                        <div className="mt-3 rounded-control border border-line bg-white/[0.03] p-2.5">
                            <p className="text-ui-dense leading-relaxed text-zinc-300">{p.revertReason}</p>
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
                </>
            )}

            {/* The ranked parent pool — measured harnesses the trader can
                return to in one tap. Renders even between proposals. */}
            {pool.length > 0 && (
                <div className={p ? 'mt-4 border-t border-hairline pt-3' : ''} data-testid="harness-opt-parent-pool">
                    <p className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500">
                        Parent pool · ranked by measured holdout delta
                    </p>
                    <ul className="mt-2 space-y-1">
                        {ranked.slice(0, 3).map((parent, i) => (
                            <li key={parent.id} className="flex items-center gap-2 font-mono text-ui-2xs text-zinc-400">
                                <span className="w-4 shrink-0 text-zinc-600">{i + 1}.</span>
                                <span className="truncate">{parent.kind}</span>
                                <span className="ml-auto shrink-0 rounded-control border border-hairline bg-white/[0.03] px-1.5 py-0.5 text-zinc-300 tabular-nums">
                                    {deltaLabel(parent.deltaPp)}
                                </span>
                                <span className="shrink-0 text-zinc-600">{parent.approvedAt.slice(0, 10)}</span>
                            </li>
                        ))}
                    </ul>
                    {bestParent && (
                        <button
                            type="button"
                            data-testid="harness-opt-rollback"
                            disabled={busy}
                            onClick={() => act(() => rollbackToParent(username), `Rolled back to the ${bestParent.kind} parent (${deltaLabel(bestParent.deltaPp)}).`)}
                            className="mt-2.5 flex items-center gap-1.5 rounded-control border border-hairline px-3 py-1.5 text-ui-dense text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                        >
                            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Roll back to best parent · {bestParent.kind} ({deltaLabel(bestParent.deltaPp)})
                        </button>
                    )}
                    {pool.some(x => x.deltaPp === null) && (
                        <p className="mt-1.5 text-ui-2xs text-zinc-600">
                            {pool.filter(x => x.deltaPp === null).length} revision{pool.filter(x => x.deltaPp === null).length === 1 ? '' : 's'} still measuring — a parent earns its rank at {HOLDOUT_MIN_FILLS} holdout fills.
                        </p>
                    )}
                </div>
            )}

            {notice && <p className="mt-2.5 text-ui-dense text-zinc-300" data-testid="harness-opt-notice">{notice}</p>}
            {error && <p className="mt-2.5 text-ui-dense text-zinc-400" data-testid="harness-opt-error">{error}</p>}
            <p className="mt-3 text-ui-2xs leading-relaxed text-zinc-600">
                {p
                    ? `The revision is one appended rule to ${p.promptId}; the previous text is ledgered and revertible. History: ${(state?.history ?? []).length} decided.`
                    : 'Every approved revision is ledgered with its previous text; the pool ranks them by measured holdout delta.'}
            </p>
        </div>
    );
};