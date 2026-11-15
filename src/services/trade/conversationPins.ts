/**
 * conversationPins — the trader's own "keep this at the top of the list".
 *
 * The reference's sidebar groups its conversations Pinned / Recent, and a
 * Pinned group with no way to pin would be a dead affordance. So the pin is
 * real and stored: one id set per profile, keyed by the conversation's stable
 * id, read back before it is echoed to the list (a quota refusal must not leave
 * a row sitting in a group it was never saved to).
 *
 * Nothing here sorts or filters — the list decides what a pin MEANS on screen;
 * this module only answers "is this id pinned" and "put it / take it off".
 */

const KEY = 'conversation_pins_v1';

const keyFor = (username?: string): string =>
    `${KEY}:${(username || 'default').trim() || 'default'}`;

/** The pinned ids, oldest writes last. Corrupt or non-array storage reads as
 *  "nothing pinned" rather than throwing into the sidebar's render. */
export const readConversationPins = (username?: string): string[] => {
    try {
        const raw = localStorage.getItem(keyFor(username));
        const parsed = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
        return [];
    }
};

/** Flip one id and return the set the STORE actually holds. Callers paint from
 *  the returned value, never from their own guess about what the write did. */
export const toggleConversationPin = (id: string, username?: string): string[] => {
    const current = readConversationPins(username);
    const next = current.includes(id)
        ? current.filter(pinned => pinned !== id)
        : [...current, id];
    try {
        localStorage.setItem(keyFor(username), JSON.stringify(next));
    } catch {
        // Storage refused (private mode, quota). Report the truth: unchanged.
        return current;
    }
    return readConversationPins(username);
};
