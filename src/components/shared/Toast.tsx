/**
 * Toast Notification System
 * Provides visual feedback for user actions and errors
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from './Icons';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
    id: string;
    type: ToastType;
    title: string;
    message?: string;
    duration?: number;
    action?: {
        label: string;
        onClick: () => void;
    };
}

interface ToastContextType {
    toasts: Toast[];
    addToast: (toast: Omit<Toast, 'id'>) => string;
    removeToast: (id: string) => void;
    clearAll: () => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
};

/** Max toasts stacked in the column before the "+N more" cap kicks in. */
const MAX_VISIBLE_TOASTS = 4;

// Convenience methods
export const useToastActions = () => {
    const { addToast } = useToast();

    // Stable identity (addToast is useCallback'd) so consumers can safely
    // include `toast` in their own useCallback deps without re-creating
    // handlers on every render.
    return useMemo(() => ({
        success: (title: string, message?: string, action?: Toast['action']) =>
            addToast({ type: 'success', title, message, action, duration: action ? 15_000 : undefined }),
        error: (title: string, message?: string, action?: Toast['action']) =>
            addToast({ type: 'error', title, message, action, duration: 8000 }),
        // The optional third argument is a per-toast reading budget, not a new
        // tone: a warning that carries two sentences of recovery instructions
        // cannot be read in the 5s a one-line "no provider configured" gets.
        warning: (title: string, message?: string, durationMs?: number) =>
            addToast({ type: 'warning', title, message, ...(durationMs ? { duration: durationMs } : {}) }),
        info: (title: string, message?: string) =>
            addToast({ type: 'info', title, message }),
    }), [addToast]);
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        setToasts(prev => [...prev, { ...toast, id }]);
        return id;
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const clearAll = useCallback(() => {
        setToasts([]);
    }, []);

    return (
        <ToastContext.Provider value={{ toasts, addToast, removeToast, clearAll }}>
            {children}
            <ToastContainer />
        </ToastContext.Provider>
    );
};

const ToastContainer: React.FC = () => {
    const { toasts, removeToast } = useToast();
    // F7: cap the STACKED column at 4 visible toasts with a "+N more" expander
    // — autopilot confirmations and backtest toasts used to pile up unbounded.
    const [expanded, setExpanded] = useState(false);
    const visibleToasts = expanded ? toasts : toasts.slice(-MAX_VISIBLE_TOASTS);
    const hiddenCount = toasts.length - visibleToasts.length;

    return (
        /* BOTTOM-LEFT, compact, and out of the reading columns.
           The chart owns the middle of the Analyze surface and the Chart AI
           dock owns the right edge, header to composer. A centered stack
           covered the price action; a top-right one covered the dock's own
           controls. The bottom-left corner is the one place a transient
           message covers neither the figure a trader is reading nor a panel's
           header/composer. Toasts join the bottom of the stack, so the newest
           message is the one nearest the corner. */
        <div className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-4 z-confirm flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3">
            {hiddenCount > 0 && !expanded && (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="pointer-events-auto self-start rounded-full border border-white/10 bg-zinc-900/90 px-2.5 py-1 text-ui-xs font-semibold text-zinc-400 shadow-lg transition-colors hover:text-zinc-200"
                >
                    +{hiddenCount} more
                </button>
            )}
            {visibleToasts.map(toast => (
                <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
            ))}
        </div>
    );
};

const ToastItem: React.FC<{ toast: Toast; onDismiss: () => void }> = ({ toast, onDismiss }) => {
    const duration = toast.duration ?? 5000;
    // Pause while the reader is on it. A toast is the only place a cause and an
    // action are shown together, and an 8s error can time out mid-read (WCAG
    // 2.2.1). Hover and focus both count; the timer restarts on leave.
    const [paused, setPaused] = useState(false);

    useEffect(() => {
        if (duration > 0 && !paused) {
            const timer = setTimeout(onDismiss, duration);
            return () => clearTimeout(timer);
        }
    }, [duration, paused, onDismiss]);

    // The surface stays neutral; the TYPE lives on the icon and a 2px edge.
    // A whole emerald panel for "outcome detected" read as a trading result
    // instead of a notice, and four of them drowned the screen it floated over.
    const typeStyles = {
        success: { bar: 'bg-emerald-400/70', icon: 'text-emerald-400' },
        error: { bar: 'bg-rose-400/70', icon: 'text-rose-400' },
        warning: { bar: 'bg-amber-400/70', icon: 'text-amber-400' },
        info: { bar: 'bg-cyan-400/70', icon: 'text-cyan-400' },
    };

    const renderIcon = (type: ToastType) => {
        const tone = typeStyles[type].icon;
        switch (type) {
            case 'success':
                return <CheckCircle className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />;
            case 'error':
                return <AlertCircle className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />;
            case 'warning':
                return <AlertTriangle className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />;
            case 'info':
            default:
                return <Info className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />;
        }
    };

    return (
        <div
            className="pointer-events-auto relative animate-fade-in overflow-hidden rounded-card border border-white/[0.08] bg-zinc-900/95 p-4 shadow-2xl shadow-black/50 backdrop-blur-xl"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            // The ROLES carry the politeness. An explicit `aria-live="polite"`
            // used to sit here and OVERRODE `role="alert"`, so every error was
            // announced politely while the comment claimed it shouted.
            role={toast.type === 'error' ? 'alert' : 'status'}
        >
            <span aria-hidden="true" className={`absolute inset-y-3 left-0 w-0.5 rounded-full ${typeStyles[toast.type].bar}`} />
            <div className="flex items-start gap-3">
                <span className="mt-0.5">{renderIcon(toast.type)}</span>
                <div className="min-w-0 flex-1">
                    <p className="text-ui-sm font-semibold leading-5 text-zinc-100">{toast.title}</p>
                    {toast.message && (
                        <p className="mt-1 text-ui-dense leading-relaxed text-zinc-400">{toast.message}</p>
                    )}
                    {toast.action && (
                        <button
                            onClick={() => {
                                toast.action!.onClick();
                                onDismiss();
                            }}
                            className="mt-3 rounded-control bg-white/[0.06] px-3 py-1.5 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-white/[0.1]"
                        >
                            {toast.action.label}
                        </button>
                    )}
                </div>
                <button
                    onClick={onDismiss}
                    className="-mr-1 -mt-1 rounded-control p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                    aria-label="Dismiss"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
};

export default ToastProvider;
