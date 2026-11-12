/**
 * ToolActionsRow — transcript status rows for model
 * side-effects. When a seat proposes a tool (forge_tool), amends
 * memory (amend_memory), or runs a custom tool, the run persists
 * ToolAction entries and this renders them as one-line status rows
 * (count chip on grouped rows). A row expands to its per-item detail
 * with the review location — the human knows where to act without a
 * hover.
 *
 * Refusals are AGGREGATED: every rejected action in the turn renders as
 * ONE quiet "Blocked" line ("2 skill drafts, 1 memory note rejected ·
 * nothing stored") no matter how many tool classes tripped a gate —
 * three alarming red rows for one turn read as the product failing, not
 * the harness enforcing. A refusal is still a status, not a footnote:
 * the line expands to the same per-item detail.
 */

import React, { useState } from 'react';
import { AlertTriangle, Brain, Wrench, FilePlus2, NotebookPen } from '../shared/Icons';
import type { ToolAction } from '../../types/message';

export interface ToolActionsRowProps {
    actions: ToolAction[];
}

const ICON_OK: Record<string, React.ReactNode> = {
    amend_memory: <Brain className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
    forge_tool: <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
    skill_write: <NotebookPen className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
    write_memory_note: <NotebookPen className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
    notebook_note: <NotebookPen className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
    custom: <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />,
};

/** Human label per tool class — where it lands and who reviews it. */
const actionLabel = (tool: string, items: ToolAction[]): string => {
    const n = items.length;
    const plural = n === 1 ? '' : 's';
    switch (tool) {
        case 'amend_memory':
            return `Memory amendment${plural} applied — the before/after and Undo are in Settings → Memory`;
        case 'forge_tool':
            return `Desk tool${plural} proposed — review in Skills → Forged tools`;
        case 'skill_write':
            return n === 1
                ? `Skill saved — ${items[0].label} (Skills)`
                : `${n} skills saved (Skills)`;
        case 'propose_strategy':
            // Without this the row falls through to "Ran <slug>" and the trader
            // reads a plan awaiting their review as something already done.
            return n === 1
                ? `Strategy plan proposed — ${items[0].label} (Skills → Trade plans; inactive until you activate it)`
                : `${n} strategy plans proposed — drafts, not active until you activate them`;
        case 'remember':
            return n === 1
                ? `Memory saved — ${(items[0].label.split('/')[1] ?? items[0].label)}`
                : `${n} memories saved`;
        case 'write_memory_note':
            return n === 1
                ? `Memory note saved — ${items[0].label} (Settings → Memory)`
                : `${n} memory notes saved (Settings → Memory)`;
        case 'notebook_note':
            return items.length === 1
                ? `Notebook ${items[0].verb} — ${items[0].label}`
                : `${n} notebook notes written`;
        default:
            return items.length === 1
                ? `Ran ${items[0].label.replace(/^custom_/, '')}`
                : `Ran ${items[0].tool.replace(/^custom_/, '')} ×${n}`;
    }
};

/** The noun a refusal counts ("2 skill drafts, 1 memory note rejected"). */
const failNoun = (tool: string, n: number): string => {
    const plural = n === 1 ? '' : 's';
    switch (tool) {
        case 'skill_write':
            return `skill write${plural}`;
        case 'skill_draft':
            return `skill draft${plural}`;
        case 'skill_ingest':
            return `skill${plural}`;
        case 'propose_strategy':
            return `strategy plan${plural}`;
        case 'write_memory_note':
        case 'notebook_note':
            return `memory note${plural}`;
        case 'amend_memory':
            return `memory amendment${plural}`;
        case 'forge_tool':
            return `desk tool${plural}`;
        default:
            return `${tool} call${plural}`;
    }
};

interface Group {
    tool: string;
    ok: boolean;
    items: ToolAction[];
    speakers: string[];
}

