/**
 * Zod boundaries for the tracked position and its post-mortem.
 *
 * Two shapes, on purpose:
 *  · `TrackedDiagnosisAnswerSchema` is what the MODEL returns. It has no id,
 *    no timestamps and no provenance — those are written by the app, and a
 *    model that invents an id must not be able to address a row.
 *  · `TrackedDiagnosisSchema` is what the STORE holds: the answer plus the
 *    app's provenance and the audit hash.
 *
 * The answer is lenient in the same places the settlement reflection is:
 * over-long prose is sliced (the reader's caps are the source of truth), a
 * missing `confidence` falls back rather than losing the whole diagnosis, and
 * `{"noLesson": true}` is an honest decline that writes nothing. A malformed
 * answer is null, never a fabricated lesson.
 */

import { z } from 'zod';
import type { TrackedDiagnosis, TrackedPosition } from '../types/tracking';

const sliced = (max: number) => (v: unknown) => (typeof v === 'string' ? v.slice(0, max) : v);

export const DiagnosisOutcomeSchema = z.enum(['win', 'loss', 'breakeven']);
export const DiagnosisChangeSchema = z.enum(['entry', 'stop', 'target', 'sizing', 'skip', 'hold']);
export const DiagnosisRefusalSchema = z.enum(['thin-tape', 'no-lesson', 'malformed']);

/** The model's answer. `when`/`action` are the existing skill parser's
 *  vocabulary; they are required because a diagnosis the skill loop cannot
 *  read is a diary entry, not a lesson. */
export const TrackedDiagnosisAnswerSchema = z.object({
    outcome: DiagnosisOutcomeSchema.catch('breakeven'),
    whatHappened: z.preprocess(sliced(1200), z.string().min(20)),
    rootCause: z.preprocess(sliced(600), z.string().min(10)),
    // "No change" is a valid answer, so the floor is low; the diagnosis may
    // legitimately say the execution was right.
    whatShouldHaveBeenDone: z.preprocess(sliced(600), z.string().min(4)),
    primaryChange: DiagnosisChangeSchema.catch('hold'),
    lesson: z.preprocess(sliced(400), z.string().min(10)),
    when: z.preprocess(sliced(240), z.string().min(12)),
    action: z.preprocess(sliced(240), z.string().min(12)),
    confidence: z.number().min(0).max(100).catch(50),
    evidenceRefs: z.array(z.string().max(200)).max(12).default([]),
    noLesson: z.preprocess(
        (v) => (v === true || v === 'true' || v === 'yes' ? true : v),
        z.boolean().optional().catch(undefined),
    ),
});

export type ValidatedTrackedDiagnosisAnswer = z.infer<typeof TrackedDiagnosisAnswerSchema>;

/** The stored diagnosis: the answer plus the app's provenance. */
export const TrackedDiagnosisSchema = TrackedDiagnosisAnswerSchema.extend({
    id: z.string().min(1).max(120),
    tradeId: z.string().min(1).max(120),
    source: z.enum(['signal', 'journal']),
    modelOutcome: DiagnosisOutcomeSchema.optional(),
    evidenceCount: z.number().int().min(0).max(10000).default(0),
    model: z.string().max(120).optional(),
    provider: z.string().max(120).optional(),
    promptVersion: z.string().max(120).optional(),
    packetHash: z.string().max(64).optional(),
    createdAt: z.string().min(1),
    tentative: z.boolean().default(true),
    refusal: DiagnosisRefusalSchema.optional(),
});

export const parseTrackedDiagnosisAnswer = (raw: unknown): ValidatedTrackedDiagnosisAnswer | null => {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).diagnosis ?? raw
        : raw;
    // Detect the decline shape BEFORE the required fields, or the honest
    // "nothing to teach" is misreported as a malformed answer.
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const flag = (obj as Record<string, unknown>).noLesson;
        if (flag === true || flag === 'true' || flag === 'yes') return null;
    }
    const result = TrackedDiagnosisAnswerSchema.safeParse(obj);
    return result.success ? result.data : null;
};

export const parseTrackedDiagnosis = (raw: unknown): TrackedDiagnosis | null => {
    const result = TrackedDiagnosisSchema.safeParse(raw);
    return result.success ? (result.data as TrackedDiagnosis) : null;
};

/**
 * A persisted position is filtered, not fatal: one corrupt row must not take
 * the whole tracker store down. Only the fields the tracker cannot operate
 * without are required; unknown/future fields pass through untouched.
 */
export const TrackedPositionSchema = z.looseObject({
    id: z.string().min(1).max(120),
    source: z.enum(['signal', 'journal']),
    sourceId: z.string().min(1).max(200),
    symbol: z.string().min(1).max(40),
    direction: z.enum(['long', 'short']),
    entry: z.number().finite().positive(),
    stop: z.number().finite().positive(),
    targets: z.array(z.number().finite().positive()).min(1).max(8),
    status: z.enum(['pending_entry', 'open', 'closed', 'expired', 'cancelled']),
    openedAt: z.number().int().nonnegative(),
    version: z.literal(1),
});

export const parseTrackedPosition = (raw: unknown): TrackedPosition | null => {
    const result = TrackedPositionSchema.safeParse(raw);
    if (!result.success) return null;
    // The schema validates the load-bearing fields; the rest of the shape is
    // the type's contract and is preserved as stored.
    return result.data as unknown as TrackedPosition;
};
