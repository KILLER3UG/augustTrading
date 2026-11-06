/**
 * chatSurfaceTurn — ONE Chat-surface turn against the desk-tool transport.
 *
 * The Agents surface answered with `streamQuickResponse`: one request, no tools.
 * So a question about the current price was answered out of the model's
 * training data while the Chart AI dock, asked the same question, looked it up.
 * Stage 20's premise is that a seat finds things out by CALLING, so both homes
 * now run the same executor (`services/trade/toolTurn`). What differs is the
 * ROW: the dock writes a `chatStore` `LiveEntry`, the Agents surface writes a
 * canonical `Message` — the record the rail, the Journal and the learning loop
 * read. The sink below is that difference and nothing else.
 *
 * Tools are the canvas-free half of the dock's set plus `present_trade`: market
 * lookups, indicator studies, the journal, past sessions, the notebook, skills,
 * search, the screener, and a plan the trader can log. The other seven
 * `CHART_ACTION_TOOL_DEFS` (draw / draw_detected / mark_trade_levels /
 * clear_chart_drawings / watch_price / wake_me / cancel_watch) are NOT offered
 * here, and that is not a shortcut: `streamChatWithDeskTools` lists a
 * chart-action definition only when the caller dispatches it AND the seat's own
 * allow-list names it, and this surface has no canvas to draw on and no chart to
 * arm a level-watch against. Offering a tool the executor would have to refuse
 * is the dead-affordance bug moved one layer down into the prompt.
 *
 * BOTS ARE NOT HERE. A bot-bound thread in this surface keeps
 * `streamQuickResponse` (stage 20 owner ruling): the roster answers with its
 * persona and its own memory, and `useBotMailbox` / `groupRounds`
 * are deliberately not moved onto the tool turn.
 */

import type { LoggedTrade } from '../../types';
import type { Message } from '../../types/message';
import type { ProviderConfig } from '../../types/provider';
import type { ChatMessage } from '../providers/GenericProviderService';
import { MessageRole } from '../../types';
import { CASUAL_CHAT_SYSTEM_PROMPT, CHAT_SURFACE_SYSTEM_PROMPT } from '../../constants/prompts/chatPrompts';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { resolveComposerEffort, type ReasoningEffort } from '../providers/reasoningControls';
import { buildSkillsIndexForPrompt } from './tradeChatContext';
import { skillIndexRows } from '../learning/SkillFileService';
import { getMemoryFiles } from '../learning/MemoryFilesService';
import { buildNotebookTopicsIndex } from '../learning/memoryTopics';
import { buildLearningRulesIndex } from '../../utils/learningRulesIndex';
import { storageService } from '../infrastructure/StorageService';
import { indexBudgetFor } from '../../utils/promptIndexBudget';
import { activeStrategiesBlock } from '../learning/strategyStore';
import { buildProfileMemoryIndex } from '../learning/profileMemory';
import { buildGoalsIndex, focusedGoal, goalMatchesMessage, listGoals } from '../goals/GoalService';
import { runToolTurn, type ToolTurnEvents, type ToolTurnOutcome, type ToolTurnRequest } from './toolTurn';
import { isMarketReadTool } from '../analysis/deskToolShared';
import { runPresentTrade } from './presentTradeTool';
import { userContentWithImage } from './chatTurnRunner';
import { saveToolPayload } from './toolPayloadStore';
import { appendToolActions } from '../../utils/toolActions';
import { recordToolTurnUsage } from '../../utils/sessionUsage';
import { truncationNotice, withTruncationWindow } from '../../utils/finishReason';

/** The desk tools a Chat-surface seat may call. Everything here answers from
 *  the exchange, the journal, the notebook or the web — none of it needs the
 *  chart the trader is looking at, which is exactly what this surface lacks.
 *  Also enforced at execution (`executeDeskTool`'s allow-list), so a
 *  text-protocol seat that invents a `draw_on_chart` tag is refused, not
 *  silently answered by something that has no canvas to draw on. */
