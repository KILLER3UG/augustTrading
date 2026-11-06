/**
 * ModelPerformanceService - Dynamic AI Model Weighting
 * Tracks per-model accuracy and adjusts ensemble weights based on performance
 */

import { AIProvider, LoggedTrade } from '../../types';
import type { TradeAnalysis } from '../../types/analysis';
import { clamp100 } from '../../utils/math';
import { MarketRegime } from '../analysis/TechnicalAnalysisService';
import {
    getPreferenceObject,
    setPreferenceObject,
    PREF_KEYS
} from '../infrastructure/PreferencesService';
import { ReinforcementSignalService } from '../learning/ReinforcementSignalService';

/**
 * Performance statistics for a specific condition
 */
export interface PerformanceStats {
    wins: number;
    losses: number;
    total: number;
    winRate: number;
}

/**
 * Complete performance data for an AI model
 */
export interface ModelPerformance {
    provider: AIProvider;
    overallStats: PerformanceStats;
    byFamily: {
        familyA: PerformanceStats;
        familyB: PerformanceStats;
        familyC: PerformanceStats;
        familyOmega: PerformanceStats;
    };
    byRegime: {
        trending: PerformanceStats;
        ranging: PerformanceStats;
        volatile: PerformanceStats;
        compression: PerformanceStats;
    };
    byConfidence: {
        high: PerformanceStats;
        medium: PerformanceStats;
        low: PerformanceStats;
    };
    recentTrend: 'improving' | 'stable' | 'declining';
    lastUpdated: string;
}

/**
 * Dynamic weights for ensemble models.
 * The fixed legacy fields (gemini, deepseek, etc.) are kept for backward
 * compatibility with consumers that read them; `byProvider` holds the full
 * dynamic map keyed by provider id.
 */
export interface DynamicWeights {
    gemini: number;      // 0-1
    deepseek: number;    // 0-1
    zhipu: number;       // 0-1
    groq: number;        // 0-1
    groqNew: number;     // 0-1
    groqAlt2: number;    // 0-1
    totalWeight: number;
    dominantModel: string | null;
    confidence: 'high' | 'medium' | 'low';
    byProvider?: Record<string, number>;
}

// =============================================================================
// ROLLING WINDOW & COLD STREAK DETECTION
// =============================================================================

/**
 * Trade type for situational expertise tracking
 */
export type TradeType = 'reversal' | 'continuation' | 'breakout' | 'range' | 'unknown';

/**
 * Individual trade entry for rolling window tracking
 */
export interface RecentTradeEntry {
    timestamp: string;
    provider: AIProvider;
    isWin: boolean;
    tradeType: TradeType;
    family?: string;
}

/**
 * Rolling window statistics for a provider (last N trades)
 */
export interface RollingWindowStats {
    last20WinRate: number;
    last20Total: number;
    last20Wins: number;
    coldStreakCount: number;         // Consecutive losses from most recent
    hotStreakCount: number;          // Consecutive wins from most recent
    isDemoted: boolean;              // Currently demoted due to cold streak
    demotedReason?: string;
}

/**
 * Situational expertise - reversal vs continuation performance
 */
export interface SituationalExpertise {
    reversalStats: PerformanceStats;   // Family A, B patterns (reversals/traps)
    continuationStats: PerformanceStats; // Family C, Omega patterns (continuations)
    strongestSituation: 'reversal' | 'continuation' | 'balanced';
}

/**
 * Rolling window data structure for all providers
 */
interface RollingWindowData {
    entries: RecentTradeEntry[];
    lastUpdated: string;
}

const CONFIDENCE_CALIBRATION_STORAGE_KEY = 'model_confidence_calibration';

// Configuration constants
const ROLLING_WINDOW_SIZE = 20;      // Number of recent trades to track
/**
 * Consecutive losses that count as a cold streak.
 *
 * EXPORTED, and previously consumed by UnderperformerFeedbackService (since
 * deleted — it had no importers).
 * this module and then re-declared the same rule locally. Two independent
 * definitions of one business rule is how they drift: today both read 3, and
 * changing only the feedback trigger to 4 would have made "feedback fires" and
 * "the model is demoted" silently disagree, with nothing pointing at the seam.
 *
 * Same failure shape as the v1.1.0 updater (artifactName vs the manifest) and
 * the v1.2.0 version (the tag vs package.json): one fact, two decision points.
 */
export const COLD_STREAK_THRESHOLD = 3;
// MULTIPLICATIVE: score *= this halves a model's weight on a cold streak.
// Renamed from COLD_STREAK_PENALTY, a name it shared with the provider-fitness
// module (deleted 2026-11-06) where the same name meant an ADDITIVE per-loss
// win-rate penalty of 0.05.
// Different operations, different units, identical name - so a refactor of one
// would have been applied to the other. This completes the consolidation of the
// cold-streak rule, whose THRESHOLD was also duplicated.
const COLD_STREAK_SCORE_MULTIPLIER = 0.5;
const UNDERPERFORMER_THRESHOLD = 0.15; // 15% below average to be flagged

/**
 * Model confidence calibration data
 */
interface ModelConfidenceCalibrationData {
    providers: Record<string, {
        high: { wins: number; total: number };
        medium: { wins: number; total: number };
        low: { wins: number; total: number };
    }>;
    lastUpdated: string;
}



/**
 * Initialize empty performance stats
 */
const initStats = (): PerformanceStats => ({
    wins: 0,
    losses: 0,
    total: 0,
    winRate: 0
});

// In-memory cache
let _performanceCache: AllModelPerformances | null = null;
let _rollingWindowCache: RollingWindowData | null = null;
let _confidenceCalibrationCache: ModelConfidenceCalibrationData | null = null;

// Initialization state
let _isInitialized = false;

/**
 * Initialize service - load all data into memory
 */
export const initModelPerformanceService = async (): Promise<void> => {
    if (_isInitialized) return;

    try {
        // Load in parallel
        const [perf, rolling, conf] = await Promise.all([
            getPreferenceObject<AllModelPerformances>(PREF_KEYS.MODEL_PERFORMANCE_DATA),
            getPreferenceObject<RollingWindowData>(PREF_KEYS.ROLLING_WINDOW_DATA),
            (async (): Promise<ModelConfidenceCalibrationData | null> => {
                migrateLegacyCalibrationKey();
                return getPreferenceObject<ModelConfidenceCalibrationData>(CONFIDENCE_CALIBRATION_STORAGE_KEY);
            })(),
        ]);

        _performanceCache = perf;
        _rollingWindowCache = rolling;
        _confidenceCalibrationCache = conf;

        _isInitialized = true;
        console.log('[ModelPerformance] Service initialized with cached data');
    } catch (e) {
        console.error('[ModelPerformance] Cached init failed:', e);
    }
};

