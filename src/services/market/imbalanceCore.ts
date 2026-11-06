/**
 * imbalanceCore — fair value gaps with the state a trader tracks, pure math.
 *
 * Detection is REUSED from `utils/smcStructure.detectFvg` (the one FVG
 * detector — a second one is how the packet and the tool drift apart). This
 * module adds what the packet does not carry: the gap's size in ATR units,
 * the displacement check on the candle that created it, its age, and how
 * deeply later price has filled it (untouched → partial → filled through the
 * midpoint → filled through the far edge). Order blocks are deliberately NOT
 * here — weakest evidence in the catalog, added last per the tools-upgrade
 * plan.
 */

import type { Kline } from '../../types/message';
import { detectFvg, type Fvg } from '../../utils/smcStructure';

export interface ImbalanceRead {
    direction: 'bullish' | 'bearish';
    top: number;
    bottom: number;
    midpoint: number;
    /** Gap height in ATR units. */
    sizeAtr: number;
    /** The creating candle's body in ATR units (the displacement check). */
    displacementAtr: number;
    /** Bars since the gap opened. */
    ageBars: number;
    fill: 'untouched' | 'partial' | 'through_midpoint' | 'filled';
    /** How much of the gap's height later price has consumed (0–1). */
    fillPct: number;
}

export interface ImbalancesOptions {
    lookback?: number;
    /** Minimum gap size in ATR units (declared threshold). */
    minSizeAtr?: number;
    /** Minimum creating-candle body in ATR units (displacement requirement). */
    minDisplacementAtr?: number;
    maxGaps?: number;
}

export const readImbalances = (
    candles: Kline[],
    atr: number,
    options: ImbalancesOptions = {},
): ImbalanceRead[] | null => {
    if (!(atr > 0) || candles.length < 10) return null;
    const lookback = options.lookback ?? 60;
    const minSizeAtr = options.minSizeAtr ?? 0.3;
    const minDisplacementAtr = options.minDisplacementAtr ?? 0.8;
    const maxGaps = options.maxGaps ?? 8;
    // detectFvg indexes into the series it is given (openedAt is an index
    // into the completed series minus nothing — it slices its own tail), so
    // hand it the whole completed series and read ages against that.
    const gaps: Fvg[] = detectFvg(candles, lookback, maxGaps);
    if (gaps.length === 0) return [];

    const completed = candles.slice(0, -1); // detectFvg ignores the forming bar
    const reads: ImbalanceRead[] = [];
    for (const g of gaps) {
        const size = g.top - g.bottom;
        const sizeAtr = size / atr;
        if (sizeAtr < minSizeAtr) continue;
        // The displacement candle is the middle of the 3-candle pattern.
        const b = completed[g.openedAt + 1];
        const displacementAtr = b ? Math.abs(b.close - b.open) / atr : 0;
        if (displacementAtr < minDisplacementAtr) continue;

        // Fill depth: how far the deepest later candle reached into the gap.
        let deepest = 0; // 0 = not touched, 1 = through the far edge
        for (let i = g.openedAt + 3; i < completed.length; i++) {
            const c = completed[i];
            const reach = g.direction === 'bullish'
                ? (g.top - c.low) / size
                : (c.high - g.bottom) / size;
            deepest = Math.max(deepest, Math.min(1.5, reach));
        }
        const fillPct = Math.max(0, Math.min(1, deepest));
        const fill: ImbalanceRead['fill'] =
            deepest <= 0 ? 'untouched'
                : deepest >= 1 ? 'filled'
                    : deepest >= 0.5 ? 'through_midpoint'
                        : 'partial';
        reads.push({
            direction: g.direction,
            top: g.top,
            bottom: g.bottom,
            midpoint: g.midpoint,
            sizeAtr: Math.round(sizeAtr * 100) / 100,
            displacementAtr: Math.round(displacementAtr * 100) / 100,
            ageBars: completed.length - 1 - g.openedAt - 2,
            fill,
            fillPct: Math.round(fillPct * 100) / 100,
        });
    }
    return reads;
};
