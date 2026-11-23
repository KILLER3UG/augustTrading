/**
 * futuresStreams — pure parsers for the Binance FUTURES websocket payloads
 * the trade surface consumes (wss://fstream.binance.com). Kept pure +
 * exported so the wire contract is unit-tested against recorded payloads
 * without opening a socket. All numeric fields arrive as strings.
 */

export interface LiveMarkIndex {
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
}

export interface LiveTicker {
    lastPrice: number;
    changePercent24h: number;
    quoteVolume24h: number;
}

export interface LiveLevel { price: number; qty: number }
export interface LiveDepth { bids: LiveLevel[]; asks: LiveLevel[] }

export interface LiveKline {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closed: boolean;
}

const num = (v: unknown): number => {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : NaN;
};

/** markPrice@1s: { e:'markPriceUpdate', p: mark, i: index, P: funding, T: next } */
export const parseMarkPrice = (msg: any): LiveMarkIndex | null => {
    if (!msg || msg.e !== 'markPriceUpdate') return null;
    const markPrice = num(msg.p);
    if (!Number.isFinite(markPrice)) return null;
    return { markPrice, indexPrice: num(msg.i), fundingRate: num(msg.P), nextFundingTime: num(msg.T) };
};

/** 24hrTicker: { e:'24hrTicker', c: last, P: pct, q: quoteVolume } */
export const parseTicker = (msg: any): LiveTicker | null => {
    if (!msg || msg.e !== '24hrTicker') return null;
    const lastPrice = num(msg.c);
    if (!Number.isFinite(lastPrice)) return null;
    return { lastPrice, changePercent24h: num(msg.P), quoteVolume24h: num(msg.q) };
};

const toLevels = (rows: unknown): LiveLevel[] => Array.isArray(rows)
    ? rows.map(r => ({ price: num(Array.isArray(r) ? r[0] : NaN), qty: num(Array.isArray(r) ? r[1] : NaN) }))
        .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty))
    : [];

/** depth20@100ms (diff-style update): { e:'depthUpdate', b: bids, a: asks } —
 *  a zero qty means "remove that level" and is filtered out. */
export const parseDepth = (msg: any): LiveDepth | null => {
    if (!msg || msg.e !== 'depthUpdate') return null;
    const bids = toLevels(msg.b).filter(l => l.qty > 0);
    const asks = toLevels(msg.a).filter(l => l.qty > 0);
    if (bids.length === 0 && asks.length === 0) return null;
    return { bids, asks };
};

/** kline_<interval>: { e:'kline', k: { t,o,h,l,c,v,x } } */
export const parseKline = (msg: any): LiveKline | null => {
    const k = msg?.k;
    if (!msg || msg.e !== 'kline' || !k) return null;
    const open = num(k.o), close = num(k.c);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
    return {
        openTime: num(k.t),
        open,
        high: num(k.h),
        low: num(k.l),
        close,
        volume: num(k.v),
        closed: !!k.x,
    };
};

/** Combined-stream envelope: { stream, data } → the inner payload. */
export const unwrapCombined = (raw: string): any => {
    try {
        const parsed = JSON.parse(raw);
        return parsed && parsed.data !== undefined ? parsed.data : parsed;
    } catch { return null; }
};

// ── shared live-frame cache (paper tick monitor) ────────────────────────────
//
// The Trade surface already owns a combined futures socket. Its parsed frames
// are published here so the paper broker can settle SL/TP/liquidation from the
// SAME intra-window high/low instead of a 30 s REST poll that synthesizes
// high=low=last (and therefore misses every wick that would have filled an
// order). This is pure module state: no socket, no timer, no network.

/** How old a cached frame may be before the paper monitor treats it as stale. */
export const PAPER_FRAME_FRESH_MS = 3000;

