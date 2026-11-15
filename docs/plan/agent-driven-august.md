# Redesign: agent-driven August (plan for approval)

## Context

August already has the hard part built: ~75 desk tools, `present_trade` proposal cards with gate
stamps, level watches, autonomous memory/skill/goal writes, harness-run reviews. What it does not
have is an agent-first face: **35 surfaces/overlays with ~370 manual controls** (audit below), two
competing chat homes, and controls that re-implement tools the model already has (17-button drawing
rail vs `draw_on_chart`; manual trade logging vs a proposal card; AI-behavior toggles vs
`propose_self_change`).

Target: **one chat + chart workspace. The agent drives; the trader plans, verifies, chats.** Your
brief's five principles are mostly codified already ("the agent proposes, deterministic code checks,
the trader decides" — `docs/product/goal.md` › `goal`); the redesign is mostly **removal + one merge
+ a decision-card contract**, shipped in phases so the app never breaks.

Decisions taken from your answers: Approve = **log + monitor** and **paper execution (simulated
fills, no exchange keys) ships as a later phase** — this is the owner ruling AGENTS.md requires;
goal.md/charter get updated when it lands. Dashboards (win rate, equity, stats) leave the chrome; the
agent renders them on demand. Fresh visual direction (mock v3 set aside), keeping the v4
palette/radii already in `src/index.css`. Two defaults chosen without your answer — **layout: chart +
chat always side by side**, **rooms/bots: composer mode menu** — are marked adjustable in Open
questions.

## Audit (keep / merge / remove)

| Area | Item | Verdict | Why |
|---|---|---|---|
| Shell | Rail Analyze/Agents/Settings | **MERGE** | Two chat homes = two answers to one concern (charter). One workspace + gear remains. |
| Shell | Sidebar history (ConversationGroups) | KEEP | New chat / Pinned / Recent / account, per reference pattern. |
| Shell | Header popover rows (Live Market, Vision data) | REMOVE | Market tools + chart cover it; vision data flows through chat. |
| Shell | `GoalRailPanel` (orphaned, imported by nothing) | DELETE | Dead code. |
| Chart | Canvas, pan/zoom, `LevelAccuracyBadge` | KEEP | Direct manipulation isn't "operating the agent's job"; honesty badge stays. |
| Chart | ChartToolRail (17 buttons) | REMOVE | `draw_on_chart`/`mark_trade_levels`/`clear_chart_drawings` already exist. |
| Chart | TimeframeBar + customize gear | REMOVE | New `set_chart_timeframe` tool replaces it; TF shown as a chip. |
| Chart | Studies/indicator menu | REMOVE | New `toggle_chart_study` tool; active studies shown passively. |
| Chart | OrderBookPanel | KEEP | 0 controls; closed-by-default drawer (ambient data the agent also reads). |
| Chat | Dock + AgentsView as two homes | **MERGE** | One transcript, one composer; chart always in the workspace. |
| Chat | GroupChatView rooms, NewBot/NewGroup | KEEP | Reachable from composer mode menu (your brief: reuse debate chat). |
| Chat | `AskUserInputCard` | KEEP | Already the agent→user question channel (matches every reference harness). |
| Chat | ToolActivityRow / ChatWorkTimeline / ReasoningRow | KEEP + tighten | One compact "worked Ns · M tools" line, expandable — the whole-turn folding deepseek-harness uses. |
| Chat | TradeProposalCard | **UPGRADE** | Becomes the decision card: Approve / Reject / Ask why (below). |
| Chat | "Log this trade" / "Log plan" buttons | REPLACE | Logging happens through Approve; model-owned path with a receipt. |
| Chat | Pin/Retry/Edit/VersionStepper/Revert chips | KEEP | Working; conversation keeps every turn. |
| Chat | `messageFeedback.ts` (unwired) | WIRE | Thumbs feed the learning loop — the accuracy line. |
| Chat | `WorkspaceHome.tsx` (unwired) | WIRE | Becomes the new-chat home screen. |
| Chat | `conversationPins.ts` (unwired) | DROP | Superseded by the live `agent_pins` store behind the shipped Pinned group. |
| Desk | ScreenerPanel modal | REMOVE | `run_screener`/`find_best_setups` render results as chat cards. |
| Desk | WatchListPanel manual Win/Loss | REMOVE | Agent settles via the signal ledger; a confirm card replaces "Confirm autopilot". |
| Desk | LiveMarket, StrategySearch overlays | REMOVE | Market tools + `scan_playbooks` cover both. |
| Journal | Manual outcome/PnL/leverage editing, deletes | REMOVE | Agent correction via gated tool + confirm card; settlement autopilot already exists. |
| Journal | Trade History list | KEEP | Read-only records view. |
| Settings | AI setup/providers, Profile, Data/Backup | KEEP | Configuration is the trader's domain. |
| Settings | AI-behavior toggles (hybrid, desk tools, effort, self-mod, A/B, settlement mode) | MERGE | Agent proposes via the existing self-change ledger (24h revert + audit). |
| Settings | Risk dials (equity, risk %, min edge, leverage, daily loss) | KEEP | The Plan source of truth; agent-editable through a verify card. |
| Settings | Prompt/Instructions editors | READ-ONLY | Agent writes under the shadow lane; the trader reads. |
| Settings | Memory + AmendmentsInbox, Skills library, StrategyPlans & ToolForge gates, Playbooks upload | KEEP | These are approval/undo mechanisms, not duplication. |
| Dashboards | WinRate, EquityCurve, Journal Stats | REMOVE | Agent-rendered on demand (your call); measurement lives in the signal feed (focus.md). |
| Dashboards | LearningDashboard, VersionHistoryDashboard | KEEP | Learning health is the loop's own surface. |

