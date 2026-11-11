# Chart → OKX parity: Phase 1 audit and gap table

**Date:** 2026-11-09 · **Status:** Phase 1 complete, read-only. No code changed.
**Reference:** OKX BTCUSDT Perp 15m screenshot (`Screenshot 2026-11-09 174550.png`), transcribed in full.

---

## 1. The chart today

**Component.** `src/components/trade/TradingChart.tsx` (1,304 lines), on `lightweight-charts` v5.2.1
(`createChart`, `CandlestickSeries`, `HistogramSeries`, `LineSeries`). Deliberately not the TradingView
embed — an iframe is blocked inside embedded webviews.

**Data flow.**

```
services/analysis/KlineService.ts › fetchKlines
  → services/trade/chartData.ts › toCandles / toVolumes
    → candles.setData(...) / volume.setData(...)
live: services/trade/futuresStreams › liveKline → last-bar patch
      + a freshness watchdog that re-syncs when the socket goes quiet
```

**State.** `chartDrawings.ts` persists drawings per symbol and per session
(`trade_session_drawings_v1` on Analyze, `trade_drawings_v1` in the dock). `TimeframeBar.tsx` persists
the timeframe bar per user (`trade_tf_bar_v1_<user>`).

### 1.1 What is actually rendered

| OKX feature | August today | Evidence |
|---|---|---|
| Candles, green up / magenta down | **Present** (green/red, not magenta) | `TradingChart.tsx:371-376` |
| Volume histogram, bottom of main pane | **Present** (bottom 18%, green/red) | `:377-381` |
| EMA(20), EMA(200) | **Missing** | — |
| Bollinger Bands + shaded fill | **Missing** | — |
| AVL average line | **Missing** | — |
| SMA(20) overlay | **Partial** — present and toggleable, off by default. Hand-rolled `sma()` at `:224`, drawn when `indicatorsOn` (toggled by the `ƒSMA` button at `:1196`) or the `showSma` prop | `:590-604` |
| TSI / RSI / MACD sub-panes | **Missing** | — |
| OHLC legend (O/H/L/C, Change, Range, VOL×2) | **Missing** — only a hover pill with 24h H/L/Vol | `:1222-1229` |
| Per-indicator legend rows, collapsible | **Missing** | — |
| Price source selector (Last / Mark / Index) | **Missing** — hardcoded `priceLineSource: 1` | `:375` |
| Chart type switcher | **Missing** — candles only | — |
| Timeframes 1s/1m/5m/15m/1h/4h/1D | **Partial** — 1m,3m,5m,15m,30m,1h,2h,4h,6h,12h,1D,3D,1W,1M; **no 1s**; default bar `1m 5m 15m 1h 4h 1D` | `utils/chartIntervals.ts:13,18` |
| Current price tag + close countdown | **Missing** | — |
| Dotted last-price line | **Partial** — the library's own last-price line, no tag or countdown | `:375` |
| High / low markers for the visible range | **Missing** | — |
| Crosshair with price label + % from last | **Partial** — crosshair mode 0, no price label, no % | `:369` |
| Time-axis time label | **Partial** — PHT formatter only | `:366-367` |
| Event/news markers | **Missing** (out of scope: no news feed) | — |
| Drawing tools + undo/redo | **Present** (cursor, trendline, ray, hline, zone, fib, freehand, eraser, undo, clear, magnet, width) | `ChartToolRail.tsx` |
| Favorites strip | **Missing** — `SymbolPicker` has no favorites | `SymbolPicker.tsx` |
| Below-chart tabs (orders/positions/assets) | **N/A** — August places no orders; maps to trade log / plans / review | — |
| Per-user indicator settings | **Missing** — nothing persisted | — |

---

## 2. The model does not see what the chart shows

The prompt path computes a **rich** indicator set from the `technicalindicators` library:
`services/analysis/TechnicalAnalysisService.ts:332` › `calculateIndicators` (memoised, LRU).

| Computed for the prompt | Where |
|---|---|
| RSI(6), RSI(12), RSI(14), RSI(24) | `TechnicalAnalysisService.ts:363-371` |
| MACD(12, 26, 9) | `:375-382` |
| EMA(5, 9, 13, 20, 21, 50, 200) | `:390-396` |
| SMA(5, 10, 20, 30, 50, 60, 200) | `:399-405` |
| Bollinger(20, 2) + bandwidth + %B | `:408-417` |
| Stochastic(14, 3, 3) + J | `:420-432` |
| ATR(14) | `:442-448` |
| VWAP, CVD, OBV, volume profile, ADX(14), Ichimoku, pivots, momentum | `:767`, `:818`, `:838`, `:1109`, `:1500`, `:1602`, `:1255`, `:1760` |

