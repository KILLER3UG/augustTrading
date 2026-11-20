import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveSignal,
    SIGNAL_BAR_MS,
    type SignalCandle,
} from '../src/services/signals/signalResolver';
import { calibrateByDimensions } from '../src/services/signals/signalCalibration';
import { scoreSignals } from '../src/services/signals/signalAccuracy';
import { scoreDrawnShape } from '../src/services/trade/tradePlanLevels';
import {
    auditPostMortemForHindsightLeak,
    diagnosisPacket,
    KNOWN_AT_DECISION_HEADER,
    SUBSEQUENT_PRICE_PATH_HEADER,
} from '../src/services/tracking/diagnosisPacket';
import {
    checkProfileBiasPromotionEligibility,
    checkRulePromotionEligibility,
    MIN_PROFILE_BIAS_EVIDENCE,
    MIN_PROFILE_BIAS_SESSIONS,
} from '../src/services/learning/candidateRuleLoop';
import type { SignalRow } from '../src/types/signal';
import type { ChartDrawing } from '../src/services/trade/chartDrawings';
import type { TrackedPosition } from '../src/types/tracking';

const T0 = 1_700_000_000_000;

const bar = (idx: number, open: number, high: number, low: number, close: number): SignalCandle => ({
    time: T0 + idx * SIGNAL_BAR_MS,
    open,
    high,
    low,
    close,
});

describe('Phase 4: SignalResolver deterministic MFE/MAE & conservative ambiguity', () => {
    it('computes deterministic mfeR (>=0) and maeR (<=0) over the held window for a winning long', () => {
        const signal = {
            direction: 'long' as const,
            entry: 100,
            stop: 95,   // risk = 5
            target: 110, // +2R
            emittedAt: T0,
            expiresAt: T0 + 10 * SIGNAL_BAR_MS,
        };
        const bars = [
            bar(0, 102, 103, 99.5, 101),  // triggers entry=100; low=99.5 -> -0.1R; high=103 -> +0.6R
            bar(1, 101, 104, 97.5, 103),  // dips to 97.5 -> -0.5R; high=104 -> +0.8R
            bar(2, 103, 112, 102, 111),   // hits target=110 (capped at +2R)
        ];
        const draft = resolveSignal(signal, bars, [], T0 + 10 * SIGNAL_BAR_MS);
        assert.ok(draft);
        assert.equal(draft.status, 'won');
        assert.equal(draft.mfeR, 2);
        assert.equal(draft.maeR, -0.5);
    });

    it('handles ambiguous same-bar SL/TP conservatively (stop-first: maeR=-1, does NOT credit ambiguous bar target overshoot)', () => {
        const signal = {
            direction: 'long' as const,
            entry: 100,
            stop: 95,
            target: 110,
            emittedAt: T0,
            expiresAt: T0 + 10 * SIGNAL_BAR_MS,
        };
        const bars = [
            bar(0, 101, 102, 99, 101),    // triggers entry; max fav = +0.4R, mae = -0.2R
            bar(1, 101, 115, 92, 105),    // touches BOTH target (110) and stop (95) with no 1m drill
        ];
        const draft = resolveSignal(signal, bars, [], T0 + 10 * SIGNAL_BAR_MS);
        assert.ok(draft);
        assert.equal(draft.status, 'lost');
        assert.equal(draft.ambiguous, true);
        assert.equal(draft.maeR, -1);
        assert.equal(draft.mfeR, 0.4); // strictly from bar 0, NOT +2R from the ambiguous bar!
    });

    it('omits mfeR/maeR on never_triggered signals', () => {
        const signal = {
            direction: 'long' as const,
            entry: 100,
            stop: 95,
            target: 110,
            emittedAt: T0,
            expiresAt: T0 + 3 * SIGNAL_BAR_MS,
        };
        const bars = [bar(0, 105, 108, 104, 106), bar(1, 106, 109, 105, 107)];
        const draft = resolveSignal(signal, bars, [], T0 + 4 * SIGNAL_BAR_MS);
        assert.ok(draft);
        assert.equal(draft.status, 'never_triggered');
        assert.equal(draft.mfeR, undefined);
        assert.equal(draft.maeR, undefined);
    });
});

