/**
 * harnessOptimization — the trader-gated harness-optimization pass
 * (Enhancement 3, 2026-11-18; Meta-RAM upgrade, 2026-11-19).
 *
 * WHY THIS EXISTS. 37 of 44 unverified prompt revisions failed their paper —
 * a revision proposed from one bad afternoon is noise wearing a diff. The
 * desk's own `propose_self_change` is gated by the trader sitting there; the
 * loop needed the same discipline on a clock. This pass reads the EVIDENCE
 * the ledger already grades (resolved signals, journal resolution records),
 * proposes AT MOST ONE revision when a thin-sample floor is met, and never
 * writes a prompt: the proposal is a Decision Card the trader approves, and
 * only an approval reaches `SelfModificationService › proposePromptChange`
 * (ledgered with the previous text, revertible — the rails that service
 * already owns).
 *
 * THE 3-STEP MAP-REDUCE (Meta-RAM, mirroring the paper's trajectory
 * analysis). Evidence is consolidated in three deterministic steps — no
 * model call on a timer:
 *   1. MAP per trade: every resolved fill in the window becomes a compact
 *      `ResolutionSummary` (the measured, entry-knowable facts only).
 *   2. MAP per session: summaries group by UTC session date into a
 *      `SessionDiagnosis` — the session's hit rate, its failure-kind counts,
 *      and the LOAD recipe that accompanied its signal fills.
 *   3. REDUCE across sessions: the diagnoses consolidate into proposal
 *      candidates. A kind qualifies at N ≥ 2 recurring failures (the same
 *      floor), and the card cites the session spread — one bad afternoon is
 *      still an anecdote, two sessions a pattern.
 *
 * MEMORY-POLICY KINDS. Beyond the placement kinds (entry slippage, stop gap,
 * stop swept) the reduce step can indict the MEMORY policy itself:
 *   - `regime-trap`: losses entered in a ranging/compressed regime whose
 *     adverse excursion reached ≥0.9R — the regime read named the noise.
 *   - `schema-gap`: losses on coins whose MARKET_SCHEMA index was absent at
 *     decision time — the seat entered without the units/funding/regime
 *     facts the index exists to carry. The pass backfills those schemas as
 *     notebook maintenance (the OFFLOAD discipline); the PROMPT rule still
 *     waits for the trader.
 *   - `recipe-blindspot`: a scan/plan/review LOAD recipe whose fills hit
 *     materially below the window's base rate — the slice that accompanied
 *     the misses is named, and the rule is a read-before-decide discipline.
 * Every revision is still ONE appended rule to the NAMED block
 * `analysis.risk_rules`, still entry-placeable, still trader-gated.
 *
 * THE HINDSIGHT SEPARATION. The outcomes used here are measured facts (the
 * fill's entry slippage, a stop that a gap blew through, a stop swept before
 * the target) — but the REVISIONS they justify are all ENTRY-TIME decisions:
 * where the entry fill was assumed, where the stop sat, what the seat should
 * have read first. A hindsight outcome may only ever propose an
 * entry-placeable fix; nothing here proposes to re-judge a trade after the
 * fact.
 *
 * THE HOLDOUT + THE RANKED PARENT POOL. An approved revision is measured
 * against the resolved signals that arrive AFTER it: when HOLDOUT_MIN_FILLS
 * have resolved, the post-approval hit rate is compared with the pre-approval
 * baseline; a regression beyond HOLDOUT_REGRESSION_PP flips the row to
 * 'revert-recommended'. Every approved revision also enters a lightweight
 * RANKED PARENT POOL with its measured holdout delta (hit rate vs base, in
 * probability points). When a new revision underperforms, the card offers a
 * ONE-TAP ROLLBACK to the highest-scoring prior parent — the rollback is the
 * trader's tap too, ledgered with the previous text, actor 'owner'.
 *
 * ISOLATION. Simulated paper fills never feed this pass: the evidence is
 * real-market outcomes (signal price resolutions and real journal rows).
 */

import { LoggedTrade } from '../../types/trade';
import { TradeOutcome } from '../../types/enums';
import type { SignalMemoryRecipe } from '../../types/signal';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { PROMPT_REGISTRY } from '../../constants/promptRegistry';
import { readSignals } from '../signals/signalLedger';
import { getActiveUsername } from '../../utils/activeUser';
import { getMemoryFiles } from '../learning/MemoryFilesService';
import { collectMarketSchemaFacts, learnedSchemaTraps, syncMarketSchema, MARKET_SCHEMA_FOLDER } from '../learning/MarketSchemaService';
import { getPrompt, savePromptOverride } from '../infrastructure/PromptOverrideService';
import { writeSelfChange, liveSelfChanges } from './SelfChangeLedger';
import { SelfChangeSchema } from '../../schemas/selfChange';

const KEY_PREFIX = 'harness_optimization_v1_';

/** How often the pass may look for a new proposal. One proposal candidate per
 *  day, and never while one is pending or measuring — a prompt block cannot
 *  absorb two competing edits at once. */
export const HARNESS_OPTIMIZATION_INTERVAL_MS = 24 * 3600_000;

/** The thin-sample floor (Enhancement 3): N ≥ 2 recurring entry-knowable
 *  failures of the SAME kind before anything may be proposed. Two is the
 *  floor the owner set for the MVP — a single instance is an anecdote. */
export const MIN_RECURRING_FAILURES = 2;

/** The holdout window: resolved FILLS (won/lost/expired — `never_triggered`
 *  is not a fill) after approval before the verdict is even computed. */
export const HOLDOUT_MIN_FILLS = 6;

/** Post-approval hit-rate regression, in probability points, that flips the
 *  row to revert-recommended. 10pp over ≥6 fills: noise around a small
 *  sample, so the bar is deliberately high. */
export const HOLDOUT_REGRESSION_PP = 0.10;

