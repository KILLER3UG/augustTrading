/**
 * UtilityRail — the quiet, collapsed-by-default right-side rail.
 *
 * In Chat layout the rail renders NOTHING while closed: the ONE trigger is a
 * subtle panel-toggle icon button in the top-right header bar (see
 * TradeChatPanel; the old rotated `Available to open` edge strip is gone).
 * Opening it reveals a symbol/interval context line and four utility rows;
 * Memory and Skills expand in place instead of navigating away from the
 * conversation.
 *
 * All chrome is monochrome zinc. The Memory counters read the curated-memory
 * snapshot live (capture, not the frozen prompt prefix), and Consolidate Now
 * goes through the same serialized, reversible dream the rest of the app uses.
 */
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import * as chatStore from '../../services/trade/chatStore';
import {
    captureCuratedMemorySnapshot,
    type CuratedMemorySnapshot,
} from '../../services/learning/curatedMemory';
import { runMemoryDream, undoMemoryDream } from '../../services/learning/memoryDream';
import {
    skillStatusRows,
    type SkillStatusRow,
} from '../../services/learning/skillManage';
import { getActiveUsername } from '../../utils/activeUser';
import { display } from '../../utils/symbol';
import { getPaperAccount, submitPaperOrder, subscribePaperAccount } from '../../services/paper/PaperBrokerService';
import { paperAccountView, paperEquity, paperUnrealizedPnl, type PaperAccount } from '../../services/paper/paperCore';
import { getPaperLiveFrame, subscribePaperLiveTicks } from '../../services/trade/futuresStreams';

const emptyCounters: CuratedMemorySnapshot = {
    userMd: '', memoryMd: '', userChars: 0, memoryChars: 0,
    userMax: 1500, memoryMax: 2500, userPct: 0, memoryPct: 0, capturedAt: '',
};

