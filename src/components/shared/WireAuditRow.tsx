/**
 * WireAuditRow — what the wire was actually asked.
 *
 * The transport has ALWAYS decided, for every request, which capability route
 * it applied: an Anthropic thinking block, a Gemini thinking config, an
 * OpenAI effort knob — or none, with a reason. It emitted that decision on
 * every call (`onWireAudit`), and nothing collected it, so the transcript
 * could not answer the one question a trader asks about a missing trace:
 * *did the model not think, or was it never asked to?*
 *
 * This row is the answer, in the transport's own words:
 *
 *  - **No trace.** The summary says so, and says WHY — "no thinking block:
 *    model id not recognized as thinking-capable (set the override in
 *    Settings)". That is the difference between a model that chose not to think
 *    and a request that never asked.
 *  - **A trace.** The summary is the route that was applied; the body lists
 *    every call the turn made, because a turn is several requests and the
 *    last one is not the whole story.
 *
 * It is a disclosure, like every other expander in the app — a native
 * `<details>`, so it is a toggle in every state without JavaScript.
 */
import React from 'react';
import type { WireAuditEntry } from '../../types/provider';
import Disclosure from './Disclosure';

export interface WireAuditRowProps {
    /** One entry per call the turn made, in order. */
    entries: WireAuditEntry[];
    /** The turn settled and produced NO thinking trace, so the summary says
     *  WHY — the one question a trader cannot answer from the transcript. */
    noTrace: boolean;
}

const ROUTE_LABEL: Record<WireAuditEntry['route'], string> = {
    'anthropic-thinking': 'Anthropic thinking block',
    'gemini-thinking': 'Gemini thinking config',
    'openai-effort': 'OpenAI effort',
    'xai-effort': 'xAI effort',
    'responses-effort': 'Responses effort',
    'glm-thinking': 'GLM thinking',
    'deepseek-thinking': 'DeepSeek thinking',
    none: 'no route',
};

const WireAuditRow: React.FC<WireAuditRowProps> = ({ entries, noTrace }) => {
    if (!entries.length) return null;
    // The LAST call is the answer's own call — the one whose trace (if any)
    // is the trace the row shows.
    const last = entries[entries.length - 1];
    const summary = noTrace
        ? `No thinking trace — ${last.reason}`
        : `Wire · ${ROUTE_LABEL[last.route]} · ${last.effort}`;
    return (
        <Disclosure
            testId="wire-audit-row"
            label={summary}
            summary={(
                <span className="text-ui-2xs text-zinc-500" title={summary}>{summary}</span>
            )}
            summaryClassName="cursor-pointer text-ui-2xs text-zinc-500 transition-colors hover:text-zinc-300"
            bodyClassName="mt-1 space-y-1 rounded-control border border-hairline bg-zinc-950/40 px-2.5 py-2"
        >
            {entries.map((entry, i) => (
                <div key={`${entry.route}-${i}`} className="text-ui-2xs leading-5 text-zinc-500">
                    <span className="text-zinc-400">#{i + 1}</span>{' '}
                    <span className="text-zinc-300">{ROUTE_LABEL[entry.route]}</span>
                    {' · '}{entry.effort}
                    {' · '}{entry.applied ? 'applied' : 'not applied'}
                    <span className="block text-zinc-600">{entry.reason}</span>
                </div>
            ))}
        </Disclosure>
    );
};

export default WireAuditRow;
