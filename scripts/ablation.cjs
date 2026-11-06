#!/usr/bin/env node
/**
 * ablation — the paired, seeded, tool-group ablation the tools-upgrade task
 * pre-declared (docs/plans/tools-upgrade.md §8), built to be RUN by the
 * owner: it needs a provider key the repo deliberately does not ship.
 *
 * THE THREE PRE-DECLARED COMPARISONS (declared before any run — no sweep):
 *   baseline  vs  +volume/auction pack      (comparison 1)
 *   baseline  vs  +regime/levels/trade-math pack   (comparison 2)
 *   volume    vs  regime                    (comparison 3)
 * A CI straddling zero reads as "cannot tell yet — larger N", never as "no
 * effect". No other comparison is reported, and any future sweep owes a
 * holdout slice untouched until one configuration wins.
 *
 * DESIGN
 *   - Samples: a seeded, time-blocked grid of (symbol, decision-time)
 *     points over the lookback; nothing about the sample depends on the arm.
 *   - AS-OF: every candle comes from a ranged fetch with endTime = the
 *     decision time; the harness asserts no bar at/after the decision is
 *     present (the no-look-ahead integrity check, per sample).
 *   - The tool arms receive a PRECOMPUTED CONTEXT PACK — the same cores the
 *     desk tools run, printed as text into the prompt (design rule 7's pack
 *     path; also the train/inference-parity shape). No live tool loop: the
 *     arms differ only in the pack block, so a score diff is the pack's
 *     effect, not loop variance.
 *   - Labels: the model's own entry/stop/target go through the REAL
 *     resolver (`signalResolver.resolveSignal`) over the POST-decision tape
 *     — stop-first on an unknowable bar, costs in R. An abstain is recorded
 *     and scores nothing (a decision, not a failure).
 *   - Metrics per arm: n, abstain rate, hit rate, avg net R (costs charged),
 *     Brier (declared confidence→probability mapping), hallucinated-price
 *     rate (stated levels with no pack/source grounding), tokens per
 *     decision, and the per-regime breakdown (regime tagged from the as-of
 *     tape — the tag get_regime exists to provide).
 *   - Stats: paired bootstrap (10k resamples) over common samples for the
 *     mean net-R diff per comparison, 95% CI.
 *
 * USAGE
 *   Dry run (no provider, validates samples/packs/labels/integrity):
 *     node scripts/ablation.cjs --dry-run --samples 6
 *   Real run:
 *     AUGUST_EVAL_BASE_URL=https://api.x.com/v1 \
 *     AUGUST_EVAL_API_KEY=... AUGUST_EVAL_MODEL=... \
 *     node scripts/ablation.cjs --samples 40
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/** Bundle the app's real modules (cores + resolver + costs + fetchers). */
const loadModules = () => {
    const tmp = path.join(os.tmpdir(), `ablation-modules-${process.pid}.cjs`);
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    esbuild.buildSync({
        stdin: {
            contents: [
                `export * as rv from './src/services/signals/signalResolver';`,
                `export * as nrr from './src/utils/netRiskReward';`,
                `export * as md from './src/services/analysis/MarketDataService';`,
                `export * as regime from './src/services/market/regimeCore';`,
                `export * as profile from './src/services/market/volumeProfileCore';`,
                `export * as vwap from './src/services/market/vwapCore';`,
                `export * as flow from './src/services/market/orderFlowCore';`,
                `export * as effort from './src/services/market/effortResultCore';`,
                `export * as levels from './src/services/market/levelsCore';`,
                `export * as tm from './src/services/market/tradeMathCore';`,
                `export * as sc from './src/services/market/sessionConvention';`,
            ].join('\n'),
            resolveDir: ROOT,
            sourcefile: 'ablation-entry.ts',
            loader: 'ts',
        },
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

// ─── declared configuration (printed into every report) ─────────────────

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const DECISION_GRID_HOURS = 4;
const LOOKBACK_DAYS = 30;
const HORIZON_HOURS = 48;
const CONFIDENCE_TO_P = { 1: 0.25, 2: 0.5, 3: 0.7, 4: 0.85 };
const ARMS = {
    baseline: {
        label: 'baseline (48×1h OHLCV rows, no pack)',
        pack: null,
    },
    volume: {
        label: '+volume/auction pack',
        pack: 'volume',
    },
    regime: {
        label: '+regime/levels/trade-math pack',
        pack: 'regime',
    },
};
const PREDECLARED_COMPARISONS = [
    ['baseline', 'volume'],
    ['baseline', 'regime'],
    ['volume', 'regime'],
];

const HOUR = 3_600_000;

// ─── as-of tape + packs ─────────────────────────────────────────────────

const fmtPx = (v) => Number(v.toPrecision(6));

/** The as-of 1h tape for a decision: ends BEFORE the decision closes.
 *  100 bars — the regime read needs ≥80, and every arm sees the same tape. */
const asOfTape = async (md, symbol, decisionTime, bars = 100) => {
    const start = decisionTime - bars * HOUR - HOUR;
    const raw = await md.fetchFuturesOHLCVFromTime(symbol, '1h', start, decisionTime);
    // Closed-bars only, and the INTEGRITY RULE: no bar may close at or after
    // the decision time — a bar that straddles the decision would carry
    // post-decision price into the prompt.
    const closed = raw.filter(c => c.time + HOUR <= decisionTime);
    return closed;
};

/** The post-decision 5m tape the resolver labels against. */
const postTape = async (md, symbol, decisionTime, horizonHours) => {
    const raw = await md.fetchFuturesOHLCVFromTime(symbol, '5m', decisionTime, decisionTime + horizonHours * HOUR);
    return raw.filter(c => c.time + 5 * 60_000 <= decisionTime + horizonHours * HOUR);
};

/** The volume/auction pack, from the as-of tape only. */
const buildVolumePack = (m, tape, atr) => {
    const lines = [];
    const prof = m.profile.buildVolumeProfile(tape.slice(-48), { bins: 24 });
    if (prof) {
        const last = tape[tape.length - 1].close;
        lines.push(`volume_profile(48×1h): POC ${fmtPx(prof.poc)}, VA ${fmtPx(prof.valueAreaLow)}–${fmtPx(prof.valueAreaHigh)}, price ${m.profile.pricePositionVsValue(prof, last)} value; POC ${fmtPx(Math.abs(last - prof.poc) / atr)} ATR away; migration ${prof.developingPoc?.migration ?? 'n/a'}`);
    }
    const vw = m.vwap.computeVwap(tape.slice(-24));
    if (vw) {
        const last = tape[tape.length - 1].close;
        const pos = m.vwap.vwapPosition(vw, tape.slice(-24), last);
        lines.push(`vwap(24h): ${fmtPx(vw.vwap)}, price ${pos?.side ?? '?'} at ${fmtPx(Math.abs(last - vw.vwap) / atr)} ATR; participants ${pos?.verdict.replace(/_/g, ' ')} (estimate)`);
    }
    const series = m.flow.deltaSeries(tape.slice(-48));
    if (series) {
        const div = m.flow.cvdDivergence(tape, series, 20);
        const events = m.flow.flowEvents(tape, atr, 48);
        lines.push(`order_flow(48×1h): CVD ${Math.round(series.cvd)}, last-20 net delta ${Math.round(series.deltas.slice(-20).reduce((s, d) => s + d.delta, 0))}${div ? `, ${div} price/CVD divergence` : ''}${events?.events.length ? `, ${events.events.length} absorption/exhaustion event(s)` : ''} (delta is an ESTIMATE from taker volume)`);
    }
    const eff = m.effort.effortVsResult(tape, atr, { recentBars: 10 });
    if (eff) {
        const notable = eff.bars.filter(b => b.read !== 'routine').map(b => `${b.read}@${b.rvol}×`).join(', ');
        lines.push(`effort_vs_result: ${notable || 'all routine'}; vol/price corr ${eff.volumePriceCorrelation}${eff.divergence ? ` (${eff.divergence} divergence)` : ''}`);
    }
    return lines;
};

/** The regime/levels/trade-math pack, from the as-of tape only. */
const buildRegimePack = (m, tape, atr, symbol) => {
    const lines = [];
    const reg = m.regime.regimeRead(tape);
    if (reg) {
        lines.push(`regime(1h): ${reg.direction} (ADX ${reg.directionStrength}, efficiency ${reg.efficiency}, dwell ${reg.dwell} bars) · volatility ${reg.volatility}${reg.atrPercentile !== null ? ` (ATR p${reg.atrPercentile})` : ''} · regime_id ${reg.regimeId}`);
    }
    const last = tape[tape.length - 1].close;
    const dayStart = m.sc.utcDayStart(last ? tape[tape.length - 1].time : 0);
    const prevDay = tape.filter(c => c.time >= dayStart - 24 * HOUR && c.time < dayStart);
    if (prevDay.length >= 4) {
        const hi = Math.max(...prevDay.map(c => c.high));
        const lo = Math.min(...prevDay.map(c => c.low));
        lines.push(`levels: prev_utc_day high ${fmtPx(hi)} (${fmtPx(Math.abs(last - hi) / atr)} ATR), low ${fmtPx(lo)} (${fmtPx(Math.abs(last - lo) / atr)} ATR)`);
    }
    const fib = m.levels; // fib lives in swingStructureCore — via levels? kept minimal: round numbers
    const rounds = (r => r)(null);
    void fib; void rounds;
    lines.push(`trade_math(1R stop / 2R target bracket): entry ${fmtPx(last)}, stop ${fmtPx(last - atr)}, target ${fmtPx(last + 2 * atr)} — R:R 2.0 gross, cost ${'~'}${m.nrr.roundTripCostR({ stopDistancePct: (atr / last) * 100 }).costR}R net per side`);
    return lines;
};

// ─── the model call ─────────────────────────────────────────────────────

const callModel = async (cfg, messages) => {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: 0.2,
            max_tokens: 700,
        }),
    });
    if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const tokens = data?.usage?.total_tokens ?? 0;
    return { text, tokens };
};

