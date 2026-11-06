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
import { extractSymbolFromPrompt } from './MarketDataService';
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
                        enum: ['volume_profile', 'naked_pocs', 'vwap', 'auction_state', 'get_key_levels', 'swing_structure', 'liquidity', 'imbalances', 'sr_zones', 'wyckoff_events'],
                        description: 'Which tool\'s levels to draw. The tool is re-run fresh at draw time.',
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
                'Mark a full trade plan on the chart: Entry (sky), Stop Loss (rose) and 1-5 Take Profits (amber) as labeled horizontal lines the user can see. Use this instead of three draw_on_chart calls when presenting a setup.',
            parameters: {
                type: 'object',
                properties: {
                    entry: { type: 'number', description: 'Entry price.' },
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
                'Present a concrete, actionable trade to the user: draws the Entry/Stop/Targets on the chart AND shows a card with a "Log this trade" button. Use this when you have a specific setup you would put on — direction, entry, stop and at least one target are required. The user decides whether to log it; logging records it as an open trade that the harness later scores against the real outcome.',
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
];

export const deskToolsMandateFor = (offered?: readonly string[], deferred = false): string => {
    const has = (name: string): boolean => offered === undefined || offered.includes(name);
    const canViewChart = has('get_chart_view');
    const canDraw = has('draw_on_chart') || has('mark_trade_levels');
    // The fallback names a tool that EXISTS here, in the order the seat can
    // actually use: the picture, then the frames, then the numbers. Nothing is
    // offered? Then the honest instruction is to say it looked at none.
    const groundingTool = canViewChart
        ? '`get_chart_view`'
        : has('get_all_timeframes')
            ? '`get_all_timeframes`'
            : has('get_indicators')
                ? '`get_indicators`'
                : null;
    const shapeRule = canViewChart
        ? 'BEFORE YOU NAME A SHAPE: a pattern, a trendline, a swing high/low, "higher lows", a triangle or a broken structure requires `get_chart_view` (or `get_all_timeframes` to compare frames) on this turn.'
        : groundingTool
            // Said as what this home IS, not as a missing tool: a seat that
            // reads a refusal as an absence still has to answer the question.
            // The name is deliberately NOT written in backticks here — the test
            // that pins "every tool the mandate names is a tool this turn can
            // call" is only worth having if it holds without an exception.
            ? `BEFORE YOU NAME A SHAPE: there is NO CHART to read on this home — the chart-view tool is not offered here, so a pattern, a trendline, a swing high/low, "higher lows" or a broken structure must come from ${groundingTool} on this turn, and you must say it came from the candles, not from the picture.`
            : 'BEFORE YOU NAME A SHAPE: no market read is offered on this turn, so a pattern, a trendline or a broken structure would be invented, not read — name none of them and say you had nothing to look at.';
    const drawingRule = canDraw
        ? 'Naming `draw_on_chart` or `mark_trade_levels` is how a level becomes something the trader can see: pass the exact prices you are citing, never restated ones.'
        : 'There is NO CANVAS on this home: nothing you name gets drawn, so a level is text the trader reads here. Pass the exact prices you are citing, never restated ones, and do not offer to draw.';
    // The card is a PUBLISH step with a computed feeder. Without this line the
    // model answered "key levels" from the packet's prose and either skipped
    // the fence or typed prices into it by hand; the app already computes them,
    // so the one honest instruction is "call, then copy".
    const levelRule = has('get_key_levels')
        ? ' When the user asks for KEY LEVELS (or asks where the levels are), call `get_key_levels` BEFORE you answer: it computes support/resistance, pivots, Fibonacci, round numbers and VWAP for the asked symbol/timeframe and returns a `key-levels` fence. Copy that fence VERBATIM at the end of your answer — it is what puts the Key Levels card on the chart. Never retype its prices.'
        : '';
    // The self-modification line rides ONLY when the trader turned the
    // capability on. An off switch that still advertised the tool would send the
    // seat to an executor that refuses it — the same mistake the chart rule
    // above exists to stop.
    const selfModRule = has('propose_self_change') && getHarnessSettings().selfModificationMode !== 'off'
        ? 'You run inside a harness you may adjust: `propose_self_change` moves a behavior knob (thinking effort, the confirmed-skill library cap — it reverts itself within 24h) or, in shadow mode, rewrites one prompt and lets the trades that run under it judge it. Call `list_self_changes` first: a target already in force must be reverted before it changes again, and a change you did not need is a change you should revert. Risk limits, privacy, memory, the prompt A/B settings and self-modification itself are blocked — asking for them is not a failure, it is a question for the trader.\n'
        : '';
    // Discovery is a WORKFLOW, not one lookup: the seat must know that a
    // shortlist and a chart switch are both calls it can make here, and that
    // a score is not a plan. Gated like the rest of the mandate, so a seat
    // whose allow-list refuses these tools is never told to call them.
    const discoveryRule = has('find_best_setups') && has('switch_chart_symbol')
        ? 'MARKET DISCOVERY: `find_best_setups` scans the whole universe and RANKS the best live setups by measured confluence (`run_screener` is the raw table behind it). `switch_chart_symbol` puts a coin on the live chart when the trader asks to look at it. A score is not a plan — read the chosen coin with `get_market_packet` (passing its symbol explicitly) before naming an entry, stop or target.\n'
        : '';
    // The market-structure rule (docs/plans/tools-upgrade.md §7): these
    // numbers exist so the seat never estimates them. Every tool named here
    // is gated on the seat's own allow-list — a seat whose executor would
    // refuse a name never reads that name. The closing sentence is the
    // anti-invention rule that binds the family.
    const structureBits: string[] = [];
    if (has('get_regime')) structureBits.push('`get_regime` classifies trend/range/volatility on a timeframe (tag your decision with its regime_id) — call it before a read whose meaning depends on regime');
    if (has('trade_math')) structureBits.push('`trade_math` computes the plan\'s own numbers — call it with your entry/stop/targets BEFORE presenting a trade and quote its R:R, net-of-costs and break-even, never your own arithmetic; it refuses an inverted plan');
    if (has('meta_label')) structureBits.push('`meta_label` reads the trader\'s own numbers against your plan — call it after `trade_math` and quote its TAKE/REDUCE/SKIP verdict WITH its reasons; it advises, it never refuses a card');
    const loadableFamily: string[] = [];
    if (has('volume_profile')) loadableFamily.push('`volume_profile` (POC/value area/price-vs-value)');
    if (has('naked_pocs')) loadableFamily.push('`naked_pocs` (unvisited prior-session POCs)');
    if (has('vwap')) loadableFamily.push('`vwap` (session or swing-anchored VWAP and who is trapped)');
    if (has('order_flow')) loadableFamily.push('`order_flow` (CVD/delta ESTIMATES from taker volume)');
    if (has('effort_vs_result')) loadableFamily.push('`effort_vs_result` (climax/churn)');
    if (has('auction_state')) loadableFamily.push('`auction_state` (initial balance, day type, open type)');
    if (has('swing_structure')) loadableFamily.push('`swing_structure` (HH/HL/LH/LL, BOS/CHoCH, fib with confluence)');
    if (has('liquidity')) loadableFamily.push('`liquidity` (equal levels, sweeps, untested swings, next pool)');
    if (has('imbalances')) loadableFamily.push('`imbalances` (FVGs with fill state)');
    if (has('sr_zones')) loadableFamily.push('`sr_zones` (S/R zones + premium/discount range state)');
    if (has('wyckoff_events')) loadableFamily.push('`wyckoff_events` (ranges, springs/UTADs — volume-conditioned)');
    if (has('setup_base_rate')) loadableFamily.push('`setup_base_rate` (the trader\'s measured W/L + Wilson CI for a setup type — refused under 5 rows)');
    if (has('risk_state')) loadableFamily.push('`risk_state` (open-plan heat, drawdown light, half-Kelly ceiling — advisory)');
    if (has('derivatives_state')) loadableFamily.push('`derivatives_state` (price/OI quadrant, funding percentile + extremes, positioning snapshot, liquidation bands — available:false for assets without derivatives, never invented)');
    if (has('btc_relative')) loadableFamily.push('`btc_relative` (alt/BTC ratio z-score, correlation/beta on returns, RS rank — works where derivatives data does not exist)');
    if (has('scan_playbooks')) loadableFamily.push('`scan_playbooks` (named setup detectors — rotation, failed IB, spring/UTAD, sweep+shift, absorption, pullback, Turtle Soup, VWAP reclaim — each with invalidation + evidence; a match is a tag, never a size or a veto)');
    if (loadableFamily.length > 0) structureBits.push(`load the structure/journal family when the read needs it: ${loadableFamily.join(', ')}`);
    if (has('draw_tool_levels')) structureBits.push('`draw_tool_levels` puts a tool\'s computed levels on the chart the way a trader plots them — name the tool, the app re-runs it and draws at the computed prices (you never restate a number)');
    const structureRule = structureBits.length > 0
        ? `MARKET STRUCTURE, COMPUTED: ${structureBits.join('. ')}. A level, a POC, a volume figure, a delta or a setup tag you did not read from a tool result this turn does not exist — state none, or name the read you are inferring from and strip its confidence.\n`
        : '';

    return `
**DESK TOOLS (available anytime on this turn)**
${deferred ? 'ONLY THE CORE TOOLS ARE LOADED. The TOOL CATALOGUE at the end lists the rest; call `load_tools` with exact names before you rely on one, and load several at once when the question needs them. A tool you have not loaded cannot be called this round.' : ''}
You can call live tools before you speak, on any question where a fresh fact would change the answer.
Use them for: news/macro catalysts, funding/OI crowding, order-book walls, liquidations, BTC context on alts, session timing, or a fresh price print.
The chart symbol is only the DEFAULT: the per-symbol market tools accept a \`symbol\` argument, so when the user asks about another coin ("what about eth, can we trade there?") pull that coin directly — get_market_packet or get_all_timeframes with symbol ETHUSDT gives the full multi-timeframe read without anyone switching charts. run_screener and find_best_setups are the exception: they scan the whole futures universe and take no symbol.
Your own trading memory is one of these tools: the recall tool searches your notebook (notes, rules, skills, similar past trades) - call it when prior experience with this setup could change your stance.
${shapeRule} The market packet you are shown carries code-calculated summaries, and its printed candle rows depend on the surface you were opened in: the full packet prints EIGHT rows per timeframe, the compact one (used by surfaces that ask for brevity) prints NONE and keeps only the summaries. Either way — eight printed rows are not a chart, and a shape described from them is invented, not read. If the rows are not in front of you, call ${groundingTool ?? 'nothing'}; if you have not, either call it or say "inferred from the rows shown" and give it no confidence. ${drawingRule}${levelRule}
${has('run_monte_carlo') ? 'run_monte_carlo simulates a concrete plan: pass direction (long/short), entry, stop_loss, and take_profits (1–3 absolute prices). Volatility is MEASURED from the tape (ATR14 at the requested timeframe) when you omit atr; the call is refused — never simulated on an assumption — when the tape cannot be measured, so pass atr explicitly only to override the measurement, and the receipt will say the number was caller-supplied. Optional timeframe is a label, num_simulations (100–5000) and max_steps (10–1000) control the run. For account drawdown estimates pass account_balance, position_size (margin in account currency), and leverage together. Report the simulation assumptions and timeout rate, not guaranteed or historical performance.' : ''}${selfModRule}${discoveryRule}${structureRule}Do not call tools you do not need. Prefer 0–2 calls. After tool results arrive, write your reply from the findings — no JSON, no restated tool schemas.
`;
};

/** The mandate for a turn that can call every desk tool (the dock, an analysis
 *  send). Built from `deskToolsMandateFor` so the two cannot drift apart. */
export const DESK_TOOLS_PROMPT = deskToolsMandateFor();

export const MARKET_TOOLS = new Set([
    'get_market_packet',
    'get_all_timeframes',
    'get_chart_view',
    'get_order_book',
    'get_derivatives',
    'get_liquidations',
    'get_price_snapshot',
    'get_indicators',
    'get_btc_context',
    'scan_setups',
    'project_future_price',
    'get_setup_history_stats',
    'run_monte_carlo',
]);

/**
 * The tools whose call READ the market (or the trader's own market record).
 *
 * `MARKET_TOOLS` answers a different question — "does this result need the coin
 * named?" — so it does not include `get_trade_log` or `run_screener`. This set
 * is the one the Full-analysis / scheduled-run check asks: a memory read, a
 * skill edit, `decline_trade`, or `present_trade` is NOT looking at the tape,
 * and must not silence "nothing was looked up".
 */
export const MARKET_READ_TOOLS = new Set([
    ...MARKET_TOOLS,
    'get_session_context',
    'get_trade_log',
    'run_screener',
    'find_best_setups',
]);

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
