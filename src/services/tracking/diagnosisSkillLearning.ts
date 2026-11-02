/**
 * diagnosisSkillLearning — turns diagnoses into tentative skills.
 *
 * The three-outcome rule and the independence definition live in the pure
 * `diagnosisSkillCluster`; this module only reads the stores and hands the
 * result to the notebook's ONE tentative ingest. It runs AFTER the diagnosis
 * is stored and BEFORE the journal's notebook sync, so a new tentative skill
 * exists when the legacy draft gates look for coverage.
 */

import type { TrackedDiagnosis, TrackedPosition } from '../../types/tracking';
import { readDiagnoses, readTrackedPositions } from './positionStore';
import { readJournalTrade } from './journalOutcomeBridge';
import { buildTentativeCraft, collectClusterEvidence } from './diagnosisSkillCluster';
import { ingestTentativeSkillFromEvidence } from '../learning/SkillMemoryService';

export interface DiagnosisLearningResult {
    ready: boolean;
    evidence: number;
    created: boolean;
    reason?: string;
}

export const learnFromDiagnosis = async (
    username: string,
    diagnosis: TrackedDiagnosis,
    position: TrackedPosition,
): Promise<DiagnosisLearningResult> => {
    if (diagnosis.refusal || diagnosis.tentative || diagnosis.outcome === 'breakeven') {
        return { ready: false, evidence: 0, created: false };
    }
    const diagnoses = await readDiagnoses(username);
    if (!diagnoses.ok) return { ready: false, evidence: 0, created: false, reason: diagnoses.error };
    const positions = await readTrackedPositions(username);
    if (!positions.ok) return { ready: false, evidence: 0, created: false, reason: positions.error };

    const regime = position.source === 'journal'
        ? readJournalTrade(position.sourceId)?.marketRegime
        : undefined;
    const cluster = collectClusterEvidence(
        diagnoses.value,
        positions.value,
        diagnosis,
        position,
        regime,
    );
    if (!cluster.ready) {
        return { ready: false, evidence: cluster.independentCount, created: false };
    }
    const crafted = buildTentativeCraft(diagnosis, cluster.evidence, position);
    if (!crafted) return { ready: true, evidence: cluster.independentCount, created: false };
    const result = await ingestTentativeSkillFromEvidence(crafted, cluster.evidence, username);
    return {
        ready: true,
        evidence: cluster.independentCount,
        created: result.created || result.reason === 'duplicate',
        ...(result.created ? {} : { reason: result.reason }),
    };
};
