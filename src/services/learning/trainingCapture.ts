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

export const TRAINING_CAPTURE_SCHEMA_VERSION = 1;
export const TRAINING_CAPTURE_KEY = 'training_capture_v1';
export const TRAINING_CAPTURE_ENABLED_KEY = 'training_capture_v1_enabled';
/** Record cap — refusals surface, nothing evicts. */
export const TRAINING_CAPTURE_MAX_RECORDS = 400;
/** One record's own ceiling: the reasoning trace is the payload, but a
 *  single pathological turn must not eat the store. Truncation is FLAGGED. */
export const TRAINING_CAPTURE_MAX_RECORD_CHARS = 80_000;

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
