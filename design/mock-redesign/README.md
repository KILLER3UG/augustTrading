# Analyze & Chat redesign — mock

A **signal-first, minimalist** redesign proposal for the two surfaces that
carry the trader's decision: **Analyze** (`trade`, Alt+1) and **Chat**
(Agents thread, Alt+4). v2 applies the reference discipline (Kimi / Claude /
Qoder screenshots): whitespace over boxes, type carries structure, quiet
disclosures over chips, one centered column, one accent. Static mock — open
`index.html` in any browser; the toggles switch Analyze / Chat and 1440px /
800px.

Status: **proposal mock, not wired to the app.** It ships no app code and
claims no gate. The build pass would be: shared `SignalCard` mounted by
`TradeChatPanel` + `AgentsView` (emit receipt links `SignalRecord.id`,
`expiresAt` countdown, conviction; two level channels stay distinct —
`verdictLevels` overlay vs `KeyLevelsCard` `onChatLevels`); `OrderBookPanel`
re-parented as a collapsible chart drawer (portal stays Analyze-only,
single-column `GRID`, walls by weight); scorecard moved up from `SignalFeed`
(820px table stays behind); `BiasChips` mounts in Agents too, honest on fetch
failure. Prove with `npm run typecheck`, `npm run lint`, `npm run build`, then
`npm run render-probe` (the only gate that sees a rendered row) plus a manual
look at 1440 and 800. Contracts preserved: surface ids, one shared
`conversationId` across homes, `Message.botId` identity claim, dock geometry
(300–820px persisted), composer furniture parity.

## The problem (from the current captures)

- The chart is squeezed into a bottom sliver; most of the frame is empty black.
- The order book is a ~400px column wider than the candles themselves.
- The market header clips mid-number (`78,853…`, `$7.76…`).
- The Chart AI dock is an empty state; the signal exists only in Chat.
- Chat's verdict is a cramped row with evidence collapsed; the composer is huge
  and says nothing about what the desk saw.

## The answer (see the notes section in `index.html` for the full table)

1. **Signal is the hero** — direction, trigger, invalidation, targets, timeframe,
   confidence and evidence lead both surfaces (focus doc checklist).
2. **Accuracy is shown** — probability pairs with base rate + *n*; thin samples
   are badged; refusals are first-class evidence rows.
3. **Minimalist, not boxed-in** — the signal is a headline + rows, not a card;
   chips are a single quiet line; the composer says almost nothing (attach
   left, model right, one send circle); work is a quiet
   *Analyzed for 12s* disclosure; notebook memory is a
   *Recalled notebook · 2 sources* card (reference: Claude's "Recalled
   memory"); the chart snapshot is one compact attach card (reference:
   Claude's artifact card). Deliberately not borrowed: serif display type,
   coral/blue brand accents, upsell rows — the UX charter and voice doc
   forbid them.
4. **Chart owns the body** — domain hugs the tape; the book is a collapsible
   drawer inside the chart; drawing tools float on the canvas.
5. **Nothing implies execution** — actions read Log plan / Pin / Copy / Show.

Screenshots: `analyze-1440.png`, `chat-1440.png`, `analyze-800.png`
(rendered with Playwright; re-render with `node scripts/shoot-mock.cjs`).
