# The goal

August Trading is a **local-first trading work harness for one trader** — the owner. It is not a
chat window with a chart attached, and it is not an execution terminal.

> **Current focus (owner, 2026-10-29).** The harness cannot place orders yet, so P&L and settlement
> are accounting, not the product line. Until execution exists, every change must improve **market
> analysis, accuracy or signals**. See [focus.md](focus.md), which outranks this page when they
> disagree.

## What it does

The work runs in a loop, and every surface exists to serve one step of it:

```
prep → scan → plan → manage → journal → review → improve
```

- **prep** — read the instrument: the chart, the levels, the session, the derivatives context.
- **scan** — find setups across a universe, not one symbol at a time.
- **plan** — turn a reading into a trade plan: entry, stop, targets, invalidation.
- **manage** — watch the levels that matter; notice when a plan is invalidated or resolved.
- **journal** — record what was actually decided and what happened.
- **review** — settle the outcome and check the plan against the result.
- **improve** — turn settled evidence into skills and notebook the next plan is built with.

## The invariant

**The agent proposes. Deterministic code checks. The trader decides.**

The model never places an order, never writes to an exchange, and never overrides a gate. A plan is
the model's reading of a chart. The trader presses the button. This is the line every feature is
measured against: if a change moves a decision from the trader to the model, it is not an
improvement.

## Non-goals

- **No order placement.** No exchange account access, no API trading key; every Binance call is a
  public market-data endpoint. A plan is never an instruction to an exchange.
- **Not financial advice.**
- **Not multi-user, not a team product.** One trader, one seat, one notebook. No roles, no review
  queues for other people.
- **Not a debate/ensemble system.** The tool-driven single seat replaced it; the deletion is final.
- **Not a light theme.** Dark, hue-free neutrals, and colour only where it means data.
- **Not a data platform.** The journal, notebook and drawings stay on the trader's machine.

## What "working" means

The loop is only closed when what happened changes what the next read says:

1. A proposal is logged with its entry, stop, targets and the tier that produced it.
2. The outcome is detected and settled — today, human-confirmed.
3. The settlement writes the journal, the diary entry and the recurring-mistake note, and a
   tracked position gets its own structured diagnosis. A skill is not written by this step: a
   skill is a document the trader or the model writes.
4. The next plan's context includes what the notebook learned.

Steps 1 and 2 exist. Step 3 no longer feeds a skill ledger at all — a skill is a document the
trader or the model writes, and settlement writes the journal, the diary and the recurring-mistake
note. Step 4 is the open work: whether what the notebook learned actually reaches the next read.
`docs/plan/open-items.md` is the register of what is missing.

**The current build order is not this loop.** Until execution exists, the learning loop that
matters is **signal → price outcome**: a signal is recorded, the tape resolves it against its target
and invalidation, and the measured result feeds the next signal. The journal loop above remains the
trader's own record and the loop August will need when it can execute; it is not what the next
feature should serve. See [focus.md](focus.md).

## Who this is for

The trader who owns it. Every UI decision is judged by one question: does this help one person make
and review a decision faster, with fewer invented numbers between them and the market?
