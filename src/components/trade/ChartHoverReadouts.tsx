/**
 * ChartHoverReadouts — the two readouts that follow the CROSSHAIR, built as
 * leaves over a tiny rAF-coalesced store.
 *
 * Why they are leaves, and why a store. The crosshair fires on every pointer
 * pixel. Driving the legend and the crosshair price through TradingChart's own
 * state meant that a sweep across the candles re-rendered the whole chart
 * component (and every study row, tag, rail and toolbar in it) for a string
 * that only two small boxes display — and re-rendering on the same frame the
 * hover animation was repainting the canvas produced a visibly unsteady chart.
 *
 * The store holds two slices, commits at most once per animation frame, and
 * drops a write that would not change a rendered character. Each readout
 * subscribes to its own slice with `useSyncExternalStore`, so a sweep re-renders
 * two tiny components and never the chart.
 */

import React, { useSyncExternalStore } from 'react';
import { ChevronDown, Plus } from '../shared/Icons';
import { fmtPrice as fmtPriceForChart, fmtUsd as fmtUsdForChart } from '../../utils/formatters';
import { phtAxisTick } from '../../utils/timezone';

/** One bar as the legend describes it: OHLC plus the study values at that bar. */
export interface HoverBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    values: Record<string, number | null>;
}

/** The price under the crosshair and its % from the last price. */
export interface HoverCross {
    y: number;
    price: number;
    pct: number;
}

export interface HoverReadout {
    subscribe(listener: () => void): () => void;
    getBar(): HoverBar | null;
    getCross(): HoverCross | null;
    /** Queue a legend bar (`null` clears it). Coalesced to one commit/frame. */
    setBar(next: HoverBar | null): void;
    /** Queue the crosshair price. Coalesced to one commit/frame. */
    setCross(next: HoverCross | null): void;
    /** Drop any scheduled frame (unmount). */
    dispose(): void;
}

const sameValues = (a: Record<string, number | null>, b: Record<string, number | null>): boolean => {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
        const av = a[key];
        const bv = b[key];
        if (av !== bv && !(typeof av === 'number' && typeof bv === 'number' && Number.isNaN(av) && Number.isNaN(bv))) return false;
    }
    return true;
};

const sameBar = (a: HoverBar | null, b: HoverBar | null): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.time === b.time
        && a.open === b.open
        && a.high === b.high
        && a.low === b.low
        && a.close === b.close
        && sameValues(a.values, b.values);
};

/** Sub-pixel movement of the crosshair is not a new readout; a different price
 *  is (that is the number the tag prints). */
const sameCross = (a: HoverCross | null, b: HoverCross | null): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.price === b.price && Math.abs(a.y - b.y) < 1;
};

export const createHoverReadout = (): HoverReadout => {
    let bar: HoverBar | null = null;
    let cross: HoverCross | null = null;
    let pendingBar: HoverBar | null | undefined;
    let pendingCross: HoverCross | null | undefined;
    let frame: number | null = null;
    const listeners = new Set<() => void>();

    const emit = (): void => {
        for (const listener of [...listeners]) listener();
    };

    const commit = (): void => {
        frame = null;
        let changed = false;
        if (pendingBar !== undefined) {
            const next = pendingBar;
            pendingBar = undefined;
            if (!sameBar(bar, next)) {
                bar = next;
                changed = true;
            }
        }
        if (pendingCross !== undefined) {
            const next = pendingCross;
            pendingCross = undefined;
            if (!sameCross(cross, next)) {
                cross = next;
                changed = true;
            }
        }
        if (changed) emit();
    };

    const schedule = (): void => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            commit();
            return;
        }
        if (frame !== null) return;
        frame = window.requestAnimationFrame(commit);
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getBar: () => bar,
        getCross: () => cross,
        setBar(next) {
            if (sameBar(pendingBar !== undefined ? pendingBar : bar, next)) return;
            pendingBar = next;
            schedule();
        },
        setCross(next) {
            if (sameCross(pendingCross !== undefined ? pendingCross : cross, next)) return;
            pendingCross = next;
            schedule();
        },
        dispose() {
            if (frame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(frame);
            }
            frame = null;
            pendingBar = undefined;
            pendingCross = undefined;
            listeners.clear();
        },
    };
};

/**
 * The OHLC/volume legend. Absolutely positioned over the plot and locked to ONE
 * line (nowrap + tabular figures + a fixed-height control row), so changing
 * digits can never wrap it onto a second line, change its height, or push the
 * chart's own box around.
 */
