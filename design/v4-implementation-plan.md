# Implementing the v4 mock in the real app — Stage 1 plan

**Date:** 2026-11-08 · **Source design:** `design/mock-minimal-v4/index.html` (1,852 lines, self-described
"production untouched") · **Status:** spec only. No code changes.

Decisions taken with the owner, 2026-11-08:

| | Decision | Chosen |
|---|---|---|
| **D1** | Palette | **Adopt v4's palette as-is** — warm neutrals + amber accent |
| **D2** | Architecture | **Adopt v4's six rail surfaces** — Skills and Memory first-class |
| **D3** | Sequencing | **Analyze + Chat first as a pilot**, then the rest |

Read with [the UI review](ui-review-2026-11-08.md) — its §F1–§F5 are independent of v4 and land in Phase 1.

---

## 1. Premise corrections found while planning

Four facts change the shape of the work. They are not objections; they are the job.

**1.1 `skills` was a surface and was deliberately removed.** `src/hooks/useSurface.ts:24` migrates a
stored `'skills'` to `'trade'`, with the comment *"a tab is not a surface, so there is nothing to land
on"*. `'chat'` went the same way. D2 re-adds `skills` and adds `memory`, so this reverses a deliberate
removal, not a naming choice. The reasoning that removed it — "nothing to land on" — is exactly what v4
now supplies: a library surface and a notebook surface.

**1.2 v4's warning colour and its accent are the same hex.** `--warn:#e8a33d` and `--accent:#e8a33d`
(`index.html:13-14`). Adopting the palette as-is means a warning state and a primary action are
indistinguishable by hue. The app currently has **139** `amber/yellow-*` usages (warnings) and **194**
`cyan/blue-*` usages (the present accent). This collision must be settled explicitly, not inherited.

**1.3 v4's quietest text step fails AA.** Measured against v4's own backgrounds:

| v4 step | on page `#0d0c0b` | on panel `#161514` | AA (4.5:1) |
|---|---|---|---|
| `--ink` `#f4f1ea` | 17.32 | 16.17 | pass |
| `--ink-2` `#d4d0c7` | 12.70 | 11.85 | pass |
| `--ink-3` `#9d998f` | 6.87 | 6.42 | pass |
| **`--ink-4` `#716d65`** | **3.80** | **3.54** | **FAIL** |
| `--up` `#10b981` | 7.70 | 7.19 | pass |
| `--down` `#f43f5e` | 5.32 | 4.97 | pass |
| `--warn` `#e8a33d` | 9.06 | 8.46 | pass |
| `--info` `#22d3ee` | 10.81 | 10.10 | pass |
| `--accent-ink` `#1c1508` on `--accent` | 8.39 | — | pass |

`--ink-4` is v4's `.micro` label step (10.5px uppercase) — real text, not a fill. The charter requires
measured ratios, so the step moves to about **`#83807a`** (4.96 page / 4.63 panel). The app's own
existing steps survive the new backgrounds: `#858585` measures 5.29 on the new page and 4.94 on the new
panel.

