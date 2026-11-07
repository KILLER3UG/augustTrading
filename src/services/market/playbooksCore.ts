/**
 * playbooksCore — the family-H playbook layer, pure math over reads the
 * other cores already computed.
 *
 * A playbook is a NAMED SETUP DETECTOR: entry condition, side, invalidation
 * level, applicable regimes, the evidence used, and an evidence level. It
 * NEVER replaces judgment, never sizes a trade, never vetoes — it is a tag
 * plus its receipts (docs/product/focus.md: the output that matters is a
 * signal or a refusal). Every condition is a declared threshold from
 * documented method; the evidence_level says which kind of fact stands
 * behind each (structural = price/volume geometry; documented = a named
 * method; folklore = none of the playbooks get it — if one can't be
 * documented, it doesn't ship).
 *
 * The composition is the value: each playbook fires on facts the desk tools
 * computed independently, so a match carries its evidence list ready for the
 * seat to quote — and the seat can re-run any underlying tool to verify.
 */

import type { Kline } from '../../types/message';
import type { FailedExtensionRead, InitialBalanceRead, VaRotationRead } from './auctionCore';
import type { FlowEventsRead } from './orderFlowCore';
import type { RegimeRead } from './regimeCore';
import type { StructureRead } from './swingStructureCore';
import type { VolumeProfileRead } from './volumeProfileCore';
import type { VwapPositionRead, VwapRead } from './vwapCore';
import type { WyckoffRead } from './wyckoffCore';
import type { SweepReversal } from '../../utils/smcStructure';

export interface PlaybookContext {
    candles: Kline[];
    atr: number;
    regime: RegimeRead | null;
    structure: StructureRead | null;
    wyckoff: WyckoffRead | null;
    flow: FlowEventsRead | null;
    /** Day-structure reads (5m UTC-day set) — null when not computable. */
    ib: InitialBalanceRead | null;
    failedExtension: FailedExtensionRead | null;
    rotation: VaRotationRead | null;
    dayOpen: number | null;
    profile: VolumeProfileRead | null;
    sessionVwap: { vwap: VwapRead; position: VwapPositionRead } | null;
    sweeps: SweepReversal[];
    /** Key price levels the absorption check measures near (POC, zone edges). */
    keyLevels: number[];
}

import type { PlaybookId } from '../../types/playbook';

export interface PlaybookMatch {
    playbook: PlaybookId;
    side: 'long' | 'short';
    confidence: 'low' | 'medium' | 'high';
    /** The price that proves the read wrong — every playbook carries one. */
    invalidation: number | null;
    evidence: string[];
    evidence_level: 'structural' | 'documented';
    /** The regimes this playbook claims to apply in (declared, not measured). */
    applies_in: string[];
}

const r4 = (v: number): number => Number(v.toPrecision(6));

/** EMA series (standard k = 2/(n+1), seeded with the first n-bar SMA). */
export const emaSeries = (values: number[], period = 20): number[] => {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out: number[] = [];
    let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out.push(ema);
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
        out.push(ema);
    }
    return out;
};

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

