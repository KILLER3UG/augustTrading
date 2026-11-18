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

import React from 'react';
import { formatSessionPlanContextSummary } from '../../../services/trade/sessionPlan';
import type { StatsCardSnapshot } from '../../../services/trade/statsCard';

interface RiskValues {
    open?: { count?: number; correlated?: boolean };
    drawdown?: { todayR?: number; weekR?: number; light?: string };
    kelly?: { available?: boolean; halfKellyPct?: number };
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
    const title = tool === 'get_setup_history_stats'
        ? 'Setup stats (journal)'
        : tool === 'playbook_attribution' ? 'Playbook attribution (journal)'
            : tool === 'risk_state' ? 'Risk state (journal)' : 'Trade log (journal)';
    const sample = typeof payload.sample === 'number' ? payload.sample
        : typeof payload.returned === 'number' ? payload.returned : null;
    const wilson = payload.wilson95 as { low?: number; high?: number } | undefined;
    const thin = typeof payload.thinSampleNote === 'string' ? payload.thinSampleNote : null;
    // The risk read is the one card with a live session-plan overlay. This is
    // context injection, not a second authority: the plan itself was confirmed
    // on its own card and only the trader can revert it.
    const risk = payload.values as RiskValues | null | undefined;
    const planSummary = tool === 'risk_state' ? formatSessionPlanContextSummary() : '';

    return (
        <div className="mt-1 rounded-control border border-hairline bg-white/[0.02] p-2.5"
            data-testid="stats-card">
            <div className="flex items-center gap-2">
                <span className="rounded-control bg-zinc-500/15 px-1.5 py-0.5 text-ui-xs font-bold text-zinc-300">
                    {title}
                </span>
                {sample !== null && (
                    <span className="font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                        n={sample}
                    </span>
                )}
                <span className="ml-auto font-mono text-ui-2xs text-zinc-600">from the tool, verbatim</span>
            </div>

            {tool === 'get_setup_history_stats' && (
                <div className="mt-2 space-y-1 font-mono text-ui-dense tabular-nums text-zinc-300">
                    <p>
                        {fmt(payload.wins)}W / {fmt(payload.losses)}L
                        {typeof payload.winRate === 'number' && (
                            <> · win {fmt(payload.winRate)}%</>
                        )}
                        {wilson && wilson.low != null && wilson.high != null && (
                            <> · Wilson 95% [{fmt(wilson.low)}–{fmt(wilson.high)}]</>
                        )}
                    </p>
                    <p className="text-zinc-400">
                        avg R {fmt(payload.avgR)} · last {fmt(payload.lastOutcome)}
                        {payload.lastDate ? ` (${fmt(payload.lastDate)})` : ''}
                        {payload.worstLesson ? ` · worst lesson: ${fmt(payload.worstLesson)}` : ''}
                    </p>
                    {thin && <p className="text-amber-400/90 text-ui-dense leading-relaxed">{thin}</p>}
                </div>
            )}

            {tool === 'playbook_attribution' && Array.isArray(payload.detectors) && (
                <div className="mt-2 font-mono text-ui-dense tabular-nums">
                    {(payload.detectors as Array<Record<string, unknown>>).slice(0, 12).map((d, i) => (
                        <p key={i} className="text-zinc-300">
                            {fmt(d.id ?? d.playbook ?? d.detector)} · {fmt(d.wins)}W/{fmt(d.losses)}L
                            {typeof d.winRate === 'number' ? ` · ${fmt(d.winRate)}%` : ''}
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
                    {planSummary && <p className="text-zinc-400">{planSummary}</p>}
                </div>
            )}

            {tool === 'get_trade_log' && Array.isArray(payload.records) && (
                <div className="mt-2 font-mono text-ui-dense tabular-nums">
                    {(payload.records as Array<Record<string, unknown>>).slice(0, 8).map((r, i) => (
                        <p key={i} className="text-zinc-300">
                            {fmt(r.loggedAt ?? r.timestamp)} · {fmt(r.symbol)} {fmt(r.direction)} {fmt(r.outcome)}
                            {r.netR != null ? ` · ${fmt(r.netR)}R` : r.pnlAmount != null ? ` · $${fmt(r.pnlAmount)}` : ''}
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
};

export default StatsCard;
