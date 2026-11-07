/**
 * journalTools — the journal-reading half of the market-tools family:
 * `setup_base_rate`, `risk_state` and `meta_label`.
 *
 * These read the SAME rows the `get_trade_log` tool reads (the desk context's
 * `trades`), so a number here and a number there cannot disagree. Every rate
 * refuses thin samples out loud — a base rate off three trades or a Kelly
 * ceiling off ten is the kind of confident nonsense this task exists to end.
 *
 * Conditioning reads what the plan RECORDED at decision time: the O-46
 * snapshot's regime (`marketConditions.timeframeAlignment`). A row without it
 * is excluded from a conditioned bucket, never guessed into one — and the
 * coverage counts say how many rows were excluded for missing the snapshot,
 * so a thin bucket is never mistaken for a losing one.
 *
 * Envelope shape: the same `MarketToolEnvelope` the market tools return
 * (reused from marketTools), with `evidence_level: 'documented'` — these are
 * measured personal-history stats, not market structure.
 */

import type { LoggedTrade } from '../../types/trade';
import {
    computeSetupClusterStats, clusterRows,
    regimeIdOf, regimeIdMatches, type SetupClusterStats,
} from '../learning/setupClusterStats';
import { wilsonInterval95 } from '../signals/signalAccuracy';
import { plannedRiskReward, plannedRiskRewardSigned, type PlannedRiskDirection } from '../../utils/riskReward';
import { roundTripCostR, breakEvenWinRate } from '../../utils/netRiskReward';
import { readRiskState, MIN_TRADES_FOR_KELLY_FLOOR, type RiskStateRead } from '../market/riskStateCore';
import { metaLabel } from '../market/metaLabelCore';
import { regimeRead } from '../market/regimeCore';
import { atr14 } from '../../utils/smcStructure';
import type { Kline } from '../../types/message';
import type { MarketToolEnvelope } from './marketTools';

/** The floor every quoted rate shares: under this, the tool says why it is
 *  not quoting one. */
const MIN_RATE_SAMPLE = 5;

/**
 * The regime a caller asked for. A trailing numeric segment is a BAR COUNT
 * from the live read (`regimeCore.regimeId` = `trend:normal:100`), not a
 * journal axis — the model copies that id from `get_regime`, and without
 * this it would match no row and read as an empty bucket.
 */
export const normaliseRegimeQuery = (raw: string): string => {
    const parts = raw.trim().toLowerCase().split(':').map(s => s.trim()).filter(Boolean);
    if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
    return parts.join(':');
};

/** The setup types a caller can ask a base rate for. `family` uses the
 *  strategy-family vocabulary the rows already carry; `regime` narrows the
 *  same rows to an attributed bucket. */
export interface SetupBaseRateParams {
    coin?: string;
    direction?: 'Long' | 'Short';
    family?: string;
    /** A decision-time regime id (`range:compressed`) or one axis segment
     *  (`compressed`). Rows with no recorded regime are excluded and counted. */
    regime?: string;
}

/**
 * The hit rate / expectancy of a setup type, from the trader's own logged
 * rows, with a Wilson 95% interval and the sample size printed BESIDE the
 * rate. Refuses under `MIN_RATE_SAMPLE` — the envelope says why rather than
 * printing a 3-trade "win rate".
 *
 * Without `regime` the rate is BLENDED across every recorded regime; the
 * envelope states which scope it used and how many rows carry the condition
 * at all.
 */
