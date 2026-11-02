/**
 * OutcomeAutopilotService — watches PENDING analyses and detects when their
 * SL/TP levels are hit, resolving outcomes automatically (user confirms).
 *
 * Detection reuses AutoCaptureService.verifyHistoricalOutcome (kline-based,
 * direction-aware crossing semantics, extended-SL-zone aware), so results are
 * authoritative and survive app restarts/time gaps. Runs a 60s loop only while
 * registrations exist; pauses with the app on native platforms.
 *
 * Flow: App registers PENDING messages → loop verifies → resolution stored +
 * listeners notified → AnalysisResult banner → user confirms → App logs via
 * the existing logTradeWithFeedback funnel (side-effects fire exactly once)
 * → markProcessed prevents re-detection.
 */

import { Capacitor } from '@capacitor/core';
import { LoggedTrade, TradeAnalysis } from '../../types';
import { TradeOutcome } from '../../types';
import { getPreferenceObject, setPreferenceObject, PREF_KEYS } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';
import { verifyHistoricalOutcome, extractSymbolFromAnalysis } from './AutoCaptureService';
import { trackSLOutcome, SLOptimizationData } from '../backtesting/StopLossOptimizerService';
import { parsePrice, leveragedMovePercent } from '../../utils/analysisUtils';
import { LEGACY_LEVERAGE } from '../../utils/conversationUtils';
import { PriceAlertService } from './PriceAlertService';

export interface AutopilotResolution {
    /** Resolved outcome (EXPIRED_OPEN uses expiredOpen flag with WIN/LOSS-neutral handling). */
    outcome: TradeOutcome.WIN | TradeOutcome.LOSS | TradeOutcome.ENTRY_NOT_HIT;
    /** Setup expired while still open — needs a manual decision, no direct log. */
    expiredOpen: boolean;
    /** Leveraged PnL percent from the analysis (e.g. +200 or -100). */
    pnlPercent?: number;
    /** Price level that decided the outcome. */
    hitLevel?: string;
    /** TP1 / TP2 / TP3 / SL. */
    hitTarget?: string;
    /** Win confidence tier: the SL was touched before price recovered to the TP. */
    recoveredAfterSlTouch?: boolean;
    /** Human-readable summary for the banner. */
    detail: string;
    detectedAt: string;
    timeToOutcome?: string;
    slOptimizationData?: SLOptimizationData;
    /** MAE/MFE the verification measured over the held window, RAW price percent
     *  (the row scales by its own leverage when it writes). Carried through so a
     *  trade confirmed by the autopilot is not excursion-less unless no post-
     *  mortem ever runs on it. */
    excursions?: { maePercent: number; mfePercent: number };
    /** Realized R measured from price levels — set whenever the exit resolved,
     *  so an autopilot row carries the canonical outcome label by itself. */
    realizedR?: number;
}

interface Registration {
    messageId: string;
    analysis: TradeAnalysis;
    leverage: number;
    registeredAt: string;
    lastTickPrice?: number;
    /** Release for the ref-counted PriceAlertService feed hold acquired at
     *  registration — without it, autopilot-only coins never receive ticks
     *  and the subscribeTicks episodes silently never accumulate. */
    releaseSymbolTracking?: () => void;
}

/** Per-profile slice of the persisted autopilot state. */
interface PersistedUserState {
    processed: string[];  // message ids confirmed/logged — never re-detect
    dismissed: string[];  // user dismissed the banner
    /** Resolutions already announced while settlement is in shadow mode.
     *  Shadow outcomes are never logged, so without this list the same old
     *  outcome re-resolved and re-toasted on every launch. */
    shadowNotified?: string[];
}

/** Legacy (pre-scoping) global shape: one flat processed/dismissed pair. */
interface LegacyPersistedState {
    processed?: string[];
    dismissed?: string[];
}

/** Current shape: a per-username partition map, e.g. `{ alice: {...} }`. */
type PersistedPartitions = Record<string, PersistedUserState>;

