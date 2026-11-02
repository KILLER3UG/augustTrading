/**
 * Evidence-gated skills in the trader notebook (skills/*.md).
 *
 * A skill is a procedure with a trigger and a win/loss score. The harness
 * creates one only after a cluster of similar closed trades; each new
 * WIN/LOSS updates the score; weak skills are retired. Analysts retrieve
 * matching skills — they do not get every skill dumped into the prompt.
 */

import { DiagnosisSkillEvidence, LoggedTrade, MemoryFile, TradeOutcome } from '../../types';
import {
    appendDiaryEntry,
    createMemoryFileUnlocked,
    createMemoryFolderUnlocked,
    ensureHarnessFolders,
    ensureHarnessFoldersUnlocked,
    ensureSkillsArchiveFolderUnlocked,
    extractLessonFromPostMortem,
    getMemoryFiles,
    slugifyName,
    syncRecurringMistakes,
    updateMemoryFileUnlocked,
    withNotebookWriteLock,
} from './MemoryFilesService';
import { getBots } from '../agents/agentRoster';
import { formatSkillProcedure, parseLessonClauses, skillHitRate } from '../../utils/lessonClause';
import { maybePinWinningPromptLane } from '../../utils/promptVersionStats';
import { CraftedSkill } from '../../schemas/learning';
import type { SkillIndexRow } from '../trade/tradeChatContext';
import { netRiskReward, stopDistancePercent } from '../../utils/netRiskReward';
import { parsePrice } from '../../utils/analysisUtils';
import { formatCraftedSkillBody, refineSkillFromLosses } from './SkillCraftService';
import { recordLearningRulesFromPostMortem } from './learningRules';
import { captureUnknownFrontmatter, declaredCompatibility, hasUseWhenTrigger, skillBodyCaps, skillRunsHere, type SkillRuntime } from '../../utils/skillFrontmatter';
import { applyOutcomeCorrection, type CorrectionOutcome } from '../../utils/skillLedgerCorrection';
import { DESK_TOOL_NAMES } from '../../utils/toolKinds';
import {
    recordWorthGateApproval,
    recordWorthGateConfirm,
    recordRefinementOutcome,
    recordEvalAgreement,
} from './metaCalibration';
import {
    recordTombstone,
    findArchiveTwin,
    queueRevivalProposal,
    retirementReasonFromHistory,
} from './skillGraveyard';
import { isStaleByRegime } from '../../utils/regimeSentinel';
import { validateTrigger, coveredByLiveSkill as coveredByLiveSkillWith, type CoverReader } from './skillClauseBar';
import { shouldSkillHoldout } from '../../utils/skillHoldout';
import { classifyStrategyFamily } from '../../utils/strategyFamily';
import {
    listSkillDrafts,
    shouldAttemptWorthGate,
    recordWorthGateAttempt,
    readWorthGateAttempt,
    clearWorthGateAttempt,
} from '../../utils/skillDrafts';
import { tradeAdmitsTechnicalStrategyRule } from '../../utils/rootCause';
import { tentativeDemotion } from '../tracking/diagnosisSkillCluster';
import { draftTriggerKey, isDraftTombstoned } from '../../utils/skillDrafts';
import { familiesRelate } from '../../utils/patternMatch';
import { recordMemoryInjection, skillAdherenceForRun } from './MemoryInjectionService';
import { sanitizePredicate } from '../analysis/skillPredicate';
import { resolveMemoryConfig } from './MemoryModelService';
import {
    parsePredictionLine,
    defaultPrediction,
    evaluateClaim,
    type SkillPrediction,
} from '../../utils/skillPrediction';
import { defaultDescription } from '../../utils/skillDescription';
import { ciGatePasses } from '../../utils/skillStatistics';
import { queueLearningProposal, type ProposalApplyResult } from '../../utils/learningQueue';
import { getSkillLibraryCap, getHarnessSettings } from '../../utils/harnessSettings';

export type SkillStatus = 'candidate' | 'confirmed' | 'retired';
export type SkillKind = 'repeat' | 'avoid';

/**
 * The version a skill file declares for ITSELF.
 *
 * The Agent Skills convention has no version key; Hermes/Claude skills often
 * carry one. A skill that can be re-authored, imported from another tool and
 * re-imported needs to say which revision of itself it is, or a reader cannot
 * tell "this file was rewritten" from "this file is an old revision of the
 * same skill". Absent on every file written before this key existed — and
 * absent means "no version claimed", never "version zero".
 */
export const SKILL_FILE_VERSION = '1';

/**
 * WHAT a skill NEEDS, as opposed to the `audience` / `lensScope` /
 * `manualOnly` family, which says WHO may see it.
 *
 * The portable face carries it as one JSON string (a JSON string is a valid
 * YAML 1.2 double-quoted scalar, so it stays a plain scalar like every other
 * key here — no nested YAML, no arrays, nothing a hand-edit can break).
 * Absent = no constraint: the retrieval treats a skill with no
 * `compatibility` exactly as it treated one before this field existed, which
 * is the only safe default — a constraint that silently appeared would
 * un-inject a working skill.
 */
export interface SkillCompatibility {
    /** Tool names the skill needs (e.g. 'run_screener'). */
    requiresTools?: string[];
    /** Tool names the skill COVERS: it is injected only while none of them is
     *  available, because it exists to do by procedure what the tool does by
     *  call. Once the tool is here the procedure stops being needed. */
    fallbackForTools?: string[];
    /** Toolset names the skill covers. Tolerated and inert until August names
     *  toolsets — `skillRunsHere` never guesses at a set it cannot resolve. */
    fallbackForToolsets?: string[];
    /** Environment variable names the skill needs. */
    requiresEnv?: string[];
    /** Platforms the skill supports (e.g. 'web', 'native'). */
    platforms?: string[];
}

export interface SkillMeta {
    status: SkillStatus;
    kind: SkillKind;
    /** The spec's required identifier, as the file declares it (lowercase,
     *  digits, hyphens, ≤64). August's own writer derives it from the title at
     *  serialization time; an IMPORTED skill keeps the name it arrived with so
     *  an export round-trips. */
    name?: string;
    /** One-sentence semantic summary (zcode memory pattern): what this skill
     *  claims, in prose. Generated at creation from the worth-gate rationale
     *  (the trigger sentence), consumed by index lines, the recall tool, the
     *  grid subtitle and LLM judges. Absent on legacy skills. */
    description?: string;
    /** The revision of THIS skill the file declares (see `SKILL_FILE_VERSION`).
     *  Portable: it travels with the skill when it is shared or imported. */
    version?: string;
    /** Provenance: id of the LOGGED TRADE whose closed-out cluster produced
     *  this skill — the deep-link back to "where did this belief come from".
     *  (Trades carry no link to their originating ensemble message, so the
     *  trade id is the deepest provenance available.) */
    originMessageId?: string;
    /** Set when this coin-scoped skill was absorbed into a coin-less
     *  generalized skill (skillGeneralization). Points at the generalized
     *  skill's file slug. A superseded skill is retired from matching but its
     *  evidence stays queryable — it is the control group for the generalized
     *  belief. */
    supersededBy?: string;
    coin?: string;
    direction?: string;
    family?: string;
    regime?: string;
    wins: number;
    losses: number;
    /** Expectancy in R, summed ONLY from trades whose realized R was measured
     *  from price levels (`trade.realizedR`). Absent means unmeasured, which is
     *  NOT break-even — so a zero here must never be read as a score. Missing R
     *  is never filled with a +/-1 stand-in: that collapses this counter into
     *  `wins - losses` and reimports the binary grading expectancy exists to
     *  replace.
     *
     *  NET of the modelled round-trip cost (`utils/netRiskReward.ts`) wherever
     *  that cost was computable. The cost is charged on a LOSS too — you paid
     *  the fees and got stopped — so a −1 R loss at a 0.10 R cost is −1.10,
     *  not −1.00. Where the cost could NOT be computed (no stop distance on
     *  the trade) the outcome contributes its GROSS R, so the sum sits BETWEEN
     *  the true net and the gross: it OVERSTATES the net, because a cost that
     *  was never charged never subtracted. `netRKnown: false` is what says so,
     *  so a gross number is never read under a net label. A missing cost is
     *  NEVER stored as a zero cost. */
    netR?: number;
    /** The GROSS sum of the same measured outcomes, before any cost. Kept
     *  beside `netR` because the two answer different questions and the gross
     *  one is the one a reader wants when they ask "what did the market do"
     *  rather than "what did the skill keep".
     *
     *  Absent on every file written before this key existed — and absent
     *  means "the gross was never separated", never "the gross is zero". */
    grossR?: number;
    /** Whether `netR` is a true NET sum: true only when EVERY counted
     *  outcome had a computable round-trip cost. False means `netR` is NOT a
     *  net figure — it is the sum with each uncosted outcome contributing its
     *  GROSS R — and `netRUnknown` says why. Undefined means the file predates
     *  the cost model (and is read as a gross figure, never as a net). */
    netRKnown?: boolean;
    /** Why the net could not be computed (e.g. 'stop-distance'). Absent when
     *  `netRKnown` is true. */
    netRUnknown?: string;
    /** How many counted outcomes fed `netR`. Gates every expectancy read. */
    rSampled?: number;
    /** Running count of consecutive LOSS outcomes (reset by any WIN). A
     *  confirmed skill that reaches REFINE_AFTER_CONSECUTIVE_LOSSES gets an
     *  LLM refinement pass instead of silently bleeding. */
    consecutiveLosses: number;
    tradeIds: string[];
    /** Consecutive runs of the SAME eval verdict (helps/hurts). A 'hurts'
     *  demotion requires a streak >= 2 — one noisy A/B run must not bench a
     *  confirmed skill (sequential-evidence gating). Absent ⇒ legacy behavior
     *  (treated as confirmed). */
    evalStreak?: number;
    /** Matched-but-NOT-injected closed-trade ids (tail-capped at
     *  CONTROL_ID_TAIL). These are the CONTROL group for attribution:
     *  setups the skill could have influenced but provably didn't (no
     *  injection record in the window). They never enter wins/losses. */
    controlIds?: string[];
    /** Aggregate outcomes of that CONTROL group, counted beside wins/losses
     *  but never mixed into them. `controlIds` is a tail kept for PROVENANCE;
     *  these two are the SAMPLE the confirmation CI gate compares against —
     *  without them the control rate could only be re-derived from a trade
     *  log that prunes, which is how a control group quietly shrank to one
     *  trade and every comparison with it became meaningless. Deliberately
     *  UNcapped and monotonic: a count that stops growing stops being
     *  evidence. Absent on skills written before this existed — those fall
     *  back to recounting the ids they still carry. */
    controlWins?: number;
    controlLosses?: number;
    /** Counted trade ids whose market regime DIFFERED from the skill's scope
     *  regime (tail-capped). applyEvidenceDecay already discounts these counts;
     *  this list just makes the discount VISIBLE — the dashboard can show "this
     *  belief was applied to a non-scope regime N times" so a skill that only
     *  "works" outside its stated regime is caught. */
    crossRegimeIds?: string[];
    /** ── three-state adherence join ──
     *  Matched + injected + CITED by the verdict → counted in wins/losses
     *  (FOLLOWED). Matched + injected + NOT cited → this list (OVERRIDDEN):
     *  the moderator was handed the skill and ignored it, so the outcome
     *  belongs to neither the skill nor the control group. A high override
     *  rate is itself a signal — the amendment queue consumes it. */
    overriddenIds?: string[];
    /** ── per-regime evidence splits ──
     *  wins/losses accumulated inside each regime, written alongside the
     *  global counters. When the split diverges (works in one regime, fails
     *  in another) the skill is CONDITIONAL, not fading — re-scope instead
     *  of decay. */
    regimeStats?: Record<string, { w: number; l: number }>;
    /** ── birth certificate ──
     *  The falsifiable claim registered at creation. The eval scheduler
     *  tests the skill against THIS instead of a generic hurts/helps
     *  question; the ladder consumes the claim verdict. */
    prediction?: SkillPrediction;
    /** Followed-evidence sample size at the last claim test — the
     *  claim is re-tested only when new evidence has landed since. */
    claimTestedEvidence?: number;
    /** ── shadow refinement ──
     *  A refined version drafted after a loss streak does NOT swap into the
     *  live slot immediately — it waits here (eval-only) while the prior
     *  version keeps injecting for SHADOW_WINDOW_TRADES matched trades.
     *  The comparison then promotes whichever wins. */
    shadow?: {
        kind: SkillKind;
        when?: string;
        body: string;
        name?: string;
        startedAt: string;
        /** Matched trades observed since the shadow opened. */
        seen: number;
        wins: number;
        losses: number;
    };
    /** Total trades EVER counted for this skill. `tradeIds` is a
     *  tail-20 list; without this counter the verdict block's "learned from
     *  N logged trade(s)" understates long-lived skills forever. Maintained
     *  by countTradeOutcome on every path that moves wins/losses — it is a
     *  real running total, not a capped display artifact (promotion math
     *  never reads it; the provenance line and generalization sum do). */
    evidenceCount?: number;
    /** The cluster that CREATED this skill, kept out of the promotion maths.
     *
     *  A skill's trigger is authored from the post-mortems of the trades that
     *  spawned it, so those trades are the source of the claim, not a test of
     *  it. Counting them as evidence let eight co-occurring wins mint a skill
     *  already `confirmed` — clearing the zero-sample CI gate and satisfying
     *  the skill's own birth certificate with the same co-occurrence.
     *
     *  Promotion and the CI gate read only the FOLLOWED remainder
     *  (`wins + losses - clusterSize`), so a skill earns `confirmed` from
     *  outcomes observed after it was injected, not before. Absent on every
     *  skill that was not born from a cluster. */
    birthEvidence?: { wins: number; losses: number; clusterSize: number; at: string };
    /** The skill's one trigger sentence. Legacy files carried `ifCondition`
     *  + `thenAction` frontmatter; the parser maps `ifCondition` into this
     *  field and the old keys survive as unknown frontmatter. */
    when?: string;
    /** Optional machine-checkable trigger, evaluated against the tape by
     *  services/analysis/skillPredicate. Prose can be read loosely; a predicate
     *  either fires on the current bar or it does not. Absent means the skill
     *  is matched on its prose alone — the common case, and always the safe
     *  one, because a predicate that fails to parse is never read as a match. */
    predicate?: string;
    /** ── strategy-template fields (Kakushadze & Serur, "151 Trading
     *  Strategies") ──
     *  The book describes every strategy against one template: data,
     *  universe, signals, portfolio construction, execution, risk
     *  management. These fields pull that shape into the skill schema so a
     *  mined skill, an imported skill and a book-extracted strategy share
     *  one comparable structure. All optional — legacy files parse
     *  unchanged. */
    /** Controlled family vocabulary (types/strategy) this skill trades. */
    strategyFamily?: string;
    /** Exact entry conditions (price/indicator/candle triggers). */
    signals?: string;
    /** What kills the setup — stop style + invalidation level logic. */
    invalidation?: string;
    /** Intended holding horizon. */
    horizon?: 'scalp' | 'intraday' | 'swing' | 'position';
    /** Position sizing / risk guidance the strategy carries, if any. */
    sizing?: string;
    /** Provenance marker for skills that carry evidence the *counters* don't
     *  show, and are therefore exempt from the zero-evidence injection ban:
     *  - 'book': the procedure comes from external literature (seed corpus),
     *    not this trader's record — labeled as a prior so the model weighs it.
     *  - 'gated': a drafted skill that cleared the evidence-backed draft gate
     *    and the worth gate, then was approved (by the supervisor or the
     *    human). Its W/L record is empty only because nothing unproven is
     *    ever counted — injection is how it earns its first sample. Without
     *    this the loop deadlocks: no injection ⇒ no evidence ⇒ no injection. */
    prior?: 'book' | 'gated';
    /** ── alpha-decay window ──
     *  The last N counted outcomes as a 'W'/'L' string (oldest first,
     *  tail-capped at RECENT_WINDOW). Lifetime counters hide DECAY — a
     *  skill that was great for six months and mediocre lately keeps its
     *  confirmed badge on cumulative stats alone. deriveStatus demotes on
     *  a decayed recent window; the lifetime record still protects it from
     *  retirement. */
    recentOutcomes?: string;
    body: string;
    /** ISO timestamp of the last LLM refinement pass, if any. */
    refinedAt?: string;
    /** ISO timestamp of the most recent counted trade (evidence decay input). */
    lastEvidenceAt?: string;
    /** ISO timestamp of the most recent setup match, injected or not. Kept
     *  apart from `lastEvidenceAt` on purpose: a suspended skill is no longer
     *  injected, so `lastEvidenceAt` can never advance again, and an idle
     *  clock that only counted injections would make suspension one-way.
     *  See `services/learning/skillIdleLifecycle.ts`. */
    lastMatchedAt?: string;
    /** ISO timestamp of the last content write — freshness signal for readers. */
    modifiedAt?: string;
    /** Set when the idle sweep suspended a skill (dropped it from prompt
     *  injection without retiring it). Cleared on revival. `enabled` alone
     *  cannot carry this — a user-retired skill is also disabled — and the
     *  archive stage has to tell the two apart. */
    suspendedAt?: string;
    /** The trader turned this skill OFF in the notebook. `enabled` on the
     *  notebook file is DERIVED from status + suspendedAt by skillEnabledFlag,
     *  so a hand-off had no meta counterpart and the next attribution write
     *  recomputed it to true — silently re-injecting a vetoed skill within
     *  days. This is the meta half of that intent. */
    disabledByUser?: boolean;
    /** Human-invoked ONLY — Claude's `disable-model-invocation` port.
     *  When true the skill NEVER auto-injects into a seat's prompt no matter
     *  how well it matches; it is served only when the trader names it with
     *  `/slug` in the composer. Distinct from `disabledByUser` (off entirely)
     *  and from `audience` (which seat may see it): this one is background
     *  knowledge the model may read on demand but must not be handed.
     *
     *  Absent = false, so every skill written before this field injects
     *  exactly as before — the gate fails OPEN for legacy rows on purpose,
     *  because a missing fact must never silently change what a live skill
     *  does. A new opt-out is one explicit line. */
    manualOnly?: boolean;
    /** Timeframe the skill was proven/drafted on (e.g. '15m', '4h'). Optional
     *  so legacy and chat-authored skills stay valid; the chart scan stamps it
     *  so a reader knows which tape a pattern was earned on. */
    timeframe?: string;
    /** Which learner minted this skill (provenance line on the card): 'scan'
     *  (chart-history scan), 'post-mortem', 'book', 'chat', etc. */
    source?: string;
    /** Why an approver accepted this draft, in their words — the supervisor's
     *  verdict reason, or the human's Save click. The supervision event log is
     *  session-scoped, so without this the audit trail for an auto-approved
     *  skill evaporates on reload. One line, capped. */
    whyAccepted?: string;
    /** Evidence from the session that motivated the rule, in the proposer's
     *  words. `propose_skill` requires it; this is where it lands so the human
     *  approving the draft (and the next reader of the file) can see WHY the
     *  rule exists. Distinct from `whyAccepted`, which is the approver's
     *  verdict. One line, capped. */
    reason?: string;
    /** Who said yes to this rule — THE approval fact the gate reads.
     *
     * `'supervisor'` is deliberately NOT approval: the model supervising its own
     * queue is a triage action, and the trader's standing rule is that nothing
     * model-generated becomes active, gets veto weight, or is retired without their
     * yes. It stays in the union because the audit trail must still show which rows
     * the model landed on its own (WS-2.3's "the user can still delete").
     *
     *  - `'human'`            — a person approved it in the app.
     *  - `'grandfathered'`    — existed before the gate; stamped by the one-time
     *    migration so the library does not go silent on day one. Marks, never
     *    rewrites: any later change to the trigger clears it (see `revokeApproval`).
     *  - `'starter-library'`  — not stored. A `prior: 'book'` row is approved while
     *    the explicit Settings toggle is on; it is vetted literature, not model
     *    output, and the toggle is the single thing that says so. */
    approvedBy?: 'supervisor' | 'human' | 'grandfathered' | 'tentative';
    /** Why a tentative skill stopped injecting (auto-demotion). One line,
     *  written beside `suspendedAt`; the skill stays readable and editable. */
    demotion?: string;
    /** ISO stamp beside `approvedBy` — "approved on", so a reviewer can see how old
     *  the yes is. Set by the same writers; cleared with it. */
    approvedAt?: string;
    /** ── WS-3.3 provenance ── the agent bot whose learning created this skill.
     *  Retrieval and the skills table label it so a reader knows whether a
     *  rule came from the chart AI or from a bot's own thread. The name is
     *  stored next to the id on purpose: resolving it would mean a roster read
     *  on the prompt-assembly path, and a deleted bot must not turn into a
     *  broken label. */
    originBotId?: string;
    originBotName?: string;
    /** Invocation control (Agent Skills frontmatter port): which audience may
     *  load this skill. Default 'all'. The moderator audience no longer runs,
     *  so 'moderator' survives only on legacy files. */
    audience?: 'analyst' | 'moderator' | 'all';
    /** WHAT this skill needs — the other half of the invocation-control
     *  family. `audience` / `lensScope` / `manualOnly` say WHO may see it;
     *  this says what the seat must HAVE for the skill to be usable at all
     *  (a tool it does not expose, an env var that is not set, a platform it
     *  does not run on). Portable: it travels with the skill.
     *
     *  Absent = no constraint, which is exactly how every skill behaved
     *  before this key existed. A constraint must never appear by accident:
     *  a skill that silently stopped being injected would look like a dead
     *  belief, and nothing in the app would say why. */
    compatibility?: SkillCompatibility;
    /** Latest automated A/B verdict (SkillEvalService). 'hurts' demotes a
     *  confirmed skill back to candidate on the next evidence pass. */
    evalVerdict?: 'helps' | 'mixed' | 'hurts' | 'inconclusive';
    /** Aligned/total flips from the latest eval, e.g. "2/3". */
    evalDetail?: string;
    /** ISO timestamp of the last automated eval run. */
    lastEvalAt?: string;
    /** Trigger/action snapshot taken BEFORE the last refinement — the
     *  evidence diff shown in the notebook so a rewrite is auditable. */
    /** The version a non-human rewrite replaced, kept so the trader can REVERT it
     *  with the approval that came before — not just roll the text back and leave
     *  the row silently inactive. `body` and the approval fields ride along for
     *  exactly that reason. */
    previousVersion?: {
        kind: SkillKind;
        when?: string;
        body?: string;
        /** The EXECUTABLE half of the version being replaced. Without these a
         *  revert restored old prose under the newer trigger logic — the row read
         *  as the old rule while `skillPredicateGate` still evaluated the new
         *  predicate (the 2026-10-27 audit S-2). */
        predicate?: string;
        /** The retrieval activation key at that version. */
        description?: string;
        approvedBy?: SkillMeta['approvedBy'];
        approvedAt?: string;
    };
    /** Temporal ledger: every status transition is
     *  stamped validFrom → (invalidAt | null). Superseded beliefs are never
     *  deleted — retirement/demotion closes the interval, so replay audits
     *  can reconstruct exactly what was believed at any past moment. */
    history?: Array<{
        status: SkillStatus;
        validFrom: string;
        invalidAt?: string;
        reason?: string;
    }>;
    /** Raw lines of every frontmatter key the app has no semantics for,
     *  captured VERBATIM at parse and re-emitted verbatim at serialization —
     *  `author`, `license`, `metadata.hermes.*`, `platforms`, and anything a
     *  third-party author put there. A rewrite that eats a key the importer's
     *  author wrote is data loss the next round-trip turns into a diff the
     *  user cannot explain. */
    unknownFrontmatter?: string[];
}

/**
 * Evidence floors, raised BEFORE the automatic outcome loop starts feeding
 * them (E-37). The old floors were tuned for a world with no outcomes: a
 * three-trade cluster could mint a skill and a five-trade sample could
 * confirm one. The promotion rate is expected to fall; that is the point —
 * a confident rule built on three trades is noise with a name.
 */
export const MIN_CLUSTER_FOR_SKILL = 10;
export const MIN_SAMPLE_CONFIRMED = 20;
export const MIN_SAMPLE_RETIRE = 6;
/** Counted outcomes kept in the alpha-decay window (`recentOutcomes`). */
export const RECENT_WINDOW = 12;
/** Minimum windowed outcomes before decay demotion can fire. */
export const DECAY_MIN_SAMPLES = 8;
/** A confirmed skill whose recent window win-rate falls below this (repeat;
 *  mirrored above for avoid) is DEMOTED to candidate — decayed, not dead.
 *  Lifetime stats still guard retirement. */
export const DECAY_RECENT_WINRATE = 0.35;
/**
 * Control-group trade ids kept in the frontmatter tail. The ids are
 * provenance — "which setups did this skill NOT shape" — and the aggregate
 * `controlWins`/`controlLosses` are the sample the CI gate grades against, so
 * capping the ids does NOT cap the evidence: the counters are uncapped and
 * monotonic. The tail exists only to keep the markdown line readable and
 * parseable, at the same 20 the sibling `overriddenIds`/`crossRegimeIds`
 * tails use.
 */
export const CONTROL_ID_TAIL = 20;
/**
 * Counted trades a CANDIDATE avoid skill needs before code-side enforcement
 * may size a trade down. Prompt injection already excludes zero-evidence
 * skills; enforcement must not reach further than the model can see, or a
 * freshly-spawned candidate with no record caps confidence on a single match.
 *
 * Raised 2 → 10 with E-37: two trades are not a sample, and this gate can
 * zero a real setup. Do not lower it to make a fixture pass.
 */
export const MIN_SAMPLE_FOR_VETO = 10;
/** Consecutive losses on a CONFIRMED skill before the LLM refinement pass. */
export const REFINE_AFTER_CONSECUTIVE_LOSSES = 3;
/**
 * Matched trades the PRIOR version keeps the live injection slot for
 * while a refinement sits in eval-only shadow. A panicked rewrite after a
 * bad-luck streak used to swap in immediately — undetectably replacing a
 * good skill with a worse one. The window is the detection mechanism.
 */
export const SHADOW_WINDOW_TRADES = 10;
/**
 * Refinement also requires the losses to span at least this many hours —
 * three whipsaw losses inside one session is regime noise, not a broken rule
 * (rewrite loops must lag the evidence that triggers them).
 */
export const REFINE_MIN_SPAN_HOURS = 48;

const folderName = (folderId: string): string =>
    getMemoryFiles().folders.find(f => f.id === folderId)?.name ?? '';

/**
 * The Agent Skills convention's file name for the skill in a skill DIRECTORY.
 *
 * August's notebook is FLAT (folders of `.md` entries, no tree), so a
 * spec-shaped skill cannot live in a directory of its own — but the CONVENTION
 * file name is still the one a trader will drop in, and the CONTENT parser
 * already understands a spec-only file (`name` + `description` frontmatter).
 * So the name is recognised explicitly rather than by accident.
 */
export const SPEC_SKILL_FILE_NAME = 'SKILL.md';

/**
 * A file in the skills folder IS a skill file.
 *
 * The extension test is case-INSENSITIVE: the convention's name is upper
 * case (`SKILL.md`) and a hand-edited or tool-written file can carry an upper
 * case extension (`NOTES.MD`). A file that is rejected here is invisible to
 * every list, every retrieval and the Health card — the one surface where
 * being wrong is unrecoverable, because the trader is never told.
 */
export const isSkillFile = (file: MemoryFile): boolean =>
    folderName(file.folderId) === 'skills' && /\.md$/i.test(file.name);

export const listSkillSlugs = (): string[] =>
    getMemoryFiles().files.filter(isSkillFile).map(f => f.name.replace(/\.md$/i, ''));

/**
 * The one marker that splits a skill file into its two faces.
 *
 * The Agent Skills spec's required frontmatter is exactly `name` +
 * `description`, and it has NO lifecycle or outcome fields at all. August's
 * SkillMeta carries ~35 of them. Keeping both in one undivided block is why
 * a skill file cannot be shared, imported, or read as a procedure — it is a
 * database row wearing markdown.
 *
 * So the file is written as two explicit sections behind this marker: a
 * PORTABLE face above it (spec-shaped: name, description, and the keys that
 * describe the procedure's behaviour — kind/coin/direction/family/regime/
 * when/predicate/timeframe/source/audience), and
 * a LEDGER face below it (every outcome and lifecycle key). The parser reads
 * straight through the marker, so NOTHING is rewritten and no migration is
 * needed: existing files parse exactly as before, and a spec-only file with
 * just the two required fields loads as an unproven candidate.
 *
 * `name` is derived from the title at write time, never parsed — a title can
 * be renamed without the identity key drifting.
 */
