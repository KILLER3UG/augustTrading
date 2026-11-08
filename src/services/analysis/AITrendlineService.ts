/**
 * AI Trendline Service
 * Uses the first ready user-configured provider for fast AI-powered trendline
 * detection on candlestick charts, falling back to the remaining ready
 * providers if the first one fails.
 * Identifies key support/resistance lines, trend channels, and optimal entry zones.
 *
 * Providers are read from user configuration (ProviderConfigService) — no
 * hardcoded provider ids or SDKs.
 */

import { ChartCandle, ChartLinePoint } from '../../types/chart';
import { loadProviderConfigs, getReadyProviders } from '../infrastructure/ProviderConfigService';
import { sendChatRequest } from '../providers/GenericProviderService';
import { extractAndParseJson } from '../../utils/jsonUtils';

export interface TrendlineResult {
    type: 'resistance' | 'support' | 'trendline';
    startTime: number;
    startPrice: number;
    endTime: number;
    endPrice: number;
    color: string;
    importance: 'high' | 'medium' | 'low';
    label?: string;
}

export interface MarketInsights {
    situation: string;       // What's happening right now
    observations: string[];  // Key technical signals observed
    potentialMoves: {
        bullish: string;     // What happens if bulls take control
        bearish: string;     // What happens if bears take control
    };
    riskFactors: string[];   // Things to watch out for
}

export interface AITrendlineAnalysis {
    trendlines: TrendlineResult[];
    marketBias: 'bullish' | 'bearish' | 'neutral';
    keyLevels: { price: number; type: 'support' | 'resistance' }[];
    summary: string;
    insights: MarketInsights; // Detailed market commentary
}

const EMPTY_RESULT: AITrendlineAnalysis = {
    trendlines: [],
    marketBias: 'neutral',
    keyLevels: [],
    summary: 'AI analysis unavailable',
    insights: {
        situation: 'Unable to analyze market. Please check your connection.',
        observations: [],
        potentialMoves: {
            bullish: 'Analysis unavailable',
            bearish: 'Analysis unavailable',
        },
        riskFactors: ['AI analysis failed - use caution'],
    },
};

/**
 * Analyze candlestick data using AI to identify important trendlines.
 * Tries each ready provider in order until one returns parseable JSON.
 */
