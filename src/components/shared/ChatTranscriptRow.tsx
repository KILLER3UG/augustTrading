/**
 * One transcript row, shared by the Chart AI dock and the Agents surface.
 *
 * The dock already had this furniture — markdown body, Thought rows, desk-tool
 * activity, side-effect status rows, copy, key levels, the verdict — and the
 * Agents surface was still a bare `{m.text}` div. Rather than write it twice,
 * both now render this over their own row model (see `ChatRowView`).
 *
 * Two things are honestly approximate and say so at the call site rather than
 * faking:
 *
 *  - **Tool and reasoning are separate blocks here.** The dock interleaves
 *    tool calls INTO the reasoning stream via a `[Desk tools]` marker the
 *    provider emits mid-answer. A settled pipeline `Message` has no single
 *    ordered stream — the trace and the tool trail are independent
 *    collections — so they render as their own rows.
 *  - **The tool trail is a list, and it survives the turn.** `Message.toolEvents`
 *    is one entry per line — the settled record of what the desk called — and
 *    `Message.toolIds` is the payload id for each of those lines, so a row can
 *    open onto the REAL output the tool returned. `Message.liveToolEvents` is
 *    the capped, newline-joined LIVE feed: it is what a filling bubble shows,
 *    and it is the fallback for rows written before the trail existed.
 */
import React, { useMemo, useState } from 'react';
import { InterruptedRunNotice } from './InterruptedRunNotice';
import ChatWorkTimeline, { type ChatWorkView } from '../trade/panels/ChatWorkTimeline';
import { CopyChip, EditChip, FadingText, PinChip, RevertChip, RetryChip, SpeakChip, ThinkingTierChip, VersionStepper } from './chatChips';
import AnswerBody from './AnswerBody';
import ChatFailureRow from './ChatFailureRow';
import { BotFace } from '../chat/BotFace';
import KeyLevelsCard from '../trade/KeyLevelsCard';
import SignalCard, { signalIdFromActions, signalRowById } from '../trade/SignalCard';
import InlineVerdict from '../analysis/InlineVerdict';
import TradeProposalCard, { TradeProposalLoggedRow } from '../trade/panels/TradeProposalCard';
import { parseKeyLevels, type ModelKeyLevel } from '../../services/trade/keyLevels';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import type { ProposalState } from '../../services/trade/proposalDisposition';
import type { PromptEdit } from '../../utils/messageVersions';
import type { TradeAnalysis } from '../../types';
import type { ToolAction } from '../../types/message';
import type { ReasoningEffort, WireAuditEntry } from '../../types/provider';

export type ChatRowRole = 'user' | 'ai';

export interface ChatRowView {
    id: string;
    role: ChatRowRole;
    text: string;
    /** Who said it — bot name, seat name, or 'desk'. */
    speaker?: string;
    /** Pre-formatted relative time. */
    timeLabel?: string;
    /** True while this turn is still producing. */
    streaming?: boolean;
    images?: string[];
    /** Merged reasoning trace (per-seat maps are joined by the caller). */
    reasoning?: string;
    /** Live desk-tool call/result lines. */
    toolLines?: string[];
    /** The payload id for each entry of `toolLines`, same order. The expander
     *  opens onto the REAL output the tool returned, so a row without one
     *  stays a plain row. */
    toolIds?: string[];
    /** What the wire was actually asked, one entry per call. It is what lets
     *  the row say WHY a turn has no trace. */
    wireAudit?: WireAuditEntry[];
    /** The turn FAILED and this is the real reason. A row with an error is
     *  NOT an answer: it renders the failure in the failure's own colour, so
     *  the transcript never shows the app's error hint as though the seat
     *  had said it. */
    error?: string;
    /** Persistent side-effect status rows. */
    actions?: ToolAction[];
    /** Frozen work time in ms from `Message.runStats` — what the collapsed
     *  block shows after the live clock is gone. Persisted, so it survives a
     *  reload of a settled answer. */
    workedMs?: number;
    /** Epoch-ms the turn started (`Message.createdAt`). The live clock reads
     *  it, so a row remounted by a surface hop continues the timer. */
    startedAt?: number;
    analysis?: TradeAnalysis;
    /** This run was interrupted (explicit Stop, or a failure mid-turn). The row
     *  renders an in-flow notice offering Edit prompt / Try again rather than
     *  leaving a half-written answer with no way forward. */
    interrupted?: boolean;
    /** The prompt that was interrupted, so "Edit prompt" can prefill the
     *  composer with what the user actually asked rather than a blank box. */
    interruptedPrompt?: string;
    /** The thinking tier the answer was produced under — shown as a muted
     *  chip on the action row. Absent on rows written before the tier was
     *  recorded; a row that does not know shows nothing rather than a guess. */
    effort?: ReasoningEffort;
}

