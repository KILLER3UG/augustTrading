/**
 * proposedTrade — the shape a Chart AI model emits when it PRESENTS a trade
 * (entry / stop / targets), and the bridge that turns an accepted proposal
 * into a PENDING journal trade.
 *
 * The point of building a real `TradeAnalysis` here (rather than a bespoke
 * "open trade" type) is reuse: the existing outcome autopilot
 * (`useWatchAndAutopilot` → `OutcomeAutopilotService.register`) already
 * watches any message whose `outcome === PENDING` and whose analysis has a
 * Long/Short direction, an entry and a stop — then detects the SL/TP touch and
 * records the settled outcome. So "Log this trade" only has to append a PENDING
 * analysis message and the autopilot takes over unchanged.
 *
 * The post-mortem this file used to name as the loop's next step was deleted
 * (2026-10-18) — a logged trade now settles into the journal and stops there.
 * Pure + dependency-free (bar the shared clamp helpers) so it is unit-tested.
 */

import { TradeAnalysis, TradeOutcome, Message, MessageRole, type ProposalGate } from '../../types';
import { baseOf, quoteOf } from '../../utils/symbol';
import { plannedRiskReward } from '../../utils/riskReward';
import { clampProbabilityToGate, downgradeConfidenceForProbability } from '../../utils/analysisUtils';
import { computeContractSize, type ContractSize } from '../../utils/ticketSize';
import { netEdgeR, roundTripCostR } from '../../utils/netRiskReward';
import { applyTradeTypeToAnalysis } from '../analysis/ScalpDetectionService';

/** Re-exported so existing importers keep one name for it; the definition lives
 *  in `types/analysis.ts`, because a stamped value has to survive onto a
 *  persisted journal row. */
export type { ProposalGate };

/** A structured trade the model puts on the table for the user to accept. */
export interface TradeProposal {
    symbol: string;
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    confidence?: 'High' | 'Medium' | 'Low';
    rationale?: string;
    invalidation?: string;
    /** Which model / session presented it — carried onto the trade for
     *  attribution so the model-performance ledger can credit/debit it. */
    proposedBy?: string;
    /** The gate that bound this plan at present time. Absent only on proposals
     *  recorded before the stamp existed — never on a fresh present_trade call. */
    gate?: ProposalGate;
    /** Stable plan id the DOCK generates when the proposal is presented
     *  (not the model): the harness level-watch arms on it and its level
     *  ids (`${planId}:ENTRY|:SL|:TP1..N`), and it rides onto the logged
     *  message so plan, warning and journal row stay the same object. */
    planId?: string;
    /**
     * The O-46 decision snapshot: what the market computed at PRESENT time —
     * regime, ATR, previous-day range, session VWAP — fetched fire-and-forget
     * by present_trade and attached to this same object, so the card, the
     * journal row and the training corpus all read ONE snapshot. Absent when
     * the fetch failed or had not landed yet: the marketConditions fields
     * stay '—', which is honest, never a placeholder that looks like data.
     */
    decisionSnapshot?: {
        regimeId: string | null;
        regimeText: string | null;
        atr: number | null;
        atrTf: string;
        prevDayHigh: number | null;
        prevDayLow: number | null;
        sessionVwap: number | null;
        capturedAt: string;
    };
}

/**
 * The size the MODEL stated for the plan, in dollars, when it stated one.
 *
 * `present_trade` has NO size parameter — the model is asked for a setup, not
 * for a ticket — so when it states a size it does so in its own words ("risk
 * $250", "$2,000 position"). This RECORDS that, separately from the app's
 * own suggested size, so the journal can compare the two: the app's
 * suggestion is computed from the trader's own equity and risk % and never
 * depends on what the model said. A model can neither inflate nor shrink the
 * ticket it is shown.
 */
export interface ModelStatedSize {
    /** A dollar amount the model named as the RISK for the trade. */
    riskUsd?: number;
    /** A dollar amount the model named as the SIZE / notional. */
    notionalUsd?: number;
}

