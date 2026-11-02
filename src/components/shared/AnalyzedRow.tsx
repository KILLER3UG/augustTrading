import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from './Icons';
import { formatElapsed } from './elapsed';
import { subscribeSharedTicker } from '../../hooks/useSharedTicker';

export interface AnalyzedRowProps {
    /** The turn is still working (streaming, no answer text yet) — the
     *  timeline stays OPEN live and the duration ticks. */
    running?: boolean;
    className?: string;
    /** What the work was, counted by KIND — "4 reads, 1 search". This is the
     *  settled row's headline: it says what the desk DID, in the typed counts
     *  the reference uses ("Ran 4 commands, read a file"). Omitted when the
     *  turn called no tool. */
    summary?: string | null;
    /** The turn's frozen work time in ms, persisted at settle. Used ONLY when
     *  the clock is not ticking: precedence is live tick > this > nothing.
     *  A reloaded turn has no live clock, so this is what keeps its
     *  "Analyzed for Ns" on screen. */
    persistedMs?: number;
    /** Epoch-ms the turn started. The live clock and the frozen settle both
     *  read it, so a remount from a surface hop does not restart the count. */
    startedAt?: number;
    /** What the work was, named from real data — "Read the chart, order book
     *  and notebook". Rendered after the duration; omitted when unknown. */
    title?: string;
    /** What the turn is doing RIGHT NOW — "Reading the order book". This is
     *  the RUNNING label, and it replaces the bare "Analyzing": a state says
     *  the desk is busy, an activity says what it is busy with. Derived from
     *  the turn's own tool lines (`utils/turnStatus.ts`), so it can only
     *  report what the tools did. Absent ⇒ the bare "Analyzing". */
    activity?: string | null;
    children: React.ReactNode;
}

/**
 * "Analyzed for 14s" — the work line over the step list. The header says what
 * the turn did ("Ran 4 commands, read a file"); the body lists the steps, and
 * EACH STEP is its own disclosure (a Thought row, a tool round).
 *
 * The list stays visible once the answer lands. It used to fold itself shut at
 * settle, which hid every step behind one click and made a settled turn read as
 * a sentence rather than the work it was — the reference keeps the step rows on
 * screen and collapses only what is inside a row. The chevron still folds the
 * whole list for anyone who wants the transcript short, and a starting run
 * opens it again so the live steps are where the eye already is.
 *
 * The clock covers the pre-answer work phase only — it starts at turn start and
 * freezes when the answer text begins.
 */
