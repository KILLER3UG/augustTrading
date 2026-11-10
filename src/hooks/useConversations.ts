import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Conversation, Message, MessageRole } from '../types';
import { messageTraceText } from '../utils/traceText';
import { MANUAL_TITLE_MAX_CHARS } from '../utils/conversationTitle';
import { generateSessionTitle, modelTitleMayReplace } from '../services/trade/sessionTitle';
import {
    activeIndex,
    hasVersions,
    mergeParked,
    popParked,
    pushEdit,
    splitAt,
    stepIndex,
    versionCount,
    type PromptEdit,
    type TurnSnapshot,
} from '../utils/messageVersions';

// No cap on messages per conversation (owner ruling, 2026-10-27: "store
// everything"). There used to be a 200-message trim here, FIFO above the first
// row, justified by save latency and blob size — and it was a SILENT one: the
// 201st turn evicted an earlier exchange that later re-analyses could still be
// referencing, so the trader's history shortened without saying so. The whole
// messages array is re-serialised on the debounced save either way; that cost is
// now the owner's to accept rather than one this hook pays on their behalf.
// The one limit that remains on this path is the storage quota itself, and a
// refused write is reported (MemoryFilesService.getNotebookWriteFailure), not
// swallowed.

/** A manual title is a NAME, not a message: whitespace is collapsed and the
 *  shared ceiling stops a paste from becoming the whole row. No word-count
 *  brief — a trader may call a thread "ETH" if that is what it is. */

type ConversationRenameApplier = (id: string, title: string) => void;

/** The mounted store's rename writer. `ConversationGroups` renders rows for
 *  two surfaces and receives the list READ-ONLY, so the write goes through
 *  this one binding rather than a second copy of the list (the same reason the
 *  dock's rows write through chatStore). */
let applyConversationRename: ConversationRenameApplier | null = null;

/**
 * Rename one conversation from a shared row menu (`ConversationGroups`).
 *
 * A manual rename stamps `titleSource: 'user'`, which the model-title path
 * refuses to overwrite — so the trader's name is final from then on. No-op
 * when no store is mounted (a bare row/test render).
 */
export const renameConversationRow = (id: string, title: string): void => {
    applyConversationRename?.(id, title);
};