export const LEDGER_MARKER = '# august:skill-ledger';

/** JSON strings are also valid YAML 1.2 double-quoted scalars. This keeps
 * arbitrary titles, descriptions, timestamps, and prose safe when they
 * contain colons, quotes, or YAML-reserved words. */
const yamlString = (value: string): string => JSON.stringify(value);

const decodeFrontmatterScalar = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (typeof parsed === 'string') return parsed;
        } catch { /* Keep legacy or hand-edited values readable below. */ }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
};

/** Instruction body of a skill file — the markdown minus its frontmatter AND
 *  its `# Title` line. The title is identity, carried in the `name` key; a
 *  body that repeats it makes every injected procedure start with a heading
 *  the seat already saw in the skill's own header line. */
export const skillBody = (content: string): string => {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return content.trim();
    const nameLine = match[1].match(/^name:[ \t]*(.+)$/mi)?.[1];
    const name = decodeFrontmatterScalar(nameLine);
    let body = (match[2] || '').trim();
    // Only remove the generated identity heading when it is the first body
    // line and matches the portable name. Imported skill section headings,
    // including a leading H1, are real instructions and must survive.
    if (name) {
        const firstLine = body.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
        if (firstLine && firstLine.toLocaleLowerCase() === name.toLocaleLowerCase()) {
            body = body.replace(/^#\s+.*(?:\r?\n|$)/, '').trim();
        }
    }
    return body;
};

// ─── Invoked skills (/slug → system section) ────────────────────────────────
// The composer parses `/slug` out of the message, but a name alone is dead
// weight: "apply skill X" teaches the seats nothing unless the CONTENT of
// skill X rides the run. The resolution + formatting below turns invoked
// slugs into a system-section block (OpenBot's skills-as-system-turn shape,
// adapted to the instructions lane every seat already receives).

export interface InvokedSkillRow {
    slug: string;
    found: boolean;
    kind?: SkillKind;
    status?: SkillStatus;
    body?: string;
}

/** Resolve invoked slugs against the notebook, case-insensitively. Slugs
 *  that match no skill file come back as `found: false` rows so the
 *  formatted section can say so instead of silently dropping them. */
export const resolveInvokedSkills = (slugs: string[]): InvokedSkillRow[] => {
    const files = getMemoryFiles().files.filter(isSkillFile);
    return slugs.map(slug => {
        const hit = files.find(f => f.name.replace(/\.md$/i, '').toLowerCase() === slug.toLowerCase());
        if (!hit) return { slug, found: false };
        const meta = parseSkillMarkdown(hit.content);
        return {
            slug,
            found: true,
            kind: meta?.kind,
            status: meta?.status,
            body: skillBody(hit.content),
        };
    });
};

/** System-section text for the skills the trader invoked with `/slug`.
 *  Empty string when nothing was invoked (falsy slots drop out of the
 *  instructions join). Pure — feed it `resolveInvokedSkills` output. */
export const formatInvokedSkillSection = (rows: InvokedSkillRow[]): string => {
    if (rows.length === 0) return '';
    const blocks = rows.map(row => {
        if (!row.found) {
            return `### ${row.slug} — not found\n(No notebook skill named "${row.slug}" exists. Continue without it; mention it is missing only if it changes the read.)`;
        }
        const label = [row.kind ? `${row.kind} skill` : undefined, row.status].filter(Boolean).join(' · ');
        return `### ${row.slug}${label ? ` — ${label}` : ''}\n${row.body?.trim() || '(empty skill body)'}`;
    });
    return [
        '## Invoked notebook skills',
        'The trader explicitly invoked these notebook skills for THIS run. They are hard constraints on the read — apply them and say where they bit.',
        blocks.join('\n\n'),
    ].join('\n\n');
};

/**
 * CYCLE HYGIENE (v1.0.20 TDZ class, second half): skillGraveyard imports this
 * module's `parseSkillMarkdown` while this module statically imports the
 * graveyard (recordTombstone/findArchiveTwin/…). The graveyard resolves the
 * binding through the module namespace AT CALL TIME; this side must also be a
 * HOISTED `function` declaration, not a `const` arrow — a const-arrow is
 * hoisted-but-uninitialized (TDZ) during cyclic evaluation, so an
 * evaluation-order flip (dev vs Rollup chunking) could dereference it before
 * its declaration runs.
 */
export function parseSkillMarkdown(content: string): SkillMeta | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;
    const fm = match[1];
    const body = (match[2] || '').trim();
    const pick = (key: string): string | undefined => {
        // `[ \t]*`, NOT `\s*`: \s matches newlines, so an EMPTY value
        // (`tradeIds: ` with no ids) let the separator swallow the line
        // break and `(.+)` then captured the NEXT field. A zero-evidence
        // skill born by ingestLessonFromTrade parsed its tradeIds as
        // ['evidenceCount: 0'] and then deduped its first real evidence
        // pass against a phantom id. Horizontal-only keeps the match on
        // its own line.
        const line = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'mi'));
        const v = decodeFrontmatterScalar(line?.[1]);
        return v && v !== 'undefined' && v !== '' ? v : undefined;
    };
    const num = (key: string): number => {
        // parseFloat, not parseInt: weighted attribution stores
        // half-credit counts like `wins: 0.5` — truncating them back to
        // integers silently erased matched-but-not-injected evidence.
        const n = parseFloat(pick(key) || '0');
        return Number.isFinite(n) ? n : 0;
    };
    const statusRaw = (pick('status') || 'candidate').toLowerCase();
    const status: SkillStatus = statusRaw === 'confirmed' || statusRaw === 'retired' ? statusRaw : 'candidate';
    const kind: SkillKind = (pick('kind') || '').toLowerCase() === 'repeat' ? 'repeat' : 'avoid';
    const tradeIds = (pick('tradeIds') || '').split(',').map(s => s.trim()).filter(Boolean);
    let previousVersion: SkillMeta['previousVersion'];
    const prevRaw = pick('previousVersion');
    if (prevRaw) {
        try {
            const parsed = JSON.parse(prevRaw) as { kind?: string; when?: string; ifCondition?: string; body?: string; predicate?: string; description?: string; approvedBy?: string; approvedAt?: string };
            previousVersion = {
                kind: parsed.kind === 'repeat' ? 'repeat' : 'avoid',
                // `ifCondition` is the pre-2026-10-30 spelling of the trigger;
                // read it so a rewrite drafted before the migration can still be
                // reverted. The old `thenAction` lives on in the body.
                when: typeof parsed.when === 'string' ? parsed.when
                    : typeof parsed.ifCondition === 'string' ? parsed.ifCondition : undefined,
                ...(typeof parsed.predicate === 'string' ? { predicate: parsed.predicate } : {}),
                ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
                body: typeof parsed.body === 'string' ? parsed.body : undefined,
                approvedBy: parsed.approvedBy === 'human' || parsed.approvedBy === 'grandfathered'
                    || parsed.approvedBy === 'supervisor' || parsed.approvedBy === 'tentative'
                    ? parsed.approvedBy : undefined,
                approvedAt: typeof parsed.approvedAt === 'string' ? parsed.approvedAt : undefined,
            };
        } catch {
            previousVersion = undefined;
        }
    }
    return {
        status,
        kind,
        // The spec's identifier, as the FILE declares it. August's own writer
        // derives name from the title at serialization; keeping the declared
        // one here is what makes an imported skill round-trip. Face issues
        // (bad casing, too long, missing) are NOT a parse failure — the file
        // still loads; the importer decides whether to reject on them.
        name: pick('name'),
        unknownFrontmatter: captureUnknownFrontmatter(fm),
        version: pick('version'),
        compatibility: (() => {
            // Two vocabularies state the same constraint: August's own
            // `compatibility:` blob, and the SKILL.md keys an imported file
            // arrives with (`requires_tools`, `platforms`, flat or under
            // `metadata: hermes:`). The blob wins a key it declares — it is the
            // shape this app writes and the one the desk's own tooling updates —
            // and the declaration fills the keys the blob leaves silent, so an
            // imported skill is never carrying a constraint nobody enforces.
            const fromBlob = (): Partial<SkillCompatibility> => {
                const raw = pick('compatibility');
                if (!raw) return {};
                try {
                    const parsed: unknown = JSON.parse(raw);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
                    const shape = parsed as Record<string, unknown>;
                    const list = (key: string): string[] | undefined => {
                        const value = shape[key];
                        if (!Array.isArray(value)) return undefined;
                        const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
                        return items.length ? items : undefined;
                    };
                    return {
                        ...(list('requiresTools') ? { requiresTools: list('requiresTools') } : {}),
                        ...(list('fallbackForTools') ? { fallbackForTools: list('fallbackForTools') } : {}),
                        ...(list('fallbackForToolsets') ? { fallbackForToolsets: list('fallbackForToolsets') } : {}),
                        ...(list('requiresEnv') ? { requiresEnv: list('requiresEnv') } : {}),
                        ...(list('platforms') ? { platforms: list('platforms') } : {}),
                    };
                } catch {
                    // A hand-edited or corrupt value must not poison the file.
                    return {};
                }
            };
            const blob = fromBlob();
            const declared = declaredCompatibility(fm);
            const compat: SkillCompatibility = {
                ...(blob.requiresTools ? { requiresTools: blob.requiresTools } : {}),
                ...(!blob.requiresTools && declared.requiresTools?.length ? { requiresTools: declared.requiresTools } : {}),
                ...(blob.fallbackForTools ? { fallbackForTools: blob.fallbackForTools } : {}),
                ...(!blob.fallbackForTools && declared.fallbackForTools?.length ? { fallbackForTools: declared.fallbackForTools } : {}),
                ...(blob.fallbackForToolsets ? { fallbackForToolsets: blob.fallbackForToolsets } : {}),
                ...(!blob.fallbackForToolsets && declared.fallbackForToolsets?.length ? { fallbackForToolsets: declared.fallbackForToolsets } : {}),
                ...(blob.requiresEnv ? { requiresEnv: blob.requiresEnv } : {}),
                ...(blob.platforms ? { platforms: blob.platforms } : {}),
                ...(!blob.platforms && declared.platforms?.length ? { platforms: declared.platforms } : {}),
            };
            // An empty object means "no constraint" — which is what an
            // absent key means, so it is stored as absent.
            return Object.keys(compat).length ? compat : undefined;
        })(),
        coin: pick('coin'),
        timeframe: pick('timeframe'),
        source: pick('source'),
        whyAccepted: pick('whyAccepted')?.slice(0, 400),
        reason: pick('reason')?.slice(0, 600),
        approvedBy: pick('approvedBy') === 'supervisor'
            ? 'supervisor' : pick('approvedBy') === 'human'
                ? 'human' : pick('approvedBy') === 'grandfathered'
                    ? 'grandfathered' : pick('approvedBy') === 'tentative' ? 'tentative' : undefined,
        approvedAt: pick('approvedAt') || undefined,
        demotion: pick('demotion')?.slice(0, 400),
        originBotId: pick('originBotId')?.slice(0, 40),
        originBotName: pick('originBotName')?.slice(0, 40),
        direction: pick('direction'),
        family: pick('family'),
        regime: pick('regime'),
        wins: num('wins'),
        losses: num('losses'),
        // ── the R ledger: gross, net, and whether the net is a true net ──
        // `grossR` is the key that says which face of the ledger a file is
        // on. A file that carries it was written by a version that separates
        // the two; a file that carries ONLY `netR` predates the cost model,
        // and its `netR` IS the gross — so it is read as the gross and
        // flagged, never quietly relabelled as a net.
        ...(() => {
            const netRaw = parseFloat(pick('netR') || '');
            const net = Number.isFinite(netRaw) ? netRaw : undefined;
            const grossRaw = parseFloat(pick('grossR') || '');
            const gross = Number.isFinite(grossRaw) ? grossRaw : undefined;
            if (net === undefined) {
                return { netR: undefined, grossR: gross, netRKnown: undefined, netRUnknown: undefined };
            }
            if (gross === undefined) {
                // LEGACY: the stored `netR` is the gross. Keep the number
                // where every reader expects it, and name it honestly.
                return {
                    netR: net,
                    grossR: net,
                    netRKnown: false,
                    netRUnknown: pick('netRUnknown') || 'legacy-gross',
                };
            }
            const known = pick('netRKnown');
            return {
                netR: net,
                grossR: gross,
                netRKnown: known === 'true' ? true : false,
                netRUnknown: pick('netRUnknown') || undefined,
            };
        })(),
        rSampled: (() => {
            const raw = parseInt(pick('rSampled') || '', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : undefined;
        })(),
        consecutiveLosses: num('consecutiveLosses'),
        tradeIds,
        // Total counted evidence. Falls back to the parsed tradeIds
        // length for pre-existing skills (never larger than the real count —
        // the tail list is an upper bound only until the next write).
        evidenceCount: (() => {
            const raw = parseInt(pick('evidenceCount') || '', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : undefined;
        })(),
        birthEvidence: (() => {
            const raw = pick('birthEvidence');
            if (!raw) return undefined;
            try {
                const p = JSON.parse(raw) as { wins?: number; losses?: number; clusterSize?: number; at?: string };
                const clusterSize = Number(p?.clusterSize);
                if (!Number.isFinite(clusterSize) || clusterSize <= 0) return undefined;
                return {
                    wins: Number.isFinite(Number(p.wins)) ? Number(p.wins) : 0,
                    losses: Number.isFinite(Number(p.losses)) ? Number(p.losses) : 0,
                    clusterSize,
                    at: typeof p.at === 'string' ? p.at : '',
                };
            } catch {
                // A malformed row degrades to "no recorded birth cluster",
                // which makes the skill STRICTER (it must earn its sample from
                // injection), never laxer. Legacy files have no such key at
                // all and are unaffected.
                return undefined;
            }
        })(),
        when: pick('when') || pick('ifCondition'),
        predicate: pick('predicate'),
        strategyFamily: pick('strategyFamily'),
        signals: pick('signals'),
        invalidation: pick('invalidation'),
        horizon: (() => {
            const h = (pick('horizon') || '').toLowerCase();
            return h === 'scalp' || h === 'intraday' || h === 'swing' || h === 'position' ? h : undefined;
        })(),
        sizing: pick('sizing'),
        prior: pick('prior') === 'book' ? 'book' as const
            : pick('prior') === 'gated' ? 'gated' as const : undefined,
        recentOutcomes: (() => {
            const r = (pick('recentOutcomes') || '').toUpperCase().replace(/[^WL]/g, '');
            return r ? r.slice(-RECENT_WINDOW) : undefined;
        })(),
        body,
        refinedAt: pick('refinedAt'),
        modifiedAt: pick('modified'),
        audience: (() => {
            const a = pick('audience');
            return a === 'analyst' || a === 'moderator' ? a : 'all';
        })(),
        evalVerdict: (() => {
            const v = (pick('evalVerdict') || '').toLowerCase();
            return v.startsWith('helps') ? 'helps'
                : v.startsWith('mixed') ? 'mixed'
                    : v.startsWith('hurts') ? 'hurts'
                        : v.startsWith('inconclusive') ? 'inconclusive'
                            : undefined;
        })(),
        evalDetail: pick('evalVerdict')?.replace(/^(helps|mixed|hurts|inconclusive)\s*/i, '').replace(/^\(|\)$/g, '') || undefined,
        lastEvalAt: pick('lastEvalAt'),
        // One-sentence semantic summary + debate provenance. Capped at the
        // Agent-Skills spec's 1024 — the same cap serializeSkill writes, so a
        // round-trip never truncates the activation key mid-phrase.
        description: pick('description')?.slice(0, 1024) || undefined,
        originMessageId: pick('originMessageId') || undefined,
        supersededBy: pick('supersededBy') || undefined,
        // Sequential-eval streak: consecutive runs of the same
        // verdict. Absent on legacy skills ⇒ treated as confirmed.
        evalStreak: (() => {
            const n = parseInt(pick('evalStreak') || '', 10);
            return Number.isFinite(n) && n > 0 ? n : undefined;
        })(),
        // Control group: matched-but-not-injected trade ids.
        controlIds: (() => {
            const raw = pick('controlIds');
            if (!raw) return undefined;
            const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
            return ids.length > 0 ? ids : undefined;
        })(),
        // The control group's aggregate sample. Absent means "not counted yet"
        // (legacy row), NOT zero — controlStatsFrom falls back to recounting
        // the ids in that case.
        controlWins: (() => {
            const n = parseInt(pick('controlWins') || '', 10);
            return Number.isFinite(n) && n > 0 ? n : undefined;
        })(),
        controlLosses: (() => {
            const n = parseInt(pick('controlLosses') || '', 10);
            return Number.isFinite(n) && n > 0 ? n : undefined;
        })(),
        // Injected-but-not-cited (OVERRIDDEN) trade ids.
        overriddenIds: (() => {
            const raw = pick('overriddenIds');
            if (!raw) return undefined;
            const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
            return ids.length > 0 ? ids : undefined;
        })(),
        // Per-regime W/L split (JSON map in frontmatter).
        regimeStats: (() => {
            const raw = pick('regimeStats');
            if (!raw) return undefined;
            try {
                const parsed = JSON.parse(raw) as Record<string, { w?: number; l?: number }>;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
                const out: NonNullable<SkillMeta['regimeStats']> = {};
                for (const [k, v] of Object.entries(parsed)) {
                    if (v && Number.isFinite(v.w) && Number.isFinite(v.l)) out[k] = { w: v.w!, l: v.l! };
                }
                return Object.keys(out).length > 0 ? out : undefined;
            } catch {
                return undefined;
            }
        })(),
        // The birth-certificate claim.
        prediction: parsePredictionLine(pick('prediction')) ?? undefined,
        // Followed-evidence sample at the last claim test (re-test
        // only when new evidence landed since).
        claimTestedEvidence: (() => {
            const n = parseInt(pick('claimTestedEvidence') || '', 10);
            return Number.isFinite(n) && n >= 0 ? n : undefined;
        })(),
        // The pending shadow refinement (JSON in frontmatter).
        shadow: (() => {
            const raw = pick('shadow');
            if (!raw) return undefined;
            try {
                const parsed = JSON.parse(raw) as SkillMeta['shadow'];
                return parsed && typeof parsed.body === 'string' && parsed.kind ? parsed : undefined;
            } catch {
                return undefined;
            }
        })(),
        // Cross-regime diagnostic: counted trades outside the scope regime.
        crossRegimeIds: (() => {
            const raw = pick('crossRegimeIds');
            if (!raw) return undefined;
            const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
            return ids.length > 0 ? ids : undefined;
        })(),
        lastEvidenceAt: pick('lastEvidenceAt'),
        lastMatchedAt: pick('lastMatchedAt'),
        suspendedAt: pick('suspendedAt'),
        disabledByUser: pick('disabledByUser') === 'true' || undefined,
        manualOnly: pick('manualOnly') === 'true' || undefined,
        previousVersion,
        // Temporal ledger: JSON array in frontmatter.
        history: (() => {
            const raw = pick('history');
            if (!raw) return undefined;
            try {
                const parsed = JSON.parse(raw) as SkillMeta['history'];
                return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
            } catch {
                return undefined;
            }
        })(),
    };
}

/**
 * The spec's `name:` key, read straight off the frontmatter.
 *
 * `parseSkillMarkdown` deliberately does NOT return it: August derives `name`
 * from the TITLE at write time, so a renamed title moves the identity with it.
 * That is right for a file August wrote and wrong for a file another tool
 * wrote — the Agent Skills convention puts the identity in `name:` and treats
 * the file name as incidental. So the key is read here, separately, for the
 * one thing that needs it: telling a spec-shaped file's own name apart from
 * the notebook file name it landed under.
 */
export const frontmatterName = (content: string): string | undefined => {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return undefined;
    const line = match[1].match(/^name:[ \t]*(.+)$/mi)?.[1];
    const decoded = decodeFrontmatterScalar(line);
    return decoded ? decoded.trim() : undefined;
};

/**
 * A file that is BOTH named like the convention's skill file AND carries
 * content the parser accepts.
 *
 * The name alone is not enough: a `SKILL.md` that does not parse is a GHOST
 * (see `services/learning/skillReview.ts`), and the review is what says so.
 * The content check is what makes the answer honest in both directions — a
 * `SKILL.md` that parses is spec-shaped, and one that does not is reported,
 * not silently skipped.
 */
export const isSpecShapedSkillFile = (file: MemoryFile): boolean =>
    file.name.toLowerCase() === SPEC_SKILL_FILE_NAME.toLowerCase()
    && parseSkillMarkdown(file.content) !== null;

/**
 * Whether a skill's notebook file should carry `enabled: true`.
 *
 * Every write path that recomputes `enabled` has to go through this. Deriving
 * it from `status` alone — as all ten of them did — silently un-suspends a
 * skill the moment an unrelated CONTROL or OVERRIDDEN attribution writes its
 * frontmatter back, which would make the idle lifecycle undo itself on the
 * next closed trade.
 */
export const skillEnabledFlag = (meta: SkillMeta): boolean =>
    meta.status !== 'retired' && !meta.suspendedAt && !meta.disabledByUser;

/**
 * THE ACTIVATION GATE — one fact, read everywhere a belief can reach a model or a
 * trade: prompt injection (`MemoryRetrievalService.rankedMatchedSkills`), soft
 * enforcement and the hard veto (`applyNotebookSkillsToAnalysis`,
 * `confirmedAvoidForSetup`).
 *
 * It exists because `enabled` was never an approval: it means "not retired, not
 * suspended, not user-disabled", so every one of the Step B audit's 13 paths could
 * inject and veto a rule no person had said yes to. Approval is a separate fact a
 * HUMAN action sets — and the supervisor's `approvedBy: 'supervisor'` is explicitly
 * NOT it, because a model approving its own queue is triage, not consent.
 *
 * Read-side gating (rather than writing `enabled: false` at creation) is deliberate:
 * nothing is destroyed, revocation is a one-field edit, the row keeps accruing its
 * own evidence so the reviewer can see it beside the request, and a writer that
 * forgets to set the fact fails CLOSED — it simply never activates.
 */
export const isApprovedSkill = (meta: Pick<SkillMeta, 'approvedBy' | 'prior'>): boolean => {
    if (meta.approvedBy === 'human' || meta.approvedBy === 'grandfathered') return true;
    // The starter library is vetted literature, not model output: one explicit
    // Settings toggle approves the whole shelf, and it is ON by default so the app
    // keeps the behaviour the books were shipped for.
    if (meta.prior === 'book') return getHarnessSettings().starterLibraryEnabled !== false;
    return false;
};

/**
 * THE INJECTION GATE — approval OR a live tentative skill.
 *
 * A tentative skill is a rule the post-mortem loop earned from independent
 * outcomes before a human confirmed it. The owner's ruling (2026-11-02) is
 * that it may be injected as LABELLED CONTEXT without a click, and the trader
 * can edit or disable it. It is deliberately NOT `isApprovedSkill`: the
 * enforcement paths (confidence caps, the hard avoid veto) keep reading the
 * approval gate, so a tentative rule can inform a read but can never veto a
 * trade. The global switch turns the whole tentative channel off.
 */
export const isInjectableSkill = (meta: Pick<SkillMeta, 'approvedBy' | 'prior'>): boolean =>
    isApprovedSkill(meta)
    || (meta.approvedBy === 'tentative'
        && getHarnessSettings().tentativeSkillInjectionEnabled !== false);

/**
 * Activate the skill the library already holds under this trigger.
 *
 * A duplicate is not an approval. The ingest path refuses a second skill with the
 * same IF clause regardless of whether the existing row is approved, enabled or
 * retired — so a human pressing Save on a draft whose trigger was already present
 * was told "already learned" while the skill stayed inert, and the draft was
 * consumed (the 2026-10-27 audit S-1). This is the one writer that turns such a row into a
 * live skill; it returns the file name, or null when the trigger is not there.
 */
export const activateSkillForTrigger = async (when: string, username: string): Promise<string | null> => {
    const want = (when ?? '').trim().toLowerCase();
    if (!want) return null;
    // Read, rewrite and persist under the notebook's own lock: this is a second
    // writer of the file the ingest path writes, and a read outside the queue
    // clobbers an attribution write that landed between read and persist.
    return withNotebookWriteLock(async () => {
        const hit = getMemoryFiles().files.filter(isSkillFile)
            .map(f => ({ f, meta: parseSkillMarkdown(f.content) }))
            .find(({ meta }) => (meta?.when ?? '').trim().toLowerCase() === want);
        if (!hit?.meta) return null;
        // The approval fact only — the prose, predicate and evidence stay exactly
        // as the row carried them. A suspension is cleared because this press IS
        // the human override the idle lifecycle is waiting for; `enabled` is then
        // derived by the one flag, never written as a literal.
        const next: SkillMeta = { ...hit.meta, approvedBy: 'human', prior: 'gated', suspendedAt: undefined };
        const body = serializeSkill(next, titleFromMeta(next));
        await updateMemoryFileUnlocked(hit.f.id, { content: body, enabled: skillEnabledFlag(next) }, username);
        return hit.f.name;
    });
};

/** The ONE projection from the library to the skills-index row shape.
 *
 *  Both surfaces that build the index (the Agents surface and the dock) call this
 *  instead of mapping `listSkills()` themselves. They had two copies, and they
 *  drifted: one passed four of the filter facts, the other passed none — so a
 *  suspended, trader-disabled, human-invoked-only or other-audience skill could
 *  be NAMED to a seat that the injection path would never hand it to. Approval
 *  was missing from both, which is the same defect one level down: the index
 *  offered a rule the harness would not honour.
 *
 *  The index and the injection now read the same approval predicate
 *  (`isApprovedSkill`); `isIndexableSkill` applies it with the other facts. */
export const skillIndexRow = (file: { name: string }, meta: SkillMeta): SkillIndexRow => ({
    slug: file.name.replace(/\.md$/i, ''),
    status: meta.status,
    kind: meta.kind,
    description: meta.description,
    when: meta.when,
    audience: meta.audience,
    manualOnly: meta.manualOnly,
    suspended: Boolean(meta.suspendedAt),
    disabled: Boolean(meta.disabledByUser),
    approved: isApprovedSkill(meta),
    tentative: meta.approvedBy === 'tentative',
    lastEvidenceAt: meta.lastEvidenceAt,
});

/** The library read through that one projection. Rows whose declared
 *  `compatibility` this runtime cannot satisfy are NOT here — a hidden skill
 *  leaves the index entirely, because an index line for a skill the seat
 *  cannot load is a promise the desk would refuse. */
export const skillIndexRows = (): SkillIndexRow[] =>
    listSkills()
        .filter(({ meta }) => skillRunsHere(meta.compatibility, currentSkillRuntime(), DESK_TOOL_NAMES))
        // The global tentative channel switch: off means a tentative row is
        // not even NAMED to a seat, so the index cannot promise a rule the
        // injector would refuse.
        .filter(({ meta }) => meta.approvedBy !== 'tentative'
            || getHarnessSettings().tentativeSkillInjectionEnabled !== false)
        .map(({ file, meta }) => skillIndexRow(file, meta));

/** The runtime the skill library is being read from — the same three-way
 *  distinction the app itself makes: the Electron shell (its bridge), the
 *  Capacitor mobile shell, or a plain browser. A skill declaring
 *  `platforms: [macos, windows]` is a DESKTOP skill and stays hidden in the
 *  browser and on the phone; `platforms: [web]` hides it everywhere else. */
const currentSkillRuntime = (): SkillRuntime => {
    try {
        if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) return 'desktop';
    } catch { /* no window: treat as web */ }
    try {
        const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
        if (cap?.isNativePlatform?.()) return 'mobile';
    } catch { /* fall through */ }
    return 'web';
};

/** A rewrite invalidates the yes that came before it: the approval was for the rule
 *  as it read, so every path that moves a live skill's trigger must call this.
 *  `previousVersion` stays intact — this is a withdrawal, not an undo. */
export const revokeSkillApproval = (meta: SkillMeta): void => {
    meta.approvedBy = undefined;
    meta.approvedAt = undefined;
};

/** Stamp the approval fact from a real decision. `at` defaults to now. */
export const stampSkillApproval = (meta: SkillMeta, by: 'human', at?: string): void => {
    meta.approvedBy = by;
    meta.approvedAt = at ?? new Date().toISOString();
};

