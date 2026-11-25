/**
 * diagnosticsRuntime — safe runtime collectors for `/context` and `/doctor`.
 *
 * Strictly zero LLM calls, safe in both Electron and browser dev mode when
 * `window.electronAPI` is absent, and resilient to cold/empty stores.
 */

import type { ProviderConfig } from '../../types/provider';
import { resolveContextWindow } from '../../utils/contextWindow';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { getActiveUsername } from '../../utils/activeUser';
import { isVisionModel } from '../../utils/modelUtils';
import { APP_VERSION } from '../../constants/version';
import { getCachedCuratedMemorySnapshot, USER_MD_MAX_CHARS, MEMORY_MD_MAX_CHARS } from '../learning/curatedMemory';
import { listRejectedFingerprints } from '../learning/rejectedFingerprints';
import { skillIndexRows, usableSkillRows } from '../learning/SkillFileService';
import { getPaperAccount, getPaperCorruptionWarning } from '../paper/PaperBrokerService';
import { getPaperLiveFrame, hasLivePaperFeed } from './futuresStreams';
import { drawingsControl } from './drawingsControl';
import type { ChartDrawing } from './chartDrawings';
import { isDrawingVisibleOnTf } from './chartGeometry';
import { readToolPayload } from './toolPayloadStore';
import { collectScopedRulesForSymbol } from './scopedRulesRuntime';
import {
    buildContextDiagnostic,
    buildDoctorDiagnostic,
    type ContextDiagnosticSnapshot,
    type DoctorDiagnosticSnapshot,
} from './diagnosticsCore';
import type { LiveEntry } from './chatStore';

export interface CollectContextOpts {
    systemPromptText: string;
    entries: readonly Pick<LiveEntry, 'role' | 'text' | 'tools' | 'toolIds'>[];
    provider: ProviderConfig | null;
}

export const collectContextDiagnostic = (opts: CollectContextOpts): ContextDiagnosticSnapshot => {
    const snap = getCachedCuratedMemorySnapshot();
    const curatedText = [snap.userMd, snap.memoryMd].filter(Boolean).join('\n');

    const historyTexts: string[] = [];
    const toolResultsTexts: string[] = [];
    const loadedSkillsTexts: string[] = [];

    for (const e of opts.entries) {
        if (e.text?.trim()) historyTexts.push(e.text);
        if (Array.isArray(e.tools)) {
            for (let i = 0; i < e.tools.length; i += 1) {
                const line = e.tools[i];
                const tid = e.toolIds?.[i];
                const payload = tid ? readToolPayload(tid) : null;
                if (payload?.text) {
                    if (/skill_view|skill_reader|read_skill/i.test(line) || payload.name === 'skill_view') {
                        loadedSkillsTexts.push(payload.text);
                    } else {
                        toolResultsTexts.push(payload.text);
                    }
                } else if (line) {
                    toolResultsTexts.push(line);
                }
            }
        }
    }

    return buildContextDiagnostic({
        systemPromptText: opts.systemPromptText,
        curatedMemoryText: curatedText,
        loadedSkillsTexts,
        historyTexts,
        toolResultsTexts,
        provider: opts.provider,
    });
};

export interface CollectDoctorOpts {
    provider: ProviderConfig | null;
    effort: string;
    symbol: string;
    interval: string;
    sessionId: string;
    planMode: boolean;
    markPrice?: number | null;
    modelDrawings?: readonly ChartDrawing[];
}

