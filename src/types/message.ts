// Message and conversation display types

import { MessageRole, TradeOutcome, DebateSpeaker } from './enums';
import { TradeAnalysis } from './analysis';
import type { ReasoningEffort, WireAuditEntry } from './provider';

export interface DebateTurn {
  speaker: DebateSpeaker;
  text: string;
  /** Public reasoning summary emitted by the model, when the provider supports it. */
  reasoning?: string;
  /**
   * 1-based debate round (real inter-model debates only): 1 = opening
   * statements, 2-3 = rebuttals, then clarification cycles (one question
   * round + one answer round each), last = moderator verdict.
   * Absent on legacy/simulated transcripts (grouped by moderator turns).
   */
  round?: number;
  /** When this turn started streaming (real debates only) — powers replay. */
  createdAt?: string;
  /** Per-turn speed metrics: time to first token and
   *  output rate. Present on live-debate turns once measurable. */
  metrics?: {
    ttftMs?: number;
    tokensPerSec?: number;
  };
  /** FinCom disagree-or-commit markers parsed from this turn (Batch 4):
   *  the mandatory COMMIT:/DISSENT: skeleton each seat emits per peer.
   *  Feeds future conformity stats; absent on legacy turns. */
  fincom?: import('./learning').FinComMarker[];
  /** Addressed routing: the seats this turn was sent to, parsed
   *  from the speaker's REPLY-TO line. Absent = floor-wide (everyone reads). */
  to?: string[];
}

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker-buy base-asset volume (Binance kline field 9) — present on
   *  spot/futures klines fetched after the CVD detector; older cached rows
   *  and synthetic tests may omit it. volume − takerBuyVolume = taker sell. */
  takerBuyVolume?: number;
}

export interface GroundingChunk {
  web: {
    uri: string;
    title: string;
  };
}

// Multi-Timeframe Confluence Data for UI display
export interface ConfluenceData {
  score: number;  // 0-100
  direction: 'bullish' | 'bearish' | 'neutral';
  strength: 'strong' | 'moderate' | 'weak';
  alignedSignals: string[];
  conflictingSignals: string[];
  timeframeCount: number;
}


/** Lightweight per-run summary — durations, gate cap, Monte Carlo snapshot. */
export interface RunStats {
  /** Id of the user message that triggered this run — the join key
   *  between injection records and trades logged from this verdict. */
  runId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Gate confidence cap (0-1) applied during the run, if any. */
  gateCap?: number;
  /**
   * Fingerprint of the effective prompt layers for this run (registry
   * overrides + mode + lens state + hybrid toggle). Lets prompt changes be
   * MEASURED against outcomes later (per-version win/calibration stats) —
   * without it, editing a prompt globally could never be evaluated.
   */
  promptVersion?: string;
  /** live = registry overrides; control = built-in prompts (A/B). */
  promptLane?: 'live' | 'control';
  /** Debate-structure lane used by this run (standard/extended/efficient).
   * Deterministically assigned per setup — surfaced on the
   * signal card as a provenance chip.
   */
  protocol?: string;
  /** Point-in-time cutoff (epoch ms) the run's learning injections replayed
   *  to — a simulated/older run that saw the journal/skills as of this
   *  instant. Absent ⇒ live run (retrieval used today's state, unchanged). */
  asOfMs?: number;
  /** First analyst's Monte Carlo win rate (%), if computed. */
  mcWinRate?: number;
  /** First analyst's Monte Carlo expected value (R), if computed. */
  mcEV?: number;
  /** How many analysts ran. */
  analystCount?: number;
  /** Live-backtest summary: similar historical setups found for this plan. */
  btMatches?: number;
  btWinRate?: number;
  btEV?: number;
  /**
   * Per-analyst cost & latency ledger: who actually ran, with which model,
   * how long they took, and how much text they produced. App-computed so the
   * run can be audited after the fact (and the count can never silently claim
   * analysts that dropped out mid-debate).
   */
  analysts?: RunAnalystStats[];
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  /** The thinking tier this run was sent under — the RESOLVED tier, not the
   *  raw composer setting: 'auto' is a request to pick, and the row must show
   *  what was actually picked. It is written by the same resolution the
   *  request used (`resolveComposerEffort`), so the answer and the wire can
   *  never disagree about how hard the model was asked to think.
   *
   *  This is a fact ABOUT THE ANSWER, which is why it lives on the run: a
   *  trader reading an old transcript can see that it was produced under a
   *  different tier than today's, and a run's cost cannot be compared to
   *  another run's without it. */
  effort?: ReasoningEffort;
}

