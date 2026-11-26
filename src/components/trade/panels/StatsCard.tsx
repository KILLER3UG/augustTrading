/**
 * StatsCard — the agent's stats-tool output rendered as a card (P-5).
 *
 * The snapshot IS the receipt: `statsCardFromReceipt` parsed the tool's own
 * JSON, and this component prints its fields verbatim — win rate next to the
 * Wilson interval, the sample size always visible, per-detector rows for the
 * attribution read, compact rows for the trade log. No number is recomputed
 * or re-derived here; a card that disagrees with its tool is impossible by
 * construction. The one-tap way to the full stats stays the Journal's stats
 * tab (this card is a viewer, not a dashboard).
 */

import React, { useState } from 'react';
import { formatSessionPlanContextSummary } from '../../../services/trade/sessionPlan';
import type { StatsCardSnapshot } from '../../../services/trade/statsCard';

interface RiskValues {
    open?: { count?: number; correlated?: boolean };
    drawdown?: { todayR?: number; weekR?: number; light?: string };
    kelly?: { available?: boolean; halfKellyPct?: number };
    correlated_heat?: {
        currentGrossBetaHeatPct?: number;
        currentNetBetaHeatPct?: number;
        currentAbsNetBetaHeatPct?: number;
        maxCorrelatedHeatPct?: number;
        blockCorrelatedHeat?: boolean;
    };
    simulated_excluded?: number;
}

const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') {
        // Rates arrive 0-100 (the tool rounds); CIs arrive 0-1 (the wilson
        // field is 0-1). Render each as the tool shipped it — no conversion.
        return String(v);
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

