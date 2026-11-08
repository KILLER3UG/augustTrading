/**
 * TrackedPostMortem — the measured record beside the model's prose.
 *
 * The journal row says what the trader decided. This section says what the
 * harness OBSERVED after that decision — the closed-bar path, the excursions,
 * the exit and its fill quality — and what the post-mortem concluded from it.
 * Neither half is allowed to stand in for the other: a diagnosis without the
 * tape would be a story, and a path without a diagnosis would be a chart.
 *
 * The section mounts only when a tracked position exists for THIS journal row
 * (`source === 'journal' && sourceId === trade.id`), so the legacy settlement
 * note and this record never impersonate each other. When the position exists
 * but the diagnosis does not, the view says which of the real reasons applies —
 * still open, journal not settled, queued, running, or failed — rather than
 * rendering an empty lesson.
 */

import React, { useEffect, useState } from 'react';
import type { LoggedTrade } from '../../types';
import type { DiagnosisQueueItem, TrackedDiagnosis, TrackedPosition } from '../../types/tracking';
import {
    readDiagnoses,
    readDiagnosisQueue,
    readTrackedPositions,
} from '../../services/tracking/positionStore';
import { humanizeSkillName } from '../../utils/skillNames';
import { phtStamp } from '../../utils/timezone';
import { getActiveUsername } from '../../utils/activeUser';
import {
    DIAGNOSIS_CHANGE_WORD,
    DIAGNOSIS_REFUSAL_WORD,
    EXIT_REASON_WORD,
    SAME_CANDLE_WORD,
    TRACKED_STATUS_WORD,
    excursionR,
    signedR,
    trackedPrice,
} from '../../utils/trackingLabels';

interface LinkedSkill {
    id: string;
    title: string;
    description?: string;
    status: string;
    wins: number;
    losses: number;
    tentative: boolean;
}

interface ReadyState {
    phase: 'ready';
    position: TrackedPosition;
    diagnosis: TrackedDiagnosis | null;
    diagnosisCount: number;
    queueItem: DiagnosisQueueItem | null;
    skills: LinkedSkill[];
    problems: string[];
}

type LoadState =
    | { phase: 'loading' }
    | { phase: 'none' }
    | { phase: 'error'; message: string }
    | ReadyState;

const useTrackedRecord = (tradeId: string, username?: string): LoadState => {
    const [state, setState] = useState<LoadState>({ phase: 'loading' });

    useEffect(() => {
        let alive = true;
        const user = username || getActiveUsername();
        setState({ phase: 'loading' });
        void (async () => {
            const [positions, diagnoses, queue] = await Promise.all([
                readTrackedPositions(user),
                readDiagnoses(user),
                readDiagnosisQueue(user),
            ]);
            if (!alive) return;
            if (!positions.ok) {
                setState({ phase: 'error', message: positions.error });
                return;
            }
            const position = positions.value.find(p => p.source === 'journal' && p.sourceId === tradeId);
            if (!position) {
                setState({ phase: 'none' });
                return;
            }
            const problems: string[] = [];
            if (!diagnoses.ok) problems.push(`post-mortems: ${diagnoses.error}`);
            if (!queue.ok) problems.push(`diagnosis queue: ${queue.error}`);

            const diagnosisRows = diagnoses.ok
                ? diagnoses.value
                    .filter(d => d.tradeId === position.id)
                    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
                : [];
            const queueItem = queue.ok
                ? queue.value.find(item => item.tradeId === position.id) ?? null
                : null;

            const skills: LinkedSkill[] = [];
            setState({
                phase: 'ready',
                position,
                diagnosis: diagnosisRows[0] ?? null,
                diagnosisCount: diagnosisRows.length,
                queueItem,
                skills,
                problems,
            });
        })().catch(e => {
            if (alive) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
        });
        return () => { alive = false; };
    }, [tradeId, username]);

    return state;
};