describe('Phase 4: Generalized Drawing Respect (scoreDrawnShape)', () => {
    it('scores diagonal trendlines and rectangle zones using post-creation bars only', () => {
        const startSec = 1_700_000_000;
        const step = 900;
        // 8 bars: trendline goes from bar 0 (100) to bar 2 (102) -> +1 per bar.
        // At bar 5, projected price = 105.
        const candles = Array.from({ length: 8 }, (_, i) => ({
            time: startSec + i * step,
            open: 100 + i,
            high: i === 5 ? 105.5 : 102,
            low: i === 5 ? 104.5 : 101,
            close: 101.5,
        }));

        const trend: ChartDrawing = {
            id: 't1',
            shortId: '#D1',
            kind: 'trend',
            origin: 'agent',
            color: '#a1a1aa',
            createdAt: (startSec + 2 * step) * 1000,
            points: [
                { t: startSec, p: 100 },
                { t: startSec + 2 * step, p: 102 },
            ],
        };
        const trendScore = scoreDrawnShape(trend, candles, { barSeconds: step, minBars: 3 });
        assert.equal(trendScore.verdict, 'touched');
        assert.equal(trendScore.missPct, 0);
        assert.equal(trendScore.barsSince, 6);

        // Rectangle zone [120, 125] untouched by bars [101..105.5]
        const rect: ChartDrawing = {
            id: 'r1',
            shortId: '#D2',
            kind: 'rect',
            origin: 'agent',
            color: '#a1a1aa',
            createdAt: (startSec + 2 * step) * 1000,
            points: [
                { t: startSec, p: 120 },
                { t: startSec + 2 * step, p: 125 },
            ],
        };
        const rectScore = scoreDrawnShape(rect, candles, { barSeconds: step, minBars: 3 });
        assert.equal(rectScore.verdict, 'untouched');
        assert.ok(rectScore.missPct > 10);
    });
});

describe('Phase 4: Grouped Calibration Rollups (skill × regime × HTF × drawings)', () => {
    const mkRow = (overrides: {
        id: string;
        status: 'won' | 'lost';
        outcomeR: number;
        mfeR: number;
        maeR: number;
        skillSlug?: string;
        marketRegime?: string;
        htfAligned?: boolean;
        hadUserDrawings?: boolean;
    }): SignalRow => ({
        status: overrides.status,
        signal: {
            id: overrides.id,
            coin: 'BTC',
            direction: 'long',
            entry: 100,
            stop: 95,
            target: 110,
            emittedAt: T0,
            expiresAt: T0 + 10 * SIGNAL_BAR_MS,
            evidenceRefs: ['get_chart_view'],
            dataHash: 'abc',
            provider: 'test',
            model: 'test',
            promptVersion: 'v1',
            source: 'signal',
            thesis: 'Breakout retest',
            skillSlug: overrides.skillSlug,
            marketRegime: overrides.marketRegime,
            htfAligned: overrides.htfAligned,
            hadUserDrawings: overrides.hadUserDrawings,
        },
        resolution: {
            status: overrides.status,
            at: T0 + 5 * SIGNAL_BAR_MS,
            grossR: overrides.outcomeR + 0.05,
            feeR: 0.05,
            outcomeR: overrides.outcomeR,
            usedBarTimes: [T0],
            path: 'bar',
            ambiguous: false,
            crossCheck: 'agree',
            primarySource: 'okx',
            mfeR: overrides.mfeR,
            maeR: overrides.maeR,
        },
    });

    it('aggregates hitRate, expectancyR, and mean/median MFE/MAE by dimensions', () => {
        const rows: SignalRow[] = [
            mkRow({ id: 's1', status: 'won', outcomeR: 1.9, mfeR: 2.0, maeR: -0.2, skillSlug: 'sr-retest', marketRegime: 'trending', htfAligned: true, hadUserDrawings: true }),
            mkRow({ id: 's2', status: 'won', outcomeR: 2.1, mfeR: 2.2, maeR: -0.4, skillSlug: 'sr-retest', marketRegime: 'trending', htfAligned: true, hadUserDrawings: true }),
            mkRow({ id: 's3', status: 'lost', outcomeR: -1.0, mfeR: 0.6, maeR: -1.0, skillSlug: 'sr-retest', marketRegime: 'trending', htfAligned: true, hadUserDrawings: true }),
            mkRow({ id: 's4', status: 'lost', outcomeR: -1.0, mfeR: 0.1, maeR: -1.0, skillSlug: 'mean-rev', marketRegime: 'ranging', htfAligned: false, hadUserDrawings: false }),
        ];

        const buckets = calibrateByDimensions(rows);
        assert.equal(buckets.length, 2);
        const top = buckets[0];
        assert.equal(top.skillSlug, 'sr-retest');
        assert.equal(top.marketRegime, 'trending');
        assert.equal(top.htfAligned, 'yes');
        assert.equal(top.hadUserDrawings, 'yes');
        assert.equal(top.fills, 3);
        assert.equal(top.wins, 2);
        assert.ok(Math.abs((top.hitRate ?? 0) - 2 / 3) < 1e-6);
        assert.ok(Math.abs((top.expectancyR ?? 0) - 1.0) < 1e-6);
        assert.equal(top.medianMfeR, 2.0);
        assert.equal(top.medianMaeR, -0.4);

        const scorecard = scoreSignals(rows);
        assert.ok(scorecard.meanMfeR !== null && scorecard.meanMfeR! > 1);
        assert.ok(scorecard.meanMaeR !== null && scorecard.meanMaeR! < 0);
    });
});

