/**
 * watchService — the "watch or schedule" harness the MODEL drives: it arms
 * price watches and time wakes through the watch_price / wake_me desk tools,
 * and when a condition holds (or the deadline lapses) it queues the harness
 * record into chatStore ITSELF (the thread that armed the watch runs it as a
 * model turn → the model alerts the user); subscribers carry only the OS ping,
 * so no record depends on a component being mounted. Same singleton shape as
 * levelWatchService/PriceAlertService.
 *
 * CONTRACT: advisory only — it never trades, resolves or logs anything. It
 * wakes the model; the model decides what the alert says.
 *
 * Fire-once + lapse: a watch fires exactly once and is then removed (its
 * note may not survive contact with a re-ping). A price watch whose deadline
 * passes first LAPSES — it is removed, persisted, and one `expired` event goes
 * to the same subscribers a fire uses, so the thread that armed it learns the
 * wait ended with nothing to report. Armed watches persist per user in
 * localStorage
 * (`trade_watches_v1_${user}`, capped), so "check back in 30 minutes" survives
 * a reload — and firing needs a live clock: the service runs its own 1s
 * interval while ANY watch is armed. Price watches ride the visible chart
 * feed's tick() when it covers their symbol, and the same clock REST-polls
 * the mark price (Binance futures premiumIndex, ~5s per symbol) for the
 * non-visible ones — before that, a watch armed while the chart pointed at
 * another coin could never see a tick for its symbol and silently expired
 * (Tier-0 #6).
 *
 * STALE IS NOT NEWS (owner ruling, 2026-10-22). A price watch whose condition
 * the tape ALREADY satisfies is refused at arm time rather than fired on the
 * spot, and a watch hydrated from a previous session whose level is already
 * met by the FIRST mark seen after the reload is dropped without emitting. Both
 * cases produced the same complaint: an amber "WATCH … PRINTED …" row and a
 * whole model turn spent announcing a level the market passed long before
 * anyone asked. `levelWatchService.arm(plan, priceAtArm)` has refused an
 * already-dead plan this way all along — this is the same gate on the other
 * half of the harness. What still fires is a condition that becomes true while
 * the app is watching it, which is the only one that is actionable.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { fetchMarkPrice } from './markPricePoll';
import * as chatStore from './chatStore';
import {
    formatWatchEvictedForModel, formatWatchFiredForModel, formatWatchesLapsedForModel,
    watchConditionHolds, watchExpired,
    type WatchFired, type WatchItem,
} from './chartTriggers';
import type { ChartDrawing } from './chartDrawings';
import type { EvalCandle, PriceScaleMode } from './chartGeometry';
import {
    createWatchdogLatch,
    evaluateDrawingWatch,
    type DrawingWatchTriggerEvent,
    type WatchdogLatchState,
} from './watchdogCore';
import {
    drainSentinelNoticesWhenIdle,
    evaluateSentinelEvent,
    type SentinelMinimalContext,
    type SentinelNotice,
} from './sentinelLoop';
import { skillIndexRows, usableSkillRows, type SkillIndexRow } from '../learning/SkillFileService';

const WATCHES_KEY_PREFIX = 'trade_watches_v1';
const MAX_WATCHES = 10;
/** A price is only trusted while fresh: the visible-chart feed prints ~1s
 *  apart and the REST poll refreshes non-visible symbols every ~5s. Beyond
 *  this window a cached print is worse than none (the cross-symbol gate). */
const PRICE_MAX_AGE_MS = 10_000;
/** Per-symbol REST throttle for armed-but-not-visible symbols. Shared with
 *  levelWatchService: both ask the same "is this symbol's price fresh, and is a
 *  poll already in flight?" question, and two copies of the number is how the
 *  two services end up polling a chart at two different rates. The loops stay
 *  local — one walks price watches, the other armed trade plans. */
import { PRICE_POLL_INTERVAL_MS } from './levelWatchService';

const storageKey = (user: string): string => `${WATCHES_KEY_PREFIX}_${user}`;

let watches = new Map<string, WatchItem>();
/** Ids read from localStorage rather than armed in this session. Their first
 *  fresh mark decides whether the level was crossed while nothing was running
 *  (drop it silently) or whether the watch is still waiting on the tape (let
 *  it fire normally from then on). */
