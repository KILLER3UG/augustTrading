/**
 * streamCoalescerCore — pure frame-coalesced delta batcher for Desk & Chat SSE
 * streaming hot paths.
 *
 * Accumulates high-frequency `text` and `reasoning` updates and emits at most
 * once per scheduled frame (~16ms via `requestAnimationFrame` or injected
 * scheduler), with synchronous `flush()` on tool boundaries, card patches,
 * abort, error, and stream completion so zero characters are ever dropped or
 * delayed.
 *
 * Pure TypeScript: ZERO React, DOM, `window`, storage, or network imports
 * (`check:boundaries` enforces this).
 */

export interface CoalescedDeltaBatch {
    /** Present when text changed since the previous flush. */
    text?: string;
    /** Present when reasoning changed since the previous flush (accumulated delta when appended). */
    reasoningDelta?: string;
    /** Present when reasoning was replaced wholesale via `setReasoning`. */
    reasoningFull?: string;
}

export interface DeltaCoalescerOptions {
    /** Invoked at most once per scheduled frame (or synchronously via `flush()`). */
    onFlush: (batch: CoalescedDeltaBatch) => void;
    /** Injectable frame scheduler (defaults to `requestAnimationFrame` or 16ms timer). */
    schedule?: (cb: () => void) => number;
    /** Injectable canceler matching `schedule`. */
    cancel?: (handle: number) => void;
}

export interface DeltaCoalescer {
    /** Replace the latest visible text snapshot (coalesced to next frame). */
    setText(fullText: string): void;
    /** Append a visible text delta onto the pending snapshot (coalesced to next frame). */
    appendText(delta: string): void;
    /** Append a reasoning delta (coalesced into one string per frame). */
    appendReasoning(delta: string): void;
    /** Replace the latest full reasoning snapshot (coalesced to next frame). */
    setReasoning(fullReasoning: string): void;
    /** Synchronously emit any pending text/reasoning batch immediately. */
    flush(): void;
    /** Cancel any scheduled frame and drop buffered state. */
    cancel(): void;
    /** True when un-flushed deltas are waiting for the next frame. */
    hasPending(): boolean;
}

const defaultSchedule = (cb: () => void): number => {
    const g = globalThis as unknown as {
        requestAnimationFrame?: (fn: () => void) => number;
    };
    if (typeof g.requestAnimationFrame === 'function') {
        return g.requestAnimationFrame(cb);
    }
    return Number(setTimeout(cb, 16));
};

const defaultCancel = (handle: number): void => {
    const g = globalThis as unknown as {
        cancelAnimationFrame?: (id: number) => void;
    };
    if (typeof g.cancelAnimationFrame === 'function') {
        g.cancelAnimationFrame(handle);
        return;
    }
    clearTimeout(handle);
};

export const createDeltaCoalescer = (options: DeltaCoalescerOptions): DeltaCoalescer => {
    const schedule = options.schedule ?? defaultSchedule;
    const cancelFn = options.cancel ?? defaultCancel;

    let frameHandle: number | null = null;
    let hasText = false;
    let pendingText = '';
    let hasReasoningDelta = false;
    let pendingReasoningDelta = '';
    let hasReasoningFull = false;
    let pendingReasoningFull = '';

    const isDirty = (): boolean => hasText || hasReasoningDelta || hasReasoningFull;

    const emitNow = (): void => {
        if (!isDirty()) return;
        const batch: CoalescedDeltaBatch = {};
        if (hasText) {
            batch.text = pendingText;
            hasText = false;
        }
        if (hasReasoningFull) {
            batch.reasoningFull = pendingReasoningFull;
            hasReasoningFull = false;
            hasReasoningDelta = false;
            pendingReasoningDelta = '';
        } else if (hasReasoningDelta) {
            batch.reasoningDelta = pendingReasoningDelta;
            hasReasoningDelta = false;
            pendingReasoningDelta = '';
        }
        options.onFlush(batch);
    };

    const ensureScheduled = (): void => {
        if (frameHandle !== null) return;
        frameHandle = schedule(() => {
            frameHandle = null;
            emitNow();
        });
    };

    return {
        setText(fullText: string): void {
            pendingText = fullText;
            hasText = true;
            ensureScheduled();
        },
        appendText(delta: string): void {
            if (!delta) return;
            pendingText = hasText ? pendingText + delta : pendingText + delta;
            hasText = true;
            ensureScheduled();
        },
        appendReasoning(delta: string): void {
            if (!delta) return;
            if (hasReasoningFull) {
                pendingReasoningFull += delta;
            } else {
                pendingReasoningDelta += delta;
                hasReasoningDelta = true;
            }
            ensureScheduled();
        },
        setReasoning(fullReasoning: string): void {
            pendingReasoningFull = fullReasoning;
            hasReasoningFull = true;
            hasReasoningDelta = false;
            pendingReasoningDelta = '';
            ensureScheduled();
        },
        flush(): void {
            if (frameHandle !== null) {
                cancelFn(frameHandle);
                frameHandle = null;
            }
            emitNow();
        },
        cancel(): void {
            if (frameHandle !== null) {
                cancelFn(frameHandle);
                frameHandle = null;
            }
            hasText = false;
            hasReasoningDelta = false;
            pendingReasoningDelta = '';
            hasReasoningFull = false;
        },
        hasPending(): boolean {
            return isDirty();
        },
    };
};
