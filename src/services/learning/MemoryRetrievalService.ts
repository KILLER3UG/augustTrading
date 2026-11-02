/**
 * Setup-aware retrieval for the trader notebook.
 *
 * Design:
 *  - ONE narrative voice: doctrine rides every stage; everything else is
 *    ranked data under a hard per-stage budget.
 *  - Diary is RAW STORAGE — never injected, deliberately. The model sees the
 *    conclusions (doctrine, settled beliefs, skills), never the journal. Note
 *    that nothing else reads it either: the doctrine rewriter works from the
 *    closed-trade log, not these files, so the diary currently survives only
 *    as the human-facing record. See docs/architecture/learning-loop.md.
 *  - Recurring-mistakes lines escalate into skills: once a skill owns a
 *    coin+direction cluster, the raw warning line goes quiet.
 *  - skill procedures live INSIDE skills (candidate → confirmed by evidence);
 *    there is no separate rules injection path.
 *  - Similar-trade history is verdict-stage material (and `recall` tool).
 *
 * Pull-over-push: analysts/debaters who want more history call the `recall`
 * desk tool instead of receiving bigger prompts.
 */

import { LoggedTrade } from '../../types';
import { clipNote } from '../../utils/harnessMarks';
import { normalizeSkillSlug } from '../../utils/followedSkills';
import { projectSkillCard } from './skillDocument';
import { shouldSkillHoldout } from '../../utils/skillHoldout';
import { regimeRankFactor } from '../../utils/regimeSentinel';
import { classifyStrategyFamily } from '../../utils/strategyFamily';
import { baseOf } from '../../utils/symbol';
import {
    RECENT_TRADES_WINDOW,
    briefFingerprint,
    buildRecentTradesBrief,
    neutralRowsText,
    selectRecentTrades,
    tallyLine,
} from '../../utils/recentTradesBrief';
import { normalizeStrategyFamily } from '../../types/strategy';
import { familyEdgeFactor, matrixSummaryBlock } from './strategyRegimeMatrix';
import { getMemoryFiles, searchNotebookNotes } from './MemoryFilesService';
import { readDoctrineForInjection } from './DoctrineConsolidationService';
import { settledBeliefsBlock, SETTLED_BELIEFS_BLOCK_MAX } from './settledBeliefs';
import { findRelevantTrades } from './PatternMemorySynthesisService';
import {
    isSkillFile,
    isApprovedSkill,
    isInjectableSkill,
    parseSkillMarkdown,
    skillBody,
    skillMatchesSetup,
    skillStatusAt,
    type SkillMeta,
} from './SkillMemoryService';
import { type MemoryRetrievalQuery } from './MemoryGraph';
import { charsForTokens, windowBudgetTokens } from '../../utils/tokenEstimate';
import { TENTATIVE_SKILL_INJECTION_MAX } from '../../constants/skillInjection';

export type { MemoryRetrievalQuery };

/** Hard per-stage budget for EVERYTHING except the doctrine slot.
 *
 * These are FLOORS, not the budget itself. They used to be the whole
 * allowance, which meant a 900-character notebook slice was the model's
 * ENTIRE retrieved memory regardless of whether it was talking to an 8K or a
 * 1M-context model. The effective budget now scales with the context window
 * (see `stageBudgetChars`) and these constants only stop it shrinking.
 */
const STAGE_BUDGET_CHARS: Record<MemoryStage, number> = {
    opening: 900,
    rebuttal: 400,
    verdict: 600,
};

/** Share of the retrieved-memory allowance each stage gets, relative to the
 *  opening — preserves the historical 900 : 400 : 600 proportions exactly. */
const STAGE_BUDGET_SHARE: Record<MemoryStage, number> = {
    opening: 1,
    rebuttal: STAGE_BUDGET_CHARS.rebuttal / STAGE_BUDGET_CHARS.opening,
    verdict: STAGE_BUDGET_CHARS.verdict / STAGE_BUDGET_CHARS.opening,
};

/** Fraction of the model's context window spent on retrieved memory, and a
 *  hard ceiling so a 1M-context model is not sent an unbounded notebook. */
const MEMORY_CONTEXT_FRACTION = 0.02;
const MEMORY_CONTEXT_MAX_TOKENS = 900;

/** Effective character budget for a stage: window-derived, never below the
 *  historical floor, never above the ceiling. */
export const stageBudgetChars = (
    stage: MemoryStage,
    contextWindowTokens?: number,
): number => {
    const tokens = windowBudgetTokens(
        MEMORY_CONTEXT_FRACTION,
        MEMORY_CONTEXT_MAX_TOKENS,
        contextWindowTokens,
    );
    const derived = charsForTokens(tokens * STAGE_BUDGET_SHARE[stage]);
    return Math.max(STAGE_BUDGET_CHARS[stage], derived);
};
const DOCTRINE_SLOT_CHARS = 800;
/** Verdict-stage skill-body cap. Exported because the A/B eval's treatment
 *  arm must send EXACTLY what this stage sends — an arm with its own budget
 *  measures an intervention production never applies
 *  (SkillEvalScheduler imports this constant). */
export const SKILL_BLOCK_MAX = 400;
/** Minimum content-word overlap between a skill's description and the live
 *  setup for the description to act as a retrieval trigger on its own. High
 *  enough that a coincidental shared noun cannot surface a skill whose
 *  structured fields say it belongs to a different setup. */
const DESCRIPTION_MATCH_MIN = 0.2;
const RISK_RULES_MAX = 300;
const MISTAKE_LINE_MAX = 200;
/** Extra matched skills surfaced as index lines at verdict depth (on top of #1). */
const VERDICT_EXTRA_SKILLS = 2;
/** Longest description an index line carries verbatim. Index lines are the
 *  ALWAYS-ON tier: a spec-max 1024-char description would spend the whole
 *  per-line budget on one skill, so the tail is clipped — named in the app's
 *  ONE marker voice, pointing at the file that holds the rest. Covers the
 *  realistic pushy description (~150-350 chars) without clipping it. */
const SKILL_INDEX_DESC_MAX = 240;
/**
 * Worst-case whole index line — status header + evidence tail + the capped
 * description + its clip note. The per-run cost estimate spends this per extra
 * skill instead of the old bare 160-char guess, which a spec-max description
 * would have silently blown past.
 *
 * MEASURED 2026-10-13 at the caps the code actually enforces: status word 9
 * (`SkillStatus` has three values), origin handle 40 (both the writer at
 * `SkillMemoryService:2646` and the reader at `:597` cut it there), evidence 58
 * (the longest string `evidenceFreshness` returns), description 240 plus its
 * clip note — 606 chars with a 64-char slug, which is what `serializeSkill`
 * allows the title to be. The previous value here was 460: 146 chars short of a
 * line the running path produces, so the estimate understated the always-on
 * layer it exists to account for.
 *
 * The one part with no cap upstream is the file name (`slugifyName` shortens
 * nothing), and the line embeds it twice — a longer slug than 64 grows the line
 * past this figure. `tests/skillDescriptionTrigger.test.ts` measures a real
 * produced line against it, so the number fails loudly instead of drifting.
 */
