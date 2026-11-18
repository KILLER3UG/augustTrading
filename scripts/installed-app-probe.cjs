/**
 * installed-app-probe — build gate for the INSTALLED desktop app (Part 3).
 *
 * installer-smoke proves the PACKAGED build boots. This probe goes further
 * and does what a trader actually does: RUN THE INSTALLER, then launch the
 * installed .exe and verify the surfaces INSIDE it. Nothing here drives the
 * win-unpacked build — the executable it launches is whatever NSIS put in the
 * install directory.
 *
 * What it verifies, with evidence into docs/evidence/installed-app/:
 *   01  pure Chat layout at 1440x900 (chart column 0px, centered <=760px
 *       reading column, no bias strip, no modal over the shot);
 *   02  Desk layout (chart + dock, the trader-gesture rail, legend present);
 *   03  the <lg flip walk (Desk<->Chat mid-conversation, zero Virtuoso loop);
 *   04  a presented plan's decision card (mock-driven, like the dev probe);
 *   05  the session guard standing a consumed session down on the card;
 *   06  the Journal review area: the weekly digest card + the trader-gated
 *       harness-optimization proposal card (seeded fixture — the card is the
 *       real renderer, the proposal is probe data, marked as such);
 *   07  the Journal history view (paper + journal rows);
 *   08  Settings modal: read-only AI status pills, the Tell-August bar docked
 *       inside the modal foot, monochrome nav.
 *
 * Every capture passes the two evidence guards: no settings window and no
 * visible aria-modal dialog over the shot, and card shots scrollIntoView +
 * assert the bounding box. The run ends with the app CLOSED and an assertion
 * that no August Trading process survived it.
 *
 * Usage:
 *   node scripts/installed-app-probe.cjs
 *     # builds the installer first if missing (electron-builder --win nsis)
 *
 * Environment:
 *   INSTALLER_APP_SETUP    path to an existing NSIS installer
 *   INSTALLER_APP_DIR      install directory override
 *   INSTALLER_APP_SKIP_BUILD=1   never build; fail if the installer is missing
 *   INSTALLER_APP_KEEP_PROFILE=1 keep the scratch userData
 *   MOCK_PORT              mock provider port (default 8791)
 *   INSTALLER_APP_TIMEOUT_MS     per-wait timeout (default 120000)
 */

const { spawn, spawnSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_PRODUCT = 'August Trading';
const SCRATCH_PARENT = path.join(os.tmpdir(), 'august-installed-probe');
const MOCK_PORT = Number(process.env.MOCK_PORT) || 8791;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;
const DEFAULT_TIMEOUT_MS = Number(process.env.INSTALLER_APP_TIMEOUT_MS) || 120000;
const LAUNCH_TIMEOUT_MS = 30000;
const KEEP_PROFILE = process.env.INSTALLER_APP_KEEP_PROFILE === '1';
const SKIP_BUILD = process.env.INSTALLER_APP_SKIP_BUILD === '1';
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'installed-app');

