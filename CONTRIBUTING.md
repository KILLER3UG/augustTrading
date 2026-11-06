# Working on this repository

The rules below are how this repository already works, written down so the next change follows the
same path. The product and UX are in [docs/product](docs/product/); the gate ladder is in
[docs/engineering/gates.md](docs/engineering/gates.md).

## Branches

- `main` is the trunk and is always green.
- Work happens on `type/short-slug`: `feat/cost-model`, `fix/dock-stop`, `docs/reading-path`,
  `refactor/settlement`.
- One branch, one purpose. If a second idea appears mid-branch, it is a second branch.
- Delete the branch after it merges. The only long-lived branch is `main`.
- A stale branch is not a source of truth. Before merging an old branch, check what it would
  resurrect — a branch cut before a deletion will restore the deleted files.

## Commits

```
type(scope): the reason, in the imperative
```

- **Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `build`, `perf`, `revert`.
- **Scopes** name the product area, not the file: `analyze`, `journal`, `agents`, `learning`,
  `providers`, `storage`, `gates`, `docs`, `release`. Historical commits use `ui`, `chat`, `memory`,
  `flow` — those are fine too.
- **One item, one commit.** The subject says *why*, the body says what changed and which gate
  proved it. A commit that needs "and also" is two commits.
- Do not amend a published commit, and do not force-push `main`.

### The commit-msg hook (optional, one command)

```bash
npm run hooks:install
```

That points `core.hooksPath` at the tracked `.githooks/` directory. The hook rejects a subject that
is not `type(scope): why` and lets a merge, revert or fixup through. `--no-verify` bypasses it; do
not make a habit of it.

## Staging

- Stage by **explicit path**: `git add src/services/learning/SkillFileService.ts`. Never `git add -A` or
  `git add .` — they pick up scratch files, secrets and another session's work.
- One gitignored path in an `add && commit` chain aborts the whole chain. Check the status after
  staging, and commit by pathspec when in doubt.
- Before any destructive git command (`checkout --`, `reset --hard`, `clean`, `stash`), run
  `git status` and read it. If the tree contains work that is not yours, stop and use a throwaway
  worktree instead of stashing shared state.
- `git status` before every commit; review `git diff --cached` after staging.

## Before a commit

Run the gate your change needs — the table is in
[gates.md](docs/engineering/gates.md#which-gate-does-my-change-need). The short version:

| Change | Required |
|---|---|
| any TypeScript | `npm run typecheck && npm run lint` |
| `electron/*.cjs` | `npm run typecheck:electron` |
| `scripts/**` | `npm run typecheck:scripts` |
| UI / rendered text / stylesheet | `npm run build && npm run render-probe`, plus a look in a browser |
| prompts / model input | `npm run check:contracts` |
| docs | `npm run check:docs` |

**2026-11-06:** the skill-approval gate is retired with the document/context-only skill refactor.

- **Prove red before green.** Reproduce the defect or the failing check first.
- **One heavy gate at a time.** `render-probe` reports blank surfaces when it shares the machine
  with a build, and it refuses a port it did not start.
- **Never loosen a gate to pass.** Fix the cause, or record the limitation honestly.

## Merging

1. Prove the diff is scoped: the file list and the counts are what you expect.
2. Gate the **merged** tree, not just the branch tip.
3. If the branch is stale, rebase it and re-gate; do not merge a tree nobody has verified.
4. "The review looked good" is not authorization to push something untested.

## Releases

- A release is a `v*` tag on `main`. CI builds once with `--publish never`, verifies the installer,
  and only then uploads the bytes.
- **Never build or publish a release locally.** `npm run electron:release` refuses on purpose; a
  local `--publish` skips every gate and ships the artifact users install.
- The updater manifest must name the installer that was actually uploaded.

## Documentation

- A durable document lives under `docs/` and is linked from [docs/README.md](docs/README.md). A
  scratch note is not documentation.
- Cite code by symbol: `` `src/App.tsx` › `App` ``. `npm run check:docs` verifies every
  citation and every relative link.
- Do not copy a number that can drift. Name the file that owns it.
- When you delete a doc, add a line to the "Where things went" table in `docs/README.md`.