export const CHAT_SURFACE_TOOLS = [
    // Market tape — the reason this surface needed a tool turn at all.
    'get_price_snapshot', 'get_order_book', 'get_derivatives',
    'get_liquidations', 'get_session_context', 'get_market_packet', 'get_all_timeframes',
    'get_btc_context', 'get_indicators', 'project_future_price',
    // The P0 market-structure family (docs/plans/tools-upgrade.md): the desk
    // reads computed levels/flow/regime instead of estimating them.
    'get_key_levels', 'volume_profile', 'naked_pocs', 'vwap', 'order_flow',
    'effort_vs_result', 'auction_state', 'get_regime', 'trade_math',
    // The P1 family — read-only here: `draw_tool_levels` stays dock-only (no
    // canvas on this surface, and its receipt would have to promise one).
    'swing_structure', 'liquidity', 'imbalances', 'sr_zones', 'wyckoff_events',
    'setup_base_rate', 'risk_state',
    // The P2 composites: derivatives positioning + cross-market, plus the
    // family-H playbook scan and the advisory meta-label read.
    'derivatives_state', 'btc_relative', 'scan_playbooks', 'meta_label',
    // The trader's own history, as rows and as past sessions.
    'get_trade_log', 'recall', 'get_setup_history_stats', 'recall_chat',
    // Market-wide discovery and simulation.
    'web_search', 'scan_setups', 'run_screener', 'run_monte_carlo',
    // The ranked shortlist and the chart switch are session-wide, not
    // canvas-bound: a Chat-surface seat can find the best setups and put
    // one on the trader's chart without owning a live plot. Both are
    // registered in DESK_TOOL_NAMES, so the executor accepts them here.
    'find_best_setups', 'switch_chart_symbol',
    // The seat edits its own memory, skills and tools from here — the same
    // growth set the dock has, since neither half of it needs a canvas.
    // `skill_view` belongs here too: the skills index and the base prompt both
    // tell the seat to open a matched skill's full body BEFORE acting, and
    // this surface's tool list never carried it — the one call its own
    // instructions demanded was the one call the executor refused (the dead
    // affordance this file exists to prevent).
    'skill_view', 'skill_index', 'skill_write', 'write_memory_note', 'get_notebook_map', 'propose_strategy',
    'amend_memory', 'forge_tool',
    'remember', 'read_memory', 'forget',
    // The one tool with a human in it: it suspends the turn until the trader
    // answers (services/analysis/askUserInput.ts).
    'ask_user_input',
    // Goal environments — durable work state the agent can shape mid-task.
    'list_goals', 'open_goal', 'create_goal', 'update_goal', 'restore_goal',
    // The harness's own change ledger. Reading it is always available; the two
    // writes are refused by the service unless the trader enabled
    // self-modification, and by UNATTENDED_DENY for any detached run.
    'list_self_changes', 'propose_self_change', 'revert_self_change',
    // The verdict IS a tool call in the post-debate app (stage 20's premise), so
    // the desk must be able to present a plan wherever the trader asks. The
    // shared executor draws nothing and arms no watch for this sink — and says
    // so in the receipt rather than promising a [HARNESS SIGNAL] that cannot come.
    'present_trade',
    // A skip is a decision; the Agents surface must be able to leave the HOLD
    // record it was told to consider.
    'decline_trade',
    // The signal ledger is the desk's own call record; the Agents home grades
    // its reads the same way the chart dock does.
    'emit_signal',
    // Anything that can be clipped must be able to be re-read.
    'read_tool_output',
];

/** What travelled in one turn's system prompt: the text, and the skill slugs it
 *  was built from. The slugs come back WITH the text on purpose — a caller that
 *  records "which skills did this turn see" must not be able to disagree with the
 *  prompt it just sent, which is what two separate reads of the library invite. */
export interface ChatSurfacePrompt {
    text: string;
    skills: string[];
}

/** The window the index prints, and the list recorded, are the same window: a
 *  slug truncated out of the prompt is not a skill this turn had. */

