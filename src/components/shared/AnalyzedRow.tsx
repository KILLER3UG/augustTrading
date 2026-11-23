import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from './Icons';
import { formatElapsed } from './elapsed';
import { subscribeSharedTicker } from '../../hooks/useSharedTicker';

/**
 * The one spelling of the reference work headline — "Thought for 14s".
 * Both the card header (`AnalyzedRow`) and the 0-tool reasoning row
 * (`ReasoningRow`) print this exact phrase, so it lives here once.
 */
export const thoughtForLabel = (seconds: number): string => `Thought for ${formatElapsed(seconds)}`;

export interface AnalyzedRowProps {
    /** The turn is still working (streaming, no answer text yet) — the
     *  timeline stays OPEN live and the duration ticks. */
    running?: boolean;
    className?: string;
    /** The settled header's tool count — "4 tools". Omitted when the turn
     *  called no tool. */
    summary?: string | null;
    /** The turn's frozen work time in ms, persisted at settle. Used ONLY when
     *  the clock is not ticking: precedence is live tick > this > nothing.
     *  A reloaded turn has no live clock, so this is what keeps its
     *  duration on screen. */
    persistedMs?: number;
    /** Epoch-ms the turn started. The live clock and the frozen settle both
     *  read it, so a remount from a surface hop does not restart the count. */
    startedAt?: number;
    /** What the turn is doing RIGHT NOW — "Reading the order book". This is
     *  the RUNNING label, and it replaces the bare "Analyzing": a state says
     *  the desk is busy, an activity says what it is busy with. Derived from
     *  the turn's own tool lines (`utils/turnStatus.ts`), so it can only
     *  report what the tools did. Absent ⇒ the bare "Analyzing". */
    activity?: string | null;
    children: React.ReactNode;
}

/**
 * "Thought for 14s · 4 tools" — the flat turn header over the work log. The
 * header says how long the seat thought and how many tools it ran; the body
 * lists the steps, and EACH STEP is its own disclosure (a Thought row, a tool
 * round).
 *
 * The log is OPEN while the turn runs — the live steps are where the eye
 * already is — and it FOLDS ITSELF SHUT the moment the answer begins to
 * settle, so the final answer owns the reading space (2026-11-23 polish
 * ruling; the old behaviour kept every step on screen forever). The chevron
 * still reopens the whole log for anyone who wants the receipt.
 *
 * The clock covers the pre-answer work phase only — it starts at turn start and
 * freezes when the answer text begins.
 */
const AnalyzedRow: React.FC<AnalyzedRowProps> = ({ running = false, className = '', summary, persistedMs, startedAt, activity, children }) => {
    // Open while the work is live; a row that mounts already settled (a
    // reloaded conversation) starts folded.
    const [open, setOpen] = useState(running);
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
            // Settling folds the log: the answer owns the reading space now,
            // and the steps stay one chevron away.
            setOpen(false);
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
    // line; settled = the FLAT turn header — "Thought for 14s · 4 tools" —
    // under which the folded log reopens. The count is CALLS, never transcript
    // lines (the desk writes two lines per call).
    const workSummary = (summary ?? '').trim();
    const ranTools = workSummary.length > 0;
    // The RUNNING label is the ACTIVITY, not the state: "Reading the order
    // book" says what the desk is doing, "Analyzing" only says it is busy.
    const runningActivity = (activity ?? '').trim();
    const label = running
        ? (runningActivity || 'Analyzing')
        : seconds !== null
            ? thoughtForLabel(Math.max(1, seconds))
            : 'Thought';
    const detail = running
        ? (seconds !== null ? (runningActivity ? ` · ${formatElapsed(seconds)}` : ` for ${formatElapsed(seconds)}`) : '')
        : ranTools ? ` · ${workSummary}` : '';

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
                            <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-zinc-500/80 motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms` }} />
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
