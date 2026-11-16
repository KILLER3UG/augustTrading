/**
 * useSessionGuardVerdict — the session-guard verdict as a reactive value.
 *
 * The guard's config lives in the harness-settings store (preset + per-field
 * overrides) and its input is the journal's tradeLog, so the verdict moves
 * when EITHER side moves: a confirmed risk-change card loosening the cap must
 * lift a stand-down without a remount, and a settled row must be able to trip
 * one. The settings store pushes on every save (`subscribeHarnessSettings`),
 * and `trades` is the memo's other dependency.
 *
 * Consumers: the proposal card (its Approve disable + the block line) and the
 * log writer in App (the deterministic refusal). Both call
 * `guardEnforcement` on THIS verdict, so the button and the writer cannot
 * disagree about whether a trade may be logged.
 */

import { useEffect, useMemo, useState } from 'react';
import type { LoggedTrade } from '../types';
import { assessSession, applyDailyStanddownLatch, guardEnforcement, type GuardEnforcement } from '../services/validation/SessionGuardService';
import { getHarnessSettings, getSessionGuardConfig, subscribeHarnessSettings, type HarnessSettings } from '../utils/harnessSettings';

export const useSessionGuardVerdict = (trades: LoggedTrade[] | undefined): GuardEnforcement => {
    // Push, not pull: `getHarnessSettings` builds a fresh object per call, so
    // a store-snapshot hook would loop. The save path hands each listener the
    // merged settings object — one state update per real save.
    const [settings, setSettings] = useState<HarnessSettings>(getHarnessSettings);
    useEffect(() => subscribeHarnessSettings(setSettings), []);
    // The verdict also moves with the CLOCK: the day buckets roll at 00:00
    // UTC (a card open across midnight would keep a stand-down that had
    // lifted, or vice versa) and a cooldown expires without any trade or
    // settings change. A one-minute tick keeps the card honest; the WRITER
    // re-checks fresh at log time either way, so this only affects what the
    // card shows.
    const [clockTick, setClockTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setClockTick(v => v + 1), 60_000);
        return () => clearInterval(t);
    }, []);
    return useMemo(
        () => {
            const config = getSessionGuardConfig();
            // F6 ruling: once the daily-loss limit trips for the UTC day, the
            // standdown LATCHES — a riskPercent tighten cannot shrink today's
            // settled losses past it; only a loosened limit clears it.
            const verdict = applyDailyStanddownLatch(
                assessSession(trades ?? [], settings.equityUsd, config),
                config,
            );
            return guardEnforcement(verdict);
        },
        [trades, settings, clockTick],
    );
};
