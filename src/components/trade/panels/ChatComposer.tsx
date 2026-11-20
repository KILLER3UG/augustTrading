/**
 * ChatComposer — the dock's composer, extracted from TradeChatPanel.
 * Props-only: the draft and the attach menu are the SHELL's state (they keep
 * their lifetime across session switches, as before) — only their setters ride
 * in as props. The model control is the shared `ModelChip` — one trigger that
 * names the provider, the model and the thinking tier, and one panel that edits
 * all three — so this file passes a value, a tier and their writers and nothing
 * else. The +
 * attach button (files + images + chart screenshot) and Full analysis behave
 * exactly as they did inline; the send button doubles as
 * Stop while a run is live.
 */

import React, { useLayoutEffect } from 'react';
import {Camera, FileText, Plus, TriangleAlert, SendIcon, StopIcon, ChartBarIcon, LayersIcon} from '../../shared/Icons';
import type { ProviderConfig } from '../../../types/provider';
import type { Attachment } from '../../../hooks/useChatAttachments';
import type { ReasoningEffort } from '../../../services/providers/reasoningControls';
import { formatModelDisplayName } from '../../../utils/providerUtils';
import { useEscapeClose } from '../../../hooks/useEscapeClose';

import ModelChip from '../../shared/ModelChip';
import ChatAttachmentStrip from './ChatAttachmentStrip';
import ComposerWorkspaceRow from './ComposerWorkspaceRow';
import * as chatStore from '../../../services/trade/chatStore';
import { parseComposerRefs } from '../../../utils/composerRefs';

interface ChatComposerProps {
    /** Desk dock vs centered Chat focus view. */
    layoutMode?: 'desk' | 'chat';
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
        <div className="mb-1.5 flex items-start gap-1.5 rounded-control border border-zinc-500/30 bg-zinc-500/10 px-2.5 py-1.5 text-ui-dense leading-4 text-zinc-300" data-testid="model-fallback-warning" role="status">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                {modelIssue} Answering with <strong className="font-semibold">{provider.name} · {formatModelDisplayName(provider.selectedModel)}</strong> — re-pick a model in the dropdown.
            </span>
        </div>
    ) : null
);

