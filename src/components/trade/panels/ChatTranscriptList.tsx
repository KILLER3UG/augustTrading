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

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Virtuoso, type FollowOutput, type VirtuosoHandle } from 'react-virtuoso';
import { Camera, Zap } from '../../shared/Icons';
import { InterruptedRunNotice } from '../../shared/InterruptedRunNotice';
import type { Message } from '../../../types/message';
import type { LiveEntry } from '../../../services/trade/chatStore';
import { parseKeyLevels, type MessageLevelLines } from '../../../services/trade/keyLevels';
import type { TradeProposal } from '../../../services/trade/proposedTrade';
import { formatSeatLabel } from '../../../utils/providerUtils';
import ChatWorkTimeline from './ChatWorkTimeline';
import TradeProposalCard, { TradeProposalLoggedRow } from './TradeProposalCard';
import SettlementCorrectionCard from './SettlementCorrectionCard';
import RiskChangeCard from './RiskChangeCard';
import TradeActionCard from './TradeActionCard';
import { settlementCorrectionStateOf, type SettlementCorrectionProposal } from '../../../services/trade/settlementCorrection';
import { tradeActionStateOf, type TradeActionProposal } from '../../../services/trade/tradeActionProposal';
import { riskChangeStateOf, riskRevertOf, type RiskChangeProposal } from '../../../services/trade/riskChangeProposal';
import {
    aiSettingChangeStateOf, aiSettingRevertOf, type AiSettingProposal,
} from '../../../services/trade/aiSettingProposal';
import AiSettingCard from './AiSettingCard';
import { strategyActivationStateOf, strategyRevertOf, type StrategyActivationProposal } from '../../../services/trade/strategyActivation';
import StrategyActivationCard from './StrategyActivationCard';
import SessionPlanCard from './SessionPlanCard';
import RuleProposalCard from './RuleProposalCard';
import {
    sessionPlanStateOf, sessionPlanRevertOf, type SessionPlanProposal,
} from '../../../services/trade/sessionPlan';
import {
    ruleProposalStateOf, ruleProposalRevertOf, type RuleProposal,
} from '../../../services/learning/candidateRuleLoop';
import StatsCard from './StatsCard';
import { getArmedPlans } from '../../../services/trade/levelWatchService';
import type { GuardEnforcement } from '../../../services/validation/SessionGuardService';
import type { LoggedTrade } from '../../../types';
import VerdictAudit, { verdictNeedsAudit } from '../../analysis/VerdictAudit';
import InlineVerdict from '../../analysis/InlineVerdict';
import MemoryProvenanceStrip from '../../chat/MemoryProvenanceStrip';
import KeyLevelsCard from '../KeyLevelsCard';
import SignalCard, { DeskScorecard, signalIdFromActions, signalRowById } from '../SignalCard';
import Disclosure from '../../shared/Disclosure';
import { JUMP_AWAY_PX } from '../../shared/JumpToLatestFab';
import { ageMinutes, roundAgoHoursLabel } from '../../../utils/relativeTime';
import { harnessNoticeDisplay, stripInternalContextMarks } from '../../../utils/chatDisplay';
import { proposalStateOf as sharedProposalStateOf, rememberProposalState, forgetProposalState } from '../../../services/trade/proposalDisposition';
import { markUndoWindow, undoWindowOf, clearUndoWindow } from '../../../services/trade/tradeDecision';
import { CopyChip, PinChip, RetryChip, ThinkingTierChip } from '../../shared/chatChips';
import AnswerBody from '../../shared/AnswerBody';
import ChatFailureRow from '../../shared/ChatFailureRow';
import { BotFace } from '../../chat/BotFace';

/** Virtuoso inputs held at MODULE scope: a fresh object or function on every
 *  render makes the virtualizer re-measure and re-render its whole window — a
 *  visible stall on the pane flip at <lg, where the transcript goes from
 *  hidden to full height mid-conversation. */
const INCREASE_VIEWPORT_BY = { top: 600, bottom: 600 } as const;
const computeEntryKey = (_index: number, entry: LiveEntry): string => entry.id;

