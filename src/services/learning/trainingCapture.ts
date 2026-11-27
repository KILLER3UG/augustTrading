/**
 * trainingCapture — the "Improve future August models" recorder.
 *
 * WHAT IT IS. When the trader turns the toggle ON (Settings → Data, default
 * OFF), every desk turn that settled into a decision — a presented plan, a
 * decline, or an emit_signal — is appended to a local corpus: the trader's
 * words, the model's reasoning, the tool trail, the actions, and the
 * decision itself, keyed by planId so the journal's outcome joins at export
 * time. The corpus is the fine-tuning fuel for a future trading-focused
 * August model; it never leaves the machine.
 *
 * FORMAT: one JSON object per turn in the export (JSONL), NOT markdown.
 * Decided, with the reasons: (1) fine-tuning pipelines consume JSONL natively —
 * the repo already exports journal records as NDJSON (reportExport), so one
 * format serves both stores; (2) the corpus is an ordered event log — the
 * export is append-friendly, and a human-readable digest belongs in the export
 * step, not the store; (3) the shape is machine-fact (messages, reasoning,
 * actions, outcome) — markdown is for human documents, and this repo already
 * keeps that split (skills are .md, goals and self-changes are .json).
 *
 * The STORE is a single JSON document, read-modify-write under a serialized
 * queue (`withCaptureLock`): two fire-and-forget turns must not both read N
 * records and write N+1. A read that FAILS is not an empty corpus — the write
 * is refused, because overwriting the file with the one record in hand is how
 * a corpus starts lying about what the model actually said.
 *
 * PRIVACY, in order: the toggle defaults OFF and turning it back on after a
 * restore is a conscious act (the flag deliberately does NOT ride in
 * backups); OFF means NOTHING is written — not buffered, not truncated, not
 * sampled; the corpus is local-only (desktop store) and is never uploaded;
 * the flag does not ride in backups.
 *
 * STORAGE: the desktop file store (`electronAPI.store`, atomic JSON files
 * under `<userData>/store`) — the same bridge the big stores use, under its
 * own key, NOT in Preferences (the 5 MiB web quota is not this corpus's
 * home). On web there is no such bridge: the recorder reports
 * `desktop-only` and captures nothing rather than quietly doing less.
 *
 * THE CAP REFUSES, IT NEVER EVICTS — the same ruling as the notebook and the
 * profile memory: every record is unique data, and silently dropping the
 * oldest to make room for the newest is how a corpus starts lying about what
 * the model actually said. At the cap the append is refused and the refusal
 * is surfaced (recordCount + refusedOnce), with the export as the drain.
 */

import type { ToolAction } from '../../types/message';
import type { LoggedTrade } from '../../types/trade';
import type { SignalRow } from '../../types/signal';
import type { PaperSettledTrade } from '../paper/paperCore';
import type { DeclineRecord } from '../trade/declineLog';
import { TradeOutcome } from '../../types/enums';

export const TRAINING_CAPTURE_SCHEMA_VERSION = 1;
export const VERIFIED_TRAJECTORY_SCHEMA = 'august.verified_trajectory.v1';
export const TRAINING_CAPTURE_KEY = 'training_capture_v1';
export const TRAINING_CAPTURE_ENABLED_KEY = 'training_capture_v1_enabled';
/** Record cap — refusals surface, nothing evicts. */
export const TRAINING_CAPTURE_MAX_RECORDS = 400;
/** One record's own ceiling: the reasoning trace is the payload, but a
 *  single pathological turn must not eat the store. Truncation is FLAGGED. */
export const TRAINING_CAPTURE_MAX_RECORD_CHARS = 80_000;

export interface CapturedToolStep {
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
}

const SECRET_KEY_RE = /(?:api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key|cookie)/i;
const SECRET_VALUE_RE = /\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{10,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g;

export const redactSensitiveText = (text: string): string =>
    String(text ?? '').replace(SECRET_VALUE_RE, '[REDACTED]');

const sanitizeValue = (value: unknown, depth = 0): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        const clean = redactSensitiveText(value);
        return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 3) return '[clipped]';
    if (Array.isArray(value)) return value.slice(0, 12).map(item => sanitizeValue(item, depth + 1));
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        let count = 0;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (count >= 16) break;
            out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : sanitizeValue(v, depth + 1);
            count += 1;
        }
        return out;
    }
    return String(value).slice(0, 120);
};

