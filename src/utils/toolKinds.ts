/**
 * toolKinds — what each desk tool IS, in the words the transcript already
 * uses.
 *
 * WHY THIS EXISTS. The transcript never carries a tool NAME. The desk loop
 * writes a digest line built from the tool's HUMAN label
 * (`services/analysis/DeskToolsService.ts` — `digestToolResult` → `toolLabel`),
 * so the row the trader reads says "order book", never "get_order_book". A
 * map keyed by tool name would therefore never match anything the transcript
 * shows, and a second map keyed by label would drift from the first.
 *
 * So there is ONE map, keyed by the LABEL — the string the transcript
 * actually carries. A tool's kind is a property of the tool, but the only
 * handle the UI has is its label, so the label is the key. The name→label
 * relation already lives in one place (`TOOL_LABELS` in the desk service, via
 * the exported `toolLabel`), so nothing is duplicated here.
 *
 * `kind` is the coarse bucket the step rows will group by (Phase 3).
 * `activity` is the gerund the turn's status line shows while that tool
 * works — "Reading the order book", not "order book". It is the one thing
 * that turns a bare state ("Analyzing") into a claim about what the desk is
 * doing right now.
 *
 * A tool August does not know — a FORGED tool, or one added after this file
 * was written — has no entry. It is not guessed at: `toolKindOf` returns
 * `other` with an empty activity, and the caller falls back to the raw label.
 * A wrong gerund is a lie about the model's work; the bare label is not.
 */

/** The coarse bucket a tool falls into. */
export type ToolKind = 'read' | 'search' | 'compute' | 'draw' | 'write' | 'present' | 'other';

/** The order the kinds are named in — a fixed order so two turns that did the
 *  same work say it the same way. */
export const KIND_ORDER: readonly ToolKind[] = ['read', 'search', 'compute', 'draw', 'write', 'present', 'other'];

/** The noun a group sentence counts in ("4 reads", "1 search"). It belongs to
 *  the KIND, not to the tool, so it is one table rather than forty. */
const KIND_COUNT_NOUN: Record<ToolKind, { one: string; many: string }> = {
    read: { one: 'read', many: 'reads' },
    search: { one: 'search', many: 'searches' },
    compute: { one: 'calculation', many: 'calculations' },
    draw: { one: 'draw', many: 'draws' },
    write: { one: 'write', many: 'writes' },
    present: { one: 'plan', many: 'plans' },
    other: { one: 'step', many: 'steps' },
};

/** The kind's own name — what the row's glyph MEANS. The glyph carries it on
 *  screen; this carries it to a screen reader and a tooltip. */
const KIND_LABEL: Record<ToolKind, string> = {
    read: 'read',
    search: 'search',
    compute: 'compute',
    draw: 'draw',
    write: 'write',
    present: 'present',
    other: 'step',
};

/** The kind's name, in the word a trader would use. */
export const toolKindLabel = (kind: ToolKind): string => KIND_LABEL[kind] ?? KIND_LABEL.other;

/** "4 reads" / "1 read" — the count and the noun, together. */
export const toolKindCount = (kind: ToolKind, n: number): string => {
    const noun = KIND_COUNT_NOUN[kind] ?? KIND_COUNT_NOUN.other;
    return `${n} ${n === 1 ? noun.one : noun.many}`;
};

export interface ToolKindInfo {
    kind: ToolKind;
    /** The activity phrase the status line shows while this tool works. */
    activity: string;
}

