/**
 * ComposerWorkspaceRow — the composer's top context strip: compact monochrome
 * Coin (symbol) & Timeframe selectors shared across Chat and Desk, plus optional
 * panel-seat and bound-bot chips.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search } from '../../shared/Icons';
import { PANEL_MAX_MODELS } from '../../../services/trade/chatSessions';
import type { SymbolMeta } from '../../../services/analysis/MarketDataService';
import * as chatStore from '../../../services/trade/chatStore';
import { FALLBACK_SYMBOLS } from '../../../hooks/useSymbolUniverse';
import { useEscapeClose } from '../../../hooks/useEscapeClose';
import { display as symbolDisplay } from '../../../utils/symbol';
import { shouldOpenUpward } from '../../../utils/popoverPlacement';
import { COMPOSER_TIMEFRAMES, type ChartInterval } from '../../../utils/chartIntervals';

export { COMPOSER_TIMEFRAMES };

export interface ComposerWorkspaceRowProps {
    symbol: string;
    symbols?: SymbolMeta[];
    onChangeSymbol?: (symbol: string) => void;
    interval: string;
    onChangeInterval?: (interval: ChartInterval) => void;
    isPanel: boolean;
    /** Seats this panel session currently holds. */
    panelCount: number;
    /** Is THIS session's seat editor open? */
    pickerOpen: boolean;
    onTogglePicker: () => void;
    /** Name of the roster bot bound to this session. `null` means no bound bot. */
    botName: string | null;
    /** Epoch-ms of the last live packet fetch (kept for upstream wiring). */
    contextAt: number | null;
}

