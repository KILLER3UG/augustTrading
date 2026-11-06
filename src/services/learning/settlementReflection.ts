/**
 * settlementReflection — the ONE bounded model call at trade settlement (E-57 §1).
 *
 * **Why this exists.** Nothing in this app has ever written `trade.postMortem`.
 * The field is read by the diary, the pattern-memory synthesis, the journal
 * detail and the CSV export, and it is declared on the row since the first
 * version. This call is its ONE writer. The skill-drafting legs that used to
 * consume it are gone with the skill ledger; what remains is the written
 * record and the `Lesson:` clause the journal-rules reader parses.
 *
 * **Why one call is allowed.** `docs/plan/README.md` rule 8 said no proposal in
 * the plan adds an LLM review call. The owner waived it for exactly this one,
 * 2026-10-21, because the cost buys back the only writer of a field four live
 * readers depend on. It writes the post-mortem the trader can read; it creates
 * no rule and no skill.
 *
 * **What it never does.**
 *  - It does not overwrite a note that is already there. A trader's own words win.
 *  - It asks nothing that is not on the row. No new fetch, no new tape: every
 *    fact in the packet was measured and stored by the settlement path itself.
 *  - It writes NOTHING on any failure, decline or malformed answer. A missing
 *    reflection is a gap in the notebook; a fabricated lesson is a lie the
 *    trader then grades their strategy against.
 *  - It runs once per trade per session, and a re-fired settlement never spends
 *    a second call.
 */

import type { LoggedTrade } from '../../types';
import { TradeOutcome } from '../../types';
import type { ChatMessage } from '../providers/GenericProviderService';
import { sendChatRequest } from '../providers/GenericProviderService';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { effortForTask } from '../providers/reasoningControls';
import type { ReasoningEffort } from '../../types/provider';
import { extractAndParseJson } from '../../utils/jsonUtils';
import { sanitizeAIResponse } from '../../utils/sanitizers';
import { tradeAdmitsTechnicalStrategyRule } from '../../utils/rootCause';
import { clipNote } from '../../utils/harnessMarks';
import { parseSettlementReflection, type SettlementReflection } from '../../schemas/learning';
import { beginPromptLane, getPrompt, promptCorpusVersion, type PromptLane } from '../infrastructure/PromptOverrideService';
import { resolveMemoryConfig } from './MemoryModelService';

/**
 * The built-in instruction. Registered as `learning.settlement_reflection`
 * (`constants/promptRegistry.ts`), so the Settings prompt tab can edit it and
 * the A/B lane can measure it — the call site imports the registry's fallback
 * rather than restating it, which is how an override and a reset stay honest.
 */
export const SETTLEMENT_REFLECTION_FALLBACK = `You write the post-mortem for ONE closed trade, from the facts given. They are the whole record: you were not watching the tape, so you did not see anything they do not name.

Answer ONLY JSON:
{
  "whatHappened": "2-4 sentences on how this plan met its outcome, in terms of the numbers given",
  "lesson": "one transferable sentence — what to do differently next time, starting with the thing the trader controls",
  "when": "the trigger, as a condition the trader can check BEFORE entering (no price you invented)",
  "action": "the mechanical action that trigger should change"
}

Rules:
- Quote only numbers that are in the record. If a fact is missing, name the absence instead of filling it.
- "when"/"action" must be checkable and mechanical — a level, a condition, a regime, a size. Not "be more careful", not "trust the feeling".
- A GROSS R that turns NET-negative after fees is a lesson about the stop distance or the entry, not about the direction.
- An outcome that beat its own benchmark is not evidence of skill; a trade that lost while the benchmark rose is not evidence of error. Say which you were told.
- If the record does not support a transferable lesson — an entry that never filled, a one-off execution slip, a row with almost no facts — output {"noLesson": true} and nothing else. A gap in the notebook is better than a rule that was never earned.`;

/** Why a reflection was not written. Recorded for the log and the tests; the
 *  row never carries it, because an absent note needs no explanation the journal
 *  has to render — the absence IS the record. A declined answer and a malformed
 *  one are the same outcome to the caller — write nothing — so they are the same
 *  reason; the schema folds the model's `noLesson` into `null` and the service
 *  never pretends to know which happened. */
