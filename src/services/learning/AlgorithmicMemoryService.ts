// AlgorithmicMemoryService.ts
// Replaces AI-based Global Memory Manager with deterministic algorithmic updates
// Saves significant tokens by processing statistics and patterns locally

import { GlobalMemory, LoggedTrade, TradeOutcome } from '../../types';
// The frozen `GlobalMemory.insightKnowledgeBase` field is deleted: its last
// reader (the memory-index INSIGHTS block) is gone with it and its entries
// migrated into the notebook's distilled/ folder
// (distilledMemory.migrateFrozenTradeInsights). This function no longer
// creates it on profiles that have none — and no profile keeps one after the
// boot migration clears it.

/**
 * Updates Global Memory algorithmically without AI.
 * 
 * @param recentTrades - New trades to merge into memory
 * @param currentMemory - Existing global memory (Layer 3)
 * @returns Updated GlobalMemory object
 */
export const updateGlobalMemoryAlgorithmically = (
    recentTrades: LoggedTrade[],
    currentMemory?: GlobalMemory
): GlobalMemory => {

    // 1. Initialize or Clone Memory
    const memory: GlobalMemory = currentMemory ? { ...currentMemory } : {
        totalTradesAnalyzed: 0,
        familyPerformance: {},
        userPreferences: {
            leverageDefault: 0,
            favoriteAssets: [],
            preferredSetup: ''
        },
        globalCorrections: [],
        lastUpdated: new Date().toISOString()
    };

    // 2. Update Total Trades
    memory.totalTradesAnalyzed += recentTrades.length;
    memory.lastUpdated = new Date().toISOString();

    // 3. Update Family Performance
    // We need to re-scan all history if possible, but here we just merge new data
    // Format: "Family A: 75% WR (12/16)"

    // To do this strictly incrementally is hard without raw counters.
    // For now, we will track performance of the RECENT batch and append/overwrite.
    // A more robust system would store raw W/L counts in memory.
    // Given the constraints, we will calculate stats for the recent batch and update the text.
    // Ideally, specific family stats should be tracked in a structured way (like GranularCalibration).
    // For this implementation, we will perform a "Rolling Assessment" of the recent batch.

    const familyStats: Record<string, { wins: number; total: number }> = {};
    const assetCounts: Record<string, number> = {};
    let leverageSum: number = 0;
    let leverageCount: number = 0;

    for (const trade of recentTrades) {
        // Family Stats
        const family = trade.analysis.detectedPatternFamily ||
            trade.analysis.marketConditions?.pattern || 'Unknown';

        if (!familyStats[family]) familyStats[family] = { wins: 0, total: 0 };
        familyStats[family].total++;
        if (trade.outcome === TradeOutcome.WIN) familyStats[family].wins++;

        // Asset Counts (for preferences)
        const asset = trade.analysis.coinName || 'Unknown';
        assetCounts[asset] = (assetCounts[asset] || 0) + 1;

        // Leverage
        if (trade.leverage) {
            leverageSum += trade.leverage;
            leverageCount++;
        }
    }

    // Merge Family Stats: parse existing "75% WR (12/16)" strings, combine
    // with the new batch counts, and write back cumulative stats.
    for (const [family, batch] of Object.entries(familyStats)) {
        const existing = memory.familyPerformance[family];
        let prevWins = 0;
        let prevTotal = 0;
        if (existing) {
            // Parse "75% WR (12/16 recent)" or "75% WR (12/16)"
            const match = existing.match(/\((\d+)\/(\d+)/);
            if (match) {
                prevWins = parseInt(match[1], 10);
                prevTotal = parseInt(match[2], 10);
            }
        }
        const totalWins = prevWins + batch.wins;
        const totalCount = prevTotal + batch.total;
        const wr = totalCount > 0 ? ((totalWins / totalCount) * 100).toFixed(0) : '0';
        memory.familyPerformance[family] = `${wr}% WR (${totalWins}/${totalCount})`;
    }

    // 4. Recurring-mistake detection and the structured insights derived from
    // it are GONE: every detector was a keyword scan of `trade.postMortem`, and
    // the post-mortem feature that wrote that field has been deleted. With no
    // writer, the detectors could only ever report nothing, so the block and the
    // insight consolidation it drove were removed rather than left to run empty.

    // 5. Update User Preferences

    // Update Favorite Assets (Top 3 by frequency in this batch + existing)
    const sortedAssets = Object.entries(assetCounts)
        .sort((a, b) => b[1] - a[1])
        .map(entry => entry[0]);

    const mergedAssets = Array.from(new Set([...sortedAssets, ...memory.userPreferences.favoriteAssets])).slice(0, 5);
    memory.userPreferences.favoriteAssets = mergedAssets;

    // Update Average Leverage (Moving Average-ish)
    if (leverageCount > 0) {
        const recentAvg = leverageSum / leverageCount;
        const oldAvg = memory.userPreferences.leverageDefault || recentAvg;
        // Weight new data 20%
        memory.userPreferences.leverageDefault = Math.round((oldAvg * 0.8) + (recentAvg * 0.2));
    }

    // 6. Global corrections used to be mined from each trade's post-mortem
    // text. That field has no writer any more, so the store keeps whatever a
    // profile already has and never grows here.
    return memory;
};

