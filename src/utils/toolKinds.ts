/**
 * toolKinds — the ONE authoritative declarative Tool Registry for August Trading.
 *
 * Every desk/chat tool's canonical name, human transcript label, coarse kind,
 * live activity phrase, cache/stamp/memory/stateful/action/market flags, and
 * aliases live here in ONE table (`TOOL_REGISTRY`).
 *
 * `DESK_TOOL_NAMES`, `TOOL_LABELS`, `BY_LABEL`, `CACHEABLE_TOOLS`,
 * `STAMPED_TOOLS`, `MEMORY_OFF_TOOLS`, `UNTRUSTED_RESULT_TOOLS`,
 * `STATEFUL_DESK_TOOLS`, `ACTIONABLE_TOOLS`, `MARKET_TOOL_NAMES`, and
 * `MARKET_READ_TOOL_NAMES` are all derived from `TOOL_REGISTRY` so adding or
 * renaming a tool can never silently drift across 10 separate files.
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

export interface ToolRegistryEntry {
    name: string;
    label: string;
    kind: ToolKind;
    activity: string;
    /** Included in `DESK_TOOL_NAMES` (the dock seat grant / skill tool check). */
    deskGrant?: boolean;
    /** Alternative tool names mapped to the same label. */
    aliases?: readonly string[];
    /** Alternative transcript labels (legacy/compatibility) mapped to same kind/activity. */
    labelAliases?: readonly string[];
    cacheable?: boolean;
    stamped?: boolean;
    memoryGated?: boolean;
    untrusted?: boolean;
    stateful?: boolean;
    actionable?: { verb: string; failNoun?: string };
    marketTool?: boolean;
    marketRead?: boolean;
}

