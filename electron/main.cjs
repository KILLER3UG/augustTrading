const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const { resolveRepoPath } = require('../shared/repoSandbox.cjs');
const { createSseParser } = require('./sseParser.cjs');

// ── REPO BRIDGE (dev only) ──────────────────────────────────────────────────
// The model may read and edit THIS checkout when the app runs from source and
// the owner names it with AUGUSTTRADING_REPO. A packaged build has no dev
// server to apply edits, so it reports the tool as unavailable rather than
// pretending. Every path goes through shared/repoSandbox.cjs; every write
// leaves a copy under .august-checkpoints and names its path in the receipt,
// so a human can put the bytes back by hand. The app writes those copies and
// has no restore path — it does not promise an undo it has not built.
const AUGUSTTRADING_REPO = process.env.AUGUSTTRADING_REPO
    ? path.resolve(process.env.AUGUSTTRADING_REPO)
    : null;
const AUGUSTTRADING_CLONE_URL = process.env.AUGUSTTRADING_CLONE_URL
    ? String(process.env.AUGUSTTRADING_CLONE_URL).trim()
    : '';
// The active checkout: the owner's env path in dev, or the self-hosted clone
// the app installs for itself on first use (userData/harness-src). Mutable
// because setupSession() switches it at runtime and the window reloads onto
// the build that checkout produces.
let activeRepoRoot = AUGUSTTRADING_REPO;
const repoReady = () => Boolean(activeRepoRoot);
const REPO_READ_CAP = 200 * 1024;
const REPO_LIST_CAP = 200;
const bundledDist = path.resolve(__dirname, '../dist');
/** The build the window serves: the checkout's dist when it has one, else the
 *  installer's own. Resolved per request so a completed setup/apply needs only
 *  a reload, not a re-registration of the app:// protocol. */
const persistedRoot = () => {
    try {
        const p = path.join(app.getPath('userData'), 'harness-src');
        return fs.existsSync(path.join(p, 'package.json')) ? p : null;
    } catch { return null; }
};
const currentRepoRoot = () => activeRepoRoot || persistedRoot();
const repoDist = () => {
    const root = currentRepoRoot();
    if (!root) return bundledDist;
    const dist = path.join(root, 'dist');
    return fs.existsSync(path.join(dist, 'index.html')) ? dist : bundledDist;
};

/** Run one command in the checkout, resolving with the tail of its output. */
const runInRepo = (cmd, args, timeoutMs = 300_000, cwd = activeRepoRoot) => new Promise((resolve) => {
    const child = spawn(cmd, args, {
        cwd,
        shell: process.platform === 'win32' && /\.cmd$/i.test(cmd),
        windowsHide: true,
    });
    let output = '';
    const take = (chunk) => { output = `${output}${chunk.toString()}`.slice(-8000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message, output }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: output.trim() }); });
});
const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function setupRepoBridge() {
    // A self-hosted checkout installed by a previous session stays active.
    if (!activeRepoRoot) activeRepoRoot = persistedRoot();
    const refused = { ok: false, error: 'Refused — the request did not come from the app window.' };
    const unavailable = { ok: false, error: 'no checkout is active: in dev set AUGUSTTRADING_REPO; in the installed app run repo_setup once (owner sets AUGUSTTRADING_CLONE_URL)' };

    trustedHandle('repo:info', () => {
        if (!activeRepoRoot) {
            return {
                ok: true, available: false, mode: 'bundled',
                reason: app.isPackaged
                    ? 'no self-hosted checkout yet — run repo_setup once (AUGUSTTRADING_CLONE_URL must be set)'
                    : 'AUGUSTTRADING_REPO is not set',
                cloneUrlConfigured: Boolean(AUGUSTTRADING_CLONE_URL),
            };
        }
        return {
            ok: true, available: true, root: activeRepoRoot,
            mode: app.isPackaged ? 'self-hosted' : 'dev',
            serving: repoDist() === bundledDist ? 'bundled' : 'checkout',
        };
    }, refused);

    trustedHandle('repo:list', (_event, rel) => {
        if (!repoReady()) return unavailable;
        const atRoot = rel == null || rel === '' || rel === '.' || rel === '/';
        const r = atRoot ? { ok: true, abs: activeRepoRoot, rel: '' } : resolveRepoPath(activeRepoRoot, rel);
        if (!r.ok) return r;
        try {
            const entries = fs.readdirSync(r.abs, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.env'))
                .slice(0, REPO_LIST_CAP)
                .map(e => ({ path: `${r.rel ? `${r.rel}/` : ''}${e.name}`, dir: e.isDirectory() }));
            return { ok: true, path: r.rel, entries };
        } catch (err) {
            return { ok: false, error: `list failed: ${err.message}` };
        }
    }, refused);

    trustedHandle('repo:read', (_event, rel) => {
        if (!repoReady()) return unavailable;
        const r = resolveRepoPath(activeRepoRoot, rel);
        if (!r.ok) return r;
        try {
            if (fs.statSync(r.abs).size > REPO_READ_CAP) return { ok: false, error: 'file is larger than 200 KB' };
            return { ok: true, path: r.rel, content: fs.readFileSync(r.abs, 'utf8') };
        } catch (err) {
            return { ok: false, error: `read failed: ${err.message}` };
        }
    }, refused);

    trustedHandle('repo:write', (_event, rel, content) => {
        if (!repoReady()) return unavailable;
        const r = resolveRepoPath(activeRepoRoot, rel);
        if (!r.ok) return r;
        const text = typeof content === 'string' ? content : '';
        if (Buffer.byteLength(text, 'utf8') > REPO_READ_CAP) return { ok: false, error: 'content is larger than 200 KB' };
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const checkpoint = path.join(activeRepoRoot, '.august-checkpoints', stamp, r.rel);
            fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
            if (fs.existsSync(r.abs)) fs.copyFileSync(r.abs, checkpoint);
            fs.mkdirSync(path.dirname(r.abs), { recursive: true });
            const tmp = `${r.abs}.august-tmp`;
            fs.writeFileSync(tmp, text, 'utf8');
            fs.renameSync(tmp, r.abs);
            return { ok: true, path: r.rel, checkpoint: path.relative(activeRepoRoot, checkpoint).replace(/\\/g, '/') };
        } catch (err) {
            return { ok: false, error: `write failed: ${err.message}` };
        }
    }, refused);

    // Dev: the Vite server already applied the save, so apply is the typecheck
    // gate. Installed self-host: the window serves the checkout's dist, so
    // apply must BUILD, then reload onto the bytes it just produced. A failed
    // build changes nothing — the previous dist keeps serving.
    trustedHandle('repo:apply', async () => {
        if (!repoReady()) return unavailable;
        const script = app.isPackaged ? 'build' : 'typecheck';
        const res = await runInRepo(npmCmd(), ['run', script], 300_000);
        if (!res.ok) return res;
        if (app.isPackaged && mainWindow) {
            try { mainWindow.reload(); } catch { /* window may be gone */ }
        }
        return { ...res, script, applied: app.isPackaged ? 'built and reloaded' : 'typechecked; the dev server already applied the save' };
    }, refused);

    // First-run self-host (the Hermes shape): clone the OWNER-CONFIGURED repo
    // into userData, install, build, and switch the window onto that build.
    // No model-supplied URL: the tool takes no arguments, so a seat cannot
    // point the installer at an arbitrary repository.
    const setupSelfHosted = async () => {
        if (!app.isPackaged) {
            return { ok: false, error: 'repo_setup is for the installed app; in dev point AUGUSTTRADING_REPO at your checkout' };
        }
        if (!AUGUSTTRADING_CLONE_URL) {
            return { ok: false, error: 'AUGUSTTRADING_CLONE_URL is not set on this machine — the owner must name the repository to clone' };
        }
        const target = path.join(app.getPath('userData'), 'harness-src');
        if (!fs.existsSync(path.join(target, 'package.json'))) {
            // The clone runs from the PARENT: its target does not exist yet, and
            // spawn with a missing cwd fails before git is ever reached.
            activeRepoRoot = target;
            const clone = await runInRepo(
                'git', ['clone', '--depth', '1', AUGUSTTRADING_CLONE_URL, target],
                600_000, app.getPath('userData'),
            );
            if (!clone.ok) { activeRepoRoot = null; return { ...clone, step: 'clone' }; }
        }
        activeRepoRoot = target;
        const install = await runInRepo(npmCmd(), ['install', '--no-audit', '--no-fund'], 900_000);
        if (!install.ok) return { ...install, step: 'install', root: target };
        const build = await runInRepo(npmCmd(), ['run', 'build'], 600_000);
        if (!build.ok) return { ...build, step: 'build', root: target };
        if (mainWindow) { try { mainWindow.reload(); } catch { /* window may be gone */ } }
        return {
            ok: true, root: target, step: 'done',
            note: 'Self-hosted checkout installed and built; the window now serves that build. The repo tools edit this checkout, not the installer bundle.',
        };
    };
    // One setup at a time: the boot auto-start and a model call must never run
    // two installs into the same target.
    let setupRunning = false;
    const runSetupOnce = async () => {
        if (setupRunning) return { ok: false, error: 'self-host setup is already running' };
        setupRunning = true;
        try { return await setupSelfHosted(); } finally { setupRunning = false; }
    };
    trustedHandle('repo:setup', () => runSetupOnce(), refused);

    // Installed app + owner-configured clone URL + no checkout yet: install
    // the self-hosted build in the background. The bundled app keeps running
    // until the build lands, then the window reloads onto it.
    if (app.isPackaged && !activeRepoRoot && AUGUSTTRADING_CLONE_URL) {
        setTimeout(() => {
            void runSetupOnce().then((r) => {
                if (!r.ok) console.error(`[selfhost] setup failed at ${r.step || 'start'}: ${r.error || r.output || 'unknown error'}`);
            });
        }, 4000);
    }
}
// Shared provider wire-request policy — the SAME module the renderer and the
// vite dev proxy use (thinking gate + effort-scaled budget + messages
// temperature, Gemini thinking params, HTTPS/private-LAN URL host rules).
// Desktop used to carry drifted inline copies (stale Claude regex missing
// sonnet-5/opus-5, fixed 0.35 budget, localhost-only HTTP rule); they are all
// deleted and every decision now comes from this require.
const policy = require('../shared/providerRequestPolicy.cjs');