export type ReflectionSkipReason =
    | 'already-written'
    | 'not-a-lesson-row'
    | 'in-flight'
    | 'no-provider'
    | 'declined-or-malformed'
    | 'failed';

export interface ReflectionOptions {
    username: string;
    /** The skills that rode the prompt on the turn that produced this plan, read
     *  off the message the trade was logged from. A lesson that contradicts an
     *  injected skill is a different finding from one written in its absence. */
    injectedSkills?: string[];
    signal?: AbortSignal;
}

export interface ReflectionResult {
    /** The row to hand on: the trade as logged, plus the reflection when one was
     *  written. The caller MUST pass this — not its own copy — into
     *  `syncClosedTradeToNotebook`, because that function folds the diary entry
     *  and the lesson draft from the row's post-mortem text. */
    trade: LoggedTrade;
    wrote: boolean;
    reason: ReflectionSkipReason | 'written';
    model?: string;
    lane?: PromptLane;
    promptVersion?: string;
    tier?: ReasoningEffort;
}

/** Session guard: keyed by USER as well as trade id, because two profiles
 *  legitimately hold a trade with the same id, and marked BEFORE the first
 *  await so a throw half-way cannot make the next caller re-ask. */
const reflectedKeys = new Set<string>();
const reflectedKey = (username: string, tradeId: string): string => `${username}:${tradeId}`;

/** Test hook — the guard is session state, so a suite that reuses one trade id
 *  across cases must clear it. */
export const __resetReflectedTradesForTests = (): void => { reflectedKeys.clear(); };

const measured = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The plan's own levels, as strings the model quotes back verbatim. */
const levelLine = (trade: LoggedTrade): string => {
    const a = trade.analysis;
    const entry = a?.entryPoints?.[0]?.price ?? '—';
    const stop = a?.stopLoss ?? '—';
    const targets = (a?.takeProfit ?? []).map(t => t.price).filter(Boolean).join(' / ') || '—';
    return `entry ${entry} · stop ${stop} · targets ${targets}`;
};

/** The row's measured R, in the app's own vocabulary: GROSS price-measured R,
 *  the fee in R, and the NET sibling. `rSource` says WHO measured it, because an
 *  autopilot number and a post-mortem number are different evidence. */
const riskLine = (trade: LoggedTrade): string => {
    const parts: string[] = [];
    if (measured(trade.realizedR)) parts.push(`${trade.realizedR}R gross (price-measured${trade.rSource ? `, by the ${trade.rSource}` : ''})`);
    if (measured(trade.costR)) parts.push(`${trade.costR}R round-trip cost${trade.slippageModeled === false ? ' — slippage is NOT modelled' : ''}`);
    if (measured(trade.netR)) parts.push(`${trade.netR}R net after cost`);
    if (measured(trade.rMultiple)) parts.push(`${trade.rMultiple}R leveraged percent`);
    if (parts.length) return parts.join(' · ');
    return `no R could be measured${trade.costUnknown ? ` — the ${trade.costUnknown} is unknown` : ''}`;
};

const benchmarkLine = (trade: LoggedTrade): string => {
    const b = trade.benchmark;
    if (!b) return 'benchmark alpha: never measured';
    if (b.unavailableReason || !Number.isFinite(b.alphaPct)) return `benchmark alpha: unavailable (${b.unavailableReason ?? 'no comparison'})`;
    return `vs ${b.benchmarkSymbol} buy-and-hold ${b.benchmarkPct.toFixed(2)}% · trade ${b.tradePct.toFixed(2)}% · alpha ${b.alphaPct.toFixed(2)}%`;
};

const excursionLine = (trade: LoggedTrade): string => {
    if (!measured(trade.maxAdverseExcursion) && !measured(trade.maxFavorableExcursion)) {
        return 'excursion: not measured over the live window';
    }
    const mae = measured(trade.maxAdverseExcursion) ? `${trade.maxAdverseExcursion}%` : '—';
    const mfe = measured(trade.maxFavorableExcursion) ? `${trade.maxFavorableExcursion}%` : '—';
    return `max adverse ${mae} · max favorable ${mfe}${trade.excursionSource ? ` (measured by the ${trade.excursionSource})` : ''}`;
};

