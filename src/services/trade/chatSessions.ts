/**
 * chatSessions — persistence for the Trade panel's Chart AI chats. Storage is
 * per active user in localStorage with a cap on HOW MANY chats (MAX_SESSIONS) so a
 * long-lived terminal
 * can't grow the blob forever. Pure module (no React, no network) so the
 * title/trim/validation rules are unit-testable.
 *
 * A session is either a SOLO chat (one selected model, optionally bound to a
 * roster bot persona) or a PANEL — up to PANEL_MAX_MODELS models that see
 * each other's turns and can message each other through the debate mailbox
 * while answering. Entries carry the rendering chrome the dock needs: the
 * model that spoke, its reasoning trace, tool-call lines and the model
 * side-effect rows (memory/skill/tool proposals) the transcript renders.
 */

import { readStore, writeStore, storeBackendKind } from '../infrastructure/storeBackend';
import { getActiveUsername } from '../../utils/activeUser';
import type { Message, ToolAction } from '../../types/message';
import { MessageRole } from '../../types/enums';
import type { ReasoningEffort, WireAuditEntry } from '../../types/provider';
import type { SessionTitleSource } from '../../types/trade';
import { messageTraceText } from '../../utils/traceText';

/** One turn in a session. `role` stays 'user' | 'ai' for storage
 *  compatibility; an ai entry may belong to one panel seat (speaker). */
export interface StoredChatEntry {
    id: string;
    role: 'user' | 'ai';
    text: string;
    /** Tool-call lines rendered as "▸ …" under the answer. */
    tools: string[];
    /** Panel sessions: which seat/model said this. */
    speaker?: string;
    /** Chain-of-thought trace (the dock's collapsible Thought row). */
    reasoning?: string;
    /** What the wire was actually asked, one entry per call. It is what lets
     *  the answer say WHY it has no trace. */
    wireAudit?: WireAuditEntry[];
    /** The turn failed, and this is the REAL reason. It is a row of its own,
     *  not the answer: a failed turn written into the text field reads as
     *  though the seat had said the app's own error hint. */
    error?: string;
    /** Model side-effects (proposals/writes) surfaced as status rows. */
    actions?: ToolAction[];
    /** Attached image (screenshot or upload) shown in the transcript,
     *  data URL, size-capped before storing. */
    image?: string;
    /** A BACKUP artifact, never a live value: `ExportService` strips image bytes
     *  from the exported copy (a 60-entry session can carry a 1.2 MB screenshot
     *  each) and leaves this stub in place so the transcript still says an image
     *  was there. The live key is never written with it. Read side keeps it
     *  verbatim — `sanitizeEntry` spreads the entry. */
    imageOmitted?: { bytes: number; mime: string };
    /** Harness row (level-watch price event, panel notices): rendered as a
     *  compact system line, never as a model answer. */
    notice?: boolean;
    /** Epoch-ms the entry was created. Memory attribution needs it: "which
     *  injections shaped this answer" is a window join over the injection log,
     *  and without a per-entry timestamp the window has no lower bound — which
     *  is why the citation strip could never be mounted. The upper bound comes
     *  from the NEXT entry's stamp, so a later run's injections cannot leak
     *  onto this answer. Optional: entries stored before this field existed
     *  simply show no strip rather than a wrong one. */
    at?: number;
    /** Wall-clock ms the ANSWERING work took — the "Analyzed for Ns" number,
     *  frozen when the turn settled so it survives a reload.
     *
     *  FIELD-LEVEL ASYMMETRY, deliberate: this lives on the ENTRY because
     *  `sanitizeEntry` (:145) spreads `...e`, so a new entry field survives
     *  `loadSessions` with NO loader change. A new SESSION field would not —
     *  `loadSessions` (:179-193) rebuilds every session field explicitly and
     *  would strip it on the next write. That is why the pin set for a
     *  `ChatSession` is stored in its own `agent_pins_v1_<user>` key instead.
     *  Optional so entries written before this existed simply show no
     *  duration rather than a wrong one. */
    workedMs?: number;
    /** One id per entry in `tools`, same order — the join key for the real
     *  payload behind that row (`toolPayloadStore`). '' (or missing) means the
     *  line has no payload: a `calling…`, an `already fetched this turn`, a guard
     *  line. Kept beside `tools` rather than inside it because the digest text is
     *  what the seat saw and the id is where the bytes are — two questions, and
     *  the renderer zips them by position. */
    toolIds?: string[];
    /** The thinking tier this answer was produced under — the RESOLVED tier
     *  the request went out with. It is a fact about the ANSWER, so it lives
     *  on the entry and survives a reload like `workedMs` does.
     *
     *  NOT the session's `effort`: that one is the composer's CURRENT setting
     *  (what the next turn will send), this one is the RECORD of what the
     *  turn that produced this row actually sent. Two answers in one session
     *  can carry different values, and that is the point — the trader can see
     *  that the tier changed under them.
     *
     *  ENTRY field, not a session one, for the same asymmetry reason: a new
     *  session field would be stripped by `loadSessions`' explicit rebuild on
     *  the next write, while a new entry field survives with no loader change. */
    effort?: ReasoningEffort;
    /** This run was interrupted (explicit Stop, or a failure mid-turn). An ENTRY
     *  field, not a session one, for the same asymmetry reason as `workedMs`: a
     *  new session field would be stripped by `loadSessions`' explicit rebuild on
     *  the next write, while a new entry field survives with no loader change.
     *  The row renders an in-flow "Run stopped" notice offering Edit prompt /
     *  Try again — a stopped turn is a half-written answer with no way forward,
     *  not a failure to be hidden. */
    interrupted?: boolean;
}

