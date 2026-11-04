/**
 * The name of a conversation, derived once for every surface that shows one.
 *
 * Nothing in the app titles a conversation — `title` stays empty unless an
 * import supplied it — so reading the raw field gave the sidebar a wall of
 * "New chat" rows and the content bar a permanent "Desk". The fallback chain
 * is the trader's own first question, which is what the old Agents rail showed
 * and what the reference's sidebar lists.
 *
 * Code-calculated only: no model call, no invented name. A conversation with
 * no user text keeps the caller's own fallback rather than printing an empty
 * label.
 */
import { MessageRole, type Conversation } from '../types';

const MAX_TITLE = 64;

export const conversationTitle = (
    conversation: Conversation | null | undefined,
    fallback = 'New chat',
): string => {
    const stored = conversation?.title?.trim();
    if (stored) return stored;
    const firstUser = conversation?.messages.find(
        m => m.role === MessageRole.USER && (m.text || '').trim(),
    );
    const asked = (firstUser?.text || '').replace(/\s+/g, ' ').trim();
    if (!asked) return fallback;
    return asked.length > MAX_TITLE ? `${asked.slice(0, MAX_TITLE - 3).trimEnd()}…` : asked;
};