/** The gate's own answer for this plan (E-57 §5 put the cautions here). A row
 *  whose plan the gate REFUSED is a different lesson from one it merely capped,
 *  and the reflection must not have to guess which happened. */
const gateLine = (trade: LoggedTrade): string => {
    const g = trade.analysis?.gate;
    if (!g) return 'pre-trade gate: never ran — this row was logged UNCAPPED';
    const parts = [`gate ${g.status} at a ${Math.round(g.confidenceCap * 100)}% cap`];
    if (g.refusal) parts.push(`REFUSED: ${g.refusal}`);
    if (g.warnings?.length) parts.push(`cautions: ${g.warnings.join(' | ')}`);
    return parts.join(' · ');
};

/** The facts, in reading order. Pure and exported so a test can assert the
 *  SHAPE of what a model is told — a packet that silently lost its cost line is
 *  how a reflection starts inventing one. */
export const reflectionPacket = (trade: LoggedTrade, injectedSkills?: string[]): string => {
    const a = trade.analysis;
    const strategy = (a?.strategy ?? '').trim();
    const STRATEGY_CAP = 600;
    const strategyText = strategy
        ? strategy.length > STRATEGY_CAP
            ? `${strategy.slice(0, STRATEGY_CAP)}\n${clipNote({ source: 'the plan text', kept: STRATEGY_CAP, total: strategy.length })}`
            : strategy
        : 'no plan text was stored';
    return [
        `SYMBOL: ${a?.coinName ?? '?'}`,
        `DIRECTION: ${a?.direction ?? '?'}${trade.leverage ? ` · leverage ${trade.leverage}x` : ''}`,
        `OUTCOME: ${trade.outcome} · resolved by ${trade.resolutionSource ?? 'unknown writer'}${trade.extendedSLZoneBreach ? ' · the 150% extended-stop zone was breached' : ''}`,
        `LEVELS: ${levelLine(trade)}`,
        `R: ${riskLine(trade)}`,
        `EXCURSION: ${excursionLine(trade)}`,
        `BENCHMARK: ${benchmarkLine(trade)}`,
        `REGIME: ${trade.marketRegime ? `${trade.marketRegime} (${trade.marketRegimeSource ?? 'source unstated'})` : 'never observed — do not assume ranging'}`,
        `GATE: ${gateLine(trade)}`,
        `FAMILY: ${a?.detectedPatternFamily ?? 'none recorded'}`,
        `PLAN FOLLOWED: ${trade.followedPlan === undefined ? 'not recorded' : trade.followedPlan ? 'yes' : `no — ${trade.planDeviationNote ?? 'no note given'}`}`,
        `SKILLS INJECTED ON THAT TURN: ${injectedSkills && injectedSkills.length ? injectedSkills.join(', ') : 'none were listed'}`,
        '',
        'THE PLAN AS IT WAS WRITTEN:',
        strategyText,
    ].join('\n');
};

/** The text that becomes `trade.postMortem`. Its shape is load-bearing, not
 *  cosmetic: the `Lesson:` line is what `extractLessonFromPostMortem`
 *  (services/learning/MemoryFilesService.ts:1017) captures — it must be a plain
 *  line, not a heading or a whole-line bold, because that reader SKIPS wrapped
 *  lines as titles — and the `When …, do …` sentence is what `parseLessonClauses`
 *  (utils/lessonClause.ts) splits into a journal rule. The legacy `IF … THEN …`
 *  form is still parsed, because post-mortems written before 2026-10-30 are
 *  stored text.
 *
 *  Plain prose, no markdown heading, and the first line names the app as the
 *  author: this text is read back by the diary, the pattern-memory synthesis and
 *  a CSV export, and a note the model wrote must not need a UI field to stay
 *  honest about who wrote it. */
export const renderPostMortem = (r: SettlementReflection, model?: string): string => [
    `Post-mortem written by the app at settlement${model ? ` (${model})` : ''}.`,
    '',
    r.whatHappened.trim(),
    '',
    `Lesson: ${r.lesson.trim()}`,
    '',
    `When ${r.when.trim()}, do ${r.action.trim()}.`,
].join('\n');

/** Extract → sanitize → schema, in the order every AI boundary in this app
 *  uses. `extractAndParseJson` throws on prose, so it is wrapped: prose is a
 *  malformed answer, not a fault in the call. */
