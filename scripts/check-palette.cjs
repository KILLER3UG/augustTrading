#!/usr/bin/env node
/**
 * check-palette — the monochrome doctrine, locked against drift.
 *
 * WHY THIS EXISTS. The 2026-11-19 sweep removed every decorative hue from the
 * chrome (amber/cyan/pink/violet/teal/yellow/sky/orange utilities → their zinc
 * step), but the sweep was a one-time manual edit: nothing stopped a hue from
 * creeping back in the next component. The doctrine is strict — green/red are
 * reserved for candles, price/PnL and Long/Short/Approve/Reject/WIN-LOSS
 * semantics; everything else reads in ink. This gate scans the component tree
 * for forbidden Tailwind hue utilities and fails on any hit, so the sweep stays
 * swept. It is a ratchet locked at ZERO: the baseline is 0 and only goes down.
 *
 * WHAT IT SCANS. `src/components/**\/*.tsx` and `src/App.tsx` — the rendered
 * chrome. A hue utility is a forbidden hue name followed by a scale step
 * (`amber-300`, `cyan-500/10`, `accent-pink-400`). Semantic `emerald-*`/`rose-*`
 * and the neutral `zinc-*` ramp are NOT forbidden. The legacy `--color-cyan-*`
 * CSS tokens in `src/index.css` are out of scope: this gate reads component
 * utilities, not the theme's variable definitions.
 *
 * REACH CONTROL. A scanner that silently stops matching reports `0 violations`
 * forever. Before scanning the tree, the same matcher runs over an inline
 * fixture carrying one of each forbidden hue plus a semantic and a neutral
 * control, and must flag exactly the forbidden set — and the file count must
 * clear a floor — or the gate fails as broken rather than green.
 *
 * Usage: node scripts/check-palette.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The decorative hues the doctrine bans from the chrome. Semantic green/red
 *  (emerald/rose) and the neutral zinc ramp are deliberately absent. */
const FORBIDDEN_HUES = ['amber', 'cyan', 'pink', 'fuchsia', 'violet', 'purple', 'sky', 'teal', 'yellow', 'orange'];

/** A hue utility: a forbidden hue name + a scale step, as a whole token. The
 *  leading boundary keeps `amber-300` out of a longer word; the step keeps a
 *  bare prose mention of "amber" from tripping the gate. */
const HUE_TOKEN = new RegExp(`\\b(?:${FORBIDDEN_HUES.join('|')})-\\d{2,3}\\b`, 'g');

const SCAN_ROOTS = ['src/components'];
const SCAN_FILES = ['src/App.tsx'];
const TSX = /\.tsx$/;

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(abs));
        else if (TSX.test(entry.name)) out.push(abs);
    }
    return out;
};

/** Every forbidden hue token in a source text, with its 1-based line. */
const findHues = (text) => {
    const hits = [];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        HUE_TOKEN.lastIndex = 0;
        let m;
        while ((m = HUE_TOKEN.exec(line)) !== null) hits.push({ line: i + 1, token: m[0] });
    });
    return hits;
};

/** Prove the matcher still sees a forbidden hue and still ignores the controls. */
const reachControl = () => {
    const fixture = [
        'text-amber-300 bg-cyan-500/10 border-pink-400',
        'accent-fuchsia-400 from-violet-500 to-purple-400',
        'text-sky-300 fill-teal-300 stroke-yellow-400 ring-orange-400',
        'text-emerald-400 text-rose-400 bg-zinc-800 text-zinc-100', // controls: must NOT flag
        'the amber warning and the cyan info hue', // prose, no step: must NOT flag
    ].join('\n');
    const hits = findHues(fixture);
    const flagged = hits.map(h => h.token).sort();
    const expected = [
        'amber-300', 'cyan-500', 'pink-400', 'fuchsia-400', 'violet-500',
        'purple-400', 'sky-300', 'teal-300', 'yellow-400', 'orange-400',
    ].sort();
    const ok = flagged.length === expected.length && flagged.every((t, i) => t === expected[i]);
    return { ok, detail: `${flagged.length}/${expected.length} hues`, flagged };
};

const main = () => {
    const reach = reachControl();
    if (!reach.ok) {
        console.error(`check-palette: REACH CONTROL FAILED — matcher flagged ${reach.detail} (${reach.flagged.join(', ')})`);
        console.error('The gate is broken, not the tree. Fix findHues before trusting a green run.');
        process.exit(1);
    }

    const files = [
        ...SCAN_ROOTS.flatMap(root => {
            const abs = path.join(ROOT, root);
            return fs.existsSync(abs) ? walk(abs) : [];
        }),
        ...SCAN_FILES.map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f)),
    ];
    const FLOOR = 100;
    if (files.length < FLOOR) {
        console.error(`check-palette: only ${files.length} component files found (floor ${FLOOR}).`);
        console.error('A scan with a collapsed population reports 0 violations by construction.');
        process.exit(1);
    }

    const violations = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const hit of findHues(text)) violations.push({ file: rel(file), ...hit });
    }

    console.log(`check-palette: reach control ${reach.detail}; ${files.length} component files scanned.`);
    if (violations.length > 0) {
        for (const v of violations) console.error(`  ${v.file}:${v.line} forbidden hue utility ${v.token}`);
        console.error(`\ncheck-palette: ${violations.length} violation(s) — the chrome must read in ink (semantic emerald/rose excepted).`);
        process.exit(1);
    }
    console.log('check-palette: OK — zero forbidden hues in the chrome (baseline locked at 0).');
};

main();