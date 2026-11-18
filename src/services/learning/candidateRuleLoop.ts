/**
 * candidateRuleLoop — candidate lessons from post-trade review, and the rules
 * the trader may promote from them.
 *
 * WHY THIS EXISTS. A single trade is an anecdote, not a rule. This module keeps
 * the two as separate objects: a CANDIDATE lesson is recorded on every review
 * (one trade, always allowed), while a RULE proposal is gated — two distinct
 * trades minimum, and only facts that were knowable at entry. Information that
 * only became visible after resolution (MAE/MFE, the final outcome, a stop that
 * was touched and then reversed) can explain a trade but may never become a
 * forward rule; letting it in is hindsight bias dressed as a lesson.
 *
 * The shape mirrors riskChangeProposal / strategyActivation: a proposal that
 * resolves on a decision, a 60s revert window, hydration seeds, and the same
 * `harnessTurn` voice for the notes the model reads after the trader acts. The
 * agent records and proposes; every apply/revert is the trader's call.
 */

import type { LoggedTrade, TradeResolutionRecord } from '../../types/trade';
import { TradeOutcome } from '../../types/enums';
import { getActiveUsername } from '../../utils/activeUser';
import { harnessTurn } from '../../utils/harnessMarks';
import { buildTradeResolutionRecord } from '../tracking/journalTracking';

export type ReviewQuadrant =
    | 'good_call_good_luck'
    | 'good_call_bad_luck'
    | 'bad_call_good_luck'
    | 'bad_call_bad_luck';

export const QUADRANT_LABELS: Record<ReviewQuadrant, string> = {
    good_call_good_luck: 'good call, good luck',
    good_call_bad_luck: 'good call, bad luck',
    bad_call_good_luck: 'bad call, good luck',
    bad_call_bad_luck: 'bad call, bad luck',
};

export interface HindsightAudit {
    knowableAtEntry: string[];
    visibleOnlyAfterResolution: string[];
    contaminated: boolean;
    reason?: string;
}

export interface CandidateLesson {
    id: string;
    patternKey: string;
    lesson: string;
    when: string;
    action: string;
    direction: 'tighten' | 'loosen';
    quadrant: ReviewQuadrant;
    knowableAtEntry: string[];
    visibleOnlyAfterResolution: string[];
    tradeIds: string[];
    createdAt: string;
    updatedAt: string;
    promotedRuleId?: string;
}

export const DEFAULT_RULE_TTL_DAYS = 14;
export const DEFAULT_RULE_TTL_TRADES = 20;

export interface RuleProposal {
    id: string;
    candidateLessonId?: string;
    patternKey: string;
    title: string;
    when: string;
    action: string;
    direction: 'tighten' | 'loosen';
    quadrant: ReviewQuadrant;
    knowableAtEntry: string[];
    visibleOnlyAfterResolution: string[];
    tradeIds: string[];
    ttlDays: number;
    ttlTrades: number;
    reason: string;
    createdAt: string;
}

export interface ActiveTradingRule {
    id: string;
    title: string;
    when: string;
    action: string;
    direction: 'tighten' | 'loosen';
    patternKey: string;
    tradeIds: string[];
    quadrant: ReviewQuadrant;
    knowableAtEntry: string[];
    confirmedAtMs: number;
    confirmedTradeCount: number;
    ttlDays: number;
    ttlTrades: number;
    expiresAtMs: number;
    status: 'active' | 'expired';
    expiredReason?: string;
}

// ── The one set of detectors — no local re-phrasings of these ────────────────

const KNOWABLE_AT_ENTRY_RE = /regime|htf|higher.?timeframe|structure|confluence|r:?r|risk.?reward|session plan|liquidity|level distance|gate|atr|vwap/i;

/** Phrases that only make sense once the trade is over. */
const POST_RESOLUTION_RE = /\b(after entry|once entered|stopped (me )?out|right before reversing|reversed after|would have won|should have (waited|held|moved stop)|turned around|wicked out|after resolution|with hindsight|knew it would)\b/i;

/** Named resolution facts: MAE/MFE, the final outcome, time-to-resolve, SL-then-reverse. */
const RESOLUTION_FACT_RE = /\b(mae|mfe|final outcome|time[\s-]to[\s-]resolution|sl[\s-]*(?:hit|touched)?[\s-]*then[\s-]*revers|stopped[\s-]out[\s-]*then[\s-]*revers)/i;

