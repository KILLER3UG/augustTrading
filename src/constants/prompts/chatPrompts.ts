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
import { buildChatSurfaceSystemPrompt, REASONING_CHANNEL_PROMPT } from './tradingKernel';

export { REASONING_CHANNEL_PROMPT };

export const CASUAL_CHAT_SYSTEM_PROMPT = `You are a helpful and concise AI assistant specializing in futures trading concepts.

${REASONING_CHANNEL_PROMPT}

OUTPUT: answer directly, in prose, from the first sentence. No restated instructions, no section template, no "here's my thinking" or "final output" preamble, and no narration of what you are about to say. Anything you work out before answering stays out of this reply.`;

/**
 * The Agents/Chat surface's standing mandate (stage 20s): composed from the
 * single canonical `tradingKernel` so Desk and Chat cannot drift apart.
 */
export const CHAT_SURFACE_SYSTEM_PROMPT = buildChatSurfaceSystemPrompt('standard');
