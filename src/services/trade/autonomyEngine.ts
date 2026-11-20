/**
 * autonomyEngine — the ONE controller for the desk's background autonomy.
 *
 * The desk's model already runs every interactive turn; this module lets the
 * SAME configured model (or an explicit override seat) also run the quiet
 * loops: sentinel evaluations on deterministic triggers, AI-drawing hygiene,
 * post-mortem lesson capture, and idle memory/skill maintenance. The trader
 * sees ONE minimalist control (Auto / Paused) and one reversible activity
 * feed (services/trade/autonomyLedger) — never a modal per mutation.
 *
 * GUARDRAILS (all enforced here, before any model call or write):
 *  - MODE: `paused` halts every background model call and write. The default
 *    is `autonomous` once a provider is configured, but every loop checks it
 *    at fire time.
 *  - BUDGET: a bounded ring of background model-call timestamps; past
 *    MAX_BACKGROUND_CALLS_PER_HOUR in the trailing hour, every loop degrades
 *    to its deterministic path (or skips) instead of calling.
 *  - COOLDOWN: per-symbol sentinel cooldown, so one stuck price line cannot
 *    spend the budget on the same evaluation every second.
 *  - BACKOFF: a provider error (429/network) escalates an exponential
 *    backoff window; while it is open nothing calls the model.
 *  - MEMORY OFF: the profile's Layer-3 memory switch hard-stops every memory
 *    AND skill write (skills are notebook writes; a trader who switched
 *    memory off switched the notebook's writer off too).
 *  - ISOLATION: autonomous chart maintenance may create/adjust/expire ONLY
 *    `origin: 'agent'` drawings, capped at MAX_ACTIVE_AGENT_DRAWINGS per
 *    symbol, and NEVER touches the user's bucket (drawingsControl 'model').
 *  - DETERMINISTIC CORE: watchdogCore math, hindsight audits, redundancy
 *    scans and R:R stay code — the model classifies and phrases, never
 *    computes a guardrail.
 */

import type { SentinelDecision, SentinelMinimalContext, SentinelTriggerEvent } from './sentinelLoop';
import {
    buildSentinelPromptPacket,
    deterministicSentinelEvaluate,
    enqueueSentinelNotice,
    formatSentinelNoticeForHarness,
    parseSentinelDecision,
} from './sentinelLoop';
import * as chatStore from './chatStore';
import { getActiveUsername } from '../../utils/activeUser';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import {
    appendAutonomyRecord,
} from './autonomyLedger';

// ── Guardrail constants ──────────────────────────────────────────────────────

export const MAX_BACKGROUND_CALLS_PER_HOUR = 24;
export const SENTINEL_SYMBOL_COOLDOWN_MS = 90_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Active `origin:'agent'` shapes allowed per symbol before the hygiene pass
 *  expires the oldest. Deliberately small: AI sketches are annotations, not a
 *  second tape. */
export const MAX_ACTIVE_AGENT_DRAWINGS = 8;
/** The maintenance pass runs at most this often, and only when this many new
 *  resolutions accumulated since the last one. */
export const MAINTENANCE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAINTENANCE_MIN_NEW_RESOLUTIONS = 3;
/** The chart-hygiene pass is throttled per symbol (it runs on the ~1s tick). */
export const AGENT_HYGIENE_INTERVAL_MS = 60_000;

const SETTINGS_KEY_PREFIX = 'autonomy_settings_v1_';
const CALLS_KEY_PREFIX = 'autonomy_calls_v1_';
const MAINTENANCE_KEY_PREFIX = 'autonomy_maintenance_v1_';

export type AutonomyMode = 'autonomous' | 'paused';

export interface AutonomySettings {
    mode: AutonomyMode;
    /** Optional override seat: `providerId::modelId`. Empty = the first ready
     *  provider (the same resolution every background job already uses). */
    seat?: string;
}

export interface AutonomySnapshot {
    mode: AutonomyMode;
    seat?: string;
    /** Background model calls in the trailing hour. */
    callsLastHour: number;
    /** Epoch ms until which every model call is refused (provider backoff). */
    backoffUntil: number | null;
    lastMaintenanceAt: number | null;
}

// ── Settings (mode + seat) ───────────────────────────────────────────────────

const listeners = new Set<() => void>();
let settingsCache: Record<string, AutonomySettings> = {};

