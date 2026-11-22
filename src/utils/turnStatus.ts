/**
 * turnStatus — the ONE answer to "what is this turn doing right now?".
 *
 * WHY A MODULE AND NOT A LABEL IN A COMPONENT. Two surfaces render a turn's
 * work — the Chart AI dock and the Agents surface — and they used to derive the
 * words separately: `ChatWorkTimeline` had its own regex to name the work
 * after the fact, and `ToolActivityRow` had another to pair a call with its
 * result. Two parsers of one grammar is how the summary and the rows stop
 * agreeing, and the summary is the promise the rows have to keep: what the
 * trader reads collapsed is exactly what they get when they open it.
 *
 * So the GRAMMAR lives here, once. `parseToolLine` reads one digest line;
 * `ToolActivityRow` pairs the lines with it, and `turnActivityLabel` and
 * `turnWorkSummary` name the turn with it. One parser, three consumers, and a
 * summary that cannot drift from the rows beneath it.
 *
 * The grammar the desk loop writes (`services/analysis/DeskToolsService.ts`,
 * `digestToolResult`):
 *
 *   `calling order book…`          — a call is in flight
 *   `order book · ETHUSDT · buy wall $1.2M @ 94.8k` — the result
 *   `order book · failed`          — the result, failed
 *
 * The label is the tool's HUMAN label, not its name — the transcript never
 * carries a name. `utils/toolKinds.ts` maps that label to a kind and an
 * activity phrase.
 */

import { stripTraceMarkers } from './traceText';
import { KIND_ORDER, toolKindCount, toolKindOf, type ToolKind } from './toolKinds';

/**
 * Lines the desk writes to the SAME tool-event channel that are NOT tool
 * calls: compaction receipts, thinking-cut repairs, the repeated-call guard,
 * the "nothing looked up" notice and the truncation warning. They must stay
 * visible in the work card, but they are not calls — counting one as a step
 * would tell the trader the desk ran a tool it never ran, and letting one be
 * the last line would make the status say "Compacted…" where it should name
 * the work.
 *
 * The prefixes are the desk's own literals. A new harness notice must be added
 * here. (`Compacted ` is the calm compaction receipt — the all-caps
 * "COMPACTED FOR THE CONTEXT WINDOW" line it replaced read as an alarm.)
 */
const HARNESS_NOTICE_PREFIXES = [
    'desk guard',
    'thinking hit the round',
    'tool syntax',
    'Compacted ',
    'CONTEXT FULL',
    'CONTEXT WINDOW TOO SMALL',
    'OUTPUT BUDGET',
    'FULL ANALYSIS, NOTHING LOOKED UP',
    'NOTHING WAS LOOKED UP',
    'THE PROVIDER STOPPED EARLY',
    'TOOL FAILURE',
];

export const isHarnessNoticeLine = (raw: string): boolean => {
    const line = stripTraceMarkers(raw ?? '').trim();
    return HARNESS_NOTICE_PREFIXES.some(prefix => line.startsWith(prefix));
};

/** A tool row's state. Derived from the line's TEXT, never stored separately —
 *  the digest line is the only record of what happened. */
export type ToolRowState = 'calling' | 'done' | 'failed';

/** One digest line, read. */
export interface ParsedToolLine {
    /** The tool's human label ("order book"). */
    label: string;
    /** Everything after the label ("ETHUSDT · buy wall $1.2M @ 94.8k"). */
    detail: string;
    state: ToolRowState;
}

/**
 * Read one digest line. `null` for a line with nothing in it.
 *
 * The result line's label is the part before the FIRST ` · `, so
 * "order book · ETHUSDT · buy wall…" is the tool "order book" with the rest
 * as detail — the coin is part of the outcome, not part of the name.
 */
export const parseToolLine = (raw: string): ParsedToolLine | null => {
    const line = stripTraceMarkers(raw ?? '').trim();
    if (!line) return null;
    const calling = /^calling\s+(.+?)(…|$)/i.exec(line);
    if (calling) {
        const label = calling[1].trim();
        return label ? { label, detail: '', state: 'calling' } : null;
    }
    const sep = line.indexOf(' · ');
    const label = (sep > 0 ? line.slice(0, sep) : line).trim();
    if (!label) return null;
    const rest = sep > 0 ? line.slice(sep + 3).trim() : '';
    const failed = /(^| · )failed$/i.test(rest);
    return {
        label,
        detail: failed ? rest.replace(/ ·? failed$/i, '') : rest,
        state: failed ? 'failed' : 'done',
    };
};

/**
 * What the turn is doing RIGHT NOW — the status line's word.
 *
 * It is the LAST tool's activity, so the line changes as the work changes
 * ("Reading the chart" → "Reading the order book" → "Running the screener"),
 * which is the reference's behaviour. It is derived, never asked of the model:
 * the desk's own digest lines are the evidence, so this can only ever report
 * what the tools say.
 *
 * `null` when the turn has done nothing yet — the caller then shows its own
 * waiting state rather than an invented phrase.
 */
