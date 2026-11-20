/**
 * steeringProtocol — the mid-turn steering wire format (pi-style two-speed
 * input), as ONE pure builder both the loop and the tests read.
 *
 * THE PAIRING RULE is the whole module: when steering interrupts a batch of
 * emitted-but-unexecuted tool calls, a strict OpenAI-compatible provider
 * requires an assistant `tool_calls` message to be followed by a `tool` reply
 * for EVERY id it named. The steering therefore ships a synthetic
 * "Skipped: user steered mid-turn" reply per id before the steering user
 * message lands — the model reads a complete, honest transcript of what was
 * skipped and why, and the seat never 400s.
 */

import type { ChatMessage } from '../providers/GenericProviderService';

/** The literal every skipped call carries — the contract the tests pin. */
export const STEER_SKIPPED_TEXT = 'Skipped: user steered mid-turn.';

interface ExecutedRound {
    /** The assistant message as the transport built it (tool_calls present on
     *  native transports; null on the text protocol). */
    assistantMessage: import('../providers/GenericProviderService').ChatMessage | null;
    /** The round's raw text (tags included) — used on the text protocol. */
    text: string;
}

/** Build the messages a steering injection appends: the assistant turn, the
 *  synthetic per-id replies (native transport only), and the steering itself
 *  as a user message. */
export const buildSteerSyntheticMessages = (round: ExecutedRound, steeringText: string): ChatMessage[] => {
    const out: ChatMessage[] = [];
    if (round.assistantMessage?.tool_calls?.length) {
        out.push({ role: 'assistant', content: round.assistantMessage.content, tool_calls: round.assistantMessage.tool_calls } as ChatMessage);
        for (const tc of round.assistantMessage.tool_calls) {
            if (!tc.id) continue;
            out.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `Skipped: user steered mid-turn.`,
            } as ChatMessage);
        }
    } else {
        // Text protocol: strip the transport tags — the attempted call is
        // transport, not prose — and say honestly that nothing ran.
        out.push({ role: 'assistant', content: round.text.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim() });
        out.push({
            role: 'user',
            content: `[HARNESS] ${STEER_SKIPPED_TEXT} Your pending tool call did not run. The trader says: ${steeringText}`,
        });
        return out;
    }
    out.push({ role: 'user', content: steeringText });
    return out;
};
