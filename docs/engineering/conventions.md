# Conventions

Code style and the single-source modules. Read this before adding a second implementation of
something that already exists.

## TypeScript

- `strict: true`; every function has a return type.
- Interfaces for object shapes, unions for simple string constants.
- zod schemas in `schemas/` for AI-boundary validation; lenient coercion and semantic fixups live in
  `schemas/tradeAnalysis.ts`.
- Import types from `types/`; do not redefine a common type locally.

## Imports

```ts
// 1. React & UI libraries
import React, { useState, useEffect } from 'react';

// 2. Internal types
import { Message, TradeAnalysis } from './types';

// 3. Services (alphabetical)
import * as dbService from './services/dbService';

// 4. Components (alphabetical)
import { TradeView } from './components/trade/TradeView';

// 5. Utilities (alphabetical)
import { sanitizeAIResponse } from './utils/sanitizers';
```

App code lives under `src/`. `shared/` stays at the repository root because the Electron main
process, the Vite dev proxy and the bundled renderer all import it.

## Components and state

- Functional components with hooks; `interface ComponentProps { … }`.
- Extract complex logic into hooks (`src/hooks/`) or services.
- `React.memo` only where a render cost is measured, not by habit.
- `useCallback` for handlers passed down, `useMemo` for expensive computation, refs for non-render
  values.

## Persistence

- Preferences (`@capacitor/preferences`, localStorage fallback) for settings and keys.
- SQLite via Capacitor on native; IndexedDB on web, through `SqliteService`.
- Back up before a major data operation (`BackupService`).
- The desktop stores chats and the notebook in files under `userData`, not in the 5 MiB web quota.
  Do not add a new large store to Preferences.

## Errors

- Wrap async work in try/catch and log with context; return a fallback only where the failure is
  genuinely non-critical.
- Provider errors are mapped to user-safe messages in `GenericProviderService`
  (`toFriendlyProviderError`). Never surface a raw API error body.
- Never swallow a notebook write. `MemoryFilesService.getNotebookWriteFailure()` is the one place
  that knows a write never reached disk; every caller that catches-and-logs turns memory loss into
  an invisible state.

## Naming

- Components PascalCase; functions/variables camelCase; constants UPPER_SNAKE_CASE.
- Files: camelCase for services/utils, PascalCase for components.
- A label names the function. Ids and testids are not copy — they stay stable when a label changes.

## Performance

- Lazy-load heavy components with `React.lazy()` + `SurfaceSkeleton`, never `fallback={null}`.
- Virtualize long lists (`react-virtuoso`).
- Monte Carlo runs in a Web Worker with a synchronous fallback (`runMonteCarloForSetupAsync`).
- There is no generic AI-response cache. Do not assume one exists.
- Desk-tool results are cached within a run (`TOOL_CACHE_TTL_MS`); the clear lives at the one choke
  point every tool turn passes (`streamChatWithDeskTools`), not at each caller.

## Security

- Never commit API keys. Keys are configured in-app and encrypted at rest on desktop via
  `safeStorage`.
- Sanitize AI responses before rendering (`sanitizeAIResponse`, `sanitizeTradeAnalysis`).
- Validate external data at the boundary with zod.
- The renderer is privileged by its preload bridge: validate the sender frame on IPC handlers.

## Canonical single-source modules

A second implementation is how numbers drift apart. When you need one of these, use the module.

