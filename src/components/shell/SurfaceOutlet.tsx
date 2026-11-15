/**
 * SurfaceOutlet — the surface switch, extracted from App.tsx (plan O-105).
 *
 * App owned the whole shell AND the per-surface render in one ~2.7k-line
 * component. The switch is the part the workspace merge and the rail rebuild
 * have to touch, so it renders here as its own module and App only wires it.
 * Props-only and presentational: every handler and every value is handed in
 * from App, so this extraction moves markup and nothing else — no hook
 * re-homed, no effect re-timed, no behavior changed.
 *
 * The lazy declarations for the two desk surfaces live HERE, next to the
 * switch that mounts them. App's idle warm-up imports the same module paths,
 * so the bundler still dedupes each surface to one chunk.
 */

import React, { useMemo, useSyncExternalStore } from 'react';
import { Header } from '../shared/Header';
import ModelChip from '../shared/ModelChip';
import { DeskInstrument } from './ShellRail';
import type { AppSurface } from '../../hooks/useSurface';
import type { TradeMode } from '../trade/TradeView';
import type { Message, Conversation, LoggedTrade, TradeAnalysis } from '../../types';
import type { ProviderConfig, ReasoningEffort } from '../../types/provider';
import type { AgentBot, AgentGroup } from '../../services/agents/agentRoster';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import type { ThreadSelection, AgentThreadOpenedMap } from '../../utils/agentThreads';
import type { BotLearningStat } from '../../services/agents/botLearning';
import type { PipelineImage } from '../../hooks/useChatAttachments';
import type { SoloTurnRow } from '../../services/trade/chatTurnMirror';
import type { SettlementCorrectionProposal } from '../../services/trade/settlementCorrection';
import type { TradeActionProposal } from '../../services/trade/tradeActionProposal';
import * as chatStore from '../../services/trade/chatStore';

const TradeView = React.lazy(() => import('../trade/TradeView'));
const AgentsView = React.lazy(() => import('../agents/AgentsView'));

/**
 * Suspense fallback for the SURFACE-level lazy screens (TradeView,
 * StrategyStudio, the Agents roster). With fallback={null} the whole surface
 * flashed a blank black/white void for the duration of the chunk fetch
 * (audit: 21× fallback={null}). This is a quiet pulsing zinc panel that
 * matches the dark chrome — no new deps, no layout shift to the real screen.
 */
export const SurfaceSkeleton: React.FC = () => (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 bg-zinc-950 p-4" role="status" aria-label="Loading">
        <div className="h-8 w-40 animate-pulse rounded-control bg-zinc-900" />
        <div className="flex-1 animate-pulse rounded-bubble border border-hairline bg-zinc-900" />
    </div>
);

/**
 * The Agents surface's model control — provider, model and the thinking dial,
 * subscribed HERE rather than in App's body.
 *
 * `chatStore` latches the username it loaded for on its FIRST touch and rehashes
 * onto a different one the next time it writes. App renders before a profile is
 * chosen, so an App-level `useSyncExternalStore` over that store initialized it
 * against the empty username; the first persist then rehydrated it onto the real
 * one, and the session id the dock had been writing into simply stopped existing
 * — `mutate` no-ops on an unknown id, so a send appended nothing and the run
 * hung behind a bubble that never settled. Mounting this node is what touches
 * the store, and that only happens once the Agents surface is on screen.
 *
 * The snapshot is the tier itself, so the subscription re-renders on a real
 * change and not on every streaming patch of the session store.
 *
 * `showEffort` is handed IN rather than read here because a bot turn answers on
 * the bot's own config through a transport that never reads the dial, and only
 * the surface's own selection knows whether this turn is a bot's (E-51 §2).
 */
const SessionModelChip: React.FC<{
    providers: ProviderConfig[];
    value: string;
    onChange: (value: string) => void;
    onRefreshModels?: () => Promise<void>;
    issue: string | null;
    fallbackLabel?: string;
    showEffort: boolean;
}> = ({ providers, value, onChange, onRefreshModels, issue, fallbackLabel, showEffort }) => {
    const effort = useSyncExternalStore(chatStore.subscribe, chatStore.getActiveEffort, chatStore.getActiveEffort);
    return (
        <ModelChip providers={providers} value={value} onChange={onChange}
            onRefreshModels={onRefreshModels} issue={issue} fallbackLabel={fallbackLabel}
            effort={effort} onEffortChange={chatStore.setActiveEffort} showEffort={showEffort} />
    );
};