/** Bare outcome/excursion words classify as post-resolution, but do not by
 *  themselves make the review "contaminated" — that flag is for the phrases
 *  and named facts above. */
const OUTCOME_FACT_RE = /\b(win|loss|outcome|result|excursion)\b/i;

/** Undisciplined markers checked across mistakeTags / emotionalState /
 *  rootCauseClass, case-insensitively. */
const UNDISCIPLINED_RE = /(fomo|revenge|over[\s-]?leverag\w*|chased|chasing|moved[\s_-]?(?:stop|sl))/i;

const MIN_PLANNED_RR = 1.2;

const normalizePatternKey = (key: string): string =>
    (typeof key === 'string' ? key : '').trim().toLowerCase().replace(/\s+/g, '-');

const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/[$,\s%]/g, '');
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
};

/** Planned R:R from the FIRST entry / stop / target when no ratio was stamped.
 *  Any missing or unusable level is a gap, never a guessed number. */
const computePlannedRr = (analysis: LoggedTrade['analysis'] | undefined): number | undefined => {
    if (!analysis) return undefined;
    const entry = parseNumber(analysis.entryPoints?.[0]?.price);
    const stop = parseNumber(analysis.stopLoss);
    const target = parseNumber(analysis.takeProfit?.[0]?.price);
    if (entry === undefined || stop === undefined || target === undefined) return undefined;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return undefined;
    const reward = Math.abs(target - entry);
    if (!(reward > 0)) return undefined;
    return reward / risk;
};

// ── Process quality and the four quadrants ───────────────────────────────────

/** Good process is ALL checks passing: adhering to the published plan, a
 *  defined stop and target, a planned R:R of at least 1.2, no gate refusal,
 *  and no undisciplined marker. Each failure returns its own reason. */
export const evaluateProcessQuality = (trade: LoggedTrade): { goodProcess: boolean; reasons: string[] } => {
    const reasons: string[] = [];
    const analysis = trade?.analysis;

    if (trade?.followedPlan === false) {
        reasons.push('Trade did not follow the published plan.');
    }

    const stopLoss = analysis?.stopLoss;
    if (stopLoss == null || (typeof stopLoss === 'string' && stopLoss.trim() === '')) {
        reasons.push('No defined stop loss at entry.');
    }

    const takeProfit = analysis?.takeProfit;
    if (!Array.isArray(takeProfit) || takeProfit.length === 0) {
        reasons.push('No defined take profit at entry.');
    }

    const statedRr = analysis?.rrRatio;
    const rr = typeof statedRr === 'number' && Number.isFinite(statedRr)
        ? statedRr
        : computePlannedRr(analysis);
    if (rr === undefined) {
        reasons.push('Planned R:R is unknown at entry (no stamped ratio and no usable entry/stop/target levels).');
    } else if (rr < MIN_PLANNED_RR) {
        reasons.push(`Planned R:R ${rr.toFixed(2)} is below the ${MIN_PLANNED_RR.toFixed(1)} floor.`);
    }

    const refusal = analysis?.gate?.refusal;
    if (refusal !== undefined) {
        reasons.push(`The gate refused this plan at entry: ${refusal}`);
    }

    const tags = trade?.mistakeTags;
    const disciplineText = [
        Array.isArray(tags) ? tags.join(' ') : '',
        typeof trade?.emotionalState === 'string' ? trade.emotionalState : '',
        typeof trade?.rootCauseClass === 'string' ? trade.rootCauseClass : '',
    ].join(' ');
    if (UNDISCIPLINED_RE.test(disciplineText)) {
        reasons.push(`Undisciplined marker present at entry: ${disciplineText.trim()}`);
    }

    return { goodProcess: reasons.length === 0, reasons };
};

/** Pure: process quality from `evaluateProcessQuality`, outcome from the row.
 *  Good process + WIN is called good luck here by convention: process is what
 *  the trader controls, the win is the part they did not. */
export const classifyTradeQuadrant = (trade: LoggedTrade): ReviewQuadrant => {
    const { goodProcess } = evaluateProcessQuality(trade);
    const won = trade?.outcome === TradeOutcome.WIN;
    if (goodProcess) return won ? 'good_call_good_luck' : 'good_call_bad_luck';
    return won ? 'bad_call_good_luck' : 'bad_call_bad_luck';
};