export const SKILL_INDEX_LINE_MAX = 620;
/** Pull tier (the recall tool): the model ASKED for the procedure, so it
 *  gets more than the verdict slice's standing injection — 700 on purpose,
 *  a different tier from `SKILL_BLOCK_MAX`, not a competing budget. */
const RECALL_SKILL_BODY_MAX = 700;

export interface RetrievedMemorySource {
    path: string;
    kind: 'identity' | 'skill' | 'playbook' | 'diary' | 'rules' | 'similar';
}

/**
 * Debate stage selector for retrieval budgeting.
 *   opening  — doctrine + best matched skill only (independent read)
 *   rebuttal — best matched skill only (tight counter-evidence)
 *   verdict  — doctrine + skills + similar trades (binding constraints)
 */
export type MemoryStage = 'opening' | 'rebuttal' | 'verdict';

/** Enabled, non-retired skills matching this setup, ranked by graph score:
 *  status weight × setup-dimension overlap × evidence freshness decay
 *  (the memory graph's semantics now drive production retrieval,
 *  not just the dashboard — with the M3 reconciliation that moderators see
 *  matched skills at index tier rather than being excluded entirely). */
/** The controlled strategy family a skill trades: its explicit
 *  strategyFamily when canonical, else a keyword classification of the
 *  pattern family + body. Undefined = no family signal (neutral factor). */
const skillStrategyFamily = (meta: SkillMeta): string | undefined =>
    normalizeStrategyFamily(meta.strategyFamily, classifyStrategyFamily)
    ?? classifyStrategyFamily(`${meta.family ?? ''} ${meta.body ?? ''}`);

/** Resolve the status a skill held at a point in time (existence + ledger
 *  replay). Undefined asOf ⇒ today's status. Returns null when the skill must
 *  be excluded from an as-of retrieval: created after the cutoff, or retired
 *  at it. A never-transitioned skill (empty ledger) existed with its current
 *  status since creation, so it passes. */
const statusAtTime = (
    meta: SkillMeta,
    file: { createdAt?: string | number },
    asOfMs: number | undefined,
): SkillMeta['status'] | null => {
    if (asOfMs === undefined) return meta.status;
    // MemoryFile stores epoch-ms numbers; tolerate ISO strings too.
    const created = typeof file.createdAt === 'number'
        ? file.createdAt
        : typeof file.createdAt === 'string'
            ? Date.parse(file.createdAt)
            : NaN;
    // The status ledger is also proof of existence: a transition cannot
    // predate the skill's creation.
    const earliestTransition = (meta.history ?? [])
        .map(h => Date.parse(h.validFrom))
        .filter(Number.isFinite)
        .reduce<number>((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
    const existedAt = (Number.isFinite(created) && created <= asOfMs)
        || earliestTransition <= asOfMs;
    if (!existedAt) return null; // didn't exist yet
    const replayed = skillStatusAt(meta, asOfMs);
    if (replayed === null) return meta.status; // predates ledger ⇒ never changed
    return replayed === 'retired' ? null : replayed;
};

const rankedMatchedSkills = (
    query?: MemoryRetrievalQuery,
    audience?: 'analyst' | 'moderator',
    asOfMs?: number,
): Array<{ file: ReturnType<typeof getMemoryFiles>['files'][number]; meta: SkillMeta; score: number; status: SkillMeta['status'] }> => {
    if (!query) return [];
    const setup = {
        coin: query.coin,
        direction: query.direction === 'Long' || query.direction === 'Short' ? query.direction : undefined,
        family: query.family,
        pattern: query.pattern,
        regime: typeof query.regime === 'string' ? query.regime : undefined,
    };
    const candidates: Array<{ file: ReturnType<typeof getMemoryFiles>['files'][number]; meta: SkillMeta; score: number; status: SkillMeta['status'] }> = [];
    for (const file of getMemoryFiles().files) {
        if (!file.enabled || !isSkillFile(file)) continue;
        const meta = parseSkillMarkdown(file.content);
        if (!meta) continue;
        // THE INJECTION GATE (see `isInjectableSkill`): an approved skill, or a
        // tentative one earned from independent outcomes while the trader's
        // tentative channel is on. Enforcement still reads `isApprovedSkill`,
        // so a tentative rule can be shown as context but never vetoes.
        if (!isInjectableSkill(meta)) continue;
        // Point-in-time: a skill created (or retired) after the cutoff is
        // invisible — an older run must not learn from a lesson the future
        // wrote. Without asOf this is exactly the old retired-check.
        const status = statusAtTime(meta, file, asOfMs);
        if (status === null || status === 'retired') continue;
        // CANDIDACY: structured fields OR the description naming the setup.
        // `skillMatchesSetup` alone made every general lesson unretrievable
        // the instant its coin/direction/family/regime did not line up — and
        // the description, which is the field that says what a skill does and
        // when it applies, was never consulted. The description gate has a
        // floor so a single shared content word ('reclaim' in a 40-word
        // description) cannot qualify a skill: it takes genuine topical
        // overlap with the live setup. A skill that qualifies on neither
        // signal stays invisible, exactly as before.
        const descScore = descriptionOverlap(meta, query);
        const descHit = descScore >= DESCRIPTION_MATCH_MIN;
        // A prose match may broaden retrieval for an unscoped/general skill,
        // but it must never overrule explicit scope written on the skill.
        // Otherwise a BTC-short rule whose wording happens to share words
        // with an ETH-long setup can cross the structured safety boundary.
        const scopeCoin = setup.coin?.toUpperCase().replace(/USDT?$/, '');
        const skillCoin = meta.coin?.toUpperCase().replace(/USDT?$/, '');
        const familyQuery = setup.family || setup.pattern;
        const explicitScopeConflict = Boolean(
            (scopeCoin && skillCoin && scopeCoin !== skillCoin)
            || (setup.direction && meta.direction && setup.direction !== meta.direction)
            || (setup.regime && meta.regime && setup.regime !== meta.regime)
            || (familyQuery && meta.family && !skillMatchesSetup(meta, { family: familyQuery }))
        );
        if (descHit && explicitScopeConflict) continue;
        if (!descHit && !skillMatchesSetup(meta, setup)) continue;
        // Audience filtering happens BEFORE ranking (#4 invocation control): a
        // blocked best-match must surface the second-best skill, not an empty slot.
        if (audience && !skillAllowedFor(meta, audience)) continue;
        // HUMAN-INVOKED ONLY (#6, Claude's `disable-model-invocation`): a
        // `manualOnly` skill is background knowledge the trader can read with
        // `/slug`, and is never handed to a seat on its own — no matter how
        // perfectly it matches. Absent = injects normally, so every skill
        // written before the field is byte-identical. `resolveInvokedSkills`
        // does NOT read this gate: that path IS the human asking.
        if (meta.manualOnly) continue;
        // Zero-evidence skills stay OUT of prompt injection.
        // A 0W/0L draft is an unproven hunch; injecting it gave the model no
        // basis to weigh it against — and contradicted the dashboard's own
        // "stays unenforced until it earns a record" message.
        // EXCEPTIONS — skills whose warrant does not come from this trader's
        // own counted record (see SkillMeta.prior):
        //   'book'  — curated literature (the seed corpus), injects from birth.
        //   'gated' — a draft that cleared the draft gates + worth gate and
        //     was approved. It must be injected to earn its FIRST counted
        //     sample: evidence only accrues on the FOLLOWED branch of
        //     applySkillEvidence, so excluding an approved-but-unproven skill
        //     deadlocks the loop (no injection ⇒ CONTROL ⇒ no evidence ⇒ no
        //     injection). Labeled 0W/0L so the model weighs it as a
        //     hypothesis, not a settled rule.
        if ((meta.wins + meta.losses) === 0 && !meta.prior) continue;
        // Graph score: status weight (confirmed 2 / candidate 1)
        // × dimension overlap count × evidence-freshness decay. Mirrors the
        // appliesWhen weights the dashboard graph assigns, so the two views
        // can never disagree about what matters.
        const statusWeight = status === 'confirmed' ? 2 : 1;
        const overlap = dimsOverlap(meta, query);
        // A skill whose evidence mix diverges from the market's current
        // 30-day regime mix is downweighted (stale-by-regime, distinct from
        // stale-by-time) until fresh evidence in the current mix re-converges.
        // The family × regime matrix adds the strategy-layer tilt: a skill
        // trading a family that has proven edge (or decay) in the CURRENT
        // regime moves accordingly — the book's regime-gating as evidence.
        const score = statusWeight * overlap * evidenceDecay(meta, asOfMs) * regimeRankFactor(meta, query?.coin)
            * familyEdgeFactor(skillStrategyFamily(meta), typeof query?.regime === 'string' ? query.regime : undefined)
            // A skill whose description names THIS setup outranks one that
            // merely shares a field. Multiplied in rather than added because
            // every other term is a multiplier too — an additive bonus would
            // let a weak-evidence skill leapfrog a strong one on vocabulary
            // alone. The boost is bounded so it can reorder, not dominate:
            // a 1.6x lift on a confirmed skill beats a candidate, but never
            // outweighs the status weight of a confirmed over a candidate.
            * (1 + descScore * 1.5);
        candidates.push({ file, meta, score, status });
    }
    candidates.sort((a, b) => b.score - a.score || (b.meta.wins + b.meta.losses) - (a.meta.wins + a.meta.losses));
    // A tentative rule is context, not a rulebook. The cap applies to the
    // CANDIDATE POOL, so neither the primary block nor the verdict's extra
    // index lines can exceed it.
    const tentative = candidates.filter(c => c.meta.approvedBy === 'tentative');
    if (tentative.length <= TENTATIVE_SKILL_INJECTION_MAX) return candidates;
    const keep = new Set(tentative.slice(0, TENTATIVE_SKILL_INJECTION_MAX).map(c => c.file.name));
    return candidates.filter(c => c.meta.approvedBy !== 'tentative' || keep.has(c.file.name));
};

/** Count shared setup dimensions between a skill and the current query. */
const dimsOverlap = (meta: SkillMeta, query: MemoryRetrievalQuery): number => {
    let n = 0;
    // Canonical base coins (utils/symbol) — query and stored skill meta are
    // normalized through the SAME helper so the join never splits on a quote
    // suffix ('BTCUSDT' and 'BTC' are one coin).
    const coin = baseOf(query.coin || '');
    const skillCoin = baseOf(meta.coin || '');
    if (coin && skillCoin && coin === skillCoin) n += 1;
    if (query.direction && meta.direction && query.direction === meta.direction) n += 1;
    if ((query.family || query.pattern) && meta.family && (query.family === meta.family)) n += 1;
    if (query.regime && meta.regime && String(query.regime) === meta.regime) n += 1;
    return Math.max(n, 0.5); // a bare trigger match still scores, just low
};

/** Stop-words a setup phrase and a skill description both carry regardless of
 *  topic. Excluded so shared vocabulary cannot manufacture a match. "use" and
 *  "whenever" are the pushy description template's own words — every
 *  synthesized description carries them, and unfiltered they would dilute
 *  every score by the same dead weight. */
const DESCRIPTIVE_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'when', 'while', 'until', 'before', 'after',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those',
    'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'over', 'under',
    'not', 'no', 'do', 'does', 'did', 'use', 'whenever', 'take', 'trade', 'setup', 'avoid', 'repeat', 'skill',
    'short', 'long', 'entry', 'enter', 'exit', 'target', 'stop', 'loss', 'level', 'levels',
    'learned', 'cluster', 'losing', 'winning', 'trades', 'pattern', 'price', 'market',
]);

