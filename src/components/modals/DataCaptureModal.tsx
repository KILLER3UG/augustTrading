
import React, { useState } from 'react';
import { CheckSquare, Clock, Square, TrendingDown, TrendingUp } from '../shared/Icons';
import { Message, TradeOutcome } from '../../types';
import { CaptureJournalTags } from '../../types/trade';
import { loadChecklistConfig, summarizeChecklist } from '../../utils/checklist';

import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface DataCaptureModalProps {
    message: Message;
    outcome: TradeOutcome;
    onClose: () => void;
    onAutoCapture: (feedback: { pnlAmount: number; correctedStopLoss?: string; correctedTakeProfit?: string; selectedEntryIndices?: number[]; journalTags?: CaptureJournalTags; }) => void;
    onSkip: (feedback: { pnlAmount: number; correctedStopLoss?: string; correctedTakeProfit?: string; selectedEntryIndices?: number[]; journalTags?: CaptureJournalTags; }) => void;
    isCapturing?: boolean;
}

export const DataCaptureModal: React.FC<DataCaptureModalProps> = ({
    message,
    outcome,
    onClose,
    onAutoCapture,
    onSkip,
    isCapturing = false
}) => {
    useEscapeClose(true, onClose);
    const dialogRef = useFocusTrap<HTMLDivElement>(true);

    const coinName = message.analysis?.coinName || 'this trade';
    const [pnl, setPnl] = useState('');
    const [correctedValue, setCorrectedValue] = useState('');
    const [isAdvanced, setIsAdvanced] = useState(false);

    // Discipline quick-tags (Batch 5): optional, ≤3 taps, monochrome chips.
    // The mistake-cost and adherence analytics build themselves from these.
    const checklistCfg = React.useMemo(() => loadChecklistConfig(), []);
    const [checklistChecked, setChecklistChecked] = useState<Set<string>>(new Set());
    // "Watched, chose not to" free-text on the skip path.
    const [skipNote, setSkipNote] = useState('');
    const toggleChecklistItem = (id: string): void =>
        setChecklistChecked(cur => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    const MISTAKE_TAGS: { id: NonNullable<CaptureJournalTags['mistakeTags']>[number]; label: string }[] = [
        { id: 'failed_thesis', label: 'Thesis failed' },
        { id: 'boredom', label: 'Boredom' },
        { id: 'overtrading', label: 'Overtrading' },
        { id: 'greed', label: 'Greed' },
        { id: 'revenge', label: 'Revenge' },
        { id: 'moved_stop', label: 'Moved stop' },
        { id: 'early_entry', label: 'Early entry' },
        { id: 'late_exit', label: 'Late exit' },
    ];
    const EMOTIONAL_STATES: NonNullable<CaptureJournalTags['emotionalState']>[] = ['calm', 'confident', 'anxious', 'frustrated', 'tilted', 'fomo'];
    const [mistakeTags, setMistakeTags] = useState<string[]>([]);
    const [emotionalState, setEmotionalState] = useState<NonNullable<CaptureJournalTags['emotionalState']> | null>(null);
    const [followedPlan, setFollowedPlan] = useState<boolean | null>(null);

    const toggleMistakeTag = (id: string): void => {
        setMistakeTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
    };

    // Entry selection state - for trades with multiple entry points
    const entryPoints = message.analysis?.entryPoints || [];
    const hasMultipleEntries = entryPoints.length > 1;
    // Default: all entries selected
    const [selectedEntryIndices, setSelectedEntryIndices] = useState<number[]>(
        entryPoints.map((_, idx) => idx)
    );

    const outcomeColors = {
        [TradeOutcome.WIN]: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', glow: 'shadow-emerald-500/20' },
        [TradeOutcome.LOSS]: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-400', glow: 'shadow-rose-500/20' },
        [TradeOutcome.ENTRY_NOT_HIT]: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400', glow: 'shadow-amber-500/20' },
        [TradeOutcome.SKIPPED]: { bg: 'bg-zinc-500/10', border: 'border-zinc-500/30', text: 'text-zinc-400', glow: 'shadow-zinc-500/20' },
        [TradeOutcome.PENDING]: { bg: 'bg-zinc-500/10', border: 'border-zinc-500/30', text: 'text-zinc-400', glow: 'shadow-zinc-500/20' },
    };

    const colors = outcomeColors[outcome] || outcomeColors[TradeOutcome.PENDING];

    const isWin = outcome === TradeOutcome.WIN;

    const content = isWin ? {
        title: 'Log Trade Win',
        pnlLabel: 'Profit Amount ($)',
        advancedToggle: 'Provide Final Take Profit',
        advancedLabel: 'Final Take Profit Price',
        advancedPlaceholder: 'e.g., 4987.0',
        advancedHelp: 'This helps the AI learn if it was too conservative.'
    } : {
        title: 'Log Trade Loss',
        pnlLabel: 'Loss Amount ($)',
        advancedToggle: 'Provide Corrected Stop Loss',
        advancedLabel: 'Corrected Stop Loss Price',
        advancedPlaceholder: 'e.g., 4123.5',
        advancedHelp: 'This helps the AI understand why the original stop loss failed.'
    };

    // Parse and validate P/L
    const pnlNum = parseFloat(pnl);
    const isPnlValid = !isNaN(pnlNum) && pnlNum >= 0 && pnl.trim() !== '';

    // Build feedback object
    const buildFeedback = (skipReason?: string) => {
        const finalPnl = isWin ? Math.abs(pnlNum) : -Math.abs(pnlNum);
        const journalTags: CaptureJournalTags = {
            ...(mistakeTags.length > 0 ? { mistakeTags: mistakeTags as CaptureJournalTags['mistakeTags'] } : {}),
            ...(emotionalState ? { emotionalState } : {}),
            ...(followedPlan !== null ? { followedPlan } : {}),
            // Checklist completion rides the tags only when the checklist is
            // Enabled AND the user actually engaged it (plan, off by
            // default — untouched trades stay unrecorded, never {0,n}).
            ...(checklistCfg.enabled && checklistChecked.size > 0
                ? { checklistCompleted: summarizeChecklist(checklistCfg.items, checklistChecked) }
                : {}),
            // Passes become data: the skip path carries the
            // "watched, chose not to" reason onto the logged trade.
            ...(skipReason && skipReason.trim() ? { skipReason: skipReason.trim() } : {}),
        };
        return {
            pnlAmount: finalPnl,
            correctedStopLoss: !isWin && isAdvanced ? correctedValue : undefined,
            correctedTakeProfit: isWin && isAdvanced ? correctedValue : undefined,
            // Include selected entries if multiple entries exist
            selectedEntryIndices: hasMultipleEntries ? selectedEntryIndices : undefined,
            journalTags: Object.keys(journalTags).length > 0 ? journalTags : undefined,
        };
    };

    const handleAutoCapture = () => {
        if (isPnlValid) {
            onAutoCapture(buildFeedback());
        }
    };

    const handleSkip = () => {
        if (isPnlValid) {
            onSkip(buildFeedback());
        }
    };

    return (
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Capture trade data" className=" fixed inset-0 bg-black/70 z-modal flex items-center justify-center p-4 outline-none">
            <div className={`bg-zinc-900 rounded-bubble shadow-elevated w-full max-w-lg border ${colors.border} animate-fade-in`}>
                {/* Header */}
                <div className={`p-5 border-b border-hairline ${colors.bg}`}>
                    <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-control border ${colors.border} ${colors.bg}`}>
                            {isWin ? (
                                <TrendingUp className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                            ) : outcome === TradeOutcome.ENTRY_NOT_HIT ? (
                                <Clock className="h-5 w-5 text-amber-400" aria-hidden="true" />
                            ) : (
                                <TrendingDown className="h-5 w-5 text-rose-400" aria-hidden="true" />
                            )}
                        </div>
                        <div>
                            <h3 className={`text-ui-lg font-bold ${colors.text}`}>
                                {content.title}
                            </h3>
                            <p className="text-ui-sm text-zinc-400 mt-0.5 font-mono">
                                <span className="text-white font-semibold">{coinName}</span>
                            </p>
                        </div>
                    </div>
                </div>

                {/* P/L Input Section */}
                <div className="p-5 border-b border-hairline">
                    <div className="space-y-4">
                        {/* Main P/L Input */}
                        <div>
                            <label htmlFor="pnl-amount" className="block text-ui-base font-medium text-zinc-300 mb-2">
                                {content.pnlLabel} <span className="text-rose-400">*</span>
                            </label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 font-mono">$</span>
                                <input
                                    type="number"
                                    id="pnl-amount"
                                    value={pnl}
                                    onChange={e => setPnl(e.target.value)}
                                    placeholder="250"
                                    className="w-full bg-zinc-800 border border-hairline rounded-control pl-8 pr-4 py-3 text-white font-mono text-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus:border-accent/50 transition-colors duration-[150ms] ease-[var(--ease-snappy)]"
                                    autoFocus
                                />
                            </div>
                            {pnl && !isPnlValid && (
                                <p className="mt-1.5 text-ui-sm text-rose-400">Please enter a valid positive number</p>
                            )}
                        </div>

                        {/* Entry Point Selector - shown when multiple entries exist */}
                        {hasMultipleEntries && (
                            <div className="pt-3 border-t border-hairline">
                                <label className="block text-ui-base font-medium text-zinc-300 mb-2">
                                     Which entry was triggered?
                                </label>
                                <div className="space-y-2 pl-1">
                                    {entryPoints.map((entry, idx) => (
                                        <label key={idx} className="flex items-center cursor-pointer group">
                                            <input
                                                type="checkbox"
                                                checked={selectedEntryIndices.includes(idx)}
                                                onChange={() => {
                                                    if (selectedEntryIndices.includes(idx)) {
                                                        // Don't allow deselecting all entries
                                                        if (selectedEntryIndices.length > 1) {
                                                            setSelectedEntryIndices(prev => prev.filter(i => i !== idx));
                                                        }
                                                    } else {
                                                        setSelectedEntryIndices(prev => [...prev, idx]);
                                                    }
                                                }}
                                                className="h-4 w-4 rounded-control border-zinc-600 bg-zinc-700 text-accent focus-visible:ring-accent"
                                            />
                                            <span className="ml-3 text-ui-base font-medium text-zinc-400 group-hover:text-zinc-300 transition-colors">
                                                <span className="text-zinc-500">Entry {idx + 1}:</span>{' '}
                                                <span className="font-mono text-white">${entry.price}</span>
                                                {entry.description && (
                                                    <span className="text-zinc-500 text-ui-sm ml-2">({entry.description})</span>
                                                )}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                                <p className="mt-2 text-ui-sm text-zinc-500">
                                    Select which entry price(s) were filled. This helps with accurate backtesting.
                                </p>
                            </div>
                        )}

                        {/* Advanced Toggle */}
                        <div className="pt-2">
                            <label className="flex items-center cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={isAdvanced}
                                    onChange={() => setIsAdvanced(!isAdvanced)}
                                    className="h-4 w-4 rounded-control border-zinc-600 bg-zinc-700 text-accent focus-visible:ring-accent"
                                />
                                <span className="ml-3 text-ui-base font-medium text-zinc-400 group-hover:text-zinc-300 transition-colors">
                                    {content.advancedToggle}
                                </span>
                            </label>
                        </div>

                        {/* Advanced Input */}
                        {isAdvanced && (
                            <div className="animate-fade-in pl-7">
                                <label htmlFor="corrected-value" className="block text-ui-base font-medium text-zinc-400 mb-1.5">
                                    {content.advancedLabel}
                                </label>
                                <input
                                    type="text"
                                    id="corrected-value"
                                    value={correctedValue}
                                    onChange={e => setCorrectedValue(e.target.value)}
                                    placeholder={content.advancedPlaceholder}
                                    className="w-full bg-zinc-800 border border-hairline rounded-control px-3 py-2 text-white text-ui-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                                />
                                <p className="mt-1.5 text-ui-sm text-zinc-500">{content.advancedHelp}</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Data Capture Options - only enabled when P/L is valid */}
                <div className={`p-5 space-y-3 ${!isPnlValid ? 'opacity-50 pointer-events-none' : ''}`}>
                    <p className="text-ui-sm text-zinc-500 uppercase tracking-widest font-bold mb-3">
                        Choose how to capture trade data
                    </p>

                    {/* Auto-Capture Option */}
                    <button
                        onClick={handleAutoCapture}
                        disabled={isCapturing || !isPnlValid}
                        className="w-full p-4 rounded-bubble border border-cyan-500/20 bg-cyan-950/30 hover:bg-cyan-950/50 hover:border-cyan-500/40 transition-colors duration-[150ms] ease-[var(--ease-snappy)] text-left group disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden"
                    >
                        {isCapturing && (
                            <div className="absolute inset-0 bg-cyan-500/10 animate-pulse" />
                        )}
                        <div className="flex items-start gap-4 relative z-10">
                            <div className="text-3xl">{isCapturing ? '⏳' : ''}</div>
                            <div className="flex-1">
                                <div className="font-bold text-cyan-300 group-hover:text-cyan-200 transition-colors flex items-center gap-2">
                                    {isCapturing ? 'Capturing...' : 'Auto-Capture & Log'}
                                    {!isCapturing && (
                                        <span className="text-ui-2xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded-control uppercase tracking-wider font-bold">
                                            Recommended
                                        </span>
                                    )}
                                </div>
                                <div className="text-ui-sm text-zinc-400 mt-1 leading-relaxed">
                                    {isCapturing
                                        ? 'Fetching market data from Binance...'
                                        : 'Instantly fetch current market data. Trade will be logged after capture completes.'
                                    }
                                </div>
                            </div>
                        </div>
                    </button>

                    {/* Skip Option */}
                    <button
                        onClick={handleSkip}
                        disabled={isCapturing || !isPnlValid}
                        className="w-full p-3 rounded-control border border-hairline bg-zinc-800 hover:bg-zinc-800 hover:border-line transition-colors duration-[150ms] ease-[var(--ease-snappy)] text-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <span className="text-ui-base text-zinc-500 hover:text-zinc-400 transition-colors">
                            Log without data capture →
                        </span>
                    </button>

                    {/* Discipline quick-tags (Batch 5): optional — everything
                        here feeds the adherence/mistake-cost analytics. */}
                    <div className="rounded-control border border-hairline bg-zinc-900/60 px-3 py-2.5">
                        <div className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500 mb-1.5">Tags (optional)</div>
                        <div className="flex flex-wrap gap-1.5">
                            {MISTAKE_TAGS.map(t => (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => toggleMistakeTag(t.id)}
                                    className={`rounded-control border px-2 py-0.5 text-ui-xs font-medium transition-colors ${
                                        mistakeTags.includes(t.id)
                                            ? 'border-line bg-zinc-700 text-zinc-100'
                                            : 'border-hairline bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                    }`}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                        <div className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500 mt-2 mb-1.5">State at entry</div>
                        <div className="flex flex-wrap gap-1.5">
                            {EMOTIONAL_STATES.map(s => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => setEmotionalState(cur => cur === s ? null : s)}
                                    className={`rounded-control border px-2 py-0.5 text-ui-xs font-medium capitalize transition-colors ${
                                        emotionalState === s
                                            ? 'border-line bg-zinc-700 text-zinc-100'
                                            : 'border-hairline bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                    }`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                        <div className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500 mt-2 mb-1.5">Followed the plan?</div>
                        <div className="flex flex-wrap gap-1.5">
                            {[true, false].map(v => (
                                <button
                                    key={String(v)}
                                    type="button"
                                    onClick={() => setFollowedPlan(cur => cur === v ? null : v)}
                                    className={`rounded-control border px-2 py-0.5 text-ui-xs font-medium transition-colors ${
                                        followedPlan === v
                                            ? 'border-line bg-zinc-700 text-zinc-100'
                                            : 'border-hairline bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                    }`}
                                >
                                    {v ? 'Yes' : 'No'}
                                </button>
                            ))}
                        </div>
                        {/* Pre-trade checklist — only rendered when
                            enabled in Settings; completion rides onto the trade. */}
                        {checklistCfg.enabled && (
                            <>
                                <div className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500 mt-2 mb-1.5">
                                    Checklist ({checklistChecked.size}/{checklistCfg.items.length})
                                </div>
                                <div className="flex flex-col gap-1">
                                    {checklistCfg.items.map(item => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => toggleChecklistItem(item.id)}
                                            className={`flex items-center gap-2 rounded-control border px-2 py-1 text-left text-ui-xs font-medium transition-colors ${
                                                checklistChecked.has(item.id)
                                                    ? 'border-line bg-zinc-700 text-zinc-100'
                                                    : 'border-hairline bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                                            }`}
                                        >
                                            <span aria-hidden className="flex items-center">
                                                {checklistChecked.has(item.id) ? <CheckSquare className="h-3.5 w-3.5 text-cyan-400 shrink-0" aria-hidden="true" /> : <Square className="h-3.5 w-3.5 text-zinc-500 shrink-0" aria-hidden="true" />}
                                            </span>
                                            {item.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-hairline bg-zinc-950">
                    <div className="flex items-center justify-between">
                        <p className="text-ui-xs text-zinc-600 max-w-[200px]">
                            Trade will only be finalized after you confirm the capture method
                        </p>
                        <button
                            onClick={onClose}
                            disabled={isCapturing}
                            className="py-2 px-4 rounded-control text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors text-ui-base disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DataCaptureModal;
