/**
 * diagnosticsCore — pure builders for `/context` and `/doctor` diagnostics.
 *
 * Pure TypeScript: zero React, DOM, window, localStorage, or network imports.
 */

import { estimateTokens } from '../../utils/tokenEstimate';
import { resolveContextWindow, type ContextWindowInput, type ContextWindowSource } from '../../utils/contextWindow';

export interface ContextDiagnosticInput {
    systemPromptText: string;
    curatedMemoryText: string;
    /** Exact block string embedded inside `systemPromptText` when already injected (prevents double-counting). */
    embeddedCuratedText?: string;
    loadedSkillsTexts: readonly string[];
    historyTexts: readonly string[];
    toolResultsTexts: readonly string[];
    provider?: ContextWindowInput | null;
}

export interface ContextDiagnosticBreakdownItem {
    key: 'system_prompt' | 'curated_memory' | 'loaded_skills' | 'conversation_history' | 'tool_results';
    label: string;
    tokens: number;
    pctOfWindow: number;
}

export interface ContextDiagnosticSnapshot {
    kind: 'context';
    generatedAt: string;
    windowTokens: number;
    windowSource: ContextWindowSource;
    windowLabel: string;
    totalTokens: number;
    pctUsed: number;
    autoCompactTriggerTokens: number;
    tokensUntilAutoCompact: number;
    breakdown: ContextDiagnosticBreakdownItem[];
}

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheckRow {
    id: 'model' | 'market_ws' | 'chart_drawings' | 'paper_risk' | 'memory_skills_rules' | 'app_updater';
    label: string;
    status: DoctorStatus;
    summary: string;
    detail?: string;
}

export interface DoctorDiagnosticSnapshot {
    kind: 'doctor';
    generatedAt: string;
    overall: DoctorStatus;
    checks: DoctorCheckRow[];
}

export interface DoctorDiagnosticInput {
    providerName: string | null;
    modelId: string | null;
    effort: string;
    toolsEnabled: boolean;
    reasoningCapable: boolean;
    visionCapable: boolean;
    windowTokens: number;
    windowSource: ContextWindowSource;

    symbol: string;
    interval: string;
    markPrice: number | null;
    markAgeMs: number | null;
    wsConnected: boolean | null;

    sessionId: string;
    modelDrawingCount: number;
    hiddenLowerTfCount: number;
    planMode: boolean;

    paperEnabled: boolean;
    paperEquityUsd: number | null;
    paperDailyDrawdownPct: number | null;
    paperKillSwitchPct: number;
    paperKillSwitchActive: boolean;
    paperOpenPositions: number;
    paperMaxPositions: number;
    paperCorruptionReason: string | null;

    userMdBytes: number;
    userMdCapBytes: number;
    memoryMdBytes: number;
    memoryMdCapBytes: number;
    rejectedStoreHealthy: boolean;
    rejectedStoreError?: string | null;
    liveSkillCount: number;
    activeScopedRuleIds: readonly string[];

    appVersion: string;
    isElectron: boolean;
    updateStatus: string;
    updateError?: string | null;
}

const sumTokens = (items: readonly string[]): number =>
    items.reduce((sum, text) => sum + (text ? estimateTokens(text) : 0), 0);

const roundPct = (num: number, denom: number): number =>
    denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0;

/** Build the `/context` token-usage breakdown snapshot. */
export const buildContextDiagnostic = (input: ContextDiagnosticInput): ContextDiagnosticSnapshot => {
    const resolved = input.provider
        ? resolveContextWindow(input.provider)
        : resolveContextWindow({ selectedModel: '', contextWindowTokens: undefined, modelContextWindows: undefined });
    const windowTokens = resolved.tokens;

    const curatedTokens = input.curatedMemoryText ? estimateTokens(input.curatedMemoryText) : 0;
    const embeddedTrimmed = input.embeddedCuratedText?.trim() ?? '';
    const systemOnlyText = embeddedTrimmed && input.systemPromptText.includes(embeddedTrimmed)
        ? input.systemPromptText.replace(embeddedTrimmed, '').trim()
        : input.systemPromptText;
    const systemTokens = systemOnlyText ? estimateTokens(systemOnlyText) : 0;
    const skillsTokens = sumTokens(input.loadedSkillsTexts);
    const historyTokens = sumTokens(input.historyTexts);
    const toolsTokens = sumTokens(input.toolResultsTexts);

    const totalTokens = systemTokens + curatedTokens + skillsTokens + historyTokens + toolsTokens;
    const autoCompactTriggerTokens = Math.floor(windowTokens * 0.9);
    const tokensUntilAutoCompact = Math.max(0, autoCompactTriggerTokens - totalTokens);

    const breakdown: ContextDiagnosticBreakdownItem[] = [
        { key: 'system_prompt', label: 'Frozen system prompt (mandate + constitution + skill index)', tokens: systemTokens, pctOfWindow: roundPct(systemTokens, windowTokens) },
        { key: 'curated_memory', label: 'Curated memory (USER.md + MEMORY.md)', tokens: curatedTokens, pctOfWindow: roundPct(curatedTokens, windowTokens) },
        { key: 'loaded_skills', label: 'Loaded skill bodies in session', tokens: skillsTokens, pctOfWindow: roundPct(skillsTokens, windowTokens) },
        { key: 'conversation_history', label: 'Conversation history (user + AI turns)', tokens: historyTokens, pctOfWindow: roundPct(historyTokens, windowTokens) },
        { key: 'tool_results', label: 'Tool results & receipts', tokens: toolsTokens, pctOfWindow: roundPct(toolsTokens, windowTokens) },
    ];

    return {
        kind: 'context',
        generatedAt: new Date().toISOString(),
        windowTokens,
        windowSource: resolved.source,
        windowLabel: resolved.label,
        totalTokens,
        pctUsed: roundPct(totalTokens, windowTokens),
        autoCompactTriggerTokens,
        tokensUntilAutoCompact,
        breakdown,
    };
};

