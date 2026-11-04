/**
 * The tool set a DETACHED skill evaluation may call.
 *
 * The scheduled-automation feature is deleted (owner request, 2026-10-24), so
 * the skill evaluator is the one remaining unattended caller. Its job is to
 * judge a skill, not to act: it gets the Agents surface's read set minus every
 * tool that edits the trader's notebook and minus the two tools that change
 * the journal (present_trade draws/arms a watch; decline_trade records a skip).
 *
 * Derived from CHAT_SURFACE_TOOLS rather than restated, so a lookup added there
 * reaches the evaluator automatically. The deny list stays the one owner of
 * "not without a human".
 */
import { CHAT_SURFACE_TOOLS } from './chatSurfaceTurn';

export const UNATTENDED_DENY = [
    'write_memory_note', 'amend_memory', 'remember', 'forget',
    'propose_skill', 'revise_skill', 'propose_strategy', 'forge_tool',
    // A detached evaluator has no human to answer, and the question would park
    // the run for its whole window.
    'ask_user_input',
    // A detached evaluator may read the environment it judges; it must not
    // reshape the trader's goals.
    'create_goal', 'update_goal', 'restore_goal',
    // Nor reshape the harness it runs in. Reading the change ledger is allowed;
    // moving a knob or a prompt is not, in a run nobody is watching.
    'propose_self_change', 'revert_self_change',
    // A signal is a call on the trader's ledger; a detached skill evaluator
    // judges skills, it does not put calls on the record.
    'emit_signal',
    // Nor may a run nobody is watching change the coin the trader is
    // looking at. `find_best_setups` stays: ranking the market is a read.
    'switch_chart_symbol',
];

export const DETACHED_EVAL_TOOLS: string[] = CHAT_SURFACE_TOOLS.filter(
    tool => !UNATTENDED_DENY.includes(tool) && tool !== 'present_trade' && tool !== 'decline_trade',
);