/** A dollar figure, with the thousands separators a model writes them with. */
const DOLLAR = /\$\s*([\d][\d,]*(?:\.\d+)?)/g;
/** The words that make a figure a RISK rather than a size. */
const RISK_WORD = /\b(?:risk|risking)\b/i;
/** The words that make a figure a SIZE / notional. */
const SIZE_WORD = /\b(?:size|position|notional)\b/i;

/**
 * Read the dollar size the model stated out of its own prose.
 *
 * Only DOLLAR amounts are read. A quantity ("0.5 BTC") is not a dollar size
 * without a reference price, and converting it would put a number in the
 * journal that no source ever stated. A dollar figure with no risk/size word
 * near it is ignored for the same reason — a bare "$100,000" in a rationale
 * is far more often the instrument's price than a position.
 *
 * The keyword is looked for on BOTH sides of the figure ("$2,000 position"
 * and "position $2,000" both count), and only in the text since the previous
 * dollar figure — so "risk $250 on a $2,000 position" reads as a $250 risk
 * against a $2,000 position rather than making both amounts risks.
 */
export const modelStatedSize = (text?: string): ModelStatedSize => {
    const out: ModelStatedSize = {};
    if (!text) return out;
    // The cursor walks the text so each figure is judged by the words
    // BETWEEN it and the previous figure — never by a word belonging to an
    // earlier amount.
    let cursor = 0;
    for (const m of text.matchAll(DOLLAR)) {
        const amount = Number(m[1].replace(/,/g, ''));
        const before = text.slice(cursor, m.index);
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
        cursor = m.index + m[0].length;
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const window = `${before} ${after}`;
        if (RISK_WORD.test(window)) {
            if (out.riskUsd === undefined) out.riskUsd = amount;
        } else if (SIZE_WORD.test(window)) {
            if (out.notionalUsd === undefined) out.notionalUsd = amount;
        }
    }
    return out;
};

const CONFIDENCE_PROBABILITY: Record<'High' | 'Medium' | 'Low', number> = {
    High: 72, Medium: 58, Low: 44,
};

/** The probability a confidence WORD starts from, before any gate cap. One
 *  lookup so the gate's minEdge arithmetic and the row's recorded number
 *  cannot disagree about what the model claimed. */
export const probabilityForConfidence = (confidence: 'High' | 'Medium' | 'Low'): number =>
    CONFIDENCE_PROBABILITY[confidence];

/**
 * ONE plan object — the levels, the ratio, the model's claim, and the numbers
 * the gate bound from them. The card, the journal row, the min-edge check and
 * the level watch all read this, so "the card says 40 %, the row says 72 %"
 * stops being representable.
 *
 * The model supplies the levels; the app supplies everything derived. The
 * plan is pure: same proposal + same stamp → same numbers, everywhere.
 */
export interface TradePlan {
    symbol: string;
    direction: 'Long' | 'Short';
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    invalidation?: string;
    /** Planned ratio from utils/riskReward — the nearest target, one formula. */
    plannedRr: number;
    /** The confidence the model stated. */
    modelConfidence: 'High' | 'Medium' | 'Low';
    /** The probability the model's word starts from. */
    modelProbability: number;
    /** The probability after the gate cap and any code-checked skill ceiling. */
    probability: number;
    /** The confidence band the capped probability earns, never above the claim. */
    confidence: 'High' | 'Medium' | 'Low';
    /** The stop as a percent of entry, or 0 when the levels are unusable. */
    stopDistancePct: number;
    /** The round-trip fee in R, or undefined when the stop is unmeasurable. */
    costR?: number;
    /** Net expectancy at the capped probability, or undefined when unmeasurable. */
    netEdgeR?: number;
    /** The arithmetic behind netEdgeR, for a refusal card. */
    netEdgeLabel?: string;
    gate?: ProposalGate;
    /** Every deterministic note (gate, skill, refusal) in display order. */
    warnings: string[];
}