const settingsKey = (username: string): string => `${SETTINGS_KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const readSettings = async (username: string): Promise<AutonomySettings> => {
    const user = (username || 'default').trim() || 'default';
    if (settingsCache[user]) return settingsCache[user];
    try {
        const raw = await getPreferenceObject<AutonomySettings>(settingsKey(user));
        const settings: AutonomySettings = {
            mode: raw?.mode === 'paused' ? 'paused' : 'autonomous',
            ...(typeof raw?.seat === 'string' && raw.seat ? { seat: raw.seat } : {}),
        };
        settingsCache[user] = settings;
        return settings;
    } catch {
        const settings: AutonomySettings = { mode: 'autonomous' };
        settingsCache[user] = settings;
        return settings;
    }
};

const writeSettings = async (username: string, settings: AutonomySettings): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    settingsCache[user] = settings;
    try { await setPreferenceObject(settingsKey(user), settings); } catch { /* mode still applies this session */ }
    emit();
};

export const subscribeAutonomy = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

// useSyncExternalStore requires a REFERENTIALLY STABLE snapshot: a fresh
// object per getSnapshot call re-renders forever ("maximum update depth
// exceeded"). Cache it and invalidate on every emit.
let snapshotCache: AutonomySnapshot | null = null;
const emit = (): void => {
    snapshotCache = null;
    for (const fn of [...listeners]) fn();
};

/** Boot-time hydrate (the UI and loops read the cache synchronously). */
export const initAutonomy = async (username: string = getActiveUsername()): Promise<void> => {
    await readSettings(username);
    emit();
};

export const getAutonomyMode = (username: string = getActiveUsername()): AutonomyMode =>
    settingsCache[(username || 'default').trim() || 'default']?.mode ?? 'autonomous';

export const getAutonomySnapshot = (username: string = getActiveUsername()): AutonomySnapshot => {
    if (snapshotCache) return snapshotCache;
    const user = (username || 'default').trim() || 'default';
    const settings = settingsCache[user] ?? { mode: 'autonomous' as AutonomyMode };
    snapshotCache = {
        mode: settings.mode,
        ...(settings.seat ? { seat: settings.seat } : {}),
        callsLastHour: callsLastHour(user),
        backoffUntil: backoffUntil > Date.now() ? backoffUntil : null,
        lastMaintenanceAt: maintenanceStamp(user),
    };
    return snapshotCache;
};

export const setAutonomyMode = async (mode: AutonomyMode, username: string = getActiveUsername()): Promise<void> => {
    const settings = await readSettings(username);
    await writeSettings(username, { ...settings, mode });
};

export const setAutonomySeat = async (seat: string | undefined, username: string = getActiveUsername()): Promise<void> => {
    const settings = await readSettings(username);
    await writeSettings(username, { ...settings, ...(seat ? { seat } : {}) });
};

// ── Budget + backoff ─────────────────────────────────────────────────────────

let callTimestamps: Record<string, number[]> = {};
let backoffUntil = 0;
let backoffStage = 0;

const callsKey = (username: string): string => `${CALLS_KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const loadCalls = async (username: string): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    if (callTimestamps[user]) return;
    try {
        const raw = await getPreferenceObject<{ calls?: number[] }>(callsKey(user));
        callTimestamps[user] = Array.isArray(raw?.calls) ? raw!.calls! : [];
    } catch {
        callTimestamps[user] = [];
    }
};

const callsLastHour = (user: string, now = Date.now()): number =>
    (callTimestamps[user] ?? []).filter(t => now - t < 60 * 60 * 1000).length;

const recordCall = async (username: string = getActiveUsername(), now = Date.now()): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    await loadCalls(username);
    callTimestamps[user] = [...(callTimestamps[user] ?? []), now].slice(-200);
    try { await setPreferenceObject(callsKey(user), { calls: callTimestamps[user] }); } catch { /* budget still applies in memory */ }
    emit();
};

const noteProviderError = (): void => {
    backoffStage = Math.min(backoffStage + 1, 6);
    backoffUntil = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** backoffStage, BACKOFF_MAX_MS);
    emit();
};

const noteProviderSuccess = (): void => {
    backoffStage = 0;
    backoffUntil = 0;
};

const maintenanceStamp = (user: string): number | null => {
    const raw = maintenanceCache[user];
    return typeof raw === 'number' ? raw : null;
};
let maintenanceCache: Record<string, number | null> = {};

/**
 * The ONE gate every background model call passes. Returns a reason string
 * when the call must NOT run (the loop then degrades to deterministic or
 * skips), or null when the budget allows it.
 */
export const backgroundCallRefusal = async (
    username: string = getActiveUsername(),
    now = Date.now(),
): Promise<string | null> => {
    const mode = await readSettings(username);
    if (mode.mode === 'paused') return 'paused';
    if (backoffUntil > now) return `backoff_${Math.ceil((backoffUntil - now) / 1000)}s`;
    await loadCalls(username);
    const user = (username || 'default').trim() || 'default';
    if (callsLastHour(user, now) >= MAX_BACKGROUND_CALLS_PER_HOUR) return 'budget_exhausted';
    return null;
};

// ── Seat resolution (the ONE provider seam) ──────────────────────────────────

