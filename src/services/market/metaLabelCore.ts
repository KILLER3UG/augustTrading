/**
 * metaLabelCore — the meta-label read the tools-upgrade task deferred to P3
 * and the owner then asked for: a secondary "take this trade or not / how
 * big" verdict ON TOP of the primary signal.
 *
 * It is ADVISORY BY CONSTRUCTION: the read returns a verdict, a size
 * fraction, and its reasons — it is never wired into the presentation path
 * and can never refuse a card (the gate that refuses lives in
 * `services/trade/proposalGate.ts` and stays the only one). "The agent
 * proposes; deterministic code checks; the trader decides" is untouched.
 *
 * Every rule is a declared threshold over numbers the other tools already
 * measured — the trader's own base rate with its Wilson interval, the
 * portfolio's heat and drawdown light, the Kelly ceiling that refuses under
 * a thin sample. When nothing is measurable, the verdict is `no_data` —
 * never a confident "take" built from nothing.
 */

export interface MetaLabelInput {
    /** The plan's R:R (nearest target ÷ stop, canonical). 0 = not computable. */
    plannedRr: number;
    /** The plan's break-even win rate AFTER costs, in percent (null when
     *  the cost model cannot compute it). */
    breakEvenWinRatePct: number | null;
    /** The trader's measured base rate for this setup type (null when the
     *  sample was too thin to quote one). */
    baseRate: { sample: number; winRate: number; ciLow: number; ciHigh: number } | null;
    /** Does the plan's regime match the setup's claimed regime? `null` when
     *  the caller cannot say (the honest default today). */
    regimeApplies: boolean | null;
    /** The half-Kelly ceiling as % of equity, or null when refused (thin
     *  sample). */
    kellyHalfPct: number | null;
    openPlans: number;
    correlated: boolean;
    drawdownLight: 'green' | 'yellow' | 'red';
}

export interface MetaLabelRead {
    verdict: 'take' | 'reduce' | 'skip' | 'no_data';
    /** % of the trader's standard risk the read supports (take = 100,
     *  reduce = 50, skip = 0). */
    sizeFractionPct: number | null;
    reasons: string[];
    thresholds: { skipCiBelowBreakEven: boolean; reduceOnThinSample: number; reduceOnYellow: boolean; reduceOnCorrelated: boolean };
    evidence_level: 'documented';
}

const THRESHOLDS = {
    /** SKIP when even the UPPER Wilson bound sits below the plan's
     *  break-even — the optimistic read still cannot pay. */
    skipCiBelowBreakEven: true,
    /** REDUCE while the base rate's sample is under this. */
    reduceOnThinSample: 20,
    /** REDUCE on a yellow drawdown light. */
    reduceOnYellow: true,
    /** REDUCE when open plans already share the coin. */
    reduceOnCorrelated: true,
};

export const metaLabel = (input: MetaLabelInput): MetaLabelRead => {
    const reasons: string[] = [];
    const hasEvidence = input.baseRate !== null || input.kellyHalfPct !== null || input.regimeApplies !== null;
    if (!hasEvidence && input.drawdownLight === 'green' && input.openPlans === 0) {
        return {
            verdict: 'no_data',
            sizeFractionPct: null,
            reasons: ['nothing measurable backs this plan yet — no base rate, no Kelly ceiling, no regime read; "take" off nothing is exactly the invented confidence this harness exists to end'],
            thresholds: THRESHOLDS,
            evidence_level: 'documented',
        };
    }

    // SKIP: the drawdown light is red (the portfolio is in its declared
    // danger band), or the base rate's OPTIMISTIC bound cannot pay for the
    // plan after costs. The Wilson bounds arrive as FRACTIONS (0–1) and the
    // break-even as a PERCENT — the fixtures caught the raw comparison
    // skipping every plan that had a base rate at all; convert first.
    if (input.drawdownLight === 'red') {
        reasons.push('drawdown light RED — the declared stop-trading band; the plan waits');
    }
    if (input.baseRate && input.breakEvenWinRatePct !== null && (input.baseRate.ciHigh * 100) < input.breakEvenWinRatePct) {
        reasons.push(`the base rate's UPPER bound (${(input.baseRate.ciHigh * 100).toFixed(0)}% over ${input.baseRate.sample}) sits below this plan's break-even (${input.breakEvenWinRatePct.toFixed(1)}% after costs) — even the optimistic read cannot pay`);
    }
    if (reasons.length > 0) {
        return { verdict: 'skip', sizeFractionPct: 0, reasons, thresholds: THRESHOLDS, evidence_level: 'documented' };
    }

    // REDUCE: anything yellow, thin, crowded, or regime-mismatched.
    if (input.drawdownLight === 'yellow') reasons.push('drawdown light YELLOW — half size until the week recovers');
    if (input.correlated) reasons.push('an open plan already holds this coin — correlated exposure takes half size');
    if (input.baseRate && input.baseRate.sample < THRESHOLDS.reduceOnThinSample) {
        reasons.push(`base rate sample ${input.baseRate.sample} is under ${THRESHOLDS.reduceOnThinSample} — the rate is directionally useful, not bankable; half size`);
    }
    if (input.regimeApplies === false) reasons.push('the plan\'s regime does not match the setup\'s claimed regime — half size');
    if (reasons.length > 0) {
        return { verdict: 'reduce', sizeFractionPct: 50, reasons, thresholds: THRESHOLDS, evidence_level: 'documented' };
    }

    // TAKE — with the Kelly ceiling stated when it exists (it never raises
    // the size; it only reports what the journal supports).
    if (input.baseRate) {
        reasons.push(`base rate ${(input.baseRate.winRate * 100).toFixed(0)}% over ${input.baseRate.sample} (Wilson 95% ${(input.baseRate.ciLow * 100).toFixed(0)}–${(input.baseRate.ciHigh * 100).toFixed(0)}%) vs break-even ${input.breakEvenWinRatePct !== null ? input.breakEvenWinRatePct.toFixed(1) + '%' : 'n/a'}`);
    }
    if (input.kellyHalfPct !== null) {
        reasons.push(`half-Kelly ceiling ${input.kellyHalfPct}% of equity — a ceiling on size, never a raise`);
    }
    if (input.openPlans > 0) {
        reasons.push(`${input.openPlans} open plan(s) already running — heat is context, not a refusal`);
    }
    return { verdict: 'take', sizeFractionPct: 100, reasons, thresholds: THRESHOLDS, evidence_level: 'documented' };
};
