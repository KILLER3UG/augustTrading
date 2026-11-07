/**
 * SetupMemoryService — journal-driven accuracy injections.
 *
 * Two pure builders that turn the logged-trade journal into evidence the
 * ensemble sees BEFORE answering:
 *
 * 1. `buildSimilarSetupsContext` — for the CURRENT setup, the journal's own
 *    similar setups (same coin/direction/pattern/regime, ≥2 matched
 *    dimensions via the existing similarity scorer): win rate, avg win/loss,
 *    expected value, the 3 most recent outcomes. The journal literally
 *    becomes the model's edge — every logged trade makes the next analysis
 *    smarter. Zero AI cost.
 *
 * 2. `buildRegimeWeightingContext` — each model's win rate in the CURRENT
 *    market regime (plus overall), so the answering model can see who
 *    actually wins in this kind of market (ranging vs trending vs volatile).
 */

import { LoggedTrade, TradeAnalysis, TradeOutcome } from '../../types';
import { backtestSimilarSetups } from '../backtesting/LiveBacktestService';

/** Same normalization the backtest service uses — regime labels written to
 *  trades are already normalized ('trending' | 'ranging' | 'volatile' |
 *  'compression'), while live hybrid regimes are raw ADX labels.
 *  NOTE: 'ranging'.includes('range') is FALSE ('range' ≠ prefix of
 *  'ranging') — the literal normalized forms need their own stems ('rang',
 *  'volat'), or normalized labels fall through to 'unknown' and regime
 *  matching silently never fires. */
const normalizeRegime = (regime?: string): string => {
    const r = (regime || '').toLowerCase();
    if (r.includes('trend')) return 'trending';
    if (r.includes('rang') || r.includes('consolidat')) return 'ranging';
    if (r.includes('volat') || r.includes('chop')) return 'volatile';
    if (r.includes('compression')) return 'compression';
    return 'unknown';
};

export interface SimilarSetupSummary {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    expectedValue: number;
    /** Newest-first, capped at 3. `pnl` is null when the trade has no
     *  measurable magnitude — render as "magnitude unmeasured", never as a
     *  fabricated 0%. */
    recent: { date: string; coin: string; direction: string; outcome: 'WIN' | 'LOSS'; pnl: number | null }[];
    sameCoinCount: number;
    sameCoinWinRate: number | null;
    /**
     * Cold start: fewer than COLD_START_MIN matches — the journal's evidence
     * is too thin to lean on. The prompt block scales confidence down and the
     * dashboard shows a caution chip.
     */
    isColdStart: boolean;
}

/** Below this many similar setups the evidence is flagged as cold start. */
export const COLD_START_MIN = 5;

/** The minimal setup description known BEFORE the analysts answer (coin from
 *  the prompt, direction from intent, pattern family from the prompt mine). */
export type PendingSetup = {
    coinName?: string;
    direction?: string;
    detectedPatternFamily?: string;
    tradeType?: 'scalp' | 'swing';
};

/**
 * Summarize the journal's similar setups for a pending setup. Returns null
 * when there is no meaningful history (fewer than 3 closed trades, no coin,
 * or no similar matches) — callers then skip the block entirely.
 */
export const summarizeSimilarSetups = (
    setup: PendingSetup,
    trades: LoggedTrade[],
    currentRegime?: string,
    /** Point-in-time cutoff (epoch ms): the track record is drawn only from
     *  trades logged by it. Omitted ⇒ live (unchanged). */
    asOfMs?: number
): SimilarSetupSummary | null => {
    const knownBy = (t: LoggedTrade): boolean =>
        asOfMs === undefined || Date.parse(t.timestamp) <= asOfMs;
    const closed = trades.filter(t => (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS) && knownBy(t));
    if (closed.length < 3 || !setup.coinName) return null;
    try {
        const result = backtestSimilarSetups(setup as TradeAnalysis, trades, currentRegime as any, { asOfMs });
        if (result.totalMatches === 0) return null;

        const recent = [...result.matchedTrades]
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 3)
            .map(m => ({
                date: new Date(m.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                coin: m.coin,
                direction: m.direction,
                outcome: m.outcome as 'WIN' | 'LOSS',
                pnl: m.pnlPercent,
            }));

        const coinUp = setup.coinName.toUpperCase();
        const coinClosed = closed.filter(t => (t.analysis?.coinName ?? '').toUpperCase() === coinUp);
        const coinWins = coinClosed.filter(t => t.outcome === TradeOutcome.WIN).length;

        return {
            total: result.totalMatches,
            wins: Math.round((result.winRate / 100) * result.totalMatches),
            losses: result.totalMatches - Math.round((result.winRate / 100) * result.totalMatches),
            winRate: result.winRate,
            avgWin: result.avgWinPercent,
            avgLoss: result.avgLossPercent,
            expectedValue: result.expectedValue,
            recent,
            sameCoinCount: coinClosed.length,
            sameCoinWinRate: coinClosed.length > 0 ? (coinWins / coinClosed.length) * 100 : null,
            isColdStart: result.totalMatches < COLD_START_MIN,
        };
    } catch (e) {
        console.warn('[SetupMemory] Similar-setup summary failed:', e);
        return null;
    }
};

