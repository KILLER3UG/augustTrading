/**
 * Regime ledger — one line per coin × day of the market regime the harness
 * observed (Phase 3).
 *
 * The Macro lens is the regime seat, but until this ledger existed it had no
 * memory: it could not say "BTC has spent 58% of the last 90 days ranging,
 * and the current ranging stretch is day 4". recordRegimeDay is called by the
 * analysis pipeline whenever fresh hybrid data names a regime; entries are
 * deduped per coin × day (same-day re-observations overwrite).
 *
 * Persistence rides Preferences (regime_ledger_v1_<user>), bounded. A small
 * module-level cache mirrors the last hydrated user so prompt-side readers
 * (regimeSummaryBlock, doctrine) stay synchronous — hydrateRegimeLedger runs
 * at boot and recordRegimeDay keeps the cache warm on every write.
 */

import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { baseOf } from '../../utils/symbol';
import { phtDayKey } from '../../utils/timezone';

export type LedgerRegime = 'trending' | 'ranging' | 'volatile' | 'compression';

export interface RegimeDay {
    /** YYYY-MM-DD (UTC). */
    date: string;
    /** Normalized coin (BTC, ETH — no USDT suffix). */
    coin: string;
    regime: LedgerRegime;
    source: 'hybrid' | 'inferred';
}

export interface RegimeSummary {
    currentRegime: LedgerRegime | null;
    /** Consecutive calendar days (ending today/latest) in currentRegime. */
    currentStreak: number;
    /** Share of windowed days per regime, percentages summing to ~100. */
    distribution: Partial<Record<LedgerRegime, number>>;
    /** Days observed inside the window. */
    samples: number;
}

const KEY_PREFIX = 'regime_ledger_v1_';
/** Bounded history: ~2 years of daily observations for two coins. */
const MAX_ENTRIES = 1500;

const REGIMES: LedgerRegime[] = ['trending', 'ranging', 'volatile', 'compression'];

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

/** Normalize a coin symbol to the ledger's canonical form (BTC, not BTCUSDT).
 *  Canonical base asset (utils/symbol): one anchored, longest-first strip —
 *  the old double `replace` mapped 'BTCFDUSD' to the corrupt base 'BTCF'. */
export const normalizeLedgerCoin = (coin: string): string => baseOf(coin || '').trim();

const isLedgerRegime = (v: unknown): v is LedgerRegime =>
    typeof v === 'string' && (REGIMES as string[]).includes(v);

/**
 * Map a raw market-regime label (the hybrid pipeline's `MarketRegime`, e.g.
 * 'strong_trend_up' / 'volatile_chop') onto the ledger's four canonical
 * regimes. Returns null for labels that carry no regime signal. Without this
 * the ledger would silently drop every trend/volatile observation, since only
 * 'ranging' and 'compression' pass through isLedgerRegime unchanged.
 */
export const marketRegimeToLedger = (raw: string | undefined | null): LedgerRegime | null => {
    if (!raw) return null;
    const r = String(raw).toLowerCase();
    if (isLedgerRegime(r)) return r;
    if (r.includes('trend')) return 'trending';
    if (r.includes('volatil') || r.includes('chop')) return 'volatile';
    // 'consolidat' joins the range vocabulary deliberately: the other mapper
    // here (ModelPerformanceService.mapRegimeToKey) already reads it as ranging,
    // and a label the ledger could not read was a trade that never counted.
    if (r.includes('rang') || r.includes('consolidat')) return 'ranging';
    if (r.includes('compress') || r.includes('squeeze')) return 'compression';
    return null;
};

// ── Module cache (sync reads for prompt assembly) ──────────────────────
let cache: RegimeDay[] = [];
let cacheUser: string | null = null;

/** Load one user's ledger into the sync cache. Best-effort. */
export const hydrateRegimeLedger = async (username: string): Promise<void> => {
    try {
        const raw = await getPreferenceObject<RegimeDay[]>(keyFor(username));
        cache = Array.isArray(raw)
            ? raw.filter(e => e && typeof e.date === 'string' && typeof e.coin === 'string' && isLedgerRegime(e.regime))
            : [];
        cacheUser = username;
    } catch {
        cache = [];
        cacheUser = username;
    }
};

