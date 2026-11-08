/**
 * PatternMemoryCard — the journal review's synthesis, read where the memory
 * it describes lives. It used to sit inside the Journal's trade log (a
 * pattern-memory.md row above the ledger); the Journal is the trade ledger
 * alone now, and this card is the Learning surface's Memory tab.
 *
 * The document itself lives in the notebook (profile/pattern-memory.md) and
 * is rewritten by the Memory model when the journal updates, so the card
 * reads it live off the store subscription. While no file exists yet it
 * composes the same markdown the pipeline would from the review text and the
 * logged trades — the same builder, so card and file can never disagree.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FileText as FileTextIcon, RefreshCw as RefreshIcon } from '../shared/Icons';
import MarkdownContent from '../shared/MarkdownContent';
import {
    getMemoryFiles,
    subscribeMemoryFilesChanged,
    toPatternMemoryMarkdown,
    patternMemoryStatsFromTrades,
} from '../../services/learning/MemoryFilesService';
import type { LoggedTrade } from '../../types';

interface PatternMemoryCardProps {
    trades: LoggedTrade[];
    /** The journal's final review text — what the fallback composes from. */
    finalSummary: string | null;
    /** True while the review model is rewriting the synthesis. */
    isLoading: boolean;
    /** Re-run the review pipeline (the Journal review's own regenerate). */
    onRegenerate?: () => void;
}

const PatternMemoryCard: React.FC<PatternMemoryCardProps> = ({ trades, finalSummary, isLoading, onRegenerate }) => {
    // Bumped by the notebook subscription so the read below re-runs when a
    // post-mortem or the review model rewrites pattern-memory.md elsewhere.
    const [fileVersion, setFileVersion] = useState(0);
    useEffect(() => subscribeMemoryFilesChanged(() => setFileVersion(v => v + 1)), []);

    const markdown = useMemo(() => {
        void fileVersion;
        const store = getMemoryFiles();
        const folder = store.folders.find(f => f.name === 'profile');
        const file = store.files.find(f => f.name === 'pattern-memory.md' && (!folder || f.folderId === folder.id));
        if (file?.content.trim()) return file.content;
        return toPatternMemoryMarkdown(finalSummary, patternMemoryStatsFromTrades(trades));
    }, [finalSummary, fileVersion, trades]);

    return (
        <section
            className="rounded-control border border-zinc-800/80 bg-zinc-900/60"
            data-testid="pattern-memory-card"
        >
            <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    <FileTextIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <h3 className="truncate text-ui-sm font-semibold text-zinc-100" title="Pattern memory">Pattern memory</h3>
                    <span className="hidden shrink-0 font-mono text-ui-2xs text-zinc-600 sm:inline">pattern-memory.md</span>
                </div>
                {onRegenerate && (
                    <button
                        type="button"
                        onClick={onRegenerate}
                        disabled={isLoading}
                        title="Regenerate synthesis"
                        aria-label="Regenerate pattern memory synthesis"
                        className="inline-flex shrink-0 items-center gap-1 rounded-control border border-transparent px-2 py-1.5 text-ui-dense text-zinc-500 transition-colors duration-[120ms] ease-[var(--ease-snappy)] hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none disabled:opacity-50"
                    >
                        <RefreshIcon className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                        {isLoading ? 'Synthesizing…' : 'Regenerate'}
                    </button>
                )}
            </div>
            <div className="px-4 py-4">
                <p className="mb-3 text-ui-dense text-zinc-500">
                    Rewritten by the Memory model when the journal updates — the lessons
                    and recurring patterns it found across your logged trades.
                </p>
                <div className="rounded-control border border-zinc-800 bg-zinc-950 px-4 py-4 lg:px-6 lg:py-5">
                    <MarkdownContent content={markdown} className="text-ui-base text-zinc-200 leading-7" />
                </div>
            </div>
        </section>
    );
};

export default PatternMemoryCard;