const isDev = !app.isPackaged;
const isInstallerSmoke = process.env.AUGUST_SMOKE_TEST === '1';

if (isInstallerSmoke) {
    // The smoke probe must exercise the packaged renderer without contacting
    // providers, market-data APIs, or the update service.
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-component-update');
    app.commandLine.appendSwitch('metrics-recording-only');
}

function blockSmokeNetwork() {
    if (!isInstallerSmoke) return;
    // Defense in depth: the probe also sets the renderer offline and aborts
    // external routes, while this main-session guard catches Electron/net.fetch
    // traffic (including accidental provider or updater calls).
    session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
        (_details, callback) => callback({ cancel: true })
    );
}

// =============================================================================
// USERDATA PATH PRESERVATION (rename chain: "August 3.5" → "August Trading" →
// "August Trading Harness" → "August Trading")
// =============================================================================
// Electron derives %APPDATA%/<productName> from package.json's build
// productName. The rename would otherwise strand every existing user's
// data (safeStorage-encrypted provider keys, SQLite/IndexedDB journals,
// preferences) in the old folder. Before anything else touches userData,
// carry the old folder's contents across exactly once, then mark it
// migrated so later boots never re-copy.

// Newest first: if both old folders exist, the newer one's files win and the
// older migration only fills gaps the new install does not already have.
const LEGACY_PRODUCT_NAMES = ['August Trading Harness', 'August Trading', 'August 3.5'];
const MIGRATION_STAMP = '.migrated-to-august-trading';

const preserveLegacyUserData = () => {
    try {
        if (isInstallerSmoke) return; // never migrate or inspect real user data
        // DEV GUARD (crosscheck §5): dev userData is named after the package
        // name, NOT the productName, so the basename check below never fires
        // while running `npm run electron:dev` — a dev boot on a machine with
        // legacy production data used to fs.renameSync the user's real
        // keys/journal INTO the dev folder and stamp it migrated, stranding it
        // from the packaged app. Only the packaged app may migrate.
        if (!app.isPackaged) return;
        const current = app.getPath('userData');
        const currentName = path.basename(current);
        for (const legacyName of LEGACY_PRODUCT_NAMES) {
            if (legacyName === currentName) continue; // still on a legacy name: nothing to carry over
            const legacy = path.join(path.dirname(current), legacyName);
            if (!fs.existsSync(legacy)) continue; // that name never ran on this machine
            const stamp = path.join(legacy, MIGRATION_STAMP);
            if (fs.existsSync(stamp)) continue; // one-time migration already done
            fs.mkdirSync(current, { recursive: true });
            for (const entry of fs.readdirSync(legacy)) {
                const from = path.join(legacy, entry);
                const to = path.join(current, entry);
                if (fs.existsSync(to)) continue; // never clobber files the new install already wrote
                try { fs.renameSync(from, to); } catch {
                    try { fs.cpSync(from, to, { recursive: true }); } catch { /* skip unreadable entry */ }
                }
            }
            fs.writeFileSync(stamp, new Date().toISOString());
        }
    } catch { /* never let data migration break boot */ }
};

preserveLegacyUserData();

// =============================================================================
// WINDOW-STATE PERSISTENCE
// =============================================================================

// Restore the window size/position across restarts. Bounds are saved to a
// small JSON file in userData on close and validated on load (a position on a
// disconnected monitor is discarded so the window never opens off-screen).
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_BOUNDS = { width: 1200, height: 800 };

function loadWindowState() {
    try {
        const raw = fs.readFileSync(windowStateFile(), 'utf-8');
        const state = JSON.parse(raw);
        const bounds = {
            width: typeof state.width === 'number' && state.width >= 800 ? state.width : DEFAULT_BOUNDS.width,
            height: typeof state.height === 'number' && state.height >= 600 ? state.height : DEFAULT_BOUNDS.height,
            x: typeof state.x === 'number' ? state.x : undefined,
            y: typeof state.y === 'number' ? state.y : undefined,
        };
        // If a saved position doesn't intersect any display, drop it.
        if (state.x !== undefined && state.y !== undefined) {
            const visible = require('electron').screen.getAllDisplays().some(d => {
                const a = d.workArea;
                return state.x >= a.x - bounds.width + 80 && state.x <= a.x + a.width - 80
                    && state.y >= a.y - 20 && state.y <= a.y + a.height - 60;
            });
            if (!visible) {
                delete bounds.x;
                delete bounds.y;
            }
        }
        bounds.maximized = state.maximized === true;
        return bounds;
    } catch {
        return { ...DEFAULT_BOUNDS };
    }
}

function saveWindowState(win) {
    try {
        if (win.isDestroyed()) return;
        const bounds = win.getNormalBounds();
        fs.writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
    } catch {
        // best-effort — window-state persistence must never break shutdown
    }
}

// =============================================================================
// CUSTOM PROTOCOL (app://) — must be registered before app.ready
// =============================================================================
// Using a custom protocol instead of file:// gives the renderer a proper origin,
// which fixes CORS failures on <script type="module" crossorigin> tags that Vite
// emits in the production build. On file:// the origin is opaque ("null") and
// module script fetches fail silently, causing a white screen.
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
]);

let mainWindow = null;
const activeProviderRequests = new Map();

// =============================================================================
// IPC SENDER-FRAME TRUST — the ONE guard every privileged channel goes through
// =============================================================================
// The preload bridge (electron/preload.cjs) is exposed to WHATEVER document is
// loaded in the window, so "which frame asked" is the only thing that tells
// the app apart from something that merely looks like it. A remote iframe, a
// second window, or a devtools view all reach the same bridge.
//
// The trusted frame is the main window's MAIN frame and nothing else. The
// comparison is by frame OBJECT identity, not by origin — a same-origin
// iframe is a different frame object, so it is refused too.
//
// A refused call returns the SAME shape the handler returns on its own
// failure path, so the renderer's handling is identical for a trusted and an
// untrusted sender. The trusted path is untouched: the handler body is called
// exactly as before, with the same arguments.
const isTrustedSenderFrame = (event) => {
    if (!event || !mainWindow || mainWindow.isDestroyed()) return false;
    const frame = event.senderFrame;
    if (!frame) return false;
    const contents = mainWindow.webContents;
    if (!contents || !contents.mainFrame) return false;
    return frame === contents.mainFrame;
};