const worstStatus = (statuses: readonly DoctorStatus[]): DoctorStatus => {
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('WARN')) return 'WARN';
    return 'PASS';
};

/** Build the `/doctor` 6-subsystem health diagnostic checklist. */
export const buildDoctorDiagnostic = (input: DoctorDiagnosticInput): DoctorDiagnosticSnapshot => {
    const checks: DoctorCheckRow[] = [];

    // 1. Active Model & Capabilities
    const hasModel = Boolean(input.providerName && input.modelId);
    const modelStatus: DoctorStatus = !hasModel ? 'FAIL' : (!input.toolsEnabled ? 'WARN' : 'PASS');
    checks.push({
        id: 'model',
        label: 'Active Model & Capabilities',
        status: modelStatus,
        summary: hasModel
            ? `${input.providerName} · ${input.modelId} · effort=${input.effort} · tools=${input.toolsEnabled ? 'on' : 'off'} · reasoning=${input.reasoningCapable ? 'yes' : 'no'} · vision=${input.visionCapable ? 'yes (inspect_chart_image ready)' : 'no'} · window=${input.windowTokens.toLocaleString()} (${input.windowSource})`
            : 'No active provider/model configured — add a key in Settings → AI Models.',
    });

    // 2. Market & WS Feed
    const markOk = typeof input.markPrice === 'number' && Number.isFinite(input.markPrice) && input.markPrice > 0;
    const staleMark = markOk && typeof input.markAgeMs === 'number' && input.markAgeMs > 30_000;
    const marketStatus: DoctorStatus = !markOk ? 'WARN' : (staleMark || input.wsConnected === false ? 'WARN' : 'PASS');
    const ageLabel = typeof input.markAgeMs === 'number' ? `${Math.round(input.markAgeMs / 1000)}s ago` : 'n/a';
    const wsLabel = input.wsConnected === true ? 'live' : input.wsConnected === false ? 'disconnected' : 'standby/unmounted';
    checks.push({
        id: 'market_ws',
        label: 'Market & WS Feed',
        status: marketStatus,
        summary: `${input.symbol} · ${input.interval} · mark=${markOk ? input.markPrice : 'unavailable'} (age ${ageLabel}) · combined WS=${wsLabel}`,
    });

    // 3. Chart Drawing Pipeline
    checks.push({
        id: 'chart_drawings',
        label: 'Chart Drawing Pipeline',
        status: 'PASS',
        summary: `session=${input.sessionId || 'none'} · model drawings on ${input.symbol}=${input.modelDrawingCount} · hidden lower-TF=${input.hiddenLowerTfCount} · Plan Mode=${input.planMode ? 'ON (read-only)' : 'OFF'}`,
    });

    // 4. Paper Broker & Risk Walls
    const ddStr = input.paperDailyDrawdownPct !== null ? `${input.paperDailyDrawdownPct.toFixed(2)}%` : '0.00%';
    const eqStr = input.paperEquityUsd !== null ? `$${Math.round(input.paperEquityUsd).toLocaleString()}` : 'n/a';
    const paperStatus: DoctorStatus = input.paperCorruptionReason
        ? 'FAIL'
        : input.paperKillSwitchActive
            ? 'FAIL'
            : (input.paperDailyDrawdownPct !== null && input.paperDailyDrawdownPct >= 1.5 ? 'WARN' : 'PASS');
    checks.push({
        id: 'paper_risk',
        label: 'Paper Broker & Risk Walls',
        status: paperStatus,
        summary: `${input.paperEnabled ? 'enabled' : 'disabled'} · equity=${eqStr} · daily drawdown=${ddStr}/${input.paperKillSwitchPct}%${input.paperKillSwitchActive ? ' (KILL-SWITCH ACTIVE)' : ''} · positions=${input.paperOpenPositions}/${input.paperMaxPositions}${input.paperCorruptionReason ? ` · QUARANTINED: ${input.paperCorruptionReason}` : ' · store clean'}`,
    });

    // 5. Memory, Skills & Scoped Rules
    const memStatus: DoctorStatus = !input.rejectedStoreHealthy
        ? 'FAIL'
        : (input.activeScopedRuleIds.length > 0 ? 'WARN' : 'PASS');
    checks.push({
        id: 'memory_skills_rules',
        label: 'Memory, Skills & Scoped Rules',
        status: memStatus,
        summary: `USER.md=${input.userMdBytes}/${input.userMdCapBytes}B · MEMORY.md=${input.memoryMdBytes}/${input.memoryMdCapBytes}B · rejectedStore=${input.rejectedStoreHealthy ? 'ok' : `degraded (${input.rejectedStoreError ?? 'error'})`} · skills=${input.liveSkillCount} · scopedRules=${input.activeScopedRuleIds.length > 0 ? input.activeScopedRuleIds.join(', ') : 'none'}`,
    });

    // 6. App & Updater
    const updaterStatus: DoctorStatus = input.updateError ? 'WARN' : 'PASS';
    checks.push({
        id: 'app_updater',
        label: 'App & Updater',
        status: updaterStatus,
        summary: `v${input.appVersion} · runtime=${input.isElectron ? 'Electron desktop' : 'browser dev'} · updater=${input.isElectron ? input.updateStatus : 'browser mode (IPC inactive)'}${input.updateError ? ` (${input.updateError})` : ''}`,
    });

    return {
        kind: 'doctor',
        generatedAt: new Date().toISOString(),
        overall: worstStatus(checks.map(c => c.status)),
        checks,
    };
};

