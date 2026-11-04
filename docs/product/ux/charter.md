# The UX charter

The rules this app's interface actually obeys, written as a checklist you can apply to a diff.
Every item below is enforced by a token or a component that ships — not by taste. When a change
violates two rules, the theme wins over the component.

The surfaces themselves are described in [surfaces.md](surfaces.md); copy and naming rules are in
[voice.md](voice.md).

## Colour

- [ ] Page is `#0a0a0a`, panels `zinc-900`, raised surfaces `zinc-800`, hairlines
      `zinc-700`/`zinc-800`. The neutrals carry **no hue** (2026-10-27): a tinted black —
      blue-shifted or warm — is a second palette waiting to disagree with the first.
- [ ] Semantic hues come from `index.css @theme` and mean one thing everywhere:
      **emerald** = gain/up, **rose/red** = loss/down, **amber/yellow** = warning, **cyan** = info.
      Never introduce a new hue for a new state.
- [ ] Exactly **one cyan accent per view**. If you're adding a second cyan, something else in that
      view should stop being cyan.
- [ ] There is **no brand gradient** (deleted 2026-10-27). A hero moment earns size or weight, not a
      hue. Do not re-add one, and do not read a chrome token as a chart colour or a chart colour as
      chrome — that pair of mistakes is what turned a dashboard series white.
- [ ] No gray remappings for a colour family. Neutral utility names (`zinc-*`) are kept
      deliberately so the whole app recolors from the token block.
- [ ] Micro-labels at ≥10px stay on `text-zinc-600`. `zinc-600` is `#858585` — 5.37:1 on the page,
      4.99:1 on a panel, 4.57:1 on a raised surface. The quieter `#6f6f6f` is 3.94:1, which is a
      fill, not text. Any new faint text step ships with the three ratios measured, not eyeballed.
- [ ] **Colour means data.** Green/red/amber/blue on a number or a series; chrome stays neutral.

## Shape and borders

- [ ] `rounded-control` (6px) for inputs and buttons; `rounded-bubble` (12px) for chat bubbles. (Retuned by the quiet-desk layer, 2026-11-04 — the four tokens in `src/index.css` are the only radii; this page names them, `src/index.css` owns the numbers.)
      Nothing else invents a radius.
- [ ] Borders are hairlines: `border-zinc-800/80`. No double borders — a panel inside a panel does
      not get a second frame.
- [ ] Dividers inside one surface are `border-t border-zinc-800/80`, not a boxed sub-card.

## Reuse — do not hand-roll these

| You need | Use |
|---|---|
| a state chip / pill | `StatusPill` (`tone: up \| down \| warn \| info \| neutral`, `kicker` for micro-caps) |
| an empty view | `EmptyState` |
| a tooltip | `Tip` (it carries `shortcut=`; the key hint must be in the accessible name too) |
| a dropdown | `SelectMenu` |
| a destructive confirm | `useConfirmDialog` — it returns the component to mount |
| a segmented control | the pressed-state button pattern; **not** `.seg-thumb` on a container |
| a chat measure | `.chat-column` (920px) for the thread, `.chat-prose` (42rem) for the answer's prose inside it — tables and evidence keep the wide column |
| an empty-state backdrop | `.chat-hero-grid` |
| an expandable panel | `Disclosure` — the one native `<details>` wrapper |
| a full-detail reader | `DetailModal` — view-only, focus-trapped, Escape and backdrop close |
| a way back to the newest row | `JumpToLatestFab` — both conversation homes mount it |
| a model menu | `ModelMenu` — `ModelChip` and `ModelPicker` both mount it |
| a focus indicator | nothing at all — `index.css` outlines every focusable element on `:focus-visible`; editable fields opt out only when they declare their own ring, or when focus did not arrive from the keyboard (`utils/navModality.ts` sets `html[data-nav-modality]`, because a browser matches `:focus-visible` on a text field after a mouse click too) |

`.seg-thumb` is the absolutely-positioned sliding **sibling** in a segmented control. Put it on the
container and it resolves against the nearest positioned ancestor and inflates to fill the surface.

## Type and numbers

- [ ] **Sizes come from the `text-ui-*` ramp, never a `text-[Npx]` literal.** The ramp is
      `--text-ui-{xl,lg,base,caption,sm,dense,xs,2xs}` (= 18/16/14/13/12/11/10/9px at the default
      dial), every step an offset from one dial, `--ui-font-size` (14px). Roles, not sizes:
      `text-ui-xs` says "micro-label", `text-[10px]` says nothing and cannot be scaled.
      A pixel literal on any heading tag is banned the same way. Display roles exist
      (`display` = base + 12, `hero` = base + 18); name the role, or add a step deliberately.
- [ ] Geist Variable for UI, JetBrains Mono for data. **No serif face ships** (owner ruling,
      2026-10-22). `font-serif` and `font-reading` survive as ROLES, both resolving to the UI stack
      — do not delete them, because Tailwind's own `font-serif` default would then quietly bring
      Georgia back wherever the role is named.
- [ ] **The model's answer is prose, and prose has its own role.** The answer is the one surface in
      the app that is READ rather than operated, so it is set through `AnswerBody` →
      `font-reading`; the trader's own message, the work card, the chips and the composer stay in
      the interface chrome. Code blocks keep their monospace and tables keep tabular figures.
- [ ] Every numeric readout is `font-mono tabular-nums`. A price, P&L or R that changes width every
      tick is a layout shift you can see.
- [ ] Tables over tiles whenever the data is tabular — win rates, skills, the trade log.

## Motion and density

- [ ] Transitions only via `--ease-snappy` at 0.12–0.18s.
- [ ] No `transition-all` — it animates geometry as well as paint. Name the property:
      `transition-colors`, `transition-transform`, `transition-[width]`.
- [ ] No new `@keyframes`. The existing tick-flash and beacon patterns are the sanctioned
      exceptions.
- [ ] **No layout shift on stream chunks.** Text grows in place; nothing below it jumps.
- [ ] Dashboards default to one-line rows with disclosure, not cards stacked inside cards.

## Structure

- [ ] **A label names the function, never a capability the app lacks.** The four surfaces are
      Analyze · Journal · Agents · Learning for exactly this reason ("Trade does not trade").
- [ ] A surface's information architecture follows the thing it models. Learning is
      Skills → Memory → Health because that is the loop's own order: where it lives, whether it's
      sound, and your call — with the decisions themselves applying automatically.
- [ ] One home per concern. If a component appears in two surfaces, one of them mounts the other's
      component — nobody reimplements a table.
- [ ] No dead-end state. A surface with nothing selected says something true and offers the next
      action; it does not point at another surface.
- [ ] An affordance must do what its label says. "— toggle panel" only on a surface that has a
      panel.
- [ ] Heavy surfaces are `React.lazy` with `SurfaceSkeleton`, never `fallback={null}` — a blank
      screen reads as a crash.

## Verification

- [ ] `npm run lint` — errors are zero, and warnings are capped by a ratchet that binds. The cap
      lives in `package.json`; never raise it to go green.
- [ ] `npm run typecheck && npm run build`.
- [ ] **Look at it in a browser.** No gate here sees an inflated pill, a clipped column, or a layout
      that only breaks at 800px — the Electron floor.
- [ ] New or merged surface ⇒ walk it in `npm run render-probe`, the only gate that can see a
      surface mount.
- [ ] Anything that touches `index.css` focus or theme rules ⇒ `npm run render-probe`. No other
      gate resolves a stylesheet.

See [docs/engineering/gates.md](../../engineering/gates.md) for what every gate proves and what it
does not.