const AnalyzedRow: React.FC<AnalyzedRowProps> = ({ running = false, className = '', summary, persistedMs, startedAt, title, activity, children }) => {
    // Collapsed by default, like the reference: the line names the work and
    // the steps are one click away. The body stays mounted, so an assertion
    // can still read it; auto-opening on every run is what made a conversation
    // read as a pile of cards.
    const [open, setOpen] = useState(false);
    const turnStartMs = typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null;
    const wasRunningRef = useRef(running);
    const startedAtRef = useRef<number | null>(turnStartMs ?? (running ? Date.now() : null));
    const [liveSeconds, setLiveSeconds] = useState<number | null>(
        running
            ? Math.max(0, Math.round((Date.now() - (turnStartMs ?? Date.now())) / 1000))
            : null,
    );
    const [settledSeconds, setSettledSeconds] = useState<number | null>(null);

    useEffect(() => {
        if (running && !wasRunningRef.current) {
            startedAtRef.current = turnStartMs ?? Date.now();
        }
        if (wasRunningRef.current && !running) {
            const start = startedAtRef.current;
            setSettledSeconds(start !== null ? Math.max(0, Math.round((Date.now() - start) / 1000)) : null);
            startedAtRef.current = null;
            // Settling freezes the CLOCK; it no longer folds the list. The steps
            // are the record of what the turn did, and hiding the record behind
            // a click is what this component used to do.
        }
        wasRunningRef.current = running;
    }, [running, turnStartMs]);

    // The live clock. This row used to run its OWN setInterval, so a
    // 200-message conversation held up to 400 live timers — one per row —
    // each re-rendering its own row. It now subscribes to the ONE shared
    // ticker (hooks/useSharedTicker.ts); the per-row API is unchanged.
    useEffect(() => {
        if (!running) {
            setLiveSeconds(null);
            return;
        }
        const start = turnStartMs ?? startedAtRef.current ?? Date.now();
        const elapsed = (): number => Math.max(0, Math.round((Date.now() - start) / 1000));
        setLiveSeconds(elapsed());
        return subscribeSharedTicker(() => setLiveSeconds(elapsed()));
    }, [running, turnStartMs]);

    // Precedence is deliberate: a LIVE tick outranks everything, then the clock
    // this component froze when the turn settled, and only then the persisted
    // value a reloaded turn carries. A persisted number must never fight a
    // running timer, and a missing one must never print "0s".
    const seconds = running
        ? liveSeconds
        : settledSeconds ?? (typeof persistedMs === 'number' ? Math.max(0, Math.round(persistedMs / 1000)) : null);
    // The reference's two states: running = the "••• verb-ing · 25s" status
    // line; settled with tools = "Ran 4 commands, read a file". Duration only
    // stands alone when there is no action count to lead with.
    //
    // The settled headline is the reference's command count ("Ran 4 commands"),
    // composed by ChatWorkTimeline from the PAIRED calls; the named work follows
    // in `title`. A count of calls, never of transcript lines — the desk writes
    // two lines per call, and a line count would double every number the trader
    // is told.
    const workSummary = (summary ?? '').trim();
    const ranTools = workSummary.length > 0;
    // The RUNNING label is the ACTIVITY, not the state: "Reading the order
    // book" says what the desk is doing, "Analyzing" only says it is busy.
    // The separator follows the same rule as the settled form — a detail
    // takes " · Ns", a bare state keeps " for Ns".
    const runningActivity = (activity ?? '').trim();
    const label = running
        ? (runningActivity || 'Analyzing')
        : ranTools
            ? workSummary
            : 'Analyzed';
    // A settled work turn reads like the reference's "Ran 4 commands, read a
    // file": the count leads and the named work follows. Duration belongs to
    // the LIVE line only — the reference's settled row carries no clock, and
    // printing "· 0s" beside a tool count made a fast read look like it did
    // nothing. A reasoning-only turn keeps "Analyzed for Ns", where the
    // duration is the only thing that happened.
    const detail = running
        ? (seconds !== null ? (runningActivity ? ` · ${formatElapsed(seconds)}` : ` for ${formatElapsed(seconds)}`) : '')
        : ranTools
            ? (title ? ` · ${title.charAt(0).toLowerCase()}${title.slice(1)}` : '')
            : (seconds !== null ? ` for ${formatElapsed(seconds)}` : '') + (title ? ` · ${title.charAt(0).toLowerCase()}${title.slice(1)}` : '');

    return (
        <details
            className={`reasoning-row analyzed-row ${open ? 'is-open' : ''} ${className}`.trim()}
            data-state={running ? 'running' : 'ok'}
            data-testid="analyzed-row"
            open={open}
            onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
        >
            <summary className="reasoning-row-summary" aria-label={`${label}${detail} — ${open ? 'collapse' : 'expand'}`}>
                {running && (
                    /* Three dots, in the reference's WARM colour: the work is
                       running, and the app's running hue is the amber one.
                       Grey said "something is happening"; amber says "the desk
                       is working right now", which is the one thing the row
                       exists to say. */
                    <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
                        {[0, 1, 2].map(i => (
                            <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-amber-500/80 motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms` }} />
                        ))}
                    </span>
                )}
                <span className="reasoning-row-label">
                    {label}{detail}
                </span>
                {/* The chevron the reference puts on every expandable line. A
                    collapsed summary otherwise only hints that it opens. */}
                <ChevronRight className="reasoning-row-chevron" aria-hidden="true" />
            </summary>
            <div className="reasoning-row-body analyzed-row-body">
                {children}
            </div>
        </details>
    );
};

export default React.memo(AnalyzedRow);
