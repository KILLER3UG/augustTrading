/**
 * AutonomyDrawer — the ONE control surface for the desk's background
 * autonomy: a header pill that names the mode (AUTO / PAUSED) and opens a
 * compact popover carrying the mode toggle, the optional background-seat
 * override, the budget readout, and the reversible activity feed with
 * one-click Undo (services/trade/autonomyLedger).
 *
 * Monochrome zinc chrome throughout (semantic emerald only for the LIVE dot),
 * `check:palette` compliant. Nothing here nags: the drawer opens on click,
 * closes on Escape/outside, and the desk works identically with it closed.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useEscapeClose } from '../../../hooks/useEscapeClose';
import type { ProviderConfig } from '../../../types/provider';

import {
    canUndoAutonomyRecord,
    listAutonomyRecords,
    subscribeAutonomyLedger,
    undoAutonomyRecord,
    type AutonomyRecord,
} from '../../../services/trade/autonomyLedger';
import {
    getAutonomySnapshot,
    subscribeAutonomy,
    setAutonomyMode,
    setAutonomySeat,
    setAutonomyRoleSeat,
    MAX_BACKGROUND_CALLS_PER_HOUR,
} from '../../../services/trade/autonomySettings';

const timeAgo = (at: number): string => {
    const s = Math.max(1, Math.floor((Date.now() - at) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const SUBSYSTEM_TAG: Record<AutonomyRecord['subsystem'], string> = {
    memory: 'MEMORY',
    skill: 'SKILL',
    chart: 'CHART',
    watch: 'WATCH',
    sentinel: 'SENTINEL',
};

export const AutonomyDrawer: React.FC<{
    providers: ProviderConfig[];
    open: boolean;
    onClose: () => void;
}> = ({ providers, open, onClose }) => {
    const snap = useSyncExternalStore(subscribeAutonomy, getAutonomySnapshot, getAutonomySnapshot);
    const [records, setRecords] = useState<AutonomyRecord[]>([]);
    const [undoingId, setUndoingId] = useState<string | null>(null);
    const [user] = useState(() => {
        try { return localStorage.getItem('last_active_user') || 'default'; } catch { return 'default'; }
    });

    useEffect(() => {
        if (!open) return;
        let alive = true;
        const load = (): void => { void listAutonomyRecords(user).then(r => { if (alive) setRecords(r); }); };
        load();
        const off = subscribeAutonomyLedger(load);
        return () => { alive = false; off(); };
    }, [open, user]);

    useEscapeClose(open, onClose);

    if (!open) return null;
    const seatValue = snap.seat ?? '';

    return (
        <>
            <div className="fixed inset-0 z-shield" aria-hidden onClick={onClose} />
            <div
                data-testid="autonomy-drawer"
                role="dialog"
                aria-label="Autonomy activity"
                className="absolute right-0 top-9 z-shield w-80 overflow-hidden rounded-bubble border border-hairline bg-zinc-900 shadow-elevated"
            >
                <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
                    <span className="text-ui-dense font-medium text-zinc-200">Desk autonomy</span>
                    <button
                        type="button"
                        data-testid="autonomy-mode-toggle"
                        onClick={() => void setAutonomyMode(snap.mode === 'autonomous' ? 'paused' : 'autonomous')}
                        className="rounded-control border border-hairline px-2 py-0.5 text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06]"
                    >
                        {snap.mode === 'autonomous' ? 'Pause' : 'Resume'}
                    </button>
                </div>

                <div className="space-y-2 px-3 py-2 text-ui-dense text-zinc-400">
                    <label className="block">
                        <span className="mb-0.5 block text-ui-2xs text-zinc-600">Background seat</span>
                        <select
                            data-testid="autonomy-seat-select"
                            value={seatValue}
                            onChange={ev => void setAutonomySeat(ev.target.value || undefined)}
                            className="w-full rounded-control border border-hairline bg-zinc-950 px-2 py-1 text-ui-dense text-zinc-200 focus:outline-none"
                        >
                            <option value="">Active model (default)</option>
                            {providers.filter(p => p.isEnabled).flatMap(p => p.models.map(m => (
                                <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                                    {p.name} · {m}
                                </option>
                            )))}
                        </select>
                    </label>
                    <details className="rounded-control border border-hairline bg-zinc-950/60 px-2 py-1" data-testid="autonomy-role-seats">
                        <summary className="cursor-pointer select-none text-ui-2xs text-zinc-500">Per-role overrides</summary>
                        <div className="mt-1 space-y-1">
                            {(['adversary', 'sentinel', 'maintenance', 'compaction'] as const).map(role => (
                                <label key={role} className="flex items-center justify-between gap-2 text-ui-2xs text-zinc-500">
                                    <span className="shrink-0">{role}</span>
                                    <select
                                        data-testid={`autonomy-role-${role}`}
                                        value={snap.roleSeats[role] ?? ''}
                                        onChange={ev => void setAutonomyRoleSeat(role, ev.target.value || undefined)}
                                        className="min-w-0 flex-1 rounded-control border border-hairline bg-zinc-950 px-1 py-0.5 text-ui-2xs text-zinc-200 focus:outline-none"
                                    >
                                        <option value="">default</option>
                                        {providers.filter(p => p.isEnabled).flatMap(p => p.models.map(m => (
                                            <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>{p.name} · {m}</option>
                                        )))}
                                    </select>
                                </label>
                            ))}
                        </div>
                    </details>
                    <p className="text-ui-2xs text-zinc-500" data-testid="autonomy-budget-line">
                        {snap.callsLastHour}/{MAX_BACKGROUND_CALLS_PER_HOUR} background calls this hour
                        {snap.backoffUntil ? ` · backing off ${Math.ceil((snap.backoffUntil - Date.now()) / 1000)}s` : ''}
                    </p>
                </div>

                <div className="max-h-72 overflow-y-auto border-t border-hairline px-3 py-2 custom-scrollbar" data-testid="autonomy-feed">
                    <p className="mb-1.5 text-ui-2xs text-zinc-600">Activity · reversible</p>
                    {records.length === 0 && (
                        <p className="py-2 text-ui-dense text-zinc-600">Nothing yet — the desk runs quiet until a loop acts.</p>
                    )}
                    <ul className="space-y-1.5">
                        {records.slice(0, 14).map(r => (
                            <li key={r.id} className="rounded-control bg-zinc-950/60 px-2 py-1.5" data-testid="autonomy-record">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-ui-2xs text-zinc-500">
                                            <span className="font-mono">{SUBSYSTEM_TAG[r.subsystem]}</span>
                                            {' · '}{timeAgo(r.at)} ago{r.undoneAt ? ' · undone' : ''}
                                        </p>
                                        <p className={`text-ui-dense leading-4 ${r.undoneAt ? 'text-zinc-600 line-through' : 'text-zinc-300'}`}>{r.summary}</p>
                                    </div>
                                    {canUndoAutonomyRecord(r) && (
                                        <button
                                            type="button"
                                            data-testid={`autonomy-undo-${r.id}`}
                                            disabled={undoingId === r.id}
                                            onClick={() => {
                                                setUndoingId(r.id);
                                                void undoAutonomyRecord(r.id).finally(() => setUndoingId(null));
                                            }}
                                            className="shrink-0 rounded-control border border-hairline px-1.5 py-0.5 text-ui-2xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40"
                                        >
                                            Undo
                                        </button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </>
    );
};

/** The header pill: names the mode, opens the drawer. ONE control. */
export const AutonomyControl: React.FC<{ providers: ProviderConfig[] }> = ({ providers }) => {
    const snap = useSyncExternalStore(subscribeAutonomy, getAutonomySnapshot, getAutonomySnapshot);
    const [open, setOpen] = useState(false);
    const autonomous = snap.mode === 'autonomous';
    return (
        <div className="relative">
            <button
                type="button"
                data-testid="autonomy-control"
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
                title={autonomous ? 'Desk autonomy: on — click for activity & pause' : 'Desk autonomy: paused — click to resume'}
                className={`hit-target flex items-center gap-1 rounded-control px-1.5 py-1 text-ui-2xs font-mono transition-colors ${
                    autonomous ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-white/[0.06]'
                }`}
            >
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${autonomous ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                {autonomous ? 'AUTO' : 'PAUSED'}
            </button>
            <AutonomyDrawer providers={providers} open={open} onClose={() => setOpen(false)} />
        </div>
    );
};

export default AutonomyDrawer;
