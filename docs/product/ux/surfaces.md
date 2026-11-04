# The four surfaces

August has four top-level surfaces and one overlay (Settings). Their **ids are load-bearing** —
`trade`, `journal`, `agents`, `learn` — because stored routes and dozens of gates pin them. Their
**labels are what the trader reads**, and a label names the function, never a capability the app
lacks.

| Surface | id | Shortcut | It is for | It is not |
|---|---|---|---|---|
| **Analyze** | `trade` | Alt+1 | reading one instrument and running the desk on it | an execution terminal — it never places an order |
| **Journal** | `journal` | Alt+2 | the record of what was decided, plus the review over it | a library of old analyses |
| **Agents** | `agents` | Alt+4 | the named bot roster, DMs, rooms, and the same thread as the chart dock | one generic assistant |
| **Learning** | `learn` | Alt+5 | what the app learned and how it decided to believe it | a library you browse |
| Settings | — | overlay | configuration and data | a surface; it mounts over whatever is current |

Alt+3 is not a surface: it is the Customize row, which opens **Learning → Skills**. The chord and
its icon kept their meaning; only the destination changed.

## Analyze (`trade`)

Anatomy, top to bottom:

- **Chart head** — one quiet line: `SymbolPicker`, hero price (`text-ui-price` mono tabular-nums), change, funding + countdown, feed dot. No metrics band and no tool buttons: the **market screener** and **pinned signals** live in the symbol picker's foot, where a trader already goes to change instruments. `src/components/trade/TradeView.tsx` › `TradeView`
- **Crosshair readout** — the 24h high/low/volume/OI/oracle fields the band held appear ONLY while the pointer is over the plot, then leave with it. `src/components/trade/TradingChart.tsx` › `TradingChart`
- **Composer** — the box is `+` / model / send. The two prompt actions ride the `+` menu ("Study the chart → skills", "Full analysis") instead of chips on the row.
- **Activity** — the skill-audit drawer's door is the account row's inbox control at the column's foot; the content bar no longer carries a status cluster. A FAILED profile save still shows ("Save failed") because a silent save error is data loss.
- **Order-book drawer** — 30px strip (name, live state, spread) closed by default, expands on demand. Analyze-only. Narrow (<1024) Book mode = full-height pane. `src/components/trade/TradeView.tsx` › `TradeView`
- **Chart AI dock** — `useRightPanel` default 364px (min 300 / max 820), resize + collapse rail. Dock body order: BiasChips line, SignalCard, KeyLevels Disclosure, DeskScorecard, user bubble (max 80%), AnalyzedRow, AnswerBody (font-reading), MemoryProvenanceStrip, VerdictAudit gate behind "Inspect evidence & gate" Disclosure, prov line (code-calculated only). `src/components/trade/panels/ChatTranscriptList.tsx` › `ChatTranscriptList`
- **Narrow <1024** — three-mode switcher **Chart | AI | Book**, one pane at a time.

Live state: one websocket bundle per symbol drives strip + book + candles; REST polling takes over
the moment the socket drops, and the chart's own stall watchdog re-syncs a quiet stream. Prices are
realtime or visibly healing — never silently stale.

Never: executes an order, touches an exchange account, or holds a trading key.

## Journal (`journal`)

- **History** — the trade ledger: every logged trade, its plan, its outcome.
- **Stats** — win-rate and equity-curve dashboards over the same rows.
- **Review cards** — weekly and monthly reviews.
- **Export** — CSV and the printable trade report (open it and print to PDF).

The ledger is the denominator for everything the learning loop believes. A trade that was never
logged did not happen as far as the app is concerned.

## Agents (`agents`)

Three regions: a sparse rail, a main pane, and one pill composer. The rail's top is the
**Analyze ⇄ Agents mode switch** — a route between the charted and focused forms of the same desk,
not a per-turn mode. Journal, Learning and Customize sit at its foot.

- **Conversation list** — `ConversationGroups`, the SAME component `ShellRail` renders: New chat + Ctrl K, Pinned (only when there are pinned rows), Recent (always). Rows: hollow dot (filled active, amber pulsing running), truncated title, mono age (`workspaceAgeLabel`). No Goals/Agents/Rooms groups — chat-only. `src/components/shell/ConversationGroups.tsx` › `ConversationGroups`
- **Chat full view = AgentsView** — id stays `agents`, label is **Chat**. Greeting sparse. `ChatTranscriptRow` renders bubble/failure/AI with `BotFace` + `ChatWorkTimeline` + `AnswerBody` + `SignalCard` + KeyLevels + chatChips incl. `FeedbackChips`. Follow-up line renders ONLY if backed by a real computed suggestion; otherwise omitted. `src/components/shared/ChatTranscriptRow.tsx` › `ChatTranscriptRow`
- **SignalCard** — shared by dock + Chat. Headline Direction + COIN, meta (R:R, interval, conviction), 4-row kv (Entry=info cyan, Stop=trade-down, Target=trade-up, Prob. w/ bar+base tick ONLY if `SignalRecord` carries `probability`/`baseRate`/`sampleN` — else omitted), Trigger/Invalidation, evidence, actions (Show on chart/Log plan/Copy), mono sigmeta (signalId·age·expiresAt countdown·venue). `signalIdFromActions` reads `ToolAction.signalId` for `emit_signal`. Ledger via `readSignals`/`summariseSignals` only — never fabricate probability/confidence. `src/components/trade/SignalCard.tsx` › `SignalCard`
- **DeskScorecard** — Disclosure "Scorecard · X% vs Y% base (n=N[, thin])". `src/components/trade/SignalCard.tsx` › `DeskScorecard`
- **BiasChips** — 6px dots, one line, honest failure (nothing until data). Mounted in AgentsView too. `src/components/trade/BiasChips.tsx` › `BiasChips`
- **Composer** — box-only (no context/quick-action chips). Keeps `ChatAttachmentStrip`, `ModelFallbackBanner`, disclaimer verbatim "Analysis and journaling only — it never places or signs a trade." Textarea autosize 1-line. `src/components/trade/panels/ChatComposer.tsx` › `ChatComposer`