const parseDecision = (text) => {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const d = JSON.parse(match[0]);
        const direction = ['long', 'short', 'abstain'].includes(String(d.direction)) ? String(d.direction) : null;
        if (!direction) return null;
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        return {
            direction,
            entry: num(d.entry),
            stop: num(d.stop),
            target: num(d.target),
            confidence: [1, 2, 3, 4].includes(Number(d.confidence)) ? Number(d.confidence) : null,
        };
    } catch {
        return null;
    }
};

const SYSTEM_PROMPT = [
    'You are a discretionary crypto perp trader making ONE decision on one symbol at a fixed point in time.',
    'Answer with a SINGLE JSON object and nothing else:',
    '{"direction":"long|short|abstain","entry":number,"stop":number,"target":number,"confidence":1-4}',
    'entry/stop/target are absolute prices; confidence expresses your probability that the trade reaches its target before its stop (1=low .. 4=high).',
    'Abstain when the tape gives you nothing — abstaining is a decision, not a failure. Never invent a number the tape or the notes did not give you.',
].join('\n');

const userPrompt = (symbol, decisionIso, tape, packLines) => {
    const rows = tape.slice(-48).map(c =>
        `${new Date(c.time).toISOString().slice(5, 16)} O${fmtPx(c.open)} H${fmtPx(c.high)} L${fmtPx(c.low)} C${fmtPx(c.close)} V${Math.round(c.volume)}`).join('\n');
    return [
        `Symbol ${symbol}. Decision time ${decisionIso}. The rows below are CLOSED 1h bars ending BEFORE the decision time — nothing after it exists for you.`,
        '',
        rows,
        '',
        ...(packLines && packLines.length ? ['COMPUTED MARKET NOTES (as-of the decision time, from closed bars — quote these numbers, do not restate others):', ...packLines, ''] : []),
        'Give your one JSON decision now.',
    ].join('\n');
};

