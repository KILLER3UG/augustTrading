import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, Lightbulb } from './Icons';
import { formatElapsed } from './elapsed';
import { thoughtForLabel } from './AnalyzedRow';
import { stripTraceMarkers } from '../../utils/traceText';
import { copyText } from '../../utils/clipboard';
import { subscribeSharedTicker } from '../../hooks/useSharedTicker';
import { useLetterReveal } from '../../hooks/useLetterReveal';
import Disclosure from './Disclosure';
import MarkdownContent from './MarkdownContent';

export interface ReasoningRowProps {
    /** Full thinking / chain-of-thought text. */
    thinking: string;
    /** Live stream in progress — shows the live duration. */
    running?: boolean;
    /** Reveal the trace whenever its containing work card is visible. Tool
     *  rounds use this so opening "Thought for Xs · N tools" shows the prose
     *  beside each tool, not another layer of collapsed labels. */
    defaultOpen?: boolean;
    /** A frozen work duration from the persisted run — what a reloaded row
     *  shows after the live clock is gone. */
    persistedMs?: number;
    /** Epoch-ms the turn started. Live and settled durations read this first,
     *  so a row remounted by a surface hop keeps counting from the real start
     *  instead of from its own mount. */
    startedAt?: number;
    /** Row label. */
    label?: string;
    /** Settled headline. A reasoning-only turn is the turn's whole receipt,
     *  so it uses the reference "Thought for 14s" (`thoughtForLabel`); a thought
     *  step inside a tool card keeps "Thinking complete". Live rows are
     *  unaffected — they always read "Thinking". */
    settledLabel?: 'thinking' | 'thoughtFor';
    className?: string;
    tokens?: number;
}

/**
 * Collapsible thinking row, built on a native `<details>`.
 *
 * The reference is one quiet line — a small bulb, “Thinking complete”, a muted
 * duration and a chevron — with the trace as a flat, muted, left-ruled block
 * underneath. No box, no fill, no second card: the answer is the primary
 * element and the trace is its receipt.
 *
 *  · RUNNING + collapsed = “Thinking” and a soft glyph pulse; no spinner, no
 *    scrolling trace. The trace never previews raw (models lean on `**`
 *    markdown; it must never leak into the transcript).
 *  · SETTLED + collapsed = “Thinking complete · 14s”; the frozen duration
 *    persists so the row still reads as a real step.
 *  · EXPANDED = the trace, muted at the small size, max-height 16rem with its
 *    own scroll, and a copy chip on hover/focus.
 *
 * The body stays in the DOM when collapsed (the caller may inspect it), and a
 * manual toggle always wins over the live state.
 */
