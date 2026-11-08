/**
 * The timeframe bar, lifted out of `TradingChart` so the Agents surface can
 * offer the same control over the same data.
 *
 * It reads `CHART_INTERVALS` and the per-user `trade_tf_bar_v1_<user>`
 * selection through the same helpers the chart uses, so the customizable set
 * is identical in both places and a choice made in one is the choice in the
 * other — not a second, parallel preference.
 */
import React, { useRef, useState } from 'react';
import { Check, ChevronDown, Settings } from '../shared/Icons';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { shouldOpenUpward } from '../../utils/popoverPlacement';
import { readTfBarSelection, writeTfBarSelection } from './TradingChart';
import { CHART_INTERVALS, type ChartInterval } from '../../utils/chartIntervals';

export interface TimeframeBarProps {
    interval: ChartInterval;
    onIntervalChange: (next: ChartInterval) => void;
    /** Rendered after the bar's own controls (the chart puts studies here). */
    children?: React.ReactNode;
    className?: string;
    /**
     * Composer mode: the intervals collapse to ONE chip carrying the active
     * choice, which opens a menu of the same list. On the chart the bar IS the
     * instrument and every timeframe sits in plain sight; in a composer it is a
     * setting changed rarely, and six buttons there is what made August's
     * composer read as a toolbar where the reference's reads as one line.
     * Nothing is removed — every interval stays reachable, and the customize
     * gear is unchanged.
     */
    compact?: boolean;
}

