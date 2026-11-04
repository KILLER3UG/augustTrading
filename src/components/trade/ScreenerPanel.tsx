/**
 * ScreenerPanel — the market-wide discovery table: every scanned coin with
 * price, 24h change, RSI(14), EMA regime, live strategy-book setups and the
 * trader's own logged edge, sortable + filterable, one click from row to
 * chart. Runs progressively — rows land while the scan is still walking the
 * universe — and can be closed mid-scan (the scan aborts with it).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, BrainCircuit, Loader2, Minus, Search, X } from '../shared/Icons';
import { runScreenerWithStatus, type ScreenerRow } from '../../services/trade/screener';
import { bestSetupScore, SCORE_FORMULA } from '../../services/trade/bestSetups';
import { display as symbolDisplay } from '../../utils/symbol';
import { fmtPrice } from '../../utils/formatters';
import StatusPill from '../ui/StatusPill';
import type { LoggedTrade } from '../../types/trade';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface ScreenerPanelProps {
    open: boolean;
    onClose: () => void;
    /** Row click: load this coin onto the chart and close. */
    onChangeSymbol: (symbol: string) => void;
    trades?: LoggedTrade[];
}

/** 'best' is the SAME score the model's find_best_setups tool prints — one
 *  ranking for the table and the answer, never two ideas of "best". */
type SortKey = 'volume' | 'movers' | 'rsi' | 'setups' | 'best';

// fmtPrice lives in utils/formatters (audit 2026-09-16 dedupe). The canonical
// keeps this table's sub-$1 six-decimal precision and pins the locale to
// en-US like the rest of the desk; visible delta here is trailing ".00" on
// whole-dollar cells (tabular-nums column was built for it).

/** EMA regime as a semantic chip: the color family is the direction, so
 *  the column scans without reading the word. Module scope (it captured
 *  nothing) so the memoized row below can use it. */
const regimePill = (regime: ScreenerRow['regime']): React.ReactNode => (
    regime === 'up'
        ? <StatusPill tone="up" icon={<ArrowUp className="h-3 w-3" aria-hidden="true" />}>up</StatusPill>
        : regime === 'down'
            ? <StatusPill tone="down" icon={<ArrowDown className="h-3 w-3" aria-hidden="true" />}>down</StatusPill>
            : <StatusPill tone="neutral" icon={<Minus className="h-3 w-3" aria-hidden="true" />}>range</StatusPill>
);

/** The flat, primitive-only view model a row renders from. The scan hands
 *  out `ScreenerRow` objects that carry a `setups` ARRAY; a memo boundary
 *  compares props by reference, so a parent render that rebuilds that array
 *  (or the row object) would miss every time. Everything the row actually
 *  paints is therefore flattened to strings/numbers here, in a useMemo
 *  keyed on the sorted list. */
interface ScreenerRowView {
    symbol: string;
    display: string;
    baseAsset: string;
    price: number;
    change24h: number;
    rsi14: number | null;
    regime: ScreenerRow['regime'];
    setupCount: number;
    setupTitle: string;
    /** The `title` tooltip: every setup, "Name (side); …". */
    setupsTitle: string;
    /** The shared confluence score, shown only when a setup is live. */
    score: number;
    edge: string;
}

interface ScreenerRowViewProps extends ScreenerRowView {
    onSelect: (symbol: string) => void;
    onLearn: (symbol: string) => void;
}

/** One table row. Memoized on primitives + two stable callbacks, so typing
 *  in the filter box re-renders only the rows whose text actually changed
 *  instead of all ~100 of them (the reason this was extracted: the panel
 *  keeps the whole scan in memory, and every keystroke used to reconcile
 *  the entire tbody). */
