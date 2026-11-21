import { useCallback, useEffect, useRef } from 'react';
import { createNewConversation, isEmptyConversation, isThrowawayConversation } from '../utils/conversationUtils';
import type { ConfirmOptions } from '../components/shared/ConfirmDialog';
import type { Conversation, Message } from '../types';

export interface UseConversationHousekeepingArgs {
    conversationHistory: Conversation[];
    setConversationHistory: React.Dispatch<React.SetStateAction<Conversation[]>>;
    activeConversation: Conversation | undefined;
    activeConversationId: string | null;
    setActiveConversationId: React.Dispatch<React.SetStateAction<string | null>>;
    updateMessages: (updater: (prev: Message[]) => Message[], conversationId?: string) => void;
    /**
     * Stop a run.
     *
     * With a conversation id, it stops THAT conversation's run and nothing
     * else. With no id, it stops the run the trader can see (the active
     * conversation's) plus any run that belongs to a different trader.
     *
     * The optional id is what lets a DELETE stop the deleted conversation's
     * run while leaving every other thread's run alone.
     */
    handleCancelAnalysis: (conversationId?: string) => void;
    /** Optional predicate to verify whether an App conversation is also blank in
     *  the dock store (no dock entries, active stream, or panel/bot binding). */
    isConversationBlank?: (conv: Conversation) => boolean;
    /** Optional unified new-chat callback invoked by Ctrl/Cmd+N so the shortcut
     *  synchronizes both App conversations and the dock session store. */
    onNewConversationShortcut?: () => void;
    confirmDialog: (opts: ConfirmOptions) => Promise<boolean>;
    toast: { success: (title: string, message?: string) => void };
}

export interface UseConversationHousekeepingResult {
    handleClearAllConversations: () => Promise<void>;
    handleNewConversation: () => string;
    handleLoadConversation: (id: string) => void;
    handleDeleteConversations: (ids: string[]) => void;
    handleDeleteConversationFromSidebar: (id: string) => Promise<void>;
    handleDeleteSelectedConversations: (ids: string[]) => Promise<boolean>;
    handleEditUserMessage: (messageId: string, text: string) => void;
}

/**
 * Conversation housekeeping: create / reuse / load / delete sessions and
 * edit a sent user message. Also owns Ctrl/Cmd+N, the one shortcut here that
 * still points at something that exists.
 */
