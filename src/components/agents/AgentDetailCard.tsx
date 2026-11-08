/**
 * AgentDetailCard — what an agent IS, in full, read-only.
 *
 * The launch list tells the trader which agent is which — the row says what
 * the agent is FOR. But a one-line role is a summary, and the things a trader
 * actually wants before handing a turn to an agent are the rest of it: which
 * model thinks, whose notebook it reads, what it was told to do, and what it
 * was thinking last time.
 *
 * So the list's row opens a full card, and the card is a READER. Editing stays
 * where the editor already is (the roster's own dialog): a viewer that also
 * edits is two editors, and the two would drift.
 */
import React from 'react';
import type { AgentBot } from '../../services/agents/agentRoster';
import { formatModelDisplayName } from '../../utils/providerUtils';
import MarkdownContent from '../shared/MarkdownContent';

export interface AgentDetailCardProps {
    bot: AgentBot;
    /** How many skills this agent authored. */
    skillsAuthored?: number;
    /** The trace of its last turn, if it left one. */
    trace?: string;
}

const SCOPE_LABEL: Record<string, string> = {
    global: 'the shared notebook',
    personal: 'your notebook',
    isolated: 'its own notebook',
};

const AgentDetailCard: React.FC<AgentDetailCardProps> = ({ bot, skillsAuthored, trace }) => {
    const scope = bot.memoryScope ?? 'global';
    const spec: { label: string; value: string }[] = [
        { label: 'Model', value: formatModelDisplayName(bot.modelId) || bot.modelId },
        { label: 'Notebook', value: SCOPE_LABEL[scope] ?? scope },
    ];
    if (typeof skillsAuthored === 'number' && skillsAuthored > 0) {
        spec.push({ label: 'Skills', value: `${skillsAuthored} authored` });
    }
    return (
        <div className="space-y-5" data-testid="agent-detail-card">
            {bot.description && (
                <section>
                    <h3 className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-widest text-zinc-500">What it is for</h3>
                    <MarkdownContent content={bot.description} className="text-ui-base leading-7 text-zinc-300" />
                </section>
            )}
            <section>
                <h3 className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-widest text-zinc-500">How it thinks</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui-dense">
                    {spec.map(s => (
                        <React.Fragment key={s.label}>
                            <dt className="text-zinc-500">{s.label}</dt>
                            <dd className="text-zinc-200">{s.value}</dd>
                        </React.Fragment>
                    ))}
                </dl>
            </section>
            {bot.customPrompt && (
                <section>
                    <h3 className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-widest text-zinc-500">Its standing instructions</h3>
                    <MarkdownContent content={bot.customPrompt} className="text-ui-base leading-7 text-zinc-300" />
                </section>
            )}
            {trace && (
                <section>
                    <h3 className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-widest text-zinc-500">Its last thinking</h3>
                    <div className="rounded-control border border-hairline bg-zinc-900/60 px-3 py-2.5">
                        <MarkdownContent content={trace} className="text-ui-dense leading-6 text-zinc-400" />
                    </div>
                </section>
            )}
        </div>
    );
};

export default AgentDetailCard;
