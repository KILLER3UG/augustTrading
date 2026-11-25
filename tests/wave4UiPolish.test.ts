/**
 * wave4UiPolish — offline unit tests for Wave 4 UI formatting helpers (`src/utils/uiFormatting.ts`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatAssistantFooterMeta,
    formatStorageBackendLabel,
    formatThreadBadge,
    humanizeSkillTitle,
    partitionMemoryFolders,
    shouldSuppressStandAsideLevels,
} from '../src/utils/uiFormatting';

describe('Wave 4 Minimalist & Beginner-Clear UI Helpers', () => {
    it('formatStorageBackendLabel reports Electron desktop honestly and preserves web storage strings', () => {
        assert.equal(formatStorageBackendLabel('indexeddb', true), 'Local desktop storage (Electron)');
        assert.equal(formatStorageBackendLabel('sqlite', true), 'Local desktop storage (Electron)');
        assert.equal(formatStorageBackendLabel('indexeddb', false), 'IndexedDB — inside the browser profile');
        assert.equal(formatStorageBackendLabel('sqlite', false), 'SQLite — the app’s own data file');
    });

    it('humanizeSkillTitle formats kebab slugs cleanly while preserving acronyms & curated names', () => {
        assert.equal(
            humanizeSkillTitle('repeat-inside-bar-mother-resolution', 'repeat-inside-bar-mother-resolution'),
            'Inside Bar Mother Resolution',
        );
        assert.equal(
            humanizeSkillTitle('btc-vwap-smc-bos', 'btc-vwap-smc-bos'),
            'BTC VWAP SMC BOS',
        );
        assert.equal(
            humanizeSkillTitle('London Sweep & Structure Shift', 'london-sweep-bos'),
            'London Sweep & Structure Shift',
        );
    });

    it('partitionMemoryFolders separates populated folders from empty folders', () => {
        const { active, empty } = partitionMemoryFolders([
            { id: '1', name: 'profile', count: 2 },
            { id: '2', name: 'strategies', count: 0 },
            { id: '3', name: 'lessons', count: 1 },
            { id: '4', name: 'archive', count: 0 },
        ]);
        assert.deepEqual(active.map(f => f.name), ['profile', 'lessons']);
        assert.deepEqual(empty.map(f => f.name), ['strategies', 'archive']);
    });

    it('formatAssistantFooterMeta deduplicates thinking tier and strips raw internal provider ids', () => {
        const nowMs = Date.parse('2026-11-25T15:00:00.000Z');
        const at = nowMs - 5 * 3_600_000;
        const line = formatAssistantFooterMeta({
            speaker: 'custom:ernie-5.5-flash',
            effort: 'max',
            at,
        }, nowMs);
        assert.ok(line);
        assert.equal(line!.toLowerCase().includes('custom:'), false);
        assert.equal(line!.split(' · ').filter(p => p === 'Max').length, 1);
        assert.ok(line!.includes('5h ago'));

        const deskOnly = formatAssistantFooterMeta({ speaker: 'desk', effort: 'high', at }, nowMs);
        assert.equal(deskOnly, 'High · 5h ago');
    });

    it('formatThreadBadge renders coin + timeframe cleanly without raw USDT suffix', () => {
        assert.equal(formatThreadBadge('BTCUSDT', '15m'), 'BTC · 15m');
        assert.equal(formatThreadBadge('SOLUSDT', '4h'), 'SOL · 4h');
        assert.equal(formatThreadBadge('USDCUSDT', '1h'), 'USDC · 1h');
        assert.equal(formatThreadBadge('', ''), null);
    });

    it('shouldSuppressStandAsideLevels suppresses empty stand-aside grids while keeping numeric or active verdicts', () => {
        assert.equal(shouldSuppressStandAsideLevels({ direction: 'WAIT' }), true);
        assert.equal(shouldSuppressStandAsideLevels({ direction: 'NO_TRADE', entryPoints: [{ price: '—' }], stopLoss: null }), true);
        assert.equal(shouldSuppressStandAsideLevels({ direction: 'Neutral' }), true);
        assert.equal(shouldSuppressStandAsideLevels({
            direction: 'Neutral',
            entryPoints: [{ price: '84210.5' }],
            stopLoss: '83100',
            takeProfit: [{ price: '87900' }],
        }), false);
        assert.equal(shouldSuppressStandAsideLevels({ direction: 'Long' }), false);
        assert.equal(shouldSuppressStandAsideLevels({ direction: 'Short' }), false);
    });
});
