/**
 * statsCard — the verified tool output rendered as a CARD, not prose (P-5).
 *
 * The audit's finding: `get_setup_history_stats`, `playbook_attribution` and
 * `get_trade_log` were reachable and returned the right payloads, but nothing
 * RENDERED them — the only way the numbers reached the trader was the model
 * restating them in prose, which is exactly what the P-5 row forbids ("the
 * model never writes them in prose"). This module turns a stats receipt into
 * a render snapshot: the numbers are the TOOL OUTPUT verbatim, the card is a
 * viewer, and a mismatch between card and tool is impossible because the card
 * holds the receipt's own fields.
 *
 * The three stats tools are READS — no authority, no confirmation, no revert
 * window. The snapshot is runtime-only (like the decision-card fields): a
 * reload drops the card, the transcript answer remains, and the one-tap way
 * to the numbers stays the Journal's stats tab.
 */

/** Which receipt this snapshot renders. */
export type StatsTool = 'get_setup_history_stats' | 'playbook_attribution' | 'get_trade_log';

const STATS_TOOLS: readonly StatsTool[] = ['get_setup_history_stats', 'playbook_attribution', 'get_trade_log'];

export interface StatsCardSnapshot {
    tool: StatsTool;
    /** The payload starts after the untrusted fence's `### TOOL RESULT`
     *  marker; kept raw-capped so the card renders the receipt VERBATIM —
     *  a mismatch between card and tool output is impossible by
     *  construction, because the card holds the receipt's own fields. */
    payload: Record<string, unknown>;
}

export type StatsCardCheck =
    | { ok: true; snapshot: StatsCardSnapshot }
    | { ok: false; refused: string };

/** Pure: turn a tool receipt into a render snapshot. Exported for the
 *  contract check — the failure this pins is a card that recomputes or
 *  invents a number instead of carrying the tool's own. */
export const statsCardFromReceipt = (tool: string, content: string): StatsCardCheck => {
    if (!(STATS_TOOLS as readonly string[]).includes(tool)) {
        return { ok: false, refused: 'not a stats tool' };
    }
    // The receipt rides the untrusted fence; the payload starts after the
    // `### TOOL RESULT: <tool> (ok)` line and ends before the END fence.
    const marker = content.indexOf('### TOOL RESULT:');
    const endFence = content.indexOf('<<<AUGUST-UNTRUSTED END');
    const inner = marker >= 0
        ? content.slice(marker, endFence > marker ? endFence : undefined).split('\n').slice(1).join('\n')
        : content;
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(inner) as Record<string, unknown>;
    } catch {
        return { ok: false, refused: 'stats receipt was not JSON — the card renders tool output, never prose' };
    }
    if (tool === 'get_setup_history_stats' && typeof payload.winRate !== 'number' && typeof payload.sample !== 'number') {
        return { ok: false, refused: 'stats receipt missing winRate and sample' };
    }
    return { ok: true, snapshot: { tool: tool as StatsTool, payload } };
};
