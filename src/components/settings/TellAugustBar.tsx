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
 * Transport: the dock owns the only composer and surfaces render exclusively,
 * so a broadcast alone can land on nothing (the same problem "Try in chat"
 * solved). The ask is therefore PARKED here as well as delivered —
 * `august:goto-workspace` closes Settings and mounts the workspace, the
 * delayed AUGUST_ASK_EVENT reaches the live dock, and `consumePendingAsk`
 * covers the mount race (a dock that mounts after the broadcast still
 * delivers the text exactly once).
 */

import React, { useState } from 'react';

export const AUGUST_ASK_EVENT = 'august:ask';

let pendingAsk: string | null = null;

/** Take (and clear) the ask a Settings submit parked for the next dock mount. */
export const consumePendingAsk = (): string | null => {
    const v = pendingAsk;
    pendingAsk = null;
    return v;
};

/** The park re-issue and the scheduled broadcast can BOTH reach a dock that
 *  mounted in between; the desk must read one ask once. A short-TTL receipt
 *  collapses the overlap (the two deliveries are ~400ms apart). */
let lastDeliveredAsk: { text: string; at: number } | null = null;
const ASK_DEDUPE_MS = 5_000;

export const isAskDelivered = (text: string): boolean =>
    !!lastDeliveredAsk && lastDeliveredAsk.text === text && (Date.now() - lastDeliveredAsk.at) < ASK_DEDUPE_MS;

export const markAskDelivered = (text: string): void => {
    lastDeliveredAsk = { text, at: Date.now() };
};

const deliverAsk = (text: string): void => {
    pendingAsk = text;
    // Switch the shell to the workspace first (App's goto-workspace handler
    // closes Settings with it), then hand the desk the text once the panel is
    // up. Same shape as utils/askDesk.
    window.dispatchEvent(new CustomEvent('august:goto-workspace'));
    window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(AUGUST_ASK_EVENT, { detail: { text } }));
    }, 400);
};

export const TellAugustBar: React.FC<{ onSent?: () => void; busy?: boolean }> = ({ onSent, busy = false }) => {
    const [draft, setDraft] = useState('');
    const submit = (): void => {
        const text = draft.trim();
        if (!text || busy) return;
        deliverAsk(text);
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
