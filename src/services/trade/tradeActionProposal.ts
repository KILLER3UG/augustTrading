/**
 * tradeActionProposal — the agent's PROPOSED action on a trade the trader
 * already armed, and what the trader did with it.
 *
 * WHY THIS EXISTS. `update_trade` moves the levels on an armed plan and
 * `close_trade` closes it. Both are AUTHORITY changes: a tool the model can
 * call is a capability the model has, so neither may act on the call. Both
 * record a proposal here, the transcript renders it as a card, and the trader's
 * confirm is the only thing that applies it. That is the whole of principle 5:
 * an authority change is never hidden, and never dressed up as a prep step.
 *
 * The shape deliberately mirrors `settlementCorrection` — keyed by the trade's
 * id, a proposal that resolves on a decision, and a confirmed row that cannot
 * be re-opened. One pattern, two cards, so a reader who knows one knows both.
 *
 * The store holds NO authority. It records intent; it never applies. Applying
 * is the confirm's job, through the journal's own writers.
 */

/** What the agent is proposing to do to an armed plan. */
export type TradeActionKind = 'update' | 'close';

export interface TradeActionProposal {
    id: string;
    kind: TradeActionKind;
    /** The armed plan this acts on — the join key and the card's identity. */
    planId: string;
    /** Why, in the agent's words. Printed on the card. */
    reason: string;
    /** `update` only: the replacement levels. Omitted fields are left alone. */
    entry?: number;
    stopLoss?: number;
    takeProfits?: number[];
}

export type TradeActionState = 'confirmed' | 'dismissed';

export type TradeActionRefusal =
    | 'an action needs the plan id it acts on'
    | 'an action needs a reason the trader can read'
    | 'a level update must change at least one level - entry, stopLoss or takeProfits'
    | 'takeProfits must be 1 to 5 prices, in order'
    | 'levels must be finite numbers';

export type TradeActionCheck =
    | { ok: true; proposal: TradeActionProposal }
    | { ok: false; refused: TradeActionRefusal };

const MAX_PROPOSALS = 500;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate BEFORE a card exists. Pure and exported: the executor refuses on
 *  this and the contract check pins it, so a proposal that would move nothing,
 *  or move a level to a non-number, cannot be minted. */
export const checkTradeActionProposal = (input: unknown): TradeActionCheck => {
    const raw = (input ?? {}) as Partial<TradeActionProposal>;
    const kind: TradeActionKind = raw.kind === 'close' ? 'close' : 'update';
    const planId = typeof raw.planId === 'string' ? raw.planId.trim() : '';
    if (!planId) return { ok: false, refused: 'an action needs the plan id it acts on' };
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) return { ok: false, refused: 'an action needs a reason the trader can read' };

    if (kind === 'close') {
        return {
            ok: true,
            proposal: { id: `${kind}-${planId}`, kind, planId, reason },
        };
    }

    // `update`: at least one level must actually change, and every level given
    // must be a real number. A proposal that moves nothing is a card that lies
    // about doing work; a non-numeric level is a silent plausibility failure.
    const hasEntry = raw.entry !== undefined;
    const hasStop = raw.stopLoss !== undefined;
    const hasTps = Array.isArray(raw.takeProfits) && raw.takeProfits.length > 0;
    if (!hasEntry && !hasStop && !hasTps) {
        return { ok: false, refused: 'a level update must change at least one level - entry, stopLoss or takeProfits' };
    }
    if ((hasEntry && !finite(raw.entry)) || (hasStop && !finite(raw.stopLoss))) {
        return { ok: false, refused: 'levels must be finite numbers' };
    }
    let takeProfits: number[] | undefined;
    if (hasTps) {
        const list = raw.takeProfits as unknown[];
        if (list.length > 5 || !list.every(finite)) {
            return { ok: false, refused: 'takeProfits must be 1 to 5 prices, in order' };
        }
        takeProfits = list.map(Number);
    }
    return {
        ok: true,
        proposal: {
            id: `${kind}-${planId}`,
            kind,
            planId,
            reason,
            ...(hasEntry ? { entry: Number(raw.entry) } : {}),
            ...(hasStop ? { stopLoss: Number(raw.stopLoss) } : {}),
            ...(takeProfits ? { takeProfits } : {}),
        },
    };
};

const pending = new Map<string, TradeActionProposal>();
const decided = new Map<string, TradeActionState>();

/** Record a proposal. A plan the trader already CONFIRMED an action on is not
 *  re-opened: the decision they made is the record, and a second card for it
 *  would invite a second apply. */
export const proposeTradeAction = (input: unknown): TradeActionCheck => {
    const checked = checkTradeActionProposal(input);
    if (!checked.ok) return checked;
    if (decided.get(checked.proposal.planId) === 'confirmed') {
        return { ok: false, refused: 'an action needs the plan id it acts on' };
    }
    pending.set(checked.proposal.planId, checked.proposal);
    while (pending.size > MAX_PROPOSALS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }
    return checked;
};

/** The live proposal for a plan, or undefined. This is what the card renders. */
export const pendingTradeAction = (planId: string): TradeActionProposal | undefined =>
    pending.get(planId);

/** What the trader decided, or undefined while the card is still open. */
export const tradeActionStateOf = (planId: string): TradeActionState | undefined =>
    decided.get(planId);

/** The trader confirmed. Clears the proposal — the row is the record from here. */
export const confirmTradeAction = (planId: string): boolean => {
    if (!pending.has(planId)) return false;
    pending.delete(planId);
    decided.set(planId, 'confirmed');
    return true;
};

/** The trader declined. Resolves the card; the plan is untouched. */
export const dismissTradeAction = (planId: string): boolean => {
    if (!pending.has(planId)) return false;
    pending.delete(planId);
    decided.set(planId, 'dismissed');
    return true;
};

export const openTradeActionProposals = (): TradeActionProposal[] => [...pending.values()];

export const __clearTradeActionProposalsForTests = (): void => {
    pending.clear();
    decided.clear();
};