/**
 * Initialize empty model performance
 */
const initModelPerformance = (provider: AIProvider): ModelPerformance => ({
    provider,
    overallStats: initStats(),
    byFamily: {
        familyA: initStats(),
        familyB: initStats(),
        familyC: initStats(),
        familyOmega: initStats()
    },
    byRegime: {
        trending: initStats(),
        ranging: initStats(),
        volatile: initStats(),
        compression: initStats()
    },
    byConfidence: {
        high: initStats(),
        medium: initStats(),
        low: initStats()
    },
    recentTrend: 'stable',
    lastUpdated: new Date().toISOString()
});

/**
 * All tracked model performances, keyed by provider id (ProviderConfig.id).
 * Dynamic — providers are user-configured, so entries are created on demand.
 */
type AllModelPerformances = Record<string, ModelPerformance>;

/** Ensure a provider has a performance entry; create one if missing. */
const ensureProviderEntry = (data: AllModelPerformances, provider: string): ModelPerformance => {
    if (!data[provider]) {
        data[provider] = initModelPerformance(provider);
    }
    return data[provider];
};

/**
 * Providers that contributed to a trade — dynamic `modelsUsed` keys first,
 * legacy per-provider fields as fallback for historical trades. THE one
 * provider list: every consumer of "who worked on this trade" routes here so
 * the per-analyst rosters cannot drift (a 3-field copy in useTradeLogging
 * once gave OpenRouter-only trades credit in the rebuild but none in the
 * incremental path).
 */
export const getTradeProviders = (trade: LoggedTrade): string[] => {
    if (trade.modelsUsed && Object.keys(trade.modelsUsed).length > 0) {
        return Object.keys(trade.modelsUsed);
    }
    const legacy: string[] = [];
    if (trade.geminiModelUsed) legacy.push(AIProvider.GEMINI);
    if (trade.deepseekModelUsed) legacy.push(AIProvider.DEEPSEEK);
    if (trade.zhipuModelUsed) legacy.push(AIProvider.ZHIPU);
    if (trade.groqModelUsed) legacy.push(AIProvider.GROQ);
    if (trade.groqNewModelUsed) legacy.push(AIProvider.GROQ_NEW);
    if (trade.groqAlt2ModelUsed) legacy.push(AIProvider.GROQ_ALT2);
    if (trade.openrouterModelUsed) legacy.push(AIProvider.OPENROUTER);
    return legacy;
};

/**
 * Per-analyst credit assignment — THE one semantic for "did this analyst's
 * call win?". The consensus entries record each analyst's OWN directional
 * call; crediting every model with the moderator's verdict made per-model
 * accuracy and the dynamic weights pure noise (a bearish analyst was rewarded
 * for a winning Long). Agreeing analysts get the trade outcome; analysts who
 * called the OPPOSITE direction get the inverse (their call lost).
 * trackTradeOutcome (incremental) and syncFromTradeLog (rebuild) BOTH route
 * through this — when only one did, the same model's weight changed meaning
 * across every restart.
 */
export const creditedWinForAnalyst = (
    analysis: TradeAnalysis | undefined,
    isWin: boolean,
    providerId: string
): boolean => {
    const entry = analysis?.analystConsensus?.entries.find(
        e => e.thoughtsKey === providerId || e.providerId === providerId
    );
    const tradeDirection = analysis?.direction;
    if (entry?.direction && tradeDirection) {
        const agreed = String(entry.direction).toLowerCase() === String(tradeDirection).toLowerCase();
        return agreed ? isWin : !isWin;
    }
    return isWin;
};

/**
 * Recent-trend from the rolling window (last 10), falling back to the all-time
 * win rate when the window is thin — the one derivation the incremental and
 * rebuild paths share. The rebuild used to read all-time here, so the same
 * model could flip improving/declining across a restart.
 */
const deriveRecentTrend = (
    provider: string,
    overallWinRate: number
): 'improving' | 'stable' | 'declining' => {
    const recentEntries = loadRollingWindowData().entries
        .filter(e => e.provider === provider)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 10);
    const winRate = recentEntries.length >= 5
        ? (recentEntries.filter(e => e.isWin).length / recentEntries.length) * 100
        : overallWinRate;
    if (winRate > 60) return 'improving';
    if (winRate < 40) return 'declining';
    return 'stable';
};

/** Weight record seeded for the enabled providers (dynamic ids). */
const createWeightRecord = (enabledProviders: AIProvider[]): Record<string, number> => {
    const weights: Record<string, number> = {};
    for (const provider of enabledProviders) {
        weights[provider] = 0;
    }
    return weights;
};

/**
 * Build a DynamicWeights result. Legacy brand fields are kept populated for
 * backward compatibility; `byProvider` is the canonical dynamic record.
 */
const buildDynamicWeightsOutput = (
    weights: Record<string, number>,
    dominantModel: string | null,
    confidence: 'high' | 'medium' | 'low'
): DynamicWeights => {
    const round = (id: string): number => Math.round((weights[id] ?? 0) * 100) / 100;
    const byProvider: Record<string, number> = {};
    for (const [id, value] of Object.entries(weights)) {
        byProvider[id] = Math.round(value * 100) / 100;
    }
    return {
        gemini: round(AIProvider.GEMINI),
        deepseek: round(AIProvider.DEEPSEEK),
        zhipu: round(AIProvider.ZHIPU),
        groq: round(AIProvider.GROQ),
        groqNew: round(AIProvider.GROQ_NEW),
        groqAlt2: round(AIProvider.GROQ_ALT2),
        totalWeight: 1,
        dominantModel,
        confidence,
        byProvider,
    };
};

/**
 * Load performance data from localStorage
 */
/**
 * Load performance data (from cache or default)
 */
