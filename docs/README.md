# Documentation

One reading path. Everything else is evidence, kept where it belongs.

## Read in this order

1. [AGENTS.md](../AGENTS.md) — how to work here: commands, gates, git rules. Most agents load it
   automatically.
2. [product/focus.md](product/focus.md) — **the current focus**: analysis, accuracy and signals;
   P&L is not the product line until execution exists.
3. [product/goal.md](product/goal.md) — what this is, who it's for, the loop, the non-goals.
4. [product/ux/](product/ux/) — what the trader sees: the [charter](product/ux/charter.md), the
   [six surfaces](product/ux/surfaces.md), the [voice](product/ux/voice.md).
5. [engineering/gates.md](engineering/gates.md) — how a change is proven, and what each gate cannot
   see. [engineering/conventions.md](engineering/conventions.md) — code style and the canonical
   single-source modules.
6. [plan/open-items.md](plan/open-items.md) — the only working list: what is open, with the code
   that proves each row is still open.
7. [architecture/system-map.md](architecture/system-map.md) — how the code implements the flow.
   [architecture/learning-loop.md](architecture/learning-loop.md) is the memory loop in depth.

## The tree

| Directory | What lives here | Read when |
|---|---|---|
| `product/` | the current focus, the goal, and the UX: charter, surfaces, voice | designing anything the trader sees |
| `architecture/` | the system map and the learning loop | changing a call path, a store, or a prompt |
| `engineering/` | gates, code conventions, the canonical modules | before writing code or claiming a change |
| `plan/` | the working register | choosing what to build next |

There is deliberately nothing else here. No roadmap, no decision log, no implementation record, no
audit corpus, no research dumps: those were the same facts in four places, and each one went stale
faster than the code it described. **What landed is in git** — `git log --stat` and the commit
messages answer "did this already ship?", and they cannot drift, because they are the change. What
is open is [plan/open-items.md](plan/open-items.md). What the app is is `product/` and
`architecture/`.

## Rules for durable docs

1. **Live docs live here, tracked.** A proposal is reviewed in conversation, not committed as a new
   `docs/*.md`. Scratch is not documentation.
2. **Cite code by symbol, not by line.** Write `` `src/App.tsx` › `App` ``.
   `npm run check:docs` verifies every symbol, every relative link, and that the gates named in
   `AGENTS.md` exist. A line number is a claim that rots on the next edit.
3. **Do not copy a number that can drift.** Name the file that owns it (the lint cap lives in
   `package.json`, the bundle ceiling in the workflow, the contract list in
   `scripts/check-contracts.cjs`).
4. **One home per fact.** If two docs state the same rule, one links to the other.
5. **A doc that records work, not the product, gets deleted when the work ends.** Removed on
   2026-11-06: `docs/research/` (36 MB of reference-repo notes), `docs/plan/full-audit.md` and
   `docs/plan/audit/`, `docs/plan/roadmap.md`, `docs/plan/decisions.md`,
   `docs/plan/implementation-record.md`, `changelog.md`, and the ten dated design docs that all said
   `Status: LANDED`. Recover any of them with `git log --diff-filter=D -- <path>` then
   `git show <sha>^:<path>`.
6. **Old ids are provenance, not links.** A citation like `M-4`, `L-7`, `E-57 §3`, `QW5` or
   `06-independent-review` names a finding in a deleted document. It records *why* a row exists; it
   is not a file to open.

## Where things went

| Was | Now |
|---|---|
| `docs/ui-doctrine.md` | [product/ux/charter.md](product/ux/charter.md) |
| `docs/learning-loop-map.md` | [architecture/learning-loop.md](architecture/learning-loop.md) |
| `docs/app-flow.md` + `.html` | [architecture/system-map.md](architecture/system-map.md) |
| `docs/STATUS.md`, `docs/AUDIT.md`, `docs/plans/` | deleted 2026-10-29 — in git history only |
| `docs/research/`, `docs/plan/audit/`, `full-audit.md`, `roadmap.md`, `decisions.md`, `implementation-record.md`, `changelog.md`, the dated design docs | deleted 2026-11-06 — in git history only; the open remainder is `plan/open-items.md` |
