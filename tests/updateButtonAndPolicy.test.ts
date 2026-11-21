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