export const loadPerformanceData = (): AllModelPerformances => {
    // If not initialized, try to load synchronously from localStorage (web fallback)
    // or return cache if available
    if (_performanceCache) return _performanceCache;

    // Fallback for first run or web before async init
    try {
        const stored = localStorage.getItem(PREF_KEYS.MODEL_PERFORMANCE_DATA);
        if (stored) {
            _performanceCache = JSON.parse(stored);
            return _performanceCache!;
        }
    } catch (e) {
        // Ignore
    }

    // Return default empty performances (entries are created on demand)
    const empty: AllModelPerformances = {};

    _performanceCache = empty;
    return empty;
};

/**
 * Save performance data to localStorage
 */
/**
 * Save performance data (to cache and async storage)
 */
export const savePerformanceData = (data: AllModelPerformances): void => {
    _performanceCache = data;
    // Fire and forget async save
    setPreferenceObject(PREF_KEYS.MODEL_PERFORMANCE_DATA, data).catch(e =>
        console.warn('[ModelPerformance] Failed to save data:', e)
    );
};

/**
 * Update stats based on win/loss
 */
const updateStats = (stats: PerformanceStats, isWin: boolean): PerformanceStats => {
    const newStats = { ...stats };
    newStats.total++;
    if (isWin) {
        newStats.wins++;
    } else {
        newStats.losses++;
    }
    newStats.winRate = newStats.total > 0 ? (newStats.wins / newStats.total) * 100 : 0;
    return newStats;
};

/**
 * Map family string to key
 */
const mapFamilyToKey = (family: string): 'familyA' | 'familyB' | 'familyC' | 'familyOmega' | null => {
    const f = family?.toLowerCase() || '';
    // "Family X" strings all contain the letter 'a' (inside "Family") — match
    // the family IDENTIFIER, not bare letters, so stats don't collapse into
    // familyA. Omega is checked first (it also contains 'a').
    if (/\bfamily\s*omega\b/.test(f) || f.includes('omega') || f.includes('momentum')) return 'familyOmega';
    if (/\bfamily\s*a\b/.test(f) || f.includes('exhaustion') || f.includes('trap')) return 'familyA';
    if (/\bfamily\s*b\b/.test(f) || f.includes('reversal')) return 'familyB';
    if (/\bfamily\s*c\b/.test(f) || f.includes('continuation')) return 'familyC';
    return null;
};

/**
 * Map regime to key
 */
export const mapRegimeToKey = (regime: string): 'trending' | 'ranging' | 'volatile' | 'compression' => {
    const r = (regime || '').toLowerCase();
    // Accepts both the 7-value TechnicalAnalysisService regime
    // (strong_trend_up, volatile_chop, ...) and the normalized 4-key set.
    if (r.includes('trend')) return 'trending';
    if (r === 'ranging' || r.includes('range') || r.includes('consolidat')) return 'ranging';
    if (r === 'volatile' || r.includes('volatile') || r.includes('chop')) return 'volatile';
    if (r === 'compression' || r.includes('compression')) return 'compression';
    return 'ranging';
};

/**
 * Map confidence to key
 */
const mapConfidenceToKey = (confidence: string): 'high' | 'medium' | 'low' => {
    const c = confidence?.toLowerCase() || '';
    if (c === 'high') return 'high';
    if (c === 'medium') return 'medium';
    return 'low';
};

/**
 * Track a trade outcome for a specific model
 */
export const trackTradeOutcome = (
    provider: AIProvider,
    isWin: boolean,
    family: string,
    regime: string,
    confidence: string,
    trade?: { direction?: string; entryPrice?: number; id?: string }
): void => {
    const data = loadPerformanceData();
    const modelData = ensureProviderEntry(data, provider);

    // Update overall stats
    modelData.overallStats = updateStats(modelData.overallStats, isWin);

    // Update family stats
    const familyKey = mapFamilyToKey(family);
    if (familyKey) {
        modelData.byFamily[familyKey] = updateStats(modelData.byFamily[familyKey], isWin);
    }

    // Update regime stats
    const regimeKey = mapRegimeToKey(regime);
    modelData.byRegime[regimeKey] = updateStats(modelData.byRegime[regimeKey], isWin);

    // Update confidence stats
    const confKey = mapConfidenceToKey(confidence);
    modelData.byConfidence[confKey] = updateStats(modelData.byConfidence[confKey], isWin);

    // Update timestamp
    modelData.lastUpdated = new Date().toISOString();

    // Append this outcome to the rolling window FIRST, so the recent-trend
    // read below (and cold-streak demotion / weighted voting elsewhere, all of
    // which consume getRollingWindowStats) reflect the CURRENT trade. Until now
    // updateRollingWindow had zero production callers, so the window was frozen
    // at its startup snapshot — a model on a live 5-loss streak was never
    // demoted mid-session.
    updateRollingWindow(provider, isWin, family);

    // Calculate recent trend from the rolling window (last 10 trades), NOT the
    // all-time win rate — a model in a current slump with good history used to
    // be reported 'improving' and handed the +5 weight bonus.
    modelData.recentTrend = deriveRecentTrend(provider, modelData.overallStats.winRate);

    data[provider] = modelData;
    savePerformanceData(data);

    console.log(`[ModelPerformance] Updated ${provider}: Win=${isWin}, WinRate=${modelData.overallStats.winRate.toFixed(1)}%`);

    // NEW: Record Reinforcement Learning Signal (Item 1.1)
    ReinforcementSignalService.recordSignal(
        // Use the REAL trade id when available — the fabricated Date.now() id
        // never matched the dedupe in ReinforcementSignalService (keyed by
        // tradeId+provider), so re-logging the same trade emitted duplicate
        // RL signals.
        trade?.id || `trade_${Date.now()}`, // Fallback id generation if not passed
        provider,
        isWin ? 'WIN' : 'LOSS',
        {
            // Use the real trade data when available instead of placeholders
            // (Neutral/0 poisoned the training signal with noise).
            direction: (trade?.direction as 'Long' | 'Short' | 'Neutral') || 'Neutral',
            confidence: confidence,
            entryPrice: trade?.entryPrice || 0
        }
    );
};

/**
 * Calculate dynamic weights based on current conditions
 */