export const ToolActionsRow: React.FC<ToolActionsRowProps> = ({ actions }) => {
    const [undoneSlugs, setUndoneSlugs] = useState<Set<string>>(new Set());
    if (!actions.length) return null;
    // Group by tool+ok — one row per class ("N items"). Fails are gathered
    // across classes into the single Blocked line below.
    const groups = new Map<string, Group>();
    for (const a of actions) {
        const key = `${a.tool}::${a.ok ? 'ok' : 'fail'}`;
        const g = groups.get(key) ?? { tool: a.tool, ok: a.ok, items: [], speakers: [] };
        g.items.push(a);
        if (!g.speakers.includes(a.speaker)) g.speakers.push(a.speaker);
        groups.set(key, g);
    }
    const okGroups = [...groups.values()].filter(g => g.ok);
    const failGroups = [...groups.values()].filter(g => !g.ok);
    const failItems = failGroups.flatMap(g => g.items);

    return (
        <div className="mb-2 space-y-1" data-testid="tool-actions-row">
            {okGroups.map(g => {
                const n = g.items.length;
                const who = g.speakers.filter(Boolean).join(', ');
                const icon = ICON_OK[g.tool] ?? ICON_OK.custom;
                const label = actionLabel(g.tool, g.items);
                // One-line action rows (OpenBot ToolLine shape): muted while
                // fine. Every row expands to the per-item detail with where
                // each item is reviewed — that location used to live only in
                // a hover tooltip.
                return (
                    <details
                        key={`${g.tool}-ok`}
                        className="group/tool-line"
                    >
                        <summary
                            className="flex cursor-pointer list-none items-center gap-2 text-ui-dense text-zinc-400 [&::-webkit-details-marker]:hidden"
                        >
                            <span
                                aria-hidden="true"
                                className="shrink-0 text-ui-2xs text-zinc-500 transition-transform group-open/tool-line:rotate-90"
                            >
                                ▸
                            </span>
                            {icon}
                            <span className="min-w-0 flex-1 truncate" title={`${who ? `${who} · ` : ''}${label} — ${n} item${n === 1 ? '' : 's'} awaiting human review`}>
                                {who ? <span className="text-zinc-500">{who} · </span> : null}
                                {label}
                            </span>
                            {n > 1 && (
                                <span className="shrink-0 rounded-full border border-zinc-600 px-1.5 py-px text-ui-2xs font-bold tabular-nums leading-tight text-zinc-300">
                                    {n}
                                </span>
                            )}
                        </summary>
                        <div className="mb-1 mt-1 space-y-0.5 border-l border-hairline pl-4">
                            {g.items.map((a, i) => {
                                // The ONE undo the chip style carries: a memory
                                // the model just saved can be taken back right
                                // here, without going to Settings. The slug
                                // rides the label ('kind/slug').
                                const slug = a.tool === 'remember' ? (a.label.split('/')[1] ?? '') : '';
                                const undone = slug !== '' && undoneSlugs.has(slug);
                                return (
                                    <p key={`${a.at}-${i}`} className="flex items-center gap-2 truncate text-ui-xs leading-4 text-zinc-500" title={`${a.verb} ${a.label}${a.review ? ` — review: ${a.review}` : ''}`}>
                                        <span className="text-zinc-400">{a.verb}</span> <span className="min-w-0 flex-1 truncate">{a.label}</span>
                                        {a.review ? <span className="text-zinc-600"> — review: {a.review}</span> : null}
                                        {a.tool === 'remember' && slug !== '' && (
                                            <button
                                                type="button"
                                                disabled={undone}
                                                data-testid={`memory-undo-${slug}`}
                                                onClick={() => {
                                                    void (async () => {
                                                        try {
                                                            const { forgetProfileMemory, flushProfileMemoryWrites } = await import('../../services/learning/profileMemory');
                                                            const { getActiveUsername } = await import('../../utils/activeUser');
                                                            const removed = forgetProfileMemory(slug, getActiveUsername()).gone;
                                                            if (removed && (await flushProfileMemoryWrites()).ok) {
                                                                window.dispatchEvent(new Event('august-profile-memory'));
                                                                setUndoneSlugs(prev => new Set(prev).add(slug));
                                                            }
                                                        } catch (err) {
                                                            console.warn('[ToolActions] memory undo failed:', err instanceof Error ? err.message : String(err));
                                                        }
                                                    })();
                                                }}
                                                className="shrink-0 rounded-control border border-hairline px-1.5 py-px text-ui-2xs font-bold uppercase tracking-wider text-zinc-400 transition-colors duration-[120ms] ease-[var(--ease-snappy)] hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                {undone ? 'Undone' : 'Undo'}
                                            </button>
                                        )}
                                    </p>
                                );
                            })}
                        </div>
                    </details>
                );
            })}

            {failGroups.length > 0 && (() => {
                const counts = failGroups
                    .map(g => `${g.items.length} ${failNoun(g.tool, g.items.length)}`);
                const who = [...new Set(failGroups.flatMap(g => g.speakers))].filter(Boolean);
                return (
                    <details className="group/tool-line" data-testid="tool-actions-blocked">
                        <summary
                            className="flex cursor-pointer list-none items-center gap-2 text-ui-dense text-rose-300 [&::-webkit-details-marker]:hidden"
                        >
                            <span
                                aria-hidden="true"
                                className="shrink-0 text-ui-2xs text-zinc-500 transition-transform group-open/tool-line:rotate-90"
                            >
                                ▸
                            </span>
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate" title={`Blocked — ${who.length === 1 ? `${who[0]}: ` : ''}${counts.join(', ')} rejected · nothing stored. The harness refused these side-effects.`}>
                                <span className="font-semibold">Blocked</span>
                                {' — '}
                                {who.length === 1 ? <span className="text-rose-400/80">{who[0]}: </span> : null}
                                {counts.join(', ')} rejected · nothing stored
                            </span>
                            <span className="shrink-0 rounded-full border border-rose-500/40 px-1.5 py-px text-ui-2xs font-bold tabular-nums leading-tight text-rose-300">
                                {failItems.length}
                            </span>
                        </summary>
                        <div className="mb-1 mt-1 space-y-0.5 border-l border-rose-500/20 pl-4">
                            {failItems.map((a, i) => (
                                <p key={`${a.at}-${i}`} className="truncate text-ui-xs leading-4 text-zinc-500" title={`${a.verb} ${a.label}${a.review ? ` — review: ${a.review}` : ''}`}>
                                    <span className="text-rose-400/80">{a.verb}</span> {a.label}
                                    {a.review ? <span className="text-zinc-600"> — review: {a.review}</span> : null}
                                </p>
                            ))}
                        </div>
                    </details>
                );
            })()}
        </div>
    );
};

export default ToolActionsRow;
