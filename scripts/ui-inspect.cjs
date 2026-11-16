/**
 * ui-inspect — a READ-ONLY tour of the running shell, reporting measured facts.
 *
 * WHY THIS EXISTS ALONGSIDE render-probe. render-probe answers "does it
 * work": rows render, controls respond, no pageerrors. It does not answer
 * "what does it actually look like", which is a different question — a rail
 * that renders at 280px while pushing the chart off-screen passes every
 * render-probe assertion and is still obviously wrong.
 *
 * It answers by MEASURING rather than by eyeballing. Every number below is
 * read off the live DOM (getBoundingClientRect, getComputedStyle,
 * elementFromPoint) at real viewport widths, so the report is evidence about
 * the rendered result rather than an opinion about the source. Screenshots are
 * written alongside for a human who can see them; this script never reads
 * them back, which is the whole point — an automated pass must not depend on
 * an agent's eyes to notice a layout regression.
 *
 *   node scripts/ui-inspect.cjs                  # self-hosts vite on 4184
 *   PROBE_REUSE=1 node scripts/ui-inspect.cjs     # reuse a running server
 *
 * Exit code 0 means every assertion held. It is NOT a substitute for
 * render-probe: it drives nothing but the chrome, and deliberately makes no
 * claim about trading behaviour.
 */

const { spawn } = require('child_process');
const path = require('path');
const { mkdirSync } = require('fs');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4184;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, '.probe-artifacts');

/** Electron's own floor is minWidth 800 / minHeight 600, plus the 1024
 *  auto-collapse boundary and one width comfortably above it. */
const WIDTHS = [800, 1024, 1440];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};
const note = (label, value) => console.log(`  ···  ${label}: ${value}`);

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

/** Same seeding the render-probe uses: a profile and a ready provider, or the
 *  app gates itself behind the workspace modal and none of this is reachable. */
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
            username: 'Probe User',
            conversations: [], tradeLog: [], tradeSummaries: [],
            finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        // Field-for-field the provider shape ProviderConfigService expects.
        // A partial one loads but resolves no ready provider, and the composer
        // then sits disabled with "Configure a provider in Settings first" —
        // which reads like a layout bug and is really a seeding bug.
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false,
            models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));
    }, MOCK_PORT);
}

/** Read the whole shell at once. One evaluate, one round trip, so every number
 *  in the report comes from the SAME frame — numbers sampled across separate
 *  calls can straddle a resize and describe a layout that never existed. */
const measureShell = () => {
    const box = (el) => el ? el.getBoundingClientRect() : null;
    const rail = document.querySelector('[data-testid="shell-rail"]');
    const main = document.querySelector('main');
    // The thread pane, not <main>: the column now lives INSIDE main, so main's
    // width is unchanged by a collapse and only the pane beside it grows.
    const thread = document.querySelector('[data-testid="agents-thread-column"]');
    const header = document.querySelector('header');
    const rows = [...document.querySelectorAll('[data-testid^="surface-switch-"]')];
    // `window.getComputedStyle`, not the bare global: this runs inside
    // page.evaluate, but the file is a Node .cjs and eslint resolves globals
    // from the file's own environment — where the bare name is undefined.
    const cs = (el) => (el ? window.getComputedStyle(el) : null);
    return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        rail: rail ? {
            width: Math.round(box(rail).width),
            expanded: rail.getAttribute('data-expanded'),
            zIndex: cs(rail).zIndex,
            background: cs(rail).backgroundColor,
            borderRight: cs(rail).borderRightWidth,
        } : null,
        thread: thread ? { width: Math.round(box(thread).width) } : null,
        main: main ? {
            width: Math.round(box(main).width),
            left: Math.round(box(main).left),
            background: cs(main).backgroundColor,
        } : null,
        header: header ? {
            height: Math.round(box(header).height),
            zIndex: cs(header).zIndex,
            // The header sits ABOVE the rail in the visual stack only by
            // accident of position; this records what is actually painted.
            position: cs(header).position,
        } : null,
        rows: rows.map(r => ({
            label: r.getAttribute('aria-label'),
            current: r.getAttribute('aria-current') || null,
            width: Math.round(box(r).width),
            visibleText: (r.textContent || '').trim(),
        })),
        bodyBackground: cs(document.body).backgroundColor,
        colorScheme: cs(document.documentElement).colorScheme,
    };
};

