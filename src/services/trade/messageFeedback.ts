/**
 * messageFeedback — the trader's own mark on one answer.
 *
 * The reference puts copy / thumbs-up / thumbs-down beside a settled reply.
 * August already had copy and pin; a thumb with no consumer would be a dead
 * control, so this is a real annotation: the verdict is stored per profile,
 * keyed by the row's stable id, and the chips re-read it on mount. Nothing
 * claims it trains a model — it is the trader marking their own transcript,
 * exactly what the row says on hover ("saved with this row").
 */

export type MessageFeedbackVerdict = 'up' | 'down';

const KEY = 'message_feedback_v1';

const keyFor = (username?: string): string =>
    `${KEY}:${(username || 'default').trim() || 'default'}`;

const read = (username?: string): Record<string, MessageFeedbackVerdict> => {
    try {
        const raw = localStorage.getItem(keyFor(username));
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, MessageFeedbackVerdict> = {};
        for (const [id, verdict] of Object.entries(parsed as Record<string, unknown>)) {
            if (verdict === 'up' || verdict === 'down') out[id] = verdict;
        }
        return out;
    } catch {
        return {};
    }
};

export const readMessageFeedback = (messageId: string, username?: string): MessageFeedbackVerdict | null =>
    read(username)[messageId] ?? null;

/** Store (or clear) one verdict. Returns whether the STORE agrees — a quota
 *  refusal must not leave a chip lit over a mark that was never saved. */
export const setMessageFeedback = (
    messageId: string,
    verdict: MessageFeedbackVerdict | null,
    username?: string,
): boolean => {
    const all = read(username);
    if (verdict) all[messageId] = verdict;
    else delete all[messageId];
    try {
        localStorage.setItem(keyFor(username), JSON.stringify(all));
    } catch {
        return false;
    }
    const after = read(username)[messageId] ?? null;
    return after === verdict;
};
