import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    compareSemver,
    isStrictlyNewerVersion,
    shouldShowUpdateButton,
} from '../src/utils/updateAvailability';

const require = createRequire(import.meta.url);
const policy = require('../shared/updateVerificationPolicy.cjs') as {
    PINNED_UPDATE_REPO: { owner: string; repo: string };
    resolveExpectedUpdateRepo: (configured?: { owner?: string; repo?: string } | null) => { owner: string; repo: string };
    compareSemver: (a: string, b: string) => number | null;
    isStrictlyNewerVersion: (candidate: string, current: string) => boolean;
    evaluateUpdateChannelPolicy: (
        cfg: Record<string, unknown> | null,
        expectedRepo: { owner?: string; repo?: string },
    ) => { allowed: boolean; mode: string; verifySignature: boolean; reason: string };
};

describe('UpdateButton visibility & semver comparison', () => {
    it('compares semver versions strictly and rejects equal or older releases', () => {
        assert.equal(compareSemver('1.5.1', '1.5.0'), 1);
        assert.equal(compareSemver('v1.6.0', '1.5.0'), 1);
        assert.equal(compareSemver('1.5.0', '1.5.0'), 0);
        assert.equal(compareSemver('1.4.9', '1.5.0'), -1);
        assert.equal(compareSemver('1.5.0', '1.5.0-rc.1'), 1);

        assert.equal(isStrictlyNewerVersion('1.5.1', '1.5.0'), true);
        assert.equal(isStrictlyNewerVersion('1.5.0', '1.5.0'), false);
        assert.equal(isStrictlyNewerVersion('1.4.9', '1.5.0'), false);
        assert.equal(isStrictlyNewerVersion(null, '1.5.0'), false);
    });

    it('hides UpdateButton when idle, checking, up-to-date, errored, installing, or same/older version', () => {
        const base = { progress: 0, version: null, error: null };
        assert.equal(shouldShowUpdateButton({ ...base, status: 'idle' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'checking' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'upToDate' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'error', error: 'network fail' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'installing', version: '1.6.0' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'available', version: '1.5.0' }, '1.5.0'), false);
        assert.equal(shouldShowUpdateButton({ ...base, status: 'available', version: '1.4.9' }, '1.5.0'), false);
    });

    it('shows UpdateButton ONLY when a strictly newer release is available, downloading, or downloaded', () => {
        assert.equal(shouldShowUpdateButton({ status: 'available', progress: 0, version: '1.5.1', error: null }, '1.5.0'), true);
        assert.equal(shouldShowUpdateButton({ status: 'downloading', progress: 42, version: '1.5.1', error: null }, '1.5.0'), true);
        assert.equal(shouldShowUpdateButton({ status: 'downloaded', progress: 100, version: '1.5.1', error: null }, '1.5.0'), true);
    });

    it('uses a static monochrome Download icon (no RefreshCw or animate-spin)', () => {
        const src = fs.readFileSync(path.resolve('src/components/shared/UpdateButton.tsx'), 'utf8');
        assert.match(src, /<Download\b/);
        assert.doesNotMatch(src, /RefreshCw/);
        assert.doesNotMatch(src, /animate-spin/);
    });
});

describe('Updater verification policy — Authenticode signed vs pinned unsigned GitHub', () => {
    const pinnedRepo = { owner: 'KILLER3UG', repo: 'augustTrading' };

    it('enforces Authenticode verification when publisherName is configured', () => {
        const res = policy.evaluateUpdateChannelPolicy(
            { provider: 'github', owner: 'KILLER3UG', repo: 'augustTrading', publisherName: 'CN=August Trading' },
            pinnedRepo,
        );
        assert.equal(res.allowed, true);
        assert.equal(res.mode, 'authenticode');
        assert.equal(res.verifySignature, true);
    });

    it('allows unsigned personal builds pinned to the exact HTTPS GitHub repo (SHA-512 verified by latest.yml)', () => {
        const res = policy.evaluateUpdateChannelPolicy(
            { provider: 'github', owner: 'KILLER3UG', repo: 'augustTrading' },
            pinnedRepo,
        );
        assert.equal(res.allowed, true);
        assert.equal(res.mode, 'pinned-github-sha512');
        assert.equal(res.verifySignature, false);
    });

    it('keeps the pinned repo identity available when the packaged package.json omits build.publish', () => {
        assert.deepEqual(policy.PINNED_UPDATE_REPO, pinnedRepo);
        assert.deepEqual(policy.resolveExpectedUpdateRepo(undefined), pinnedRepo);
        assert.deepEqual(policy.resolveExpectedUpdateRepo({}), pinnedRepo);
        assert.deepEqual(policy.resolveExpectedUpdateRepo({ owner: 'other', repo: 'other' }), { owner: 'other', repo: 'other' });
        const res = policy.evaluateUpdateChannelPolicy(
            { provider: 'github', owner: 'killer3ug', repo: 'augusttrading' },
            policy.PINNED_UPDATE_REPO,
        );
        assert.equal(res.allowed, true);
        assert.equal(res.mode, 'pinned-github-sha512');
    });

    it('refuses unsigned builds pointing to a mismatched repo, non-GitHub feed, plain HTTP, or missing config', () => {
        assert.equal(policy.evaluateUpdateChannelPolicy(null, pinnedRepo).allowed, false);
        assert.equal(
            policy.evaluateUpdateChannelPolicy({ provider: 'github', owner: 'attacker', repo: 'augustTrading' }, pinnedRepo).allowed,
            false,
        );
        assert.equal(
            policy.evaluateUpdateChannelPolicy({ provider: 'generic', url: 'https://evil.example/updates' }, pinnedRepo).allowed,
            false,
        );
        assert.equal(
            policy.evaluateUpdateChannelPolicy({ provider: 'github', owner: 'KILLER3UG', repo: 'augustTrading', protocol: 'http' }, pinnedRepo).allowed,
            false,
        );
    });
});

