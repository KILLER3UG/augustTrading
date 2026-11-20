/**
 * sentinelLoop — isolated headless evaluator for deterministic chart/level
 * watchdog events.
 *
 * Design contract (Hermes/Claude isolated background loop pattern):
 *  1. NEVER feeds the full interactive chat transcript into the sentinel.
 *     Each evaluation builds a fresh, minimal context packet containing ONLY:
 *       - Frozen trader profile slice (risk rules & hard limits)
 *       - Single matched skill summary (if any)
 *       - Compact ChartStateSnapshot summary
 *       - The deterministic trigger event payload
 *  2. Enforces a strict structured decision output:
 *       - `SILENT_DISMISS` — noise / low-conviction touch; never interrupts chat.
 *       - `ALERT_TRADER` — concise actionable alert queued for the chat harness.
 *       - `UPDATE_PLAN_STATUS` — structured plan-lifecycle update queued for the harness.
 *  3. Idle-safe harness queue: non-dismissed notices NEVER interrupt a streaming
 *     turn; they accumulate in a bounded queue and drain into `chatStore` only
 *     when the target session is idle.
 */

import type { DrawingWatchTriggerEvent } from './watchdogCore';
import type { LevelHit, WatchPlan } from './tradePlanLevels';

export type SentinelActionType = 'SILENT_DISMISS' | 'ALERT_TRADER' | 'UPDATE_PLAN_STATUS';

export interface SentinelDecision {
    action: SentinelActionType;
    summary: string;
    severity?: 'info' | 'warning' | 'critical';
    planId?: string;
    nextPlanStatus?: 'pending' | 'active' | 'invalidated' | 'target_hit' | 'stale';
    drawingShortId?: string;
    reason?: string;
}

export type SentinelTriggerEvent =
    | {
        source: 'drawing_watch';
        symbol: string;
        sid?: string;
        event: DrawingWatchTriggerEvent;
    }
    | {
        source: 'plan_level';
        symbol: string;
        sid?: string;
        plan: WatchPlan;
        hit: LevelHit;
    };

export interface SentinelMinimalContext {
    /** Frozen trader profile summary (static per session, never chat history). */
    traderProfileSlice: string;
    /** Optional matched procedural skill summary. */
    matchedSkillExcerpt?: string;
    /** Compact chart state manifest (Tier 0 summary). */
    chartManifestSummary: string;
    /** Optional live ATR(14) on active timeframe. */
    atr14?: number | null;
}

export interface SentinelPromptPacket {
    systemInstruction: string;
    userPayload: string;
    /** Always true — guarantees no chat transcript was leaked into the packet. */
    isolated: true;
    eventSource: SentinelTriggerEvent['source'];
    symbol: string;
}

export interface SentinelNotice {
    id: string;
    symbol: string;
    sid?: string;
    decision: SentinelDecision;
    signalText: string;
    createdAt: number;
}

const MAX_PENDING_NOTICES = 12;
let noticeSeq = 0;
let pendingNotices: SentinelNotice[] = [];

const SENTINEL_SYSTEM_PROMPT = [
    'You are an isolated market sentinel evaluating ONE deterministic chart trigger.',
    'Respond ONLY with a single JSON object matching:',
    '{"action":"SILENT_DISMISS"|"ALERT_TRADER"|"UPDATE_PLAN_STATUS","summary":"<one concise sentence>","severity":"info"|"warning"|"critical","planId":"<optional>","nextPlanStatus":"pending"|"active"|"invalidated"|"target_hit"|"stale","reason":"<brief rationale>"}',
    'Rules:',
    '- Return SILENT_DISMISS if price noise is low-signal or redundant.',
    '- Return ALERT_TRADER when a trader-drawn structure or key level was crossed/tested cleanly.',
    '- Return UPDATE_PLAN_STATUS when an armed plan Entry/SL/TP was reached.',
    '- Never invent prices; cite only numbers present in the event payload.',
].join('\n');

/**
 * Build a fresh, minimal, transcript-free prompt packet for headless sentinel
 * evaluation.
 */
