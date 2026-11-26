/**
 * ChartFavoritesBar — draggable matte-monochrome Favorites micro-bar floating
 * inside `chart-canvas-wrapper` via GPU `translate3d` (zero CLS, zero layout
 * reflow). Appears whenever the trader has starred `>= 1` drawing tool from
 * any left-rail `▸` flyout, and stays usable even when the left rail is
 * collapsed (`Ctrl+Alt+D`).
 */

import React, { useEffect, useRef, useState } from 'react';
import { GripVertical } from '../shared/Icons';
import type { DrawTool } from '../../services/trade/chartDrawings';
import { findRailToolDef } from '../../services/trade/chartDeckCore';
import { renderRailToolIcon } from './ChartToolRail';
import { getActiveUsername } from '../../utils/activeUser';

export interface ChartFavoritesBarProps {
    favorites: ReadonlyArray<DrawTool>;
    activeTool: DrawTool;
    onSelectTool: (tool: DrawTool) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
}

const posKey = (username: string): string => `august_chart_favbar_pos_v1_${username}`;

const readStoredPos = (): { x: number; y: number } => {
    try {
        const raw = localStorage.getItem(posKey(getActiveUsername()));
        if (!raw) return { x: 12, y: 44 };
        const parsed = JSON.parse(raw) as { x?: number; y?: number };
        if (typeof parsed.x === 'number' && Number.isFinite(parsed.x) && typeof parsed.y === 'number' && Number.isFinite(parsed.y)) {
            return { x: Math.max(8, parsed.x), y: Math.max(8, parsed.y) };
        }
    } catch { /* fallback */ }
    return { x: 12, y: 44 };
};

export const ChartFavoritesBar: React.FC<ChartFavoritesBarProps> = ({
    favorites,
    activeTool,
    onSelectTool,
    containerRef,
}) => {
    const [pos, setPos] = useState<{ x: number; y: number }>(readStoredPos);
    const posRef = useRef(pos);
    posRef.current = pos;
    const barRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null);

    useEffect(() => {
        const onMove = (ev: PointerEvent): void => {
            const d = dragRef.current;
            if (!d || ev.pointerId !== d.pointerId) return;
            const host = containerRef.current;
            const bar = barRef.current;
            const maxX = Math.max(8, (host?.clientWidth ?? 600) - (bar?.offsetWidth ?? 160) - 8);
            const maxY = Math.max(8, (host?.clientHeight ?? 400) - (bar?.offsetHeight ?? 34) - 8);
            const nextX = Math.max(8, Math.min(maxX, Math.round(d.origX + (ev.clientX - d.startX))));
            const nextY = Math.max(8, Math.min(maxY, Math.round(d.origY + (ev.clientY - d.startY))));
            setPos({ x: nextX, y: nextY });
        };
        const onUp = (ev: PointerEvent): void => {
            const d = dragRef.current;
            if (!d || ev.pointerId !== d.pointerId) return;
            dragRef.current = null;
            try {
                localStorage.setItem(posKey(getActiveUsername()), JSON.stringify(posRef.current));
            } catch { /* private mode */ }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, [containerRef]);

    if (favorites.length === 0) return null;

    return (
        <div
            ref={barRef}
            data-testid="chart-favorites-bar"
            role="toolbar"
            aria-label="Favorite drawing tools"
            style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
            className="pointer-events-auto absolute left-0 top-0 z-20 flex items-center gap-0.5 rounded-control border border-hairline bg-zinc-950/95 px-1 py-0.5 shadow-elevated will-change-transform"
        >
            <span
                data-testid="favorites-bar-grip"
                title="Drag favorites bar"
                onPointerDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    dragRef.current = {
                        pointerId: ev.pointerId,
                        startX: ev.clientX,
                        startY: ev.clientY,
                        origX: posRef.current.x,
                        origY: posRef.current.y,
                    };
                }}
                className="flex h-6 w-4 cursor-grab items-center justify-center text-zinc-600 hover:text-zinc-300 active:cursor-grabbing"
            >
                <GripVertical className="h-3 w-3" aria-hidden="true" />
            </span>
            {favorites.map(tool => {
                const def = findRailToolDef(tool);
                if (!def) return null;
                const active = activeTool === tool;
                return (
                    <button
                        key={tool}
                        type="button"
                        data-testid={`fav-tool-${tool}`}
                        title={def.title}
                        aria-label={def.label}
                        aria-pressed={active}
                        onClick={() => onSelectTool(active ? 'cursor' : tool)}
                        className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors ${
                            active
                                ? 'bg-white/[0.10] text-zinc-100'
                                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
                        }`}
                    >
                        {renderRailToolIcon(tool)}
                    </button>
                );
            })}
        </div>
    );
};