/**
 * Single-source tool registry. Order of `deskGrant: true` entries preserves the
 * canonical `DESK_TOOL_NAMES` allow-list order.
 */
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
    // ── Market & Chart Reads ────────────────────────────────────────────────
    {
        name: 'get_price_snapshot', label: 'price snapshot', kind: 'read', activity: 'Reading the price',
        deskGrant: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_order_book', label: 'order book', kind: 'read', activity: 'Reading the order book',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_derivatives', label: 'derivatives', kind: 'read', activity: 'Reading derivatives',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_liquidations', label: 'liquidations', kind: 'read', activity: 'Reading liquidations',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_session_context', label: 'session', kind: 'read', activity: 'Reading the session',
        deskGrant: true, cacheable: true, marketRead: true,
    },
    {
        name: 'get_market_packet', label: 'hybrid packet', kind: 'read', activity: 'Reading the market',
        deskGrant: true, cacheable: true, stamped: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_all_timeframes', label: 'all-timeframe compendium', kind: 'read', activity: 'Reading every timeframe',
        deskGrant: true, cacheable: true, stamped: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_chart_view', label: 'chart view', kind: 'read', activity: 'Reading the chart',
        deskGrant: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_chart_studies', label: 'chart studies', kind: 'read', activity: 'Reading chart studies',
        deskGrant: true,
    },
    {
        name: 'get_key_levels', label: 'key levels', kind: 'read', activity: 'Reading key levels',
        deskGrant: true,
    },

    // ── P0/P1/P2/P3 Structure & Quant Computes ──────────────────────────────
    {
        name: 'volume_profile', label: 'volume profile', kind: 'compute', activity: 'Building the volume profile',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'naked_pocs', label: 'naked POCs', kind: 'compute', activity: 'Scanning for naked POCs',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'vwap', label: 'anchored VWAP', kind: 'compute', activity: 'Computing anchored VWAP',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'order_flow', label: 'order flow', kind: 'compute', activity: 'Reading order flow',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'effort_vs_result', label: 'effort vs result', kind: 'compute', activity: 'Weighing effort against result',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'auction_state', label: 'auction state', kind: 'compute', activity: 'Reading the auction state',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'get_regime', label: 'regime', kind: 'compute', activity: 'Classifying the regime',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'trade_math', label: 'trade math', kind: 'compute', activity: 'Computing the trade math',
        deskGrant: true,
    },
    {
        name: 'swing_structure', label: 'swing structure', kind: 'compute', activity: 'Reading swing structure',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'liquidity', label: 'liquidity', kind: 'compute', activity: 'Mapping resting liquidity',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'imbalances', label: 'imbalances', kind: 'compute', activity: 'Scanning fair value gaps',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'sr_zones', label: 'S/R zones', kind: 'compute', activity: 'Clustering S/R zones',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'wyckoff_events', label: 'Wyckoff events', kind: 'compute', activity: 'Detecting Wyckoff events',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'setup_base_rate', label: 'setup base rate', kind: 'read', activity: 'Measuring the setup base rate',
        deskGrant: true,
    },
    {
        name: 'playbook_attribution', label: 'playbook attribution', kind: 'read', activity: 'Measuring playbook attribution',
        deskGrant: true,
    },
    {
        name: 'risk_state', label: 'risk state', kind: 'read', activity: 'Reading the risk state',
        deskGrant: true,
    },
    {
        name: 'derivatives_state', label: 'derivatives state', kind: 'read', activity: 'Reading the derivatives state',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'btc_relative', label: 'BTC relative', kind: 'compute', activity: 'Comparing against BTC',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'scan_playbooks', label: 'playbook scan', kind: 'compute', activity: 'Scanning the playbooks',
        deskGrant: true, cacheable: true,
    },
    {
        name: 'meta_label', label: 'meta label', kind: 'compute', activity: 'Reading the meta label',
        deskGrant: true,
    },
    {
        name: 'get_btc_context', label: 'BTC context', kind: 'read', activity: 'Reading BTC context',
        deskGrant: true, marketTool: true, marketRead: true,
    },
    {
        name: 'recall', label: 'notebook recall', kind: 'search', activity: 'Recalling the notebook',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'get_setup_history_stats', label: 'setup history', kind: 'read', activity: 'Reading setup history',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'web_search', label: 'web search', kind: 'search', activity: 'Searching the web',
        deskGrant: true, cacheable: true, untrusted: true,
    },
    {
        name: 'scan_setups', label: 'scan setups', kind: 'search', activity: 'Scanning for setups',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
        labelAliases: ['scan chart skills'],
    },
    {
        name: 'scan_confluence', label: 'confluence scan', kind: 'compute', activity: 'Scanning multi-TF confluence',
        cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'get_trade_log', label: 'trade log', kind: 'read', activity: 'Reading the trade log',
        deskGrant: true, marketRead: true,
    },
    {
        name: 'project_future_price', label: 'price projection', kind: 'compute', activity: 'Projecting prices',
        deskGrant: true, cacheable: true, marketTool: true, marketRead: true,
    },
    {
        name: 'emit_signal', label: 'signal', kind: 'present', activity: 'Emitting signal',
        deskGrant: true, stateful: true, actionable: { verb: 'emitted', failNoun: 'signal' },
    },
    {
        name: 'get_indicators', label: 'indicators', kind: 'read', activity: 'Reading indicators',
        deskGrant: true, marketTool: true, marketRead: true,
    },
    {
        name: 'recall_chat', label: 'session search', kind: 'search', activity: 'Searching the session',
        deskGrant: true,
    },
    {
        name: 'run_screener', label: 'screener', kind: 'compute', activity: 'Running the screener',
        deskGrant: true, cacheable: true, marketRead: true,
    },
    {
        name: 'run_monte_carlo', label: 'monte carlo', kind: 'compute', activity: 'Running Monte Carlo',
        deskGrant: true, marketTool: true, marketRead: true,
    },
    {
        name: 'find_best_setups', label: 'best setups', kind: 'compute', activity: 'Ranking the best setups',
        deskGrant: true, cacheable: true, marketRead: true,
    },
    {
        name: 'switch_chart_symbol', label: 'chart switch', kind: 'draw', activity: 'Switching the chart symbol',
        deskGrant: true, stateful: true,
    },

    // ── Notebook, Memory & Skills ───────────────────────────────────────────
    {
        name: 'write_memory_note', label: 'memory note', kind: 'write', activity: 'Writing a memory note',
        deskGrant: true, memoryGated: true, stateful: true,
        actionable: { verb: 'saved', failNoun: 'memory note' },
    },
    {
        name: 'get_notebook_map', label: 'notebook map', kind: 'read', activity: 'Reading the notebook map',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'skill_index', label: 'skills list', kind: 'read', activity: 'Listing skills',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'skill_write', label: 'skill write', kind: 'write', activity: 'Writing a skill',
        deskGrant: true, memoryGated: true, stateful: true,
        actionable: { verb: 'saved', failNoun: 'skill write' },
        labelAliases: ['skill proposal', 'skill revision'],
    },
    {
        name: 'propose_strategy', label: 'strategy plan', kind: 'present', activity: 'Proposing a plan',
        deskGrant: true, stateful: true, actionable: { verb: 'proposed', failNoun: 'strategy plan' },
    },
    {
        name: 'amend_memory', label: 'amend memory', kind: 'write', activity: 'Amending memory',
        deskGrant: true, memoryGated: true, stateful: true,
        actionable: { verb: 'amended', failNoun: 'memory amendment' },
    },
    {
        name: 'forge_tool', label: 'forge tool', kind: 'write', activity: 'Forging a tool',
        deskGrant: true, stateful: true, actionable: { verb: 'proposed', failNoun: 'desk tool' },
    },
    {
        name: 'skill_view', label: 'skill reader', kind: 'read', activity: 'Reading a skill',
        deskGrant: true, memoryGated: true, aliases: ['skill_reader', 'read_skill'],
    },
    {
        name: 'remember', label: 'remember', kind: 'write', activity: 'Remembering something',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'saved', failNoun: 'memory' },
    },
    {
        name: 'read_memory', label: 'read memory', kind: 'read', activity: 'Reading a memory',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'forget', label: 'forget', kind: 'write', activity: 'Forgetting a memory',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'removed', failNoun: 'memory removal' },
    },
    {
        name: 'memory_read', label: 'read memory', kind: 'read', activity: 'Reading a memory',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'memory_add', label: 'remember', kind: 'write', activity: 'Remembering something',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'saved', failNoun: 'memory' },
    },
    {
        name: 'memory_update', label: 'amend memory', kind: 'write', activity: 'Amending memory',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'updated', failNoun: 'memory update' },
    },
    {
        name: 'memory_delete', label: 'forget', kind: 'write', activity: 'Forgetting a memory',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'removed', failNoun: 'memory removal' },
    },
    {
        name: 'memory_search_sessions', label: 'session search', kind: 'search', activity: 'Searching the session',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'memory', label: 'curated memory', kind: 'write', activity: 'Updating curated memory',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'saved', failNoun: 'curated memory write' },
    },
    {
        name: 'session_search', label: 'session search', kind: 'search', activity: 'Searching the session',
        deskGrant: true, memoryGated: true,
    },
    {
        name: 'skill_manage', label: 'skill manage', kind: 'write', activity: 'Managing skill lifecycle',
        deskGrant: true, memoryGated: true, stateful: true, actionable: { verb: 'updated', failNoun: 'skill manage' },
    },

    // ── Plans, Goals, Self-Mod & Proposals ──────────────────────────────────
    {
        name: 'update_plan', label: 'update plan', kind: 'write', activity: 'Updating turn plan',
        deskGrant: true, stateful: true,
    },
    {
        name: 'list_goals', label: 'goal list', kind: 'read', activity: 'Reading the goals',
        deskGrant: true,
    },
    {
        name: 'open_goal', label: 'goal reader', kind: 'read', activity: 'Opening a goal',
        deskGrant: true,
    },
    {
        name: 'create_goal', label: 'goal creation', kind: 'write', activity: 'Creating a goal',
        deskGrant: true, stateful: true,
    },
    {
        name: 'update_goal', label: 'goal update', kind: 'write', activity: 'Updating a goal',
        deskGrant: true, stateful: true,
    },
    {
        name: 'restore_goal', label: 'goal restore', kind: 'write', activity: 'Restoring a goal version',
        deskGrant: true, stateful: true,
    },
    {
        name: 'list_self_changes', label: 'change ledger', kind: 'read', activity: 'Reading the change ledger',
        deskGrant: true,
    },
    {
        name: 'propose_self_change', label: 'self-change', kind: 'write', activity: 'Changing its own harness',
        deskGrant: true, stateful: true,
    },
    {
        name: 'revert_self_change', label: 'self-change undo', kind: 'write', activity: 'Reverting a self-change',
        deskGrant: true, stateful: true,
    },
    {
        name: 'ask_user_input', label: 'ask trader', kind: 'other', activity: 'Asking the trader',
        deskGrant: true, stateful: true,
    },
    {
        name: 'correct_trade_outcome', label: 'settlement correction', kind: 'write', activity: 'Proposing a settlement correction',
        deskGrant: true, stateful: true,
    },
    {
        name: 'update_trade', label: 'update trade', kind: 'write', activity: 'Proposing a level change',
        deskGrant: true, stateful: true, labelAliases: ['trade level change'],
    },
    {
        name: 'close_trade', label: 'close trade', kind: 'write', activity: 'Proposing a close',
        deskGrant: true, stateful: true, labelAliases: ['trade close'],
    },
    {
        name: 'run_review', label: 'run review', kind: 'read', activity: 'Running a review',
        deskGrant: true, labelAliases: ['review'],
    },
    {
        name: 'propose_risk_change', label: 'risk limit change', kind: 'write', activity: 'Proposing a risk limit change',
        deskGrant: true, stateful: true,
    },
    {
        name: 'propose_strategy_activation', label: 'strategy state change', kind: 'write', activity: 'Proposing a strategy state change',
        deskGrant: true, stateful: true,
    },
    {
        name: 'propose_session_plan', label: 'session plan', kind: 'write', activity: 'Proposing the session plan',
        deskGrant: true, stateful: true,
    },
    {
        name: 'propose_rule_change', label: 'rule proposal', kind: 'write', activity: 'Proposing a trading rule',
        deskGrant: true, stateful: true,
    },
    {
        name: 'propose_ai_setting_change', label: 'ai setting', kind: 'write', activity: 'Proposing an AI setting change',
        deskGrant: true, stateful: true, labelAliases: ['propose ai setting change'],
    },
    {
        name: 'refresh_journal_review', label: 'refresh journal review', kind: 'read', activity: 'Refreshing journal review',
        deskGrant: true, stateful: true,
    },

    // ── Paper Trading Engine ────────────────────────────────────────────────
    {
        name: 'paper_account', label: 'paper account', kind: 'read', activity: 'Reading paper account',
        deskGrant: true,
    },
    {
        name: 'paper_order', label: 'paper order', kind: 'write', activity: 'Placing paper order',
        deskGrant: true, stateful: true,
    },

    // ── Chart Actions, Panel Mail, Catalogue & Surface Presentation ─────────
    {
        name: 'draw_on_chart', label: 'chart draw', kind: 'draw', activity: 'Drawing on the chart',
        stateful: true,
    },
    {
        name: 'draw_detected', label: 'draw detected', kind: 'draw', activity: 'Drawing the detected setup',
        stateful: true,
    },
    {
        name: 'draw_tool_levels', label: 'tool levels', kind: 'draw', activity: 'Drawing the tool levels',
        stateful: true,
    },
    {
        name: 'mark_trade_levels', label: 'level marks', kind: 'draw', activity: 'Marking levels',
        stateful: true,
    },
    {
        name: 'clear_chart_drawings', label: 'chart clear', kind: 'draw', activity: 'Clearing the chart',
        stateful: true,
    },
    {
        name: 'set_chart_timeframe', label: 'chart timeframe', kind: 'draw', activity: 'Changing the timeframe',
        stateful: true,
    },
    {
        name: 'toggle_chart_study', label: 'chart study', kind: 'draw', activity: 'Toggling a chart study',
        stateful: true,
    },
    {
        name: 'send_message', label: 'direct message', kind: 'write', activity: 'Messaging an agent',
        stateful: true,
    },
    {
        name: 'read_message', label: 'read inbox', kind: 'read', activity: 'Reading the inbox',
    },
    {
        name: 'load_tools', label: 'tool catalogue', kind: 'read', activity: 'Loading tools',
    },
    {
        name: 'read_tool_output', label: 'stored result', kind: 'read', activity: 'Reading a stored result',
    },
    {
        name: 'present_trade', label: 'present trade', kind: 'present', activity: 'Presenting the trade',
        stateful: true,
    },
    {
        name: 'decline_trade', label: 'decline trade', kind: 'present', activity: 'Declining the trade',
        stateful: true,
    },
    {
        name: 'repo_read', label: 'repo read', kind: 'read', activity: 'Reading workspace file',
    },
    {
        name: 'repo_edit', label: 'repo edit', kind: 'write', activity: 'Editing workspace file',
        stateful: true,
    },
    {
        name: 'repo_apply', label: 'repo apply', kind: 'write', activity: 'Applying workspace check',
        stateful: true,
    },
    {
        name: 'repo_setup', label: 'repo setup', kind: 'read', activity: 'Checking workspace setup',
    },
    {
        name: 'wake_me', label: 'wake me', kind: 'other', activity: 'Waking you',
    },
];

