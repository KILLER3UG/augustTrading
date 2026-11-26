/**
 * deskToolShared — the desk vocabulary that eager services need WITHOUT
 * the DeskToolsService whale.
 *
 * WHY THIS EXISTS. The entry chunk (O-146) carried the whole desk service
 * because four eager modules imported one predicate, two prompt constants,
 * a helper and the chart-action schemas from it. Those pieces are
 * dependency-light; the whale (the 48 tool schemas, the dispatch, the
 * loop) is not. They live here, the whale imports them from here, and the
 * eager services import from here — so the schemas and dispatch load on
 * the first tool turn instead of at boot. A symbol moved here MUST stay
 * dependency-light: anything that drags DeskToolsService back in defeats
 * the whole point, and the ratchet will say so.
 */

import { getHarnessSettings } from '../../utils/harnessSettings';
import { PLAYBOOK_IDS } from '../../types/playbook';
import { CHART_INTERVALS } from '../../utils/chartIntervals';
import { MARKET_TOOL_NAMES, MARKET_READ_TOOL_NAMES } from '../../utils/toolKinds';
import { CHART_INDICATOR_IDS, CHART_INDICATOR_LABELS } from '../trade/chartIndicatorSettings';
import { extractSymbolFromPrompt } from './MarketDataService';
import { isVisionModel } from '../../utils/modelUtils';
import type { DeskToolDefinition } from './DeskToolsService';
export const CHART_ACTION_TOOL_DEFS: DeskToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'draw_on_chart',
            description:
                'Draw on the user\'s live chart — the same drawing tools the user has: horizontal line (level), trendline, ray, supply/demand zone, a parallel CHANNEL (a band for a range), a fibonacci retracement, an ARROW pointing at a level, a MEASURED_MOVE (entry → stop → first target, labelled with the risk, the reward and the resulting ratio), or a text note. Anchors are PRICES plus "bars ago" offsets from the newest candle (startBarsAgo is the OLDER anchor). The shape appears on the chart immediately and the user sees it.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', description: 'hline | trend | ray | zone | channel | fib | arrow | measured_move | text', enum: ['hline', 'trend', 'ray', 'zone', 'channel', 'fib', 'arrow', 'measured_move', 'text'] },
                    prices: { type: 'array', items: { type: 'number' }, description: 'One price for hline/text; two (start→end) for trend/ray/zone/channel/fib/arrow; THREE (entry, stop, firstTarget) for measured_move.' },
                    startBarsAgo: { type: 'number', description: 'Bars back from now for the OLDER anchor (default 40). Ignored for measured_move, which stacks on one bar.' },
                    endBarsAgo: { type: 'number', description: 'Bars back for the NEWER anchor (default 0 = now).' },
                    color: { type: 'string', description: 'emerald | rose | amber | sky | violet (default sky).', enum: ['emerald', 'rose', 'amber', 'sky', 'violet'] },
                    label: { type: 'string', description: 'Short label shown on the shape, e.g. "range high".' },
                },
                required: ['kind', 'prices'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'draw_detected',
            description:
                'Draw a structure the detector already found on THIS chart, at the exact price the code measured. Name the pattern exactly as it appears in the market packet\'s geometry table; the detector\'s own anchors place it. Prefer this over draw_on_chart whenever the shape is already in that table — the level cannot be a digit out, because you never state it. Returns what was drawn and whether the market actually respected that line.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Pattern name from the packet geometry table, e.g. "Head and Shoulders" or "Ascending Triangle".' },
                },
                required: ['pattern'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'draw_tool_levels',
            description:
                'Draw a market tool\'s computed levels on THIS chart, the way a trader plots them: POC/VAH/VAL and the value-area zone from volume_profile, naked POCs, VWAP and its ±1σ bands, initial balance and rotation target from auction_state, session levels from get_key_levels, fib/break levels from swing_structure, equal-level pools and untested swings from liquidity, unfilled FVG zones from imbalances, S/R zones from sr_zones, range/spring levels from wyckoff_events. The app RE-RUNS the tool and draws at the computed prices — you never restate a number, so the drawing cannot be a digit out.',
            parameters: {
                type: 'object',
                properties: {
                    tool: {
                        type: 'string',
                        enum: ['volume_profile', 'naked_pocs', 'vwap', 'auction_state', 'get_key_levels', 'swing_structure', 'liquidity', 'imbalances', 'sr_zones', 'wyckoff_events', 'divergences'],
                        description: 'Which tool\'s levels or divergence trendlines to draw. The tool is re-run fresh at draw time.',
                    },
                    symbol: { type: 'string', description: 'Any perp symbol (default: the chart\'s current symbol).' },
                    anchor: { type: 'string', description: 'volume_profile: session|day|week|visible|swing|custom. vwap: session_open|swing_high|swing_low|custom. Default: session / session_open.' },
                    interval: { type: 'string', description: 'Timeframe for the structure tools (swing_structure, liquidity, imbalances, sr_zones, wyckoff_events). Default 1h.' },
                    items: { type: 'array', items: { type: 'string' }, description: 'Optional label filter — draw only lines whose label matches one of these substrings (e.g. ["POC", "value area"]).' },
                },
                required: ['tool'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mark_trade_levels',
            description:
                'Mark a full trade plan on the chart: Entry (sky), Stop Loss (rose) and 1-5 Take Profits (amber) as labeled horizontal lines the user can see. At least one of stopLoss / takeProfits is REQUIRED beside the entry — and SL/TP geometry is validated (SL and TPs cannot sit on the same side of Entry or contradict direction). Use this instead of three draw_on_chart calls when presenting a setup; if the plan is going to the trader for a decision, use present_trade instead (it draws these AND shows the card).',
            parameters: {
                type: 'object',
                properties: {
                    direction: { type: 'string', enum: ['Long', 'Short'], description: 'Optional trade side ("Long" requires SL < entry < TP; "Short" requires TP < entry < SL).' },
                    entry: { type: 'number', description: 'Entry price. Refused alone: name a stopLoss and/or takeProfits too.' },
                    stopLoss: { type: 'number', description: 'Stop-loss price.' },
                    takeProfits: { type: 'array', items: { type: 'number' }, description: '1-5 TP prices, in order.' },
                },
                required: ['entry'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'clear_chart_drawings',
            description:
                'Clear drawings from the chart. scope "model" (default) removes only what the MODEL drew; scope "all" also wipes the USER\'S own drawings — only when the user explicitly asked to clear the chart.',
            parameters: {
                type: 'object',
                properties: {
                    scope: { type: 'string', description: 'model (default) | all', enum: ['model', 'all'] },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'present_trade',
            description:
                'Present a concrete, actionable trade to the user: draws the Entry/Stop/Targets on the chart AND shows a card with a "Log this trade" button. Use this when you have a specific setup you would put on — direction, entry, stop and at least one target are required. The user decides whether to log it; logging records it as an open trade that the harness later scores against the real outcome. When the plan follows a `scan_playbooks` match, pass that match\'s exact `playbook` id — the tag lets the journal measure that detector\'s outcomes; omit it when no detector fired.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Instrument, e.g. BTCUSDT (default: the chart symbol).' },
                    direction: { type: 'string', enum: ['Long', 'Short'] },
                    entry: { type: 'number', description: 'Entry price.' },
                    stopLoss: { type: 'number', description: 'Stop-loss price (below entry for Long, above for Short).' },
                    takeProfits: { type: 'array', items: { type: 'number' }, description: '1-5 target prices, in order.' },
                    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                    rationale: { type: 'string', description: 'One or two sentences: why this setup.' },
                    invalidation: { type: 'string', description: 'What would prove the idea wrong.' },
                    playbook: {
                        type: 'string',
                        enum: [...PLAYBOOK_IDS],
                        description: 'The scan_playbooks detector id this plan follows — copy it exactly from the scan match. Omit when no detector fired; never invent one.',
                    },
                    skillSlug: {
                        type: 'string',
                        description: 'Optional playbook skill slug applied to this plan.',
                    },
                },
                required: ['direction', 'entry', 'stopLoss', 'takeProfits'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'decline_trade',
            description:
                'Decline to present a trade and leave a HOLD record with your reason and the levels you rejected. Use this when you have looked at the tape and the setup is not worth taking — a skip is a decision, and the harness must be able to ask later whether it skipped a winner. Do NOT call this just because the user asked a question; use it only when you actually evaluated a setup and chose not to take it.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Instrument, e.g. BTCUSDT (default: the chart symbol).' },
                    direction: { type: 'string', enum: ['Long', 'Short', 'Neutral'], description: 'The side you rejected, or Neutral if neither.' },
                    reason: { type: 'string', description: 'Why the setup is not worth taking, in one or two sentences.' },
                    entry: { type: 'number', description: 'The entry you would have used, if any.' },
                    stopLoss: { type: 'number', description: 'The stop you rejected, if any.' },
                    takeProfits: { type: 'array', items: { type: 'number' }, description: 'The targets you rejected, if any.' },
                    invalidation: { type: 'string', description: 'What would have changed your mind.' },
                },
                required: ['reason'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'watch_price',
            description:
                'Arm a price WATCH on the harness: when the live mark price reaches the condition, the harness WAKES YOU with a [HARNESS TRIGGER] signal so you can re-read the chart live and alert the user whether it is ready to trade. Use whenever the user says "tell me when price hits X", "alert me on a reclaim of Y", or when YOU want to track a condition in real time instead of guessing it later. Fires once, then lapses.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Instrument, e.g. BTCUSDT (default: the chart symbol).' },
                    condition: { type: 'string', enum: ['above', 'below'], description: 'Trigger when the mark price is at/above (or at/below) the price.' },
                    price: { type: 'number', description: 'The watched price level.' },
                    note: { type: 'string', description: 'Why you armed it — quoted back in the fired signal ("breakout reclaim above range high").' },
                    expiresInMinutes: { type: 'number', description: 'Lapse deadline (default 720 = 12h).' },
                },
                required: ['condition', 'price'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'wake_me',
            description:
                'Schedule a TIME wake-up: the harness signals you at the set time so you can re-check the chart and report to the user ("check back in 30 minutes", "watch this breakout and update me at the session open"). Fires once at/after the deadline.',
            parameters: {
                type: 'object',
                properties: {
                    symbol: { type: 'string', description: 'Instrument for the re-check context (default: the chart symbol).' },
                    inMinutes: { type: 'number', description: 'Wake in N minutes from now (≥1, max 7 days).' },
                    note: { type: 'string', description: 'What to check when you wake ("did the 5m breakout hold?").' },
                },
                required: ['inMinutes'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cancel_watch',
            description:
                'Cancel armed price watches / wake-ups — by their ids (from the receipts and the [ARMED HARNESSES] context block), or all watches for the current symbol (omit ids). Use when the user says "stop watching that" or the reason changed.',
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Watch ids to cancel.' },
                    allForSymbol: { type: 'boolean', description: 'true = cancel every watch armed on the given/current symbol.' },
                    symbol: { type: 'string', description: 'Symbol for allForSymbol (default: the chart symbol).' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_chart_timeframe',
            description:
                'Move the live chart to another timeframe. The chart redraws at that interval and the trader sees it, and your own reads follow the chart.',
            parameters: {
                type: 'object',
                properties: {
                    interval: {
                        type: 'string',
                        enum: [...CHART_INTERVALS],
                        description: 'Target timeframe, e.g. 15m, 1h, 4h, 1D.',
                    },
                },
                required: ['interval'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'toggle_chart_study',
            description:
                'Show or hide one study on the live chart — the same toggles the trader has. Pass the id exactly as listed. Turning a study off drops its computed state, so a later on starts a fresh read rather than reviving a stale value. This changes VISIBILITY only: the numbers come from the one series module the chart and your reads share, so no value can drift.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        enum: [...CHART_INDICATOR_IDS],
                        description: `Study id: ${CHART_INDICATOR_IDS.map(id => `${id} (${CHART_INDICATOR_LABELS[id]})`).join(' | ')}.`,
                    },
                    enabled: { type: 'boolean', description: 'true shows it, false hides it.' },
                },
                required: ['id', 'enabled'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'inspect_chart_image',
            description:
                'Capture the trader\'s LIVE chart as an image — candles, studies and every committed drawing (yours included) — and receive it as a PICTURE on your next turn. Use it to visually verify structure, your own plotted levels, or a pattern before you commit to a read, alongside the deterministic OHLCV tools. Read-only: it changes nothing on the chart. Offered only when you can actually see images and a live chart is mounted.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
];

/**
 * Whether `inspect_chart_image` may be OFFERED this turn: the active model
 * must be vision-capable AND a live canvas capture must be wired. A pure
 * predicate so the offer filter, the tests and the catalogue cannot drift.
 */
export const shouldOfferChartImageTool = (modelId: string, captureWired: boolean): boolean =>
    captureWired && isVisionModel(modelId);

export const deskToolsMandateFor = (offered?: readonly string[], deferred = false): string => {
    const has = (name: string): boolean => offered === undefined || offered.includes(name);
    const canViewChart = has('get_chart_view');
    const canDraw = has('draw_on_chart') || has('mark_trade_levels');
    const groundingTool = canViewChart
        ? '`get_chart_view`'
        : has('get_all_timeframes')
            ? '`get_all_timeframes`'
            : has('get_indicators')
                ? '`get_indicators`'
                : null;
    const shapeRule = canViewChart
        ? 'BEFORE NAMING SHAPES: verify patterns, swings, or structure breaks via `get_chart_view` (or `get_all_timeframes`).'
        : groundingTool
            ? `BEFORE NAMING SHAPES: no chart canvas is attached here — derive swings/structure strictly from ${groundingTool} candles.`
            : 'BEFORE NAMING SHAPES: no chart read is offered; do not infer visual chart shapes.';
    const drawingRule = canDraw
        ? 'Plot exact computed levels via `draw_on_chart` or `mark_trade_levels`.'
        : 'No chart canvas is active here — state exact numeric levels in text without offering to draw.';
    const levelRule = has('get_key_levels')
        ? ' When asked for KEY LEVELS, call `get_key_levels` and copy its `key-levels` fence verbatim.'
        : '';
    const selfModRule = has('propose_self_change') && getHarnessSettings().selfModificationMode !== 'off'
        ? 'Self-mod enabled: check `list_self_changes` before calling `propose_self_change`.\n'
        : '';
    const discoveryRule = has('find_best_setups') && has('switch_chart_symbol')
        ? 'MARKET DISCOVERY: `find_best_setups` ranks live setups (`run_screener` raw table); `switch_chart_symbol` switches the chart. Always read `get_market_packet` before sizing a discovered symbol.\n'
        : '';
    const coreMathRule = [
        has('get_regime') ? '`get_regime` tags trend/range/vol (`regime_id`)' : '',
        has('trade_math') ? '`trade_math` computes net R:R & break-even before `present_trade`' : '',
        has('meta_label') ? '`meta_label` gives TAKE/REDUCE/SKIP history read' : '',
        has('draw_tool_levels') ? '`draw_tool_levels` plots computed tool/divergence levels without restating numbers' : '',
        has('session_search') ? '`session_search` queries past Desk/Chat transcripts' : '',
    ].filter(Boolean);
    const mcRule = has('run_monte_carlo')
        ? ' `run_monte_carlo` measures volatility from ATR14 unless overridden; report simulation assumptions and timeout rate.'
        : '';
    const planGate = has('update_plan')
        ? ' PLANNING GATE: call `update_plan` ONLY for multi-step >=3-phase work in Round 1; NEVER call it on a simple question.'
        : '';

    return [
        '**DESK TOOLS (use live tools before citing numbers; pass `symbol` explicitly for non-chart coins; prefer 0-2 targeted calls):**',
        deferred
            ? 'ONLY CORE TOOLS LOADED ON TURN 1: call `load_tools` with exact names from TOOL CATALOGUE below whenever a task needs extended structure, backtest (`setup_replay`), or `divergences`.'
            : '',
        `${shapeRule} ${drawingRule}${levelRule}${mcRule}${planGate}`,
        selfModRule.trim(),
        discoveryRule.trim(),
        coreMathRule.length > 0 ? `COMPUTED TOOLS: ${coreMathRule.join('; ')}.` : '',
        'Answer cleanly in prose/markdown from tool findings — no JSON dumps or restated schemas.',
    ].filter(Boolean).join('\n');
};

/** The mandate for a turn that can call every desk tool (the dock, an analysis
 *  send). Built from `deskToolsMandateFor` so the two cannot drift apart. */
export const DESK_TOOLS_PROMPT = deskToolsMandateFor();

/**
 * Pass 3 — one frozen paragraph, imported by BOTH prompt builders. A tool
 * wired into only one seat is a dead affordance on the other.
 */
export const PAPER_TRADING_PROMPT = [
    'PAPER TRADING (local simulation, no exchange keys):',
    'Call `paper_account` before sizing. `paper_order` accepts open_market, open_limit (fills strictly past limit), modify_sl_tp, close, cancel.',
    'Deterministic fills model L2 depth + 0.02%/0.05% fees + mark-price liquidation and enforce configured risk/leverage/drawdown walls in code (report refusals plainly; simulated rows stay under Journal → Paper).',
].join('\n');

export const MARKET_TOOLS = new Set<string>(MARKET_TOOL_NAMES);

/**
 * The tools whose call READ the market (or the trader's own market record).
 */
export const MARKET_READ_TOOLS = new Set<string>(MARKET_READ_TOOL_NAMES);

export const isMarketReadTool = (name: string): boolean => MARKET_READ_TOOLS.has(name);

export const resolveDefaultSymbol = (...texts: Array<string | null | undefined>): string | null => {
    for (const text of texts) {
        if (!text) continue;
        const hit = extractSymbolFromPrompt(text);
        if (hit) return hit;
    }
    return null;
};

export const TEXT_TOOL_FALLBACK_PROMPT = `
If native function calling is unavailable, request a tool by emitting exactly:
<tool_call name="TOOL_NAME">{"arg":"value"}</tool_call>
Then wait for TOOL RESULT blocks before the public reply. Never invent tool results.
`;
