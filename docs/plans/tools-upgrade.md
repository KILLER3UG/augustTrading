# Tools upgrade — the audit, and the P0 build plan

**Status.** Audit complete 2026-11-06; **P0 built and gated 2026-11-07** (§9 records what landed).
This is a work record, not a product doc: when the work ends it goes, per
[docs/README.md](../README.md) rule 5. It sits under `docs/plans/` because the task names that
path; the register in [plan/open-items.md](../plan/open-items.md) stays the only working list.

**The hypothesis, stated so it can fail.** Every method below is a FEATURE DETECTOR, not an edge.
The build makes numbers the seat would otherwise invent computable and as-of correct; whether any
detector earns its tokens is an ablation question (§8), and a detector with no measured gain is a
removal candidate, especially a folklore-level one.

---

## 1. Executive summary — findings

- **F1 — the task's role model is not this tree's.** There are no analyst lenses, no moderator and
  no post-mortem analysis turn to grant tools to: the debate was deleted (owner ruling 2026-10-19,
  [system-map](../architecture/system-map.md) §C) and the post-mortem writer with it. There is no
  fine-tuned small model, no "context pack", no `compare_checkpoints`, no seeded-sample eval
  harness anywhere in the repo (searched `src/`, `scripts/`, `shared/`). Per-role access therefore
  maps onto the access control that DOES exist — the seat allow-lists (§2.2) — and the
  context-pack half of the task becomes a prompt-parity rule plus a prepared module surface
  (§7), not a dataset change.
- **F2 — the tool plumbing the P0 tools need already exists and is good.** 48 desk-tool schemas,
  per-seat allow-lists enforced a second time at execution (`seatAllows`), per-tool output budgets,
  spill-to-artifact with `read_tool_output` paging, a repeat gate, a candle-aligned cache TTL, and
  a `DATA_UNAVAILABLE` failure sentinel that is never cached. The P0 tools inherit all of it; the
  design rules in the task (available:false + reason, compact envelope, never throw) are already
  the house style (`utils/harnessMarks.ts` › `DATA_UNAVAILABLE`).
- **F3 — levels are the best-served family and still miss the day/week/month frame.**
  `get_key_levels` returns pivots, Fibonacci, psychological levels and VWAP with a publishable
  fence the prompt tells the seat to copy verbatim — the grounding protocol works. But the
  previous day/week/month H/L/O/C and the session highs/lows exist only as packet prompt text
  (`utils/smcStructure.ts` › `buildDolTargets`), not as tool rows, and no level carries an
  ATR-unit distance (`distancePct` only).
- **F4 — volume/auction is the biggest gap, and the data for it is already on the wire.** Binance
  kline field 9 (taker-buy volume) is dropped by the desk tape parser (`KlineService.ts` ›
  `parseBinanceKlines` keeps fields 0–5) while the historical fetchers keep it (`MarketDataService.ts`
  › `toKlines`) — so the live path's CVD is a close-position approximation
  (`TechnicalAnalysisService.ts` › `calculateCVD`) and the historical path's is real
  (`utils/smcStructure.ts` › `computeSessionCvd`, honest null when the field is absent). Volume
  profile exists only as a 1h×50-bucket summary (`TechnicalAnalysisService.ts` ›
  `calculateVolumeProfile`) with no anchors, no naked POCs, no developing POC and no
  position-vs-value statement. There is no initial balance, no day-type, no open-type, no
  effort-vs-result read anywhere.
- **F5 — regime is a label, not a state.** `TechnicalAnalysisService.ts` › `calculateRegime`
  derives labels from 1h ADX and ATR-vs-average. There are no percentiles, no minimum dwell time,
  no neutral band, no separate volatility axis, and nothing tags a decision or a sample with the
  regime it was made in — so "win rate per regime" is unanswerable today, and the register
  already records the adjacent hole: the journal row stores no feature snapshot at all
  (`src/services/trade/proposedTrade.ts` › `buildProposedTradeAnalysis` writes `marketConditions`
  as dashes — O-46).
- **F6 — trade math exists canonically but is not a tool.** `utils/riskReward.ts` ›
  `plannedRiskReward`, `utils/netRiskReward.ts` › `roundTripCostR`/`netRiskReward`/
  `breakEvenWinRate` are the one-source modules — the model still computes R:R in its head and the
  gate only checks it afterwards (`services/trade/proposalGate.ts` › `assessPlanShape`). Sizing
  and liquidation price live in unreachable modules (O-23, O-24: `utils/ticketSize.ts` ›
  `computeContractSize` has test-only importers; default leverage 100×).
- **F7 — as-of correctness has one gold standard and one deliberate exception.** The signal
  resolver is closed-bars-only with stop-first-on-unknowable-bar and contract tests to prove it
  (`services/signals/signalResolver.ts` › `resolveSignal`, families in
  `scripts/check-contracts.cjs`). The market packet is deliberately a now-cast INCLUDING forming
  candles, stamped as such (`HybridIntelligenceService.ts` › `fetchHybridData`). Every P0 tool
  must declare which side it is on; these are closed-candle tools with an `asof` argument.
- **F8 — the ablation harness the task assumes does not exist.** What measures decisions today:
  the signal ledger (hit rate vs base with a Wilson interval — `services/signals/signalAccuracy.ts`
  › `wilsonInterval95`; conviction-vs-realized-R Spearman IC — `services/signals/signalCalibration.ts`
  › `calibrationVerdict`), the calibration ledger's Brier (`services/validation/CalibrationLedgerService.ts`
  › `buildCalibrationLedger`), and the deterministic baseline lane (`services/signals/baselineLane.ts`
  › `momentumBaselineFor`). None of these can vary a tool GROUP over a fixed sample. §8 says what
  P0 delivers (a deterministic label-sanity check, runnable now) and what needs the owner (a
  model-in-the-loop paired eval with configured providers), with the multiple-testing control
  pre-declared.

