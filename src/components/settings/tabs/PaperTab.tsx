// TAB: Paper Trading — the trader's view of the LOCAL simulated broker.
//
// Every number here comes from PaperBrokerService / paperCore. This tab is the
// ONLY place a trader can enable the broker, move its risk caps or wipe its
// ledger: the seat's desk tools deliberately have no path to these mutators
// (ANTI-REWARD-HACKING). Writes go through updatePaperConfigForUser, which
// serializes them on the same chain as every fill, and a reset is confirmed
// with the shared in-app dialog before it touches the store.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Activity, FileText, ShieldCheck, Target, Wrench } from '../../shared/Icons';
import { ToggleSwitch } from '../../shared/ToggleSwitch';
import { useConfirmDialog } from '../../shared/ConfirmDialog';
import { SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow } from './shared';
import { getActiveUsername } from '../../../utils/activeUser';
import {
    getHarnessSettings,
    saveHarnessSettings,
    subscribeHarnessSettings,
} from '../../../utils/harnessSettings';
import {
    normalizePreTradeHooksSettings,
    type PreTradeHooksSettings,
} from '../../../services/paper/preTradeHooksCore';
import {
    createPaperAccount,
    DEFAULT_PAPER_ACCOUNT_CONFIG,
    normalizePaperConfig,
    type PaperAccount,
    type PaperAccountConfig,
} from '../../../services/paper/paperCore';
import {
    getPaperAccount,
    getPaperCorruptionWarning,
    resetPaperAccountForUser,
    subscribePaperAccount,
    updatePaperConfigForUser,
    type PaperCorruptionWarning,
} from '../../../services/paper/PaperBrokerService';
import type { SettingsTabProps } from './types';

export type PaperTabProps = SettingsTabProps;

/** A numeric setting that is clamped on the way in by normalizePaperConfig —
 *  the input's min/max only mirror those bounds; the service is the authority. */
const NumberRow: React.FC<{
    title: string;
    description: string;
    testId: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
}> = ({ title, description, testId, value, min, max, step = 1, onChange }) => (
    <SettingsRow
        title={title}
        description={description}
        control={
            <input
                type="number"
                data-testid={testId}
                aria-label={title}
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={e => {
                    if (e.target.value === '') return; // a mid-edit blank is not zero
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onChange(n);
                }}
                className="w-24 rounded-control border border-hairline bg-zinc-950 px-2 py-1 text-right font-mono text-ui-sm text-zinc-100 outline-none focus:border-line"
            />
        }
    />
);

/** A corrupt stored account is quarantined, never silently reset to \$10k.
 *  The service keeps a sticky record with no event, so — like the Health
 *  tab's notebook-write failure — the only way to catch a failure while this
 *  tab is open is a short poll. Renders nothing when the store is healthy. */
const PaperCorruptionNotice: React.FC = () => {
    const [warning, setWarning] = useState<PaperCorruptionWarning | null>(
        () => getPaperCorruptionWarning(),
    );
    useEffect(() => {
        const timer = window.setInterval(() => setWarning(getPaperCorruptionWarning()), 2000);
        return () => window.clearInterval(timer);
    }, []);
    if (!warning) return null;
    return (
        <div className="rounded-bubble border border-rose-500/20 bg-rose-950/30 p-3" data-testid="paper-corruption-warning">
            <p className="text-ui-sm font-semibold text-rose-300">
                A corrupt paper account was found and quarantined.
            </p>
            <p className="text-ui-xs text-zinc-300">
                The raw bytes were preserved under a backup key; a fresh account is in memory.
                {' '}{warning.reason}.
            </p>
            <p className="text-ui-2xs text-zinc-500">
                {warning.bytes} bytes · {new Date(warning.atMs).toLocaleString()}
            </p>
        </div>
    );
};