/** The ONE prompt block this pass may propose revisions to. It governs the
 *  risk rules every analysis seat reads (entry/stop/sizing) — the entry-time
 *  decisions the evidence can actually indict. Widening this list is a
 *  product decision, not a code change. */
export const TARGET_PROMPT_ID = 'analysis.risk_rules';

/** Where the signal lookback stops. Failures older than this are stale
 *  evidence for a harness that changes underneath them. */
const EVIDENCE_WINDOW_MS = 30 * 24 * 3600_000;

/** The parent pool's cap — a lightweight ranked history, not a second
 *  ledger. The self-change ledger keeps the full audit; the pool keeps the
 *  rollback candidates. */
export const PARENT_POOL_MAX = 8;

/** A recipe needs this many graded fills before its hit rate may indict it
 *  (the same small-sample discipline as the holdout). */
export const RECIPE_MIN_FILLS = 4;
/** The recipe hit-rate gap vs the window base rate, in probability points,
 *  that makes a recipe a blind-spot candidate. */
export const RECIPE_REGRESSION_PP = 0.10;

export type HarnessFailureKind =
    | 'entry-slippage' | 'stop-gap' | 'stop-swept'
    | 'regime-trap' | 'schema-gap' | 'recipe-blindspot';

export interface HarnessFailureEvidence {
    id: string;
    source: 'signal' | 'journal';
    /** The measured, entry-knowable fact — verbatim, for the card. */
    fact: string;
    outcome: 'LOSS' | 'loss';
    at: number;
}

export type HarnessProposalStatus = 'pending' | 'approved' | 'dismissed' | 'revert-recommended';

export interface HarnessHoldoutState {
    fills: number;
    won: number;
    lost: number;
    expired: number;
    hitRate: number | null;
    evaluatedAt?: string;
}

/** One ranked rollback candidate: a previously approved harness revision
 *  with its measured post-approval holdout delta vs its own baseline. */
export interface HarnessParent {
    /** The proposal id this parent was approved from. */
    id: string;
    promptId: string;
    /** The FULL approved block text — what a rollback restores. */
    text: string;
    kind: HarnessFailureKind;
    approvedAt: string;
    /** The self-change ledger row that applied it. */
    ledgerId: string;
    baseline: { hitRate: number | null; samples: number };
    /** Frozen at revert; live while the revision is in force. */
    holdout: HarnessHoldoutState | null;
    /** (holdout.hitRate − baseline.hitRate) × 100, once graded. Null while
     *  measuring or when either rate is thin. */
    deltaPp: number | null;
    status: 'measuring' | 'graded' | 'reverted';
}

/** The map-reduce diagnosis the card prints — the evidence's shape, not a
 *  prose wall. Optional on stored rows (pre-upgrade proposals lack it). */
export interface HarnessDiagnosis {
    sessions: number;
    fills: number;
    won: number;
    lost: number;
    /** Per-kind failure counts across the window's sessions. */
    kindCounts: Partial<Record<HarnessFailureKind, number>>;
    /** The session keys the qualifying kind appeared in. */
    sessionSpread: string[];
}

export interface HarnessOptimizationState {
    /** ISO timestamp of the last PASS that looked (due-check clock). */
    lastPassAt: string;
    /** At most ONE proposal is live at a time (pending, approved or
     *  revert-recommended) — the newest row wins the slot. */
    proposal?: {
        id: string;
        status: HarnessProposalStatus;
        kind: HarnessFailureKind;
        /** The prompt block this revision names. */
        promptId: string;
        /** The live block text the revision starts from (the card's "before"). */
        before: string;
        /** The proposed text (the card's "after"; the diff is `before` → this). */
        after: string;
        /** The trader-facing reason, with the evidence cited. */
        reason: string;
        evidence: HarnessFailureEvidence[];
        createdAt: string;
        baseline: { hitRate: number | null; samples: number };
        /** Set on approval — the SelfChangeLedger row id (1-tap revert reads it). */
        ledgerId?: string;
        approvedAt?: string;
        holdout?: HarnessHoldoutState;
        /** Set on a revert-recommended row: why the holdout said so. */
        revertReason?: string;
        /** The 3-step map-reduce diagnosis (Meta-RAM upgrade). */
        diagnosis?: HarnessDiagnosis;
    };
    /** Proposal history the slot's one-at-a-time rule does not erase (newest
     *  last, capped). Terminal rows only. */
    history?: Array<{ id: string; status: 'approved' | 'dismissed' | 'revert-recommended'; decidedAt: string; kind: HarnessFailureKind; ledgerId?: string }>;
    /** The ranked parent pool — approved revisions with measured deltas. */
    parentPool?: HarnessParent[];
}

const emptyState = (): HarnessOptimizationState => ({ lastPassAt: new Date(0).toISOString() });

const keyFor = (username: string): string => `${KEY_PREFIX}${username}`;

const loadState = async (username: string): Promise<HarnessOptimizationState> => {
    try {
        const s = await getPreferenceObject<HarnessOptimizationState>(keyFor(username));
        return s && typeof s.lastPassAt === 'string' ? s : emptyState();
    } catch {
        return emptyState();
    }
};

const saveState = async (username: string, state: HarnessOptimizationState): Promise<void> => {
    await setPreferenceObject(keyFor(username), state);
};

/** The stored state for the Journal card (null when the pass never ran and
 *  no parent pool exists — the card renders the pool even between proposals,
 *  because a rollback is the trader's to make at any time). */
export const loadHarnessOptimizationState = async (username: string): Promise<HarnessOptimizationState | null> => {
    try {
        const s = await getPreferenceObject<HarnessOptimizationState>(keyFor(username));
        if (!s) return null;
        return (s.proposal || (s.parentPool && s.parentPool.length > 0)) ? s : null;
    } catch {
        return null;
    }
};

// ─── Step 1 (MAP per trade): resolution summaries ──────────────────────────