export const turnActivityLabel = (lines: string[], hasReasoning: boolean): string | null => {
    let last: ParsedToolLine | null = null;
    for (const raw of lines ?? []) {
        if (isHarnessNoticeLine(raw)) continue;
        const parsed = parseToolLine(raw);
        if (parsed) last = parsed;
    }
    if (last) {
        // An unknown tool keeps its own label: a wrong gerund would be a lie
        // about the model's work, and the label is not.
        return toolKindOf(last.label).activity || last.label;
    }
    // No tool yet, but the model is reasoning — that IS an activity, and it
    // is the truth rather than a placeholder.
    return hasReasoning ? 'Thinking' : null;
};

/** One paired row: a CALL and its result, merged. `sources` are the indices in
 *  the original line list that produced it — the `calling…` line and/or the
 *  result line.
 *
 *  That bookkeeping is load-bearing, not decoration: a payload id is stamped on
 *  the RESULT line, while the `calling…` line never has one. Without the
 *  source indices the id cannot be found again — a positional lookup lands on
 *  the calling line, and the expander silently never appears. */
export interface PairedToolRow {
    label: string;
    detail: string;
    state: ToolRowState;
    sources: number[];
}

/**
 * Pair a call with its result, index-aware.
 *
 * A `calling X…` line OPENS a row and the matching result line (`X · detail`
 * / `X · failed`) UPDATES it in place — the transcript never shows the call
 * and the outcome as two separate lines. Matching is by human label in FIFO
 * order (parallel calls of the same tool pair up in issue order). Old
 * persisted grammars degrade gracefully: an unmatched result renders
 * standalone, an unmatched `calling` stays a calling row.
 *
 * ONE PAIR ROW = ONE CALL. That is the fact the turn's summary counts: the
 * transcript holds two lines per call (the call and its result), so counting
 * LINES doubles every number the trader is told.
 */
export const pairToolRows = (lines: string[]): PairedToolRow[] => {
    const rows: PairedToolRow[] = [];
    const open = new Map<string, PairedToolRow[]>();
    lines.forEach((raw, index) => {
        const parsed = parseToolLine(raw);
        if (!parsed) return;
        if (parsed.state === 'calling') {
            const row = { label: parsed.label, detail: parsed.detail, state: parsed.state, sources: [index] };
            const queue = open.get(row.label) ?? [];
            queue.push(row);
            open.set(row.label, queue);
            rows.push(row);
            return;
        }
        const queue = open.get(parsed.label);
        if (queue && queue.length > 0) {
            const row = queue.shift()!;
            row.state = parsed.state;
            row.detail = parsed.detail;
            row.sources.push(index);
        } else {
            rows.push({ label: parsed.label, detail: parsed.detail, state: parsed.state, sources: [index] });
        }
    });
    return rows;
};

/**
 * What kinds of work the turn did, counted by CALL: "4 reads, 1 search".
 *
 * The reference's settled summary says what it did in typed counts ("Ran 4
 * commands, read a file") — because a trader who reads only the collapsed row
 * should still know whether the desk LOOKED things up or WROTE something.
 * August could not say that: a step carried no kind at all, so the only
 * honest summary was a count of lines.
 */
export const turnKindSummary = (lines: string[]): string | null => {
    const rows = pairToolRows((lines ?? []).filter(line => !isHarnessNoticeLine(line)));
    if (rows.length === 0) return null;
    const counts = new Map<ToolKind, number>();
    for (const row of rows) {
        const kind = toolKindOf(row.label).kind;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const kind of KIND_ORDER) {
        const n = counts.get(kind);
        if (!n) continue;
        parts.push(toolKindCount(kind, n));
    }
    return parts.length > 0 ? parts.join(', ') : null;
};

/**
 * What the turn DID, named from the transcript it already produced — no model
 * call, no new store.
 *
 * The rows below show these labels, so the summary names the same strings:
 * what the trader reads collapsed is exactly what they get when they open it.
 * Duplicates are folded (four order-book calls are one mention) and the list
 * is capped so a tool-heavy turn does not become a paragraph — and "+N" names
 * how many were left out, not how many the loop happened to reach.
 *
 * These are the NAMES; the COUNTS live in {@link turnKindSummary}, which
 * counts by kind. The two answer different questions, and the settled row
 * shows both: "3 reads, 1 search, order book, indicators".
 */
export const turnWorkSummary = (tools: string[]): string | null => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const raw of tools ?? []) {
        if (isHarnessNoticeLine(raw)) continue;
        const parsed = parseToolLine(raw);
        if (!parsed) continue;
        const head = parsed.label;
        if (!head) continue;
        const key = head.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(head);
    }
    if (parts.length === 0) return null;
    const shown = parts.slice(0, 4);
    const more = parts.length - shown.length;
    const label = shown.join(', ');
    return more > 0 ? `${label} +${more}` : label;
};
