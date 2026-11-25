
import {
    DEFAULT_SESSION_GUARD,
    FTMO_SESSION_GUARD,
    SessionGuardConfig,
} from '../services/validation/SessionGuardService';
import type { OutcomeSettlement } from './outcomeSettlement';
import type { SelfModMode } from '../schemas/selfChange';

export const RISK_CONSTITUTION_MAX_CHARS = 1200;

export interface HarnessSettings {
    equityUsd: number;
    riskPercent: number;
    /** New sessions and tickets start here. The old app-wide default was 100×,
     *  which makes a 1 % wick a total loss; this is the trader's setting now,
     *  defaulted to 10×. Historical rows keep the leverage they were stamped
     *  with (`LEGACY_LEVERAGE` covers a row that never did). */
    defaultLeverage: number;
    /** Refuse a plan whose net expectancy at its own probability is at or
     *  below this, in R. 0 refuses only negative/zero edge; the trader can
     *  demand a positive floor. The card names the number it refused on. */
    minEdgeR: number;
    /** Analysts may call live desk tools (search, derivatives, session) before the brief. Default on. */
    deskToolsEnabled: boolean;
    /** Session-guard preset: 'default' = research-tight
     *  (2%/2 trades/2-streak/4h), 'ftmo' = the looser alternative
     *  (3%/3 trades). Individual overrides win over the preset. */
    guardPreset?: 'default' | 'ftmo';
    guardDailyLossPct?: number;
    guardMaxTradesPerDay?: number;
    guardPostLossCooldownMin?: number;
    /** Consecutive losses that trigger the streak pause. 0 disables it —
     *  the preset's research-tight 2 is the shipped default, and the card
     *  path (a risk change) is the agent's way to propose a different one. */
    guardStreakPause?: number;
    /** The trader's RISK CONSTITUTION — their own immutable-for-the-model
     *  rule sheet, injected verbatim into the frozen session prefix. Written
     *  ONLY by the trader in Settings (autonomous memory/post-mortem writers
     *  are structurally unable to touch harness settings); length-capped so
     *  one paste cannot bloat every future prefix. */
    riskConstitution?: string;
    /** Composer speed dial (port of Minara's Fast/Quality toggle):
     *  'quality' (default) = the built-in role→effort schedule; 'fast' =
     *  one step down on every reasoning task (verdicts still reason, just
     *  less; quick tiers never drop below low). Never affects what the
     *  pipeline DOES — only how hard each call thinks. */
    responseEffort: 'fast' | 'quality';
    /** Whether a SENSITIVE-category fact (health/finances/identity, per
     *  utils/memoryWriteFilters) may be stored at all. Default OFF — a
     *  sensitive fact is refused until the trader opts in, and the write is
     *  flagged `sensitive` so recall and pre-reads keep it contained. */
    sensitiveMemoryEnabled: boolean;
    /** What happens when the autopilot detects an outcome: record it after a
     *  15s Undo window, only notify, or the shadow month (show, never record).
     *  Per-coin approval rules still win over this. */
    outcomeSettlement: OutcomeSettlement;
        /**
     * How much the agent may change the harness it is running in, mid-task.
     *
     * 'off' — nothing. Every self-change tool refuses; the ledger still reads.
     * 'config' — reversible BEHAVIOR knobs (thinking speed, library cap). Each
     *             one applies now and auto-reverts when its window closes, so a
     *             mid-task speed-up cannot become a permanent drift.
     * 'shadow' — additionally what the model is TOLD (prompt overrides), which
     *             only earns its place after settled trades rate it above the
     *             built-in text it replaced.
     *
     * OFF by default and owner-only: no desk tool may write this key, so the
     * agent cannot grant itself the capability it is being refused. Opt-IN is
     * deliberate too.
     */
    selfModificationMode: SelfModMode;
    /** Post-turn background learning pass (Hermes-style four signals).
     *  Writes ONLY USER.md/MEMORY.md entries or probation skills, receipted
     *  and reversible. Default ON; the trader can switch it off here. */
    backgroundReviewEnabled: boolean;
    /** Periodic "Dream" consolidation of USER.md/MEMORY.md (>= 24h + >= 5 new
     *  sessions, or a manual trigger). Default ON. */
    memoryDreamEnabled: boolean;
    /** Automatically fold completed multi-tool turn timelines into one summary row. Default ON. */
    autoFoldTools: boolean;
    /** Default Enter action while a turn is actively streaming: steer mid-turn or queue for next turn. */
    sendWhileRunning: 'steer' | 'queue';
}

