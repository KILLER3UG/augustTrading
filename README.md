# August Trading

August Trading is a **local-first AI trading work harness for one trader**: a React + TypeScript
desktop/web app that does the trader's work — prep, scan, plan, manage, journal, review, improve —
around a single AI seat that reasons over the trader's notebook (skills + doctrine) and live market
data through a bounded set of tools.

**The agent proposes. Deterministic code checks. The trader decides.** Closed trades feed a
self-auditing memory loop that is re-verified against the trade journal; settlement is
human-confirmed today.

Code lives under [`src/`](src/). The full goal and the non-goals are in
[docs/product/goal.md](docs/product/goal.md).

## What it is not

August Trading **places no trades**. It has no exchange account access, no API trading key, and no
order-placement code path: every Binance call is a public market-data endpoint. It reads, analyses,
proposes, records and journals — a plan is the model's reading of a chart, never an instruction to an
exchange. It is not financial advice.

Your journal, notebooks and drawings stay on your machine. When you send a message, that message plus
the market context for the instrument you are looking at is sent to **the AI provider you
configured**. See [PRIVACY.md](PRIVACY.md).

## How it works

```
trader sends → surface prompt (mandate + skills index + strategies + profile memory)
             → tool turn: the seat calls bounded desk tools (indicators, screener,
               market packet, chart view, journal, notebook recall, web search)
             → present_trade → zod-validated plan → deterministic gate
                (confidence cap, pattern memory, regime, volume)
             → the proposal card → THE TRADER DECIDES → R:R clamped at log time → journal
             → settlement reflection → skill evidence → draft gates → human approval
             → the next plan's context includes what the loop learned
```

- **The harness contract** (`src/constants/prompts/harnessContract.ts`) is the single source of
  truth for output and plan rules; prompts compose through `utils/composePrompt.ts` so the contract
  appears exactly once.
- **Memory** is a trader notebook (`services/learning/MemoryRetrievalService`): one narrative voice
  (doctrine), everything else ranked data under hard per-stage char budgets; skills escalate from
  candidate → confirmed → retired on journal evidence; the injection ledger records what the
  retrieval layer selected for each prompt.
- **Desk tools** (`services/analysis/DeskToolsService.ts`) give the seat bounded live tools
  (derivatives, order book, liquidations, BTC context, session, price snapshot, indicators,
  screener, Monte Carlo, web search) plus `recall` — pull-based search over the trader's notebook.

The loop, stage by stage: [docs/architecture/learning-loop.md](docs/architecture/learning-loop.md).

## The six surfaces

**Analyze** (Alt+1) — the chart, the order book and the Chart AI dock. It reads; it never trades.
**Journal** (Alt+2) — the record plus the review over it: history, stats, weekly/monthly reviews.
**Agents** (Alt+4) — a roster of named bots, DMs and rooms over the same thread as the chart dock.
**Learning** (Alt+5) — learning diagnostics: scorecards, harness lessons, versions, usage.
**Skills** (Alt+3) — the skill library: document folders, search, read, edit, import.
**Memory** (Alt+6) — the notebook, the pattern synthesis and the raw files.

Anatomy and states: [docs/product/ux/surfaces.md](docs/product/ux/surfaces.md).

## Providers

There are no hardcoded provider/model constants. Providers are configured at runtime
(Settings → AI setup), stored in Preferences (`provider_configs_v1`, encrypted at rest on desktop via
Electron `safeStorage`), and every AI call goes through
`src/services/providers/GenericProviderService.ts` (chat_completions / messages / responses /
google wire formats, retry + timeout built in).

## Commands

```bash
npm run dev                 # dev server on port 3000
npm run build               # tsc --noEmit && vite build
npm run typecheck           # tsc --noEmit
npm run lint                # eslint, warnings capped by a ratchet
npm run check:contracts     # the pure-logic contracts (node only, no suite)
npm run check:docs          # doc links + symbol citations + gate names
npm run electron:dev        # Vite dev server + Electron window
npm run electron:build      # Windows installer
```

CI runs the type checks, the doc and contract gates, `lint`, `build`, and the three browser probes
(boot, render, skill-approval). A `v*` tag runs the release workflow: it builds once with
`--publish never`, verifies the installer, and only then publishes it. Neither workflow builds
artifacts on a developer machine.

## Layout

| Path | Contents |
|---|---|
| `src/App.tsx`, `src/index.tsx`, `src/index.css` | the app entry |
| `src/components/` | UI, one directory per domain (`trade/`, `journal/`, `agents/`, `learn/`, `chat/`, `settings/`, …) |
| `src/hooks/` | `useAnalysisPipeline` (the send path) + supporting hooks |
| `src/services/` | providers, learning (memory/skills), backtesting, trade, infrastructure |
| `src/constants/prompts/` | all model-facing prompts; `promptRegistry.ts` makes them user-editable |
| `src/schemas/` | zod boundary schemas for AI JSON |
| `electron/` | desktop shell (safeStorage, auto-update) |
| `shared/` | `providerRequestPolicy.cjs`, the one wire policy for renderer, dev proxy and Electron |

## Documentation

- **[docs/README.md](docs/README.md) — the reading path.** Start here.
- [docs/product/](docs/product/) — the goal and the UX: charter, surfaces, voice.
- [docs/engineering/](docs/engineering/) — gates and code conventions.
- [docs/plan/](docs/plan/README.md) — the working register: what is still open, with the evidence.
- [docs/architecture/](docs/architecture/) — the system map and the learning loop.

## License

MIT — see [`LICENSE`](LICENSE). Bundled third-party material is credited in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