/**
 * Assemble a surface mandate with the trader's notebook under it: surface
 * mandate + skills index + active strategy plans + the profile memory index, each
 * read FRESH per turn so a `remember` or a skill the model just wrote lands in
 * the NEXT turn's prompt instead of waiting for a reload.
 *
 * `where` phrases the skills heading, because the surfaces ask the same question
 * about different subjects: the Agents surface matches a skill to "what the
 * trader asks about", the chart dock to "this chart".
 *
 * Every block is guarded separately. An unreadable notebook must not cost the
 * trader their answer: the prompt simply carries less, the same way the dock's
 * `skillsIndexForPrompt` swallows and returns ''.
 */
export const surfacePromptWith = (mandate: string, where: string, opts: { memoryEnabled?: boolean; strategiesEnabled?: boolean; windowTokens?: number; matchText?: string } = {}): ChatSurfacePrompt => {
    const memoryEnabled = opts.memoryEnabled !== false;
    const budget = indexBudgetFor(opts.windowTokens ?? 200_000);
    let skillsBlock: string;
    let skills: string[];
    try {
        const rows = skillIndexRows();
        // The SAME ranked list the prompt carries, so the row's `injectedSkills`
        // names exactly the skills the model was shown. Ranking it twice (here
        // and inside the builder) is idempotent — the sort is stable.
        skills = rows.slice(0, budget.skills).map(r => r.slug);
        skillsBlock = buildSkillsIndexForPrompt(rows, budget.skills, where);
    } catch {
        skills = [];
        skillsBlock = '';
    }
    // Listing-first notebook recall: one line per topic, bodies on demand.
    // Same failure posture as the skills block — a read that cannot happen
    // costs the block, never the turn.
    let topicsBlock: string;
    try {
        const store = getMemoryFiles();
        topicsBlock = memoryEnabled ? buildNotebookTopicsIndex(store.files, store.folders, budget.topics) : '';
    } catch {
        topicsBlock = '';
    }
    let strategiesBlock: string;
    try {
        // Plans AND uploaded books, behind the trader's one switch — see
        // `activeStrategiesBlock`. Opt-out, so a caller that never threads the
        // flag keeps the section exactly as it does today.
        strategiesBlock = activeStrategiesBlock(3, { enabled: opts.strategiesEnabled });
    } catch {
        strategiesBlock = '';
    }
    let rulesBlock: string;
    try {
        // The learned rules finally have a reader: they were written at boot,
        // mirrored into the profile and swept by backups while no prompt ever
        // saw them (the 2026-10-27 audit M-5). Memory content, so the toggle gates it.
        if (memoryEnabled) {
            // Synchronous read: this prompt builder is sync, and the store is
            // localStorage-backed.
            rulesBlock = buildLearningRulesIndex(storageService.loadLearningRules().rules, Math.min(6, budget.skills));
        } else {
            rulesBlock = '';
        }
    } catch {
        rulesBlock = '';
    }
    let memoryBlock: string;
    try {
        // The Settings toggle is a PROMISE: memory off means no memory block —
        // profile, topics, all of it. The analysis pipeline honoured this; the
        // chat path read the store anyway until 2026-10-24.
        memoryBlock = memoryEnabled ? buildProfileMemoryIndex(undefined, budget.memory) : '';
    } catch {
        memoryBlock = '';
    }
    // The goal is the work environment, not memory; it rides even with memory
    // off. One compact line per goal, the focused one first.
    let goalsBlock: string;
    try {
        goalsBlock = buildGoalsIndex(budget.goals);
    } catch {
        goalsBlock = '';
    }
    // A goal's `message` trigger is something the seat RESPONDS TO, not a label
    // it reads. Deterministic substring match against the trader's own line —
    // no extra call, no model judgement — and it changes NOTHING by itself: it
    // names the goal and stops there. An unattended run passes no `matchText`,
    // because a web page or a tool output must never be what points the seat at
    // an environment.
    if (opts.matchText) {
        try {
            const hit = listGoals()
                .filter(g => !g.focused && g.status === 'active' && goalMatchesMessage(g, opts.matchText as string))
                .slice(0, 2);
            if (hit.length > 0) {
                goalsBlock = [goalsBlock, `A goal's trigger matches this message: ${hit.map(g => `"${g.title}" (${g.slug})`).join(', ')} — read it with open_goal, and make it the environment only if the trader asks.`]
                    .filter(Boolean).join('\n\n');
            }
        } catch {
            /* an unreadable goal store costs the hint, never the answer */
        }
    }
    return {
        text: [mandate, goalsBlock, skillsBlock, rulesBlock, topicsBlock, strategiesBlock, memoryBlock].filter(Boolean).join('\n\n'),
        skills,
    };
};

