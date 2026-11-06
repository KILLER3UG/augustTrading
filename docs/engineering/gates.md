# Gates

Every claim about a change is supposed to be checkable. This file says what each gate proves, what
it cannot see, and which gate a given change needs.

The command is the source of truth for any number it prints (a warning cap, a bundle ceiling, an
assertion count). Do not copy those numbers into prose — name the file that owns them.

## The ladder

| Gate | Command | Proves | Cannot see |
|---|---|---|---|
| Renderer types | `npm run typecheck` | the TS/TSX program compiles | `electron/*.cjs` and `scripts/*.ts` — different programs |
| Script types | `npm run typecheck:scripts` | `scripts/**/*.ts` compiles against the app's real types | runtime behaviour |
| Electron parses | `npm run typecheck:electron` | `electron/*.cjs` is syntactically valid | anything runtime — the desktop shell has no behavioural gate except the packaged smoke |
| Lint | `npm run lint` | zero errors, warnings under a ratchet that binds | taste, layout, rendered text |
| Build | `npm run build` | `tsc --noEmit` + a production Vite bundle | a prod-only runtime boot failure — that is boot-probe |
| Contracts | `npm run check:contracts` | the pure-logic contracts (R:R math, retry classification, harness marks, notebook pressure, tool-pair compaction, AI-boundary coercion, the skill document and its duplicate scan, index budget, policy tables, desk tool budget) | anything that needs a DOM, a store or a network |
| Boundaries | `npm run check:boundaries` | no runtime edge crosses the layer table: types/schemas stay vocabulary, services and hooks take component types only, and `shared/`/`electron/` never import `src/` | a string-built `require`, a bundler alias it cannot resolve, or a boundary the table does not name |
| Docs | `npm run check:docs` | every local link resolves, every `path` › `symbol` citation names a symbol that exists, and every gate named in `AGENTS.md` exists | whether the prose is *true* — only that its references are real |
| Boot | `npm run boot-probe` | the production bundle starts, the Analyze surface and the chart dock mount, zero pageerrors | whether any interaction does anything |
| Render | `npm run render-probe` | rendered row counts per conversation, send order, reload persistence, all four nav surfaces, no inert control on Learn/Journal, Settings → Data backup/export/import, computed focus indicator | a layout that only breaks at 800px; a wrong number inside a row it counted |
| Installer smoke | `npm run installer-smoke` | the **packaged exe** launches and renders | anything after launch; Windows only |
| Signature | `npm run verify:signature` | the installer is signed (or the unsigned release variable is deliberately set) | — |
| Update manifest | `scripts/check-update-manifest.cjs` | the updater manifest names an installer that exists | the bytes behind it |

`probe:chip`, `probe:census`, `probe:surfaces`, `trade-shot` and `ui-inspect` are dev instruments,
not gates. `replay:plans` is a read-only drift harness.

## What has no gate

- **A backup/restore round-trip.** Exercise export → wipe → import by hand after touching
  `ExportService`.
- **The packaged shell's behaviour after launch.** `installer-smoke` proves it starts; nothing
  proves an IPC handler behaves. Keep IPC changes small and frame-checked.
- **Native/Capacitor.** No gate runs on a device.
- **The printable trade report.** It opens; whether it prints correctly is a hand check.
- **Prompt content.** The contracts pin pure functions; nothing asserts what a model is actually
  sent. Prompt changes need a read of the composed string.

## CI and release

**One gate definition:** `.github/actions/verify/action.yml`. Both callers run it.

- **CI** (`.github/workflows/ci.yml`) — every push to `main` and every PR: one ubuntu job that
  installs deps and runs the shared action. That is the whole difference between local and CI.
- **Release** (`.github/workflows/release.yml`) — a `v*` tag, on `windows-latest`. It runs the
  SAME action, then packages the dist that action built, runs `installer-smoke`, verifies the
  signature and the updater manifest, and only then uploads.

A composite action, not a reusable workflow, so the release job packages the exact dist the gates
verified — no artifact round-trip, no second build. Every run step declares `shell: bash`; the
action runs on both ubuntu and windows, so the shell is never the runner's default by luck.

The release gate is the authoritative one; a local tag or a local `--publish` skips it. `npm run
electron:release` refuses locally on purpose.

## Rules

1. **Never raise a ceiling to go green.** The lint cap, the bundle ratchet and any coverage floor
   ratchet **down**. Lower the cap in the same change that removes the warnings.
2. **Prove red before green.** Reproduce the defect (or the failing check) first; a fix with no
   observed failure is a guess.
3. **One heavy gate at a time, on an idle machine.** `render-probe` reports blank surfaces when it
   shares the machine with a build. An occupied port is not a nuisance: the probe refuses to drive a
   server it did not start, because a pass against another tree proves nothing.
4. **A check whose measurement is identical in two different states is measuring the wrong thing.**
5. **Overlays mount outside `<main>`.** Measuring `<main>` after opening one re-reports the previous
   surface and passes vacuously.
6. **`render-probe` is the only gate that sees a rendered row.** A component that returns clean and
   renders nothing passes every other gate.
7. **Do not add another contract without saying why the existing ones cannot reach it.** The list
   is deliberately small; it is not a test suite waiting to grow.

## Which gate does my change need?

| Change | Required |
|---|---|
| any TypeScript | `typecheck`, `lint` |
| `electron/*.cjs` | `typecheck:electron` + `installer-smoke` before a release |
| `scripts/**` | `typecheck:scripts`; if it is a probe, the guards' parse + lint |
| UI, rendered text, a surface, a stylesheet | `build`, `render-probe`, and a look in a browser |
| a prompt or anything the model reads | `check:contracts` if pure; read the composed prompt |
| storage, Preferences, export | `render-probe` for the UI path; a manual export → wipe → import |
| docs | `check:docs` |
| a release | the whole ladder, through CI |
