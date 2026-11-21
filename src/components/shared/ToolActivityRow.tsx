import React, { useMemo, useState } from 'react';
import { stripTraceMarkers } from '../../utils/traceText';
import { pairToolRows, type ToolRowState } from '../../utils/turnStatus';
import { toolKindLabel, toolKindOf } from '../../utils/toolKinds';
import { KIND_GLYPH } from './toolKindIcons';
import { Check, ChevronRight, Copy } from './Icons';
import Disclosure from './Disclosure';
import { readToolPayload } from '../../services/trade/toolPayloadStore';
import { readToolArtifact } from '../../services/analysis/toolArtifactStore';
import { copyText } from '../../utils/clipboard';
import { formatToolPayload } from '../../utils/toolPayloadFormat';

export interface ToolActivityRowProps {
    /** Human-readable tool-event lines ("calling order book…", "order book · buy wall …"). */
    lines: string[];
    /** The answer this row belongs to is still streaming. */
    running?: boolean;
    className?: string;
    /** One payload id per entry in `lines`, same order. A row whose id resolves
     *  becomes a `<details>` that opens onto the REAL output the tool returned —
     *  always available, never gated behind a density toggle. '' / missing means
     *  the line has no payload and stays a plain row. */
    payloadIds?: string[];
}

/** Re-exported from the one grammar owner (`utils/turnStatus.ts`) so the rows
 *  and the turn's status line read the same line the same way. */
export type { ToolRowState };

export interface PairedToolRow {
    label: string;
    detail: string;
    state: ToolRowState;
}

/** The glyph each kind of step carries.
 *
 *  A step used to wear one wrench for everything, so a READ and a WRITE looked
 *  identical on screen — and a trader reading the transcript could not tell
 *  what the desk had DONE, only that it had done something. The kind is a
 *  property of the tool (`utils/toolKinds.ts`), and the glyph is how it shows
 *  here: one look tells you whether the desk was looking something up,
 *  working something out, or changing something.
 *
 *  The map itself lives in `components/shared/toolKindIcons.tsx`, so the
 *  Settings catalogue and this row draw the SAME mark for the same kind. */
export { KIND_GLYPH };

/** A row AFTER the consecutive-fold: one or more same-label calls rendered as a
 *  single line. `count` is 1 for an unfolded row.
 *
 *  Folding is CONSECUTIVE-ONLY, which is the whole safety property: the fold
 *  never reorders what the seat actually did, it only collapses a run of the
 *  same tool that happened back to back. A `chart draw`, then an `order book`,
 *  then another `chart draw` stays three rows — because the order of the work is
 *  the information. */
export interface ToolRowGroup {
    label: string;
    /** How many same-label calls this line stands for. */
    count: number;
    /** Each member's detail, in call order. */
    details: string[];
    /** Each member's state, in call order. */
    states: ToolRowState[];
    /** Each member's payload id, in call order. '' means that call kept none. */
    payloadIds: string[];
}

/** Pairing, index-aware. The pairing itself lives in `utils/turnStatus.ts` —
 *  the ONE reader of the digest grammar — so the rows, the turn's status line
 *  and the turn's summary are three readers of one fact. A second pairing
 *  here is how a row and the summary stop agreeing about what was called. */
export { pairToolRows };

/** What one expandable row shows when opened, resolved once per row.
 *
 *  Two sources, in honest order: the persisted payload store (the call's real
 *  output, kept after a reload), and for a result clipped THIS turn the live
 *  artifact store may still hold the bytes paged under a `ta-…` id. Only when
 *  neither has them does the row say so — it never opens onto an empty box that
 *  looks like output, because a blank panel claiming to be a result is the
 *  decorative-empty-state defect the `imageOmitted` row already avoids. */
interface PayloadBody {
    /** The text to render, or null when nothing was kept. */
    text: string | null;
    /** Why nothing was kept, when it wasn't. */
    refused: string | null;
}

const resolvePayload = (toolCallId: string): PayloadBody => {
    const persisted = readToolPayload(toolCallId);
    if (persisted && persisted.text) return { text: persisted.text, refused: null };
    const artifactId = persisted?.artifact;
    if (artifactId) {
        const page = readToolArtifact(artifactId, 0, 8000);
        // A miss is a `DATA_UNAVAILABLE` string, not an empty result — only an
        // `ok` page with content counts as bytes actually recovered.
        if (page.ok && page.content) return { text: page.content, refused: null };
    }
    const kept = persisted?.kept;
    const total = persisted?.total;
    if (typeof kept === 'number' && typeof total === 'number' && total > kept) {
        return { text: null, refused: `full result not kept · ${(total - kept).toLocaleString()} chars` };
    }
    return { text: null, refused: 'full result not kept' };
};

/** One folded line: `order book ×4`, expanding to each member's real output.
 *
 *  A group with one member is the ordinary case and renders exactly as the
 *  single-row path did. When it folds, the count is the disclosure: the row says
 *  how many calls it stands for, and opening it lists every member's payload
 *  rather than picking one. */