/** One analyst's entry in the run ledger. */
export interface RunAnalystStats {
  /** ProviderConfig.id — the key used across modelsUsed/calibration. */
  providerId: string;
  displayName: string;
  modelId: string;
  /** Team seat role short name ("Macro"/"Technical"/"Risk") when the run
   *  was driven by an active team and the seat carries a built-in role.
   *  Powers the floor + transcript role tags — UI-only, never prompted. */
  seatRole?: string;
  /** Focus dimension short tag for UNROLED team seats (the u1 diversity
   *  rotation, e.g. "structure", "risk") — distinguishes N general seats
   *  on the floor. Absent for roled/teamless seats. */
  seatFocus?: string;
  /** Wall-clock time for the initial analysis call, ms. */
  durationMs?: number;
  /** Combined output size (final output + thought process), chars. */
  charsOut?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string; // ISO string timestamp for when the message was created
  images?: string[];
  imageSummaries?: string[];
  /** Chart OCR text from the first vision pass — reuse instead of re-sending images. */
  ocrCache?: { texts: string[] };
  analysis?: TradeAnalysis;
  sources?: GroundingChunk[];
  postMortem?: string;
  postMortemCreatedAt?: string; // Timestamp for post-mortem analysis
  postMortemImages?: string[]; // To store screenshots from the post-mortem upload
  outcome?: TradeOutcome;
  ocrModelUsed?: string;
  correctedEntry?: string; // To store the user-provided correct entry price
  correctedStopLoss?: string; // To store user-provided corrected stop loss
  correctedTakeProfit?: string; // To store user-provided corrected take profit
  // Ensemble fields — keyed by provider id (ProviderConfig.id)
  modelsUsed?: Record<string, string>;       // providerId → model id used
  thoughtProcesses?: Record<string, string>; // providerId → thought process text
  //
  // The DELETED debate engine's own lane (`reasoningProcesses`) used to sit
  // here beside `thoughtProcesses`, and the two were joined at read time. It
  // is gone from the type: nothing writes it, and a field nobody may write
  // is a field nobody may depend on. Rows persisted before the engine was
  // deleted still carry the moderator's trace in it, so it is read exactly
  // once — `utils/traceText.ts` → `messageTraceText` — and folded into the
  // live map there. Do not reintroduce the key.

  debateTurns?: DebateTurn[]; // Holds the live debate conversation
  /** True while a single-model reply is actively streaming into the bubble.
   *  Cleared when the stream settles — drives live markdown rendering and the
   *  Thinking row's running state (perceived speed). */
  isStreaming?: boolean;
  /** The run ended before it finished — an explicit Stop, a failure mid-turn,
   *  or a turn the app closed on. Written by `utils/rowSettlement.ts` (the one
   *  rule both transcript homes use) and projected into `ChatRowView` /
   *  `LiveEntry`, where the in-flow "Run stopped" notice reads it. Without
   *  it, a half-written answer reads as a completed one that happened to be
   *  short. */
  interrupted?: boolean;
  /** Transient live desk-tool feed: speaker -> the RECENT tool lines, joined
   *  with newlines and capped, because it is what a bubble shows WHILE the
   *  answer is still coming. The settled trail is `toolEvents`. */
  liveToolEvents?: Record<string, string>;
  /** The turn's tool trail, one entry per line, in the order the desk called
   *  the tools. Unlike `liveToolEvents` this is NOT capped and NOT a blob: it
   *  is the record the work card draws, so the rows a trader opens are the
   *  rows the desk actually ran.
   *
   *  It exists because `liveToolEvents` is a newline-JOINED string — one
   *  entry for the whole turn — so a reader that took it for a list got ONE
   *  row holding every line, and the call/result pairing never happened. */
  toolEvents?: string[];
  /** The payload id for each entry of `toolEvents`, same order. '' (or a
   *  missing entry) means that line kept no payload: a `calling…` line never
   *  has one, and a guard line never will. The id is where the BYTES are; the
   *  line is what the seat saw — two questions, zipped by position. */
  toolIds?: string[];
  /** What the wire was actually asked, one entry per call the turn made.
   *
   *  It is what lets the answer say WHY it has no trace: the transport
   *  already decided which capability route it applied, and when it applied
   *  none it said why ("model id not recognized as thinking-capable"). Before
   *  this, "the model didn't think" and "the model was never asked to think"
   *  were the same silence. */
  wireAudit?: WireAuditEntry[];
  /** The turn FAILED, and this is why — the provider's own words, with the
   *  cause underneath ("fetch failed · ENOTFOUND: getaddrinfo ENOTFOUND
   *  api.example.com"). It is NOT the answer, and it is not a canned
   *  sentence: a failed turn used to be written into the text field, so the
   *  transcript showed the app's own hint as though the seat had said it. */
  error?: string;