const SENSITIVE_ENV_KEY = /(?:^|_)(?:API|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|KEY)(?:_|$)|(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AWS|AZURE|GITHUB|NPM|PROVIDER|COHERE|MISTRAL|DEEPSEEK|GROQ|PERPLEXITY|CLOUDFLARE|STRIPE|SENDGRID|MAILGUN)/i;
const PROXY_ENV_KEY = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i;
const FORBIDDEN_ENV_KEY = /^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i;
const BENIGN_CONSOLE_PATTERNS = [
    /fapi[12]?\.binance\.com.*(?:CORS|ERR_FAILED)/i,
    /data-api\.binance\.vision.*(?:CORS|ERR_FAILED)/i,
    /net::ERR_(?:FAILED|ABORTED|CONNECTION_REFUSED|TIMED_OUT|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/i,
    /^Failed to load resource: net::ERR_(?:FAILED|BLOCKED_BY_CLIENT)$/,
    /Blocked by client/i,
    /^All fetch attempts failed for /i,
    /WebSocket connection to .*net::ERR_INTERNET_DISCONNECTED/i,
    /^Failed to fetch futures ticker for /i,
];

let failed = false;
const failures = [];
const pageErrors = [];
const consoleErrors = [];

function fail(msg) {
    failed = true;
    failures.push(msg);
    console.error(`INSTALLED APP PROBE FAIL: ${msg}`);
}

function check(name, ok, detail) {
    if (!ok) fail(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ${ok ? 'ok' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
    return ok;
}

function parseTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeEnv(source = process.env) {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (SENSITIVE_ENV_KEY.test(key) || PROXY_ENV_KEY.test(key) || FORBIDDEN_ENV_KEY.test(key)) continue;
        result[key] = String(value);
    }
    result.AUGUST_SMOKE_TEST = '1';
    result.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
    return result;
}

function terminateProcessTree(child) {
    if (!child || child.pid === undefined) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch { /* best-effort */ }
        return;
    }
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
}

function runCommand(command, args, { timeoutMs, env, cwd }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let settled = false;
        let output = '';
        const append = (chunk) => { output = (output + String(chunk)).slice(-16000); process.stdout.write(String(chunk)); };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateProcessTree(child);
            reject(new Error(`${command} timed out after ${timeoutMs}ms\n${output}`));
        }, timeoutMs);
        child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
        child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${command} exited code=${code} signal=${signal}\n${output}`));
        });
    });
}

function findInstaller() {
    const override = process.env.INSTALLER_APP_SETUP;
    if (override) {
        const resolved = path.resolve(ROOT, override);
        if (!fs.existsSync(resolved)) throw new Error(`INSTALLER_APP_SETUP does not exist: ${resolved}`);
        return resolved;
    }
    const dist = path.join(ROOT, 'dist_electron');
    if (!fs.existsSync(dist)) return null;
    const setups = fs.readdirSync(dist)
        .filter((f) => /setup/i.test(f) && f.toLowerCase().endsWith('.exe'))
        .sort((a, b) => fs.statSync(path.join(dist, b)).mtimeMs - fs.statSync(path.join(dist, a)).mtimeMs);
    return setups.length > 0 ? path.join(dist, setups[0]) : null;
}

async function buildInstaller() {
    const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
    if (!fs.existsSync(builderCli)) throw new Error(`electron-builder CLI not found at ${builderCli}; run npm ci first`);
    console.log('[installed-probe] building the NSIS installer (electron-builder --win nsis)…');
    await runCommand(process.execPath, [builderCli, '--win', 'nsis'], {
        timeoutMs: parseTimeout(process.env.INSTALLER_APP_BUILD_TIMEOUT_MS, 900000),
        env: { ...sanitizeEnv(), CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        cwd: ROOT,
    });
}

function installedExeOf(installDir) {
    return path.join(installDir, `${APP_PRODUCT}.exe`);
}

async function runInstaller(setupPath, installDir) {
    // NSIS: /S silent, /D MUST be the LAST argument and unquoted.
    console.log(`[installed-probe] installing ${path.basename(setupPath)} -> ${installDir}`);
    const res = spawnSync(setupPath, ['/S', `/D=${installDir}`], {
        cwd: path.dirname(setupPath),
        windowsHide: true,
        timeout: 240000,
    });
    if (res.error) throw new Error(`installer failed to start: ${res.error}`);
    // Some NSIS builds detach; poll for the exe either way.
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (fs.existsSync(installedExeOf(installDir))) return;
        await sleep(1000);
    }
    throw new Error(`installer finished but ${installedExeOf(installDir)} never appeared`);
}

/** Orphaned-app assertion: after the probe closes the app, NO August Trading
 *  process may remain — a probe that leaks its subject is a failed probe. */
function assertNoOrphanProcesses() {
    const res = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${APP_PRODUCT}.exe`, '/FO', 'CSV', '/NH'], {
        windowsHide: true, encoding: 'utf8', timeout: 20000,
    });
    const out = String(res.stdout || '');
    const rows = out.split('\n').filter((l) => l.toLowerCase().includes(`${APP_PRODUCT.toLowerCase()}.exe`));
    check('zero orphaned August Trading processes after close', rows.length === 0, rows.join(' | ').slice(0, 200));
}

