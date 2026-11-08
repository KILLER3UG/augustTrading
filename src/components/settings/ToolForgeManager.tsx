/**
 * ToolForgeManager — Settings → AI Models panel for model-authored tools.
 * Candidates land here when a seat calls `forge_tool`; nothing runs
 * network until a human approves. Shows uses/success stats for
 * confirmed tools; retire/delete available on every row.
 */

import React from 'react';
import { Check, Trash2, Ban } from '../shared/Icons';
import { ForgedTool, loadForgedTools, approveForgedTool, retireForgedTool, deleteForgedTool, forgedToolStats, FORGED_PROPOSAL_EVENT } from '../../services/tools/toolForge';

const StatusBadge: React.FC<{ tool: ForgedTool }> = ({ tool }) => {
    const map: Record<ForgedTool['status'], string> = {
        candidate: 'bg-amber-950/60 text-amber-400',
        confirmed: 'bg-emerald-950/60 text-emerald-400',
        retired: 'bg-zinc-900 text-zinc-600 line-through',
    };
    return (
        <span className={`rounded-control px-1.5 py-0.5 text-ui-xs font-bold uppercase tracking-wider ${map[tool.status]}`}>
            {tool.status}
        </span>
    );
};

/** Cheap identity guard: loadForgedTools always returns a fresh array, so a
 *  plain reference compare would never bail. The list only meaningfully
 *  changes on proposal/approve/retire/delete — id + status + usage stamps
 *  cover all four (stats drift between renders is accepted: the panel
 *  re-syncs on the same events and remounts whenever Settings opens). */
const sameTools = (a: ForgedTool[], b: ForgedTool[]): boolean =>
    a.length === b.length
    && a.every((t, i) => t === b[i]
        || (t.id === b[i].id && t.status === b[i].status && t.uses === b[i].uses && t.updatedAt === b[i].updatedAt));

export const ToolForgeManager: React.FC = () => {
    const [tools, setTools] = React.useState<ForgedTool[]>([]);
    const [saveError, setSaveError] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Initial load, then re-read only when the forge ANNOUNCES a change
        // (FORGED_PROPOSAL_EVENT fires per proposal, and the panel's own
        // actions re-read below) — the old 5s setInterval polled localStorage
        // + JSON.parse forever while Settings was open, for an event that is
        // already a push.
        const sync = (): void => {
            const next = loadForgedTools();
            setTools(prev => (sameTools(prev, next) ? prev : next));
        };
        sync();
        window.addEventListener(FORGED_PROPOSAL_EVENT, sync);
        return () => window.removeEventListener(FORGED_PROPOSAL_EVENT, sync);
    }, []);

    /** Every writer here now reports whether its bytes landed, so a refused write
     *  cannot render as a state change that a reload silently undoes. */
    const act = (fn: () => unknown): void => {
        let result: unknown;
        try {
            result = fn();
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : 'That change could not be saved.');
            return;
        }
        setSaveError(result === undefined || result === false
            ? 'That change could not be saved — storage is full or unavailable, so nothing was changed.'
            : null);
        const next = loadForgedTools();
        setTools(prev => (sameTools(prev, next) ? prev : next));
    };

    return (
        <div className="space-y-2">
            <p className="text-ui-dense leading-snug text-zinc-500">
                Tools proposed by the models during a tool turn (via <code className="text-zinc-400">forge_tool</code>).
                A candidate is an inert HTTP recipe — it cannot run until you approve it.
            </p>
            {saveError && (
                <p role="alert" data-testid="forge-save-error"
                    className="rounded-control border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-ui-dense leading-snug text-rose-300">
                    {saveError}
                </p>
            )}
            {tools.length === 0 && (
                <p className="rounded-control border border-hairline bg-zinc-900/50 px-3 py-4 text-center text-ui-sm text-zinc-600">
                    No forged tools yet. Models propose one by calling <code className="text-zinc-400">forge_tool</code> when the desk lacks a lookup they need.
                </p>
            )}
            {tools.map(tool => {
                const stats = forgedToolStats(tool.id);
                return (
                    <div
                        key={tool.id}
                        className="rounded-control border border-hairline bg-zinc-900/40 p-3"
                        data-testid={`forged-tool-${tool.id}`}
                    >
                        <div className="flex items-center gap-2">
                            <code className="text-ui-sm font-semibold text-zinc-200">{tool.id}</code>
                            <StatusBadge tool={tool} />
                            {tool.status === 'confirmed' && (
                                <span className="ml-auto shrink-0 text-ui-xs text-zinc-500">
                                    {stats.uses} calls · {Math.round(stats.successRate * 100)}% ok
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-ui-dense leading-snug text-zinc-400">{tool.proposal.description}</p>
                        <p className="mt-1 truncate text-ui-xs text-zinc-600" title={`${tool.proposal.method ?? 'GET'} ${tool.proposal.urlTemplate}${tool.proposal.extractPath ? ` → ${tool.proposal.extractPath}` : ''}`}>
                            {tool.proposal.method ?? 'GET'} {tool.proposal.urlTemplate}
                            {tool.proposal.extractPath ? ` → ${tool.proposal.extractPath}` : ''}
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                            {tool.status === 'candidate' && (
                                <button
                                    type="button"
                                    onClick={() => act(() => approveForgedTool(tool.id))}
                                    data-testid={`approve-forged-${tool.id}`}
                                    className="flex items-center gap-1 rounded-control border border-hairline px-2 py-1 text-ui-dense font-semibold text-zinc-200 hover:bg-zinc-800"
                                >
                                    <Check className="h-3 w-3" aria-hidden="true" /> Approve network access
                                </button>
                            )}
                            {tool.status === 'confirmed' && (
                                <button
                                    type="button"
                                    onClick={() => act(() => retireForgedTool(tool.id))}
                                    className="flex items-center gap-1 rounded-control px-2 py-1 text-ui-dense text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                                >
                                    <Ban className="h-3 w-3" aria-hidden="true" /> Retire
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => act(() => deleteForgedTool(tool.id))}
                                aria-label={`Delete ${tool.id}`}
                                className="ml-auto rounded-control p-1 text-zinc-600 hover:bg-zinc-800 hover:text-rose-300"
                            >
                                <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default ToolForgeManager;
