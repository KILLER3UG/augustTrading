/**
 * proposalFormatCore — the ONE precision law for TradeProposalCard numbers.
 *
 * DESIGN.md rules: numbers are rounded to the precision the DECISION needs
 * before render, in `font-mono tabular-nums`, with full precision reserved
 * for a title/expanded drawer. A component that rounds inline is a second
 * implementation and will drift — every scan-line figure on the proposal
 * card goes through here.
 *
 * Pure TypeScript: ZERO React, DOM, window, storage, or network imports
 * (`check:boundaries` enforces this).
 */

/** Non-finite input has no decision-safe rendering — the em-dash is the app's
 *  quiet "unknown", matching the card's other unset cells. */
const DASH = '—';

const finiteOrDash = (value: number): string | null =>
    Number.isFinite(value) ? null : DASH;

/**
 * Position size: `>= 100` quotes one decimal, `>= 1` up to three, below 1
 * falls to 3 significant digits — `0.153846` → `0.154`, `0.0666667` →
 * `0.0667`. Trailing zeros never survive (`2.500` → `2.5`), so the SIZE cell
 * reads crisply and never clips mid-number.
 */
export const formatProposalQty = (qty: number): string => {
    const dash = finiteOrDash(qty);
    if (dash) return dash;
    const abs = Math.abs(qty);
    if (abs >= 100) return String(Number(qty.toFixed(1)));
    if (abs >= 1) return String(Number(qty.toFixed(3)));
    // Below 1: significant digits, not decimal places — 0.0666667 must not
    // become "0.067" (a 5% rounding lie) nor print six digits of noise.
    return String(Number(qty.toPrecision(3)));
};

/** Reward in R: two decimals, unit attached — `1.9067` → `1.91R`. */
export const formatProposalR = (r: number): string => {
    const dash = finiteOrDash(r);
    if (dash) return dash;
    return `${r.toFixed(2)}R`;
};

/** Percent: one decimal, unit attached — `36.4433` → `36.4%`. */
export const formatProposalPct = (pct: number): string => {
    const dash = finiteOrDash(pct);
    if (dash) return dash;
    return `${pct.toFixed(1)}%`;
};

/** Leverage: one decimal only when it exists — `0.68` → `0.7x`, `10` → `10x`. */
export const formatProposalLeverage = (lev: number): string => {
    const dash = finiteOrDash(lev);
    if (dash) return dash;
    const rounded = Number(lev.toFixed(1));
    return `${rounded}x`;
};

/**
 * Compact currency: `$103` at a hundred and up, two decimals below — a risk
 * figure's cents matter at $12.34 and are noise at $1,034.
 */
export const formatProposalUsd = (usd: number): string => {
    const dash = finiteOrDash(usd);
    if (dash) return dash;
    return Math.abs(usd) >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
};
