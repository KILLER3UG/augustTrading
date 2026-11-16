# Removal-parity proofs (P-1…P-6) — evidence

Phase 4 deletes nothing until its P-row is verified. P-6 (the settlement-correction
card vs the journal's manual editors and the watchlist's manual Win/Loss) is proven:
`scripts/dock-card-probe.cjs` walks propose → confirm → void on the dock, and the plan
doc records the review that closed its findings. The proofs below are walked by
`scripts/parity-proof-probe.cjs` (a scripted-mock walk over the REAL executor, asserting
on the receipts the model actually received) plus the evidence tables here.

**What a probe can and cannot prove.** The probes prove the agent path is REACHABLE,
accepts its parameters, and returns the payload shape the control produced. They cannot
prove that a live model picks the right tool unprompted — that needs a configured
provider and is reported as unverifiable at STOP 1. The disambiguation surface the
model reads is the tool descriptions plus the catalogue routing hints
(`DeskToolsService` › `ROUTING_HINTS`), contract-pinned.

## P-1 — Header popover rows (Live Market, Vision data) vs the market tools

Old control: the header session popover's "Live Market" row (opens the LiveMarket
overlay) and "Vision data" row. Replacement: `get_market_packet` (one call: price,
session context, derivatives), `get_price_snapshot`, `get_order_book`, `get_liquidations`;
vision output already renders in the transcript through `read_message`.

Probe: `p1-packet` (packet covers price + session/derivatives fields in one call) and
`p1-key-levels` (the publishable `key-levels` fence with support/resistance). The
popover's per-row content is a subset of the packet's envelope.

Capability the replacement cannot reach: the overlay's always-on ambient refresh (the
popover showed continuously; the tools are on-demand). The chat surface is the
replacement surface; the ambient row dies with the control.

## P-2 — ChartToolRail (17 buttons) vs the drawing tools

`draw_on_chart` (9 kinds), `draw_detected`, `draw_tool_levels`, `mark_trade_levels`,
`clear_chart_drawings`. Probe: `p2-*` walks seven `draw_on_chart` kinds, the
trade-level mark, and the model-scope clear, each asserted on its receipt.

| Rail button | Replacement | Gap? |
|---|---|---|
| Cursor (pan/zoom) | none — stays | No: direct manipulation of the view is the trader's own (the audit's KEEP row for the canvas). Not a drawing shape. |
| Trendline | `draw_on_chart` kind `trend` | No |
| Ray | `draw_on_chart` kind `ray` | No |
| Horizontal line | `draw_on_chart` kind `hline` (the level line the model names most) | No |
| Zone (rect) | `draw_on_chart` kind `zone` | No |
| Fib retracement | `draw_on_chart` kind `fib` | No |
| Text note | `draw_on_chart` kind `text` | No |
| Arrow | `draw_on_chart` kind `arrow` (rail: inside the "more tools" menu) | No |
| Channel | `draw_on_chart` kind `channel` (rail: inside the menu) | No |
| Measured move | `draw_on_chart` kind `measured_move` — prints the R:R itself | No — the tool adds what the rail cannot (labelled risk/reward/ratio) |
| Freehand (brush) | none | YES — a freehand scribble has no tool kind, and should not: it is a trader gesture, not analysis. Phase 4's removal is a trader-capability decision, flagged here honestly. |
| Eraser (per shape) | `clear_chart_drawings` (scope `model` or `all`) | Partial: the tool clears BY SCOPE, not per shape. The trader's own per-shape erase is direct manipulation on their own drawings. |
| Magnet (snap to OHLC) | none | Stays with the trader's own drawing controls |
| Hide/show drawings | none | View visibility for the trader's own shapes |
| Undo last drawing | none (trader's own undo) | Stays |
| Clear all drawings | `clear_chart_drawings` (agent scope) + the rail's own clear (user scope) | No for the agent half |
| Color palette | `draw_on_chart` `color` enum (5 named colors) | No for the agent half |
| Line width | none | Styling only; the agent's shapes carry their own defaults |

Verdict for Phase 4: the shape-creating buttons are fully agent-replaceable. The
trader-gesture controls (brush, per-shape erase, magnet, visibility, undo, width) serve
the trader's OWN drawings — direct manipulation the charter keeps. Phase 4's rail
removal must keep or re-home those controls with the canvas, or the removal is a
capability cut, not a parity replacement.

## P-3 — ScreenerPanel modal vs `run_screener` / `find_best_setups`

Probe: `p3-screener` (bounded table, ≤30 rows, UNKNOWN-not-empty on feed failure) and
`p3-best-setups` (ranked candidates with per-coin `why` reasons, ≤20). The modal's rows
render as chat receipts/cards in both surfaces by construction (one workspace).

## P-4 — LiveMarket / StrategySearch overlays vs market tools + `scan_playbooks`

Probe: `p4-playbooks` (matches carry invalidation + evidence). The market half of P-4
is the same packet walk as P-1. StrategySearch's library browsing stays as the Settings
strategy library (a KEEP row); the overlay's scan action is `scan_playbooks`.

## P-5 — Dashboards vs agent-rendered stats

`get_setup_history_stats` (Wilson 95% + sample size — probe `p5-stats`),
`playbook_attribution` (per-detector rows — `p5-attribution`), `get_trade_log` records
(PnL + timestamps, so an equity curve is derivable — `p5-log`). The card renders the
numbers FROM the verified tool output; the model never writes them in prose. The
one-tap way to open the stats stays (the dashboards' KEEP rows: LearningDashboard,
VersionHistory).

## P-6 — Journal manual outcome/PnL edits + deletes vs the settlement-correction card

Proven. `scripts/dock-card-probe.cjs`: the card renders from the dock, the row is
untouched while open, one tap writes the corrected outcome with the audit trail, the
VOID tap deletes through the journal's own gated path, and a dismissed proposal changes
nothing. Independently reviewed (findings fixed in `31caa3b5`).
