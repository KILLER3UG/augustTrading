# AGENTS.md

**This file is the router.** Read it, then follow the reading path in [docs/README.md](docs/README.md).

| Read | For |
|---|---|
| [docs/product/focus.md](docs/product/focus.md) | **the current focus**: analysis, accuracy and signals; P&L is not the product line |
| [docs/product/goal.md](docs/product/goal.md) | what this is, who it's for, the loop, the non-goals |
| [docs/product/ux/](docs/product/ux/) | what the trader sees: [charter](docs/product/ux/charter.md), [surfaces](docs/product/ux/surfaces.md), [voice](docs/product/ux/voice.md) |
| [docs/engineering/gates.md](docs/engineering/gates.md) | what proves a change, and what each gate cannot see |
| [docs/engineering/conventions.md](docs/engineering/conventions.md) | code style and the canonical single-source modules |
| [docs/plan/open-items.md](docs/plan/open-items.md) | what is open to build, with the evidence for each row |
| [docs/architecture/system-map.md](docs/architecture/system-map.md) | how the code implements the flow |

## What this is

August Trading is a **local-first trading work harness for one trader**: prep → scan → plan →
manage → journal → review → improve, around a single AI seat that reasons over the trader's notebook
and live market data through a bounded set of tools.

**The agent proposes. Deterministic code checks. The trader decides.** The app places no trades, has
no exchange account access and no API trading key. Full statement:
[docs/product/goal.md](docs/product/goal.md).

## Current focus (owner, 2026-10-29)

August is a **trading harness, not a P&L tracker**. It cannot place an order, so P&L, settlement and
win/loss displays are accounting, not the product line. Until execution exists, every enhancement
must improve one of three things:

1. **Market analysis** — structure, liquidity, derivatives, sessions, catalysts.
2. **Accuracy** — numbers and claims that are verifiable, grounded, or refused when thin.
3. **Signals** — a decision with direction, trigger, invalidation, targets and evidence.

Point the learning loop at **signals and price outcomes**, not only at logged trades. Do not make
P&L, settlement or the session guard a priority; do not add order placement or exchange keys
without an owner ruling. Full statement: [docs/product/focus.md](docs/product/focus.md).

## Commands

```bash
npm run dev                 # dev server on :3000 (127.0.0.1)
npm run build               # tsc --noEmit && vite build
npm run preview             # preview the production bundle
npm run typecheck           # tsc over the app + config TS (not scripts/electron)
npm run typecheck:scripts   # tsc over scripts/**/*.ts
npm run typecheck:electron  # node --check on electron/*.cjs
npm run lint                # eslint with a warning ratchet (cap in package.json)
npm run lint:loose          # eslint without the cap, for a cleanup pass
npm run check:contracts     # the pure-logic contracts (node only, no suite)
npm run check:boundaries    # the import edges the layer table promises
npm run check:docs          # doc links + symbol citations + gate names
npm run boot-probe          # the production bundle boots, zero pageerrors
npm run render-probe        # rendered rows, inert controls, all four surfaces
npm run skill-approval-probe # the human-actuation path, asserting notebook bytes
npm run installer-smoke     # the packaged Windows exe (release gate)
npm run electron:dev        # Vite + Electron window
npm run electron:build      # build + package the Windows installer
npm run electron:release    # REFUSES locally by design; releases run in CI
```

## The gate ladder, and what it misses

| Gate | Proves | Misses |
|---|---|---|
| `typecheck` | the TS/TSX program compiles | `electron/*.cjs`, `scripts/*.ts` |
| `typecheck:scripts` | script TS compiles against real app types | runtime behaviour |
| `typecheck:electron` | the desktop shell parses | everything runtime — only the packaged smoke covers launch |
| `lint` | zero errors, warnings under a binding ratchet | layout, rendered text, taste |
| `build` | a production bundle is produced | a prod-only boot failure |
| `check:contracts` | the pure-logic contracts hold | anything needing a DOM, a store or a network |
| `check:boundaries` | no runtime import crosses the layer table; type-only imports stay legal where named | a string-built require, a bundler alias, or an edge the table does not name |
| `check:docs` | links resolve, symbol citations exist, AGENTS' gate names exist | whether the prose is true |
| `boot-probe` | the bundle starts and the first surface mounts | any interaction |
| `render-probe` | rendered rows, send order, reload persistence, four surfaces, no inert controls, focus rings | a layout that breaks at 800px; a wrong number inside a counted row |
| `skill-approval-probe` | the four draft outcomes + Apply, by notebook bytes | the rest of the loop |
| `installer-smoke` | the packaged exe launches and renders | anything after launch |

