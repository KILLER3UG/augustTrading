/**
 * signalCalibration — does the conviction number mean anything yet?
 *
 * Two pure aggregates over the settled ledger, both refusing to speak before
 * the sample can support them:
 *
 *  · `calibrationVerdict` — Spearman rank correlation between the model's
 *    self-reported conviction (1-4) and the resolved outcome R, over fills
 *    that carry a conviction. A positive IC means higher claimed evidence
 *    has, so far, resolved better; an inverse one means the scale is
 *    anti-signal and SHOULD be said out loud. Flat is the honest default at
 *    small n.
 *  · `fillRealismSummary` — the mean |entryOpenR| over fills: how far the
 *    trigger bar's open sat from the assumed entry fill, i.e. how much the
 *    resolver's limit-fill assumption could have cost. A small number is the
 *    resolver's honesty being cheap; a large one says the assumed fills are
 *    fiction the tape rarely printed.
 *
 * Both read the ledger as it is — no fetch, no model, no gate. Neither blocks
 * anything: calibration is a measurement the trader reads, not a rule.
 */

import type { SignalRow } from '../../types/signal';

/** Below this many conviction-bearing fills the verdict says insufficient. */
export const MIN_CALIBRATION_SAMPLE = 10;
/** |rank IC| at or above this reads as positive/inverse; below it is flat. */
export const CALIBRATION_IC_THRESHOLD = 0.2;

const rankOf = (values: readonly number[]): number[] => {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    for (let i = 0; i < indexed.length; i += 1) {
        // Average ranks for ties: a group spanning positions [i..j] shares
        // their mean, so a tie never fakes a strict ordering.
        let j = i;
        while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
        const mean = (i + j) / 2 + 1;
        for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = mean;
        i = j;
    }
    return ranks;
};

/** Spearman rank correlation. Null when fewer than 2 pairs or when either
 *  side has no variance to rank — a constant is not a correlation. */
export const spearmanRankIC = (pairs: readonly { x: number; y: number }[]): number | null => {
    if (pairs.length < 2) return null;
    const rx = rankOf(pairs.map(p => p.x));
    const ry = rankOf(pairs.map(p => p.y));
    const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
    const my = ry.reduce((a, b) => a + b, 0) / ry.length;
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < rx.length; i += 1) {
        cov += (rx[i] - mx) * (ry[i] - my);
        vx += (rx[i] - mx) ** 2;
        vy += (ry[i] - my) ** 2;
    }
    if (vx === 0 || vy === 0) return null;
    return cov / Math.sqrt(vx * vy);
};

export interface CalibrationVerdict {
    /** Fills that carried a conviction and a finite outcomeR. */
    n: number;
    rankIC: number | null;
    verdict: 'insufficient' | 'positive' | 'flat' | 'inverse';
}

export const calibrationVerdict = (rows: readonly SignalRow[]): CalibrationVerdict => {
    const pairs = rows
        .filter(r => (r.status === 'won' || r.status === 'lost' || r.status === 'expired'))
        .map(r => ({ x: r.signal.conviction, y: r.resolution?.outcomeR }))
        .filter((p): p is { x: number; y: number } =>
            typeof p.x === 'number' && Number.isFinite(p.x)
            && typeof p.y === 'number' && Number.isFinite(p.y));
    const ic = spearmanRankIC(pairs);
    if (pairs.length < MIN_CALIBRATION_SAMPLE || ic === null) {
        return { n: pairs.length, rankIC: ic, verdict: 'insufficient' };
    }
    return {
        n: pairs.length,
        rankIC: ic,
        verdict: ic >= CALIBRATION_IC_THRESHOLD ? 'positive'
            : ic <= -CALIBRATION_IC_THRESHOLD ? 'inverse'
                : 'flat',
    };
};

export interface FillRealism {
    /** Fills that carried an entryOpenR measurement. */
    n: number;
    /** Mean |entryOpenR| in R — the average distance the trigger bar's open
     *  sat from the assumed entry fill. Null until a fill carries one. */
    meanAbsEntryR: number | null;
    /** Mean |exitOpenR| over fills that carry one — the same measure on the
     *  exit bar. Null until then. */
    meanAbsExitR: number | null;
}

export const fillRealismSummary = (rows: readonly SignalRow[]): FillRealism => {
    const fills = rows.filter(r => r.status === 'won' || r.status === 'lost' || r.status === 'expired');
    const entries = fills
        .map(r => r.resolution?.entryOpenR)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const exits = fills
        .map(r => r.resolution?.exitOpenR)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const meanAbs = (xs: readonly number[]): number | null =>
        xs.length === 0 ? null : xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
    return {
        n: entries.length,
        meanAbsEntryR: meanAbs(entries),
        meanAbsExitR: meanAbs(exits),
    };
};