export interface ResolutionSummary {
    id: string;
    source: 'signal' | 'journal';
    coin: string;
    direction: string;
    /** UTC session date of the RESOLUTION (the session it taught). */
    sessionKey: string;
    at: number;
    outcomeR: number | null;
    won: boolean;
    /** The LOAD recipe that accompanied a signal fill, when stamped. */
    recipeId?: SignalMemoryRecipe['id'];
    /** Measured, entry-knowable facts. */
    entryOpenR?: number;
    gapAdjusted?: boolean;
    stopSwept?: boolean;
    regimeAtEntry?: string;
    maeR?: number;
    /** Whether the coin's MARKET_SCHEMA index existed at decision time.
     *  Computed by the pass's presence reader; undefined = not assessed. */
    schemaPresentAtDecision?: boolean;
}

interface SignalRowLike {
    signal: { id: string; coin: string; direction: string; emittedAt: number; memoryRecipe?: SignalMemoryRecipe };
    resolution?: { status: string; outcomeR: number; entryOpenR?: number; gapAdjusted?: boolean; at: number } | undefined;
}

const sessionKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Regime words that mean "the tape was ranging/compressed at entry". */
const RANGE_REGIME_WORDS = new Set(['range', 'ranging', 'compressed', 'compression', 'neutral']);

/**
 * STEP 1 — one compact summary per resolved fill in the window. Real
 * evidence only: a simulated paper fill is excluded outright (its outcome
 * is about the fill model, not the market). Pure given its inputs; the
 * schema-presence reader is injected so the contract check can pin the
 * shape without a notebook.
 */
export const summarizeResolutions = (
    trades: LoggedTrade[],
    signals: SignalRowLike[],
    now: number = Date.now(),
    schemaPresence?: (coin: string, atMs: number) => boolean,
): ResolutionSummary[] => {
    const cutoff = now - EVIDENCE_WINDOW_MS;
    const out: ResolutionSummary[] = [];
    for (const row of signals ?? []) {
        const r = row.resolution;
        if (!r || r.status === 'never_triggered') continue;
        if (r.at < cutoff) continue;
        out.push({
            id: row.signal.id,
            source: 'signal',
            coin: row.signal.coin,
            direction: row.signal.direction,
            sessionKey: sessionKeyOf(r.at),
            at: r.at,
            outcomeR: r.outcomeR,
            won: r.status === 'won',
            ...(row.signal.memoryRecipe ? { recipeId: row.signal.memoryRecipe.id } : {}),
            ...(typeof r.entryOpenR === 'number' ? { entryOpenR: r.entryOpenR } : {}),
            ...(r.gapAdjusted === true ? { gapAdjusted: true } : {}),
        });
    }
    for (const t of trades ?? []) {
        if (t.simulated === true) continue;
        if (t.outcome !== TradeOutcome.WIN && t.outcome !== TradeOutcome.LOSS) continue;
        const at = Date.parse(t.outcomeResolvedAt ?? t.timestamp ?? '');
        if (!Number.isFinite(at) || at < cutoff) continue;
        const r = t.resolutionRecord;
        out.push({
            id: t.id,
            source: 'journal',
            coin: t.analysis?.coinName ?? '?',
            direction: t.analysis?.direction ?? '?',
            sessionKey: sessionKeyOf(at),
            at,
            outcomeR: null,
            won: t.outcome === TradeOutcome.WIN,
            ...(r?.slHitThenReversedToTp === true ? { stopSwept: true } : {}),
            ...(r?.regimeAtEntry ? { regimeAtEntry: r.regimeAtEntry } : {}),
            ...(typeof r?.maeR === 'number' ? { maeR: r.maeR } : {}),
            ...(schemaPresence ? { schemaPresentAtDecision: schemaPresence(t.analysis?.coinName ?? '', at) } : {}),
        });
    }
    return out.sort((a, b) => b.at - a.at);
};

/** The per-trade kind detection — ONE source for the placement kinds and
 *  the regime/schema memory-policy kinds. Only a LOSS carries a failure
 *  kind: a win, or an expired fill that closed at/above zero, is not
 *  evidence against the harness (the pre-upgrade floor, preserved). */
export const kindsForSummary = (s: ResolutionSummary): HarnessFailureKind[] => {
    const isLoss = !s.won && (s.outcomeR === null || s.outcomeR < 0);
    if (!isLoss) return [];
    const kinds: HarnessFailureKind[] = [];
    if (typeof s.entryOpenR === 'number' && s.entryOpenR <= -0.25) kinds.push('entry-slippage');
    if (s.gapAdjusted === true) kinds.push('stop-gap');
    if (s.stopSwept === true) kinds.push('stop-swept');
    const regime = (s.regimeAtEntry ?? '').toLowerCase().trim();
    if (RANGE_REGIME_WORDS.has(regime) && typeof s.maeR === 'number' && s.maeR >= 0.9) kinds.push('regime-trap');
    if (s.schemaPresentAtDecision === false) kinds.push('schema-gap');
    return kinds;
};

// ─── Step 2 (MAP per session): run diagnoses ───────────────────────────────

export interface SessionDiagnosis {
    sessionKey: string;
    fills: number;
    won: number;
    lost: number;
    hitRate: number | null;
    kindCounts: Partial<Record<HarnessFailureKind, number>>;
    /** Per-recipe fill counts — the attribution half of the blind-spot read. */
    recipeFills: Partial<Record<NonNullable<ResolutionSummary['recipeId']>, { fills: number; won: number }>>;
    coins: string[];
}