export const sanitizeToolTrajectory = (
    steps: readonly CapturedToolStep[] | undefined,
): CapturedToolStep[] =>
    (steps ?? [])
        .filter(s => s && typeof s.name === 'string' && s.name.trim().length > 0)
        .slice(-24)
        .map(s => ({
            name: s.name.trim().slice(0, 64),
            args: (sanitizeValue(s.args ?? {}, 0) as Record<string, unknown>) ?? {},
            ok: s.ok === true,
        }));

export interface DecisionSnapshot {
    regimeId: string | null;
    regimeText: string | null;
    atr: number | null;
    atrTf: string | null;
    prevDayHigh: number | null;
    prevDayLow: number | null;
    sessionVwap: number | null;
    capturedAt: string;
}

export interface TrainingCaptureRecord {
    v: 1;
    at: string;
    kind: 'turn';
    surface: 'dock' | 'chat';
    symbol: string | null;
    model: { provider: string; model: string } | null;
    effort: string | null;
    /** The trader's own words for the turn (last user message). */
    userText: string;
    /** The model's public answer. */
    finalText: string;
    /** The reasoning trace, verbatim. */
    reasoning: string;
    /** The tool trail, one line per call/result pair. */
    toolEvents: string[];
    /** Structured redacted tool-call trajectory (name, sanitized args, ok). */
    toolTrajectory?: CapturedToolStep[];
    /** The structured actions (present_trade, decline_trade, emit_signal…). */
    actions: ToolAction[];
    /** The plan id, when the turn minted one — the outcome-join key. */
    planId: string | null;
    /** The detector that produced the plan, when `present_trade` carried a
     *  verified one. Kept beside planId so a row can be scored by playbook
     *  without re-reading the journal. */
    playbookId: string | null;
    /** The O-46 snapshot: what the market computed at decision time. */
    snapshot: DecisionSnapshot | null;
    truncated: boolean;
}

interface Corpus {
    schemaVersion: 1;
    records: TrainingCaptureRecord[];
    refusedOnce?: boolean;
}

export interface CaptureStatus {
    enabled: boolean;
    desktop: boolean;
    recordCount: number;
    refusedOnce: boolean;
    lastAt: string | null;
}

const isDesktop = (): boolean =>
    !!(window as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

const store = (): { read: (k: string) => Promise<{ ok: boolean; value?: unknown }>; write: (k: string, v: unknown) => Promise<{ ok: boolean }> } => {
    const api = (window as { electronAPI?: { store?: { read: (k: string) => Promise<{ ok: boolean; value?: unknown }>; write: (k: string, v: unknown) => Promise<{ ok: boolean }> } } }).electronAPI?.store;
    if (!api) throw new Error('desktop store unavailable');
    return api;
};

/** The flag lives OUTSIDE the profile deliberately: a backup restore must
 *  not silently re-enable recording on another machine. */
export const isCaptureEnabled = (): boolean => {
    try {
        return localStorage.getItem(TRAINING_CAPTURE_ENABLED_KEY) === '1';
    } catch {
        return false;
    }
};

export const setCaptureEnabled = (on: boolean): void => {
    try {
        if (on) localStorage.setItem(TRAINING_CAPTURE_ENABLED_KEY, '1');
        else localStorage.removeItem(TRAINING_CAPTURE_ENABLED_KEY);
    } catch { /* a private-mode localStorage failure keeps recording OFF — the safe direction */ }
};

const emptyCorpus = (): Corpus => ({ schemaVersion: 1, records: [] });

type CorpusRead =
    | { ok: true; corpus: Corpus }
    | { ok: false; reason: string };

const readCorpus = async (): Promise<CorpusRead> => {
    let res: { ok: boolean; value?: unknown };
    try {
        res = await store().read(TRAINING_CAPTURE_KEY);
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) return { ok: false, reason: 'the corpus store could not be read' };
    const value = res.value;
    if (!value || typeof value !== 'object') return { ok: true, corpus: emptyCorpus() };
    const c = value as Partial<Corpus>;
    if (!Array.isArray(c.records)) return { ok: true, corpus: emptyCorpus() };
    return {
        ok: true,
        corpus: { schemaVersion: 1, records: c.records as TrainingCaptureRecord[], refusedOnce: c.refusedOnce },
    };
};

/** Serialize the read-modify-write. The recorder is fire-and-forget and two
 *  turns can settle together; without this, both read the same corpus and the
 *  last write drops the other's record. The queue never rejects: a failed
 *  capture must not block the next one. */
let captureWriteQueue: Promise<unknown> = Promise.resolve();
const withCaptureLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = captureWriteQueue.then(task, task);
    captureWriteQueue = run.then(() => undefined, () => undefined);
    return run;
};

