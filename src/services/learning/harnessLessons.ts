/**
 * harnessLessons — the harness's own lesson store (P7).
 *
 * The skills store learns TRADING beliefs (what setups to repeat/avoid);
 * this store learns HARNESS beliefs — which wire shapes, prompt patterns
 * and budget knobs actually work on the providers the user runs. Written
 * by the wire audit and the known-answer probes (`probeAndLearn`, wired to
 * the provider manager's probe button).
 *
 * READERS, measured, not remembered (E-57): exactly two. The wire-audit pin
 * checker below (`registerWireRoutePins`) — a live read, the reason this store
 * is not dead — and `components/settings/HarnessLessonsBrowser.tsx`, which is a
 * HUMAN surface. There is NO prompt reader: the block that used to feed the
 * ensemble's arbiter (`formatHarnessNotesBlock`) and the class-scoped accessor
 * that only its tests called (`lessonsForClass`) are deleted here, because a
 * store that advertises a reader it does not have is the same lie as an inert
 * button. Do not re-add a prompt injection without an owner ruling on what the
 * seat can DO with a wire lesson.
 *
 * Capability-class doctrine (2026-08-29): lessons key on CAPABILITY CLASSES
 * (thinkingDefault / wire format / jsonMode / vision), NEVER on provider
 * identity — any model can run on the harness. `provider` on a lesson is
 * evidence provenance only (which endpoint demonstrated it), not scope.
 * A wire lesson can pin a class to thinking-off until a re-probe clears it.
 */

import { buildReasoningPatch, ReasoningEffort, WireAuditEntry, registerWireRoutePins } from '../providers/reasoningControls';
import { sendChatRequest } from '../providers/GenericProviderService';
import { ProviderConfig } from '../../types/provider';

// ─── Lesson shape ────────────────────────────────────────────────────────────

export type HarnessLessonKind = 'fabrication' | 'wire' | 'injection' | 'budget';

/** The capability class a lesson applies to — scope, not provenance. */
export type CapabilityClass =
    | 'thinkingDefault'    // model thinks by default unless told not to
    | 'thinkingOptIn'      // model thinks only when asked
    | 'wireReasoningEffort' // chat_completions reasoning_effort knob
    | 'jsonMode'
    | 'vision'
    // Skill-guidance injections (the notebook's learned beliefs): negative
    // evidence recorded from the chat surface, e.g. a flagged citation.
    | 'skillGuidance';

export interface HarnessLesson {
    id: string;
    kind: HarnessLessonKind;
    /** Capability class this lesson scopes to. */
    scope: CapabilityClass;
    /** Evidence provenance only — never the lesson's scope. */
    provider?: string;
    /** The pattern that triggered the lesson (e.g. 'grok-*-fast rejects reasoning_effort'). */
    pattern: string;
    /** One-sentence actionable statement. */
    lesson: string;
    /** Deep link to the evidence (runStats audit line, probe result). */
    evidenceId: string;
    /** When the lesson was recorded. */
    at: string;
}

// ─── Store chassis (in-memory + localStorage persistence) ─────────────────────

const STORAGE_KEY = 'august_harness_lessons_v1';
const MAX_LESSONS = 200;

let lessons: HarnessLesson[] | null = null;

const load = (): HarnessLesson[] => {
    if (lessons === null) {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? (JSON.parse(raw) as HarnessLesson[]) : [];
            lessons = Array.isArray(parsed) ? parsed : [];
        } catch {
            lessons = [];
        }
    }
    return lessons;
};

const persist = (store: HarnessLesson[]): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
        console.warn('[HarnessLessons] persist failed:', e);
    }
};

/** All lessons, newest first. */
export const listHarnessLessons = (): HarnessLesson[] =>
    [...load()].sort((a, b) => (a.at < b.at ? 1 : -1));

/**
 * Record a lesson. Re-recording the same pattern (matched by scope+kind+pattern)
 * refreshes its timestamp instead of duplicating — the store tracks beliefs,
 * not an event log.
 */
