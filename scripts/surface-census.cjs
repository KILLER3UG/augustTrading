/** surface-census — measured facts about every rendered surface, straight from
 *  the DOM (no eyes). Drives the app the way surface-shots does, then dumps a
 *  JSON census per surface: text-leaf count, the type-ramp distribution, radius
 *  distribution, heading tags, overflow, and the region skeleton. This is the
 *  evidence layer for the redesign spec — a screenshot can be misread, a
 *  getComputedStyle cannot. Read-only: asserts nothing, modifies nothing. */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4192;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.probe-artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { const res = await fetch(url); if (res.ok || res.status === 404) return true; }
        catch { /* not up */ }
        await sleep(250);
    }
    return false;
}

// Same seeding as surface-shots.
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
        const tx = db.transaction('userProfiles', 'readwrite');
        tx.objectStore('userProfiles').put({
            username: 'Probe User', conversations: [], tradeLog: [],
            tradeSummaries: [], finalTradeSummary: null, settings: { activeFrameworks: [] },
        });
        await new Promise((resolve) => { tx.oncomplete = () => resolve(); });
        db.close();
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false, models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));
    }, MOCK_PORT);
    await page.evaluate(async () => {
        const analysis = (over) => ({
            direction: 'Long', confidence: 'High', coinName: 'BTCUSDT',
            entryPoints: [{ price: '84210.5', description: 'reclaim' }],
            stopLoss: '83100', takeProfit: [{ price: '87900' }], probability: 62,
            reasoning: 'Holding above the 200-EMA into thin sell-side.',
            marketConditions: {}, activeStrategies: [], validationWarnings: [], ...over,
        });
        const row = (id, mins, outcome, type, dir, coin) => ({
            id, outcome, tradeType: type, timestamp: new Date(Date.now() - mins * 60000).toISOString(),
            leverage: 10, analysis: analysis({ direction: dir, coinName: coin }),
        });
        const conv = {
            id: 'census-conv', timestamp: Date.now() - 600000, title: 'Census seeded',
            messages: [
                { id: 'm1', role: 'user', text: 'What is the bias here?', createdAt: new Date(Date.now() - 120000).toISOString() },
                { id: 'm2', role: 'ai', text: 'Long bias into the reclaim, stop below the shelf.', createdAt: new Date(Date.now() - 110000).toISOString(), modelsUsed: { mock: 'mock-mini' }, analysis: analysis({}) },
            ],
        };
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const store = db.transaction('userProfiles', 'readwrite').objectStore('userProfiles');
        const cur = await new Promise((resolve) => {
            const g = store.get('Probe User'); g.onsuccess = () => resolve(g.result); g.onerror = () => resolve(null);
        });
        store.put({
            ...(cur || { username: 'Probe User' }),
            conversations: [conv], lastActiveConversationId: conv.id,
            tradeLog: [
                row('t1', 300, 'WIN', 'scalp', 'Long', 'BTCUSDT'),
                row('t2', 280, 'LOSS', 'scalp', 'Short', 'BTCUSDT'),
                row('t3', 260, 'WIN', 'swing', 'Long', 'ETHUSDT'),
                row('t4', 240, 'ENTRY_NOT_HIT', 'swing', 'Short', 'SOLUSDT'),
            ],
            tradeSummaries: [], finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        db.close();
    });
}

// The census function, run inside the page. Scoped to ONE surface root:
// surfaces mount outside <main> (the overlays rule in AGENTS.md), so the old
// main-scoped measurement reported zeros for every surface but Learn and
// re-reported Learn for the Settings overlay.
const census = (rootSel) => {
    const cs = (el) => window.getComputedStyle(el);
    const px = (v) => Math.round(parseFloat(v) || 0);
    const scope = document.querySelector(rootSel)
        || document.querySelector('main')
        || document.body;
    const q = (sel) => [...scope.querySelectorAll(sel)];
    // Text leaves: elements whose direct text is non-empty and which have no
    // element children with their own text (i.e. the actual glyph carriers).
    const leaves = q('*').filter((el) => {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
            .map((n) => n.textContent.trim()).join('');
        if (!own) return false;
        return ![...el.children].some((c) => c.textContent.trim());
    });
    const ramp = {};
    const radii = {};
    const headings = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    const sizes = {};
    let smallPx = 0;
    for (const el of leaves) {
        const s = cs(el);
        const fs = px(s.fontSize);
        sizes[fs] = (sizes[fs] || 0) + 1;
        if (fs <= 11) smallPx++;
        // Map the computed px back onto the ramp role name where we can.
        const cls = el.className && String(el.className);
        const role = (cls.match(/text-ui-([a-z0-9]+)/) || [])[1];
        if (role) ramp[role] = (ramp[role] || 0) + 1;
    }
    for (const el of q('*')) {
        const cls = String(el.className || '');
        const m = cls.match(/rounded-([a-z0-9-]+)/);
        if (m) radii[m[1]] = (radii[m[1]] || 0) + 1;
    }
    q('h1, h2, h3, h4, h5, h6')
        .forEach((h) => { headings[h.tagName.toLowerCase()]++; });
    // Overflow.
    const vw = window.innerWidth;
    let worstOver = 0;
    for (const el of q('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const over = r.right - vw;
        if (over > worstOver) worstOver = over;
    }
    // Region skeleton: the direct-ish structural children with a label.
    const region = (el) => {
        const tid = el.getAttribute && el.getAttribute('data-testid');
        return tid ? `[${tid}]` : el.tagName.toLowerCase();
    };
    const topRegions = [...scope.children].map((c) => region(c)).slice(0, 12);
    const chars = leaves.reduce((n, el) => n + (el.textContent || '').trim().length, 0);
    const longStrings = leaves.filter((el) => (el.textContent || '').trim().length > 60).length;
    // Clickable-size floor: controls under 24px tall.
    let smallControls = 0;
    q('button, [role="button"], a').forEach((b) => {
        const r = b.getBoundingClientRect();
        if (r.height > 0 && r.height < 24) smallControls++;
    });
    const tid = scope.getAttribute && scope.getAttribute('data-testid');
    return {
        root: scope === document.body ? 'body' : (tid ? `[${tid}]` : rootSel),
        leafCount: leaves.length,
        smallPx, sizes, ramp, radii, headings, worstOver: Math.round(worstOver),
        chars, longStrings, smallControls, topRegions,
        selectCount: q('select').length,
        tableCount: q('table').length,
    };
};

async function main() {
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let browser;
    const out = {};
    try {
        if (!(await waitForServer(BASE)) || !(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
            console.error('CENSUS FAIL: server/mock did not come up'); process.exitCode = 1; return;
        }
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));
        await seed(page);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await page.waitForSelector('[data-testid^="surface-switch-"]', { timeout: 25000 });
        await sleep(2000);

        // The destination rows are gone, so the switch IS the navigation. Pressed
        // by surface id, and a miss throws: this loop used to ignore navTo's
        // return value, which meant a broken route measured whichever surface
        // happened to be mounted and still reported a number.
        const SWITCH_ID = { Analyze: 'trade', Journal: 'journal', Agents: 'agents', Learning: 'learn' };
        const navTo = async (name) => page.evaluate((id) => {
            const hit = document.querySelector(`[data-testid="surface-switch-${id}"]`);
            if (!hit) return false;
            hit.click(); return true;
        }, SWITCH_ID[name]);

        // Each surface is measured at its own root — not main, which some
        // surfaces never render inside.
        const ROOTS = {
            trade: '[data-testid="trade-view"]',
            journal: '[data-testid="journal-view"]',
            chat: '[data-testid="agents-view"]',
            agents: '[data-testid="agents-view"]',
            learn: '[data-testid="learn-view"]',
        };
        // 'Skills' is gone from the rail sweep — the Studio is measured under
        // Settings below, where it now actually lives.
        for (const surface of ['Analyze', 'Journal', 'Agents', 'Learning']) {
            if (!await navTo(surface)) throw new Error(`no switch entry for ${surface}`);
            const sel = ROOTS[surface.toLowerCase()];
            const ok = await page.waitForSelector(sel, { timeout: 15000 })
                .then(() => true).catch(() => false);
            await sleep(1500);
            out[surface.toLowerCase()] = await page.evaluate(census, ok ? sel : 'main');
        }
        // Settings is an overlay mounted outside <main> and has no hash route:
        // open it with the global Ctrl+, shortcut — the title-bar gear was
        // removed and the Agents account row is not mounted on every surface —
        // measure its own dialog root, close it.
        await page.keyboard.down('Control');
        await page.keyboard.press(',');
        await page.keyboard.up('Control');
        const dlg = '[aria-labelledby="settings-title"]';
        const dlgOk = await page.waitForSelector(dlg, { timeout: 15000 })
            .then(() => true).catch(() => false);
        await sleep(1500);
        out.settings = await page.evaluate(census, dlgOk ? dlg : 'main');
        await page.keyboard.press('Escape');
        await sleep(800);
        // The Strategy Studio is reached from the Customize row, and that row now
        // lives in the Agents surface's sidebar — so go back to Chat first. Pressing
        // a row that is not mounted would fall through to `main` and report
        // whatever surface happened to be open, the vacuous read this census
        // documents for every other surface.
        if (!await navTo('Agents')) throw new Error('no switch entry back to Agents');
        await page.waitForSelector('[data-testid="nav-customize"]', { timeout: 15000 })
            .then(() => true).catch(() => false);
        const studioOpened = await page.evaluate(() => {
            const hit = document.querySelector('[data-testid="nav-customize"]');
            if (!hit) return false;
            hit.click();
            return true;
        });
        const studioOk = studioOpened
            && await page.waitForSelector('[data-testid="studio-view"]', { timeout: 15000 })
                .then(() => true).catch(() => false);
        await sleep(1500);
        out.skills = await page.evaluate(census, studioOk ? '[data-testid="studio-view"]' : 'main');

        const { writeFileSync, mkdirSync } = require('fs');
        mkdirSync(OUT, { recursive: true });
        writeFileSync(path.join(OUT, 'census-1440.json'), JSON.stringify(out, null, 2));
        console.log(JSON.stringify(out, null, 2));
    } catch (err) {
        console.error('CENSUS FAIL:', err && err.stack || err); process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        server.kill(); mock.kill();
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
