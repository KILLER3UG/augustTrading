/**
 * FloatingChartComposer — slim, non-glassmorphic matte composer pill rendered
 * near the bottom center of the chart when Full-Chart Focus (`Ctrl+\`) hides
 * the right chat dock.
 *
 * Dispatches normal prompts, `/slash` commands, and `/<skill-slug>` triggers
 * directly to the active Chart AI session without remounting the dock.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Minimize2, SendIcon } from '../shared/Icons';

export interface FloatingChartComposerProps {
    symbol: string;
    interval: string;
    onSend: (text: string) => void;
    onExitFocus: () => void;
}

export const FloatingChartComposer: React.FC<FloatingChartComposerProps> = ({
    symbol,
    interval,
    onSend,
    onExitFocus,
}) => {
    const [text, setText] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const onInject = (ev: Event): void => {
            const detail = (ev as CustomEvent<{ text?: string; focus?: boolean }>).detail;
            if (!detail?.text) return;
            setText(prev => (prev.trim() ? `${prev.trim()} ${detail.text}` : detail.text!));
            if (detail.focus !== false) inputRef.current?.focus();
        };
        window.addEventListener('august:composer-inject', onInject);
        return () => window.removeEventListener('august:composer-inject', onInject);
    }, []);

    const handleSubmit = (ev: React.FormEvent): void => {
        ev.preventDefault();
        const trimmed = text.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setText('');
    };

    return (
        <div
            data-testid="floating-chart-composer"
            className="pointer-events-auto absolute bottom-3 left-1/2 z-30 w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-lg border border-hairline bg-zinc-950 px-2 py-1.5 shadow-elevated"
        >
            <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
                <span className="shrink-0 rounded-control border border-hairline bg-zinc-900 px-1.5 py-0.5 font-mono text-ui-2xs text-zinc-400">
                    {symbol.replace(/USDT$/i, '')} · {interval}
                </span>
                <input
                    ref={inputRef}
                    type="text"
                    data-testid="floating-composer-input"
                    value={text}
                    onChange={ev => setText(ev.target.value)}
                    onKeyDown={ev => {
                        if (ev.key === 'Escape') {
                            ev.preventDefault();
                            ev.stopPropagation();
                            onExitFocus();
                        }
                    }}
                    placeholder="Ask August, run /compact, /plan, or /skill… (Ctrl+\ or Esc to exit)"
                    className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-ui-dense text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                />
                <button
                    type="submit"
                    data-testid="floating-composer-send"
                    disabled={!text.trim()}
                    aria-label="Send prompt from floating chart composer"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:opacity-30"
                >
                    <SendIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    data-testid="floating-composer-exit"
                    onClick={onExitFocus}
                    title="Exit Full-Chart Focus (Ctrl+\ or Esc)"
                    aria-label="Exit Full-Chart Focus"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-hairline text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                >
                    <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </form>
        </div>
    );
};

export default FloatingChartComposer;
