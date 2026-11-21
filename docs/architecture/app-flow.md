# app-flow — the live execution graph

The end-to-end runtime of the desk as it actually executes, verified against
the current tree. Every node lists its trigger, its read/write boundary, its
budget and its failure edge. **"The loop lives inside the node; the graph
governs the boundaries"** — nodes own their internal loops; the graph owns who
may talk to whom.

Read with [system-map.md](system-map.md) (how the code implements the flow)
and [learning-loop.md](learning-loop.md) (the memory loop in depth).

## 1. The graph

```
 trader ──Enter/Alt+Enter──▶ ChatComposer ──▶ runSeatTurn ──▶ runToolTurn ──▶ runDeskToolLoop
                                 │                                              │  (≤8 rounds, 5s/call, turn budget)
                                 │ steering (queued)                            ▼
                                 │                                    executeDeskTools ──▶ executeDeskTool
                                 ▼                                              │        (seat allow-list,
                        [HARNESS SIGNAL] ◀── levelWatch/watchService ◀── WebSocket tick  │  memory-off, provenance,
                                 (idle drain)                                   ▼         skill pen, forge scan)
                                                                        adversaryReview (present_trade only)
                                                                                 │ pending_review → armed
                                                                                 ▼
 trackerService (60s heartbeat) ──▶ runDiagnosisPass ──▶ hindsight audit ──▶ autonomyEngine.notePostMortemLesson
        ▲
        │
 autonomyEngine.ensureBackgroundLoops (2min tick) ──▶ sentinel / maintenance / bench flags
        │
 Tier 0 manifest ──▶ latest USER turn (never the frozen prefix)
```

### Nodes (live, in execution order)

| Node | Trigger | Reads | Writes | Budget | Failure edge |
|---|---|---|---|---|---|
| **WebSocket tick** (`TradeView` mark effect) | markPrice ~1s + kline closed flag | chart snapshot (drawings, ATR14, evalCandles), `chatSnap.activeId` | `levelWatch.tick(symbol, price, {atr14})`, `watchService.tick`, `tickDrawingWatches` | none (passive read) | early return on non-finite price; snapshot/symbol mismatch skips |
| **`watchdogCore.evaluateDrawingWatch`** | every tick, per watched drawing | drawing geometry, ATR, candles | latch state map | ATR tolerance + 0.5·ATR hysteresis + bar cooldown | returns no event (no throw) |
| **`sentinelLoop` via `evaluateSentinelTrigger`** | watchdog event | isolated packet ONLY (profile slice + Tier 0 summary + skill hint + event) — **never chat prose** | notice queue (≤12), autonomy ledger | budget 24/h · 90s/symbol cooldown · backoff 30s→15min · paused = no model | deterministic fallback on any model failure; `SILENT_DISMISS`/`SILENT_MAINTAIN` never reach chat |
| **`maintainAgentDrawings`** | same tick, 60s/symbol | `model` drawings bucket ONLY (`origin:'agent'`) | expiry + cap ≤8 + `august:agent-drawings-changed` event + ledger record | 60s/symbol throttle | catch → no-op; user bucket structurally unreachable |
| **`runSeatTurn` → `runToolTurn` → `runDeskToolLoop`** | trader Enter (or steering/follow-up/harness drain) | session transcript, Tier 0 context, skill/memory index | streaming row, tool actions, proposals, drawings | ≤8 rounds · 5s/tool deadline · `DESK_TURN_BUDGET_MS` turn budget · token ceiling | mid-turn steering skips batch calls with synthetic pair-valid replies; abort → `interrupted` settle; ceiling repairs (bounded) |
| **`adversaryReview`** | every `present_trade` (after mint) | plan bracket, net R:R, ATR, trend bias, calibration — **never chat prose** | card badge patch; **arm** on APPROVE/CAUTION/UNAVAILABLE | 13s timeout | timeout/transport failure → `UNAVAILABLE` → arms as before the reviewer existed |
| **`trackerService` 60s heartbeat** | `initTracker` interval | positions, journal settlements, signals | diagnosis queue, settlements | MAX_ADOPT_PER_PASS=8 | pass catch → next tick |
| **`runDiagnosisPass`** | tracker pass, queued terminal positions | positionStore, journal outcome (AUTHORITATIVE), packet | diagnosis rows + hindsight-refusal rows | MAX_DIAGNOSIS_ATTEMPTS | malformed/malformed-retries → refusal row, never a crash |
| **hindsight audit** | every diagnosis answer | answer text vs pre-entry packet facts | refusal row on leak | — | leak → refusal row; the lesson never reaches memory |
| **`notePostMortemLesson`** | diagnosis saved (post-audit) | diagnosis lesson/when/action, evidence pool | candidate pool → `profileMemory` promotion at ≥3 evidence × ≥3 sessions | floors enforced by `checkProfileBiasPromotionEligibility`; risk-shaped lessons NEVER write | refused → dropped, recorded in ledger |
| **idle maintenance** (`ensureBackgroundLoops`, 2min tick) | chat idle × (≥6h OR ≥3 new resolutions) | memory index, skill rows, calibration buckets, signal ledger | memory ops (≤3/pass, via `rememberProfileMemory`), ONE skill refine via `writeSkillFile`, bench flags | budget gate · memory-OFF hard stop · paused = skip · `writeSkillFile` gates (duplicate scan, index version) | every op carries a ledger undo; failures → notes, never throws |
| **microcompaction** (stage 1, every loop round) | always | outbound messages past the tail | stub stale bulky `tool` outputs (>2,000 chars → head + re-read pointer) | tail-protected | zero-LLM-cost; savings reported to the trace |
| **two-stage compaction** | 80% window pressure | full conversation | sanitized digest (4 headings) injected into the NEXT request | `COMPACTION_SUMMARY_MAX_CHARS` | failed summary = the send path still compacts structurally |

