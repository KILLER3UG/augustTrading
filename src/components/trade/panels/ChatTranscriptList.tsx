/**
 * ChatTranscriptList — the dock's transcript rows, extracted from
 * TradeChatPanel. Props-only: every input is either data (the merged entry
 * list, the analysis-message-id map) or a callback the shell owns (`send`
 * for the retry chips, the Key Levels → chart channel, the pin toggle, the
 * journal logger). The proposal-card disposition map stays at MODULE scope
 * so it survives a dock unmount, exactly as it did in the panel.
 */

import React, { useState } from 'react';
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
import { proposalStateOf as sharedProposalStateOf, rememberProposalState } from '../../../services/trade/proposalDisposition';
import { CopyChip, PinChip, RetryChip, ThinkingTierChip } from '../../shared/chatChips';
import AnswerBody from '../../shared/AnswerBody';
import ChatFailureRow from '../../shared/ChatFailureRow';
import { BotFace } from '../../chat/BotFace';

/** Prov line: short session id · model short · thinking tier · notebook
 *  count · relative time. CODE-CALCULATED only — never "Mock" in real UI,
 *  never invented numbers. */
const provLine = (e: LiveEntry): string | null => {
    const parts: string[] = [];
    const sid = e.speaker?.split(':')[0]?.replace(/-/g, '').slice(0, 6);
    if (sid && sid !== 'desk') parts.push(sid);
    // Model short: seat label's second half ("provider:model") already in
    // `speaker`; fall back to nothing rather than a fabricated name.
    const model = e.speaker?.split(':')[1]?.split('/').pop()?.slice(0, 12);
    if (model) parts.push(model);
    if (e.effort) parts.push(String(e.effort));
    if (e.at) {
        const mins = Math.max(0, Math.round((Date.now() - e.at) / 60_000));
        parts.push(mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
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
    entries, send, setDraftText, getAnalysisMessage, resolveVerdictByIdentity, symbol, getMark, onChatLevels,
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
    // through props for no win at the 60-entry cap.)
    const answerStreamingFlags = React.useMemo<boolean[]>(() => {
        const flags = new Array<boolean>(entries.length);
        let seen = false;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            flags[i] = seen;
            if (entries[i].streaming) seen = true;
        }
        return flags;
    }, [entries]);
    return (
        <>
            {entries.map((e, i) => {
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
                <div key={e.id} className="chat-fade-in" data-entry-id={e.id} data-message-id={analysisId ?? e.id} data-testid={`chat-entry-${e.role}`}>
                    {e.role === 'user' ? (
                        <div className="flex flex-col items-end gap-1.5">
                            {e.image && (
                                <div className="flex flex-col items-end gap-0.5">
                                    <img src={e.image} alt="attached" className="max-h-40 rounded-bubble border border-white/10 object-contain" />
                                    {!answerStreaming && <RetryChip onRetry={() => void send('', e.id)} />}
                                </div>
                            )}
                            {!e.image && e.imageOmitted && (
                                // A restored backup carries no image bytes: the row must
                                // still say an image was attached — and never via an <img>
                                // with a missing src, which renders as a broken icon.
                                <div
                                    data-testid="chat-image-omitted"
                                    className="rounded-control border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-ui-dense text-zinc-500"
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
            })}
        </>
    );
};

export default React.memo(ChatTranscriptList);
