# The learning loop

> **Current focus (2026-10-29).** This page describes the **trade-settled** loop. Under the owner's
> current focus it is **infrastructure, not the primary learning loop**: August cannot execute, so
> P&L and settlement are not the product line. The accuracy loop is **signal → price outcome**; see
> [focus.md](../product/focus.md).

How a closed trade becomes a written record, and how a written record becomes context the next read
sees. Every stage is cited by symbol; `npm run check:docs` verifies the citations still exist. The
product reason for the loop is in [the goal](../product/goal.md).

**Owner refactor, documented 2026-11-06.** A skill is a **document used as context**, not a
candidate/confirmed/retired record. Automatic skill writers, tentative injection, approval,
skill outcomes/evaluation and the supervisor are removed. Skills no longer supply predicates,
vetoes or confidence caps. The model writes through `skill_write`; the trader writes or imports
through the library. Other notebook writers remain. See [the conventions](../engineering/conventions.md).

## The loop as it runs

### 1. A trade settles

`src/hooks/useTradeLogging.ts` › `syncClosedTradeToNotebook` handles notebook work for a closed
trade, without writing a skill:

- `appendDiaryEntry` and `syncRecurringMistakes` (`src/services/learning/MemoryFilesService.ts`) —
  the trader's diary, and the note that names a mistake once it repeats;
- `expireSelfChanges` and `settleSelfChanges` (`src/services/selfMod/SelfModificationService.ts`) —
  the harness's own change ledger, which grades a self-modification against what happened next.

### 2. The settlement reflection

`src/services/learning/settlementReflection.ts` › `reflectOnClosedTrade` makes a bounded model
call for eligible non-tracker settlements. It preserves an existing post-mortem of at least 40
trimmed characters, leaves the row unchanged on failure or decline, and guards repeat attempts
with a bounded per-user/trade session set. Its packet uses the stored row and any supplied injected
skill names; missing values stay explicit.

Tracker settlements skip that call. `src/services/tracking/postMortemDiagnosis.ts` ›
`runDiagnosisPass` supplies a structured diagnosis; the journal bridge in
`src/hooks/useTradeLogging.ts` › `useTradeLogging` writes its post-mortem and syncs the notebook.
The diary, pattern synthesis, journal detail and exports can read post-mortems, but none of these
paths drafts a skill.

`src/services/tracking/diagnosisBrief.ts` › `diagnosisBriefBlock` carries the last non-refused
instrument diagnosis into subsequent reads as reference only. `buildDecisionReflectionContext`
(`src/services/learning/DecisionReflectionService.ts`) remains a read over closed trades, not a store.

### 3. How a skill comes to exist

`src/services/learning/SkillFileService.ts` owns logical folders:
`skills/<slug>/SKILL.md` plus optional `references/`, `templates/`, `scripts/` and `assets/`.
Bundled scripts are stored, not executed.

- `writeSkillFile` serves the model's `skill_write` tool and
  `src/components/skills/SkillLibrary.tsx` › `SkillLibrary`. Creates compose `name` + `description`
  frontmatter and a markdown body; updates preserve other author frontmatter.
- **Body shape is guidance, not a gate:** the suggested headings
  (`src/utils/skillFrontmatter.ts` › `SKILL_BODY_SECTIONS`) are named by the `skill_write` body
  description and hinted live in the library editor
  (`src/utils/skillFrontmatter.ts` › `missingSkillSections`); a save that skips one is never
  refused — the containment duplicate scan stays the one deterministic refusal.
- **Version checks:** `if_version` remains optional in the tool schema because creates need none.
  The current `writeSkillFile` requires a matching `ifVersion` for an existing target; omission or
  mismatch refuses that update. Library edits supply the token. This is a check on that write path,
  not a universal concurrency guarantee for all notebook operations.
- **Lexical duplicate check:** `nearDuplicates` runs on **creates and updates** (excluding the
  target itself and the named merge sources). Description and body are scored by **containment**
  (`shared / min(|a|,|b|)`, `overlap`) and the name by Jaccard; the boilerplate words
  `use/use/using/skill/skills/note/notes` are stopwords so a library of "Use this skill whenever…"
  does not look mutually similar. Jaccard's union was the flaw: a reworded subset of an existing
  trigger scored 0.242 against a 0.5 floor and passed, which is the exact duplicate the rule claims
  to stop. Qualifying matches refuse the write. This proves neither semantic uniqueness nor
  thoughtful review. `skillWriteRejection` returns the library index on duplicates and current bytes
  on version conflicts.
- **Merge:** `supersedes` names the absorbed skills. The service refuses conflicting bundled paths,
  writes and checks the survivor and copied support files, then deletes the named source files.
  Cleanup failures are returned in `mergeFailures`; deletion is not all-or-nothing.
- **Import:** `importSkillToLibrary`, reached through `SkillImportService` and the library, also
  checks lexical duplicates but stores the imported head verbatim with supported sibling files.
  Imported author metadata is not restricted to two frontmatter keys.

