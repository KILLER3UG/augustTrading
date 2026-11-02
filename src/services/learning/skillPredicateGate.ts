/**
 * skillPredicateGate — asks the skills' code-level triggers against the live
 * tape before a debate spends tokens on them.
 *
 * Retrieval decides which skills are RELEVANT by matching setup dimensions; a
 * predicate decides whether a relevant skill's trigger is actually TRUE on the
 * current bar. The two are different questions, and until now only the first
 * was answered in code — the second was left to a seat reading prose.
 *
 * Cost is one `fetchKlines` per coin+timeframe, which the 30s KlineService
 * cache and its in-flight dedupe make effectively free while the chart for that
 * symbol is on screen. No model call, no desk tool, no new endpoint.
 */

import {
    isApprovedSkill,
    listSkills,
    titleFromMeta,
    MIN_SAMPLE_FOR_VETO,
    type SkillKind,
    type SkillMeta,
} from './SkillMemoryService';
import {
    buildPredicateSeries,
    evaluatePredicateSource,
    lastClosedIndex,
} from '../analysis/skillPredicate';
import type { ScanCandle } from '../trade/setupScan';
import { shouldSkillHoldout } from '../../utils/skillHoldout';

/** A fired `avoid` predicate caps verdict confidence here. The number matches
 *  the ceiling the existing prose-based avoid ladder already applies, so the
 *  code gate tightens nothing beyond what the skill already implied — it just
 *  makes the call deterministic instead of hoping a seat honors the sentence. */
export const AVOID_PREDICATE_CEILING = 0.40;

/** How many fired triggers the injected note renders. Sized so the whole
 *  block stays under ~600 chars — comparable to one memory slice. */
export const MAX_NOTE_LINES = 6;

/** Live fetch depth in bars — what the current-bar gate has always used,
 *  cached 30s by KlineService, one request. */
const LIVE_FETCH_BARS = 120;

/** Replay fetch-depth ceiling. `fetchKlines` fetches klines in ONE request
 *  (KlineService has no pagination) and the spot mirror caps a single
 *  request at 1000 bars — asking for more returns fewer bars than asked,
 *  silently. A trade older than this many bars of its own timeframe reads as
 *  INCONCLUSIVE (never "conditions clear"), which is the honest answer until
 *  the fetch grows a paged historical mode. */
export const MAX_REPLAY_BARS = 1000;

/** Bars a timeframe must fetch so an `asOfMs` cutoff still leaves a
 *  judgeable series: fetchKlines returns bars ENDING NOW, so depth has to
 *  cover the age of the cutoff (or the asOfMs filter empties the series and
 *  every historical run silently reports inconclusive) plus indicator
 *  warmup — LIVE_FETCH_BARS of it. */
const replayBarsFor = (timeframe: string, asOfMs: number): number => {
    const m = /^(\d+)\s*([mhd])$/i.exec(timeframe.trim());
    const unitMs = !m ? 3_600_000
        : m[2].toLowerCase() === 'm' ? 60_000
            : m[2].toLowerCase() === 'd' ? 86_400_000
                : 3_600_000;
    const periodMs = (m ? Math.max(1, Number(m[1])) : 1) * unitMs;
    const age = Date.now() - asOfMs;
    const ageBars = Number.isFinite(age) && age > 0 ? Math.ceil(age / periodMs) : 0;
    return Math.min(LIVE_FETCH_BARS + ageBars, MAX_REPLAY_BARS);
};

export interface PredicateGateResult {
    /** Skills whose predicate fired on the last closed bar. */
    fired: Array<{ name: string; kind: SkillKind; predicate: string; timeframe: string }>;
    /** How many predicates were judged at all. */
    judged: number;
    /** Predicates that could not be confirmed — quiet, unwarmed indicators, or
     *  a clause that no longer parses. Kept distinct from "safe". */
    inconclusive: number;
    /** Lowest ceiling implied across fired skills; undefined when none fired. */
    ceiling?: number;
    /** Prompt line for the seats. Empty when nothing fired, so a run with no
     *  predicates is byte-identical to one before this feature. */
    note: string;
}

const EMPTY: PredicateGateResult = { fired: [], judged: 0, inconclusive: 0, note: '' };

/**
 * A predicate may only clamp what the model could itself have seen. Retrieval
 * and enforcement both retire a skill on `status === 'retired'`/`supersededBy`
 * (`SkillMemoryService.ts:681`, `:707`) and hold a zero-evidence candidate
 * avoid skill back from vetoing (`:262`); the gate has to honour the same
 * three guards or a retired BTC/LONG avoid skill caps a BTC/SHORT verdict at
 * 40% behind a deterministic-looking technicality.
 *
 * `direction` deliberately FAILS CLOSED: a skill scoped to one side says
 * nothing about the other, and a run with no detected direction leaves a
 * scoped skill out instead of guessing which side it applies to.
 */
const mayClamp = (skill: SkillMeta, direction?: string): boolean => {
    if (skill.status === 'retired' || skill.supersededBy) return false;
    if (skill.kind === 'avoid' && skill.status === 'candidate'
        && (skill.wins + skill.losses) < MIN_SAMPLE_FOR_VETO) return false;
    if (skill.direction && skill.direction !== direction) return false;
    return true;
};

/** Skills carrying a predicate, scoped to this coin (a coin-less skill applies
 *  to any setup and is kept). */