export interface SurfaceOutletProps {
    surface: AppSurface;
    /* ── The content bar (every surface but Agents) ─────────────────────── */
    saveStatus: 'SAVED' | 'SAVING' | 'ERROR';
    isAnalysisInProgress: boolean;
    currentVisionData: string[];
    pendingQueueCount: number;
    liveMarketConditions: { volatility: 'High' | 'Medium' | 'Low'; liquidation: 'High' | 'Medium' | 'Low'; lastUpdated: string } | null;
    liveMarketSymbol?: string;
    onOpenLiveMarket: () => void;
    onOpenVisionData: () => void;
    onToggleNavRail: () => void;
    navRailExpanded: boolean;
    /* ── Analyze (`trade`) ───────────────────────────────────────────────── */
    memoryEnabled: boolean;
    strategiesEnabled: boolean;
    providers: ProviderConfig[];
    selectedChatModel: string;
    onSelectChatModel: (modelId: string) => void;
    onRefreshModels: () => Promise<void>;
    tradeSidebarOpen: boolean;
    onToggleTradeSidebar: () => void;
    tradeModeRequest: { mode: TradeMode; n: number } | null;
    activeUsername: string | null;
    onTradeModeChange: (mode: TradeMode) => void;
    botThreadRows: Message[];
    onBotTurnCommit: (bot: AgentBot, prompt: string, answer?: string, workedMs?: number, effort?: ReasoningEffort) => void;
    onSoloTurnCommit: (row: SoloTurnRow, conversationId: string) => void;
    onSyncConversation: (conversationId?: string) => string | null;
    conversationRows: Message[];
    onNewGroup: () => void;
    verdict: TradeAnalysis | null;
    bots: AgentBot[];
    trades: LoggedTrade[];
    groupTabs: Array<{ id: string; name: string }>;
    botSessionRequest: { botId: string; nonce: number } | null;
    groupSessionRequest: { groupId: string; nonce: number } | null;
    onRunAnalysisFromChat: (prompt: string, images: Array<{ name: string; dataURL: string }>, fullAnalysis?: boolean) => Promise<void>;
    onAnalysisError: (message: string) => void;
    onCancelAnalysis: () => void;
    getAnalysisMessage: (messageId: string) => Message | undefined;
    onLogProposedTrade: (proposal: TradeProposal) => Promise<boolean>;
    registerScrollToMessage: (fn: ((messageId: string) => void) | null) => void;
    onToggleWatch: (messageId: string) => void;
    onOpenWatchList: () => void;
    /** Jump straight to the Agents surface from the dock header. */
    onOpenAgents: () => void;
    /** The dock's decision-card handlers (audit P-6): confirm/dismiss a
     *  PROPOSED settlement fix or trade action. Confirm applies through the
     *  SAME journal/watch writers the Chat surface's card uses. */
    onConfirmSettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onDismissSettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onConfirmTradeAction: (proposal: TradeActionProposal) => void;
    onDismissTradeAction: (proposal: TradeActionProposal) => void;
    watchOpenCount: number;
    watchOpenR: string | undefined;
    pinnedMessageIds: ReadonlySet<string>;
    renderGroupSurface: (groupId: string) => React.ReactNode;
    /* ── Agents (chat) ────────────────────────────────────────────────────── */
    groups: AgentGroup[];
    activeThread: ThreadSelection;
    onSelectThread: (t: ThreadSelection) => void;
    onNewBot: () => void;
    onSendBotTurn: (bot: AgentBot, prompt: string) => Promise<boolean>;
    onAnalyze: (prompt: string, images: PipelineImage[]) => Promise<void>;
    onApplySettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onApplyTradeAction: (proposal: TradeActionProposal) => void;
    onStopAgentsRun: (target?: { kind: 'analysis' } | { kind: 'dock'; conversationId: string } | { kind: 'bot'; botId: string }) => void;
    workingBotId: string | null;
    dmWorkingBotId: string | null;
    mailboxBusyBotIds: string[];
    threadOpenedMap: AgentThreadOpenedMap;
    attentionMap: Record<string, string>;
    botStats: BotLearningStat[];
    onDeleteBot: (botId: string) => void;
    onRenameBot: (botId: string, name: string) => void;
    onDeleteGroup: (groupId: string) => void;
    onEditGroup: (groupId: string) => void;
    changeChatSoloModel: (value: string) => void;
    chatModelFallback: {
        issue: string | null;
        providerName?: string;
        notice: { issue: string; provider: ProviderConfig } | null;
    };
    railExpanded: boolean;
    sidebarExpanded: boolean;
    onToggleRailExpanded: () => void;
    railWidth: number;
    railIsResizing: boolean;
    onRailResizeStart: (event: React.PointerEvent) => void;
    onRailResizeReset: () => void;
    onRevertTo: (messageId: string) => number;
    onEditPromptMessage: (messageId: string, newText: string) => void;
    onStepVersion: (messageId: string, delta: number) => void;
    parkedCount: number;
    onRestoreParked: () => number;
    accountRow: React.ReactNode;
    conversations: Conversation[];
    activeConversationId: string | null;
    onLoadConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onClearConversation: (id: string) => void;
    onNewChat: () => void;
}

