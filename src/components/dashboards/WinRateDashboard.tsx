/**
 * WinRateDashboard - Comprehensive Trading Analytics Dashboard
 * Features real charts using recharts library
 */

import React, { useMemo, useState } from 'react';
import {
    AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
    ResponsiveContainer, Cell
} from 'recharts';
import { BarChart3 } from '../shared/Icons';
import { LoggedTrade, TradeOutcome } from '../../types';
import { decidedAtOf } from '../../utils/journalAnalytics';
import { EmptyState } from '../ui/EmptyState';
import StatusPill from '../ui/StatusPill';
import { buildCalibrationLedger, ledgerFramingLine, brierQuality } from '../../services/validation/CalibrationLedgerService';
import { buildDisciplineAnalytics } from '../../utils/disciplineAnalytics';
import { fmtPercent } from '../../utils/formatters';
import { chartColor } from '../../utils/themeColors';
import {
    calculateOverallStats,
    calculatePerformanceByConfidence,
    calculatePerformanceByCoin,
    calculatePerformanceByFamily,
    calculateStreakData,
    calculateRecentTrends,
    OverallStats,
    ConfidenceStats,
    CoinStats,
    FamilyStats,
    StreakData,
    TrendDataPoint
} from '../../utils/dashboardUtils';

interface WinRateDashboardProps {
    trades: LoggedTrade[];
}

// Color constants — Minara chart palette; each series/bucket is a distinct
// hue so families stay separable (the old monochrome map reused grays, so
// e.g. Family A and Family C drew identical lines).
//
// Every entry reads its token off :root THROUGH A GETTER, not a plain call:
// in dev the style tag is injected by JS after this module is evaluated, so a
// value captured at import time would fall back to the literal forever and
// never track a theme change. The getters keep the `COLORS.x` call sites
// exactly as they were and still resolve at render time.
const COLORS = {
    get cyan() { return chartColor('--color-teal-500', '#42d0ff'); },
    get emerald() { return chartColor('--color-emerald-400', '#23cf8b'); },
    get rose() { return chartColor('--color-rose-500', '#f6465d'); },
    get amber() { return chartColor('--color-amber-500', '#f08800'); },
    // Was `orange` reading `--color-brand-end` — a CHROME token doing data duty,
    // and it drew pink, not orange. The 2026-10-27 ruling flattened the brand
    // stops to ink, so a borrowed chrome token here would have silently turned
    // the Low tier's marker white and invisible against the ink ramp. Named for
    // the hue it actually draws now, off the pink ramp.
    get pink() { return chartColor('--color-pink-500', '#ff538e'); },
    get purple() { return chartColor('--color-purple-500', '#a142ff'); },
    // The one value in this palette that is not a step of any ramp, and so is
    // the one entry that cannot be token-driven without changing what it
    // draws. Left literal on purpose; C9 settles the categorical palette in
    // Phase 4 rather than inventing a ramp step here.
    get blue() { return '#42a1ff'; },
    get zinc() { return chartColor('--color-zinc-500', '#9a9a9a'); }
};

// Lazy for the same reason as COLORS: these are read at render time from the
// charts below, so a plain object literal would freeze the values at import.
const FAMILY_COLORS: Record<string, string> = {
    get 'Family A'() { return COLORS.rose; },
    get 'Family B'() { return COLORS.emerald; },
    get 'Family C'() { return COLORS.blue; },
    get 'Omega'() { return COLORS.purple; }
};

const CONFIDENCE_COLORS: Record<string, string> = {
    get 'High'() { return COLORS.emerald; },
    get 'Medium'() { return COLORS.amber; },
    get 'Low'() { return COLORS.pink; },
    get 'Avoid'() { return COLORS.rose; }
};