/** A user message's attached image. A src that will not decode (a probe
 *  placeholder, a stripped backup) used to render the browser's broken-image
 *  glyph with alt="attached" — the UI audit's broken-attachment defect. One
 *  onError state swap: the decoded image when it decodes, a quiet monochrome
 *  chip when it does not. */
const AttachmentImage: React.FC<{ src: string }> = ({ src }) => {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return (
            <span
                data-testid="chat-attachment-fallback"
                className="flex items-center gap-1.5 rounded-control border border-hairline bg-zinc-900/60 px-2.5 py-1.5 text-ui-dense text-zinc-500"
            >
                <Camera className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Chart snapshot
            </span>
        );
    }
    return (
        <img
            src={src}
            alt="attached chart"
            onError={() => setFailed(true)}
            className="max-h-40 rounded-bubble border border-hairline object-contain"
        />
    );
};

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

/** The pushback prompt "Ask why" pre-fills the composer with. It names the
 *  plan's actual numbers so the model answers about THIS setup, not about
 *  trading in general — and it asks for the falsifier, because a plan the
 *  trader cannot break is not a plan, it is a hope. */
const askWhyPrompt = (p: TradeProposal): string => (
    `Why this trade? Walk me through the ${p.direction.toLowerCase()} on ${p.symbol}`
    + ` at ${p.entry} (stop ${p.stopLoss}, targets ${p.takeProfits.join('/')}).`
    + ` What invalidates it, and what makes this entry worth the risk now?`
);

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
    /** Approve on a decision card → App runs the gated human log path and
     *  returns the journal ROW id it wrote (or false/null/void when the gate
     *  refused or the trader cancelled a confirm). The row id opens the
     *  card's undo window. `sessionId` is the dock session the card lives
     *  in — the approval-receipt harness turn is routed to that thread.
     *  Absent ⇒ the Approve button is hidden (no journal attached). */
    onLogProposedTrade?: (proposal: TradeProposal, sessionId?: string) => Promise<string | false> | string | false | void;
    /** The dock session id the transcript belongs to — routed to the approve
     *  handler so the receipt lands in the conversation that presented the
     *  plan. */
    sessionId?: string;
    /** Reject on a decision card → App records the decline (the HOLD ledger,
     *  source 'desk') with the card's optional reason. Returns whether the
     *  record landed — false keeps the card live (a decline that failed to
     *  write is not a decline). The disposition that takes the card off
     *  screen stays here, and only runs when the record landed. */
    onRejectProposedTrade?: (proposal: TradeProposal, reason?: string) => boolean;
    /** Undo inside the approval window → App deletes the pending row and its
     *  receipt message, disarms the plan watch and clears the receipt dedupe
     *  (a later re-approve is a fresh decision). */
    onUndoApproval?: (decision: { rowId: string; planId?: string; entryId: string; sessionId?: string }) => void;
    /** Confirm a PROPOSED risk-limit / guard-preset change → App writes it
     *  through the ONE settings writer the trader's own Settings screen uses,
     *  stamps the revert window and notes the thread. The card's asymmetry
     *  (one tap to tighten, an explicit re-confirm to loosen) is the card's. */
    onConfirmRiskChange?: (proposal: RiskChangeProposal, sessionId?: string) => void;
    /** Dismiss a PROPOSED risk change — the setting is untouched. */
    onDismissRiskChange?: (proposal: RiskChangeProposal) => void;
    /** Revert a confirmed change inside its window → App restores the
     *  replaced value through the same settings writer and notes the thread. */
    onRevertRiskChange?: (proposal: RiskChangeProposal, sessionId?: string) => void;
    /** Confirm a PROPOSED AI-behavior setting toggle → App writes it through
     *  the same settings path the trader's Settings screen uses. */
    onConfirmAiSettingChange?: (proposal: AiSettingProposal, sessionId?: string) => void;
    /** Dismiss a PROPOSED AI setting change — nothing was toggled. */
    onDismissAiSettingChange?: (proposal: AiSettingProposal) => void;
    /** Restore the replaced setting inside the 60s revert window. */
    onRevertAiSettingChange?: (proposal: AiSettingProposal, sessionId?: string) => void;
    /** The journal rows, so a settlement-correction card can show the "before"
     *  half of what it changes (the same input the Chat row gets). */
    trades?: LoggedTrade[];
    /** The session-guard enforcement verdict over those rows: non-null
     *  `block` disables the proposal card's Approve (the log writer refuses on
     *  the same computation); `warnings` print without blocking. */
    sessionGuard?: GuardEnforcement;
    /** Confirm a PROPOSED settlement fix. The handler applies it through the
     *  SAME journal hooks a human edit calls; this list only renders the card
     *  and reports the tap. Absent ⇒ the Confirm button is hidden. */
    onConfirmSettlementCorrection?: (proposal: SettlementCorrectionProposal) => void;
    /** Dismiss a PROPOSED settlement fix — the row is untouched. */
    onDismissSettlementCorrection?: (proposal: SettlementCorrectionProposal) => void;
    /** VOID a PROPOSED settlement fix — the trader deletes the row instead of
     *  applying the correction (P-6's separate explicit delete). */
    onVoidSettlementCorrection?: (proposal: SettlementCorrectionProposal) => void;
    /** Confirm a PROPOSED action on an armed plan (move levels / close).
     *  Applied through App's watch/journal writers, never from this row. */
    onConfirmTradeAction?: (proposal: TradeActionProposal) => void;
    /** Dismiss a PROPOSED trade action — the armed plan is untouched. */
    onDismissTradeAction?: (proposal: TradeActionProposal) => void;
    /** Confirm a PROPOSED strategy activation/retirement. Applied through the
     *  SAME writer the Settings screen uses (setStrategyStatus); this list
     *  only renders the card and reports the tap. */
    onConfirmStrategyActivation?: (proposal: StrategyActivationProposal, sessionId?: string) => void;
    /** Dismiss a PROPOSED strategy change — the plan is untouched. */
    onDismissStrategyActivation?: (proposal: StrategyActivationProposal) => void;
    /** Put the replaced status back inside the revert window. */
    onRevertStrategyActivation?: (proposal: StrategyActivationProposal, sessionId?: string) => void;
    /** Confirm a PROPOSED session plan. The plan is persisted only by this
     *  tap, through the sessionPlan store; the list renders and reports. */
    onConfirmSessionPlan?: (proposal: SessionPlanProposal, sessionId?: string) => void;
    onDismissSessionPlan?: (proposal: SessionPlanProposal) => void;
    onRevertSessionPlan?: (proposal: SessionPlanProposal, sessionId?: string) => void;
    /** Confirm a PROPOSED trading rule. Confirm starts its TTL in the
     *  candidateRuleLoop store; the card itself writes nothing. */
    onConfirmRuleProposal?: (proposal: RuleProposal, sessionId?: string) => void;
    onDismissRuleProposal?: (proposal: RuleProposal) => void;
    onRevertRuleProposal?: (proposal: RuleProposal, sessionId?: string) => void;
}

