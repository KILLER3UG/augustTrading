/**
 * uiFormatting — pure, single-source display formatters for Wave 4 UI clarity.
 *
 * Keeps beginner-friendly titles, storage environment labels, thread symbol
 * badges, folder grouping, and deduplicated assistant footer lines in ONE
 * testable pure utility module (zero React/DOM/service runtime dependencies).
 */

import { formatModelDisplayName } from './providerUtils';
import { ageMinutes, roundAgoHoursLabel } from './relativeTime';
import { baseOf } from './symbol';

export type StorageBackendType = 'files' | 'sqlite' | 'indexeddb';

/** Human-readable storage backend label (prefers desktop Electron wording when Electron is detected). */
export const formatStorageBackendLabel = (
    storageType: StorageBackendType,
    isElectron: boolean,
): string => {
    if (isElectron) return 'Local desktop storage (Electron)';
    if (storageType === 'sqlite') return 'SQLite — the app’s own data file';
    if (storageType === 'files') return 'Local files — on-device workspace storage';
    return 'IndexedDB — inside the browser profile';
};

const TRADING_ACRONYMS = new Set([
    'SMC', 'VWAP', 'OB', 'FVG', 'RSI', 'EMA', 'SMA', 'ATR', 'OI',
    'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'LINK', 'SUI',
    'USDT', 'USDC', 'USD', 'HTF', 'LTF', 'MTF', 'SL', 'TP', 'RR',
    'IB', 'CVD', 'BOS', 'CHOCH', 'ICT', 'POC', 'VAH', 'VAL', 'AI',
]);

