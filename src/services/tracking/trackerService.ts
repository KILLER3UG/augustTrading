/**
 * trackerService — the live half of the tracked-position loop.
 *
 * It adopts desk signals from the append-only ledger, advances every open
 * position over closed 5m bars, lets the signal ledger's settlement win when
 * one exists, and queues a diagnosis for every real close. The pure decision
 * logic lives in `positionTracker.ts`; this module owns the clock, the fetch
 * budget and persistence.
 *
 * THE BUDGETS. A pass fetches at most `MAX_TRACKED_FETCH_PER_PASS` series and
 * adopts at most `MAX_ADOPT_PER_PASS` signals. Overflow is not lost: adopted
 * positions stay in the store and the oldest cursor is served first. A
 * diagnosis is queued in the same pass and is never dropped by a busy pass;
 * `queueDiagnoses` re-adds any terminal position without a queue row.
 *
 * THE CLOCK. The pass runs on a 60s timer while the app is active, stops when
 * nothing is open and no adoptable signal remains, and restarts on a new
 * emission. On native it pauses with the app and catches up on resume; on
 * desktop/web the timer is the app's own lifetime.
 *
 * THE LEDGER WINS. `reconcileSignals` applies every resolved ledger row to its
 * tracked position. A disagreement is recorded in `discrepancy`, never
 * silently kept as a second outcome.
 */

import { Capacitor } from '@capacitor/core';
import type { Kline } from '../../types';
import type { SignalRecord, SignalRow } from '../../types/signal';
import type { DiagnosisQueueItem, TrackedPosition } from '../../types/tracking';
import type { SignalCandle } from '../signals/signalResolver';
import { readSignals } from '../signals/signalLedger';
import {
    fetchBinanceCandles,
    fetchOkxCandles,
    okxInstId,
    tapeCoversEmission,
} from '../signals/signalMarketData';
import { fetchFuturesOHLCVFromTime } from '../analysis/MarketDataService';
import { getActiveUsername } from '../../utils/activeUser';
import { advancePosition, closePositionManually, type AdvanceResult } from './positionTracker';
import {
    readDiagnoses,
    readDiagnosisQueue,
    readTrackedPositions,
    saveTrackedPosition,
    writeDiagnosisQueue,
} from './positionStore';
import {
    applySignalResolution,
    isSignalAdoptable,
    signalBarsToKlines,
    trackedPositionFromSignal,
} from './signalTracking';
import { isJournalSettled, journalSettlementFromPosition } from './journalTracking';
import {
    hasJournalOutcomeBridge,
    readJournalOutcome,
    settleJournalTrade,
} from './journalOutcomeBridge';
import { runDiagnosisPass } from './postMortemDiagnosis';

const PASS_INTERVAL_MS = 60_000;
export const MAX_ADOPT_PER_PASS = 8;
export const MAX_TRACKED_FETCH_PER_PASS = 4;
const SIGNAL_BAR_MS = 5 * 60_000;

export interface TrackerPassResult {
    adopted: number;
    adoptRemaining: number;
    attempted: number;
    advanced: number;
    reconciled: number;
    closed: number;
    journalSettled: number;
    queued: number;
    diagnosed: number;
    diagnosisRefused: number;
    skipped: { positionId: string; reason: string }[];
    busy?: boolean;
}

export interface TrackingRegistrationResult {
    ok: boolean;
    already?: boolean;
    position?: TrackedPosition;
    error?: string;
}

let activeUser: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let passPromise: Promise<TrackerPassResult> | null = null;
let passGeneration = 0;
let lifecycleRegistered = false;

const isTerminal = (p: TrackedPosition): boolean =>
    p.status === 'closed' || p.status === 'expired' || p.status === 'cancelled';

const emptyResult = (): TrackerPassResult => ({
    adopted: 0,
    adoptRemaining: 0,
    attempted: 0,
    advanced: 0,
    reconciled: 0,
    closed: 0,
    journalSettled: 0,
    queued: 0,
    diagnosed: 0,
    diagnosisRefused: 0,
    skipped: [],
});