const ComposerWorkspaceRow: React.FC<ComposerWorkspaceRowProps> = ({
    symbol, symbols, onChangeSymbol, interval, onChangeInterval,
    isPanel, panelCount, pickerOpen, onTogglePicker, botName,
}) => {
    const [symbolOpen, setSymbolOpen] = useState(false);
    const [tfOpen, setTfOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const [tfCursor, setTfCursor] = useState(0);
    const [symbolAnchor, setSymbolAnchor] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
    const [tfAnchor, setTfAnchor] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
    const symbolBtnRef = useRef<HTMLButtonElement>(null);
    const tfBtnRef = useRef<HTMLButtonElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const tfMenuRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEscapeClose(symbolOpen, () => setSymbolOpen(false));
    useEscapeClose(tfOpen, () => setTfOpen(false));

    const universe = symbols && symbols.length > 0 ? symbols : FALLBACK_SYMBOLS;

    const filtered = useMemo(() => {
        const q = query.trim().toUpperCase();
        if (!q) return universe;
        const starts: SymbolMeta[] = [];
        const includes: SymbolMeta[] = [];
        for (const s of universe) {
            if (s.symbol.startsWith(q) || s.baseAsset.toUpperCase().startsWith(q)) starts.push(s);
            else if (s.symbol.includes(q) || s.baseAsset.toUpperCase().includes(q)) includes.push(s);
        }
        return [...starts, ...includes];
    }, [universe, query]);

    useEffect(() => {
        if (symbolOpen) {
            setQuery('');
            setCursor(0);
            window.setTimeout(() => searchInputRef.current?.focus(), 0);
        }
    }, [symbolOpen]);

    useEffect(() => {
        if (tfOpen) {
            const idx = COMPOSER_TIMEFRAMES.indexOf(interval as ChartInterval);
            setTfCursor(idx >= 0 ? idx : 0);
            window.setTimeout(() => tfMenuRef.current?.focus(), 0);
        }
    }, [tfOpen, interval]);

    useEffect(() => {
        if (!symbolOpen) return;
        const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
    }, [cursor, symbolOpen]);

    const commitSymbol = (next: string): void => {
        onChangeSymbol?.(next);
        chatStore.setActiveSymbol(next);
        setSymbolOpen(false);
    };

    const commitInterval = (next: ChartInterval): void => {
        onChangeInterval?.(next);
        const sid = chatStore.getActiveSession()?.id ?? chatStore.getActiveId();
        if (sid) chatStore.mutate(sid, sess => ({ ...sess, interval: next }));
        setTfOpen(false);
    };

    const toggleSymbolMenu = (): void => {
        setTfOpen(false);
        const r = symbolBtnRef.current?.getBoundingClientRect();
        if (r) {
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 264));
            setSymbolAnchor(
                shouldOpenUpward(r, 320)
                    ? { left, bottom: window.innerHeight - r.top + 4 }
                    : { left, top: r.bottom + 4 },
            );
        }
        setSymbolOpen(o => !o);
    };

    const toggleTfMenu = (): void => {
        setSymbolOpen(false);
        const r = tfBtnRef.current?.getBoundingClientRect();
        if (r) {
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 136));
            setTfAnchor(
                shouldOpenUpward(r, 240)
                    ? { left, bottom: window.innerHeight - r.top + 4 }
                    : { left, top: r.bottom + 4 },
            );
        }
        setTfOpen(o => !o);
    };

    const activeItem = filtered[cursor];

    return (
        <div className="flex shrink-0 items-center gap-1.5 px-1 pb-2 pt-0.5" data-testid="composer-context-bar">
            <button
                ref={symbolBtnRef}
                type="button"
                onClick={toggleSymbolMenu}
                aria-label="Composer symbol"
                aria-expanded={symbolOpen}
                data-testid="composer-symbol-trigger"
                className="flex min-h-6 items-center gap-1 rounded-control border border-hairline px-2 py-1 text-ui-xs font-medium text-zinc-300 transition-colors hover:border-line hover:bg-white/[0.04] hover:text-zinc-100"
            >
                <span className="font-mono">{symbolDisplay(symbol)}</span>
                <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden="true" />
            </button>
            <button
                ref={tfBtnRef}
                type="button"
                onClick={toggleTfMenu}
                aria-label="Composer timeframe"
                aria-expanded={tfOpen}
                data-testid="composer-timeframe-trigger"
                className="flex min-h-6 items-center gap-1 rounded-control border border-hairline px-2 py-1 font-mono text-ui-xs font-medium text-zinc-300 transition-colors hover:border-line hover:bg-white/[0.04] hover:text-zinc-100"
            >
                <span>{interval}</span>
                <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden="true" />
            </button>
            {isPanel && (
                <button
                    type="button"
                    onClick={onTogglePicker}
                    aria-expanded={pickerOpen}
                    title="Add / remove panel models (up to 5)"
                    className="rounded-full border border-hairline px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-wider text-zinc-400 transition-colors hover:border-line hover:text-zinc-100"
                >
                    panel · {panelCount}/{PANEL_MAX_MODELS}
                </button>
            )}
            {botName !== null && (
                <span className="truncate rounded-full border border-hairline px-1.5 py-0.5 text-ui-2xs font-semibold text-zinc-400" title={botName}>
                    {botName}
                </span>
            )}
            {symbolOpen && createPortal(
                <>
                    <div className="fixed inset-0 z-shield" aria-hidden="true" onClick={() => setSymbolOpen(false)} />
                    <div
                        data-testid="composer-symbol-menu"
                        className={`fixed z-flyout w-64 overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900 shadow-elevated ${symbolAnchor.bottom !== undefined ? 'motion-popover-in' : 'motion-popover-down'}`}
                        style={symbolAnchor}
                    >
                        <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
                            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                            <input
                                ref={searchInputRef}
                                data-testid="composer-symbol-search"
                                value={query}
                                onChange={e => { setQuery(e.target.value); setCursor(0); }}
                                onKeyDown={e => {
                                    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, Math.max(0, filtered.length - 1))); }
                                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
                                    else if (e.key === 'Enter') { e.preventDefault(); if (activeItem) commitSymbol(activeItem.symbol); }
                                    else if (e.key === 'Escape') { e.preventDefault(); setSymbolOpen(false); }
                                }}
                                placeholder="Search symbol…"
                                aria-label="Search composer symbols"
                                className="min-w-0 flex-1 bg-transparent text-ui-dense text-zinc-100 placeholder-zinc-500 focus:outline-none"
                            />
                        </div>
                        <div ref={listRef} className="max-h-60 overflow-y-auto py-1 custom-scrollbar" data-testid="composer-symbol-list">
                            {filtered.length === 0 ? (
                                <p className="px-3 py-4 text-center text-ui-xs text-zinc-500">
                                    No match for &quot;{query}&quot;.
                                </p>
                            ) : filtered.map((s, i) => (
                                <button
                                    key={s.symbol}
                                    type="button"
                                    data-idx={i}
                                    data-testid={`composer-symbol-row-${s.symbol}`}
                                    onMouseEnter={() => setCursor(i)}
                                    onClick={() => commitSymbol(s.symbol)}
                                    className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-ui-dense transition-colors ${i === cursor ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-300'}`}
                                >
                                    <span className="font-mono font-medium">{symbolDisplay(s.symbol)}</span>
                                    <span className="text-ui-2xs text-zinc-500">{s.symbol === symbol ? 'active' : `${s.baseAsset} perp`}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </>,
                document.body,
            )}
            {tfOpen && createPortal(
                <>
                    <div className="fixed inset-0 z-shield" aria-hidden="true" onClick={() => setTfOpen(false)} />
                    <div
                        ref={tfMenuRef}
                        tabIndex={-1}
                        role="listbox"
                        aria-label="Select timeframe"
                        data-testid="composer-timeframe-menu"
                        onKeyDown={e => {
                            if (e.key === 'ArrowDown') { e.preventDefault(); setTfCursor(c => (c + 1) % COMPOSER_TIMEFRAMES.length); }
                            else if (e.key === 'ArrowUp') { e.preventDefault(); setTfCursor(c => (c - 1 + COMPOSER_TIMEFRAMES.length) % COMPOSER_TIMEFRAMES.length); }
                            else if (e.key === 'Enter') { e.preventDefault(); const chosen = COMPOSER_TIMEFRAMES[tfCursor]; if (chosen) commitInterval(chosen); }
                            else if (e.key === 'Escape') { e.preventDefault(); setTfOpen(false); tfBtnRef.current?.focus(); }
                        }}
                        className={`fixed z-flyout w-28 overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900 p-1 shadow-elevated focus:outline-none ${tfAnchor.bottom !== undefined ? 'motion-popover-in' : 'motion-popover-down'}`}
                        style={tfAnchor}
                    >
                        {COMPOSER_TIMEFRAMES.map((tf, i) => (
                            <button
                                key={tf}
                                type="button"
                                role="option"
                                aria-selected={tf === interval}
                                data-testid={`composer-timeframe-row-${tf}`}
                                onMouseEnter={() => setTfCursor(i)}
                                onClick={() => commitInterval(tf)}
                                className={`flex w-full items-center justify-between rounded-control px-2 py-1 text-left font-mono text-ui-dense transition-colors ${tf === interval ? 'bg-white/[0.08] font-semibold text-zinc-100' : i === tfCursor ? 'bg-white/[0.05] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100'}`}
                            >
                                <span>{tf}</span>
                                {tf === interval && <span className="text-ui-2xs text-zinc-400">active</span>}
                            </button>
                        ))}
                    </div>
                </>,
                document.body,
            )}
        </div>
    );
};

export default ComposerWorkspaceRow;
