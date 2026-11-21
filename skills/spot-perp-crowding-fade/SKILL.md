---
name: Spot-Perp Crowding Fade
description: Fade perp_chase crowding extremes with funding-carry awareness, gated by the full pre-trade desk check — volatility percentile, L2 slippage, effective base rate, flow confirmation and the macro-calendar reminder.
---

## When to use

- `order_flow` → `values.spot_perp_divergence.classification` reads `perp_chase` —
  perp delta is surging while spot lags or falls — at an extended level
  (`get_regime` → `values.quant.volPercentile >= 80` or `values.brooks.climaxBar: true`), and the
  trader is considering fading it.
- Works best when `get_regime` → `values.direction` is `range` or the chase is into a
  measured magnet (`imbalances` → `values.micro_measuring_gaps`, `get_key_levels`).

## Steps

1. **Pre-trade desk gate — all four, or refuse:**
   - `get_regime` → `values.quant.volPercentile` — quote it; a chase into `>= 90`
     with `order_flow` → `values.vpin.toxicityWarning: true` is a cascade risk, not an entry.
   - `get_order_book` with `notional_usd` and `side` (`'buy'` / `'sell'`) — quote `impact.impactVsTopBps`
     and `impact.slippageVsMidBps` (`impact.referenceSource: 'mid'`), and refuse the trade when `impact.available` is false (book cannot absorb the size or is stale).
   - `setup_base_rate` → `values.sample_uniqueness.nEffective` — the base rate is
     quoted only when `nEffective >= 5` (and `values.entry_significance.nEffective >= 10` for p-values); overlapping signals on one pump
     are one observation.
   - Macro calendar: **"macro event calendar UNKNOWN — verify FOMC/CPI/NFP
     manually"** — the desk has no reliable free calendar feed; say so
     instead of pretending.
2. **Carry check:** `get_btc_context` → `optionsContext` (BTC/ETH only: `dvol`, `realizedVolPct`, `vrp`) — when
   `optionsContext.vrp` is strongly positive, perp longs are paying up for insurance;
   `derivatives_state` (`values.funding_state`) or `get_derivatives` (`fundingRate`) plus `trade_math` (`expected_hold_hours` → `values.funding.dragR`) adds the per-settlement carry.
   A crowded long chasing into positive funding is paying to hold the
   squeeze — quote both numbers.
3. **Entry:** fade only on a CONFIRMED turn — a closed-bar rejection at the
   magnet (`swing_structure` → `values.inside_cluster` breakout failure, or
   `order_flow` → `values.events` absorption/exhaustion print), never against the
   chase mid-surge. Stop beyond the chase extreme + `1σ` (`get_regime` → `values.quant.expectedMove1Sigma.dollars`).
4. **Targets:** the magnet first, then the range mid; time-stop the fade —
   a chase that does not roll within a few bars is a trend, not a fade.

## Pitfalls

- `perp_chase` is a CONDITION, not a signal — the fade needs the confirmed
  turn or it is catching a freight train.
- Missing spot leg (`order_flow` → `values.spot_perp_divergence.available: false`) — say the
  divergence is unmeasurable; do not fade a number that does not exist.
- Thin books (`get_order_book` → `impact.available: false`) — the fade is untradable at
  size; stand aside or halve.
- The macro calendar is UNKNOWN by design — never invent a catalyst.

## Verification

- `order_flow` (`values.spot_perp_divergence`, `values.vpin`), `get_regime`
  (`values.quant.volPercentile`, `values.brooks.climaxBar`), `get_order_book` (`impact.impactVsTopBps`, `impact.slippageVsMidBps`),
  `get_btc_context` (`optionsContext.dvol`, `optionsContext.vrp`), and `setup_base_rate` (`values.sample_uniqueness.nEffective`) — every
  number is a deterministic closed-bar or live-book read, reproducible
  from the same snapshot.
- The refusals (toxicity, thin book, thin nEffective, non-BTC/ETH options,
  unknown macro) are the skill: refusing IS the decision.
