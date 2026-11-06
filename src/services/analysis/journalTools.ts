/**
 * journalTools — the journal-reading half of the market-tools family:
 * `setup_base_rate` and `risk_state`.
 *
 * These two are the P1 evidence/risk pair from docs/plans/tools-upgrade.md
 * §7. They read the SAME rows the `get_trade_log` tool reads (the desk
 * context's `trades`), so a number here and a number there cannot disagree.
 * Both refuse thin samples out loud — a base rate off three trades or a
 * Kelly ceiling off ten is the kind of confident nonsense this task exists
 * to end.
 *
 * Envelope shape: the same `MarketToolEnvelope` the market tools return
 * (reused from marketTools), with `evidence_level: 'documented'` — these are
 * measured personal-history stats, not market structure.
 */

import type { LoggedTrade } from '../../types/trade';
import { computeSetupClusterStats } from '../learning/setupClusterStats';
import { wilsonInterval95 } from '../signals/signalAccuracy';
import { plannedRiskReward } from '../../utils/riskReward';
import { readRiskState, MIN_TRADES_FOR_KELLY_FLOOR, type RiskStateRead } from '../market/riskStateCore';
import type { MarketToolEnvelope } from './marketTools';

/** The setup types a caller can ask a base rate for. `family` uses the
 *  strategy-family vocabulary the rows already carry. */
export interface SetupBaseRateParams {
    coin?: string;
    direction?: 'Long' | 'Short';
    family?: string;
}

/**
 * The hit rate / expectancy of a setup type, from the trader's own logged
 * rows, with a Wilson 95% interval and the sample size printed BESIDE the
 * rate. Refuses under `MIN_SAMPLE` — the envelope says why rather than
 * printing a 3-trade "win rate".
 *
 * Regime conditioning is NOT claimed: journal rows carry no feature snapshot
 * (register row O-46), so conditioning rows by regime would silently filter
 * to nothing. The envelope says so — the honest answer, and one more reason
 * O-46 matters.
 */
export const runSetupBaseRateTool = (
    trades: LoggedTrade[],
    params: SetupBaseRateParams,
    asofMs: number = Date.now(),
): string => {
    const tool = 'setup_base_rate';
    const notes: string[] = ['source: the trader\'s logged journal rows (the same rows get_trade_log reads)'];
    const MIN_SAMPLE = 5;
    const make = (values: Record<string, unknown> | null, summary: string, reason?: string, barsUsed = (trades ?? []).length): string =>
        JSON.stringify({
            tool,
            asof: asofMs,
            symbol: params.coin ?? '(all)',
            tf: 'journal',
            params: { ...params } as Record<string, unknown>,
            data_quality: {
                available: values !== null && reason === undefined,
                bars_used: barsUsed,
                notes,
                ...(reason !== undefined ? { reason } : {}),
            },
            values,
            distances_atr: {},
            evidence_level: 'documented',
            one_line_summary: values === null ? (reason ?? 'unavailable') : summary,
        } satisfies MarketToolEnvelope<Record<string, unknown>>);

    const rows = trades ?? [];
    if (rows.length === 0) {
        return make(null, '', 'the journal has no rows yet — nothing to measure a base rate on');
    }
    const stats = computeSetupClusterStats(params.coin, params.direction, params.family, rows);
    if (!stats || stats.sample < MIN_SAMPLE || stats.winRate === null) {
        return make(null, '', `sample too thin: ${stats?.sample ?? 0} matching closed rows for this setup type (need ≥${MIN_SAMPLE}) — no base rate is quoted`);
    }
    const winRate = stats.winRate;
    const ci = wilsonInterval95(stats.wins, stats.sample);
    const values = {
        setup: { coin: params.coin ?? '(any)', direction: params.direction ?? '(any)', family: params.family ?? '(any)' },
        sample: stats.sample,
        wins: stats.wins,
        losses: stats.losses,
        win_rate: stats.winRate,
        wilson_95: ci ? { low: Math.round(ci.low * 1000) / 1000, high: Math.round(ci.high * 1000) / 1000 } : null,
        avg_r: stats.avgR,
        last_outcome: stats.lastOutcome,
        last_date: stats.lastDate,
        worst_lesson: stats.worstLesson,
        regime_conditioned: false,
        regime_note: 'rows carry no regime snapshot (open-items O-46), so this rate is NOT regime-conditioned — treat it as the blended base rate until the journal records regime',
    };
    return make(
        values,
        `${stats.wins}W/${stats.losses}L over ${stats.sample} (${(winRate * 100).toFixed(0)}%, Wilson 95% ${ci ? `${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)}%` : 'n/a'}), avg ${stats.avgR}R`,
    );
};

/**
 * The portfolio's risk state from the journal: open-plan heat (grouped by
 * coin), the day/week realized-R traffic light, and the half-Kelly ceiling —
 * refused under the same floor the core declares. Open plans get their
 * planned R:R filled from the plan's own numbers via the canonical
 * `plannedRiskReward` (one source).
 */
export const runRiskStateTool = (
    trades: LoggedTrade[],
    asofMs: number = Date.now(),
): string => {
    const tool = 'risk_state';
    const notes: string[] = [
        'source: the trader\'s logged journal rows',
        'advisory only — context for sizing and refusal decisions, never a P&L report',
    ];
    const rows = trades ?? [];
    if (rows.length === 0) {
        return JSON.stringify({
            tool, asof: asofMs, symbol: '(journal)', tf: 'journal', params: {},
            data_quality: { available: false, bars_used: 0, notes, reason: 'the journal has no rows yet' },
            values: null, distances_atr: {}, evidence_level: 'documented',
            one_line_summary: 'the journal has no rows yet',
        } satisfies MarketToolEnvelope<null>);
    }
    const read = readRiskState(rows, asofMs);
    // Fill the canonical planned R:R per open plan from its own numbers.
    const values = {
        ...read,
        open: {
            ...read.open,
            rows: read.open.rows.map(r => {
                const t = rows.find(x => x.id === r.id);
                const tps = (t?.analysis.takeProfit ?? []).map(tp => parseFloat(tp.price)).filter(n => Number.isFinite(n));
                const entry = r.entry;
                const stop = r.stop;
                return {
                    ...r,
                    planned_rr: entry !== null && stop !== null
                        ? plannedRiskReward({ entry, stopLoss: stop, takeProfits: tps })
                        : 0,
                };
            }),
        },
        kelly_floor: MIN_TRADES_FOR_KELLY_FLOOR,
    } as RiskStateRead & { kelly_floor: number };
    const summary = `${read.open.count} open plan(s)${read.open.correlated ? ' (CORRELATED)' : ''}, drawdown light ${read.drawdown.light} (day ${read.drawdown.todayR}R / week ${read.drawdown.weekR}R), Kelly ${read.kelly.available ? `half-Kelly ceiling ${read.kelly.halfKellyPct}%` : 'refused (thin sample)'}`;
    return JSON.stringify({
        tool, asof: asofMs, symbol: '(journal)', tf: 'journal', params: {},
        data_quality: { available: true, bars_used: rows.length, notes },
        values, distances_atr: {}, evidence_level: 'documented', one_line_summary: summary,
    } satisfies MarketToolEnvelope<typeof values>);
};