const ToolRowGroupView: React.FC<{ group: ToolRowGroup; running: boolean }> = ({ group, running }) => {
    const [open, setOpen] = useState(false);
    const expandable = group.payloadIds.some(id => !!id);
    const anyCalling = group.states.some(s => s === 'calling') && running;
    const anyFailed = group.states.some(s => s === 'failed');
    // The folded line shows the LAST member's detail — the most recent outcome —
    // with the count beside it naming how many calls the line stands for.
    const detail = group.details[group.details.length - 1] ?? '';
    // The kind of the step: what the desk DID. The glyph carries it on screen;
    // the name travels with the row for a screen reader and a tooltip.
    const kind = toolKindOf(group.label).kind;
    const Glyph = KIND_GLYPH[kind];
    const kindName = toolKindLabel(kind);

    const line = (
        <div className="group/tool flex items-center gap-2 text-ui-caption leading-5 text-zinc-500" data-kind={kind}>
            {anyCalling ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
            ) : (
                <Glyph className={`h-3.5 w-3.5 shrink-0 ${anyFailed ? 'text-zinc-400' : 'text-zinc-600'}`} aria-hidden="true" />
            )}
            <span className={`shrink-0 transition-colors group-hover/tool:text-zinc-200 ${anyCalling ? 'text-zinc-400' : anyFailed ? 'text-zinc-300' : 'text-zinc-300'}`}>
                {group.label}
            </span>
            {group.count > 1 && (
                <span className="shrink-0 tabular-nums text-zinc-500">×{group.count}</span>
            )}
            {anyCalling ? (
                <span className="min-w-0 truncate text-zinc-500" title="calling…">calling…</span>
            ) : detail ? (
                <span className="min-w-0 truncate text-zinc-500 transition-colors group-hover/tool:text-zinc-300" title={detail}>{detail}</span>
            ) : anyFailed ? (
                <span className="min-w-0 truncate text-rose-400/90" title="failed">failed</span>
            ) : null}
            {expandable && (
                <ChevronRight
                    className={`ml-0.5 h-3 w-3 shrink-0 transition-transform duration-150 ease-[var(--ease-snappy)] ${
                        open ? 'rotate-90 text-zinc-300' : 'text-zinc-600 group-hover/tool:text-zinc-400'
                    }`}
                    aria-hidden="true"
                />
            )}
        </div>
    );

    const rowState = anyCalling ? 'calling' : anyFailed ? 'failed' : 'done';
    if (!expandable) return <div className="tool-row-static" data-testid="tool-row" data-state={rowState}>{line}</div>;

    return (
        <Disclosure
            className="tool-row"
            summaryClassName="tool-row-summary"
            bodyClassName="tool-row-body custom-scrollbar"
            testId="tool-row"
            detailsProps={{ 'data-fold-count': group.count, 'data-kind': kind, 'data-state': rowState }}
            open={open}
            onToggle={setOpen}
            label={`${group.label} (${kindName})${group.count > 1 ? ` ×${group.count}` : ''} — ${open ? 'collapse' : 'expand'}`}
            bodyProps={{ role: 'region', 'aria-label': `${group.label} output` }}
            summary={line}
        >
            {group.payloadIds.map((id, i) => (
                <ToolCallBody
                    key={`${id}-${i}`}
                    toolCallId={id}
                    label={group.label}
                    state={group.states[i] ?? 'done'}
                    detail={group.details[i] ?? ''}
                />
            ))}
        </Disclosure>
    );
};

const ToolCallBody: React.FC<{
    toolCallId: string;
    label: string;
    state: ToolRowState;
    detail: string;
}> = ({ toolCallId, label, state, detail }) => {
    const body = useMemo(() => (toolCallId ? resolvePayload(toolCallId) : null), [toolCallId]);
    const formatted = useMemo(() => (body?.text ? formatToolPayload(body.text) : null), [body]);
    const [showAll, setShowAll] = useState(false);
    const [copied, setCopied] = useState(false);
    const failed = state === 'failed';

    const onCopy = (): void => {
        if (!formatted?.text) return;
        void copyText(formatted.text).then(ok => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        });
    };

    return (
        <div className="space-y-2.5">
            <div className="space-y-1">
                <div className="tool-row-output-head">
                    <span className="tool-row-output-title">Request</span>
                </div>
                <pre className="tool-row-output">{label}{detail ? ` · ${detail}` : ''}</pre>
            </div>
            <div className="border-t border-white/[0.06] pt-2.5 space-y-1">
                <div className="tool-row-output-head">
                    <span className="tool-row-output-title">Response</span>
                    {formatted ? <span className="tool-row-output-lang">{formatted.language}</span> : null}
                    {failed && <span className="tool-row-output-lang tool-row-failed-chip">Failed</span>}
                    {formatted?.text && (
                        <button
                            type="button"
                            onClick={onCopy}
                            aria-label={copied ? 'Response copied' : 'Copy response payload'}
                            title={copied ? 'Copied' : 'Copy response'}
                            className="ml-auto flex items-center gap-1 rounded-control px-1.5 py-0.5 text-ui-2xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                            {copied
                                ? <><Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /><span>Copied</span></>
                                : <><Copy className="h-3 w-3" aria-hidden="true" /><span>Copy</span></>}
                        </button>
                    )}
                </div>
                {formatted?.text ? (
                    <>
                        <pre className="tool-row-output">{showAll ? formatted.text : formatted.preview}</pre>
                        {formatted.truncated && (
                            <button
                                type="button"
                                onClick={() => setShowAll(v => !v)}
                                className="mt-1 text-ui-2xs text-zinc-500 transition-colors hover:text-zinc-200"
                            >
                                {showAll ? 'Show less' : `Show all ${formatted.lineCount} lines`}
                            </button>
                        )}
                    </>
                ) : (
                    <p className="tool-row-refused">{body?.refused ?? 'full result not kept'}</p>
                )}
            </div>
        </div>
    );
};

