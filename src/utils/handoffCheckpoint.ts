/**
 * handoffCheckpoint — the deterministic `/handoff` checkpoint: a compact,
 * model-free summary of what the desk is looking at RIGHT NOW, minted as the
 * first entry of a fresh session so a new thread starts warm.
 *
 * DETERMINISTIC on purpose: every line comes from the snapshot, the armed
 * plans and the store — never from the outgoing model's own prose, because a
 * checkpoint that trusts the leaving thread's self-summary is how a handoff
 * inherits the last thread's hallucinations.
 */

export interface HandoffInput {
    symbol: string;
    interval: string;
    markPrice: number | null;
    /** Evaluated drawings (shortId, label, prices) — the #D1..#Dn layer. */
    drawings: ReadonlyArray<{ shortId?: string; label?: string; kind: string; points: ReadonlyArray<{ p: number }> }>;
    /** Armed harness plans. */
    plans: ReadonlyArray<{ planId: string; symbol: string; direction: string; entry: number }>;
    /** The OUTGOING session's last trader question — context, quoted not trusted. */
    lastUserText: string | null;
    at?: number;
}

export const buildHandoffCheckpoint = (input: HandoffInput): string => {
    const lines: string[] = [
        `[HANDOFF CHECKPOINT — ${input.symbol} ${input.interval}${input.markPrice !== null && Number.isFinite(input.markPrice) ? ` · mark ${input.markPrice}` : ''}]`,
    ];
    const shapes = input.drawings
        .map(d => `${d.shortId ?? '#D?'} ${d.kind}${d.label ? ` "${d.label}"` : ''} @ ${d.points.map(p => p.p).join('/')}`)
        .slice(0, 8);
    lines.push(shapes.length > 0
        ? `Chart shapes: ${shapes.join(' · ')}`
        : 'Chart shapes: none on screen.');
    if (input.plans.length > 0) {
        lines.push(`Armed plans: ${input.plans.map(p => `${p.planId} ${p.direction} ${p.symbol} entry ${p.entry}`).join(' · ')}`);
    } else {
        lines.push('Armed plans: none.');
    }
    if (input.lastUserText) {
        lines.push(`Outgoing thread's last question (context, verify independently): "${input.lastUserText.slice(0, 160)}"`);
    }
    lines.push('Continue from here. Verify every number against a fresh read before acting on it.');
    return lines.join('\n');
};