const ensureLoop = (): void => {
    if (timer || !activeUser) return;
    timer = setInterval(() => {
        if (activeUser) {
            void runTrackerPass(activeUser).catch(err => {
                console.warn('[Tracker] pass failed:', err instanceof Error ? err.message : err);
            });
        }
    }, PASS_INTERVAL_MS);
};

const stopLoop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
};

/** Stop the timer; an in-flight pass is left to finish against its OWN user's
 *  store. The next init starts a fresh pass. */
export const resetTracker = (): void => {
    activeUser = null;
    stopLoop();
    passGeneration += 1;
    passPromise = null;
};

const registerLifecycle = (): void => {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;
    if (!Capacitor.isNativePlatform()) return;
    void (async () => {
        try {
            const { App } = await import('@capacitor/app');
            App.addListener('appStateChange', ({ isActive }) => {
                if (!activeUser) return;
                if (isActive) {
                    ensureLoop();
                    void runTrackerPass(activeUser).catch(err => {
                        console.warn('[Tracker] resume pass failed:', err instanceof Error ? err.message : err);
                    });
                } else {
                    stopLoop();
                }
            });
        } catch (err) {
            console.warn('[Tracker] native lifecycle not registered:', err);
        }
    })();
};

/** Start the tracker for a profile. Returns after scheduling the first pass;
 *  the pass itself is fire-and-forget so boot is not blocked by a fetch. */
export const initTracker = async (username: string): Promise<void> => {
    if (activeUser === username) {
        ensureLoop();
        void runTrackerPass(username).catch(err => {
            console.warn('[Tracker] first pass failed:', err instanceof Error ? err.message : err);
        });
        return;
    }
    resetTracker();
    activeUser = username;
    registerLifecycle();
    ensureLoop();
    void runTrackerPass(username).catch(err => {
        console.warn('[Tracker] first pass failed:', err instanceof Error ? err.message : err);
    });
};

/** Register a just-emitted signal. Dynamic-imported by `emitSignal` so the
 *  emission path never waits on the store. */
export const registerSignalForTracking = async (
    signal: SignalRecord,
    user: string = getActiveUsername(),
): Promise<TrackingRegistrationResult> => {
    const existing = await readTrackedPositions(user);
    if (!existing.ok) return { ok: false, error: existing.error };
    const id = `signal-${signal.id}`;
    if (existing.value.some(p => p.id === id)) return { ok: true, already: true };
    const position = trackedPositionFromSignal(signal);
    const saved = await saveTrackedPosition(user, position);
    if (!saved.ok) return { ok: false, error: saved.error };
    if (activeUser === user) ensureLoop();
    return { ok: true, position };
};

/** Register a journal plan (a PENDING row) for tape tracking. Same contract
 *  as the signal registration: deterministic id, idempotent, and the loop
 *  restarts for a new plan. */
export const registerJournalPositionForTracking = async (
    position: TrackedPosition,
    user: string = getActiveUsername(),
): Promise<TrackingRegistrationResult> => {
    const existing = await readTrackedPositions(user);
    if (!existing.ok) return { ok: false, error: existing.error };
    if (existing.value.some(p => p.id === position.id)) {
        return { ok: true, already: true, position };
    }
    const saved = await saveTrackedPosition(user, position);
    if (!saved.ok) return { ok: false, error: saved.error };
    if (activeUser === user) ensureLoop();
    return { ok: true, position };
};

interface AdoptionResult {
    adopted: number;
    remaining: number;
    error?: string;
}