export const analyzeWithAI = async (
    candles: ChartCandle[],
    symbol: string,
    interval: string,
    modelName?: string
): Promise<AITrendlineAnalysis> => {
    const configs = await loadProviderConfigs();
    const ready = getReadyProviders(configs);
    if (ready.length === 0) {
        console.warn('[AITrendlineService] No ready providers configured for trendline analysis');
        return EMPTY_RESULT;
    }

    // Prepare summarized candle data (last 100 candles for efficiency)
    const recentCandles = candles.slice(-100);
    if (recentCandles.length === 0) {
        console.warn(`[AITrendlineService] No candle data available for ${symbol} ${interval}`);
        return EMPTY_RESULT;
    }
    const candleData = recentCandles.map((c, i) => ({
        i,
        t: c.time,
        o: Number(c.open).toFixed(2),
        h: Number(c.high).toFixed(2),
        l: Number(c.low).toFixed(2),
        c: Number(c.close).toFixed(2),
    }));

    // Calculate basic metrics
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);
    const overallHigh = Math.max(...highs);
    const overallLow = Math.min(...lows);
    const currentPrice = recentCandles[recentCandles.length - 1].close;

    // Calculate additional metrics for AI context
    const priceChange = ((currentPrice - recentCandles[0].close) / recentCandles[0].close * 100).toFixed(2);
    const avgVolatility = recentCandles.slice(-20).reduce((sum, c) => sum + (c.high - c.low), 0) / 20;

    // Renumber the prompt slice 0..29 so the model's startIndex/endIndex
    // refer to the data it actually sees. The old code sent candles carrying
    // their 0..99 indices; a model that renumbered them 0..29 anchored every
    // trendline ~70 candles too early.
    const promptCandles = candleData.slice(-30).map((c, i) => ({ ...c, i }));

    const prompt = `You are an expert technical analyst providing real-time market commentary. Analyze this ${symbol} ${interval} chart data.

PRICE DATA (last 30 candles, format: index 0-29 within this slice, time, open, high, low, close):
${JSON.stringify(promptCandles, null, 0)}

MARKET CONTEXT:
- Range: ${overallLow.toFixed(2)} to ${overallHigh.toFixed(2)}
- Current Price: ${currentPrice.toFixed(2)}
- Price Change (period): ${priceChange}%
- Avg Candle Range: ${avgVolatility.toFixed(2)}
- Total candles analyzed: ${recentCandles.length}

Provide a comprehensive analysis including:
1. Key trendlines (support, resistance, trend channels)
2. Current market situation - what's happening RIGHT NOW
3. Key observations - important technical signals you see
4. Potential moves - what could happen next (bullish and bearish scenarios)
5. Risk factors - things traders should watch out for

RESPOND IN THIS EXACT JSON FORMAT:
{
  "trendlines": [
    {
      "type": "resistance|support|trendline",
      "startIndex": <number>,
      "endIndex": <number>,
      "importance": "high|medium|low",
      "label": "<brief description>"
    }
  ],
  "marketBias": "bullish|bearish|neutral",
  "keyLevels": [
    { "price": <number>, "type": "support|resistance" }
  ],
  "summary": "<1-2 sentence market summary>",
  "insights": {
    "situation": "<2-3 sentences describing current market state - is it trending, ranging, consolidating? Near key levels?>",
    "observations": [
      "<key technical observation 1>",
      "<key technical observation 2>",
      "<key technical observation 3>"
    ],
    "potentialMoves": {
      "bullish": "<what happens if price breaks up - target levels>",
      "bearish": "<what happens if price breaks down - target levels>"
    },
    "riskFactors": [
      "<risk or warning 1>",
      "<risk or warning 2>"
    ]
  }
}`;

    // Parse a raw response into the analysis shape (shared by all providers).
    // The canonical boundary parser handles fenced blocks, bare JSON, and
    // leading prose — the hand-rolled fence-only regex used to fail on any
    // response that wrapped its JSON in extra text.
    const parseResponse = (responseText: string, providerName: string): AITrendlineAnalysis => {
        let parsed: any;
        try {
            parsed = extractAndParseJson(responseText);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Unknown JSON parsing error';
            throw new Error(`[AITrendlineService] ${providerName} returned invalid JSON: ${message}`, { cause: e });
        }

        // Convert index-based trendlines to time/price based. Indices are
        // 0-based within the 30-candle prompt slice — map back into the full
        // recentCandles array (the slice may be shorter when history is thin).
        const trendlines: TrendlineResult[] = (parsed.trendlines || []).map((tl: any) => {
            const base = Math.max(0, recentCandles.length - 30);
            const startIdx = Math.min(recentCandles.length - 1, base + Math.max(0, tl.startIndex || 0));
            const endIdx = Math.min(recentCandles.length - 1, base + Math.max(0, tl.endIndex ?? tl.startIndex ?? 0));
            const startCandle = recentCandles[startIdx] || recentCandles[0];
            const endCandle = recentCandles[endIdx] || recentCandles[recentCandles.length - 1];

            const isResistance = tl.type === 'resistance';
            const startPrice = isResistance ? startCandle.high : startCandle.low;
            const endPrice = isResistance ? endCandle.high : endCandle.low;

            return {
                type: tl.type,
                startTime: startCandle.time as number,
                startPrice,
                endTime: endCandle.time as number,
                endPrice,
                color: tl.type === 'resistance' ? '#fb7185' : tl.type === 'support' ? '#34d399' : '#9d998f',
                importance: tl.importance || 'medium',
                label: tl.label,
            };
        });

        // Build insights with fallbacks for missing data
        const insights: MarketInsights = {
            situation: parsed.insights?.situation || 'Market analysis in progress.',
            observations: parsed.insights?.observations || ['Analyzing market conditions...'],
            potentialMoves: {
                bullish: parsed.insights?.potentialMoves?.bullish || 'Awaiting breakout confirmation.',
                bearish: parsed.insights?.potentialMoves?.bearish || 'Awaiting breakdown confirmation.',
            },
            riskFactors: parsed.insights?.riskFactors || ['Monitor for sudden volatility'],
        };

        console.log(`[AITrendlineService] Analysis complete via ${providerName}:`, parsed.summary);

        return {
            trendlines,
            marketBias: parsed.marketBias || 'neutral',
            keyLevels: parsed.keyLevels || [],
            summary: parsed.summary || 'Analysis complete',
            insights,
        };
    };

    // Try each ready provider in order until one succeeds
    for (const config of ready) {
        try {
            const responseText = await sendChatRequest(
                { ...config, selectedModel: modelName || config.selectedModel },
                [
                    { role: 'system', content: 'You are a technical analyst. Respond ONLY with valid JSON, no markdown or explanation.' },
                    { role: 'user', content: prompt },
                ],
                { maxTokens: 1000, temperature: 0.3 }
            );
            return parseResponse(responseText, config.name);
        } catch (error: any) {
            console.warn(`[AITrendlineService] Provider ${config.name} failed:`, error.message);
        }
    }

    console.error('[AITrendlineService] All ready providers failed for trendline analysis');
    return EMPTY_RESULT;
};

/**
 * Convert AI trendline results to lightweight-charts LineData format
 */
export const convertToLineData = (
    trendline: TrendlineResult
): ChartLinePoint[] => {
    return [
        { time: trendline.startTime, value: trendline.startPrice },
        { time: trendline.endTime, value: trendline.endPrice },
    ];
};
