/**
 * KeyLevelsCard — the prototype's Key Levels table, living inside a Chart AI
 * message. When the model ends an answer with a `key-levels` block, the dock
 * renders this card under it: the levels as a table (Level · Price · Dist ·
 * Context) with a "chart" toggle, wired to the canvas exactly like the
 * prototype's table↔chart pair —
 *   · master switch ON  → every level draws as a dim dashed line + gutter tag
 *   · row click         → PIN the line (stays drawn with the switch off)
 *   · row hover         → full-strength preview of that line
 *   · the "last" divider→ mark price sits between the levels it is above/below
 * The resolved visibility is pushed UP as MessageLevelLines (TradeView holds
 * it, TradingChart paints it), so the chart stays the single renderer and the
 * card owns the whole interaction model — mirroring the prototype's
 * "LEVELS array is the single source of truth for table + chart" split.
 *
 * The card belongs to the coin it was drawn for: switching instruments
 * resets it (and TradeView blanks the lines with the strip).
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { deriveChartLines, formatDist, KEY_LEVEL_COLORS, type MessageLevelLines, type ModelKeyLevel } from '../../services/trade/keyLevels';
import { fmtPrice } from '../../utils/formatters';
import Disclosure from '../shared/Disclosure';

interface KeyLevelsCardProps {
    levels: ModelKeyLevel[];
    /** The instrument on the chart right now (the lines are stamped with it). */
    symbol: string;
    /** The message this card belongs to — the OWNERSHIP key on the shared
     *  chart-levels channel: unmount may only clear the layer if this card
     *  is the one that last drew it (multiple cards share the one channel). */
    messageId?: string;
    /** Freshest mark the canvas is showing (Dist column + the "last" divider). */
    getMark?: () => number | null;
    /** Push the resolved line set to the chart; null blanks it. The second
     *  argument is this card's id, so the channel owner can arbitrate whose
     *  clears count (card A unmounting must not null card B's live lines). */
    onChatLevels?: (payload: MessageLevelLines | null, ownerId?: string) => void;
}

/** Text tone per kind — CATEGORICAL markers (which kind of level), never a
 *  gain/loss read. Each row's left border is painted from KEY_LEVEL_COLORS in
 *  services/trade/keyLevels.ts — the very map the canvas draws from — so a
 *  legend swatch can never drift from the line it labels. */
const KIND_TEXT: Record<ModelKeyLevel['kind'], string> = {
    resistance: 'text-rose-400',
    support: 'text-emerald-400',
    vwap: 'text-zinc-300',
    level: 'text-amber-300',
};

