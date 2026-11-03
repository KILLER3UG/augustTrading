# Implementation record — the 2026-10-20 fix pass

**What this file is.** The register (`open-items.md`) says what is *open*. This file says
what *landed*, where it landed, and how it was verified. It is not a second register: an
item appears here only when there is a `file:line` to point at and a gate that was run.

**The rule it follows.** Every claim here was re-measured against the tree, not copied
from a commit message. Where a figure moved while the pass was running, the figure and
the tip it was taken at are both given, because a number without its tip is how a
document starts lying.

**Scope.** This is the *roadmap thread's* record, not a complete account of the pass —
six other threads were landing code in the same tree at the same time. Anything this file
does not mention is not claimed to be done.

---

## 1. The plan's items that landed in this pass

| item | what landed | where | how it was verified |
|---|---|---|---|
| **E-11** | **The prompt contract test.** A new suite that asserts what is **sent** on the four model-call paths, not what is built. | `tests/promptContract.test.ts` (new) | `npx vitest run tests/promptContract.test.ts` → **16 tests, 16 pass** (2026-10-20). |
| **E-60** | **The "one place to look" rule**, in one line, in `AGENTS.md`. | `AGENTS.md` § *The Plan* | Read back; the line names the working list, the evidence file, and the id a proposal must cite. |
| **E-01a** (prompts thread) | **The harness contract reaches every live surface exactly once.** It is injected at the transport — `withDeskToolsSystemPrompt` (`src/services/analysis/DeskToolsService.ts:3782`, called from `:3827`) — not at each surface's composer. | `src/services/analysis/DeskToolsService.ts` | **Verified by outcome, not by diff:** `tests/promptContract.test.ts` asserts `HARNESS CONTRACT` appears exactly once in the sent system prompt on all four paths, and that the evaluation path — which composes the contract itself — does not get a second one at the transport. |
| **E-09** (prompts thread) | **`analysis.lens` is gone from the registry.** The editor entry the trader could edit but the model never saw is deleted; the registry now holds **12** ids. | `src/constants/promptRegistry.ts:54-162` | **Verified by reading the file** (no `analysis.lens` entry) **and by the new gate**: `tests/promptContract.test.ts` now asserts that the three registry ids the registry itself says reach `analyzeTradingView` — `analysis.master`, `analysis.risk_rules`, `analysis.memory_enforcement` — actually appear **in the sent system prompt**. That is E-09's own verification, done the way the plan asked for it: not "a `getPrompt()` call site exists" but "the prompt reaches a sent request". |
| **3.6 (docs restructure)** | **The plan corpus landed in `docs/plan/`** — `README.md`, `open-items.md`, `full-audit.md` and `audit/` (seven sources). `docs/plans/` now holds **one** file: `debate-deletion-status.md`, the dated history ledger the anchor gate scans. | `docs/plan/`; `docs/plans/debate-deletion-status.md` | **Verified by listing the tree** at `40443692`: `docs/plans/` = 1 file, `docs/plan/` = 4 entries + 7 audit sources. |
| **Q14 (answered and executed)** | **18 plan documents deleted, not archived.** | `docs/plans/` | **Verified by listing `docs/plans/`**: only the dated ledger survives, as the anchor gate's scan list (`scripts/check-flow-doc-anchors.cjs:44`) requires. |
| **Q10 (answered)** | **`docs/analysis/` is scratch, and the previous audit cannot be pruned.** The directory is untracked on purpose; the six previous reports were preserved on a branch — **that branch was deleted on 2026-10-23, so this is a dated record, not a standing fact.** | commit `56639b4b`; branch `archive/prior-audit-2026-10-18` | **Verified**: the branch resolves (`508b691a`) and carries **1 182** `docs/analysis/` entries — the six `.md` reports **including `06-independent-review-2026-10-18.md`**, plus the `data/` folder. Nothing in the other three checkpoint commits is missing from it, so `git gc --prune=now` can no longer destroy the only written record of the live-data findings. |

### The analyst-role system (the 2026-10-19/20 wave)

Not a plan item, but the largest change in the tree, and the reason several plan items
changed shape. Recorded here so the next reader does not re-derive it.

| commit | what |
|---|---|
| `6e1e09bb` | **the analyst-role system deleted**, and stored profiles migrated. |
| `69c4aa33` | the last role/lens vocabulary residue removed. |
| `2157999f` / `658ae762` | the moderator is a **seat pick**, not a debate role; the global Moderator model picker is gone. |
| `40443692` | the orphaned progress tracker deleted. |

---

## 2. Measured figures

Every number here was taken with the command named, on the tip named.

| figure | value | how it was measured | tip |
|---|---|---|---|
| **`src/App.tsx` unused declarations** | **11 locals + 6 imports = 17** | `npx eslint src/App.tsx -f json` → 17 `@typescript-eslint/no-unused-vars` messages | 2026-10-20, working tree |
| the six unused **imports** | `Conversation`, `AIProvider`, `ChevronDownIcon`, `CloseIcon`, `ModelPicker`, `NavRail` | same | same |
| the eleven unused **locals** | `providerCooldownRemainingMs`, `updateActiveConversation`, `newlyAddedInsightIds`, `leverageInput`, `isNavOverlay`, `closeNavOverlay`, `input`, `images`, `setLoadingMessage`, `openBotInTrade`, `openGroupInTrade` | same | same |
| **the cost model's `netR` is no longer gross** | `meta.netR` is now net of the fee tier | `tests/skillStatisticsGate.test.ts:202,214` still assert the **pre-fee** figures (`-0.8`, `3`) and now read `-0.82` / `2.98` | 2026-10-20 |
| **vitest census** | see `AGENTS.md`'s tree map | vitest's own summary block | see `AGENTS.md` |
| the previous audit's preservation | **1 182** `docs/analysis/` entries on `archive/prior-audit-2026-10-18` — **the branch was deleted 2026-10-23**, so this measured a state that no longer exists | `git ls-tree -r --name-only archive/prior-audit-2026-10-18 -- docs/analysis` | 2026-10-20 |

**A note on the `src/App.tsx` figure, because the plan quotes several.** The "28 unused LOCAL
declarations" number is **not in `AGENTS.md`** at this tip — the `AGENTS.md` rewrite
removed it. The number was re-measured rather than patched, because a figure that lives
in three places and is measured in a fourth is a figure that will be wrong in one of them.
**17 is the count of eslint messages; 11 is the count of unused local declarations; 6 is
the count of unused imports.** The `cleanup` thread's 13 was measured at an earlier tip.

**A note on the `netR` figure, because it is the cost model showing up in a test.**
Q3 was answered — 5 bps taker / 2 bps maker — and the cost model landed with it, so
`meta.netR` is now **net**. `tests/skillStatisticsGate.test.ts:202,214` still assert the
**gross** figures the app used to produce (`-0.8` and `3`), and now read `-0.82` and
`2.98`: the 0.02 is the fee. **Those assertions are the cost model's first red test, and
they belong to the thread that landed it — this record does not change them.** They are
the honest proof that Q3 was acted on rather than merely recorded.

---

## 3. What the prompt contract test asserts, and why it is not a copy

The test is the plan's E-11, and its whole value is that it can **fail on the code**. Three
design decisions make that true:

1. **It captures at the transport boundary, and applies the REAL enrichment.**
   `streamChatWithDeskTools` adds the harness contract and the DESK TOOLS block *inside*
   itself (`:3804`). A test that mocked that function would assert a prompt the app never
   sends. So the test captures the message array the turn hands the transport, then applies
   the real `withDeskToolsSystemPrompt` to it — and **source-pins** that the transport
   really does call it, so the file cannot pass on a transport that stopped enriching.
2. **The dock's composer is a `useCallback` inside a component**, so it cannot be called
   from a unit test. The test asserts the contract over the two **exported** blocks the
   panel concatenates (`TRADE_CHAT_SYSTEM_PROMPT`, `buildSkillsIndexForPrompt`) and
   source-pins the concatenation. A copy of the composition inside the test would be the
   second implementation this repo keeps paying for.
3. **The debate-vocabulary check is an exact equation, not a ban.** Two shared blocks still
   carry a residue of the debate deletion — the harness contract's *"The moderator's last
   block…"* and the DESK TOOLS catalogue's *"…or moderator verdict"*. A blanket ban would
   have failed on the shared blocks and taught the next reader nothing. The test instead
   measures what the shared blocks contribute (from the real function) and requires the
   surface's own text to add **nothing**: the wire prompt's count must equal the surface's
   own count plus the shared blocks' contribution. A surface that reintroduces the word
   breaks the balance.

**It is not vacuous.** It went red seven times while it was being written — every one of
them a real mismatch between the assertion and the code — and it is green now against the
tree as it stands. The plan's own verification for E-11 is *"remove a block from one
surface's prompt and watch exactly one test go red"*; the seven reds are that evidence,
and the assertions are exact counts, so a removed block cannot pass.

### What it covers, per path

| path | the real function it drives | what it proves |
|---|---|---|
| **P1 chat** | `runChatSurfaceTurn` (`src/services/trade/chatSurfaceTurn.ts`) | the contract once, the DESK TOOLS block once, the mandate present, only offered tools named, the allow-list is exactly `CHAT_SURFACE_TOOLS`, a skill NAMED once |
| **P2 dock** | the exported `TRADE_CHAT_SYSTEM_PROMPT` + `buildSkillsIndexForPrompt` (`src/services/trade/tradeChatContext.ts`), source-pinned to the panel's composer | the same, plus the mailbox tools are never named |
| **P3 automation** | `runAutomationTurn` (`src/services/trade/automationTurn.ts`) | the same, plus the allow-list is exactly the Chat surface's minus the denied eight, and no notebook-writing tool is named |
| **P4 evaluation** | `analyzeTradingView` (`src/services/providers/GenericAnalysisService.ts`) — the skill-evaluation path, called from `src/services/learning/SkillEvalScheduler.ts:285` | the contract is composed once and not doubled, the retrieved context rides in the **user** turn and not the system prompt, and the registry prompts that claim the path really reach the wire |

---

## 4. Decisions taken differently from the plan's default

**The plan is a proposal; this section is where it and the code part company.** Each of
these is a place where the plan said one thing and the implementation had to do another,
with the reason.

| the plan says | what was done | why |
|---|---|---|
| E-11: *"for each of the four model-call paths (P1 chat, P2 dock, P3 automation, **P4 bot**)"* | **P4 is the evaluation path** — `analyzeTradingView` (`src/services/providers/GenericAnalysisService.ts`), which the plan's own tool table (`audit/2026-10-19-01-system-and-data-flow.md:904`) calls *"P5 evaluation"*, and which is what the skill-evaluation scheduler actually calls (`src/services/learning/SkillEvalScheduler.ts:285`). | The plan's prose and the plan's own table disagree about the fourth path, and the table's version is the one a unit test can drive end to end. The bot path is a `streamQuickResponse` turn and carries no separate system prompt to audit. |
| E-11: *"build the **real** system prompt through the real function"* | **The dock's composer is a `useCallback` inside a component** (`src/components/trade/TradeChatPanel.tsx:450`), so the test asserts the contract over the two **exported** blocks the panel concatenates and **source-pins the concatenation**. | A copy of the composition inside the test would be the second implementation this repo keeps paying for — and the source pin is what stops the test from passing on a panel that stopped using those blocks. |
| E-11: *"assert … the tool list matches the surface's allow-list"* | **The check is made on the surface's OWN text, never on the enriched prompt**, and the shared DESK TOOLS catalogue — which names every tool the executor has — is measured separately. | Reading the catalogue as the surface's vocabulary would make the check vacuous: every surface would "name" every tool. The measured split is what lets the check mean something. |
| E-11: *"no `debate`/`moderator` vocabulary may appear on a live surface"* | **An exact equation, not a ban.** Two shared blocks still carry the residue of the debate deletion — the harness contract's *"The moderator's last block…"* and the DESK TOOLS catalogue's *"…or moderator verdict"*. The wire prompt's count must equal the surface's own count plus the shared blocks' measured contribution. | A blanket ban fails on the shared blocks and teaches the next reader nothing. The equation fails when a **surface** reintroduces the word, and it fails when a shared block's copy disappears — so the residue cannot hide a new one. |
| E-11: *"four tests, one per surface"* | **Sixteen tests across the four paths**, because each path is checked on four axes (present / absent / tools / skills) and the axes are the contract. | One test per surface would have to assert all four axes in one breath, and the first failure would hide the other three. |
| §3E's **E-49** — rank and filter the 30-slot skill index by trigger, status, audience and evidence | **NOT implemented here.** The contract test pins the index's **section vocabulary** and the "named once" property, and deliberately does **not** pin its order. | E-49 is not in this thread's items. The test was written so that E-49's re-ranking will not break it — the index is still "one line per skill, in the recognised heading", and which skills occupy the slots is E-49's business. **Worth knowing before E-49 lands:** `SkillIndexAudience = 'analyst' \| 'moderator'` still exists at `src/services/trade/tradeChatContext.ts:214` while `buildSkillsIndexForPrompt` takes no `audience` argument, and `MemoryRetrievalService` filters by audience for *retrieval* but the *index* does not. That is exactly the gap E-49 names. |
| §3E's **E-48b** — the three-verdict review job for malformed skills | **NOT implemented here.** | Not in this thread's items. The contract test does not touch it. |

---

## 5. What this record does NOT close

- **No owner question is closed by this file.** Three are answered (Q3, Q10, Q14) and the
  rest stand.
- **The registry-to-wire check covers one path.** `analysis.compact`, `strategy.summarize_pdf`,
  `notebook.note`, `notebook.chat_note`, `strategy.ocr_page`, `learning.skill_craft`,
  `learning.skill_refine`, `learning.skill_worth` and `learning.chart_scan` are sent by
  six other services, none of which a unit test drives end to end here. **The gate is
  real for the path it covers and silent for the rest** — the same shape of blind spot the
  plan keeps naming, and the same shape the anchor gate has.
- **The F-01 shape is asserted for the surfaces, not for the pipeline.** The pipeline's
  `enhancedPrompt` is assembled in `src/hooks/useAnalysisPipeline.ts:1088-1131` and is the
  subject of E-01; the contract test asserts that the four surfaces do not carry a
  retrieved blob, and that the evaluation path's retrieval rides in the user turn. **It
  does not assert what the pipeline sends** — that path was not driven here.
- **The measured figures move.** Six other threads were landing code in the same tree.
  Every number in §2 carries its tip for that reason.

---

## 6. How to keep this honest

- A new implementation record line needs a `file:line` **and** a gate that was run.
- A figure that moved must be re-measured, not patched — and the old tip is worth keeping
  next to the new one.
- An item that landed *differently* from the plan's default says so here, with the reason.
  **The plan is a proposal; this file is the record of what the trader actually accepted.**

---

## 7. The Phase 3 / Phase 4 pass (2026-10-20)

This is a second pass over the plan, after the one recorded in §1. It closed the
remaining Phase 1 items, all of Phase 3, and the Phase 4 items that do not wait
on real data. **One item is deliberately not built: the candidate log** — D-24
approves its shape but gates its implementation waves on the shadow month that
E-18 now makes possible. The decline half of E-42 is built; the log half is not.

