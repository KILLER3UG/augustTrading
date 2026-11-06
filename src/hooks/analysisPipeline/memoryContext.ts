/**
 * Pipeline stage module — trader-notebook memory context assembly.
 *
 * Extracted verbatim from useAnalysisPipeline's send path: everything the seat
 * sees from the notebook for THIS setup (the matched skill's index line, the
 * profile memory index, bot memory, similar-setups track record, regime
 * weighting, loss-priming rows), each under its own budget. Pure given its
 * inputs, so it is unit-testable without mounting the hook.
 */

import { extractLessonFromPostMortem } from '../../services/learning/MemoryFilesService';
import { mineCoinFromPrompt, mineDirectionFromPrompt, minePatternFromPrompt } from '../../utils/patternMining';
import { getMemoryFilesContext } from '../../services/learning/MemoryRetrievalService';
import { buildProfileMemoryIndex } from '../../services/learning/profileMemory';
import { indexBudgetFor } from '../../utils/promptIndexBudget';
import { listRetrievedMemorySources, type MemoryRetrievalQuery, type RetrievedMemorySource } from '../../services/learning/MemoryRetrievalService';
import { getBotMemoryContext } from '../../services/bots/BotMemoryService';
import { BOT_MEMORY_TOTAL_CHAR_BUDGET } from '../../services/bots/botMemoryBudget';
import { clipNote } from '../../utils/harnessMarks';
import { buildSimilarSetupsContext, buildRegimeWeightingContext } from '../../services/learning/SetupMemoryService';
import type { HybridDataPacket } from '../../services/analysis/HybridIntelligenceService';
import type { LoggedTrade } from '../../types';
import { getBots } from '../../services/agents/agentRoster';

// Merged cap across ALL bots' memory context — the notebook
// opening budget is 900 chars; bot memory should not dwarf it. The number
// itself lives with the reader so a second surface (Chart AI) can divide the
// SAME allowance instead of inventing its own.
const BOT_MEMORY_TOTAL_CAP = BOT_MEMORY_TOTAL_CHAR_BUDGET;

// Pattern-family + coin + direction mining lives in utils/patternMining.ts so
// the bots (services/agents/botLearning.ts) mine the SAME query — this is a
// hook module the agents layer must not import. Re-exported here because that
// is where its tests and prompt-side callers look.
export { minePatternFromPrompt };

export interface PipelineMemoryContext {
    /** Setup query that drove retrieval. */
    memoryQuery: MemoryRetrievalQuery;
    detectedLearningCoin?: string;
    pendingDirection: 'Long' | 'Short' | 'Neutral';
    pendingPattern?: string;
    botMemoryContext: string;
    /** Analyst-audience notebook slice — the one retrieval depth a seat gets. */
    memoryFilesContext: string;
    memoryRetrieved: RetrievedMemorySource[];
    similarSetupsContext: string;
    regimeWeightingContext: string;
    lossPrimingRows: Array<{
        outcome: string | undefined;
        keyLesson: string;
        coin?: string;
        direction?: string;
        timestamp?: string;
    }>;
    /** The point-in-time cutoff this context was assembled under, if any —
     *  mirrored onto runStats.asOfMs so a simulated run records its own
     *  leak-prevention posture. Absent on live runs. */
    asOfMs?: number;
}