/**
 * Register an IPC handler behind the sender-frame guard.
 * `refuse` is what a refused call returns; every channel passes the value its
 * own handler already returns on failure (null for the crypto calls, false
 * for the boolean ones, {ok:false} for the provider ones), so the refusal is
 * indistinguishable from the handler's own error path to the renderer.
 */
const trustedHandle = (channel, handler, refuse) => {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSenderFrame(event)) {
            console.warn(`[main] refused IPC "${channel}" — the sender frame is not the app window`);
            return typeof refuse === 'function' ? refuse() : refuse;
        }
        return handler(event, ...args);
    });
};

// =============================================================================
// DESKTOP STORE — the file backend for stores that outgrew a browser budget
// =============================================================================

/**
 * On desktop every big store was renderer `localStorage`: Preferences only takes
 * its native branch on Capacitor, and Electron is not that. So chats, the
 * notebook, payloads, drafts and amendments shared one ~5 MiB origin budget while
 * the product ruling is "store everything, no cap". These three channels are the
 * destination: plain JSON files under `<userData>/store`, written atomically by
 * electron/storeFs.cjs (which owns the key/path safety, the backup and the size
 * ceiling — this file only transports).
 *
 * Every call returns `{ok, value?|error}` and NOTHING throws across the bridge: a
 * failed write must reach the renderer as a failure it can report, never as a
 * rejected promise a caller forgets to catch.
 */
const { createStore } = require('./storeFs.cjs');
let desktopStore = null;
const getDesktopStore = () => (desktopStore ??= createStore(path.join(app.getPath('userData'), 'store')));
const untrusted = { ok: false, error: 'untrusted sender' };
trustedHandle('store:read', (_event, key) => getDesktopStore().read(key), untrusted);
trustedHandle('store:write', (_event, key, value) => getDesktopStore().write(key, value), untrusted);
trustedHandle('store:remove', (_event, key) => getDesktopStore().remove(key), untrusted);
trustedHandle('store:location', () => getDesktopStore().location(), null);

// =============================================================================
// PROVIDER TRANSPORT — main-process requests avoid renderer CORS restrictions
// =============================================================================

/**
 * Validate + normalize a configured provider baseUrl. The rules live in
 * shared/providerRequestPolicy.cjs — the SAME module the renderer and the
 * vite dev proxy use. Desktop used to carry a third inline copy, and the
 * dev proxy a fourth that stripped only four endpoint path suffixes, so a
 * baseUrl pasted straight from a provider's docs normalized DIFFERENTLY per
 * transport (the same saved provider worked on one runtime and 404'd on the
 * other). The old desktop-only localhost HTTP rule also rejected saved LAN
 * setups (e.g. http://192.168.x:11434) that worked fine on web.
 */
const normalizeProviderUrl = (url) => policy.normalizeProviderUrl(url);

function getDiscoveryCandidateUrls(baseUrl, isGemini, apiKey) {
    if (isGemini) {
        return [`${baseUrl.replace(/\/+$/, '')}/models?key=${encodeURIComponent(apiKey)}`];
    }
    const urls = [`${baseUrl}/models`];
    if (baseUrl.endsWith('/v1')) {
        const withoutV1 = baseUrl.slice(0, -3);
        if (withoutV1) urls.push(`${withoutV1}/models`);
    } else {
        urls.push(`${baseUrl}/v1/models`);
    }
    if (policy.isLocalBaseUrl(baseUrl)) {
        urls.push(`${baseUrl.replace(/\/v1$/, '')}/api/tags`);
    }
    return [...new Set(urls)];
}

function discoverProviderDetails(config) {
    const baseUrl = normalizeProviderUrl(config?.baseUrl);
    const apiKey = String(config?.apiKey || '').trim();
    // Local model servers (Ollama / LM Studio) answer /models with no auth —
    // demanding a key here made desktop discovery reject exactly the hosts
    // that never have one. Remote providers still require a key.
    if (!apiKey && !policy.isLocalBaseUrl(config?.baseUrl)) {
        throw new Error('API key is required to discover models.');
    }
    const isGemini = config?.apiFormat === 'google' || /generativelanguage/i.test(baseUrl);
    const isAnthropic = config?.apiFormat === 'messages' && !isGemini;
    const urls = getDiscoveryCandidateUrls(baseUrl, isGemini, apiKey);
    const headers = {
        Accept: 'application/json',
    };
    if (isAnthropic) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else if (!isGemini && apiKey && apiKey !== 'not-needed') {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return { urls, headers };
}

// Wall-clock budget for one main-process provider request (headers OR body
// phase), matching the browser's stream budget (STREAM_TIMEOUT_MS 300s).
const PROVIDER_REQUEST_TIMEOUT_MS = 300000;

/**
 * net.fetch wrapper: redirect:'manual' + re-validation of EVERY Location hop
 * against the shared provider-URL policy (SSRF). net.fetch follows redirects
 * by default, so the HTTPS+host gate on the configured endpoint only ever
 * checked the INITIAL URL: a malicious/compromised provider could 302 the
 * main process (which has no CORS confinement) to internal or plain-HTTP
 * targets and the body still returned to the renderer.
 *
 * The hop-walking itself now lives in shared/providerRequestPolicy.cjs as
 * `fetchFollowingSafeRedirects`, because this policy is not desktop-only: the
 * vite dev proxy used a plain `fetch`, which follows redirects silently, so
 * the same request was checked against one hop policy on desktop and another
 * on localhost. The policy is shared; only the fetch implementation differs,
 * which is why the shared function takes it as a parameter.
 */
const fetchUpstream = (url, init) => policy.fetchFollowingSafeRedirects(net.fetch, url, init);

async function sendDiscoverRequest(config) {
    const { urls, headers } = discoverProviderDetails(config);
    let lastResult = { ok: false, status: 0, body: '' };
    let timedOut = false;

    for (const url of urls) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetchUpstream(url, {
                method: 'GET',
                headers,
                signal: controller.signal,
            });
            const body = await response.text();
            lastResult = { ok: response.ok, status: response.status, body };
            if (response.ok || response.status !== 404) {
                return lastResult;
            }
        } catch (error) {
            // Same rule as the renderer: one hanging endpoint must not cancel
            // the candidate chain it is being tried by.
            if (error?.name === 'AbortError') timedOut = true;
            lastResult = { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
        } finally {
            clearTimeout(timeout);
        }
    }
    if (timedOut) {
        throw new Error('Model discovery timed out — check the base URL.');
    }
    return lastResult;
}

// Streaming parity for the desktop chat dock: the renderer opts in per call
// (stream:true). jsonMode/jsonSchema calls stay buffered (they need the whole
// body to validate), and the google format's stream wire (JSON-array SSE) is
// not parsed here — those requests keep today's one-shot path.
const STREAMABLE_FORMATS = new Set(['chat_completions', 'messages', 'responses']);
function streamRequested(request) {
    return request?.stream === true
        && !request.jsonMode && !request.jsonSchema
        && STREAMABLE_FORMATS.has(request?.config?.apiFormat);
}

