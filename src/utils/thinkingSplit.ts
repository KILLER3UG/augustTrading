/**
 * Keep chain-of-thought out of the final answer (and vice versa).
 * Tags and scratchpads never stay in the user-visible reply, even when a
 * model dumps them into `content`.
 */

import { noteThinkingLeak, stillLooksLikeLeakedThinking } from './thinkingLeakBin';

const PLAN_RE = /FINAL TRADE PLAN|\b(?:Direction|Stop Loss|Take Profit(?:\s*[123])?|Invalidation)\s*:/i;

const SCRATCHPAD_START_RE = /(?:^|\n)\s*(?:here(?:['’]s| is)\s+(?:my\s+)?(?:a\s+)?)?thinking\s+process\s*:/i;
const SCRATCHPAD_META_RE = /Analyze User Input\s*:|Deconstruct (?:the )?Context|Current Round\s*:|YOUR TASK\b|The user (?:is asking|wants|asked)\b/i;
const THINK_TAG_RE = /<(?:think|thinking|thought|reasoning|REASONING_SCRATCHPAD)|<\|begin_of_thought\||\[(?:THINKING|REASONING)\]|◁think▷/i;
const LET_ME_THINK_RE = /(?:^|\n)\s*(?:okay[,.]?\s+)?(?:so[,.]?\s+)?(?:let me think|let's think|thinking out loud|internal monologue|chain of thought|wait,\s+i\b)\b/i;
const ANSWER_MARK_RE = /(?:^|\n)\s*(?:\*\*)?(?:answer|final(?:\s*output)?|response|conclusion|verdict|solution)(?:\*\*)?\s*[:.-]\s*/i;
const META_PARA_RE = /^(?:Analyze User Input|Deconstruct|My State|Role\s*:|Current Round\s*:|YOUR TASK|Moderator's question|Here's a thinking|Let me think|The user (?:is asking|wants)|I need to (?:analyze|weigh|consider|answer|give|correct|state))/i;
/** Prompt-echo / agent-scratchpad tells. Models trained on traces restate these instead of answering. */
const PROMPT_ECHO_RE = /Analyze User Input\s*:|Deconstruct (?:the )?Context|YOUR TASK\b|Current Round\s*:|Moderator's question\s*:|thinking process\s*:|I(?:['’]m| am) in a debate|ensemble scenario|60-?100 words|plain prose(?: only)?|no JSON\s*\/?\s*XML|I need to (?:answer|give|correct|state)|I must (?:correct|answer)/i;

export const looksLikeTradeOutput = (text: string): boolean => {
    if (!text || text.length < 40) return false;
    const plan = /FINAL TRADE PLAN/i.test(text);
    const levels = /\b(Stop Loss|SL)\b/i.test(text) && /\b(Take Profit|TP\s*1)\b/i.test(text);
    const entry = /\bEntr(?:y|ies)\b/i.test(text) && /\bDirection\b/i.test(text);
    return plan || (levels && entry) || (PLAN_RE.test(text) && levels);
};

const eq = (a: string, b: string): boolean => a.trim() === b.trim();

const THINK_TAG_NAMES = 'think|thinking|thought|reasoning|REASONING_SCRATCHPAD|redacted_thinking';
const THINK_BLOCK_RE = new RegExp(`<(${THINK_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
const THINK_ORPHAN_RE = new RegExp(`<\\/?(?:${THINK_TAG_NAMES})\\b[^>]*>`, 'gi');
const THINK_CLOSE_RE = new RegExp(`<\\/(?:${THINK_TAG_NAMES})>`, 'i');
const THINK_OPEN_RE = new RegExp(`<(${THINK_TAG_NAMES})\\b[^>]*>`, 'i');

const SPECIAL_THINK_RE = /<\|begin_of_thought\|>([\s\S]*?)<\|end_of_thought\|>/gi;
const SPECIAL_SOLUTION_RE = /<\|begin_of_solution\|>([\s\S]*?)<\|end_of_solution\|>/gi;
const BRACKET_THINK_RE = /\[(?:THINKING|THINK|REASONING)\]([\s\S]*?)\[\/(?:THINKING|THINK|REASONING)\]/gi;
const FENCE_THINK_RE = /```(?:thinking|thought|reasoning|scratchpad)\s*\n([\s\S]*?)```/gi;
const UNICODE_THINK_RE = /◁think▷([\s\S]*?)◁\/think▷/gi;

const takeMatches = (raw: string, re: RegExp): { visible: string; leaked: string[] } => {
    const leaked: string[] = [];
    const visible = raw.replace(re, (_all, inner: string) => {
        if (inner?.trim()) leaked.push(inner.trim());
        return '';
    });
    return { visible, leaked };
};

/** Tags never stay in the answer. */
export const extractAndStripThinkBlocks = (text: string): { visible: string; leaked: string } => {
    let visible = text || '';
    const leaked: string[] = [];

    const special = takeMatches(visible, SPECIAL_THINK_RE);
    visible = special.visible;
    leaked.push(...special.leaked);
    const solution = takeMatches(visible, SPECIAL_SOLUTION_RE);
    if (solution.leaked.length > 0) {
        visible = solution.leaked.join('\n\n');
    } else {
        visible = solution.visible;
    }
    const bracket = takeMatches(visible, BRACKET_THINK_RE);
    visible = bracket.visible;
    leaked.push(...bracket.leaked);
    const fence = takeMatches(visible, FENCE_THINK_RE);
    visible = fence.visible;
    leaked.push(...fence.leaked);
    const unicode = takeMatches(visible, UNICODE_THINK_RE);
    visible = unicode.visible;
    leaked.push(...unicode.leaked);

    if (THINK_OPEN_RE.test(visible) || THINK_CLOSE_RE.test(visible)) {
        visible = visible
            .replace(THINK_BLOCK_RE, (block, name: string) => {
                const inner = block.replace(new RegExp(`^<${name}\\b[^>]*>|<\\/${name}>$`, 'gi'), '').trim();
                if (inner) leaked.push(inner);
                return '';
            });
        const closeAt = visible.search(THINK_CLOSE_RE);
        const openAt = visible.search(THINK_OPEN_RE);
        if (closeAt >= 0 && (openAt < 0 || closeAt < openAt)) {
            const before = visible.slice(0, closeAt).replace(THINK_ORPHAN_RE, '').trim();
            const after = visible.slice(closeAt).replace(THINK_CLOSE_RE, '').replace(THINK_ORPHAN_RE, '').trim();
            if (before) leaked.push(before);
            visible = after;
        } else if (openAt >= 0) {
            const before = visible.slice(0, openAt).replace(THINK_ORPHAN_RE, '').trim();
            const afterOpen = visible.slice(openAt);
            const closed = afterOpen.match(THINK_BLOCK_RE);
            if (closed) {
                visible = (before + '\n\n' + afterOpen.replace(THINK_BLOCK_RE, '')).replace(THINK_ORPHAN_RE, '').trim();
            } else {
                const inner = afterOpen.replace(THINK_ORPHAN_RE, '').trim();
                if (inner) leaked.push(inner);
                visible = before;
            }
        }
        visible = visible.replace(THINK_ORPHAN_RE, '');
    }

    return {
        visible: visible.replace(/\n{3,}/g, '\n\n').trim(),
        leaked: leaked.filter(Boolean).join('\n\n').trim(),
    };
};

const stripTags = (text: string): string => extractAndStripThinkBlocks(text).visible
    .replace(/<FINAL_OUTPUT>[\s\S]*?<\/FINAL_OUTPUT>/gi, '')
    .replace(/<\/?FINAL_OUTPUT>/gi, '')
    .replace(/^\s*(?:\*\*)?(?:THINKING|FINAL OUTPUT|FINAL_OUTPUT|REASONING|ANSWER)(?:\*\*)?\s*:?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const looksLikePromptEcho = (text: string): boolean => PROMPT_ECHO_RE.test(text || '');

export const looksLikeScratchpad = (text: string): boolean => {
    const raw = (text || '').trim();
    if (!raw) return false;
    return SCRATCHPAD_START_RE.test(raw)
        || SCRATCHPAD_META_RE.test(raw)
        || THINK_TAG_RE.test(raw)
        || LET_ME_THINK_RE.test(raw)
        || looksLikePromptEcho(raw);
};

/** A public debate/trade reply — not a restated prompt or planning paragraph. */
export const looksLikePublicAnswer = (text: string): boolean => {
    const raw = (text || '').trim();
    if (!raw || looksLikePromptEcho(raw)) return false;
    if (looksLikeTradeOutput(raw)) return true;
    const words = raw.split(/\s+/).length;
    if (words < 6 || META_PARA_RE.test(raw)) return false;
    const hasCall = /\b(Long|Short|Neutral|Avoid|Buy|Sell)\b/i.test(raw);
    const hasLevel = /\b(?:Entry|SL|TP\s*[123]|Stop\s*Loss|Take\s*Profit|R\s*[:/]\s*R)\b/i.test(raw);
    return hasCall && hasLevel;
};

const stripNormalizedPrefix = (output: string, prefix: string): string => {
    let i = 0;
    let j = 0;
    while (i < prefix.length && j < output.length) {
        if (/\s/.test(prefix[i])) { i += 1; continue; }
        if (/\s/.test(output[j])) { j += 1; continue; }
        if (prefix[i] !== output[j]) return output;
        i += 1;
        j += 1;
    }
    if (i < prefix.length) return output;
    return output.slice(j).trim();
};

const dropParagraphsAlreadyInThinking = (output: string, thinking: string): string => {
    const thinkNorm = thinking.replace(/\s+/g, ' ');
    if (!thinkNorm || !output.trim()) return output;
    const paras = output.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paras.length === 0) return output;
    const kept = paras.filter(p => {
        const n = p.replace(/\s+/g, ' ').trim();
        if (n.length < 32) return true;
        return !thinkNorm.includes(n.slice(0, Math.min(160, n.length)));
    });
    if (kept.length === 0) {
        return looksLikePublicAnswer(output) || looksLikeTradeOutput(output) ? output : '';
    }
    return kept.join('\n\n');
};

/**
 * What the Final output bubble may show. Thinking already on screen must
 * never be copied into the reply — native CoT often repeats in the markdown
 * content stream after the thinking channel has already filled.
 */
export const visibleReplyFromThinking = (thinking: string, output: string): string => {
    const split = splitThinkingFromOutput(thinking || '', output || '');
    let visible = split.output;
    if (!visible) return '';
    if (thinking) {
        visible = stripNormalizedPrefix(visible, thinking);
        visible = dropParagraphsAlreadyInThinking(visible, thinking);
    }
    if (visible && thinking && eq(visible, thinking)) return '';
    if (visible && looksLikeScratchpad(visible) && !looksLikePublicAnswer(visible) && !looksLikeTradeOutput(visible)) {
        return '';
    }
    return visible.trim();
};

/**
 * Peel "Here's a thinking process / Analyze User Input" dumps out of the
 * visible floor. If there is no real answer yet, visible is empty.
 * Never promote a leftover planning paragraph just because it is long.
 */
export const stripLeakedScratchpad = (text: string): { visible: string; leaked: string } => {
    const raw = (text || '').trim();
    if (!raw) return { visible: '', leaked: '' };
    if (!looksLikeScratchpad(raw)) return { visible: raw, leaked: '' };

    const start = raw.search(SCRATCHPAD_START_RE);
    const leakStart = start >= 0 ? start : 0;
    const before = raw.slice(0, leakStart).trim();
    const rest = raw.slice(leakStart);

    const answerAt = rest.search(ANSWER_MARK_RE);
    if (answerAt >= 0) {
        const after = rest.slice(answerAt).replace(ANSWER_MARK_RE, '').trim();
        if (!after || looksLikePublicAnswer(after) || looksLikeTradeOutput(after) || !looksLikePromptEcho(after)) {
            return {
                visible: [before, after].filter(Boolean).join('\n\n'),
                leaked: rest.slice(0, answerAt).trim(),
            };
        }
    }

    const paras = rest.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const tail = [...paras].reverse().find(p => looksLikePublicAnswer(p));
    if (tail) {
        return {
            visible: [before, tail].filter(Boolean).join('\n\n'),
            leaked: rest.replace(tail, '').trim(),
        };
    }

    if (before && looksLikePublicAnswer(before)) return { visible: before, leaked: rest };
    if (looksLikeTradeOutput(raw) && !looksLikePromptEcho(raw)) return { visible: raw, leaked: '' };
    return { visible: '', leaked: raw };
};

export const splitThinkingHeaders = (raw: string): { thinking: string; output: string } => {
    const headerRe = /^\s*(?:\*\*|#{1,3}\s*)?(THINKING|REASONING|SCRATCHPAD|INTERNAL(?:\s+MONOLOGUE)?|CHAIN OF THOUGHT|FINAL OUTPUT|FINAL_OUTPUT|ANSWER|RESPONSE|VERDICT|SOLUTION|CONCLUSION)(?:\*\*)?\s*:?[ \t]*\r?\n?/gim;
    const matches = [...raw.matchAll(headerRe)];
    if (matches.length === 0) return { thinking: '', output: '' };

    const thinkKeys = /^(THINKING|REASONING|SCRATCHPAD|INTERNAL|CHAIN OF THOUGHT)/i;
    const outKeys = /^(FINAL OUTPUT|FINAL_OUTPUT|ANSWER|RESPONSE|VERDICT|SOLUTION|CONCLUSION)/i;
    const sections: Array<{ kind: 'think' | 'out'; text: string }> = [];
    matches.forEach((match, i) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
        const label = match[1];
        const kind = outKeys.test(label) ? 'out' : thinkKeys.test(label) ? 'think' : 'out';
        sections.push({ kind, text: raw.slice(start, end).trim() });
    });
    const thinking = sections.filter(s => s.kind === 'think').map(s => s.text).filter(Boolean).join('\n\n');
    const output = sections.filter(s => s.kind === 'out').map(s => s.text).filter(Boolean).join('\n\n');
    if (thinking && output) return { thinking, output };
    if (thinking && !output) {
        const prefix = raw.slice(0, matches[0].index ?? 0).trim();
        return { thinking, output: prefix };
    }
    if (!thinking && output && matches[0].index && matches[0].index > 0) {
        return { thinking: raw.slice(0, matches[0].index).trim(), output };
    }
    return { thinking, output };
};

/**
 * Split a model turn into thinking vs visible answer.
 * Native streamed CoT wins for thinking. The content stream wins for output.
 * Never copy one into the other as a fallback.
 */
export const splitThinkingFromOutput = (
    streamedReasoning: string,
    responseText: string,
): { thinking: string; output: string } => {
    const streamed = (streamedReasoning || '').trim();
    const raw = (responseText || '').trim();
    const taggedThinking = raw.match(/<(?:THINKING|THINK|THOUGHT)>\s*([\s\S]*?)\s*<\/(?:THINKING|THINK|THOUGHT)>/i)?.[1]?.trim() ?? '';
    const taggedOutput = raw.match(/<FINAL_OUTPUT>\s*([\s\S]*?)\s*<\/FINAL_OUTPUT>/i)?.[1]?.trim() ?? '';
    const headers = splitThinkingHeaders(raw);
    const inlineThink = extractAndStripThinkBlocks(raw);

    let thinking = streamed || taggedThinking || headers.thinking || inlineThink.leaked;
    let output = taggedOutput || headers.output || (raw ? (inlineThink.visible || stripTags(raw)) : '');

    if (headers.thinking && headers.output) {
        thinking = streamed || headers.thinking;
        output = taggedOutput || headers.output;
    } else if (inlineThink.leaked) {
        thinking = streamed || inlineThink.leaked;
        output = taggedOutput || inlineThink.visible;
    }

    if (!raw && streamed) {
        thinking = streamed;
        output = '';
    }

    // Content often repeats the native CoT then the answer. Strip the prefix
    // so Thinking owns the CoT and the reply is only the leftover.
    if (streamed && output && output.startsWith(streamed)) {
        thinking = streamed;
        output = output.slice(streamed.length).trim();
    } else if (streamed && output) {
        const stripped = stripNormalizedPrefix(output, streamed);
        if (stripped !== output) {
            thinking = streamed;
            output = stripped;
        } else {
            const idx = output.indexOf(streamed);
            if (idx >= 0 && idx < 80) {
                thinking = streamed;
                output = (output.slice(0, idx) + output.slice(idx + streamed.length)).trim();
            }
        }
    }

    if (thinking && output && eq(thinking, output)) {
        if (looksLikeTradeOutput(output)) thinking = '';
        else output = '';
    }

    if (thinking && looksLikeTradeOutput(thinking)) {
        if (!output || eq(thinking, output)) output = thinking;
        thinking = streamed && !looksLikeTradeOutput(streamed) ? streamed : '';
    }

    if (output && eq(thinking, output)) thinking = '';

    const peeled = stripLeakedScratchpad(output);
    if (peeled.leaked) {
        thinking = [thinking, peeled.leaked].filter(Boolean).join('\n\n').trim();
        output = peeled.visible;
    }

    if (output && looksLikeScratchpad(output) && !looksLikeTradeOutput(output) && !ANSWER_MARK_RE.test(output)) {
        thinking = [thinking, output].filter(Boolean).join('\n\n').trim();
        output = '';
    }

    if (output && looksLikePromptEcho(output) && !looksLikePublicAnswer(output) && !looksLikeTradeOutput(output)) {
        thinking = [thinking, output].filter(Boolean).join('\n\n').trim();
        output = '';
    }

    const next = { thinking: thinking.trim(), output: output.trim() };
    if (stillLooksLikeLeakedThinking(next.output)) noteThinkingLeak(next.output);
    return next;
};

const THINK_OPEN_CLOSE: Array<{ open: RegExp; close: RegExp }> = [
    { open: /<(think|thinking|thought|reasoning|REASONING_SCRATCHPAD|redacted_thinking)\b[^>]*>/i, close: /<\/(?:think|thinking|thought|reasoning|REASONING_SCRATCHPAD|redacted_thinking)>/i },
    { open: /<\|begin_of_thought\|>/i, close: /<\|end_of_thought\|>/i },
    { open: /\[(?:THINKING|THINK|REASONING)\]/i, close: /\[\/(?:THINKING|THINK|REASONING)\]/i },
    { open: /◁think▷/i, close: /◁\/think▷/i },
];

const holdIncompleteTag = (buf: string): string => {
    const lt = buf.lastIndexOf('<');
    const br = buf.lastIndexOf('[');
    const uni = buf.lastIndexOf('◁');
    const start = Math.max(lt, br, uni);
    if (start < 0) return '';
    const tail = buf.slice(start);
    if (
        /^<\/?[a-zA-Z|/_]*$/.test(tail)
        || /^\[[A-Za-z/]*$/.test(tail)
        || /^<\|[a-z_]*$/.test(tail)
        || /^◁\/?[a-zA-Z]*$/.test(tail)
    ) return tail;
    return '';
};

/**
 * Live content gate: route think-tag bodies to the reasoning channel and
 * only yield the public answer. Incomplete tags stay buffered across chunks.
 */
export const createThinkingStreamGate = (): {
    push: (chunk: string) => { visible: string; thinking: string };
    flush: () => { visible: string; thinking: string };
} => {
    let buf = '';
    let closeRe: RegExp | null = null;
    return {
        push(chunk: string): { visible: string; thinking: string } {
            if (!chunk) return { visible: '', thinking: '' };
            buf += chunk;
            let visible = '';
            let thinking = '';
            for (;;) {
                if (closeRe) {
                    const match = buf.match(closeRe);
                    if (!match || match.index === undefined) {
                        const hold = holdIncompleteTag(buf);
                        thinking += buf.slice(0, buf.length - hold.length);
                        buf = hold;
                        break;
                    }
                    thinking += buf.slice(0, match.index);
                    buf = buf.slice(match.index + match[0].length);
                    closeRe = null;
                    continue;
                }
                let found: { index: number; len: number; close: RegExp } | null = null;
                for (const pair of THINK_OPEN_CLOSE) {
                    pair.open.lastIndex = 0;
                    const match = pair.open.exec(buf);
                    if (match && match.index !== undefined && (!found || match.index < found.index)) {
                        found = { index: match.index, len: match[0].length, close: pair.close };
                    }
                }
                if (!found) {
                    const hold = holdIncompleteTag(buf);
                    visible += buf.slice(0, buf.length - hold.length);
                    buf = hold;
                    break;
                }
                visible += buf.slice(0, found.index);
                buf = buf.slice(found.index + found.len);
                closeRe = found.close;
            }
            return { visible, thinking };
        },
        flush(): { visible: string; thinking: string } {
            const leftover = buf;
            buf = '';
            if (closeRe) {
                closeRe = null;
                return { visible: '', thinking: leftover };
            }
            return { visible: leftover, thinking: '' };
        },
    };
};

export interface ThinkingDisplayParts {
    thinking: string;
    output: string;
    raw: string;
}

/**
 * Journal / card display: repair records that stored the answer as `reasoning`.
 */
export const displayThinkingParts = (record: {
    role?: string;
    reasoning?: string;
    finalOutput?: string;
    rawReasoning?: string;
}): ThinkingDisplayParts => {
    let thinking = (record.reasoning || '').trim();
    let output = (record.finalOutput || '').trim();
    let raw = (record.rawReasoning || '').trim();

    if (record.role === 'debate_turn') {
        const split = splitThinkingFromOutput(thinking, output);
        if (output) {
            thinking = split.thinking;
            output = split.output;
        } else {
            const peeled = splitThinkingFromOutput('', thinking);
            output = peeled.output;
            thinking = peeled.thinking;
        }
        if (eq(thinking, output)) thinking = '';
        if (eq(raw, output) || eq(raw, thinking)) raw = '';
        return { thinking, output, raw };
    }

    const split = splitThinkingFromOutput(raw || thinking, output || thinking);
    thinking = split.thinking;
    output = split.output || output;

    if (raw && looksLikeTradeOutput(raw) && !looksLikeTradeOutput(thinking)) {
        raw = '';
    }
    if (raw && (eq(raw, output) || eq(raw, thinking)) && !looksLikeScratchpad(raw)) raw = '';
    if (eq(thinking, output)) thinking = '';

    return { thinking, output, raw };
};
