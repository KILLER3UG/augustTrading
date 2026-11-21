---
name: Confirmed Range and Breakout
description: Fade confirmed ranges with at least two rejections, trade closed-bar breakouts with S&R-flip retests, and gate every entry on fakeout protection plus Spot/Perp CVD and VPIN confirmation.
---

## When to use

- `get_regime` reads `values.direction: 'range'` (or `values.quant.varianceRatio.k4 < 1`,
  `values.quant.hurst < 0.5`) — the tape oscillates rather than trends.
- `get_key_levels` / `sr_zones` (`values.range_state`) print a range the price has respected, and
  `swing_structure` (`values.trend`) shows the pivot sequence flattening.

## Steps

1. **Confirm the range:** at least TWO rejections of the same boundary —
   `get_key_levels` (`session_levels.rows[].touches >= 2`) / `sr_zones` (`values.zones[].touches >= 2`), or equal highs/lows
   from `liquidity` (`values.equal_highs_lows[].touches >= 2`). One touch is a level, not a range.
2. **Fade the rejection:** enter when a closed bar rejects the boundary
   (wick through, close back inside) with `imbalances` (`values.gaps`) showing no unfilled
   gap pulling through it. The stop sits beyond the boundary + `1σ` of
   `get_regime` → `values.quant.expectedMove1Sigma.dollars` — never inside normal noise.
3. **Breakout instead:** when a bar CLOSES beyond the range (not a wick),
   wait for the S&R-flip retest — the broken boundary retested from the
   other side as support/resistance — and enter on the hold, stop beyond
   the flip level.
4. **Flow confirmation:** `order_flow` → `values.spot_perp_divergence.classification` must not read
   `absorption_risk` against the trade, and `values.vpin.vpinPercentile >= 90`
   (`values.vpin.toxicityWarning: true`) is a stand-aside — informed flow is
   pulling liquidity.
5. Targets: the opposite boundary first (range trades are boundary-to-
   boundary), then the measured move.

## Pitfalls

- A single touch is not a range. Two rejections minimum, or refuse.
- A wick through the boundary that closes back inside is the FAKEOUT the
  fade wants; a CLOSE through it is the breakout the flip wants — never
  confuse the two.
- `order_flow` → `values.vpin.toxicityWarning: true` — stand aside; the tape is being
  pulled by informed flow.
- Thin significance: the base rate is quoted only when
  `setup_base_rate` → `values.sample_uniqueness.nEffective >= 5`, and significance (`values.entry_significance.pValue`) requires `values.entry_significance.nEffective >= 10` — overlapping
  signals on one move are one observation.

## Verification

- `get_regime` (`values.direction`, `values.quant.*`), `get_key_levels` / `sr_zones`
  (`touches`), `order_flow` (`values.spot_perp_divergence`, `values.vpin`), and `imbalances` (`values.gaps`) — all
  deterministic closed-bar reads, reproducible from the same tape.
- The refusals (single touch, thin buckets, missing spot leg, toxicity)
  are part of the skill: refusing IS the trade decision.
