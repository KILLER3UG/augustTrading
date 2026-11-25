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
import { Check, ChevronDown, ListChecks } from '../shared/Icons';
import { getActiveSession } from '../../services/trade/chatStore';
import {
    clearTurnPlan, getTurnPlan, subscribeTurnPlanKey,
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
        <div className="relative mb-1.5 flex w-full justify-start" data-testid="turn-plan-pill-wrap">
            <button
                type="button"
                aria-label={`Progress ${completed}/${total}`}
                aria-expanded={open}
                data-testid="turn-plan-progress-bar"
                title="Turn progress"
                onClick={() => setOpen(o => !o)}
                className="inline-flex items-center gap-2 rounded-control border border-hairline bg-zinc-900/90 px-3 py-1.5 text-ui-xs text-zinc-300 transition-colors hover:border-line hover:bg-zinc-800 hover:text-zinc-100"
            >
                <ListChecks className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                <span className="font-medium text-zinc-200">Progress</span>
                <span className="font-mono tabular-nums text-zinc-400">{completed}/{total}</span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {open && (
                <div
                    data-testid="turn-plan-progress-list"
                    role="list"
                    aria-label="Turn plan steps"
                    className="motion-popover-down absolute bottom-full left-0 right-0 z-shield mb-1.5 max-h-60 overflow-y-auto custom-scrollbar rounded-xl border border-white/[0.08] bg-zinc-900/95 p-2.5 shadow-elevated backdrop-blur-md"
                >
                    <div className="mb-1.5 flex items-center justify-between border-b border-hairline px-1 pb-1.5">
                        <span className="flex items-center gap-2 text-ui-xs font-medium text-zinc-200">
                            <ListChecks className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                            Progress <span className="font-mono tabular-nums text-zinc-400">{completed}/{total}</span>
                        </span>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label="Collapse progress checklist"
                            className="rounded-control p-0.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="space-y-0.5">
                        {plan.steps.map(step => (
                            <div key={step.id} role="listitem" className="flex items-start gap-2.5 rounded-control px-1.5 py-1">
                                <span aria-hidden="true" className="mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                    {step.status === 'completed' ? (
                                        <Check className="h-3.5 w-3.5 text-zinc-400" />
                                    ) : step.status === 'in_progress' ? (
                                        <span className="h-2 w-2 rounded-full bg-zinc-100" />
                                    ) : (
                                        <span className="h-2.5 w-2.5 rounded-full border border-zinc-600" />
                                    )}
                                </span>
                                <span className={`min-w-0 flex-1 text-ui-caption leading-5 ${
                                    step.status === 'in_progress'
                                        ? 'font-medium text-zinc-100'
                                        : step.status === 'completed'
                                            ? 'text-zinc-400'
                                            : 'text-zinc-500'
                                }`}>
                                    {step.label}
                                </span>
                            </div>
                        ))}
                    </div>
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
