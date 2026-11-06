/**
 * diagnosisPacket — the pure half of the post-mortem diagnosis.
 *
 * It turns a tracked position, its source row(s) and the captured context into
 * the deterministic packet a model reads, and renders the stored diagnosis
 * back into the journal note. No store, no network, no provider — so the
 * packet's facts (and its printed ABSENCES) are directly testable.
 *
 * The tape's outcome is authoritative. A model's claim is kept as
 * `modelOutcome`; it never replaces the measured result.
 */

import type { LoggedTrade } from '../../types/trade';
import type { SignalRow } from '../../types/signal';
import type {
    DiagnosisOutcome,
    DiagnosisQueueItem,
    DiagnosisRefusal,
    TrackedContextPoint,
    TrackedDiagnosis,
    TrackedPosition,
} from '../../types/tracking';
import { TradeOutcome } from '../../types/enums';
import { clipNote } from '../../utils/harnessMarks';
import { stopDistancePercent } from '../../utils/netRiskReward';

export const PATH_SAMPLE = 16;
export const CONTEXT_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;

export interface DiagnosisFacts {
    position: TrackedPosition;
    outcome: DiagnosisOutcome;
    signalRow?: SignalRow;
    journalRow?: LoggedTrade;
    context: readonly TrackedContextPoint[];
}

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const fnv1a = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

const iso = (ms?: number | null): string =>
    finite(ms) ? new Date(ms).toISOString() : 'not recorded';

const px = (v?: number | null): string =>
    finite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : 'not recorded';

const rText = (v?: number | null): string =>
    finite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : 'not measured';

const pctText = (v?: number | null): string => (finite(v) ? `${v.toFixed(2)}%` : 'not captured');

const numText = (v?: number | null): string => (finite(v) ? v.toFixed(2) : 'not captured');

