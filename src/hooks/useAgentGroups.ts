/**
 * useAgentGroups — runs a group ROOM:
 * group-rounds semantics in-process. Round 1 = the @mentioned members
 * (@everyone/all = fan-out parity with the old single pass); each turn is
 * fed ONLY the room messages newer than what that member last saw; a
 * reply that @mentions teammates sets next round's speakers; replying
 * exactly "(pass)" is silence — no bubble, no room entry; a round with no
 * mentions settles the room. Bounded by ROOM_ROUND_CAP rounds and
 * ROOM_TURN_CAP model turns per send. Replies stream into their own
 * message attributed by modelsUsed[providerId] = modelId.
 *
 * Learning (the room recorder): a room turn is a real turn — the speaker's
 * own notes ride its system prompt, its reply is stamped with the runId a
 * trade logged from it will carry, and at settlement each participant that
 * spoke earns ONE write-back (lesson line + trade fold) through the same
 * guard and injection record a 1:1 DM earns. Not one per reply: a bot that
 * takes three rounds must not accrue three lesson lines.
 *
 * The caller supplies message append/patch functions (App's
 * updateMessages) and the provider configs; the hook exposes the
 * activity entries ("X is working…", "✓ X replied", "○ X passed")
 * and the currently working bot id for the roster's active-now chip.
 */

import { useCallback, useRef, useState } from 'react';
import { MessageRole } from '../types/enums';
import { Message } from '../types/message';
import { ProviderConfig } from '../types/provider';
import { streamQuickResponse } from '../services/providers/GenericAnalysisService';
import { tryFetchHybridDataFromPromptWithCalibration } from '../services/analysis/HybridIntelligenceService';
import { AgentBot, findBotById } from '../services/agents/agentRoster';
import { readBotSystemMarkdown, readBotMemoryMarkdown } from '../services/bots/BotMemoryService';
import { settleMessageRow } from '../utils/rowSettlement';
import {
    ROOM_HUMAN_LABEL,
    ROOM_ROUND_CAP,
    ROOM_TURN_CAP,
    buildRoomSystemPrompt,
    couldStillBePass,
    isPassReply,
    parseRoomMentions,
    renderRoomTurn,
    type RoomEntry,
} from '../services/agents/groupRounds';
import { parseDmMarkers } from '../services/agents/botMailbox';
import { lessonFromBotTurn, recordBotTurnInjection, recordBotTurnOutcome } from '../services/agents/botLearning';
import { stripLessonToken } from '../utils/lessonToken';
import { isProviderReady } from '../utils/providerUtils';
import type { LoggedTrade } from '../types';

export interface GroupActivityEntry {
    id: string;
    kind: 'sent' | 'working' | 'replied' | 'passed';
    botName?: string;
    at: number;
    detail?: string;
}

// Readiness comes from utils/providerUtils.isProviderReady — the shared
// predicate (isEnabled + models/selectedModel + key OR keyless local server,
// see shared/providerRequestPolicy.cjs). The old local copy demanded a non-empty
// apiKey unconditionally, so a room member on Ollama/LM Studio was always
// "provider offline". The bot's own model must additionally be listed by the
// provider — checked at the call site.

export interface UseAgentGroupsResult {
    workingBotId: string | null;
    isRunning: boolean;
    activity: GroupActivityEntry[];
    runGroupThread: (group: { id: string; memberIds: string[] }, prompt: string, bots: AgentBot[]) => Promise<void>;
    /** Abort the in-flight room round: streams are aborted, the loop stops
     *  at the next member boundary, and partial bubbles are marked done. */
    cancelRun: () => void;
}

