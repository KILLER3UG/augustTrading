/**
 * ChatWorkTimeline — one AI entry's ZCode-style work timeline: the reasoning
 * stream interleaved with the desk-tool rounds that interrupted it, folded
 * into a single "Analyzed for Ns" row, plus the model's side-effect status
 * rows. Extracted from TradeChatPanel unchanged (it was an inline IIFE).
 *
 * The `[Desk tools] …` mirrors inside the reasoning text are the cut points,
 * so consecutive tool events group into ONE ToolActivityRow whose rows pair
 * call→result (a `calling…` line updates to `ok` in place, never a second
 * line). Reads only the entry it is given — no dock state.
 */

import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { Lightbulb } from '../../shared/Icons';
import { getHarnessSettings, subscribeHarnessSettings } from '../../../utils/harnessSettings';
import type { ToolAction } from '../../../types/message';
import type { WireAuditEntry } from '../../../types/provider';
import { tipForSeed } from '../../../utils/tradingTips';
import { splitReasoningAroundTools } from '../../../utils/traceText';
import { pairToolRows, turnActivityLabel, turnKindSummary, turnWorkSummary, isHarnessNoticeLine } from '../../../utils/turnStatus';
import AnalyzedRow from '../../shared/AnalyzedRow';
import ReasoningRow from '../../shared/ReasoningRow';
import ToolActivityRow from '../../shared/ToolActivityRow';
import ToolActionsRow from '../../chat/ToolActionsRow';
import WireAuditRow from '../../shared/WireAuditRow';
import { getPayloadWriteFailure, readToolPayload } from '../../../services/trade/toolPayloadStore';
import { undoMemorySnapshot, type CuratedMemoryTarget } from '../../../services/learning/curatedMemory';
import { applyDreamUndo, type DreamUndoPayload } from '../../../services/learning/memoryDream';
import { undoSkillManageMutation, type SkillManageUndoSnapshot } from '../../../services/learning/skillManage';
import { recordRejectedFingerprint } from '../../../services/learning/rejectedFingerprints';
import { getActiveUsername } from '../../../utils/activeUser';
import type { PaperReceipt } from '../../../services/paper/paperCore';

/**
 * Append-only cache for the tool-mirror split. Reasoning streams by APPENDING
 * tokens to one string, so every segment before the final one is frozen; only
 * the tail (the last segment plus newly arrived text) can change. Re-splitting
 * the whole string on every token was O(n²) over a turn. The length stamp is
 * O(1), and a same-stamp render is a free cache hit. Identity is the entry id,
 * so a surface hop that remounts the row reuses the frozen prefix.
 */
interface ReasoningSplitCache {
    stamp: number;
    reasoning: string;
    segs: string[];
}
const reasoningSplits = new Map<string, ReasoningSplitCache>();
const REASONING_SPLIT_CACHE_CAP = 64;

const splitReasoningIncremental = (id: string, reasoning: string): string[] => {
    const cached = reasoningSplits.get(id);
    if (cached && cached.stamp === reasoning.length && cached.reasoning === reasoning) return cached.segs;
    let prefix: string[] = [];
    let tail = reasoning;
    if (cached && reasoning.length >= cached.stamp && reasoning.startsWith(cached.reasoning)) {
        prefix = cached.segs.slice(0, -1);
        tail = (cached.segs[cached.segs.length - 1] ?? '') + reasoning.slice(cached.stamp);
    }
    const segs = [...prefix, ...splitReasoningAroundTools(tail)];
    if (reasoningSplits.size >= REASONING_SPLIT_CACHE_CAP) {
        const oldest = reasoningSplits.keys().next().value;
        if (oldest !== undefined) reasoningSplits.delete(oldest);
    }
    reasoningSplits.set(id, { stamp: reasoning.length, reasoning, segs });
    return segs;
};

/** What this turn's work actually was, named from the transcript it already
 *  produced — no model call, no new store.
 *
 *  The grammar, the pairing and the naming all live in `utils/turnStatus.ts`,
 *  because the transcript row and this summary are two readers of ONE
 *  grammar: what the trader reads collapsed is exactly what they get when
 *  they open it. This export stays so the existing callers keep working. */
