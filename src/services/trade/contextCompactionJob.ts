/**
 * contextCompactionJob — the SILENT 80% summarizer.
 *
 * `contextCompact` already fits an outbound array to a ceiling, but it only runs
 * when the ceiling is already crossed, on the send path, and it is structural:
 * it clips tool payloads and drops whole turns. The trader sees a "COMPACTED
 * FOR THE CONTEXT WINDOW" line after the fact, and the dropped turns are gone
 * with no account of what they said.
 *
 * This module is the other half. Once a conversation reaches 80% of the model's
 * window it summarizes the OLDER turns in the background — off the send path,
 * during idle — into a short digest that keeps the three things a later turn
 * actually needs: which symbols were in play, what was decided, and what is
 * still open. Nothing the trader sees is blocked, cleared, or re-ordered: the
 * summary is stored on the conversation and prepended to the NEXT request, so a
 * turn never waits for it and a failure just means the next turn compacts the
 * old way.
 *
 * Why 80% and not 100%: the estimate is a heuristic and the provider's own
 * tokenizer is the authority, so the last 20% is the margin in which a real
 * request still fits. Compacting AT the ceiling is compacting after the request
 * that needed it has already been rejected.
 */

import type { ChatMessage } from '../providers/GenericProviderService';
import { estimateMessagesTokens } from '../providers/contextCompact';

/** Start summarizing at this share of the window. */
export const COMPACTION_TRIGGER_RATIO = 0.8;

/** Older turns this many messages back are never summarized away: they are what
 *  the next reply is most likely to be about. */
export const COMPACTION_KEEP_RECENT = 8;

/** The digest is a few hundred tokens by design — it replaces far more. */
export const COMPACTION_SUMMARY_MAX_CHARS = 2_400;

export interface CompactionUsage {
    tokens: number;
    windowTokens: number;
    /** tokens / windowTokens, clamped to [0, 1]. */
    ratio: number;
}

export const compactionUsage = (messages: readonly ChatMessage[], windowTokens: number): CompactionUsage => {
    const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 1;
    const tokens = estimateMessagesTokens(messages as ChatMessage[]);
    return { tokens, windowTokens: window, ratio: Math.min(1, tokens / window) };
};

export const shouldCompact = (usage: CompactionUsage): boolean => usage.ratio >= COMPACTION_TRIGGER_RATIO;

/** The slice a summary covers: everything except the recent tail and any system
 *  message (the system block is not history, and folding it into a digest would
 *  silently drop the standing instructions). */
export const summarizableSlice = (
    messages: readonly ChatMessage[],
    keepRecent = COMPACTION_KEEP_RECENT,
): { older: ChatMessage[]; recent: ChatMessage[] } => {
    const cut = Math.max(0, messages.length - Math.max(0, keepRecent));
    return {
        older: messages.slice(0, cut).filter(m => m.role !== 'system'),
        recent: messages.slice(cut),
    };
};

const roleLabel = (role: string): string =>
    role === 'user' ? 'Trader' : role === 'assistant' ? 'Desk' : role === 'tool' ? 'Tool' : 'System';

/** The prompt. The three headings are the contract the owner asked for; the
 *  "do not invent" line is what stops a summary from becoming a story. */
export const buildCompactionPrompt = (older: readonly ChatMessage[], maxChars = COMPACTION_SUMMARY_MAX_CHARS): string => {
    const transcript = older.map(m => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        const clipped = text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
        return `${roleLabel(m.role)}: ${clipped}`;
    }).join('\n');
    return [
        'Summarize the OLDER part of this trading session for your own future use. Output ONLY markdown with exactly these four headings:',
        '## Symbols',
        'Every symbol/coin discussed, with what was concluded about it (one line each).',
        '## Decisions',
        'Each decision or plan actually made, with its trigger and invalidation if one was given.',
        '## Open tasks',
        'Anything explicitly left unfinished or waiting on the trader.',
        '## Other context',
        'Durable facts a later turn would otherwise have to re-derive.',
        `Keep it under ${maxChars} characters. Preserve numbers, prices and levels EXACTLY as written. Never invent a fact that is not in the transcript; if a section has nothing, write "(none)".`,
        '',
        'Transcript:',
        transcript,
    ].join('\n');
};

/**
 * Clean a model answer into a digest that is safe to inject.
 *
 * A summary missing its headings is still useful, so it is kept — but one that
 * is empty, obviously a refusal, or missing every symbol mentioned in the slice
 * is discarded. A summary that silently drops the symbol the trader is asking
 * about is worse than no summary: the next turn reasons confidently without it.
 */