/** Lowercased content words of a text, minus stop-words. */
const contentWords = (text: string): Set<string> => {
    const words = (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !DESCRIPTIVE_STOPWORDS.has(w));
    return new Set(words);
};

/**
 * The pushy description template ends with a "Do NOT use for X" exclusion
 * clause. The scorer cannot weigh negation, so the clause is cut before
 * scoring — a description that names the situation it refuses must not have
 * that situation's words counted toward a match. Scoring ONLY: the full
 * description still renders and injects. The phrase is a fixed contract with
 * the writers — utils/skillDescription.ts and the craft prompts.
 */
const EXCLUSION_SPLIT = /\bdo\s+not\s+use\b/i;

const positiveDescription = (description: string): string => {
    const at = description.search(EXCLUSION_SPLIT);
    // A description that STARTS with the exclusion has no trigger clause at
    // all — malformed, but scoring the whole string keeps its behavior
    // identical to an unsplit description instead of zeroing it silently.
    return at > 0 ? description.slice(0, at) : description;
};

/**
 * Semantic overlap between a skill's DESCRIPTION and the live setup.
 *
 * The research plan's #1: in both reference products the description is the
 * trigger — it is what says what a skill does and when it applies. Here it
 * was render-only (see `skillIndexLine`), so a skill whose prose names
 * exactly the situation in front of the trader was invisible the moment its
 * structured fields (coin/direction/family/regime) did not line up, which is
 * every general lesson.
 *
 * Returns a 0..1 Jaccard overlap of content words. This can admit general
 * lessons whose prose describes the setup, but explicit structured scope is
 * checked separately before a description hit is accepted.
 */
const descriptionOverlap = (
    meta: SkillMeta,
    query: MemoryRetrievalQuery,
): number => {
    const setupText = [
        query.coin,
        query.direction,
        query.family,
        query.pattern,
        query.regime,
    ].filter(Boolean).join(' ');
    const a = contentWords(positiveDescription(meta.description || ''));
    const b = contentWords(setupText);
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) if (b.has(w)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
};

/** Evidence-age decay for scoring — same 120-day constant as MemoryGraph.
 *  Age is measured from `asOfMs` when a point-in-time replay is running. */
const evidenceDecay = (meta: SkillMeta, asOfMs?: number): number => {
    if (!meta.lastEvidenceAt) return 0.75;
    const t = Date.parse(meta.lastEvidenceAt);
    if (!Number.isFinite(t)) return 0.75;
    const ageDays = Math.max(0, ((asOfMs ?? Date.now()) - t) / 86_400_000);
    return Math.exp(-ageDays / 120);
};

