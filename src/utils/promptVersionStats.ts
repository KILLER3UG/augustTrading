import { LoggedTrade, TradeOutcome } from '../types';

export interface PromptVersionStat {
    version: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgDeclared: number | null;
    avgRealized: number | null;
}

export interface PromptLaneStat {
    lane: 'live' | 'control';
    trades: number;
    wins: number;
    winRate: number | null;
}

export const summarizePromptLanes = (trades: LoggedTrade[]): PromptLaneStat[] => {
    const by: Record<'live' | 'control', { wins: number; losses: number }> = {
        live: { wins: 0, losses: 0 },
        control: { wins: 0, losses: 0 },
    };
    for (const trade of trades) {
        const lane = trade.promptLane;
        if (lane !== 'live' && lane !== 'control') continue;
        if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) continue;
        if (trade.outcome === TradeOutcome.WIN) by[lane].wins += 1;
        else by[lane].losses += 1;
    }
    return (['live', 'control'] as const).map(lane => {
        const tradesN = by[lane].wins + by[lane].losses;
        return {
            lane,
            trades: tradesN,
            wins: by[lane].wins,
            winRate: tradesN > 0 ? Math.round((by[lane].wins / tradesN) * 100) : null,
        };
    });
};

export const summarizePromptVersions = (trades: LoggedTrade[]): PromptVersionStat[] => {
    const by = new Map<string, { wins: number; losses: number; declared: number[]; }>();
    for (const trade of trades) {
        const version = trade.promptVersion;
        if (!version) continue;
        if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) continue;
        const cur = by.get(version) ?? { wins: 0, losses: 0, declared: [] };
        if (trade.outcome === TradeOutcome.WIN) cur.wins += 1;
        else cur.losses += 1;
        if (typeof trade.analysis?.probability === 'number') cur.declared.push(trade.analysis.probability);
        by.set(version, cur);
    }
    return [...by.entries()]
        .map(([version, { wins, losses, declared }]) => {
            const tradesN = wins + losses;
            const avgDeclared = declared.length > 0
                ? Math.round(declared.reduce((a, b) => a + b, 0) / declared.length)
                : null;
            return {
                version,
                trades: tradesN,
                wins,
                losses,
                winRate: tradesN > 0 ? Math.round((wins / tradesN) * 100) : null,
                avgDeclared,
                avgRealized: tradesN > 0 ? Math.round((wins / tradesN) * 100) : null,
            };
        })
        .sort((a, b) => b.trades - a.trades);
};
