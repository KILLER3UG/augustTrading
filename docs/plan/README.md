# The plan

One file: **[open-items.md](open-items.md)**. Every row is a measurement, not a transcription — it
carries the code that proves it is still open at the commit the row was last re-measured.

There is no roadmap and no separate decision log. The order of work is what the owner's focus says
([docs/product/focus.md](../product/focus.md)): analysis, accuracy, signals. A row that needs an
owner ruling says so in its own status cell and proposes the two honest answers; the answer goes
into the row, and the ruling into `AGENTS.md` or `docs/product/` if it changes the product line.
What already landed is not documented here — it is in git, which cannot drift.

## How a row is worked

1. Pick a row whose evidence still holds at HEAD. If it does not, re-measure it first: a stale row
   is worse than no row, because it reads as a decision already taken.
2. Read the code the evidence column cites before writing anything.
3. One item, one commit, with the gate named in the message. The gate ladder is
   [docs/engineering/gates.md](../engineering/gates.md).
4. Update the row only with a measurement made at the new HEAD — and when the row closes, delete it.
   A closed row is git history, not a status page.

## What keeps this honest

| mechanism | what it protects |
|---|---|
| `npm run check:docs` | every relative link resolves, every `path` › `symbol` citation names a symbol that exists, and every gate named in `AGENTS.md` exists |
| `npm run check:contracts` | the pure-logic claims, including the skill pen's read-before-write and refusal text |
| `npm run render-probe` | the only gate that can see a rendered row |
| the register itself | each row's evidence column must be a live code citation, not a citation of another document |

**The gate cannot see this file's prose.** `check:docs` polices links, symbols and gate names in the
reading path — the register's `O-nn` rows are not in its LIVE list, so a stale row is caught by
reading the code it cites, which is exactly what step 1 above is for.

A citation like `E-57 §3`, `QW5`, `06-independent-review` or `M-4` names a finding in the audit and
research corpus deleted on 2026-11-06. It records why a row exists; it is not a file to open
([docs/README.md](../README.md) rule 6).