export const StatsCard: React.FC<{ snapshot: StatsCardSnapshot }> = ({ snapshot }) => {
    const { tool, payload } = snapshot;
    const [viewMode, setViewMode] = useState<'real' | 'simulated'>('real');
    const simulatedView = payload.simulatedView && typeof payload.simulatedView === 'object'
        ? (payload.simulatedView as Record<string, unknown>)
        : undefined;
    const activePayload: Record<string, unknown> = viewMode === 'simulated'
        ? (simulatedView ?? { sample: 0, returned: 0, wins: 0, losses: 0, records: [], rows: [], detectors: [], values: { open: { count: 0 }, drawdown: { todayR: 0, weekR: 0, light: 'clear' }, kelly: { available: false } } })
        : payload;
    const title = tool === 'get_setup_history_stats'
        ? 'Setup stats (journal)'
        : tool === 'playbook_attribution' ? 'Playbook attribution (journal)'
            : tool === 'risk_state' ? 'Risk state (journal)' : 'Trade log (journal)';
    const sample = typeof activePayload.sample === 'number' ? activePayload.sample
        : typeof activePayload.returned === 'number' ? activePayload.returned : null;
    const wilson = activePayload.wilson95 as { low?: number; high?: number } | undefined;
    const thin = typeof activePayload.thinSampleNote === 'string' ? activePayload.thinSampleNote : null;
    // The risk read is the one card with a live session-plan overlay. This is
    // context injection, not a second authority: the plan itself was confirmed
    // on its own card and only the trader can revert it.
    const risk = activePayload.values as RiskValues | null | undefined;
    const planSummary = tool === 'risk_state' ? formatSessionPlanContextSummary() : '';
    const simExcluded = typeof payload.simulatedExcluded === 'number'
        ? payload.simulatedExcluded
        : typeof risk?.simulated_excluded === 'number'
            ? risk.simulated_excluded
            : typeof (payload.coverage as { simulated_excluded?: number } | undefined)?.simulated_excluded === 'number'
                ? (payload.coverage as { simulated_excluded: number }).simulated_excluded
                : 0;

    return (
        <div className="mt-1 rounded-control border border-hairline bg-zinc-900/60 p-2.5"
            data-testid="stats-card">
            <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-control bg-white/[0.06] px-1.5 py-0.5 text-ui-xs font-bold text-zinc-200">
                    {title}
                </span>
                {sample !== null && (
                    <span className="font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                        n={sample}
                    </span>
                )}
                <span
                    data-testid="stats-card-simulated-status"
                    className="rounded-control border border-hairline bg-zinc-950/60 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400"
                >
                    {viewMode === 'simulated' ? 'Simulated only' : `Simulated excluded (${simExcluded})`}
                </span>
                <button
                    type="button"
                    data-testid="stats-card-simulated-toggle"
                    onClick={() => setViewMode(prev => (prev === 'real' ? 'simulated' : 'real'))}
                    className="rounded-control border border-line bg-zinc-800/80 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-200 transition-colors hover:bg-zinc-700"
                >
                    {viewMode === 'real' ? 'Real · switch to Simulated' : 'Simulated · switch to Real'}
                </button>
                <span className="ml-auto font-mono text-ui-2xs text-zinc-600">from the tool, verbatim</span>
            </div>

            {tool === 'get_setup_history_stats' && (
                <div className="mt-2 space-y-1 font-mono text-ui-dense tabular-nums text-zinc-300">
                    <p>
                        {fmt(activePayload.wins)}W / {fmt(activePayload.losses)}L
                        {typeof activePayload.winRate === 'number' && (
                            <> · win {fmt(activePayload.winRate)}%</>
                        )}
                        {wilson && wilson.low != null && wilson.high != null && (
                            <> · Wilson 95% [{fmt(wilson.low)}–{fmt(wilson.high)}]</>
                        )}
                    </p>
                    <p className="text-zinc-400">
                        avg R {fmt(activePayload.avgR)} · last {fmt(activePayload.lastOutcome)}
                        {activePayload.lastDate ? ` (${fmt(activePayload.lastDate)})` : ''}
                        {activePayload.worstLesson ? ` · worst lesson: ${fmt(activePayload.worstLesson)}` : ''}
                    </p>
                    {thin && <p className="text-zinc-300 text-ui-dense leading-relaxed">{thin}</p>}
                </div>
            )}

            {tool === 'playbook_attribution' && Array.isArray(activePayload.detectors ?? (activePayload.values as { playbooks?: unknown[] } | undefined)?.playbooks) && (
                <div className="mt-2 font-mono text-ui-dense tabular-nums">
                    {((activePayload.detectors ?? (activePayload.values as { playbooks?: unknown[] } | undefined)?.playbooks) as Array<Record<string, unknown>>).slice(0, 12).map((d, i) => (
                        <p key={i} className="text-zinc-300">
                            {fmt(d.id ?? d.playbook ?? d.detector)} · {fmt(d.wins)}W/{fmt(d.losses)}L
                            {typeof (d.winRate ?? d.win_rate) === 'number' ? ` · ${fmt(d.winRate ?? d.win_rate)}%` : ''}
                            {typeof d.sample === 'number' ? ` (n=${fmt(d.sample)})` : ''}
                        </p>
                    ))}
                </div>
            )}

            {tool === 'risk_state' && (
                <div data-testid="risk-state-card" className="mt-2 space-y-1 font-mono text-ui-dense tabular-nums text-zinc-300">
                    <p>
                        open plans {fmt(risk?.open?.count)}
                        {risk?.open?.correlated ? ' · correlated' : ''}
                    </p>
                    <p>
                        week R {fmt(risk?.drawdown?.weekR)} · day R {fmt(risk?.drawdown?.todayR)}
                        {' · drawdown light '}{fmt(risk?.drawdown?.light)}
                    </p>
                    <p>
                        {risk?.kelly?.available
                            ? `half-Kelly ceiling ${fmt(risk.kelly.halfKellyPct)}%`
                            : 'half-Kelly ceiling refused (thin sample)'}
                    </p>
                    {risk?.correlated_heat && (
                        <p className="text-zinc-400">
                            net BTC-beta heat {fmt(risk.correlated_heat.currentNetBetaHeatPct)}% / {fmt(risk.correlated_heat.maxCorrelatedHeatPct)}% cap
                            {' · gross '}{fmt(risk.correlated_heat.currentGrossBetaHeatPct)}%
                        </p>
                    )}
                    {planSummary && <p className="text-zinc-400">{planSummary}</p>}
                </div>
            )}

            {tool === 'get_trade_log' && Array.isArray(activePayload.records) && (
                <div className="mt-2 font-mono text-ui-dense tabular-nums">
                    {(activePayload.records as Array<Record<string, unknown>>).slice(0, 8).map((r, i) => (
                        <p key={i} className="text-zinc-300">
                            {fmt(r.loggedAt ?? r.timestamp)} · {fmt(r.symbol)} {fmt(r.direction)} {fmt(r.outcome)}
                            {r.simulated ? ' · [Simulated]' : ''}
                            {r.netR != null ? ` · ${fmt(r.netR)}R` : r.pnlAmount != null ? ` · $${fmt(r.pnlAmount)}` : ''}
                        </p>
                    ))}
                </div>
            )}

            {tool === 'get_trade_log' && !Array.isArray(activePayload.records) && Array.isArray(activePayload.rows) && (
                <div className="mt-2 font-mono text-ui-dense tabular-nums">
                    {typeof activePayload.tally === 'string' && (
                        <p className="text-zinc-400 mb-1">{activePayload.tally}</p>
                    )}
                    {(activePayload.rows as string[]).slice(0, 8).map((line, i) => (
                        <p key={i} className="text-zinc-300">{line}</p>
                    ))}
                </div>
            )}
        </div>
    );
};

export default StatsCard;