export const recordHarnessLesson = (lesson: Omit<HarnessLesson, 'id' | 'at'>): HarnessLesson => {
    const store = load();
    const existing = store.find(l =>
        l.scope === lesson.scope && l.kind === lesson.kind && l.pattern === lesson.pattern
    );
    const now = new Date().toISOString();
    if (existing) {
        existing.at = now;
        existing.evidenceId = lesson.evidenceId;
        existing.lesson = lesson.lesson;
        if (lesson.provider) existing.provider = lesson.provider;
    } else {
        const entry: HarnessLesson = {
            ...lesson,
            id: `hl_${now}_${Math.random().toString(36).slice(2, 8)}`,
            at: now,
        };
        store.unshift(entry);
        if (store.length > MAX_LESSONS) store.length = MAX_LESSONS;
    }
    persist(store);
    return existing ?? store[0];
};

/** Remove one lesson (re-probe cleared the belief / user override). */
export const clearHarnessLesson = (id: string): void => {
    const store = load();
    const idx = store.findIndex(l => l.id === id);
    if (idx >= 0) {
        store.splice(idx, 1);
        persist(store);
    }
};

// ─── Wire-lesson read path (consumed by reasoningControls callers) ───────────

/**
 * Harness-lesson read path into reasoningControls: a provider whose probe FAILED while a
 * knob was sent gets its route pinned off (the store keeps the lesson until
 * a re-probe clears it). The provider id here narrows a CAPABILITY-CLASS
 * lesson to the endpoints that demonstrated the failure — the lesson's scope
 * stays the class, the pin's scope is the evidence provider.
 */
registerWireRoutePins((route, providerId) =>
    route !== 'none' && load().some(l =>
        l.kind === 'wire'
        && l.provider === providerId
        && l.pattern.toLowerCase().includes(`route=${route}`.toLowerCase())
    ));

// ─── P6: known-answer probes (200-accepted ≠ honored) ────────────────────────

export interface WireProbeResult {
    /** The provider+model probed. */
    providerId: string;
    model: string;
    /** The effort tier the probe requested. */
    requestedEffort: ReasoningEffort;
    /** What the wire audit said about the request body. */
    audit: WireAuditEntry;
    /** Whether the call succeeded AND the knob provably reached the provider
     *  (a 400 rejecting the knob is evidence the knob IS honored — it was
     *  read; a silent 200 with the knob stripped is NOT). */
    honored: boolean;
    /** How honor was determined. */
    evidence: string;
}

/**
 * Probe ONE provider with a known-answer request at a HIGH effort tier.
 *
 * The probe distinguishes three outcomes:
 *  1. success + audit applied → the knob reached the wire (honored, subject
 *     to the provider not silently stripping it — the audit says we SENT it).
 *  2. 400-class failure whose error mentions the knob field → the knob was
 *     READ by the provider (honored but rejected — e.g. grok-fast rejects
 *     reasoning_effort; that model should be excluded via the fail-closed
 *     detection, and this result proves the exclusion is needed).
 *  3. success + audit no-op/fail-closed → the harness never sent a knob —
 *     nothing was learned about the provider (honored=false, evidence says
 *     the harness sent no knob).
 */