/**
 * The Agents surface's own system prompt (stage 20s), assembled the way the dock
 * assembles its seat prompt, with one difference this surface has to honour: the
 * skills heading says "what the trader asks about", because there is no chart
 * here to match against, and the mandate forbids the tool calls the canvas owns.
 */
export const chatSurfaceSystemPrompt = (opts: { memoryEnabled?: boolean; strategiesEnabled?: boolean; windowTokens?: number; matchText?: string } = {}): ChatSurfacePrompt =>
    surfacePromptWith(CHAT_SURFACE_SYSTEM_PROMPT, 'what the trader asks about', opts);

/** The speaker key for this surface's live tool feed — `chatRowFrom` flattens
 *  `liveToolEvents` for the Chat row and `liveEntryFromMessage` does the same
 *  for the dock's projection of this row, so one key serves both homes. */
const DESK_SPEAKER = 'desk';

/** Rolling cap on the live tool feed, matching the ensemble feed's window so a
 *  long tool round does not turn a bubble into a log. Exported because the
 *  schedule sink (deleted 2026-10-24) wrote the SAME field on its row, and a
 *  second number there would mean one renderer trimming two ways. */
export const MAX_LIVE_TOOL_LINES = 8;

/**
 * The prompt for a Chat-surface turn, built the way `streamQuickResponse`
 * built it — system, then history, then the live line — with one deliberate
 * difference: the screenshot attached to THIS line goes on the wire as a real
 * image part (a text-only seat is told it is there instead of answering blind).
 * Older history rows still travel as text; the dock re-sends its last ten, this
 * surface passes its whole conversation, and bolting images onto all of that
 * would be a cost decision rather than a correctness one.
 *
 * The trailing-prompt guard is load-bearing: the pipeline appends the trader's
 * own row to `messages` BEFORE the run, so `history` already ends with it.
 * Pushing it again would send the question twice — and skipping the push
 * without attaching the image there dropped the screenshot in the ordinary
 * case, because only the push branch built an image part.
 */
export const chatSurfaceTurnMessages = (
    history: readonly Message[],
    prompt: string,
    image: string | undefined,
    selectedModel: string,
    systemPrompt?: string,
): ChatMessage[] => {
    const messages: ChatMessage[] = (history || []).map(m => ({
        role: m.role === MessageRole.AI ? 'assistant' : m.role === MessageRole.SYSTEM ? 'system' : 'user',
        content: m.text,
    }));
    messages.unshift({ role: 'system', content: systemPrompt || CASUAL_CHAT_SYSTEM_PROMPT });
    const attachment = image ? { kind: 'image' as const, payload: image } : undefined;
    const last = messages[messages.length - 1];
    if (last?.content !== prompt) {
        messages.push({ role: 'user', content: userContentWithImage(prompt, attachment, selectedModel) });
    } else {
        // The row is already on the wire; the attachment is this turn's.
        last.content = userContentWithImage(prompt, attachment, selectedModel);
    }
    return messages;
};

