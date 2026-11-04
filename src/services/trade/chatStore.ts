/**
 * chatStore — the Chart AI dock's session state, hoisted OUT of React so an
 * in-flight answer survives a surface switch. The trade surface is mounted
 * only while its tab is active, so a plain useState panel would unmount (and
 * its unmount-cleanup abort) the moment the user glanced at the Journal — the
 * stream died mid-sentence. Living in a module singleton instead: the run
 * keeps streaming into the store while the panel is gone, and remounting
 * re-subscribes to the SAME live entries (streaming text resumes on screen).
 *
 * Also owns the per-session AbortControllers (so switching tabs never aborts
 * another session's run — only an explicit Stop or deleting a session does),
 * the debounced persistence into chatSessions (streaming flags stripped, so a
 * half-finished answer is never written to storage), and the HARNESS SIGNAL
 * QUEUE: level-watch price events land here, not in a component ref, so a hit
 * that arrives while a run is busy — or while the dock is unmounted — is
 * never dropped; the panel flushes the queue when the session goes idle.
 *
 * Persistence is user-scoped and honest about it: the store remembers WHICH
 * user it loaded for and refuses to write the previous user's chats into the
 * newly active user's key — a detected switch rehydrates from the new key
 * instead. A `storage` listener keeps two windows of the same user from
 * silently clobbering each other (refresh when idle; a live stream wins).
 */

import {
    ChatSession, StoredChatEntry, createSession, loadSessions, saveSessions, storageKey,
    MAX_SESSIONS,
} from './chatSessions';
import { getActiveUsername, LAST_ACTIVE_USER_KEY } from '../../utils/activeUser';
import type { TradeProposal } from './proposedTrade';
import type { ReasoningEffort } from '../providers/reasoningControls';

/** A trade currently open in this session (logged but not yet resolved by
 *  the outcome autopilot). The model context loader in useAnalysisPipeline
 *  can consult this so the chat session sees which of its recommendations are
 *  still in flight. Runtime-only — never persisted (reset on rehydrate). */
export interface OpenTradeRow {
    tradeId: string;
    symbol: string;
    direction: string;
    entry: string;
    stopLoss: string;
    takeProfits: string[];
    openedAt: string;
}

/** Stored entry + the non-persisted streaming flag for the in-flight answer. */
export type LiveEntry = StoredChatEntry & {
    streaming?: boolean;
    /** A trade the model PRESENTED via the present_trade tool — the dock
     *  renders it as a card with Log-this-trade / Cancel. Not persisted. */
    proposal?: TradeProposal;
    /** The live-only "still working" line for a slow call; not persisted. */
    liveProgress?: string;
};
export type LiveSession = Omit<ChatSession, 'entries'> & {
    entries: LiveEntry[];
    /** Trades logged from this session whose outcome has not yet resolved.
     *  Cleared when the autopilot (or manual flow) closes the trade. */
    openTrades?: Record<string, OpenTradeRow>;
    /** Chronological list of trade ids ever logged from this session — the
     *  model context loader's channel for "do you remember your last
     *  recommendation?" even after the trade has resolved. */
    loggedTradeIds?: string[];
};

/** The immutable snapshot React reads via useSyncExternalStore. `running` is
 *  the set of session ids with a live stream, so the composer knows what's
 *  busy without a second subscription. `conversationRunning` is the same idea
 *  for the CHAT SURFACE's runs, keyed by conversation id. `signals` is the
 *  pending harness signal queue (see takeHarnessSignals). */
export interface ChatSnapshot {
    sessions: LiveSession[];
    activeId: string;
    running: Record<string, true>;
    /** Live Chat-surface runs, keyed by CONVERSATION id. */
    conversationRunning: Record<string, true>;
    signals: HarnessSignal[];
}

/** One queued `[HARNESS SIGNAL …]` and the session that should receive it. */
export interface HarnessSignal {
    text: string;
    /** The session that owns the plan or armed the watch. Absent for a signal
     *  with no owner (a level hit from a conversation, not the dock). */
    sid?: string;
}