const adoptSignals = async (user: string, now: number): Promise<AdoptionResult> => {
    const rows = readSignals(user);
    const positions = await readTrackedPositions(user);
    if (!positions.ok) return { adopted: 0, remaining: 0, error: positions.error };

    const positionIds = new Set(positions.value.map(p => p.id));
    const possiblyNew = rows.some(row =>
        isSignalAdoptable(row, now) && !positionIds.has(`signal-${row.signal.id}`));
    if (!possiblyNew) return { adopted: 0, remaining: 0 };

    // A pruned position must not be re-adopted once its diagnosis or queue
    // row exists; the trade id is the position id, not the signal id. These
    // stores are read only when there is a candidate, not on every pass.
    const diagnoses = await readDiagnoses(user);
    if (!diagnoses.ok) return { adopted: 0, remaining: 0, error: diagnoses.error };
    const queue = await readDiagnosisQueue(user);
    if (!queue.ok) return { adopted: 0, remaining: 0, error: queue.error };
    const knownIds = new Set<string>([
        ...positionIds,
        ...diagnoses.value.map(d => d.tradeId),
        ...queue.value.map(q => q.tradeId),
    ]);
    const candidates = rows
        .filter(row => !knownIds.has(`signal-${row.signal.id}`) && isSignalAdoptable(row, now))
        .sort((a, b) => {
            const openDelta = (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1);
            return openDelta !== 0 ? openDelta : b.signal.emittedAt - a.signal.emittedAt;
        });

    let adopted = 0;
    for (const row of candidates.slice(0, MAX_ADOPT_PER_PASS)) {
        const saved = await saveTrackedPosition(user, trackedPositionFromSignal(row.signal));
        if (saved.ok) adopted += 1;
        else console.warn('[Tracker] could not adopt signal:', saved.error);
    }
    return { adopted, remaining: Math.max(0, candidates.length - adopted) };
};

const fetchSignalBars = async (position: TrackedPosition): Promise<Kline[] | null> => {
    const instId = okxInstId(position.symbol);
    let candles: SignalCandle[] | null = null;
    if (instId) {
        const okx = await fetchOkxCandles(instId, '5m', 300);
        if (okx.ok && tapeCoversEmission(okx.candles, position.openedAt)) candles = okx.candles;
    }
    if (!candles) {
        const binance = await fetchBinanceCandles(position.symbol, '5m', 300);
        if (binance && tapeCoversEmission(binance, position.openedAt)) candles = binance;
    }
    return candles ? signalBarsToKlines(candles) : null;
};

const fetchSignalDrill = async (position: TrackedPosition, exitAt: number): Promise<SignalCandle[]> => {
    const instId = okxInstId(position.symbol);
    let candles: SignalCandle[] | null = null;
    if (instId) {
        const okx = await fetchOkxCandles(instId, '1m', 300);
        if (okx.ok) candles = okx.candles;
    }
    if (!candles) candles = await fetchBinanceCandles(position.symbol, '1m', 300);
    if (!candles) return [];
    return candles.filter(c => c.time >= exitAt && c.time < exitAt + SIGNAL_BAR_MS);
};

/** The journal tape. 1500 5m bars is ~5.2 days; a longer hold cannot be
 *  covered at this granularity, and `advancePosition` refuses rather than
 *  reading a truncated window. */
const fetchJournalBars = async (position: TrackedPosition): Promise<Kline[]> => {
    const start = Math.max(position.openedAt - SIGNAL_BAR_MS, Date.now() - 1500 * SIGNAL_BAR_MS);
    try {
        return await fetchFuturesOHLCVFromTime(position.symbol, '5m', start);
    } catch {
        return [];
    }
};

/**
 * Advance a journal position, then reconcile it with the journal row.
 *
 *  · row already settled by the trader/autopilot → the row's call wins; an
 *    open tracker position is closed manually at the last close and the
 *    disagreement is recorded;
 *  · tracker closed while the row is PENDING → the bridge hands the exit to
 *    the existing journal funnel, and only a successful write stamps
 *    `journalSettledAt`;
 *  · bridge absent/failed → the position stays closed as a debt and the next
 *    pass retries. Nothing is silently marked settled.
 */
