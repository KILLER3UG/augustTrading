/**
 * Single-active-model routing + chart-studies store (2026-11-23).
 *
 * Pins the "one model decision" contract: the composer's persisted pick
 * (`casual_chat_model` = `providerId::modelId`) is what every background and
 * utility call resolves first; legacy stored seat/pick JSON only fills in
 * when the composer has no resolvable pick. Also pins the chart-studies
 * store the ƒ Studies menu rides on: per-user persistence, sanitize-on-read,
 * and exactly-one announcement per write (the live toggle bug was a write
 * firing twice with the inverse value).
 *
 * All offline: no network, no provider. The suite shares one process
 * (`--test-isolation=none --test-concurrency=4`) and these tests SWAP the
 * global localStorage for a private Map for the duration of each test,
 * restoring the previous storage after — so the keys they write never leak
 * into concurrently running suites (the autonomy routing tests read the same
 * keys).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeModelPair, orderReadyByActiveModel, pickActiveModelConfig } from '../src/services/infrastructure/ActiveModelConfig';
import {
    readChartIndicatorSettings,
    writeChartIndicatorSettings,
    subscribeChartIndicatorSettings,
    DEFAULT_CHART_INDICATOR_SETTINGS,
} from '../src/services/trade/chartIndicatorSettings';

/** Run one test body against a PRIVATE localStorage, restoring whatever was
 *  installed before it (nothing leaked into the shared process). */
const withIsolatedStorage = async (body: () => void | Promise<void>): Promise<void> => {
    const g = globalThis as { localStorage?: Storage };
    const had = Object.prototype.hasOwnProperty.call(g, 'localStorage');
    const original = g.localStorage;
    const m = new Map<string, string>();
    g.localStorage = {
        getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
        setItem: (k: string, v: string) => { m.set(k, String(v)); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => { m.clear(); },
    } as Storage;
    try {
        await body();
    } finally {
        if (had) g.localStorage = original;
        else delete g.localStorage;
    }
};

const mkProvider = (id: string, selectedModel: string, models: string[]) => ({
    id, name: id.toUpperCase(), apiKey: 'k', baseUrl: 'https://x/v1',
    apiFormat: 'chat_completions' as const, isEnabled: true, isBuiltIn: false,
    models, selectedModel,
});

describe('single active model — the composer pick leads every route', () => {
    it('reads empty when the composer has never picked', async () => {
        await withIsolatedStorage(() => {
            assert.equal(activeModelPair(), '');
        });
    });

    it('reads the composer pick back from the persisted key', async () => {
        await withIsolatedStorage(() => {
            localStorage.setItem('casual_chat_model', 'prov-b::model-2');
            assert.equal(activeModelPair(), 'prov-b::model-2');
        });
    });

    it('orderReadyByActiveModel puts the composer pick FIRST', async () => {
        await withIsolatedStorage(async () => {
            const ready = [
                mkProvider('prov-a', 'model-1', ['model-1', 'model-2']),
                mkProvider('prov-b', 'model-2', ['model-2']),
            ];
            localStorage.setItem('casual_chat_model', 'prov-b::model-2');
            const ordered = await orderReadyByActiveModel(ready);
            assert.equal(ordered[0].id, 'prov-b');
            assert.equal(ordered[1].id, 'prov-a');
            // No pick: the stored order stands.
            localStorage.removeItem('casual_chat_model');
            const unchanged = await orderReadyByActiveModel(ready);
            assert.deepEqual(unchanged.map(c => c.id), ['prov-a', 'prov-b']);
        });
    });

    it('pickActiveModelConfig overrides the provider selectedModel with the picked model', async () => {
        await withIsolatedStorage(async () => {
            localStorage.setItem('provider_configs_v1', JSON.stringify([
                mkProvider('prov-a', 'model-1', ['model-1', 'model-2']),
            ]));
            localStorage.setItem('casual_chat_model', 'prov-a::model-2');
            const picked = await pickActiveModelConfig();
            assert.ok(picked);
            assert.equal(picked.id, 'prov-a');
            assert.equal(picked.selectedModel, 'model-2');
        });
    });

    it('a stale or absent pick resolves to null so the caller falls back', async () => {
        await withIsolatedStorage(async () => {
            localStorage.setItem('provider_configs_v1', JSON.stringify([
                mkProvider('prov-a', 'model-1', ['model-1']),
            ]));
            localStorage.setItem('casual_chat_model', 'prov-z::nope');
            assert.equal(await pickActiveModelConfig(), null);
            localStorage.removeItem('casual_chat_model');
            assert.equal(await pickActiveModelConfig(), null);
        });
    });
});

describe('chart studies store — the ƒ Studies toggle state', () => {
    it('defaults to the clean chart: price + volume only', async () => {
        await withIsolatedStorage(() => {
            const s = readChartIndicatorSettings('Test User');
            assert.equal(s.visible.volume, true);
            assert.equal(s.visible.ema20, false);
            assert.equal(s.visible.cvd, false);
            assert.equal(DEFAULT_CHART_INDICATOR_SETTINGS.visible.volume, true);
        });
    });

    it('a write persists per user and is announced EXACTLY ONCE with the written value', async () => {
        await withIsolatedStorage(() => {
            const user = 'Store User';
            const base = readChartIndicatorSettings(user);
            const next = { visible: { ...base.visible, ema200: true, volume: false } };
            let calls = 0;
            let announced: unknown = null;
            const unsub = subscribeChartIndicatorSettings(s => { calls += 1; announced = s; });
            writeChartIndicatorSettings(user, next);
            unsub();
            assert.equal(calls, 1, 'one write, one announcement');
            assert.equal(announced, next, 'the listener hears the written object');
            const reread = readChartIndicatorSettings(user);
            assert.equal(reread.visible.ema200, true);
            assert.equal(reread.visible.volume, false);
        });
    });

    it('a partial or unknown blob never half-initialises the chart', async () => {
        await withIsolatedStorage(() => {
            localStorage.setItem('chart_indicators_v1_Blob User', '{"visible":{"volume":true,"ema20":true,"bogus":true}}');
            const s = readChartIndicatorSettings('Blob User');
            assert.equal(s.visible.ema20, true);
            assert.equal(s.visible.ema200, false, 'missing ids take the default');
            assert.equal((s.visible as Record<string, unknown>).bogus, undefined, 'unknown ids are dropped');
        });
    });

    it('a malformed blob falls back to the clean chart', async () => {
        await withIsolatedStorage(() => {
            localStorage.setItem('chart_indicators_v1_Junk User', 'not json at all');
            const s = readChartIndicatorSettings('Junk User');
            assert.equal(s.visible.volume, true);
            assert.equal(s.visible.ema20, false);
        });
    });
});