const hydrated = new Set<string>();
let loadedFor = '';
/** Last price per symbol + when it arrived. The chart feed's tick() only
 *  ever carries the ACTIVE symbol, so a per-symbol map (not one last-price)
 *  is what lets the REST poll side-feed armed watches on other coins —
 *  previously they silently expired because `lastPriceSymbol === w.symbol`
 *  could never hold for a non-visible symbol (Tier-0 #6). */
let priceBySymbol = new Map<string, { price: number; at: number }>();
const lastPollAttempt = new Map<string, number>();
const pollInFlight = new Set<string>();
const subscribers = new Set<(fired: WatchFired, remaining: WatchItem[]) => void>();
let clock: ReturnType<typeof setInterval> | null = null;

const persist = (): void => {
    try {
        localStorage.setItem(storageKey(loadedFor), JSON.stringify([...watches.values()].slice(-MAX_WATCHES)));
    } catch { /* private mode — watches live in memory this session */ }
};

/** REST-poll every armed price symbol whose feed went stale (the visible
 *  chart tick refreshes its symbol ~1s, so in practice only non-visible
 *  symbols reach this — and a unmounted chart degrades to polled, not
 *  silently dead). Each symbol is attempted at most once per
 *  PRICE_POLL_INTERVAL_MS (throttle counts attempts, not successes, so a
 *  dead endpoint can't hot-loop). */
const pollStaleSymbols = (nowMs: number): void => {
    const targets = new Set<string>();
    for (const w of watches.values()) {
        if (w.kind !== 'price') continue;
        const entry = priceBySymbol.get(w.symbol);
        if (entry && nowMs - entry.at < PRICE_POLL_INTERVAL_MS) continue; // feed is fresh
        targets.add(w.symbol);
    }
    for (const symbol of targets) {
        if (pollInFlight.has(symbol)) continue;
        if (nowMs - (lastPollAttempt.get(symbol) ?? 0) < PRICE_POLL_INTERVAL_MS) continue;
        lastPollAttempt.set(symbol, nowMs);
        pollInFlight.add(symbol);
        void fetchMarkPrice(symbol).then(price => {
            if (price !== null) {
                priceBySymbol.set(symbol, { price, at: Date.now() });
                evaluateWatches(Date.now());
            }
        }).finally(() => pollInFlight.delete(symbol));
    }
};

const validWatch = (w: unknown): w is WatchItem => {
    const v = w as WatchItem & Record<string, unknown>;
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.symbol !== 'string') return false;
    if (typeof v.createdAt !== 'number') return false;
    if (v.kind === 'price') {
        return (v.condition === 'above' || v.condition === 'below')
            && typeof v.price === 'number' && Number.isFinite(v.price)
            && typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt);
    }
    return v.kind === 'time' && typeof v.atMs === 'number' && Number.isFinite(v.atMs);
};

/** Adopt the CURRENT user's armed watches (and drop the previous user's —
 *  the chatStore lesson: track who you loaded for). */
const loadWatches = (): void => {
    const user = getActiveUsername();
    if (user === loadedFor) return;
    loadedFor = user;
    watches = new Map();
    hydrated.clear();
    try {
        const raw = localStorage.getItem(storageKey(user));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
            const nowMs = Date.now();
            const lapsedWhileClosed: WatchItem[] = [];
            for (const w of parsed) {
                if (validWatch(w) && !watchExpired(w, nowMs) && (w.kind === 'price' || w.atMs > nowMs - 60_000)) {
                    watches.set(w.id, w);
                    if (w.kind === 'price') hydrated.add(w.id);
                } else if (validWatch(w) && watchExpired(w, nowMs)) {
                    // The deadline passed while the app was shut. STALE IS NOT
                    // NEWS covers a level the tape already met; it does not
                    // cover a promised report — the note said "check back in
                    // 30 minutes" and the trader deserves the closure line.
                    lapsedWhileClosed.push(w);
                }
            }
            if (lapsedWhileClosed.length > 0) {
                // The watches that SURVIVED this load are still armed; the
                // record must count them or it tells the seat nothing is
                // waiting when nine other waits are.
                recordLapses(lapsedWhileClosed.map(w => ({ watch: w, price: null, at: nowMs, expired: true })), [...watches.values()]);
                persist();
            }
        }
    } catch { /* fresh slate */ }
    syncClock();
};

