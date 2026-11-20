/**
 * trajectoryExport — ONE RL-ready JSONL artifact joining the three stores that
 * each hold half a decision: the signal ledger (the bracket + its resolution),
 * the diagnosis store (whether the lesson was hindsight-checked clean), and
 * the adversary verdict when one reviewed the plan.
 *
 * THE LEAK RULE is the whole point: `known_at_decision_time` carries ONLY
 * fields that existed before the first bar after emission — the bracket, the
 * dimension stamps, the tape hash, the calibration-era prompt version.
 * `outcome` carries ONLY post-resolution facts. A record with no resolution
 * yet is FILTERED by default; with `includeOpen` it is tagged `"resolved":
 * false` and shipped with the outcome fields ABSENT, never zero-filled — a
 * zero that means "no data" is how a training corpus starts lying.
 */

import { readSignals } from '../signals/signalLedger';
import type { SignalRow } from '../../types/signal';
import { getActiveUsername } from '../../utils/activeUser';

export interface TrajectoryRecord {
    known_at_decision_time: {
        coin: string;
        direction: string;
        entry: number;
        stop: number;
        target: number;
        rr: number | null;
        /** The dimension stamps the emit-time harness derived (skill × regime
         *  × htf × drawings) — the attribution join key. */
        skillSlug: string;
        marketRegime: string;
        htfAligned: 'yes' | 'no' | 'unknown';
        hadUserDrawings: 'yes' | 'no' | 'unknown';
        /** FNV of the tape the app knew at emission (signalService) — the
         *  decision-input fingerprint, not a restatement of it. */
        dataHash: string | null;
        promptVersion: string | null;
        emittedAt: number;
        expiresAt: number;
        /** The adversary reviewer's verdict when one reviewed the plan. */
        adversaryVerdict: string | null;
    };
    outcome?: {
        status: string;
        mfeR: number | null;
        maeR: number | null;
        netR: number | null;
        resolvedAt: number | null;
        hindsightLeakFree: boolean | null;
    };
    /** Present (false) only on `includeOpen` records that have no outcome yet. */
    resolved?: boolean;
}

const HINDSIGHT_REFUSAL = 'no-lesson';

const triState = (v: boolean | undefined): 'yes' | 'no' | 'unknown' =>
    v === true ? 'yes' : v === false ? 'no' : 'unknown';

/** Build ONE record. The leak rule is structural: resolution fields are read
 *  ONLY inside the `outcome` object, and only when the row resolved. */
export const buildTrajectoryRecord = (
    row: SignalRow,
    netRr: number | null,
    diagnosis?: { hindsightRefused: boolean } | null,
): TrajectoryRecord => {
    const s = row.signal;
    const res = row.resolution ?? null;
    const record: TrajectoryRecord = {
        known_at_decision_time: {
            coin: s.coin,
            direction: s.direction as string,
            entry: s.entry,
            stop: s.stop,
            target: s.target,
            rr: netRr,
            skillSlug: (s.skillSlug ?? '').trim() || 'untagged',
            marketRegime: (s.marketRegime ?? '').trim() || 'unknown',
            htfAligned: triState(s.htfAligned),
            hadUserDrawings: triState(s.hadUserDrawings),
            dataHash: s.dataHash ?? null,
            promptVersion: s.promptVersion ?? null,
            emittedAt: s.emittedAt,
            expiresAt: s.expiresAt,
            adversaryVerdict: (s as { adversaryVerdict?: string }).adversaryVerdict ?? null,
        },
    };
    if (res) {
        const r = res as { mfeR?: number; maeR?: number };
        record.outcome = {
            status: row.status,
            mfeR: typeof r.mfeR === 'number' ? r.mfeR : null,
            maeR: typeof r.maeR === 'number' ? r.maeR : null,
            netR: typeof res.outcomeR === 'number' ? res.outcomeR : null,
            resolvedAt: typeof res.at === 'number' ? res.at : null,
            hindsightLeakFree: diagnosis ? diagnosis.hindsightRefused !== true : null,
        };
    }
    return record;
};

export interface TrajectoryExportOptions {
    includeOpen?: boolean;
    user?: string;
}

/** The full JSONL export — oldest-first, one JSON object per line. */
export const exportTrajectoryJsonl = async (
    options: TrajectoryExportOptions = {},
): Promise<{ jsonl: string; count: number; openCount: number }> => {
    const user = options.user ?? getActiveUsername();
    const rows = readSignals(user).slice().sort((a, b) => a.signal.emittedAt - b.signal.emittedAt);
    // Diagnoses join by the tracker's deterministic position id, which for a
    // signal is `signal-<signalId>`. A hindsight-refused diagnosis ("Diagnosis
    // refused: …" / noLesson) marks the record instead of shipping clean.
    let diagnoses: Map<string, { hindsightRefused: boolean }> = new Map();
    try {
        const { readDiagnoses } = await import('../tracking/positionStore');
        const diagRead = await readDiagnoses(user);
        if (diagRead.ok) {
            for (const d of diagRead.value) {
                const refused = d.noLesson === true
                    || String(d.whatHappened).startsWith('Diagnosis refused')
                    || String(d.rootCause).startsWith('Not diagnosed');
                diagnoses.set(d.tradeId, { hindsightRefused: refused });
            }
        }
    } catch {
        diagnoses = new Map();
    }
    const { plannedRiskReward } = await import('../../utils/riskReward');
    const lines: string[] = [];
    let openCount = 0;
    for (const row of rows) {
        const resolved = row.status !== 'open';
        if (!resolved && !options.includeOpen) continue;
        if (!resolved) openCount += 1;
        const rr = plannedRiskReward({
            entry: row.signal.entry,
            stopLoss: row.signal.stop,
            takeProfits: [row.signal.target],
        });
        const diagnosis = diagnoses.get(`signal-${row.signal.id}`) ?? null;
        const record = buildTrajectoryRecord(row, rr !== null && Number.isFinite(rr) ? Number(rr.toFixed(2)) : null, diagnosis);
        if (!resolved && record.outcome === undefined) record.resolved = false;
        lines.push(JSON.stringify(record));
    }
    return { jsonl: lines.join('\n'), count: lines.length, openCount };
};
