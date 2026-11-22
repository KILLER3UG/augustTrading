#!/usr/bin/env node
/**
 * probe:fast — boot-probe + render-probe back-to-back, sharing ONE Chromium
 * browser and never rebuilding a fresh dist/ twice.
 *
 * What it does, in order:
 *   1. Freshness check: if dist/index.html is older than any source that
 *      feeds the production bundle (src/, public/, shared/, electron/, the
 *      configs), run `npm run build` first. A stale build is never tested
 *      silently; pass --rebuild to force one explicitly.
 *   2. Launch ONE headless Chromium (launchServer) and hand its endpoint to
 *      both probes via AUGUST_PROBE_WS_ENDPOINT — each probe opens its own
 *      pages/contexts, but the browser process is paid for once.
 *   3. Phase "boot": start `vite preview` (the PRODUCTION bundle) on
 *      PROBE_PORT and run scripts/boot-probe.cjs against it.
 *   4. Phase "render": start the vite DEV server + the mock provider (the
 *      dev server is deliberate — see render-probe.cjs — the provider calls
 *      are same-origin under the dev proxy) and run scripts/render-probe.cjs.
 *   5. Print per-phase timings and exit non-zero if the build, either probe,
 *      or any pageerror failed (each probe already exits non-zero on its own
 *      failures; this runner only propagates them).
 *
 * Both probes abort third-party market endpoints instantly, so the whole run
 * stays 100% offline.
 *
 * Usage:  npm run probe:fast
 *         npm run probe:fast -- --rebuild     # force a fresh production build
 *         PROBE_PORT=4183 MOCK_PORT=8787 npm run probe:fast
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4183;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const forceRebuild = process.argv.includes('--rebuild');

// Same DNS-level third-party block the individual probes use (see
// boot-probe.cjs): the shared Chromium never resolves a market-data host, so
// neither probe can touch the live internet or stall on an external timeout.
const PROBE_CHROMIUM_ARGS = [`--host-resolver-rules=${[
    'MAP binance.com ~NOTFOUND', 'MAP *.binance.com ~NOTFOUND',
    'MAP okx.com ~NOTFOUND', 'MAP *.okx.com ~NOTFOUND',
    'MAP deribit.com ~NOTFOUND', 'MAP *.deribit.com ~NOTFOUND',
    'MAP bybit.com ~NOTFOUND', 'MAP *.bybit.com ~NOTFOUND',
].join(', ')}`];

// ─── dist/ freshness ────────────────────────────────────────────────────────
const FRESHNESS_ROOTS = ['src', 'public', 'shared', 'electron'];
const FRESHNESS_FILES = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'capacitor.config.ts'];

const newestMtimeUnder = (dir) => {
    let newest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        newest = Math.max(newest, entry.isDirectory() ? newestMtimeUnder(abs) : fs.statSync(abs).mtimeMs);
    }
    return newest;
};

/** True when dist/index.html exists and is newer than every input. A stale
 *  (or missing) build returns false so the build is never skipped silently. */
const distIsFresh = () => {
    const distIndex = path.join(ROOT, 'dist', 'index.html');
    if (!fs.existsSync(distIndex)) return false;
    const builtAt = fs.statSync(distIndex).mtimeMs;
    let newestInput = 0;
    for (const root of FRESHNESS_ROOTS) {
        const abs = path.join(ROOT, root);
        if (fs.existsSync(abs)) newestInput = Math.max(newestInput, newestMtimeUnder(abs));
    }
    for (const file of FRESHNESS_FILES) {
        const abs = path.join(ROOT, file);
        if (fs.existsSync(abs)) newestInput = Math.max(newestInput, fs.statSync(abs).mtimeMs);
    }
    return builtAt >= newestInput;
};

// ─── server helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    return false;
}

/** Wait until the port is actually free again before the next phase binds it
 *  with --strictPort — a SIGTERM'd vite can hold the socket for a beat. */
async function waitForPortFree(port, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const free = await new Promise((resolve) => {
            const probe = net.createServer();
            probe.once('error', () => resolve(false));
            probe.once('listening', () => probe.close(() => resolve(true)));
            probe.listen(port, '127.0.0.1');
        });
        if (free) return true;
        await sleep(150);
    }
    return false;
}