const clip = (text: string): { text: string; clipped: boolean } =>
    text.length <= TRAINING_CAPTURE_MAX_RECORD_CHARS
        ? { text, clipped: false }
        : { text: `${text.slice(0, TRAINING_CAPTURE_MAX_RECORD_CHARS)}\n[truncated for corpus size]`, clipped: true };

/** Read the corpus status for the Settings card. A read failure is surfaced,
 *  not rendered as an empty corpus — the trader must be able to tell the
 *  difference between "nothing recorded" and "the store is unreadable". */
export const captureStatus = async (): Promise<CaptureStatus> => {
    const enabled = isCaptureEnabled();
    if (!isDesktop()) return { enabled, desktop: false, recordCount: 0, refusedOnce: false, lastAt: null };
    const read = await readCorpus();
    if (!read.ok) {
        noteCaptureFailure(read.reason);
        return { enabled, desktop: true, recordCount: 0, refusedOnce: false, lastAt: null };
    }
    const c = read.corpus;
    return {
        enabled,
        desktop: true,
        recordCount: c.records.length,
        refusedOnce: c.refusedOnce === true,
        lastAt: c.records.length ? c.records[c.records.length - 1].at : null,
    };
};

/** The last append that did not land, this SESSION. It cannot live in the
 *  corpus — a dead store is exactly the failure it would have to record — so
 *  it is process memory the Settings card reads, and a dead store now reads
 *  as "0 records + a failure", not as an empty corpus. */
let lastCaptureFailure: { at: string; reason: string } | null = null;
export const lastCaptureFailureInfo = (): { at: string; reason: string } | null => lastCaptureFailure;
export const noteCaptureFailure = (reason: string): void => {
    lastCaptureFailure = { at: new Date().toISOString(), reason };
    console.warn('[trainingCapture] a turn was NOT recorded:', reason);
};

export interface TurnCaptureInput {
    surface: 'dock' | 'chat';
    symbol: string | null;
    model: { provider: string; model: string } | null;
    effort: string | null;
    userText: string;
    finalText: string;
    reasoning: string;
    toolEvents: string[];
    toolTrajectory?: CapturedToolStep[];
    actions: ToolAction[];
    planId: string | null;
    /** Optional on the input so an older caller cannot fail to compile; the
     *  record always carries the field (null when the plan named none). */
    playbookId?: string | null;
    snapshot: DecisionSnapshot | null;
}

export type CaptureResult =
    | { ok: true; recordCount: number }
    | { ok: false; reason: 'disabled' | 'desktop-only' | 'cap' | 'store-failed' };

/**
 * Append one settled turn. FIRE-AND-FORGET SAFE: callers `void` this — a
 * recording failure must never fail a trading decision, so nothing throws
 * past this function. OFF means nothing happens: no read, no buffer, no
 * trace of the turn.
 */
export const captureTurn = async (input: TurnCaptureInput): Promise<CaptureResult> => {
    if (!isCaptureEnabled()) return { ok: false, reason: 'disabled' };
    if (!isDesktop()) return { ok: false, reason: 'desktop-only' };
    return withCaptureLock(async () => {
        try {
            const read = await readCorpus();
            if (!read.ok) return { ok: false, reason: 'store-failed' };
            const corpus = read.corpus;
            if (corpus.records.length >= TRAINING_CAPTURE_MAX_RECORDS) {
                corpus.refusedOnce = true;
                const capped = await store().write(TRAINING_CAPTURE_KEY, corpus);
                return capped.ok
                    ? { ok: false, reason: 'cap' }
                    : { ok: false, reason: 'store-failed' };
            }
            const parts = [
                clip(input.userText),
                clip(input.finalText),
                clip(input.reasoning),
            ];
            const record: TrainingCaptureRecord = {
                v: 1,
                at: new Date().toISOString(),
                kind: 'turn',
                surface: input.surface,
                symbol: input.symbol,
                model: input.model,
                effort: input.effort,
                userText: parts[0].text,
                finalText: parts[1].text,
                reasoning: parts[2].text,
                toolEvents: input.toolEvents.slice(-40),
                ...(input.toolTrajectory && input.toolTrajectory.length > 0
                    ? { toolTrajectory: sanitizeToolTrajectory(input.toolTrajectory) }
                    : {}),
                actions: input.actions,
                planId: input.planId,
                playbookId: input.playbookId ?? null,
                snapshot: input.snapshot,
                truncated: parts.some(p => p.clipped),
            };
            corpus.records.push(record);
            const res = await store().write(TRAINING_CAPTURE_KEY, corpus);
            if (!res.ok) return { ok: false, reason: 'store-failed' };
            return { ok: true, recordCount: corpus.records.length };
        } catch {
            return { ok: false, reason: 'store-failed' };
        }
    });
};