export const HoverLegend: React.FC<{
    store: HoverReadout;
    expanded: boolean;
    onToggleExpanded: () => void;
    /** The verdict chip reserves the right edge when it is up. */
    narrow: boolean;
    renderRows: (bar: HoverBar) => React.ReactNode;
    /** Bar volume (contracts) — read from the chart's own mirror, not a prop. */
    volumeFor: (time: number) => number | null;
}> = ({ store, expanded, onToggleExpanded, narrow, renderRows, volumeFor }) => {
    const bar = useSyncExternalStore(store.subscribe, store.getBar);
    if (!bar) return null;
    const vol = volumeFor(bar.time);
    return (
        <div
            data-testid="chart-legend"
            /* The drawing rail now occupies its own dedicated 38px flex column
               to the left of the canvas wrapper, so the legend starts cleanly
               at left-2 inside the plot with zero rail overlap. When the
               verdict chip is up, its ~190px on the right stay reserved. */
            className={`pointer-events-none absolute left-2 top-1.5 z-10 overflow-hidden rounded-control bg-zinc-950/80 px-2 py-1 font-mono text-ui-dense tabular-nums text-zinc-500 [contain:layout] ${narrow ? 'max-w-[calc(100%-204px)]' : 'max-w-[calc(100%-16px)]'}`}
        >
            {/* ONE compact OHLCV line: time, the four prices and the volume.
                whitespace-nowrap keeps the tokens whole: a narrowed legend
                CLIPS at its edge rather than breaking "Nov 19," across two
                lines — a legend that reflowed on hover would resize the plot.
                The expand control is ABSOLUTE at the row's right edge (pr-7
                reserves its 24px), so a wider/tighter volume figure can never
                push it sideways: the row is measured by the browser as still,
                which is what keeps the hover readout out of the CLS budget. */}
            <div className="flex h-6 items-center gap-x-2 whitespace-nowrap pr-7">
                <span className="inline-block w-[6.25rem]">{phtAxisTick(bar.time, 'full')}</span>
                {(['open', 'high', 'low', 'close'] as const).map(k => (
                    <span key={k}>{k[0].toUpperCase()} <span className="text-zinc-300">{fmtPriceForChart(bar[k])}</span></span>
                ))}
                {vol === undefined || vol === null ? null : (
                    <span className="inline-block w-[5.5rem]">VOL <span className="text-zinc-300">{fmtUsdForChart(vol * bar.close)}</span></span>
                )}
            </div>
            <button
                type="button"
                data-testid="legend-expand"
                aria-expanded={expanded}
                title={expanded ? 'Hide study readouts' : 'Show change, range and study readouts'}
                onClick={onToggleExpanded}
                /* 24px: the control floor every clickable target is held to;
                   the chevron stays 12px inside it. */
                className="pointer-events-auto absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-[4px] text-zinc-500 transition-colors hover:text-zinc-200"
            >
                <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {expanded && (
                <>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>Change <span className={bar.close >= bar.open ? 'text-emerald-400' : 'text-rose-400'}>
                            {fmtPriceForChart(bar.close - bar.open)} ({(((bar.close - bar.open) / bar.open) * 100).toFixed(2)}%)
                        </span></span>
                        <span>Range <span className="text-zinc-300">{(((bar.high - bar.low) / bar.open) * 100).toFixed(2)}%</span></span>
                        {vol === undefined || vol === null ? null : (
                            <span>VOL(Contracts) <span className="text-zinc-300">{vol >= 1000 ? `${(vol / 1000).toFixed(3)}K` : vol.toFixed(3)}</span></span>
                        )}
                    </div>
                    {renderRows(bar)}
                </>
            )}
        </div>
    );
};

/** The price under the crosshair with its distance from the last price. */
export const HoverCrossTag: React.FC<{ store: HoverReadout; axisW: number }> = ({ store, axisW }) => {
    const cross = useSyncExternalStore(store.subscribe, store.getCross);
    if (!cross) return null;
    return (
        <div
            data-testid="crosshair-price-tag"
            className="pointer-events-none absolute right-0.5 top-0 z-10 flex flex-col items-end gap-1 [will-change:transform]"
            /* TRANSFORM, not `top`: this tag follows the pointer, and a layout
               box that moves on every pixel is reported as a layout shift. A
               composited translate repaints the tag without re-laying anything
               out, so hovering the candles contributes nothing to CLS. */
            style={{ transform: `translate3d(0, ${Math.max(6, cross.y - 10)}px, 0)` }}
        >
            <span
                style={{ minWidth: Math.max(48, axisW - 4) }}
                className="rounded-[3px] bg-zinc-700 px-1.5 py-0.5 text-right font-mono text-[11px] leading-none tabular-nums text-zinc-100"
            >
                {fmtPriceForChart(cross.price)}
            </span>
            <span className={`rounded-[3px] border border-hairline bg-zinc-900/95 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums ${cross.pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {`${cross.pct >= 0 ? '+' : ''}${cross.pct.toFixed(2)}%`}
            </span>
        </div>
    );
};

/**
 * Right price-axis `+` button driven by the same rAF-coalesced hover store
 * via `translate3d` (zero `TradingChart` re-renders, zero CLS). Clicking opens
 * the 4-action ChartContextMenu at the exact hovered price.
 */
export const PriceAxisPlusButton: React.FC<{
    store: HoverReadout;
    axisW: number;
    onOpenMenu: (price: number, y: number) => void;
}> = ({ store, axisW, onOpenMenu }) => {
    const cross = useSyncExternalStore(store.subscribe, store.getCross);
    if (!cross || !Number.isFinite(cross.price)) return null;
    return (
        <button
            type="button"
            data-testid="price-axis-plus-btn"
            title={`Actions @ $${fmtPriceForChart(cross.price)}`}
            aria-label={`Price actions at ${fmtPriceForChart(cross.price)}`}
            onClick={(ev) => {
                ev.stopPropagation();
                onOpenMenu(cross.price, cross.y);
            }}
            style={{
                right: Math.max(54, axisW + 2),
                transform: `translate3d(0, ${Math.max(6, Math.round(cross.y) - 9)}px, 0)`,
            }}
            className="pointer-events-auto absolute top-0 z-20 flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border border-hairline bg-zinc-900 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50 [will-change:transform]"
        >
            <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
    );
};