export const collectDoctorDiagnostic = async (opts: CollectDoctorOpts): Promise<DoctorDiagnosticSnapshot> => {
    const settings = getHarnessSettings();
    const user = getActiveUsername() || 'default';
    const resolvedWin = opts.provider
        ? resolveContextWindow(opts.provider)
        : resolveContextWindow({ selectedModel: '', contextWindowTokens: undefined, modelContextWindows: undefined });

    const modelId = opts.provider?.selectedModel ?? '';
    const visionCapable = modelId ? isVisionModel(modelId) : false;
    const reasoningCapable = Boolean(modelId && !/gpt-3\.5/i.test(modelId));

    const liveFrame = opts.symbol ? getPaperLiveFrame(opts.symbol, 300_000) : null;
    const markPrice = typeof opts.markPrice === 'number' && Number.isFinite(opts.markPrice) && opts.markPrice > 0
        ? opts.markPrice
        : (liveFrame?.mark ?? null);
    const markAgeMs = liveFrame ? Math.max(0, Date.now() - liveFrame.at) : null;
    const wsConnected = opts.symbol ? (hasLivePaperFeed(opts.symbol) ? true : null) : null;

    let modelDrawings: readonly ChartDrawing[] = opts.modelDrawings ?? [];
    if (modelDrawings.length === 0 && opts.sessionId && opts.symbol) {
        try {
            modelDrawings = drawingsControl('model', opts.sessionId, opts.symbol).list();
        } catch {
            modelDrawings = [];
        }
    }
    const hiddenLowerTfCount = modelDrawings.filter(d => !isDrawingVisibleOnTf(d, opts.interval)).length;

    let paperEnabled = false;
    let paperEquityUsd: number | null = null;
    let paperDailyDrawdownPct: number | null = null;
    let paperKillSwitchPct = 3.0;
    let paperKillSwitchActive = false;
    let paperOpenPositions = 0;
    let paperMaxPositions = 3;
    try {
        const account = await getPaperAccount(user);
        paperEnabled = account.config.enabled;
        paperEquityUsd = account.cashBalanceUsd;
        paperKillSwitchPct = account.config.dailyDrawdownKillSwitchPct;
        paperKillSwitchActive = account.killSwitchActive;
        paperOpenPositions = account.positions.length;
        paperMaxPositions = account.config.maxConcurrentPositions;
        if (account.dayStartEquityUsd > 0 && account.cashBalanceUsd < account.dayStartEquityUsd) {
            paperDailyDrawdownPct = ((account.dayStartEquityUsd - account.cashBalanceUsd) / account.dayStartEquityUsd) * 100;
        } else {
            paperDailyDrawdownPct = 0;
        }
    } catch { /* cold or uninitialized store */ }
    const paperCorruption = getPaperCorruptionWarning();

    const curated = getCachedCuratedMemorySnapshot();
    let rejectedHealthy = true;
    let rejectedError: string | null = null;
    try {
        await listRejectedFingerprints(user);
    } catch (e) {
        rejectedHealthy = false;
        rejectedError = e instanceof Error ? e.message : String(e);
    }

    let liveSkillCount: number;
    try {
        liveSkillCount = usableSkillRows(skillIndexRows()).length;
    } catch {
        liveSkillCount = 0;
    }

    const scoped = collectScopedRulesForSymbol(opts.symbol);

    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const isElectron = Boolean(electronAPI);
    let appVersion = APP_VERSION;
    let updateStatus = 'idle';
    let updateError: string | null = null;
    if (electronAPI) {
        try {
            const v = await electronAPI.getVersion?.();
            if (v) appVersion = v;
        } catch { /* keep APP_VERSION fallback */ }
        try {
            const st = await electronAPI.getUpdateStatus?.();
            if (st) {
                updateStatus = st.status ?? 'idle';
                updateError = st.error ?? null;
            }
        } catch { /* keep idle */ }
    }

    return buildDoctorDiagnostic({
        providerName: opts.provider?.name ?? null,
        modelId: opts.provider?.selectedModel ?? null,
        effort: opts.effort,
        toolsEnabled: settings.deskToolsEnabled !== false,
        reasoningCapable,
        visionCapable,
        windowTokens: resolvedWin.tokens,
        windowSource: resolvedWin.source,

        symbol: opts.symbol,
        interval: opts.interval,
        markPrice,
        markAgeMs,
        wsConnected,

        sessionId: opts.sessionId,
        modelDrawingCount: modelDrawings.length,
        hiddenLowerTfCount,
        planMode: opts.planMode,

        paperEnabled,
        paperEquityUsd,
        paperDailyDrawdownPct,
        paperKillSwitchPct,
        paperKillSwitchActive,
        paperOpenPositions,
        paperMaxPositions,
        paperCorruptionReason: paperCorruption?.reason ?? null,

        userMdBytes: curated.userMd.length,
        userMdCapBytes: USER_MD_MAX_CHARS,
        memoryMdBytes: curated.memoryMd.length,
        memoryMdCapBytes: MEMORY_MD_MAX_CHARS,
        rejectedStoreHealthy: rejectedHealthy,
        rejectedStoreError: rejectedError,
        liveSkillCount,
        activeScopedRuleIds: scoped.activeRules.map(r => r.id),

        appVersion,
        isElectron,
        updateStatus,
        updateError,
    });
};