export const buildSentinelPromptPacket = (
    trigger: SentinelTriggerEvent,
    context: SentinelMinimalContext,
): SentinelPromptPacket => {
    const sections: string[] = [
        '[TRADER PROFILE SLICE]',
        context.traderProfileSlice.trim() || '(none)',
    ];
    if (context.matchedSkillExcerpt && context.matchedSkillExcerpt.trim()) {
        sections.push('[MATCHED SKILL]', context.matchedSkillExcerpt.trim());
    }
    sections.push('[CHART MANIFEST]', context.chartManifestSummary.trim() || '(unavailable)');
    if (trigger.source === 'drawing_watch') {
        const e = trigger.event;
        sections.push(
            '[TRIGGER EVENT: DRAWING WATCH]',
            JSON.stringify({
                kind: e.kind,
                symbol: e.symbol,
                drawing: e.shortId ?? e.drawingId,
                drawingKind: e.drawingKind,
                label: e.drawingLabel ?? null,
                tf: e.tf,
                livePrice: e.livePrice,
                targetPrice: e.targetPrice,
                distanceAtr: e.distanceAtr,
                crossedDirection: e.crossedDirection,
                barTime: e.barTime,
            }),
        );
    } else {
        sections.push(
            '[TRIGGER EVENT: PLAN LEVEL]',
            JSON.stringify({
                symbol: trigger.symbol,
                planId: trigger.plan.planId,
                direction: trigger.plan.direction,
                levelKind: trigger.hit.kind,
                levelId: trigger.hit.levelId,
                levelPrice: trigger.hit.price,
                hitPrice: trigger.hit.hitPrice,
            }),
        );
    }

    return {
        systemInstruction: SENTINEL_SYSTEM_PROMPT,
        userPayload: sections.join('\n\n'),
        isolated: true,
        eventSource: trigger.source,
        symbol: trigger.symbol,
    };
};

/**
 * Parse and validate strict structured JSON from a headless sentinel model run.
 * Unparseable or invalid actions fail safe to `SILENT_DISMISS`.
 */
export const parseSentinelDecision = (raw: string): SentinelDecision => {
    const trimmed = raw.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return {
            action: 'SILENT_DISMISS',
            summary: 'Sentinel returned non-JSON output; dismissed silently.',
            reason: 'parse_error',
        };
    }
    try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const action = parsed.action;
        if (action !== 'SILENT_DISMISS' && action !== 'ALERT_TRADER' && action !== 'UPDATE_PLAN_STATUS') {
            return {
                action: 'SILENT_DISMISS',
                summary: 'Sentinel returned unknown action; dismissed silently.',
                reason: 'invalid_action',
            };
        }
        const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim().slice(0, 280)
            : (action === 'SILENT_DISMISS' ? 'Dismissed.' : 'Sentinel trigger fired.');
        const severity = parsed.severity === 'critical' || parsed.severity === 'warning' || parsed.severity === 'info'
            ? parsed.severity
            : undefined;
        const nextPlanStatus = (
            parsed.nextPlanStatus === 'pending'
            || parsed.nextPlanStatus === 'active'
            || parsed.nextPlanStatus === 'invalidated'
            || parsed.nextPlanStatus === 'target_hit'
            || parsed.nextPlanStatus === 'stale'
        )
            ? parsed.nextPlanStatus
            : undefined;
        return {
            action,
            summary,
            ...(severity ? { severity } : {}),
            ...(typeof parsed.planId === 'string' && parsed.planId.trim() ? { planId: parsed.planId.trim() } : {}),
            ...(nextPlanStatus ? { nextPlanStatus } : {}),
            ...(typeof parsed.drawingShortId === 'string' && parsed.drawingShortId.trim() ? { drawingShortId: parsed.drawingShortId.trim() } : {}),
            ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason.trim().slice(0, 200) } : {}),
        };
    } catch {
        return {
            action: 'SILENT_DISMISS',
            summary: 'Sentinel JSON parse failed; dismissed silently.',
            reason: 'json_syntax_error',
        };
    }
};

/**
 * Deterministic fallback evaluator used when no headless LLM runner is wired
 * or when a quick local classification is requested.
 */
export const deterministicSentinelEvaluate = (
    trigger: SentinelTriggerEvent,
): SentinelDecision => {
    if (trigger.source === 'plan_level') {
        const { plan, hit } = trigger;
        const nextPlanStatus = hit.kind === 'sl'
            ? 'invalidated'
            : hit.kind === 'tp'
                ? 'target_hit'
                : 'active';
        return {
            action: 'UPDATE_PLAN_STATUS',
            summary: `${plan.symbol} ${plan.direction} plan ${plan.planId}: ${hit.label} @ ${hit.price} reached (mark ${hit.hitPrice}).`,
            severity: hit.kind === 'sl' ? 'critical' : 'warning',
            planId: plan.planId,
            nextPlanStatus,
            reason: `deterministic_${hit.kind}_hit`,
        };
    }

    const e = trigger.event;
    // If price is merely glancing outside tolerance on a live tick without a
    // clean cross or candle close, dismiss silently.
    if (e.kind === 'price_cross_drawing' && e.crossedDirection === 'touch' && e.distanceAtr !== null && e.distanceAtr > 0.25) {
        return {
            action: 'SILENT_DISMISS',
            summary: `${e.symbol} near ${e.shortId ?? e.drawingKind} (${e.distanceAtr} ATR) without a clean cross.`,
            drawingShortId: e.shortId,
            reason: 'noise_filter',
        };
    }

    const ref = e.shortId ? `${e.shortId} (${e.drawingKind})` : e.drawingKind;
    const labelPart = e.drawingLabel ? ` "${e.drawingLabel}"` : '';
    const verb = e.kind === 'candle_close_drawing'
        ? `${e.tf} candle closed at ${e.livePrice} near`
        : `price ${e.crossedDirection === 'up' ? 'crossed above' : e.crossedDirection === 'down' ? 'crossed below' : 'touched'}`;
    return {
        action: 'ALERT_TRADER',
        summary: `${e.symbol}: ${verb} ${ref}${labelPart} @ ${Number(e.targetPrice.toPrecision(6))}.`,
        severity: e.kind === 'candle_close_drawing' ? 'warning' : 'info',
        drawingShortId: e.shortId,
        reason: e.kind,
    };
};