/**
 * One row per CALL, not per event: a `calling X…` line OPENS a row and the
 * matching result line (`X · detail` / `X · failed`) UPDATES it in place — the
 * transcript never shows the call and the outcome as two separate
 * lines. Matching is by human label in FIFO order (parallel calls of the
 * same tool pair up in issue order). Old persisted grammars degrade
 * gracefully: an unmatched result renders standalone, an unmatched
 * `calling` stays a calling row.
 */
export const pairToolLines = (lines: string[]): PairedToolRow[] =>
    pairToolRows(lines).map(({ sources: _sources, ...row }) => row);

/** Fold CONSECUTIVE same-label rows into one line — `order book ×4`.
 *
 *  Consecutive-only is the safety property: a fold never reorders what the seat
 *  actually did. `chart draw`, `order book`, `chart draw` stays three rows,
 *  because the order of the work is the information; four `order book` calls in
 *  a row collapse to one line that expands back to four.
 *
 *  `payloadIds` is indexed by position in the ORIGINAL line list. Each paired row
 *  consumed one or two source lines (its `calling…` line and its result), and the
 *  id lives on the RESULT line — so a group holds exactly ONE id per member,
 *  keeping `payloadIds[i]` answerable for `details[i]`. */
export const foldConsecutiveToolRows = (lines: string[], payloadIds: string[] = []): ToolRowGroup[] => {
    const rows = pairToolRows(lines);
    const groups: ToolRowGroup[] = [];
    for (const row of rows) {
        // A row's own payload id: the id stamped on the line that CARRIED the
        // bytes. Looking it up positionally across the whole line list lands on
        // the calling line, which never has one.
        const id = row.sources.map(s => payloadIds[s] ?? '').find(v => !!v) ?? '';
        const prev = groups[groups.length - 1];
        if (prev && prev.label === row.label) {
            prev.count += 1;
            prev.details.push(row.detail);
            prev.states.push(row.state);
            prev.payloadIds.push(id);
            continue;
        }
        groups.push({
            label: row.label,
            count: 1,
            details: [row.detail],
            states: [row.state],
            payloadIds: [id],
        });
    }
    return groups;
};

/** Old runs joined parallel calls into one line ("calling a… · calling b…");
 *  split those into one row per call. Joined DIGEST lines carry real detail
 *  in the middle, so only split when EVERY segment is a call. */
const expandLine = (raw: string): string[] => {
    const line = stripTraceMarkers(raw ?? '').trim();
    if (!line) return [];
    const segments = line.split(' · ').map(s => s.trim());
    if (segments.length > 1 && segments.every(s => /^calling /i.test(s))) return segments;
    return [line];
};

/**
 * ZCode-style tool transcript: every desk-tool call renders as ONE compact
 * row whose state UPDATES in place — `⚒ chart view · calling…` flips to
 * `⚒ chart view · ok` (or `⚒ order book · ETHUSDT · buy wall …`) without
 * ever appending a second line. Markdown markers are stripped — model text
 * never leaks `**` into the transcript.
 */
const ToolActivityRow: React.FC<ToolActivityRowProps> = ({ lines, running = false, className = '', payloadIds }) => {
    const expanded = lines.flatMap(expandLine);
    const groups = foldConsecutiveToolRows(expanded, payloadIds ?? []);
    if (groups.length === 0) return null;
    return (
        <div
            className={`tool-activity-list ${className}`.trim()}
            data-testid="tool-activity"
            data-state={running ? 'running' : 'ok'}
        >
            {groups.map((group, i) => (
                <ToolRowGroupView key={`${group.label}-${i}`} group={group} running={running} />
            ))}
        </div>
    );
};

export default React.memo(ToolActivityRow);
