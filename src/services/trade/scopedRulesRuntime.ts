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
import { computeCorrelatedPortfolioHeat } from '../paper/preTradeHooksCore';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { evaluateScopedRules, type LiveTapePaperHeat, type ScopedRulesResult } from './scopedRules';
import { classifyUtcSession } from '../learning/executionAutopsyCore';

export type CachedRegimeTf = '15m' | '1h' | '4h';

export interface LiveMarketContextSnapshot {
    symbol: string;
    markPrice: number | null;
    regime: string | null;
    regimesByTf: Partial<Record<CachedRegimeTf, string>>;
    fundingRate: number | null;
    dailyDrawdownPct: number | null;
    killSwitchActive: boolean | null;
    maxDailyDrawdownPct: number | null;
    paperHeat: LiveTapePaperHeat | null;
    session: string;
    nowMs: number;
}

const cachedRegimeBySymbol = new Map<string, { regime: string; atMs: number }>();
const cachedRegimeBySymbolTf = new Map<string, Partial<Record<CachedRegimeTf, { regime: string; atMs: number }>>>();
const REGIME_CACHE_TTL_MS = 5 * 60_000;

const normalizeCachedTf = (raw?: string | null): CachedRegimeTf | null => {
    const tf = (raw ?? '').trim().toLowerCase();
    return tf === '15m' || tf === '1h' || tf === '4h' ? tf : null;
};

/** Record an already-computed regime read for a symbol (and optional TF, zero network). */
export const recordCachedRegime = (
    symbol: string,
    regime: string,
    tfOrAtMs?: string | number,
    atMsArg?: number,
): void => {
    const key = symbol.trim().toUpperCase();
    const cleanRegime = regime.trim();
    if (!key || !cleanRegime) return;
    const tf = typeof tfOrAtMs === 'string' ? normalizeCachedTf(tfOrAtMs) : null;
    const atMs = typeof tfOrAtMs === 'number' ? tfOrAtMs : (atMsArg ?? Date.now());
    cachedRegimeBySymbol.set(key, { regime: cleanRegime, atMs });
    if (tf) {
        const prev = cachedRegimeBySymbolTf.get(key) ?? {};
        cachedRegimeBySymbolTf.set(key, { ...prev, [tf]: { regime: cleanRegime, atMs } });
    }
};

export const getCachedRegime = (symbol: string, nowMs = Date.now()): string | null => {
    const key = symbol.trim().toUpperCase();
    const hit = key ? cachedRegimeBySymbol.get(key) : undefined;
    if (!hit) return null;
    if (nowMs - hit.atMs > REGIME_CACHE_TTL_MS) return null;
    return hit.regime;
};

export const getCachedRegimesByTf = (
    symbol: string,
    nowMs = Date.now(),
): Partial<Record<CachedRegimeTf, string>> => {
    const key = symbol.trim().toUpperCase();
    const bucket = key ? cachedRegimeBySymbolTf.get(key) : undefined;
    if (!bucket) return {};
    const out: Partial<Record<CachedRegimeTf, string>> = {};
    for (const tf of ['15m', '1h', '4h'] as const) {
        const entry = bucket[tf];
        if (entry && nowMs - entry.atMs <= REGIME_CACHE_TTL_MS) {
            out[tf] = entry.regime;
        }
    }
    return out;
};

export const clearCachedRegimesForTests = (): void => {
    cachedRegimeBySymbol.clear();
    cachedRegimeBySymbolTf.clear();
};

export type ScopedRuleCandle = Omit<Kline, 'volume'> & { volume?: number };

export const collectLiveMarketContextForSymbol = (
    symbol: string,
    opts?: { evalCandles?: readonly ScopedRuleCandle[] | null; interval?: string | null; markPrice?: number | null; nowMs?: number },
): LiveMarketContextSnapshot => {
    const nowMs = opts?.nowMs ?? Date.now();
    const cleanSymbol = symbol.trim().toUpperCase();
    const tf = normalizeCachedTf(opts?.interval);

    let regime: string | null = getCachedRegime(cleanSymbol, nowMs);
    if (opts?.evalCandles && opts.evalCandles.length >= 80) {
        const klines: Kline[] = opts.evalCandles.map(c => ({ ...c, volume: c.volume ?? 0 }));
        const read = regimeRead(klines);
        if (read) {
            regime = read.direction;
            recordCachedRegime(cleanSymbol, read.direction, tf ?? undefined, nowMs);
        }
    }
    const regimesByTf = getCachedRegimesByTf(cleanSymbol, nowMs);

    const frame = cleanSymbol ? getPaperLiveFrame(cleanSymbol, 120_000, nowMs) : null;
    const fundingRate = frame?.fundingRate ?? null;
    const markPrice =
        typeof opts?.markPrice === 'number' && Number.isFinite(opts.markPrice) && opts.markPrice > 0
            ? opts.markPrice
            : frame?.mark && Number.isFinite(frame.mark) && frame.mark > 0
                ? frame.mark
                : null;
    const paperView = getCachedPaperAccountView();

    let paperHeat: LiveTapePaperHeat | null = null;
    if (paperView) {
        const capPct = getHarnessSettings().preTradeHooks.maxCorrelatedHeatPct;
        const heat = computeCorrelatedPortfolioHeat({
            positions: paperView.openPositions.map(p => ({
                symbol: p.symbol,
                side: p.side,
                riskUsd: p.riskUsd,
            })),
            equityUsd: paperView.equity > 0 ? paperView.equity : undefined,
        });
        paperHeat = {
            openCount: paperView.openPositions.length,
            netBetaHeatPct: heat.currentNetBetaHeatPct,
            grossBetaHeatPct: heat.currentGrossBetaHeatPct,
            capPct,
        };
    }

    return {
        symbol: cleanSymbol,
        markPrice,
        regime,
        regimesByTf,
        fundingRate,
        dailyDrawdownPct: paperView?.dailyDrawdownPct ?? null,
        killSwitchActive: paperView?.killSwitchActive ?? null,
        maxDailyDrawdownPct: paperView?.riskLimits?.dailyDrawdownKillSwitchPct ?? null,
        paperHeat,
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
