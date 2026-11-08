import React from 'react';
import { TradeAnalysis } from '../../types';
import { buildConfidenceTimeline, classifyAvoidBasis, confirmationTrigger, ConfidenceStep } from '../../utils/avoidReason';
import { explainNoTrade } from '../../utils/analysisUtils';

/**
 * "Why Avoid?" — the structured replacement for the flat no-trade line.
 * Splits the verdict into hard blockers (untradeable on its own) vs
 * confidence downgrades (still a valid watch), shows the trigger that would
 * make the setup valid, and a compact confidence-change timeline.
 */

const dotTone = (tone: ConfidenceStep['tone']): string => {
    if (tone === 'blocked') return 'bg-rose-400';
    if (tone === 'warning') return 'bg-amber-400';
    if (tone === 'good') return 'bg-emerald-400';
    return 'bg-zinc-600';
};

const textTone = (tone: ConfidenceStep['tone']): string => {
    if (tone === 'blocked') return 'text-rose-300';
    if (tone === 'warning') return 'text-amber-300';
    if (tone === 'good') return 'text-emerald-400';
    return 'text-zinc-300';
};

export const WhyAvoidPanel: React.FC<{ analysis: TradeAnalysis }> = ({ analysis }) => {
    const basis = classifyAvoidBasis(analysis);
    // The card renders the Invalidation line directly below this panel, so
    // the "Would be valid if" line only adds sources the user cannot already
    // see (entry timing, gate insights).
    const trigger = confirmationTrigger(analysis, { skipInvalidationSource: true });
    const steps = buildConfidenceTimeline(analysis);
    const showTimeline = steps.length > 1;

    if (basis.hard.length === 0 && basis.downgrades.length === 0 && !trigger && !showTimeline) {
        // Nothing structured to explain (e.g. a plain model-declared Neutral) —
        // keep the previous flat line so the card never goes blank.
        return (
            <div className="rounded-control border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2">
                <div className="text-ui-xs font-semibold uppercase tracking-widest text-rose-300">Why no trade</div>
                <p className="mt-1 text-ui-base leading-6 text-zinc-300">{explainNoTrade(analysis)}</p>
            </div>
        );
    }

    return (
        <div className="rounded-control border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2">
            <div className="text-ui-xs font-semibold uppercase tracking-widest text-rose-300">Why Avoid?</div>

            {basis.hard.length > 0 && (
                <div className="mt-2">
                    <div className="text-ui-xs uppercase tracking-widest text-rose-400/80">Hard blockers — do not enter</div>
                    <ul className="mt-1 space-y-1">
                        {basis.hard.map(item => (
                            <li key={item.text} className="text-ui-base leading-5 text-rose-200/90">{item.text}</li>
                        ))}
                    </ul>
                </div>
            )}

            {basis.downgrades.length > 0 && (
                <div className="mt-2">
                    <div className="text-ui-xs uppercase tracking-widest text-amber-300/80">Confidence downgrades — watch, not dead</div>
                    <ul className="mt-1 space-y-1">
                        {basis.downgrades.map(item => (
                            <li key={item.text} className="text-ui-base leading-5 text-zinc-300">{item.text}</li>
                        ))}
                    </ul>
                </div>
            )}

            {trigger && (
                <p className="mt-2 text-ui-sm leading-5 text-zinc-400">
                    <span className="font-medium uppercase tracking-widest text-zinc-500">Would be valid if </span>
                    {trigger.text}
                    {trigger.level ? ` — at ${trigger.level}` : ''}.
                </p>
            )}

            {showTimeline && (
                <div className="mt-2 border-t border-hairline pt-2">
                    <div className="text-ui-xs uppercase tracking-widest text-zinc-500">Confidence timeline</div>
                    <ol className="mt-1 space-y-1">
                        {steps.map((step, index) => (
                            <li key={`${step.label}-${index}`} className="flex items-start gap-2 text-ui-sm leading-5">
                                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dotTone(step.tone)}`} />
                                <span className="min-w-0">
                                    <span className="text-zinc-500">{step.label}: </span>
                                    <span className={`${textTone(step.tone)} line-clamp-2`} title={step.value}>{step.value}</span>
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
};

/**
 * "Wait for confirmation" — for setups that are still a valid watch (Low /
 * Medium, or an explicit wait recommendation). Shows the exact trigger that
 * would make the setup tradeable instead of treating uncertainty as Avoid.
 */
export const WaitForConfirmationBanner: React.FC<{ analysis: TradeAnalysis }> = ({ analysis }) => {
    const trigger = confirmationTrigger(analysis, { skipInvalidationSource: true });
    if (!trigger) return null;
    return (
        <div className="rounded-control border border-amber-500/15 bg-amber-500/[0.03] px-3 py-2">
            <div className="text-ui-xs font-semibold uppercase tracking-widest text-amber-300">Wait for confirmation</div>
            <p className="mt-1 text-ui-base leading-6 text-zinc-300">
                This setup is a watch, not a no-trade. Enter when {trigger.text}
                {trigger.level ? ` (${trigger.level})` : ''}.
            </p>
        </div>
    );
};
