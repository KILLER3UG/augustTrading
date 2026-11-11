/**
 * ChatTranscriptList — the dock's transcript rows, extracted from
 * TradeChatPanel. Props-only: every input is either data (the merged entry
 * list, the analysis-message-id map), the scroller the dock owns, or a
 * callback the shell owns (`send` for the retry chips, the Key Levels → chart
 * channel, the pin toggle, the journal logger). The proposal-card disposition
 * map stays at MODULE scope so it survives a dock unmount, exactly as it did
 * in the panel.
 *
 * VIRTUALIZED. A conversation keeps every turn (owner ruling, 2026-10-27 — the
 * 60-entry cap is gone and `entriesForSession` maps the whole canonical thread),
 * so mounting every row meant mounting every markdown body, every work timeline
 * and every Key Levels card of a month-long thread on each streaming chunk.
 * `react-virtuoso` renders the window instead. It does NOT own the scroll box:
 * `customScrollParent` is the dock's own `role="log"` div, so the composer, the
 * jump FAB and the scroll-to-entry bridge keep addressing one element. The
 * follow-the-bottom behaviour is Virtuoso's (`followOutput` +
 * `atBottomStateChange`), driven by the shell — see TradeChatPanel.
 */

import React, { useState } from 'react';
import { Virtuoso, type FollowOutput, type VirtuosoHandle } from 'react-virtuoso';
import { Zap } from '../../shared/Icons';
import { InterruptedRunNotice } from '../../shared/InterruptedRunNotice';
import type { Message } from '../../../types/message';
import type { LiveEntry } from '../../../services/trade/chatStore';
import { parseKeyLevels, type MessageLevelLines } from '../../../services/trade/keyLevels';
import type { TradeProposal } from '../../../services/trade/proposedTrade';
import { formatSeatLabel } from '../../../utils/providerUtils';
import ChatWorkTimeline from './ChatWorkTimeline';
import TradeProposalCard, { TradeProposalLoggedRow } from './TradeProposalCard';
import VerdictAudit, { verdictNeedsAudit } from '../../analysis/VerdictAudit';
import InlineVerdict from '../../analysis/InlineVerdict';
import MemoryProvenanceStrip from '../../chat/MemoryProvenanceStrip';
import KeyLevelsCard from '../KeyLevelsCard';
import SignalCard, { DeskScorecard, signalIdFromActions, signalRowById } from '../SignalCard';
import Disclosure from '../../shared/Disclosure';
import { JUMP_AWAY_PX } from '../../shared/JumpToLatestFab';
import { ageMinutes, roundAgoHoursLabel } from '../../../utils/relativeTime';
import { proposalStateOf as sharedProposalStateOf, rememberProposalState } from '../../../services/trade/proposalDisposition';
import { CopyChip, PinChip, RetryChip, ThinkingTierChip } from '../../shared/chatChips';
import AnswerBody from '../../shared/AnswerBody';
import ChatFailureRow from '../../shared/ChatFailureRow';
import { BotFace } from '../../chat/BotFace';

/** Prov line: short session id · model short · thinking tier · notebook
 *  count · relative time. CODE-CALCULATED only — never "Mock" in real UI,
 *  never invented numbers.
 *
 *  CACHED per entry object, bucketed by the minute it prints. Every other part
 *  of the line is fixed for the life of the entry, and the relative time is
 *  printed at minute resolution — so rebuilding it for every rendered row on
 *  every streaming chunk was the same string join thousands of times an
 *  answer. The bucket is the ROUNDED age in minutes, which is exactly the
 *  quantity the label prints: the cache expires on the tick the text would
 *  change (now → 1m ago → … → 1h ago), never a minute late, and no timer is
 *  needed to roll it. A WeakMap so a dropped conversation is collected with
 *  its rows. The printed format is unchanged. */
