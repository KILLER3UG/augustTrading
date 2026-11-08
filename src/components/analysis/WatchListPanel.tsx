import React, { useMemo, useState } from 'react';
import { TradeOutcome } from '../../types';
import { CloseIcon, PinIcon } from '../shared/Icons';
import { AutopilotResolution } from '../../services/ui/OutcomeAutopilotService';
import { PriceAlertService } from '../../services/ui/PriceAlertService';
import { signalDirectionLabel } from '../../utils/analysisUtils';
import { describeOpenBookRisk, paperPnlR } from '../../utils/paperPnl';
import { WatchedSignal } from '../../utils/watchList';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface WatchListPanelProps {
    isVisible: boolean;
    onClose: () => void;
    signals: WatchedSignal[];
    activeConversationId: string | null;
    autopilotResolutions?: Record<string, AutopilotResolution>;
    onToggleWatch: (messageId: string, conversationId: string) => void;
    onLogTrade: (messageId: string, outcome: TradeOutcome.WIN | TradeOutcome.LOSS, conversationId: string) => void;
    onOpenSignal: (conversationId: string, messageId: string) => void;
    onConfirmAutopilot?: (messageId: string, conversationId: string) => void;
}

type Filter = 'open' | 'closed' | 'all';

const isOpen = (outcome?: TradeOutcome): boolean =>
    !outcome || outcome === TradeOutcome.PENDING;

