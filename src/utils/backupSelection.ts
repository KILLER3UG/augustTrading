/**
 * backupSelection — which backup, if any, is worth offering after the profile's
 * trade count drops.
 *
 * The integrity check used to suggest the NEWEST backup. Startup takes a
 * backup before the check, so the newest is usually the one that captured the
 * loss — literally "a backup with 0 trades is available". The only useful
 * offer is the backup holding the most trades, and only when that is more than
 * the profile still has.
 */

export interface BackupCandidate {
    id: string;
    timestamp: string;
    tradeCount: number;
}

/** Highest trade count wins; equal counts prefer the newer backup. */
export const selectRecoveryBackup = <T extends BackupCandidate>(
    backups: readonly T[],
    currentTradeCount: number,
): T | null => {
    let best: T | null = null;
    for (const backup of backups) {
        if (backup.tradeCount <= currentTradeCount) continue;
        if (!best
            || backup.tradeCount > best.tradeCount
            || (backup.tradeCount === best.tradeCount
                && new Date(backup.timestamp).getTime() > new Date(best.timestamp).getTime())) {
            best = backup;
        }
    }
    return best;
};