const Metric: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
    <div className="min-w-0">
        <dt className="text-ui-xs uppercase tracking-wider text-zinc-600">{label}</dt>
        <dd className="mt-1 truncate font-mono text-ui-base tabular-nums text-zinc-200" title={value}>{value}</dd>
        {sub && <dd className="mt-0.5 truncate text-ui-2xs text-zinc-500" title={sub}>{sub}</dd>}
    </div>
);

const Prose: React.FC<{ label: string; text: string }> = ({ label, text }) => (
    <div className="min-w-0">
        <p className="text-ui-xs uppercase tracking-wider text-zinc-600">{label}</p>
        <p className="mt-1.5 text-ui-caption leading-relaxed text-zinc-300">{text}</p>
    </div>
);

const Dot: React.FC<{ className: string; label: string }> = ({ className, label }) => (
    <span className="inline-flex items-baseline gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />
        {label}
    </span>
);

const PricePath: React.FC<{ position: TrackedPosition }> = ({ position }) => {
    const points = position.timeline;
    if (points.length < 2) {
        return (
            <p className="mt-3 text-ui-dense text-zinc-500" data-testid="tracked-path-empty">
                {points.length === 0
                    ? 'The tracker stored no closed bars for this position, so there is no path to draw.'
                    : 'The tracker stored one closed bar; a path needs at least two.'}
            </p>
        );
    }
    const W = 800;
    const H = 200;
    const padX = 10;
    const padY = 14;
    const prices = [
        position.entry,
        position.stop,
        ...position.targets,
        ...points.map(p => p.h),
        ...points.map(p => p.l),
    ];
    if (position.mfePrice !== null) prices.push(position.mfePrice);
    if (position.maePrice !== null) prices.push(position.maePrice);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const first = points[0].t;
    const last = points[points.length - 1].t;
    const timeSpan = last - first || 1;
    const x = (t: number) => padX + ((t - first) / timeSpan) * (W - padX * 2);
    const y = (price: number) => padY + (1 - (price - min) / span) * (H - padY * 2);
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
    const area = `${line} L${x(last).toFixed(1)},${H - padY} L${x(first).toFixed(1)},${H - padY} Z`;

    return (
        <div className="mt-3 overflow-hidden rounded-card border border-hairline bg-zinc-950/40">
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="h-auto w-full"
                role="img"
                aria-label={`Price path for ${position.symbol} from entry to ${position.exit ? 'exit' : 'the latest closed bar'}`}
                data-testid="tracked-path"
            >
                <path d={area} fill="rgb(34 211 238 / 0.05)" />
                {position.targets.map((target, i) => (
                    <line
                        key={`target-${i}`}
                        x1={padX} x2={W - padX} y1={y(target)} y2={y(target)}
                        stroke="rgb(52 211 153 / 0.32)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"
                    />
                ))}
                <line
                    x1={padX} x2={W - padX} y1={y(position.entry)} y2={y(position.entry)}
                    stroke="rgb(34 211 238 / 0.5)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke"
                />
                <line
                    x1={padX} x2={W - padX} y1={y(position.stop)} y2={y(position.stop)}
                    stroke="rgb(251 113 133 / 0.45)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke"
                />
                {position.gaps.map((gap, i) => (
                    <line
                        key={`gap-${i}`}
                        x1={x(gap)} x2={x(gap)} y1={H - padY} y2={H - padY - 10}
                        stroke="rgb(252 211 77 / 0.6)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                    />
                ))}
                <path
                    d={line} fill="none" stroke="rgb(212 212 216 / 0.9)" strokeWidth={1.6}
                    strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
                />
                {position.mfePrice !== null && position.mfeAt !== null && (
                    <circle cx={x(position.mfeAt)} cy={y(position.mfePrice)} r={4} fill="rgb(52 211 153)" />
                )}
                {position.maePrice !== null && position.maeAt !== null && (
                    <circle cx={x(position.maeAt)} cy={y(position.maePrice)} r={4} fill="rgb(251 113 133)" />
                )}
                {position.entryBarTime !== undefined && (
                    <circle cx={x(position.entryBarTime)} cy={y(position.entry)} r={3.5} fill="rgb(34 211 238)" />
                )}
                {position.exit && (
                    <circle cx={x(position.exit.at)} cy={y(position.exit.price)} r={4} fill="rgb(244 244 245)" />
                )}
            </svg>
        </div>
    );
};

