/**
 * useColumnResize — the ONE drag-to-size contract for a layout COLUMN.
 *
 * The three columns around the desk are the shell rail, the order book and the
 * Chart AI dock. The dock is a panel with lifecycle and its own richer hook
 * (`useRightPanel`); this hook is only geometry, so a column cannot grow a
 * second idea of how it is sized or where its width is stored.
 *
 * `edge` names the side the handle sits on: a right-edge handle grows when the
 * pointer moves right, a left-edge handle grows when it moves left.
 *
 * Width is persisted as a plain number and restored only when it is still
 * inside [minWidth, maxWidth]; a stale or hand-edited value falls back to the
 * default rather than opening the app at a width that hides the chart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface UseColumnResizeOptions {
    /** Namespaced localStorage key, so two columns never share a width. */
    storageKey: string;
    defaultWidth: number;
    minWidth: number;
    maxWidth: number;
    edge: 'left' | 'right';
}

export interface UseColumnResize {
    width: number;
    isResizing: boolean;
    startResize: (event: React.PointerEvent) => void;
    /** Double-click the handle: back to the designed width. */
    resetWidth: () => void;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function useColumnResize(options: UseColumnResizeOptions): UseColumnResize {
    const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

    const readWidth = useCallback((): number => {
        try {
            const next = Number(localStorage.getItem(storageKey));
            if (Number.isFinite(next) && next >= minWidth && next <= maxWidth) return Math.round(next);
        } catch { /* private mode */ }
        return defaultWidth;
    }, [storageKey, minWidth, maxWidth, defaultWidth]);

    const [width, setWidthState] = useState<number>(readWidth);
    const [isResizing, setIsResizing] = useState(false);

    const commitWidth = useCallback((next: number) => {
        const clamped = clamp(Math.round(next), minWidth, maxWidth);
        setWidthState(clamped);
        try { localStorage.setItem(storageKey, String(clamped)); } catch { /* private mode */ }
    }, [storageKey, minWidth, maxWidth]);

    // The width lives in a ref during the drag so a pointermove never waits on
    // a render. The listeners are held so unmount removes the SAME functions
    // that were added; a fresh arrow in cleanup would leak the drag.
    const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
    const listenersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

    const startResize = useCallback((event: React.PointerEvent) => {
        event.preventDefault();
        dragRef.current = { startX: event.clientX, startWidth: width };
        setIsResizing(true);

        const onMove = (e: PointerEvent): void => {
            const drag = dragRef.current;
            if (!drag) return;
            const delta = e.clientX - drag.startX;
            commitWidth(edge === 'right' ? drag.startWidth + delta : drag.startWidth - delta);
        };
        const onUp = (): void => {
            dragRef.current = null;
            listenersRef.current = null;
            setIsResizing(false);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        listenersRef.current = { move: onMove, up: onUp };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [width, edge, commitWidth]);

    useEffect(() => () => {
        const l = listenersRef.current;
        if (!l) return;
        window.removeEventListener('pointermove', l.move);
        window.removeEventListener('pointerup', l.up);
        window.removeEventListener('pointercancel', l.up);
        listenersRef.current = null;
        dragRef.current = null;
    }, []);

    const resetWidth = useCallback(() => commitWidth(defaultWidth), [commitWidth, defaultWidth]);

    return useMemo(() => ({
        width, isResizing, startResize, resetWidth,
    }), [width, isResizing, startResize, resetWidth]);
}