/**
 * The prompt block: "your own logged track record" for this exact kind of
 * setup. Empty string when the journal has nothing comparable.
 */
export const buildSimilarSetupsContext = (
    setup: PendingSetup,
    trades: LoggedTrade[],
    currentRegime?: string,
    /** Point-in-time cutoff (epoch ms) — see summarizeSimilarSetups. */
    asOfMs?: number
): string => {
    const s = summarizeSimilarSetups(setup, trades, currentRegime, asOfMs);
    if (!s) return '';

    const lines: string[] = [
        ` **SIMILAR SETUPS FROM YOUR JOURNAL (your own logged track record for ${setup.coinName}):**`,
        `- ${s.total} similar setups · ${s.winRate.toFixed(0)}% win (${s.wins}W/${s.losses}L) · avg win +${s.avgWin.toFixed(1)}% · avg loss −${s.avgLoss.toFixed(1)}% · expected value ${s.expectedValue >= 0 ? '+' : ''}${s.expectedValue.toFixed(1)}% per trade`,
    ];
    if (s.recent.length > 0) {
        // Unmeasured PnL prints as "magnitude unmeasured" — the journal's
        // source keeps nulls now (no `?? 0` placeholder), so a WIN/LOSS with
        // no recorded magnitude must never read to the model as "(0.0%)".
        lines.push(`- Recent: ${s.recent.map(r =>
            `${r.date} ${r.coin} ${r.direction} ${r.outcome} (${r.pnl === null
                ? 'magnitude unmeasured'
                : `${r.pnl > 0 ? '+' : ''}${r.pnl.toFixed(1)}%`})`
        ).join(' · ')}`);
    }
    if (s.sameCoinCount > 1 && s.sameCoinWinRate !== null) {
        lines.push(`- ${setup.coinName} overall: ${s.sameCoinCount} closed trades · ${s.sameCoinWinRate.toFixed(0)}% win`);
    }
    if (s.isColdStart) {
        lines.push(
            '',
            `⚠️ **COLD START:** only ${s.total} similar setup${s.total === 1 ? '' : 's'} logged — the history is too thin to lean on.`,
            `Do NOT raise confidence above Medium based on this history alone; treat these stats as weak corroboration, not validation.`
        );
    } else {
        lines.push(
            '',
            'These are REAL outcomes the user logged — the strongest evidence available. Use them to validate direction and confidence.',
            'They are context, not a veto: the current setup\'s own evidence always wins.'
        );
    }
    return lines.join('\n');
};

/** Provider-level regime win rates — the shape the composer dropdown, team
 *  strip, and lens auto-assign consume. */
export type RegimeProviderStatsMap = Map<string, { wr: number; n: number }>;

/**
 * Provider-level win rate in the CURRENT regime, aggregated across the
 * provider's models — the number the composer dropdown, the team strip, and
 * the lens auto-assign should show (a blended all-time number defeats the
 * regime mechanism). Only providers with ≥ minTrades in the regime are
 * included; empty map = fall back to overall calibration.
 */
export const computeRegimeProviderStats = (
    trades: LoggedTrade[],
    currentRegime?: string,
    minTrades = 3
): RegimeProviderStatsMap => {
    const current = normalizeRegime(currentRegime);
    const out = new Map<string, { w: number; l: number }>();
    for (const t of trades) {
        if (t.outcome !== TradeOutcome.WIN && t.outcome !== TradeOutcome.LOSS) continue;
        const used = t.modelsUsed ?? {};
        const pid = Object.keys(used)[0];
        if (!pid) continue;
        if ((t.marketRegime ?? 'unknown') !== current) continue;
        const c = out.get(pid) ?? { w: 0, l: 0 };
        if (t.outcome === TradeOutcome.WIN) c.w += 1;
        else c.l += 1;
        out.set(pid, c);
    }
    const result = new Map<string, { wr: number; n: number }>();
    for (const [pid, c] of out) {
        const n = c.w + c.l;
        if (n >= minTrades) result.set(pid, { wr: (c.w / n) * 100, n });
    }
    return result;
};

