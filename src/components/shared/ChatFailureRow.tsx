/**
 * ChatFailureRow — a failed turn, drawn as a failure in BOTH conversation homes.
 *
 * The error text is the provider's own words (the status, the message and the
 * cause underneath), never a canned sentence and never written into the answer
 * field. The dock and the Agents surface render the same row so a failure cannot
 * be visible in one home and silently disappear in the other.
 */
import React from 'react';

export interface ChatFailureRowProps {
    /** The real failure text, as the transport reported it. */
    error: string;
}

const ChatFailureRow: React.FC<ChatFailureRowProps> = ({ error }) => (
    <div
        data-testid="chat-error-row"
        className="w-full max-w-full rounded-card border border-rose-500/20 bg-rose-500/[0.05] px-4 py-3 text-ui-sm leading-relaxed text-rose-200"
    >
        <span className="mb-1 block font-mono text-ui-2xs uppercase tracking-wider text-rose-400/80">
            request failed
        </span>
        {error}
    </div>
);

export default React.memo(ChatFailureRow);