/**
 * Rough per-run token cost of memory injection (Zed's "may increase token
 * costs" disclosure, made concrete). Worst case = doctrine slot + settled
 * beliefs + skill body + risk rules + mistake line + verdict extras; typical
 * opening ≈ half that. ~4 chars/token for English prose. Display-only.
 *
 * BOTH always-on slots are counted. The settled-beliefs slot rides ABOVE the
 * doctrine and is injected on every stage just like it — an estimate that
 * named the doctrine and omitted the beliefs was not a worst case, it was an
 * optimistic one, and it is the figure the Health tab shows the trader as
 * their per-run prompt cost. The two always-on layers are the ONE part of
 * memory injection that does not shrink with a smaller stage budget, so they
 * are also the part most likely to be under-reported.
 */
export function estimateMemoryTokensPerRun(): { worstCase: number; typical: number } {
    const chars =
        DOCTRINE_SLOT_CHARS +
        SETTLED_BELIEFS_BLOCK_MAX +
        SKILL_BLOCK_MAX +
        RISK_RULES_MAX +
        MISTAKE_LINE_MAX +
        VERDICT_EXTRA_SKILLS * SKILL_INDEX_LINE_MAX;
    const worstCase = Math.round(chars / 4);
    return { worstCase, typical: Math.round(worstCase / 2) };
};

const bestMatchedSkill = (
    query?: MemoryRetrievalQuery,
    audience?: 'analyst' | 'moderator',
    asOfMs?: number,
): { file: ReturnType<typeof getMemoryFiles>['files'][number]; meta: SkillMeta; status: SkillMeta['status'] } | null =>
    rankedMatchedSkills(query, audience, asOfMs)[0] ?? null;

/**
 * Doctrine block — the ONE narrative voice, fixed slot on every stage.
 */
const doctrineBlock = (): string => {
    try {
        const doctrine = readDoctrineForInjection();
        if (!doctrine) return '';
        const capped = doctrine.length > DOCTRINE_SLOT_CHARS
            ? `${doctrine.slice(0, DOCTRINE_SLOT_CHARS).trimEnd()}\n…`
            : doctrine;
        return `**My trading doctrine (settled beliefs):**\n${capped}`;
    } catch {
        return '';
    }
};

/** The single best-matched skill body, capped. */
/** Human-readable evidence freshness for a skill (relative-time label). */
export function evidenceFreshness(meta: SkillMeta): string {
    if (!meta.lastEvidenceAt) return 'no counted evidence yet';
    const t = Date.parse(meta.lastEvidenceAt);
    if (!Number.isFinite(t)) return 'no counted evidence yet';
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0) return 'evidence from today';
    if (days === 1) return 'evidence from yesterday';
    if (days <= 30) return `evidence ${days}d old`;
    if (days <= 90) return `evidence ${Math.floor(days / 7)}w old — treat as stale`;
    return 'evidence 3+ months old — stale, verify before relying on it';
};

/**
 * #4 invocation control (Agent Skills frontmatter port): `audience: analyst`
 * hides a skill from moderator-facing assembly, `audience: moderator` the
 * reverse. Default `all`.
 */
const skillAudience = (meta: SkillMeta): 'all' | 'analyst' | 'moderator' =>
    meta.audience ?? 'all';

const skillAllowedFor = (meta: SkillMeta, audience: 'analyst' | 'moderator'): boolean =>
    skillAudience(meta) === 'all' || skillAudience(meta) === audience;

/**
 * #5 dynamic context injection: skill bodies may reference ${SYMBOL} /
 * ${REGIME} / ${DIRECTION}; substituted with the live setup at assembly
 * time so the model reads facts, not placeholders.
 */
export function substituteSkillContext(text: string, query?: MemoryRetrievalQuery): string {
    return text
        .replace(/\$\{SYMBOL\}/g, (query?.coin ?? 'this coin').toUpperCase())
        .replace(/\$\{REGIME\}/g, (typeof query?.regime === 'string' && query.regime) || 'the current regime')
        .replace(/\$\{DIRECTION\}/g, (query?.direction === 'Long' || query?.direction === 'Short') ? query.direction : 'either direction');
}

/** One-line index entry (progressive disclosure tier 1 — near-zero tokens). */
const skillIndexLine = (name: string, meta: SkillMeta, status?: SkillMeta['status']): string => {
    // The stored one-sentence description wins when present (zcode memory
    // pattern) — it was written to be read by models and humans alike. A
    // spec-max description is clipped to the always-on budget, with the clip
    // named so the model reads the line as an index, not the whole skill.
    const rule = meta.description
        ? (meta.description.length > SKILL_INDEX_DESC_MAX
            ? `${meta.description.slice(0, SKILL_INDEX_DESC_MAX).trimEnd()} ${clipNote({
                source: 'skill description',
                kept: SKILL_INDEX_DESC_MAX,
                total: meta.description.length,
                guidance: `the full text is in skills/${name}`,
            })}`
            : meta.description)
        : meta.when
            || meta.body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 100) || name;
    const unprovenLabel = meta.prior === 'book'
        ? 'book prior — no local record yet'
        : meta.prior === 'gated'
            ? 'approved draft, untested — weigh it as a hypothesis'
            : '';
    const evidence = (meta.wins + meta.losses) === 0 && unprovenLabel
        ? unprovenLabel
        : evidenceFreshness(meta);
    const tentative = meta.approvedBy === 'tentative' ? ' · TENTATIVE — context only, not enforced' : '';
    return `${meta.kind === 'avoid' ? 'AVOID' : 'REPEAT'} [${status ?? meta.status} · ${Math.round(meta.wins)}W/${Math.round(meta.losses)}L · ${evidence}${tentative}${meta.originBotName ? ` · from @${meta.originBotName}` : ''}] ${rule}`;
};

/**
 * Matched-skill block. Openings/rebuttals get the INDEX LINE only (tier 1);
 * verdicts get the full body (tier 2); recall serves the full body anytime.
 */