export const scanPlaybooks = (ctx: PlaybookContext): PlaybookMatch[] => {
    const matches: PlaybookMatch[] = [];
    const { candles, atr } = ctx;
    if (candles.length < 25 || !(atr > 0)) return matches;
    const last = candles[candles.length - 1].close;
    const recentTime = candles[candles.length - 1].time;
    const push = (m: PlaybookMatch): void => { matches.push(m); };

    // 1 ── Value-area rotation (the 80% rule, documented): open outside
    //      prior value, re-enter it → the far side is the objective.
    const rot = ctx.rotation;
    if (rot && rot.openVsPriorValue !== 'inside' && rot.openVsPriorValue !== null && rot.reentered && rot.target !== null) {
        const long = rot.openVsPriorValue === 'below';
        push({
            playbook: 'value_area_rotation',
            side: long ? 'long' : 'short',
            confidence: 'medium',
            invalidation: ctx.dayOpen,
            evidence: [rot.detail, `rotation target ${r4(rot.target)}`],
            evidence_level: 'documented',
            applies_in: ['range', 'neutral'],
        });
    }

    // 2 ── Failed IB extension (documented): beyond the IB, closed back
    //      inside → fade toward the IB middle; invalid = the extreme.
    const fx = ctx.failedExtension;
    if (fx && fx.failed && fx.side !== null && ctx.ib) {
        const short = fx.side === 'above_ib_high';
        const extreme = short
            ? (ctx.ib.high + fx.maxExtensionAtr * atr)
            : (ctx.ib.low - fx.maxExtensionAtr * atr);
        push({
            playbook: 'failed_ib_extension',
            side: short ? 'short' : 'long',
            confidence: 'medium',
            invalidation: r4(extreme),
            evidence: [fx.detail, `IB ${r4(ctx.ib.high)}–${r4(ctx.ib.low)} (${ctx.ib.widthAtr} ATR wide)`],
            evidence_level: 'documented',
            applies_in: ['range', 'neutral', 'trend'],
        });
    }

    // 3 ── Wyckoff spring / UTAD (documented): ONLY medium-confidence events
    //      (the volume condition held) qualify; low-confidence candidates
    //      are the tool's job to label, not a setup.
    const wy = ctx.wyckoff;
    if (wy && wy.range) {
        const spring = [...wy.events].reverse().find(e => e.kind === 'spring' && e.confidence === 'medium');
        const utad = [...wy.events].reverse().find(e => e.kind === 'upthrust' && e.confidence === 'medium');
        if (spring) {
            const springCandle = candles.find(c => c.time === spring.time);
            push({
                playbook: 'wyckoff_spring',
                side: 'long',
                confidence: 'medium',
                invalidation: springCandle ? springCandle.low : null,
                evidence: [spring.detail, `range ${r4(wy.range.bottom)}–${r4(wy.range.top)} over ${wy.range.bars} bars`],
                evidence_level: 'documented',
                applies_in: ['range', 'neutral'],
            });
        }
        if (utad) {
            const utadCandle = candles.find(c => c.time === utad.time);
            push({
                playbook: 'wyckoff_utad',
                side: 'short',
                confidence: 'medium',
                invalidation: utadCandle ? utadCandle.high : null,
                evidence: [utad.detail],
                evidence_level: 'documented',
                applies_in: ['range', 'neutral'],
            });
        }
    }

    // 4 ── Liquidity sweep + structure shift (documented): a sweep whose
    //      reversal side matches the last structural break, confirmed or
    //      reclaimed. Invalid = the sweep's extreme wick.
    for (const s of ctx.sweeps.slice(0, 3)) {
        const aligned = ctx.structure?.lastBreak?.direction === s.side;
        if (!aligned || !(s.status === 'confirmed' || s.reclaimed)) continue;
        const long = s.side === 'bullish';
        push({
            playbook: 'sweep_structure_shift',
            side: long ? 'long' : 'short',
            confidence: s.status === 'confirmed' ? 'high' : 'medium',
            invalidation: r4(s.extreme),
            evidence: [`${s.status} sweep of ${s.levelLabel || 'level'} at ${r4(s.level)}`, `structure agrees: ${ctx.structure?.lastBreak?.kind} ${ctx.structure?.lastBreak?.direction}`],
            evidence_level: 'documented',
            applies_in: ['trend', 'neutral', 'range'],
        });
        break; // the freshest aligned sweep is the trade
    }

    // 5 ── Absorption reversal at a level (documented): a high-volume,
    //      no-progress bar (the flow detector's absorption) sitting within
    //      0.5 ATR of a key level, within the last 5 bars → fade the
    //      absorbed side.
    if (ctx.flow) {
        const absorption = [...ctx.flow.events].reverse().find(e => e.kind === 'absorption');
        if (absorption) {
            const bar = candles.find(c => c.time === absorption.time);
            const atLevel = bar !== undefined && ctx.keyLevels.some(lvl => near(lvl, (bar.high + bar.low) / 2, 0.5 * atr));
            const fresh = recentTime - absorption.time <= 5 * 60_000 * (candles.length > 1 ? (candles[candles.length - 1].time - candles[candles.length - 2].time) : 60_000);
            if (bar && atLevel && fresh) {
                const short = absorption.side === 'buy'; // buys absorbed → fade longs
                push({
                    playbook: 'absorption_reversal',
                    side: short ? 'short' : 'long',
                    confidence: 'medium',
                    invalidation: short ? bar.high : bar.low,
                    evidence: [`${absorption.detail} at ~${r4((bar.high + bar.low) / 2)}`, `near a key level (${ctx.keyLevels.map(r4).join(', ')})`],
                    evidence_level: 'documented',
                    applies_in: ['range', 'neutral', 'trend'],
                });
            }
        }
    }

    // 6 ── Trend pullback, Holy-Grail shape (documented): trend regime with
    //      ADX ≥ 30, price pulled back to the 20 EMA within 0.5 ATR, and the
    //      EMA's own slope still agrees → with the trend. Invalid = the
    //      pullback's opposite extreme.
    const reg = ctx.regime;
    if (reg && reg.direction === 'trend' && reg.directionStrength >= 30) {
        const closes = candles.map(c => c.close);
        const ema = emaSeries(closes, 20);
        const emaNow = ema.length ? ema[ema.length - 1] : null;
        if (emaNow !== null && near(last, emaNow, 0.5 * atr) && ema.length > 10) {
            const slope = ema[ema.length - 1] - ema[ema.length - 11];
            if (Math.abs(slope) > 0.05 * atr) {
                const side: 'long' | 'short' = slope > 0 ? 'long' : 'short';
                const swing = side === 'long'
                    ? Math.min(...candles.slice(-5).map(c => c.low))
                    : Math.max(...candles.slice(-5).map(c => c.high));
                push({
                    playbook: 'trend_pullback',
                    side,
                    confidence: 'medium',
                    invalidation: r4(swing),
                    evidence: [`trend regime (ADX ${reg.directionStrength}, dwell ${reg.dwell})`, `close ${r4(last)} at the 20 EMA ${r4(emaNow)}`],
                    evidence_level: 'documented',
                    applies_in: ['trend'],
                });
            }
        }
    }

    // 7 ── Turtle Soup (documented): a close beyond the 20-bar extreme that
    //      the NEXT bar fails — closes back inside → fade. The one-bar
    //      confirmation IS this detection; the aggressive variant (fade the
    //      breakout bar itself) is not detected here.
    if (candles.length >= 22) {
        const prior20 = candles.slice(-22, -2);
        const b = candles[candles.length - 2]; // the breakout bar
        const c = candles[candles.length - 1]; // the failure bar
        const high20 = Math.max(...prior20.map(x => x.high));
        const low20 = Math.min(...prior20.map(x => x.low));
        if (b.close > high20 && c.close < high20) {
            push({
                playbook: 'turtle_soup',
                side: 'short',
                confidence: 'medium',
                invalidation: r4(Math.max(b.high, c.high)),
                evidence: [`closed ${r4(b.close)} above the 20-bar high ${r4(high20)}, next bar closed back inside at ${r4(c.close)}`],
                evidence_level: 'documented',
                applies_in: ['range', 'neutral'],
            });
        }
        if (b.close < low20 && c.close > low20) {
            push({
                playbook: 'turtle_soup',
                side: 'long',
                confidence: 'medium',
                invalidation: r4(Math.min(b.low, c.low)),
                evidence: [`closed ${r4(b.close)} under the 20-bar low ${r4(low20)}, next bar closed back inside at ${r4(c.close)}`],
                evidence_level: 'documented',
                applies_in: ['range', 'neutral'],
            });
        }
    }

    // 8 ── Anchored-VWAP reclaim / rejection (documented): a fresh cross of
    //      the session VWAP (≤2 bars since) → side of the cross; invalid =
    //      VWAP itself.
    const vw = ctx.sessionVwap;
    if (vw && vw.position.barsSinceCross !== null && vw.position.barsSinceCross <= 2) {
        const long = vw.position.side === 'above';
        push({
            playbook: 'vwap_reclaim',
            side: long ? 'long' : 'short',
            confidence: 'medium',
            invalidation: r4(vw.vwap.vwap),
            evidence: [`crossed session VWAP ${r4(vw.vwap.vwap)} ${vw.position.barsSinceCross} bar(s) ago`, `participants ${vw.position.verdict.replace(/_/g, ' ')} (estimate)`],
            evidence_level: 'documented',
            applies_in: ['trend', 'neutral'],
        });
    }

    return matches;
};
