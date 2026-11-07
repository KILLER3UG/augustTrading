// TAB: Profile — who is signed in and what their desk holds (SettingsMenu
// "TAB 1").
//
// Deliberately NO credits, plan, streak or sign-out: August is local-first with
// no account, no subscription and no cloud session. A label is a promise, so
// every number below is read from a store the app actually owns.
import React from 'react';
import { ArrowUpRight, Database, HardDrive, User, Users } from '../../shared/Icons';
import { APP_NAME, APP_VERSION } from '../../../constants/version';
import { useAutoUpdate } from '../../../hooks/useAutoUpdate';
import { SettingsButton, SettingsGroup, SettingsPageHeader, SettingsRow } from './shared';
import type { SettingsTab } from '../SettingsMenu';
import type { SettingsTabProps } from './types';
import { isProviderReady } from '../../../utils/providerUtils';

export interface ProfileTabProps extends SettingsTabProps {
    onSwitchUser?: () => void;
    onExportData?: () => Promise<void> | void;
    setActiveTab: (tab: SettingsTab) => void;
}

/**
 * What the manual check control says for each updater phase. Exported and pure
 * because the whole point is one honest sentence per state: a clean check must
 * read "Up to date", and before `upToDate` existed the check fell back to
 * `idle` — which is also "never checked" — so pressing the button looked like
 * it did nothing at all.
 */
export const updateCheckStatusLabel = (status: string | undefined): string => {
    switch (status) {
        case 'checking': return 'Checking…';
        case 'upToDate': return 'Up to date';
        case 'available':
        case 'downloading':
        case 'downloaded':
        case 'installing':
            return 'Update in progress';
        case 'error': return 'Check failed — try again';
        default: return 'Check for updates';
    }
};

/** The Settings-side updater entry: a quiet text button beside the version. */
const CheckForUpdatesRow: React.FC = () => {
    const { isElectron, updateStatus, checkForUpdates } = useAutoUpdate();
    const [busy, setBusy] = React.useState(false);
    if (!isElectron) return null;
    const phase = updateStatus?.status ?? 'idle';
    const label = updateCheckStatusLabel(phase);
    return (
        <button
            type="button"
            data-testid="profile-check-updates"
            disabled={busy || phase === 'checking' || phase === 'downloading' || phase === 'installing'}
            onClick={() => { setBusy(true); void checkForUpdates().finally(() => setBusy(false)); }}
            className="motion-press rounded-control border border-white/10 px-1.5 py-0.5 text-ui-2xs text-zinc-400 transition-colors hover:border-white/25 hover:text-zinc-200 disabled:opacity-50"
        >
            {label}
        </button>
    );
};

const ProfileTab: React.FC<{ tab: ProfileTabProps }> = ({ tab: props }) => {
    const { username, providerConfigs, providerConfigsLoaded, onSwitchUser, onExportData, setActiveTab } = props;
    const trades = props.loggedTrades ?? [];
    const readyProviders = (providerConfigs ?? []).filter(isProviderReady).length;
    const initial = (username || '?').trim().charAt(0).toUpperCase();

    return (
        <div className="motion-page">
            <SettingsPageHeader
                title="Profile"
                description="The active trader profile — its journal, memory and backups are separate from every other profile on this device."
                action={onSwitchUser && (
                    <SettingsButton onClick={onSwitchUser} ariaLabel="Switch profile">
                        <Users className="h-3.5 w-3.5" aria-hidden="true" />
                        Switch profile
                    </SettingsButton>
                )}
            />

            <div className="grid gap-3 sm:grid-cols-3">
                {[
                    { label: 'Trades logged', value: String(trades.length) },
                    { label: 'Providers connected', value: providerConfigsLoaded ? String(readyProviders) : '…' },
                    { label: 'Installed version', value: `v${APP_VERSION}` },
                ].map(stat => (
                    <div key={stat.label} className="rounded-card border border-white/[0.06] bg-zinc-900/40 px-4 py-3">
                        <div className="font-mono text-ui-xs uppercase tracking-[0.08em] text-zinc-500">{stat.label}</div>
                        <div className="mt-1.5 font-mono text-ui-xl font-medium tabular-nums text-zinc-100">{stat.value}</div>
                    </div>
                ))}
            </div>

            <div className="mt-6">
                <SettingsGroup title="Account">
                    <SettingsRow
                        icon={<User className="h-4 w-4" aria-hidden="true" />}
                        title={username || 'Trader'}
                        description={`${APP_NAME} ${APP_VERSION} · local-first · no account or subscription`}
                        control={
                            <span className="flex shrink-0 items-center gap-2">
                                <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-zinc-800 text-ui-base font-semibold text-zinc-100">
                                    {initial}
                                </span>
                                <CheckForUpdatesRow />
                            </span>
                        }
                    />
                    <SettingsRow
                        icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
                        title="Trading journal"
                        description="Trade log, pattern memory, model performance and reasoning history."
                        control={
                            <SettingsButton onClick={() => setActiveTab('journal')}>
                                Open <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            </SettingsButton>
                        }
                    />
                    {onExportData && (
                        <SettingsRow
                            icon={<Database className="h-4 w-4" aria-hidden="true" />}
                            title="Export this profile"
                            description="Download trades, analyses and memory as a JSON archive."
                            control={<SettingsButton onClick={() => void onExportData()}>Export</SettingsButton>}
                        />
                    )}
                    <SettingsRow
                        icon={<Database className="h-4 w-4" aria-hidden="true" />}
                        title="Backups & usage"
                        description="Auto-backups run every 30 minutes while a profile is open."
                        control={
                            <SettingsButton onClick={() => setActiveTab('actions')}>
                                Open <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            </SettingsButton>
                        }
                    />
                </SettingsGroup>
            </div>
        </div>
    );
};

export default ProfileTab;
