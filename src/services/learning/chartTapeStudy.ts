/**
 * chartTapeStudy — the full-tape half of `scan_chart_skills`.
 *
 * The scan has always fetched the chart's whole 1000-bar history, but the model
 * only ever SAW a digest: regime segments, pivots, gap counts and the last 40
 * raw bars. "Study the chart" meant trusting code-computed summaries of most of
 * the tape, with no time-of-day read and no list of the actual big moves.
 *
 * This module studies EVERY bar and answers three questions with numbers:
 *
 *  1. WHEN does this chart move? Every bar is sampled with a fixed forward
 *     horizon; the samples are bucketed by hour of the TRADER's clock (PHT) —
 *     mean absolute move, mean signed drift, up share and favourable/adverse
 *     excursion per hour.
 *  2. WHERE were the big moves? A leg is the lowest close in a 24-bar window
 *     followed by a rise of at least 10% (or the mirror for a fall). Each leg
 *     records the entry time, how long it took, and the state BEFORE it
 *     (prior return, volume, range compression, gap, RSI) — the facts a
 *     "turn back time, when should I have been in" skill can be built from.
 *  3. HOW do the candles move? Up/down bar share, body-to-range, closes in the
 *     top third, expansion bars, and consecutive-run lengths.
 *
 * Everything here is pure and covers the whole array it is given. The digest
 * builder is the only thing that may DROP a section for prompt budget, and it
 * names what it dropped — the study itself is never sampled.
 */

import type { ScanCandle } from '../trade/setupScan';
import { rsiSeries } from '../trade/setupScan';
import { phtClock, phtDayYear, phtHourOf } from '../../utils/timezone';

export interface HourStudy {
    hour: number;
    samples: number;
    /** Mean signed forward return over the horizon. */
    meanDrift: number;
    /** Mean |forward return| — the opportunity in the hour, direction aside. */
    meanMove: number;
    upShare: number;
    /** Mean max favourable excursion (positive) and adverse excursion (negative). */
    meanMfe: number;
    meanMae: number;
}

export interface BigMove {
    side: 'up' | 'down';
    startTime: number;
    startPrice: number;
    endTime: number;
    endPrice: number;
    movePct: number;
    bars: number;
    hour: number;
    priorReturn: number;
    volumeRatio: number | null;
    rangeCompression: number | null;
    gapPct: number;
    rsi: number | null;
}

export interface RunStats {
    mean: number;
    median: number;
    max: number;
    count: number;
}

export interface TapeStudy {
    bars: number;
    horizon: number;
    window: number;
    thresholdPct: number;
    samples: number;
    hours: HourStudy[];
    upMoves: BigMove[];
    downMoves: BigMove[];
    /** The largest leg found even when it is below the threshold — so a quiet
     *  tape is reported as "largest +6.2%", never as "no big moves" with no
     *  scale. Null only when the tape is too short to sample. */
    largestUp: BigMove | null;
    largestDown: BigMove | null;
    runs: { up: RunStats; down: RunStats };
    anatomy: {
        upBarShare: number;
        bodyToRange: number;
        closeTopThird: number;
        expansionShare: number;
    };
}

export interface TapeStudyOptions {
    horizon?: number;
    window?: number;
    threshold?: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: readonly number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** All 24 hours, sampled over the whole tape. */
export const studyHours = (candles: readonly ScanCandle[], horizon = 12): { hours: HourStudy[]; samples: number } => {
    const acc = Array.from({ length: 24 }, (_, hour) => ({
        hour, samples: 0, drift: 0, abs: 0, up: 0, mfe: 0, mae: 0,
    }));
    let samples = 0;
    for (let i = 0; i + horizon < candles.length; i += 1) {
        const base = candles[i].close;
        if (!(base > 0)) continue;
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i + 1; j <= i + horizon; j += 1) {
            if (candles[j].high > hi) hi = candles[j].high;
            if (candles[j].low < lo) lo = candles[j].low;
        }
        const fwd = candles[i + horizon].close / base - 1;
        if (!Number.isFinite(fwd) || !Number.isFinite(hi) || !Number.isFinite(lo)) continue;
        const b = acc[phtHourOf(candles[i].time)];
        b.samples += 1;
        b.drift += fwd;
        b.abs += Math.abs(fwd);
        if (fwd > 0) b.up += 1;
        b.mfe += hi / base - 1;
        b.mae += lo / base - 1;
        samples += 1;
    }
    const hours = acc.map(b => ({
        hour: b.hour,
        samples: b.samples,
        meanDrift: b.samples ? b.drift / b.samples : 0,
        meanMove: b.samples ? b.abs / b.samples : 0,
        upShare: b.samples ? b.up / b.samples : 0,
        meanMfe: b.samples ? b.mfe / b.samples : 0,
        meanMae: b.samples ? b.mae / b.samples : 0,
    }));
    return { hours, samples };
};

