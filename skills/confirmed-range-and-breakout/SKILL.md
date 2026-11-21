---
name: Confirmed Range and Breakout
description: Fade confirmed ranges with at least two rejections, trade closed-bar breakouts with S&R-flip retests, and gate every entry on fakeout protection plus Spot/Perp CVD and VPIN confirmation.
---

## When to use

- `get_regime` reads `direction: 'range'` (or `varianceRatio.k4 < 1`,
  `hurst < 0.5`) — the tape oscillates rather than trends.
- `get_key_levels` / `sr_zones` print a range the price has respected, and
  `swing_structure` shows the pivot sequence flattening.

## Steps

1. **Confirm the range:** at least TWO rejections of the same boundary —
   `get_key_levels`/`sr_zones` rows with `touches >= 2`, or equal highs/lows
   from `liquidity` with `touches >= 2`. One touch is a level, not a range.
2. **Fade the rejection:** enter when a closed bar rejects the boundary
   (wick through, close back inside) with `imbalances` showing no unfilled
   gap pulling through it. The stop sits beyond the boundary + `1σ` of
   `get_regime.quant.expectedMove1Sigma` — never inside normal noise.
3. **Breakout instead:** when a bar CLOSES beyond the range (not a wick),
   wait for the S&R-flip retest — the broken boundary retested from the
   other side as support/resistance — and enter on the hold, stop beyond
   the flip level.
4. **Flow confirmation:** `order_flow.spot_perp_divergence` must not read
   `absorption_risk` against the trade, and `order_flow.vpin.vpinPercentile
   >= 90` (`toxicityWarning: true`) is a stand-aside — informed flow is
   pulling liquidity.
5. Targets: the opposite boundary first (range trades are boundary-to-
   boundary), then the measured move.

## Pitfalls

- A single touch is not a range. Two rejections minimum, or refuse.
- A wick through the boundary that closes back inside is the FAKEOUT the
  fade wants; a CLOSE through it is the breakout the flip wants — never
  confuse the two.
- `order_flow.vpin.toxicityWarning: true` — stand aside; the tape is being
  pulled by informed flow.
- Thin significance: the base rate is quoted only when
  `setup_base_rate.sample_uniqueness.nEffective >= 5` — overlapping
  signals on one move are one observation.

## Verification

- `get_regime` (range + percentiles), `get_key_levels`/`sr_zones`
  (touches), `order_flow` (divergence + VPIN), `imbalances` (gaps) — all
  deterministic closed-bar reads, reproducible from the same tape.
- The refusals (single touch, thin buckets, missing spot leg, toxicity)
  are part of the skill: refusing IS the trade decision.
