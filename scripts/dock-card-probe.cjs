/**
 * dock-card-probe — drive the CHART AI dock's decision cards end to end.
 *
 * WHY THIS EXISTS. The settlement-correction and trade-action cards landed on
 * the CHAT surface first; the dock's sink (chatTurnRunner → chatStore entry →
 * ChatTranscriptList) is the Phase 2 open item, and Phase 4 stays blocked until
 * the correction card is verified on EVERY surface it can be proposed from.
 * This probe proposes a correction FROM THE DOCK through the real tool turn
 * (mock provider scripted to call correct_trade_outcome), then proves the
 * authority contract in a real browser:
 *
 *   1. the card renders in the dock transcript;
 *   2. the journal row is UNCHANGED while the card is open;
 *   3. one tap on Confirm writes the row through the journal's own gated path
 *      (outcome updated, correctedFrom/correctedAt/resolutionSource stamped);
 *   4. the card resolves after the confirm;
 *   5. a second proposal, DISMISSED, leaves its row untouched.
 *
 *   node scripts/dock-card-probe.cjs     # self-hosts vite on 4185 + mock on 8789
 *
 * Exits non-zero on any failure. This is the P-6 dock-side evidence, not a
 * release gate; render-probe remains the release gate.
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4185;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORRECTION_1 = {
    tradeId: 'pt-2',
    outcome: 'WIN',
    pnlAmount: 125.5,
    reason: 'The tape shows price never traded through the stop; the row was mis-settled as a loss.',
};
const CORRECTION_2 = {
    tradeId: 'pt-3',
    outcome: 'LOSS',
    reason: 'The target was never reached before the reversal; this was not a win.',
};

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

/** Seed the profile the way render-probe does, plus the two journal rows the
 *  corrections act on. The app must be UNMOUNTED while this writes (the
 *  mount-armed save flush would overwrite an external write — see
 *  render-probe's seedVerdicts note), so this runs from favicon.ico. */
async function seed(page) {
    await page.goto(`${BASE}/favicon.ico`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');
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
            probability: 62, reasoning: 'Holding above the 200-EMA into thin sell-side.',
            marketConditions: {}, activeStrategies: [], validationWarnings: [],
            ...over,
        });
        const tradeRow = (id, minsAgo, outcome, tradeType, direction, coin) => ({
            id,
            outcome,
            tradeType,
            timestamp: new Date(Date.now() - minsAgo * 60000).toISOString(),
            leverage: 10,
            analysis: analysis({ direction, coinName: coin }),
        });
        const tx = db.transaction('userProfiles', 'readwrite');
        tx.objectStore('userProfiles').put({
            username: 'Probe User',
            conversations: [],
            tradeLog: [
                tradeRow('pt-2', 280, 'LOSS', 'scalp', 'Short', 'BTCUSDT'),
                tradeRow('pt-3', 260, 'WIN', 'swing', 'Long', 'ETHUSDT'),
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
    }, MOCK_PORT);
}

/** Read one journal row back out of the profile store — the RECORD the
 *  journal's own writers persist, not a component's state. */
async function readTradeRow(page, tradeId) {
    return page.evaluate(async (id) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const row = await new Promise((resolve) => {
            const get = db.transaction('userProfiles', 'readonly')
                .objectStore('userProfiles').get('Probe User');
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => resolve(null);
        });
        db.close();
        return ((row && row.tradeLog) || []).find((t) => t.id === id) || null;
    }, tradeId);
}

/** Send one dock message the way a person does (native value setter + Send). */
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

