/**
 * RowMenu — the rail row's context menu (WS-6 §5: pin/unpin, rename,
 * routines, delete).
 *
 * One action list, two entry points: right-click opens it at the cursor, and
 * a ⋯ trigger opens the same list for anyone who cannot right-click a div
 * (keyboard, touch). It portals to `document.body` because the rail is a
 * scroll container — positioned inside the row it would be clipped the moment
 * it overhangs the bottom edge.
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface RowMenuItem {
    label: string;
    onSelect: () => void;
    /** Destructive — gets the rose end of the ramp, per the color doctrine. */
    danger?: boolean;
}

/** Fixed width so the trigger can anchor the popover without measuring it. */
export const MENU_W = 156;

export const RowMenu: React.FC<{
    /** Viewport point to open at — clamped into the viewport below. */
    x: number;
    y: number;
    items: RowMenuItem[];
    onClose: () => void;
}> = ({ x, y, items, onClose }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
        // Bubble phase, deliberately: the ⋯ trigger stops pointerdown so a
        // second click can close the menu it opened.
        const dismiss = (): void => onClose();
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', dismiss);
        // A fixed popover must not outlive the row it was anchored to.
        window.addEventListener('scroll', dismiss, true);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('pointerdown', dismiss);
            window.removeEventListener('scroll', dismiss, true);
        };
    }, [onClose]);

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    // 0 means the host cannot measure (jsdom) — then open where asked.
    const left = vw ? Math.max(4, Math.min(x, vw - MENU_W - 4)) : x;
    const top = vh ? Math.max(4, Math.min(y, vh - items.length * 26 - 12)) : y;

    return createPortal(
        <div role="menu" data-testid="row-menu-popover"
            style={{ left, top, width: MENU_W }}
            className="fixed z-drawer rounded-bubble border border-zinc-800/80 bg-zinc-900 p-1 shadow-elevated">
            {items.map(item => (
                <button key={item.label} type="button" role="menuitem"
                    onClick={() => { item.onSelect(); onClose(); }}
                    className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-ui-dense transition-colors ${
                        item.danger ? 'text-rose-300 hover:bg-rose-500/10' : 'text-zinc-300 hover:bg-zinc-800'
                    }`}>
                    {item.label}
                </button>
            ))}
        </div>,
        document.body,
    );
};

export default RowMenu;
