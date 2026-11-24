/**
 * CorrelationRiskService
 * Detects correlation-based risks for altcoin trades
 * 
 * Features:
 * - BTC dominance tracking (via CoinGecko)
 * - BTC major level detection
 * - Correlation risk scoring
 * - Warning generation for high-correlation risk scenarios
 */

import { CorrelationRiskResult } from '../../types';
import { fetchOHLCV, fetchMarketData, Kline } from './MarketDataService';
import { calculateKeyLevels } from './TechnicalAnalysisService';
import { COINGECKO_API_BASE } from '../../config/exchangeEndpoints';

// Cache for BTC dominance data
let btcDominanceCache: { value: number; timestamp: number } | null = null;
const DOMINANCE_CACHE_TTL = 300000; // 5 minutes

// Cache for BTC levels
let btcLevelsCache: { support: number[]; resistance: number[]; timestamp: number } | null = null;
const LEVELS_CACHE_TTL = 60000; // 1 minute

/** Both CoinGecko calls are decorative inputs to a risk score — a stall must
 *  cost the analysis seconds, not the provider stream's 300s ceiling. */
const COINGECKO_TIMEOUT_MS = 8000;

/**
 * Fetch BTC dominance from CoinGecko (free, no API key required)
 */
export const fetchBTCDominance = async (): Promise<number> => {
    // Check cache first
    if (btcDominanceCache && Date.now() - btcDominanceCache.timestamp < DOMINANCE_CACHE_TTL) {
        return btcDominanceCache.value;
    }

    try {
        const response = await fetch(`${COINGECKO_API_BASE}/global`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            // Caller runs this inside the per-analysis fetch fan-out, so an
            // un-timed CoinGecko stall held the whole analysis until the
            // provider stream's own 300s cap.
            signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
        });

        if (!response.ok) {
            console.warn('[CorrelationRiskService] CoinGecko API failed, using fallback');
            return btcDominanceCache?.value ?? 50; // Return cached or default
        }

        const data = await response.json();
        const dominance = data.data?.market_cap_percentage?.btc ?? 50;

        btcDominanceCache = { value: dominance, timestamp: Date.now() };
        return dominance;
    } catch (error) {
        console.error('[CorrelationRiskService] Failed to fetch BTC dominance:', error);
        return btcDominanceCache?.value ?? 50;
    }
};

/**
 * Detect if BTC is at major support/resistance levels
 */
export const detectBTCMajorLevels = async (): Promise<{
    atSupport: boolean;
    atResistance: boolean;
    level: number | null;
    supportLevels: number[];
    resistanceLevels: number[];
}> => {
    try {
        // Fetch BTC price and OHLCV data
        const [marketData, klines4h] = await Promise.all([
            fetchMarketData('BTCUSDT'),
            fetchOHLCV('BTCUSDT', '4h', 100)
        ]);

        const currentPrice = marketData.currentPrice;

        // Check cache for levels
        if (btcLevelsCache && Date.now() - btcLevelsCache.timestamp < LEVELS_CACHE_TTL) {
            const { support, resistance } = btcLevelsCache;
            const proximityThreshold = currentPrice * 0.01; // 1% proximity

            const atSupport = support.some(s => Math.abs(currentPrice - s) <= proximityThreshold);
            const atResistance = resistance.some(r => Math.abs(currentPrice - r) <= proximityThreshold);
            const nearestLevel = atSupport
                ? support.find(s => Math.abs(currentPrice - s) <= proximityThreshold)
                : atResistance
                    ? resistance.find(r => Math.abs(currentPrice - r) <= proximityThreshold)
                    : null;

            return {
                atSupport,
                atResistance,
                level: nearestLevel ?? null,
                supportLevels: support,
                resistanceLevels: resistance
            };
        }

        // Calculate key levels
        const levels = calculateKeyLevels(klines4h);
        btcLevelsCache = {
            support: levels.support,
            resistance: levels.resistance,
            timestamp: Date.now()
        };

        const proximityThreshold = currentPrice * 0.01; // 1% proximity

        const atSupport = levels.support.some(s => Math.abs(currentPrice - s) <= proximityThreshold);
        const atResistance = levels.resistance.some(r => Math.abs(currentPrice - r) <= proximityThreshold);

        const nearestLevel = atSupport
            ? levels.support.find(s => Math.abs(currentPrice - s) <= proximityThreshold)
            : atResistance
                ? levels.resistance.find(r => Math.abs(currentPrice - r) <= proximityThreshold)
                : null;

        return {
            atSupport,
            atResistance,
            level: nearestLevel ?? null,
            supportLevels: levels.support,
            resistanceLevels: levels.resistance
        };
    } catch (error) {
        console.error('[CorrelationRiskService] Failed to detect BTC levels:', error);
        return {
            atSupport: false,
            atResistance: false,
            level: null,
            supportLevels: [],
            resistanceLevels: []
        };
    }
};

/**
 * Determine BTC dominance trend (rising = alts underperform, falling = alts outperform)
 */
export const getBTCDominanceTrend = async (): Promise<'rising' | 'falling' | 'stable'> => {
    try {
        const response = await fetch(`${COINGECKO_API_BASE}/global`, {
            signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
        });
        if (!response.ok) return 'stable';

        const data = await response.json();
        // Use the REAL dominance change when the API reports it. The old code
        // read `market_cap_change_percentage_24h_usd` — the TOTAL crypto
        // market's move — and called it BTC dominance, despite its own comment
        // saying it compared BTC against the total. That is a sign INVERSION,
        // not a rough approximation: when BTC is flat and alts rally, the total
        // cap rises, the code reported "dominance rising", and the caller added
        // a 20-point risk penalty plus an "alt longs especially risky" warning
        // to the prompt — precisely when alts were outperforming.
        //
        // When the API does not report the change, the honest answer is "no
        // signal". Deriving one from a different metric is how the inversion
        // happened in the first place.
        const dominanceChange = data?.data?.btc_dominance_change_percentage_24h;
        if (typeof dominanceChange !== 'number' || !Number.isFinite(dominanceChange)) return 'stable';
        if (dominanceChange > 0.5) return 'rising';
        if (dominanceChange < -0.5) return 'falling';
        return 'stable';
    } catch {
        return 'stable';
    }
};