  // Mode Tracking
  isLensMode?: boolean; // Was this analysis created with Analyst Lenses enabled?
  /** Failed-run retry: id of the user message whose prompt + charts can
   *  rebuild and re-dispatch the run (renders a Retry button on the error
   *  bubble). Undefined on successful runs. */
  retryOf?: { userMessageId: string };
  /** Pattern-memory gate outcome (HALT / REDUCE_SIZE / WARNING / PASS) —
   *  rendered as a banner on the analysis card. */
  patternMemoryGate?: PatternMemoryGateView;
  // Multi-Timeframe Confluence Score from Hybrid Intelligence
  confluenceData?: ConfluenceData;
  // Per-run execution summary (durations, gate cap, Monte Carlo snapshot)
  runStats?: RunStats;
  /** The composer slash-mode chip that produced this reply (persisted
   *  provenance: 'research' replies are pipeline reports, not chat). */
  composerMode?: 'research' | 'visualize';
  /** User pinned this setup — the header tray's "Pinned" list. The field keeps
   *  its legacy `watched` name because it is persisted in stored conversations.
   *  Autopilot still tracks every PENDING Long/Short the same way. */
  watched?: boolean;
  watchedAt?: string;
  /** NAC-style watch-thread episodes (pin, autopilot, log) — not a new outcome path. */
  watchEpisodes?: WatchEpisode[];
  /** ── Bot Mode ──
   *  A user-role row that is a teammate DM (rendered as an envelope, not a
   *  user bubble). The target's turn runs from it; the reply wakes the
   *  sender with a `dmNotice` row in THEIR thread instead. */
  dmFrom?: boolean;
  /** Structured view of the DM above: who sent it, the task, and the
   *  optional handoff fields. The renderer uses this to draw the envelope
   *  (sender header, task, muted constraint/expectation lines) instead of
   *  the flat prompt text; rows from before it existed render as before. */
  dmEnvelope?: {
    fromName: string;
    task: string;
    constraints?: string;
    expecting?: string;
  };
  /** A system notice produced by the DM machinery (reply wake-up, refusal,
   *  hop-cap hold). Rendered muted; never fed back into a model prompt. */
  dmNotice?: boolean;
  /** a room turn that resolved to "(pass)" — the row exists for thread
   *  attribution but renders nowhere (silence is a first-class outcome). */
  hidden?: boolean;
  /** The group ROOM this row belongs to (AgentGroup.id). Stamped by the room
   *  runner on every message it writes so a room's transcript is scoped by
   *  identity, not just by provider+model — recreating a group with the same
   *  bots starts an EMPTY room instead of re-claiming the old one. Absent on
   *  1:1/DM/ensemble rows (they never carry a room). */
  roomId?: string;
  /** The roster BOT that produced this row (AgentBot.id), stamped by every
   *  writer that answers AS a bot. Without it a bot's reply is attributed only
   *  by provider+model — which a solo Chat-AI answer from the same model
   *  matches exactly, so the desk pane dropped the trader's own answer into a
   *  bot's thread that never displayed it. `roomId` made this same argument for
   *  rooms; a 1:1 turn needed it too. Absent on desk/ensemble rows and on every
   *  row written before it existed, so those keep the provider+model fallback. */
  botId?: string;
  /** Notebook files / skills retrieved for this run (inspectable on the card). */
  memoryRetrieved?: Array<{ path: string; kind: string }>;
  /** "What would I do today?" — fresh forward-looking re-assessment of the
   *  closed trade's setup against the current market price. */
  todayReassessment?: TodayReassessment;
  /** Pre-read capture (Batch 5, opt-in training mode): the user's own
   *  direction + confidence committed BEFORE the verdict card revealed.
   *  Rides the message so the journal can show user-prior vs verdict vs
   *  outcome — the human-Brier vs ensemble-Brier anti-automation display. */
  userPriorCall?: UserPriorCall;
  /** The stable id of the trade plan this message presents (minted by the dock
   *  at `present_trade`, shared with the level-watch). Stamped onto the journal
   *  row at log time, so a plan, its watch and its outcome stay joinable — and
   *  so the "Log this trade" card dedupes on a field instead of on the rendered
   *  headline text. */
  planId?: string;
  /** The trade plan a model PRESENTED on this row via the `present_trade` tool.
   *  The decision card both homes render comes from this field: the dock stores
   *  it on its own entry, the Chat surface on the canonical row, and
   *  `liveEntryFromMessage` projects one into the other by `m.id` — so a plan
   *  said in one surface is a plan the other surface can log, not a second one.
   *  Type-only import: `proposedTrade` imports `Message` back, and a value
   *  import here would make that a runtime cycle in the bundle. */
  proposal?: import('../services/trade/proposedTrade').TradeProposal;
  /** Persisted model side-effects: proposal tools and file
   *  creations this run produced, for the status rows on
   *  the bubble ("Saved to memory · N entries", "⚠ Memory write noted").
   *  Append-only; capped by the pipeline. */
  toolActions?: ToolAction[];
  /** The notebook skill slugs that travelled in THIS turn's system prompt
   *  (stage 20s). Recorded, not inferred: "the model had 30 skills available"
   *  and "the model was shown these five" are different questions, and only the
   *  second one can be audited after the fact. */
  injectedSkills?: string[];

