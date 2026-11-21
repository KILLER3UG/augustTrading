/**
 * Trace-text presentation helpers. Thinking rows and tool-activity rows
 * render model chain-of-thought and harness event lines as PLAIN
 * transcript chrome (no markdown pass), so the emphasis markers models
 * lean on in their scratchpads must be peeled, not escaped. The strip is
 * deliberately conservative: paired ** / __ / * emphasis, headers,
 * leading list bullets/numbers, code fences and backticks. Single
 * underscores survive — they light up tool names like `scan_setups`.
 */

/** Paired emphasis first, so a leading `**Note:` stops looking like a
 *  bullet before the list-marker strip runs. */
const EMPHASIS_PAIRS: Array<[RegExp, string]> = [
    [/\*\*([^*]+)\*\*/g, '$1'],
    [/__([^_]+)__/g, '$1'],
    [/\*([^*\s][^*]*)\*/g, '$1'],
];

/** Peel markdown markers from trace text (multiline-safe). Unpaired
 *  orphan `**`/`__` runs — common when a stream is cut mid-emphasis —
 *  are dropped after the paired pass. */
export const stripTraceMarkers = (text: string): string => {
    let out = text
        .replace(/<\/?(?:think|thinking|thought|reasoning|REASONING_SCRATCHPAD|redacted_thinking)\b[^>]*>/gi, '')
        .replace(/<\|(?:begin_of_thought|end_of_thought|\/?think)\|>/gi, '')
        .replace(/◁\/?think▷/gi, '')
        .replace(/```[a-z]*/gi, '');
    for (const [re, to] of EMPHASIS_PAIRS) out = out.replace(re, to);
    return out
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^[ \t]*[-*•·][ \t]+/gm, '')
        .replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, '')
        .replace(/`/g, '')
        .replace(/\*\*|__/g, '')
        .replace(/^[_*~\-—]{3,}\s*$/gm, '')
        .replace(/[ \t]+$/gm, '');
};

/** Non-empty, marker-stripped lines of a trace — one bullet each. */
export const traceLines = (text: string): string[] =>
    text.split('\n')
        .map(line => stripTraceMarkers(line).trim())
        .filter(Boolean);

/**
 * The desk-tool loop mirrors every tool event into the reasoning stream as
 * a `[Desk tools] …` line — those mirrors are the CUT POINTS of the
 * ZCode-style work timeline: thinking segments interleave with the tool
 * events that interrupted them. Returns the reasoning split into segments
 * where segment i is separated from segment i+1 by tool event i (so
 * segments.length - 1 === number of interleaved tool events, in order).
 */
export const splitReasoningAroundTools = (reasoning: string): string[] =>
    reasoning.split(/\s*\[Desk tools\][^\n]*\n?/g);

/**
 * Every trace a message carries, as one string — the Thinking row's text.
 *
 * `thoughtProcesses` is the LIVE map. `reasoningProcesses` was the DELETED
 * debate engine's own lane, and the two used to be joined at every read
 * site, which is how a dead field stayed alive for years: three readers, no
 * writer. The key is off the `Message` type now, so nothing may write it —
 * but rows persisted before the engine was deleted still carry the
 * moderator's trace in it, and dropping it unread would blank the Thinking
 * row on those old transcripts. So it is read HERE, once, and folded in.
 *
 * The legacy lane is read through a cast, deliberately: a field nobody may
 * write is a field nobody may depend on, and the cast keeps that promise
 * local to this function instead of spreading a second vocabulary.
 */
export const messageTraceText = (m: {
    thoughtProcesses?: Record<string, string>;
}): string => {
    const legacy = Object.values(
        (m as { reasoningProcesses?: Record<string, string> }).reasoningProcesses ?? {},
    );
    const live = Object.values(m.thoughtProcesses ?? {});
    return [...legacy, ...live]
        .filter(t => !!t && t.trim().length > 0)
        .join('\n\n');
};
