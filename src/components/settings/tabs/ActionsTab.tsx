// TAB: Data — session usage and the profile's automatic backups (SettingsMenu
// "TAB 6").
//
// Moved verbatim from the inline body in SettingsMenu.tsx.
import React from 'react';
import { BackupManager } from '../BackupManager';
import { StorageLocationCard } from '../StorageLocationCard';
import { SettingsPageHeader } from './shared';
import { exportTrainingDataJSONL, trainingRecordFor } from '../../../utils/reportExport';
import { captureStatus, exportCorpusJsonl, setCaptureEnabled, isCaptureEnabled, lastCaptureFailureInfo, TRAINING_CAPTURE_MAX_RECORDS } from '../../../services/learning/trainingCapture';
import type { SettingsTabProps } from './types';

export interface ActionsTabProps extends SettingsTabProps {
    /** Called after a backup restore replaces the profile (App reloads it). */
    onProfileRestored?: (username: string) => void;
}

const ActionsTab: React.FC<{ tab: ActionsTabProps }> = ({ tab: props }) => {
    const { username, onProfileRestored } = props;
    const trades = props.loggedTrades ?? [];

    // The Improve-future-August-models recorder: a LOCAL toggle (default
    // OFF), a status line, and the corpus export. The flag deliberately
    // does not ride in backups — re-enabling after a restore is a conscious
    // act. State refreshes on mount and after each flip.
    const [capture, setCapture] = React.useState<{ enabled: boolean; desktop: boolean; recordCount: number; refusedOnce: boolean; lastAt: string | null } | null>(null);
    const [corpusBusy, setCorpusBusy] = React.useState(false);
    const refreshCapture = React.useCallback(() => { void captureStatus().then(setCapture); }, []);
    React.useEffect(() => { refreshCapture(); }, [refreshCapture]);
    const flipCapture = () => {
        setCaptureEnabled(!isCaptureEnabled());
        refreshCapture();
    };
    const exportCorpus = async () => {
        setCorpusBusy(true);
        try {
            const jsonl = await exportCorpusJsonl((props.loggedTrades ?? []).map(t => ({ planId: t.planId, json: trainingRecordFor(t) })));
            const stamp = new Date().toISOString().slice(0, 10);
            const blob = new Blob([jsonl], { type: 'application/jsonl' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `august-corpus-${stamp}.jsonl`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } finally {
            setCorpusBusy(false);
        }
    };

    return (
        <div className="space-y-5 animate-fade-in">
            <SettingsPageHeader
                title="Data"
                description="Session usage and the profile's automatic backups."
            />

            <StorageLocationCard />

            {/* Training data — the journal as one model-ready JSON record per
                trade. A local download of the trader's own rows; nothing here
                leaves the machine. */}
            <section className="rounded-bubble border border-hairline bg-zinc-800/40 p-4" data-testid="training-export-card">
                <h3 className="text-ui-dense font-semibold text-zinc-200">Training data</h3>
                <p className="mt-1 max-w-prose text-ui-xs leading-4 text-zinc-500">
                    One JSON record per trade on its own line: the plan it came from, the verdict,
                    the outcome and when it was learned, PnL in whichever unit was captured, R,
                    excursions, discipline tags and any stored post-mortem notes. Saves a local
                    {' '}.jsonl file — nothing is uploaded.
                </p>
                <button
                    type="button"
                    data-testid="export-training-jsonl"
                    disabled={trades.length === 0}
                    onClick={() => exportTrainingDataJSONL(trades)}
                    className="mt-2.5 rounded-control border border-hairline bg-zinc-900 px-3 py-1.5 text-ui-xs font-semibold text-zinc-200 transition-colors hover:border-line hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {trades.length === 0
                        ? 'No trades logged yet'
                        : `Export ${trades.length} ${trades.length === 1 ? 'trade' : 'trades'} (JSONL)`}
                </button>
            </section>

            {/* Improve future August models — the decision recorder. The
                corpus (turn + reasoning + actions + outcome, joined by planId)
                is the fine-tuning fuel; it is LOCAL-ONLY and OFF by default. */}
            <section className="rounded-bubble border border-hairline bg-zinc-800/40 p-4" data-testid="training-capture-card">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="text-ui-dense font-semibold text-zinc-200">Improve future August models</h3>
                        <p className="mt-1 max-w-prose text-ui-xs leading-4 text-zinc-500">
                            When ON, every desk turn that ends in a decision is recorded to this
                            machine only — the trader's words, the model's reasoning, the tool trail,
                            the plan and its later outcome — as one JSON line per turn, for training a
                            future trading-focused August model. Nothing is uploaded; the flag is not
                            part of backups. When OFF, nothing is stored.
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={capture?.enabled ?? false}
                        data-testid="training-capture-toggle"
                        onClick={flipCapture}
                        className={`shrink-0 rounded-control border px-3 py-1.5 text-ui-xs font-semibold transition-colors ${(capture?.enabled ?? false)
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-hairline bg-zinc-900 text-zinc-400 hover:border-line'}`}
                    >
                        {(capture?.enabled ?? false) ? 'Recording ON' : 'Recording OFF'}
                    </button>
                </div>
                <p className="mt-2 text-ui-xs leading-4 text-zinc-500" data-testid="training-capture-status" role="status">
                    {!capture
                        ? '…'
                        : !capture.desktop
                            ? 'Recording needs the desktop app — this environment has no local store.'
                            : capture.enabled
                                ? `Recording ON · ${capture.recordCount} turn${capture.recordCount === 1 ? '' : 's'} stored${capture.refusedOnce ? ` · store FULL (${TRAINING_CAPTURE_MAX_RECORDS} cap reached — export and archive to keep recording)` : ''}${capture.lastAt ? ` · last ${capture.lastAt}` : ''}`
                                : `Recording OFF · ${capture.recordCount} turn${capture.recordCount === 1 ? '' : 's'} already stored${capture.refusedOnce ? ' · store FULL' : ''}`}
                </p>
                {lastCaptureFailureInfo() && (
                    <p className="mt-1 text-ui-xs leading-4 text-rose-400" data-testid="training-capture-failure" role="alert">
                        {`Last append FAILED (${lastCaptureFailureInfo()!.reason} at ${lastCaptureFailureInfo()!.at}) — that turn is not in the corpus. Check the desktop store; this resets on restart.`}
                    </p>
                )}
                <button
                    type="button"
                    data-testid="export-training-corpus"
                    disabled={corpusBusy || !capture?.desktop || capture.recordCount === 0}
                    onClick={() => { void exportCorpus(); }}
                    className="mt-2.5 rounded-control border border-hairline bg-zinc-900 px-3 py-1.5 text-ui-xs font-semibold text-zinc-200 transition-colors hover:border-line hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {corpusBusy ? 'Preparing…' : 'Export training corpus (JSONL)'}
                </button>
            </section>

            {/* Backups — list/export/restore/delete the 30-min auto-backups */}
            {username && onProfileRestored && (
                <BackupManager username={username} onProfileRestored={onProfileRestored} />
            )}
        </div>
    );
};

export default ActionsTab;