const provLineCache = new WeakMap<LiveEntry, { mins: number; line: string | null }>();
const provLine = (e: LiveEntry): string | null => {
    const mins = e.at ? Math.max(0, Math.round(ageMinutes(e.at))) : -1;
    const hit = provLineCache.get(e);
    if (hit && hit.mins === mins) return hit.line;
    const parts: string[] = [];
    const sid = e.speaker?.split(':')[0]?.replace(/-/g, '').slice(0, 6);
    if (sid && sid !== 'desk') parts.push(sid);
    // Model short: seat label's second half ("provider:model") already in
    // `speaker`; fall back to nothing rather than a fabricated name.
    const model = e.speaker?.split(':')[1]?.split('/').pop()?.slice(0, 12);
    if (model) parts.push(model);
    if (e.effort) parts.push(String(e.effort));
    if (mins >= 0) parts.push(roundAgoHoursLabel(mins));
    const line = parts.length > 0 ? parts.join(' · ') : null;
    provLineCache.set(e, { mins, line });
    return line;
};

/** Per-entry disposition of a model proposal card ('logged' / 'dismissed')
 *  moved to `services/trade/proposalDisposition` when the Agents surface grew a
 *  card of its own. It is STILL module scope, so a 'logged' plan survives a dock
 *  unmount exactly as before — the difference is that both homes now read one
 *  map keyed by the row id `entriesForSession` already shares between them, so
 *  logging a plan on the chart marks it logged in Chat rather than leaving a
 *  second clickable card behind. Re-exported: existing test hooks import this
 *  name from here. */
export { __clearProposalStateForTests } from '../../../services/trade/proposalDisposition';

interface ChatTranscriptListProps {
    /** The merged conversation rows (a bot session is a VIEW of the
     *  canonical conversation — the merge happened in the shell). */
    entries: LiveEntry[];
    /** The dock's OWN scroll box — the `role="log"` div in TradeChatPanel.
     *  Virtuoso renders into it (`customScrollParent`) instead of growing a
     *  second scroller, so the jump FAB, the composer's growth and App's
     *  scroll-to-entry bridge all keep addressing one element. It is a real
     *  HTMLElement, never null: the shell mounts this list only once its
     *  callback ref has handed the node over. */
    scrollParent: HTMLElement;
    /** The shell's handle on the list, for the two imperative jumps it owns
     *  (the FAB's "back to the newest row" and App's Locate). */
    virtuosoRef: React.Ref<VirtuosoHandle>;
    /** Virtuoso's follow-the-output decision, owned by the shell so the pin
     *  and the FAB read one state. */
    followOutput: FollowOutput;
    /** Virtuoso's own at-bottom measurement, on the same JUMP_AWAY_PX
     *  threshold the FAB uses. */
    onAtBottomChange: (atBottom: boolean) => void;
    /** Every change to the list's measured height — the follow path for growth
     *  too small to cross JUMP_AWAY_PX, which never flips the bottom state. */
    onTotalHeightChanged: () => void;
    /** The shell's send — retry chips re-run a user bubble through it. */
    send: (raw: string, retryOf?: string) => Promise<void>;
    /** Prefill the composer with the interrupted prompt — "Edit prompt" on an
     *  interrupted run. Optional: a surface with no composer omits the control
     *  rather than drawing a dead one. */
    setDraftText?: (text: string) => void;
    /** Resolve an analysis message id into the App-side message (the
     *  verdict audit block). Absent ⇒ the audit block does not render. */
    getAnalysisMessage?: (messageId: string) => Message | undefined;
    /** True when this list may hold rows projected from a conversation, i.e. the
     *  session is bound to one. Every analysis row is one now — the pipeline
     *  writes the conversation, both homes render it — so the entry id IS the
     *  message id and no side map is needed. See the `analysisId` derivation. */
    resolveVerdictByIdentity?: boolean;
    /** The chart the transcript talks about (Key Levels card rows). */
    symbol: string;
    /** The freshest mark for the levels card's Dist column — the canvas
     *  snapshot's markPrice, never a re-fetch. */
    getMark: () => number | null;
    /** The ownership-arbitrated Key Levels → chart channel (dock-owned). */
    onChatLevels: (payload: MessageLevelLines | null, ownerId?: string) => void;
    /** Pin / unpin the signal behind an entry (App-side message ids only). */
    onToggleWatch?: (messageId: string) => void;
    /** Message ids currently pinned, so the chip shows the real state. */
    pinnedMessageIds?: ReadonlySet<string>;
    /** "Log this trade" on a model proposal → App records an OPEN trade.
     *  Absent ⇒ the Log button is hidden (no journal attached). */
    onLogProposedTrade?: (proposal: TradeProposal) => void | Promise<boolean>;
}