export interface RegimeModelStats {
    /** Analyst identity key (provider::model when recorded). */
    key: string;
    /** Normalized current regime at query time. */
    regime: string;
    /** Trades in the current regime; 0 when the model never saw it. */
    regimeTrades: number;
    regimeWins: number;
    /** NaN when regimeTrades === 0. */
    regimeWinRate: number;
    total: number;
    totalWinRate: number;
}

/**
 * Structured per-model win-rate stats split by regime, prioritized for the
 * CURRENT regime — the shared source for the regime-weighting prompt the
 * answering model reads, the team strip/dropdown win rates, and the
 * learning-tab leaderboard. Only models with ≥ minTrades overall are
 * included. Empty when the journal is too thin.
 */
export const computeRegimeModelStats = (
    trades: LoggedTrade[],
    currentRegime?: string,
    minTrades = 3
): RegimeModelStats[] => {
    const closed = trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS);
    if (closed.length < minTrades) return [];

    const current = normalizeRegime(currentRegime);
    const perKey = new Map<string, { regime: Map<string, { w: number; l: number }>; total: number; wins: number }>();
    for (const t of closed) {
        const used = t.modelsUsed ?? {};
        const entries = Object.entries(used);
        const key = entries.length > 0 ? `${entries[0][0]}::${entries[0][1]}` : 'unknown';
        const regime = t.marketRegime ?? 'unknown';
        const c = perKey.get(key) ?? { regime: new Map<string, { w: number; l: number }>(), total: 0, wins: 0 };
        c.total += 1;
        if (t.outcome === TradeOutcome.WIN) {
            c.wins += 1;
            c.regime.set(regime, { w: (c.regime.get(regime)?.w ?? 0) + 1, l: c.regime.get(regime)?.l ?? 0 });
        } else {
            c.regime.set(regime, { w: c.regime.get(regime)?.w ?? 0, l: (c.regime.get(regime)?.l ?? 0) + 1 });
        }
        perKey.set(key, c);
    }

    const rows: RegimeModelStats[] = [];
    for (const [key, c] of perKey) {
        if (c.total < minTrades) continue;
        const rg = c.regime.get(current);
        rows.push({
            key,
            regime: current,
            regimeTrades: rg ? rg.w + rg.l : 0,
            regimeWins: rg?.w ?? 0,
            regimeWinRate: rg ? (rg.w / (rg.w + rg.l)) * 100 : NaN,
            total: c.total,
            totalWinRate: (c.wins / c.total) * 100,
        });
    }

    // Models with ≥3 trades in the current regime first, then any regime
    // experience, then by total trades — relevance-first ordering.
    rows.sort((a, b) => {
        const ar = a.regimeTrades >= minTrades ? 2 : a.regimeTrades > 0 ? 1 : 0;
        const br = b.regimeTrades >= minTrades ? 2 : b.regimeTrades > 0 ? 1 : 0;
        return br - ar || b.total - a.total;
    });
    return rows;
};

/**
 * Per-model win rate split by regime, prioritized for the CURRENT regime —
 * the regime-weighting prompt the answering model reads. Empty string when
 * the journal is too thin.
 */
export const buildRegimeWeightingContext = (
    trades: LoggedTrade[],
    currentRegime?: string,
    resolveName: (key: string) => string = key => key,
    minTrades = 3
): string => {
    const rows = computeRegimeModelStats(trades, currentRegime, minTrades);
    if (rows.length === 0) return '';

    const current = normalizeRegime(currentRegime);
    const lines: string[] = [
        ` **MODEL TRACK RECORD BY REGIME (current regime: ${current}):**`,
        ...rows.slice(0, 6).map(r => {
            const hasRegime = r.regimeTrades >= minTrades;
            const regimeCell = hasRegime
                ? `${r.regimeWinRate.toFixed(0)}% (${r.regimeTrades})`
                : r.regimeTrades > 0 ? `${r.regimeWinRate.toFixed(0)}% (${r.regimeTrades}, thin)` : 'n/a';
            return `- ${resolveName(r.key)} — ${current}: ${regimeCell} · overall ${r.totalWinRate.toFixed(0)}% (${r.total})`;
        }),
        '',
        'INSTRUCTION: use the CURRENT-regime win rate as context for your own read — when it has ≥3 trades it is the most relevant sample of this regime; otherwise lean on the overall. There is no moderator weighting analysts; you are the one answering.',
    ];
    return lines.join('\n');
};
