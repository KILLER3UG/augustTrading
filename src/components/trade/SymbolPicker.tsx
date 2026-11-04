/**
 * SymbolPicker — TradingView-style instrument search for the Analyze surface.
 * The whole USDT-perp universe (/fapi/v1/exchangeInfo ∩ 24hr tickers) sits
 * behind one button: a search field filters by ticker or base asset, rows
 * show last price + 24h change, and ↑↓/↵/Esc navigate — no more 20-symbol
 * dropdown.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search } from '../shared/Icons';
import type { SymbolMeta } from '../../services/analysis/MarketDataService';
import { display as symbolDisplay } from '../../utils/symbol';
import { shouldOpenUpward } from '../../utils/popoverPlacement';

export interface SymbolPickerProps {
    symbols: SymbolMeta[];
    value: string;
    onChange: (symbol: string) => void;
    /** The chart head is the symbol, the price and the funding (v3) — the
     *  market TOOLS that used to sit there live in this menu's foot, so they
     *  keep a door without decorating the head. */
    onOpenScreener?: () => void;
    onOpenWatchList?: () => void;
    watchOpenCount?: number;
}

const display: (symbol: string) => string = symbolDisplay;

export const SymbolPicker: React.FC<SymbolPickerProps> = ({
    symbols, value, onChange, onOpenScreener, onOpenWatchList, watchOpenCount = 0,
}) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
    const triggerRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // startsWith ranks above includes; each group keeps the volume order the
    // feed already arrives in, so liquid names lead both.
    const filtered = useMemo(() => {
        const q = query.trim().toUpperCase();
        if (!q) return symbols;
        const starts: SymbolMeta[] = [];
        const includes: SymbolMeta[] = [];
        for (const s of symbols) {
            if (s.symbol.startsWith(q) || s.baseAsset.startsWith(q)) starts.push(s);
            else if (s.symbol.includes(q) || s.baseAsset.toUpperCase().includes(q)) includes.push(s);
        }
        return [...starts, ...includes];
    }, [symbols, query]);

    // Fresh search + cursor every open; the field takes focus after paint.
    useEffect(() => {
        if (open) {
            setQuery('');
            setCursor(0);
            window.setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open]);

    // Keep the cursor row in view while arrowing (scrollIntoView is
    // optional-called: jsdom embeds don't implement it).
    useEffect(() => {
        if (!open) return;
        const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
    }, [cursor, open]);

    const commit = (symbol: string): void => {
        onChange(symbol);
        setOpen(false);
    };

    // The popover PORTALS to <body> and pins to the trigger's rect — the
    // stats strip is an overflow-x container that would otherwise clip the
    // dropdown to its own box (the later-5 menu-clip bug, again).
    /** The list's own ceiling: `max-h-80` (320px) plus the search row and the
     *  border. Used only to decide which way to open — see
     *  utils/popoverPlacement.ts, the same rule the timeframe chip uses. The
     *  panel is anchored by its bottom edge when it flips, so a short result
     *  list leaves no gap. */
    const PANEL_MAX_H = 364;
    const toggle = (): void => {
        const r = triggerRef.current?.getBoundingClientRect();
        if (r) {
            // The composer sits at the bottom of the window, so a picker that
            // always opened downward ran off its edge and across the disclaimer
            // line under the card. Flip when the space below cannot hold the
            // list AND there is more room above.
            const left = Math.min(r.left, Math.max(8, window.innerWidth - 336));
            setAnchor(shouldOpenUpward(r, PANEL_MAX_H)
                ? { left, bottom: window.innerHeight - r.top + 4 }
                : { left, top: r.bottom + 4 });
        }
        setOpen(o => !o);
    };

    const active = filtered[cursor];
    const valueMeta = symbols.find(s => s.symbol === value);

    return (
        <div className="relative">
            {/* CHROME (the reference's title bar). The trigger is a TITLE with
                a chevron, not a box: the reference's own window chrome puts the
                title and its caret on the bare page and keeps the small icon
                set beside it. The old trigger was a bordered, filled pill —
                the loudest object in a title bar. The panel it opens is still
                a bordered card, because that is what a popover is. */}
            <button
                ref={triggerRef}
                type="button"
                aria-label="Trade symbol"
                aria-expanded={open}
                data-testid="symbol-picker-trigger"
                onClick={toggle}
                className="flex items-center gap-1.5 rounded-control px-2 py-1 text-ui-caption font-bold text-zinc-100 transition-colors hover:bg-white/[0.05]"
            >
                {display(value)}
                {valueMeta && valueMeta.changePercent24h !== 0 && (
                    <span className={`font-mono text-ui-xs font-semibold tabular-nums ${valueMeta.changePercent24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {valueMeta.changePercent24h >= 0 ? '+' : ''}{valueMeta.changePercent24h.toFixed(1)}%
                    </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
            </button>
            {open && createPortal(
                <>
                    <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
                    <div
                        data-testid="symbol-picker"
                        className="fixed z-drawer w-80 overflow-hidden rounded-bubble border border-white/10 bg-zinc-900 shadow-2xl"
                        style={anchor}
                    >
                        <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
                            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={e => { setQuery(e.target.value); setCursor(0); }}
                                onKeyDown={e => {
                                    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, filtered.length - 1)); }
                                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
                                    else if (e.key === 'Enter') { e.preventDefault(); if (active) commit(active.symbol); }
                                    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
                                }}
                                placeholder="Search symbol…"
                                aria-label="Search symbols"
                                className="min-w-0 flex-1 bg-transparent text-ui-caption text-zinc-100 placeholder-zinc-500 focus:outline-none"
                            />
                        </div>
                        <div ref={listRef} className="max-h-80 overflow-y-auto custom-scrollbar" data-testid="symbol-picker-list">
                            {filtered.length === 0 ? (
                                <p className="px-3 py-6 text-center text-ui-dense text-zinc-500" data-testid="symbol-picker-empty">
                                    No symbol matches &quot;{query}&quot;.
                                </p>
                            ) : filtered.map((s, i) => (
                                <button
                                    key={s.symbol}
                                    type="button"
                                    data-idx={i}
                                    data-testid={`symbol-row-${s.symbol}`}
                                    onMouseEnter={() => setCursor(i)}
                                    onClick={() => commit(s.symbol)}
                                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === cursor ? 'bg-white/[0.06]' : ''}`}
                                >
                                    <span className="w-28 shrink-0 truncate font-mono text-ui-sm font-bold text-zinc-100" title={display(s.symbol)}>{display(s.symbol)}</span>
                                    <span className="min-w-0 flex-1 truncate text-ui-dense text-zinc-500" title={`${s.baseAsset} perpetual`}>{s.baseAsset} perpetual</span>
                                    <span className="shrink-0 font-mono text-ui-dense tabular-nums text-zinc-300">
                                        {s.lastPrice > 0 ? s.lastPrice.toLocaleString(undefined, { maximumFractionDigits: s.lastPrice < 1 ? 6 : 2 }) : '—'}
                                    </span>
                                    <span className={`w-14 shrink-0 text-right font-mono text-ui-xs tabular-nums ${s.changePercent24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {s.changePercent24h >= 0 ? '+' : ''}{s.changePercent24h.toFixed(1)}%
                                    </span>
                                </button>
                            ))}
                        </div>
                        {(onOpenScreener || onOpenWatchList) && (
                            <div className="flex items-center gap-1 border-t border-white/[0.06] px-2 py-1.5">
                                {onOpenScreener && (
                                    <button type="button" data-testid="screener-trigger"
                                        onClick={() => { setOpen(false); onOpenScreener(); }}
                                        aria-label="Open market screener" title="Market screener"
                                        className="flex flex-1 items-center justify-center gap-1.5 rounded-control px-2 py-1 text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                                        Screener
                                    </button>
                                )}
                                {onOpenWatchList && (
                                    <button type="button" data-testid="trade-pinned-trigger"
                                        onClick={() => { setOpen(false); onOpenWatchList(); }}
                                        aria-label={`Pinned signals, ${watchOpenCount} open`}
                                        title="Pinned signals"
                                        className="flex flex-1 items-center justify-center gap-1.5 rounded-control px-2 py-1 text-ui-dense text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                                        Pinned{watchOpenCount > 0 ? ` · ${watchOpenCount}` : ''}
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="border-t border-white/[0.06] px-3 py-1.5 text-ui-2xs text-zinc-600">
                            ↑↓ navigate · ↵ select · esc close · {filtered.length} of {symbols.length} USDT perps
                        </div>
                    </div>
                </>,
                document.body,
            )}
        </div>
    );
};

export default React.memo(SymbolPicker);