const ReasoningRow: React.FC<ReasoningRowProps> = ({
    thinking,
    running = false,
    defaultOpen = false,
    persistedMs,
    startedAt,
    label = 'Thinking',
    settledLabel = 'thinking',
    className = '',
    tokens,
}) => {
    const [open, setOpen] = useState(running || defaultOpen);
    const [copied, setCopied] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const turnStartMs = typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null;
    const wasRunningRef = useRef(running);
    const startedAtRef = useRef<number | null>(turnStartMs ?? (running ? Date.now() : null));
    const [liveSeconds, setLiveSeconds] = useState<number | null>(
        running
            ? Math.max(0, Math.round((Date.now() - (turnStartMs ?? Date.now())) / 1000))
            : null,
    );
    const [settledSeconds, setSettledSeconds] = useState<number | null>(null);
    // The live body only follows the stream's bottom while the reader IS at
    // the bottom — scrolling up to re-read must win over the auto-follow.
    const bodyPinnedRef = useRef(true);
    const trimmed = thinking.trim();
    const revealSource = running ? thinking.trimStart() : trimmed;

    useEffect(() => {
        if (running && !wasRunningRef.current) {
            startedAtRef.current = turnStartMs ?? Date.now();
            bodyPinnedRef.current = true;
            if (!defaultOpen) setOpen(true);
        }
        if (wasRunningRef.current && !running) {
            const start = startedAtRef.current;
            setSettledSeconds(start !== null ? Math.max(0, Math.round((Date.now() - start) / 1000)) : null);
            startedAtRef.current = null;
            /* Standalone thoughts fold on settle. A thought inside a tool
               card stays revealed: the trader opened that card to read the
               work, and every received round belongs beside its tool. */
            if (!defaultOpen) setOpen(false);
        }
        wasRunningRef.current = running;
    }, [running, turnStartMs, defaultOpen]);

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

    // The trace is written letter by letter only while it is being WATCHED
    // (expanded and running); a collapsed row must not tick 60 times a second
    // for text nobody can see. Expanding shows the trace received so far and
    // types the rest.
    //
    // The reveal runs against the RAW trace, never the peeled one: the raw
    // stream is append-only, while stripTraceMarkers is not — a marker that
    // completes mid-stream (`*this*`, `## `, `---`) removes characters from
    // the middle of the peeled text, which the reveal would read as "a new
    // turn" and retype the trace from its first letter. The peel runs on the
    // revealed slice instead, so markers vanish as they complete and the
    // reveal index only ever moves forward.
    const rawReveal = useLetterReveal(revealSource, running && open);
    const visibleTrace = useMemo(() => stripTraceMarkers(rawReveal), [rawReveal]);

    useLayoutEffect(() => {
        if (!running || !open || !bodyPinnedRef.current) return;
        const body = bodyRef.current;
        if (body) body.scrollTop = body.scrollHeight;
    }, [visibleTrace, running, open]);

    if (!trimmed) return null;

    const frozenSeconds = typeof persistedMs === 'number'
        ? Math.max(0, Math.round(persistedMs / 1000))
        : null;
    const seconds = running ? liveSeconds : settledSeconds ?? frozenSeconds;
    // A reasoning-only turn IS the receipt: its settled headline is the same
    // "Thought for 14s" the card header prints. Use the ONE helper for the
    // phrase, and drop the separate "· 14s" meta so it is not printed twice.
    const thoughtSeconds = !running && settledLabel === 'thoughtFor' && label === 'Thinking'
        ? Math.max(1, typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds) : 1)
        : null;
    const meta = seconds !== null && thoughtSeconds === null ? formatElapsed(seconds) : null;
    // While running: "Thinking"; once settled: "Thinking complete", or the
    // reference "Thought for 14s" on a reasoning-only turn (custom labels win).
    const rowLabel = label !== 'Thinking'
        ? label
        : running
            ? 'Thinking'
            : thoughtSeconds !== null
                ? thoughtForLabel(thoughtSeconds)
                : 'Thinking complete';

    const onCopy = (): void => {
        void copyText(trimmed).then(ok => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        });
    };

    return (
        <Disclosure
            className={`thinking-row reasoning-row group/reasoning ${open ? 'is-open' : ''} ${className}`.trim()}
            summaryClassName="reasoning-row-summary"
            bodyClassName="reasoning-row-body thinking-row-body custom-scrollbar"
            testId="thinking-block"
            state={running ? 'running' : 'ok'}
            open={open}
            onToggle={setOpen}
            label={`${rowLabel}${meta ? `, ${meta}` : ''} — ${open ? 'collapse' : 'expand'}`}
            bodyRef={bodyRef}
            onBodyScroll={() => {
                const body = bodyRef.current;
                if (!body) return;
                bodyPinnedRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
            }}
            summary={(
                <>
                    <Lightbulb
                        className={`reasoning-row-glyph ${running ? 'animate-pulse motion-reduce:animate-none text-zinc-500' : ''}`}
                        aria-hidden="true"
                    />
                    <span className="reasoning-row-label">{rowLabel}</span>
                    {meta !== null && (
                        <span className="reasoning-row-meta" aria-label={`${meta} of thinking`}>
                            · {meta}
                        </span>
                    )}
                    {typeof tokens === 'number' && tokens > 0 && (
                        <span className="reasoning-row-meta hidden sm:inline">· {tokens.toLocaleString()} tokens</span>
                    )}
                    <ChevronRight className="reasoning-row-chevron" aria-hidden="true" />
                </>
            )}
        >
            <div className="relative pr-8">
                {running && open ? (
                    // While the trace is being WATCHED it types raw: a markdown
                    // re-parse per revealed letter is expensive and flickers,
                    // and the reveal caret belongs to plain text.
                    <div className={`whitespace-pre-wrap break-words text-ui-caption leading-[1.75] text-zinc-500 stream-typing`}>
                        {visibleTrace}
                    </div>
                ) : (
                    // Settled (or expanded-before-running) traces read as
                    // proper formatted text — paragraphs, lists, rules — the
                    // same pipeline the answer uses, at the trace's muted tone.
                    <MarkdownContent content={visibleTrace} className="text-ui-caption leading-[1.75] text-zinc-500 [&_hr]:border-zinc-800 [&_strong]:text-zinc-400 [&_a]:text-zinc-300" />
                )}
                <button
                    type="button"
                    onClick={onCopy}
                    aria-label={copied ? 'Thinking copied' : 'Copy thinking'}
                    title={copied ? 'Copied' : 'Copy thinking'}
                    className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 opacity-100 transition-opacity hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/reasoning:opacity-100"
                >
                    {copied ? <Check className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
            </div>
        </Disclosure>
    );
};

export default React.memo(ReasoningRow);