/** Record (or same-day overwrite) one regime observation. Best-effort:
 *  telemetry must never break the analysis path. */
export const recordRegimeDay = async (
    day: { date?: string; coin: string; regime: string; source?: 'hybrid' | 'inferred' },
    username: string,
): Promise<void> => {
    const coin = normalizeLedgerCoin(day.coin);
    if (!coin || !isLedgerRegime(day.regime)) return;
    // PHT day key (utils/timezone) — the ledger groups by the trader's day,
    // not the UTC one.
    const date = day.date || phtDayKey();
    try {
        const list = (await getPreferenceObject<RegimeDay[]>(keyFor(username))) ?? [];
        const kept = Array.isArray(list)
            ? list.filter(e => !(e.coin === coin && e.date === date))
            : [];
        kept.push({ date, coin, regime: day.regime, source: day.source ?? 'hybrid' });
        kept.sort((a, b) => a.date.localeCompare(b.date));
        await setPreferenceObject(keyFor(username), kept.slice(-MAX_ENTRIES));
        if (cacheUser === username) {
            // Mirror the persisted write EXACTLY. `kept` already holds the new
            // entry (pushed above) — re-filtering and re-pushing it here left
            // the cache with two rows for (coin, date), so getRegimeSummary
            // double-counted today: inflated `samples`, skewed distribution.
            cache = kept.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_ENTRIES);
        }
    } catch { /* best-effort */ }
};

/** Distinct coins in the sync cache, alphabetical. */
export const listLedgerCoins = (): string[] =>
    [...new Set(cache.map(e => e.coin))].sort();

/**
 * The regime observed for one coin on one day — the ledger's own day key (a
 * PHT calendar day, `utils/timezone`), so a trade timestamp and a ledger row
 * written from a hybrid run land on the same bucket.
 *
 * When the exact day was never observed, the NEAREST EARLIER observation within
 * `lookbackDays` answers instead: a regime label from yesterday still describes
 * the tape, and a label from three weeks ago does not. Nothing near enough
 * returns null — a gap stays a gap rather than becoming an inferred regime the
 * matrix will count as evidence.
 */
export const regimeOnDay = (
    coin: string | undefined,
    dateKey: string,
    lookbackDays = 3,
): { regime: LedgerRegime; ageDays: number } | null => {
    const norm = normalizeLedgerCoin(coin || '');
    if (!norm || !dateKey) return null;
    const mine = cache
        .filter(e => e.coin === norm && e.date <= dateKey)
        .sort((a, b) => b.date.localeCompare(a.date));
    for (let age = 0; age <= lookbackDays; age++) {
        const wanted = shiftDays(dateKey, age);
        const hit = mine.find(e => e.date === wanted);
        if (hit) return { regime: hit.regime, ageDays: age };
    }
    return null;
};

/**
 * The regime a CLOSED trade was settled in, and how we know.
 *
 * `LoggedTrade.marketRegime` is only written when a live hybrid snapshot
 * existed at log time, so most historical rows carry nothing — and every
 * regime-conditional reader silently skips them. This resolves the same
 * question once, in the one order every caller agrees on:
 *
 *   snapshot → ledger (this coin, this day or the nearest earlier one)
 *            → the analysis's own pattern text
 *
 * The ledger is the harness's own observation, so `source: 'ledger'` is
 * evidence — which is also why it is stamped rather than quietly folded into
 * `marketRegime`, so a reader can tell an observed regime from a resolved one.
 */
export type RegimeSource = 'snapshot' | 'ledger' | 'analysis';

/** A union, not two independent fields: `source` describes where `regime` came
 *  from, so a resolved regime without a source (or the reverse) is a state no
 *  caller should have to defend against. `regime: null` is the honest gap. */
export type ResolvedRegime =
    | { regime: LedgerRegime; source: RegimeSource; ledgerAgeDays?: number }
    | { regime: null; source: null };

