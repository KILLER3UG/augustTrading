/**
 * ChartToolRail — Binance/OKX-grade minimalist vertical drawing rail docked on
 * the chart's left edge.
 *
 * Strictly monochrome `zinc-*` chrome with semantic `emerald-*` / `rose-*`
 * reserved solely for Long / Short position icons (`check:palette` compliant).
 * Includes one-click undoable Clear AI Drawings using a clean monochrome icon
 * (`Trash2` + subtle `AI` tag — zero `Sparkles` or `Bot` icons).
 */

import React, { useState } from 'react';
import {
    ArrowDown,
    ArrowUp,
    ArrowUpRight,
    Eraser,
    Eye,
    EyeOff,
    Grid3x3,
    Layers,
    Magnet,
    Minus,
    MousePointer2,
    Palette,
    Pencil,
    Redo2,
    Square,
    Trash2,
    TrendingUp,
    Type,
    Undo2,
} from '../shared/Icons';
import { DRAW_COLORS, type DrawTool } from '../../services/trade/chartDrawings';
import { useEscapeClose } from '../../hooks/useEscapeClose';

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
        className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-control transition-colors ${
            active
                ? 'bg-white/[0.10] text-zinc-100'
                : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent'
        }`}
    >
        {children}
    </button>
);

const RailSep: React.FC = () => <span className="my-0.5 h-px w-5 shrink-0 bg-white/[0.04]" aria-hidden />;

export interface ChartToolRailProps {
    tool: DrawTool;
    /** Select a tool (clicking the active tool returns to cursor). */
    onSelectTool: (t: DrawTool) => void;
    color: string;
    onColorChange: (c: string) => void;
    canUndo: boolean;
    onUndo: () => void;
    canRedo?: boolean;
    onRedo?: () => void;
    /** Count of `origin === 'agent'` shapes currently on the chart. */
    agentDrawingCount?: number;
    /** One-click undoable removal of ONLY `origin === 'agent'` shapes. */
    onClearAgentDrawings?: () => void;
    /** Hide-all toggle: every drawing layer off the canvas, nothing deleted. */
    hidden: boolean;
    onToggleHidden: () => void;
    /** Magnet snap: pull each anchor onto the nearest candle's OHLC (12px). */
    magnet: boolean;
    onToggleMagnet: () => void;
    /** The stroke weight NEW shapes are drawn with (cycles the ladder). */
    lineWidth: number;
    onCycleWidth: () => void;
}

export const ChartToolRail: React.FC<ChartToolRailProps> = ({
    tool,
    onSelectTool,
    color,
    onColorChange,
    canUndo,
    onUndo,
    canRedo = false,
    onRedo,
    agentDrawingCount = 0,
    onClearAgentDrawings,
    hidden,
    onToggleHidden,
    magnet,
    onToggleMagnet,
    lineWidth,
    onCycleWidth,
}) => {
    const [paletteOpen, setPaletteOpen] = useState(false);
    // Escape lifts the palette wherever focus sits — the chart's own window
    // Escape handler stays standing down (useEscapeClose captures first).
    useEscapeClose(paletteOpen, () => setPaletteOpen(false));
    const pick = (t: DrawTool): void => {
        onSelectTool(tool === t ? 'cursor' : t);
    };

    return (
        <div
            data-testid="chart-tool-rail"
            role="toolbar"
            aria-label="Chart drawing tools"
            className="absolute left-0 top-0 z-20 flex h-full w-10 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden border-r border-white/[0.04] bg-zinc-900/30 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
            <RailButton
                title="Cursor — select, drag, pan & zoom (Esc)"
                active={tool === 'cursor'}
                onClick={() => onSelectTool('cursor')}
                testId="rail-tool-cursor"
            >
                <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>

            <RailSep />

            <RailButton
                title="Trendline — drag between two anchors"
                active={tool === 'trend'}
                onClick={() => pick('trend')}
                testId="rail-tool-trend"
            >
                <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Ray — anchor and extend forward"
                active={tool === 'ray'}
                onClick={() => pick('ray')}
                testId="rail-tool-ray"
            >
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Horizontal level — click to place"
                active={tool === 'hline'}
                onClick={() => pick('hline')}
                testId="rail-tool-hline"
            >
                <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Parallel channel — drag range"
                active={tool === 'channel'}
                onClick={() => pick('channel')}
                testId="rail-tool-channel"
            >
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Rectangle zone — drag supply/demand box"
                active={tool === 'rect'}
                onClick={() => pick('rect')}
                testId="rail-tool-rect"
            >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Fibonacci retracement — drag swing"
                active={tool === 'fib'}
                onClick={() => pick('fib')}
                testId="rail-tool-fib"
            >
                <Grid3x3 className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>

            <RailSep />

            <RailButton
                title="Long Position — R:R profit/risk box"
                active={tool === 'long_position'}
                onClick={() => pick('long_position')}
                testId="rail-tool-long-position"
            >
                <ArrowUp className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Short Position — R:R profit/risk box"
                active={tool === 'short_position'}
                onClick={() => pick('short_position')}
                testId="rail-tool-short-position"
            >
                <ArrowDown className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Callout label — click to annotate"
                active={tool === 'text'}
                onClick={() => pick('text')}
                testId="rail-tool-text"
            >
                <Type className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Freehand — drag to draw"
                active={tool === 'brush'}
                onClick={() => pick('brush')}
                testId="rail-tool-brush"
            >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            <RailButton
                title="Eraser — click a shape to remove it"
                active={tool === 'erase'}
                onClick={() => pick('erase')}
                testId="rail-tool-erase"
            >
                <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>

            <RailSep />

            <RailButton
                title={magnet ? 'Magnet on — snaps within 12px to OHLC (hold Ctrl)' : 'Magnet off — click or hold Ctrl to snap to OHLC'}
                active={magnet}
                onClick={onToggleMagnet}
                testId="rail-magnet"
            >
                <Magnet className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>

            <span className="flex-1" aria-hidden />

            <RailButton
                title={hidden ? 'Show all drawings' : 'Hide all drawings'}
                active={hidden}
                onClick={onToggleHidden}
                testId="rail-toggle-hidden"
            >
                {hidden ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            </RailButton>
            <RailButton
                title="Undo last drawing (Ctrl+Z)"
                disabled={!canUndo}
                onClick={onUndo}
                testId="rail-undo"
            >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </RailButton>
            {onRedo && (
                <RailButton
                    title="Redo drawing (Ctrl+Y)"
                    disabled={!canRedo}
                    onClick={onRedo}
                    testId="rail-redo"
                >
                    <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
                </RailButton>
            )}
            {onClearAgentDrawings && (
                <RailButton
                    title={agentDrawingCount > 0 ? `Clear AI Drawings (${agentDrawingCount})` : 'Clear AI Drawings (none active)'}
                    disabled={agentDrawingCount === 0}
                    onClick={onClearAgentDrawings}
                    testId="rail-clear-ai"
                >
                    <span className="relative flex items-center justify-center">
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="pointer-events-none absolute -bottom-1.5 -right-1.5 rounded-[2px] bg-zinc-900 px-0.5 font-mono text-[7px] leading-none text-zinc-400">
                            AI
                        </span>
                    </span>
                </RailButton>
            )}

            <div className="relative">
                <RailButton title="Drawing color" active={paletteOpen} onClick={() => setPaletteOpen(v => !v)}>
                    <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                </RailButton>
                {paletteOpen && (
                    <>
                        {/* z-shield: clears the dock's permanent z-drawer layer
                            (see index.css --z-shield) so a click in the Chart AI
                            dock dismisses the palette; the panel rides z-flyout
                            above its own backdrop. */}
                        <div className="fixed inset-0 z-shield" aria-hidden onClick={() => setPaletteOpen(false)} />
                        <div className="motion-popover-in absolute bottom-0 left-9 z-flyout flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-zinc-900/95 p-2 shadow-elevated backdrop-blur-md" data-testid="rail-palette">
                            {DRAW_COLORS.map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    aria-label={`Draw with ${c}`}
                                    onClick={() => { onColorChange(c); setPaletteOpen(false); }}
                                    className={`h-4 w-4 rounded-full border transition-transform ${color === c ? 'scale-110 border-line' : 'border-transparent hover:scale-105'}`}
                                    style={{ backgroundColor: c }}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>

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