### Write-ownership matrix (who may write what)

| Writer | chat transcript | user drawings | AI drawings | profileMemory | notebook | harness settings | Risk Constitution | watches |
|---|---|---|---|---|---|---|---|---|
| Trader (composer/cards) | ✓ | ✓ | — | via tools ✓ | via tools ✓ | Settings only ✓ | Settings only ✓ | via tools ✓ |
| Interactive model turn | streams ✓ | via `draw_on_chart` ✓ | ✓ | via `memory_add` ✓ | ✓ | propose-only (card) | **never** | via `watch_price` ✓ |
| sentinel / maintenance loops | notice queue only (idle drain) | **never** | expire/cap only | via gated promotion ✓ | via `writeSkillFile` ✓ | **never** | **never** | re-arm via notes only |
| adversaryReview | card patch only | **never** | **never** | **never** | **never** | **never** | **never** | arm-on-clearance only |
| post-mortem bridge | — | — | — | candidate pool → gated promotion | refusal rows | **never** | **never** | — |

### Code-decided vs model-decided edges

**Code-decided (the model cannot argue):** inverted-plan refusal, min-edgeR
floor, session guard, R:R floor, seat allow-list, memory-off refuse list,
skill duplicate scan + index/version gates, ATR hysteresis/cooldowns,
stale-is-not-news watch refusal, evidence/shadow gates on emit_signal,
adversary timeout → UNAVAILABLE, VETO holds the arm, budget ceilings.

**Model-decided (inside the code-decided rails):** which tools to call, the
counter-thesis content, the verdict phrasing on the card, which memory ops to
propose in a maintenance turn, the refined playbook BODY (still passes the pen's
gates), which skill the bench flag names.

## 2. Memory & Skills lifecycle

```
 frozen system prefix (per session|seat|model|toggles|constitution-hash)
   ├─ [TRADER RISK CONSTITUTION] ← Settings → Harness ONLY; autonomous writers
   │                                are structurally unable to touch it
   ├─ TRADE_CHAT_SYSTEM_PROMPT (4 layers: identity / hard rules / workflow /
   │   dispatch+formats) — immutable in code
   └─ skills index + memory index + strategies (SNAPSHOT at freeze)
          │
          ▼ every user turn
 Tier 0 manifest + delta note ──▶ LATEST USER TURN (append-only: the prefix is
                                   never mutated mid-session)
          │                        delta note = NAMED diffs: skills/memory
          │                        added · edited · removed since the freeze
          ▼
 skill_view (Tier-2 body, on demand) · memory_read (body on demand)
          │
          ▼
 profileMemory rows: bi-temporal — validFrom (creation/body change) ·
 invalidatedAt + supersededBy + invalidatedBy (retire/forget) · previous
 (one generation) · derivedFrom (merge trail) — readers filter invalidated
 rows exactly like deleted ones, so the model never sees a contradicting pair
          │
          ▼
 calibration: emit_signal stamps skillSlug×regime×htf×drawings → settlement
 MFE/MAE → calibrateByDimensions buckets → Skills bench flags (≥5 fills,
 <40% hit) → tighten/retire flagged in the feed → refineOneSkill targets the
 worst bucket through writeSkillFile's own gates
```

## 3. Tool & loop contract

- **Two-stage compaction:** stage 1 (microcompaction, zero LLM cost) stubs
  stale bulky `tool` outputs past the protected tail EVERY round
  (`MICRO_STUB_CHARS` = 2,000, head 700, `tool_call_id`/name preserved,
  re-read via `read_tool_output` artifacts); stage 2 only runs when pressure
  still crosses the ceiling (body shrink → group drops), then the background
  80%-window summarizer sanitizes a 4-heading digest into the NEXT request.
  Savings land in the trace (`microcompaction −N chars`).
- **Two-speed input:** Enter while busy = steering (loop consumes at the next
  round boundary; unexecuted batch calls get synthetic pair-valid
  `"Skipped: user steered mid-turn"` replies so strict providers never see an
  orphan tool_call); Alt+Enter = follow-up (delivered as its own turn at
  settle). Esc = abort (settles as `interrupted`, no partial reveal).
- **Per-role model tiering:** `resolveBackgroundSeat(user, role?)` resolves
  role → `seats[role]` → default `seat` → first ready provider. Roles:
  `sentinel`, `compaction`, `maintenance`, `adversary`. Configure in the
  AUTO drawer → Per-role overrides; empty = the default background seat.
- **Trace Inspector:** collapsed `<details>` per settled turn — prefix hash +
  CACHE WARM/PREFIX CHANGED, Tier 0 revision, turn ms, tokens in/out, gate
  refusals, microcompaction savings. All measured; never inferred.
- **Trajectory export:** Journal → Signals → Export trajectory — JSONL rows
  with `known_at_decision_time` (bracket, net R:R, dimension stamps, tape
  hash, prompt version, adversary verdict) strictly separated from `outcome`
  (status, MFE/MAE, netR, hindsightLeakFree); unresolved rows filtered unless
  `includeOpen` tags them.