export const calculateDynamicWeights = (
    currentRegime: MarketRegime,
    currentFamily: string,
    enabledProviders: AIProvider[]
): DynamicWeights => {
    const data = loadPerformanceData();
    const regimeKey = mapRegimeToKey(currentRegime);
    const familyKey = mapFamilyToKey(currentFamily);

    const weights: Record<string, number> = createWeightRecord(enabledProviders);

    let hasEnoughData = false;
    const minTradesRequired = 5;

    // Calculate weight for each enabled provider
    for (const provider of enabledProviders) {
        const modelData = ensureProviderEntry(data, provider);
        let score = 50; // Base score

        // Add regime performance bonus (0-30 points)
        const regimeStats = modelData.byRegime[regimeKey];
        if (regimeStats.total >= minTradesRequired) {
            hasEnoughData = true;
            score += (regimeStats.winRate - 50) * 0.6; // Up to ±30
        }

        // Add family performance bonus (0-20 points)
        if (familyKey) {
            const familyStats = modelData.byFamily[familyKey];
            if (familyStats.total >= minTradesRequired) {
                hasEnoughData = true;
                score += (familyStats.winRate - 50) * 0.4; // Up to ±20
            }
        }

        // Add overall performance factor
        if (modelData.overallStats.total >= minTradesRequired) {
            hasEnoughData = true;
            const overallBonus = (modelData.overallStats.winRate - 50) * 0.3;
            score += overallBonus;
        }

        // Recent trend adjustment
        if (modelData.recentTrend === 'improving') {
            score += 5;
        } else if (modelData.recentTrend === 'declining') {
            score -= 5;
        }

        // Clamp score to 0-100
        score = clamp100(score);

        // Convert to 0-1 weight
        weights[provider] = score / 100;
    }

    // If not enough data, use equal weights
    if (!hasEnoughData) {
        const equalWeight = 1 / enabledProviders.length;
        for (const provider of enabledProviders) {
            weights[provider] = equalWeight;
        }
    }

    // Normalize weights to sum to 1
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
        for (const provider of Object.keys(weights) as AIProvider[]) {
            weights[provider] = weights[provider] / totalWeight;
        }
    }

    // Find dominant model
    let dominantModel: AIProvider | null = null;
    let maxWeight = 0;
    for (const provider of enabledProviders) {
        if (weights[provider] > maxWeight) {
            maxWeight = weights[provider];
            dominantModel = provider;
        }
    }

    // Determine confidence in weighting
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (hasEnoughData) {
        const variance = enabledProviders.reduce((sum, p) => {
            const mean = 1 / enabledProviders.length;
            return sum + Math.pow(weights[p] - mean, 2);
        }, 0) / enabledProviders.length;

        if (variance > 0.05) {
            confidence = 'high'; // Clear differentiation
        } else if (variance > 0.02) {
            confidence = 'medium';
        }
    }

    return buildDynamicWeightsOutput(weights, dominantModel, confidence);
};

/**
 * Generate weighted voting context for moderator prompt injection.
 * Provides historical accuracy data to inform the moderator's weighting of analyst opinions.
 */
export const generateWeightedVotingContext = (
    enabledProviders: AIProvider[],
    currentFamily?: string
): string => {
    if (enabledProviders.length === 0) return '';

    const data = loadPerformanceData();
    const providerStats: { provider: AIProvider; winRate: number; total: number; trend: string; coldStreak: number }[] = [];

    for (const provider of enabledProviders) {
        const perf = ensureProviderEntry(data, provider);
        const rollingStats = getRollingWindowStats(provider);
        providerStats.push({
            provider,
            winRate: perf.overallStats.total >= 3 ? perf.overallStats.winRate : 0,
            total: perf.overallStats.total,
            trend: perf.recentTrend,
            coldStreak: rollingStats.coldStreakCount
        });
    }

    // Sort by win rate descending
    providerStats.sort((a, b) => b.winRate - a.winRate);

    // Identify best and worst performers
    const hasEnoughData = providerStats.some(s => s.total >= 5);
    if (!hasEnoughData) {
        return `
**⚖️ WEIGHTED VOTING: INSUFFICIENT DATA**
Not enough historical trades to establish accuracy rankings.
Treat all analyst opinions with equal weight until more data is available.
`;
    }

    const best = providerStats[0];
    const worst = providerStats[providerStats.length - 1];
    const spreadPct = best.winRate - worst.winRate;

    // Build ranking table
    let rankingTable = '';
    providerStats.forEach((s, idx) => {
        const rank = idx + 1;
        const streakWarning = s.coldStreak >= 3 ? ` COLD STREAK (${s.coldStreak})` : '';
        const trendIcon = s.trend === 'improving' ? '' : s.trend === 'declining' ? '' : '';
        rankingTable += `${rank}. **${s.provider.toUpperCase()}**: ${s.winRate.toFixed(1)}% (${s.total} trades) ${trendIcon} ${streakWarning}\n`;
    });

    // Generate context
    let context = `
**⚖️ WEIGHTED VOTING BASED ON HISTORICAL ACCURACY**

${rankingTable}

**MODERATOR INSTRUCTIONS:**
`;

    // Add specific instructions based on spread
    if (spreadPct > 20) {
        context += `- **Strong differentiation detected**: Weight ${best.provider.toUpperCase()}'s analysis significantly higher (${spreadPct.toFixed(0)}% accuracy advantage).
- Be skeptical of ${worst.provider.toUpperCase()}'s recommendations unless strongly corroborated.
`;
    } else if (spreadPct > 10) {
        context += `- **Moderate differentiation**: Favor ${best.provider.toUpperCase()}'s analysis when opinions conflict.
`;
    } else {
        context += `- **Similar accuracy levels**: All analysts have comparable track records. Focus on argument quality.
`;
    }

    // Add cold streak warnings
    const coldStreakProviders = providerStats.filter(s => s.coldStreak >= 3);
    if (coldStreakProviders.length > 0) {
        context += `\n** COLD STREAK WARNINGS:**\n`;
        coldStreakProviders.forEach(s => {
            context += `- ${s.provider.toUpperCase()} is on a ${s.coldStreak}-loss streak. Apply extra scrutiny to their recommendations.\n`;
        });
    }

    // Add family-specific insight if available
    if (currentFamily) {
        const familyKey = mapFamilyToKey(currentFamily);
        if (familyKey) {
            const familyBest = providerStats.reduce((best, current) => {
                const currentFamilyRate = ensureProviderEntry(data, current.provider).byFamily[familyKey]?.winRate || 0;
                const bestFamilyRate = ensureProviderEntry(data, best.provider).byFamily[familyKey]?.winRate || 0;
                return currentFamilyRate > bestFamilyRate ? current : best;
            });
            const familyWinRate = ensureProviderEntry(data, familyBest.provider).byFamily[familyKey]?.winRate;
            if (familyWinRate && familyWinRate > 0) {
                context += `\n**${currentFamily.toUpperCase()} SPECIALIST:** ${familyBest.provider.toUpperCase()} has the highest win rate (${familyWinRate.toFixed(1)}%) for this pattern family.\n`;
            }
        }
    }

    return context.trim();
};


