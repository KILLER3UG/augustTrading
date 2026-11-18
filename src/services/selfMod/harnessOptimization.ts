/**
 * harnessOptimization — the trader-gated harness-optimization pass
 * (Enhancement 3, 2026-11-18).
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
 * THE HINDSIGHT SEPARATION. The outcomes used here are measured facts (the
 * fill's entry slippage, a stop that a gap blew through, a stop swept before
 * the target) — but the REVISIONS they justify are all ENTRY-TIME decisions:
 * where the entry fill was assumed, where the stop sat. A hindsight outcome
 * may only ever propose an entry-placeable fix; nothing here proposes to
 * re-judge a trade after the fact.
 *
 * THE HOLDOUT. An approved revision is measured against the resolved signals
 * that arrive AFTER it: when HOLDOUT_MIN_FILLS have resolved, the post-approval
 * hit rate is compared with the pre-approval baseline; a regression beyond
 * HOLDOUT_REGRESSION_PP flips the row to 'revert-recommended' and the card
 * grows a Revert button that calls `revertSelfChange` on the ledger row.
 */

import { LoggedTrade } from '../../types/trade';
import { TradeOutcome } from '../../types/enums';
import type { SignalMemoryRecipe } from '../../types/signal';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { PROMPT_REGISTRY } from '../../constants/promptRegistry';
import { readSignals } from '../signals/signalLedger';
import { getActiveUsername } from '../../utils/activeUser';

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

export type HarnessFailureKind = 'entry-slippage' | 'stop-gap' | 'stop-swept';

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
        /** The registry fallback the revision starts from (the card's "before"). */
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
    };
    /** Proposal history the slot's one-at-a-time rule does not erase (newest
     *  last, capped). Terminal rows only. */
    history?: Array<{ id: string; status: 'approved' | 'dismissed' | 'revert-recommended'; decidedAt: string; kind: HarnessFailureKind; ledgerId?: string }>;
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

/** The stored state for the Journal card (null when the pass never ran). */
export const loadHarnessOptimizationState = async (username: string): Promise<HarnessOptimizationState | null> => {
    try {
        const s = await getPreferenceObject<HarnessOptimizationState>(keyFor(username));
        return s && s.proposal ? s : null;
    } catch {
        return null;
    }
};

// ─── Evidence: entry-knowable failure kinds ─────────────────────────────────

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
};

/** Collect the failure kinds that meet the N ≥ 2 floor in the evidence
 *  window, most recent first. Exported for the contract check. */
export const collectFailureKinds = (
    trades: LoggedTrade[],
    signals: Array<{ signal: { id: string; coin: string; direction: string; emittedAt: number }; resolution?: { status: string; outcomeR: number; entryOpenR?: number; gapAdjusted?: boolean; at: number } | undefined }>,
    now = Date.now(),
): Array<{ spec: KindSpec; evidence: HarnessFailureEvidence[]; lastAt: number }> => {
    const cutoff = now - EVIDENCE_WINDOW_MS;
    const byKind = new Map<HarnessFailureKind, HarnessFailureEvidence[]>();

    for (const row of signals) {
        const r = row.resolution;
        if (!r || r.status === 'never_triggered' || r.outcomeR >= 0) continue;
        if (r.at < cutoff) continue;
        if (typeof r.entryOpenR === 'number' && r.entryOpenR <= -0.25) {
            byKind.set('entry-slippage', [
                ...(byKind.get('entry-slippage') ?? []),
                { id: row.signal.id, source: 'signal', outcome: 'loss', at: r.at,
                    fact: `${row.signal.coin} ${row.signal.direction}: filled ${(r.entryOpenR * -1).toFixed(2)}R worse than the assumed entry at the trigger bar's open` },
            ]);
        }
        if (r.gapAdjusted === true) {
            byKind.set('stop-gap', [
                ...(byKind.get('stop-gap') ?? []),
                { id: row.signal.id, source: 'signal', outcome: 'loss', at: r.at,
                    fact: `${row.signal.coin} ${row.signal.direction}: the exit bar opened beyond the stop — the fill cost more than 1R (gap-adjusted)` },
            ]);
        }
    }

    for (const t of trades ?? []) {
        if (t.outcome !== TradeOutcome.LOSS) continue;
        const at = Date.parse(t.timestamp ?? '');
        if (!Number.isFinite(at) || at < cutoff) continue;
        if (t.resolutionRecord?.slHitThenReversedToTp === true) {
            byKind.set('stop-swept', [
                ...(byKind.get('stop-swept') ?? []),
                { id: t.id, source: 'journal', outcome: 'LOSS', at,
                    fact: `${t.analysis?.coinName ?? '?'} ${t.analysis?.direction ?? '?'}: the stop was touched and price still reached the target` },
            ]);
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

    // 3. Evidence floor: at least one kind with N ≥ 2 recurring failures.
    const candidates = collectFailureKinds(trades, rows, now);
    if (candidates.length === 0) {
        await saveState(username, state);
        return null;
    }

    // 4. ONE proposal: the most recent qualifying kind. The revision is the
    //    rule line appended to the registry's fallback — a concrete, diffable
    //    edit to a NAMED prompt block.
    const { spec, evidence } = candidates[0];
    const entry = PROMPT_REGISTRY.find(p => p.id === TARGET_PROMPT_ID);
    if (!entry) {
        await saveState(username, state);
        return null;
    }
    const before = entry.fallback;
    const after = `${before.trimEnd()}\n\n${spec.ruleLine}`;
    const baseline = baselineHitRate(rows, now);
    state.proposal = {
        id: `harness-opt-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        status: 'pending',
        kind: spec.kind,
        promptId: TARGET_PROMPT_ID,
        before,
        after,
        reason: `${spec.rationale} ${evidence.length} recent failures of this kind (newest: ${evidence[0].fact}). ${baseline.samples > 0 && baseline.hitRate !== null ? `Baseline hit rate over the same window: ${(baseline.hitRate * 100).toFixed(0)}% (${baseline.samples} fills).` : 'No resolved fills in the window yet — the holdout will grade the revision once signals resolve.'}`,
        evidence: evidence.slice(0, 6),
        createdAt: new Date(now).toISOString(),
        baseline,
    };
    await saveState(username, state);
    console.log('[HarnessOpt] proposal staged:', spec.kind, evidence.length, 'failures — awaiting the trader');
    return state;
};

// ─── The trader's three decisions ───────────────────────────────────────────

/** Approve: the ONE path from card to prompt. Calls
 *  `SelfModificationService › proposePromptChange` — applied, ledgered with
 *  the previous text, revertible — and stamps the holdout clock. The self-mod
 *  rails still own the gate: with the mode OFF this refuses and the card
 *  shows why. */
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
 *  judgement): calls the ledger's revert — the previous prompt text returns. */
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
    const status: 'revert-recommended' | 'approved' = p.status === 'revert-recommended' ? 'revert-recommended' : 'approved';
    state.history = [
        ...(state.history ?? []),
        { id: p.id, status, decidedAt: new Date().toISOString(), kind: p.kind, ledgerId: p.ledgerId },
    ].slice(-20);
    state.proposal = undefined;
    await saveState(username, state);
    return { ok: true };
};

/** The recipe type rides the signal rows this pass reads; re-exported so the
 *  card's imports stay one-hop. */
export type { SignalMemoryRecipe };
