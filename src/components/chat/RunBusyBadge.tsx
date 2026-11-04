import React, { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '../../services/trade/chatStore';
import { runStatusPresentation } from '../../utils/runStatus';

/**
 * RunBusyBadge — "this is still running".
 *
 * A run now survives a conversation switch (E-45: the run belongs to the
 * conversation it was typed in, and a switch moves the view). That makes a
 * state the app must be able to SHOW: a thread you are not looking at is
 * still thinking, and a thread that says nothing about it reads as a hang.
 *
 * WHY IT READS THE STORE: the runs live in `services/trade/chatStore.ts`'s
 * conversation-keyed registry, and the badge is rendered by components the App
 * does not thread props into. The store's snapshot is the only channel that
 * reaches them — the same reason the dock's own busy state lives there.
 *
 * WHY THE WORD AND THE COLOUR COME FROM ONE PLACE: `utils/runStatus.ts` is the
 * run-status vocabulary ("one colour+word per state"), and AGENTS.md is
 * explicit — *"Never hardcode a status colour in a component."* So the dot's
 * class is read out of the vocabulary, not typed here.
 *
 * The badge is DECORATIVE: it is `aria-hidden`, because the state must also
 * be in the host's accessible name (a dot a screen reader cannot read is not
 * an announcement). The host appends the sentence — see `ShellRail`, whose rail icons carry `NavBadge.detail`.
 */

export interface RunBusyBadgeProps {
    /** The conversation to report on. Omit it to report "is ANY conversation
     *  running" — the surface-level question. */
    conversationId?: string;
    className?: string;
    /**
     * The dot is decoration, so it is hidden from assistive tech — but the
     * STATE is not decoration, and a screen reader cannot read a hidden dot.
     * The host must put the sentence in its accessible name (the Chat row
     * does: "A conversation is still running"). This flag lets the host say
     * so at the point of use.
     */
    'aria-hidden'?: boolean | 'true' | 'false';
}

const anyRunning = (): boolean =>
    Object.keys(getSnapshot().conversationRunning).length > 0;

const RunBusyBadge: React.FC<RunBusyBadgeProps> = ({ conversationId, className = '', 'aria-hidden': ariaHidden = true }) => {
    // A boolean snapshot: React bails out of the re-render when nothing
    // changed, so the nav does not repaint on every streamed token.
    const running = useSyncExternalStore(
        subscribe,
        () => (conversationId ? Boolean(getSnapshot().conversationRunning[conversationId]) : anyRunning()),
    );

    if (!running) return null;

    const presentation = runStatusPresentation('running');
    return (
        <span
            aria-hidden={ariaHidden}
            data-testid="run-busy-badge"
            className={`inline-flex shrink-0 items-center ${className}`.trim()}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${presentation.dot} animate-pulse`} />
        </span>
    );
};

export default React.memo(RunBusyBadge);
