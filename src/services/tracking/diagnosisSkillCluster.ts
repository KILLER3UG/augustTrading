/**
 * diagnosisSkillCluster — the pure evidence rule for a post-mortem skill.
 *
 * A lesson is stored on every close; a SKILL is minted only when three
 * INDEPENDENT outcomes agree on the same setup and the same kind of
 * correction. The independence definition is `areIndependentOutcomes`
 * (different trade, non-overlapping holding window, not the same setup on the
 * same PHT day). The cluster key is the setup key plus `primaryChange`; that
 * is the "same trigger" proxy a text model can actually produce consistently,
 * while the skill's prose trigger still comes from the latest diagnosis.
 *
 * A tentative diagnosis (thin tape, a gap, an ambiguous same-candle exit) is
 * never counted. A breakeven is not a win and never counts. This module is
 * pure so those rules can be tested without a notebook or a provider.
 */

import type { CraftedSkill } from '../../schemas/learning';
import type {
    DiagnosisSkillEvidence,
    TrackedDiagnosis,
    TrackedPosition,
    TrackedOutcomeWindow,
} from '../../types/tracking';
import { defaultPrediction } from '../../utils/skillPrediction';
import { stopDistancePercent } from '../../utils/netRiskReward';
import { independentOutcomes, outcomeWindowOf, setupKeyOf } from './positionTracker';

export const MIN_INDEPENDENT_SKILL_OUTCOMES = 3;
export const TENTATIVE_DEMOTE_MIN_SAMPLE = 5;
export const TENTATIVE_DEMOTE_WIN_RATE = 0.4;

export interface TentativeSkillCounts {
    approvedBy?: string;
    wins: number;
    losses: number;
}

/** The auto-demotion rule: a tentative skill that has at least five tracked
 *  outcomes and wins under 40% stops injecting. It is not retired; the
 *  trader can edit, re-approve or delete it. */
export const tentativeDemotion = (meta: TentativeSkillCounts): string | null => {
    if (meta.approvedBy !== 'tentative') return null;
    const n = meta.wins + meta.losses;
    if (n < TENTATIVE_DEMOTE_MIN_SAMPLE) return null;
    const rate = meta.wins / n;
    if (rate >= TENTATIVE_DEMOTE_WIN_RATE) return null;
    return `Auto-demoted after ${n} tracked outcomes: ${meta.wins}W/${meta.losses}L (${(rate * 100).toFixed(0)}% win rate). It stays readable and editable; re-approve it if the sample was unrepresentative.`;
};

export const clusterKeyFor = (position: TrackedPosition, diagnosis: TrackedDiagnosis): string =>
    `${setupKeyOf(position)}|${diagnosis.primaryChange}`;

const evidenceFrom = (
    diagnosis: TrackedDiagnosis,
    position: TrackedPosition,
    regime?: string,
): DiagnosisSkillEvidence | null => {
    if (diagnosis.outcome !== 'win' && diagnosis.outcome !== 'loss') return null;
    return {
        tradeId: position.id,
        outcome: diagnosis.outcome,
        ...(position.exit?.realizedR !== null && position.exit?.realizedR !== undefined
            ? { grossR: position.exit.realizedR }
            : {}),
        ...(position.exit?.netR !== null && position.exit?.netR !== undefined
            ? { netR: position.exit.netR }
            : {}),
        stopDistancePct: stopDistancePercent(position.entry, position.stop),
        at: diagnosis.createdAt,
        setup: {
            coin: position.symbol,
            direction: position.direction === 'long' ? 'Long' : 'Short',
            ...(position.entryContext.family ? { family: position.entryContext.family } : {}),
            ...(regime ? { regime } : {}),
        },
    };
};

