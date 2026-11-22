#!/usr/bin/env node
/**
 * verify:fast — every independent READ-ONLY gate, run CONCURRENTLY, with a
 * per-gate timing summary and a non-zero exit if any gate fails.
 *
 * Why concurrently: the gates share no mutable state (tests, contracts, docs,
 * boundaries, palette, the three typechecks and lint each read the tree and
 * write at most their own cache under node_modules/.cache), so the wall clock
 * of the batch is the slowest gate, not the sum of all of them. Every
 * individual `npm run <gate>` script stays intact and remains the authority —
 * this runner only fans them out. A gate that fails fails the batch without
 * cancelling the others, so one run still shows every red gate, not just the
 * first.
 *
 * Usage:  npm run verify:fast          # all gates
 *         node scripts/verify-fast.cjs test:fast lint   # any subset
 */
'use strict';

const { spawn } = require('child_process');

const ALL_GATES = [
    'test:fast',
    'check:contracts',
    'check:docs',
    'check:boundaries',
    'check:palette',
    'typecheck',
    'typecheck:scripts',
    'typecheck:electron',
    'lint',
];

const requested = process.argv.slice(2);
const gates = requested.length > 0 ? requested : ALL_GATES;
const unknown = gates.filter(g => !ALL_GATES.includes(g));
if (unknown.length) {
    console.error(`verify:fast: unknown gate(s): ${unknown.join(', ')}\n  known: ${ALL_GATES.join(', ')}`);
    process.exit(2);
}

const ROOT = require('path').join(__dirname, '..');
const results = [];
let settled = 0;

const runGate = (gate) => new Promise((resolve) => {
    const t0 = Date.now();
    // Buffer each gate's output and print it on completion, prefixed per line:
    // 9 interleaved streams would be unreadable, and a failure must be
    // attributable to its gate at a glance.
    const child = spawn(`npm run ${gate}`, {
        cwd: ROOT,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        windowsHide: true,
    });
    let out = '';
    const chunk = (d) => { out += String(d); };
    child.stdout.on('data', chunk);
    child.stderr.on('data', chunk);
    child.on('close', (code) => {
        const ms = Date.now() - t0;
        results.push({ gate, ms, code: code ?? 1, out });
        settled += 1;
        const status = code === 0 ? 'PASS' : 'FAIL';
        console.log(`[${status}] ${gate} — ${(ms / 1000).toFixed(2)}s`);
        if (code !== 0) {
            console.log(out.trim().split('\n').slice(-40).map(l => `    | ${l}`).join('\n'));
        }
        if (settled === gates.length) resolve();
        else resolve();
    });
});

(async () => {
    const t0 = Date.now();
    console.log(`verify:fast — ${gates.length} gates in parallel:\n  ${gates.join('\n  ')}\n`);
    await Promise.all(gates.map(runGate));
    const totalMs = Date.now() - t0;

    results.sort((a, b) => b.ms - a.ms);
    console.log('\n---- verify:fast summary (slowest first) ----');
    for (const { gate, ms, code } of results) {
        console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${gate.padEnd(22)} ${(ms / 1000).toFixed(2)}s`);
    }
    const failed = results.filter(r => r.code !== 0);
    const sumMs = results.reduce((n, r) => n + r.ms, 0);
    console.log(`\nwall ${(totalMs / 1000).toFixed(2)}s (sequential-equivalent ${(sumMs / 1000).toFixed(2)}s)`
        + ` — ${results.length - failed.length}/${results.length} gates passed`);
    if (failed.length) {
        console.error(`verify:fast FAILED: ${failed.map(f => f.gate).join(', ')}`);
        process.exit(1);
    }
    console.log('verify:fast OK — all gates green.');
})().catch((err) => {
    console.error('verify:fast driver error:', err);
    process.exit(1);
});
