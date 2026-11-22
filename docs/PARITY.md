# Parity checklist

One screen: every core capability, the sensor that proves it, and the row that
has no automated sensor. A `manual` row is a claim we do **not** make on a
green gate. Cite code by symbol, never by line.

| Capability | Where it lives | Sensor |
|---|---|---|
| Waves A–C quant math (structure, liquidity, derivatives, sessions, catalysts) | `src/services/market/auctionCore.ts` › `failedIbExtension`; `src/services/market/derivativesCore.ts` › `fundingState`; `src/services/analysis/MarketDataService.ts` › `estimateBookSlippage` | `test:fast` + `check:contracts` |
| Incremental Chat/Desk `<thinking>` streaming, `<` safety, both layout modes | `src/utils/thinkingSplit.ts` › `createThinkingStreamGate`; `src/services/analysis/DeskToolsService.ts` › `streamChatWithDeskTools` | `test:fast` + `render-probe` |
| Curated memory (bounded USER.md/MEMORY.md, hard cap, undo, frozen snapshot) | `src/services/learning/curatedMemory.ts` › `applyCuratedMemoryOps` | `test:fast` + `check:contracts` |
| Unified `session_search` (one reader, both homes, surface-tagged) | `src/services/trade/sessionSearchTool.ts` › `searchAllSessionsForTool` | `test:fast` + `check:contracts` |
| `skill_manage` lifecycle + one-pen writes + read-before-write | `src/services/learning/skillManage.ts` › `skillManage`; `src/services/learning/SkillFileService.ts` › `writeSkillFile` | `test:fast` + `check:contracts` |
| O-150 forward tests, `nEffective`, promotion floor, reversible rejections | `src/services/selfMod/harnessOptimization.ts` › `gradeParent`; `src/services/learning/skillManage.ts` › `promoteSkillToVerified` | `test:fast` + `check:contracts` |
| SIM provenance + EfficientSkill post-verification pruning | `src/services/learning/rejectedFingerprints.ts` › `resolveProvenance`; `src/services/learning/skillManage.ts` › `pruneVerifiedSkill` | `test:fast` + `check:contracts` |
| Background review + periodic Dream (receipted, reversible, capped) | `src/services/learning/learningPassWiring.ts` › `emit`; `src/services/learning/memoryDream.ts` › `runMemoryDream` | `test:fast` + `check:contracts` |
| `update_plan` pill (turn-scoped, latest plan across both session keys) | `src/components/trade/TurnPlanPill.tsx` › `TurnPlanPill`; `src/services/analysis/DeskToolsService.ts` › `executeDeskTool` | `check:contracts` + `render-probe` |
| Minimalist monochrome shell, six surfaces, utility rail outside `<main>` | `src/App.tsx` › `App`; `src/components/shell/UtilityRail.tsx` › `UtilityRail` | `check:palette` + `render-probe` |
| Local Paper Broker: L2 fill, strict-cross limits, mark liquidation, funding, risk walls | `src/services/paper/paperCore.ts` › `placePaperOrder`; `src/services/paper/PaperBrokerService.ts` › `submitPaperOrder` | `test:fast` + `check:contracts` |
| Paper filled → Trade Log; All · Live · Paper split never pollutes live stats | `src/services/paper/paperJournal.ts` › `paperSourceOf`; `src/services/tracking/paperExecution.ts` › `filterTradesBySimulationMode` | `test:fast` + `render-probe` |
| Two narrow desk tools granted to Chat and Desk, Paper Mode refusal | `src/services/analysis/DeskToolsService.ts` › `paper_account`; `src/services/trade/chatSurfaceTurn.ts` › `CHAT_SURFACE_TOOLS` | `check:contracts` + `check:boundaries` |
| Production bundle boots; rendered rows and inert controls on all six surfaces | `scripts/boot-probe.cjs`; `scripts/render-probe.cjs` | `boot-probe` + `render-probe` |
| Packaged Windows installer launches | `scripts/installer-smoke.cjs` | `installer-smoke` |

**Manual only — no gate proves these:**

- Packaged `.exe` with a real provider key streaming a live turn — `manual`.
- Real GitHub auto-updater flow (signed release, download, apply, relaunch) — `manual`.
- Live ISP disconnect/reconnect and the market-feed recovery path — `manual`.

`verify:fast` is the batch of read-only gates, not a weaker gate; `probe:fast`
runs both browser probes against a fresh-or-explicitly-rebuilt bundle.
