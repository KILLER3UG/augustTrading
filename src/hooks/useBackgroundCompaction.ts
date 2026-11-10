/**
 * useBackgroundCompaction — runs the 80% summarizer when the tab is idle.
 *
 * The whole point is that the trader never waits for it. So:
 *  · it is scheduled in `requestIdleCallback`, not in an effect that blocks a
 *    paint, and it skips entirely while a request is streaming (`busy`);
 *  · the model call happens once per conversation per usage level, deduped in
 *    `summarizeOnce`;
 *  · a failure is silent — the send path still compacts structurally, exactly
 *    as it did before this hook existed;
 *  · the digest is only ever stored, never shown, so a bad summary cannot
 *    interrupt the conversation. It is injected on the NEXT request instead.
 */

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../services/providers/GenericProviderService';
import {
    compactionUsage,
    shouldCompact,
    summarizeOnce,
} from '../services/trade/contextCompactionJob';

/** The one small-model call the job needs. Returns '' when nothing is ready —
 *  a session with no configured provider simply never gets a digest. */
export type CompactionComplete = (prompt: string) => Promise<string>;

export interface BackgroundCompactionOptions {
    /** Conversation the digest belongs to; also the dedupe key. */
    conversationId: string | null;
    messages: readonly ChatMessage[];
    windowTokens: number;
    /** True while a turn is streaming. Summarizing mid-turn would spend a
     *  second model call against the same provider for no benefit. */
    busy: boolean;
    /** Already-stored digest. A conversation that has one does not re-summarize
     *  until it has grown substantially past the trigger. */
    existingSummary?: string;
    complete: CompactionComplete | null;
    onSummary: (summary: string, conversationId: string) => void;
}

export const useBackgroundCompaction = (options: BackgroundCompactionOptions): void => {
    const { conversationId, messages, windowTokens, busy, complete, onSummary } = options;
    const existing = options.existingSummary ?? '';
    const lastRunTokens = useRef(0);

    useEffect(() => {
        if (!conversationId || busy || !complete) return;
        const usage = compactionUsage(messages, windowTokens);
        if (!shouldCompact(usage)) return;
        // Re-summarizing the same size buys nothing. Require the conversation to
        // have grown by another 10% of the window since the last digest.
        if (existing && usage.tokens - lastRunTokens.current < windowTokens * 0.1) return;

        let cancelled = false;
        const run = (): void => {
            if (cancelled) return;
            lastRunTokens.current = usage.tokens;
            void summarizeOnce(conversationId, { messages, windowTokens, complete })
                .then(result => {
                    // A summary that lands after the trader switched conversations
                    // must not be written onto the new one.
                    if (cancelled || !result) return;
                    onSummary(result.summary, conversationId);
                })
                .catch(() => { /* silent by contract */ });
        };

        type IdleDeadline = { timeRemaining: () => number };
        const ric = (window as unknown as {
            requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => number;
        }).requestIdleCallback;
        if (typeof ric === 'function') {
            const handle = ric(() => run(), { timeout: 4_000 });
            return () => {
                cancelled = true;
                const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
                if (typeof cancel === 'function') cancel(handle);
            };
        }
        // No idle API (Safari, jsdom): a timeout keeps the same promise that
        // this never runs inside a paint.
        const timer = window.setTimeout(run, 1_500);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [conversationId, messages, windowTokens, busy, complete, existing, onSummary]);
};