export const useAgentGroups = ({
    providerConfigs,
    appendMessage,
    patchMessage,
    username,
    /** Hybrid Intelligence: when ON, live market data is fetched once
     *  per send (symbol detected from the prompt) and the enhanced packet
     *  injection is added to EVERY member's system prompt — the whole room
     *  reasons over the same live read, not just the debate pipeline. */
    hybridEnabled = false,
    loggedTradesRef,
}: {
    providerConfigs: ProviderConfig[];
    appendMessage: (msg: Message) => void;
    patchMessage: (id: string, patch: Partial<Message>) => void;
    /** Active profile — enables per-bot persona/notes in room turns. */
    username?: string | null;
    hybridEnabled?: boolean;
    /** Trade log (WS-3): a room turn's lesson writes to the speaker's
     *  memory.md and its closed trades fold into the shared evidence path —
     *  the same write-back a DM turn gets. Absent ⇒ read-only rooms. */
    loggedTradesRef?: React.MutableRefObject<LoggedTrade[]>;
}): UseAgentGroupsResult => {
    const [workingBotId, setWorkingBotId] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [activity, setActivity] = useState<GroupActivityEntry[]>([]);
    const runNonce = useRef(0);
    const abortRef = useRef<AbortController | null>(null);

    const pushActivity = useCallback((entry: Omit<GroupActivityEntry, 'id' | 'at'>) => {
        // a room that runs for hours must not grow the
        // feed unboundedly — the roster renders a recent-history strip, and
        // the oldest entries are the first anyone would scroll past anyway.
        setActivity(prev => [...prev, { ...entry, id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now() }].slice(-100));
    }, []);
    const pushActivityRef = useRef(pushActivity);
    pushActivityRef.current = pushActivity;

    /** User-facing cancel: a stale nonce makes every subsequent turn
     *  bail (the `runNonce.current !== nonce` guards), the in-flight
     *  stream's AbortController is fired, and the room settles. */
    const cancelRun = useCallback(() => {
        runNonce.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setWorkingBotId(null);
        setIsRunning(false);
        pushActivityRef.current({ kind: 'passed', botName: 'Room', detail: 'cancelled' });
    }, []);

    const runGroupThread = useCallback(async (group: { id: string; memberIds: string[] }, prompt: string, bots: AgentBot[]): Promise<void> => {
        const trimmed = prompt.trim();
        if (!trimmed || group.memberIds.length === 0) return;
        const nonce = ++runNonce.current;

        const members = group.memberIds
            .map(id => findBotById(bots, id))
            .filter((b): b is AgentBot => Boolean(b));
        if (members.length === 0) return;

        // Round 1 speakers: @mention routing (deterministic parse
        // — name/title/no-space forms + @everyone). No mention = the old
        // fan-out (every member speaks once), which keeps single-pass
        // behavior byte-identical for plain prompts.
        const mentioned = parseRoomMentions(trimmed, members);
        let speakers: AgentBot[] = mentioned.length > 0 ? mentioned : members;

        // The prompt lands once as the thread opener.
        appendMessage({
            id: `usr-${Date.now()}`,
            role: MessageRole.USER,
            text: trimmed,
            createdAt: new Date().toISOString(),
            roomId: group.id,
        });
        pushActivity({ kind: 'sent' });
        setIsRunning(true);
        const abort = new AbortController();
        abortRef.current = abort;

        // Hybrid Intelligence for the room: fetched ONCE per send,
        // injected into EVERY member's system prompt — the whole room
        // shares the same live market read. Silent fallback to plain
        // prompts when the symbol can't be detected or the fetch fails.
        let hybridInjection = '';
        if (hybridEnabled) {
            try {
                const hybridResult = await tryFetchHybridDataFromPromptWithCalibration(trimmed);
                if (runNonce.current !== nonce) return;
                if (hybridResult) hybridInjection = hybridResult.enhancedInjection || hybridResult.promptInjection;
            } catch { /* offline / no symbol — the room runs without live data */ }
        }

        // The room log: everything said so far. Each member tracks the
        // index it last saw — a turn is fed ONLY the newer entries (this
        // is what makes multi-round cheap).
        const room: RoomEntry[] = [{ speaker: ROOM_HUMAN_LABEL, text: trimmed }];
        const lastSeen = new Map<string, number>();
        // The room recorder's ledger: one entry per participant that spoke,
        // filled during the rounds and flushed at settlement (below). Bots
        // stop being read-only learners here — the write-back is deferred so
        // a chatty participant cannot accrue a lesson line per round.
        const recorder = new Map<string, { bot: AgentBot; prompt: string; reply: string; username: string }>();
        let turns = 0;

        try {
            for (let round = 1; round <= ROOM_ROUND_CAP && speakers.length > 0; round++) {
                const nextSpeakers = new Map<string, AgentBot>();
                for (const bot of speakers) {
                    if (runNonce.current !== nonce) return;
                    if (turns >= ROOM_TURN_CAP) {
                        pushActivity({ kind: 'passed', botName: bot.name, detail: 'turn budget' });
                        continue;
                    }
                    const provider = providerConfigs.find(p => p.id === bot.providerId);
                    if (!provider || !isProviderReady(provider) || !provider.models.includes(bot.modelId)) {
                        pushActivity({ kind: 'passed', botName: bot.name, detail: 'provider offline' });
                        continue;
                    }
                    turns++;

                    setWorkingBotId(bot.id);
                    pushActivity({ kind: 'working', botName: bot.name });

                    const unseen = room.slice(lastSeen.get(bot.id) ?? 0);
                    // Advance BEFORE the turn: the member's own reply is
                    // pushed to the room after this point, so it lands in
                    // the NEXT window (rendered "You:") — the model sees
                    // what it said, never the prompt twice.
                    lastSeen.set(bot.id, room.length);
                    const system = buildRoomSystemPrompt(bot, {
                        persona: username ? readBotSystemMarkdown(bot.id) : null,
                        notes: username ? readBotMemoryMarkdown(bot.id) : null,
                        members,
                    }) + (hybridInjection ? `\n\n${hybridInjection}` : '');

                    const config = { ...provider, selectedModel: bot.modelId };
                    const replyId = `grp-${Date.now()}-${bot.id}-${round}`;
                    appendMessage({
                        id: replyId,
                        role: MessageRole.AI,
                        text: '',
                        createdAt: new Date().toISOString(),
                        modelsUsed: { [provider.id]: bot.modelId },
                        isStreaming: true,
                        roomId: group.id,
                    });

                    let visible = '';
                    let lastFlush = 0;
                    const replyStartedAt = Date.now();
                    try {
                        const responseText = await streamQuickResponse(
                            config,
                            renderRoomTurn(bot.name, unseen),
                            [],
                            system,
                            abort.signal,
                            undefined,
                            delta => {
                                visible += delta;
                                // A pure "(pass)" must never render — hold
                                // the bubble empty while it could still be.
                                if (couldStillBePass(visible)) return;
                                const now = Date.now();
                                if (now - lastFlush > 120) {
                                    lastFlush = now;
                                    patchMessage(replyId, { text: visible });
                                }
                            },
                        );
                        if (runNonce.current !== nonce) {
                            // A CANCELLED run still owns the row it painted.
                            // `cancelRun` bumps the nonce and then aborts, so this
                            // early return used to skip the settle below and leave
                            // the bubble streaming for the rest of the session —
                            // a row no later write ever finishes (the 2026-10-27 audit L-4).
                            if (abort.signal.aborted) {
                                patchMessage(replyId, settleMessageRow({
                                    text: visible ? `${visible}

(cancelled)` : '',
                                    hidden: !visible,
                                }, 'stopped'));
                            }
                            return;
                        }
                        const rawReply = responseText || visible;
                        // The room protocol forbids [[dm:@…]] markers (that is
                        // the 1:1 mailbox's channel), but a model can still
                        // emit one — and the same is true of the LESSON token.
                        // Both are stripped from the persisted text so the
                        // bubble never shows a raw marker: same pattern the
                        // mailbox uses for its own replies. The RAW reply is
                        // what the learner reads (the token is the lesson), so
                        // stripping must not destroy it.
                        const finalText = stripLessonToken(parseDmMarkers(rawReply).clean.trim());
                        if (isPassReply(finalText)) {
                            // Silence is a first-class outcome: no bubble,
                            // no room entry — just the activity feed.
                            patchMessage(replyId, settleMessageRow({ text: '', hidden: true }, 'completed'));
                            pushActivity({ kind: 'passed', botName: bot.name });
                        } else {
                            patchMessage(replyId, settleMessageRow({ text: finalText, runStats: {
                                runId: replyId,
                                startedAt: new Date(replyStartedAt).toISOString(),
                                finishedAt: new Date().toISOString(),
                                durationMs: Date.now() - replyStartedAt,
                            } }, 'completed'));
                            room.push({ speaker: bot.name, text: finalText });
                            pushActivity({ kind: 'replied', botName: bot.name });
                            if (username) {
                                // The speaker's own notes rode THIS turn's system
                                // prompt (buildRoomSystemPrompt reads memory.md), and
                                // that half never comes out of retrieval — so it has
                                // to be recorded here or nothing downstream can tell
                                // a room turn was shown anything. Same call the 1:1
                                // mailbox makes, for the same reason.
                                recordBotTurnInjection({ botId: bot.id, username, runId: replyId });
                                // The room recorder: ONE write-back per participant
                                // per run, not one per reply. A participant that
                                // speaks in three rounds earns one lesson line, not
                                // three — and the line it means is usually in the
                                // first reply, so a pick that already earned a lesson
                                // is frozen and a lesson-free pick is displaced by
                                // anything newer.
                                const prior = recorder.get(bot.id);
                                if (!prior || !lessonFromBotTurn(prior.reply)) {
                                    recorder.set(bot.id, {
                                        bot,
                                        prompt: renderRoomTurn(bot.name, unseen),
                                        reply: rawReply,
                                        username,
                                    });
                                }
                            }
                            // Deterministic routing: mentions in this reply
                            // speak next round (self-excluded; no echo loop).
                            for (const t of parseRoomMentions(finalText, members)) {
                                if (t.id !== bot.id) nextSpeakers.set(t.id, t);
                            }
                        }
                    } catch (error) {
                        // `|| abort.signal.aborted`: the same reason as above — a
                        // stop must settle ITS OWN row, even after a newer run took
                        // the room.
                        if (runNonce.current === nonce || abort.signal.aborted) {
                            const aborted = abort.signal.aborted;
                            // The transport already mapped the raw failure to a
                            // user-safe message (toFriendlyProviderError) — show
                            // WHY the turn died instead of a generic
                            // "provider error" that leaves the user guessing.
                            const rawReason = error instanceof Error ? error.message.trim() : '';
                            const reason = rawReason
                                ? /[.!?]$/.test(rawReason) ? rawReason.slice(0, 160) : `${rawReason.slice(0, 160)}.`
                                : 'provider error';
                            patchMessage(replyId, settleMessageRow({
                                text: aborted
                                    ? (visible ? `${visible}\n\n(cancelled)` : '')
                                    : (visible
                                        ? `${visible}\n\n(failed: ${reason})`
                                        : `(${bot.name} could not reply — ${reason})`),
                                hidden: aborted && !visible,
                            }, aborted ? 'stopped' : 'failed', { error: aborted ? undefined : reason, hasText: !!visible }));
                            if (!aborted) pushActivity({ kind: 'passed', botName: bot.name, detail: reason });
                        }
                    }
                }
                // A round where nobody was addressed = the room settled.
                speakers = [...nextSpeakers.values()];
            }
        } finally {
            if (abortRef.current === abort) abortRef.current = null;
            // ROOM SETTLEMENT: the run is over (settled, capped, or cancelled),
            // so the room teaches now — one write-back per participant that
            // spoke, through the same guard and injection record a DM turn
            // uses. Deferring to here is what makes "one labeled lesson per
            // participant" true: a bot that took three rounds wrote three
            // lesson lines before, and only the first is what it meant.
            for (const { bot, prompt, reply, username } of recorder.values()) {
                void recordBotTurnOutcome(bot, prompt, reply, {
                    username,
                    trades: loggedTradesRef?.current ?? [],
                });
            }
            if (runNonce.current === nonce) {
                setWorkingBotId(null);
                setIsRunning(false);
            }
        }
    }, [providerConfigs, appendMessage, patchMessage, pushActivity, username, hybridEnabled, loggedTradesRef]);

    return { workingBotId, isRunning, activity, runGroupThread, cancelRun };
};

export default useAgentGroups;