`src/services/analysis/DeskToolsService.ts` exposes `skill_index` (index, versions and each skill's
bundled paths), `skill_view` (body, version and bundled-file listing; or one support file) and
`skill_write`, which also writes support files (`files: [{path, content}]`) under the four role
folders — paths are validated, traversal and a `SKILL.md` entry are refused, and each write is read
back before the receipt says it landed. Model writes require a current index receipt and
body-read receipts for existing targets and merge sources through `SkillWriteReview`. The receipt is
seeded from `skillReviewFromTranscript`, so a read earned on an earlier turn of the same
conversation counts — the library fingerprint and `ifVersion` still decide whether it is current,
which is what makes carrying it safe rather than merely cheaper. These receipts establish tool
reads, not semantic review of the library.

### 4. Retrieval and injection

`src/services/trade/chatSurfaceTurn.ts` › `surfacePromptWith` assembles a window-budgeted skill
index for desk turns; `skill_view` is the explicit body read. Listing a skill is not evidence that
the model read its body or followed it.

The setup-aware helper `src/services/learning/MemoryRetrievalService.ts` › `rankedMatchedSkills`
lexically ranks enabled skills by description and body, without lifecycle or approval gates.
`getMemoryFilesContext` has ONE depth now: the best match arrives as an index
line, and the body is pulled with `skill_view` or the `recall` tool. The rebuttal slice was assembled
on every send and read by nobody, and the verdict depth belonged to a moderator that no longer
exists, so both are deleted — one budget (`notebookSliceChars`), one retrieval per send. The budget
can still clip a block; the helper reports the elided characters instead of trimming silently.

`src/hooks/analysisPipeline/memoryContext.ts` › `assemblePipelineMemoryContext` builds notebook
slices without opting into injection recording. Assembly alone does not prove delivery. The verdict
"evidence pack" and run-contract panels that once claimed to show what a moderator was
shown are deleted (2026-11-06): no path ever wrote the fields they read.

### 5. What a decision actually saw

`src/services/learning/MemoryInjectionService.ts` › `recordMemoryInjection` keeps bounded,
per-user telemetry with optional `runId`. Retrieval records only when `recordInjections: true`:
`src/services/agents/botLearning.ts` › `buildBotSharedMemoryContext` opts in, and
`recordBotTurnInjection` records the bot's own memory. The shared-context caller can trim again
after retrieval records its sources, so this is not an exact final-wire transcript.

Retained consumers:

- `src/components/chat/MemoryProvenanceStrip.tsx` › `MemoryProvenanceStrip` reads records by the
  answer's timestamp window, **not** by an exact `sourceRunId` join. It groups paths and can flag a
  skill via `recordHarnessLesson`; this does not change the skill document.
- `src/services/infrastructure/ExportService.ts` › `exportPreferencesData` sweeps Preferences;
  `RESTORABLE_PREFERENCE_KEY_PREFIXES` retains `memory_injections_v1_` for restore.

`src/utils/reportExport.ts` exports stored `sourceRunId` and `Message.injectedSkills` fields in
training/reasoning exports; it does not read this ledger. Skill credit, outcome grading and
evaluation consumers are removed; the retained telemetry does not certify a skill's effectiveness.

### 6. The scheduled passes

`src/hooks/useLearningHeartbeat.ts` › `useLearningHeartbeat` has two distinct paths:

- **Boot/profile activation only:** `settleDueSignals`, `settleRefusedSignals` and
  `migrateSkillLibrary`. These calls are outside the interval sweep. Migration adds missing logical
  paths and strips retired content only from heads carrying `LEGACY_LEDGER_MARKER`; it is not a
  universal format validator (`src/services/learning/SkillFileService.ts` › `migrateSkillLibrary`).
- **Every 15 minutes and on return to a visible tab:** `runWeeklyReviewIfDue`,
  `runMonthlyReportIfDue` and `runMemoryHygieneIfDue`, each with its own due-check. Their boot calls
  live separately in `src/hooks/useUserProfileLoader.ts` › `useUserProfileLoader`.

`src/services/learning/memoryHygiene.ts` › `runMemoryHygiene` selects a ready provider and calls
`src/services/learning/MemoryReviewService.ts` › `runNotebookReview`. That model review has its
own index-change/cooldown gate and writes human-facing, retrieval-disabled
`profile/suggestions.md`. Hygiene also logs size pressure; it does not prune, merge or demote
skills. Its retired lifecycle counters are deleted, not zeroed. No scheduled pass creates or
revises skill procedures.

## What is closed, and what is not

| leg | state |
|---|---|
| settle → notebook writes | closed |
| settlement → post-mortem | separate reflection and tracker-diagnosis paths; neither drafts skills |
| skill → library | document writes/imports, lexical duplicate refusals and named merge deletions; limits above |
| retrieval → injection ledger | opt-in bot telemetry, not universal send coverage |
| provenance (what a decision saw) | retained time-window UI and backups; no skill-credit arithmetic |
| **tracked position → diagnosis** | signals and tracked journal plans have tape outcomes and structured diagnosis; no human click is required to mint evidence, and no skill is minted |
| **the loop's evidence base** | price outcomes, not exchange fills; the app places no trades |
| **insight consolidation** | **deleted with the frozen store** — the top-level `insightKnowledgeBase` is gone; its entries migrated into the notebook's `distilled/` folder, which has its own distill path |
| **cheap-to-expensive retrieval** | index and explicit body reads exist; delivery and final-wire coverage must be assessed per caller |

The current learning priority is signal accuracy and diagnosis, not removing a human settlement
click or restoring skill lifecycle machinery. See [focus.md](../product/focus.md).
