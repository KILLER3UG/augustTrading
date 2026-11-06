/**
 * botLearning — the bot half of the learning loop (WS-3).
 *
 * Until now bots were READ-ONLY learners: the chart pipeline merges bot
 * memory into analyst prompts, and bots read their own system/notes, but a
 * bot turn never consulted the shared notebook and never wrote anything
 * back. This module closes both directions:
 *
 *  - buildBotSharedMemoryContext: a budgeted slice of the same
 *    MemoryRetrievalService retrieval the debate analysts get, mined from the
 *    turn's prompt, attributed under the turn's id so a trade that follows a
 *    bot's call can credit the skills the bot was shown. Isolated-scope bots
 *    skip shared retrieval entirely.
 *  - recordBotTurnOutcome: writes the turn's lesson into the bot's own
 *    memory.md, runs the bot's closed trades through the SAME draft chain the
 *    chart AI's post-mortems use (craftSkillFromPostMortem → the evidence-
 *    backed draft gate, with that bot's memory as the gate's context), and
 *    folds them into the shared evidence path via syncClosedTradeToNotebook.
 *
 * Everything here is fire-and-forget safe: a failure logs and returns, never
 * breaks the turn.
 */

import type { LoggedTrade } from '../../types';
import { getMemoryFilesContext, type MemoryRetrievalQuery } from '../learning/MemoryRetrievalService';
import { recordMemoryInjection } from '../learning/MemoryInjectionService';
import { readBotMemoryMarkdown, botMemoryFolderName } from '../bots/BotMemoryService';
import {
    createMemoryFile,
    createMemoryFolder,
    findFolderByName,
    getMemoryFiles,
    updateMemoryFile,
    extractLessonFromPostMortem,
} from '../learning/MemoryFilesService';
import { appendDiaryEntry, syncRecurringMistakes } from '../learning/MemoryFilesService';
import { phtDayKey } from '../../utils/timezone';
import { getBots } from './agentRoster';
import { mineCoinFromPrompt, mineDirectionFromPrompt, minePatternFromPrompt } from '../../utils/patternMining';
import { hasLessonLabel, parseLessonToken, stripLessonLabel } from '../../utils/lessonToken';
import type { BotMemoryScope } from './agentRoster';

/** Bots get the smallest honest slice — their persona/notes already ride the
 *  system prompt; the shared slice is evidence, not a second personality. */
const BOT_SHARED_MEMORY_CAP = 700;
const BOT_LESSON_MAX_CHARS = 280;
/** Below this a "lesson" is a fragment, not something worth spending prompt
 *  budget on every future turn. */
const BOT_LESSON_MIN_CHARS = 20;
const BOT_MEMORY_FILE_MAX_CHARS = 4000;

/** Mine the setup query from a bot turn's prompt. The SAME mining the analyst
 *  seats use (utils/patternMining), so a bot asking about a "BTC fakeout"
 *  retrieves the Family-A skills an analyst would see — when this was forked
 *  locally the bots matched a strictly weaker query than the humans' debate. */
export const mineBotTurnQuery = (prompt: string): MemoryRetrievalQuery => {
    const pattern = minePatternFromPrompt(prompt);
    return {
        coin: mineCoinFromPrompt(prompt),
        direction: mineDirectionFromPrompt(prompt),
        family: pattern,
        pattern,
    };
};

/**
 * The shared notebook slice for one bot turn. Returns '' when the bot is
 * isolated-scope or nothing matched.
 */
export const buildBotSharedMemoryContext = (
    prompt: string,
    opts: { botId: string; memoryScope?: BotMemoryScope; runId?: string },
): string => {
    // WS-3.1's scope contract: only a 'global' bot reads the shared book. An
    // 'isolated' bot keeps its own notes out of it and it out of them;
    // 'personal' has no separate store to read, so it behaves as isolated here.
    if (opts.memoryScope && opts.memoryScope !== 'global') return '';
    try {
        // recordInjections under THIS turn's id is what makes attribution real:
        // the retrieval records only the files that survived the budget, and a
        // trade logged from the reply joins back on the same id via
        // message.runStats.runId. Forking the source list afterwards logged
        // files the budget had already dropped.
        const ctx = getMemoryFilesContext(
            mineBotTurnQuery(prompt),
            undefined,
            'analyst',
            { runId: opts.runId, recordInjections: true },
        );
        if (!ctx.trim()) return '';
        return ctx.length > BOT_SHARED_MEMORY_CAP ? `${ctx.slice(0, BOT_SHARED_MEMORY_CAP).trimEnd()}\n…` : ctx;
    } catch {
        return '';
    }
};

