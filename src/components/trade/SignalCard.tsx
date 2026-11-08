/**
 * SignalCard — the desk's own call, rendered from the signal ledger.
 *
 * Data comes ONLY from `readSignals` (folded ledger rows) — never fabricated
 * here. A SignalRecord carries no probability/baseRate/sampleN field: the
 * Prob. row is OMITTED unless a future record adds one. The conviction on
 * the record (1–4, self-reported) is shown as conviction, never as a
 * probability.
 *
 * Shared by TradeChatPanel (dock) and AgentsView (Chat) so the two homes
 * render byte-identical signal cards.
 */

import React, { useMemo, useState } from 'react';
import type { SignalRow, SignalRecord } from '../../types/signal';
import { readSignals } from '../../services/signals/signalLedger';
import { summariseSignals } from '../../services/signals/signalResolver';
import { scoreSignals } from '../../services/signals/signalAccuracy';
import { plannedRiskReward } from '../../utils/riskReward';
import { convictionLabel, type Conviction } from '../../utils/convictionScale';
import { fmtPrice } from '../../utils/formatters';
import type { ToolAction } from '../../types/message';

/** Resolve the signal id an emit_signal ToolAction recorded. The action's
 *  label is `"<coin> <dir> · <rr>R"` — the id is NOT on the action; it is
 *  read from the tool RESULT text (`"id":"<sig-id>"`). Falls back to the
 *  ledger row matching coin+direction when the result text is absent. */
export const signalIdFromActions = (actions: readonly ToolAction[] | undefined, resultText?: string): string | null => {
    if (resultText) {
        const m = resultText.match(/"id"\s*:\s*"([^"]{6,})"/);
        if (m) return m[1];
    }
    if (!actions) return null;
    const emit = actions.find(a => a.tool === 'emit_signal' && a.ok);
    if (!emit) return null;
    // The label carries coin + direction — match the latest open ledger row.
    const label = emit.label ?? '';
    const m = label.match(/^(\S+)\s+(long|short)/i);
    if (!m) return null;
    const coin = m[1];
    const direction = m[2].toLowerCase();
    const rows = readSignals().filter(r => r.signal.coin === coin && r.signal.direction === direction);
    if (rows.length === 0) return null;
    return rows[rows.length - 1].signal.id;
};

/** Find a ledger row by id (for callers holding only the id). */
export const signalRowById = (id: string): SignalRow | undefined =>
    readSignals().find(r => r.signal.id === id);

const PERSONA_LABEL: Record<Conviction, string> = {
    1: 'Low',
    2: 'Core',
    3: 'High',
    4: 'Conviction',
};

const shortId = (id: string): string => id.length > 8 ? id.slice(0, 8) : id;

const ago = (at: number): string => {
    const ms = Date.now() - at;
    if (ms < 60_000) return 'now';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
};

