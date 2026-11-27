/**
 * commandBarCore — the pure command vocabulary and ranking for the unified
 * Ctrl+K command bar.
 *
 * The bar is ONE entry point to every app-level verb (it UPGRADES the old
 * Ctrl+K = New chat chord, it does not sit beside it). This module owns the
 * DATA: what commands exist, how they group, and how a query ranks them.
 * Execution stays with the callers that hold each command's target (App for
 * app-level verbs, the workspace stores for session-scoped ones) — a command
 * list that ran things itself would need the world imported into a util.
 *
 * Pure TypeScript: ZERO React, DOM, window, storage, or network imports
 * (`check:boundaries` enforces this).
 */

export type CommandBarGroup = 'desk' | 'symbols' | 'timeframes' | 'agent' | 'conversations';

export interface CommandBarItem {
    /** Stable id — also the `command-bar-item-<id>` testid suffix. */
    id: string;
    group: CommandBarGroup;
    label: string;
    /** Lowercase scoring corpus beyond the label (matched as words). */
    keywords: string;
    /** Right-aligned monospace hotkey hint (e.g. `Ctrl+\`). */
    hint?: string;
    /** Quiet secondary readout (current state, recent activity). */
    detail?: string;
}

export interface CommandBarContext {
    planModeOn: boolean;
    transcriptMode: 'normal' | 'audit' | 'calm';
    /** True when the workspace is in the centered Chat layout. */
    chatLayout: boolean;
    /** The symbol universe, best-first (the first three are pinned). */
    symbols: readonly string[];
    /** The chart's canonical timeframe ladder. */
    timeframes?: readonly string[];
    /** Existing recent threads, most recent first. */
    conversations: ReadonlyArray<{ id: string; title: string }>;
}

export const COMMAND_BAR_GROUP_LABELS: Record<CommandBarGroup, string> = {
    desk: 'Desk',
    symbols: 'Symbols',
    timeframes: 'Timeframes',
    agent: 'Agent & Settings',
    conversations: 'Conversations',
};

/** The default timeframe ladder — the same set the chart toolbar ships with. */
export const DEFAULT_COMMAND_BAR_TIMEFRAMES: readonly string[] = ['1m', '5m', '15m', '1h', '4h', '1D'];

/**
 * The full command list for one snapshot of the app. Group order is display
 * order; ids are stable so tests and the executor can key on them.
 */
export const buildCommandBarItems = (ctx: CommandBarContext): CommandBarItem[] => {
    const items: CommandBarItem[] = [
        {
            id: 'toggle-plan-mode',
            group: 'desk',
            label: 'Toggle Plan Mode',
            detail: ctx.planModeOn ? 'ON' : 'OFF',
            keywords: 'plan mode read-only locked unlock execution gate',
        },
        {
            id: 'cycle-transcript-mode',
            group: 'desk',
            label: 'Cycle Transcript Mode',
            detail: ctx.transcriptMode.charAt(0).toUpperCase() + ctx.transcriptMode.slice(1),
            hint: 'Ctrl+O',
            keywords: 'transcript view mode normal audit calm verbosity detail',
        },
        {
            id: 'toggle-chart-focus',
            group: 'desk',
            label: 'Toggle Full-Chart Focus',
            hint: 'Ctrl+\\',
            keywords: 'full chart focus fullscreen expand canvas hide dock',
        },
        {
            id: 'switch-layout',
            group: 'desk',
            label: 'Switch Desk / Chat layout',
            detail: ctx.chatLayout ? 'Chat' : 'Desk',
            hint: 'Alt+D',
            keywords: 'desk chat layout switch workspace centered column',
        },
        {
            id: 'new-chat',
            group: 'desk',
            label: 'New Chat',
            keywords: 'new chat conversation start blank desk',
        },
    ];

    for (const symbol of ctx.symbols) {
        items.push({
            id: `symbol:${symbol}`,
            group: 'symbols',
            label: symbol,
            keywords: `${symbol} symbol instrument switch chart market`,
        });
    }

    for (const tf of ctx.timeframes ?? DEFAULT_COMMAND_BAR_TIMEFRAMES) {
        items.push({
            id: `timeframe:${tf}`,
            group: 'timeframes',
            label: tf,
            keywords: `${tf} timeframe interval chart candles bars`,
        });
    }

    items.push(
        {
            id: 'run-compact',
            group: 'agent',
            label: '/compact',
            keywords: '/compact compact context thread summary shrink',
        },
        {
            id: 'run-dream',
            group: 'agent',
            label: '/dream',
            keywords: '/dream dream consolidation memory sleep',
        },
        {
            id: 'run-context',
            group: 'agent',
            label: '/context',
            keywords: '/context context diagnostic tokens window usage',
        },
        {
            id: 'run-doctor',
            group: 'agent',
            label: '/doctor',
            keywords: '/doctor doctor diagnostic health check',
        },
        {
            id: 'settings-models',
            group: 'agent',
            label: 'Settings → AI setup',
            detail: 'Benchmark model',
            keywords: 'settings ai setup provider model benchmark api key',
        },
        {
            id: 'settings-data',
            group: 'agent',
            label: 'Settings → Data',
            detail: 'Verified trajectories',
            keywords: 'settings data backup verified trajectories export restore',
        },
    );

    for (const convo of ctx.conversations) {
        items.push({
            id: `conversation:${convo.id}`,
            group: 'conversations',
            label: convo.title || 'Untitled',
            keywords: `${convo.title ?? ''} conversation open thread recent`,
        });
    }

    return items;
};

const scoreItem = (item: CommandBarItem, query: string, index: number): number => {
    const label = item.label.toLowerCase();
    if (!query) return 0;
    // Prefix match on the label outranks everything — typing "4h" wants the
    // timeframe, not a keyword mention.
    if (label.startsWith(query)) return 1000 - index;
    const wordStart = label.search(new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    if (wordStart >= 0) return 800 - index - wordStart;
    if (label.includes(query)) return 600 - index;
    if (item.keywords.includes(query)) return 400 - index;
    // Category match: the group label itself ("desk", "symbols", …).
    if (COMMAND_BAR_GROUP_LABELS[item.group].toLowerCase().includes(query)) return 200 - index;
    return -1;
};

/**
 * Deterministic scorer: prefix > word-boundary > substring > keyword >
 * category, ties broken by list order (which is group order). An empty query
 * returns the list as-is. Non-matching items are dropped; a query that
 * matches nothing yields an empty list and the modal shows its empty state.
 */
export const filterAndRankCommands = (items: CommandBarItem[], query: string): CommandBarItem[] => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items
        .map((item, index) => ({ item, score: scoreItem(item, q, index) }))
        .filter(row => row.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map(row => row.item);
};