// ─── Redacted Diagnostic Bundle Export ───────────────────────────────────────

const SAFE_TOKEN_METRIC_KEYS = new Set([
    'windowtokens',
    'totaltokens',
    'tokensin',
    'tokensout',
    'tokensuntilautocompact',
    'autocompacttriggertokens',
]);

const SENSITIVE_KEY_RE =
    /^(?:x[-_])?api[-_]?key$|^authorization$|^bearer$|secret|password|passwd|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|cookie|credential|api[-_]?token/i;

const redactStringSecrets = (text: string): string =>
    text
        .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
        .replace(
            /\b(x-api-key|api[_-]?key|authorization|secret|password|access[_-]?token|refresh[_-]?token)\s*([:=])\s*(?:Bearer\s+)?["']?(?!\[REDACTED\])([^\s"',;}{]+)["']?/gi,
            (_m, k: string, sep: string) => `${k}${sep} [REDACTED]`,
        )
        .replace(/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{6,}=*/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]');

/** Recursively strip API keys, bearer tokens, passwords, and secrets from diagnostic payloads. */
export const redactSensitiveFields = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactStringSecrets(value) as unknown as T;
    if (typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[Circular]' as unknown as T;
    seen.add(value as object);

    if (Array.isArray(value)) {
        return value.map(item => redactSensitiveFields(item, seen)) as unknown as T;
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const lower = key.toLowerCase();
        if (!SAFE_TOKEN_METRIC_KEYS.has(lower) && SENSITIVE_KEY_RE.test(key)) {
            out[key] = '[REDACTED]';
            continue;
        }
        out[key] = redactSensitiveFields(val, seen);
    }
    return out as T;
};

export interface RedactedErrorSummary {
    source: 'lastPromiseError' | 'lastGlobalError' | 'lastCrashError';
    timestamp?: string;
    type?: string;
    message: string;
}

export interface RedactedDiagnosticBundle {
    schemaVersion: 1;
    exportedAt: string;
    appVersion: string;
    runtime: 'electron' | 'web';
    activeModel: {
        providerName: string | null;
        modelId: string | null;
        effort: string;
        reasoningCapable: boolean;
        visionCapable: boolean;
    };
    doctor: DoctorDiagnosticSnapshot;
    recentErrors: RedactedErrorSummary[];
}

/** Build and deeply redact a 1-click troubleshooting bundle safe to share or inspect offline. */
export const buildRedactedDiagnosticBundle = (input: {
    appVersion: string;
    isElectron: boolean;
    activeModel: {
        providerName: string | null;
        modelId: string | null;
        effort: string;
        reasoningCapable: boolean;
        visionCapable: boolean;
    };
    doctor: DoctorDiagnosticSnapshot;
    recentErrors?: readonly RedactedErrorSummary[];
    exportedAt?: string;
}): RedactedDiagnosticBundle => redactSensitiveFields({
    schemaVersion: 1,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    runtime: input.isElectron ? 'electron' : 'web',
    activeModel: input.activeModel,
    doctor: input.doctor,
    recentErrors: [...(input.recentErrors ?? [])],
});