describe('Updater state machine & packaged main/build pins (offline)', () => {
    const sm = require('../shared/updaterStateMachine.cjs') as {
        UPDATE_STARTUP_DELAY_MS: number;
        UPDATE_CHECK_INTERVAL_MS: number;
        createUpdateInfo: () => Record<string, unknown>;
        shouldRunBackgroundCheck: (info: Record<string, unknown>) => boolean;
        reduceUpdateInfo: (info: Record<string, unknown>, event: Record<string, unknown>, now?: number) => Record<string, unknown>;
        toPublicUpdateInfo: (info: Record<string, unknown>) => Record<string, unknown>;
    };

    it('transitions cleanly through checking → available → downloading → downloaded → installing and strips internal fields', () => {
        let s = sm.createUpdateInfo();
        assert.equal(s.status, 'idle');
        assert.equal(sm.shouldRunBackgroundCheck(s), true);

        s = sm.reduceUpdateInfo(s, { type: 'check-start', manual: false }, 1000);
        assert.equal(s.status, 'checking');
        assert.equal(sm.shouldRunBackgroundCheck(s), false);

        s = sm.reduceUpdateInfo(s, { type: 'available', version: '1.6.4', currentVersion: '1.6.3', releaseNotes: '## Fixed\n- Bug' }, 2000);
        assert.equal(s.status, 'available');
        assert.equal(s.version, '1.6.4');
        assert.equal(s.lastCheckedAt, 2000);

        s = sm.reduceUpdateInfo(s, { type: 'progress', percent: 42.4, bytesPerSecond: 1024000, transferred: 4240, total: 10000 });
        assert.equal(s.status, 'downloading');
        assert.equal(s.progress, 42);
        assert.equal(sm.shouldRunBackgroundCheck(s), false);

        // install-start is ignored before downloaded
        assert.strictEqual(sm.reduceUpdateInfo(s, { type: 'install-start' }), s);

        s = sm.reduceUpdateInfo(s, { type: 'downloaded' });
        assert.equal(s.status, 'downloaded');
        assert.equal(s.progress, 100);
        assert.equal(sm.shouldRunBackgroundCheck(s), false);

        s = sm.reduceUpdateInfo(s, { type: 'install-start' });
        assert.equal(s.status, 'installing');

        const pub = sm.toPublicUpdateInfo(s);
        assert.equal(Object.prototype.hasOwnProperty.call(pub, 'origin'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(pub, 'resumeStatus'), false);
        assert.equal(pub.status, 'installing');
    });

    it('swallows background offline errors silently while surfacing manual check errors visibly', () => {
        const upToDate = sm.reduceUpdateInfo(sm.createUpdateInfo(), { type: 'not-available' }, 1500);
        assert.equal(upToDate.status, 'upToDate');
        assert.equal(upToDate.lastCheckedAt, 1500);

        const bgChecking = sm.reduceUpdateInfo(upToDate, { type: 'check-start', manual: false });
        const afterBgErr = sm.reduceUpdateInfo(bgChecking, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
        assert.equal(afterBgErr.status, 'upToDate');
        assert.equal(afterBgErr.error, null);

        const manualChecking = sm.reduceUpdateInfo(upToDate, { type: 'check-start', manual: true });
        const afterManualErr = sm.reduceUpdateInfo(manualChecking, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
        assert.equal(afterManualErr.status, 'error');
        assert.equal(afterManualErr.error, 'net::ERR_INTERNET_DISCONNECTED');
    });

    it('pins safe updater flags in electron/main.cjs and unsigned SHA-512 GitHub feed in package.json', () => {
        const mainSrc = fs.readFileSync(path.resolve('electron/main.cjs'), 'utf8');
        assert.match(mainSrc, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
        assert.match(mainSrc, /autoUpdater\.disableWebInstaller\s*=\s*true/);
        assert.match(mainSrc, /autoUpdater\.quitAndInstall\(false,\s*true\)/);

        const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
            build?: { win?: { verifyUpdateCodeSignature?: boolean }; publish?: { provider?: string; owner?: string; repo?: string } };
        };
        assert.equal(pkg.build?.win?.verifyUpdateCodeSignature, false);
        assert.equal(pkg.build?.publish?.provider, 'github');
        assert.equal(pkg.build?.publish?.owner, 'KILLER3UG');
        assert.equal(pkg.build?.publish?.repo, 'augustTrading');
        assert.ok(sm.UPDATE_STARTUP_DELAY_MS >= 3000 && sm.UPDATE_STARTUP_DELAY_MS <= 15000);
        assert.ok(sm.UPDATE_CHECK_INTERVAL_MS >= 3600_000);
    });
});
