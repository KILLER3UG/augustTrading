/**
 * setupScan — the strategy books, turned into code. Each detector here is the
 * machine-checkable core of a playbook from `Pdf's Strategies` (breakout
 * retest, gap classes, pin bars, inside-bar breaks, RSI divergence, band
 * plays, range fades, trend pullbacks, failed breaks, momentum thrusts).
 * `scanSetups` runs them over a candle window and returns the setups that
 * are LIVE right now with their evidence — the `scan_setups` desk tool feeds
 * this to the model, and each setup carries keywords so the tool can also
 * name the library skills that speak to it.
 *
 * Pure + dependency-free (like candleFormations): unit-testable, no React,
 * no network. Windows are in BARS, newest last.
 */

export interface ScanCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface GapInfo {
    /** Index into the scanned window (absolute bar position). */
    index: number;
    kind: 'breakaway' | 'runaway' | 'exhaustion' | 'common';
    side: 'up' | 'down';
    /** Gap zone edges (from = prior bar extreme, to = current open). */
    from: number;
    to: number;
    /** A later bar traded back through the zone — the gap is filled. */
    filled: boolean;
}

export interface LiveSetup {
    id: string;
    title: string;
    side: 'long' | 'short' | 'watch';
    /** How many bars ago the trigger candle closed (0 = current bar). */
    barsAgo: number;
    evidence: string[];
    /** Keywords the scan tool uses to match library skills. */
    keywords: string[];
}

const body = (c: ScanCandle): number => Math.abs(c.close - c.open);
const range = (c: ScanCandle): number => Math.max(c.high - c.low, Number.EPSILON);
const upperWick = (c: ScanCandle): number => c.high - Math.max(c.open, c.close);
const lowerWick = (c: ScanCandle): number => Math.min(c.open, c.close) - c.low;
const isBull = (c: ScanCandle): boolean => c.close >= c.open;
const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2 });

/** Standard Wilder RSI(14) over closes; returns a series aligned to candles
 *  (NaN until the seed period completes). */
