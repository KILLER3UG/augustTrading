/** surface-shots — one screenshot per nav surface, at 1440, for the redesign spec.
 *  Reuses render-probe's seeding exactly (profile + mock provider + seeded
 *  verdicts/journal) so every surface has content to render. Writes PNGs to
 *  .probe-artifacts/surface-*.png. Read-only: drives the UI, asserts nothing. */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4191;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8791;
// SHOTS_EMPTY=1 profiles with no conversation, so the Agents surface's empty
// state can be looked at rather than asserted.
const SHOTS_EMPTY = !!process.env.SHOTS_EMPTY;
// LIVE_BASE=http://127.0.0.1:3000 attaches to an ALREADY-RUNNING dev server
// instead of spawning a competing vite (strictPort would just die). The
// browser context is still throwaway — seeding never touches a real profile.
const BASE = process.env.LIVE_BASE || `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, '.probe-artifacts');
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

async function seed(page) {
    await page.goto(`${BASE}/favicon.ico`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');
    });
    await page.evaluate(async ({ mockPort, empty }) => {        const db = await new Promise((resolve, reject) => {
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
    }, { mockPort: MOCK_PORT, empty: SHOTS_EMPTY });
    // Seed a populated journal so the Journal surface has rows, and a chat so
    // the Agents surface renders a thread — the spec must judge real screens.
    await page.evaluate(async ({ empty }) => {
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
            id: 'shot-conv', timestamp: Date.now() - 600000, title: 'Shot seeded',
            messages: [
                { id: 'm1', role: 'user', text: 'What is the bias here?', createdAt: new Date(Date.now() - 120000).toISOString() },
                {
                    id: 'm2', role: 'ai', text: 'Long bias into the reclaim, stop below the shelf.',
                    createdAt: new Date(Date.now() - 110000).toISOString(),
                    modelsUsed: { mock: 'mock-mini' }, analysis: analysis({}),
                    thoughtProcesses: { mock: 'The reclaim held above the shelf and sell-side was thin; the 1h and 4h reads agree.' },
                    runStats: {
                        runId: 'surface-run',
                        startedAt: new Date(Date.now() - 122000).toISOString(),
                        finishedAt: new Date(Date.now() - 110000).toISOString(),
                        durationMs: 12_000,
                    },
                },
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
            // SHOTS_EMPTY=1 leaves the profile with no conversation, so the
            // Agents surface's empty state — the one screen the reference is most
            // recognisable for — can actually be looked at rather than asserted.
            conversations: empty ? [] : [conv],
            lastActiveConversationId: empty ? null : conv.id,
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
    }, { empty: SHOTS_EMPTY });
}

async function main() {
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = process.env.LIVE_BASE ? null : spawn(
        process.execPath, [viteBin, '--port', String(PORT), '--strictPort'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let browser;
    try {
        if (!(await waitForServer(BASE)) || !(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
            console.error('SURFACE SHOTS FAIL: server/mock did not come up');
            process.exitCode = 1; return;
        }
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await seed(page);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        // The rail is gone; the title-bar switch is what proves the shell mounted.
        await page.waitForSelector('[data-testid^="surface-switch-"]', { timeout: 25000 });
        // The exchange feed fills the chart and the ladder after the shell
        // mounts; a 2s settle sometimes photographed skeletons. Four seconds
        // is still a capture preference, not a gate.
        await sleep(4000);

        // The destination rows are gone — the title-bar switch is the navigation
        // now — so press the switch by surface id. The label→id map is written
        // out because a switch that no longer exists returns 'not found' and
        // would otherwise re-shoot whatever surface happened to be open.
        // Navigation lives in the rail; when it is put away the content bar's
        // expand button (or the Agents drawer's opener) is the way in. There is
        // no four-tab fallback to click.
        const SWITCH_ID = { Analyze: 'trade', Journal: 'journal', Agents: 'agents', Learning: 'learn' };
        const navTo = async (name) => {
            const id = SWITCH_ID[name] || name;
            const clickSwitch = () => page.evaluate((surfaceId) => {
                const el = document.querySelector(`[data-testid="surface-switch-${surfaceId}"]`);
                if (!el) return 'missing';
                el.click();
                return 'clicked';
            }, id);
            let how = await clickSwitch();
            if (how === 'clicked') return 'clicked';
            const revealed = await page.evaluate(() => {
                const visible = (el) => {
                    if (!el) return false;
                    const cs = window.getComputedStyle(el);
                    return cs.visibility !== 'hidden' && cs.display !== 'none'
                        && el.getClientRects().length > 0;
                };
                const toggle = [...document.querySelectorAll(
                    '[data-testid="nav-rail-toggle-header"], [data-testid="rail-open"]')]
                    .find(visible);
                if (!toggle) return 'not found';
                toggle.click();
                return 'clicked';
            });
            if (revealed !== 'clicked') return 'not found';
            await sleep(300);
            how = await clickSwitch();
            if (how === 'clicked') {
                await page.evaluate(() => {
                    if (window.innerWidth < 1024) {
                        document.querySelector('[data-testid="shell-rail-backdrop"]')?.click();
                    }
                });
                return 'clicked';
            }
            return 'not found';
        };

        // 'Skills' is gone from the rail — it is a tab of the Learning surface,
        // shot below through the Customize row that reaches it. The surface row
        // itself is named 'Learning' now, and the sweep must ask for that: a
        // label that no longer matches returns 'not found' and re-shoots whatever
        // surface happened to be open, which is the vacuous read every gate here
        // exists to catch.
        for (const surface of ['Analyze', 'Journal', 'Agents', 'Learning']) {
            const how = await navTo(surface);
            await sleep(2500); // let lazy chunks + data settle
            await page.screenshot({ path: path.join(SHOTS, `surface-${surface.toLowerCase()}.png`) });
            console.log(`  ${surface}: ${how} -> surface-${surface.toLowerCase()}.png`);
        }
        // The Agents surface's switch, shot as the destination it reaches: the
        // chart with the Chart AI dock carrying the SAME conversation. Judging
        // "is this as clean as Claude" off the thread alone would miss the one
        // hop this surface has.
        await navTo('Agents');
        await sleep(1200);
        const pill = page.locator('[data-testid="surface-switch-trade"]');
        if (await pill.count()) {
            await pill.first().click();
            await sleep(2500);
            await page.screenshot({ path: path.join(SHOTS, 'surface-hop-chart-ai.png') });
            console.log('  Chat → Chart AI hop -> surface-hop-chart-ai.png');
            await page.locator('[data-testid="surface-switch-agents"]').first().click();
            await sleep(800);
        } else {
            console.log('  Chat → Chart AI hop: NO SWITCH FOUND');
        }
        // Settings modal — opened the way a person does (the Agents account
        // row's gear); there is no #/settings hash route, and the overlay mounts
        // outside <main> regardless. The title-bar gear was removed at the
        // owner's request; Ctrl+, remains the global shortcut.
        await page.locator('[data-testid="nav-settings"]').last().click();
        await page.waitForSelector('[aria-labelledby="settings-title"]', { timeout: 15000 });
        await sleep(1500);
        await page.screenshot({ path: path.join(SHOTS, 'surface-settings.png') });
        console.log('  Settings -> surface-settings.png');
        // The skill library, shot through the row that promises it — Customize
        // lands on the Learning surface's Skills tab.
        await page.keyboard.press('Escape');
        await sleep(800);
        const tabbed = await page.evaluate(() => {
            // Dismiss anything floating above the app first: this step used to
            // run while the Settings dialog was still open, so the click landed
            // on the sidebar BEHIND the overlay and the "Learning → Skills"
            // screenshot was a picture of the Settings dialog.
            const dlg = document.querySelector('[aria-labelledby="settings-title"]');
            if (dlg) return 'settings dialog still open';
            const hit = document.querySelector('[data-testid="nav-customize"]');
            if (!hit) return 'no Customize row';
            hit.click();
            return 'clicked';
        });
        await sleep(2500);
        await page.screenshot({ path: path.join(SHOTS, 'surface-learning-skills.png') });
        console.log(`  Learning → Skills: ${tabbed} -> surface-learning-skills.png`);

        // ── The states the reference is drawn in, not just the surfaces ──
        // Comparing "is this Claude" against four root screenshots misses the
        // parts the reference actually shows: a record open in the right panel,
        // a disclosure expanded, a settings section other than the first, the
        // picker the composer opens. Each step below presses the real control;
        // a step that cannot find it says so in the log rather than re-shooting
        // whatever is already on screen.
        const shoot = async (name, how) => {
            await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
            console.log(`  ${name}: ${how} -> ${name}.png`);
        };
        const press = async (selector, ms = 1200) => {
            const hit = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return 'missing';
                el.click();
                return 'clicked';
            }, selector);
            await sleep(ms);
            return hit;
        };

        // A skill document, read in the Skills tab's library — the reference's
        // SKILL.md view. The library is the one skill surface now, so this
        // selects the tab and presses a row.
        await press('[data-testid="learn-tab-skills"]', 1800);
        let how = await press('[data-testid="skills-catalog-card"]', 1500);
        await shoot('ui-skill-reader', how);

        // The audit disclosure under a settled verdict: August's answer to the
        // reference's collapsible "Ran a command" stack.
        await navTo('Agents');
        await sleep(1500);
        how = await press('[data-testid="agent-thread"] details summary', 900);
        await shoot('ui-chat-audit-open', how);

        // The composer's model chip. Pressed by its own testid, not by its text:
        // the label is the model's name, which changes with whatever is selected,
        // and a text match would report `missing` on a machine that has a model
        // picked while still shooting the previous state under a new name.
        how = await press('[data-testid="composer-model-chip"]', 1200);
        await shoot('ui-model-picker', how);
        await page.keyboard.press('Escape');
        await sleep(500);

        // Settings on a section that is not the first — the reference's Memory
        // list is what the Learning surface's own tabs are compared against.
        // The gear now lives only in the Agents account row (the title-bar gear
        // was removed) and Ctrl+, is the global route; a selector list keeps
        // this from silently shooting the open surface again.
        await press('[data-testid="nav-settings"]', 1500);
        how = await page.evaluate(() => {
            const hit = [...document.querySelectorAll('[aria-labelledby="settings-title"] button')]
                .find(b => /^Memory$/i.test((b.textContent || '').trim()));
            if (!hit) return 'missing';
            hit.click();
            return 'clicked';
        });
        await sleep(1500);
        await shoot('ui-settings-memory', how);
        await page.keyboard.press('Escape');

        // The empty conversation: the reference's hero + composer at rest. One
        // press now — `New` used to open a menu whose first item was this.
        how = await press('[data-testid="rail-new-chat"]', 1200);
        await shoot('ui-chat-empty', how);

        // The states that exist only after an interaction, and that no numeric
        // gate can vouch for: the revealed search field, the compact timeframe
        // menu, the collapsed column, and the phone layout.
        await navTo('Agents');
        await sleep(1400);
        how = await press('[data-testid="rail-search-toggle"]', 700);
        await shoot('ui-search-open', how);
        await page.keyboard.press('Escape');
        how = await press('[data-testid="tf-compact"]', 700);
        await shoot('ui-tf-menu-open', how);
        await page.keyboard.press('Escape');
        // The hide control lives IN the sidebar (after RECENT): it puts the
        // whole rail away, and the title-row toggle is the way back.
        how = await press('[data-testid="conversation-hide"]', 900);
        await shoot('ui-chat-collapsed', how);
        await press('[data-testid="nav-rail-toggle-header"]', 900);

        await page.setViewportSize({ width: 430, height: 860 });
        await sleep(1200);
        await navTo('Agents');
        await sleep(1600);
        await page.screenshot({ path: path.join(SHOTS, 'ui-phone-chat.png') });
        console.log('  ui-phone-chat (430px) -> ui-phone-chat.png');
        await navTo('Analyze');
        await sleep(2000);
        await page.screenshot({ path: path.join(SHOTS, 'ui-phone-trade.png') });
        console.log('  ui-phone-trade (430px) -> ui-phone-trade.png');
        await page.setViewportSize({ width: 1440, height: 900 });

        console.log(`pageerrors: ${errors.length}`);
        if (errors.length) console.log(errors.slice(0, 3).join('\n'));
    } catch (err) {
        console.error('SURFACE SHOTS FAIL:', err && err.stack || err);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
        mock.kill();
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