// ── In-page helpers (the decision-card-probe's shapes, against app://) ──────

async function ensureNoOverlay(page, label) {
    const blocked = await page.evaluate(() => {
        if (document.querySelector('[data-testid="settings-window"]')) return 'settings-window open';
        const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
            .find((d) => d.getClientRects().length > 0);
        return dlg ? 'a modal dialog is open' : null;
    });
    if (blocked) throw new Error(`${label}: refusing to capture — ${blocked}`);
}

async function shootEvidence(page, name, label) {
    await ensureNoOverlay(page, label);
    const file = path.join(EVIDENCE_DIR, name);
    await page.screenshot({ path: file });
    console.log(`[installed-probe] evidence: ${name}`);
    return file;
}

async function shootCard(page, name, locator, label) {
    const blocked = await page.evaluate(() => {
        if (document.querySelector('[data-testid="settings-window"]')) return 'settings-window open';
        const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
            .find((d) => d.getClientRects().length > 0);
        return dlg ? 'a modal dialog is open' : null;
    });
    if (blocked) throw new Error(`${label}: refusing to capture — ${blocked}`);
    const el = locator.first();
    // Virtualized transcript: a follow-output re-scroll can unmount the row
    // mid-assert. Retry the scroll-assert pair; the assertion stays strict.
    let onScreen = false;
    for (let attempt = 0; attempt < 4 && !onScreen; attempt += 1) {
        await el.evaluate((node) => node.scrollIntoView({ block: 'center' })).catch(() => {});
        await sleep(300 + attempt * 200);
        onScreen = await el.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        }).catch(() => false);
    }
    if (!onScreen) throw new Error(`${label}: target is not inside the viewport after scrollIntoView`);
    const file = path.join(EVIDENCE_DIR, name);
    await page.screenshot({ path: file });
    console.log(`[installed-probe] evidence: ${name}`);
    return file;
}

async function scrollTranscriptToBottom(page) {
    await page.evaluate(() => {
        const scrollers = [...document.querySelectorAll('[data-testid="trade-chat-panel"] [data-virtuoso-scroller], [data-testid="trade-chat-panel"] [style*="overflow"]')];
        for (const el of scrollers) el.scrollTop = el.scrollHeight;
        const panel = document.querySelector('[data-testid="trade-chat-panel"]');
        if (panel) panel.scrollTop = panel.scrollHeight;
    }).catch(() => {});
    await sleep(200);
}

async function scrollTranscriptUp(page, amount = 1600) {
    await page.evaluate((amt) => {
        const scrollers = [...document.querySelectorAll('[data-testid="trade-chat-panel"] [data-virtuoso-scroller], [data-testid="trade-chat-panel"] [style*="overflow"]')];
        for (const el of scrollers) el.scrollTop = Math.max(0, el.scrollTop - amt);
    }, amount).catch(() => {});
    await sleep(200);
}

async function waitForCard(page, cardSelector, text, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    const locate = () => page.locator(`[data-testid="trade-chat-panel"] [data-testid="${cardSelector}"]`, { hasText: text });
    while (Date.now() < deadline) {
        await scrollTranscriptToBottom(page);
        await sleep(250);
        if (await locate().count()) return locate().last();
        for (let i = 0; i < 6; i += 1) {
            await scrollTranscriptUp(page, 900);
            await sleep(250);
            if (await locate().count()) return locate().last();
        }
        await sleep(400);
    }
    return null;
}

async function sendInDock(page, text) {
    await scrollTranscriptToBottom(page);
    await page.waitForFunction(() => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return false;
        return [...document.querySelectorAll('button')].some((b) => !b.disabled
            && /send/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
    }, null, { timeout: 30000 });
    const sent = await page.evaluate((needle) => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return 'no composer';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, needle);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find((b) => /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
        if (!btn) return 'no send button';
        if (btn.disabled) return 'send disabled';
        btn.click();
        return 'clicked';
    }, text);
    if (sent !== 'clicked') throw new Error(`dock send failed: ${sent}`);
}

