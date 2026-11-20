/**
 * DrawingInspectorPopover — minimal monochrome inline editor opened on
 * double-clicking any committed chart drawing.
 *
 * Lets the trader edit exact numeric prices (Entry / SL / TP for Long/Short
 * position boxes with live signed R:R via `plannedRiskRewardSigned`, or
 * anchor prices for lines/zones/fibs), edit the label/callout text, or delete
 * the shape. Strictly monochrome `zinc-*` + semantic `emerald-*`/`rose-*`
 * chrome (`check:palette` compliant).
 */

import React, { useMemo, useState } from 'react';
import { Trash2, X } from '../shared/Icons';
import type { ChartDrawing } from '../../services/trade/chartDrawings';
import {
    computePositionBoxMetrics,
    isPositionBoxKind,
} from '../../services/trade/positionBoxMath';

export interface DrawingInspectorPopoverProps {
    drawing: ChartDrawing;
    anchorX: number;
    anchorY: number;
    containerWidth: number;
    containerHeight: number;
    onApply: (updated: ChartDrawing) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
}

const fmtInputPrice = (p: number): string => {
    if (!Number.isFinite(p)) return '';
    if (Math.abs(p) >= 1000) return String(Math.round(p * 100) / 100);
    if (Math.abs(p) >= 1) return String(Math.round(p * 10000) / 10000);
    return String(Number(p.toPrecision(6)));
};

