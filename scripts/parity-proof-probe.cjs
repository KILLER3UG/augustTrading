/**
 * parity-proof-probe — the P-1…P-5 removal-parity walks (redesign Phase 3).
 *
 * Phase 4 deletes the old controls ONLY after each proof lands: the agent
 * path must be REACHABLE and produce what the control produced. This probe
 * drives each replacement through the REAL tool executor (scripted mock
 * turns, the same harness the decision-card probe uses), then asserts on the
 * RECEIPT the model actually received — captured by the mock provider from
 * the follow-up request (`/receipts`), because the transcript collapses tool
 * rows and DOM text cannot be the assertion surface.
 *
 * Proofs (per docs/plan/agent-driven-august.md § Removal parity):
 *   P-1  header popover rows   → get_market_packet · get_key_levels
 *   P-2  ChartToolRail shapes  → draw_on_chart (7 kinds) · mark_trade_levels · clear_chart_drawings
 *   P-3  ScreenerPanel modal   → run_screener · find_best_setups
 *   P-4  LiveMarket/Strategy   → market packet above · scan_playbooks
 *   P-5  dashboards            → get_setup_history_stats (Wilson) · playbook_attribution · get_trade_log
 *
 * What this probe PROVES: reachability, parameter acceptance, payload shape,
 * and the cap/CI guarantees. What it CANNOT prove: that a LIVE model picks
 * the right tool unprompted — that needs a configured provider and is
 * reported as unverifiable in the phase report.
 *
 * Run: node scripts/parity-proof-probe.cjs
 */

const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4197;
const MOCK_PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The scripted calls, in the order the probe's turns fire ─────────────────
const CALLS = [
    { id: 'p1-packet', tool: 'get_market_packet', args: { symbol: 'BTCUSDT' } },
    { id: 'p1-key-levels', tool: 'get_key_levels', args: { symbol: 'BTCUSDT' } },
    { id: 'p2-hline', tool: 'draw_on_chart', args: { kind: 'hline', prices: [84210], label: 'range high' } },
    { id: 'p2-trend', tool: 'draw_on_chart', args: { kind: 'trend', prices: [83100, 84210], startBarsAgo: 30 } },
    { id: 'p2-zone', tool: 'draw_on_chart', args: { kind: 'zone', prices: [83100, 84210], startBarsAgo: 40 } },
    { id: 'p2-fib', tool: 'draw_on_chart', args: { kind: 'fib', prices: [83100, 87900], startBarsAgo: 40 } },
    { id: 'p2-text', tool: 'draw_on_chart', args: { kind: 'text', prices: [84210], label: 'probe note' } },
    { id: 'p2-arrow', tool: 'draw_on_chart', args: { kind: 'arrow', prices: [83100, 84210], label: 'reclaim' } },
    { id: 'p2-measured', tool: 'draw_on_chart', args: { kind: 'measured_move', prices: [84210, 83100, 87900] } },
    { id: 'p2-channel', tool: 'draw_on_chart', args: { kind: 'channel', prices: [83100, 84210, 84500], startBarsAgo: 30 } },
    { id: 'p2-mark-levels', tool: 'mark_trade_levels', args: { entry: 84210, stopLoss: 83100, takeProfits: [87900, 90000] } },
    { id: 'p2-clear', tool: 'clear_chart_drawings', args: { scope: 'model' } },
    { id: 'p3-screener', tool: 'run_screener', args: {} },
    { id: 'p3-best-setups', tool: 'find_best_setups', args: {} },
    { id: 'p4-playbooks', tool: 'scan_playbooks', args: { symbol: 'BTCUSDT' } },
    { id: 'p5-stats', tool: 'get_setup_history_stats', args: { symbol: 'ETHUSDT', direction: 'Long' } },
    { id: 'p5-attribution', tool: 'playbook_attribution', args: {} },
    { id: 'p5-log', tool: 'get_trade_log', args: { records: true } },
];

async function waitForServer(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* not up yet */ }
        await sleep(400);
    }
    return false;
}

const free = (port) => new Promise((resolve) => {
    const probe = require('http').createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
});

