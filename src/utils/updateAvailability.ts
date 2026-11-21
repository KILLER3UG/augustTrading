import type { ElectronUpdateStatus } from '../types/electron';

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

const parseSemver = (raw: string | null | undefined): ParsedSemver | null => {
    if (typeof raw !== 'string') return null;
    const match = SEMVER_RE.exec(raw.trim());
    if (!match) return null;
    return {
        major: Number.parseInt(match[1], 10),
        minor: Number.parseInt(match[2], 10),
        patch: Number.parseInt(match[3], 10),
        prerelease: match[4] ? match[4].split('.') : [],
    };
};

const compareIdentifiers = (a: string, b: string): number => {
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
        const na = Number.parseInt(a, 10);
        const nb = Number.parseInt(b, 10);
        return na === nb ? 0 : na > nb ? 1 : -1;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a === b ? 0 : a > b ? 1 : -1;
};

/**
 * Compare two semver strings. Returns 1 when `a > b`, -1 when `a < b`, 0 when
 * equal, or `null` if either value is not valid semver.
 */
export const compareSemver = (a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return null;
    if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
    if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
    if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
    if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
    if (pa.prerelease.length === 0) return 1;
    if (pb.prerelease.length === 0) return -1;
    const len = Math.max(pa.prerelease.length, pb.prerelease.length);
    for (let i = 0; i < len; i += 1) {
        if (i >= pa.prerelease.length) return -1;
        if (i >= pb.prerelease.length) return 1;
        const cmp = compareIdentifiers(pa.prerelease[i], pb.prerelease[i]);
        if (cmp !== 0) return cmp as -1 | 1;
    }
    return 0;
};

/** True iff both versions parse as semver and `candidate > current`. */
export const isStrictlyNewerVersion = (
    candidate: string | null | undefined,
    current: string | null | undefined,
): boolean => compareSemver(candidate, current) === 1;

/**
 * Header update button visibility gate: hidden when idle, checking, up-to-date,
 * errored, or installing; rendered ONLY when a strictly newer release is
 * available, downloading, or downloaded and ready to install.
 */
export const shouldShowUpdateButton = (
    updateStatus: ElectronUpdateStatus,
    currentVersion: string | null | undefined,
): boolean => {
    const { status, version } = updateStatus;
    if (status === 'available') {
        return isStrictlyNewerVersion(version, currentVersion);
    }
    if (status === 'downloading' || status === 'downloaded') {
        return !version || isStrictlyNewerVersion(version, currentVersion);
    }
    return false;
};