export interface ChatTranscriptRowProps {
    row: ChatRowView;
    /** Omit on surfaces with no canvas — the card then renders as a plain
     *  table, without the live-distance column or the "draw on chart" action,
     *  because both are meaningless away from a chart. */
    symbol?: string;
    getMark?: () => number | null;
    onChatLevels?: (payload: never, ownerId?: string) => void;
    onRetry?: () => void;
    /** Prefill the composer with the interrupted prompt — "Edit prompt". */
    onEditPrompt?: (prompt: string) => void;
    pinned?: boolean;
    onTogglePin?: () => void;
    onLogTrade?: (analysis: TradeAnalysis) => void;
    canLogTrade?: boolean;
    /** ── Revert and versions (2026-10-27) ──
     *  All optional: a host that has not wired the conversation store simply
     *  draws no controls, rather than drawing ones that do nothing. */
    /** Save a new wording for this PROMPT and re-ask it. The host keeps the
     *  words being replaced as a version of this row. */
    onEditPromptMessage?: (messageId: string, newText: string) => void;
    /** Park every turn after this one, so the thread ends here. */
    onRevertTo?: (messageId: string) => void;
    /** How many turns live after this row. 0 hides the restore control — a
     *  button that parks nothing is a button that lies. */
    turnsAfter?: number;
    /** Which generation of this answer is on screen, and how many exist.
     *  Scalars plus ONE stable callback rather than a `{index,total,onStep}`
     *  object: the object was rebuilt on every parent render, so React.memo
     *  compared a fresh reference every time and never held. The stepper draws
     *  only where there is a choice (total > 1) and a host wired the step. */
    versionIndex?: number;
    versionTotal?: number;
    onStepVersion?: (messageId: string, delta: number) => void;
    /** Wordings this prompt carried before the current one. */
    priorPrompts?: PromptEdit[];
    /** ── The decision cards under the answer ──
     *  These used to be `children`: JSX the parent rebuilt on every render,
     *  which defeated the memo even when every other prop was stable. They are
     *  DATA now — plain values and stable callbacks the row renders into the
     *  same cards, in the same place, so an unchanged row is a shallow-equal
     *  row. The verdict table needs no prop of its own: it reads `row.analysis`,
     *  the one projection that already decides whether this turn carries a
     *  plan (a planId-stamped receipt carries none, so it draws none). */
    /** The plan this row PRESENTED via the present_trade tool. */
    proposal?: TradeProposal;
    /** The plan this row's PROSE describes, when the seat never called the
     *  tool. The caller caches it per message — a fresh parse per render is a
     *  fresh object, and a fresh object is a re-render. */
    prosePlan?: TradeProposal | null;
    /** The trader's recorded disposition on this row's plan, from the ONE
     *  module store both transcript homes share. */
    proposalState?: ProposalState;
    /** A journal is attached — without it the card hides Log and the prose
     *  chip disables it, rather than drawing a button that clicks into nothing. */
    canLogProposal?: boolean;
    /** THIS row's Log click is awaiting the gate stamp. */
    awaitingProposalLog?: boolean;
    /** ANY row's Log click is in flight — the prose chip waits for it too. */
    proposalLogBusy?: boolean;
    /** Log the plan this row carries. `kind` names the card that asked: a
     *  prose plan may still need its planId minted, a presented one has it. */
    onLogProposal?: (messageId: string, plan: TradeProposal, kind: 'presented' | 'prose') => void;
    /** Dismiss the plan — the card/chip never comes back. */
    onDismissProposal?: (messageId: string) => void;
}

