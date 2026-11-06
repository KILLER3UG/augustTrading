/**
 * the async half of teammate DMs.
 *
 * Pure logic (validation, protocol text, marker grammar) lives in
 * services/agents/botMailbox.ts. This hook owns the per-target queues and
 * drains them: deliver a DM → run the target bot's turn (persona + notes +
 * teammate protocol over its own thread history) → parse its reply for
 * [[dm:@…]] markers → deliver the next hop or wake the sender with a
 * "replied to your DM" notice. Serial per target (a per-profile
 * lock), TTL at drain time, global rate budget, hop cap.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { AgentBot } from '../services/agents/agentRoster';
import { findProviderById, isProviderReady } from '../utils/providerUtils';
import { settleMessageRow } from '../utils/rowSettlement';
import type { ProviderConfig } from '../types/provider';
import type { Message } from '../types';
import { MessageRole } from '../types/enums';
import { streamQuickResponse } from '../services/providers/GenericAnalysisService';
import { tryFetchHybridDataFromPromptWithCalibration } from '../services/analysis/HybridIntelligenceService';
import {
    readBotSystemMarkdown,
    readBotMemoryMarkdown,
} from '../services/bots/BotMemoryService';
import { threadForProvider } from '../utils/agentThreads';
import {
    buildBotSharedMemoryContext,
    recordBotTurnInjection,
    recordBotTurnOutcome,
} from '../services/agents/botLearning';
import type { LoggedTrade } from '../types';
import {
    DM_ENVELOPE_TTL_MS,
    DM_MAX_FANOUT,
    DM_RATE_LIMIT,
    DM_RATE_WINDOW_MS,
    buildBotSystemPrompt,
    dmEnvelopeText,
    dmMessageRow,
    dmNoticeRow,
    dmReplyNoticeText,
    parseDmMarkers,
    refuseText,
    validateDM,
    type DMEnvelope,
} from '../services/agents/botMailbox';

export interface UseBotMailboxArgs {
    bots: AgentBot[];
    providerConfigs: ProviderConfig[];
    username: string | null;
    messagesRef: React.MutableRefObject<Message[]>;
    appendMessage: (msg: Message) => void;
    patchMessage: (id: string, patch: Partial<Message>) => void;
    /** Hybrid Intelligence: when ON, a bot answering in its own thread
     *  gets the same live-market injection the debate analysts and room
     *  members receive — fetched once per turn, keyed on the symbol the
     *  prompt names. Without it a DM'd bot reasons blind while the rest
     *  of the harness sees live prices. */
    hybridEnabled?: boolean;
    /** Trade log (WS-3): closed bot-authored trades fold back into the shared
     *  evidence path after a turn. Optional — absent, the bot still learns
     *  into its own memory.md but no skill evidence is written. */
    loggedTradesRef?: React.MutableRefObject<LoggedTrade[]>;
}

export interface UseBotMailboxResult {
    /** DMs completed since boot — bump the roster rail's Coach-style badge. */
    dmActivityCount: number;
    /** True while any queue is draining (rail "working" affordance). */
    dmBusy: boolean;
    /** Bot ids whose queue is draining right now (rail working-pulse). */
    dmBusyBotIds: string[];
    /** Deliver an envelope into the target's queue and drain it. */
    deliverDM: (envelope: DMEnvelope, fromBot: AgentBot) => void;
    /** Scan a finished bot reply for DM markers: strips them from the
     *  bubble, delivers/queues valid ones, posts refusals as notices.
     *  Returns true when markers were present. */
    dispatchFromBotReply: (bot: AgentBot, messageId: string, rawText: string, hop: number) => boolean;
    /** A user-initiated turn in a bot's 1:1 thread: persona + notes +
     *  teammate protocol, reply dispatched for DM markers. Returns false
     *  when the bot's provider is not ready (caller falls back). */
    runUserBotTurn: (bot: AgentBot, prompt: string) => Promise<boolean>;
    /** Abort the bot's in-flight reply (queue-drained or user-initiated).
     *  Returns true when a turn was actually stopped. The queued envelopes
     *  behind it keep draining — Stop answers for the reply on screen, not
     *  for the mailbox contract. */
    cancelDmTurn: (botId: string) => boolean;
}