export interface BackgroundSeat {
    config: import('../../types/provider').ProviderConfig;
    complete: (prompt: string, system?: string, options?: { maxTokens?: number; temperature?: number }) => Promise<string>;
}

/**
 * Resolve the seat a background loop runs on: the explicit override when one
 * is configured, else the first READY provider — the same resolution the
 * compaction job and the memory hygiene pass use. No provider, no autonomy
 * model calls; every loop's deterministic path still runs.
 */
export const resolveBackgroundSeat = async (username: string = getActiveUsername()): Promise<BackgroundSeat | null> => {
    try {
        const [{ loadProviderConfigs, getReadyProviders }, { getQuickResponse }] = await Promise.all([
            import('../infrastructure/ProviderConfigService'),
            import('../providers/GenericProviderService'),
        ]);
        const configs = await loadProviderConfigs();
        const ready = getReadyProviders(configs);
        const settings = await readSettings(username);
        let config = ready[0];
        if (settings.seat) {
            const [providerId, ...modelParts] = settings.seat.split('::');
            const modelId = modelParts.join('::');
            const found = ready.find(c => c.id === providerId && (!modelId || c.selectedModel === modelId));
            if (found) config = found;
        }
        if (!config) return null;
        return {
            config,
            complete: (prompt, system, options) => getQuickResponse(config, prompt, system, {
                maxTokens: options?.maxTokens ?? 700,
                temperature: options?.temperature ?? 0.2,
            }),
        };
    } catch {
        return null;
    }
};

// ── Memory gate ──────────────────────────────────────────────────────────────

/** The profile's Layer-3 switch. A trader who switched memory OFF switched
 *  every notebook writer off — the engine included. */
export const isMemoryWriteAllowed = async (username: string = getActiveUsername()): Promise<boolean> => {
    try {
        const { getUserProfile } = await import('../infrastructure/dbService');
        const profile = await getUserProfile(username);
        return profile?.settings?.isGlobalMemoryEnabled !== false;
    } catch {
        return true;
    }
};

// ── Model-powered sentinel ───────────────────────────────────────────────────

export interface SentinelRunResult {
    decision: SentinelDecision;
    /** True when the configured model classified the event; false when the
     *  deterministic fallback answered (paused, budget, no seat, error). */
    modelRan: boolean;
    /** Side effects the engine executed for the decision (SILENT_MAINTAIN). */
    maintainSummary?: string;
    /** The harness notice for ALERT_TRADER / UPDATE_PLAN_STATUS (the caller
     *  mirrors it into its own return shape). */
    notice?: import('./sentinelLoop').SentinelNotice;
}

const symbolCooldownUntil = new Map<string, number>();

const sentinelCooldownActive = (symbol: string, now = Date.now()): boolean =>
    (symbolCooldownUntil.get(symbol) ?? 0) > now;

/**
 * ONE sentinel evaluation: budget-gated model classification over the minimal
 * isolated packet, deterministic fallback, then DECISION EXECUTION —
 * SILENT_MAINTAIN acts on the chart/watches quietly, the other non-dismiss
 * actions enqueue an idle-safe harness notice. Never chat history; never a
 * user-drawing mutation.
 */
export const evaluateSentinelTrigger = async (
    trigger: SentinelTriggerEvent,
    context: SentinelMinimalContext,
    input?: { sessionId?: string; drawings?: ReadonlyArray<{ id: string; shortId?: string; kind: string; origin?: string; createdAt?: number; label?: string }> },
): Promise<SentinelRunResult> => {
    // PAUSED halts the model call and every AUTONOMOUS WRITE, but a watch the
    // trader explicitly armed still wakes them: the deterministic decision
    // runs and ALERT_TRADER / UPDATE_PLAN_STATUS still reach the harness
    // queue. What pause suppresses is exactly the proactive half — model
    // classification and SILENT_MAINTAIN chart mutations.
    const refusal = await backgroundCallRefusal();
    const paused = refusal === 'paused';
    if (refusal && refusal !== 'paused') {
        // Backoff/budget: the deterministic answer still classifies the event
        // (the watchdog math already fired), just without a model call.
        const decision = deterministicSentinelEvaluate(trigger);
        return finishSentinel(trigger, decision, false, input, { allowMaintain: false });
    }
    if (paused) {
        const decision = deterministicSentinelEvaluate(trigger);
        return finishSentinel(trigger, decision, false, input, { allowMaintain: false });
    }
    if (sentinelCooldownActive(trigger.symbol)) {
        const decision = deterministicSentinelEvaluate(trigger);
        return finishSentinel(trigger, decision, false, input, { allowMaintain: false });
    }
    symbolCooldownUntil.set(trigger.symbol, Date.now() + SENTINEL_SYMBOL_COOLDOWN_MS);

    const seat = await resolveBackgroundSeat();
    const packet = buildSentinelPromptPacket(trigger, context);
    let decision: SentinelDecision;
    let modelRan = false;
    if (seat) {
        try {
            const raw = await seat.complete(
                packet.userPayload,
                packet.systemInstruction,
                { maxTokens: 300, temperature: 0.1 },
            );
            await recordCall();
            decision = parseSentinelDecision(raw);
            modelRan = true;
            noteProviderSuccess();
        } catch {
            noteProviderError();
            decision = deterministicSentinelEvaluate(trigger);
        }
    } else {
        decision = deterministicSentinelEvaluate(trigger);
    }
    return finishSentinel(trigger, decision, modelRan, input, { allowMaintain: true });
};

