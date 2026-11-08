// TAB: Journal — hub & quick launcher (SettingsMenu "TAB 0").
//
// Moved verbatim from the inline IIFE body in SettingsMenu.tsx when the tab
// bodies became lazily-loaded components. The component binds its single
// `tab` props object to the name `props`, so the body's `props.` references
// are the same keys the IIFE closed over — no renames.
import React from 'react';
import { Activity, ArrowUpRight, Brain, BrainCircuit, FileText } from '../../shared/Icons';
import { ToggleSwitch } from '../../shared/ToggleSwitch';
import AutoJournalRulesCard from '../AutoJournalRulesCard';
import { SettingsGroup, SettingsPageHeader, SettingsRow } from './shared';
import type { SettingsTabProps } from './types';
import type { JournalUIState } from '../../../hooks/useJournalUI';

export interface JournalTabProps extends SettingsTabProps {
    onClose: () => void;
    /** Routes to the Journal SURFACE tab (stage 3). */
    onOpenJournal?: (tab?: JournalUIState['tab']) => void;
    useAlgorithmicSummary?: boolean;
    onToggleAlgorithmicSummary?: (enabled: boolean) => void;
    useAlgorithmicInsights?: boolean;
    onToggleAlgorithmicInsights?: (enabled: boolean) => void;
    summaryCharLimit?: number;
    onUpdateSummaryCharLimit?: (limit: number) => void;
}

const JournalTab: React.FC<{ tab: JournalTabProps }> = ({ tab: props }) => {
    const { onClose, onOpenJournal, onOpenLearn, username } = props;

    return (
        <div className="space-y-5 animate-fade-in">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                <SettingsPageHeader
                    title="Journal"
                    description="Review past trades and the pattern memory they build."
                />
                <button
                    type="button"
                    onClick={() => {
                        onClose();
                        onOpenJournal?.('log');
                    }}
                    className="mb-3.5 inline-flex items-center justify-center gap-2 rounded-control border border-hairline bg-zinc-800 px-3 py-1.5 text-ui-dense font-semibold text-zinc-200 transition-colors hover:border-line hover:bg-zinc-700 hover:text-zinc-100 active:scale-[0.98]"
                >
                    <span>Open Trading Journal</span>
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>

            {/* Stage 3: the four stat tiles are gone — Profile owns the
                identical numbers, and this tab is a launcher. */}

            {/* Quick navigation cards. The Model Performance card died with
                the Journal's Models tab (2026-10-07) — there is nothing left
                for it to open. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                    type="button"
                    onClick={() => {
                        onClose();
                        onOpenJournal?.('log');
                    }}
                    className="group flex flex-col rounded-bubble border border-hairline bg-zinc-800/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-zinc-800/60"
                >
                    <div className="flex items-center justify-between w-full">
                        <span className="font-semibold text-ui-sm text-zinc-200 group-hover:text-accent transition-colors">Trade Log</span>
                        <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 group-hover:text-accent transition-colors" aria-hidden="true" />
                    </div>
                    <p className="mt-1.5 text-ui-dense text-zinc-400">View and manage all recorded trades, outcomes, and screenshots.</p>
                </button>

                <button
                    type="button"
                    onClick={() => {
                        onClose();
                        onOpenLearn?.('memory');
                    }}
                    className="group flex flex-col rounded-bubble border border-hairline bg-zinc-800/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-zinc-800/60"
                >
                    <div className="flex items-center justify-between w-full">
                        <span className="font-semibold text-ui-sm text-zinc-200 group-hover:text-accent transition-colors">Pattern Memory</span>
                        <Brain className="h-3.5 w-3.5 text-zinc-500 group-hover:text-accent transition-colors" aria-hidden="true" />
                    </div>
                    <p className="mt-1.5 text-ui-dense text-zinc-400">Review lessons learned and recurring patterns identified across your trades.</p>
                </button>
            </div>

            {/* The approvals inbox's standing Always/Never rules: created
                by one click, enforced on every pinned setup — and with this
                card, listable and revocable for the first time. */}
            <AutoJournalRulesCard username={username} />

            {/* Journal Configuration */}
            <SettingsGroup
                title="Summaries"
                description="How the journal writes its own review text."
            >
                <SettingsRow
                    icon={<Activity className="h-4 w-4" aria-hidden="true" />}
                    title="Algorithmic summary"
                    description="Instant calculation from the trade ledger instead of a model call."
                    control={
                        <ToggleSwitch
                            checked={props.useAlgorithmicSummary ?? false}
                            onChange={() => props.onToggleAlgorithmicSummary?.(!props.useAlgorithmicSummary)}
                            label="Toggle algorithmic summary"
                        />
                    }
                />
                <SettingsRow
                    icon={<BrainCircuit className="h-4 w-4" aria-hidden="true" />}
                    title="Algorithmic pattern insights"
                    description="Extract insights with local heuristics alongside AI pattern memory."
                    control={
                        <ToggleSwitch
                            checked={props.useAlgorithmicInsights ?? false}
                            onChange={() => props.onToggleAlgorithmicInsights?.(!props.useAlgorithmicInsights)}
                            label="Toggle algorithmic pattern insights"
                        />
                    }
                />
                {props.onUpdateSummaryCharLimit && (
                    <SettingsRow
                        icon={<FileText className="h-4 w-4" aria-hidden="true" />}
                        title="Summary character limit"
                        description="Maximum length for AI-generated journal review summaries."
                        control={
                            <input
                                type="number"
                                value={props.summaryCharLimit ?? 1000}
                                onChange={e => props.onUpdateSummaryCharLimit?.(Number(e.target.value))}
                                aria-label="Summary character limit"
                                className="w-24 rounded-control border border-hairline bg-zinc-900 px-3 py-1.5 text-right font-mono text-ui-sm text-zinc-200 focus:border-accent focus:outline-none"
                                min={200}
                                max={5000}
                                step={100}
                            />
                        }
                    />
                )}
            </SettingsGroup>
        </div>
    );
};

export default JournalTab;
