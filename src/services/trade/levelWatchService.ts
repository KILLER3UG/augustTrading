/**
 * levelWatchService — the harness side of "price reached a plan level, tell
 * Chart AI". Same shape as PriceAlertService/OutcomeAutopilotService: a
 * module singleton the trade surface arms from present_trade proposals and
 * ticks from the live mark-price feed; a hit queues its harness record into
 * chatStore itself (routed to the dock thread that armed the plan) and notifies
 * subscribers for the OS ping only — never through a component.
 *
 * CONTRACT (load-bearing): ADVISORY ONLY — this warns, it never resolves.
 * OutcomeAutopilotService owns SL/TP resolution and the post-mortem for
 * logged trades; both watch the same levels deliberately (one grades the
 * trade, one prompts the conversation). Nothing here writes trade outcomes.
 *
 * Fire-once: every level id that fires is latched in localStorage per user
 * (`trade_level_hits_v1_${user}`, capped), so a reload — or re-watching the
 * same plan — never re-pings a level that already spoke. The latch tracks
 * which user it was loaded for, so a user switch reloads instead of leaking
 * one profile's latches into another's key (the chatStore lesson). Armed
 * plans persist too (`trade_level_arms_v1_${user}`) — a reload no longer
 * silently un-watches a live trade; the per-user adopt re-arms from storage.
 *
 * ENTRY re-touch exception (deep-dive Tier-1: a strict fire-once latch on
 * ENTRY killed the "is my entry live?" signal — price dips to entry, prints
 * back above, dips again, and the second touch was silenced). The ENTRY
 * latch is per-VISIT, not per-life: once a printed price sits on the FAR
 * side of the entry (above it for a Long, below for a Short), the ENTRY id
 * is un-latched, so the NEXT touch of the entry re-fires and re-notifies.
 * SL and TP levels keep the strict fire-once latch — an invalidated or paid
 * plan must never re-ping. The persistence contract is untouched: every
 * latch add/remove still writes the same per-user blob immediately, and a
 * reload inherits exactly the current latch state (fired + still in the
 * entry's zone ⇒ silent; far side ⇒ re-armed).
 *
 * Ticks ride the visible chart's live feed (TradeView calls tick() with its
 * mark, ~1s) — but that feed only ever carries the VIEWED coin. A plan armed
 * for another symbol (a background/harness turn presenting an off-view
 * instrument — reachable since the wave-3 turn-context; or an adopted
 * reload/user-switch plan on a coin the chart isn't on) could therefore never
 * see a tick and went silent — the same Tier-0 #6 shape watchService fixed
 * for price watches. So the service runs its own 1s interval while ANY plan
 * is armed and REST-polls the mark price (Binance futures premiumIndex,
 * ~5s per symbol, same fetch+throttle shape as watchService's) for symbols
 * whose last feed print went stale; a polled print runs through the exact
 * same tick() crossing logic, so notify/queueHarnessSignal routing is
 * automatic. A fresh live tick suppresses polling for its symbol, and the
 * interval stops as soon as nothing is armed.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { fetchMarkPrice } from './markPricePoll';
import * as chatStore from './chatStore';
import {
    buildPlanLevels, detectLevelHits, formatLevelHitForModel, staleLevelsAtArm,
    type LevelHit, type PlanLevel, type WatchPlan,
} from './tradePlanLevels';
import { shouldRearmEntryWithHysteresis } from './watchdogCore';

interface ArmedPlan {
    plan: WatchPlan;
    levels: PlanLevel[];
    /** Last accepted tick for this plan (crossing/dedup anchor). */
    prev: number | null;
}

const HITS_KEY_PREFIX = 'trade_level_hits_v1';
/** Latched ids are warnings that already spoke — bound the blob. */
const MAX_LATCHED = 200;
/** Armed plans persist under the sibling key so a reload doesn't silently
 *  un-watch a live trade (deep-dive Tier-1: the latch persisted, the armed
 *  set was memory-only). */
