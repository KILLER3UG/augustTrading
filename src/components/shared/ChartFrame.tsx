/**
 * ChartFrame — the ONE wrapper for every chart surface.
 *
 * The app has two chart renderers (`components/trade/TradingChart.tsx` uses
 * lightweight-charts on a canvas; the dashboards use Recharts). They used to
 * each own a card, a loading placeholder, an empty copy and an error line.
 * This wrapper is the shared half: ONE frame, ONE state machine, ONE
 * responsive plot box. The renderer still owns its own plot — no chart code
 * is duplicated and no third chart component is created.
 *
 * `variant="plain"` is for a surface that already owns its chrome (the trade
 * chart's toolbar): it renders only the plot box and the state overlay.
 * `variant="card"` adds the framed panel, title and actions for dashboards
 * and docks. In BOTH variants `children` stay mounted while a state is
 * showing — a canvas host or a Recharts container must keep its size so it
 * measures correctly the moment data arrives.
 *
 * Every transition here is transform/opacity through the `motion-*` tokens;
 * nothing animates a dimension, so a resizing panel never fights a frame.
 */
import React from 'react';
import { AlertCircle, BarChart3, RefreshCw } from './Icons';
import { EmptyState } from '../ui/EmptyState';

export type ChartFrameState = 'loading' | 'empty' | 'error' | 'ready';

export interface ChartFrameProps {
    state: ChartFrameState;
    /** Card header only (`variant="card"`). */
    title?: string;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    /** Copy for the empty / error states. */
    message?: string;
    onRetry?: () => void;
    variant?: 'plain' | 'card';
    /** Sizing for the plot box. Defaults to a flexible, at-least-200px body. */
    bodyClassName?: string;
    className?: string;
    testId?: string;
    children: React.ReactNode;
}

const StateOverlay: React.FC<Pick<ChartFrameProps, 'state' | 'message' | 'onRetry'>> = ({ state, message, onRetry }) => {
    if (state === 'loading') {
        return (
            <div aria-hidden="true" className="motion-fade pointer-events-none absolute inset-0 flex flex-col justify-end gap-2 p-4">
                {[38, 62, 48, 78, 56].map((height, index) => (
                    <div key={index} className="flex items-end gap-1.5" style={{ opacity: 0.5 - index * 0.06 }}>
                        <div className="animate-pulse w-full rounded-control bg-zinc-800" style={{ height }} />
                    </div>
                ))}
            </div>
        );
    }
    if (state === 'empty') {
        return (
            <div className="motion-fade absolute inset-0 flex items-center justify-center bg-zinc-950/75">
                <EmptyState
                    compact
                    iconVariant="subtle"
                    align="center"
                    icon={<BarChart3 className="h-5 w-5" aria-hidden="true" />}
                    title={message ?? 'No chart data yet'}
                />
            </div>
        );
    }
    if (state === 'error') {
        return (
            <div className="motion-fade absolute inset-0 flex items-center justify-center bg-zinc-950/85 p-4">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-5 w-5 text-rose-400" aria-hidden="true" />
                    <p className="max-w-xs text-ui-dense leading-relaxed text-zinc-400">
                        {message ?? 'Chart data is unavailable.'}
                    </p>
                    {onRetry && (
                        <button type="button" onClick={onRetry}
                            className="motion-press mt-1 inline-flex items-center gap-1.5 rounded-control border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-ui-dense font-semibold text-zinc-200 transition-colors hover:bg-zinc-700">
                            <RefreshCw className="h-3 w-3" aria-hidden="true" />
                            Retry
                        </button>
                    )}
                </div>
            </div>
        );
    }
    return null;
};

const ChartFrame: React.FC<ChartFrameProps> = ({
    state, title, subtitle, actions, message, onRetry,
    variant = 'card', bodyClassName = 'min-h-[200px] flex-1', className,
    testId, children,
}) => {
    const body = (
        <div
            data-testid={variant === 'plain' ? testId : undefined}
            className={['relative w-full min-w-0', variant === 'card' ? 'overflow-hidden' : '', bodyClassName, variant === 'plain' ? className : '']
                .filter(Boolean).join(' ')}
        >
            {children}
            {state !== 'ready' && <StateOverlay state={state} message={message} onRetry={onRetry} />}
        </div>
    );

    if (variant === 'plain') return body;

    return (
        <div
            data-testid={testId}
            className={['motion-fade flex min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-card border border-white/[0.06] bg-zinc-900/40', className]
                .filter(Boolean).join(' ')}
        >
            {(title || actions || subtitle) && (
                <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
                    <div className="min-w-0">
                        {title && (
                            <p className="truncate font-mono text-ui-xs font-medium uppercase tracking-[0.08em] text-zinc-400">{title}</p>
                        )}
                        {subtitle && <div className="mt-0.5 text-ui-2xs text-zinc-500">{subtitle}</div>}
                    </div>
                    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
                </header>
            )}
            {body}
        </div>
    );
};

export default React.memo(ChartFrame);
