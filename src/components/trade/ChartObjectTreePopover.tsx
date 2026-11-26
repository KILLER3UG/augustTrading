/**
 * ChartObjectTreePopover — compact matte-monochrome Object Tree anchored to
 * the top-right Layers button on the Desk chart bar.
 *
 * Separates AI Plan Levels, User Drawings (`#D1..#Dn`), and Active Studies
 * with 1-click visibility toggle, lock toggle, inline rename (user drawings),
 * click-to-select/focus, and delete. Strictly `zinc-*` + semantic emerald/rose
 * (`check:palette` compliant, zero glassmorphism).
 */

import React, { useState } from 'react';
import { Check, Eye, EyeOff, Lock, Pencil, Trash2, X } from '../shared/Icons';
import type { ChartDrawing } from '../../services/trade/chartDrawings';
import { CHART_INDICATOR_LABELS, type ChartIndicatorId } from '../../services/trade/chartIndicatorSettings';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { fmtPrice } from '../../utils/formatters';

export interface ChartObjectTreePopoverProps {
    open: boolean;
    onClose: () => void;
    userDrawings: ReadonlyArray<ChartDrawing>;
    modelDrawings: ReadonlyArray<ChartDrawing>;
    activeStudies: ReadonlyArray<ChartIndicatorId>;
    selectedId: string | null;
    onSelectDrawing: (id: string) => void;
    onToggleVisibility: (id: string) => void;
    onToggleLock: (id: string) => void;
    onRenameDrawing: (id: string, label: string) => void;
    onDeleteDrawing: (id: string) => void;
    onToggleStudy: (id: ChartIndicatorId) => void;
}

const describeDrawing = (d: ChartDrawing): string => {
    if (d.label?.trim()) return d.label.trim();
    const px = d.points[0]?.p;
    const pxText = Number.isFinite(px) ? ` · ${fmtPrice(px)}` : '';
    return `${d.kind.replace(/_/g, ' ')}${pxText}`;
};