export interface UtilityRailProps {
    /** Chart opens the trading desk; Trade Log opens the journal Settings tab.
     *  Both routes already exist — the rail only names them. */
    onOpenChart?: () => void;
    onOpenTradeLog?: () => void;
    username?: string | null;
    /** Controlled open state — the top-right header-bar toggle owns it
     *  (2026-11-23: the rotated `Available to open` edge strip is gone; the
     *  header button is the one trigger). Omitted ⇒ internal state. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

const UtilityRail: React.FC<UtilityRailProps> = ({
    onOpenChart, onOpenTradeLog, username, open: openProp, onOpenChange,
}) => {
    const [openState, setOpenState] = useState(false);
    const open = openProp ?? openState;
    const setOpen = (next: boolean): void => {
        setOpenState(next);
        onOpenChange?.(next);
    };
    const [section, setSection] = useState<'none' | 'memory' | 'skills' | 'paper'>('none');
    const [mem, setMem] = useState<CuratedMemorySnapshot>(emptyCounters);
    const [dreamUndo, setDreamUndo] = useState<{ userMd: string; memoryMd: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [skillRows, setSkillRows] = useState<Record<string, SkillStatusRow>>({});
    const [paperAccount, setPaperAccount] = useState<PaperAccount | null>(null);
    const [, setPaperTick] = useState(0);
    const [closingPaperId, setClosingPaperId] = useState<string | null>(null);
    const [paperActionNote, setPaperActionNote] = useState<string | null>(null);

    const snap = useSyncExternalStore(
        chatStore.subscribe, chatStore.getSnapshot, chatStore.getSnapshot);
    const session = snap.sessions.find(s => s.id === snap.activeId) ?? snap.sessions[0];
    const context = session?.symbol
        ? `${display(session.symbol)} · ${session.interval} · Live`
        : 'No active session';

    const user = username ?? getActiveUsername() ?? 'default';
    const refreshCounters = useCallback(async (): Promise<void> => {
        try { setMem(await captureCuratedMemorySnapshot(user)); }
        catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    }, [user]);

    useEffect(() => {
        if (section !== 'memory') return;
        void refreshCounters();
    }, [section, refreshCounters]);
    useEffect(() => {
        if (section !== 'skills') return;
        let alive = true;
        void skillStatusRows(user).then(rows => { if (alive) setSkillRows(rows); });
        return () => { alive = false; };
    }, [section, user]);

    // The paper barometer is a view of the one authoritative account. Subscribe
    // for fills/config writes, and take one async snapshot on mount.
    useEffect(() => {
        let alive = true;
        const unsubscribe = subscribePaperAccount(account => { if (alive) setPaperAccount(account); });
        void getPaperAccount(user)
            .then(account => { if (alive) setPaperAccount(account); })
            .catch(() => { /* no readable paper account yet — show the empty state */ });
        return () => { alive = false; unsubscribe(); };
    }, [user]);

    useEffect(() => {
        if (!open || section !== 'paper') return;
        return subscribePaperLiveTicks(() => setPaperTick(t => t + 1));
    }, [open, section]);

    const livePaperMarks: Record<string, number> = {};
    if (paperAccount) {
        for (const p of paperAccount.positions) {
            const frame = getPaperLiveFrame(p.symbol, 300_000);
            const livePrice = frame?.mark ?? frame?.last;
            if (typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0) {
                livePaperMarks[p.symbol] = livePrice;
            }
        }
    }
    const paperView = paperAccount ? paperAccountView(paperAccount, livePaperMarks) : null;
    const paperEquityUsd = paperAccount ? paperEquity(paperAccount, livePaperMarks) : 0;
    const closePaperPosition = async (positionId: string, symbol: string): Promise<void> => {
        if (closingPaperId) return;
        setClosingPaperId(positionId);
        setPaperActionNote(null);
        try {
            const receipt = await submitPaperOrder(
                { action: 'close', symbol, position_id: positionId },
                { username: user },
            );
            setPaperActionNote(receipt.ok
                ? `Closed ${display(symbol)}${receipt.message ? ` — ${receipt.message}` : ''}`
                : `Close refused — ${receipt.reason ?? receipt.error ?? 'error'}`);
        } catch (err) {
            setPaperActionNote(err instanceof Error ? err.message : String(err));
        } finally {
            setClosingPaperId(null);
        }
    };
    const paperStartUsd = paperView?.riskLimits.startingBalanceUsd ?? 0;
    const paperPct = paperStartUsd > 0
        ? ((paperEquityUsd - paperStartUsd) / paperStartUsd) * 100
        : 0;
    const paperStatus = `Paper · $${Math.round(paperEquityUsd).toLocaleString('en-US')} · ${paperPct >= 0 ? '+' : ''}${paperPct.toFixed(1)}% · ${paperView?.openPositions.length ?? 0} open`;

    const consolidate = (): void => {
        setBusy(true);
        setNote(null);
        void (async () => {
            try {
                const result = await runMemoryDream({ manual: true, username: user });
                if (result.error) setNote(result.error);
                else if (!result.ran) setNote('Nothing to consolidate yet.');
                if (result.undoSnapshot) setDreamUndo(result.undoSnapshot);
                await refreshCounters();
            } catch (e) {
                setNote(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(false);
            }
        })();
    };

    const undoConsolidate = (): void => {
        if (!dreamUndo) return;
        void (async () => {
            try {
                const ok = await undoMemoryDream(dreamUndo, user);
                setNote(ok ? 'Consolidation undone.' : 'Undo refused by the memory store.');
                if (ok) setDreamUndo(null);
                await refreshCounters();
            } catch (e) {
                setNote(e instanceof Error ? e.message : String(e));
            }
        })();
    };

    const rows: Array<{ id: string; label: string; onClick: () => void; testid: string }> = [
        { id: 'chart', label: 'Chart', onClick: () => onOpenChart?.(), testid: 'utility-chart' },
        { id: 'log', label: 'Trade Log', onClick: () => onOpenTradeLog?.(), testid: 'utility-trade-log' },
        { id: 'paper', label: 'Paper', onClick: () => setSection(s => s === 'paper' ? 'none' : 'paper'), testid: 'utility-paper' },
        { id: 'memory', label: 'Memory', onClick: () => setSection(s => s === 'memory' ? 'none' : 'memory'), testid: 'utility-memory' },
        { id: 'skills', label: 'Skills', onClick: () => setSection(s => s === 'skills' ? 'none' : 'skills'), testid: 'utility-skills' },
    ];

    if (!open) {
        // Collapsed = NOTHING on the edge. The old rotated `Available to open`
        // strip is gone; the ONE trigger is the header-bar icon button
        // (data-testid="utility-rail-open", see TradeChatPanel's header).
        return null;
    }

    return (
        <aside
            data-testid="utility-rail"
            data-open="true"
            aria-label="Utility rail"
            className="flex w-60 shrink-0 flex-col overflow-y-auto custom-scrollbar border-l border-white/[0.04] bg-zinc-900/40"
        >
            <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-ui-2xs font-semibold uppercase tracking-[0.14em] text-zinc-600">Utilities</span>
                <button
                    type="button"
                    aria-label="Close utility rail"
                    title="Close"
                    data-testid="utility-rail-close"
                    onClick={() => { setOpen(false); setSection('none'); }}
                    className="rounded-control px-1.5 py-0.5 text-ui-caption text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                >
                    ×
                </button>
            </div>
            <div className="px-3 pb-2" data-testid="utility-context">
                <p className="font-mono text-ui-xs text-zinc-300">{context}</p>
                <p className="mt-0.5 text-ui-2xs text-zinc-600">Chart context · live</p>
            </div>
            <div className="px-3 pb-2" data-testid="utility-paper-status">
                <p className="font-mono text-ui-xs text-zinc-400">{paperStatus}</p>
            </div>
            <div className="flex flex-col gap-0.5 px-2">
                {rows.map(row => (
                    <button
                        key={row.id}
                        type="button"
                        aria-label={`Open ${row.label}`}
                        aria-expanded={row.id === section}
                        data-testid={row.testid}
                        onClick={row.onClick}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-caption transition-colors hover:bg-white/[0.05] hover:text-zinc-100 ${
                            section === row.id ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-500'
                        }`}
                    >
                        <span className="flex-1 truncate">{row.label}</span>
                        {(row.id === 'memory' || row.id === 'skills' || row.id === 'paper') && (
                            <span aria-hidden="true" className="text-ui-2xs text-zinc-600">{section === row.id ? '−' : '+'}</span>
                        )}
                    </button>
                ))}
            </div>

            {section === 'memory' && (
                <div className="mt-2 border-t border-white/[0.04] px-3 py-2" data-testid="utility-memory-inspector">
                    <p className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-wider text-zinc-600">Curated memory</p>
                    <div className="space-y-1 font-mono text-ui-2xs text-zinc-500">
                        <p data-testid="utility-user-md-count">USER.md · {mem.userChars}/{mem.userMax} ({mem.userPct}%)</p>
                        <p data-testid="utility-memory-md-count">MEMORY.md · {mem.memoryChars}/{mem.memoryMax} ({mem.memoryPct}%)</p>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            aria-label="Consolidate memory now"
                            title="Run one reversible consolidation pass"
                            data-testid="utility-memory-consolidate"
                            disabled={busy}
                            onClick={consolidate}
                            className="rounded-control bg-zinc-800 px-2 py-1 text-ui-2xs text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {busy ? 'Consolidating…' : 'Consolidate Now'}
                        </button>
                        {dreamUndo && (
                            <button
                                type="button"
                                aria-label="Undo memory consolidation"
                                title="Restore both files to their pre-consolidation bytes"
                                data-testid="utility-memory-undo"
                                onClick={undoConsolidate}
                                className="rounded-control px-2 py-1 text-ui-2xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                            >
                                Undo
                            </button>
                        )}
                    </div>
                    {note && <p className="mt-1.5 text-ui-2xs leading-4 text-zinc-600" role="status">{note}</p>}
                </div>
            )}

            {section === 'skills' && (
                <div className="mt-2 border-t border-white/[0.04] px-3 py-2" data-testid="utility-skills-inspector">
                    <p className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-wider text-zinc-600">Skill lifecycle</p>
                    {Object.keys(skillRows).length === 0 ? (
                        <p className="text-ui-2xs text-zinc-600">No skills in this library.</p>
                    ) : Object.values(skillRows).map(row => (
                        <div key={row.slug} className="flex items-center gap-2 py-0.5">
                            <span className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-zinc-400">{row.slug}</span>
                            <span
                                data-testid={`utility-skill-status-${row.slug}`}
                                className="rounded-full border border-white/[0.08] px-1.5 py-px text-ui-2xs uppercase tracking-wider text-zinc-500"
                            >
                                {row.status}
                            </span>
                        </div>
                    ))}
                    {/* Pin/archive are intentionally not offered here: those
                        writes belong to Skills settings, which already runs the
                        one-pen review path. This rail only reads status. */}
                </div>
            )}

            {section === 'paper' && (
                <div className="mt-2 border-t border-white/[0.04] px-3 py-2" data-testid="utility-paper-inspector">
                    <p className="mb-1.5 text-ui-2xs font-semibold uppercase tracking-wider text-zinc-600">Paper book</p>
                    {!paperView || (paperView.openPositions.length === 0 && paperView.pendingOrders.length === 0) ? (
                        <p className="text-ui-2xs text-zinc-600">No open paper positions or resting limits.</p>
                    ) : (
                        <div className="space-y-1.5 font-mono text-ui-2xs text-zinc-400">
                            {paperView.openPositions.map(position => {
                                const mark = livePaperMarks[position.symbol] ?? position.entryPrice;
                                const unrealizedUsd = paperUnrealizedPnl(position, mark);
                                const unrealizedR = position.riskUsd > 0 ? unrealizedUsd / position.riskUsd : null;
                                const signedUsd = `${unrealizedUsd >= 0 ? '+' : '-'}$${Math.abs(unrealizedUsd).toFixed(2)}`;
                                const signedR = unrealizedR !== null
                                    ? `${unrealizedR >= 0 ? '+' : ''}${unrealizedR.toFixed(2)}R`
                                    : '—';
                                const isClosing = closingPaperId === position.id;
                                return (
                                    <div
                                        key={position.id}
                                        data-testid={`utility-paper-position-${position.id}`}
                                        className="rounded-control border border-white/[0.05] bg-zinc-950/50 px-2 py-1.5"
                                        title={`${position.side.toUpperCase()} ${position.symbol} · ${position.qty} @ ${position.entryPrice} · SL ${position.stopLoss} · TP ${position.takeProfits.join('/') || '—'}`}
                                    >
                                        <div className="flex items-center justify-between gap-1.5">
                                            <span className="truncate text-zinc-300">
                                                {position.side.toUpperCase()} {display(position.symbol)} @ {position.entryPrice.toFixed(2)}
                                            </span>
                                            <button
                                                type="button"
                                                data-testid="utilities-paper-close-btn"
                                                disabled={isClosing || Boolean(closingPaperId)}
                                                onClick={() => { void closePaperPosition(position.id, position.symbol); }}
                                                className="shrink-0 rounded-control border border-line bg-zinc-800 px-1.5 py-0.5 text-ui-2xs text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                {isClosing ? 'Closing…' : 'Close'}
                                            </button>
                                        </div>
                                        <div className="mt-0.5 flex items-center justify-between text-zinc-500">
                                            <span>SL {position.stopLoss.toFixed(2)}</span>
                                            <span
                                                data-testid={`utility-paper-pnl-${position.id}`}
                                                className={unrealizedUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}
                                            >
                                                {signedR} · {signedUsd}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                            {paperView.pendingOrders.map(order => (
                                <p
                                    key={order.id}
                                    data-testid={`utility-paper-order-${order.id}`}
                                    className="truncate text-zinc-500"
                                    title={`LIMIT ${order.side.toUpperCase()} ${order.symbol} · ${order.qty} @ ${order.limitPrice}`}
                                >
                                    LIMIT {order.side.toUpperCase()} {display(order.symbol)} · {order.qty} @ {order.limitPrice.toFixed(2)}
                                </p>
                            ))}
                        </div>
                    )}
                    {paperActionNote && (
                        <p className="mt-1.5 text-ui-2xs leading-4 text-zinc-400" role="status" data-testid="utilities-paper-note">
                            {paperActionNote}
                        </p>
                    )}
                    {paperView && (
                        <p className="mt-1.5 text-ui-2xs leading-4 text-zinc-600">
                            Equity ${paperView.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · free ${paperView.freeMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                    )}
                    {/* An executed paper fill or close is final, matching the write
                        receipts in chat. */}
                </div>
            )}
        </aside>
    );
};

export default React.memo(UtilityRail);
