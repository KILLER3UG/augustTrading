/**
 * ChartToolRail — the chart's drawing tools as a TradingView-style vertical
 * icon rail docked on the chart's LEFT edge (the old unicode-glyph row in the
 * top bar became unreadable noise next to the interval buttons). Layout and
 * interactions copy TradingView: drawing groups with a flyout of alternates,
 * the active tool highlighted, and the utility cluster (hide / undo / clear /
 * palette) pinned to the bottom of the rail.
 *
 * Pure presentation: every action is delegated via props so the component is
 * trivially unit-testable and the chart keeps owning drawing state.
 */

import React, { useState } from 'react';
import {
    Eraser, Eye, EyeOff, Minus, MousePointer2, Palette, Pencil, Square,
    Trash2, Type, Undo2, MoreHorizontal,
} from '../shared/Icons';
import { DRAW_COLORS, type DrawTool } from '../../services/trade/chartDrawings';

/** Rail width in px — the chart host and overlay inset by this so shapes
 *  never paint under the rail. */
export const CHART_RAIL_WIDTH = 40;

interface RailIconProps { className?: string }

/* These three stay hand-drawn rather than coming from the icon layer, and
 * that is a deliberate exception to "no hand-rolled SVGs", not an oversight:
 * each names a DRAWING TOOL whose meaning lucide does not carry. A trendline
 * is a segment with two grabbable endpoints; a ray is an anchored point with
 * an arrowhead; a Fibonacci is a diagonal plus level bands. Substituting
 * lucide's nearest neighbours (Slash, ArrowUpRight, Sqrt) loses exactly the
 * part that tells the trader which tool they are about to draw — the comment
 * on TrendIcon records the same conclusion when lucide's Slash was tried.
 *
 * They obey the rest of the doctrine: stroke 2, currentColor, size from the
 * caller's class, aria-hidden (each button carries its own label). */

/** Fibonacci retracement glyph: the anchor diagonal with retracement levels. */
const FibIcon: React.FC<RailIconProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
        <path d="M5 3 L19 21" />
        <path d="M3 8.4 H21" strokeDasharray="2.5 2.5" />
        <path d="M3 14.6 H21" />
        <path d="M3 20.5 H21" strokeDasharray="2.5 2.5" />
    </svg>
);

/** A small trendline glyph (lucide's Slash reads as a plain divider at 16px). */
const TrendIcon: React.FC<RailIconProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
        <path d="M4 20 L14 10" />
        <circle cx="4" cy="20" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="14" cy="10" r="1.6" fill="currentColor" stroke="none" />
        <path d="M14 10 L20 4" strokeDasharray="2.5 2.5" />
    </svg>
);

/** A ray glyph: anchored segment extending right with an arrowhead. */
const RayIcon: React.FC<RailIconProps> = ({ className }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
        <circle cx="5" cy="17" r="1.6" fill="currentColor" stroke="none" />
        <path d="M6.5 15.8 L19 5" />
        <path d="M13.5 4.5 L19.5 4.5 L19.5 10.5" />
    </svg>
);

interface RailButtonProps {
    title: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}

