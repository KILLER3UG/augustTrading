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
 * THE WORKSPACE MERGE (Phase 2): `trade` and `agents` are the SAME page —
 * chart pane left, the Chart AI dock right, both mounted at desktop width.
 * The stored `agents` route and the Alt+4 chord stay valid; they land on the
 * workspace. The dock's own New menu is the composer mode menu
 * (solo / panel / room / bot), so the roster needs no second page.
 *
 * The lazy declaration for the workspace lives HERE, next to the switch that
 * mounts it. App's idle warm-up imports the same module path, so the bundler
 * still dedupes it to one chunk.
 */

import React from 'react';
import SidebarToggle from './SidebarToggle';
import { LayoutMiniToggle } from './LayoutSwitch';
import type { AppSurface } from '../../hooks/useSurface';
import type { TradeMode } from '../trade/TradeView';
import type { Message, LoggedTrade, TradeAnalysis } from '../../types';
import type { ProviderConfig, ReasoningEffort } from '../../types/provider';
import type { AgentBot } from '../../services/agents/agentRoster';
import type { TradeProposal } from '../../services/trade/proposedTrade';
import type { SoloTurnRow } from '../../services/trade/chatTurnMirror';
import type { SettlementCorrectionProposal } from '../../services/trade/settlementCorrection';
import type { TradeActionProposal } from '../../services/trade/tradeActionProposal';

const TradeView = React.lazy(() => import('../trade/TradeView'));

/**
 * Suspense fallback for the SURFACE-level lazy screen (TradeView). With
 * fallback={null} the whole surface flashed a blank black/white void for the
 * duration of the chunk fetch (audit: 21× fallback={null}). This is a quiet
 * pulsing zinc panel that matches the dark chrome — no new deps, no layout
 * shift to the real screen.
 */
export const SurfaceSkeleton: React.FC = () => (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 bg-zinc-950 p-4" role="status" aria-label="Loading">
        <div className="h-8 w-40 animate-pulse rounded-control bg-zinc-900" />
        <div className="flex-1 animate-pulse rounded-bubble border border-hairline bg-zinc-900" />
    </div>
);

export interface SurfaceOutletProps {
    surface: AppSurface;
    /* ── The shell ────────────────────────────────────────────────────────── */
    onToggleNavRail: () => void;
    navRailExpanded: boolean;
    /* ── The workspace (chart + Chart AI dock) ───────────────────────────── */
    memoryEnabled: boolean;
    strategiesEnabled: boolean;
    providers: ProviderConfig[];
    selectedChatModel: string;
    onSelectChatModel: (modelId: string) => void;
    onRefreshModels: () => Promise<void>;
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
    /** Approve on the decision card → App's gated log path; resolves to the
     *  journal ROW id (the undo handle) or false on refusal/cancel. */
    onLogProposedTrade: (proposal: TradeProposal, sessionId?: string) => Promise<string | false>;
    /** Reject on the decision card → App records the decline (HOLD ledger);
     *  returns whether the record landed. */
    onRejectProposedTrade: (proposal: TradeProposal, reason?: string) => boolean;
    /** Undo inside the approval window → App reverses the approval. */
    onUndoApproval: (decision: { rowId: string; planId?: string; entryId: string; sessionId?: string }) => void;
    /** Confirm / dismiss / revert a PROPOSED risk-limit or guard-preset
     *  change — App writes through the settings path the trader owns. */
    onConfirmRiskChange: (proposal: import('../../services/trade/riskChangeProposal').RiskChangeProposal, sessionId?: string) => void;
    onDismissRiskChange: (proposal: import('../../services/trade/riskChangeProposal').RiskChangeProposal) => void;
    onRevertRiskChange: (proposal: import('../../services/trade/riskChangeProposal').RiskChangeProposal, sessionId?: string) => void;
    onConfirmAiSettingChange: (proposal: import('../../services/trade/aiSettingProposal').AiSettingProposal, sessionId?: string) => void;
    onDismissAiSettingChange: (proposal: import('../../services/trade/aiSettingProposal').AiSettingProposal) => void;
    onRevertAiSettingChange: (proposal: import('../../services/trade/aiSettingProposal').AiSettingProposal, sessionId?: string) => void;
    onConfirmStrategyActivation: (proposal: import('../../services/trade/strategyActivation').StrategyActivationProposal, sessionId?: string) => void;
    onDismissStrategyActivation: (proposal: import('../../services/trade/strategyActivation').StrategyActivationProposal) => void;
    onRevertStrategyActivation: (proposal: import('../../services/trade/strategyActivation').StrategyActivationProposal, sessionId?: string) => void;
    registerScrollToMessage: (fn: ((messageId: string) => void) | null) => void;
    onToggleWatch: (messageId: string) => void;
    onOpenWatchList: () => void;
    /** The dock's decision-card handlers (audit P-6): confirm/dismiss a
     *  PROPOSED settlement fix or trade action. Confirm applies through the
     *  SAME journal/watch writers the Chat surface's card used. */
    onConfirmSettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onDismissSettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onVoidSettlementCorrection: (proposal: SettlementCorrectionProposal) => void;
    onConfirmTradeAction: (proposal: TradeActionProposal) => void;
    onDismissTradeAction: (proposal: TradeActionProposal) => void;
    watchOpenCount: number;
    watchOpenR: string | undefined;
    pinnedMessageIds: ReadonlySet<string>;
    renderGroupSurface: (groupId: string) => React.ReactNode;
}

