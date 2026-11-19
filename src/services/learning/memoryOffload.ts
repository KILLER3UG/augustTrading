/**
 * memoryOffload — the bounded OFFLOAD ("dreaming") passes of the Meta-RAM
 * loop. LOAD reads crisp index files (MARKET_SCHEMA + REGISTRY + the diary
 * recency window); OFFLOAD is what keeps those files current WITHOUT a
 * model call and WITHOUT a second prose store:
 *
 *  1. TRADE RESOLUTION — `offloadOnTradeResolution` rides the settlement
 *     notebook sync (`useTradeLogging › syncClosedTradeToNotebook`): the
 *     coin's MARKET_SCHEMA refreshes its measurable facts and re-derives its
 *     learned traps from the REAL journal rows. The diary entry and the
 *     REGISTRY are written by the same sync, one lock ahead of this.
 *
 *  2. SIGNAL RESOLUTION — the accuracy loop's resolutions land in the signal
 *     ledger, not the journal. `runMemoryOffloadIfDue` folds the resolutions
 *     newer than its stamp into the same per-coin schema refresh, so a
 *     signal-only coin still carries its market facts into the next thread.
 *
 *  3. SESSION CLOSE — when the UTC session date rolls over, the pass writes
 *     ONE bounded session-digest diary entry per coin that resolved real
 *     trades in the closing session, refreshes the REGISTRY, and refreshes
 *     those coins' schemas. The digest is what lets a FRESH chat thread read
 *     "last session: 2 losses, both stops inside range noise" without
 *     re-reading the journal.
 *
 * ISOLATION. Every real-market write here filters `simulated !== true`.
 * Paper practice keeps its own marked diary entries (MemoryFilesService ›
 * buildDiaryEntry) and never writes a real trap, a real cluster or a real
 * session tally.
 *
 * BOUNDS. No model call. At most OFFLOAD_MAX_COINS schemas refresh per pass
 * (newest first). The session digest is one entry per coin per session,
 * deduped by id, under the diary's own entry cap. Stamps live in one
 * Preferences object per user; a pass that changes nothing writes nothing.
 */

import { LoggedTrade, TradeOutcome } from '../../types';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { readSignals } from '../signals/signalLedger';
import { baseOf } from '../../utils/symbol';
import {
    appendDiaryNote,
    syncRecurringMistakes,
} from './MemoryFilesService';
import {
    collectMarketSchemaFacts,
    learnedSchemaTraps,
    syncMarketSchema,
} from './MarketSchemaService';
import { currentSessionDateKey } from '../trade/sessionPlan';

const KEY_PREFIX = 'memory_offload_v1_';

/** The pass looks at most this often — the heartbeat's own cadence, so a
 *  visibility-change burst cannot hammer the market readers. */
export const OFFLOAD_INTERVAL_MS = 15 * 60_000;
/** Schemas refreshed per pass, newest resolution first. The rest are picked
 *  up by the next pass — OFFLOAD is bounded work, never a sweep-the-universe
 *  job on a timer. */
export const OFFLOAD_MAX_COINS = 6;

export interface MemoryOffloadState {
    /** ISO of the last pass that LOOKED (due-check clock). */
    lastPassAt: string;
    /** Epoch ms of the newest signal resolution already folded. */
    lastSignalResolutionAt: number;
    /** The UTC session date key already digested (the rollover detector). */
    lastSessionKey: string;
}

const emptyState = (): MemoryOffloadState => ({
    lastPassAt: new Date(0).toISOString(),
    lastSignalResolutionAt: 0,
    lastSessionKey: '',
});

const keyFor = (username: string): string => `${KEY_PREFIX}${username}`;

const loadState = async (username: string): Promise<MemoryOffloadState> => {
    try {
        const s = await getPreferenceObject<MemoryOffloadState>(keyFor(username));
        return s && typeof s.lastPassAt === 'string' ? { ...emptyState(), ...s } : emptyState();
    } catch {
        return emptyState();
    }
};

