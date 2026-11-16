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
import { assessSession, guardEnforcement, type GuardEnforcement } from '../services/validation/SessionGuardService';
import { getHarnessSettings, getSessionGuardConfig, subscribeHarnessSettings, type HarnessSettings } from '../utils/harnessSettings';

export const useSessionGuardVerdict = (trades: LoggedTrade[] | undefined): GuardEnforcement => {
    // Push, not pull: `getHarnessSettings` builds a fresh object per call, so
    // a store-snapshot hook would loop. The save path hands each listener the
    // merged settings object — one state update per real save.
    const [settings, setSettings] = useState<HarnessSettings>(getHarnessSettings);
    useEffect(() => subscribeHarnessSettings(setSettings), []);
    return useMemo(
        () => guardEnforcement(assessSession(trades ?? [], settings.equityUsd, getSessionGuardConfig())),
        [trades, settings],
    );
};