### Removal parity

Every REMOVE row names the agent path that replaces it, and the phase that proves the replacement
before Phase 4 deletes anything. **A REMOVE row whose P-row is unproven stays in the app.**

| ID | Removed control | Agent replacement | Proven in |
|---|---|---|---|
| P-1 | Header popover rows (Live Market, Vision data) | `get_market_packet`, `get_price_snapshot`, `get_key_levels`, `get_order_book` for market state; vision output already renders in the transcript through `read_message` | Phase 3 walkthrough |
| P-2 | ChartToolRail (17 buttons) | `draw_on_chart`, `draw_tool_levels`, `mark_trade_levels`, `clear_chart_drawings` | Phase 3, button-by-button table |
| P-3 | ScreenerPanel modal | `run_screener`, `find_best_setups` as chat cards | Phase 3, row-for-row parity |
| P-4 | LiveMarket, StrategySearch overlays | market tools above + `scan_playbooks` | Phase 3 walkthrough |
| P-5 | WinRate, EquityCurve, Journal Stats dashboards | `get_setup_history_stats` (win rate with Wilson 95%), `playbook_attribution` (per detector), `get_trade_log` (rows carry PnL and timestamp, so an equity curve is derivable) | Phase 3, moved up from Phase 5 |
| P-6 | Journal manual outcome/PnL/leverage edits **and deletes** | settlement-correction card: propose → confirm → gated write. A correction and a void are separate explicit actions, and neither applies without the tap | Phase 3 |

## Design

**Layout (default, adjustable).** One workspace: chart pane left, chat pane right, both always
visible at desktop width; below 1024px a Chat/Chart switcher (the existing one-pane pattern,
simplified to two). Sidebar: New chat, Pinned, Recent, account. Settings stays the
Claude-Desktop-style modal with the four record sections. Empty state = `WorkspaceHome` (New chat,
restore, recent workspaces).

**The loop** maps onto existing machinery:

- **Plan** — trader states goals/risk in chat; agent writes them into goals + notebook and renders a
  **Plan card** (goals, risk limits, thesis) → verified once. `create_goal`, `write_memory_note`, risk
  dials all exist.
- **Propose** — `present_trade` (unchanged): zod-parsed plan, planId, gate scan, drawings, watch
  armed, confidence/R:R/invalidation on the card. "No trade" stays a first-class output
  (`decline_trade` receipts, refusal ledger).
- **Verify** — the card grows three actions: **Approve** (logs via the existing human path
  `logTradeWithFeedback`, arms the watch, enqueues an approval-receipt harness turn so the model
  learns the outcome in-conversation), **Reject** (records a decline with optional reason), **Ask why**
  (pre-fills a pushback prompt). One tap, no modal. Rule/risk changes and strategy activation reuse
  the same card shape.
- **Monitor** — `levelWatchService`/`watchService` fire without a model in the loop; hits wake a
  harness turn that reports and proposes management (level changes go through a new gated
  `update_trade` card; `close_trade` likewise).