export const rsiSeries = (candles: ScanCandle[], period = 14): number[] => {
    const out: number[] = candles.map(() => NaN);
    if (candles.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
        const d = candles[i].close - candles[i - 1].close;
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < candles.length; i += 1) {
        const d = candles[i].close - candles[i - 1].close;
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
};

/** NaN until the window fills. */
export const smaSeries = (values: number[], period: number): number[] =>
    values.map((_, i) => {
        if (i < period - 1) return NaN;
        let s = 0;
        for (let j = i - period + 1; j <= i; j += 1) s += values[j];
        return s / period;
    });

/** Bollinger bands (20, 2) over closes. */
export const bollinger = (candles: ScanCandle[], period = 20, mult = 2): { mid: number[]; upper: number[]; lower: number[] } => {
    const closes = candles.map(c => c.close);
    const mid = smaSeries(closes, period);
    const upper: number[] = [];
    const lower: number[] = [];
    for (let i = 0; i < closes.length; i += 1) {
        if (Number.isNaN(mid[i])) { upper.push(NaN); lower.push(NaN); continue; }
        let v = 0;
        for (let j = i - period + 1; j <= i; j += 1) v += (closes[j] - mid[i]) ** 2;
        const sd = Math.sqrt(v / period);
        upper.push(mid[i] + mult * sd);
        lower.push(mid[i] - mult * sd);
    }
    return { mid, upper, lower };
};

/**
 * Gap classification (Gap-Trading-Strategies + Al Brooks): a gap is a bar
 * whose open clears the prior bar's opposite extreme by >0.15%. Kinds:
 * exhaustion after a stretched run, breakaway out of a tight base, runaway
 * mid-trend, else common. `filled` = any later bar traded back through.
 */
export const classifyGaps = (candles: ScanCandle[]): GapInfo[] => {
    const out: GapInfo[] = [];
    const n = candles.length;
    for (let i = 1; i < n; i += 1) {
        const c = candles[i];
        const prev = candles[i - 1];
        const minGap = prev.close * 0.0015;
        let side: 'up' | 'down' | null = null;
        if (c.open - prev.high >= minGap) side = 'up';
        else if (prev.low - c.open >= minGap) side = 'down';
        if (!side) continue;
        const from = side === 'up' ? prev.high : prev.low;
        const to = c.open;
        // Stretched run before the gap → exhaustion candidate.
        let run = 0;
        for (let j = i - 1; j >= Math.max(1, i - 4); j -= 1) {
            if ((side === 'up' && isBull(candles[j])) || (side === 'down' && !isBull(candles[j]))) run += 1;
            else break;
        }
        const prior = candles.slice(Math.max(0, i - 6), i);
        const avgRange = prior.length ? prior.reduce((s, x) => s + range(x), 0) / prior.length : range(c);
        const tightBase = prior.length >= 4 && (Math.max(...prior.map(x => x.high)) - Math.min(...prior.map(x => x.low))) < avgRange * 3;
        let kind: GapInfo['kind'];
        if (run >= 3 && range(c) >= avgRange * 1.8) kind = 'exhaustion';
        else if (tightBase) kind = 'breakaway';
        else if (run >= 2) kind = 'runaway';
        else kind = 'common';
        let filled = false;
        for (let j = i + 1; j < n; j += 1) {
            const back = side === 'up' ? candles[j].low <= from : candles[j].high >= from;
            if (back) { filled = true; break; }
        }
        out.push({ index: i, kind, side, from, to, filled });
    }
    return out;
};

/**
 * The live-setup scan over a candle window (≥ ~40 bars recommended).
 * Returns setups whose trigger closed within the last 5 bars, newest first.
 */
export const scanSetups = (candles: ScanCandle[]): LiveSetup[] => {
    const out: LiveSetup[] = [];
    const n = candles.length;
    if (n < 25) return out;
    const recent = (i: number): boolean => n - 1 - i <= 5;
    const ago = (i: number): number => n - 1 - i;
    const closes = candles.map(c => c.close);
    // Average range of the last 20 CLOSED bars. The old slice(-20) window
    // included the FORMING bar — the breakout detectors then compared this
    // bar's own range "vs avg" with the bar inside its own benchmark
    // (apples vs mixed apples). Compare against closed candles only.
    // n ≥ 25 (guard above) ⇒ slice(-21, -1) is always exactly 20 bars.
    const avgRange = candles.slice(-21, -1).reduce((s, c) => s + range(c), 0) / 20;
    // Range extremes over the PRIOR 30 bars — the current bar is excluded.
    // Including it made "close above the 30-bar high" overstate its own
    // evidence: hi30 always contains last.high, so the breakout condition
    // (`last.close > hi30 * 0.995` with `last.high >= hi30 * 0.998`) could be
    // satisfied by the very bar it claims to have broken. A breakout is
    // strength only against the range that EXISTED before this bar printed.
    const last = candles[n - 1];
    // n ≥ 25 ⇒ this slice always holds 24–30 closed bars; the old
    // `prior30.length > 0 ? … : candles.slice(0, -1)` and the
    // `: last.high` / `: last.low` empty guards were unreachable.
    const priorBars = candles.slice(-31, -1);
    const hi30 = Math.max(...priorBars.map(c => c.high));
    const lo30 = Math.min(...priorBars.map(c => c.low));

    // --- Range edges: breakout with body, or rejection at the edge.
    const nearTop = last.high >= hi30 * 0.998;
    const nearBottom = last.low <= lo30 * 1.002;
    if (nearTop && last.close > hi30 * 0.995 && isBull(last) && body(last) >= range(last) * 0.55 && range(last) >= avgRange * 1.3) {
        out.push({ id: 'range-breakout-up', title: 'Range breakout — close above the 30-bar high', side: 'long', barsAgo: 0,
            evidence: [`close ${fmt(last.close)} beyond range high ${fmt(hi30)}`, `full-bodied ${fmt(range(last))}-range bar vs ${fmt(avgRange)} avg`],
            keywords: ['breakout', 'range'] });
    }
    if (nearBottom && last.close < lo30 * 1.005 && !isBull(last) && body(last) >= range(last) * 0.55 && range(last) >= avgRange * 1.3) {
        out.push({ id: 'range-breakout-down', title: 'Range breakdown — close below the 30-bar low', side: 'short', barsAgo: 0,
            evidence: [`close ${fmt(last.close)} below range low ${fmt(lo30)}`, `full-bodied bar vs avg range`],
            keywords: ['breakout', 'range'] });
    }
    if (nearTop && upperWick(last) >= range(last) * 0.55 && body(last) < range(last) * 0.35) {
        out.push({ id: 'range-fade-top', title: 'Range-edge rejection at the high — fade candidate', side: 'short', barsAgo: 0,
            evidence: [`long upper wick ${fmt(upperWick(last))} at range top ${fmt(hi30)}`, 'body closed back under the wick'],
            keywords: ['range', 'pin bar', 'rejection'] });
    }
    if (nearBottom && lowerWick(last) >= range(last) * 0.55 && body(last) < range(last) * 0.35) {
        out.push({ id: 'range-fade-bottom', title: 'Range-edge rejection at the low — fade candidate', side: 'long', barsAgo: 0,
            evidence: [`long lower wick ${fmt(lowerWick(last))} at range bottom ${fmt(lo30)}`, 'body closed back above the wick'],
            keywords: ['range', 'pin bar', 'rejection'] });
    }

    // --- Pin bars at the window extremes (Pin-Bar-Trading-Strategies).
    for (let i = Math.max(1, n - 6); i < n; i += 1) {
        const c = candles[i];
        if (!recent(i)) continue;
        const hi = Math.max(...candles.slice(Math.max(0, i - 10), i + 1).map(x => x.high));
        const lo = Math.min(...candles.slice(Math.max(0, i - 10), i + 1).map(x => x.low));
        if (body(c) > range(c) * 0.34) continue;
        if (lowerWick(c) >= body(c) * 2.5 && lowerWick(c) >= range(c) * 0.6 && c.low <= lo * 1.002) {
            out.push({ id: 'pin-bar-buy', title: 'Bullish pin bar at the local low', side: 'long', barsAgo: ago(i),
                evidence: [`wick ${fmt(lowerWick(c))} ≥ 2.5× body at swing low ${fmt(lo)}`],
                keywords: ['pin bar', 'rejection'] });
        }
        if (upperWick(c) >= body(c) * 2.5 && upperWick(c) >= range(c) * 0.6 && c.high >= hi * 0.998) {
            out.push({ id: 'pin-bar-sell', title: 'Bearish pin bar at the local high', side: 'short', barsAgo: ago(i),
                evidence: [`wick ${fmt(upperWick(c))} ≥ 2.5× body at swing high ${fmt(hi)}`],
                keywords: ['pin bar', 'rejection'] });
        }
    }

    // --- Inside-bar mother break (Inside-Bar-Trading-Strategies).
    for (let i = 2; i < n; i += 1) {
        const mother = candles[i - 2];
        const inside = candles[i - 1];
        const brk = candles[i];
        if (!recent(i) || !mother) continue;
        const isInside = inside.high <= mother.high && inside.low >= mother.low;
        if (!isInside) continue;
        if (brk.close > mother.high && isBull(brk)) {
            out.push({ id: 'inside-break-up', title: 'Inside bar resolved UP — close beyond the mother high', side: 'long', barsAgo: ago(i),
                evidence: [`mother range ${fmt(range(mother))}, inside contraction, break close ${fmt(brk.close)}`],
                keywords: ['inside bar', 'breakout'] });
        } else if (brk.close < mother.low && !isBull(brk)) {
            out.push({ id: 'inside-break-down', title: 'Inside bar resolved DOWN — close below the mother low', side: 'short', barsAgo: ago(i),
                evidence: [`mother range ${fmt(range(mother))}, inside contraction, break close ${fmt(brk.close)}`],
                keywords: ['inside bar', 'breakout'] });
        }
    }

    // --- Gaps (Gap-Trading-Strategies): unfilled exhaustion → fade, breakaway → join.
    for (const g of classifyGaps(candles.slice(-25)).map(x => ({ ...x, index: x.index + Math.max(0, n - 25) }))) {
        if (!recent(g.index)) continue;
        if (!g.filled && g.kind === 'exhaustion') {
            out.push({ id: 'gap-exhaustion', title: `Unfilled ${g.side} exhaustion gap after a stretched run — reversion candidate`, side: g.side === 'up' ? 'short' : 'long', barsAgo: ago(g.index),
                evidence: [`gap ${fmt(g.from)} → ${fmt(g.to)} (${g.side}), no retrace yet`, '3+ same-color bars + ≥1.8× range into the gap'],
                keywords: ['gap', 'exhaustion', 'mean reversion'] });
        }
        if (!g.filled && g.kind === 'breakaway') {
            out.push({ id: 'gap-breakaway', title: `Breakaway ${g.side} gap out of a tight base — continuation candidate`, side: g.side === 'up' ? 'long' : 'short', barsAgo: ago(g.index),
                evidence: [`gap ${fmt(g.from)} → ${fmt(g.to)} (${g.side}) out of a compressed range`, 'gap unfilled so far'],
                keywords: ['gap', 'breakaway', 'breakout'] });
        }
    }

    // --- RSI divergence (Relative-Strength-Index-Strategies).
    const rsi = rsiSeries(candles);
    const swingLow = (vals: number[], i: number): boolean => i > 0 && i < n - 1 && vals[i] <= Math.min(vals[i - 1], vals[i + 1]);
    for (let i = n - 12; i < n - 2; i += 1) {
        if (i < 15 || !recent(i)) continue;
        // Bullish: price lower low, RSI higher low.
        if (swingLow(closes.map(c => c), i) && swingLow(rsi, i)) {
            const later = rsi.slice(i + 2).findIndex((_, k) => closes[i + 2 + k] < closes[i] && !Number.isNaN(rsi[i + 2 + k]) && rsi[i + 2 + k] > rsi[i]);
            if (later >= 0 && recent(i + 2 + later)) {
                out.push({ id: 'rsi-div-bull', title: 'Bullish RSI divergence — price lower low, RSI higher low', side: 'long', barsAgo: ago(i + 2 + later),
                    evidence: [`RSI ${rsi[i].toFixed(1)} → ${rsi[i + 2 + later].toFixed(1)} while price made a lower low`],
                    keywords: ['divergence', 'rsi', 'reversal'] });
            }
        }
    }

    // --- Bollinger plays (Bands Explained + Mean-Reversion).
    const bb = bollinger(candles);
    if (!Number.isNaN(bb.lower[n - 1]) && recent(n - 1)) {
        if (last.close < bb.lower[n - 1] && isBull(last)) {
            out.push({ id: 'band-revert-up', title: 'Closed below the lower band, then a green bar — mean-reversion to mid-band', side: 'long', barsAgo: 0,
                evidence: [`close ${fmt(last.close)} vs lower band ${fmt(bb.lower[n - 1])}`, `mid-band target ${fmt(bb.mid[n - 1])}`],
                keywords: ['bands', 'mean reversion'] });
        }
        if (last.close > bb.upper[n - 1] && !isBull(last)) {
            out.push({ id: 'band-revert-down', title: 'Closed above the upper band, then a red bar — mean-reversion to mid-band', side: 'short', barsAgo: 0,
                evidence: [`close ${fmt(last.close)} vs upper band ${fmt(bb.upper[n - 1])}`, `mid-band target ${fmt(bb.mid[n - 1])}`],
                keywords: ['bands', 'mean reversion'] });
        }
        const walk = candles.slice(-3).every((c, k) => {
            const i = n - 3 + k;
            return c.close > bb.upper[i];
        });
        if (walk) {
            out.push({ id: 'band-walk-up', title: 'Band walk — 3 closes above the upper band (momentum, do NOT fade)', side: 'long', barsAgo: 0,
                evidence: ['three consecutive closes beyond the upper band'],
                keywords: ['bands', 'momentum'] });
        }
    }

    // --- Trend pullback second entry (Al Brooks — Trading Price Action Trends).
    const ema20 = smaSeries(closes, 20);
    if (!Number.isNaN(ema20[n - 6])) {
        const rising = ema20[n - 1] > ema20[n - 6];
        const pullback = candles.slice(-4).some(c => c.low <= ema20[n - 1] * 1.002);
        if (rising && pullback && isBull(last) && last.close > ema20[n - 1]) {
            out.push({ id: 'trend-pullback-long', title: 'Trend pullback to rising EMA20 + bullish close — second entry', side: 'long', barsAgo: 0,
                evidence: [`EMA20 rising ${fmt(ema20[n - 6])} → ${fmt(ema20[n - 1])}`, 'dip tagged the EMA and closed back above'],
                keywords: ['pullback', 'trend'] });
        }
        const falling = ema20[n - 1] < ema20[n - 6];
        if (falling && pullback && !isBull(last) && last.close < ema20[n - 1]) {
            out.push({ id: 'trend-pullback-short', title: 'Trend rally to falling EMA20 + bearish close — second entry short', side: 'short', barsAgo: 0,
                evidence: [`EMA20 falling ${fmt(ema20[n - 6])} → ${fmt(ema20[n - 1])}`, 'rally tagged the EMA and closed back below'],
                keywords: ['pullback', 'trend'] });
        }
    }

    // --- Failed breakout (Reversal-Trading-Strategies + Profitable-Chart-Patterns).
    for (let i = Math.max(1, n - 6); i < n - 1; i += 1) {
        if (!recent(i)) continue;
        const priorHigh = Math.max(...candles.slice(0, i).map(c => c.high));
        if (candles[i].close > priorHigh && !isBull(candles[i + 1]) && candles[i + 1].close < priorHigh) {
            out.push({ id: 'failed-break-up', title: 'Failed upside breakout — back inside the prior high within a bar', side: 'short', barsAgo: ago(i + 1),
                evidence: [`breaked ${fmt(priorHigh)} then closed back under it`, 'classic trap — reversal evidence'],
                keywords: ['breakout', 'failure', 'reversal'] });
        }
    }

    return out.sort((a, b) => a.barsAgo - b.barsAgo);
};

// ─── Historical scan ─────────────────────────────────────────────────────────

/** One occurrence of a detector firing in the past, with how price behaved
 *  after its trigger close: 1.5×ATR first-touch target vs 1×ATR stop within
 *  the horizon. `mfe`/`mae` are signed fractions of the entry price. */
export interface HistoricalSetupHit {
    /** Index of the trigger candle inside the scanned array. */
    index: number;
    time: number;
    entry: number;
    outcome: 'win' | 'loss' | 'open';
    /** Best excursion in the trade's direction, as a fraction of entry. */
    mfe: number;
    /** Worst excursion against it (≤ 0), as a fraction of entry. */
    mae: number;
}

/** Aggregated behavior of one detector (per side) across the whole history —
 *  "how often does this fire here, and does it actually work?". */
export interface HistoricalSetupStat {
    id: string;
    title: string;
    side: 'long' | 'short' | 'watch';
    keywords: string[];
    hits: number;
    wins: number;
    losses: number;
    open: number;
    /** wins/(wins+losses); null when nothing resolved inside the horizon. */
    winRate: number | null;
    avgMfe: number;
    avgMae: number;
    /** Most recent hits (newest first), capped for prompt economy. */
    examples: HistoricalSetupHit[];
}

export interface HistoryScanOptions {
    /** Bars walked forward from each trigger before calling it 'open'. */
    horizonBars?: number;
    /** Trailing window handed to the live detectors per step (bounds cost). */
    windowBars?: number;
}

const HISTORY_EXAMPLE_CAP = 8;

export const scanHistorySetups = (
    candles: ScanCandle[],
    opts: HistoryScanOptions = {},
): HistoricalSetupStat[] => {
    const horizon = opts.horizonBars ?? 12;
    const windowBars = Math.max(30, opts.windowBars ?? 120);
    const n = candles.length;
    if (n < 40) return [];

    const ranges = candles.map(c => range(c));
    const atrAt = (idx: number): number => {
        const from = Math.max(0, idx - 13);
        let sum = 0;
        for (let j = from; j <= idx; j += 1) sum += ranges[j];
        return sum / (idx - from + 1);
    };

    interface Bucket {
        id: string; title: string; side: LiveSetup['side']; keywords: string[];
        hits: HistoricalSetupHit[];
        wins: number; losses: number; open: number;
        mfeSum: number; maeSum: number;
    }
    const stats = new Map<string, Bucket>();
    const seen = new Set<string>();

    for (let e = 25; e < n; e += 1) {
        const from = Math.max(0, e - windowBars + 1);
        const window = candles.slice(from, e + 1);
        const setups = scanSetups(window);
        if (setups.length === 0) continue;
        for (const s of setups) {
            const triggerIdx = from + (window.length - 1 - s.barsAgo);
            const key = `${s.id}@${triggerIdx}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const entry = candles[triggerIdx].close;
            const atr = atrAt(triggerIdx);
            const target = atr * 1.5;
            const stop = atr;
            let outcome: HistoricalSetupHit['outcome'] = 'open';
            let mfe = 0;
            let mae = 0;
            if (s.side !== 'watch' && entry > 0 && atr > 0) {
                for (let j = triggerIdx + 1; j <= Math.min(n - 1, triggerIdx + horizon); j += 1) {
                    const c = candles[j];
                    const favourable = s.side === 'long' ? c.high - entry : entry - c.low;
                    const adverse = s.side === 'long' ? c.low - entry : entry - c.high;
                    mfe = Math.max(mfe, favourable);
                    mae = Math.min(mae, adverse);
                    // A bar spanning both levels loses (no favourable fill).
                    if (adverse <= -stop) { outcome = 'loss'; break; }
                    if (favourable >= target) { outcome = 'win'; break; }
                }
            }
            const hit: HistoricalSetupHit = {
                index: triggerIdx,
                time: candles[triggerIdx].time,
                entry,
                outcome,
                mfe: mfe / entry,
                mae: mae / entry,
            };
            const statKey = `${s.id}::${s.side}`;
            let bucket = stats.get(statKey);
            if (!bucket) {
                bucket = { id: s.id, title: s.title, side: s.side, keywords: s.keywords, hits: [], wins: 0, losses: 0, open: 0, mfeSum: 0, maeSum: 0 };
                stats.set(statKey, bucket);
            }
            bucket.hits.push(hit);
            if (outcome === 'win') bucket.wins += 1;
            else if (outcome === 'loss') bucket.losses += 1;
            else bucket.open += 1;
            bucket.mfeSum += hit.mfe;
            bucket.maeSum += hit.mae;
        }
    }

    return [...stats.values()]
        .sort((a, b) => b.hits.length - a.hits.length)
        .map(b => ({
            id: b.id,
            title: b.title,
            side: b.side,
            keywords: b.keywords,
            hits: b.hits.length,
            wins: b.wins,
            losses: b.losses,
            open: b.open,
            winRate: b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null,
            avgMfe: b.hits.length > 0 ? b.mfeSum / b.hits.length : 0,
            avgMae: b.hits.length > 0 ? b.maeSum / b.hits.length : 0,
            examples: [...b.hits].reverse().slice(0, HISTORY_EXAMPLE_CAP),
        }));
};