/** Attribution for the half the notebook pass cannot see: the bot's OWN
 *  memory.md, which rides the system prompt rather than coming out of
 *  retrieval. Shared-book sources are recorded by getMemoryFilesContext itself
 *  under the same runId — see buildBotSharedMemoryContext. */
export const recordBotTurnInjection = (
    opts: { botId: string; username: string; runId: string },
): void => {
    try {
        if (!readBotMemoryMarkdown(opts.botId)) return;
        void recordMemoryInjection(opts.username, {
            stage: 'opening',
            audience: `bot:${opts.botId}`,
            runId: opts.runId,
            sources: [{ path: `${botMemoryFolderName(opts.botId)}/memory.md`, kind: 'bot' }],
        });
    } catch { /* telemetry must never break a turn */ }
};

/** Which agent bot, if any, answered a message — the join the trade logger
 *  needs to credit a bot-authored trade (WS-3.2/3.3). A chart-AI verdict
 *  carries one modelUsed pair per provider; a bot DM or routine run carries
 *  exactly one pair, and that pair IS the bot's identity — the same rule
 *  threadForProvider uses to thread the reply into the bot's own conversation.
 *  Returns null when the pair is absent, ambiguous, or matches no roster bot,
 *  which is the chart-AI path: no single authoring bot exists there.
 */
export const botOriginForMessage = (
    modelsUsed?: Record<string, string>,
): { botId: string; botName?: string } | null => {
    const pairs = Object.entries(modelsUsed ?? {});
    if (pairs.length !== 1) return null;
    const [providerId, modelId] = pairs[0];
    const bot = getBots().find(b => b.providerId === providerId && b.modelId === modelId);
    return bot ? { botId: bot.id, botName: bot.name } : null;
};

/**
 * Trade ids already folded into the notebook this session, per bot.
 * syncClosedTradeToNotebook is idempotent for its diary/evidence writes, but
 * its worth-gate leg is a LIVE LLM call that fires whenever a cluster has no
 * matching skill yet — so re-feeding the same closed trades on every DM turn
 * would turn casual chat into an unbounded spend with nothing to show for it.
 */
const foldedTrades = new Map<string, Set<string>>();

/**
 * The lesson in a bot turn's reply — or '' when there isn't one.
 *
 * extractLessonFromPostMortem is built for post-mortems: structured text whose
 * prose FALLBACK (first sentence over 20 chars) is already known to be a
 * lesson. A chat reply carries no such guarantee, so using it directly
 * memorialized refusals, disclaimers and "I have no price data here" into the
 * bot's memory.md — where retrieval feeds it back into every future turn of
 * that bot. So: require the reply to declare a lesson before extracting one.
 *
 * Two declarations are honored, in order. An explicit LESSON token
 * (utils/lessonToken) is what the bot MEANT — it names its own boundaries, so
 * it wins over any longer "Lesson:" line elsewhere in the same reply, and a
 * token too short to keep does not fall back to the prose around it. Failing
 * that, a reply that labels a lesson in prose earns the post-mortem miner.
 */
export const lessonFromBotTurn = (reply: string): string => {
    if (!reply || !hasLessonLabel(reply)) return '';
    const declared = parseLessonToken(reply);
    const mined = declared ?? extractLessonFromPostMortem(reply);
    // The label comes off either way: `extractLessonFromPostMortem` captures
    // the body only for the spellings its own pattern knows, so a "Lessons
    // learned:" reply would otherwise be stored WITH its label attached.
    const lesson = stripLessonLabel(mined);
    return lesson.length >= BOT_LESSON_MIN_CHARS ? lesson : '';
};

/** What this module needs to know about the acting bot. `modelId` lets a bot
 *  craft with the model it thinks with rather than the provider's default. */
export interface BotIdentity {
    id: string;
    name: string;
    providerId: string;
    modelId?: string;
}

/**
 * WS-3.2's craft leg: a bot's closed trade goes through the SAME draft chain
 * the chart AI's post-mortems do — craft a procedure from the post-mortem,
 * then the evidence-backed draft gate (tombstone, duplicate-draft and worth
 * checks, prediction required) — with THAT bot's own memory as the gate's
 * context, so the judgement is made against what this bot already believes.
 *
 * Returns the queued draft, or null when anything declined it: no ready
 * provider, a post-mortem too thin to craft from, a duplicate already pending,
 * or a gate refusal. Fail-safe by construction — the deterministic tier inside
 * the gate still queues offline, and a throw here never reaches the turn.
 */