The chart hand-rolls its own `sma()` at `TradingChart.tsx:224` (off by default, toggled by `ƒSMA`). **The chart and the model share no
indicator code and no indicator values.**

---

## 3. The same indicator is computed in many places, and they disagree

Full inventory in the appendix. Nine documented disagreements:

| # | Indicator | Disagreement | Evidence |
|---|---|---|---|
| **D1** | **ATR(14)** | **Wilder vs simple average.** `smcStructure.atr14` is an SMA of true range (its own comment says so) and feeds **every** desk tool; `regimeCore.atrSeries` and the library `ATR.calculate` are Wilder. Same candles, two different numbers. **FIXED 2026-11-10: `atr14` now reads Wilder from `chartIndicators.atrSeries` (the forming candle is still dropped, warm-up still 0). `regimeCore.atrSeries` and `TechnicalAnalysisService` remain separate copies — tracked in open-items O-147.** | `utils/smcStructure.ts:20-37` vs `market/regimeCore.ts:48-52` vs `TechnicalAnalysisService.ts:442` |
| **D2** | **EMA seeding** | **First value vs SMA of first N.** `taLibrary.emaOf` seeds with the first value; `playbooksCore.emaSeries`, `regime.ema`, `screener.ema` and the library seed with an SMA. Every study composed from `emaOf` (DEMA, TEMA, ZLEMA, PPO, TSI, Elder Ray, Chaikin Volatility, Mass Index, SMI, Schaff, Klinger, Chaikin Oscillator) inherits the difference. | `taLibrary.ts:69-71` vs `playbooksCore.ts:70-73` vs `trade/regime.ts:26-29` vs `TechnicalAnalysisService.ts:390-396` |
| **D3** | **RSI** | `taLibrary.rsiOf`'s first smoothing step is not Wilder (SMA seed of the first smoothed value). | `taLibrary.ts:408` |
| **D4** | **"EMA20"** | **The setup scanner's EMA20 is actually SMA20** — `smaSeries(closes, 20)` assigned to `ema20`, detecting the same setup the playbook scanner finds with a real EMA. **FIXED 2026-11-10: `setupScan` imports `emaSeries` from `chartIndicators`, so the detector fires on the same EMA20 the chart draws; the guard is a null check (the series is null before warm-up), not Number.isNaN.** | `trade/setupScan.ts:295` vs `market/playbooksCore.ts:208` |
| **D5** | **Session VWAP** | **Rolling 24×1h vs UTC day.** `buildDecisionSnapshot` calls a 24-bar rolling VWAP "sessionVwap"; the prompt restarts at the UTC day; `regime.sessionVwap` uses the chart's day candles. Three windows, one name. | `marketTools.ts:1629` vs `TechnicalAnalysisService.ts:1520-1526` vs `trade/regime.ts:72-83` |
| **D6** | **CVD** | **Candle-position estimate vs taker-buy measurement.** `orderFlowCore.ts:9-11` explicitly calls the estimate "exactly what this replaces for the desk tools". | `TechnicalAnalysisService.ts:826-828` vs `market/orderFlowCore.ts:18-19` vs `utils/smcStructure.ts:613` |
| **D7** | **Volume profile** | **50 buckets with even split vs 48 bins with overlap weighting.** Different POC/VAH/VAL for the same candles; `volumeProfileCore.ts:11-13` documents the split as deliberate. | `TechnicalAnalysisService.ts:860,873-877` vs `market/volumeProfileCore.ts:62,89-92` |
| **D8** | **Pivot points** | **Previous bar vs previous UTC day.** | `taLibrary.ts:824` vs `TechnicalAnalysisService.ts:1281-1283` |
| **D9** | **Swing definition** | **1-bar vs 2-bar vs 5-bar** fractal, feeding three different reads. | `NumericChartService.ts:511` vs `market/swingStructureCore.ts:49-55` vs `taLibrary.ts:867` |

**Consistent (verified, no disagreement):** MACD (both call sites 12/26/9), ADX (both Wilder),
Bollinger core (all SMA20 + population SD), SMA (all five implementations plain SMA, same warm-up).

