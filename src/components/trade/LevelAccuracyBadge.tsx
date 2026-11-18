import React, { useMemo } from 'react';
import { scoreDrawnLevel, levelAccuracy } from '../../services/trade/tradePlanLevels';
import type { ChartDrawing } from '../../services/trade/chartDrawings';
import type { Kline } from '../../types';

/**
 * How the model's drawn levels have actually done.
 *
 * `levelAccuracy` shipped model-facing: the seat is told its own standing in
 * the receipt of its next draw. The USER never saw it, which made a real
 * measurement invisible to the one person who could act on it — "this seat
 * draws levels the market ignores" is something you can only fix by switching
 * the model, and you cannot know that without seeing the number.
 *
 * Session-scoped, not per-model, and the reason is a data limitation rather
 * than a design choice: `ChartDrawing` carries no seat or provider stamp, so
 * there is nothing to group by. That is also what makes the multi-model layer
 * work a schema change instead of a rendering change, and it is worth saying
 * out loud rather than shipping a per-model label that cannot be correct.
 *
 * Silent when nothing is judgeable. A badge reading "0 of 0" implies a failing
 * model when it is an empty sample, and a badge that appears and disappears is
 * noise; the model-facing side made the same call for the same reason.
 */

interface Props {
    drawings: ChartDrawing[];
    candles: Kline[];
    className?: string;
}

export const LevelAccuracyBadge: React.FC<Props> = ({ drawings, candles, className = '' }) => {
    const scores = useMemo(() => {
        const hlines = drawings.filter(
            // hline ONLY. A trend or zone has no single price to have been
            // reached; scoring points[0] would measure a price the shape does
            // not claim, and report it as a level the market ignored. A
            // mutation that widened this filter to any shape left the file
            // 7/7 green until the fixture below was fixed — see the test.
            (d) => d.kind === 'hline' && d.points.length > 0 && d.points[0].p > 0,
        );
        if (hlines.length === 0 || candles.length === 0) return [];
        return hlines.map((d) => scoreDrawnLevel(d.points[0].p, candles, d.createdAt / 1000));
    }, [drawings, candles]);

    const { judged, reached, ratio } = levelAccuracy(scores);
    // Nothing judgeable yet: say nothing rather than implying a verdict.
    if (judged === 0) return null;

    // Only draw attention when it is informative. A near-perfect record and a
    // near-empty one both read as "fine" in a single number, and the user is
    // better served by the number itself than by a colour implying more.
    // MONOCHROME (owner 1.4.2): green and red are reserved for price,
    // candles, PnL and the Long/Short badges — an accuracy percentage is
    // neither, so it reads in ink.
    const pct = Math.round((ratio ?? 0) * 100);

    return (
        <div
            className={`flex items-center gap-2 text-ui-sm ${className}`}
            data-testid="level-accuracy-badge"
            title="Of the levels this model drew, how many did price actually reach. A level price never returned to was not read from the chart."
        >
            {/* A DATA readout, so the label keeps the app's uppercase
                micro-label (the readout row's own rule) and the figure keeps
                the monospace tabular figures every number in this app
                carries. */}
            <span className="text-ui-xs font-bold text-zinc-500 uppercase tracking-wider">
                Levels
            </span>
            <span className="font-mono tabular-nums text-zinc-300">{pct}%</span>
            <span className="text-zinc-600">
                reached ({reached}/{judged})
            </span>
        </div>
    );
};

export default LevelAccuracyBadge;