const buildByLabel = (): Record<string, ToolKindInfo> => {
    const out: Record<string, ToolKindInfo> = {};
    for (const entry of TOOL_REGISTRY) {
        const info: ToolKindInfo = { kind: entry.kind, activity: entry.activity };
        out[entry.label.toLowerCase()] = info;
        if (entry.labelAliases) {
            for (const alias of entry.labelAliases) {
                out[alias.toLowerCase()] = info;
            }
        }
    }
    return out;
};

/** Keyed by the transcript's human label, lower-cased. */
const BY_LABEL: Record<string, ToolKindInfo> = buildByLabel();

/** The kind + activity phrase for a transcript label. Never throws, and never
 *  guesses: an unknown label is `other` with an EMPTY activity, so the caller
 *  falls back to the label itself. */
export const toolKindOf = (label: string): ToolKindInfo => {
    const key = (label ?? '').trim().toLowerCase();
    return BY_LABEL[key] ?? { kind: 'other', activity: '' };
};

export const NO_TOOLS_ALLOWED: string[] = [''];

export type SeatToolGrant = readonly string[] | 'all';

export const intersectGoalPolicy = (
    seat: SeatToolGrant | undefined,
    policy: readonly string[],
    realToolNames: readonly string[],
): string[] => {
    const keep = policy.filter(t => realToolNames.includes(t) && (
        seat === 'all' ? true : Array.isArray(seat) && seat.includes(t)
    ));
    return keep.length > 0 ? keep : [...NO_TOOLS_ALLOWED];
};