| item | what landed | where | how it was verified |
|---|---|---|---|
| **E-37** | Evidence floors raised: cluster 3→10, confirmed 5→20, veto 2→10. `MIN_SAMPLE_RETIRE` deliberately unchanged. | `src/services/learning/SkillMemoryService.ts` (constants) | Existing suites updated on purpose (fixtures raised to the new floors); **4918/4918** vitest tests green. |
| **E-38** | A presented plan now carries a validity window from the app's own detector (scalp 20 min, swing 330 min), so `ENTRY_NOT_HIT` is writable at expiry. It also records the stop-distance percentage the detector reads. | `src/services/trade/proposedTrade.ts` (`buildTradePlan`, `applyTradeTypeToAnalysis`) | `tests/proposedTrade.test.ts` asserts both classes and windows. |
| **E-40** | `decidedAt` beside the write `timestamp`; `decidedAtOf()` is the one fallback for legacy rows. Dashboards, learning sections and the recent-form brief order by decision time; the brief shows it. | `src/types/trade.ts`, `src/hooks/useTradeLogging.ts`, `src/utils/journalAnalytics.ts`, `src/utils/recentTradesBrief.ts`, the dashboard/learning sections | `tests/recentTradesBrief.test.ts` (decided Monday / logged Friday) + typecheck. |
| **E-39** | `tradingDecision: high` for the two plan-capable chat homes and `automatedTradingDecision: max` for schedules; a composer pick still wins. `effectiveTemperature()` is the published format × thinking table, tested. | `src/services/providers/reasoningControls.ts`, `chatSurfaceTurn.ts`, `chatTurnRunner.ts`, `automationTurn.ts`, `shared/providerRequestPolicy.cjs` | `tests/reasoningControls.test.ts`, `tests/providerRequestPolicy.test.ts`, `tests/chatEffortDial.test.tsx`. |
| **E-26b / E-14** | The Q4 default: `approval_rules_v1` and the five restore-only namespaces are on the RAW list; `trade_chat_active_v1` and `trade_declines_v1` too. A raw-string envelope carries plain values (usernames, session ids, flags) without quoting them. | `src/services/infrastructure/ExportService.ts` | Export suites incl. a native-shaped round trip of a plain username and a session id. |
| **E-06** | Bundle ceiling 2,600 → **1,400 kB**, plus a stale-ceiling floor at 90 % so the ratchet must be lowered when the build shrinks. Measured entry: **1,389.30 kB**. | `.github/workflows/guards.yml` | Build + the ratchet shell logic run locally (`RATCHET_OK`). |
| **W3.1** | The roster-deletion test: a clean store stays empty and a brand-new profile shows no Macro/Technical/Risk seats. | `tests/agentRosterService.test.ts`, `tests/agentsSurface.test.tsx` | Both suites green. |
| **E-35** | The deterministic layer is wired at the ONE `present_trade` executor: a confirmed AVOID refuses the plan and writes `VetoLedgerService.recordVeto`; a candidate AVOID caps the tier; a fired predicate's `ceiling` is folded into the same gate stamp the journal records. | `src/services/trade/presentTradeTool.ts`, `src/services/trade/proposalGate.ts`, `src/types/analysis.ts` | `tests/planE35Enforcement.test.ts` drives the real presenter (6 tests) and proves the ledger write, the refusal, the candidate cap and the stamped ceiling. |
| **E-43** | `netEdgeR` (net expectancy at the plan's own capped probability), a trader floor setting (default 0), a gate refusal, and a card that disables Log and quotes the number. The gate and the card read the SAME `buildTradePlan`. | `src/utils/netRiskReward.ts`, `src/services/trade/proposalGate.ts`, `src/services/trade/proposedTrade.ts`, `src/components/trade/panels/TradeProposalCard.tsx`, `src/App.tsx`, Settings → Analysis | `tests/planE03.test.ts`, `tests/proposalGate.test.ts`, `tests/proposalCard.test.tsx`. |
| **E-41** | New-session default leverage is the trader's setting, **10×** out of the box; `LEGACY_LEVERAGE = 100` is used only for historical rows. The proposal card shows the isolated-liquidation buffer beside the stop. | `src/utils/harnessSettings.ts`, `src/utils/conversationUtils.ts`, `src/components/trade/panels/TradeProposalCard.tsx`, Settings → Analysis | `tests/harnessControlsSettings.test.tsx` + card test (5 % buffer at 10×, "past liquidation" at 100×). |
| **E-18** | Automatic settlement with a 15 s Undo window; `shadow` (show, never record — the DEFAULT, per the plan's first month) and `confirm` modes; per-coin `deny`/`always` still win. Rows carry `resolutionSource`; a human correction stamps `correctedFrom`/`correctedAt` and `resolutionSource: correction`. | `src/utils/outcomeSettlement.ts`, `src/hooks/useWatchSideEffects.ts`, `src/hooks/useTradeLogging.ts`, `src/hooks/useTradeJournalActions.ts`, `src/types/trade.ts`, Settings → Analysis | `tests/planE18Settlement.test.ts` (table + real hook with fake timers), `tests/useTradeJournalActions.test.tsx`, `tests/harnessControlsSettings.test.tsx` (default = shadow). |
| **E-42(a)** | `decline_trade`: a HOLD object with the reason, side and rejected levels, offered on Chat, the dock and schedules, bounded at 500, backed up. | `src/services/trade/declineLog.ts`, `src/services/analysis/DeskToolsService.ts`, the three allow-lists, `ExportService.ts` | `tests/planE42Decline.test.ts` (5 tests, incl. the allow-list refusal). |
| **E-19** | ONE `TradePlan` object (`buildTradePlan`) produces the ratio, model claim, capped probability/band, cost, net edge and warnings. The card, the journal builder, the watch/drawings and the minEdge gate read it. | `src/services/trade/proposedTrade.ts`, `presentTradeTool.ts`, `TradeProposalCard.tsx` | `tests/planE19OnePlan.test.ts` asserts card/row/gate equality. |
| **E-20** | A read-only replay harness: `src/utils/planReplay.ts` + `npm run replay:plans --input <export>`. It re-derives today's verdict through the real builder and reports drift; an unstamped row is counted as unstamped, not accused. The deterministic baseline is labelled as requiring the candidate log. | `src/utils/planReplay.ts`, `scripts/replay-plans.entry.ts`, `scripts/replay-plans.cjs` | Unit tests + a real sample run produced a report (`1/1 compared, 1 drifted`). |
| **E-24** | Behavioural coverage for `electron/main.cjs`: protocol containment (real path, encoded traversal, foreign host, bad encoding), navigation/window-open policy, and the shell's hardening options. | `tests/planE24ElectronBehaviour.test.ts` | 7 tests against the real main process with Electron mocked. |
| **E-23** | Version + checksum + a preserved sidecar on a corrupt or checksum-failing notebook; a list/restore API; a "Restore this copy" banner in the notebook UI. The main key is never overwritten. | `src/services/learning/MemoryFilesService.ts`, `src/components/learn/MemoryFilesManager.tsx`, `ExportService.ts` | `tests/memoryFilesService.test.ts` (sidecar, restore, refusal, checksum). |
| **E-44** | The notebook is a v2 manifest plus per-category shards for `skills` and `trader-diary`; the v1 key becomes the manifest and migration source. The manifest is written LAST, so one full shard cannot take the whole notebook down. Every entry survives byte-identically across migration. | `src/services/learning/MemoryFilesService.ts`, `scripts/probe-skill-approval.cjs` (reads the shard), `ExportService.ts` | Sharding + migration tests; the full suite and the skill-approval probe (25/25) both pass. |

### The gates this pass ran, with their own figures

| gate | result |
|---|---|
| `npm run typecheck` / `typecheck:scripts` | 0 errors |
| `npm run lint` | 0 errors, **659** warnings (the ratchet cap binds exactly) |
| `npm run test` | **491 files / 4918 tests passed** |
| `npm run build` | ok, entry **1,389.30 kB** |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | ok, zero pageerrors |
| `npm run e2e` | 5 passed |
| `npm run skill-approval-probe` | **25/25**, `pageErrors=2` (its known quota signature) |
| `npm run check-flow-doc-anchors` | **299 anchors verified, 0 unattributed**; re-anchored from the HEAD source lines after the code moved |

### What this pass does NOT close

- **The candidate log (E-42b)** is not built: D-24 approves its shape but gates
  the implementation waves on the shadow month. The decline object is the half
  that can be built now.
- **The register's UX/accessibility, cleanup and infrastructure rows** (the
  `O-nn` items outside the five-phase order) are untouched. The five-phase order
  in `README.md` is what this pass completed, not the whole 121-row register.
- **The `minEdge` default is 0.** A trader who wants a margin raises it in
  Settings → Analysis; the default only refuses plans whose edge is non-positive.
- **Outcome settlement ships in `shadow`, not `automatic`.** The plan's first
  month is resolve-and-show-never-record; the trader flips it to automatic after
  comparing the detector with their own calls. The mechanism (provenance,
  correction, first-writer-wins, the 15 s Undo) is built and tested; the flip is
  the owner's, not the app's.
- **The replay baseline** needs the candidate log to answer "does the model beat
  a fixed rule?"; the drift harness is the part that can run today.
- **`noUncheckedIndexedAccess` (Phase 0.6) is not on.** Measured on this tip: `npx tsc --noEmit --noUncheckedIndexedAccess` reports **2,833 errors** across the analytics/tooling surface (`taLibrary.ts` 153, `setupScan.ts` 116, `smcStructure.ts` 111, …). TypeScript has no warning tier for it, so "on as a warning first" cannot be done without a compiler fork or a blanket suppression — both worse than leaving it off. The measurement is the deliverable; turning it on is a separate, large pass.

## 8. The context-window pass (2026-10-20)

Not a plan id. The owner reported a behaviour, in product terms: **when the model
runs many tools or thinks hard, no final answer arrives**, and the row instead
carries `THE PROVIDER STOPPED EARLY: one answer in this run hit the token
ceiling…`. The plan's `O-74`/E-13 made that line truthful; this pass made the
answer arrive. Three causes were found in the code, and one of them turned out to
be a stored-data bug the line was hiding.

| Cause, in the code | What landed | Verified by |
| --- | --- | --- |
| A tool round's output budget was `Math.min(caller, 4096)`, and thinking counts **inside** `max_tokens` on the DeepSeek, GLM, Anthropic and o-family routes. A seat told to decide at `high` (the E-39 default for `tradingDecision`) could spend the whole 4096 mid-thought and return a message with no call and no text; the loop read that as "chose not to call a tool" and ended the turn empty. | `DESK_ROUND_MAX_TOKENS = 8192` (`DeskToolsService.ts:241`), the same room `TASK_BUDGETS.chat` gives the answer, still clamped by a smaller caller budget. | `tests/deskToolThinkingCut.test.ts` — and measured red: setting the constant back to 4096 fails 3 checks |
| Nothing re-asked. An empty round returned `endedWithToolCalls: false` with `finalText: ''`, and the continuation went out at the tier that had just failed. | One re-ask per turn at a stepped-down tier (`stepEffortDown`, now exported from `reasoningControls.ts`), triggered on the wire's own stop signal — `truncated` **or** `finishReason === 'unknown'`, because a gateway that sends no signal has not said it finished. If the whole turn produced nothing, the continuation gets the same step-down plus a harness turn asking for prose. | `tests/deskToolThinkingCut.test.ts` (4 cases) — measured red: disabling the repair fails all four |
| Nothing bounded the outbound array. The desk loop grew its own request every round, and `chatSurfaceTurnMessages` mapped the **whole** stored conversation onto every send. | `src/services/providers/contextCompact.ts` — fit the array to the resolved window: oldest tool payloads to a marked head slice, then old prose, then whole tool rounds (never splitting a `tool_calls` block from its replies, which is what 400s the transcript). Applied at every round and at the continuation, and reported in the transcript through the tool-line channel — including the case where **nothing could be cut** (`CONTEXT FULL: … over a N-token ceiling`), because silence there reads as a healthy request right up to the provider refusal. | `tests/contextCompact.test.ts` (23 cases), `tests/deskToolThinkingCut.test.ts` (14) |
| The window itself was a single optional field the trader could type, defaulting to 65,536 — and `loadProviderConfigs` **dropped it on every app start** while the save path kept writing it. `thinkingCapable`, `jsonSchemaCapable` and both pricing rates were dropped with it. | `src/utils/contextWindow.ts`: user override → a limit the provider stated in a rejection → the window `/models` reported for that model id → the owner's new **1,000,000** default. Discovery now captures per-model windows (`discoverProviderModelCatalog`, stored in `ProviderConfig.modelContextWindows`); the loader preserves every optional field with coercion; `Settings → Providers` shows the number in use and says which evidence produced it. | `tests/contextWindow.test.ts`, `tests/providerConfigService.test.ts` (5 new), `tests/modelCatalogRefresh.test.tsx` (2 new) |
| An optimistic default is only safe if a wrong guess is survivable. | The transport (`sendChatRequest`, `sendChatTurn`, `streamChatRequest`) reads the limit out of a context-length rejection, records it as `measured`, compacts to it and retries **once** — never after a delta has been painted, and not at all when compaction has nothing to cut. A non-window 400 is not retried. | `tests/desktopProviderParity.test.ts` (4 new, over the Electron bridge) |

**Why the default could move to 1M without inflating a prompt.** Every injection
budget is `min(cap, window × fraction)` and both caps already bound at 65,536
(memory 2 %/900 tokens, market packet 10 %/6,000), so the change moves no
injected byte. `tests/contextWindow.test.ts` pins that as a control arm rather
than leaving it as an argument.

### The gates this pass ran, with their own figures

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ok, 0 errors |
| `npm run typecheck:scripts` | ok, 0 errors |
| `npm run lint` | **0 errors / 659 warnings** (cap 659 — the new modules and tests add 0 net) |
| `npm run test` | **4992 tests in 494 files** passed, 0 skipped (184 s idle, 294 s with the dev server up — both green) |
| `npm run build` | ok, entry **1,398.63 kB** — the 1,400 kB ratchet now has **1.37 kB of headroom** |
| `npm run boot-probe` | ok, zero pageerrors, against a `dist/` built in the same sitting |
| `npm run render-probe` | **113 checks, 0 failures**, zero pageerrors |
| `npm run e2e` | 5 passed |
| `npm run skill-approval-probe` | **25/25**, `pageErrors=2` (its known quota signature) |
| `npm run check-flow-doc-anchors` | **299 anchors verified, 0 unattributed**; re-anchored `DeskToolsService.ts` 2159→2232, 3836→3929, 2935→3041, 3123→3222, and the provider-directory census (3 helpers → 4, 5 files → 6) |

### Verified in the running app, not only in jsdom

Driven against `localhost:3000` with the loopback mock provider, which now reports
`context_length: 131072` for its model — the shape OpenRouter, Together, llama.cpp
and vLLM use:

- A provider created in Settings → Providers, discovered, and reloaded shows
  `In use now: 131,072 tokens (reported for this model · 131,072 tokens)`.
  Discovery → storage → resolution → UI, in one path, in the packaged renderer.
- Typing `65536` flips it to `your override · 65,536 … Your entry overrides the
  131,072 it reported`, and **a full page reload still says so**. Before this pass
  the reload lost both fields, because `loadProviderConfigs` rebuilt the row
  without them — that is the stored-data bug, and this is the measurement that
  closes it.
- Clearing the override returns the line to the discovered 131,072, so the
  resolution order is not a unit-test artifact.
- With the window set to `2000`, a third dock question produced
  `CONTEXT WINDOW TOO SMALL: 2,000 tokens cannot hold this prompt plus a reply…`
  in the transcript. No provider request was sent: the prompt plus the output
  budget could not fit, and the turn fails with the measured reason instead of
  sending an impossible `max_tokens` and reporting the provider's opaque 400.
  The output budget is also clamped to what the window has left on turns that
  do fit (~12k windows), so the 8,192-token round no longer overflows by itself.
- `npm run render-probe` (113 checks) re-runs the dock tool round against the same
  mock, so the transport change is covered without a live reasoning provider.

### What this pass does NOT close

- **The 1M default is an assumption, not a measurement.** It is correct for the
  models this owner runs and wrong for a 128K one — which is why the measured
  path exists. A seat that has never reported a window and has never been
  rejected still starts at 1M and learns its real limit on the first overflow,
  at the cost of one retried turn.
- **The estimated token count is an estimate.** `src/utils/tokenEstimate.ts` biases
  high and cannot see the provider's chat template or the tool schemas; that is
  what `WIRE_FRAMING_SAFETY_TOKENS = 4096` is for, and it is a constant, not a
  measurement.
- **Discovery reports a window for some gateways only.** OpenRouter, Together,
  Groq, llama.cpp, vLLM, NVIDIA NIM and Gemini do; OpenAI, DeepSeek and
  Anthropic answer `/models` with ids alone. A `max_tokens` field is
  deliberately not read — that is a request cap, and treating it as a window
  would compact a 128K model into amnesia.
- **No compaction happens while the assumed window holds.** With a 1M default an
  ordinary turn never reaches the ceiling, so the trader sees nothing. That is
  the honest consequence of an optimistic default, and `tests/contextCompact.test.ts`
  pins it so nobody "fixes" it by compacting eagerly.
- **A turn that still cannot fit says so instead of failing quietly**
  (`CONTEXT FULL: … over a N-token ceiling`), but the app does not then summarize
  the dropped history into a digest. Semantic summarization of compacted turns is
  a separate feature and is not built here.

## 9. The register sweep (2026-10-20)

No new plan id. This pass does two things the plan asked for and nobody had
done: it **closes the rows whose defect was still open in the code**, and it
**re-measures the rows whose evidence had gone stale**, including several that
were already fixed by an earlier commit and left marked OPEN. Every closure names
the `file:line` that proves the fix is in the tree at this commit, and every
correction says which figure was wrong and what the measurement was.

**A rule this pass followed, stated because it changed outcomes:** a register row
is a claim about the tree, not a claim about history. Three rows were already
closed by commits that predate them (`O-54` by `c311dd32`, `O-90`/`O-91` by
`91b09eb4`/`8682019d`); two rows' `file:line`s had moved while the statement did
not (`O-75`, `O-59`); and one row was **false in the pessimistic direction**
(`O-72`: the step ladder is not "muted", it has no importer at all, and neither
does the thought reader). Checking before implementing is what kept this pass from
re-building a cost cap the app had already stopped shipping.

### What landed, and where

| Row | The defect | What landed | Verified by |
| --- | --- | --- | --- |
| **O-55**, **O-47** | The A/B lane and the prompt fingerprint had three readers and no writer, so the profile card's control/live split and every `promptVersion` on a journal row were `undefined`. | `src/hooks/useAnalysisPipeline.ts:951` opens the lane per run and `:955` stamps the corpus; both `runStats` builders persist the pair (`:1278-1279`, `:1443-1444`), which is what `src/hooks/useTradeLogging.ts:428-429` copies onto the trade. The fingerprint is `promptCorpusVersion()` in `src/services/infrastructure/PromptOverrideService.ts` — it hashes the EDITED-corpus state, so it is stable across builds and moves the moment the trader edits a prompt. It deliberately does NOT hash `PROMPT_REGISTRY`: importing the registry into the run path grew the entry chunk by 18.7 kB and the bundle ratchet is not a thing to loosen. | `tests/promptOverrideService.test.ts`: the lane's three branches, the fingerprint's stability and variation, and two source pins that the writers are still called from the pipeline |
| **O-60** | The desk mandate ordered the seat to call `get_chart_view`, and the Chat surface's allow-list refuses it — a duty the executor would not honour, which reads to the model as an obligation rather than an absence. | The mandate is composed from the offer set: `deskToolsMandateFor(offered)` (`src/services/analysis/DeskToolsService.ts:1686`), `withDeskToolsSystemPrompt(…, offeredTools)` (`:3979`), the offer list built at `:4087` from `mergedAllowed` before falling back to the definitions. A home with no chart is told there is NO CHART to read here and must cite the candles; a home with no market read at all is told to name no shape. | `tests/deskSystemPrompt.test.ts` — the invariant that every tool the mandate NAMES is a tool this turn can call — plus the updated source assertion in `tests/promptContract.test.ts` |
| **O-62** | The prompt promised a *fresh* packet; the code served an 8-second cache and, on a failed fetch, a bare "packet unavailable". | The fence stamps its own age — `packetAgeNote()` at `src/services/trade/tradeChatContext.ts:90` says `Ns old`, and past a minute `… — STALE: this snapshot predates the last N minute(s); call get_market_packet or get_chart_view for a newer read before you state a price` (into the header at `:128`). A failed fetch writes the `DATA_UNAVAILABLE` sentinel (`:102`) whose text says the state is UNKNOWN rather than missing. The system prompt now claims an age-stamped packet, not a fresh one. | `tests/tradeChatContext.test.ts` (the age, the sentinel, and the prompt's own sentence about it) |
| **O-65** | Nothing near a streaming transcript was a live region, so an arriving answer was never announced. | `role="log" aria-live="polite" aria-busy=…` on both homes' scroll containers — `src/components/trade/TradeChatPanel.tsx:1077`, `src/components/agents/AgentsView.tsx:1346` — each with an `aria-label` naming the conversation. Per-row live regions were rejected deliberately: one per message re-announces the whole transcript on every token. | `tests/tradeChatPanelHarness.test.tsx`, the surface-switch case in `tests/surfaceSwitch.test.tsx` |
| **O-66** | Seven of eighteen dialogs rendered `role="dialog"` with no trap, no `aria-modal`, no restore. | Five modals now trap and are proven by mounting each one and asserting focus lands inside — `AutomationEditorModal`, `ThinkingModal`, `ImageViewerModal`, `NewBotDialog`, `NewGroupDialog` — plus the two the audit missed: the full-screen `LiveMarket` overlay (`src/components/market/LiveMarket.tsx:81`, and NOT when it is the embedded panel) and the update overlay's decidable phase (`src/components/shared/UpdateOverlay.tsx:140`, because `downloading` and `installing` contain nothing focusable and a trap there swallows Tab for minutes). The header's session popover stays a disclosure on purpose — `src/components/shared/Header.tsx:217` writes no `aria-modal` and Escape/outside-click dismiss it — and now carries `aria-controls` on its trigger. | `tests/useFocusTrap.test.tsx`: the five mounts, and a **population** gate that lexes every `.tsx` under `src/components/` plus `src/App.tsx` with the shared `jsxScan` and refuses any element that writes `aria-modal` without carrying the `useFocusTrap()` ref on that same tag. Reach is floored at the 18 measured sites, six named members must be in the set, two planted defects prove both finding branches fire, and a disclosure-only fixture proves it does not over-refuse. |
| **O-53** | Four user-visible strings still named the deleted engine. | The editor's validation error is "Pick the model this run answers with." under a plain "Model" label (`src/components/automation/AutomationEditorModal.tsx:247`, `:508`); the journal's pre-merge badge reads `Ensemble (legacy)` (`src/components/journal/TradeLog.tsx:352`); the monthly card header says "Grade the panel — legacy debate rows only" (`src/components/journal/MonthlyReportCard.tsx:62`) and `src/services/learning/monthlyReport.ts` labels those columns legacy; `moderator` is out of the Settings search keywords. | grep over `src/components/**.tsx` — the two words survive only as code identifiers, in comments, and on these legacy-labelled rows |
| **O-73** | "The desk home, which runs the longest jobs, has no Stop." | It has one, on both homes: `aria-label={busy ? 'Stop' : 'Send'}` at `src/components/trade/panels/ChatComposer.tsx:213` and the `(busy \|\| analysisRunning)` form at `src/components/agents/AgentsView.tsx:1515`. Recorded as verified rather than newly built — the row's premise is retired, and `ChatComposer.tsx:51-54` documents that a Stop which aborts only the chat turn is a lie. | read at the two cited lines |
| **O-54**, **O-90**, **O-91**, **O-92** | Rows the code had already out-fixed. | The cost-cap setting is deleted at both ends (`debateCostCapUsd` has no declaration and no reader; the panel says so at `src/components/settings/SessionUsagePanel.tsx:132`); `surface-census.cjs` measures each surface at its own `ROOTS` entry (`:215`) and Settings at its dialog root; `ui-inspect.cjs` contains no `7` at all and reads the live switch population; the dead default `NavRail` import is gone (`src/App.tsx:129` imports only `AccountRow` and `NAV_RAIL_AUTO_COLLAPSE_PX`, both used — and `NAV_RAIL_EXPANDED_PX` is a third live export, imported at `src/components/agents/AgentsView.tsx:73`). | grep, plus `tests/deadControlsGuard.test.ts:145`, which pins that no `<NavRail` is ever rendered |

### Corrections to the register (the numbers were the point)

- **O-69** — "17 call sites, 0 pass `action=`" was wrong on both halves. Measured
  today: **14** sites, and **1** passes `action=` (the journal's "Nothing is
  classified yet" offers "Show all trades" — `src/components/journal/TradeLog.tsx:724`).
  The prop exists and renders (`src/components/ui/EmptyState.tsx:14`, `:93-101`); what
  is missing is 13 decisions about what each empty state's next action actually
  IS, which is the trader's call, not a sweep.
- **O-71** — 20 `fallback={null}` is now **17**, measured.
- **O-72** — the ladder is not "imported but not mounted". `AnalysisProgress.tsx`
  and `ThinkingModal.tsx` both have **zero** production importers. Recorded as
  worse than the register said, and folded into **E-50**'s orphan census.
- **O-129** — `debatePods.ts` comes off the list (deleted; it is one of the 25
  files `git log --diff-filter=D` names under `src/services/providers/`) and
  `ThinkingModal.tsx` goes on it. Every figure in the row predates the debate
  deletion, the roster deletion and the context-window pass, so the graph must be
  re-run before the E-50 batches are cut.
- **O-75** — `'Logging in 15s'` moved from `:55` to
  `src/hooks/useWatchSideEffects.ts:70`, and `tests/planE18Settlement.test.ts:101`
  pins that exact copy, so the countdown is a tested behavior rather than an
  accident. Still the trader's number to choose.
- **O-59** — the definitions array is now `src/services/analysis/DeskToolsService.ts:871`,
  spanning `:871-1485`, and carries **35** `name:` fields, not 39 (measured by
  brace depth over that span). The ~7,864-token figure is the audit's own estimate
  and has not been re-derived here.
- **`docs/app-flow.md`** — the provider-directory census said "twenty-four files…
  the other fifteen". `git log --diff-filter=D --name-only --format= --
  src/services/providers/` names **25**, of which 9 were provider clients, so the
  sentence now says twenty-five and sixteen and enumerates the sixteen. The
  anchor gate's own census rule caught it; the paragraph is now the recipe's
  output rather than a remembered number.

### The gates this sweep ran, with their own figures

Every exit code below is read from the log's own `*_EXIT=` marker, not from a
pipeline. The first column is the run that measured the sweep tree; the
combined-tree re-run (sweep + E-51 Phase 1) is in §10.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | `TYPECHECK_EXIT=0`, no diagnostics |
| `npm run lint` | **0 errors / 657 warnings** (the ratchet cap is 659, so the pass had to *lower* the count — it went from 659 to 657) |
| `npm run test` | **5028 tests in 494 files**, 0 failed (298 s idle) |
| `npm run check-flow-doc-anchors` | **303 anchors verified, 0 unattributed**; cited-line quality 0/0; providers census **0 findings — git names 25 deleted files, 6 remain** |
| `npm run build` | ok, entry **1367 KiB** by the guard's own `bytes/1024` measurement (ceiling 1400) |
| `npm run boot-probe` | ok, prod bundle boots, trade surface + dock render, zero pageerrors |
| `npm run render-probe` | **113 checks, 0 failures**, zero pageerrors |

Not re-run here, and saying so instead of implying it: `skill-approval-probe`
(drives the approvals inbox, which this sweep does not touch) and
`installer-smoke`. §8 records their last measurements.

## 10. E-51 Phase 1 — the merged model panel, unwired (2026-10-20)

`docs/plan/model-menu-redesign.md` is **untracked work the owner wrote** on
2026-10-20 (all four rulings answered, nothing implemented). This is Phase 1 of
its four, whose whole point is that the panel is extracted and tested with
**no surface wired to it** — the composer, the Chat surface and `ModelPicker`
keep their present controls until Phases 2 and 3 replace them.

| File | What it is |
| --- | --- |
| `src/components/shared/ModelMenu.tsx` | new: the portaled panel. Provider row with the constant `API` badge (ruling D-C) that opens a right-hand provider panel on click **and** hover; the active provider's models only, ready providers only; `Vision` from `isVisionModel`, `free` from `isFreeModelId`, the star toggle, the shared free-only pref, one `Manage providers` row (not the reference's two names for one destination); a six-stop `role="slider"` whose `aria-valuetext` is the tier LABEL, never the index; Escape contained to the innermost panel; roving arrow-key focus with Home/End; focus returns to the trigger. |
| `src/components/shared/effortScale.ts` | new: the ladder moved out of `EffortChip` (`EFFORT_CHOICES`, `effortChoiceOf`, plus `effortIndexOf` / `effortAtIndex` for the slider), re-exported from `EffortChip` so every existing importer is unchanged. One owner, because the trigger will print the tier and the slider will edit it. |
| `src/utils/providerUtils.ts` | `STARRED_MODELS_KEY`, `readStarredModels`, `writeStarredModels` beside the free-only pref — the star list was a `localStorage` literal copied into two components. Same key, same bytes; a ModelChip star still sorts the panel's list. |
| `src/components/shared/ModelChip.tsx` | the star read/write now goes through that owner. No behaviour change. |
| `src/App.tsx` | unchanged. The dead `import ModelPicker` (O-130's G-7, one occurrence, nothing renders it) is **still there on purpose**: `src/App.tsx` is the file the flow docs cite by line number more than any other, and deleting one line near the top invalidates every one of them at once. Phase 2 rewrites this file's composer wiring anyway and re-anchors `docs/app-flow.md` as part of its own gate list, so the import goes out with the pass that can pay for the re-measurement. Verified: removing it here turned `src/App.tsx:2014` into a comment line and the anchor gate said so. |
| `tests/modelMenu.test.tsx` | new: 15 tests, mounting the panel only. |

### The two gates that bound this work, and what they caught

`radiusRamp` and `themeContrast`'s clipped-text rule both went red on the new
file, and both were **right**:

- two `API` badges were written `rounded` — an off-token radius, and that gate
  holds its floor **by name** (`FLOOR_INVENTORY`), so a new entry fails the
  inventory even if the count somehow fit. Now `rounded-control`.
- three `truncate` spans clipped text whose full value was only reachable by
  the ancestor's `title`. The rule wants the clipped element itself to name the
  text. Each span now carries its own `title`.

The ceilings were not moved. `BASELINE = 9` and the clipped-text ceiling of `0`
are both still what they were before this file existed.

### Correctness notes found by reading, not by a red gate

- **The layout effect must not depend on the `anchor` object.** A parent that
  builds its own `DOMRect` each render would re-run the measure every render,
  and `setPos(freshObject)` is an identity change, so it would be an infinite
  loop, not a reposition. The deps are the anchor's three numbers now, and the
  setter returns `prev` unless a coordinate actually moved. The test suite
  cannot see this (it passes a module-level constant), which is exactly why it
  is written down here.
- **`ArrowLeft` was unreachable** behind the `if (providersOpen) return` guard —
  the inner panel could be opened but not backed out of by keyboard. The guard
  now handles Left before returning.
- **The Escape-containment test can fail.** Proved by deleting
  `e.stopPropagation()` from the panel's key handler: the planted document-level
  listener then fires and the test goes red (`1 failed | 14 passed`), and it
  passes again when the line is restored. A containment assertion that cannot
  fail would be documenting nothing.

### Gates

All measured on the final tree (sweep + Phase 1), each read from its own
`*_EXIT=` marker:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ok, 0 errors |
| `npm run typecheck:scripts` / `typecheck:electron` | ok, 0 errors |
| `npm run lint` | **0 errors / 657 warnings** (cap 659) |
| `npm run test` | **5043 tests in 495 files**, 0 failed, 0 skipped (384 s) |
| `npm run build` | ok, entry **1367 KiB** — unchanged, because nothing imports `ModelMenu` yet, so it is not in the startup graph |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | **113 checks, 0 failures** — run against the combined tree, and it is the gate that would have caught a composer regression had Phase 1 accidentally touched one |
| `npm run e2e` | 5 passed |
| `npm run check-flow-doc-anchors` | **303 anchors verified, 0 unattributed**; cited-line quality 0/0 |

**What Phase 1 does NOT do:** no surface changed. `ModelChip`, `EffortChip` and
`ModelPicker` still render where they render today, so the trader sees nothing
different, and `O-130`/`O-68` are **not** closed — the panel is one
implementation until Phase 3 makes `ModelPicker` mount it too.

## 11. E-51 Phase 2 — the composers mount the merged control (2026-10-21)

This is the first commit of the pass that changes what the trader sees. Rulings
D-A (the trigger moves INTO the composer card), D-C (a constant `API` badge) and
D-D (the tier printed on the trigger) land here; D-B's shortcut stays scheduled
for Phase 4 so the key hint is never shown before the chord exists.

| File | What changed |
| --- | --- |
| `src/components/shared/ModelChip.tsx` | rewritten: it is now the trigger AND the anchor. The label reads `Provider · Model · High` (D-D) and the accessible name reads the same three things; the panel body is `ModelMenu`, portaled and anchored to the trigger's rect. The compact form (dock, 384px) truncates; the wide form (Chat surface) does not. |
| `src/components/shared/EffortChip.tsx` | **deleted** (`git rm`). The tier is set on the slider in the model panel; keeping a second control for one value is the defect the proposal names (G-3). Its ladder had already moved to `effortScale.ts`, so nothing else moved with it. |
| `src/components/trade/panels/ChatComposer.tsx` | the footer row under the card is gone; the control sits in the toolbar row inside `data-testid="composer-model-and-send"`, left of send, and `ml-auto` moved from the send button to that pair so send stays bottom-right when the row wraps. The disclaimer keeps its own line. |
| `src/components/agents/AgentsView.tsx` | same move, and the bot rule now travels WITH the control: `modelPicker` is a render prop receiving `{ showEffort }`, because "a bot turn has no Effort section" needs `activeBot`, which only this surface has. `effortPicker` is deleted. |
| `src/App.tsx` | `SessionEffortChip` became `SessionModelChip` (still module-scope, still the only thing that touches `chatStore` on that surface's mount — the latch bug in its comment is why), the injection passes `showEffort` through, and the Chat surface's inline `setSelectedChatModel(v); chatStore.setActiveSoloModel(v)` pair became one `changeChatSoloModel` callback — the two writes the dock's own callback performs, spelled once. |
| `tests/chatEffortDial.test.tsx` | rewritten rather than deleted: the chip's radio-menu tests go (the panel's slider tests live in `tests/modelMenu.test.tsx`), and the five wiring pins that named `EffortChip`/`effortPicker`/`SessionEffortChip` now name the merged control — including `expect(fs.existsSync('src/components/shared/EffortChip.tsx')).toBe(false)`, so the deletion cannot be quietly undone. The transport pins (three wires, one shared rule) are untouched. |
| `tests/agentsSurface.test.tsx` | the injected-picker test now renders through the render prop and asserts the picker lands INSIDE the send pair, and that `showEffort` arrives as a real boolean. |
| `scripts/chip-shot.cjs` | rewritten for the new testids, and it now asserts behaviour rather than only pixels: the trigger must END in a tier word (D-D), starring must move a row to first, and the slider must expose `aria-valuemax=5` and a non-empty `aria-valuetext`. |
| `scripts/render-probe.cjs` | new checks for the move (below). |

### What the new probe checks learned on the way

Two of my own first drafts were **false green**, and both are the bug class this
repo has been bitten by before, so they are written down rather than fixed
silently:

- Every narrowed-width measurement reported `row 0px … send right 0 of card 0`
  and PASSED. Below its breakpoint the Trade surface does not lay the dock out
  at all, so the numbers were a zero-size rectangle, not a fit. A
  `found: false` guard now refuses to grade an unlaid-out composer and says so in
  the detail.
- A "both states measured" check passed while reporting `wrapped + wrapped`,
  because a hidden `display:none` file input contributed a third distinct `top`
  and made the single-line row read as wrapped. Line detection now counts
  VISIBLE children only.
- The plan asked for the claim in "both the wrapped and the unwrapped state", and
  **the unwrapped state is UNMET, not assumed**: the dock's toolbar measures the
  same ~333px at 1100px and 1280px viewports (the column is a chart fraction, not
  a viewport fraction), and a 208px trigger plus a 32px send cannot fit beside
  `+` and `Scan → skills`, so the row always wraps in the dock. The probe asserts
  the two properties that hold in whichever state exists — no horizontal overflow,
  and send right-most AND bottom-most — at the run width and at three narrower
  ones, prints a `NOTE` that the unwrapped state is unmeasurable, and does not
  claim otherwise. (If the dock is ever made genuinely wider, the sweep starts
  reporting a single line on its own.)

### Gates, measured on this tree

| Gate | Result |
| --- | --- |
| `npm run typecheck` / `typecheck:scripts` | ok, 0 errors |
| `npm run lint` | **0 errors / 657 warnings** (cap 659) |
| `npm run test` | **5042 tests in 495 files**, 0 failed, 0 skipped |
| `npm run build` | ok, entry **1374 KiB** (ceiling 1400, stale below 1260) — **+7 KiB, which is the honest cost of Phase 2**: `ModelMenu` was unreachable in Phase 1 and therefore not in the startup graph at all, and now every composer imports it. The ratchet still binds with 26 KiB of headroom, and it was NOT raised. |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | **115 checks, 0 failures**, zero pageerrors (was 113; the two new ones are the composer row at the run width and at 1100px) |
| `npm run probe:chip` | ok against a dev server on :4193 — `trigger label: "B.AI · Auto"`, `model popover top=380 bottom=800 viewport=900 FITS`, `after starring, first row: Kimi k3`, `effort slider stops=5 valuetext=Auto` |
| `npm run check-flow-doc-anchors` | **304 anchors verified, 0 unattributed**; cited-line quality 0/0 |

The anchor count moved 303 → 305 → **304** during this pass, and both moves were
measurements, not drift: Phase 2 shifted `src/App.tsx` by ~16 lines, so the tool
re-resolved 36 citations; re-pointing the html's `:2365` onto the existing
`{surface === 'trade' && (` anchor merged two distinct numbers into one, dropping
the unique count by 1. Two citations that the gate CANNOT see were corrected while
in there: `src/App.tsx:1217` claimed to be `latestChartVerdict(messages)` and is a
group-edit line (the real one is `:1229`), and `:303` claimed to be
`moderatorConfig` (the real one is `:310`). A citation the gate cannot check is
still a claim, and this one was false.

### What Phase 2 does NOT close

`O-130` moves to **in progress**, not closed: `ModelPicker` is still a second
implementation (Settings, the automation editor, the seat picker), so the shared
free-only/star preferences still do not follow the trader everywhere, and `O-68`
keeps its `ModelPicker`/`SymbolPicker`/`SelectMenu` half. The dead
`import ModelPicker` in `src/App.tsx` is still there for the same reason as in Phase 1
— it costs a doc re-anchor, and Phase 3 rewrites that file's picker anyway.
`O-56`/`E-39`'s *default* tier is untouched: this makes the tier visible and
settable beside the model, which is the UI half the proposal claims.

## 12. E-51 Phase 3 — one implementation: the picker mounts the same panel (2026-10-21)

`ModelPicker` is now a trigger. Its two-column hover flyout, its own free-only
checkbox, its own positioner and its own portal are gone; the body is the same
`ModelMenu` the composers mount, so there is one model menu in the app (G-4).
The 625-line file is 200.

What the picker had that the panel did not, and so had to be inherited rather
than merely deleted:

- **The flat cross-provider search.** `ModelMenu` listed only the selected
  provider's models, which is right for a composer and wrong for a box that
  implies "find it wherever it lives". The rows are now keyed by the
  `provider::model` PAIR (`data-testid="model-row-alpha::gpt-4o"`) because the
  same slug on two providers is two choices, and a search hit names its provider
  in WORDS — the old flyout printed the raw provider id there, which is not
  something a trader can read off a list.
- **`disabledValues`.** The panel seat picker greys a model that already holds a
  seat; the row renders `disabled`, and the click is refused rather than silently
  ignored.
- **The discovery feedback word.** `ModelMenu` had an icon-only refresh;
  `ModelPicker` had 'Refreshing…' / 'Updated!'. The panel now takes a
  `refreshState` prop and prints the word while it is not idle, so the icon
  stays quiet in the composer and a Settings user still sees that discovery ran.
- **`mode`.** `provider-model` writes `"p::m"`; `model-only` opens on the
  provider that owns the stored id and writes the bare `"m"` back.
  `provider-only` — declared, never rendered anywhere — is deleted (G-7).
- **One `Manage providers` row**, only when the host can route to Settings. A row
  with no handler is the dead affordance this repo's probes keep catching.
- **`onMouseDownCapture`/`onPointerDownCapture` stopPropagation moved WITH the
  flyout into `ModelMenu`.** This is not cosmetic: the picker sits inside
  `AutomationEditorModal`, whose host closes on any document-level
  outside-mousedown, and the panel is portaled to `document.body` — without the
  guard the modal tears itself down mid-pick.
- **Close on scroll and resize**, ignoring a scroll inside the panel's own list.
  A `fixed` panel that stays put while the page moves under it is detached
  chrome.

**A behaviour deliberately NOT "fixed" while passing through.** The old picker
flagged a stale pick as `· unavailable` when its PROVIDER was not ready, and
said nothing when a qualified pair named a model the catalog did not list. That
asymmetry looks like an oversight and is not: a user-typed custom model id is a
real selection that answers even when `/models` never listed it, so marking it
unavailable would refuse to run a model that works. A test pins the direction
(`does NOT flag a model id the catalog omits but the provider can still serve`)
so the next reader does not "tidy" it into a false alarm.

**A latent bug the rewrite removed.** The old refresh effect returned a cleanup
closure from the `august:model-refresh-end` HANDLER, where nothing reads it, so
the 2 s 'Updated!' timer was never cleared and could flip state on an unmounted
picker. The new effect owns the timer and clears it on unmount.

### Retargeted source guards

Two repo-wide source pins named `ModelPicker` for behaviour that now lives in
`ModelMenu`; both were moved rather than deleted, and one was loosened in the
direction of the property it defends:

- `tests/flyoutMarginSingleSource.test.ts` walks `ModelMenu.tsx` + `SelectMenu.tsx`
  now. Its "neither declares its own" arm asserted the exact alias line
  `const VIEWPORT_MARGIN = FLYOUT_VIEWPORT_MARGIN;`, which is a SPELLING, not the
  rule; it now refuses a local NUMBER and separately requires each file to
  subtract the shared constant, so an import nobody uses still fails.
- `tests/dockChatParity.test.tsx` reads the `text-left` search pin from
  `ModelMenu.tsx`.
- `src/components/shared/flyoutLayout.ts`'s own docblock named `ModelPicker` as one of
  the two positioners; it says `ModelMenu` now. A stale name lies after a move.

### Gates, measured on this tree

| Gate | Result |
| --- | --- |
| `npm run typecheck` / `typecheck:scripts` | ok, 0 errors |
| `npm run lint` | **0 errors / 656 warnings** (cap 659; deleting the flyout removed one warning) |
| `npm run test` | **5053 tests in 495 files**, 0 failed, 0 skipped |
| `npm run build` | ok, entry **1376 KiB** (ceiling 1400) — +2 KiB over Phase 2 |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | **115 checks, 0 failures**, zero pageerrors |

`tests/modelPicker.test.tsx` went 13 → 21 tests: the readiness parity guard is
unchanged in intent (it still asserts against
`providerUtils.isProviderReady`, not a snapshot of its rule), and the added
coverage is exactly what the merge promised — one panel, no second portal, no
second copy of the preferences, and the two value shapes.

## 13. E-51 Phase 4 — the chord, the hint, and the last dead import (2026-10-21)

Ruling D-B asked for `Ctrl+Shift+E` "later", with the hint in the SAME commit as
the binding so a key the trader was told about was never a key nobody bound.
This is that commit, and it closes E-51's four phases.

**What the chord does.** It steps the ACTIVE CHAT SESSION's thinking tier —
`chatStore.setActiveEffort(nextEffortTier(chatStore.getActiveEffort()))`, the
same stored row the slider writes, so the trigger's label moves the instant the
key is pressed and the value the next turn sends cannot disagree with what is on
screen. The ladder wraps (`max → off`), because a one-way ramp would strand the
dial at the top with no way back except opening the panel.

**Why it is guarded, and what the guard is.** `src/components/shared/effortDial.ts`
is a refcount that `ModelChip` raises for as long as it SHOWS the tier, and the
App-level handler asks it before acting. Not a boolean, because both chat homes
can be mounted with one hidden — the surface that unmounts must not switch the
key off for the one still on screen. A panel session never registers (`isPanel`
hides the chip) and a bot turn never registers (`showEffort: false`), so the
chord cannot write a tier that nothing reads back. That is the same class of lie
as an unbound hint, approached from the other side.

**The hint travels with the platform.** `effortShortcutHint(platform)` prints
`⌘⇧E` on macOS and `Ctrl+Shift+E` elsewhere, beside the `EFFORT` label and inside
the slider's accessible name (`docs/ui-doctrine.md:48` asks for the second, not
just the first), so a screen-reader user hears the chord that the sighted user
reads off a keycap.

**G-7, at last.** The dead `import ModelPicker` at `src/App.tsx:82` is gone. It was
deferred out of Phases 1–3 for the reason in §10 and §12 — one line near the top
of `src/App.tsx` invalidates every line-anchored citation the flow docs hold against
that file — and this phase pays for it deliberately, because Phase 4's own gate
list is the doc re-anchor. 28 tokens re-resolved from the gate's report, cited-line
quality back to 0 comment landings and 0 symbol misses, and the unique-anchor
count holds at **304**.

### What the gates can and cannot see

The chord is App-level keyboard handling, and mounting `App` in jsdom is not on
offer, so the pinned evidence is:

- `tests/chatEffortDial.test.tsx` — 7 new tests. `nextEffortTier` walks the
  ladder and wraps; `effortShortcutHint` names the right keycap per platform;
  the hint is rendered beside the label AND inside `aria-label`; the refcount
  rises while a dial is on screen, stays down for a bot turn, and falls back to
  zero on unmount (twice, because a double release must not sink the count).
- The same file pins the BINDING and its GUARD as one condition in `src/App.tsx`
  (`… && e.shiftKey && !e.altKey && effortDialUp() && e.key.toLowerCase() === 'e'`)
  and the write as one call into `chatStore`. A chord bound but unguarded, or
  guarded but unbound, fails that pin.
- `npm run render-probe` presses the real key in a real browser and requires the
  dock's trigger label to move — `"Mock · Auto" -> "Mock · Low"` — and then
  presses it six times and requires the label to be back where it started, which
  is the wrap, not a ramp. That is the only gate that walks the whole path
  (keydown → guard → store → subscription → label).

### Gates, measured on this tree

| Gate | Result |
| --- | --- |
| `npm run typecheck` / `typecheck:scripts` / `typecheck:electron` | ok, 0 errors |
| `npm run lint` | **0 errors / 655 warnings** (cap 659; the deleted dead import took one with it) |
| `npm run test` | **5060 tests in 495 files**, 0 failed, 0 skipped |
| `npm run build` | ok, entry **1376 KiB** — unchanged from Phase 3 |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | **117 checks, 0 failures**, zero pageerrors (was 115: the chord and its wrap) |
| `npm run e2e` | 5 passed |
| `npm run check-flow-doc-anchors` | **304 anchors verified, 0 unattributed**, cited-line quality 0/0 |

**Honest limit:** nothing exercises the chord against a bot turn or a panel
session in a browser. Those states are covered by the registration rule (no
chip, no count, no chord) and by the `showEffort: false` unit test, not by a
keystroke.

## 14. The R:R and cost rows — 12 closed, 2 copies actually fixed (2026-10-21)

The owner asked to keep implementing. The next cluster on the plan's own order is
Phase 2.2 (one R:R) and 2.3 (the cost model). **Verifying before building turned
that into a different job than the register advertised**, and the difference is
the point of this section.

**`O-01`, `O-02`, `O-05`, `O-07`, `O-19`, `O-20`, `O-22`, `O-27` were already
fixed** — E-02 and E-03 landed in an earlier pass with their own suites
(`tests/planE02.test.ts`, `tests/planE03.test.ts`, `tests/proposalGate.test.ts`)
and the rows simply never moved. `O-19`'s own grep recipe
(`takerFee|makerFee|feeRate|commission|costBps`) returned **0 files** when the
row was written and returns `src/utils/netRiskReward.ts` now. Had I implemented
"the cost model" from the register instead of checking, this pass would have
built a second one — the exact defect class the plan's §Phase 0.2 warns about.

**Two copies were genuinely live, and they are fixed:**

- `O-03` — the canvas `measured_move` label printed its own `reward/risk`.
  It now measures with `plannedRiskReward` and prints through `fmtRiskReward`
  (`src/services/trade/chartDrawings.ts:619`), so a drawn level and the card cannot
  quote different ratios for one ticket once a ladder is out of order.
- `O-04` — the pattern memory estimated a win from `analysis.takeProfit[0]`,
  which is **array order**. It now prefers a corrected exit (what filled) and
  otherwise takes `nearestTargetPrice`
  (`src/services/learning/PatternMemorySynthesisService.ts:275`). Four new tests,
  one of which is a parity pin against `plannedRiskReward` for the same plan.

**A second defect fell out of the `O-04` fix, and it is the better find.** The
old code accepted a target sitting exactly ON the entry as a real reward, so a
"win" with `takeProfit[0] === entry` booked **+0.00R** — a win that earned
nothing entered the pattern memory as a flat outcome. The canonical rule refuses
a zero-distance target as "no reward", so the estimate now falls through to the
1.5R default like any plan with nothing to measure. That behaviour is pinned by
its own test (`falls back to the 1.5R estimate only when no target is usable`),
which goes red on the old code — as do the other three, proved by reverting the
one line in the tree (`expected 3 to be 1.4`).

**Two rows are re-scoped rather than closed, and the reason is recorded.**
`O-06` ("make the gate refuse, not just cap") is half-true now: a refusal was
built, but in `proposalGate` — the path a presented trade actually takes — while
`runValidationGate` still has zero production importers. Asking for THE gate to
refuse is the E-02a/E-02b ruling, not a cleanup. `O-21` keeps its 150 %
extended-stop rule as the unvalidated policy it is; what E-03 changed is that
any breakeven quoted against it must now be computed net, so the row's 59.3 %
figure is stale arithmetic rather than a live bug.

### Gates

Every one measured on this tree, read from its own `*_EXIT=` marker:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ok, 0 errors |
| `npm run lint` | **0 errors / 655 warnings** — unchanged from Phase 4, so the two fixes added no debt |
| `npm run test` | **5065 tests in 495 files**, 0 failed, 0 skipped (5 more than Phase 4: the four `calculatePnlR` cases and the drawing-label case) |
| `npm run build` | ok, entry **1376 KiB** — unchanged; `chartDrawings` reached `src/utils/riskReward` through a module already in the graph |
| `npm run boot-probe` | ok, zero pageerrors |
| `npm run render-probe` | **117 checks, 0 failures**, zero pageerrors |
| `npm run check-flow-doc-anchors` | ok, 304 anchors verified, 0 unattributed, cited-line quality 0/0 |

---

## 15. E-52 Phase 1 — the status line names the activity (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gaps **G-1**, **G-2**.

The turn's status line said that work happened, not what work: a turn read
"Analyzing · 25s" whatever the desk was doing, and the one line that could have
said more was taken by a rotating trader tip.

**What landed.** `src/utils/turnStatus.ts` and `src/utils/toolKinds.ts` are new: the
**one** reader of the digest grammar the desk writes ("calling order book…" /
"order book · detail") and the **one** vocabulary the desk's tools are named
in. The running row now names the activity ("Reading the order book · 12s"),
derived from the last tool's own line — ruling **R-A**: no model call, no
prompt change, because the app already writes the fact. The rotating tip left
the running row entirely; its only home is now the thinking placeholder.

**The map is keyed by the tool's HUMAN LABEL, not its name** — the transcript
never carries a name — and `tests/turnStatus.test.ts` measures the map against
the desk service's own tool list, so a new tool cannot slip through unlabelled.
An unknown tool keeps its own label: never guess a verb for it.

**Gates.** `typecheck` ok · `vitest` 5100 in 497 · `lint` 0 errors / 656
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 304 anchors, 0 unattributed.

## 16. E-52 Phase 2 — the tier lands on the answer (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gaps **G-4**, **G-17**. **Ruling R-B** (the tier lands on the answer):
yes.

**What landed.** `src/types/provider.ts` now owns `ReasoningEffort` — the wire
vocabulary — because a `Message` and a stored chat entry both carry the tier
that produced them, and neither may depend on a service. The tier a turn ran
under is resolved **once** (`resolveComposerEffort`), rides out of the executor
on the outcome (`src/services/trade/toolTurn.ts`), and is written onto the run and
the entry. The answer's row carries a `ThinkingTierChip` — a muted mark, not a
control, labelled from the one ladder (`src/components/shared/effortScale.ts`).

**The dead lane is gone.** `Message.reasoningProcesses` — a field the deleted
debate engine filled and nothing has written since — is removed from the type,
and the legacy lane is folded into the live one through a single seam
(`src/utils/traceText.ts`). `extractModeratorThinking` had no production callers
and is deleted rather than left as a second reader.

**Gates.** `typecheck` ok · `vitest` 5100 in 497 · `lint` 0 errors / 656
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 304 anchors, 0 unattributed.

## 17. E-52 Phase 3 — a step has a kind, and there is one disclosure (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gaps **G-6**, **G-7**, **G-14**.

**What landed.** Every step wore the same wrench, so a READ and a WRITE looked
identical. Each step now carries its kind's mark and names the kind to a screen
reader; the settled row headlines the work in typed counts ("3 reads, 1
search"). The tool output opens onto a headed block: "Output" plus a language
chip **derived from the bytes**, so a JSON blob says it is JSON before the
trader reads a line of it.

**A real miscount died here.** The old label read "Ran N commands", and N
counted transcript LINES — the desk writes **two** lines per call (the call
and its result), so every number the trader was told was double. The pairing
moved to `src/utils/turnStatus.ts`, where the grammar already lived, so one paired
row is one call.

**One disclosure.** `src/components/shared/Disclosure.tsx` is new and it is the
NATIVE one: the thinking row, the tool-output expander and the automation
card's reasoning all render through it. The card's used to be a `<button>`
plus a grid-collapse `<div>` — a second mechanism for the same kind of thing,
and the older of the two.

**Gates.** `typecheck` ok · `vitest` 5115 in 498 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 304 anchors, 0 unattributed.

## 18. E-52 Phase 4 — the tool trail works in both homes (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gaps **G-8**, **G-9**, **G-10**, **G-18**.

**The defect was a shape, not a writer.** `Message.liveToolEvents` is a
newline-**joined** string — one entry for the whole turn. A reader that took it
for a list drew ONE row holding every line, so the Chat surface's call/result
pairing never happened and its rows never expanded. Both readers now split it.

**What landed.** `Message.toolEvents` and `Message.toolIds` carry the **trail**
and the payload ids as lists, one entry per line, in the order the desk called
the tools. The Chat surface now records the id it was already saving: before
this, the payload was written and nothing could find it again — an expander
that opens onto nothing. The live feed stays what it is: the capped feed a
filling bubble shows.

`docs/app-flow.md` row 40 claimed the reasoning deltas go to
`saveThinkingBatch`. Neither `chatTurnRunner` nor `useAnalysisPipeline` does —
the trace rides on the row, and `saveThinkingBatch` is the restore/migration
path. The row now says so.

**Gates.** `typecheck` ok · `vitest` 5124 in 499 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed.

## 19. E-52 Phase 5 — one way back to the newest row, in both homes (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gap **G-11**.

The Chart AI dock had no jump-to-latest at all: a trader reading up the
transcript had no way to return to the answer that was still arriving, while
the Chat surface had a pill. So the control moved into ONE component
(`src/components/shared/JumpToLatestFab.tsx`) and both surfaces mount it.

**The ring is INDETERMINATE, by ruling R-E.** A desk turn has no denominator
anyone could honestly draw — the model may call three tools or forty — so an
arc claiming "60 % done" would be a number the app invented. The ring says
"the desk is working" and nothing more.

`JUMP_AWAY_PX` is the ONE distance at which the transcript stops following, and
both homes read it: one home must not yank a reader the other one offered a
button for. The Chat surface's transcript now stops following too — it snapped
to the bottom on every message, so a streaming answer carried the row the
trader was reading off the screen.

**Gates.** `typecheck` ok · `vitest` 5130 in 500 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed.

## 20. E-52 Phase 6 — the launch list says what each agent is for (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gap **G-13**. **Ruling R-C** (build the launch list): yes — and last,
because it needs the step kinds and the status line to be worth anything.

**What landed.** A bot's row showed its name and the last thing it said, so
two agents were two names with no way to tell which was the macro reader and
which was the risk one. The row now says what the agent is FOR — its title, or
the first line of its description — because the role is what you choose by.

**The orphan is closed.** `src/components/analysis/ThinkingModal.tsx` had a focus
trap, an `aria-modal`, a test and **no importer anywhere in the app**: a modal
nobody had ever opened, reading as if the app had one. It is now
`src/components/shared/DetailModal.tsx` — the one full-detail reader — and the
agents surface mounts it for the agent's card: what it is for, how it thinks
(model, notebook, skills), its standing instructions, and the trace of its last
turn.

It is a **READER**. The card offers no way to edit the agent, because editing
stays where the editor already is: a reader that also edits is two editors,
and the two would drift.

**Gates.** `typecheck` ok · `vitest` 5137 in 501 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed.

## 21. E-52 Phase 7 — the catalogue of what the desk can call (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**,
and gap **G-16**.

Settings named **six** of the desk's forty tools; the other thirty-four were
invisible, and the ones nobody names are exactly the ones that write. The
catalogue now lists every tool, grouped by the kind the transcript's rows
wear, each with the name the transcript shows, the name the tool is actually
called, and what it does. It is built from the desk service's OWN list, so a
tool added without appearing there fails the suite.

It is a **reader**: the allow-lists are code, not preferences, so a per-tool
switch would be a promise the app does not keep. The switch above it is the
only control, and the catalogue says what that switch turns on.

The kind marks moved to `src/components/shared/toolKindIcons.tsx`, so the
catalogue and the transcript's rows draw the SAME mark for the same kind. The
Settings' "Advanced" section now uses the shared disclosure too: one
mechanism, one keyboard behaviour.

**Gates.** `typecheck` ok · `vitest` 5144 in 502 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed.

## 22. E-52 Phase 8 — the plan corpus (2026-10-21)

**Proposal:** `docs/plan/transcript-redesign.md` (E-52). **Covers:** **O-131**.

The proposal itself (`docs/plan/transcript-redesign.md`), the register row
(**O-131**), the index row in `docs/plan/README.md`, and this record.

**What the eight phases do NOT close** is stated in the proposal's §3 and is
not re-stated here: **G-3** (partly), **G-5**, **G-12**, **G-15** stay open,
**R-D** (the file/artifact viewer) is deferred by ruling, and **O-56 / E-39**
(the default tier) is untouched.

**Gates.** `check-flow-doc-anchors` 306 anchors, 0 unattributed, cited-line
quality 0/0 · `lint` 0 errors / 655 warnings · the census in `AGENTS.md`
restated to **5144 tests in 502 files** and re-measured by the gate.
## 23. E-53 — the wire audit: what the provider was actually asked (2026-10-21)

**Proposal:** `docs/plan/wire-audit.md` (E-53). **Covers:** **O-132**, and
**G-5** and the actionable half of **G-3** from E-52.

It was the owner's question after E-52 landed — *"what should we do to the one
you did not close?"* — and the answer turned out to be that **the data already
existed**. The transport has always decided, per request, which capability
route it applied (an Anthropic thinking block, a Gemini thinking config, an
OpenAI effort knob) and has always said why when it applied none ("model id
not recognized as thinking-capable", "maxTokens below the 1024 thinking floor",
"jsonMode excludes thinking"). It emitted that decision on every call, through
`onWireAudit` — and **nothing collected it**: the pipeline declared the prop
and supplied it to no one.

**What landed.**

- `src/types/provider.ts` now owns `WireAuditEntry` and `WireAuditRoute` — the
  wire vocabulary, beside `ReasoningEffort`. `reasoningControls.ts`
  RE-EXPORTS them, so every existing import keeps working and the shape lives
  in one place: the service owns the DECISION, the type owns the vocabulary,
  and a `Message` may carry the fact without depending on a service.
- The turn collects the audit PER CALL — the way it collects usage — and it
  rides out on the outcome beside the tier. One return, every path shares.
- Both homes write it (the dock's settle, the pipeline's settled `Message`)
  and both read it from the same field, so they cannot disagree about one
  turn.
- `src/components/shared/WireAuditRow.tsx` draws it: a turn with no trace says
  WHY, in the transport's own words; a turn with a trace shows the route that
  was applied, and the disclosure lists every call the turn made.

**Where it stays quiet, on purpose.** Inside the folded work card when the
turn did work — the card folds itself shut the moment the answer lands. On
its own line ONLY in the case silence misleads: a settled turn with no trace
AND no route applied. And a STREAMING turn is never said to have no trace:
the trace may still be on its way, and claiming otherwise is a lie the trader
would act on.

**What this does NOT close.** The other half of **G-3** (a trace the provider
was asked for and never returned), **G-12** (a long bot turn is a wall), and
**G-15** (per-provider thinking joined flat — a row-model question, not a UI
one: the traces are already a map, but the desk's tool markers are interleaved
into the joined text and the tool rows are matched positionally).

**Gates.** `typecheck` ok · `vitest` 5156 in 503 · `lint` 0 errors / 655
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed, cited-line quality 0/0.
## 24. E-54 — The reference's voice: the answer is prose, and the row stops shouting (2026-10-21)

**Proposal:** `docs/plan/reference-voice.md` (E-54). **Covers:** **O-133**.

It was the owner's report after E-52 landed — *"the current UI is nowhere near
similar to the reference image… the chart ai still look the same and even the
chat surface"* — and it was true: **not one of E-52's eighteen gaps was about
the face of the thing.** The transcript said the right things and wore the
same chrome as before.

**What the reference does, and August did not:**

- The answer is a **serif prose column** — a reading face, not the
  interface's sans. Every answer in the reference set is.
- **Nothing is stamped above a message.** The reference identifies a turn by
  the turn; August stamped every row — user rows included — with an uppercase
  monospace label, and printed the time **twice** (in the stamp and in the
  row's own action row).
- The work says it is **running**, in the app's running hue: the reference's
  activity dots are warm, August's were grey.
- And there was **no one home** for any of it: the Chat surface and the
  Chart AI dock each rendered their own row, which is how the two drifted
  apart in the first place.

**What landed.**

- `src/components/shared/AnswerBody.tsx` (new) is the **ONE home for the answer's
  voice**, and both conversation surfaces mount it. The model's answer is
  prose and wears the serif; the trader's own message stays in the UI sans —
  in the reference the human's bubble is interface, not prose.
- The row **stopped shouting**: the seat is named by a quiet dot and a name,
  and the time moved out of the label into the action row, where it was
  already printed and where the reference puts it.
- The running dots are **warm** (the app's running hue is amber).
- `FadingText` now **adds** the caller's class to the base rules instead of
  replacing them, so a caller can say "this answer is serif" without losing
  the size and the paragraph rhythm every answer shares.
- `docs/ui-doctrine.md` records the amendment in words: the answer IS a
  display moment. The boundary is written down too — the trader's words, the
  work card, the chips and the composer stay in the UI sans.

**What this does NOT close.** The Chart AI dock's empty state (the reference
set has none to copy); the work card's interior (the reference's is a
hairline-separated list of steps); a **text** serif (the app's DM Serif Text
is a display face with one weight, so a bold level is a synthetic bold — a
font decision, not a styling tweak); and E-52's **G-12** and **G-15**.

**Gates.** `typecheck` ok · `vitest` 5174 in 505 · `lint` 0 errors / 656
warnings · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed, cited-line quality 0/0.
## 25. E-55 — The reference's other four surfaces: the work card, the skills, the memory, and the tools (2026-10-21)

**Proposal:** `docs/plan/reference-surfaces.md` (E-55). **Covers:** **O-134**.

E-54 answered the half of the owner's report that was about the ANSWER. This
pass answers the other half — the furniture around it — using the owner's
second reference set: nineteen Claude frames (the Customize → Skills panel, the
Settings → Memory panel, and ten frames of a chat surface doing real work).

**The work card.** The reference draws the work as a **bare line with the card
below it**. August had the card AROUND the line, so a collapsed turn was a
little box with a sentence in it, and the steps inside were boxes inside a
box. The border and the fill moved to the line's **open body**; the steps
inside are hairline-separated **rows**; the side-effect rows keep their own
card, because in the reference a "Presented 2 files" card is a separate card
below the work. Every step that opens carries a **chevron**, and an
**interrupted run is a card** with the two ways out as raised chips.

**The skills catalogue.** The reference's catalogue is a **two-column grid of
cards** — a coloured icon tile, the name, a one-line truncated description,
the availability mark — and August's catalogue is now that. The mark is the
honest part: **check** for a rule that reaches a seat, **pause** for one the
idle sweep suspended, **ban** for one switched off or retired, all derived from
`skillEnabledFlag` and never re-derived. The tile's colour follows the STATE
(emerald / amber / zinc) instead of the kind, which used to paint a rule that
never traded in rose — and rose means loss in this theme. The reference's
duplicated list (the same skill under "Installed" AND under its plugin) is not
reproduced: August has no plugins, so the shipped shelf gets the "System" badge
on its own category row, and nothing is printed twice. The gear is hidden
because there is no skills settings screen to open.

**The memory surfaces.** The reference's list is three columns — label, what it
says, when it was written — hairline-separated, the selected row raised with
the pencil and the trash on it; the detail is a read with a back link, a Delete
chip, and "Last updated / Summary / Details". August's memory list was a grid
of cards with a date badge in the corner, and its detail was a form. Both are
now the reference's shape, and the notebook browser, the Settings → Memory tab
and the assistant-memory card were moved onto the same three-column grammar so
the memory area has one row shape instead of three.

**The face, corrected.** E-54 set the answer in DM Serif Text — the app's only
serif — and that was right about the FACE and wrong about the TYPE. DM Serif
Text is a display face: **one weight**, no italic, so every bold level in a
long analysis was a *synthetic* bold, a smear the browser fakes by thickening
the stems. The reference's answer face is a TEXT serif. The app now has **two
serifs, two jobs**: DM Serif Text stays the hero and brand face
(`font-serif`), and **Newsreader** (`font-reading`) is the reading face the
answer is set in. The doctrine records the rule and the reason.

**Deliberately not matched** (all in the proposal): the reference's icon-only
action row (August's is labelled and carries the thinking tier), the coloured
inline-code chip (August's is the neutral zinc pill the doctrine asks for), a
"Presented 2 files" card and a web-search results card (features, not styling),
and the empty chat state's greeting (a copy decision).

**Gates.** `typecheck` ok · `vitest` 5204 in 508 · `lint` 0 errors / 655
warnings (cap 659) · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 306 anchors, 0 unattributed, cited-line quality 0/0 ·
`radiusRamp` ok, with the CSS radius census restated for the work card's
token radius and the floor narrowed by one.
## 26. E-56 — The quiet pass: the rail, the dock and the chart area stop shouting (2026-10-21)

**Proposal:** `docs/plan/quiet-voice.md` (E-56). **Covers:** **O-135**.

The owner's third reference pass named the **chart surface** and the **sidebar
in the chat surface** — and asked how the skills and the memory are formatted
now. Looking at the two side by side in a browser, the gap was not layout or
colour. It was **volume**.

**The rail (Q-1, Q-2, Q-3).** The section headings were uppercase and
letter-spaced; they are now sentence case, small and muted, the way the
reference's "Pinned" and "Chats and tasks" are. The Chats | Bots tab strip is
quiet too. A conversation's title is **not a headline** any more (the reference
lists them in a regular weight). A row's glyph is the reference's **plain
mark**, not a ring around every row — the state still reads, because the
working row's mark is amber and the active row's is bright. The dock's own
prose labels were quietened the same way: it had been printing a whole
**sentence** in uppercase letter-spacing, and the dock's name was set as a
headline.

**The chart area (the chrome pass).** The reference's window is a flat page:
sections separated by hairlines, flat controls, a control's state carried by
its colour rather than a frame. August's chart area had a fill and a border on
every surface. The market row is now a **title bar** (the instrument is the
reference's title and caret), the readout strip is hairlines only, the order
book is a **section** of the page with one `border-l`, the drawing rail is the
page colour, and the book toggle / Screener / Pinned / ƒSMA / the symbol
trigger are flat controls at one icon size. The seam between the chart and the
dock is a **hairline** — the shell's `RightPanel` drag handle had a fill and a
border on both sides, and no longer matched the flat half beside it. The
level-accuracy badge's percentage gained `tabular-nums`: every numeric readout
in this app is mono tabular, and that one was not.

**The judgement call.** The readout row's UPPERCASE data labels stay. That is
the app's deliberate data-density rule, not drift — the order book's own
PRICE/SIZE/TOTAL header is the same family — and the reference's sentence-case
labels are *prose* headings, a different role from a figure's caption. So the
line was drawn **by role**: navigation, section and chip labels are sentence
case; data-readout labels keep the app's rule. Both halves are pinned, so a
future "make it all sentence case" sweep cannot half-apply it.

**The memory vocabulary came home.** The list's date column and its section
headings are vocabulary, and they were living in a component — with the
Settings card importing them **from that component**. They now live in
`src/services/learning/memoryTopics.ts`, beside the derivation they belong to, and
both surfaces read them from there.

**Gates.** `typecheck` ok · `vitest` 5240 in 510 · `lint` 0 errors / 655
warnings (cap 659 — and the doctrine's own stale `--max-warnings 889` was
corrected to the real cap) · `build` ok · `render-probe` ok, zero pageerrors ·
`check-flow-doc-anchors` 375 anchors, 0 unattributed, cited-line quality 0/0.
## 27. E-57 §2 — the harness-lesson store stopped claiming a reader it did not have (2026-10-21)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Covers:** **O-136**, and the register
corrections of §8a landed first as `dd0af735`.

Two external reviews were re-verified against HEAD before anything was built. Four of their
headline claims were false (`beginPromptLane` does have a caller; human sends do fetch market data
in the dock; `ticketSize.ts` has three importers; pre-trade validation is not purely structural),
and two of their remedies would have broken live paths. The one this section lands is the store
that said "read by roster build, reasoningControls, and the run-snapshot assembler" while the only
remaining caller of either of its readers was a test.

**§8a — the census, re-measured, not re-remembered.** `O-129` named thirteen unreachable modules.
Re-run with a scan that reads static `from`, `export … from` AND `await import(…)` — the first
pass that forgot the dynamic form called a live module dead — the figure is **ten**: nine with no
importer of any kind, plus `EntryTimingService.ts`, whose sole importer is the orphaned
`TradeValidationGate.ts:49`. Four of the thirteen were never orphans, and the row now says which
and why. The graph's 521/492/29 figures stay **unre-run** and the row says so, because no
reachability script exists in `scripts/`. `docs/app-flow.md`'s sentence claiming the A/B lane was
starved is corrected to what is actually broken: a process-global `controlLane`, and a dock that
resolves no overrides at all.

**§2 — the deletion.** `formatHarnessNotesBlock` and `lessonsForClass` are gone from
`src/services/learning/harnessLessons.ts`. The header now names the store's two real readers —
`registerWireRoutePins` (`harnessLessons.ts:142` → `reasoningControls.ts:216`), a live read that
pins a provider class to thinking-off, and `HarnessLessonsBrowser`, a human surface — and states
that there is no prompt reader. **The reviews' recommended remedy was rejected:** deleting the
store, as both suggested, would have silently broken the wire audit.

**The doctrine outlived the function.** `lessonsForClass` was the only thing testing that a lesson
is scoped by CAPABILITY CLASS and that `provider` is provenance, never scope. That assertion moved
into `tests/harnessLessons.test.ts` against the stored shape before the accessor went, so the
deletion cost no coverage — the test is now `a lesson is scoped by CAPABILITY CLASS, and its
provider is provenance only`.

**The guard, and the mistake it caught.** `tests/deadControlsGuard.test.ts` pins both directions.
Its first version asserted the identifiers must not appear in the file at all — and failed on this
commit's own header comment, which names the deleted functions to explain why they went. That was
the wrong rule: a repo that documents deletions by name (the dated deletion ledger exists for
exactly that) must not be forbidden from saying so. The rule is now per line and per CODE line —
an identifier may appear in prose; it may not appear in a declaration, an import or a call — with a
planted control proving the scan bites on a real call and stays quiet on a comment.

**Gates.** `typecheck` ok · `vitest` **5244 in 510** (was 5240: +5 in the guard, −1 by folding two
lesson tests into one that pins the same doctrine) · `lint` 0 errors / **655** warnings under the
659 cap — the cap is NOT lowered here, because §26 already measured 655 before this change, so the
headroom is not attributable to it · `check-flow-doc-anchors` **377** anchors, 0 unattributed,
cited-line quality 0/0, 20/20 reach controls, 0 of 6 AGENTS.md arms failed. The count moved 375 →
378 → 377 across these two commits — up when §8a added citations, down when §2 deleted the citation
to the removed `formatHarnessNotesBlock` — and both mirrors restate it on every pass, because a
gate that measures the working tree will happily ship a doc quoting yesterday's figure.

**What this does NOT close.** Whether a wire lesson SHOULD reach a prompt at all is an owner
ruling, not a code question, and the header says so instead of silently deciding. Six of E-57's
eight items are still OPEN: **§7** the unasserted chart levels (O-117), **§4** the dock's
prose-then-failure turn, **§3** the per-run lane and the corpus filter, **§5** enforcing the R:R
floor and ATR bands in the live gate, **§6** the automation run record and the failure breaker, and
**§1** the closed-trade reflection that ruling (a) authorises. Also left as found, and reported
rather than quietly edited: `docs/plan/full-audit.md:6756` and `:6757` carry the **D-24** decision
row twice, verbatim.

## 28. E-57 §7 — the Entry/Stop/Target lines the trader stops out at are now a gate (2026-10-21)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Closes:** **O-117** for the plan overlay.

O-117 had sat open because the honest answer to "is the drawn level asserted?" was no:
`scripts/render-probe.cjs` never named these lines, and the chart's own test suite stopped at the
data layer. The mapping from a settled plan to a price on the canvas — the one visual thing a
trader sizes a position against — was unwatched.

**Why the existing recorder could not be reused.** `tradingChartChatLevels.test.tsx` spies on
`series.createPriceLine()`, which is how the dock's key-level cards paint. The verdict overlay uses
a different mechanism entirely: `chart.addSeries(LineSeries, opts)` plus a two-point `setData()`
across the loaded window (`src/components/trade/TradingChart.tsx:628-645`). A mock that records
price lines is blind to it by construction, so this file adds a recorder for added SERIES, keyed by
the series definition it was created from, capturing both the options and the prices fed to it.

**What is asserted.** Four lines at `[100000, 98000, 104000, 108000]` in Entry→Stop→TP1→TP2 order;
sky `#399ef7` for the entry with `lineStyle: 0`, rose `#f75d5f` and green `#07b56a` dashed with
`lineStyle: 2`; each line spanning the whole window rather than a single floating point; an ETH plan
on a BTC chart drawing nothing; a coin switch RETIRING the four lines instead of stranding them;
and a re-presented plan replacing its stop rather than stacking a second one, which is the failure
mode that leaves two stops on one chart.

**The fixture is the app's own builder.** `buildProposedTradeAnalysis(proposal(...))` — the same
object the card, the gate and the journal read — so the test cannot drift from the plan shape the
way a hand-typed `TradeAnalysis` literal would. (The first draft of this fixture invented an `id`
and a `thesis` and lower-cased `direction`; `TradeProposal` has neither field and spells it
`'Long'`. Caught by reading the interface rather than guessing it.)

**Proved red, not merely green.** With the product temporarily mutated — `entry` and `sl` swapped
in `src/services/trade/chartData.ts:70,72` — 3 of the 5 cases failed, then all 5 passed again once the
file was restored. A test that has never been observed to fail is an assertion about the mock.

**The mock caught two of its own bugs first.** `removeSeries` looked up an entry by a `series`
property that was never set, and retired series stayed in `drawn`, so "the overlay disappeared on a
coin switch" would have passed vacuously against a chart that had never drawn anything. Both fixed,
and the coin-switch case now asserts the four lines EXIST before it asserts they are gone.

**Gates.** `typecheck` ok · `vitest` **5249 in 511** (+5, one new file) · `lint` 0 errors / 655
warnings under the 659 cap · `check-flow-doc-anchors` ok with the AGENTS.md census restated to
5249/511 and the new file named in the census sentence, as the convention requires.

**What this does NOT close.** The shapes a trader draws by hand, and the shapes `mark_trade_levels`
writes into `src/services/trade/chartDrawings.ts`, reach the canvas through the drawing overlay rather
than this effect; they remain asserted at the data level only (`tests/chartDrawings.test.ts:200`,
`tests/drawingGeometry.test.ts`), not as drawn pixels. `render-probe` gained no new level assertion
in this pass. §4, §3, §5 and §6 landed afterwards, in §29–§32; §1 landed as
`src/services/learning/settlementReflection.ts`, awaited from `src/hooks/useTradeLogging.ts:525`.
Nothing in E-57 remains open.

## 29. E-57 §4 — a failed turn is never a finished answer, in either home (2026-10-22)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Closes:** **O-137**. **Surfaced:** **O-138**.

The dock gated its failure stamp on the entry having no text. A turn that streamed
"Long BTC above 65,000, stop 64,200, target…" and then died therefore kept the half-sentence
looking like finished advice, and the part that never arrived was precisely the invalidation and
the size. The Chat surface had no such bug — it appends its own system row — so the two homes
rendered the same failed turn as different facts.

**No new state.** `StoredChatEntry` already carries `interrupted` (`src/services/trade/chatSessions.ts:103`)
and `sanitizeEntry` spreads the entry, so it persists without a migration and without a fourth
status a reader would have to disambiguate. The stamp is now unconditional and adds
`interrupted` when prose exists; `ChatTranscriptList` reserves `ChatFailureRow` for
`error && !e.text`, and a prose-plus-failure row keeps its answer and carries the provider's
reason INSIDE the one "Run stopped" card (`InterruptedRunNotice` gained `cause`).

**The caution that is not a disabled control.** The card's `logNote` prints what is incomplete and
leaves *Log this trade* enabled. Disabling it was the tempting fix and is wrong: the plan object is
machine-built and gate-checked, and removing a working control because something adjacent failed is
the inert-control mode this repo already pins. It says the fact and lets the trader decide.

**Fixed on the way, and it matters more than the rendering.** The dock persisted the RAW provider
message into the row; the Chat surface redacts. That field is written into the session and shipped
in a backup, and a provider error can carry a credential-shaped token, so the dock now uses the
canonical `sanitizeErrorText` (`src/utils/runStatus.ts:96`) like every other path.

**Red proof, twice.** Restoring the old branch condition made the keep-prose-and-name-the-failure
case fail; reversing it made it pass. Separately, two assertions in this pass first failed on their
own author's prose: a source scan that bans a deleted shape matched the comment explaining why the
shape was deleted. Both scans now read code lines only — the same correction §2 needed, learned
twice in one day, which is the argument for making it a rule rather than a fix.

**Gates.** `typecheck` ok · `vitest` **5255 in 511**, 0 skip · `lint` 0 errors / 655 warnings under
the 659 cap (unchanged, still unattributed) · `check-flow-doc-anchors` **377** anchors, 0
unattributed, cited-line quality 0/0, 0 self-quota disagreements.

**The re-anchoring this change caused, and why it was not four fixes.** One added import line and a
rewritten catch block shifted every later line in `chatTurnRunner.ts` — +1 after line 47, +25 after
974 — which moved **17 citations across three docs** off their targets. The gate named 4 and would
have stayed silent about the rest: a pointer that slides one line usually still lands near the
symbol it names, so it PASSES while pointing at the wrong place. Four slid onto comment lines,
where they would have kept their symbol match and lied about the code. Every citation into the file
was therefore re-derived from the hunk map (`git diff -U0`) and each new number confirmed by
comparing the text at the old line in `HEAD` with the text at the new one — including the ones no
gate flagged: the `ChatTurnRunnerDeps` range `:205-286`, the seat-build pointer `:1035`, and two
bare numbers inside mermaid node labels, which a file-prefixed rewrite pattern cannot see at all.

**What this did NOT close.** Named in O-137: the Chat surface still puts the reason in a separate
system row rather than in the interrupted card, so the homes now agree on the fact and disagree on
the furniture; and `chatTurnRunner.ts:1277` still drops a harness warning silently when the turn
already has text. **And O-138 is not fixed, only found:** gating this change needed four full-suite
runs because two files that each pass solo fail together on a CLEAN checkout
(`memorySurfaces` + `referenceVoice`, both orders, `expected +0 to be 2` on seeded notebook data),
and the failing set moves between runs. Root cause unknown; the row says plainly not to cure it with
a timeout.

## 30. E-57 §3 — the prompt lane is a value now, and the fingerprint counts only what exists (2026-10-22)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Closes:** **O-139**. **Opens:** **O-140**.

`beginPromptLane()` flipped a module boolean and a caller's `finally` cleared it. Two
runs deciding in the same window — a schedule and a human send — each resolved with
whichever lane decided LAST, and a run that threw left the flag set for whoever was
mid-flight. `promptCorpusVersion()` hashed every stored override, including edits left
behind by prompts the app no longer ships, so two runs that sent identical bytes could
carry different `promptVersion` strings and split the A/B group on a number that named
nothing the model was given.

**The lane is now a value.** `PromptLane` (`src/services/infrastructure/PromptOverrideService.ts:32`)
is returned by `beginPromptLane` (`:34`), taken by `getPrompt(id, fallback, lane)` (`:69`) and
`promptCorpusVersion(lane)` (`:97`), and threaded from the run that decided it
(`src/hooks/useAnalysisPipeline.ts:957` → `:963`). `endPromptLane` is deleted: a value needs no
unwinding, so there is no call left to forget on a throwing path.

**The filter, and why it is a separate list.** Registered ids come from
`src/constants/promptIds.ts` — twelve bare strings — because importing `PROMPT_REGISTRY` into a run
path pulls every prompt's text with it (+18.7 kB, over the bundle ratchet, as that module's own
history records). A test pins the two lists against each other, so an id added to the registry and
not to the list fails the suite rather than silently vanishing from the fingerprint.

**A visible number was on the same lie.** Settings' **Reset all (N)** counted stored keys, so it
offered to reset prompts the app cannot send. It now filters against the registry the tab already
renders (`src/components/settings/PromptManager.tsx:83`) — derived there rather than imported from the
new list, so the tab and its count cannot disagree.

**The finding that changed this item's own premise, and is now O-140.** The plan said to thread
the lane "at the measured call sites". Re-reading those sites showed the analysis prompts behind
them are reached in production only from `src/services/learning/SkillEvalScheduler.ts:285`, that
`analyzeTradingViewWithTransientRetry` (`src/hooks/useAnalysisPipeline.ts:249`) has no caller at all,
and that `src/services/trade/**` contains ZERO `getPrompt` calls — the dock never resolves an override.
Threading the lane into a path the trader's run never takes would have produced plumbing that looks
like wiring, so it was not done. What §3 fixed is real (no cross-run clobbering, no ghost
fingerprint); what it exposed is that the dial measures a label, not a difference, and that is an
owner decision with two honest answers, recorded rather than decided here.

**Proved red.** Removing `&& isRegisteredPromptId(id)` fails the orphan-override case; the
no-global scan and the value-threading scan are code-line only — the THIRD time in two days that a
source gate failed on its own author's comment rather than on code, which is why the rule is now
"comments may name what was deleted; the scan reads code".

**Gates.** `typecheck` ok · `vitest` **5260 in 511**, 0 skip · lint 0 errors / 655 under the 659
cap · `check-flow-doc-anchors` **381** anchors, 0 unattributed, cited-line quality 0/0, self-quota
0 — after 24 citations into `useAnalysisPipeline.ts` and `PromptOverrideService.ts` were re-derived
from the hunk map, including three bare numbers inside mermaid labels and html `<code>` spans that
a file-prefixed rewrite cannot reach.

**What this does NOT close.** **O-140** (above), and it does not purge the stored orphan overrides
themselves — they are now ignored where they mislead, and deleting a trader's data is not this
pass's call.

## 31. E-57 §5 — the risk checks that existed now answer the plan the trader is shown (2026-10-22)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Closes:** **O-141**. Ruling **(c)** is this item's shape.

`validateRiskReward` (`src/services/validation/AccuracyValidationService.ts:206`) has owned the confidence-tier R:R
floor and the two ATR stop bands for a long time, `tests/planE02.test.ts` and `tests/accuracyValidation.test.ts`
pin them, and the only production caller was `runValidationGate`
(`src/services/validation/TradeValidationGate.ts:654`) — inside a module with **zero importers**. So a presented plan
was graded by a number nothing showed and nothing enforced: the card printed the ratio, the journal stored it,
and no path ever asked whether the stop was inside the noise band the app itself computes.

**The live call site.** `assessPlanShape` (`src/services/trade/proposalGate.ts:152`) is called from **every exit** of
`runGateScan` (`:189`) — evaluated, aborted, null-fetch and thrown — with the ATR the scan actually brought back
(`atrForGate :123`: 1h → 4h → 15m → 1d, the frame the gate already scores on, since `runProgrammaticGate`'s own
exhaustion check and `inferRegime` read `indicators['1h']`). A plan whose tape never arrived is still caught for
a shape that needs no tape. It calls the band owner rather than re-deriving anything, and the inverted check is
the same `plannedRiskRewardSigned` call the card's printed ratio comes from, so the gate and the card cannot
disagree about what "inverted" means.

**The split ruling (c) asked for.** Sub-floor ratio, tight stop, wide stop, stop beyond 5 % of entry →
`ProposalGate.warnings` → printed on the card (`src/components/trade/panels/TradeProposalCard.tsx:173`, the first
caution always visible because a warning behind a toggle is a warning nobody reads, the rest through the one
`Disclosure`) **and** recorded on the journal row (`src/services/trade/proposedTrade.ts:207`), so a caution the
trader overrode is auditable after the fact and the Log button was never disabled. Inverted levels →
`refusal`, stated **ahead of** the min-edge refusal, because grading an expectancy on levels that point the wrong
way is a claim about arithmetic that does not exist. The refusal text deliberately does not quote
`levelOrder.fixes`: those strings describe a mirror-repair this gate does not perform, and printing one would
tell the trader the levels were fixed when they were thrown out.

**Three labels said "edge floor" and were false for an inverted plan.** `proposedTrade.ts:202` stamped every
refusal as `REFUSED by the min-edge gate`, the card's disabled button read `Refused by your edge floor`, and the
App toast read `Plan refused by your edge floor`. All three now name the gate, and the sentence riding with each
refusal says which check fired.

**A latent defect the wiring exposed.** With `atr = 0` the tight band can never fire (`risk < 0`) while the wide
one — `risk > 0 * 3` — fires on **every** plan, so the live gate would have printed
`Wide stop loss (Infinityx ATR). Consider reducing position size.` as a measurement of nothing. Both bands now
stand down when there is no volatility reading (`AccuracyValidationService.ts:269`). This was unreachable before
only because nothing called the function.

**Proved red, three ways.** Stubbing `assessPlanShape` to return `{}` → 6 of the 7 new shape cases fail (the
seventh is the control that asserts the absence, and it is the reason the other six cannot pass on a gate that
warns about everything). Removing the `atr > 0` guard → 2 fail, and the gate's own control case reports the
`Infinityx ATR` string. Emptying the card block and the row's provenance loop → 4 fail: 3 card cases plus the
journal-row assertion that the caution reaches the record.

**Gates.** `typecheck` ok · `vitest` **5273 in 511**, 0 skip · lint 0 errors / 655 under the 659 cap (§26
already measured 655, so no headroom was spent and none claimed) · `render-probe` **117 ok, zero pageerrors** ·
(the probe and the build measured a tree that differed from this entry only in four comment strings, which
neither render nor survive minification — said here rather than glossed, because the sentence above reads as
one tip) ·
entry chunk **1,383 kB** against the 1,400 ceiling by the `guards.yml` recipe (`$(wc -c)/1024`), and §5 costs no
new module in the startup graph: `AccuracyValidationService` was already reachable through
`HybridIntelligenceService`, which `src/hooks/useAnalysisPipeline.ts:19` imports statically ·
`check-flow-doc-anchors` **382** anchors, 0 unattributed, both quality ceilings 0 — ten citations into
`proposalGate.ts`, `proposedTrade.ts` and `TradeProposalCard.tsx` (including the two `ensureStamp` rows in the
flow docs) were re-derived from the `git diff -U0` hunk map rather than shifted by hand, two
`AccuracyValidationService.ts:228` citations were checked and provably did not move (the hunks start at 263), and two of them (`docs/app-flow.md`'s and `html`'s
own "381" self-quotes, plus a comment-exemption count that §3 had already moved from 3 to 5) were stale in ways
the gate cannot see until the count it prints is restated.

**What this does NOT close.** **O-10 / O-06**: `runValidationGate` is still dead — §5 imported its *checks*, not
its dispatcher, and it stays an E-50 deletion candidate. **O-141's own residue**: the frame the stop is measured
against is the gate's choice, because a proposal carries no timeframe; an inverted plan still draws on the chart
until the stamp lands, since `present_trade` returns before the scan (refusing at presentation would move the
decision out of the one place that consults the tape, and that is its own call); the 5 % band is direction-free
and fires on deliberate swing stops. **No `hardInvalid` field was added** — `refusal` already owns "do not log
this", and a second flag for the same fact is a second writer waiting to disagree. The probe does **not** assert
the caution sentence: whether a band fires depends on live candles, so a probe assertion would be flaky by
construction, and the rendered text is pinned at the jsdom layer instead.

## 32. E-57 §6 — what a scheduled run leaves behind, and what stops it leaving nothing (2026-10-22)

**Proposal:** `docs/plan/closed-loop-fixes.md` (E-57). **Closes:** **O-142**. **Opens:** **O-143** — a gate gap this
item found while choosing its own verification.

`runAutomationTurn` already returns `notices`, `failedTools`, `refusedPlans` and `plansPresented`
(`src/services/trade/automationTurn.ts:290-311`). The hook turned them into a WARNING toast
(`src/hooks/useAutomations.ts:566`) and stored nothing: `AutomationRun` had no field for a caveat, so the record of a
run was silent about it the moment the toast expired. Worse, two of the three shapes had no prose to hide behind
— an `error` or `skipped` row carries no message at all, and the card's analysis-shaped bubble rebuilds its text
from the analysis object and drops the prose the turn wrote. And there was no ceiling on failure anywhere: a
routine whose bot had left the roster fired, skipped, toasted and fired again, forever.

**The caveats are fields now.** `AutomationRun.notices` / `.plans` (`src/types/automation.ts:102`, `:108`) are written
at the ONE `finish` site (`src/hooks/useAutomations.ts:530`) from the delivery the pipeline already carries
(`src/hooks/useAnalysisPipeline.ts:1308`, widened in place so no line in that heavily-cited file moved), and printed
on the card in the open (`src/components/automation/AutomationRunCard.tsx:147`) — a test asserts the block sits
outside any `<details>`, because a caveat behind a toggle is a caveat nobody reads before acting on the signal.
The block is deliberately suppressed on the two bubble paths that already render `message.text` whole, and that
is not tidiness: the turn writes its notices INTO that text on purpose, because the next scheduled run's history
is built from these stored rows, so the model is told what failed last time. A card that showed both would print
one sentence twice.

**One breaker, both arms.** `settleRunStreak` (`src/hooks/useAutomations.ts:282`) is the only place that counts the
streak, and the pipeline's `finish` and the bot routine's `finishMeta` both settle through it — two writers would
be how one arm quietly stops counting. `MAX_CONSECUTIVE_AUTOMATION_FAILURES`
(`src/services/automation/AutomationService.ts:127`) is 3, and a trip writes `enabled: false` plus a `disabledReason`
into the config the boot reads, so the verdict survives a reload rather than living in React state. The schedule
prints its own banner (`src/components/automation/AutomationView.tsx:121`) rather than letting `Off` mean two things,
and only `toggleAutomationEnabled` (`src/hooks/useAutomations.ts:752`) clears the counter — the re-enable IS the human
act ruling (d) asked for. A switch OFF writes no reason, so a manual pause and a breaker trip stay tellable apart.

**Two items in this pass turned out to be already true, and are recorded rather than "fixed".** The quota reads
`MAX_PLANS_PER_DAY` — plans per automation per local calendar day, ledger read at
`src/services/automation/AutomationService.ts:144`, spent at `:157` — and the refusal receipt already prints "3 plans
per day for this schedule" (`src/services/trade/automationTurn.ts:227`); no UI ever claimed symbols, so the semantics
were left alone as the plan required. And no `model` field was added to the run: `message.modelsUsed` already
names the model, the card now reads it (`AutomationRunCard.tsx:62`) and falls back to the raw id rather than
saying nothing, so a second field would have been a second writer for one fact. `RAW_LOCAL_STORAGE_PREFIXES` was
not touched — `automations_v1_` and `automation_runs_v1_` are already on it
(`src/services/infrastructure/ExportService.ts:773-774`), which the new export → wipe → import test confirms carries
the new fields.

**Proved red, four ways.** Dropping the two row fields → the record test fails. Never writing `enabled: false` →
the trip, re-enable and bot-arm tests fail (4 total, the streak control still passes because it asserts the
schedule is still ON). Forcing the duplication guard off → the no-repeat test sees the sentence twice. Making the
banner unconditional → the manual-off control fails. The two controls exist so the four failures cannot be
explained by a test that passes on any code.

**Gates.** `typecheck` ok · `vitest` **5290 in 511**, 0 skip (17 cases added, no new file) · lint 0 errors / 655
under the 659 cap · `build` ok, entry chunk **1,383 kB** against the 1,400 ceiling by the `guards.yml` recipe —
the automation surface is lazy, so this cost the startup graph nothing · `render-probe` **117 ok, zero
pageerrors**.

**What this does NOT close.** **O-143**: `grep -c automation` is 0 in `render-probe.cjs`, `boot-probe.cjs`,
`probe-skill-approval.cjs`, `surface-census.cjs` and `e2e/smoke.spec.ts`, so no browser gate has ever opened this
surface — §6's rendered claims rest on jsdom alone, and the probe's contribution here is that nothing ELSE
regressed. The bot arm still has no `notices` to record, because `runBotRoutineTurn` returns none; a fire that
returns before the bridge is wired leaves no meta at all (pre-existing, untouched); and the breaker counts a run
a human cancelled, which is a deliberate reading of `skipped` and is written into the constant's own comment
rather than hidden in a branch.

---

## 33. The three research proposals that needed no ruling (2026-10-23)

**Commit:** `e6787a8f`. **From:** `docs/research/TRADING-IMPROVEMENTS.md` P2, P10,
P3 (ranked 3rd, 4th and 5th of the top five). **Closes:** nothing in the register —
these were research items, not `O-nn` rows. **Opens:** nothing; the halves that
remain are named below.

**P2 — the `propose_skill` reason survives.** The tool's schema has required a
`reason` since it was written and its handler never read it, so the human approving a
draft was approving a rule whose stated evidence the app had thrown away. It now rides
the whole chain: read at `src/services/analysis/DeskToolsService.ts:2687`, declared at
`src/schemas/learning.ts:153` (clipped to 600 chars, the same budget every other clause
carries), stamped by the ingest (`src/services/learning/SkillMemoryService.ts:2977`),
serialised into the skill's frontmatter (`:1325`) and parsed back (`:726`), and printed
as its own line on the Coach card (`src/components/chat/CoachThreadPanel.tsx:143`).
`timeframe` joined the schema (`:2688`) because the replay proof silently assumed `1h`
without it; `source` deliberately did **not**, because it is learner-stamped provenance
and a model may not claim it. Two adjacent lies on the same path went with it: a
proposal with no `steps` used to be coerced by `steps = [String(steps)]` into the
one-element array `["undefined"]` — which satisfied `min(1)` and reached the draft as a
real step — and now is refused (`:2668`); and `queueLearningProposal` returned the row
it had just failed to store, so `write` now returns a boolean
(`src/utils/learningQueue.ts:126`) and the caller yields `null` (`:156`), which is how
`src/utils/skillDrafts.ts` already answered. `revise_skill`'s receipt
(`DeskToolsService.ts:2827`) stopped calling a failed write "already pending".

**P10 — the skills index and the skill injection read one filter.** An unapproved
skill was *named* to the model in the index and then refused by the injection, which
reads to a model as a broken promise and to the trader as a flaky system. The fix is
one projection, not a second filter: `skillIndexRow`
(`src/services/learning/SkillMemoryService.ts:1020`) turns a library row into the index
row and carries `approved`, `skillIndexRows()` (`:1036`) is the only caller-facing
builder, and `isIndexableSkill` (`src/services/trade/tradeChatContext.ts:277`) refuses a
row whose approval fact is false. `approved` is **optional** on the row type
(`:238`), so a caller that passes no fact still fails *open* — deliberate, because the
field is new, and the reason both surfaces must go through the one projection rather
than mapping `listSkills()` themselves. The dock's inline projection was deleted, and
so was its **copy inside `tests/promptContract.test.ts`**: that copy is why the file
stayed green while the production dock path sent an index the injection would never
fill — a test that re-implements the thing it audits cannot fail when the thing breaks.

**P3 (the half that was not a ruling) — the detached skill evaluator gets an
allow-list.** `SkillEvalScheduler.ts:285` reached `analyzeTradingView` with no
`allowedTools`, and an absent list means *everything*
(`src/services/analysis/DeskToolsService.ts:2490`), so a background job could call
`present_trade`, `decline_trade`, `propose_skill`, `forge_tool`, `write_memory_note`
and every forged `custom_*` tool. It now passes `AUTOMATION_EVALUATION_TOOLS`
(`src/services/trade/automationTurn.ts:73`), derived from the automation surface's own
list by dropping the two tools that write to the journal, and applied at
`src/services/learning/SkillEvalScheduler.ts:301`.

**Proved red, five ways.** Disabling the index's approval check turned both
negative assertions red (`tests/tradeChatContext.test.ts`, and the new wire-level
`tests/promptContract.test.ts > does not name a skill the trader has not approved`).
Dropping the ingest's reason stamp, emptying the `steps` guard, deleting the
evaluator's `allowedTools` and forcing `queueLearningProposal` to return the row on a
failed write each turned their own test red — the guard, not the fixture.

**Gates.** `typecheck` ok · `vitest` **5,351 in 514 files**, 0 skipped — **8 new cases**
(`git diff HEAD~1 HEAD -- tests`: 8 `it(` added, 0 removed), four of them the negative
assertions named above, plus `tests/chatSurfacePrompt.test.ts` and
`tests/tradeChatPanelHarness.test.tsx` — whose blanket `vi.mock` of the skill service
silently swallowed the new `skillIndexRows` export and dropped the Chat mandate into
its own `catch`, so the mock had to become `importOriginal` + the real projection
before those existing cases could keep testing the path the app runs · lint 0
errors / **655** warnings under the 659 cap (unchanged) · `check-flow-doc-anchors`
**410 anchors, 0 unattributed, self-quota 0** — the three policed docs re-anchored for
the lines these moved. `docs/research` is *not* policed, so its citations were
re-derived from this commit's own `-U0` hunk headers: 258 named and 98 bare moves,
each asserted by requiring the bytes at the old line and the new line to be identical,
with every doc verified afterwards to differ from its committed form in digits only. That rule
protects a MOVE; it does not validate a citation the move left alone, and a reviewer's re-check of
the prose this session wrote found several that had been wrong for days (§35, and the `STATUS.md`
log line). `docs/research/**` sits outside the four documents the anchor gate polices, so nothing
measures it automatically.

**What this does NOT close.** The probe half of P2: `skill-approval-probe` seeds the
draft bytes, so the segment between a model's `propose_skill` call and the inbox is
still covered only by unit tests. The other half of P3: an absent `allowedTools` still
means unrestricted — making consequential tools refuse an unattended context changes
the executor's default for every caller, and is the owner's call. P10 fixed naming,
not writing: the 14 unapproved-activation paths (O-32) are untouched. And nothing here
touches P4, P1 or P5's row-furniture half.

---

## 34. The dev-proxy transport gets its timeout, and P5 is shown to be one decision (2026-10-23)

**From:** `docs/research/TRADING-IMPROVEMENTS.md` P5 item 3. **Closes:** no register row.
**Changes the shape of:** P5 items 1 and 2, which are now recorded as one decision.

**What landed.** Two of the three `/__provider_proxy` branches were sending `signal: options?.signal`
— no timeout of their own — while every other transport path in the same file passes
`withTimeoutSignal` (120 s) or `withStreamTimeoutSignal` (300 s). They now pass the one
matching the call they make: the non-streaming request at
`src/services/providers/GenericProviderService.ts:1432`, the streaming turn at `:1619`.
The research corpus recorded this as one branch; a census of `signal: options?.signal`
found a second uncapped one, so the fix is wider than the finding and the three rows that
named it now say so — and narrower than it reads, because a third proxy branch was already
capped and this pass did not touch it.

**Why the streaming branch takes 300 s and not 120 s.** The proposal said "match the
other two transports (120 s)". A stream is not a non-streaming call: a reasoning model
streams its chain of thought before its answer, which is exactly why
`withStreamTimeoutSignal` exists at all. Cutting a thinking turn at 120 s would be a new
failure traded for an old one.

**Proved red.** Reverting both lines to `signal: options?.signal` fails both new cases —
the first on "the signal handed to `fetch` is not the caller's bare one", the second on
"no timeout budget was ever requested". `tests/devProxyTimeout.test.ts` also asserts the
caller's `abort()` still reaches the wire, so the fix cannot have replaced the Stop
signal instead of combining with it, and it asserts the streaming path never asks for
120 s.

**What this pass also found, and did NOT "fix".** P5 items 1 and 2 cannot be taken
separately. `InterruptedRunNotice` returns `null` without at least one handler
(`src/components/shared/InterruptedRunNotice.tsx:27`), and the Chat surface mounts
`ChatTranscriptRow` with only `row` — so adding `Message.interrupted` alone would render
nothing at all. A flag whose only reader is suppressed by the component that reads it is
a write-only field, which is the pattern P4 exists to delete. The pair needs the trader's
call on what the stopped row offers. Recorded in
`docs/research/TRADING-IMPROVEMENTS.md` §P5 with the measurements, together with the
correction that `interruptedPrompt` has no producer anywhere in the tree (only
`tests/interruptedRunNotice.test.tsx:29` sets it), so the dock's "Edit prompt" reads the
previous entry instead.

**A false register row, found while re-anchoring.** `open-items.md` O-29 cited
`SkillMemoryService.ts:352/:360/:386` for the three evidence floors and stated them as
2 / 3 / 5. The constants are at `:442/:443/:472` and are **10 / 20 / 10** — raised by
E-37 in `8cae97c7` (2026-10-20), the same commit whose work this register was supposed to
have noticed. So the row was not stale by a day: it had been false for three, citing
lines that hold `whyAccepted` and the provenance fields, and it listed as OPEN an item
that had closed. It is now **CLOSED by E-37** with the lines and values that resolve.
This is the fourth false row in the register after O-34, O-105 and the triple D-24 —
which is why the re-anchor pass asserts on bytes rather than trusting its own arithmetic.

**Gates.** `typecheck` ok · `vitest` **5,353 in 515 files**, 0 skip · lint 0 errors /
655 warnings · `check-flow-doc-anchors` 410 anchors, 0 unattributed, self-quota 0, and
the AGENTS.md census arm green against the tracked file count (it failed at 514 until the
new test file was staged — the gate measures `git ls-files`, not the working directory).

---

## 35. The review pass: five real defects the first two commits left (2026-10-23)

**Method.** Five read-only reviewers were launched against `e6787a8f` + `7bd7098f`
with different lenses — the reason chain, the unattended blast radius, the index
consolidation, test quality, and doc-claim fact-checking. Every finding they made was
re-opened in the tree before anything was changed; two of theirs did not survive
inspection (named below).

**Fixed, in code.**

1. **The second writer of the skill format did not write the new field.**
   `ingestCraftedSkillUnlocked` builds its own `SkillMeta` and had no `reason` slot, so
   a draft backed by a closed trade — which is exactly what a post-mortem produces —
   lost the evidence on the way to the notebook while the draft-backed path kept it.
   Now stamped at `src/services/learning/SkillMemoryService.ts:2887`, the same clip as the
   other writer. Pinned by extending the existing P0-1 case
   (`tests/skillApprovalRoundTrip.test.ts`), proved red by disabling the line.
2. **The round-trip guard did not know the field existed.** `ROUND_TRIP_FIELDS`
   (`src/services/learning/skillReview.ts:332`) is the list the byte-level serialize/parse
   guard walks; `reason` was absent, so a frontmatter round trip could silently drop it
   and nothing would fail. Added beside `whyAccepted`.
3. **The Skills label asserted a thing the gate denies.** After P10 the index and the
   injection both withhold an unapproved skill, while `skillAvailability` still answered
   `Enabled — this skill is injected into the seat prompt` from `skillEnabledFlag` alone
   (`src/components/learn/SkillsCatalog.tsx:159`, fed at `:421`), and the skill reader's chip
   and `SkillDetail`'s "Active" (`src/components/skills/SkillDetail.tsx:139`) did the same.
   The function's own header already states the rule — "a check on a rule that reaches
   no seat is a lie" — so this is not a new opinion, it is the module's contract
   applied to a fact it had not yet read. Both call `isApprovedSkill` (widened to
   `Pick<SkillMeta, 'approvedBy' | 'prior'>` so the surfaces can call the one reader
   instead of re-implementing it), and the existing `off` state carries the why; no new
   chip vocabulary was invented. `tests/skillsReferenceSurface.test.tsx` and
   `tests/skillLiveLabel.test.tsx` pin both directions, including the starter-shelf arm
   that fails if a surface hand-tests `approvedBy === 'human'` instead of calling the gate.
4. **A third place names skills to a model.** `scan_setups` cross-references the skill
   list into a tool result, filtered only by retired-and-enabled — so a seat was told
   "skills: funding-exhaustion-long" and `recall` would answer with nothing. It applies
   the approval fact now (`src/services/analysis/DeskToolsService.ts:3049`), with
   `tests/scanSetupsTool.test.ts` mocking the library but keeping the REAL gate.
5. **Three of my own tests were not capable of failing.** (a)
   `tests/automationToolTurn.test.ts` opened with `toEqual(AUTOMATION_TOOLS.filter(t =>
   t !== 'present_trade' && ...))` — the production expression restated, which is green
   for any code. Replaced with assertions that the base actually carries both acting
   tools, that neither survives, that exactly two were removed, and that nothing else
   was. (b) The deny-list loop in the same test was vacuous (the base already excludes
   them). (c) `tests/devProxyTimeout.test.ts` asserted `not.toBeNull()` on a value that
   was `undefined` pre-fix, so that arm passed on the broken code; both arms now demand
   an `AbortSignal` instance. The reviewer's fourth point — the mocks re-implement the
   projection's `.map()` — is true and accepted: they call the real `skillIndexRow`, so
   a gate change is caught; only a change to `skillIndexRows`' *composition* would hide.

**Not taken from the review, and why.** One reviewer reported the unattended path can
"still reach every forged `custom_*` tool" — true of SCHEDULED runs (`automationTurn.ts`
sets `executePanelTool`, which re-adds confirmed forged definitions at
`src/services/analysis/DeskToolsService.ts:4265-4273`), and false of the evaluator this fix
narrowed, because `analyzeTradingView` wires no executor. So the claim is a pre-existing
property of the automation surface, not a hole in this change, and it is recorded rather
than silently widened into a behaviour change for schedules. Another suggested routing
`get_notebook_map` through the same filter; rejected — that tool answers "what files are
in my notebook", and hiding a file there makes it wrong about the trader's own data.

**Gates.** `typecheck` ok · `vitest` green across the touched suites (the full run and
the final numbers are in the entry below) · `check-flow-doc-anchors` re-run after the
docs moved again: the corpus was re-anchored a second time with the same byte-identity
assertion, now including `SkillsCatalog.tsx`, `SkillViewerPanel.tsx`, `SkillDetail.tsx`
and `skillReview.ts`.

**And what the corpus check found about ITSELF.** The re-anchor rule validates a MOVE,
not a citation nobody moved. A reviewer that re-opened every claim this session's prose
makes found citations that had been wrong for days — `deskToolsMandateFor`,
`rejectedResult`, `requireFirstToolRound`, the status-ladder and temporal-ledger pairs,
the `hurts` pin block, `revokeSkillApproval`, O-31's two route-A entry points, and
`automationTurn.ts:106-127` (which is `automationSeatFor`) quoted as evidence that the
automation path has no provider fallback. Each is corrected here. **`docs/research/**` is
not policed** — the anchor gate reads four documents — so nothing measures the rest of
the corpus automatically, and O-29 was the proof that a register row can be confidently
wrong for three days. That is the honest limit of this pass, not a resolved item.

---

## 36. The second review round: what my own fix got wrong (2026-10-23)

**Method.** After §35 landed, two more reviewers were pointed at `792589ff` itself —
one for runtime reach, one for design quality. Four of their findings were real and
are fixed here; two were checked and are false; the rest are recorded as open, with the
measurement that makes them open rather than vague.

**Fixed.**

1. **The new label promised a path that does not exist for the row showing it.** The
   catalogue's title said "A draft is approved in the Coach inbox" — but the writers that
   produce an unapproved file (`ingestIfThenFromTrade`, and the worth-gate `create`)
   queue NO draft, so the very rows that reach that sentence have nothing waiting in the
   inbox. The wording now states the rule ("a skill reaches a seat only on a human
   approval") and the one switch that is real — Settings → *Starter playbook library*
   (`src/components/settings/SessionUsagePanel.tsx:209-227`) — without promising a row that
   may not exist. `src/components/learn/SkillsCatalog.tsx:163`.
2. **`approvedBy: 'supervisor'` was called "nothing has approved this rule"** while the
   pill beside it read "auto-approved". Both sentences are true of the GATE and false of
   each other; the reason line now names who accepted it
   (`src/components/skills/SkillDetail.tsx:151`), and `tests/skillLiveLabel.test.tsx` pins
   that the two do not contradict — proved red by changing the one string comparison.
3. **A row signature omitted the new fact.** `describeRosterSync`
   (`src/components/learn/SkillsCatalog.tsx:185`) lists every field that makes a roster row
   what it is, and the refresh line it writes ("Refreshed — nothing changed") is only
   honest if that list is complete. `approved` was not in it, so flipping the starter
   shelf and pressing Refresh would move every `book-*.md` card from the check to the ban
   and report no change. Added.
4. **A test depended on jsdom's case folding.** `[title*="nothing has approved"]` matched
   a sentence that begins "Nothing has approved…" — jsdom matched it, Chromium would not.
   The selector now matches a substring whose case is fixed (`has approved this rule`).

**Checked and false.** The design reviewer's proposal to give a superseded skill its own
`off` arm rests on "the matcher refuses it while the catalogue says Enabled".
`skillMatchesSetup` does test `supersededBy` (`src/services/learning/SkillMemoryService.ts:1420`),
but the writer that supersedes a skill also retires and archives it — `stampStatusTransition(meta,
'retired', 'superseded')`, `meta.status = 'retired'`, `enabled: false` (`:3458-3468`) — and
`skillAvailability` already answers `Off` for a retired rule
(`src/components/learn/SkillsCatalog.tsx:148`). An arm for the state alone would be a branch
nothing can reach. The reviewer also asked for a count of skills awaiting approval; there
is genuinely none (§35's finding 4 stands) — that is a product gap, not a text fix, and it
is the owner's to weigh.

**Still open, with the measurement.** `manualOnly` and a non-`all` `audience` are dropped by
BOTH the index (`src/services/trade/tradeChatContext.ts:274-279`) and the retrieval
(`src/services/learning/MemoryRetrievalService.ts:267`), yet the catalogue still calls such a
file "Enabled — injected": the same class of label lie, one arm short. It is left open
because no writer in the tree sets either field (`grep "manualOnly: true"` and
`"audience:"` across `src/services/` and `src/constants/` find only the parser and the serialiser) —
so the population today is hand-edited or imported files. `src/components/learn/MemoryFilesManager.tsx:241`
carries the same lie in a toast ("is now injected into every prompt") for a file the gate
refuses. And `get_notebook_map` still lists unapproved skill files — deliberately: it
answers what is IN the notebook, not what a seat is given.

**Gates.** `tsc` clean · **515 files / 5,358 tests**, 0 skipped (+1 case) · eslint 0 errors /
655 warnings · anchors 410, 0 unattributed · `render-probe` re-run AFTER the label text
changed again — 126 ok, zero pageerrors, so the Learn sweep saw the new words rather than
the old ones.

---

## 37. Live-app verification, one more asymmetry, and ten wrong claims about the references (2026-10-23)

**What was checked where it actually runs.** The trader's dev server is **:3000**;
**:5173 is a different project** (it serves `August Proxy` from `/src/main.tsx`, and this
repo enters at `/index.tsx`). Before asserting anything against it, the served source was
confirmed to contain this session's code (`curl :3000/components/learn/SkillsCatalog.tsx`
returns the new tooltip text and `approved: isApprovedSkill(meta)`) — checking a stale or
different checkout would have proven nothing either way.

**The live result.** `.probe-artifacts/live-verify.mjs` (scratch, Playwright, 14 checks,
all green against the running app) verified the user-visible chain end to end: the
Approvals card prints the reason verbatim; Save writes a notebook whose **shard** carries
`reason:` — and that was itself a finding about the check, not the app: the first version
read only `memory_files_v1_<user>`, which holds folders and the shard manifest, so it
reported a missing reason that was really in `memory_files_v2_<user>_skills`. The mark
change was proven with a contrast, not a zero: 14 rows render, the saved skill's own row
reads `Enabled`, the same row reads `Off` after `approvedBy` is stripped from its stored
bytes, and a starter-shelf row stays `Enabled` throughout — so neither arm can pass on an
empty page. `npm run skill-approval-probe` ran green beside it (25 PASS / 0 FAIL).

**One more writer asymmetry, from the benefit review.** `timeframe` and `source` were
forwarded to the draft-backed ingest but never stamped by `ingestCraftedSkillUnlocked`
(`src/services/learning/SkillMemoryService.ts:2887-2889`) — the same two-writers-of-one-format
class `792589ff` fixed for `reason`. Both are stamped now and the existing P0-1 case
asserts them, so the closed-trade route and the chat route can no longer disagree about
what a skill file contains.

**One finding that is not a defect.** The review flagged the 120 s dev cap as reachable on
a *streaming* call (`GenericProviderService.ts:1931` routes `messages`/`google` streams
through `sendChatRequestOnce`). It is not a regression: that path was already capped at
120 s in the packaged app (`:1486-1490` wrap every format call), so the fix made dev match
the shipped behaviour instead of breaking it.

**And the reference corpus was wrong about the references, ten times.** Re-opening the
pinned clones (`pi` at `58c0b02`, `deepseek-harness` at `687f282e`) and re-measuring each
claim before touching it: the `~90 boolean flags` figure counted properties, not flags
(31 file-wide, 24 in the cited window); `additionalProperties: true` has seven sites, not
five; the overflow-before-retry **ordering** is enforced in the caller
(`coding-agent/src/core/agent-session.ts:3769-3772`, `durable/src/harness/generation.ts:542`),
not in `overflow.ts:80-84`; **"any HTTP 413 regardless of body" states the opposite of the
tested rule** (`overflow.ts:64-66` requires the 413 to be the status, and
`test/overflow.test.ts:48-56` asserts body-only 413s are NOT overflow); the "no test" claim
about the overflow table is really "no test that runs without an API key"
(`test/context-overflow.test.ts:96` is key-gated); `packages/ai/src/scripts/hydrate-model-catalog.ts`
does not exist (twice cited; the real path is `packages/ai/scripts/…`); and deepseek's
two-bounds compaction trigger is at `config.ts:191-194`, not `:203-206`. The pi
synthesis's own "6 of 6 verified, none false" line now carries that amendment — its
spot-check sampled the shard reports and never re-opened the summary written from them.

**Gates.** `tsc` clean · 515 files / **5,358 tests** (no new cases this entry) · eslint 0
errors / 655 warnings · anchors 410, 0 unattributed · live probe 14/14 against :3000.

**Left for the owner, and it is not documentation.** A route-A skill file now reads `Off`
with an honest why, and there is **no press in the app that approves it** — the only
writers of `approvedBy: 'human'` are a draft approval and a queued rewrite
(`src/services/learning/skillApproval.ts:71`, `src/services/learning/SkillMemoryService.ts:1108`),
and neither exists for a file the closed-trade loop minted. Honest `Off` with no lever is
still a dead end; the small fix is one Approve press on the skill card beside Undo, which
is a product decision, not a repair.

---

## 38. The buckets that never un-counted, and what the harness deep-reads found (2026-10-23)

**From the deepseek round-2 review, one real data defect, fixed.** The per-provider
confidence-calibration store (`model_confidence_calibration`,
`src/services/backtesting/ModelPerformanceService.ts:1226`) is counters-only — wins/total
with no entry log — so a trade that was re-settled, deleted or mirror-corrected after the
fact never un-counted its sample, while the Brier summary on the profile read the buckets
as live. The fix follows the pattern the reference calls "possibly stale, never wrong"
and the repo already uses twice on the same file: rebuild at boot from the same trade log
(`syncConfidenceCalibrationFromTradeLog`, called at
`src/hooks/useUserProfileLoader.ts:448` beside `syncFromTradeLog` and
`syncRollingWindowFromTradeLog`), sharing the ONE derivation with the incremental writer
(`getTradeProviders` + `creditedWinForAnalyst` + the same `levelsCorrected` skip), so the
two writers cannot disagree. A provider the log cannot reconstruct (the migrated legacy
shelf) is preserved, not dropped; and an identity rebuild is not persisted, because the
Preferences write queue is shared with every boot read and a no-change write buys nothing
but latency. Proved: incremental-then-rebuild produces byte-identical summaries (the
two-writers contract); a WIN re-settled to LOSS moves `highGap` from −30 to +70; a
mirrored plan counts in neither writer; and the boot wiring is pinned behaviourally in
`tests/useUserProfileLoader.test.tsx` (the mock now asserts the call receives the same
mapped rows). Two of this suite's own tests were written wrong first (expected
`(1−p)²` for a loss; bucket state leaked through the module cache until the tests
re-imported the module), which is recorded because a test that passes for the wrong
reason is worse than one that fails.

**Recorded, not built — the owner's call, from both deep reads:**

- **A crashed scheduled run escapes the 3-strike breaker** (pi round-2, verified against
  `src/hooks/useAutomations.ts:287-290`: the breaker counts only *settled* `error|skipped`
  rows, and a run that dies mid-call writes no row, so catch-up re-fires while the
  breaker stays blind — `pi` counts the death itself at `scheduler.ts:394-412`). The
  repair is to write the run row before the provider call and settle the orphan as a
  strike on boot. This changes what a schedule row looks like mid-run, so it is a design
  decision, not a patch.
- **A catch-up re-run can double-execute `present_trade`** — two identical plans armed
  from one schedule after a crash (pi declares per-tool `replay: safe|unsafe` and records
  it into the committed intent before execution, `tool.ts:181-197`; August's only analog
  is the in-memory 30 s tool cache). Same decision family: an idempotency key of
  `(automationId, tickIso)` would close it.
- **A provider-compat table** (pi's flag-shaped answer to per-provider wire quirks):
  three August branches qualify — the reasoning-capability regexes with no user override
  (`src/services/providers/reasoningControls.ts:162-190`), the json_schema→json_object
  response-format ladder (`GenericProviderService.ts:536-566`), and the hardcoded
  `max_tokens` field. The four-format dispatch and the dev-proxy routing do NOT qualify.
  Deferred, exactly as the proposals document said.
- **The dead-end skill state** (route-A files reading `Off` with no approving press):
  both references point the same way — the refusal naming the missing action is already
  done (`SkillDetail.tsx:150-153`), and what fits is a **migration that re-queues**
  unapproved non-draft files into the existing Approvals inbox, the shape deepseek's
  blocked-goal reason (`goal/src/types.ts:45-66`) and August's own draft inbox both use.
  Not built: it creates inbox rows, which is a product decision.
- **Does not transfer:** pi's storage kernel and mutation line (August is single-seat; a
  turn-start row buys the invariant without an engine), deepseek's file-backed spill
  locator (August's id-based artifact store with `read_tool_output` paging already gives
  the model what it needs, `DeskToolsService.ts:755-756`, `:2939`), and a per-format
  adapter package for the wire (a fifth format would edit ~10 `apiFormat` sites, but a
  reference-style adapter package fragments the retry/timeout/error mapping all four
  formats share).

**Gates.** `tsc` clean · 515 files / **5,362 tests**, 0 skipped (+4) · eslint 0 errors /
655 warnings (baseline restored after the first cut of the tests leaked 4 unused-import
warnings) · anchors 410, 0 unattributed.

**A flake was investigated and exonerated, with the receipts.** `tests/memorySurfaces.test.tsx`
> the Details are a bulleted list` failed in the first full run after this change and was
proven NOT caused by it: the panel mounts standalone and never touches the loader, and
three isolated runs of the same test with this change in place returned
fail / pass / pass. This section originally filed the remaining signal as a bug in
`MemoryTopicPanel`'s async load; **that reading was wrong** — the panel is fully
synchronous once the store holds the file. §39 names the real resource and fixes the test.

## 39. The "shared-worker" flake was a lazy boundary, and two rules get one home (2026-10-23)

**O-138 is closed, and its recorded diagnosis was wrong in the useful way.** The item said
two test files pass solo and fail together, "that is state, not timing", and that the
seeded notebook came back empty. Measured, none of that holds: `MemoryTopicPanel` reads
`getMemoryFiles()` synchronously and seeds nothing, and the exact documented repro
(`vitest run tests/memorySurfaces.test.tsx tests/referenceVoice.test.tsx
--no-file-parallelism`, both orders) is green three times out of three on HEAD, as is the
pair with the other reported partners (`chatTranscriptImageStub`, `answerEffortTier`,
`realProviderError`). The state was never missing.

The resource is `src/components/shared/MarkdownContent.tsx`: `AnswerBody` routes the entry's
Summary and Details through it, and it is a `React.lazy` boundary — `lazy(() =>
import('./MarkdownRenderer'))` inside a `<Suspense>` whose fallback is
`MarkdownFallback`, which renders the raw markdown in a `<div>` with no parsing at all.
So `memory-topic-details` exists in **two** states: the fallback (the bullets are there
as text, and there is no `<ul>` or `<li>` anywhere) and the resolved renderer (a real
list). The panel's own container renders whenever `parts.details` is non-empty, so
`findByTestId` succeeds immediately in the fallback state and the old
`querySelectorAll('li').length` reads `+0` — which looks exactly like an empty notebook
and is not. That also explains the shape the item could not: the partner list kept
changing because the only thing a partner has to do is keep the worker busy long enough
for the chunk load to exceed `waitFor`'s 1 s default, and the chunk resolves per test
file's module graph.

Proved, not inferred: with the lazy import replaced by a never-resolving promise,
`the Details are a bulleted list` fails in 5,061 ms at
`expect(details.querySelector('ul')).toBeTruthy()` with `expected null to be truthy`;
reverted. The fix is to wait on the **parsed list** with an explicit 5 s window and a
comment naming the two states — the assertion now says what it wants instead of
measuring a container that can legitimately be empty of list items. This is not the
"widen the timeout" the item warned against: the default is untouched, and the state
being waited for is the one the test is about. Left alone deliberately: the fallback's
first-paint flash of raw markdown on every answer, which is the app-wide lazy-boundary
tradeoff and a surface decision, not a test one.

**The allow-list polarity has one home.** `seatAllows` had been hand-copied into five
places in three shapes: the executor's deny-form, the offer-time definition filter, the
forged-call refusal, the chart-tool filter, and the mail/panel merge. Four read the same
sentence forwards; the fifth read it inverted to decide whether to widen a list. That is
one sentence with two readings, so it is now two functions in one place —
`seatIsRestricted` (a type predicate, so the merge narrows `string[] | undefined` without
a cast) and `seatAllows`. `spillReceiptAllowed` is `seatAllows(allowedTools,
'read_tool_output')`, which is what it always meant. Pinned by `tests/deskTools.test.ts`
`the allow-list polarity has one readable home` (both readings, including "absent and
empty are unrestricted" — the legacy callers' contract).

**The wire's per-format reading has one home too.** Two things were duplicated rather
than merely switch-shaped, and one of them had already drifted:

- `readWireBody(format, data, statedReasoning)` is now the ONE reader of a proxied
  response body. The dev proxy hands back the provider's own JSON, and both proxy paths
  (the string request and the tool-capable turn) extracted it themselves: the turn path
  passed an array `message.content` straight through as `text` where the request path
  joined its parts, and only one of the two split an inline think block out of the
  answer. Pinned by five cases in `tests/devProxyRouting.test.ts`, including the array
  join and the think-block split.
- `STRING_TRANSPORTS` + `stringTransportFor(format)` replace a `switch` in one function
  and a nested ternary in another. The per-attempt timeout that three of the four
  transports need is part of the table entry (`withRequestTimeout`), because that pairing
  is part of the same rule; `chat_completions` stays unwrapped on purpose, since it
  applies its own timeout for its jsonMode retry. An unknown format now throws instead of
  returning `''` — an empty answer is indistinguishable from a model with nothing to say.

This is **not** the per-format adapter package the deep read deferred: the format dispatch
is still a switch, now one that cannot drift from its second caller. The genuinely
flag-shaped provider work (capability regexes with no user override, the
json_schema→json_object ladder, the hardcoded `max_tokens` field) is untouched and still
the owner's call.

**Gates.** `tsc` clean · 515 files / **5,368 tests**, 0 skipped (+6, no new files) ·
eslint 0 errors / 652 warnings (three fewer: the duplicated body extractors took their
`any` annotations with them) · anchors 410 / 0 unattributed, after re-pointing all
sixteen flow-doc citations (`app-flow.md`, `app-flow.html`, the debate-deletion ledger)
whose lines this section shifted — the anchor gate caught ten of them and the rest were
the same symbols cited a second time.

## 40. The prompt budget: cache the stable block, defer the rest (2026-10-29)

**Trigger.** The Vibe-Trading/mcode-stack comparison named the same two items the
register already carried: O-58 (no prompt caching) and O-17 (the live prompt is
mandate plus every tool schema). Both were re-measured against the tree before
anything was written.

**What landed**

| item | what landed | where | how it was verified |
|---|---|---|---|
| **O-58** | **One Anthropic cache breakpoint on the system block**, owned by the shared wire policy and used by all three builders (renderer, dev proxy, Electron main). The usage reader is normalized across the families that disagree about whether the cache is inside the prompt count: Anthropic's `input_tokens` excludes cache reads/writes, OpenAI's and the Responses API's counts include them; `promptTokens` now means the whole prompt and `cachedPromptTokens` the reported subset, summed into Settings → Session Usage. | `shared/providerRequestPolicy.cjs` › `anthropicCachedSystem`; `src/services/providers/GenericProviderService.ts` › `messagesCall`; `electron/main.cjs` (messages branch); `vite.config.ts` (messages branch); `src/utils/tokenUsage.ts` › `extractTokenUsage`; `src/utils/sessionUsage.ts`; `src/components/settings/SessionUsagePanel.tsx` | `npm run typecheck`, `typecheck:electron`, `check:contracts` (147), `build`, `boot-probe`. The shared helper was asserted directly: `anthropicCachedSystem('x')` → `[{type:'text',cache_control:{type:'ephemeral'}}]`, `''` → `undefined`. **Not verified:** a live provider's cache-hit rate — that needs a real key and a real bill. |
| **O-17** | **13 tools stay resident; the other 29 are one `load_tools` call away.** Measured over the wire: all 42 definitions are 39,903 JSON chars ≈ 10.0k tokens and were re-sent on every round (up to 8). Round 1 now carries 10,055 chars of initial schemas + a 3,643-char catalogue = 13,698 chars ≈ 3.4k tokens, **66% below the full set**. | `src/services/analysis/DeskToolsService.ts` › `INITIAL_DESK_TOOL_NAMES`, `loadableDeskToolNamesFor`, `buildDeskToolCatalogue`, `LOAD_TOOLS_DEFINITION`, the round loop's `deskDefs` + `loadResults`; `src/utils/toolKinds.ts` (`tool catalogue` label) | `check:contracts` #13 (the budget: initial ⊆ real tools, loader not a desk tool, native unrestricted defers exactly the rest, catalogue covers each once, restricted seat loads nothing, text protocol never defers, initial is a minority of bytes). **End-to-end**: a scratch SSE provider scripted one `load_tools(['run_monte_carlo'])` call — round 1 sent 14 tools (13 + loader), round 2 carried the loaded schema and still withheld `propose_skill`, the load receipt reached the transcript, and the turn ended on "done" (10/10). |

**Residues, named**

- The cache breakpoint is Anthropic-only on the wire. OpenAI-compatible and Gemini
  prefix caching is implicit; the stable system/tool order is what lets it hit, and
  `compactForWire` rewrites old history under pressure, which invalidates the prefix
  from the rewritten message on. Designing compaction around the cache is its own item.
- A turn that needs a deferred tool spends one round loading it. The 13 that stay
  resident are the market reads and the notebook lookup; a turn that reaches for goal
  authoring or skill proposals pays a round it did not pay before.
- Text-protocol formats (`messages`, `responses`) never defer — they never sent
  schemas. Their discovery story is unchanged.
- The correction→learning gap is **not** covered here: `correctedFrom` still has one
  writer and no learning reader, and a correct retraction is a ledger replay (evidence
  decay is stateful, shadow windows may already have settled), not a subtraction. It
  needs its own spec and a ruling on whether a correction rewrites history or applies
  forward.
- `render-probe` was red at `d91030ed` before any of this: the refactor dropped `.md`
  from the Journal row label and the probe still matched it. Repaired in `0794ec08`;
  it is a gate repair, not part of O-17/O-58.

**Commits.** `67edfd7` (caching), `363f75c1` (Vite interop export — the build is red
without it), `0794ec08` (probe repair), `ac779c5e` (deferred schemas + contract #13).

## 41. Skill carry-over: what compaction takes, the request puts back (2026-10-29)

**Trigger.** The ThinkRail deep dive surfaced a bug class August shares: a `skill_view`
result is a tool payload, compaction shortens tool payloads first, and nothing told the
seat that the procedure it had been following was now a head slice. The system prompt's
skills index survived (it is the mandate, never compacted), but the body did not — and
the compaction notice was a transcript line, not a message the model receives.

**What landed**

| phase | what landed | where | how it was verified |
|---|---|---|---|
| **1 — name it** | When the compacted request no longer contains the full body of a skill the loop read this turn, the request gets a harness-authored notice naming each lost skill and the remedy (`skill_view`). The loop records only bodies it actually executed (`skill_view` with no `file_path`; a bundled-file read never overwrites the body). The notice rides the outbound copy only, so tool pairs stay intact. | `src/services/providers/contextCompact.ts` › `skillsLostToCompaction`, `skillCarryOverNotice`; `src/services/analysis/DeskToolsService.ts` (the round loop) | `check:contracts` contract 5 (four cases: present body not claimed, stub named, empty map claims nothing, the notice is harness-authored with the remedy) |
| **2 — restore it** | The body itself is restored, bounded four ways: **5k tokens per skill**, **25k total**, **10% of the model window**, and the headroom the compacted request actually left (`ceiling − after`). An oversized body is cut with `clipNote` and marked truncated; a skill that does not fit is named in the preamble as "not restored for budget"; below 512 tokens of room the phase-1 notice is the fallback. Re-reading a skill moves it to the end, so the newest procedure is closest to the request. The same function runs on the continuation request via `loadedSkills` on the loop result. | `src/services/providers/contextCompact.ts` › `carryOverSkillBodies`; `src/services/analysis/DeskToolsService.ts` › `CompactedOutbound`, both loop returns, the continuation | `check:contracts` contract 5 (five more cases: verbatim restoration, truncation, no-room fallback, the total budget stopping at a second skill, no-op when the body is on the wire); `typecheck`; `build`; `boot-probe`; `render-probe`; the scratch SSE load_tools harness still passes 10/10 |

**Residues, named**

- The map is **per turn**. A body read in an earlier turn and compacted out of the
  caller's history is not in it; the index + `skill_view` remain the path, and the
  notice does not fire for it. Extending the map to history would require parsing
  stored tool calls, which the stored transcript does not carry.
- It is **skill-specific by design**. A large `read_tool_output` page or a strategy
  document gets the ordinary clip note, not restoration; generalizing would need a
  carry flag on the tool definition, and that is a different decision.
- The budget is the app's **estimate** (`estimateTokens`, biased high), and the
  restoration is skipped rather than sent over the ceiling. A model window small
  enough to leave under 512 tokens gets the notice only.
- The restored text is **what the seat read**, not a fresh read of the notebook. If a
  skill were revised mid-turn, the carry would restore the earlier body; the seat is
  told the restoration exists and can re-open.
- The carry adds a `user` turn after tool results on the **outbound copy only**. The
  loop's own array keeps the real bytes and the pairing; a reviewer looking for the
  restored text in `messages` will not find it, by construction.

**Commits.** `4b73a02e` (notice), `0719314b` (bounded restoration + contract cases).

## 42. Three integrity fixes: boundaries, corrected outcomes, import provenance (2026-10-29)

**Trigger.** The ThinkRail deep dive named a module-boundary gate, a per-project trust
grant, and the correction→learning gap left open from the first pass.

### 1. Import boundaries (`79d0bfd5`)

One real inversion existed: `chatTurnRunner` (a service) value-imported `intervalSeconds`
from `TradingChart` (a component), so the chart and lightweight-charts were bundled into a
path that never draws one. The timeframe vocabulary now lives in
`src/utils/chartIntervals.ts`, and `scripts/check-boundaries.cjs` reads every `import`,
`export … from`, dynamic `import()` and `require()` with the TypeScript parser against a
nine-rule table: types/schemas stay vocabulary, utils never import a component, services
and hooks may take component TYPES but never values, `shared/` and `electron/` never
import `src/`.

The gate self-tests its collector on all six shapes before reading the tree, and fails
below a 400-file population floor — a broken scan reports `0 violations` forever
otherwise. Measured at the commit: **523 files, 2,242 relative edges, 9 rules**. It runs in
the one Verify action (CI and release), and is in the command list and gate table.

**Residues.** Type-only imports stay legal by design. The scanner resolves relative
specifiers only: a string-built `require`, a bundler alias, or an edge the table does not
name is invisible. The table is the boundary definition, not a proof of runtime cycles.

### 2. Corrected outcomes (`975a638c`)

The gap was real: `correctedFrom` had one writer and no learning reader, so a corrected
trade left the skill that counted it on the old class forever. A WIN↔LOSS correction now
moves the skills that named the trade — followed skills through W/L, the 12-outcome
window tail, the streak and the regime split; control skills through the control counters.
The R sums are deliberately untouched (the journal corrects classification and PnL
separately), the arithmetic is a pure util (`src/utils/skillLedgerCorrection.ts`), a repair
floors at zero, a trade outside the window moves only lifetime counters, and an
injected-and-ignored skill is reported as never having counted. The hook toasts the repair
or its failure.

**Residues.** Only WIN↔LOSS transitions are reconciled; a row entering or leaving the
settled classes was never folded and is not invented here. The per-bot learning fold and
the strategy×regime matrix are not reconciled (they are separate records). A control trade
whose id has already fallen out of the 20-id tail cannot be identified as control. The
streak is read from the 12-outcome window, so a longer unbroken streak clips to 12 when a
rewrite touches it. Evidence decay is not replayed — the correction moves the current
counters by one unit, which is what the flip means. Status is not re-evaluated. The toast
path is pinned by contract, not by a browser probe: no probe seeds a skill AND a corrected
trade.

### 3. Import provenance (`69033a74`)

The library's origin line falls back to `"seeded"` when frontmatter has no `source`, so
every imported file was labelled with a provenance it did not have. The import path now
stamps `source: imported` into the head's frontmatter — text-level, so an author's body,
key order and comments are never reserialized — and an author-declared source wins. CRLF
keeps its line ending. Contract 7 carries the four cases.

**The trust grant itself was not built, and that is the audit result.** ThinkRail's grant
protects an **auto-load** surface: a cloned repo's `.pi/` settings, skills and MCP servers
load without a per-file choice. August has no such surface. A skill arrives only when the
trader picks a file or a URL, the destructive/exfiltration scan refuses at import, and
model-authored content goes through the human approval inbox. A per-project grant here
would be a toggle that removes nothing. What was missing was not enforcement but the truth
on the label; that is what landed.

**Residues.** `source: imported` is a label, not an enforcement. Bundled support files are
not stamped (they are not skills). An author-declared source wins even when it is false.

**Gates.** `typecheck` · `check:contracts` **169** (contract 14 + four contract-7 cases) ·
`check:boundaries` (523 files / 2,242 edges) · `check:docs` · `build` · `boot-probe` ·
`render-probe` · `lint` · workflow-shells · the probe-script parse and lint steps.

**Commits.** `79d0bfd5` (boundaries), `975a638c` (correction), `69033a74` (provenance).

## 43. The memory/skill write model: stated, observed, undoable (2026-10-29)

**Owner ruling.** No human approval gates on memory or skill writes. The model writes directly;
safety comes from automatic gates. `write_memory_note` may write `rules/` and `profile/`; `forget`
has no confirmation step. The audit's recommendations on those two paths are overridden.

**What landed**

| Path | Gate now applied |
|---|---|
| `remember` | existing secret/sensitive/honesty filters + the new trading guardrails; `author: 'model'`, `sourceTurnId: call.id`; stated-only; quote verification; version conflict; consolidation at the size cap |
| `write_memory_note` | secret + trading-guardrail filter; a valid verbatim `quote` writes where asked as **stated**; no/invalid quote routes to `reflections/` as **`[observed n=N]`** (n required) — context, never a rule; `if_version` mismatch returns current content; an invisible provenance comment (`author=model turn=… tag=… at=…`); a chip names where and the tag |
| `forget` | model-authored rows may be removed; a trader-authored row needs an explicit delete/forget request in the same turn; **soft delete** with a 30-day `undoUntil`; Settings → Assistant memory lists deleted rows with Restore |
| `amend_memory` | applied DIRECTLY (no queue); secret/guardrail filter; rules/profile require a quote; `if_version` conflict returns current content; the amendment row stores previous/applied bytes; Learning → Approvals shows it with **Undo** |
| `propose_skill` | deterministic draft gates still run; on pass the skill is created **directly as a candidate** (no Coach approval); only evidence promotes/retires |
| `revise_skill` | applied directly; IF/THEN re-validated; status and evidence unchanged; reason kept on the skill |
| `create_goal` / `update_goal` | secret + trading-guardrail filter over the goal's text |
| Read side | profile index excludes observed/inferred and sensitive rows; `read_memory` labels the tag and withholds sensitive rows from bulk reads |

**Observed vs stated is a folder rule:** any model note without a valid quote is written to
`reflections/` as `[observed n=N]`; it is not the skills index, not a rule, and not evidence. A rule
or profile note requires the trader's verbatim words.

**Verification.** Contracts **186** (new section 15: soft delete/undo/stale/observed; new section 9
cases: trading guardrails, explicit delete, observed tag, instruction folders; new chips in section
13). A node harness (localStorage + window/event shim) drove `executeDeskTools` end to end:
inferred rule → `reflections/fade-1600.md` `[observed n=7]`; `always give me a signal` → refused;
stated rule with quote → `rules/no-weekends.md` tag `stated` with provenance comment; stale write →
`conflict` + current content; API key → refused; `forget` without a request → refused, with a
request → soft-deleted with `undoUntil`; `propose_skill` → candidate; `revise_skill` → applied,
still candidate; `amend_memory` → applied, log row has previous/applied bytes. `typecheck` ·
`check:contracts` · `build` · `boot-probe` · `render-probe` · `skill-approval-probe` · `lint`.

**Residues.** Per-chat incognito is **not implemented** (the global memory switch is). The Coach
inbox is not yet an activity log: model writes are direct and recorded by the chat chip, while
pre-existing/system drafts still use the legacy pending list; its conversion is open. `propose_strategy`
and `forge_tool` keep their existing draft/candidate gates (a plan is a human-activated object; a
forged tool can make network calls). A revision preserves the skill's status, so a confirmed skill's
changed rule keeps its old evidence until the next fold. The chip and amendment-Undo UI are built and
type-checked but were not clicked in a browser probe; the write behaviors above were harness-verified,
not live-app-verified.

## 44. Candidate semantics and the index cap (2026-10-29)

**What changed.** The skills index names only **confirmed** skills under "APPLY"; candidates are a
single counted line of **hypotheses** (unproven, not rules, not applied). `memoryHints` receives
confirmed slugs only, and the row's `injectedSkills` records only what the index named. A candidate
still exists and is inspectable through `get_notebook_map`/`recall`; it is just not advertised as
usable.

**Live re-capture (same probe profile, same recorder).**

| Measurement | Before | After |
|---|---|---|
| System prompt | 16,875 chars | **13,579 chars** (−3,296, −19.5%) |
| Skills section | 3,406 chars, 12 candidate rows | **145 chars, one hypothesis line** |
| `skill_view` hints in the user turn | 2 | **0** |
| Tools offered | 22 | 22 |

The user-message size moved from 14,333 to 16,658 chars in the same capture; that block is the live
market packet and varies with the tape, so it is not a comparison of this change.

**Verification.** Contract 16: a confirmed skill is named under APPLY; a candidate is never named
as usable; candidates collapse to a count; with no confirmed skills there is no APPLY at all. The
live capture above confirms it on the real prompt path. `typecheck` · `check:contracts` **190** ·
`build` · `boot-probe` · `render-probe`.

**Residue.** The analysis-path retrieval can still show a candidate with a `prior` flag as context
(labeled 0W/0L), not under APPLY; the index itself no longer names candidates, so finding one is a
deliberate `get_notebook_map`/`recall` act.

## 45. Trade provenance: a staged `source` field (2026-10-29)

**Owner ruling.** Add `source ('manual' | 'imported' | 'signal')` to every journal row, default
existing rows to `manual`, with no behavior change yet.

**What landed.** `types/trade.ts` › `TradeSource`; `utils/tradeSource.ts` › `normalizeTradeSource`
and `withTradeSource`; both load paths (the profile/web loader and `SqliteService`) normalize a
legacy row to `manual`; both row-construction sites in `useTradeLogging` stamp `manual`. The SQLite
per-trade metadata column already carries extended fields, so `source` round-trips in the row JSON;
there is deliberately no indexed `source` column yet.

**Verification.** Contract 17: an absent field reads `manual`, an explicit source survives, and
normalization keeps the row. `typecheck` · `check:contracts` **193** · `build` · `boot-probe` ·
`render-probe`.

**Residue.** Nothing reads `source` yet — that is the ruling. The first consumers will be the signal
fold (`imported` never confirms a playbook; `signal` is the ledger) and the trade-history importer if
it is ever unfrozen.

## 46. Startup model-call gates (2026-10-29)

**What changed.**
- **Notebook review**: a review now runs only on a **material change** — a different index signature
  AND a 15-minute cooldown. The state is `memory_review_v1:<user>` in Preferences; it is stamped
  before the call, so a burst of writes buys one review. Pure rule:
  `utils/notebookReviewGate.ts` › `notebookReviewDue`.
- **Book-draft supervision**: an automatic supervisor pass skips `book:` drafts; they are deferred to
  a **manual** pass, which the inbox mount (`SupervisorStream`) runs once. Pure rule:
  `utils/skillSupervisionGate.ts` › `shouldDeferSupervision`.

**Fresh-profile measurement (same probe/recorder).**

| Call | Before | After (startup) |
|---|---|---|
| Notebook reviews | 2 | **1** |
| Supervisor book judgments | 12 | **0** |
| Chat turn | 1 | 1 |
| **Total startup requests** | **15** | **2** |

Opening the inbox still spends the 12 book judgments — that is the deferral target, not a
regression. The generic recorder used for measurement does not settle the probe's chat row; the
real `render-probe` (its own mock) passes after the change.

**Verification.** Contract 18: no prior review → due; same signature never; changed inside the
cooldown waits; changed after it is due; auto defers `book:`; manual takes it; other sources stay
automatic. `typecheck` · `check:contracts` **200** · `build` · `boot-probe` · `render-probe` · `lint`.

**Residues.** The inbox-open manual pass can spend up to `MAX_ITEMS_PER_PASS` (12) calls and bypasses
the hourly window budget (it is a human action). The review cooldown is a preference, not data; a
failed review still stamps the 15 minutes so a retry waits for the next material change.

## 47. The insight store stops being created and carried (2026-10-29)

**Owner ruling.** Stop carrying `insightKnowledgeBase` in the pipeline prop and stop writing it;
leave the stored column readable so backup restore keeps working; report anything that blocks full
removal.

**What changed.**
- `AlgorithmicMemoryService.updateGlobalMemoryAlgorithmically` no longer seeds an empty
  `insightKnowledgeBase` on a memory object that lacks one. Nothing else in `src/` assigns it.
- `useAnalysisPipeline` no longer imports the type, declares the prop, destructures it or lists it
  in the main effect's dependency array; `App` no longer passes it into the hook.
- Comments re-anchored to symbols: `types/learning.ts` › `TradeInsight`, `useAppSettings`, and
  `memoryHygiene` no longer claim a writer or a pipeline consumer that do not exist.

**What blocks full removal (reported, not worked around).** The field has one live reader:
`utils/memoryUtils.buildGlobalMemoryIndex` renders `GlobalMemory.insightKnowledgeBase.insights`
into the LAYER 3 memory index, which `GenericAnalysisService.analyzeTradingView` injects through
`constructOptimizedContext` (800-token cap). A profile that already carries entries still has them
shown to the model, so the type, the reader and the stored field stay. Deleting the field outright
would also delete what the SQLite column and `useProfilePersistence` restore from a backup — the
thing the ruling asked to keep readable. So: writer gone, pipeline copy gone, renderer and backup
round-trip intact.

**Verification.** Contract 19 is a source pin with a red-at-HEAD control: the pipeline file named the
field 3 times at `1b43e5a7` and 0 times now; `AlgorithmicMemoryService` had 1 assignment and has 0;
`memoryUtils` still reads `?.insights`; `SqliteService` still round-trips the column.
`typecheck` · `check:contracts` **204** · `lint` **375/379** · `build` · `boot-probe` ·
`render-probe`.

**Residues.** Old profiles keep whatever entries they had (not purged; no migration). The
`useAppSettings` state and its persistence round-trip remain — they are the backup path, not a
runtime input. `docs/research/TRADING-IMPROVEMENTS.md` P4 (wire or delete the consolidation half)
is still an open decision.

## 48. Phase 1 of the signal loop (2026-10-29)

**Scope (owner).** An append-only signal ledger, a deterministic resolver, a minimal `emit_signal`,
a Signal Card + Feed, and both gates in SHADOW. Nothing consumes resolved signals yet.

**What landed.**
- `types/signal.ts` — the ledger vocabulary. A signal is a direction, entry/stop/target, expiry,
  evidence refs, a tape hash, requested provider/model and the emit prompt revision; a resolution
  carries gross R, the named round-trip cost, net R, the bars it read, the path, ambiguity, and the
  venue provenance (`primarySource`, `crossCheck`).
- `services/signals/signalLedger.ts` — one localStorage namespace per user
  (`signal_ledger_v1:<user>`), append-only events (`emit`/`gate`/`ground`/`resolve`). A second
  resolution for one id is REFUSED, so history cannot be rewritten. The cap drops whole oldest
  signals (150 or 200 KiB), never an isolated event. Registered on both `ExportService` lists and
  capped for backup (256 KiB) — a restore carries the calls, not just the journal.
- `services/signals/signalResolver.ts` — closed-candle settlement. Entry touch fills; the first stop
  or target after that decides; a bar with both drills into 1m and settles STOP-FIRST when the order
  is still unknowable (`ambiguous: true`). At expiry the open call is marked to the last closed bar.
  A call with no entry touch is `never_triggered` (R 0, no cost), not a loss. No lookahead: a bar
  must OPEN at/after emission and CLOSE by expiry. Costs: `SIGNAL_TAKER_FEE_RATE` 5 bps +
  `SIGNAL_SLIPPAGE_RATE` 2 bps per side, charged in R against the stop distance.
- `services/signals/signalMarketData.ts` — OKX 5m closed candles are primary (public, keyless), 1m
  is the drill-down, Binance 5m is the cross-check on the bars that DECIDED the call (10 bps
  tolerance; a missing bar reads `unavailable`, never `agree`). A tape that starts after the
  emission cannot settle the call — it stays open and the feed says why.
- `services/signals/signalService.ts` — `emitSignal` validates coin/bracket/expiry/evidence before
  writing; the two shadows never block: the programmatic gate (`GateKeeperService`) runs
  fire-and-forget and is appended as a `gate` event, and the evidence check is local and synchronous
  (`ground` event: tool-like refs must name real desk tools; prose refs are citations).
  `settleDueSignals` fetches at most 4 open signals per pass (60 s cooldown; the feed's button
  forces) so a UI mount cannot fan out one series per signal ever emitted.
- Desk tool: `emit_signal` is in `DESK_TOOL_DEFINITIONS` and the INITIAL set (14 tools now; its
  schema is 1,296 chars, initial set 11,351 of 42,726). The executor maps the turn's `liveMarkPrice`
  / forming candle onto the tape hash and takes `modelName`/`providerId` from the loop (the REQUESTED
  model; a provider-side substitution is not visible here, so an absent value reads `unknown`).
  The transcript gets a chip ("BTCUSDT long · 3R — Journal → Signals"); the Agents surface carries
  the tool, a detached skill evaluator does not (`UNATTENDED_DENY`).
- UI: Journal gains a **Signals** tab (`SignalFeed` + `SignalCard`) — summary strip (hit rate,
  expectancy after costs, ambiguity rate, emitted/open/no-entry, shadow-gate sides), the card's
  levels and outcome, and a settle button. The empty state explains what a signal is.

**Live settlement receipt (real tape, synthetic bracket).** Anchored to the OKX 5m bar closed
2026-10-29 11:10 UTC (BTC-USDT close 80,210.7), entry 80,210.7 / stop 79,408.6 / target 81,012.8,
expiry one minute before the run:

```
SETTLE RESULT {"attempted":1,"resolved":1,"skipped":[]}
RESOLUTION {"status":"expired","grossR":0.1379,"feeR":0.1400,"outcomeR":-0.0021,
            "path":"bar","ambiguous":false,"crossCheck":"agree","primarySource":"okx"}
```

35 closed 5m bars were read; the Binance cross-check agreed on every deciding bar. That is the
honest shape of a 1 %-stop call: the 0.14 % round trip nearly cancels a +0.14 R drift.

**Verification.** Contract 20 (26 cases): bracket rules, cost math, target-first win, stop-first
loss, both-hit stop-first without a drill, 1m drill ordering, a 1m bar with both still ambiguous,
expiry mark-to-market, post-expiry and pre-emission bars excluded, never-triggered at zero cost,
the summary's fill/never-triggered split and per-side gate means, ledger append/fold/duplicate-
resolution refusal/cap, OKX parse (closed only, ascending), cross-check agree/disagree/unavailable,
tape coverage, and the emission refusals (inverted bracket, expiry range, empty evidence) plus the
evidence shadow. `typecheck` · `check:contracts` **230** · `check:boundaries` (532 files, 2,278
edges) · `check:docs` · `lint` **375/379** · `build` · `boot-probe` · `render-probe` (5 new rows:
Signals tab reachable, feed mounts, seeded card drawn, outcome after costs stated, venue
cross-check named). Plus two node harnesses: the desk tool writing ledger bytes through the real
executor (provenance, tape hash, cited/missing evidence, inverted bracket writes nothing), and the
live settlement above.

**Residues (none of them hidden in the UI).**
- Resolution starts at the first FULL 5m bar after emission; a fill in the emission bar's remaining
  seconds is not counted. Conservative by the no-lookahead rule.
- OKX `/market/candles` is 300 bars (25 h). Signals older than that stay open with a named reason;
  no history pagination yet.
- Settlement is a feed-mount pass (4 signals, 60 s cooldown), not a background timer. An app left
  open past an expiry settles on the next Signals visit.
- The gate shadow costs one `fetchGateInputData` scan (5 public reads) per emission, in the
  background. The evidence shadow is local; `dataHash` fingerprints the app-known mark/forming
  candle, not the whole prompt.
- Nothing reads resolutions yet: no skill fold, no calibration, no base rate. That is the scoped
  next phase.

## 49. The chart scan studies every candle (2026-10-30)

**Owner ask.** `scan_chart_skills` must actually look at all the candles, study how the price moved, answer
"if we could turn back time, when was the best time to trade", and especially find the big moves (>10% up —
a long entry if you were in at that time; the mirror for shorts). Create skills for that — pattern-first,
not a generic IF/THEN rule.

**What was wrong.** The scan already FETCHED 1000 bars, but the model only saw a digest: regime segments,
14 pivots, gap counts, RSI counts, top-10 detector win-rates and the LAST 40 raw rows. There was no
time-of-day read and no list of the actual big moves, and the candidate write still went to the approval
inbox — contradicting the 2026-10-29 direct-write ruling.

**What landed.**
- `services/learning/chartTapeStudy.ts` — pure full-tape studies. Every bar is sampled with a 12-bar
  forward horizon and bucketed by hour of the TRADER's clock (PHT): mean |move|, signed drift, up share,
  mean favourable/adverse excursion. Swing legs are found as the lowest (or highest) close in a 24-bar
  window followed by ≥10% in the opposite direction — non-overlapping, entry at the extreme — and each leg
  records the state BEFORE it: prior 6-bar return, volume ratio (3/20), range compression (6/24), gap and
  RSI. Candle anatomy (up-bar share, body/range, top-third closes, expansion bars) and run lengths are
  measured too. `phtHourOf` joined `utils/timezone.ts` for the bucket arithmetic.
- `services/learning/chartScanSkills.ts` — the digest now leads with the full-tape study, states that
  EVERY bar was analysed and that only the final 20 raw rows are a subset, and fits a
  `CHART_DIGEST_MAX_CHARS` budget that drops the raw tail (never the study) and NAMES what it dropped.
  The prompt is pattern-first: repetition is required (≥3 similar events or a stable hour bucket), a
  single spectacular leg is not a rule, IF/THEN is only the compact trigger summary.
- DIRECT CANDIDATE WRITES: `gateEvidenceBackedDraft` gained an optional `createCandidate` sink and a
  `created` result; the scan passes a sink that calls `ingestCraftedSkillFromDraft`. The approval inbox is
  no longer part of this source. The other draft sources (book drafts, pass mining, self-improvement,
  session review) still queue — the change is scoped, and a contract control pins that.
- Surfaces: the tool description, the ChatComposer "Scan → skills" prompt, the prompt-registry entry and the
  chat mandate all now say full-tape/hour/leg study and direct candidates, not "pending approval".

**Live measurements (real Binance 1h, 1000 bars, 2026-10-30).**

| Tape | Digest | Samples | ≥10% legs | Facts found |
|---|---|---|---|---|
| BTCUSDT 1h | 4,895 chars | 988 | 0 up / 0 down | largest up **+7.5%**, largest down −4.3% (reported below threshold); most movement 13:00 PHT (1.10%), 11:00 (1.07%), 12:00 (1.07%) |
| DOGEUSDT 1h | 5,160 chars | 988 | 1 up / 1 down | up +10.1% at **21:00 PHT**, vol 0.6×, range 0.65× compressed, RSI 38 · down −10.7% at **11:00 PHT**, prior 6 +3.4%, RSI 72 |

Both digests are inside the 14k cap. The study itself runs in ~175–211 ms per 1000 bars (no model call).
A quiet tape reports its largest leg below the threshold instead of "no big moves" with no scale, and a
down leg prints as −10.7%, never +10.7% (pinned by contract).

**Verification.** Contract 21 (13 cases): PHT hour mapping; per-hour drift/up-share from every sampled
bar; a 10%+ up leg starting at the lowest close with finite antecedents and non-overlap; the explicit
down mirror; the below-threshold largest; run lengths; the section names; the down-leg sign; the digest
budget dropping the tail by name; a 1000-bar digest that states the full-tape claim and stays under the
cap with ≤16 leg lines; the prompt's pattern-first/PHT/turn-back-time text; and the source pin that the
scan creates directly (control: `bookSkillDrafts` still queues). `typecheck` · `check:contracts` **245** ·
`check:boundaries` (533 files, 2,282 edges) · `check:docs` (338 symbol citations) · `lint` **375/375** ·
`build` · `boot-probe` · `render-probe` · `skill-approval-probe` **28 PASS / 0 FAIL**.

**Residues.** The 10% threshold and 24-bar window are constants (the digest always names the largest leg
when nothing qualifies). Hours are PHT only. Time-of-day numbers are descriptive forward-close statistics
— no significance test and no costs are attached, so the model is told to require repetition rather than
treat a 1.1% mean move as an edge. The scan still needs one AI provider call; with none it returns
unavailable. The skills it creates are candidates like any other model write — evidence alone moves them.

## 50. Signal accuracy: the base rate and the feedback leg (2026-10-30)

**Scope.** The next phase the last report left open: read resolved signals and measure them honestly —
hit rate against what the same levels would have done entered at a random time — then feed that back
into the next emission. This is the accuracy fold, NOT the skill evidence fold (b3), which stays frozen.

**What landed.**
- `services/signals/signalAccuracy.ts` — `baseRateFor` simulates the SAME risk/reward percentages and
  the SAME time-to-expiry entered at every bar's close of the same tape, through the same
  `resolveSignal` (so same-bar both-hit is still stop-first). `scoreSignals` returns fills, hit rate,
  mean base, lift, expectancy, ambiguity and a THIN flag below `MIN_ACCURACY_FILLS` (20).
- Settlement stores the baseline on the resolution (`SignalResolution.base`: samples, hit rate,
  horizon bars, risk/reward pct). Resolutions written before this fold simply have no `base`; the feed
  says "no same-levels baseline yet", never 0%.
- The feed's summary gained a **vs base** stat: `hit rate vs base · lift ±N pts · N=fills`, with
  `thin` below the floor. The footnote now says a hit rate means nothing without the baseline.
- THE FEEDBACK LEG: `signalScorecard(coin)` reads this coin's resolved calls and the `emit_signal`
  receipt carries it. The model makes its next call with the last ones' graded record in front of it;
  the receipt's note says a `thin` scorecard is not an edge to claim.

**Live receipt (real OKX tape, synthetic bracket, 2026-10-30).**
```
RESOLUTION {"status":"expired","grossR":-0.2293,"feeR":0.1400,"outcomeR":-0.3693,
            "crossCheck":"disagree","primarySource":"okx",
            "base":{"samples":299,"hitRate":0.1940,"horizonBars":35,
                    "riskPct":0.010000,"rewardPct":0.010000}}
```
299 same-levels entries on that tape hit target-before-stop 19.4% of the time; the emitted call
expired at −0.37R after costs. The Binance cross-check **disagreed** on this run (the previous run
agreed on identical mechanics) — the venue provenance is recorded, not smoothed over.

**Verification.** Contract 22 (8 cases): a trending tape produces a high base; a tape whose bars
contain both levels produces a ZERO base (stop-first); no distance → no baseline; score = hit rate vs
mean base with lift and `thin`; a resolution without a stored baseline is unmeasured, not 0%;
`summariseSignals` carries the pair; and two source pins (the baseline is computed at settlement; the
emission receipt carries the scorecard). `typecheck` · `check:contracts` **253** · `lint`
**375/375** · `check:boundaries` (534 files, 2,286 edges) · `check:docs` · `build` · `boot-probe` ·
`render-probe` (the "vs base" row is asserted rendered on the seeded card) · `skill-approval-probe`
**28 PASS**.

**Residues.** The baseline enters at each bar's close (immediate fill) — a signal that waits for a
pullback is compared against an always-in trader, the harder baseline. Base rates are gross hit rates
(costs are applied to the signal's R, not the base). A per-signal base of 299 samples is descriptive;
the THIN floor applies to the number of resolved SIGNALS, not the simulation sample. Calibration by
stated probability is not possible yet — signals carry no probability, and the gate's cap is not a
calibrated forecast. The skill evidence fold (b3: resolved signals confirming/denying playbooks) is not
built, per the standing ruling.

## 51. Skills lose the IF/THEN pair (2026-10-30)

**Owner ask.** Drop the if-condition and then-action fields completely. Not every skill is purely
pattern-based — it can be, but not all; let the model generate skills using the proper format.

**The format now.** A skill is a **trigger + a procedure**: `when` (one checkable trigger sentence),
`steps`/body (the procedure), `description` (the activation key), and the optional `predicate`.
There is no `ifCondition`/`thenAction` pair anywhere in the skill entity.

**What changed (one coherent cut).**
- Schema: `CraftedSkillSchema` no longer declares the pair; `parseCraftedSkill` strips it from any
  old payload.
- Storage: `SkillMeta` carries `when?` instead of `ifCondition?/thenAction?`; `serializeSkill` writes
  `when:` and never the pair. `parseSkillMarkdown` maps a legacy `ifCondition` key into `when` on
  read; the old keys are no longer KNOWN frontmatter, so they ride through as unknown keys and no
  file loses bytes. The shadow/previousVersion snapshots carry `when` + body.
- Gates: `validateIfThen` → `validateTrigger` (specific, non-generic); coverage, draft trigger keys,
  duplicate detection, tombstones, activation, consolidation, the library-cap challenger, skill
  generalization/graveyard/import dedupe and the contradiction sweep all compare triggers.
- Tools: `propose_skill` dropped `if_condition`/`then_action` (required fields are now
  name/kind/when/steps/reason); `revise_skill` replaces them with `when` and `procedure` (the body),
  applying directly. The desk executor, prompts, chips and mandate text follow.
- Builders: session review, pass mining, self-improvement, book seeds (their triggers moved from
  `ifCondition` to `when`), the chart scan and the worth gate produce no pair. The worth gate may
  tighten `when` only.
- UI: SkillDetail shows "Trigger", the refine diff shows `When`; Coach draft cards show "When …"
  plus the step count; the version-history, memory-graph and trader-profile cards read `when`; the
  skill-proof text is built from the trigger.
- Chat surface: the skills index line is description + "When …"; the scan chip and prompts no longer
  promise IF/THEN drafts or Inbox approval (candidates are created directly).

**Verification.** Contract 23: a trigger+steps craft parses; legacy IF/THEN input is not carried onto
the craft; a craft without `when`/`steps` is refused; the trigger bar refuses generic/short; the
written file carries `when:` and no pair; it round-trips; a legacy file migrates `ifCondition` into
`when`; the index row exposes `when` only; `propose_skill` has no old fields; six draft builders
write no pair. Full ladder: `typecheck` · `check:contracts` **268** · `check:boundaries` ·
`check:docs` · `lint` **375/375** · `build` · `boot-probe` · `render-probe` ·
`skill-approval-probe` **28/28** (its fixtures now carry `when`/body; the rescope test proves a
trigger+body rewrite lands in the notebook bytes).

**Residues, named.**
- `LearningRule` (`learning_rules_v2_<user>`) and the settlement reflection's post-mortem note are
  NOT skills; they still carry their own IF/THEN clause shape (`parseIfThenClauses` feeds the
  reflection's skill candidate by mapping the clause into `when` + body). Migrating that legacy
  rules store is a separate ruling.
- `bookSkillDrafts` call sites still pass their two old strings as `_`-prefixed unused arguments
  (the book's source table); they never reach the craft.
- Existing files keep their `ifCondition:`/`thenAction:` lines as unknown frontmatter until a
  rewrite; the app reads `when` (migrated from the old key) and ignores the pair.
- A rewrite now snapshots and restores `when`/body; a legacy `previousVersion` carrying only the old
  keys is read through `ifCondition` for revert, but its `thenAction` is not restored as a field
  (it lives in the body).

## 52. The journal-rules store moves to when + action (2026-10-30)

**Owner ask.** Migrate the rules store to the new format.

**What it is.** The flat journal-lesson index beside skills (`learning_rules_v2_<user>`): one trigger
+ one action per row, learned from a settled trade's post-mortem and printed into both chat homes as
"Rules learned from this journal" (up to six lines, memory switch gated). It is NOT the skills
library — a rule can exist where the skill gate refused or merged the candidate.

**What changed.**
- `LearningRule` now carries `when` (trigger) and `action` (what to do); `outcome` is optional so a
  legacy row with no recorded win/loss prints without a source claim.
- `utils/learningRuleFormat.ts` — the pure, idempotent normalizer: a row with `ifCondition`/
  `thenAction` becomes `when`/`action` with its id, trade, coin, outcome, counts and status intact; a
  row that cannot be printed (no trigger or no action) is dropped. Re-running it on converted rows
  reports `migrated: false` and returns identical bytes.
- `StorageService.loadLearningRules` normalizes on READ and persists the converted store once; the
  pre-multi-user key migration goes through the same normalizer. `saveLearningRules` normalizes at
  the WRITE edge, which is where the profile loader seeds rows from an old profile or backup.
- `learningRules.recordLearningRulesFromPostMortem` writes `when`/`action` and dedupes on them.
- `learningRulesIndex` prints `- BTC · When … → … · learned from a loss`; no `IF`/`THEN` token.
- The post-mortem TEXT keeps its `IF … THEN …` sentence (that is prose in the journal note), and the
  parser maps it into the rule's `when`/`action` and the skill candidate's `when` + body.

**Verification.** Contract 24: a legacy row converts with metadata intact and no old keys; the
normalizer is idempotent; an unprintable row is dropped while a complete one survives; the prompt
line prints When → do and no `IF`; no rows → no block; the store normalizes on read and write; the
writer emits `when`/`action` and never the pair. A node harness against the REAL `StorageService`
proves both edges on stored bytes: a legacy `learning_rules_v2_rules-user` value loads converted and
is rewritten on disk, a second read does not churn it, and a legacy profile/backup seed passed to
`saveLearningRules` is converted at write. Ladder: `typecheck` · `check:contracts` **275** · `lint`
**375/375** · `check:boundaries` · `check:docs` · `build` · `boot-probe` · `render-probe` ·
`skill-approval-probe` **28/28**.

**Residues.** Old rows are kept as rows, not archived — the migration rewrites their fields in place
(`ifCondition`/`thenAction` keys are not preserved in this store; they were app-owned, unlike
third-party skill frontmatter). The settlement reflection's post-mortem prose still uses the words
"IF/THEN" and is parsed into the new shapes; renaming that prompt is a separate change. The rules
store remains a deliberate second view of a journal lesson beside skills.

## 53. The post-mortem writes When …, do … (2026-10-30)

**Owner ask.** Apply the parser change for the residue — the settlement reflection's note was the last
place a model was asked for, and a note stored, an `IF … THEN …` pair.

**What changed.**
- The reflection prompt now asks for `{"when", "action"}` (was `ifCondition`/`thenAction`), and the
  rules line names them. `SettlementReflectionSchema` requires `when`/`action`.
- `renderPostMortem` writes `When <trigger>, do <action>.` instead of `IF … THEN …`.
- `utils/ifThenSkill.ts` is gone. `utils/lessonClause.ts` is the one parser/formatter:
  `parseLessonClauses` returns `{when, action}`; it reads the current `When …, do …` sentence first and
  STILL reads the legacy `IF … THEN …` and `When …, then …` forms, because post-mortems written before
  today are stored text. `formatSkillProcedure` writes the `**When:**` / `**What I do:**` body.
- `ingestIfThenFromTrade` → `ingestLessonFromTrade`; every consumer (skill candidate ingestion, the
  journal-rules writer, the craft service, self-improvement, the review/format comments) uses the new
  clause shape directly — the previous intermediate mapping (`clause.ifCondition → when`) is gone.
- The old `AlgorithmicSummaryService` legacy-note reader is untouched: it parses historical post-mortem
  text for a summary and is not a writer.

**Verification.** Contract 25: the current sentence parses into `{when, action}`; a legacy IF/THEN note
still yields the same shape; a placeholder side is dropped; the procedure body has no IF/THEN tokens;
`renderPostMortem` writes `When …, do …`; the schema accepts the new fields and REFUSES a legacy-shaped
answer; the prompt asks for `when`/`action`; the old module is deleted and nothing imports it; the
notebook ingest is named for the lesson. Ladder: `typecheck` · `check:contracts` **285** · `lint`
**375/375** · `check:boundaries` · `check:docs` · `build` · `boot-probe` · `render-probe` ·
`skill-approval-probe` **28/28**.

**Residues.** Stored post-mortems written before today keep their `IF … THEN …` sentence; the parser
reads it (that is the compatibility arm, tested). `AlgorithmicSummaryService` still matches the legacy
`IF/THEN Rule:` patterns when summarising an old note. No live model call was made for this change — the
prompt/schema/parser/renderer are contract-tested, and the next settled trade is the first live note in
the new shape.

## 54. Settings → Memory is the reference's memory page (2026-10-30)

**Owner ask.** Focus on the UI: how memory is shown today, with the target being the reference's
Settings → Memory page (switches, named topics grouped by section, a row opens the entry's own page).

**What it looked like before.** Two surfaces, neither matching: Settings → Memory was a header, a
boxed "Notebook" group (a link to the Learning browser and the memory model) and the assistant-memory
entries as inline-expanding rows with kind chips, per-row Edit/Delete, a checkbox for auto-learning,
and a "recently deleted" drawer. Learning → Memory already showed the NOTEBOOK as grouped topic rows
with a right-panel detail — the content surface. The Settings page showed storage-shaped rows, not a
memory page.

**What landed (Settings → Memory).**
- The switch stack: **Generate memory from chats** (the trader-learning auto-distiller) and
  **Include sensitive topics in memory** (`harnessSettings.sensitiveMemoryEnabled`, default OFF — the
  same flag the write path already refuses sensitive facts on). Both are the real settings, not props.
- **Export memory**: a Markdown download of every entry (label, updated ISO stamp, summary, details,
  provenance), grouped one section per category. The notebook is named as a separate export.
- **One section per category, and the model can create them**: a row's section is its own `section`
  label (the model names it on `remember`, free-form — "Trading", "Risk", "Instruments", …) and
  falls back to its `subject` for rows written before the field. Custom sections sort first, then the
  fallback sections; a new name in `remember.section` becomes a new section with no registry. The
  always-loaded memory index prints up to six existing section names so the model reuses a spelling
  before inventing one. Three columns — label (`memoryEntryTitle`), one-line summary (`description`),
  updated stamp — in the reference's column: the page is NOT full-bleed (it was, flush against the
  sidebar with rules 922px wide); it is a full-width column inset 40px from the pane edge, matching the
  reference's 30px inset at a 1600px window. Rhythm, measured in the live app: a hairline rule above
  each category, 16px from the rule to the heading, a 45px heading-to-first-row gap, 49px rows
  separated by hairlines, 14px row text, a 200px label column and a 300px updated column. The page
  title is the reference's modest 18px with no kicker and no rule. Hover raises the row pill and the
  bare pencil/trash, which overlay the row's right edge instead of reserving a column (reserving one
  pulled the updated stamp 40px left of the reference).
- **Short titles**: `remember.name` used to exist only to derive a slug, so a fact described in a
  whole sentence produced a slug that ellipsized in the label column. The name is now stored as
  `title` (≤60 chars, 2–5 words) on the entry, the learner stores its humanized `name`, and the row
  label, the detail title and the export heading all use `memoryEntryTitle` — the stored title, else
  the humanized slug for legacy rows. An edit that omits the title keeps the existing one.
- A row opens the entry's own page, which REPLACES the page title (the back link leads): title, Delete,
  then labelled blocks — "Last updated" above the day, **Summary** (`description`), **Details**
  (`body`) — then provenance chips and Edit. Edit keeps the store's version conflict handling; Delete
  is the existing soft delete with the 30-day undo drawer on the list.
- "Notebook files" remains one door to the Learning browser; the memory model row appears when one is
  configured. Hover reveals the row's pencil and trash, like the reference.

**Deliberately not copied.** "Import memory from other AI providers" has no August implementation, so
it is not shown (a button that cannot work is a lie). The reference's "Tell Claude what to change"
line is that app's global composer, not part of Settings → Memory; August's chat lives on its own
surfaces.

**Verification.** Contract 26: the export's categories, custom-first order, the section normalizer and
fallback/order rules, an entry's title/summary/details/updated stamp, the PHT-dated filename, the empty
document, both switch labels wired to their real settings, grouping by `subjectOf`, the export calling
the real download helper, the notebook door, `memoryEntryTitle` preferring a stored title and falling
back to the humanized slug, the export heading using that title, and both model write paths storing it.
`render-probe` seeds five entries (one per category plus a model-created "Trading"), one with a long
slug and a short title, opens Settings → Memory and asserts custom-first category groups, all five
rows, the long slug rendering its short title, both switches with their own `aria-checked` state, the
export control, a row opening the detail with title/Summary/Details, and Back returning to the list.
Layout was measured in the live app (Playwright against the dev server at 1600×1000, reading
`getBoundingClientRect` rather than a screenshot): pane inset 40px, title 18px/600, 45px
heading→row, 49px rows, updated column 300px. Ladder:
`typecheck` · `check:contracts` **301** · `lint` **375/375** · `check:boundaries` · `check:docs` ·
`build` · `boot-probe` · `render-probe` · `skill-approval-probe` **28/28**.

**Residues.** The page shows the ASSISTANT memory store; the notebook remains the Learning surface's
browser (a link, not a copy). The sensitive default is OFF (the reference's default is ON); that is the
app's existing stance, now visible here. The row's updated column is relative for recent entries and a
date for older ones, exactly as the reference's own column behaves; the detail page names the day.
Sections are labels, not a registry: the model can create a near-duplicate ("Trading" vs "Trading
Style"), and the index's six-name list is guidance, not enforcement. Existing rows keep their subject
fallback until a write names a section.

## 55. Every settings page shares the memory page's frame (2026-10-30)

**Owner ask.** After the Memory page was matched to the reference, make every Settings entry use that
same space and UI.

**What it looked like before.** Nine pages, six headers: five tabs drew a 28px title with a
"Workspace settings" kicker and a rule (and a `max-w-3xl` centered column), Memory had an 18px bare
title with no kicker, Prompts a 30px title inside its own frame, Playbooks a 16px bold title inside a
second header strip, and Instructions had no page title at all. Groups were boxed cards with an 8x8
icon tile per row on one page and hairline rules on the next.

**What landed.**
- **One pane frame** (`SettingsMenu.tsx`): every non-full-bleed tab renders
  `px-8 py-8 lg:px-10 [&>*]:w-full` — a full-width column inset from the pane edge, the reference's
  measure — instead of two competing centered widths.
- **One page header** (`tabs/shared.tsx`): an 18px/600 title with a 28px top inset (60px from the
  pane top), an optional 14px muted description, no kicker and no rule. The `bare` variant is gone
  because there is no longer a second style to opt out of.
- **One row language** (`SettingsGroup`/`SettingsRow`): a hairline rule above each group, a 14px
  medium heading, 49px rows separated by hairlines, a bare muted icon (no tile), a 14px near-white
  title and 14px muted description — the Memory list's own rhythm.
- **The three editors aligned**: Prompts' 30px title became 18px and its centered 4xl column dropped;
  Playbooks' duplicate header strip was deleted and its Strategy Studio button moved into the
  manager's header (whose title is now the page header); Instructions gained the same page header.
- Settings → Memory lost its one-off `pt-7`; the detail page keeps that inset when the header hides.

**Verification.** Playwright against the dev server at 1600×1000 measured all nine pages after
switching tabs: every one reports its title at x=507, y=131, 18px/600, and no page contains
"Workspace settings". `render-probe` (150 checks) exercises the same Settings navigation and the
Memory page.

## 56. A kill gate for triggers, and protections for signals (2026-10-30)

**Why.** The research loop's discipline is the kill rate: test before shipping. August's signal loop
graded calls forward and its skills earned evidence forward, but nothing refused a drafted trigger
that had never met the tape, and the signal layer had no stop-digging rules at all.

**Kill gate** (`src/services/learning/historyKillGate.ts`). A crafted skill with a machine-checkable
`predicate` is replayed over the same candles the scan studied: entry is the next bar's open, the
forward window is `horizonBars`, and the question is whether a fire precedes a 1R (ATR) move more
often than an arbitrary bar (lift ≥ 1.25), on at least 8 fires, while firing on ≤ 60% of the tape.
`kill` refuses the candidate before the ingest (`chartScanSkills`), `insufficient` and `invalid` never
count as a keep, and prose-only candidates pass unlabelled because prose cannot be replayed. It is
direction-agnostic on purpose: the trigger's job is to precede movement; the plan carries direction.

**Signal protections** (`src/services/signals/signalProtections.ts`). Read settled signals only, in R:
three straight losses inside six hours cooldown the seat; a 20-call window at or below −6R trips the
drawdown breaker; a full 8+ window that nets ≤ 0R retires the setup. A blocked emission writes nothing
— the ledger must not carry a call the app refused to stand behind. `emitSignal` checks them before
the append.

**Verification.** Contracts 27: the kill gate kills a whole-tape trigger, and reports invalid /
insufficient rather than pass; the protections block on cooldown, let it expire, trip the drawdown
breaker and the low-profit rule, and block nothing on an empty history. `check:contracts` **310**.

## 57. The rename reaches installed apps, and the model can edit the harness (2026-10-30)

**Upgrade path.** The product is **August Trading**; the project/package are **`augustTrading`**
(package `august-trading`) after the interim "August Trading Harness" name was retired. `appId` stays
`com.august35.tradingapp` on purpose: NSIS keys the install and its upgrade path on the appId, so
changing it would strand every existing install as a separate app. The userData folder follows the
product name, so `electron/main.cjs` carries EVERY previous folder (`August Trading Harness`, then
`August Trading`, then `August 3.5`, newest first) into the new one on the first packaged boot,
stamped per folder and never clobbering new files. The GitHub repository is now
`KILLER3UG/augustTrading` (transferred from `Acepay25/augustTrading`, which still redirects);
`build.publish.owner`/`repo` and the local `origin` follow it, so the updater feed and pushes point at
the transferred repository.

**Repo bridge (dev only).** The model can read and replace files in August's own checkout when the
desktop app runs from source with `AUGUSTTRADING_REPO` set: `repo_read` (or list the root),
`repo_edit` (full new content; refuses empty), `repo_apply` (runs `npm run typecheck` and returns
its tail). Main enforces ONE sandbox (`shared/repoSandbox.cjs`): repo-relative only, no drive/absolute
paths, no `..` escape, and no `node_modules`/`.git`/`dist`/`.env`/binary files. Every write copies
the previous bytes to `.august-checkpoints/<timestamp>/<path>` (gitignored) before an atomic
replacement, and the dev server applies the save; typecheck is the apply gate. Packaged builds report
the bridge unavailable rather than pretending — the installed app has no dev server to apply edits.

**Verification.** Contract 28 pins the sandbox: in-repo paths pass; `..`, absolute/drive paths,
dependency/build/git trees, `.env` and binaries are refused; no root refuses everything.
`node --check` on main/preload, typecheck and contracts **316**.

## 58. The installed app can run a checkout it clones for itself (2026-10-30)

**Owner ask.** "Implement like how Hermes does": the installed app should clone the repo and run
that repo, so the model edits real code and the edit reaches the running app.

**What landed (Option B, opt-in by environment).**
- `AUGUSTTRADING_CLONE_URL` names the repository. When the packaged app boots without a checkout
  and the variable is set, it clones into `<userData>/harness-src` (depth 1), runs `npm install`,
  then `npm run build`; the `app://` protocol resolves the served root **per request**, so the
  window reloads onto the checkout's `dist` and later launches serve it directly (the root is
  re-discovered from `<userData>/harness-src` at boot).
- `repo_setup` is the same flow as a tool (no arguments — the URL is owner-configured, never
  model-supplied), for a machine where the auto-start was skipped. One setup at a time.
- `repo_apply` changes meaning by mode: dev runs `typecheck` (the Vite server already applied the
  save); the installed self-hosted app runs `build` and reloads onto the bytes it produced. A failed
  build changes nothing — the previous `dist` keeps serving.
- Unchanged: the repo sandbox, the per-write checkpoint, and the dev path (`AUGUSTTRADING_REPO`).

**Operational cost, stated up front.** The self-hosted app needs **git, npm and network** on the
trader's machine, a first-run install/build measured in minutes, and `node_modules` on disk. A
private repository needs credentials available to git. Without the variable the app runs the
installer bundle exactly as before.

**Security.** The clone URL comes from the environment, not from a tool argument, so a seat cannot
point the installer at an arbitrary repository; `npm install` still runs that repository's scripts.
Once built, model-edited code runs with the app's privileges — this is the Hermes trade the owner
asked for, which is why it is opt-in and sandboxed to the checkout.

## 59. An empty round is repaired silently, and the learning surface stops asking (2026-11-03)

**Owner report.** The transcript showed `thinking hit the round's token ceiling with nothing to
show` and `THE PROVIDER STOPPED EARLY`; the thinking block still drew a box; the Learning surface
had an Approvals tab (the old Coach) with nothing to decide; every skill file was expected to
follow one format; the rail's Customize row rendered the Learning tab; and an attached image
appeared only after its decode finished.

**What landed.**
- **The empty round cannot end the turn.** A round with no call and no word is re-asked SILENTLY.
  The first repair doubles the room and steps the effort down — and it may EXCEED the caller's
  budget, which the old `Math.min` clamp forbade (a 400-token clarification was re-asked at 400
  tokens). The second repair removes the thinking channel (`off`) and the tools (`toolChoice:
  'none'`) so the round can only produce words. Reasoning-with-a-clean-stop counts as empty. A
  partial text continuation also gets the doubled room. No tool line announces either repair, and
  a recovered run still suppresses the truncation notice.
- **Thinking draws no frame.** `.thinking-row` is `border: 0`, transparent, `animation: none` — the
  last part matters because the running border-colour animation beats a normal declaration. The
  trace body has no top/left rule; settled traces render through `MarkdownContent` (paragraphs,
  lists, emphasis) at the trace's muted tone.
- **One skill format, repaired.** `skillFormatIssues` audits every file (slug name, `when`,
  `description`, non-empty body, hard cap); `deriveSkillFace` derives the missing face from the
  file's own words; `repairSkillFileFormats` runs at boot and rewrites a non-conforming file
  through the ONE serializer, refusing ghosts, underivable files, and rewrites that do not reduce
  the issue count. The Health tab still lists whatever remains.
- **No approvals, no coach.** The Learning tab row is Skills → Memory → Health; skill drafts
  auto-apply through the existing deterministic gates with an attempt budget; the memory
  corrections log (and its one Undo) moved to Settings → Memory; `ActionApprovals`,
  `CoachThreadPanel` and `utils/approvalInbox.ts` (renamed `autoJournalRules`) are deleted.
  `amend_memory` was already a direct write; its tool copy now names the new home.
- **Rail.** Workspaces group the profile list (active one expanded over its conversations), rows
  carry the reference's right-aligned age (`now`, `5m`, `3h`, `48d`), and Add workspace opens the
  ONE profile creator. The old Customize row is now **Skills** and lands on Learning → Skills —
  label and destination agree.
- **Attach.** The chip mounts on the change event in its loading state (a pulsing thumbnail) and
  fills in place when the read lands; the send path filters unloaded chips.

**Verification.** `typecheck`; `check:contracts` **486** (silent empty-round repair, budget
exceeding the caller's ceiling, second-try tool/thinking removal, reasoning-only stop, serializer
gold output, face derivation, boot repair); `lint` 0 errors; `check:docs`; `check:boundaries`;
`render-probe` **194 checks**, including computed styles proving the trace has zero border, no
fill and no rules, a 4 MB attachment observed loading before its decode, and the rail's nested
conversation age column — zero pageerrors.