const saveState = async (username: string, state: MemoryOffloadState): Promise<void> => {
    await setPreferenceObject(keyFor(username), state);
};

/** The coin's canonical pair as the journal writes it — the schema file is
 *  named after the pair (BTCUSDT.md), the query may be a bare ticker. */
const canonicalCoin = (coin: string): string => {
    const clean = (coin || '').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
    if (!clean) return '';
    return clean.endsWith('USDT') ? clean : `${clean}USDT`;
};

/** Refresh one coin's MARKET_SCHEMA: measurable facts + the traps the REAL
 *  journal rows back. Best-effort — a failed refresh never breaks settlement. */
const refreshCoinSchema = async (coin: string, trades: LoggedTrade[], username: string): Promise<void> => {
    const canonical = canonicalCoin(coin);
    if (!canonical) return;
    try {
        const facts = await collectMarketSchemaFacts(canonical);
        facts.traps = learnedSchemaTraps(canonical, trades);
        await syncMarketSchema(canonical, facts, username);
    } catch (e) {
        console.warn('[MemoryOffload] schema refresh failed for', canonical, e instanceof Error ? e.message : e);
    }
};

/**
 * OFFLOAD on TRADE RESOLUTION. Called by the settlement notebook sync after
 * the diary entry and the REGISTRY are written. Only REAL resolutions write
 * market structure — a paper fill's settlement still updates the diary (its
 * entry is marked SIMULATED by the writer) but never a real-market trap.
 */
export const offloadOnTradeResolution = async (
    trade: LoggedTrade,
    allTrades: LoggedTrade[],
    username: string,
): Promise<void> => {
    if (!username) return;
    if (trade.simulated === true) return;
    if (trade.outcome !== TradeOutcome.WIN && trade.outcome !== TradeOutcome.LOSS) return;
    const coin = trade.analysis?.coinName;
    if (typeof coin !== 'string' || !coin) return;
    await refreshCoinSchema(coin, allTrades, username);
};

/** The session a resolution belongs to: when the outcome became known,
 *  falling back to the row's write time. UTC date key — the same boundary
 *  the session plan and the guard read. */
const resolutionSessionKey = (t: LoggedTrade): string => {
    const iso = t.outcomeResolvedAt ?? t.timestamp ?? '';
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? currentSessionDateKey(ms) : '';
};

/** One coin's session digest body — the bounded "what this session taught"
 *  entry a fresh thread reads through the diary recency window. */
export const buildSessionDigestBody = (
    coin: string,
    sessionKey: string,
    sessionTrades: LoggedTrade[],
): string => {
    const real = sessionTrades.filter(t => t.simulated !== true
        && (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS));
    const wins = real.filter(t => t.outcome === TradeOutcome.WIN).length;
    const losses = real.length - wins;
    // The lesson: the first post-mortem lesson among the session's losses,
    // else the honest absence. No model call — the reflection already wrote
    // the lessons; OFFLOAD only folds them.
    let lesson = '';
    for (const t of real) {
        if (t.outcome !== TradeOutcome.LOSS) continue;
        const pm = t.postMortem ?? '';
        const m = pm.match(/(?:lesson|takeaway)\s*[:\-–]\s*([^\n]{10,})/i);
        if (m) { lesson = m[1].replace(/[*_]/g, '').trim().slice(0, 160); break; }
    }
    const lines = [
        `${sessionKey} · session digest · ${coin} · ${real.length} real trade${real.length === 1 ? '' : 's'} (${wins}W/${losses}L)`,
        `What I learned: ${lesson || 'no single lesson named — the rows behind this entry carry the detail'}`,
    ];
    return lines.join('\n');
};

/**
 * The heartbeat's OFFLOAD pass: signal-resolution fold + session-close
 * digest. Due every OFFLOAD_INTERVAL_MS; each half has its own novelty
 * stamp, so a pass with nothing new writes nothing. Returns what it did
 * (for the log line), or null when not due / nothing ran.
 */
