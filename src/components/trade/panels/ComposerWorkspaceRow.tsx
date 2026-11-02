/**
 * ComposerWorkspaceRow — the composer's workspace header sub-row: the
 * instrument, the panel-seat count chip, the bound bot and the live-packet
 * clock. Extracted from TradeChatPanel unchanged; every affordance stays
 * owned by the dock (this row only reports the picker toggle).
 */

import React from 'react';
import { PANEL_MAX_MODELS } from '../../../services/trade/chatSessions';
import { display as symbolDisplay } from '../../../utils/symbol';
import { phtClock } from '../../../utils/timezone';

export interface ComposerWorkspaceRowProps {
    /** Raw instrument — the no-packet fallback reads it verbatim. */
    symbol: string;
    interval: string;
    isPanel: boolean;
    /** Seats this panel session currently holds. */
    panelCount: number;
    /** Is THIS session's seat editor open? */
    pickerOpen: boolean;
    onTogglePicker: () => void;
    /** Name of the roster bot bound to this session. `null` (not '') means no
     *  bound bot — the chip is gated on the bot existing, exactly as the dock
     *  gated it on the `boundBot` object, so a blank name still shows a chip. */
    botName: string | null;
    /** Epoch-ms of the last live packet fetched, or null for none yet. */
    contextAt: number | null;
}

const ComposerWorkspaceRow: React.FC<ComposerWorkspaceRowProps> = ({
    symbol, interval, isPanel, panelCount, pickerOpen, onTogglePicker, botName, contextAt,
}) => (
    <div className="flex shrink-0 items-center gap-2.5 px-1 pb-2.5 pt-1.5">
        <span className="truncate text-ui-sm font-semibold text-zinc-200" title={symbolDisplay(symbol)}>{symbolDisplay(symbol)}</span>
        {isPanel && (
            <button type="button" onClick={onTogglePicker}
                aria-expanded={pickerOpen} title="Add / remove panel models (up to 5)"
                className="rounded-full border border-white/10 px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-wider text-zinc-400 transition-colors hover:border-white/25 hover:text-zinc-100">
                panel · {panelCount}/{PANEL_MAX_MODELS}
            </button>
        )}
        {botName !== null && (
            <span className="truncate rounded-full border border-white/10 px-1.5 py-0.5 text-ui-2xs font-semibold text-zinc-400" title={botName}>{botName}</span>
        )}
        {/* The fallback names only the interval. Printing `${symbol} · ${interval}`
            here put the instrument on the row twice in two formats — the same
            duplication this row was written to remove. */}
        <span className="ml-auto shrink-0 font-mono text-ui-xs text-zinc-600" title={contextAt ? `Live packet fetched ${new Date(contextAt).toISOString()}` : 'No packet yet'}>
            {contextAt ? `ctx ${phtClock(contextAt)} PHT` : interval}
        </span>
    </div>
);

export default ComposerWorkspaceRow;