export const assemblePipelineMemoryContext = async (
    effectiveInput: string,
    loggedTrades: LoggedTrade[],
    freshHybridData: HybridDataPacket | null | undefined,
    runId?: string,
    /** Point-in-time replay cutoff (epoch ms). When set, every journal-derived
     *  slice below (skills, similar setups/trades, loss priming) sees only
     *  what was KNOWN by that moment. Omitted ⇒ live behavior, unchanged. */
    asOfMs?: number,
    /** Model context window (tokens) — threads to the notebook slice's
     *  budget. Omitted ⇒ default window, unchanged. */
    contextWindowTokens?: number,
    /** The Settings memory switch. False strips the profile index from every
     *  seat this assembly feeds — the deep pipeline used to read it
     *  unconditionally and un-budgeted, so a trader who switched memory OFF
     *  still had every stored fact riding a Full-analysis prompt. */
    memoryEnabled?: boolean,
): Promise<PipelineMemoryContext> => {
    const detectedLearningCoin = mineCoinFromPrompt(effectiveInput);
    const pendingDirection = mineDirectionFromPrompt(effectiveInput);
    const pendingPattern = minePatternFromPrompt(effectiveInput);

    // TRADER NOTEBOOK: retrieve matching files, skills, similar trades
    // and rules for THIS setup — never dump the whole notebook.
    const memoryQuery: MemoryRetrievalQuery = {
        coin: detectedLearningCoin,
        direction: pendingDirection,
        family: pendingPattern,
        pattern: pendingPattern,
        regime: freshHybridData?.regime?.regime,
    };
    // One roster only: agentRoster owns the bot list the trader edits. The
    // legacy Preferences roster has had no writer since the seeding effects
    // were deleted, so reading it here would have reported no bots.
    const botMemoryContext = await (async () => {
        try {
            const allBots = getBots();
            if (!allBots.length) return '';
            // The coin universe the note filter would otherwise guess at: a
            // lesson about a coin THIS TRADER keeps a journal for is another
            // coin's lesson, whatever the baseline majors list says.
            const knownCoins = [...new Set(
                (loggedTrades ?? [])
                    .map(t => t?.analysis?.coinName)
                    .filter((a): a is string => typeof a === 'string' && a.length >= 2),
            )];
            const botQuery = { ...memoryQuery, knownCoins };
            // Only a GLOBAL bot's notebook may be merged into somebody else's
            // prompt. `memoryScope: 'isolated'` means "keeps to its own notes,
            // nothing it learns is retrieved by others" — and this merge read
            // every bot while using the field only to size bytes, so an
            // isolated agent's private notes went to every seat.
            const shareable = allBots.filter(b => b?.id && (b.memoryScope ?? 'global') === 'global');
            if (shareable.length === 0) return '';
            // Divide the allowance instead of letting the first two bots spend
            // it: each got a fixed 900/1200 before, so with five bots the last
            // three were pushed past the merged cap and cut.
            const perBot = Math.max(200, Math.ceil(BOT_MEMORY_TOTAL_CAP / shareable.length));
            const seen = new Set<string>();
            const contexts: string[] = [];
            let used = 0;
            for (const bot of shareable) {
                if (seen.has(bot.id)) continue;
                seen.add(bot.id);
                const ctx = getBotMemoryContext(bot.id, botQuery, perBot);
                if (!ctx) continue;
                if (used >= BOT_MEMORY_TOTAL_CAP) break;
                const room = BOT_MEMORY_TOTAL_CAP - used;
                // A bare `\n…` here told the model nothing about how much was
                // left behind; the dialect names kept vs existed.
                const clipped = ctx.length > room
                    ? `${ctx.slice(0, room).trimEnd()}\n${clipNote({ source: 'merged bot memory', kept: room, total: used + ctx.length })}`
                    : ctx;
                contexts.push(clipped);
                used += clipped.length;
            }
            return contexts.join('\n\n---\n\n');
        } catch { return ''; }
    })();
    // Analyst seats get ONE notebook slice. The rebuttal slice used to be built
    // here as well — a second full retrieval per send whose result no consumer
    // ever read (it was returned and dropped), and the verdict slice before it
    // served a moderator that no longer exists: one model answers a send.
    // The profile index was read unconditionally and with no budget, so this
    // path ignored both the Settings switch and the window the same table sizes
    // for every other seat. Both now come from the shared sources.
    const profileMemoryIndex = memoryEnabled === false
        ? ''
        : buildProfileMemoryIndex(undefined, indexBudgetFor(contextWindowTokens ?? 200_000).memory);
    const withProfile = (ctx: string): string => [profileMemoryIndex, ctx].filter(Boolean).join('\n\n---\n\n');
    const memoryFilesContext = withProfile([getMemoryFilesContext(memoryQuery, loggedTrades, 'analyst', { runId, asOfMs, contextWindowTokens }), botMemoryContext].filter(Boolean).join('\n\n---\n\n'));
    const memoryRetrieved = listRetrievedMemorySources(memoryQuery, loggedTrades, 'analyst');

    // JOURNAL-DRIVEN ACCURACY (SetupMemoryService): before the analysts
    // answer, they see their own logged track record on setups like this one.
    const similarSetupsContext = buildSimilarSetupsContext(
        { coinName: detectedLearningCoin, direction: pendingDirection, detectedPatternFamily: pendingPattern },
        loggedTrades,
        freshHybridData?.regime?.regime,
        asOfMs
    );
    const regimeWeightingContext = buildRegimeWeightingContext(
        loggedTrades,
        freshHybridData?.regime?.regime
    );

    // Loss priming rows (B4): this setup's recent closed trades, compact —
    // the debate seats recall their own losses on setups like this first.
    // Under a point-in-time cutoff, a lesson counts only once it was KNOWN
    // (post-mortem written), not merely once the trade was logged.
    const lossPrimingRows = loggedTrades
        .filter(t => (t.outcome === 'WIN' || t.outcome === 'LOSS')
            && (!detectedLearningCoin || t.analysis?.coinName?.toLowerCase() === detectedLearningCoin.toLowerCase())
            && (pendingDirection === 'Neutral' || t.analysis?.direction === pendingDirection)
            && (asOfMs === undefined || Date.parse(t.postMortemCreatedAt ?? t.timestamp) <= asOfMs))
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        .slice(0, 6)
        .map(t => {
            let lesson = '';
            try { lesson = extractLessonFromPostMortem(t.postMortem || ''); } catch { /* optional */ }
            return {
                outcome: t.outcome as string | undefined,
                keyLesson: lesson,
                coin: t.analysis?.coinName,
                direction: t.analysis?.direction,
                timestamp: t.timestamp,
            };
        });

    return {
        memoryQuery,
        detectedLearningCoin,
        pendingDirection,
        pendingPattern,
        botMemoryContext,
        memoryFilesContext,
        memoryRetrieved,
        similarSetupsContext,
        regimeWeightingContext,
        lossPrimingRows,
        asOfMs,
    };
};