function providerRequestDetails(request) {
    const config = request?.config || {};
    const format = config.apiFormat;
    const baseUrl = normalizeProviderUrl(config.baseUrl);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const model = String(config.selectedModel || '').trim();
    if (!model) throw new Error('Choose a model before sending a provider request.');

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = String(config.apiKey || '').trim();
    let url;
    let body;

    if (format === 'chat_completions') {
        url = `${baseUrl}/chat/completions`;
        if (apiKey && apiKey !== 'not-needed') headers.Authorization = `Bearer ${apiKey}`;
        body = {
            model,
            messages,
            max_tokens: request.maxTokens ?? 4096,
            temperature: request.temperature ?? 0.7,
        };
        // Same reasoning-side-channel ask the renderer makes. It lived only
        // in the renderer, so the PACKAGED APP never sent it: the dock asks
        // THIS process to build the provider request, so the same seat
        // returned its thinking on the web and not on the desktop — the
        // Thinking row simply stayed empty, with no error to explain it.
        policy.requestReasoningSideChannel(config, body);
        if (request.jsonSchema && request.jsonSchema.schema) {
            // Pre-resolved by the renderer's jsonSchema capability class —
            // apply as-is; the degrade below is the safety net either way.
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: request.jsonSchema.name || 'august_json',
                    strict: false,
                    schema: request.jsonSchema.schema,
                },
            };
        } else if (request.jsonMode) body.response_format = { type: 'json_object' };
        if (Array.isArray(request.tools) && request.tools.length > 0) {
            body.tools = request.tools;
            body.tool_choice = request.toolChoice || 'auto';
        }
    } else if (format === 'messages') {
        url = `${baseUrl}/messages`;
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        const system = messages.find(message => message?.role === 'system');
        body = {
            model,
            max_tokens: request.maxTokens ?? 4096,
            messages: messages.filter(message => message?.role !== 'system').map(message => ({
                role: message.role,
                content: toAnthropicContent(message.content)
            })),
        };
        // Cache breakpoint on the stable system block (shared policy, O-58).
        if (system) body.system = policy.anthropicCachedSystem(contentToText(system.content));
        // Temperature + extended thinking come from the SHARED policy module
        // (identical to the renderer by construction): 0.7 default when no
        // thinking, thinking active → temperature omitted, effort-scaled
        // budget from request.reasoningEffort (the renderer now forwards the
        // composer tier over the bridge). The old inline copy had a stale
        // Claude regex (missed sonnet-5/opus-5), a fixed 0.35 budget, ignored
        // 'off', and only passed temperature when explicitly defined.
        const thinkingFields = policy.anthropicThinkingFields({
            modelId: model,
            displayName: String(config.name || ''),
            capabilityOverride: config.thinkingCapable,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            jsonMode: request.jsonMode,
            reasoningEffort: request.reasoningEffort,
        });
        if (typeof thinkingFields.temperature === 'number') body.temperature = thinkingFields.temperature;
        if (thinkingFields.thinking) body.thinking = thinkingFields.thinking;
    } else if (format === 'responses') {
        url = `${baseUrl}/responses`;
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        body = {
            model,
            input: messages.filter(message => message?.role !== 'system').map(message => ({
                role: message.role,
                content: typeof message.content === 'string'
                    ? message.content
                    : message.content.map(part => part.type === 'text'
                        ? { type: 'input_text', text: part.text }
                        : { type: 'input_image', image_url: part.image_url.url })
            })),
            ...(messages.find(message => message?.role === 'system') ? {
                instructions: contentToText(messages.find(message => message?.role === 'system').content)
            } : {}),
            max_output_tokens: request.maxTokens ?? 4096,
            temperature: request.temperature ?? 0.7,
        };
    } else if (format === 'google') {
        const geminiModel = model.replace(/^models\//, '');
        url = `${baseUrl}/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        if (apiKey) headers['x-goog-api-key'] = apiKey;
        const systemBits = [];
        const contents = [];
        for (const message of messages) {
            if (message?.role === 'system') {
                const text = contentToText(message.content);
                if (text) systemBits.push(text);
                continue;
            }
            const parts = toGeminiParts(message.content);
            if (parts.length === 0) continue;
            const role = message.role === 'assistant' || message.role === 'model' ? 'model' : 'user';
            const last = contents[contents.length - 1];
            if (last && last.role === role) last.parts.push(...parts);
            else contents.push({ role, parts });
        }
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: systemBits.join('\n\n') || ' ' }] });
            systemBits.length = 0;
        } else if (contents[0].role !== 'user') {
            contents.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
        }
        body = {
            contents,
            generationConfig: {
                temperature: request.temperature ?? 0.7,
                maxOutputTokens: request.maxTokens ?? 4096,
            },
        };
        if (systemBits.length > 0) body.systemInstruction = { parts: [{ text: systemBits.join('\n\n') }] };
        if (request.jsonMode) body.generationConfig.responseMimeType = 'application/json';
        // Canonical Gemini thinking decision (includeThoughts + budget, never
        // under JSON mode) from the shared policy module.
        //
        // The output cap is REQUIRED, not optional: Gemini bills thinking
        // tokens INSIDE maxOutputTokens, so a budget at or above the cap is a
        // hard 400. The renderer always passed it (utils/googleGeminiFormat.ts
        // passes the 4th arg); this call site did not, so the clamp never
        // engaged here. Executed against a mock enforcing the documented rule:
        // effort=high with the app's TASK_BUDGETS.analysis (8192) emitted
        // thinkingBudget=8192 == the cap → 400, and the moderator verdict
        // (max effort, 12288) emitted 16384 → 400. The default profile is
        // `quality`, so this was the DEFAULT desktop path for any Gemini
        // seat, not an edge case.
        const geminiThinking = policy.geminiThinkingParams(
            request.jsonMode,
            geminiModel,
            request.reasoningEffort,
            request.maxTokens || 4096,
        );
        if (geminiThinking) body.generationConfig.thinkingConfig = geminiThinking;
        else delete body.generationConfig.thinkingConfig;
    } else {
        throw new Error('Unknown provider API format.');
    }

    // Reasoning knob parity with the vite dev proxy (vite.config.ts): the
    // renderer translates the composer's effort tier into wire fields
    // (reasoningControls capability classes) and sends them as reasoningPatch;
    // merge them into whatever body shape the format built. Absent ⇒ no
    // change. Without this, desktop requests ran thinking-default gateways
    // (GLM/DeepSeek/xAI) in thinking mode even at off/low effort, while
    // localhost disabled it — the same prompt answered differently per
    // transport, and the empty-content collapse below turned that into a
    // false "streamed only reasoning" error.
    if (request.reasoningPatch && typeof request.reasoningPatch === 'object') {
        Object.assign(body, request.reasoningPatch);
    }

    // Stream opt-in AFTER the reasoning patch so a patch key can never be
    // silently overwritten. stream_options asks OpenAI-compatible servers for
    // the final usage chunk; servers that reject the knob are retried
    // buffered in sendProviderRequest (400/422 degrade).
    if (streamRequested(request)) {
        body.stream = true;
        if (format === 'chat_completions') body.stream_options = { include_usage: true };
    }

    return { url, headers, body };
}

function contentToText(content) {
    return typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : '');
}

function toGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return [];
    return content.map(part => {
        if (part?.type === 'text') return { text: part.text };
        const url = part?.image_url?.url || '';
        const commaIndex = url.indexOf(',');
        if (url.startsWith('data:') && commaIndex !== -1) {
            const header = url.slice(5, commaIndex);
            const mimeMatch = header.match(/^image\/(png|jpeg|jpg|webp|gif)\b/i);
            const mimeType = mimeMatch
                ? `image/${mimeMatch[1].toLowerCase() === 'jpg' ? 'jpeg' : mimeMatch[1].toLowerCase()}`
                : 'image/png';
            return { inlineData: { mimeType, data: url.slice(commaIndex + 1) } };
        }
        return url ? { text: `[image: ${url}]` } : { text: '' };
    }).filter(part => part.text || part.inlineData);
}

function parseGeminiResponseJs(data) {
    const texts = [];
    const thoughts = [];
    const candidates = data?.candidates;
    if (Array.isArray(candidates)) {
        for (const candidate of candidates) {
            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
                if (typeof part?.text !== 'string' || !part.text) continue;
                if (part.thought) thoughts.push(part.text);
                else texts.push(part.text);
            }
        }
    }
    return { text: texts.join('\n').trim(), reasoning: thoughts.join('\n').trim() };
}

function toAnthropicContent(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    return content.map(part => {
        if (part?.type === 'text') return { type: 'text', text: part.text };
        const url = part?.image_url?.url || '';
        const commaIndex = url.indexOf(',');
        if (url.startsWith('data:') && commaIndex !== -1) {
            const header = url.slice(5, commaIndex);
            const mimeMatch = header.match(/^image\/(png|jpeg|webp|gif)\b/i);
            const mediaType = mimeMatch ? `image/${mimeMatch[1].toLowerCase()}` : 'image/png';
            return { type: 'image', source: { type: 'base64', media_type: mediaType, data: url.slice(commaIndex + 1) } };
        }
        return { type: 'image', source: { type: 'url', url } };
    });
}

function parseProviderErrorBody(raw) {
    try {
        const parsed = raw ? JSON.parse(raw) : {};
        const message = parsed?.error?.message || parsed?.error?.error?.message || parsed?.message || parsed?.detail;
        return typeof message === 'string' ? message.trim().slice(0, 300) : '';
    } catch {
        return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
}

function extractTokenUsageJs(data) {
    const usage = data && data.usage;
    if (usage && typeof usage === 'object') {
        const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
        const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
        const total = Number(usage.total_tokens ?? prompt + completion) || 0;
        if (!prompt && !completion && !total) return undefined;
        return { promptTokens: prompt, completionTokens: completion, totalTokens: total || prompt + completion };
    }
    const meta = data && data.usageMetadata;
    if (meta && typeof meta === 'object') {
        const prompt = Number(meta.promptTokenCount ?? 0) || 0;
        const completion = Number(meta.candidatesTokenCount ?? 0) || 0;
        const total = Number(meta.totalTokenCount ?? prompt + completion) || 0;
        if (!prompt && !completion && !total) return undefined;
        return { promptTokens: prompt, completionTokens: completion, totalTokens: total || prompt + completion };
    }
    return undefined;
}

/**
 * Why the model stopped, as the provider's OWN vocabulary — the renderer
 * normalizes it (utils/finishReason.ts). Returns undefined when the body
 * carried no signal, which is deliberately distinct from a value: a gateway
 * that omits the field must not be read as "stopped cleanly" nor as a
 * truncation. Four shapes because the bridge serves all four wire formats.
 */
function extractStopReasonJs(data) {
    if (!data || typeof data !== 'object') return undefined;
    const chat = data.choices && data.choices[0] && data.choices[0].finish_reason;
    if (typeof chat === 'string' && chat) return chat;
    if (typeof data.stop_reason === 'string' && data.stop_reason) return data.stop_reason;
    const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
    if (status === 'incomplete') {
        const why = data.incomplete_details && data.incomplete_details.reason;
        return typeof why === 'string' && why ? why : 'max_output_tokens';
    }
    if (status && status !== 'completed') return status;
    const cand = data.candidates && data.candidates[0];
    if (cand && typeof cand.finishReason === 'string' && cand.finishReason) return cand.finishReason;
    return undefined;
}

/** Same signal, recovered from accumulated SSE text for a streamed turn.
 *  finish_reason arrives on the final chunk of each choice, so the LAST
 *  occurrence wins; a stream that never emitted one returns undefined. */
function extractStopReasonFromSse(raw) {
    if (typeof raw !== 'string' || !raw) return undefined;
    let found;
    const re = /"finish_reason"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = re.exec(raw)) !== null) if (match[1]) found = match[1];
    if (found) return found;
    const anthropic = /"stop_reason"\s*:\s*"([^"]+)"/g;
    while ((match = anthropic.exec(raw)) !== null) if (match[1]) found = match[1];
    if (found) return found;
    // Responses-format stream: the terminal event is response.completed /
    // response.incomplete carrying a "status" field, never finish_reason —
    // without this scan desktop silently under-reported the one signal this
    // bridge exists to catch. Mirror extractStopReasonJs: incomplete reads
    // incomplete_details.reason, defaulting to the truncation token.
    if (/"status"\s*:\s*"incomplete"/.test(raw)) {
        const why = /"incomplete_details"\s*:\s*\{[^}]*"reason"\s*:\s*"([^"]+)"/.exec(raw);
        return why && why[1] ? why[1] : 'max_output_tokens';
    }
    return undefined;
}

/**
 * Consume a streaming provider response: parse SSE deltas as they land, push
 * each one to the renderer over `provider:chunk` (the live paint), and
 * accumulate the final {text, reasoning, toolCalls, usage}. Returns
 * sawData:false when the body carried no SSE frames at all — a provider that
 * ignored stream:true and answered with one plain JSON body — so the caller
 * can fall back to the buffered parse of `raw` instead of losing the answer.
 */
async function consumeProviderStream(response, request, sender) {
    const parser = createSseParser(request.config.apiFormat);
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let reasoning = '';
    let raw = '';
    let terminal = false;
    // A mid-stream error event ends the body: the provider said it failed, so the
    // caller must not read the empty text as a complete answer (AUDIT L-5). The
    // old `else reasoning += ev.delta` also appended every unknown event to the
    // reasoning channel, including this one.
    let streamError = null;
    const emit = (ev) => {
        if (ev.type === 'error') {
            streamError = { message: ev.message || 'the provider reported an error mid-stream', status: ev.status };
            return;
        }
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'reasoning') reasoning += ev.delta;
        else return;
        try {
            if (sender && !sender.isDestroyed()) {
                sender.send('provider:chunk', { requestId: request.requestId, type: ev.type, delta: ev.delta });
            }
        } catch { /* window gone mid-stream */ }
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            raw += chunkText;
            const out = parser.push(chunkText);
            out.events.forEach(emit);
            if (out.done) { terminal = true; break; }
        }
        if (!terminal) {
            // Trailing decode() with no `{stream:true}`: TextDecoder holds back
            // an INCOMPLETE multi-byte sequence at the end of the body. Any
            // final character whose bytes straddled the last chunk boundary (a
            // 3-byte '€', an emoji — very common as the last character of a
            // model reply) stayed in the decoder's buffer and was never pushed
            // to the parser, so the painted text and the accumulated answer
            // were both missing it. Flushing here is what makes the last
            // character appear; parser.finish() below still runs either way.
            const tail = decoder.decode();
            if (tail) {
                raw += tail;
                parser.push(tail).events.forEach(emit);
            }
        }
    } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
    }
    const fin = parser.finish();
    fin.events.forEach(emit);
    return {
        text, reasoning,
        toolCalls: fin.toolCalls,
        usage: fin.usage,
        sawData: terminal || fin.sawData,
        raw,
        stopReason: extractStopReasonFromSse(raw),
        ...(streamError ? { error: streamError } : {}),
    };
}

async function sendProviderRequest(request, sender) {
    const { url, headers, body } = providerRequestDetails(request);
    const controller = new AbortController();
    // 300s — matches the browser's stream budget (STREAM_TIMEOUT_MS). The old
    // 120s cap hard-aborted legitimate long reasoning streams on desktop that
    // survive in the browser.
    let timeout = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
    // Re-arm the SAME controller's guard when a new phase begins (stream
    // drain, body read, degrade re-fetch) so each phase gets a full 300s.
    const armBodyPhase = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
    };
    if (request.requestId) activeProviderRequests.set(request.requestId, controller);
    let response;
    let streamActive = streamRequested(request);
    let raw = null;
    let data = {};
    // Cancellation + timeout stay registered through the BODY phase. The
    // old structure ran both down in a finally the moment HEADERS arrived, so
    // a stalled response.text() hung forever, un-abortable, and
    // cancelProviderChat returned false for the whole body phase
    // (deep-dive ✅ :530-533,573). Everything await-able lives inside this
    // try; the outer finally releases the controller once the bytes are in.
    try {
        response = await fetchUpstream(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok && (request.jsonMode || request.jsonSchema) && (response.status === 400 || response.status === 422) && body.response_format) {
            // Degrade chain mirroring the renderer: json_schema → json_object → none.
            const fallbackBody = { ...body };
            if (body.response_format.type === 'json_schema' && request.jsonMode) {
                fallbackBody.response_format = { type: 'json_object' };
            } else {
                delete fallbackBody.response_format;
            }
            armBodyPhase();
            response = await fetchUpstream(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(fallbackBody),
                signal: controller.signal,
            });
            if (!response.ok && (response.status === 400 || response.status === 422) && fallbackBody.response_format) {
                delete fallbackBody.response_format;
                armBodyPhase();
                response = await fetchUpstream(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(fallbackBody),
                    signal: controller.signal,
                });
            }
        }
        if (streamActive && !response.ok && (response.status === 400 || response.status === 422)) {
            // Some OpenAI-compatible gateways reject stream/stream_options —
            // retry once buffered so the chat still answers (no live paint).
            const retryBody = { ...body };
            delete retryBody.stream;
            delete retryBody.stream_options;
            armBodyPhase();
            response = await fetchUpstream(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(retryBody),
                signal: controller.signal,
            });
            streamActive = false;
        }
        if (streamActive && response.ok && response.body && request.requestId && sender) {
            armBodyPhase();
            const streamOut = await consumeProviderStream(response, request, sender);
            if (streamOut.error) {
                // Surface it as a real failure with the provider's own words; the
                // renderer's classifier already knows how to read `status`.
                throw Object.assign(new Error(streamOut.error.message), {
                    ...(streamOut.error.status !== undefined ? { status: streamOut.error.status } : {}),
                });
            }
            if (streamOut.sawData) {
                // NORMALIZE, and never substitute `{}`.
                //
                // sseParser stores the provider's RAW usage (snake_case), and
                // the renderer's only guard is falsiness — so a snake_case
                // object passed straight through, and `0 + undefined` in
                // mergeTokenUsage produced NaN for the whole run ledger.
                // Executed against the real bridge: Session Usage rendered "—"
                // for every desktop run, and worse, `estimateCostUsd(NaN) ?? 0`
                // made shouldSkipRemaining() always false — so the
                // per-debate `debateCostCapUsd` money guard NEVER FIRED on
                // desktop. A spend limit the user set was silently inert.
                //
                // extractTokenUsageJs is the same normalizer the BUFFERED path
                // already used, and it returns undefined (not {}) when a
                // provider reports no usage — which is the value the renderer's
                // falsiness guard is actually written for.
                const streamUsage = extractTokenUsageJs({ usage: streamOut.usage });
                if (streamOut.toolCalls.length > 0) {
                    return {
                        text: streamOut.text,
                        reasoning: streamOut.reasoning,
                        usage: streamUsage,
                        finishReason: streamOut.stopReason,
                        toolCalls: streamOut.toolCalls,
                        assistantMessage: {
                            role: 'assistant',
                            content: streamOut.text || '',
                            tool_calls: streamOut.toolCalls.map((c, i) => ({
                                id: c.id || `call_${i}`,
                                type: 'function',
                                function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
                            })),
                        },
                    };
                }
                return { text: streamOut.text, reasoning: streamOut.reasoning, usage: streamUsage, finishReason: streamOut.stopReason };
            }
            // Provider ignored stream:true and answered with one JSON body —
            // feed the accumulated raw text into the buffered parse below.
            raw = streamOut.raw;
        }
        if (raw === null) {
            armBodyPhase();
            raw = await response.text();
        }
        try { data = raw ? JSON.parse(raw) : {}; } catch { /* handled by fallback below */ }

        if (response.ok && (request.jsonMode || request.jsonSchema) && body.response_format) {
            const message = data?.choices?.[0]?.message || {};
            const content = Array.isArray(message.content)
                ? message.content.filter(block => typeof block?.text === 'string').map(block => block.text).join('')
                : message.content;
            const reasoning = message.reasoning_content || message.reasoning;
            if (!content && !reasoning) {
                const fallbackBody = { ...body };
                delete fallbackBody.response_format;
                armBodyPhase();
                response = await fetchUpstream(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(fallbackBody),
                    signal: controller.signal,
                });
                raw = await response.text();
                try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
            }
        }
    } finally {
        clearTimeout(timeout);
        if (request.requestId) activeProviderRequests.delete(request.requestId);
    }

    if (!response.ok) {
        const error = new Error(parseProviderErrorBody(raw) || (response.status === 401
            ? 'Invalid API key. Check your provider settings.'
            : response.status === 403
                ? 'Access denied. Check your provider permissions or credits.'
                : response.status === 429
                    ? 'Rate limit reached. Please wait and try again.'
                    : response.status >= 500
                        ? 'Provider server error. Try again later.'
                        : `Provider request failed (${response.status}).`));
        error.status = response.status;
        throw error;
    }

    let text = '';
    let reasoning = '';
    if (request.config.apiFormat === 'messages') {
        text = Array.isArray(data.content)
            ? data.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
            : data.text || '';
        // Anthropic chain of thought arrives as `thinking` content blocks
        // (only when the request enabled extended thinking); redacted blocks
        // are surfaced as a marker so the user knows thinking was withheld.
        if (Array.isArray(data.content)) {
            const thinkingBlocks = data.content
                .filter(block => block?.type === 'thinking' && typeof block?.thinking === 'string' && block.thinking.trim())
                .map(block => block.thinking.trim());
            if (data.content.some(block => block?.type === 'redacted_thinking')) {
                thinkingBlocks.push('[Thinking redacted by provider]');
            }
            reasoning = thinkingBlocks.join('\n');
        }
    } else if (request.config.apiFormat === 'responses') {
        if (data.output_text) text = data.output_text;
        if (!text && Array.isArray(data.output)) {
            text = data.output.flatMap(item => item?.content || [])
                .filter(block => block?.type === 'output_text').map(block => block.text).join('\n');
        }
        // OpenAI Responses API reasoning arrives as `output` items of type
        // `reasoning` (full text in `content`, public summary in `summary`).
        if (Array.isArray(data.output)) {
            const reasoningParts = data.output
                .filter(item => item?.type === 'reasoning')
                .flatMap(item => [
                    ...(Array.isArray(item?.content) ? item.content.filter(block => block?.type === 'output_text' && typeof block?.text === 'string').map(block => block.text) : []),
                    ...(Array.isArray(item?.summary) ? item.summary.filter(block => block?.type === 'summary_text' && typeof block?.text === 'string').map(block => block.text) : []),
                ]);
            reasoning = reasoningParts.join('\n');
        }
    } else if (request.config.apiFormat === 'google') {
        const parsed = parseGeminiResponseJs(data);
        text = parsed.text;
        reasoning = parsed.reasoning;
    } else {
        const message = data.choices?.[0]?.message || {};
        const content = message.content;
        text = Array.isArray(content)
            ? content.filter(block => typeof block?.text === 'string').map(block => block.text).join('\n')
            : content || '';
        // Qwen/Kimi-style gateways return `reasoning` as an array of strings.
        const msgReasoning = message.reasoning_content ?? message.reasoning;
        reasoning = Array.isArray(msgReasoning)
            ? msgReasoning.filter(part => typeof part === 'string').join('\n')
            : msgReasoning || '';
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const toolCalls = message.tool_calls.map((tc, i) => {
                let args;
                try {
                    args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                } catch {
                    args = { raw: tc?.function?.arguments || '' };
                }
                return {
                    id: tc?.id || `call_${i}`,
                    name: String(tc?.function?.name || ''),
                    arguments: args && typeof args === 'object' ? args : {},
                };
            }).filter(c => c.name);
            return {
                text,
                reasoning,
                usage: extractTokenUsageJs(data),
                finishReason: extractStopReasonJs(data),
                toolCalls,
                assistantMessage: {
                    role: 'assistant',
                    content: text || '',
                    tool_calls: message.tool_calls,
                },
            };
        }
    }
    // NEVER substitute reasoning for content. A model that thinks without
    // emitting a final message genuinely returned no text; relabeling its
    // CoT as the answer makes the renderer's pure-echo guard (reasoning ==
    // content) fire a false "streamed only its reasoning" error on desktop
    // for turns that localhost renders fine.
    return { text, reasoning, usage: extractTokenUsageJs(data), finishReason: extractStopReasonJs(data) };
}

// =============================================================================
// APP PROTOCOL HANDLER — registered EXACTLY ONCE at whenReady
// =============================================================================
// protocol.handle used to sit inside createWindow(); with the macOS
// activate-recreate path that re-registers the scheme on every window
// rebuild (replacing the prior handler — benign, but structural sloppiness
// the audit flagged). One idempotent registration at boot instead.
let appProtocolRegistered = false;
function registerAppProtocol() {
    if (appProtocolRegistered || isDev) return;
    appProtocolRegistered = true;
    protocol.handle('app', (request) => {
        // Per-request root: after a self-host setup or a successful packaged
        // build, a reload serves the checkout's dist without re-registering.
        const distPath = repoDist();
        const url = new URL(request.url);
        if (url.protocol !== 'app:' || url.hostname !== '.') {
            return new Response('Not found', { status: 404 });
        }

        let filePath;
        try {
            filePath = decodeURIComponent(url.pathname);
        } catch {
            return new Response('Bad request', { status: 400 });
        }

        if (filePath === '/' || filePath === '') {
            filePath = '/index.html';
        }

        const fullPath = path.resolve(distPath, `.${filePath}`);
        const relativePath = path.relative(distPath, fullPath);
        if (
            relativePath === '..' ||
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath)
        ) {
            return new Response('Forbidden', { status: 403 });
        }

        return net.fetch(pathToFileURL(fullPath).toString());
    });
}

async function createWindow() {
    const saved = loadWindowState();
    mainWindow = new BrowserWindow({
        width: saved.width,
        height: saved.height,
        // Floor the live size at the same bounds loadWindowState clamps to:
        // below ~600px the trade layout degrades into the reported "toggle
        // broke the UI" state — the chart pane hits its min-h floor, the dock
        // transcript collapses to a sliver, and the Key Levels card clips to
        // one row. The window must not be draggable into that state.
        minWidth: 800,
        minHeight: 600,
        ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
        // Don't show the frame until the first paint is ready — otherwise a
        // blank/white window flashes on launch (the audit flagged this).
        // `show: false` alone does not fix it: the window's own background is
        // Electron's default white, so anything that paints behind the
        // renderer — the 4s fail-safe show, a failed load — still shows white.
        // This is the page color from index.css.
        backgroundColor: '#0a0a0a',
        show: false,
        // Keep renderer timers/rAF at full rate when the window is hidden or
        // occluded. Electron throttles backgrounded renderers to ~1 timer/min
        // after ~5 min, which on desktop froze the price strip (reconnect
        // setTimeout + REST polls) and suspended the chart repaint until the
        // window refocused — the "prices aren't realtime, then jump" symptom.
        // This is a trading terminal; it must keep ticking in the background.
        backgroundThrottling: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            // Renderer is fully sandboxed — the preload bridge is its only
            // privileged surface (sandboxed preloads support contextBridge/ipc).
            sandbox: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        icon: path.join(__dirname, '../public/favicon.ico')
    });

    // Show on first paint; a 4s fail-safe covers the custom app:// protocol in
    // case ready-to-show never fires (slow disk, renderer error page).
    let windowShown = false;
    const showWindow = () => {
        if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
        windowShown = true;
        mainWindow.show();
    };
    mainWindow.once('ready-to-show', showWindow);
    setTimeout(showWindow, 4000);

    // Persist bounds/position on close so the next launch restores them.
    mainWindow.on('close', () => saveWindowState(mainWindow));
    if (saved.maximized) mainWindow.maximize();

    // Remove menu bar for cleaner look
    mainWindow.setMenuBarVisibility(false);

    if (isDev) {
        // Chromium can retain localhost responses between Electron launches,
        // even when the renderer performs a hard refresh. Disable that cache
        // for the development window and force the first navigation to use
        // the current Vite output.
        const devSession = mainWindow.webContents.session;
        await devSession.clearCache();
        devSession.webRequest.onHeadersReceived(
            { urls: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] },
            (details, callback) => {
                const responseHeaders = { ...details.responseHeaders };
                for (const key of Object.keys(responseHeaders)) {
                    if (key.toLowerCase() === 'cache-control') delete responseHeaders[key];
                }
                responseHeaders['Cache-Control'] = ['no-store, no-cache, must-revalidate, max-age=0'];
                callback({ responseHeaders });
            }
        );
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) {
            require('electron').shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const allowed = isDev ? url.startsWith('http://localhost:') : url.startsWith('app://');
        if (!allowed) event.preventDefault();
    });

    if (isDev) {
        const port = process.env.PORT || 3000;
        // A moved/renamed source file leaves the renderer's HTTP cache
        // serving the module under its OLD url with bindings that no longer
        // initialize — the user-visible crash was `Cannot read properties of
        // null (reading 'useContext')` on the Knowledge surface, from a stale
        // `components/chat/SessionUsagePanel.tsx` chunk after the file had
        // moved to components/settings/. Dev modules are uncached-by-design,
        // so clearing on every dev boot costs one reload and kills the whole
        // class. Prod clears once per version, below.
        try { await session.defaultSession.clearCache(); } catch { /* best-effort */ }
        await mainWindow.loadURL(`http://localhost:${port}`);
        mainWindow.webContents.openDevTools();
    } else {
        // Same class, packaged: an auto-update swaps dist/ bytes under the
        // same app:// urls; a stale cached chunk from the previous version
        // can outlive the swap. One cache clear per NEW version — stamped
        // into userData so an unchanged version pays nothing.
        try {
            const stampPath = path.join(app.getPath('userData'), 'renderer-cache-stamp');
            const version = app.getVersion();
            let stamped = '';
            try { stamped = fs.readFileSync(stampPath, 'utf8'); } catch { /* first run */ }
            if (stamped !== version) {
                await session.defaultSession.clearCache();
                fs.writeFileSync(stampPath, version);
            }
        } catch { /* best-effort */ }
        // Serve the built dist/ folder via the custom app:// protocol
        // (registered once at whenReady — see registerAppProtocol).
        mainWindow.loadURL('app://./index.html');
    }
}