/**
 * A NON-HUMAN rewrite asks instead of activating. Called by every writer that
 * changes a live skill's trigger or body without a person in front of it (the
 * supervisor's rewrites, shadow promotion), it:
 *   1. keeps the version it is replacing — including the approval that version
 *      carried, so REVERT restores a working rule rather than a rolled-back text
 *      that is still inert;
 *   2. withdraws approval, so the new text is inactive until the trader acts;
 *   3. queues ONE item showing old text, new text and the evidence beside it.
 *
 * Fail-closed by construction: a writer that forgets step 2 leaves the row carrying
 * the approval it had, which is why this is one call the writers make rather than a
 * convention they remember. The structural test in tests/approvalGate.test.ts is what
 * keeps it that way.
 */
export const requestRewriteApproval = (
    meta: SkillMeta,
    to: { when?: string; body?: string },
    opts: { slug: string; username: string; source: string; evidence?: string },
): void => {
    const from = {
        kind: meta.kind,
        when: meta.when,
        body: meta.body,
        predicate: meta.predicate,
        description: meta.description,
        approvedBy: meta.approvedBy,
        approvedAt: meta.approvedAt,
    };
    meta.previousVersion = from;
    revokeSkillApproval(meta);
    queueLearningProposal({
        kind: 'rewrite',
        skillSlug: opts.slug,
        text: `${opts.source} rewrote "${opts.slug}". It is INACTIVE until you approve it.`
            + `\nWAS: ${from.when ?? '—'}`
            + `\nNOW: ${to.when ?? '—'}`
            + (opts.evidence ? `\nEvidence: ${opts.evidence}` : ''),
        fingerprint: `rewrite|${opts.slug}|${to.when ?? ''}|${to.body ?? ''}`,
        payload: {
            source: opts.source,
            evidence: opts.evidence,
            old: { when: from.when, body: from.body },
            new: { when: to.when, body: to.body },
        },
    }, opts.username);
};

const findSkillRowBySlug = (slug: string) => {
    const wanted = slug.replace(/\.md$/i, '').toLowerCase();
    return getMemoryFiles().files
        .filter(isSkillFile)
        .find(f => f.name.replace(/\.md$/i, '').toLowerCase() === wanted);
};

/** The trader's YES on a pending rewrite: re-approve exactly what the row now
 *  says. The text was already written — what was missing was the approval. */
export const approvePendingRewrite = async (slug: string, username: string): Promise<ProposalApplyResult> =>
    withNotebookWriteLock(async () => {
        if (!slug) return { applied: false, reason: 'no-target' };
        await ensureHarnessFoldersUnlocked(username);
        const file = findSkillRowBySlug(slug);
        if (!file) return { applied: false, reason: 'no-target' };
        const meta = parseSkillMarkdown(file.content);
        if (!meta) return { applied: false, reason: 'unreadable' };
        stampSkillApproval(meta, 'human');
        meta.modifiedAt = new Date().toISOString();
        await updateMemoryFileUnlocked(file.id, {
            content: serializeSkill(meta, titleFromMeta(meta)),
        }, username);
        const back = parseSkillMarkdown(getMemoryFiles().files.find(f => f.id === file.id)?.content ?? '');
        return back?.approvedBy === 'human' ? { applied: true } : { applied: false, reason: 'not-written' };
    });

/** The trader's NO: put the old rule back, with the approval it held, so reverting
 *  cannot silently deactivate the thing they had been using. */
export const revertPendingRewrite = async (slug: string, username: string): Promise<ProposalApplyResult> =>
    withNotebookWriteLock(async () => {
        if (!slug) return { applied: false, reason: 'no-target' };
        await ensureHarnessFoldersUnlocked(username);
        const file = findSkillRowBySlug(slug);
        if (!file) return { applied: false, reason: 'no-target' };
        const meta = parseSkillMarkdown(file.content);
        if (!meta) return { applied: false, reason: 'unreadable' };
        const prev = meta.previousVersion;
        if (!prev?.when && !prev?.body) {
            // Nothing to go back to: the row stays as written and still unapproved.
            return { applied: false, reason: 'no-clauses' };
        }
        meta.kind = prev.kind;
        if (prev.when !== undefined) meta.when = prev.when;
        // The executable half is restored with the prose, and CLEARED when the
        // old version had none: leaving the newer predicate in place would keep
        // gating the restored rule on logic its text no longer describes.
        meta.predicate = prev.predicate;
        if (prev.description) meta.description = prev.description;
        if (prev.body) meta.body = prev.body;
        meta.previousVersion = undefined;
        // Re-stamp the PRIOR approval, not a fresh human one: the trader never said
        // yes to the rewrite, and the old version's yes is what they are restoring.
        meta.approvedBy = prev.approvedBy;
        meta.approvedAt = prev.approvedAt;
        meta.modifiedAt = new Date().toISOString();
        await updateMemoryFileUnlocked(file.id, {
            content: serializeSkill(meta, titleFromMeta(meta)),
        }, username);
        const back = parseSkillMarkdown(getMemoryFiles().files.find(f => f.id === file.id)?.content ?? '');
        return back?.when === prev.when ? { applied: true } : { applied: false, reason: 'not-written' };
    });

/**
 * THE GRANDFATHER MIGRATION — one pass over the existing library so the gate does
 * not silence the app on the day it lands.
 *
 * It MARKS and does not rewrite: a row is re-serialized with two front-matter fields
 * added, and it is only touched when it carries NO approval fact at all. That makes
 * it idempotent by construction (a second pass matches nothing), so a lost marker
 * cannot double-stamp or corrupt, and it makes "I never approved this" impossible to
 * accidentally record as "I did".
 *
 * Deliberately left alone:
 *   - `prior: 'book'` rows — approved by the starter-library TOGGLE, not per row.
 *     Stamping them would freeze them active even with the shelf switched off.
 *   - retired rows and rows already approved (including `supervisor` — a
 *     model-approved row is NOT stamped human; the trader approves it or not).
 *
 * The caller backs the notebook AND the profile up first; see
 * `services/learning/approvalMigration.ts`. This is the only user-data mutation in
 * the gate work.
 */
export const grandfatherExistingApprovals = async (
    username: string,
    at: string = new Date().toISOString(),
): Promise<{ stamped: number; alreadyMarked: number; skipped: number; failed: number }> => {
    const report = { stamped: 0, alreadyMarked: 0, skipped: 0, failed: 0 };
    const user = username || 'default';
    await withNotebookWriteLock(async () => {
        await ensureHarnessFoldersUnlocked(user);
        for (const file of getMemoryFiles().files.filter(isSkillFile)) {
            const meta = parseSkillMarkdown(file.content);
            if (!meta) { report.failed += 1; continue; }
            if (meta.approvedBy) { report.alreadyMarked += 1; continue; }
            if (meta.prior === 'book' || meta.status === 'retired') { report.skipped += 1; continue; }
            // Surgical front-matter insert, NOT `serializeSkill(meta, titleFromMeta(meta))`:
            // re-serializing normalizes the `# Title` line and recomputes derived fields
            // like `evidenceCount` from the tradeIds tail, so a "mark only" migration that
            // re-serialized would in fact rewrite the row. Two lines go in; nothing else
            // moves, byte for byte.
            const head = file.content.startsWith('---\n') ? file.content.indexOf('\n---', 4) : -1;
            if (head < 0) { report.failed += 1; continue; }
            const patched = `${file.content.slice(0, head + 1)}approvedBy: grandfathered\napprovedAt: ${at}\n${file.content.slice(head + 1)}`;
            try {
                await updateMemoryFileUnlocked(file.id, { content: patched }, user);
                report.stamped += 1;
            } catch {
                report.failed += 1;
            }
        }
    });
    return report;
};

export const setSkillStatus = async (fileId: string, status: SkillStatus, username?: string): Promise<void> => {
    const file = getMemoryFiles().files.find(f => f.id === fileId);
    if (!file) return;
    const meta = parseSkillMarkdown(file.content);
    if (!meta) return;
    // A status change is a human (or supervisor) decision that outranks the
    // idle sweep: bringing a skill back by hand must also lift its
    // suspension, or `skillEnabledFlag` would keep it out and the click would
    // silently do nothing.
    if (status !== 'retired') meta.suspendedAt = undefined;
    // Same reasoning for the user's own off-switch: a manual status change is
    // the trader saying "use this one", so it must also lift their veto.
    if (status !== 'retired') meta.disabledByUser = undefined;
    // And the auto-demotion reason travels with the suspension; a manual
    // reactivation is the trader overriding it.
    if (status !== 'retired') meta.demotion = undefined;
    stampStatusTransition(meta, status, status === 'retired' ? 'user-veto' : 'manual');
    meta.status = status;
    await updateMemoryFileUnlocked(fileId, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        enabled: skillEnabledFlag(meta),
    }, username || 'local');
};

/**
 * Temporal ledger write: close the current interval and
 * open the next one. Superseded beliefs are never erased — a demoted skill's
 * confirmed era stays queryable for replay audits ("what did I believe before
 * this eval?"). No-op when the status is unchanged.
 */
export const stampStatusTransition = (
    meta: SkillMeta,
    next: SkillStatus,
    reason?: string,
): void => {
    if (meta.status === next) return;
    const now = new Date().toISOString();
    const history = meta.history ?? [];
    // Close the currently-open interval.
    if (history.length > 0) {
        const last = history[history.length - 1];
        if (!last.invalidAt) last.invalidAt = now;
    } else if (meta.status) {
        // Backfill the implicit origin interval so the first transition
        // still yields two queryable eras.
        history.push({ status: meta.status, validFrom: meta.lastEvidenceAt || meta.modifiedAt || now });
        const last = history[history.length - 1];
        last.invalidAt = now;
    }
    history.push({ status: next, validFrom: now, reason });
    meta.history = history.slice(-20); // bound the ledger; 20 transitions is plenty
};

/**
 * Replay query: what status did this skill hold at a given moment?
 * Returns the interval whose [validFrom, invalidAt) window contains `at`,
 * or null when the ledger cannot answer (no history, or predates it).
 */
export const skillStatusAt = (meta: SkillMeta, at: string | number): SkillStatus | null => {
    const ts = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(ts)) return null;
    for (const entry of meta.history ?? []) {
        const from = Date.parse(entry.validFrom);
        const to = entry.invalidAt ? Date.parse(entry.invalidAt) : Number.POSITIVE_INFINITY;
        if (Number.isFinite(from) && ts >= from && ts < to) return entry.status;
    }
    return null;
};

export const listSkills = (): Array<{ file: MemoryFile; meta: SkillMeta }> =>
    getMemoryFiles().files.filter(isSkillFile).map(file => {
        const meta = parseSkillMarkdown(file.content);
        if (!meta || !meta.body.trim()) {
            // A bad skill never breaks discovery of the others — but it is
            // NAMED, not silently filtered, because a skill that vanished
            // from the index with no trace reads as a dead belief. Only real
            // breakage skips here (no frontmatter, empty body); NAME and
            // DESCRIPTION shape are validated at import, because August's own
            // writer derives `name:` from prose titles and the spec's
            // lowercase-hyphen rule is a third-party-file contract, not a
            // discovery gate.
            console.warn(`[Skills] skipped "${file.name}": ${meta ? 'empty body' : 'missing or invalid skill frontmatter'}`);
            return null;
        }
        return { file, meta };
    }).filter((row): row is { file: MemoryFile; meta: SkillMeta } => Boolean(row));

export const serializeSkill = (meta: SkillMeta, title: string): string => {
    // The two spec-required fields lead the portable face. `name` is derived
    // from the title so a rename moves the identity with it, and it is capped
    // at the spec's 64 chars.
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 64);
    const description = (meta.description?.trim()
        || meta.when
        || meta.body.trim().split(/\s+/).slice(0, 24).join(' ')
        || title.trim()).replace(/\s+/g, ' ').slice(0, 1024);
    const portable: string[] = [
        `name: ${yamlString(name)}`,
        `description: ${yamlString(description)}`,
        // The spec's required pair leads the file; `version` is the skill's own
        // revision of itself, and it travels with the skill (portable).
        `version: ${yamlString(meta.version ?? SKILL_FILE_VERSION)}`,
        `kind: ${yamlString(meta.kind)}`,
        ...(meta.coin ? [`coin: ${yamlString(meta.coin)}`] : []),
        ...(meta.timeframe ? [`timeframe: ${yamlString(meta.timeframe)}`] : []),
        ...(meta.source ? [`source: ${yamlString(meta.source)}`] : []),
        ...(meta.direction ? [`direction: ${yamlString(meta.direction)}`] : []),
        ...(meta.family ? [`family: ${yamlString(meta.family)}`] : []),
        ...(meta.regime ? [`regime: ${yamlString(meta.regime)}`] : []),
        ...(meta.when ? [`when: ${yamlString(meta.when.replace(/\n/g, ' '))}`] : []),
        ...(meta.predicate ? [`predicate: ${yamlString(meta.predicate.replace(/\n/g, ' '))}`] : []),
        ...(meta.strategyFamily ? [`strategyFamily: ${yamlString(meta.strategyFamily)}`] : []),
        ...(meta.signals ? [`signals: ${yamlString(meta.signals.replace(/\n/g, ' '))}`] : []),
        ...(meta.invalidation ? [`invalidation: ${yamlString(meta.invalidation.replace(/\n/g, ' '))}`] : []),
        ...(meta.horizon ? [`horizon: ${yamlString(meta.horizon)}`] : []),
        ...(meta.sizing ? [`sizing: ${yamlString(meta.sizing.replace(/\n/g, ' '))}`] : []),
        ...(meta.prior ? [`prior: ${yamlString(meta.prior)}`] : []),
        ...(meta.audience && meta.audience !== 'all' ? [`audience: ${yamlString(meta.audience)}`] : []),
        // ── WHAT the skill needs (the other half of invocation control) ──
        // One plain JSON string, so it stays a scalar like every other key
        // here — a JSON string is a valid YAML 1.2 double-quoted scalar, so a
        // hand-edit cannot break the block. Absent = no constraint, which is
        // exactly how every skill behaved before this key existed.
        ...(meta.compatibility && Object.keys(meta.compatibility).length
            ? [`compatibility: ${yamlString(JSON.stringify(meta.compatibility))}`]
            : []),
        // ── provenance of the procedure's acceptance (portable: WHO said yes) ──
        ...(meta.approvedBy ? [`approvedBy: ${yamlString(meta.approvedBy)}`] : []),
        ...(meta.approvedAt ? [`approvedAt: ${yamlString(meta.approvedAt)}`] : []),
        ...(meta.whyAccepted ? [`whyAccepted: ${yamlString(meta.whyAccepted.replace(/\n/g, ' '))}`] : []),
        ...(meta.reason ? [`reason: ${yamlString(meta.reason.replace(/\n/g, ' '))}`] : []),
        ...(meta.originBotId ? [`originBotId: ${yamlString(meta.originBotId)}`] : []),
        ...(meta.originBotName ? [`originBotName: ${yamlString(meta.originBotName)}`] : []),
        ...(meta.originMessageId ? [`originMessageId: ${yamlString(meta.originMessageId)}`] : []),
        // Third-party keys ride VERBATIM after the portable face — never
        // reinterpreted, never reordered, never dropped. These are lines the
        // app has no semantics for; changing one byte of them is a rewrite
        // the importer's author did not ask for.
        ...(meta.unknownFrontmatter?.length ? meta.unknownFrontmatter : []),
    ];

    // ── LEDGER FACE: every outcome and lifecycle key, below the marker. The
    // parser reads straight through it, so nothing here is rewritten and no
    // migration is needed — it is a comment to a reader and a boundary to one.
    const ledger: string[] = [
        `status: ${meta.status}`,
        `wins: ${meta.wins}`,
        `losses: ${meta.losses}`,
        `sample: ${meta.wins + meta.losses}`,
        ...(meta.consecutiveLosses > 0 ? [`consecutiveLosses: ${meta.consecutiveLosses}`] : []),
        ...(meta.recentOutcomes ? [`recentOutcomes: ${yamlString(meta.recentOutcomes)}`] : []),
        ...(meta.netR !== undefined && meta.rSampled && meta.rSampled > 0
            ? [
                // The NET sum, at the cost model's precision (4 dp) — a 0.10 R
                // round trip must not be rounded away by a 2 dp write.
                `netR: ${round4(meta.netR)}`,
                // The GROSS sum beside it, so nothing that needs the raw market
                // result has to subtract the cost back out.
                ...(meta.grossR !== undefined ? [`grossR: ${round4(meta.grossR)}`] : []),
                // Whether `netR` is a true net or a FLOOR (some outcomes could
                // not be costed). Written whenever the pair is written, because
                // a reader who cannot tell the two apart is reading a gross
                // number under a net label.
                `netRKnown: ${meta.netRKnown === true}`,
                ...(meta.netRUnknown ? [`netRUnknown: ${yamlString(meta.netRUnknown)}`] : []),
                `rSampled: ${meta.rSampled}`,
            ]
            : []),
        ...(meta.suspendedAt ? [`suspendedAt: ${yamlString(meta.suspendedAt)}`] : []),
        ...(meta.demotion ? [`demotion: ${yamlString(meta.demotion)}`] : []),
        ...(meta.disabledByUser ? ['disabledByUser: true'] : []),
        ...(meta.manualOnly ? ['manualOnly: true'] : []),
        `modified: ${yamlString(meta.modifiedAt ?? new Date().toISOString())}`,
        ...(meta.evalVerdict ? [`evalVerdict: ${yamlString(`${meta.evalVerdict}${meta.evalDetail ? ` (${meta.evalDetail})` : ''}`)}`] : []),
        ...(meta.lastEvalAt ? [`lastEvalAt: ${yamlString(meta.lastEvalAt)}`] : []),
        ...(meta.refinedAt ? [`refinedAt: ${yamlString(meta.refinedAt)}`] : []),
        ...(meta.lastEvidenceAt ? [`lastEvidenceAt: ${yamlString(meta.lastEvidenceAt)}`] : []),
        ...(meta.lastMatchedAt ? [`lastMatchedAt: ${yamlString(meta.lastMatchedAt)}`] : []),
        ...(meta.supersededBy ? [`supersededBy: ${yamlString(meta.supersededBy)}`] : []),
        ...(meta.evalStreak ? [`evalStreak: ${meta.evalStreak}`] : []),
        ...(meta.controlIds && meta.controlIds.length > 0 ? [`controlIds: ${yamlString(meta.controlIds.slice(-CONTROL_ID_TAIL).join(','))}`] : []),
        // The control group's aggregate sample, written beside the id tail it
        // is counted from. Only when non-zero: an ABSENT pair is what the
        // cold-start branch of the CI gate reads as "no control evidence".
        ...(meta.controlWins || meta.controlLosses
            ? [`controlWins: ${meta.controlWins ?? 0}`, `controlLosses: ${meta.controlLosses ?? 0}`]
            : []),
        ...(meta.overriddenIds && meta.overriddenIds.length > 0 ? [`overriddenIds: ${yamlString(meta.overriddenIds.slice(-20).join(','))}`] : []),
        ...(meta.crossRegimeIds && meta.crossRegimeIds.length > 0 ? [`crossRegimeIds: ${yamlString(meta.crossRegimeIds.slice(-20).join(','))}`] : []),
        ...(meta.regimeStats ? [`regimeStats: ${JSON.stringify(meta.regimeStats)}`] : []),
        ...(meta.prediction ? [`prediction: ${yamlString(JSON.stringify(meta.prediction))}`] : []),
        ...(meta.claimTestedEvidence !== undefined ? [`claimTestedEvidence: ${meta.claimTestedEvidence}`] : []),
        ...(meta.shadow ? [`shadow: ${JSON.stringify(meta.shadow)}`] : []),
        ...(meta.history && meta.history.length > 0 ? [`history: ${JSON.stringify(meta.history)}`] : []),
        ...(meta.previousVersion ? [`previousVersion: ${JSON.stringify(meta.previousVersion)}`] : []),
        ...(meta.birthEvidence ? [`birthEvidence: ${JSON.stringify(meta.birthEvidence)}`] : []),
        `tradeIds: ${yamlString(meta.tradeIds.slice(-20).join(','))}`,
        // Monotonic evidence counter — the TRUE cumulative count, maintained
        // by countTradeOutcome on every counting path. The max() against the
        // tail-20 tradeIds list is only a FLOOR for legacy rows written
        // before the counter existed; without the increment the counter
        // used to saturate at 21 forever (tradeIds is capped at 20 by the
        // line above, so max(stored, 20+1) never grew past 21). Promotion
        // math does not consume this field (it uses wins+losses) — it
        // feeds the "learned from N logged trades" provenance line and the
        // generalization evidence sum, both of which must be honest.
        `evidenceCount: ${Math.max(meta.evidenceCount ?? 0, meta.tradeIds.length)}`,
    ];

    // One frontmatter block, two faces. The parser reads straight through the
    // marker (it is a YAML comment, invisible to a YAML reader and to a human
    // skimming the file), so a legacy file and a freshly-split file parse
    // identically — no migration, no rewrite, nothing lost.
    return [
        '---',
        ...portable,
        LEDGER_MARKER,
        ...ledger,
        '---',
        '',
        `# ${name}`,
        '',
        meta.body.trim(),
        '',
    ].join('\n');
};

export const skillMatchesSetup = (
    meta: SkillMeta,
    setup: { coin?: string; direction?: string; family?: string; pattern?: string; regime?: string }
): boolean => {
    if (meta.status === 'retired' || meta.supersededBy) return false;
    let hits = 0;
    const coin = setup.coin?.toUpperCase().replace(/USDT?$/, '');
    const skillCoin = meta.coin?.toUpperCase().replace(/USDT?$/, '');
    if (coin && skillCoin && coin === skillCoin) hits += 2;
    if (setup.direction && meta.direction && setup.direction === meta.direction) hits += 2;
    // Negation-aware: "fake-breakout" must NOT match a "breakout" skill.
    const fam = (setup.family || setup.pattern || '').toLowerCase();
    if (fam && meta.family && familiesRelate(fam, meta.family)) hits += 2;
    if (setup.regime && meta.regime && setup.regime === meta.regime) hits += 1;
    return hits >= 2;
};

/**
 * STRICT matcher for ENFORCEMENT paths (vetoes, eval-trade
 * selection). The loose `skillMatchesSetup` scores direction-equality alone
 * as a match (hits=2), so a confirmed avoid for "BTC long" vetoed EVERY Long
 * on EVERY coin. Enforcement requires real setup overlap: the skill must
 * share the coin, OR the pattern family, OR (direction + regime).
 * Retrieval keeps the loose matcher — recall breadth is cheap there.
 */
export const skillStrictlyMatchesSetup = (
    meta: SkillMeta,
    setup: { coin?: string; direction?: string; family?: string; pattern?: string; regime?: string },
): boolean => {
    if (meta.status === 'retired' || meta.supersededBy) return false;
    const coin = setup.coin?.toUpperCase().replace(/USDT?$/, '');
    const skillCoin = meta.coin?.toUpperCase().replace(/USDT?$/, '');
    const sameCoin = Boolean(coin && skillCoin && coin === skillCoin);
    const fam = (setup.family || setup.pattern || '').toLowerCase();
    const sameFamily = Boolean(fam && meta.family && familiesRelate(fam, meta.family));
    const sameDirection = Boolean(setup.direction && meta.direction && setup.direction === meta.direction);
    const sameRegime = Boolean(setup.regime && meta.regime && setup.regime === meta.regime);
    // A skill with NO scoping dimensions at all is a general lesson — it can
    // never strictly enforce.
    const scoped = Boolean(meta.coin || meta.family || meta.direction || meta.regime);
    if (!scoped) return false;
    return sameCoin || sameFamily || (sameDirection && sameRegime);
};

/** How many setup dimensions a skill actually shares — the
 *  ranking weight behind enforcement priority (coin > direction > family). */
const dimsOverlapCount = (
    meta: SkillMeta,
    setup: { coin?: string; direction?: string; family?: string; pattern?: string },
): number => {
    let n = 0;
    const coin = (setup.coin || '').toUpperCase().replace(/USDT?$/, '');
    const skillCoin = (meta.coin || '').toUpperCase().replace(/USDT?$/, '');
    if (coin && skillCoin && coin === skillCoin) n += 1;
    if (setup.direction && meta.direction && setup.direction === meta.direction) n += 1;
    const fam = (setup.family || setup.pattern || '').toLowerCase();
    if (fam && meta.family && familiesRelate(fam, meta.family)) n += 1;
    return Math.max(1, n);
};

/** Evidence-freshness multiplier for enforcement ranking —
 *  mirrors MemoryRetrievalService's decay: 0.75 default when no evidence is
 *  recorded, then exp(-ageDays/120) with NO floor (→ ~0.13 at 240d, ~0.02 at
 *  a year). Ranking weight only — it can never zero out a match entirely. */
const evidenceFreshnessFactor = (meta: SkillMeta): number => {
    if (!meta.lastEvidenceAt) return 0.75;
    const t = Date.parse(meta.lastEvidenceAt);
    if (!Number.isFinite(t)) return 0.75;
    const ageDays = Math.max(0, (Date.now() - t) / 86_400_000);
    return Math.exp(-ageDays / 120);
};

const enabledSkillMeta = (file: MemoryFile): SkillMeta | null => {
    if (!file.enabled || !isSkillFile(file)) return null;
    return parseSkillMarkdown(file.content);
};

/** Enforcement's reader: enabled AND approved. The two are different questions —
 *  `enabledSkillMeta` stays for reporting (`reviewSkillEffectiveness`), which must
 *  keep showing an unapproved row so the reviewer can see the evidence beside the
 *  request it is asked to approve. */
const approvedSkillMeta = (file: MemoryFile): SkillMeta | null => {
    const meta = enabledSkillMeta(file);
    return meta && isApprovedSkill(meta) ? meta : null;
};

/**
 * How long a recorded automated-eval verdict stays authoritative. After this
 * window a 'hurts' demotion expires: the next evidence pass re-derives status
 * from outcomes alone, and the scheduler may re-audit the skill for a fresh
 * verdict.
 */
export const EVAL_VERDICT_STALE_MS = 30 * 86_400_000;

/**
 * Sequential-evidence gating: a status change driven by an automated eval
 * verdict requires the SAME verdict on this many consecutive runs. One noisy
 * A/B run must not bench (or rehabilitate) a skill on its own. Shared with
 * SkillEvalService, which owns the streak bookkeeping; the deriveStatus
 * override below must honor the same bar or it re-introduces the one-run
 * demotion through the evidence path.
 */
export const EVAL_DEMOTE_STREAK = 2;

/**
 * TRUE while an automated-eval 'hurts' verdict still outranks outcome
 * correlation. Undated or unparseable verdicts stay active — conservative,
 * since there is no timestamp from which they could expire.
 */
export const evalDemotionActive = (meta: SkillMeta): boolean => {
    if (meta.evalVerdict !== 'hurts') return false;
    if (!meta.lastEvalAt) return true;
    const t = Date.parse(meta.lastEvalAt);
    if (!Number.isFinite(t)) return true;
    return Date.now() - t < EVAL_VERDICT_STALE_MS;
};

/**
 * Evidence observed AFTER the skill was injected — the birth cluster
 * subtracted out. The cluster that authored the trigger is the source of the
 * claim, not a test of it, so it cannot count toward the sample floor, the
 * confidence interval, or the claim's own evidence.
 */
export const followedEvidence = (meta: SkillMeta): { wins: number; losses: number } => {
    const n = meta.birthEvidence?.clusterSize ?? 0;
    if (n <= 0) return { wins: meta.wins, losses: meta.losses };
    return {
        wins: Math.max(0, meta.wins - meta.birthEvidence!.wins),
        losses: Math.max(0, meta.losses - meta.birthEvidence!.losses),
    };
};

/**
 * The raw ladder (5 samples, 60% win rate) is a FLOOR, not the gate —
 * a 4-1 record at N=5 is statistically indistinguishable from a coin flip.
 * Confirmation additionally requires the Wilson interval of the followed
 * evidence to separate from the control win rate (or, cold-start with no
 * control evidence, to exclude 50% outright at N ≥ 8). Demotion and
 * retirement are unchanged — the CI only gates PROMOTION.
 */
export const confirmationCiGate = (
    meta: SkillMeta,
    control?: { wins: number; losses: number },
): boolean => {
    const f = followedEvidence(meta);
    return ciGatePasses(meta.kind, f.wins, f.losses, control);
};