/** STEP 2 — group the summaries by session and diagnose each run. */
export const diagnoseSessions = (summaries: ResolutionSummary[]): SessionDiagnosis[] => {
    const bySession = new Map<string, ResolutionSummary[]>();
    for (const s of summaries) {
        bySession.set(s.sessionKey, [...(bySession.get(s.sessionKey) ?? []), s]);
    }
    const out: SessionDiagnosis[] = [];
    for (const [sessionKey, rows] of bySession) {
        const won = rows.filter(r => r.won).length;
        const kindCounts: Partial<Record<HarnessFailureKind, number>> = {};
        const recipeFills: SessionDiagnosis['recipeFills'] = {};
        for (const r of rows) {
            for (const k of kindsForSummary(r)) {
                kindCounts[k] = (kindCounts[k] ?? 0) + 1;
            }
            if (r.recipeId) {
                const cur = recipeFills[r.recipeId] ?? { fills: 0, won: 0 };
                recipeFills[r.recipeId] = { fills: cur.fills + 1, won: cur.won + (r.won ? 1 : 0) };
            }
        }
        out.push({
            sessionKey,
            fills: rows.length,
            won,
            lost: rows.length - won,
            hitRate: rows.length > 0 ? won / rows.length : null,
            kindCounts,
            recipeFills,
            coins: [...new Set(rows.map(r => r.coin))],
        });
    }
    return out.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
};

// ─── Step 3 (REDUCE across sessions): consolidation ────────────────────────

export interface HarnessCandidate {
    kind: HarnessFailureKind;
    evidence: HarnessFailureEvidence[];
    lastAt: number;
    /** The sessions the kind appeared in — the cross-session spread. */
    sessionSpread: string[];
    /** recipe-blindspot only: the measured recipe stats. */
    recipeStats?: { recipeId: string; fills: number; hitRate: number; baseRate: number };
}

const factFor = (s: ResolutionSummary, kind: HarnessFailureKind): string => {
    const head = `${s.coin} ${s.direction}`;
    switch (kind) {
        case 'entry-slippage':
            return `${head}: filled ${((s.entryOpenR ?? 0) * -1).toFixed(2)}R worse than the assumed entry at the trigger bar's open`;
        case 'stop-gap':
            return `${head}: the exit bar opened beyond the stop — the fill cost more than 1R (gap-adjusted)`;
        case 'stop-swept':
            return `${head}: the stop was touched and price still reached the target`;
        case 'regime-trap':
            return `${head}: entered in ${s.regimeAtEntry} with ${(s.maeR ?? 0).toFixed(2)}R adverse excursion — the regime read named the noise`;
        case 'schema-gap':
            return `${head}: entered with no market-schema index for the coin — units/funding/regime conventions unread`;
        case 'recipe-blindspot':
            return `${head}: a ${s.recipeId ?? '?'}-context fill that lost`;
    }
};

/**
 * STEP 3 — consolidate the session diagnoses into proposal candidates.
 * The placement + regime + schema kinds qualify at the N ≥ 2 floor; the
 * recipe blind spot needs its own small-sample floor and a measured gap
 * against the window's base rate. Most recent qualifying kind first.
 */
export const consolidateDiagnoses = (
    diagnoses: SessionDiagnosis[],
    summaries: ResolutionSummary[],
): HarnessCandidate[] => {
    const byKind = new Map<HarnessFailureKind, { evidence: HarnessFailureEvidence[]; sessions: Set<string>; lastAt: number }>();
    for (const s of summaries) {
        for (const kind of kindsForSummary(s)) {
            const cur = byKind.get(kind) ?? { evidence: [], sessions: new Set<string>(), lastAt: 0 };
            cur.evidence.push({ id: s.id, source: s.source, outcome: s.source === 'journal' ? 'LOSS' : 'loss', at: s.at, fact: factFor(s, kind) });
            cur.sessions.add(s.sessionKey);
            cur.lastAt = Math.max(cur.lastAt, s.at);
            byKind.set(kind, cur);
        }
    }
    const candidates: HarnessCandidate[] = [];
    for (const [kind, cur] of byKind) {
        if (cur.evidence.length < MIN_RECURRING_FAILURES) continue;
        candidates.push({
            kind,
            evidence: cur.evidence.sort((a, b) => b.at - a.at),
            lastAt: cur.lastAt,
            sessionSpread: [...cur.sessions].sort(),
        });
    }

    // The recipe blind spot: a LOAD recipe whose fills hit materially below
    // the window's base rate. Base = every graded fill in the window.
    const baseWon = summaries.filter(s => s.won).length;
    const baseRate = summaries.length > 0 ? baseWon / summaries.length : null;
    if (baseRate !== null) {
        const recipeTotals = new Map<string, { fills: number; won: number; lastAt: number; evidence: HarnessFailureEvidence[]; sessions: Set<string> }>();
        for (const s of summaries) {
            if (!s.recipeId) continue;
            const cur = recipeTotals.get(s.recipeId) ?? { fills: 0, won: 0, lastAt: 0, evidence: [], sessions: new Set<string>() };
            cur.fills += 1;
            cur.won += s.won ? 1 : 0;
            cur.lastAt = Math.max(cur.lastAt, s.at);
            cur.sessions.add(s.sessionKey);
            if (!s.won) cur.evidence.push({ id: s.id, source: s.source, outcome: 'loss', at: s.at, fact: factFor(s, 'recipe-blindspot') });
            recipeTotals.set(s.recipeId, cur);
        }
        for (const [recipeId, cur] of recipeTotals) {
            if (cur.fills < RECIPE_MIN_FILLS) continue;
            const hitRate = cur.won / cur.fills;
            if (hitRate > baseRate - RECIPE_REGRESSION_PP) continue;
            if (cur.evidence.length < MIN_RECURRING_FAILURES) continue;
            candidates.push({
                kind: 'recipe-blindspot',
                evidence: cur.evidence.sort((a, b) => b.at - a.at),
                lastAt: cur.lastAt,
                sessionSpread: [...cur.sessions].sort(),
                recipeStats: { recipeId, fills: cur.fills, hitRate, baseRate },
            });
        }
    }
    void diagnoses; // the spread is carried per candidate; diagnoses feed the card's strip
    return candidates.sort((a, b) => b.lastAt - a.lastAt);
};