export const workSummaryLabel = (tools: string[]): string | null =>
    turnWorkSummary(tools);

/** What the turn's work was, counted by KIND — "4 reads, 1 search". The
 *  settled row's headline, and the one thing a trader reading only the
 *  collapsed row can learn about it. */
export const workKindSummary = (tools: string[]): string | null => turnKindSummary(tools);

/** The shape this actually reads. The dock passes its `LiveEntry` straight
 *  in; the Agents surface adapts a pipeline `Message` onto the same fields.
 *  Widening the prop to the fields rather than to a store type is what lets
 *  two surfaces render one timeline without either owning the other's model. */
export interface ChatWorkView {
    id: string;
    reasoning?: string;
    tools: string[];
    streaming?: boolean;
    /** The answer text so far — "running" means work with nothing to show yet. */
    text?: string;
    actions?: ToolAction[];
    /** Frozen work time in ms, persisted at settle — survives a reload. */
    workedMs?: number;
    /** Epoch-ms the turn STARTED. The live clocks read this instead of their
     *  own mount time, so crossing between the Agents surface and the dock
     *  continues the same count rather than restarting at zero. */
    startedAt?: number;
    /** The stored entry's own stamp — the dock's native entries carry `at`. */
    at?: number;
    /** One payload id per entry in `tools`, same order. */
    toolIds?: string[];
    /** The live-only "still working" line for a slow call. It is never part of
     *  `tools`: a progress line in the result grammar parses as a completed
     *  row. Hidden the moment the run settles. */
    liveProgress?: string;
    /** What the wire was actually asked, one entry per call. It is what lets
     *  the card say WHY a turn has no trace. */
    wireAudit?: WireAuditEntry[];
    /** The Execution Trace row (chatTurnRunner records it at settle):
     *  measured prompt-hash stability, tokens, refusals. */
    trace?: import('../../../services/trade/chatStore').TurnTrace;
}

// ─── Flat write-receipt rows ────────────────────────────────────────────────
// `memory` and `skill_manage` write receipts are reversible. The undo bytes
// live in the tool's persisted payload (keyed by the tool-call id), NOT on the
// ToolAction summary — that summary deliberately keeps only a label. Reading
// the payload by id is the one safe join; when a payload was clipped or never
// kept we have no undoSnapshot, so the row renders View ONLY. A fabricated
// Undo that restores nothing is worse than a missing affordance.

type WriteKind = 'memory' | 'skill_manage' | 'paper' | 'memory_dream';

interface MemoryReceipt {
    ok?: boolean;
    target?: string;
    applied?: number;
    undoSnapshot?: string;
    /** The NEW rule, in the same shape the background reviewer fingerprints. */
    rejectedContent?: string;
    error?: string;
}

interface SkillReceipt {
    ok?: boolean;
    action?: string;
    slug?: string;
    undoSkill?: SkillManageUndoSnapshot;
    priorBody?: string;
    rejectedContent?: string;
    error?: string;
}

interface DreamReceipt {
    ok?: boolean;
    summary?: string;
    undoDream?: DreamUndoPayload;
    error?: string;
}

interface WriteRow {
    key: string;
    kind: WriteKind;
    label: string;
    receipt: MemoryReceipt | SkillReceipt | PaperReceipt | DreamReceipt | null;
    clipped: boolean;
    missing: boolean;
}

const canUndo = (row: WriteRow): boolean => {
    // Executed paper trades are final — there is no undo snapshot, and a
    // simulated fill may never be rolled back through this row.
    if (row.kind === 'paper') return false;
    if (row.kind === 'memory') return typeof (row.receipt as MemoryReceipt | null)?.undoSnapshot === 'string';
    if (row.kind === 'memory_dream') return !!(row.receipt as DreamReceipt | null)?.undoDream;
    return !!(row.receipt as SkillReceipt | null)?.undoSkill;
};