export type SessionKind = 'solo' | 'panel' | 'group';

/** A row stored before the Coach inbox left the dock can still say
 *  kind 'coach'; the loader drops those rather than reopening them as chats. */
type LegacySessionKind = SessionKind | 'coach';

/** One panel seat: a specific model inside a specific provider. */
export interface PanelSeatRef { providerId: string; modelId: string; botId?: string }

/** A conversation row projected into a dock session.
 *
 *  The persisted entry shape plus the one fact a stored blob never carries:
 *  whether the turn is still arriving. `chatStore.LiveEntry` is structurally the
 *  same thing; it is NOT imported here because the store imports THIS module,
 *  and a projection that reached back for its reader would be a cycle. */
export type ProjectedChatEntry = StoredChatEntry & { streaming?: boolean };

export interface ChatSession {
    id: string;
    title: string;
    /** WHO named this chat (see `SessionTitleSource`). Missing on legacy rows ⇒
     *  `'message'` — every title before this field existed came from the first
     *  message. A trader's rename stamps `'user'` and the model-title path
     *  refuses to overwrite it. A SESSION field, so `loadSessions` must carry
     *  it explicitly (see the field-level asymmetry note on `workedMs`). */
    titleSource?: SessionTitleSource;
    createdAt: number;
    updatedAt: number;
    entries: StoredChatEntry[];
    /** Missing on legacy rows ⇒ 'solo'. */
    kind?: SessionKind;
    /** Panel sessions: the seats (providerId + modelId), max PANEL_MAX_MODELS. */
    panelModels?: PanelSeatRef[];
    /** Solo sessions bound to a roster bot: the answer runs with the bot's
     *  persona + provider/model (the roster's thread carried INTO Chart AI). */
    botId?: string;
    /** Group-room sessions: the dock mirrors this AgentGroup's transcript. */
    groupId?: string;
    /** The Agents surface's conversation this session IS, when there is one.
     *
     *  `botId`/`groupId` already said "this session is a view of that roster
     *  thread"; a solo or panel session had no counterpart, so the SAME
     *  conversation opened in the other home was a different conversation.
     *  This is the id of the App conversation whose rows feed
     *  {@link entriesForSession} for that session. Unset ⇒ the session's own
     *  entries are the whole transcript, which is every row stored before this
     *  existed, so a reload cannot invent a merge the trader never had.
     *
     *  A SESSION field, so `loadSessions` must carry it explicitly — see the
     *  field-level asymmetry note on `workedMs`: the rebuild lists every
     *  session field on purpose, and a new one it omits is stripped on the next
     *  write. */
    conversationId?: string;
    /** Chart setup bound to this session — restored when the session is
     *  re-opened, so each chat keeps the instrument + interval it discussed.
     *  Missing on legacy rows ⇒ restore nothing (keep the current chart). */
    symbol?: string;
    interval?: string;
    /** The composer's thinking-effort choice for this session — THE shared
     *  value, since both chat homes now drive one dial from this row (the dock
     *  and the Agents surface). Typed as the tier union, not `string`: two
     *  readers casting the same field is how one surface ends up sending a
     *  tier the other never heard of. Absent ⇒ `'auto'` (the task default). */
    effort?: ReasoningEffort;
    /** Solo sessions: the model (providerId:modelId) this chat answers with. */
    soloModel?: string;
    /** Runtime-only open-trade ledger (chat store lives on this in memory,
     *  but the on-disk shape mirrors the field so a round-trip through
     *  saveSessions/loadSessions doesn't strip it). Cleared by the harness
     *  resolution site — never meaningful across reloads. */
    openTrades?: Record<string, import('./chatStore').OpenTradeRow>;
    /** Runtime-only list of every trade id ever logged from this session.
     *  Lives alongside openTrades for the same round-trip reason. */
    loggedTradeIds?: string[];
}

