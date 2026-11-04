/**
 * ChatComposer — the dock's composer, extracted from TradeChatPanel.
 * Props-only: the draft and the attach menu are the SHELL's state (they keep
 * their lifetime across session switches, as before) — only their setters ride
 * in as props. The model control is the shared `ModelChip` — one trigger that
 * names the provider, the model and the thinking tier, and one panel that edits
 * all three — so this file passes a value, a tier and their writers and nothing
 * else. The +
 * attach button (files + images + chart screenshot), the scan→skills chip and
 * Full analysis behave exactly as they did inline; the send button doubles as
 * Stop while a run is live.
 */

import React, { useLayoutEffect } from 'react';
import {Camera, FileText, Plus, TriangleAlert, SendIcon, StopIcon, ChartBarIcon, LayersIcon} from '../../shared/Icons';
import type { ProviderConfig } from '../../../types/provider';
import type { Attachment } from '../../../hooks/useChatAttachments';
import type { ReasoningEffort } from '../../../services/providers/reasoningControls';
import { formatModelDisplayName } from '../../../utils/providerUtils';

import ModelChip from '../../shared/ModelChip';
import ChatAttachmentStrip from './ChatAttachmentStrip';
import ComposerWorkspaceRow from './ComposerWorkspaceRow';
import * as chatStore from '../../../services/trade/chatStore';

/** Composer chip + the empty-state "Scan chart → skills" prompt: the model
 *  reads the WHOLE tape via the scan_chart_skills desk tool and drafts skills
 *  that wait for approval in the Inbox. Exported because the shell's
 *  screener-prefill listener drops the same prompt into the draft. */
export const SCAN_SKILLS_PROMPT = 'Scan every candle of this chart with scan_chart_skills: study the hour-by-hour movement, the ≥10% up and down legs and what preceded them — if we could turn back time, when should we have been in? Create your best candidates from what the tape proves (a trigger sentence plus a procedure, not a generic rule), and tell me what you created and which times and moves support it.';

interface ChatComposerProps {
    /** The chart the chat talks about (workspace row + model picker). */
    symbol: string;
    interval: string;
    isPanel: boolean;
    /** A send needs a ready provider (panels: at least 2 seats). */
    ready: boolean;
    /** A run is live — the send button is a Stop. */
    busy: boolean;
    draft: string;
    setDraft: React.Dispatch<React.SetStateAction<string>>;
    /** The runner's send — Enter, the scan chip and the send button. */
    send: (raw: string, retryOf?: string) => Promise<void>;
    runFullAnalysis: () => Promise<void>;
    /** Absent ⇒ the Full-analysis option is hidden (no pipeline attached). The
     *  button itself calls `runFullAnalysis`; this is read only for whether a
     *  pipeline exists at all. */
    onRunAnalysis?: (prompt: string, images: Array<{ name: string; dataURL: string }>) => Promise<void>;
    /** Stop the running pipeline as well as the chat turn. Aborting ONLY the
     *  chat controller (what this button used to do) left a Full analysis
     *  streaming — and spending — under a bubble that said it had stopped,
     *  because the pipeline never reads that controller. Absent ⇒ Stop keeps
     *  its old chat-only meaning. */
    onStopRun?: () => void;
    effort: ReasoningEffort;
    /** Writes the tier onto the active chat session — the row the Agents surface
     *  renders too, so one pick is both homes' pick. */
    changeEffort: (next: ReasoningEffort) => void;
    /** Visible explanation when the stored model pick went stale. */
    modelIssue: string | null;
    provider: ProviderConfig | null;
    selectedChatModel: string;
    /** Keeps the app-wide default AND binds the active session. */
    changeSoloModel: (value: string) => void;
    providers: ProviderConfig[];
    onRefreshModels?: () => Promise<void>;
    attachments: Attachment[];
    removeAttachment: (id: string) => void;
    fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
    attachFiles: (files: FileList | null) => void;
    showAttachMenu: boolean;
    setShowAttachMenu: React.Dispatch<React.SetStateAction<boolean>>;
    /** Captures the chart as the one image that never came off the picker. */
    captureChart: () => void;
    onCaptureChart?: () => string | null;
    /** So a "Try in chat" skill chip can drop its /slug in and refocus. */
    composerRef: React.RefObject<HTMLTextAreaElement | null>;
    /** Workspace-row readouts (panel seats + picker state). */
    panelCount: number;
    pickerOpen: boolean;
    onTogglePicker: () => void;
    botName: string | null;
    contextAt: number | null;
}