export const ChartObjectTreePopover: React.FC<ChartObjectTreePopoverProps> = ({
    open,
    onClose,
    userDrawings,
    modelDrawings,
    activeStudies,
    selectedId,
    onSelectDrawing,
    onToggleVisibility,
    onToggleLock,
    onRenameDrawing,
    onDeleteDrawing,
    onToggleStudy,
}) => {
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    useEscapeClose(open, () => {
        if (renamingId) {
            setRenamingId(null);
            return;
        }
        onClose();
    });

    if (!open) return null;

    const startRename = (d: ChartDrawing): void => {
        setRenamingId(d.id);
        setRenameDraft(d.label ?? '');
    };

    const commitRename = (id: string): void => {
        onRenameDrawing(id, renameDraft.trim().slice(0, 64));
        setRenamingId(null);
    };

    const renderDrawingRow = (d: ChartDrawing, allowRename: boolean): React.ReactElement => {
        const isSelected = selectedId === d.id;
        const isHidden = d.hidden === true;
        const isLocked = d.locked === true;
        const isRenaming = renamingId === d.id;
        return (
            <div
                key={d.id}
                data-testid={`object-tree-item-${d.shortId ?? d.id}`}
                className={`group flex items-center gap-1 rounded-control px-1.5 py-1 text-ui-dense transition-colors ${
                    isSelected ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
                } ${isHidden ? 'opacity-50' : ''}`}
            >
                <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: d.color || '#a1a1aa' }}
                    aria-hidden="true"
                />
                {isRenaming ? (
                    <form
                        className="flex min-w-0 flex-1 items-center gap-1"
                        onSubmit={ev => {
                            ev.preventDefault();
                            commitRename(d.id);
                        }}
                    >
                        <input
                            autoFocus
                            type="text"
                            data-testid="object-tree-rename-input"
                            value={renameDraft}
                            onChange={ev => setRenameDraft(ev.target.value)}
                            onBlur={() => commitRename(d.id)}
                            maxLength={64}
                            className="min-w-0 flex-1 rounded-[4px] border border-hairline bg-zinc-900 px-1.5 py-0.5 text-ui-2xs text-zinc-100 focus:border-zinc-500 focus:outline-none"
                        />
                        <button
                            type="submit"
                            aria-label="Save name"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-zinc-300 hover:bg-white/[0.08]"
                        >
                            <Check className="h-3 w-3" aria-hidden="true" />
                        </button>
                    </form>
                ) : (
                    <button
                        type="button"
                        onClick={() => onSelectDrawing(d.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                        title={`Select ${d.shortId ?? d.kind}`}
                    >
                        {d.shortId && (
                            <span className="shrink-0 font-mono text-ui-2xs text-zinc-500">{d.shortId}</span>
                        )}
                        <span className="truncate capitalize">{describeDrawing(d)}</span>
                    </button>
                )}
                {!isRenaming && (
                    <div className="flex shrink-0 items-center gap-0.5">
                        {allowRename && !isLocked && (
                            <button
                                type="button"
                                aria-label={`Rename ${d.shortId ?? d.kind}`}
                                title="Rename drawing"
                                onClick={() => startRename(d)}
                                className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                            >
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                        <button
                            type="button"
                            aria-label={isHidden ? `Show ${d.shortId ?? d.kind}` : `Hide ${d.shortId ?? d.kind}`}
                            aria-pressed={isHidden}
                            title={isHidden ? 'Show on chart' : 'Hide on chart'}
                            onClick={() => onToggleVisibility(d.id)}
                            className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                            {isHidden ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : <Eye className="h-3 w-3" aria-hidden="true" />}
                        </button>
                        <button
                            type="button"
                            aria-label={isLocked ? `Unlock ${d.shortId ?? d.kind}` : `Lock ${d.shortId ?? d.kind}`}
                            aria-pressed={isLocked}
                            title={isLocked ? 'Unlock' : 'Lock'}
                            onClick={() => onToggleLock(d.id)}
                            className={`flex h-6 w-6 items-center justify-center rounded-control transition-colors hover:bg-white/[0.06] ${
                                isLocked ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
                            }`}
                        >
                            <Lock className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            disabled={isLocked}
                            aria-label={`Delete ${d.shortId ?? d.kind}`}
                            title={isLocked ? 'Unlock to delete' : 'Delete'}
                            onClick={() => onDeleteDrawing(d.id)}
                            className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-30"
                        >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                    </div>
                )}
            </div>
        );
    };

    const totalCount = modelDrawings.length + userDrawings.length + activeStudies.length;

    return (
        <>
            <div className="fixed inset-0 z-shield" aria-hidden="true" onClick={onClose} />
            <div
                data-testid="chart-object-tree"
                role="dialog"
                aria-label="Chart object tree"
                className="motion-popover-down absolute right-2 top-full z-flyout mt-1 w-72 max-h-[380px] overflow-y-auto rounded-lg border border-hairline bg-zinc-950 p-2 shadow-elevated custom-scrollbar"
            >
                <div className="mb-1.5 flex items-center justify-between border-b border-hairline pb-1.5">
                    <span className="font-mono text-ui-2xs font-semibold uppercase tracking-wider text-zinc-400">
                        Object Tree · {totalCount}
                    </span>
                    <button
                        type="button"
                        aria-label="Close object tree"
                        onClick={onClose}
                        className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>

                {/* Section 1: AI Plan Levels */}
                <div className="mb-2" data-testid="object-tree-section-ai">
                    <p className="mb-1 px-1 text-ui-2xs font-medium text-zinc-500">
                        AI Plan Levels ({modelDrawings.length})
                    </p>
                    {modelDrawings.length === 0 ? (
                        <p className="px-1.5 py-1 text-ui-2xs text-zinc-600">No active AI levels.</p>
                    ) : (
                        <div className="space-y-0.5">{modelDrawings.map(d => renderDrawingRow(d, false))}</div>
                    )}
                </div>

                {/* Section 2: User Drawings */}
                <div className="mb-2 border-t border-hairline pt-2" data-testid="object-tree-section-user">
                    <p className="mb-1 px-1 text-ui-2xs font-medium text-zinc-500">
                        User Drawings ({userDrawings.length})
                    </p>
                    {userDrawings.length === 0 ? (
                        <p className="px-1.5 py-1 text-ui-2xs text-zinc-600">No user drawings on this symbol.</p>
                    ) : (
                        <div className="space-y-0.5">{userDrawings.map(d => renderDrawingRow(d, true))}</div>
                    )}
                </div>

                {/* Section 3: Active Studies */}
                <div className="border-t border-hairline pt-2" data-testid="object-tree-section-studies">
                    <p className="mb-1 px-1 text-ui-2xs font-medium text-zinc-500">
                        Active Studies ({activeStudies.length})
                    </p>
                    {activeStudies.length === 0 ? (
                        <p className="px-1.5 py-1 text-ui-2xs text-zinc-600">Price &amp; volume only.</p>
                    ) : (
                        <div className="space-y-0.5">
                            {activeStudies.map(id => (
                                <div key={id} className="flex items-center justify-between rounded-control px-1.5 py-1 text-ui-dense text-zinc-300 hover:bg-white/[0.04]">
                                    <span className="truncate">{CHART_INDICATOR_LABELS[id]}</span>
                                    <button
                                        type="button"
                                        aria-label={`Hide study ${CHART_INDICATOR_LABELS[id]}`}
                                        title="Hide study"
                                        onClick={() => onToggleStudy(id)}
                                        className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
                                    >
                                        <EyeOff className="h-3 w-3" aria-hidden="true" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};

export default ChartObjectTreePopover;
