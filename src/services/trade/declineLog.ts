/**
 * declineLog — the HOLD record.
 *
 * Before this, a model that decided NOT to present a plan left no object at
 * all: no row, no candidate, no reason. "Are we skipping winners?" was
 * structurally unanswerable because the skip did not exist. `decline_trade`
 * writes one bounded row per declined setup, and the reason and rejected
 * levels are the evidence a later pass needs.
 *
 * It is deliberately NOT a journal row: a decline has no entry, no stop and no
 * outcome. It is a candidate-shaped record, stored beside the journal and
 * included in backup/export.
 */

import { getActiveUsername } from '../../utils/activeUser';

export interface DeclineRecord {
    id: string;
    symbol: string;
    direction: 'Long' | 'Short' | 'Neutral';
    reason: string;
    entry?: number;
    stopLoss?: number;
    takeProfits?: number[];
    invalidation?: string;
    /** Who declined: a live desk turn or a scheduled run. */
    /** `automation` is historical: the scheduled run that wrote it was
     *  deleted on 2026-10-24, and stored rows still carry the value. */
    source: 'desk' | 'automation';
    createdAt: string;
}

const KEY_PREFIX = 'trade_declines_v1_';
/** Bounded like every other ledger; 365 days of declines is far below this. */
export const MAX_DECLINES = 500;

const keyFor = (username?: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

/** The result of reading the HOLD record. `rows` is empty in BOTH the
 *  "nothing was ever declined" and the "the store could not be read" cases —
 *  which is exactly why the old `catch { return []; }` rendered a corrupted
 *  store as an empty history. `error` is the distinction a reader can show. */
export interface DeclineReadResult {
    rows: DeclineRecord[];
    error: string | null;
}

/** Read the HOLD record, reporting a failed read instead of swallowing it.
 *
 *  Empty means empty ONLY when the key is absent (or holds an empty list): the
 *  desk never declined anything. A key that is present but unreadable —
 *  missing localStorage, a throwing getItem, invalid JSON, a non-list, or a
 *  list with no usable record — is a failure, and says so. A list with SOME
 *  usable record still returns the readable rows: hiding them would trade one
 *  silent loss for another. */
export const tryListDeclines = (username?: string): DeclineReadResult => {
    if (typeof localStorage === 'undefined') {
        return { rows: [], error: 'localStorage is unavailable in this environment' };
    }
    let raw: string | null;
    try {
        raw = localStorage.getItem(keyFor(username ?? getActiveUsername()));
    } catch {
        return { rows: [], error: 'the decline history could not be read from localStorage' };
    }
    // No key is the honest empty state: no decline was ever recorded.
    if (!raw) return { rows: [], error: null };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { rows: [], error: 'the decline history is corrupted (not valid JSON)' };
    }
    if (!Array.isArray(parsed)) {
        return { rows: [], error: 'the decline history is corrupted (not a list of declines)' };
    }
    const rows = parsed.filter((r): r is DeclineRecord =>
        !!r && typeof r === 'object'
        && typeof (r as DeclineRecord).id === 'string'
        && typeof (r as DeclineRecord).reason === 'string');
    // A stored list with nothing usable in it is a corrupt store, not an empty
    // one: the key exists, so bytes were written and are now unreadable.
    if (rows.length === 0 && parsed.length > 0) {
        return { rows: [], error: 'the decline history is corrupted (no readable declines)' };
    }
    return { rows, error: null };
};

/** The old contract: an empty array on any failure. Kept as a thin wrapper
 *  for the callers that cannot act on an error — the write path and any
 *  backup/export reader — so their behaviour is byte-for-byte unchanged. */
export const listDeclines = (username?: string): DeclineRecord[] =>
    tryListDeclines(username).rows;

const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Record one decline. Returns null when there is no symbol (nothing to log
 *  against) — a decline still needs an instrument to be useful. */
export const recordDecline = (
    input: {
        symbol?: unknown;
        direction?: unknown;
        reason?: unknown;
        entry?: unknown;
        stopLoss?: unknown;
        takeProfits?: unknown;
        invalidation?: unknown;
        source?: 'desk' | 'automation';
    },
    username?: string,
): DeclineRecord | null => {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    const reason = String(input.reason ?? '').trim();
    if (!symbol || !reason) return null;
    const direction = input.direction === 'Long' || input.direction === 'Short' || input.direction === 'Neutral'
        ? input.direction
        : 'Neutral';
    const takeProfits = Array.isArray(input.takeProfits)
        ? input.takeProfits.map(num).filter((n): n is number => n !== undefined).slice(0, 5)
        : [];
    const record: DeclineRecord = {
        id: `decline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        direction,
        reason: reason.slice(0, 600),
        ...(num(input.entry) !== undefined ? { entry: num(input.entry) } : {}),
        ...(num(input.stopLoss) !== undefined ? { stopLoss: num(input.stopLoss) } : {}),
        ...(takeProfits.length > 0 ? { takeProfits } : {}),
        ...(typeof input.invalidation === 'string' && input.invalidation.trim()
            ? { invalidation: input.invalidation.trim().slice(0, 300) }
            : {}),
        source: input.source ?? 'desk',
        createdAt: new Date().toISOString(),
    };
    if (typeof localStorage === 'undefined') return null;
    try {
        const key = keyFor(username ?? getActiveUsername());
        const next = [record, ...listDeclines(username)].slice(0, MAX_DECLINES);
        localStorage.setItem(key, JSON.stringify(next));
    } catch {
        // Quota / private mode: do not claim a write that did not happen.
        return null;
    }
    return record;
};