/** How many chats the dock keeps. This one STAYS (see MAX_STORED_CHARS for why
 *  the byte ceiling cannot go too): it is a structural bound on the blob, not a
 *  bound on what a turn stores. The per-chat ENTRY cap and the REASONING-TEXT
 *  cut that used to sit next to it were removed on 2026-10-27 under the owner's
 *  "store everything" ruling — a chat now holds every turn it was given, and
 *  every character of the trace that produced each one. */
export const MAX_SESSIONS = 12;
/**
 * The pinned-set cap. Derivation, not a magic number: MAX_SESSIONS (12) minus
 * 2, so the newest two UNPINNED sessions always survive a pin spree — the
 * chat the user just opened is never the one a pin evicts. A pin refused for
 * this cap says so in the rail (`SessionSaveNotice.pinsDropped`); it is never
 * silently dropped, because a pin that silently disappears is the feature
 * lying about itself.
 */
export const MAX_PINNED_SESSIONS = 10;

/** What a save did to the chats the user pinned. Returned so the rail can SAY
 *  it — an invisible trim is the silent-loss defect this store's doctrine
 *  exists to prevent. Null when nothing pinned was harmed. */
export interface SessionSaveNotice {
    /** Titles of pinned chats whose oldest entries were shaved to fit the byte
     *  cap — the LAST resort, taken only when nothing unpinned was left. */
    pinnedTrimmed: string[];
    /** Pinned ids that did not fit the pinned cap. */
    pinsDropped: string[];
}
/** The user asked for "max 5 models that talk to each other". */
export const PANEL_MAX_MODELS = 5;
const MAX_IMAGE_CHARS = 1_200_000;
const TITLE_MAX = 36;

export const storageKey = (): string => `trade_chat_sessions_v1_${getActiveUsername()}`;

export const createSession = (kind: SessionKind = 'solo', panelModels: PanelSeatRef[] = []): ChatSession => {
    const now = Date.now();
    return {
        id: `s-${now}-${Math.random().toString(36).slice(2, 8)}`,
        title: kind === 'panel' ? 'New panel' : 'New chat',
        titleSource: 'default',
        createdAt: now,
        updatedAt: now,
        entries: [],
        kind,
        panelModels: kind === 'panel' ? panelModels.slice(0, PANEL_MAX_MODELS) : undefined,
    };
};