const matchedSkillBlock = (
    query?: MemoryRetrievalQuery,
    audience?: 'analyst' | 'moderator',
    stage: MemoryStage = 'opening',
    asOfMs?: number,
): { text: string; meta: SkillMeta | null; name: string } => {
    const match = bestMatchedSkill(query, audience, asOfMs);
    if (!match) return { text: '', meta: null, name: '' };
    const tentativeTag = match.meta.approvedBy === 'tentative'
        ? ' · TENTATIVE — context only, not enforced'
        : '';
    const header = `[skills/${match.file.name} · ${match.status} · ${Math.round(match.meta.wins)}W/${Math.round(match.meta.losses)}L${tentativeTag}${match.meta.originBotName ? ` · from @${match.meta.originBotName}` : ''}]`;
    if (stage !== 'verdict') {
        return { text: `${header}\n${skillIndexLine(match.file.name, match.meta)}`, meta: match.meta, name: match.file.name };
    }
    const titleBits = [match.meta.kind === 'avoid' ? 'Avoid' : 'Repeat', match.meta.coin, match.meta.direction]
        .filter(Boolean).join(' ');
    // Inject the BODY, never the raw file: a real skill file carries 25-35
    // YAML frontmatter lines (status/counts/history/shadow JSON…), and under
    // the 400-char cap the raw file meant the metadata ate the entire budget
    // and the actual PROCEDURE was truncated away. skillBody() makes the
    // budget buy procedure text — which is all the model can act on.
    const body = substituteSkillContext(skillBody(match.file.content), query);
    // THE BINDING STAGE GETS THE PROJECTED CARD, not the first 400 chars.
    //
    // slice(0, SKILL_BLOCK_MAX) spends the verdict's whole budget on whatever
    // prose arrived first — and the craft writes the verbose trigger ("When:")
    // first, so a long skill handed the deciding seat 400 chars of situation
    // description and never reached a single step. The recall tool, which the
    // model must ASK for, already did this correctly via projectSkillCard
    // (rule → trigger → when-NOT → pitfall → verification → ticket → numbered
    // procedure → examples). The stage that produces the binding decision must
    // not be served worse than the on-demand one, so it uses the same projector.
    //
    // A body that already fits is served UNCHANGED — the projector's own
    // guard — so short skills keep their exact text, and the clip is named in
    // the app's ONE marker voice (harnessMarks) rather than a bare "…" the
    // model would read as the procedure simply ending.
    const card = projectSkillCard(body, {
        when: match.meta.when,
        budget: SKILL_BLOCK_MAX,
    });
    const slug = normalizeSkillSlug(match.file.name);
    const capped = card.clipped
        ? `${card.text}\n${clipNote({
            source: 'skill procedure',
            kept: card.chars,
            total: card.chars + card.droppedChars,
            guidance: `the rest is in skills/${slug}.md — call recall for it if a step you need is missing`,
        })}`
        : card.text;
    // Provenance: how many logged trades
    // shaped this rule — from the monotonic evidence counter, not the
    // tail-20 tradeIds list.
    const provenance = (match.meta.evidenceCount ?? match.meta.tradeIds.length) > 0
        ? `learned from ${match.meta.evidenceCount ?? match.meta.tradeIds.length} logged trade(s)`
        : '';
    return {
        text: `${header}\n${[evidenceFreshness(match.meta), provenance].filter(Boolean).join(' · ')}\n${titleBits}\n${capped}`,
        meta: match.meta,
        name: match.file.name,
    };
};

/**
 * Per-lens skill supplement: the best IN-SCOPE skill index line for one lens
 * seat, or '' when that seat's best in-scope skill is already the global
 * best (the shared analyst slice shows it to every seat anyway). This is
 * how a lens seat sees its OWN top skill even when a higher-ranked
 * out-of-scope skill occupies the shared slot.
 */

/**
 * Risk-rules excerpt — hard rules only (always-on identity file), capped tight.
 */
const riskRulesBlock = (): string => {
    const { files, folders } = getMemoryFiles();
    const folder = folders.find(f => f.name === 'rules');
    const file = files.find(f => f.folderId === folder?.id && f.name === 'risk-rules.md');
    if (!file?.enabled) return '';
    // Strip the instructional preamble — keep bullet lines only.
    const bullets = file.content.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 6).join('\n');
    if (!bullets) return '';
    return cap(`[rules/risk-rules.md]\n${bullets}`, RISK_RULES_MAX);
};

/**
 * Identity slice — profile/memory.md ("About the Trader"), compact and
 * always-on. Who the model is: stats, preferences, style. Capped tight.
 */
const identityBlock = (): string => {
    const { files, folders } = getMemoryFiles();
    const folder = folders.find(f => f.name === 'profile');
    const file = files.find(f => f.folderId === folder?.id && f.name === 'memory.md');
    if (!file?.enabled) return '';
    const bullets = file.content.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 7).join('\n');
    if (!bullets) return '';
    return cap(`[profile/memory.md]\n${bullets}`, 300);
};

/**
 * Recurring-mistakes line for a cluster ONLY when no enabled skill owns that
 * coin+direction. Escalation contract: mistake → skill created → line silent.
 */
const uncoveredMistakeLine = (query?: MemoryRetrievalQuery): string => {
    if (!query?.coin) return '';
    const { files, folders } = getMemoryFiles();
    const rulesFolder = folders.find(f => f.name === 'rules');
    const file = files.find(f => f.folderId === rulesFolder?.id && f.name === 'recurring-mistakes.md');
    if (!file?.enabled) return '';

    // Does an enabled skill already own this coin (+direction when set)?
    const setup = {
        coin: query.coin,
        direction: query.direction === 'Long' || query.direction === 'Short' ? query.direction : undefined,
    };
    const owned = getMemoryFiles().files.some(f => {
        if (!f.enabled || !isSkillFile(f)) return false;
        const meta = parseSkillMarkdown(f.content);
        if (!meta || meta.status === 'retired') return false;
        // Only a LIVE skill may suppress the raw warning: an unapproved twin used
        // to silence the trader's own recorded mistake without replacing it with
        // anything they had agreed to (the 2026-10-27 audit S-4).
        if (!isApprovedSkill(meta)) return false;
        if ((meta.coin ?? '').toLowerCase() !== setup.coin.toLowerCase()) return false;
        if (setup.direction && meta.direction && meta.direction !== setup.direction) return false;
        return true;
    });
    if (owned) return ''; // skill owns it — raw warning would be a stale duplicate

    const line = file.content
        .split('\n')
        .find(l => l.includes(` ${setup.coin.toUpperCase()} `) || l.includes(`${setup.coin.toUpperCase()} `));
    if (!line) return '';
    return cap(`[rules/recurring-mistakes.md]\n${line.trim()}`, MISTAKE_LINE_MAX);
};

/**
 * Avoid-vs-repeat conflict flag: when BOTH kinds of enabled skill match this
 * exact setup, say so instead of silently letting sample size pick a winner.
 * One line, verdict-stage only — where the full bodies are actually shown.
 */
const conflictNote = (query?: MemoryRetrievalQuery): string => {
    if (!query) return '';
    const setup = {
        coin: query.coin,
        direction: query.direction === 'Long' || query.direction === 'Short' ? query.direction : undefined,
        family: query.family,
        pattern: query.pattern,
        regime: typeof query.regime === 'string' ? query.regime : undefined,
    };
    let avoid = false;
    let repeat = false;
    for (const file of getMemoryFiles().files) {
        if (!file.enabled || !isSkillFile(file)) continue;
        const meta = parseSkillMarkdown(file.content);
        if (!meta || meta.status === 'retired') continue;
        // SAME eligibility as ranked retrieval: an unapproved skill must not
        // silence a warning or raise a conflict the seat is told to resolve
        // (the 2026-10-27 audit S-4).
        if (!isApprovedSkill(meta)) continue;
        if (!skillMatchesSetup(meta, setup)) continue;
        if (meta.kind === 'avoid') avoid = true; else repeat = true;
        if (avoid && repeat) break;
    }
    if (!(avoid && repeat)) return '';
    return '[notebook conflict] Both an AVOID and a REPEAT skill match this setup and they disagree — resolve against doctrine and evidence freshness rather than habit.';
};

