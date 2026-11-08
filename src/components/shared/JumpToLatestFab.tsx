/**
 * JumpToLatestFab — the ONE control that returns the trader to the newest row.
 *
 * It exists because the two conversation homes had two different answers to
 * the same question, and one of them had none at all: the Agents surface grew a
 * "↓ Latest" pill when the palette's jump action was deleted, and the Chart AI
 * dock — the narrower surface, with the longer turns — never got one. A
 * trader reading up the dock's transcript had no way back to the answer that
 * was still arriving.
 *
 * So there is one control, and both homes mount it.
 *
 * Two states, one button:
 *
 *  - **A turn is running.** The control shows an INDETERMINATE ring — a
 *    spinning dashed circle, not a percentage. A desk turn has no denominator
 *    anyone could honestly draw: the model may call three tools or forty, and
 *    a ring that claimed "60% done" would be a number the app made up. The
 *    ring says "the desk is working" and nothing more, which is all it knows.
 *  - **The trader has scrolled away.** The control shows the arrow, and one
 *    click returns. The follow-the-bottom behaviour already refuses to fight a
 *    trader who scrolled up to read, so this is the way back — deliberately
 *    explicit, because a transcript that moves on its own is a transcript you
 *    cannot read.
 *
 * It is a FAB: circular, floating above the transcript's bottom edge and
 * centered like the reference's own jump control, out of the way until it has
 * something to say.
 */
import React from 'react';
import { ArrowDownIcon } from './Icons';

export interface JumpToLatestFabProps {
    /** Show the control. It appears when there is something below: a turn in
     *  flight, or a trader who has scrolled away from the newest row. */
    visible: boolean;
    /** A turn is in flight — the control shows the indeterminate ring. */
    running?: boolean;
    /** Return the trader to the newest row. */
    onJump: () => void;
    /** The accessible name. Defaults name the state, because the ring and the
     *  arrow are the same button and say different things. */
    label?: string;
}

/** How far the transcript may drift from its newest row before the surface
 *  stops following it. ONE number for both homes: a transcript that moves
 *  under a trader who is reading it cannot be read, and the control is the
 *  way back — so the two must agree, or one home would yank the reader down
 *  while the other offered a button. */
export const JUMP_AWAY_PX = 240;

const JumpToLatestFab: React.FC<JumpToLatestFabProps> = ({ visible, running, onJump, label }) => {
    if (!visible) return null;
    const name = label ?? (running ? 'Working — jump to the latest' : 'Jump to the latest');
    return (
        <button
            type="button"
            data-testid="jump-to-latest"
            data-state={running ? 'running' : 'idle'}
            onClick={onJump}
            aria-label={name}
            title={name}
            className="absolute bottom-3 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-zinc-800/95 text-zinc-200 shadow-elevated transition-colors duration-[120ms] ease-[var(--ease-snappy)] hover:bg-zinc-700 hover:text-zinc-100"
        >
            {running ? (
                // The INDETERMINATE ring: a dashed circle that turns. No
                // percentage, no denominator — a desk turn has no total to
                // count, and a ring that claimed one would be inventing it.
                <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin text-cyan-400" aria-hidden="true">
                    <circle
                        cx="12" cy="12" r="9"
                        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                        strokeDasharray="42 15"
                    />
                </svg>
            ) : (
                <ArrowDownIcon className="h-4 w-4" aria-hidden="true" />
            )}
        </button>
    );
};

export default JumpToLatestFab;