export const DrawingInspectorPopover: React.FC<DrawingInspectorPopoverProps> = ({
    drawing,
    anchorX,
    anchorY,
    containerWidth,
    containerHeight,
    onApply,
    onDelete,
    onClose,
}) => {
    const isPos = isPositionBoxKind(drawing.kind);
    const [label, setLabel] = useState(drawing.label ?? '');
    const [prices, setPrices] = useState<string[]>(() => {
        if (drawing.kind === 'brush') {
            return [fmtInputPrice(drawing.points[0]?.p ?? 0)];
        }
        return drawing.points.slice(0, 3).map(pt => fmtInputPrice(pt.p));
    });

    const parsedPrices = useMemo(
        () => prices.map(raw => {
            const n = Number(raw.trim());
            return Number.isFinite(n) && n > 0 ? n : null;
        }),
        [prices],
    );

    const previewMetrics = useMemo(() => {
        if (!isPos || parsedPrices.length < 3) return null;
        const [e, s, t] = parsedPrices;
        if (e === null || s === null || t === null) return null;
        return computePositionBoxMetrics(drawing.kind as 'long_position' | 'short_position', [
            { t: drawing.points[0]?.t ?? 0, p: e },
            { t: drawing.points[1]?.t ?? 0, p: s },
            { t: drawing.points[2]?.t ?? 0, p: t },
        ]);
    }, [drawing.kind, drawing.points, isPos, parsedPrices]);

    const fieldLabels: string[] = isPos
        ? ['Entry', 'Stop Loss', 'Take Profit']
        : drawing.kind === 'hline' || drawing.kind === 'text'
            ? ['Price']
            : drawing.kind === 'measured_move'
                ? ['Entry', 'Stop', 'Target']
                : drawing.points.slice(0, 2).map((_, idx) => `Anchor ${idx + 1}`);

    const canSubmit = parsedPrices.every(p => p !== null);

    const handleSubmit = (ev: React.FormEvent): void => {
        ev.preventDefault();
        if (!canSubmit) return;
        const nextPoints = drawing.points.map((pt, idx) => {
            if (drawing.kind === 'brush') return { ...pt };
            const edited = parsedPrices[idx];
            return edited !== null && edited !== undefined ? { ...pt, p: edited } : { ...pt };
        });
        const trimmedLabel = label.trim().slice(0, 80);
        onApply({
            ...drawing,
            points: nextPoints,
            label: trimmedLabel || undefined,
        });
        onClose();
    };

    const popW = 228;
    const popH = isPos ? 236 : 188;
    const left = Math.max(48, Math.min(Math.max(48, containerWidth - popW - 12), anchorX + 12));
    const top = Math.max(12, Math.min(Math.max(12, containerHeight - popH - 12), anchorY - 24));

    return (
        <div
            data-testid="drawing-inspector-popover"
            role="dialog"
            aria-label={`Edit ${drawing.shortId ?? drawing.kind} drawing`}
            className="absolute z-30 w-[228px] rounded-bubble border border-hairline bg-zinc-900 p-2.5 shadow-elevated"
            style={{ left, top }}
            onPointerDown={ev => ev.stopPropagation()}
            onKeyDown={ev => {
                if (ev.key === 'Escape') {
                    ev.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-ui-dense font-medium text-zinc-200">
                    <span className="font-mono text-zinc-400">{drawing.shortId ?? '#D'}</span>
                    <span className="capitalize">{drawing.kind.replace('_', ' ')}</span>
                    {drawing.origin === 'agent' && (
                        <span className="rounded-sm bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-400">AI</span>
                    )}
                </div>
                <button
                    type="button"
                    aria-label="Close drawing inspector"
                    onClick={onClose}
                    className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-2">
                <label className="block">
                    <span className="mb-0.5 block text-ui-2xs text-zinc-500">Label</span>
                    <input
                        type="text"
                        data-testid="inspector-label-input"
                        value={label}
                        onChange={ev => setLabel(ev.target.value)}
                        placeholder={drawing.kind === 'text' ? 'Callout text…' : 'Optional label…'}
                        maxLength={80}
                        className="w-full rounded-control border border-hairline bg-zinc-950 px-2 py-1 text-ui-dense text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                </label>

                {drawing.kind !== 'brush' && fieldLabels.map((fieldLabel, idx) => (
                    <label key={fieldLabel} className="block">
                        <span className="mb-0.5 block text-ui-2xs text-zinc-500">{fieldLabel}</span>
                        <input
                            type="number"
                            step="any"
                            data-testid={`inspector-price-${idx}`}
                            value={prices[idx] ?? ''}
                            onChange={ev => {
                                const v = ev.target.value;
                                setPrices(prev => prev.map((item, i) => (i === idx ? v : item)));
                            }}
                            className="w-full rounded-control border border-hairline bg-zinc-950 px-2 py-1 font-mono text-ui-dense text-zinc-100 tabular-nums focus:border-zinc-500 focus:outline-none"
                        />
                    </label>
                ))}

                {previewMetrics && (
                    <div
                        data-testid="inspector-rr-preview"
                        className="flex items-center justify-between rounded-control bg-zinc-950 px-2 py-1 font-mono text-ui-2xs"
                    >
                        <span className={previewMetrics.inverted ? 'text-rose-400' : 'text-zinc-300'}>
                            R:R {previewMetrics.formattedRR}
                        </span>
                        <span className="text-zinc-500">
                            <span className="text-emerald-400">+{previewMetrics.rewardPct.toFixed(2)}%</span>
                            {' / '}
                            <span className="text-rose-400">-{previewMetrics.riskPct.toFixed(2)}%</span>
                        </span>
                    </div>
                )}

                <div className="flex items-center justify-between pt-1">
                    <button
                        type="button"
                        data-testid="inspector-delete-btn"
                        aria-label="Delete drawing"
                        onClick={() => { onDelete(drawing.id); onClose(); }}
                        className="flex h-7 items-center gap-1 rounded-control px-2 text-ui-dense text-rose-400 transition-colors hover:bg-rose-500/10"
                    >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete
                    </button>
                    <button
                        type="submit"
                        data-testid="inspector-apply-btn"
                        disabled={!canSubmit}
                        className="h-7 rounded-control bg-zinc-100 px-3 text-ui-dense font-medium text-zinc-950 transition-colors hover:bg-white disabled:opacity-40"
                    >
                        Apply
                    </button>
                </div>
            </form>
        </div>
    );
};

export default DrawingInspectorPopover;
