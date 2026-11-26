/**
 * ToolVisualCard — deterministic, matte-monochrome inline interactive visualizers
 * rendered inside `ChatTranscriptList` from stored `toolPayloadStore` payloads
 * (`scout_market`, `spot_vs_perp`, `setup_replay`).
 *
 * Strictly zero LLM calls, zero raw SVG generation, zero forbidden hues, zero
 * `backdrop-blur-*`, and every interactive control is `>= 24px`.
 */

import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Check, Copy, MoreHorizontal } from '../../shared/Icons';
import type {
    ScoutVisualModel,
    SetupReplayVisualModel,
    SpotVsPerpVisualModel,
    ToolVisualModel,
} from '../../../services/trade/toolVisualCore';

export interface ToolVisualCardProps {
    visual: ToolVisualModel;
    onJumpToSymbol?: (symbol: string) => void;
}

const CardHeaderMenu: React.FC<{
    summary: string;
    showRaw: boolean;
    onToggleRaw: () => void;
}> = ({ summary, showRaw, onToggleRaw }) => {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);

    const copySummary = (): void => {
        void navigator.clipboard?.writeText(summary).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => { /* clipboard unavailable */ });
        setOpen(false);
    };

    return (
        <div className="relative">
            <button
                type="button"
                aria-label="Visual card options"
                aria-expanded={open}
                data-testid="tool-visual-menu-btn"
                onClick={() => setOpen(v => !v)}
                className="flex h-6 w-6 items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
            >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
                    <div
                        role="menu"
                        className="absolute right-0 top-7 z-30 min-w-[140px] rounded-control border border-hairline bg-zinc-950 p-1 shadow-elevated"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            onClick={copySummary}
                            className="flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-ui-2xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                        >
                            {copied ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
                            {copied ? 'Copied' : 'Copy summary'}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            data-testid="tool-visual-raw-toggle"
                            onClick={() => { onToggleRaw(); setOpen(false); }}
                            className="flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-ui-2xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                        >
                            {showRaw ? 'Hide raw payload' : 'Raw payload'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};

const ScoutVisualBody: React.FC<{
    visual: ScoutVisualModel;
    onJumpToSymbol?: (symbol: string) => void;
}> = ({ visual, onJumpToSymbol }) => {
    const [activeSymbol, setActiveSymbol] = useState<string>(visual.items[0]?.symbol ?? '');
    const selected = useMemo(
        () => visual.items.find(i => i.symbol === activeSymbol) ?? visual.items[0],
        [visual.items, activeSymbol],
    );
    const maxAbsScore = useMemo(
        () => Math.max(10, ...visual.items.map(i => Math.abs(i.score))),
        [visual.items],
    );

    if (!selected) return null;

    return (
        <div className="space-y-3">
            {/* Clickable symbol pill tabs */}
            <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Scouted symbols">
                {visual.items.map(item => {
                    const active = item.symbol === selected.symbol;
                    const shortSym = item.symbol.replace(/USDT$/i, '');
                    return (
                        <button
                            key={item.symbol}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            data-testid={`visual-tab-${item.symbol}`}
                            onClick={() => setActiveSymbol(item.symbol)}
                            className={`h-6 rounded-control border px-2 font-mono text-ui-2xs font-medium tabular-nums transition-colors ${
                                active
                                    ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                                    : 'border-hairline bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                            }`}
                        >
                            {shortSym} <span className="text-zinc-500">{item.score}</span>
                        </button>
                    );
                })}
            </div>

            {/* Synchronized Edge Score comparison bars */}
            <div className="space-y-1.5">
                {visual.items.map(item => {
                    const active = item.symbol === selected.symbol;
                    const pct = Math.max(6, Math.min(100, Math.round((Math.max(0, item.score) / maxAbsScore) * 100)));
                    return (
                        <button
                            key={item.symbol}
                            type="button"
                            onClick={() => setActiveSymbol(item.symbol)}
                            className={`flex min-h-[26px] w-full items-center gap-2 rounded-control px-1.5 py-0.5 text-left transition-colors ${
                                active ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                            }`}
                        >
                            <span className={`w-14 shrink-0 font-mono text-ui-2xs font-semibold ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                                {item.symbol.replace(/USDT$/i, '')}
                            </span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800/90">
                                <div
                                    className={`h-full rounded-full transition-all ${
                                        item.timedOut
                                            ? 'bg-zinc-600'
                                            : active
                                                ? 'bg-emerald-400'
                                                : 'bg-zinc-400/80'
                                    }`}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            <span className="w-8 shrink-0 text-right font-mono text-ui-2xs tabular-nums text-zinc-300">
                                {item.score}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Active symbol telemetry footer + 1-click Jump to chart */}
            <div
                data-testid="visual-active-detail"
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-hairline bg-zinc-950/70 px-2.5 py-2"
            >
                <div className="min-w-0 space-y-0.5 font-mono text-ui-2xs">
                    <div className="text-zinc-200">
                        <span className="font-semibold text-zinc-100">{selected.symbol}</span>
                        {' · '}
                        <span>{selected.regimeLabel}</span>
                    </div>
                    <div className="text-zinc-400">
                        flow: <span className="text-zinc-200">{selected.flowRegime.replace(/_/g, ' ')}</span>
                        {selected.basisBps !== null && (
                            <>
                                {' · '}basis: <span className="tabular-nums text-zinc-200">{selected.basisBps.toFixed(1)} bps</span>
                            </>
                        )}
                        {selected.divergence && (
                            <>
                                {' · '}div: <span className="text-zinc-200">{selected.divergence}</span>
                            </>
                        )}
                    </div>
                </div>
                {onJumpToSymbol && (
                    <button
                        type="button"
                        data-testid="visual-jump-chart"
                        onClick={() => onJumpToSymbol(selected.symbol)}
                        className="flex h-7 shrink-0 items-center gap-1 rounded-control border border-hairline bg-zinc-900 px-2.5 text-ui-2xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
                    >
                        Jump to chart
                        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                )}
            </div>
        </div>
    );
};

const SpotVsPerpVisualBody: React.FC<{
    visual: SpotVsPerpVisualModel;
    onJumpToSymbol?: (symbol: string) => void;
}> = ({ visual, onJumpToSymbol }) => {
    const maxPct = Math.max(10, Math.abs(visual.spotDeltaSharePct), Math.abs(visual.perpDeltaSharePct));
    const rows = [
        { label: 'Spot CVD share', pct: visual.spotDeltaSharePct, cvd: visual.spotCvd },
        { label: 'Perp CVD share', pct: visual.perpDeltaSharePct, cvd: visual.perpCvd },
    ];

    return (
        <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2 font-mono text-ui-2xs">
                <span className="rounded-control border border-hairline bg-zinc-950 px-2 py-0.5 font-semibold text-zinc-100">
                    {visual.regime.replace(/_/g, ' ')}
                </span>
                {visual.basisBps !== null && (
                    <span className="tabular-nums text-zinc-400">
                        Basis: <span className="text-zinc-200">{visual.basisBps >= 0 ? '+' : ''}{visual.basisBps.toFixed(1)} bps</span>
                    </span>
                )}
                {visual.fundingRatePct !== null && (
                    <span className="tabular-nums text-zinc-400">
                        Funding: <span className="text-zinc-200">{visual.fundingRatePct >= 0 ? '+' : ''}{visual.fundingRatePct.toFixed(3)}%</span>
                    </span>
                )}
                {onJumpToSymbol && (
                    <button
                        type="button"
                        data-testid="visual-jump-chart"
                        onClick={() => onJumpToSymbol(visual.symbol)}
                        className="ml-auto flex h-6 items-center gap-1 rounded-control border border-hairline bg-zinc-950 px-2 text-ui-2xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
                    >
                        Chart <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                )}
            </div>

            <div className="space-y-1.5">
                {rows.map(r => {
                    const widthPct = Math.max(4, Math.min(100, Math.round((Math.abs(r.pct) / maxPct) * 100)));
                    const positive = r.pct >= 0;
                    return (
                        <div key={r.label} className="space-y-0.5">
                            <div className="flex items-center justify-between font-mono text-ui-2xs tabular-nums">
                                <span className="text-zinc-400">{r.label}</span>
                                <span className={positive ? 'text-emerald-400' : 'text-rose-400'}>
                                    {positive ? '+' : ''}{r.pct.toFixed(1)}%
                                </span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                                <div
                                    className={`h-full rounded-full ${positive ? 'bg-emerald-400' : 'bg-rose-400'}`}
                                    style={{ width: `${widthPct}%` }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const SetupReplayVisualBody: React.FC<{ visual: SetupReplayVisualModel }> = ({ visual }) => {
    const [tab, setTab] = useState<'summary' | 'outcomes'>('summary');
    const maxR = Math.max(1, ...visual.outcomes.map(o => Math.abs(o.r)));

    return (
        <div className="space-y-2.5">
            <div className="flex items-center gap-1" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'summary'}
                    data-testid="visual-tab-summary"
                    onClick={() => setTab('summary')}
                    className={`h-6 rounded-control border px-2.5 text-ui-2xs font-medium transition-colors ${
                        tab === 'summary'
                            ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                            : 'border-hairline bg-zinc-950 text-zinc-400 hover:bg-zinc-900'
                    }`}
                >
                    Summary
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'outcomes'}
                    data-testid="visual-tab-outcomes"
                    onClick={() => setTab('outcomes')}
                    className={`h-6 rounded-control border px-2.5 text-ui-2xs font-medium transition-colors ${
                        tab === 'outcomes'
                            ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                            : 'border-hairline bg-zinc-950 text-zinc-400 hover:bg-zinc-900'
                    }`}
                >
                    Outcomes ({visual.outcomes.length})
                </button>
            </div>

            {tab === 'summary' ? (
                <div className="grid grid-cols-4 gap-2 rounded-control border border-hairline bg-zinc-950/70 p-2 font-mono text-ui-2xs tabular-nums">
                    <div>
                        <div className="text-zinc-500">Trades</div>
                        <div className="font-semibold text-zinc-100">{visual.totalTrades}</div>
                    </div>
                    <div>
                        <div className="text-zinc-500">Win rate</div>
                        <div className="font-semibold text-zinc-100">{visual.winRatePct}%</div>
                    </div>
                    <div>
                        <div className="text-zinc-500">Exp R</div>
                        <div className={visual.expectancyR >= 0 ? 'font-semibold text-emerald-400' : 'font-semibold text-rose-400'}>
                            {visual.expectancyR >= 0 ? '+' : ''}{visual.expectancyR.toFixed(2)}R
                        </div>
                    </div>
                    <div>
                        <div className="text-zinc-500">Net R</div>
                        <div className={visual.netR >= 0 ? 'font-semibold text-emerald-400' : 'font-semibold text-rose-400'}>
                            {visual.netR >= 0 ? '+' : ''}{visual.netR.toFixed(2)}R
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-1.5">
                    {visual.outcomes.map((o, idx) => {
                        const pct = Math.max(8, Math.min(100, Math.round((Math.abs(o.r) / maxR) * 100)));
                        const barCls = o.outcome === 'win' ? 'bg-emerald-400' : o.outcome === 'loss' ? 'bg-rose-400' : 'bg-zinc-500';
                        return (
                            <div key={`${o.label}-${idx}`} className="flex items-center gap-2 font-mono text-ui-2xs tabular-nums">
                                <span className="w-16 shrink-0 truncate text-zinc-400">{o.label}</span>
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                                    <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
                                </div>
                                <span className="w-12 shrink-0 text-right text-zinc-300">
                                    {o.r >= 0 ? '+' : ''}{o.r.toFixed(2)}R
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export const ToolVisualCard: React.FC<ToolVisualCardProps> = ({ visual, onJumpToSymbol }) => {
    const [showRaw, setShowRaw] = useState(false);

    const title = visual.kind === 'scout_market'
        ? visual.title
        : visual.kind === 'spot_vs_perp'
            ? `Spot vs. Perp · ${visual.symbol} ${visual.interval}`
            : `Setup Replay · ${visual.symbol} ${visual.interval}`;

    return (
        <div
            data-testid="tool-visual-card"
            data-visual-kind={visual.kind}
            className="mt-1.5 rounded-control border border-hairline bg-zinc-900/70 p-3"
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-ui-2xs font-semibold uppercase tracking-wider text-zinc-300">
                    {title}
                </span>
                <CardHeaderMenu
                    summary={visual.summary}
                    showRaw={showRaw}
                    onToggleRaw={() => setShowRaw(v => !v)}
                />
            </div>

            {showRaw ? (
                <pre
                    data-testid="tool-visual-raw"
                    className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-control border border-hairline bg-zinc-950 p-2 font-mono text-ui-2xs text-zinc-400"
                >
                    {visual.rawText}
                </pre>
            ) : visual.kind === 'scout_market' ? (
                <ScoutVisualBody visual={visual} onJumpToSymbol={onJumpToSymbol} />
            ) : visual.kind === 'spot_vs_perp' ? (
                <SpotVsPerpVisualBody visual={visual} onJumpToSymbol={onJumpToSymbol} />
            ) : (
                <SetupReplayVisualBody visual={visual} />
            )}
        </div>
    );
};

export default React.memo(ToolVisualCard);