interface LegScan {
    moves: BigMove[];
    largest: BigMove | null;
}

const volRatio = (candles: readonly ScanCandle[], at: number, short = 3, long = 20): number | null => {
    if (at < long) return null;
    const vols = (a: number, b: number): number[] => candles.slice(a, b).map(c => c.volume ?? 0);
    const recent = vols(at - short, at);
    const base = vols(at - long, at);
    const avgBase = mean(base);
    const avgRecent = mean(recent);
    if (!(avgBase > 0) || !(avgRecent > 0)) return null;
    return avgRecent / avgBase;
};

const compression = (candles: readonly ScanCandle[], at: number, short = 6, long = 24): number | null => {
    if (at < long) return null;
    const range = (c: ScanCandle): number => c.high - c.low;
    const avgShort = mean(candles.slice(at - short, at).map(range));
    const avgLong = mean(candles.slice(at - long, at).map(range));
    if (!(avgLong > 0)) return null;
    return avgShort / avgLong;
};

const legAt = (
    candles: readonly ScanCandle[],
    start: number,
    end: number,
    side: 'up' | 'down',
    rsi: readonly number[],
): BigMove => {
    const startPrice = candles[start].close;
    const endPrice = candles[end].close;
    const prior = start >= 7 ? candles[start - 1].close / candles[start - 7].close - 1 : 0;
    const r = rsi[start - 1];
    return {
        side,
        startTime: candles[start].time,
        startPrice,
        endTime: candles[end].time,
        endPrice,
        movePct: side === 'up' ? endPrice / startPrice - 1 : 1 - endPrice / startPrice,
        bars: end - start,
        hour: phtHourOf(candles[start].time),
        priorReturn: prior,
        volumeRatio: volRatio(candles, start),
        rangeCompression: compression(candles, start),
        gapPct: start > 0 ? candles[start].open / candles[start - 1].close - 1 : 0,
        rsi: Number.isFinite(r) ? r : null,
    };
};

/**
 * Swing legs of at least `threshold` (default 10%) within `window` bars.
 *
 * A leg starts at the LOWEST close of the trailing window and is confirmed by
 * the first later bar that is `threshold` above it; non-overlapping, oldest
 * first. That is exactly "if we could turn back time, entering at that low
 * would have caught the move". The `largest` leg is returned even below the
 * threshold so a quiet tape still has a scale.
 */
export const findBigMoves = (
    candles: readonly ScanCandle[],
    side: 'up' | 'down',
    threshold = 0.10,
    window = 24,
): LegScan => {
    if (candles.length < 10) return { moves: [], largest: null };
    const rsi = rsiSeries([...candles]);
    const moves: BigMove[] = [];
    let largest: BigMove | null = null;
    let lastEnd = -1;
    for (let i = 1; i < candles.length; i += 1) {
        const from = Math.max(0, i - window);
        let extreme = from;
        for (let j = from; j <= i; j += 1) {
            const better = side === 'up'
                ? candles[j].close < candles[extreme].close
                : candles[j].close > candles[extreme].close;
            if (better) extreme = j;
        }
        const startPrice = candles[extreme].close;
        if (!(startPrice > 0)) continue;
        const pct = side === 'up'
            ? candles[i].close / startPrice - 1
            : 1 - candles[i].close / startPrice;
        if (!Number.isFinite(pct) || pct <= 0) continue;
        if (!largest || pct > largest.movePct) {
            largest = legAt(candles, extreme, i, side, rsi);
        }
        if (pct < threshold) continue;
        if (extreme <= lastEnd) continue;
        moves.push(legAt(candles, extreme, i, side, rsi));
        lastEnd = i;
    }
    return { moves, largest };
};

