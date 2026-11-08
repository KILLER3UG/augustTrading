import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { TrashIcon, CloseIcon } from './Icons';

/**
 * ConfirmDialog — a non-blocking, styled replacement for window.confirm().
 *
 * Native confirm() is blocking, unstyled, has no undo, and (combined
 * with the debounced-save risk) a delete can appear to succeed in the UI but
 * be lost on close. This component renders an in-app modal and, after a
 * confirmed destructive action, shows an undo toast for a short grace period.
 *
 * Usage:
 *   const confirm = useConfirmDialog();
 *   const ok = await confirm({ title: 'Delete?', message: 'This cannot be undone.' });
 *   if (ok) doDelete();
 *
 * For undo support, pass `onUndo` — when the user clicks Undo within the grace
 * period, onUndo fires and the result becomes `false` (so the caller treats
 * the action as not-performed). The undo toast auto-dismisses after 5s.
 *
 * For typed confirmation (destructive ops where a misclick is too easy),
 * pass `typedConfirm: 'RESET'` (or any string). The dialog renders an
 * input; the confirm button stays disabled until the user types the exact
 * string. Use `typedConfirmHint` to override the default instruction
 * ("Type X to confirm").
 */

export interface ConfirmOptions {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    /** If provided, an Undo button is shown for this many ms after confirm. */
    undoGraceMs?: number;
    onUndo?: () => void | Promise<void>;
    /** If set, the confirm button is disabled until the user types this
     *  exact string into the modal's input field. Case-sensitive. */
    typedConfirm?: string;
    /** Override the default hint text shown above the input. */
    typedConfirmHint?: string;
}

interface ConfirmState extends ConfirmOptions {
    open: boolean;
    resolve?: (ok: boolean) => void;
}

const DEFAULTS: Required<Omit<ConfirmOptions, 'onUndo' | 'message' | 'typedConfirm' | 'typedConfirmHint'>> = {
    title: 'Confirm',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    destructive: true,
    undoGraceMs: 5000,
};