export const buildTradePlan = (p: TradeProposal): TradePlan => {
    const plannedRr = computeRrRatio(p);
    const stopDistancePct = p.entry > 0 ? Math.abs((p.entry - p.stopLoss) / p.entry) * 100 : 0;
    const modelConfidence = p.confidence ?? 'Medium';
    const modelProbability = probabilityForConfidence(modelConfidence);
    let probability = modelProbability;
    let confidence: 'High' | 'Medium' | 'Low' = modelConfidence;
    const warnings: string[] = [];

    const gateCap = p.gate?.status === 'evaluated' ? p.gate.confidenceCap : 1;
    if (p.gate?.status === 'evaluated') {
        const clamp = clampProbabilityToGate(probability, gateCap, plannedRr);
        if (clamp.wasClamped) {
            probability = clamp.probability;
            const next = downgradeConfidenceForProbability(clamp.probability, confidence);
            confidence = next === 'Avoid' ? confidence : next;
            warnings.push(`Gate enforcement: ${clamp.reason}`);
        }
    } else if (p.gate?.status === 'unavailable') {
        warnings.push(`Gate unavailable — this plan is UNCAPPED (${p.gate.reason})`);
    } else {
        warnings.push('Gate never ran for this plan — logged UNCAPPED');
    }
    if (p.gate?.refusal) {
        // A refusal is either the min-edge floor or an inverted plan, and the
        // sentence riding with it already names which. The prefix therefore says
        // only "the gate": calling an inverted plan a min-edge refusal would
        // claim an edge was measured on arithmetic that points the wrong way.
        warnings.push(`REFUSED by the gate: ${p.gate.refusal}`);
    }
    // The plan-shape bands, in the gate's own words, so the row quotes the same
    // sentence the card showed (E-57 §5). They WARN — the Log button stayed live
    // and the trader decided — so they belong on the record, not in a refusal.
    for (const w of p.gate?.warnings ?? []) warnings.push(w);

    const cost = roundTripCostR({ stopDistancePct });
    const edge = netEdgeR({
        winProbability: probability / 100,
        rewardRatio: plannedRr,
        stopDistancePct,
    });
    return {
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entry,
        stopLoss: p.stopLoss,
        takeProfits: [...p.takeProfits],
        ...(p.invalidation ? { invalidation: p.invalidation } : {}),
        plannedRr,
        modelConfidence,
        modelProbability,
        probability,
        confidence,
        stopDistancePct,
        ...(cost.known && cost.costR !== null ? { costR: cost.costR } : {}),
        ...(edge.known && edge.netEdgeR !== null ? { netEdgeR: edge.netEdgeR, netEdgeLabel: edge.label } : {}),
        ...(p.gate ? { gate: p.gate } : {}),
        warnings,
    };
};

/** Reward:risk from the first target vs the stop, sign-correct for direction.
 *  Delegates to the single planned-R:R definition — the old version read
 *  `takeProfits[0]`, so a model emitting targets out of order quoted the
 *  FARTHEST target as the nearest one. */
export const computeRrRatio = (p: Pick<TradeProposal, 'direction' | 'entry' | 'stopLoss' | 'takeProfits'>): number =>
    plannedRiskReward({ entry: p.entry, stopLoss: p.stopLoss, takeProfits: p.takeProfits });

/** The one plan-id shape. `present_trade` mints it and the level-watch arms on
 *  it; the prose chip (stage 20d) must mint the SAME thing, or a plan logged
 *  from prose and a plan presented by the tool become two different objects to
 *  the dedupe keyed on `planId`. */
export const mintPlanId = (symbol: string): string =>
    `${baseOf(symbol).toLowerCase()}-${Date.now().toString(36)}`;

/** Validate + normalize the model's raw tool arguments into a proposal, or
 *  return the reason it is unusable (the tool surfaces this to the model). */
