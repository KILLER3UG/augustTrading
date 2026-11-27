/**
 * CommandBarModal — the unified Ctrl+K command palette (v1.8.1).
 *
 * Strictly matte per DESIGN.md: `rounded-xl` on the deepest surface
 * (`bg-zinc-950`), 1px hairlines, zero glassmorphism (no backdrop-blur), rows
 * at the >= 28px hit-target floor, right-aligned monospace hotkey hints, and
 * GPU-only motion (`motion-popover-in`: opacity + translate3d).
 *
 * It is an UPGRADE of the old Ctrl+K = New chat chord, not a second listener:
 * App's one Ctrl+K handler opens this bar, and New Chat lives inside it as a
 * command. Data (the command list + ranking) lives in `utils/commandBarCore`;
 * execution stays with App, which holds each command's target.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    COMMAND_BAR_GROUP_LABELS,
    filterAndRankCommands,
    type CommandBarItem,
} from '../../utils/commandBarCore';
import { Search } from '../shared/Icons';

export interface CommandBarModalProps {
    open: boolean;
    onClose: () => void;
    /** The snapshot's full command list (already built for the current ctx). */
    items: CommandBarItem[];
    onExecute: (item: CommandBarItem) => void;
}

const CommandBarModal: React.FC<CommandBarModalProps> = ({ open, onClose, items, onExecute }) => {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const activeRowRef = useRef<HTMLButtonElement | null>(null);

    const ranked = useMemo(() => filterAndRankCommands(items, query), [items, query]);

    // A fresh snapshot per open: the query and the cursor start clean, and the
    // input owns focus immediately (keyboard-first by contract).
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setActiveIndex(0);
        const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
        return () => window.clearTimeout(timer);
    }, [open]);

    // The ranked list shrinks as the query narrows — the cursor must never
    // point past the end.
    useEffect(() => {
        setActiveIndex(prev => Math.min(prev, Math.max(0, ranked.length - 1)));
    }, [ranked.length]);

    // Keyboard scrolling, not mouse scrolling: the active row follows the
    // cursor into view when the list outgrows the pane.
    useEffect(() => {
        activeRowRef.current?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    if (!open) return null;

    const executeAt = (index: number): void => {
        const item = ranked[index];
        if (!item) return;
        onClose();
        onExecute(item);
    };

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(i => Math.min(i + 1, Math.max(0, ranked.length - 1)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            executeAt(activeIndex);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    // Group headers re-render wherever the ranked order crosses a group
    // boundary — grouped as-built for an empty query, relevance-ordered (with
    // their origin named) under a query.
    let lastGroup: string | null = null;

    return (
        <div
            className="fixed inset-0 z-[70] flex items-start justify-center bg-black/70 px-4 pt-[12vh]"
            data-testid="command-bar-overlay"
            onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Command bar"
                data-testid="command-bar-modal"
                className="motion-popover-in w-full max-w-xl rounded-xl border border-hairline bg-zinc-950 shadow-elevated"
            >
                <div className="flex items-center gap-2 border-b border-hairline px-3">
                    <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden="true" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder="Type a command, symbol, timeframe…"
                        aria-label="Command bar search"
                        spellCheck={false}
                        data-testid="command-bar-input"
                        className="h-11 min-w-0 flex-1 bg-transparent font-mono text-ui-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
                    />
                    {/* The keycap hint is a promise: Escape closes, and the
                        handler above makes it true. */}
                    <kbd className="shrink-0 rounded-[4px] border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                        Esc
                    </kbd>
                </div>
                <div className="max-h-[46vh] overflow-y-auto p-1.5">
                    {ranked.length === 0 ? (
                        <p className="px-2 py-6 text-center font-mono text-ui-dense text-zinc-600" data-testid="command-bar-empty">
                            No matching command.
                        </p>
                    ) : (
                        ranked.map((item, index) => {
                            const header = item.group !== lastGroup ? COMMAND_BAR_GROUP_LABELS[item.group] : null;
                            lastGroup = item.group;
                            const active = index === activeIndex;
                            return (
                                <React.Fragment key={item.id}>
                                    {header && (
                                        <div className="px-2 pb-0.5 pt-1.5 font-mono text-ui-2xs uppercase tracking-wider text-zinc-600">
                                            {header}
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        ref={active ? activeRowRef : undefined}
                                        data-testid={`command-bar-item-${item.id}`}
                                        data-active={active ? 'true' : 'false'}
                                        onMouseMove={() => setActiveIndex(index)}
                                        onClick={() => executeAt(index)}
                                        className={`flex min-h-[28px] w-full items-center gap-2 rounded-control px-2 py-1 text-left transition-colors ${
                                            active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                                        }`}
                                    >
                                        <span className="min-w-0 flex-1 truncate font-mono text-ui-dense">{item.label}</span>
                                        {item.detail && (
                                            <span className="shrink-0 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500">
                                                {item.detail}
                                            </span>
                                        )}
                                        {item.hint && (
                                            <kbd className="shrink-0 rounded-[4px] border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-500">
                                                {item.hint}
                                            </kbd>
                                        )}
                                    </button>
                                </React.Fragment>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};

export default CommandBarModal;
