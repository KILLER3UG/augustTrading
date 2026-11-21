/**
 * autonomySettings — the LIGHT half of the autonomy engine: mode/seat/role
 * settings, the background-call budget + provider backoff, the seat resolver
 * and the UI snapshot store. Deliberately separate from
 * `autonomyEngine.ts` (the loops) so the UI can subscribe to the snapshot
 * without pulling the loop machinery into the eager startup graph (the CI
 * entry-chunk ratchet).
 */

import { getActiveUsername } from '../../utils/activeUser';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';

// ── Guardrail constants ──────────────────────────────────────────────────────

export const MAX_BACKGROUND_CALLS_PER_HOUR = 24;
export const SENTINEL_SYMBOL_COOLDOWN_MS = 90_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Active `origin:'agent'` shapes allowed per symbol before the hygiene pass
 *  expires the oldest. Deliberately small: AI sketches are annotations, not a
 *  second tape. */
export const MAX_ACTIVE_AGENT_DRAWINGS = 8;
/** The maintenance pass runs at most this often, and only when this many new
 *  resolutions accumulated since the last one. */
export const MAINTENANCE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAINTENANCE_MIN_NEW_RESOLUTIONS = 3;
/** The chart-hygiene pass is throttled per symbol (it runs on the ~1s tick). */
export const AGENT_HYGIENE_INTERVAL_MS = 60_000;

const SETTINGS_KEY_PREFIX = 'autonomy_settings_v1_';
const CALLS_KEY_PREFIX = 'autonomy_calls_v1_';
export const MAINTENANCE_KEY_PREFIX = 'autonomy_maintenance_v1_';

export type AutonomyMode = 'autonomous' | 'paused';

export type AutonomyRole = 'sentinel' | 'compaction' | 'maintenance' | 'adversary';

export interface AutonomySettings {
    mode: AutonomyMode;
    /** Optional DEFAULT background seat: `providerId::modelId`. Empty = the
     *  first ready provider (the same resolution every background job uses). */
    seat?: string;
    /** Optional PER-ROLE overrides, tried before `seat`: route the fast
     *  triage loops (sentinel/compaction/maintenance) to a lightweight/local
     *  seat while reserving the frontier model for the adversary review.
     *  Absent for a role = fall back to `seat`. */
    seats?: Partial<Record<AutonomyRole, string>>;
}

export interface AutonomySnapshot {
    mode: AutonomyMode;
    seat?: string;
    roleSeats: Partial<Record<AutonomyRole, string>>;
    /** Background model calls in the trailing hour. */
    callsLastHour: number;
    /** Epoch ms until which every model call is refused (provider backoff). */
    backoffUntil: number | null;
    lastMaintenanceAt: number | null;
}

// ── Settings (mode + seat) ───────────────────────────────────────────────────

const listeners = new Set<() => void>();
const settingsCache: Record<string, AutonomySettings> = {};

const settingsKey = (username: string): string => `${SETTINGS_KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const readSettings = async (username: string): Promise<AutonomySettings> => {
    const user = (username || 'default').trim() || 'default';
    if (settingsCache[user]) return settingsCache[user];
    try {
        const raw = await getPreferenceObject<AutonomySettings>(settingsKey(user));
        const settings: AutonomySettings = {
            mode: raw?.mode === 'paused' ? 'paused' : 'autonomous',
            ...(typeof raw?.seat === 'string' && raw.seat ? { seat: raw.seat } : {}),
        };
        settingsCache[user] = settings;
        return settings;
    } catch {
        const settings: AutonomySettings = { mode: 'autonomous' };
        settingsCache[user] = settings;
        return settings;
    }
};

const writeSettings = async (username: string, settings: AutonomySettings): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    settingsCache[user] = settings;
    try { await setPreferenceObject(settingsKey(user), settings); } catch { /* mode still applies this session */ }
    emit();
};

export const subscribeAutonomy = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

// useSyncExternalStore requires a REFERENTIALLY STABLE snapshot: a fresh
// object per getSnapshot call re-renders forever ("maximum update depth
// exceeded"). Cache it and invalidate on every emit.
let snapshotCache: AutonomySnapshot | null = null;
const emit = (): void => {
    snapshotCache = null;
    for (const fn of [...listeners]) fn();
};

/** Boot-time hydrate (the UI and loops read the cache synchronously). */
export const initAutonomy = async (username: string = getActiveUsername()): Promise<void> => {
    await readSettings(username);
    emit();
};

export const getAutonomyMode = (username: string = getActiveUsername()): AutonomyMode =>
    settingsCache[(username || 'default').trim() || 'default']?.mode ?? 'autonomous';

export const getAutonomySnapshot = (username: string = getActiveUsername()): AutonomySnapshot => {
    if (snapshotCache) return snapshotCache;
    const user = (username || 'default').trim() || 'default';
    const settings = settingsCache[user] ?? { mode: 'autonomous' as AutonomyMode };
    snapshotCache = {
        mode: settings.mode,
        ...(settings.seat ? { seat: settings.seat } : {}),
        roleSeats: settings.seats ?? {},
        callsLastHour: callsLastHour(user),
        backoffUntil: backoffUntil > Date.now() ? backoffUntil : null,
        lastMaintenanceAt: maintenanceStamp(user),
    };
    return snapshotCache;
};

export const setAutonomyMode = async (mode: AutonomyMode, username: string = getActiveUsername()): Promise<void> => {
    const settings = await readSettings(username);
    await writeSettings(username, { ...settings, mode });
};

export const setAutonomySeat = async (seat: string | undefined, username: string = getActiveUsername()): Promise<void> => {
    const settings = await readSettings(username);
    await writeSettings(username, { ...settings, ...(seat ? { seat } : {}) });
};

export const setAutonomyRoleSeat = async (role: AutonomyRole, seat: string | undefined, username: string = getActiveUsername()): Promise<void> => {
    const settings = await readSettings(username);
    const seats = { ...(settings.seats ?? {}) };
    if (seat) seats[role] = seat;
    else delete seats[role];
    await writeSettings(username, { ...settings, seats });
};

// ── Budget + backoff ─────────────────────────────────────────────────────────

let callTimestamps: Record<string, number[]> = {};

let backoffUntil = 0;
let backoffStage = 0;

const callsKey = (username: string): string => `${CALLS_KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

const loadCalls = async (username: string): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    if (callTimestamps[user]) return;
    try {
        const raw = await getPreferenceObject<{ calls?: number[] }>(callsKey(user));
        callTimestamps[user] = Array.isArray(raw?.calls) ? raw!.calls! : [];
    } catch {
        callTimestamps[user] = [];
    }
};