/** Keyed by the transcript's human label, lower-cased. */
const BY_LABEL: Record<string, ToolKindInfo> = {
    // ── reads: the desk is looking something up ──────────────────────────
    'btc context': { kind: 'read', activity: 'Reading BTC context' },
    'all-timeframe compendium': { kind: 'read', activity: 'Reading every timeframe' },
    'chart view': { kind: 'read', activity: 'Reading the chart' },
    'derivatives': { kind: 'read', activity: 'Reading derivatives' },
    'hybrid packet': { kind: 'read', activity: 'Reading the market' },
    'indicators': { kind: 'read', activity: 'Reading indicators' },
    'key levels': { kind: 'read', activity: 'Reading key levels' },
    'liquidations': { kind: 'read', activity: 'Reading liquidations' },
    'notebook map': { kind: 'read', activity: 'Reading the notebook map' },
    'order book': { kind: 'read', activity: 'Reading the order book' },
    'price snapshot': { kind: 'read', activity: 'Reading the price' },
    'read memory': { kind: 'read', activity: 'Reading a memory' },
    'read inbox': { kind: 'read', activity: 'Reading the inbox' },
    'session': { kind: 'read', activity: 'Reading the session' },
    'setup history': { kind: 'read', activity: 'Reading setup history' },
    'stored result': { kind: 'read', activity: 'Reading a stored result' },
    'trade log': { kind: 'read', activity: 'Reading the trade log' },

    // ── searches: the desk is looking for something ──────────────────────
    'notebook recall': { kind: 'search', activity: 'Recalling the notebook' },
    'tool catalogue': { kind: 'read', activity: 'Loading tools' },
    'skill reader': { kind: 'read', activity: 'Reading a skill' },
    'scan chart skills': { kind: 'search', activity: 'Scanning the chart for skills' },
    'scan setups': { kind: 'search', activity: 'Scanning for setups' },
    'session search': { kind: 'search', activity: 'Searching the session' },
    'web search': { kind: 'search', activity: 'Searching the web' },

    // ── computes: the desk is working something out ───────────────────────
    'monte carlo': { kind: 'compute', activity: 'Running Monte Carlo' },
    'price projection': { kind: 'compute', activity: 'Projecting prices' },
    'screener': { kind: 'compute', activity: 'Running the screener' },
    'best setups': { kind: 'compute', activity: 'Ranking the best setups' },
    'volume profile': { kind: 'compute', activity: 'Building the volume profile' },
    'naked pocs': { kind: 'compute', activity: 'Scanning for naked POCs' },
    'anchored VWAP': { kind: 'compute', activity: 'Computing anchored VWAP' },
    'order flow': { kind: 'compute', activity: 'Reading order flow' },
    'effort vs result': { kind: 'compute', activity: 'Weighing effort against result' },
    'auction state': { kind: 'compute', activity: 'Reading the auction state' },
    'regime': { kind: 'compute', activity: 'Classifying the regime' },
    'trade math': { kind: 'compute', activity: 'Computing the trade math' },
    'swing structure': { kind: 'compute', activity: 'Reading swing structure' },
    'liquidity': { kind: 'compute', activity: 'Mapping resting liquidity' },
    'imbalances': { kind: 'compute', activity: 'Scanning fair value gaps' },
    's/r zones': { kind: 'compute', activity: 'Clustering S/R zones' },
    'wyckoff events': { kind: 'compute', activity: 'Detecting Wyckoff events' },
    'setup base rate': { kind: 'read', activity: 'Measuring the setup base rate' },
    'playbook attribution': { kind: 'read', activity: 'Measuring playbook attribution' },
    'risk state': { kind: 'read', activity: 'Reading the risk state' },
    'derivatives state': { kind: 'read', activity: 'Reading the derivatives state' },
    'btc relative': { kind: 'compute', activity: 'Comparing against BTC' },
    'playbook scan': { kind: 'compute', activity: 'Scanning the playbooks' },
    'meta label': { kind: 'compute', activity: 'Reading the meta label' },
    'tool levels': { kind: 'draw', activity: 'Drawing the tool levels' },

    // ── draws: the desk is changing the chart ────────────────────────────
    'chart clear': { kind: 'draw', activity: 'Clearing the chart' },
    'chart draw': { kind: 'draw', activity: 'Drawing on the chart' },
    'chart switch': { kind: 'draw', activity: 'Switching the chart symbol' },
    'draw detected': { kind: 'draw', activity: 'Drawing the detected setup' },
    'level marks': { kind: 'draw', activity: 'Marking levels' },

    // ── writes: the desk is changing the notebook ────────────────────────
    'amend memory': { kind: 'write', activity: 'Amending memory' },
    'ask trader': { kind: 'other', activity: 'Asking the trader' },
    'cancel watch': { kind: 'write', activity: 'Cancelling the price watch' },
    'direct message': { kind: 'write', activity: 'Messaging an agent' },
    'forge tool': { kind: 'write', activity: 'Forging a tool' },
    'forget': { kind: 'write', activity: 'Forgetting a memory' },
    'memory note': { kind: 'write', activity: 'Writing a memory note' },
    'remember': { kind: 'write', activity: 'Remembering something' },
    'goal list': { kind: 'read', activity: 'Reading the goals' },
    'goal reader': { kind: 'read', activity: 'Opening a goal' },
    'goal creation': { kind: 'write', activity: 'Creating a goal' },
    'goal update': { kind: 'write', activity: 'Updating a goal' },
    'goal restore': { kind: 'write', activity: 'Restoring a goal version' },
    'change ledger': { kind: 'read', activity: 'Reading the change ledger' },
    'self-change': { kind: 'write', activity: 'Changing its own harness' },
    'self-change undo': { kind: 'write', activity: 'Reverting a self-change' },
    'skill proposal': { kind: 'write', activity: 'Proposing a skill' },
    'skill revision': { kind: 'write', activity: 'Revising a skill' },
    'watch price': { kind: 'write', activity: 'Setting a price watch' },

    // ── presents: the desk is putting a trade in front of the trader ─────
    'decline trade': { kind: 'present', activity: 'Declining the trade' },
    'present trade': { kind: 'present', activity: 'Presenting the trade' },
    'strategy plan': { kind: 'present', activity: 'Proposing a plan' },

    // ── other: the desk is doing something we have no phrase for ─────────
    'wake me': { kind: 'other', activity: 'Waking you' },
};