const TimeframeBar: React.FC<TimeframeBarProps> = ({ interval, onIntervalChange, children, className, compact = false }) => {
    const [open, setOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    /* This bar is rendered twice: on the chart, where a menu can hang below
       the trigger, and in the Chat composer, which sits at the bottom of the
       window — where the same menu ran off the edge and across the disclaimer
       line. Both menus ask which way to open at the moment they open. */
    const [menuUp, setMenuUp] = useState(false);
    const [pickerUp, setPickerUp] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);
    const gearRef = useRef<HTMLButtonElement>(null);
    const MENU_H = 208;
    const PICKER_H = 300;
    /* Both popovers dismiss on Escape, not only on the invisible backdrop.
       Caught by looking at the screen rather than at a test: a menu that the
       keyboard opens and the keyboard cannot close is a trap, and the compact
       chip made that reachable from the composer. */
    useEscapeClose(open, () => setOpen(false));
    useEscapeClose(menuOpen, () => setMenuOpen(false));
    // The persisted selection is read ONCE on mount (and again on toggle) —
    // not per render: this bar sits on the chart, which re-renders on every
    // live tick (~1s), and a localStorage read + JSON.parse per tick is pure
    // waste. State re-syncs on toggle (see below), the only moment the
    // selection can actually change.
    const [bar, setBar] = useState<ChartInterval[]>(() => readTfBarSelection());
    const shownIntervals = CHART_INTERVALS.filter(tf => bar.includes(tf) || tf === interval);

    const toggle = (tf: ChartInterval): void => {
        // Re-read (not trust the mount-time state): another surface's bar may
        // have written the key since mount, and the persisted selection is
        // the source of truth. Then mirror the write into state.
        const current = readTfBarSelection();
        const next = current.includes(tf) ? current.filter(x => x !== tf) : [...current, tf];
        writeTfBarSelection(next);
        setBar(next);
        setOpen(false);
    };

    return (
        <div className={`relative flex shrink-0 flex-wrap items-center gap-1 ${className ?? 'border-b border-hairline px-3 py-2'}`}>
            {compact ? (
                <>
                    <button type="button" data-testid="tf-compact" ref={chipRef}
                        aria-haspopup="menu" aria-expanded={menuOpen}
                        aria-label={`Timeframe ${interval} — change`}
                        onClick={() => {
                            const el = chipRef.current;
                            if (el) setMenuUp(shouldOpenUpward(el.getBoundingClientRect(), MENU_H));
                            setMenuOpen(v => !v);
                        }}
                        className="flex items-center gap-1 rounded-control px-2 py-1 text-ui-dense font-semibold text-zinc-200 transition-colors hover:bg-white/[0.05]">
                        {interval}
                        <ChevronDown className={`h-3 w-3 text-zinc-500 transition-transform ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {menuOpen && (
                        <>
                            <div className="fixed inset-0 z-20" aria-hidden onClick={() => setMenuOpen(false)} />
                            <div role="menu" data-testid="tf-compact-menu"
                                className={`absolute left-0 ${menuUp ? 'bottom-8' : 'top-8'} z-40 w-28 rounded-bubble border border-hairline bg-zinc-900 p-1 shadow-elevated`}>
                                {shownIntervals.map(tf => (
                                    <button key={tf} type="button" role="menuitem"
                                        onClick={() => { onIntervalChange(tf); setMenuOpen(false); }}
                                        aria-current={interval === tf ? 'true' : undefined}
                                        className={`flex w-full items-center justify-between rounded-control px-2 py-1 text-ui-dense transition-colors ${
                                            interval === tf ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
                                        }`}>
                                        {tf}
                                        {interval === tf && <Check className="h-3 w-3" aria-hidden="true" />}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </>
            ) : shownIntervals.map(tf => (
                /* CHROME: the active timeframe is a RAISED chip (the
                   reference's own segmented control draws its selected tab
                   exactly that way) and the rest are bare labels on the flat
                   page. No border on either — a border here made six boxes
                   out of six words. */
                <button
                    key={tf}
                    type="button"
                    onClick={() => onIntervalChange(tf)}
                    className={`rounded-control px-2.5 py-1 font-mono text-ui-dense font-medium tabular-nums transition-colors ${
                        interval === tf ? 'bg-zinc-700 text-zinc-100 ring-1 ring-white/[0.07]' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                    }`}
                >
                    {tf}
                </button>
            ))}
            <button type="button" ref={gearRef}
                onClick={() => {
                    const el = gearRef.current;
                    if (el) setPickerUp(shouldOpenUpward(el.getBoundingClientRect(), PICKER_H));
                    setOpen(v => !v);
                }}
                aria-label="Customize timeframes" aria-expanded={open}
                title="Choose which timeframes show in this bar"
                className={`ml-0.5 flex h-6 w-6 items-center justify-center rounded-control transition-colors ${
                    open ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                }`}>
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
                    {/* z-40, not the chart's z-30: this bar is also rendered
                        on the Agents surface, and the Chat composer sits at
                        z-[90]. The overlay that closes it is z-20 either
                        way; only the panel needed lifting. */}
                    <div className={`absolute left-2 ${pickerUp ? 'bottom-9' : 'top-9'} z-40 w-40 rounded-bubble border border-hairline bg-zinc-900 p-1 shadow-elevated`} data-testid="tf-picker">
                        {/* A SECTION HEADING, so it takes the reference's rule:
                            small, muted, sentence case — not the uppercase
                            letter-spaced eyebrow the data readouts keep. */}
                        <p className="px-2 py-1 text-ui-2xs text-zinc-600">Timeframes</p>
                        <div className="grid grid-cols-2 gap-0.5">
                            {CHART_INTERVALS.map(tf => {
                                const isShown = bar.includes(tf) || tf === interval;
                                return (
                                    <button key={tf} type="button" onClick={() => toggle(tf)} disabled={tf === interval}
                                        aria-pressed={isShown}
                                        title={tf === interval ? 'The current timeframe always shows' : undefined}
                                        className={`flex items-center justify-between rounded-control px-2 py-1 text-ui-dense transition-colors hover:bg-white/[0.06] disabled:opacity-40 ${
                                            isShown ? 'text-zinc-100' : 'text-zinc-500'
                                        }`}>
                                        {tf}
                                        <span aria-hidden>{isShown ? <Check className="h-3 w-3 text-cyan-400" aria-hidden="true" /> : null}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}
            {children}
        </div>
    );
};

export default TimeframeBar;
