/**
 * Dock V1 views. Each one owns its own state (filter, selected file, chart
 * timeframe) and is MOUNTED ONCE — the dock only toggles which is visible, so
 * switching tabs never resets another tab's work.
 *
 * No chart component is created here: the two chart views both mount the
 * existing `TradingChart`, and both chart renderers in the app share
 * `ChartFrame`'s loading / empty / error presentation.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { Search, FileText, BookOpen, Info } from '../../shared/Icons';
import ChartFrame from '../../shared/ChartFrame';
import ErrorBoundary from '../../shared/ErrorBoundary';
import { EmptyState } from '../../ui/EmptyState';
import StatusPill from '../../ui/StatusPill';
import { useFuturesLiveFeed } from '../../../hooks/useFuturesLiveFeed';
import { getMemoryFiles, getNotebookWriteFailure, subscribeMemoryFilesChanged } from '../../../services/learning/MemoryFilesService';
import { skillIndexRows, type SkillIndexRow } from '../../../services/learning/SkillFileService';
import { artifactCount } from '../../../services/analysis/toolArtifactStore';
import type { MemoryFile } from '../../../types';
import type { ChartInterval } from '../../../utils/chartIntervals';

const TradingChart = React.lazy(() => import('../../trade/TradingChart'));

export interface DockChartProps {
    /** The drawing scope — REQUIRED. The dock's chart draws into the SAME
     *  session bucket as the Analyze chart (the active conversation id), or
     *  the stable 'dock' scope when no conversation is running; two charts of
     *  one instrument keeping two drawing stores meant a shape drawn in the
     *  dock never appeared on the main chart, and vice versa. */
    sessionId: string;
    symbol: string;
    interval: ChartInterval;
    onIntervalChange: (interval: ChartInterval) => void;
}

/* ── Files ───────────────────────────────────────────────────────────────── */

interface FileRow {
    id: string;
    name: string;
    detail: string;
    content: string;
    kind: 'notebook' | 'skill';
}