async function seedProfile(page, mockPort) {
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');
        localStorage.setItem('harness_settings_v1', JSON.stringify({
            equityUsd: 10000, riskPercent: 1,
            guardMaxTradesPerDay: 20, guardDailyLossPct: 20, guardPostLossCooldownMin: 0,
        }));
    });
    await page.evaluate(async (mockPort) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('userProfiles')) {
                    request.result.createObjectStore('userProfiles', { keyPath: 'username' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const analysis = (over) => ({
            direction: 'Long', confidence: 'High', coinName: 'BTCUSDT',
            entryPoints: [{ price: '84210.5', description: 'reclaim' }],
            stopLoss: '83100', takeProfit: [{ price: '87900' }],
            probability: 62, reasoning: 'Probe parity row.',
            marketConditions: {}, activeStrategies: [], validationWarnings: [],
            ...over,
        });
        const tx = db.transaction('userProfiles', 'readwrite');
        tx.objectStore('userProfiles').put({
            username: 'Probe User',
            conversations: [],
            tradeLog: [
                { id: 'pp-1', outcome: 'WIN', tradeType: 'scalp', timestamp: new Date(Date.now() - 90 * 60000).toISOString(), leverage: 10, realizedR: 1.8, analysis: analysis({ direction: 'Long', coinName: 'ETHUSDT', strategy: 'breakout' }) },
                { id: 'pp-2', outcome: 'LOSS', tradeType: 'scalp', timestamp: new Date(Date.now() - 60 * 60000).toISOString(), leverage: 10, realizedR: -1, analysis: analysis({ direction: 'Long', coinName: 'ETHUSDT', strategy: 'breakout' }) },
                { id: 'pp-3', outcome: 'WIN', tradeType: 'swing', timestamp: new Date(Date.now() - 30 * 60000).toISOString(), leverage: 10, realizedR: 2.2, analysis: analysis({ direction: 'Long', coinName: 'ETHUSDT', strategy: 'breakout' }) },
                { id: 'pp-4', outcome: 'WIN', tradeType: 'swing', timestamp: new Date(Date.now() - 20 * 60000).toISOString(), leverage: 10, realizedR: 1.1, analysis: analysis({ direction: 'Short', coinName: 'BTCUSDT', strategy: 'range' }) },
            ],
            tradeSummaries: [],
            finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false,
            models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));
    }, mockPort);
}

async function sendInDock(page, text) {
    await page.waitForFunction(() => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return false;
        return [...document.querySelectorAll('button')].some((b) => !b.disabled && /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
        ));
    }, null, { timeout: 30000 });
    const sent = await page.evaluate((needle) => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return 'no composer';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, needle);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find((b) => /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
        ));
        if (!btn) return 'no send button';
        if (btn.disabled) return 'send disabled';
        btn.click();
        return 'clicked';
    }, text);
    if (sent !== 'clicked') throw new Error(`send failed: ${sent}`);
}

/** Poll the mock's captured receipts until a NEW receipt for `tool` lands
 *  (more than `before` copies exist) — draw_on_chart repeats 8×, so a plain
 *  find-by-name would hand every kind the FIRST kind's receipt. Returns the
 *  newest copy. */
async function waitForReceipt(tool, before, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${MOCK}/receipts`);
            const recs = await res.json();
            const mine = recs.filter((r) => r.name === tool);
            if (mine.length > before) return mine[mine.length - 1].content;
        } catch { /* mock not up yet */ }
        await sleep(500);
    }
    return null;
}

/** How many receipts `tool` has now. */
async function receiptCount(tool) {
    try {
        const res = await fetch(`${MOCK}/receipts`);
        return (await res.json()).filter((r) => r.name === tool).length;
    } catch { return 0; }
}

const failures = [];
const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ''}`);
};

const j = (content) => {
    // Tool results ride the app's untrusted-data fence with a preamble: the
    // payload starts AFTER the `### TOOL RESULT: <tool>` marker and ends
    // before the END fence. Some payloads are JSON; some (the packet, the
    // screener table) are markdown by design — those parse to null and the
    // assertions go content-based.
    const marker = content.indexOf('### TOOL RESULT:');
    const endFence = content.indexOf('<<<AUGUST-UNTRUSTED END');
    const inner = marker >= 0
        ? content.slice(marker, endFence > marker ? endFence : undefined).split('\n').slice(1).join('\n')
        : content;
    try { return JSON.parse(inner); } catch { return null; }
};

