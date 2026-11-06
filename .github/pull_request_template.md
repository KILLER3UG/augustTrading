## What changed

## Why

<!-- The reason, not a restatement of the diff. Link the plan row / issue if there is one. -->

## Gate

- [ ] `npm run typecheck` (and `typecheck:scripts` / `typecheck:electron` if touched)
- [ ] `npm run lint`
- [ ] `npm run build` + `npm run render-probe` for anything rendered
- [ ] `npm run check:contracts` for pure logic; `npm run check:docs` for docs
- [ ] `npm run check:boundaries` if an import edge moved
- [ ] exercised by hand in the browser (UI changes only)

## Notes

<!-- What this does NOT prove, or what remains open. -->