/**
 * The corpus as fine-tuning JSONL: one line per turn, with the journal's
 * outcome joined by planId when the trade was logged. The turn record is the
 * INPUT half (what the model knew and said); the journal record (via
 * `reportExport.trainingRecordFor`) is the OUTCOME half — they meet on
 * planId, and an unlabeled turn is INCLUDED and flagged, the same rule the
 * journal export holds (dropping unsettled turns biases the corpus).
 */
export type CorpusExport =
    | { ok: true; jsonl: string }
    | { ok: false; reason: string };

export const exportCorpusJsonl = async (
    journalRecords: Array<{ planId?: string; json: Record<string, unknown> }>,
): Promise<CorpusExport> => {
    let corpus: Corpus;
    if (isDesktop()) {
        const read = await readCorpus();
        if (!read.ok) return { ok: false, reason: read.reason };
        corpus = read.corpus;
    } else {
        corpus = emptyCorpus();
    }
    const byPlan = new Map<string, Record<string, unknown>>();
    for (const j of journalRecords) {
        if (j.planId) byPlan.set(j.planId, j.json);
    }
    const lines: string[] = [];
    for (const r of corpus.records) {
        const outcome = r.planId ? byPlan.get(r.planId) : undefined;
        lines.push(JSON.stringify({
            schemaVersion: TRAINING_CAPTURE_SCHEMA_VERSION,
            kind: 'turn',
            at: r.at,
            surface: r.surface,
            symbol: r.symbol,
            model: r.model,
            effort: r.effort,
            input: { userText: r.userText, toolEvents: r.toolEvents },
            reasoning: r.reasoning,
            output: { finalText: r.finalText, actions: r.actions, planId: r.planId, playbookId: r.playbookId },
            decisionSnapshot: r.snapshot,
            outcome: outcome ?? null,
            labeled: !!outcome,
            truncated: r.truncated,
        }));
    }
    return { ok: true, jsonl: lines.join('\n') };
};

export interface VerifiedTrajectoryOutcome {
    kind: 'settled' | 'rejected';
    realized_r: number | null;
    reason?: string;
}

export interface VerifiedTrajectoryRecord {
    schema: typeof VERIFIED_TRAJECTORY_SCHEMA;
    id: string;
    timestamp: string;
    symbol: string | null;
    context: {
        surface: 'dock' | 'chat';
        userText: string;
        effort: string | null;
        model: { provider: string; model: string } | null;
        decisionSnapshot: DecisionSnapshot | null;
    };
    tool_trajectory: CapturedToolStep[];
    decision: {
        planId: string | null;
        playbookId: string | null;
        finalText: string;
        reasoning: string;
        actions: ToolAction[];
    };
    outcome: VerifiedTrajectoryOutcome;
}

export interface VerifiedTrajectorySources {
    journalTrades?: readonly LoggedTrade[];
    signalRows?: readonly SignalRow[];
    paperTrades?: readonly PaperSettledTrade[];
    declines?: readonly DeclineRecord[];
}

const DECLINE_MATCH_WINDOW_MS = 15 * 60_000;

const realizedRFromLoggedTrade = (t: LoggedTrade): number | null => {
    if (t.outcome !== TradeOutcome.WIN && t.outcome !== TradeOutcome.LOSS) return null;
    if (typeof t.netR === 'number' && Number.isFinite(t.netR)) return t.netR;
    if (typeof t.realizedR === 'number' && Number.isFinite(t.realizedR)) return t.realizedR;
    if (typeof t.rMultiple === 'number' && Number.isFinite(t.rMultiple)) return t.rMultiple;
    return null;
};

/**
 * Pure filter for verified fine-tuning trajectories:
 * keeps ONLY grounded turns (`toolTrajectory.length > 0 || toolEvents.length > 0`)
 * that resolve to EITHER a settled finite `realized_r` (journal / signal ledger /
 * closed paper trade) OR an explicit `decline_trade` / recorded trader rejection.
 * Redacts sensitive tokens/keys cleanly.
 */
