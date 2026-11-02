/**
 * useLetterReveal — the fast typewriter for streamed text.
 *
 * The provider delivers chunks, not letters; a big chunk lands at once. This
 * reveals the text at a steady 3 characters per frame (faster when a burst
 * builds a backlog), so the reader sees it written without waiting for the
 * stream to finish.
 *
 * SAFETY RULES (the reason the old rAF prefix reveal was removed):
 *  · timer-based, not rAF: it still advances when the window is hidden;
 *  · `visibilitychange` snaps to the full text the moment the tab hides;
 *  · `active=false` returns the full text immediately at settle;
 *  · a remount with an existing long text starts at the end (no replay);
 *  · copy/action chips read the source text, never the revealed prefix.
 *
 * It intentionally reveals a STRING. The answer is rendered as plain text
 * while streaming and parsed as markdown once at settle — re-parsing markdown
 * on every letter would be the expensive, flickering version of this effect.
 */

import { useEffect, useRef, useState } from 'react';

const TICK_MS = 16;
const CHARS_PER_TICK = 3;
const BURST_BACKLOG = 240;
const BURST_CHARS_PER_TICK = 5;
/** A mount with more text than this is a surface hop mid-stream, not a first
 *  chunk: show it whole and type only what arrives next. */
const INSTANT_MOUNT_CHARS = 120;

const prefersReducedMotion = (): boolean => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const useLetterReveal = (text: string, active: boolean): string => {
    const reduced = prefersReducedMotion();
    const [revealed, setRevealed] = useState(
        active && text.length > INSTANT_MOUNT_CHARS ? text.length : 0,
    );
    const previous = useRef(text);

    useEffect(() => {
        const prior = previous.current;
        previous.current = text;
        if (!active) {
            setRevealed(text.length);
            return;
        }
        if (prior.length > 0 && !text.startsWith(prior)) {
            // A new turn/version — start this text from its first letter.
            setRevealed(0);
            return;
        }
        setRevealed(current => Math.min(current, text.length));
    }, [text, active]);

    useEffect(() => {
        if (!active) {
            setRevealed(text.length);
            return;
        }
        if (reduced) {
            setRevealed(text.length);
            return;
        }
        // A hidden tab must never leave the tail unrendered.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            setRevealed(text.length);
            return;
        }
        const timer = window.setInterval(() => {
            setRevealed(current => {
                const target = text.length;
                if (current >= target) return current;
                const pending = target - current;
                const step = pending > BURST_BACKLOG ? BURST_CHARS_PER_TICK : CHARS_PER_TICK;
                return Math.min(target, current + step);
            });
        }, TICK_MS);
        return () => window.clearInterval(timer);
    }, [text.length, active, reduced]);

    useEffect(() => {
        if (!active) return;
        const snapWhenHidden = (): void => {
            if (document.visibilityState === 'hidden') setRevealed(text.length);
        };
        document.addEventListener('visibilitychange', snapWhenHidden);
        return () => document.removeEventListener('visibilitychange', snapWhenHidden);
    }, [active, text.length]);

    if (reduced || !active) return text;
    // A replaced text must not flash its new body before the reset effect runs.
    const isAppend = text.startsWith(previous.current) || previous.current.length === 0;
    return isAppend ? text.slice(0, Math.min(revealed, text.length)) : '';
};
