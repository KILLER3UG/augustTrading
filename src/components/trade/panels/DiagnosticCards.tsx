/**
 * DiagnosticCards — monochrome inline receipts for `/context` and `/doctor`.
 *
 * Strictly adheres to the monochrome doctrine (`check:palette = 0`): matte
 * zinc surfaces, 1px low-contrast hairlines, and semantic emerald/rose status
 * indicators only.
 */

import React from 'react';
import type { ContextDiagnosticSnapshot, DoctorDiagnosticSnapshot, DoctorStatus } from '../../../services/trade/diagnosticsCore';

const STATUS_BADGE: Record<DoctorStatus, string> = {
    PASS: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    WARN: 'border-hairline bg-white/[0.06] text-zinc-200',
    FAIL: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
};

export const ContextDiagnosticCard: React.FC<{ snapshot: ContextDiagnosticSnapshot }> = ({ snapshot }) => (
    <div
        className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
        data-testid="context-diagnostic-card"
    >
        <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 font-mono text-ui-xs font-bold uppercase tracking-wider text-zinc-200">
                /context
            </span>
            <span className="font-mono text-ui-dense tabular-nums text-zinc-100">
                {snapshot.totalTokens.toLocaleString()} / {snapshot.windowTokens.toLocaleString()} tok ({snapshot.pctUsed}%)
            </span>
            <span className="ml-auto font-mono text-ui-2xs text-zinc-500">
                {snapshot.windowSource} window · {snapshot.tokensUntilAutoCompact.toLocaleString()} tok to 90% auto-compact
            </span>
        </div>

        <div className="mt-2 space-y-1 rounded-control border border-hairline bg-white/[0.02] p-2">
            {snapshot.breakdown.map(row => (
                <div key={row.key} className="flex items-center justify-between gap-3 text-ui-dense">
                    <span className="truncate text-zinc-400">{row.label}</span>
                    <span className="shrink-0 font-mono tabular-nums text-zinc-200">
                        {row.tokens.toLocaleString()} ({row.pctOfWindow}%)
                    </span>
                </div>
            ))}
        </div>
    </div>
);

export const DoctorDiagnosticCard: React.FC<{ snapshot: DoctorDiagnosticSnapshot }> = ({ snapshot }) => (
    <div
        className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
        data-testid="doctor-diagnostic-card"
    >
        <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 font-mono text-ui-xs font-bold uppercase tracking-wider text-zinc-200">
                /doctor
            </span>
            <span className={`rounded-control border px-1.5 py-0.5 font-mono text-ui-2xs font-semibold uppercase tracking-wider ${STATUS_BADGE[snapshot.overall]}`}>
                {snapshot.overall}
            </span>
            <span className="ml-auto font-mono text-ui-2xs text-zinc-500">
                6 subsystems checked · 0 LLM tokens
            </span>
        </div>

        <div className="mt-2 space-y-1.5 rounded-control border border-hairline bg-white/[0.02] p-2">
            {snapshot.checks.map(check => (
                <div key={check.id} data-testid={`doctor-check-${check.id}`} className="flex items-start gap-2 text-ui-dense">
                    <span className={`mt-0.5 shrink-0 rounded-control border px-1 py-0.2 font-mono text-ui-2xs font-semibold uppercase ${STATUS_BADGE[check.status]}`}>
                        {check.status}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="font-medium text-zinc-200">{check.label}</div>
                        <div className="font-mono text-ui-2xs leading-relaxed text-zinc-400">{check.summary}</div>
                    </div>
                </div>
            ))}
        </div>
    </div>
);