const SurfaceOutlet: React.FC<SurfaceOutletProps> = ({
    surface,
    onToggleNavRail, navRailExpanded,
    memoryEnabled, strategiesEnabled, providers, selectedChatModel, onSelectChatModel,
    onRefreshModels, tradeModeRequest,
    activeUsername, onTradeModeChange, botThreadRows, onBotTurnCommit, onSoloTurnCommit,
    onSyncConversation, conversationRows, onNewGroup, verdict, bots, trades, groupTabs,
    botSessionRequest, groupSessionRequest, onRunAnalysisFromChat, onAnalysisError,
    onCancelAnalysis, getAnalysisMessage, onLogProposedTrade, onRejectProposedTrade, onUndoApproval, onConfirmRiskChange, onDismissRiskChange, onRevertRiskChange, onConfirmAiSettingChange, onDismissAiSettingChange, onRevertAiSettingChange, onConfirmStrategyActivation, onDismissStrategyActivation, onRevertStrategyActivation, registerScrollToMessage,
    onToggleWatch, onOpenWatchList, watchOpenCount, watchOpenR, pinnedMessageIds,
    onConfirmSettlementCorrection, onDismissSettlementCorrection, onVoidSettlementCorrection,
    onConfirmTradeAction, onDismissTradeAction,
    renderGroupSurface,
}) => {
    // One workspace: whichever of the two desk routes is showing, the same
    // page mounts — the layout pill is the difference, not the route.
    const showWorkspace = surface === 'trade' || surface === 'agents';

    return (
        <>
            {/* The content bar is GONE (owner 1.3.1): the dock header names
                the thread, the bias row carries the session read (SessionChip)
                and the market state, the sidebar carries the routes. The one
                thing the bar uniquely owned — the way back into a put-away
                rail — is the compact flow row below, and only while the rail
                is away: an expanded sidebar's collapse control lives in its
                own pill row, and a second one here would be the duplicate the
                ruling deleted. */}
            {showWorkspace && !navRailExpanded && onToggleNavRail && (
                <div
                    data-testid="collapsed-rail-bar"
                    className="flex shrink-0 items-center gap-1.5 bg-zinc-950 px-3 py-1.5"
                >
                    <SidebarToggle expanded={false} onToggle={onToggleNavRail} />
                    <LayoutMiniToggle />
                </div>
            )}

            {showWorkspace && (
                <React.Suspense fallback={<SurfaceSkeleton />}>
                    <TradeView
                        memoryEnabled={memoryEnabled}
                        strategiesEnabled={strategiesEnabled}
                        providers={providers}
                        selectedChatModel={selectedChatModel}
                        onSelectChatModel={onSelectChatModel}
                        onRefreshModels={onRefreshModels}
                        modeRequest={tradeModeRequest ?? undefined}
                        activeUsername={activeUsername ?? undefined}
                        onTradeModeChange={onTradeModeChange}
                        /* The same handlers the Chat rail got, so the
                           dock is the Chat's form rather than a reduced
                           one: it can open a room, not just list rooms. */
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
                        onRejectProposedTrade={onRejectProposedTrade}
                        onUndoApproval={onUndoApproval}
                        onConfirmRiskChange={onConfirmRiskChange}
                        onDismissRiskChange={onDismissRiskChange}
                        onRevertRiskChange={onRevertRiskChange}
                        onConfirmAiSettingChange={onConfirmAiSettingChange}
                        onDismissAiSettingChange={onDismissAiSettingChange}
                        onRevertAiSettingChange={onRevertAiSettingChange}
                        onConfirmStrategyActivation={onConfirmStrategyActivation}
                        onDismissStrategyActivation={onDismissStrategyActivation}
                        onRevertStrategyActivation={onRevertStrategyActivation}
                        registerScrollToMessage={registerScrollToMessage}
                        onToggleWatch={onToggleWatch}
                        onOpenWatchList={onOpenWatchList}
                        onConfirmSettlementCorrection={onConfirmSettlementCorrection}
                        onDismissSettlementCorrection={onDismissSettlementCorrection}
                        onVoidSettlementCorrection={onVoidSettlementCorrection}
                        onConfirmTradeAction={onConfirmTradeAction}
                        onDismissTradeAction={onDismissTradeAction}
                        watchOpenCount={watchOpenCount}
                        watchOpenR={watchOpenR}
                        pinnedMessageIds={pinnedMessageIds}
                        renderGroupSurface={renderGroupSurface}
                    />
                </React.Suspense>
            )}
        </>
    );
};

export default SurfaceOutlet;
