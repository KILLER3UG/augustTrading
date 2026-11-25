/**
 * scopedRules — lazy, condition-triggered trading guardrails (pure TypeScript).
 *
 * Modeled on Claude Code's path-scoped rules: zero token overhead in normal
 * market/account states; injects concise behavioral guardrails ONLY when
 * specific risk or market-structure conditions hold, strictly at the dynamic
 * prompt tail so the frozen KV-cache prefix stays byte-identical.
 *
 * Pure: zero React, DOM, window, storage, or network imports.
 */

export type ScopedRuleId = 'chop_discipline' | 'extreme_funding' | 'drawdown_cooldown';

export interface ScopedRule {
    id: ScopedRuleId;
    title: string;
    detail: string;
}

export interface ScopedRulesInput {
    /** Regime direction or regimeId (e.g. 'range', 'chop', 'trend', 'range:compressed:120'). */
    regime?: string | null;
    /** Current 8h funding rate in decimal (e.g. 0.0005 = 0.05%). */
    fundingRate?: number | null;
    /** Today's paper-account drawdown in percent (e.g. 1.8 = 1.8%). */
    dailyDrawdownPct?: number | null;
    /** True when the daily drawdown kill-switch has halted new entries. */
    killSwitchActive?: boolean | null;
    /** Configured daily drawdown kill-switch threshold in percent (default 3.0). */
    maxDailyDrawdownPct?: number | null;
}

export interface ScopedRulesResult {
    activeRules: ScopedRule[];
    /** Empty string when no rules trip — zero token overhead in normal conditions. */
    promptTailBlock: string;
}

export const EXTREME_FUNDING_ABS_THRESHOLD = 0.0005; // 0.05% per 8h
export const DRAWDOWN_COOLDOWN_PCT = 1.5;
export const DEFAULT_KILL_SWITCH_PCT = 3.0;

const normalizeRegimeDirection = (raw: string | null | undefined): string => {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.split(':')[0]?.trim() ?? '';
};

/**
 * Evaluate condition-scoped trading rules over in-memory session state.
 * Gracefully omits any rule whose input is null, undefined, or non-finite.
 */
export const evaluateScopedRules = (input: ScopedRulesInput): ScopedRulesResult => {
    const activeRules: ScopedRule[] = [];

    // 1. Chop / Range Discipline
    const dir = normalizeRegimeDirection(input.regime);
    if (dir === 'range' || dir === 'chop') {
        activeRules.push({
            id: 'chop_discipline',
            title: 'Chop / Range Discipline',
            detail:
                `Regime is ${dir}: discourage breakout chasing inside the range. `
                + 'Require a clear range-edge liquidity sweep + reclaim with tight invalidation, or explicitly call `decline_trade` / WAIT.',
        });
    }

    // 2. Extreme Funding Crowding
    if (typeof input.fundingRate === 'number' && Number.isFinite(input.fundingRate)
        && Math.abs(input.fundingRate) >= EXTREME_FUNDING_ABS_THRESHOLD) {
        const pct = (input.fundingRate * 100).toFixed(4);
        const crowdedSide = input.fundingRate > 0 ? 'Longs' : 'Shorts';
        const directionHint = input.fundingRate > 0 ? 'long' : 'short';
        activeRules.push({
            id: 'extreme_funding',
            title: 'Extreme Funding Crowding',
            detail:
                `Funding rate is ${pct}%/8h (${crowdedSide} crowded, |rate| >= 0.05%). `
                + `Warn against chasing crowded ${directionHint} entries and pass \`expected_hold_hours\` into \`trade_math\` to price funding carry.`,
        });
    }

    // 3. Drawdown Cooldown / Kill-Switch
    const killActive = input.killSwitchActive === true;
    const ddPct = typeof input.dailyDrawdownPct === 'number' && Number.isFinite(input.dailyDrawdownPct)
        ? Math.max(0, input.dailyDrawdownPct)
        : null;
    const maxDd = typeof input.maxDailyDrawdownPct === 'number' && Number.isFinite(input.maxDailyDrawdownPct) && input.maxDailyDrawdownPct > 0
        ? input.maxDailyDrawdownPct
        : DEFAULT_KILL_SWITCH_PCT;

    if (killActive) {
        activeRules.push({
            id: 'drawdown_cooldown',
            title: 'Daily Drawdown Kill-Switch Active',
            detail:
                `Kill-switch is ACTIVE (${ddPct !== null ? `${ddPct.toFixed(2)}%` : `>= ${maxDd.toFixed(1)}%`} daily drawdown). `
                + 'New entries are HALTED — restrict advice to risk management, reducing exposure, or post-mortem review.',
        });
    } else if (ddPct !== null && ddPct >= DRAWDOWN_COOLDOWN_PCT) {
        const headroom = Math.max(0, maxDd - ddPct);
        activeRules.push({
            id: 'drawdown_cooldown',
            title: 'Drawdown Cooldown',
            detail:
                `Daily drawdown is ${ddPct.toFixed(2)}% (${headroom.toFixed(2)}% headroom remaining before the ${maxDd.toFixed(1)}% kill-switch). `
                + 'Enforce capital-preservation mode: cap recommended risk at <= 0.5% per trade and skip marginal setups.',
        });
    }

    if (activeRules.length === 0) {
        return { activeRules, promptTailBlock: '' };
    }

    const promptTailBlock = [
        '[SCOPED GUARDRAILS — condition-triggered for this turn]',
        ...activeRules.map(r => `- ${r.title} (${r.id}): ${r.detail}`),
    ].join('\n');

    return { activeRules, promptTailBlock };
};
