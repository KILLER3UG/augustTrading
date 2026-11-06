/**
 * derivativesCore — the positioning reads, pure math over the derivatives
 * series the app already fetches.
 *
 * Every threshold here is a DECLARED STARTING PARAMETER to validate, not an
 * edge: the quadrant deadband, the divergence persistence, the funding
 * extreme floor, the liquidation-intensity bands (<2% normal, 2–5%
 * stressed, >5% cascade). They are printed in the outputs so the ablation —
 * and the trader — can disagree with them from the numbers themselves.
 *
 * Honesty rules this module keeps:
 *  - Divergences require PERSISTENCE (consecutive aligned bars), never a
 *    single spike.
 *  - A series that is too short or missing makes its read unavailable —
 *    never zero, never a stand-in sentiment.
 *  - Depth is stated: funding history is ~21×8h (≈7 days), OI history
 *    24×1h (1 day). A percentile off 21 points is coarse, and the note says
 *    so. Any future training use must respect that depth (tools-upgrade §5).
 */

export interface PriceRow { t: number; close: number }
export interface OiRow { t: number; oi: number }
export interface FundingRow { t: number; rate: number }

export type OiPriceQuadrant = 'new_longs' | 'new_shorts' | 'short_covering' | 'long_liquidation' | 'flat';

export interface OiPriceState {
    quadrant: OiPriceQuadrant;
    /** Price change over the aligned window, in percent. */
    priceChangePct: number;
    /** OI change over the same aligned window, in percent. */
    oiChangePct: number;
    oiChange: { '1h': number | null; '4h': number | null; '24h': number | null };
    divergence: {
        kind: 'price_up_oi_down' | 'price_down_oi_up' | null;
        /** Consecutive aligned bars the divergence has held. */
        consecutiveBars: number;
        persistenceRequired: number;
    };
    alignedBars: number;
    thresholds: { deadbandPct: number; persistenceBars: number };
}

const pct = (a: number, b: number): number => b !== 0 ? ((a - b) / b) * 100 : 0;

/**
 * The price/OI quadrant read. Both series ascend; the window is the tail
 * where they overlap (matched by index from the end). The quadrant names
 * who is acting: price↑/OI↑ new longs, price↓/OI↑ new shorts, price↑/OI↓
 * short covering, price↓/OI↓ long liquidation — inside the deadband, flat.
 */
export const oiPriceState = (
    prices: PriceRow[],
    oi: OiRow[],
    options: { deadbandPct?: number; persistenceBars?: number } = {},
): OiPriceState | null => {
    const deadbandPct = options.deadbandPct ?? 0.1;
    const persistenceBars = options.persistenceBars ?? 3;
    if (prices.length < 3 || oi.length < 3) return null;

    // Align from the tail: the last min(len) rows of each (both are 1h
    // series in practice; a coarse index match is what the data supports).
    const n = Math.min(prices.length, oi.length);
    const p = prices.slice(-n);
    const o = oi.slice(-n);

    const priceChangePct = pct(p[p.length - 1].close, p[0].close);
    const oiChangePct = pct(o[o.length - 1].oi, o[0].oi);
    const priceUp = priceChangePct > deadbandPct;
    const priceDown = priceChangePct < -deadbandPct;
    const oiUp = oiChangePct > deadbandPct;
    const oiDown = oiChangePct < -deadbandPct;
    const quadrant: OiPriceQuadrant = !priceUp && !priceDown ? 'flat'
        : priceUp && oiUp ? 'new_longs'
            : priceDown && oiUp ? 'new_shorts'
                : priceUp && oiDown ? 'short_covering'
                    : 'long_liquidation';

    // OI change over the standard horizons, from the OI series' own tail.
    const oiAt = (back: number): number | null =>
        o.length > back ? o[o.length - 1 - back].oi : null;
    const last = o[o.length - 1].oi;
    const oiChange = {
        '1h': oiAt(1) !== null ? Math.round(pct(last, oiAt(1) as number) * 100) / 100 : null,
        '4h': oiAt(4) !== null ? Math.round(pct(last, oiAt(4) as number) * 100) / 100 : null,
        '24h': oiAt(24) !== null ? Math.round(pct(last, oiAt(24) as number) * 100) / 100 : null,
    };

    // Persistence divergence: per aligned bar, sign(priceΔ) vs sign(oiΔ);
    // count consecutive disagreements ending at the newest bar.
    const barDir = (a: number, b: number): number => (b - a > 0 ? 1 : b - a < 0 ? -1 : 0);
    let consecutive = 0;
    for (let i = n - 1; i >= 1; i--) {
        const pd = barDir(p[i - 1].close, p[i].close);
        const od = barDir(o[i - 1].oi, o[i].oi);
        if (pd === 0 || od === 0 || pd === od) break;
        consecutive += 1;
    }
    const kind: OiPriceState['divergence']['kind'] = consecutive >= persistenceBars
        ? (p[p.length - 1].close >= p[0].close ? 'price_up_oi_down' : 'price_down_oi_up')
        : null;

    return {
        quadrant,
        priceChangePct: Math.round(priceChangePct * 100) / 100,
        oiChangePct: Math.round(oiChangePct * 100) / 100,
        oiChange,
        divergence: { kind, consecutiveBars: consecutive, persistenceRequired: persistenceBars },
        alignedBars: n,
        thresholds: { deadbandPct, persistenceBars },
    };
};