const settleJournalIfNeeded = async (
    position: TrackedPosition,
    bars: readonly Kline[],
    now: number,
): Promise<AdvanceResult> => {
    const advanced = advancePosition({ position, bars, now });
    const snapshot = readJournalOutcome(position.sourceId);
    const settledAtRaw = snapshot?.resolvedAt ? Date.parse(snapshot.resolvedAt) : Number.NaN;
    const settledAt = Number.isFinite(settledAtRaw) ? settledAtRaw : now;

    if (snapshot && isJournalSettled(snapshot.outcome)) {
        if (snapshot.outcome === 'ENTRY_NOT_HIT' || snapshot.outcome === 'SKIPPED') {
            return {
                position: {
                    ...advanced.position,
                    status: 'cancelled',
                    closedAt: advanced.position.closedAt ?? now,
                    journalSettledAt: settledAt,
                },
                closed: true,
                exitedNow: false,
            };
        }
        if (!isTerminal(advanced.position)) {
            const last = bars[bars.length - 1];
            if (!last) return advanced;
            // The row proves the trade was taken; a tracker that never saw the
            // entry must still be closed, not left pending beside a settled row.
            const wasPending = advanced.position.status === 'pending_entry';
            const base = wasPending
                ? { ...advanced.position, status: 'open' as const, entryConfirmed: true }
                : advanced.position;
            const manual = closePositionManually(base, last.close, last.time + SIGNAL_BAR_MS);
            const r = manual.exit?.realizedR;
            const mismatch = wasPending
                || (r !== null && r !== undefined
                    && ((snapshot.outcome === 'WIN' && r < 0) || (snapshot.outcome === 'LOSS' && r > 0)));
            return {
                position: {
                    ...manual,
                    journalSettledAt: settledAt,
                    ...(mismatch
                        ? {
                            discrepancy: wasPending
                                ? `journal row settled ${snapshot.outcome} before the tracker saw an entry; closed at the last close (${r ?? '—'}R)`
                                : `journal row settled ${snapshot.outcome}; tracker marked the last close at ${r}R`,
                        }
                        : {}),
                },
                closed: true,
                exitedNow: true,
            };
        }
        const exit = advanced.position.exit;
        const wasCancelled = advanced.position.status === 'cancelled';
        const mismatch = wasCancelled
            || (exit !== undefined
                && ((snapshot.outcome === 'WIN' && exit.reason === 'stop')
                    || (snapshot.outcome === 'LOSS' && exit.reason === 'target')));
        return {
            position: {
                ...advanced.position,
                journalSettledAt: settledAt,
                ...(mismatch
                    ? {
                        discrepancy: wasCancelled
                            ? `journal row settled ${snapshot.outcome} but the tracker never triggered`
                            : `journal row settled ${snapshot.outcome}; tracker exited ${exit?.reason} at ${exit?.price}`,
                    }
                    : {}),
            },
            closed: true,
            exitedNow: false,
        };
    }

    if (isTerminal(advanced.position) && advanced.position.exit) {
        const settlement = journalSettlementFromPosition(advanced.position);
        if (settlement) {
            const wrote = await settleJournalTrade(position.sourceId, settlement);
            if (wrote.ok) {
                return {
                    position: { ...advanced.position, journalSettledAt: Date.now() },
                    closed: true,
                    exitedNow: advanced.exitedNow,
                };
            }
            return {
                ...advanced,
                position: {
                    ...advanced.position,
                    discrepancy: `journal settlement pending: ${wrote.error ?? 'unknown error'}`,
                },
            };
        }
    }
    return advanced;
};

/**
 * Settle journal positions that closed on an earlier pass but whose row was
 * never accepted (the bridge was not mounted, or its write failed). Closed
 * positions are not in the fetch batch, so without this step their debt would
 * spin forever. A row the trader deleted is cancelled as orphaned rather than
 * resurrected; a row that is already settled is stamped and left alone.
 */