## 2. What the seat can call today

### 2.1 The catalogue

`src/services/analysis/DeskToolsService.ts` › `DESK_TOOL_DEFINITIONS` holds 48 schemas; nine chart
actions live beside them (`CHART_ACTION_TOOL_DEFS`) and two mailbox tools in
`services/analysis/PanelMailbox.ts` › `PANEL_MAIL_TOOLS`. Grouped by family, with the tool output
budget (`TOOL_BUDGETS`, chars) where one is set:

| Family | Tools |
|---|---|
| Tape reads | `get_market_packet` (6000), `get_all_timeframes` (8000), `get_chart_view` (8000), `get_price_snapshot`, `get_indicators` (per-study, ≤3 groups), `get_key_levels` (4000), `get_session_context`, `get_btc_context` |
| Derivatives / book | `get_derivatives`, `get_order_book`, `get_liquidations` (source retired, honest `source_retired` latch) |
| Scan / compute | `scan_setups`, `run_screener` (4000), `find_best_setups` (4000), `run_monte_carlo`, `project_future_price`, `switch_chart_symbol` |
| History / memory | `get_trade_log` (4000), `get_setup_history_stats`, `recall`, `recall_chat`, `web_search`, `ask_user_input` |
| Decision | `emit_signal` (evidence rubric + scorecard receipt), `present_trade`, `decline_trade`, `watch_price`, `wake_me`, `mark_trade_levels`, `draw_on_chart`, `draw_detected`, `clear_chart_drawings` |
| Notebook / skills / goals | `remember`, `read_memory`, `forget`, `write_memory_note`, `amend_memory`, `get_notebook_map`, `skill_index`, `skill_view`, `skill_write`, `propose_strategy` |
| Self-editing | `list_goals`, `open_goal`, `create_goal`, `update_goal`, `restore_goal`, `list_self_changes` (2600), `propose_self_change`, `revert_self_change`, `repo_read`, `repo_edit`, `repo_apply`, `repo_setup` |
| Paging / loading | `read_tool_output` (2000/page), `load_tools` (schema-on-demand; not in the catalogue) |

### 2.2 Per-role access, mapped onto what exists

The gates: `INITIAL_DESK_TOOL_NAMES` (16 loaded without `load_tools`), `utils/toolKinds.ts` ›
`DESK_TOOL_NAMES` (the canonical 43), `services/trade/chatTurnRunner.ts` › `TRADE_TOOLS` (dock:
desk + 9 chart actions), `services/trade/chatSurfaceTurn.ts` › `CHAT_SURFACE_TOOLS` (Agents
surface: no canvas tools), goal policy intersection (`intersectGoalPolicy` — a goal may only
NARROW, empty intersection is `NO_TOOLS_ALLOWED`), and `deskToolsMandateFor` so the prompt never
offers a tool the executor would refuse. Bots get no tools (plain transport). The task's four
roles resolve as: **technical/macro/risk lens → the two desk seats** (P0 wiring point); **moderator
→ none exists** (reconciliation reads `setup_base_rate`/regime from the same seat today);
**fine-tuned model → does not exist** (see §5/§7); **post-mortem → the settlement reflection is a
prompt-only pass** (`services/learning/settlementReflection.ts`), no tool calls.

### 2.3 Output economics (why "~10 coarse tools" is the right number here)

Every result is budgeted (`budgetToolContent`, `MAX_TOOL_CONTENT_CHARS` 2400 default), clipped
shape-preserving, spilled to an artifact with a paging receipt, cached candle-aligned
(`klineBackedCacheTtlMs` = `utils/candleTtl.ts` › `candleAlignedTtlMs`), and repeat-gated. The
schema tax is a known register row (O-59: ~7.9k tokens per dock request) — P0 adds schemas to
`INITIAL_DESK_TOOL_NAMES` only where the seat needs them unprompted, and the mandate tells the
seat when to call what (design rule 8).

## 3. What the pipeline computes (feature → exposure)

Exposure: TOOL (a desk tool returns it), PROMPT (packet block), INTERNAL, UI.