export interface FundingState {
    current: number | null;
    /** Rank of the current rate among the history (0–100; coarse — the
     *  history is ~21×8h). */
    percentile: number | null;
    extreme: boolean;
    /** Mean rate of the last 3 settlements vs the first 3 — the trend the
     *  percentile cannot show. */
    drift: number | null;
    divergence: 'price_up_funding_falling' | 'price_down_funding_rising' | null;
    minutesToSettlement: number | null;
    historyPoints: number;
    note: string;
    thresholds: { extremeAbsRate: number; driftPoints: number };
}

/**
 * The funding read. `extreme` is |rate| ≥ `extremeAbsRate` (default 0.05% =
 * 0.0005 per settlement — a declared starting parameter). The divergence
 * needs the drift to be persistent (3-settlement means on each side), not a
 * single print.
 */
export const fundingState = (
    history: FundingRow[],
    current: number | null,
    prices: PriceRow[],
    nextFundingTime: number | null,
    now: number,
    options: { extremeAbsRate?: number } = {},
): FundingState => {
    const extremeAbsRate = options.extremeAbsRate ?? 0.0005;
    const rates = history.map(h => h.rate).filter(r => Number.isFinite(r));
    const rate = current ?? (rates.length ? rates[rates.length - 1] : null);
    const percentile = rate !== null && rates.length >= 5
        ? Math.round((rates.filter(r => r <= rate).length / rates.length) * 100)
        : null;
    const extreme = rate !== null && Math.abs(rate) >= extremeAbsRate;

    let drift: number | null = null;
    let divergence: FundingState['divergence'] = null;
    if (rates.length >= 6) {
        const k = 3;
        const recent = rates.slice(-k).reduce((s, r) => s + r, 0) / k;
        const older = rates.slice(0, k).reduce((s, r) => s + r, 0) / k;
        drift = Math.round((recent - older) * 1e6) / 1e6;
        if (prices.length >= 3) {
            const priceUp = prices[prices.length - 1].close > prices[0].close;
            if (priceUp && recent < older) divergence = 'price_up_funding_falling';
            if (!priceUp && recent > older) divergence = 'price_down_funding_rising';
        }
    }

    return {
        current: rate,
        percentile,
        extreme,
        drift,
        divergence,
        minutesToSettlement: nextFundingTime && nextFundingTime > now
            ? Math.round((nextFundingTime - now) / 60_000)
            : null,
        historyPoints: rates.length,
        note: `funding history depth ≈ ${rates.length} settlements (~7 days at 8h) — a percentile off this many points is coarse`,
        thresholds: { extremeAbsRate, driftPoints: 3 },
    };
};

