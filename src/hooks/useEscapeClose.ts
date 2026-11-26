import { useEffect, useRef } from 'react';

/**
 * Calls the provided handler when the Escape key is pressed while active.
 *
 * Uses a single LIFO stack so when multiple modals/dialogs are open (e.g. a
 * ConfirmDialog over Settings), ONLY the topmost active layer consumes Escape.
 *
 * An open flyout owns this Escape FIRST: while any component marks
 * `data-menu-open` on <body> (SelectMenu does while open), this hook stands
 * down — the menu closes, and the NEXT Escape reaches the host.
 */
const escapeStack: Array<() => void> = [];
let listenerAttached = false;

function handleGlobalEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (document.body.getAttribute('data-menu-open') === '1') return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  e.stopPropagation();
  top();
}

export function useEscapeClose(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    const entry = () => onEscapeRef.current();
    escapeStack.push(entry);
    if (!listenerAttached) {
      document.addEventListener('keydown', handleGlobalEscape, true);
      listenerAttached = true;
    }

    return () => {
      const idx = escapeStack.lastIndexOf(entry);
      if (idx !== -1) escapeStack.splice(idx, 1);
      if (escapeStack.length === 0 && listenerAttached) {
        document.removeEventListener('keydown', handleGlobalEscape, true);
        listenerAttached = false;
      }
    };
  }, [active]);
}