**Dead code:** `regimeCore.meanCandleRange:226`, `setupScan.scanHistorySetups:371` (and its helper
`atrAt:381`), `screener.runScreener:150`.

---

## 4. Python parity (`C:\Dev\Agentic-Trading`)

`vlm/data/indicators.py` is the single source. `compute_all_indicators` (`:238-253`) computes exactly:
`ema_20`, `ema_50`, `ema_200`, `rsi_14`, `atr_14`, `adx_14`, `volume_sma_20`, `volume_ratio`.
There is **no TSI and no MACD** anywhere in the pipeline (chart-only, default off).

| Indicator | Python convention | Evidence |
|---|---|---|
| EMA(20/50/200) | Plain EMA `alpha=2/(n+1)`, **first-close seed** | `indicators.py:47` |
| RSI(14) | Wilder `alpha=1/14`, but **seed is the first gain/loss, not an SMA of the first 14** | `indicators.py:63-65` |
| ATR(14) | Wilder `alpha=1/14`, same first-value seed nuance | `indicators.py:100` |
| ADX(14) | Wilder chain, first valid ≈ bar 28 | `indicators.py:129-138` |
| Bollinger(20,2) | Not in the prompt; internal to mean-reversion, pandas `std` (ddof=1) | `pattern_detector.py:371-374` |
| VWAP | Session-to-date, only under `rich_context` (default **off**) | `indicators.py:866-888` |

**What reaches the prompt:** `format_legend` (`indicators.py:466-532`) prints **the last value only**,
one line per timeframe — `C`, `EMA(20)`, `EMA(200)`, `RSI(14)`, `ATR(14)`, `ADX(14)`, `VOL_RATIO`,
`trend`, `S/R`. No per-candle indicator series. Per-candle data is OHLCV, 3 candles per TF, with
microstructure appended for the entry TF only (`prompt_builder.py:196-234`).

**Lookahead:** indicators at T are causal (`indicators.py:317-319` filters swings to `index+5 <= idx`).
The **label** and **sample survival** read >T (hindsight teacher filter, `pipeline.py:762-805`) — that is
label construction, not prompt data. Splits are chronological with de Prado purging.

**Parity risks:** RSI/ATR use Wilder alpha but a first-observation seed rather than the classic SMA
seed; the TS chart's `sma()` is not an EMA at all; the default prompt carries no MACD, TSI, Bollinger
or VWAP.

---

## 5. Gap table — OKX feature vs August

| OKX feature | Status | Gap |
|---|---|---|
| Candles (configurable palette) | **Partial** | Colours hardcoded `chartData.ts:27-28`; OKX uses magenta down |
| Volume histogram | **Present** | — |
| EMA(20) / EMA(200) | **Missing** | No EMA series on the chart |
| Bollinger + fill | **Missing** | No band series; no shaded fill |
| AVL | **Missing** | Undefined on OKX without ambiguity — **skip unless defined** |
| TSI(25,13,13) + signal | **Missing** | No sub-pane |
| RSI(6/14/24) | **Missing** | Computed for the model, never drawn |
| MACD(12,26,9) | **Missing** | Computed for the model, never drawn |
| OHLC legend | **Missing** | Largest single gap |
| Per-indicator legend rows | **Missing** | — |
| Price source selector | **Missing** | `priceLineSource` hardcoded |
| Chart types | **Missing** | — |
| 1s timeframe | **Missing** | Not in `CHART_INTERVALS` |
| Price tag + countdown | **Missing** | — |
| High/low visible-range markers | **Missing** | — |
| Crosshair price label + % | **Missing** | — |
| Event/news markers | **Missing** | No news feed |
| Favorites strip | **Missing** | — |
| Per-user indicator settings | **Missing** | Nothing persisted |
| VWAP / anchored VWAP (Phase 3) | **Partial** | Computed for the model (`TechnicalAnalysisService.ts:1500`, `vwapCore.ts:30`), never drawn; three anchoring conventions |
| Volume profile POC/VAH/VAL (Phase 3) | **Partial** | Two disagreeing implementations (D7) |
| Session levels (Phase 3) | **Partial** | Computed (`market/levelsCore.ts:95`), never drawn |
| Swing structure / BOS / CHoCH (Phase 3) | **Partial** | Three definitions (D9); `CandlePatternDetector.ts` exists |
| Taker volume / delta / CVD (Phase 3) | **Partial** | Estimate vs measurement (D6) |
| Funding / OI / long-short ratio (Phase 3) | **Missing** | No derivatives pane |
| Order book depth / liquidation heatmaps | **Out of scope** | Per the spec — live-only, no model input |