const PaperTab: React.FC<{ tab: PaperTabProps }> = ({ tab }) => {
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const user = tab.username ?? getActiveUsername() ?? 'default';
    const [account, setAccount] = useState<PaperAccount | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Reads and writes share one barometer: an order filled in chat updates
    // this tab without a reopen, and a config write here updates the rail.
    useEffect(() => {
        let alive = true;
        const unsubscribe = subscribePaperAccount(next => { if (alive) setAccount(next); });
        void getPaperAccount(user)
            .then(next => { if (alive) setAccount(next); })
            .catch(() => { /* keep the safe defaults until the store answers */ });
        return () => { alive = false; unsubscribe(); };
    }, [user]);

    const cfg: PaperAccountConfig = account?.config ?? DEFAULT_PAPER_ACCOUNT_CONFIG;
    const harness = useSyncExternalStore(subscribeHarnessSettings, getHarnessSettings, getHarnessSettings);
    const hooks = harness.preTradeHooks;
    const updateHooks = (patch: Partial<PreTradeHooksSettings>): void => {
        saveHarnessSettings({ preTradeHooks: normalizePreTradeHooksSettings({ ...hooks, ...patch }) });
    };

    const updateConfig = (patch: Partial<PaperAccountConfig>): void => {
        // Clamp locally for an immediate, honest UI; the service clamps again
        // before persisting, so a stale tab can never widen a risk cap.
        const nextConfig = normalizePaperConfig({ ...cfg, ...patch });
        setAccount(prev => prev ? { ...prev, config: nextConfig } : createPaperAccount(nextConfig));
        void updatePaperConfigForUser(nextConfig, user)
            .then(next => setAccount(next))
            .catch(e => setNote(e instanceof Error ? e.message : String(e)));
    };

    const reset = async (): Promise<void> => {
        const ok = await confirm({
            title: 'Reset paper account?',
            message: 'This clears every simulated position, pending limit and closed trade. Your settings stay. This cannot be undone.',
            confirmLabel: 'Reset paper account',
            destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        try {
            const next = await resetPaperAccountForUser(user);
            setAccount(next);
            setNote('Paper account reset — the ledger is empty.');
        } catch (e) {
            setNote(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-5 animate-fade-in">
            <SettingsPageHeader
                title="Paper Trading"
                description="A local simulation of execution — no orders leave this machine and no exchange key is involved. Positions, fills and the closed ledger are computed from public market data."
            />

            <PaperCorruptionNotice />

            <SettingsGroup title="Account" description="Paper Mode is on by default in chat. Autonomous watch stays off until you turn it on.">
                <SettingsRow
                    icon={<Activity className="h-4 w-4" aria-hidden="true" />}
                    title="Paper Mode"
                    description="When off, simulated orders are blocked and no paper fills are placed. Nothing here can place a live exchange order."
                    control={
                        <span data-testid="settings-paper-enabled" className="inline-flex">
                            <ToggleSwitch
                                checked={cfg.enabled}
                                onChange={() => updateConfig({ enabled: !cfg.enabled })}
                                label="Toggle Paper Mode"
                            />
                        </span>
                    }
                />
                <SettingsRow
                    icon={<Target className="h-4 w-4" aria-hidden="true" />}
                    title="Autonomous watch"
                    description="Lets August monitor resting paper orders between messages. Off by default — nothing is monitored automatically until you enable it."
                    control={
                        <span data-testid="settings-paper-autonomous" className="inline-flex">
                            <ToggleSwitch
                                checked={cfg.allowAutonomousWatch}
                                onChange={() => updateConfig({ allowAutonomousWatch: !cfg.allowAutonomousWatch })}
                                label="Toggle autonomous paper watch"
                            />
                        </span>
                    }
                />
                <NumberRow
                    title="Starting balance"
                    description="The simulated wallet's opening balance, in USD. Changing this does not rewrite an existing ledger — reset to start from the new figure."
                    testId="settings-paper-starting-balance"
                    value={cfg.startingBalanceUsd}
                    min={100}
                    max={10_000_000}
                    onChange={startingBalanceUsd => updateConfig({ startingBalanceUsd })}
                />
            </SettingsGroup>

            <SettingsGroup
                title="Risk limits"
                description="Deterministic walls on every simulated fill. They are enforced in the broker core, not in a prompt."
            >
                <NumberRow
                    title={`Maker fee (bps) · ${(cfg.makerFeeBps / 100).toFixed(2)}%`}
                    description="Fee charged on resting limit entries and take-profit exits, in basis points of full notional (1 bps = 0.01%)."
                    testId="settings-paper-maker-fee-bps"
                    value={cfg.makerFeeBps}
                    min={0}
                    max={100}
                    onChange={makerFeeBps => updateConfig({ makerFeeBps })}
                />
                <NumberRow
                    title={`Taker fee (bps) · ${(cfg.takerFeeBps / 100).toFixed(2)}%`}
                    description="Fee charged on market entries, stop exits and manual closes, in basis points of full notional (1 bps = 0.01%)."
                    testId="settings-paper-taker-fee-bps"
                    value={cfg.takerFeeBps}
                    min={0}
                    max={100}
                    onChange={takerFeeBps => updateConfig({ takerFeeBps })}
                />
                <NumberRow
                    title="Max risk per trade (%)"
                    description="The largest simulated loss one position may carry, as a percent of equity."
                    testId="settings-paper-max-risk-per-trade-pct"
                    value={cfg.maxRiskPerTradePct}
                    min={0.05}
                    max={5}
                    step={0.05}
                    onChange={maxRiskPerTradePct => updateConfig({ maxRiskPerTradePct })}
                />
                <NumberRow
                    title="Max leverage"
                    description="Highest isolated leverage an order may request."
                    testId="settings-paper-max-leverage"
                    value={cfg.maxLeverage}
                    min={1}
                    max={125}
                    onChange={maxLeverage => updateConfig({ maxLeverage })}
                />
                <NumberRow
                    title="Max concurrent positions"
                    description="How many open simulated positions may exist at once."
                    testId="settings-paper-max-concurrent-positions"
                    value={cfg.maxConcurrentPositions}
                    min={1}
                    max={20}
                    onChange={maxConcurrentPositions => updateConfig({ maxConcurrentPositions })}
                />
                <NumberRow
                    title="Daily drawdown kill switch (%)"
                    description="A daily equity drawdown this large halts new entries until 00:00 UTC. Closing is always allowed."
                    testId="settings-paper-daily-drawdown-kill-switch-pct"
                    value={cfg.dailyDrawdownKillSwitchPct}
                    min={0.1}
                    max={50}
                    step={0.1}
                    onChange={dailyDrawdownKillSwitchPct => updateConfig({ dailyDrawdownKillSwitchPct })}
                />
            </SettingsGroup>

            <div data-testid="settings-pretrade-hooks">
                <SettingsGroup
                    title="Pre-Trade Hooks"
                    description="Deterministic guardrails enforced before any simulated entry opens. Closing, cancelling, and risk-reducing hedges are never blocked."
                >
                    <SettingsRow
                        icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                        title="Block correlated portfolio heat"
                        description="Blocks new entries when net directional BTC-beta risk heat exceeds the cap below (risk-reducing hedges still pass)."
                        control={
                            <span data-testid="settings-hook-correlated-heat" className="inline-flex">
                                <ToggleSwitch
                                    checked={hooks.blockCorrelatedHeat}
                                    onChange={() => updateHooks({ blockCorrelatedHeat: !hooks.blockCorrelatedHeat })}
                                    label="Toggle Block correlated portfolio heat"
                                />
                            </span>
                        }
                    />
                    <NumberRow
                        title="Max correlated BTC-beta heat (%)"
                        description="Net directional BTC-beta risk ceiling (BTC=1.0x, ETH=1.15x, major L1/L2=1.35x, other alts=1.55x)."
                        testId="settings-max-correlated-heat"
                        value={hooks.maxCorrelatedHeatPct}
                        min={0.5}
                        max={20}
                        step={0.5}
                        onChange={maxCorrelatedHeatPct => updateHooks({ maxCorrelatedHeatPct })}
                    />
                    <SettingsRow
                        icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                        title="Block breakouts in chop regime"
                        description="Blocks breakout entries when live market regime reads chop/range unless thesis or playbook cites fade, reclaim, sweep, mean, or range."
                        control={
                            <span data-testid="settings-hook-chop-breakout" className="inline-flex">
                                <ToggleSwitch
                                    checked={hooks.blockChopBreakout}
                                    onChange={() => updateHooks({ blockChopBreakout: !hooks.blockChopBreakout })}
                                    label="Toggle Block breakouts in chop regime"
                                />
                            </span>
                        }
                    />
                    <SettingsRow
                        icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                        title="Block crowded side at extreme funding"
                        description="Blocks entries aligned with extreme 8h funding (>= 5 bps) while permitting counter-trend fades."
                        control={
                            <span data-testid="settings-hook-extreme-funding" className="inline-flex">
                                <ToggleSwitch
                                    checked={hooks.blockExtremeFunding}
                                    onChange={() => updateHooks({ blockExtremeFunding: !hooks.blockExtremeFunding })}
                                    label="Toggle Block crowded side at extreme funding"
                                />
                            </span>
                        }
                    />
                </SettingsGroup>
            </div>

            <SettingsGroup title="Account actions">
                <SettingsRow
                    icon={<FileText className="h-4 w-4" aria-hidden="true" />}
                    title="Reset paper account"
                    description="Clears all simulated positions, pending limits and closed trades. Settings are kept."
                    control={
                        <SettingsButton
                            tone="danger"
                            disabled={busy}
                            testId="settings-paper-reset"
                            ariaLabel="Reset paper account"
                            onClick={() => { void reset(); }}
                        >
                            <Wrench className="h-3.5 w-3.5" aria-hidden="true" /> Reset
                        </SettingsButton>
                    }
                />
            </SettingsGroup>

            {note && <p role="status" data-testid="settings-paper-note" className="text-ui-sm leading-relaxed text-zinc-500">{note}</p>}
            {ConfirmDialogComponent}
        </div>
    );
};

export default PaperTab;
