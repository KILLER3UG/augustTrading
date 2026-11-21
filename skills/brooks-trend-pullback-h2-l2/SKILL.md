---
name: Brooks Trend Pullback H2/L2
description: Trade pullback resumptions in an established trend using the deterministic bar-count, composite-candle and quant gates — with explicit refusals for barbwire, traps and thin significance.
---

## When to use

- The desk is in a declared regime: `get_regime` returns `values.direction: 'trend'`
  with `values.quant.trendScan.tStat` beyond ±10 on the 40/80-bar horizons (`values.quant.trendScan.byHorizon`), or
  `values.quant.varianceRatio.k4 > 1` / `values.quant.hurst > 0.5` (persistent tape).
- A pullback is visible: `swing_structure` (`values.bar_count`) reports an active
  `H1–H4` count in an uptrend or `L1–L4` in a downtrend.

## Steps

1. Read `get_regime` first. Refuse the setup when `values.brooks.barbwire` is true
   (overlapping doji chop — no stop entries), when `values.quant.volPercentile >= 90`
   without `values.quant.bbKcSqueeze`, or when the tape is thinner than the tool's
   floors (`values.quant.thresholds`).
2. Read `swing_structure`. Require the pullback count to be live
   (`values.bar_count.label` = H2+ for longs, L2+ for shorts — an H1/L1 is a probe,
   not an entry). The entry trigger is `values.bar_count.triggerPrice` (one tick
   beyond the signal bar's extreme); the invalidation is
   `values.bar_count.invalidationPrice`.
3. Confirm with the blended bars: `values.composite_candle.two_bar` and
   `.three_bar` must agree with the resumption direction
   (`netDirection`), and a fresh `values.inside_cluster` breakout
   (`ii`/`iii`/`ioi` → `breakoutHigh`/`breakoutLow`) is the strongest
   trigger of the three.
4. Price the trade with `trade_math` (pass `direction`, `entry`, `stop_loss`,
   `take_profits`; read `values.gross.ratio` and `values.costs.netRewardR`), then
   validate with `run_monte_carlo` (pass `direction`, `entry`, `stop_loss`,
   `take_profits`) — quote its `P(TP before SL)` (`pHitTpBeforeSl`), `CVaR95`
   (`cvar95R`), and `resampled tape drift` / mode from the receipt. In
   `empirical_bootstrap` mode the paths are the tape's own returns; in
   `gbm_fallback` the tape was too short (< 100 closed bars) — say so.
5. Size with `values.quant.expectedMove1Sigma`: a stop inside `±1σ` of normal noise is a
   refusal, not a tighter stop.

## Pitfalls

- `values.brooks.reversalOverlapTrap: true` — the "reversal" bar's midpoint has not
  cleared the prior bar's geometry; treat it as continuation until it does.
- An H1/L1 count is a probe. Only H2+ (or an inside-cluster breakout) is an
  entry.
- The Monte Carlo is a stochastic estimate, not a forecast — quote
  `P(TP before SL)` with the seed and the sample count, never as certainty.

## Verification

- `get_regime` (`values.quant.*`, `values.brooks.*`), `swing_structure` (`values.bar_count`,
  `values.composite_candle`, `values.inside_cluster`), `trade_math` (`values.gross.ratio`,
  `values.costs.netRewardR`), and `run_monte_carlo` (empirical bootstrap vs GBM fallback)
  are all deterministic and reproducible from the same closed bars.
- The refusal gates (barbwire, trap, thin tape, thin significance) are
  verified by the unit suite; a skipped refusal is a defect, not a style
  choice.