export const predicateBearingSkills = (skills: SkillMeta[], coin?: string, direction?: string): SkillMeta[] => {
    const wanted = (coin || '').toUpperCase().replace(/USDT?$/, '');
    return skills.filter(s => {
        if (!s.predicate || !s.predicate.trim()) return false;
        if (!mayClamp(s, direction)) return false;
        if (!s.coin) return true;
        return s.coin.toUpperCase().replace(/USDT?$/, '') === wanted;
    });
};

const describeFired = (kind: SkillKind): string =>
    kind === 'avoid' ? 'AVOID condition is LIVE' : 'repeat condition is LIVE';

/**
 * Evaluate every predicate-bearing skill for one coin. Never throws: a failed
 * fetch simply means that timeframe's gate did not run, which is reported as
 * inconclusive rather than as "conditions clear".
 *
 * Skills are judged on the timeframe they were earned on (`skill.timeframe`,
 * falling back to 1h) — a 15m exhaustion rule read off an hourly bar would be a
 * different condition entirely. One fetch per distinct timeframe, since
 * KlineService already caches and de-dupes in flight.
 */
export async function evaluateSkillPredicates(args: {
    coin: string;
    skills?: SkillMeta[];
    bars?: number;
    /** The run's own direction — a skill scoped to the other side must not
     *  clamp it. 'Neutral' matches nothing, which is the point. */
    direction?: string;
    /** Replay cutoff. A backtest run time-travels its memory; judging a
     *  trigger on a bar that closed after this instant leaks the future. */
    asOfMs?: number;
    /** The run's id, used only to honour the ε-holdout. A control run gets NO
     *  skill treatment anywhere else (`MemoryRetrievalService.ts:577`), and a
     *  code-side clamp is treatment — measuring a holdout group that is being
     *  quietly served skill guidance would make the whole experiment a lie. */
    runId?: string;
}): Promise<PredicateGateResult> {
    if (shouldSkillHoldout(args.runId)) return EMPTY;
    // `file.enabled` is what retirement writes (SkillMemoryService.ts:551), so
    // checking it here keeps a switched-off skill out of the clamp pool even if
    // its markdown still reads active. `isApprovedSkill` is the same activation
    // gate retrieval applies (MemoryRetrievalService.ts:226) — a skill the app
    // refuses to inject into a seat's prompt must not clamp that seat's verdict
    // from the code side either. Nothing in the notebook reaches this pool
    // unapproved today; an imported or hand-edited file can, and the invariant
    // has to hold for that path too.
    const pool = predicateBearingSkills(
        args.skills ?? listSkills().filter(s => s.file.enabled && isApprovedSkill(s.meta)).map(s => s.meta),
        args.coin,
        args.direction,
    );
    if (pool.length === 0) return EMPTY;

    const byTimeframe = new Map<string, SkillMeta[]>();
    for (const skill of pool) {
        const tf = skill.timeframe || '1h';
        byTimeframe.set(tf, [...(byTimeframe.get(tf) ?? []), skill]);
    }

    const fired: PredicateGateResult['fired'] = [];
    let inconclusive = 0;

    for (const [timeframe, skills] of byTimeframe) {
        let series;
        try {
            const { fetchKlines } = await import('../analysis/KlineService');
            const bars = args.bars ?? (args.asOfMs === undefined
                ? LIVE_FETCH_BARS
                : replayBarsFor(timeframe, args.asOfMs));
            const klines = await fetchKlines(args.coin, timeframe, bars);
            // KlineService stores time in MILLISECONDS; `asOfMs` is a
            // millisecond cutoff. Multiplying here made the filter impossible
            // to satisfy and turned every replay verdict into "inconclusive".
            const candles: ScanCandle[] = klines
                .filter(k => args.asOfMs === undefined || k.time <= args.asOfMs)
                .map(k => ({
                    time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
                }));
            if (candles.length < 3) throw new Error('not enough history');
            series = buildPredicateSeries(candles);
        } catch {
            // No tape means no gate for this timeframe's skills.
            inconclusive += skills.length;
            continue;
        }
        const at = lastClosedIndex(series);
        for (const skill of skills) {
            const outcome = evaluatePredicateSource(skill.predicate ?? '', series, at);
            if (outcome.status === 'invalid' || outcome.status === 'unknown') {
                inconclusive += 1;
                continue;
            }
            if (outcome.status === 'fired') {
                fired.push({ name: titleFromMeta(skill), kind: skill.kind, predicate: skill.predicate ?? '', timeframe });
            }
        }
    }

    const ceilings = fired.filter(f => f.kind === 'avoid').map(() => AVOID_PREDICATE_CEILING);
    // Every seat gets this block and it sits OUTSIDE the stage budgets the
    // memory slices obey, so it renders avoid-first (those are the lines that
    // move the verdict) and stops at a cap, naming what it hid.
    const shown = [...fired]
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'avoid' ? -1 : 1))
        .slice(0, MAX_NOTE_LINES);
    const note = fired.length === 0
        ? ''
        : [
            '**CODE-CHECKED TRIGGERS (evaluated on the last closed candle, not by a model):**',
            ...shown.map(f => `- ${f.name} — ${f.kind} @ ${f.timeframe}: ${f.predicate} → ${describeFired(f.kind)}`),
            ...(fired.length > shown.length
                ? [`…and ${fired.length - shown.length} more fired (pull the skill cards with recall).`]
                : []),
            ...(ceilings.length > 0
                ? [`An AVOID trigger is live: the verdict cannot exceed ${Math.round(AVOID_PREDICATE_CEILING * 100)}% confidence.`]
                : []),
        ].join('\n');

    return {
        fired,
        judged: pool.length,
        inconclusive,
        ceiling: ceilings.length > 0 ? Math.min(...ceilings) : undefined,
        note,
    };
}
