import React from 'react';

export type PillTone = 'up' | 'down' | 'warn' | 'info' | 'neutral';

/**
 * The theme's semantic colors, declared once. `up`/`down`/`warn` map to the
 * emerald / rose / amber families from index.css `@theme`, so a pill that
 * reads green here means GAIN or BULLISH everywhere in the app.
 */
const TONE: Record<PillTone, string> = {
    up: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    down: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    info: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
    neutral: 'border-hairline bg-white/[0.04] text-zinc-400',
};

interface StatusPillProps {
    tone?: PillTone;
    icon?: React.ReactNode;
    children: React.ReactNode;
    /** Uppercase micro-caps for state readouts, sentence case for data. */
    kicker?: boolean;
    className?: string;
    title?: string;
    'data-testid'?: string;
}

/** Small semantic pill — the one place a colored "this is up / this is a
 *  warning" chip is assembled, so tables and headers stop hand-rolling the
 *  same three border/bg/text classes. */
const StatusPill: React.FC<StatusPillProps> = ({
    tone = 'neutral',
    icon,
    children,
    kicker = false,
    className = '',
    title,
    ...rest
}) => (
    <span
        title={title}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-bold ${
            kicker ? 'text-ui-2xs uppercase tracking-widest' : 'text-ui-xs'
        } ${TONE[tone]} ${className}`.trim()}
        {...rest}
    >
        {icon}
        {children}
    </span>
);

export default React.memo(StatusPill);

/** The quarantined-verdict badge — ONE home, now that two surfaces draw it.
 *
 *  A `verdictReview` stamp means an integrity gate OVERRODE the direction (no
 *  aligned analyst cited, ungrounded levels, an unparseable or truncated plan),
 *  so the Neutral on the card is a MEASUREMENT FAILURE, never a deliberate
 *  no-trade. The Journal's row and the conversation's verdict card each used to
 *  carry a hand-copied twin; that is how the trade surface shipped a quarantined
 *  plan as a confident Neutral while the Journal called the same plan out. */
export const VerdictReviewPill: React.FC<{
    reason: string;
    className?: string;
    'data-testid'?: string;
}> = ({ reason, className, ...rest }) => (
    <StatusPill
        tone="warn"
        kicker
        className={className}
        title={`Quarantined verdict (${reason}) — a parse/integrity failure, not a neutral opinion`}
        {...rest}
    >
        Review
    </StatusPill>
);
