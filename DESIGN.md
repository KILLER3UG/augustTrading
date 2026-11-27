# DESIGN.md — August's matte-monochrome UI system

**This file is the visual law.** Every surface a trader sees is matte monochrome:
zinc greys, 1px hairlines, concentric radii, GPU-only motion. Colour exists in
exactly two semantic exceptions (emerald/rose), and never as decoration. The
`check:palette` gate enforces the hue ban; this file states the system the gate
cannot fully see. When a component and this file disagree, this file wins — fix
the component, or change the ruling here first.

## Surface ladder (three steps, no fourth)

| Step | Token | Where |
|---|---|---|
| Deepest | `bg-zinc-950` | The app background, modals, command bars |
| Raised | `bg-zinc-900/50` | Cards, panels, drawers resting on the background |
| Highest | `bg-zinc-800` | Controls, pills, inputs, hover fills inside a raised surface |

A surface never invents a fourth step. Depth comes from the ladder plus a
`border-hairline` edge, never from a shadow stack or a blur.

## Hairlines and radii — concentric, one scale

- Every edge is a **1px hairline** (`border-hairline`). No 2px borders, no
  double borders between nested surfaces.
- Radii are **concentric**: a child's radius is smaller than its parent's by
  one step, so nested edges stay parallel.

| Container | Radius |
|---|---|
| Modals, command palettes | `rounded-xl` |
| Cards, popovers, panels | `rounded-lg` |
| Buttons, inputs, grids, rows | `rounded-control` |
| Micro-badges, keycaps, status chips | `rounded-[4px]` |

An overlay that floats above the chrome is still rounded — an unrounded float
is an anti-pattern (below).

## Hit targets

Every clickable control is at least **24px** (`h-6 min-w-6` for icon-only
buttons; padded text buttons clear it naturally). A control smaller than 24px
is a defect even when it renders correctly — the render-probe cannot see it.

## Numbers

- Numeric display is `font-mono tabular-nums` — prices, sizes, percentages,
  R:R, token counts, clocks.
- Numbers are **rounded to the precision the decision needs** before render:
  a proposal shows `1.91R`, `36.4%`, `0.154` — never `1.9067R` or
  `0.0666667`. Full precision lives in a `title`/expanded drawer, not in the
  scan line. Proposal formatting has one shared formatter module (wired in
  `src/components/trade/panels/TradeProposalCard.tsx` ›
  `TradeProposalCard`); a component that rounds inline is a second
  implementation and will drift.
- Right-align monospace hotkey hints (`Ctrl+\`, `Esc`) in keycap chips.

## Motion law

- Only **GPU-composited properties** animate: `opacity` and `transform`
  (`translate3d`). Never animate `height`, `width`, `top`, `left`, or layout —
  collapse/expand uses the `grid-template-rows` glide in `src/index.css` ›
  `motion-collapse-grid` with its children retained until the glide ends.
- Durations live in the **150–220ms** band: 150ms for state flips, 200–210ms
  for collapse glides, 220ms ceiling for card transitions.
- Every motion respects `prefers-reduced-motion` (see the media query at the
  bottom of `src/index.css`).
- Streaming text arrives via the frame-coalesced path in
  `src/utils/streamCoalescerCore.ts` › `createDeltaCoalescer` — one paint per
  frame, synchronous flush on tool boundaries, `cancel()` fully resets so a
  stale aborted tail can never concatenate into the next turn.

## Anti-patterns (each one is a refusal, not a style opinion)

1. **No glassmorphism.** Zero `backdrop-blur-*`, zero translucent frosted
   overlays. `check:palette` fails the build for a reason.
2. **No unrounded floats.** Anything that floats above the chrome carries the
   modal/card radius.
3. **No 3-deep stacked modals.** Two layers maximum; a third needs a ruling.
4. **No forbidden hues.** Amber, cyan, pink, violet, teal, yellow, sky, orange
   never appear in the chrome; semantic emerald/rose are the only exceptions.
5. **No painted-on-chart exceptions.** The palette gate scans components; the
   chart canvas follows the same monochrome law by convention.
6. **No new motion property.** If an effect seems to need `height`, it needs
   the collapse grid instead.
