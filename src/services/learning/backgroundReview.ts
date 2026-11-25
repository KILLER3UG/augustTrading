/**
 * backgroundReview — the NON-BLOCKING post-turn review.
 *
 * After a substantive turn, a background pass looks for the four Hermes
 * learning signals and may propose writes to the two bounded memory files or
 * a probation skill — and NOTHING else. The pass is strictly OFF the live
 * streaming critical path: callers fire it without awaiting it, and it never
 * touches the wire, the trade log, the ledger, or code. Every write it makes
 * goes through the same receipted tools the seat uses, so the trader can
 * undo it.
 *
 * 100% offline-testable: signal detection is pure, and the write boundary is
 * enforced against an injected emitter whose allowed tool set is pinned here.
 */

import { formatAutopsyForPrompt, type ExecutionAutopsyReport } from './executionAutopsyCore';

export const BACKGROUND_REVIEW_MIN_TOOL_CALLS = 4;

/**
 * The correction cues that make a turn worth reviewing even without tool
 * activity: the trader pushed back. Deliberately conservative — a comma
 * after "no" or an explicit "wrong/instead/don't" is a correction; a bare
 * "no" as an answer to a question is not enough on its own.
 */
export const CORRECTION_CUE_RE =
    /(?:\bno,\s*|\bremember[:,]\s*|\b(?:not\s+quite|that'?s\s+(?:wrong|incorrect|not\s+what)|wrong|incorrect|don'?t|do\s+not|stop\s+(?:doing|saving|writing|adding)|i\s+(?:said|told\s+you|already\s+said)|as\s+i\s+said|correction|mistake|instead|too\s+(?:verbose|long|short|wordy)|be\s+(?:brief|concise))\b)/i;

export type BackgroundReviewSignal =
    | 'style_or_risk_correction'
    | 'workflow_correction'
    | 'reusable_setup'
    | 'skill_gap';

export interface BackgroundReviewInput {
    /** Tool calls the turn made (the loop's count). */
    toolCallCount: number;
    /** The trader's raw message this turn. */
    userMessage: string;
    /** The assistant's answer (for the reusable-setup detector). */
    assistantMessage?: string;
    /** Skill slugs the turn actually loaded/invoked. */
    skillsUsed?: string[];
    /** Settings switch. */
    enabled: boolean;
    /** The session the turn ran in — stamped onto created skills. */
    sourceSessionId?: string;
    /** Injectable clock for date stamps (defaults to now). */
    nowMs?: number;
    /** Optional deterministic MFE/MAE autopsy report — emits a bounded memory leak note when sufficientSample & findings exist. */
    autopsy?: ExecutionAutopsyReport;
}

export interface DetectedSignal {
    signal: BackgroundReviewSignal;
    evidence: string;
}

/**
 * The trigger heuristic. Fires when the turn was substantive (>= 4 tool
 * calls) OR the trader's message carries an explicit correction cue — and
 * only when the feature is enabled.
 */
export const shouldRunBackgroundReview = (input: BackgroundReviewInput): boolean => {
    if (!input?.enabled) return false;
    if (Number.isFinite(input.toolCallCount) && input.toolCallCount >= BACKGROUND_REVIEW_MIN_TOOL_CALLS) return true;
    return CORRECTION_CUE_RE.test(input.userMessage ?? '');
};

const STYLE_RISK_RE = /\b(risk|leverage|sizing|size|position|verbose|brief|concise|format|style|tone|shorter|longer|wording)\b/i;
const WORKFLOW_RE = /\b(order|workflow|process|step|sequence|first|then|before|after|instead|procedure|should\s+have\s+called|wrong\s+tool)\b/i;
const SETUP_SHAPE_RE = /\b(entry|stop(?:\s*loss)?|take\s*profit|target|invalidation|setup|playbook|checklist)\b/gi;

/**
 * The four Hermes signals, detected deterministically from the turn's own
 * words — no model call, so the review pass costs nothing and cannot invent.
 */