const clip = (text: string, max: number): string => {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max)}\n${clipNote({ source: 'the record text', kept: max, total: trimmed.length })}`;
};

const durationText = (ms: number): string => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const samplePoints = <T extends { t: number }>(points: readonly T[], max: number): T[] => {
    if (points.length <= max) return [...points];
    const step = (points.length - 1) / (max - 1);
    const out: T[] = [];
    for (let i = 0; i < max; i += 1) {
        const point = points[Math.round(i * step)];
        if (point) out.push(point);
    }
    return [...new Map(out.map(point => [point.t, point])).values()];
};

/** The tape's / journal's / ledger's outcome. The model's claim is kept
 *  separately and never replaces this. */
export const authoritativeOutcome = (
    position: TrackedPosition,
    journalRow?: LoggedTrade | null,
    signalRow?: SignalRow | null,
): DiagnosisOutcome => {
    if (journalRow?.outcome === TradeOutcome.WIN) return 'win';
    if (journalRow?.outcome === TradeOutcome.LOSS) return 'loss';
    if (signalRow) {
        if (signalRow.status === 'won') return 'win';
        if (signalRow.status === 'lost') return 'loss';
        if (signalRow.status === 'expired') {
            const r = signalRow.resolution?.outcomeR ?? 0;
            return Math.abs(r) < 0.05 ? 'breakeven' : r > 0 ? 'win' : 'loss';
        }
    }
    const exit = position.exit;
    if (exit?.reason === 'target') return 'win';
    if (exit?.reason === 'stop') return 'loss';
    const r = exit?.netR ?? exit?.realizedR ?? 0;
    return Math.abs(r) < 0.05 ? 'breakeven' : r > 0 ? 'win' : 'loss';
};

export const diagnosisIsTentative = (position: TrackedPosition): boolean =>
    !position.tapeCoversWindow
    || position.gaps.length > 0
    || position.exit?.ambiguous === true
    || position.barsRead < 5;

/** The packet the model reads. Pure and exported so a test can assert the
 *  facts — and the ABSENCES — the model was given. */
export const diagnosisPacket = (facts: DiagnosisFacts): string => {
    const { position, outcome, signalRow, journalRow, context } = facts;
    const exit = position.exit;
    const entryAt = position.entryBarTime ?? position.openedAt;
    const closedAt = position.closedAt ?? exit?.at ?? Date.now();
    const riskPct = stopDistancePercent(position.entry, position.stop);
    const lines: string[] = [
        `SOURCE: ${position.source}`,
        `SYMBOL: ${position.symbol} · ${position.direction.toUpperCase()}`,
        `OUTCOME (authoritative): ${outcome.toUpperCase()} · exit ${exit?.reason ?? 'not recorded'} at ${px(exit?.price)} · ${iso(exit?.at)}`,
        `LEVELS: entry ${px(position.entry)} · stop ${px(position.stop)} · targets ${position.targets.map(px).join(' / ')}`,
        `RISK: ${px(Math.abs(position.entry - position.stop))} (${riskPct.toFixed(2)}% of entry)${position.leverage ? ` · leverage ${position.leverage}x` : ''}`,
        `FILL: ${position.entryConfirmed ? 'confirmed at the plan price' : 'limit touch at the plan price'}${position.entryBarAmbiguous ? ' · entry candle ambiguous (extremes may predate the fill)' : ''}`,
    ];

    if (exit) {
        lines.push(
            `EXIT: ${exit.reason} · same-candle ${exit.sameCandle}`
            + `${exit.ambiguous ? ' · AMBIGUOUS (stop-first policy)' : ''}`
            + `${exit.gapAtOpen ? ' · GAP at open' : ''}`,
            `R: ${rText(exit.realizedR)} gross · ${rText(exit.costR)} cost · ${rText(exit.netR)} net`
            + `${exit.slippageModeled ? ' (signal cost includes assumed slippage)' : ' (journal cost is fee-only; slippage not modeled)'}`,
        );
    } else {
        lines.push('R: not measured (no exit)');
    }

    lines.push(
        `EXCURSION: MFE ${rText(position.mfeR)} at ${px(position.mfePrice)} ${iso(position.mfeAt)} · MAE ${rText(position.maeR)} at ${px(position.maePrice)} ${iso(position.maeAt)}`,
        `HOLD: ${durationText(Math.max(0, closedAt - entryAt))} · bars read ${position.barsRead} · gaps ${position.gaps.length}`
        + `${position.gaps.length ? ` (${position.gaps.slice(0, 5).map(iso).join(', ')}${position.gaps.length > 5 ? '…' : ''})` : ''}`
        + ` · tape covers window ${position.tapeCoversWindow ? 'yes' : 'NO'}`,
        `ENTRY CONTEXT: ${clip(position.entryContext.thesis, 700)}`,
        `MODEL AT ENTRY: ${[position.entryContext.provider, position.entryContext.model].filter(Boolean).join(' / ') || 'not recorded'}`
        + `${position.entryContext.promptVersion ? ` · prompt ${position.entryContext.promptVersion}` : ''}`,
    );
    if (position.entryContext.injectedSkills?.length) {
        lines.push(`SKILLS INJECTED ON THAT TURN: ${position.entryContext.injectedSkills.join(', ')}`);
    }
    if (position.entryContext.snapshot) {
        lines.push(`ENTRY SNAPSHOT: ${clip(JSON.stringify(position.entryContext.snapshot), 700)}`);
    }

    if (journalRow) {
        const analysis = journalRow.analysis;
        lines.push(
            '',
            `PLAN (journal): ${clip(analysis?.strategy || 'no plan text recorded', 700)}`,
            `GATE: ${analysis?.gate
                ? `${analysis.gate.status} at a ${Math.round(analysis.gate.confidenceCap * 100)}% cap`
                + `${analysis.gate.refusal ? ` · REFUSED: ${analysis.gate.refusal}` : ''}`
                + `${analysis.gate.warnings?.length ? ` · cautions: ${analysis.gate.warnings.join(' | ')}` : ''}`
                : 'never ran — this row was logged UNCAPPED'}`,
            `CONFIDENCE: ${analysis?.confidence ?? 'not recorded'} · probability ${finite(analysis?.probability) ? analysis?.probability : 'not recorded'}`,
            `REGIME: ${journalRow.marketRegime ? `${journalRow.marketRegime} (${journalRow.marketRegimeSource ?? 'source unstated'})` : 'never observed — do not assume ranging'}`,
            `PLAN FOLLOWED: ${journalRow.followedPlan === undefined ? 'not recorded' : journalRow.followedPlan ? 'yes' : `no — ${journalRow.planDeviationNote ?? 'no note given'}`}`,
            `BENCHMARK: ${journalRow.benchmark
                ? (finite(journalRow.benchmark.alphaPct)
                    ? `vs ${journalRow.benchmark.benchmarkSymbol} ${journalRow.benchmark.benchmarkPct.toFixed(2)}% · trade ${journalRow.benchmark.tradePct.toFixed(2)}% · alpha ${journalRow.benchmark.alphaPct.toFixed(2)}%`
                    : `unavailable (${journalRow.benchmark.unavailableReason ?? 'no comparison'})`)
                : 'never measured'}`,
            `SIZE: suggested risk ${journalRow.suggestedRiskUsd !== undefined ? `$${journalRow.suggestedRiskUsd}` : 'not set'}`
            + ` · notional ${journalRow.suggestedNotionalUsd !== undefined ? `$${journalRow.suggestedNotionalUsd}` : 'not set'}`
            + `${journalRow.suggestedSizeReason ? ` (${journalRow.suggestedSizeReason})` : ''}`
            + ` · model stated risk ${journalRow.modelStatedRiskUsd !== undefined ? `$${journalRow.modelStatedRiskUsd}` : 'not stated'}`
            + ` · notional ${journalRow.modelStatedNotionalUsd !== undefined ? `$${journalRow.modelStatedNotionalUsd}` : 'not stated'}`,
            `JOURNAL OUTCOME: ${journalRow.outcome} · resolved by ${journalRow.resolutionSource ?? 'unknown writer'}`,
        );
    }

    if (signalRow) {
        const base = signalRow.resolution?.base;
        lines.push(
            '',
            `SIGNAL THESIS: ${clip(signalRow.signal.thesis, 700)}`,
            `SIGNAL EVIDENCE: ${signalRow.signal.evidenceRefs.join(' · ') || 'none recorded'}`,
            `LEDGER: ${signalRow.status}${signalRow.resolution?.ambiguous ? ' · AMBIGUOUS' : ''}`
            + ` · cross-check ${signalRow.resolution?.crossCheck ?? 'unavailable'}`
            + ` · primary ${signalRow.resolution?.primarySource ?? 'unknown'}`,
            `BASE RATE (same levels): ${base
                ? `${(base.hitRate * 100).toFixed(1)}% over ${base.samples} entries (horizon ${base.horizonBars} bars, risk ${base.riskPct.toFixed(2)}%, reward ${base.rewardPct.toFixed(2)}%)`
                : 'not measured'}`,
            `SHADOW GATE: ${signalRow.gate ? `${signalRow.gate.status}${signalRow.gate.reason ? ` — ${signalRow.gate.reason}` : ''}` : 'not recorded'}`
            + ` · EVIDENCE SHADOW: ${signalRow.grounding ? `${signalRow.grounding.verdict}${signalRow.grounding.missing.length ? ` — missing ${signalRow.grounding.missing.join(', ')}` : ''}` : 'not recorded'}`,
        );
    }

    lines.push('', 'CONTEXT AT CLOSE (higher timeframes; funding/OI as of diagnosis, not exit; spread/news not captured):');
    if (context.length === 0) {
        lines.push('  not captured');
    } else {
        for (const point of context) {
            lines.push(
                `  ${point.timeframe}: close ${px(point.close)}`
                + ` · vol ${numText(point.volume)}`
                + ` · EMA20 ${px(point.indicators?.ema20)}`
                + ` · EMA50 ${px(point.indicators?.ema50)}`
                + ` · RSI14 ${numText(point.indicators?.rsi14)}`
                + ` · ATR ${pctText(point.indicators?.atrPercent)}`
                + `${point.funding !== undefined ? ` · funding ${(point.funding * 100).toFixed(4)}%` : ''}`
                + `${point.openInterest !== undefined ? ` · OI ${numText(point.openInterest)} USDT` : ''}`,
            );
        }
    }

    const points = samplePoints(position.timeline, PATH_SAMPLE);
    lines.push(
        '',
        `PATH (${position.timeline.length} stored points${position.timelineDownsampled ? `, downsampled ${position.timelinePointsDropped}` : ''}; * = entry/MFE/MAE/exit/gap; times UTC):`,
    );
    if (points.length === 0) {
        lines.push('  not recorded');
    } else {
        for (const point of points) {
            lines.push(`  ${iso(point.t)} O${point.o} H${point.h} L${point.l} C${point.c}${point.decisive ? ' *' : ''}`);
        }
    }
    return lines.join('\n');
};

/** A stored refusal is an audit fact, not a fabricated lesson. */
export const refusalDiagnosis = (
    item: DiagnosisQueueItem,
    position: TrackedPosition | null,
    outcome: DiagnosisOutcome,
    reason: DiagnosisRefusal,
    detail: string,
): TrackedDiagnosis => ({
    id: item.id,
    tradeId: item.tradeId,
    source: position?.source ?? item.source ?? 'signal',
    outcome,
    whatHappened: `Diagnosis refused: ${detail}`,
    rootCause: 'Not diagnosed — the record could not support a cause.',
    whatShouldHaveBeenDone: 'No change inferred from this record.',
    primaryChange: 'hold',
    lesson: 'No lesson: the record is too thin to support one.',
    when: 'the record is too thin to diagnose',
    action: 'collect a complete tape before learning from it',
    confidence: 0,
    evidenceRefs: [],
    evidenceCount: 0,
    createdAt: new Date().toISOString(),
    tentative: true,
    refusal: reason,
});

/** The journal note. Its `Lesson:` line and `When …, do …` sentence are what
 *  the existing diary and skill readers parse; the structured diagnosis is
 *  stored beside it. */
export const renderDiagnosisPostMortem = (diagnosis: TrackedDiagnosis): string => [
    `Post-mortem written by the app at settlement${diagnosis.model ? ` (${diagnosis.model})` : ''}.`,
    '',
    diagnosis.whatHappened.trim(),
    '',
    `Root cause: ${diagnosis.rootCause.trim()}`,
    '',
    `What should have been done: ${diagnosis.whatShouldHaveBeenDone.trim()}`,
    '',
    `Lesson: ${diagnosis.lesson.trim()}`,
    '',
    `When ${diagnosis.when.trim()}, do ${diagnosis.action.trim()}.`,
].join('\n');