export interface ClusterEvidence {
    ready: boolean;
    independentCount: number;
    evidence: DiagnosisSkillEvidence[];
    /** The windows that survived the independence rule, oldest first. */
    windows: TrackedOutcomeWindow[];
    /** Diagnoses on the SAME setup that propose a DIFFERENT kind of
     *  correction. Agreement is only evidence while it is unanimous: one side
     *  of a live disagreement must not become doctrine (E6, the deterioration
     *  guard). */
    dissentCount: number;
    /** Set when the newest dissent is NEWER than the newest agreeing outcome:
     *  the cluster mints nothing until the disagreement resolves one way. */
    blockedReason?: string;
}

export const collectClusterEvidence = (
    diagnoses: readonly TrackedDiagnosis[],
    positions: readonly TrackedPosition[],
    currentDiagnosis: TrackedDiagnosis,
    currentPosition: TrackedPosition,
    regime?: string,
): ClusterEvidence => {
    const key = clusterKeyFor(currentPosition, currentDiagnosis);
    const byId = new Map(positions.map(position => [position.id, position]));
    const candidates: Array<{ diagnosis: TrackedDiagnosis; position: TrackedPosition }> = [];
    const dissent: TrackedDiagnosis[] = [];
    for (const diagnosis of diagnoses) {
        if (diagnosis.refusal || diagnosis.tentative) continue;
        if (diagnosis.outcome !== 'win' && diagnosis.outcome !== 'loss') continue;
        const position = byId.get(diagnosis.tradeId);
        if (!position || position.status === 'cancelled') continue;
        if (setupKeyOf(position) !== setupKeyOf(currentPosition)) continue;
        if (clusterKeyFor(position, diagnosis) !== key) {
            dissent.push(diagnosis);
            continue;
        }
        candidates.push({ diagnosis, position });
    }
    const windows = candidates
        .map(candidate => outcomeWindowOf(candidate.position))
        .filter((window): window is TrackedOutcomeWindow => window !== null);
    const independent = independentOutcomes(windows);
    const independentIds = new Set(independent.map(window => window.id));
    const evidence = candidates
        .filter(candidate => independentIds.has(candidate.position.id))
        .map(candidate => evidenceFrom(candidate.diagnosis, candidate.position, regime))
        .filter((item): item is DiagnosisSkillEvidence => item !== null);
    const newestAgree = candidates.reduce((latest, c) =>
        Math.max(latest, Date.parse(c.diagnosis.createdAt) || 0), 0);
    const newestDissent = dissent.reduce((latest, d) =>
        Math.max(latest, Date.parse(d.createdAt) || 0), 0);
    const contested = dissent.length > 0 && newestDissent > newestAgree;
    return {
        ready: evidence.length >= MIN_INDEPENDENT_SKILL_OUTCOMES && !contested,
        independentCount: evidence.length,
        evidence,
        windows: independent,
        dissentCount: dissent.length,
        ...(contested ? {
            blockedReason: `a newer diagnosis on this setup proposes a different correction (${dissent[dissent.length - 1]?.primaryChange ?? 'other'} vs ${currentDiagnosis.primaryChange}) — the disagreement has to resolve before three outcomes can become a skill`,
        } : {}),
    };
};

/** The skill a cluster earns. The prose comes from the LATEST diagnosis; the
 *  evidence comes from the independent set. */
export const buildTentativeCraft = (
    diagnosis: TrackedDiagnosis,
    evidence: readonly DiagnosisSkillEvidence[],
    position: TrackedPosition,
): CraftedSkill | null => {
    if (evidence.length < MIN_INDEPENDENT_SKILL_OUTCOMES) return null;
    if (diagnosis.outcome !== 'win' && diagnosis.outcome !== 'loss') return null;
    const kind: 'repeat' | 'avoid' = diagnosis.outcome === 'win' ? 'repeat' : 'avoid';
    const shortTrigger = diagnosis.when.trim().replace(/\s+/g, ' ').slice(0, 64);
    const coin = position.symbol;
    const family = position.entryContext.family;
    const regime = evidence[0]?.setup.regime;
    return {
        name: `${kind === 'avoid' ? 'Avoid' : 'Repeat'}: ${shortTrigger}`.slice(0, 78),
        kind,
        description: `Use this skill when ${diagnosis.when.trim()}. ${diagnosis.lesson.trim()} Tentative — learned from ${evidence.length} independent tracked outcomes.`,
        when: diagnosis.when.trim(),
        inputs: ['coin', 'direction', 'timeframe or family'],
        steps: [diagnosis.lesson.trim(), diagnosis.action.trim()].filter(Boolean),
        validate: `the setup still matches: ${diagnosis.when.trim()}`,
        output: diagnosis.action.trim(),
        approval: 'Auto-injected as tentative context; the trader can edit or disable it.',
        reason: `Root cause: ${diagnosis.rootCause.trim()} What happened: ${diagnosis.whatHappened.trim()}`.slice(0, 600),
        source: 'post-mortem',
        prediction: defaultPrediction({ coin, ...(family ? { family } : {}), ...(regime ? { regime } : {}) }),
    };
};

