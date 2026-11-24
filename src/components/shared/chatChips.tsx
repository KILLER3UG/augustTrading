/**
 * The small row controls the Chart AI dock and the Agents surface both need. They
 * were module-local to `TradeChatPanel.tsx` only because there was one caller;
 * with two surfaces rendering the same transcript furniture, they live here so
 * the copy affordance and the row's visibility cannot drift.
 *
 * These chips are PERMANENTLY visible — the action row is always on, per the
 * reference. They used to be hover-released, which hid copy from anyone who did
 * not know to hunt for it; `group/msg` is gone from every caller, so a row does
 * not need a group class to make them appear.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brain, Check, Copy, Pin, RotateCcw } from './Icons';
import { copyText } from '../../utils/clipboard';
import MarkdownContent from './MarkdownContent';
import { effortChoiceOf } from './effortScale';
import { useLetterReveal } from '../../hooks/useLetterReveal';
import { getIdleMotionEnabled, subscribeIdleMotion } from '../../services/desk/idleMotion';
import { canRenderPlainStreamingProse, splitStableMarkdownBlocks } from '../../utils/streamBlocks';
import type { ReasoningEffort } from '../../types/provider';

/** Hover chip on USER bubbles: re-run the turn from this message — the
 *  stale answer(s) after it are dropped and the model regenerates with
 *  fresh live context. */
export const RetryChip: React.FC<{ onRetry: () => void; className?: string }> = ({ onRetry, className = '' }) => (
    <button type="button"
        onClick={onRetry}
        aria-label="Retry this message"
        title="Retry — regenerate the answer"
        className={`flex items-center hit-target rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${className}`.trim()}>
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
    </button>
);

export const CopyChip: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
    const [copied, setCopied] = useState(false);
    return (
        <button type="button"
            onClick={() => { void copyText(text).then(ok => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1400); } }); }}
            aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy this message'}
            className={`flex items-center hit-target rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${className}`.trim()}>
            {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
        </button>
    );
};

/** Pin this verdict to the Pinned list. Unlike the other chips it is the one
 *  whose state must stay legible: a pinned signal that hides its own pinned
 *  indicator would leave the Pinned list unexplainable. */
export const PinChip: React.FC<{ pinned: boolean; onToggle: () => void }> = ({ pinned, onToggle }) => (
    <button type="button"
        onClick={onToggle}
        aria-pressed={pinned}
        aria-label={pinned ? 'Unpin this signal' : 'Pin this signal'}
        title={pinned
            ? 'Pinned — tracked in the Pinned list (header tray). Click to remove.'
            : 'Pin this signal to the Pinned list. It tracks the setup; it does not arm a price trigger.'}
        className={`flex items-center gap-1 hit-target rounded-control px-1.5 py-0.5 text-ui-xs transition-colors hover:bg-white/[0.06] ${
            pinned ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
        }`}>
        <Pin className={`h-3 w-3 ${pinned ? 'fill-current' : ''}`} aria-hidden="true" />
    </button>
);

/** The thinking tier this answer was produced under.
 *
 *  A MUTED chip, not a control: the tier was decided when the turn was sent
 *  (the composer's dial, or the task's own schedule), and the row's job is to
 *  REPORT it, not to offer a second place to change it. It says the thing the
 *  answer's text cannot: this was produced at a different tier than the one
 *  next to it, and a cost compared across two answers means nothing without
 *  it.
 *
 *  The label comes from the ONE ladder (`effortScale.ts`), the same table the
 *  composer's panel and its trigger read — a chip that spelled the tier its
 *  own way would drift from the control that set it. */
export const ThinkingTierChip: React.FC<{ effort: ReasoningEffort; className?: string }> = ({ effort, className = '' }) => {
    const label = effortChoiceOf(effort).label;
    return (
        <span
            data-testid="thinking-tier-chip"
            title={`Thinking tier: ${label}`}
            aria-label={`Thinking tier: ${label}`}
            className={`flex items-center gap-1 rounded-control px-1.5 py-0.5 text-ui-2xs text-zinc-600 ${className}`.trim()}
        >
            <Brain className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{label}</span>
        </span>
    );
};

/** The streamed answer, progressively revealed with calm per-segment opacity fade-in.
 *
 *  `useLetterReveal` paces chunked provider bursts smoothly using a timer
 *  (never an rAF-only trap that stalls when backgrounded) and snaps to the full
 *  text immediately at settle, on tab hide, or when reduced motion is active.
 *
 *  While streaming, completed top-level markdown blocks keep stable keys so
 *  settled paragraphs never re-fade or re-parse, while only newly arrived segments
 *  in the growing block fade in via `.stream-token-fade` / `.stream-block-fade`.
 */
const PARSE_STEP = 8;
const PARSE_MAX_STALE_MS = 40;
const MAX_ACTIVE_FADE_SPANS = 8;