const timeLeft = (expiresAt: number): string => {
    const left = expiresAt - Date.now();
    if (left <= 0) return 'expired';
    const h = Math.floor(left / 3_600_000);
    const min = Math.floor((left % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${min}m left` : `${min}m left`;
};

export interface SignalCardProps {
    signal: SignalRecord;
    row?: SignalRow;
    /** Show on chart — draw the Entry/SL/TP lines. */
    onShowOnChart?: (signal: SignalRecord) => void;
    /** Log plan — hand the levels to the journal. */
    onLogPlan?: (signal: SignalRecord) => void;
}

export const SignalCard: React.FC<SignalCardProps> = ({ signal, row, onShowOnChart, onLogPlan }) => {
    const [copied, setCopied] = useState(false);
    const rr = plannedRiskReward({ entry: signal.entry, stopLoss: signal.stop, takeProfits: [signal.target] });
    const dirLabel = signal.direction === 'long' ? 'LONG' : 'SHORT';
    const conviction = signal.conviction as Conviction | undefined;
    const convLabel = conviction && conviction >= 1 && conviction <= 4
        ? convictionLabel(conviction)
        : null;

    const copyText = useMemo(() => {
        const lines = [
            `${dirLabel} ${signal.coin}`,
            `Entry ${fmtPrice(signal.entry)} · Stop ${fmtPrice(signal.stop)} · Target ${fmtPrice(signal.target)}`,
            `R:R ${rr > 0 ? rr.toFixed(2) : '—'} · Expires ${new Date(signal.expiresAt).toISOString()}`,
            signal.thesis,
        ];
        return lines.filter(Boolean).join('\n');
    }, [signal, rr, dirLabel]);

    return (
        <div className="overflow-hidden rounded-card border border-hairline bg-white/[0.015]" data-testid="signal-card">
            <div className="flex items-center gap-2 px-3 pt-3">
                <span
                    className={`inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-ui-dense font-bold ${signal.direction === 'long' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}
                    data-testid="signal-direction"
                >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    {dirLabel}
                </span>
                <span className="text-ui-base font-semibold text-zinc-100">{signal.coin}</span>
                <span className="ml-auto flex items-center gap-2 text-ui-dense text-zinc-500">
                    <span className="font-mono tabular-nums" data-testid="signal-rr">R:R {rr > 0 ? rr.toFixed(2) : '—'}</span>
                    <span>{convLabel ? `${PERSONA_LABEL[conviction!] ?? convLabel}` : '—'}</span>
                </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 pt-2 text-ui-dense">
                <div className="flex items-baseline gap-1.5">
                    <dt className="text-zinc-500">Entry</dt>
                    <dd className="font-mono font-medium tabular-nums text-cyan-400" data-testid="signal-entry">{fmtPrice(signal.entry)}</dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <dt className="text-zinc-500">Stop</dt>
                    <dd className="font-mono font-medium tabular-nums text-rose-400" data-testid="signal-stop">{fmtPrice(signal.stop)}</dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <dt className="text-zinc-500">Target</dt>
                    <dd className="font-mono font-medium tabular-nums text-emerald-400" data-testid="signal-target">{fmtPrice(signal.target)}</dd>
                </div>
                {/* Prob. row: ONLY if the record carries probability/baseRate/sampleN.
                    SignalRecord has none of these — the row is omitted (never fabricated). */}
                {(signal as unknown as Record<string, unknown>).probability !== undefined && (
                    <div className="flex items-baseline gap-1.5" data-testid="signal-prob">
                        <dt className="text-zinc-500">Prob.</dt>
                        <dd className="font-mono tabular-nums text-zinc-300">{String((signal as unknown as Record<string, unknown>).probability)}</dd>
                    </div>
                )}
            </dl>

            <div className="px-3 pt-2 text-ui-dense leading-relaxed text-zinc-400" data-testid="signal-thesis">
                {signal.thesis}
            </div>

            <div className="px-3 pt-1 text-ui-xs text-zinc-500">
                <span className="mr-2">Trigger: shown on chart when armed</span>
                <span>Invalidation: stop {fmtPrice(signal.stop)}</span>
            </div>

            <div className="flex items-center gap-1.5 px-3 py-2.5">
                {onShowOnChart && (
                    <button
                        type="button"
                        onClick={() => onShowOnChart(signal)}
                        className="rounded-control px-2 py-1 text-ui-dense font-medium text-zinc-300 transition-colors hover:bg-white/[0.06]"
                    >
                        Show on chart
                    </button>
                )}
                {onLogPlan && (
                    <button
                        type="button"
                        onClick={() => onLogPlan(signal)}
                        className="rounded-control px-2 py-1 text-ui-dense font-medium text-zinc-300 transition-colors hover:bg-white/[0.06]"
                    >
                        Log plan
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => {
                        void navigator.clipboard?.writeText(copyText).catch(() => undefined);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1200);
                    }}
                    className="rounded-control px-2 py-1 text-ui-dense font-medium text-zinc-300 transition-colors hover:bg-white/[0.06]"
                >
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>

            <div className="border-t border-hairline px-3 py-1.5 font-mono text-ui-2xs text-zinc-600" data-testid="signal-meta">
                {shortId(signal.id)} · {ago(signal.emittedAt)} · {timeLeft(signal.expiresAt)} · {signal.coin} · {row?.status ?? 'open'}
            </div>
        </div>
    );
};

/** DeskScorecard — the ledger's hit-rate vs base-rate, as a quiet Disclosure.
 *  One place, shared by dock + Chat. Reads `summariseSignals(readSignals())`
 *  and `scoreSignals` — the receipt's math, never a display copy. */
export const DeskScorecard: React.FC<{ className?: string }> = ({ className }) => {
    const data = useMemo(() => {
        const rows = readSignals();
        if (rows.length === 0) return null;
        const summary = summariseSignals(rows);
        const scorecard = scoreSignals(rows);
        return { summary, scorecard, n: summary.won + summary.lost + summary.expired };
    }, []);
    if (!data) return null;
    const { summary, scorecard, n } = data;
    const hit = summary.hitRate !== null ? `${(summary.hitRate * 100).toFixed(0)}%` : '—';
    const base = summary.baseRate !== null ? `${(summary.baseRate * 100).toFixed(0)}%` : '—';
    return (
        <details className={className ?? ''} data-testid="desk-scorecard">
            <summary className="cursor-pointer px-3 py-1.5 text-ui-dense text-zinc-500" data-testid="desk-scorecard-summary">
                Scorecard · {hit} vs {base} base (n={n}{scorecard.thin ? ', thin' : ''})
            </summary>
            <div className="px-3 pb-2 text-ui-dense leading-relaxed text-zinc-400">
                <span className="font-mono tabular-nums">
                    {summary.won}W / {summary.lost}L / {summary.expired} expired
                    {scorecard.hitCi ? ` · 95% CI ${(scorecard.hitCi.low * 100).toFixed(0)}–${(scorecard.hitCi.high * 100).toFixed(0)}%` : ''}
                    {summary.expectancyR !== null ? ` · expectancy ${summary.expectancyR.toFixed(2)}R` : ''}
                    {scorecard.slugging !== null ? ` · slugging ${scorecard.slugging.toFixed(2)}×` : ''}
                </span>
                {scorecard.thin && (
                    <span className="text-amber-400"> — sample too small to read; not an edge.</span>
                )}
            </div>
        </details>
    );
};

export default React.memo(SignalCard);