const WriteReceiptRows: React.FC<{ toolIds: string[] }> = ({ toolIds }) => {
    const [undone, setUndone] = useState<ReadonlySet<string>>(() => new Set());
    const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
    const [note, setNote] = useState<string | null>(null);

    const rows = useMemo<WriteRow[]>(() => {
        const out: WriteRow[] = [];
        for (const id of toolIds) {
            if (!id) continue;
            const payload = readToolPayload(id);
            if (!payload) continue;
            const isPaper = payload.name === 'paper_order' || payload.name === 'paper_account';
            const isDream = payload.name === 'memory_dream';
            if (!isPaper && !isDream && payload.name !== 'memory' && payload.name !== 'skill_manage') continue;
            const kind: WriteKind = isPaper ? 'paper' : isDream ? 'memory_dream' : payload.name as 'memory' | 'skill_manage';
            let receipt: MemoryReceipt | SkillReceipt | PaperReceipt | DreamReceipt | null = null;
            if (payload.text) {
                try {
                    const parsed: unknown = JSON.parse(payload.text);
                    if (parsed && typeof parsed === 'object') {
                        receipt = parsed as MemoryReceipt | SkillReceipt | PaperReceipt | DreamReceipt;
                    }
                } catch { /* a non-JSON result is still a View-able receipt */ }
            }
            const clipped = !payload.text && (!!payload.artifact || typeof payload.kept === 'number');
            const label = kind === 'paper'
                ? (payload.name === 'paper_account' ? 'Paper account' : 'Paper order')
                : kind === 'memory_dream'
                    ? 'Dream consolidation'
                    : kind === 'memory'
                        ? ((receipt as MemoryReceipt | null)?.target === 'user' ? 'USER.md' : 'MEMORY.md')
                        : String((receipt as SkillReceipt | null)?.slug ?? 'skill');
            out.push({
                key: id,
                kind,
                label,
                receipt,
                clipped,
                missing: !payload.text && !clipped,
            });
        }
        return out;
    }, [toolIds]);

    if (rows.length === 0) return null;

    const undo = (row: WriteRow): void => {
        const username = getActiveUsername();
        void (async () => {
            try {
                if (row.kind === 'memory') {
                    const r = row.receipt as MemoryReceipt;
                    const target: CuratedMemoryTarget = r.target === 'user' ? 'user' : 'memory';
                    const snapshot = r.undoSnapshot ?? '';
                    const result = await undoMemorySnapshot(target, snapshot, username);
                    if (!result.ok) { setNote('Memory undo was refused — nothing was restored.'); return; }
                    await recordRejectedFingerprint(
                        // The REFUSED rule (new payload), not the restored
                        // bytes — the background writer fingerprints the
                        // proposed content, so this must match that shape.
                        { kind: 'memory', target, content: r.rejectedContent ?? '' },
                        'user_undo', `memory · ${target}`, username,
                    );
                } else if (row.kind === 'memory_dream') {
                    const r = row.receipt as DreamReceipt;
                    const payload = r.undoDream as DreamUndoPayload;
                    const ok = await applyDreamUndo(payload, username);
                    if (!ok) { setNote('Dream undo was refused — nothing was restored.'); return; }
                } else {
                    const r = row.receipt as SkillReceipt;
                    const snapshot = r.undoSkill as SkillManageUndoSnapshot;
                    const result = await undoSkillManageMutation(snapshot, username);
                    if (!result.ok) { setNote(result.error ?? 'Skill undo was refused — nothing was restored.'); return; }
                    await recordRejectedFingerprint(
                        {
                            kind: 'skill_manage',
                            target: r.slug ?? snapshot.slug ?? '',
                            content: r.rejectedContent ?? '',
                        },
                        'user_undo', `skill · ${r.slug ?? snapshot.slug ?? ''}`, username,
                    );
                }
                setUndone(prev => new Set(prev).add(row.key));
                setNote(row.kind === 'memory' ? 'Memory write undone.' : row.kind === 'memory_dream' ? 'Consolidation undone.' : 'Skill change undone.');
                window.dispatchEvent(new Event('august-memory-refresh'));
            } catch (e) {
                setNote(e instanceof Error ? e.message : String(e));
            }
        })();
    };

    return (
        <div className="space-y-1" data-testid="write-receipt-rows">
            {rows.map(row => {
                // Paper receipts are executed simulations: one flat row per
                // PaperEvent.line (already a monochrome, single-line receipt),
                // plus a View detail. There is deliberately NO Undo affordance.
                if (row.kind === 'paper') {
                    const receipt = row.receipt as PaperReceipt | null;
                    const eventLines = (receipt?.events ?? [])
                        .map(event => event?.line)
                        .filter((line): line is string => typeof line === 'string' && line.length > 0);
                    const shown = eventLines.length > 0
                        ? eventLines
                        : [receipt?.error ?? receipt?.reason ?? receipt?.message ?? 'Paper receipt'];
                    const viewOpen = viewed.has(row.key);
                    const why = row.clipped
                        ? 'Result was clipped — view the stored excerpt.'
                        : row.missing
                            ? 'No stored receipt payload — view what the transcript kept.'
                            : 'Open the full paper receipt.';
                    return (
                        <div key={row.key}>
                            {shown.map((line, i) => (
                                <div
                                    key={`${row.key}-${i}`}
                                    data-testid="write-receipt-row"
                                    data-kind="paper"
                                    className="flex items-center gap-2 rounded-control bg-white/[0.02] px-2 py-1 text-ui-dense leading-5 text-zinc-500"
                                >
                                    <span className="shrink-0 text-zinc-400">Paper</span>
                                    <span className="min-w-0 flex-1 truncate" title={line}>{line}</span>
                                </div>
                            ))}
                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    aria-label="View paper receipt"
                                    aria-expanded={viewOpen}
                                    title={why}
                                    data-testid="write-receipt-view-paper"
                                    onClick={() => setViewed(prev => {
                                        const next = new Set(prev);
                                        if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                                        return next;
                                    })}
                                    className="shrink-0 rounded-control px-1.5 py-px text-ui-2xs uppercase tracking-wider text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                                >
                                    View
                                </button>
                            </div>
                            {viewOpen && (
                                <pre
                                    data-testid="write-receipt-detail-paper"
                                    className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-zinc-900/60 px-2 py-1 font-mono text-ui-2xs leading-4 text-zinc-500"
                                >
                                    {JSON.stringify(receipt ?? { note: why }, null, 2)}
                                </pre>
                            )}
                        </div>
                    );
                }
                const undoneRow = undone.has(row.key);
                const viewOpen = viewed.has(row.key);
                const undoable = canUndo(row) && !undoneRow;
                // Why View-only: the receipt's bytes were clipped to an
                // artifact (or never kept). There is no undoSnapshot to pass
                // to the reversible writer, so the row says so on hover.
                const why = row.clipped
                    ? 'Result was clipped — no undo snapshot was kept. View the stored excerpt.'
                    : row.missing
                        ? 'No stored receipt payload — undo is unavailable. View what the transcript kept.'
                        : 'Open the full receipt bytes.';
                return (
                    <div key={row.key}>
                        <div
                            data-testid="write-receipt-row"
                            data-kind={row.kind}
                            className="flex items-center gap-2 rounded-control bg-white/[0.02] px-2 py-1 text-ui-dense leading-5 text-zinc-500"
                        >
                            <span className="shrink-0 text-zinc-400">
                                {row.kind === 'memory' ? 'Memory' : row.kind === 'memory_dream' ? 'Dream' : 'Skill'}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={row.label}>{row.label}</span>
                            {undoable ? (
                                <button
                                    type="button"
                                    aria-label={`Undo ${row.kind} write to ${row.label}`}
                                    title="Undo this write and refuse the same suggestion later"
                                    data-testid={`write-receipt-undo-${row.kind}`}
                                    onClick={() => undo(row)}
                                    className="shrink-0 rounded-control px-1.5 py-px text-ui-2xs font-bold uppercase tracking-wider text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
                                >
                                    Undo
                                </button>
                            ) : undoneRow ? (
                                <span className="shrink-0 text-ui-2xs uppercase tracking-wider text-zinc-600">Undone</span>
                            ) : (
                                <span className="shrink-0 text-ui-2xs text-zinc-600" title={why}>View only</span>
                            )}
                            <button
                                type="button"
                                aria-label={`View ${row.kind} receipt for ${row.label}`}
                                aria-expanded={viewOpen}
                                title={why}
                                data-testid={`write-receipt-view-${row.kind}`}
                                onClick={() => setViewed(prev => {
                                    const next = new Set(prev);
                                    if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
                                    return next;
                                })}
                                className="shrink-0 rounded-control px-1.5 py-px text-ui-2xs uppercase tracking-wider text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                            >
                                View
                            </button>
                        </div>
                        {viewOpen && (
                            <pre
                                data-testid={`write-receipt-detail-${row.kind}`}
                                className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-zinc-900/60 px-2 py-1 font-mono text-ui-2xs leading-4 text-zinc-500"
                            >
                                {JSON.stringify(row.receipt ?? { note: why }, null, 2)}
                            </pre>
                        )}
                    </div>
                );
            })}
            {note && (
                <p data-testid="write-receipt-note" role="status" className="text-ui-2xs leading-4 text-zinc-500">{note}</p>
            )}
        </div>
    );
};