export interface PositioningState {
    taker: { ratio: number | null; read: string };
    topTraders: { ratio: number | null; read: string };
    retail: { ratio: number | null; read: string };
    trend: 'up' | 'down' | null;
    note: string;
}

/**
 * The positioning snapshot, each row labeled with or against the price
 * trend (trend = last close vs the first of the window). Single 5m samples
 * with NO history depth — the note must ride every output so nobody reads a
 * snapshot as a build-up.
 */
export const positioningState = (
    parts: {
        takerRatio: number | null;
        topTraderRatio: number | null;
        longShortRatio: number | null;
    },
    prices: PriceRow[],
): PositioningState => {
    const trend: 'up' | 'down' | null = prices.length >= 2
        ? (prices[prices.length - 1].close >= prices[0].close ? 'up' : 'down')
        : null;
    const withTrend = (ratio: number | null, longSide: boolean): string => {
        if (ratio === null || trend === null) return 'no trend context';
        const leaning = longSide ? ratio > 1 : ratio < 1;
        return leaning
            ? (trend === 'up' ? 'long-heavy WITH the uptrend' : 'short-heavy WITH the downtrend')
            : (trend === 'up' ? 'short-heavy AGAINST the uptrend' : 'long-heavy AGAINST the downtrend');
    };
    return {
        taker: { ratio: parts.takerRatio, read: withTrend(parts.takerRatio, true) },
        topTraders: { ratio: parts.topTraderRatio, read: withTrend(parts.topTraderRatio, true) },
        retail: { ratio: parts.longShortRatio, read: withTrend(parts.longShortRatio, true) },
        trend,
        note: 'each ratio is a single 5m sample (no history) — a snapshot, not a build-up; treat accordingly',
    };
};

export interface LiquidationRisk {
    available: boolean;
    reason?: string;
    /** Liquidations (USD, last hour) ÷ open interest (USD) × 100. */
    intensityPct: number | null;
    band: 'normal' | 'stressed' | 'cascade' | null;
    dominantSide: 'longs' | 'shorts' | 'balanced' | null;
    thresholds: { stressedPct: number; cascadePct: number };
}

/**
 * Liquidation/OI intensity in the declared bands (<2% normal, 2–5%
 * stressed, >5% cascade — starting parameters to validate). The Binance
 * liquidation feed is RETIRED (the honest latch in MarketDataService), so
 * today this read is almost always `available: false` with that reason —
 * which is the correct answer, not a failure.
 */
export const liquidationRisk = (
    parts: {
        liquidationsUsd: number | null;
        oiUsd: number | null;
        dominantSide: 'longs' | 'shorts' | 'balanced' | null;
        unavailableReason?: 'source_retired' | 'fetch_failed';
    },
    options: { stressedPct?: number; cascadePct?: number } = {},
): LiquidationRisk => {
    const stressedPct = options.stressedPct ?? 2;
    const cascadePct = options.cascadePct ?? 5;
    if (parts.unavailableReason || parts.liquidationsUsd === null || parts.oiUsd === null || parts.oiUsd <= 0) {
        return {
            available: false,
            reason: parts.unavailableReason === 'source_retired'
                ? 'the exchange retired the public liquidation feed — no liquidation figure exists, and "quiet" would be a lie'
                : 'liquidation or open-interest value unavailable',
            intensityPct: null,
            band: null,
            dominantSide: null,
            thresholds: { stressedPct, cascadePct },
        };
    }
    const intensityPct = (parts.liquidationsUsd / parts.oiUsd) * 100;
    return {
        available: true,
        intensityPct: Math.round(intensityPct * 100) / 100,
        band: intensityPct >= cascadePct ? 'cascade' : intensityPct >= stressedPct ? 'stressed' : 'normal',
        dominantSide: parts.dominantSide,
        thresholds: { stressedPct, cascadePct },
    };
};