/**
 * The amber "your pick is not answering" banner. Exported because the Chat
 * surface composer is a different component and must say the same thing in the
 * same words when the same stored model goes stale — one surface warning and
 * one silently answering from another model is the bug this splits.
 */
export const ModelFallbackBanner: React.FC<{
    modelIssue: string | null;
    provider: ProviderConfig | null;
}> = ({ modelIssue, provider }) => (
    modelIssue && provider ? (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-control border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-ui-dense leading-4 text-amber-300" data-testid="model-fallback-warning" role="status">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                {modelIssue} Answering with <strong className="font-semibold">{provider.name} · {formatModelDisplayName(provider.selectedModel)}</strong> — re-pick a model in the dropdown.
            </span>
        </div>
    ) : null
);

const ChatComposer: React.FC<ChatComposerProps> = ({
    symbol, interval, isPanel, ready, busy, draft, setDraft, send, runFullAnalysis, onRunAnalysis, onStopRun,
    effort, changeEffort, modelIssue, provider, selectedChatModel,
    changeSoloModel, providers, onRefreshModels, attachments, removeAttachment, fileInputRef,
    attachFiles, showAttachMenu, setShowAttachMenu, captureChart, onCaptureChart, composerRef,
    panelCount, pickerOpen, onTogglePicker, botName, contextAt,
}) => {
    // The field is one line at rest and grows with the draft, up to a ceiling;
    // a fixed `min-h-[56px]` gave a one-line "what about now?" two lines of
    // empty card, which is most of what made the composer read as a panel.
    // `rows={1}` stays the SSR/first-paint height; this only replaces it after
    // a real measurement. The observer re-fits when the DOCK is dragged wider
    // or narrower — the height is a function of the current width, not only of
    // the draft, and a stale height after a resize is a tall empty box.
    useLayoutEffect(() => {
        const el = composerRef.current;
        if (!el) return;
        const fit = (): void => {
            el.style.height = 'auto';
            el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 160)}px`;
        };
        fit();
        const host = el.parentElement;
        if (!host || typeof ResizeObserver === 'undefined') return;
        let lastWidth = host.clientWidth;
        const observer = new ResizeObserver(entries => {
            const width = Math.round(entries[0]?.contentRect.width ?? 0);
            if (width === lastWidth) return;
            lastWidth = width;
            fit();
        });
        observer.observe(host);
        return () => observer.disconnect();
    }, [draft, composerRef]);

    // One shared ModelChip (components/shared/ModelChip.tsx), which is now also
    // the effort dial: the tier rides the trigger's label and is edited on the
    // slider in the same panel, so the Agents surface and this dock cannot end up
    // with a dial the other lacks — or a label that disagrees with the request.
    // Flat by owner ruling (2026-10-27). This block used to sit on a translucent
    // band (`bg-zinc-900/45`) closed off from the transcript by a hairline
    // (`border-t`). Both are gone: the coin row, the card and the note under it
    // now sit on the dock's own panel, and the card's frame is the only boundary
    // in the area — which is the point of the card existing at all.
    return (
    <div className="shrink-0 px-5 pb-3 pt-2">
        <ModelFallbackBanner modelIssue={modelIssue} provider={provider} />
        <ComposerWorkspaceRow
            symbol={symbol}
            interval={interval}
            isPanel={isPanel}
            panelCount={panelCount}
            pickerOpen={pickerOpen}
            onTogglePicker={onTogglePicker}
            botName={botName}
            contextAt={contextAt}
        />
        {attachments.length > 0 && (
            <ChatAttachmentStrip
                attachments={attachments}
                onRemove={removeAttachment}
            />
        )}
        {/* The card IS the field: what you type, what rides the message
            (attachments), and the controls that send it. Market context — the
            coin and the timeframe — does not live in here; on the Agents surface
            they sit on their own row outside the card (see AgentsView). */}
        <div className="rounded-composer bg-surface-raised px-4 py-3 ring-1 ring-transparent transition-[background-color,box-shadow] duration-150 ease-[var(--ease-snappy)] focus-within:bg-zinc-800/80 focus-within:ring-zinc-700">
            <textarea
                ref={composerRef}
                data-testid="composer-input"
                rows={1}
                value={draft}
                disabled={!ready}
                onChange={ev => setDraft(ev.target.value)}
                onKeyDown={ev => {
                    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(draft); }
                }}
                placeholder={ready ? 'Ask about the chart or a plan…' : isPanel ? 'Add at least 2 panel models above' : 'Configure a provider in Settings first'}
                className="max-h-40 min-h-[40px] w-full resize-none overflow-y-auto bg-transparent py-0.5 text-ui-base leading-7 text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* The control set is STABLE: Full analysis is present from the
                    first paint (disabled until there is a draft) and the model
                    chip takes the remaining width with `flex-1`, so typing the
                    first character cannot reveal a control, wrap the row, and
                    grow the card under the cursor. The chip truncates instead. */}
                <input type="file" multiple accept="image/*,.md,.txt,.csv,.json" ref={fileInputRef} className="hidden"
                    onChange={ev => { attachFiles(ev.target.files); ev.target.value = ''; }} />
                {/* Reference layout: ONE + button opens everything that
                    can ride the message — uploads AND the chart shot. */}
                <div className="relative">
                    <button type="button" onClick={() => setShowAttachMenu(v => !v)} disabled={!ready}
                        title="Attach to this message" aria-label="Attach to this message" aria-expanded={showAttachMenu}
                        className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40">
                        <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                    </button>
                    {showAttachMenu && (
                        <>
                            <div className="fixed inset-0 z-20" aria-hidden onClick={() => setShowAttachMenu(false)} />
                            <div className="absolute bottom-9 left-0 z-30 w-48 rounded-card border border-zinc-700/60 bg-zinc-800 p-1" data-testid="attach-menu">
                                <button type="button" onClick={() => { setShowAttachMenu(false); fileInputRef.current?.click(); }}
                                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 hover:bg-white/[0.06]">
                                    <FileText className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Upload files &amp; images
                                </button>
                                <button type="button" onClick={() => { setShowAttachMenu(false); captureChart(); }}
                                    disabled={!onCaptureChart} title={onCaptureChart ? undefined : 'Chart not ready'}
                                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] disabled:opacity-40">
                                    <Camera className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Screenshot chart
                                </button>
                                {/* The two prompt ACTIONS live here now, not as
                                    chips on the row: v3's composer is the box
                                    alone (＋ · model · send), and an action
                                    still needs a door. They are message
                                    actions, so they ride the message's own
                                    menu rather than decorating the box. */}
                                <div aria-hidden="true" className="my-1 h-px bg-white/[0.07]" />
                                <button type="button" data-testid="composer-scan-skills"
                                    onClick={() => { setShowAttachMenu(false); void send(SCAN_SKILLS_PROMPT); }}
                                    disabled={!ready || busy}
                                    title="Study every candle in this chart and create candidate skills from what actually worked — each is a trigger + procedure, and evidence sets its status"
                                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] disabled:opacity-40">
                                    <LayersIcon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Study the chart → skills
                                </button>
                                {onRunAnalysis && !isPanel && (
                                    <button type="button" data-testid="composer-full-analysis"
                                        onClick={() => { setShowAttachMenu(false); void runFullAnalysis(); }}
                                        disabled={busy || !draft.trim()}
                                        title={draft.trim()
                                            ? 'Run the full analysis (live market data + tools + trade plan) on this request'
                                            : 'Type a request to run the full analysis'}
                                        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] disabled:opacity-40">
                                        <ChartBarIcon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Full analysis
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
                <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5" data-testid="composer-model-and-send">
                    {!isPanel && (
                        <ModelChip providers={providers} value={selectedChatModel} onChange={changeSoloModel}
                            onRefreshModels={onRefreshModels} issue={modelIssue} fallbackLabel={provider?.name}
                            effort={effort} onEffortChange={changeEffort} compact />
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            if (!busy) { void send(draft); return; }
                            // Both, and in this order: the chat controller settles
                            // the bubble as a deliberate stop, the pipeline cancel
                            // actually ends the run. Either alone leaves half the
                            // job done — that is the defect this order fixes.
                            onStopRun?.();
                            chatStore.abortActive();
                        }}
                        disabled={!ready && !busy}
                        aria-label={busy ? 'Stop' : 'Send'}
                        /* The pair above is what right-aligns this button now,
                           so its own `ml-auto` is gone: the reference keeps the
                           send at the composer's bottom-right, never bottom-left. */
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-zinc-100 transition-colors hover:bg-zinc-600 disabled:opacity-40"
                    >
                        {busy ? <StopIcon className="h-3 w-3" fill="currentColor" /> : <SendIcon className="h-[18px] w-[18px]" aria-hidden="true" />}
                    </button>
                </div>
            </div>
        </div>
        {/* The footer row that used to hold the two chips is deleted with them;
            the disclaimer keeps its own line under the card. */}
        <p className="mt-1.5 px-2 text-ui-xs leading-relaxed text-zinc-600">
            Analysis and journaling only — it never places or signs a trade.
        </p>
    </div>
    );
};

export default React.memo(ChatComposer);
