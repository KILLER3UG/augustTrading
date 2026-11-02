/**
 * How a tracked position speaks.
 *
 * ONE home for the words: the signal ledger and the journal's post-mortem both
 * describe the same tracker state, and two copies of "stop hit" is how the
 * signal tab and the trade detail start telling a trader different stories
 * about one position. These are LABELS only — the values stay in the types, so
 * a label change can never move what the tracker measured.
 */

import type {
    DiagnosisChange,
    DiagnosisRefusal,
    ExitReason,
    SameCandleResolution,
    TrackedStatus,
} from '../types/tracking';

export const TRACKED_STATUS_WORD: Record<TrackedStatus, string> = {
    pending_entry: 'waiting for entry',
    open: 'open',
    closed: 'closed',
    expired: 'expired',
    cancelled: 'cancelled',
};

export const EXIT_REASON_WORD: Record<ExitReason, string> = {
    target: 'target hit',
    stop: 'stop hit',
    expiry: 'expired at the validity end',
    manual: 'closed by the trader',
};

/** `stop-first` is a POLICY, not an observation — the label must say so. */
export const SAME_CANDLE_WORD: Record<SameCandleResolution, string> = {
    'single-level': 'one level in the deciding bar',
    'stop-first': 'both levels in one bar — stop-first policy',
    'ordered-1m': 'both levels in one bar — ordered by 1m candles',
};

export const DIAGNOSIS_CHANGE_WORD: Record<DiagnosisChange, string> = {
    entry: 'Entry timing',
    stop: 'Stop placement',
    target: 'Target choice',
    sizing: 'Position size',
    skip: 'Skip this setup',
    hold: 'Hold longer',
};

export const DIAGNOSIS_REFUSAL_WORD: Record<DiagnosisRefusal, string> = {
    'thin-tape': 'the tape was too thin to attribute the outcome',
    'no-lesson': 'the record supported no lesson',
    malformed: 'the model answer was malformed',
};

/** `+1.23R` / `-0.45R`. */
export const signedR = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;

/** An excursion keeps its own sign: MFE >= 0, MAE <= 0, null never prints 0. */
export const excursionR = (n: number | null): string => {
    if (n === null) return 'not measured';
    return n > 0 ? `+${n.toFixed(2)}R` : `${n.toFixed(2)}R`;
};

export const trackedPrice = (n: number): string =>
    n.toLocaleString(undefined, { maximumFractionDigits: 2 });