/** 8h Binance funding cadence — mirrors paperCore's slot boundary. */
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const fundingSlotOf = (at: number): number => Math.floor(at / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
const keyOf = (symbol: string): string => symbol.trim().toLowerCase();

export interface PaperLiveFrame {
    symbol: string;
    mark: number | null;
    fundingRate: number | null;
    /** Intra-window high/low from @kline_1s — the wicks REST cannot see. */
    high: number | null;
    low: number | null;
    last: number | null;
    /** Epoch ms of the LAST published frame of any kind. */
    at: number;
}

/** A funding observation bucketed to its 8h settlement slot. */
export interface PaperFundingObservation {
    slotMs: number;
    rate: number;
    markPrice: number;
}

interface PaperFrameEntry {
    frame: PaperLiveFrame;
    /** One last-observed rate+mark per UTC slot while that slot was open. */
    fundingBySlot: Map<number, PaperFundingObservation>;
}

const paperFrameCache = new Map<string, PaperFrameEntry>();
/** Refcount: how many mounted Trade/Desk feeds own a live symbol socket. */
const liveFeedOwners = new Map<string, number>();

const entryFor = (symbol: string): PaperFrameEntry => {
    const key = keyOf(symbol);
    let entry = paperFrameCache.get(key);
    if (!entry) {
        entry = {
            frame: { symbol: key, mark: null, fundingRate: null, high: null, low: null, last: null, at: 0 },
            fundingBySlot: new Map(),
        };
        paperFrameCache.set(key, entry);
    }
    return entry;
};

/** markPrice@1s frame: p = mark, P = funding rate. */
export const publishPaperMark = (
    symbol: string,
    markPrice: number,
    fundingRate: number | null,
    at: number = Date.now(),
): void => {
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    const entry = entryFor(symbol);
    entry.frame.mark = markPrice;
    if (entry.frame.last === null) entry.frame.last = markPrice;
    if (fundingRate !== null && Number.isFinite(fundingRate)) {
        entry.frame.fundingRate = fundingRate;
        entry.fundingBySlot.set(fundingSlotOf(at), {
            slotMs: fundingSlotOf(at), rate: fundingRate, markPrice,
        });
    }
    entry.frame.at = at;
};

/** kline_1s frame: the high/low wicks a 30 s poll would never observe. */
export const publishPaperKline = (
    symbol: string,
    kline: LiveKline,
    at: number = Date.now(),
): void => {
    if (!kline || !Number.isFinite(kline.high) || !Number.isFinite(kline.low)) return;
    const entry = entryFor(symbol);
    entry.frame.high = kline.high;
    entry.frame.low = kline.low;
    entry.frame.last = kline.close;
    entry.frame.at = at;
};

/** 24hrTicker frame: last traded price. */
export const publishPaperTicker = (
    symbol: string,
    lastPrice: number,
    at: number = Date.now(),
): void => {
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
    const entry = entryFor(symbol);
    entry.frame.last = lastPrice;
    entry.frame.at = at;
};

/** A copy of the newest frame, or null once it is older than `maxAgeMs`. */
export const getPaperLiveFrame = (
    symbol: string,
    maxAgeMs: number = PAPER_FRAME_FRESH_MS,
    nowMs: number = Date.now(),
): PaperLiveFrame | null => {
    const frame = paperFrameCache.get(keyOf(symbol))?.frame;
    if (!frame || frame.at <= 0) return null;
    const age = nowMs - frame.at;
    if (!Number.isFinite(age) || age < -1000 || age > maxAgeMs) return null;
    return { ...frame };
};

/** Funding observations for the crossed slots, one per slot when available. */
export const getFundingFramesForSlots = (
    symbol: string,
    slots: ReadonlyArray<number>,
): PaperFundingObservation[] => {
    const bySlot = paperFrameCache.get(keyOf(symbol))?.fundingBySlot;
    if (!bySlot) return [];
    return slots.flatMap(slot => {
        const obs = bySlot.get(slot);
        return obs ? [{ ...obs }] : [];
    });
};

/** Every recorded funding observation for the symbol (the core maps them by
 *  slot and ignores the ones it did not cross). */
export const getAllPaperFundingFrames = (symbol: string): PaperFundingObservation[] => {
    const bySlot = paperFrameCache.get(keyOf(symbol))?.fundingBySlot;
    return bySlot ? Array.from(bySlot.values()).map(o => ({ ...o })) : [];
};

/** A mounted Trade/Desk feed registers once per symbol (refcounted). */
export const registerLivePaperFeed = (symbol: string): (() => void) => {
    const key = keyOf(symbol);
    liveFeedOwners.set(key, (liveFeedOwners.get(key) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (liveFeedOwners.get(key) ?? 1) - 1;
        if (n <= 0) liveFeedOwners.delete(key); else liveFeedOwners.set(key, n);
    };
};

export const hasLivePaperFeed = (symbol: string): boolean =>
    (liveFeedOwners.get(keyOf(symbol)) ?? 0) > 0;

/** The broker opens its OWN combined socket ONLY when real exposure exists
 *  AND no Trade-surface feed already owns that symbol. Never a permanently
 *  open socket with nothing at risk. */
export const shouldOpenPaperWs = (symbol: string, hasExposure: boolean): boolean =>
    hasExposure && !hasLivePaperFeed(symbol);

/** Test hook — clears frame state and feed registrations between cases. */
export const resetPaperFrameCache = (): void => {
    paperFrameCache.clear();
    liveFeedOwners.clear();
};
