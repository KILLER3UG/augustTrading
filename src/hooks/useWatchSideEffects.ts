import { useEffect, useRef } from 'react';
import { Conversation, Message, TradeOutcome } from '../types';
import { OutcomeAutopilotService, AutopilotResolution } from '../services/ui/OutcomeAutopilotService';
import { appendWatchEpisode } from '../utils/watchList';
import { autoJournalPolicyFor } from '../utils/autoJournalRules';
import { settlementActionFor, SETTLEMENT_UNDO_MS } from '../utils/outcomeSettlement';
import { getHarnessSettings } from '../utils/harnessSettings';
import { describeWatchTick } from '../utils/watchTicks';
import { ticketExpiryLine } from '../utils/paperPnl';

interface WatchSideEffectsArgs {
    messagesRef: React.MutableRefObject<Message[]>;
    setConversationHistory: React.Dispatch<React.SetStateAction<Conversation[]>>;
    setAutopilotResolutions: React.Dispatch<React.SetStateAction<Record<string, AutopilotResolution>>>;
    toast: {
        success: (title: string, message?: string, action?: { label: string; onClick: () => void }) => void;
        warning: (title: string, message?: string) => void;
    };
    confirmAutopilot: React.MutableRefObject<(messageId: string) => void>;
    activeUsername?: string | null;
}

/** Autopilot ticks, watched auto-log with undo, and ticket expiry episodes. */
export const useWatchSideEffects = ({
    messagesRef,
    setConversationHistory,
    setAutopilotResolutions,
    toast,
    confirmAutopilot,
    activeUsername,
}: WatchSideEffectsArgs): void => {
    const pendingTimers = useRef<Map<string, number>>(new Map());
    const expiredIds = useRef<Set<string>>(new Set());

    useEffect(() => {
        const unsubscribe = OutcomeAutopilotService.subscribe((messageId, resolution) => {
            setAutopilotResolutions(prev => ({ ...prev, [messageId]: resolution }));
            const watched = messagesRef.current.find(m => m.id === messageId)?.watched;
            const coin = messagesRef.current.find(m => m.id === messageId)?.analysis?.coinName;
            const policy = autoJournalPolicyFor(coin, activeUsername || undefined);
            const action = settlementActionFor({
                watched: !!watched,
                policy,
                settlement: getHarnessSettings().outcomeSettlement,
                expiredOpen: resolution.expiredOpen,
            });
            if (action === 'ignore') return;
            if (action === 'notify-only') {
                toast.success('Autopilot: outcome detected', resolution.detail);
                return;
            }
            if (action === 'shadow') {
                // The shadow month: resolve and show, never record. The
                // disagreement between this banner and what the trader would
                // confirm is the evidence that decides whether automatic is safe.
                // One announcement per outcome: the setup stays watched across
                // boots, and without the persisted mark the same old result
                // re-toasted on every launch.
                if (OutcomeAutopilotService.markShadowNotified(messageId)) {
                    toast.success('Shadow: outcome detected (not recorded)', `${resolution.detail} — settlement is in shadow mode.`);
                }
                return;
            }
            if (action === 'log-now') {
                confirmAutopilot.current(messageId);
                return;
            }
            const existing = pendingTimers.current.get(messageId);
            if (existing) window.clearTimeout(existing);
            const timer = window.setTimeout(() => {
                pendingTimers.current.delete(messageId);
                confirmAutopilot.current(messageId);
            }, SETTLEMENT_UNDO_MS);
            pendingTimers.current.set(messageId, timer);
            toast.success('Logging in 15s', 'Undo to keep this setup open.', {
                label: 'Undo',
                onClick: () => {
                    const id = pendingTimers.current.get(messageId);
                    if (id) window.clearTimeout(id);
                    pendingTimers.current.delete(messageId);
                },
            });
        });
        const unsubscribeTicks = OutcomeAutopilotService.subscribeTicks((messageId, price, previousPrice) => {
            setConversationHistory(prev => prev.map(conv => {
                const index = conv.messages.findIndex(m => m.id === messageId);
                if (index < 0) return conv;
                const msg = conv.messages[index];
                if (!msg.watched || !msg.analysis) return conv;
                const tick = describeWatchTick(msg.analysis, price, previousPrice);
                if (!tick) return conv;
                const nextMessages = [...conv.messages];
                nextMessages[index] = appendWatchEpisode(msg, tick.kind, tick.detail);
                return { ...conv, messages: nextMessages };
            }));
        });
        return () => {
            unsubscribe();
            unsubscribeTicks();
        };
    }, [messagesRef, setAutopilotResolutions, setConversationHistory, toast, confirmAutopilot, activeUsername]);

    useEffect(() => {
        const scan = (): void => {
            setConversationHistory(prev => prev.map(conv => {
                let changed = false;
                const nextMessages = conv.messages.map(m => {
                    if (!m.watched || !m.analysis || (m.outcome && m.outcome !== TradeOutcome.PENDING)) return m;
                    const expiry = ticketExpiryLine(m.analysis);
                    if (!expiry?.expired || expiredIds.current.has(m.id)) return m;
                    expiredIds.current.add(m.id);
                    changed = true;
                    return appendWatchEpisode(m, 'expired', expiry.line);
                });
                return changed ? { ...conv, messages: nextMessages } : conv;
            }));
        };
        scan();
        const id = window.setInterval(scan, 30_000);
        return () => window.clearInterval(id);
    }, [setConversationHistory, toast]);
};