const syncClock = (): void => {
    // The clock now serves BOTH kinds: time wakes fire off it, and price
    // watches on symbols the visible chart isn't feeding rely on it to run
    // the REST poll — an armed price watch with no clock was the silent
    // expiry (Tier-0 #6). It stops as soon as nothing is armed.
    const needsClock = watches.size > 0;
    if (needsClock && !clock) {
        clock = setInterval(() => {
            const now = Date.now();
            pollStaleSymbols(now);
            evaluateWatches(now);
        }, 1000);
    }
    if (!needsClock && clock) { clearInterval(clock); clock = null; }
};

/** The durable half of a completed watch: the arming thread's harness record,
 *  queued by the SERVICE — before this it was written by whichever component
 *  happened to be mounted, and a fire or lapse with zero listeners (the
 *  trader on another surface) deleted the watch and lost the record with it.
 *  The emit below is presentation only (the OS ping). */
const recordWatch = (fired: WatchFired, remaining: WatchItem[]): void => {
    chatStore.queueHarnessSignal(formatWatchFiredForModel(fired, remaining.length), fired.watch.sid);
};

/** A watch dropped by the MAX_WATCHES ceiling is NOT a lapse: its deadline had
 *  not passed. The arm receipt promised the seat a wake, so the eviction still
 *  owes it a record — with the reason it actually died. */
const recordEviction = (evicted: WatchItem, remaining: WatchItem[]): void => {
    chatStore.queueHarnessSignal(formatWatchEvictedForModel(evicted, remaining.length), evicted.sid);
};

/** Simultaneous lapses become ONE record per session — N instruction blocks
 *  for the same close-the-loop ask is noise, and the signal queue caps at 8,
 *  so a 10-lapse burst as separate signals would drop the oldest two. */
const recordLapses = (lapses: WatchFired[], remaining: WatchItem[]): void => {
    if (lapses.length === 0) return;
    const bySid = new Map<string | undefined, WatchFired[]>();
    for (const f of lapses) {
        const list = bySid.get(f.watch.sid) ?? [];
        list.push(f);
        bySid.set(f.watch.sid, list);
    }
    for (const [sid, group] of bySid) {
        chatStore.queueHarnessSignal(formatWatchesLapsedForModel(group, remaining.length), sid);
    }
};

const emit = (fired: WatchFired, remaining: WatchItem[]): void => {
    for (const cb of subscribers) {
        try { cb(fired, remaining); } catch (e) {
            // A throwing listener must not stall the harness — and with the
            // record queued above, this is presentation loss only. Say so.
            console.warn('[watchService] subscriber threw:', e);
        }
    }
};

/** The freshest trustworthy mark for a watch's symbol: the visible chart
 *  feed (tick) or the REST poll both write priceBySymbol; a print older
 *  than PRICE_MAX_AGE_MS means the feed for it died — better none than a
 *  stale cross-symbol number. */
const priceFor = (symbol: string, nowMs: number): number | null => {
    const entry = priceBySymbol.get(symbol);
    if (!entry || nowMs - entry.at > PRICE_MAX_AGE_MS) return null;
    return entry.price;
};

/** Evaluate every watch against the given clock + last known price; fire the
 *  ones whose condition holds (each at most once, then removed). */
const evaluateWatches = (nowMs: number): void => {
    loadWatches();
    if (watches.size === 0) return;
    const lapses: WatchFired[] = [];
    for (const w of [...watches.values()]) {
        if (watchExpired(w, nowMs)) {
            watches.delete(w.id);
            persist();
            // A lapse is a fact the trader was promised a report on — the note
            // said "check back in N minutes". The record is queued here (see
            // recordWatch); the emit is only the OS-presentation channel, and
            // a lapse does not ping the OS.
            lapses.push({ watch: w, price: null, at: nowMs, expired: true });
            continue;
        }
        // The price only rides the signal when it's THIS symbol's mark —
        // a cross-symbol number is worse than none.
        const price = priceFor(w.symbol, nowMs);
        if (hydrated.has(w.id)) {
            if (price === null) continue;            // still no fresh sight of it
            hydrated.delete(w.id);                  // THIS is the first one
            if (watchConditionHolds(w, price, nowMs)) {
                // The level was already met when the app came back, so the
                // crossing happened while nothing was running: history, not
                // news. Dropped without emitting — and a watch that SURVIVES
                // this first sight keeps its promise, which is the whole point
                // of the flag.
                watches.delete(w.id);
                persist();
                continue;
            }
        }
        if (!watchConditionHolds(w, price, nowMs)) continue;
        watches.delete(w.id);
        persist();
        const remaining = [...watches.values()];
        recordWatch({ watch: w, price, at: nowMs }, remaining);
        emit({ watch: w, price, at: nowMs }, remaining);
    }
    recordLapses(lapses, [...watches.values()]);
    syncClock();
};