// ─── E7: the forward-fed diagnosis ──────────────────────────────────────────

export interface DiagnosisBrief {
    outcome: TrackedDiagnosis['outcome'];
    primaryChange: string;
    /** The lesson and trigger, clipped — a receipt line, not the full note. */
    lesson: string;
    when: string;
    at: string;
}

const clip = (text: string, max: number): string => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

/** The most recent stored diagnosis for one instrument, in receipt form.
 *  Refusals carry no lesson and are skipped — a "no lesson" is not a lesson.
 *  The caller frames it as REFERENCE ONLY: adopt, improve, or reject. */
export const latestDiagnosisBrief = (
    diagnoses: readonly TrackedDiagnosis[],
    positions: readonly TrackedPosition[],
    symbol: string,
): DiagnosisBrief | null => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return null;
    const byId = new Map(positions.map(position => [position.id, position]));
    const mine = diagnoses
        .filter(d => !d.refusal && byId.get(d.tradeId)?.symbol.toUpperCase() === sym)
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    const latest = mine[0];
    if (!latest) return null;
    return {
        outcome: latest.outcome,
        primaryChange: latest.primaryChange,
        lesson: clip(latest.lesson, 160),
        when: clip(latest.when, 100),
        at: latest.createdAt,
    };
};

/** The prompt-facing block for an instrument's last stored diagnosis, or ''
 *  when none is stored or the store is unreadable — the same posture as the
 *  emit_signal receipt's `previousDiagnosis`, extended to the ordinary desk
 *  read (the lesson the loop already earned must not be visible ONLY when
 *  the seat happens to emit a signal). Refusals are skipped by
 *  `latestDiagnosisBrief` (a "no lesson" is not a lesson); a read failure
 *  costs the block, never the turn, and never fabricates one.
 *
 *  The framing is the receipt's own words — REFERENCE ONLY, adopt/improve/
 *  reject — because a diagnosis that reads as a rule would be a second veto
 *  path, and a tentative-skill rule must never veto or cap anything. */
export const diagnosisBriefBlock = async (symbol: string): Promise<string> => {
    const sym = (symbol || '').trim().toUpperCase();
    if (!sym) return '';
    try {
        const { getActiveUsername } = await import('../../utils/activeUser');
        const { readDiagnoses, readTrackedPositions } = await import('./positionStore');
        const user = getActiveUsername();
        const [diagRead, posRead] = await Promise.all([readDiagnoses(user), readTrackedPositions(user)]);
        if (!diagRead.ok || !posRead.ok) return '';
        const brief = latestDiagnosisBrief(diagRead.value, posRead.value, sym);
        if (!brief) return '';
        return [
            `## Post-mortem context — the last recorded lesson on ${sym} (REFERENCE ONLY: adopt it, improve it, or reject it in your own read; never a rule, a veto or a confidence cap)`,
            `- Outcome: ${brief.outcome} · diagnosed ${brief.at}`,
            `- What changed: ${brief.primaryChange}`,
            `- Lesson: ${brief.lesson}`,
            brief.when ? `- Applies when: ${brief.when}` : '',
        ].filter(Boolean).join('\n');
    } catch {
        return '';
    }
};
