import { useState, useEffect } from 'react';
import { HybridDataPacket } from '../services/analysis/HybridIntelligenceService';
import { MonteCarloResult, LabeledMonteCarloResult } from '../services/analysis/MonteCarloService';
import { LiveBacktestResult } from '../services/backtesting/LiveBacktestService';
import { SLOptimization } from '../services/backtesting/StopLossOptimizerService';
import { fetchRecentLiquidations, fetchOHLCV, pingBinanceAPI } from '../services/analysis/MarketDataService';
import { DEFAULT_SYMBOL } from '../config/exchangeEndpoints';

/**
 * The instrument the live-market sampler reads (defaults to `DEFAULT_SYMBOL`).
 */
export function useMarketData(
    isHybridIntelligenceEnabled: boolean,
    symbol: string = DEFAULT_SYMBOL,
    chartInterval: string = '1h',
) {
    const [currentHybridData, setCurrentHybridData] = useState<HybridDataPacket | null>(null);
    const [hybridConnectionStatus, setHybridConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
    const [latestMonteCarloResult, setLatestMonteCarloResult] = useState<MonteCarloResult | null>(null);
    const [latestBacktestResult, setLatestBacktestResult] = useState<LiveBacktestResult | null>(null);
    const [perAIMonteCarloResults, setPerAIMonteCarloResults] = useState<LabeledMonteCarloResult[]>([]);
    const [currentSlOptimization, setCurrentSlOptimization] = useState<SLOptimization | null>(null);
    const [currentSuggestedEntryPrice, setCurrentSuggestedEntryPrice] = useState<number | null>(null);
    const [currentEntryTimingScore, setCurrentEntryTimingScore] = useState<{
        score: number;
        timingQuality: string;
        suggestedEntry?: { price: number; reason: string } | null;
    } | null>(null);

    // Live Market Conditions (fetched periodically for Global Sessions display)
    const [liveMarketConditions, setLiveMarketConditions] = useState<{
        volatility: 'High' | 'Medium' | 'Low';
        liquidation: 'High' | 'Medium' | 'Low';
        lastUpdated: string;
    } | null>(null);

    // Fetch live market conditions periodically for Global Sessions display.
    // The Hybrid Intelligence toggle alone decides whether the app talks to the
    // exchange on a timer — the ensemble mode this used to also require no
    // longer exists, and nothing about a chat answer depends on it.
    useEffect(() => {
        if (!isHybridIntelligenceEnabled) {
            setLiveMarketConditions(null);
            return;
        }
        const fetchLiveMarketConditions = async () => {
            try {
                // Fetch liquidation data
                const liquidationData = await fetchRecentLiquidations(symbol);

                // Fetch recent candles to calculate volatility (ATR approximation)
                const candles = await fetchOHLCV(symbol, chartInterval, 20);

                // Calculate average true range for volatility
                let volatility: 'High' | 'Medium' | 'Low' = 'Medium';
                if (candles && candles.length >= 14) {
                    const recentCandles = candles.slice(-14);
                    const avgRange = recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length;
                    const avgPrice = recentCandles.reduce((sum, c) => sum + c.close, 0) / recentCandles.length;
                    const volatilityPercent = (avgRange / avgPrice) * 100;

                    // Classify volatility based on percentage range
                    if (volatilityPercent > 2) volatility = 'High';
                    else if (volatilityPercent > 0.8) volatility = 'Medium';
                    else volatility = 'Low';
                }

                // Map liquidation pressure
                const liquidation = liquidationData.liquidationPressure === 'high' ? 'High' :
                    liquidationData.liquidationPressure === 'medium' ? 'Medium' : 'Low';

                setLiveMarketConditions({
                    volatility,
                    liquidation,
                    lastUpdated: new Date().toISOString()
                });
            } catch (error) {
                console.error('[LiveMarketConditions] Failed to fetch:', error);
            }
        };

        // Fetch immediately on mount
        fetchLiveMarketConditions();

        // Then refresh every 60 seconds
        let interval: ReturnType<typeof setInterval> | null = null;
        const startInterval = () => {
            if (interval !== null) return; // already running
            interval = setInterval(fetchLiveMarketConditions, 60000);
        };
        const stopInterval = () => {
            if (interval !== null) {
                clearInterval(interval);
                interval = null;
            }
        };

        // Pause polling when the tab is hidden to save battery/data on
        // mobile and avoid wasted network requests. Mirrors the pattern used
        // in Header.tsx for its session-refresh interval.
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                fetchLiveMarketConditions(); // Refresh immediately on return
                startInterval();
            } else {
                stopInterval();
            }
        };

        startInterval();
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            stopInterval();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [isHybridIntelligenceEnabled, symbol, chartInterval]);

    // Check Binance API connection when Hybrid Intelligence is enabled
    useEffect(() => {
        let intervalId: NodeJS.Timeout | null = null;
        let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        let retryCount = 0;

        const isEnabled = (): boolean => !disposed && isHybridIntelligenceEnabled;

        const checkConnection = async () => {
            if (isEnabled()) {
                // Only show "connecting" if we are currently disconnected or in error state
                // This prevents flickering "connecting..." when we are already connected
                setHybridConnectionStatus(prev => (prev === 'connected' ? 'connected' : 'connecting'));

                try {
                    const isConnected = await pingBinanceAPI();

                    if (!isEnabled()) return;
                    if (isConnected) {
                        setHybridConnectionStatus('connected');
                        retryCount = 0; // Reset retries on success
                    } else {
                        // Soft failure handling: Don't show error immediately, retry once
                        if (retryCount < 1) {
                            retryCount++;
                            console.log('[Hybrid Intelligence] Connection check failed, retrying silently...');
                            retryTimeoutId = setTimeout(checkConnection, 1000); // Quick retry
                        } else {
                            setHybridConnectionStatus('error');
                        }
                    }
                } catch {
                    if (!isEnabled()) return;
                    setHybridConnectionStatus('error');
                }
            } else {
                setHybridConnectionStatus('disconnected');
            }
        };

        if (isHybridIntelligenceEnabled) {
            checkConnection();
            // Re-check connection every 60 seconds (less aggressive than 30s)
            intervalId = setInterval(checkConnection, 60000);

            // Pause the connection check when the tab is hidden.
            const handleVisibilityChange = () => {
                if (document.visibilityState === 'visible') {
                    checkConnection(); // Re-check immediately on return
                    if (!intervalId) {
                        intervalId = setInterval(checkConnection, 60000);
                    }
                } else {
                    if (intervalId) {
                        clearInterval(intervalId);
                        intervalId = null;
                    }
                }
            };
            document.addEventListener('visibilitychange', handleVisibilityChange);

            return () => {
                disposed = true;
                if (intervalId) clearInterval(intervalId);
                if (retryTimeoutId) clearTimeout(retryTimeoutId);
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            };
        } else {
            disposed = true;
            setHybridConnectionStatus('disconnected');
        }
    }, [isHybridIntelligenceEnabled]);

    return {
        currentHybridData,
        setCurrentHybridData,
        hybridConnectionStatus,
        setHybridConnectionStatus,
        latestMonteCarloResult,
        setLatestMonteCarloResult,
        latestBacktestResult,
        setLatestBacktestResult,
        perAIMonteCarloResults,
        setPerAIMonteCarloResults,
        currentSlOptimization,
        setCurrentSlOptimization,
        currentSuggestedEntryPrice,
        setCurrentSuggestedEntryPrice,
        currentEntryTimingScore,
        setCurrentEntryTimingScore,
        liveMarketConditions,
        setLiveMarketConditions,
        /** Which instrument `liveMarketConditions` describes. Read it in the
         *  label; never re-state the symbol in the UI. */
        liveMarketSymbol: symbol,
    };
}
