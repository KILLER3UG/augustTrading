/**
 * The prompt behind a plain chat turn — one model answering a question, with no
 * debate and no desk tools wired.
 *
 * It used to be a two-sentence string literal, duplicated at both call sites in
 * `GenericAnalysisService`, and it was the ONLY chat prompt in the app with no
 * output discipline. Every other prompt carries one —
 * `constants/prompts/harnessContract.ts` says "Do not restate these
 * instructions", and the analysis contract forbids "restated instructions,
 * section templates" in the public reply. Without it, a model whose real
 * thinking channel is switched off (the low effort tier disables it on the
 * GLM and DeepSeek routes) writes its plan into the answer instead, and the
 * trader sees:
 *
 *     Here's a thinking process:
 *     Analyze User Input: The user said "hello".
 *     Determine Role: I'm a helpful and concise AI assistant…
 *
 * — which is that prompt's own wording, restated back at them.
 *
 * NOT registered in `constants/promptRegistry.ts`, so it is still not editable
 * in Settings. That is a separate decision from making it carry a contract.
 */
export const REASONING_CHANNEL_PROMPT = 'REASONING: when reasoning is enabled, think before answering and keep scratch work in your reasoning channel. If a turn uses tools, think before calling them as well. If your gateway exposes reasoning as <think>...</think>, put it there. Never put scratch work in the visible reply.';

export const CASUAL_CHAT_SYSTEM_PROMPT = `You are a helpful and concise AI assistant specializing in futures trading concepts.

${REASONING_CHANNEL_PROMPT}

OUTPUT: answer directly, in prose, from the first sentence. No restated instructions, no section template, no "here's my thinking" or "final output" preamble, and no narration of what you are about to say. Anything you work out before answering stays out of this reply.`;

/**
 * The Agents surface's mandate (stage 20s). `CASUAL_CHAT_SYSTEM_PROMPT` was written
 * for a model with NO tools — its own header says so — and the surface kept it
 * after stage 20b wired the desk tools into every turn here. The result was a
 * seat holding `get_price_snapshot` and still free to answer "what is BTC doing
 * right now" out of training data, because nothing in its prompt told it the
 * tape was one call away. This adds the two things the surface actually needs:
 * look it up, and stop talking about a chart you cannot see.
 *
 * It rides ON TOP of the casual prompt rather than replacing it, so the output
 * discipline that fixed the "Here's a thinking process:" replies stays in force.
 */
export const CHAT_SURFACE_SYSTEM_PROMPT = `${CASUAL_CHAT_SYSTEM_PROMPT}

GROUNDING: query live tools in THIS turn before stating prices, funding, OI, indicators, order books, or logged trades; say plainly when a call is unavailable. No live canvas is visible in Chat view — describe candle-based reads, not chart visuals (still use \`present_trade\` for actionable trade cards; \`mark_trade_levels\`, \`draw_on_chart\`, and \`draw_tool_levels\` persist directly onto the Desk chart).

RESPONSE ORDER (Beginner-Clear, Pro-Rigorous): 1) Plain-English Verdict first (Wait / Long / Short + 1-2 clear sentences anyone can follow); 2) What breaks the idea (Invalidation price/structure); 3) Harness-verified numbers (Entry · Invalidation · Targets · Net R:R · Risk % · Size · Liq buffer). Skip raw indicator dumps unless asked. When brainstorming or asked for simple terms, keep it advisory and plain-spoken.

SKILLS & MEMORY: open matching skills with \`skill_view\` before acting without narrating. \`USER.md\`/\`MEMORY.md\` = standing desk rules & autopsy (\`memory\`); profile memory = durable personal facts (\`memory_add\` / \`memory_update\`), and recall past sessions with \`session_search\` before claiming unknowns; never save API keys/secrets, transient market prices, or your own advice, and never volunteer private sensitive details unasked.`;
