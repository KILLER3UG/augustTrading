/**
 * signalService — emission, the two shadow checks, and settlement.
 *
 * EMISSION is a deterministic write: the tool's levels are validated here, not
 * by the model, and the record is appended before any shadow work starts. The
 * two shadows NEVER block an emission (owner scope, phase 1):
 *
 *  · gate   — the same programmatic gate `present_trade` runs, recorded as what
 *             it WOULD have said (status + confidence cap + reason);
 *  · ground — an evidence check: tool-like refs must name real desk tools,
 *             prose refs are citations the app cannot machine-check.
 *
 * SETTLEMENT is bounded and conservative: at most a few signals per pass, one
 * 5m OKX series each with a Binance cross-check, a 1m drill-down only when a
 * coarse bar contains both levels, and NO resolution when the tape does not
 * reach back to the emission (an app closed for a weekend must not read as
 * "never triggered").
 */

import type {
    SignalGateShadow,
    SignalGroundingShadow,
    SignalRecord,
    SignalResolution,
} from '../../types/signal';
import type { SignalCandle } from './signalResolver';
import { bracketError, resolveSignal, SIGNAL_BAR_MS } from './signalResolver';
import { appendSignalEvent, readSignals, recordSignalResolution } from './signalLedger';
import { signalProtectionVerdict } from './signalProtections';
import {
    crossCheckBars,
    fetchBinanceCandles,
    fetchOkxCandles,
    normalizeCoin,
    okxInstId,
    tapeCoversEmission,
} from './signalMarketData';
import { getActiveUsername } from '../../utils/activeUser';
import { DESK_TOOL_NAMES } from '../../utils/toolKinds';
import { baseRateFor, scoreSignals, type SignalScorecard } from './signalAccuracy';

/** Bump when the emit_signal description or parameter semantics change. The
 *  value is stored on every emission, so a later accuracy comparison can tell
 *  two prompt generations apart without guessing from dates. */
export const EMIT_SIGNAL_PROMPT_VERSION = 'emit-signal-v1';

export const MIN_EXPIRY_MINUTES = 15;
export const MAX_EXPIRY_MINUTES = 24 * 60;
/** How many open signals one settlement pass may fetch. A feed mount is a UI
 *  action; it must not fan out one series per signal ever emitted. */
export const MAX_SETTLE_PER_RUN = 4;
const SETTLE_COOLDOWN_MS = 60_000;

const fnv1a = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

export interface EmitSignalInput {
    coin?: unknown;
    direction?: unknown;
    entry?: unknown;
    stop?: unknown;
    target?: unknown;
    expiresInMinutes?: unknown;
    thesis?: unknown;
    evidence?: unknown;
}

export interface EmitSignalContext {
    defaultSymbol?: string | null;
    markAtEmit?: number | null;
    formingCandle?: { time: number; open: number; high: number; low: number; close: number } | null;
    provider?: string;
    model?: string;
    user?: string;
}

export type EmitSignalOutcome =
    | { ok: true; signal: SignalRecord }
    | { ok: false; error: string };

const asPrice = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