- **Review** — settlement autopilot → `settlementReflection` post-mortem → weekly/monthly heartbeat
  reviews arrive as chat turns with proposed rules; new `run_review` tool lets the trader request one
  on demand.

**Autonomy matrix.** Agent-alone (no tap): all market reads, drawings, symbol/timeframe/studies,
notebook/memory/skill/goal writes, declines, signals, watches, screener scans, review runs (principle
5 is already true in code). One-tap verify: log/close a trade, change levels on an armed plan,
risk-limit/guard-preset changes, activate strategy/skill, forged-tool first use, self-mod changes
(existing revert ladder). Never: real order placement or exchange keys (unchanged non-goal); paper
fills always labeled simulated.

**Agent activity without clutter.** Working = one quiet line ("Analyzed 12s · 5 tools · nothing
executed") expanding to the tool-call tree; thinking stays a collapsible row; failed turns are
transcript rows, never toasts (voice.md). Chart shows what the agent did, not chrome: levels,
drawings, symbol chip.

**Reference takeaways (only what fits a trading workflow):** Claude Code — plan-then-approve before
side effects, compact expandable tool rows (both already exist here); Claude Desktop — config in a
modal, chat-first with a work panel ([support.anthropic.com](https://support.anthropic.com),
[bloom.security/blog/claude-artifacts](https://bloom.security/blog/claude-artifacts)); ChatGPT agent
mode — narrated actions, pause/take-control, confirm-before-consequential
([help.openai.com](https://help.openai.com)); deepseek-harness (local docs/research corpus, recovered
at `fdb6b81d~1`) — whole-turn folding and "never lie to the reader about what happened"; hermes-agent
— approval flow and skill lifecycle already adopted here. Rejected: full-autonomy browsing patterns;
trading keeps deterministic gates.

## Phases (each ships and gates independently)

1. **Agent hands** — three steps, each gated on the one before it.
   - **1a — definitions only.** The five tools defined in
     `AGENT_HAND_TOOL_DEFINITIONS`, contract-tested, in none of the three registries.
   - **1b-i — the chart writes.** `set_chart_timeframe` and `toggle_chart_study` move into
     `CHART_ACTION_TOOL_DEFS`, with executor branches and the settings subscription the chart
     needs to hear an external write. Both are reversible visibility/frame changes: no record,
     no risk, no card required.
   - **1b-ii — the trade writes.** `update_trade` and `close_trade` are registered only with the
     Phase 3 decision card. A proposal with no card to confirm it is a dead affordance, and a tool
     that applied its change on the call would be the authority bug the 1a/1b split exists to
     prevent. They stay defined and unreachable until the card ships.
   - **1b-iii — `run_review`.** Waits on the review services' entry points and the harness turn
     that carries their findings, not on the card.
2. **One workspace** (the visible cut): merge dock + AgentsView; rail becomes New chat/Pinned/Recent/
   account + gear; composer mode menu (single/panel/room/bot); chart pane permanent.
   `src/App.tsx` surface switch extracted first (it is ~2,717 lines — O-105). render-probe re-anchored
   (lazy-chunk + pane-scoping lessons from the 11-14 pass).
3. **Decision cards**: proposal card upgrade + approval receipts; risk/goal changes as cards;
   WatchList/DataCapture replacement flows live alongside old controls. Deliverables:
   - **Settlement-correction card**: the agent proposes a corrected outcome/PnL, the trader confirms
     in one tap, and it writes through the existing gated path. A correction and a void (delete) are
     separate explicit actions on the card. This is the replacement for P-6 — the journal's manual
     outcome/PnL/leverage editors and deletes, and the watchlist's manual Win/Loss — and Phase 4 does
     not remove either until this card is verified. The producer is a
     `correct_trade_outcome` tool that only RECORDS a proposal; the confirmation
     half (store, card, and the write through the journal's own
     `handleUpdateTradeOutcome`/`handleUpdateTradePnL`) is in place, and the tool
     is registered with its sink on the chat surface
     (`chatSurfaceTurn` › `req.patch`), which is the store `AgentsView` reads.
     Still open: the DOCK path. `chatTurnRunner` writes its rows to `chatStore`
     entries and renders them through `ChatTranscriptList`, which does not draw a
     correction card yet — so a correction proposed from the dock records and
     replies honestly, but shows no card there until that sink exists.
   - **Risk-limit and goal-change cards**, sharing the decision-card shape.
   - **Removal-parity proofs (P-1…P-6)**: each REMOVE row gets the check named in the parity table
     above — the replacement is reachable, and it produces what the control produced. Phase 4 deletes
     nothing whose P-row is unproven.
   - **Agent-rendered stats** (P-5): win rate, equity curve and journal stats rendered from
     `get_setup_history_stats`, `playbook_attribution` and `get_trade_log`. Moved up from Phase 5 so
     the dashboard removal has a verified replacement before it.
4. **Removals**: everything the audit marks REMOVE goes, only after phases 1–3 verified (your
   constraint), and only after its P-row is verified in Phase 3. The journal's manual editors and the
   watchlist's manual Win/Loss go last in that order, behind the settlement-correction card. Settings
   diet (AI-behavior toggles → agent-proposed; prompt editors read-only); dashboards removed.
5. **Plan & review loop**: Plan card verified once; `risk_state` surfaced in chat; reviews arrive as
   chat turns, with proposed rules attached.
6. **Paper execution lane** (your ruling): simulated fills over live prices reusing
   `positionTracker`/`journalTracking`/`journalOutcomeBridge` and the existing fill-realism measures —
   no new store, no exchange keys. Positions reported by the agent in chat + chart markers, always
   labeled simulated. goal.md/charter updated in the same commit.

### Phase 1a / 1b controls

- **1a test — no early registration.** A test asserts the five tools are absent from the chat tool
  registry, so nothing can register them early by accident.
- **1b gate — confirmation is not weakened.** `update_trade` and `close_trade` stay behind their
  existing confirmation and gating path. Registering them must not weaken it; a test pins that the
  gated path is still the one taken.

## Risks

- **App.tsx sprawl**: the merge is the riskiest diff; extracting the surface switch first bounds it.
- **Probe churn**: surface merges move testids; budget for render-probe re-anchoring (memory: lazy
  chunks mount late, scope sweeps to the open pane).
- **Latency/cost**: monitoring must stay harness-side (watches fire with no model); keep the
  `load_tools` schema-on-demand pattern (tool-schema tax is already ~7.9k tokens — O-59).
- **Honesty**: paper fills and every card carry provenance and refusal paths; profit is never
  guaranteed; "nothing executed on any exchange" replaces "nothing executed" once paper fills exist.
- **Removal regret**: order of phases guarantees a verified replacement before any removal; everything
  is one revert away.
- **Untracked owner files**: I will not stage or commit anything without showing you the exact paths
  first.

## Verification

Per phase: `npm run typecheck`, `lint` (ratchet never raised), `build`, `check:contracts`,
`check:boundaries`, `check:docs`, `boot-probe`, `render-probe` (re-anchored when surfaces move; it is
the only gate that sees a rendered row), manual walkthrough at 1440 and 800 (charter),
`installer-smoke` before any release-tagged phase.

Phase-specific:

- **1a**: the registry test passes — the five tools are defined, contract-tested, and absent from the
  chat tool loop. Runtime behaviour is unchanged; the existing probes must be byte-identical.
- **1b**: the five tools are registered and callable; the receipt round-trip returns a decision
  receipt; and the confirmation-path test proves `update_trade`/`close_trade` still route through the
  existing gate rather than around it.
- **3**: the settlement-correction card is walked end to end — propose a correction, confirm it with
  one tap, check that the record updates through the gated path, and check that nothing changes
  without the confirmation; then the same for a void. Each P-row (P-1…P-6) is proven by its own
  check: the replacement is reachable and produces what the removed control produced.
- **4**: no REMOVE item is deleted until its P-row is verified in Phase 3; the journal editors and
  manual Win/Loss are last in that order.

The four honesty receipts in `tests/tradeChatPanelHarness.test.tsx` gain decision-card cases; paper-fill
logic gets pinned contract sections in `scripts/check-contracts.cjs`.

## Open questions (defaults chosen, adjustable now)

1. **Layout**: chart + chat always side by side. Alternatives: chat-led with chart summoned on demand,
   or chart-led with a collapsible dock.
2. **Rooms/bots**: composer mode menu. Alternatives: demote to Settings, or remove entirely.
3. **Execution**: Approve = log + monitor, paper lane in phase 6. If you meant log + monitor only,
   phase 6 drops and the plan is otherwise unchanged.
4. WorkspaceHome wired / conversationPins dropped / messageFeedback wired — object here if you'd rather
   drop all three.