export const parseTradeProposal = (args: Record<string, unknown>): { proposal?: TradeProposal; error?: string } => {
    const num = (v: unknown): number | null => {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const direction = args.direction === 'Short' ? 'Short' : args.direction === 'Long' ? 'Long' : null;
    if (!direction) return { error: 'direction must be "Long" or "Short"' };
    const entry = num(args.entry);
    const stopLoss = num(args.stopLoss);
    if (entry === null) return { error: 'entry price is required' };
    if (stopLoss === null) return { error: 'stopLoss price is required' };
    const takeProfits = Array.isArray(args.takeProfits)
        ? args.takeProfits.map(num).filter((n): n is number => n !== null).slice(0, 5)
        : [];
    if (takeProfits.length === 0) return { error: 'at least one takeProfits price is required' };
    // A long must stop below entry and target above it (and vice versa) — a
    // backwards plan is a model slip, not a trade.
    if (direction === 'Long' && (stopLoss >= entry || takeProfits.some(tp => tp <= entry))) {
        return { error: 'for a Long, the stop must sit below entry and every target above it' };
    }
    if (direction === 'Short' && (stopLoss <= entry || takeProfits.some(tp => tp >= entry))) {
        return { error: 'for a Short, the stop must sit above entry and every target below it' };
    }
    const confidence = args.confidence === 'High' || args.confidence === 'Medium' || args.confidence === 'Low'
        ? args.confidence : 'Medium';
    // SYMBOL DOCTRINE (utils/symbol, PR#5): models routinely answer with a bare
    // base ("BTC"). Storing it verbatim armed the harness level-watch under
    // 'BTC' — tick('BTCUSDT') never matches, fetchMarkPrice('BTC') 400s on
    // every 5s poll forever (plans have no expiry), and disarmSymbol('BTCUSDT')
    // can't remove it. Normalize at the PARSE site to the canonical full
    // futures form (base + quote, bare base defaults to USDT): 'BTC' and
    // 'BTC/USDT' both arm as 'BTCUSDT'; a canonical input is unchanged.
    const rawSymbol = String(args.symbol ?? '').trim();
    return {
        proposal: {
            symbol: rawSymbol ? `${baseOf(rawSymbol)}${quoteOf(rawSymbol)}` : 'BTCUSDT',
            direction, entry, stopLoss, takeProfits, confidence,
            rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 600) : undefined,
            invalidation: typeof args.invalidation === 'string' ? args.invalidation.slice(0, 300) : undefined,
            proposedBy: typeof args.proposedBy === 'string' ? args.proposedBy.slice(0, 60) : undefined,
        },
    };
};

/** Build the minimal-but-valid TradeAnalysis the autopilot + journal expect.
 *
 *  The gate cap binds HERE, at the one place a confidence WORD becomes a number:
 *  a plan stamped `evaluated` with a 0.50 cap cannot reach the journal as 72%,
 *  and a plan whose gate could not run is recorded UNCAPPED with a warning
 *  rather than quietly measured zero. Same helper as the pipeline's finalizer, so
 *  a presented plan and an analysed one are clamped by one rule, not two.
 *
 *  No stamp at all is also recorded, not hidden: every log path awaits
 *  `ensureStamp` first, so an unstamped row here means a caller skipped it. */