export const probeWireSupport = async (
    config: ProviderConfig,
    effort: ReasoningEffort = 'high',
): Promise<WireProbeResult> => {
    const { audit } = buildReasoningPatch(config, effort);
    let honored = false;
    let evidence: string;
    try {
        const reply = await sendChatRequest(
            { ...config, apiKey: config.apiKey?.trim() || 'not-needed' },
            [{ role: 'user', content: 'Reply with exactly: OK' }],
            {
                // 512, not 64: a thinking-default model spends
                // part of the budget reasoning; at 64 the visible reply can
                // legitimately come back empty and the probe would pin off
                // a WORKING provider.
                maxTokens: 512,
                temperature: 0,
                signal: AbortSignal.timeout(30_000),
                reasoningEffort: effort,
            },
        );
        if (audit.applied && /OK/i.test(reply || '')) {
            honored = true;
            evidence = `knob sent (${audit.reason}) and the model replied OK`;
        } else if (audit.applied) {
            // INCONCLUSIVE, not broken: the knob reached the wire (the call
            // succeeded with it in the body) but the known-answer check
            // missed. probeAndLearn must NOT pin a route off on this.
            evidence = `inconclusive: knob sent (${audit.reason}) but the reply lacked OK — no lesson recorded`;
        } else {
            evidence = `no knob sent (fail-closed: ${audit.reason})`;
        }
    } catch (error: any) {
        const message = String(error?.message || error);
        const knobField = audit.route === 'xai-effort' || audit.route === 'openai-effort' ? 'reasoning_effort'
            : audit.route === 'glm-thinking' || audit.route === 'deepseek-thinking' ? 'thinking'
                : audit.route === 'responses-effort' ? 'reasoning'
                    : 'thinking';
        // Tightened heuristic: the provider must name the knob
        // field in a REJECTION context — a bare substring match on
        // 'thinking' caught unrelated error text.
        const rejection = /unrecognized|invalid|not\s+(a\s+)?(valid|supported|allowed)|unsupported|unknown|extra.*argument|argument.*not|rejected/i.test(message);
        if (rejection && message.toLowerCase().includes(knobField)) {
            // The provider read the field and rejected its VALUE — proof the
            // knob reaches the wire (the harness must exclude this shape).
            honored = true;
            evidence = `provider rejected the ${knobField} field (${message.slice(0, 160)})`;
        } else {
            evidence = `call failed before the knob could be judged (${message.slice(0, 160)})`;
        }
    }
    return {
        providerId: config.id,
        model: config.selectedModel,
        requestedEffort: effort,
        audit,
        honored,
        evidence,
    };
};

/**
 * Run a probe and record what it proved as a harness lesson (probe → lesson write
 * path). A probe that finds a fail-closed no-op where the user EXPECTS a knob
 * records a 'wire' lesson; a probe that proves the knob reaches the wire
 * clears any stale pin recorded against it.
 */
export const probeAndLearn = async (
    config: ProviderConfig,
    effort: ReasoningEffort = 'high',
): Promise<WireProbeResult> => {
    const result = await probeWireSupport(config, effort);
    const routeLabel = result.audit.route;
    if (result.honored) {
        // The knob reached the wire — clear any pin recorded against this
        // provider+route (the re-probe is the clearing evidence).
        const stale = load().filter(l =>
            l.kind === 'wire'
            && l.provider === config.id
            && l.pattern.toLowerCase().includes(`route=${routeLabel}`.toLowerCase())
        );
        for (const l of stale) clearHarnessLesson(l.id);
    } else if (result.audit.applied) {
        // Only HARD evidence pins: the call failed and the provider did not
        // name the knob (a broken route). "200 + no OK" is INCONCLUSIVE
        // — a thinking-default model can legitimately return
        // no visible text — and must never pin off a working provider.
        if (result.evidence.startsWith('inconclusive')) {
            // No lesson; the probe simply taught nothing.
        } else {
            recordHarnessLesson({
                kind: 'wire',
                scope: 'wireReasoningEffort',
                provider: config.id,
                pattern: `route=${routeLabel} broken on ${config.apiFormat}/${config.selectedModel}`,
                lesson: `The ${routeLabel} reasoning knob failed on this endpoint — effort tiers are pinned off for this provider until a re-probe succeeds.`,
                evidenceId: `probe:${result.providerId}:${Date.now()}`,
            });
        }
    } else if (result.audit.route === 'none') {
        // The harness sent no knob where one may have applied — worth a
        // lesson ONLY if the reason indicates an unverified shape (not a
        // deliberate 'auto').
        if (result.evidence.includes('fail-closed')) {
            recordHarnessLesson({
                kind: 'wire',
                scope: 'wireReasoningEffort',
                provider: config.id,
                pattern: `${routeLabel} unverified for ${config.apiFormat}/${config.selectedModel}`,
                lesson: `No verified reasoning route for this wire shape — effort knobs are not sent (fail closed). Probe again if the provider documents support.`,
                evidenceId: `probe:${result.providerId}:${Date.now()}`,
            });
        }
    }
    return result;
};
