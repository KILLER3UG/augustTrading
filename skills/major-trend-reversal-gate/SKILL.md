---
name: Major Trend Reversal Gate
description: A mandatory 3-step confirmation gate before trading against an established trend — trendline/EMA break, lower-momentum extreme test, and a non-overlapping signal bar or >75%-cleared composite reversal — with partial profit at the first magnet.
---

## When to use

- `get_regime` reads `direction: 'trend'` (or `hurst > 0.5` /
  `varianceRatio.k4 > 1`) and the trader is considering a counter-trend
  entry.
- Never used inside `brooks.barbwire` chop or when
  `quant.trendScanRefused` is set (the tape is too thin to prove the turn).

## Steps

1. **Break:** require the trend's mechanical line to break on a CLOSED bar —
   the EMA(20) gap-bar streak ends with a re-contact
   (`get_regime.brooks.ema20GapStreak` collapsing to 0 with
   `maGapBarSetup: true`), or a swing break printed by
   `swing_structure.last_break` (`CHoCH` against the prevailing trend).
2. **Momentum extreme:** require the counter-move to print a
   lower-momentum extreme — the pullback's swing made the extension low/high
   while `get_regime.trendScan.tStat` on the short horizons (10/20) flips
   sign or collapses toward 0. A break with the trend-scan still at full
   strength is a pause, not a reversal.
3. **Signal bar:** require a NON-OVERLAPPING reversal bar, or a 2-bar
   composite whose `overlapRatio > 0.75` clears BOTH bars' extremes
   (`swing_structure.composite_candle.two_bar` + the cluster trigger from
   `inside_cluster`). A reversal bar whose midpoint is still inside the
   prior bar's geometry (`brooks.reversalOverlapTrap: true`) is a refusal.
4. Enter on the trigger; take the FIRST partial at the nearest magnet
   (`get_key_levels` session levels or the FVG midpoint from `imbalances`)
   and move the stop to break-even. The remainder targets the next
   structural level.
5. Confirm the flow: `order_flow.spot_perp_divergence` in
   `absorption_risk` or `spot_led` against the old trend supports the turn;
   `vpin.vpinPercentile >= 90` (`toxicityWarning`) says the liquidity is
   being pulled — widen caution accordingly.

## Pitfalls

- Skipping step 2 is the classic top-picker: a break without a
  momentum extreme is continuation fuel.
- A trap midpoint (`reversalOverlapTrap: true`) inverts the signal — stand
  aside.
- Counter-trend trades are half-size by definition; the first magnet is the
  exit, not the moon.

## Verification

- Every input is a deterministic read of closed bars: `swing_structure`,
  `get_regime` (trend-scan t-stats, EMA20 streak), `order_flow`
  (spot/perp divergence, VPIN) and `imbalances` (magnets) — reproducible
  from the same tape, with the refusals named.