const prefersOsReducedMotion = (): boolean => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const FadingText: React.FC<{ text: string; streaming: boolean; className?: string }> = ({ text, streaming, className }) => {
    const [idleMotion, setIdleMotion] = useState<boolean>(getIdleMotionEnabled);
    useEffect(() => subscribeIdleMotion(setIdleMotion), []);
    const motionEnabled = idleMotion && !prefersOsReducedMotion();
    const visible = useLetterReveal(text, streaming);
    const typingRef = useRef<HTMLDivElement>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    // Bucketed markdown node for formatted growing active block; written during
    // render per the repo's derived-cache idiom (conventions.md).
    const parsedRef = useRef<{ blockIdx: number; len: number; at: number; node: React.ReactNode }>({ blockIdx: -1, len: -1, at: 0, node: null });
    // Incremental token slices for plain growing prose so only newly arrived
    // characters wear `.stream-token-fade` without re-fading settled prefix.
    const proseTrackRef = useRef<{
        blockIdx: number;
        totalLen: number;
        settledPrefix: string;
        segs: Array<{ id: number; text: string }>;
        seq: number;
    }>({ blockIdx: -1, totalLen: 0, settledPrefix: '', segs: [], seq: 0 });
    const mountedBlocksRef = useRef<Set<number>>(new Set());
    const prevVisibleLenRef = useRef(0);

    // Keep the transcript pinned while letters grow the answer. The check is a
    // live distance, not a flag: a reader who scrolled up stays where they are.
    useLayoutEffect(() => {
        if (!streaming) {
            scrollerRef.current = null;
            mountedBlocksRef.current.clear();
            prevVisibleLenRef.current = 0;
            return;
        }
        if (!scrollerRef.current) {
            let node: HTMLElement | null = typingRef.current?.parentElement ?? null;
            while (node && node !== document.body) {
                const overflowY = getComputedStyle(node).overflowY;
                if ((overflowY === 'auto' || overflowY === 'scroll')
                    && node.scrollHeight > node.clientHeight) {
                    scrollerRef.current = node;
                    break;
                }
                node = node.parentElement;
            }
        }
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (distance < 64) scroller.scrollTop = scroller.scrollHeight;
    }, [visible, streaming]);

    if (streaming && motionEnabled) {
        if (visible.length < prevVisibleLenRef.current) {
            mountedBlocksRef.current.clear();
        }
        prevVisibleLenRef.current = visible.length;
        const { committed, active } = splitStableMarkdownBlocks(visible);
        const activeIdx = committed.length;
        const mdClass = `!text-ui-base [&_p]:my-1 [&_li]:text-ui-base ${className ?? ''}`;

        let activeNode: React.ReactNode = null;
        if (active) {
            if (canRenderPlainStreamingProse(active)) {
                mountedBlocksRef.current.add(activeIdx);
                const track = proseTrackRef.current;
                const priorJoined = track.settledPrefix + track.segs.map(s => s.text).join('');
                if (track.blockIdx !== activeIdx || !active.startsWith(priorJoined)) {
                    track.blockIdx = activeIdx;
                    track.settledPrefix = '';
                    track.seq += 1;
                    track.segs = [{ id: track.seq, text: active }];
                    track.totalLen = active.length;
                } else if (active.length > track.totalLen) {
                    const added = active.slice(track.totalLen);
                    track.seq += 1;
                    track.segs = [...track.segs, { id: track.seq, text: added }];
                    if (track.segs.length > MAX_ACTIVE_FADE_SPANS) {
                        const overflow = track.segs.length - MAX_ACTIVE_FADE_SPANS;
                        track.settledPrefix += track.segs.slice(0, overflow).map(s => s.text).join('');
                        track.segs = track.segs.slice(overflow);
                    }
                    track.totalLen = active.length;
                }
                activeNode = (
                    <div key={`block-${activeIdx}`} className="my-1 whitespace-pre-wrap text-ui-base leading-relaxed text-zinc-200">
                        {track.settledPrefix}
                        {track.segs.map(seg => (
                            <span key={seg.id} className="stream-token-fade">{seg.text}</span>
                        ))}
                    </div>
                );
            } else {
                const isFirstMount = !mountedBlocksRef.current.has(activeIdx);
                mountedBlocksRef.current.add(activeIdx);
                const last = parsedRef.current;
                const now = Date.now();
                if (
                    last.blockIdx !== activeIdx
                    || last.len < 0
                    || active.length < last.len
                    || (active.length !== last.len && (active.length - last.len >= PARSE_STEP || now - last.at >= PARSE_MAX_STALE_MS))
                ) {
                    parsedRef.current = {
                        blockIdx: activeIdx,
                        len: active.length,
                        at: now,
                        node: <MarkdownContent content={active} className={mdClass} />,
                    };
                }
                activeNode = (
                    <div key={`block-${activeIdx}`} className={isFirstMount ? 'stream-block-fade' : undefined}>
                        {parsedRef.current.node}
                    </div>
                );
            }
        }

        const nodes: React.ReactNode[] = committed.map((block, i) => {
            const isFirstMount = !mountedBlocksRef.current.has(i);
            mountedBlocksRef.current.add(i);
            return (
                <div key={`block-${i}`} className={isFirstMount ? 'stream-block-fade' : undefined}>
                    <MarkdownContent content={block} className={mdClass} />
                </div>
            );
        });
        if (activeNode) nodes.push(activeNode);

        return (
            <div ref={typingRef} className={`text-ui-base leading-relaxed text-zinc-200 ${className ?? ''}`} data-streaming="true">
                {nodes}
            </div>
        );
    }

    return (
        <MarkdownContent content={text} className={`!text-ui-base [&_p]:my-1 [&_li]:text-ui-base ${className ?? ''}`} />
    );
};
