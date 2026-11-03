/**
 * convictionScale — the ONE written rubric for the model's self-reported
 * conviction, and the one parser for it.
 *
 * A free-form confidence percentage measures how sure the model SOUNDS. These
 * four levels measure what the EVIDENCE reached, and the wording is part of
 * the contract: the same text lives in the `emit_signal` tool description, so
 * a number arriving here was produced against the levels defined here. A
 * conviction outside the rubric is refused, never clamped — a clamped 5 would
 * silently grade as a 4 and the calibration ledger would believe it.
 *
 * A conviction is a SELF-REPORT: it gates nothing, caps nothing, and never
 * reaches enforcement (the same boundary tentative skills obey).
 */

export type Conviction = 1 | 2 | 3 | 4;

export const CONVICTION_RUBRIC: Record<Conviction, string> = {
    1: 'One timeframe leans; the levels are untested and the derivatives read is neutral or absent.',
    2: 'Structure and one confirming level agree; derivatives are neutral.',
    3: 'Structure, levels and derivatives all agree, and no higher timeframe opposes the direction.',
    4: 'The whole checklist agrees AND the invalidation is a defined, near level — the call is falsifiable within the expiry.',
};

export const parseConviction = (value: unknown): Conviction | null => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 4) return null;
    return n as Conviction;
};

export const convictionLabel = (conviction: Conviction): string => CONVICTION_RUBRIC[conviction];