const runStats = (lengths: readonly number[]): RunStats => ({
    mean: mean(lengths),
    median: median(lengths),
    max: lengths.length ? Math.max(...lengths) : 0,
    count: lengths.length,
});

export const studyRuns = (candles: readonly ScanCandle[]): { up: RunStats; down: RunStats } => {
    const up: number[] = [];
    const down: number[] = [];
    let dir = 0;
    let len = 0;
    for (let i = 1; i < candles.length; i += 1) {
        const d = candles[i].close > candles[i - 1].close ? 1 : candles[i].close < candles[i - 1].close ? -1 : dir;
        if (d === 0) continue;
        if (d === dir) len += 1;
        else {
            if (dir === 1 && len > 0) up.push(len);
            if (dir === -1 && len > 0) down.push(len);
            dir = d;
            len = 1;
        }
    }
    if (dir === 1 && len > 0) up.push(len);
    if (dir === -1 && len > 0) down.push(len);
    return { up: runStats(up), down: runStats(down) };
};

const studyAnatomy = (candles: readonly ScanCandle[]): TapeStudy['anatomy'] => {
    if (candles.length === 0) return { upBarShare: 0, bodyToRange: 0, closeTopThird: 0, expansionShare: 0 };
    let up = 0;
    let body = 0;
    let range = 0;
    let topThird = 0;
    let expansion = 0;
    for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i];
        const r = c.high - c.low;
        body += Math.abs(c.close - c.open);
        range += r;
        if (c.close > c.open) up += 1;
        if (r > 0 && c.close >= c.low + r * (2 / 3)) topThird += 1;
        if (i >= 14) {
            const avg = mean(candles.slice(i - 14, i).map(x => x.high - x.low));
            if (avg > 0 && r > avg * 1.5) expansion += 1;
        }
    }
    return {
        upBarShare: up / candles.length,
        bodyToRange: range > 0 ? body / range : 0,
        closeTopThird: topThird / candles.length,
        expansionShare: expansion / Math.max(1, candles.length - 14),
    };
};

export const buildTapeStudy = (
    candles: readonly ScanCandle[],
    options: TapeStudyOptions = {},
): TapeStudy => {
    const horizon = Math.min(Math.max(Math.round(options.horizon ?? 12), 1), 96);
    const window = Math.min(Math.max(Math.round(options.window ?? 24), 2), 96);
    const thresholdPct = Math.min(Math.max(options.threshold ?? 0.10, 0.01), 0.50);
    const { hours, samples } = studyHours(candles, horizon);
    const up = findBigMoves(candles, 'up', thresholdPct, window);
    const down = findBigMoves(candles, 'down', thresholdPct, window);
    return {
        bars: candles.length,
        horizon,
        window,
        thresholdPct,
        samples,
        hours,
        upMoves: up.moves,
        downMoves: down.moves,
        largestUp: up.largest,
        largestDown: down.largest,
        runs: studyRuns(candles),
        anatomy: studyAnatomy(candles),
    };
};

// ─── Text ────────────────────────────────────────────────────────────────────

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const px = (v: number): string => Number(v.toPrecision(5)).toString();
const hh = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

const hourLine = (h: HourStudy): string =>
    `${hh(h.hour)} move ${pct(h.meanMove)} · drift ${pct(h.meanDrift)} · up ${(h.upShare * 100).toFixed(0)}% · MFE ${pct(h.meanMfe)} / MAE ${pct(h.meanMae)} · n=${h.samples}`;