const spawnVite = (args, label) => {
    const child = spawn(process.execPath, [VITE_BIN, ...args], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    // Collected so a startup failure can show WHY the server never came up;
    // the probe children print their own output via stdio: 'inherit'.
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.childOut = () => out;
    child._label = label;
    return child;
};

const runProbeScript = (script, extraEnv) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script)], {
        cwd: ROOT,
        env: { ...process.env, ...extraEnv },
        stdio: 'inherit',
        windowsHide: true,
    });
    child.on('close', (code) => resolve(code ?? 1));
});

(async () => {
    const t0 = Date.now();
    const phases = [];

    // 1. Build only when stale (or when --rebuild forces it).
    if (forceRebuild || !distIsFresh()) {
        console.log('[probe:fast] dist/ is stale or missing — running npm run build');
        const buildT0 = Date.now();
        const build = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true });
        const buildCode = await new Promise((resolve) => build.on('close', resolve));
        phases.push(`build: ${((Date.now() - buildT0) / 1000).toFixed(2)}s (exit=${buildCode})`);
        if (buildCode !== 0) {
            console.error('[probe:fast] build failed — refusing to probe a broken or stale bundle');
            process.exit(1);
        }
    } else {
        phases.push('build: skipped (dist/ is fresh)');
        console.log('[probe:fast] dist/ is fresh — skipping the build (pass --rebuild to force one)');
    }

    // 2. ONE Chromium for both probes.
    const browserServer = await chromium.launchServer({ headless: true, args: PROBE_CHROMIUM_ARGS });
    const wsEndpoint = browserServer.wsEndpoint();
    const sharedEnv = { AUGUST_PROBE_WS_ENDPOINT: wsEndpoint, PROBE_PORT: String(PORT), MOCK_PORT: String(MOCK_PORT) };
    let bootCode = 1;
    let renderCode = 1;
    try {
        // 3. Boot phase — PRODUCTION bundle via vite preview.
        const preview = spawnVite(['preview', '--port', String(PORT), '--strictPort'], 'vite preview');
        const bootT0 = Date.now();
        try {
            if (!(await waitForServer(BASE))) {
                console.error(`[probe:fast] vite preview never came up on ${BASE}\n${preview.childOut()}`);
                bootCode = 1;
            } else {
                bootCode = await runProbeScript('boot-probe.cjs', { ...sharedEnv, PROBE_REUSE: '1' });
            }
        } finally {
            preview.kill('SIGTERM');
            await waitForPortFree(PORT);
        }
        phases.push(`boot-probe: ${((Date.now() - bootT0) / 1000).toFixed(2)}s (exit=${bootCode})`);

        // 4. Render phase — vite DEV server + mock provider (deliberate; see
        // render-probe.cjs: the provider calls are same-origin under the dev
        // proxy, which the prod preview cannot offer).
        const dev = spawnVite(['--port', String(PORT), '--strictPort'], 'vite dev');
        const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        const renderT0 = Date.now();
        try {
            if (!(await waitForServer(BASE)) || !(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
                console.error(`[probe:fast] dev server or mock provider never came up (base=${BASE} mock=${MOCK_PORT})\n${dev.childOut()}`);
                renderCode = 1;
            } else {
                renderCode = await runProbeScript('render-probe.cjs', { ...sharedEnv, PROBE_REUSE: '1' });
            }
        } finally {
            dev.kill('SIGTERM');
            mock.kill('SIGTERM');
            await waitForPortFree(PORT);
            await waitForPortFree(MOCK_PORT);
        }
        phases.push(`render-probe: ${((Date.now() - renderT0) / 1000).toFixed(2)}s (exit=${renderCode})`);
    } finally {
        await browserServer.close().catch(() => { /* already gone */ });
    }

    console.log('\n---- probe:fast summary ----');
    for (const line of phases) console.log('  ' + line);
    console.log(`  total: ${((Date.now() - t0) / 1000).toFixed(2)}s — one Chromium, one build at most`);
    if (bootCode !== 0 || renderCode !== 0) {
        console.error(`probe:fast FAILED (boot=${bootCode} render=${renderCode})`);
        process.exit(1);
    }
    console.log('probe:fast OK — boot-probe and render-probe both passed with zero pageerrors.');
})().catch((err) => {
    console.error('probe:fast driver error:', err);
    process.exit(1);
});