/** Derived desk tool allow-list (every entry with `deskGrant: true`). */
export const DESK_TOOL_NAMES: readonly string[] = TOOL_REGISTRY
    .filter(t => t.deskGrant)
    .map(t => t.name);

/** Canonical paper-broker tool names granted to both Desk and Chat seats. */
export const PAPER_TOOL_NAMES = ['paper_account', 'paper_order'] as const;

/** Derived human-friendly tool labels (canonical name + aliases). */
export const TOOL_LABELS: Record<string, string> = (() => {
    const map: Record<string, string> = {};
    for (const entry of TOOL_REGISTRY) {
        map[entry.name] = entry.label;
        if (entry.aliases) {
            for (const alias of entry.aliases) map[alias] = entry.label;
        }
    }
    return map;
})();

export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name.replace(/_/g, ' ');

export const CACHEABLE_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.cacheable).map(t => t.name),
);

export const STAMPED_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.stamped).map(t => t.name),
);

export const MEMORY_OFF_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.memoryGated).flatMap(t => [t.name, ...(t.aliases ?? [])]),
);

export const UNTRUSTED_RESULT_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.untrusted).map(t => t.name),
);

export const STATEFUL_DESK_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.stateful).map(t => t.name),
);

export const ACTIONABLE_TOOLS: ReadonlySet<string> = new Set(
    TOOL_REGISTRY.filter(t => t.actionable).map(t => t.name),
);

export const ACTIONABLE_TOOL_META: Readonly<Record<string, { verb: string; failNoun?: string }>> = (() => {
    const map: Record<string, { verb: string; failNoun?: string }> = {};
    for (const entry of TOOL_REGISTRY) {
        if (entry.actionable) map[entry.name] = entry.actionable;
    }
    return map;
})();

export const MARKET_TOOL_NAMES: readonly string[] = TOOL_REGISTRY
    .filter(t => t.marketTool)
    .map(t => t.name);

export const MARKET_READ_TOOL_NAMES: readonly string[] = TOOL_REGISTRY
    .filter(t => t.marketTool || t.marketRead)
    .map(t => t.name);