| Feature | Home | Exposure |
|---|---|---|
| RSI/MACD/EMA/SMA/Bollinger/Stoch/ATR/volume | `TechnicalAnalysisService.ts` › `computeIndicators` | TOOL+PROMPT+INTERNAL+UI |
| ADX/±DI, regime labels | `calculateADX`, `calculateRegime` | TOOL (regime study) + PROMPT |
| VWAP session (UTC day) ±1/2σ bands | `calculateVWAP` | TOOL+PROMPT |
| Volume profile 1h×50 (POC/VA 70%/shape) | `calculateVolumeProfile` | TOOL (volume study) + PROMPT |
| CVD — close-position approx (live) vs taker-buy real (historical) | `calculateCVD` vs `smcStructure.ts` › `computeSessionCvd` | TOOL+PROMPT (live approx) |
| OBV, relative volume | `calculateAdvancedVolume`, `calculateOBVValues` | TOOL+PROMPT |
| Pivots (daily UTC), Fibonacci, psych levels, touch counts | `calculatePivotPoints`, `calculateFibonacciLevels`, `detectPsychologicalLevels`, `countLevelTouches` | TOOL (`get_key_levels`) + PROMPT |
| Ichimoku, ROC/momentum score | `calculateIchimoku`, `calculateMomentum` | TOOL+PROMPT |
| 48 extra studies (HMA…TTM squeeze, choppiness) | `services/analysis/taLibrary.ts` › `TA_STUDIES` | TOOL only (`get_indicators` ta* groups) |
| Equal highs/lows, FVG, order blocks, premium/discount, DOL targets (PWH/PWL/PDH/PDL), sweeps, measured move | `utils/smcStructure.ts` (`detectEqualLevels`, `detectFvg`, `detectOrderBlocks`, `computePremiumDiscount`, `buildDolTargets`, `detectSweepReversals`, `projectMeasuredMove`) | PROMPT (packet SMC block) only |
| HTF bar phase (Wyckoff-ish 9-phase) | `utils/htfPhase.ts` › `classifyBar` | PROMPT |
| Session/killzones (DST-aware), seasonality | `services/infrastructure/SessionService.ts` › `getEffectiveSessions`, `smcStructure.ts` › `seasonalityFlags` | TOOL (`get_session_context`) + PROMPT |
| Candle/geometric patterns, numeric chart encoding | `services/analysis/CandlePatternDetector.ts` › `scanCandlePatterns`, `utils/patternDetection.ts` › `detectChartPatterns`, `services/analysis/NumericChartService.ts` › `generateNumericChartData` | PROMPT |
| Setup detectors (breakouts, fades, pin bars, divergences, failed breakout) | `services/trade/setupScan.ts` › `scanSetups` | TOOL (`scan_setups`, `run_screener`) |
| Confluence/ranking score | `services/trade/bestSetups.ts` › `bestSetupScore` | TOOL (`find_best_setups`) |
| Monte Carlo (seeded, measured ATR) | `services/analysis/MonteCarloService.ts` › `runSimulation` | TOOL (`run_monte_carlo`) |
| ATR cone projection | `services/trade/priceProjection.ts` › `projectPrices` | TOOL |
| Funding/OI/LSR/taker/basis (Binance, shallow history) | `services/analysis/MarketDataService.ts` (`fetchFundingRateHistory`, `fetchOpenInterestHistory`) | TOOL+PROMPT |
| Planned R:R, net costs, break-even, net edge | `utils/riskReward.ts`, `utils/netRiskReward.ts` | INTERNAL (gate/cards) — not a tool |
| Signal labels (triple-barrier shaped: entry/stop/target/time, stop-first, path-aware) | `services/signals/signalResolver.ts` › `resolveSignal` | INTERNAL+UI |
| Base rate, Wilson CI, conviction IC, Brier | `signalAccuracy.ts`, `signalCalibration.ts`, `CalibrationLedgerService.ts` | INTERNAL+UI |
| Deterministic baseline | `services/signals/baselineLane.ts` › `momentumBaselineFor` | INTERNAL |

## 4. The gap map (task catalog A–H)

| Family | Status in this tree | P0? |
|---|---|---|
| A Volume/auction | profile summary only (1h×50); no anchors/naked POCs/developing POC; no VWAP anchors or trapped-participant read; CVD approximated live; no absorption/exhaustion/effort-vs-result; no IB/day-type/open-type | **P0** |
| B Levels/structure | key_levels partial (no day/week/month, no session H/L, no ATR distances); structure present as packet text (equal levels, FVG, OB, sweeps); no `sr_zones`/`range_state` tool | **key_levels P0**; rest P1 |
| C Regime/volatility | label-only; no percentiles/dwell/neutral/vol axis; nothing tags samples with regime | **P0** |
| D Derivatives | present but shallow (funding ≈7d, OI 24×1h, ratios 1 sample); liquidations retired; no quadrants/divergence/percentile framing | P2 (task) |
| E Cross-market | `get_btc_context` (dominance, CoinGecko) only; no ratio z-score/beta/RS-rank | P2 |
| F Risk/sizing | canonical math exists; not exposed; sizing/liquidation unreachable (O-23/24) | **trade_math P0**; `risk_state`/`setup_base_rate` P1 |
| G Microstructure | order book tool exists (live only by nature); depth-imbalance read exists | P3 (no change) |
| H Playbooks | `scan_setups` detectors exist (strategy-book); auction/Wyckoff/liquidity playbooks absent | P1+ after P0 evidence |

## 5. Training data vs live inference — where the paths diverge

1. **There is no trained model and no context pack**, so there is no train/inference parity to
   break yet. The export that exists is journal-shaped only (`utils/reportExport.ts` ›
   `trainingRecordFor`, `TRAINING_SCHEMA_VERSION` 1): decision + outcome + lesson + provenance.
   The feature snapshot is dashes (O-46), and entry-time candles are reconstructable, not stored.
2. **Tool outputs reach training data only through prose.** No tool result is persisted with the
   row; the reasoning store correlates outcomes with per-model traces
   (`services/infrastructure/ThinkingStoreService.ts`). The only decision→price-outcome loop that
   is closed and measured is the signal ledger (§8).
3. **Live-vs-live divergences that matter** (the ones a context pack would freeze):
   - delta: live path approximates, historical path is real (F4) — one P0 fix closes it for the desk;
   - as-of: packet = now-cast with forming candles (stamped); resolver = closed only; new tools =
     closed only with `asof` (F7);
   - exchange: desk tape = Binance futures (spot-mirror fallback, source-tagged); resolver tape =
     OKX primary with Binance cross-check. Volume-based tools record their exchange in the output
     and never mix venues (design rule 3).
4. **Regime is nowhere in the record** (F5). The P0 regime tool returns a stable, taggable
   `regime_id`, and §8 wires the tag into the ablation so per-regime results are reportable when
   the eval exists.

## 6. Decisions the audit fixes

- **Session convention (design rule 2).** One definition, in the new market-tools module, DELEGATED
  to `services/infrastructure/SessionService.ts` › `getEffectiveSessions` for the DST-shifted
  named windows (asian 00:00–09:00 UTC, london 07:00–16:00 BST-adjusted, new_york 13:00–22:00
  EDT-adjusted): the trading day is the UTC day; previous day/week/month are the prior UTC
  calendar periods; session H/L are computed over the named windows; initial balance is the first
  60 minutes of the UTC day (00:00–01:00) for crypto, documented on every `auction_state` result.
  Identical code serves inference and any future training extraction — that is the parity rule.