/** Format a non-dismissed sentinel decision for the chat harness queue. */
export const formatSentinelNoticeForHarness = (
    symbol: string,
    decision: SentinelDecision,
): string => {
    const tag = decision.action === 'UPDATE_PLAN_STATUS'
        ? `[SENTINEL PLAN UPDATE — ${symbol}${decision.planId ? ` ${decision.planId}` : ''}${decision.nextPlanStatus ? ` → ${decision.nextPlanStatus}` : ''}]`
        : `[SENTINEL ALERT — ${symbol}${decision.drawingShortId ? ` ${decision.drawingShortId}` : ''}]`;
    return `${tag} ${decision.summary}\nReview the fresh chart state before advising the trader; do not fabricate numbers.`;
};

/**
 * Run one isolated sentinel evaluation. If the decision is `SILENT_DISMISS`,
 * nothing is enqueued; otherwise a notice is returned and optionally queued
 * into the idle-safe sentinel queue.
 */
export const evaluateSentinelEvent = async (
    trigger: SentinelTriggerEvent,
    context: SentinelMinimalContext,
    options?: {
        runHeadlessModel?: (packet: SentinelPromptPacket) => Promise<string>;
        enqueue?: boolean;
    },
): Promise<{ decision: SentinelDecision; packet: SentinelPromptPacket; notice: SentinelNotice | null }> => {
    const packet = buildSentinelPromptPacket(trigger, context);
    let decision: SentinelDecision;
    if (options?.runHeadlessModel) {
        try {
            const raw = await options.runHeadlessModel(packet);
            decision = parseSentinelDecision(raw);
        } catch {
            decision = deterministicSentinelEvaluate(trigger);
        }
    } else {
        decision = deterministicSentinelEvaluate(trigger);
    }

    if (decision.action === 'SILENT_DISMISS') {
        return { decision, packet, notice: null };
    }

    const notice: SentinelNotice = {
        id: `sent-${++noticeSeq}-${Date.now()}`,
        symbol: trigger.symbol,
        sid: trigger.sid,
        decision,
        signalText: formatSentinelNoticeForHarness(trigger.symbol, decision),
        createdAt: Date.now(),
    };
    if (options?.enqueue !== false) {
        enqueueSentinelNotice(notice);
    }
    return { decision, packet, notice };
};

/** Add a non-dismissed notice to the bounded idle-safe sentinel queue. */
export const enqueueSentinelNotice = (notice: SentinelNotice): void => {
    if (notice.decision.action === 'SILENT_DISMISS') return;
    pendingNotices = [...pendingNotices, notice].slice(-MAX_PENDING_NOTICES);
};

/** Inspect queued notices without draining them. */
export const getPendingSentinelNotices = (sid?: string): SentinelNotice[] =>
    sid ? pendingNotices.filter(n => !n.sid || n.sid === sid) : [...pendingNotices];

/**
 * Drain queued sentinel notices into a harness sink ONLY when the session is
 * idle (never mid-stream). Returns drained notices; leaves queue untouched
 * while `isIdle === false`.
 */
export const drainSentinelNoticesWhenIdle = (
    isIdle: boolean,
    sink: (signalText: string, sid?: string) => void,
    sid?: string,
): SentinelNotice[] => {
    if (!isIdle || pendingNotices.length === 0) return [];
    const matched: SentinelNotice[] = [];
    const remaining: SentinelNotice[] = [];
    for (const n of pendingNotices) {
        if (!sid || !n.sid || n.sid === sid) matched.push(n);
        else remaining.push(n);
    }
    pendingNotices = remaining;
    for (const n of matched) {
        sink(n.signalText, n.sid);
    }
    return matched;
};

/** Test hook: reset queue & sequence counter. */
export const __resetSentinelForTests = (): void => {
    pendingNotices = [];
    noticeSeq = 0;
};