const KEY = 'harness_settings_v1';

const read = (): Partial<HarnessSettings> => {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Partial<HarnessSettings>;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

// Cached snapshot keyed by serialized localStorage value so useSyncExternalStore
// receives referential equality across renders when settings have not changed.
let cachedRawSnapshot: string | null | undefined = undefined;
let cachedSettingsSnapshot: HarnessSettings | null = null;

export const getHarnessSettings = (): HarnessSettings => {
    let raw: string | null = null;
    try {
        raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    } catch {
        raw = null;
    }
    if (cachedSettingsSnapshot && raw === cachedRawSnapshot) {
        return cachedSettingsSnapshot;
    }
    const stored = raw ? read() : {};
    const snapshot: HarnessSettings = {
        // 0 means "not configured" — sizing and the session guard fail closed
        // on it. The old $10,000 stand-in here made every downstream number
        // look authoritative for a user who never set an account.
        equityUsd: typeof stored.equityUsd === 'number' && stored.equityUsd > 0 ? stored.equityUsd : 0,
        riskPercent: typeof stored.riskPercent === 'number' && stored.riskPercent > 0
            ? Math.min(10, Math.max(0.1, stored.riskPercent))
            : 1,
        defaultLeverage: typeof stored.defaultLeverage === 'number' && Number.isFinite(stored.defaultLeverage)
            ? Math.min(125, Math.max(1, Math.round(stored.defaultLeverage)))
            : 10,
        // Default 0: refuse only a plan whose edge is not positive. A trader
        // who wants a margin raises it; nothing else interprets the number.
        minEdgeR: typeof stored.minEdgeR === 'number' && Number.isFinite(stored.minEdgeR)
            ? Math.min(5, Math.max(-5, stored.minEdgeR))
            : 0,
        deskToolsEnabled: stored.deskToolsEnabled !== false,
        guardPreset: stored.guardPreset === 'ftmo' ? 'ftmo' : stored.guardPreset === 'default' ? 'default' : undefined,
        guardDailyLossPct: typeof stored.guardDailyLossPct === 'number' && stored.guardDailyLossPct > 0 ? stored.guardDailyLossPct : undefined,
        guardMaxTradesPerDay: typeof stored.guardMaxTradesPerDay === 'number' && stored.guardMaxTradesPerDay >= 1 ? stored.guardMaxTradesPerDay : undefined,
        guardPostLossCooldownMin: typeof stored.guardPostLossCooldownMin === 'number' && stored.guardPostLossCooldownMin >= 0 ? stored.guardPostLossCooldownMin : undefined,
        guardStreakPause: typeof stored.guardStreakPause === 'number' && stored.guardStreakPause >= 0 && stored.guardStreakPause <= 20
            ? Math.floor(stored.guardStreakPause) : undefined,
        responseEffort: stored.responseEffort === 'fast' ? 'fast' : 'quality',
        // Both opt-OUT only on an explicit false: an absent key is the shipped
        // default, and a default that silently disabled the shelf or the veto would
        // read as the app losing its rules.
        sensitiveMemoryEnabled: stored.sensitiveMemoryEnabled === true,
        // Shadow first (E-18): resolve and SHOW every detected outcome, record
        // nothing. The trader flips to 'automatic' after the disagreement rate
        // between the detector and their own confirmation is known. Choosing
        // 'automatic' here by default would skip the plan's safety month.
        outcomeSettlement: stored.outcomeSettlement === 'automatic' || stored.outcomeSettlement === 'confirm'
            ? stored.outcomeSettlement
            : 'shadow',
        // Opt-IN, and the only rail on self-modification: an absent or
        // malformed value means the agent may change nothing about its own
        // harness. 'config' is the only open level; a stored 'shadow' fails
        // to 'off' with the tier it belonged to (O-148).
        selfModificationMode: stored.selfModificationMode === 'config'
            ? stored.selfModificationMode
            : 'off',
        // Pass-1 agent-driven learning, both opt-OUT only on an explicit false
        // (the shipped default is ON — the passes are receipted, reversible and
        // restricted to memory/skill_manage, so an absent key must not read as
        // the app losing its learning loop):
        //  - backgroundReviewEnabled: the post-turn pass that detects the four
        //    learning signals and may write USER.md / MEMORY.md or create a
        //    PROBATION skill. Never touches the ledger, trades or code.
        //  - memoryDreamEnabled: the periodic consolidation of the two bounded
        //    files (>= 24h + >= 5 new sessions, or a manual /dream).
        backgroundReviewEnabled: stored.backgroundReviewEnabled !== false,
        memoryDreamEnabled: stored.memoryDreamEnabled !== false,
        autoFoldTools: stored.autoFoldTools !== false,
        sendWhileRunning: stored.sendWhileRunning === 'queue' ? 'queue' : 'steer',
        // The trader's Risk Constitution rides the frozen session prefix;
        // length-capped here at the STORE so one oversized paste cannot bloat
        // every future prefix regardless of what the editor sends.
        riskConstitution: typeof stored.riskConstitution === 'string'
            ? stored.riskConstitution.slice(0, 1200)
            : undefined,
    };
    if (typeof localStorage !== 'undefined') {
        cachedRawSnapshot = raw;
        cachedSettingsSnapshot = snapshot;
    }
    return snapshot;
};

export const saveHarnessSettings = (next: Partial<HarnessSettings>): HarnessSettings => {
    const merged = { ...getHarnessSettings(), ...next };
    try {
        const serialized = JSON.stringify(merged);
        localStorage.setItem(KEY, serialized);
        cachedRawSnapshot = serialized;
        cachedSettingsSnapshot = merged;
    } catch { /* ignore */ }
    listeners.forEach(fn => { try { fn(merged); } catch { /* a subscriber must not break the save */ } });
    return merged;
};

/**
 * The settings barometer. Every surface that reads or writes a harness
 * setting goes through this store, so a value written in one place is the
 * value every reader sees — a second copy of a setting is how a UI ends up
 * disagreeing with itself.
 */
type SettingsListener = (next: HarnessSettings) => void;
const listeners = new Set<SettingsListener>();

export const subscribeHarnessSettings = (fn: SettingsListener): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

/**
 * Resolve the live SessionGuardConfig from the stored settings :
 * preset base + per-field overrides, all clamped to sane ranges. This is
 * the single source every assessSession call site reads, so the FTMO preset
 * and the user's own limits actually take effect.
 */
export const getSessionGuardConfig = (): SessionGuardConfig => {
    const s = getHarnessSettings();
    const base = s.guardPreset === 'ftmo' ? FTMO_SESSION_GUARD : DEFAULT_SESSION_GUARD;
    const pct = typeof s.guardDailyLossPct === 'number' && s.guardDailyLossPct > 0 && s.guardDailyLossPct <= 25
        ? s.guardDailyLossPct : base.dailyLossLimitPct * 100;
    const cap = typeof s.guardMaxTradesPerDay === 'number' && s.guardMaxTradesPerDay >= 1 && s.guardMaxTradesPerDay <= 20
        ? Math.floor(s.guardMaxTradesPerDay) : base.maxTradesPerDay;
    const cool = typeof s.guardPostLossCooldownMin === 'number' && s.guardPostLossCooldownMin >= 0 && s.guardPostLossCooldownMin <= 1440
        ? Math.floor(s.guardPostLossCooldownMin) : base.postLossCooldownMin;
    return {
        dailyLossLimitPct: pct / 100,
        maxTradesPerDay: cap,
        // The streak pause is overridable like the other guard fields; 0
        // disables it (assessSession treats 0 as off).
        lossStreakPause: typeof s.guardStreakPause === 'number' && s.guardStreakPause >= 0 && s.guardStreakPause <= 20
            ? Math.floor(s.guardStreakPause) : base.lossStreakPause,
        postLossCooldownMin: cool,
        tradeRiskPercent: s.riskPercent,
    };
};