export const buildProposedTradeAnalysis = (p: TradeProposal, createdAt = new Date().toISOString()): TradeAnalysis => {
    // Everything derived comes from the ONE plan object. This builder only
    // maps it onto the TradeAnalysis shape the autopilot and journal expect.
    const plan = buildTradePlan(p);
    return applyTradeTypeToAnalysis({
        coinName: plan.symbol,
        direction: plan.direction,
        confidence: plan.confidence,
        probability: plan.probability,
        strategy: 'Chart AI proposal',
        activeStrategies: [],
        entryPoints: [{ description: p.proposedBy ? `Proposed by ${p.proposedBy}` : 'Chart AI proposal', price: String(plan.entry) }],
        stopLoss: String(plan.stopLoss),
        // The detector (and the card's risk line) reads the stop DISTANCE,
        // not the two absolute prices. Stored signed like every other row:
        // the value is the adverse move, so it is negative for both sides.
        ...(plan.stopDistancePct > 0 ? { stopLossPercentage: `-${plan.stopDistancePct.toFixed(2)}%` } : {}),
        takeProfit: plan.takeProfits.map(tp => ({ price: String(tp) })),
        // O-46: when the decision snapshot landed, the market conditions are
        // the MEASURED read, not dashes. Only computed fields are filled — an
        // unfilled field stays '—' rather than wearing a placeholder that
        // looks like data.
        marketConditions: {
            pattern: p.decisionSnapshot?.regimeText ?? '—',
            candleBehavior: '—',
            timeframeAlignment: p.decisionSnapshot?.regimeId ?? '—',
            rsi: p.decisionSnapshot?.atr != null
                ? `ATR ${Number(p.decisionSnapshot.atr.toPrecision(4))} (${p.decisionSnapshot.atrTf})`
                : '—',
            macd: p.decisionSnapshot?.prevDayHigh != null && p.decisionSnapshot?.prevDayLow != null
                ? `prev day ${p.decisionSnapshot.prevDayHigh}–${p.decisionSnapshot.prevDayLow}`
                : '—',
            sentiment: p.decisionSnapshot?.sessionVwap != null
                ? `session VWAP ${Number(p.decisionSnapshot.sessionVwap.toPrecision(6))}`
                : '—',
        },
        historicalCorrelation: p.rationale ? `Chart AI: ${p.rationale}` : 'Proposed from the live chart in Chart AI.',
        createdAt,
        rrRatio: plan.plannedRr,
        // The tier the MODEL stated, before the gate clamped it. The sizing
        // reads the pair (this + the tier that survived) to decide whether the
        // plan was downgraded, and the journal can show what the model claimed
        // against what the gate allowed.
        originalConfidence: plan.modelConfidence,
        ...(plan.gate ? { gate: plan.gate } : {}),
        ...(plan.warnings.length > 0 ? { validationWarnings: plan.warnings } : {}),
    });
};

/**
 * The SUGGESTED size for a presented plan.
 *
 * The one sizing rule in the app (`utils/ticketSize`) was complete and had
 * ZERO production callers: every number the trader saw about size came from
 * the model or from nowhere. This wires it to the proposal path, so the card
 * can show what the trader's OWN equity and risk % say the position should
 * be — which is a different question from what the model proposed, and the
 * one that decides how much money is actually at risk.
 *
 * It FAILS CLOSED: with no equity configured the size is zero and the reason
 * says so, because a confident-looking size for a user who never set an
 * account is exactly the failure this replaces.
 */
export const proposedTicketSize = (
    p: TradeProposal,
    equityUsd: number,
    leverage: number,
    riskPercent: number,
): ContractSize =>
    computeContractSize(buildProposedTradeAnalysis(p), equityUsd, leverage, riskPercent);

/** The PENDING message "Log this trade" appends to the conversation — the
 *  autopilot picks it up by id and drives the SL/TP detection.
 *
 *  A RECEIPT, not a second report: the entry/stop/target/probability numbers
 *  this plan is made of are already carried by the decision card (the answer's
 *  own card on this surface, the proposal card in the dock) and by the journal
 *  row this receipt becomes. Restating them here printed the same four numbers
 *  twice in one turn — once in prose, once under a card that labels them — so
 *  the text names the plan (direction, symbol, plan id) and stops there. */
export const buildProposedTradeMessage = (
    p: TradeProposal,
    id: string,
    /** The message that PRESENTED the plan. Its provenance is copied, because
     *  settlement reads `modelsUsed`/`runStats` off the accepted row: without it
     *  the journal row for an accepted plan could not name the model that made
     *  the call (the 2026-10-27 audit A-6). */
    source?: Pick<Message, 'modelsUsed' | 'runStats'>,
): Message => ({
    id,
    role: MessageRole.AI,
    text: `Logged from Chart AI — ${p.direction} ${p.symbol}${p.planId ? ` · plan ${p.planId}` : ''}`,
    createdAt: new Date().toISOString(),
    analysis: buildProposedTradeAnalysis(p),
    outcome: TradeOutcome.PENDING,
    // The headline carries the plan id for the reader; the FIELD carries it for
    // the journal row and the dedupe, so neither has to re-parse prose.
    ...(p.planId ? { planId: p.planId } : {}),
    ...(source?.modelsUsed ? { modelsUsed: source.modelsUsed } : {}),
    ...(source?.runStats ? { runStats: source.runStats } : {}),
});