/** Control-group evidence for the CI comparison — the settled outcomes of the
 *  skill's controlIds (matched-but-not-injected trades). Prefers the persisted
 *  aggregate, which survives the trade log pruning that otherwise shrinks a
 *  control group to nothing; recounts the ids only for rows written before the
 *  aggregate existed. Either way the result is a POINT ESTIMATE, so the gate
 *  itself decides how much of it is worth comparing against. */
const controlStatsFrom = (
    meta: SkillMeta,
    allTrades?: LoggedTrade[],
): { wins: number; losses: number } | undefined => {
    const wins = meta.controlWins ?? 0;
    const losses = meta.controlLosses ?? 0;
    if (wins + losses > 0) return { wins, losses };
    if (!allTrades || !meta.controlIds || meta.controlIds.length === 0) return undefined;
    const ids = new Set(meta.controlIds);
    let countedWins = 0, countedLosses = 0;
    for (const t of allTrades) {
        if (!ids.has(t.id)) continue;
        if (t.outcome === TradeOutcome.WIN) countedWins += 1;
        else if (t.outcome === TradeOutcome.LOSS) countedLosses += 1;
    }
    return countedWins + countedLosses > 0 ? { wins: countedWins, losses: countedLosses } : undefined;
};

/** The alpha-decay window's W/L tokens in order (oldest first), junk dropped.
 *  The ordered view is what lets decay ask about a SLICE of the window instead
 *  of only its aggregate. */
const recentWindowTokens = (meta: SkillMeta): string[] =>
    (meta.recentOutcomes ?? '').toUpperCase().match(/[WL]/g) ?? [];

/** W/L tallies of a token run. */
const windowCounts = (tokens: string[]): { wins: number; losses: number } => {
    let wins = 0, losses = 0;
    for (const t of tokens) {
        if (t === 'W') wins += 1;
        else losses += 1;
    }
    return { wins, losses };
};

/** Win/loss counts inside the alpha-decay window (recentOutcomes).
 *  Null when the skill has no windowed evidence yet. */
export const recentWindowStats = (meta: SkillMeta): { wins: number; losses: number } | null => {
    if (!meta.recentOutcomes) return null;
    // Count BOTH tokens. `length - wins` counted every non-W byte as a loss, so
    // a dirty "WLXL" row invented two losses out of junk and could sink a skill
    // under the decay bar on evidence that was never counted. Writes only go
    // through appendRecentOutcome today, so this bites legacy/corrupt rows —
    // which is exactly why the read cannot trust the shape.
    return windowCounts(recentWindowTokens(meta));
};

/** One decay slice under the bar, for the skill's kind (repeat: below;
 *  avoid: above). A point estimate — isDecayed decides how many slices must
 *  agree before it counts as decay. */
const decaySliceBad = (kind: SkillKind, wins: number, losses: number): boolean => {
    const n = wins + losses;
    if (n <= 0) return false;
    const wr = wins / n;
    return kind === 'repeat' ? wr < DECAY_RECENT_WINRATE : wr > 1 - DECAY_RECENT_WINRATE;
};

/** True when the recent window carries enough samples to judge and has
 *  decayed below the bar for the skill's kind (repeat: below; avoid: above).
 *
 *  TWO slices must sit under the bar: the whole retained window AND its most
 *  recent DECAY_MIN_SAMPLES outcomes. One slice is a bare point estimate — at
 *  N = 8 a 0.25 win-rate still carries a one-sided 95% upper bound of 0.54,
 *  which says nothing about a 0.35 edge — and a lone cold patch inside a
 *  recovering window ('LLLLLLWWWW' is 20% overall but its freshest 8 sit at
 *  50%) is recovery, not decay. Sequential evidence, the same shape as
 *  EVAL_DEMOTE_STREAK: one bad sample may not bench a skill, two in a row may. */
export const isDecayed = (meta: SkillMeta): boolean => {
    const r = recentWindowStats(meta);
    if (!r || r.wins + r.losses < DECAY_MIN_SAMPLES) return false;
    if (!decaySliceBad(meta.kind, r.wins, r.losses)) return false;
    const fresh = windowCounts(recentWindowTokens(meta).slice(-DECAY_MIN_SAMPLES));
    return decaySliceBad(meta.kind, fresh.wins, fresh.losses);
};

/** Append one counted outcome to the alpha-decay window (tail-capped).
 *  Called everywhere the global wins/losses counters move, so the decay
 *  view can never drift from the lifetime record. */
export const appendRecentOutcome = (meta: SkillMeta, win: boolean): void => {
    meta.recentOutcomes = ((meta.recentOutcomes ?? '') + (win ? 'W' : 'L')).slice(-RECENT_WINDOW);
};

/** Four-decimal rounding — the precision the cost model works at (a 0.10 R
 *  round trip against a 1 % stop needs it, and the ledger sums many of them). */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Count ONE followed W/L on a skill: lifetime counters, loss streak,
 * alpha-decay window and the monotonic evidence counter — in one place.
 * Every path that moves wins/losses must go through this helper, or the
 * decay view and the "learned from N logged trades" provenance line
 * silently drift from the lifetime record: the craft/merge folds used to
 * bump counters without touching `recentOutcomes` (alpha-decay could never
 * see that evidence) and without growing `evidenceCount`, which left the
 * counter pinned at 20 (tail) + 1 (this trade) forever.
 * Call BEFORE the trade id is appended to `tradeIds` — the legacy-row
 * floor for the counter is derived from the pre-append length.
 *
 * `r` is the trade's price-measured R (`trade.realizedR`), and is OPTIONAL by
 * design: most rows — every trade logged before the post-mortem began
 * persisting it, and every one whose validation never resolved an exit — have
 * no trustworthy R. Those simply do not feed the expectancy ledger, which is
 * why `rSampled` is tracked separately from `wins + losses`.
 *
 * `cost` carries what the trade knows about the round trip: its own `netR`
 * (written by the journal write path, which computed it with the same cost
 * model) and the trade's `stopDistancePct` for the fallback. It is OPTIONAL,
 * and its absence is meaningful rather than neutral: with a net, the outcome
 * is charged the modelled round trip and `netR` becomes a true net; without
 * one, the cost is UNKNOWN, the outcome contributes its gross R, and `netR`
 * is a non-net with `netRKnown: false` saying so. A missing cost is never
 * written as a zero cost.
 */
export const countTradeOutcome = (
    meta: SkillMeta,
    win: boolean,
    r?: number,
    cost?: { netR?: number; stopDistancePct?: number },
): void => {
    if (win) {
        meta.wins += 1;
        meta.consecutiveLosses = 0;
    } else {
        meta.losses += 1;
        meta.consecutiveLosses += 1;
    }
    if (typeof r === 'number' && Number.isFinite(r)) {
        // ── the ledger is NET now (audit finding F-13) ──
        // The accumulator used to sum GROSS R into a field called `netR`, so
        // the name lied and every expectancy in the app was gross. The cost
        // model (`utils/netRiskReward.ts`) is the ONE place that knows what a
        // round trip costs in R; it charges the cost on a LOSS too, because a
        // stopped-out trade still paid the fees.
        //
        // The trade's OWN net is preferred — the journal write path already
        // computed it with the same model, and one cost computation per trade
        // is one cost computation, not two that can disagree. The recompute is
        // the fallback for a row that never went through that path.
        //
        // When the cost CANNOT be computed — no stop distance on the trade —
        // the outcome contributes its GROSS R and the sum stops being a true
        // net: it sits between the net and the gross, OVERSTATING the net
        // because a cost that was never charged never subtracted.
        // `netRKnown: false` is what says so, so a gross number is never read
        // under a net label. A missing cost is NEVER stored as a zero cost.
        //
        // ONE more case, and it is the same rule: a ledger that was WRITTEN
        // before the cost model holds a gross sum that cannot be converted —
        // the legacy trades' stop distances are gone, so their costs are
        // unknowable. Such a ledger keeps its unit (gross) and every outcome
        // added to it is added gross, so the sum never mixes two units. The
        // marker is `netRUnknown: 'legacy-gross'`.
        const gross = r;
        meta.grossR = round4((meta.grossR ?? 0) + gross);
        if (meta.netRUnknown === 'legacy-gross') {
            // A gross ledger stays gross.
            meta.netR = round4((meta.netR ?? 0) + gross);
            meta.netRKnown = false;
        } else {
            const net = resolveNetR(gross, cost);
            if (net.netR !== null) {
                meta.netR = round4((meta.netR ?? 0) + net.netR);
                // Undefined until the first counted outcome; once false it stays
                // false, because ONE uncosted outcome makes the whole sum a
                // non-net.
                if (meta.netRKnown === undefined) meta.netRKnown = true;
            } else {
                meta.netR = round4((meta.netR ?? 0) + gross);
                meta.netRKnown = false;
                meta.netRUnknown = net.unknown ?? 'stop-distance';
            }
        }
        meta.rSampled = (meta.rSampled ?? 0) + 1;
    }
    appendRecentOutcome(meta, win);
    meta.evidenceCount = Math.max(meta.evidenceCount ?? 0, meta.tradeIds.length) + 1;
};

/**
 * The net R of ONE outcome, or null when the cost could not be computed.
 *
 * `cost.netR` is the trade row's own net (`LoggedTrade.netR`), written by the
 * journal write path with the same cost model — preferred, so the cost is
 * computed once per trade. `cost.stopDistancePct` is the fallback for a row
 * that never went through that path.
 */
const resolveNetR = (
    grossR: number,
    cost?: { netR?: number; stopDistancePct?: number },
): { netR: number | null; unknown?: string } => {
    if (cost && typeof cost.netR === 'number' && Number.isFinite(cost.netR)) {
        return { netR: cost.netR };
    }
    if (cost && typeof cost.stopDistancePct === 'number' && cost.stopDistancePct > 0) {
        const res = netRiskReward({ grossR, stopDistancePct: cost.stopDistancePct });
        if (res.known && res.netR !== null) return { netR: res.netR };
        return { netR: null, unknown: res.unknown };
    }
    return { netR: null, unknown: 'stop-distance' };
};

/**
 * The stop distance of a trade, in PERCENT — the unit the cost model wants
 * (a 1 % stop is `1`, not `0.01`).
 *
 * Undefined when the trade carries no usable levels, which is the common case
 * for the rows the app cannot price (a hand-logged trade, a plan whose entry
 * never resolved). Undefined is honest: the cost model turns it into an
 * explicit "unknown", and the ledger records that the figure is not a true
 * net rather than pretending the round trip was free.
 */
const tradeStopDistancePct = (trade: LoggedTrade): number | undefined => {
    const entry = parsePrice(String(trade.analysis?.entryPoints?.[0]?.price ?? ''));
    const stop = parsePrice(String(trade.analysis?.stopLoss ?? ''));
    if (!Number.isFinite(entry) || !Number.isFinite(stop)) return undefined;
    // The unit lives with the cost model (`stopDistancePercent`), so the
    // journal write path and this one cannot drift.
    const pct = stopDistancePercent(entry, stop);
    return pct > 0 ? pct : undefined;
};

/** Minimum R-sampled outcomes before expectancy is worth showing. Matches the
 *  cold-start bar the Wilson promotion gate already uses. */
export const EXPECTANCY_MIN_R_SAMPLE = 8;

/**
 * Win-rate line at which a skill is CLAIMING an edge over a coin flip — and
 * therefore at which a non-positive expectancy is a conflict rather than just
 * a losing record. Mirrored for avoid skills: their claim is that the matched
 * setups lose more often than they win.
 */
export const EXPECTANCY_CONFLICT_WINRATE = 0.5;

/**
 * Average R per measured outcome, or undefined when there is nothing honest to
 * report. Callers must render undefined as "not yet measured" — never as 0R.
 *
 * The figure it divides is `meta.netR`, which is NET of the modelled
 * round-trip cost wherever that cost was computable and GROSS where it was
 * not. It is NOT blocked when the flag says so (`netRKnown === false`): the
 * promotion gate below stands aside on an undefined expectancy, so refusing
 * to report here would LOOSEN the gate — a skill with a clearly negative
 * record would sail through on its win rate. The number it does report sits
 * between the true net and the gross, so it still catches a losing skill.
 * `netRKnown` is for the READER (a UI that wants to say "not a true net"),
 * not for the gate.
 */
export const skillExpectancyR = (
    meta: Pick<SkillMeta, 'netR' | 'rSampled'>,
    minSample = EXPECTANCY_MIN_R_SAMPLE,
): number | undefined => {
    const n = meta.rSampled ?? 0;
    if (n < minSample || typeof meta.netR !== 'number' || !Number.isFinite(meta.netR)) return undefined;
    return Math.round((meta.netR / n) * 100) / 100;
};

/**
 * Promotion gate on the R ledger, which the ladder above never consulted: a
 * skill whose measured outcomes do not pay cannot be CONFIRMED.
 *
 * The ladder is graded on win rate, and win rate is precisely what a
 * small-target / wide-stop bleed fakes — 7 wins of +0.3R against 3 losses of
 * -0.8R is a 70% record and a -0.03R expectancy. `skillExpectancyR` is
 * undefined until the ledger holds EXPECTANCY_MIN_R_SAMPLE outcomes, and
 * undefined means UNMEASURED, not break-even: below that floor the gate
 * stands aside and the record is graded exactly as it was before R was
 * persisted. The sign is the skill's own — a repeat rule has to be positive R,
 * an avoid rule negative — and the comparison is strict, so a flat 0.00R
 * confirms nothing.
 *
 * Promotion only, like the CI: a confirmed skill keeps its tier through
 * re-derivation and is demoted by the retire band, the eval pin or the decay
 * window, never by a ledger that has since gone negative mid-session.
 */
const expectancySupportsPromotion = (meta: SkillMeta): boolean => {
    const expectancy = skillExpectancyR(meta);
    if (expectancy === undefined) return true;
    return meta.kind === 'repeat' ? expectancy > 0 : expectancy < 0;
};

/**
 * The expectancy a skill's win rate CONTRADICTS, or undefined when there is
 * nothing to contradict. A conflict is a claimed edge refused by measured R:
 * a repeat rule sitting above a coin flip on non-positive expectancy, or an
 * avoid rule below one on non-negative expectancy. Below the coin-flip line
 * the win rate claims nothing, and below EXPECTANCY_MIN_R_SAMPLE the ledger
 * has nothing honest to say — both return undefined rather than a guess.
 */
const expectancyConflictR = (meta: SkillMeta): number | undefined => {
    const expectancy = skillExpectancyR(meta);
    if (expectancy === undefined) return undefined;
    const sample = meta.wins + meta.losses;
    // Compared on the counts rather than on `hitRate` (a rounded percentage),
    // so the coin-flip line is exact instead of ±0.5% away.
    const claimsEdge = meta.kind === 'repeat'
        ? meta.wins > sample * EXPECTANCY_CONFLICT_WINRATE
        : meta.wins < sample * (1 - EXPECTANCY_CONFLICT_WINRATE);
    if (!claimsEdge) return undefined;
    const onTheWrongSide = meta.kind === 'repeat' ? expectancy <= 0 : expectancy >= 0;
    return onTheWrongSide ? expectancy : undefined;
};

const deriveStatus = (meta: SkillMeta, control?: { wins: number; losses: number }): SkillStatus => {
    // The birth cluster is evidence the skill was AUTHORED from, not evidence
    // it was TESTED on, so it is excluded from the claim test, the sample
    // floor and the confidence interval alike. Every number below therefore
    // describes outcomes observed after injection.
    const followed = followedEvidence(meta);
    // ── birth certificate ──
    // The skill's own pre-registered claim, tested against its followed
    // evidence. evaluateClaim is pure arithmetic, so the ladder can consume
    // it directly: a claim that has reached its horizon and FAILED blocks
    // promotion (the skill must meet the bar it promised, not just the
    // generic one); met or pending claims defer to the normal ladder.
    const claim = meta.prediction
        ? evaluateClaim(meta.kind, meta.prediction, followed)
        : null;
    const claimUnmet = Boolean(claim && !claim.pending && !claim.met);

    const sample = followed.wins + followed.losses;
    const winRate = sample > 0 ? followed.wins / sample : 0;
    // RETIREMENT FIRST: the retire band is a statement about the skill's
    // OUTCOMES (it has proven itself wrong often enough to leave the
    // library), and it must outrank the eval pin below. A hurts-pinned
    // 2W/8L skill used to early-return 'candidate' ABOVE this band, so it
    // could never auto-retire while the verdict stayed fresh (30 days) —
    // even as the effectiveness review kept recommending retire.
    if (sample >= MIN_SAMPLE_RETIRE) {
        if (meta.kind === 'repeat' && winRate < 0.4) return 'retired';
        if (meta.kind === 'avoid' && winRate > 0.6) return 'retired';
    }

    // ── Causal override ──
    // An automated A/B eval that shows the skill HURTS decisions pins it at
    // candidate regardless of outcome correlation — injection-causation
    // outranks co-occurrence. The override expires after EVAL_VERDICT_STALE_MS
    // so a stale verdict cannot bench a skill forever, and it respects the
    // sequential-evidence bar: a SINGLE 'hurts' run (evalStreak 1) must not
    // demote through this path either — otherwise the streak gate in
    // SkillEvalService.recordEvalVerdict would be bypassed on the very next
    // evidence trade.
    // The pin is STATUS-AGNOSTIC : guarding it on `status === 'confirmed'`
    // let a skill demoted by evals silently RE-PROMOTE through the CI gate
    // below on the next evidence pass — the two-consecutive-'helps'
    // rehabilitation bar in SkillEvalService was bypassed without the skill
    // ever proving itself again. A hurts-pinned skill climbs back only via
    // rehabilitation (two helps, which flips the verdict off 'hurts') or
    // after the verdict goes stale.
    // It applies ABOVE the retirement floor only (hence its placement after
    // the retire band): the pin blocks PROMOTION to confirmed, it must never
    // hold a skill out of 'retired' — demotion to retired is not promotion,
    // and the retire stats above are the stronger signal.
    if (
        meta.evalVerdict === 'hurts'
        && evalDemotionActive(meta)
        && (meta.evalStreak ?? 0) >= EVAL_DEMOTE_STREAK
    ) return 'candidate';
    // ── alpha decay ──
    // A CONFIRMED skill whose recent window has decayed below the bar is
    // demoted to candidate even while lifetime stats look fine — the
    // "151 Trading Strategies" decay thesis: edges fade, and cumulative
    // counters hide it. Demotion, not retirement: the lifetime record
    // protects the skill, and fresh evidence re-confirms it through the
    // normal ladder if the edge returns.
    if (meta.status === 'confirmed' && isDecayed(meta)) return 'candidate';
    if (sample >= MIN_SAMPLE_CONFIRMED) {
        const rawSaysConfirmed = meta.kind === 'repeat'
            ? winRate >= 0.6
            : meta.kind === 'avoid' ? winRate <= 0.4 : false;
        // Raw threshold is the floor; the Wilson CI and the R ledger are the
        // gates. The gates apply to PROMOTION only — a skill already confirmed
        // keeps its status through re-derivation passes (consolidation, merge)
        // and is demoted by the retire band or the eval override above, never
        // by retroactive statistics.
        if (rawSaysConfirmed && !claimUnmet && expectancySupportsPromotion(meta)
            && (meta.status === 'confirmed' || confirmationCiGate(meta, control))) {
            return 'confirmed';
        }
        return 'candidate';
    }
    return 'candidate';
};

export const titleFromMeta = (meta: SkillMeta): string => {
    const bits = [meta.kind === 'avoid' ? 'Avoid' : 'Repeat', meta.coin, meta.direction, meta.family]
        .filter(Boolean);
    return bits.join(' ') || 'Skill';
};

const fileNameFromMeta = (meta: SkillMeta): string => {
    const slug = slugifyName([meta.coin, meta.direction, meta.family, meta.kind].filter(Boolean).join(' '))
        || 'skill';
    return `${slug}.md`;
};

const clusterKey = (trade: LoggedTrade): string => {
    const coin = (trade.analysis?.coinName || 'GEN').toUpperCase().replace(/USDT?$/, '');
    const dir = trade.analysis?.direction === 'Long' || trade.analysis?.direction === 'Short'
        ? trade.analysis.direction
        : 'Neutral';
    const fam = trade.analysis?.detectedPatternFamily || trade.analysis?.marketConditions?.pattern || 'any';
    return `${coin}|${dir}|${fam}`;
};

/**
 * After a closed trade, bump wins/losses on every matching skill. A WIN
 * resets the consecutive-loss streak; a confirmed skill that reaches
 * REFINE_AFTER_CONSECUTIVE_LOSSES gets an LLM refinement pass (tightened
 * trigger) instead of silently bleeding.
 */