const WatchListPanel: React.FC<WatchListPanelProps> = ({
    isVisible,
    onClose,
    signals,
    activeConversationId,
    autopilotResolutions = {},
    onToggleWatch,
    onLogTrade,
    onOpenSignal,
    onConfirmAutopilot,
}) => {
    const [filter, setFilter] = useState<Filter>('open');
    useEscapeClose(isVisible, onClose);
    const dialogRef = useFocusTrap<HTMLDivElement>(isVisible);
    const visible = useMemo(() => {
        if (filter === 'all') return signals;
        if (filter === 'open') return signals.filter(s => isOpen(s.outcome));
        return signals.filter(s => !isOpen(s.outcome));
    }, [filter, signals]);
    const openCount = signals.filter(s => isOpen(s.outcome)).length;
    const bookRisk = useMemo(() => describeOpenBookRisk(signals), [signals]);

    if (!isVisible) return null;

    return (
        <div className="fixed inset-0 z-modal flex items-end justify-end bg-black/50 sm:items-stretch" role="dialog" aria-label="Pinned signals">
            <button type="button" className="absolute inset-0 cursor-default" aria-label="Close pinned signals overlay" onClick={onClose} />
            <div ref={dialogRef} className="relative flex h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-hairline bg-zinc-950 shadow-2xl sm:h-full sm:rounded-none sm:border-l sm:border-t-0 sm:border-b-0">
                <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
                    <PinIcon className="h-4 w-4 text-zinc-300" aria-hidden="true" />
                    <h2 className="text-ui-base font-semibold text-zinc-100">Pinned signals</h2>
                    <span className="text-ui-dense text-zinc-500">{openCount} open</span>
                    <button type="button" onClick={onClose} className="ml-auto rounded-control p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close pinned signals">
                        <CloseIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="flex gap-1 border-b border-hairline px-4 py-2">
                    {(['open', 'closed', 'all'] as const).map(id => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setFilter(id)}
                            className={`rounded-control px-2 py-1 text-ui-dense capitalize ${filter === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            {id}
                        </button>
                    ))}
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
                    {bookRisk && (
                        <p className="rounded-control border border-hairline bg-zinc-900 px-3 py-2 text-ui-dense leading-relaxed text-zinc-400">{bookRisk}</p>
                    )}
                    {visible.length === 0 ? (
                        <p className="px-2 py-8 text-center text-ui-caption text-zinc-500">
                            {filter === 'open'
                                ? 'Nothing pinned yet. Hover a settled verdict in Chart AI and tap Pin.'
                                : 'Nothing in this filter.'}
                        </p>
                    ) : visible.map(signal => {
                        const analysis = signal.analysis;
                        const dir = signalDirectionLabel(analysis.direction, analysis.confidence);
                        const pending = isOpen(signal.outcome);
                        const inThisChat = signal.conversationId === activeConversationId;
                        const resolution = autopilotResolutions[signal.messageId];
                        const symbol = (analysis.coinName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                        const priced = symbol ? PriceAlertService.getCurrentPrice(symbol.includes('USDT') ? symbol : `${symbol}USDT`) : undefined;
                        const paper = paperPnlR(analysis, priced);
                        return (
                            <div key={signal.messageId} className=" rounded-bubble border border-hairline bg-zinc-900/60 p-3">
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <span className="text-ui-sm font-semibold text-zinc-100">{analysis.coinName || 'Setup'}</span>
                                    <span className="text-ui-dense font-medium text-zinc-300">{dir}</span>
                                    <span className="text-ui-xs text-zinc-600">{signal.conversationTitle}</span>
                                    {!pending && (
                                        <span className="ml-auto text-ui-xs font-semibold uppercase tracking-widest text-zinc-400">{signal.outcome}</span>
                                    )}
                                    {pending && paper && (
                                        <span className="ml-auto text-ui-dense tabular-nums text-zinc-400">{paper.line}</span>
                                    )}
                                </div>
                                <div className="mt-2 grid grid-cols-3 gap-2 text-ui-dense tabular-nums">
                                    <div>
                                        <div className="text-ui-xs uppercase tracking-widest text-zinc-600">Entry</div>
                                        <div className="text-zinc-200">{analysis.entryPoints?.[0]?.price || '—'}</div>
                                    </div>
                                    <div>
                                        <div className="text-ui-xs uppercase tracking-widest text-zinc-600">SL</div>
                                        <div className="text-rose-400">{analysis.stopLoss || '—'}</div>
                                    </div>
                                    <div>
                                        <div className="text-ui-xs uppercase tracking-widest text-zinc-600">TP1</div>
                                        <div className="text-emerald-400">{analysis.takeProfit?.[0]?.price || '—'}</div>
                                    </div>
                                </div>
                                {resolution && pending && (
                                    <p className="mt-2 text-ui-dense text-cyan-300">Autopilot: {resolution.detail}</p>
                                )}
                                {signal.watchEpisodes && signal.watchEpisodes.length > 0 && (
                                    <ol className="mt-2 space-y-1 border-t border-hairline pt-2">
                                        {signal.watchEpisodes.slice(-6).map((ep, i) => (
                                            <li key={`${ep.at}-${i}`} className="text-ui-xs leading-4 text-zinc-500">
                                                <span className="font-semibold uppercase tracking-widest text-zinc-600">{ep.kind}</span>
                                                {' · '}{ep.detail}
                                            </li>
                                        ))}
                                    </ol>
                                )}
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                    {pending && !resolution && (
                                        <>
                                            <button type="button" onClick={() => onLogTrade(signal.messageId, TradeOutcome.WIN, signal.conversationId)} className="rounded-control border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-ui-dense font-semibold text-emerald-300">Win</button>
                                            <button type="button" onClick={() => onLogTrade(signal.messageId, TradeOutcome.LOSS, signal.conversationId)} className="rounded-control border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-ui-dense font-semibold text-rose-300">Loss</button>
                                        </>
                                    )}
                                    {pending && resolution && onConfirmAutopilot && (
                                        <button type="button" onClick={() => onConfirmAutopilot(signal.messageId, signal.conversationId)} className="rounded-control border border-accent/40 bg-accent/15 px-2.5 py-1 text-ui-dense font-semibold text-accent">Confirm autopilot</button>
                                    )}
                                    <button type="button" onClick={() => onOpenSignal(signal.conversationId, signal.messageId)} className="rounded-control border border-hairline px-2.5 py-1 text-ui-dense text-zinc-300 hover:text-zinc-100">
                                        {inThisChat ? 'Show in chat' : 'Open chat'}
                                    </button>
                                    <button type="button" onClick={() => onToggleWatch(signal.messageId, signal.conversationId)} className="rounded-control border border-hairline px-2.5 py-1 text-ui-dense text-zinc-500 hover:text-zinc-300">
                                        Unpin
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default WatchListPanel;