// ── Hindsight separation ─────────────────────────────────────────────────────

/** True for a post-resolution phrase OR a named resolution fact. Empty and
 *  non-string inputs are false — a missing note is not evidence of bias. */
export const detectHindsightBias = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false;
    return POST_RESOLUTION_RE.test(text) || RESOLUTION_FACT_RE.test(text);
};

/** Deterministic split. A hindsight statement always wins over a knowable
 *  keyword in the same item, and anything unrecognised falls to the
 *  post-resolution side (fail closed). */
export const separateKnowableVsHindsight = (observations: string[]): HindsightAudit => {
    const knowableAtEntry: string[] = [];
    const visibleOnlyAfterResolution: string[] = [];
    let hindsightFound = false;

    const source = Array.isArray(observations) ? observations : [];
    for (const raw of source) {
        const item = typeof raw === 'string' ? raw.trim() : '';
        if (!item) continue;
        const hindsight = detectHindsightBias(item);
        if (hindsight) hindsightFound = true;
        const resolutionFact = hindsight || OUTCOME_FACT_RE.test(item);
        if (!resolutionFact && KNOWABLE_AT_ENTRY_RE.test(item)) {
            knowableAtEntry.push(item);
        } else {
            visibleOnlyAfterResolution.push(item);
        }
    }

    const audit: HindsightAudit = {
        knowableAtEntry,
        visibleOnlyAfterResolution,
        contaminated: hindsightFound,
    };
    if (hindsightFound) {
        audit.reason = 'Hindsight detected: observations include facts visible only after resolution; a rule may use only what was knowable at entry.';
    }
    return audit;
};

// ── The candidate store (append-only per pattern) ────────────────────────────

const candidateLessons = new Map<string, CandidateLesson>();

const safeGetItem = (key: string): string | undefined => {
    try {
        if (typeof localStorage === 'undefined') return undefined;
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
};

const safeSetItem = (key: string, value: string): void => {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    } catch {
        // Storage can be absent, full or blocked — the in-memory store still works.
    }
};

const persistCandidateLessons = (username: string): void => {
    try {
        safeSetItem(`candidate_lessons_v1_${username}`, JSON.stringify(Array.from(candidateLessons.values())));
    } catch {
        // Serialization failed — nothing safe to persist.
    }
};

/** Safe read of the persisted candidates. Also seeds the module store so a
 *  later record for the same pattern dedupes against what was loaded. */
export const readCandidateLessons = (username?: string): CandidateLesson[] => {
    const user = username ?? getActiveUsername();
    const raw = safeGetItem(`candidate_lessons_v1_${user}`);
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const lessons = parsed as CandidateLesson[];
        for (const lesson of lessons) {
            if (lesson && typeof lesson.patternKey === 'string') {
                candidateLessons.set(normalizePatternKey(lesson.patternKey), lesson);
            }
        }
        return lessons;
    } catch {
        return [];
    }
};

/** One trade is always allowed to become a CANDIDATE. A repeat pattern extends
 *  the existing candidate's trade list (deduplicated) instead of minting a
 *  second lesson. */