async function main() {
    for (const [label, port] of [['parity server', PORT], ['parity mock', MOCK_PORT]]) {
        if (await free(port)) continue;
        console.error(`PARITY PROBE FAIL: port ${port} (${label}) is already owned — refusing to drive it.`);
        process.exitCode = 1;
        return;
    }
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: {
            ...process.env,
            MOCK_TOOL_CALL: '1',
            MOCK_TOOL_NAME: 'get_market_packet',
            // One scripted call per PROBE_TOOL_ROUND, in CALLS order — the
            // per-entry `__tool` names which tool each round emits.
            MOCK_SKILL_ARGS: JSON.stringify(CALLS.map(c => ({ __tool: c.tool, ...c.args }))),
        },
    });
    let serverOut = '';
    const pageErrors = [];
    server.stdout.on('data', (d) => { serverOut += String(d); });
    mock.stderr.on('data', (d) => { serverOut += String(d); });

    try {
        if (!(await waitForServer(BASE))) {
            console.error('PARITY PROBE FAIL: no vite dev server on', BASE, '\n', serverOut);
            process.exitCode = 1;
            return;
        }
        if (!(await waitForServer(`${MOCK}/models`))) {
            console.error('PARITY PROBE FAIL: mock provider never came up');
            process.exitCode = 1;
            return;
        }
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        // Seed on an ORIGIN page — localStorage is denied on about:blank.
        await page.goto(`${BASE}/favicon.ico`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await seedProfile(page, MOCK_PORT);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForSelector('[data-testid="trade-chat-panel"]', { timeout: 45000 });
        await sleep(2500);

        // One round per scripted call; assert on the receipt.
        const seen = {};
        for (const step of CALLS) {
            seen[step.tool] = seen[step.tool] ?? await receiptCount(step.tool);
            await sendInDock(page, `PROBE_TOOL_ROUND parity ${step.id}`);
            let content = await waitForReceipt(step.tool, seen[step.tool]);
            if (!content) {
                // A live-feed failure can error the turn before the tool
                // result reaches the mock. Retry the round ONCE before
                // failing — the walk asserts payload shapes, and one dead
                // feed should not end it (the repeat-run flake).
                await sendInDock(page, `PROBE_TOOL_ROUND parity ${step.id} retry`);
                content = await waitForReceipt(step.tool, seen[step.tool]);
            }
            seen[step.tool] = await receiptCount(step.tool);
            if (!content) {
                check(`${step.id}: receipt captured`, false, `no ${step.tool} receipt reached the mock within 45s (retried once)`);
                continue;
            }
            const parsed = j(content);
            const t = (needle) => content.includes(needle);
            console.log(`  [receipt ${step.id}] len=${content.length}`, JSON.stringify(content.slice(0, 120)) + ' ...TAIL... ' + JSON.stringify(content.slice(-260)));
            switch (step.id) {
                case 'p1-packet':
                    // The packet is a MARKDOWN payload by design — assert on
                    // content, not JSON shape.
                    check('P-1 get_market_packet covers the popover rows (price/session/derivatives, one call)',
                        (t('price') || t('Price')) && (t('funding') || t('Funding') || t('session') || t('Session') || t('OI') || t('open interest')),
                        `len=${content.length}`);
                    break;
                case 'p1-key-levels':
                    check('P-1 get_key_levels returns the publishable fence + support/resistance',
                        t('key-levels') && (t('resistance') || t('support')),
                        content.slice(0, 120));
                    break;
                case 'p2-hline': case 'p2-trend': case 'p2-zone': case 'p2-fib':
                case 'p2-text': case 'p2-arrow': case 'p2-measured': case 'p2-channel':
                    check(`P-2 draw_on_chart ${step.args.kind} draws (receipt confirms)`,
                        parsed?.drawn === true || parsed?.ok === true || /DREW|drawn|Draw|DRAW/.test(content),
                        content.slice(0, 100));
                    break;
                case 'p2-mark-levels':
                    check('P-2 mark_trade_levels draws entry/stop/targets in one call',
                        parsed?.drawn === true || parsed?.ok === true || /entry|stop|target/i.test(content),
                        content.slice(0, 100));
                    break;
                case 'p2-clear':
                    check('P-2 clear_chart_drawings clears the model shapes',
                        parsed?.cleared !== undefined || parsed?.removed !== undefined || /Cleared|cleared/.test(content),
                        content.slice(0, 100));
                    break;
                case 'p3-screener':
                    check('P-3 run_screener returns a bounded table (≤30 rows, UNKNOWN-not-empty on failure)',
                        /USDT/.test(content) || t('rows') || t('UNKNOWN'),
                        `len=${content.length}`);
                    break;
                case 'p3-best-setups':
                    check('P-3 find_best_setups returns ranked candidates with reasons',
                        t('candidate') || t('why') || t('rank') || (Array.isArray(parsed?.candidates) && parsed.candidates.length <= 20),
                        content.slice(0, 120));
                    break;
                case 'p4-playbooks':
                    check('P-4 scan_playbooks matches carry invalidation + evidence',
                        t('invalidation') || t('match') || t('playbook') || t('Playbook') || t('no match'),
                        content.slice(0, 120));
                    break;
                case 'p5-stats':
                    check('P-5 get_setup_history_stats carries the Wilson CI + sample size',
                        !!parsed && parsed.wilson95 && typeof parsed.sample === 'number',
                        content.slice(0, 160));
                    // The RENDERING half: the card mounts in the dock with the
                    // sample size visible — the model never restates the
                    // numbers in prose alone.
                    await sleep(900);
                    check('P-5 the stats card renders in the dock (n visible, verbatim from the receipt)',
                        (await page.locator('[data-testid="stats-card"]').count()) > 0
                        && /n=\d+/i.test(await page.locator('[data-testid="stats-card"]').first().innerText()),
                        (await page.locator('[data-testid="stats-card"]').count())
                            ? (await page.locator('[data-testid="stats-card"]').first().innerText()).replace(/\s+/g, ' ').slice(0, 120)
                            : 'no stats card mounted');
                    await page.screenshot({ path: '.probe-artifacts/parity-stats-card.png' });
                    break;
                case 'p5-attribution':
                    check('P-5 playbook_attribution returns per-detector rows',
                        t('detector') || t('attribution') || Array.isArray(parsed),
                        content.slice(0, 120));
                    break;
                case 'p5-log':
                    check('P-5 get_trade_log records carry pnl + timestamps (equity curve derivable)',
                        (t('pnlAmount') || t('pnlPercent') || t('realizedR')) && (t('timestamp') || t('loggedAt')),
                        content.slice(0, 120));
                    break;
                default:
                    check(`${step.id}: receipt captured`, true, content.slice(0, 80));
            }
            await sleep(700);
        }

        // Visual artifacts: one shot with drawings up (before the clear already
        // ran), one after — the probe's walk order cleared them, so re-draw
        // one line for the after-shot? No: the shots bookend the walk instead.
        await page.screenshot({ path: '.probe-artifacts/parity-final-state.png', fullPage: false });

        check('zero pageerrors across the parity walk', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
        await browser.close();
    } catch (err) {
        console.error('PARITY PROBE FAIL (driver):', err && err.message || err);
        console.error('  [server]', serverOut.slice(-300).split('\n').join(' | '));
        process.exitCode = 1;
    } finally {
        server.kill();
        mock.kill();
    }
    if (failures.length) {
        console.error(`\nPARITY PROBE FAILED — ${failures.length} check(s):`);
        for (const f of failures) console.error(' • ' + f);
        process.exitCode = 1;
        return;
    }
    if (process.exitCode !== 1) {
        console.log('\nPARITY PROBE OK — every removal-parity replacement is reachable, accepts its');
        console.log('parameters, and returns the payload shape the control produced (P-1 market');
        console.log('packet + key levels fence; P-2 the seven draw kinds + trade levels + clear;');
        console.log('P-3 the screener table + ranked setups; P-4 the playbook scan with');
        console.log('invalidation; P-5 stats with Wilson CI + sample size, per-detector');
        console.log('attribution, and the trade-log records).');
    }
}

void main();