export const runSetupBaseRateTool = (
    trades: LoggedTrade[],
    params: SetupBaseRateParams,
    asofMs: number = Date.now(),
): string => {
    const tool = 'setup_base_rate';
    const notes: string[] = [
        'source: the trader\'s logged journal rows (the same rows get_trade_log reads)',
        'regime comes from the O-46 decision snapshot — a row logged without one is excluded, never guessed into a bucket',
    ];
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
    const regime = typeof params.regime === 'string' && params.regime.trim()
        ? normaliseRegimeQuery(params.regime)
        : undefined;

    const considered = clusterRows(rows, { coin: params.coin, direction: params.direction, family: params.family });
    const withRegime = considered.filter(t => regimeIdOf(t) !== null).length;
    const matchingRegime = regime
        ? considered.filter(t => { const id = regimeIdOf(t); return id !== null && regimeIdMatches(id, regime); }).length
        : null;

    const stats = computeSetupClusterStats(params.coin, params.direction, params.family, rows, { regime });
    if (!stats || stats.sample < MIN_RATE_SAMPLE || stats.winRate === null) {
        const bucket = regime ? ` in regime ${regime}` : '';
        const coverage = regime
            ? `; ${matchingRegime} of ${considered.length} considered closed row(s) match this regime, ${withRegime} carry any regime`
            : '';
        return make(null, '', `sample too thin: ${stats?.sample ?? 0} matching closed rows${bucket} (need ≥${MIN_RATE_SAMPLE}) — no base rate is quoted${coverage}`);
    }
    const winRate = stats.winRate;
    const ci = wilsonInterval95(stats.wins, stats.sample);
    const scope = regime ? `regime ${regime}` : '';
    const values = {
        setup: {
            coin: params.coin ?? '(any)',
            direction: params.direction ?? '(any)',
            family: params.family ?? '(any)',
            regime: regime ?? '(any)',
        },
        sample: stats.sample,
        wins: stats.wins,
        losses: stats.losses,
        win_rate: stats.winRate,
        wilson_95: ci ? { low: Math.round(ci.low * 1000) / 1000, high: Math.round(ci.high * 1000) / 1000 } : null,
        avg_r: stats.avgR,
        min_sample: MIN_RATE_SAMPLE,
        last_outcome: stats.lastOutcome,
        last_date: stats.lastDate,
        worst_lesson: stats.worstLesson,
        regime_conditioned: regime !== undefined,
        coverage: { considered: considered.length, with_regime: withRegime },
    };
    const avg = stats.avgR !== null ? `${stats.avgR.toFixed(2)}R` : 'R n/a';
    return make(
        values,
        `${stats.wins}W/${stats.losses}L over ${stats.sample}${scope ? ` in ${scope}` : ' (blended across recorded regimes)'} (${(winRate * 100).toFixed(0)}%, Wilson 95% ${ci ? `${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)}%` : 'n/a'}), avg ${avg}`,
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

// ─── meta_label — the P3 advisory gate read ─────────────────────────────
// The secondary "take / reduce / skip / how big" verdict on top of the
// primary signal, composed from the numbers the other tools already
// measured. ADVISORY: it never refuses a card and never blocks a turn —
// the refusing gate is proposalGate and stays the only one.

/**
 * The rate meta_label reads: the live regime's bucket when it holds the
 * floor, otherwise the blended rate — never a conditioned rate off two rows.
 * The scope string is the honest label printed BESIDE the number.
 */
export const pickBaseRate = (
    blended: SetupClusterStats | null,
    conditioned: SetupClusterStats | null,
    liveRegime: string | null,
): { stats: SetupClusterStats | null; scope: string } => {
    const useConditioned = conditioned !== null && conditioned.sample >= MIN_RATE_SAMPLE && conditioned.winRate !== null;
    return useConditioned
        ? { stats: conditioned, scope: `regime ${liveRegime}` }
        : {
            stats: blended,
            scope: liveRegime
                ? `blended — the ${liveRegime} bucket holds ${conditioned?.sample ?? 0} closed row(s), under ${MIN_RATE_SAMPLE}`
                : 'blended — no regime read this turn',
        };
};

export interface MetaLabelPlan {
    /** The coin the plan trades — the base-rate and correlated-exposure key. */
    coin: string;
    direction: 'Long' | 'Short';
    entry: number;
    stop: number;
    takeProfits: number[];
    /** The regime the setup claims to apply in, when the caller can say. */
    regimeApplies?: boolean;
}

export const runMetaLabelTool = async (
    trades: LoggedTrade[],
    plan: MetaLabelPlan,
    candles: Kline[],
    asofMs: number = Date.now(),
): Promise<string> => {
    const tool = 'meta_label';
    const notes: string[] = [
        'ADVISORY — a verdict with reasons; it never refuses a card and never sizes a position by itself (the trader decides)',
        'sources: the journal rows (base rate, heat, drawdown light), the plan\'s own arithmetic (break-even after costs), the 1h regime read',
        `the base rate is conditioned on the live regime only when that bucket holds ≥${MIN_RATE_SAMPLE} closed rows; otherwise it is BLENDED and the scope says so`,
    ];
    const make = (values: unknown, summary: string, reason?: string): string =>
        JSON.stringify({
            tool, asof: asofMs, symbol: '(plan)', tf: 'journal',
            params: { ...plan } as Record<string, unknown>,
            data_quality: {
                available: reason === undefined,
                bars_used: candles.length,
                notes,
                ...(reason !== undefined ? { reason } : {}),
            },
            values, distances_atr: {}, evidence_level: 'documented', one_line_summary: reason ?? summary,
        } satisfies MarketToolEnvelope<unknown>);

    const signed = plannedRiskRewardSigned({
        direction: plan.direction as PlannedRiskDirection,
        entry: plan.entry,
        stopLoss: plan.stop,
        takeProfits: plan.takeProfits,
    });
    if (signed.inverted || signed.ratio <= 0) {
        return make(null, '', 'the plan is inverted or has no computable R:R — meta-label reads a plan that can pay, not one that cannot lose');
    }
    const cost = roundTripCostR({ stopDistancePct: (signed.risk / plan.entry) * 100 });
    const breakEven = cost.known ? breakEvenWinRate({ rewardRatio: signed.ratio, costR: cost.costR }) : null;

    // The regime must be read BEFORE the rate is picked: the conditioned
    // bucket is the desk's own history in the regime this plan is entering.
    const reg = candles.length >= 80 && atr14(candles) > 0 ? regimeRead(candles) : null;
    // `${direction}:${volatility}` — the composite the O-46 snapshot writes.
    // `regimeId` carries a third segment (bar count) that no journal row has.
    const liveRegime = reg ? `${reg.direction}:${reg.volatility}` : null;
    const blended = computeSetupClusterStats(plan.coin, plan.direction, undefined, trades ?? []);
    const conditioned = liveRegime
        ? computeSetupClusterStats(plan.coin, plan.direction, undefined, trades ?? [], { regime: liveRegime })
        : null;
    const { stats, scope: baseRateScope } = pickBaseRate(blended, conditioned, liveRegime);

    // The trader's own base rate for this setup type.
    const ci = stats && stats.sample >= MIN_RATE_SAMPLE && stats.winRate !== null ? wilsonInterval95(stats.wins, stats.sample) : null;
    const baseRate = stats && ci && stats.winRate !== null
        ? { sample: stats.sample, winRate: stats.winRate, ciLow: ci.low, ciHigh: ci.high }
        : null;

    // The portfolio state.
    const risk = readRiskState(trades ?? [], asofMs);

    const read = metaLabel({
        plannedRr: signed.ratio,
        breakEvenWinRatePct: breakEven,
        baseRate,
        baseRateScope,
        regimeApplies: plan.regimeApplies ?? null,
        kellyHalfPct: risk.kelly.available ? risk.kelly.halfKellyPct ?? null : null,
        openPlans: risk.open.count,
        correlated: risk.open.count > 0 && risk.open.byCoin.some(c => c.coin === plan.coin.replace(/USDT$/i, '')),
        drawdownLight: risk.drawdown.light,
    });

    const values = {
        verdict: read.verdict,
        size_fraction_pct: read.sizeFractionPct,
        reasons: read.reasons,
        plan: {
            direction: plan.direction,
            planned_rr: signed.ratio,
            risk_atr: read2(() => (atr14(candles) > 0 ? Math.round((signed.risk / atr14(candles)) * 100) / 100 : null)),
            break_even_win_rate_pct: breakEven,
        },
        base_rate: baseRate,
        base_rate_scope: baseRateScope,
        regime_now: reg ? { direction: reg.direction, volatility: reg.volatility, regime_id: reg.regimeId } : null,
        portfolio: { open_plans: risk.open.count, correlated: risk.open.correlated, drawdown_light: risk.drawdown.light, week_r: risk.drawdown.weekR },
        kelly_half_pct: risk.kelly.available ? risk.kelly.halfKellyPct ?? null : null,
        thresholds: read.thresholds,
        note: 'the refusing gate is proposalGate and stays the only one — this read informs the trader, it does not block',
    };
    return make(values, `${read.verdict.toUpperCase()}${read.sizeFractionPct !== null ? ` (${read.sizeFractionPct}% of standard risk)` : ''} — ${read.reasons[0] ?? ''}`);
};

const read2 = (fn: () => number | null): number | null => fn();