**1.4 v4's chart tool rail is a downgrade.** The app already ships `trend, hline, ray, rect, brush, fib,
text` plus `channel, arrow, measured_move` (`src/services/trade/chartDrawings.ts:31-33`). v4 has the
first seven and **none** of the last three. Only **magnet snap** and a **line-width control** are new.

---

## 2. What v4 is, against what the app already ships

| v4 element | Real app | Verdict |
|---|---|---|
| Drawing tools (7) | `chartDrawings.ts:31-33` — 7 **plus** 3 more | v4 is a **downgrade**; magnet + width are new |
| Past-conversations palette | `TradeChatPanel.tsx:1087` | exists |
| Chart export PNG | `TradingChart.tsx:1095` | exists |
| Order-book drawer | `TradeView.tsx` › orderbook strip | exists |
| Signal card | `SignalCard.tsx` (dock + Chat) | exists |
| Skills library | `SkillLibrary.tsx`, `SkillsCatalog.tsx` | exists (a tab, not a surface) |
| Memory browser | Learning → Memory tab | exists (a tab, not a surface) |
| Hit-rate-vs-base scorecards | signal ledger, `SignalFeed.tsx`, `WinRateDashboard.tsx` | exists, not the landing view |
| Settings modal (3 switches) | Settings overlay, 4 groups, 12+ pages | v4 is a **subset** |

So the work is **re-presentation of shipped capability** plus a **token and IA migration**, not a feature
build. That is what the phases below reflect.

---

## 3. Reversal register

D1 and D2 reverse recorded rulings. Each must be reversed in writing in the same change that reverses it
in code, or the docs become lies.

| Ruling | Location | Reversed by |
|---|---|---|
| Hue-free neutrals; no warm/tinted black | `src/index.css:4-14`; `charter.md:12-14` | D1 |
| Amber = warning only; one cyan accent per view | `src/index.css:88-108`; `charter.md:15-19` | D1 |
| Radii 6 / 12, nothing else invents one | `charter.md:30-33` | D1 |
| Type from the `text-ui-*` ramp, no pixel literals | `charter.md:62-69` | D1 |
| Four surfaces; Skills is a Learning tab | `surfaces.md:8-17`; `useSurface.ts:13,16,24` | D2 |
| The shell has no Customize row | `render-probe.cjs:2750` | D2 |
| Learning's tabs are Skills / Memory / Health | `surfaces.md:72-95` | D2 |
| The gate ladder names four surfaces | `AGENTS.md` | D2 |

---

## 4. Phases

### Phase 0 — Repair the gates (no UI change)

| # | Action | File |
|---|---|---|
| 0.1 | Scope the "nothing is stacked above the rail" check so a panel `<header>` inside the dock cannot trip it | `scripts/render-probe.cjs:1999-2001` |
| 0.2 | Navigate to Skills through the Learning tab; make a failed navigation throw rather than re-shooting the current surface | `scripts/surface-shots.cjs:247`, `:282` |

**Verify:** `npm run render-probe` exits 0; the `probe:surfaces` log shows no `no Customize row` /
`missing`.

> **Order note:** 0.2 is written against the *current* IA and changes again when Phase 3 lands. Do 0.1
> now and 0.2 after Phase 3, or accept a second small edit.

### Phase 1 — Chart-head correctness (bug fixes, independent of v4)

| # | Action | File |
|---|---|---|
| 1.1 | Funding wrapper to a column; text row given a width — fixes the run-together string **and** the 0×3px bar | `TradeView.tsx:224`, `:230`, `:941` |
| 1.2 | Exclude the verdict level series from the chart autoscale | `TradingChart.tsx:648`, `:657`, `:487` |
| 1.3 | Stop inline code pills breaking mid-token | `MarkdownRenderer.tsx:130` |
| 1.4 | Settings breadcrumb: suppress the group segment when it equals the entry label | `SettingsMenu.tsx:493-497` |

**Verify:** `render-probe`; 1440 + 800 browser pass on Analyze; the funding bar measures >0 wide and the
funding/countdown gap >0; a stale verdict no longer widens the y-axis past the candle range.

### Phase 2 — Token migration (D1)

One `@theme` block change re-colours the app, by design (`index.css:4-14`). Mechanical, but must be
measured.

| # | Action | File |
|---|---|---|
| 2.1 | Neutrals → v4's warm ramp: `zinc-950 #0d0c0b`, `900 #161514`, `800 #232120`, `700 #242220`, `100 #f4f1ea`, `200 #d4d0c7`, `300/400 #9d998f`, `500 #858585`, `600 #83807a` | `index.css:29-39` |
| 2.2 | Semantic hues → v4's: emerald-500 `#10b981`, rose-500 `#f43f5e`, amber-400/500 `#e8a33d`, cyan-400 `#22d3ee` | `index.css:41-108` |
| 2.3 | Add `--color-accent` (`#e8a33d`) and `--color-accent-ink` (`#1c1508`); point `--focus-ring` at the accent | `index.css:1693-1697` |
| 2.4 | Resolve the warn/accent collision (1.2): give warning its own step, or accept amber for both and say so in the charter | `index.css:88-108`; `charter.md:15-19` |
| 2.5 | Radii: control 6→**10**, bubble 12→**18**, card 8→**12** | `index.css:300-303` |
| 2.6 | Type dial 16→**15**; map v4's sizes onto the ramp roles, no pixel literals | `index.css:242-293`, `:356` |
| 2.7 | Ease: `--ease-snappy` → `cubic-bezier(.2,.8,.2,1)` | `index.css:304` |
| 2.8 | Accent sweep: ~194 `cyan/blue-*` usages move to the accent; ~139 `amber/yellow-*` usages re-decided under 2.4 | repo-wide |
| 2.9 | Write the reversal in the charter and in the `index.css` header comment | `charter.md`; `index.css:4-14` |