const settleClosedJournalDebts = async (user: string): Promise<number> => {
    if (!hasJournalOutcomeBridge()) return 0;
    const positions = await readTrackedPositions(user);
    if (!positions.ok) return 0;
    let settled = 0;
    for (const position of positions.value) {
        if (position.source !== 'journal'
            || position.exit === undefined
            || position.journalSettledAt !== undefined) continue;
        const snapshot = readJournalOutcome(position.sourceId);
        const parsed = snapshot?.resolvedAt ? Date.parse(snapshot.resolvedAt) : Number.NaN;
        const stamp = Number.isFinite(parsed) ? parsed : Date.now();

        if (snapshot === null) {
            const saved = await saveTrackedPosition(user, {
                ...position,
                status: 'cancelled',
                exit: undefined,
                journalSettledAt: stamp,
                discrepancy: 'journal row no longer exists; the tracker position was closed as orphaned',
            });
            if (saved.ok) settled += 1;
            continue;
        }
        if (snapshot.outcome === 'ENTRY_NOT_HIT' || snapshot.outcome === 'SKIPPED') {
            const saved = await saveTrackedPosition(user, {
                ...position,
                status: 'cancelled',
                exit: undefined,
                journalSettledAt: stamp,
                discrepancy: `journal row settled ${snapshot.outcome}; the tracker exit was discarded`,
            });
            if (saved.ok) settled += 1;
            continue;
        }
        if (snapshot.outcome === 'WIN' || snapshot.outcome === 'LOSS') {
            const exit = position.exit;
            const mismatch = (snapshot.outcome === 'WIN' && exit.reason === 'stop')
                || (snapshot.outcome === 'LOSS' && exit.reason === 'target');
            const saved = await saveTrackedPosition(user, {
                ...position,
                journalSettledAt: stamp,
                ...(mismatch
                    ? { discrepancy: `journal row settled ${snapshot.outcome}; tracker exited ${exit.reason} at ${exit.price}` }
                    : {}),
            });
            if (saved.ok) settled += 1;
            continue;
        }

        // The row is still PENDING; the bridge funnel owns the transition.
        const settlement = journalSettlementFromPosition(position);
        if (!settlement) continue;
        const wrote = await settleJournalTrade(position.sourceId, settlement);
        if (!wrote.ok) continue;
        const saved = await saveTrackedPosition(user, { ...position, journalSettledAt: Date.now() });
        if (saved.ok) settled += 1;
    }
    return settled;
};

/** Overlay every resolved ledger row onto its tracked signal position. No
 *  network, so a position the fetch budget skipped still gets the verdict. */
const reconcileSignals = async (user: string): Promise<number> => {
    const rows = readSignals(user);
    if (rows.length === 0) return 0;
    const bySignalId = new Map<string, SignalRow>(rows.map(row => [row.signal.id, row]));
    const positions = await readTrackedPositions(user);
    if (!positions.ok) return 0;
    let changed = 0;
    for (const position of positions.value) {
        if (position.source !== 'signal') continue;
        const row = bySignalId.get(position.sourceId);
        if (!row) continue;
        const applied = applySignalResolution(position, row);
        if (!applied.changed) continue;
        const saved = await saveTrackedPosition(user, applied.position);
        if (saved.ok) changed += 1;
    }
    return changed;
};

interface QueueResult { queued: number; error?: string }

/** Queue a diagnosis for every real close without one. The queue is written
 *  once, and an existing pending/running/done/failed row is never duplicated. */
const queueDiagnoses = async (user: string): Promise<QueueResult> => {
    const positions = await readTrackedPositions(user);
    if (!positions.ok) return { queued: 0, error: positions.error };
    const queue = await readDiagnosisQueue(user);
    if (!queue.ok) return { queued: 0, error: queue.error };
    const known = new Set(queue.value.map(item => item.tradeId));
    const additions: DiagnosisQueueItem[] = positions.value
        .filter(position =>
            position.status !== 'cancelled'
            && position.exit !== undefined
            && !position.diagnosisId
            // A journal position is diagnosable only once its ROW is settled;
            // a tape close the journal never accepted is a debt, not a lesson.
            && (position.source === 'signal' || position.journalSettledAt !== undefined)
            && !known.has(position.id))
        .map(position => ({
            id: `diag-${position.id}`,
            tradeId: position.id,
            source: position.source,
            queuedAt: Date.now(),
            attempts: 0,
            status: 'pending' as const,
        }));
    if (additions.length === 0) return { queued: 0 };
    const wrote = await writeDiagnosisQueue(user, [...queue.value, ...additions]);
    return wrote.ok ? { queued: additions.length } : { queued: 0, error: wrote.error };
};

/** Whether anything still needs the loop: an open position, an open signal,
 *  or an adoptable row the per-pass cap has not reached yet. */