// ─── The rule lines (one per kind) ─────────────────────────────────────────

interface KindSpec {
    kind: HarnessFailureKind;
    /** The appended rule line — the WHOLE revision (one concrete edit). */
    ruleLine: string;
    /** Why this outcome indicts an entry-time decision. */
    rationale: string;
}

const KIND_SPECS: Record<HarnessFailureKind, KindSpec> = {
    'entry-slippage': {
        kind: 'entry-slippage',
        ruleLine: 'Entry placement: assume the fill at the bar that TRIGGERED the setup, not inside the move it started — if the last entries slipped against the position at the trigger bar\'s open (entryOpenR well below 0), wait for the retest or move the limit into the range the open actually printed.',
        rationale: 'The fill arrived worse than the assumed entry the moment the position opened — a placement decision, knowable at entry.',
    },
    'stop-gap': {
        kind: 'stop-gap',
        ruleLine: 'Stop placement: set the stop where a single bar\'s open cannot blow through it — a stop the exit bar gapped past fills at the open and costs more than the planned 1R. Put it beyond the recent gap range or size the position for the wider fill.',
        rationale: 'The stop was reachable by one bar\'s open — a placement decision, knowable at entry.',
    },
    'stop-swept': {
        kind: 'stop-swept',
        ruleLine: 'Stop placement: a stop swept before the target was reached means it sat inside the setup\'s noise — give the trade room beyond the swept liquidity (or cut size instead of cutting distance), and re-check that the entry did not precede confirmation.',
        rationale: 'The stop was touched and price still reached the target — the stop sat inside the noise the entry stepped into.',
    },
    'regime-trap': {
        kind: 'regime-trap',
        ruleLine: 'Regime discipline: the recent losses entered in range/compression with ≥0.9R adverse excursion — in a ranging tape, place the stop beyond the range\'s swept edge or skip the continuation entry entirely; the regime read named the noise before entry, so an entry inside it is a decision, not an accident.',
        rationale: 'The regime read was available at entry and named the noise the stop sat in — a memory-policy failure the schema now carries.',
    },
    'schema-gap': {
        kind: 'schema-gap',
        ruleLine: 'Market schema first: before an entry on a coin whose market-schema index is absent, read its units, funding clock and regime conventions (recall the coin) — the recent losses entered without those facts, and a stop or size that ignores the tick/funding clock is a guess.',
        rationale: 'The losses entered on coins with no MARKET_SCHEMA index at decision time — the facts were missing, not misread.',
    },
    'recipe-blindspot': {
        kind: 'recipe-blindspot',
        ruleLine: 'LOAD discipline: the leaner read context accompanied losing fills below the window base rate — before answering a scan-style read on a coin with logged losses, pull the coin\'s diary and recurring-mistakes line (recall) instead of answering from the chart alone; the lesson was already written.',
        rationale: 'The recipe attribution shows one LOAD slice accompanying misses materially below the base rate — a read-before-decide fix.',
    },
};

/** Collect the failure kinds that meet the N ≥ 2 floor in the evidence
 *  window, most recent first. Exported for the contract check — the
 *  pre-upgrade placement-kind shape, now derived from the SAME per-trade
 *  detection the map-reduce uses (one source, two views). */
