#!/usr/bin/env node
/**
 * tool-smoke — run the market-structure tools END TO END against the live
 * Binance futures API. The contract suite proves the math on synthetic
 * fixtures and the boot/render probes prove the bundle mounts; NOTHING in
 * the gate ladder executes a real fetch through the adapters — this does.
 *
 * A dev instrument, not a gate (gates.md). Graceful without network: every
 * failure prints the tool's own honest envelope and the run exits 0 unless a
 * tool THREW past its boundary (which would be the defect this exists to
 * catch — design rule: a tool never throws past its adapter).
 *
 * Usage: node scripts/tool-smoke.cjs [symbol=BTCUSDT]
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

const loadMarketTools = () => {
    const tmp = path.join(os.tmpdir(), `tool-smoke-${process.pid}.cjs`);
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    esbuild.buildSync({
        stdin: { contents: `export * from './src/services/analysis/marketTools';`, resolveDir: ROOT, sourcefile: 'tool-smoke-entry.ts', loader: 'ts' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: tmp,
        logLevel: 'error',
    });
    try {
        delete require.cache[tmp];
        return require(tmp);
    } finally {
        delete require.cache[tmp];
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
};

const summarize = (tool, content, tookMs) => {
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        return `  ✗ ${tool}: non-JSON result (${String(content).slice(0, 80)}…)`;
    }
    const dq = parsed.data_quality ?? {};
    const line = parsed.one_line_summary ?? '';
    const flag = dq.available === false ? '⚠' : '✓';
    return `  ${flag} ${tool} (${tookMs}ms, ${dq.bars_used ?? '?'} bars): ${line}${dq.available === false ? ` — reason: ${dq.reason ?? '?'}` : ''}`;
};

const main = async () => {
    const symbol = String(process.argv[2] || 'BTCUSDT').toUpperCase();
    const mt = loadMarketTools();
    const calls = [
        ['volume_profile(session)', () => mt.runVolumeProfileTool(symbol, 'session')],
        ['naked_pocs', () => mt.runNakedPocsTool(symbol, 'day', 5)],
        ['vwap(session_open)', () => mt.runVwapTool(symbol, 'session_open')],
        ['order_flow', () => mt.runOrderFlowTool(symbol, '15m', 20)],
        ['effort_vs_result', () => mt.runEffortResultTool(symbol, '1h')],
        ['auction_state', () => mt.runAuctionStateTool(symbol)],
        ['get_regime', () => mt.runRegimeTool(symbol, '1h')],
        ['trade_math', () => mt.runTradeMathTool(symbol, 'Long', 1, 0.99, [1.03], { leverage: 10 })],
        ['swing_structure', () => mt.runStructureTool('swing_structure', symbol, '1h')],
        ['liquidity', () => mt.runStructureTool('liquidity', symbol, '1h')],
        ['imbalances', () => mt.runStructureTool('imbalances', symbol, '1h')],
        ['sr_zones', () => mt.runStructureTool('sr_zones', symbol, '1h')],
        ['wyckoff_events', () => mt.runStructureTool('wyckoff_events', symbol, '1h')],
        ['scan_playbooks', () => mt.runPlaybooksTool(symbol, '1h')],
        ['derivatives_state', () => mt.runDerivativesStateTool(symbol)],
        ['btc_relative(SOLUSDT)', () => mt.runBtcRelativeTool('SOLUSDT', 30)],
        ['key_levels(session frame)', () => mt.runKeyLevelsEnvelope(symbol)],
    ];

    console.log(`tool-smoke: ${calls.length} market tools end-to-end on ${symbol}`);
    let threw = 0;
    let unavailable = 0;
    for (const [name, fn] of calls) {
        const t0 = Date.now();
        try {
            const content = await fn();
            const line = summarize(name, content, Date.now() - t0);
            console.log(line);
            if (line.includes('⚠')) unavailable += 1;
        } catch (error) {
            threw += 1;
            console.log(`  ✗ ${name}: THREW past the adapter — ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    console.log(`tool-smoke: ${calls.length - threw - unavailable} ok, ${unavailable} honest-unavailable, ${threw} threw`);
    if (threw > 0) {
        console.error('TOOL SMOKE FAIL — a tool threw past its adapter; design rule 6 says it never should.');
        process.exit(1);
    }
};

main().catch((e) => {
    console.error(`tool-smoke could not start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