const FilesView: React.FC = () => {
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rows, setRows] = useState<FileRow[]>(() => buildFileRows());

    useEffect(() => subscribeMemoryFilesChanged(() => setRows(buildFileRows())), []);

    const needle = query.trim().toLowerCase();
    const visible = needle
        ? rows.filter(r => r.name.toLowerCase().includes(needle) || r.detail.toLowerCase().includes(needle))
        : rows;
    const selected = rows.find(r => r.id === selectedId) ?? null;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-3 pb-2 pt-3">
                <div className="flex items-center gap-2 rounded-control border border-hairline bg-zinc-800/70 px-2.5 py-1.5 transition-colors focus-within:border-line">
                    <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                    <input value={query} onChange={e => setQuery(e.target.value)}
                        placeholder="Filter files" aria-label="Filter workspace files"
                        data-testid="dock-files-filter"
                        className="w-full min-w-0 bg-transparent text-ui-dense text-zinc-200 placeholder-zinc-500 outline-none" />
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 custom-scrollbar">
                {visible.length === 0 ? (
                    <EmptyState compact iconVariant="subtle" align="start"
                        icon={<FileText className="h-5 w-5" aria-hidden="true" />}
                        title={needle ? 'No files match that filter' : 'No notebook files yet'}
                        description={needle ? 'Clear the filter to see every file.' : 'Notes the desk writes will appear here.'} />
                ) : (
                    <ul className="motion-list divide-y divide-dashed divide-hairline rounded-card border border-hairline bg-zinc-900/40">
                        {visible.map(row => (
                            <li key={row.id}>
                                <button type="button" onClick={() => setSelectedId(row.id)}
                                    data-testid="dock-file-row"
                                    aria-pressed={selectedId === row.id}
                                    className={`motion-press flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                        selectedId === row.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.03]'
                                    }`}>
                                    {row.kind === 'skill'
                                        ? <BookOpen className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                                        : <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-mono text-ui-dense">{row.name}</span>
                                        <span className="block truncate text-ui-2xs text-zinc-500">{row.detail}</span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {selected && (
                    <div className="mt-3 motion-pop rounded-card border border-hairline bg-zinc-900/40 p-3">
                        <p className="mb-2 flex items-center gap-1.5 font-mono text-ui-xs uppercase tracking-[0.08em] text-zinc-500">
                            <FileText className="h-3 w-3" aria-hidden="true" /> {selected.name}
                        </p>
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-2xs leading-relaxed text-zinc-300 custom-scrollbar">
                            {selected.content || '(empty file)'}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
};

const buildFileRows = (): FileRow[] => {
    const notebook: FileRow[] = getMemoryFiles().files.map((f: MemoryFile) => ({
        id: `notebook:${f.id}`,
        name: f.path || f.name,
        detail: `${f.autoManaged ? 'auto' : 'trader'} · ${f.enabled ? 'in context' : 'off'}`,
        content: f.content,
        kind: 'notebook',
    }));
    const skills: FileRow[] = skillIndexRows().map((s: SkillIndexRow) => ({
        id: `skill:${s.slug}`,
        name: `${s.slug}/SKILL.md`,
        detail: `${s.name} · v${s.version}${s.files.length ? ` · ${s.files.length} files` : ''}${s.formatIssues.length ? ' · out of format' : ''}`,
        content: s.description,
        kind: 'skill',
    }));
    return [...notebook, ...skills];
};

/* ── Charts (one existing renderer, two modes) ───────────────────────────── */

const ChartFallback: React.FC = () => (
    <ChartFrame variant="plain" state="loading" bodyClassName="h-full" testId="dock-chart-loading">
        <div className="h-full w-full" />
    </ChartFrame>
);

export const ChartView: React.FC<DockChartProps> = ({ symbol, interval, onIntervalChange, sessionId }) => (
    <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
            <span className="font-mono text-ui-2xs text-zinc-400">{symbol}</span>
            <StatusPill tone="neutral" kicker>snapshot</StatusPill>
        </div>
        <div className="min-h-0 flex-1">
            <ErrorBoundary pane label="The chart" resetKey={`${symbol}:${interval}`}>
            <Suspense fallback={<ChartFallback />}>
                <TradingChart symbol={symbol} interval={interval} onIntervalChange={onIntervalChange} sessionId={sessionId} />
            </Suspense>
            </ErrorBoundary>
        </div>
    </div>
);

export const LiveView: React.FC<DockChartProps> = ({ symbol, interval, onIntervalChange, sessionId }) => {
    const feed = useFuturesLiveFeed(symbol, interval);
    const isLive = feed.status === 'live';
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
                <span className="font-mono text-ui-2xs text-zinc-400">{symbol}</span>
                <StatusPill tone={isLive ? 'up' : 'warn'} kicker>{isLive ? 'live' : feed.status}</StatusPill>
                {feed.ticker && (
                    <span className="ml-auto font-mono text-ui-2xs tabular-nums text-zinc-300">
                        {feed.ticker.lastPrice.toLocaleString()}
                    </span>
                )}
            </div>
            <div className="min-h-0 flex-1">
                {!isLive && !feed.ticker ? (
                    <ChartFrame variant="plain" state="error" bodyClassName="h-full"
                        message="No live feed yet — the desk is connecting or falling back to polling.">
                        <div className="h-full w-full" />
                    </ChartFrame>
                ) : (
                    <ErrorBoundary pane label="The chart" resetKey={`${symbol}:${interval}`}>
                    <Suspense fallback={<ChartFallback />}>
                        <TradingChart
                            symbol={symbol}
                            interval={interval}
                            onIntervalChange={onIntervalChange}
                            sessionId={sessionId}
                            live={isLive}
                            liveKline={feed.kline}
                            lastPrice={feed.ticker?.lastPrice ?? null}
                            markPrice={feed.markIndex?.markPrice ?? null}
                        />
                    </Suspense>
                    </ErrorBoundary>
                )}
            </div>
        </div>
    );
};

/* ── Evidence ────────────────────────────────────────────────────────────── */

export const EvidenceView: React.FC<{ symbol: string }> = ({ symbol }) => {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 5000);
        return () => clearInterval(id);
    }, []);
    void tick;
    const artifacts = artifactCount();
    const failure = getNotebookWriteFailure();

    return (
        <div className="h-full overflow-y-auto p-3 custom-scrollbar">
            <p className="mb-2 font-mono text-ui-xs uppercase tracking-[0.08em] text-zinc-500">Desk state</p>
            <div className="motion-list divide-y divide-dashed divide-hairline rounded-card border border-hairline bg-zinc-900/40 px-3">
                <div className="flex items-center justify-between gap-2 py-2.5">
                    <span className="text-ui-dense text-zinc-400">Active instrument</span>
                    <span className="font-mono text-ui-dense tabular-nums text-zinc-200">{symbol}</span>
                </div>
                <div className="flex items-center justify-between gap-2 py-2.5">
                    <span className="text-ui-dense text-zinc-400">Tool results in this run</span>
                    <span className="font-mono text-ui-dense tabular-nums text-zinc-200">{artifacts}</span>
                </div>
                <div className="flex items-center justify-between gap-2 py-2.5">
                    <span className="text-ui-dense text-zinc-400">Notebook writes</span>
                    <StatusPill tone={failure ? 'down' : 'up'} kicker>{failure ? 'failing' : 'healthy'}</StatusPill>
                </div>
            </div>

            {artifacts === 0 && (
                <div className="mt-3">
                    <EmptyState compact iconVariant="subtle" align="start"
                        icon={<FileText className="h-5 w-5" aria-hidden="true" />}
                        title="No tool output held yet"
                        description="A desk tool that returns more than the prompt can carry will leave its full result here for this run." />
                </div>
            )}

            {failure && (
                <div className="mt-3 motion-pop rounded-card border border-rose-500/30 bg-rose-500/[0.07] p-3">
                    <p className="text-ui-dense font-semibold text-rose-300">A notebook write did not reach disk</p>
                    <p className="mt-1 text-ui-2xs leading-relaxed text-zinc-400">{failure.message}</p>
                </div>
            )}

            <p className="mt-4 flex items-start gap-1.5 text-ui-2xs leading-relaxed text-zinc-600">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                Tool results are held in memory for the current run only. Nothing here is a trade
                or an order — the desk proposes, deterministic code checks, you decide.
            </p>
        </div>
    );
};

export { FilesView };
