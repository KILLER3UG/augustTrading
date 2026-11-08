import React from 'react';
import { Info, Pencil, RotateCcw } from './Icons';

/**
 * InterruptedRunNotice — the "Run stopped" card, shared by the Agents surface
 * row (ChatTranscriptRow) and the Chart AI dock list (ChatTranscriptList),
 * which used to carry two drifting copies of the same furniture.
 *
 * Rendered only with at least ONE handler: a "Run stopped" label with no
 * button beside it is a dead notice — it names a problem and offers no way
 * out, which is worse than saying nothing.
 *
 * The reference draws it as a CARD with the two ways out as raised chips on
 * the right — the same furniture it uses for a file it hands back. August
 * had a bare row of ghost buttons, which reads as a caption on the answer
 * rather than as the place the run stopped.
 */
export const InterruptedRunNotice: React.FC<{
    onEditPrompt?: () => void;
    onTryAgain?: () => void;
    /** WHY the run stopped, in the app's own words — the provider's mapped cause
     *  when a turn FAILED rather than being stopped by hand. Rendered as a line in
     *  the card, not as a second failure box under the prose: one mechanism says
     *  "this run did not finish", and it says it once, with the reason in it. */
    cause?: string;
}> = ({ onEditPrompt, onTryAgain, cause }) => {
    if (!onEditPrompt && !onTryAgain) return null;
    return (
        <div
            data-testid="interrupted-run-notice"
            className="mt-2 rounded-control border border-hairline bg-white/[0.02] px-3 py-2"
        >
            <div className="flex flex-wrap items-center gap-2">
                <Info className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                <span className="text-ui-xs text-zinc-400">Run stopped</span>
                <div className="ml-auto flex items-center gap-1.5">
                    {onEditPrompt && (
                        <button type="button"
                            onClick={onEditPrompt}
                            className="flex items-center hit-target gap-1 rounded-control border border-hairline bg-white/[0.04] px-2 py-1 text-ui-xs text-zinc-300 transition-colors hover:bg-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                            <span>Edit prompt</span>
                        </button>
                    )}
                    {onTryAgain && (
                        <button type="button"
                            onClick={onTryAgain}
                            className="flex items-center hit-target gap-1 rounded-control border border-hairline bg-white/[0.08] px-2 py-1 text-ui-xs font-medium text-zinc-100 transition-colors hover:bg-white/[0.12] focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            <span>Try again</span>
                        </button>
                    )}
                </div>
            </div>
            {cause && (
                <p className="mt-1.5 pl-5 text-ui-dense leading-relaxed text-rose-300/90" data-testid="interrupted-run-cause">
                    {cause}
                </p>
            )}
        </div>
    );
};