const ChatTranscriptList: React.FC<ChatTranscriptListProps> = ({
    entries, scrollParent, virtuosoRef, followOutput, onAtBottomChange, onTotalHeightChanged,
    send, setDraftText, getAnalysisMessage, resolveVerdictByIdentity, symbol, getMark, onChatLevels,
    onToggleWatch, pinnedMessageIds, onLogProposedTrade, sessionId, onRejectProposedTrade, onUndoApproval, trades,
    sessionGuard,
    onConfirmRiskChange, onDismissRiskChange, onRevertRiskChange,
    onConfirmAiSettingChange, onDismissAiSettingChange, onRevertAiSettingChange,
    onConfirmSettlementCorrection, onDismissSettlementCorrection, onVoidSettlementCorrection,
    onConfirmTradeAction, onDismissTradeAction,
    onConfirmStrategyActivation, onDismissStrategyActivation, onRevertStrategyActivation,
    onConfirmSessionPlan, onDismissSessionPlan, onRevertSessionPlan,
    onConfirmRuleProposal, onDismissRuleProposal, onRevertRuleProposal,
}) => {
    /** Re-render trigger for the module-scope proposal dispositions (see
     *  proposalDisposition): the disposition itself must SURVIVE a dock
     *  unmount, the state here only makes React repaint the card. */
    const [proposalTick, setProposalTick] = useState(0);
    /** Which entry's Log click is currently awaiting the gate stamp. Local (not
     *  the module map) on purpose: it is a transient, and a pending await that
     *  survived an unmount would disable a button that no longer exists. */
    const [awaitingLogEntryId, setAwaitingLogEntryId] = useState<string | null>(null);
    /** Re-render trigger for the module-scope decision-card stores (the
     *  settlement-correction and trade-action dispositions). Like
     *  `proposalTick`: the decision survives a dock unmount in its own store,
     *  the state here only makes the resolved card leave the screen. */
    const [decisionTick, setDecisionTick] = useState(0);
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
        // The displayed text NEVER carries the app's internal context marks —
        // on BOTH branches: the key-levels fence's clean text used to skip the
        // strip, so a transport that echoes its input (the probe mock) painted
        // `[LIVE CHART CONTEXT …]` into a bubble that also carried a fence.
        const shownText = aiLevels?.hadBlock
            ? stripInternalContextMarks(aiLevels.clean)
            : stripInternalContextMarks(e.text);
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
                                <AttachmentImage src={e.image} />
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
                    /* A harness event is the APP speaking — a receipt or a
                        warning, never a model answer. One quiet monochrome
                        line: the amber uppercase block read as an alarm and
                        leaked the machine voice (the approval receipt) into
                        the trader's transcript. */
                    <p className="flex items-center gap-1.5 text-ui-xs text-zinc-500" data-testid="chat-notice">
                        <Zap className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden="true" />
                        <span>{harnessNoticeDisplay(e.tools[0] ?? 'Harness event') || 'Harness event'}</span>
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
                                /* Neutral face (owner 1.4.2): the desk's avatar
                                    was a bright blue circle beside every answer
                                    — a third accent in chrome that must stay
                                    monochrome. Green/red belong to price and
                                    direction; the desk is zinc. */
                                face={deskSpeaker ? { shape: 'circle', hue: '#71717a' } : 'auto'}
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
                        {/* A PROPOSED settlement fix (correct_trade_outcome).
                            The card holds no authority: Confirm routes to the
                            SAME journal hooks a human edit calls, and nothing
                            changes until that tap. The disposition lives in
                            the correction store at module scope, so a decided
                            card stays decided across a dock unmount — the same
                            contract as the proposal map below. */}
                        {(() => {
                            void decisionTick;
                            const p = e.settlementCorrection;
                            if (!p || settlementCorrectionStateOf(p.tradeId) !== undefined) return null;
                            const row = trades?.find(t => t.id === p.tradeId);
                            return (
                                <SettlementCorrectionCard
                                    proposal={p}
                                    current={row ? { outcome: row.outcome, pnlAmount: row.pnlAmount, pnlPercent: row.pnlPercent, entry: row.analysis?.entryPoints?.[0]?.price ? Number(row.analysis.entryPoints[0].price) : undefined } : undefined}
                                    onConfirm={() => { onConfirmSettlementCorrection?.(p); setDecisionTick(t => t + 1); }}
                                    onDismiss={() => { onDismissSettlementCorrection?.(p); setDecisionTick(t => t + 1); }}
                                    onVoid={() => { onVoidSettlementCorrection?.(p); setDecisionTick(t => t + 1); }}
                                />
                            );
                        })()}
                        {/* A PROPOSED action on an ARMED plan (update_trade /
                            close_trade). Confirm applies it through App's
                            watch/journal writers; the card itself writes
                            nothing. The plan's CURRENT levels come from the
                            watch service — the dock is the surface that arms
                            it, so the before/after is real here. */}
                        {(() => {
                            void decisionTick;
                            const p = e.tradeAction;
                            if (!p || tradeActionStateOf(p.planId) !== undefined) return null;
                            const plan = getArmedPlans().find(x => x.planId === p.planId);
                            return (
                                <TradeActionCard
                                    proposal={p}
                                    current={plan ? { entry: plan.entry, stopLoss: plan.stopLoss, takeProfits: plan.takeProfits } : undefined}
                                    onConfirm={() => { onConfirmTradeAction?.(p); setDecisionTick(t => t + 1); }}
                                    onDismiss={() => { onDismissTradeAction?.(p); setDecisionTick(t => t + 1); }}
                                />
                            );
                        })()}
                        {/* A PROPOSED risk-limit / guard-preset change
                            (propose_risk_change). The card's asymmetry is the
                            owner's rule: one tap to TIGHTEN, an explicit
                            second tap to LOOSEN. Confirm writes through the
                            settings writer the trader owns; a confirmed change
                            stays for a short revert window. */}
                        {(() => {
                            void decisionTick;
                            const p = e.riskChange;
                            if (!p) return null;
                            const state = riskChangeStateOf(p.id);
                            const revert = riskRevertOf(p.id);
                            if (!state && !revert) {
                                return (
                                    <RiskChangeCard
                                        proposal={p}
                                        onConfirm={() => { onConfirmRiskChange?.(p, sessionId); setDecisionTick(t => t + 1); }}
                                        onDismiss={() => { onDismissRiskChange?.(p); setDecisionTick(t => t + 1); }}
                                    />
                                );
                            }
                            if (state === 'confirmed') {
                                return (
                                    <RiskChangeCard
                                        proposal={p}
                                        applied
                                        revert={revert}
                                        onRevert={revert ? () => { onRevertRiskChange?.(p, sessionId); setDecisionTick(t => t + 1); } : undefined}
                                    />
                                );
                            }
                            return null;
                        })()}
                        {/* A PROPOSED AI-behavior setting toggle (Commit 4.7):
                            Hybrid Intelligence / Desk Tools left Settings for
                            this card. Turning a capability OFF tightens and
                            confirms in one tap; turning it ON asks again. The
                            confirm writes through the trader's settings path
                            and the applied card offers a 60s revert. */}
                        {(() => {
                            void decisionTick;
                            const ap = e.aiSettingChange;
                            if (!ap) return null;
                            const state = aiSettingChangeStateOf(ap.id);
                            const revert = aiSettingRevertOf(ap.id);
                            if (!state && !revert) {
                                return (
                                    <AiSettingCard
                                        proposal={ap}
                                        onConfirm={() => { onConfirmAiSettingChange?.(ap, sessionId); setDecisionTick(t => t + 1); }}
                                        onDismiss={() => { onDismissAiSettingChange?.(ap); setDecisionTick(t => t + 1); }}
                                    />
                                );
                            }
                            if (state === 'confirmed') {
                                return (
                                    <AiSettingCard
                                        proposal={ap}
                                        applied
                                        revert={revert}
                                        onRevert={revert ? () => { onRevertAiSettingChange?.(ap, sessionId); setDecisionTick(t => t + 1); } : undefined}
                                    />
                                );
                            }
                            return null;
                        })()}
                        {/* A PROPOSED strategy activation/retirement
                            (propose_strategy_activation). Same decision-card
                            shape: Confirm applies through the writer the
                            trader owns; a confirmed change stays for the same
                            revert window as the risk card. */}
                        {(() => {
                            void decisionTick;
                            const sp = e.strategyActivation;
                            if (!sp) return null;
                            const state = strategyActivationStateOf(sp.id);
                            const revert = strategyRevertOf(sp.id);
                            if (!state && !revert) {
                                return (
                                    <StrategyActivationCard
                                        proposal={sp}
                                        onConfirm={() => { onConfirmStrategyActivation?.(sp, sessionId); setDecisionTick(t => t + 1); }}
                                        onDismiss={() => { onDismissStrategyActivation?.(sp); setDecisionTick(t => t + 1); }}
                                    />
                                );
                            }
                            if (state === 'confirmed') {
                                return (
                                    <StrategyActivationCard
                                        proposal={sp}
                                        applied
                                        revert={revert}
                                        onRevert={revert ? () => { onRevertStrategyActivation?.(sp, sessionId); setDecisionTick(t => t + 1); } : undefined}
                                    />
                                );
                            }
                            return null;
                        })()}
                        {/* A PROPOSED session plan (propose_session_plan).
                            Confirm persists the plan; Dismiss resolves the card
                            without touching the live session. A confirmed plan
                            stays for the 60s revert window, then reads as a
                            verified once-per-session record. */}
                        {(() => {
                            void decisionTick;
                            const p = e.sessionPlan;
                            if (!p) return null;
                            const state = sessionPlanStateOf(p.id);
                            const revert = sessionPlanRevertOf(p.id);
                            if (!state && !revert) {
                                return (
                                    <SessionPlanCard
                                        proposal={p}
                                        onConfirm={() => { onConfirmSessionPlan?.(p, sessionId); setDecisionTick(t => t + 1); }}
                                        onDismiss={() => { onDismissSessionPlan?.(p); setDecisionTick(t => t + 1); }}
                                    />
                                );
                            }
                            if (state === 'confirmed') {
                                return (
                                    <SessionPlanCard
                                        proposal={p}
                                        applied
                                        revert={revert}
                                        onRevert={revert ? () => { onRevertSessionPlan?.(p, sessionId); setDecisionTick(t => t + 1); } : undefined}
                                    />
                                );
                            }
                            return null;
                        })()}
                        {/* A PROPOSED trading rule (propose_rule_change). The
                            anti-hindsight split is printed on the card; Confirm
                            is the only writer and starts the TTL. */}
                        {(() => {
                            void decisionTick;
                            const p = e.ruleProposal;
                            if (!p) return null;
                            const state = ruleProposalStateOf(p.id);
                            const revert = ruleProposalRevertOf(p.id);
                            if (!state && !revert) {
                                return (
                                    <RuleProposalCard
                                        proposal={p}
                                        onConfirm={() => { onConfirmRuleProposal?.(p, sessionId); setDecisionTick(t => t + 1); }}
                                        onDismiss={() => { onDismissRuleProposal?.(p); setDecisionTick(t => t + 1); }}
                                    />
                                );
                            }
                            if (state === 'confirmed') {
                                return (
                                    <RuleProposalCard
                                        proposal={p}
                                        applied
                                        revert={revert}
                                        onRevert={revert ? () => { onRevertRuleProposal?.(p, sessionId); setDecisionTick(t => t + 1); } : undefined}
                                    />
                                );
                            }
                            return null;
                        })()}
                        {/* P-5's rendering half: a stats-tool receipt rendered
                            as a card — the numbers ARE the tool output, the
                            sample size is always visible, and the model
                            never restates them in prose. */}
                        {e.statsCard && (
                            <StatsCard snapshot={e.statsCard} />
                        )}
                        {e.proposal && (!proposalStateOf(e.id) || (proposalStateOf(e.id) === 'logged' && !!undoWindowOf(e.id))) && (
                            <TradeProposalCard
                                proposal={e.proposal}
                                entryId={e.id}
                                canLog={!!onLogProposedTrade}
                                guardBlock={sessionGuard?.block ?? null}
                                guardWarnings={sessionGuard?.warnings ?? []}
                                logNote={e.error
                                    ? 'This plan arrived on a run that stopped before it finished — the rest of the answer never came.'
                                    : undefined}
                                awaitingLog={awaitingLogEntryId === e.id}
                                getMark={getMark}
                                presentedAt={e.at}
                                undoTick={proposalTick}
                                onUndoWindowClose={() => setProposalTick(t => t + 1)}
                                onApprove={async () => {
                                    // Double-approve guard: the disposition lives at module
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
                                    // await instead of being marked approved up front.
                                    // The handler returns the ROW id on success (the
                                    // handle the undo window reverses); anything else is
                                    // a refusal or a cancelled confirm.
                                    let approved: string | null;
                                    try {
                                        const res = await onLogProposedTrade?.(stamped, sessionId);
                                        approved = typeof res === 'string' ? res : null;
                                    }
                                    // An approve that threw is NOT an approval: the card
                                    // stays live so the trader can retry instead of
                                    // seeing ✓ Approved over a missing row.
                                    catch { approved = null; }
                                    finally { setAwaitingLogEntryId(null); }
                                    if (!approved) return;
                                    // The undo window opens on the ENTRY (the card's
                                    // identity, stable across a virtualized remount) with
                                    // the row id and plan it reverses.
                                    markUndoWindow(e.id, approved, stamped.planId);
                                    rememberProposalState(e.id, 'logged');
                                    setProposalTick(t => t + 1);
                                }}
                                onReject={(reason) => {
                                    if (sharedProposalStateOf(e.id)) return;
                                    // The decline is RECORDED by App (the HOLD ledger,
                                    // source 'desk', optional reason). A record that
                                    // failed to land keeps the card live — a decline
                                    // that was never written is not a decline.
                                    const recorded = onRejectProposedTrade
                                        ? onRejectProposedTrade(e.proposal!, reason)
                                        : true;
                                    if (!recorded) return;
                                    rememberProposalState(e.id, 'dismissed');
                                    setProposalTick(t => t + 1);
                                }}
                                onAskWhy={() => {
                                    // Pre-fill the composer with the pushback prompt —
                                    // the trader edits and sends it themselves; nothing
                                    // is sent by tapping the card.
                                    setDraftText?.(askWhyPrompt(e.proposal!));
                                }}
                                onUndo={() => {
                                    const w = undoWindowOf(e.id);
                                    if (!w) return;
                                    clearUndoWindow(e.id);
                                    onUndoApproval?.({ rowId: w.rowId, planId: w.planId, entryId: e.id, sessionId });
                                    // The card returns to undecided: the row was deleted
                                    // and the receipt message removed, so the trader can
                                    // approve again (a fresh decision, a fresh receipt).
                                    forgetProposalState(e.id);
                                    setProposalTick(t => t + 1);
                                }}
                            />
                        )}
                        {e.proposal && proposalStateOf(e.id) === 'logged' && !undoWindowOf(e.id) && <TradeProposalLoggedRow />}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    // `itemContent` must keep ONE identity for the life of this list: a fresh
    // function each render sends Virtuoso through a full window remount, which
    // is exactly what the <lg Chart|AI|Book flip exposed mid-conversation.
    // The ref carries the latest closure (ticks, handlers, props) into the
    // stable callback, and the context changes only when transcript state
    // changes — so a resize/visibility flip repaints cleanly with no remount.
    const renderEntryRef = useRef(renderEntry);
    renderEntryRef.current = renderEntry;
    const itemContent = useCallback((index: number, entry: LiveEntry) => renderEntryRef.current(index, entry), []);
    const virtuosoContext = useMemo(() => ({
        proposalTick, decisionTick, awaitingLogEntryId, pinnedMessageIds, sessionGuard,
        trades, symbol, resolveVerdictByIdentity, answerStreamingFlags,
    }), [proposalTick, decisionTick, awaitingLogEntryId, pinnedMessageIds, sessionGuard, trades, symbol, resolveVerdictByIdentity, answerStreamingFlags]);

    return (
        <Virtuoso
            ref={virtuosoRef}
            // The dock's own log box scrolls; Virtuoso renders into it rather
            // than growing a second scroller inside it.
            customScrollParent={scrollParent}
            data={entries}
            // The entry id is the row's identity across the merge, so a
            // recycled row never inherits another turn's DOM.
            computeItemKey={computeEntryKey}
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
            increaseViewportBy={INCREASE_VIEWPORT_BY}
            itemContent={itemContent}
            // Changing context repaints the mounted rows without changing the
            // itemContent identity — no window remount on a pane flip.
            context={virtuosoContext}
        />
    );
};

export default React.memo(ChatTranscriptList);