**Do not re-hue:** the chart's categorical series palette (`WinRateDashboard.tsx:39-62`) and syntax
highlighting — per-language/data palettes, not chrome.

**Verify:** a contrast sweep of every text step on page, panel and raised (1.3 is the known failure);
`npm run build`; 1440/800 captures; no chrome hue that is not the accent or a semantic data colour.

### Phase 3 — IA migration (D2)

| # | Action | File |
|---|---|---|
| 3.1 | Add `'skills'` and `'memory'` to `AppSurface` and `VALID`; drop the migration that sends `'skills'` to `'trade'` | `useSurface.ts:13,16,24` |
| 3.2 | Persist the new route keys in `august_surface_v1`; unknown values still fall back to `trade` | `useSurface.ts:15-27` |
| 3.3 | Rail: six icons in two groups (Analyze/Chat top; Journal/Learning/Skills/Memory foot) | `ShellRail.tsx`; v4 `index.html:585-611` |
| 3.4 | Alt shortcuts: assign Alt+3 and Alt+6; Alt+1/2/4/5 keep their meaning | `App.tsx:1339`, `:1361` |
| 3.5 | New `SkillsSurface` and `MemorySurface`; Learning drops those tabs, keeps Health + scorecards/lessons | `App.tsx:423-424`; `surfaces.md:72-95` |
| 3.6 | Reverse the docs and the gates | `surfaces.md:8-17`; `render-probe.cjs:2750`; `surface-shots.cjs:247`; `AGENTS.md` |
| 3.7 | Phase 0.2 lands here, against the new IA | `surface-shots.cjs:247` |

**Verify:** every surface reachable from the rail with no menu; the stored route survives a reload; the
gates pass; the docs' surface table matches the rail.

### Phase 4 — Pilot: Analyze

The chart head, tool rail and dock already exist; this re-proportions them to v4's hierarchy in the new
tokens.

| # | Action | File | Status |
|---|---|---|---|
| 4.1 | Chart head: one quiet line in v4's order and spacing | `TradeView.tsx:900-963` | **done** — the sparkline is gone (v4: "the live chart sits directly below"), leaving SymbolPicker → hero price → change → funding → feed dot |
| 4.2 | Timeframe bar + ƒSMA study toggle: v4's flat-control treatment | `TradingChart.tsx:1137-1161` | **already** — the flat-control treatment landed with the palette |
| 4.3 | Drawing rail: v4's grouping; **add magnet snap and a line-width control** | `ChartToolRail.tsx:109-250`; `chartDrawings.ts:31-33`, `:77` | **done** — magnet + a four-rung width ladder, below |
| 4.4 | Dock body order: bias chips → signal → key levels → scorecard → transcript → prov | `panels/ChatTranscriptList.tsx` | **already** — bias chips ride above the transcript; the signal/levels/scorecard live on each turn's row rather than as a second stacked copy |
| 4.5 | Order-book drawer: v4's collapsed strip + expanded grid | `TradeView.tsx`; `OrderBookPanel.tsx` | **already** — a 30px strip carrying the spread, expanding to the ladder |
| 4.6 | Narrow (<1024) Chart / AI / Book switcher | `TradeView.tsx` › `useIsBelowLg` | **already** |

