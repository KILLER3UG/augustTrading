#!/usr/bin/env node
/**
 * label-sanity — the label check the tools-upgrade task asks for, run over
 * the app's REAL resolver.
 *
 * The signal ledger's label is a triple-barrier scheme by construction:
 * `resolveSignal` walks closed bars after emission, triggers on the entry
 * touch, settles stop-first on an unknowable bar (with a 1m drill when the
 * caller can supply one), and expires to a mark at the horizon. This
 * instrument quantifies WHY that matters: it replays seeded synthetic tapes
 * through the resolver and, in parallel, labels the same tape the naive way
 * — reading ONLY where price ended at expiry — and counts the disagreements.
 *
 * Deterministic: mulberry32 with a fixed seed, no network, no fs. A dev
 * instrument, not a gate (gates.md); run `node scripts/label-sanity.cjs`.
 *
 * Usage: node scripts/label-sanity.cjs [trials=2000] [seed=20261107]
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/** Bundle the pure resolver (and only it) to CJS with esbuild, like
 *  check-contracts does — no vitest, no network, no DOM. */
const loadResolver = () => {
    const tmp = path.join(os.tmpdir(), `label-sanity-resolver-${process.pid}.cjs`);
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    esbuild.buildSync({
        stdin: { contents: `export * from './src/services/signals/signalResolver';`, resolveDir: ROOT, sourcefile: 'label-sanity-entry.ts', loader: 'ts' },
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

const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const BAR_MS = 5 * 60_000;

/** One synthetic 5m tape. The first bar OPENS at `entry` (the trigger), so
 *  every trial fills; drift regimes alternate so wins and losses both occur;
 *  ~3% of bars gap their open and ~5% are wide (both-touch candidates). */
const makeTape = (rng, entry, direction, bars = 120) => {
    const sign = direction === 'long' ? 1 : -1;
    const out = [];
    let price = entry;
    let drift = 0;
    for (let i = 0; i < bars; i++) {
        if (i % 24 === 0) drift = (rng() - 0.5) * 0.08;
        const shock = (rng() - 0.5) * 0.5;
        const wide = rng() < 0.05 ? 2.2 : 1;
        // The gap is mirrored by direction like every other component — an
        // unmirrored jump field hands one side adverse gaps and the other
        // favorable ones (the asymmetry that made every early Long trial a
        // stop-out on this instrument's first run).
        const gap = rng() < 0.03 ? (rng() - 0.5) * 3 : 0;
        const open = i === 0 ? entry : price + sign * gap;
        const move = (drift + shock) * wide;
        const close = open + sign * move;
        const spread = Math.abs(rng() - 0.5) * 0.5 * wide + 0.05;
        const high = Math.max(open, close) + spread * rng();
        const low = Math.min(open, close) - spread * rng();
        out.push({ time: i * BAR_MS, open, high, low, close });
        price = close;
    }
    return out;
};

const endpointLabel = (tape, entry, stop, target, direction, expiresAt) => {
    // The naive labeler reads ONE point: the last bar that closed by expiry.
    const bars = tape.filter(c => c.time + BAR_MS <= expiresAt);
    const last = bars[bars.length - 1];
    if (!last) return 'no_data';
    if (direction === 'long') {
        if (last.close >= target) return 'won';
        if (last.close <= stop) return 'lost';
    } else {
        if (last.close <= target) return 'won';
        if (last.close >= stop) return 'lost';
    }
    return 'expired';
};

const main = () => {
    const trials = Math.max(1, Number(process.argv[2]) || 2000);
    const seed = Number(process.argv[3]) || 20261107;
    const rv = loadResolver();
    const rng = mulberry32(seed);

    const tally = { agreed: 0, disagreed: 0, classes: {}, examples: [] };
    let resolved = 0;

    for (let t = 0; t < trials; t++) {
        const direction = t % 2 === 0 ? 'long' : 'short';
        const entry = 100;
        // 3 units of risk ≈ 3× a typical bar range: tight enough that stops
        // and targets both resolve inside the horizon, loose enough that the
        // outcome mix is not a stop-out monochrome.
        const risk = 3;
        const reward = 6; // 2R target
        const stop = direction === 'long' ? entry - risk : entry + risk;
        const target = direction === 'long' ? entry + reward : entry - reward;
        const emittedAt = 0;
        const horizonBars = 90;
        const expiresAt = horizonBars * BAR_MS;

        const tape = makeTape(rng, entry, direction);
        const resolution = rv.resolveSignal(
            { direction, entry, stop, target, emittedAt, expiresAt },
            tape, [], expiresAt + BAR_MS,
        );
        if (!resolution) continue;
        resolved += 1;
        const realized = resolution.status === 'won' ? 'won'
            : resolution.status === 'lost' ? 'lost'
                : resolution.status; // expired | never_triggered
        const naive = endpointLabel(tape, entry, stop, target, direction, expiresAt);

        if (realized === naive) {
            tally.agreed += 1;
        } else {
            tally.disagreed += 1;
            const cls = `path=${realized} · endpoint=${naive}`;
            tally.classes[cls] = (tally.classes[cls] || 0) + 1;
            if (tally.examples.length < 5) {
                tally.examples.push({ trial: t, direction, path: resolution.status, ambiguous: resolution.ambiguous, gapAdjusted: resolution.gapAdjusted ?? false, endpoint: naive, grossR: resolution.grossR });
            }
        }
    }

    const disagreeRate = resolved ? ((tally.disagreed / resolved) * 100).toFixed(1) : '0.0';
    console.log(`label-sanity: ${resolved} resolved signals (seed ${seed}, ${trials} trials, 2R:1R brackets, 5m synthetic tape)`);
    console.log(`  agreed (path-aware === endpoint-only): ${tally.agreed}`);
    console.log(`  DISAGREED (an endpoint-only labeler would have mislabeled): ${tally.disagreed} (${disagreeRate}%)`);
    for (const [cls, n] of Object.entries(tally.classes).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cls}: ${n}`);
    }
    for (const ex of tally.examples) {
        console.log(`    e.g. trial ${ex.trial} ${ex.direction}: path=${ex.path}${ex.ambiguous ? ' (ambiguous→stop-first)' : ''}${ex.gapAdjusted ? ' (gap fill)' : ''}, endpoint=${ex.endpoint}, grossR=${ex.grossR}`);
    }
    console.log('  verdict: the ledger label is path-aware (stop/target/time, stop-first on unknowable bars);');
    console.log('  an endpoint-only labeler would have graded the same decisions differently on every DISAGREED row above.');
    if (resolved === 0) {
        console.error('label-sanity: no signal resolved — the fixture is broken, not the label.');
        process.exit(1);
    }
};

main();