/** Similar closed trades — verdict-stage history (and the recall tool). */
const similarTradesBlock = (query: MemoryRetrievalQuery | undefined, trades?: LoggedTrade[], asOfMs?: number): string => {
    if (!trades || trades.length === 0 || !query) return '';
    // Age-decayed similarity — old associations weigh less in
    // prompts, honoring the edge-decay contract end to end.
    const relevant = findRelevantTrades({
        coin: query.coin,
        direction: query.direction === 'Long' || query.direction === 'Short' ? query.direction : undefined,
        pattern: query.pattern,
        family: query.family,
        regime: query.regime as 'trending' | 'ranging' | 'volatile' | 'compression' | undefined,
    }, trades, { decayByAge: true, cutoffMs: asOfMs }).slice(0, 5);
    if (relevant.length === 0) return '';
    const lines = relevant.map(t =>
        `- ${t.coin} ${t.direction} ${t.outcome} (${t.similarity}% similar)${t.keyLesson ? ` — ${t.keyLesson}` : ''}`
    );
    return `**Similar closed trades**\n${lines.join('\n')}`;
};

const cap = (text: string, n: number): string =>
    text.length <= n ? text : `${text.slice(0, n).trimEnd()}\n…`;

/**
 * Recent form — what the last 20 logged trades did, in the shape the reader may
 * use it in.
 *
 * Two renderings, one builder:
 *  - analyst seats get the TAPE: neutral rows, no win rate, no streak. A seat
 *    arguing this setup must be able to check "my last losses were all revenge
 *    trades" against the record, but handing every opening prompt "you are three
 *    losses deep" is priming dressed as evidence — which is why loss-priming
 *    lives in its own deliberate, coin-scoped slice.
 *  - the moderator (and the post-mortem, which reuses its path) gets the TALLY:
 *    streak, win rate, net PnL. Weighing recent form is its actual job.
 *
 * Rows are day-level and ~50 chars each, so the window costs roughly what a
 * matched skill costs rather than what a market packet does; the full ISO row
 * stays behind `get_trade_log`. Both renderings are fingerprinted into the
 * injection record, which a trade reaches through its own `sourceRunId`.
 */
export const recentFormBlock = (
    trades?: LoggedTrade[],
    asOfMs?: number,
    audience: 'analyst' | 'moderator' = 'analyst',
): string => {
    if (!trades || trades.length === 0) return '';
    const visible = asOfMs === undefined
        ? trades
        : trades.filter(t => {
            const ms = Date.parse(t.timestamp ?? '');
            return Number.isFinite(ms) && ms <= asOfMs;
        });
    const brief = buildRecentTradesBrief(selectRecentTrades(visible, { limit: RECENT_TRADES_WINDOW }));
    if (brief.rows.length === 0) return '';
    // Two shapes on purpose. An analyst arguing THIS setup gets the tape — rows,
    // no aggregate framing — because a streak handed to every opening prompt is
    // priming, not evidence. The moderator, whose job is to weigh recent form
    // against the debate, gets the tally.
    return audience === 'moderator'
        ? `**Recent form**\n${tallyLine(brief, 'Last 20 logged trades')}`
        : `**Your logged trades**\n${neutralRowsText(brief)}`;
};

/** Cross-block dedup key: lowercase alphanumerics only. */
const dedupKey = (line: string): string =>
    line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Drop substantive lines that an EARLIER block already injected. Skills,
 * risk rules, similar trades and the doctrine are written independently and
 * routinely phrase the same lesson twice — the second copy only burns budget
 * and teaches the model nothing. Short/structural lines (headers, bullets
 * under 12 normalized chars) are always kept.
 */
const dedupeContentLines = (sections: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const section of sections) {
        const kept: string[] = [];
        for (const line of section.split('\n')) {
            const key = dedupKey(line);
            if (key.length >= 12) {
                if (seen.has(key)) continue;
                seen.add(key);
            }
            kept.push(line);
        }
        const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text) out.push(text);
    }
    return out;
};

export function listRetrievedMemorySources(
    query?: MemoryRetrievalQuery,
    trades?: LoggedTrade[],
    audience: 'analyst' | 'moderator' = 'analyst',
): RetrievedMemorySource[] {
    const out: RetrievedMemorySource[] = [];
    try {
        if (settledBeliefsBlock()) out.push({ path: 'profile/settled-beliefs', kind: 'identity' });
    } catch { /* registry unreadable — skip the source line */ }
    if (doctrineBlock()) out.push({ path: 'profile/doctrine', kind: 'identity' });
    if (identityBlock()) out.push({ path: 'profile/memory', kind: 'identity' });
    const skillMatch = matchedSkillBlock(query, audience, 'opening');
    if (skillMatch.meta) out.push({ path: `skills/${skillMatch.name}`, kind: 'skill' });
    if (riskRulesBlock()) out.push({ path: 'rules/risk-rules', kind: 'rules' });
    if (uncoveredMistakeLine(query)) out.push({ path: 'rules/recurring-mistakes', kind: 'rules' });
    if (similarTradesBlock(query, trades)) out.push({ path: 'journal/similar-trades', kind: 'similar' });
    if (recentFormBlock(trades, undefined, audience)) out.push({ path: 'journal/recent-form', kind: 'similar' });
    return out;
};

/**
 * Capped, setup-ranked harness context.
 *
 * Fill order per stage (budget enforced across all non-doctrine blocks):
 *   1. best matched skill   2. risk-rules excerpt   3. uncovered mistake line
 *   4. similar trades (verdict only)
 * Doctrine has its own always-on slot and does not count against the budget.
 */
export interface MemoryContextOptions {
    /** Exclude one skill (file stem) from matching —
     *  used by the A/B eval so the "baseline minus skill" arm genuinely
     *  omits the skill under test. */
    excludeSkillName?: string;
    /** Record the injection in the attribution ledger — OPT IN.
     *
     *  A record says "the model saw skill X in this run", and the ledger
     *  (skill evidence, lift, the dashboard) grants a skill credit for every
     *  recorded injection. So a record may only be written for a block that
     *  was ACTUALLY SENT. This used to default to ON, and the pipeline
     *  assembles a full retrieval (matched skill body, risk rules, similar
     *  setups, the skill-trigger note) into a prompt it then never sends —
     *  so the ledger credited skills for context the model never read, and
     *  the "enforcement" evidence was fiction.
     *
     *  Callers that really send the block opt in explicitly:
     *  `services/agents/botLearning.ts` (a bot's shared-memory context, which
     *  rides its prompt). The A/B eval arms opt OUT (synthetic contexts must
     *  not fall inside a future trade's attribution window). */
    recordInjections?: boolean;
    /** Per-run id used to seed the reproducible ε-holdout decision.
     *  Omitted ⇒ this retrieval never holds out (conservative default). */
    runId?: string;
    /** Point-in-time replay cutoff (epoch ms). When set, skills created after
     *  it — or retired at it — are invisible, and evidence freshness is aged
     *  from it. Evidence COUNTS are not replayed (the status ledger records
     *  transitions, not samples), so this gates existence and status only.
     *  Omitted ⇒ today's behavior, byte-identical. */
    asOfMs?: number;
    /** The model's context window (tokens) — threads to `stageBudgetChars`
     *  so the stage budget derives from the REAL window instead of always
     *  assuming the default. Omitted ⇒ `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS`,
     *  byte-identical to before the field existed. */
    contextWindowTokens?: number;
}