const ScreenerRowView = React.memo<ScreenerRowViewProps>(({
    symbol, display, baseAsset, price, change24h, rsi14, regime,
    setupCount, setupTitle, setupsTitle, score, edge, onSelect, onLearn,
}) => (
    <tr
        data-testid={`screener-row-${symbol}`}
        onClick={() => onSelect(symbol)}
        className="cursor-pointer border-b border-white/[0.03] transition-colors hover:bg-white/[0.04]"
    >
        <td className="px-4 py-1.5">
            <span className="font-mono font-bold text-zinc-100">{display}</span>
            <span className="ml-2 text-zinc-600">{baseAsset}</span>
            <button
                type="button"
                data-testid={`screener-learn-${symbol}`}
                title="Load on the chart and prefill the Chart AI to scan this coin's candles for skills"
                aria-label={`Learn skills from ${display}`}
                onClick={ev => { ev.stopPropagation(); onLearn(symbol); }}
                className="ml-2 inline-flex rounded-control p-0.5 text-zinc-600 transition-colors hover:bg-white/10 hover:text-cyan-300"
            >
                <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
        </td>
        <td className="px-3 py-1.5 font-mono tabular-nums text-zinc-300">{price > 0 ? fmtPrice(price) : '—'}</td>
        <td className={`px-3 py-1.5 font-mono tabular-nums ${change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {change24h >= 0 ? '+' : ''}{change24h.toFixed(1)}%
        </td>
        <td className={`px-3 py-1.5 font-mono tabular-nums ${rsi14 == null ? 'text-zinc-600' : rsi14 >= 70 ? 'text-rose-400' : rsi14 <= 30 ? 'text-emerald-400' : 'text-zinc-300'}`}>
            {rsi14 ?? '—'}
        </td>
        <td className="px-3 py-1.5">{regimePill(regime)}</td>
        <td className="px-3 py-1.5">
            {setupCount > 0
                ? <span className="rounded-control bg-amber-500/10 px-1.5 py-0.5 text-ui-xs font-semibold text-amber-300" title={setupsTitle}>
                    {setupCount} · {setupTitle}
                    <span className="ml-1.5 font-mono text-zinc-400" title={`Confluence score ${score}: ${SCORE_FORMULA}`}>
                        {score}
                    </span>
                </span>
                : <span className="text-zinc-600">—</span>}
        </td>
        <td className="px-3 py-1.5 font-mono tabular-nums text-zinc-500">{edge || '—'}</td>
    </tr>
));
ScreenerRowView.displayName = 'ScreenerRowView';

export const ScreenerPanel: React.FC<ScreenerPanelProps> = ({ open, onClose, onChangeSymbol, trades = [] }) => {
    const [rows, setRows] = useState<ScreenerRow[]>([]);
    const [scanned, setScanned] = useState(0);
    const [scanTotal, setScanTotal] = useState(0);
    const [running, setRunning] = useState(false);
    const [query, setQuery] = useState('');
    const [setupsOnly, setSetupsOnly] = useState(false);
    const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'volume', desc: true });
    // True when the futures universe feed failed to answer — the scan is
    // BLIND, not empty. Rendered as a red retry row, never as "No coins
    // match" (the old byte-identical failure/empty presentation).
    const [universeFailed, setUniverseFailed] = useState(false);
    const [runNonce, setRunNonce] = useState(0);
    const runIdRef = useRef(0);

    // Each open (and each explicit retry) starts a FRESH scan; closing
    // aborts the in-flight one.
    useEffect(() => {
        if (!open) return;
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        const controller = new AbortController();
        setRows([]);
        setScanned(0);
        setUniverseFailed(false);
        setRunning(true);
        void runScreenerWithStatus({
            limit: 100,
            trades,
            signal: controller.signal,
            onRows: latest => {
                if (runIdRef.current !== runId) return;
                setRows(latest);
                setScanned(latest.length);
            },
        }).then(result => {
            if (runIdRef.current !== runId) return;
            setScanTotal(result.rows.length);
            setUniverseFailed(result.universeFailed);
        }).finally(() => {
            if (runIdRef.current !== runId) return;
            setRunning(false);
        });
        return () => controller.abort();
        // `trades` is intentionally sampled at scan start; `runNonce` drives
        // explicit retries.
    }, [open, runNonce]);

    const visible = useMemo(() => {
        const q = query.trim().toUpperCase();
        const filtered = rows.filter(r =>
            (!q || r.symbol.includes(q) || r.baseAsset.toUpperCase().includes(q))
            && (!setupsOnly || r.setups.length > 0));
        const dir = sort.desc ? -1 : 1;
        const sorted = [...filtered];
        if (sort.key === 'movers') sorted.sort((a, b) => dir * (Math.abs(b.change24h) - Math.abs(a.change24h)));
        else if (sort.key === 'rsi') sorted.sort((a, b) => dir * ((a.rsi14 ?? 50) - (b.rsi14 ?? 50)));
        else if (sort.key === 'setups') sorted.sort((a, b) => dir * (b.setups.length - a.setups.length));
        else if (sort.key === 'best') sorted.sort((a, b) =>
            dir * (bestSetupScore(a).score - bestSetupScore(b).score)
            || b.quoteVolume - a.quoteVolume
            || a.symbol.localeCompare(b.symbol));
        else sorted.sort((a, b) => dir * (b.quoteVolume - a.quoteVolume));
        return sorted;
    }, [rows, query, setupsOnly, sort]);

    // Flatten the sorted rows to primitives ONCE per scan/filter/sort change,
    // so a keystroke in the filter box hands React.memo a stable prop set and
    // only the rows whose text actually changed re-render.
    const rowViews = useMemo<ScreenerRowView[]>(() => visible.map(r => ({
        symbol: r.symbol,
        display: symbolDisplay(r.symbol),
        baseAsset: r.baseAsset,
        price: r.price,
        change24h: r.change24h,
        rsi14: r.rsi14 ?? null,
        regime: r.regime,
        setupCount: r.setups.length,
        setupTitle: r.setups[0]?.title ?? '',
        setupsTitle: r.setups.map(s => `${s.title} (${s.side})`).join('; '),
        score: bestSetupScore(r).score,
        edge: r.edge || '',
    })), [visible]);

    // Stable row callbacks: an inline arrow would be a new reference on every
    // render and would defeat the row memo entirely.
    const handleRowSelect = useCallback((rowSymbol: string): void => {
        onChangeSymbol(rowSymbol);
        onClose();
    }, [onChangeSymbol, onClose]);

    const handleRowLearn = useCallback((rowSymbol: string): void => {
        onChangeSymbol(rowSymbol);
        window.dispatchEvent(new CustomEvent('august:prefill-chat', { detail: { token: 'scan-chart-skills' } }));
        onClose();
    }, [onChangeSymbol, onClose]);

    // A11y (it had neither): Escape closes the dialog and Tab stays inside it,
    // with focus returned to whatever opened it on close. Before this the only
    // way out was clicking the X or the backdrop — a keyboard user was stuck.
    // Both hooks are unconditional, above the `!open` return below.
    const panelRef = useFocusTrap<HTMLDivElement>(open);
    useEscapeClose(open, onClose);

    if (!open) return null;

    /** Sortable column head. The arrow IS the direction read (no separate
     *  caret to decode), and an idle column still shows a faint double arrow
     *  so it reads as sortable rather than static. */
    const sortTh = (key: SortKey, label: string, className = 'px-3 py-1.5'): React.ReactNode => {
        const active = sort.key === key;
        return (
            <th className={className} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button
                    type="button"
                    onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : true }))}
                    className={`inline-flex shrink-0 items-center gap-1 text-ui-2xs font-bold uppercase tracking-widest transition-colors hover:text-zinc-200 ${
                        active ? 'text-zinc-100' : 'text-zinc-500'
                    }`}
                >
                    {label}
                    {active
                        ? (sort.desc
                            ? <ArrowDown className="h-3 w-3" aria-hidden="true" />
                            : <ArrowUp className="h-3 w-3" aria-hidden="true" />)
                        : <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />}
                </button>
            </th>
        );
    };

    const plainTh = (label: string, className = 'px-3 py-1.5'): React.ReactNode => (
        <th className={className}>
            <span className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500">{label}</span>
        </th>
    );

    return createPortal(
        <>
            <div className="fixed inset-0 z-40 bg-black/70" aria-hidden="true" onClick={onClose} />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Market screener"
                tabIndex={-1}
                data-testid="screener-panel"
                className="fixed left-1/2 top-1/2 z-modal flex max-h-[82vh] w-[min(880px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-bubble border border-white/10 bg-zinc-900 shadow-2xl focus:outline-none"
            >
                <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
                    <h2 className="text-ui-caption font-bold text-zinc-100">Screener</h2>
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-white/10 bg-zinc-800 px-2 py-1">
                        <Search className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden="true" />
                        <input
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Filter symbol…"
                            aria-label="Filter screener symbols"
                            className="min-w-0 flex-1 bg-transparent text-ui-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => setSetupsOnly(s => !s)}
                        aria-pressed={setupsOnly}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-ui-xs font-semibold transition-colors ${setupsOnly ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-white/10 text-zinc-400 hover:text-zinc-200'}`}
                    >
                        Setups only
                    </button>
                    <button
                        type="button"
                        data-testid="screener-best-trigger"
                        title={`Rank by the same confluence score the desk's find_best_setups tool uses. ${SCORE_FORMULA}`}
                        aria-label="Best setups"
                        aria-pressed={sort.key === 'best'}
                        onClick={() => {
                            const on = sort.key === 'best';
                            setSetupsOnly(!on);
                            setSort(on ? { key: 'volume', desc: true } : { key: 'best', desc: true });
                        }}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-ui-xs font-semibold transition-colors ${sort.key === 'best' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-white/10 text-zinc-400 hover:text-zinc-200'}`}
                    >
                        Best setups
                    </button>
                    <button type="button" onClick={onClose} aria-label="Close screener"
                        className="shrink-0 rounded-control p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                    <table className="w-full border-collapse text-ui-dense">
                        <thead className="sticky top-0 bg-zinc-900">
                            <tr className="border-b border-white/[0.06]">
                                {sortTh('volume', 'Symbol', 'px-4 py-1.5')}
                                {plainTh('Price')}
                                {sortTh('movers', '24h')}
                                {sortTh('rsi', 'RSI')}
                                {plainTh('Regime')}
                                {sortTh('setups', 'Setups')}
                                {plainTh('You')}
                            </tr>
                        </thead>
                        <tbody>
                            {rowViews.map(r => (
                                <ScreenerRowView
                                    key={r.symbol}
                                    {...r}
                                    onSelect={handleRowSelect}
                                    onLearn={handleRowLearn}
                                />
                            ))}
                            {visible.length === 0 && !running && universeFailed && (
                                <tr><td colSpan={7} className="px-4 py-8 text-center text-ui-dense">
                                    <span className="text-rose-400 font-semibold" role="alert">Feed failed — the futures ticker could not be reached.</span>{' '}
                                    <button
                                        type="button"
                                        data-testid="screener-retry"
                                        onClick={() => setRunNonce(n => n + 1)}
                                        className="rounded-control border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-ui-xs font-semibold text-rose-300 transition-colors hover:bg-rose-500/20"
                                    >
                                        Retry
                                    </button>
                                </td></tr>
                            )}
                            {visible.length === 0 && !running && !universeFailed && (
                                <tr><td colSpan={7} className="px-4 py-8 text-center text-ui-dense text-zinc-500">No coins match.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.06] px-4 py-1.5 text-ui-xs text-zinc-500">
                    {running && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                    <span>
                        {running
                            ? `scanning ${scanned}${scanTotal ? `/${scanTotal}` : ''}… rows fill in as they land`
                            : universeFailed
                                ? 'universe feed unreachable — nothing scanned'
                                : `${rows.length} coins scanned · click a row to load it on the chart`}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1">
                        sorted by {sort.key}
                        {sort.desc
                            ? <ArrowDown className="h-3 w-3" aria-hidden="true" />
                            : <ArrowUp className="h-3 w-3" aria-hidden="true" />}
                    </span>
                </div>
            </div>
        </>,
        document.body,
    );
};

export default React.memo(ScreenerPanel);