/** The kind + activity phrase for a transcript label. Never throws, and never
 *  guesses: an unknown label is `other` with an EMPTY activity, so the caller
 *  falls back to the label itself. */
export const toolKindOf = (label: string): ToolKindInfo => {
    const key = (label ?? '').trim().toLowerCase();
    return BY_LABEL[key] ?? { kind: 'other', activity: '' };
};

/**
 * The desk's tool NAMES, one list — the same names `chatTurnRunner`'s
 * TRADE_TOOLS allow-list carries and the skill `compatibility.requiresTools`
 * gate checks against. A skill may only require a tool the desk can actually
 * call, and both readers must agree on the spelling, so the list lives here
 * in the vocabulary module where neither imports the other.
 */
/**
 * The allow-list that means "this seat is offered NOTHING".
 *
 * An empty array cannot mean that: every gate here reads a missing or empty
 * allow-list as "unrestricted", so a narrowed-to-nothing seat passed as `[]`
 * gets the whole desk back. The one name no tool can ever carry is the value
 * that does mean nothing — the definition filter matches no tool against it
 * and the executor refuses every call. Transport-only: never written into a
 * goal, never shown to the trader.
 */
export const NO_TOOLS_ALLOWED: string[] = [''];

/**
 * The ONE rule for how a goal's tool policy meets a seat's allow-list.
 *
 * A goal may only NARROW, so the answer is the intersection with what this
 * seat can actually call — and only with names that have a definition, so a
 * goal cannot resurrect a tool this build does not ship.
 *
 * The interesting case is the empty one. A goal authored on a wider seat (the
 * Agents surface's list is not the trade seat's `TRADE_TOOLS`) can name tools
 * this seat never had; returning `[]` there would NOT mean "nothing", because
 * `[]` reads as unrestricted. So an empty intersection returns
 * `NO_TOOLS_ALLOWED`. Pure and exported because the never-widen invariant
 * fires only for a mis-shaped goal, which no render probe can produce —
 * `check:contracts` pins it.
 */
export const intersectGoalPolicy = (
    seat: readonly string[] | undefined,
    policy: readonly string[],
    realToolNames: readonly string[],
): string[] => {
    const keep = policy.filter(t => (!seat || seat.includes(t)) && realToolNames.includes(t));
    return keep.length > 0 ? keep : [...NO_TOOLS_ALLOWED];
};

export const DESK_TOOL_NAMES: readonly string[] = [
    'get_price_snapshot', 'get_order_book', 'get_derivatives',
    'get_liquidations', 'get_session_context', 'get_market_packet', 'get_all_timeframes', 'get_chart_view',
    'get_key_levels',
    // The P0 market-structure family (docs/plans/tools-upgrade.md): volume,
    // auction and regime reads computed from closed candles, plus the plan's
    // own arithmetic. The seat reads these numbers instead of inventing them.
    'volume_profile', 'naked_pocs', 'vwap', 'order_flow', 'effort_vs_result',
    'auction_state', 'get_regime', 'trade_math',
    // The P1 family: structure/liquidity/imbalance/zone/wyckoff reads, and
    // the journal's own measured base rate and risk state.
    'swing_structure', 'liquidity', 'imbalances', 'sr_zones', 'wyckoff_events',
    'setup_base_rate', 'playbook_attribution', 'risk_state',
    // The P2 composites: derivatives positioning and the cross-market read
    // (the answer for assets without derivatives data), plus the family-H
    // playbook layer — named detectors over the same reads.
    'derivatives_state', 'btc_relative', 'scan_playbooks',
    // The advisory meta-label read (the P3 candidate the owner asked for).
    'meta_label',
    'get_btc_context', 'recall', 'get_setup_history_stats', 'web_search', 'scan_setups',
    'get_trade_log',
    'project_future_price',
    'emit_signal',
    'get_indicators',
    'recall_chat',
    'run_screener', 'run_monte_carlo',
    // The screener's ranked shortlist, and the one actuation that puts a
    // discovered coin on the live chart. Neither needs a canvas: both write
    // or read through the shared chat session / the market services.
    'find_best_setups', 'switch_chart_symbol',
    'write_memory_note', 'get_notebook_map', 'skill_index', 'skill_write', 'propose_strategy',
    'amend_memory', 'forge_tool',
    'skill_view',
    // The collaboration-memory trio the dock's own mandate already asks for.
    // They were refused at the executor because this list did not name them;
    // the chart copilot can now save/recall/forget like the Agents surface.
    'remember', 'read_memory', 'forget',
    // Goal environments: durable work state, edited mid-task.
    'list_goals', 'open_goal', 'create_goal', 'update_goal', 'restore_goal',
    // The harness change ledger: reading and moving its own self-modifications.
    'list_self_changes', 'propose_self_change', 'revert_self_change',
    // A human answer is a tool, not a broadcast: the dock's seat can ask too.
    'ask_user_input',
];
