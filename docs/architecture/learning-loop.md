# The learning loop

> **Current focus (2026-10-29).** This page describes the **trade-settled** loop. Under the owner's
> current focus it is **infrastructure, not the primary learning loop**: August cannot execute, so
> P&L and settlement are not the product line. The accuracy loop is **signal → price outcome**; see
> [focus.md](../product/focus.md). This page will be rewritten when the signal ledger lands.

How a closed trade becomes a lesson the next plan reads. Every stage below is cited by symbol;
`npm run check:docs` verifies the citations still exist. The product reason for the loop is in
[the goal](../product/goal.md).

## The loop as it runs

### 1. A trade is logged

`hooks/useTradeLogging.ts` calls `syncClosedTradeToNotebook` (`services/learning/SkillMemoryService.ts`).
That one call appends the diary entry, syncs recurring mistakes, applies skill evidence (W/L,
`controlIds`, `overriddenIds`, status), ingests the lesson's trigger, and — when a cluster
is large enough and no skill covers it — asks `evaluateSkillWorth` (`services/learning/skillWorthGate.ts`)
whether the cluster is worth a draft.

### 2. The settlement reflection

`reflectOnClosedTrade` (`services/learning/settlementReflection.ts`) is the one bounded model call at
settlement. It exists because nothing used to write `trade.postMortem`: the craft leg ran on an
empty string and never produced a skill.

Its rules are strict by design:

- It never overwrites a note that is already there — the trader's own words win.
- It asks nothing that is not on the row: every fact in the packet was measured and stored by the
  settlement path.
- It writes **nothing** on failure, decline or a malformed answer. A missing reflection is a gap; a
  fabricated lesson is a lie the trader then grades their strategy against.
- It runs once per trade per session; a re-fired settlement never spends a second call.

### 3. Every draft passes the same gates

Seven sources mint skill drafts. `gateEvidenceBackedDraft` and `deterministicDraftGate`
(`services/learning/draftGates.ts`) are the one quality bar they all pass:

- nothing enters without a **falsifiable prediction**;
- nothing **duplicates** a live skill — a covered setup strengthens the existing tally instead;
- the evidence tier runs the full worth gate; the deterministic tier handles drafts with no scored
  outcome yet (tombstone cooldown, pending-duplicate skip, trigger sanity).

Any gate failure falls back to the deterministic tier. The human inbox remains the backstop.

### 3b. A tentative skill is earned from independent post-mortems

The tracked-position loop does not wait for the draft inbox. `learnFromDiagnosis`
(`services/tracking/diagnosisSkillLearning.ts`) reads the diagnosis store and asks the pure
`collectClusterEvidence` (`services/tracking/diagnosisSkillCluster.ts`) whether **three
independent outcomes** agree on the same setup and the same correction kind (`primaryChange`).
Independence is `areIndependentOutcomes` (`services/tracking/positionTracker.ts`): different
trades, non-overlapping holding windows, and not the same setup on the same PHT day. A diagnosis
that is itself tentative (thin tape, a gap, an ambiguous same-candle exit) or a breakeven never
counts.

At three, `ingestTentativeSkillFromEvidence` (`services/learning/SkillMemoryService.ts`) writes a
skill with `approvedBy: 'tentative'` (or reinforces the live skill that already covers the setup).
It is injected as **labelled context** through `isInjectableSkill` — **never** enforcement:
`isApprovedSkill` still refuses it, so a tentative rule can inform a read but cannot veto or cap
confidence. The ceiling is `TENTATIVE_SKILL_INJECTION_MAX` (2 per prompt), the global switch is
`tentativeSkillInjectionEnabled` (Settings), and a tentative skill below 40% over at least five
tracked outcomes is auto-demoted (`tentativeDemotion`, same module) with its reason in `demotion`.
The trader can edit or retire any tentative skill.

### 4. A human approves the drafts that are not evidence-backed

`approveSkillDraft` (`services/learning/skillApproval.ts`) is the **only** place a pending draft
becomes a live skill. It reads the library back after the write and lets that answer decide what the
UI says — a name collision or a refused ingest leaves the draft in the inbox and tells the trader
why. It never deletes the draft before the write is proven.

The post-mortem channel above is the deliberate exception (owner ruling, 2026-11-02): a rule the
tracker earned from independent outcomes is injected as a tentative context skill without a click,
and the human keeps edit/disable/retire control. Drafts from sources with no scored outcomes still
wait here.

