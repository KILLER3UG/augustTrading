/**
 * OrderBookPanel — the DOM ladder column from Minara's perps screen: asks
 * (red) stacked above the spread band, bids (green) below.
 *
 * Three columns, matching the reference: Price, Size, and Total — where Total
 * is the running depth from the spread outward. That cumulative figure is the
 * point: the bar behind each row is scaled to it, so the bar answers "how
 * much size is stacked from here to the spread", which is what a depth bar
 * has always been *trying* to say. Neither the REST ladder
 * (MarketDataService) nor the live stream carries a cumulative field, so it
 * is computed locally with withCumulative().
 *
 * Both sides share one bar scale on purpose, so the two ladders stay
 * comparable at a glance.
 *
 * Walls (≥3× the visible average) get weight, not colour.
 *
 * Polls fetchOrderBookDepth every 5s while the websocket is not up; the
 * service's 30s cache + futures rate budget keep the polling honest.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { fetchOrderBookDepth, type OrderBookData } from '../../services/analysis/MarketDataService';
import { fmtPercent, fmtPrice } from '../../utils/formatters';
import type { LiveDepth } from '../../services/trade/futuresStreams';

interface OrderBookPanelProps {
    symbol: string;
    /** Websocket depth20@100ms is up: the ladder comes from liveDepth and
     *  the 5s REST poll stops (it stays as the fallback). */
    live?: boolean;
    liveDepth?: LiveDepth | null;
    /** Bare mode: the ladder only, no page chrome (drawer + Book mode). */
    bare?: boolean;
}

const fmtQty = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toFixed(n >= 10 ? 1 : 3);
// fmtPrice lives in utils/formatters (audit 2026-09-16 dedupe — this file's
// copy was byte-identical to TradeView's).

/** Levels visible per side. 12 + 12 + the spread band fills the column at the
 *  panel's height without scrolling, which is why the body is overflow-hidden. */
const LADDER_DEPTH = 12;

/** One grid for the header, every row and the spread band, so the three
 *  columns line up. Price takes the slack; Size and Total are fixed because
 *  both are short numbers and must not reflow as quantities change. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] gap-x-1 px-2';

interface LadderLevel {
    price: number;
    qty: number;
    /** Running depth from the spread outward — the sum of every level at or
     *  nearer the spread than this one. This is the number the depth bar was
     *  always trying to show. */
    total: number;
}

/** Attach a running total, best-first in, so index 0 is nearest the spread. */
const withCumulative = (levels: { price: number; qty: number }[]): LadderLevel[] => {
    const out: LadderLevel[] = [];
    let run = 0;
    for (const l of levels) {
        run += l.qty;
        out.push({ price: l.price, qty: l.qty, total: run });
    }
    return out;
};

/** Wall = level ≥3× the average size of the visible ladder (the same rule
 *  the REST OrderBookData uses, recomputed locally for the live snapshot). */
const wallPrices = (levels: { price: number; qty: number }[]): Set<number> => {
    if (levels.length === 0) return new Set();
    const avg = levels.reduce((s, l) => s + l.qty, 0) / levels.length;
    return new Set(levels.filter(l => l.qty >= avg * 3).map(l => l.price));
};

