/**
 * signalLedger — the append-only record of emitted signals and their
 * resolutions.
 *
 * STORAGE. One localStorage namespace per user (`signal_ledger_v1:<user>`),
 * the same local-first path the notebook and the learning stores use; the
 * backup sweep already walks every scoped key, and the namespace is registered
 * in `ExportService` on both the export and restore lists so a backup carries
 * it (see RAW_LOCAL_STORAGE_PREFIXES / RESTORABLE_PREFERENCE_KEY_PREFIXES).
 *
 * APPEND-ONLY. An emission, each shadow check and the resolution are separate
 * events; nothing is rewritten. The store refuses a second resolution for the
 * same signal, so a later re-settlement cannot quietly improve the record.
 * The only mutation is the CAP: the oldest complete signals (every event of
 * theirs) are dropped together, never an event in isolation.
 *
 * CAP. 150 signals or 200 KiB of JSON, whichever binds first — a resolution
 * event is small, but the whole store must stay far inside a backup's byte
 * budget and the shared 5 MiB origin quota.
 */

import type {
    SignalEvent, SignalRefusalRecord, SignalRefusalResolution, SignalRow, SignalResolution,
} from '../../types/signal';
import { getActiveUsername } from '../../utils/activeUser';

export const SIGNAL_LEDGER_KEY = 'signal_ledger_v1';
export const MAX_SIGNALS = 150;
export const MAX_REFUSALS = 100;
export const LEDGER_BYTE_CAP = 200 * 1024;

export const signalLedgerKey = (user: string = getActiveUsername()): string =>
    `${SIGNAL_LEDGER_KEY}:${user}`;

const isEvent = (value: unknown): value is SignalEvent => {
    if (!value || typeof value !== 'object') return false;
    const e = value as Partial<SignalEvent>;
    if (e.v !== 1
        || typeof e.id !== 'string' || e.id.length === 0
        || typeof e.at !== 'number') return false;
    switch (e.type) {
        case 'emit': return !!e.signal;
        case 'resolve': return !!e.resolution;
        case 'gate': return !!e.gate;
        case 'ground': return !!e.grounding;
        case 'refuse': return !!e.refusal;
        case 'refuse_resolve': return !!e.refusalResolution;
        default: return false;
    }
};

export const readSignalEvents = (user: string = getActiveUsername()): SignalEvent[] => {
    try {
        const raw = localStorage.getItem(signalLedgerKey(user));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isEvent);
    } catch {
        // An unreadable ledger is not an empty one, but there is nothing to
        // return that would be truthful. `appendSignalEvent` overwrites only
        // after this read, so a corrupt store is preserved on disk until a
        // write. Callers show "no signals yet"; the record's own bytes remain.
        return [];
    }
};

/** Drop whole signals — and whole refusals, as one unit each — oldest first,
 *  until the count and byte caps hold. Refusals carry their OWN count cap, and
 *  the prune empties the pool that is OVER ITS OWN cap: an oldest-overall
 *  order would let a chatty protection rule evict a real signal that happens
 *  to be older than the oldest refusal. Only the byte cap prunes oldest
 *  overall, because bytes do not belong to either pool. */
export const pruneLedgerEvents = (events: readonly SignalEvent[], byteCap: number = LEDGER_BYTE_CAP): SignalEvent[] => {
    let kept = [...events];
    const idsInOrder = (): string[] => {
        const seen = new Map<string, number>();
        for (const e of kept) {
            if (!seen.has(e.id)) {
                seen.set(e.id, e.type === 'emit' && e.signal
                    ? e.signal.emittedAt
                    : e.type === 'refuse' && e.refusal ? e.refusal.emittedAt : e.at);
            }
        }
        return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    };
    const counts = (): { signals: number; refusals: number; bytes: number } => {
        let signals = 0;
        let refusals = 0;
        for (const e of kept) {
            if (e.type === 'emit') signals += 1;
            else if (e.type === 'refuse') refusals += 1;
        }
        return { signals, refusals, bytes: JSON.stringify(kept).length };
    };
    while (kept.length > 0) {
        const { signals, refusals, bytes } = counts();
        if (signals <= MAX_SIGNALS && refusals <= MAX_REFUSALS && bytes <= byteCap) break;
        const ids = idsInOrder();
        const isRefusalId = (id: string): boolean => kept.some(e => e.id === id && e.type === 'refuse');
        // Prune the pool that is over its own cap; when only the byte cap
        // binds (or both are), fall through to the oldest unit overall.
        const target = ids.find(id => (isRefusalId(id) ? refusals > MAX_REFUSALS : signals > MAX_SIGNALS)) ?? ids[0];
        kept = kept.filter(e => e.id !== target);
    }
    return kept;
};

