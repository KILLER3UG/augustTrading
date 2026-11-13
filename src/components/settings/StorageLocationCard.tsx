/**
 * Where the journal actually lives (2026-09-22).
 *
 * `dbService.getStorageInfo()` — platform, storage backend, profile count — was
 * written, exported and never called by anything, while `BackupService`'s own
 * header records the reason it matters: on native, backups go to a
 * non-evictable directory "because WebView IndexedDB can be cleared by the OS
 * under storage pressure". So the app knew its journal could be evicted on
 * exactly the store it might be using, and told the user nothing about which
 * store that was. `DiagnosticsPanel` shows runtime errors and no storage state.
 *
 * This is the card for that, placed on the same Data tab as export/import so the
 * fact and the remedy sit together.
 */

import React, { useEffect, useState } from 'react';
import { getStorageInfo } from '../../services/infrastructure/dbService';
import { getStoreFailure, storeBackendKind, storeLocation, type StoreFailure } from '../../services/infrastructure/storeBackend';

interface StorageInfo {
    platform: string;
    storageType: 'files' | 'sqlite' | 'indexeddb';
    userCount: number;
}

/** Deliberately conservative: the eviction risk is about browser/webview
 *  storage, and only that. Claiming more than `storageType` supports would be
 *  the same kind of overreach this card exists to prevent. */
const evictable = (info: StorageInfo): boolean => info.storageType === 'indexeddb';

export const StorageLocationCard: React.FC = () => {
    const [info, setInfo] = useState<StorageInfo | null>(null);
    const [failed, setFailed] = useState(false);
    // The big stores' own backend: chat transcripts and the notebook live in
    // files on desktop and in localStorage on web. This card is where the trader
    // finds out which — and where a write that did NOT land is reported, because
    // the alternative is a console line nobody reads.
    const [filesLocation, setFilesLocation] = useState<string | null>(null);
    const [storeFailure, setStoreFailure] = useState<StoreFailure | null>(null);
    const backend = storeBackendKind();

    useEffect(() => {
        let alive = true;
        void (async (): Promise<void> => {
            try {
                const next = await getStorageInfo();
                if (alive) setInfo(next);
            } catch (err) {
                console.warn('[StorageLocationCard] Storage probe failed:', err);
                if (alive) setFailed(true);
            }
            const loc = await storeLocation();
            if (alive) {
                setFilesLocation(loc);
                setStoreFailure(getStoreFailure());
            }
        })();
        return () => { alive = false; };
    }, []);

    if (failed) {
        return (
            <div className="rounded-bubble border border-hairline bg-zinc-900/60 px-4 py-3" data-testid="storage-location-card">
                <p className="text-ui-xs uppercase tracking-widest text-zinc-500">Storage</p>
                <p className="text-ui-base text-zinc-300 mt-1" data-testid="storage-location-unknown">
                    Storage location unavailable — export a backup before assuming this journal is safe.
                </p>
            </div>
        );
    }
    if (!info) {
        return (
            <div className="rounded-bubble border border-hairline bg-zinc-900/60 px-4 py-3" data-testid="storage-location-card">
                <p className="text-ui-xs uppercase tracking-widest text-zinc-500">Storage</p>
                <p className="text-ui-base text-zinc-500 mt-1">Checking…</p>
            </div>
        );
    }

    const where = info.storageType === 'sqlite'
        ? 'SQLite — the app’s own data file'
        : 'IndexedDB — inside the browser profile';

    return (
        <div className="rounded-bubble border border-hairline bg-zinc-900/60 px-4 py-3" data-testid="storage-location-card">
            <p className="text-ui-xs uppercase tracking-widest text-zinc-500">Storage</p>
            <p className="text-ui-base text-zinc-200 mt-1" data-testid="storage-location-value">
                {where}
                <span className="text-zinc-500"> · {info.platform} · {info.userCount} {info.userCount === 1 ? 'profile' : 'profiles'}</span>
            </p>
            {/* The stores that hold the most: files on desktop, localStorage on web. */}
            <p className="text-ui-dense text-zinc-400 mt-2" data-testid="store-backend">
                Chats &amp; notebook:{' '}
                <span className="text-zinc-200">
                    {backend === 'desktop-files'
                        ? `dedicated files${filesLocation ? ` — ${filesLocation}` : ''}`
                        : 'browser storage (shared ~5 MB budget)'}
                </span>
            </p>
            {backend === 'browser-storage' && (
                <p className="text-ui-xs text-amber-400/90 mt-1">
                    This build keeps chats and the notebook in the browser's storage, which is capped and can be
                    cleared. The desktop build writes them to app files instead.
                </p>
            )}
            {storeFailure && (
                <p role="alert" className="text-ui-xs text-rose-300 mt-1" data-testid="store-write-failure">
                    A write did not reach its store: “{storeFailure.key}” — {storeFailure.error}
                    {storeFailure.fellBack ? ' (kept in browser storage for now)' : ' (nothing was lost silently: export a backup)'}.
                </p>
            )}
            {evictable(info) && (
                <p className="text-ui-xs text-amber-400/90 mt-1" data-testid="storage-location-warning">
                    Browser and WebView storage can be cleared by the system under disk pressure. Keep an exported backup.
                </p>
            )}
        </div>
    );
};

export default StorageLocationCard;
