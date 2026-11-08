/**
 * SignalFeed — the desk's own calls, settled against the tape.
 *
 * A LEDGER, not a deck of cards: one row per call, hairline separators, and
 * the numbers that grade it on the row itself. A row expands to the thesis,
 * the evidence it cited, the shadow checks and the tracker's state — never the
 * other way round, so the summary stays scannable without hiding the audit.
 *
 * What the feed may claim is bounded on purpose: an open call says when it
 * expires, a resolved one shows outcome R after the named costs, and every
 * shadow measurement (the programmatic gate, the evidence check) is labelled
 * SHADOW because it never blocked the emission.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SignalRow, SignalStatus, SignalSummary } from '../../types/signal';
import type { TrackedPosition } from '../../types/tracking';
import { foldRefusals, readSignalEvents, readSignals, type SignalRefusalRow } from '../../services/signals/signalLedger';
import { readTrackedPositions } from '../../services/tracking/positionStore';
import { settleDueSignals, settleRefusedSignals } from '../../services/signals/signalService';
import { summariseSignals, SIGNAL_SLIPPAGE_RATE, SIGNAL_TAKER_FEE_RATE } from '../../services/signals/signalResolver';
import { MIN_ACCURACY_FILLS, scoreSignals } from '../../services/signals/signalAccuracy';
import { getActiveUsername } from '../../utils/activeUser';
import { phtStamp } from '../../utils/timezone';
import { excursionR, signedR, trackedPrice, TRACKED_STATUS_WORD } from '../../utils/trackingLabels';
import { ChevronDownIcon, RefreshIcon } from '../shared/Icons';

interface SignalFeedProps {
    user?: string;
}

const STATUS_WORD: Record<SignalStatus, string> = {
    open: 'open',
    won: 'won',
    lost: 'lost',
    expired: 'expired',
    never_triggered: 'no entry',
};

const statusClass = (status: SignalStatus): string =>
    status === 'won' ? 'text-emerald-400'
        : status === 'lost' ? 'text-rose-400'
            : status === 'expired' ? 'text-amber-300'
                : status === 'never_triggered' ? 'text-zinc-500'
                    : 'text-cyan-300';

const pct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

const venueLabel = (row: SignalRow): string => {
    const resolution = row.resolution;
    if (!resolution) return 'not settled';
    if (resolution.crossCheck === 'agree') return 'cross-checked OKX/Binance';
    if (resolution.crossCheck === 'disagree') return 'exchange mismatch';
    return resolution.primarySource === 'binance' ? 'Binance fallback · no cross-check' : 'no cross-check';
};

const trackedShort = (position: TrackedPosition): string => {
    if (position.status === 'closed' && position.exit?.netR !== null && position.exit?.netR !== undefined) {
        return `tracked · ${signedR(position.exit.netR)} net`;
    }
    return `tracked · ${TRACKED_STATUS_WORD[position.status]}`;
};

const Stat: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
    <div className="min-w-0">
        <div className="mb-1 text-ui-2xs uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="truncate text-ui-sm font-semibold text-zinc-100" title={value}>{value}</div>
        {sub && <div className="truncate text-ui-2xs text-zinc-500" title={sub}>{sub}</div>}
    </div>
);

const ShadowLine: React.FC<{ summary: SignalSummary }> = ({ summary }) => {
    const refused = summary.shadowRefusedR;
    const passed = summary.shadowPassedR;
    if (refused === null && passed === null) return null;
    return (
        <Stat
            label="Gate shadow"
            value={`${refused === null ? 'no refusals' : `refused ${signedR(refused)}`} · ${passed === null ? 'no passes' : `passed ${signedR(passed)}`}`}
            sub="mean outcome R of resolved calls on each side — the gate never blocked"
        />
    );
};

const DetailKV: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="min-w-0">
        <div className="text-ui-2xs uppercase tracking-wider text-zinc-600">{label}</div>
        <div className="mt-0.5 truncate font-mono text-ui-dense tabular-nums text-zinc-300" title={value}>{value}</div>
    </div>
);

const SignalTableRow: React.FC<{ row: SignalRow; tracked?: TrackedPosition }> = ({ row, tracked }) => {
    const [open, setOpen] = useState(false);
    const s = row.signal;
    const risk = Math.abs(s.entry - s.stop);
    const rr = risk > 0 ? Math.abs(s.target - s.entry) / risk : 0;
    const resolution = row.resolution;
    const gate = row.gate;
    const grounding = row.grounding;
    const detailId = `signal-detail-${s.id}`;

    return (
        <>
            <tr
                className="border-b border-hairline align-top transition-colors hover:bg-white/[0.02]"
                data-testid="signal-card"
                data-signal-id={s.id}
                data-status={row.status}
            >
                <td className="py-3 pr-4">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-ui-sm font-semibold text-zinc-100">{s.coin}</span>
                        <span className={`text-ui-2xs font-bold uppercase tracking-wider ${s.direction === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {s.direction}
                        </span>
                        {tracked && <span className="text-ui-2xs text-zinc-500">tracked</span>}
                    </div>
                    <p className="mt-0.5 max-w-[26rem] truncate text-ui-2xs text-zinc-500" title={s.thesis}>{s.thesis}</p>
                </td>
                <td className="py-3 px-3">
                    <span className={`text-ui-2xs font-bold uppercase tracking-wider ${statusClass(row.status)}`}>
                        {STATUS_WORD[row.status]}
                    </span>
                    {resolution?.ambiguous && (
                        <span className="mt-0.5 block text-ui-2xs text-amber-300/80">ambiguous</span>
                    )}
                    {tracked && (
                        <span className="mt-0.5 block text-ui-2xs text-zinc-600">{trackedShort(tracked)}</span>
                    )}
                </td>
                <td className="py-3 px-3 text-right font-mono text-ui-dense tabular-nums text-zinc-300">{trackedPrice(s.entry)}</td>
                <td className="py-3 px-3 text-right font-mono text-ui-dense tabular-nums text-zinc-300">{trackedPrice(s.stop)}</td>
                <td className="py-3 px-3 text-right font-mono text-ui-dense tabular-nums text-zinc-300">{trackedPrice(s.target)}</td>
                <td className="py-3 px-3 text-right">
                    {resolution && row.status !== 'never_triggered' ? (
                        <>
                            <span className={`font-mono text-ui-dense font-semibold tabular-nums ${resolution.outcomeR >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {signedR(resolution.outcomeR)}
                            </span>
                            <span className="mt-0.5 block text-ui-2xs text-zinc-500">{venueLabel(row)}</span>
                        </>
                    ) : (
                        <>
                            <span className="font-mono text-ui-dense text-zinc-600">—</span>
                            <span className="mt-0.5 block text-ui-2xs text-zinc-600">
                                {row.status === 'never_triggered' ? 'no fill' : 'not settled'}
                            </span>
                        </>
                    )}
                </td>
                <td className="py-3 px-3">
                    {resolution?.base ? (
                        <>
                            <span className="font-mono text-ui-dense tabular-nums text-zinc-300">{pct(resolution.base.hitRate)}</span>
                            <span className="mt-0.5 block text-ui-2xs text-zinc-600">N={resolution.base.samples}</span>
                        </>
                    ) : <span className="text-ui-dense text-zinc-600">—</span>}
                </td>
                <td className="py-3 pl-3">
                    <span className="block font-mono text-ui-2xs tabular-nums text-zinc-500">{phtStamp(s.emittedAt)}</span>
                    {row.status === 'open' && (
                        <span className="mt-0.5 block text-ui-2xs text-zinc-600">expires {phtStamp(s.expiresAt)}</span>
                    )}
                </td>
                <td className="py-3 pl-2 text-right">
                    <button
                        type="button"
                        data-testid={`signal-expand-${s.id}`}
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={`${open ? 'Hide' : 'Show'} details for ${s.coin} ${s.direction}`}
                        onClick={() => setOpen(v => !v)}
                        className="rounded-control p-1 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                </td>
            </tr>
            {open && (
                <tr className="border-b border-hairline" id={detailId} data-testid={detailId}>
                    <td colSpan={9} className="bg-white/[0.015] px-4 py-5">
                        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                            <div className="min-w-0 space-y-4">
                                <div>
                                    <p className="text-ui-2xs uppercase tracking-[0.12em] text-zinc-500">Thesis</p>
                                    <p className="mt-1 text-ui-dense leading-relaxed text-zinc-300">{s.thesis}</p>
                                </div>
                                <div>
                                    <p className="text-ui-2xs uppercase tracking-[0.12em] text-zinc-500">Evidence</p>
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                        {s.evidenceRefs.length > 0 ? s.evidenceRefs.map((ref, i) => (
                                            <span key={`${ref}-${i}`} className="rounded-control border border-hairline px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400">
                                                {ref}
                                            </span>
                                        )) : (
                                            <span className="text-ui-2xs text-zinc-600">No evidence refs were recorded.</span>
                                        )}
                                    </div>
                                </div>
                                <p className="font-mono text-ui-2xs leading-relaxed text-zinc-600">
                                    {[s.provider, s.model].filter(x => x && x !== 'unknown').join(' · ') || 'model unrecorded'}
                                    {' · '}tape hash {s.dataHash}
                                    {s.promptVersion ? ` · ${s.promptVersion}` : ''}
                                </p>
                            </div>

                            <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-3">
                                    <DetailKV label="Planned" value={`${rr.toFixed(2)}R`} />
                                    <DetailKV label="Expires" value={phtStamp(s.expiresAt)} />
                                    {resolution && <DetailKV label="Fill" value={resolution.triggeredAt !== undefined ? phtStamp(resolution.triggeredAt) : 'recorded'} />}
                                    {resolution && <DetailKV label="Read" value={resolution.path === '1m' ? '1m drill-down' : `${resolution.usedBarTimes.length} closed bar${resolution.usedBarTimes.length === 1 ? '' : 's'}`} />}
                                </div>

                                {resolution && (
                                    <div className="border-t border-hairline pt-3 text-ui-2xs leading-relaxed text-zinc-500">
                                        <p className="font-mono text-ui-dense text-zinc-300">
                                            gross {signedR(resolution.grossR)} · cost {resolution.feeR.toFixed(2)}R · net {signedR(resolution.outcomeR)}
                                        </p>
                                        <p className="mt-1">
                                            {resolution.exitPrice !== undefined ? `exit ${trackedPrice(resolution.exitPrice)}` : 'no exit fill'}
                                            {resolution.exitAt !== undefined ? ` at ${phtStamp(resolution.exitAt)}` : ''}
                                            {' · '}{venueLabel(row)}
                                        </p>
                                        {resolution.primarySource === 'binance' && (
                                            <p className="mt-1 text-amber-300/80">Binance fallback: OKX was unavailable, so no second venue saw this resolution.</p>
                                        )}
                                        {resolution.ambiguous && (
                                            <p className="mt-1 text-amber-300/80">Both levels sat in one bar and no 1m series could order them — settled stop-first.</p>
                                        )}
                                    </div>
                                )}

                                {grounding && (
                                    <p className={`text-ui-2xs ${grounding.verdict === 'missing' ? 'text-amber-300/80' : 'text-zinc-500'}`}>
                                        Evidence shadow: {grounding.verdict}
                                        {grounding.missing.length > 0 ? ` — ${grounding.missing.join(', ')}` : ''}
                                    </p>
                                )}
                                {gate && (
                                    <p className={`text-ui-2xs ${gate.status === 'refused' ? 'text-amber-300/80' : 'text-zinc-500'}`}>
                                        Gate shadow: {gate.status}
                                        {typeof gate.confidenceCap === 'number' ? ` · cap ${(gate.confidenceCap * 100).toFixed(0)}%` : ''}
                                        {gate.reason ? ` · ${gate.reason}` : ''}
                                    </p>
                                )}
                                <p className="text-ui-2xs text-zinc-600">
                                    Shadow checks record what a gate would have done. They never blocked this call.
                                </p>

                                {tracked ? (
                                    <div className="border-t border-hairline pt-3 text-ui-2xs leading-relaxed text-zinc-500" data-testid="signal-tracked-state">
                                        <p className="text-ui-2xs uppercase tracking-wider text-zinc-600">Tracker</p>
                                        <p className="mt-1 text-ui-dense text-zinc-300">
                                            {TRACKED_STATUS_WORD[tracked.status]} · {tracked.barsRead} closed bar{tracked.barsRead === 1 ? '' : 's'}
                                            {' · '}MFE {excursionR(tracked.mfeR)} · MAE {excursionR(tracked.maeR)}
                                        </p>
                                        {tracked.exit && (
                                            <p className="mt-1">
                                                Exit {tracked.exit.reason} at {trackedPrice(tracked.exit.price)}
                                                {tracked.exit.netR !== null ? ` · ${signedR(tracked.exit.netR)} net after ${tracked.exit.costR !== null ? `${tracked.exit.costR.toFixed(2)}R cost` : 'an unmeasured cost'}` : ''}
                                            </p>
                                        )}
                                        {tracked.gaps.length > 0 && (
                                            <p className="mt-1 text-amber-300/80">{tracked.gaps.length} missing closed bar{tracked.gaps.length === 1 ? '' : 's'} inside the tracked window.</p>
                                        )}
                                    </div>
                                ) : (
                                    <p className="border-t border-hairline pt-3 text-ui-2xs text-zinc-600">
                                        Not tracked — the ledger is this call's record. The tracker adopts signals emitted in the last 24 hours.
                                    </p>
                                )}
                            </div>
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
};

const SignalFeed: React.FC<SignalFeedProps> = ({ user }) => {
    const activeUser = user ?? getActiveUsername();
    const [rows, setRows] = useState<SignalRow[]>(() => readSignals(activeUser));
    const [refusals, setRefusals] = useState<SignalRefusalRow[]>(() => foldRefusals(readSignalEvents(activeUser)));
    const [settling, setSettling] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [trackedBySignal, setTrackedBySignal] = useState<Record<string, TrackedPosition>>({});
    const [trackedError, setTrackedError] = useState<string | null>(null);

    const load = useCallback(() => {
        setRows(readSignals(activeUser));
        setRefusals(foldRefusals(readSignalEvents(activeUser)));
    }, [activeUser]);

    const loadTracked = useCallback(async () => {
        try {
            const read = await readTrackedPositions(activeUser);
            if (!read.ok) {
                setTrackedError(read.error);
                return;
            }
            const next: Record<string, TrackedPosition> = {};
            for (const position of read.value) {
                if (position.source === 'signal') next[position.sourceId] = position;
            }
            setTrackedBySignal(next);
            setTrackedError(null);
        } catch (e) {
            setTrackedError(e instanceof Error ? e.message : String(e));
        }
    }, [activeUser]);

    useEffect(() => {
        let alive = true;
        setRows(readSignals(activeUser));
        setSettling(true);
        void loadTracked();
        void settleDueSignals(activeUser)
            .then(out => {
                if (!alive) return;
                load();
                void loadTracked();
                if (out.resolved > 0) setNote(`Settled ${out.resolved} signal${out.resolved === 1 ? '' : 's'} against the tape.`);
                else if (out.skipped.some(s => s.reason.startsWith('the tape does not reach back'))) {
                    setNote('Some open signals predate the fetched tape; they stay open rather than being read as no-entry.');
                }
            })
            .catch(() => { /* settlement is best-effort; the stored rows still render */ })
            .finally(() => { if (alive) setSettling(false); });
        return () => { alive = false; };
    }, [activeUser, load, loadTracked]);

    const refresh = useCallback(() => {
        setSettling(true);
        setNote(null);
        void settleDueSignals(activeUser, { force: true })
            .then(out => {
                load();
                void loadTracked();
                setNote(out.resolved > 0 ? `Settled ${out.resolved} signal${out.resolved === 1 ? '' : 's'}.` : 'No signal was ready to settle.');
            })
            .catch(() => setNote('Settlement could not reach the tape; nothing was written.'))
            // The refusal bookkeeping grades on the same refresh, after the
            // real signals — it is a shadow ledger, never the headline.
            .then(() => settleRefusedSignals(activeUser))
            .then(() => { load(); })
            .catch(() => { /* refusal grading is best-effort */ })
            .finally(() => setSettling(false));
    }, [activeUser, load, loadTracked]);

    const summary = useMemo(() => summariseSignals(rows), [rows]);
    // The scorecard is the receipt's math; the feed renders the same object so
    // the two can never disagree about slugging or the hit-rate interval.
    const scorecard = useMemo(() => scoreSignals(rows), [rows]);
    // N6: the fixed mechanical rule's hit rate, averaged over the resolutions
    // that carry one — "does the harness beat a rule with no model at all",
    // resolved on the same tape by the same resolver as the base rate itself.
    const ruleBaseline = useMemo(() => {
        const rates = rows
            .map(r => r.resolution?.base?.ruleHitRate)
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length;
    }, [rows]);
    const fills = summary.won + summary.lost + summary.expired;
    const costPct = ((SIGNAL_TAKER_FEE_RATE + SIGNAL_SLIPPAGE_RATE) * 2 * 100).toFixed(2);

    return (
        <div className="h-full overflow-y-auto" data-testid="signal-feed">
            <div className="space-y-6 p-6 sm:p-8">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 max-w-2xl">
                        <p className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Desk signals</p>
                        <p className="text-ui-caption leading-relaxed text-zinc-500">
                            The desk's own calls — a direction, three prices and an expiry — recorded when it emits one and settled later
                            against the tape. These are not your trades and nothing here places an order.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={refresh}
                        disabled={settling}
                        className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-ui-xs font-semibold text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        title="Re-check open signals against the tape"
                    >
                        <RefreshIcon className={`h-3.5 w-3.5 ${settling ? 'animate-spin' : ''}`} aria-hidden="true" />
                        {settling ? 'Settling…' : 'Settle now'}
                    </button>
                </div>

                {summary.emitted > 0 && (
                    <section className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-hairline py-5 sm:grid-cols-3 lg:grid-cols-7">
                        <Stat
                            label="Hit rate"
                            value={pct(summary.hitRate)}
                            sub={`${summary.won}W / ${summary.lost}L / ${summary.expired} expired of ${summary.won + summary.lost + summary.expired} fills`
                                + (scorecard.hitCi
                                    ? ` · 95% CI ${(scorecard.hitCi.low * 100).toFixed(0)}–${(scorecard.hitCi.high * 100).toFixed(0)}%`
                                    : '')}
                        />
                        <Stat
                            label="Expectancy"
                            value={summary.expectancyR === null ? '—' : signedR(summary.expectancyR)}
                            sub="after fees, per filled call"
                        />
                        <Stat
                            label="vs base"
                            value={summary.baseRate === null || summary.hitRate === null
                                ? '—'
                                : `${pct(summary.hitRate)} vs ${pct(summary.baseRate)}`}
                            sub={summary.lift === null
                                ? 'no same-levels baseline yet'
                                : `lift ${summary.lift >= 0 ? '+' : ''}${(summary.lift * 100).toFixed(1)} pts · N=${fills}${fills < MIN_ACCURACY_FILLS ? ' · thin' : ''}`
                                    + (ruleBaseline === null ? '' : ` · rule ${pct(ruleBaseline)}`)}
                        />
                        <Stat
                            label="Slugging"
                            value={scorecard.slugging === null ? '—' : `${scorecard.slugging.toFixed(2)}×`}
                            sub={scorecard.slugging === null
                                ? 'needs wins and losses'
                                : 'avg win ÷ avg loss, net R'}
                        />
                        <Stat
                            label="Ambiguity"
                            value={pct(summary.ambiguityRate)}
                            sub="same-bar both-hit, settled stop-first"
                        />
                        <Stat
                            label="Emitted"
                            value={`${summary.emitted}`}
                            sub={`${summary.open} open · ${summary.neverTriggered} no entry`}
                        />
                        <ShadowLine summary={summary} />
                    </section>
                )}

                {note && <p className="text-ui-dense text-zinc-500" data-testid="signal-note">{note}</p>}
                {refusals.length > 0 && (
                    <p className="text-ui-dense text-zinc-500" data-testid="signal-refusals">
                        {refusals.length} blocked emission{refusals.length === 1 ? '' : 's'} by the stop-digging protections
                        {(() => {
                            const graded = refusals.filter(r => r.resolution);
                            if (graded.length === 0) return ' — none graded yet.';
                            const wins = graded.filter(r => r.resolution?.outcome === 'would_win').length;
                            const losses = graded.filter(r => r.resolution?.outcome === 'would_lose').length;
                            return ` — ${graded.length} graded: ${wins} would-win, ${losses} would-lose`
                                + ` (net ${graded.reduce((a, r) => a + (r.resolution?.outcomeR ?? 0), 0).toFixed(2)}R the rules kept off the ledger).`;
                        })()}
                    </p>
                )}
                {settling && <p className="text-ui-dense text-zinc-500">Reading closed OKX candles (Binance cross-check)…</p>}
                {trackedError && (
                    <p className="text-ui-dense text-amber-300/80">Tracker state could not be read: {trackedError}. Settlement is unaffected.</p>
                )}

                {rows.length === 0 ? (
                    <div data-testid="signal-feed-empty">
                        <p className="text-ui-sm text-zinc-200">No signals yet.</p>
                        <p className="mt-2 max-w-2xl text-ui-caption leading-relaxed text-zinc-500">
                            A signal is emitted by the desk when it calls <code className="font-mono text-ui-dense text-zinc-400">emit_signal</code> —
                            a direction, entry, stop, target and expiry it is willing to be graded on. Every one is settled on closed
                            5-minute candles after expiry, with a stop-first rule when a bar contains both levels.
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table data-testid="signal-table" className="w-full min-w-[820px] border-collapse text-left">
                            <thead>
                                <tr className="border-b border-hairline text-ui-2xs uppercase tracking-[0.1em] text-zinc-500">
                                    <th scope="col" className="py-2 pr-4 font-medium">Signal</th>
                                    <th scope="col" className="py-2 px-3 font-medium">Status</th>
                                    <th scope="col" className="py-2 px-3 text-right font-medium">Entry</th>
                                    <th scope="col" className="py-2 px-3 text-right font-medium">Stop</th>
                                    <th scope="col" className="py-2 px-3 text-right font-medium">Target</th>
                                    <th scope="col" className="py-2 px-3 text-right font-medium">Outcome</th>
                                    <th scope="col" className="py-2 px-3 font-medium">Same-levels base</th>
                                    <th scope="col" className="py-2 pl-3 font-medium">Emitted</th>
                                    <th scope="col" className="w-8 py-2"><span className="sr-only">Details</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <SignalTableRow
                                        key={row.signal.id}
                                        row={row}
                                        tracked={trackedBySignal[row.signal.id]}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <p className="text-ui-2xs leading-relaxed text-zinc-600">
                    Settlement: closed OKX 5m candles, Binance cross-check on the bars that decided the call, 1m drill-down only for a
                    bar that contains both levels. Costs charged in R: {costPct}% round trip (taker fee + assumed slippage). The base rate
                    is the SAME levels entered at every bar of the same tape — a hit rate means nothing without it. A signal whose tape is
                    unavailable stays open; it is never read as &quot;no entry&quot;.
                </p>
            </div>
        </div>
    );
};

export default React.memo(SignalFeed);
