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

import React, { useMemo } from 'react';
import { Lightbulb } from '../../shared/Icons';
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
import { getPayloadWriteFailure } from '../../../services/trade/toolPayloadStore';

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
    /** One payload id per entry in `tools`, same order. */
    toolIds?: string[];
    /** The live-only "still working" line for a slow call. It is never part of
     *  `tools`: a progress line in the result grammar parses as a completed
     *  row. Hidden the moment the run settles. */
    liveProgress?: string;
    /** What the wire was actually asked, one entry per call. It is what lets
     *  the card say WHY a turn has no trace. */
    wireAudit?: WireAuditEntry[];
}

export interface ChatWorkTimelineProps {
    entry: ChatWorkView;
}

const ChatWorkTimeline: React.FC<ChatWorkTimelineProps> = ({ entry }) => {
    const reasoning = entry.reasoning ?? '';
    const running = !!entry.streaming && !entry.text;
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
    const activity = useMemo(
        () => turnActivityLabel(entry.tools, reasoning.trim().length > 0),
        [entry.tools, reasoning],
    );
    // The reference's settled headline: "Ran 4 commands, read a file". The
    // count is CALLS, not transcript lines — `pairToolRows` is the same pairing
    // the rows below render, so the headline and the card can never disagree
    // about how many commands the turn ran. A reasoning-only turn has no
    // command to count and keeps the "Analyzed" form.
    const callCount = useMemo(
        () => pairToolRows(entry.tools.filter(line => !isHarnessNoticeLine(line))).length,
        [entry.tools],
    );
    const ranSummary = callCount > 0
        ? `Ran ${callCount} ${callCount === 1 ? 'command' : 'commands'}`
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
    // over the trace, not a work card wrapped around a single thought.
    if (reasoning.trim().length > 0 && entry.tools.length === 0 && !hasActions && !wireAlone) {
        return (
            <div className="my-1">
                <ReasoningRow thinking={reasoning} running={running} persistedMs={entry.workedMs} />
            </div>
        );
    }
    const segs = splitReasoningAroundTools(reasoning);
    const markerCount = segs.length - 1;
    const nodes: React.ReactNode[] = [];
    let buf: string[] = [];
    // Payload ids in the SAME order the lines are pushed below, so `flush` can
    // hand each `ToolActivityRow` the ids for exactly the lines it is given.
    const idBuf: string[] = [...(entry.toolIds ?? [])];
    const flush = (key: string): void => {
        if (buf.length > 0) {
            // The ids ride WITH their lines: pairing inside `pairToolLines` is
            // FIFO by label, so a payload is attached by position in the buffer
            // it was rendered from, never by a lookup that could drift.
            const ids = buf.map(() => idBuf.shift() ?? '');
            nodes.push(<ToolActivityRow key={key} lines={buf} running={running} payloadIds={ids} />);
            buf = [];
        }
    };
    for (let s = 0; s < segs.length; s++) {
        if (s > 0 && s - 1 < entry.tools.length) buf.push(entry.tools[s - 1]);
        if (segs[s]?.trim()) {
            flush(`tools-${s}`);
            nodes.push(
                <ReasoningRow
                    key={`thought-${s}`}
                    thinking={segs[s]}
                    running={running && s === segs.length - 1}
                />
            );
        }
    }
    // Mirrors can lag the tools array (tool lines pushed
    // outside the desk loop) — leftovers render at the end.
    buf.push(...entry.tools.slice(markerCount));
    flush('tools-tail');

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
                    title={workSummaryLabel(entry.tools) ?? undefined}
                    activity={activity}
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
        </div>
    );
};

export default ChatWorkTimeline;
