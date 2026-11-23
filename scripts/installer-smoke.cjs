/**
 * installer-smoke — verify the PACKAGED Electron app boots and renders the
 * production Analyze surface + expanded Chart AI dock.
 *
 * This probe intentionally drives the real packaged executable through
 * Playwright's Electron API. A renderer-only Vite preview cannot catch failures
 * in the packaged main process, the app:// protocol, the sandboxed preload
 * bridge, safeStorage, or the packaged provider/update IPC paths.
 *
 * Usage:
 *   # Reuse an existing unpacked executable, or build it if it is missing:
 *   node scripts/installer-smoke.cjs
 *
 *   # Explicitly select an executable (paths are resolved from the repo root):
 *   INSTALLER_SMOKE_EXECUTABLE=dist_electron/win-unpacked/"August Trading.exe" \
 *       node scripts/installer-smoke.cjs
 *
 *   # Force a rebuild or skip building when an executable is already present:
 *   INSTALLER_SMOKE_REBUILD=1 node scripts/installer-smoke.cjs
 *   INSTALLER_SMOKE_SKIP_BUILD=1 node scripts/installer-smoke.cjs
 *
 * Environment:
 *   INSTALLER_SMOKE_TIMEOUT_MS       Probe wait timeout (default: 120000)
 *   INSTALLER_SMOKE_BUILD_TIMEOUT_MS Build timeout (default: 600000)
 *   INSTALLER_SMOKE_KEEP_PROFILE=1   Retain the scratch user-data directory
 *
 * The launcher strips credentials and provider tokens from the child
 * environment, isolates userData, disables updater/provider work, blocks
 * external renderer traffic, and exits non-zero on any verification failure.
 */

const { spawn, spawnSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_PARENT = path.join(os.tmpdir(), 'august-smoke');
const APP_PRODUCT = 'August Trading';
const APP_PROTOCOL_URL = 'app://./index.html';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_BUILD_TIMEOUT_MS = 600000;
const LAUNCH_TIMEOUT_MS = 30000;
const LIVE_SAMPLE_MS = 3000;

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
    /^WebSocket connection to '(?:wss?|https?):\/\/[^']+'.* failed:/i,
    /^Failed to fetch futures ticker for /i,
];

let failed = false;
let scratchDir = null;
let exePath = null;
let electronApp = null;
let appProcess = null;
let appExited = false;
let appExitCode = null;
let appExitSignal = null;
const failures = [];
const pageErrors = [];
const consoleErrors = [];
const mainConsoleErrors = [];
const blockedRequests = [];
const appResourceFailures = [];
const attachedPages = new WeakSet();
let appOutput = '';

function fail(msg, err) {
    failed = true;
    failures.push(err ? `${msg}: ${err.stack || err}` : msg);
    console.error(`INSTALLER SMOKE FAIL: ${msg}`, err ? err.stack || err : '');
}

function parseTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const PROBE_TIMEOUT_MS = parseTimeout(process.env.INSTALLER_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const BUILD_TIMEOUT_MS = parseTimeout(process.env.INSTALLER_SMOKE_BUILD_TIMEOUT_MS, DEFAULT_BUILD_TIMEOUT_MS);
const KEEP_PROFILE = process.env.INSTALLER_SMOKE_KEEP_PROFILE === '1';
const SKIP_BUILD = process.env.INSTALLER_SMOKE_SKIP_BUILD === '1';
const REBUILD = process.env.INSTALLER_SMOKE_REBUILD === '1';

function isBenignConsoleError(text) {
    return BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeEnv(source = process.env) {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (SENSITIVE_ENV_KEY.test(key) || PROXY_ENV_KEY.test(key) || FORBIDDEN_ENV_KEY.test(key)) {
            continue;
        }
        result[key] = String(value);
    }
    result.AUGUST_SMOKE_TEST = '1';
    result.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
    return result;
}

function samePath(left, right) {
    const normalize = (value) => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

function findExePath() {
    const candidates = [
        path.join(ROOT, 'dist_electron', 'win-unpacked', `${APP_PRODUCT}.exe`),
        path.join(ROOT, 'dist_electron', `${APP_PRODUCT}.exe`),
        path.join(ROOT, 'dist_electron', 'win-unpacked', 'AugustTrading.exe'),
        path.join(ROOT, 'dist_electron', 'AugustTrading.exe'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // electron-builder normally uses the product name, but a case or naming
    // variation should still be discoverable without guessing an installer.
    const unpackedDir = path.join(ROOT, 'dist_electron', 'win-unpacked');
    if (fs.existsSync(unpackedDir)) {
        for (const entry of fs.readdirSync(unpackedDir)) {
            if (entry.toLowerCase().endsWith('.exe')) return path.join(unpackedDir, entry);
        }
    }
    return null;
}

function resolveExePath() {
    const override = process.env.INSTALLER_SMOKE_EXECUTABLE || process.env.AUGUST_SMOKE_APP;
    if (override) {
        const resolved = path.resolve(ROOT, override);
        if (fs.existsSync(resolved)) return resolved;
        throw new Error(`Installer smoke executable override does not exist: ${resolved}`);
    }

    const resolved = findExePath();
    if (!resolved) {
        throw new Error(
            'No packaged executable found. Looked at: ' +
            `${path.join(ROOT, 'dist_electron', 'win-unpacked', `${APP_PRODUCT}.exe`)}, ` +
            `${path.join(ROOT, 'dist_electron', 'win-unpacked', 'AugustTrading.exe')}. ` +
            'Build with `electron-builder --dir --win` or set INSTALLER_SMOKE_EXECUTABLE.'
        );
    }
    return resolved;
}

function terminateProcessTree(child) {
    if (!child || child.pid === undefined) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch { /* best-effort cleanup */ }
        return;
    }
    try { child.kill('SIGTERM'); } catch { /* best-effort cleanup */ }
}

function runCommand(command, args, options) {
    const { timeoutMs, env, cwd } = options;
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let settled = false;
        let output = '';
        const appendOutput = (chunk) => {
            const text = String(chunk);
            output = (output + text).slice(-20000);
            process.stdout.write(text);
        };
        child.stdout.on('data', appendOutput);
        child.stderr.on('data', appendOutput);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateProcessTree(child);
            reject(new Error(`${command} timed out after ${timeoutMs}ms\n${output}`));
        }, timeoutMs);
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code=${code} signal=${signal}\n${output}`));
        });
    });
}

async function buildExe() {
    const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
    if (!fs.existsSync(builderCli)) {
        throw new Error(`electron-builder CLI not found at ${builderCli}; run npm ci first`);
    }
    console.log('[smoke] building unpacked Electron app (electron-builder --dir --win)…');
    await runCommand(process.execPath, [builderCli, '--dir', '--win'], {
        timeoutMs: BUILD_TIMEOUT_MS,
        env: {
            ...sanitizeEnv(),
            CSC_IDENTITY_AUTO_DISCOVERY: 'false',
            npm_config_offline: 'true',
        },
        cwd: ROOT,
    });
}

function attachPage(page) {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    page.on('pageerror', (err) => {
        pageErrors.push(String(err && err.stack || err));
    });
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!isBenignConsoleError(text)) consoleErrors.push(text);
    });
}

async function seedProfile(page) {
    // Navigate to a tiny app:// resource first. This gives the probe a clean
    // document in the packaged origin before seeding storage and IndexedDB.
    await page.goto('app://./favicon.ico', { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
    await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('last_active_user', 'Probe User');
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');

        const openProfileDb = () => new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('userProfiles')) {
                    request.result.createObjectStore('userProfiles', { keyPath: 'username' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        let db = await openProfileDb();
        try {
            if (!db.objectStoreNames.contains('userProfiles')) {
                // Electron's IndexedDB migration can win the race and create an
                // empty v1 database before this probe opens it. With no version
                // change, onupgradeneeded will not fire to add the store. Close
                // and remove that empty shell, then reopen through the upgrade.
                db.close();
                await new Promise((resolve, reject) => {
                    const request = indexedDB.deleteDatabase('FuturesAI-DB');
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => { /* the app's migration closes shortly */ };
                });
                db = await openProfileDb();
            }
            if (!db.objectStoreNames.contains('userProfiles')) {
                throw new Error('FuturesAI-DB is missing the userProfiles store after repair');
            }
            const transaction = db.transaction('userProfiles', 'readwrite');
            transaction.objectStore('userProfiles').put({
                username: 'Probe User',
                conversations: [],
                tradeLog: [],
                tradeSummaries: [],
                finalTradeSummary: null,
                settings: {
                    activeFrameworks: [],
                    summaryCharLimit: 4000,
                    summarizationProvider: '',
                    summarizationModel: '',
                    visionModel: '',
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
                    memoryProvider: '',
                    memoryModel: '',
                },
            });
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error || new Error('Profile seed transaction aborted'));
            });
        } finally {
            db.close();
        }
    });
}

async function verifyMainProcess(expectedVersion, expectedUserData) {
    const mainInfo = await electronApp.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        userData: app.getPath('userData'),
        version: app.getVersion(),
    }));
    if (!mainInfo.isPackaged) throw new Error(`Expected packaged mode, got isPackaged=${mainInfo.isPackaged}`);
    if (!samePath(mainInfo.userData, expectedUserData)) {
        throw new Error(`Expected isolated userData ${expectedUserData}, got ${mainInfo.userData}`);
    }
    if (String(mainInfo.version) !== String(expectedVersion)) {
        throw new Error(`Expected app version ${expectedVersion}, got ${mainInfo.version}`);
    }
    console.log(`[smoke] main process verified: packaged=true version=${mainInfo.version} userData=${mainInfo.userData}`);
}

async function verifyRenderer(page, expectedVersion) {
    const rendererInfo = await page.evaluate(async () => ({
        isElectron: window.electronAPI?.isElectron === true,
        protocol: document.location.protocol,
        version: typeof window.electronAPI?.getVersion === 'function'
            ? await window.electronAPI.getVersion()
            : null,
    }));
    if (!rendererInfo.isElectron) throw new Error('Renderer bridge is missing or window.electronAPI.isElectron is not true');
    if (rendererInfo.protocol !== 'app:') throw new Error(`Expected app: renderer protocol, got ${rendererInfo.protocol}`);
    if (String(rendererInfo.version) !== String(expectedVersion)) {
        throw new Error(`Expected renderer app version ${expectedVersion}, got ${rendererInfo.version}`);
    }
    console.log(`[smoke] renderer verified: electron=true protocol=${rendererInfo.protocol} version=${rendererInfo.version}`);
}

async function verifyTradeSurface(page) {
    await page.locator('#splash').waitFor({ state: 'detached', timeout: PROBE_TIMEOUT_MS });
    await page.getByRole('dialog', { name: /User profile selection/i }).waitFor({ state: 'detached', timeout: PROBE_TIMEOUT_MS });

    const trade = page.getByTestId('trade-view');
    const chartPane = page.getByTestId('trade-chart-pane');
    const dock = page.getByTestId('trade-dock');
    const panel = page.getByTestId('trade-chat-panel');
    await trade.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    await chartPane.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    await dock.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    await panel.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    // The dock's identity: since the STOP-2 dual-view redesign (582cbf98) the
    // header carries the CONVERSATION TITLE (no Chat/Coach tablist, no static
    // "Chart AI" label — both locators timed out on every packaged run after
    // it). The one affordance every dock shape has carried is the COMPOSER —
    // `composer-input`, disabled or not (this smoke seeds no provider, so the
    // placeholder reads "Configure a provider…" and a placeholder locator
    // would miss it).
    const dockIdentity = panel.getByTestId('composer-input').first();
    await dockIdentity.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    console.log('[smoke] Analyze surface and expanded Chart AI dock are visible');

    // Re-sample after a bounded pause so a post-mount TDZ/abort crash cannot
    // pass as a successful boot merely because the first paint was complete.
    await new Promise((resolve) => setTimeout(resolve, LIVE_SAMPLE_MS));
    const checks = await Promise.all([
        trade.isVisible(),
        chartPane.isVisible(),
        dock.isVisible(),
        panel.isVisible(),
        dockIdentity.isVisible(),
    ]);
    if (checks.some((visible) => !visible)) {
        throw new Error(`Analyze surface disappeared on liveness re-sample: ${JSON.stringify(checks)}`);
    }
}

async function closeElectronApp() {
    if (!electronApp) return;
    const app = electronApp;
    electronApp = null;
    try {
        await Promise.race([
            app.close(),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    } catch { /* fall through to process-tree cleanup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const child = appProcess || (app.process && app.process());
    if (child && child.pid !== undefined && child.exitCode === null) {
        terminateProcessTree(child);
    }
}

async function cleanup() {
    if (!KEEP_PROFILE && scratchDir) {
        try {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        } catch { /* best-effort cleanup */ }
        scratchDir = null;
    } else if (scratchDir) {
        console.log(`[smoke] retained scratch profile: ${scratchDir}`);
    }
}

async function runProbe() {
    fs.mkdirSync(SCRATCH_PARENT, { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(SCRATCH_PARENT, `august-smoke-${process.pid}-`));
    console.log(`[smoke] scratch user-data: ${scratchDir}`);

    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const expectedVersion = String(packageJson.version);
    const override = process.env.INSTALLER_SMOKE_EXECUTABLE || process.env.AUGUST_SMOKE_APP;
    const existingExe = override ? resolveExePath() : findExePath();
    if (REBUILD || !existingExe) {
        if (SKIP_BUILD && !existingExe) throw new Error('INSTALLER_SMOKE_SKIP_BUILD=1 but no packaged executable is available');
        await buildExe();
    }
    exePath = resolveExePath();
    console.log(`[smoke] exe: ${exePath}`);

    const launchEnv = sanitizeEnv();
    const launchArgs = [
        `--user-data-dir=${scratchDir}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--metrics-recording-only',
        '--disable-gpu',
    ];
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
        launchArgs.push('--no-sandbox');
    }

    console.log('[smoke] launching packaged Electron app with Playwright…');
    electronApp = await electron.launch({
        executablePath: exePath,
        args: launchArgs,
        cwd: ROOT,
        env: launchEnv,
        timeout: LAUNCH_TIMEOUT_MS,
    });
    appProcess = electronApp.process();
    appProcess.once('exit', (code, signal) => {
        appExited = true;
        appExitCode = code;
        appExitSignal = signal;
    });
    electronApp.on('window', attachPage);
    electronApp.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!isBenignConsoleError(text)) mainConsoleErrors.push(text);
    });
    appProcess.stdout.on('data', (chunk) => {
        appOutput = (appOutput + String(chunk)).slice(-20000);
    });
    appProcess.stderr.on('data', (chunk) => {
        appOutput = (appOutput + String(chunk)).slice(-20000);
    });

    await verifyMainProcess(expectedVersion, scratchDir);

    const context = electronApp.context();
    context.setDefaultTimeout(PROBE_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(PROBE_TIMEOUT_MS);
    await context.setOffline(true);
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (/^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url)) {
            blockedRequests.push(url);
            await route.abort();
            return;
        }
        await route.continue();
    });

    const page = await electronApp.firstWindow({ timeout: PROBE_TIMEOUT_MS });
    attachPage(page);
    page.setDefaultTimeout(PROBE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PROBE_TIMEOUT_MS);
    // Exercise the documented desktop Trade layout. GitHub-hosted Electron
    // windows can default below the lg breakpoint, where the dock is
    // intentionally hidden unless the user selects the AI mode.
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.waitForLoadState('load');
    await seedProfile(page);
    // Observe the seeded navigation without counting requests cancelled by seeding.
    page.on('requestfailed', (request) => {
        if (request.url().startsWith('app://')) {
            appResourceFailures.push(`${request.url()} → ${request.failure()?.errorText || 'unknown error'}`);
        }
    });
    page.on('response', (response) => {
        if (response.url().startsWith('app://') && response.status() >= 400) {
            appResourceFailures.push(`${response.url()} → HTTP ${response.status()}`);
        }
    });
    await page.goto(APP_PROTOCOL_URL, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
    console.log('[smoke] profile seeded and packaged renderer loaded');

    await verifyRenderer(page, expectedVersion);
    await verifyTradeSurface(page);

    if (pageErrors.length > 0) {
        throw new Error(`${pageErrors.length} renderer pageerror(s) during packaged boot`);
    }
    if (consoleErrors.length > 0) {
        throw new Error(`${consoleErrors.length} unexpected renderer console.error message(s) during packaged boot`);
    }
    if (mainConsoleErrors.length > 0) {
        throw new Error(`${mainConsoleErrors.length} unexpected main-process console.error message(s)`);
    }
    if (/App threw an error during load|Uncaught Exception:|UnhandledPromiseRejection(?:Warning|:)/i.test(appOutput)) {
        throw new Error('Main-process fatal banner in packaged app output');
    }
    if (appResourceFailures.length > 0) {
        throw new Error(`Packaged resource failures: ${appResourceFailures.join('; ')}`);
    }
    if (blockedRequests.length > 0) {
        console.log(`[smoke] blocked ${blockedRequests.length} external renderer request attempt(s); no request was allowed through`);
    }
    if (appExited || appProcess.exitCode !== null || appProcess.signalCode !== null) {
        throw new Error(`Packaged Electron exited unexpectedly (code=${appExitCode} signal=${appExitSignal})`);
    }

    console.log('INSTALLER SMOKE OK — packaged Electron boots, Analyze surface + Chart AI dock render, zero pageerrors.');
}