export interface LedgerWrite {
    ok: boolean;
    error?: string;
    events?: SignalEvent[];
}

/**
 * Append one event. Refuses a second `emit` or a second `resolve` for the same
 * id, and a duplicate shadow check of the same kind — the ledger's whole claim
 * is that history is not rewritten.
 */
export const appendSignalEvent = (event: SignalEvent, user: string = getActiveUsername()): LedgerWrite => {
    const events = readSignalEvents(user);
    const mine = events.filter(e => e.id === event.id);
    if (event.type === 'emit' && mine.some(e => e.type === 'emit')) {
        return { ok: false, error: 'a signal with this id already exists' };
    }
    if (event.type === 'resolve' && mine.some(e => e.type === 'resolve')) {
        return { ok: false, error: 'this signal is already resolved' };
    }
    if ((event.type === 'gate' || event.type === 'ground') && mine.some(e => e.type === event.type)) {
        return { ok: false, error: `this signal already has a ${event.type} event` };
    }
    if (event.type === 'refuse' && mine.some(e => e.type === 'refuse')) {
        return { ok: false, error: 'a refusal with this id already exists' };
    }
    if (event.type === 'refuse_resolve' && mine.some(e => e.type === 'refuse_resolve')) {
        return { ok: false, error: 'this refusal is already resolved' };
    }
    const next = pruneLedgerEvents([...events, event]);
    try {
        localStorage.setItem(signalLedgerKey(user), JSON.stringify(next));
        // Read back: a quota failure can throw on write, but a backend that
        // silently drops bytes would otherwise report a save that never landed.
        const back = localStorage.getItem(signalLedgerKey(user));
        if (back !== JSON.stringify(next)) {
            return { ok: false, error: 'the ledger write could not be read back' };
        }
        return { ok: true, events: next };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
};

export const foldSignals = (events: readonly SignalEvent[]): SignalRow[] => {
    const byId = new Map<string, SignalRow>();
    for (const event of events) {
        if (event.type !== 'emit') continue;
        byId.set(event.id, { signal: event.signal, status: 'open' });
    }
    for (const event of events) {
        const row = byId.get(event.id);
        if (!row) continue;
        if (event.type === 'gate') row.gate = event.gate;
        else if (event.type === 'ground') row.grounding = event.grounding;
        else if (event.type === 'resolve') {
            row.resolution = event.resolution;
            row.status = event.resolution.status;
        }
    }
    return [...byId.values()].sort((a, b) => b.signal.emittedAt - a.signal.emittedAt);
};

/** One refusal folded from its events. A refusal is NOT a SignalRow: it never
 *  enters `readSignals`, so the tracker, the scorecard and the protections
 *  cannot mistake a blocked call for a live one. */
export interface SignalRefusalRow {
    refusal: SignalRefusalRecord;
    resolution?: SignalRefusalResolution;
    /** 'open' while ungraded; the resolution's outcome once graded. */
    status: 'open' | SignalRefusalResolution['outcome'];
}

export const foldRefusals = (events: readonly SignalEvent[]): SignalRefusalRow[] => {
    const byId = new Map<string, SignalRefusalRow>();
    for (const event of events) {
        if (event.type !== 'refuse' || !event.refusal) continue;
        byId.set(event.id, { refusal: event.refusal, status: 'open' });
    }
    for (const event of events) {
        const row = byId.get(event.id);
        if (!row) continue;
        if (event.type === 'refuse_resolve' && event.refusalResolution) {
            row.resolution = event.refusalResolution;
            row.status = event.refusalResolution.outcome;
        }
    }
    return [...byId.values()]
        .filter((r): r is SignalRefusalRow & { refusal: SignalRefusalRecord } => !!r.refusal)
        .sort((a, b) => b.refusal.emittedAt - a.refusal.emittedAt);
};

export const readSignals = (user: string = getActiveUsername()): SignalRow[] =>
    foldSignals(readSignalEvents(user));

export const recordSignalResolution = (
    signalId: string,
    resolution: SignalResolution,
    user: string = getActiveUsername(),
): LedgerWrite => appendSignalEvent(
    { v: 1, type: 'resolve', at: resolution.at, id: signalId, resolution },
    user,
);

/** Test-only: wipe the namespace for one user. */
export const __clearSignalLedgerForTests = (user: string = getActiveUsername()): void => {
    try { localStorage.removeItem(signalLedgerKey(user)); } catch { /* no storage */ }
};