---

## 6. What this means for the work

1. **The chart is not a thinner OKX — it is a different product.** It draws one dead SMA and a volume
   histogram. Every indicator the model reasons over is invisible to the trader, and the trader's
   chart is invisible to the model's numbers. The spec's headline requirement ("the model sees the
   same numbers the chart shows") cannot be met by adding overlays: there is no shared series.
2. **Nine disagreements are live today**, and they are not cosmetic — D1 (ATR) and D4 ("EMA20" is
   SMA20) change setup detection and stop distances. Fixing parity is a prerequisite to drawing
   anything, or the chart will faithfully reproduce a number the model was never given.
3. **The Python pipeline is a third implementation**, and its RSI/ATR seed differs from the classic
   SMA seed the TS library uses. Parity tests must pin the seed, not just the alpha.
4. **One indicator module is the fix.** `taLibrary.ts` already owns ~40 studies and is imported only
   by `DeskToolsService`; `TechnicalAnalysisService.ts` owns the prompt set; `TradingChart.tsx` owns
   one SMA. A single `chartIndicators` module consumed by chart, prompt and pipeline is the
   architecture the spec asks for.

---

## Appendix — full inventory

| Indicator | file:line | Params | Smoothing / seed | Warm-up | Consumers |
|---|---|---|---|---|---|
| SMA (chart) | `TradingChart.tsx:224` | 20 | plain | null until 19 | chart (dead) |
| SMA (canonical) | `TechnicalAnalysisService.ts:399-405` | 5,10,20,30,50,60,200 | library | n−p+1 | prompt, dash |
| SMA (taLibrary) | `taLibrary.ts:55` | — | plain | NaN until p−1 | prompt |
| SMA (setupScan) | `setupScan.ts:78` | — | plain | NaN until p−1 | scanner, prompt |
| SMA20 (baseline) | `signals/baselineLane.ts:39` | 20 | plain | NaN until 19 | dash |
| EMA (taLibrary) | `taLibrary.ts:66` | — | **first-value seed**, k=2/(p+1) | none | prompt |
| EMA (playbooks) | `market/playbooksCore.ts:66` | 20 | **SMA seed** | n−p+1 | prompt |
| EMA (regime) | `trade/regime.ts:23` | — | SMA seed | null if n<p | chart (bias chips) |
| EMA (screener) | `trade/screener.ts:58` | — | SMA seed | NaN if n<p | scanner, prompt |
| EMA (projection) | `trade/priceProjection.ts:67` | — | first-value seed | none | prompt |
| EMA (canonical) | `TechnicalAnalysisService.ts:390-396` | 5,9,13,20,21,50,200 | library, SMA seed | n−p+1 | prompt, dash |
| RSI (setupScan) | `setupScan.ts:56` | 14 | Wilder, SMA seed | NaN until p | scanner, prompt |
| RSI (regime) | `trade/regime.ts:34` | 14 | Wilder, SMA seed | null if n<p+1 | chart (bias chips) |
| RSI (taLibrary) | `taLibrary.ts:408` | — | Wilder (first step not) | NaN until p+1 | prompt |
| RSI (canonical) | `TechnicalAnalysisService.ts:363-371` | 6,12,14,24 | library Wilder | n−p | prompt, chart (LiveMarket) |
| RSI (snapshot) | `marketSnapshot.ts:71` | — | library Wilder | null if n<p+1 | chart, prompt |
| MACD | `TechnicalAnalysisService.ts:375-382`, `:1797-1804` | 12,26,9 | library EMA | from slowPeriod | prompt, chart (LiveMarket) |
| Stochastic | `TechnicalAnalysisService.ts:420-432` | 14,3,3 | library | from period | prompt, chart |
| ADX | `TechnicalAnalysisService.ts:1109` | 14 | Wilder | ≈28 bars | prompt |
| ADX | `market/regimeCore.ts:58` | 14 | Wilder | [] if n<2p+1 | prompt |
| ATR (regimeCore) | `market/regimeCore.ts:40` | 14 | Wilder | first value at bar p | prompt, dash |
| ATR (canonical) | `TechnicalAnalysisService.ts:442-448` | 14 | library Wilder | n−p | prompt |
| ATR (projection) | `trade/priceProjection.ts:48` | 14 | Wilder | scalar | prompt |
| ATR (smc) | `utils/smcStructure.ts:26` | 14 | **simple avg TR** | 0 if n<p+2 | prompt (all desk tools) |
| ATR (numeric) | `NumericChartService.ts:475` | 14 | **SMA of high−low** | none | prompt |
| ATR (setupScan) | `setupScan.ts:381-386` | 14 | SMA of range | none | **dead** |
| Bollinger (setupScan) | `setupScan.ts:87` | 20,2 | SMA + population SD | NaN until p−1 | scanner, prompt |
| Bollinger (canonical) | `TechnicalAnalysisService.ts:408-412` | 20,2 | library, population SD | n−p+1 | prompt, chart |
| BB width | `market/regimeCore.ts:126` | 20 | SMA + population SD | bar p−1 | prompt |
| VWAP (canonical) | `TechnicalAnalysisService.ts:1500` | window | typical price, UTC day | none | prompt |
| VWAP (core) | `market/vwapCore.ts:30` | caller slice | typical price | null if empty | prompt |
| VWAP (session) | `trade/regime.ts:72` | day candles | typical price | null if empty | chart (bias chips) |
| VWAP (decision) | `marketTools.ts:1629` | last 24×1h | rolling, not UTC day | none | dash |
| CVD (canonical) | `TechnicalAnalysisService.ts:818` | all | **candle-position estimate** | none | prompt |
| CVD (order flow) | `market/orderFlowCore.ts:17-50` | all | **taker-buy measured** | null if field missing | prompt |
| CVD (smc) | `utils/smcStructure.ts:607` | completed | taker-buy measured | null if <10 bars | prompt |
| Volume profile (canonical) | `TechnicalAnalysisService.ts:838` | 50 buckets, VA 70% | **even split** | null if empty | prompt |
| Volume profile (tool) | `market/volumeProfileCore.ts:57` | 48 bins, VA 70% | **overlap-weighted** | null if <5 | prompt |
| Pivots (canonical) | `TechnicalAnalysisService.ts:1255` | prev UTC day | floor pivots | needs day boundary | prompt |
| Pivots (taLibrary) | `taLibrary.ts:823` | **previous bar** | floor pivots | 2 bars | prompt |
| Swings (numeric) | `NumericChartService.ts:507-517` | 1-bar | strict fractal | 1 bar | prompt |
| Swings (smc) | `utils/smcStructure.ts:64-78` | 2-bar | fractal | 2 bars | prompt |
| Swings (core) | `market/swingStructureCore.ts:47` | k=2 | strict fractal | 2 bars | prompt |
| Swings (Williams) | `taLibrary.ts:866` | 5-bar | fractal | 5 bars | prompt |
| ZigZag | `taLibrary.ts:840` | 5% | percentage reversal | 3 bars | prompt |
| Session levels | `market/levelsCore.ts:95` | session windows | period high/low | — | prompt |

## 2026-11-11 migration update

Migrated onto `services/trade/chartIndicators.ts`:

- `services/trade/setupScan.ts` — `rsiSeries`, `smaSeries` and `bollinger` are now
  NaN-aligned wrappers over `rsiSeries`/`smaSeries`/`bollingerSeries`; the local
  math is gone.
- `services/trade/regime.ts` — `ema` and `rsi` are wrappers over `emaSeries`/
  `rsiSeries`; the local math is gone.
- `utils/smcStructure.ts` — `atr14` is `atrSeries` (Wilder), migrated 2026-11-10.

Still local, each a deliberate parity mirror to migrate one at a time (each
migration changes numbers, so each needs its own parity contract):

- `services/analysis/TechnicalAnalysisService.ts` — prompt/dash indicator set
  (library semantics: SMA-seeded EMA, library RSI, different pivot/CVD).
- `services/analysis/taLibrary.ts` — ~40 studies; imported only by
  `DeskToolsService`.
- `utils/playbooksCore.ts` — scanner EMA (SMA seed).
- `services/analysis/agentTools.ts`, `strategyBacktest.ts`,
  `patternBacktest.ts` — agent/backtest helpers.

The scanner's EMA20 (D4) and the desk ATR (D1) are fixed; the rows above are
the remaining inventory.