export const recordCandidateLesson = (args: {
    patternKey: string;
    lesson: string;
    when: string;
    action: string;
    direction: 'tighten' | 'loosen';
    quadrant: ReviewQuadrant;
    knowableAtEntry: string[];
    visibleOnlyAfterResolution: string[];
    trade: LoggedTrade;
    username?: string;
}): CandidateLesson => {
    const user = args.username ?? getActiveUsername();
    const key = normalizePatternKey(args.patternKey ?? '');
    const now = new Date().toISOString();
    const existing = candidateLessons.get(key);

    let candidate: CandidateLesson;
    if (existing) {
        const tradeIds = Array.isArray(existing.tradeIds) ? [...existing.tradeIds] : [];
        if (args.trade?.id && !tradeIds.includes(args.trade.id)) tradeIds.push(args.trade.id);
        candidate = { ...existing, tradeIds, updatedAt: now };
    } else {
        const id = `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        candidate = {
            id,
            patternKey: key,
            lesson: args.lesson ?? '',
            when: args.when ?? '',
            action: args.action ?? '',
            direction: args.direction === 'loosen' ? 'loosen' : 'tighten',
            quadrant: args.quadrant,
            knowableAtEntry: [...(args.knowableAtEntry ?? [])],
            visibleOnlyAfterResolution: [...(args.visibleOnlyAfterResolution ?? [])],
            tradeIds: args.trade?.id ? [args.trade.id] : [],
            createdAt: now,
            updatedAt: now,
        };
    }

    candidateLessons.set(key, candidate);
    persistCandidateLessons(user);
    return candidate;
};

// ── Promotion gate ───────────────────────────────────────────────────────────

export type RuleEligibility = { ok: true } | { ok: false; refused: string };

/** The two refusals are a contract — the tool receipt returns them verbatim
 *  and the Phase 5 contract checks pin both strings. Do not reword them. */
export const checkRulePromotionEligibility = (args: {
    tradeIds: string[];
    when: string;
    action: string;
    knowableAtEntry: string[];
    visibleOnlyAfterResolution?: string[];
}): RuleEligibility => {
    const uniqueTradeIds = [...new Set((args?.tradeIds ?? []).filter(Boolean))];
    if (uniqueTradeIds.length < 2) {
        return { ok: false, refused: 'Refused — one trade is not a lesson. Recorded as a candidate lesson; promoting a rule requires N >= 2 distinct trades.' };
    }
    const knowableAtEntry = Array.isArray(args?.knowableAtEntry) ? args.knowableAtEntry : [];
    const when = typeof args?.when === 'string' ? args.when : '';
    const action = typeof args?.action === 'string' ? args.action : '';
    // The excluded post-resolution list is not decoration: citing any of it
    // inside the rule is the same hindsight as citing a phrase directly.
    const excluded = Array.isArray(args?.visibleOnlyAfterResolution) ? args.visibleOnlyAfterResolution : [];
    const citesExcluded = excluded.some(item => typeof item === 'string' && item.trim().length > 0
        && (when.includes(item.trim()) || action.includes(item.trim())));
    if (knowableAtEntry.length === 0 || citesExcluded || detectHindsightBias(when) || detectHindsightBias(action)) {
        return { ok: false, refused: 'Refused — hindsight bias detected. A rule may use only facts knowable at entry, never information visible only after resolution.' };
    }
    return { ok: true };
};

// ── Pending proposals, decisions and the active store ───────────────────────

const MAX_PROPOSALS = 200;
const pendingRules = new Map<string, RuleProposal>();
/** Keyed by proposal id — a new proposal is a new decision. */
const ruleDecisions = new Map<string, 'confirmed' | 'dismissed'>();

export type RuleProposalCheck = { ok: true; proposal: RuleProposal } | { ok: false; refused: string };

export const proposeRuleChange = (args: {
    patternKey: string;
    title?: string;
    when: string;
    action: string;
    direction: 'tighten' | 'loosen';
    quadrant: ReviewQuadrant;
    knowableAtEntry: string[];
    visibleOnlyAfterResolution: string[];
    tradeIds: string[];
    reason: string;
    ttlDays?: number;
    ttlTrades?: number;
    candidateLessonId?: string;
}): RuleProposalCheck => {
    const eligible = checkRulePromotionEligibility({
        tradeIds: args?.tradeIds ?? [],
        when: args?.when ?? '',
        action: args?.action ?? '',
        knowableAtEntry: args?.knowableAtEntry ?? [],
        visibleOnlyAfterResolution: args?.visibleOnlyAfterResolution ?? [],
    });
    if (!eligible.ok) return eligible;

    const when = (args.when ?? '').trim();
    const action = (args.action ?? '').trim();
    const reason = (args.reason ?? '').trim();
    if (!when) return { ok: false, refused: 'Refused — a rule needs a non-blank "when" condition.' };
    if (!action) return { ok: false, refused: 'Refused — a rule needs a non-blank "action".' };
    if (!reason) return { ok: false, refused: 'Refused — a rule needs a non-blank reason.' };

    const ttlDays = typeof args.ttlDays === 'number' && Number.isFinite(args.ttlDays)
        ? args.ttlDays : DEFAULT_RULE_TTL_DAYS;
    const ttlTrades = typeof args.ttlTrades === 'number' && Number.isFinite(args.ttlTrades)
        ? args.ttlTrades : DEFAULT_RULE_TTL_TRADES;

    const proposal: RuleProposal = {
        id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        candidateLessonId: args.candidateLessonId,
        patternKey: normalizePatternKey(args.patternKey ?? ''),
        title: (args.title ?? '').trim() || when,
        when,
        action,
        direction: args.direction === 'loosen' ? 'loosen' : 'tighten',
        quadrant: args.quadrant,
        knowableAtEntry: [...(args.knowableAtEntry ?? [])],
        visibleOnlyAfterResolution: [...(args.visibleOnlyAfterResolution ?? [])],
        tradeIds: [...new Set((args.tradeIds ?? []).filter(Boolean))],
        ttlDays,
        ttlTrades,
        reason,
        createdAt: new Date().toISOString(),
    };
    // One pending decision per pattern: a newer proposal for the SAME pattern
    // supersedes the open one, so a sink that looks up by patternKey cannot
    // attach an older card to the new receipt. Decided state still keys on the
    // unique proposal id — a new decision never inherits the old one's state.
    for (const [id, existing] of pendingRules) {
        if (existing.patternKey === proposal.patternKey) pendingRules.delete(id);
    }
    pendingRules.set(proposal.id, proposal);
    while (pendingRules.size > MAX_PROPOSALS) {
        const oldest = pendingRules.keys().next().value;
        if (oldest === undefined) break;
        pendingRules.delete(oldest);
    }
    return { ok: true, proposal };
};

/** An id looks up a proposal directly; `idOrKey` also accepts a pattern key.
 *  With no argument, the oldest pending proposal is returned. */
export const pendingRuleProposal = (idOrKey?: string): RuleProposal | undefined => {
    if (idOrKey !== undefined) {
        const byId = pendingRules.get(idOrKey);
        if (byId) return byId;
        const key = normalizePatternKey(idOrKey);
        return Array.from(pendingRules.values()).find((p) => p.patternKey === key);
    }
    return pendingRules.values().next().value;
};

export const ruleProposalStateOf = (id: string): 'confirmed' | 'dismissed' | undefined => ruleDecisions.get(id);

const activeRulesKey = (username: string): string => `active_trading_rules_v1_${username}`;

/** A dismissal leaves no rule row to prove it, so the DECISION is persisted
 *  under the same registered prefix. Without it a dismissed rule card comes
 *  back pending after a reload and the trader is asked twice. */
const ruleDecisionsKey = (username: string): string => `${activeRulesKey(username)}_decisions`;

const readRuleDecisions = (username: string): Record<string, 'confirmed' | 'dismissed'> => {
    const raw = safeGetItem(ruleDecisionsKey(username));
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, 'confirmed' | 'dismissed'> : {};
    } catch {
        return {};
    }
};

const writeRuleDecision = (id: string, state: 'confirmed' | 'dismissed', username: string): void => {
    safeSetItem(ruleDecisionsKey(username), JSON.stringify({ ...readRuleDecisions(username), [id]: state }));
};

/** The persisted disposition for a mirrored rule card, if the trader already
 *  decided it. Hydration prefers this over inferring from a rule row. */
export const readRuleDecision = (id: string, username?: string): 'confirmed' | 'dismissed' | undefined =>
    readRuleDecisions(username ?? getActiveUsername())[id];

const readRulesRaw = (username: string): ActiveTradingRule[] => {
    const raw = safeGetItem(activeRulesKey(username));
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ActiveTradingRule[]) : [];
    } catch {
        return [];
    }
};

const persistActiveRules = (username: string, rules: ActiveTradingRule[]): void => {
    try {
        safeSetItem(activeRulesKey(username), JSON.stringify(rules));
    } catch {
        // Never let a serialization failure break the confirm path.
    }
};

/** Trader confirmed: apply the rule to the persisted store, resolve the card. */
export const confirmRuleProposal = (
    id: string,
    currentTradeCount: number,
    username?: string,
    nowMs: number = Date.now(),
): ActiveTradingRule | undefined => {
    const proposal = pendingRules.get(id);
    if (!proposal) return undefined;
    if (ruleDecisions.has(id)) return undefined;

    const rule: ActiveTradingRule = {
        id: proposal.id,
        title: proposal.title,
        when: proposal.when,
        action: proposal.action,
        direction: proposal.direction,
        patternKey: proposal.patternKey,
        tradeIds: [...proposal.tradeIds],
        quadrant: proposal.quadrant,
        knowableAtEntry: [...proposal.knowableAtEntry],
        confirmedAtMs: nowMs,
        confirmedTradeCount: currentTradeCount,
        ttlDays: proposal.ttlDays,
        ttlTrades: proposal.ttlTrades,
        expiresAtMs: nowMs + proposal.ttlDays * 86400000,
        status: 'active',
    };
    const rules = readRulesRaw(username ?? getActiveUsername());
    rules.push(rule);
    persistActiveRules(username ?? getActiveUsername(), rules);
    pendingRules.delete(id);
    ruleDecisions.set(id, 'confirmed');
    writeRuleDecision(id, 'confirmed', username ?? getActiveUsername());
    return rule;
};

export const dismissRuleProposal = (id: string, username?: string): boolean => {
    const proposal = pendingRules.get(id);
    if (!proposal) return false;
    pendingRules.delete(id);
    ruleDecisions.set(id, 'dismissed');
    writeRuleDecision(id, 'dismissed', username ?? getActiveUsername());
    return true;
};

// ── The revert window ────────────────────────────────────────────────────────

export const RULE_REVERT_WINDOW_MS = 60_000;

const ruleRevertWindows = new Map<string, { previousRule: ActiveTradingRule | undefined; deadline: number }>();

/** Stamp what the confirmed rule REPLACED — captured at confirm time, never
 *  re-derived after the fact. */
export const markRuleRevertWindow = (
    proposalId: string,
    previousRule: ActiveTradingRule | undefined,
    nowMs: number = Date.now(),
): void => {
    ruleRevertWindows.set(proposalId, { previousRule, deadline: nowMs + RULE_REVERT_WINDOW_MS });
};

export const ruleProposalRevertOf = (
    proposalId: string,
    nowMs: number = Date.now(),
): { previousRule: ActiveTradingRule | undefined; msLeft: number } | undefined => {
    const w = ruleRevertWindows.get(proposalId);
    if (!w) return undefined;
    const msLeft = w.deadline - nowMs;
    if (msLeft <= 0) {
        ruleRevertWindows.delete(proposalId);
        return undefined;
    }
    return { previousRule: w.previousRule, msLeft };
};

/** Every stored rule, including expired ones. The one reader that needs the
 *  full list is hydration: an expired rule is still EVIDENCE that the trader
 *  confirmed the card, so the old card must not come back pending. */
export const readAllRules = (username: string): ActiveTradingRule[] => readRulesRaw(username);

export const revertRuleProposal = (id: string, username?: string): ActiveTradingRule | undefined => {
    // The service owns the window, not just the App handler: a direct call
    // after 60s must be a no-op, exactly as revertSessionPlan behaves.
    const window = ruleProposalRevertOf(id);
    if (!window) return undefined;
    const previousRule = window.previousRule;
    const user = username ?? getActiveUsername();
    const kept = readRulesRaw(user).filter((rule) => rule.id !== id);
    if (previousRule) {
        const restored: ActiveTradingRule = { ...previousRule, status: 'active' };
        delete restored.expiredReason;
        kept.push(restored);
    }
    persistActiveRules(user, kept);
    ruleRevertWindows.delete(id);
    return previousRule;
};

// ── TTL and the active context the model reads ───────────────────────────────

export const isRuleExpired = (
    rule: ActiveTradingRule,
    currentTradeCount: number,
    nowMs: number,
): { expired: boolean; reason?: string } => {
    if (nowMs > rule.expiresAtMs) {
        return {
            expired: true,
            reason: `Time-to-live elapsed (${rule.ttlDays} days after confirmation) — the rule expired without renewed evidence.`,
        };
    }
    if ((currentTradeCount - rule.confirmedTradeCount) >= rule.ttlTrades) {
        return {
            expired: true,
            reason: `Trade-to-live elapsed (${rule.ttlTrades} trades since confirmation) — the rule expired without renewed evidence.`,
        };
    }
    return { expired: false };
};

/** Transition expired rules in place. Persists whenever anything changed —
 *  including the case where every rule became expired in this pass. */
export const pruneExpiredRules = (
    username: string,
    currentTradeCount: number,
    nowMs: number = Date.now(),
): ActiveTradingRule[] => {
    const rules = readRulesRaw(username);
    let changed = false;
    const result = rules.map((rule) => {
        if (rule.status !== 'active') return rule;
        const verdict = isRuleExpired(rule, currentTradeCount, nowMs);
        if (!verdict.expired) return rule;
        changed = true;
        return { ...rule, status: 'expired' as const, expiredReason: verdict.reason ?? 'Rule expired.' };
    });
    if (changed) persistActiveRules(username, result);
    return result;
};

export const readActiveRules = (
    username: string,
    currentTradeCount: number,
    nowMs: number = Date.now(),
): ActiveTradingRule[] => pruneExpiredRules(username, currentTradeCount, nowMs).filter((r) => r.status === 'active');

export const formatActiveRulesContextSummary = (
    username: string,
    currentTradeCount: number,
    nowMs: number = Date.now(),
): string => {
    const rules = readActiveRules(username, currentTradeCount, nowMs);
    if (rules.length === 0) return '';
    const lines = rules.map((rule) => {
        const daysLeft = Math.max(0, Math.ceil((rule.expiresAtMs - nowMs) / 86400000));
        const tradesLeft = Math.max(0, rule.ttlTrades - (currentTradeCount - rule.confirmedTradeCount));
        return `- ${rule.title} [${rule.direction}] when ${rule.when}; then ${rule.action}. TTL ${daysLeft}d / ${tradesLeft} trades remain.`;
    });
    return `Active trading rules (learned, trader-confirmed):\n${lines.join('\n')}`;
};

// ── The full post-trade review ───────────────────────────────────────────────

/** One review: measure the resolution, grade the process, split knowable from
 *  hindsight, record a candidate, and check (without promoting) whether that
 *  candidate has earned a rule yet. */
export const evaluatePostTradeReview = (
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    opts?: {
        username?: string;
        patternKey?: string;
        when?: string;
        action?: string;
        direction?: 'tighten' | 'loosen';
        title?: string;
        decision?: string;
    },
): {
    resolutionRecord: TradeResolutionRecord;
    quadrant: ReviewQuadrant;
    audit: HindsightAudit;
    candidateLesson: CandidateLesson;
    eligibleForRulePromotion: boolean;
    matchingCandidate: CandidateLesson;
} => {
    const analysis = trade?.analysis;
    const quadrant = classifyTradeQuadrant(trade);

    // The stored settlement record is AUTHORITATIVE. Build the same record
    // run_review writes, then let stored measurements override it — the review
    // can never drift from what the journal actually settled. A missing
    // measure stays absent; a stored false stays false.
    const resolutionRecord: TradeResolutionRecord = {
        ...buildTradeResolutionRecord(trade),
        ...(trade?.resolutionRecord ?? {}),
    };

    const strategy = (analysis?.strategy ?? '').trim() || 'unspecified strategy';
    const confluenceRaw: string | undefined = analysis?.detectedPatternFamily ?? analysis?.confidence ?? undefined;
    const confluence = (confluenceRaw ?? 'unknown confluence').trim();
    const statedRr = analysis?.rrRatio;
    const plannedRr = typeof statedRr === 'number' && Number.isFinite(statedRr)
        ? statedRr : computePlannedRr(analysis);
    const rrText = plannedRr === undefined ? 'unknown' : plannedRr.toFixed(2);

    const contextParts = [`strategy ${strategy}`, `confidence ${analysis?.confidence ?? 'unknown'}`];
    if (analysis?.marketConditions?.pattern) contextParts.push(`pattern ${analysis.marketConditions.pattern}`);
    contextParts.push(`${Array.isArray(allTrades) ? allTrades.length : 0} trades in journal`);
    if (resolutionRecord.contextAtEntry === undefined) resolutionRecord.contextAtEntry = contextParts.join('; ');

    // Seed observations from what was knowable at entry and what only resolution
    // revealed; the split below is deterministic and fails closed.
    const observations: string[] = [
        `session plan: ${strategy} at entry`,
        `confluence at entry: ${confluence}`,
        `R:R at entry: ${rrText}`,
    ];
    if (trade?.marketRegime) observations.push(`regime at entry: ${trade.marketRegime}`);
    const entryPrice = parseNumber(analysis?.entryPoints?.[0]?.price);
    const stopPrice = parseNumber(analysis?.stopLoss);
    if (entryPrice !== undefined && entryPrice > 0 && stopPrice !== undefined) {
        const distance = Math.abs(entryPrice - stopPrice) / entryPrice * 100;
        observations.push(`level distance at entry: stop ${distance.toFixed(2)}% from entry`);
    }
    if (analysis?.sessionGuard?.summary) observations.push(`session plan: ${analysis.sessionGuard.summary}`);
    if (analysis?.gate) observations.push(`gate ${analysis.gate.status} at entry`);
    if (analysis?.marketConditions?.atr) observations.push(`ATR snapshot ${analysis.marketConditions.atr}`);
    if (analysis?.marketConditions?.sessionVwap) observations.push(`VWAP snapshot ${analysis.marketConditions.sessionVwap}`);
    if (resolutionRecord.maePercent !== undefined) observations.push(`MAE ${resolutionRecord.maePercent}%`);
    if (resolutionRecord.mfePercent !== undefined) observations.push(`MFE ${resolutionRecord.mfePercent}%`);
    observations.push(`outcome: ${trade?.outcome}`);
    // Both signals count: the authoritative stored measurement AND the raw
    // SL-touch-then-win observation. Either one makes this a post-resolution
    // fact; a stored false is not silently overwritten by the raw observation.
    if (resolutionRecord.slHitThenReversedToTp === true
        || (trade?.slOptimizationData?.slWasTouched === true && trade?.outcome === TradeOutcome.WIN)) {
        observations.push('sl hit then reversed to tp');
    }
    if (resolutionRecord.timeToResolution) observations.push(`time to resolution: ${resolutionRecord.timeToResolution}`);
    if (trade?.postMortem) observations.push(trade.postMortem);

    const audit = separateKnowableVsHindsight(observations);

    const direction = opts?.direction === 'loosen' ? 'loosen' : 'tighten';
    const patternKey = normalizePatternKey(opts?.patternKey ?? opts?.title ?? `${strategy}-${confluence}`);
    const defaultWhen = `At entry: ${strategy} setup, regime ${trade?.marketRegime ?? 'unknown'}, confluence ${confluence}, planned R:R ${rrText}`;
    const when = (opts?.when ?? '').trim() || defaultWhen;
    const action = (opts?.action ?? '').trim() || `${direction} this setup when the entry conditions recur`;
    const lesson = `${QUADRANT_LABELS[quadrant]} — ${strategy}${opts?.decision ? `; decision: ${opts.decision}` : ''}`;

    const candidateLesson = recordCandidateLesson({
        patternKey,
        lesson,
        when,
        action,
        direction,
        quadrant,
        knowableAtEntry: audit.knowableAtEntry,
        visibleOnlyAfterResolution: audit.visibleOnlyAfterResolution,
        trade,
        username: opts?.username,
    });

    const eligibility = checkRulePromotionEligibility({
        tradeIds: candidateLesson.tradeIds,
        when: candidateLesson.when,
        action: candidateLesson.action,
        knowableAtEntry: candidateLesson.knowableAtEntry,
        visibleOnlyAfterResolution: candidateLesson.visibleOnlyAfterResolution,
    });

    return {
        resolutionRecord,
        quadrant,
        audit,
        candidateLesson,
        eligibleForRulePromotion: eligibility.ok,
        matchingCandidate: candidateLesson,
    };
};

// ── Hydration, test reset and the notes the model reads ─────────────────────

/** A mirrored pending card comes back after reload with the stores empty. */
export const seedRuleProposalForHydration = (
    proposal: RuleProposal,
    decidedState?: 'confirmed' | 'dismissed',
): void => {
    if (decidedState) {
        ruleDecisions.set(proposal.id, decidedState);
        return;
    }
    pendingRules.set(proposal.id, proposal);
};

export const __clearRuleLoopForTests = (): void => {
    pendingRules.clear();
    ruleDecisions.clear();
    ruleRevertWindows.clear();
    candidateLessons.clear();
};

export const formatRuleAppliedForModel = (p: ActiveTradingRule): string => harnessTurn(
    `[RULE APPLIED — the app, not the trader] The trader CONFIRMED your proposed rule "${p.title}":`
    + ` when ${p.when}; then ${p.action} (${p.direction}).`
    + ` It is active for ${p.ttlDays} days / ${p.ttlTrades} new trades from confirmation.`
    + ` A revert is the trader's call; do not re-propose the same rule without new evidence.`,
);

export const formatRuleRevertedForModel = (p: ActiveTradingRule): string => harnessTurn(
    `[RULE REVERTED — the app, not the trader] The trader reverted the confirmed rule "${p.title}":`
    + ` when ${p.when}; then ${p.action}.`
    + ` Reason with the rule set as it was before; do not re-propose the same rule without something new.`,
);
