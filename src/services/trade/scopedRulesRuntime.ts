/**
 * scopedRulesRuntime — zero-network runtime collector for `scopedRules.ts`.
 *
 * Reads ONLY already-cached / in-memory state (`futuresStreams`,
 * `PaperBrokerService` cached view, and cached regime reads). Never fires
 * HTTP or WebSocket requests.
 */

import type { Kline } from '../../types/message';
import { getPaperLiveFrame } from './futuresStreams';
import { regimeRead } from '../market/regimeCore';
import { getCachedPaperAccountView } from '../paper/PaperBrokerService';
import { evaluateScopedRules, type ScopedRulesResult } from './scopedRules';
import { classifyUtcSession } from '../learning/executionAutopsyCore';

export interface LiveMarketContextSnapshot {
    symbol: string;
    regime: string | null;
    fundingRate: number | null;
    dailyDrawdownPct: number | null;
    killSwitchActive: boolean | null;
    maxDailyDrawdownPct: number | null;
    session: string;
    nowMs: number;
}

const cachedRegimeBySymbol = new Map<string, { regime: string; atMs: number }>();
const REGIME_CACHE_TTL_MS = 5 * 60_000;

/** Record an already-computed regime read for a symbol (zero network). */
export const recordCachedRegime = (symbol: string, regime: string, atMs = Date.now()): void => {
    const key = symbol.trim().toUpperCase();
    if (!key || !regime.trim()) return;
    cachedRegimeBySymbol.set(key, { regime: regime.trim(), atMs });
};

export const getCachedRegime = (symbol: string, nowMs = Date.now()): string | null => {
    const key = symbol.trim().toUpperCase();
    const hit = key ? cachedRegimeBySymbol.get(key) : undefined;
    if (!hit) return null;
    if (nowMs - hit.atMs > REGIME_CACHE_TTL_MS) return null;
    return hit.regime;
};

export type ScopedRuleCandle = Omit<Kline, 'volume'> & { volume?: number };

export const collectLiveMarketContextForSymbol = (
    symbol: string,
    opts?: { evalCandles?: readonly ScopedRuleCandle[] | null; nowMs?: number },
): LiveMarketContextSnapshot => {
    const nowMs = opts?.nowMs ?? Date.now();
    const cleanSymbol = symbol.trim().toUpperCase();

    let regime: string | null = getCachedRegime(cleanSymbol, nowMs);
    if (!regime && opts?.evalCandles && opts.evalCandles.length >= 80) {
        const klines: Kline[] = opts.evalCandles.map(c => ({ ...c, volume: c.volume ?? 0 }));
        const read = regimeRead(klines);
        if (read) {
            regime = read.direction;
            recordCachedRegime(cleanSymbol, read.direction, nowMs);
        }
    }

    const frame = cleanSymbol ? getPaperLiveFrame(cleanSymbol, 120_000, nowMs) : null;
    const fundingRate = frame?.fundingRate ?? null;
    const paperView = getCachedPaperAccountView();

    return {
        symbol: cleanSymbol,
        regime,
        fundingRate,
        dailyDrawdownPct: paperView?.dailyDrawdownPct ?? null,
        killSwitchActive: paperView?.killSwitchActive ?? null,
        maxDailyDrawdownPct: paperView?.riskLimits?.dailyDrawdownKillSwitchPct ?? null,
        session: classifyUtcSession(nowMs),
        nowMs,
    };
};

export const collectScopedRulesForSymbol = (
    symbol: string,
    opts?: { evalCandles?: readonly ScopedRuleCandle[] | null; nowMs?: number },
): ScopedRulesResult => {
    const snap = collectLiveMarketContextForSymbol(symbol, opts);
    return evaluateScopedRules({
        regime: snap.regime,
        fundingRate: snap.fundingRate,
        dailyDrawdownPct: snap.dailyDrawdownPct,
        killSwitchActive: snap.killSwitchActive,
        maxDailyDrawdownPct: snap.maxDailyDrawdownPct,
    });
};
