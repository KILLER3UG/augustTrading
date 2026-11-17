/**
 * ChartToolRail — the chart's TRADER GESTURES as a TradingView-style vertical
 * icon rail docked on the chart's LEFT edge (the old unicode-glyph row in the
 * top bar became unreadable noise next to the interval buttons). Layout and
 * interactions copy TradingView: the active tool highlighted, and the utility
 * cluster (hide / undo / palette) pinned to the bottom of the rail.
 *
 * Phase 4 (owner 2026-11-17, approved disposition table P-2): the SHAPE tools
 * left — trendline, ray, horizontal line, zone, fib, text — because the desk
 * draws them (`draw_on_chart`, `mark_trade_levels`; parity probe P-2 asserts
 * the seven kinds + trade levels + clear). What stays is what the model
 * cannot do: the trader's hand. Cursor, freehand, per-shape eraser, magnet
 * snap, hide/show, undo, the colour the trader styles their own strokes
 * with, and the stroke weight.
 *
 * Pure presentation: every action is delegated via props so the component is
 * trivially unit-testable and the chart keeps owning drawing state.
 */

import React, { useState } from 'react';
import {
    Eraser, Eye, EyeOff, Magnet, MousePointer2, Palette, Pencil, Undo2,
} from '../shared/Icons';
import { DRAW_COLORS, type DrawTool } from '../../services/trade/chartDrawings';

/** Rail width in px — the chart host and overlay inset by this so shapes
 *  never paint under the rail. */
export const CHART_RAIL_WIDTH = 40;

interface RailButtonProps {
    title: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
    /** Stable handle for the gates; the title is the accessible name. */
    testId?: string;
}

const RailButton: React.FC<RailButtonProps> = ({ title, active = false, disabled = false, onClick, children, testId }) => (
    <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
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
    /** Hide-all toggle: every drawing layer off the canvas, nothing deleted. */
    hidden: boolean;
    onToggleHidden: () => void;
    /** Magnet snap: pull each anchor onto the nearest candle's OHLC. */
    magnet: boolean;
    onToggleMagnet: () => void;
    /** The stroke weight NEW shapes are drawn with (the control cycles it). */
    lineWidth: number;
    onCycleWidth: () => void;
}

export const ChartToolRail: React.FC<ChartToolRailProps> = ({
    tool, onSelectTool, color, onColorChange, canUndo, onUndo, hidden, onToggleHidden,
    magnet, onToggleMagnet, lineWidth, onCycleWidth,
}) => {
    const [paletteOpen, setPaletteOpen] = useState(false);
    const pick = (t: DrawTool): void => {
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
            <RailButton title="Freehand — drag to draw" active={tool === 'brush'} onClick={() => pick('brush')}>
                <Pencil className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            <RailButton title="Eraser — click a shape to remove it" active={tool === 'erase'} onClick={() => pick('erase')}>
                <Eraser className="h-4 w-4" aria-hidden="true" />
            </RailButton>
            {/* Magnet snap — the reference's tool. It changes WHERE an anchor
                lands, not what is drawn: each click is pulled onto the nearest
                candle's OHLC, so a freehand stroke sits on the high it actually
                means instead of three ticks above it. */}
            <RailButton
                title={magnet ? 'Magnet on — anchors snap to the nearest OHLC' : 'Magnet off — anchors land where you click'}
                active={magnet}
                onClick={onToggleMagnet}
            >
                <Magnet className="h-4 w-4" aria-hidden="true" />
            </RailButton>
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
            <div className="relative">
                <RailButton title="Drawing color" active={paletteOpen} onClick={() => setPaletteOpen(v => !v)}>
                    <Palette className="h-4 w-4" aria-hidden="true" />
                </RailButton>
                {paletteOpen && (
                    <>
                        <div className="fixed inset-0 z-30" aria-hidden onClick={() => setPaletteOpen(false)} />
                        <div className="absolute left-9 bottom-0 z-40 flex flex-col gap-1 rounded-bubble border border-hairline bg-zinc-900 p-2 shadow-elevated" data-testid="rail-palette">
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
            {/* Line width — cycles the ladder. The glyph IS the stroke it will
                draw, so the button shows its own state rather than a number the
                trader has to interpret. */}
            <RailButton
                title={`Line width ${lineWidth} px — click for the next weight`}
                onClick={onCycleWidth}
                testId="rail-line-width"
            >
                <span aria-hidden="true" className="block w-4 rounded-full bg-current" style={{ height: Math.min(lineWidth, 4) }} />
            </RailButton>
        </div>
    );
};

export default ChartToolRail;