async function main() {
    mkdirSync(SHOTS, { recursive: true });
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = process.env.PROBE_REUSE
        ? null
        : spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    if (server) {
        server.stdout.on('data', d => { out += String(d); });
        server.stderr.on('data', d => { out += String(d); });
    }

    let browser;
    try {
        if (!(await waitForServer(BASE))) {
            console.error('UI INSPECT FAIL: no dev server on', BASE, '\n', out);
            process.exitCode = 1;
            return;
        }
        browser = await chromium.launch();
        const pageErrors = [];
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', (e) => pageErrors.push(String(e)));

        await seed(page);
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid^="surface-switch-"]', { timeout: 30000 });
        await sleep(1500);

        for (const width of WIDTHS) {
            console.log(`\n── viewport ${width}px ────────────────────────────────────`);
            await page.setViewportSize({ width, height: 900 });
            await sleep(700);
            const m = await page.evaluate(measureShell);

            note('page scrollWidth vs viewport', `${m.scrollWidth} vs ${m.viewport.w}`);
            check('nothing overflows horizontally', m.scrollWidth <= m.viewport.w,
                `scrollW ${m.scrollWidth} / vw ${m.viewport.w}`);

            check('the destinations are present at every width', m.rows.length === 4, `${m.rows.length} entries`);
            if (m.rail) {
                note('conversation column', `${m.rail ? m.rail.width : 0}px, visible=${!!m.rail && m.rail.expanded !== 'false'}`);
            }
            if (m.main) {
                note('main', `${m.main.width}px at left ${m.main.left}, bg=${m.main.background}`);
                // The chart needs room. A rail that leaves the content below
                // ~55% of the viewport has taken more than it gives back.
                check('the surface keeps a usable share of the width',
                    m.main.width >= width * 0.55,
                    `${m.main.width}px of ${width}px`);
            }
            check('all four destinations render', m.rows.length === 4, `${m.rows.length} entries`);
            const current = m.rows.filter(r => r.current === 'page');
            check('exactly one row is marked current', current.length === 1,
                current.map(r => r.label).join(',') || 'none');
            check('every destination still carries an accessible name',
                m.rows.every(r => !!r.label), m.rows.filter(r => !r.label).map(r => r.label).join('|'));

            await page.screenshot({ path: path.join(SHOTS, `ui-${width}.png`), fullPage: false });
            note('screenshot', `.probe-artifacts/ui-${width}.png`);
        }

        // ── Collapse / expand, and what it costs the chart ──────────────────
        console.log('\n── conversation column collapse ──────────────────────');
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(500);
        // The column that collapses belongs to the Agents surface, and the width
        // tour above leaves the app on Journal — measuring the wrong surface
        // makes `rail` null, which reads as a crash rather than as a moved
        // layout. This is also what Ctrl+B does for a person: it puts away the
        // column on the surface that has one.
        await page.evaluate(() => document.querySelector('[data-testid="surface-switch-agents"]')?.click());
        await sleep(1500);
        const before = await page.evaluate(measureShell);
        await page.keyboard.press('Control+b');
        await sleep(600);
        const after = await page.evaluate(measureShell);
        note('expanded', `${before.rail.width}px, main ${before.main.width}px`);
        note('collapsed', `${after.rail.width}px, main ${after.main.width}px`);
        check('Ctrl+B hides the column completely (0px)', after.rail.width === 0, `${after.rail.width}px`);
        check('the thread gains exactly the width the column gives up',
            !!before.thread && !!after.thread
                && Math.abs((after.thread.width - before.thread.width) - (before.rail.width - after.rail.width)) <= 1,
            before.thread && after.thread
                ? `thread +${after.thread.width - before.thread.width}, column -${before.rail.width - after.rail.width}`
                : 'no thread pane on this surface');
        check('the destinations keep their accessible names when collapsed',
            after.rows.every(r => !!r.label), `${after.rows.length} entries`);
        // There is no glyph-only collapsed state to assert any more: the column
        // hides entirely rather than narrowing to icons, so the old
        // "collapsed rows show no text" check described a rail that no longer
        // exists and would pass vacuously against the switch.
        await page.screenshot({ path: path.join(SHOTS, 'ui-1440-collapsed.png') });

        // A hidden rail whose expand affordance does not work is the trap
        // this catches: the header button must revive the panel, and the
        // revived panel must provably route — measured by the header's own
        // surface label, since data-expanded never changes on a click.
        await page.evaluate(() => document.querySelector('[data-testid="nav-rail-toggle-header"]')?.click());
        await sleep(600);
        const revived = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="shell-rail"]');
            return !!el && el.offsetParent !== null;
        });
        check('the header toggle revives the hidden column', revived === true, `visible=${revived}`);
        await page.evaluate(() => {
            [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                .find(b => /^Journal/i.test(b.getAttribute('aria-label') || ''))?.click();
        });
        await sleep(1200);
        const where = await page.evaluate(() => {
            const on = [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                .find(b => b.getAttribute('aria-current') === 'page');
            return on ? (on.getAttribute('aria-label') || '').split(',')[0] : null;
        });
        // Read off the switch, not a text label: the header's surface label is
        // only a fallback for when no switch is supplied, and one always is now.
        check('the revived column routes to Journal', where === 'Journal', String(where));

        await page.keyboard.press('Control+b');
        await sleep(500);

        // ── The dock: hidden, not closed ───────────────────────────────────
        // The strongest claim in this phase is that collapsing the Chart AI dock
        // preserves what is in it. It is verified the only way it can honestly
        // be: type a draft in a real browser, collapse, expand, and read the
        // draft back. A source scan would pass on the old swapping code, which
        // is exactly the bug.
        console.log('\n── Chart AI dock: hide vs close ────────────────────────');
        // The rail block above leaves the tour on Journal (to prove the rail
        // routes); the dock lives on Trade, so get back there first or this
        // measures an absent panel and reports it as a layout failure.
        await page.evaluate(() => {
            [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                .find(b => /^Trade/i.test(b.getAttribute('aria-label') || ''))?.click();
        });
        await sleep(1500);
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(600);
        {
            const dock = page.locator('[data-testid="trade-dock"]');
            const compose = dock.locator('textarea').first();
            if (!(await compose.count())) {
                check('the dock composer is reachable', false, 'no textarea in trade-dock');
            } else {
                const draft = 'half-written analysis, mid-thought';
                await compose.fill(draft);
                await sleep(300);

                await page.evaluate(() => {
                    document.querySelector('[aria-label="Collapse Chart AI"]')?.click();
                });
                await sleep(700);

                const collapsed = await page.evaluate(() => {
                    const d = document.querySelector('[data-testid="trade-dock"]');
                    return {
                        mounted: !!d,
                        hidden: d ? d.getAttribute('data-hidden') : null,
                        inert: d ? d.hasAttribute('inert') : null,
                        railVisible: !!document.querySelector('[data-testid="trade-dock-rail"]'),
                    };
                });
                note('while collapsed', JSON.stringify(collapsed));
                check('the collapsed dock stays MOUNTED', collapsed.mounted === true);
                check('it is marked hidden rather than removed', collapsed.hidden === 'true');
                check('it is inert, so it stays out of the tab ring', collapsed.inert === true);
                check('the collapsed rail is what the user sees', collapsed.railVisible === true);
                note('screenshot', '.probe-artifacts/ui-1440-dock-collapsed.png');
                await page.screenshot({ path: path.join(SHOTS, 'ui-1440-dock-collapsed.png') });

                await page.evaluate(() => {
                    document.querySelector('[aria-label="Expand Chart AI"]')?.click();
                });
                await sleep(700);
                const after = await page.locator('[data-testid="trade-dock"] textarea').first().inputValue().catch(() => '');
                check('the draft survived the collapse', after === draft, `"${after.slice(0, 40)}"`);
                await page.screenshot({ path: path.join(SHOTS, 'ui-1440-dock-restored.png') });
            }
        }

        // ── Theme sanity: the palette must still be the dark one ─────────────
        console.log('\n── theme ─────────────────────────────────────────────');
        await page.evaluate(() => {
            [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                .find(b => /^Trade/i.test(b.getAttribute('aria-label') || ''))?.click();
        });
        await sleep(1000);
        const t = await page.evaluate(measureShell);
        note('body background', t.bodyBackground);
        note('color-scheme', t.colorScheme);
        check('the shell is still dark (near-black page, not light)', t.colorScheme !== 'light', t.colorScheme);
        check('page ground is the hue-free near-black #0a0a0a',
            t.bodyBackground === 'rgb(10, 10, 10)', t.bodyBackground);

        check('no pageerror across the whole tour', pageErrors.length === 0,
            pageErrors.slice(0, 2).join(' | ').slice(0, 180));
    } catch (err) {
        console.error('UI INSPECT FAIL:', err && err.stack ? err.stack : err);
        failures++;
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
        mock.kill();
    }

    console.log(failures === 0
        ? '\nUI INSPECT OK — the shell renders and measures as intended at 800/1024/1440px, collapsed and expanded.'
        : `\nUI INSPECT FAIL — ${failures} assertion(s) did not hold.`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });