---
name: Spot-Perp Crowding Fade
description: Fade perp_chase crowding extremes with funding-carry awareness, gated by the full pre-trade desk check — volatility percentile, L2 slippage, effective base rate, flow confirmation and the macro-calendar reminder.
---

## When to use

- `order_flow.spot_perp_divergence.classification` reads `perp_chase` —
  perp delta is surging while spot lags or falls — at an extended level
  (`get_regime.quant.volPercentile >= 80` or a `climaxBar` flag), and the
  trader is considering fading it.
- Works best when `get_regime.direction` is `range` or the chase is into a
  measured magnet (`imbalances.micro_measuring_gaps`, `get_key_levels`).

## Steps

1. **Pre-trade desk gate — all four, or refuse:**
   - `get_regime.quant.volPercentile` — quote it; a chase into `>= 90`
     with `toxicityWarning` is a cascade risk, not an entry.
   - `get_order_book` with `notional_usd` — quote `impact.impactVsTopBps`
     and refuse the trade when the book cannot absorb the size.
   - `setup_base_rate.sample_uniqueness.nEffective` — the base rate is
     quoted only when `nEffective >= 5`; overlapping signals on one pump
     are one observation.
   - Macro calendar: **"macro event calendar UNKNOWN — verify FOMC/CPI/NFP
     manually"** — the desk has no reliable free calendar feed; say so
     instead of pretending.
2. **Carry check:** `get_btc_context.optionsContext` (BTC/ETH) — when
   `vrp` is strongly positive, perp longs are paying up for insurance;
   funding (`get_derivatives.funding_state`) adds the per-settlement carry.
   A crowded long chasing into positive funding is paying to hold the
   squeeze — quote both numbers.
3. **Entry:** fade only on a CONFIRMED turn — a closed-bar rejection at the
   magnet (`swing_structure` inside-cluster breakout failure, or the
   `order_flow.events` absorption/exhaustion print), never against the
   chase mid-surge. Stop beyond the chase extreme + `1σ`.
4. **Targets:** the magnet first, then the range mid; time-stop the fade —
   a chase that does not roll within a few bars is a trend, not a fade.

## Pitfalls

- `perp_chase` is a CONDITION, not a signal — the fade needs the confirmed
  turn or it is catching a freight train.
- Missing spot leg (`spot_perp_divergence.available: false`) — say the
  divergence is unmeasurable; do not fade a number that does not exist.
- Thin books (`get_order_book.impact` refused) — the fade is untradable at
  size; stand aside or halve.
- The macro calendar is UNKNOWN by design — never invent a catalyst.

## Verification

- `order_flow` (divergence classification + VPIN), `get_regime`
  (percentiles, climax), `get_order_book` (impact vs top, mid reference),
  `get_btc_context` (DVOL/VRP), `setup_base_rate` (nEffective) — every
  number is a deterministic closed-bar or live-book read, reproducible
  from the same snapshot.
- The refusals (toxicity, thin book, thin nEffective, non-BTC/ETH options,
  unknown macro) are the skill: refusing IS the decision.