let sessions: LiveSession[] = [];
let activeId = '';
let loaded = false;
/** The user the in-memory sessions were loaded for — the persist guard's
 *  anchor. Writing while this differs from getActiveUsername() would leak
 *  one user's chats into another's storage key. */
let loadedFor = '';
let pendingSignals: HarnessSignal[] = [];
const controllers = new Map<string, AbortController>();
/**
 * The CHAT SURFACE's live runs, keyed by CONVERSATION id.
 *
 * The map above is keyed by SESSION id (a dock chat session). A Chat-surface
 * run belongs to a CONVERSATION — the trader's thread — and the two id spaces
 * are different, so they get their own map rather than sharing one: a shared
 * map would let a session id and a conversation id collide, and one run's Stop
 * would abort the other.
 *
 * WHY THE STORE AT ALL: the hook that owns these runs is App-level and never
 * unmounts, but the BADGE that says "this conversation is still running" is
 * rendered by a component the App does not thread props into — a module
 * singleton is the only channel that reaches it. That is the same reason the
 * dock's run state lives here (see the file header).
 */
const conversationControllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let saveTimer = 0;
let storageWatched = false;

let snapshot: ChatSnapshot = { sessions, activeId, running: {}, conversationRunning: {}, signals: [] };

/** Last-open session id, per user — so a reload returns to the same chat. */
const activeKey = (user: string): string => `trade_chat_active_v1_${user}`;

const rebuild = (): void => {
    const running: Record<string, true> = {};
    for (const id of controllers.keys()) running[id] = true;
    const conversationRunning: Record<string, true> = {};
    for (const id of conversationControllers.keys()) conversationRunning[id] = true;
    snapshot = { sessions, activeId, running, conversationRunning, signals: pendingSignals };
};

// ── Session cap (mirrors trimForStorage) ───────────────────────────────────
// chatSessions persists the last MAX_SESSIONS chats (trimForStorage), so the
// LIVE store applies the SAME bound — memory and disk must not diverge, or the
// transcript shows rows a reload cannot restore. There is deliberately NO entry
// cap here any more: per-chat entry count and the reasoning-text cut were
// removed under the owner's 2026-10-27 "store everything" ruling, so the only
// bound left on this path is the blob's byte budget in chatSessions.

/** Keep at most MAX_SESSIONS sessions, evicting oldest-first. A session
 *  with a LIVE RUN is never chosen while idle candidates exist: dropping it
 *  would orphan a stream still writing into the store (its mutate would land
 *  on a session no longer in the list). Only when every overflow candidate
 *  is running does plain oldest-first apply — the cap must hold. */
const capSessions = (list: LiveSession[]): LiveSession[] => {
    if (list.length <= MAX_SESSIONS) return list;
    const overflow = list.length - MAX_SESSIONS;
    const drop = new Set<number>();
    for (let i = 0; i < list.length && drop.size < overflow; i += 1) {
        if (!controllers.has(list[i].id)) drop.add(i);
    }
    for (let i = 0; i < list.length && drop.size < overflow; i += 1) drop.add(i);
    return list.filter((_, i) => !drop.has(i));
};

const emit = (): void => {
    rebuild();
    for (const l of listeners) l();
    schedulePersist();
};

/** Notify subscribers WITHOUT scheduling a persist. The run registries hold
 *  nothing persistable — a live run is not a fact about the transcript — so
 *  they must not drag the debounced save along on every state change. */
const publish = (): void => {
    rebuild();
    for (const l of listeners) l();
};

/** Persist the settled transcript. An entry that is still streaming is
 *  EXCLUDED from the write (a half-finished answer must never land) but does
 *  NOT block the rest — previously one stuck `streaming:true` bubble (a seat
 *  that threw after partial text, or an aborted full-analysis) silently
 *  re-armed this timer forever and froze EVERY session's persistence until
 *  reload. */