export const emitSignal = (input: EmitSignalInput, context: EmitSignalContext = {}): EmitSignalOutcome => {
    const coin = normalizeCoin(String(input.coin ?? context.defaultSymbol ?? ''));
    if (!coin) return { ok: false, error: 'coin is required (or open the chart on the instrument)' };
    const rawDirection = String(input.direction ?? '').toLowerCase();
    if (rawDirection !== 'long' && rawDirection !== 'short') {
        return { ok: false, error: 'direction must be long or short' };
    }
    const entry = asPrice(input.entry);
    const stop = asPrice(input.stop);
    const target = asPrice(input.target);
    if (entry === null || stop === null || target === null) {
        return { ok: false, error: 'entry, stop and target must be positive prices' };
    }
    const levels = { entry, stop, target };
    const bracket = bracketError(levels, rawDirection);
    if (bracket) return { ok: false, error: bracket };

    const minutes = Math.round(Number(input.expiresInMinutes));
    if (!Number.isFinite(minutes) || minutes < MIN_EXPIRY_MINUTES || minutes > MAX_EXPIRY_MINUTES) {
        return { ok: false, error: `expiresInMinutes must be between ${MIN_EXPIRY_MINUTES} and ${MAX_EXPIRY_MINUTES}` };
    }
    const thesis = String(input.thesis ?? '').trim();
    if (thesis.length < 8) return { ok: false, error: 'thesis is required — one sentence on what this call rests on' };
    const refs = (Array.isArray(input.evidence) ? input.evidence : [])
        .map(e => String(e ?? '').trim())
        .filter(Boolean)
        .slice(0, 8)
        .map(e => (e.length > 120 ? `${e.slice(0, 117)}…` : e));
    if (refs.length === 0) return { ok: false, error: 'evidence is required — name the readings or levels the call rests on' };

    const now = Date.now();
    const user = context.user ?? getActiveUsername();
    // Protections read SETTLED signals only: a losing streak, a drawdown or a
    // window that is not paying for its costs stops the next call from being
    // written at all. Refusing here keeps the ledger honest — no row for a
    // call the app would not stand behind.
    const protection = signalProtectionVerdict(
        readSignals(user).map(row => ({
            coin: row.signal.coin,
            direction: row.signal.direction,
            outcomeR: row.resolution ? row.resolution.outcomeR : null,
            settledAt: row.resolution ? row.resolution.at : null,
        })),
        { coin, direction: rawDirection, now },
    );
    if (protection.blocked) return { ok: false, error: protection.reason ?? 'signal blocked by a protection' };
    const mark = typeof context.markAtEmit === 'number' && Number.isFinite(context.markAtEmit)
        ? context.markAtEmit
        : undefined;
    const forming = context.formingCandle;
    const tape = [
        coin,
        mark ?? 'na',
        forming ? `${forming.time}:${forming.open}:${forming.high}:${forming.low}:${forming.close}` : 'na',
    ].join('|');
    const id = `sig-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const signal: SignalRecord = {
        id,
        coin,
        direction: rawDirection,
        ...levels,
        emittedAt: now,
        expiresAt: now + minutes * 60_000,
        evidenceRefs: refs,
        dataHash: fnv1a(tape),
        ...(mark !== undefined ? { markAtEmit: mark } : {}),
        provider: context.provider || 'unknown',
        model: context.model || 'unknown',
        promptVersion: EMIT_SIGNAL_PROMPT_VERSION,
        source: 'signal',
        thesis: thesis.length > 280 ? `${thesis.slice(0, 277)}…` : thesis,
    };

    const wrote = appendSignalEvent({ v: 1, type: 'emit', at: now, id, signal }, user);
    if (!wrote.ok) return { ok: false, error: `signal was not saved: ${wrote.error ?? 'storage refused'}` };

    // The evidence check is local and synchronous.
    const grounding = shadowGrounding(refs, now);
    appendSignalEvent({ v: 1, type: 'ground', at: now, id, grounding }, user);

    // The market gate is a network scan; it must not delay the answer.
    void shadowGate(signal, user);

    // The tracker adopts this open call from the ledger on its next pass. The
    // direct registration is immediate and carries the emission context; the
    // ledger adoption covers a signal emitted while the tracker was off.
    void import('../tracking/trackerService')
        .then(tracker => tracker.registerSignalForTracking(signal, user))
        .then(registered => {
            if (!registered.ok) console.warn('[Signal] tracker registration failed:', registered.error);
        })
        .catch(err => console.warn('[Signal] tracker registration failed:', err));

    return { ok: true, signal };
};

/** Tool-like refs (`snake_case`) must be real desk tools; anything with spaces
 *  is a prose citation the app cannot verify and does not pretend to. */
export const shadowGrounding = (refs: readonly string[], at: number = Date.now()): SignalGroundingShadow => {
    const toolLike = refs.filter(r => /^[a-z][a-z0-9_]*$/.test(r));
    const missing = toolLike.filter(r => !DESK_TOOL_NAMES.includes(r));
    if (refs.length === 0) return { at, verdict: 'uncited', missing: [] };
    return { at, verdict: missing.length > 0 ? 'missing' : 'cited', missing };
};

const shadowGate = async (signal: SignalRecord, user: string): Promise<void> => {
    let shadow: SignalGateShadow;
    try {
        const { fetchGateInputData, runProgrammaticGate } = await import('../validation/GateKeeperService');        const input = await fetchGateInputData(signal.coin, []);
        if (!input) {
            shadow = { status: 'unavailable', at: Date.now(), reason: 'market data fetch returned nothing' };
        } else {
            const out = runProgrammaticGate(input);
            shadow = out.pass
                ? { status: 'pass', at: Date.now(), confidenceCap: out.confidenceCap, reason: out.reason }
                : { status: 'refused', at: Date.now(), confidenceCap: out.confidenceCap, reason: out.reason };
        }
    } catch (e) {
        shadow = { status: 'unavailable', at: Date.now(), reason: e instanceof Error ? e.message : String(e) };
    }
    appendSignalEvent({ v: 1, type: 'gate', at: shadow.at, id: signal.id, gate: shadow }, user);
};

export interface SettleOutcome {
    attempted: number;
    resolved: number;
    skipped: { id: string; reason: string }[];
}

/** What the desk's resolved calls on this coin actually did, against the
 *  same-levels base rate. The emission receipt carries it so the NEXT call is
 *  made knowing how the last ones were graded. `thin` means the sample is too
 *  small to read — say so instead of claiming an edge. */
export const signalScorecard = (coin?: string, user: string = getActiveUsername()): SignalScorecard =>
    scoreSignals(readSignals(user).filter(r => !coin || r.signal.coin === coin));

let lastSettleAttempt = 0;

/**
 * Settle open signals that are worth a fetch. `force` bypasses the cooldown
 * (the feed's refresh), never the per-run bound.
 */
export const settleDueSignals = async (
    user: string = getActiveUsername(),
    options: { force?: boolean } = {},
): Promise<SettleOutcome> => {
    const now = Date.now();
    if (!options.force && now - lastSettleAttempt < SETTLE_COOLDOWN_MS) {
        return { attempted: 0, resolved: 0, skipped: [] };
    }
    lastSettleAttempt = now;
    const open = readSignals(user).filter(r => r.status === 'open').slice(0, MAX_SETTLE_PER_RUN);
    const out: SettleOutcome = { attempted: open.length, resolved: 0, skipped: [] };

    for (const row of open) {
        const signal = row.signal;
        const instId = okxInstId(signal.coin);
        let primary: SignalCandle[] | null = null;
        let primarySource: 'okx' | 'binance' = 'okx';
        if (instId) {
            const okx = await fetchOkxCandles(instId, '5m', 300);
            if (okx.ok && tapeCoversEmission(okx.candles, signal.emittedAt)) primary = okx.candles;
        }
        let cross: SignalCandle[] | null = null;
        if (primary) {
            cross = await fetchBinanceCandles(signal.coin, '5m', 300);
        } else {
            const binance = await fetchBinanceCandles(signal.coin, '5m', 300);
            if (binance && tapeCoversEmission(binance, signal.emittedAt)) {
                primary = binance;
                primarySource = 'binance';
            }
        }
        if (!primary) {
            out.skipped.push({ id: signal.id, reason: 'the tape does not reach back to this emission' });
            continue;
        }

        const first = resolveSignal(signal, primary, [], now);
        if (!first) {
            out.skipped.push({ id: signal.id, reason: 'still open' });
            continue;
        }
        let draft = first;
        if (first.ambiguous) {
            const drillCoarse = primary.find(c => c.time === first.exitAt);
            if (drillCoarse) {
                let minutes: SignalCandle[] | null;
                if (primarySource === 'okx') {
                    const drilled = await fetchOkxCandles(instId ?? '', '1m', 300);
                    minutes = drilled.ok ? drilled.candles : null;
                } else {
                    minutes = await fetchBinanceCandles(signal.coin, '1m', 300);
                }
                const inside = (minutes ?? []).filter(c =>
                    c.time >= drillCoarse.time && c.time < drillCoarse.time + SIGNAL_BAR_MS);
                if (inside.length > 0) draft = resolveSignal(signal, primary, inside, now) ?? first;
            }
        }

        const crossCheck = primarySource === 'okx'
            ? crossCheckBars(primary, cross, draft.usedBarTimes)
            : 'unavailable';
        // The baseline is computed where the tape already is. A resolution
        // written before this fold shipped simply has no `base` — the feed
        // says "no baseline", never 0.
        const base = baseRateFor(signal, primary) ?? undefined;
        const resolution: SignalResolution = {
            ...draft,
            at: Date.now(),
            crossCheck,
            primarySource,
            ...(base ? { base } : {}),
        };
        const wrote = recordSignalResolution(signal.id, resolution, user);
        if (wrote.ok) out.resolved += 1;
        else out.skipped.push({ id: signal.id, reason: wrote.error ?? 'the ledger refused the resolution' });
    }
    return out;
};
