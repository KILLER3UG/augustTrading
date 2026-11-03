# Voice and copy

The app speaks in one quiet voice. These rules come from owner rulings and the copy fixes that
followed them.

## Names

- **A label is a promise.** The four surfaces are Analyze · Journal · Agents · Learning because
  each names what the surface does — "Trade" promised execution the surface never performs.
- The same thing has one name everywhere: surface labels, route hints ("Learning → Skills"),
  tooltips, and the accessible name a screen reader announces.
- Ids and testids are not copy: they stay `trade` / `journal` / `agents` / `learn` when a label
  changes. Do not rename an id to match a label.
- A row is labelled with human-readable text, never a key, a filename or a provider id.

## Claims

- **The agent proposes; the trader decides.** No copy may imply the app executed anything, graded
  anything by itself, or decided anything on the trader's behalf.
- Status copy states what the lists actually hold. "3 queued" means three rows exist — not that
  three things are working.
- If the app withholds or clips data, say so and say how much. The harness marks
  (`utils/harnessMarks.ts`) exist so the model and the trader read the same receipt.
- A control may only advertise a gesture that exists. If the handler is not there, the label is not
  there either.
- **No invented numbers.** An indeterminate task shows an indeterminate indicator, not a
  percentage; an empty sample shows nothing rather than 0%.

## Errors

- Name the cause and the next action. Never surface a raw provider body.
- A refused write is a failure state, not a success with a footnote: the draft stays in the inbox
  and the trader is told why.
- A failed turn is a row in the transcript, not a toast that disappears.
- A stop is visible. "Stop" aborts the work; it does not merely stop drawing it.

## Numbers and time

- Prices, P&L and R are mono, tabular, and formatted through the shared formatters.
- Journal times use the trader's timezone helpers, not the machine's clock.
- A number carries its provenance when it could be wrong: which model served the answer, which
  thinking tier it ran under, and whether the transport applied a capability route or skipped it.
  "Did not think" and "was never asked to" are different sentences.

## Volume

- No exclamation marks, no marketing, no "Welcome back".
- The answer is prose; the chrome is quiet. Data earns colour; decoration does not.
- One cyan accent per view. If everything is highlighted, nothing is.