const ChatTranscriptRow: React.FC<ChatTranscriptRowProps> = ({
    row, symbol, getMark, onChatLevels, onRetry, onEditPrompt, pinned, onTogglePin, onLogTrade, canLogTrade,
    onEditPromptMessage, onRevertTo, turnsAfter = 0, versionIndex, versionTotal, onStepVersion, priorPrompts,
    proposal, prosePlan, proposalState, canLogProposal, awaitingProposalLog, proposalLogBusy,
    onLogProposal, onDismissProposal,
}) => {
    const isUser = row.role === 'user';
    const deskSpeaker = !row.speaker || row.speaker.trim().toLowerCase() === 'desk';
    const canEdit = isUser && !!onEditPromptMessage && !row.streaming && !row.error;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(row.text);
    const startEdit = (): void => { setDraft(row.text); setEditing(true); };
    const cancelEdit = (): void => { setEditing(false); setDraft(row.text); };
    const saveEdit = (): void => {
        const next = draft.trim();
        setEditing(false);
        if (!next || next === row.text) return;
        onEditPromptMessage?.(row.id, next);
    };
    // Only a CLOSED key-levels fence yields levels; an open one is stripped
    // from `clean` so the protocol never flashes mid-stream.
    const levels: ModelKeyLevel[] | null =
        !isUser && row.text ? parseKeyLevels(row.text).levels : null;
    const body = levels && levels.length > 0 ? parseKeyLevels(row.text).clean : row.text;

    const work: ChatWorkView = {
        id: row.id,
        reasoning: row.reasoning,
        tools: row.toolLines ?? [],
        toolIds: row.toolIds,
        wireAudit: row.wireAudit,
        streaming: row.streaming,
        text: row.text,
        actions: row.actions,
        workedMs: row.workedMs,
        startedAt: row.startedAt,
    };

    return (
        <div
            data-message-id={row.id}
            data-role={row.role}
            data-testid={isUser ? 'agent-message' : 'agent-message'}
            className={`group/msg chat-fade-in flex ${isUser ? 'justify-end pl-8' : 'items-start gap-3.5 pr-2 sm:pr-8'}`}
        >
            {/* The reference identifies the answer with an avatar, not a
                byline. The seat's name stays on the avatar's accessible name;
                the turn itself carries no stamp above the text. */}
            {!isUser && (
                <span
                    className="mt-0.5 shrink-0"
                    title={row.speaker ?? 'desk'}
                    aria-label={row.speaker ?? 'desk'}
                    data-testid="row-avatar"
                >
                    <BotFace
                        face={deskSpeaker ? { shape: 'circle', hue: '#4d9fff' } : 'auto'}
                        name={row.speaker ?? 'desk'}
                        size={28}
                        working={!!row.streaming}
                    />
                </span>
            )}
            <div className={`min-w-0 ${isUser ? 'flex max-w-[68%] flex-col items-end' : 'flex-1'}`}>
            {isUser && row.images && row.images.length > 0 && (
                <div className="mb-1 flex flex-wrap justify-end gap-1">
                    {row.images.map((src, i) => (
                        <img key={i} src={src} alt=""
                            className="max-h-40 rounded-control border border-zinc-800" />
                    ))}
                </div>
            )}

            {isUser && editing ? (
                /* The edit is IN the thread, not in the composer: the trader is
                   changing the words that produced the answer below them, and
                   sending them through the composer would ask a NEW question
                   while leaving this one's wording on screen. */
                <div className="w-full rounded-bubble border border-hairline bg-surface-raised p-2.5">
                    <textarea
                        autoFocus
                        rows={3}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                        }}
                        aria-label="Edit your message"
                        data-testid="edit-message-input"
                        className="w-full resize-none bg-transparent text-ui-base leading-relaxed text-zinc-100 outline-none"
                    />
                    <div className="mt-1.5 flex items-center justify-end gap-1.5">
                        <button type="button" onClick={cancelEdit}
                            className="rounded-control px-2 py-1 text-ui-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                            Cancel
                        </button>
                        <button type="button" onClick={saveEdit}
                            disabled={!draft.trim() || draft.trim() === row.text}
                            data-testid="edit-message-save"
                            className="rounded-full bg-zinc-100 px-2.5 py-1 text-ui-xs font-semibold text-zinc-900 transition-opacity hover:opacity-90 disabled:opacity-40">
                            Save &amp; re-ask
                        </button>
                    </div>
                </div>
            ) : isUser ? (
                /* The reference's own bubble caps at roughly 60% of the thread
                   column, so a long question wraps instead of running edge to
                   edge. At 85% the bubble read as a full-width band and the
                   right-hand alignment — the thing that says "this is mine" —
                   disappeared. The trader's own words are INTERFACE, not prose:
                   they stay in the UI sans. */
                <div className="max-w-full rounded-bubble bg-zinc-800 px-4 py-2.5 text-ui-base leading-relaxed text-zinc-100">
                    <FadingText text={body} streaming={!!row.streaming} />
                </div>
            ) : row.error ? (
                /* A FAILED turn is not an answer. It is the provider's own
                   words — the status, the message, the cause underneath — and
                   it is drawn in the failure colour so the reader never
                   mistakes the app's error for the seat's opinion. */
                <ChatFailureRow error={row.error} />
            ) : (
                    <div className="w-full max-w-full space-y-2 text-ui-base leading-[1.7] text-zinc-200">
                        {/* Signal row: the ledger call, when this turn
                            emitted one. Never fabricated. */}
                        {(() => {
                            const sid = signalIdFromActions(row.actions);
                            if (!sid) return null;
                            const ledgerRow = signalRowById(sid);
                            if (!ledgerRow) return null;
                            return (
                                <SignalCard
                                    signal={ledgerRow.signal}
                                    row={ledgerRow}
                                />
                            );
                        })()}
                        <ChatWorkTimeline entry={work} />
                    {body.trim()
                        /* The answer takes the prose measure (`.chat-prose`,
                           42rem) and nothing else in this row does: the work
                           timeline above it and the verdict or key-level card
                           below it keep the full 920px column, because a table
                           at reading width is a table that wraps its own
                           numbers. One row, two widths, on purpose. */
                        ? <div className="chat-prose"><AnswerBody text={body} streaming={!!row.streaming} /></div>
                        : <span className="text-zinc-500">{row.analysis ? 'Analysis' : '…'}</span>}
                    {/* The decision cards, fed from DATA props rather than children
                        JSX, so the memo boundary stays props-pure. The verdict is
                        fed from the ROW MODEL, never from the raw message: a
                        "Logged from Chart AI" receipt carries a copy of the plan's
                        analysis for the journal row and the autopilot, and reading
                        it here drew the identical ENTRY/STOP/TARGET/PROBABILITY
                        card a second time in the same turn. `chatRowFrom` is the
                        one place that decides. */}
                    <InlineVerdict analysis={row.analysis} />
                    {/* A plan the model PRESENTED gets the SAME decision card the
                        dock renders. One disposition store, keyed by the row id
                        both homes share: logging on the chart marks this card
                        logged, and a re-click is a no-op rather than a second
                        journal row. */}
                    {proposal && proposalState === undefined && (
                        <TradeProposalCard
                            proposal={proposal}
                            canLog={!!canLogProposal}
                            awaitingLog={!!awaitingProposalLog}
                            onLog={() => onLogProposal?.(row.id, proposal, 'presented')}
                            onCancel={() => onDismissProposal?.(row.id)}
                        />
                    )}
                    {/* The seat DESCRIBED a plan and never called present_trade.
                        The prose carries the same three numbers, so the row offers
                        the same decision instead of leaving the plan in a sentence
                        the journal never sees. Validation is NOT re-implemented
                        here: the caller's planFromProse hands the numbers to
                        parseTradeProposal, which already refuses a long whose stop
                        sits above its entry. */}
                    {!proposal && proposalState === undefined && prosePlan && (
                        <div className="mt-1 flex items-center gap-2" data-testid="prose-plan-chip">
                            <button type="button" disabled={!canLogProposal || !!proposalLogBusy}
                                className="rounded-control border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-ui-dense font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                                onClick={() => onLogProposal?.(row.id, prosePlan, 'prose')}>
                                Log this? {prosePlan.direction} {prosePlan.symbol} @ {prosePlan.entry}
                            </button>
                            <button type="button" aria-label="Not this plan"
                                className="text-ui-dense text-zinc-500 transition-colors hover:text-zinc-300"
                                onClick={() => onDismissProposal?.(row.id)}>
                                dismiss
                            </button>
                        </div>
                    )}
                    {/* A logged plan — presented OR prose — leaves the receipt.
                        The two old branches (with/without a presented proposal)
                        render the identical row, so one condition covers both. */}
                    {proposalState === 'logged' && <TradeProposalLoggedRow />}
                </div>
            )}

            {!isUser && levels && levels.length > 0 && symbol && (
                <div className="mt-1 max-w-[85%] w-full">
                    <KeyLevelsCard
                        levels={levels}
                        symbol={symbol}
                        messageId={row.id}
                        getMark={getMark}
                        onChatLevels={onChatLevels as never}
                    />
                </div>
            )}

            {/* The action row is ALWAYS VISIBLE on the reference, not
                hover-released. Hover-reveal hid copy/read-aloud from anyone who
                did not know to hunt for them, and a control you have to discover
                by accident is half a control. The row drops its hover-only
                opacity; the chips inside keep their own hover affordances.

                Thumbs up/down are DELIBERATELY absent — cut this pass as a
                product decision, not finished and disabled. */}
            {/* An interrupted run is a dead end without this. Rendered IN FLOW
                (not a hover chip) because the whole point is that the user finds
                out the run stopped and can fix it. `ChatTranscriptRow.tsx:130`'s
                post-mortem retry is the precedent — same placement, same reuse of
                the `retryOf` re-dispatch. The hover `RetryChip` stays for
                successful rows.

                Requires at least ONE handler: a "Run stopped" label with no
                button beside it is a dead notice — it names a problem and offers
                no way out, which is worse than saying nothing. */}
            {!isUser && row.interrupted && (
                <InterruptedRunNotice
                    onEditPrompt={onEditPrompt && row.interruptedPrompt
                        ? () => onEditPrompt(row.interruptedPrompt!)
                        : undefined}
                    onTryAgain={onRetry ?? undefined}
                />
            )}

            <div className="mt-2 flex items-center gap-1.5">
                {isUser && onRetry && <RetryChip onRetry={onRetry} />}
                {canEdit && (
                    <EditChip edited={(priorPrompts?.length ?? 0) > 0} onEdit={startEdit} />
                )}
                {/* The tier this answer was produced under. It leads the row
                    because it is a fact about the ANSWER, not an action on it —
                    the actions below are the ones that change something. */}
                {!isUser && row.effort && <ThinkingTierChip effort={row.effort} />}
                <CopyChip text={row.text} />
                {!isUser && <SpeakChip text={row.text} />}
                {!isUser && onTogglePin && (
                    <PinChip pinned={!!pinned} onToggle={onTogglePin} />
                )}
                {/* Which answer you are looking at, when this row has been
                    re-run. Placed with the actions because stepping one is a
                    choice the trader makes, not a property of the turn. */}
                {!isUser && onStepVersion && (versionTotal ?? 0) > 1 && (
                    <VersionStepper
                        index={versionIndex ?? 0}
                        total={versionTotal ?? 0}
                        onStep={delta => onStepVersion(row.id, delta)}
                    />
                )}
                {!editing && onRevertTo && (
                    <RevertChip onRevert={() => onRevertTo(row.id)} after={turnsAfter} />
                )}
                {!isUser && canLogTrade && onLogTrade && row.analysis && (
                    <button type="button" onClick={() => onLogTrade(row.analysis!)}
                        className="rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                        Log this trade
                    </button>
                )}
                {/* The reference's trailing "5 minutes ago". Callers already
                    format this once (`ChatRowView.timeLabel`, the same helper the
                    history palette uses), so the row renders that label rather
                    than deriving a second opinion of what "2 days ago" means. */}
                {row.timeLabel && (
                    <span className="ml-auto shrink-0 text-ui-2xs tabular-nums text-zinc-600">{row.timeLabel}</span>
                )}
            </div>
            </div>
        </div>
    );
};

export default React.memo(ChatTranscriptRow);
