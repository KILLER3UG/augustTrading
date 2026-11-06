export type PromptAbRate = 0 | 0.1 | 0.5;

import {
    DEFAULT_SESSION_GUARD,
    FTMO_SESSION_GUARD,
    SessionGuardConfig,
} from '../services/validation/SessionGuardService';
import type { OutcomeSettlement } from './outcomeSettlement';
import type { SelfModMode } from '../schemas/selfChange';

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
    promptAbRate: PromptAbRate;
    /** Analysts may call live desk tools (search, derivatives, session) before the brief. Default on. */
    deskToolsEnabled: boolean;
    /** Session-guard preset: 'default' = research-tight
     *  (2%/2 trades/2-streak/4h), 'ftmo' = the looser alternative
     *  (3%/3 trades). Individual overrides win over the preset. */
    guardPreset?: 'default' | 'ftmo';
    guardDailyLossPct?: number;
    guardMaxTradesPerDay?: number;
    guardPostLossCooldownMin?: number;
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

export const getHarnessSettings = (): HarnessSettings => {
    const stored = typeof localStorage === 'undefined' ? {} : read();
    const rate = stored.promptAbRate;
    return {
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
        promptAbRate: rate === 0 || rate === 0.1 || rate === 0.5 ? rate : 0.1,
        deskToolsEnabled: stored.deskToolsEnabled !== false,
        guardPreset: stored.guardPreset === 'ftmo' ? 'ftmo' : stored.guardPreset === 'default' ? 'default' : undefined,
        guardDailyLossPct: typeof stored.guardDailyLossPct === 'number' && stored.guardDailyLossPct > 0 ? stored.guardDailyLossPct : undefined,
        guardMaxTradesPerDay: typeof stored.guardMaxTradesPerDay === 'number' && stored.guardMaxTradesPerDay >= 1 ? stored.guardMaxTradesPerDay : undefined,
        guardPostLossCooldownMin: typeof stored.guardPostLossCooldownMin === 'number' && stored.guardPostLossCooldownMin >= 0 ? stored.guardPostLossCooldownMin : undefined,
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
        // harness. Anything other than the two named levels fails to 'off'.
        selfModificationMode: stored.selfModificationMode === 'config' || stored.selfModificationMode === 'shadow'
            ? stored.selfModificationMode
            : 'off',
    };
};

export const saveHarnessSettings = (next: Partial<HarnessSettings>): HarnessSettings => {
    const merged = { ...getHarnessSettings(), ...next };
    try {
        localStorage.setItem(KEY, JSON.stringify(merged));
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
        lossStreakPause: base.lossStreakPause,
        postLossCooldownMin: cool,
        tradeRiskPercent: s.riskPercent,
    };
};

