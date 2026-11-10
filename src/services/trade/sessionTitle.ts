/**
 * sessionTitle — the model names a chat, once, in the background.
 *
 * The instant fallback (`titleFromMessage` in the dock, `conversationTitle` on
 * the Chat surface) is what makes a thread readable the moment it exists. This
 * module is the SECOND half: after the first exchange settles, one small
 * non-streaming call asks the configured background/memory model for a short
 * name and hands the answer through the pure sanitizer in
 * `utils/conversationTitle.ts`. The caller applies it only if the row still
 * carries that fallback — a trader's rename is never overwritten.
 *
 * NON-NEGOTIABLE: this never blocks, delays or reorders a chat turn. Callers
 * fire it and forget (`void generateSessionTitle(...).then(...).catch(...)`);
 * nothing in a send path awaits it, and a null/throw leaves the existing title
 * exactly as it was.
 *
 * The provider is the SAME one the app already uses for background work
 * (`MemoryModelService.resolveMemoryConfig`, i.e. Settings → Memory model —
 * the `memoryConfig` the React tree hydrates from the profile's
 * `settings.memoryProvider`). It falls back to the caller's active chat
 * provider only when no background provider resolves. No model is hardcoded
 * and no new provider path exists: the call rides `getQuickResponse`, the one
 * non-streaming transport every background pass uses.
 *
 * Both provider imports are lazy so this module (imported by the dock commit
 * path and the conversation store) stays tiny and the transport subtree loads
 * only when a title is actually asked for.
 */

import type { ProviderConfig } from '../../types/provider';
import {
    modelTitleMayReplace,
    sanitizeSessionTitle,
    SESSION_TITLE_MAX_CHARS,
    SESSION_TITLE_MAX_WORDS,
    SESSION_TITLE_MIN_WORDS,
} from '../../utils/conversationTitle';

export { modelTitleMayReplace, sanitizeSessionTitle };
export { SESSION_TITLE_MAX_CHARS, SESSION_TITLE_MAX_WORDS, SESSION_TITLE_MIN_WORDS };

const SYSTEM_INSTRUCTION = 'You name trading conversations. Answer with the title only — no explanation, no quotes and no markdown.';

/** How much of the exchange the title call reads. A title needs the subject,
 *  not the whole argument; the caps also keep a 40k-char analysis from making
 *  a cheap background call expensive. */
const MAX_QUESTION_CHARS = 1_200;
const MAX_ANSWER_CHARS = 1_800;

const clip = (text: string, max: number): string =>
    (text.length > max ? text.slice(0, max) : text);

const titlePrompt = (question: string, answer: string): string => [
    `Name the conversation below in ${SESSION_TITLE_MIN_WORDS} to ${SESSION_TITLE_MAX_WORDS} words.`,
    '- Name the actual subject: the instrument, setup, level or decision (for example: "BTC funding exhaustion short").',
    '- Plain text on one line. No quotes, no markdown, no trailing punctuation.',
    '- Never start with "Session", "Chat" or "Conversation".',
    '',
    `TRADER: ${question}`,
    `DESK: ${answer}`,
    '',
    'TITLE:',
].join('\n');

export interface GenerateSessionTitleInput {
    /** The first question the trader asked in this thread. */
    question: string;
    /** The settled answer that followed it. */
    answer: string;
    /** The active chat provider — a FALLBACK only, used when no
     *  background/memory provider resolves. Never a hardcoded model. */
    fallback?: ProviderConfig | null;
    /** The trader whose profile names the memory provider. */
    username?: string;
}

/**
 * Ask the configured background model to name one conversation. Resolves to a
 * sanitized title, or null when there is nothing to name, no provider, the
 * call fails, or the answer breaks the brief. Never throws on a provider
 * problem it can report as null — but callers still attach `.catch`, because a
 * title must never cost the turn that produced it.
 */
export const generateSessionTitle = async ({
    question,
    answer,
    fallback = null,
    username,
}: GenerateSessionTitleInput): Promise<string | null> => {
    const asked = clip(question.replace(/\s+/g, ' ').trim(), MAX_QUESTION_CHARS);
    const replied = clip(answer.replace(/\s+/g, ' ').trim(), MAX_ANSWER_CHARS);
    if (!asked || !replied) return null;
    const [{ getQuickResponse }, { resolveMemoryConfig }] = await Promise.all([
        import('../providers/GenericProviderService'),
        import('../learning/MemoryModelService'),
    ]);
    let resolved: ProviderConfig | null;
    try {
        resolved = await resolveMemoryConfig(username);
    } catch {
        resolved = null;
    }
    const config = resolved ?? fallback;
    if (!config) return null;
    const raw = await getQuickResponse(config, titlePrompt(asked, replied), SYSTEM_INSTRUCTION, {
        // A title is a handful of tokens; the ceiling is generous only so a
        // reasoning model cannot spend its whole budget on hidden thinking and
        // return an empty visible answer (the same failure the quick-response
        // callers already guard against).
        maxTokens: 120,
        temperature: 0.2,
    });
    return sanitizeSessionTitle(raw);
};