/**
 * Analyze trades from trade log and update model performance
 * Call this when loading app or after trade outcomes are recorded
 */
export const syncFromTradeLog = (trades: LoggedTrade[]): void => {
    // Reset data (entries are created on demand per provider id)
    const data: AllModelPerformances = {};

    // Process each trade
    for (const trade of trades) {
        if (trade.outcome === 'WIN' || trade.outcome === 'LOSS') {
            const isWin = trade.outcome === 'WIN';
            const family = trade.analysis?.detectedPatternFamily || '';
            const confidence = trade.analysis?.confidence || 'medium';

            // Derive the regime from the analysis's market snapshot when it was
            // captured (the hybrid packet stores the regime at analysis time).
            // The old hardcoded 'ranging' put every trade in one bucket, which
            // is noise for the regime-weighted dynamic model weights.
            const snapshot = trade.analysis?.marketSnapshot as { regime?: { regime?: string } } | undefined;
            const regime: MarketRegime = (snapshot?.regime?.regime as MarketRegime) || trade.marketRegime || 'ranging';

            // Track for each model that was used (dynamic provider ids)
            const usedProviders = getTradeProviders(trade);

            for (const provider of usedProviders) {
                const modelData = ensureProviderEntry(data, provider);

                // Same per-analyst credit semantic as the incremental path
                // (creditedWinForAnalyst). The rebuild used to credit every
                // provider the raw verdict, so each dissenting analyst's
                // record flipped meaning on every app restart.
                const creditedWin = creditedWinForAnalyst(trade.analysis, isWin, provider);

                // Update overall
                modelData.overallStats = updateStats(modelData.overallStats, creditedWin);

                // Update family
                const familyKey = mapFamilyToKey(family);
                if (familyKey) {
                    modelData.byFamily[familyKey] = updateStats(modelData.byFamily[familyKey], creditedWin);
                }

                // Update regime
                const regimeKey = mapRegimeToKey(regime);
                modelData.byRegime[regimeKey] = updateStats(modelData.byRegime[regimeKey], creditedWin);

                // Update confidence
                const confKey = mapConfidenceToKey(confidence);
                modelData.byConfidence[confKey] = updateStats(modelData.byConfidence[confKey], creditedWin);

                modelData.lastUpdated = new Date().toISOString();
            }
        }
    }

    // Calculate trends from the rolling window — the SAME derivation the
    // incremental path uses (deriveRecentTrend), not the all-time rate.
    for (const provider of Object.keys(data) as AIProvider[]) {
        const perf = data[provider];
        if (perf.overallStats.total >= 5) {
            perf.recentTrend = deriveRecentTrend(provider, perf.overallStats.winRate);
        }
    }

    savePerformanceData(data);
    console.log('[ModelPerformance] Synced from trade log:', trades.length, 'trades processed');
};

// =============================================================================
// ROLLING WINDOW FUNCTIONS
// =============================================================================

/**
 * Load rolling window data
 */
export const loadRollingWindowData = (): RollingWindowData => {
    if (_rollingWindowCache) return _rollingWindowCache;

    try {
        const stored = localStorage.getItem(PREF_KEYS.ROLLING_WINDOW_DATA);
        if (stored) {
            _rollingWindowCache = JSON.parse(stored);
            return _rollingWindowCache!;
        }
    } catch (e) { /* intentionally ignored: cache parse failure */ }

    const empty = { entries: [], lastUpdated: new Date().toISOString() };
    _rollingWindowCache = empty;
    return empty;
};

/**
 * Save rolling window data
 */
export const saveRollingWindowData = (data: RollingWindowData): void => {
    _rollingWindowCache = data;
    setPreferenceObject(PREF_KEYS.ROLLING_WINDOW_DATA, data).catch(e =>
        console.warn('[ModelPerformance] Failed to save rolling window:', e)
    );
};

/**
 * Determine trade type from family string
 */
export const mapFamilyToTradeType = (family: string): TradeType => {
    const f = family?.toLowerCase() || '';
    // Match the family IDENTIFIER with word boundaries — the old bare-letter
    // checks matched the 'a' inside "family" itself (and the 'b' inside
    // "breakout"), so EVERY family classified as 'reversal' and the
    // continuation/breakout buckets stayed nearly empty. That skewed
    // getSituationalExpertise and the situational bonuses in the dynamic
    // ensemble weights. Mirrors mapFamilyToKey's approach.
    if (/\bfamily\s*omega\b/.test(f) || f.includes('omega') || f.includes('momentum')) {
        return 'continuation';
    }
    if (/\bfamily\s*a\b/.test(f) || /\bfamily\s*b\b/.test(f) || f.includes('reversal') || f.includes('trap') || f.includes('exhaustion')) {
        return 'reversal';
    }
    if (/\bfamily\s*c\b/.test(f) || f.includes('continuation')) {
        return 'continuation';
    }
    if (f.includes('breakout') || f.includes('break')) {
        return 'breakout';
    }
    if (f.includes('range') || f.includes('ranging')) {
        return 'range';
    }
    return 'unknown';
};

/**
 * Update rolling window with a new trade entry
 * Maintains max ROLLING_WINDOW_SIZE entries per provider
 */
export const updateRollingWindow = (
    provider: AIProvider,
    isWin: boolean,
    family: string
): void => {
    const data = loadRollingWindowData();

    const newEntry: RecentTradeEntry = {
        timestamp: new Date().toISOString(),
        provider,
        isWin,
        tradeType: mapFamilyToTradeType(family),
        family
    };

    // Add new entry
    data.entries.push(newEntry);

    // Keep only entries within the rolling window per provider
    const providerEntries = data.entries.filter(e => e.provider === provider);
    if (providerEntries.length > ROLLING_WINDOW_SIZE) {
        // Remove oldest entries for this provider
        const excessCount = providerEntries.length - ROLLING_WINDOW_SIZE;
        let removed = 0;
        data.entries = data.entries.filter(e => {
            if (e.provider === provider && removed < excessCount) {
                removed++;
                return false;
            }
            return true;
        });
    }

    data.lastUpdated = new Date().toISOString();
    saveRollingWindowData(data);

    console.log(`[RollingWindow] Updated ${provider}: Win=${isWin}, Total entries=${data.entries.filter(e => e.provider === provider).length}`);
};