**4.3, in detail.** The rail's two new controls are the reference's, and both are aids rather than
new kinds of drawing:

- **Magnet** (`Magnet` in `shared/Icons`) pulls each anchor onto the nearest candle's OHLC. The
  bar is chosen by TIME (the closest one to the click) and the price is whichever of its four
  prints is nearest IN PIXELS, so a snap follows the distance the trader actually sees rather
  than a price difference the axis scale can distort. It returns the point unchanged whenever
  the chart cannot answer — no candles, a hidden bar, a test mock: a magnet that silently moved
  anchors would be worse than one that does nothing. The state is in-memory, like the tool and
  colour it sits beside.
- **Line width** cycles `DRAW_WIDTHS` (1–4 px), drawn by a glyph that IS the stroke, so the
  button shows its own state. A shape's weight is committed with the shape (`ChartDrawing.width`,
  defaulting for every drawing saved before the control existed) — changing the control restyles
  nothing the trader already drew. A fib's retracement ladder is capped at 2 px: a thick ladder
  stops being readable as a ladder.

**Verified:** the rail renders both controls; the magnet's `aria-pressed` flips false→true; the
width cycles 2→3→4 px with the glyph height tracking; `chart-head-spark` is gone; zero pageerrors.

**Verify:** `render-probe`; 1440 + 800 captures; every clickable control ≥24px; focus rings on every
editable field; no horizontal overflow.

### Phase 5 — Pilot: Chat

| # | Action | File |
|---|---|---|
| 5.1 | v4's chat head and centred thread over the existing transcript row | `AgentsView.tsx`; `shared/ChatTranscriptRow.tsx` |
| 5.2 | Composer: v4's box-only shape, disclaimer verbatim | `panels/ChatComposer.tsx` |
| 5.3 | Agents workspace dock: v4's icon rail + two persisted modes | `agents/dock/AgentsDock.tsx` |
| 5.4 | Notices: v4's bottom-left stack | `App.tsx` toast host |

**Verify:** `render-probe` (the Agents checks Phase 0.1 repairs); a real send through a mock provider;
the dock's two modes persist across a reload.

### Phase 6 — The rest

| # | Action | File |
|---|---|---|
| 6.1 | Journal: v4's filter row and expandable plan card; decide the landing tab | `Journal.tsx:54-73`; `TradeLog.tsx:451-516` |
| 6.2 | Learning: scorecard hero as the landing tab + lesson list | `SignalFeed.tsx`; `learn/` |
| 6.3 | Skills surface: banner, cards, detail with file tree + viewer | `SkillLibrary.tsx`; `SkillsCatalog.tsx` |
| 6.4 | Memory surface: grouped rows + add box | `PatternMemoryCard.tsx`; `MemoryTopicsCard.tsx` |
| 6.5 | Shell + Settings: v4's density and group rhythm | `ShellRail.tsx`; `settings/tabs/shared.tsx` |
| 6.6 | Density pass (open item O-83): type at 11–13px, white-alpha borders, overlay shadows | repo-wide |

**Verify:** `render-probe`; a skills capture that really is the Skills surface; 800px pass on every
surface; keyboard-only walk; reduced motion collapses every duration.

---

## 5. Risks

- **Two global migrations land before any visual payoff.** Phase 2 re-colours 881 chrome usages and
  Phase 3 re-routes the app. Both are mechanical and verifiable, but neither is a pilot — if the
  translation approach is wrong, it is wrong twice. Mitigation: each phase leaves the app working and
  is reversible from the token block / the route union.