/**
 * Bot-level readiness: the SHARED provider predicate (isEnabled + models +
 * key OR keyless local server — providerUtils.isProviderReady exempts
 * Ollama/LM Studio base URLs, matching ProviderConfigService.getReadyProviders)
 * plus the bot's specific model being offered. The old inline `apiKey` clause
 * ignored the local exemption, so DMs to bots on a keyless local provider were
 * refused as "no provider".
 */
const isProviderReadyFor = (configs: ProviderConfig[], providerId: string, modelId: string): boolean => {
    const p = findProviderById(configs, providerId);
    return !!p && isProviderReady(p) && p.models.includes(modelId);
};

export const useBotMailbox = ({
    bots, providerConfigs, username, messagesRef, appendMessage, patchMessage,
    hybridEnabled = false, loggedTradesRef,
}: UseBotMailboxArgs): UseBotMailboxResult => {
    // Per-target serial queues (a per-profile lock, in-memory).
    const queues = useRef<Map<string, DMEnvelope[]>>(new Map());
    const busy = useRef<Set<string>>(new Set());
    // Bots running a USER-initiated turn. Separate from `busy` on purpose:
    // that set is the queue's serial lock, and joining it would make a DM
    // delivered mid-user-turn skip the drain instead of queueing behind it.
    // The working pulse and Stop still need to see user turns.
    const userTurns = useRef<Set<string>>(new Set());
    const rate = useRef<number[]>([]);
    const processed = useRef<Set<string>>(new Set());
    const [dmActivityCount, setDmActivityCount] = useState(0);
    const [dmBusy, setDmBusy] = useState(false);
    // Which bots are streaming a reply right now (rail working-pulse).
    const [busyIds, setBusyIds] = useState<string[]>([]);
    // In-flight requests by bot id. A SET, not one controller: a user turn
    // does not take the per-target queue lock, so a queue-drained turn and a
    // user send can legally overlap and both must be stoppable.
    const controllers = useRef<Map<string, Set<AbortController>>>(new Map());
    const syncBusy = useCallback(() => {
        const ids = [...new Set([...busy.current, ...userTurns.current])];
        setBusyIds(ids);
        setDmBusy(ids.length > 0);
    }, []);

    const botsRef = useRef(bots);
    botsRef.current = bots;
    const configsRef = useRef(providerConfigs);
    configsRef.current = providerConfigs;

    const botById = useCallback((id: string): AgentBot | null =>
        botsRef.current.find(b => b.id === id) ?? null, []);

    const notice = useCallback((bot: AgentBot, text: string): void => {
        appendMessage(dmNoticeRow(text, bot.providerId, bot.modelId, `dmn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, bot.id));
    }, [appendMessage]);

    const runBotTurn = useCallback(async (bot: AgentBot, prompt: string, opts: {
        /** The DM that triggered this turn (undefined = user-initiated). */
        triggeredBy?: { envelope: DMEnvelope; from: AgentBot };
    }): Promise<void> => {
        const configs = configsRef.current;
        // Same shared predicate as isProviderReadyFor (see above) — the old
        // inline key clause would have refused a keyless local provider even
        // after runUserBotTurn's readiness check passed.
        const provider = configs.find(c => c.id === bot.providerId && isProviderReady(c) && c.models.includes(bot.modelId));
        if (!provider) {
            if (opts.triggeredBy) notice(opts.triggeredBy.from, refuseText('no_provider', bot.name));
            return;
        }
        const persona = username ? readBotSystemMarkdown(bot.id) : null;
        const notes = username ? readBotMemoryMarkdown(bot.id) : null;
        // Hybrid Intelligence for the turn: one fetch, keyed on the symbol
        // the prompt names; silent fallback to the bot's own knowledge when
        // the fetch fails or no symbol is present (the rooms' exact pattern).
        // The controller is armed BEFORE the network-bound hybrid fetch, not
        // just before the model stream: the composer's Stop is already red
        // while this fetch runs, and a stop that silently no-ops through it
        // reads as broken. (The repo's own rule — chatTurnRunner arms before
        // its context fetch for exactly this reason.) The fetch itself does
        // not take a signal, so an abort here is honoured by the check below.
        const controller = new AbortController();
        let live = controllers.current.get(bot.id);
        if (!live) { live = new Set(); controllers.current.set(bot.id, live); }
        live.add(controller);
        const replyId = `dmr-${Date.now()}-${bot.id}`;
        try {
            // Armed BEFORE the network-bound hybrid fetch, not just before the
            // model stream: the composer's Stop is already red while this fetch
            // runs, and a stop that silently no-ops through it reads as broken.
            // (The repo's own rule — chatTurnRunner arms before its context
            // fetch for exactly this reason.) The fetch itself does not take a
            // signal, so an abort here is honoured by the check below.
            let hybridInjection = '';
            if (hybridEnabled) {
                try {
                    const hybridResult = await tryFetchHybridDataFromPromptWithCalibration(prompt);
                    if (hybridResult) hybridInjection = hybridResult.enhancedInjection || hybridResult.promptInjection;
                } catch { /* offline / no symbol — the turn runs without live data */ }
            }
            // WS-3: the bot reads the shared notebook too — a budgeted retrieval
            // slice keyed on the prompt's setup, recorded under this turn's id so a
            // trade that follows the bot's call credits what it was ACTUALLY shown.
            // The scope comes off the bot now: an isolated bot gets no shared slice
            // at all (it did not used to, either — the field did not exist).
            const memoryScope = bot.memoryScope ?? 'global';
            let sharedMemory = '';
            if (username) {
                sharedMemory = buildBotSharedMemoryContext(prompt, { botId: bot.id, memoryScope, runId: replyId });
                recordBotTurnInjection({ botId: bot.id, username, runId: replyId });
            }
            const system = buildBotSystemPrompt(bot, { persona, notes, teammates: botsRef.current })
                + (sharedMemory ? `\n\nSHARED NOTEBOOK (weigh it like your own notes):\n${sharedMemory}` : '')
                + (hybridInjection ? `\n\n${hybridInjection}` : '');
            const history = threadForProvider(messagesRef.current, bot.providerId, bot.modelId, bot.id);
            // The incoming DM itself must be VISIBLE in the target's thread
            // (the texting metaphor): a user-role dmFrom row that the reply
            // below claims via threadForProvider's pending-user rule. Written
            // BEFORE the abort check: a stopped turn must not erase the message
            // it was answering.
            if (opts.triggeredBy) {
                appendMessage(dmMessageRow(
                    dmEnvelopeText(opts.triggeredBy.from.name, opts.triggeredBy.envelope),
                    `dmr-in-${opts.triggeredBy.envelope.id}`,
                    {
                        fromName: opts.triggeredBy.from.name,
                        task: opts.triggeredBy.envelope.text,
                        constraints: opts.triggeredBy.envelope.constraints,
                        expecting: opts.triggeredBy.envelope.expecting,
                    },
                ));
            }
            if (controller.signal.aborted) {
                // Stopped during the hybrid fetch: no bubble was ever opened, so
                // the receipt is the whole row — never a fabricated premise.
                appendMessage({
                    id: replyId, role: MessageRole.AI,
                    text: `(${bot.name}'s reply was stopped.)`,
                    createdAt: new Date().toISOString(),
                    modelsUsed: { [bot.providerId]: bot.modelId },
                    botId: bot.id, isStreaming: false,
                });
                return;
            }
            appendMessage({
                id: replyId,
                role: MessageRole.AI,
                text: '',
                createdAt: new Date().toISOString(),
                modelsUsed: { [bot.providerId]: bot.modelId },
                // Identity, not just provider+model: a solo Chat-AI answer from this
                // same model otherwise looks exactly like this bot's reply.
                botId: bot.id,
                isStreaming: true,
            });
        const replyStartedAt = Date.now();
            const raw = await streamQuickResponse(
                { ...provider, selectedModel: bot.modelId },
                prompt,
                history,
                system,
                controller.signal,
            );
            // The bubble must carry the reply (markers included for now —
            // dispatch strips them when present). Without this the DM
            // answer renders as an empty row.
            // runStats.runId is what makes the provenance above reachable: a
            // trade logged from this reply carries sourceRunId = replyId, the
            // same id the injection record of this run is stamped with, so the
            // strip and the printable report can say what the decision actually
            // saw. Before this, no bot reply joined to any injection record.
            patchMessage(replyId, settleMessageRow({
                text: raw,
                runStats: {
                    runId: replyId,
                    startedAt: new Date(replyStartedAt).toISOString(),
                    finishedAt: new Date().toISOString(),
                    durationMs: Date.now() - replyStartedAt,
                },
            }, 'completed'));
            // Chain depth: a DM-triggered turn's own DMs are one hop deeper
            // than the envelope that woke it.
            const nextHop = opts.triggeredBy ? opts.triggeredBy.envelope.hop + 1 : 0;
            dispatchRef.current(bot, replyId, raw, nextHop);
            // WS-3: the turn teaches the bot. Lesson → its memory.md; closed
            // bot-authored trades → the shared evidence path (skills, worth
            // gate) exactly like a chart-AI trade close. Fire-and-forget.
            if (username) {
                void recordBotTurnOutcome(bot, prompt, raw, {
                    username,
                    trades: loggedTradesRef?.current ?? [],
                });
            }
            if (opts.triggeredBy) {
                // The reply IS the answer to the DM — wake the sender with a
                // notice in THEIR thread (never auto-run the sender: that is
                // the storm the hop cap exists to bound).
                appendMessage(dmNoticeRow(
                    dmReplyNoticeText(bot.name, raw.trim()),
                    opts.triggeredBy.from.providerId, opts.triggeredBy.from.modelId,
                    `dmw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    // Stamped for the SAME thread the provider+model pair points
                    // at. Without it this row is claimed by inference, which is
                    // how a sibling bot on that pair picked up a DM addressed to
                    // someone else.
                    opts.triggeredBy.from.id,
                ));
                setDmActivityCount(n => n + 1);
            }
        } catch (error) {
            if (controller.signal.aborted) {
                // A deliberate Stop, not a failure: the provider never erred
                // and the turn must not read as one.
                patchMessage(replyId, settleMessageRow({
                    text: `(${bot.name}'s reply was stopped.)`,
                }, 'stopped'));
            } else {
                // Surface the transport's user-safe reason (toFriendlyProviderError)
                // — a bare "provider error" hid WHY every DM turn was dying.
                const rawReason = error instanceof Error ? error.message.trim() : '';
                const reason = rawReason
                    ? /[.!?]$/.test(rawReason) ? rawReason.slice(0, 160) : `${rawReason.slice(0, 160)}.`
                    : 'provider error';
                patchMessage(replyId, settleMessageRow({
                    text: `(${bot.name} could not process the DM — ${reason})`,
                }, 'failed', { error: reason, hasText: true }));
            }
        } finally {
            live?.delete(controller);
            if (live && live.size === 0) controllers.current.delete(bot.id);
        }
    }, [appendMessage, patchMessage, messagesRef, notice, username, hybridEnabled, loggedTradesRef]);

    const drain = useCallback(async (botId: string): Promise<void> => {
        if (busy.current.has(botId)) return; // serial per target
        const q = queues.current.get(botId);
        if (!q || q.length === 0) return;
        busy.current.add(botId);
        syncBusy();
        try {
            while (q.length > 0) {
                const env = q.shift()!;
                const target = botById(env.toBotId);
                const from = botById(env.fromBotId);
                if (!target) continue;
                if (Date.now() - env.queuedAt > DM_ENVELOPE_TTL_MS) {
                    if (from) notice(from, refuseText('expired', target.name));
                    continue;
                }
                rate.current = rate.current.filter(t => Date.now() - t < DM_RATE_WINDOW_MS);
                if (rate.current.length >= DM_RATE_LIMIT) {
                    if (from) notice(from, refuseText('rate_limited', target.name));
                    continue;
                }
                rate.current.push(Date.now());
                await runBotTurn(target, dmEnvelopeText(from?.name ?? 'a teammate', env), {
                    triggeredBy: from ? { envelope: env, from } : undefined,
                });
            }
        } finally {
            busy.current.delete(botId);
            syncBusy();
        }
    }, [botById, notice, runBotTurn, syncBusy]);

    const deliverDM = useCallback((env: DMEnvelope, fromBot: AgentBot): void => {
        const q = queues.current.get(env.toBotId) ?? [];
        q.push(env);
        queues.current.set(env.toBotId, q);
        void drain(env.toBotId);
        void fromBot; // attribution already rides the envelope text
    }, [drain]);

    const runUserBotTurn = useCallback(async (bot: AgentBot, prompt: string): Promise<boolean> => {
        if (!isProviderReadyFor(configsRef.current, bot.providerId, bot.modelId)) return false;
        userTurns.current.add(bot.id);
        syncBusy();
        try {
            await runBotTurn(bot, prompt, {});
        } finally {
            userTurns.current.delete(bot.id);
            syncBusy();
        }
        return true;
    }, [runBotTurn, syncBusy]);

    const cancelDmTurn = useCallback((botId: string): boolean => {
        const live = controllers.current.get(botId);
        if (!live || live.size === 0) return false;
        for (const c of live) c.abort();
        return true;
    }, []);

    // dispatchFromBotReply needs deliverDM, and runBotTurn (via drain) needs
    // dispatch — break the cycle with a ref assigned after both exist.
    const dispatchRef = useRef<(bot: AgentBot, messageId: string, rawText: string, hop: number) => boolean>(
        () => false,
    );

    const dispatchFromBotReply = useCallback((bot: AgentBot, messageId: string, rawText: string, hop: number): boolean => {
        if (processed.current.has(messageId)) return false;
        const { clean, marks } = parseDmMarkers(rawText);
        if (marks.length === 0) return false;
        processed.current.add(messageId);
        patchMessage(messageId, { text: clean });
        // Fanout cap (DM_MAX_FANOUT): the protocol ASKS for at most two
        // teammates per reply; this enforces it. Extra marks get a
        // model-actionable refusal instead of a delivery. An identical
        // (handle, text) pair repeated within one reply is deduplicated
        // silently — the first copy already delivered, and a second notice
        // would say the same thing twice.
        let delivered = 0;
        const seen = new Set<string>();
        for (const mark of marks) {
            const key = `${mark.handle.toLowerCase()}\u0000${mark.text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const v = validateDM(botsRef.current, bot, mark.handle, mark.text, hop,
                (pid, mid) => isProviderReadyFor(configsRef.current, pid, mid),
                { constraints: mark.constraints, expecting: mark.expecting });
            if (v.ok) {
                if (delivered >= DM_MAX_FANOUT) {
                    notice(bot, refuseText('fanout_cap', mark.handle));
                    continue;
                }
                delivered += 1;
                deliverDM(v.envelope, bot);
            } else {
                notice(bot, refuseText(v.reason, mark.handle));
            }
        }
        return true;
    }, [patchMessage, deliverDM, notice]);
    dispatchRef.current = dispatchFromBotReply;

    return useMemo(
        () => ({ dmActivityCount, dmBusy, dmBusyBotIds: busyIds, deliverDM, dispatchFromBotReply, runUserBotTurn, cancelDmTurn }),
        [dmActivityCount, dmBusy, busyIds, deliverDM, dispatchFromBotReply, runUserBotTurn, cancelDmTurn],
    );
};

export default useBotMailbox;
