/**
 * InlineVerdict — the decision table a settled verdict leaves behind.
 *
 * This lived inside `AgentsView`, which made the Agents surface the only home that
 * could draw it. The Chart AI panel drew `VerdictAudit` on its own instead, and
 * that component returns null for a plain Long/High verdict carrying no evidence
 * pack or stage ladder — so ONE conversation showed ENTRY/STOP/TARGET/
 * PROBABILITY on one surface and bare prose on the other. That is exactly the
 * split the merged thread exists to close, and the fix is one renderer rather
 * than a second card: the audit stays folded into this component's disclosure,
 * so a home that draws the table cannot draw the forensic block twice.
 */

import React from 'react';

import type { TradeAnalysis } from '../../types/analysis';
import { fmtPercent } from '../../utils/formatters';
import { fmtRiskReward } from '../../utils/riskReward';
import { ChevronDown } from '../shared/Icons';
import StatusPill, { VerdictReviewPill } from '../ui/StatusPill';
import VerdictAudit, { verdictNeedsAudit } from './VerdictAudit';

const VerdictLine: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="font-mono text-ui-dense font-medium tabular-nums text-zinc-100">{value}</span>
    </div>
);

const InlineVerdict: React.FC<{
    analysis?: TradeAnalysis;
}> = ({ analysis }) => {
    const a = analysis;
    if (!a) return null;
    const up = a.direction === 'Long';
    const down = a.direction === 'Short';
    return (
        <div className="mt-2.5 w-full max-w-lg border-t border-zinc-800/80 pt-2.5"
            data-testid="inline-verdict">
            <div className="mb-2 flex items-center gap-2">
                <StatusPill tone={up ? 'up' : down ? 'down' : 'neutral'} kicker>
                    {a.direction ?? 'No trade'}
                </StatusPill>
                {/* Quarantine. An integrity gate OVERRODE this direction, so
                    the badge to its left is a measurement failure — not a
                    deliberate no-trade. The Journal has always said so and this
                    surface rendered the same plan as a confident Neutral, which
                    is how a truncated plan shipped as a tradeable verdict. Both
                    homes now draw ONE pill, so they cannot drift apart again. */}
                {a.verdictReview && (
                    <VerdictReviewPill reason={a.verdictReview.reason} data-testid="verdict-review" />
                )}
                <span className="truncate text-ui-caption font-semibold text-zinc-100" title={a.coinName ?? 'setup'}>{a.coinName ?? 'setup'}</span>
                {a.rrRatio && (
                    <span className="rounded-control border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-xs font-medium text-zinc-300">
                        {fmtRiskReward(a.rrRatio, 1)} R:R
                    </span>
                )}
                {/* Confidence carries a LABEL, like every other value on this
                    card — an unlabelled `MEDIUM` in mono gray is an affordance
                    that says nothing about what it is. */}
                {a.confidence && (
                    <span className="ml-auto flex items-baseline gap-1.5">
                        <span className="font-mono text-ui-xs uppercase tracking-wider text-zinc-500">confidence</span>
                        <span className="font-mono text-ui-dense font-medium tabular-nums text-zinc-100">{a.confidence}</span>
                    </span>
                )}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-control border border-hairline bg-white/[0.02] p-2.5">
                <VerdictLine label="entry" value={a.entryPoints?.[0]?.price ?? '—'} />
                <VerdictLine label="stop" value={a.stopLoss ?? '—'} />
                <VerdictLine label="target" value={a.takeProfit?.[0]?.price ?? '—'} />
                {typeof a.probability === 'number' && <VerdictLine label="probability" value={fmtPercent(a.probability, 0)} />}
            </div>
            {/* Progressive disclosure for the audit — rendered ONLY when the
                verdict actually needs explaining (a decline or a watch). An
                always-on shell whose body returns null is a control that opens
                to nothing. */}
            {verdictNeedsAudit(a) && (
                <details className="group/audit mt-2" open>
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 py-1 text-ui-sm font-semibold text-zinc-500 transition-colors hover:text-zinc-300 list-none">
                        <ChevronDown className="h-3 w-3 transition-transform group-open/audit:rotate-180" aria-hidden="true" />
                        <span>Inspect evidence & gate</span>
                    </summary>
                    <div className="mt-1.5 border-t border-zinc-800/60 pt-1.5">
                        <VerdictAudit
                            analysis={a}
                            className="mt-1"
                        />
                    </div>
                </details>
            )}
        </div>
    );
};

export default InlineVerdict;
