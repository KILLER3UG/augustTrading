
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {AlertTriangle, Bookmark, ShieldAlert, X, Zap, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, TrashIcon, StarIcon, LoadingIcon, FileTextIcon} from '../shared/Icons';
import { LoggedTrade, TradeOutcome } from '../../types';

import ImageViewerModal from '../modals/ImageViewerModal';
import { EmptyState } from '../ui/EmptyState';
import StatusPill, { VerdictReviewPill, type PillTone } from '../ui/StatusPill';
import { defaultLeverage } from '../../utils/conversationUtils';
import { captureEfficiencyPct } from '../../utils/disciplineAnalytics';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import SetupLifecycleCard from '../analysis/SetupLifecycleCard';
import MarkdownContent from '../shared/MarkdownContent';
import { phtDayYear } from '../../utils/timezone';

interface TradeLogContentProps {
    trades: LoggedTrade[];
    onDeleteTrades: (ids: string[]) => void;
    onClearAllTrades: () => void;
    modelIdToName: Record<string, string>;
    onUpdateInsights: (ids: string[]) => void;
    isSummarizing?: boolean;
    currentInsightIds: string[];
    onUpdateTradeLeverage: (id: string, leverage: number) => void;
    /** Optional: the classifier labels automatically, and this is the way to
     *  disagree with it. Mounts that don't offer editing simply omit it. */
    onUpdateTradeType?: (id: string, tradeType: 'scalp' | 'swing') => void;
    /** Correct a mis-logged outcome from the expanded card. */
    onUpdateOutcome?: (id: string, outcome: TradeOutcome) => void;
    /** Edit PnL (dollar amount + leveraged percent) from the expanded card. */
    onUpdatePnL?: (id: string, pnl: { pnlAmount?: number; pnlPercent?: number }) => void;
    /** Active user — scopes the reasoning-record lookup per trade. */
    username?: string;
    onDocumentOpenChange?: (open: boolean) => void;
}

const OutcomeBadge: React.FC<{ outcome: TradeOutcome }> = ({ outcome }) => {
    const tone: { [key in TradeOutcome]?: PillTone } = {
        [TradeOutcome.WIN]: 'up',
        [TradeOutcome.LOSS]: 'down',
        [TradeOutcome.PENDING]: 'info',
        [TradeOutcome.ENTRY_NOT_HIT]: 'neutral',
        [TradeOutcome.SKIPPED]: 'neutral',
    };
    const text: { [key in TradeOutcome]?: string } = {
        [TradeOutcome.WIN]: 'WIN',
        [TradeOutcome.LOSS]: 'LOSS',
        [TradeOutcome.PENDING]: 'OPEN',
        [TradeOutcome.ENTRY_NOT_HIT]: 'NO ENTRY',
        [TradeOutcome.SKIPPED]: 'SKIPPED',
    };
    if (!tone[outcome]) return null;
    return <StatusPill tone={tone[outcome]} kicker>{text[outcome]}</StatusPill>;
};

/**
 * Full-screen trade detail — the drill-down destination when a row is
 * clicked (the old inline expansion dropped the content down inside the
 * list, with no way back but re-clicking). Has an explicit Back button that
 * returns to the trade list.
 */
