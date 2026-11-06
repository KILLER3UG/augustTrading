import React from 'react';
import { TradeAnalysis } from '../../types';
import { WaitForConfirmationBanner, WhyAvoidPanel } from './WhyAvoidPanel';

/**
 * VerdictAudit — the one home for "why did this run say what it said".
 *
 * It renders what the VERDICT ITSELF supports: the structured why-avoid
 * breakdown for a decline, and the wait-for-confirmation trigger for a watch.
 * The forensic panels that used to sit here — an evidence pack and a stage
 * ladder read off `Message.evidencePack` / `Message.runContract` — were deleted
 * on 2026-11-06: no live path writes either field, so the panels could only
 * ever show bytes a probe had seeded. A rendered row a real turn cannot produce
 * is not evidence, it is a prop.
 *
 * Deliberately a child of neither surface: it takes the verdict pieces a host
 * already has rather than a `Message`, because the dock does not hold a
 * `Message` (it holds a flattened answer plus the id of one) and copying an
 * analysis into the persisted chat store to make the prop fit would bloat
 * every stored entry.
 */

/** A directional call the user should not act on yet. */
const WATCH_CONFIDENCES = new Set(['low', 'medium']);

/** Mutually exclusive by definition: a watch must never read as a no-trade,
 *  and a no-trade must never offer a "get in when X" line. Both fall out of
 *  the verdict itself, so neither needs the pipeline to still be running. */
const isDeclined = (analysis: TradeAnalysis): boolean => {
    const direction = analysis.direction ?? '';
    return (direction !== 'Long' && direction !== 'Short')
        || (analysis.confidence ?? '').toLowerCase() === 'avoid';
};

const isWatch = (analysis: TradeAnalysis): boolean =>
    !isDeclined(analysis) && WATCH_CONFIDENCES.has((analysis.confidence ?? '').toLowerCase());

/**
 * Will the audit render anything for this verdict?
 *
 * The hosts put this inside a disclosure, and a disclosure whose body is empty
 * is a control that opens to nothing — which is exactly what this component
 * became for a plain Long/High answer once the forensic panels behind it were
 * deleted. Exported so the two hosts ask the SAME question the render asks,
 * rather than each keeping its own copy of "is there something to inspect".
 */
export const verdictNeedsAudit = (analysis: TradeAnalysis): boolean =>
    isDeclined(analysis) || isWatch(analysis);

/**
 * Anything thrown inside the audit is caught here and renders nothing.
 *
 * This is not a way to swallow bugs — the panels have their own tests, and the
 * two crash shapes found when this block was first mounted are fixed where they
 * live. It exists because of where the block sits: it renders inside a
 * transcript's `messages.map()`, so a throw from a decorative panel does not
 * lose the panel, it loses EVERY message after it and leaves the user with a
 * conversation that silently stops rendering. The verdict answer itself is
 * owned by the host and stays on screen either way.
 */
class AuditBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: unknown): void {
        console.warn('[VerdictAudit] suppressed an audit render failure:', error instanceof Error ? error.message : error);
    }

    render(): React.ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

interface VerdictAuditProps {
    analysis: TradeAnalysis;
    /** A host that renders the verdict inside a chat bubble wants tighter
     *  spacing than one rendering it as a panel. */
    className?: string;
}

const VerdictAudit: React.FC<VerdictAuditProps> = ({
    analysis, className = '',
}) => {
    const declined = isDeclined(analysis);
    const watch = isWatch(analysis);

    if (!declined && !watch) return null;

    return (
        <AuditBoundary>
            <div className={className} data-testid="verdict-audit">
                {declined && <WhyAvoidPanel analysis={analysis} />}
                {watch && <WaitForConfirmationBanner analysis={analysis} />}
            </div>
        </AuditBoundary>
    );
};

export default React.memo(VerdictAudit);