const RailButton: React.FC<RailButtonProps> = ({ title, active = false, disabled = false, onClick, children }) => (
    <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors ${
            active
                ? 'bg-white/[0.09] text-zinc-100'
                : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent'
        }`}
    >
        {children}
    </button>
);

const RailSep: React.FC = () => <span className="my-1 h-px w-5 shrink-0 bg-white/[0.07]" aria-hidden />;

interface ChartToolRailProps {
    tool: DrawTool;
    /** Select a tool (the rail already toggles the active one back to cursor). */
    onSelectTool: (t: DrawTool) => void;
    color: string;
    onColorChange: (c: string) => void;
    canUndo: boolean;
    onUndo: () => void;
    onClear: () => void;
    /** Hide-all toggle: every drawing layer off the canvas, nothing deleted. */
    hidden: boolean;
    onToggleHidden: () => void;
}

export const ChartToolRail: React.FC<ChartToolRailProps> = ({
    tool, onSelectTool, color, onColorChange, canUndo, onUndo, onClear, hidden, onToggleHidden,
}) => {
    const [trendFlyout, setTrendFlyout] = useState(false);
    // The mock's resting rail is four tools (cursor, trend, horizontal, zone);
    // the rest are real and stay, one caret away.
    const [moreFlyout, setMoreFlyout] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const pick = (t: DrawTool): void => {
        setTrendFlyout(false);
        onSelectTool(tool === t ? 'cursor' : t);
    };

    return (
        <div
            data-testid="chart-tool-rail"
            role="toolbar"
            aria-label="Chart drawing tools"
            /* CHROME (the reference's frame): a flat page separated by a
               HAIRLINE, not a panel with a fill and a border. The rail used to
               carry its own raised surface (zinc-900 at 90 %) over the chart,
               which drew a second box down the left edge of the plot. It is
               the page colour now, and the one hairline on its right is what
               separates the icon column from the chart. */
            className="absolute left-0 top-0 z-20 flex h-full w-10 flex-col items-center gap-0.5 border-r border-hairline bg-zinc-950 py-1.5"
        >
            <RailButton title="Cursor — pan & zoom the chart" active={tool === 'cursor'} onClick={() => onSelectTool('cursor')}>
                <MousePointer2 className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <RailSep />
            {/* Trend group: one button for the last-used line tool, a flyout
                for alternates — TradingView's group pattern. */}
            <div className="relative">
                <RailButton
                    title={tool === 'ray' ? 'Ray — click start, click direction (extends right)' : 'Trendline — click start, click end'}
                    active={tool === 'trend' || tool === 'ray'}
                    onClick={() => pick(tool === 'trend' || tool === 'ray' ? 'cursor' : 'trend')}
                >
                    {tool === 'ray' ? <RayIcon className="h-4 w-4" aria-hidden="true" /> : <TrendIcon className="h-4 w-4" aria-hidden="true" />}
                </RailButton>
                <button
                    type="button"
                    title="More line tools"
                    aria-label="More line tools"
                    aria-expanded={trendFlyout}
                    onClick={() => setTrendFlyout(v => !v)}
                    className="hit-target group/caret absolute -right-2.5 -bottom-2 grid place-items-center rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
                >
                    {/* The caret stays a 10px corner glyph (TradingView's split-button
                        look); the button around it is the invisible 24px hit-target
                        floor the render probe enforces. */}
                    <span className="block h-2.5 w-2.5 rounded-full border border-zinc-900 bg-zinc-700 transition-colors group-hover/caret:bg-zinc-600">
                        <span className="mx-auto block h-0 w-0 border-x-[2.5px] border-b-[3px] border-x-transparent border-b-zinc-300" aria-hidden />
                    </span>
                </button>
                {trendFlyout && (
                    <>
                        <div className="fixed inset-0 z-30" aria-hidden onClick={() => setTrendFlyout(false)} />
                        <div className="absolute left-9 top-0 z-40 flex flex-col gap-0.5 rounded-bubble border border-hairline bg-zinc-900 p-1 shadow-xl" data-testid="trend-flyout">
                            <RailButton title="Trendline — click start, click end" active={tool === 'trend'} onClick={() => pick('trend')}>
                                <TrendIcon className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                            <RailButton title="Ray — click start, click direction (extends right)" active={tool === 'ray'} onClick={() => pick('ray')}>
                                <RayIcon className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                        </div>
                    </>
                )}
            </div>
            <RailButton title="Horizontal line — click a price" active={tool === 'hline'} onClick={() => pick('hline')}>
                <Minus className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <RailButton title="Zone — click corner to corner" active={tool === 'rect'} onClick={() => pick('rect')}>
                <Square className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <div className="relative">
                <RailButton
                    title="More tools — fib, text, freehand, eraser"
                    active={['fib', 'text', 'brush', 'erase'].includes(tool)}
                    onClick={() => setMoreFlyout(v => !v)}
                >
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </RailButton>
                {moreFlyout && (
                    <>
                        <div className="fixed inset-0 z-30" aria-hidden onClick={() => setMoreFlyout(false)} />
                        <div className="absolute left-9 top-0 z-40 flex flex-col gap-0.5 rounded-bubble border border-hairline bg-zinc-900 p-1 shadow-xl" data-testid="more-tools-flyout">
                            <RailButton title="Fib retracement — click swing low, click swing high" active={tool === 'fib'} onClick={() => pick('fib')}>
                                <FibIcon className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                            <RailButton title="Text note — click a spot, type the note" active={tool === 'text'} onClick={() => pick('text')}>
                                <Type className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                            <RailButton title="Freehand — drag to draw" active={tool === 'brush'} onClick={() => pick('brush')}>
                                <Pencil className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                            <RailButton title="Eraser — click a shape to remove it" active={tool === 'erase'} onClick={() => pick('erase')}>
                                <Eraser className="h-4 w-4" aria-hidden="true" />
                            </RailButton>
                            <div className="my-0.5 h-px bg-white/[0.07]" />
                        </div>
                    </>
                )}
            </div>
            <RailSep />
            <span className="flex-1" aria-hidden />
            <RailButton
                title={hidden ? 'Show all drawings' : 'Hide all drawings'}
                active={hidden}
                onClick={onToggleHidden}
            >
                {hidden ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </RailButton>
            <RailButton title="Undo last drawing" disabled={!canUndo} onClick={onUndo}>
                <Undo2 className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <RailButton title="Clear all drawings" disabled={!canUndo} onClick={onClear}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <div className="relative">
                <RailButton title="Drawing color" active={paletteOpen} onClick={() => setPaletteOpen(v => !v)}>
                    <Palette className="h-4 w-4" aria-hidden="true" />
                </RailButton>
                {paletteOpen && (
                    <>
                        <div className="fixed inset-0 z-30" aria-hidden onClick={() => setPaletteOpen(false)} />
                        <div className="absolute left-9 bottom-0 z-40 flex flex-col gap-1 rounded-bubble border border-hairline bg-zinc-900 p-2 shadow-xl" data-testid="rail-palette">
                            {DRAW_COLORS.map(c => (
                                <button key={c} type="button" aria-label={`Draw with ${c}`}
                                    onClick={() => { onColorChange(c); setPaletteOpen(false); }}
                                    className={`h-4 w-4 rounded-full border transition-transform ${color === c ? 'scale-110 border-line' : 'border-transparent hover:scale-105'}`}
                                    style={{ backgroundColor: c }} />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ChartToolRail;