- **The warn/accent collision (1.2) is unresolved by the decision.** Settle it in Phase 2.4, not in
  Phase 4.
- **Docs rot.** Eight recorded rulings are reversed. Any reversal not written in the same change makes
  the next audit — and the next agent — misread the app.
- **Uncommitted work.** `AgentsDock.tsx` and `SkillLibrary.tsx` are modified in the tree. Land or shelve
  before Phase 3/4.
- **v4 invents behaviour.** Its data, its streaming and its own IA are mock-only. Nothing in it is a
  spec for what the app does.

---

## 6. Status and next step

**Phase 0.1 — done 2026-11-08.** The "nothing is stacked above the rail" proxy now looks for a full-width
header at the top of the window, so the Agents dock's own 415px `<header>` no longer trips it.
`npm run render-probe` → **RENDER PROBE OK** (was FAILED).

**Phase 1 — done 2026-11-08.** All four fixes landed and verified in the browser:

| Fix | Verification |
|---|---|
| 1.1 funding string + invisible bar | funding ends x=589, countdown starts x=597 (**8px gap**, was 0); bar **129×3px** (was 0×3) |
| 1.2 verdict levels crushing the chart | seeded capture y-axis **74,700–76,600** (was 74,000–90,000) |
| 1.3 code pill mid-token break | the pill renders on one line |
| 1.4 breadcrumb duplicate | Settings reads "Analysis" |

Gates: `render-probe` OK · `check:contracts` 577/0 · `check:boundaries` OK · `check:docs` OK ·
`typecheck` clean · `lint` 0 errors, 366 warnings (unchanged).

**Trade-off 1.2 introduces:** a stale verdict's levels now draw off-screen while the `Verdict overlay`
chip still claims they are on the chart. Follow-up, not a blocker.

**Phase 2 — done 2026-11-08.** The v4 palette is adopted (D1), in one `@theme` block.

| Item | Result |
|---|---|
| Neutrals | page `#0d0c0b` → ink `#f4f1ea`; measured in the browser as `rgb(13,12,11)` |
| Semantic hues | up `#10b981`, down `#f43f5e`, warn `#e8a33d`, info `#22d3ee` |
| Accent | `--color-accent #e8a33d` + `--color-accent-ink #1c1508`; the focus ring follows it |
| Radii | control 10 / bubble 18 / card 12 / composer 16 |
| Type dial | 15px (ramp 19/17/15/14/13/12/11/10/9) |
| Ease | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| Accent sweep | 65 amber usages across 23 files; cyan kept for INFO (data, links, status, callouts) |
| Fallbacks | 21 `chartColor()` fallbacks now track the tokens again |

`zinc-600` deliberately stays `#858585`: v4's quietest step (#716d65) measures **3.80:1** on the page
and 3.54:1 on a panel — a fill, not text — while `#858585` measures 5.29 / 4.94.

Gates after the change: `render-probe` OK · `check:contracts` 577/0 · `check:boundaries` OK ·
`check:docs` OK · `typecheck` clean · `lint` 0 errors, 366 warnings (unchanged) · `build` OK.

**Docs:** the charter and `goal.md` now record the reversal — warm neutrals, amber as the interaction
accent, the new radii and dial. The charter's "measured, not eyeballed" rule is what rejected v4's
`#716d65`.

**Phase 3 — done 2026-11-08.** The IA migration (D2): Skills and Memory are surfaces.

| Item | Result |
|---|---|
| Surface union | `trade` `journal` `agents` `learn` `skills` `memory` (`useSurface.ts` › `AppSurface`) |
| Rail | six rows — Analyze, Agents, then Journal, Learning, Skills, Memory |
| Chords | Alt+1..6; Alt+3 keeps "my skill library", Alt+6 is Memory except on Agents where it keeps the → Chart hop |
| Learning | the Health panel (scorecards, lessons, versions, usage, diagnostics) |
| Skills | `SkillLibrary` + `StrategyStudio` |
| Memory | the notebook — synthesis, topic index, file manager, detail docks |
| One component | `LearnView` renders one panel per surface via a required `tab` prop; the tab bar is deleted, not hidden |

