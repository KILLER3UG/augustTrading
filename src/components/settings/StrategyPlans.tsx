/**
 * StrategyPlans — the activation surface for a named trade plan.
 *
 * A plan is proposed as a DRAFT and nothing in the app could ever promote it,
 * so `activeStrategiesBlock()` — the block injected into every seat's prompt —
 * returned '' forever. That made the read path dead code and the user-facing
 * receipt ("review it in Settings") a pointer to nothing. This is the missing
 * half: the trader's decision, in the tab where they already manage skills.
 *
 * It lives here rather than in a new Settings tab because a plan and a skill
 * are the same idea at two granularities — the skill says when, the plan says
 * how — and a trader comparing the two should see them side by side.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { listStrategies, setStrategyStatus, strategyFileName, type StrategyMeta } from '../../services/learning/strategyStore';
import { getActiveUsername } from '../../utils/activeUser';

const STATUS_LABEL: Record<StrategyMeta['status'], string> = {
    draft: 'Draft',
    active: 'Active',
    retired: 'Retired',
};

const Plan: React.FC<{ meta: StrategyMeta; onChanged: () => void }> = ({ meta, onChanged }) => {
    const [busy, setBusy] = useState(false);
    const act = useCallback(async (status: StrategyMeta['status']) => {
        setBusy(true);
        try {
            // The canonical file name, not a second copy of the slug rule.
            await setStrategyStatus(strategyFileName(meta.name).replace(/\.md$/i, ''), status, getActiveUsername());
            onChanged();
        } finally {
            setBusy(false);
        }
    }, [meta.name, onChanged]);

    const rows: Array<[string, string | undefined]> = [
        ['Entry', meta.entry],
        ['Invalidation', meta.invalidation],
        ['Stop', meta.stop],
        ['Target', meta.target],
        ['Size', meta.sizing],
    ];

    return (
        <div
            className="rounded-control border border-zinc-800 bg-zinc-900 p-3"
            data-testid={`strategy-plan-${meta.status}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-ui-dense font-semibold text-zinc-100" title={meta.name}>{meta.name}</span>
                        <span
                            className={`shrink-0 rounded-control px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-wider ${
                                meta.status === 'active'
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : meta.status === 'retired'
                                        ? 'bg-zinc-800 text-zinc-500'
                                        : 'bg-amber-500/15 text-amber-300'
                            }`}
                        >
                            {STATUS_LABEL[meta.status]}
                        </span>
                    </div>
                    {meta.description && (
                        <p className="mt-0.5 text-ui-dense text-zinc-500">{meta.description}</p>
                    )}
                </div>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(meta.status === 'active' ? 'retired' : 'active')}
                    className="shrink-0 rounded-control border border-hairline bg-zinc-800 px-2.5 py-1 text-ui-dense font-bold uppercase tracking-wider text-zinc-200 hover:border-line hover:bg-zinc-700 disabled:opacity-50"
                >
                    {meta.status === 'active' ? 'Retire' : 'Activate'}
                </button>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {rows.filter(([, v]) => !!v).map(([k, v]) => (
                    <React.Fragment key={k}>
                        <dt className="text-ui-2xs uppercase tracking-wider text-zinc-600">{k}</dt>
                        <dd className="truncate text-ui-dense text-zinc-300" title={v}>{v}</dd>
                    </React.Fragment>
                ))}
            </dl>
            {meta.conditions && meta.conditions.length > 0 && (
                <p className="mt-1.5 text-ui-dense text-zinc-500">
                    Requires: {meta.conditions.join('; ')}
                </p>
            )}
            {(typeof meta.wins === 'number' || typeof meta.losses === 'number') && (
                <p className="mt-1 text-ui-2xs text-zinc-600">
                    Record: {meta.wins ?? 0}W / {meta.losses ?? 0}L
                </p>
            )}
        </div>
    );
};

const StrategyPlans: React.FC = () => {
    const [plans, setPlans] = useState<StrategyMeta[]>([]);
    const [loaded, setLoaded] = useState(false);

    const refresh = useCallback(() => {
        try {
            setPlans(listStrategies());
        } catch {
            setPlans([]);
        }
        setLoaded(true);
    }, []);

    useEffect(refresh, [refresh]);

    if (!loaded) return null;
    if (plans.length === 0) {
        return (
            <p className="text-ui-dense text-zinc-500" data-testid="strategy-plans-empty">
                No trade plans yet. Ask the desk to propose one when a setup keeps repeating the same
                entry, stop and target.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {plans.map(p => (
                <Plan key={p.name} meta={p} onChanged={refresh} />
            ))}
        </div>
    );
};

export default StrategyPlans;