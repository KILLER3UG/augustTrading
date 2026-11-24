'use strict';

/**
 * updaterStateMachine — the PURE half of the desktop auto-update flow.
 *
 * `electron/main.cjs` owns the side effects (electron-updater calls, IPC, the
 * timers). Every decision about what the trader SEES lives here, so it can be
 * tested offline, with no Electron and no network:
 *
 *   idle ─▶ checking ─▶ available ─▶ downloading ─▶ downloaded ─▶ installing
 *                 │           └─▶ upToDate
 *                 └─▶ error (manual / download / install)   — visible
 *                 └─▶ (restore)  background check that failed — SILENT
 *
 * The one non-obvious rule: a BACKGROUND check that fails (offline, DNS, a
 * GitHub blip) restores the previous state and shows nothing. The same failure
 * on a MANUAL check, a download or an install is shown, because the trader
 * asked for it or something they were waiting on broke.
 */

/** Startup check waits so a cold boot stays instant. */
const UPDATE_STARTUP_DELAY_MS = 8000;
/** Background re-check cadence while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Phases in which a new check must not start (it would fight the work in flight). */
const BUSY_STATUSES = new Set(['checking', 'downloading', 'downloaded', 'installing']);

const { isStrictlyNewerVersion } = require('./updateVerificationPolicy.cjs');

function createUpdateInfo() {
    return {
        status: 'idle', // idle | checking | available | upToDate | downloading | downloaded | installing | error
        progress: 0,
        version: null,
        error: null,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        releaseNotes: null,
        /** Epoch-ms of the last check that reached the release feed. */
        lastCheckedAt: null,
        /** Who started the check in flight — decides whether a failure is shown. */
        origin: null,
        /** What to fall back to if a background check fails silently. */
        resumeStatus: null,
    };
}

/** GitHub's releaseNotes is a raw markdown string; other providers can hand
 *  back an array of per-language notes. Normalize to capped plain text. */
function normalizeReleaseNotes(notes) {
    if (typeof notes === 'string') return notes.slice(0, 4000);
    if (Array.isArray(notes)) {
        return notes
            .map(n => (n && (n.note ?? n.text ?? n.value) ? String(n.note ?? n.text ?? n.value) : ''))
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 4000) || null;
    }
    return null;
}

/** True when a periodic/startup check may start right now. */
function shouldRunBackgroundCheck(info) {
    return !BUSY_STATUSES.has(info && info.status);
}

/**
 * The reducer. `event.type` is one of:
 *   check-start {manual}, available {version, currentVersion, releaseNotes},
 *   not-available, progress {percent, bytesPerSecond, transferred, total},
 *   downloaded, error {message}, install-start.
 * Unknown events and events that make no sense in the current phase return the
 * SAME object (referential equality = "nothing to announce").
 */
function reduceUpdateInfo(info, event, now = Date.now()) {
    switch (event && event.type) {
        case 'check-start': {
            if (info.status === 'downloading' || info.status === 'downloaded' || info.status === 'installing') return info;
            const resume = info.status === 'checking'
                ? info.resumeStatus
                : (info.status === 'error' ? 'idle' : info.status);
            return {
                ...info,
                status: 'checking',
                error: null,
                origin: event.manual ? 'manual' : 'background',
                resumeStatus: resume || 'idle',
            };
        }
        case 'available': {
            if (!isStrictlyNewerVersion(event.version, event.currentVersion)) {
                return {
                    ...info, status: 'upToDate', version: null, releaseNotes: null, error: null,
                    origin: null, resumeStatus: null, lastCheckedAt: now,
                };
            }
            return {
                ...info,
                status: 'available',
                version: event.version,
                releaseNotes: normalizeReleaseNotes(event.releaseNotes),
                error: null,
                origin: null,
                resumeStatus: null,
                lastCheckedAt: now,
            };
        }
        case 'not-available':
            // 'upToDate', NOT 'idle' — idle is also the never-checked state.
            return { ...info, status: 'upToDate', version: null, releaseNotes: null, error: null, origin: null, resumeStatus: null, lastCheckedAt: now };
        case 'progress':
            return {
                ...info,
                status: 'downloading',
                progress: Math.round(Number(event.percent) || 0),
                bytesPerSecond: Math.max(0, Math.round(Number(event.bytesPerSecond) || 0)),
                transferred: Math.max(0, Math.round(Number(event.transferred) || 0)),
                total: Math.max(0, Math.round(Number(event.total) || 0)),
            };
        case 'downloaded':
            return { ...info, status: 'downloaded', progress: 100, bytesPerSecond: 0, error: null };
        case 'error': {
            if (info.status === 'checking' && info.origin === 'background') {
                // Silent: offline / DNS / GitHub blip on a check nobody asked for.
                return { ...info, status: info.resumeStatus || 'idle', error: null, origin: null, resumeStatus: null };
            }
            return {
                ...info,
                status: 'error',
                error: (event.message && String(event.message)) || 'Unknown update error',
                origin: null,
                resumeStatus: null,
            };
        }
        case 'install-start':
            if (info.status !== 'downloaded') return info;
            return { ...info, status: 'installing' };
        default:
            return info;
    }
}

/** What the renderer receives: the public fields only (no internal bookkeeping). */
function toPublicUpdateInfo(info) {
    return {
        status: info.status,
        progress: info.progress,
        version: info.version,
        error: info.error,
        bytesPerSecond: info.bytesPerSecond,
        transferred: info.transferred,
        total: info.total,
        releaseNotes: info.releaseNotes,
        lastCheckedAt: info.lastCheckedAt,
    };
}

module.exports = {
    UPDATE_STARTUP_DELAY_MS,
    UPDATE_CHECK_INTERVAL_MS,
    createUpdateInfo,
    normalizeReleaseNotes,
    shouldRunBackgroundCheck,
    reduceUpdateInfo,
    toPublicUpdateInfo,
};
