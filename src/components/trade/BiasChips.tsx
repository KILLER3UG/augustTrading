/**
 * BiasChips — the dock's code-calculated bias read, right under the Chart AI
 * header: 1D regime, the chart timeframe's regime, and position vs session
 * VWAP. CODE-CALCULATED from the app's own klines (the regime math lives in
 * services/trade/regime — EMA/RSI/VWAP, pure + unit-tested), never model
 * prose; re-pulls on coin/timeframe change and every 60 s, and renders
 * NOTHING until both series arrive — a missing chip beats an invented one.
 * 6px dots, one line, honest failure (nothing until data).
 */

import React, { useEffect, useState } from 'react';
import { fetchKlines } from '../../services/analysis/KlineService';
import { biasChips, type BiasChip } from '../../services/trade/regime';
import { toKlineInterval, type ChartInterval } from '../../utils/chartIntervals';

/** Matches the chart's REST refresh cadence — the regime moves slower than
 *  price, and the kline cache already absorbs most of this traffic. */
const REFRESH_MS = 60_000;

/** Dot colors only: `bull`/`bear` are semantic (gain-side / loss-side, matching
 *  the theme's emerald = up and rose = down), `vwap` is a categorical label
 *  for the session-VWAP reference line — info, not a verdict. `neutral` is the
 *  no-direction state. */
const TONE: Record<BiasChip['tone'], string> = {
    bull: 'bg-emerald-400',
    bear: 'bg-rose-400',
    neutral: 'bg-zinc-500',
    vwap: 'bg-cyan-400',
};

const BiasChips: React.FC<{ symbol: string; interval: ChartInterval }> = ({ symbol, interval }) => {
    const [chips, setChips] = useState<BiasChip[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        setChips(null);
        const load = async (): Promise<void> => {
            try {
                const [cur, day] = await Promise.all([
                    fetchKlines(symbol, toKlineInterval(interval), 200),
                    fetchKlines(symbol, '1d', 60),
                ]);
                if (!cancelled) setChips(biasChips(cur, interval, day));
            } catch { /* fetch failed — stay silent, retry on the next tick */ }
        };
        void load();
        const poll = window.setInterval(() => void load(), REFRESH_MS);
        return () => { cancelled = true; window.clearInterval(poll); };
    }, [symbol, interval]);
    if (!chips || chips.length === 0) return null;
    return (
        /* One quiet line, not three bordered pills. Truncating (not wrapping)
           matters at the dock's 300px floor: a wrapped meta row re-introduces
           the furniture it just shed. */
        <div className="flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap px-5 pb-2 pt-3 text-ui-dense text-zinc-500" data-testid="bias-chips">
            {chips.map((c, i) => (
                <span key={`${c.text}-${i}`} className="inline-flex min-w-0 items-center gap-1.5">
                    {i > 0 && <span aria-hidden className="text-zinc-700">·</span>}
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[c.tone]}`} aria-hidden="true" />
                    <span className="truncate" title={`${c.text} — Code-calculated from klines: EMA9/21 + RSI-14 trend, session VWAP`}>{c.text}</span>
                </span>
            ))}
        </div>
    );
};

export default React.memo(BiasChips);
