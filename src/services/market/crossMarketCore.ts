/**
 * crossMarketCore — the alt-vs-majors reads, pure math over aligned close
 * series. This family works for the assets WITHOUT derivatives data (the
 * tools-upgrade plan's E group): a coin the derivatives endpoints do not
 * cover still has a BTC/ETH-relative story.
 *
 * All series are closed candles the caller has already as-of filtered and
 * length-aligned. Correlation and beta run on RETURNS (Δclose/close), not
 * prices — correlating prices is how two uptrending coins read as "related"
 * while their day-to-day moves disagree.
 */

export interface CrossMarketRead {
    /** alt/BTC ratio now, and its z-score over the window. */
    ratioNow: number;
    ratioZScore: number;
    /** Ratio change over the window, in percent (positive = alt outperformed). */
    ratioMomentumPct: number;
    correlationBtc: number | null;
    betaBtc: number | null;
    correlationEth: number | null;
    betaEth: number | null;
    windowBars: number;
    note: string;
}

const returns = (closes: number[]): number[] => {
    const out: number[] = [];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    return out;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
};

/** Pearson correlation of two return series. */
export const correlation = (a: number[], b: number[]): number | null => {
    if (a.length !== b.length || a.length < 5) return null;
    const ma = mean(a);
    const mb = mean(b);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i] - ma;
        const y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if (da <= 0 || db <= 0) return null;
    return num / Math.sqrt(da * db);
};

/** Beta of the alt's returns vs the major's: cov / var(major). */
export const beta = (altReturns: number[], majorReturns: number[]): number | null => {
    if (altReturns.length !== majorReturns.length || majorReturns.length < 5) return null;
    const ma = mean(altReturns);
    const mm = mean(majorReturns);
    let cov = 0;
    let varM = 0;
    for (let i = 0; i < altReturns.length; i++) {
        cov += (altReturns[i] - ma) * (majorReturns[i] - mm);
        varM += (majorReturns[i] - mm) * (majorReturns[i] - mm);
    }
    if (varM <= 0) return null;
    return cov / varM;
};

/**
 * The BTC-relative read over the window (tail-aligned; ETH optional).
 * The z-score answers "is this alt stretched vs BTC relative to its own
 * recent relationship" — the mean-reversion framing a relative-value trader
 * actually uses.
 */
export const btcRelative = (
    altCloses: number[],
    btcCloses: number[],
    ethCloses: number[] | null,
    window = 30,
): CrossMarketRead | null => {
    const n = Math.min(window + 1, altCloses.length, btcCloses.length, ethCloses ? ethCloses.length : Infinity);
    if (!(n >= 10)) return null;
    const alt = altCloses.slice(-n);
    const btc = btcCloses.slice(-n);
    const eth = ethCloses ? ethCloses.slice(-n) : null;

    const ratio = alt.map((c, i) => (btc[i] > 0 ? c / btc[i] : NaN)).filter(Number.isFinite);
    if (ratio.length < 10) return null;
    const ratioNow = ratio[ratio.length - 1];
    const m = mean(ratio);
    const sd = stdev(ratio);
    const ratioZScore = sd > 0 ? (ratioNow - m) / sd : 0;
    const ratioMomentumPct = ratio[0] > 0 ? ((ratioNow - ratio[0]) / ratio[0]) * 100 : 0;

    const altR = returns(alt);
    const btcR = returns(btc);
    const ethR = eth ? returns(eth) : [];

    return {
        ratioNow: Math.round(ratioNow * 1e8) / 1e8,
        ratioZScore: Math.round(ratioZScore * 100) / 100,
        ratioMomentumPct: Math.round(ratioMomentumPct * 100) / 100,
        correlationBtc: Math.round((correlation(altR, btcR) ?? 0) * 100) / 100,
        betaBtc: Math.round((beta(altR, btcR) ?? 0) * 100) / 100,
        correlationEth: ethR.length ? Math.round((correlation(altR, ethR) ?? 0) * 100) / 100 : null,
        betaEth: ethR.length ? Math.round((beta(altR, ethR) ?? 0) * 100) / 100 : null,
        windowBars: ratio.length,
        note: 'correlation/beta run on bar RETURNS over the window; a stretched ratio (|z| ≥ 2) is a relative-value fact, not a timing signal',
    };
};

export interface StrengthRank {
    symbol: string;
    /** Window return in percent. */
    windowReturnPct: number;
    /** 1 = strongest of the compared set. */
    rank: number;
    setSize: number;
}

/**
 * Relative-strength rank within a declared peer set: each member's window
 * return, ranked. Ties share the better rank (deterministic: first in the
 * input order wins it).
 */
export const relativeStrengthRank = (
    symbol: string,
    symbolReturnPct: number,
    peerReturns: Array<{ symbol: string; windowReturnPct: number }>,
): StrengthRank[] => {
    const all = [
        { symbol, windowReturnPct: symbolReturnPct },
        ...peerReturns,
    ];
    const sorted = [...all].sort((a, b) => b.windowReturnPct - a.windowReturnPct);
    return sorted.map((s, i) => ({
        symbol: s.symbol,
        windowReturnPct: Math.round(s.windowReturnPct * 100) / 100,
        rank: i + 1,
        setSize: sorted.length,
    }));
};