/**
 * Get rolling window statistics for a provider
 */
export const getRollingWindowStats = (provider: AIProvider): RollingWindowStats => {
    const data = loadRollingWindowData();
    const providerEntries = data.entries
        .filter(e => e.provider === provider)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Most recent first

    const total = providerEntries.length;
    const wins = providerEntries.filter(e => e.isWin).length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    // Calculate cold/hot streak from most recent trades
    let coldStreak = 0;
    let hotStreak = 0;

    for (const entry of providerEntries) {
        if (!entry.isWin) {
            if (hotStreak === 0) coldStreak++;
            else break;
        } else {
            if (coldStreak === 0) hotStreak++;
            else break;
        }
    }

    // Determine if model is demoted
    const isDemoted = coldStreak >= COLD_STREAK_THRESHOLD;
    const demotedReason = isDemoted
        ? `${coldStreak} consecutive losses (threshold: ${COLD_STREAK_THRESHOLD})`
        : undefined;

    return {
        last20WinRate: Math.round(winRate * 10) / 10,
        last20Total: total,
        last20Wins: wins,
        coldStreakCount: coldStreak,
        hotStreakCount: hotStreak,
        isDemoted,
        demotedReason
    };
};

/**
 * Get situational expertise for a provider (reversal vs continuation)
 */
export const getSituationalExpertise = (provider: AIProvider): SituationalExpertise => {
    const data = loadRollingWindowData();
    const providerEntries = data.entries.filter(e => e.provider === provider);

    // Separate by trade type
    const reversalTrades = providerEntries.filter(e => e.tradeType === 'reversal');
    const continuationTrades = providerEntries.filter(e =>
        e.tradeType === 'continuation' || e.tradeType === 'breakout'
    );

    const calcStats = (trades: RecentTradeEntry[]): PerformanceStats => {
        const wins = trades.filter(t => t.isWin).length;
        const total = trades.length;
        return {
            wins,
            losses: total - wins,
            total,
            winRate: total > 0 ? (wins / total) * 100 : 0
        };
    };

    const reversalStats = calcStats(reversalTrades);
    const continuationStats = calcStats(continuationTrades);

    // Determine strongest situation (need at least 3 trades to make determination)
    let strongestSituation: 'reversal' | 'continuation' | 'balanced' = 'balanced';

    if (reversalStats.total >= 3 && continuationStats.total >= 3) {
        const diff = reversalStats.winRate - continuationStats.winRate;
        if (diff > 15) strongestSituation = 'reversal';
        else if (diff < -15) strongestSituation = 'continuation';
    } else if (reversalStats.total >= 3 && reversalStats.winRate > 55) {
        strongestSituation = 'reversal';
    } else if (continuationStats.total >= 3 && continuationStats.winRate > 55) {
        strongestSituation = 'continuation';
    }

    return {
        reversalStats,
        continuationStats,
        strongestSituation
    };
};

/**
 * Identify the lowest performing model from enabled providers
 */
export const identifyLowestPerformer = (
    enabledProviders: AIProvider[]
): {
    provider: AIProvider;
    winRate: number;
    recentLosses: number;
    isSignificantlyWorse: boolean;
} | null => {
    if (enabledProviders.length === 0) return null;

    const stats = enabledProviders.map(p => ({
        provider: p,
        ...getRollingWindowStats(p)
    }));

    // Filter to providers with enough data
    const withData = stats.filter(s => s.last20Total >= 3);
    if (withData.length === 0) return null;

    // Calculate average win rate
    const avgWinRate = withData.reduce((sum, s) => sum + s.last20WinRate, 0) / withData.length;

    // Find lowest performer
    const lowest = withData.reduce((min, s) =>
        s.last20WinRate < min.last20WinRate ? s : min
    );

    const isSignificantlyWorse = (avgWinRate - lowest.last20WinRate) / 100 >= UNDERPERFORMER_THRESHOLD;

    return {
        provider: lowest.provider,
        winRate: lowest.last20WinRate,
        recentLosses: lowest.coldStreakCount,
        isSignificantlyWorse
    };
};

/**
 * Enhanced calculateDynamicWeights with rolling window priority
 */
export const calculateDynamicWeightsEnhanced = (
    currentRegime: MarketRegime,
    currentFamily: string,
    enabledProviders: AIProvider[]
): DynamicWeights => {
    const allTimeData = loadPerformanceData();
    const regimeKey = mapRegimeToKey(currentRegime);
    const familyKey = mapFamilyToKey(currentFamily);
    const tradeType = mapFamilyToTradeType(currentFamily);

    const weights: Record<string, number> = createWeightRecord(enabledProviders);

    let hasEnoughData = false;
    const minTradesRequired = 3;

    for (const provider of enabledProviders) {
        const allTimeStats = ensureProviderEntry(allTimeData, provider);
        const rollingStats = getRollingWindowStats(provider);
        const expertise = getSituationalExpertise(provider);

        let score = 50; // Base score

        // PRIORITY 1: Rolling window performance (last 20 trades) - up to ±25 points
        if (rollingStats.last20Total >= minTradesRequired) {
            hasEnoughData = true;
            score += (rollingStats.last20WinRate - 50) * 0.5; // Up to ±25
        }

        // PRIORITY 2: Situational expertise bonus - up to ±15 points
        if (tradeType === 'reversal' && expertise.reversalStats.total >= minTradesRequired) {
            score += (expertise.reversalStats.winRate - 50) * 0.3;
        } else if (tradeType === 'continuation' && expertise.continuationStats.total >= minTradesRequired) {
            score += (expertise.continuationStats.winRate - 50) * 0.3;
        }

        // PRIORITY 3: All-time regime performance - up to ±10 points
        const regimeStats = allTimeStats.byRegime[regimeKey];
        if (regimeStats.total >= minTradesRequired) {
            hasEnoughData = true;
            score += (regimeStats.winRate - 50) * 0.2;
        }

        // PRIORITY 4: Hot/cold streak adjustment
        if (rollingStats.hotStreakCount >= 3) {
            score += 8; // Hot streak bonus
        }

        // COLD STREAK PENALTY - significant reduction
        if (rollingStats.isDemoted) {
            score *= COLD_STREAK_SCORE_MULTIPLIER; // 50% reduction
            console.log(`[DynamicWeights] ${provider} demoted: ${rollingStats.demotedReason}`);
        }

        // Clamp score to 0-100
        score = clamp100(score);
        weights[provider] = score / 100;
    }

    // If not enough data, use equal weights
    if (!hasEnoughData) {
        const equalWeight = 1 / enabledProviders.length;
        for (const provider of enabledProviders) {
            weights[provider] = equalWeight;
        }
    }

    // Normalize weights to sum to 1
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight > 0) {
        for (const provider of Object.keys(weights) as AIProvider[]) {
            weights[provider] = weights[provider] / totalWeight;
        }
    }

    // Find dominant model
    let dominantModel: AIProvider | null = null;
    let maxWeight = 0;
    for (const provider of enabledProviders) {
        if (weights[provider] > maxWeight) {
            maxWeight = weights[provider];
            dominantModel = provider;
        }
    }

    // Determine confidence in weighting
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (hasEnoughData) {
        const variance = enabledProviders.reduce((sum, p) => {
            const mean = 1 / enabledProviders.length;
            return sum + Math.pow(weights[p] - mean, 2);
        }, 0) / enabledProviders.length;

        if (variance > 0.05) confidence = 'high';
        else if (variance > 0.02) confidence = 'medium';
    }

    return buildDynamicWeightsOutput(weights, dominantModel, confidence);
};

