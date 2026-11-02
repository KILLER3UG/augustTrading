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
import React, { useState } from 'react';
import { InterruptedRunNotice } from './InterruptedRunNotice';
import ChatWorkTimeline, { type ChatWorkView } from '../trade/panels/ChatWorkTimeline';
import { CopyChip, EditChip, FadingText, PinChip, RevertChip, RetryChip, SpeakChip, ThinkingTierChip, VersionStepper } from './chatChips';
import AnswerBody from './AnswerBody';
import ChatFailureRow from './ChatFailureRow';
import { BotFace } from '../chat/BotFace';
import KeyLevelsCard from '../trade/KeyLevelsCard';
import { parseKeyLevels, type ModelKeyLevel } from '../../services/trade/keyLevels';
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
    /** The answer's versions, when it has more than one. */
    versions?: { index: number; total: number; onStep: (delta: number) => void };
    /** Wordings this prompt carried before the current one. */
    priorPrompts?: PromptEdit[];
    /** Extra chrome the caller renders under the bubble (the verdict card). */
    children?: React.ReactNode;
}

const ChatTranscriptRow: React.FC<ChatTranscriptRowProps> = ({
    row, symbol, getMark, onChatLevels, onRetry, onEditPrompt, pinned, onTogglePin, onLogTrade, canLogTrade,
    onEditPromptMessage, onRevertTo, turnsAfter = 0, versions, priorPrompts, children,
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
    };

    return (
        <div
            data-message-id={row.id}
            data-role={row.role}
            data-testid={isUser ? 'agent-message' : 'agent-message'}
            className={`group/msg flex ${isUser ? 'justify-end pl-8' : 'items-start gap-3.5 pr-2 sm:pr-8'}`}
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
                <div className="w-full rounded-bubble border border-white/[0.09] bg-surface-raised p-2.5">
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
                    {children}
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
                {!isUser && versions && (
                    <VersionStepper index={versions.index} total={versions.total} onStep={versions.onStep} />
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