const ChatComposer: React.FC<ChatComposerProps> = ({
    layoutMode = 'desk', symbol, interval, isPanel, ready, busy, draft, setDraft, send, runFullAnalysis, onRunAnalysis, onStopRun,
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
    const isChatFocus = layoutMode === 'chat';
    const hasContent = draft.trim().length > 0 || attachments.length > 0;
    // Live `@` reference chips: the trader sees exactly what the turn will
    // focus on (@#D1, @4h, @skill:slug, @plan:id) before sending.
    const parsedRefs = parseComposerRefs(draft);
    const refChips = [...parsedRefs.refs.shapes, ...parsedRefs.refs.timeframes, ...parsedRefs.refs.skills.map(sk => `skill:${sk}`), ...parsedRefs.refs.plans.map(pl => `plan:${pl}`)];

    // The attach menu is a click-outside popover, so it owns Escape too — the
    // same contract the symbol picker and the timeframe menus keep.
    useEscapeClose(showAttachMenu, () => setShowAttachMenu(false));

    return (
    <div className={isChatFocus ? 'mx-auto w-full max-w-[740px] shrink-0 px-6 pb-5 pt-2' : 'shrink-0 px-4 pb-3.5 pt-2'}>
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
        <div className="rounded-[20px] border border-white/[0.09] bg-zinc-900/90 px-3.5 pb-2.5 pt-3 shadow-[0_8px_28px_rgba(0,0,0,0.35)] transition-[border-color,background-color,box-shadow] duration-150 ease-[var(--ease-snappy)] focus-within:border-white/[0.18] focus-within:bg-zinc-900">
            <textarea
                ref={composerRef}
                data-testid="composer-input"
                rows={1}
                value={draft}
                disabled={!ready}
                onChange={ev => setDraft(ev.target.value)}
                onKeyDown={ev => {
                    // Esc while a run is live aborts it (the keyboard twin of
                    // the Stop control) — and never wipes the draft.
                    if (ev.key === 'Escape' && busy) {
                        ev.preventDefault();
                        onStopRun?.();
                        chatStore.abortActive();
                        return;
                    }
                    if (ev.key === 'Enter' && !ev.shiftKey) {
                        ev.preventDefault();
                        // Two-speed input (pi-style): while a turn is live,
                        // Enter STEERS it (the loop injects the message at the
                        // next round boundary) and Alt+Enter QUEUES it for
                        // after the turn. Esc stays with the Stop control.
                        if (busy && draft.trim()) {
                            if (ev.altKey) chatStore.queueFollowUp(draft);
                            else chatStore.queueSteering(draft);
                            setDraft('');
                            return;
                        }
                        void send(draft);
                    }
                }}
                placeholder={ready ? (isChatFocus ? 'Write a message…' : 'Ask about the chart or a plan…') : isPanel ? 'Add at least 2 panel models above' : 'Configure a provider in Settings first'}
                className="max-h-40 min-h-[38px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-ui-base leading-7 text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-50"
            />
            {refChips.length > 0 && (
                <div data-testid="composer-ref-chips" className="mt-1 flex flex-wrap items-center gap-1 px-1">
                    {refChips.map(chip => (
                        <span key={chip} className="rounded-control border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-300">
                            @{chip}
                        </span>
                    ))}
                </div>
            )}
            {busy && (
                <p data-testid="steering-hint" className="mt-0.5 px-1 text-ui-2xs text-zinc-600">
                    Enter: steer · Alt+Enter: queue
                </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <input type="file" multiple accept="image/*,.md,.txt,.csv,.json" ref={fileInputRef} className="hidden"
                    onChange={ev => { attachFiles(ev.target.files); ev.target.value = ''; }} />
                <div className="relative">
                    <button type="button" onClick={() => setShowAttachMenu(v => !v)} disabled={!ready}
                        title="Attach to this message" aria-label="Attach to this message" aria-expanded={showAttachMenu}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40">
                        <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                    </button>
                    {showAttachMenu && (
                        <>
                            {/* z-shield for backdrop and panel alike (panel
                                renders after, so it paints above): inside the
                                dock's stacking context the rung only has to sit
                                above the composer content while still being ONE
                                rung for every click-outside backdrop — see
                                index.css --z-shield. */}
                            <div className="fixed inset-0 z-shield" aria-hidden onClick={() => setShowAttachMenu(false)} />
                            <div className="absolute bottom-10 left-0 z-shield w-52 rounded-card border border-white/[0.1] bg-zinc-900/95 p-1 shadow-elevated backdrop-blur-md" data-testid="attach-menu">
                                <button type="button" onClick={() => { setShowAttachMenu(false); fileInputRef.current?.click(); }}
                                    className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100">
                                    <FileText className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Upload files &amp; images
                                </button>
                                <button type="button" onClick={() => { setShowAttachMenu(false); captureChart(); }}
                                    disabled={!onCaptureChart} title={onCaptureChart ? undefined : 'Chart not ready'}
                                    className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40">
                                    <Camera className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Screenshot chart
                                </button>
                                <div aria-hidden="true" className="my-1 h-px bg-white/[0.07]" />
                                <button type="button" data-testid="composer-full-analysis"
                                        onClick={() => { setShowAttachMenu(false); void runFullAnalysis(); }}
                                        disabled={busy || !draft.trim()}
                                        title={draft.trim()
                                            ? 'Run the full analysis (live market data + tools + trade plan) on this request'
                                            : 'Type a request to run the full analysis'}
                                        className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ui-dense text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40">
                                        <ChartBarIcon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" /> Full analysis
                                    </button>
                            </div>
                        </>
                    )}
                </div>
                <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2" data-testid="composer-model-and-send">
                    {!isPanel && (
                        <ModelChip providers={providers} value={selectedChatModel} onChange={changeSoloModel}
                            onRefreshModels={onRefreshModels} issue={modelIssue} fallbackLabel={provider?.name}
                            effort={effort} onEffortChange={changeEffort} compact={!isChatFocus} />
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            if (!busy) { void send(draft); return; }
                            onStopRun?.();
                            chatStore.abortActive();
                        }}
                        disabled={!ready && !busy}
                        aria-label={busy ? 'Stop' : 'Send'}
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 ${
                            busy
                                ? 'bg-zinc-200 text-zinc-950 hover:bg-white'
                                : ready && hasContent
                                    ? 'bg-zinc-100 text-zinc-950 hover:bg-white'
                                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
                        }`}
                    >
                        {busy ? <StopIcon className="h-3 w-3" fill="currentColor" /> : <SendIcon className="h-4 w-4" aria-hidden="true" />}
                    </button>
                </div>
            </div>
        </div>
    </div>
    );
};

export default React.memo(ChatComposer);