export function getMemoryFilesContext(
    query?: MemoryRetrievalQuery,
    trades?: LoggedTrade[],
    audience: 'analyst' | 'moderator' = 'analyst',
    stage: MemoryStage = 'opening',
    options?: MemoryContextOptions,
): string {
    const budget = stageBudgetChars(stage, options?.contextWindowTokens);
    const blocks: string[] = [];
    /** What ACTUALLY made it into the prompt — recorded for attribution. */
    const injected: Array<{ path: string; kind: string; chars?: number; fingerprint?: string }> = [];
    let used = 0;
    /** Characters that existed but did not fit. Reported to the model rather
     *  than cut silently: a silent trim makes an absent lesson look like a
     *  contradicted one, and the model cannot ask for what it cannot see. */
    let elidedChars = 0;

    const push = (block: string): number => {
        if (!block || used >= budget) {
            if (block && used >= budget) elidedChars += block.length;
            return 0;
        }
        const room = budget - used;
        const capped = cap(block, room);
        blocks.push(capped);
        used += capped.length;
        if (capped.length < block.length) elidedChars += block.length - capped.length;
        return capped.length;
    };

    const exclude = options?.excludeSkillName?.toLowerCase().replace(/\.md$/i, '');
    // ε-holdout: on ~10% of runs (seeded per run id) skill injection is
    // withheld entirely so the control group keeps growing. The decision is
    // the same for the analyst-opening and moderator-verdict slices of a run
    // (same runId), recorded on the injection record, and mirrored in runStats.
    const holdout = Boolean(options?.runId && shouldSkillHoldout(options.runId));
    const identChars = push(identityBlock());
    if (identChars > 0) injected.push({ path: 'profile/memory', kind: 'identity', chars: identChars });
    if (stage === 'verdict') push(conflictNote(query)); // a flag, not a notebook source
    const primary = (() => {
        if (!exclude) return matchedSkillBlock(query, audience, stage, options?.asOfMs);
        const firstNonExcluded = rankedMatchedSkills(query, audience, options?.asOfMs)
            .find(m => m.file.name.toLowerCase().replace(/\.md$/i, '') !== exclude);
        return firstNonExcluded
            ? { text: `[skills/${firstNonExcluded.file.name}] ${skillIndexLine(firstNonExcluded.file.name, firstNonExcluded.meta, firstNonExcluded.status)}`, meta: firstNonExcluded.meta, name: firstNonExcluded.file.name }
            : { text: '', meta: null as SkillMeta | null, name: '' };
    })();
    if (!holdout) {
        const skillChars = push(primary.text);
        if (skillChars > 0 && primary.meta) {
            injected.push({ path: `skills/${primary.name}`, kind: 'skill', chars: skillChars });
        }
    }
    if (!holdout && stage === 'verdict') {
        // Top-K: verdict depth surfaces the runners-up as index
        // lines — one matching skill is a coincidence, two a pattern.
        // The primary skill is already pushed above — skip it
        // here so it never renders twice when no exclusion is set.
        const ranked = rankedMatchedSkills(query, undefined, options?.asOfMs).filter(
            m => (!exclude || m.file.name.toLowerCase().replace(/\.md$/i, '') !== exclude)
                && m.file.name !== primary.name,
        );
        for (const extra of ranked.slice(0, VERDICT_EXTRA_SKILLS)) {
            const extraChars = push(`[skills/${extra.file.name}] ${skillIndexLine(extra.file.name, extra.meta, extra.status)}`);
            if (extraChars > 0) {
                injected.push({ path: `skills/${extra.file.name}`, kind: 'skill', chars: extraChars });
            }
        }
    }
    const riskChars = push(riskRulesBlock());
    if (riskChars > 0) injected.push({ path: 'rules/risk-rules', kind: 'rules', chars: riskChars });
    const mistakeChars = push(uncoveredMistakeLine(query));
    if (mistakeChars > 0) injected.push({ path: 'rules/recurring-mistakes', kind: 'rules', chars: mistakeChars });
    // Every stage, both audiences: a seat arguing this setup should know the
    // trader is 3 losses deep before it argues, not after.
    const formBlock = recentFormBlock(trades, options?.asOfMs, audience);
    const formChars = push(formBlock);
    if (formChars > 0) {
        // The fingerprint says WHICH brief this run saw, per audience. A trade
        // row carries its `sourceRunId`, so a decision can be traced back to the
        // exact context it was made in instead of the code that made it.
        injected.push({
            path: 'journal/recent-form',
            kind: 'similar',
            chars: formChars,
            fingerprint: briefFingerprint(formBlock),
        });
    }
    if (stage === 'verdict') {
        const similarChars = push(similarTradesBlock(query, trades, options?.asOfMs));
        if (similarChars > 0) injected.push({ path: 'journal/similar-trades', kind: 'similar', chars: similarChars });
        // Family × regime scoreboard: which strategy families the settled
        // record currently favors in THIS regime. Compact, capped, and only
        // when the matrix has evidence — the moderator sees nothing rather
        // than an empty table.
        const edgeChars = push(matrixSummaryBlock(typeof query?.regime === 'string' ? query.regime : undefined));
        if (edgeChars > 0) injected.push({ path: 'matrix/family-regime', kind: 'similar', chars: edgeChars });
    }

    const doctrine = doctrineBlock();
    // Settled beliefs ride in their own always-on slot ABOVE the doctrine —
    // permanent convictions the model reads before the revisable doctrine.
    // Like doctrine, they do not count against the stage budget.
    const beliefs = (() => {
        try { return settledBeliefsBlock(); } catch { return ''; }
    })();
    if (blocks.length === 0 && !doctrine && !beliefs) return '';
    if (beliefs) injected.unshift({ path: 'profile/settled-beliefs', kind: 'identity' });
    if (doctrine) injected.unshift({ path: 'profile/doctrine', kind: 'identity' });

    // Telemetry (fire-and-forget): record what was REALLY injected so skill
    // evidence, lift and the dashboard reflect injections, not setup matches.
    //
    // OPT IN, not opt out. A record grants a skill credit for the run, so it
    // may only be written for a block that was ACTUALLY SENT — and the
    // pipeline assembles this whole retrieval into a prompt it never sends.
    // The default is therefore FALSE, and a send site says `recordInjections:
    // true` (the bot's shared-memory context does) while a synthetic context
    // says nothing at all.
    if (injected.length > 0 && options?.recordInjections === true) {
        void (async () => {
            try {
                const { recordMemoryInjection } = await import('./MemoryInjectionService');
                const { getActiveUsername } = await import('../../utils/activeUser');
                await recordMemoryInjection(getActiveUsername(), {
                    stage,
                    audience,
                    coin: query?.coin,
                    sources: injected,
                    holdout: holdout || undefined,
                    runId: options?.runId,
                });
            } catch { /* telemetry must never break prompt assembly */ }
        })();
    }

    const parts: string[] = [];
    if (beliefs) parts.push(beliefs);
    if (doctrine) parts.push(doctrine);
    if (blocks.length > 0) parts.push(blocks.join('\n\n'));
    if (elidedChars > 0) {
        // Through `clipNote` rather than hand-written: it names how much was
        // KEPT as well as dropped, which is what lets `findClipIn` read this
        // back and the fence legend describe it. The old phrasing reported only
        // the loss, so the activity line could not say "clipped n/m".
        parts.push(clipNote({
            source: 'notebook memory',
            kept: used,
            total: used + elidedChars,
            guidance: 'treat the absence above as "not injected this stage", NOT as '
                + '"no lesson exists" — recall_notebook_memory can retrieve more',
        }));
    }

    return `═══════════════════════════════════════════════════════════════
📓 MY MEMORY (doctrine + what matches THIS setup — not a blank slate)
═══════════════════════════════════════════════════════════════
Do not contradict a confirmed rule without strong new evidence. Need more
history? Call the recall tool with this setup's coin/topic.
═══════════════════════════════════════════════════════════════
${dedupeContentLines(parts).join('\n\n---\n\n')}`;
};