export const useConversationHousekeeping = (args: UseConversationHousekeepingArgs): UseConversationHousekeepingResult => {
    const {
        conversationHistory, setConversationHistory,
        activeConversation, activeConversationId, setActiveConversationId,
        updateMessages, handleCancelAnalysis,
        isConversationBlank, onNewConversationShortcut,
        confirmDialog, toast,
    } = args;

    // Owner 1.3.2, the cleanup half: the duplicate-thread spam the previous
    // layout minted (a failed turn left a non-blank thread, so every
    // starter-chip click after it opened a twin) is swept ONCE, when the
    // history first arrives from storage. A throwaway thread — blank, or a
    // prompt and its error that never became an answer — is kept if it is
    // the active one (the trader may be about to retry it) or the newest;
    // the rest go. A thread with a real answer in it is never touched.
    const pruneRef = useRef(false);
    useEffect(() => {
        if (pruneRef.current || conversationHistory.length === 0) return;
        pruneRef.current = true;
        setConversationHistory(prev => {
            const throwaways = prev.filter(isThrowawayConversation);
            if (throwaways.length <= 1) return prev;
            const newest = [...throwaways].sort((a, b) => b.timestamp - a.timestamp)[0];
            const keep = new Set<string>([activeConversationId ?? '', newest.id].filter(Boolean));
            const kept = prev.filter(c => !isThrowawayConversation(c) || keep.has(c.id));
            return kept.length === prev.length ? prev : kept;
        });
    }, [conversationHistory.length, activeConversationId]);

    const handleClearAllConversations = async () => {
        const prevHistory = conversationHistory;
        const prevActiveId = activeConversationId;
        const ok = await confirmDialog({
            title: 'Clear all conversation history?',
            message: `This will remove ${conversationHistory.length} conversation(s). You can undo this for 5 seconds.`,
            confirmLabel: 'Clear All',
            destructive: true,
            onUndo: () => {
                setConversationHistory(prevHistory);
                setActiveConversationId(prevActiveId);
                toast.success('Conversations restored');
            },
        });
        if (ok) {
            // Every conversation is going, so every conversation's run stops —
            // each one named, so a run in a thread the trader is not looking at
            // is stopped too. (The old code cancelled only the ACTIVE run and
            // left the rest streaming into conversations that no longer exist.)
            for (const c of conversationHistory) handleCancelAnalysis(c.id);
            const newConv = createNewConversation();
            setConversationHistory([newConv]);
            setActiveConversationId(newConv.id);
        }
    };

    // F3: New conversation (Ctrl/Cmd+N shortcut + palette action).
    // Reuse an existing truly-blank session instead of minting another empty one —
    // "New" from a filled or streaming session returns to the unused blank tab or mints one.
    const handleNewConversation = useCallback((): string => {
        // A new thread does NOT stop what is running in the old one. The run
        // belongs to the conversation it was typed in, and its answer is
        // written back into that conversation — so opening another thread
        // moves the view, not the run. (This used to cancel, which is the
        // defect E-45 names: the machinery to survive a switch was already
        // in the pipeline, and this call killed the run before it could be
        // used.)
        const blankCheck = isConversationBlank ?? isEmptyConversation;
        const active = conversationHistory.find(c => c.id === activeConversationId);
        const reusable = (active && blankCheck(active))
            ? active
            : conversationHistory.find(c => c.id !== activeConversationId && blankCheck(c)) ?? null;
        if (reusable) {
            if (reusable.id !== activeConversationId) {
                setConversationHistory(prev => [
                    { ...reusable, timestamp: Date.now() },
                    ...prev.filter(c => c.id !== reusable.id),
                ]);
                setActiveConversationId(reusable.id);
            }
            return reusable.id;
        }
        const newConv = createNewConversation();
        if (activeConversation) {
            newConv.ocrModel = activeConversation.ocrModel;
            newConv.leverage = activeConversation.leverage;
        }
        setConversationHistory(prev => [newConv, ...prev]);
        setActiveConversationId(newConv.id);
        return newConv.id;
    }, [conversationHistory, activeConversationId, activeConversation, isConversationBlank, setConversationHistory, setActiveConversationId]);

    // F3: Ctrl/Cmd+N = new conversation. ("/" used to focus the composer; the
    // #chat-composer element it looked up was deleted in 78bc027, so the branch
    // had been a permanent no-op and is gone. AgentsView now owns "/" for the
    // rail search.)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                if (onNewConversationShortcut) onNewConversationShortcut();
                else handleNewConversation();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [handleNewConversation, onNewConversationShortcut]);

    /**
     * Load a conversation — a VIEW change, not a run's death.
     *
     * This used to cancel the running analysis, which is the defect E-45
     * names: the pipeline already binds every async write to the conversation
     * the request started in, so the answer was designed to land in the thread
     * it was typed in — and the cancel killed it before that could happen.
     * Switching threads now moves the view; the run keeps going, and the
     * thread it belongs to says so while you are away.
     */
    const handleLoadConversation = useCallback((id: string) => {
        if (id !== activeConversationId) {
            setActiveConversationId(id);
        }
    }, [activeConversationId, setActiveConversationId]);

    const handleDeleteConversations = (ids: string[]) => {
        // Single source of truth: filter from the same list we store, so the
        // active-conversation fallback can't reference a stale snapshot.
        const remaining = conversationHistory.filter(c => !ids.includes(c.id));
        setConversationHistory(remaining);
        // A DELETED conversation's run must stop — its answer would land in a
        // thread that no longer exists. Only the deleted ones: a run in
        // another thread is none of this delete's business.
        for (const id of ids) handleCancelAnalysis(id);
        if (activeConversationId && ids.includes(activeConversationId)) {
            if (remaining.length > 0) {
                setActiveConversationId(remaining[0].id);
            } else {
                // Don't reuse via handleNewConversation — that would see the
                // pre-delete history and resurrect the session we just removed.
                const newConv = createNewConversation();
                setConversationHistory([newConv]);
                setActiveConversationId(newConv.id);
            }
        }
    };

    // Sidebar delete: confirm + undo (5s grace) before removing a session.
    const handleDeleteConversationFromSidebar = async (id: string) => {
        const ok = await confirmDialog({
            title: 'Delete session?',
            message: 'This conversation and its messages will be removed. Logged trades are kept.',
            confirmLabel: 'Delete',
        });
        if (ok) handleDeleteConversations([id]);
    };

    const handleDeleteSelectedConversations = async (ids: string[]): Promise<boolean> => {
        if (ids.length === 0) return false;
        const ok = await confirmDialog({
            title: `Delete ${ids.length} session${ids.length === 1 ? '' : 's'}?`,
            message: `This will remove ${ids.length} selected conversation${ids.length === 1 ? '' : 's'} and their messages. Logged trades are kept.`,
            confirmLabel: 'Delete selected',
            destructive: true,
        });
        if (!ok) return false;
        handleDeleteConversations(ids);
        return true;
    };

    // Edit a sent user message's text in place (persisted to history).
    const handleEditUserMessage = useCallback((messageId: string, text: string) => {
        updateMessages(prev => prev.map(m => m.id === messageId ? { ...m, text } : m));
    }, [updateMessages]);

    return {
        handleClearAllConversations,
        handleNewConversation,
        handleLoadConversation,
        handleDeleteConversations,
        handleDeleteConversationFromSidebar,
        handleDeleteSelectedConversations,
        handleEditUserMessage,
    };
};