/** Arm a parsed watch (chartTriggers.parsePriceWatch / parseTimeWake).
 *  `liveMark` is the caller's hint — the desk tool passes the viewed canvas's
 *  mark when the watch is for that same coin. The service's own feed is the
 *  authority when the caller has none, because the chart has been ticking all
 *  session. Returns 'refused' when the condition is already satisfied, in which
 *  case nothing is armed and nothing will ever fire. */
export const arm = (w: WatchItem, liveMark: number | null = null): 'armed' | 'refused' => {
    loadWatches();
    if (w.kind === 'price') {
        const mark = Number.isFinite(liveMark as number) ? liveMark : priceFor(w.symbol, Date.now());
        if (mark !== null && watchConditionHolds(w, mark, Date.now())) return 'refused';
    }
    let evicted: WatchItem | null = null;
    if (watches.size >= MAX_WATCHES) {
        // Oldest first out — the newest ask is the one the user just made.
        const oldest = [...watches.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) {
            watches.delete(oldest.id);
            evicted = oldest;
        }
    }
    watches.set(w.id, w);
    persist();
    // Recorded AFTER the arm so the count is the set the model will actually
    // see next turn (the eviction freed one slot; the new watch took it).
    if (evicted) recordEviction(evicted, [...watches.values()]);
    syncClock();
    // A TIME wake whose deadline has already passed (an app reopen after the
    // scheduled minute) still owes the model its turn, so this evaluation stays
    // — for a PRICE watch it can now only fire on a condition the gate above
    // just ruled out, which means it is a no-op there.
    evaluateWatches(Date.now());
    return 'armed';
};

export const cancel = (id: string): boolean => {
    loadWatches();
    const had = watches.delete(id);
    if (had) { persist(); syncClock(); }
    return had;
};

/** Cancel by prefix (w-cancel-all helper for the model: every watch on a
 *  symbol, or everything). */
export const cancelWhere = (pred: (w: WatchItem) => boolean): number => {
    loadWatches();
    let n = 0;
    for (const w of [...watches.values()]) {
        if (pred(w)) { watches.delete(w.id); n += 1; }
    }
    if (n > 0) { persist(); syncClock(); }
    return n;
};

export const list = (symbol?: string): WatchItem[] => {
    loadWatches();
    const all = [...watches.values()];
    return symbol ? all.filter(w => w.symbol === symbol) : all;
};

/** The live-feed tick (TradeView calls it with its mark price, ~1s): records
 *  the price and lets price watches fire the moment it touches. */
export const tick = (symbol: string, price: number): void => {
    if (!Number.isFinite(price) || price <= 0) return;
    priceBySymbol.set(symbol, { price, at: Date.now() });
    evaluateWatches(Date.now());
};

export const subscribe = (cb: (fired: WatchFired, remaining: WatchItem[]) => void): (() => void) => {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
};

// ── Drawing-anchored watches + isolated sentinel dispatch ────────────────────
const drawingLatchStates = new Map<string, WatchdogLatchState>();

export interface TickDrawingWatchesInput {
    symbol: string;
    drawings: ReadonlyArray<ChartDrawing>;
    activeTf: string;
    barSeconds: number;
    priceScaleMode: PriceScaleMode;
    candles: ReadonlyArray<EvalCandle>;
    livePrice: number;
    atr14: number | null;
    tickSize?: number;
    isCandleClose?: boolean;
    cooldownBars?: number;
    sid?: string;
    sentinelContext?: SentinelMinimalContext;
}

/**
 * The sentinel packet's skill pointer: the ONE usable skill whose name or
 * description names what just fired (the symbol or the drawing kind). The same
 * deterministic string match `buildMemoryHints` runs for trader turns, and the
 * excerpt only NAMES the slug — the body travels on demand via `skill_view`,
 * exactly as it does in the prompt index, so the packet stays compact.
 */