const ChatTranscriptList: React.FC<ChatTranscriptListProps> = ({
    entries, scrollParent, virtuosoRef, followOutput, onAtBottomChange, onTotalHeightChanged,
    send, setDraftText, getAnalysisMessage, resolveVerdictByIdentity, symbol, getMark, onChatLevels,
    onToggleWatch, pinnedMessageIds, onLogProposedTrade,
}) => {
    /** Re-render trigger for the module-scope proposal dispositions (see
     *  proposalDisposition): the disposition itself must SURVIVE a dock
     *  unmount, the state here only makes React repaint the card. */
    const [proposalTick, setProposalTick] = useState(0);
    /** Which entry's Log click is currently awaiting the gate stamp. Local (not
     *  the module map) on purpose: it is a transient, and a pending await that
     *  survived an unmount would disable a button that no longer exists. */
    const [awaitingLogEntryId, setAwaitingLogEntryId] = useState<string | null>(null);
    /** Proposal card disposition for one entry — read from the MODULE map
     *  (see proposalDisposition), so the 'logged' state survives a dock
     *  unmount/remount and "Log this trade" can never be clicked twice for
     *  the same plan. proposalTick is the repaint trigger. */
    const proposalStateOf = (id: string): 'logged' | 'dismissed' | undefined => {
        void proposalTick;
        return sharedProposalStateOf(id);
    };
    // "Is any LATER entry still streaming?" — the retry/copy chips on a USER
    // bubble stay hidden while the whole following generation runs (a PANEL
    // turn streams seat 2 while seat 1 has settled, and a mid-turn retry
    // could wipe the live room). Computed ONCE per render with a single
    // reverse pass; the old per-row `entries.slice(i + 1).some(...)` was
    // O(n²) on every streaming chunk.
    // (The rows themselves stay unmemoized on purpose: they read the module
    // proposalDisposition map through the proposalTick counter, so they are
    // not props-pure — a memo boundary would have to thread module state
    // through props. Virtuoso is what bounds the work now: a conversation has
    // no entry cap, and only the mounted window renders at all.)
    const answerStreamingFlags = React.useMemo<boolean[]>(() => {
        const flags = new Array<boolean>(entries.length);
        let seen = false;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            flags[i] = seen;
            if (entries[i].streaming) seen = true;
        }
        return flags;
    }, [entries]);
    /** Open on the NEWEST row, the way the hand-rolled scroller did
     *  (`scrollTop = scrollHeight`). Decided ONCE, at mount, and only when the
     *  box can actually scroll: the dock stays mounted while it is collapsed
     *  to a rail, and Virtuoso's initial-location handshake waits for a scroll
     *  that a zero-height box can never make — it would leave the list
     *  `visibility: hidden` behind the rail. With no height we start at the top
     *  and the shell's follow re-pin lands on the newest row as soon as the
     *  dock is expanded and the content measures. */
    const [initialTopMostItemIndex] = useState<number | { index: 'LAST'; align: 'end' }>(
        () => (scrollParent.clientHeight > 0 ? { index: 'LAST', align: 'end' } : 0),
    );
    /** One row. `i` is the index in the WHOLE conversation, not in the mounted
     *  window — the neighbour reads (`entries[i - 1]` for a retry, `entries[i + 1]`
     *  for the memory window) and the streaming flags are keyed by it. */
    const renderEntry = (i: number, e: LiveEntry): React.ReactNode => {
        const answerStreaming = answerStreamingFlags[i];
        // Key-levels protocol: the fenced block the model closes an
        // analysis with renders as the chart-linked card, never as
        // raw text — and an OPEN (still-streaming) fence is hidden
        // from the bubble too, so the protocol never flashes.
        const aiLevels = e.role === 'ai' && !e.notice ? parseKeyLevels(e.text) : null;
        const shownText = aiLevels?.hadBlock ? aiLevels.clean : e.text;
        // A row projected from the conversation keeps the Message's own id
        // (`liveEntryFromMessage` sets `id: m.id`, which is what lets the
        // merge treat one turn as one row), so the entry id IS the analysis
        // id. Gated on the host saying its rows are conversation rows: a
        // dock-native entry id must never be looked up as a message id,
        // because a collision would hang another run's verdict on the
        // wrong bubble.
        const analysisId = resolveVerdictByIdentity && e.role === 'ai' ? e.id : undefined;
        // Only a settled answer has a verdict to explain, and only
        // an entry this dock ran has an id to resolve it from.
        const verdict = e.streaming || e.notice ? undefined
            : (analysisId ? getAnalysisMessage?.(analysisId) : undefined);
        const seatLabel = e.speaker
            ? formatSeatLabel(e.speaker.split(':')[1] ?? e.speaker)
            : 'desk';
        const deskSpeaker = !e.speaker || e.speaker.trim().toLowerCase() === 'desk';
        // The row was projected out of the Chat conversation, which draws
        // a verdict as a decision table rather than a bare audit — and
        // since both homes now read that one conversation, this IS every
        // analysis row. `InlineVerdict` is the one renderer for both.
        const projected = !!resolveVerdictByIdentity;
        return (
            // The 24px between rows used to come from the scroller's
            // `space-y-6`. Virtuoso measures each item's own box, so the gap
            // rides the row's padding now — on every row but the last, which
            // is exactly the spacing space-y-6 produced. `data-entry-index` is
            // the row's place in the WHOLE conversation: with only a window
            // mounted, it is what lets a reader (and render-probe) tell "the
            // newest row is on screen" from "some rows are on screen".
            <div
                className={`chat-fade-in${i < entries.length - 1 ? ' pb-6' : ''}`}
                data-entry-id={e.id}
                data-message-id={analysisId ?? e.id}
                data-entry-index={i}
                data-testid={`chat-entry-${e.role}`}
            >
                {e.role === 'user' ? (
                    <div className="flex flex-col items-end gap-1.5">
                        {e.image && (
                            <div className="flex flex-col items-end gap-0.5">
                                <img src={e.image} alt="attached" className="max-h-40 rounded-bubble border border-hairline object-contain" />
                                {!answerStreaming && <RetryChip onRetry={() => void send('', e.id)} />}
                            </div>
                        )}
                        {!e.image && e.imageOmitted && (
                            // A restored backup carries no image bytes: the row must
                            // still say an image was attached — and never via an <img>
                            // with a missing src, which renders as a broken icon.
                            <div
                                data-testid="chat-image-omitted"
                                className="rounded-control border border-hairline bg-zinc-900/60 px-2.5 py-1.5 text-ui-dense text-zinc-500"
                            >
                                image not backed up ({e.imageOmitted.mime}, {Math.max(1, Math.round(e.imageOmitted.bytes / 1024))} KB)
                            </div>
                        )}
                        {e.text && e.text !== '(chart screenshot)' && (
                            <div className="flex max-w-[80%] items-start gap-1.5">
                                {!answerStreaming && <CopyChip text={e.text} className="mt-2.5" />}
                                {!answerStreaming && <RetryChip onRetry={() => void send('', e.id)} className="mt-2.5" />}
                                <p className="min-w-0 rounded-bubble bg-zinc-800 px-4 py-2.5 text-ui-base leading-relaxed text-zinc-100">{e.text}</p>
                            </div>
                        )}
                    </div>
                ) : e.notice ? (
                    <p className="flex items-center gap-1.5 text-ui-xs font-semibold uppercase tracking-wider text-amber-400" data-testid="chat-notice">
                        <span className="sr-only">⚡ </span>
                        <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span>{e.tools[0] ?? 'Harness event'}</span>
                    </p>
                ) : e.error && !e.text ? (
                    /* A turn that never produced a line is a failure, whole
                       and alone: both homes render the same row, so the dock
                       cannot show a blank bubble where Chat shows the failure.
                       A turn that produced prose AND then failed is NOT this
                       row — it falls through to the answer below, keeps what
                       arrived, and carries the reason inside the "Run stopped"
                       card. Collapsing it here would throw away the half of
                       the analysis the trader still has to read. */
                    <ChatFailureRow error={e.error} />
                ) : (
                    <div className="flex items-start gap-3">
                        <span
                            className="mt-0.5 shrink-0"
                            title={seatLabel}
                            aria-label={seatLabel}
                            data-testid="row-avatar"
                        >
                            <BotFace
                                face={deskSpeaker ? { shape: 'circle', hue: '#4d9fff' } : 'auto'}
                                name={e.speaker ?? 'desk'}
                                size={28}
                                working={!!e.streaming}
                            />
                        </span>
                        <div className="min-w-0 flex-1 space-y-2">
                        {/* Signal row: the ledger call, when this turn
                            emitted one (signalIdFromActions reads the id
                            from the emit_signal action). Never fabricated. */}
                        {(() => {
                            const sid = signalIdFromActions(e.actions);
                            if (!sid) return null;
                            const row = signalRowById(sid);
                            if (!row) return null;
                            return (
                                <SignalCard
                                    signal={row.signal}
                                    row={row}
                                />
                            );
                        })()}
                        <ChatWorkTimeline entry={e} />
                        {/* An interrupted run is a half-written answer with no
                            way forward — say so IN FLOW, and offer the two
                            recoveries (re-ask, or edit what was asked). The
                            `retryOf` re-dispatch is the same one the post-mortem
                            retry uses. */}
                        {e.interrupted && !e.streaming && (
                            <InterruptedRunNotice
                                cause={e.error}
                                /* A recovery is only offered against the USER turn
                                   this answer was answering: `send('', retryOf)`
                                   replays a USER entry and returns early for any
                                   other id, so a card on a row whose predecessor is
                                   a harness notice or another seat would carry a
                                   dead button — and this notice's own contract says
                                   it renders only with a handler that works. */
                                onEditPrompt={(() => {
                                    const asked = entries[i - 1]?.role === 'user' ? entries[i - 1].text : '';
                                    return asked ? () => setDraftText?.(asked) : undefined;
                                })()}
                                onTryAgain={(() => {
                                    const prev = entries[i - 1];
                                    return prev?.role === 'user' && prev.text.trim()
                                        ? () => { void send('', prev.id); }
                                        : undefined;
                                })()}
                            />
                        )}
                        <div className="text-ui-base leading-relaxed text-zinc-200">
                            {shownText
                                ? <AnswerBody text={shownText} streaming={!!e.streaming} />
                                : null}
                        </div>
                        {/* Desk scorecard: the ledger's hit-rate vs base-rate. */}
                        {!e.streaming && <DeskScorecard />}
                        {shownText && !e.streaming && (
                            /* Always visible, matching ChatTranscriptRow's
                                action row — the dock's chips used to be
                                hover-gated on a `group/msg` no ancestor
                                carried, so a mouse user could never see
                                them. */
                            <div className="flex items-center gap-2">
                                {/* The tier this answer was produced under —
                                    the same muted chip the Agents surface
                                    shows, so the two homes say the same
                                    thing about the same turn. */}
                                {e.effort && <ThinkingTierChip effort={e.effort} />}
                                <CopyChip text={shownText} />
                                {onToggleWatch && analysisId && pinnedMessageIds && (
                                    <PinChip pinned={pinnedMessageIds.has(analysisId)}
                                        onToggle={() => onToggleWatch(analysisId)} />
                                )}
                            </div>
                        )}
                        {/* The one "what the AI remembered" row. Once the
                            answer has settled — an open stream is still
                            pulling injections in, so its window has no
                            upper bound yet. */}
                        {shownText && !e.streaming && !e.notice && (
                            <MemoryProvenanceStrip
                                startedAt={e.at}
                                nextAt={entries[i + 1]?.at}
                                messageId={e.id}
                            />
                        )}
                        {verdict?.analysis && (projected ? (
                            // The card already folds VerdictAudit into its
                            // own disclosure, so a projected row must not
                            // draw the explanation a second time below it.
                            <InlineVerdict analysis={verdict.analysis} />
                        ) : verdictNeedsAudit(verdict.analysis) ? (
                            <Disclosure
                                summary="Inspect evidence & gate"
                                label="Inspect evidence and gate"
                                testId="inspect-evidence-gate"
                                className="mt-1.5"
                                summaryClassName="flex cursor-pointer items-center gap-1.5 py-1 text-ui-sm font-semibold text-zinc-500 transition-colors hover:text-zinc-300"
                                bodyClassName="mt-1.5 border-t border-zinc-800/60 pt-1.5"
                            >
                                <VerdictAudit
                                    analysis={verdict.analysis}
                                    className="mt-1"
                                />
                            </Disclosure>
                        ) : null)}
                        {/* Prov line: code-calculated only — short session
                            id · model short · thinking tier · notebook
                            count · relative time. Never "Mock". */}
                        {shownText && !e.streaming && (() => {
                            const prov = provLine(e);
                            return prov ? (
                                <p className="font-mono text-ui-2xs tabular-nums text-zinc-600" data-testid="prov-line">{prov}</p>
                            ) : null;
                        })()}
                        {aiLevels && aiLevels.levels.length > 0 && !e.streaming && (
                            <KeyLevelsCard
                                messageId={e.id}
                                levels={aiLevels.levels}
                                symbol={symbol}
                                getMark={getMark}
                                onChatLevels={onChatLevels}
                            />
                        )}
                        {e.proposal && !proposalStateOf(e.id) && (
                            <TradeProposalCard
                                proposal={e.proposal}
                                canLog={!!onLogProposedTrade}
                                logNote={e.error
                                    ? 'This plan arrived on a run that stopped before it finished — the rest of the answer never came.'
                                    : undefined}
                                awaitingLog={awaitingLogEntryId === e.id}
                                onLog={async () => {
                                    // Double-log guard: the disposition lives at module
                                    // scope, so it survived even before this fix's second
                                    // half — the map lookup makes a re-click after a dock
                                    // unmount/remount (fresh component, same store entry)
                                    // a NO-OP instead of a second journal row.
                                    if (sharedProposalStateOf(e.id) || awaitingLogEntryId) return;
                                    const stamped = e.proposal!;
                                    setAwaitingLogEntryId(e.id);
                                    // The row is written only once the gate stamp has
                                    // been awaited (and, if it could not be measured,
                                    // once the trader has confirmed) — so the card must
                                    // stay live and clickable-to-cancel through that
                                    // await instead of being marked logged up front.
                                    let logged: boolean;
                                    try { logged = (await onLogProposedTrade?.(stamped)) !== false; }
                                    // A log that threw is NOT a log: the card
                                    // stays live so the trader can retry instead
                                    // of seeing ✓ Logged over a missing row.
                                    catch { logged = false; }
                                    finally { setAwaitingLogEntryId(null); }
                                    if (!logged) return;
                                    rememberProposalState(e.id, 'logged');
                                    setProposalTick(t => t + 1);
                                }}
                                onCancel={() => { if (sharedProposalStateOf(e.id)) return; rememberProposalState(e.id, 'dismissed'); setProposalTick(t => t + 1); }}
                            />
                        )}
                        {e.proposal && proposalStateOf(e.id) === 'logged' && <TradeProposalLoggedRow />}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <Virtuoso
            ref={virtuosoRef}
            // The dock's own log box scrolls; Virtuoso renders into it rather
            // than growing a second scroller inside it.
            customScrollParent={scrollParent}
            data={entries}
            // The entry id is the row's identity across the merge, so a
            // recycled row never inherits another turn's DOM.
            computeItemKey={(_index, entry) => entry.id}
            initialTopMostItemIndex={initialTopMostItemIndex}
            followOutput={followOutput}
            atBottomStateChange={onAtBottomChange}
            totalListHeightChanged={onTotalHeightChanged}
            // ONE follow distance for both homes (components/shared/JumpToLatestFab):
            // "at the bottom" means within JUMP_AWAY_PX of it, which is the same
            // threshold that decides whether the jump control is offered.
            atBottomThreshold={JUMP_AWAY_PX}
            // A dock row is tall (markdown, a work timeline, cards). Render a
            // little above and below the fold so a flick lands on content
            // rather than on a blank strip.
            increaseViewportBy={{ top: 600, bottom: 600 }}
            itemContent={renderEntry}
        />
    );
};

export default React.memo(ChatTranscriptList);