const Row: React.FC<{ side: 'bid' | 'ask'; level: LadderLevel; maxTotal: number; wall: boolean }> = ({ side, level, maxTotal, wall }) => (
    <div
        data-testid="orderbook-row"
        className={`relative ${GRID} items-center py-[1.5px] font-mono text-ui-xs tabular-nums`}
    >
        <span
            aria-hidden
            className={`absolute inset-y-0 left-0 rounded-control ${side === 'bid' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}
            style={{ width: `${maxTotal > 0 ? Math.min(100, (level.total / maxTotal) * 100) : 0}%` }}
        />
        <span className={`relative truncate ${side === 'bid' ? 'text-emerald-400' : 'text-rose-400'} ${wall ? 'font-bold' : ''}`} title={fmtPrice(level.price)}>{fmtPrice(level.price)}</span>
        <span className={`relative text-right text-zinc-400 ${wall ? 'font-bold text-zinc-200' : ''}`}>{fmtQty(level.qty)}</span>
        <span className="relative text-right text-zinc-500">{fmtQty(level.total)}</span>
    </div>
);

/** Cold-start skeleton: the ladder's real grid geometry before the data
 *  exists, so the first paint reads "loading" instead of "broken" (no blank
 *  heavy surfaces — docs/product/ux/charter.md). Stock animate-pulse; no new
 *  keyframes for the motion inventory to chase. */
const SkeletonRow: React.FC<{ side: 'bid' | 'ask' }> = ({ side }) => (
    <div className={`${GRID} items-center py-[1.5px]`}>
        <span className={`h-3 w-2/3 animate-pulse rounded-control ${side === 'bid' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`} />
        <span className="ml-auto h-3 w-10 animate-pulse rounded-control bg-zinc-800/80" />
        <span className="ml-auto h-3 w-8 animate-pulse rounded-control bg-zinc-800/80" />
    </div>
);

const OrderBookPanel: React.FC<OrderBookPanelProps> = ({ symbol, live = false, liveDepth, bare = false }) => {
    const [book, setBook] = useState<OrderBookData | null>(null);
    // The poll's failure is a STATE, not a silence: a swallowed catch left a
    // permanently failing book indistinguishable from a loading one.
    const [bookFailed, setBookFailed] = useState(false);

    // Fallback poll only while the socket is down.
    useEffect(() => {
        if (live) return;
        let cancelled = false;
        let timer = 0;
        setBookFailed(false);
        const load = async (): Promise<void> => {
            try {
                const next = await fetchOrderBookDepth(symbol);
                if (!cancelled) {
                    setBook(next);
                    setBookFailed(false);
                }
            } catch {
                // Keep the last ladder on a failed poll — but SAY the poll is
                // failing (the header + the body below read this state).
                if (!cancelled) setBookFailed(true);
            }
            if (!cancelled) timer = window.setTimeout(() => void load(), 5000);
        };
        void load();
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [symbol, live]);

    const usingLive = live && !!liveDepth;
    // Skeleton only while genuinely LOADING (no book yet, no failure). A
    // loaded-but-empty book and a failing poll are their own honest states.
    const bookLoading = !usingLive && !book && !bookFailed;
    const asks = usingLive ? liveDepth!.asks : book?.asks ?? [];
    const bids = usingLive ? liveDepth!.bids : book?.bids ?? [];
    // Binance depth asks arrive ASCENDING (best ask first, index 0). Take the
    // 12 NEAREST levels first, THEN reverse so the ladder paints best-at-bottom
    // next to the spread. (Reversing before the slice kept the 12 FARTHEST asks
    // and discarded the near-spread ones — poisoning bestAsk, spread%, walls
    // and the dominance ratio.)
    const asksCum = withCumulative(asks.slice(0, LADDER_DEPTH));
    const bidsCum = withCumulative(bids.slice(0, LADDER_DEPTH));
    // The view is reversed AFTER the running total is attached, so the ask
    // sitting next to the spread still carries the full side depth.
    const asksView = asksCum.slice().reverse();
    const bidsView = bidsCum;
    // SHARED max across both sides, deliberately: scaling each side to its own
    // peak would make a side with twice the liquidity look identical, and the
    // whole point of a two-sided ladder is comparing them.
    const maxTotal = Math.max(
        1e-9,
        asksCum[asksCum.length - 1]?.total ?? 0,
        bidsCum[bidsCum.length - 1]?.total ?? 0,
    );
    const sellWalls = useMemo(() => wallPrices(asksView), [asksView]);
    const buyWalls = useMemo(() => wallPrices(bidsView), [bidsView]);
    const bestBid = bidsView[0]?.price ?? book?.bestBid ?? 0;
    const bestAsk = asksView[asksView.length - 1]?.price ?? book?.bestAsk ?? 0;
    const spreadValue = bestAsk && bestBid ? bestAsk - bestBid : 0;
    const spreadPercent = bestAsk && bestBid ? (spreadValue / bestAsk) * 100 : 0;
    // Perps quote tick sizes far below 0.001%, so a fixed 3-decimal format
    // renders a real 0.0001% spread as "0.000%" — which reads as "no spread"
    // rather than "one tick". Widen only when the value would otherwise round
    // to zero, so the common case keeps its compact 3-decimal form.
    const spreadPctText = fmtPercent(
        spreadPercent,
        spreadPercent > 0 && spreadPercent < 0.001 ? 4 : 3,
    );
    const askDepth = asksCum[asksCum.length - 1]?.total ?? 0;
    const bidDepth = bidsCum[bidsCum.length - 1]?.total ?? 0;
    const dominant: 'buyers' | 'sellers' | 'balanced' = usingLive
        ? (bidDepth > askDepth * 1.15 ? 'buyers' : askDepth > bidDepth * 1.15 ? 'sellers' : 'balanced')
        : book?.dominantSide ?? 'balanced';

    return (
        /* CHROME (the reference's frame): the book is a SECTION of a flat
           page, so it is separated from the chart by ONE HAIRLINE and carries
           no fill of its own. The old panel fill (zinc-900 at 40 %) was a
           second box down the middle of the surface. */
        <div className={`flex h-full min-h-0 flex-col ${bare ? '' : 'border-l border-white/[0.06]'}`}>
            {!bare && (
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.04] px-3 py-2.5">
                <h2 className="ui-kicker">Order Book</h2>
                {/* The feed state is a WORD, not a figure, so it wears the
                    interface face — the monospace is for the numbers in the
                    ladder below it. */}
                <span className={`text-ui-xs ${usingLive ? 'text-emerald-400' : asksView.length || bidsView.length ? 'text-zinc-600' : bookFailed ? 'text-rose-400' : 'text-zinc-600 animate-pulse'}`} title={usingLive ? 'depth20@100ms websocket' : 'REST poll every 5s'}>
                    {usingLive ? 'live' : asksView.length || bidsView.length ? `${dominant}` : bookFailed ? 'offline' : book ? 'empty' : 'loading'}
                </span>
            </div>
            )}
            {/* Column headers share the rows' grid so all three columns align.
                Labelled exactly like the metrics strip in TradeView (Stat's
                label class) rather than inventing a new micro-type style —
                the uppercase letter-spaced data label stays, because these
                are DATA columns; only the face follows the figures below
                them, so the words line up with the numbers. */}
            <div
                data-testid="orderbook-header"
                className={`${GRID} shrink-0 items-center py-1 font-mono text-ui-2xs uppercase tracking-wider text-zinc-500`}
            >
                <span>Price</span>
                <span className="text-right">Size</span>
                <span className="text-right">Total</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
                {bookLoading ? (
                    // Cold state: a skeleton ladder at the real geometry —
                    // asks above the spread band, bids below — instead of a
                    // lone "Loading book…" line in an empty column.
                    <div data-testid="orderbook-empty">
                        <p className="sr-only">Loading book…</p>
                        {Array.from({ length: LADDER_DEPTH }, (_, i) => <SkeletonRow key={`sa${i}`} side="ask" />)}
                    </div>
                ) : asksView.length === 0 && bidsView.length === 0 ? (
                    // Loaded-but-empty, or the poll is failing: say WHICH,
                    // instead of a skeleton that would never clear.
                    <p
                        data-testid={bookFailed ? 'orderbook-error' : 'orderbook-empty-book'}
                        className="px-2 py-3 text-ui-dense leading-5 text-zinc-500"
                    >
                        {bookFailed
                            ? 'Book unavailable — the exchange is not answering. Retrying every 5s.'
                            : 'No depth data in the book.'}
                    </p>
                ) : asksView.map(a => (
                    <Row key={`a${a.price}`} side="ask" level={a} maxTotal={maxTotal} wall={sellWalls.has(a.price)} />
                ))}
                {/* The spread band reuses the same grid, so it reads as a row
                    of the table rather than a banner: label in the price
                    column, the absolute spread in Size, the percentage in
                    Total. The hairlines above and below it are the section
                    separators — the band itself is no longer a filled strip,
                    because the reference separates a section with a line and
                    not with a colour. */}
                <div
                    data-testid="orderbook-spread"
                    className={`${GRID} my-1 items-center border-y border-white/[0.06] py-1 font-mono text-ui-xs tabular-nums text-zinc-400`}
                >
                    <span className={spreadPercent > 0.05 ? 'text-amber-400' : 'text-zinc-500'}>spread</span>
                    <span className="text-right text-zinc-300">{bestAsk && bestBid ? fmtPrice(spreadValue) : '—'}</span>
                    <span className={`text-right ${spreadPercent > 0.05 ? 'text-amber-400' : ''}`}>{spreadPctText}</span>
                </div>
                {bookLoading ? (
                    <div aria-hidden>
                        {Array.from({ length: LADDER_DEPTH }, (_, i) => <SkeletonRow key={`sb${i}`} side="bid" />)}
                    </div>
                ) : bidsView.map(b => (
                    <Row key={`b${b.price}`} side="bid" level={b} maxTotal={maxTotal} wall={buyWalls.has(b.price)} />
                ))}
            </div>
        </div>
    );
};

export default React.memo(OrderBookPanel);