const SurfaceOutlet: React.FC<SurfaceOutletProps> = ({
    surface,
    saveStatus, isAnalysisInProgress, currentVisionData, pendingQueueCount,
    liveMarketConditions, liveMarketSymbol, onOpenLiveMarket, onOpenVisionData,
    onToggleNavRail, navRailExpanded,
    memoryEnabled, strategiesEnabled, providers, selectedChatModel, onSelectChatModel,
    onRefreshModels, tradeSidebarOpen, onToggleTradeSidebar, tradeModeRequest,
    activeUsername, onTradeModeChange, botThreadRows, onBotTurnCommit, onSoloTurnCommit,
    onSyncConversation, conversationRows, onNewGroup, verdict, bots, trades, groupTabs,
    botSessionRequest, groupSessionRequest, onRunAnalysisFromChat, onAnalysisError,
    onCancelAnalysis, getAnalysisMessage, onLogProposedTrade, registerScrollToMessage,
    onToggleWatch, onOpenWatchList, onOpenAgents, watchOpenCount, watchOpenR, pinnedMessageIds,
    onConfirmSettlementCorrection, onDismissSettlementCorrection,
    onConfirmTradeAction, onDismissTradeAction,
    renderGroupSurface,
    groups, activeThread, onSelectThread, onNewBot, onSendBotTurn, onAnalyze,
    onApplySettlementCorrection, onApplyTradeAction, onStopAgentsRun,
    workingBotId, dmWorkingBotId, mailboxBusyBotIds, threadOpenedMap, attentionMap,
    botStats, onDeleteBot, onRenameBot, onDeleteGroup, onEditGroup,
    changeChatSoloModel, chatModelFallback,
    railExpanded, sidebarExpanded, onToggleRailExpanded, railWidth, railIsResizing,
    onRailResizeStart, onRailResizeReset,
    onRevertTo, onEditPromptMessage, onStepVersion, parkedCount, onRestoreParked,
    accountRow, conversations, activeConversationId, onLoadConversation, onDeleteConversation,
    onClearConversation, onNewChat,
}) => {
    /** What the content bar is about. The rail names the workspace; this names
     *  the thing being worked on. Memoized because Header is memoized on
     *  purpose: a fresh element on every price tick would re-render the whole
     *  bar for a label that has not moved. */
    const shellTitle = surface === 'agents' ? 'Chat AI' : 'Chart AI';
    const shellContext = useMemo(
        () => (surface === 'trade' ? <DeskInstrument /> : undefined),
        [surface],
    );

    return (
        <>
            {/* The content bar. The rail owns navigation; this bar names
                what is being worked on and carries the live state. On
                Agents, AgentsView's own bar is this bar — rendering a
                second one above it stacked two titles for one screen. */}
            {surface !== 'agents' && (
                <Header
                    saveStatus={saveStatus}
                    isAnalysisInProgress={isAnalysisInProgress}
                    currentVisionData={currentVisionData}
                    pendingQueueCount={pendingQueueCount}
                    liveMarketConditions={liveMarketConditions}
                    liveMarketSymbol={liveMarketSymbol}
                    onOpenLiveMarket={onOpenLiveMarket}
                    onOpenVisionData={onOpenVisionData}
                    hasVisionData={currentVisionData.length > 0}
                    title={shellTitle}
                    context={shellContext}
                    onToggleNavRail={onToggleNavRail}
                    navRailExpanded={navRailExpanded}
                />
            )}

            {surface === 'trade' && (
                <React.Suspense fallback={<SurfaceSkeleton />}>
                    <TradeView
                        memoryEnabled={memoryEnabled}
                        strategiesEnabled={strategiesEnabled}
                        providers={providers}
                        selectedChatModel={selectedChatModel}
                        onSelectChatModel={onSelectChatModel}
                        onRefreshModels={onRefreshModels}
                        sidebarOpen={surface === 'trade' && tradeSidebarOpen}
                        onToggleSidebar={onToggleTradeSidebar}
                        modeRequest={tradeModeRequest ?? undefined}
                        activeUsername={activeUsername ?? undefined}
                        onTradeModeChange={onTradeModeChange}
                        onOpenChat={onOpenAgents}
                        /* The same handlers the Chat rail gets, so the
                           dock is the Chat's compact form rather than
                           a reduced one: it can open a room, not just
                           list rooms. */
                        botThreadRows={botThreadRows}
                        onBotTurnCommit={onBotTurnCommit}
                        onSoloTurnCommit={onSoloTurnCommit}
                        onSyncConversation={onSyncConversation}
                        conversationRows={conversationRows}
                        onNewGroup={onNewGroup}
                        verdict={verdict}
                        bots={bots}
                        trades={trades}
                        groups={groupTabs}
                        botSessionRequest={botSessionRequest ?? undefined}
                        groupSessionRequest={groupSessionRequest ?? undefined}
                        onRunAnalysis={(prompt, images) => onRunAnalysisFromChat(prompt, images, true)}
                        onAnalysisError={onAnalysisError}
                        onStopRun={onCancelAnalysis}
                        getAnalysisMessage={getAnalysisMessage}
                        onLogProposedTrade={onLogProposedTrade}
                        registerScrollToMessage={registerScrollToMessage}
                        onToggleWatch={onToggleWatch}
                        onOpenWatchList={onOpenWatchList}
                        onConfirmSettlementCorrection={onConfirmSettlementCorrection}
                        onDismissSettlementCorrection={onDismissSettlementCorrection}
                        onConfirmTradeAction={onConfirmTradeAction}
                        onDismissTradeAction={onDismissTradeAction}
                        watchOpenCount={watchOpenCount}
                        watchOpenR={watchOpenR}
                        pinnedMessageIds={pinnedMessageIds}
                        renderGroupSurface={renderGroupSurface}
                    />
                </React.Suspense>
            )}

            {surface === 'agents' && (
                <React.Suspense fallback={<SurfaceSkeleton />}>
                    <AgentsView
                        username={activeUsername || ''}
                        bots={bots}
                        groups={groups}
                        messages={conversationRows}
                        selection={activeThread}
                        onSelect={onSelectThread}
                        onNewBot={onNewBot}
                        onNewGroup={onNewGroup}
                        onSendBotTurn={onSendBotTurn}
                        onAnalyze={onAnalyze}
                        onLogProposedTrade={onLogProposedTrade}
                        /* The settlement-correction write path: the
                           SAME handlers the Journal's own editors
                           call, so a confirmed correction lands with
                           the audit trail a human edit gets. */
                        trades={trades}
                        onApplySettlementCorrection={onApplySettlementCorrection}
                        /* The trade-action apply path: move the levels on the
                           armed plan (re-arm it with the confirmed levels) or
                           close it (disarm the watch). Written through the
                           watch service, not through this component. */
                        onApplyTradeAction={onApplyTradeAction}
                        onAnalysisError={onAnalysisError}
                        onStopRun={onStopAgentsRun}
                        analysisRunning={isAnalysisInProgress}
                        renderGroup={g => renderGroupSurface(g.id)}
                        workingBotId={workingBotId ?? dmWorkingBotId}
                        mailboxBusyBotIds={mailboxBusyBotIds}
                        lastOpenedMap={threadOpenedMap}
                        attentionMap={attentionMap}
                        botStats={botStats}
                        onDeleteBot={onDeleteBot}
                        onRenameBot={onRenameBot}
                        onDeleteGroup={onDeleteGroup}
                        onEditGroup={onEditGroup}
                        modelPicker={({ showEffort }) => (
                            /* The dock's control, not a plainer twin of
                               it: one trigger naming the provider, the
                               model AND the tier, opening one panel that
                               edits all three. The writes are the pair
                               the dock writes (`changeChatSoloModel`), and
                               the tier is subscribed inside the node — see
                               SessionModelChip. */
                            <SessionModelChip providers={providers} value={selectedChatModel}
                                onChange={changeChatSoloModel}
                                onRefreshModels={onRefreshModels}
                                issue={chatModelFallback.issue}
                                fallbackLabel={chatModelFallback.providerName}
                                showEffort={showEffort} />
                        )}
                        modelFallback={chatModelFallback.notice}
                        railExpanded={railExpanded}
                        /* Whole-rail state, separate from the Agents
                           COLUMN state above: the top-bar toggle is
                           about the rail, on every surface. */
                        sidebarExpanded={sidebarExpanded}
                        /* The content bar's toggle opens/closes the RAIL;
                           the column's own put-away is a separate callback. */
                        onToggleRailExpanded={onToggleRailExpanded}
                        railWidth={railWidth}
                        railIsResizing={railIsResizing}
                        onRailResizeStart={onRailResizeStart}
                        onRailResizeReset={onRailResizeReset}
                        onRevertTo={onRevertTo}
                        onEditPromptMessage={onEditPromptMessage}
                        onStepVersion={onStepVersion}
                        parkedCount={parkedCount}
                        onRestoreParked={onRestoreParked}
                        accountRow={accountRow}
                        conversations={conversations}
                        activeConversationId={activeConversationId}
                        onLoadConversation={onLoadConversation}
                        onDeleteConversation={onDeleteConversation}
                        onClearConversation={onClearConversation}
                        onNewChat={onNewChat}
                    />
                </React.Suspense>
            )}
        </>
    );
};

export default SurfaceOutlet;