export interface ChatWorkTimelineProps {
    entry: ChatWorkView;
}

const ChatWorkTimeline: React.FC<ChatWorkTimelineProps> = ({ entry }) => {
    const { autoFoldTools } = useSyncExternalStore(subscribeHarnessSettings, getHarnessSettings, getHarnessSettings);
    const reasoning = entry.reasoning ?? '';
    const turnStreaming = !!entry.streaming;
    const hasAnswerText = Boolean(entry.text && entry.text.trim().length > 0);
    const pairedCalls = useMemo(
        () => pairToolRows(entry.tools.filter(line => !isHarnessNoticeLine(line))),
        [entry.tools],
    );
    const hasCallingTool = turnStreaming && pairedCalls.some(r => r.state === 'calling');
    const running = turnStreaming && (!hasAnswerText || hasCallingTool);
    // One start stamp for every clock in this turn. Both homes mount a fresh
    // row when the trader hops surfaces; without the stamp each mount read
    // "0s" and the turn appeared to restart.
    const startedAt = entry.startedAt ?? entry.at;
    const hasWork = reasoning.trim().length > 0 || entry.tools.length > 0;
    const hasActions = !!(entry.actions && entry.actions.length > 0);
    // The wire's own record of what it was asked. It rides on the row because
    // the answer has to be able to say WHY it has no trace — "the model didn't
    // think" and "the model was never asked to think" were the same silence.
    const wireAudit = entry.wireAudit ?? [];
    const hasWire = wireAudit.length > 0;
    // Only a SETTLED turn may be said to have no trace: while the answer is
    // still streaming, the trace may be on its way.
    const settled = !entry.streaming;
    const noTrace = settled && reasoning.trim().length === 0;
    // The route the wire applied on its LAST call — the answer's own call.
    const lastRoute = hasWire ? wireAudit[wireAudit.length - 1] : null;
    // The wire row belongs INSIDE the card when the turn did work: the card
    // folds itself shut the moment the answer lands, so the record stays out
    // of the way until the trader opens the work.
    //
    // It earns its own line ONLY in the one case silence misleads: the turn
    // settled with no trace at all AND the wire applied no thinking route.
    // Then the trader is silently getting no thinking, and the transport's own
    // reason is the only thing that can tell them so.
    const wireAlone = hasWire && !hasWork && noTrace && lastRoute?.applied === false;
    // What the turn is doing RIGHT NOW — the status line's word, derived from
    // the turn's own tool lines. It changes as the work changes, and it can
    // only ever report what the tools did. Declared before the early return
    // below, because a hook after one is a hook called conditionally.
    // Keyed on the TOOLS (count + identity) and the streaming flag, not on the
    // raw reasoning: reasoning grows a token at a time and re-keying on it
    // recomputed this label and trimmed the whole string on every token. The
    // boolean is O(1) and only flips once when thinking first appears.
    const hasReasoning = reasoning.length > 0;
    const activity = useMemo(
        () => turnActivityLabel(entry.tools, hasReasoning),
        [entry.tools, entry.tools.length, turnStreaming, hasReasoning, reasoning.length],
    );
    // The settled header's tool count — "4 tools" beside "Thought for 14s".
    // The count is CALLS, not transcript lines: `pairToolRows` is the same
    // pairing the rows below render, so the header and the card can never
    // disagree about how many commands the turn ran.
    const callCount = pairedCalls.length;
    const ranSummary = callCount > 0
        ? `${callCount} tool${callCount === 1 ? '' : 's'}`
        : null;
    if (!hasWork && !hasActions && !wireAlone) {
        // Nothing yet: the waiting tip covers
        // the silent first moments of a turn. It is the tip's ONLY home now —
        // once there is work, the status line names the activity instead.
        return running ? (
            <p className="flex items-start gap-1.5 text-ui-dense leading-5 text-zinc-500" data-testid="thinking-placeholder">
                <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" aria-hidden="true" />
                <span className="min-w-0 break-words">Tip: {tipForSeed(entry.id)}</span>
            </p>
        ) : null;
    }
    // A reasoning-only turn IS the reference's thinking block: one quiet line
    // over the trace, not a work card wrapped around a single thought. Keep
    // live Thinking open for the whole stream so it never disappears once answer
    // tokens start arriving, and render any harness notices strictly below it.
    if (reasoning.trim().length > 0 && callCount === 0 && !hasActions && !wireAlone) {
        const noticeLines = entry.tools.filter(line => isHarnessNoticeLine(line));
        return (
            <div className="my-1 space-y-1.5">
                <ReasoningRow thinking={reasoning} running={turnStreaming} persistedMs={entry.workedMs} startedAt={startedAt} settledLabel="thoughtFor" />
                {noticeLines.length > 0 && (
                    <ToolActivityRow lines={noticeLines} running={turnStreaming} payloadIds={noticeLines.map(() => '')} />
                )}
            </div>
        );
    }
    const segs = splitReasoningIncremental(entry.id, reasoning);
    const markerCount = segs.length - 1;
    const nodes: React.ReactNode[] = [];
    let buf: string[] = [];
    let toolCursor = 0;
    let bufStart = 0;
    // Payload ids in the SAME order the lines are pushed below, so `flush` can
    // hand each `ToolActivityRow` the ids for exactly the lines it is given.
    const idBuf: string[] = [...(entry.toolIds ?? [])];
    const pushTool = (line: string): void => {
        if (buf.length === 0) bufStart = toolCursor;
        buf.push(line);
        toolCursor += 1;
    };
    const flush = (): void => {
        if (buf.length > 0) {
            // The ids ride WITH their lines: pairing inside `pairToolLines` is
            // FIFO by label, so a payload is attached by position in the buffer
            // it was rendered from, never by a lookup that could drift.
            const ids = buf.map(() => idBuf.shift() ?? '');
            // Key by the first source line, not by the reasoning segment that
            // eventually closes this buffer. A later thought must not remount
            // a tool output the trader already expanded.
            nodes.push(<ToolActivityRow key={`tools-${bufStart}`} lines={buf} running={turnStreaming} payloadIds={ids} />);
            buf = [];
        }
    };
    for (let s = 0; s < segs.length; s++) {
        if (s > 0 && s - 1 < entry.tools.length) pushTool(entry.tools[s - 1]);
        if (segs[s]?.trim()) {
            flush();
            nodes.push(
                <ReasoningRow
                    key={`thought-${s}`}
                    thinking={segs[s]}
                    defaultOpen
                    running={turnStreaming && s === segs.length - 1 && !hasCallingTool && !hasAnswerText}
                    persistedMs={s === 0 ? entry.workedMs : undefined}
                    startedAt={startedAt}
                />
            );
        }
    }
    // Mirrors can lag the tools array (tool lines pushed
    // outside the desk loop) — leftovers render at the end.
    for (const line of entry.tools.slice(markerCount)) pushTool(line);
    flush();

    // 2.11 — the sticky payload write failure needs a READER, or the record the
    // store keeps is invisible. A row that opens onto "full result not kept"
    // cannot tell a CLIP (a pause, the bytes exist under a ta-… id) from a store
    // that REFUSED the write (the bytes are gone). This line says which, only
    // where tool rows exist — payloads are written by tool calls alone — and it
    // names the ceiling, not a stack trace.
    const writeFailure = entry.tools.length > 0 ? getPayloadWriteFailure() : null;
    const writeFailureNote = writeFailure
        ? writeFailure.kind === 'quota'
            ? 'Some tool output was not kept — browser storage refused the write.'
            : writeFailure.kind === 'budget'
                ? 'Some tool output was not kept — the payload store is at its ceiling.'
                : 'Some tool output was not kept — a tool result could not be saved.'
        : null;
    return (
        /* The reference's work: a BARE LINE (the activity) with the card
           BELOW it. The card is the analyzed row's open body — the border and
           the fill live there now, not around the line — so a collapsed turn
           shows one quiet sentence instead of a little box. The side-effect
           rows keep their own card: in the reference a "Presented 2 files"
           card is a separate card BELOW the work, not part of it. */
        <div className="my-1.5 space-y-1.5">
            {hasWork && (
                <AnalyzedRow
                    running={running}
                    summary={ranSummary}
                    persistedMs={entry.workedMs}
                    startedAt={startedAt}
                    activity={activity}
                    autoFold={autoFoldTools}
                    toolCount={callCount}
                    foldSummaryTestId={!running && autoFoldTools && callCount >= 2 ? 'tool-summary-fold' : undefined}
                >
                    {nodes}
                    {entry.liveProgress && entry.streaming && (
                        <p className="text-ui-dense leading-5 text-zinc-500" data-testid="slow-call-progress">
                            {entry.liveProgress}
                        </p>
                    )}
                    {writeFailureNote && (
                        <p className="text-ui-dense leading-5 text-zinc-500" data-testid="payload-write-failure">
                            {writeFailureNote}
                        </p>
                    )}
                    {hasWire && (
                        <WireAuditRow entries={wireAudit} noTrace={noTrace} />
                    )}
                    {settled && entry.trace && (
                        <details data-testid="turn-trace" className="mt-0.5 py-0.5">
                            <summary className="cursor-pointer select-none font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                Trace · {entry.trace.cacheWarm === null
                                    ? 'first turn'
                                    : entry.trace.cacheWarm
                                        ? 'cache warm'
                                        : 'prefix changed'}
                                {' · '}{entry.trace.tokensIn}/{entry.trace.tokensOut} tok
                                {entry.trace.gateRefusals > 0 ? ` · ${entry.trace.gateRefusals} refused` : ''}
                            </summary>
                            <div className="mt-1 space-y-0.5 font-mono text-ui-2xs text-zinc-500">
                                <p>SYSTEM prefix hash: <span className="text-zinc-300">{entry.trace.prefixHash}</span>
                                    {' · '}
                                    <span className={entry.trace.cacheWarm === false ? 'text-zinc-200' : ''}>
                                        {entry.trace.cacheWarm === null
                                            ? 'FIRST TURN'
                                            : entry.trace.cacheWarm
                                                ? 'CACHE WARM'
                                                : 'PREFIX CHANGED'}
                                    </span>
                                </p>
                                {entry.trace.tier0Revision && (
                                    <p>Tier 0 CONTEXT revision: <span className="text-zinc-300">{entry.trace.tier0Revision}</span></p>
                                )}
                                <p>turn {entry.trace.totalMs}ms · in {entry.trace.tokensIn} tok / out {entry.trace.tokensOut} tok
                                    {entry.trace.gateRefusals > 0 ? ` · ${entry.trace.gateRefusals} gate refusal${entry.trace.gateRefusals === 1 ? '' : 's'}` : ''}
                                    {entry.trace.microCompactChars ? ` · microcompaction −${entry.trace.microCompactChars.toLocaleString()} chars` : ''}
                                </p>
                            </div>
                        </details>
                    )}
                </AnalyzedRow>
            )}
            {wireAlone && (
                <div className="rounded-card bg-zinc-900/40 px-3 py-2.5">
                    <WireAuditRow entries={wireAudit} noTrace={noTrace} />
                </div>
            )}
            {hasActions && (
                <div className="rounded-card bg-zinc-900/40 px-3 py-2.5">
                    <ToolActionsRow actions={entry.actions!} />
                </div>
            )}
            {/* Additive: reversible memory/skill writes get their own flat
                rows. The existing status rows above are untouched. */}
            <WriteReceiptRows toolIds={entry.toolIds ?? []} />
        </div>
    );
};

export default ChatWorkTimeline;