const hasWork = async (user: string, adoptRemaining: number): Promise<boolean> => {
    if (adoptRemaining > 0) return true;
    if (readSignals(user).some(row => row.status === 'open')) return true;
    const positions = await readTrackedPositions(user);
    // A failed read is not proof the loop is idle; keep it alive and retry.
    if (!positions.ok) return true;
    const open = positions.value.some(position => !isTerminal(position));
    // A closed journal position the journal has not accepted is a debt; the
    // bridge may not have been mounted on the pass that closed it.
    const unsettled = positions.value.some(position =>
        position.source === 'journal'
        && position.exit !== undefined
        && position.journalSettledAt === undefined);
    // A queued diagnosis is a debt; the loop keeps retrying it (for example
    // while no memory provider is configured) instead of stopping silently.
    const queue = await readDiagnosisQueue(user);
    const diagnosisDebt = queue.ok && queue.value.some(item =>
        item.status === 'pending'
        || (item.status === 'failed' && item.attempts < 3));
    return open || unsettled || diagnosisDebt;
};

/** One tracker pass. Concurrent callers share the in-flight pass. */
export const runTrackerPass = async (
    user: string = getActiveUsername(),
): Promise<TrackerPassResult> => {
    if (passPromise) return passPromise;
    const generation = passGeneration;
    passPromise = (async (): Promise<TrackerPassResult> => {
        const result = emptyResult();
        const now = Date.now();
        const adoption = await adoptSignals(user, now);
        result.adopted = adoption.adopted;
        result.adoptRemaining = adoption.remaining;
        if (adoption.error) result.skipped.push({ positionId: '*', reason: `signal adoption: ${adoption.error}` });

        const read = await readTrackedPositions(user);
        if (!read.ok) {
            result.skipped.push({ positionId: '*', reason: read.error });
            return result;
        }
        const pending = read.value
            .filter(position =>
                !isTerminal(position)
                // No fetch until the next 5m bar can have closed. A 60s pass
                // must not pull the same 300-bar window five times per bar.
                && now >= position.cursor.lastClosedBarTime + SIGNAL_BAR_MS)
            .sort((a, b) => a.cursor.lastClosedBarTime - b.cursor.lastClosedBarTime)
            .slice(0, MAX_TRACKED_FETCH_PER_PASS);

        for (const position of pending) {
            result.attempted += 1;
            try {
                let advanced: AdvanceResult;
                if (position.source === 'signal') {
                    const bars = await fetchSignalBars(position);
                    if (!bars) {
                        result.skipped.push({ positionId: position.id, reason: 'the tape does not reach back to the emission' });
                        continue;
                    }
                    advanced = advancePosition({ position, bars, now });
                    // A coarse bar that contained both levels is retried with the
                    // 1m series; an incomplete series leaves the stop-first policy.
                    if (advanced.position.exit?.ambiguous && advanced.position.exit.at !== undefined) {
                        const drill = await fetchSignalDrill(position, advanced.position.exit.at);
                        if (drill.length > 0) {
                            const ordered = advancePosition({ position, bars, drill, now });
                            if (ordered.position.exit && !ordered.position.exit.ambiguous) advanced = ordered;
                        }
                    }
                } else {
                    const bars = await fetchJournalBars(position);
                    if (bars.length === 0) {
                        result.skipped.push({ positionId: position.id, reason: 'no closed 5m tape for this journal position' });
                        continue;
                    }
                    advanced = await settleJournalIfNeeded(position, bars, now);
                }
                const saved = await saveTrackedPosition(user, advanced.position);
                if (!saved.ok) {
                    result.skipped.push({ positionId: position.id, reason: saved.error });
                    continue;
                }
                result.advanced += 1;
                if (isTerminal(advanced.position)) result.closed += 1;
            } catch (err) {
                result.skipped.push({
                    positionId: position.id,
                    reason: err instanceof Error ? err.message : String(err),
                });
            }
        }

        result.reconciled = await reconcileSignals(user);
        result.journalSettled = await settleClosedJournalDebts(user);
        const queued = await queueDiagnoses(user);
        result.queued = queued.queued;
        if (queued.error) result.skipped.push({ positionId: '*', reason: `diagnosis queue: ${queued.error}` });

        const diagnosis = await runDiagnosisPass(user);
        result.diagnosed = diagnosis.diagnosed;
        result.diagnosisRefused = diagnosis.refused;

        if (activeUser === user && !(await hasWork(user, result.adoptRemaining))) stopLoop();
        return result;
    })().finally(() => {
        // A reset/switch starts a new generation; the old pass must not clear
        // the newer pass's lock when it finally settles.
        if (generation === passGeneration) passPromise = null;
    });
    return passPromise;
};