const callsLastHour = (user: string, now = Date.now()): number =>
    (callTimestamps[user] ?? []).filter(t => now - t < 60 * 60 * 1000).length;

export const recordCall = async (username: string = getActiveUsername(), now = Date.now()): Promise<void> => {
    const user = (username || 'default').trim() || 'default';
    await loadCalls(username);
    callTimestamps[user] = [...(callTimestamps[user] ?? []), now].slice(-200);
    try { await setPreferenceObject(callsKey(user), { calls: callTimestamps[user] }); } catch { /* budget still applies in memory */ }
    emit();
};

export const noteProviderError = (): void => {
    backoffStage = Math.min(backoffStage + 1, 6);
    backoffUntil = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** backoffStage, BACKOFF_MAX_MS);
    emit();
};

export const noteProviderSuccess = (): void => {
    backoffStage = 0;
    backoffUntil = 0;
};

export const maintenanceStamp = (user: string): number | null => {
    const raw = maintenanceCache[user];
    return typeof raw === 'number' ? raw : null;
};
let maintenanceCache: Record<string, number | null> = {};

export const setMaintenanceStamp = (user: string, at: number): void => { maintenanceCache = { ...maintenanceCache, [user]: at }; };

/** Test hook: saturate the background-call budget for one user. */
export const __forceBudgetForTests = (username: string = getActiveUsername()): void => {
    const user = (username || 'default').trim() || 'default';
    const now = Date.now();
    callTimestamps[user] = Array.from({ length: MAX_BACKGROUND_CALLS_PER_HOUR }, (_, i) => now - i * 1000);
};
export const resetAutonomySettingsForTests = (): void => {
    maintenanceCache = {};
    callTimestamps = {};
    backoffUntil = 0;
    backoffStage = 0;
};

/**
 * The ONE gate every background model call passes. Returns a reason string
 * when the call must NOT run (the loop then degrades to deterministic or
 * skips), or null when the budget allows it.
 */
export const backgroundCallRefusal = async (
    username: string = getActiveUsername(),
    now = Date.now(),
): Promise<string | null> => {
    const mode = await readSettings(username);
    if (mode.mode === 'paused') return 'paused';
    if (backoffUntil > now) return `backoff_${Math.ceil((backoffUntil - now) / 1000)}s`;
    await loadCalls(username);
    const user = (username || 'default').trim() || 'default';
    if (callsLastHour(user, now) >= MAX_BACKGROUND_CALLS_PER_HOUR) return 'budget_exhausted';
    return null;
};

// ── Seat resolution (the ONE provider seam) ──────────────────────────────────

export interface BackgroundSeat {
    config: import('../../types/provider').ProviderConfig;
    complete: (prompt: string, system?: string, options?: { maxTokens?: number; temperature?: number }) => Promise<string>;
}

/**
 * Resolve the seat a background loop runs on: the explicit override when one
 * is configured, else the first READY provider — the same resolution the
 * compaction job and the memory hygiene pass use. No provider, no autonomy
 * model calls; every loop's deterministic path still runs.
 */
export const resolveBackgroundSeat = async (username: string = getActiveUsername(), role?: AutonomyRole): Promise<BackgroundSeat | null> => {
    try {
        const [{ loadProviderConfigs, getReadyProviders }, { getQuickResponse }] = await Promise.all([
            import('../infrastructure/ProviderConfigService'),
            import('../providers/GenericProviderService'),
        ]);
        const configs = await loadProviderConfigs();
        const ready = getReadyProviders(configs);
        const settings = await readSettings(username);
        let config = ready[0];
        // PER-ROLE ROUTING (dsh pattern): the role's own override wins, then
        // the default background seat, then the first ready provider. A role
        // entry may be '' to PIN a role to the default (e.g. force the
        // adversary onto the frontier model while everything else routes to a
        // local seat).
        const roleSeat = role ? settings.seats?.[role] : undefined;
        const wanted = roleSeat !== undefined ? roleSeat : settings.seat;
        if (wanted) {
            const [providerId, ...modelParts] = wanted.split('::');
            const modelId = modelParts.join('::');
            const found = ready.find(c => c.id === providerId && (!modelId || c.selectedModel === modelId));
            if (found) config = found;
        }
        if (!config) return null;
        return {
            config,
            complete: (prompt, system, options) => getQuickResponse(config, prompt, system, {
                maxTokens: options?.maxTokens ?? 700,
                temperature: options?.temperature ?? 0.2,
            }),
        };
    } catch {
        return null;
    }
};