/**
 * Calculate comprehensive correlation risk for a trading symbol
 */
export const calculateCorrelationRisk = async (symbol: string): Promise<CorrelationRiskResult> => {
    const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const isBTC = normalizedSymbol.startsWith('BTC');

    // For BTC itself, correlation risk is irrelevant
    if (isBTC) {
        return {
            btcDominance: await fetchBTCDominance(),
            btcDominanceTrend: await getBTCDominanceTrend(),
            btcAtMajorLevel: false,
            btcLevelType: 'none',
            btcLevelPrice: null,
            correlationRiskScore: 0,
            warnings: []
        };
    }

    // Fetch all data in parallel
    const [dominance, dominanceTrend, btcLevels] = await Promise.all([
        fetchBTCDominance(),
        getBTCDominanceTrend(),
        detectBTCMajorLevels()
    ]);

    let riskScore = 0;
    const warnings: string[] = [];

    // Risk Factor 1: BTC at major level (potential for BTC-led market move)
    if (btcLevels.atSupport || btcLevels.atResistance) {
        riskScore += 25;
        const levelType = btcLevels.atSupport ? 'support' : 'resistance';
        warnings.push(
            ` BTC at major ${levelType} ($${btcLevels.level?.toLocaleString()}). ` +
            `Potential for correlated move affecting ${normalizedSymbol}.`
        );
    }

    // Risk Factor 2: BTC dominance rising (alts typically underperform)
    if (dominanceTrend === 'rising') {
        riskScore += 20;
        warnings.push(
            ` BTC dominance rising (${dominance.toFixed(1)}%). ` +
            `Alt performance may lag or underperform.`
        );
    }

    // Risk Factor 3: High BTC dominance environment (>55%)
    if (dominance > 55) {
        riskScore += 15;
        warnings.push(
            ` High BTC dominance environment (${dominance.toFixed(1)}%). ` +
            `Reduce alt exposure or tighten stops.`
        );
    }

    // Risk Factor 4: Extreme dominance levels
    if (dominance > 60) {
        riskScore += 15;
        warnings.push(
            ` Extreme BTC dominance (${dominance.toFixed(1)}%). ` +
            `Consider waiting for BTC to consolidate before alt entries.`
        );
    }

    // Risk Factor 5: BTC volatility spillover risk
    if (btcLevels.atResistance && dominanceTrend === 'rising') {
        riskScore += 10;
        warnings.push(
            ` Double risk: BTC at resistance + rising dominance. ` +
            `Alt longs especially risky.`
        );
    }

    return {
        btcDominance: dominance,
        btcDominanceTrend: dominanceTrend,
        btcAtMajorLevel: btcLevels.atSupport || btcLevels.atResistance,
        btcLevelType: btcLevels.atSupport ? 'support' : btcLevels.atResistance ? 'resistance' : 'none',
        btcLevelPrice: btcLevels.level,
        correlationRiskScore: Math.min(100, riskScore),
        warnings
    };
};

/**
 * Generate correlation warnings based on trade direction
 */
export const generateCorrelationWarnings = (
    risk: CorrelationRiskResult,
    direction: 'Long' | 'Short'
): string[] => {
    const warnings = [...risk.warnings];

    // Additional direction-specific warnings
    if (direction === 'Long' && risk.btcLevelType === 'resistance') {
        warnings.push(
            ` Long entry while BTC at resistance. ` +
            `If BTC rejects, expect correlated pullback.`
        );
    }

    if (direction === 'Short' && risk.btcLevelType === 'support') {
        warnings.push(
            ` Short entry while BTC at support. ` +
            `If BTC bounces, expect correlated squeeze.`
        );
    }

    if (direction === 'Long' && risk.btcDominanceTrend === 'rising') {
        warnings.push(
            ` Going long on alt while BTC dominance rising. ` +
            `Consider BTC-paired trade instead.`
        );
    }

    return warnings;
};

/**
 * Generate a prompt injection for AI context with correlation risk data
 */
export const generateCorrelationRiskPrompt = (risk: CorrelationRiskResult): string => {
    if (risk.correlationRiskScore === 0) {
        return ''; // No correlation risk to report
    }

    let prompt = `
 **CORRELATION RISK ASSESSMENT** (Score: ${risk.correlationRiskScore}/100)

**BTC Dominance:** ${risk.btcDominance.toFixed(1)}% (${risk.btcDominanceTrend})
**BTC at Major Level:** ${risk.btcAtMajorLevel ? `YES - ${risk.btcLevelType} at $${risk.btcLevelPrice?.toLocaleString()}` : 'No'}

`;

    if (risk.warnings.length > 0) {
        prompt += `**Warnings:**\n`;
        risk.warnings.forEach(w => {
            prompt += `- ${w}\n`;
        });
    }

    prompt += `
**INSTRUCTIONS:** Factor these correlation risks into your confidence assessment.
- If risk score > 50: Consider downgrading confidence by one level
- If risk score > 75: Strongly recommend "Avoid" or reduce position size
`;

    return prompt;
};