// ─── main ───────────────────────────────────────────────────────────────

const main = async () => {
    const args = process.argv.slice(2);
    const flag = (name, dflt) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? Number(args[i + 1]) : dflt;
    };
    const dryRun = args.includes('--dry-run');
    const perArm = Math.max(2, flag('samples', 40));
    const seed = Number(args[args.indexOf('--seed') + 1]) || 20261107;
    const armsArg = args.find(a => a.startsWith('--arms'));
    const armNames = armsArg ? armsArg.split('=')[1].split(',') : ['baseline', 'volume', 'regime'];
    for (const a of armNames) if (!ARMS[a]) { console.error(`unknown arm "${a}"`); process.exit(1); }

    const cfg = {
        baseUrl: process.env.AUGUST_EVAL_BASE_URL,
        apiKey: process.env.AUGUST_EVAL_API_KEY,
        model: process.env.AUGUST_EVAL_MODEL,
    };
    if (!dryRun && (!cfg.baseUrl || !cfg.apiKey || !cfg.model)) {
        console.error('ablation: a real run needs AUGUST_EVAL_BASE_URL, AUGUST_EVAL_API_KEY and AUGUST_EVAL_MODEL (or use --dry-run).');
        process.exit(1);
    }

    const m = loadModules();
    const rng = mulberry32(seed);

    // ── sample grid: time-blocked, seeded, arm-agnostic ────────────────
    const now = Date.now();
    const gridStart = now - LOOKBACK_DAYS * 24 * HOUR;
    const horizonEnd = now - HORIZON_HOURS * HOUR; // a sample needs its horizon resolved
    const slots = [];
    for (let t = gridStart; t <= horizonEnd; t += DECISION_GRID_HOURS * HOUR) slots.push(t);
    for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const samples = [];
    outer: for (const sym of SYMBOLS) {
        for (const t of slots) {
            if (samples.length >= perArm) break outer;
            samples.push({ symbol: sym, decisionTime: t });
        }
    }
    console.log(`ablation: ${samples.length} samples per arm × ${armNames.length} arms (${armNames.join(', ')}), seed ${seed}, horizon ${HORIZON_HOURS}h`);
    console.log(`  comparisons (PRE-DECLARED): ${PREDECLARED_COMPARISONS.map(([a, b]) => `${a} vs ${b}`).join('; ')} — no sweep, no post-hoc pairs`);

    // ── per-sample data: as-of tape, label machinery, packs ────────────
    const results = {}; // arm -> array of per-sample outcomes
    for (const a of armNames) results[a] = [];
    let integrityFailures = 0;

    for (let si = 0; si < samples.length; si++) {
        const s = samples[si];
        const decisionIso = new Date(s.decisionTime).toISOString();
        let tape;
        try {
            tape = await asOfTape(m.md, s.symbol, s.decisionTime);
        } catch (e) {
            console.log(`  ⚠ sample ${si} ${s.symbol}: tape fetch failed (${e.message}) — skipped`);
            continue;
        }
        if (tape.length < 30) { console.log(`  ⚠ sample ${si} ${s.symbol}: thin tape (${tape.length}) — skipped`); continue; }

        // INTEGRITY: no closed bar at/after the decision.
        if (tape.some(c => c.time + HOUR > s.decisionTime)) {
            integrityFailures += 1;
            console.log(`  ⚠ sample ${si}: LOOK-AHEAD detected in the as-of tape — skipped and counted`);
            continue;
        }
        const closes = tape.map(c => c.close);
        const atrSeries = m.regime.atrSeries(tape, 14);
        const atr = atrSeries.length ? atrSeries[atrSeries.length - 1] : 0;
        if (!(atr > 0)) { console.log(`  ⚠ sample ${si}: ATR not measurable — skipped`); continue; }

        // The regime tag (the per-regime breakdown depends on it).
        const reg = m.regime.regimeRead(tape);
        const regimeId = reg ? `${reg.direction}:${reg.volatility}` : 'unknown';

        // The arm packs (computed once per sample — arm-agnostic inputs).
        const packs = {};
        if (armNames.includes('volume')) packs.volume = buildVolumePack(m, tape, atr);
        if (armNames.includes('regime')) packs.regime = buildRegimePack(m, tape, atr, s.symbol);

        // Post tape for labels (fetched once per sample).
        let post;
        try {
            post = await postTape(m.md, s.symbol, s.decisionTime, HORIZON_HOURS);
        } catch (e) {
            console.log(`  ⚠ sample ${si}: post tape failed (${e.message}) — skipped`);
            continue;
        }

        for (const arm of armNames) {
            const packLines = ARMS[arm].pack ? packs[ARMS[arm].pack] : null;
            let decision = null;
            let tokens = 0;
            if (dryRun) {
                // Dry run: a deterministic stand-in decision so the scoring
                // path is exercised end to end without a provider.
                const last = tape[tape.length - 1].close;
                const up = closes[closes.length - 1] > closes[closes.length - 13];
                decision = { direction: up ? 'long' : 'short', entry: last, stop: up ? last - atr : last + atr, target: up ? last + 2 * atr : last - 2 * atr, confidence: 3 };
                tokens = 0;
            } else {
                try {
                    const r = await callModel(cfg, [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userPrompt(s.symbol, decisionIso, tape, packLines) },
                    ]);
                    tokens = r.tokens;
                    decision = parseDecision(r.text);
                } catch (e) {
                    console.log(`  ⚠ sample ${si} ${arm}: model call failed (${e.message})`);
                }
            }
            if (!decision) {
                results[arm].push({ sample: si, symbol: s.symbol, regimeId, outcome: 'unparseable', netR: null, brier: null, hallucination: null, tokens });
                continue;
            }
            if (decision.direction === 'abstain') {
                results[arm].push({ sample: si, symbol: s.symbol, regimeId, outcome: 'abstain', netR: null, brier: null, hallucination: 0, tokens });
                continue;
            }

            // Grounding: a stated level counts as grounded when it sits
            // within 0.15×ATR of (a) a pack-printed number, or (b) a price
            // the tape itself printed (rows are visible to every arm).
            const tapePrices = [];
            for (const c of tape.slice(-48)) tapePrices.push(c.open, c.high, c.low, c.close);
            const packPrices = [];
            for (const line of packLines ?? []) {
                const nums = line.match(/-?\d+(\.\d+)?/g) ?? [];
                for (const n of nums) { const v = Number(n); if (v > 0) packPrices.push(v); }
            }
            const grounded = (p) => (packPrices.some(v => Math.abs(v - p) <= 0.15 * atr) || tapePrices.some(v => Math.abs(v - p) <= 0.15 * atr)) ? 1 : 0;
            const stated = [decision.entry, decision.stop, decision.target].filter(v => v !== null);
            const hallucination = stated.length ? 1 - stated.reduce((sum, p) => sum + grounded(p), 0) / stated.length : null;

            // Label: the model's own bracket through the REAL resolver.
            const isLong = decision.direction === 'long';
            const entry = decision.entry ?? tape[tape.length - 1].close;
            const stop = decision.stop ?? (isLong ? entry - atr : entry + atr);
            const target = decision.target ?? (isLong ? entry + 2 * atr : entry - 2 * atr);
            const bracket = { direction: isLong ? 'long' : 'short', entry, stop, target, emittedAt: s.decisionTime, expiresAt: s.decisionTime + HORIZON_HOURS * HOUR };
            const resolution = m.rv.resolveSignal(bracket, post, [], s.decisionTime + HORIZON_HOURS * HOUR);
            let netR = null;
            let won = null;
            if (resolution) {
                const cost = m.nrr.roundTripCostR({ stopDistancePct: (Math.abs(entry - stop) / entry) * 100 });
                netR = cost.known ? Math.round(((resolution.grossR ?? 0) - cost.costR) * 10000) / 10000 : resolution.grossR;
                if (resolution.status === 'won') won = 1;
                else if (resolution.status === 'lost') won = 0;
                else if (resolution.status === 'expired') won = netR > 0 ? 1 : 0;
                // never_triggered: nothing scores (the call never came alive)
            }
            const brier = won !== null && decision.confidence ? (CONFIDENCE_TO_P[decision.confidence] - won) ** 2 : null;
            results[arm].push({
                sample: si, symbol: s.symbol, regimeId,
                outcome: resolution?.status ?? 'open', netR, brier, hallucination, tokens,
            });
        }
        if ((si + 1) % 5 === 0) console.log(`  … ${si + 1}/${samples.length} samples done`);
    }

    // ── report ──────────────────────────────────────────────────────────
    const stat = (arm) => {
        const rows = results[arm];
        const scored = rows.filter(r => typeof r.netR === 'number');
        const resolved = rows.filter(r => r.outcome === 'won' || r.outcome === 'lost');
        const wins = rows.filter(r => r.outcome === 'won').length;
        const abstains = rows.filter(r => r.outcome === 'abstain').length;
        const briers = rows.filter(r => r.brier !== null).map(r => r.brier);
        const hals = rows.filter(r => r.hallucination !== null).map(r => r.hallucination);
        const tokens = rows.filter(r => r.tokens > 0).map(r => r.tokens);
        const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
        return {
            n: rows.length, scored: scored.length, abstainRate: rows.length ? abstains / rows.length : null,
            hitRate: resolved.length ? wins / resolved.length : null, resolved: resolved.length,
            avgNetR: mean(scored.map(r => r.netR)),
            brier: mean(briers), brierN: briers.length,
            hallucinationRate: mean(hals),
            avgTokens: mean(tokens),
            perRegime: Object.entries(rows.reduce((acc, r) => {
                (acc[r.regimeId] = acc[r.regimeId] || []).push(r);
                return acc;
            }, {})).map(([rid, rs]) => {
                const sc = rs.filter(r => typeof r.netR === 'number');
                return { regime: rid, n: rs.length, avgNetR: mean(sc.map(r => r.netR)) };
            }),
        };
    };

    console.log('\n── per-arm results ──');
    const stats = {};
    for (const arm of armNames) {
        stats[arm] = stat(arm);
        const s = stats[arm];
        console.log(`${arm}: n=${s.n} scored=${s.scored} abstain=${s.abstainRate === null ? '—' : (s.abstainRate * 100).toFixed(0) + '%'}`
            + ` hitRate=${s.hitRate === null ? '—' : (s.hitRate * 100).toFixed(0) + '%'} (of ${s.resolved})`
            + ` avgNetR=${s.avgNetR === null ? '—' : s.avgNetR.toFixed(3)}`
            + ` Brier=${s.brier === null ? '—' : s.brier.toFixed(3)} (n=${s.brierN})`
            + ` halluc=${s.hallucinationRate === null ? '—(no pack reference)' : (s.hallucinationRate * 100).toFixed(0) + '%'}`
            + ` tokens/decision=${s.avgTokens === null ? '—' : Math.round(s.avgTokens)}`);
        for (const pr of s.perRegime) {
            console.log(`    ${pr.regime}: n=${pr.n} avgNetR=${pr.avgNetR === null ? '—' : pr.avgNetR.toFixed(3)}`);
        }
    }

    // Paired bootstrap over common samples.
    const bootstrapCI = (armA, armB) => {
        const byIdxA = new Map(results[armA].filter(r => typeof r.netR === 'number').map(r => [r.sample, r.netR]));
        const byIdxB = new Map(results[armB].filter(r => typeof r.netR === 'number').map(r => [r.sample, r.netR]));
        const common = [...byIdxA.keys()].filter(k => byIdxB.has(k));
        if (common.length < 5) return { common: common.length, ci: null };
        const diffs = common.map(k => byIdxA.get(k) - byIdxB.get(k));
        const brng = mulberry32(seed + 1);
        const means = [];
        for (let b = 0; b < 10_000; b++) {
            let acc = 0;
            for (let i = 0; i < diffs.length; i++) acc += diffs[Math.floor(brng() * diffs.length)];
            means.push(acc / diffs.length);
        }
        means.sort((x, y) => x - y);
        return { common: common.length, mean: diffs.reduce((s, d) => s + d, 0) / diffs.length, ci: [means[250], means[9750]] };
    };

    console.log('\n── the three pre-declared comparisons (paired bootstrap, 10k) ──');
    for (const [a, b] of PREDECLARED_COMPARISONS) {
        if (!armNames.includes(a) || !armNames.includes(b)) continue;
        const r = bootstrapCI(a, b);
        if (!r.ci) { console.log(`${a} vs ${b}: only ${r.common} common scored samples — cannot tell yet, larger N`); continue; }
        const straddle = r.ci[0] <= 0 && r.ci[1] >= 0;
        console.log(`${a} vs ${b}: mean ΔnetR ${(r.mean).toFixed(3)} R, 95% CI [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] over ${r.common} paired samples`
            + ` → ${straddle ? 'CANNOT TELL YET (CI straddles zero — larger N), not "no effect"' : (r.mean > 0 ? `${a} helps` : `${b} helps`)}`);
    }

    console.log(`\nintegrity: ${integrityFailures} look-ahead detections (must be 0)`);
    console.log('multiple-testing control: exactly the three comparisons declared in docs/plans/tools-upgrade.md §8 were computed.');

    const artifact = { seed, perArm, arms: armNames, samples: samples.length, integrityFailures, results: Object.fromEntries(armNames.map(a => [a, results[a]])) };
    const dir = path.join(ROOT, '.probe-artifacts');
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `ablation-${Date.now()}.json`), JSON.stringify(artifact, null, 1)); } catch { /* best effort */ }
    if (dryRun) console.log('\nDRY RUN COMPLETE — the harness, packs and labels work; a real run needs the AUGUST_EVAL_* env.');
};

main().catch((e) => {
    console.error(`ablation failed: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
});