type Listener = (messageId: string, resolution: AutopilotResolution) => void;
type TickListener = (messageId: string, price: number, previousPrice?: number) => void;

const CHECK_INTERVAL_MS = 20_000;

/**
 * Interpret whatever is on disk under `outcome_autopilot_state` as a
 * partition map. The legacy global shape ({processed, dismissed}) has no
 * owner — callers attribute it separately (read-fallback for the loading
 * profile); here it contributes no partitions.
 */
const normalizePartitions = (stored: unknown): PersistedPartitions => {
    const out: PersistedPartitions = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (key === 'processed' || key === 'dismissed') continue; // legacy leaves
        const v = value as Partial<PersistedUserState> | null;
        if (v && Array.isArray(v.processed) && Array.isArray(v.dismissed)) {
            out[key] = {
                processed: v.processed.filter((x): x is string => typeof x === 'string'),
                dismissed: v.dismissed.filter((x): x is string => typeof x === 'string'),
                shadowNotified: Array.isArray(v.shadowNotified)
                    ? v.shadowNotified.filter((x): x is string => typeof x === 'string')
                    : [],
            };
        }
    }
    return out;
};

// How many processed/dismissed message ids to keep. MUST match between the
// in-memory trim (pruneIdSets) and persist() — if disk kept fewer than
// memory, messages outside the disk window became re-detectable after a
// restart and produced duplicate banners/logs.
const MAX_TRACKED_IDS = 2000;

class OutcomeAutopilotServiceClass {
    private registrations = new Map<string, Registration>();
    private resolutions = new Map<string, AutopilotResolution>();
    private dismissed = new Set<string>();
    private processed = new Set<string>();
    private shadowNotified = new Set<string>();
    private listeners = new Set<Listener>();
    private tickListeners = new Set<TickListener>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private checkPromise: Promise<void> | null = null;
    private initialized = false;
    /** Profile the in-memory sets were loaded for (partition owner). */
    private loadedUser: string | null = null;
    /** Bumped by init/reset so a superseded async load can't write state. */
    private initGeneration = 0;
    /** Last-known partition map (read-modify-write target for persist). */
    private partitions: PersistedPartitions = {};
    /** Serialize the read-modify-write cycles against the shared global key
     *  — two overlapping persists would otherwise lose one partition. */
    private writeChain: Promise<void> = Promise.resolve();

    /** Load persisted state for a profile. Re-init for a DIFFERENT user
     *  reloads their partition (the old unconditional `if (initialized)
     *  return;` made post-switch init a no-op, leaving the outgoing user's
     *  processed/dismissed sets in place — duplicate banners and possible
     *  auto-logs of pre-switch outcomes). */
    async init(username?: string): Promise<void> {
        const user = username ?? getActiveUsername();
        if (this.initialized && this.loadedUser === user) return;
        const gen = ++this.initGeneration;
        // Release every feed hold BEFORE dropping the map — init can be
        // called for a different user WITHOUT a preceding reset() (the
        // loader does reset first, but the guard here must not leak the
        // outgoing user's trackSymbol ref-counts either).
        for (const reg of this.registrations.values()) reg.releaseSymbolTracking?.();
        this.registrations.clear();
        this.resolutions.clear();
        this.processed.clear();
        this.dismissed.clear();
        this.shadowNotified.clear();
        this.loadedUser = user;
        try {
            const stored = await getPreferenceObject<LegacyPersistedState & PersistedPartitions>(
                PREF_KEYS.OUTCOME_AUTOPILOT_STATE
            );
            if (gen !== this.initGeneration || this.loadedUser !== user) return;
            this.partitions = normalizePartitions(stored);
            const isLegacy = !!stored && (Array.isArray(stored.processed) || Array.isArray(stored.dismissed));
            // Read-fallback: the legacy global pair is attributed to the
            // profile that loads it first (then re-persisted partitioned).
            const mine = isLegacy
                ? { processed: stored.processed || [], dismissed: stored.dismissed || [] }
                : this.partitions[user];
            if (mine) {
                (mine.processed || []).forEach(id => this.processed.add(id));
                (mine.dismissed || []).forEach(id => this.dismissed.add(id));
                (mine.shadowNotified || []).forEach(id => this.shadowNotified.add(id));
                this.pruneIdSets();
            }
            if (isLegacy) void this.persist(); // migrate to the partition map
        } catch (err) {
            console.warn('[OutcomeAutopilot] Failed to load state:', err);
            if (gen !== this.initGeneration || this.loadedUser !== user) return;
        }
        this.registerLifecycle();
        this.initialized = true;
        console.log(`[OutcomeAutopilot] Initialized for ${user} (${this.processed.size} processed, ${this.dismissed.size} dismissed)`);
    }

