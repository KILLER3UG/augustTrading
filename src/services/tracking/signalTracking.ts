/**
 * signalTracking — the pure bridge from a SignalRecord to a TrackedPosition.
 *
 * The signal ledger remains the authoritative settlement. This module only
 * translates its rows so the tracker can attach a path/MFE/MAE and the
 * diagnosis can attach a lesson. When the ledger has a resolution, it WINS:
 * `applySignalResolution` copies that status and R onto the tracked row and
 * records any disagreement in `discrepancy` rather than letting two numbers
 * drift apart.
 */

import type { Kline } from '../../types';
import type { SignalRecord, SignalRow } from '../../types/signal';
import type {
    TrackedExit,
    TrackedPosition,
} from '../../types/tracking';
import type { SignalCandle } from '../signals/signalResolver';
import { SIGNAL_BAR_MS } from '../signals/signalResolver';

/** Resolved signals are still adopted for this long, so a call that closed
 *  while the tracker was off still gets a path and a post-mortem. The signal
 *  expiry ceiling is 24h, so anything older is a ledger record, not a live
 *  position. */
export const SIGNAL_ADOPT_WINDOW_MS = 24 * 60 * 60_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const trackedIdForSignal = (signalId: string): string => `signal-${signalId}`;

export const trackedPositionFromSignal = (signal: SignalRecord): TrackedPosition => ({
    id: trackedIdForSignal(signal.id),
    source: 'signal',
    sourceId: signal.id,
    symbol: signal.coin,
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    targets: [signal.target],
    expiresAt: signal.expiresAt,
    status: 'pending_entry',
    openedAt: signal.emittedAt,
    entryConfirmed: false,
    entryContext: {
        thesis: signal.thesis,
        evidenceRefs: [...signal.evidenceRefs],
        model: signal.model,
        provider: signal.provider,
        promptVersion: signal.promptVersion,
        snapshot: {
            ...(signal.markAtEmit !== undefined ? { markAtEmit: signal.markAtEmit } : { markAtEmit: null }),
            dataHash: signal.dataHash,
        },
    },
    // The next 5m bar that can CLOSE after the emission. A signal emitted
    // mid-bar must not make the tracker fetch the forming bar.
    cursor: {
        lastClosedBarTime: Math.floor(signal.emittedAt / SIGNAL_BAR_MS) * SIGNAL_BAR_MS + SIGNAL_BAR_MS,
        timeframe: '5m',
    },
    mfeR: null,
    maeR: null,
    mfePrice: null,
    maePrice: null,
    mfeAt: null,
    maeAt: null,
    barsRead: 0,
    gaps: [],
    tapeCoversWindow: true,
    timeline: [],
    timelineDownsampled: false,
    timelinePointsDropped: 0,
    context: [],
    contextDownsampled: false,
    version: 1,
});

export interface AppliedSignalResolution {
    position: TrackedPosition;
    changed: boolean;
}

const exitFromLedger = (
    position: TrackedPosition,
    row: SignalRow & { resolution: NonNullable<SignalRow['resolution']> },
): TrackedExit => {
    const resolution = row.resolution;
    const reason: TrackedExit['reason'] = row.status === 'won'
        ? 'target'
        : row.status === 'lost' ? 'stop' : 'expiry';
    const sameBar = position.exit?.at !== undefined
        && position.exit.at === resolution.exitAt;
    return {
        reason,
        price: resolution.exitPrice ?? position.exit?.price ?? position.entry,
        at: resolution.exitAt ?? resolution.at,
        sameCandle: resolution.ambiguous
            ? 'stop-first'
            : resolution.path === '1m' ? 'ordered-1m' : 'single-level',
        ambiguous: resolution.ambiguous,
        gapAtOpen: sameBar ? Boolean(position.exit?.gapAtOpen) : false,
        barsRead: position.barsRead,
        realizedR: finite(resolution.grossR) ? resolution.grossR : null,
        costR: finite(resolution.feeR) ? resolution.feeR : null,
        netR: finite(resolution.outcomeR) ? resolution.outcomeR : null,
        slippageModeled: true,
    };
};

/**
 * Overlay the ledger's settlement on a tracked signal position.
 *
 * A resolution that matches the tracker is a no-op. A disagreement is recorded
 * and the ledger's status/R win — the resolver is the deterministic owner, and
 * the tracker must not keep two outcomes for one call. The path and MFE/MAE
 * computed by the tracker are preserved; only the verdict and its R move.
 */
export const applySignalResolution = (
    position: TrackedPosition,
    row: SignalRow,
    now: number = Date.now(),
): AppliedSignalResolution => {
    if (position.source !== 'signal' || position.sourceId !== row.signal.id) {
        return { position, changed: false };
    }
    if (row.status === 'open' || !row.resolution) {
        return { position, changed: false };
    }

    if (row.status === 'never_triggered') {
        if (position.status === 'cancelled' && !position.exit) {
            return { position, changed: false };
        }
        const had = position.exit
            ? `${position.status} at ${position.exit.price}`
            : position.status;
        return {
            position: {
                ...position,
                status: 'cancelled',
                closedAt: position.closedAt ?? now,
                exit: undefined,
                ...(position.exit
                    ? { discrepancy: `signal ledger says never triggered; tracker had ${had}` }
                    : {}),
            },
            changed: true,
        };
    }

    const exit = exitFromLedger(position, row as SignalRow & { resolution: NonNullable<SignalRow['resolution']> });
    const status: 'closed' | 'expired' = row.status === 'expired' ? 'expired' : 'closed';
    const unchanged = position.status === status
        && position.exit !== undefined
        && position.exit.reason === exit.reason
        && position.exit.price === exit.price
        && position.exit.realizedR === exit.realizedR
        && position.exit.netR === exit.netR;
    if (unchanged) return { position, changed: false };

    const had = position.exit
        ? `${position.status} at ${position.exit.price}`
        : position.status;
    const closedAt = row.resolution.exitAt !== undefined
        ? row.resolution.exitAt + SIGNAL_BAR_MS
        : row.resolution.at;

    return {
        position: {
            ...position,
            status,
            closedAt,
            exit,
            ...(position.exit
                ? { discrepancy: `signal ledger resolved ${row.status} at ${exit.price}; tracker had ${had}` }
                : {}),
        },
        changed: true,
    };
};

/** Open calls are always worth tracking; a resolved call is worth tracking
 *  only while its tape is still in the 300-bar window. */
export const isSignalAdoptable = (
    row: SignalRow,
    now: number = Date.now(),
    windowMs: number = SIGNAL_ADOPT_WINDOW_MS,
): boolean => row.status === 'open' || row.signal.emittedAt >= now - windowMs;

/**
 * SignalCandle → Kline. The signal venue feed may omit volume (a cross-check
 * normalizer drops it); NaN marks "not fetched" and the tracker's path omits
 * the field rather than printing a false zero.
 */
export const signalBarsToKlines = (candles: readonly SignalCandle[]): Kline[] =>
    candles.map(candle => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: finite(candle.volume) ? candle.volume : Number.NaN,
    }));
