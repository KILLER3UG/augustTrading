/**
 * DeskToolCatalogue — what the desk can actually call.
 *
 * Settings had ONE line about the desk's tools: a toggle that lets the desk
 * call live tools "anytime — web search, funding/OI, order book, liquidations,
 * BTC context, session timing". Six named tools out of forty. A trader
 * deciding whether to let the desk hold the tools has no way to see the other
 * thirty-four — and the ones nobody names are exactly the ones that write.
 *
 * So the catalogue lists them all, grouped BY KIND (the same kinds the
 * transcript's rows wear, from `utils/toolKinds.ts`), each with the name the
 * transcript shows, the name the tool is actually called, and what it does.
 *
 * It is a READER. The switch above it is the only control: the allow-lists
 * are code, not preferences, and a per-tool switch here would be a promise
 * the app does not keep. The catalogue says what the switch turns on.
 */
import React, { useMemo } from 'react';
import { DESK_TOOL_DEFINITIONS, toolLabel } from '../../../services/analysis/DeskToolsService';
import { KIND_ORDER, toolKindLabel, toolKindOf, type ToolKind } from '../../../utils/toolKinds';
import { KIND_GLYPH } from '../../shared/toolKindIcons';
import Disclosure from '../../shared/Disclosure';

interface CatalogueEntry {
    name: string;
    label: string;
    kind: ToolKind;
    summary: string;
    description: string;
}

/** The first sentence of a tool's description — enough to know what it does,
 *  short enough that forty of them stay a list rather than a wall. */
const firstSentence = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    const stop = flat.indexOf('. ');
    return stop > 0 ? flat.slice(0, stop + 1) : flat;
};

const DeskToolCatalogue: React.FC = () => {
    const entries = useMemo<CatalogueEntry[]>(() => DESK_TOOL_DEFINITIONS.map(def => {
        const name = def.function.name;
        const label = toolLabel(name);
        return {
            name,
            label,
            kind: toolKindOf(label).kind,
            summary: firstSentence(def.function.description ?? ''),
            description: def.function.description ?? '',
        };
    }), []);

    const byKind = useMemo(() => {
        const groups = new Map<ToolKind, CatalogueEntry[]>();
        for (const e of entries) {
            const list = groups.get(e.kind) ?? [];
            list.push(e);
            groups.set(e.kind, list);
        }
        return KIND_ORDER
            .filter(k => groups.has(k))
            .map(k => ({ kind: k, tools: groups.get(k) ?? [] }));
    }, [entries]);

    return (
        <Disclosure
            testId="desk-tool-catalogue"
            label="What the desk can call"
            summary={(
                <span className="flex items-center justify-between gap-4">
                    <span className="min-w-0">
                        <span className="block text-ui-caption font-semibold text-zinc-200">What the desk can call</span>
                        <span className="mt-0.5 block text-ui-dense text-zinc-500">
                            {entries.length} live tools, by kind. The switch above turns them all on or off.
                        </span>
                    </span>
                </span>
            )}
            summaryClassName="flex w-full items-center justify-between gap-4 rounded-bubble border border-hairline bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:bg-zinc-800/40"
            bodyClassName="mt-3 space-y-4 animate-fade-in"
        >
            {byKind.map(group => {
                const Glyph = KIND_GLYPH[group.kind];
                return (
                    <section key={group.kind} data-testid={`desk-tool-group-${group.kind}`}>
                        <h4 className="mb-1.5 flex items-center gap-1.5 text-ui-2xs font-semibold uppercase tracking-widest text-zinc-500">
                            <Glyph className="h-3 w-3" aria-hidden="true" />
                            {toolKindLabel(group.kind)}
                            <span className="font-mono text-zinc-600">{group.tools.length}</span>
                        </h4>
                        <ul className="space-y-1.5">
                            {group.tools.map(tool => (
                                <li key={tool.name} data-testid="desk-tool-row" className="rounded-control border border-hairline bg-zinc-900/40 px-3 py-2">
                                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                        <span className="text-ui-dense font-semibold text-zinc-200">{tool.label}</span>
                                        <code className="font-mono text-ui-2xs text-zinc-600">{tool.name}</code>
                                    </div>
                                    <p className="mt-0.5 text-ui-dense leading-5 text-zinc-500" title={tool.description}>{tool.summary}</p>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </Disclosure>
    );
};

export default DeskToolCatalogue;
