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

const formatLastChecked = (lastCheckedAt: number | null | undefined): string => {
    if (!lastCheckedAt || !Number.isFinite(lastCheckedAt)) return 'Not checked yet';
    const elapsedMs = Math.max(0, Date.now() - lastCheckedAt);
    if (elapsedMs < 60_000) return 'Checked just now';
    const mins = Math.floor(elapsedMs / 60_000);
    if (mins < 60) return `Checked ${mins}m ago`;
    try {
        return `Checked ${new Date(lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
        return 'Checked recently';
    }
};

const describeUpdatePhase = (
    status: string | undefined,
    version: string | null | undefined,
    progress: number | undefined,
    error: string | null | undefined,
): string => {
    switch (status) {
        case 'checking': return 'Checking GitHub Releases…';
        case 'available': return version ? `Update v${version} found — starting download` : 'Update found';
        case 'downloading': {
            const pct = Number.isFinite(progress) && (progress ?? 0) > 0 ? ` ${progress}%` : '…';
            return `Downloading${version ? ` v${version}` : ''}${pct}`;
        }
        case 'downloaded': return version ? `Ready to install v${version}` : 'Ready to install';
        case 'installing': return `Restarting to install${version ? ` v${version}` : ''}…`;
        case 'upToDate': return 'Up to date';
        case 'error': return error || 'Update check failed';
        default: return 'Automatic background checks active';
    }
};

const stripNoteFormatting = (raw: string): string[] => raw
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^#{1,6}\s+/, '').replace(/\*\*|__|`/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);

/** Settings → Profile Updates group (Electron only; browser hides cleanly). */
const UpdatesGroup: React.FC = () => {
    const { isElectron, appVersion, updateStatus, checkForUpdates, installUpdate } = useAutoUpdate();
    const [busy, setBusy] = React.useState(false);
    if (!isElectron) return null;

    const phase = updateStatus?.status ?? 'idle';
    const buttonLabel = updateCheckStatusLabel(phase);
    const liveSummary = describeUpdatePhase(phase, updateStatus.version, updateStatus.progress, updateStatus.error);
    const lastCheckedLabel = formatLastChecked(updateStatus.lastCheckedAt);
    const notes = updateStatus.releaseNotes ? stripNoteFormatting(updateStatus.releaseNotes) : [];

    return (
        <div className="mt-6">
            <SettingsGroup title="Updates">
                <SettingsRow
                    icon={<Database className="h-4 w-4" aria-hidden="true" />}
                    title={`August Trading v${appVersion || APP_VERSION}`}
                    description={
                        <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-ui-sm text-zinc-400" data-testid="profile-update-status">
                                <span>{liveSummary}</span>
                                <span className="text-zinc-600">·</span>
                                <span className="text-ui-xs text-zinc-500">{lastCheckedLabel}</span>
                            </div>
                            {notes.length > 0 && (
                                <details className="mt-1.5 text-ui-xs text-zinc-500" data-testid="profile-update-notes">
                                    <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">
                                        Release notes {updateStatus.version ? `(v${updateStatus.version})` : ''}
                                    </summary>
                                    <div className="mt-1.5 space-y-1 rounded-control border border-hairline bg-zinc-950/60 p-2.5 text-zinc-400">
                                        {notes.map((line, i) => <p key={i}>{line}</p>)}
                                    </div>
                                </details>
                            )}
                        </div>
                    }
                    control={
                        <div className="flex shrink-0 items-center gap-2">
                            {phase === 'downloaded' && (
                                <SettingsButton
                                    testId="profile-install-update"
                                    onClick={() => void installUpdate()}
                                    ariaLabel={`Restart to update to v${updateStatus.version ?? ''}`}
                                >
                                    Restart to update
                                </SettingsButton>
                            )}
                            <button
                                type="button"
                                data-testid="profile-check-updates"
                                disabled={busy || phase === 'checking' || phase === 'downloading' || phase === 'installing'}
                                onClick={() => { setBusy(true); void checkForUpdates().finally(() => setBusy(false)); }}
                                className="motion-press rounded-control border border-hairline bg-zinc-900 px-2.5 py-1 text-ui-dense text-zinc-300 transition-colors hover:border-line hover:text-zinc-100 disabled:opacity-50"
                            >
                                {buttonLabel}
                            </button>
                        </div>
                    }
                />
            </SettingsGroup>
        </div>
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
                    <div key={stat.label} className="rounded-card border border-hairline bg-zinc-900/40 px-4 py-3">
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
                            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-zinc-800 text-ui-base font-semibold text-zinc-100">
                                {initial}
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
            <UpdatesGroup />
        </div>
    );
};

export default ProfileTab;