const dayKeyOf = (timestamp: string | undefined): string => {
    if (!timestamp) return '';
    const ms = new Date(timestamp).getTime();
    return Number.isFinite(ms) ? phtDayKey(ms) : '';
};

export const resolveTradeRegime = (trade: {
    coin?: string;
    timestamp?: string;
    marketRegime?: string;
    analysis?: { coinName?: string; marketConditions?: { pattern?: string }; marketSnapshot?: unknown } | undefined;
}): ResolvedRegime => {
    const fromField = marketRegimeToLedger(trade.marketRegime);
    if (fromField) return { regime: fromField, source: 'snapshot' };

    // `marketRegime` can be absent while the snapshot it came from is still on
    // the row (older writers stored the snapshot but not the derived key).
    const snap = (trade.analysis?.marketSnapshot as { regime?: { regime?: string } } | undefined)?.regime?.regime;
    const fromSnap = marketRegimeToLedger(snap);
    if (fromSnap) return { regime: fromSnap, source: 'snapshot' };

    // The coin is read from either place on purpose: a chat-side caller holds a
    // message analysis (`analysis.coinName`) and a journal-side caller holds a
    // LoggedTrade, and a resolver that silently missed the second one would
    // report "no regime observed" for a trade the ledger has days of data on.
    const hit = regimeOnDay(trade.coin || trade.analysis?.coinName, dayKeyOf(trade.timestamp));
    if (hit) return { regime: hit.regime, source: 'ledger', ledgerAgeDays: hit.ageDays };

    const fromText = marketRegimeToLedger(trade.analysis?.marketConditions?.pattern);
    if (fromText) return { regime: fromText, source: 'analysis' };

    return { regime: null, source: null };
};

const shiftDays = (isoDate: string, days: number): string => {
    // Whole-day arithmetic on a midnight-UTC anchor — zone-invariant for fixed
    // offsets — but the KEY comes from the one helper (a PHT day key).
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return phtDayKey(d.getTime());
};

/**
 * Summarize one coin's regime history from the sync cache. `days` bounds the
 * window; the streak counts consecutive calendar days in the current regime
 * ending at the newest observation. Returns an empty summary when the cache
 * holds nothing for the coin (callers render nothing, never an error).
 */
export const getRegimeSummary = (coin: string, days = 90): RegimeSummary => {
    const empty: RegimeSummary = { currentRegime: null, currentStreak: 0, distribution: {}, samples: 0 };
    const norm = normalizeLedgerCoin(coin);
    if (!norm) return empty;
    const mine = cache.filter(e => e.coin === norm);
    if (mine.length === 0) return empty;
    const sorted = [...mine].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const cutoff = shiftDays(latest.date, days);
    const windowed = sorted.filter(e => e.date >= cutoff);

    const distribution: Partial<Record<LedgerRegime, number>> = {};
    for (const r of REGIMES) {
        const n = windowed.filter(e => e.regime === r).length;
        if (n > 0) distribution[r] = Math.round((n / windowed.length) * 100);
    }

    // Streak: walk backward from the newest observation; each step must be
    // the previous calendar day AND the same regime.
    const byDate = new Map(windowed.map(e => [e.date, e]));
    let streak = 0;
    let cursor = latest.date;
    while (byDate.get(cursor)?.regime === latest.regime) {
        streak += 1;
        cursor = shiftDays(cursor, 1);
    }

    return { currentRegime: latest.regime, currentStreak: streak, distribution, samples: windowed.length };
};

/**
 * One-line prompt block for the Macro lens (the regime seat), capped at
 * `max` chars. '' when the ledger has nothing on this coin.
 */
export const regimeSummaryBlock = (coin: string | undefined, days = 90, max = 150): string => {
    if (!coin) return '';
    const s = getRegimeSummary(coin, days);
    if (!s.currentRegime || s.samples === 0) return '';
    const mix = Object.entries(s.distribution)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([r, pct]) => `${r} ${pct}%`)
        .join(' / ');
    const line = `REGIME LEDGER (${normalizeLedgerCoin(coin)}, last ${days}d, ${s.samples} observed days): ${s.currentRegime} now (day ${s.currentStreak} of this stretch) · mix: ${mix}`;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