const isKebabSlug = (s: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(s.trim());

/** Humanize raw skill slugs/names into clean Title Case while preserving acronyms and curated titles. */
export const humanizeSkillTitle = (name: string, slug: string): string => {
    const trimmedName = (name ?? '').trim();
    if (trimmedName && !isKebabSlug(trimmedName) && /[\sA-Z]/.test(trimmedName)) {
        return trimmedName;
    }
    const raw = (trimmedName || (slug ?? '').trim()).replace(/^repeat-(?=[a-z0-9])/i, '');
    if (!raw) return 'Untitled Skill';
    const tokens = raw.split(/[-_\s]+/).filter(Boolean);
    if (tokens.length === 0) return 'Untitled Skill';
    return tokens
        .map((tok) => {
            const upper = tok.toUpperCase();
            if (TRADING_ACRONYMS.has(upper)) return upper;
            return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
        })
        .join(' ');
};

/** Partition notebook memory folders into populated (`count > 0`) vs empty (`count === 0`). */
export const partitionMemoryFolders = <T extends { count: number }>(
    folders: readonly T[],
): { active: T[]; empty: T[] } => {
    const active: T[] = [];
    const empty: T[] = [];
    for (const f of folders) {
        if (f.count > 0) active.push(f);
        else empty.push(f);
    }
    return { active, empty };
};

const RAW_INTERNAL_SPEAKER_PREFIXES = new Set([
    'desk', 'custom', 'openrouter', 'mock', 'openai', 'anthropic', 'gemini',
    'deepseek', 'groq', 'zhipu', 'together', 'xai', 'mistral', 'ollama',
]);

const EFFORT_LABELS: Record<string, string> = {
    off: 'Off',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
};

/**
 * Format assistant message footer metadata into a single deduplicated monochrome line
 * (e.g. `Ernie 5.5 Flash · Max · 5h ago`), omitting raw internal provider prefixes
 * and never repeating the thinking tier.
 */
export const formatAssistantFooterMeta = (
    input: { speaker?: string; effort?: string; effortLabel?: string; at?: number },
    nowMs: number = Date.now(),
): string | null => {
    const parts: string[] = [];
    const rawSpeaker = (input.speaker ?? '').trim();
    if (rawSpeaker) {
        const segments = rawSpeaker.split(':').map(s => s.trim()).filter(Boolean);
        while (segments.length > 0 && RAW_INTERNAL_SPEAKER_PREFIXES.has(segments[0].toLowerCase())) {
            segments.shift();
        }
        const modelRaw = segments.join(':');
        if (modelRaw) {
            parts.push(formatModelDisplayName(modelRaw));
        }
    }
    const effortRaw = (input.effortLabel ?? (input.effort ? (EFFORT_LABELS[String(input.effort).toLowerCase()] ?? String(input.effort)) : '')).trim();
    if (effortRaw) parts.push(effortRaw);
    const mins = input.at ? Math.max(0, Math.round(ageMinutes(input.at, nowMs))) : -1;
    if (mins >= 0) {
        const ago = roundAgoHoursLabel(mins);
        if (ago) parts.push(ago);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
};

/** Compact instrument/timeframe badge for sidebar & search conversation lists (e.g. `BTC · 15m`). */
export const formatThreadBadge = (symbol?: string | null, interval?: string | null): string | null => {
    const sym = (symbol ?? '').trim();
    const tf = (interval ?? '').trim();
    if (!sym && !tf) return null;
    if (!sym) return tf;
    const coin = baseOf(sym);
    return tf ? `${coin} · ${tf}` : coin;
};

const hasLevelPrice = (v: string | number | null | undefined): boolean => {
    if (v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s !== '' && s !== '—' && s !== '-' && s !== 'n/a' && s !== 'na';
};

/**
 * Suppress the 3-level Entry/Stop/Target UNCITED grid when a stand-aside verdict
 * (`WAIT`, `NO_TRADE`, `Neutral`, `No trade`, `Hold`, `Avoid`, etc.) has all
 * three level prices empty so beginners do not read an intentional pass as an error.
 */
export const shouldSuppressStandAsideLevels = (analysis: {
    direction?: string;
    entryPoints?: Array<{ price?: string | number | null }>;
    stopLoss?: string | number | null;
    takeProfit?: Array<{ price?: string | number | null }>;
}): boolean => {
    const dir = (analysis.direction ?? '').trim().toLowerCase();
    if (dir === 'long' || dir === 'short') return false;
    return !hasLevelPrice(analysis.entryPoints?.[0]?.price)
        && !hasLevelPrice(analysis.stopLoss)
        && !hasLevelPrice(analysis.takeProfit?.[0]?.price);
};

export interface ContextRingUsage {
    totalTokens: number;
    windowTokens: number;
    pctUsed: number;
    autoCompactTriggerTokens: number;
    tokensToAutoCompact: number;
    circumference: number;
    dashOffset: number;
    tooltip: string;
}

const CONTEXT_RING_RADIUS = 6;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/** Compute clamped context-window percentage, remaining auto-compact tokens, and SVG ring dash offset. */
export const computeContextRingUsage = (input: {
    totalTokens: number;
    windowTokens: number;
}): ContextRingUsage => {
    const safeTotal = Number.isFinite(input.totalTokens) && input.totalTokens > 0
        ? Math.floor(input.totalTokens)
        : 0;
    const safeWindow = Number.isFinite(input.windowTokens) && input.windowTokens > 0
        ? Math.floor(input.windowTokens)
        : 128_000;
    const clampedPct = Math.min(100, Math.max(0, (safeTotal / safeWindow) * 100));
    const pctUsed = Math.round(clampedPct * 10) / 10;
    const autoCompactTriggerTokens = Math.floor(safeWindow * 0.9);
    const tokensToAutoCompact = Math.max(0, autoCompactTriggerTokens - safeTotal);
    const dashOffset = CONTEXT_RING_CIRCUMFERENCE * (1 - pctUsed / 100);
    const tooltip = `Context: ${safeTotal.toLocaleString('en-US')} / ${safeWindow.toLocaleString('en-US')} tokens (${pctUsed}%) · ${tokensToAutoCompact.toLocaleString('en-US')} tokens to 90% auto-compact`;
    return {
        totalTokens: safeTotal,
        windowTokens: safeWindow,
        pctUsed,
        autoCompactTriggerTokens,
        tokensToAutoCompact,
        circumference: CONTEXT_RING_CIRCUMFERENCE,
        dashOffset,
        tooltip,
    };
};

export interface CollapsiblePromptSummary {
    collapsible: boolean;
    preview: string;
    lineCount: number;
}

/** Collapse long pasted prompts (> 6 lines or >= 420 chars with newlines) into a compact first-line pill. */
export const summarizeCollapsiblePrompt = (text: string): CollapsiblePromptSummary => {
    const normalized = text ?? '';
    const lines = normalized.split(/\r?\n/);
    const lineCount = lines.length;
    const collapsible = lineCount > 6 || (normalized.length >= 420 && lineCount > 1);
    const firstNonEmpty = lines.find(l => l.trim().length > 0)?.trim() ?? normalized.trim();
    const preview = firstNonEmpty.length > 72
        ? `${firstNonEmpty.slice(0, 71).trimEnd()}…`
        : (firstNonEmpty || '(empty prompt)');
    return { collapsible, preview, lineCount };
};