export function useConfirmDialog() {
    const [state, setState] = useState<ConfirmState>({ ...DEFAULTS, open: false });
    const [typedInput, setTypedInput] = useState('');
    const [undoVisible, setUndoVisible] = useState(false);
    const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onUndoRef = useRef<(() => void | Promise<void>) | undefined>(undefined);

    const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            setState({
                ...DEFAULTS,
                ...opts,
                open: true,
                resolve,
            });
            setTypedInput('');
        });
    }, []);

    const close = useCallback((ok: boolean) => {
        setState(prev => {
            prev.resolve?.(ok);
            return { ...prev, open: false, resolve: undefined };
        });
        setTypedInput('');
    }, []);

    const handleCancel = useCallback(() => {
        close(false);
    }, [close]);

    const handleConfirm = useCallback(() => {
        const opts = state;
        close(true);
        // If undo is configured, show the toast and arm the callback.
        if (opts.onUndo && opts.undoGraceMs && opts.undoGraceMs > 0) {
            onUndoRef.current = opts.onUndo;
            setUndoVisible(true);
            if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
            undoTimerRef.current = setTimeout(() => {
                setUndoVisible(false);
                onUndoRef.current = undefined;
            }, opts.undoGraceMs);
        }
    }, [state, close]);

    const handleUndo = useCallback(async () => {
        const fn = onUndoRef.current;
        onUndoRef.current = undefined;
        setUndoVisible(false);
        if (undoTimerRef.current) {
            clearTimeout(undoTimerRef.current);
            undoTimerRef.current = null;
        }
        if (fn) {
            try {
                await fn();
            } catch (err) {
                console.error('[ConfirmDialog] Undo failed:', err);
            }
        }
    }, []);

    // One shared trap, not a second implementation: it cycles Tab, focuses the
    // first control on open AND restores focus to whatever opened the dialog —
    // the hand-rolled handler it replaces did the first two and stranded focus
    // on a removed node afterwards.
    const dialogRef = useFocusTrap<HTMLDivElement>(state.open);
    useEscapeClose(state.open, handleCancel);

    // Cleanup any pending undo timer on unmount.
    useEffect(() => {
        return () => {
            if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        };
    }, []);

    const ConfirmDialogComponent = (
        <>
            {state.open && (
                <div className="fixed inset-0 z-confirm flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60"
                        onClick={handleCancel}
                    />
                    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" className="relative w-full max-w-md bg-zinc-900 border border-hairline rounded-bubble shadow-elevated overflow-hidden animate-fade-in">
                        <div className="p-6">
                            <div className="flex items-start gap-4">
                                {state.destructive && (
                                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
                                        <TrashIcon className="h-5 w-5" aria-hidden="true" />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                     <h3 id="confirm-dialog-title" className="text-lg font-semibold text-zinc-100">{state.title}</h3>
                                    {state.message && (
                                        <p className="mt-1.5 text-ui-base text-zinc-400 leading-relaxed">{state.message}</p>
                                    )}
                                    {state.typedConfirm && (
                                        <div className="mt-4">
                                            <label
                                                htmlFor="confirm-typed-input"
                                                className="block text-ui-dense font-semibold uppercase tracking-widest text-zinc-500"
                                            >
                                                {state.typedConfirmHint ?? `Type ${state.typedConfirm} to confirm`}
                                            </label>
                                            <input
                                                id="confirm-typed-input"
                                                data-testid="confirm-typed-input"
                                                type="text"
                                                value={typedInput}
                                                onChange={e => setTypedInput(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter' && typedInput === state.typedConfirm) {
                                                        handleConfirm();
                                                    }
                                                }}
                                                autoComplete="off"
                                                spellCheck={false}
                                                autoFocus
                                                className="mt-1.5 w-full rounded-control border border-line bg-zinc-950 px-2.5 py-1.5 font-mono text-ui-base text-zinc-100 placeholder-zinc-600 focus:border-rose-400/50 focus:outline-none"
                                                placeholder={state.typedConfirm}
                                            />
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={handleCancel}
                                    className="flex-shrink-0 p-1.5 text-zinc-500 hover:text-zinc-300 rounded-control hover:bg-zinc-800 transition-colors"
                                    aria-label="Close"
                                >
                                    <CloseIcon className="h-4 w-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                        <div className="px-6 py-4 bg-zinc-900 border-t border-hairline flex items-center justify-end gap-3">
                            <button
                                onClick={handleCancel}
                                className="px-4 py-2 text-ui-base font-medium text-zinc-300 hover:text-white rounded-control hover:bg-zinc-800 transition-colors"
                            >
                                {state.cancelLabel}
                            </button>
                            <button
                                onClick={handleConfirm}
                                disabled={state.typedConfirm !== undefined && typedInput !== state.typedConfirm}
                                data-testid="confirm-dialog-confirm"
                                className={`px-4 py-2 text-ui-base font-semibold rounded-control transition-colors ${state.destructive
                                    ? 'bg-rose-500 enabled:hover:bg-rose-600 text-white disabled:bg-zinc-700 disabled:text-zinc-500'
                                    : 'bg-accent enabled:hover:bg-amber-500 text-accent-ink disabled:bg-zinc-700 disabled:text-zinc-500'
                                    }`}
                            >
                                {state.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Undo toast — role=status because it APPEARS on its own after a
                confirmed delete; without a live region a screen reader never
                hears "Action completed", and the 5s grace window closes. */}
            {undoVisible && (
                <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[101] animate-fade-in">
                    <div className="flex items-center gap-4 px-4 py-3 bg-zinc-800 border border-hairline rounded-bubble">
                        <span className="text-ui-base text-zinc-200">Action completed</span>
                        <button
                            type="button"
                            onClick={handleUndo}
                            className="text-ui-base font-semibold text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                            Undo
                        </button>
                    </div>
                </div>
            )}
        </>
    );

    return { confirm, ConfirmDialogComponent };
}