const schedulePersist = (): void => {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        if (getActiveUsername() !== loadedFor) { rehydrate(); return; }
        const stored: ChatSession[] = sessions.map(s => ({
            ...s,
            entries: s.entries
                .filter(e => !e.streaming)
                .map(({ streaming: _streaming, proposal: _proposal, liveProgress: _liveProgress, ...rest }) => rest),
            // openTrades / loggedTradeIds are runtime-only — persisted sessions
            // never carry them (a reload means "we have no live trade state"),
            // so strip them defensively here even though chatSessions.ts also
            // doesn't write them out.
            openTrades: undefined,
            loggedTradeIds: undefined,
        }));
        saveSessions(stored);
        // The last-open session rides the same debounce — reopening the app
        // (or the Analyze surface) lands back in this session, with its chart
        // setup, model and effort restored from the session row itself.
        try { localStorage.setItem(activeKey(loadedFor), activeId); } catch { /* private mode */ }
    }, 400);
};

/** Load the CURRENT user's sessions into memory and notify subscribers. */
const rehydrate = (): void => {
    loadedFor = getActiveUsername();
    const stored = loadSessions();
    sessions = stored.length > 0 ? stored : [createSession()];
    let wanted = '';
    try { wanted = localStorage.getItem(activeKey(loadedFor)) || ''; } catch { /* private mode */ }
    // No pointer (a fresh install, another device's backup, or this key's
    // deliberate absence from backups — it is a plain string the export sweep
    // cannot carry): open the session the trader touched LAST. Not `sessions[0]`,
    // which is the OLDEST row, because new sessions are appended and a restore can
    // add rows out of order — so the choice is made from the row's own timestamps.
    const byRecency = (s: LiveSession): number => s.updatedAt || s.createdAt || 0;
    const newest = sessions.reduce<LiveSession | undefined>(
        (best, s) => (!best || byRecency(s) > byRecency(best) ? s : best),
        undefined,
    );
    activeId = sessions.some(s => s.id === wanted) ? wanted : (newest?.id ?? '');
    rebuild();
    for (const l of listeners) l();
};

/**
 * Persist what a LIVE turn has produced so far, as interrupted rows.
 *
 * The debounce deliberately drops `streaming` entries — a half-finished answer
 * must never land as if it were complete. But a tab closed, a renderer killed or
 * a machine slept mid-turn then lost the ENTIRE run: the trader watched two
 * minutes of analysis and reloaded into nothing (the 2026-10-27 audit L-6). On a
 * hide/unload the partial text IS the last thing the trader saw, so it is written
 * WITHOUT the streaming flag — which is exactly what an interruption is.
 */
export const persistInterrupted = (): void => {
    try {
        if (!loaded || getActiveUsername() !== loadedFor) return;
        const stored: ChatSession[] = sessions.map(s => ({
            ...s,
            entries: s.entries.map(({ streaming, proposal: _proposal, liveProgress: _liveProgress, ...rest }) => (streaming ? { ...rest, interrupted: true } : rest)),
            openTrades: undefined,
            loggedTradeIds: undefined,
        }));
        saveSessions(stored);
        try { localStorage.setItem(activeKey(loadedFor), activeId); } catch { /* private mode */ }
    } catch { /* an unload path must never throw */ }
};

let unloadHooked = false;
const hookUnload = (): void => {
    if (unloadHooked || typeof window === 'undefined') return;
    unloadHooked = true;
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persistInterrupted();
    });
    window.addEventListener('beforeunload', () => persistInterrupted());
};

const ensureLoaded = (): void => {
    if (loaded) return;
    loaded = true;
    rehydrate();
    hookUnload();
    if (!storageWatched && typeof window !== 'undefined') {
        storageWatched = true;
        window.addEventListener('storage', ev => {
            if (!loaded) return;
            // Another window switched users → adopt the new key's chats.
            if (ev.key === LAST_ACTIVE_USER_KEY) {
                if (getActiveUsername() !== loadedFor) rehydrate();
                return;
            }
            // Another window wrote THIS user's chats → refresh, but only
            // while nothing is streaming here (the live transcript wins).
            if (ev.key === storageKey() && getActiveUsername() === loadedFor
                && !sessions.some(s => controllers.has(s.id))) {
                rehydrate();
            }
        });
    }
};

