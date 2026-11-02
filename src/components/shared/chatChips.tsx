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
import React, { useEffect, useState } from 'react';
import { Brain, Check, ChevronLeftIcon, ChevronRight, Copy, Pencil, Pin, RotateCcw, Square, Undo2, Volume2 } from './Icons';
import { copyText } from '../../utils/clipboard';
import MarkdownContent from './MarkdownContent';
import { effortChoiceOf } from './effortScale';
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

/** Edit a prompt the trader already sent.
 *
 *  Not a cosmetic rewrite: the host keeps the words being replaced as a version
 *  of that row, parks the answer that grew from them, and re-runs the question.
 *  The title says so because "Edit" alone does not tell you that the earlier
 *  exchange survives the click — which is the whole point of the design. */
export const EditChip: React.FC<{
    onEdit: () => void;
    /** This row has been edited before, so the control is a re-edit rather than
     *  a first one. Changes the label, not the behaviour. */
    edited?: boolean;
    className?: string;
}> = ({ onEdit, edited = false, className = '' }) => (
    <button type="button"
        onClick={onEdit}
        aria-label={edited ? 'Edit this message again' : 'Edit this message'}
        title={edited ? 'Edit again — your earlier wording is kept as a version' : 'Edit — keeps your wording as a version and re-answers'}
        className={`flex items-center gap-1 hit-target rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${className}`.trim()}>
        <Pencil className="h-3 w-3" aria-hidden="true" />
    </button>
);

/** Take the thread back to this message.
 *
 *  The turns after it are PARKED, not deleted, and the row under the thread
 *  offers to bring them back — so this is reversible in both directions and the
 *  label says "restore" rather than "delete", which is the thing it is not.
 *  It changes the transcript only: memory, skills, logged trades and watches a
 *  parked turn produced stay exactly as they were. */
export const RevertChip: React.FC<{
    onRevert: () => void;
    /** How many turns would be parked. Zero means this is already the last
     *  turn, and a control that restores nothing is not drawn at all. */
    after: number;
    className?: string;
}> = ({ onRevert, after, className = '' }) => {
    if (after <= 0) return null;
    return (
        <button type="button"
            onClick={onRevert}
            aria-label={`Restore the thread to this message`}
            title={`Restore to here — parks the ${after} newer turn${after === 1 ? '' : 's'} so you can bring them back`}
            className={`flex items-center gap-1 hit-target rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${className}`.trim()}>
            <Undo2 className="h-3 w-3" aria-hidden="true" />
            <span>Restore to here</span>
        </button>
    );
};

/** Step the answer shown between the versions this row holds.
 *
 *  Only drawn when the row actually has more than one version — a "1 of 1"
 *  stepper advertises a choice the app does not have. Pressing either end
 *  WRAPS, so one key walks the whole set. */
export const VersionStepper: React.FC<{
    index: number;
    total: number;
    onStep: (delta: number) => void;
    className?: string;
}> = ({ index, total, onStep, className = '' }) => {
    if (total <= 1) return null;
    return (
        <span className={`flex items-center gap-0.5 ${className}`.trim()} data-testid="version-stepper">
            <button type="button"
                onClick={() => onStep(-1)}
                aria-label="Previous version of this answer"
                title="Previous version"
                className="flex h-5 w-5 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                <ChevronLeftIcon className="h-3 w-3" aria-hidden="true" />
            </button>
            <span className="text-ui-xs tabular-nums text-zinc-500" aria-live="polite">
                {index + 1} / {total}
            </span>
            <button type="button"
                onClick={() => onStep(1)}
                aria-label="Next version of this answer"
                title="Next version"
                className="flex h-5 w-5 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
        </span>
    );
};

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

/** Read this answer aloud.
 *
 *  A NEW capability, not chrome: `window.speechSynthesis` returns zero matches
 *  repo-wide before this, so nothing here existed to reuse. Toggle to stop —
 *  pressing the same control again cancels the utterance — and the utterance is
 *  cancelled on unmount so navigating away mid-sentence cannot leave a voice
 *  reading a row the user is no longer looking at.
 *
 *  Where the API is absent (and in tests) the control is NOT drawn. A button
 *  that silently does nothing is exactly the dead control this project rejects;
 *  the caller renders nothing instead, which is honest. */
export const SpeakChip: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
    const [speaking, setSpeaking] = useState(false);
    const available = typeof window !== 'undefined'
        && 'speechSynthesis' in window
        && typeof SpeechSynthesisUtterance !== 'undefined';
    useEffect(() => {
        if (!available) return undefined;
        const stop = (): void => setSpeaking(false);
        window.speechSynthesis.addEventListener('end', stop);
        window.speechSynthesis.addEventListener('error', stop);
        return () => {
            window.speechSynthesis.removeEventListener('end', stop);
            window.speechSynthesis.removeEventListener('error', stop);
            // Release the utterance on unmount rather than leaving it queued.
            window.speechSynthesis.cancel();
        };
    }, [available]);

    if (!available) return null;

    const toggle = (): void => {
        if (speaking) {
            window.speechSynthesis.cancel();
            setSpeaking(false);
            return;
        }
        // `speechSynthesis` existing does NOT imply the utterance constructor
        // exists — jsdom has the object and not the class, and some embedded
        // WebViews are the same shape. Without this guard the click throws and
        // takes the row's action handler with it.
        if (typeof SpeechSynthesisUtterance === 'undefined') return;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => setSpeaking(false);
        utterance.onerror = () => setSpeaking(false);
        window.speechSynthesis.speak(utterance);
        setSpeaking(true);
    };

    return (
        <button type="button"
            onClick={toggle}
            aria-label={speaking ? 'Stop reading aloud' : 'Read this answer aloud'}
            title={speaking ? 'Stop reading aloud' : 'Read this answer aloud'}
            className={`flex items-center hit-target rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${speaking ? 'text-emerald-300' : ''} ${className}`.trim()}>
            {speaking ? <Square className="h-3 w-3" aria-hidden="true" /> : <Volume2 className="h-3 w-3" aria-hidden="true" />}
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

/** Every character the store holds, every render. The reveal used to be a
 *  requestAnimationFrame-driven prefix of the text, which silently withheld
 *  content: measured on a 4,800-char answer, only 1,728 characters were in the
 *  DOM while the window was hidden (rAF fired 0 times in 400ms). The tail was
 *  unrendered and therefore unscrollable, while the Copy chip — handed the
 *  full string — revealed that the model had answered completely. The chunks
 *  arriving from the provider already give the typewriter feel; the fade here
 *  is CSS-only and can never eat text. */
export const FadingText: React.FC<{ text: string; streaming: boolean; className?: string }> = ({ text, streaming, className }) => (
    <div className={streaming ? 'stream-fade' : undefined}>
        {/* The caller's class is ADDED to the base rules, not swapped for
            them: a caller that says "this answer carries the reading role"
            must not lose the size and the paragraph rhythm every answer
            shares. */}
        <MarkdownContent content={text} className={`!text-ui-base [&_p]:my-1 [&_li]:text-ui-base ${className ?? ''}`} />
    </div>
);