const ARMS_KEY_PREFIX = 'trade_level_arms_v1';
const MAX_ARMS = 10;
/**
 * Per-symbol REST throttle for a watch whose price feed is not refreshing —
 * the visible chart feed refreshes its symbol ~1s, so in practice only
 * off-view symbols go stale and get polled (a quiet/unmounted chart degrades
 * to polled too).
 *
 * EXPORTED, and imported by watchService, which had its own copy reading 5_000.
 * Both services answer the same question — "is this symbol's price fresh, and
 * is a poll already in flight?" — with near-identical code against the same
 * `priceBySymbol` map and the same `pollInFlight` guard, down to the identical
 * `// feed is fresh` comment. The old note here said "Same 5s cadence as
 * watchService's cross-symbol poll", which is the invariant written as PROSE:
 * true on the day it was written, and a silent drift the moment either file was
 * edited. An import cannot rot that way.
 *
 * Only the interval is shared. The two services still keep their own throttle
 * LOOPS, because one walks armed trade plans and the other walks price
 * watches — different inputs, different latching. Collapsing those is a larger
 * change than the duplication is currently worth, and is named here so it is a
 * decision rather than an oversight.
 */
export const PRICE_POLL_INTERVAL_MS = 5_000;

const hitsKey = (user: string): string => `${HITS_KEY_PREFIX}_${user}`;
const armsKey = (user: string): string => `${ARMS_KEY_PREFIX}_${user}`;

let armed = new Map<string, ArmedPlan>();
let fired = new Set<string>();
let firedFor = '';
const subscribers = new Set<(hit: LevelHit, plan: WatchPlan) => void>();
/** Last price per symbol + when it arrived. tick() (the visible chart feed)
 *  and the REST poll both write here; the freshness check is what identifies
 *  the symbols the poller owns — the poller never fetches a symbol the view
 *  feed printed within the last ~5s. */
let priceBySymbol = new Map<string, { price: number; at: number }>();
const lastPollAttempt = new Map<string, number>();
const pollInFlight = new Set<string>();
let clock: ReturnType<typeof setInterval> | null = null;

const validPlan = (p: unknown): p is WatchPlan => {
    const v = p as WatchPlan & Record<string, unknown>;
    return !!v && typeof v === 'object'
        && typeof v.planId === 'string' && typeof v.symbol === 'string'
        && (v.direction === 'Long' || v.direction === 'Short')
        && typeof v.entry === 'number' && Number.isFinite(v.entry)
        && typeof v.stopLoss === 'number' && Number.isFinite(v.stopLoss)
        && Array.isArray(v.takeProfits)
        && v.takeProfits.every(t => typeof t === 'number' && Number.isFinite(t));
};

/** Rebuild the armed map from the current user's persisted plans. `prev`
 *  resets to null — the first post-reload tick is judged on the plain touch
 *  test (the "first-tick fallback" detectLevelHits already documents), and
 *  the fire-once latch keeps anything that spoke pre-reload silent. */
const loadArmed = (): void => {
    try {
        const raw = localStorage.getItem(armsKey(firedFor));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return;
        for (const p of parsed.slice(-MAX_ARMS)) {
            if (!validPlan(p)) continue;
            armed.set(p.planId, { plan: p, levels: buildPlanLevels(p), prev: null });
        }
    } catch { /* fresh arms set */ }
};

const persistArmed = (): void => {
    try {
        const plans = [...armed.values()].slice(-MAX_ARMS).map(a => a.plan);
        if (plans.length === 0) localStorage.removeItem(armsKey(firedFor));
        else localStorage.setItem(armsKey(firedFor), JSON.stringify(plans));
    } catch { /* private mode — plans live in memory this session */ }
};

/** Adopt the CURRENT user's latch + armed set (cheap no-op while the user is
 *  unchanged). On a switch, ALSO drop the previous user's in-memory ARMED
 *  plans before reloading this user's: the fired-latch is per-user, but
 *  `armed` was a module-global, so without this A's plan would be ticked
 *  against B's price feed and fire B's Chart AI. */
const loadFired = (): void => {
    const user = getActiveUsername();
    if (user === firedFor) return;
    firedFor = user;
    armed = new Map();
    fired = new Set();
    try {
        const raw = localStorage.getItem(hitsKey(user));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) fired = new Set(parsed.filter((x): x is string => typeof x === 'string'));
    } catch { /* fresh latch */ }
    loadArmed();
    // A switch can empty or populate `armed` — the REST-poll clock follows it.
    syncClock();
};