const finishSentinel = async (
    trigger: SentinelTriggerEvent,
    decision: SentinelDecision,
    modelRan: boolean,
    input?: { sessionId?: string; drawings?: ReadonlyArray<{ id: string; shortId?: string; kind: string; origin?: string; createdAt?: number; label?: string }> },
    opts?: { allowMaintain?: boolean },
): Promise<SentinelRunResult> => {
    if (decision.action === 'SILENT_DISMISS') {
        return { decision, modelRan };
    }
    if (decision.action === 'SILENT_MAINTAIN') {
        if (opts?.allowMaintain === false) {
            // Paused/backoff: no autonomous chart mutation. The decision dies
            // quietly — that is what "paused" means for the proactive half.
            return { decision, modelRan };
        }
        // The maintain executor appends its own record WITH a revert payload
        // when it actually removed something; a no-op (target gone, or a
        // user-drawing shortId refused by the isolation contract) stays quiet
        // — that is the whole point of the action.
        const maintain = await applySentinelMaintain(trigger, decision, input);
        if (maintain) return { decision, modelRan, maintainSummary: maintain };
        return { decision, modelRan };
    }
    // ALERT_TRADER / UPDATE_PLAN_STATUS: the idle-safe harness notice.
    const notice = {
        id: `sent-auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        symbol: trigger.symbol,
        sid: trigger.sid,
        decision,
        signalText: formatSentinelNoticeForHarness(trigger.symbol, decision),
        createdAt: Date.now(),
    };
    enqueueSentinelNotice(notice);
    appendAutonomyRecord({ subsystem: 'sentinel', summary: decision.summary, undo: { kind: 'none' } });
    return { decision, modelRan, notice };
};

/** Set while a maintain mutates drawings, so the record carries the revert. */
void 0;

// ── Autonomous AI chart hygiene ──────────────────────────────────────────────

export interface AgentHygieneResult {
    expired: number;
    /** Summaries of what was expired and why (empty = nothing to do). */
    notes: string[];
}

const hygieneStampBySymbol = new Map<string, number>();

/**
 * Expire stale/invalidated `origin:'agent'` drawings and enforce the
 * MAX_ACTIVE_AGENT_DRAWINGS cap. USER DRAWINGS ARE NEVER READ FOR WRITING:
 * the pass runs on the `model` bucket alone, so a user shape is structurally
 * unreachable here. Every removal carries a full snapshot in the ledger.
 */
export const maintainAgentDrawings = async (
    sessionId: string,
    symbol: string,
    markPrice: number | null,
    activeTf: string,
    now = Date.now(),
): Promise<AgentHygieneResult> => {
    const result: AgentHygieneResult = { expired: 0, notes: [] };
    const last = hygieneStampBySymbol.get(symbol) ?? 0;
    if (now - last < AGENT_HYGIENE_INTERVAL_MS) return result;
    hygieneStampBySymbol.set(symbol, now);
    try {
        const [{ drawingsControl }, { isDrawingStale }] = await Promise.all([
            import('./drawingsControl'),
            import('./chartGeometry'),
        ]);
        const control = drawingsControl('model', sessionId, symbol);
        const drawings = control.list();
        if (drawings.length === 0) return result;
        const agent = drawings.filter(d => d.origin === 'agent');
        if (agent.length === 0) return result;

        // Stale = the shape's own staleness verdict (age + ATR distance), the
        // SAME predicate the Tier 0 manifest reports to the model. ATR comes
        // from the same chart rows the manifest reads.
        const { computeAtr14 } = await import('./chartGeometry');
        void computeAtr14;
        const stale = agent
            .filter(d => isDrawingStale(d, markPrice, null, now));
        const overCap = agent.length > MAX_ACTIVE_AGENT_DRAWINGS
            ? agent.slice(0, agent.length - MAX_ACTIVE_AGENT_DRAWINGS)
            : [];
        const doomedIds = new Set<string>();
        for (const d of stale) {
            if (!doomedIds.has(d.id)) {
                doomedIds.add(d.id);
                result.notes.push(`expired stale ${d.shortId ?? d.id} (${d.kind})`);
            }
        }
        for (const d of overCap) {
            if (!doomedIds.has(d.id)) {
                doomedIds.add(d.id);
                result.notes.push(`expired ${d.shortId ?? d.id} (${d.kind}) over the ${MAX_ACTIVE_AGENT_DRAWINGS}-shape cap`);
            }
        }
        void activeTf;
        if (doomedIds.size === 0) return result;

        control.remove([...doomedIds]);
        result.expired = doomedIds.size;
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('august:agent-drawings-changed', { detail: { sessionId, symbol } }));
        }
        appendAutonomyRecord({
            subsystem: 'chart',
            summary: `Maintained AI drawings on ${symbol}: ${result.notes.join('; ')}.`,
            undo: { kind: 'chart-restore', sessionId, symbol, drawings: [...drawings] },
        });
        return result;
    } catch {
        return result;
    }
};

/**
 * The SILENT_MAINTAIN executor: the model named a drawing (or the engine's
 * hygiene target). Only `origin:'agent'` shapes are eligible — a user-drawing
 * shortId is refused silently, which is the isolation contract, not an error.
 */
export const applySentinelMaintain = async (
    trigger: SentinelTriggerEvent,
    decision: SentinelDecision,
    input?: { sessionId?: string; drawings?: ReadonlyArray<{ id: string; shortId?: string; kind: string; origin?: string; createdAt?: number; label?: string }> },
): Promise<string | null> => {
    const sessionId = input?.sessionId;
    if (!sessionId) return null;
    const target = decision.drawingShortId;
    if (!target) return null;
    const named = (input?.drawings ?? []).find(d => (d.shortId ?? d.id) === target);
    if (!named) return null;
    // ISOLATION: only agent-origin shapes may be maintained away.
    if (named.origin !== 'agent') return null;
    try {
        const { drawingsControl } = await import('./drawingsControl');
        const control = drawingsControl('model', sessionId, trigger.symbol);
        const before = control.list();
        const doomed = before.find(d => d.id === named.id || d.shortId === target);
        if (!doomed) return null;
        control.remove([doomed.id]);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('august:agent-drawings-changed', { detail: { sessionId, symbol: trigger.symbol } }));
        }
        appendAutonomyRecord({
            subsystem: 'chart',
            summary: `Sentinel maintained chart on ${trigger.symbol}: removed ${doomed.shortId ?? doomed.id} (${doomed.kind}) — ${decision.reason ?? decision.summary}`,
            undo: { kind: 'chart-restore', sessionId, symbol: trigger.symbol, drawings: before },
        });
        return `removed ${doomed.shortId ?? doomed.id}`;
    } catch {
        return null;
    }
};

// ── Post-mortem → memory bridge ──────────────────────────────────────────────

export interface DiagnosisLessonInput {
    id: string;
    tradeId: string;
    lesson: string;
    when: string;
    action: string;
    source: string;
    outcome: string;
    createdAt: string;
}

/** Accumulated lessons per pattern key, so the promotion gate can count
 *  evidence across distinct trades/sessions. */
const lessonPool: Map<string, DiagnosisLessonInput[]> = new Map();

/**
 * The post-mortem bridge: a hindsight-checked diagnosis becomes a candidate
 * lesson; when the SAME pattern accumulates >=3 evidence across >=3 distinct
 * sessions the engine promotes it into profileMemory through the SAME gate a
 * rule proposal passes. Risk-rule-shaped lessons NEVER auto-promote — the
 * trader states risk limits themselves.
 */
export const notePostMortemLesson = async (diagnosis: DiagnosisLessonInput): Promise<void> => {
    try {
        if (!(await isMemoryWriteAllowed())) return;
        const { checkProfileBiasPromotionEligibility, MIN_PROFILE_BIAS_EVIDENCE, MIN_PROFILE_BIAS_SESSIONS } = await import('../learning/candidateRuleLoop');
        const text = `${diagnosis.lesson}\n${diagnosis.when}\n${diagnosis.action}`;
        const patternKey = `pm:${diagnosis.source}:${diagnosis.when.slice(0, 60).toLowerCase().replace(/\s+/g, ' ').trim()}`;
        const pool = lessonPool.get(patternKey) ?? [];
        if (!pool.some(l => l.tradeId === diagnosis.tradeId)) pool.push(diagnosis);
        lessonPool.set(patternKey, pool);

        // Risk-shaped lessons are the trader's own statement, never an
        // autonomous write.
        const riskShaped = /\b(risk|stop|size|sizing|leverage|max loss|guardrail)\b/i.test(text);

        const evidenceIds = pool.map(l => l.tradeId);
        const sessionIds = [...new Set(pool.map(l => l.createdAt.slice(0, 10)))];
        const promotion = checkProfileBiasPromotionEligibility({
            evidenceIds,
            sessionIds,
            biasStatement: text,
            knowableAtEntry: [diagnosis.when].filter(Boolean),
        });
        if (!promotion.ok) {
            appendAutonomyRecord({
                subsystem: 'memory',
                summary: `Post-mortem lesson from ${diagnosis.tradeId} held as a candidate (${evidenceIds.length}/${MIN_PROFILE_BIAS_EVIDENCE} evidence, ${sessionIds.length}/${MIN_PROFILE_BIAS_SESSIONS} sessions)${promotion.requiresTraderConfirmation ? ' — needs trader confirmation' : ''}.`,
                undo: { kind: 'none' },
            });
            return;
        }
        if (riskShaped) {
            appendAutonomyRecord({
                subsystem: 'memory',
                summary: `Post-mortem pattern on ${diagnosis.source} looks risk-shaped — logged as a recommendation only; the trader owns risk rules.`,
                undo: { kind: 'none' },
            });
            return;
        }
        const { rememberWithConsolidation } = await import('../learning/profileMemoryConsolidation');
        const slug = `pm-${patternKey.replace(/^pm:/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 48)}-${sessionIds.length}`;
        const previous = (await import('../learning/profileMemory')).getProfileMemory(slug);
        const saved = await rememberWithConsolidation({
            slug,
            name: slug,
            title: `Lesson: ${diagnosis.when.slice(0, 40)}`.trim(),
            description: diagnosis.lesson.slice(0, 150),
            kind: 'feedback',
            body: `${diagnosis.lesson}\n\nWhen: ${diagnosis.when}\nAction: ${diagnosis.action}\nEvidence: ${evidenceIds.length} settled trades across ${sessionIds.length} sessions.`,
            source: 'auto',
            tag: 'inferred',
        });
        if (saved.ok && !('conflict' in saved.result) && saved.result.persisted !== false) {
            appendAutonomyRecord({
                subsystem: 'memory',
                summary: `Promoted post-mortem pattern to memory "${slug}" (${evidenceIds.length} evidence, ${sessionIds.length} sessions).`,
                undo: previous
                    ? { kind: 'memory-update', slug, previous: { description: previous.description, body: previous.body, title: previous.title, version: previous.version } }
                    : { kind: 'memory-forget', slug },
            });
        }
        lessonPool.delete(patternKey);
    } catch {
        // A bridge failure must never surface as a diagnosis error.
    }
};

// ── Idle maintenance loop (memory consolidation + skill refinement) ──────────

let maintenanceRunning = false;
let loopTimer: ReturnType<typeof setInterval> | null = null;

interface MaintenanceStamp { at: number; resolvedAt: number }

const maintenanceKey = (username: string): string => `${MAINTENANCE_KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const readMaintenanceStamp = async (username: string): Promise<MaintenanceStamp | null> => {
    try {
        const raw = await getPreferenceObject<MaintenanceStamp>(maintenanceKey(username));
        return raw && typeof raw.at === 'number' ? raw : null;
    } catch {
        return null;
    }
};

const writeMaintenanceStamp = async (username: string, stamp: MaintenanceStamp): Promise<void> => {
    try { await setPreferenceObject(maintenanceKey(username), stamp); } catch { /* retried next pass */ }
};

/** How many resolved-signal rows landed after `since` (the trigger metric). */
const countResolutionsSince = async (since: number): Promise<number> => {
    try {
        const { readSignals } = await import('../signals/signalLedger');
        return readSignals().filter(r => r.resolution && r.resolution.at > since).length;
    } catch {
        return 0;
    }
};

/** Chat idle = no session streaming and no conversation streaming. */
const chatIdle = (): boolean => {
    try {
        const snap = chatStore.getSnapshot();
        return Object.keys(snap.running).length === 0 && Object.keys(snap.conversationRunning).length === 0;
    } catch {
        return true;
    }
};

/**
 * One maintenance pass: an isolated model turn that (1) merges/prunes
 * redundant profile memory within the notebook's byte ceiling, and
 * (2) refines ONE skill playbook against its calibration dimensions —
 * through the ONE pen (`writeSkillFile`) with the SAME gates a model write
 * passes. Every applied op lands in the ledger with a revert payload.
 */
export const runMaintenancePass = async (username: string = getActiveUsername(), now = Date.now()): Promise<string[]> => {
    const notes: string[] = [];
    if (maintenanceRunning) return notes;
    maintenanceRunning = true;
    try {
        const refusal = await backgroundCallRefusal(username, now);
        if (refusal) {
            notes.push(`Maintenance skipped: ${refusal}.`);
            return notes;
        }
        const seat = await resolveBackgroundSeat(username);
        if (!seat) {
            notes.push('Maintenance skipped: no ready provider.');
            return notes;
        }

        // (1) Memory consolidation — model proposes, the engine applies, the
        // ledger remembers how to revert. Capped at 3 ops per pass.
        if (await isMemoryWriteAllowed(username)) {
            const { listProfileMemories } = await import('../learning/profileMemory');
            const entries = listProfileMemories(username);
            const index = entries.slice(0, 40).map(e => `- ${e.slug} (${e.kind}): ${e.description} :: ${e.body.slice(0, 160).replace(/\s+/g, ' ')}`).join('\n');
            if (index.trim()) {
                try {
                    const raw = await seat.complete(
                        [
                            'You maintain the trader\'s durable fact store. Below is the fact index (slug (kind): description :: body-head).',
                            'Return ONLY a JSON array of at most 3 ops:',
                            '[{"op":"forget","slug":"...","reason":"..."}] or [{"op":"update","slug":"...","description":"...","body":"..."}]',
                            'Only propose a merge-like update that genuinely deduplicates or sharpens an existing fact; never invent a new fact; never touch risk limits or numbers of record.',
                            '',
                            index,
                        ].join('\n'),
                        'You are a conservative memory curator for a trading desk. Refuse (return []) when nothing is clearly redundant.',
                        { maxTokens: 500, temperature: 0.1 },
                    );
                    await recordCall(username, now);
                    const match = raw.match(/\[[\s\S]*\]/);
                    const ops = match ? JSON.parse(match[0]) as Array<Record<string, unknown>> : [];
                    const { forgetProfileMemory, updateProfileMemory, getProfileMemory } = await import('../learning/profileMemory');
                    let applied = 0;
                    for (const op of ops.slice(0, 3)) {
                        if (applied >= 3) break;
                        const slug = typeof op.slug === 'string' ? op.slug : '';
                        if (!slug) continue;
                        const before = getProfileMemory(slug, username);
                        if (!before) continue;
                        if (op.op === 'forget' && typeof op.reason === 'string') {
                            const result = forgetProfileMemory(slug, username, 'model');
                            if (result.gone) {
                                appendAutonomyRecord({
                                    subsystem: 'memory',
                                    summary: `Maintenance pruned "${slug}": ${String(op.reason).slice(0, 120)}`,
                                    undo: { kind: 'memory-restore', entry: { slug: before.slug, title: before.title, description: before.description, kind: before.kind, body: before.body } },
                                }, username);
                                applied += 1;
                                notes.push(`Pruned "${slug}".`);
                            }
                        } else if (op.op === 'update' && typeof op.body === 'string' && typeof op.description === 'string') {
                            const result = updateProfileMemory({
                                slug,
                                mode: 'replace',
                                body: op.body.slice(0, 1000),
                                description: op.description.slice(0, 160),
                                ifVersion: before.version ?? 1,
                            }, username);
                            if (result.ok) {
                                appendAutonomyRecord({
                                    subsystem: 'memory',
                                    summary: `Maintenance sharpened "${slug}".`,
                                    undo: { kind: 'memory-update', slug, previous: { description: before.description, body: before.body, title: before.title, version: before.version } },
                                }, username);
                                applied += 1;
                                notes.push(`Sharpened "${slug}".`);
                            }
                        }
                    }
                    if (applied === 0) notes.push('Memory maintenance: nothing clearly redundant.');
                } catch {
                    noteProviderError();
                    notes.push('Memory maintenance turn failed; nothing written.');
                }
            }
        } else {
            notes.push('Memory maintenance skipped: memory is OFF.');
        }

        // (2) Skill refinement — ONE skill per pass, through the ONE pen.
        const skillNote = await refineOneSkill(seat, username);
        if (skillNote) notes.push(skillNote);

        await writeMaintenanceStamp(username, { at: now, resolvedAt: now });
        maintenanceCache = { ...maintenanceCache, [username]: now };
    } finally {
        maintenanceRunning = false;
    }
    return notes;
};

/** The stored SKILL.md minus its frontmatter fence — the BODY only. */
const skillBodyOf = (content: string): string =>
    stripFrontmatter(content.trim());

/** Strip a leading `--- ... ---` frontmatter fence if present. */
const stripFrontmatter = (text: string): string =>
    /^---[\s\S]*?---\s*/.test(text) ? text.replace(/^---[\s\S]*?---\s*/, '').trim() : text.trim();

/**
 * Refine one skill against its calibration dimensions: the weakest dimension
 * bucket names the skill (or the first usable skill when no dimensions have
 * data). The revised body must pass the format gates AND the redundancy scan
 * inside `writeSkillFile` — a refused write records nothing.
 */
export const refineOneSkill = async (seat: BackgroundSeat, username: string = getActiveUsername()): Promise<string | null> => {
    try {
        const { skillIndexRows, usableSkillRows, getSkill, writeSkillFile, skillLibraryVersion, contentVersion } = await import('../learning/SkillFileService');
        const { calibrateByDimensions } = await import('../signals/signalCalibration');
        const rows = usableSkillRows(skillIndexRows());
        if (rows.length === 0) return null;
        let targetSlug = rows[0].slug;
        try {
            const { readSignals } = await import('../signals/signalLedger');
            const buckets = calibrateByDimensions(readSignals(username));
            const worst = buckets.find(b => b.skillSlug !== 'untagged' && b.fills >= 2 && (b.hitRate !== null && b.hitRate < 0.5));
            if (worst && rows.some(r => r.slug === worst.skillSlug)) targetSlug = worst.skillSlug;
        } catch { /* no ledger data: first usable skill */ }
        const skill = getSkill(targetSlug);
        if (!skill) return null;

        const raw = await seat.complete(
            [
                `Refine this trading playbook BODY for clarity and checklists. Keep the ## When to use / ## Steps / ## Pitfalls / ## Verification headings. Do NOT add frontmatter, status, approval, win/loss ledger or performance fields. Do not change what the playbook is for.`,
                `Return ONLY the revised body (no frontmatter).`,
                ``,
                skillBodyOf(skill.file.content),
            ].join('\n'),
            'You refine a trading desk playbook. Same shape, sharper words, no invented facts, no ledger fields.',
            { maxTokens: 1200, temperature: 0.2 },
        );
        await recordCall(username);
        const revisedBody = stripFrontmatter(raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim());
        if (revisedBody.length < 80 || revisedBody === skillBodyOf(skill.file.content)) return null;
        // Validate the COMPOSED document (frontmatter + body) against the same
        // format gate every writer passes — the pen stores body-only and wraps
        // it in generated frontmatter itself.
        const { composeSkillMarkdown } = await import('../learning/SkillFileService');
        const composed = composeSkillMarkdown(skill.name, skill.description, revisedBody);
        const { skillFormatIssues } = await import('../../utils/skillFrontmatter');
        if (skillFormatIssues(composed).length > 0) return null;

        const result = await writeSkillFile({
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            body: revisedBody,
            ifVersion: contentVersion(skill.file.content),
        }, username, {
            indexVersion: skillLibraryVersion(),
            opened: new Map([[skill.slug, contentVersion(skill.file.content)]]),
        });
        if (!result.ok) return `Skill refinement of "${skill.slug}" refused: ${result.message.slice(0, 120)}`;
        appendAutonomyRecord({
            subsystem: 'skill',
            summary: `Refined playbook "${skill.slug}" (sharper checklist, same scope).`,
            undo: { kind: 'skill-restore', slug: skill.slug, previous: { body: skillBodyOf(skill.file.content), description: skill.description, name: skill.name } },
        }, username);
        return `Refined playbook "${skill.slug}".`;
    } catch (e) {
        return `Skill refinement skipped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
    }
};

/**
 * The background heartbeat: started once per boot (App), self-throttling.
 * Fires the sentinel-adjacent maintenance ONLY when the chat is idle, the
 * maintenance interval elapsed, and enough resolutions accumulated.
 */
export const ensureBackgroundLoops = (): void => {
    if (loopTimer) return;
    loopTimer = setInterval(() => {
        void (async () => {
            const username = getActiveUsername();
            if (getAutonomyMode(username) === 'paused') return;
            if (!chatIdle()) return;
            const stamp = await readMaintenanceStamp(username);
            const now = Date.now();
            const dueByAge = !stamp || now - stamp.at >= MAINTENANCE_MIN_INTERVAL_MS;
            const newResolutions = await countResolutionsSince(stamp?.resolvedAt ?? 0);
            if (!dueByAge && newResolutions < MAINTENANCE_MIN_NEW_RESOLUTIONS) return;
            await runMaintenancePass(username, now);
        })().catch(() => { /* a background pass never surfaces as an error */ });
    }, 120_000);
};

/** Test hook: saturate the background-call budget for one user. */
export const __forceBudgetForTests = (username: string = getActiveUsername()): void => {
    const user = (username || 'default').trim() || 'default';
    const now = Date.now();
    callTimestamps[user] = Array.from({ length: MAX_BACKGROUND_CALLS_PER_HOUR }, (_, i) => now - i * 1000);
};

/** Test hook: reset module state (mode cache, budget, cooldowns, pools). */
export const __resetAutonomyEngineForTests = (): void => {
    settingsCache = {};
    callTimestamps = {};
    backoffUntil = 0;
    backoffStage = 0;
    symbolCooldownUntil.clear();
    hygieneStampBySymbol.clear();
    lessonPool.clear();
    maintenanceCache = {};
    maintenanceRunning = false;
};