const diagnosisPendingReason = (position: TrackedPosition, queueItem: DiagnosisQueueItem | null): string => {
    if (!position.exit) {
        if (position.status === 'pending_entry') return 'The entry has not been touched yet, so there is nothing to diagnose.';
        if (position.status === 'cancelled') return 'This plan never filled; there is no outcome to diagnose.';
        return 'The position is still open against the tape; a diagnosis runs after it closes.';
    }
    if (position.source === 'journal' && position.journalSettledAt === undefined) {
        return 'The tape closed this position, but the journal row has not settled yet; no diagnosis was queued.';
    }
    if (queueItem?.status === 'failed') {
        return `The diagnosis could not be written after ${queueItem.attempts} attempt${queueItem.attempts === 1 ? '' : 's'}: ${queueItem.lastError ?? 'no error recorded'}.`;
    }
    if (queueItem?.status === 'running') return 'The diagnosis is running now.';
    if (queueItem?.status === 'pending') {
        return `The diagnosis is queued${queueItem.attempts > 0 ? ` (${queueItem.attempts} attempt${queueItem.attempts === 1 ? '' : 's'} so far)` : ''} and runs on the tracker's next pass, at most 3 per pass.`;
    }
    if (queueItem?.status === 'done') {
        return 'The queue records a finished diagnosis, but no post-mortem row could be read.';
    }
    return 'No diagnosis has been recorded for this position yet.';
};

export interface TrackedPostMortemProps {
    trade: LoggedTrade;
    username?: string;
    modelIdToName: Record<string, string>;
    /** The legacy settlement note owns "Post-mortem" when it exists; this
     *  record then names itself separately so two records never share a title. */
    title?: string;
}