const TradeDetailView: React.FC<{
    trade: LoggedTrade;
    onBack: () => void;
    modelIdToName: Record<string, string>;
    onUpdateLeverage: (id: string, leverage: number) => void;
    onUpdateType?: (id: string, tradeType: 'scalp' | 'swing') => void;
    onUpdateOutcome?: (id: string, outcome: TradeOutcome) => void;
    onUpdatePnL?: (id: string, pnl: { pnlAmount?: number; pnlPercent?: number }) => void;
    username?: string;
}> = ({ trade, onBack, modelIdToName, onUpdateLeverage, onUpdateType, onUpdateOutcome, onUpdatePnL, username }) => {
    const { analysis, outcome, timestamp, postMortem, postMortemCreatedAt, postMortemModel, postMortemImages, correctedEntry, correctedStopLoss, correctedTakeProfit, pnlAmount, pnlPercent, modelsUsed, geminiModelUsed, deepseekModelUsed, zhipuModelUsed, groqModelUsed, groqNewModelUsed, groqAlt2ModelUsed, openrouterModelUsed, moderatorModel, leverage } = trade;
    const { direction, stopLoss, stopLossPercentage, entryPoints, takeProfit, activeStrategies, coinName, invalidationCriteria } = analysis;
    const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
    const [localLeverage, setLocalLeverage] = useState<string>(String(leverage || defaultLeverage()));
    // PnL edit state — autopilot-logged trades only carry a percent, so the
    // dollar figure often needs a manual fill.
    const [pnlDraftAmount, setPnlDraftAmount] = useState<string>(pnlAmount !== undefined ? String(pnlAmount) : '');
    const [pnlDraftPercent, setPnlDraftPercent] = useState<string>(pnlPercent !== undefined ? String(pnlPercent) : '');

    const safeDirection = direction || 'Neutral';
    // Realized share of the best move the tape offered. Null until the outcome
    // was recorded with a measured excursion window.
    const capture = captureEfficiencyPct(trade);

    const handleLeverageBlur = () => {
        let val = parseInt(localLeverage, 10);
        if (isNaN(val)) val = defaultLeverage();
        val = Math.max(1, Math.min(125, val));
        setLocalLeverage(String(val));
        if (val !== leverage) {
            onUpdateLeverage(trade.id, val);
        }
    };

    const handlePresetClick = (e: React.MouseEvent, val: number) => {
        e.stopPropagation();
        setLocalLeverage(String(val));
        onUpdateLeverage(trade.id, val);
    };

    // --- Dynamic Mode Styling ---
    const containerClass = "bg-zinc-900/50 border border-zinc-800";

    return (
        <div className="flex flex-col h-full bg-surface-page">
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="px-8 pt-2 pb-16 w-full max-w-4xl mx-auto">
                    <button
                        onClick={onBack}
                        className="flex items-center gap-1.5 text-ui-base text-zinc-400 hover:text-zinc-100 transition-colors mb-8"
                        aria-label="Back to trade list"
                    >
                        <ChevronLeftIcon className="w-4 h-4" aria-hidden="true" /> Back
                    </button>

                    <h2 className="text-2xl font-semibold text-zinc-100 tracking-tight">{coinName}</h2>
                    <p className="text-ui-base text-zinc-500 mt-2 mb-8">
                        {safeDirection}
                        {' · '}
                        {phtDayYear(timestamp)}
                    </p>

                    <div className="mb-4">
                        <OutcomeBadge outcome={outcome} />
                    </div>

                    <details className="mt-10 group">
                        <summary className="cursor-pointer text-ui-base text-zinc-400 hover:text-zinc-200 list-none flex items-center gap-2">
                            <ChevronDownIcon className="w-4 h-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                            Trade setup
                        </summary>
                        <div className={`mt-6 rounded-bubble overflow-hidden ${containerClass}`}>
                        <div className="px-5 py-6 space-y-5">
                            <SetupLifecycleCard analysis={analysis} outcome={outcome} triggeredEntryIndices={trade.triggeredEntryIndices} compact embedded />
                            <div className="grid grid-cols-2 gap-4 text-ui-base pt-2 font-mono tabular-nums">

                                {/* Trade Settings Row */}
                                <div className="col-span-2 flex items-center justify-between bg-zinc-950 p-3.5 rounded-control border border-zinc-800 mb-1 flex-wrap gap-3">
                                    <span className="text-ui-dense uppercase font-semibold text-zinc-500 tracking-widest">Trade Parameters</span>
                                    <div className="flex items-center gap-2.5 flex-wrap">
                                        <span className="text-ui-sm text-zinc-400">Leverage:</span>
                                        <div className="flex items-center bg-zinc-800 rounded-control border border-zinc-700 px-2.5 py-1">
                                            <input
                                                type="number"
                                                value={localLeverage}
                                                onChange={(e) => setLocalLeverage(e.target.value)}
                                                onBlur={handleLeverageBlur}
                                                onKeyDown={(e) => e.key === 'Enter' && handleLeverageBlur()}
                                                className="w-8 bg-transparent text-center font-mono font-bold text-zinc-200 outline-none text-ui-base"
                                            />
                                            <span className="text-zinc-600 text-ui-sm">x</span>
                                        </div>

                                        <div className="flex gap-1.5 ml-1 pl-3 border-l border-zinc-800">
                                            {[25, 50, 75, 100].map(val => (
                                                <button
                                                    key={val}
                                                    onClick={(e) => handlePresetClick(e, val)}
                                                    className={`text-ui-xs px-2 py-1 rounded-control border transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${parseInt(localLeverage) === val
                                                        ? 'bg-zinc-700 border-zinc-500 text-zinc-100 font-semibold'
                                                        : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300'
                                                        }`}
                                                >
                                                    {val}x
                                                </button>
                                            ))}
                                        </div>

                                        {/* Outcome correction — segmented buttons
                                            (the old <select> dropdown is gone). */}
                                        {onUpdateOutcome && (
                                            <div className="flex items-center gap-1 ml-2 pl-2 border-l border-white/10 flex-wrap">
                                                <span className="text-ui-xs text-zinc-400">Outcome:</span>
                                                {[TradeOutcome.WIN, TradeOutcome.LOSS, TradeOutcome.ENTRY_NOT_HIT, TradeOutcome.SKIPPED].map(o => (
                                                    <button
                                                        key={o}
                                                        onClick={() => onUpdateOutcome(trade.id, o)}
                                                        className={`px-1.5 py-0.5 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${
                                                            trade.outcome === o
                                                                ? o === TradeOutcome.WIN
                                                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                                                    : o === TradeOutcome.LOSS
                                                                        ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                                                                        : 'bg-zinc-700 border-white/20 text-zinc-200'
                                                                : 'bg-zinc-800 border-white/10 text-zinc-500 hover:text-zinc-300'
                                                        }`}
                                                        title={`Set outcome to ${o === TradeOutcome.ENTRY_NOT_HIT ? 'NO ENTRY' : o}`}
                                                    >
                                                        {o === TradeOutcome.ENTRY_NOT_HIT ? 'NO ENTRY' : o}
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* Class correction. Finalization labels every
                                            verdict, so without this the class is
                                            something the trader can filter by but
                                            never disagree with — and the
                                            `tradeTypeManualOverride` flag the detector
                                            honours had no writer. Setting it here is
                                            what makes the label stick: the classifier
                                            skips any trade that already carries one. */}
                                        {onUpdateType && (
                                            <div className="flex items-center gap-1 ml-2 pl-2 border-l border-white/10" data-testid="trade-type-editor">
                                                <span className="text-ui-xs text-zinc-400">Class:</span>
                                                {(['scalp', 'swing'] as const).map(tt => (
                                                    <button
                                                        key={tt}
                                                        type="button"
                                                        aria-pressed={(trade.tradeType || analysis?.tradeType) === tt}
                                                        onClick={() => onUpdateType(trade.id, tt)}
                                                        title={analysis?.tradeTypeManualOverride
                                                            ? 'Manually set — click to change'
                                                            : 'Auto-detected — set it yourself'}
                                                        className={`px-1.5 py-0.5 rounded-control text-ui-2xs font-bold uppercase tracking-wider border transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${
                                                            (trade.tradeType || analysis?.tradeType) === tt
                                                                ? 'bg-zinc-700 border-white/20 text-zinc-100'
                                                                : 'bg-zinc-800 border-white/10 text-zinc-500 hover:text-zinc-300'
                                                        }`}
                                                    >
                                                        {tt === 'scalp' ? '◆ scalp' : '◇ swing'}
                                                    </button>
                                                ))}
                                                {analysis?.tradeTypeManualOverride && (
                                                    <span className="text-ui-2xs uppercase tracking-widest text-zinc-500">manual</span>
                                                )}
                                            </div>
                                        )}

                                        {/* PnL editing — dollar amount + leveraged percent
                                            (autopilot trades only carry the percent). */}
                                        {onUpdatePnL && (
                                            <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-white/10">
                                                <span className="text-ui-xs text-zinc-400">PnL $</span>
                                                <input
                                                    type="number"
                                                    value={pnlDraftAmount}
                                                    onChange={(e) => setPnlDraftAmount(e.target.value)}
                                                    placeholder={pnlAmount !== undefined ? undefined : '—'}
                                                    className="w-20 bg-zinc-800 border border-white/10 rounded-control px-1.5 py-0.5 text-ui-xs font-mono text-zinc-300 outline-none focus:border-cyan-500/40"
                                                    aria-label="PnL in dollars"
                                                />
                                                <span className="text-ui-xs text-zinc-400">%</span>
                                                <input
                                                    type="number"
                                                    value={pnlDraftPercent}
                                                    onChange={(e) => setPnlDraftPercent(e.target.value)}
                                                    placeholder={pnlPercent !== undefined ? undefined : '—'}
                                                    className="w-14 bg-zinc-800 border border-white/10 rounded-control px-1.5 py-0.5 text-ui-xs font-mono text-zinc-300 outline-none focus:border-cyan-500/40"
                                                    aria-label="PnL as leveraged percent"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => onUpdatePnL(trade.id, {
                                                        pnlAmount: pnlDraftAmount.trim() !== '' ? parseFloat(pnlDraftAmount) : undefined,
                                                        pnlPercent: pnlDraftPercent.trim() !== '' ? parseFloat(pnlDraftPercent) : undefined,
                                                    })}
                                                    className="px-2 py-1 rounded-control bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-ui-xs font-semibold uppercase tracking-widest transition-colors"
                                                    title="Save PnL"
                                                >
                                                    Save
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="p-4 bg-zinc-950 rounded-bubble border border-zinc-800">
                                    <span className="text-ui-dense uppercase font-semibold text-zinc-500 block mb-1.5">Entry Zone</span>
                                    <span className="text-cyan-200 font-bold text-ui-base">{(entryPoints || [])[0]?.price || 'N/A'}</span>
                                </div>
                                <div className="p-4 bg-zinc-950 rounded-bubble border border-zinc-800">
                                    <span className="text-ui-dense uppercase font-semibold text-zinc-500 block mb-1.5">Stop Loss</span>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-rose-300 font-bold text-ui-base">{stopLoss}</span>
                                        {stopLossPercentage && <span className="text-rose-500/60 text-ui-2xs">{stopLossPercentage}</span>}
                                    </div>
                                </div>
                                <div className="col-span-2 p-4 bg-zinc-950 rounded-bubble border border-zinc-800">
                                    <span className="text-ui-dense uppercase font-semibold text-zinc-500 block mb-2">Take Profit Targets</span>
                                    <div className="flex flex-wrap gap-2">
                                        {(takeProfit || []).map((tp, i) => (
                                            <div key={i} className="flex items-center gap-1 bg-emerald-900/20 px-2 py-1 rounded-control border border-emerald-500/10">
                                                <span className="text-emerald-300 font-bold">{tp.price}</span>
                                                {tp.percentage && <span className="text-emerald-600 text-ui-2xs">{tp.percentage}</span>}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Execution quality, measured from the candles the
                                    position actually occupied. Rendered only once at
                                    least one side exists, so the (large) population
                                    of pre-feature trades stays clean rather than
                                    showing dashes everywhere. */}
                                {(trade.maxAdverseExcursion !== undefined || trade.maxFavorableExcursion !== undefined) && (
                                    <div className="col-span-2 p-4 bg-zinc-950 rounded-bubble border border-zinc-800" data-testid="trade-excursions">
                                        <span className="text-ui-dense uppercase font-semibold text-zinc-500 block mb-1.5">Held Through</span>
                                        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-ui-base tabular-nums">
                                            <span className="text-zinc-300 tabular-nums">
                                                worst −{trade.maxAdverseExcursion !== undefined ? `${trade.maxAdverseExcursion.toFixed(1)}%` : '—'}
                                                <span className="text-ui-2xs uppercase tracking-wider text-zinc-600"> against</span>
                                            </span>
                                            <span className="text-zinc-300">
                                                best +{trade.maxFavorableExcursion !== undefined ? `${trade.maxFavorableExcursion.toFixed(1)}%` : '—'}
                                                <span className="text-ui-2xs uppercase tracking-wider text-zinc-600"> in favor</span>
                                            </span>
                                            {capture !== null && (
                                                <span className={capture >= 50 ? 'text-emerald-300' : 'text-amber-300'}>
                                                    {capture.toFixed(0)}%
                                                    <span className="text-ui-2xs uppercase tracking-wider text-zinc-600"> captured</span>
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-1 text-ui-2xs text-zinc-600">
                                            Leveraged percents over the candles the position actually occupied.
                                        </p>
                                    </div>
                                )}

                                {invalidationCriteria && invalidationCriteria.length > 0 && (
                                    <div className="col-span-2 p-2.5 bg-rose-950/20 rounded-control border border-rose-500/15 hover:border-rose-500/30 transition-colors">
                                        <span className="text-ui-2xs uppercase font-bold text-rose-400/80 block mb-1">Invalidation Contract</span>
                                        <div className="space-y-1">
                                            {invalidationCriteria.map((c, i) => (
                                                <div key={i} className="text-ui-xs text-rose-100/80 leading-snug">
                                                    <span className="font-mono font-bold text-rose-300">{c.level}</span>
                                                    <span className="text-rose-200/70"> — {c.condition}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {correctedEntry && <div className="col-span-2 bg-amber-500/10 p-2 rounded-control border border-amber-500/20 text-amber-200 font-medium">Corrected Entry: {correctedEntry}</div>}

                                <div className="col-span-2 text-ui-2xs text-zinc-600 pt-3 mt-1 border-t border-white/5 flex justify-between uppercase tracking-wider">
                                    <span>Analyst: {(() => {
                                        const usedEntries = modelsUsed && Object.keys(modelsUsed).length > 0 ? Object.entries(modelsUsed) : [];
                                        if (usedEntries.length > 0) {
                                            return usedEntries.map(([, modelId]) => modelIdToName[modelId] ?? modelId).join(' + ');
                                        }
                                        const legacyModels = [geminiModelUsed, deepseekModelUsed, zhipuModelUsed, groqModelUsed, groqNewModelUsed, groqAlt2ModelUsed, openrouterModelUsed].filter(Boolean) as string[];
                                        if (legacyModels.length > 0) {
                                            return legacyModels.map(m => modelIdToName[m] ?? m).join(' + ');
                                        }
                                        // Legacy provenance, not a current feature: a row with no
                                        // modelsUsed and no legacy per-provider fields was
                                        // answered by the ensemble, and saying so keeps the
                                        // old row readable without pretending the panel
                                        // still exists to pick.
                                        return 'Ensemble (legacy)';
                                    })()}</span>
                                    {moderatorModel && <span>Mod (legacy): {modelIdToName[moderatorModel] || 'AI'}</span>}
                                </div>

                                {/* Pattern-memory gate at analysis time — shows when
                                    memory halted / downsized / warned this trade. */}
                                {trade.patternMemoryGate && trade.patternMemoryGate.gateResult !== 'PASS' && (
                                    <div className={`col-span-2 rounded-control border px-3 py-2 ${trade.patternMemoryGate.gateResult === 'HALT'
                                        ? ' border-rose-500/40 bg-rose-500/10'
                                        : ' border-amber-500/40 bg-amber-500/10'}`}>
                                        <span className={`text-ui-2xs font-black uppercase tracking-widest flex items-center gap-1.5 ${trade.patternMemoryGate.gateResult === 'HALT' ? 'text-rose-400' : 'text-amber-400'}`}>
                                            {trade.patternMemoryGate.gateResult === 'HALT' ? (
                                                <>
                                                    <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                    <span>Memory gate: halted</span>
                                                </>
                                            ) : trade.patternMemoryGate.gateResult === 'REDUCE_SIZE' ? (
                                                <>
                                                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                    <span>Memory gate: reduce size</span>
                                                </>
                                            ) : (
                                                <>
                                                    <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
                                                    <span>Memory gate: warning</span>
                                                </>
                                            )}
                                        </span>
                                        <p className="text-ui-dense text-zinc-400 mt-1 leading-relaxed">{trade.patternMemoryGate.reason}</p>
                                        {trade.patternMemoryGate.historicalFailures.length > 0 && (
                                            <p className="text-ui-xs text-zinc-500 mt-1">
                                                Matched: {trade.patternMemoryGate.historicalFailures.map(f => `${f.outcome ?? ''}${f.coinName ? ` ${f.coinName}` : ''}${f.direction ? ` ${f.direction}` : ''}`).join(' · ')}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* The Model Reasoning panel went with the
                                    debate engine: nothing writes a
                                    ThinkingRecord any more, so it rendered an
                                    empty section on every trade. */}
                            </div>
                        </div>
                        </div>
                    </details>

                    {/* The post-mortem (E-57 §1). In the open, not behind a
                        fold: it is a sentence about a position the trader took,
                        and the app wrote it — so it shows with the outcome, not
                        one click after it. The note's own first line names the
                        app as its author; the field beside it names the model,
                        because a journal the model can write into must never
                        read as the trader's own handwriting. */}
                    {postMortem?.trim() && (
                        <section className="mt-10" data-testid="trade-post-mortem">
                            <h3 className="text-ui-base font-semibold text-zinc-100 tracking-tight">Post-mortem</h3>
                            <p className="text-ui-2xs font-mono uppercase tracking-widest text-zinc-500 mt-1" data-testid="trade-post-mortem-when">
                                {postMortemCreatedAt ? phtDayYear(postMortemCreatedAt) : 'date not recorded'}
                                {postMortemModel ? ` · ${modelIdToName[postMortemModel] ?? postMortemModel}` : ''}
                            </p>
                            <p className="mt-3 text-ui-base leading-relaxed text-zinc-300 whitespace-pre-wrap">{postMortem}</p>
                        </section>
                    )}
                </div>
            </div>

            {/* Image Viewer Modal */}
            <ImageViewerModal
                imageUrl={viewerImageUrl}
                onClose={() => setViewerImageUrl(null)}
            />
        </div>
    );
};

/**
 * Compact list row — clicking it NAVIGATES to the full trade detail screen
 * (with its own Back button) instead of expanding inline.
 * Memoized: the journal can hold hundreds of rows and the list re-renders on
 * every selection/filter change. The open-detail handler takes the id so its
 * identity stays stable across parent renders.
 */
const TradeLogRowImpl: React.FC<{
    trade: LoggedTrade;
    onOpenDetail: (id: string) => void;
    isSelected: boolean;
    onSelect: (id: string) => void;
    isInsight: boolean;
}> = ({ trade, onOpenDetail, isSelected, onSelect, isInsight }) => {
    const { analysis, outcome, timestamp, pnlPercent, pnlAmount } = trade;
    const coinName = analysis?.coinName || 'Unknown';
    const direction = analysis?.direction || 'Neutral';
    // The classifier's output used to exist only as something to filter on — a
    // row never showed which class it belonged to, so the filter's result could
    // not be checked by eye. Same glyph the chips use, one vocabulary.
    const tradeType = trade.tradeType || analysis?.tradeType;
    const rawStrategy = (analysis?.activeStrategies || [])[0] || analysis?.strategy || '';
    const strategy = rawStrategy && !/\*\*|FINAL TRADE PLAN|#\s/.test(rawStrategy)
        ? rawStrategy
        : (analysis?.detectedPatternFamily || '');
    const pnlLabel = pnlAmount !== undefined
        ? `${pnlAmount >= 0 ? '+' : ''}${pnlAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`
        : pnlPercent !== undefined
            ? `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
            : null;
    // Skill vs tide: alpha against holding the benchmark over the same
    // window. Only rendered when the settle actually produced a number.
    const alphaLabel = trade.benchmark && Number.isFinite(trade.benchmark.alphaPct)
        ? `α ${trade.benchmark.alphaPct >= 0 ? '+' : ''}${trade.benchmark.alphaPct.toFixed(1)}%`
        : null;
    // Compact "how much of the move did I keep" tag; only once the outcome was
    // recorded with a measured excursion window.
    const capture = captureEfficiencyPct(trade);
    const capLabel = capture !== null ? `cap ${capture.toFixed(0)}%` : null;

    return (
        <div className={`flex items-center gap-3 px-5 py-5 hover:bg-zinc-800/80 transition-colors ${isSelected ? 'bg-zinc-800' : ''}`}>
            <div onClick={(e) => e.stopPropagation()}>
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onSelect(trade.id)}
                    className="form-checkbox hit-target bg-zinc-950 border-zinc-600 text-zinc-300 rounded-control focus-visible:ring-zinc-500 cursor-pointer"
                />
            </div>
            <button type="button" onClick={() => onOpenDetail(trade.id)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                <FileTextIcon className="w-5 h-5 text-zinc-500 shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-ui-base font-medium text-zinc-100 truncate" title={coinName}>{coinName}</span>
                        <OutcomeBadge outcome={outcome} />
                        {analysis?.verdictReview && (
                            <VerdictReviewPill reason={analysis.verdictReview.reason} />
                        )}
                        {isInsight && <span className="text-ui-xs uppercase tracking-widest text-zinc-500">memory</span>}
                    </div>
                    <p className="text-ui-sm text-zinc-500 mt-1 truncate tabular-nums" title={`${direction}${tradeType ? ` · ${tradeType === 'scalp' ? '◆' : '◇'} ${tradeType}` : ''}${strategy ? ` · ${strategy}` : ''} · ${phtDayYear(timestamp)}${pnlLabel ? ` · ${pnlLabel}` : ''}${alphaLabel ? ` · ${alphaLabel}` : ''}${capLabel ? ` · ${capLabel}` : ''}`}>
                        {direction}{tradeType ? ` · ${tradeType === 'scalp' ? '◆' : '◇'} ${tradeType}` : ''}{strategy ? ` · ${strategy}` : ''} · {phtDayYear(timestamp)}
                        {pnlLabel ? ` · ${pnlLabel}` : ''}
                        {alphaLabel ? ` · ${alphaLabel}` : ''}
                        {capLabel ? ` · ${capLabel}` : ''}
                    </p>
                </div>
                <ChevronRightIcon className="w-4 h-4 text-zinc-600 shrink-0" aria-hidden="true" />
            </button>
        </div>
    );
};

const TradeLogRow = React.memo(TradeLogRowImpl);

const TradeLogContent: React.FC<TradeLogContentProps> = ({
    trades, onDeleteTrades, onClearAllTrades, modelIdToName, onUpdateInsights, isSummarizing, currentInsightIds, onUpdateTradeLeverage, onUpdateTradeType, onUpdateOutcome, onUpdatePnL, username,
    onDocumentOpenChange,
}) => {
    // Drill-down navigation: the trade currently on the full detail screen
    // (null = the list is showing).
    const [detailTradeId, setDetailTradeId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
    const [tradeTypeFilter, setTradeTypeFilter] = useState<'all' | 'scalp' | 'swing'>('all');
    const [outcomeFilter, setOutcomeFilter] = useState<'all' | TradeOutcome>('all');
    // Typed-confirm: the "Clear all" button requires the user to type
    // CLEAR before the modal's confirm button enables. The dialog
    // floats above the trade list at z-100.
    const { confirm: confirmClear, ConfirmDialogComponent: ClearDialog } = useConfirmDialog();
    // Separate dialog instance for the bulk "Delete Selected" gate so the
    // two confirm flows never stomp on each other's pending promise.
    const { confirm: confirmDeleteSelected, ConfirmDialogComponent: DeleteSelectedDialog } = useConfirmDialog();
    const askClearAll = (): void => {
        void confirmClear({
            title: 'Clear all logged trades?',
            message: `This permanently deletes ${trades.length} trade${trades.length === 1 ? '' : 's'}. Pattern memory built from these trades is preserved.`,
            confirmLabel: 'Clear all',
            destructive: true,
            typedConfirm: 'CLEAR',
            typedConfirmHint: 'Type CLEAR to confirm',
        }).then(ok => { if (ok) onClearAllTrades(); });
    };

    const detailTrade = trades.find(t => t.id === detailTradeId);

    useEffect(() => {
        onDocumentOpenChange?.(!!detailTradeId);
        return () => onDocumentOpenChange?.(false);
    }, [detailTradeId, onDocumentOpenChange]);

    const filteredTrades = useMemo(() => (trades || []).filter(trade => {
        if (tradeTypeFilter !== 'all') {
            const tt = trade.tradeType || trade.analysis?.tradeType;
            if (tradeTypeFilter === 'scalp') return tt === 'scalp';
            if (tradeTypeFilter === 'swing') return tt === 'swing' || !tt;
        }
        if (outcomeFilter !== 'all' && trade.outcome !== outcomeFilter) return false;
        return true;
    }), [trades, tradeTypeFilter, outcomeFilter]);

    /** How many rows carry a scalp/swing label at all. The filter reads a field
     *  the pipeline never writes automatically, so an empty Scalp list almost
     *  always means "nothing has been classified", not "you made no scalps" —
     *  and those two need different sentences. The desk tools already follow
     *  this rule for a failed fetch: an unavailable measurement must never read
     *  as an absence of evidence. */
    const classifiedCount = useMemo(() => (trades || []).reduce(
        (n, trade) => n + ((trade.tradeType || trade.analysis?.tradeType) ? 1 : 0),
        0,
    ), [trades]);

    const handleSelect = useCallback((id: string) => {
        setSelectedIds(prev =>
            prev.includes(id) ? prev.filter(tradeId => tradeId !== id) : [...prev, id]
        );
    }, []);

    // Stable detail-open handler for the memoized row — an inline arrow per
    // row would rebuild on every render and defeat React.memo.
    // Both callbacks sit ABOVE every conditional return: they used to live
    // below them, which crashed row-click with "Rendered fewer hooks than
    // expected" (a trade detail render has 2 fewer hooks than the list).
    const openDetailForTrade = useCallback((id: string) => setDetailTradeId(id), []);

    // Full-screen trade detail (Back button returns to the list).
    // Must sit AFTER every hook — opening a trade used to return here before
    // filter state, which crashed with "Rendered fewer hooks than expected".
    if (detailTrade) {
        return (
            <TradeDetailView
                trade={detailTrade}
                onBack={() => setDetailTradeId(null)}
                modelIdToName={modelIdToName}
                onUpdateLeverage={onUpdateTradeLeverage}
                onUpdateType={onUpdateTradeType}
                onUpdateOutcome={onUpdateOutcome}
                onUpdatePnL={onUpdatePnL}
                username={username}
            />
        );
    }

    const handleSelectActiveInsights = () => {
        const validIds = currentInsightIds.filter(id => trades.some(t => t.id === id));
        setSelectedIds(validIds);
    };

    // Bulk delete cascades to reasoning records + autopilot watchers and has
    // no undo system — gate it behind the same in-app dialog pattern used by
    // "Clear all" (plain confirm; the typed-CLEAR requirement stays reserved
    // for the wipe-everything action).
    const handleDeleteSelected = (): void => {
        if (selectedIds.length === 0) return;
        const count = selectedIds.length;
        void confirmDeleteSelected({
            title: `Delete ${count} selected trade${count === 1 ? '' : 's'}?`,
            message: 'This permanently deletes the selected trades, including their reasoning records and autopilot watches. This cannot be undone.',
            confirmLabel: 'Delete',
            destructive: true,
        }).then(ok => {
            if (!ok) return;
            onDeleteTrades(selectedIds);
            setSelectedIds([]);
        });
    };

    const handleUpdateInsights = () => {
        if (selectedIds.length > 0) {
            onUpdateInsights(selectedIds);
        }
    };

    const duplicateCount = selectedIds.filter(id => currentInsightIds.includes(id)).length;
    const newCount = selectedIds.length - duplicateCount;

    const totalTrades = filteredTrades.length;

    return (
        <div className="flex flex-col h-full bg-transparent w-full max-w-4xl mx-auto">
            {/* Filters: trade type + outcome */}
            <div className="px-8 pt-2 pb-6 shrink-0 space-y-5">
                <div className="flex items-center gap-2 flex-wrap">
                    {(['all', 'scalp', 'swing'] as const).map(type => (
                        <button
                            key={type}
                            onClick={() => setTradeTypeFilter(type)}
                            aria-pressed={tradeTypeFilter === type}
                            className={`px-3 py-1.5 text-ui-sm font-medium rounded-full transition-colors ${
                                tradeTypeFilter === type
                                    ? 'bg-zinc-800 text-zinc-100'
                                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'}`}
                        >
                            {type === 'scalp' ? '◆ ' : type === 'swing' ? '◇ ' : ''}{type}
                        </button>
                    ))}
                    <span className="w-px h-4 bg-white/10 mx-1" />
                    {[TradeOutcome.WIN, TradeOutcome.LOSS, TradeOutcome.PENDING, TradeOutcome.ENTRY_NOT_HIT, TradeOutcome.SKIPPED].map(o => (
                        <button
                            key={o}
                            onClick={() => setOutcomeFilter(prev => prev === o ? 'all' : o)}
                            className={`px-3 py-1.5 text-ui-sm font-medium rounded-full transition-colors ${
                                outcomeFilter === o
                                    ? 'bg-zinc-800 text-zinc-100'
                                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                            }`}
                        >
                            {o === TradeOutcome.ENTRY_NOT_HIT ? 'NO ENTRY' : o === TradeOutcome.PENDING ? 'OPEN' : o}
                        </button>
                    ))}
                    {outcomeFilter !== 'all' && (
                        <button
                            onClick={() => setOutcomeFilter('all')}
                            className="p-1 text-zinc-500 hover:text-zinc-300 rounded-control hover:bg-zinc-800 transition-colors"
                            aria-label="Clear outcome filter"
                        >
                            <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>

            {trades.length > 0 && (
                <div className="px-8 pb-3 shrink-0 flex items-center justify-end">
                    <button
                        type="button"
                        onClick={askClearAll}
                        className="hit-target text-ui-sm text-zinc-500 hover:text-rose-400 transition-colors"
                        title="Delete all logged trades (typed confirm)"
                    >
                        Clear all
                    </button>
                </div>
            )}

            {currentInsightIds.length > 0 && (
                <div className="px-8 pb-4 shrink-0">
                    <button onClick={handleSelectActiveInsights} className="text-ui-sm text-zinc-400 hover:text-zinc-200 transition-colors">
                        Select {currentInsightIds.length} memory trades
                    </button>
                </div>
            )}

            {/* Selected Actions */}
            {selectedIds.length > 0 && (
                <div className="p-4 border-b border-zinc-800 bg-zinc-900/50 shrink-0 animate-fade-in">
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={handleUpdateInsights}
                            disabled={isSummarizing || newCount === 0}
                            className={`w-full flex items-center justify-center gap-2 font-semibold py-3 px-4 rounded-control transition-colors duration-[150ms] ease-[var(--ease-snappy)] uppercase text-ui-sm tracking-widest disabled:opacity-50 disabled:cursor-not-allowed ${duplicateCount > 0 && newCount === 0
                                ? 'bg-zinc-800 border border-zinc-700 text-zinc-500'
                                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-600'
                                }`}
                        >
                            {isSummarizing ? <LoadingIcon className="w-4 h-4" aria-hidden="true" /> : <StarIcon className="w-4 h-4" aria-hidden="true" />}
                            {isSummarizing ? 'Synthesizing...' :
                                duplicateCount > 0
                                    ? `Add ${newCount} New (${duplicateCount} Duplicates)`
                                    : `Set as Recent Insights (${selectedIds.length})`
                            }
                        </button>
                        {duplicateCount > 0 && (
                            <div className="text-ui-xs text-center text-amber-400/80 uppercase font-bold tracking-wider animate-pulse">
                                {duplicateCount === selectedIds.length
                                    ? 'All selected trades are already in Recent Insights'
                                    : `${duplicateCount} duplicate(s) will be skipped`
                                }
                            </div>
                        )}
                        <button onClick={handleDeleteSelected} disabled={isSummarizing} className=" w-full flex items-center justify-center gap-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 font-semibold py-3 px-4 rounded-control transition-colors duration-[150ms] ease-[var(--ease-snappy)] uppercase text-ui-sm tracking-widest disabled:opacity-50">
                            <TrashIcon /> Delete Selected ({selectedIds.length})
                        </button>
                    </div>
                </div>
            )}

            {/* Trade List - Virtualized */}
            <div className="flex-1 overflow-hidden px-8 pb-8">
                {totalTrades === 0 && trades.length === 0 ? (
                    <div className="h-full rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        <EmptyState
                            icon={<Bookmark className="w-8 h-8" aria-hidden="true" />}
                            title="No trades logged yet"
                            description="Run an analysis and log your first trade to start building your journal."
                            className="flex-1"
                        />
                    </div>
                ) : totalTrades === 0 && tradeTypeFilter !== 'all' && classifiedCount === 0 ? (
                    <EmptyState
                        icon={<Bookmark className="w-8 h-8" aria-hidden="true" />}
                        title="Nothing is classified yet"
                        description={`None of the ${trades.length} logged ${trades.length === 1 ? 'trade has' : 'trades have'} a scalp/swing label. Verdicts are classified when they finalize, so these predate that — an empty list here says nothing about how you traded.`}
                        action={
                            <button
                                type="button"
                                data-testid="journal-clear-type-filter"
                                onClick={() => setTradeTypeFilter('all')}
                                className="px-3 py-1.5 text-ui-sm font-medium rounded-full bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors"
                            >
                                Show all trades
                            </button>
                        }
                        className="h-full"
                    />
                ) : totalTrades === 0 ? (
                    <EmptyState
                        icon={<Bookmark className="w-8 h-8" aria-hidden="true" />}
                        title="No matching trades"
                        description="Nothing matches the current filters."
                        className="h-full"
                    />
                ) : (
                    <div className="h-full rounded-bubble border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col">
                        <Virtuoso
                            style={{ height: '100%' }}
                            data={filteredTrades}
                            itemContent={(_index, trade) => (
                                <div className="border-b border-zinc-800 last:border-b-0">
                                    <TradeLogRow
                                        trade={trade}
                                        onOpenDetail={openDetailForTrade}
                                        isSelected={selectedIds.includes(trade.id)}
                                        onSelect={handleSelect}
                                        isInsight={currentInsightIds.includes(trade.id)}
                                    />
                                </div>
                            )}
                        />
                    </div>
                )}
            </div>

            {/* Image Viewer Modal */}
            <ImageViewerModal
                imageUrl={viewerImageUrl}
                onClose={() => setViewerImageUrl(null)}
            />
            {ClearDialog}
            {DeleteSelectedDialog}
        </div>
    );
};

export default React.memo(TradeLogContent);
