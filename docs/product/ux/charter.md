# The UX charter

The rules this app's interface actually obeys, written as a checklist you can apply to a diff.
Every item below is enforced by a token or a component that ships — not by taste. When a change
violates two rules, the theme wins over the component.

The surfaces themselves are described in [surfaces.md](surfaces.md); copy and naming rules are in
[voice.md](voice.md).

## Colour

- [ ] Page is `#0d0c0b`, panels `zinc-900`, raised surfaces `zinc-800`, hairlines
      `zinc-700`/`zinc-800`. The neutrals are **warm** (owner ruling, 2026-11-08): the v4 mock's
      palette was adopted as-is, reversing the 2026-10-27 hue-free ruling. `zinc-600` stays
      hue-free `#858585` — v4's quietest step (#716d65) measures 3.80:1 on the page, a fill not text.
- [ ] Semantic hues come from `index.css @theme`: **emerald** = gain/up, **rose/red** = loss/down,
      **amber/yellow** = warning, **cyan** = info. Cyan is the INFO hue only.
- [ ] The **accent is amber** (`--color-accent`, `#e8a33d`) and means INTERACTION — a solid button
      fill, a focus ring, a toggle's on state. A fill wears `--color-accent-ink` (`#1c1508`,
      8.39:1 on the fill); a warning is amber TEXT on the page. Same hue, two roles: that is the
      v4 mock's rule, adopted 2026-11-08. It reverses "amber = warning only" and "one cyan accent
      per view".
- [ ] Exactly **one accent per view**. If you're adding a second amber fill, something else in
      that view should stop being amber.
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

- [ ] `rounded-control` (10px) for inputs and buttons; `rounded-bubble` (18px) for chat bubbles;
      `rounded-card` (12px); `rounded-composer` (16px). (Retuned to the v4 mock's radii,
      2026-11-08 — the four tokens in `src/index.css` are the only radii; this page names them,
      `src/index.css` owns the numbers.) Nothing else invents a radius.
- [ ] Borders are hairlines, and there are exactly **two**: `border-hairline` (the resting step,
      `#242220` — the reference's `--hair`) and `border-line` (`#33312d`, its `--hair-2`), which a
      control wears while hovered, focused or selected. No opacity ladder — the 2026-11-08
      border-token migration replaced 416 raw `border-white/N` utilities with these two, because 18
      opacities were 18 ways to ask for one of two states. No double borders — a panel inside a
      panel does not get a second frame.
- [ ] Dividers inside one surface are `border-t border-hairline`, not a boxed sub-card.
      **Settings is the one boxed exception**: its pages are rounded cards with thin dashed
      dividers between rows (`divide-dashed divide-hairline`), composed through
      `src/components/settings/tabs/shared.tsx` › `SettingsGroup` / `SettingsRow`.

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
      `--text-ui-{xl,lg,base,caption,sm,dense,xs,2xs}` (= 19/17/15/14/13/12/11/10/9px at the default
      dial), every step an offset from one dial, `--ui-font-size` (15px). Roles, not sizes:
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

- [ ] **One motion clock for the whole app.** `--motion-fast` (150ms), `--motion-base`
      (200ms), `--motion-slow` (250ms) and `--motion-ease` (= `--ease-snappy`) are declared in
      `src/index.css`; `--default-transition-duration` puts bare `transition-*` utilities on the
      same clock. Page/tab/panel/list/chart/toast motion uses the `motion-*` utilities there.
- [ ] **Animate only `transform` and `opacity`.** No width, height, padding, margin, gap,
      `top`/`left`, grid tracks or `max-height` — those force layout every frame.
- [ ] No `transition-all` — it animates geometry as well as paint. Name the property:
      `transition-colors`, `transition-transform`, `transition-opacity`.
- [ ] `prefers-reduced-motion` and the trader's own `body.motion-reduced` switch collapse every
      duration to 0.01ms. No new `@keyframes` outside the sanctioned motion set in `index.css`.
- [ ] **No layout shift on stream chunks.** Text grows in place; nothing below it jumps.
- [ ] Dashboards default to one-line rows with disclosure, not cards stacked inside cards.

## Structure

- [ ] **A label names the function, never a capability the app lacks.** The six surfaces are
      Analyze · Journal · Agents · Learning · Skills · Memory for exactly this reason ("Trade does
      not trade").
- [ ] A surface's information architecture follows the thing it models. Skills → Memory → Learning
      is the loop's own order — where it lives, what it reads, whether it's sound — and each is a
      surface of its own (2026-11-08), with the decisions themselves applying automatically.
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