const KeyLevelsCard: React.FC<KeyLevelsCardProps> = ({ levels, symbol, messageId, getMark, onChatLevels }) => {
    const [allOn, setAllOn] = useState(false);
    const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
    const [hoverId, setHoverId] = useState<string | null>(null);

    const lines = deriveChartLines(levels, { allOn, pinned, hoverId });
    const drawing = lines.some(l => l.state !== 'hidden');

    // Push the resolved set up whenever it CHANGES — a card never blanks the
    // layer on mount (an old card settling must not erase a live card's
    // lines; the most-recent card to draw owns the layer). Null lands only
    // when this card actively clears or unmounts while it was drawing —
    // and it carries THIS card's id so the shared channel can drop clears
    // from non-owners (card A's unmount must not null card B's lines).
    const pushRef = useRef(onChatLevels);
    pushRef.current = onChatLevels;
    // React's instance id, not a random literal: a fallback id minted per
    // mount was a NEW identity every remount, which orphaned the previous
    // owner in the shared channel. useId is stable for this slot in the tree.
    const reactId = useId();
    const cardIdRef = useRef<string>(messageId ?? `keylevels-${reactId.replace(/[^a-zA-Z0-9-]/g, '')}`);
    const pushedRef = useRef(false);
    const lastPushedSymbolRef = useRef(symbol);
    const signature = JSON.stringify([symbol, drawing ? lines : null]);
    useEffect(() => {
        // Coin switch: the signature changes while the draw state still holds
        // the PREVIOUS instrument's prices — pushing those stamped with the
        // new symbol paints them through the chart's symbol filter for one
        // commit before the reset effect settles. Drop the layer instead.
        if (lastPushedSymbolRef.current !== symbol) {
            lastPushedSymbolRef.current = symbol;
            if (pushedRef.current) pushRef.current?.(null, cardIdRef.current);
            pushedRef.current = false;
            return;
        }
        if (drawing) {
            pushRef.current?.({ symbol, lines }, cardIdRef.current);
            pushedRef.current = true;
        } else if (pushedRef.current) {
            pushRef.current?.(null, cardIdRef.current);
            pushedRef.current = false;
        }
    }, [signature]);
    useEffect(() => () => { if (pushedRef.current) pushRef.current?.(null, cardIdRef.current); }, []);

    // Coin switch: the levels belonged to the PREVIOUS instrument — drop the
    // user's draw state instead of silently repainting it on a new coin.
    const prevSymbolRef = useRef(symbol);
    useEffect(() => {
        if (prevSymbolRef.current === symbol) return;
        prevSymbolRef.current = symbol;
        setAllOn(false);
        setPinned(new Set());
        setHoverId(null);
    }, [symbol]);

    const mark = getMark?.() ?? null;
    // The prototype's "last" divider: after the levels above the mark.
    const splitAt = useMemo(() => {
        if (mark === null) return -1;
        const i = levels.findIndex(l => l.price <= mark);
        return i === -1 ? levels.length : i;
    }, [levels, mark]);

    const togglePin = useCallback((id: string): void => {
        setPinned(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const drawnCount = levels.length - lines.filter(l => l.state === 'hidden').length;

    return (
        <Disclosure
            summary={`Key levels · ${levels.length}`}
            label={`Key levels, ${levels.length} levels, disclosure`}
            testId="key-levels-disclosure"
            className="mt-2 overflow-hidden rounded-control border border-hairline bg-white/[0.015]"
            summaryClassName="flex items-center justify-between px-3 py-2 text-ui-xs font-bold uppercase tracking-[0.09em] text-zinc-400"
            bodyClassName=""
        >
        <div className="overflow-hidden" data-testid="key-levels-card"
            onMouseLeave={() => setHoverId(null)}>
            <div className="flex items-center justify-end px-3 py-1.5">
                <label
                    className="relative flex min-h-6 cursor-pointer items-center gap-1.5 py-0.5 text-ui-xs font-semibold text-zinc-500 transition-colors hover:text-zinc-300"
                    title={allOn ? 'Hide the other levels — pinned lines stay' : 'Draw every level on the chart'}
                >
                    {/* The input covers the label instead of being `sr-only`.
                        A clipped, absolutely positioned checkbox gives the
                        browser a 1×1 target at its STATIC position — thousands
                        of pixels down this card's scroll container — so
                        focusing it (a mouse click focuses too) scrolled the
                        app's hidden overflow container and moved the whole
                        surface out of view: the black screen. A full-size
                        transparent input focuses where the control actually
                        is, so the browser has nothing to scroll to. */}
                    <input
                        type="checkbox"
                        className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        checked={allOn}
                        onChange={ev => setAllOn(ev.target.checked)}
                        aria-label="Draw all key levels on the chart"
                        data-testid="key-levels-chart-toggle"
                    />
                    <span className={`relative inline-block h-3.5 w-6 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-zinc-950 ${allOn ? 'bg-emerald-500/40' : 'bg-zinc-700'}`} aria-hidden="true">
                        <span className={`absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full transition-[transform,background-color] duration-[150ms] ease-[var(--ease-snappy)] ${allOn ? 'translate-x-2.5 bg-emerald-400' : 'bg-zinc-500'}`} />
                    </span>
                    chart
                </label>
            </div>
            <div className="grid grid-cols-[42px_80px_52px_1fr] gap-x-2 border-y border-hairline px-3 py-1 text-ui-2xs font-bold uppercase tracking-[0.1em] text-zinc-600">
                <span>Level</span><span>Price</span><span>Dist</span><span>Context</span>
            </div>
            <div className="py-0.5">
                {levels.map((l, i) => (
                    <React.Fragment key={l.id}>
                        {i === splitAt && (
                            <div className="my-0.5 flex items-center justify-center gap-2 border-y border-dashed border-emerald-500/30 bg-emerald-500/[0.06] py-1 text-ui-dense text-emerald-400" data-testid="key-levels-last">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />
                                last <span className="font-mono font-bold tabular-nums">{fmtPrice(mark!)}</span>
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => togglePin(l.id)}
                            onMouseEnter={() => setHoverId(l.id)}
                            data-id={l.id}
                            aria-pressed={pinned.has(l.id)}
                            title={pinned.has(l.id) ? 'Unpin this level' : 'Pin this level — stays drawn with the switch off'}
                            style={{ borderLeftColor: KEY_LEVEL_COLORS[l.kind] }}
                            className={`grid w-full grid-cols-[42px_80px_52px_1fr] items-center gap-x-2 border-l-[3px] px-3 py-1.5 text-left transition-colors hover:bg-white/[0.04] ${pinned.has(l.id) ? 'bg-white/[0.05]' : ''}`}
                        >
                            <span className={`text-ui-dense font-bold ${KIND_TEXT[l.kind]}`}>{l.label}{pinned.has(l.id) && <span className="ml-0.5 text-cyan-400" aria-hidden="true">⌖</span>}</span>
                            <span className="font-mono text-ui-dense tabular-nums text-zinc-200">{fmtPrice(l.price)}</span>
                            <span className={`font-mono text-ui-2xs tabular-nums ${KIND_TEXT[l.kind]}`}>{formatDist(l.price, mark)}</span>
                            <span className="line-clamp-2 text-ui-dense leading-4 text-zinc-400" title={l.context}>{l.context}</span>
                        </button>
                    </React.Fragment>
                ))}
            </div>
            <div className="border-t border-hairline px-3 py-1.5 text-ui-xs text-zinc-600">
                hover = preview on chart · click = pin / unpin
                {drawing && <span className="ml-2 text-emerald-400">· {drawnCount} drawn</span>}
            </div>
        </div>
        </Disclosure>
    );
};

export default React.memo(KeyLevelsCard);