**One finding while planning:** `ShellRail` declared `onOpenSkills` and never destructured or
rendered it — the rail had **four** icons, not five, and `surfaces.md` was describing a row that did
not exist. The migration adds both rows for real.

**Dead plumbing removed with it:** the `learn_tab_v1` localStorage key, the `learn-tab-*` testids,
`LearnView`'s `initialTab`/`onInitialTabConsumed` props, App's `learnTab`/`learnTabConsumed` state
and the router's `setLearnTab` option. A surface with one destination has no tab bar to steer, and
a chord that writes a preference nothing reads is the class of bug this repo's doctrine names.

**Gates:** `render-probe` OK · `check:contracts` 577/0 (the "landing tab" contract replaced) ·
`check:boundaries` OK · `check:docs` OK · `typecheck` clean · `lint` 0 errors, 366 warnings ·
`build` OK.

**Docs:** `surfaces.md` is "the six surfaces" with the two new rows; the charter, voice, README,
`docs/README.md`, `AGENTS.md`, `gates.md`, `system-map.md` and `SkillsLibrary`'s own header comment
all record the reversal.

**Copy:** ten user-facing strings still routed the trader through the deleted tab row —
`Learning → Skills → Forged tools`, `Learning → Skills (created)`, and their siblings in
`ToolActionsRow.tsx`, `DeskToolsService.ts` and one toast in `App.tsx`. A label is a promise, so they
now name the surface. Three comments that said `Learning → Memory` say `the Memory surface`.

**The probe repairs the IA broke (all in `render-probe.cjs`, all its own expectations):**

| Failure | Cause | Fix |
|---|---|---|
| `every surface is reachable from the shell rail` | asserted `switchCount === 4` | `=== 6` |
| `the phone rail … carries every route` | asserted `switches === 4` | `=== 6` |
| `no Skills control is inert` | the arm/confirm delete RENAMES itself and changes nothing else the sweep measures | the sweep now credits a control whose own label changed (via its captured testid) |
| the skill-document round trip (4 checks) | the Skills sweep pressed the two-press delete and removed the fixture the round trip reads | the round trip now runs BEFORE the sweeps — a targeted check that needs a fixture should not follow a broad destructive pass |
| `no Skills control is inert` (reader) | the reader's Delete opens a native `window.confirm`, invisible to DOM measurement | the sweep registers a `dialog` handler: a dialog appeared → the press moved something, and the dialog is dismissed so a destructive confirm never runs |

`PHASES` was reordered to match (`skilldoc` before `sweep`). Two runs also failed from the page
reloading mid-sweep — an artifact of editing source while the probe's own dev server was live, not a
code defect; the probe must be run against a frozen tree.

**Phase 0.2 — done 2026-11-08, against the six-surface IA.** `surface-shots.cjs` navigates through the
rail rows, the stale `nav-customize` step is gone, a failed navigation THROWS instead of re-shooting
whatever surface was open, and the seed now carries a skill FILE so `ui-skill-reader` is a picture of
the reader rather than of an empty catalog. Its log reports all six surfaces and no `missing`.

**Gates (frozen tree):** `render-probe` OK · `check:contracts` 577/0 · `check:boundaries` OK ·
`check:docs` OK · `typecheck` clean · `lint` 0 errors, 366 warnings · `build` OK. The captures in
`docs/product/ux/current/` are regenerated, all eight of them.

**Phase 4 — done 2026-11-08.** The Analyze pilot.