  /* ── Revert and versions (owner ruling, 2026-10-27) ──────────────────────
     A revert here changes the TRANSCRIPT and nothing else: memory, skills,
     logged trades and armed watches a reverted turn produced stay exactly as
     they were. The turns a revert takes off the thread are PARKED, not deleted
     (see `Conversation.parked`), so the operation runs backwards as well as
     forwards. */
  /** Prompt texts this row carried BEFORE the trader edited it, oldest first.
   *  The live `text` is the newest version, so an unedited message has no key
   *  at all rather than an empty one. */
  edits?: import('../utils/messageVersions').PromptEdit[];
  /** Superseded generations of this ANSWER, oldest first. Written when a
   *  message is edited and re-run: the answer that was there before is a
   *  generation, not a deletion. */
  gens?: import('../utils/messageVersions').TurnSnapshot[];
  /** Which generation is being shown; absent means the newest. Read through
   *  `utils/messageVersions.ts` so the dock and the Chat surface cannot
   *  disagree about which answer is on screen. */
  gen?: number;
}

/** A committed pre-read call. `confidencePct` is the user's own
 *  0-100 belief that their direction plays out (TP before SL). */
export interface UserPriorCall {
  direction: 'Long' | 'Short' | 'Flat';
  confidencePct: number;
  /** ISO timestamp at commit (before the reveal). */
  createdAt: string;
}

export interface WatchEpisode {
  at: string;
  kind: 'watched' | 'unwatched' | 'autopilot' | 'logged' | 'price' | 'invalidation' | 'expired';
  detail: string;
}


/**
 * One model side-effect on a run — the persisted counterpart of the
 * transcript status rows ("Saved to memory · 6 entries",
 * "⚠ Memory write noted · 7 items"). Proposal-class actions
 * (forge_tool / amend_memory) and file creations persist here so the
 * transcript can show what the models CHANGED, not just what they said.
 */
export interface ToolAction {
  /** Wall-clock stamp (ISO) of when the action ran. */
  at: string;
  /** The seat/bot that ran it (speaker name). */
  speaker: string;
  /** Tool name — forge_tool, amend_memory, or a custom_ tool. */
  tool: string;
  /** ok = accepted as a candidate/pending item; !ok = rejected/failed. */
  ok: boolean;
  /** short verb for the status row ("proposed", "amended", "created"). */
  verb: string;
  /** short human label of the target ("sketch-momentum", "notebook/edge_rules"). */
  label: string;
  /** Where a human reviews it ("Settings → AI Models", "Settings → Memory"). */
  review: string;
}

/** "What would I do today?" — fresh forward-looking re-assessment of a closed
 *  trade's setup against the current market price. */
export interface TodayReassessment {
  verdict: 'YES' | 'NO' | 'MAYBE';
  text: string;
  /** Current market price used for the reassessment (0 = unavailable). */
  price: number;
  createdAt: string;
}

/**
 * Pattern-memory gate outcome, surfaced on the analysis card and journal row
 * so the user can audit when memory HALTED / downsized / warned a trade —
 * previously the gate was prompt-only and invisible.
 */
export interface PatternMemoryGateView {
  gateResult: 'PASS' | 'WARNING' | 'HALT' | 'REDUCE_SIZE';
  /** Human-readable reason (includes the emoji severity prefix). */
  reason: string;
  /** Questions the moderator was forced to address. */
  mandatoryQuestions: string[];
  /** The most similar historical trades (compact, serializable). */
  historicalFailures: {
    coinName?: string;
    direction?: string;
    /** Display-only outcome label (the gate's synthesis uses its own set). */
    outcome?: string;
    /** Extracted lesson from the matched trade's post-mortem. */
    keyLesson?: string;
  }[];
}

export interface ImageMetadata {
  file: File;
  dataURL: string;
  summary?: string; // This will now be the minimal UI string
  fullAnalysisText?: string; // This will hold the full analysis payload text
  isLoading: boolean;
  ocrModelUsed?: string;
}

export interface LiveThoughts {
  [providerId: string]: string | null;
}