const parseAnswer = (raw: string): SettlementReflection | null => {
    try {
        return parseSettlementReflection(extractAndParseJson(sanitizeAIResponse(raw || '')));
    } catch {
        return null;
    }
};

/**
 * Reflect on ONE closed trade. Never throws: every failure returns the row
 * unchanged with a reason, and the caller keeps settling.
 */
export const reflectOnClosedTrade = async (
    trade: LoggedTrade,
    opts: ReflectionOptions,
): Promise<ReflectionResult> => {
    const skip = (reason: ReflectionSkipReason): ReflectionResult => ({ trade, wrote: false, reason });

    // A trader's own note (or a legacy row that still carries one) always wins.
    // 40 characters is the length that reads as "a real post-mortem exists".
    if ((trade.postMortem ?? '').trim().length >= 40) return skip('already-written');
    // Only rows the journal can act on: the lesson readers skip anything but
    // WIN/LOSS, so an ENTRY_NOT_HIT reflection would be a call with no consumer.
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return skip('not-a-lesson-row');
    // Spend nothing on a row that cannot become a technical rule. This is the
    // SAME predicate the journal-rules path uses, and it admits every row that
    // carries no root-cause class yet — `classifyRootCause('')` is UNCLEAR — so
    // an unreflected trade is never starved by the guard that exists to save it
    // a call. Execution slips and macro shocks stay out.
    if (!tradeAdmitsTechnicalStrategyRule(trade)) return skip('not-a-lesson-row');

    // The provider lookup can reject (a Preferences read failing), and a
    // rejection here would escape the "never throws" contract — taking the
    // caller's notebook sync down with it. A failure to FIND a provider is the
    // same outcome as not having one.
    let config: Awaited<ReturnType<typeof resolveMemoryConfig>>;
    try {
        config = await resolveMemoryConfig(opts.username);
    } catch {
        return skip('failed');
    }
    if (!config || !config.apiKey?.trim()) return skip('no-provider');

    // Marked only AFTER the provider gate: spending no call must not spend the
    // session's one attempt. A row settled while no provider was configured can
    // still be reflected once one is (a reload clears this set, but a later
    // settlement in the same session should not need one just to retry).
    const key = reflectedKey(opts.username, trade.id);
    if (reflectedKeys.has(key)) return skip('in-flight');
    reflectedKeys.add(key);
    if (reflectedKeys.size > 2000) {
        const oldest = [...reflectedKeys].slice(0, reflectedKeys.size - 2000);
        for (const id of oldest) reflectedKeys.delete(id);
    }

    const lane = beginPromptLane();
    const promptVersion = promptCorpusVersion(lane);
    const tier = effortForTask('postMortem');
    const meta = { model: config.selectedModel ?? '', lane, promptVersion, tier };

    try {
        const raw = await sendChatRequest(
            config,
            [
                { role: 'system', content: getPrompt('learning.settlement_reflection', SETTLEMENT_REFLECTION_FALLBACK, lane) },
                { role: 'user', content: reflectionPacket(trade, opts.injectedSkills) },
            ] as ChatMessage[],
            { maxTokens: TASK_BUDGETS.postMortem, temperature: 0.2, reasoningEffort: tier, signal: opts.signal },
        );
        // A throw from the TRANSPORT is a failed call; a throw from the JSON
        // extractor is a malformed ANSWER. Both write nothing, and they are
        // different reasons: one is "the model never answered", the other is
        // "it answered and it was not a reflection". Folding them would report a
        // bad prompt as a bad network.
        const reflection = parseAnswer(raw);
        if (!reflection) return skip('declined-or-malformed');
        return {
            trade: {
                ...trade,
                postMortem: renderPostMortem(reflection, meta.model),
                postMortemCreatedAt: new Date().toISOString(),
                // One provenance field naming the writer. Deliberately NOT
                // `postMortemByProvider`, which is the legacy per-provider
                // analyst map and means something else.
                postMortemModel: meta.model,
            },
            wrote: true,
            reason: 'written',
            ...meta,
        };
    } catch {
        // A failed reflection writes nothing and leaves the leg exactly as it
        // was today: the settlement still folds its diary, its mistakes and its
        // evidence, and the notebook simply has no lesson for this trade.
        return skip('failed');
    }
};