const failures = [];
const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` (${detail})` : ''}`);
};

async function main() {
    const free = (port) => new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port, '127.0.0.1');
    });
    for (const [label, port] of [['dev server', PORT], ['mock provider', MOCK_PORT]]) {
        if (await free(port)) continue;
        console.error(`DOCK CARD PROBE FAIL: port ${port} (${label}) is already owned — refusing to drive it.`);
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
            MOCK_TOOL_NAME: 'correct_trade_outcome',
            // A SEQUENCE: the first scripted call proposes the pt-2 correction
            // (the trader confirms it), the second proposes the pt-3 correction
            // (the trader dismisses it).
            MOCK_SKILL_ARGS: JSON.stringify([CORRECTION_1, CORRECTION_2]),
        },
    });
    let serverOut = '';
    server.stdout.on('data', (d) => { serverOut += String(d); });
    server.stderr.on('data', (d) => { serverOut += String(d); });

    try {
        if (!(await waitForServer(BASE))) {
            console.error('DOCK CARD PROBE FAIL: no vite dev server on', BASE, '\n', serverOut);
            process.exitCode = 1;
            return;
        }
        if (!(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
            console.error('DOCK CARD PROBE FAIL: mock provider never came up');
            process.exitCode = 1;
            return;
        }
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));

        await seed(page);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        const ws = page.locator('input[placeholder="Create New Workspace"]');
        if (await ws.count()) {
            await ws.first().fill('Probe User');
            await page.locator('button').filter({ hasText: /^Enter$/ }).first().click();
            await sleep(1500);
        }
        await page.waitForSelector('[data-testid="trade-view"]', { timeout: 25000 });
        const aiTab = page.locator('[role="tab"]', { hasText: /^AI$/ }).first();
        if (await aiTab.count()) await aiTab.click();
        await sleep(500);

        // ── Turn 1: propose the pt-2 correction from the dock ────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND correct the settled outcome of pt-2');
        await page.waitForSelector('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]',
            { timeout: 45000 });
        check('a correction proposed from the dock renders its card in the dock', true);
        const cardText = await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]')
            .first().innerText();
        check('the card names the change it proposes',
            /LOSS\s*→\s*WIN/i.test(cardText) && /mis-settled/i.test(cardText),
            cardText.replace(/\s+/g, ' ').slice(0, 160));

        // Nothing changes without confirmation: the row is still a LOSS while
        // the card is open.
        const beforeConfirm = await readTradeRow(page, 'pt-2');
        check('the journal row is untouched while the card is open',
            !!beforeConfirm && beforeConfirm.outcome === 'LOSS',
            beforeConfirm ? `outcome=${beforeConfirm.outcome}` : 'row missing');

        // One tap confirms. The write goes through the journal's own hook, so
        // poll for the SETTLED record: the debounced DATA save (~1.5s) carries
        // the outcome AND the audit trail the hook stamps (correctedFrom = the
        // previous outcome, correctedAt, resolutionSource 'correction').
        await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-confirm"]')
            .first().click();
        const audit = await page.waitForFunction(async (id) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('FuturesAI-DB', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const row = await new Promise((resolve) => {
                const get = db.transaction('userProfiles', 'readonly')
                    .objectStore('userProfiles').get('Probe User');
                get.onsuccess = () => resolve(get.result || null);
                get.onerror = () => resolve(null);
            });
            db.close();
            const t = ((row && row.tradeLog) || []).find((x) => x.id === id);
            return !!t && t.outcome === 'WIN' && t.resolutionSource === 'correction'
                && !!t.correctedAt && t.correctedFrom === 'LOSS';
        }, 'pt-2', { timeout: 15000 }).then(() => true).catch(() => false);
        check('one tap on Confirm writes the corrected outcome through the gated path', audit);
        // The detail reads the row AGAIN, after the save has settled — a read
        // raced against the debounced write printed a pre-commit snapshot and
        // misreported a passing check (review finding).
        await sleep(2000);
        const afterConfirm = await readTradeRow(page, 'pt-2');
        check('the confirmed correction carries the journal edit audit trail', audit,
            afterConfirm
                ? `outcome=${afterConfirm.outcome} resolutionSource=${afterConfirm.resolutionSource} correctedAt=${afterConfirm.correctedAt} correctedFrom=${JSON.stringify(afterConfirm.correctedFrom)}`
                : 'row missing');
        await sleep(600);
        const cardGone = (await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]').count()) === 0;
        check('the card resolves after the confirm', cardGone);

        // ── Turn 2: propose the pt-3 correction, then DISMISS it ─────────
        await sendInDock(page, 'PROBE_TOOL_ROUND and now correct pt-3 as well');
        await page.waitForSelector('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]',
            { timeout: 45000 });
        const card2Text = await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]')
            .first().innerText();
        check('a second dock proposal renders for the other row', /WIN\s*→\s*LOSS/i.test(card2Text),
            card2Text.replace(/\s+/g, ' ').slice(0, 120));
        await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-dismiss"]')
            .first().click();
        await sleep(1200);
        const dismissedRow = await readTradeRow(page, 'pt-3');
        check('a dismissed correction leaves its row untouched',
            !!dismissedRow && dismissedRow.outcome === 'WIN',
            dismissedRow ? `outcome=${dismissedRow.outcome}` : 'row missing');
        const card2Gone = (await page.locator('[data-testid="trade-chat-panel"] [data-testid="settlement-correction-card"]').count()) === 0;
        check('the dismissed card resolves too', card2Gone);

        check('zero pageerrors across the dock-card run', pageErrors.length === 0,
            pageErrors.slice(0, 3).join(' | '));
        await browser.close();
    } catch (err) {
        console.error('DOCK CARD PROBE FAIL (driver):', err && err.message || err);
        process.exitCode = 1;
    } finally {
        server.kill();
        mock.kill();
    }
    if (failures.length) {
        console.error(`\nDOCK CARD PROBE FAILED — ${failures.length} check(s):`);
        for (const f of failures) console.error(' • ' + f);
        process.exitCode = 1;
        return;
    }
    if (process.exitCode !== 1) {
        console.log('\nDOCK CARD PROBE OK — the dock proposes, the trader confirms in one tap,');
        console.log('the journal row moves through the journal\'s own gated path, and nothing');
        console.log('changes without that confirmation.');
    }
}

void main();