/**
 * Sync rolling window from trade log
 * Call this when loading app to populate rolling window from existing trades
 */
export const syncRollingWindowFromTradeLog = (trades: LoggedTrade[]): void => {
    // Clear existing rolling window
    const data: RollingWindowData = { entries: [], lastUpdated: new Date().toISOString() };

    // Sort trades by timestamp (oldest first) and take last N
    const sortedTrades = [...trades]
        .filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS')
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    for (const trade of sortedTrades) {
        const isWin = trade.outcome === 'WIN';
        const family = trade.analysis?.detectedPatternFamily || '';
        const tradeType = mapFamilyToTradeType(family);

        // Determine which providers were used (dynamic provider ids)
        const usedProviders = getTradeProviders(trade);

        for (const provider of usedProviders) {
            data.entries.push({
                timestamp: trade.timestamp,
                provider,
                isWin,
                tradeType,
                family
            });
        }
    }

    // Trim to rolling window size per provider
    const providers = new Set(data.entries.map(e => e.provider));
    for (const provider of providers) {
        const providerEntries = data.entries
            .filter(e => e.provider === provider)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        if (providerEntries.length > ROLLING_WINDOW_SIZE) {
            const toKeep = new Set(providerEntries.slice(0, ROLLING_WINDOW_SIZE).map(e => e.timestamp + e.provider));
            data.entries = data.entries.filter(e =>
                e.provider !== provider || toKeep.has(e.timestamp + e.provider)
            );
        }
    }

    saveRollingWindowData(data);
    console.log('[RollingWindow] Synced from trade log:', data.entries.length, 'entries');
};

// =============================================================================
// IMPROVEMENT 2: CONFIDENCE CALIBRATION PER MODEL
// =============================================================================

/**
 * MIGRATION (2026-09-13): this per-model blob used to live on the shared
 * `confidence_calibration` key, colliding with the bucketed
 * ConfidenceCalibration the VersionHistoryDashboard reads from that same key
 * (and parsing into a shape whose fields were all `undefined` — silent data
 * corruption). The providers-shaped blob now owns its own key
 * (`model_confidence_calibration`). One-time lift from the shared key when it
 * still holds OUR shape (has `providers`); the dashboard's shape is left alone.
 */
function migrateLegacyCalibrationKey(): void {
    try {
        const mine = localStorage.getItem(CONFIDENCE_CALIBRATION_STORAGE_KEY);
        if (mine) return;
        const legacy = localStorage.getItem(PREF_KEYS.CONFIDENCE_CALIBRATION);
        if (!legacy) return;
        const parsed = JSON.parse(legacy) as { providers?: unknown };
        if (parsed && typeof parsed === 'object' && parsed.providers) {
            localStorage.setItem(CONFIDENCE_CALIBRATION_STORAGE_KEY, legacy);
            localStorage.removeItem(PREF_KEYS.CONFIDENCE_CALIBRATION);
        }
    } catch { /* best-effort */ }
};

/**
 * Record ONE per-provider confidence-calibration sample: the confidence word
 * the analysis carried and whether the call won (per-analyst credit). This
 * store had NO writer anywhere — the Brier summaries on the trader profile
 * and injected into moderator prompts were frozen at the legacy blob (empty
 * on fresh installs) while looking live. Called from the trade-log learning
 * path right next to trackTradeOutcome.
 */
export const recordProviderConfidenceCalibration = (
    provider: string,
    confidence: string,
    isWin: boolean
): void => {
    const key = confidence.toLowerCase();
    if (key !== 'high' && key !== 'medium' && key !== 'low') return;
    const data = loadConfidenceCalibrationData();
    const buckets = data.providers[provider] || {
        high: { wins: 0, total: 0 },
        medium: { wins: 0, total: 0 },
        low: { wins: 0, total: 0 },
    };
    const bucket = buckets[key];
    buckets[key] = { wins: bucket.wins + (isWin ? 1 : 0), total: bucket.total + 1 };
    data.providers[provider] = buckets;
    data.lastUpdated = new Date().toISOString();
    _confidenceCalibrationCache = data;
    setPreferenceObject(CONFIDENCE_CALIBRATION_STORAGE_KEY, data).catch(e =>
        console.warn('[ModelPerformance] Failed to save confidence calibration:', e)
    );
};

/**
 * Rebuild the per-provider confidence buckets from the trade log at boot, the
 * way `syncFromTradeLog` rebuilds the performance ledger beside it.
 *
 * `recordProviderConfidenceCalibration` is counters-only — wins/total with no
 * entry log — so a trade that is re-settled, deleted or mirror-corrected after
 * the fact never un-counts its sample, and the Brier summary reads the buckets
 * as live. Rebuilding from the same rows the incremental writer consumed makes
 * the store "possibly stale, never wrong", and BOTH writers share the one
 * derivation (`getTradeProviders` + `creditedWinForAnalyst` + the same
 * levelsMirrored skip), so they cannot quietly disagree.
 *
 * Providers the log cannot reconstruct (the migrated legacy shelf) are kept,
 * not dropped: a rebuild that loses rows is its own kind of wrong.
 */