export const detectLearningSignals = (input: BackgroundReviewInput): DetectedSignal[] => {
    const out: DetectedSignal[] = [];
    const user = input.userMessage ?? '';
    const correction = CORRECTION_CUE_RE.test(user);
    if (correction && STYLE_RISK_RE.test(user)) {
        out.push({ signal: 'style_or_risk_correction', evidence: `correction cue + risk/style vocabulary in: "${user.slice(0, 160)}"` });
    }
    if (correction && WORKFLOW_RE.test(user)) {
        out.push({ signal: 'workflow_correction', evidence: `correction cue + workflow vocabulary in: "${user.slice(0, 160)}"` });
    }
    const assistant = input.assistantMessage ?? '';
    const setupHits = assistant.match(SETUP_SHAPE_RE)?.length ?? 0;
    const stepCues = (assistant.match(/\b(?:1\.|2\.|3\.|first|then|next|finally)\b/gi) ?? []).length;
    if (setupHits >= 3 && stepCues >= 2) {
        out.push({ signal: 'reusable_setup', evidence: `answer carries ${setupHits} plan elements across ${stepCues} ordered steps — candidate playbook` });
    }
    if ((input.skillsUsed?.length ?? 0) > 0 && correction) {
        out.push({ signal: 'skill_gap', evidence: `loaded skill(s) ${input.skillsUsed!.join(', ')} and the trader still corrected the turn` });
    }
    return out;
};

/** The ONLY tools a background review may emit. Enforced, not advisory. */
export const BACKGROUND_REVIEW_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['memory', 'skill_manage']);

export interface BackgroundReviewEmission {
    tool: string;
    args: Record<string, unknown>;
    /** Filled by the emitter on success — the receipt's undo handle. */
    undoSnapshot?: unknown;
}

export interface BackgroundReviewReceipt {
    ran: boolean;
    trigger: 'tool_calls' | 'correction_cue' | 'both' | 'disabled' | 'not_substantive';
    signals: DetectedSignal[];
    emissions: BackgroundReviewEmission[];
    refused: Array<{ tool: string; reason: string }>;
    notes: string[];
}

export interface BackgroundReviewDeps {
    /**
     * Apply one proposed write. The review calls this ONLY with a whitelisted
     * tool; the REAL implementation routes to the memory/skill_manage
     * executors and returns their receipt (undoSnapshot included).
     */
    emit: (emission: BackgroundReviewEmission) => Promise<{ ok: boolean; undoSnapshot?: unknown; error?: string }>;
    /** Injectable clock. */
    nowMs?: number;
}