### 5. Retrieval and injection

`assemblePipelineMemoryContext` (`hooks/analysisPipeline/memoryContext.ts`) asks
`getMemoryFilesContext` (`services/learning/MemoryRetrievalService.ts`) for what THIS setup should
see: matched skills and doctrine under per-stage budgets, bot memory under its own cap, similar
setups, regime weighting, loss-priming rows. The retrieval admits a skill through
`isInjectableSkill` — approval **or** a live tentative skill — while enforcement keeps reading
`isApprovedSkill`. A tentative block is labelled `TENTATIVE — context only, not enforced`, and
`rankedMatchedSkills` caps the tentative candidate pool at `TENTATIVE_SKILL_INJECTION_MAX`.

`recordMemoryInjection` (`services/learning/MemoryInjectionService.ts`) logs what actually made it
into the prompt. A skill that merely matched but was budgeted out is not credited — "skills appear
here once injected" is literally true.

### 6. Attribution

When a trade closes, `applySkillEvidence` joins `trade.sourceRunId` to the injection record's
`runId`:

| verdict | meaning |
|---|---|
| `FOLLOWED` | the plan followed the injected skill |
| `OVERRIDDEN` | the trader went against it — counts, and files a rescope proposal |
| `CONTROL` | the lift baseline |

The decision reflection (`buildDecisionReflectionContext`,
`services/learning/DecisionReflectionService.ts`) is a pure read over closed trades for the next
prompt; it owns no store.

### 7. Automated evaluation

`runDueSkillEvalWithDefaultRunner` (`services/learning/SkillEvalScheduler.ts`) benchmarks skills
itself: after a trade-log sync, one due skill is A/B evaluated with a cost cap. The verdict is
stamped into the skill's frontmatter, and a `hurts` verdict demotes a confirmed skill on its next
evidence pass.

### 8. Scheduled hygiene

`runMemoryHygieneIfDue` (`services/learning/memoryHygiene.ts`) runs weekly, due-checked per user, at
boot. It files one line per job for the Learning → Health tab:

- stale-skill demotion proposals;
- the contradiction sweep;
- graveyard retention (clears unusable rows; revives nothing);
- idle skill lifecycle (`runSkillIdleSweep`, `services/learning/skillIdleLifecycle.ts`) — the only
  stage that acts on a clock without a verdict, and it is allowed to because it touches no belief:
  it changes what is injected, reversibly, and archives nothing destructively.

### 9. The supervisor

`runSupervisorPass` (`services/learning/skillSupervisor.ts`) triages queued items with one streamed
call per item, bounded by `MAX_ITEMS_PER_PASS`. **Auto-triage, not auto-apply**: a verdict is
recorded; the only thing that creates a skill is still the human (stage 4). There is no startup
sweep — a pass runs when something changes or when the panel says "Run now".

## What is closed, and what is not

| leg | state |
|---|---|
| log → notebook writes | closed |
| settlement → reflection → draft | closed (one model call, human-gated) |
| draft gates | closed — one bar for all seven sources |
| human approval | closed, with a read-back |
| retrieval → injection ledger | closed |
| attribution | wired; runs only on settled trades |
| eval + hygiene | wired; idle by data |
| **tracked position → diagnosis** | **closed 2026-11-02** — signals and tracked journal trades are followed to the tape, diagnosed with one structured call, and their outcomes are stored with MFE/MAE and a path |
| **diagnosis → tentative skill** | **closed 2026-11-02** — three independent outcomes mint or reinforce a tentative skill; it is injected as labelled context and auto-demoted under the floor |
| **the outcome corpus** | **still the bottleneck for human-gated drafts** — settlement is human-confirmed, so there are few settled rows there; the tracked loop does not wait for it |
| **insight consolidation** | **not wired** — `insightKnowledgeBase` has no producer; a scheduled prune would walk a list nobody grows (`memoryHygiene.ts` says so in its own header) |
| **cheap-to-expensive retrieval** | open — the retrieved context is still large by default; see the plan register |

The single highest-leverage change is not code: whether an outcome needs a human click
([decisions](../plan/decisions.md) Q1, and roadmap item 3.7). Every downstream leg — evidence,
evals, hygiene, the corpus itself — is waiting on it.
