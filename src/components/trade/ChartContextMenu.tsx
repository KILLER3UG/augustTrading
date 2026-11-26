/**
 * ChartContextMenu — clean 4-action matte-monochrome menu opened either by
 * clicking the right price-axis `+` button or by right-clicking on the Desk
 * chart canvas at cursor price `$P`.
 *
 * Actions:
 *  1. Draw Horizontal Line @ $P
 *  2. Arm Price Watch @ $P
 *  3. Stage Paper Limit Long/Short @ $P (guarded by Plan Mode & Paper Mode)
 *  4. Ask August about $P
 *
 * Strictly `zinc-*` surfaces + semantic emerald/rose only on Long/Short side
 * accent (`check:palette = 0`, zero glassmorphism).
 */

import React from 'react';
import { BellIcon, MessageSquare, Minus, Target } from '../shared/Icons';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { fmtPrice } from '../../utils/formatters';

export interface ChartContextMenuProps {
    open: boolean;
    x: number;
    y: number;
    containerWidth: number;
    containerHeight: number;
    symbol: string;
    price: number;
    markPrice: number | null;
    planMode: boolean;
    paperEnabled: boolean;
    onClose: () => void;
    onDrawHline: (price: number) => void;
    onArmWatch: (price: number) => void;
    onStagePaperLimit: (price: number, side: 'long' | 'short') => void;
    onAskAugust: (price: number) => void;
}

export const ChartContextMenu: React.FC<ChartContextMenuProps> = ({
    open,
    x,
    y,
    containerWidth,
    containerHeight,
    symbol,
    price,
    markPrice,
    planMode,
    paperEnabled,
    onClose,
    onDrawHline,
    onArmWatch,
    onStagePaperLimit,
    onAskAugust,
}) => {
    useEscapeClose(open, onClose);
    if (!open || !Number.isFinite(price) || price <= 0) return null;

    const menuW = 248;
    const menuH = 166;
    const left = Math.max(8, Math.min(Math.round(x), Math.max(8, containerWidth - menuW - 8)));
    const top = Math.max(8, Math.min(Math.round(y), Math.max(8, containerHeight - menuH - 8)));

    const priceLabel = fmtPrice(price);
    const side: 'long' | 'short' = markPrice !== null && Number.isFinite(markPrice) && price > markPrice
        ? 'short'
        : 'long';
    const sideLabel = side === 'long' ? 'Long' : 'Short';
    const paperDisabled = planMode || !paperEnabled;
    const paperDisabledReason = planMode
        ? 'Disabled in Plan Mode (read-only)'
        : !paperEnabled
            ? 'Enable Paper Mode in Settings'
            : undefined;

    return (
        <>
            <div
                className="fixed inset-0 z-shield"
                aria-hidden="true"
                onClick={onClose}
                onContextMenu={(ev) => { ev.preventDefault(); onClose(); }}
            />
            <div
                data-testid="chart-context-menu"
                role="menu"
                aria-label={`Chart actions at ${priceLabel}`}
                style={{ left, top }}
                className="motion-popover-in absolute z-flyout w-[248px] rounded-lg border border-hairline bg-zinc-950 p-1 shadow-elevated"
            >
                <div className="flex items-center justify-between border-b border-hairline px-2 py-1">
                    <span className="font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                        {symbol.replace(/USDT$/i, '')}
                    </span>
                    <span className="font-mono text-ui-2xs tabular-nums text-zinc-300">
                        ${priceLabel}
                    </span>
                </div>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="ctx-draw-hline"
                    onClick={() => { onDrawHline(price); onClose(); }}
                    className="mt-0.5 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                >
                    <Minus className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="truncate">Draw Horizontal Line @ ${priceLabel}</span>
                </button>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="ctx-arm-watch"
                    onClick={() => { onArmWatch(price); onClose(); }}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                >
                    <BellIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="truncate">Arm Price Watch @ ${priceLabel}</span>
                </button>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="ctx-stage-paper"
                    disabled={paperDisabled}
                    title={paperDisabledReason ?? `Stage Paper Limit ${sideLabel} @ $${priceLabel}`}
                    onClick={() => {
                        if (paperDisabled) return;
                        onStagePaperLimit(price, side);
                        onClose();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                    <span className="flex min-w-0 items-center gap-2">
                        <Target
                            className={`h-3.5 w-3.5 shrink-0 ${side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}
                            aria-hidden="true"
                        />
                        <span className="truncate">Stage Paper Limit {sideLabel} @ ${priceLabel}</span>
                    </span>
                    {planMode && (
                        <span className="shrink-0 font-mono text-[9px] uppercase text-zinc-500">Plan</span>
                    )}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="ctx-ask-august"
                    onClick={() => { onAskAugust(price); onClose(); }}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-200 transition-colors hover:bg-white/[0.06]"
                >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="truncate">Ask August about ${priceLabel}</span>
                </button>
            </div>
        </>
    );
};
