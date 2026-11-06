/**
 * diagnosisBrief — the one read that carries a stored post-mortem forward.
 *
 * The tracked-position loop writes a diagnosis on every close
 * (`postMortemDiagnosis.ts`). This module is the OTHER half: the last recorded
 * lesson on an instrument, fed into the next read of that instrument — the
 * ordinary dock answer, the pipeline's context bundle, and the `emit_signal`
 * receipt — so the loop's memory reaches the model instead of sitting in a
 * journal nobody re-opens.
 *
 * It mints nothing. It was a section of `diagnosisSkillCluster.ts`, which also
 * held the rule that turned three outcomes into a tentative skill; that
 * lifecycle is deleted (2026-11-05, owner ruling: a skill is a document written
 * by `skill_write` or by the trader) and this read is all that survived of it.
 *
 * Three rules the callers depend on:
 *   - a REFUSED diagnosis carries no lesson and is skipped — "no lesson" is not
 *     a lesson, and quoting one would invent a memory;
 *   - the block is framed REFERENCE ONLY, in the receipt's own words, because a
 *     diagnosis that reads as a rule would be a second veto path;
 *   - a failed store read costs the section, never the turn.
 */

import type { TrackedDiagnosis, TrackedPosition } from '../../types/tracking';

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

/** The most recent stored diagnosis for one instrument, in receipt form. */
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
 *  when none is stored or the store is unreadable. */
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
