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
import { getActiveUsername } from '../../utils/activeUser';
import { advancePosition } from './positionTracker';
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
    queued: number;
    skipped: { positionId: string; reason: string }[];
    busy?: boolean;
}

export interface SignalRegistrationResult {
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
    queued: 0,
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
): Promise<SignalRegistrationResult> => {
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
            && !known.has(position.id))
        .map(position => ({
            id: `diag-${position.id}`,
            tradeId: position.id,
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
    return !positions.ok || positions.value.some(position => !isTerminal(position));
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
                && position.source === 'signal'
                // No fetch until the next 5m bar can have closed. A 60s pass
                // must not pull the same 300-bar window five times per bar.
                && now >= position.cursor.lastClosedBarTime + SIGNAL_BAR_MS)
            .sort((a, b) => a.cursor.lastClosedBarTime - b.cursor.lastClosedBarTime)
            .slice(0, MAX_TRACKED_FETCH_PER_PASS);

        for (const position of pending) {
            result.attempted += 1;
            try {
                const bars = await fetchSignalBars(position);
                if (!bars) {
                    result.skipped.push({ positionId: position.id, reason: 'the tape does not reach back to the emission' });
                    continue;
                }
                let advanced = advancePosition({ position, bars, now });
                // A coarse bar that contained both levels is retried with the
                // 1m series; an incomplete series leaves the stop-first policy.
                if (advanced.position.exit?.ambiguous && advanced.position.exit.at !== undefined) {
                    const drill = await fetchSignalDrill(position, advanced.position.exit.at);
                    if (drill.length > 0) {
                        const ordered = advancePosition({ position, bars, drill, now });
                        if (ordered.position.exit && !ordered.position.exit.ambiguous) advanced = ordered;
                    }
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
        const queued = await queueDiagnoses(user);
        result.queued = queued.queued;
        if (queued.error) result.skipped.push({ positionId: '*', reason: `diagnosis queue: ${queued.error}` });

        if (activeUser === user && !(await hasWork(user, result.adoptRemaining))) stopLoop();
        return result;
    })().finally(() => {
        // A reset/switch starts a new generation; the old pass must not clear
        // the newer pass's lock when it finally settles.
        if (generation === passGeneration) passPromise = null;
    });
    return passPromise;
};