// ─── recall tool (pull-over-push) ───────────────────────────────────────────

export interface RecallRequest {
    /** Free-text topic: usually the coin ("BTC"), optionally + direction/pattern. */
    topic: string;
}

/**
 * Handle a model-initiated `recall` desk-tool call: search the notebook the
 * way the retrieval layer does and hand back a compact digest — matched
 * skills (top 3, one-line each), matching NOTE files (the write_memory_note
 * surface), similar closed trades, uncovered mistakes, and the current
 * doctrine header. Budget-capped like every other slice.
 */
export function handleRecallTool(
    args: RecallRequest,
    trades?: LoggedTrade[],
): string {
    const raw = (args.topic || '').trim();
    if (!raw) return JSON.stringify({ error: 'recall requires a topic, e.g. {"topic": "BTC long"}' });

    // Parse "BTC long" / "ETH short sweep" style topics into a query.
    const words = raw.toLowerCase().split(/\s+/);
    const direction = words.includes('long') ? 'Long' : words.includes('short') ? 'Short' : undefined;
    const coin = words.find(w => w !== 'long' && w !== 'short' && w.length >= 2)?.toUpperCase();
    const query: MemoryRetrievalQuery = {
        coin,
        direction: direction as MemoryRetrievalQuery['direction'],
        family: undefined,
        pattern: undefined,
    };

    const sections: string[] = [];

    // A NOTE NAMED EXACTLY IS SERVED WHOLE. The topics index promises the note
    // and the only reader returned one 240-character line, so a seat told "read
    // the funding note" could never see the second paragraph
    // (the 2026-10-27 audit §4). A name the trader can see in the index is an address;
    // this is what makes it one. Bounded, and a cut says how much is missing.
    try {
        const key = raw.toLowerCase().replace(/\.md$/, '').replace(/[\s_-]+/g, ' ').trim();
        const note = getMemoryFiles().files.find(f => {
            if (f.enabled === false || isSkillFile(f)) return false;
            if (!f.content.trim()) return false;
            const name = f.name.toLowerCase().replace(/\.md$/, '').replace(/[\s_-]+/g, ' ').trim();
            return !!key && (name === key || (key.length >= 4 && (name.includes(key) || key.includes(name))));
        });
        if (note) {
            const body = note.content.trim();
            const budget = 4_000;
            const shown = body.length > budget
                ? `${body.slice(0, budget)}
${clipNote({
                    source: `notebook note "${note.name}"`,
                    kept: budget,
                    total: body.length,
                    guidance: 'ask for a narrower part of this note rather than assuming the rest',
                })}`
                : body;
            sections.push(`NOTE ${note.name}:
${shown}`);
        }
    } catch { /* a note lookup must never cost the recall */ }

    // Pull tier: #1 gets the full body; runners-up appear as one-line index
    // entries so the model knows they exist and can ask again specifically.
    const matches = rankedMatchedSkills(query).slice(0, 1 + VERDICT_EXTRA_SKILLS);
    matches.forEach((m, i) => {
        if (i === 0) {
            // Body, not the raw file — same frontmatter-budget rule as the
            // verdict slice; the model asked for the PROCEDURE, not the
            // bookkeeping YAML.
            const body = substituteSkillContext(skillBody(m.file.content), query);
            const slug = normalizeSkillSlug(m.file.name);
            // Projected, not sliced. `body.slice(0, 700)` cut in whatever order
            // the prose arrived, so a long skill could spend its whole budget on
            // the trigger and inputs and never show a step — and a seat could
            // not tell a short skill from a truncated one. A body that fits the
            // budget is served whole; only a larger one is re-ordered into
            // priority (rule, trigger, when-NOT, pitfall, verification, plan,
            // procedure), and the omission is marked in the app's one clipping
            // voice, with numbers.
            const card = projectSkillCard(body, {
                when: m.meta.when,
                budget: RECALL_SKILL_BODY_MAX,
            });
            const shown = card.clipped
                ? `${card.text}
${clipNote({
                    source: 'skill procedure',
                    kept: card.chars,
                    total: card.chars + card.droppedChars,
                    guidance: `the rest is in skills/${slug}.md — ask for it again if the `
                        + 'procedure above stops before a step you need',
                })}`
                : card.text;
            // The slug is in the header because the clip note tells the model to
            // ask for the rest by name — an instruction pointing at an address it
            // was never given is not actionable.
            sections.push(
                `SKILL ${slug} ${m.meta.status.toUpperCase()} (${Math.round(m.meta.wins)}W/${Math.round(m.meta.losses)}L · ${evidenceFreshness(m.meta)}):
${shown}`
            );
        } else {
            sections.push(`SKILL (also matches) ${skillIndexLine(m.file.name, m.meta)}`);
        }
    });

    const mistakes = uncoveredMistakeLine(query);
    if (mistakes) sections.push(mistakes.replace(/^\[[^\]]+\]\n/, ''));

    // The model's own NOTES (write_memory_note → lessons/, rules/, …): these
    // files have no SKILL frontmatter, so the skill tier above never sees
    // them — without this, a saved lesson is invisible to the very tool whose
    // description promises "lessons learned" (observed 2026-09-14).
    const notes = searchNotebookNotes(raw);
    if (notes.length > 0) {
        sections.push(notes.map(n => `NOTE ${n.path}:\n${n.excerpt}`).join('\n'));
    }

    const similar = similarTradesBlock(query, trades);
    if (similar) sections.push(similar);

    const doctrine = readDoctrineForInjection();
    if (doctrine) {
        const head = doctrine.split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
        sections.push(`DOCTRINE (my settled beliefs):\n${head}`);
    }

    if (sections.length === 0) {
        return JSON.stringify({ result: `No notebook memory found for "${raw}".` });
    }
    const digest = sections.join('\n\n');
    return JSON.stringify({
        result: digest.length > MAX_TOOL_CONTENT_RECALL ? `${digest.slice(0, MAX_TOOL_CONTENT_RECALL)}\n…` : digest,
    });
};
/** The recall digest ceiling: a named note may occupy its own 4k budget, so the
 *  result must have room for that whole body plus the ranked index rows below. */
const MAX_TOOL_CONTENT_RECALL = 6_000;