    /**
     * Track a pending analysis. No-op for processed/dismissed messages.
     * A re-registration of a KNOWN id UPDATES the entry instead of returning
     * early: useWatchAndAutopilot re-registers everything when the
     * conversation leverage changes and used to rely on this call to refresh
     * the authoritative `reg.leverage` used by every later PnL resolution
     * (it stayed stale while register early-returned on existing id).
     */
    register(messageId: string, analysis: TradeAnalysis, leverage: number): void {
        if (this.processed.has(messageId) || this.dismissed.has(messageId)
            || this.shadowNotified.has(messageId)) return;
        const lev = leverage || LEGACY_LEVERAGE;
        const existing = this.registrations.get(messageId);
        if (existing) {
            // Symmetric re-hold: the update can swap in an analysis for a NEW
            // symbol while registeredAt (and the acquired feed hold) stay from
            // the old registration. Release the old symbol's hold and acquire
            // for the new one, or the ref-count pins a coin we no longer watch
            // and the new coin silently starves of ticks.
            const previousSymbol = extractSymbolFromAnalysis(existing.analysis);
            existing.analysis = analysis;
            existing.leverage = lev;
            const nextSymbol = extractSymbolFromAnalysis(analysis);
            if (nextSymbol !== previousSymbol) {
                existing.releaseSymbolTracking?.();
                existing.releaseSymbolTracking = nextSymbol ? PriceAlertService.acquireSymbol(nextSymbol) : undefined;
            }
            this.ensureLoop();
            void this.runChecks();
            return;
        }
        if (analysis.confidence === 'Avoid' || analysis.direction === 'Neutral') {
            return;
        }
        if (analysis.direction !== 'Long' && analysis.direction !== 'Short') return;
        const registration: Registration = {
            messageId,
            analysis,
            leverage: lev,
            registeredAt: new Date().toISOString(),
        };
        // Guarantee the feed streams this coin while the registration is
        // alive, even when no price alert / setup watch tracks it (:279
        // subscribeTicks was silently dead for untracked symbols).
        const symbol = extractSymbolFromAnalysis(analysis);
        if (symbol) registration.releaseSymbolTracking = PriceAlertService.acquireSymbol(symbol);
        this.registrations.set(messageId, registration);
        this.ensureLoop();
        void this.runChecks();
    }

    /** Stop tracking (message logged, deleted, or outcome set manually). */
    unregister(messageId: string): void {
        this.dropRegistration(messageId);
        this.stopLoopIfEmpty();
    }

    /** Delete one registration and release its feed hold (single choke point
     *  so every removal path — resolve, dismiss, expiry drops — cleans up). */
    private dropRegistration(messageId: string): void {
        const reg = this.registrations.get(messageId);
        if (!reg) return;
        reg.releaseSymbolTracking?.();
        this.registrations.delete(messageId);
    }

    /** User dismissed the banner for this message. */
    dismiss(messageId: string): void {
        this.dismissed.add(messageId);
        this.pruneIdSets();
        this.resolutions.delete(messageId);
        this.dropRegistration(messageId);
        this.stopLoopIfEmpty();
        void this.persist();
    }

