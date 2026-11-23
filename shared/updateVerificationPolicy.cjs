'use strict';

/**
 * Shared update channel verification & semver comparison policy.
 *
 * Used by both `electron/main.cjs` and contract/unit tests so the desktop app
 * keeps full Authenticode verification whenever a signing `publisherName` is
 * configured, while cleanly allowing personal unsigned GitHub releases pinned
 * to the exact `owner/repo` over HTTPS + SHA-512 integrity (`latest.yml`).
 */

const PINNED_UPDATE_REPO = Object.freeze({ owner: 'KILLER3UG', repo: 'augustTrading' });

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(raw) {
    if (typeof raw !== 'string') return null;
    const match = SEMVER_RE.exec(raw.trim());
    if (!match) return null;
    return {
        major: Number.parseInt(match[1], 10),
        minor: Number.parseInt(match[2], 10),
        patch: Number.parseInt(match[3], 10),
        prerelease: match[4] ? match[4].split('.') : [],
    };
}

function compareIdentifiers(a, b) {
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
        const na = Number.parseInt(a, 10);
        const nb = Number.parseInt(b, 10);
        return na === nb ? 0 : na > nb ? 1 : -1;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * Compare two semver strings. Returns 1 when `a > b`, -1 when `a < b`, 0 when
 * equal, or `null` if either string is not valid semver.
 */
function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return null;
    for (const key of ['major', 'minor', 'patch']) {
        if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
    }
    const ap = pa.prerelease;
    const bp = pb.prerelease;
    if (ap.length === 0 && bp.length === 0) return 0;
    if (ap.length === 0) return 1;
    if (bp.length === 0) return -1;
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i += 1) {
        if (i >= ap.length) return -1;
        if (i >= bp.length) return 1;
        const cmp = compareIdentifiers(ap[i], bp[i]);
        if (cmp !== 0) return cmp;
    }
    return 0;
}

/** True iff both versions parse as semver and `candidate > current`. */
function isStrictlyNewerVersion(candidate, current) {
    return compareSemver(candidate, current) === 1;
}

function resolveExpectedUpdateRepo(configured) {
    if (configured?.owner && configured?.repo) return configured;
    return PINNED_UPDATE_REPO;
}

function normalizePublisherNames(raw) {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed ? [trimmed] : [];
    }
    if (Array.isArray(raw)) {
        return raw.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
    }
    return [];
}

/**
 * Evaluate whether the installed app's update channel (`app-update.yml`
 * loaded by `electron-updater`) satisfies our verification policy:
 *
 * 1. Signed build (`publisherName` configured): full Windows Authenticode
 *    signature verification is active.
 * 2. Unsigned personal GitHub build (`publisherName` absent): allowed when
 *    pinned to the exact HTTPS `owner/repo` from `expectedRepo`, relying on
 *    HTTPS transport + `electron-updater`'s SHA-512 verification of `latest.yml`.
 * 3. Any missing, non-HTTPS, or mismatched repo feed is refused.
 */
function evaluateUpdateChannelPolicy(cfg, expectedRepo) {
    if (!cfg || typeof cfg !== 'object') {
        return {
            allowed: false,
            mode: 'refused',
            verifySignature: false,
            reason: 'Update configuration (app-update.yml) is missing or unreadable.',
        };
    }

    const publisherNames = normalizePublisherNames(cfg.publisherName);
    if (publisherNames.length > 0) {
        return {
            allowed: true,
            mode: 'authenticode',
            verifySignature: true,
            publisherName: publisherNames[0],
            reason: 'Windows Authenticode signature verification active.',
        };
    }

    const expectedOwner = typeof expectedRepo?.owner === 'string' ? expectedRepo.owner.trim().toLowerCase() : '';
    const expectedName = typeof expectedRepo?.repo === 'string' ? expectedRepo.repo.trim().toLowerCase() : '';
    const provider = typeof cfg.provider === 'string' ? cfg.provider.trim().toLowerCase() : '';
    const owner = typeof cfg.owner === 'string' ? cfg.owner.trim().toLowerCase() : '';
    const repo = typeof cfg.repo === 'string' ? cfg.repo.trim().toLowerCase() : '';
    const protocol = typeof cfg.protocol === 'string' ? cfg.protocol.trim().toLowerCase() : 'https';
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';

    if (provider !== 'github') {
        return {
            allowed: false,
            mode: 'refused',
            verifySignature: false,
            reason: `Unsigned update channel refused: provider "${cfg.provider ?? 'unknown'}" is not pinned to GitHub.`,
        };
    }
    if (!expectedOwner || !expectedName || owner !== expectedOwner || repo !== expectedName) {
        return {
            allowed: false,
            mode: 'refused',
            verifySignature: false,
            reason: `Unsigned update channel refused: feed "${owner || '?'}/${repo || '?'}" does not match pinned repo "${expectedOwner}/${expectedName}".`,
        };
    }
    if (protocol !== 'https' || (url && !/^https:\/\//i.test(url))) {
        return {
            allowed: false,
            mode: 'refused',
            verifySignature: false,
            reason: 'Unsigned update channel refused: HTTPS transport is required.',
        };
    }

    return {
        allowed: true,
        mode: 'pinned-github-sha512',
        verifySignature: false,
        reason: `Pinned GitHub HTTPS release (${expectedRepo.owner}/${expectedRepo.repo}) with SHA-512 integrity verification (latest.yml).`,
    };
}

module.exports = {
    PINNED_UPDATE_REPO,
    resolveExpectedUpdateRepo,
    compareSemver,
    isStrictlyNewerVersion,
    evaluateUpdateChannelPolicy,
};
