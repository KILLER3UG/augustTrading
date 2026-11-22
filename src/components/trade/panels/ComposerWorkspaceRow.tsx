/**
 * ComposerWorkspaceRow — the composer's workspace sub-row: the panel-seat
 * chip, the bound bot and the live-packet clock. Extracted from TradeChatPanel;
 * every affordance stays owned by the dock (this row only reports the picker
 * toggle).
 *
 * The instrument read (BTC/USDT · 15m) died with ruling 1.3.1: it duplicated
 * the chart's hero line in Desk mode, and the reading column in Chat mode is
 * the conversation, not a second instrument banner. The row renders nothing
 * when none of its chips have content.
 */

import React from 'react';
import { PANEL_MAX_MODELS } from '../../../services/trade/chatSessions';

export interface ComposerWorkspaceRowProps {
    /** Kept in the props so the call site compiles untouched; the row no
     *  longer prints it. */
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
    /** Epoch-ms of the last live packet fetch. No longer PRINTED — the
     *  `ctx 06:15 PHT` readout was micro-clutter above the composer
     *  (2026-11-23); kept in the props so the packet-age instrumentation
     *  upstream stays wired. */
    contextAt: number | null;
}

const ComposerWorkspaceRow: React.FC<ComposerWorkspaceRowProps> = ({
    isPanel, panelCount, pickerOpen, onTogglePicker, botName,
}) => {
    if (!isPanel && botName === null) return null;
    return (
        <div className="flex shrink-0 items-center gap-2.5 px-1 pb-2 pt-1">
            {isPanel && (
                <button type="button" onClick={onTogglePicker}
                    aria-expanded={pickerOpen} title="Add / remove panel models (up to 5)"
                    className="rounded-full border border-hairline px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-wider text-zinc-400 transition-colors hover:border-line hover:text-zinc-100">
                    panel · {panelCount}/{PANEL_MAX_MODELS}
                </button>
            )}
            {botName !== null && (
                <span className="truncate rounded-full border border-hairline px-1.5 py-0.5 text-ui-2xs font-semibold text-zinc-400" title={botName}>{botName}</span>
            )}
        </div>
    );
};

export default ComposerWorkspaceRow;
