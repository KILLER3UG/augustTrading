/**
 * TurnPlanPill — the collapsed-by-default view of a turn's ephemeral
 * `update_plan` checklist.
 *
 * A plan is UI state the model proposed while one turn streams: it is NOT a
 * saved document, a signal or a skill. The pill reads the per-session store
 * through `useSyncExternalStore`, so both homes (the Chat composer and the
 * dock composer) show the same checklist without either owning it, and the
 * transport's own settle clears it. Rendering nothing when there is no plan
 * is deliberate — an empty pill is a decorative affordance, and those are the
 * ones the trader learns to ignore.
 */
import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getActiveSession } from '../../services/trade/chatStore';
import {
    clearTurnPlan, getTurnPlan, subscribeTurnPlanKey,
    type TurnPlanStepStatus,
} from '../../services/trade/turnPlan';

/**
 * The TRUE key a plan is stored under, resolved the same way in the pill and
 * in the settle hook. A chat-surface session is bound to a conversation and
 * its turn runner stores the plan under the conversation id; a chart-side dock
 * session has no conversationId and stores under its own session id. Resolving
 * here — rather than showing the global "latest" — is what stops a second
 * concurrent session's checklist from repainting this composer.
 */
const resolvePlanKey = (sessionId: string | null): string => {
    const key = sessionId ?? '';
    if (!key) return '';
    const active = getActiveSession();
    return active?.id === key && active.conversationId ? active.conversationId : key;
};

const GLYPH: Record<TurnPlanStepStatus, string> = {
    completed: '✓',
    in_progress: '→',
    pending: '○',
};

/** Muted done, bright active, dimmed waiting — monochrome only. */
const GLYPH_CLASS: Record<TurnPlanStepStatus, string> = {
    completed: 'text-zinc-500',
    in_progress: 'text-zinc-50',
    pending: 'text-zinc-700',
};

export interface TurnPlanPillProps {
    /** The session whose plan this is. The dock and the Chat thread each have
     *  their own key, so one turn cannot overwrite the other's checklist. */
    sessionId: string | null;
}

const TurnPlanPill: React.FC<TurnPlanPillProps> = ({ sessionId }) => {
    const key = sessionId ?? '';
    const planKey = resolvePlanKey(sessionId);
    // Subscribe to ONLY this composer's resolved key. A write under another
    // key does not call this listener, so two concurrent sessions cannot
    // overwrite each other's visible checklist. `getSnapshot` reads the same
    // key and returns null when it has no plan — the pill renders nothing.
    const subscribe = useCallback((onStoreChange: () => void) =>
        subscribeTurnPlanKey(planKey, onStoreChange), [planKey]);
    const getSnapshot = useCallback(() => getTurnPlan(planKey), [planKey]);
    const getServerSnapshot = useCallback((): null => null, []);
    const plan = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    const [open, setOpen] = React.useState(false);

    // A new plan (or a new session) starts collapsed. Escape closes the
    // checklist without touching the plan itself — dismissal is presentation.
    useEffect(() => { setOpen(false); }, [key]);
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [open]);

    if (!plan || plan.steps.length === 0) return null;
    const completed = plan.steps.filter(s => s.status === 'completed').length;
    const total = plan.steps.length;

    return (
        <div className="relative mb-1.5 flex justify-start" data-testid="turn-plan-pill-wrap">
            <button
                type="button"
                aria-label={`Turn plan, ${completed} of ${total} steps complete`}
                aria-expanded={open}
                data-testid="turn-plan-pill"
                title="Turn plan"
                onClick={() => setOpen(o => !o)}
                className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900/80 px-2.5 py-1 text-ui-2xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" aria-hidden="true" />
                <span>In progress {completed}/{total}</span>
                <span aria-hidden="true" className="text-zinc-600">{open ? '−' : '+'}</span>
            </button>
            {open && (
                <div
                    data-testid="turn-plan-popover"
                    role="list"
                    aria-label="Turn plan steps"
                    className="motion-popover-down absolute bottom-full left-0 z-shield mb-1.5 w-72 rounded-xl border border-white/[0.08] bg-zinc-900/95 p-2 shadow-elevated backdrop-blur-md"
                >
                    {plan.steps.map(step => (
                        <div key={step.id} role="listitem" className="flex items-start gap-2 px-1 py-1">
                            <span aria-hidden="true" className={`w-3 shrink-0 text-center text-ui-caption leading-5 ${GLYPH_CLASS[step.status]}`}>
                                {GLYPH[step.status]}
                            </span>
                            <span className="min-w-0 flex-1 text-ui-caption leading-5 text-zinc-400">{step.label}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

/** The settle side of the contract. Mounted beside the pill by the composer,
 *  this clears a session's plan when its streaming flag flips false. Kept as a
 *  named export so the call site reads as an intent, not a bare effect. */
export const useClearTurnPlanOnSettle = (sessionId: string | null, streaming: boolean): void => {
    const planKey = resolvePlanKey(sessionId);
    const wasStreaming = React.useRef(false);
    useEffect(() => {
        if (streaming) { wasStreaming.current = true; return; }
        if (wasStreaming.current) {
            wasStreaming.current = false;
            clearTurnPlan(planKey);
        }
    }, [streaming, planKey]);
};

export default React.memo(TurnPlanPill);