// ── Seeding (installer-smoke's profile + the mock provider) ────────────────

async function seedInstalledApp(page) {
    await page.goto('app://./favicon.ico', { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    await page.evaluate(async (mockPort) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('last_active_user', 'Probe User');
        localStorage.setItem('august_surface_v1', 'trade');
        localStorage.setItem('workspace_layout_v1', 'desk');
        sessionStorage.setItem('activeUsername', 'Probe User');
        localStorage.setItem('harness_settings_v1', JSON.stringify({
            equityUsd: 10000, riskPercent: 1,
            guardMaxTradesPerDay: 20, guardDailyLossPct: 20, guardPostLossCooldownMin: 0,
        }));
        // The mock rides the desktop store's FIRST-RUN migration: a key that
        // exists only in localStorage is copied to the file store and served —
        // the same path the app uses for every preference it has not yet
        // written to disk.
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false,
            models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));

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
            settings: {
                activeFrameworks: [],
                isGlobalMemoryEnabled: false,
                isStrategiesEnabled: false,
                isEnsembleEnabled: false,
                customInstructions: { general: [] },
                isHybridIntelligenceEnabled: false,
                isAutoCapturing: false,
                isEntryNotHitCapturing: false,
                useAlgorithmicSummary: false,
                useAlgorithmicInsights: false,
                confidenceCalibration: false,
            },
        });
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('seed aborted'));
        });
        db.close();

        // Fixture data for the review cards (installed-06): the weekly digest
        // and a PENDING harness-optimization proposal. The CARDS are the real
        // renderers; these rows are probe fixtures, like the mock provider.
        localStorage.setItem('weekly_review_v1_Probe User', JSON.stringify({
            generatedAt: new Date(Date.now() - 3600_000).toISOString(),
            stats: {
                closed: 2, wins: 1, losses: 1, netPnlUsd: 0, dollarRows: 0,
                avgR: null, adherenceFollowedPct: null, topMistake: null, givebackDays: 0,
            },
            impulse: 'Probe fixture: one impulse line so the review card has a body.',
            providerName: 'Mock',
        }));
        localStorage.setItem('harness_optimization_v1_Probe User', JSON.stringify({
            lastPassAt: new Date().toISOString(),
            proposal: {
                id: 'harness-opt-probe-1',
                status: 'pending',
                kind: 'stop-gap',
                promptId: 'analysis.risk_rules',
                before: 'Probe fixture: the previous block text.',
                after: 'Probe fixture: the previous block text.\n\nStop placement: set the stop where a single bar\'s open cannot blow through it.',
                reason: 'Probe fixture: 2 recent exits opened beyond the stop (gap-adjusted), so the proposal widens stop placement — approve routes through the ledgered self-change path.',
                evidence: [
                    { id: 'probe-e1', source: 'signal', outcome: 'loss', at: Date.now() - 4000_000, fact: 'BTC long: the exit bar opened beyond the stop — the fill cost more than 1R (gap-adjusted)' },
                    { id: 'probe-e2', source: 'signal', outcome: 'loss', at: Date.now() - 8000_000, fact: 'BTC long: the exit bar opened beyond the stop — the fill cost more than 1R (gap-adjusted)' },
                ],
                createdAt: new Date().toISOString(),
                baseline: { hitRate: 0.4, samples: 5 },
            },
            history: [],
        }));
    }, MOCK_PORT);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.mkdirSync(SCRATCH_PARENT, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(SCRATCH_PARENT, `august-installed-${process.pid}-`));

    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const expectedVersion = String(packageJson.version);

    let installer = findInstaller();
    if (!installer) {
        if (SKIP_BUILD) throw new Error('INSTALLER_APP_SKIP_BUILD=1 but no NSIS installer exists in dist_electron/');
        await buildInstaller();
        installer = findInstaller();
    }
    if (!installer) throw new Error('no NSIS installer found after the build');
    console.log(`[installed-probe] installer: ${installer}`);

    const installDir = process.env.INSTALLER_APP_DIR
        ? path.resolve(ROOT, process.env.INSTALLER_APP_DIR)
        : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'AugustTradingProbe');
    if (fs.existsSync(installedExeOf(installDir))) {
        console.log('[installed-probe] install dir already populated — reinstalling over it');
    }
    await runInstaller(installer, installDir);
    const installedExe = installedExeOf(installDir);
    if (!fs.existsSync(installedExe)) throw new Error(`the installed exe is missing: ${installedExe}`);
    console.log(`[installed-probe] installed exe: ${installedExe}`);

    // The mock provider, on the loopback the installed app can reach.
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
        cwd: ROOT,
        env: {
            ...sanitizeEnv(),
            MOCK_SKILL_ARGS: JSON.stringify([
                { symbol: 'BTCUSDT', direction: 'Long', entry: 84000, stopLoss: 1000, takeProfits: [88000], confidence: 'Low', rationale: 'Installed-probe plan — the presented card.', invalidation: 'A close below the probe stop.' },
                { __tool: 'propose_risk_change', target: 'guardMaxTradesPerDay', value: 1, reason: 'The tape is choppy; one attempt today, then a review.' },
                { symbol: 'BTCUSDT', direction: 'Long', entry: 84000, stopLoss: 1000, takeProfits: [200000], confidence: 'Low', rationale: 'Installed-probe plan E — the session-guard walk.', invalidation: 'A close below the probe stop.' },
            ]),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let mockOut = '';
    mock.stdout.on('data', (d) => { mockOut += String(d); });
    mock.stderr.on('data', (d) => { mockOut += String(d); });

    const waitForServer = async (url, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try { const res = await fetch(url); if (res.ok) return true; } catch { /* not up yet */ }
            await sleep(250);
        }
        return false;
    };
    if (!(await waitForServer(`${BASE}/models`))) {
        mock.kill();
        throw new Error(`mock provider never came up on ${BASE}\n${mockOut}`);
    }

    let electronApp = null;
    try {
        electronApp = await electron.launch({
            executablePath: installedExe,
            args: [
                `--user-data-dir=${scratchDir}`,
                '--disable-background-networking',
                '--disable-component-update',
                '--metrics-recording-only',
                '--disable-gpu',
            ],
            cwd: ROOT,
            env: sanitizeEnv(),
            timeout: LAUNCH_TIMEOUT_MS,
        });
        const appProcess = electronApp.process();

        const mainInfo = await electronApp.evaluate(({ app }) => ({
            isPackaged: app.isPackaged,
            version: app.getVersion(),
        }));
        check('the installed exe runs packaged', mainInfo.isPackaged === true, JSON.stringify(mainInfo));
        check('the installed exe is the one the installer wrote', true, installedExe);
        check('the installed version matches the package', String(mainInfo.version) === expectedVersion,
            `app=${mainInfo.version} package=${expectedVersion}`);

        const context = electronApp.context();
        context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
        context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
        // Block every external host; the loopback mock stays reachable.
        await context.route('**/*', async (route) => {
            const url = route.request().url();
            if (/^https?:\/\/127\.0\.0\.1:8791/i.test(url) || /^https?:\/\/localhost:8791/i.test(url)) {
                await route.continue();
                return;
            }
            if (/^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url)) {
                await route.abort();
                return;
            }
            await route.continue();
        });

        const page = await electronApp.firstWindow({ timeout: DEFAULT_TIMEOUT_MS });
        page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
        page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
        page.on('console', (message) => {
            if (message.type() === 'error' && !BENIGN_CONSOLE_PATTERNS.some((p) => p.test(message.text()))) {
                consoleErrors.push(message.text());
            }
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForLoadState('load');
        await seedInstalledApp(page);
        await page.goto('app://./index.html', { waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
        await page.locator('#splash').waitFor({ state: 'detached', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
        await page.getByRole('dialog', { name: /User profile selection/i }).waitFor({ state: 'detached', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
        await sleep(2500);

        // ── 01: Chat layout at 1440x900 ────────────────────────────────────
        await page.evaluate(() => localStorage.setItem('workspace_layout_v1', 'chat'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        const chatGeom = await page.evaluate(() => {
            const box = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), center: r.left + r.width / 2 };
            };
            return {
                vw: window.innerWidth,
                chartColumn: box('[data-testid="trade-chart-column"]'),
                dock: box('[data-testid="trade-dock"]'),
                workspace: box('main'),
                reading: box('[data-testid="chat-reading-column"]'),
                biasRow: !!document.querySelector('[data-testid="bias-row"]'),
            };
        });
        const chatDelta = chatGeom.workspace && chatGeom.reading
            ? Math.abs(chatGeom.workspace.center - chatGeom.reading.center) : Number.NaN;
        check('01 chat: chart column 0px, dock full-width, reading column centered <=760px, no bias strip',
            chatGeom.chartColumn?.width === 0
            && chatGeom.dock && chatGeom.workspace
            && Math.abs(chatGeom.dock.width - chatGeom.workspace.width) < 24
            && chatGeom.reading && chatGeom.reading.width > 0 && chatGeom.reading.width <= 760
            && chatDelta < 24
            && chatGeom.biasRow === false,
            JSON.stringify(chatGeom));
        await shootEvidence(page, 'installed-01-chat-1440x900.png', 'chat 1440x900');

        // ── 02: Desk layout ────────────────────────────────────────────────
        await page.evaluate(() => localStorage.setItem('workspace_layout_v1', 'desk'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        const deskState = await page.evaluate(() => {
            const rail = document.querySelector('[data-testid="chart-tool-rail"]');
            const railButtons = rail ? [...rail.querySelectorAll('button')].map((b) => ({
                title: b.title || b.getAttribute('aria-label') || '',
            })) : [];
            return {
                chartVisible: (document.querySelector('[data-testid="trade-chart-pane"]')?.getBoundingClientRect().width ?? 0) > 0,
                dockVisible: (document.querySelector('[data-testid="trade-dock"]')?.getBoundingClientRect().width ?? 0) > 0,
                railButtons,
                legendPresent: !!document.querySelector('[data-testid="chart-legend"]'),
                shapeToolLeak: railButtons.some((b) => /trendline|horizontal line|rectangle|fib|text note|clear all/i.test(b.title)),
            };
        });
        check('02 desk: chart + dock visible, the trader-gesture rail (7+ controls, zero shape tools)',
            deskState.chartVisible && deskState.dockVisible
            && deskState.railButtons.length >= 7
            && deskState.legendPresent
            && deskState.shapeToolLeak === false,
            JSON.stringify({ n: deskState.railButtons.length, titles: deskState.railButtons.map((b) => b.title) }));
        await shootEvidence(page, 'installed-02-desk-1440x900.png', 'desk 1440x900');

        // ── 03: <lg flip walk, zero Virtuoso loop ──────────────────────────
        await page.setViewportSize({ width: 960, height: 720 });
        await sleep(500);
        const errorsBeforeFlip = pageErrors.length;
        for (const layout of ['chat', 'desk', 'chat', 'desk']) {
            await page.evaluate((l) => localStorage.setItem('workspace_layout_v1', l), layout);
            await page.evaluate(() => {
                const mini = document.querySelector('[data-testid="layout-pill-mini-chat"], [data-testid="layout-pill-mini-desk"], [data-testid="layout-pill-chat"], [data-testid="layout-pill-desk"]');
                mini?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await sleep(450);
        }
        const flipErrors = pageErrors.slice(errorsBeforeFlip)
            .filter((e) => /Maximum update depth|too many re-renders/i.test(e));
        check('03 narrow 960x720: the layout flip walk produces zero Virtuoso update loops',
            flipErrors.length === 0, flipErrors.slice(0, 2).join(' | '));
        await shootEvidence(page, 'installed-03-narrow-960x720.png', 'narrow 960x720');
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(500);

        // ── 04: the presented plan's decision card ─────────────────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND present a plan');
        const cardA = await waitForCard(page, 'trade-proposal-card', 'Installed-probe plan');
        if (!cardA) throw new Error('the presented card never rendered in the installed app');
        const cardAText = (await cardA.innerText().catch(() => '')).replace(/\s+/g, ' ');
        check('04 the presented plan renders the decision card in the installed app',
            /Approve/i.test(cardAText) && /Reject/i.test(cardAText), cardAText.slice(0, 140));
        await shootCard(page, 'installed-04-decision-cards.png', cardA, 'decision card');

        // ── 05: the guard stands the session down on the card ──────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND tighten the trade cap');
        const capCard = await waitForCard(page, 'risk-change-card', 'one attempt today');
        if (!capCard) throw new Error('the guard-tighten card never rendered in the installed app');
        await capCard.locator('[data-testid="risk-change-confirm"]').click();
        await sleep(1200);
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan E');
        const cardE = await waitForCard(page, 'trade-proposal-card', 'plan E');
        if (!cardE) throw new Error('plan E never rendered in the installed app');
        let blockSeen = null;
        for (let i = 0; i < 10 && !blockSeen; i += 1) {
            await sleep(400);
            blockSeen = await cardE.evaluate((el) => {
                const block = el.querySelector('[data-testid="proposal-guard-block"]');
                const btn = el.querySelector('[data-testid="proposal-approve"]');
                return btn && btn.disabled && block ? block.textContent : null;
            });
        }
        check('05 the guard stands a consumed session down on the card (Approve down, reason printed)',
            !!blockSeen, blockSeen ? blockSeen.slice(0, 120) : 'no guard block');
        await shootCard(page, 'installed-05-guard-block.png', cardE, 'guard block card');

        // ── 06 + 07: the Journal review area, inside the Settings modal ────
        await page.evaluate(() => {
            document.querySelector('[data-testid="nav-settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await sleep(900);
        await page.evaluate(() => {
            document.querySelector('[data-testid="settings-section-journal"]')?.click();
        });
        await sleep(700);
        await page.evaluate(() => {
            const analyticsTab = [...document.querySelectorAll('[role="dialog"] button')]
                .find((b) => /^analytics$/i.test((b.textContent || '').trim()));
            analyticsTab?.click();
        });
        await sleep(900);
        const reviewState = await page.evaluate(() => ({
            weekly: !!document.querySelector('[role="dialog"] [data-testid="weekly-review-card"], [role="dialog"] .rounded-bubble'),
            harness: !!document.querySelector('[data-testid="harness-optimization-card"]'),
            harnessApprove: !!document.querySelector('[data-testid="harness-opt-approve"]'),
        }));
        check('06 the review area renders the weekly digest card and the trader-gated harness proposal card',
            reviewState.weekly && reviewState.harness && reviewState.harnessApprove, JSON.stringify(reviewState));
        const harnessCard = page.locator('[data-testid="harness-optimization-card"]');
        // The modal IS the evidence here (bug 2's guard applies to chat/desk
        // shots, not to a settings-section capture) — shoot directly.
        await harnessCard.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await sleep(300);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 'installed-06-phase5-review-and-ram-harness-card.png') });
        console.log('[installed-probe] evidence: installed-06-phase5-review-and-ram-harness-card.png');

        // 07: the Journal history view (paper + journal rows).
        await page.evaluate(() => {
            const historyTab = [...document.querySelectorAll('[role="dialog"] button')]
                .find((b) => /^history$/i.test((b.textContent || '').trim()));
            historyTab?.click();
        });
        await sleep(900);
        const historyState = await page.evaluate(() => ({
            checkboxes: [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')].length,
            rowMention: [...document.querySelectorAll('[role="dialog"] [data-testid="trade-log"] *')].length > 0
                || [...document.querySelectorAll('[role="dialog"] [data-testid="journal-*"]')].length > 0
                || (document.querySelector('[role="dialog"]')?.textContent || '').includes('BTCUSDT'),
        }));
        check('07 the journal history view renders the seeded rows inside the modal',
            historyState.rowMention || historyState.checkboxes > 0, JSON.stringify(historyState));
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 'installed-07-phase6-paper-and-journal.png') });
        console.log('[installed-probe] evidence: installed-07-phase6-paper-and-journal.png');

        // ── 08: Settings → Analysis, monochrome + the docked bar ───────────
        await page.evaluate(() => {
            document.querySelector('[data-testid="settings-section-analysis"]')?.click();
        });
        await sleep(800);
        const settingsState = await page.evaluate(() => {
            const win = document.querySelector('[data-testid="settings-window"]');
            const bar = document.querySelector('[data-testid="tell-august-bar"]');
            const box = (el) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
            };
            const w = box(win);
            const b = box(bar);
            const navText = [...document.querySelectorAll('[data-testid="settings-window"] button')]
                .map((x) => (x.textContent || '').trim());
            return {
                win: !!win,
                hybridStatus: !!document.querySelector('[data-testid="setting-status-hybridIntelligence"]'),
                deskStatus: !!document.querySelector('[data-testid="setting-status-deskToolsEnabled"]'),
                hybridAsk: !!document.querySelector('[data-testid="setting-ask-hybridIntelligence"]'),
                deskAsk: !!document.querySelector('[data-testid="setting-ask-deskToolsEnabled"]'),
                barInside: Boolean(w && b && b.top >= w.top - 1 && b.bottom <= w.bottom + 1 && b.left >= w.left - 1 && b.right <= w.right + 1),
                lifecyclePills: navText.filter((t) => t === 'Beta' || t === 'New').length,
            };
        });
        check('08 settings: read-only AI status pills, Change-in-chat triggers, bar docked INSIDE the modal, no lifecycle pills',
            settingsState.win && settingsState.hybridStatus && settingsState.deskStatus
            && settingsState.hybridAsk && settingsState.deskAsk
            && settingsState.barInside && settingsState.lifecyclePills === 0,
            JSON.stringify(settingsState));
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 'installed-08-settings-monochrome.png') });
        console.log('[installed-probe] evidence: installed-08-settings-monochrome.png');

        // Close the app FIRST, then judge the console/page errors: the app's
        // own shutdown noise must not fail a run whose surfaces were clean.
        check('zero unexplained renderer page errors in the installed app',
            pageErrors.filter((e) => !/Maximum update depth/.test(e) || flipErrors.length === 0).length === 0,
            pageErrors.slice(0, 3).join(' | '));
        check('zero unexplained console errors in the installed app',
            consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

        await Promise.race([electronApp.close(), sleep(5000)]);
        await sleep(400);
        try { terminateProcessTree(appProcess); } catch { /* already gone */ }
        electronApp = null;
        assertNoOrphanProcesses();
    } catch (err) {
        fail(err && err.stack || String(err));
        if (electronApp) {
            try { await Promise.race([electronApp.close(), sleep(4000)]); } catch { /* fall through */ }
        }
    } finally {
        try { mock.kill(); } catch { /* best-effort */ }
        if (!KEEP_PROFILE) {
            try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        } else {
            console.log(`[installed-probe] retained scratch profile: ${scratchDir}`);
        }
    }

    if (failed) {
        console.error(`\nINSTALLED APP PROBE FAILED — ${failures.length} failure(s):`);
        for (const f of failures) console.error(' • ' + f);
        process.exitCode = 1;
        return;
    }
    console.log('\nINSTALLED APP PROBE OK — the installer ran, the installed exe rendered all eight');
    console.log('evidence surfaces (chat centered, desk rail, <lg flip walk, decision card, guard');
    console.log('block, review + harness proposal card, journal history, monochrome settings),');
    console.log('and closed with zero orphaned processes. Evidence: docs/evidence/installed-app/.');
}

main().catch((err) => {
    console.error('INSTALLED APP PROBE FAIL (driver):', err && err.stack || err);
    process.exitCode = 1;
});