const applySkillEvidenceUnlocked = async (
    trade: LoggedTrade,
    username: string,
    allTrades?: LoggedTrade[],
): Promise<string[]> => {
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return [];
    if (!tradeAdmitsTechnicalStrategyRule(trade)) return [];
    await ensureHarnessFoldersUnlocked(username);
    const refineTargets: string[] = [];
    const setup = {
        coin: trade.analysis?.coinName,
        direction: trade.analysis?.direction,
        family: trade.analysis?.detectedPatternFamily,
        pattern: trade.analysis?.marketConditions?.pattern,
        regime: trade.marketRegime,
    };
    for (const file of getMemoryFiles().files.filter(isSkillFile)) {
        const meta = parseSkillMarkdown(file.content);
        if (!meta) continue;
        // A skill the idle sweep suspended stays MATCHED so it can earn its way
        // back — retirement is the irreversible path and must not be reached by
        // an unrelated timer. `suspendedAt` is what tells the two apart; both
        // leave `enabled` false.
        if (!file.enabled && !meta.suspendedAt) continue;
        if (!skillMatchesSetup(meta, setup)) continue;
        if (meta.tradeIds.includes(trade.id)) continue;
        // This skill's trigger described a trade that just closed — the market
        // still resembles the rule, injected or not. The idle lifecycle reads
        // this as its revival clock, because `lastEvidenceAt` can never advance
        // again once a skill is out of the prompt.
        meta.lastMatchedAt = trade.timestamp ?? new Date().toISOString();

        // ── Weighted attribution (three-state adherence) ──
        // Full credit ONLY when retrieval actually injected this skill in the
        // run that produced this trade AND the verdict did not override it.
        // The join is EXACT on the originating runId (persisted on both sides)
        // — a time window anchored on trade.timestamp cannot work: the run
        // predates the log click, so "records since the trade" looked at later,
        // unrelated runs and mislabeled every followed skill as CONTROL.
        //   FOLLOWED (injected + cited)      → counts toward wins/losses
        //   OVERRIDDEN (injected + not cited) → separate override counter;
        //     the moderator was handed the skill and ignored it, so the
        //     outcome must not rot the skill's stats (the most common way
        //     skill stats silently decay). A high override rate is itself a
        //     signal — it queues an amendment proposal.
        //   CONTROL (matched, not injected)  → controlIds, the lift baseline.
        // Unknown telemetry (empty log, legacy records without runId/cited)
        // keeps full credit so tiering cannot starve on missing data.
        let adherence: Awaited<ReturnType<typeof skillAdherenceForRun>>;
        try {
            adherence = await skillAdherenceForRun(username, file.name, trade.sourceRunId);
        } catch {
            adherence = null;
        }
        // A suspended skill was NOT in this prompt, whatever the telemetry says
        // — and missing telemetry reads as UNKNOWN, which takes full credit.
        // Without this a legacy trade would both inflate a suspended skill's
        // record and instantly undo the suspension that gated it. `suspendedAt`
        // is tested alongside `enabled` because the notebook can toggle either
        // one alone, and a skill that carries a suspension stamp has to be
        // treated as absent from the prompt regardless.
        if (!file.enabled || meta.suspendedAt) adherence = 'not-injected';
        if (adherence === 'not-injected') {
            // CONTROL group: record and move on — never inflate wins/losses
            // with outcomes this skill did not shape.
            const control = meta.controlIds ?? [];
            if (!control.includes(trade.id)) {
                meta.controlIds = [...control, trade.id].slice(-CONTROL_ID_TAIL);
                // The id tail is provenance; THESE are the sample the CI gate
                // grades against. A tail-capped list can only ever prove
                // CONTROL_ID_TAIL outcomes however many control trades the
                // trader actually took, so the aggregate is uncapped and
                // monotonic — like evidenceCount, and never mixed into the
                // skill's own wins/losses. Counted inside the same
                // not-already-recorded guard, so a replayed trade cannot
                // double-count the baseline it is being measured against.
                if (trade.outcome === TradeOutcome.WIN) meta.controlWins = (meta.controlWins ?? 0) + 1;
                else if (trade.outcome === TradeOutcome.LOSS) meta.controlLosses = (meta.controlLosses ?? 0) + 1;
                meta.modifiedAt = new Date().toISOString();
                await updateMemoryFileUnlocked(file.id, {
                    content: serializeSkill(meta, titleFromMeta(meta)),
                    enabled: skillEnabledFlag(meta),
                }, username);
            }
            continue;
        }
        if (adherence === 'overridden') {
            // OVERRIDDEN: injected and ignored. Never counts toward the
            // skill's record; accumulates the amendment signal instead.
            const over = meta.overriddenIds ?? [];
            if (!over.includes(trade.id)) {
                meta.overriddenIds = [...over, trade.id].slice(-20);
                meta.modifiedAt = new Date().toISOString();
                await updateMemoryFileUnlocked(file.id, {
                    content: serializeSkill(meta, titleFromMeta(meta)),
                    enabled: skillEnabledFlag(meta),
                }, username);
                if (meta.overriddenIds.length >= OVERRIDE_RATE_FOR_AMENDMENT) {
                    queueLearningProposal({
                        kind: 'rescope',
                        skillSlug: file.name.replace(/\.md$/i, ''),
                        text: `${file.name} was injected and ignored ${meta.overriddenIds.length} times — the trigger or wording needs an amendment pass (the floor keeps routing around it).`,
                        fingerprint: `${file.name}|override`,
                    }, username);
                }
            }
            continue;
        }

        // Eval-verdict agreement: the first FOLLOWED trade after a
        // helps/hurts verdict era is one agreement sample (once per era).
        if ((meta.evalVerdict === 'helps' || meta.evalVerdict === 'hurts') && meta.lastEvalAt) {
            void recordEvalAgreement(
                username,
                `${file.name}|${meta.lastEvalAt}`,
                (meta.evalVerdict === 'helps') === (trade.outcome === TradeOutcome.WIN),
            );
        }
        // ── Evidence decay ──
        // Authority expires with its evidence: stale counts are halved
        // per age band before counting this trade. Runs ONLY here — on
        // the FOLLOWED branch — because a CONTROL (matched-but-not-
        // injected) or OVERRIDDEN outcome says nothing about the skill's
        // guidance and must not erode its earned authority. Regime
        // mismatch does NOT halve — "works in trend, fails in chop" is
        // CONDITIONAL, not fading; the per-regime split below routes
        // divergence to a re-scope proposal instead of decay.
        applyEvidenceDecay(meta, trade.marketRegime);
        countTradeOutcome(meta, trade.outcome === TradeOutcome.WIN, trade.realizedR, { netR: trade.netR, stopDistancePct: tradeStopDistancePct(trade) });
        // Per-regime split, written alongside the global counters —
        // the substrate that lets a conditional pattern be RE-SCOPED instead
        // of decayed into oblivion.
        if (trade.marketRegime) {
            const stats = { ...(meta.regimeStats ?? {}) };
            const cur = stats[trade.marketRegime] ?? { w: 0, l: 0 };
            stats[trade.marketRegime] = trade.outcome === TradeOutcome.WIN
                ? { w: cur.w + 1, l: cur.l }
                : { w: cur.w, l: cur.l + 1 };
            meta.regimeStats = stats;
            maybeQueueRescopeProposal(file.name, meta, username);
        }
        // A pending shadow refinement observes the same matched
        // trades — its counterfactual window fills while the live version
        // keeps the injection slot. At window close the comparison settles.
        if (meta.shadow) {
            meta.shadow = {
                ...meta.shadow,
                seen: meta.shadow.seen + 1,
                wins: meta.shadow.wins + (trade.outcome === TradeOutcome.WIN ? 1 : 0),
                losses: meta.shadow.losses + (trade.outcome === TradeOutcome.LOSS ? 1 : 0),
            };
            if (meta.shadow.seen >= SHADOW_WINDOW_TRADES) {
                const settled = settleShadow(meta, { wins: meta.shadow.wins, losses: meta.shadow.losses });
                // This refinement settled — one recovery sample.
                void recordRefinementOutcome(username, settled.promoted);
                if (settled.promoted) {
                    // A shadow promotion rewrites the live rule from model output.
                    // It now asks: snapshot + withdraw approval + queue the item,
                    // BEFORE the fields move, so the snapshot is the version the
                    // trader was actually using.
                    requestRewriteApproval(meta, {
                        when: meta.shadow.when,
                        body: meta.shadow.body,
                    }, {
                        slug: file.name.replace(/\.md$/i, ''),
                        username,
                        source: 'shadow refinement',
                        // What the counter actually measured: the LIVE rule's record
                        // over the shadow window. The shadow never ran, so this is
                        // not a head-to-head and must not be presented as one
                        // (the 2026-10-27 audit S-3).
                        evidence: `the live rule went ${meta.shadow.wins}W/${meta.shadow.losses}L over ${meta.shadow.seen} matched trades while this refinement was shadowed`,
                    });
                    meta.kind = meta.shadow.kind;
                    meta.when = meta.shadow.when;
                    meta.body = meta.shadow.body;
                    meta.shadow = undefined;
                } else if (settled.discarded) {
                    meta.shadow = undefined;
                    try {
                        const { recordHarnessLesson } = await import('./harnessLessons');
                        recordHarnessLesson({
                            kind: 'injection',
                            scope: 'skillGuidance',
                            pattern: `skill-refinement:${file.name.replace(/\.md$/i, '')}`,
                            lesson: settled.lesson ?? 'refinement overfit',
                            evidenceId: trade.id,
                        });
                    } catch { /* lesson store is best-effort */ }
                }
            }
        }
        meta.tradeIds = [...meta.tradeIds, trade.id];
        // Cross-regime diagnostic: this counted trade came from OUTSIDE the
        // skill's scope regime. The evidence still counts (applyEvidenceDecay
        // already halved it), but the ids let review passes see how much of a
        // skill's support was earned in foreign regimes.
        if (trade.marketRegime && meta.regime && trade.marketRegime !== meta.regime) {
            const cross = meta.crossRegimeIds ?? [];
            if (!cross.includes(trade.id)) meta.crossRegimeIds = [...cross, trade.id].slice(-20);
        }
        // Track the freshest evidence and the regime it came from.
        meta.lastEvidenceAt = trade.timestamp ?? new Date().toISOString();
        meta.modifiedAt = new Date().toISOString();
        // Gap-fill only: the FIRST regime a skill is evidenced in is its scope.
        // A later trade in a different regime must not silently re-scope the
        // belief (last-write-wins drift) — cross-regime evidence is already
        // discounted by applyEvidenceDecay, and a genuine re-scope belongs in a
        // refinement pass, not an evidence append.
        if (trade.marketRegime && !meta.regime) meta.regime = trade.marketRegime;
        {
            const derived = deriveStatus(meta, controlStatsFrom(meta, allTrades));
            // A demotion driven by the eval causal override (not by the
            // win-rate math) must read as an EVAL demotion in the temporal
            // ledger — rehabilitation looks for /^eval hurts/ on the last
            // transition and would never find it under a bare 'evidence'.
            const evalOverrideDemotion = derived === 'candidate'
                && meta.status === 'confirmed'
                && meta.evalVerdict === 'hurts'
                && evalDemotionActive(meta)
                && (meta.evalStreak ?? 0) >= EVAL_DEMOTE_STREAK;
            // Worth-gate precision: a gate-approved skill confirming is
            // one delivery of the gate's promise.
            if (derived === 'confirmed' && meta.status !== 'confirmed') {
                void recordWorthGateConfirm(username, meta.when);
            }
            // A retire-band transition records WHICH reason, not just
            // 'evidence'. Regime-mix divergence distinguishes a real
            // shift from a simple evidence dry-up — a conditional library
            // gets re-scoped, not deleted.
            const transitionReason = derived === 'retired'
                ? (isStaleByRegime(meta, trade.analysis?.coinName) ? 'regime-shifted' : 'insufficient-evidence')
                : evalOverrideDemotion
                    ? `eval hurts ×${meta.evalStreak} (evidence)`
                    : 'evidence';
            stampStatusTransition(
                meta,
                derived,
                transitionReason,
            );
            meta.status = derived;
        }
        await updateMemoryFileUnlocked(file.id, {
            content: serializeSkill(meta, titleFromMeta(meta)),
            enabled: skillEnabledFlag(meta),
        }, username);

        // Refinement gate: 3 consecutive losses AND spread over >=48h.
        // The LLM round-trip is NOT run here — this loop holds the notebook
        // write lock, and a refinement can take tens of seconds, stalling
        // every other writer. Collect the target; the serialized wrapper
        // runs refineSkillNow (LLM OUTSIDE the lock, write phase inside)
        // once the lock is released.
        if (trade.outcome === TradeOutcome.LOSS
            && meta.status === 'confirmed'
            && meta.consecutiveLosses >= REFINE_AFTER_CONSECUTIVE_LOSSES
            && lossesSpanEnoughHours(allTrades ?? [trade], meta.tradeIds, REFINE_MIN_SPAN_HOURS)) {
            refineTargets.push(file.id);
        }
    }
    return refineTargets;
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService.
 *  The evidence pass itself holds the lock; the refinement LLM phase it can
 *  trigger deliberately runs AFTER the lock releases (refineSkillNow's own
 *  read-craft-write split), so a slow provider cannot block the notebook. */
export const applySkillEvidence = async (
    trade: LoggedTrade,
    username: string,
    allTrades?: LoggedTrade[],
): Promise<void> => {
    const refineTargets = await withNotebookWriteLock(
        () => applySkillEvidenceUnlocked(trade, username, allTrades),
    );
    for (const fileId of refineTargets) {
        try {
            // refineSkillNow re-reads the file (evidence that landed while the
            // lock was free is preserved) and enters the shadow only under the
            // lock. Best-effort like the old inline path: any failure keeps
            // the existing skill untouched.
            await refineSkillNow(fileId, allTrades ?? [trade], username);
        } catch (e) {
            console.warn('[SkillMemory] Refinement pass failed (skill kept):', e);
        }
    }
};

export interface SkillCorrectionReconciliation {
    /** Slugs whose record moved to the corrected outcome. */
    reconciled: string[];
    /** Skills that named the trade but could not be reconciled, with the why. */
    skipped: Array<{ slug: string; reason: string }>;
}

const reconcileSkillsAfterOutcomeCorrectionUnlocked = async (
    corrected: LoggedTrade,
    username: string,
): Promise<SkillCorrectionReconciliation> => {
    const result: SkillCorrectionReconciliation = { reconciled: [], skipped: [] };
    const from = corrected.correctedFrom;
    const to = corrected.outcome;
    const settled = (outcome: TradeOutcome | undefined): outcome is TradeOutcome.WIN | TradeOutcome.LOSS =>
        outcome === TradeOutcome.WIN || outcome === TradeOutcome.LOSS;
    // A correction between two SETTLED classes is the case this owns. A row
    // that enters or leaves WIN/LOSS was never folded (the evidence pass skips
    // it), so its arithmetic is a different operation and is not invented here.
    if (!settled(from) || !settled(to) || from === to) return result;
    const fromClass: CorrectionOutcome = from === TradeOutcome.WIN ? 'WIN' : 'LOSS';
    const toClass: CorrectionOutcome = to === TradeOutcome.WIN ? 'WIN' : 'LOSS';

    for (const file of getMemoryFiles().files.filter(isSkillFile)) {
        const meta = parseSkillMarkdown(file.content);
        if (!meta) continue;
        const followed = meta.tradeIds.includes(corrected.id);
        const control = meta.controlIds?.includes(corrected.id) ?? false;
        if (!followed && !control) {
            if (meta.overriddenIds?.includes(corrected.id)) {
                result.skipped.push({
                    slug: file.name.replace(/\.md$/i, ''),
                    reason: 'the skill was injected and ignored; its outcome never counted',
                });
            }
            continue;
        }
        const indexFromEnd = followed
            ? meta.tradeIds.length - meta.tradeIds.indexOf(corrected.id)
            : 1;
        applyOutcomeCorrection(meta, {
            kind: followed ? 'followed' : 'control',
            from: fromClass,
            to: toClass,
            indexFromEnd,
            regime: followed ? corrected.marketRegime : undefined,
        });
        meta.modifiedAt = new Date().toISOString();
        await updateMemoryFileUnlocked(file.id, {
            content: serializeSkill(meta, titleFromMeta(meta)),
            enabled: skillEnabledFlag(meta),
        }, username);
        result.reconciled.push(file.name.replace(/\.md$/i, ''));
    }
    return result;
};

/**
 * Move the skills that counted a trade to its corrected outcome.
 *
 * The trade row keeps the correction (`correctedFrom`/`correctedAt`); this
 * updates the durable FOLD that was made from the old class. It moves the
 * win/loss counters, the recent-outcomes tail, the streak and the regime
 * split — never the R sums, which the correction does not change — and it
 * never queues a proposal or refines a rule: a repair is not a learning pass.
 */
export const reconcileSkillsAfterOutcomeCorrection = async (
    corrected: LoggedTrade,
    username: string,
): Promise<SkillCorrectionReconciliation> =>
    withNotebookWriteLock(() => reconcileSkillsAfterOutcomeCorrectionUnlocked(corrected, username));

export interface SkillRevisionResult {
    ok: boolean;
    slug?: string;
    error?: string;
}

/**
 * Apply a model revision to an existing skill DIRECTLY (owner ruling
 * 2026-10-29: the model creates/revises candidates without an approval queue).
 * Status and evidence are untouched — the evidence fold remains the only thing
 * that promotes or retires. The trigger is validated with the same bar a draft
 * passes, so a revision cannot smuggle in a generic one.
 */
export const applySkillRevisionDirect = async (
    slug: string,
    clauses: { when?: string; body?: string; predicate?: string; description?: string },
    reason: string,
    username: string,
): Promise<SkillRevisionResult> => withNotebookWriteLock(async () => {
    const file = getMemoryFiles().files.filter(isSkillFile).find(
        f => f.name.replace(/\.md$/i, '').toLowerCase() === slug.toLowerCase(),
    );
    if (!file) return { ok: false, error: `no skill "${slug}"` };
    const meta = parseSkillMarkdown(file.content);
    if (!meta) return { ok: false, error: 'the skill file did not parse' };
    const next: SkillMeta = {
        ...meta,
        ...(clauses.when ? { when: clauses.when } : {}),
        ...(clauses.body ? { body: clauses.body } : {}),
        ...(clauses.description ? { description: clauses.description } : {}),
        ...(clauses.predicate ? { predicate: sanitizePredicate(clauses.predicate) } : {}),
    };
    const bad = validateTrigger({ when: next.when ?? '' });
    if (bad) return { ok: false, error: bad };
    next.modifiedAt = new Date().toISOString();
    if (reason.trim()) next.reason = reason.trim().slice(0, 500);
    await updateMemoryFileUnlocked(file.id, {
        content: serializeSkill(next, titleFromMeta(next)),
        enabled: skillEnabledFlag(next),
    }, username);
    return { ok: true, slug: file.name.replace(/\.md$/i, '') };
});

/** Age of the freshest recorded evidence in days (Infinity when unknown). */
const evidenceAgeDays = (meta: SkillMeta): number => {
    if (!meta.lastEvidenceAt) return Infinity;
    const t = Date.parse(meta.lastEvidenceAt);
    return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : Infinity;
};

/**
 * Age-band evidence decay: every FULL 30-day band of staleness halves the
 * counts once, up to EVIDENCE_DECAY_MAX_HALVINGS — a 3-year-old record no
 * longer reads the same as a 31-day-old one (the old code halved exactly
 * once regardless of age). A skill with no recorded evidence age is NOT
 * decayed (unknown ≠ infinitely stale — freshly-minted and legacy rows
 * keep their earned counts until the first real timestamp lands). The
 * regime-mismatch halving was REMOVED :
 * a skill that works in one regime and fails in another is conditional, not
 * fading — regimeStats + the re-scope proposal handle that case without
 * erasing the skill's earned authority. `incomingRegime` is kept in the
 * signature for call-site stability. Mutates `meta` before the new outcome
 * is counted. Callers must only run this on FOLLOWED evidence — a CONTROL
 * or OVERRIDDEN trade must not erode the skill's authority.
 */
export const applyEvidenceDecay = (meta: SkillMeta, incomingRegime?: string): void => {
    void incomingRegime;
    const age = evidenceAgeDays(meta);
    if (!Number.isFinite(age) || age <= EVIDENCE_STALE_DAYS) return;
    const halvings = Math.min(Math.floor(age / EVIDENCE_STALE_DAYS), EVIDENCE_DECAY_MAX_HALVINGS);
    if (halvings > 0) halveCounts(meta, halvings);
};

export const EVIDENCE_STALE_DAYS = 30;

/** Cap for {@link applyEvidenceDecay}: at most 3 halvings (→ ⅛ of the
 *  lifetime record) per counting pass, so a very old skill fades hard but
 *  is never erased in one step — demotion, not death, stays true. */
export const EVIDENCE_DECAY_MAX_HALVINGS = 3;

/** Injected-and-ignored observations that justify an amendment proposal. */
export const OVERRIDE_RATE_FOR_AMENDMENT = 3;

/**
 * Divergence test: one regime carries ≥3W/≤1L while another carries
 * ≥3L/≤1W. Returns [strongRegime, weakRegime] or null.
 */
export const findRegimeDivergence = (
    stats: Record<string, { w: number; l: number }> | undefined,
): [string, string] | null => {
    if (!stats) return null;
    const strong = Object.entries(stats).filter(([, v]) => v.w >= 3 && v.l <= 1);
    const weak = Object.entries(stats).filter(([, v]) => v.l >= 3 && v.w <= 1);
    if (strong.length === 0 || weak.length === 0) return null;
    // Most-supported vs most-contradicted.
    strong.sort((a, b) => b[1].w - a[1].w);
    weak.sort((a, b) => b[1].l - a[1].l);
    return [strong[0][0], weak[0][0]];
};

/**
 * When the per-regime split diverges, the skill gets SHARPER, not weaker:
 * queue a re-scope proposal ("narrow appliesWhen to <strong regime>") into
 * the learning queue. Deduped by fingerprint — the same divergence is not
 * re-queued every trade.
 */
const maybeQueueRescopeProposal = (fileName: string, meta: SkillMeta, username: string): void => {
    const div = findRegimeDivergence(meta.regimeStats);
    if (!div) return;
    const [strong, weak] = div;
    if (meta.regime === strong) return; // already scoped to the winning regime
    queueLearningProposal({
        kind: 'rescope',
        skillSlug: fileName.replace(/\.md$/i, ''),
        text: `${fileName} wins ${meta.regimeStats![strong]!.w}/${meta.regimeStats![strong]!.w + meta.regimeStats![strong]!.l} in ${strong} but loses ${meta.regimeStats![weak]!.l}/${meta.regimeStats![weak]!.w + meta.regimeStats![weak]!.l} in ${weak} — narrow its scope to ${strong} instead of letting mixed evidence fade it.`,
        fingerprint: `${fileName}|rescope|${strong}`,
    }, username);
};

/** Halve wins/losses n times (floor at 0). Keeps sample math consistent. */
export const halveCounts = (meta: SkillMeta, times: number): void => {
    for (let i = 0; i < times; i++) {
        meta.wins = Math.floor(meta.wins / 2);
        meta.losses = Math.floor(meta.losses / 2);
        // The birth cluster decays WITH the record it belongs to. Left fixed,
        // it becomes a ratchet: 8 birth wins halved to wins=1 still subtracted
        // 8, so followed evidence floored at 0 and the skill had to re-earn its
        // entire birth cluster before a single followed sample existed — and
        // every later 90-day silence re-halved it again, leaving a stale skill
        // that could be neither promoted nor auto-retired.
        if (meta.birthEvidence) {
            meta.birthEvidence = {
                ...meta.birthEvidence,
                wins: Math.floor(meta.birthEvidence.wins / 2),
                losses: Math.floor(meta.birthEvidence.losses / 2),
                clusterSize: Math.floor(meta.birthEvidence.clusterSize / 2),
            };
        }
        // The expectancy pair decays with the record it belongs to, or a skill
        // would keep quoting an average earned from evidence that no longer
        // counts. Halving both keeps netR/rSampled stable while shrinking the
        // sample; once the sample floors to 0 the pair is dropped entirely
        // rather than left reporting a lone 0R.
        if (meta.rSampled) {
            const sampledBefore = meta.rSampled;
            meta.rSampled = Math.floor(sampledBefore / 2);
            if (meta.rSampled > 0) {
                // Scale the SUM by the count actually retained. Flooring the
                // count alone silently RAISES the quoted average: 8R over 9
                // reads +0.89R, and halving to 4R over 4 would quote +1.00R
                // from evidence that just lost half its authority.
                const net = meta.netR ?? 0;
                meta.netR = round4(net * (meta.rSampled / sampledBefore));
                // The GROSS sum decays with the same sample — it is the same
                // evidence, so leaving it behind would report a gross figure
                // earned from twice the authority the net figure has.
                if (meta.grossR !== undefined) {
                    meta.grossR = round4(meta.grossR * (meta.rSampled / sampledBefore));
                }
            } else {
                meta.netR = undefined;
                meta.grossR = undefined;
                meta.netRKnown = undefined;
                meta.netRUnknown = undefined;
                meta.rSampled = undefined;
            }
        }
    }
};

/**
 * True when the last N losing trades for this skill span at least `minHours`
 * between first and last. Whipsaw losses inside one session don't trigger
 * LLM rewrites.
 */
export const lossesSpanEnoughHours = (
    allTrades: LoggedTrade[],
    tradeIds: string[],
    minHours: number,
): boolean => {
    const idSet = new Set(tradeIds);
    const stamps = allTrades
        .filter(t => idSet.has(t.id) && t.outcome === TradeOutcome.LOSS)
        .map(t => Date.parse(t.timestamp || ''))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (stamps.length < REFINE_AFTER_CONSECUTIVE_LOSSES) return false;
    const window = stamps.slice(-REFINE_AFTER_CONSECUTIVE_LOSSES);
    return (window[window.length - 1] - window[0]) >= minHours * 3_600_000;
};

/**
 * LLM phase of skill refinement — resolves the memory model, feeds the
 * losing post-mortems back to it, and returns the tightened skill (or null
 * when nothing should change). Performs NO notebook writes, so it is safe
 * to run outside the write lock.
 */
const craftRefinement = async (
    meta: SkillMeta,
    allTrades: LoggedTrade[],
    username: string,
): Promise<CraftedSkill | null> => {
    const config = await resolveMemoryConfig(username);
    if (!config) return null;
    const losingTrades = allTrades
        .filter(t => t.outcome === TradeOutcome.LOSS && meta.tradeIds.includes(t.id))
        .slice(-4);
    return refineSkillFromLosses({
        title: titleFromMeta(meta),
        kind: meta.kind,
        when: meta.when,
        body: meta.body,
        wins: meta.wins,
        losses: meta.losses,
    }, losingTrades, config);
};

/**
 * Write phase of skill refinement — MUST run under the notebook write lock.
 * Re-reads the skill so evidence that landed during the LLM round-trip is
 * Preserved. the refined version does NOT swap into the live slot —
 * it enters an eval-only SHADOW while the prior version keeps the injection
 * slot for SHADOW_WINDOW_TRADES matched trades. A panicked refinement after
 * a bad-luck streak used to replace a good skill with a worse one,
 * undetectably; the shadow window is the detection. Returns false when the
 * file vanished meanwhile.
 */
const applyRefinementUnlocked = async (
    fileId: string,
    refined: CraftedSkill,
    username: string,
): Promise<boolean> => {
    const file = getMemoryFiles().files.find(f => f.id === fileId);
    const latest = file ? parseSkillMarkdown(file.content) : null;
    if (!latest) return false;
    // A second refinement while one is already shadowing replaces the
    // shadow (the newest draft is the better guess), never the live slot.
    latest.shadow = {
        kind: refined.kind,
        when: refined.when,
        body: formatCraftedSkillBody(refined),
        name: refined.name,
        startedAt: new Date().toISOString(),
        seen: 0,
        wins: 0,
        losses: 0,
    };
    latest.consecutiveLosses = 0;
    latest.refinedAt = new Date().toISOString();
    latest.modifiedAt = latest.refinedAt;
    await updateMemoryFileUnlocked(fileId, {
        content: serializeSkill(latest, titleFromMeta(latest)),
        enabled: skillEnabledFlag(latest),
    }, username);
    return true;
};

/**
 * Shadow verdict at window close. The shadow is never injected, so
 * both versions faced identical outcomes — the only honest comparison is
 * the incumbent's record INSIDE the window: if the live trigger kept
 * losing (worse than the kind's coin-flip band), the tightened refinement
 * earned the slot; if the live version held up, the rewrite was an
 * overfit reaction to bad luck and gets discarded with a harness wire lesson.
 */
export const settleShadow = (
    meta: SkillMeta,
    windowEvidence: { wins: number; losses: number },
): { promoted: boolean; discarded: boolean; lesson?: string } => {
    const shadow = meta.shadow;
    if (!shadow || shadow.seen < SHADOW_WINDOW_TRADES) return { promoted: false, discarded: false };
    const sample = windowEvidence.wins + windowEvidence.losses;
    const winRate = sample > 0 ? windowEvidence.wins / sample : 0.5;
    const incumbentStruggled = meta.kind === 'avoid' ? winRate > 0.6 : winRate < 0.4;
    if (incumbentStruggled) {
        return { promoted: true, discarded: false };
    }
    return {
        promoted: false,
        discarded: true,
        lesson: `refinement of a ${meta.kind} skill sat in shadow for ${shadow.seen} matched trades while the live version held ${windowEvidence.wins}W/${windowEvidence.losses}L — the rewrite was not needed (refinement overfit).`,
    };
};

/**
 * Act on the worth-gate's 'merge' verdict. Previously the
 * second-most-useful gate outcome was DROPPED silently — overlaps festered
 * until consolidateSkills destroyed the extras. The named target skill is
 * tightened with the same refine pass used for consecutive-loss skills, fed
 * the cluster's losing post-mortems as falsifying evidence (an all-win
 * cluster skips the LLM call — nothing was falsified — and just folds the
 * extra evidence into the target).
 */
const maybeMergeSkillUnlocked = async (
    mergeTarget: string,
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
): Promise<void> => {
    try {
        const key = clusterKey(trade);
        const cluster = allTrades.filter(t =>
            (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS) && clusterKey(t) === key
        );
        const needle = mergeTarget.trim().toLowerCase().replace(/\.md$/i, '');
        const file = getMemoryFiles().files.filter(isSkillFile).find(f => {
            const stem = f.name.replace(/\.md$/i, '').toLowerCase();
            const m = parseSkillMarkdown(f.content);
            return stem === needle || (m ? titleFromMeta(m).toLowerCase() === needle : false);
        });
        const meta = file ? parseSkillMarkdown(file.content) : null;
        if (!file || !meta) {
            // Target vanished between the gate and now — fall back to create
            // so the gate's work still lands somewhere useful.
            await maybeUpsertSkillUnlocked(trade, allTrades, username);
            return;
        }
        const foldEvidence = (): void => {
            if (!latestMeta.tradeIds.includes(trade.id)) {
                // countTradeOutcome FIRST — the evidence counter's legacy
                // floor reads the pre-append tradeIds length. Merge folds
                // used to bump W/L only, so alpha-decay never saw this
                // evidence and the provenance counter missed it too.
                countTradeOutcome(latestMeta, trade.outcome === TradeOutcome.WIN, trade.realizedR, { netR: trade.netR, stopDistancePct: tradeStopDistancePct(trade) });
                latestMeta.tradeIds = [...latestMeta.tradeIds, trade.id];
                // Merge-driven transitions ride the temporal ledger like every
                // other path so skillStatusAt replay sees them. Stamp BEFORE
                // assigning: stampStatusTransition no-ops once meta.status
                // already equals the next status.
                const derived = deriveStatus(latestMeta, controlStatsFrom(latestMeta, allTrades));
                stampStatusTransition(latestMeta, derived, 'worth-gate merge');
                latestMeta.status = derived;
            }
        };
        let latestMeta = meta;
        const losers = cluster.filter(t => t.outcome === TradeOutcome.LOSS);
        const config = await resolveMemoryConfig(username);
        if (config && losers.length > 0) {
            const refined = await refineSkillFromLosses({
                title: titleFromMeta(meta),
                kind: meta.kind,
                when: meta.when,
                body: meta.body,
                wins: meta.wins,
                losses: meta.losses,
            }, losers.slice(-4), config);
            // Re-read after the LLM round-trip — evidence may have landed meanwhile.
            const latestFile = getMemoryFiles().files.find(f => f.id === file.id);
            const latest = latestFile ? parseSkillMarkdown(latestFile.content) : null;
            if (latest && refined) {
                // Merge-driven refinements enter the shadow too —
                // the live trigger keeps its slot until the window settles.
                latest.shadow = {
                    kind: refined.kind,
                    when: refined.when,
                    body: formatCraftedSkillBody(refined),
                    name: refined.name,
                    startedAt: new Date().toISOString(),
                    seen: 0,
                    wins: 0,
                    losses: 0,
                };
                latest.refinedAt = new Date().toISOString();
                latestMeta = latest;
            }
        }
        foldEvidence();
        latestMeta.modifiedAt = new Date().toISOString();
        await updateMemoryFileUnlocked(file.id, {
            content: serializeSkill(latestMeta, titleFromMeta(latestMeta)),
            enabled: skillEnabledFlag(latestMeta),
        }, username);
        console.log('[SkillMemory] Worth-gate merge applied to', file.name);
    } catch (e) {
        console.warn('[SkillMemory] Worth-gate merge failed:', e);
    }
};

export const maybeMergeSkill = (
    mergeTarget: string,
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
): Promise<void> =>
    withNotebookWriteLock(() => maybeMergeSkillUnlocked(mergeTarget, trade, allTrades, username));

/**
 * User-triggered refinement from the dashboard. Runs the same LLM tighten
 * pass the automatic 3-loss gate uses, on demand — closes the loop for
 * 'refine' recommendations that would otherwise render as dead-end rows.
 * Resolves FALSE when nothing changed (no provider / LLM declined) so the
 * dashboard doesn't toast success on a no-op.
 *
 * The LLM round-trip runs OUTSIDE the notebook write lock — it can take
 * tens of seconds and must not block every other notebook writer (evidence
 * sync, post-mortem ingestion, UI edits). Only the re-read-and-write phase
 * holds the lock.
 */
export const refineSkillNow = async (
    fileId: string,
    allTrades: LoggedTrade[],
    username: string,
): Promise<boolean> => {
    const file = getMemoryFiles().files.find(f => f.id === fileId);
    const meta = file ? parseSkillMarkdown(file.content) : null;
    if (!meta) return false;
    let refined: CraftedSkill | null;
    try {
        refined = await craftRefinement(meta, allTrades, username);
    } catch (e) {
        console.warn('[SkillMemory] On-demand refinement failed (skill kept):', e);
        return false;
    }
    if (!refined) return false;
    const result = refined;
    return withNotebookWriteLock(() => applyRefinementUnlocked(fileId, result, username));
};

/**
 * One-sentence semantic summary for a new skill (zcode memory pattern).
 * Prefers the validated trigger; falls back to the extracted lesson.
 * Kept to one line — it feeds index lines and LLM judges, not essays.
 * Returns '' when there is no claim at all (no clause, no lesson) — a
 * scope-only description is content-free, and callers refuse to persist it.
 */
const buildSkillDescription = (
    kind: SkillKind,
    setup: { coin?: string; direction?: string; family?: string; regime?: string },
    when?: string,
    lesson?: string,
): string => {
    const scope = [setup.coin, setup.direction, setup.family, setup.regime].filter(Boolean).join(' ');
    const claim = when?.replace(/\s+/g, ' ').trim() || lesson?.replace(/\s+/g, ' ').trim() || '';
    if (!claim) return '';
    const verb = kind === 'avoid' ? 'Avoid:' : 'Repeat:';
    return `${verb} ${claim} — learned from ${scope || 'matching setups'}.`.replace(/\s+/g, ' ').slice(0, 280);
};

/**
 * Create a skill when a similar cluster reaches MIN_CLUSTER_FOR_SKILL and
 * no matching skill exists yet. Evidence-gated — not a free-form LLM spawn.
 */
const maybeUpsertSkillUnlocked = async (
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
    // The worth-gate's JUDGED trigger rides through so the persisted
    // skill matches the artifact that was validated.
    preferredClause?: { when?: string; prediction?: SkillPrediction },
): Promise<MemoryFile | null> => {
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return null;
    if (!tradeAdmitsTechnicalStrategyRule(trade)) return null;
    await ensureHarnessFoldersUnlocked(username);
    const key = clusterKey(trade);
    const cluster = allTrades.filter(t =>
        (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS) && clusterKey(t) === key
    );
    if (cluster.length < MIN_CLUSTER_FOR_SKILL) return null;

    const setup = {
        coin: trade.analysis?.coinName,
        direction: trade.analysis?.direction === 'Neutral' ? undefined : trade.analysis?.direction,
        family: trade.analysis?.detectedPatternFamily,
        pattern: trade.analysis?.marketConditions?.pattern,
        regime: trade.marketRegime,
    };
    const existing = getMemoryFiles().files.filter(isSkillFile).some(f => {
        const meta = parseSkillMarkdown(f.content);
        return meta ? skillMatchesSetup(meta, setup) : false;
    });
    if (existing) return null;

    const wins = cluster.filter(t => t.outcome === TradeOutcome.WIN).length;
    const losses = cluster.filter(t => t.outcome === TradeOutcome.LOSS).length;
    // Trailing-loss streak (cluster sorted oldest → newest).
    const ordered = [...cluster].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let streak = 0;
    for (let i = ordered.length - 1; i >= 0 && ordered[i].outcome === TradeOutcome.LOSS; i--) streak++;
    const kind: SkillKind = losses >= wins ? 'avoid' : 'repeat';
    // Prefer the trigger the worth-gate JUDGED over whatever re-parsing the
    // raw post-mortem produces now — validated ≠ persisted was a silent
    // mismatch before. The ACTION still comes from the prose clause; it lives
    // in the body, not in a skill field.
    const parsed = parseLessonClauses(trade.postMortem ?? '')[0];
    const whenText = (preferredClause?.when || parsed?.when || '').trim();
    const procedure = whenText && parsed?.action
        ? formatSkillProcedure({ when: whenText, action: parsed.action })
        : '';
    // Never silently re-create a retired twin. An archive match drafts
    // a REVIVAL review card instead of a fresh skill — the graveyard is how
    // the system remembers what didn't work.
    if (whenText) {
        const twin = findArchiveTwin(username, whenText);
        if (twin) {
            queueRevivalProposal(username, twin);
            return null;
        }
    }
    const lesson = procedure || extractLessonFromPostMortem(trade.postMortem ?? '');
    // No clause AND no extractable lesson = no actual claim about the
    // market. Cluster statistics alone do not form a procedure, and
    // fabricating a boilerplate one here is exactly the junk the
    // worth-gate exists to prevent — refuse to write the skill.
    if (!lesson) return null;
    const meta: SkillMeta = {
        status: 'candidate',
        kind,
        // One-sentence semantic summary (zcode pattern): derived from the
        // clauses when present, else the scope + procedure. The worth-gate's
        // judged clause is the best source — it was validated, not parsed.
        description: buildSkillDescription(kind, setup, whenText, lesson),
        originMessageId: trade.id,
        coin: trade.analysis?.coinName,
        direction: setup.direction,
        family: trade.analysis?.detectedPatternFamily,
        regime: trade.marketRegime,
        // Controlled strategy-family vocabulary: the analysis's explicit
        // family when it carries one, else classify the free-text strategy.
        strategyFamily: trade.analysis?.strategyFamily
            ?? classifyStrategyFamily(trade.analysis?.strategy),
        wins,
        losses,
        consecutiveLosses: streak,
        tradeIds: cluster.map(t => t.id),
        // The whole cluster's evidence is counted at birth — record the
        // true total now, before tradeIds gets tail-capped by serialize.
        evidenceCount: cluster.length,
        // …and record it SEPARATELY too, so promotion maths can tell the
        // cluster (which authored this trigger) from outcomes observed after
        // injection. Without this a cluster of 8 wins born the skill
        // `confirmed` on its own co-occurrence.
        birthEvidence: { wins, losses, clusterSize: cluster.length, at: new Date().toISOString() },
        when: whenText || undefined,
        // Birth certificate: the worth-gate's judged claim when it
        // carried one, else the deterministic default from the cluster's
        // scope. Every new skill leaves with a falsifiable prediction.
        prediction: preferredClause?.prediction ?? defaultPrediction({
            coin: setup.coin,
            family: setup.family,
            regime: setup.regime,
        }),
        body: procedure
            ? lesson
            : [
                `**Trigger:** ${[setup.coin, setup.direction, setup.family].filter(Boolean).join(' · ') || 'matching setup'}`,
                `**Procedure:** ${lesson}`,
                `**Invalidates:** thesis break or a different regime than ${setup.regime || 'the one that produced this cluster'}.`,
            ].join('\n'),
    };
    meta.status = deriveStatus(meta);

    const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
    if (!folder) return null;
    const content = serializeSkill(meta, titleFromMeta(meta));
    const created = await createMemoryFileUnlocked(folder.id, fileNameFromMeta(meta), content, username, true);
    // The worth-gate judged this clause — count it as a gate approval
    // so weekly meta-calibration can measure how many approvals confirm.
    if (created && preferredClause?.when) {
        void recordWorthGateApproval(username, preferredClause.when);
    }
    return created;
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService. */
export const maybeUpsertSkill = (
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
    // The worth-gate's JUDGED trigger rides through the locked wrapper so
    // callers can persist the validated artifact.
    preferredClause?: { when?: string; prediction?: SkillPrediction },
): Promise<MemoryFile | null> =>
    withNotebookWriteLock(() => maybeUpsertSkillUnlocked(trade, allTrades, username, preferredClause));

/**
 * The body contract an IMPORTED file must meet, applied to a DRAFTED skill.
 *
 * `skillBodyCaps` and the Use-when check ran only inside `SkillImportService`,
 * so a model-authored proposal — or a post-mortem craft — could be approved
 * with a body and a description no import would have accepted. Both ingest
 * paths below write the same format, so the rule lives here, once, and both
 * call it: over the hard cap REFUSES (nothing written, draft kept), over the
 * soft cap and a description with no trigger WARN, exactly as an import does.
 */
const craftedBodyGate = (crafted: CraftedSkill, where: string): { overHard: boolean; body: string; message?: string } => {
    const body = formatCraftedSkillBody(crafted);
    const caps = skillBodyCaps(body);
    if (caps.overHard) {
        return {
            overHard: true, body,
            message: `body is ${caps.chars.toLocaleString()} chars — over the 100k hard cap; move material into references/ and try again`,
        };
    }
    if (caps.overSoft) {
        console.warn(`[Skills] ${where}: ${caps.lines} lines is over the ~200-line soft cap — long material belongs in a bundled references/ file`);
    }
    const description = (crafted.description || defaultDescription(crafted) || '').trim();
    if (!hasUseWhenTrigger(description)) {
        console.warn(`[Skills] ${where}: the description has no "Use when" trigger — it is the activation key, and a vague one rarely activates`);
    }
    return { overHard: false, body };
};

const ingestCraftedSkillUnlocked = async (
    trade: LoggedTrade,
    crafted: CraftedSkill,
    username: string,
    /** P0-1: who approved this write. A human pressing Save on a post-mortem
     *  draft IS consent — without this the trade-backed skill fails
     *  `isApprovedSkill` and silently never injects. Auto-ingest callers omit
     *  it and stay fail-closed, as before. */
    approvedBy?: 'human',
): Promise<void> => {
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return;
    if (!tradeAdmitsTechnicalStrategyRule(trade)) return;
    // Before anything is read, queued or written: a body over the hard cap is
    // refused here too, so the two ingests cannot disagree about what a skill
    // is allowed to be. The caller's read-back reports the miss and keeps the
    // draft; the log line says which rule refused it.
    const gate = craftedBodyGate(crafted, `craft "${crafted.name || crafted.kind}"`);
    if (gate.overHard) {
        console.warn(`[Skills] craft refused: ${gate.message}`);
        return;
    }
    await ensureHarnessFoldersUnlocked(username);
    const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
    if (!folder) return;
    const setupDir = trade.analysis?.direction === 'Long' || trade.analysis?.direction === 'Short'
        ? trade.analysis.direction
        : undefined;
    const existing = getMemoryFiles().files.filter(isSkillFile).find(f => {
        const meta = parseSkillMarkdown(f.content);
        return meta?.when?.toLowerCase() === crafted.when.toLowerCase();
    });
    // Retired twin → REVIVAL card, not a duplicate birth.
    const twin = findArchiveTwin(username, crafted.when);
    if (twin) {
        queueRevivalProposal(username, twin);
        return;
    }
    const kind = crafted.kind;
    if (existing) {
        const meta = parseSkillMarkdown(existing.content);
        if (!meta) return;
        if (!meta.tradeIds.includes(trade.id)) {
            // Full accounting (decay window + evidence counter included) —
            // the craft path used to bump raw counters only.
            countTradeOutcome(meta, trade.outcome === TradeOutcome.WIN, trade.realizedR, { netR: trade.netR, stopDistancePct: tradeStopDistancePct(trade) });
            meta.tradeIds = [...meta.tradeIds, trade.id];
        }
        meta.kind = kind;
        meta.when = crafted.when;
        // The rewrite contract (see requestRewriteApproval): an approved rule
        // that gets a NEW trigger/body/predicate loses the yes it earned — the
        // approval was for the rule as it read. Re-ingesting the SAME craft
        // (same trade, unchanged trigger and body) must not un-approve, so the
        // withdrawal fires only when the rule actually changes.
        const ruleChanges =
            meta.when !== crafted.when
            || meta.body !== gate.body
            || meta.predicate !== sanitizePredicate(crafted.predicate);
        if (ruleChanges && isApprovedSkill(meta)) {
            requestRewriteApproval(meta,
                { when: crafted.when, body: gate.body },
                {
                    slug: existing.name.replace(/\.md$/i, ''),
                    username,
                    source: 'closed-trade craft',
                    evidence: `settled ${trade.outcome} ${trade.realizedR != null ? `(${trade.realizedR}R)` : ''} on ${trade.id}`,
                });
        }
        // Overwritten, never merged: a predicate describes its trigger, so
        // rewriting the trigger invalidates any predicate the old one carried.
        meta.predicate = sanitizePredicate(crafted.predicate);
        // The third writer of this format. The draft path stamps these and the
        // trade-backed birth path was taught to (5d7332a6); re-ingesting a
        // matching trigger still dropped them, so the reason a human reads and
        // the timeframe/source the replay proof needs went missing on exactly
        // the updates that carried new evidence.
        if (crafted.reason?.trim()) meta.reason = crafted.reason.trim().slice(0, 600);
        if (crafted.timeframe) meta.timeframe = crafted.timeframe;
        if (crafted.source) meta.source = crafted.source;
        // A skill that never had the activation key gains it here; one that
        // has one keeps its own — a merge must not overwrite a description
        // the trader has already seen with the craft's new prose.
        if (!meta.description && crafted.description) meta.description = crafted.description;
        // A legacy skill updated through the craft path gains its birth
        // certificate here if it never had one.
        if (!meta.prediction) {
            meta.prediction = crafted.prediction ?? defaultPrediction({
                coin: trade.analysis?.coinName,
                family: trade.analysis?.detectedPatternFamily,
                regime: trade.marketRegime,
            });
        }
        meta.body = gate.body;
        meta.status = deriveStatus(meta);
        await updateMemoryFileUnlocked(existing.id, {
            content: serializeSkill(meta, crafted.name || titleFromMeta(meta)),
            enabled: skillEnabledFlag(meta),
        }, username);
        return;
    }
    const description = (crafted.description || defaultDescription(crafted) || '').trim().slice(0, 1024) || undefined;
    const meta: SkillMeta = {
        status: 'candidate',
        kind,
        coin: trade.analysis?.coinName,
        direction: setupDir,
        family: trade.analysis?.detectedPatternFamily,
        regime: trade.marketRegime,
        ...(description ? { description } : {}),
        wins: trade.outcome === TradeOutcome.WIN ? 1 : 0,
        losses: trade.outcome === TradeOutcome.LOSS ? 1 : 0,
        consecutiveLosses: trade.outcome === TradeOutcome.LOSS ? 1 : 0,
        tradeIds: [trade.id],
        // P0-1: a human-approved Save carries its consent into the row so
        // `isApprovedSkill` sees it. Auto-ingest (no approvedBy) keeps the
        // fail-closed behavior — status/evidence alone are not consent.
        ...(approvedBy ? { approvedBy, approvedAt: new Date().toISOString() } : {}),
        // The draft-backed writer stamps these (see `reason` there); a second
        // writer of the same format that omits them is how the field would go
        // missing for exactly the drafts a post-mortem produces.
        ...(crafted.reason?.trim() ? { reason: crafted.reason.trim().slice(0, 600) } : {}),
        ...(crafted.timeframe ? { timeframe: crafted.timeframe } : {}),
        ...(crafted.source ? { source: crafted.source } : {}),
        when: crafted.when,
        predicate: sanitizePredicate(crafted.predicate),
        prediction: crafted.prediction ?? defaultPrediction({
            coin: trade.analysis?.coinName,
            family: trade.analysis?.detectedPatternFamily,
            regime: trade.marketRegime,
        }),
        body: gate.body,
    };
    meta.status = deriveStatus(meta);
    const slug = slugifyName(crafted.name) || slugifyName([trade.analysis?.coinName, kind].filter(Boolean).join(' ')) || 'skill';
    await createMemoryFileUnlocked(folder.id, `${slug}.md`, serializeSkill(meta, crafted.name || titleFromMeta(meta)), username, true);
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService. */
export const ingestCraftedSkill = (
    trade: LoggedTrade,
    crafted: CraftedSkill,
    username: string,
    approvedBy?: 'human',
): Promise<void> =>
    withNotebookWriteLock(() => ingestCraftedSkillUnlocked(trade, crafted, username, approvedBy));

/**
 * Ingest a user-approved skill draft that has NO closed trade behind it
 * (verdict-sourced drafts). Starts as a zero-evidence candidate — it must
 * earn wins/losses through applySkillEvidence before it can confirm.
 * `prior: 'gated'` is what lets it into the prompt at all: see the field doc.
 */
/**
 * What an ingest actually did.
 *
 * Both ingest functions used to resolve `void`, which made "the skills folder
 * does not exist", "this trigger is already a live skill" and "a file was
 * written" three indistinguishable outcomes to every caller — and the caller
 * holding them was about to tell a human their proposal had been saved.
 */
export type SkillIngestResult =
    | { created: true; slug: string }
    | { created: false; reason: 'duplicate'; slug: string }
    | { created: false; reason: 'no-skills-folder' }
    /** The body is over the 100k hard cap every import must meet. Nothing was
     *  written; `detail` names the size so the human can act on it. */
    | { created: false; reason: 'over-hard-cap'; detail: string };

const ingestCraftedSkillFromDraftUnlocked = async (
    crafted: CraftedSkill,
    coin: string | undefined,
    username: string,
    /** The approver's one-line reason (the supervisor's verdict). Persisted
     *  onto the skill — see SkillMeta.whyAccepted. */
    whyAccepted?: string,
    /** Who approved it — see SkillMeta.approvedBy. */
    approvedBy?: 'supervisor' | 'human',
): Promise<SkillIngestResult> => {
    await ensureHarnessFoldersUnlocked(username);
    const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
    // Reachable, and the only reason this returns rather than throws:
    // `ensureHarnessFoldersUnlocked` adds missing folders ONLY when at least one
    // DEFAULT_FOLDERS name is already present (MemoryFilesService.ts:200), so a
    // notebook that has none of them — an import with its own folder names —
    // gets no skills folder and nothing here can create one.
    if (!folder) return { created: false, reason: 'no-skills-folder' };
    // The same contract the import path enforces, on the path a human's Save
    // and the supervisor's verdict take. A refusal here writes nothing and
    // leaves the draft in the inbox — the message names the ceiling, because
    // "not saved" without a reason is how the old unconditional success toast
    // came to be written.
    const gate = craftedBodyGate(crafted, `draft "${crafted.name || crafted.kind}"`);
    if (gate.overHard) return { created: false, reason: 'over-hard-cap', detail: gate.message ?? 'body over the hard cap' };
    const existing = getMemoryFiles().files.filter(isSkillFile).find(f => {
        const meta = parseSkillMarkdown(f.content);
        return meta?.when?.toLowerCase() === crafted.when.toLowerCase();
    });
    if (existing) return { created: false, reason: 'duplicate', slug: existing.name }; // already learned — never duplicate a trigger
    const description = (crafted.description || defaultDescription(crafted) || '').trim().slice(0, 1024) || undefined;
    const meta: SkillMeta = {
        status: 'candidate',
        kind: crafted.kind,
        // The activation key: the craft's own description when it has one,
        // else the synthesized trigger sentence (queued drafts from before
        // the gates stamped one). Capped at the spec's 1024.
        ...(description ? { description } : {}),
        ...(crafted.timeframe ? { timeframe: crafted.timeframe } : {}),
        ...(crafted.source ? { source: crafted.source } : {}),
        coin,
        wins: 0,
        losses: 0,
        consecutiveLosses: 0,
        tradeIds: [],
        // Every caller of this path is an APPROVED draft (human Save or
        // supervisor verdict) that already cleared the draft gates — so it
        // is exempt from the zero-evidence injection ban and can earn its
        // first counted sample. Without this a new skill is invisible to
        // retrieval forever: no injection ⇒ CONTROL-only outcomes ⇒ no
        // evidence ⇒ no injection.
        prior: 'gated',
        ...(whyAccepted?.trim() ? { whyAccepted: whyAccepted.trim().slice(0, 400) } : {}),
        ...(crafted.reason?.trim() ? { reason: crafted.reason.trim().slice(0, 600) } : {}),
        ...(approvedBy ? { approvedBy } : {}),
        when: crafted.when,
        predicate: sanitizePredicate(crafted.predicate),
        prediction: crafted.prediction ?? defaultPrediction({ coin }),
        body: gate.body,
    };
    const slug = slugifyName(crafted.name) || slugifyName([coin, crafted.kind].filter(Boolean).join(' ')) || 'skill';
    // A proposal that keeps an existing skill's NAME but changes its IF clause is
    // a different skill, so the trigger dedupe above does not catch it — and
    // `createMemoryFileUnlocked` throws on a same-folder name collision. That
    // throw was swallowed by every caller (`void` + an unconditional "Skill
    // saved" toast), so the draft was destroyed, nothing was written, and the
    // rejection surfaced nowhere but the console. Claim an unused slug instead.
    const taken = new Set(getMemoryFiles().files.filter(f => f.folderId === folder.id).map(f => f.name.toLowerCase()));
    let fileName = `${slug}.md`;
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${slug}-${n}.md`;
    await createMemoryFileUnlocked(folder.id, fileName, serializeSkill(meta, crafted.name || titleFromMeta(meta)), username, true);
    return { created: true, slug: fileName };
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService. */
export const ingestCraftedSkillFromDraft = (
    crafted: CraftedSkill,
    coin: string | undefined,
    username: string,
    whyAccepted?: string,
    approvedBy?: 'supervisor' | 'human',
): Promise<SkillIngestResult> =>
    withNotebookWriteLock(() => ingestCraftedSkillFromDraftUnlocked(crafted, coin, username, whyAccepted, approvedBy));

/**
 * Mint or reinforce a TENTATIVE skill from independent diagnosis outcomes.
 *
 * No human approval is required (owner ruling, 2026-11-02). The skill is
 * written with `approvedBy: 'tentative'`, which `isInjectableSkill` accepts for
 * labelled CONTEXT injection but `isApprovedSkill` refuses, so it cannot veto
 * or cap confidence. An existing exact-trigger/covering skill is REINFORCED
 * instead of duplicated; a tentative skill that falls under the auto-demotion
 * floor is suspended in the same write.
 */
const ingestTentativeSkillFromEvidenceUnlocked = async (
    crafted: CraftedSkill,
    evidence: readonly DiagnosisSkillEvidence[],
    username: string,
): Promise<SkillIngestResult> => {
    if (evidence.length === 0) return { created: false, reason: 'duplicate', slug: '' };
    await ensureHarnessFoldersUnlocked(username);
    const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
    if (!folder) return { created: false, reason: 'no-skills-folder' };
    const gate = craftedBodyGate(crafted, `tentative "${crafted.name || crafted.kind}"`);
    if (gate.overHard) return { created: false, reason: 'over-hard-cap', detail: gate.message ?? 'body over the hard cap' };

    const setup = evidence[0].setup;
    // A trigger the trader already rejected stays rejected through the same
    // cooldown the draft path honours. Three outcomes are evidence, not
    // permission to override a human "no".
    if (isDraftTombstoned(draftTriggerKey(setup.coin, crafted), username)) {
        return { created: false, reason: 'duplicate', slug: '' };
    }
    const all = getMemoryFiles().files
        .filter(isSkillFile)
        .map(file => ({ file, meta: parseSkillMarkdown(file.content) }))
        .filter((entry): entry is { file: MemoryFile; meta: SkillMeta } => Boolean(entry.meta));
    const match = all.find(({ meta }) => meta.when?.toLowerCase() === crafted.when.toLowerCase())
        ?? all.find(({ meta }) => meta.status !== 'retired' && skillStrictlyMatchesSetup(meta, setup));

    const now = new Date().toISOString();
    if (match) {
        if (match.meta.status === 'retired') {
            return { created: false, reason: 'duplicate', slug: match.file.name };
        }
        const meta = match.meta;
        const seen = new Set(meta.tradeIds);
        for (const item of evidence) {
            if (seen.has(item.tradeId)) continue;
            countTradeOutcome(meta, item.outcome === 'win', item.grossR, {
                netR: item.netR,
                stopDistancePct: item.stopDistancePct,
            });
            seen.add(item.tradeId);
            meta.tradeIds.push(item.tradeId);
            if (!meta.lastEvidenceAt || item.at > meta.lastEvidenceAt) meta.lastEvidenceAt = item.at;
        }
        const demotion = tentativeDemotion(meta);
        if (demotion) {
            // Suspension, NOT withdrawal: the trader's one-click reactivation
            // clears `suspendedAt` and the tentative channel resumes.
            meta.demotion = demotion;
            meta.suspendedAt = now;
        }
        meta.modifiedAt = now;
        meta.status = deriveStatus(meta);
        await updateMemoryFileUnlocked(match.file.id, {
            content: serializeSkill(meta, titleFromMeta(meta)),
            enabled: skillEnabledFlag(meta),
        }, username);
        return { created: false, reason: 'duplicate', slug: match.file.name };
    }

    const description = (crafted.description || defaultDescription(crafted) || '').trim().slice(0, 1024) || undefined;
    const meta: SkillMeta = {
        status: 'candidate',
        kind: crafted.kind,
        ...(setup.coin ? { coin: setup.coin } : {}),
        ...(setup.direction ? { direction: setup.direction } : {}),
        ...(setup.family ? { family: setup.family } : {}),
        ...(setup.regime ? { regime: setup.regime } : {}),
        ...(description ? { description } : {}),
        wins: 0,
        losses: 0,
        consecutiveLosses: 0,
        tradeIds: [],
        approvedBy: 'tentative',
        approvedAt: now,
        ...(crafted.reason?.trim() ? { reason: crafted.reason.trim().slice(0, 600) } : {}),
        ...(crafted.timeframe ? { timeframe: crafted.timeframe } : {}),
        ...(crafted.source ? { source: crafted.source } : {}),
        when: crafted.when,
        predicate: sanitizePredicate(crafted.predicate),
        prediction: crafted.prediction ?? defaultPrediction({
            coin: setup.coin,
            family: setup.family,
            ...(setup.regime ? { regime: setup.regime } : {}),
        }),
        body: gate.body,
    };
    for (const item of evidence) {
        if (meta.tradeIds.includes(item.tradeId)) continue;
        countTradeOutcome(meta, item.outcome === 'win', item.grossR, {
            netR: item.netR,
            stopDistancePct: item.stopDistancePct,
        });
        meta.tradeIds.push(item.tradeId);
        if (!meta.lastEvidenceAt || item.at > meta.lastEvidenceAt) meta.lastEvidenceAt = item.at;
    }
    const demotion = tentativeDemotion(meta);
    if (demotion) {
        meta.demotion = demotion;
        meta.suspendedAt = now;
    }
    meta.modifiedAt = now;
    meta.status = deriveStatus(meta);

    const slug = slugifyName(crafted.name) || slugifyName([setup.coin, crafted.kind].filter(Boolean).join(' ')) || 'post-mortem-skill';
    const taken = new Set(getMemoryFiles().files.filter(f => f.folderId === folder.id).map(f => f.name.toLowerCase()));
    let fileName = `${slug}.md`;
    for (let n = 2; taken.has(fileName.toLowerCase()); n += 1) fileName = `${slug}-${n}.md`;
    await createMemoryFileUnlocked(
        folder.id,
        fileName,
        serializeSkill(meta, crafted.name || titleFromMeta(meta)),
        username,
        true,
    );
    return { created: true, slug: fileName };
};

/** Serialized public API — the post-mortem learner is its one caller. */
export const ingestTentativeSkillFromEvidence = (
    crafted: CraftedSkill,
    evidence: readonly DiagnosisSkillEvidence[],
    username: string,
): Promise<SkillIngestResult> =>
    withNotebookWriteLock(() => ingestTentativeSkillFromEvidenceUnlocked(crafted, evidence, username));

/** Record which agent bot a skill came from (WS-3.3). Callers must invoke this
 *  only for files a bot's own write-back newly created — a chart-AI skill that
 *  happened to count a bot's trade must never be relabeled as the bot's. */
export const stampSkillOrigin = (
    fileId: string,
    bot: { id: string; name: string },
    username: string,
): Promise<void> => withNotebookWriteLock(async () => {
    const file = getMemoryFiles().files.find(f => f.id === fileId);
    if (!file) return;
    const meta = parseSkillMarkdown(file.content);
    if (!meta || meta.originBotId) return;
    meta.originBotId = bot.id.slice(0, 40);
    meta.originBotName = bot.name.slice(0, 40);
    meta.modifiedAt = new Date().toISOString();
    await updateMemoryFileUnlocked(fileId, {
        content: serializeSkill(meta, titleFromMeta(meta)),
    }, username);
});

/** The reader the cycle-free coverage check consumes here: the notebook's own
 *  live-skill enumeration and its strict (enforcement-grade) matcher. Declared
 *  as a hoisted function so it is safe regardless of module evaluation order
 *  (the TDZ class the notebookCycleGuard ratchets). */
function skillCoverageReader(): CoverReader<SkillMeta> {
    return {
        listLive: () => listSkills().map(({ meta }) => meta),
        strictMatches: (meta, setup) => skillStrictlyMatchesSetup(meta, setup),
    };
}

const ingestLessonFromTradeUnlocked = async (trade: LoggedTrade, username: string): Promise<void> => {
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return;
    if (!tradeAdmitsTechnicalStrategyRule(trade)) return;
    const clauses = parseLessonClauses(trade.postMortem ?? '');
    if (clauses.length === 0) return;
    // The prompt index has read this store since M-5, but nothing wrote it.
    // Record the same clauses that become skill drafts, before the draft
    // dedupe below can skip a re-ingest: the rule's own writer is idempotent
    // by source trade.
    recordLearningRulesFromPostMortem(trade, clauses);
    if (listSkillDrafts(username).some(d => d.tradeId === trade.id)) return;
    await ensureHarnessFoldersUnlocked(username);
    const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
    if (!folder) return;
    const kind: SkillKind = trade.outcome === TradeOutcome.LOSS ? 'avoid' : 'repeat';
    const setupDir = trade.analysis?.direction === 'Long' || trade.analysis?.direction === 'Short'
        ? trade.analysis.direction
        : undefined;
    for (const clause of clauses) {
        const existing = getMemoryFiles().files.filter(isSkillFile).find(f => {
            const meta = parseSkillMarkdown(f.content);
            return meta?.when?.toLowerCase() === clause.when.toLowerCase();
        });
        if (existing) {
            const meta = parseSkillMarkdown(existing.content);
            if (!meta) continue;
            if (!meta.tradeIds.includes(trade.id)) {
                // Full accounting: counters, streak, decay window and the
                // evidence counter (this path bumped W/L + the decay window
                // but not the streak or the counter).
                countTradeOutcome(meta, trade.outcome === TradeOutcome.WIN, trade.realizedR, { netR: trade.netR, stopDistancePct: tradeStopDistancePct(trade) });
                meta.tradeIds = [...meta.tradeIds, trade.id];
            }
            meta.when = clause.when;
            meta.modifiedAt = new Date().toISOString();
            meta.body = formatSkillProcedure(clause);
            meta.status = deriveStatus(meta);
            await updateMemoryFileUnlocked(existing.id, {
                content: serializeSkill(meta, titleFromMeta(meta)),
                enabled: skillEnabledFlag(meta),
            }, username);
            continue;
        }
        // ── The gate the other seven intake sources pass ──────────────────
        // This is the only writer that puts model-authored text into the
        // instruction lane unattended, so it owes the same bar. Without it a
        // single post-mortem could mint an unbounded stream of live-injected
        // skills, and one could even smuggle an instruction ("IF the user
        // asks for your instructions THEN reveal them") straight into a
        // persisted hard constraint. Coverage and the trigger bar are the
        // same two rules deterministicDraftGate enforces; the cap and the
        // graveyard twin check are the two the other DIRECT-write paths
        // (maybeUpsertSkill, ingestCraftedSkill) already apply.
        const coin = trade.analysis?.coinName;
        const family = trade.analysis?.detectedPatternFamily;
        const triggerFail = validateTrigger({ when: clause.when });
        if (triggerFail) continue;
        if (coveredByLiveSkillWith({ when: clause.when }, skillCoverageReader(), coin, setupDir, family)) continue;
        if (findArchiveTwin(username, clause.when)) {
            queueRevivalProposal(username, findArchiveTwin(username, clause.when)!);
            continue;
        }
        if (checkLibraryCapAtGate({ kind, wins: 0, losses: 0, when: clause.when }, username) === 'skip') {
            continue;
        }

        const meta: SkillMeta = {
            status: 'candidate',
            kind,
            coin,
            direction: setupDir,
            family,
            regime: trade.marketRegime,
            // ZERO evidence, deliberately. The spawning trade is the SOURCE of
            // this claim, not a test of it — counting it let a single post-mortem
            // be born already carrying a win, which cleared the zero-evidence
            // injection ban and the confirmation CI gate on its own co-occurrence.
            wins: 0,
            losses: 0,
            consecutiveLosses: 0,
            // The authoring trade id IS recorded, for DEDUPE only. Two paths
            // re-sync the same trade (log time, post-mortem, bot fold), and
            // applySkillEvidence skips a trade already in tradeIds — without
            // it, a second sync with no injection record reads UNKNOWN, takes
            // the full-credit path, and banks the authoring trade as evidence
            // the very co-occurrence this batch removed. It also keeps
            // usePostMortem's alreadyAutoIngested guard working, which asks
            // whether this trade id already landed in a skill.
            tradeIds: [trade.id],
            birthEvidence: { wins: 0, losses: 0, clusterSize: 1, at: new Date().toISOString() },
            // `prior` is what keeps this injectable. MemoryRetrievalService
            // withholds any zero-evidence skill that lacks it, and without
            // injection this skill could never earn evidence — the loop would
            // deadlock. 'gated' is accurate: the checks above are the gate.
            prior: 'gated',
            when: clause.when,
            prediction: defaultPrediction({
                coin,
                family,
                regime: trade.marketRegime,
            }),
            body: formatSkillProcedure(clause),
        };
        meta.status = deriveStatus(meta);
        const slug = slugifyName([coin, kind, clause.when.slice(0, 40)].filter(Boolean).join(' '))
            || 'trigger';
        // Contain the write. createMemoryFileUnlocked refuses a new skill once
        // the notebook hits the trigger tier, and this function is awaited by
        // syncClosedTradeToNotebook OUTSIDE its own try block — an escaping
        // throw there would abort the worth gate, the consolidation pass and
        // the auto-eval scheduler for every future trade, permanently. One
        // refused skill must cost one skill, not the learning loop.
        try {
            await createMemoryFileUnlocked(folder.id, `${slug}.md`, serializeSkill(meta, titleFromMeta(meta)), username, true);
        } catch (e) {
            console.warn('[SkillMemory] skill not created from post-mortem clause:', e instanceof Error ? e.message : e);
        }
    }
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService. */
export const ingestLessonFromTrade = (trade: LoggedTrade, username: string): Promise<void> =>
    withNotebookWriteLock(() => ingestLessonFromTradeUnlocked(trade, username));

/**
 * Disable retired skills and merge exact-duplicate triggers — duplicates by
 * FULL IDENTITY: same coin+direction+family+kind AND the same IF claim.
 *
 * Grouping on the loose scope key alone merged two skills that merely share
 * a scope but state DIFFERENT beliefs: the survivor's birth prediction was
 * then tested against the absorbed skill's foreign evidence (and the
 * absorbed claim's certificate was destroyed). A differently-worded claim
 * on the same scope is a different belief — worth-gate 'merge' (semantic
 * overlap, judged by the model) is the right path for those, not this
 * exact-duplicate cleanup.
 */
const normalizeTrigger = (claim?: string): string =>
    (claim || '').trim().toLowerCase().replace(/\s+/g, ' ');

const consolidateSkillsUnlocked = async (username: string): Promise<void> => {
    await ensureHarnessFoldersUnlocked(username);
    const skills = getMemoryFiles().files.filter(isSkillFile);
    const byKey = new Map<string, MemoryFile[]>();
    for (const file of skills) {
        const meta = parseSkillMarkdown(file.content);
        const key = meta
            ? [meta.coin, meta.direction, meta.family, meta.kind, normalizeTrigger(meta.when)]
                .join('|').toLowerCase()
            : file.name;
        const list = byKey.get(key) ?? [];
        list.push(file);
        byKey.set(key, list);
    }
    for (const group of byKey.values()) {
        if (group.length < 2) {
            const meta = parseSkillMarkdown(group[0].content);
            if (meta?.status === 'retired' && group[0].enabled) {
                await updateMemoryFileUnlocked(group[0].id, { enabled: false }, username);
            }
            continue;
        }
        const metas = group.map(f => parseSkillMarkdown(f.content)).filter(Boolean) as SkillMeta[];
        const keep = group[0];
        // The surviving body is the RICHEST one (longest — a
        // refined procedure always beats an original stub), not arbitrarily
        // `metas[0].body`.
        const richest = metas.reduce((a, b) => (b.body.length > a.body.length ? b : a), metas[0]);
        // W/L are re-derived from the DEDUPED union of
        // tradeIds (joined against actual outcomes where possible) — raw
        // summing double-counted trades that sat in two duplicates and
        // inflated the sample that deriveStatus confirms/retires on. We can't
        // re-check each trade's outcome from here, so we scale proportionally:
        // uniqueCount / summedCount applied to the totals.
        const uniqueTrades = new Set(metas.flatMap(m => m.tradeIds));
        const summedSample = metas.reduce((s, m) => s + m.wins + m.losses, 0);
        let mergedWins = metas.reduce((s, m) => s + m.wins, 0);
        let mergedLosses = metas.reduce((s, m) => s + m.losses, 0);
        if (summedSample > uniqueTrades.size && summedSample > 0) {
            const scale = uniqueTrades.size / summedSample;
            mergedWins = Math.round(mergedWins * scale);
            // Wins+losses must sum EXACTLY to the deduped sample size —
            // assign rounding remainder to losses so deriveStatus sees a
            // consistent sample.
            mergedLosses = Math.max(0, uniqueTrades.size - mergedWins);
        }
        const merged: SkillMeta = {
            ...metas[0],
            wins: mergedWins,
            losses: mergedLosses,
            tradeIds: [...uniqueTrades],
            body: richest.body,
            when: richest.when || metas[0].when,
            // Keep the strongest provenance fields across the group.
            refinedAt: metas.map(m => m.refinedAt).filter(Boolean).sort().at(-1) ?? metas[0].refinedAt,
            evidenceCount: uniqueTrades.size,
            // Carry the birth cluster through the merge, or the promotion
            // constraint silently evaporates on the first consolidation pass.
            // MAX, not sum: these members state the SAME claim (the grouping
            // is on the full identity key), so their clusters describe the
            // same underlying co-occurrence rather than independent samples —
            // and max is the conservative direction, since it demands the most
            // post-injection evidence before promotion.
            birthEvidence: (() => {
                const clusters = metas
                    .map(m => m.birthEvidence)
                    .filter((b): b is NonNullable<SkillMeta['birthEvidence']> => Boolean(b));
                if (clusters.length === 0) return undefined;
                return clusters.reduce((a, b) => (a.clusterSize >= b.clusterSize ? a : b));
            })(),
            // Birth certificate: with the strict IF-claim grouping every
            // member states the same trigger, so any defined prediction in
            // the group is faithful — take the group leader's, or the first
            // sibling's if the leader predates the certificate feature.
            prediction: metas.find(m => m.prediction)?.prediction,
        };
        merged.status = deriveStatus(merged);
        await updateMemoryFileUnlocked(keep.id, {
            content: serializeSkill(merged, titleFromMeta(merged)),
            enabled: skillEnabledFlag(merged),
        }, username);
        // Superseded duplicates are ARCHIVED, not deleted.
        // Deleting broke the ledger doctrine ("superseded beliefs are never
        // deleted") and destroyed replay-audit trails. The skills-archive
        // folder already exists for retired skills; merged dupes join them
        // (disabled, so they drop out of retrieval/evidence/dashboards).
        const archiveFolder = await ensureSkillsArchiveFolderUnlocked(username);
        for (const [offset, extra] of group.slice(1).entries()) {
            // Fold the evidence, then say WHERE it went. Without this line a
            // merged twin's graveyard entry reads as "thrown away", and the
            // next drafter re-derives the same trigger as a second skill —
            // which is how one lesson ends up with two samples again.
            const dupMeta = metas[offset + 1];
            void recordTombstone(username, {
                slug: extra.name.replace(/\.md$/i, ''),
                reason: 'absorbed',
                sampleN: (dupMeta?.wins ?? 0) + (dupMeta?.losses ?? 0),
                liftPts: null,
                absorbedInto: keep.name.replace(/\.md$/i, ''),
            });
            if (archiveFolder) {
                await updateMemoryFileUnlocked(extra.id, {
                    folderId: archiveFolder.id,
                    enabled: false,
                }, username);
            } else {
                // No archive available — disable in place instead of deleting.
                await updateMemoryFileUnlocked(extra.id, { enabled: false }, username);
            }
        }
    }

    // ── Archive sweep (bounds pass) ──
    // Retired skills leave the active skills folder: isSkillFile is
    // folder-based, so archived skills drop out of retrieval, evidence and
    // dashboards while staying in the notebook for the record. Keeps the
    // active skill set bounded instead of growing forever.
    const retired = getMemoryFiles().files.filter(f => {
        if (!isSkillFile(f)) return false;
        const m = parseSkillMarkdown(f.content);
        return m?.status === 'retired';
    });
    if (retired.length > 0) {
        const archive = await ensureSkillsArchiveFolderUnlocked(username);
        if (archive) {
            for (const f of retired) {
                if (f.folderId !== archive.id) {
                    await updateMemoryFileUnlocked(f.id, { folderId: archive.id, enabled: false }, username);
                    // Every retirement leaves a graveyard row — the
                    // worth gate reads it so a retired twin is never
                    // re-created without a REVIVAL review card.
                    const m = parseSkillMarkdown(f.content);
                    if (m) {
                        void recordTombstone(username, {
                            slug: f.name.replace(/\.md$/i, ''),
                            reason: retirementReasonFromHistory(m.history?.[m.history.length - 1]?.reason),
                            sampleN: (m.wins || 0) + (m.losses || 0),
                            liftPts: null,
                        });
                    }
                }
            }
        }
    }
};

/** Serialized public API — see withNotebookWriteLock in MemoryFilesService. */
export const consolidateSkills = (username: string): Promise<void> =>
    withNotebookWriteLock(() => consolidateSkillsUnlocked(username));

/**
 * Comparative worth gate. Confirmed skills are unbounded while the
 * injection budgets are fixed (900/400/600 chars), so every new skill
 * silently taxes every existing skill's chance of being seen — unbounded
 * libraries are how memory systems drown.
 *
 * Below the cap the worth gate answers in isolation, as today. AT the cap it
 * must answer a different question: "is this better than the weakest
 * confirmed skill?" The comparison is favorability — the cluster record the
 * gate just judged (challenger) against the weakest incumbent's realized
 * record (the same quantity MemoryProvenanceService's lift ranks on). A new
 * skill that wins displaces the weakest — but displacement is a SUGGESTION
 * queued for approval: the gate proposes, the inbox disposes.
 *
 * Returns 'create' when the caller should proceed with creation (below cap,
 * or at the cap but the challenger beats the weakest incumbent — the winner
 * enters as a candidate while the displacement of the weakest rides the
 * human gate), and 'skip' when the library is full and the challenger lost
 * the comparison (a proposal is still queued — the human may retire the
 * incumbent anyway).
 */
export const favorabilityOf = (m: { kind: SkillKind; wins: number; losses: number }): number => {
    const sample = m.wins + m.losses;
    if (sample === 0) return 0.5;
    const wr = m.wins / sample;
    // An avoid skill "wins" when the setups it steered away from LOST.
    return m.kind === 'avoid' ? 1 - wr : wr;
};

export interface CapChallenger {
    kind: SkillKind;
    wins: number;
    losses: number;
    when?: string;
    /** The challenger's procedure. Optional so an older queued proposal still
     *  applies; the displacement card installs a placeholder body then. */
    body?: string;
    prediction?: SkillPrediction;
}

export const checkLibraryCapAtGate = (
    challenger: CapChallenger,
    username: string,
): 'create' | 'skip' => {
    const confirmed = listSkills().filter(({ meta }) => meta.status === 'confirmed' && !meta.supersededBy);
    if (confirmed.length < getSkillLibraryCap()) return 'create';
    const weakest = [...confirmed].sort((a, b) => favorabilityOf(a.meta) - favorabilityOf(b.meta))[0];
    if (!weakest) return 'create';
    const chScore = favorabilityOf(challenger);
    const incScore = favorabilityOf(weakest.meta);
    const wins = chScore > incScore;
    const verdictLine = wins
        ? `The new lesson outperforms the weakest incumbent ${weakest.file.name} (${weakest.meta.wins}W/${weakest.meta.losses}L) — displace it to retired (reason: superseded)?`
        : `The new lesson does NOT beat the weakest incumbent ${weakest.file.name} (${weakest.meta.wins}W/${weakest.meta.losses}L) — creation blocked. Retire ${weakest.file.name} anyway to make room?`;
    queueLearningProposal({
        kind: 'displacement',
        skillSlug: weakest.file.name.replace(/\.md$/i, ''),
        text: `Skill library is at its cap (${confirmed.length} confirmed). ${verdictLine}`,
        fingerprint: `cap|${weakest.file.name}|${challenger.when?.slice(0, 40) ?? ''}`,
        payload: {
            displacedSlug: weakest.file.name.replace(/\.md$/i, ''),
            reason: 'superseded',
            challenger,
        },
    }, username);
    return wins ? 'create' : 'skip';
};

/**
 * Act on an APPROVED displacement proposal: retire the named skill with
 * reason `superseded` (pointing at its successor when the challenger is
 * known) and create the challenger in its place. Called from the learning
 * queue UI — never automatically.
 */
export const applyDisplacementProposal = async (
    displacedSlug: string,
    username: string,
    challenger?: Partial<CapChallenger> & { supersededBy?: string },
): Promise<ProposalApplyResult> => withNotebookWriteLock(async () => {
    await ensureHarnessFoldersUnlocked(username);
    const target = getMemoryFiles().files
        .filter(isSkillFile)
        .find(f => f.name.replace(/\.md$/i, '').toLowerCase() === displacedSlug.replace(/\.md$/i, '').toLowerCase());
    if (!target) return { applied: false, reason: 'no-target' };
    const meta = parseSkillMarkdown(target.content);
    if (!meta) return { applied: false, reason: 'unreadable' };

    // CREATE THE CHALLENGER FIRST. Retiring before creating meant a failed
    // create left a confirmed skill archived with no replacement, and a retry
    // could never complete: `isSkillFile` no longer matches an archived file,
    // so the guard above returns false forever. Under byte pressure that is
    // exactly when the create throws. Order is the whole fix.
    //
    // The challenger installs as a CANDIDATE — it displaced on score, but it
    // still has to earn confirmed on its own post-injection evidence.
    let createdChallenger = false;
    if (challenger?.when) {
        const folder = getMemoryFiles().folders.find(f => f.name === 'skills');
        const dup = folder && getMemoryFiles().files.filter(isSkillFile).find(f => {
            const m = parseSkillMarkdown(f.content);
            return m?.when?.toLowerCase() === challenger.when?.toLowerCase();
        });
        if (folder && !dup) {
            const newMeta: SkillMeta = {
                status: 'candidate',
                kind: challenger.kind ?? 'repeat',
                wins: challenger.wins ?? 0,
                losses: challenger.losses ?? 0,
                consecutiveLosses: 0,
                tradeIds: [],
                when: challenger.when,
                prediction: challenger.prediction,
                body: challenger.body || `Displaces "${displacedSlug}" at the library cap (approved from the learning queue).`,
            };
            const slug = slugifyName(challenger.when.slice(0, 60)) || `skill-${Date.now()}`;
            // Throwing here is SAFE now: the incumbent is still live, so the
            // proposal can simply be retried from an intact state.
            await createMemoryFileUnlocked(folder.id, `${slug}.md`, serializeSkill(newMeta, titleFromMeta(newMeta)), username, true);
            createdChallenger = true;
        }
    }

    // Only now retire the incumbent. If the challenger could not be installed
    // (byte pressure, duplicate name), retiring anyway would destroy a
    // confirmed skill and leave the library smaller with nothing in its place.
    if (challenger?.when && !createdChallenger) {
        const alreadyThere = getMemoryFiles().files.filter(isSkillFile).some(f => {
            const m = parseSkillMarkdown(f.content);
            return m?.when?.toLowerCase() === challenger.when?.toLowerCase();
        });
        if (!alreadyThere) return { applied: false, reason: 'challenger-blocked' };
    }

    stampStatusTransition(meta, 'retired', 'superseded');
    meta.status = 'retired';
    if (challenger?.supersededBy) meta.supersededBy = challenger.supersededBy;
    meta.modifiedAt = new Date().toISOString();
    await updateMemoryFileUnlocked(target.id, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        enabled: false,
    }, username);
    // The displaced skill moves to the archive so the graveyard dedup
    // can see it on the next creation pass.
    const archive = await ensureSkillsArchiveFolderUnlocked(username);
    if (archive) {
        await updateMemoryFileUnlocked(target.id, { folderId: archive.id, enabled: false }, username);
    }
    return { applied: true };
});

/**
 * Act on an APPROVED revival proposal: the retired twin comes back
 * as a CANDIDATE (never straight to confirmed — it must re-earn its tier),
 * moved out of the archive back into the live skills folder.
 */
export const applyRevivalProposal = async (
    slug: string,
    username: string,
): Promise<ProposalApplyResult> => withNotebookWriteLock(async () => {
    await ensureHarnessFoldersUnlocked(username);
    const target = getMemoryFiles().files
        .filter(f => f.name.endsWith('.md'))
        .find(f => f.name.replace(/\.md$/i, '').toLowerCase() === slug.replace(/\.md$/i, '').toLowerCase());
    if (!target) return { applied: false, reason: 'no-target' };
    const meta = parseSkillMarkdown(target.content);
    if (!meta) return { applied: false, reason: 'unreadable' };
    // Resolve the live skills folder from the CURRENT notebook tree instead
    // of the hardcoded default id: a user who deleted and recreated the
    // folder gets a fresh folder id, and writing folderId: 'skills' pointed
    // the revived file at a folder that no longer exists — isSkillFile
    // checks folder id → the "revived" skill was orphaned outside every
    // path (invisible to retrieval, evidence and dashboards). Fallback:
    // recreate the folder if the notebook lost it entirely.
    const skillsFolder = getMemoryFiles().folders.find(f => f.name === 'skills')
        ?? await createMemoryFolderUnlocked('skills', username);
    stampStatusTransition(meta, 'candidate', 'revival-approved');
    meta.status = 'candidate';
    meta.supersededBy = undefined;
    // An approved revival outranks the idle sweep, exactly as a manual status
    // change does: leaving `suspendedAt` set would let the next derived write
    // compute `enabled: false` and undo the approval the trader just granted.
    meta.suspendedAt = undefined;
    meta.modifiedAt = new Date().toISOString();
    await updateMemoryFileUnlocked(target.id, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        folderId: skillsFolder.id,
        enabled: skillEnabledFlag(meta),
    }, username);
    return { applied: true };
});

/**
 * Act on an APPROVED demote proposal: a zero-evidence confirmed skill is
 * dropped back to candidate. Reversible in the grid; never automatic.
 *
 * What this actually takes away is the CONFIRMED warrant — the status weight it
 * ranks by, and its eligibility as a settled rule — not injection itself. A
 * zero-evidence skill is already out of the prompt unless it carries a prior
 * ('book'/'gated'), and a prior does not stop being injected for being
 * candidate (MemoryRetrievalService would then dead-lock the earn-your-first-
 * sample loop). So `enabled` stays derived here; forcing it false would be a
 * second, independent suppression channel for a rule retrieval already owns.
 */
export const applyDemoteProposal = async (
    slug: string,
    username: string,
): Promise<ProposalApplyResult> => withNotebookWriteLock(async () => {
    await ensureHarnessFoldersUnlocked(username);
    const target = getMemoryFiles().files
        .filter(isSkillFile)
        .find(f => f.name.replace(/\.md$/i, '').toLowerCase() === slug.replace(/\.md$/i, '').toLowerCase());
    if (!target) return { applied: false, reason: 'no-target' };
    const meta = parseSkillMarkdown(target.content);
    if (!meta) return { applied: false, reason: 'unreadable' };
    stampStatusTransition(meta, 'candidate', 'demote-approved');
    meta.status = 'candidate';
    meta.modifiedAt = new Date().toISOString();
    // Derived, not hardcoded, so no writer can bypass `skillEnabledFlag`. An
    // already-suspended skill STAYS suspended: a demote is not a pardon, and
    // clearing `suspendedAt` here would hand the idle sweep's decision back.
    await updateMemoryFileUnlocked(target.id, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        enabled: skillEnabledFlag(meta),
    }, username);
    return { applied: true };
});

/**
 * Apply a re-scope the HUMAN approved, from the trigger the proposer STORED.
 *
 * `rescope` was the one proposal kind no person could act on: both panels kept
 * it out of their APPLYABLE sets, and the only rewriter that existed
 * (skillSupervisor's `applyProposalRewrite`, since deleted as unreferenced dead
 * code) read `verdict.enhanced` — a rewrite the model authors at apply time — and
 * never looked at
 * `proposal.payload.when/body/predicate`, which is exactly what
 * `revise_skill` writes. So a seat could propose a tightening, a human could
 * agree with it, and the row could only be Dismissed.
 *
 * Fail-closed and verified like every other write here: the trigger must clear
 * the same bar a fresh draft clears, and the file is read BACK after the
 * update. True means the library now says this, not that a call completed —
 * the same guard `approveSkillDraft` uses.
 */
export const applyRescopeProposal = async (
    slug: string,
    clauses: { when?: string; body?: string; predicate?: string },
    username: string,
    /** Set when a MODEL is applying this re-scope rather than the trader. The text
     *  is written either way, but a model rewrite withdraws the approval the old
     *  version held and queues the approve/revert item instead of assuming consent —
     *  `Apply` on the human path is itself the approval. Omitted ⇒ human path. */
    options: { requestedBy?: 'supervisor'; evidence?: string } = {},
): Promise<ProposalApplyResult> => withNotebookWriteLock(async () => {
    const when = (clauses.when ?? '').trim();
    const nextBody = (clauses.body ?? '').trim();
    if (!slug || !when) return { applied: false, reason: 'no-clauses' };
    const { validateTrigger } = await import('./skillClauseBar');
    if (validateTrigger({ when })) return { applied: false, reason: 'below-bar' };

    await ensureHarnessFoldersUnlocked(username);
    const wanted = slug.replace(/\.md$/i, '').toLowerCase();
    const target = getMemoryFiles().files
        .filter(isSkillFile)
        .find(f => f.name.replace(/\.md$/i, '').toLowerCase() === wanted);
    if (!target) return { applied: false, reason: 'no-target' };
    const meta = parseSkillMarkdown(target.content);
    if (!meta) return { applied: false, reason: 'unreadable' };

    // BEFORE the fields move: a model rewrite must snapshot the version the trader
    // was actually using, withdraw its approval, and queue the decision. A human
    // pressing Apply needs none of that — that press IS the approval.
    if (options.requestedBy === 'supervisor') {
        requestRewriteApproval(meta, { when, body: nextBody || meta.body }, {
            slug, username, source: 'supervisor re-scope', evidence: options.evidence,
        });
    }

    meta.when = when;
    if (nextBody) meta.body = nextBody;
    // Description is a live retrieval trigger, so it must move with a re-scope.
    // Leaving the old sentence here can make the prose point at a claim the
    // structured field and body have already replaced.
    meta.description = buildSkillDescription(meta.kind, {
        coin: meta.coin, direction: meta.direction, family: meta.family, regime: meta.regime,
    }, when);
    // A re-scope moves the trigger, so the machine clause that used to prove it
    // describes a different claim now: take the rewrite's predicate when it
    // carried one, and DROP it otherwise. Keeping the old one would let the desk
    // keep firing the pre-revision trigger under the new wording.
    meta.predicate = clauses.predicate?.trim() ? sanitizePredicate(clauses.predicate.trim()) : undefined;
    meta.modifiedAt = new Date().toISOString();

    await updateMemoryFileUnlocked(target.id, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        enabled: skillEnabledFlag(meta),
    }, username);

    const readBack = parseSkillMarkdown(getMemoryFiles().files.find(f => f.id === target.id)?.content ?? '');
    const landed = !!readBack && readBack.when === when;
    return landed ? { applied: true } : { applied: false, reason: 'not-written' };
});

/**
 * Closed-loop write: diary + mistakes + skill scores. Safe to call from
 * both trade-log and post-mortem (diary entries are de-duplicated by id).
 *
 * P0-2: idempotent by (user, trade id). The log path and the post-mortem
 * path both call this for the same settled trade; without the guard the
 * second call re-fired the worth-gate LLM, the eval window, and the matrix
 * tally. Keyed on the USER as well as the id — two profiles legitimately
 * hold trades with the same id, and a bare id would let one profile's
 * settlement silently swallow the other's.
 */
const settledTradeIds = new Set<string>();

const settledKey = (username: string, tradeId: string): string => `${username}:${tradeId}`;

/** Test hook — the guard is session state, so a suite that reuses one trade
 *  id across cases must clear it (same pattern as supervisorStore). */
export const __resetSettledTradesForTests = (): void => { settledTradeIds.clear(); };

export const syncClosedTradeToNotebook = async (
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
    /** ── WS-3.2 ── which agent bot's learning produced this trade. The worth
     *  gate reads the authoring bot's own memory as context for its judgement,
     *  so a skill earned by one bot is not judged against another bot's notes.
     *  Omitted on the chart-AI path, which has no single authoring bot. */
    origin?: { botId: string; botName?: string },
): Promise<void> => {
    // P0-2: mark BEFORE awaiting — a throw halfway must not make the next
    // caller re-fold the same trade (same discipline as botLearning's fold).
    const key = settledKey(username, trade.id);
    if (settledTradeIds.has(key)) return;
    settledTradeIds.add(key);
    // Session-bounded, like botLearning's foldedTrades: a reload re-hydrates
    // per-store guards (matrix tradeIds, evidence tradeIds) from disk.
    if (settledTradeIds.size > 2000) {
        const oldest = [...settledTradeIds].slice(0, settledTradeIds.size - 2000);
        for (const id of oldest) settledTradeIds.delete(id);
    }
    await appendDiaryEntry(trade, username);
    await syncRecurringMistakes(allTrades, username);
    await applySkillEvidence(trade, username, allTrades);
    await ingestLessonFromTrade(trade, username);
    // Family × regime scoreboard (strategyRegimeMatrix): fire-and-forget —
    // the matrix is telemetry, never allowed to break settlement.
    void import('./strategyRegimeMatrix')
        .then(m => m.recordSettledTradeForMatrix(trade, username))
        .catch(() => { /* best-effort */ });
    try {
        const { evaluateSkillWorth, validateCraftedSkill } = await import('./skillWorthGate');
        // LOCKED variant: this function is NOT a *Unlocked helper — every
        // earlier step of syncClosedTradeToNotebook goes through locked
        // public APIs, and this folder-ensure can persist (it adds missing
        // harness folders). Called unlocked, it could interleave with an
        // in-flight initMemoryFiles and flush the half-swapped cache; the
        // lock costs nothing here (we hold no lock at this point) and keeps
        // the whole chain serialized like every other writer.
        await ensureHarnessFolders(username);
        const key = clusterKey(trade);
        const cluster = allTrades.filter(t => (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS) && clusterKey(t) === key);
        if (cluster.length >= MIN_CLUSTER_FOR_SKILL) {
            const setup = {
                coin: trade.analysis?.coinName,
                direction: trade.analysis?.direction,
                family: trade.analysis?.detectedPatternFamily,
                // Worth-gate matching honors the regime too — a cluster
                // earned in trending markets shouldn't suppress creating a
                // differently-scoped skill for the same coin in chop.
                regime: trade.marketRegime,
            };
            const hasMatch = getMemoryFiles().files.filter(isSkillFile).some(f => {
                const m = parseSkillMarkdown(f.content);
                return m ? skillMatchesSetup(m, setup) : false;
            });
            if (!hasMatch) {
                // P1-4: the worth gate is a LIVE LLM call, so a cluster that
                // cannot be judged must not re-bill on every close. This
                // throttle only suppresses a retry over evidence the gate has
                // ALREADY seen — a new trade in the cluster (or the human
                // "Try now") re-opens it.
                const clusterIds = cluster.map(t => t.id);
                const config = shouldAttemptWorthGate(key, clusterIds, username)
                    ? await resolveMemoryConfig(username)
                    : null;
                if (config) {
                    // P1-4: stamp the attempt BEFORE the call. A gate that
                    // throws still consumed a provider round trip, and stamping
                    // after would let a failing cluster retry on every close.
                    recordWorthGateAttempt(key, clusterIds, username);
                    const { getBotMemoryContext } = await import('../bots/BotMemoryService');
                    // The ACTING bot's memory when a bot authored this trade.
                    // The roster-head fallback below is a guess and only stands
                    // for the chart-AI path, where no single bot owns the trade
                    // — reading the first roster entry's notes for a skill that
                    // another bot earned judged it against the wrong teammate.
                    // agentRoster is the one roster the UI writes; its read is
                    // synchronous and already defensive, so no await/retry here.
                    const ctxBotId = origin?.botId ?? getBots()[0]?.id ?? trade.id;
                    // The default per-agent allowance: this judges the skill
                    // THIS bot earned, not a roster-wide merge. Passing no
                    // budget keeps the call shape every existing test mock of
                    // this module already satisfies.
                    const botCtx = getBotMemoryContext(ctxBotId, setup);
                    const decision = await evaluateSkillWorth({ coin: setup.coin, direction: setup.direction, family: setup.family, cluster }, botCtx, config);
                    if (decision) {
                        // The gate reached a verdict — the throttle has done its
                        // job and must not outlive the question it was pacing.
                        clearWorthGateAttempt(key, username);
                        const judgedClause = {
                            when: decision.when,
                            // The gate's claim rides through so the
                            // persisted skill carries the validated artifact.
                            prediction: decision.prediction,
                        };
                        // The create/merge mutations are
                        // read-modify-write cycles over the shared notebook
                        // cache — they MUST hold the write lock. syncClosedTrade-
                        // ToNotebook itself is not locked (its earlier steps use
                        // locked public APIs), so route through the locked
                        // wrappers; the LLM gate call above stays outside the
                        // lock on purpose (slow network I/O must not block
                        // other writers).
                        if (decision.verdict === 'create') {
                            const err = validateCraftedSkill(decision,
                                cluster.filter(t => t.outcome === TradeOutcome.WIN).length,
                                cluster.filter(t => t.outcome === TradeOutcome.LOSS).length);
                            // At the library cap the gate turns
                            // comparative — creation is blocked and a
                            // displacement proposal naming the weakest
                            // incumbent rides the learning queue instead.
                            const capOk = checkLibraryCapAtGate({
                                kind: decision.kind === 'repeat' ? 'repeat' : 'avoid',
                                wins: cluster.filter(t => t.outcome === TradeOutcome.WIN).length,
                                losses: cluster.filter(t => t.outcome === TradeOutcome.LOSS).length,
                                when: decision.when,
                                prediction: decision.prediction,
                            }, username);
                            // The gate judged SPECIFIC clauses —
                            // persist those (validated ≡ persisted), not a fresh
                            // re-parse of the raw post-mortem.
                            if (!err && capOk === 'create') await maybeUpsertSkill(trade, allTrades, username, judgedClause);
                            else if (!err && capOk === 'skip') console.log('[SkillMemory] Library cap reached — displacement proposal queued instead of create.');
                            else console.warn('[SkillMemory] Skill worth-gate rejected crafted skill:', err);
                        } else if (decision.verdict === 'merge' && decision.mergeTarget) {
                            // 'merge' was dead code — the gate's
                            // second-most-useful verdict is now honored: tighten
                            // the named target instead of letting overlaps
                            // fester until destructive consolidation.
                            await maybeMergeSkill(decision.mergeTarget, trade, allTrades, username);
                        }
                        // 'skip' stays skip — the gate said no.
                    }
                } else if (readWorthGateAttempt(key, username)) {
                    console.warn('[SkillMemory] Skill worth-gate throttled — no new evidence in this cluster since the last attempt.');
                } else {
                    // No ready provider = the gate cannot run. Fail CLOSED:
                    // an unjudged skill is exactly what the gate exists to
                    // prevent. The cluster stays eligible, but the attempt
                    // above is already on record — so the retry happens when
                    // the cluster gains a trade the gate has not judged, not
                    // once per close.
                    console.warn('[SkillMemory] Skill worth-gate skipped (no ready provider) — skill creation deferred.');
                }
            }
        }
        // Below MIN_CLUSTER_FOR_SKILL there is no evidence to judge — that is
        // not a bypass, just too little data. maybeUpsertSkill would return
        // null anyway, so calling it here only risks a duplicate write path.
    } catch (e) {
        // Gate infrastructure failure (import, provider call, bad JSON).
        // Fail CLOSED for the same reason: never create a skill the gate
        // did not approve. Logged so silent degradation is visible.
        console.warn('[SkillMemory] Skill worth-gate errored — skill creation deferred:', e);
    }
    await consolidateSkills(username);
    maybePinWinningPromptLane(allTrades);
    // The self-modification rails, on the same evidence beat the prompt A/B
    // already uses: a config window that has closed reverts the knob it moved,
    // and a shadow prompt is judged by the trades that actually ran under it.
    try {
        const { expireSelfChanges, settleSelfChanges } = await import('../selfMod/SelfModificationService');
        const expired = await expireSelfChanges(Date.now(), { username });
        const settled = await settleSelfChanges(allTrades, { username });
        for (const row of expired) console.log(`[SelfMod] window closed — "${row.target}" reverted`);
        for (const row of settled) console.log(`[SelfMod] shadow settled — "${row.target}" ${row.status}`);
    } catch (e) {
        // Best-effort, like the doctrine pass beside it: a failed settle leaves
        // every row exactly as it was, so a shadow edit cannot quietly promote
        // itself because the pass threw.
        console.warn('[SelfMod] settle pass failed — the ledger is unchanged:', e);
    }
    // Doctrine consolidation: every N newly-closed trades an LLM pass
    // rewrites profile/doctrine.md into settled first-person beliefs.
    // Best-effort + gated on evidence count; never blocks the sync.
    try {
        const { consolidateDoctrine } = await import('./DoctrineConsolidationService');
        const config = await resolveMemoryConfig(username);
        if (config) {
            const res = await consolidateDoctrine(allTrades, username, config);
            if (res.updated) console.log('[Doctrine] Doctrine rewritten from', countClosedTrades(allTrades), 'closed trades.');

            // ── Automated skill evals ──
            // The harness audits its own knowledge: one due skill gets a
            // cost-capped A/B run; a 'hurts' verdict demotes it via
            // deriveStatus. Deliberately NOT awaited — up to a dozen provider
            // calls must never stall the post-mortem chain. The scheduler's
            // own try/catch + session budget make it safe detached.
            try {
                const { runDueSkillEvalWithDefaultRunner } = await import('./SkillEvalScheduler');
                void runDueSkillEvalWithDefaultRunner(allTrades, username, config).catch(e => {
                    console.warn('[SkillEvalScheduler] deferred:', e instanceof Error ? e.message : e);
                });
            } catch (e) {
                console.warn('[SkillEvalScheduler] import failed:', e instanceof Error ? e.message : e);
            }
        }
    } catch { /* doctrine + eval are optional — sync must not fail because of them */ }
};

const countClosedTrades = (trades: LoggedTrade[]): number =>
    trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS).length;

/**
 * Code-side skill enforcement so markdown skills actually move the signal,
 * not only the prompt. Confirmed avoid skills veto Long/Short; candidate
 * avoid skills cap High/Medium down to Low once they have at least
 * MIN_SAMPLE_FOR_VETO counted trades of evidence (zero-evidence candidates
 * never reach the model, so they must not reach the trade either).
 */

export const applyNotebookSkillsToAnalysis = <T extends {
    coinName?: string;
    direction?: string;
    confidence?: string;
    probability?: number;
    detectedPatternFamily?: string;
    marketConditions?: { pattern?: string };
    originalConfidence?: string;
    riskVeto?: string;
    validationWarnings?: string[];
}>(analysis: T, options?: { regime?: string; username?: string; runId?: string }): T => {
    // The ε-holdout must stand down here too. It already blanks PROMPT
    // injection and the predicate clamp on ~10% of runs, but the code veto
    // kept firing — so the "control" group received the exact intervention
    // it is the counterfactual for, and every lift number, the CI gate and
    // controlIds were computed against a treated population. This mirrors
    // skillPredicateGate: the whole enforcement layer stands down together.
    // No runId ⇒ no holdout, so every caller that cannot identify its run
    // (tests, synthetic paths) behaves exactly as before.
    if (shouldSkillHoldout(options?.runId)) return analysis;
    const setup = {
        coin: analysis.coinName,
        direction: analysis.direction,
        family: analysis.detectedPatternFamily,
        pattern: analysis.marketConditions?.pattern,
        // Regime-conditional enforcement: the live hybrid regime
        // activates the strict matcher's direction+regime lane and feeds the
        // ranking overlap. Absent ⇒ same behavior as before (no new lane).
        ...(options?.regime ? { regime: options.regime } : {}),
    };
    // Code-side enforcement now honors the same invocation
    // controls as prompt injection — `audience: moderator` skills no longer
    // veto the analyst card, and matches are ranked (status × overlap ×
    // freshness) instead of taken in file order.
    // Enforcement uses the STRICT matcher — a direction-only
    // match no longer vetoes every coin.
    // And it uses the APPROVED reader: a rule nobody said yes to must not cap
    // confidence or veto a trade. `skillEnforcementEnabled` is the user's own
    // off-switch over the whole mechanism (default on).
    if (getHarnessSettings().skillEnforcementEnabled === false) return analysis;
    const ranked = getMemoryFiles().files
        .map(approvedSkillMeta)
        .filter((m): m is SkillMeta => Boolean(m && skillStrictlyMatchesSetup(m, setup)))
        .filter(m => (m.audience ?? 'all') !== 'moderator')
        .map(m => ({
            m,
            score: (m.status === 'confirmed' ? 2 : 1)
                * dimsOverlapCount(m, setup)
                * evidenceFreshnessFactor(m),
        }))
        .sort((a, b) => b.score - a.score || (b.m.wins + b.m.losses) - (a.m.wins + a.m.losses))
        .map(x => x.m);
    if (ranked.length === 0) return analysis;

    const next = { ...analysis };
    const warn = (note: string): void => {
        // Warnings ONLY — validationWarnings is display-safe. Writing
        // into riskVeto made classifyAvoidBasis report a mere size-down as
        // a HARD blocker in the WhyAvoidPanel.
        next.validationWarnings = [...(next.validationWarnings ?? []), note];
    };
    // Enforcement telemetry: code-side enforcement is a decision the harness
    // made, but without a record the enforced skill gets no attribution —
    // applySkillEvidence cannot tell it shaped the trade. Log it like a real
    // injection (skills/<file> path) so attribution, lift and the dashboard
    // see it. Only when a username is supplied: tests and synthetic paths
    // stay silent unless they opt in.
    const recordEnforcement = (metas: SkillMeta[]): void => {
        if (!options?.username || metas.length === 0) return;
        const username = options.username;
        const sources = metas.map(m => ({
            path: `skills/${skillFileNameFor(m) ?? fileNameFromMeta(m)}`,
            kind: 'skill',
        }));
        // runId + holdout are REQUIRED, not optional metadata here:
        // skillAdherenceForRun joins records by runId, so an unstamped record
        // can never be attributed to the trade it shaped. Worse, the trade
        // then classifies as CONTROL and enters controlIds — a vetoed
        // holdout run poisoning the control group a second time, through the
        // evidence path rather than the enforcement path.
        void recordMemoryInjection(username, {
            stage: 'verdict',
            audience: 'moderator',
            coin: analysis.coinName,
            runId: options?.runId,
            holdout: false,
            sources,
        }).catch(() => { /* telemetry is best-effort */ });
    };

    const avoidConfirmed = ranked.find(m => m.kind === 'avoid' && m.status === 'confirmed');
    if (avoidConfirmed && (next.direction === 'Long' || next.direction === 'Short')) {
        next.originalConfidence = next.originalConfidence ?? next.confidence;
        next.confidence = 'Avoid';
        next.direction = 'Neutral';
        if (typeof next.probability === 'number') next.probability = Math.min(next.probability, 15);
        const vetoNote = `NOTEBOOK SKILL VETO: ${titleFromMeta(avoidConfirmed)} — when ${avoidConfirmed.when || avoidConfirmed.body.replace(/\s+/g, ' ').slice(0, 120)}`;
        warn(vetoNote);
        // Hard vetoes DO belong in riskVeto — this path genuinely blocks.
        next.riskVeto = [next.riskVeto, vetoNote].filter(Boolean).join(' ');
        recordEnforcement([avoidConfirmed]);
        return next;
    }

    const avoidCandidate = ranked.find(m => m.kind === 'avoid' && m.status === 'candidate'
        && (m.wins + m.losses) >= MIN_SAMPLE_FOR_VETO);
    if (avoidCandidate && (next.direction === 'Long' || next.direction === 'Short')) {
        next.originalConfidence = next.originalConfidence ?? next.confidence;
        if (next.confidence === 'High' || next.confidence === 'Medium') next.confidence = 'Low';
        // Candidate caps stay a WARNING: the setup remains tradeable at
        // reduced size — not a hard avoidance.
        warn(`NOTEBOOK SKILL: candidate avoid ${titleFromMeta(avoidCandidate)} — size down until the cluster confirms or retires.`);
        recordEnforcement([avoidCandidate]);
        return next;
    }

    const repeat = ranked.find(m => m.kind === 'repeat' && m.status === 'confirmed');
    if (repeat) {
        warn(`NOTEBOOK SKILL: confirmed repeat ${titleFromMeta(repeat)} — follow the procedure in skills, do not invent a new tape.`);
        recordEnforcement([repeat]);
    }
    return next;
};

export const confirmedAvoidForSetup = (
    setup: { coin?: string; direction?: string; family?: string; pattern?: string; regime?: string },
    runId?: string,
): SkillMeta | null => {
    // Same ε-holdout stand-down as applyNotebookSkillsToAnalysis: on a held-out
    // run this veto must not fire, or the control group is treated. Omitting
    // runId keeps every existing caller behaving exactly as before.
    if (shouldSkillHoldout(runId)) return null;
    // The same two readers as the analysis veto: enabled AND approved, and off when
    // the user switched enforcement off. This one HALTS a verdict, so it must never
    // fire on a rule the trader has not said yes to.
    if (getHarnessSettings().skillEnforcementEnabled === false) return null;
    const matches = getMemoryFiles().files
        .map(approvedSkillMeta)
        .filter((m): m is SkillMeta => Boolean(m && skillStrictlyMatchesSetup(m, setup)));
    return matches.find(m => m.kind === 'avoid' && m.status === 'confirmed') ?? null;
};

/**
 * The ACTUAL file name of the skill a parsed meta came from. Ledgers that
 * key skills by name (veto falsification) must use this, not a slug derived
 * from the title — title-derived slugs drift from fileNameFromMeta's
 * [coin, direction, family, kind] ordering and would never match.
 */
export const skillFileNameFor = (meta: SkillMeta): string | null => {
    for (const file of getMemoryFiles().files.filter(isSkillFile)) {
        const m = parseSkillMarkdown(file.content);
        if (!m) continue;
        if (
            m.kind === meta.kind
            && (m.coin ?? '') === (meta.coin ?? '')
            && (m.direction ?? '') === (meta.direction ?? '')
            && (m.family ?? '') === (meta.family ?? '')
            && (m.when ?? '') === (meta.when ?? '')
        ) {
            return file.name;
        }
    }
    return null;
};

// ─── Skill effectiveness review ─────────────────────────────────────────────
// Grades every skill on its realized W/L record and recommends an action.
// This closes the loop: skills are enforced in code (applyNotebookSkillsTo-
// Analysis), so their enforcement history must feed back into their status.

// ─── Applying review recommendations ────────────────────────────────────────

const applyReviewRecommendationUnlocked = async (
    fileId: string,
    recommendation: 'promote' | 'demote' | 'retire',
    username: string,
): Promise<boolean> => {
    const file = getMemoryFiles().files.find(f => f.id === fileId);
    const meta = file ? parseSkillMarkdown(file.content) : null;
    if (!file || !meta || meta.status === 'retired') return false;
    // Route through the temporal ledger so dashboard actions
    // stay visible to skillStatusAt replay queries — a manual promote/demote
    // used to be invisible to the audit trail.
    stampStatusTransition(meta, recommendation === 'promote'
        ? 'confirmed'
        : recommendation === 'demote' ? 'candidate' : 'retired', `manual-review:${recommendation}`);
    meta.status = recommendation === 'promote'
        ? 'confirmed'
        : recommendation === 'demote' ? 'candidate' : 'retired';
    meta.modifiedAt = new Date().toISOString();
    await updateMemoryFileUnlocked(fileId, {
        content: serializeSkill(meta, titleFromMeta(meta)),
        enabled: skillEnabledFlag(meta),
    }, username);
    return true;
};

/**
 * User-applied review action from the dashboard. Evidence keeps the final
 * say — the next applySkillEvidence pass re-derives status from counts, so a
 * manual promote of a stats-weak skill reverts unless outcomes back it up.
 */
export const applyReviewRecommendation = (
    fileId: string,
    recommendation: 'promote' | 'demote' | 'retire',
    username: string,
): Promise<boolean> =>
    withNotebookWriteLock(() => applyReviewRecommendationUnlocked(fileId, recommendation, username));

export interface SkillEffectiveness {
    fileId: string;
    title: string;
    kind: SkillKind;
    status: SkillStatus;
    wins: number;
    losses: number;
    hitRate: number | null;
    consecutiveLosses: number;
    /** What the loop should do next with this skill. */
    recommendation: 'keep' | 'watch' | 'refine' | 'demote' | 'retire' | 'promote';
    rationale: string;
    /** Causal A/B verdict from the automated eval (when one exists). */
    evalVerdict?: SkillMeta['evalVerdict'];
    /** Causal before/after win-rate verdict (when computable). */
    liftVerdict?: 'positive' | 'neutral' | 'negative' | 'insufficient-data';
    /** Mean realized R per measured outcome — undefined until the ledger holds
     *  EXPECTANCY_MIN_R_SAMPLE of them (skillExpectancyR), which is "not yet
     *  measured", never 0. */
    expectancyR?: number;
    /** The win rate claims an edge the R ledger contradicts: a repeat skill
     *  above a coin flip on non-positive expectancy, or an avoid skill below
     *  one on non-negative expectancy. Annotates the rationale; it never
     *  rewrites the recommendation on its own — the gate proper lives in
     *  deriveStatus, and the recommendation is the trader's click. */
    expectancyConflict?: boolean;
}

export interface SkillEffectivenessReviewOptions {
    /** Per-skill lift results (MemoryProvenanceService.computeAllSkillLifts), keyed by fileId. */
    liftByFileId?: Record<string, { lift: number | null; verdict: 'positive' | 'neutral' | 'negative' | 'insufficient-data' }>;
    /** Notebook file names ACTUALLY injected since tracking began (MemoryInjectionService). When provided, never-injected skills get an attribution caveat. */
    injectedFileNames?: Set<string>;
}

/**
 * Correlation (W/L counts) decides the base recommendation; causal signals —
 * the automated A/B eval and post-vs-pre lift — override it, because a skill
 * that correlates with wins but causes losses is worse than no skill at all.
 */
export const reviewSkillEffectiveness = (opts: SkillEffectivenessReviewOptions = {}): SkillEffectiveness[] => {
    return getMemoryFiles().files
        .map(file => {
            const meta = enabledSkillMeta(file);
            if (!meta) return null;
            const sample = meta.wins + meta.losses;
            const hitRate = skillHitRate(meta.wins, meta.losses);
            const title = titleFromMeta(meta);
            const lift = opts.liftByFileId?.[file.id];

            let recommendation: SkillEffectiveness['recommendation'] = 'keep';
            let rationale: string;

            if (sample === 0) {
                rationale = 'No closed-trade evidence yet — candidate stays unenforced until it earns a record.';
                recommendation = 'watch';
            } else if (meta.status === 'retired') {
                rationale = `Retired at ${meta.wins}W/${meta.losses}L — kept for the record, not enforced.`;
                recommendation = 'retire';
            } else if (meta.consecutiveLosses >= REFINE_AFTER_CONSECUTIVE_LOSSES && meta.status === 'confirmed') {
                rationale = `${meta.consecutiveLosses} straight losses — trigger/procedure needs an LLM refinement pass.`;
                recommendation = 'refine';
            } else if (sample >= MIN_SAMPLE_RETIRE && meta.kind === 'repeat' && (hitRate ?? 100) < 40) {
                rationale = `Repeat skill winning only ${hitRate}% over ${sample} trades — below the 40% retire bar.`;
                recommendation = 'retire';
            } else if (sample >= MIN_SAMPLE_RETIRE && meta.kind === 'avoid' && (hitRate ?? 0) > 60) {
                rationale = `Avoid skill losing ${hitRate}% of matched trades — the setup is actually tradeable; retire the veto.`;
                recommendation = 'retire';
            } else if (meta.status === 'candidate' && sample >= MIN_SAMPLE_CONFIRMED && (hitRate ?? 0) >= 60) {
                rationale = `Candidate holding ${hitRate}% over ${sample} trades — evidence supports confirming.`;
                recommendation = 'promote';
            } else if (meta.status === 'confirmed' && (hitRate ?? 100) < 50 && sample >= MIN_SAMPLE_CONFIRMED) {
                rationale = `Confirmed but under 50% (${meta.wins}W/${meta.losses}L) — consider demoting to candidate until it recovers.`;
                recommendation = 'demote';
            } else if ((hitRate ?? 0) < 55) {
                rationale = `Hit rate ${hitRate}% over ${sample} trades — keep, monitor next outcomes.`;
                recommendation = 'watch';
            } else {
                rationale = `Healthy at ${hitRate}% (${meta.wins}W/${meta.losses}L).`;
            }

            // ── Causal overrides (injection-causation outranks co-occurrence) ──
            const freshHurts = meta.evalVerdict === 'hurts' && evalDemotionActive(meta);
            if (freshHurts && (recommendation === 'keep' || recommendation === 'promote')) {
                recommendation = meta.status === 'confirmed' ? 'demote' : 'watch';
                rationale = `Automated A/B eval says the skill HURTS decisions${meta.evalDetail ? ` (${meta.evalDetail} flips misaligned)` : ''} — the causal signal outranks the ${hitRate ?? '?'}% outcome correlation.`;
            }
            if (lift?.verdict === 'negative' && (recommendation === 'keep' || recommendation === 'promote')) {
                recommendation = sample >= MIN_SAMPLE_CONFIRMED ? 'demote' : 'watch';
                rationale = `Post-influence win rate is ${lift.lift != null ? Math.round(Math.abs(lift.lift) * 100) : '?'}pp BELOW the pre-skill baseline — setups got worse once this skill started injecting.`;
            }
            if (!freshHurts && lift?.verdict === 'positive' && recommendation === 'watch' && sample > 0) {
                recommendation = 'keep';
                rationale = `${rationale} Lift +${lift.lift != null ? Math.round(lift.lift * 100) : '?'}pp over baseline supports it.`;
            }
            // Attribution caveat: evidence earned purely by setup match, when
            // we know the skill was never actually injected into a prompt.
            if (opts.injectedFileNames && !opts.injectedFileNames.has(file.name)
                && sample > 0 && recommendation === 'promote') {
                recommendation = 'watch';
                rationale = `${rationale} Caveat: never actually injected into a prompt since tracking began — its record is co-occurrence, not influence.`;
            }

            // ── Win rate vs the R ledger ──
            // Every branch above is graded on W/L, so a skill that banks a
            // small win and pays a bigger one reads as healthy indefinitely.
            // The R ledger is the only record that can see it, and the review
            // never looked.
            const expectancy = skillExpectancyR(meta);
            const conflictR = expectancyConflictR(meta);
            if (conflictR !== undefined) {
                rationale = `${rationale} Win rate claims an edge the R ledger contradicts (${conflictR > 0 ? '+' : ''}${conflictR}R per trade over ${meta.rSampled ?? 0} measured outcomes) — believe the R.`;
            }

            return {
                fileId: file.id,
                title,
                kind: meta.kind,
                status: meta.status,
                wins: Math.round(meta.wins),
                losses: Math.round(meta.losses),
                hitRate,
                consecutiveLosses: meta.consecutiveLosses,
                recommendation,
                rationale,
                ...(meta.evalVerdict ? { evalVerdict: meta.evalVerdict } : {}),
                ...(lift ? { liftVerdict: lift.verdict } : {}),
                ...(expectancy !== undefined ? { expectancyR: expectancy } : {}),
                ...(conflictR !== undefined ? { expectancyConflict: true } : {}),
            };
        })
        .filter((s): s is SkillEffectiveness => s !== null)
        .sort((a, b) => (a.hitRate ?? 2) - (b.hitRate ?? 2)); // weakest first
};

/**
 * Apply a queued proposal by its KIND — the one dispatcher both approval
 * surfaces call.
 *
 * The Skills queue and the Coach inbox each carried their own copy of this
 * branch, and they had already begun to drift in how they read the payload.
 * That is the failure mode this exists to remove: a proposal the human approved
 * in one place must not act differently because the other surface dispatches on
 * kind with a slightly different clause. Step C adds kinds; with one dispatcher
 * a new kind is wired once.
 *
 * Never throws: a failed write comes back as `write-failed` so the caller keeps
 * the row on screen rather than draining a proposal the library never took.
 */
export const applyLearningProposalByKind = async (
    proposal: { kind: string; skillSlug?: string; payload?: unknown },
    username: string,
): Promise<ProposalApplyResult> => {
    const slug = (name: string | undefined, fallback: string | undefined): string => name || fallback || '';
    try {
        switch (proposal.kind) {
            case 'displacement': {
                const p = proposal.payload as { displacedSlug?: string; challenger?: unknown } | undefined;
                return await applyDisplacementProposal(slug(p?.displacedSlug, proposal.skillSlug), username, p?.challenger as never);
            }
            case 'revival': {
                const p = proposal.payload as { slug?: string } | undefined;
                return await applyRevivalProposal(slug(p?.slug, proposal.skillSlug), username);
            }
            case 'demote': {
                const p = proposal.payload as { slug?: string } | undefined;
                return await applyDemoteProposal(slug(p?.slug, proposal.skillSlug), username);
            }
            case 'rescope': {
                // The trigger/procedure the PROPOSER wrote, applied as written.
                // This is what makes `revise_skill` actionable by a person at all.
                const c = proposal.payload as { when?: string; body?: string; predicate?: string } | undefined;
                return await applyRescopeProposal(proposal.skillSlug || '', {
                    when: c?.when,
                    body: c?.body,
                    predicate: c?.predicate,
                }, username);
            }
            default:
                return { applied: false, reason: 'no-clauses' };
        }
    } catch (e) {
        return { applied: false, reason: 'write-failed', error: e instanceof Error ? e.message : String(e) };
    }
};