// =============================================================================
// AUTO-UPDATE LOGIC
// =============================================================================

let updateInfo = {
    status: 'idle',           // idle | checking | available | downloading | downloaded | installing | error
    progress: 0,
    version: null,
    error: null,
    // Download telemetry (downloading phase): electron-updater's
    // download-progress carries bytes/second so the overlay can show speed+ETA.
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    // Release body from GitHub (available/downloaded phases) — "What's new".
    releaseNotes: null,
};

// Set while an update:install is waiting for the renderer's restart animation
// to finish (the overlay sends update:quit-now, with a timeout fallback).
let pendingInstallerQuit = null;

/** GitHub's releaseNotes is a raw markdown string; other providers can hand
 *  back an array of per-language notes. Normalize to plain text (capped) so
 *  the renderer never has to branch on the shape. */
function normalizeReleaseNotes(notes) {
    if (typeof notes === 'string') return notes.slice(0, 4000);
    if (Array.isArray(notes)) {
        return notes
            .map(n => (n && (n.note ?? n.text ?? n.value) ? String(n.note ?? n.text ?? n.value) : ''))
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 4000) || null;
    }
    return null;
}

function sendUpdateStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', updateInfo);
    }
}

function setupAutoUpdater() {
    // Disable auto-download — we let the user decide via the Update button
    autoUpdater.autoDownload = false;
    // User-decides flow: the update installs only when update:install fires.
    // autoInstallOnAppQuit would install silently on window close instead.
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => {
        updateInfo = { ...updateInfo, status: 'checking', error: null };
        sendUpdateStatus();
    });

    autoUpdater.on('update-available', (info) => {
        updateInfo = {
            ...updateInfo,
            status: 'available',
            version: info.version,
            releaseNotes: normalizeReleaseNotes(info.releaseNotes),
            error: null,
        };
        sendUpdateStatus();
    });

    autoUpdater.on('update-not-available', () => {
        // 'upToDate', NOT 'idle' — idle is also the never-checked state, so
        // collapsing the two made "no update exists" indistinguishable from
        // "the check never ran", and no surface could report a manual check.
        updateInfo = { ...updateInfo, status: 'upToDate', version: null };
        sendUpdateStatus();
    });

    autoUpdater.on('download-progress', (progressObj) => {
        updateInfo = {
            ...updateInfo,
            status: 'downloading',
            progress: Math.round(progressObj.percent),
            bytesPerSecond: Math.max(0, Math.round(progressObj.bytesPerSecond || 0)),
            transferred: Math.max(0, Math.round(progressObj.transferred || 0)),
            total: Math.max(0, Math.round(progressObj.total || 0)),
        };
        sendUpdateStatus();
    });

    autoUpdater.on('update-downloaded', () => {
        updateInfo = {
            ...updateInfo,
            status: 'downloaded',
            progress: 100,
            bytesPerSecond: 0,
        };
        sendUpdateStatus();
    });

    autoUpdater.on('error', (err) => {
        updateInfo = {
            ...updateInfo,
            status: 'error',
            error: err ? err.message : 'Unknown update error',
        };
        sendUpdateStatus();
    });

    // IPC handlers — called from the renderer via the preload bridge.
    // Every one of them goes through `trustedHandle`, which refuses a sender
    // frame that is not the app window's main frame (see the guard above).
    const refused = { error: 'Refused — the request did not come from the app window.' };

    trustedHandle('update:check', async () => {
        if (isInstallerSmoke) return updateInfo; // smoke runs must never contact the update service
        try {
            await autoUpdater.checkForUpdates();
            return updateInfo;
        } catch (err) {
            updateInfo = { ...updateInfo, status: 'error', error: err.message };
            sendUpdateStatus();
            return updateInfo;
        }
    }, () => ({ ...updateInfo, status: 'error', ...refused }));

    trustedHandle('update:download', async () => {
        if (isInstallerSmoke) return updateInfo; // smoke runs must never download an update
        try {
            await autoUpdater.downloadUpdate();
            return updateInfo;
        } catch (err) {
            updateInfo = { ...updateInfo, status: 'error', error: err.message };
            sendUpdateStatus();
            return updateInfo;
        }
    }, () => ({ ...updateInfo, status: 'error', ...refused }));

    trustedHandle('update:install', () => {
        if (isInstallerSmoke) return false; // smoke runs must never launch an installer
        // Only install when an update was actually downloaded — quitAndInstall
        // with nothing downloaded throws synchronously inside setImmediate
        // (uncaught exception in main).
        if (updateInfo.status !== 'downloaded') {
            console.warn('[AutoUpdater] update:install ignored — no downloaded update');
            return false;
        }
        // Push an 'installing' status so the renderer overlay can show a
        // "Restarting…" message before the app quits.
        updateInfo = { ...updateInfo, status: 'installing' };
        sendUpdateStatus();
        // The overlay plays the restart animation, then sends
        // update:quit-now. The 5s fallback guarantees the update still
        // installs if the renderer is stuck (or hides the overlay entirely);
        // quitAndInstall fires exactly once either way.
        let fired = false;
        const doQuit = () => {
            if (fired) return;
            fired = true;
            pendingInstallerQuit = null;
            try {
                // Silent + force-run: the NSIS installer runs invisibly with
                // no generic Windows dialog (/S is safe for the per-user
                // oneClick install — no elevation needed), then relaunches
                // August (--force-run). The only visuals around the update
                // are ours: the Restarting… overlay, then the boot splash.
                autoUpdater.quitAndInstall(true, true);
            } catch (err) {
                console.error('[AutoUpdater] quitAndInstall failed, plain quit:', err);
                app.quit();
            }
        };
        pendingInstallerQuit = doQuit;
        setTimeout(doQuit, 5000);
        return true;
    }, () => false);

    // Renderer's "animation done — quit now" ack for the install above.
    ipcMain.on('update:quit-now', (event) => {
        if (!isTrustedSenderFrame(event)) {
            console.warn('[main] refused IPC "update:quit-now" — the sender frame is not the app window');
            return;
        }
        if (pendingInstallerQuit) pendingInstallerQuit();
    });

    trustedHandle('update:get-status', () => updateInfo, () => updateInfo);

    trustedHandle('app:get-version', () => app.getVersion(), () => '');

    trustedHandle('provider:discover', async (_event, config) => {
        if (isInstallerSmoke) {
            return { ok: false, message: 'Provider discovery is disabled during installer smoke.' };
        }
        try {
            return await sendDiscoverRequest(config || {});
        } catch (error) {
            console.error('[main] provider discover failed:', {
                provider: config?.name || 'Provider',
                format: config?.apiFormat,
                message: error instanceof Error ? error.message : String(error),
            });
            return {
                ok: false,
                message: error instanceof Error ? error.message : 'Model discovery failed.',
            };
        }
    }, () => ({ ok: false, message: 'Refused — the request did not come from the app window.' }));

    trustedHandle('provider:chat', async (event, request) => {
        if (isInstallerSmoke) {
            return { ok: false, message: 'Provider requests are disabled during installer smoke.' };
        }
        try {
            return { ok: true, ...(await sendProviderRequest(request, event.sender)) };
        } catch (error) {
            console.error('[main] provider request failed:', {
                provider: request?.config?.name || 'Provider',
                format: request?.config?.apiFormat,
                message: error instanceof Error ? error.message : String(error),
                code: error?.code,
                status: error?.status,
            });
            return {
                ok: false,
                status: typeof error?.status === 'number' ? error.status : undefined,
                code: typeof error?.code === 'string' ? error.code : undefined,
                message: error instanceof Error ? error.message : 'Provider request failed.',
            };
        }
    }, () => ({ ok: false, message: 'Refused — the request did not come from the app window.' }));

    trustedHandle('provider:cancel', (_event, requestId) => {
        if (typeof requestId !== 'string') return false;
        const controller = activeProviderRequests.get(requestId);
        if (!controller) return false;
        controller.abort();
        activeProviderRequests.delete(requestId);
        return true;
    }, () => false);

    // =========================================================================
    // SECRET ENCRYPTION — API keys at rest
    // =========================================================================
    // The renderer stores provider API keys; on desktop we encrypt them with
    // the OS keychain (DPAPI on Windows, Keychain on macOS) via safeStorage.
    // Payloads are prefixed "enc:v1:" so the renderer can tell encrypted
    // values from legacy plaintext and fall back gracefully when unavailable.
    trustedHandle('crypto:encrypt', (_event, plaintext) => {
        try {
            if (typeof plaintext !== 'string' || !plaintext || !safeStorage.isEncryptionAvailable()) return null;
            return 'enc:v1:' + safeStorage.encryptString(plaintext).toString('base64');
        } catch (err) {
            console.warn('[main] crypto:encrypt failed:', err);
            return null;
        }
    }, () => null);

    trustedHandle('crypto:decrypt', (_event, payload) => {
        try {
            if (typeof payload !== 'string' || !payload.startsWith('enc:v1:')) return null;
            return safeStorage.decryptString(Buffer.from(payload.slice(7), 'base64'));
        } catch (err) {
            console.warn('[main] crypto:decrypt failed:', err);
            return null;
        }
    }, () => null);
}