    /** Called after the user confirms/logs — prevents re-detection forever. */
    markProcessed(messageId: string): void {
        this.processed.add(messageId);
        this.pruneIdSets();
        this.resolutions.delete(messageId);
        this.dropRegistration(messageId);
        this.stopLoopIfEmpty();
        void this.persist();
    }

    /**
     * The shadow settlement announced this outcome; it will never be logged.
     * Persist the announcement so a restart does not re-verify the old setup
     * and toast the same outcome again. Returns false for a repeat.
     */
    markShadowNotified(messageId: string): boolean {
        if (this.shadowNotified.has(messageId)) return false;
        this.shadowNotified.add(messageId);
        this.pruneIdSets();
        // The outcome stays available for this session's banner; only future
        // registrations are suppressed. Drop the registration like a resolved
        // one so the loop stops polling a settled setup.
        this.dropRegistration(messageId);
        this.stopLoopIfEmpty();
        void this.persist();
        return true;
    }

    /**
     * Cap the persisted processed/dismissed id lists — they grew unbounded
     * (one entry per resolved analysis, forever). Old entries are only used
     * to suppress re-detection of messages that no longer exist anyway, so
     * the most recent window is sufficient.
     */
    private pruneIdSets(): void {
        const trim = (set: Set<string>): void => {
            if (set.size <= MAX_TRACKED_IDS) return;
            const entries = [...set];
            set.clear();
            entries.slice(-MAX_TRACKED_IDS).forEach(id => set.add(id));
        };
        trim(this.processed);
        trim(this.dismissed);
        trim(this.shadowNotified);
    }