async function main() {
    let exitCode = 0;
    try {
        await runProbe();
    } catch (err) {
        exitCode = 1;
        fail(err.message || String(err), err);
    } finally {
        try {
            await closeElectronApp();
        } catch (err) {
            exitCode = 1;
            fail('Electron cleanup failed', err);
        }
        try {
            await cleanup();
        } catch (err) {
            exitCode = 1;
            fail('Profile cleanup failed', err);
        }
    }

    if (exitCode !== 0 || failed) {
        if (pageErrors.length > 0) {
            console.error('--- renderer pageerrors ---');
            for (const error of pageErrors) console.error(error);
        }
        if (consoleErrors.length > 0) {
            console.error('--- unexpected console errors ---');
            for (const error of consoleErrors) console.error(error);
        }
        if (blockedRequests.length > 0) {
            console.error('--- blocked external requests ---');
            for (const url of blockedRequests.slice(0, 20)) console.error(url);
        }
        if (mainConsoleErrors.length > 0) {
            console.error('--- unexpected main-process console errors ---');
            for (const error of mainConsoleErrors) console.error(error);
        }
        if (appOutput) {
            console.error('--- packaged app output (tail) ---');
            console.error(appOutput);
        }
        console.error(`INSTALLER SMOKE FAILED (${failures.length} failure(s))`);
        process.exitCode = 1;
        return;
    }
    process.exitCode = 0;
}

main().catch((err) => {
    console.error('INSTALLER SMOKE FAILED (driver):', err);
    process.exitCode = 1;
});