// =============================================================================
// APP LIFECYCLE
// =============================================================================

// Single-instance lock: without it a double launch opens two windows and two
// auto-update checks, and the update-status IPC pushes to whichever window
// happens to respond. The second instance focuses the first window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // Guard the window ALIVE first: 'second-instance' can land after the
        // window was closed (macOS keeps the app running), and isMinimized()
        // on a destroyed BrowserWindow throws.
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

if (gotSingleInstanceLock) {
app.whenReady().then(() => {
    // Deny EVERY permission request (media, geolocation, clipboard,
    // notifications, …) outright: Electron's default grants them, so a
    // compromised renderer (a TradingView script runs in the app origin)
    // could otherwise ask the OS for camera/mic/clipboard. The trading
    // terminal needs none of them.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(false);
    });
    registerAppProtocol();
    blockSmokeNetwork();
    createWindow();
    setupAutoUpdater();
    setupRepoBridge();

    // Check for updates on startup (production only, non-blocking). The
    // installer-smoke probe sets AUGUST_SMOKE_TEST=1 to skip this entirely:
    // a packaged build without app-update.yml (electron-builder --dir) logs
    // an ENOENT here, and a real installer probe should never talk to GitHub.
    if (!isDev && !isInstallerSmoke) {
        // Delay the check so the app loads first
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch(() => {
                // Silently fail on startup — user can manually check
            });
        }, 3000);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
} // gotSingleInstanceLock

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