const moveLine = (m: BigMove, i: number): string => {
    const vol = m.volumeRatio === null ? 'vol –' : `vol ${m.volumeRatio.toFixed(1)}×`;
    const comp = m.rangeCompression === null ? 'range –'
        : `range ${m.rangeCompression.toFixed(2)}×${m.rangeCompression < 1 ? ' (compressed)' : ''}`;
    // The magnitude is stored positive on both sides; the SIGN comes from the
    // side, so a drop never prints as "+10.7%".
    const magnitude = `${m.side === 'up' ? '+' : '−'}${(m.movePct * 100).toFixed(1)}%`;
    // The start time is PHT, the same clock as the hour buckets and every
    // other stamp the model reads. It used to print a UTC ISO string beside a
    // PHT hour for the same bar — two clocks in one line, the exact mix the
    // candle rows were fixed for.
    return `${m.side} #${i + 1} ${phtDayYear(m.startTime)} ${phtClock(m.startTime)} PHT `
        + `${px(m.startPrice)}→${px(m.endPrice)} ${magnitude} in ${m.bars} bar${m.bars === 1 ? '' : 's'} · prior 6 ${pct(m.priorReturn)} · ${vol} · ${comp} `
        + `· gap ${pct(m.gapPct)} · RSI ${m.rsi === null ? '–' : m.rsi.toFixed(0)}`;
};

export interface TapeStudyText {
    timeOfDay: string;
    bigMoves: string;
    anatomy: string;
}

/** Bounded text: best/worst five hours, eight legs per side, one line each. */
export const formatTapeStudy = (study: TapeStudy): TapeStudyText => {
    const active = study.hours.filter(h => h.samples > 0);
    const byMove = [...active].sort((a, b) => b.meanMove - a.meanMove);
    const best = byMove.slice(0, 5);
    const worst = byMove.slice(-5).reverse();
    const timeOfDay = [
        `TIME OF DAY (PHT, ${study.bars} bars → ${study.samples} samples, ${study.horizon}-bar forward horizon):`,
        `  most movement: ${best.map(hourLine).join('\n                ')}`,
        `  least movement: ${worst.map(hourLine).join('\n                 ')}`,
    ].join('\n');

    const bigMoves = [
        `BIG MOVES ≥${(study.thresholdPct * 100).toFixed(0)}% — entry at the lowest/highest close in a ${study.window}-bar window:`,
        study.upMoves.length === 0 && study.downMoves.length === 0
            ? '  none at the threshold on this tape.'
            : '',
        ...study.upMoves.slice(-8).map(moveLine),
        ...study.downMoves.slice(-8).map(moveLine),
        study.largestUp && study.largestUp.movePct < study.thresholdPct
            ? `  largest UP leg was ${(study.largestUp.movePct * 100).toFixed(1)}% at ${phtDayYear(study.largestUp.startTime)} ${phtClock(study.largestUp.startTime)} PHT — below the threshold.`
            : '',
        study.largestDown && study.largestDown.movePct < study.thresholdPct
            ? `  largest DOWN leg was ${(study.largestDown.movePct * 100).toFixed(1)}% at ${phtDayYear(study.largestDown.startTime)} ${phtClock(study.largestDown.startTime)} PHT — below the threshold.`
            : '',
    ].filter(Boolean).join('\n');

    const a = study.anatomy;
    const anatomy = [
        `CANDLE ANATOMY (every bar): ${(a.upBarShare * 100).toFixed(0)}% up bars · body/range ${a.bodyToRange.toFixed(2)} `
            + `· ${(a.closeTopThird * 100).toFixed(0)}% close in the top third · ${(a.expansionShare * 100).toFixed(0)}% expansion bars (>1.5× prior 14-bar range)`,
        `RUNS: up mean ${study.runs.up.mean.toFixed(1)} / median ${study.runs.up.median.toFixed(0)} / max ${study.runs.up.max} `
            + `(${study.runs.up.count} runs) · down mean ${study.runs.down.mean.toFixed(1)} / median ${study.runs.down.median.toFixed(0)} / max ${study.runs.down.max} `
            + `(${study.runs.down.count} runs)`,
    ].join('\n');

    return { timeOfDay, bigMoves, anatomy };
};