export function useConversations() {
    // Master state for all conversation data.
    const [conversationHistory, setConversationHistory] = useState<Conversation[]>([]);
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

    // Derived state for the active conversation.
    const activeConversation = useMemo(() =>
        conversationHistory.find(c => c.id === activeConversationId),
        [conversationHistory, activeConversationId]);

    const messages = activeConversation?.messages || [];

    // Ref to hold the latest messages for async access to prevent stale
    // closures. Assigned during render (not in a post-commit effect) so async
    // code reading it after an updateMessages call can never see the previous
    // array — the effect lag forced multiple in-file workarounds elsewhere
    // (matches the loggedTradesRef pattern in App).
    const messagesRef = useRef<Message[]>([]);
    messagesRef.current = messages;

    // Per-conversation selections. Provider enable/disable + per-provider model
    // selection now live in ProviderConfig (global, via useProviderConfigs).
    // The conversation only tracks the moderator provider/model and the vision model.
    const selectedOcrModel = activeConversation?.ocrModel || '';
    const moderatorProviderId = activeConversation?.moderatorProviderId || '';
    const moderatorModel = activeConversation?.moderatorModel || '';

    const updateMessages = useCallback((updater: (prevMessages: Message[]) => Message[], conversationId: string | null = activeConversationId) => {
        setConversationHistory(prevHistory => {
            return prevHistory.map(conv => {
                if (conv.id === conversationId) {
                    // Every turn the updater returns is kept. The trim that used
                    // to live here evicted the trader's own history; see the
                    // note at the top of this file.
                    return { ...conv, messages: updater(conv.messages) };
                }
                return conv;
            });
        });
    }, [activeConversationId]);

    const updateActiveConversation = useCallback((updater: (conv: Conversation) => Conversation) => {
        setConversationHistory(prev => prev.map(c =>
            c.id === activeConversationId ? updater(c) : c
        ));
    }, [activeConversationId]);

    /* ── Titles: the model names a thread once, the trader can name it for good
       ────────────────────────────────────────────────────────────────────────
       The fallback needs no write — `conversationTitle` derives it from the
       first question. These three pieces are the OTHER half: the trader's
       rename (which must win forever) and the one background model call that
       replaces that fallback. */

    // Bound while the store is mounted; `renameConversationRow` is how the
    // shared row menu reaches it.
    useEffect(() => {
        applyConversationRename = (id, title) => {
            const clean = title.replace(/\s+/g, ' ').trim().slice(0, MANUAL_TITLE_MAX_CHARS);
            if (!clean) return;
            setConversationHistory(prev => prev.map(c => (
                c.id === id ? { ...c, title: clean, titleSource: 'user' as const } : c
            )));
        };
        return () => { applyConversationRename = null; };
    }, []);

    /** Apply a model title ONLY while the row still carries its fallback — a
     *  manual rename and an earlier model name both refuse it. */
    const applyModelTitle = useCallback((conversationId: string, title: string): void => {
        setConversationHistory(prev => prev.map(c => (
            c.id === conversationId && modelTitleMayReplace(c.titleSource)
                ? { ...c, title, titleSource: 'model' as const }
                : c
        )));
    }, []);

    /** One attempt per conversation per mount. A provider that cannot answer
     *  must not be re-asked after every later turn. */
    const titledConversations = useRef<Set<string>>(new Set());

    /** Conversations whose last row this mount has SEEN streaming. A title is
     *  generated only for a turn that settled HERE; without this, opening the
     *  app would spend one background call per legacy thread at once. */
    const sawStreaming = useRef<Set<string>>(new Set());

    /** The SETTLE boundary, cheap to compare: a turn finishing flips the last
     *  row's `isStreaming`, a new row changes the length. Streaming text churn
     *  changes neither, so the effect below does not run per token. */
    const settleSignature = useMemo(
        () => conversationHistory.map(c => (
            `${c.id}:${c.messages.length}:${c.messages[c.messages.length - 1]?.isStreaming ? 'live' : 'idle'}:${c.titleSource ?? ''}`
        )).join('|'),
        [conversationHistory],
    );

    // After the FIRST exchange settles, ask the background model for a name.
    // Fire-and-forget: the promise is never awaited and a null/throw leaves
    // the first-message fallback exactly as it was.
    useEffect(() => {
        for (const conv of conversationHistory) {
            if (conv.messages[conv.messages.length - 1]?.isStreaming) sawStreaming.current.add(conv.id);
        }
        for (const conv of conversationHistory) {
            if (!sawStreaming.current.has(conv.id)) continue;
            // Only at a SETTLE — never rename a thread under a live answer.
            if (conv.messages[conv.messages.length - 1]?.isStreaming) continue;
            if (!modelTitleMayReplace(conv.titleSource)) continue;
            if (titledConversations.current.has(conv.id)) continue;
            const questionAt = conv.messages.findIndex(m => m.role === MessageRole.USER && (m.text || '').trim());
            if (questionAt < 0) continue;
            const answer = conv.messages.slice(questionAt + 1).find(m => (
                m.role === MessageRole.AI && !m.isStreaming && (m.text || '').trim().length > 0
            ))?.text;
            if (!answer) continue;
            titledConversations.current.add(conv.id);
            void generateSessionTitle({ question: conv.messages[questionAt].text, answer })
                .then(title => { if (title) applyModelTitle(conv.id, title); })
                .catch(() => { /* the first-message fallback stays */ });
        }
    }, [settleSignature, applyModelTitle]);

    /** Store the silent compaction digest. Keyed by id, not by "active": the
     *  summary finishes on an idle callback and the trader may well have
     *  switched conversations by then. */
    const setThreadSummary = useCallback((conversationId: string, threadSummary: string) => {
        setConversationHistory(prev => prev.map(c =>
            c.id === conversationId ? { ...c, threadSummary } : c
        ));
    }, []);

    const handleSetVisionModel = (modelId: string) => updateActiveConversation(c => ({ ...c, ocrModel: modelId }));
    const handleSetSelectedOcrModel = (id: string) => updateActiveConversation(c => ({ ...c, ocrModel: id }));

    /* ── Revert and versions ───────────────────────────────────────────────
       The rule lives on the CONVERSATION store, not in a surface. One
       conversation has two readers — the Agents surface and the Chart AI dock,
       joined by `entriesForSession` — and a revert applied inside one of them
       would appear and then be undone by the other's next merge. Here there is
       one writer, and both readers see the same thread.

       The counting and the list surgery are in `utils/messageVersions.ts`; this
       file only knows how a `Message` maps onto a generation. */

    /** A message's live fields, as one generation. */
    const snapshot = (m: Message): TurnSnapshot => ({
        text: m.text ?? '',
        reasoning: messageTraceText(m),
        processes: m.thoughtProcesses,
        tools: m.toolEvents ?? [],
        toolIds: m.toolIds ?? [],
        actions: m.toolActions ?? [],
        workedMs: typeof m.runStats?.durationMs === 'number' ? m.runStats.durationMs : undefined,
        effort: m.runStats?.effort,
        error: m.error,
        at: Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : Date.now(),
    });

    /** Make a generation the live one. Everything a turn is made of travels
     *  with it — the answer, its trace, its tool trail and the ids that open
     *  the real payloads — so stepping between versions cannot show one
     *  answer's prose over another's work. */
    const withSnapshot = (m: Message, snap: TurnSnapshot): Message => ({
        ...m,
        text: snap.text,
        thoughtProcesses: snap.processes,
        toolEvents: snap.tools.length ? snap.tools : undefined,
        toolIds: snap.toolIds.length ? snap.toolIds : undefined,
        toolActions: snap.actions?.length ? snap.actions : undefined,
        error: snap.error,
        // The run ledger is the pipeline's own record; only the two numbers a
        // generation actually changes are rewritten, and a row that never had
        // one stays without one rather than gaining a fabricated stub.
        runStats: m.runStats
            ? { ...m.runStats, durationMs: snap.workedMs ?? m.runStats.durationMs, effort: snap.effort ?? m.runStats.effort }
            : m.runStats,
    });

    /** Take every turn AFTER `messageId` off the live thread and park it.
     *  Returns how many turns moved; 0 means nothing did, which is also the
     *  answer for a stale id — the thread is left intact rather than truncated
     *  on a bookkeeping miss. */
    const revertToMessage = useCallback((messageId: string): number => {
        let moved = 0;
        updateActiveConversation(conv => {
            const { keep, parked } = splitAt(conv.messages, messageId);
            if (!parked) return conv;
            moved = parked.rows.length;
            return { ...conv, messages: keep, parked: [...(conv.parked ?? []), parked] };
        });
        return moved;
    }, [updateActiveConversation]);

    /** Put the most recently parked tail back. A turn that has been re-run in
     *  the meantime is not duplicated — `mergeParked` drops the id it already
     *  has live. Returns the number of turns restored. */
    const restoreParkedTurns = useCallback((): number => {
        let back = 0;
        updateActiveConversation(conv => {
            const popped = popParked(conv.parked);
            if (!popped.rest) return conv;
            const merged = mergeParked(conv.messages, popped.rows);
            back = merged.length - conv.messages.length;
            return { ...conv, messages: merged, parked: popped.rest.length ? popped.rest : undefined };
        });
        return back;
    }, [updateActiveConversation]);

    /** Edit a prompt the trader already sent. The words they first sent are kept
     *  on the row, and the answer that grew from them becomes a generation of
     *  the SAME row rather than a second message — one question, its versions.
     *  Everything after it is parked by the same rule a revert uses, so the
     *  caller can re-run the edited question without the old thread trailing it.
     *
     *  Returns the superseded answer so the caller can hand it to the re-run. */
    const editMessageText = useCallback((messageId: string, newText: string): {
        ok: boolean; parked: number; prior: PromptEdit[];
    } => {
        let out = { ok: false, parked: 0, prior: [] as PromptEdit[] };
        updateActiveConversation(conv => {
            const idx = conv.messages.findIndex(m => m.id === messageId);
            if (idx < 0) return conv;
            const target = conv.messages[idx];
            if (target.role !== MessageRole.USER) return conv;   // only a prompt you sent
            const trimmed = newText.trim();
            if (!trimmed || trimmed === target.text) return conv; // nothing changed, nothing recorded
            const edits = pushEdit(target.edits, target.text, Date.now());
            const { keep, parked } = splitAt(
                conv.messages.map((m, i) => (i === idx ? { ...m, edits, text: trimmed } : m)),
                messageId,
            );
            out = { ok: true, parked: parked?.rows.length ?? 0, prior: edits };
            return {
                ...conv,
                messages: keep,
                parked: parked ? [...(conv.parked ?? []), parked] : conv.parked,
            };
        });
        return out;
    }, [updateActiveConversation]);

    /** Step the answer shown between the versions this row holds. */
    const stepMessageGeneration = useCallback((messageId: string, delta: number): void => {
        updateMessages(prev => prev.map(m => {
            if (m.id !== messageId || !hasVersions(m)) return m;
            const to = stepIndex(m, delta);
            const count = versionCount(m);
            const gens = m.gens ?? [];
            // The newest generation is the live row itself, so the last index
            // means "exchange whatever is parked for what is showing".
            const target = to === count - 1 ? snapshot(m) : gens[to];
            if (!target) return m;
            const nextGens = to === count - 1
                ? gens
                : gens.map((g, i) => (i === to ? snapshot(m) : g));
            return withSnapshot({ ...m, gens: nextGens }, { ...target, at: target.at });
        }));
    }, [updateMessages]);

    /** Whether a row can be stepped, so the host draws a stepper only where
     *  there is a choice to make. */
    const versionInfo = useCallback((m: Message) => ({
        show: hasVersions(m),
        index: activeIndex(m),
        total: versionCount(m),
    }), []);

    return {
        conversationHistory,
        setConversationHistory,
        activeConversationId,
        setActiveConversationId,
        activeConversation,
        messages,
        messagesRef,
        updateMessages,
        updateActiveConversation,
        setThreadSummary,
        selectedOcrModel,
        moderatorProviderId,
        moderatorModel,
        handleSetVisionModel,
        handleSetSelectedOcrModel,
        revertToMessage,
        restoreParkedTurns,
        editMessageText,
        stepMessageGeneration,
        versionInfo,
    };
}