export const collectFailureKinds = (
    trades: LoggedTrade[],
    signals: Array<{ signal: { id: string; coin: string; direction: string; emittedAt: number }; resolution?: { status: string; outcomeR: number; entryOpenR?: number; gapAdjusted?: boolean; at: number } | undefined }>,
    now = Date.now(),
): Array<{ spec: KindSpec; evidence: HarnessFailureEvidence[]; lastAt: number }> => {
    const summaries = summarizeResolutions(trades, signals, now);
    const byKind = new Map<HarnessFailureKind, HarnessFailureEvidence[]>();
    for (const s of summaries) {
        for (const kind of kindsForSummary(s)) {
            // The pinned fast path names the three placement kinds; the
            // memory-policy kinds ride the map-reduce path only.
            if (kind !== 'entry-slippage' && kind !== 'stop-gap' && kind !== 'stop-swept') continue;
            byKind.set(kind, [...(byKind.get(kind) ?? []), {
                id: s.id, source: s.source, outcome: s.source === 'journal' ? 'LOSS' : 'loss', at: s.at, fact: factFor(s, kind),
            }]);
        }
    }
    return [...byKind.entries()]
        .filter(([, ev]) => ev.length >= MIN_RECURRING_FAILURES)
        .map(([kind, ev]) => ({
            spec: KIND_SPECS[kind],
            evidence: ev.sort((a, b) => b.at - a.at),
            lastAt: Math.max(...ev.map(e => e.at)),
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
};

// ─── Baseline + holdout ─────────────────────────────────────────────────────

interface FillRow { status: string; outcomeR: number; at: number }

const hitRateOf = (fills: FillRow[]): number | null => {
    const graded = fills.filter(f => f.status === 'won' || f.status === 'lost' || f.status === 'expired');
    if (graded.length === 0) return null;
    const won = graded.filter(f => f.status === 'won').length;
    return won / graded.length;
};

/** The pre-approval baseline: hit rate over resolved fills INSIDE the same
 *  window the failures came from. Null when nothing has filled (thin) — the
 *  proposal may still stand, and the holdout verdict waits for a baseline. */
export const baselineHitRate = (signals: Array<{ resolution?: FillRow | undefined }>, now = Date.now()): { hitRate: number | null; samples: number } => {
    const cutoff = now - EVIDENCE_WINDOW_MS;
    const fills = signals
        .map(s => s.resolution)
        .filter((r): r is FillRow => Boolean(r) && r!.status !== 'never_triggered' && r!.at >= cutoff);
    return { hitRate: hitRateOf(fills), samples: fills.length };
};

// ─── The parent pool ────────────────────────────────────────────────────────

/** Rank: graded parents by measured delta (best first), ties by recency.
 *  A reverted parent keeps its measured delta — it is still a candidate;
 *  "reverted" says it is not live, not that it was wrong. */
export const rankParents = (pool: HarnessParent[]): HarnessParent[] =>
    [...pool]
        .filter(p => p.deltaPp !== null)
        .sort((a, b) => (b.deltaPp! - a.deltaPp!) || b.approvedAt.localeCompare(a.approvedAt));

const gradeParent = (p: HarnessParent): void => {
    if (p.holdout && p.holdout.fills >= HOLDOUT_MIN_FILLS
        && p.holdout.hitRate !== null && p.baseline.hitRate !== null) {
        p.deltaPp = Math.round((p.holdout.hitRate - p.baseline.hitRate) * 100);
        p.status = 'graded';
    }
};

/** The notebook reader the pass injects into step 1: did the coin's
 *  MARKET_SCHEMA index exist at decision time? A file created AFTER the
 *  decision was absent when it mattered. */
const schemaPresenceReader = (coin: string, atMs: number): boolean => {
    try {
        const clean = (coin || '').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
        if (!clean) return true; // no coin named — nothing to indict
        const { files, folders } = getMemoryFiles();
        const folder = folders.find(f => f.name === MARKET_SCHEMA_FOLDER);
        if (!folder) return false;
        const strip = (name: string): string => name.replace(/\.md$/i, '').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
        const file = files.find(f => f.folderId === folder.id && strip(f.name) === clean)
            ?? files.find(f => f.folderId === folder.id && strip(f.name) === `${clean}USDT`)
            ?? files.find(f => f.folderId === folder.id && strip(f.name).startsWith(clean));
        if (!file) return false;
        return file.createdAt <= atMs;
    } catch {
        return true; // an unreadable notebook indicts nothing
    }
};

// ─── The pass ───────────────────────────────────────────────────────────────

/** Run one pass. Best-effort, deterministic, no model call: it reads the
 *  ledger, the journal and the registry. Due every
 *  HARNESS_OPTIMIZATION_INTERVAL_MS; skips while a proposal is live or under
 *  holdout. Returns the state (or null when nothing ran / nothing changed). */
export const runHarnessOptimizationPass = async (
    username: string = getActiveUsername(),
    trades: LoggedTrade[] = [],
    now = Date.now(),
): Promise<HarnessOptimizationState | null> => {
    if (!username) return null;
    const state = await loadState(username);
    const last = Date.parse(state.lastPassAt);
    if (Number.isFinite(last) && now - last < HARNESS_OPTIMIZATION_INTERVAL_MS) return null;
    state.lastPassAt = new Date(now).toISOString();

    const rows = readSignals(username);
    const fills = rows
        .map(r => r.resolution)
        .filter((r): r is NonNullable<typeof r> => Boolean(r));

    // 1. Holdout first: an approved revision keeps measuring no matter what.
    //    The matching parent pool entry measures on the SAME window.
    if (state.proposal?.status === 'approved' || state.proposal?.status === 'revert-recommended') {
        const p = state.proposal;
        const approvedAt = p.approvedAt ? Date.parse(p.approvedAt) : NaN;
        if (Number.isFinite(approvedAt)) {
            const post = fills.filter(r => r.at >= approvedAt);
            const won = post.filter(r => r.status === 'won').length;
            const lost = post.filter(r => r.status === 'lost').length;
            const expired = post.filter(r => r.status === 'expired').length;
            const holdoutFills = won + lost + expired;
            p.holdout = { fills: post.length, won, lost, expired, hitRate: hitRateOf(post) };
            const parent = (state.parentPool ?? []).find(x => x.id === p.id);
            if (parent) {
                parent.holdout = { ...p.holdout };
                gradeParent(parent);
            }
            if (holdoutFills >= HOLDOUT_MIN_FILLS
                && p.holdout.hitRate !== null
                && p.baseline.hitRate !== null
                && p.holdout.hitRate < p.baseline.hitRate - HOLDOUT_REGRESSION_PP) {
                if (p.status !== 'revert-recommended') {
                    p.status = 'revert-recommended';
                    p.revertReason = `holdout hit rate ${(p.holdout.hitRate * 100).toFixed(0)}% vs baseline ${(p.baseline.hitRate * 100).toFixed(0)}% over ${holdoutFills} fills — below the ${(HOLDOUT_REGRESSION_PP * 100).toFixed(0)}pp regression bar`;
                    console.log('[HarnessOpt] revert recommended:', p.revertReason);
                }
            }
            await saveState(username, state);
            return state;
        }
    }

    // 2. One live proposal at a time — pending, approved or measuring all
    //    occupy the slot.
    if (state.proposal && (state.proposal.status === 'pending' || state.proposal.status === 'approved'
        || state.proposal.status === 'revert-recommended')) {
        await saveState(username, state);
        return null;
    }

    // 3. The 3-step map-reduce: per-trade summaries → per-session diagnoses
    //    → cross-session consolidation. The evidence floor lives in the
    //    reduce step (N ≥ 2 of one kind; the recipe kind has its own floor).
    const summaries = summarizeResolutions(trades, rows, now, schemaPresenceReader);
    const diagnoses = diagnoseSessions(summaries);
    const candidates = consolidateDiagnoses(diagnoses, summaries);
    if (candidates.length === 0) {
        await saveState(username, state);
        return null;
    }

    // 4. ONE proposal: the most recent qualifying kind. The revision is the
    //    rule line appended to the LIVE block text — a concrete, diffable
    //    edit to a NAMED prompt block.
    const cand = candidates[0];
    const spec = KIND_SPECS[cand.kind];
    const entry = PROMPT_REGISTRY.find(p => p.id === TARGET_PROMPT_ID);
    if (!entry) {
        await saveState(username, state);
        return null;
    }
    const before = getPrompt(TARGET_PROMPT_ID, entry.fallback);
    const after = `${before.trimEnd()}\n\n${spec.ruleLine}`;
    const baseline = baselineHitRate(rows, now);

    // schema-gap: the missing facts are notebook maintenance — backfill the
    // indicted coins' schemas now (bounded, the OFFLOAD discipline). The
    // PROMPT rule still waits for the trader's tap.
    if (cand.kind === 'schema-gap') {
        const gapCoins = [...new Set(summaries
            .filter(s => !s.won && s.schemaPresentAtDecision === false)
            .map(s => s.coin))]
            .filter(c => typeof c === 'string' && c.length >= 2)
            .slice(0, 3);
        for (const coin of gapCoins) {
            try {
                const facts = await collectMarketSchemaFacts(coin);
                facts.traps = learnedSchemaTraps(coin, trades);
                await syncMarketSchema(coin, facts, username);
            } catch (e) {
                console.warn('[HarnessOpt] schema backfill failed for', coin, e instanceof Error ? e.message : e);
            }
        }
    }

    const kindCounts: HarnessDiagnosis['kindCounts'] = {};
    for (const d of diagnoses) {
        for (const [k, n] of Object.entries(d.kindCounts)) {
            kindCounts[k as HarnessFailureKind] = (kindCounts[k as HarnessFailureKind] ?? 0) + (n ?? 0);
        }
    }
    const spreadNote = cand.sessionSpread.length > 1
        ? ` across ${cand.sessionSpread.length} sessions (${cand.sessionSpread.join(', ')})`
        : ` in session ${cand.sessionSpread[0] ?? '?'}`;
    const recipeNote = cand.recipeStats
        ? ` The ${cand.recipeStats.recipeId} recipe hit ${(cand.recipeStats.hitRate * 100).toFixed(0)}% over ${cand.recipeStats.fills} fills vs the window's ${(cand.recipeStats.baseRate * 100).toFixed(0)}%.`
        : '';
    state.proposal = {
        id: `harness-opt-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'pending',
        kind: spec.kind,
        promptId: TARGET_PROMPT_ID,
        before,
        after,
        reason: `${spec.rationale} ${cand.evidence.length} recent failures of this kind${spreadNote} (newest: ${cand.evidence[0].fact}).${recipeNote} ${baseline.samples > 0 && baseline.hitRate !== null ? `Baseline hit rate over the same window: ${(baseline.hitRate * 100).toFixed(0)}% (${baseline.samples} fills).` : 'No resolved fills in the window yet — the holdout will grade the revision once signals resolve.'}`,
        evidence: cand.evidence.slice(0, 6),
        createdAt: new Date(now).toISOString(),
        baseline,
        diagnosis: {
            sessions: diagnoses.length,
            fills: summaries.length,
            won: summaries.filter(s => s.won).length,
            lost: summaries.filter(s => !s.won).length,
            kindCounts,
            sessionSpread: cand.sessionSpread,
        },
    };
    await saveState(username, state);
    console.log('[HarnessOpt] proposal staged:', spec.kind, cand.evidence.length, 'failures — awaiting the trader');
    return state;
};

// ─── The trader's decisions ─────────────────────────────────────────────────

/** Approve: the ONE path from card to prompt. Calls
 *  `SelfModificationService › proposePromptChange` — applied, ledgered with
 *  the previous text, revertible — and stamps the holdout clock. The self-mod
 *  rails still own the gate: with the mode OFF this refuses and the card
 *  shows why. The approved revision enters the ranked parent pool. */
export const approveHarnessRevision = async (
    username: string = getActiveUsername(),
): Promise<{ ok: boolean; error?: string }> => {
    if (!username) return { ok: false, error: 'no active trader' };
    const state = await loadState(username);
    const p = state.proposal;
    if (!p || p.status !== 'pending') return { ok: false, error: 'no pending proposal to approve' };
    const { proposePromptChange } = await import('./SelfModificationService');
    const res = await proposePromptChange(p.promptId, p.after, p.reason, { actor: 'agent' });
    if (!res.ok) return { ok: false, error: res.error };
    p.status = 'approved';
    p.ledgerId = res.change.id;
    p.approvedAt = new Date().toISOString();
    p.holdout = { fills: 0, won: 0, lost: 0, expired: 0, hitRate: null };
    state.parentPool = [
        ...(state.parentPool ?? []),
        {
            id: p.id,
            promptId: p.promptId,
            text: p.after,
            kind: p.kind,
            approvedAt: p.approvedAt,
            ledgerId: res.change.id,
            baseline: { ...p.baseline },
            holdout: { ...p.holdout },
            deltaPp: null,
            status: 'measuring' as const,
        },
    ].slice(-PARENT_POOL_MAX);
    await saveState(username, state);
    console.log('[HarnessOpt] approved:', p.ledgerId, '— holdout measuring');
    return { ok: true };
};

/** Dismiss: the trader said no. The row is kept in history, not erased. */
export const dismissHarnessRevision = async (
    username: string = getActiveUsername(),
): Promise<{ ok: boolean; error?: string }> => {
    if (!username) return { ok: false, error: 'no active trader' };
    const state = await loadState(username);
    const p = state.proposal;
    if (!p || p.status !== 'pending') return { ok: false, error: 'no pending proposal to dismiss' };
    p.status = 'dismissed';
    state.history = [
        ...(state.history ?? []),
        { id: p.id, status: 'dismissed' as const, decidedAt: new Date().toISOString(), kind: p.kind },
    ].slice(-20);
    state.proposal = undefined;
    await saveState(username, state);
    return { ok: true };
};

/** Revert (the card's button on a revert-recommended row, or the trader's own
 *  judgement): calls the ledger's revert — the previous prompt text returns.
 *  The matching parent's holdout freezes at this moment and grades if it can. */
export const revertHarnessRevision = async (
    username: string = getActiveUsername(),
): Promise<{ ok: boolean; error?: string }> => {
    if (!username) return { ok: false, error: 'no active trader' };
    const state = await loadState(username);
    const p = state.proposal;
    if (!p?.ledgerId) return { ok: false, error: 'no approved revision to revert' };
    const { revertSelfChange } = await import('./SelfModificationService');
    const res = await revertSelfChange(p.ledgerId, 'owner', { username, note: 'reverted from the harness-optimization holdout' });
    if (!res.ok) return { ok: false, error: res.error };
    const parent = (state.parentPool ?? []).find(x => x.id === p.id);
    if (parent) {
        if (p.holdout) parent.holdout = { ...p.holdout };
        gradeParent(parent);
        parent.status = parent.deltaPp !== null ? 'graded' : 'reverted';
    }
    const status: 'revert-recommended' | 'approved' = p.status === 'revert-recommended' ? 'revert-recommended' : 'approved';
    state.history = [
        ...(state.history ?? []),
        { id: p.id, status, decidedAt: new Date().toISOString(), kind: p.kind, ledgerId: p.ledgerId },
    ].slice(-20);
    state.proposal = undefined;
    await saveState(username, state);
    return { ok: true };
};

/**
 * ROLLBACK to a ranked parent — the trader's one tap back to the
 * highest-scoring prior harness (or a named one). This is a TRADER decision,
 * not the pass writing: it reverts the live revision through the ledger, then
 * restores the parent's measured text through the same override store the
 * approve path uses, ledgered with the previous text and actor 'owner'.
 *
 * Why not `proposePromptChange` for the restore: its churn rail rests a
 * target for 6h after an agent edit — a regression verdict must be undoable
 * the moment it lands, and an owner undo is not churn. The ledger row still
 * records before/after verbatim; the audit trail is the same shape.
 */
export const rollbackToParent = async (
    username: string = getActiveUsername(),
    parentId?: string,
): Promise<{ ok: boolean; error?: string; restoredId?: string }> => {
    if (!username) return { ok: false, error: 'no active trader' };
    const state = await loadState(username);
    const pool = state.parentPool ?? [];
    const ranked = rankParents(pool);
    const target = parentId ? pool.find(x => x.id === parentId) : ranked[0];
    if (!target) return { ok: false, error: 'no graded parent to roll back to — a parent earns its rank after the holdout grades it' };
    if (parentId && target.deltaPp === null) return { ok: false, error: 'that parent is still measuring — no measured delta to rank it by yet' };

    const entry = PROMPT_REGISTRY.find(p => p.id === TARGET_PROMPT_ID);
    const fallback = entry?.fallback ?? '';
    const live = getPrompt(TARGET_PROMPT_ID, fallback);
    if (live === target.text) return { ok: false, error: 'that parent is already the live harness text' };

    // 1. Revert the live revision (if any) through the ledger — the override
    //    resets to the registry fallback, the row records the undo.
    const p = state.proposal;
    if (p?.ledgerId && (p.status === 'approved' || p.status === 'revert-recommended')) {
        const { revertSelfChange } = await import('./SelfModificationService');
        const res = await revertSelfChange(p.ledgerId, 'owner', { username, note: `reverted for parent-pool rollback to ${target.id}` });
        if (!res.ok) return { ok: false, error: res.error };
        const parent = pool.find(x => x.id === p.id);
        if (parent) {
            if (p.holdout) parent.holdout = { ...p.holdout };
            gradeParent(parent);
            parent.status = parent.deltaPp !== null ? 'graded' : 'reverted';
        }
        state.history = [
            ...(state.history ?? []),
            { id: p.id, status: p.status === 'revert-recommended' ? 'revert-recommended' as const : 'approved' as const, decidedAt: new Date().toISOString(), kind: p.kind, ledgerId: p.ledgerId },
        ].slice(-20);
        state.proposal = undefined;
    }

    // 1b. Any OTHER live prompt row on the target (a prior owner rollback,
    //     an agent edit the proposal slot no longer names) reverts too —
    //     the ledger must not carry two 'active' rows for one live text.
    const { revertSelfChange: revertRow } = await import('./SelfModificationService');
    for (const row of liveSelfChanges().filter(r => r.target === `prompt:${TARGET_PROMPT_ID}`)) {
        const res = await revertRow(row.id, 'owner', { username, note: `reverted for parent-pool rollback to ${target.id}` });
        if (!res.ok) console.warn('[HarnessOpt] rollback could not revert', row.id, res.error);
    }

    // 2. Restore the parent's text — unless the parent IS the registry
    //    fallback, in which case the reset above already restored it.
    if (target.text !== fallback) {
        const nowIso = new Date().toISOString();
        const row = SelfChangeSchema.parse({
            schemaVersion: 1,
            id: `config-rollback-${Date.now().toString(36)}`.slice(0, 60),
            tier: 'config',
            target: `prompt:${TARGET_PROMPT_ID}`,
            before: live,
            after: target.text,
            reason: `trader rollback to ranked parent ${target.id} (${target.kind}, holdout delta ${target.deltaPp !== null ? `${target.deltaPp > 0 ? '+' : ''}${target.deltaPp}pp` : 'ungraded'})`,
            status: 'active',
            actor: 'owner',
            version: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
        });
        await savePromptOverride(TARGET_PROMPT_ID, target.text, username);
        await writeSelfChange(row, username);
    }
    await saveState(username, state);
    console.log('[HarnessOpt] rolled back to parent:', target.id);
    return { ok: true, restoredId: target.id };
};

/** The recipe type rides the signal rows this pass reads; re-exported so the
 *  card's imports stay one-hop. */
export type { SignalMemoryRecipe };