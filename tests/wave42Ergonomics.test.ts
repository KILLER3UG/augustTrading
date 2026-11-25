/**
 * wave42Ergonomics — offline unit tests for Wave 4.2 ergonomics:
 *   - Recursive redaction of API keys, bearer tokens, passwords, and secrets in diagnostic exports
 *   - Context-window usage ring clamping and 90% auto-compact token headroom
 *   - Long user prompt collapsibility thresholds and preview truncation
 *   - `autoFoldTools` & `sendWhileRunning` harnessSettings defaults, persistence, and snapshot stability
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map<string, string>();
const storageShim: Storage = {
    get length() { return backing.size; },
    clear: () => backing.clear(),
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    removeItem: (k: string) => { backing.delete(k); },
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
};
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = storageShim;

import { buildRedactedDiagnosticBundle, redactSensitiveFields } from '../src/services/trade/diagnosticsCore';
import { computeContextRingUsage, summarizeCollapsiblePrompt } from '../src/utils/uiFormatting';
import { getHarnessSettings, saveHarnessSettings } from '../src/utils/harnessSettings';

describe('Wave 4.2 Ergonomics & Redacted Diagnostics', () => {
    it('1. redactSensitiveFields and buildRedactedDiagnosticBundle strip all secrets while keeping token counters', () => {
        const dirty = {
            apiKey: 'sk-live-secret-999999999',
            nested: {
                authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
                'x-api-key': 'raw-header-key-123',
                password: 'hunter2-password',
                secret: 'top-secret',
                headers: ['Authorization: Bearer top-bearer-token-xyz'],
            },
            windowTokens: 128000,
            totalTokens: 2450,
            tokensIn: 1200,
            tokensOut: 300,
        };
        const clean = redactSensitiveFields(dirty);
        assert.equal(clean.apiKey, '[REDACTED]');
        assert.equal(clean.nested.authorization, '[REDACTED]');
        assert.equal(clean.nested['x-api-key'], '[REDACTED]');
        assert.equal(clean.nested.password, '[REDACTED]');
        assert.equal(clean.nested.secret, '[REDACTED]');
        assert.equal(clean.nested.headers[0], 'Authorization: [REDACTED]');
        assert.equal(clean.windowTokens, 128000);
        assert.equal(clean.totalTokens, 2450);

        const bundle = buildRedactedDiagnosticBundle({
            appVersion: '1.6.3',
            isElectron: false,
            activeModel: {
                providerName: 'OpenRouter',
                modelId: 'ernie-5.5-flash',
                effort: 'max',
                reasoningCapable: true,
                visionCapable: false,
            },
            doctor: {
                kind: 'doctor',
                generatedAt: '2026-11-25T13:00:00.000Z',
                overall: 'PASS',
                checks: [{
                    id: 'model',
                    label: 'Active Model & Capabilities',
                    status: 'PASS',
                    summary: 'header x-api-key=secret-abc-123 failed? Bearer sk-testsecret123456',
                }],
            },
            recentErrors: [{
                source: 'lastPromiseError',
                timestamp: '2026-11-25T13:00:00.000Z',
                message: 'Request failed with api_key=sk-secret-key-987654321 and Bearer abcdefghij123456',
            }],
        });
        const dumped = JSON.stringify(bundle);
        assert.equal(dumped.includes('secret-abc-123'), false);
        assert.equal(dumped.includes('sk-testsecret123456'), false);
        assert.equal(dumped.includes('sk-secret-key-987654321'), false);
        assert.equal(dumped.includes('abcdefghij123456'), false);
        assert.ok(dumped.includes('[REDACTED]'));
    });

    it('2. computeContextRingUsage clamps 0..100% and computes 90% auto-compact headroom', () => {
        const empty = computeContextRingUsage({ totalTokens: -50, windowTokens: 100_000 });
        assert.equal(empty.totalTokens, 0);
        assert.equal(empty.pctUsed, 0);
        assert.equal(empty.autoCompactTriggerTokens, 90_000);
        assert.equal(empty.tokensToAutoCompact, 90_000);
        assert.ok(Math.abs(empty.dashOffset - empty.circumference) < 1e-6);

        const mid = computeContextRingUsage({ totalTokens: 50_000, windowTokens: 100_000 });
        assert.equal(mid.pctUsed, 50);
        assert.equal(mid.tokensToAutoCompact, 40_000);
        assert.ok(mid.tooltip.includes('50,000 / 100,000 tokens (50%)'));
        assert.ok(mid.tooltip.includes('40,000 tokens to 90% auto-compact'));

        const over = computeContextRingUsage({ totalTokens: 250_000, windowTokens: 100_000 });
        assert.equal(over.pctUsed, 100);
        assert.equal(over.tokensToAutoCompact, 0);
        assert.ok(Math.abs(over.dashOffset) < 1e-6);
    });

    it('3. summarizeCollapsiblePrompt collapses > 6 lines or >= 420-char multiline prompts', () => {
        const sixLines = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].join('\n');
        const shortRes = summarizeCollapsiblePrompt(sixLines);
        assert.equal(shortRes.collapsible, false);
        assert.equal(shortRes.lineCount, 6);

        const sevenLines = ['First audit line of a detailed prompt', '2', '3', '4', '5', '6', '7'].join('\n');
        const longRes = summarizeCollapsiblePrompt(sevenLines);
        assert.equal(longRes.collapsible, true);
        assert.equal(longRes.lineCount, 7);
        assert.equal(longRes.preview, 'First audit line of a detailed prompt');

        const longMultiline = `${'A'.repeat(90)} detailed first line\n${'B'.repeat(400)}`;
        const charRes = summarizeCollapsiblePrompt(longMultiline);
        assert.equal(charRes.collapsible, true);
        assert.equal(charRes.lineCount, 2);
        assert.ok(charRes.preview.length <= 72);
        assert.ok(charRes.preview.endsWith('…'));
    });

    it('4. autoFoldTools and sendWhileRunning default safely, persist, and return stable snapshot references', () => {
        const ls = g.localStorage as Storage;
        const prev = ls.getItem('harness_settings_v1');
        try {
            ls.removeItem('harness_settings_v1');
            const defaults1 = getHarnessSettings();
            const defaults2 = getHarnessSettings();
            assert.equal(defaults1, defaults2, 'unchanged storage returns cached referential snapshot');
            assert.equal(defaults1.autoFoldTools, true);
            assert.equal(defaults1.sendWhileRunning, 'steer');

            saveHarnessSettings({ autoFoldTools: false, sendWhileRunning: 'queue' });
            const updated1 = getHarnessSettings();
            const updated2 = getHarnessSettings();
            assert.equal(updated1, updated2, 'updated storage caches referential snapshot');
            assert.equal(updated1.autoFoldTools, false);
            assert.equal(updated1.sendWhileRunning, 'queue');
        } finally {
            if (prev === null) ls.removeItem('harness_settings_v1');
            else ls.setItem('harness_settings_v1', prev);
        }
    });
});