const persistFired = (): void => {
    try {
        localStorage.setItem(hitsKey(firedFor), JSON.stringify([...fired].slice(-MAX_LATCHED)));
    } catch { /* private mode — latches live in memory this session */ }
};

/** REST-poll every armed plan's symbol whose feed went stale. The visible
 *  chart tick refreshes its symbol ~1s, so in practice only off-view symbols
 *  reach this (a plan armed by a background turn for a coin the chart isn't
 *  on — Tier-0 #6 for this watch family). Each symbol is attempted at most
 *  once per PRICE_POLL_INTERVAL_MS (throttle counts attempts, not successes,
 *  so a dead endpoint can't hot-loop); a successful print runs the existing
 *  tick() crossing logic, and the harness record is queued inside that logic,
 *  so a polled hit routes exactly as a view-fed one does. */
const pollStaleSymbols = (nowMs: number): void => {
    loadFired(); // a user switch mid-watch replaces `armed` (and may end the clock)
    if (armed.size === 0) { syncClock(); return; }
    const targets = new Set<string>();
    for (const a of armed.values()) {
        const entry = priceBySymbol.get(a.plan.symbol);
        if (entry && nowMs - entry.at < PRICE_POLL_INTERVAL_MS) continue; // feed is fresh
        targets.add(a.plan.symbol);
    }
    for (const symbol of targets) {
        if (pollInFlight.has(symbol)) continue;
        if (nowMs - (lastPollAttempt.get(symbol) ?? 0) < PRICE_POLL_INTERVAL_MS) continue;
        lastPollAttempt.set(symbol, nowMs);
        pollInFlight.add(symbol);
        void fetchMarkPrice(symbol).then(price => {
            if (price !== null) tick(symbol, price);
        }).finally(() => pollInFlight.delete(symbol));
    }
};

/** The 1s poll clock. It runs while ANY plan is armed — deliberately NOT only
 *  while a symbol looks stale: if the clock stopped the moment every print
 *  was fresh, a view feed that then died (unmounted chart, dropped socket)
 *  would have nothing left to notice the staleness, and the silent-starvation
 *  gap would re-open. An armed plan with no live feed to tick it is exactly
 *  the case this exists for (same reasoning as watchService's clock). */
const syncClock = (): void => {
    const needsClock = armed.size > 0;
    if (needsClock && !clock) {
        clock = setInterval(() => pollStaleSymbols(Date.now()), 1000);
    }
    if (!needsClock && clock) { clearInterval(clock); clock = null; }
};

/** Start watching a plan. `priceAtArm` (the live mark, if known) feeds the
 *  stale-plan guard: a plan already through its stop/target latches silently
 *  and is NOT armed — no tick-0 pings for a dead or paid plan. */
export const arm = (plan: WatchPlan, priceAtArm: number | null): void => {
    loadFired();
    const stale = staleLevelsAtArm(plan, priceAtArm);
    if (stale.length > 0) {
        stale.forEach(id => fired.add(id));
        persistFired();
        return;
    }
    armed.set(plan.planId, { plan, levels: buildPlanLevels(plan), prev: null });
    persistArmed();
    // The arm may have introduced a symbol the live feed never ticks — make
    // sure the REST poll clock exists to cover it.
    syncClock();
};

export const disarm = (planId: string): void => {
    loadFired();
    if (armed.delete(planId)) { persistArmed(); syncClock(); }
};

/** Drop every plan on a symbol (the trade surface resets its watch when the
 *  user switches instruments — fired latches persist, so nothing re-pings). */
export const disarmSymbol = (symbol: string): void => {
    loadFired();
    let changed = false;
    for (const [id, a] of armed) if (a.plan.symbol === symbol) { armed.delete(id); changed = true; }
    if (changed) { persistArmed(); syncClock(); }
};

/** Does `price` currently TOUCH the plan's entry (at or through it,
 *  direction-aware — same test as tradePlanLevels.touches for an entry
 *  level)? A print on the FAR side is what re-arms the ENTRY latch: the
 *  entry's "visit" ended, and the next touch deserves a fresh "is my entry
 *  live?" ping. SL/TP ids are never re-armed here. */