    getResolution(messageId: string): AutopilotResolution | undefined {
        if (this.dismissed.has(messageId) || this.processed.has(messageId)) return undefined;
        return this.resolutions.get(messageId);
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    subscribeTicks(cb: TickListener): () => void {
        this.tickListeners.add(cb);
        return () => this.tickListeners.delete(cb);
    }

    /** Run a verification pass immediately (startup catch-up). */
    async checkNow(): Promise<void> {
        await this.runChecks();
    }

    /**
     * Clear every registration/resolution for the previous profile and stop
     * the loop. Called on profile switch — otherwise the singleton keeps
     * kline-verifying the old user's pending analyses and the processed/
     * dismissed sets leak across profiles.
     *
     * The old version persisted EMPTY sets to the global key (destroying the
     * incoming user's history on every switch) while `initialized` stayed
     * true, so the follow-up init() never reloaded. Now the persisted state
     * is a per-username partition map: reset clears ONLY the outgoing user's
     * partition in storage (their processed/dismissed history should not
     * resurrect re-detect after a logout-relogin either — matches the old
     * global behavior, minus the cross-user damage) and drops `initialized`
     * so the incoming user's init() actually loads their own partition.
     */
    reset(): void {
        this.initGeneration++;
        for (const reg of this.registrations.values()) reg.releaseSymbolTracking?.();
        this.registrations.clear();
        this.resolutions.clear();
        this.dismissed.clear();
        this.processed.clear();
        this.shadowNotified.clear();
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        const outgoing = this.loadedUser;
        this.loadedUser = null;
        this.initialized = false;
        this.partitions = {};
        if (outgoing) {
            this.writeChain = this.writeChain
                .then(async () => {
                    const stored = await getPreferenceObject<LegacyPersistedState & PersistedPartitions>(
                        PREF_KEYS.OUTCOME_AUTOPILOT_STATE
                    );
                    const map = normalizePartitions(stored);
                    if (!(outgoing in map)) return; // nothing of theirs to clear
                    delete map[outgoing];
                    await setPreferenceObject(PREF_KEYS.OUTCOME_AUTOPILOT_STATE, map);
                })
                .catch(err => console.warn('[OutcomeAutopilot] Failed to clear outgoing partition:', err));
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private ensureLoop(): void {
        if (this.timer || this.registrations.size === 0) return;
        this.timer = setInterval(() => void this.runChecks(), CHECK_INTERVAL_MS);
    }

    private stopLoopIfEmpty(): void {
        if (this.registrations.size === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private registerLifecycle(): void {
        try {
            if (!Capacitor.isNativePlatform()) return;
            void (async () => {
                const { App } = await import('@capacitor/app');
                App.addListener('appStateChange', ({ isActive }) => {
                    if (isActive) {
                        this.ensureLoop();
                        void this.runChecks(); // catch up on what happened while away
                    } else {
                        if (this.timer) {
                            clearInterval(this.timer);
                            this.timer = null;
                        }
                    }
                });
            })();
        } catch (err) {
            console.warn('[OutcomeAutopilot] Native lifecycle not registered:', err);
        }
    }

    private async runChecks(): Promise<void> {
        if (this.checkPromise) return this.checkPromise;
        if (this.registrations.size === 0) return;
        this.checkPromise = (async () => {
            for (const messageId of [...this.registrations.keys()]) {
                const reg = this.registrations.get(messageId);
                if (!reg) continue;
                try {
                    await this.verifyOne(reg);
                } catch (err) {
                    console.warn(`[OutcomeAutopilot] Verification failed for ${messageId}:`, err);
                }
            }
        })().finally(() => {
            this.checkPromise = null;
        });
        return this.checkPromise;
    }

    private async verifyOne(reg: Registration): Promise<void> {
        const { messageId, analysis } = reg;
        const symbol = extractSymbolFromAnalysis(analysis);
        const createdAt = analysis.createdAt || reg.registeredAt;
        if (!symbol) {
            this.dropRegistration(messageId);
            return;
        }

        const result = await verifyHistoricalOutcome(analysis, symbol, createdAt, undefined, { excludeFormingCandle: false });
        if (!result.verified && result.outcome === 'INSUFFICIENT_DATA') {
            // Don't watch forever: a permanently dead kline source (delisted
            // symbol, no data yet on a fresh pair) would re-verify every 60s
            // indefinitely. Drop once the setup's validity window has expired,
            // or after a hard 7-day cap on observation.
            const watchedMs = Date.now() - new Date(reg.registeredAt).getTime();
            if (this.isExpired(analysis) || watchedMs > 7 * 24 * 60 * 60 * 1000) {
                this.dropRegistration(messageId);
                this.stopLoopIfEmpty();
                console.warn(`[OutcomeAutopilot] ${messageId} dropped after insufficient data (watched ${Math.round(watchedMs / 36e5)}h).`);
            }
            return; // try again later
        }

        const expired = this.isExpired(analysis);

        const livePrice = PriceAlertService.getCurrentPrice(symbol);
        if (livePrice && this.tickListeners.size > 0) {
            const previous = reg.lastTickPrice;
            reg.lastTickPrice = livePrice;
            this.tickListeners.forEach(cb => {
                try { cb(messageId, livePrice, previous); }
                catch (err) { console.warn('[OutcomeAutopilot] Tick listener error:', err); }
            });
        }

        if (result.outcome === 'TP_HIT') {
            this.resolve(messageId, this.buildWinResolution(reg, result));
        } else if (result.outcome === 'SL_HIT') {
            this.resolve(messageId, this.buildLossResolution(reg, result));
        } else if (result.outcome === 'ENTRY_NOT_TRIGGERED' && expired) {
            this.resolve(messageId, {
                outcome: TradeOutcome.ENTRY_NOT_HIT,
                expiredOpen: false,
                detail: 'Validity window expired without triggering the entry.',
                detectedAt: new Date().toISOString(),
            });
        } else if (result.outcome === 'STILL_OPEN' && expired) {
            this.resolve(messageId, {
                outcome: TradeOutcome.ENTRY_NOT_HIT, // closest loggable outcome
                expiredOpen: true,
                detail: 'Setup expired while still open — review and decide manually.',
                detectedAt: new Date().toISOString(),
            });
        }

        // Otherwise: still live — keep watching. But never forever: a setup
        // without a validity window that never hits SL/TP would otherwise poll
        // Binance every 60s indefinitely (the 7-day cap below used to apply
        // only to the INSUFFICIENT_DATA branch).
        const watchedMs = Date.now() - new Date(reg.registeredAt).getTime();
        if (watchedMs > 7 * 24 * 60 * 60 * 1000) {
            this.dropRegistration(messageId);
            this.stopLoopIfEmpty();
            console.warn(`[OutcomeAutopilot] ${messageId} dropped after 7-day observation cap (setup never resolved).`);
        }
    }

    private isExpired(analysis: TradeAnalysis): boolean {
        if (!analysis.createdAt || !analysis.validityDurationMinutes) return false;
        const expiry = new Date(analysis.createdAt).getTime() + analysis.validityDurationMinutes * 60_000;
        return Date.now() > expiry;
    }

    /**
     * Realized leveraged PnL % from price levels. Recomputing from the hit
     * price and the REGISTERED leverage is authoritative — the analysis-time
     * `percentage` fields were computed at analysis time with that session's
     * leverage and can be stale. Returns undefined when prices don't parse
     * (callers fall back to the stored percentages).
     */
    private computePnLFromPrice(
        reg: Registration,
        exitPrice: number
    ): number | undefined {
        const entry = parsePrice(reg.analysis.entryPoints?.[0]?.price || '');
        if (isNaN(entry) || entry <= 0 || isNaN(exitPrice) || exitPrice <= 0) return undefined;
        const pct = leveragedMovePercent(reg.analysis.entryPoints?.[0]?.price, String(exitPrice), reg.leverage, 'gain');
        if (!pct) return undefined;
        return Math.round(Math.abs(parseFloat(pct)) * 10) / 10;
    }

    /**
     * Detect a TP1 → breakeven-managed scale-out: the verifier records an
     * entry-priced stop fill (breakeven) alongside exactly one TP hit (TP1).
     * In that case only the TP1 leg realized the full move — the remainder
     * exited flat at entry, so the realized PnL is ~half of TP1%.
     */
    private isBreakevenScaleOut(
        reg: Registration,
        result: Awaited<ReturnType<typeof verifyHistoricalOutcome>>
    ): boolean {
        if (!result.slHit || result.tpHits?.length !== 1 || result.tpHits[0].level !== 'TP1') return false;
        const entry = parsePrice(reg.analysis.entryPoints?.[0]?.price || '');
        // 5 bps tolerance — tight enough that a genuine stop within 0.1% of
        // entry isn't misread as a breakeven-managed exit (which halves PnL).
        return !isNaN(entry) && entry > 0 && Math.abs((result.slHit.price ?? 0) - entry) / entry < 0.0005;
    }

    private buildWinResolution(
        reg: Registration,
        result: Awaited<ReturnType<typeof verifyHistoricalOutcome>>
    ): AutopilotResolution {
        const { analysis } = reg;
        const hitTarget = result.hitTarget || 'TP1';
        // Leveraged % recomputed from the actual hit price with the
        // REGISTERED leverage (the analysis-time percentage may carry a
        // stale leverage and ignores scale-outs).
        const scaleOutDetected = this.isBreakevenScaleOut(reg, result);
        // `result.priceAtHit` IS the engine's `resolution.exitPrice`, and the engine
        // already blends the scale-out: a TP1→breakeven exit is (TP1 + entry)/2 and a
        // TP1→TP3 run is (TP1 + TP3)/2 (services/backtesting/outcomeEngine.ts:319-344,
        // whose header says the blend exists because without it "a half-out trade …
        // ~2× inflates realizedR"). Two copies of that arithmetic sat here — a second
        // `0.5` factor AND a re-midpoint of the same tpHits — and the factor measured
        // 25 % on a trade whose own canonical `realizedR` was 0.5R, i.e. 50 % at the
        // same leverage: one exit, two money figures on the same row
        // (the 2026-10-27 audit A-4). The engine is the single source; `scaleOutDetected`
        // still earns its keep below, where it stops a breakeven scale-out from being
        // reported as an SL touch.
        const hitPrice = result.priceAtHit ?? NaN;
        const recomputed = this.computePnLFromPrice(reg, hitPrice);
        let pnlPercent = recomputed;
        if (pnlPercent === undefined) {
            // Fallback: analysis-time percentage.
            const tpIndex = hitTarget === 'TP2' ? 1 : hitTarget === 'TP3' ? 2 : 0;
            pnlPercent = this.parsePercent(analysis.takeProfit?.[tpIndex]?.percentage || analysis.takeProfit?.[0]?.percentage || '');
        }
        // `priceAtHit` is the engine's BLENDED exit, not the level the tape
        // printed. Name both: the level the plan reached, and the exit the row
        // actually books. Printing the blend as "@ TP1" claimed a price the
        // tape never showed (the 2026-10-27 audit A-4's display half).
        const lastHit = result.tpHits?.[result.tpHits.length - 1];
        const levelPrice = lastHit?.price;
        const exitNote = result.priceAtHit !== undefined
            ? ` · exit @ ${result.priceAtHit}${scaleOutDetected || (result.tpHits?.length ?? 0) > 1 ? ' (blended)' : ''}`
            : '';
        return {
            outcome: TradeOutcome.WIN,
            expiredOpen: false,
            pnlPercent,
            hitLevel: levelPrice !== undefined ? String(levelPrice) : (result.priceAtHit !== undefined ? String(result.priceAtHit) : undefined),
            hitTarget,
            // Confidence tier: a win where the SL was touched first is weaker
            // than a clean run to the TP — but a breakeven scale-out (TP1
            // then entry-priced stop) is NOT an SL touch; exclude it.
            recoveredAfterSlTouch: !!result.slHit && !scaleOutDetected,
            detail: `${hitTarget} hit${levelPrice !== undefined ? ` @ ${levelPrice}` : ''}${exitNote}${result.slHit ? ' · recovered after SL touch' : ' · clean'}${scaleOutDetected ? ' · TP1 scale-out to breakeven' : ''}${!scaleOutDetected && result.tpHits && result.tpHits.length > 1 ? ' · TP1 partial scale-out, remainder to last TP' : ''}${result.timeToOutcome ? ` · ${result.timeToOutcome} after analysis` : ''}`,
            detectedAt: new Date().toISOString(),
            timeToOutcome: result.timeToOutcome,
            slOptimizationData: this.computeSLOptimization(reg, result),
            excursions: result.excursions,
            realizedR: result.realizedR,
        };
    }

    private buildLossResolution(
        reg: Registration,
        result: Awaited<ReturnType<typeof verifyHistoricalOutcome>>
    ): AutopilotResolution {
        const { analysis } = reg;
        // Exit price: the 150% hard-stop fill when the zone was breached,
        // otherwise the touched stop level.
        const slPrice = result.slHit?.price !== undefined
            ? result.slHit.price
            : parsePrice(analysis.stopLoss || '');
        const recomputed = this.computePnLFromPrice(reg, slPrice);
        const pnlPercent = recomputed !== undefined
            ? -Math.abs(recomputed)
            : this.parsePercent(analysis.stopLossPercentage || '');
        return {
            outcome: TradeOutcome.LOSS,
            expiredOpen: false,
            pnlPercent,
            hitLevel: result.slHit?.price !== undefined ? String(result.slHit.price) : (result.priceAtHit !== undefined ? String(result.priceAtHit) : undefined),
            hitTarget: 'SL',
            detail: `Stop loss hit${result.slHit?.price !== undefined ? ` @ ${result.slHit.price}` : ''}${result.timeToOutcome ? ` · ${result.timeToOutcome} after analysis` : ''}`,
            detectedAt: new Date().toISOString(),
            timeToOutcome: result.timeToOutcome || result.slHit?.timeAfterAnalysis,
            slOptimizationData: this.computeSLOptimization(reg, result),
            excursions: result.excursions,
            realizedR: result.realizedR,
        };
    }

    /** "+200.0%" / "-100%" / "45" → signed number (undefined when unparseable). */
    private parsePercent(raw: string): number | undefined {
        if (!raw) return undefined;
        const n = parseFloat(raw.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? undefined : n;
    }

    /**
     * Feed the (previously dead) SL optimizer with the observed price range.
     * The verifier doesn't expose full min/max, so the range is approximated
     * from entry + all observed hit prices — advisory data, not exact.
     */
    private computeSLOptimization(
        reg: Registration,
        result: Awaited<ReturnType<typeof verifyHistoricalOutcome>>
    ): SLOptimizationData | undefined {
        const { analysis } = reg;
        const entry = parsePrice(analysis.entryPoints?.[0]?.price || '');
        if (isNaN(entry)) return undefined;
        const observed: number[] = [entry];
        if (result.priceAtHit !== undefined) observed.push(result.priceAtHit);
        if (result.slHit?.price !== undefined) observed.push(result.slHit.price);
        (result.tpHits || []).forEach(tp => observed.push(tp.price));
        if (observed.length < 2) return undefined;
        const pseudoTrade = { analysis } as LoggedTrade;
        try {
            return trackSLOutcome(pseudoTrade, {
                minPrice: Math.min(...observed),
                maxPrice: Math.max(...observed),
            });
        } catch {
            return undefined;
        }
    }

    private resolve(messageId: string, resolution: AutopilotResolution): void {
        this.resolutions.set(messageId, resolution);
        this.dropRegistration(messageId);
        this.stopLoopIfEmpty();
        console.log(`[OutcomeAutopilot] ${messageId} → ${resolution.outcome}${resolution.expiredOpen ? ' (expired open)' : ''}: ${resolution.detail}`);
        this.listeners.forEach(cb => {
            try {
                cb(messageId, resolution);
            } catch (err) {
                console.warn('[OutcomeAutopilot] Listener error:', err);
            }
        });
    }

    private async persist(): Promise<void> {
        const user = this.loadedUser;
        if (!user) return; // no partition owner yet — never write to the shared key
        const snapshot: PersistedUserState = {
            // Keep the same window as the in-memory trim — a narrower
            // persist window would resurrect old messages as
            // re-detectable after a restart.
            processed: [...this.processed].slice(-MAX_TRACKED_IDS),
            dismissed: [...this.dismissed].slice(-MAX_TRACKED_IDS),
            shadowNotified: [...this.shadowNotified].slice(-MAX_TRACKED_IDS),
        };
        this.partitions[user] = snapshot;
        // Read-modify-write the partition map under the write chain so a
        // concurrent persist can't clobber another user's partition (or our
        // own newer snapshot, when chains interleave).
        this.writeChain = this.writeChain
            .then(async () => {
                const stored = await getPreferenceObject<LegacyPersistedState & PersistedPartitions>(
                    PREF_KEYS.OUTCOME_AUTOPILOT_STATE
                );
                const map = normalizePartitions(stored);
                // A still-legacy blob belongs to nobody verifiable; our own
                // partition is authoritative for the loaded user regardless.
                map[user] = snapshot;
                await setPreferenceObject(PREF_KEYS.OUTCOME_AUTOPILOT_STATE, map);
            })
            .catch(err => console.warn('[OutcomeAutopilot] Failed to persist state:', err));
        await this.writeChain;
    }
}

export const OutcomeAutopilotService = new OutcomeAutopilotServiceClass();