| Module | Owns | Rule |
|---|---|---|
| `utils/riskReward.ts` | the **planned** R:R (nearest target ÷ stop) | the realized ratio in `outcomeEngine.ts` (`realizedRFromPrices`) is a different question on purpose |
| `utils/runStatus.ts` | the run-status vocabulary: one colour + word per state, error classification, the error-text sanitizer | never hardcode a status colour in a component |
| `utils/turnStatus.ts` + `utils/toolKinds.ts` | what a turn is DOING, and the vocabulary the desk's tools are named in | `parseToolLine` is the ONE reader of the digest grammar; `pairToolRows` is the ONE pairing of a call with its result — one paired row is one call. The map is keyed by the tool's human label; a new tool needs its label in the same change, checked against the desk service's tool list. An unknown tool keeps its own label — never guess a verb. |
| `components/shared/toolKindIcons.tsx` | the one mark per kind | beside the vocabulary it belongs to; a kind with two spellings is two kinds |
| `components/shared/Disclosure.tsx` | the one expandable panel, a native `<details>` | it owns the shape only; summary, body, classes and ref are the caller's |
| `components/shared/DetailModal.tsx` | the one full-detail reader: focus trap, `aria-modal`, Escape, backdrop | view-only on purpose — a reader that also edits is two editors |
| `components/shared/JumpToLatestFab.tsx` | the one way back to the newest row | both conversation homes mount it; `JUMP_AWAY_PX` is the one follow distance; while a turn runs it is an indeterminate ring, never a made-up percentage |
| `components/shared/ModelMenu.tsx` | the one model menu | `ModelChip` and `ModelPicker` mount it; a new picker takes the panel, it does not grow a second flyout |
| `components/shared/effortScale.ts` + `effortDial.ts` | the thinking-tier ladder and the record of whether a dial is on screen | `Ctrl/Cmd+Shift+E` asks `effortDialUp()` before writing; no panel/bot turn renders a dial, so they must not answer the key; the hint printed beside `EFFORT` is the string the handler binds |
| `types/provider.ts` | `ReasoningEffort`, `WireAuditEntry`, the wire vocabulary | `services/providers/reasoningControls.ts` owns the schedule and resolution and re-exports the type; resolve the tier **once** (`resolveComposerEffort`) and carry it out on the outcome |
| `utils/finishReason.ts` | the four providers' stop signals → one `FinishReason` | read the truncation tally with `peekTruncations()`; never re-derive it from a missing regex match |
| `utils/contextWindow.ts` + `services/providers/contextCompact.ts` | the model's window and the compaction that respects it | resolve with `resolveContextWindow()` (override → a provider-stated limit → `/models` → the 1,000,000 default); size history with `compactForWire()`; the transport retries once on a context-length rejection. Do not add a smaller default to "fix" an overflow |
| `shared/providerRequestPolicy.cjs` | thinking gates, temperature, provider URL host policy | imported by the renderer, the Vite dev proxy **and** Electron main — one policy, three transports |
| `utils/harnessMarks.ts` | the one voice for text this app withholds from a model: `DATA_UNAVAILABLE`, clipping notes, the spill receipt, the fence legend | never hand-write a marker or describe one in a prompt |
| `utils/composePrompt.ts` + `constants/promptRegistry.ts` | prompt layering | the harness contract appears exactly once |
| `utils/memoryBudget.ts` | the notebook's soft/trigger/hard caps and the tier classifier | pressure REFUSES growth (new files at the trigger, model notes at the hard cap); it never evicts — do not add an eviction rule without proving which bytes are regenerable |
| `services/learning/SkillFileService.ts` | the one skill store: a folder (`<slug>/SKILL.md` + role dirs), a minimal `name` + `description` frontmatter, and one write path (head **and** support files) | the app never rewrites a skill's prose; `nearDuplicates` runs on creates **and** updates, by containment not Jaccard, and the refusal names the skill to merge; an update needs the `ifVersion` that was read; a merge deletes only what the writer names in `supersedes` and carries the absorbed folder's files to the survivor. Do not add a status, approval or win/loss key back into the file |
| `MemoryFilesService.getNotebookWriteFailure()` | the only record that a notebook write never reached disk | `persist` records, rethrows, and clears on the next success — never add a swallow-and-continue |
| `utils/messageVersions.ts` | the one arithmetic of reverting/versioning a transcript | a conversation has two homes (`StoredChatEntry` and `Message`) that do not share field names; this module owns the counting and list surgery and each host adapts to `TurnSnapshot`. `splitAt` RETURNS the tail — ignoring the second half deletes the trader's turns. A revert changes the transcript and nothing else; say how many side effects a parked tail made |
| `ExportService.RAW_LOCAL_STORAGE_PREFIXES` | the key namespaces whose owners talk to `localStorage` directly | on web that IS the Preferences fallback; on native they are different places. A new raw store must be added or it silently leaves no backup on mobile. Do not widen it "for safety" — the WebView origin quota is shared |

## Two idioms that look like mistakes

**Writing a ref during render is deliberate.** `ref.current = value` on its own line inside a
component body exists because an effect runs too late: a hook called later in the same render, or a
callback that fires before the next effect pass, must already see the new value. Two rules make it
safe: never write a ref from props mid-transition (derived from committed state or `sessionStorage`
only), and two writers to one ref sometimes correct — `App.tsx`'s `activeUsernameRef` is written
twice on purpose, each writer serving a different set of readers.

**A conversation keeps every turn** (owner ruling, 2026-10-27). The 200-message trim, the dock's
60-entry cap and the 4,000-character cut on stored reasoning are gone. What remains is `MAX_SESSIONS`
(a bound on how many chats) and `MAX_STORED_CHARS` (this store IS `localStorage` on web). Do not
re-add a content cap to "fix" save latency.

**An AI row is claimed by identity, never by provider+model.** `Message.botId` is stamped by the
writers that answer as a bot. `deskThread` drops only rows a bot positively owns; `threadForProvider`
falls back to provider+model for pre-stamp history but excludes a different bot's rows. A
model-shaped claim deleted the trader's own answers once — do not reintroduce it.

## Providers

There are no hardcoded provider/model constants. Providers are configured at runtime
(Settings → AI setup), stored in Preferences (`provider_configs_v1`, encrypted at rest on desktop),
and every AI call goes through `GenericProviderService` (chat_completions / messages / responses /
google; retry and timeout built in) or `GenericAnalysisService` (analysis, vision, memory).

- `ProviderConfig.id` is a string; `AIProvider` is only a legacy const of built-in ids.
- Resolve providers through `utils/providerUtils.ts` and `ProviderConfigService.getReadyProviders`.
- Analysis/journal rows carry `modelsUsed: Record<providerId, modelId>`; legacy per-provider fields
  are read-only fallbacks.