const sentinelSkillHint = (input: TickDrawingWatchesInput): string | undefined => {
    try {
        const tokens = [...new Set([input.symbol, ...input.drawings.map(d => d.kind)])]
            .filter((t): t is string => !!t);
        if (tokens.length === 0) return undefined;
        let best: { row: SkillIndexRow; score: number } | null = null;
        for (const row of usableSkillRows(skillIndexRows())) {
            const hay = `${row.name} ${row.description}`.toLowerCase();
            const score = tokens.reduce((n, tk) => n + (hay.includes(tk.toLowerCase()) ? 1 : 0), 0);
            if (score > 0 && (!best || score > best.score)) best = { row, score };
        }
        if (!best) return undefined;
        return `skill "${best.row.slug}" — ${best.row.description} (call skill_view {"skill":"${best.row.slug}"} before acting)`;
    } catch {
        return undefined;
    }
};

/**
 * Evaluate watched user/AI drawings against the live tick or candle close with
 * ATR-scaled tolerance, `0.5 * ATR(14)` hysteresis, and bar cooldowns.
 * Triggered events run through the autonomy engine — the configured model
 * classifies each event over the isolated minimal packet (budget, per-symbol
 * cooldown and provider-backoff gated; deterministic fallback), and a
 * `SILENT_MAINTAIN` decision executes on the AI-drawing bucket without chat.
 */
export const tickDrawingWatches = async (
    input: TickDrawingWatchesInput,
): Promise<{ events: DrawingWatchTriggerEvent[]; notices: SentinelNotice[] }> => {
    const events: DrawingWatchTriggerEvent[] = [];
    const notices: SentinelNotice[] = [];
    const ctx: SentinelMinimalContext = input.sentinelContext ?? {
        traderProfileSlice: 'Risk guard active.',
        chartManifestSummary: `${input.symbol} ${input.activeTf} mark ${input.livePrice}`,
        atr14: input.atr14,
        matchedSkillExcerpt: sentinelSkillHint(input),
    };
    const engine = await import('./autonomyEngine');
    for (const drawing of input.drawings) {
        const key = `${input.symbol}:${drawing.id}`;
        const prev = drawingLatchStates.get(key) ?? createWatchdogLatch();
        const { event, nextState } = evaluateDrawingWatch({
            symbol: input.symbol,
            drawing,
            activeTf: input.activeTf,
            barSeconds: input.barSeconds,
            priceScaleMode: input.priceScaleMode,
            candles: input.candles,
            livePrice: input.livePrice,
            isCandleClose: input.isCandleClose,
            atr14: input.atr14,
            tickSize: input.tickSize,
            cooldownBars: input.cooldownBars,
            state: prev,
        });
        drawingLatchStates.set(key, nextState);
        if (!event) continue;
        events.push(event);
        const res = await engine.evaluateSentinelTrigger(
            { source: 'drawing_watch', symbol: input.symbol, sid: input.sid, event },
            ctx,
            { sessionId: input.sid, drawings: input.drawings },
        );
        if (res.notice) notices.push(res.notice);
    }
    // Autonomous AI-drawing hygiene rides the same tick: stale/over-cap agent
    // shapes expire quietly (throttled per symbol inside the engine; the user
    // bucket is structurally unreachable there).
    if (input.sid && events.length >= 0) {
        try {
            await engine.maintainAgentDrawings(input.sid, input.symbol, input.livePrice, input.activeTf);
        } catch { /* hygiene never breaks the tick */ }
    }
    return { events, notices };
};

/**
 * Flush queued sentinel notices into `chatStore.queueHarnessSignal` ONLY when
 * the target session is idle (never mid-stream).
 */
export const drainIdleSentinelNotices = (isIdle: boolean, sid?: string): SentinelNotice[] =>
    drainSentinelNoticesWhenIdle(
        isIdle,
        (signalText, targetSid) => { chatStore.queueHarnessSignal(signalText, targetSid); },
        sid,
    );

/** Test hook: reset the singleton (localStorage persists — that's how a
 *  reload is simulated). */
export const __resetForTests = (): void => {
    watches = new Map();
    hydrated.clear();
    loadedFor = '';
    priceBySymbol = new Map();
    lastPollAttempt.clear();
    pollInFlight.clear();
    subscribers.clear();
    drawingLatchStates.clear();
    if (clock) { clearInterval(clock); clock = null; }
};
