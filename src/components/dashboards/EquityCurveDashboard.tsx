/**
 * EquityCurveDashboard — cumulative P&L curve (in %) over the decided trade
 * log, with a max-drawdown readout.
 *
 * Unit policy matches journalAnalytics: percent-based (pnlPercent). Trades
 * without a percent (manual dollar-only wins) are excluded from the curve —
 * they still count toward win rate and streaks elsewhere.
 *
 * The card, its header and its loading / empty / error presentation come from
 * the ONE chart wrapper (`components/shared/ChartFrame.tsx`), the same wrapper
 * the canvas candlestick chart uses. This component owns only the Recharts
 * plot — no second frame, no duplicated state copy.
 */

import { chartColor } from '../../utils/themeColors';

import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { LoggedTrade, TradeOutcome } from '../../types';
import { decidedAtOf } from '../../utils/journalAnalytics';
import ChartFrame from '../shared/ChartFrame';

interface EquityCurveDashboardProps {
    trades: LoggedTrade[];
}

export const EquityCurveDashboard: React.FC<EquityCurveDashboardProps> = ({ trades }) => {
    const { points, maxDrawdown, totalPnl, counted } = useMemo(() => {
        const decided = trades
            .filter(t => (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS) && typeof t.pnlPercent === 'number')
            .slice()
            .sort((a, b) => new Date(decidedAtOf(a)).getTime() - new Date(decidedAtOf(b)).getTime());
        let cumulative = 0;
        let peak = 0;
        let worstDd = 0;
        const points = decided.map(t => {
            cumulative += t.pnlPercent as number;
            peak = Math.max(peak, cumulative);
            worstDd = Math.min(worstDd, cumulative - peak);
            return {
                label: new Date(decidedAtOf(t)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                equity: Math.round(cumulative * 10) / 10,
                drawdown: Math.round((cumulative - peak) * 10) / 10,
            };
        });
        return { points, maxDrawdown: Math.round(worstDd * 10) / 10, totalPnl: Math.round(cumulative * 10) / 10, counted: decided.length };
    }, [trades]);

    const pnlPositive = totalPnl >= 0;
    const accent = pnlPositive
        ? chartColor('--color-emerald-400', '#23cf8b')
        : chartColor('--color-rose-400', '#f9808a');

    return (
        <ChartFrame
            className="mb-3 sm:mb-5"
            state={counted === 0 ? 'empty' : 'ready'}
            title="Equity curve"
            subtitle="Cumulative P&L % over decided trades"
            message="No decided trades with a percentage yet — the curve starts once a logged trade settles."
            bodyClassName="h-48 sm:h-56"
            actions={
                <div className="flex items-center gap-3 font-mono text-ui-xs tabular-nums">
                    <span className={pnlPositive ? 'text-emerald-400' : 'text-rose-400'}>{pnlPositive ? '+' : ''}{totalPnl}%</span>
                    <span className="text-zinc-500">Max DD {maxDrawdown}%</span>
                    <span className="text-zinc-600">{counted} trade{counted === 1 ? '' : 's'}</span>
                </div>
            }
        >
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                    <defs>
                        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={accent} stopOpacity={0.25} />
                            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" tick={{ fill: chartColor('--color-zinc-500', '#9a9a9a'), fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={40} />
                    <YAxis tick={{ fill: chartColor('--color-zinc-500', '#9a9a9a'), fontSize: 9 }} tickLine={false} axisLine={false} />
                    <Tooltip
                        contentStyle={{ background: chartColor('--color-zinc-900', '#141414'), border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 11 }}
                        labelStyle={{ color: chartColor('--color-zinc-400', '#b6b6b6') }}
                    />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" />
                    <Area type="monotone" dataKey="equity" stroke={accent} strokeWidth={1.8} fill="url(#equityFill)" dot={false} name="Equity" />
                </AreaChart>
            </ResponsiveContainer>
        </ChartFrame>
    );
};

export default React.memo(EquityCurveDashboard);