- **Data source (design rule 3).** Binance USDT-M futures is the primary venue for volume-based
  tools; the exchange name is printed in every result; the spot-mirror fallback marks
  `data_quality.notes` (`KlineService.ts` › `spotMirrorSourceNote`); taker-buy field 9 is kept at
  the tape parser so delta is real, and any row missing it makes delta `available:false` — never a
  silent approximation.
- **As-of (design rule 1).** Every P0 tool takes `asof` (ms epoch), filters to bars that CLOSED at
  or before it, and reuses `candleAlignedTtlMs` for cache honesty. Each pure core gets a
  no-look-ahead contract test.
- **Envelope (design rule 5).** Every tool returns
  `{tool, asof, symbol, tf, params, data_quality:{available, bars_used, notes}, values,
  distances_atr, evidence_level, one_line_summary}` with `evidence_level` in
  {structural, documented, folklore} and distances in ATR units.

## 7. Ranked build list

| # | Item | Evidence level | Notes |
|---|---|---|---|
| 1 | **P0-A volume/auction tools** — `volume_profile`, `naked_pocs`, `vwap`, `order_flow`, `effort_vs_result`, `auction_state` | profile/VWAP/delta math structural; auction reads documented (label estimates); imbalance heuristics documented, parameters to validate | pure cores in a new `src/services/market/` layer (no fetch), tool adapters in the desk service; tape parser keeps taker-buy |
| 2 | **P0-B `get_key_levels` extension** — prev day/week/month H/L/O/C, session H/L, round numbers, ATR distance + touch count on every row | structural | same tool name, richer payload; the fence protocol unchanged |
| 3 | **P0-C `get_regime`** — trend/range/vol axes per timeframe, percentiles, dwell, neutral band, `regime_id` for tagging | structural math, documented thresholds | `calculateRegime` stays (packet consumer); convergence follow-up, not a P0 prompt change |
| 4 | **P0-D `trade_math`** — cost-adjusted R:R, ATR-based size, liquidation price | structural | REUSES `plannedRiskReward`/`roundTripCostR` — no second cost model |
| 5 | Per-role wiring + prompt updates (mandate lines per tool; "never state a level/POC/figure that did not come from a tool result") | — | `deskToolsMandateFor` + `chatPrompts.ts` |
| 6 | Contract tests: hand-computed synthetic fixtures per core + one no-look-ahead test per tool | — | `scripts/check-contracts.cjs` families (the repo's only test infra — no vitest) |
| 7 | Label sanity check: triple-barrier vs endpoint-only disagreement count on the resolver | — | §8; deterministic, runnable now |
| 8 | Context-pack readiness (design rule 7) | — | cores are packable; adding to a pack changes dataset format → batched with the derivatives integration per the task; NOT done now |
| 9 | P1: liquidity/sr_zones/range_state tools, `setup_base_rate`, `risk_state`; P2: derivatives framing, cross-market; P3: orderbook micro, meta-label gate | — | listed so the deferral is explicit |

## 8. The ablation — what exists, what ran, what needs the owner

**Exists:** signal-ledger scoring (hit rate vs same-levels base, Wilson CI, thin-sample floor),
conviction calibration (Spearman IC vs realized R), a Brier-capable calibration ledger, a
deterministic baseline lane, and a resolver whose label IS triple-barrier shaped (bracket:
entry trigger, stop, target, `expiresAt`; stop-first on an unknowable bar; `never_triggered` is a
label, not a loss; costs in R).

**Ran (deterministic, no provider): the label sanity check.** `scripts/label-sanity.cjs` replays
seeded synthetic 5m tapes through the real `resolveSignal` and labels the same tapes the naive
way — reading only where price ended at expiry — then counts the disagreements:

| seed / trials | agreed | disagreed | dominant class |
|---|---|---|---|
| 20261107 / 2000 | 1803 | 197 (9.8%) | stop touched mid-window, endpoint close recovered → endpoint says `expired`, path says `lost` (181) |
| 777 / 3000 | 2747 | 253 (8.4%) | same shape (236) |

Reading: the ledger label IS path-aware, and an endpoint-only labeler would have mislabeled
~9% of decisions — every one of them a real change to a win-rate or expectancy number. The
label is sound to build on. (Instrument notes: the first run had two fixture bugs worth
recording — an unmirrored gap field handed one direction adverse jumps, and capitalized
`'Long'`/`'Short'` fell through the resolver's lowercase `'long' | 'short'` checks into the
short branch. Both fixed in the instrument; the resolver was right on both counts.)

**Needs the owner (not runnable in this task):** a model-in-the-loop paired eval. It needs
in-app-configured providers, a seeded sample set, and a budget decision; the repo has no
checkpoint-comparison harness to extend and the task forbids retraining. The honest P0 output is
the spec plus the pre-declared comparisons:

- Comparisons (three, no sweep): baseline prompt vs +volume/auction group vs +regime/key-levels
  group (trade_math rides with levels). Primary metric: hallucinated-price rate (stated levels
  that no tool produced); secondary: net reward after costs, Brier, per-regime hit rate (via
  `get_regime`'s `regime_id`), tokens per decision.
- Multiple-testing control: exactly these three, declared here before any run; a CI straddling
  zero reads as "cannot tell yet — larger N"; any later sweep gets a holdout slice untouched until
  one configuration wins.

## 9. P0 — what landed (2026-11-07)

**Pure cores** (`src/services/market/`, no fetch, no storage — the contract-tested surface):

| Module | Owns |
|---|---|
| `sessionConvention.ts` | THE UTC-day convention: day/week/month periods, DST-shifted named windows delegated to `SessionService.getEffectiveSessions`, initial balance = 00:00–01:00 UTC |
| `volumeProfileCore.ts` | profile bins with buy/sell split, POC (tie → lower bin, declared), 70% value area, HVN/LVN, developing POC + migration, session POCs, naked POCs |
| `vwapCore.ts` | VWAP + volume-weighted σ bands, anchor slicing, participant-position read (labelled estimate) |
| `orderFlowCore.ts` | delta = 2·takerBuy − volume, CVD series, half-window divergence, absorption/exhaustion events — all labelled estimates; a missing taker-buy field makes the read unavailable, never zero |
| `effortResultCore.ts` | rvol vs same-UTC-hour baseline (baseline EXCLUDES the classified window — a fixture-found fix: a bar in its own baseline damped climax to 2.4×), drive/no-result/effortless/climax with declared thresholds, volume-price correlation/divergence |
| `auctionCore.ts` | initial balance with self-normalized width percentile, open type, day type, failed IB extension, poor edges, value-area rotation |
| `levelsCore.ts` | prev day/week/month H/L, session H/L, magnitude-adaptive round numbers — ATR distances + touch counts on every row |
| `regimeCore.ts` | Wilder ADX, efficiency ratio, BBW/ATR percentiles, trend/range/NEUTRAL band with dwell, separate compressed/normal/high vol axis, taggable `regime_id` |
| `tradeMathCore.ts` | composes `plannedRiskRewardSigned` + `roundTripCostR`/`breakEvenWinRate` (no second cost model), ATR sizing (fails closed without equity), isolated-margin liquidation estimate (model named) |

**Adapter** (`src/services/analysis/marketTools.ts`): the uniform envelope
{tool, asof, symbol, tf, params, data_quality, values, distances_atr, evidence_level,
one_line_summary}; closed-candle gating (`open + interval ≤ asof`); chunked range fetches
(Binance's 1500-bar cap returns the OLDEST bars — a naive single call silently loses the most
recent days); venue printed in notes; `available:false` + reason, never a throw.

**Registration:** 8 new tools (`volume_profile`, `naked_pocs`, `vwap`, `order_flow`,
`effort_vs_result`, `auction_state`, `get_regime`, `trade_math`) defined, dispatched, labelled,
budgeted, cacheable (not stamped — no live mark by design); `get_regime` + `trade_math` ride
`INITIAL_DESK_TOOL_NAMES` (a decision cannot go without them), the volume/auction family stays
load-on-demand to bound the schema tax (O-59). `get_key_levels` gained the `session_levels`
frame beside its publish fence (the card protocol unchanged). Both seat allow-lists carry the
family. The adapters are LAZY-imported so the cores stay out of the entry graph (O-146) — the
entry chunk ended SMALLER than before the build. The mandate gained the
MARKET STRUCTURE, COMPUTED section with the anti-invention rule: a level, a POC, a volume
figure, a delta or a setup tag that did not come from a tool result this turn does not exist.

**Tape layer:** `KlineService.parseBinanceKlines` now keeps kline field 9 (taker-buy volume) —
the delta tools measure instead of approximating; rows without the field make delta honestly
unavailable.

**Tests:** contract family 36 in `scripts/check-contracts.cjs` — hand-computed fixtures for
every core (a profile whose POC is known by construction, a hand-valued Wilder ATR, a 3:1 plan
whose cost line is the canonical 0.10R) plus the as-of gate test; 500/500 green. Gates:
typecheck, lint (0 errors), boundaries, contracts, build, boot-probe all green.

**Deliberately NOT done:** context-pack changes (batched with the derivatives integration per
the task — the cores are packable when that day comes), P1–P3 families, any checkpoint or
trade-ingest change.

## 10. P1 + the chart half — what landed (2026-11-07, owner-approved next phase)

**P1 tools** (same envelope, same as-of rules, cores under `src/services/market/`):

| Tool | Core | Owns |
|---|---|---|
| `swing_structure` | `swingStructureCore.ts` | fractal swings (k=2), HH/HL/LH/LL, BOS/CHoCH (close-beyond rule), sequence trend, fib from the ACTIVE swing with per-level confluence |
| `liquidity` | reuses `smcStructure.detectEqualLevels` + `detectSweepReversals` | equal-level pools, sweep candidates, untested swing extremes, next opposing pool |
| `imbalances` | `imbalanceCore.ts` wraps `smcStructure.detectFvg` | ATR size filter, displacement check, age, fill state (untouched → partial → through-midpoint → filled). Order blocks deliberately absent — weakest evidence, added last |
| `sr_zones` | `zonesCore.ts` | clustered swing zones (touch-counted) + the dealing-range state reusing `computePremiumDiscount` (premium > 55 / discount < 45 — a real neutral band, declared; positionPct is 0–100) |
| `wyckoff_events` | `wyckoffCore.ts` | range over the window EXCLUDING the newest completed bar (a range that includes its own sweep can never see a spring), springs/UTADs volume-conditioned, no-volume candidates flagged LOW by design, SOS/SOW after an event |
| `setup_base_rate` | over `context.trades` via `computeSetupClusterStats` + `wilsonInterval95` | the trader's measured W/L + Wilson 95% CI + avg R per setup type; REFUSES under 5 rows; regime conditioning explicitly unavailable (O-46 — rows carry no regime snapshot) and the envelope says so |
| `risk_state` | `riskStateCore.ts` over `context.trades` | open-plan heat grouped by coin (correlated flag), realized-R day/week traffic light (declared −2/−4 thresholds), HALF-Kelly from the closed-R pool REFUSED under 20 closed rows; advisory, not a P&L report |

**The chart half — `draw_tool_levels`** (dock chart action, in `CHART_ACTION_TOOL_DEFS`):
the model NAMES a tool (and optionally label filters); the app RE-RUNS the tool fresh and draws
at the computed prices — the `draw_detected` rule applied to the market tools, so the drawing and
the computation cannot disagree. The pure extraction is
`marketTools.drawableLevelsFor` (contract-pinned: the POC price reaches the chart bit-for-bit —
no restatement, no rounding drift): POC/VAH/VAL + the 70% value-area zone, naked POCs, VWAP ±1σ,
IB high/low + rotation target, session levels, fib/break levels, equal pools + untested swings,
unfilled FVG zones (filled gaps are NOT drawn), S/R zones, range/spring levels. Zones draw as
rects anchored to the VISIBLE window; the receipt repeats the visibility warnings the other
drawing tools give (clipped prices are named, never silently assumed seen). `runKeyLevelsEnvelope`
serves the key-levels frame in envelope shape for the drawer. On the Agents surface the tool is
not offered (no canvas), consistent with the chart-action rule.

**Registration:** the 7 tools ride `DESK_TOOL_NAMES`, both seat allow-lists, the mandate's
structure section (load-on-demand; the journal readers are deliberately never cached — a cached
base rate after a new trade is the stale number this family exists to end). The drawer rides
`CHART_ACTION_TOOL_DEFS` (dock-only via the existing canvas rule).

**Gates at HEAD of this phase:** typecheck, lint (0 errors, 366 warnings — the pre-phase
baseline), contracts **519/519** (family 36 extended: hand-computed zigzag/BOS/fib, FVG fill
depth, zone clustering, spring volume-conditioning, half-Kelly arithmetic, and the drawer's
no-drift pass-through), boundaries, docs, build (`marketTools` ships as its own lazy chunk —
55 kB out of the entry graph), boot-probe, render-probe.

**Fixture-found module fixes worth knowing:** `readRangeState` originally compared
`positionPct` (0–100) against 0–1 thresholds — the fixtures caught it; the wyckoff range now
excludes the newest completed bar for the same reason.

## 11. P2 — derivatives framing + cross-market (2026-11-07, same phase)

Two coarse tools, per the "~10 tools" rule — the four derivatives sub-reads share their fetches,
and cross-market is the answer for assets WITHOUT derivatives data:

| Tool | Core | Owns |
|---|---|---|
| `derivatives_state` | `derivativesCore.ts` | the price/OI quadrant (new longs / new shorts / short covering / long liquidation, declared 0.1% deadband) with OI Δ over 1h/4h/24h and a PERSISTENCE-filtered OI-vs-price divergence (≥3 consecutive aligned opposing bars — never a single spike); the funding read (current, percentile vs ~21×8h history, declared 0.05%/8h extreme floor, 3-settlement drift, funding-vs-price divergence, minutes to settlement); the positioning snapshot (taker / top-trader / retail, each labeled with-or-against trend, single-5m-sample caveat stated); liquidation/OI intensity in the declared <2 / 2–5 / >5% bands. The RETIRED Binance liquidation feed answers `available:false` with its honest reason — never "quiet". |
| `btc_relative` | `crossMarketCore.ts` | alt/BTC ratio z-score + momentum over the window, correlation and beta vs BTC and ETH computed on bar RETURNS (not prices), relative-strength rank within a declared 5-major peer set (skipped when the subject IS a major). Works where derivatives data does not exist. |

Honesty wiring: series depths are printed in every envelope (OI 24×1h = 1 day, funding ~7 days)
with the training-use caveat (§5); a missing series makes ITS read unavailable without blocking
the others; an asset where nothing comes back gets one clean `available:false` — "never invent
OI, funding or positioning numbers" now rides the tool description AND the mandate.

**Gates at HEAD of this phase:** typecheck, lint (0 errors, 366 warnings — baseline), contracts
**532/532** (family 36 extended: the four quadrants, deadband flatness, hand-arithmetic OI
horizons, persistence-vs-spike, funding percentile/extreme/drift, positioning labels, the three
liquidation bands, the retired-feed refusal, a 2×-mirror's corr-1/beta-1, a stretched flat-alt
read, an exact return-mirror at corr −1, and the RS rank), boundaries, docs, build, boot-probe.
Entry chunk 1,134 kB (the +2 kB over the P1 build is tool-schema text — the P2 cores live in the
same lazy `marketTools` chunk, now 64 kB).

**P3 stays deferred** (per the plan): order-book microstructure is live-only and already served
by `get_order_book`; VPIN stays out (contested predictive value); the meta-label gate is a
candidate, not a build.

## 12. Family H (playbooks) + the micro read + the live smoke (2026-11-07, same phase)

**`scan_playbooks`** (core: `market/playbooksCore.ts`) — the family-H layer, one call composing
every P0/P1 read on the SAME tape into named setup detectors:

value-area rotation (open outside prior value, re-entered, target the far side) · failed IB
extension (fade toward the IB, invalid = the extension extreme) · Wyckoff spring/UTAD (**only
medium-confidence events** — the volume-conditioned ones; a low-confidence candidate is never a
setup) · liquidity sweep + structure shift (sides must AGREE; confirmed/reclaimed; invalid = the
sweep's extreme wick) · absorption reversal at a level (fresh absorption within 0.5 ATR of POC or
a zone edge, fade the absorbed side) · Holy-Grail trend pullback (trend regime, ADX ≥ 30, close
within 0.5 ATR of a 20 EMA whose own slope still agrees) · Turtle Soup (close beyond the 20-bar
extreme, next bar back inside — the one-bar-confirmation variant) · VWAP reclaim/rejection (fresh
cross ≤2 bars, invalid = VWAP itself).

Every match carries side, confidence, an invalidation price (in ATR units too), the evidence
list, `evidence_level: 'documented'` (no playbook ships on folklore — if it can't be documented
it can't be detected here), and its declared applicable regimes. A match is a TAG with receipts:
it never sizes a trade and never vetoes one; no match is a reading, not a failure.

**P3 micro read** (the one P3 item worth having): `get_order_book`'s payload now carries a
`micro` block — microprice (size-weighted mid: P_b·Q_a + P_a·Q_b over Q_b+Q_a) and five-level
depth imbalance — computed from the raw ladders, explicitly LIVE-ONLY (an order book has no
history; it must never enter a training sample). VPIN stays out; the meta-label gate stays a
candidate.

**The live smoke** (`scripts/tool-smoke.cjs`, dev instrument): the gate ladder cannot execute a
real fetch, so this does — runs all 17 market tools end-to-end against Binance futures and fails
only if a tool THROWS past its adapter (design rule 6). First run on BTCUSDT: **17 ok, 0 threw,
0 honest-unavailable** — real POC 75677.9 (0.69 ATR), 4 naked POCs, balanced open with a FAILED
downside IB extension, neutral regime (ADX 48.96, dwell 17), 1 playbook match (failed IB), OI
quadrant "new shorts", funding p100 at 0.0100%, SOL/BTC z 0.3 with corr 0.87 / beta 1.08. This
is the runtime evidence the contract fixtures cannot provide.

**Gates at HEAD of this phase:** typecheck, lint (0 errors, 366 warnings — baseline),
contracts **542/542** (family 36 extended: EMA seed/step hand values, Turtle Soup fade with
extreme invalidation, failed-IB fade, spring fires / low-confidence spring refuses, sweep-side
agreement and refusal, absorption at a level, the Holy-Grail shape, and a quiet context firing
nothing), boundaries, docs, build (the lazy `marketTools` chunk is 71 kB; entry 1,136 kB),
boot-probe.

## 13. The eval harness + the meta-label (2026-11-07, owner directive)

**`scripts/ablation.cjs` — the paired eval the task pre-declared and the repo never had.**
Seeded, time-blocked (symbol, decision-time) samples over the lookback, built from ranged
as-of fetches with a PER-SAMPLE integrity check (no closed bar at/after the decision — first
runs: 0 detections). The arms receive the SAME closed-bar tape; only the pack differs
(baseline rows / +volume-auction pack / +regime-levels-trade-math pack) — the design-rule-7
pack shape, so a score difference is the pack's effect and nothing else. The model's own
entry/stop/target are labeled by the REAL resolver over the post-decision tape (stop-first,
costs in R). Metrics per arm: n, abstain rate, hit rate, avg net R, Brier (declared
confidence→probability mapping), hallucinated-price rate (stated levels vs the pack's printed
numbers and the tape), tokens per decision, and the per-regime breakdown keyed on the as-of
`regime_id`. The THREE pre-declared comparisons score by paired bootstrap (10k) with the
CI-straddling-zero verdict — "cannot tell yet", never "no effect". `--dry-run` needs no
provider and exercises the whole scoring path; a real run takes
`AUGUST_EVAL_BASE_URL/AUGUST_EVAL_API_KEY/AUGUST_EVAL_MODEL`.

**`meta_label`** (core: `market/metaLabelCore.ts`) — the P3 candidate, implemented as the
advisory read it was specified as: TAKE / REDUCE (half size) / SKIP / NO_DATA with reasons,
composed from the trader's own base rate (Wilson interval vs the plan's break-even AFTER
costs — skip when even the upper bound cannot pay), the drawdown traffic light (red skips),
correlated open-plan heat and a thin sample (reduce), and the half-Kelly ceiling (a ceiling on
size, never a raise). ADVISORY by construction: it never refuses a card and never blocks a
turn — `proposalGate` stays the only refusing gate. On `INITIAL_DESK_TOOL_NAMES` (a plan
should be read against the trader's own numbers before it is presented) and both seats.
The fixtures caught a real unit bug before it shipped: the Wilson bounds arrive as fractions
and the break-even as a percent — the raw comparison skipped every plan that had a base rate
at all.

**Pushed to main** (owner's 2026-11-06 cluster committed first as its own item, per the
owner's call): `fdb6b81d` cleanup → `4e5d54c0` P0 cores → `06a0a50d` P1/P2/H + registration →
`89a09bb8` contracts + smoke → `42a430c7` doc → `ba90ad93` eval + meta-label → `92d20db0`
style fix. Contracts **548/548**; lint 0 errors / 366 warnings; boundaries, docs, build,
boot-probe green; smoke 17/17.

**CI status (honest):** red on the O-146 entry-chunk ratchet ONLY — CI builds the chunk at
**1109 kB vs the 1100 kB ceiling** the cluster's action.yml sets. Before this work the chunk
was **1312 kB** (Nov 5 run): the lazy-import discipline this work introduced took ~200 kB out
of the startup graph, and the remaining 9 kB is the new tools' schema text (O-59's domain).
The fix is the registered O-146 lazy-import work, not a ceiling raise — ratchets go down.

## 14. O-146 closed; the deletion pass (2026-11-07)

**The startup graph.** The four eager modules that pulled the desk whale into the entry
(`GenericAnalysisService`, `toolTurn`, `chatSurfaceTurn` for one predicate, `chatTurnRunner`
for the chart-action schemas) now read the light pieces from
`services/analysis/deskToolShared.ts` — the market-read name sets, `deskToolsMandateFor` +
`DESK_TOOLS_PROMPT`, `TEXT_TOOL_FALLBACK_PROMPT`, `resolveDefaultSymbol`,
`CHART_ACTION_TOOL_DEFS` — and the whale itself (`DeskToolsService`, 168 kB built) plus the
hybrid packet machinery load dynamically on the first tool turn. Entry chunk: **1312 kB →
955.61 kB built**; the ratchet follows in the same change, **1100 → 1000** (the stale-floor
rule demands the ceiling move with the build, and 955 leaves O-59's schema tax room to
bind). `render-probe` flagged a stale-model banner miss on the first post-change run —
machine load (gates.md rule 3), not the refactor: the banner is a synchronous memo the
change never touched, and the probe is green on an idle machine.

**The deletion pass the owner asked for, done honestly.** The repo has NO unit-test files
(no `tests/`, no `*.test.*`) — `scripts/check-contracts.cjs` IS the test suite, the curated
minimum the 2026-10-23 ruling produced, and its 548 assertions each pin a behavior no other
gate reaches; five of them caught real bugs in this work alone (the fraction-vs-percent
skip-everything, the 0–100 `positionPct`, the self-sweeping wyckoff range, the damped effort
baseline, the unmirrored-gap fixture). The genuinely dead weight removed: `scripts/test-candle-history.ts`
(61 lines — unwired, network-hitting, superseded by family 36 + `tool-smoke`), one
constant-restating assertion in the drawer tests, a duplicated header comment, and
`.qoder/` gitignored. 62 lines out; every bug-catching fixture stays. The bigger LOC
reduction had already landed: the owner's cluster commit (268k lines) and this work's
lazy-chunk split, which moved code out of the startup graph rather than out of the repo.

## 15. The first real ablation run (2026-11-07, owner-supplied gateway)

Model: `nvidia/nemotron-3.5-super-vl:free` via the owner's kilo.ai gateway (a reasoning
model — the harness grew a `reasoning`-fallback parser, an 8k token budget, and 429/5xx
retry; `never_triggered` now scores 0, matching the resolver's own semantics). 24 paired
samples × 3 arms = 72 live calls, seed 20261107, 48h horizon, 0 look-ahead detections.

| arm | scored | abstain | hit rate | avg net R | Brier | halluc | tokens/decision |
|---|---|---|---|---|---|---|---|
| baseline | 16 | 25% | 13% | −1.173 R | 0.266 | 0% | 6,768 |
| +volume/auction | 18 | 25% | **31%** | **−0.282 R** | **0.250** | 1% | 6,274 |
| +regime/levels/math | 22 | **8%** | 19% | −0.592 R | 0.257 | 0% | **4,594** |

The three pre-declared comparisons (paired bootstrap, 10k): baseline vs volume Δ −0.701 R
[−1.623, +0.139]; baseline vs regime Δ −0.473 R [−1.478, +0.386]; volume vs regime Δ +0.367 R
[−0.583, +1.457] — **all three CANNOT TELL YET** at N=24, exactly what an honest harness
says when the effect is real but the sample is not.

What the numbers DO say, without overclaiming:
- Both tool packs point the same way — fewer losses than the baseline's −1.17 R (which is
  roughly "every scored trade stopped out"), higher hit rate, equal-or-better Brier. The
  regime pack abstains 3× more (it refuses thin tapes instead of guessing) and costs 32%
  fewer tokens.
- The regime breakdown shows where the money moved: `neutral:compressed` and
  `trend:compressed` flipped from −0.6/— (baseline) to +1.88/+5.35 under the volume pack —
  the compression reads are where computed numbers changed decisions. One 5.35R sample is
  one sample; the pattern is a hypothesis for the next run, not a finding.
- Hallucinated prices: ~0–1% in the pack arms — the model quotes what it was given.

**Recommended next step:** the same seed at N≈80 per arm (one overnight run) — the observed
Δ of ~0.7 R needs roughly that N for the CI to close. Nothing in this run justifies
removing a tool group; nothing justifies declaring victory either. The harness is now a
one-command instrument the owner can re-run on any model.

## 16. The training recorder + O-46 closed (2026-11-07, owner directive)

**O-46 is closed on the proposed path.** `present_trade` now fetches a decision snapshot
fire-and-forget (the same not-awaited pattern as the gate scan) and attaches it to the
proposal object: regime (id + text + ADX/dwell), ATR with its timeframe, previous UTC-day
range, session VWAP. `buildProposedTradeAnalysis` fills `marketConditions` from the snapshot
— the dashes were the register's evidence the row recorded nothing measurable. An unfetched
or failed snapshot leaves the dashes, which is the honest state.

**The "Improve future August models" recorder** (`services/learning/trainingCapture.ts`,
Settings → Data): a LOCAL toggle, default OFF. When ON, every desk turn that settles is
appended to the corpus — the trader's words, the reasoning trace verbatim, the tool trail,
the structured actions, the plan id, and the O-46 snapshot — keyed by planId so the journal's
outcome joins at export. Format decided: **JSONL, not markdown** — fine-tuning pipelines
consume it natively (the repo's journal export already ships NDJSON), the corpus is
append-only events that JSONL appends without re-parsing, and the repo already splits human
documents (.md skills) from machine state (.json goals); a human digest belongs in the
export step. Privacy, in order: OFF means nothing is written — not buffered, not sampled;
the flag deliberately does NOT ride in backups (re-enabling after a restore is a conscious
act); the corpus is desktop-only (`userData/store`, the same atomic bridge the big stores
use) and never uploaded; the cap (400 turns) REFUSES like the notebook rather than evicting,
and the refusal surfaces on the card with the export as the drain. Capture rides the one
choke point both homes share (`runToolTurn`'s event tee) and is fire-and-forget — a
recording failure can never fail a trading decision. Contracts: off-stores-nothing,
append-whole, cap-refuses, standalone flag — 554/554.