const touchingEntry = (level: PlanLevel, price: number, direction: 'Long' | 'Short'): boolean => {
    if (!Number.isFinite(level.price) || level.price <= 0) return false;
    return direction === 'Long' ? price <= level.price : price >= level.price;
};

export interface LevelTickOptions {
    atr14?: number | null;
    tickSize?: number;
}

/** One live price observation for a symbol — either the visible chart's
 *  ~1s mark feed (TradeView) or the internal REST poll feeding an off-view
 *  symbol. Records the print (freshness gates the poller) and runs the
 *  crossing logic for that symbol's armed plans. When `atr14` is supplied,
 *  ENTRY re-arm requires `>= 0.5 * ATR(14)` hysteresis to prevent chop storms. */
export const tick = (symbol: string, price: number, opts?: LevelTickOptions): void => {
    loadFired(); // adopt a user switch BEFORE the empty check — the reload
    // may populate `armed` itself
    if (!Number.isFinite(price) || price <= 0) return; // never poison `prev`/freshness
    priceBySymbol.set(symbol, { price, at: Date.now() });
    if (armed.size === 0) return;
    const isFired = (id: string): boolean => fired.has(id);
    const atr14 = opts?.atr14 ?? null;
    const tickSize = opts?.tickSize ?? 0;
    for (const a of armed.values()) {
        if (a.plan.symbol !== symbol) continue;
        const hits = detectLevelHits(a.levels, a.plan.direction, a.prev, price, isFired);
        a.prev = price;
        for (const h of hits) fired.add(h.levelId);
        // ENTRY re-touch: require ATR-scaled hysteresis (`>= 0.5 * ATR(14)`)
        // when ATR is available so chop near entry never storms alerts; fall
        // back to plain far-side check when ATR is unknown.
        let rearmed = false;
        const entry = a.levels.find(l => l.kind === 'entry');
        if (entry && fired.has(entry.id)) {
            const canRearm = atr14 !== null && Number.isFinite(atr14) && atr14 > 0
                ? shouldRearmEntryWithHysteresis(entry.price, price, a.plan.direction, atr14, tickSize)
                : !touchingEntry(entry, price, a.plan.direction);
            if (canRearm) {
                fired.delete(entry.id);
                rearmed = true;
            }
        }
        if (hits.length === 0 && !rearmed) continue;
        persistFired(); // latch mutations (fires AND re-arms) persist at once
        for (const h of hits) {
            // The harness record is queued by the SERVICE — the hit was just
            // latched AND persisted, so with the record left to a subscriber
            // (TradeView) a level hit on an unmounted surface was announced
            // to nobody, and the fire-once latch made it unrecoverable: the
            // same class as the watchService lapse loss, but worse, because
            // the state was already spent. The emit below is presentation
            // only (the OS ping).
            chatStore.queueHarnessSignal(formatLevelHitForModel(a.plan, h, firedLevelsFor(a.plan.planId)), a.plan.sid);
            for (const cb of subscribers) {
                try { cb(h, a.plan); } catch (e) {
                    console.warn('[levelWatchService] subscriber threw:', e);
                }
            }
        }
    }
};

export const subscribe = (cb: (hit: LevelHit, plan: WatchPlan) => void): (() => void) => {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
};

/** Plans currently under watch (the dock renders their levels into the
 *  model's context via describePlanForModel). loadFired() first so a
 *  user switch adopted here re-reads the incoming user's persisted arms. */
export const getArmedPlans = (): WatchPlan[] => {
    loadFired();
    return [...armed.values()].map(a => a.plan);
};

/** Which of an armed plan's levels have already fired. */
export const firedLevelsFor = (planId: string): string[] => {
    loadFired();
    const a = armed.get(planId);
    return a ? a.levels.map(l => l.id).filter(id => fired.has(id)) : [];
};

/** Test hook: reset the singleton between suites (localStorage persists —
 *  that's exactly how a reload is simulated). */
export const __resetForTests = (): void => {
    armed = new Map();
    fired = new Set();
    firedFor = '';
    subscribers.clear();
    priceBySymbol = new Map();
    lastPollAttempt.clear();
    pollInFlight.clear();
    if (clock) { clearInterval(clock); clock = null; }
};