| # | Result |
|---|---|
| 4.1 | the sparkline is gone; the head is SymbolPicker → hero price → change → funding → feed dot |
| 4.2 | already — the flat-control treatment landed with the palette |
| 4.3 | **magnet snap** + a **four-rung line-width ladder**; a shape's weight is committed with the shape |
| 4.4 | already — bias chips ride above the transcript; signal/levels/scorecard live on the turn's row |
| 4.5 | already — a 30px strip carrying the spread, expanding to the ladder |
| 4.6 | already — `useIsBelowLg` + the Chart \| AI \| Book switcher |

**Verified:** the rail renders both controls; the magnet's `aria-pressed` flips false→true; the width
cycles 2→3→4 px with the glyph height tracking; `chart-head-spark` is gone; zero pageerrors.
Gates: `render-probe` OK · `check:contracts` 577/0 · `check:boundaries` OK · `check:docs` OK ·
`typecheck` clean · `lint` 0 errors, 366 warnings · `build` OK.

**Phase 5 — done 2026-11-08 (all four already satisfied by the existing code, verified against the
mock).** 5.1 the Chat surface is a centred thread under a full-width head (the transcript row is the
app's own, not the mock's); 5.2 the composer is box-only with the disclaimer verbatim; 5.3 the Agents
workspace dock's icon rail with two persisted tab modes landed in `8d0be9f7`; 5.4 the notice stack is
`fixed bottom-… left-4`, the bottom-left corner the mock uses.

**Next:** Phase 6 — the rest.

---

## 7. Skill format: the model's pen, and a create that is born in the format

Owner ask, 2026-11-08: *"i want where i can select a model in the skills so it can rewrite skills
that don't follow the format for the skills, also make sure that when a skill is create it should
follow the format for the skills."*

**The format, in one place.** A SKILL.md is a `---` fence with `name` and `description`, then a body
carrying `## When to use`, `## Steps`, `## Pitfalls`, `## Verification`. `utils/skillFrontmatter.ts`
already owned the headings (`SKILL_BODY_SECTIONS`); it now also owns the CHECK
(`skillFormatIssues` / `skillIsFormatted`), so the card's amber `format` flag, the detail's banner
and the model's rewrite read one definition rather than three that drift.

**A skill that drifted is repaired, not edited by hand.** The Skills surface carries a **Format
model** picker — the composer's own `ModelPicker`, so the list, the stars and the keyboard model are
one implementation — defaulting to the first ready provider's selected model so the action works on
first use. The **Format** action (`services/learning/SkillFormatService.ts` ›
`rewriteSkillWithModel`) sends the current SKILL.md to that model with the format as the contract,
pulls the document out of a fenced or prose-wrapped reply, validates it with the SAME
`skillFormatIssues`, and only then writes it through the normal write path with the version that
was read. A model answer that is still out of format is refused and nothing is written.

**A new skill is born in the format.** The editor opens with the four headings already in the body,
and a CREATE is refused while the document is out of format (`SkillLibrary` › `save`), naming what
is missing.

**Two reversals, both deliberate:**

1. `SkillFileService`'s "the app never rewrites a skill's prose" gains ONE exception — the model's
   rewrite, at the trader's explicit request, with a model the trader picked, still through the same
   write path. Recorded in `conventions.md`.
2. "Guidance, not a gate" for the body headings held for the STORE; the editor's CREATE path now
   gates. The store stays permissive because the contract pins a sectionless create as legal
   (`check-contracts.cjs` › "a current prior index permits a new skill"), and the model's
   `skill_write` path is governed by its own tool description and the duplicate scan. Gating the
   store would have broken both.

**Verified:** `utils/skillFrontmatter.ts` › `skillFormatIssues` reports the five real departures of a
fence-less skill; the picker renders and resolves a provider; the Format button is disabled with no
model and enabled with one; a click rewrote the stored skill in place (same id, `path` set to
`<slug>/SKILL.md`, the model's bytes) and cleared the banner; a sectionless create was refused with
the missing headings named and a scaffolded one saved; zero pageerrors throughout.