describe('Phase 4: Post-Mortem Hindsight Separation & Profile Bias Promotion Gate', () => {
    it('delimits diagnosisPacket into KNOWN_AT_DECISION_TIME and SUBSEQUENT_PRICE_PATH and catches hindsight leaks', () => {
        const position: TrackedPosition = {
            id: 'tp-1',
            source: 'signal',
            sourceId: 'sig-1',
            symbol: 'BTCUSDT',
            direction: 'long',
            status: 'closed',
            entry: 100,
            stop: 95,
            targets: [110],
            openedAt: T0,
            closedAt: T0 + 4 * SIGNAL_BAR_MS,
            entryConfirmed: true,
            entryBarTime: T0,
            barsRead: 10,
            gaps: [],
            tapeCoversWindow: true,
            mfeR: 1.4,
            mfePrice: 107,
            mfeAt: T0 + 2 * SIGNAL_BAR_MS,
            maeR: -1.0,
            maePrice: 95,
            maeAt: T0 + 4 * SIGNAL_BAR_MS,
            exit: {
                reason: 'stop',
                price: 95,
                at: T0 + 4 * SIGNAL_BAR_MS,
                sameCandle: 'single-level',
                ambiguous: false,
                gapAtOpen: false,
                barsRead: 10,
                realizedR: -1,
                costR: 0.04,
                netR: -1.04,
                slippageModeled: false,
            },
            entryContext: {
                thesis: 'HTF uptrend pullback to 4H support',
                evidenceRefs: ['get_chart_view'],
                provider: 'test',
                model: 'test',
            },
            context: [],
            timeline: [],
            cursor: { lastClosedBarTime: T0 + 4 * SIGNAL_BAR_MS, timeframe: '5m' },
            timelineDownsampled: false,
            timelinePointsDropped: 0,
            contextDownsampled: false,
            version: 1,
        };

        const packet = diagnosisPacket({ position, outcome: 'loss', context: [] });
        const idxKnown = packet.indexOf(KNOWN_AT_DECISION_HEADER);
        const idxSub = packet.indexOf(SUBSEQUENT_PRICE_PATH_HEADER);
        assert.ok(idxKnown >= 0);
        assert.ok(idxSub > idxKnown);

        const knownSection = packet.slice(idxKnown, idxSub);
        const subSection = packet.slice(idxSub);
        assert.match(knownSection, /LEVELS:/);
        assert.match(knownSection, /ENTRY CONTEXT:/);
        assert.doesNotMatch(knownSection, /EXCURSION:/);
        assert.match(subSection, /OUTCOME \(authoritative\):/);
        assert.match(subSection, /EXCURSION: MFE/);

        // Clean forward lesson passes
        const clean = auditPostMortemForHindsightLeak({
            when: 'HTF regime is ranging and stop distance is below 0.5 ATR',
            action: 'skip the breakout entry or widen stop past swing low',
            lesson: 'Require HTF alignment and >= 0.8 ATR stop buffer before entry.',
        });
        assert.equal(clean.leaked, false);

        // Hindsight-contaminated forward rule is flagged
        const leaked = auditPostMortemForHindsightLeak({
            when: 'price gets wicked out right before reversing after MFE reaches +1.4R',
            action: 'move stop wider after entry',
            lesson: 'Should have held through the MAE dip.',
        });
        assert.equal(leaked.leaked, true);
        assert.ok(leaked.matches.length >= 2);
    });

    it('gates persistent trader-profile bias promotion on >=3 evidence across >=3 sessions and trader confirmation for risk rules', () => {
        // Preserve existing rule-loop contract verbatim
        const existingSingleTrade = checkRulePromotionEligibility({
            tradeIds: ['t1'],
            when: 'HTF regime ranging',
            action: 'skip',
            knowableAtEntry: ['regime at entry: ranging'],
        });
        assert.equal(existingSingleTrade.ok, false);

        // Fewer than 3 evidence items refused
        const tooFewEvidence = checkProfileBiasPromotionEligibility({
            evidenceIds: ['e1', 'e2'],
            sessionIds: ['2026-11-18', '2026-11-19', '2026-11-20'],
            biasStatement: 'Avoid counter-trend longs in bearish 4H regime',
            knowableAtEntry: ['4H regime bearish'],
        });
        assert.equal(tooFewEvidence.ok, false);
        assert.match(tooFewEvidence.refused, new RegExp(`>= ${MIN_PROFILE_BIAS_EVIDENCE}`));

        // Fewer than 3 distinct sessions refused
        const tooFewSessions = checkProfileBiasPromotionEligibility({
            evidenceIds: ['e1', 'e2', 'e3'],
            sessionIds: ['2026-11-19', '2026-11-20'],
            biasStatement: 'Avoid counter-trend longs in bearish 4H regime',
            knowableAtEntry: ['4H regime bearish'],
        });
        assert.equal(tooFewSessions.ok, false);
        assert.match(tooFewSessions.refused, new RegExp(`>= ${MIN_PROFILE_BIAS_SESSIONS}`));

        // Risk-rule modification without trader confirmation refused with requiresTraderConfirmation
        const unconfirmedRisk = checkProfileBiasPromotionEligibility({
            evidenceIds: ['e1', 'e2', 'e3'],
            sessionIds: ['s1', 's2', 's3'],
            biasStatement: 'Cap risk per trade at 0.5% during high-volatility sessions',
            knowableAtEntry: ['ATR > 2%'],
            affectsRiskRules: true,
            traderConfirmed: false,
        });
        assert.equal(unconfirmedRisk.ok, false);
        assert.equal(unconfirmedRisk.requiresTraderConfirmation, true);

        // Confirmed risk-rule bias with >=3 evidence across >=3 distinct sessions passes
        const approved = checkProfileBiasPromotionEligibility({
            evidenceIds: ['e1', 'e2', 'e3'],
            sessionIds: ['s1', 's2', 's3'],
            biasStatement: 'Cap risk per trade at 0.5% during high-volatility sessions',
            knowableAtEntry: ['ATR > 2%'],
            affectsRiskRules: true,
            traderConfirmed: true,
        });
        assert.equal(approved.ok, true);
    });
});
