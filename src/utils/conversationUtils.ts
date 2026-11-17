import { Conversation, MessageRole } from '../types';
import { getHarnessSettings } from './harnessSettings';

/** The leverage a row was recorded under before the default became a setting.
 *  Only historical fallbacks may use it: stamping it on a NEW ticket would
 *  re-introduce the 100× default this change removes. */
export const LEGACY_LEVERAGE = 100;

/** The trader's leverage for a NEW session or ticket. */
export const defaultLeverage = (): number => getHarnessSettings().defaultLeverage;

export const createNewConversation = (): Conversation => {
  return {
    id: `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    // Fresh sessions start empty — the chat shows a centered input (no
    // hardcoded welcome bubble) and fills as messages are sent.
    messages: [],
    ocrModel: '',               // Set once a vision provider is configured
    moderatorProviderId: '',     // Set once providers are configured (defaults to first ready provider)
    moderatorModel: '',
    leverage: defaultLeverage(), // The trader's setting, not an app-wide 100×
  };
};

/** A session with no messages — the blank "new conversation" state. */
export const isEmptyConversation = (conv: Conversation): boolean =>
  (conv.messages ?? []).length === 0;

/**
 * A FAILED thread is a throwaway: it holds user prompts and — at most — AI
 * rows that carry an error and never became an answer. Nothing in it taught
 * the trader anything, so the next send may reuse it instead of minting a
 * twin (the starter-chip + failed-turn spam, owner 1.3.2). One real answer,
 * or any row still streaming, makes the thread real.
 */
export const isFailedOnlyConversation = (conv: Conversation): boolean => {
  const msgs = conv.messages ?? [];
  if (msgs.length === 0) return false;
  return msgs.every(m =>
    m.role === MessageRole.USER
    || (!!m.error && !m.isStreaming));
};

/** Blank OR failed-only — the two thread shapes a send may reuse. */
export const isThrowawayConversation = (conv: Conversation): boolean =>
  isEmptyConversation(conv) || isFailedOnlyConversation(conv);

/**
 * Prefer an existing blank session over creating another one.
 * Returns the active session if it is already blank, otherwise the most
 * recent other blank session (history is newest-first), otherwise null.
 */
export const findReusableEmptyConversation = (
  conversations: Conversation[],
  activeId: string | null | undefined,
): Conversation | null => {
  const active = conversations.find(c => c.id === activeId);
  if (active && isEmptyConversation(active)) return active;
  return conversations.find(c => c.id !== activeId && isEmptyConversation(c)) ?? null;
};

/**
 * The SEND path's reuse: blank OR failed-only threads are reusable, because
 * a retry or a starter-chip click into a thread whose turn never landed is
 * the same turn again — not a new thread. Ctrl+N keeps the blank-only rule
 * (findReusableEmptyConversation): "New" from a failed thread should give a
 * clean one, not redress the failure as new.
 */
export const findReusableThrowawayConversation = (
  conversations: Conversation[],
  activeId: string | null | undefined,
): Conversation | null => {
  const active = conversations.find(c => c.id === activeId);
  if (active && isThrowawayConversation(active)) return active;
  return conversations.find(c => c.id !== activeId && isThrowawayConversation(c)) ?? null;
};