const memoryArgsFor = (signal: DetectedSignal, input: BackgroundReviewInput): Record<string, unknown> | null => {
    const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
    const cue = (input.userMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    switch (signal.signal) {
        case 'style_or_risk_correction':
            return {
                target: 'user',
                operations: [{ action: 'add', content: `Style/risk correction (${day}): the trader corrected how I framed or sized a read — "${cue}". Apply this framing from now on.` }],
            };
        case 'workflow_correction':
            return {
                target: 'memory',
                operations: [{ action: 'add', content: `Workflow correction (${day}): "${cue}". Follow the trader's stated order of operations next time.` }],
            };
        case 'skill_gap':
            return {
                target: 'memory',
                operations: [{ action: 'add', content: `Skill gap (${day}): the loaded skill did not prevent this correction — "${cue}". Check the matching skill before answering a similar question.` }],
            };
        default:
            return null;
    }
};

/**
 * Run the post-turn review. Returns a receipt even when it does nothing, so
 * the caller can log why. Never throws for a refused write — refusals are
 * recorded. NEVER mutates signal_ledger, trades, or code: the emitter is
 * invoked only with `memory` / `skill_manage` args, and anything else is
 * refused here before the emitter ever sees it.
 */
export const runBackgroundReview = async (
    input: BackgroundReviewInput,
    deps: BackgroundReviewDeps,
): Promise<BackgroundReviewReceipt> => {
    const toolSubstantive = Number.isFinite(input.toolCallCount) && input.toolCallCount >= BACKGROUND_REVIEW_MIN_TOOL_CALLS;
    const cue = CORRECTION_CUE_RE.test(input.userMessage ?? '');
    const trigger: BackgroundReviewReceipt['trigger'] =
        !input.enabled ? 'disabled'
            : toolSubstantive && cue ? 'both'
                : toolSubstantive ? 'tool_calls'
                    : cue ? 'correction_cue'
                        : 'not_substantive';
    if (trigger === 'disabled' || trigger === 'not_substantive') {
        return { ran: false, trigger, signals: [], emissions: [], refused: [], notes: [] };
    }
    const signals = detectLearningSignals(input);
    const hasAutopsy = Boolean(input.autopsy?.sufficientSample && input.autopsy.findings.length > 0);
    if (signals.length === 0 && !hasAutopsy) {
        return { ran: true, trigger, signals: [], emissions: [], refused: [], notes: ['No learning signal in this turn — nothing written.'] };
    }
    const emissions: BackgroundReviewEmission[] = [];
    const refused: BackgroundReviewReceipt['refused'] = [];
    const notes: string[] = [];
    if (hasAutopsy && input.autopsy) {
        const verdict = await applyEmission(
            {
                tool: 'memory',
                args: {
                    target: 'memory',
                    operations: [{ action: 'add', content: formatAutopsyForPrompt(input.autopsy) }],
                },
            },
            deps,
            emissions,
            refused,
        );
        if (verdict) notes.push('Recorded execution autopsy finding to MEMORY.md.');
    }
    for (const signal of signals) {
        if (signal.signal === 'reusable_setup') {
            // A reusable setup becomes a PROBATION skill, never a memory rule.
            const emission: BackgroundReviewEmission = {
                tool: 'skill_manage',
                args: {
                    action: 'create',
                    slug: `reusable-setup-${new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10)}`,
                    name: 'Reusable setup (background review)',
                    description: `Emerging multi-step setup observed on ${new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10)} — probation until the ledger verifies it.`,
                    source_session_id: input.sourceSessionId,
                    body: [
                        '## When to Use',
                        'When the same multi-step setup shape reappears and the trader engages with it.',
                        '',
                        '## Procedure',
                        input.assistantMessage?.slice(0, 1200) || '(answer text unavailable)',
                        '',
                        '## Pitfalls',
                        'Authored by the background review from ONE observation — verify against the live tape before relying on it.',
                        '',
                        '## Verification',
                        'Confirm the entry/stop/target geometry against get_chart_view and the setup base rate before acting.',
                    ].join('\n'),
                },
            };
            const verdict = await applyEmission(emission, deps, emissions, refused);
            if (verdict) notes.push('Reusable setup captured as a PROBATION skill (never auto-verified).');
            continue;
        }
        const args = memoryArgsFor(signal, input);
        if (!args) continue;
        await applyEmission({ tool: 'memory', args }, deps, emissions, refused);
    }
    return { ran: true, trigger, signals, emissions, refused, notes };
};

const applyEmission = async (
    emission: BackgroundReviewEmission,
    deps: BackgroundReviewDeps,
    emissions: BackgroundReviewEmission[],
    refused: BackgroundReviewReceipt['refused'],
): Promise<boolean> => {
    // THE BOUNDARY. A review pass that could write anywhere would be a
    // second model with a notebook — it gets exactly two tools.
    if (!BACKGROUND_REVIEW_ALLOWED_TOOLS.has(emission.tool)) {
        refused.push({ tool: emission.tool, reason: 'not in the background-review allow-list (memory | skill_manage only).' });
        return false;
    }
    try {
        const result = await deps.emit(emission);
        if (result.ok) {
            emissions.push({ ...emission, undoSnapshot: result.undoSnapshot });
            return true;
        }
        refused.push({ tool: emission.tool, reason: result.error ?? 'the emitter refused the write.' });
        return false;
    } catch (e) {
        refused.push({ tool: emission.tool, reason: e instanceof Error ? e.message : String(e) });
        return false;
    }
};