**`render-probe` is the only gate that sees a rendered row.** A component that returns clean and
renders nothing passes every other gate. Two rules it encodes: overlays mount outside `<main>`, and
a check whose measurement is identical across two states is measuring the wrong thing.

## Where things live

```
src/
  App.tsx, index.tsx, index.css   the app entry
  components/                     UI, one directory per domain (trade, journal, agents, learn,
                                  chat, settings, shared, shell, ui, dashboards, …)
  hooks/                          useAnalysisPipeline (the send path) + supporting hooks
  services/                       providers, analysis, learning, backtesting, trade, infrastructure
  constants/prompts/              all model-facing prompts; promptRegistry makes them editable
  schemas/                        zod boundary schemas for AI JSON
  types/                          the shared vocabulary
  utils/                          pure helpers (see the canonical modules list)
electron/                         main.cjs + preload.cjs — NOT covered by tsc
shared/providerRequestPolicy.cjs  the ONE wire policy: renderer, Vite proxy and Electron main
scripts/                          gates, probes, dev instruments
docs/                             the reading path and the plan (see docs/README.md)
```

`shared/` stays at the root on purpose: Electron's `require` and the renderer's bundle both load it.

## Traps

1. **No hardcoded providers or models.** Providers are configured at runtime, stored in
   Preferences, and every call goes through `GenericProviderService`/`GenericAnalysisService`.
2. **One source per concern.** Before implementing a status colour, an R:R, a model menu, a
   disclosure, a modal, a jump control, a prompt layer or a memory budget, check
   [conventions](docs/engineering/conventions.md). A second implementation is how the numbers drift.
3. **A label is a promise.** Nav labels name the function (Analyze, Journal, Agents, Learning);
   ids and testids stay stable when a label changes.
4. **Never raise a numeric ceiling to go green.** Lint cap, bundle ceiling, evidence floors: they
   ratchet down.
5. **Never swallow a notebook write.** Surface it through
   `MemoryFilesService.getNotebookWriteFailure()`.
6. **A conversation keeps every turn.** Do not re-add a content cap to "fix" save latency.
7. **An AI row is claimed by identity (`Message.botId`), never by provider+model.**
8. **Cite docs by symbol:** `` `src/App.tsx` › `App` ``, never a line number.
9. **The desktop shell is not type-checked.** Run `node --check` after editing `electron/*.cjs`.
10. **A tentative skill is context, not enforcement.** The post-mortem loop may mint one from three
    independent outcomes (`learnFromDiagnosis`, `services/tracking/diagnosisSkillLearning.ts`). It
    reaches a prompt through `isInjectableSkill`, **never** `isApprovedSkill`; it is labelled
    `TENTATIVE`, capped at `TENTATIVE_SKILL_INJECTION_MAX` (2) per prompt, switched by
    `tentativeSkillInjectionEnabled`, and auto-demoted under 40% after 5 tracked outcomes. Do not
    add a second injection gate, and do not let it veto or cap confidence.
11. **Writing a ref during render is deliberate here.** See
    [conventions](docs/engineering/conventions.md#two-idioms-that-look-like-mistakes) before
    "fixing" one.

## Git

Trunk-based on `main`. Branch as `type/short-slug`, commit as `type(scope): why`, one item per
commit, stage by explicit path, and never build a release locally. The full rules — branches,
staging, the merge protocol and the release path — are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Environment

No API keys are needed at build or runtime; providers are configured in-app (Settings → AI setup)
and encrypted at rest on desktop. Optional: `PORT` for `electron:dev` (default 3000).
Optional: `AUGUSTTRADING_REPO=<checkout>` (desktop dev only) enables the model's `repo_read` /
`repo_edit` / `repo_apply` tools against that checkout; writes are sandboxed, checkpointed under
`.august-checkpoints/`, and gated by `npm run typecheck`.
Optional: `AUGUSTTRADING_CLONE_URL=<git-url>` makes the INSTALLED app self-hosted: first boot clones
it into `<userData>/harness-src`, installs, builds, and serves that build; `repo_apply` then builds
and reloads. Needs git + npm + network; without it the app runs the installer bundle.