export const syncConfidenceCalibrationFromTradeLog = (trades: LoggedTrade[]): void => {
    const rebuilt: ModelConfidenceCalibrationData['providers'] = {};
    for (const trade of trades) {
        if (trade.outcome !== 'WIN' && trade.outcome !== 'LOSS') continue;
        const isWin = trade.outcome === 'WIN';
        // The incremental writer credits NOTHING for a mirrored plan
        // (`levelsCorrected` hides the model's own call), so the rebuild must
        // skip the same rows or a corrected trade would start counting. Same
        // for a settled trade with no analysis: the incremental writer returns
        // on `!analysis` (useTradeLogging autoLearnFromOutcome), so counting
        // it here as a default-Medium sample would inflate that bucket with
        // rows the other writer never sees. (Both review branches added this
        // skip independently; the merge kept one.)
        if (!trade.analysis) continue;
        if (trade.analysis?.levelsCorrected === true) continue;
        const confidence = (trade.analysis?.confidence || 'Medium').toLowerCase();
        if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') continue;
        for (const p of getTradeProviders(trade)) {
            const creditedWin = creditedWinForAnalyst(trade.analysis, isWin, p);
            const buckets = rebuilt[p] || {
                high: { wins: 0, total: 0 },
                medium: { wins: 0, total: 0 },
                low: { wins: 0, total: 0 },
            };
            buckets[confidence] = {
                wins: buckets[confidence].wins + (creditedWin ? 1 : 0),
                total: buckets[confidence].total + 1,
            };
            rebuilt[p] = buckets;
        }
    }
    const existing = loadConfidenceCalibrationData();
    _confidenceCalibrationCache = {
        providers: { ...existing.providers, ...rebuilt },
        lastUpdated: new Date().toISOString(),
    };
    // An identity rebuild is not persisted. The Preferences write queue is
    // shared with every other boot read, and a write that changes nothing
    // buys nothing but latency — which is exactly what a marginal reader
    // downstream cannot afford.
    if (JSON.stringify(existing.providers) !== JSON.stringify(_confidenceCalibrationCache.providers)) {
        setPreferenceObject(CONFIDENCE_CALIBRATION_STORAGE_KEY, _confidenceCalibrationCache).catch(e =>
            console.warn('[ModelPerformance] Failed to save rebuilt confidence calibration:', e)
        );
    }
};

/**
 * Load confidence calibration data
 */
const loadConfidenceCalibrationData = (): ModelConfidenceCalibrationData => {
    if (_confidenceCalibrationCache) return _confidenceCalibrationCache;

    migrateLegacyCalibrationKey();
    try {
        const stored = localStorage.getItem(CONFIDENCE_CALIBRATION_STORAGE_KEY);
        if (stored) {
            _confidenceCalibrationCache = JSON.parse(stored);
            return _confidenceCalibrationCache!;
        }
    } catch (e) { /* intentionally ignored: cache parse failure */ }

    const empty = { providers: {}, lastUpdated: new Date().toISOString() };
    _confidenceCalibrationCache = empty;
    return empty;
};

/**
 * Brier-score calibration summary across all providers.
 *
 * The Brier score is the mean squared error between declared confidence and
 * outcome: (p - outcome)², where p = declared confidence as a probability
 * (High=0.70, Medium=0.55, Low=0.40 — the same anchors the dashboard uses)
 * and outcome = 1 for WIN, 0 for LOSS. Range 0..1; lower is better; 0.25 is
 * chance for a coin-flip market. This complements win-rate stats by measuring
 * whether a model's CONFIDENCE WORDS mean anything.
 */
export interface ProviderCalibrationSummary {
    provider: string;
    brierScore: number | null;
    samples: number;
    /** declared minus realized win rate at High confidence (positive = overconfident) */
    highGap: number | null;
    verdict: 'calibrated' | 'overconfident' | 'underconfident' | 'insufficient-data';
}

const CONFIDENCE_ANCHOR: Record<'high' | 'medium' | 'low', number> = { high: 0.7, medium: 0.55, low: 0.4 };

export const getCalibrationSummaries = (): ProviderCalibrationSummary[] => {
    const data = loadConfidenceCalibrationData();
    return Object.entries(data.providers).map(([provider, buckets]) => {
        let seSum = 0;
        let samples = 0;
        for (const key of ['high', 'medium', 'low'] as const) {
            const b = buckets[key];
            if (!b || b.total === 0) continue;
            const anchor = CONFIDENCE_ANCHOR[key];
            // Split the bucket: each win contributes (1-p)², each loss p².
            seSum += b.wins * Math.pow(1 - anchor, 2) + (b.total - b.wins) * Math.pow(anchor, 2);
            samples += b.total;
        }
        const highTotal = buckets.high.total;
        const highWinRate = highTotal > 0 ? (buckets.high.wins / highTotal) * 100 : null;
        // Declared anchor MINUS realized, exactly as the field's doc says. The
        // old code compared High against the model's OWN all-bucket average,
        // so the verdict answered a question nobody asked and could land wrong
        // in both directions: executed, a provider hitting the 70% anchor
        // exactly was graded "underconfident", and one winning 30% of its
        // High calls was graded "calibrated" (gap 0) and so never demoted.
        // Positive = overconfident, matching the comment and threshold signs.
        const highGap = highWinRate !== null
            ? Math.round((CONFIDENCE_ANCHOR.high * 100 - highWinRate) * 10) / 10
            : null;
        const brierScore = samples > 0 ? Math.round((seSum / samples) * 10000) / 10000 : null;

        let verdict: ProviderCalibrationSummary['verdict'] = 'insufficient-data';
        if (samples >= 5 && highGap !== null && highTotal >= 3) {
            verdict = highGap > 12 ? 'overconfident' : highGap < -12 ? 'underconfident' : 'calibrated';
        }
        // The old `else if (samples >= 5) verdict = 'calibrated'` awarded
        // "calibrated" to a model with ZERO High samples — a verdict about
        // High-confidence behaviour from data containing no High trades.
        // Absence of that evidence is 'insufficient-data', which is what it
        // says now.

        return { provider, brierScore, samples, highGap, verdict };
    });
};

