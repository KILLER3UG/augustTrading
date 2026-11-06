# Current focus — a trading harness, not a P&L tracker

**Owner directive, 2026-10-29.** This page outranks the roadmap when they disagree.

August cannot place an order yet. It has no exchange account and no API trading key, so **P&L,
settlement and "how much did I win or lose" are accounting, not trading** — they are not the product
line. Until execution exists, every enhancement must make the trader better at one of three things:

1. **Market analysis** — reading structure, liquidity, derivatives context, sessions and catalysts.
2. **Accuracy** — making every number and every claim more verifiable, better grounded, or easier to
   refuse when the evidence is thin.
3. **Signals** — giving the trader a decision they can act on: direction, trigger, invalidation,
   targets, timeframe, confidence, and the evidence behind it.

The harness is tool-driven and iterative in the way a coding harness is: it explores the market with
real tools, forms a view, tests it against history and the tape, and refuses when the evidence does
not support a decision. The output that matters is a **signal or a refusal**, not a paragraph.

## The test for every new feature

A change earns its place only if it can answer:

- **Which trader decision does it improve?** Analysis, entry/exit, risk, or passing.
- **What evidence does it use, and how is that evidence verified?**
- **What does it refuse to do when the evidence is missing?** A feature with no refusal path is an
  opinion machine.

If the answer is "it shows the trader their P&L", it is not the current product.

## What this deprioritizes

- **P&L, settlement, win/loss dashboards and the session risk guard as the main line.** They stay
  built where they already exist, and they remain useful for the trader's own records, but they are
  not what the next feature should be.
- **Journal-settled trade evidence as the primary learning loop.** The tracker follows both desk
  signals and accepted journal plans, and the loop that improves accuracy is **signal → price
  outcome → diagnosis**, which needs no execution and no trader click. The step that used to mint a
  **tentative skill** from three agreeing outcomes is deleted (2026-11-05): a skill is a document
  the desk or the trader writes, not a record the loop stamps. The diagnosis still reaches the next
  read — see [the learning loop](../architecture/learning-loop.md).
- **Execution, broker keys and order placement.** Not now, and never without an owner ruling.
- **Breadth for its own sake** — multi-market equities, fundamentals, options chains, alpha zoos.
  August trades the tape it can see; depth on that tape beats a second market.

## What this does not change

- **The agent proposes; deterministic code checks; the trader decides.** Still the invariant.
- **No order placement, no account access, no API trading key.** Still the non-goal.
- **One trader, one seat, one notebook, local-first.** Still the product.
- **A label is a promise.** If a feature says "signal", it must carry direction, invalidation and
  evidence; if it says "accuracy", it must show the sample and the base rate.

## The hole this focus exposes

Today the seat's output is a chat answer plus a full trade plan. There is no **first-class signal**
with a lifecycle, no **price-based record** of whether yesterday's calls were right, and no
**measured base rate** shown beside a claim. The journal measures the trader's decisions; nothing
measures the harness's. That is the work: make the signal the unit, measure it against the tape,
and feed the measurement back into the next signal.

**Phase 1 shipped 2026-10-29:** the `emit_signal` desk tool, an append-only signal ledger
(`signal_ledger_v1:<user>`, backed up), a deterministic resolver (closed OKX 5m candles, Binance
cross-check, stop-first on an unknowable bar, costs in R), two shadow checks (the programmatic gate
and an evidence check — neither blocks), and Journal → Signals. **Phase 2 shipped 2026-10-30:** every
resolution carries the same-levels base rate, the feed shows hit rate vs base with a thin-sample floor,
and the next `emit_signal` receipt carries the coin's scorecard.

**Closed 2026-11-02 (b3):** resolved signals and accepted journal plans are followed by the tracked
position loop; on close, `runDiagnosisPass` (`services/tracking/postMortemDiagnosis.ts`) writes the
structured diagnosis, and `diagnosisBriefBlock` (`services/tracking/diagnosisBrief.ts`) carries that
coin's last recorded lesson into the next read — the dock's context block, the pipeline's context
bundle and the `emit_signal` receipt. It is REFERENCE ONLY: never a veto, never a confidence cap,
and never a skill. See [the learning loop](../architecture/learning-loop.md).