export const sanitizeSummary = (
    raw: string,
    older: readonly ChatMessage[],
    maxChars = COMPACTION_SUMMARY_MAX_CHARS,
): string | null => {
    const text = (raw || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    if (text.length < 40) return null;
    if (/^(i (cannot|can't)|sorry[,.]|as an ai)/i.test(text)) return null;
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
    // Coverage check: the symbols named in the slice must survive. Only tokens
    // that look like a pair (BTCUSDT, BTC/USDT, ETH) are checked, against the
    // user/assistant turns only — tool payloads are full of market shorthand.
    const spoken = older
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => (typeof m.content === 'string' ? m.content : ''))
        .join(' ');
    const symbols = [...new Set((spoken.match(/\b[A-Z]{2,6}(?:USDT|USDC|PERP|\/USDT)?\b/g) ?? []))]
        .filter(s => s.length >= 3)
        .slice(0, 8);
    const missing = symbols.filter(s => !clipped.toUpperCase().includes(s));
    if (symbols.length > 0 && missing.length > symbols.length / 2) return null;
    return clipped;
};

export interface SummarizeResult {
    summary: string;
    coveredMessages: number;
    tokensBefore: number;
    /** Estimated tokens of the slice the summary replaces. */
    tokensReplaced: number;
}

/**
 * Summarize if the conversation has crossed the trigger. Returns null when
 * nothing should be written — under the trigger, nothing old enough, no model,
 * or an answer that failed sanitization.
 *
 * `complete` is injected so this module never imports a provider itself: the
 * caller owns which model is used, exactly like the memory consolidation pass.
 */
export const summarizeIfNeeded = async (input: {
    messages: readonly ChatMessage[];
    windowTokens: number;
    complete: (prompt: string) => Promise<string>;
    keepRecent?: number;
}): Promise<SummarizeResult | null> => {
    const usage = compactionUsage(input.messages, input.windowTokens);
    if (!shouldCompact(usage)) return null;
    const { older } = summarizableSlice(input.messages, input.keepRecent ?? COMPACTION_KEEP_RECENT);
    if (older.length < 4) return null;
    let raw: string;
    try {
        raw = await input.complete(buildCompactionPrompt(older));
    } catch {
        // A background summary that fails is not an error the trader should
        // meet: the send path still compacts structurally, as it always did.
        return null;
    }
    const summary = sanitizeSummary(raw, older);
    if (!summary) return null;
    return {
        summary,
        coveredMessages: older.length,
        tokensBefore: usage.tokens,
        tokensReplaced: estimateMessagesTokens(older),
    };
};

/** One in-flight summary per conversation. Two renders inside the same turn
 *  must not spend two model calls on the same bytes. */
const inFlight = new Map<string, Promise<SummarizeResult | null>>();

export const summarizeOnce = (
    key: string,
    input: Parameters<typeof summarizeIfNeeded>[0],
): Promise<SummarizeResult | null> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const run = summarizeIfNeeded(input).finally(() => { inFlight.delete(key); });
    inFlight.set(key, run);
    return run;
};

/** Test hook. */
export const __clearCompactionInFlight = (): void => { inFlight.clear(); };

/**
 * The provider-backed `complete` for callers that do not already own one.
 *
 * Deliberately lazy and deliberately NOT exported from a provider module: the
 * summarizer must stay importable (and contract-testable) without pulling the
 * provider stack, and the caller must be able to skip the whole feature when no
 * provider is ready. Reuses the SAME plumbing as the memory consolidation pass —
 * first ready provider, one non-streaming call, no model hardcoded.
 */
export const resolveCompactionComplete = async (): Promise<((prompt: string) => Promise<string>) | null> => {
    try {
        const [{ loadProviderConfigs, getReadyProviders }, { getQuickResponse }] = await Promise.all([
            import('../infrastructure/ProviderConfigService'),
            import('../providers/GenericProviderService'),
        ]);
        const config = getReadyProviders(await loadProviderConfigs())[0];
        if (!config) return null;
        return (prompt: string) => getQuickResponse(
            config,
            prompt,
            'You compress a trading conversation for your own future reference. Preserve symbols, prices, decisions and open tasks exactly. Never invent.',
            { maxTokens: 900, temperature: 0.2 },
        );
    } catch {
        return null;
    }
};

/**
 * Prepend the stored digest to an outbound array. The digest rides as a leading
 * SYSTEM message, not a synthetic assistant turn: it is the harness's account of
 * history, and a model that believes it said those words will defend them.
 */
export const withCompactionSummary = (messages: ChatMessage[], summary: string | undefined): ChatMessage[] => {
    const text = (summary ?? '').trim();
    if (!text) return messages;
    return [
        {
            role: 'system',
            content: `EARLIER IN THIS SESSION (summarized as the context window filled; the most recent turns are below verbatim):\n${text}`,
        },
        ...messages,
    ];
};