export const subscribe = (fn: () => void): (() => void) => {
    ensureLoaded();
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

export const getSnapshot = (): ChatSnapshot => {
    ensureLoaded();
    return snapshot;
};

export const getActiveId = (): string => { ensureLoaded(); return activeId; };

/** THE session the surfaces share — read, written and adopted through one rule.
 *
 *  Three places need "the chat this trader is on": the Chart AI dock, the Chat
 *  surface's composer (its instrument picker writes here) and `TradeView`, which
 *  follows the session's coin. Each used to resolve it its own way — one by raw
 *  id, one with a `sessions[0]` fallback, one by raw id only — and when the two
 *  answers differed the picker became a label: it repainted from the row it
 *  rendered while the write and the chart's read landed on a row that no longer
 *  existed. One accessor, so the reader and the writer cannot disagree. */
export const getActiveSession = (): LiveSession | undefined => {
    const s = getSnapshot();
    return s.sessions.find(x => x.id === s.activeId) ?? s.sessions[0];
};

/**
 * THE one writer for the chart's instrument.
 *
 * `TradeView`'s symbol picker and the desk's `switch_chart_symbol` tool both
 * land here. The chart, the dock, the Agents composer and the shell's
 * instrument label all read this session row, so a write that bypassed this
 * function would leave one of them naming a different coin. Returns the
 * symbol that was on the row before the write (or null when there is no
 * active session), so a caller can report an honest "X -> Y" receipt.
 */
export const setActiveSymbol = (symbol: string): string | null => {
    ensureLoaded();
    const session = getActiveSession();
    if (!session) return null;
    const previous = session.symbol ?? null;
    if (previous === symbol) return previous;
    mutate(session.id, s => ({ ...s, symbol }));
    return previous;
};

/**
 * The ACTIVE session's composer thinking tier, read fresh (no subscription).
 *
 * One row, two homes: the Chart AI dock and the Agents surface both drive this
 * dial, so the value a turn sends must come from here rather than from
 * whichever component last wrote it. A session with no stored tier is
 * `'auto'` — "whatever this task defaults to" — which is the behavior every
 * chat had before the dial existed.
 */
export const getActiveEffort = (): ReasoningEffort => {
    ensureLoaded();
    return sessions.find(s => s.id === activeId)?.effort ?? 'auto';
};

/** Set it on the ACTIVE session, so the other home sees the same tier the
 *  moment it re-renders. Writing a row rather than component state is the
 *  point: the dock unmounts when you hop to the Agents surface, and state that
 *  died with it is the sync gap this closes. */
export const setActiveEffort = (next: ReasoningEffort): void => {
    ensureLoaded();
    if (getActiveEffort() === next) return;
    mutate(activeId, s => ({ ...s, effort: next }));
};

/** The same write-through for the composer's model pick: the app-wide default
 *  is App's state, the PER-SESSION binding is this row. A Agents surface that set
 *  only the default left the dock answering with whatever this chat last used —
 *  the other half of "the two surfaces don't sync". A panel session keeps its
 *  seats and is left alone. */
export const setActiveSoloModel = (value: string): void => {
    ensureLoaded();
    const sid = activeId;
    const s = sessions.find(x => x.id === sid);
    if (!s || s.kind === 'panel' || s.soloModel === value) return;
    mutate(sid, sess => ({ ...sess, soloModel: value }));
};

export const setActiveId = (id: string): void => {
    ensureLoaded();
    if (id === activeId) return;
    activeId = id;
    emit();
};

/** Append a fresh session and (optionally) make it active. Returns its id. */
export const addSession = (partial: Partial<LiveSession> = {}, activate = true): string => {
    ensureLoaded();
    // A new chat starts with the composer AS IT STANDS. The two composer
    // preferences — thinking tier and solo model — are inherited from the
    // session being left, because a chat created mid-run is not a new choice:
    // `bindConversation` mints one the moment the Agents surface's send lands in a
    // fresh App conversation, and a row that inherits nothing reset the dock's
    // chip to Auto right under the trader who had just picked High.
    //
    // Only these two ride over. The chart setup is deliberately NOT inherited
    // here: the dock passes it explicitly when the trader presses New chat, and a
    // bot session opened with `{ botId }` must not adopt the coin of whichever
    // chat happened to be on screen.
    const from = sessions.find(s => s.id === activeId);
    const fresh: LiveSession = {
        ...createSession(),
        ...(from ? { effort: from.effort, soloModel: from.soloModel } : {}),
        ...partial,
        entries: partial.entries ?? [],
    };
    sessions = capSessions([...sessions, fresh]);
    if (activate) activeId = fresh.id;
    emit();
    return fresh.id;
};

/** Delete a session; aborts its in-flight run (a real teardown, unlike a
 *  tab switch). Keeps at least one session alive. Returns the new active id. */
export const removeSession = (id: string): string => {
    ensureLoaded();
    controllers.get(id)?.abort();
    controllers.delete(id);
    // Queued harness signals bound to a deleted session can never drain (the
    // dock's drain only takes signals for a LIVE session) — they sat until
    // cap eviction, carrying records the seat was promised. Drop them.
    pendingSignals = pendingSignals.filter(sig => sig.sid !== id);
    const next = sessions.filter(s => s.id !== id);
    if (next.length === 0) {
        const fresh: LiveSession = { ...createSession(), entries: [] };
        sessions = [fresh];
        activeId = fresh.id;
        emit();
        return fresh.id;
    }
    sessions = next;
    if (id === activeId) activeId = next[next.length - 1].id;
    emit();
    return activeId;
};

/** Immutably update one session (entries, title, panel seats…). Entry appends
 *  used to ride a MAX_ENTRIES cap through here so every append path stayed
 *  bounded; the cap is gone (see the note above), which also means a
 *  title-or-seat-only update now keeps the SAME entries array reference for
 *  the reason the cap used to claim: nothing is rewritten at all. */
export const mutate = (id: string, fn: (s: LiveSession) => LiveSession): void => {
    ensureLoaded();
    let matched = false;
    sessions = sessions.map(s => {
        if (s.id !== id) return s;
        matched = true;
        return fn(s);
    });
    // A miss used to be silent, and silence is the worst shape this can take: a
    // send that writes into an id the store no longer holds appends no row,
    // throws nothing, and leaves a bubble streaming forever. The one symptom a
    // trader sees is "it never answered", which points at the provider.
    if (!matched) console.warn(`chatStore: mutate on unknown session "${id}" — nothing was written`);
    emit();
};

/** Select — or create — the session that stands in for an App conversation, and
 *  make it the active one.
 *
 *  The Agents surface and the Chart AI dock are ONE conversation across two
 *  surfaces, and `ChatSession.conversationId` is the link. Hopping from a chat
 *  to the dock therefore has to land on that conversation's session, not on
 *  whichever session was last used.
 *
 *  A session is adopted only when it is genuinely blank: one that already holds
 *  a transcript of its own must keep its own binding, or "New chat" would answer
 *  with the previous conversation's rows. */
export const bindConversation = (conversationId: string): string => {
    ensureLoaded();
    const bound = sessions.find(s => s.conversationId === conversationId);
    if (bound) {
        activeId = bound.id;
        emit();
        return bound.id;
    }
    const blank = sessions.find(s => !s.conversationId && s.entries.length === 0);
    if (blank) {
        sessions = sessions.map(s => (s.id === blank.id ? { ...s, conversationId } : s));
        activeId = blank.id;
        emit();
        return blank.id;
    }
    // Minting has to carry the instrument over. This runs when the trader moves
    // between the two homes of ONE conversation, and `TradeView` reads the coin
    // off the session it lands on: a session born with no symbol made the chart
    // open on its default while the conversation it joined was about ETH. The
    // dock's own "New chat" already stamps the setup on screen (see addSession's
    // call there) — this is the same rule on the path a surface switch takes.
    const from = getActiveSession();
    return addSession({
        conversationId,
        ...(from?.symbol ? { symbol: from.symbol } : {}),
        ...(from?.interval ? { interval: from.interval } : {}),
    });
};

// ── Logged-trade harness visibility (openTrades, loggedTradeIds) ─────────────
// The Chart AI dock's chat session is blind to its OWN trade-logging events
// unless we hand it state. These helpers are the only allowed mutators for
// the openTrades / loggedTradeIds invariants so the rest of the codebase
// doesn't widen the surface.

/** Push a notice-style entry ("trade logged", "trade closed…") into a
 *  session — renders as a compact system line, not a model answer. The
 *  session id defaults to the active session so the caller rarely has to
 *  look it up. */
export const addChatSystemEntry = (text: string, sid?: string): string | null => {
    ensureLoaded();
    const target = sid ?? activeId;
    if (!target) return null;
    if (!sessions.some(s => s.id === target)) return null;
    const id = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mutate(target, s => ({
        ...s,
        entries: [...s.entries, { id, role: 'ai', text: '', tools: [text], notice: true }],
    }));
    return id;
};

/** Record that `tradeId` was logged from `sid` (or the active session).
 *  Adds it to the session's `openTrades` ledger AND to `loggedTradeIds`
 *  (the model context loader's channel for "your last recommendation…").
 *  No-op if the session doesn't exist. */
export const addOpenTrade = (row: OpenTradeRow, sid?: string): void => {
    ensureLoaded();
    const target = sid ?? activeId;
    if (!target) return;
    if (!sessions.some(s => s.id === target)) return;
    mutate(target, s => {
        const prevIds = s.loggedTradeIds ?? [];
        const nextIds = prevIds.includes(row.tradeId) ? prevIds : [...prevIds, row.tradeId];
        return {
            ...s,
            openTrades: { ...(s.openTrades ?? {}), [row.tradeId]: row },
            loggedTradeIds: nextIds,
        };
    });
};

/** Clear a trade from the openTrades ledger once the outcome resolves.
 *  `loggedTradeIds` is preserved (it's the channel for resolved trades too).
 *  No-op if the session or trade id is unknown. */
export const removeOpenTrade = (tradeId: string, sid?: string): void => {
    ensureLoaded();
    const target = sid ?? activeId;
    if (!target) return;
    if (!sessions.some(s => s.id === target)) return;
    mutate(target, s => {
        if (!(s.openTrades && tradeId in s.openTrades)) return s;
        const next = { ...s.openTrades };
        delete next[tradeId];
        return { ...s, openTrades: next };
    });
};

/** Find the session id whose entries include a chat entry with id === `entryId`.
 *  Used to route a "trade logged" event back to the harness that presented
 *  the trade (the conversation Message.id and the chat entry id are the
 *  same in the present_trade path). Returns undefined if no match. */
export const findSessionByEntryId = (entryId: string): string | undefined => {
    ensureLoaded();
    return sessions.find(s => s.entries.some(e => e.id === entryId))?.id;
};

// ── Harness signal queue (level-watch price events) ─────────────────────────

/** Queue a `[HARNESS SIGNAL …]` text for the panel to run as a model turn.
 *  Capped so a runaway watch can't flood the transcript. */
export const queueHarnessSignal = (text: string, sid?: string): void => {
    pendingSignals = [...pendingSignals, { text, ...(sid ? { sid } : {}) }].slice(-8);
    emit();
};

/** Drain the queued signals (the panel calls this when the session is idle).
 *  `only` drains the signals for one session, leaving the rest queued — the
 *  panel uses it to hand each wake to the thread that owns it instead of to
 *  whichever session happens to be on screen (the 2026-10-27 audit L-7). */
export const takeHarnessSignals = (only?: string | 'unbound'): HarnessSignal[] => {
    if (pendingSignals.length === 0) return [];
    const matches = (s: HarnessSignal): boolean => (
        only === undefined ? true : only === 'unbound' ? !s.sid : s.sid === only
    );
    const out = pendingSignals.filter(matches);
    if (out.length === 0) return [];
    pendingSignals = pendingSignals.filter(s => !matches(s));
    emit();
    return out;
};

// ── Run controllers (per session, so switching tabs never cancels) ──────────

export const beginRun = (sid: string, controller: AbortController): void => {
    controllers.set(sid, controller);
    emit();
};

export const getController = (sid: string): AbortController | undefined => controllers.get(sid);

/** End a run ONLY if the store still holds THIS run's controller.
 *  chatStore keys controllers by session; a second beginRun (a queued harness
 *  flush racing this run, or a double-submit that slipped through) REPLACES the
 *  entry — and a blind endRun(sid) would then delete the NEWER run's slot,
 *  leaving it un-stoppable while the finished one's `busy` ghost lingers.
 *  Identity check: whoever owns the slot clears the slot. Lives here, beside
 *  the controller map it reads, so every caller shares one rule. */
export const endRunOwned = (sid: string, controller: AbortController): void => {
    if (controllers.get(sid) === controller) endRun(sid);
};

export const endRun = (sid: string): void => {
    controllers.delete(sid);
    emit();
};

// ── Conversation-keyed runs (the Agents surface's runs) ───────────────────────
//
// The Agents surface's run is OWNED BY THE CONVERSATION IT WAS TYPED IN, so a
// conversation switch moves the view and leaves the run alone. These are the
// store-side half of that: the owner-checked release, a per-conversation Stop,
// and the "is anything running" read the badge needs.

/** Register a live run against the CONVERSATION it belongs to. */
export const beginConversationRun = (conversationId: string, controller: AbortController): void => {
    if (!conversationId) return;
    conversationControllers.set(conversationId, controller);
    publish();
};

/** End a conversation run ONLY if the store still holds THIS run's controller.
 *  Same rule as `endRunOwned` above, and for the same reason: a blind delete
 *  would clear a NEWER run's slot and leave it un-stoppable. */
export const endConversationRunOwned = (conversationId: string, controller: AbortController): void => {
    if (conversationControllers.get(conversationId) === controller) endConversationRun(conversationId);
};

export const endConversationRun = (conversationId: string): void => {
    if (!conversationControllers.has(conversationId)) return;
    conversationControllers.delete(conversationId);
    publish();
};

/** Explicit Stop: abort ONE conversation's run, and only that one. */
export const abortConversationRun = (conversationId: string): void => {
    conversationControllers.get(conversationId)?.abort();
};

/** Abort EVERY conversation run — the profile switch's job: a different
 *  trader's data must not receive the previous trader's answer. */
export const abortAllConversationRuns = (): void => {
    if (conversationControllers.size === 0) return;
    for (const c of conversationControllers.values()) c.abort();
    conversationControllers.clear();
    publish();
};

/** Is this one conversation running? */
export const isConversationRunning = (conversationId: string): boolean =>
    conversationControllers.has(conversationId);

/** Is ANY conversation running? — the surface-level badge's question. */
export const anyConversationRunning = (): boolean => conversationControllers.size > 0;

/** Explicit Stop: abort the active session's run (the button's job). */
export const abortActive = (): void => {
    const ctrl = controllers.get(activeId);
    if (ctrl) ctrl.abort();
};

/** A profile switch: abort the outgoing identity's runs, drop its in-memory
 *  transcript and pending signals, then load the incoming user's sessions.
 *  Called after the active-user marker has changed. */
export const resetForUserSwitch = (): void => {
    for (const c of controllers.values()) { try { c.abort(); } catch { /* older runtimes */ } }
    controllers.clear();
    for (const c of conversationControllers.values()) { try { c.abort(); } catch { /* older runtimes */ } }
    conversationControllers.clear();
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = 0;
    sessions = [];
    activeId = '';
    loaded = false;
    loadedFor = '';
    pendingSignals = [];
    ensureLoaded();
};

/** Test hook: reset the singleton between suites. */
export const __resetForTests = (): void => {
    for (const c of controllers.values()) c.abort();
    controllers.clear();
    for (const c of conversationControllers.values()) c.abort();
    conversationControllers.clear();
    listeners.clear();
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = 0;
    sessions = [];
    activeId = '';
    loaded = false;
    loadedFor = '';
    pendingSignals = [];
    snapshot = { sessions, activeId, running: {}, conversationRunning: {}, signals: [] };
};