export interface ChatSurfaceTurnRequest {
    config: ProviderConfig;
    history: readonly Message[];
    prompt: string;
    /** A chart screenshot attached to THIS line, as a dataURL. */
    image?: string;
    /** A bot persona overrides the casual prompt — bots stay chat-only, so
     *  this is for the surfaces that route here with their own mandate. */
    systemPrompt?: string;
    /** The composer's dial, forwarded exactly as `streamQuickResponse`
     *  forwarded it: unset means the task default, not a new tier. */
    effort?: ReasoningEffort;
    /** The Settings memory toggle. Default true; false strips the profile
     *  and topics blocks from the seat prompt (the write tools stay — the
     *  toggle is about what the seat READS, and the UI hides writes). */
    memoryEnabled?: boolean;
    /** The Settings → Strategies master switch. Default true; false strips the
     *  ACTIVE STRATEGIES and UPLOADED STRATEGY BOOKS blocks from the seat. It
     *  was previously read by nothing — the label beside the switch said the
     *  books were used while no seat had ever seen one. */
    strategiesEnabled?: boolean;
    /** See the note beside `contextBlock` in the executor. */
    extraContext?: string;
    symbol?: string | null;
    interval?: string;
    trades: LoggedTrade[];
    signal: AbortSignal;
    /** When the bubble was painted — every settle path reports from here. */
    startedAt: number;
    /** Patch THIS row. The caller binds the conversation and the message id, so
     *  a run that outlives the surface it started in still writes its own row. */
    patch: (fn: (m: Message) => Message) => void;
    /** Live paint, RAF-coalesced by the caller: absolute text + reasoning so
     *  far. Writing `thoughtProcesses` here too would fight the throttled
     *  casual updater that already owns that field. */
    paint: (text: string, thinking: string) => void;
    /** When true this turn is a FULL ANALYSIS, an instruction the trader gave on
     *  purpose (stage 20f) — so the seat is told to look things up, and the turn
     *  that ends without calling anything says so on the row. Explicit, because
     *  "no tool ran" is also what a text-only model does on an ordinary chat
     *  line, and a casual turn must not be shamed for answering a question. */
    requireTools?: boolean;
}

/** Run the turn. Transport errors propagate to the caller's catch: only it
 *  knows whether a failed turn is a toast, a row note, or both. */