- A send routes on **what is selected**, not on a send-mode switch (there is none inside the
  composer): a selected bot answers through the bot turn path; nothing selected hands the text to
  the real pipeline, so desk tools and memory run exactly as they do from the chart dock.
- Rooms delegate to the group-round view rather than reimplementing it.
- **One thread across homes.** The Agents surface and the chart dock show the same conversation
  under the same id; a run keeps its activity line when the trader switches surfaces. Two stores,
  one thread — this is a contract, not an implementation detail.
- An agent's card opens in `DetailModal`.
- The product's one AI response is claimed by **identity** (`Message.botId`), never by
  provider+model.

## Learning (`learn`)

**Learning** lands on the notebook and **Skills** lands on the library. Both rows are in the rail,
so the landing tab is part of the route (`App.tsx` › `App` `selectSurface`, `openSkills`): while
Learning inherited the library default the two rows drew one screen, which the owner named twice.


Tabs in the loop's own order:

1. **Skills** — the library the desk learns from; moved here from Settings so the library and the
   notebook sit together. Skills earned from three independent tracked outcomes carry a
   **tentative · context only** mark: they inform a read, never veto or cap confidence, and
   auto-demote under 40% after five outcomes. The global switch is Settings → tentative skills.
   Drafts apply themselves through the deterministic gates (owner ruling, 2026-11-03) — there is
   no approval inbox between a gated draft and the library, and every skill file follows one
   format (the boot pass repairs legacy files).
2. **Memory** — the notebook browser, including per-topic detail docks.
3. **Health** — whether the notebook is sound: memory health, pressure, versions, diagnostics —
   including any skill file that still does not follow the one format.

Never: the playbook library. Playbook Studio is the one owner of that table and lives under
Settings → Playbooks. Never: an Approvals tab — its queues apply themselves, and the memory
corrections log (with its one Undo) lives in Settings → Memory.

## Settings (overlay)

Grouped, in this order:

- **Setup** — AI setup (providers, keys, models).
- **Analysis** — Analysis, Prompts, Instructions.
- **Learning** — Memory, Playbooks.
- **Account** — Profile, Journal, Data.

Data is where back up / export / import lives. It is the only surface that can destroy or restore
the trader's journal in bulk; treat it accordingly.

## The shell

- **One full-height rail, two columns** (mock v3): a 48px icon strip — Analyze, Agents, the
  conversation column's toggle, then Journal, Learning and the account — beside the conversation
  column: **New chat (Ctrl K)**, **Pinned**, **Recent**, and the account row
  (`name · Signed in · local-first`) at its foot. No Search row and no mode switch in the column:
  the rail owns the surfaces, the column owns the record, and the desk's search lives in the
  Agents column's own field.
- On the **Agents** surface the column is `AgentsView`'s own (conversations above the roster); its
  Chats | Bots tab strip is DELETED — one scroll of sections.
- The **content bar** is the title, the instrument context and one muted **Live** pill (its
  popover still carries sessions, market conditions, Live market and Vision data). No brand mark,
  no save tick, no Activity pill. `AgentsView`'s own bar IS that bar — no second header stacks
  above it.
- The rail is 240px by default and drags from its right edge (200–360px; the width persists and
  double-click restores 240). Its top-right control puts it away; collapsed it leaves the layout,
  and the content bar's expand button is the ONLY way back — navigation never rides the content
  bar. Below 1024px it is a drawer over the content instead of a column — opening it never
  squeezes the chart to a sliver — and the drawer's own mode switch and utility rows carry every
  route. The old four-tab bar is deleted, not hidden.
- Electron's floor is 800px wide. A layout that only breaks below 1024 is a bug.
- Heavy surfaces are `React.lazy` with `SurfaceSkeleton`, never `fallback={null}`.
- Overlays mount **outside** `<main>`. A probe that measures `<main>` after opening one re-reports
  the previous surface and passes vacuously.

## Current state

One 1440px capture per surface, taken 2026-11-02 from the app with the probe's seeded profile:

| Analyze | Journal |
|---|---|
| ![Analyze](current/analyze.png) | ![Journal](current/journal.png) |

| Agents | Learning |
|---|---|
| ![Agents](current/agents.png) | ![Learning](current/learning.png) |

[Settings](current/settings.png) is the overlay.

These are orientation, not a gate — `render-probe` is the gate. Re-capture with
`npm run probe:surfaces`, then copy `surface-{analyze,journal,agents,learning,settings}.png` here when
a surface changes materially. The Analyze capture carries a "Memory reviewed" toast because the probe
seeds a notebook first; that is real state, not decoration.

## Changing a surface

1. Read this file and the [charter](charter.md).
2. Reuse the shared components the charter lists; do not hand-roll a pill, a tooltip, a dropdown, a
   modal or a focus ring.
3. Run `npm run render-probe` — it is the only gate that can see a surface mount, a rendered row,
   or an inert control.
4. Look at it in a browser at 1440 and at 800. No gate sees a clipped column.