// Custom tooltip for charts
const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-zinc-900 border border-hairline rounded-bubble px-3 py-2 shadow-xl">
                <p className="text-ui-xs text-zinc-400 uppercase tracking-wider mb-1">{label}</p>
                {payload.map((entry: any, index: number) => (
                    <p key={index} className="text-ui-base font-bold" style={{ color: entry.color }}>
                        {entry.name}: {entry.value}{entry.name === 'winRate' ? '%' : ''}
                    </p>
                ))}
            </div>
        );
    }
    return null;
};

// Date range presets
const DATE_PRESETS = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: 'All', days: 0 }
];

const WinRateDashboard: React.FC<WinRateDashboardProps> = ({ trades }) => {
    // Date range state
    const [selectedPreset, setSelectedPreset] = useState<number>(30); // Default 30 days
    const [customStartDate, setCustomStartDate] = useState<string>('');
    const [customEndDate, setCustomEndDate] = useState<string>('');
    const [isCustomRange, setIsCustomRange] = useState(false);

    // Filter trades by date range
    const filteredTrades = useMemo(() => {
        if (isCustomRange && customStartDate && customEndDate) {
            const start = new Date(customStartDate);
            const end = new Date(customEndDate);
            end.setHours(23, 59, 59, 999); // Include entire end day
            return trades.filter(t => {
                const tradeDate = new Date(decidedAtOf(t));
                return tradeDate >= start && tradeDate <= end;
            });
        } else if (selectedPreset === 0) {
            return trades; // All time
        } else {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - selectedPreset);
            return trades.filter(t => new Date(decidedAtOf(t)) >= cutoffDate);
        }
    }, [trades, selectedPreset, isCustomRange, customStartDate, customEndDate]);

    // Calculate all stats using filtered trades
    const overallStats = useMemo(() => calculateOverallStats(filteredTrades), [filteredTrades]);
    const confidenceStats = useMemo(() => calculatePerformanceByConfidence(filteredTrades), [filteredTrades]);
    const coinStats = useMemo(() => calculatePerformanceByCoin(filteredTrades), [filteredTrades]);
    const familyStats = useMemo(() => calculatePerformanceByFamily(filteredTrades), [filteredTrades]);
    const streakData = useMemo(() => calculateStreakData(filteredTrades), [filteredTrades]);
    // Calibration ledger (Batch 7): predicted vs realized, by grade + band.
    const ledger = useMemo(() => buildCalibrationLedger(filteredTrades), [filteredTrades]);
    const framingLine = useMemo(() => ledgerFramingLine(ledger), [ledger]);
    const ledgerRows = useMemo(() => [
        ...ledger.byGrade.map(r => ({ key: `g-${r.label}`, ...r, label: `Grade ${r.label}` })),
        ...ledger.byBand.map(r => ({ key: `b-${r.label}`, ...r, label: `${r.label} confidence` })),
    ], [ledger]);
    const discipline = useMemo(() => buildDisciplineAnalytics(filteredTrades), [filteredTrades]);
    // Number of days the trend window should look back. The "All" preset (0) and
    // custom date ranges would otherwise be clamped to the 30-day default inside
    // calculateRecentTrends, silently dropping older trades from the trend chart.
    const trendDays = useMemo(() => {
        if (isCustomRange && customStartDate && customEndDate) {
            const diff = (new Date(customEndDate).getTime() - new Date(customStartDate).getTime()) / (1000 * 60 * 60 * 24);
            return Math.max(1, Math.ceil(diff));
        }
        return selectedPreset === 0 ? 3650 : selectedPreset;
    }, [isCustomRange, customStartDate, customEndDate, selectedPreset]);
    const trendData = useMemo(() => calculateRecentTrends(filteredTrades, trendDays), [filteredTrades, trendDays]);

    // Prepare chart data
    const confidenceChartData = confidenceStats.filter(s => s.total > 0);
    const familyChartData = familyStats.filter(s => s.total > 0);
    const topCoins = coinStats.slice(0, 5);

    const handlePresetClick = (days: number) => {
        setSelectedPreset(days);
        setIsCustomRange(false);
        setCustomStartDate('');
        setCustomEndDate('');
    };

    // Empty state - need at least 3 trades with outcomes (WIN or LOSS)
    const tradesWithOutcomes = trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS);
    if (tradesWithOutcomes.length < 3) {
        return (
            <EmptyState
                icon={<BarChart3 className="w-8 h-8" aria-hidden="true" />}
                title="Not enough data"
                description="Log at least 3 trades with outcomes to see win rate analytics."
                className="h-full"
            />
        );
    }

    return (
        <div className="flex flex-col h-full bg-transparent p-3 sm:p-4 md:p-5 space-y-3 sm:space-y-5 overflow-y-auto">
            {/* Header with Date Range Selector */}
            <div className="flex flex-col gap-2 sm:gap-3 border-b border-hairline pb-3 sm:pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 sm:gap-3">
                        <div className="w-1 h-6 sm:h-8 bg-cyan-500 rounded-full shadow-[0_0_10px_#4d9fff]"></div>
                        <h2 className="text-ui-lg sm:text-xl font-black text-white uppercase tracking-wide">Analytics</h2>
                    </div>
                    <span className="text-ui-xs text-zinc-500 font-mono tabular-nums">
                        {filteredTrades.length} trades
                    </span>
                </div>

                {/* Date Range Controls */}
                <div className="flex flex-col sm:flex-row sm:flex-wrap items-start sm:items-center gap-2">
                    {/* Preset Buttons */}
                    <div className="flex gap-1 bg-zinc-800 rounded-control p-1 border border-hairline w-full sm:w-auto">
                        {DATE_PRESETS.map(preset => (
                            <button
                                key={preset.days}
                                onClick={() => handlePresetClick(preset.days)}
                                /* The selected range is state the screen already
                                   draws (the cyan chip); a range that is only a
                                   colour is invisible to a screen reader and to
                                   any press-level check. */
                                aria-pressed={!isCustomRange && selectedPreset === preset.days}
                                aria-label={preset.days === 0 ? 'Show all-time performance' : `Show the last ${preset.days} days of performance`}
                                className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 text-ui-2xs sm:text-ui-xs font-bold uppercase tracking-wider rounded-control transition-colors duration-[150ms] ease-[var(--ease-snappy)] ${!isCustomRange && selectedPreset === preset.days
                                    ? 'bg-cyan-500 text-white shadow-md'
                                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                    }`}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    {/* Custom Date Range */}
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <input
                            type="date"
                            value={customStartDate}
                            onChange={(e) => {
                                setCustomStartDate(e.target.value);
                                if (e.target.value && customEndDate) setIsCustomRange(true);
                            }}
                            className="flex-1 sm:flex-none px-2 py-1 text-ui-xs font-mono bg-zinc-800 border border-hairline rounded-control text-zinc-300 focus:outline-none focus:border-accent/50"
                        />
                        <span className="text-zinc-600 text-ui-xs">to</span>
                        <input
                            type="date"
                            value={customEndDate}
                            onChange={(e) => {
                                setCustomEndDate(e.target.value);
                                if (customStartDate && e.target.value) setIsCustomRange(true);
                            }}
                            className="flex-1 sm:flex-none px-2 py-1 text-ui-xs font-mono bg-zinc-800 border border-hairline rounded-control text-zinc-300 focus:outline-none focus:border-accent/50"
                        />
                    </div>
                </div>
            </div>

            {/* Top Stats Row */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
                {/* Win Rate */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800 text-center">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-1">Win Rate</div>
                    <div className={`text-xl sm:text-3xl font-black ${overallStats.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {fmtPercent(overallStats.winRate, 0)}
                    </div>
                </div>

                {/* Total Trades */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800 text-center">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-1">Trades</div>
                    <div className="text-xl sm:text-3xl font-black text-white">{overallStats.totalTrades}</div>
                </div>

                {/* Net PnL — dollar PnL from manual captures; autopilot
                    confirms carry pnlPercent only (never pnlAmount), so they
                    are shown as the percent line instead of being invisible. */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800 text-center relative overflow-hidden">
                    {overallStats.totalPnL !== 0 && (
                        <div className={`absolute top-0 left-0 w-full h-1 ${overallStats.totalPnL > 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                    )}
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-1">Net PnL</div>
                    {overallStats.totalPnL !== 0 ? (
                        <div className={`text-lg sm:text-2xl font-mono font-black tabular-nums ${overallStats.totalPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {overallStats.totalPnL >= 0 ? '+' : ''}{overallStats.totalPnL.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                        </div>
                    ) : overallStats.totalPnLPercent !== 0 ? (
                        <div className={`text-lg sm:text-2xl font-mono font-black tabular-nums ${overallStats.totalPnLPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {overallStats.totalPnLPercent >= 0 ? '+' : ''}{fmtPercent(overallStats.totalPnLPercent, 1)}
                        </div>
                    ) : (
                        <div className="text-lg sm:text-2xl font-mono font-black text-zinc-500 tabular-nums">$0</div>
                    )}
                    {overallStats.totalPnL !== 0 && overallStats.totalPnLPercent !== 0 && (
                        <div className={`text-ui-xs font-mono tabular-nums mt-0.5 ${overallStats.totalPnLPercent >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                            {overallStats.totalPnLPercent >= 0 ? '+' : ''}{fmtPercent(overallStats.totalPnLPercent, 1)}
                        </div>
                    )}
                </div>

                {/* Profit Factor */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800 text-center">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-1">Profit Factor</div>
                    <div className={`text-xl sm:text-3xl font-black ${overallStats.profitFactor >= 1.5 ? 'text-cyan-400' : overallStats.profitFactor >= 1 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {overallStats.profitFactor >= 999 ? '∞' : `${overallStats.profitFactor}x`}
                    </div>
                </div>
            </div>

            {/* Calibration ledger (Batch 7): predicted vs realized hit rate by
                grade and confidence band + Brier score. The trust research
                says frequency format beats raw probability — "when the verdict
                says High it hit X% over N" — and no consumer journaling tool
                offers this view. */}
            <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest">Calibration Ledger</div>
                    {ledger.overallBrier !== null && (
                        <span
                            className={`text-ui-xs font-bold tabular-nums px-1.5 py-0.5 rounded-control ${
                                brierQuality(ledger.overallBrier) === 'good'
                                    ? 'text-emerald-400 bg-emerald-500/10'
                                    : brierQuality(ledger.overallBrier) === 'fair'
                                        ? 'text-amber-400 bg-amber-500/10'
                                        : 'text-rose-400 bg-rose-500/10'
                            }`}
                            title={`Brier score over ${ledger.brierN} trades with a declared probability (lower is better; 0.25 = coin flip)`}
                        >
                            Brier {ledger.overallBrier.toFixed(3)}
                        </span>
                    )}
                </div>
                {framingLine && (
                    <p className="text-ui-dense text-zinc-300 mb-2">{framingLine}.</p>
                )}
                <div className="overflow-x-auto">
                    <table className="w-full text-ui-dense">
                        <thead>
                            <tr className="text-zinc-500 uppercase tracking-wider text-ui-2xs">
                                <th className="text-left py-1 font-bold">Verdict</th>
                                <th className="text-right py-1 font-bold">N</th>
                                <th className="text-right py-1 font-bold">Hit</th>
                                <th className="text-right py-1 font-bold">Said</th>
                            </tr>
                        </thead>
                        <tbody className="font-mono">
                            {ledgerRows.map(r => (
                                <tr key={r.key} className="border-t border-hairline text-zinc-300">
                                    <td className="py-1 text-left">{r.label}</td>
                                    <td className="py-1 text-right tabular-nums">{r.n}</td>
                                    <td className="py-1 text-right tabular-nums text-white">{r.n > 0 ? fmtPercent(r.winRate, 0) : '—'}</td>
                                    <td className="py-1 text-right tabular-nums text-zinc-500">{r.avgDeclaredPct !== null ? fmtPercent(r.avgDeclaredPct, 0) : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Discipline analytics (Batch 5): the adherence split, mistake
                cost, post-first-red, and giveback views — the research says
                these changed behavior where raw P&L did not. */}
            <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2">Discipline</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <div className="text-ui-xs text-zinc-400 font-bold mb-1">Plan adherence</div>
                        <table className="w-full text-ui-dense">
                            <tbody className="font-mono">
                                {[discipline.adherence.followed, discipline.adherence.broken].map(r => (
                                    <tr key={r.label} className="border-t border-hairline text-zinc-300">
                                        <td className="py-1">{r.label}</td>
                                        <td className="py-1 text-right tabular-nums">{r.n} trades</td>
                                        <td className="py-1 text-right tabular-nums text-white">{r.n > 0 ? fmtPercent(r.winRate, 0) : '—'}</td>
                                        <td className="py-1 text-right tabular-nums text-zinc-500">{r.n > 0 && Number.isFinite(r.profitFactor) ? `${r.profitFactor.toFixed(2)} PF` : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {discipline.giveback.days > 0 && (
                            <p className="text-ui-xs text-zinc-500 mt-1">
                                {discipline.giveback.days} green day{discipline.giveback.days === 1 ? '' : 's'} finished red — overtrading into a lead.
                            </p>
                        )}
                        {/* Covers only trades whose post-mortem resolved a candle
                            window, so the sample count rides along — these are not
                            book-wide averages until coverage grows. */}
                        {discipline.excursion.n > 0 && (
                            <p className="text-ui-xs text-zinc-500 mt-1" data-testid="discipline-excursion">
                                Over {discipline.excursion.n} measured trade{discipline.excursion.n === 1 ? '' : 's'}: held through −
                                {discipline.excursion.meanMaePct !== null ? fmtPercent(discipline.excursion.meanMaePct, 1) : '—'} on average,
                                {discipline.excursion.captureN > 0
                                    ? ` captured ${discipline.excursion.meanCapturePct !== null ? fmtPercent(discipline.excursion.meanCapturePct, 1) : '—'} of the best move — ${discipline.excursion.captureN} of those had both sides measured.`
                                    : ' capture efficiency needs a best move and a settled percent, and none had both.'}
                            </p>
                        )}
                    </div>
                    <div>
                        <div className="text-ui-xs text-zinc-400 font-bold mb-1">Mistake cost (Σ PnL)</div>
                        {discipline.mistakeCost.length > 0 ? (
                            <table className="w-full text-ui-dense">
                                <tbody className="font-mono">
                                    {discipline.mistakeCost.slice(0, 4).map(r => (
                                        <tr key={r.tag} className="border-t border-hairline text-zinc-300">
                                            <td className="py-1">{r.tag.replace(/_/g, ' ')}</td>
                                            <td className="py-1 text-right tabular-nums text-zinc-500">×{r.n}</td>
                                            <td className={`py-1 text-right tabular-nums ${r.totalPnlUsd < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                                ${Math.round(r.totalPnlUsd).toLocaleString()}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <p className="text-ui-xs text-zinc-600">Tag mistakes when logging — the table builds itself.</p>
                        )}
                        <div className="text-ui-xs text-zinc-400 font-bold mt-2 mb-1">After the day's first red</div>
                        <table className="w-full text-ui-dense">
                            <tbody className="font-mono">
                                {[discipline.afterFirstRed.before, discipline.afterFirstRed.after].map(r => (
                                    <tr key={r.label} className="border-t border-hairline text-zinc-300">
                                        <td className="py-1">{r.label}</td>
                                        <td className="py-1 text-right tabular-nums">{r.n} trades</td>
                                        <td className="py-1 text-right tabular-nums text-white">{r.n > 0 ? fmtPercent(r.winRate, 0) : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Win Rate Trend Chart */}
            <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2 sm:mb-3">Win Rate Trend</div>
                {trendData.length > 1 ? (
                    <div className="h-32">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={trendData}>
                                <defs>
                                    <linearGradient id="winRateGradient" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={COLORS.cyan} stopOpacity={0.4} />
                                        <stop offset="95%" stopColor={COLORS.cyan} stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <XAxis dataKey="date" tick={{ fontSize: 9, fill: chartColor('--color-zinc-600', '#858585') }} axisLine={false} tickLine={false} />
                                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: chartColor('--color-zinc-600', '#858585') }} axisLine={false} tickLine={false} width={25} />
                                <Tooltip content={<CustomTooltip />} />
                                <Area
                                    type="monotone"
                                    dataKey="winRate"
                                    stroke={COLORS.cyan}
                                    strokeWidth={2}
                                    fill="url(#winRateGradient)"
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="h-32 flex items-center justify-center text-zinc-600 text-ui-base">
                        Need more data to show trends
                    </div>
                )}
            </div>

            {/* Performance by Confidence */}
            <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2 sm:mb-3">By Confidence</div>
                {confidenceChartData.length > 0 ? (
                    <div className="h-40">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={confidenceChartData} layout="vertical">
                                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: chartColor('--color-zinc-600', '#858585') }} axisLine={false} tickLine={false} />
                                <YAxis type="category" dataKey="level" tick={{ fontSize: 11, fill: chartColor('--color-zinc-500', '#9a9a9a'), fontWeight: 'bold' }} axisLine={false} tickLine={false} width={60} />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="winRate" radius={[0, 6, 6, 0]} barSize={20}>
                                    {confidenceChartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={CONFIDENCE_COLORS[entry.level]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <EmptyState
                        compact
                        iconVariant="subtle"
                        title="No data available"
                        className="h-24 justify-center"
                    />
                )}
                {/* Legend */}
                <div className="flex flex-wrap justify-center gap-4 mt-2 pt-2 border-t border-hairline">
                    {confidenceStats.map(s => (
                        <div key={s.level} className="text-ui-xs text-zinc-500">
                            <span className="font-bold" style={{ color: CONFIDENCE_COLORS[s.level] }}>{s.level}</span>: {s.wins}W / {s.total}T
                        </div>
                    ))}
                </div>
            </div>

            {/* Pattern Family Performance */}
            <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2 sm:mb-3">Pattern Families</div>
                <div className="grid grid-cols-2 gap-2 sm:gap-3">
                    {familyStats.map(family => {
                        const color = FAMILY_COLORS[family.family] || COLORS.zinc;
                        return (
                            <div
                                key={family.family}
                                className="p-2 sm:p-3 rounded-control border text-center transition-colors duration-[150ms] ease-[var(--ease-snappy)]"
                                style={{
                                    borderColor: `${color}30`,
                                    backgroundColor: `${color}10`
                                }}
                            >
                                <span className="text-ui-2xs sm:text-ui-xs font-bold uppercase tracking-wider block mb-1" style={{ color }}>
                                    {family.family.replace('Family ', '')}
                                </span>
                                <span className="text-lg sm:text-xl font-black block" style={{ color }}>
                                    {family.total > 0 ? fmtPercent(family.winRate, 0) : '-'}
                                </span>
                                <span className="text-ui-micro sm:text-ui-2xs opacity-60 text-zinc-400">
                                    {family.wins}W / {family.total}T
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Top Coins + Streaks */}
            <div className="grid grid-cols-1 gap-3 sm:gap-4">
                {/* Top Coins */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2 sm:mb-3">Top Coins</div>
                    {topCoins.length > 0 ? (
                        <div className="space-y-2">
                            {topCoins.map((coin, idx) => (
                                <div key={coin.coin} className="flex items-center justify-between p-2 bg-zinc-800 rounded-control">
                                    <div className="flex items-center gap-2">
                                        <span className="text-ui-xs text-zinc-600 font-mono tabular-nums w-4">#{idx + 1}</span>
                                        <span className="font-bold text-ui-base text-white">{coin.coin}</span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {coin.pnl !== 0 ? (
                                            <span className={`text-ui-sm font-mono tabular-nums ${coin.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {coin.pnl >= 0 ? '+' : ''}{coin.pnl.toFixed(0)}
                                            </span>
                                        ) : coin.pnlPercent !== 0 ? (
                                            <span className={`text-ui-sm font-mono tabular-nums ${coin.pnlPercent >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {coin.pnlPercent >= 0 ? '+' : ''}{fmtPercent(coin.pnlPercent, 1)}
                                            </span>
                                        ) : null}
                                        <StatusPill tone={coin.winRate >= 50 ? 'up' : 'down'} className="tabular-nums">
                                            {fmtPercent(coin.winRate, 0)}
                                        </StatusPill>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <EmptyState
                            compact
                            iconVariant="subtle"
                            title="No coin data yet"
                        />
                    )}
                </div>

                {/* Streaks */}
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-hairline bg-zinc-800">
                    <div className="text-ui-2xs sm:text-ui-xs text-zinc-500 uppercase font-bold tracking-widest mb-2 sm:mb-3">Streaks</div>
                    <div className="space-y-3 sm:space-y-4">
                        {/* Current Streak */}
                        <div className="flex items-center justify-between p-3 rounded-control" style={{
                            backgroundColor: streakData.currentStreak.type === 'win' ? `${COLORS.emerald}15` : streakData.currentStreak.type === 'loss' ? `${COLORS.rose}15` : `${COLORS.zinc}15`,
                            borderColor: streakData.currentStreak.type === 'win' ? `${COLORS.emerald}30` : streakData.currentStreak.type === 'loss' ? `${COLORS.rose}30` : `${COLORS.zinc}30`,
                            borderWidth: 1
                        }}>
                            <span className="text-ui-sm text-zinc-400 uppercase tracking-wider">Current</span>
                            <span className={`text-lg font-black ${streakData.currentStreak.type === 'win' ? 'text-emerald-400' : streakData.currentStreak.type === 'loss' ? 'text-rose-400' : 'text-zinc-400'}`}>
                                {streakData.currentStreak.count > 0 ? (
                                    <>
                                        {streakData.currentStreak.count} {streakData.currentStreak.type.toUpperCase()}S
                                    </>
                                ) : '-'}
                            </span>
                        </div>

                        {/* Best/Worst */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-control text-center">
                                <span className="text-ui-2xs text-emerald-500 uppercase tracking-wider block mb-1">Best Win Streak</span>
                                <span className="text-2xl font-black text-emerald-400">{streakData.bestWinStreak}</span>
                            </div>
                            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-control text-center">
                                <span className="text-ui-2xs text-rose-500 uppercase tracking-wider block mb-1">Worst Loss Streak</span>
                                <span className="text-2xl font-black text-rose-400">{streakData.worstLossStreak}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Avg Win/Loss */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-emerald-500/20 bg-emerald-500/5 text-center">
                    <div className="text-ui-2xs sm:text-ui-xs text-emerald-500 uppercase font-bold tracking-widest mb-1">Avg Win</div>
                    <div className="text-ui-lg sm:text-xl font-mono font-bold text-emerald-400">
                        +{overallStats.avgWinSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                    </div>
                </div>
                <div className="glass-panel p-3 sm:p-4 rounded-bubble border border-rose-500/20 bg-rose-500/5 text-center">
                    <div className="text-ui-2xs sm:text-ui-xs text-rose-500 uppercase font-bold tracking-widest mb-1">Avg Loss</div>
                    <div className="text-ui-lg sm:text-xl font-mono font-bold text-rose-400">
                        -{overallStats.avgLossSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(WinRateDashboard);