/**
 * Persist what a bot turn learned. Two writes:
 *  1. A one-line lesson appended to the bot's own memory.md (capped so the
 *     file can't grow unbounded; query-filtered retrieval keeps it relevant).
 *  2. Closed bot-authored trades fold into the shared evidence path — a trade
 *     whose modelsUsed pair IS this bot's identity (utils/agentThreads
 *     single-model rule) is this bot's call, and it earns the same
 *     syncClosedTradeToNotebook write-back a chart-AI trade gets.
 */
export const recordBotTurnOutcome = async (
    bot: BotIdentity,
    prompt: string,
    reply: string,
    opts: { username: string; trades: LoggedTrade[] },
): Promise<void> => {
    try {
        // 1. The lesson line. Only a reply that LABELS a lesson earns one —
        //    refusals, disclaimers and empty turns are not lessons.
        const lesson = lessonFromBotTurn(reply);
        if (lesson) {
            const folderName = botMemoryFolderName(bot.id);
            let folder = findFolderByName(folderName);
            if (!folder) folder = await createMemoryFolder(folderName, opts.username);
            const existing = getMemoryFiles().files.find(f => f.folderId === folder.id && f.name === 'memory.md');
            const stamp = phtDayKey();
            const line = `- [${stamp}] ${lesson.slice(0, BOT_LESSON_MAX_CHARS)}`;
            const next = existing
                ? `${existing.content.trimEnd()}\n${line}`.slice(-BOT_MEMORY_FILE_MAX_CHARS)
                : `# ${bot.name} — learned memory\n\n${line}`;
            if (existing) await updateMemoryFile(existing.id, { content: next }, opts.username);
            else await createMemoryFile(folder.id, 'memory.md', next, opts.username, true);
        }

        // A closed bot-authored trade still writes its diary entry and the
        // recurring-mistakes file. Skill evidence and skill drafting are gone
        // with the ledger.
        const seen = foldedTrades.get(bot.id) ?? new Set<string>();
        const botTrades = opts.trades.filter(t => {
            const keys = Object.keys(t.modelsUsed ?? {});
            return Boolean(bot.modelId)
                && keys.length === 1 && keys[0] === bot.providerId
                && t.modelsUsed?.[bot.providerId] === bot.modelId
                && (t.outcome === 'WIN' || t.outcome === 'LOSS')
                && !seen.has(t.id);
        });
        for (const trade of botTrades.slice(-2)) {
            seen.add(trade.id);
            foldedTrades.set(bot.id, seen);
            await appendDiaryEntry(trade, opts.username);
            await syncRecurringMistakes(opts.trades, opts.username);
        }
    } catch (e) {
        console.warn('[BotLearning] outcome write failed (non-fatal):', e instanceof Error ? e.message : e);
    }
};

/** How many lesson lines this bot has earned. The cheap read side of the
 *  per-bot learning stats the roster surfaces, and the only way to tell a
 *  written lesson apart from an empty notebook. */
export const botLessonCount = (botId: string): number => {
    const note = readBotMemoryMarkdown(botId);
    if (!note) return 0;
    return note.split('\n').filter(l => l.trim().startsWith('- [')).length;
};

export interface BotLearningStat {
    id: string;
    name: string;
    /** Lesson lines in the bot's own memory.md. */
    lessons: number;
    /** Skills this bot authored (WS-3.3 provenance). */
    skillsAuthored: number;
    /** Counted trades behind those skills. */
    evidence: number;
    /** Newest lesson date in the bot's notes, YYYY-MM-DD, or null. */
    lastLessonAt: string | null;
}

/** Per-bot learning stats for the roster rail / Learning surface (WS-3.4). */
export const loadBotLearningStats = (): BotLearningStat[] => {
    return getBots().map(b => {
        const note = readBotMemoryMarkdown(b.id) ?? '';
        const dates = [...note.matchAll(/-\s+\[(\d{4}-\d{2}-\d{2})\]/g)].map(m => m[1]);
        return {
            id: b.id,
            name: b.name,
            lessons: botLessonCount(b.id),
            skillsAuthored: 0,
            evidence: 0,
            lastLessonAt: dates.length ? dates.reduce((a, d) => (d > a ? d : a)) : null,
        };
    });
};