export const runChatSurfaceTurn = async (req: ChatSurfaceTurnRequest): Promise<ToolTurnOutcome> => {
    let reasoning = '';
    let visible = '';
    const events: ToolTurnEvents = {
        setText: text => { visible = text; req.paint(text, reasoning); },
        addReasoning: chunk => { reasoning += chunk; req.paint(visible, reasoning); },
        // Append order, oldest first — the same order the dock's `tools` array
        // uses, because `liveEntryFromMessage` feeds these lines into it and
        // one renderer (ChatWorkTimeline) reads both homes.
        //
        // TWO fields, two jobs. `toolEvents` is the TRAIL: one line per entry,
        // uncapped, and the thing the settled work card draws — it is what
        // makes the rows a trader opens the rows the desk ran. `liveToolEvents`
        // is the LIVE feed: newline-joined and capped, because a bubble that
        // is still filling must not become a log.
        addToolLine: line => req.patch(m => {
            const feed = m.liveToolEvents?.[DESK_SPEAKER] ?? '';
            const lines = feed ? `${feed}\n${line}`.split('\n') : [line];
            return {
                ...m,
                toolEvents: [...(m.toolEvents ?? []), line],
                liveToolEvents: { ...m.liveToolEvents, [DESK_SPEAKER]: lines.slice(-MAX_LIVE_TOOL_LINES).join('\n') },
            };
        }),
        addLiveToolLine: line => req.patch(m => {
            const feed = m.liveToolEvents?.[DESK_SPEAKER] ?? '';
            const lines = feed ? `${feed}\n${line}`.split('\n') : [line];
            return { ...m, liveToolEvents: { ...m.liveToolEvents, [DESK_SPEAKER]: lines.slice(-MAX_LIVE_TOOL_LINES).join('\n') } };
        }),
        attachPayload: payload => {
            try {
                saveToolPayload(payload);
            } catch {
                // A payload write must never take down the transcript write it
                // is riding inside — the line already landed above.
            }
            // The id is what the expander opens onto, and it belongs to the
            // RESULT line — the desk loop emits the digest line first, so the
            // last line is the one the bytes are for. Without this the Chat
            // surface's tool rows could never expand: the payload was saved
            // and nothing could find it again.
            req.patch(m => {
                const ids = [...(m.toolIds ?? [])];
                const lines = m.toolEvents ?? [];
                // Keep the two arrays the same length: a payload that arrives
                // with no matching line pads with '' rather than shifting every
                // later id onto the wrong row.
                while (ids.length < lines.length) ids.push('');
                ids[Math.max(0, lines.length - 1)] = payload.toolCallId;
                return { ...m, toolIds: ids };
            });
        },
        // Side-effects (skill drafts, memory notes, forged tools) append through
        // the ONE ledger helper so this writer caps and copies exactly like the
        // pipeline's own; the row then shows them as status rows in both homes.
        addAction: action => req.patch(m => appendToolActions([m], m.id, [{ ...action, speaker: action.speaker || DESK_SPEAKER }])[0]),
    };

    const transport: ToolTurnRequest['transport'] = {
        defaultSymbol: req.symbol ?? null,
        allowedTools: CHAT_SURFACE_TOOLS,
        goalAllowedTools: focusedGoal()?.policy.allowedTools,
        maxTokens: TASK_BUDGETS.chat,
        temperature: 0.4,
        reasoningEffort: resolveComposerEffort(req.effort, 'tradingDecision'),
        chartInterval: req.interval,
        trades: req.trades,
        // The desk CAN present a plan here, and this is the only chart-action
        // tool it may do: anything else returns null and falls through to the
        // core executor, whose allow-list refuses it. The sink writes the
        // canonical row and owns NEITHER a canvas NOR the level-watch, so the
        // receipt the model reads says exactly that instead of promising a
        // [HARNESS SIGNAL] that would never arrive.
        executePanelTool: async (call: Parameters<NonNullable<ToolTurnRequest['transport']['executePanelTool']>>[0]) => {
            if (call.name !== 'present_trade') return null;
            return runPresentTrade(
                {
                    call,
                    symbol: req.symbol || call.arguments?.symbol?.toString() || 'BTCUSDT',
                    trades: req.trades,
                    drawnPrice: null,
                    crossCanvas: false,
                    canvasNote: '',
                    // This home has no chart to arm a level-watch against, so the
                    // receipt says "NO level-watch is armed" instead of promising
                    // a [HARNESS SIGNAL]. Explicit, not inferred from a missing
                    // callback: the watch is unavailable HERE, not unwired.
                    watchable: false,
                },
                {
                    setProposal: proposal => req.patch(m => ({ ...m, proposal })),
                    setGate: gate => req.patch(m => (m.proposal ? { ...m, proposal: { ...m.proposal, gate } } : m)),
                    // A Stop on this turn cancels its own gate scan: a verdict
                    // that arrives for a run the trader cut must not resurrect
                    // the card it was capped for.
                    onAbort: fn => req.signal.addEventListener('abort', fn, { once: true }),
                },
            );
        },
    };

    // A caller that brings its own mandate (a persona, a room note) gets it
    // verbatim and NO skill record: nothing was injected that it did not ask
    // for, and a row claiming skills it never saw is worse than a silent row.
    const prompt = req.systemPrompt
        ? { text: req.systemPrompt, skills: [] as string[] }
        : chatSurfaceSystemPrompt({
            memoryEnabled: req.memoryEnabled !== false,
            strategiesEnabled: req.strategiesEnabled !== false,
            windowTokens: req.config?.contextWindowTokens,
            // Only the trader's own line is matched — see the note in
            // `surfacePromptWith`. A caller that brought its own mandate gets
            // that mandate verbatim and no hint.
            matchText: typeof req.prompt === 'string' ? req.prompt : undefined,
        });
    if (prompt.skills.length > 0) req.patch(m => ({ ...m, injectedSkills: prompt.skills }));

    // A FULL ANALYSIS (stage 20f) is an instruction, not a keyword: the trader
    // pressed the button, so the seat is told to check the tape, and the turn is
    // checked afterwards for whether it actually did.
    // Retrieved context the caller assembled for THIS run (the trader's closed
    // trade lessons, skill-veto prose, notebook bodies, the predicate note). It
    // rides the SYSTEM prompt because a seat reads the user role as the trader
    // speaking, and because it is guidance rather than a request. Capped here so
    // a runaway retrieval cannot crowd out the chart.
    const extraContext = (req.extraContext ?? '').trim();
    const contextBlock = extraContext
        ? `\n\n## What you already know about this trader\n${extraContext.slice(0, 6000)}${
            extraContext.length > 6000 ? '\n… (retrieved context truncated)' : ''
        }`
        : '';
    const systemText = req.requireTools
        ? `${prompt.text}${contextBlock}\n\nFULL ANALYSIS REQUESTED: this turn is not a conversation, it is a reading. Call the market tools (price, book, derivatives, indicators, the trader's own log) before you state a number, and finish with present_trade if you have a plan. If you call nothing, say plainly that you did not look anything up.`
        : `${prompt.text}${contextBlock}`;
    let sawMarketTool = false;
    const tracked: ToolTurnEvents = {
        ...events,
        // Name, not display line: `present_trade` renders as a call like any
        // other, but it reads nothing — and neither does a memory read, a
        // skill edit, or `decline_trade`. Only an explicit market-read set
        // satisfies "checked the tape"; anything else would let a plan from
        // memory pass the very check that exists to catch it.
        addToolCall: name => { if (isMarketReadTool(name)) sawMarketTool = true; },
    };
    // The truncation tally is per-RUN, and this is the run. Without a window
    // open, `recordFinishReason` counts nothing and a provider that stopped
    // at the token ceiling is indistinguishable from one that finished — a
    // truncated body is a SUCCESS-shaped response, so nothing else in the
    // transport reports it. Bracket the turn so the notice below is a
    // measured fact, not a guess from a missing sentence.
    // The bracket hands this run ITS OWN recorder, and the transport prefers it
    // over the process-wide tally — so a second turn elsewhere can no longer
    // reset this one's counters (the 2026-10-27 audit L-7).
    const { value: out, summary } = await withTruncationWindow(async (recordFinishReason) => await runToolTurn({
        config: req.config,
        messages: chatSurfaceTurnMessages(req.history, req.prompt, req.image, req.config.selectedModel, systemText),
        signal: req.signal,
        startedAt: req.startedAt,
        effort: resolveComposerEffort(req.effort, 'tradingDecision'),
        transport: { ...transport, onFinishReason: recordFinishReason },
        events: tracked,
        memoryEnabled: req.memoryEnabled !== false,
        lastUserMessage: typeof req.prompt === 'string' ? req.prompt : undefined,
    }));
    recordToolTurnUsage({
        startedAt: req.startedAt,
        workedMs: out.workedMs,
        modelId: req.config.selectedModel,
        usage: out.usage,
        usageCalls: out.usageCalls,
        answer: out.text,
        rates: {
            inputUsdPer1k: req.config.inputUsdPer1k,
            outputUsdPer1k: req.config.outputUsdPer1k,
        },
    });
    // A cut-off answer is said out loud, on the row it belongs to, BEFORE the
    // "nothing looked up" notice: that notice is about the TOOLS, this one is
    // about the ANSWER being incomplete, and a trader reading the row must not
    // mistake a truncated analysis for a complete one. A RECOVERED run is
    // exempt: the loop repaired the ceiling-hit (re-ask or continuation) and
    // returned a whole answer, so warning about it would be noise.
    const cutOff = out.recoveredFromTruncation ? '' : truncationNotice(summary);
    if (cutOff) {
        return {
            ...out,
            notice: out.notice ? `${cutOff} ${out.notice}` : cutOff,
        };
    }
    if (req.requireTools && !sawMarketTool && !out.interrupted) {
        // The honest notice, on the row it belongs to: an answer that looked up
        // nothing must not read like one that looked something up. A stopped
        // turn is excluded — the trader cut it, the seat did not skip the tape.
        return {
            ...out,
            notice: 'FULL ANALYSIS, NOTHING LOOKED UP: this turn called no market tool, so every number in it is the model’s own memory. Re-ask, or check the chart.',
        };
    }
    return out;
};