const TrackedPostMortem: React.FC<TrackedPostMortemProps> = ({ trade, username, modelIdToName, title = 'Post-mortem' }) => {
    const state = useTrackedRecord(trade.id, username);

    if (state.phase === 'loading' || state.phase === 'none') return null;
    if (state.phase === 'error') {
        return (
            <section className="mt-10" data-testid="tracked-post-mortem-error">
                <h3 className="text-ui-base font-semibold tracking-tight text-zinc-100">Tracked record</h3>
                <p className="mt-2 text-ui-dense text-amber-300/80">
                    The tracked record could not be read: {state.message}. Nothing was changed by this view.
                </p>
            </section>
        );
    }

    const { position, diagnosis, diagnosisCount, queueItem, skills, problems } = state;
    const netR = position.exit?.netR;
    const net = netR === null || netR === undefined ? null : netR;
    const grossR = position.exit?.realizedR;
    const costR = position.exit?.costR;

    return (
        <section className="mt-10" data-testid="tracked-post-mortem">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-ui-base font-semibold tracking-tight text-zinc-100">{title}</h3>
                <span className="text-ui-2xs uppercase tracking-widest text-zinc-600">tracked by the harness</span>
            </div>
            <p className="mt-1 font-mono text-ui-2xs uppercase tracking-widest text-zinc-500" data-testid="tracked-post-mortem-when">
                {position.closedAt ? `closed ${phtStamp(position.closedAt)}` : `opened ${phtStamp(position.openedAt)}`}
                {diagnosis?.model ? ` · ${modelIdToName[diagnosis.model] ?? diagnosis.model}` : ''}
                {diagnosis?.tentative && !diagnosis.refusal ? ' · tentative' : ''}
            </p>
            {problems.length > 0 && (
                <p className="mt-2 text-ui-2xs text-amber-300/80">
                    Part of this record could not be read: {problems.join('; ')}.
                </p>
            )}

            <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
                <span className={`font-mono text-ui-lg font-semibold tabular-nums ${net === null ? 'text-zinc-300' : net >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {net !== null ? `${signedR(net)} net` : TRACKED_STATUS_WORD[position.status]}
                </span>
                <span className="text-ui-dense text-zinc-400">
                    {position.exit ? EXIT_REASON_WORD[position.exit.reason] : TRACKED_STATUS_WORD[position.status]}
                    {position.exit && !position.exit.slippageModeled ? ' · fees only, slippage not modelled' : ''}
                </span>
                <span className="text-ui-dense text-zinc-500">
                    MFE {excursionR(position.mfeR)} · MAE {excursionR(position.maeR)}
                </span>
                <span className="text-ui-dense text-zinc-500">
                    {position.barsRead} closed 5m bar{position.barsRead === 1 ? '' : 's'}
                </span>
                {!position.tapeCoversWindow && (
                    <span className="text-ui-2xs text-amber-300/80">tape starts after the entry window</span>
                )}
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <Metric label="Opened" value={phtStamp(position.openedAt)} />
                <Metric
                    label="Entry"
                    value={trackedPrice(position.entry)}
                    sub={position.entryConfirmed ? 'confirmed by the journal log' : 'waiting for the limit'}
                />
                <Metric
                    label="Best (MFE)"
                    value={excursionR(position.mfeR)}
                    sub={position.mfeAt !== null ? phtStamp(position.mfeAt) : 'not measured'}
                />
                <Metric
                    label="Worst (MAE)"
                    value={excursionR(position.maeR)}
                    sub={position.maeAt !== null ? phtStamp(position.maeAt) : 'not measured'}
                />
                <Metric
                    label="Exit"
                    value={position.exit ? trackedPrice(position.exit.price) : '—'}
                    sub={position.exit ? `${EXIT_REASON_WORD[position.exit.reason]} · ${phtStamp(position.exit.at)}` : 'not closed'}
                />
                <Metric
                    label="Costs"
                    value={net !== null ? signedR(net) : '—'}
                    sub={position.exit
                        ? `gross ${grossR !== null && grossR !== undefined ? signedR(grossR) : '—'} · cost ${costR !== null && costR !== undefined ? `${costR.toFixed(2)}R` : 'not modelled'}`
                        : 'no exit yet'}
                />
                <Metric
                    label="Gaps"
                    value={`${position.gaps.length}`}
                    sub={position.gaps.length > 0 ? 'missing closed 5m bars' : 'none inside the window'}
                />
                <Metric
                    label="Journal"
                    value={position.journalSettledAt !== undefined ? 'settled' : 'open'}
                    sub={position.journalSettledAt !== undefined ? phtStamp(position.journalSettledAt) : 'no settled outcome yet'}
                />
            </dl>

            {position.exit && (
                <p className="mt-3 text-ui-2xs leading-relaxed text-zinc-500">
                    {SAME_CANDLE_WORD[position.exit.sameCandle]}
                    {position.exit.gapAtOpen ? ' · the deciding bar opened beyond the level, so the fill is gap-adjusted' : ''}
                    {' · '}{position.exit.barsRead} closed bar{position.exit.barsRead === 1 ? '' : 's'} read
                </p>
            )}
            {position.discrepancy && (
                <p className="mt-2 text-ui-2xs text-amber-300/80">Recorded discrepancy: {position.discrepancy}</p>
            )}

            <div className="mt-8">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h4 className="text-ui-sm font-semibold text-zinc-200">The path</h4>
                    <span className="text-ui-2xs text-zinc-600">
                        {position.timeline.length} stored point{position.timeline.length === 1 ? '' : 's'}
                        {position.timelineDownsampled ? ` · downsampled, ${position.timelinePointsDropped} dropped` : ''}
                        {position.gaps.length > 0 ? ` · ${position.gaps.length} gap${position.gaps.length === 1 ? '' : 's'}` : ''}
                    </span>
                </div>
                <PricePath position={position} />
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ui-2xs text-zinc-500">
                    <Dot className="bg-cyan-400" label={`entry ${trackedPrice(position.entry)}`} />
                    <Dot className="bg-rose-400" label={`stop ${trackedPrice(position.stop)}`} />
                    {position.targets.map((target, i) => (
                        <Dot key={`legend-target-${i}`} className="bg-emerald-400" label={`target ${trackedPrice(target)}`} />
                    ))}
                    <Dot className="bg-emerald-400" label={`MFE ${excursionR(position.mfeR)}`} />
                    <Dot className="bg-rose-400" label={`MAE ${excursionR(position.maeR)}`} />
                    {position.exit && <Dot className="bg-zinc-200" label={net !== null ? `exit ${signedR(net)} net` : 'exit'} />}
                    {position.gaps.length > 0 && <Dot className="bg-amber-300" label={`${position.gaps.length} gap${position.gaps.length === 1 ? '' : 's'}`} />}
                </div>
                <p className="mt-2 text-ui-2xs text-zinc-600">
                    Closed 5m closes; the lines are the planned entry, stop and targets. The path is capped and decisive bars
                    (entry, best, worst, exit, a bar after a gap) are always kept.
                </p>
            </div>

            <div className="mt-8">
                <h4 className="text-ui-sm font-semibold text-zinc-200">Sequence</h4>
                <ol className="mt-3 space-y-1.5 border-l border-hairline pl-4 text-ui-dense text-zinc-400">
                    <li><span className="text-zinc-300">Opened</span> · {phtStamp(position.openedAt)}</li>
                    {position.entryBarTime !== undefined && (
                        <li><span className="text-zinc-300">Entry filled</span> · {phtStamp(position.entryBarTime)} at {trackedPrice(position.entry)}</li>
                    )}
                    {position.mfeAt !== null && (
                        <li><span className="text-zinc-300">Best</span> · {excursionR(position.mfeR)} at {phtStamp(position.mfeAt)}</li>
                    )}
                    {position.maeAt !== null && (
                        <li><span className="text-zinc-300">Worst</span> · {excursionR(position.maeR)} at {phtStamp(position.maeAt)}</li>
                    )}
                    {position.exit && (
                        <li>
                            <span className="text-zinc-300">Exit</span> · {EXIT_REASON_WORD[position.exit.reason]} at {trackedPrice(position.exit.price)}
                            {' · '}{phtStamp(position.exit.at)}{net !== null ? ` · ${signedR(net)} net` : ''}
                        </li>
                    )}
                    {position.journalSettledAt !== undefined && (
                        <li><span className="text-zinc-300">Journal settled</span> · {phtStamp(position.journalSettledAt)}</li>
                    )}
                    {diagnosis && (
                        <li><span className="text-zinc-300">Diagnosed</span> · {phtStamp(diagnosis.createdAt)}</li>
                    )}
                </ol>
            </div>

            <div className="mt-8 border-t border-hairline pt-6" data-testid="tracked-diagnosis">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h4 className="text-ui-sm font-semibold text-zinc-200">What the post-mortem said</h4>
                    {diagnosis && (
                        <div className="flex flex-wrap gap-1.5">
                            {diagnosis.refusal && (
                                <span className="rounded-full border border-amber-400/30 px-2 py-0.5 text-ui-2xs text-amber-300">
                                    Refused · {DIAGNOSIS_REFUSAL_WORD[diagnosis.refusal]}
                                </span>
                            )}
                            {diagnosis.tentative && !diagnosis.refusal && (
                                <span
                                    className="rounded-full border border-cyan-400/30 px-2 py-0.5 text-ui-2xs text-cyan-300"
                                    title="A tentative skill is context only until 3 independent outcomes on the same setup"
                                >
                                    Tentative · context only
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {!diagnosis ? (
                    <p className="mt-3 max-w-2xl text-ui-caption leading-relaxed text-zinc-400" data-testid="tracked-diagnosis-pending">
                        {diagnosisPendingReason(position, queueItem)}
                    </p>
                ) : (
                    <>
                        {diagnosis.modelOutcome && diagnosis.modelOutcome !== diagnosis.outcome && (
                            <p className="mt-3 text-ui-xs text-amber-300/80">
                                The model called it a {diagnosis.modelOutcome}; the tape's {diagnosis.outcome} is the stored outcome.
                            </p>
                        )}
                        {diagnosis.refusal ? (
                            <>
                                <p className="mt-3 max-w-2xl text-ui-caption leading-relaxed text-zinc-300">{diagnosis.whatHappened}</p>
                                <p className="mt-2 text-ui-xs text-zinc-600">
                                    A refusal is recorded, not hidden: no lesson was minted and no skill can learn from this trade.
                                </p>
                            </>
                        ) : (
                            <>
                                <div className="mt-5 grid gap-6 sm:grid-cols-2">
                                    <Prose label="What happened" text={diagnosis.whatHappened} />
                                    <Prose label="Root cause" text={diagnosis.rootCause} />
                                    <Prose label="What should have been done" text={diagnosis.whatShouldHaveBeenDone} />
                                    <div className="min-w-0">
                                        <p className="text-ui-xs uppercase tracking-wider text-zinc-600">Primary change</p>
                                        <p className="mt-1.5 text-ui-base text-zinc-200">{DIAGNOSIS_CHANGE_WORD[diagnosis.primaryChange]}</p>
                                    </div>
                                </div>
                                <blockquote className="mt-6 border-l-2 border-cyan-400/40 pl-5">
                                    <p className="text-ui-base leading-relaxed text-zinc-200">{diagnosis.lesson}</p>
                                    <p className="mt-2 font-mono text-ui-xs uppercase tracking-wider text-zinc-500">
                                        IF {diagnosis.when} THEN {diagnosis.action}
                                    </p>
                                </blockquote>
                            </>
                        )}
                        <p className="mt-4 text-ui-xs leading-relaxed text-zinc-600">
                            Confidence {Math.round(diagnosis.confidence)}%
                            {' · '}{diagnosis.evidenceCount} evidence item{diagnosis.evidenceCount === 1 ? '' : 's'}
                            {diagnosis.packetHash ? ` · packet ${diagnosis.packetHash}` : ''}
                            {diagnosis.promptVersion ? ` · ${diagnosis.promptVersion}` : ''}
                            {diagnosisCount > 1 ? ` · ${diagnosisCount} diagnosis records on file` : ''}
                        </p>
                    </>
                )}
            </div>

            <div className="mt-8 border-t border-hairline pt-6" data-testid="tracked-linked-skills">
                <h4 className="text-ui-sm font-semibold text-zinc-200">Skills citing this trade</h4>
                {skills.length === 0 ? (
                    <p className="mt-2 max-w-2xl text-ui-caption leading-relaxed text-zinc-500">
                        No skill cites this trade yet. A tentative skill is minted only after three independent outcomes on the same
                        setup — different trades, non-overlapping holding windows, and not the same setup on the same day.
                    </p>
                ) : (
                    <ul className="mt-3 divide-y divide-hairline">
                        {skills.map(skill => (
                            <li key={skill.id} className="py-2.5">
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                    <span className="text-ui-dense font-medium text-zinc-200">{skill.title}</span>
                                    <span className="text-ui-2xs uppercase tracking-wider text-zinc-500">{skill.status}</span>
                                    {skill.tentative && (
                                        <span className="rounded-full border border-cyan-400/30 px-1.5 py-0.5 text-ui-2xs text-cyan-300">
                                            tentative · context only
                                        </span>
                                    )}
                                    <span className="ml-auto font-mono text-ui-2xs text-zinc-500">{skill.wins}W / {skill.losses}L</span>
                                </div>
                                {skill.description && (
                                    <p className="mt-1 text-ui-2xs leading-relaxed text-zinc-500">{skill.description}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <p className="mt-3 text-ui-2xs leading-relaxed text-zinc-600">
                    The model writes the prose; the path, R, excursions and gaps beside it are measured by the app from closed 5m
                    candles. A tentative skill is context, never an enforcement.
                </p>
            </div>
        </section>
    );
};

export default React.memo(TrackedPostMortem);
