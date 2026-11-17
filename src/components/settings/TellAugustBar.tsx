/**
 * TellAugustBar — the Settings modal's inline prompt (the minimalist spec's
 * "Tell August what to change").
 *
 * The trader types a change request where they are; the text is handed to the
 * workspace's seat as a normal message, and the SEAT does the work through
 * the gated tools — a settings change arrives as a risk-change card, a memory
 * write as a memory pill, a strategy change as an activation card. The bar
 * itself holds no authority: it is a doorbell.
 *
 * Transport: a CustomEvent the mounted dock panel listens for (the same
 * pattern as the skill deep-link), so the Settings modal needs no prop chain
 * into the workspace. App closes the modal on submit so the trader sees the
 * answer being worked on.
 */

import React, { useState } from 'react';

export const AUGUST_ASK_EVENT = 'august:ask';

export const TellAugustBar: React.FC<{ onSent?: () => void; busy?: boolean }> = ({ onSent, busy = false }) => {
    const [draft, setDraft] = useState('');
    const submit = (): void => {
        const text = draft.trim();
        if (!text || busy) return;
        window.dispatchEvent(new CustomEvent(AUGUST_ASK_EVENT, { detail: { text } }));
        setDraft('');
        onSent?.();
    };
    return (
        <div
            className="flex shrink-0 items-center gap-2 border-t border-hairline bg-zinc-950/80 px-4 py-3"
            data-testid="tell-august-bar"
        >
            <input
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                placeholder="Tell August what to change"
                aria-label="Tell August what to change"
                maxLength={500}
                className="min-w-0 flex-1 rounded-control border border-hairline bg-white/[0.03] px-3 py-2 text-ui-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <button
                type="button"
                onClick={submit}
                disabled={!draft.trim() || busy}
                className="shrink-0 rounded-control bg-zinc-100 px-3 py-2 text-ui-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
                Ask
            </button>
        </div>
    );
};

export default TellAugustBar;