/** Session title = the first user question, one line, no markdown noise. */
export const titleFromMessage = (text: string): string => {
    const line = (text.trim().split('\n')[0] || '').replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim();
    if (!line) return 'New chat';
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

const validToolAction = (a: unknown): a is ToolAction => {
    const v = a as ToolAction;
    return !!v && typeof v === 'object' && typeof v.tool === 'string' && typeof v.ok === 'boolean';
};

const validEntry = (e: unknown): e is StoredChatEntry => {
    const v = e as StoredChatEntry;
    return !!v && typeof v === 'object'
        && typeof v.id === 'string'
        && (v.role === 'user' || v.role === 'ai')
        && typeof v.text === 'string'
        && Array.isArray(v.tools)
        && v.tools.every(t => typeof t === 'string');
};

const sanitizeEntry = (e: StoredChatEntry): StoredChatEntry => ({
    ...e,
    // Every character of the trace is kept. This used to cut at 4000 chars
    // "so 60 long-thinking turns can't sink the blob" — which traded the one
    // thing the trader opens the row to read for a bound the byte budget below
    // already enforces honestly, at the blob level, and REPORTS (pinnedTrimmed).
    reasoning: typeof e.reasoning === 'string' && e.reasoning.trim() ? e.reasoning : undefined,
    actions: Array.isArray(e.actions) ? e.actions.filter(validToolAction).slice(0, 50) : undefined,
    image: typeof e.image === 'string' && e.image.startsWith('data:image/') && e.image.length <= MAX_IMAGE_CHARS ? e.image : undefined,
    notice: e.notice === true ? true : undefined,
});

const validSession = (s: unknown): s is ChatSession => {
    const v = s as ChatSession;
    return !!v && typeof v === 'object' && typeof v.id === 'string' && Array.isArray(v.entries);
};

const validPanelModel = (m: unknown): m is PanelSeatRef => {
    const v = m as { providerId?: unknown; modelId?: unknown };
    return !!v && typeof v.providerId === 'string' && typeof v.modelId === 'string';
};

const VALID_EFFORTS = new Set<ReasoningEffort>(['off', 'low', 'medium', 'high', 'max', 'auto']);

const VALID_TITLE_SOURCES = new Set<SessionTitleSource>(['default', 'message', 'model', 'user']);

/** A stored title source is only usable if it is one this build knows;
 *  anything else is dropped, which means "legacy row" (= the first-message
 *  fallback) rather than trusting a value no writer here produces. */
const isTitleSource = (v: unknown): v is SessionTitleSource =>
    typeof v === 'string' && VALID_TITLE_SOURCES.has(v as SessionTitleSource);

/** A stored tier is only usable if it is one of the wire tiers; anything else
 *  (a future tier written by a newer build) is dropped, which means `'auto'`,
 *  i.e. the task default — not a knob the transport has never seen. */
const isEffort = (v: unknown): v is ReasoningEffort =>
    typeof v === 'string' && VALID_EFFORTS.has(v as ReasoningEffort);

/**
 * The bytes a sync reader sees, primed once at boot.
 *
 * The dock's readers are synchronous (it hydrates from a snapshot) and the
 * desktop store is a file behind IPC, which is not. So index.tsx awaits
 * `primeChatSessions()` before mounting: one round trip, then every read below is
 * local. `undefined` means "not primed" and falls back to localStorage, which is
 * also the whole story on web.
 */
let primedRaw: string | null | undefined;
/** The user those bytes were read for. Serving them under another identity is
 *  how one profile's chats appeared in another's dock. */
let primedFor: string | null = null;

export const primeChatSessions = async (username = getActiveUsername()): Promise<void> => {
    primedFor = username;
    primedRaw = undefined;
    try {
        const res = await readStore(`trade_chat_sessions_v1_${username}`);
        if (primedFor !== username) return;
        if (res.ok) primedRaw = res.value;
    } catch {
        // Leave it unprimed: the localStorage path below still serves, and a boot
        // that cannot reach the file store must not fail to render.
    }
};

/** Read + validate + bound the stored list; any corruption yields []. */
export const loadSessions = (): ChatSession[] => {
    try {
        const raw = primedFor === getActiveUsername() && primedRaw !== undefined ? primedRaw : localStorage.getItem(storageKey());
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const now = Date.now();
        return parsed
            .filter(validSession)
            // The Coach inbox used to be a dock session (kind 'coach') holding
            // no transcript of its own. It is the Learning surface's tab now, so a
            // stored one drops rather than resurfacing as an empty chat.
            .filter(s => (s.kind as LegacySessionKind | undefined) !== 'coach')
            .map(s => ({
                id: s.id,
                title: typeof s.title === 'string' && s.title.trim() ? s.title : 'New chat',
                titleSource: isTitleSource(s.titleSource) ? s.titleSource : undefined,
                createdAt: Number.isFinite(s.createdAt) ? s.createdAt : now,
                updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now,
                kind: s.kind === 'panel' || s.kind === 'group' ? s.kind : 'solo' as const,
                panelModels: Array.isArray(s.panelModels) ? s.panelModels.filter(validPanelModel).slice(0, PANEL_MAX_MODELS) : undefined,
                botId: typeof s.botId === 'string' && s.botId ? s.botId : undefined,
                groupId: typeof s.groupId === 'string' && s.groupId ? s.groupId : undefined,
                conversationId: typeof s.conversationId === 'string' && s.conversationId ? s.conversationId : undefined,
                symbol: typeof s.symbol === 'string' && s.symbol.trim() ? s.symbol.toUpperCase() : undefined,
                interval: typeof s.interval === 'string' && s.interval.trim() ? s.interval : undefined,
                effort: isEffort(s.effort) ? s.effort : undefined,
                soloModel: typeof s.soloModel === 'string' && s.soloModel ? s.soloModel : undefined,
                entries: s.entries.filter(validEntry).map(sanitizeEntry),
            }));
    } catch {
        return [];
    }
};

const pinnedSet = (pinnedIds: readonly string[]): ReadonlySet<string> =>
    new Set(pinnedIds.filter((id): id is string => typeof id === 'string' && !!id));

/**
 * The COUNT cap, pin-aware. `slice(-MAX_SESSIONS)` used to drop the oldest
 * sessions outright — after pinning, precisely the chats the user chose to
 * keep. Now: every pinned session survives (up to {@link MAX_PINNED_SESSIONS},
 * newest-first when there are somehow more), filled out with the newest
 * unpinned sessions up to MAX_SESSIONS.
 *
 * `pinnedIds` is the CALLER's pin source — the `agent_pins_v1_<user>` rail.
 * This store does not reach into another module's key namespace.
 */
const fitToMaxSessions = (
    sessions: ChatSession[],
    pinned: ReadonlySet<string>,
): { sessions: ChatSession[]; pinsDropped: string[] } => {
    const sanitized = sessions.map(s => ({ ...s, entries: s.entries.filter(validEntry).map(sanitizeEntry) }));
    let keptPins = sanitized.filter(s => pinned.has(s.id));
    let pinsDropped: string[] = [];
    if (keptPins.length > MAX_PINNED_SESSIONS) {
        // Keep the most-recently-updated pins; the stalest pins are the ones
        // the user is least likely to come back to.
        const ordered = [...keptPins].sort((a, b) => b.updatedAt - a.updatedAt);
        keptPins = ordered.slice(0, MAX_PINNED_SESSIONS);
        pinsDropped = ordered.slice(MAX_PINNED_SESSIONS).map(s => s.id);
    }
    const room = Math.max(0, MAX_SESSIONS - keptPins.length);
    const unpinned = sanitized.filter(s => !pinned.has(s.id));
    const keptUnpinned = unpinned.slice(Math.max(0, unpinned.length - room));
    const keptIds = new Set([...keptPins, ...keptUnpinned].map(s => s.id));
    // Preserve the incoming oldest-first order — the byte passes below
    // sacrifice in that order, and re-sorting here would change which chat is
    // "oldest" for reasons that have nothing to do with the chat.
    return { sessions: sanitized.filter(s => keptIds.has(s.id)), pinsDropped };
};

/**
 * A COUNT cap is not a SIZE cap, and this store needs both.
 *
 * 12 sessions × 60 entries is unbounded in bytes: `MAX_IMAGE_CHARS` lets a single
 * entry carry 1.2 MB, so the list can ask for hundreds of megabytes against a
 * ~5 MB origin quota. The quota is SHARED — on web this store IS `localStorage`
 * (see `PreferencesService`), so one fat chat makes every other store's write
 * throw too, while the transcript still looks saved in memory. The count trim
 * above could never catch that, because 3 sessions full of screenshots is already
 * under it.
 *
 * Trim in the order that costs the trader least: oldest screenshots first (the
 * TEXT of that exchange survives — a chart image can be re-taken, a past
 * argument cannot), then entries past the count cap, then whole oldest
 * sessions. PINNED sessions are skipped by passes 2 and 3 — and when nothing
 * unpinned is left to lose, the last resort shaves the oldest PINNED chat and
 * reports it, because "never touch a pinned chat" with no last resort
 * dead-ends at a throwing setItem that loses the live transcript instead.
 */
export const MAX_STORED_CHARS = 3_500_000;

/**
 * The budget that actually applies. 3.5 MB is a BROWSER number — it exists so a
 * shared ~5 MiB origin quota is never spent on one store. A desktop file has no
 * such neighbour, so the same rule buys ~7x the history before it trims, and the
 * per-file ceiling in electron/storeFs.cjs is still far above it.
 */
export const storedCharsBudget = (): number =>
    storeBackendKind() === 'desktop-files' ? 24_000_000 : MAX_STORED_CHARS;

const serialized = (sessions: ChatSession[]): string => {
    try {
        return JSON.stringify(sessions);
    } catch {
        // A cycle cannot be built by these readers, but a throw here must not
        // become a lost transcript: an empty string trims everything, and the
        // caller still has the in-memory copy.
        return '';
    }
};

const fitToByteBudget = (
    sessions: ChatSession[],
    pinned: ReadonlySet<string>,
): { sessions: ChatSession[]; pinnedTrimmed: string[] } => {
    let size = serialized(sessions).length;
    if (size <= storedCharsBudget()) return { sessions, pinnedTrimmed: [] };
    // Work on copies; sessions and entries are ordered oldest first, which is
    // the order both passes sacrifice in.
    const work: ChatSession[] = sessions.map(s => ({ ...s, entries: s.entries.map(e => ({ ...e })) }));

    // Pass 1 — drop the oldest screenshot, one at a time. The words of that
    // exchange stay: an image can be re-taken, a past argument cannot. A PIN is
    // no reason to keep a screenshot; the pin protects the conversation, and
    // this pass keeps every word of it.
    //
    // Size is tracked by SUBTRACTING each removed image rather than re-serializing
    // the whole list per drop: a base64 payload escapes identically inside JSON, so
    // the arithmetic is exact where it matters, and re-measuring a half-gigabyte
    // blob once per image is what made this loop unusable.
    for (const s of work) {
        for (const e of s.entries) {
            if (size <= storedCharsBudget()) return { sessions: work, pinnedTrimmed: [] };
            if (!e.image) continue;
            size -= e.image.length + '"image":'.length + 2;
            e.image = undefined;
        }
    }

    // Pass 2 — shave the oldest transcripts, newest entries first, down to ten.
    // A pinned session is never the one shaved here.
    for (const s of work) {
        if (size <= storedCharsBudget()) break;
        if (pinned.has(s.id)) continue;
        if (s.entries.length <= 10) continue;
        const removed = s.entries.slice(0, s.entries.length - 10);
        s.entries = s.entries.slice(-10);
        size -= removed.reduce((n, e) => n + (e.text?.length ?? 0) + e.id.length + 24, 0);
    }

    // Pass 3 — whole oldest conversations, but never a PINNED one, and never
    // the last session standing.
    while (size > storedCharsBudget() && work.length > 1) {
        const idx = work.findIndex(s => !pinned.has(s.id));
        if (idx < 0) break;
        const gone = work.splice(idx, 1)[0];
        size -= gone.entries.reduce((n, e) => n + (e.text?.length ?? 0) + e.id.length + 24, 0);
    }

    // Last resort — every remaining session is pinned and the store is STILL
    // over. Shave the oldest pinned chat's oldest entries (it keeps its newest
    // ten, never wiped whole) and RECORD it, so the rail can say a pinned chat
    // was trimmed. Silent here is the failure this whole path exists to avoid.
    const pinnedTrimmed: string[] = [];
    if (size > storedCharsBudget()) {
        for (const s of work) {
            if (size <= storedCharsBudget()) break;
            if (s.entries.length <= 10) continue;
            const removed = s.entries.slice(0, s.entries.length - 10);
            s.entries = s.entries.slice(-10);
            size -= removed.reduce((n, e) => n + (e.text?.length ?? 0) + e.id.length + 24, 0);
            pinnedTrimmed.push(s.title);
        }
    }
    return { sessions: work, pinnedTrimmed };
};

/** Strip every image — the retry that keeps a transcript saving at all. */
const withoutAnyImages = (sessions: ChatSession[]): ChatSession[] =>
    sessions.map(s => ({ ...s, entries: s.entries.map(e => (e.image ? { ...e, image: undefined } : e)) }));

/**
 * Persist the chat list. `pinnedIds` is the caller's pin source
 * (`agent_pins_v1_<user>`, bare ids); sessions in it are never the ones the
 * byte budget sacrifices, and anything the budget DID cost a pinned chat is
 * RETURNED, not logged — the rail needs it to say so. Returns null when
 * nothing pinned was harmed.
 */
export const saveSessions = (sessions: ChatSession[], pinnedIds: readonly string[] = []): SessionSaveNotice | null => {
    const key = storageKey();
    const pinned = pinnedSet(pinnedIds);
    const { sessions: capped, pinsDropped } = fitToMaxSessions(sessions, pinned);
    const { sessions: trimmed, pinnedTrimmed } = fitToByteBudget(capped, pinned);
    const notice = (): SessionSaveNotice | null =>
        pinsDropped.length > 0 || pinnedTrimmed.length > 0 ? { pinsDropped, pinnedTrimmed } : null;
    // ONE write path, whichever store is behind it. `writeStore` writes the file
    // on desktop (recording a failure and keeping a localStorage copy when the
    // file write is refused) and is localStorage-only on web; it RESOLVES, so this
    // stays the fire-and-forget call the callers already had. The payload is also
    // primed, so a later sync read inside this session sees what was just saved.
    const payload = serialized(trimmed);
    primedRaw = payload;
    void writeStore(key, payload).then(async res => {
        if (res.ok) return;
        // The transcript is worth more than its screenshots: retry without them
        // before accepting a loss, and say which of the two happened.
        const smaller = serialized(withoutAnyImages(trimmed));
        if (smaller === payload) {
            console.error('[chatSessions] transcript NOT persisted:', res.error);
            return;
        }
        const retry = await writeStore(key, smaller);
        if (retry.ok) {
            primedRaw = smaller;
            console.warn('[chatSessions] saved without screenshots after a failed write');
        } else {
            console.error('[chatSessions] transcript NOT persisted:', retry.error);
        }
    }).catch(() => { /* writeStore resolves; belt and braces */ });
    return notice();
};

/**
 * One history row, as a transcript entry.
 *
 * WHY THIS EXISTS. A bot's conversation lives in App's `messages` (that is what
 * the Chat rail renders, and what the Journal, the analyses gallery and the
 * learning loop all read). The Chart AI dock renders a `chatStore` session. So
 * "Open in Chart AI" used to create an EMPTY session for that bot and quietly
 * drop the entire conversation the trader had just built — the button implied
 * continuity and delivered a blank page.
 *
 * This converts the Chat rail's rows into the shape the dock stores, so a bot
 * session opened in the dock can be seeded with the history it should have
 * inherited. It is a ONE-WAY projection by design: the dock continues the
 * conversation with its own richer transport (streaming, desk tools, reasoning
 * rows, key levels) rather than replaying the Chat's. {@link entriesForSession}
 * is the other half — the single merge that makes both homes read ONE thread.
 */
export const liveEntryFromMessage = (m: Message): ProjectedChatEntry => {
    const trace = messageTraceText(m);
    const at = m.createdAt ? Date.parse(m.createdAt) : NaN;
    // The trail, one line per entry. `liveToolEvents` is the capped,
    // newline-JOINED live feed — read as a list it is ONE row holding every
    // line, so the dock's projection of a Chat row drew one giant tool row
    // and never paired a call with its result.
    const liveFeed = Object.values(m.liveToolEvents ?? {})
        .flatMap(feed => feed.split('\n'))
        .filter(line => line.trim().length > 0);
    const trail = m.toolEvents && m.toolEvents.length > 0 ? m.toolEvents : liveFeed;
    return {
        id: m.id,
        role: m.role === MessageRole.USER ? 'user' : 'ai',
        text: m.text || '',
        tools: trail,
        /** The turn is still arriving.
         *
         *  This is the fact that made the two homes disagree rather than
         *  differ: a Chat-surface run was already mirrored into the dock row by
         *  row, but the row carried no `streaming`, so crossing over mid-answer
         *  showed a FINISHED reply that had no work card, no live text and no
         *  Stop — and the next token then rewrote it under the trader's eyes.
         *  `Message.isStreaming` is the pipeline's own truth, written when the
         *  run starts and cleared when it settles, so the dock reads it rather
         *  than re-deriving "is anything running" from a timer. */
        streaming: !!m.isStreaming,
        // Left unset on purpose: the dock stamps the answering seat from the
        // session's own bot, so a stale name here would fight it.
        speaker: undefined,
        reasoning: trace.length > 0 ? trace : undefined,
        wireAudit: m.wireAudit,
        error: m.error,
        // A Chat-surface run that stopped mid-turn keeps the fact when the row
        // is read in the dock; without it the dock drew a finished-looking
        // short answer and no recovery card.
        interrupted: m.interrupted,
        actions: m.toolActions,
        // `proposal` is deliberately NOT projected. The dock keeps its card on the
        // RUNTIME entry only (`chatStore.LiveEntry`, not `StoredChatEntry`) so a
        // presented plan never rides the byte-capped session blob — and a plan
        // presented on the Agents surface renders from its canonical
        // `Message.proposal` THERE. One card per plan, in the home that asked for
        // it; the disposition both homes consult is keyed by the shared row id.
        image: m.images?.[0],
        // The pipeline path's frozen work time, so a dock row built from a
        // pipeline Message still shows its "Analyzed for Ns" after a reload.
        // Only the Chat rail writes `runStats` (useBotMailbox) —
        // the dock stamps `workedMs` directly on the entry, so an undefined
        // here is normal for a dock-native turn, not a missing value.
        workedMs: typeof m.runStats?.durationMs === 'number' ? m.runStats.durationMs : undefined,
        // …and the tier it was produced under, for the same reason: a row
        // opened in the dock from a Chat-surface conversation keeps the fact
        // that the answer was produced under a different tier.
        effort: m.runStats?.effort,
        // …and the payload ids, so the dock's rows can open onto the real
        // output for a turn the Agents surface answered.
        toolIds: m.toolIds,
        // A row with an unparseable timestamp keeps `at` undefined rather than
        // stamping it as 0: the memory-attribution window join treats a real
        // stamp as meaningful and 0 as noise.
        at: Number.isFinite(at) ? at : undefined,
    };
};

/**
 * THE ONE MERGE — one thread, whichever home it is read from.
 *
 * Both homes write, and that is not going to change: the dock's turn runner
 * streams into a session's `entries` (~40 write sites in `chatTurnRunner.ts`,
 * each with tool lines, reasoning traces and a streaming flag), while the Chat
 * surface's turns settle into App `messages` — the record the Journal, the
 * analyses gallery and the learning loop read, and the only one rich enough to
 * carry `analysis`, `planId`, `debateTurns` and `runStats`. Replacing either
 * writer with the other would cost the dock its streaming state or the trader
 * their verdict cards.
 *
 * So the thread is a READ model over both, keyed by id, and the id is the trick
 * that makes two writers safe: `liveEntryFromMessage` keys a projected row by
 * `m.id`, and the `present_trade` path already writes the dock entry under the
 * SAME id as the conversation Message (`chatStore.findSessionByEntryId`), so a
 * turn that exists twice is one row here, not a duplicate. That is also why
 * this must be the only merge in the app — a second one would be a second
 * answer to "what did we say", which is the split this closes.
 *
 * Rules, inherited from the merge this replaces in `TradeChatPanel`:
 *  - canonical rows first, in conversation order;
 *  - a local row whose id already exists REPLACES it (the settling turn carries
 *    the dock's richer chrome), never appends — appending is what made every
 *    exchange appear twice;
 *  - a local row with no canonical counterpart joins at the end: a chart-side
 *    tool round, a harness notice, or the answer still streaming, which reaches
 *    `messages` only once it settles.
 *
 * `canonical` undefined ⇒ the session has no counterpart and its own entries
 * are the whole transcript. That is a chart-side session with no
 * `conversationId` — a conversation of its own, with its own tool rounds and
 * key levels — so a reload can never invent a merge the trader never had.
 */
export const entriesForSession = (
    local: ProjectedChatEntry[],
    canonical: readonly Message[] | undefined,
): ProjectedChatEntry[] => {
    if (!canonical) return local;
    const rows: ProjectedChatEntry[] = canonical.map(liveEntryFromMessage);
    const known = new Set(rows.map(e => e.id));
    for (const e of local) {
        const at = rows.findIndex(m => m.id === e.id);
        if (at >= 0) rows[at] = e;
        else if (!known.has(e.id)) rows.push(e);
    }
    return rows;
};