export const runMemoryOffloadIfDue = async (
    username: string,
    trades: LoggedTrade[] = [],
    now: number = Date.now(),
): Promise<{ signalCoins: number; sessionKey: string | null; digestCoins: number } | null> => {
    if (!username) return null;
    const state = await loadState(username);
    const last = Date.parse(state.lastPassAt);
    if (Number.isFinite(last) && now - last < OFFLOAD_INTERVAL_MS) return null;
    state.lastPassAt = new Date(now).toISOString();

    const out = { signalCoins: 0, sessionKey: null as string | null, digestCoins: 0 };
    const touched = new Map<string, number>(); // canonical coin -> newest resolution ms

    // 1. Signal resolutions newer than the stamp — the accuracy loop's
    //    evidence reaches the same per-coin index the journal writes.
    try {
        const rows = readSignals(username);
        let newest = state.lastSignalResolutionAt;
        for (const row of rows) {
            const r = row.resolution;
            if (!r || r.at <= state.lastSignalResolutionAt) continue;
            const coin = canonicalCoin(row.signal.coin);
            if (!coin) continue;
            touched.set(coin, Math.max(touched.get(coin) ?? 0, r.at));
            newest = Math.max(newest, r.at);
        }
        state.lastSignalResolutionAt = newest;
    } catch (e) {
        console.warn('[MemoryOffload] signal fold failed:', e instanceof Error ? e.message : e);
    }

    // 2. Session close — the UTC date rolled over since the last digest.
    const todayKey = currentSessionDateKey(now);
    const closingKey = state.lastSessionKey && state.lastSessionKey < todayKey ? state.lastSessionKey : null;
    if (closingKey) {
        out.sessionKey = closingKey;
        // Coins that resolved REAL trades in the closing session.
        const byCoin = new Map<string, LoggedTrade[]>();
        for (const t of trades ?? []) {
            if (t.simulated === true) continue;
            if (t.outcome !== TradeOutcome.WIN && t.outcome !== TradeOutcome.LOSS) continue;
            if (resolutionSessionKey(t) !== closingKey) continue;
            const coin = canonicalCoin(t.analysis?.coinName ?? '');
            if (!coin) continue;
            byCoin.set(coin, [...(byCoin.get(coin) ?? []), t]);
        }
        // The REGISTRY refreshes wholesale from the real log — the same
        // builder settlement uses, so the two can never disagree.
        try {
            await syncRecurringMistakes(trades ?? [], username);
        } catch (e) {
            console.warn('[MemoryOffload] registry refresh failed:', e instanceof Error ? e.message : e);
        }
        for (const [coin, coinTrades] of byCoin) {
            try {
                const body = buildSessionDigestBody(coin, closingKey, coinTrades);
                await appendDiaryNote(coin, `session-${closingKey}-${baseOf(coin)}`, body, username);
                out.digestCoins += 1;
                touched.set(coin, Math.max(touched.get(coin) ?? 0, now));
            } catch (e) {
                console.warn('[MemoryOffload] session digest failed for', coin, e instanceof Error ? e.message : e);
            }
        }
        state.lastSessionKey = todayKey;
    } else if (!state.lastSessionKey) {
        // First pass ever: adopt today's key WITHOUT digesting — the session
        // is still open, and a boot must not write a half-session digest.
        state.lastSessionKey = todayKey;
    }

    // 3. Schema refresh for the touched coins, newest first, bounded.
    const coins = [...touched.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, OFFLOAD_MAX_COINS)
        .map(([coin]) => coin);
    for (const coin of coins) {
        await refreshCoinSchema(coin, trades ?? [], username);
        out.signalCoins += 1;
    }

    await saveState(username, state);
    if (out.signalCoins === 0 && out.sessionKey === null) return null;
    return out;
};