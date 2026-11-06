/**
 * memoryHygiene — the weekly notebook maintenance pass.
 *
 * The skill lifecycle (idle suspension, graveyard, demotion proposals,
 * contradiction sweeps, veto/lift reviews) is gone with the ledger. What
 * remains is the part that is about the NOTEBOOK, not about skills: one model
 * review that writes suggestions, and the size-pressure report.
 *
 * Everything here is best-effort. A failed pass logs and returns; it never
 * blocks boot.
 */

import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { loadProviderConfigs } from '../infrastructure/ProviderConfigService';
import { getFirstReadyProvider } from '../../utils/providerUtils';
import type { ProviderConfig } from '../../types/provider';
import { runNotebookReview } from './MemoryReviewService';
import { notebookWantsCleanup } from './MemoryFilesService';
import { cleanupIsDue } from '../../utils/memoryBudget';
import type { LoggedTrade } from '../../types';

const KEY_PREFIX = 'memory_hygiene_v1_';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_CAP = 20;

export interface HygieneLine {
    atMs: number;
    text: string;
}

export interface HygieneResult {
    atMs: number;
    reviewWritten: boolean;
    lines: string[];
}

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

/** True when no pass has ever run, the last one is >=7 days old, or the
 *  notebook has asked for one under byte pressure. */
export const isHygieneDue = async (username: string, now = Date.now()): Promise<boolean> => {
    try {
        const prev = await getPreferenceObject<{ lines?: HygieneLine[] }>(keyFor(username));
        const last = prev?.lines?.[0]?.atMs;
        if (typeof last !== 'number' || !Number.isFinite(last)) return true;
        if (notebookWantsCleanup() && cleanupIsDue(last, now)) return true;
        return now - last >= WEEK_MS;
    } catch {
        return true;
    }
};

export const loadHygieneLog = async (username: string): Promise<HygieneLine[]> => {
    try {
        const prev = await getPreferenceObject<{ lines?: HygieneLine[] }>(keyFor(username));
        return Array.isArray(prev?.lines) ? prev!.lines!.slice(0, LOG_CAP) : [];
    } catch {
        return [];
    }
};

const appendLog = async (username: string, atMs: number, lines: string[]): Promise<void> => {
    try {
        const prev = await loadHygieneLog(username);
        const next = [...lines.map(text => ({ atMs, text })), ...prev].slice(0, LOG_CAP);
        await setPreferenceObject(keyFor(username), { lines: next });
    } catch { /* a hygiene log must never break boot */ }
};

export const runMemoryHygiene = async (
    username: string,
    opts: { providerConfigs?: ProviderConfig[]; now?: number; trades?: LoggedTrade[] } = {},
): Promise<HygieneResult> => {
    const now = opts.now ?? Date.now();
    const lines: string[] = [];
    const result: HygieneResult = {
        atMs: now, reviewWritten: false, lines,
    };
    try {
        const configs = opts.providerConfigs ?? await loadProviderConfigs();
        const provider = getFirstReadyProvider(configs);
        if (provider) {
            result.reviewWritten = await runNotebookReview(username, provider);
            lines.push(result.reviewWritten
                ? 'Ran the notebook review — suggestions written.'
                : 'Notebook review had nothing to say (empty or unchanged notebook).');
        } else {
            lines.push('Skipped the notebook review — no ready provider.');
        }

        if (notebookWantsCleanup()) {
            lines.push('Notebook is over its size budget — new files are refused until space is freed in Settings → Memory.');
        }

        await appendLog(username, now, lines);
        return result;
    } catch (e) {
        lines.push(`Notebook pass aborted: ${e instanceof Error ? e.message : String(e)}.`);
        try { await appendLog(username, now, lines); } catch { /* the audit trail must not break boot */ }
        return result;
    }
};

/** Boot hook, beside `runWeeklyReviewIfDue`. Fire-and-forget, own due-check. */
export const runMemoryHygieneIfDue = async (
    username: string,
    providerConfigs?: ProviderConfig[],
    trades?: LoggedTrade[],
): Promise<HygieneResult | null> => {
    try {
        if (!(await isHygieneDue(username))) return null;
        return await runMemoryHygiene(username, { providerConfigs, trades });
    } catch {
        return null;
    }
};