export const filterVerifiedTrajectories = (
    turns: readonly TrainingCaptureRecord[],
    sources: VerifiedTrajectorySources,
): VerifiedTrajectoryRecord[] => {
    const journalByPlan = new Map<string, number>();
    for (const t of sources.journalTrades ?? []) {
        const r = realizedRFromLoggedTrade(t);
        if (r === null) continue;
        if (t.planId) journalByPlan.set(t.planId, r);
        if (t.paper?.positionId) journalByPlan.set(t.paper.positionId, r);
    }

    const signalById = new Map<string, number>();
    for (const s of sources.signalRows ?? []) {
        const res = s.resolution;
        if (!res || res.status === 'never_triggered' || !Number.isFinite(res.outcomeR)) continue;
        signalById.set(s.signal.id, res.outcomeR);
    }

    const paperById = new Map<string, number>();
    for (const p of sources.paperTrades ?? []) {
        if (!Number.isFinite(p.rMultiple)) continue;
        paperById.set(p.positionId, p.rMultiple);
    }

    const declines = sources.declines ?? [];
    const verified: VerifiedTrajectoryRecord[] = [];

    for (let i = 0; i < turns.length; i += 1) {
        const r = turns[i];
        const trajectory = sanitizeToolTrajectory(r.toolTrajectory);
        const isGrounded = trajectory.length > 0 || (Array.isArray(r.toolEvents) && r.toolEvents.length > 0);
        if (!isGrounded) continue;

        let outcome: VerifiedTrajectoryOutcome | null = null;

        // 1. Settled finite realized_r join (planId -> journal / signal / paper)
        if (r.planId) {
            const settledR =
                journalByPlan.get(r.planId)
                ?? signalById.get(r.planId)
                ?? paperById.get(r.planId);
            if (typeof settledR === 'number' && Number.isFinite(settledR)) {
                outcome = { kind: 'settled', realized_r: Math.round(settledR * 1000) / 1000 };
            }
        }

        // 2. Explicit decline_trade tool step or recorded trader decline
        if (!outcome) {
            const declineStep = trajectory.find(s => s.name === 'decline_trade' && s.ok);
            const hasDeclineEvent = (r.toolEvents ?? []).some(e => /\bdecline_trade\b/i.test(e));
            const turnMs = Date.parse(r.at);
            const matchedDecline = declines.find(d => {
                if (r.planId && d.reason.includes(r.planId)) return true;
                if (r.symbol && d.symbol.toUpperCase() === r.symbol.toUpperCase() && Number.isFinite(turnMs)) {
                    const decMs = Date.parse(d.createdAt);
                    return Number.isFinite(decMs) && Math.abs(decMs - turnMs) <= DECLINE_MATCH_WINDOW_MS;
                }
                return false;
            });
            if (declineStep || hasDeclineEvent || matchedDecline) {
                const rawReason =
                    (typeof declineStep?.args?.reason === 'string' ? declineStep.args.reason : '')
                    || matchedDecline?.reason
                    || 'Declined setup';
                outcome = {
                    kind: 'rejected',
                    realized_r: null,
                    reason: redactSensitiveText(rawReason).slice(0, 300),
                };
            }
        }

        if (!outcome) continue;

        verified.push({
            schema: VERIFIED_TRAJECTORY_SCHEMA,
            id: r.planId || `traj-${i + 1}-${r.at}`,
            timestamp: r.at,
            symbol: r.symbol,
            context: {
                surface: r.surface,
                userText: redactSensitiveText(r.userText),
                effort: r.effort,
                model: r.model,
                decisionSnapshot: r.snapshot,
            },
            tool_trajectory: trajectory,
            decision: {
                planId: r.planId,
                playbookId: r.playbookId,
                finalText: redactSensitiveText(r.finalText),
                reasoning: redactSensitiveText(r.reasoning),
                actions: r.actions,
            },
            outcome,
        });
    }

    return verified;
};

export type VerifiedTrajectoryExportResult =
    | { ok: true; jsonl: string; verifiedCount: number; totalCount: number }
    | { ok: false; reason: string };

/** Export ONLY verified (grounded + settled or rejected) trajectories as JSONL. */
export const exportVerifiedTrajectoriesJsonl = async (
    sources: VerifiedTrajectorySources,
    overrideTurns?: readonly TrainingCaptureRecord[],
): Promise<VerifiedTrajectoryExportResult> => {
    let records: readonly TrainingCaptureRecord[];
    if (overrideTurns) {
        records = overrideTurns;
    } else if (isDesktop()) {
        const read = await readCorpus();
        if (!read.ok) return { ok: false, reason: read.reason };
        records = read.corpus.records;
    } else {
        records = [];
    }
    const verified = filterVerifiedTrajectories(records, sources);
    return {
        ok: true,
        jsonl: verified.map(v => JSON.stringify(v)).join('\n'),
        verifiedCount: verified.length,
        totalCount: records.length,
    };
};
